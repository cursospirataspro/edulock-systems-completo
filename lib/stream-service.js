'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const https = require('node:https');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ACCOUNT_HOST = 'api.bunny.net';
const STREAM_HOST = 'video.bunnycdn.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A create whose response was lost is re-checked against Bunny's listing on every
// attempt. Only after this window (far beyond Bunny's list consistency) may a
// new create be issued, so an unconfirmed resource cannot stay stuck forever.
const UNCERTAIN_RECHECK_MS = 15 * 60 * 1000;

// Etapas del recorrido curso→biblioteca, módulo→colección, clase→video. Se
// registran y se devuelven al panel para indicar exactamente qué falló.
const STAGES = Object.freeze({
    'library-create': 'Creación de la biblioteca del curso',
    'library-verify': 'Verificación de la biblioteca',
    'library-protect': 'Protección de la biblioteca (DRM básico)',
    'storage-verify': 'Verificación del almacenamiento (Fráncfort)',
    'cdn-verify': 'Verificación del CDN de la biblioteca',
    'collection-verify': 'Verificación de la colección del módulo',
    'collection-create': 'Creación de la colección del módulo',
    'local-file': 'Lectura del archivo en el servidor',
    'video-create': 'Creación del video en Bunny',
    'video-collection': 'Asociación del video a la colección',
    'player-key': 'Preparación de la clave del reproductor',
    'video-transfer': 'Transferencia del archivo a Bunny',
    'video-status': 'Consulta del estado del video',
});

function failure(code, message, statusCode = 502, retryable = false, extra = {}) {
    return Object.assign(new Error(message), { code, statusCode, retryable, ...extra });
}
const safeText = (value, max = 240) => typeof value === 'string'
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
// Bunny's validation errors are JSON { ErrorKey, Field, Message }. Only those
// three short strings are kept: never the raw body, never headers or keys.
function providerDetail(status, text) {
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const pick = (...keys) => keys.map(key => parsed && typeof parsed === 'object' ? parsed[key] : undefined).find(v => typeof v === 'string');
    return { status, errorKey: safeText(pick('ErrorKey', 'errorKey', 'Key'), 80) || null,
        field: safeText(pick('Field', 'field'), 80) || null, message: safeText(pick('Message', 'message', 'title'), 240) || null };
}
function describeError(error) {
    return { code: error?.code || 'STREAM_ERROR', stage: error?.stage || null, status: error?.httpStatus || null,
        errorKey: error?.provider?.errorKey || null, message: error?.provider?.message || null,
        retryable: error?.retryable === true, at: new Date().toISOString() };
}
// The provider explicitly refused the request: nothing was created remotely.
function confirmedRejection(error) {
    if (!error || typeof error !== 'object') return false;
    if (error.code === 'BUNNY_REJECTED' || error.code === 'INVALID_BUNNY_HOST') return true;
    const status = Number(error.httpStatus);
    return error.code === 'BUNNY_HTTP_ERROR' && status >= 400 && status < 500 && ![408, 429].includes(status);
}
async function atStage(stage, fn) {
    try { return await fn(); }
    catch (error) { if (error && typeof error === 'object' && !error.stage) error.stage = stage; throw error; }
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
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        const retryable = response.statusCode === 429 || response.statusCode >= 500;
                        // The message stays generic; the provider's own validation
                        // keys travel separately so logs and the panel can name the cause.
                        return finish(failure('BUNNY_HTTP_ERROR', `Bunny respondió HTTP ${response.statusCode}.`, 502, retryable,
                            { httpStatus: response.statusCode, provider: providerDetail(response.statusCode, text) }));
                    }
                    let result;
                    try { result = text ? JSON.parse(text) : {}; }
                    catch { return finish(failure('BUNNY_INVALID_JSON', 'Bunny devolvió una respuesta incompleta.', 502, true)); }
                    if (result?.success === false || result?.Success === false) {
                        return finish(failure('BUNNY_REJECTED', 'Bunny rechazó la operación.', 502, false, { provider: providerDetail(response.statusCode, text) }));
                    }
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

