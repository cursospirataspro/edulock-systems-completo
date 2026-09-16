'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const database = fs.readFileSync(path.join(__dirname, '..', 'database-pg.js'), 'utf8').replace(/\r\n/g, '\n');
const pid = '11111111-1111-4111-8111-111111111111';
const lid = '22222222-2222-4222-8222-222222222222';
const lotId = '33333333-3333-4333-8333-333333333333';
function sourceFunction(source, name) {
    const start = source.search(new RegExp('(?:async )?function ' + name + '\\('));
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness() {
    const routes = new Map(), calls = [];
    const state = { active: 1, serials: 0, producer: { id: pid, email: 'synthetic@example.invalid', active: 1, max_licenses: 0, max_devices: 2 } };
    const db = {
        getProducerById: async () => ({ ...state.producer, active: state.active }),
        createProducerLotAtomic: async input => { calls.push(['lot', input]); return { ok: true }; },
        getLotsByProducer: async id => { calls.push(['lots', id]); return []; },
        getProducerLicenseItems: async input => { calls.push(['list', input]); return { total: 1, rows: [{
            id: lid, lot_id: lotId, course_id: 'own-course', course_name: 'Course', status: 'free', max_devices: 2,
            expires_at: '2020-01-01T00:00:00Z', activation_count: '1', active_activations: '0',
            license_key_hash: 'NEVER-RETURN-HASH', activation_token_hash: 'NEVER-RETURN-TOKEN'
        }] }; },
        revokeProducerLicense: async input => { calls.push(['revoke', input]); if (state.revokeError) throw state.revokeError; return { licenseId: input.licenseId, status: 'revoked', alreadyRevoked: false }; },
        getProducerByEmail: async () => null,
        createProducer: async input => calls.push(['create', input]),
        updateProducer: async (id, fields) => calls.push(['update', id, fields])
    };
    const app = Object.fromEntries(['get', 'post', 'put'].map(method => [method, (url, ...handlers) => routes.set(method + ' ' + url, handlers)]));
    const context = vm.createContext({ app, db, dbReady: true, console, JWT_SECRET: 'synthetic',
        verifyToken: req => req.auth === undefined ? { role: 'producer', producerId: pid } : req.auth,
        requireAdmin: (_req, _res, next) => next(),
        ownedStreamCourse: async (id, actor) => {
            calls.push(['course', id, actor]);
            if (id !== 'own-course') throw Object.assign(new Error('Course unavailable'), { statusCode: 403 });
        },
        genLicenseKey: () => { state.serials++; return { key: 'synthetic-key-' + state.serials, hash: 'synthetic-hash-' + state.serials }; },
        uuidv4: () => lotId, crypto: { randomBytes: () => Buffer.from('synthetic') },
        hashPassword: () => 'synthetic-password-hash', getPublicBase: () => 'https://example.invalid'
    });
    for (const name of ['dbError', 'normalizeProducerQuotas', 'normalizeProducerLicenseExpiry']) vm.runInContext(sourceFunction(database, name), context);
    db.normalizeProducerQuotas = context.normalizeProducerQuotas;
    db.normalizeProducerLicenseExpiry = context.normalizeProducerLicenseExpiry;
    for (const name of ['requireProducer', 'streamError']) vm.runInContext(sourceFunction(server, name), context);
    for (const [method, url] of [
        ['post', '/api/producer/license/generate-bulk'], ['get', '/api/producer/licenses/items'],
        ['post', '/api/producer/licenses/:licenseId/revoke'], ['post', '/api/owner/producers'], ['put', '/api/owner/producers/:id']
    ]) {
        const start = server.indexOf(`app.${method}('${url}',`);
        assert.ok(start >= 0, url);
        vm.runInContext(server.slice(start, server.indexOf('\n});', start) + 4), context);
    }
    async function run(method, url, overrides = {}) {
        const req = { body: {}, query: {}, params: { id: pid, licenseId: lid }, ...overrides };
        const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; } };
        const handlers = routes.get(method + ' ' + url);
        for (let i = 0; i < handlers.length; i++) {
            let continued = false;
            await handlers[i](req, res, () => { continued = true; });
            if (i < handlers.length - 1 && !continued) break;
        }
        return res;
    }
    return { state, calls, run };
}

