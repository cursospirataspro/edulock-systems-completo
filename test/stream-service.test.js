'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Writable, PassThrough } = require('node:stream');
const { createStreamService, createTransport, normalizeVideoStatus } = require('../lib/stream-service');

const COURSE = '00000000-0000-4000-8000-000000000001';
const MODULE = '00000000-0000-4000-8000-000000000002';
const VIDEO = '00000000-0000-4000-8000-000000000003';
const COLLECTION = '00000000-0000-4000-8000-000000000004';
const ADMIN = { admin: true };

function fakeDb() {
    const state = { courses: new Map([[COURSE, { id: COURSE, name: 'Prueba sintética', producerId: 'producer-one' }]]),
        modules: new Map([[MODULE, { id: MODULE, name: 'Módulo sintético', courseId: COURSE, producerId: 'producer-one' }]]),
        library: null, collection: null, resources: new Map(), operations: new Map(), catalog: new Map(), locks: new Set() };
    return { state,
        async getCourseById(id) { return state.courses.get(id) || null; },
        async getModuleById(id) { return state.modules.get(id) || null; },
        async getProducerById(id) { return { id, active: id === 'disabled' ? 0 : 1 }; },
        async withStreamLock(key, callback) {
            if (state.locks.has(key)) throw Object.assign(new Error('Busy'), { code: 'STREAM_BUSY' });
            state.locks.add(key); try { return await callback(); } finally { state.locks.delete(key); }
        },
        async getCourseBunny() { return state.library; },
        async setCourseBunnyLibrary(id, fields) { state.library = { ...state.library, ...fields }; },
        async getModuleBunnyCollection() { return state.collection; },
        async setModuleBunnyCollection(id, guid) { state.collection = guid; },
        async getStreamResource(key) { return state.resources.get(key) || null; },
        async setStreamResource(key, fields) { const old = state.resources.get(key); state.resources.set(key, {
            remote_name: old?.remote_name || fields.remoteName, remote_id: fields.remoteId || old?.remote_id || null, state: fields.state }); },
        async clearStreamResource(key) { state.resources.delete(key); },
        async reserveStreamOperation(f) {
            if (!state.operations.has(f.id)) state.operations.set(f.id, { id: f.id, actor_key: f.actorKey,
                course_id: f.courseId, module_id: f.moduleId, title: f.title, file_size: f.fileSize, file_sha256: f.fileSha256,
                state: 'reserved', video_id: null, upload_percent: 0, encode_progress: 0 });
            return state.operations.get(f.id);
        },
        async getStreamOperation(id) { return state.operations.get(id) || null; },
        async getStreamOperationByVideo(id) { return [...state.operations.values()].find(op => op.video_id === id) || null; },
        async updateStreamOperation(id, fields) {
            const map = { videoId: 'video_id', state: 'state', uploadPercent: 'upload_percent', providerStatus: 'provider_status', encodeProgress: 'encode_progress', errorCode: 'error_code', errorDetail: 'error_detail' };
            const op = state.operations.get(id); for (const [key, value] of Object.entries(fields)) op[map[key]] = value;
            return op;
        },
        async getCatalogById(id) { return state.catalog.get(id) || null; },
        async addToCatalog(entry) { state.catalog.set(entry.videoId, { ...entry }); },
        async updateCatalogEntry(entry) { Object.assign(state.catalog.get(entry.videoId), entry); },
        async moveVideoToModule(id, moduleId) { state.catalog.get(id).moduleId = moduleId; },
        async getPendingStreamVideos() { return [...state.catalog.values()].filter(v => v.status === 'processing').map(v => v.videoId); },
        async getModulesWithoutCollection() { return state.library?.libraryId && !state.collection ? [{ moduleId: MODULE, courseId: COURSE }] : []; },
    };
}

