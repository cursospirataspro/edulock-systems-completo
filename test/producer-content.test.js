'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePatch, validateSettings, httpsUrl, embedOrigins, documentsPresent, courseDto, videoDto, mountProducerContent, createProducerContent } = require('../lib/producer-content');

test('content patches reject ownership, storage, protection and provider credential fields', () => {
    for (const kind of ['course', 'module', 'video']) {
        for (const key of ['producerId', 'producer_id', 'bunnyUrl', 'libraryKey', 'documents', 'protection', '__proto__']) {
            const value = Object.create(null); value[key] = 'untrusted';
            assert.throws(() => validatePatch(kind, value), { code: 'CONTENT_UNKNOWN_FIELD' });
        }
    }
});
test('invalid titles, fractional ordering, oversized fields and nonboolean publication fail validation', () => {
    for (const patch of [{ name: '' }, { name: ' '.repeat(4) }, { name: 'x'.repeat(121) }, { sortOrder: '2' }, { sortOrder: 1.5 }, { sortOrder: -1 }, { sortOrder: 1000001 }]) assert.throws(() => validatePatch('course', patch));
    assert.throws(() => validatePatch('module', { playlistPublished: 'false' }));
    assert.throws(() => validatePatch('video', { title: 'a\u0000b' }));
    assert.throws(() => validatePatch('video', []));
    assert.throws(() => validatePatch('video', {}));
    assert.throws(() => validatePatch('video', { courseId: 'a/b' }));
    assert.deepEqual(validatePatch('module', { parentId: null, sortOrder: 0, playlistPublished: false }), { parentId: null, sortOrder: 0, playlistPublished: false });
});
test('presentation URLs exclude active schemes, cleartext and embedded credentials', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'http://example.invalid/image', 'https://user:password@example.invalid', '//example.invalid', 'https://example.invalid/\nimage']) assert.throws(() => httpsUrl(url), { code: 'CONTENT_INVALID_URL' });
    assert.equal(httpsUrl(''), null);
    assert.equal(httpsUrl('https://example.invalid/cover.png'), 'https://example.invalid/cover.png');
    assert.throws(() => validateSettings({ theme: 'red; background:url(x)' }, true));
    assert.throws(() => validateSettings({ description: 'x'.repeat(2001) }, true));
    assert.deepEqual(validateSettings({ coverUrl: null, theme: 'light', description: ' Texto ' }, true), { coverUrl: null, theme: 'light', description: 'Texto' });
});
test('embedding requires exact HTTPS public domain origins, deduplicated with an explicit limit', () => {
    for (const value of ['https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://example.local', 'https://user:secret@example.com', 'https://example.com/page', 'https://example.com/?q=1', "https://example.com;script-src *"]) assert.throws(() => embedOrigins([value]));
    assert.throws(() => embedOrigins(Array(11).fill('https://example.com')));
    assert.throws(() => embedOrigins('https://example.com'));
    assert.deepEqual(embedOrigins(['https://example.com/', 'https://example.com', 'https://learn.example.com']), ['https://example.com', 'https://learn.example.com']);
    assert.deepEqual(validateSettings({ embedOrigins: [] }), { embedOrigins: [] });
});
test('safe DTOs never expose provider tokens, encrypted locations or legacy private links', () => {
    const secrets = { bunny_url: 'https://private.invalid/token', bunny_library_key: 'SECRET', key_id: 'KEY', documents: '[{"url":"secret"}]', producer_id: 'OTHER' };
    const course = courseDto({ id: 'course', name: 'Course', settings: { description: 'hi', unknown: 'SECRET' }, ...secrets });
    const video = videoDto({ video_id: 'video', title: 'Video', settings: { theme: 'dark' }, ...secrets });
    assert.equal(JSON.stringify([course, video]).includes('SECRET'), false);
    assert.equal(JSON.stringify([course, video]).includes('private.invalid'), false);
    assert.equal(JSON.stringify([course, video]).includes('producer_id'), false);
});
test('legacy resource presence blocks deletion even when malformed', () => {
    for (const value of ['[{}]', '{"url":"file"}', 'not-json']) assert.equal(documentsPresent(value), true);
    for (const value of [null, '', '[]']) assert.equal(documentsPresent(value), false);
});

