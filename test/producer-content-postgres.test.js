'use strict';
// Run only against an explicitly designated disposable QA database. Cleanup is
// restricted to UUIDs created by this test; existing customer rows are untouched.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
let databaseName = '';
try { databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL || '').pathname.slice(1)); } catch {}
const allowed = /^edulock_qa(?:_[a-zA-Z0-9-]+)*$/;
if (!allowed.test(databaseName)) { console.error('REFUSED: producer content tests require an explicitly named edulock_qa database.'); process.exit(1); }
for (const key of ['COURSES_SEED', 'CATALOG_SEED', 'CATALOG_SEED_1', 'CATALOG_SEED_2', 'CATALOG_SEED_3', 'ALLOWED_DOMAINS_SEED']) delete process.env[key];
const db = require('../database-pg');
const { ensureSchema, createProducerContent, getPublicVideoPresentation } = require('../lib/producer-content');
const service = createProducerContent({ db, generatePublicCode: id => id.replaceAll('-', '') });
const tracked = { producers: [], courses: [], modules: [], catalog: [], licenses: [], license_lots: [], protected_resources: [], stream_operations: [] };
const id = table => { const value = randomUUID(); tracked[table].push(value); return value; };
const query = (...args) => db.pool.query(...args);
before(async () => {
    const actual = (await query('SELECT current_database() AS name')).rows[0].name;
    assert.equal(actual, databaseName); assert.match(actual, allowed); await db.initDb(); await ensureSchema(db);
});
after(async () => {
    try {
        await query('DELETE FROM producer_content_settings WHERE producer_id=ANY($1::text[])', [tracked.producers]);
        await query('DELETE FROM deleted_videos WHERE video_id=ANY($1::text[])', [tracked.catalog]);
        for (const table of ['protected_resources', 'stream_operations', 'licenses', 'license_lots', 'catalog', 'modules', 'courses', 'producers']) if (tracked[table].length) await query(`DELETE FROM ${table} WHERE ${table === 'catalog' ? 'video_id' : 'id'}=ANY($1::text[])`, [tracked[table]]);
    } finally { await db.pool.end(); }
});
async function fixture() {
    const producerId = id('producers'), courseId = id('courses'), secondCourse = id('courses'), moduleId = id('modules'), childId = id('modules'), videoId = id('catalog');
    await query('INSERT INTO producers(id,email,name,active,created_at) VALUES($1,$2,$3,1,$4)', [producerId, producerId + '@content-qa.invalid', 'Synthetic', new Date().toISOString()]);
    await db.createCourse({ id: courseId, name: 'Course', producerId });
    await db.createCourse({ id: secondCourse, name: 'Second', producerId });
    await db.createModule({ id: moduleId, courseId, name: 'Module', producerId });
    await db.createModule({ id: childId, courseId, parentId: moduleId, name: 'Child', producerId });
    await db.addToCatalog({ videoId, title: 'Video', courseId, producerId, status: 'ready', sourceType: 'local' });
    await db.moveVideoToModule(videoId, moduleId);
    return { producerId, courseId, secondCourse, moduleId, childId, videoId };
}
async function resource(f, protection = 'protected') {
    const resourceId = id('protected_resources');
    await query(`INSERT INTO protected_resources(id,target_kind,target_id,course_id,producer_id,name,type,protection,storage_key,mime_type,byte_size,page_count,created_at,updated_at)
        VALUES($1,'video',$2,$3,$4,'PDF','document',$5,$6,'application/pdf',2345,1,$7,$7)`, [resourceId, f.videoId, f.courseId, f.producerId, protection, randomUUID(), new Date().toISOString()]);
    return resourceId;
}
test('workspace is owner-scoped and credentials do not leak through DTOs', async () => {
    const a = await fixture(), b = await fixture();
    await query("UPDATE courses SET bunny_library_key='SYNTHETIC-SECRET',bunny_token_key='TOKEN-SECRET' WHERE id=$1", [a.courseId]);
    await query("UPDATE catalog SET bunny_url='https://secret.invalid/file' WHERE video_id=$1", [a.videoId]);
    const result = await service.projects(a.producerId);
    assert.equal(result.projects.length, 2); assert.equal(result.projects.some(c => c.id === b.courseId), false);
    assert.equal(result.projects.find(c => c.id === a.courseId).videos[0].videoId, a.videoId);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC-SECRET|TOKEN-SECRET|secret\.invalid|bunny_library/);
});
test('foreign updates and deletes cannot modify another producer or disclose dependencies', async () => {
    const a = await fixture(), b = await fixture();
    for (const [kind, key] of [['course', 'courseId'], ['module', 'moduleId'], ['video', 'videoId']]) {
        await assert.rejects(service.remove(a.producerId, kind, b[key]), { code: 'CONTENT_NOT_FOUND', statusCode: 404 });
        const method = 'update' + kind[0].toUpperCase() + kind.slice(1);
        await assert.rejects(service[method](a.producerId, b[key], kind === 'video' ? { title: 'Intrusion' } : { name: 'Intrusion' }), { code: 'CONTENT_NOT_FOUND' });
    }
    await assert.rejects(service.updateVideo(a.producerId, a.videoId, { courseId: b.courseId }), { code: 'CONTENT_NOT_FOUND' });
    assert.equal((await db.getCatalogById(a.videoId)).courseId, a.courseId);
});
test('project and video presentation survive a new service instance without changing protection', async () => {
    const f = await fixture(); const rid = await resource(f);
    await service.updateCourse(f.producerId, f.courseId, { name: 'Edited', author: 'Author', sortOrder: 5, settings: { purchaseUrl: 'https://example.invalid/buy', description: 'Course description' } });
    await service.updateVideo(f.producerId, f.videoId, { title: 'Edited video', sortOrder: 2, presentation: { coverUrl: 'https://example.invalid/cover.jpg', theme: 'light', description: 'Video description' } });
    const fresh = createProducerContent({ db }); const result = await fresh.projects(f.producerId);
    const course = result.projects.find(c => c.id === f.courseId);
    assert.equal(course.settings.purchaseUrl, 'https://example.invalid/buy'); assert.equal(course.name, 'Edited'); assert.equal(course.videos[0].presentation.theme, 'light');
    assert.equal((await query('SELECT protection FROM protected_resources WHERE id=$1', [rid])).rows[0].protection, 'protected');
});
test('module moves reject cycles, foreign parents and cross-course parents', async () => {
    const f = await fixture();
    await assert.rejects(service.updateModule(f.producerId, f.moduleId, { parentId: f.moduleId }), { code: 'CONTENT_MODULE_CYCLE' });
    await assert.rejects(service.updateModule(f.producerId, f.moduleId, { parentId: f.childId }), { code: 'CONTENT_MODULE_CYCLE' });
    const otherId = id('modules'); await db.createModule({ id: otherId, courseId: f.secondCourse, name: 'Other', producerId: f.producerId });
    await assert.rejects(service.updateModule(f.producerId, f.moduleId, { parentId: otherId }), { code: 'CONTENT_MODULE_COURSE_MISMATCH' });
    await service.updateModule(f.producerId, f.childId, { parentId: null, sortOrder: 7 });
    const child = await db.getModuleById(f.childId); assert.equal(child.parentId, null); assert.equal(child.sortOrder, 7);
});
test('simultaneous inverse reparenting cannot commit a cycle', async () => {
    const f = await fixture(); await service.updateModule(f.producerId, f.childId, { parentId: null });
    const results = await Promise.allSettled([service.updateModule(f.producerId, f.moduleId, { parentId: f.childId }), service.updateModule(f.producerId, f.childId, { parentId: f.moduleId })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'CONTENT_MODULE_CYCLE');
});
test('video moves keep resource ownership, change course atomically and invalidate old resource versions', async () => {
    const f = await fixture(); const rid = await resource(f);
    await service.updateVideo(f.producerId, f.videoId, { courseId: f.secondCourse });
    const video = await db.getCatalogById(f.videoId), pdf = (await query('SELECT * FROM protected_resources WHERE id=$1', [rid])).rows[0];
    assert.equal(video.courseId, f.secondCourse); assert.equal(video.moduleId, null); assert.equal(pdf.course_id, f.secondCourse); assert.equal(pdf.producer_id, f.producerId); assert.equal(pdf.version, 2); assert.equal(pdf.protection, 'protected');
    await assert.rejects(service.updateVideo(f.producerId, f.videoId, { courseId: null }), { code: 'CONTENT_PROTECTED_COURSE_REQUIRED' });
    assert.equal((await db.getCatalogById(f.videoId)).courseId, f.secondCourse);
});
test('Bunny videos cannot move between different provider libraries', async () => {
    const f = await fixture();
    await query("UPDATE catalog SET source_type='bunny' WHERE video_id=$1", [f.videoId]);
    await query("UPDATE courses SET bunny_library_id='111' WHERE id=$1", [f.courseId]);
    await query("UPDATE courses SET bunny_library_id='222' WHERE id=$1", [f.secondCourse]);
    await assert.rejects(service.updateVideo(f.producerId, f.videoId, { courseId: f.secondCourse }), { code: 'CONTENT_LIBRARY_MISMATCH' });
    assert.equal((await db.getCatalogById(f.videoId)).courseId, f.courseId);
});
test('delete refuses populated course/module/video and never removes licenses or PDF metadata', async () => {
    const f = await fixture(); const rid = await resource(f);
    for (const [kind, id] of [['course', f.courseId], ['module', f.moduleId], ['video', f.videoId]]) await assert.rejects(service.remove(f.producerId, kind, id), { code: 'CONTENT_HAS_DEPENDENCIES' });
    assert.equal((await query('SELECT id FROM protected_resources WHERE id=$1', [rid])).rows.length, 1);
    const lid = id('licenses'); await query("INSERT INTO licenses(id,license_key_hash,course_id,status,max_devices,created_at,producer_id) VALUES($1,$2,$3,'free',1,$4,$5)", [lid, randomUUID(), f.secondCourse, new Date().toISOString(), f.producerId]);
    await assert.rejects(service.remove(f.producerId, 'course', f.secondCourse), { code: 'CONTENT_HAS_DEPENDENCIES' });
    assert.equal((await query('SELECT id FROM licenses WHERE id=$1', [lid])).rows.length, 1);
});
test('empty entities can be removed, video tombstone persists, no remote operation is needed', async () => {
    const f = await fixture();
    const removed = await service.remove(f.producerId, 'video', f.videoId); assert.equal(removed.providerFilesDeleted, false); assert.equal(await db.getCatalogById(f.videoId), null);
    assert.equal((await query('SELECT video_id FROM deleted_videos WHERE video_id=$1', [f.videoId])).rows.length, 1);
    await service.remove(f.producerId, 'module', f.childId); await service.remove(f.producerId, 'module', f.moduleId); await service.remove(f.producerId, 'course', f.courseId);
    assert.equal(await db.getCourseById(f.courseId), null);
});
test('playlist publication generates cover codes, respects sort, revokes instantly and follows account suspension', async () => {
    const f = await fixture(); const secondVideo = id('catalog');
    await db.addToCatalog({ videoId: secondVideo, title: 'First in order', courseId: f.courseId, producerId: f.producerId, status: 'ready' }); await db.moveVideoToModule(secondVideo, f.moduleId);
    await service.updateVideo(f.producerId, f.videoId, { sortOrder: 8, presentation: { description: 'Description', theme: 'light' } });
    const module = await service.updateModule(f.producerId, f.moduleId, { playlistPublished: true });
    assert.match(module.playlistCode, /^[a-zA-Z0-9_-]{24}$/);
    const listing = await service.playlist(module.playlistCode); assert.equal(listing.videos[0].title, 'First in order'); assert.equal(listing.videos.length, 2);
    const publicCode = (await db.getCatalogById(f.videoId)).publicCode; assert.equal((await getPublicVideoPresentation(db, publicCode)).theme, 'light');
    await query('UPDATE producers SET active=0 WHERE id=$1', [f.producerId]); await assert.rejects(service.playlist(module.playlistCode), { code: 'CONTENT_NOT_FOUND' });
    await query('UPDATE producers SET active=1 WHERE id=$1', [f.producerId]); await service.updateModule(f.producerId, f.moduleId, { playlistPublished: false });
    await assert.rejects(service.playlist(module.playlistCode), { code: 'CONTENT_NOT_FOUND' });
});
test('storage reports known original bytes and unknown sizes without inventing provider consumption', async () => {
    const f = await fixture(), other = await fixture(); await resource(f);
    const opId = id('stream_operations');
    await query("INSERT INTO stream_operations(id,actor_key,course_id,title,file_size,file_sha256,video_id,state,created_at,updated_at) VALUES($1,$2,$3,'Video',1000,$4,$5,'ready',$6,$6)", [opId, 'producer:' + f.producerId, f.courseId, '0'.repeat(64), f.videoId, new Date().toISOString()]);
    const result = await service.storage(f.producerId);
    assert.equal(result.total, 2); assert.equal(result.knownBytes, 3345); assert.equal(result.capacityBytes, null); assert.equal(result.trafficBytes, null); assert.equal(result.providerUsageKnown, false);
    assert.equal(JSON.stringify(result).includes(other.videoId), false); assert.equal(result.items.some(item => own(item, 'storageKey')), false);
    const filtered = await service.storage(f.producerId, { q: 'PDF' }); assert.equal(filtered.items.length, 1); assert.equal(filtered.total, 2);
});
test('atomic reordering validates the entire owned course and keeps previous order on stale or foreign input', async () => {
    const f = await fixture();
    const changed = await service.reorder(f.producerId, { kind: 'modules', courseId: f.courseId, ids: [f.childId, f.moduleId] });
    assert.equal(changed.count, 2); assert.equal((await db.getModuleById(f.childId)).sortOrder, 10); assert.equal((await db.getModuleById(f.moduleId)).sortOrder, 20);
    await assert.rejects(service.reorder(f.producerId, { kind: 'modules', courseId: f.courseId, ids: [f.moduleId] }), { code: 'CONTENT_ORDER_CHANGED' });
    await assert.rejects(service.reorder(f.producerId, { kind: 'modules', courseId: f.courseId, ids: [f.moduleId, randomUUID()] }), { code: 'CONTENT_ORDER_CHANGED' });
    assert.equal((await db.getModuleById(f.childId)).sortOrder, 10); assert.equal((await db.getModuleById(f.moduleId)).sortOrder, 20);
});
test('container reordering validates only the siblings of one parent or module and rejects foreign, duplicate or missing ids', async () => {
    const f = await fixture();
    const secondRoot = id('modules'); await db.createModule({ id: secondRoot, courseId: f.courseId, name: 'Second root', producerId: f.producerId });
    assert.equal((await db.getModuleById(secondRoot)).sortOrder > (await db.getModuleById(f.moduleId)).sortOrder, true, 'a new module lands after its siblings automatically');
    const childBefore = (await db.getModuleById(f.childId)).sortOrder;
    const result = await service.reorder(f.producerId, { kind: 'modules', courseId: f.courseId, parentId: null, ids: [secondRoot, f.moduleId] });
    assert.equal(result.count, 2); assert.equal(result.parentId, null);
    assert.equal((await db.getModuleById(secondRoot)).sortOrder, 10); assert.equal((await db.getModuleById(f.moduleId)).sortOrder, 20); assert.equal((await db.getModuleById(f.childId)).sortOrder, childBefore);
    assert.equal((await service.reorder(f.producerId, { kind: 'modules', courseId: f.courseId, parentId: f.moduleId, ids: [f.childId] })).count, 1);
    await assert.rejects(service.reorder(f.producerId, { kind: 'modules', courseId: f.courseId, parentId: f.moduleId, ids: [f.childId, secondRoot] }), { code: 'CONTENT_ORDER_CHANGED' });
    await assert.rejects(service.reorder(f.producerId, { kind: 'modules', courseId: f.courseId, parentId: null, ids: [f.moduleId] }), { code: 'CONTENT_ORDER_CHANGED' });
    await assert.rejects(service.reorder(f.producerId, { kind: 'modules', courseId: f.courseId, parentId: f.secondCourse, ids: [f.childId] }), { code: 'CONTENT_NOT_FOUND' });
    await assert.rejects(service.reorder(f.producerId, { kind: 'modules', courseId: f.courseId, parentId: null, ids: [f.moduleId, f.moduleId] }), { code: 'CONTENT_INVALID_ORDER' });
    await assert.rejects(service.reorder(f.producerId, { kind: 'modules', courseId: f.courseId, moduleId: null, ids: [f.moduleId] }), { code: 'CONTENT_INVALID_ORDER' });
    const otherVideo = id('catalog'); await db.addToCatalog({ videoId: otherVideo, title: 'Other', courseId: f.courseId, producerId: f.producerId, status: 'ready', sourceType: 'local' });
    assert.equal((await service.reorder(f.producerId, { kind: 'videos', courseId: f.courseId, moduleId: f.moduleId, ids: [f.videoId] })).count, 1);
    await assert.rejects(service.reorder(f.producerId, { kind: 'videos', courseId: f.courseId, moduleId: f.moduleId, ids: [f.videoId, otherVideo] }), { code: 'CONTENT_ORDER_CHANGED' });
    assert.equal((await service.reorder(f.producerId, { kind: 'videos', courseId: f.courseId, moduleId: null, ids: [otherVideo] })).count, 1, 'videos without module form their own container');
    await assert.rejects(service.reorder(randomUUID(), { kind: 'videos', courseId: f.courseId, moduleId: f.moduleId, ids: [f.videoId] }), { code: 'CONTENT_PRODUCER_UNAVAILABLE' });
});
test('moving a Bunny class between modules marks the provider collection as pending and clears it once synced', async () => {
    const f = await fixture();
    const bunnyVideo = id('catalog'); await db.addToCatalog({ videoId: bunnyVideo, title: 'Bunny', courseId: f.courseId, producerId: f.producerId, status: 'ready', sourceType: 'bunny', bunnyUrl: 'https://vz-test.b-cdn.net/x/playlist.m3u8' });
    const synced = [];
    const withSync = createProducerContent({ db, generatePublicCode: id => id.replaceAll('-', ''), syncCollection: async input => { synced.push(input); if (input.moduleId === f.childId) throw new Error('proveedor caido'); } });
    const moved = await withSync.updateVideo(f.producerId, bunnyVideo, { moduleId: f.moduleId });
    assert.equal(moved.moduleId, f.moduleId); assert.equal(moved.collectionSyncPending, false); assert.equal(moved.providerWarning, null);
    assert.deepEqual(synced.at(-1), { producerId: f.producerId, videoId: bunnyVideo, courseId: f.courseId, moduleId: f.moduleId });
    assert.equal((await db.getPendingCollectionSyncs(50)).some(p => p.videoId === bunnyVideo), false, 'nothing pending after a successful sync');
    const failed = await withSync.updateVideo(f.producerId, bunnyVideo, { moduleId: f.childId });
    assert.equal(failed.moduleId, f.childId, 'the Edulock move is kept even if the provider fails'); assert.equal(failed.collectionSyncPending, true); assert.match(failed.providerWarning, /reintentar/);
    assert.equal((await db.getPendingCollectionSyncs(50)).some(p => p.videoId === bunnyVideo), false, 'courses without a Bunny library are not reconciled');
    await db.setCourseBunnyLibrary(f.courseId, { libraryId: '999', libraryKey: 'k', pullZone: 'vz-test.b-cdn.net', tokenKey: null });
    assert.equal((await db.getPendingCollectionSyncs(50)).some(p => p.videoId === bunnyVideo && p.moduleId === f.childId), true);
    await db.setCollectionSyncPending(bunnyVideo, false);
    const renamed = await withSync.updateVideo(f.producerId, bunnyVideo, { title: 'Renamed' });
    assert.equal(renamed.providerWarning, undefined, 'a title change never touches the provider'); assert.equal(synced.length, 2);
    const local = await service.updateVideo(f.producerId, f.videoId, { moduleId: f.childId });
    assert.equal(local.collectionSyncPending, false, 'local videos have no provider collection');
});
test('upload advisory lock prevents removal or metadata changes while provider work is running', async () => {
    const f = await fixture(), operationId = id('stream_operations');
    await query("INSERT INTO stream_operations(id,actor_key,course_id,title,file_size,file_sha256,video_id,state,created_at,updated_at) VALUES($1,$2,$3,'Video',1000,$4,$5,'ready',$6,$6)", [operationId, 'producer:' + f.producerId, f.courseId, '0'.repeat(64), f.videoId, new Date().toISOString()]);
    await db.withStreamLock('upload:' + operationId, async () => {
        await assert.rejects(service.updateVideo(f.producerId, f.videoId, { title: 'Busy change' }), { code: 'CONTENT_UPLOAD_BUSY' });
        await assert.rejects(service.remove(f.producerId, 'video', f.videoId), { code: 'CONTENT_UPLOAD_BUSY' });
    });
    assert.equal((await db.getCatalogById(f.videoId)).title, 'Video');
    await service.remove(f.producerId, 'video', f.videoId);
    assert.equal((await db.getStreamOperation(operationId)).state, 'deleted');
});
test('creation rechecks the course after a concurrent deletion releases the producer lock', async () => {
    for (const kind of ['module', 'video']) {
        const f = await fixture(), entityId = id(kind === 'module' ? 'modules' : 'catalog');
        const holder = await db.pool.connect();
        let result;
        try {
            await holder.query('BEGIN'); await holder.query('SELECT id FROM producers WHERE id=$1 FOR UPDATE', [f.producerId]);
            const acquired = new Promise(resolve => db.pool.once('acquire', client => resolve(client.processID)));
            result = (kind === 'module' ? db.createModule({ id: entityId, courseId: f.secondCourse, producerId: f.producerId, name: 'Concurrent module' }) : db.addToCatalog({ videoId: entityId, courseId: f.secondCourse, producerId: f.producerId, title: 'Concurrent video', status: 'ready' })).then(value => ({ value }), error => ({ error }));
            const pid = await acquired;
            let blocked = false;
            for (let attempt = 0; attempt < 100; attempt++) {
                await holder.query('SELECT pg_stat_clear_snapshot()');
                const row = (await holder.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
                if (row?.wait_event_type === 'Lock') { blocked = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(blocked, true, 'Creation must wait on the producer before the course is removed');
            await holder.query('DELETE FROM courses WHERE id=$1 AND producer_id=$2', [f.secondCourse, f.producerId]);
            await holder.query('COMMIT');
            const outcome = await result; assert.equal(outcome.error?.code, 'COURSE_NOT_FOUND');
            assert.equal(kind === 'module' ? await db.getModuleById(entityId) : await db.getCatalogById(entityId), null);
        } finally { try { await holder.query('ROLLBACK'); } catch {} holder.release(); if (result) await result; }
    }
});
function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
test('when a class is moved again while the provider is still syncing the first move, the stale sync leaves the class pending instead of clearing it', async () => {
    const f = await fixture();
    const bunnyVideo = id('catalog'); await db.addToCatalog({ videoId: bunnyVideo, title: 'Bunny race', courseId: f.courseId, producerId: f.producerId, status: 'ready', sourceType: 'bunny', bunnyUrl: 'https://vz-test.b-cdn.net/x/playlist.m3u8' });
    let releaseFirst; const firstStarted = new Promise(resolve => { releaseFirst = resolve; });
    let gate = null; const synced = [];
    const withSync = createProducerContent({ db, generatePublicCode: id => id.replaceAll('-', ''), syncCollection: async input => { synced.push(input.moduleId); if (gate) { const wait = gate; gate = null; releaseFirst(); await wait; } } });
    let unblock; gate = new Promise(resolve => { unblock = resolve; });
    const slowMove = withSync.updateVideo(f.producerId, bunnyVideo, { moduleId: f.moduleId });   // first move: provider answer delayed
    await firstStarted;
    const fastMove = await withSync.updateVideo(f.producerId, bunnyVideo, { moduleId: f.childId }); // second move finishes first
    assert.equal(fastMove.moduleId, f.childId); assert.equal(fastMove.collectionSyncPending, false);
    unblock(); const stale = await slowMove;
    assert.equal(stale.collectionSyncPending, true, 'the stale sync must not close the synchronisation');
    assert.match(stale.providerWarning, /volvió a moverse/);
    assert.equal((await db.getCatalogById(bunnyVideo)).moduleId, f.childId, 'the newest move wins in Edulock');
    await db.setCourseBunnyLibrary(f.courseId, { libraryId: '999', libraryKey: 'k', pullZone: 'vz-test.b-cdn.net', tokenKey: null });
    const pending = (await db.getPendingCollectionSyncs(50)).find(p => p.videoId === bunnyVideo);
    assert.equal(pending?.moduleId, f.childId, 'the reconciliation will place the class in its current module');
    assert.deepEqual(synced, [f.moduleId, f.childId]);
});
test('when the post-sync check cannot be run, the class stays pending instead of being treated as confirmed', async () => {
    const f = await fixture();
    const bunnyVideo = id('catalog'); await db.addToCatalog({ videoId: bunnyVideo, title: 'Bunny blind', courseId: f.courseId, producerId: f.producerId, status: 'ready', sourceType: 'bunny', bunnyUrl: 'https://vz-test.b-cdn.net/x/playlist.m3u8' });
    const blindDb = { ...db, getCatalogById: async () => { throw new Error('base de datos no disponible'); } };
    const service2 = createProducerContent({ db: blindDb, generatePublicCode: id => id.replaceAll('-', ''), syncCollection: async () => {} });
    const moved = await service2.updateVideo(f.producerId, bunnyVideo, { moduleId: f.moduleId });
    assert.equal(moved.moduleId, f.moduleId);
    assert.equal(moved.collectionSyncPending, true, 'not being able to check is never a confirmation');
    assert.match(moved.providerWarning, /no se pudo confirmar/);
    assert.equal((await db.pool.query('SELECT collection_sync_pending FROM catalog WHERE video_id=$1', [bunnyVideo])).rows[0].collection_sync_pending, true, 'the flag stays on in the database');
});