function fakeTransport() {
    const state = { calls: [], libraries: [], collections: [], videos: [], puts: 0, status: 2, progress: 30,
        region: 'DE', replicas: [], failCreate: false, createDespiteFailure: false, failPut: false, cdnSecurity: true, drm: false,
        rejectUpdate: null, rejectCollection: null, lostCollections: false };
    const rejection = (status, errorKey, message) => Object.assign(new Error(`Bunny respondió HTTP ${status}.`),
        { code: 'BUNNY_HTTP_ERROR', statusCode: 502, retryable: false, httpStatus: status, provider: { status, errorKey, field: null, message } });
    const transport = {
        state,
        async json(method, host, apiPath, key, body) {
            state.calls.push({ method, host, path: apiPath, body });
            const url = new URL(`https://${host}${apiPath}`);
            if (url.pathname === '/videolibrary' && method === 'GET') return { Items: state.libraries, TotalItems: state.libraries.length };
            if (url.pathname === '/videolibrary' && method === 'POST') {
                const value = { Id: 101, Name: body.Name, ApiKey: 'synthetic-library-key', PullZoneId: 102, StorageZoneId: 103 };
                if (!state.failCreate || state.createDespiteFailure) state.libraries.push(value);
                if (state.failCreate) throw Object.assign(new Error('Ambiguous network failure'), { code: 'BUNNY_TIMEOUT' });
                return value;
            }
            if (url.pathname === '/videolibrary/101') {
                if (method === 'POST') {
                    if (state.rejectUpdate) throw rejection(400, state.rejectUpdate, 'Synthetic validation rejection');
                    if (Object.hasOwn(body, 'EnableTokenAuthentication')) state.cdnSecurity = body.EnableTokenAuthentication === true;
                    if (Object.hasOwn(body, 'EnableDRM')) state.drm = body.EnableDRM === true;
                }
                return { ...state.libraries[0], EnableDRM: state.drm };
            }
            if (url.pathname === '/storagezone/103') return { Region: state.region, ReplicationRegions: state.replicas };
            if (url.pathname === '/pullzone/102') return { Hostnames: [{ Value: 'synthetic.b-cdn.net' }], ZoneSecurityEnabled: state.cdnSecurity, ZoneSecurityKey: 'synthetic-token-key' };
            if (url.pathname === '/library/101/collections' && method === 'GET') return { items: state.collections, totalItems: state.collections.length };
            if (url.pathname === '/library/101/collections' && method === 'POST') {
                if (state.rejectCollection) throw rejection(400, state.rejectCollection, 'Synthetic collection rejection');
                const value = { guid: COLLECTION, name: body.name }; state.collections.push(value); return value;
            }
            const collectionLookup = url.pathname.match(/^\/library\/101\/collections\/(.+)$/);
            if (collectionLookup && method === 'GET') {
                const found = !state.lostCollections && state.collections.find(c => c.guid === collectionLookup[1]);
                if (!found) throw rejection(404, 'collection.notFound', 'Collection not found');
                return found;
            }
            if (url.pathname === '/library/101/videos' && method === 'GET') return { items: state.videos, totalItems: state.videos.length };
            if (url.pathname === '/library/101/videos' && method === 'POST') { const value = { guid: VIDEO, title: body.title, collectionId: body.collectionId || '' }; state.videos.push(value); return value; }
            if (url.pathname === `/library/101/videos/${VIDEO}`) {
                if (method === 'POST') { const video = state.videos.find(v => v.guid === VIDEO); if (video) video.collectionId = body.collectionId; return { success: true }; }
                return { guid: VIDEO, status: state.status, encodeProgress: state.progress, collectionId: state.videos.find(v => v.guid === VIDEO)?.collectionId || '' };
            }
            throw new Error(`Unexpected fake route: ${method} ${url.pathname}`);
        },
        async putFile(args) {
            assert.equal(typeof args.filePath, 'string');
            assert.equal(args.buffer, undefined);
            state.puts++; args.onProgress?.(55);
            if (state.failPut) throw Object.assign(new Error('Transfer failed'), { code: 'UPLOAD_INTERRUPTED', retryable: true });
        },
    };
    return transport;
}

async function fixture(t) {
    const file = path.join(os.tmpdir(), `edulock-stream-test-${crypto.randomUUID()}.bin`);
    await fs.promises.writeFile(file, Buffer.alloc(256 * 1024, 7));
    t.after(() => fs.promises.unlink(file).catch(() => {}));
    return file;
}

function setup(overrides = {}) {
    const db = fakeDb(), transport = fakeTransport();
    const service = createStreamService({ db, transport, getAccountKey: async () => 'synthetic-account-key', createKey: async () => ({ keyId: 'synthetic-hls-key' }), ...overrides });
    return { db, transport, service };
}

