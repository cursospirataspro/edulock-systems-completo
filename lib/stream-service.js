'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const https = require('node:https');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ACCOUNT_HOST = 'api.bunny.net';
const STREAM_HOST = 'video.bunnycdn.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(code, message, statusCode = 502, retryable = false) {
    return Object.assign(new Error(message), { code, statusCode, retryable });
}

// This is VideoModelStatus (GET video), NOT webhook Status. Official SDK:
// https://github.com/BunnyWay/bunny-stream-android/blob/main/bunny-stream-api/src/main/java/net/bunny/api/model/VideoModelStatus.kt
function normalizeVideoStatus(video) {
    const raw = video?.status ?? video?.Status;
    const status = Number.isInteger(raw) ? raw : null;
    const progress = Number(video?.encodeProgress ?? video?.EncodeProgress ?? 0);
    const encodeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
    const phases = { 0: 'created', 1: 'uploaded', 2: 'processing', 3: 'transcoding', 4: 'ready',
        5: 'error', 6: 'upload_failed', 7: 'jit_segmenting', 8: 'jit_playlists_created' };
    const failed = status === 5 || status === 6;
    const ready = status === 4 || (status === 8 && video?.jitEncodingEnabled === true);
    return { status, phase: phases[status] || 'unknown', encodeProgress, ready, failed,
        retryable: status === 6,
        error: failed ? (status === 6 ? 'La subida a Bunny no se completó.' : 'Bunny no pudo procesar el video.') : null };
}

function createTransport({ request = https.request } = {}) {
    function send({ method, hostname, path, accessKey, body, filePath, fileSize, onProgress }) {
        if (![ACCOUNT_HOST, STREAM_HOST].includes(hostname)) throw failure('INVALID_BUNNY_HOST', 'Proveedor no permitido.', 400);
        return new Promise((resolve, reject) => {
            let settled = false, source;
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                if (error) { source?.destroy(); req.destroy(); reject(error); }
                else resolve(result);
            };
            const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
            const headers = { AccessKey: accessKey, Accept: 'application/json' };
            if (filePath) { headers['Content-Type'] = 'application/octet-stream'; headers['Content-Length'] = fileSize; }
            else if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
            const req = request({ method, hostname, path, headers, timeout: filePath ? 120000 : 30000 }, response => {
                const chunks = []; let bytes = 0;
                response.on('error', () => finish(failure('BUNNY_CONNECTION_ERROR', 'La conexión con Bunny se interrumpió.', 502, true)));
                response.on('data', chunk => {
                    bytes += chunk.length;
                    if (bytes > 1024 * 1024) { response.destroy(); finish(failure('BUNNY_RESPONSE_TOO_LARGE', 'Respuesta de Bunny no válida.')); }
                    else chunks.push(chunk);
                });
                response.on('end', () => {
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        const retryable = response.statusCode === 429 || response.statusCode >= 500;
                        return finish(failure('BUNNY_HTTP_ERROR', `Bunny respondió HTTP ${response.statusCode}.`, 502, retryable));
                    }
                    const text = Buffer.concat(chunks).toString('utf8');
                    let result;
                    try { result = text ? JSON.parse(text) : {}; }
                    catch { return finish(failure('BUNNY_INVALID_JSON', 'Bunny devolvió una respuesta incompleta.', 502, true)); }
                    if (result?.success === false || result?.Success === false) return finish(failure('BUNNY_REJECTED', 'Bunny rechazó la operación.'));
                    finish(null, result);
                });
            });
            req.on('error', () => finish(failure('BUNNY_CONNECTION_ERROR', 'No se pudo completar la conexión con Bunny.', 502, true)));
            req.on('timeout', () => finish(failure('BUNNY_TIMEOUT', 'Bunny no respondió dentro del plazo.', 504, true)));
            if (filePath) {
                let uploaded = 0;
                source = fs.createReadStream(filePath);
                const meter = new Transform({ transform(chunk, encoding, callback) {
                    uploaded += chunk.length;
                    try { onProgress?.(Math.min(99, Math.floor(uploaded * 100 / fileSize))); }
                    catch { /* A UI callback must not terminate the transfer. */ }
                    callback(null, chunk);
                } });
                pipeline(source, meter, req).catch(() => finish(failure('UPLOAD_INTERRUPTED', 'La transferencia a Bunny se interrumpió.', 502, true)));
            } else req.end(payload || undefined);
        });
    }
    return {
        json: (method, hostname, path, accessKey, body) => send({ method, hostname, path, accessKey, body }),
        putFile: ({ libraryId, libraryKey, videoId, filePath, fileSize, onProgress }) => send({
            method: 'PUT', hostname: STREAM_HOST, path: `/library/${encodeURIComponent(libraryId)}/videos/${encodeURIComponent(videoId)}`,
            accessKey: libraryKey, filePath, fileSize, onProgress,
        }),
    };
}