test('producer batch accepts future expiry and never trusts owner scope in its body', async () => {
    const h = harness(), expiresAt = new Date(Date.now() + 86400000).toISOString();
    const res = await h.run('post', '/api/producer/license/generate-bulk', { body: { courseId: 'own-course', quantity: 2, expiresAt, producerId: 'another' } });
    assert.equal(res.statusCode, 200); assert.equal(res.body.expiresAt, expiresAt);
    const input = h.calls.find(c => c[0] === 'lot')[1];
    assert.equal(input.producerId, pid); assert.equal(input.lot.expiresAt, expiresAt);
    assert.equal(res.body.keys.length, 2);
});

test('invalid expiry, fractional quantity and device overflow cannot create producer serials', async () => {
    for (const invalid of [{ expiresAt: '2020-01-01T00:00:00Z' }, { expiresAt: '2099-02-30T00:00:00Z' },
        { quantity: 1.5 }, { quantity: '2oops' }, { quantity: null }, { maxDevices: 0 }, { maxDevices: 3 }]) {
        const h = harness();
        const res = await h.run('post', '/api/producer/license/generate-bulk', { body: { courseId: 'own-course', quantity: 1, ...invalid } });
        assert.ok([400, 403].includes(res.statusCode));
        assert.equal(h.state.serials, 0);
        assert.equal(h.calls.some(c => c[0] === 'lot'), false);
    }
});

test('producer listing is paginated, uses the authenticated owner, and excludes credential fields', async () => {
    const h = harness();
    const res = await h.run('get', '/api/producer/licenses/items', { query: { page: '2', lotId, producerId: 'another' } });
    assert.equal(res.statusCode, 200); assert.equal(res.body.page, 2);
    assert.equal(res.body.licenses[0].effectiveStatus, 'expired');
    const input = h.calls.find(c => c[0] === 'list')[1];
    assert.equal(input.producerId, pid); assert.equal(input.offset, 50); assert.equal(input.lotId, lotId);
    assert.doesNotMatch(JSON.stringify(res.body), /hash|NEVER-RETURN/);
    for (const page of ['0', '-1', '1.5', '1000000000000', ['1', '2']]) {
        assert.equal((await h.run('get', '/api/producer/licenses/items', { query: { page } })).statusCode, 400);
    }
});

test('producer revocation uses authenticated ownership and reports missing foreign licenses', async () => {
    const h = harness();
    const res = await h.run('post', '/api/producer/licenses/:licenseId/revoke', { body: { producerId: 'another', licenseId: 'another-license' } });
    assert.equal(res.statusCode, 200); assert.equal(res.body.ok, true);
    const input = h.calls.find(c => c[0] === 'revoke')[1];
    assert.equal(input.producerId, pid); assert.equal(input.licenseId, lid);
    h.state.revokeError = Object.assign(new Error('Licencia no encontrada.'), { statusCode: 404, code: 'LICENSE_NOT_FOUND' });
    assert.equal((await h.run('post', '/api/producer/licenses/:licenseId/revoke')).statusCode, 404);
});

test('new producer controls reject another role and a suspended producer before accessing licenses', async () => {
    for (const [method, route] of [['get', '/api/producer/licenses/items'], ['post', '/api/producer/licenses/:licenseId/revoke']]) {
        const h = harness();
        assert.equal((await h.run(method, route, { auth: { sub: 'student' } })).statusCode, 403);
        h.state.active = 0;
        assert.equal((await h.run(method, route)).statusCode, 403);
        assert.equal(h.calls.length, 0);
    }
});

test('owner producer routes preserve zero and reject invalid quotas instead of coercing them', async () => {
    const h = harness();
    assert.equal((await h.run('post', '/api/owner/producers', { body: { email: 'synthetic@example.invalid', maxLicenses: 0 } })).statusCode, 200);
    assert.equal(h.calls.find(c => c[0] === 'create')[1].maxLicenses, 0);
    assert.equal((await h.run('put', '/api/owner/producers/:id', { body: { maxLicenses: 0, maxStudents: 0 } })).statusCode, 200);
    assert.equal(h.calls.find(c => c[0] === 'update')[2].max_licenses, 0);
    const count = h.calls.length;
    for (const value of [null, '', false, -1, 1.5, '12oops', 2147483648]) {
        assert.equal((await h.run('post', '/api/owner/producers', { body: { email: 'synthetic@example.invalid', maxLicenses: value } })).statusCode, 400);
        assert.equal((await h.run('put', '/api/owner/producers/:id', { body: { maxDevices: value } })).statusCode, 400);
    }
    assert.equal(h.calls.length, count);
});