test('GET video enum distinguishes transcoding, finished, upload failure and JIT from webhooks', () => {
    for (let status = 0; status <= 8; status++) {
        const result = normalizeVideoStatus({ status, encodeProgress: 100 });
        assert.equal(result.ready, status === 4);
        assert.equal(result.failed, status === 5 || status === 6);
        assert.equal(result.ready && result.failed, false);
    }
    assert.equal(normalizeVideoStatus({ status: 8, jitEncodingEnabled: true }).ready, true);
    for (const status of [9, -1, null, '4', undefined]) assert.equal(normalizeVideoStatus({ status }).ready, false);
    assert.equal(normalizeVideoStatus({ status: 3, encodeProgress: 140 }).encodeProgress, 100);
});

test('ownership and missing/mismatched modules fail before any Bunny request', async () => {
    const { service, transport, db } = setup();
    await assert.rejects(service.ensureCourseLibrary({ courseId: COURSE, actor: { producerId: 'other' } }), { code: 'COURSE_FORBIDDEN' });
    await assert.rejects(service.ensureCourseLibrary({ courseId: COURSE, actor: {} }), { code: 'AUTH_REQUIRED' });
    db.state.modules.get(MODULE).courseId = 'another-course';
    await assert.rejects(service.ensureModuleCollection({ courseId: COURSE, moduleId: MODULE, actor: ADMIN }), { code: 'MODULE_COURSE_MISMATCH' });
    assert.equal(transport.state.calls.length, 0);
});

test('library and collection provisioning is reused and confirms storage region', async () => {
    const { service, transport } = setup();
    await service.ensureModuleCollection({ courseId: COURSE, moduleId: MODULE, actor: { producerId: 'producer-one' } });
    await service.ensureModuleCollection({ courseId: COURSE, moduleId: MODULE, actor: ADMIN });
    assert.equal(transport.state.libraries.length, 1);
    assert.equal(transport.state.collections.length, 1);
    assert.deepEqual(transport.state.calls.find(c => c.method === 'POST' && c.path === '/videolibrary').body.ReplicationRegions, []);
    assert.ok(transport.state.calls.some(c => c.path === '/storagezone/103'));
});

test('non-Frankfurt provisioning is rejected without a second library on retry', async () => {
    const { service, transport, db } = setup();
    transport.state.region = 'NY';
    await assert.rejects(service.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN }), { code: 'BUNNY_REGION_MISMATCH' });
    assert.equal(db.state.library.libraryId, '101');
    transport.state.region = 'DE'; transport.state.replicas = ['SG'];
    await assert.rejects(service.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN }), { code: 'BUNNY_REGION_MISMATCH' });
    assert.equal(transport.state.libraries.length, 1);
});

test('a newly managed library enables MediaCage Basic DRM and never requests CDN token auth alongside it', async () => {
    const { service, transport, db } = setup(); transport.state.cdnSecurity = false;
    const library = await service.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN });
    const updates = transport.state.calls.filter(call => call.method === 'POST' && call.path === '/videolibrary/101');
    // MediaCage Basic (GRATIS) = EnableDRM:true + token de vista incrustada.
    const drm = updates.find(u => u.body && u.body.EnableDRM === true);
    assert.ok(drm, 'debe activar MediaCage Basic (EnableDRM:true)');
    assert.equal(drm.body.PlayerTokenAuthenticationEnabled, true);
    // Bunny rechaza EnableTokenAuthentication junto con DRM básico (HTTP 400
    // VideoLibrary.TokenAuthAndDrmConflict): con DRM activo nunca se solicita.
    assert.equal(updates.some(u => u.body && Object.hasOwn(u.body, 'EnableTokenAuthentication')), false, 'con DRM nunca se toca el token del CDN');
    // INVARIANTES DE SEGURIDAD: nunca DRM de pago, ni reset de clave, ni replicación.
    for (const u of updates) {
        assert.equal('GoogleWidevineDrm' in u.body, false, 'nunca DRM de pago Widevine');
        assert.equal('AppleFairPlayDrm' in u.body, false, 'nunca DRM de pago FairPlay');
        assert.equal('ApiKey' in u.body, false, 'nunca resetear la clave');
        assert.equal('ResetToken' in u.body, false, 'nunca resetear el token');
        assert.equal('ReplicationRegions' in u.body, false, 'nunca cambiar replicación aquí');
    }
    assert.equal(library.drm, true);
    assert.equal(library.tokenKey, 'synthetic-token-key'); assert.equal(db.state.library.tokenKey, 'synthetic-token-key');
    // Idempotent: a second verification does not repeat the DRM update.
    await service.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN });
    assert.equal(transport.state.calls.filter(call => call.method === 'POST' && call.path === '/videolibrary/101').length, 1);
});