function createStreamService({ db, getAccountKey, createKey, transport = createTransport(), maxUploadBytes = 1024 ** 3, maxConcurrentUploads = 2 }) {
    if (!db || !getAccountKey || !createKey) throw new TypeError('db, getAccountKey and createKey are required');
    let activeUploads = 0, stopped = false, reconciling = false;
    const verifiedLibraries = new Map();
    const inFlightOperations = new Set();
    const actorKey = actor => actor?.admin === true ? 'admin' : actor?.producerId ? `producer:${actor.producerId}` : null;

    async function authorizeCourse(courseId, actor) {
        if (!actorKey(actor)) throw failure('AUTH_REQUIRED', 'Autenticación requerida.', 401);
        const course = await db.getCourseById(courseId);
        if (!course) throw failure('COURSE_NOT_FOUND', 'Curso no encontrado.', 404);
        if (actor.admin !== true) {
            const producer = await db.getProducerById(actor.producerId);
            if (!producer || Number(producer.active) !== 1 || course.producerId !== actor.producerId) {
                throw failure('COURSE_FORBIDDEN', 'Curso no disponible para esta cuenta.', 403);
            }
        }
        return course;
    }

    async function accountKey() {
        const key = await getAccountKey();
        if (!key) throw failure('BUNNY_NOT_CONFIGURED', 'Configura la cuenta Bunny antes de subir videos.', 503);
        return key;
    }

    async function findRemote(host, path, key, name, field) {
        let found = null;
        for (let page = 1; page <= 100; page++) {
            const result = await transport.json('GET', host, `${path}${path.includes('?') ? '&' : '?'}page=${page}&perPage=100`, key);
            const items = Array.isArray(result) ? result : result.Items ?? result.items;
            if (!Array.isArray(items)) throw failure('BUNNY_INVALID_LIST', 'Bunny devolvió una lista no válida.');
            const matches = items.filter(item => item[field] === name || item[field[0].toUpperCase() + field.slice(1)] === name);
            if (matches.length > 1 || (found && matches.length)) throw failure('REMOTE_DUPLICATE', 'Hay recursos remotos duplicados; se requiere conciliarlos.', 409);
            if (matches.length === 1) found = matches[0];
            const total = Number(result.TotalItems ?? result.totalItems);
            if (items.length < 100 || (Number.isFinite(total) && page * 100 >= total)) return found;
        }
        throw failure('REMOTE_LIST_LIMIT', 'No se pudo completar la conciliación remota.', 503, true);
    }

    async function provision(resourceKey, remoteName, find, create, idOf) {
        const saved = await db.getStreamResource(resourceKey);
        if (saved?.remote_id) return { id: saved.remote_id };
        const knownName = saved?.remote_name || remoteName;
        const found = await find(knownName);
        if (found) {
            const id = idOf(found);
            if (!id) throw failure('BUNNY_MISSING_ID', 'Bunny no devolvió el identificador del recurso.');
            await db.setStreamResource(resourceKey, { remoteName: knownName, state: 'ready', remoteId: id });
            return { id: String(id), value: found };
        }
        // An earlier POST might have succeeded without a response. A later list
        // can recover it, but absence in an eventually consistent list does not
        // authorize a second POST. This deliberately fails closed.
        if (saved && saved.state !== 'reserved') throw failure('PROVISION_UNCERTAIN', 'La creación remota sigue sin confirmarse. Vuelve a consultar antes de crear otro recurso.', 409, true);
        await db.setStreamResource(resourceKey, { remoteName: knownName, state: 'creating' });
        try {
            const value = await create(knownName);
            const id = idOf(value);
            if (!id) throw failure('BUNNY_MISSING_ID', 'Bunny no devolvió el identificador del recurso.');
            await db.setStreamResource(resourceKey, { remoteName: knownName, state: 'ready', remoteId: id });
            return { id: String(id), value };
        } catch (error) {
            await db.setStreamResource(resourceKey, { remoteName: knownName, state: 'unknown' });
            throw failure('PROVISION_UNCERTAIN', 'No se pudo confirmar la creación remota. El siguiente intento buscará el recurso antes de continuar.', 409, true);
        }
    }

    async function ensureCourseLibrary({ courseId, actor }) {
        const course = await authorizeCourse(courseId, actor);
        return db.withStreamLock(`course:${courseId}`, async () => {
            const saved = await db.getCourseBunny(courseId);
            const cached = verifiedLibraries.get(courseId);
            if (cached && cached.until > Date.now() && String(saved?.libraryId) === cached.libraryId && saved?.libraryKey && saved?.pullZone && saved?.tokenKey) return saved;
            const key = await accountKey();
            let libraryId = saved?.libraryId;
            if (!libraryId) {
                const name = `${String(course.name).slice(0, 40)} [course:${courseId}]`;
                const resource = await provision(`course:${courseId}`, name,
                    n => findRemote(ACCOUNT_HOST, '/videolibrary?includeAccessKey=true', key, n, 'Name'),
                    n => transport.json('POST', ACCOUNT_HOST, '/videolibrary', key, { Name: n, ReplicationRegions: [] }),
                    lib => lib.Id);
                libraryId = resource.id;
                await db.setCourseBunnyLibrary(courseId, { libraryId, libraryKey: resource.value?.ApiKey || null, pullZone: null });
                // MediaCage Basic DRM (GRATIS: clave transparente, detiene descargas) + token
                // de vista incrustada, en la biblioteca recién creada (vacía, antes de subir).
                // EnableDRM:true con Widevine/FairPlay APAGADOS = MediaCage Basic gratis; NUNCA
                // se tocan GoogleWidevineDrm/AppleFairPlayDrm (esos son el DRM de PAGO, $99).
                // No-fatal: si Bunny rechaza el ajuste, la biblioteca igual sirve.
                try {
                    await transport.json('POST', ACCOUNT_HOST, `/videolibrary/${libraryId}`, key, {
                        EnableDRM: true,
                        PlayerTokenAuthenticationEnabled: true,
                        BlockNoneReferrer: true,
                        AllowDirectPlay: true,
                    });
                } catch { /* el toggle es best-effort; no rompe la creación */ }
            }
            const library = await transport.json('GET', ACCOUNT_HOST, `/videolibrary/${encodeURIComponent(libraryId)}?includeAccessKey=true`, key);
            if (String(library.Id) !== String(libraryId) || !library.ApiKey || !library.PullZoneId || !library.StorageZoneId) {
                throw failure('BUNNY_LIBRARY_INCOMPLETE', 'La biblioteca todavía no tiene todos sus datos.', 503, true);
            }
            // StorageZone is authoritative: Library.ReplicationRegions may use
            // [''] for its default while StorageZone correctly reports DE/[].
            const storage = await transport.json('GET', ACCOUNT_HOST, `/storagezone/${library.StorageZoneId}`, key);
            const replicas = storage.ReplicationRegions;
            if (String(storage.Region).toUpperCase() !== 'DE' || !Array.isArray(replicas) || replicas.some(r => String(r).toUpperCase() !== 'DE')) {
                throw failure('BUNNY_REGION_MISMATCH', 'La biblioteca no confirma Frankfurt sin réplicas adicionales.', 409);
            }
            let pull = await transport.json('GET', ACCOUNT_HOST, `/pullzone/${library.PullZoneId}`, key);
            if (pull.ZoneSecurityEnabled !== true || pull.ZoneSecurityIncludeHashRemoteIP === true) {
                const owned = await db.getStreamResource(`course:${courseId}`);
                if (!owned || String(owned.remote_id) !== String(libraryId)) {
                    throw failure('BUNNY_UNMANAGED_SECURITY', 'Esta biblioteca anterior necesita una revisión de protección antes de adoptarla.', 409);
                }
                // Documented video-library settings update the underlying CDN.
                // Never reset its key, modify replication or enable paid DRM.
                await transport.json('POST', ACCOUNT_HOST, `/videolibrary/${libraryId}`, key,
                    { EnableTokenAuthentication: true, EnableTokenIPVerification: false });
                pull = await transport.json('GET', ACCOUNT_HOST, `/pullzone/${library.PullZoneId}`, key);
            }
            if (pull.ZoneSecurityEnabled !== true || pull.ZoneSecurityIncludeHashRemoteIP === true ||
                typeof pull.ZoneSecurityKey !== 'string' || !pull.ZoneSecurityKey) {
                throw failure('BUNNY_CDN_UNPROTECTED', 'Bunny todavía no confirmó la protección del CDN.', 503, true);
            }
            const hostname = (pull.Hostnames || []).map(h => h.Value).find(h => typeof h === 'string' && /^[a-z0-9-]+\.b-cdn\.net$/i.test(h));
            if (!hostname) throw failure('BUNNY_HOSTNAME_MISSING', 'El hostname de la biblioteca aún no está disponible.', 503, true);
            const result = { libraryId: String(libraryId), libraryKey: library.ApiKey, pullZone: hostname, tokenKey: pull.ZoneSecurityKey };
            await db.setCourseBunnyLibrary(courseId, result);
            verifiedLibraries.set(courseId, { until: Date.now() + 60000, libraryId: String(libraryId) });
            return result;
        });
    }

    async function ensureModuleCollection({ courseId, moduleId, actor }) {
        await authorizeCourse(courseId, actor);
        const mod = await db.getModuleById(moduleId);
        if (!mod || mod.courseId !== courseId) throw failure('MODULE_COURSE_MISMATCH', 'El módulo no pertenece al curso.', 400);
        const library = await ensureCourseLibrary({ courseId, actor });
        return db.withStreamLock(`module:${moduleId}`, async () => {
            const saved = await db.getModuleBunnyCollection(moduleId);
            if (saved) return saved;
            const name = `${String(mod.name).slice(0, 40)} [module:${moduleId}]`;
            const base = `/library/${library.libraryId}/collections`;
            const resource = await provision(`module:${moduleId}`, name,
                n => findRemote(STREAM_HOST, base, library.libraryKey, n, 'name'),
                n => transport.json('POST', STREAM_HOST, base, library.libraryKey, { name: n }),
                collection => collection.guid || collection.Guid);
            if (!UUID.test(resource.id)) throw failure('BUNNY_INVALID_COLLECTION', 'Identificador de colección no válido.');
            await db.setModuleBunnyCollection(moduleId, resource.id);
            return resource.id;
        });
    }

    function operationResult(op) {
        const ready = op.state === 'ready', failed = ['error', 'upload_failed', 'deleted'].includes(op.state);
        return { ok: !failed, operationId: op.id, videoId: op.video_id || null, status: ready ? 'ready' : failed ? 'error' : 'processing',
            phase: op.state, uploadPercent: Number(op.upload_percent) || 0, encodeProgress: Number(op.encode_progress) || 0,
            ready, failed, retryable: ['reserved', 'upload_failed', 'uncertain'].includes(op.state),
            error: op.state === 'deleted' ? 'Este video se quitó del catálogo y esta operación ya no puede reanudarse.' : op.error_code ? 'La operación requiere un nuevo intento o revisión.' : null, code: op.error_code || null };
    }

    async function getOperationStatus({ operationId, actor }) {
        const op = await db.getStreamOperation(operationId);
        if (!op || (actor?.admin !== true && op.actor_key !== actorKey(actor))) throw failure('OPERATION_NOT_FOUND', 'Operación no encontrada.', 404);
        await authorizeCourse(op.course_id, actor);
        if (op.video_id && ['processing', 'ready'].includes(op.state)) {
            await getVideoStatus({ videoId: op.video_id, actor });
            return operationResult(await db.getStreamOperation(operationId));
        }
        return operationResult(op);
    }

    async function uploadVideo({ filePath, title, courseId, moduleId = null, actor, operationId, onProgress }) {
        if (!UUID.test(operationId || '')) throw failure('OPERATION_ID_REQUIRED', 'Identificador de subida requerido.', 400);
        if (stopped || activeUploads >= maxConcurrentUploads) throw failure('UPLOAD_CAPACITY', 'Hay otras subidas en curso. Inténtalo nuevamente.', 429, true);
        const course = await authorizeCourse(courseId, actor);
        if (moduleId) {
            const mod = await db.getModuleById(moduleId);
            if (!mod || mod.courseId !== courseId) throw failure('MODULE_COURSE_MISMATCH', 'El módulo no pertenece al curso.', 400);
        }
        activeUploads++;
        try {
            return await db.withStreamLock(`upload:${operationId}`, async () => {
                const stat = await fs.promises.stat(filePath);
                if (!stat.isFile() || stat.size <= 0 || stat.size > maxUploadBytes) throw failure('UPLOAD_SIZE', 'El archivo está vacío o supera el límite permitido.', 413);
                const digest = crypto.createHash('sha256');
                for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk);
                const fileSha256 = digest.digest('hex');
                const cleanTitle = String(title || 'Video').trim().slice(0, 200) || 'Video';
                let op = await db.reserveStreamOperation({ id: operationId, actorKey: actorKey(actor), courseId, moduleId, title: cleanTitle, fileSize: stat.size, fileSha256 });
                if (op.state === 'deleted') throw failure('OPERATION_DELETED', 'Este video se quitó del catálogo. Inicia una subida nueva para volver a publicarlo.', 409);
                if (op.actor_key !== actorKey(actor) || op.course_id !== courseId || (op.module_id || null) !== (moduleId || null) ||
                    op.file_sha256 !== fileSha256 || Number(op.file_size) !== stat.size || op.title !== cleanTitle) {
                    throw failure('OPERATION_CONFLICT', 'Esta operación corresponde a otro archivo, curso o cuenta.', 409);
                }
                if (op.state === 'ready' || op.state === 'processing') return operationResult(op);
                inFlightOperations.add(operationId);
                try {
                    const library = await ensureCourseLibrary({ courseId, actor });
                    const collectionId = moduleId ? await ensureModuleCollection({ courseId, moduleId, actor }) : null;
                    let videoId = op.video_id;
                    if (!videoId) {
                        const remoteTitle = `${cleanTitle.slice(0, 140)} [upload:${operationId}]`;
                        const base = `/library/${library.libraryId}/videos`;
                        const resource = await provision(`upload:${operationId}`, remoteTitle,
                            n => findRemote(STREAM_HOST, base, library.libraryKey, n, 'title'),
                            n => transport.json('POST', STREAM_HOST, base, library.libraryKey, { title: n, ...(collectionId ? { collectionId } : {}) }),
                            video => video.guid || video.Guid);
                        videoId = resource.id;
                        if (!UUID.test(videoId)) throw failure('BUNNY_INVALID_VIDEO', 'Identificador de video no válido.');
                        op = await db.updateStreamOperation(operationId, { videoId });
                    }
                    const existing = await db.getCatalogById(videoId);
                    const key = existing?.keyId || await createKey(videoId);
                    const keyId = typeof key === 'string' ? key : key?.keyId;
                    if (!keyId) throw failure('HLS_KEY_MISSING', 'No se pudo preparar la clave del reproductor.', 500);
                    const bunnyUrl = `https://${library.pullZone}/${videoId}/playlist.m3u8`;
                    if (!existing) {
                        await db.addToCatalog({ videoId, title: cleanTitle, status: 'processing', sourceType: 'bunny', keyId,
                            bunnyUrl, courseId, producerId: course.producerId || null, segmentCount: 0 });
                        if (moduleId) await db.moveVideoToModule(videoId, moduleId);
                    } else if (!existing.keyId) await db.updateCatalogEntry({ videoId, keyId });

                    // A lost PUT response can be recovered without uploading again.
                    if (op.state === 'uploading' || op.state === 'upload_failed') {
                        const video = await transport.json('GET', STREAM_HOST, `/library/${library.libraryId}/videos/${videoId}`, library.libraryKey);
                        const remote = normalizeVideoStatus(video);
                        if ([1, 2, 3, 4, 7, 8].includes(remote.status)) {
                            await db.updateStreamOperation(operationId, { state: remote.ready ? 'ready' : 'processing', uploadPercent: 100, errorCode: null });
                            await getVideoStatus({ videoId, actor });
                            return operationResult(await db.getStreamOperation(operationId));
                        }
                    }
                    await db.updateStreamOperation(operationId, { state: 'uploading', uploadPercent: 0, errorCode: null });
                    let lastPercent = -1, lastAt = 0, progressWrite = Promise.resolve();
                    await transport.putFile({ libraryId: library.libraryId, libraryKey: library.libraryKey, videoId, filePath, fileSize: stat.size,
                        onProgress: percent => {
                            onProgress?.(percent);
                            if (percent >= lastPercent + 5 && Date.now() - lastAt >= 500) {
                                lastPercent = percent; lastAt = Date.now();
                                progressWrite = progressWrite.then(() => db.updateStreamOperation(operationId, { uploadPercent: percent })).catch(() => {});
                            }
                        } });
                    await progressWrite;
                    await db.updateStreamOperation(operationId, { state: 'processing', uploadPercent: 100, errorCode: null });
                    await db.updateCatalogEntry({ videoId, status: 'processing', error: null });
                    return { ...operationResult(await db.getStreamOperation(operationId)), libraryId: library.libraryId, bunnyUrl };
                } catch (error) {
                    const current = await db.getStreamOperation(operationId);
                    const state = error.code === 'PROVISION_UNCERTAIN' ? 'uncertain' : current?.video_id ? 'upload_failed' : 'reserved';
                    await db.updateStreamOperation(operationId, { state, errorCode: error.code || 'STREAM_ERROR' });
                    throw error;
                } finally { inFlightOperations.delete(operationId); }
            });
        } finally { activeUploads--; }
    }

    async function getVideoStatus({ videoId, actor }) {
        const entry = await db.getCatalogById(videoId);
        if (!entry || !entry.courseId || entry.sourceType !== 'bunny') throw failure('VIDEO_NOT_FOUND', 'Video no encontrado.', 404);
        await authorizeCourse(entry.courseId, actor);
        const library = await db.getCourseBunny(entry.courseId);
        if (!library?.libraryId || !library.libraryKey) throw failure('BUNNY_LIBRARY_INCOMPLETE', 'El curso no tiene una biblioteca configurada.', 409);
        const video = await transport.json('GET', STREAM_HOST, `/library/${library.libraryId}/videos/${encodeURIComponent(videoId)}`, library.libraryKey);
        if (video.guid && video.guid !== videoId) throw failure('BUNNY_VIDEO_MISMATCH', 'Bunny devolvió otro video.');
        const result = normalizeVideoStatus(video);
        const op = await db.getStreamOperationByVideo(videoId);
        // A live upload may still be reported as Created. Do not turn it into
        // a completed upload merely because the background worker polled it.
        const uploading = op && inFlightOperations.has(op.id) && result.status === 0;
        if (op && result.status === 0 && !uploading) {
            await db.updateStreamOperation(op.id, { state: 'upload_failed', providerStatus: 0, errorCode: 'UPLOAD_INCOMPLETE' });
            await db.updateCatalogEntry({ videoId, status: 'error', error: 'La subida no se completó.' });
            return { videoId, ...result, phase: 'upload_failed', failed: true, retryable: true, error: 'La subida no se completó. Reintenta con el mismo archivo.', uploadPercent: Number(op.upload_percent) || 0 };
        }
        if (!uploading) {
            const state = result.ready ? 'ready' : result.failed ? (result.retryable ? 'upload_failed' : 'error') : 'processing';
            if (result.ready && !entry.keyId) {
                const key = await createKey(videoId);
                await db.updateCatalogEntry({ videoId, keyId: typeof key === 'string' ? key : key.keyId });
            }
            await db.updateCatalogEntry({ videoId, status: result.ready ? 'ready' : result.failed ? 'error' : 'processing', error: result.error });
            if (op) await db.updateStreamOperation(op.id, { state, providerStatus: result.status, encodeProgress: result.encodeProgress,
                ...(result.status !== 0 ? { uploadPercent: 100 } : {}), errorCode: result.failed ? `BUNNY_STATUS_${result.status}` : null });
        }
        return { videoId, ...result, ...(uploading ? { phase: 'uploading' } : {}), uploadPercent: uploading ? Number(op.upload_percent) : 100 };
    }

    async function reconcilePending({ limit = 20 } = {}) {
        if (stopped || reconciling) return { checked: 0, errors: [] };
        reconciling = true;
        const errors = []; let checked = 0;
        try {
            const videos = await db.getPendingStreamVideos(limit);
            for (const videoId of videos) {
                if (stopped) break;
                try { await getVideoStatus({ videoId, actor: { admin: true } }); checked++; }
                catch (error) { errors.push({ videoId, code: error.code || 'STREAM_RECONCILE_ERROR' }); }
            }
            return { checked, errors };
        } finally { reconciling = false; }
    }

    return { ensureCourseLibrary, ensureModuleCollection, uploadVideo, getVideoStatus, getOperationStatus, reconcilePending,
        stop() { stopped = true; } };
}

module.exports = { createStreamService, createTransport, normalizeVideoStatus };