function createStreamService({ db, getAccountKey, createKey, transport = createTransport(), logger = console, maxUploadBytes = 1024 ** 3, maxConcurrentUploads = 2 }) {
    if (!db || !getAccountKey || !createKey) throw new TypeError('db, getAccountKey and createKey are required');
    let activeUploads = 0, stopped = false, reconciling = false;
    const verifiedLibraries = new Map();
    const verifiedCollections = new Map();
    const inFlightOperations = new Set();
    const actorKey = actor => actor?.admin === true ? 'admin' : actor?.producerId ? `producer:${actor.producerId}` : null;
    // Structured, secret-free log line: method/endpoint are implicit in the stage; keys never enter this object.
    const warn = (event, fields) => { try { logger?.warn?.(`[stream/${event}] ${JSON.stringify(fields)}`); } catch { /* logging must never break provisioning */ } };

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
        if (saved?.remote_id) return { id: String(saved.remote_id) };
        const knownName = saved?.remote_name || remoteName;
        const found = await find(knownName);
        if (found) {
            const id = idOf(found);
            if (!id) throw failure('BUNNY_MISSING_ID', 'Bunny no devolvió el identificador del recurso.');
            await db.setStreamResource(resourceKey, { remoteName: knownName, state: 'ready', remoteId: id });
            return { id: String(id), value: found };
        }
        if (saved && saved.state !== 'reserved') {
            // An earlier POST might have succeeded without a response. The listing
            // above recovers it; absence in an eventually consistent list does not
            // authorize a second POST until the recheck window has clearly passed.
            const age = Date.now() - Date.parse(saved.updated_at || '');
            if (!(Number.isFinite(age) && age > UNCERTAIN_RECHECK_MS)) {
                throw failure('PROVISION_UNCERTAIN', 'La creación remota sigue sin confirmarse. Vuelve a consultar en unos minutos antes de crear otro recurso.', 409, true);
            }
            warn('provision-recreate', { resourceKey, ageMs: age });
        }
        await db.setStreamResource(resourceKey, { remoteName: knownName, state: 'creating' });
        try {
            const value = await create(knownName);
            const id = idOf(value);
            if (!id) throw failure('BUNNY_MISSING_ID', 'Bunny no devolvió el identificador del recurso.');
            await db.setStreamResource(resourceKey, { remoteName: knownName, state: 'ready', remoteId: id });
            return { id: String(id), value };
        } catch (error) {
            if (confirmedRejection(error)) {
                // Bunny refused the request (HTTP 4xx): nothing exists remotely, so the
                // resource goes back to 'reserved' and the original cause is reported.
                await db.setStreamResource(resourceKey, { remoteName: knownName, state: 'reserved' });
                warn('provision-rejected', { resourceKey, ...describeError(error) });
                throw error;
            }
            await db.setStreamResource(resourceKey, { remoteName: knownName, state: 'unknown' });
            warn('provision-uncertain', { resourceKey, ...describeError(error) });
            throw failure('PROVISION_UNCERTAIN', 'No se pudo confirmar la creación remota. El siguiente intento buscará el recurso antes de continuar.', 409, true, { cause: describeError(error) });
        }
    }

    async function ensureCourseLibrary({ courseId, actor }) {
        const course = await authorizeCourse(courseId, actor);
        return db.withStreamLock(`course:${courseId}`, async () => {
            const saved = await db.getCourseBunny(courseId);
            const cached = verifiedLibraries.get(courseId);
            if (cached && cached.until > Date.now() && String(saved?.libraryId) === cached.libraryId && saved?.libraryKey && saved?.pullZone) return saved;
            const key = await accountKey();
            let libraryId = saved?.libraryId;
            if (!libraryId) {
                const name = `${String(course.name).slice(0, 40)} [course:${courseId}]`;
                // Solo Fráncfort: ReplicationRegions vacío = ninguna réplica adicional.
                // La zona de almacenamiento se relee después para confirmarlo.
                const resource = await atStage('library-create', () => provision(`course:${courseId}`, name,
                    n => findRemote(ACCOUNT_HOST, '/videolibrary?includeAccessKey=true', key, n, 'Name'),
                    n => transport.json('POST', ACCOUNT_HOST, '/videolibrary', key, { Name: n, ReplicationRegions: [] }),
                    lib => lib.Id));
                libraryId = resource.id;
                await db.setCourseBunnyLibrary(courseId, { libraryId, libraryKey: resource.value?.ApiKey || null, pullZone: null });
            }
            const owned = await db.getStreamResource(`course:${courseId}`);
            const managed = !!owned && String(owned.remote_id) === String(libraryId);
            const readLibrary = () => atStage('library-verify', () => transport.json('GET', ACCOUNT_HOST, `/videolibrary/${encodeURIComponent(libraryId)}?includeAccessKey=true`, key));
            let library = await readLibrary();
            if (String(library.Id) !== String(libraryId) || !library.ApiKey || !library.PullZoneId || !library.StorageZoneId) {
                throw failure('BUNNY_LIBRARY_INCOMPLETE', 'La biblioteca todavía no tiene todos sus datos.', 503, true, { stage: 'library-verify' });
            }
            if (managed && library.EnableDRM !== true) {
                // MediaCage Basic DRM (GRATIS) + token de vista incrustada, solo en las
                // bibliotecas creadas por esta plataforma. NUNCA GoogleWidevineDrm /
                // AppleFairPlayDrm (DRM de pago), nunca ResetToken, nunca replicación.
                await atStage('library-protect', () => transport.json('POST', ACCOUNT_HOST, `/videolibrary/${libraryId}`, key, {
                    EnableDRM: true,
                    PlayerTokenAuthenticationEnabled: true,
                    BlockNoneReferrer: true,
                    AllowDirectPlay: true,
                }));
                library = await readLibrary();
                if (library.EnableDRM !== true) throw failure('BUNNY_DRM_UNCONFIRMED', 'Bunny todavía no confirmó la protección DRM de la biblioteca.', 503, true, { stage: 'library-protect' });
            }
            // StorageZone is authoritative: Library.ReplicationRegions may use
            // [''] for its default while StorageZone correctly reports DE/[].
            const storage = await atStage('storage-verify', () => transport.json('GET', ACCOUNT_HOST, `/storagezone/${library.StorageZoneId}`, key));
            const replicas = storage.ReplicationRegions;
            if (String(storage.Region).toUpperCase() !== 'DE' || !Array.isArray(replicas) || replicas.some(r => String(r).toUpperCase() !== 'DE')) {
                throw failure('BUNNY_REGION_MISMATCH', 'La biblioteca no confirma Frankfurt sin réplicas adicionales.', 409, false, { stage: 'storage-verify' });
            }
            const readPull = () => atStage('cdn-verify', () => transport.json('GET', ACCOUNT_HOST, `/pullzone/${library.PullZoneId}`, key));
            let pull = await readPull();
            if (library.EnableDRM !== true) {
                // Bibliotecas históricas sin DRM: conservan la protección por token del CDN.
                if (pull.ZoneSecurityEnabled !== true || pull.ZoneSecurityIncludeHashRemoteIP === true) {
                    if (!managed) throw failure('BUNNY_UNMANAGED_SECURITY', 'Esta biblioteca anterior necesita una revisión de protección antes de adoptarla.', 409, false, { stage: 'cdn-verify' });
                    await atStage('cdn-verify', () => transport.json('POST', ACCOUNT_HOST, `/videolibrary/${libraryId}`, key,
                        { EnableTokenAuthentication: true, EnableTokenIPVerification: false }));
                    pull = await readPull();
                }
                if (pull.ZoneSecurityEnabled !== true || pull.ZoneSecurityIncludeHashRemoteIP === true ||
                    typeof pull.ZoneSecurityKey !== 'string' || !pull.ZoneSecurityKey) {
                    throw failure('BUNNY_CDN_UNPROTECTED', 'Bunny todavía no confirmó la protección del CDN.', 503, true, { stage: 'cdn-verify' });
                }
            }
            // Con DRM básico activo, Bunny rechaza EnableTokenAuthentication en la
            // misma biblioteca (HTTP 400 VideoLibrary.TokenAuthAndDrmConflict), así
            // que aquí no se toca la seguridad del pull zone. Su clave, si existe,
            // solo se guarda para firmar URLs.
            const hostname = (pull.Hostnames || []).map(h => h.Value).find(h => typeof h === 'string' && /^[a-z0-9-]+\.b-cdn\.net$/i.test(h));
            if (!hostname) throw failure('BUNNY_HOSTNAME_MISSING', 'El hostname de la biblioteca aún no está disponible.', 503, true, { stage: 'cdn-verify' });
            const tokenKey = typeof pull.ZoneSecurityKey === 'string' && pull.ZoneSecurityKey ? pull.ZoneSecurityKey : null;
            const result = { libraryId: String(libraryId), libraryKey: library.ApiKey, pullZone: hostname, tokenKey, drm: library.EnableDRM === true };
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
            const base = `/library/${library.libraryId}/collections`;
            let saved = await db.getModuleBunnyCollection(moduleId);
            const cached = verifiedCollections.get(moduleId);
            if (saved && cached && cached.until > Date.now() && cached.id === saved && cached.libraryId === library.libraryId) return saved;
            if (saved) {
                // A stored identifier does not prove the collection still exists in
                // this course's library: confirm it, and rebuild it if it is gone.
                const remote = await atStage('collection-verify', () => transport.json('GET', STREAM_HOST, `${base}/${encodeURIComponent(saved)}`, library.libraryKey)
                    .catch(error => { if (error?.httpStatus === 404) return null; throw error; }));
                if (remote && String(remote.guid || remote.Guid) === String(saved)) {
                    verifiedCollections.set(moduleId, { id: saved, libraryId: library.libraryId, until: Date.now() + 60000 });
                    return saved;
                }
                warn('collection-missing', { courseId, moduleId, libraryId: library.libraryId, collectionId: saved });
                await db.setModuleBunnyCollection(moduleId, null);
                await db.clearStreamResource(`module:${moduleId}`);
                saved = null;
            }
            const name = `${String(mod.name).slice(0, 40)} [module:${moduleId}]`;
            const resource = await atStage('collection-create', () => provision(`module:${moduleId}`, name,
                n => findRemote(STREAM_HOST, base, library.libraryKey, n, 'name'),
                n => transport.json('POST', STREAM_HOST, base, library.libraryKey, { name: n }),
                collection => collection.guid || collection.Guid));
            if (!UUID.test(resource.id)) throw failure('BUNNY_INVALID_COLLECTION', 'Identificador de colección no válido.', 502, false, { stage: 'collection-create' });
            await db.setModuleBunnyCollection(moduleId, resource.id);
            verifiedCollections.set(moduleId, { id: resource.id, libraryId: library.libraryId, until: Date.now() + 60000 });
            return resource.id;
        });
    }

    function parseDetail(op) {
        try { return op?.error_detail ? JSON.parse(op.error_detail) : null; } catch { return null; }
    }
    function operationResult(op) {
        const detail = parseDetail(op);
        const ready = op.state === 'ready';
        const rejected = op.state === 'reserved' && !!op.error_code;
        const failed = ['error', 'upload_failed', 'deleted', 'uncertain'].includes(op.state) || rejected;
        const stage = detail?.stage || (op.state === 'upload_failed' ? 'video-transfer' : null);
        let error = null, action = null;
        if (op.state === 'deleted') error = 'Este video se quitó del catálogo y esta operación ya no puede reanudarse.';
        else if (op.state === 'uncertain') {
            error = 'No se confirmó la creación del recurso en Bunny.';
            action = 'Usa «Continuar seguimiento» o reintenta en unos minutos; no se creará un recurso duplicado.';
        } else if (op.state === 'error') {
            error = 'Bunny no pudo procesar el video.';
            action = 'Revisa el archivo y vuelve a subirlo como una clase nueva.';
        } else if (op.state === 'upload_failed') {
            error = 'La transferencia a Bunny no se completó.';
            action = 'Selecciona el mismo archivo y usa «Reintentar envío».';
        } else if (rejected) {
            error = `Falló la etapa «${STAGES[stage] || 'preparación en Bunny'}».`;
            action = detail?.status && detail.status < 500
                ? 'Bunny rechazó la petición. Corrige la causa indicada y vuelve a seleccionar el archivo para reintentar.'
                : 'Vuelve a seleccionar el archivo para reintentar. El video no llegó a Bunny.';
        }
        return { ok: !failed, operationId: op.id, videoId: op.video_id || null, status: ready ? 'ready' : failed ? 'error' : 'processing',
            phase: op.state, stage, stageLabel: stage ? STAGES[stage] || stage : null,
            uploadPercent: Number(op.upload_percent) || 0, encodeProgress: Number(op.encode_progress) || 0,
            ready, failed, retryable: ['reserved', 'upload_failed', 'uncertain'].includes(op.state),
            error, action, code: op.error_code || null,
            providerErrorKey: detail?.errorKey || null, providerMessage: detail?.message || null };
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
                const stat = await atStage('local-file', () => fs.promises.stat(filePath));
                if (!stat.isFile() || stat.size <= 0 || stat.size > maxUploadBytes) throw failure('UPLOAD_SIZE', 'El archivo está vacío o supera el límite permitido.', 413, false, { stage: 'local-file' });
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
                    // A retry starts clean: the previous failure must not be shown as
                    // current while the library and collection are being prepared.
                    if (op.error_code || op.error_detail) op = await db.updateStreamOperation(operationId, { errorCode: null, errorDetail: null }) || op;
                    const library = await ensureCourseLibrary({ courseId, actor });
                    const collectionId = moduleId ? await ensureModuleCollection({ courseId, moduleId, actor }) : null;
                    let videoId = op.video_id, remoteVideo = null;
                    if (!videoId) {
                        const remoteTitle = `${cleanTitle.slice(0, 140)} [upload:${operationId}]`;
                        const base = `/library/${library.libraryId}/videos`;
                        const resource = await atStage('video-create', () => provision(`upload:${operationId}`, remoteTitle,
                            n => findRemote(STREAM_HOST, base, library.libraryKey, n, 'title'),
                            n => transport.json('POST', STREAM_HOST, base, library.libraryKey, { title: n, ...(collectionId ? { collectionId } : {}) }),
                            video => video.guid || video.Guid));
                        videoId = resource.id;
                        remoteVideo = resource.value || null;
                        if (!UUID.test(videoId)) throw failure('BUNNY_INVALID_VIDEO', 'Identificador de video no válido.', 502, false, { stage: 'video-create' });
                        op = await db.updateStreamOperation(operationId, { videoId });
                    }
                    if (collectionId) {
                        // The selected module must really contain the video: a
                        // recovered or previously created video is moved if needed.
                        if (!remoteVideo) remoteVideo = await atStage('video-collection', () => transport.json('GET', STREAM_HOST, `/library/${library.libraryId}/videos/${videoId}`, library.libraryKey));
                        const remoteCollection = remoteVideo?.collectionId ?? remoteVideo?.CollectionId ?? null;
                        if (String(remoteCollection || '') !== String(collectionId)) {
                            await atStage('video-collection', () => transport.json('POST', STREAM_HOST, `/library/${library.libraryId}/videos/${videoId}`, library.libraryKey, { collectionId }));
                        }
                    }
                    const existing = await db.getCatalogById(videoId);
                    const key = existing?.keyId || await atStage('player-key', () => createKey(videoId));
                    const keyId = typeof key === 'string' ? key : key?.keyId;
                    if (!keyId) throw failure('HLS_KEY_MISSING', 'No se pudo preparar la clave del reproductor.', 500, false, { stage: 'player-key' });
                    const bunnyUrl = `https://${library.pullZone}/${videoId}/playlist.m3u8`;
                    if (!existing) {
                        await db.addToCatalog({ videoId, title: cleanTitle, status: 'processing', sourceType: 'bunny', keyId,
                            bunnyUrl, courseId, producerId: course.producerId || null, segmentCount: 0 });
                        if (moduleId) await db.moveVideoToModule(videoId, moduleId);
                    } else if (!existing.keyId) await db.updateCatalogEntry({ videoId, keyId });

                    // A lost PUT response can be recovered without uploading again.
                    if (op.state === 'uploading' || op.state === 'upload_failed') {
                        const video = await atStage('video-status', () => transport.json('GET', STREAM_HOST, `/library/${library.libraryId}/videos/${videoId}`, library.libraryKey));
                        const remote = normalizeVideoStatus(video);
                        if ([1, 2, 3, 4, 7, 8].includes(remote.status)) {
                            await db.updateStreamOperation(operationId, { state: remote.ready ? 'ready' : 'processing', uploadPercent: 100, errorCode: null, errorDetail: null });
                            await getVideoStatus({ videoId, actor });
                            return operationResult(await db.getStreamOperation(operationId));
                        }
                    }
                    await db.updateStreamOperation(operationId, { state: 'uploading', uploadPercent: 0, errorCode: null, errorDetail: null });
                    let lastPercent = -1, lastAt = 0, progressWrite = Promise.resolve();
                    await atStage('video-transfer', () => transport.putFile({ libraryId: library.libraryId, libraryKey: library.libraryKey, videoId, filePath, fileSize: stat.size,
                        onProgress: percent => {
                            onProgress?.(percent);
                            if (percent >= lastPercent + 5 && Date.now() - lastAt >= 500) {
                                lastPercent = percent; lastAt = Date.now();
                                progressWrite = progressWrite.then(() => db.updateStreamOperation(operationId, { uploadPercent: percent })).catch(() => {});
                            }
                        } }));
                    await progressWrite;
                    await db.updateStreamOperation(operationId, { state: 'processing', uploadPercent: 100, errorCode: null, errorDetail: null });
                    await db.updateCatalogEntry({ videoId, status: 'processing', error: null });
                    return { ...operationResult(await db.getStreamOperation(operationId)), libraryId: library.libraryId, bunnyUrl };
                } catch (error) {
                    const current = await db.getStreamOperation(operationId);
                    const state = error.code === 'PROVISION_UNCERTAIN' ? 'uncertain' : current?.video_id ? 'upload_failed' : 'reserved';
                    const detail = describeError(error);
                    await db.updateStreamOperation(operationId, { state, errorCode: error.code || 'STREAM_ERROR', errorDetail: JSON.stringify(detail) });
                    warn('upload-failed', { operationId, courseId, moduleId, state, ...detail });
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
        const video = await atStage('video-status', () => transport.json('GET', STREAM_HOST, `/library/${library.libraryId}/videos/${encodeURIComponent(videoId)}`, library.libraryKey));
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

module.exports = { createStreamService, createTransport, normalizeVideoStatus, describeError, confirmedRejection, STAGES };