test('a historical DRM library whose pull zone has no token is adopted without touching its security', async () => {
    const { service, transport, db } = setup();
    transport.state.cdnSecurity = false; transport.state.drm = true;
    transport.state.libraries.push({ Id: 101, ApiKey: 'synthetic', PullZoneId: 102, StorageZoneId: 103 });
    db.state.library = { libraryId: '101', libraryKey: 'synthetic', pullZone: null };
    const library = await service.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN });
    assert.equal(library.pullZone, 'synthetic.b-cdn.net'); assert.equal(library.drm, true);
    assert.equal(transport.state.calls.some(call => call.method === 'POST'), false);
});

test('a provider validation rejection during protection is reported with stage and error key, and leaves no uncertain state', async t => {
    const { service, transport, db } = setup(); const filePath = await fixture(t);
    transport.state.rejectUpdate = 'VideoLibrary.TokenAuthAndDrmConflict';
    const input = { filePath, title: 'Clase', courseId: COURSE, moduleId: MODULE, actor: ADMIN, operationId: crypto.randomUUID() };
    await assert.rejects(service.uploadVideo(input), error => {
        assert.equal(error.code, 'BUNNY_HTTP_ERROR'); assert.equal(error.stage, 'library-protect'); assert.equal(error.httpStatus, 400);
        assert.equal(error.provider.errorKey, 'VideoLibrary.TokenAuthAndDrmConflict'); return true;
    });
    const op = db.state.operations.get(input.operationId);
    assert.equal(op.state, 'reserved'); assert.equal(op.error_code, 'BUNNY_HTTP_ERROR');
    const detail = JSON.parse(op.error_detail);
    assert.equal(detail.stage, 'library-protect'); assert.equal(detail.errorKey, 'VideoLibrary.TokenAuthAndDrmConflict');
    assert.equal(JSON.stringify(detail).includes('synthetic-library-key'), false);
    const status = await service.getOperationStatus({ operationId: input.operationId, actor: ADMIN });
    assert.equal(status.failed, true); assert.equal(status.retryable, true); assert.equal(status.stage, 'library-protect');
    assert.match(status.error, /Protección de la biblioteca/); assert.ok(status.action);
    // Retry after the cause is fixed: the library is still the same remote resource.
    transport.state.rejectUpdate = null;
    const result = await service.uploadVideo(input);
    assert.equal(result.ready, false); assert.equal(transport.state.libraries.length, 1); assert.equal(transport.state.puts, 1);
    assert.equal(db.state.operations.get(input.operationId).error_detail, null);
});

test('a confirmed 4xx rejection of a collection create returns the resource to reserved instead of uncertain', async () => {
    const { service, transport, db } = setup();
    transport.state.rejectCollection = 'collection.invalidName';
    await assert.rejects(service.ensureModuleCollection({ courseId: COURSE, moduleId: MODULE, actor: ADMIN }), error => {
        assert.equal(error.code, 'BUNNY_HTTP_ERROR'); assert.equal(error.stage, 'collection-create'); assert.equal(error.provider.errorKey, 'collection.invalidName'); return true;
    });
    assert.equal(db.state.resources.get(`module:${MODULE}`).state, 'reserved');
    transport.state.rejectCollection = null;
    assert.equal(await service.ensureModuleCollection({ courseId: COURSE, moduleId: MODULE, actor: ADMIN }), COLLECTION);
    assert.equal(transport.state.collections.length, 1);
});

test('a stored collection id that no longer exists remotely is verified and rebuilt without a duplicate library', async () => {
    const { service, transport, db } = setup();
    assert.equal(await service.ensureModuleCollection({ courseId: COURSE, moduleId: MODULE, actor: ADMIN }), COLLECTION);
    const fresh = createStreamService({ db, transport, getAccountKey: async () => 'synthetic', createKey: async () => 'synthetic' });
    transport.state.lostCollections = true; transport.state.collections.length = 0;
    assert.equal(await fresh.ensureModuleCollection({ courseId: COURSE, moduleId: MODULE, actor: ADMIN }), COLLECTION);
    assert.equal(transport.state.calls.filter(c => c.method === 'POST' && c.path === '/library/101/collections').length, 2);
    assert.equal(transport.state.libraries.length, 1);
    assert.equal(db.state.collection, COLLECTION);
});