function routeHarness(serviceOverrides = {}) {
    const routes = new Map(), calls = [];
    const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (path, ...handlers) => routes.set(method + ' ' + path, handlers)]));
    const service = Object.fromEntries(['projects', 'updateCourse', 'updateModule', 'updateVideo', 'remove', 'storage', 'reorder'].map(name => [name, async (...args) => { calls.push({ name, args }); return { ok: true }; }]));
    Object.assign(service, serviceOverrides);
    const auth = (req, res, next) => { if (!req.allowed) return res.status(403).json({ error: 'Denied' }); req.producer = { id: 'authorized-producer' }; next(); };
    mountProducerContent(app, { requireProducer: auth, service });
    async function run(method, path, extra = {}) {
        const req = { allowed: true, params: { id: 'owned-id', code: 'synthetic-code' }, query: {}, body: {}, ...extra };
        const headers = {};
        const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; }, set(key, value) { headers[key] = value; return this; }, type(value) { headers['Content-Type'] = value; return this; } };
        for (const handler of routes.get(method + ' ' + path)) {
            let next = false; await handler(req, res, () => { next = true; }); if (!next) break;
        }
        return { ...res, headers };
    }
    return { run, calls };
}
test('all workspace routes require authentication and take owner exclusively from middleware', async () => {
    const h = routeHarness();
    const paths = [['get', 'projects'], ['get', 'storage'], ['post', 'reorder'], ...['courses', 'modules', 'videos'].flatMap(kind => [['patch', kind + '/:id'], ['delete', kind + '/:id']])];
    for (const [method, path] of paths) {
        const full = '/api/producer/workspace/' + path;
        const denied = await h.run(method, full, { allowed: false });
        assert.equal(denied.statusCode, 403); assert.equal(h.calls.length, 0);
        const allowed = await h.run(method, full, { body: { producerId: 'attacker' }, query: { producerId: 'attacker' } });
        assert.equal(allowed.statusCode, 200); assert.equal(h.calls.pop().args[0], 'authorized-producer');
        assert.equal(allowed.headers['Cache-Control'], 'no-store, private');
    }
});
test('database internals are redacted; known dependency errors remain actionable', async () => {
    const h = routeHarness({ projects: async () => { throw new Error('password=SECRET postgresql://root'); }, remove: async () => { throw Object.assign(new Error('Associated data remains'), { code: 'CONTENT_HAS_DEPENDENCIES', statusCode: 409, dependencies: { licenses: 2 } }); } });
    const res = await h.run('get', '/api/producer/workspace/projects');
    assert.equal(res.statusCode, 503); assert.equal(JSON.stringify(res.body).includes('SECRET'), false);
    const conflict = await h.run('delete', '/api/producer/workspace/courses/:id');
    assert.equal(conflict.statusCode, 409); assert.deepEqual(conflict.body.dependencies, { licenses: 2 });
});
test('public playlist escapes producer text and links, requires no customer data or browser script', async () => {
    const h = routeHarness({ playlist: async () => ({ name: '<script>alert(1)</script>', courseName: 'A&B', videos: [{ title: '"<img onerror=x>', url: '/cover/safe', coverUrl: 'https://example.invalid/" onerror="x', description: '</p><script>x</script>' }] }) });
    const res = await h.run('get', '/playlist/:code', { allowed: false });
    assert.equal(res.statusCode, 200); assert.equal(res.body.includes('<script>'), false);
    assert.match(res.body, /&lt;script&gt;/); assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'self'/);
});