test('background reconciliation creates the collection of a module saved without one, for any producer', async () => {
    const { service, transport, db } = setup();
    await service.ensureCourseLibrary({ courseId: COURSE, actor: { producerId: 'producer-one' } });
    assert.equal(db.state.collection, null);
    transport.state.rejectCollection = 'collection.invalidName';
    assert.equal((await service.reconcileCollections()).errors[0].code, 'BUNNY_HTTP_ERROR');
    transport.state.rejectCollection = null;
    assert.deepEqual(await service.reconcileCollections(), { repaired: 1, errors: [] });
    assert.equal(db.state.collection, COLLECTION);
    assert.deepEqual(await service.reconcileCollections(), { repaired: 0, errors: [] }, 'nothing left to repair');
    assert.equal(transport.state.collections.length, 1);
});

test('a video created for a module is confirmed inside that collection', async t => {
    const { service, transport } = setup(); const filePath = await fixture(t);
    await service.uploadVideo({ filePath, title: 'Clase', courseId: COURSE, moduleId: MODULE, actor: ADMIN, operationId: crypto.randomUUID() });
    assert.equal(transport.state.videos[0].collectionId, COLLECTION);
    assert.equal(transport.state.calls.some(c => c.method === 'POST' && c.path === `/library/101/videos/${VIDEO}`), false, 'no move needed when created in place');
});

test('security settings of an unmanaged historical library are not changed', async () => {
    const { service, transport, db } = setup();
    transport.state.cdnSecurity = false;
    transport.state.libraries.push({ Id: 101, ApiKey: 'synthetic', PullZoneId: 102, StorageZoneId: 103 });
    db.state.library = { libraryId: '101', libraryKey: 'synthetic', pullZone: 'synthetic.b-cdn.net' };
    await assert.rejects(service.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN }), { code: 'BUNNY_UNMANAGED_SECURITY' });
    assert.equal(transport.state.calls.some(call => call.method === 'POST'), false);
});

test('simultaneous provisioning cannot create two remote libraries', async () => {
    const { service, transport } = setup();
    const results = await Promise.allSettled([service.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN }), service.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STREAM_BUSY');
    assert.equal(transport.state.libraries.length, 1);
});

test('lost create response is reconciled by stable remote identity after restart', async () => {
    const { service, transport, db } = setup();
    transport.state.failCreate = true; transport.state.createDespiteFailure = true;
    await assert.rejects(service.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN }), { code: 'PROVISION_UNCERTAIN' });
    const restarted = createStreamService({ db, transport, getAccountKey: async () => 'synthetic', createKey: async () => 'synthetic' });
    const library = await restarted.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN });
    assert.equal(library.libraryId, '101');
    assert.equal(transport.state.calls.filter(c => c.method === 'POST' && c.path === '/videolibrary').length, 1);
});

test('an uncertain create absent from listing never blindly creates another resource', async () => {
    const { service, transport } = setup(); transport.state.failCreate = true;
    await assert.rejects(service.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN }), { code: 'PROVISION_UNCERTAIN' });
    await assert.rejects(service.ensureCourseLibrary({ courseId: COURSE, actor: ADMIN }), { code: 'PROVISION_UNCERTAIN' });
    assert.equal(transport.state.calls.filter(c => c.method === 'POST').length, 1);
});

test('upload stores ownership and HLS key, retry reuses video, background status completes it', async t => {
    const { service, transport, db } = setup(); const filePath = await fixture(t);
    const input = { filePath, title: 'Clase', courseId: COURSE, moduleId: MODULE, actor: { producerId: 'producer-one' }, operationId: crypto.randomUUID() };
    const result = await service.uploadVideo(input);
    assert.equal(result.videoId, VIDEO); assert.equal(result.ready, false);
    const video = db.state.catalog.get(VIDEO);
    assert.equal(video.keyId, 'synthetic-hls-key'); assert.equal(video.producerId, 'producer-one'); assert.equal(video.moduleId, MODULE);
    await service.uploadVideo(input);
    assert.equal(transport.state.puts, 1); assert.equal(transport.state.videos.length, 1);
    transport.state.status = 4;
    assert.equal((await service.reconcilePending()).checked, 1);
    assert.equal(video.status, 'ready'); assert.equal(video.keyId, 'synthetic-hls-key');
    const restored = await service.getOperationStatus({ operationId: input.operationId, actor: input.actor });
    assert.equal(restored.ready, true);
    assert.equal(Object.hasOwn(restored, 'file_sha256'), false);
    assert.equal(Object.hasOwn(restored, 'libraryKey'), false);
});

test('operation id cannot be reused with different file or owner', async t => {
    const { service } = setup(); const filePath = await fixture(t);
    const input = { filePath, title: 'Clase', courseId: COURSE, actor: ADMIN, operationId: crypto.randomUUID() };
    await service.uploadVideo(input);
    await assert.rejects(service.uploadVideo({ ...input, title: 'Otra clase' }), { code: 'OPERATION_CONFLICT' });
    await assert.rejects(service.getOperationStatus({ operationId: input.operationId, actor: { producerId: 'producer-one' } }), { code: 'OPERATION_NOT_FOUND' });
});

test('interrupted PUT repeats bytes to the same remote video and retains the key', async t => {
    const { service, transport, db } = setup(); const filePath = await fixture(t);
    const input = { filePath, title: 'Clase', courseId: COURSE, actor: ADMIN, operationId: crypto.randomUUID() };
    transport.state.failPut = true; transport.state.status = 0;
    await assert.rejects(service.uploadVideo(input), { code: 'UPLOAD_INTERRUPTED' });
    assert.equal((await service.getVideoStatus({ videoId: VIDEO, actor: ADMIN })).retryable, true);
    transport.state.failPut = false;
    await service.uploadVideo(input);
    assert.equal(transport.state.puts, 2); assert.equal(transport.state.videos.length, 1);
    assert.equal(db.state.catalog.get(VIDEO).keyId, 'synthetic-hls-key');
});

test('a lost successful PUT response recovers the provider state without resending bytes', async t => {
    const { service, transport } = setup(); const filePath = await fixture(t);
    const input = { filePath, title: 'Clase', courseId: COURSE, actor: ADMIN, operationId: crypto.randomUUID() };
    transport.state.failPut = true;
    await assert.rejects(service.uploadVideo(input), { code: 'UPLOAD_INTERRUPTED' });
    transport.state.status = 4; transport.state.failPut = false;
    assert.equal((await service.uploadVideo(input)).ready, true);
    assert.equal(transport.state.puts, 1);
});

test('transport streams bounded chunks and propagates backpressure without holding the file', async t => {
    const filePath = await fixture(t); let maxChunk = 0, bytes = 0, options;
    const transport = createTransport({ request(input, respond) {
        options = input;
        const req = new Writable({ highWaterMark: 1024, write(chunk, encoding, done) {
            bytes += chunk.length; maxChunk = Math.max(maxChunk, chunk.length); setTimeout(done, 1);
        } });
        req.on('finish', () => { const response = new PassThrough(); response.statusCode = 200; respond(response); response.end('{"success":true}'); });
        return req;
    } });
    await transport.putFile({ libraryId: '1', libraryKey: 'synthetic', videoId: VIDEO, filePath, fileSize: 256 * 1024 });
    assert.equal(bytes, 256 * 1024); assert.ok(maxChunk <= 64 * 1024);
    assert.equal(options.headers['Content-Length'], bytes);
});

test('transport does not expose provider response bodies in HTTP failures', async () => {
    const transport = createTransport({ request(input, respond) {
        const req = new Writable({ write(chunk, encoding, done) { done(); } });
        req.on('finish', () => { const response = new PassThrough(); response.statusCode = 403; respond(response); response.end('{"message":"synthetic-sensitive-provider-detail"}'); });
        return req;
    } });
    await assert.rejects(transport.json('GET', 'api.bunny.net', '/videolibrary', 'synthetic'), error => {
        assert.equal(error.code, 'BUNNY_HTTP_ERROR'); assert.equal(error.message.includes('synthetic-sensitive'), false); return true;
    });
});

test('transport timeout destroys its request and rejects instead of hanging', async () => {
    let request;
    const transport = createTransport({ request() {
        request = new Writable({ write(chunk, encoding, done) { done(); } });
        request.on('finish', () => setImmediate(() => request.emit('timeout')));
        return request;
    } });
    await assert.rejects(transport.json('GET', 'api.bunny.net', '/videolibrary', 'synthetic'), { code: 'BUNNY_TIMEOUT' });
    assert.equal(request.destroyed, true);
});