function transactionHarness(rows) {
    const statements = [];
    const client = { async query(sql, params) { statements.push({ sql, params });
        if (sql.includes('SELECT id,active FROM producers')) return { rows: [{ id: 'producer-a', active: 1 }] };
        if (/SELECT \* FROM/.test(sql)) return { rows: rows(sql, params) };
        return { rows: [] };
    }, release() { statements.push({ sql: 'RELEASE' }); } };
    return { service: createProducerContent({ db: { pool: { query: client.query, connect: async () => client } } }), statements };
}
test('foreign content mutation rolls back with 404 without touching metadata or data', async () => {
    const h = transactionHarness(() => []);
    for (const method of ['updateCourse', 'updateModule', 'updateVideo']) await assert.rejects(h.service[method]('producer-a', 'foreign-id', method === 'updateVideo' ? { title: 'New' } : { name: 'New' }), { code: 'CONTENT_NOT_FOUND', statusCode: 404 });
    assert.equal(h.statements.filter(s => s.sql === 'ROLLBACK').length, 3);
    assert.equal(h.statements.some(s => /^(UPDATE|INSERT|DELETE)/.test(s.sql)), false);
    for (const statement of h.statements.filter(s => /SELECT \* FROM/.test(s.sql))) assert.equal(statement.params[1], 'producer-a');
});
test('cross-owner video destinations fail before any write', async () => {
    const h = transactionHarness((sql, params) => sql.includes('FROM catalog') ? [{ video_id: 'own-video', producer_id: 'producer-a', course_id: null, source_type: 'local' }] : []);
    await assert.rejects(h.service.updateVideo('producer-a', 'own-video', { courseId: 'foreign-course' }), { code: 'CONTENT_NOT_FOUND' });
    assert.equal(h.statements.some(s => /^(UPDATE|INSERT|DELETE)/.test(s.sql)), false);
});
test('Bunny course moves cannot silently switch the library used for playback', async () => {
    const h = transactionHarness((sql, params) => sql.includes('FROM catalog') ? [{ video_id: 'own-video', course_id: 'course-a', source_type: 'bunny' }] : [{ id: params[0], bunny_library_id: params[0] === 'course-a' ? '111' : '222' }]);
    await assert.rejects(h.service.updateVideo('producer-a', 'own-video', { courseId: 'course-b' }), { code: 'CONTENT_LIBRARY_MISMATCH' });
    assert.equal(h.statements.some(s => /^(UPDATE|INSERT|DELETE)/.test(s.sql)), false);
});
test('a deleted durable upload cannot recreate a removed video or contact the provider', async t => {
    const { createStreamService } = require('../lib/stream-service');
    const { randomUUID } = require('node:crypto');
    const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
    const filePath = path.join(os.tmpdir(), 'edulock-deleted-upload-' + randomUUID() + '.bin');
    await fs.writeFile(filePath, 'synthetic file'); t.after(() => fs.unlink(filePath));
    const courseId = randomUUID(), operationId = randomUUID(); let providerCalls = 0;
    const operation = { id: operationId, state: 'deleted', error_code: 'CONTENT_DELETED', course_id: courseId, actor_key: 'producer:producer-one' };
    const db = {
        getCourseById: async () => ({ id: courseId, producerId: 'producer-one' }),
        getProducerById: async () => ({ active: 1 }),
        withStreamLock: async (_key, work) => work(),
        reserveStreamOperation: async () => operation,
        getStreamOperation: async () => operation
    };
    const service = createStreamService({ db, transport: { json: async () => { providerCalls++; }, putFile: async () => { providerCalls++; } }, getAccountKey: async () => 'unused', createKey: async () => 'unused' });
    await assert.rejects(service.uploadVideo({ filePath, title: 'Video', courseId, operationId, actor: { producerId: 'producer-one' } }), { code: 'OPERATION_DELETED', statusCode: 409 });
    const status = await service.getOperationStatus({ operationId, actor: { producerId: 'producer-one' } });
    assert.equal(status.failed, true); assert.equal(status.retryable, false); assert.equal(status.phase, 'deleted'); assert.equal(providerCalls, 0);
});
