'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createIntegrationRateLimit } = require('../lib/integration-rate-limit');
const { isAccountToken } = require('../lib/token-scope');
const { resourceError } = require('../lib/resource-routes');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').replace(/\r\n/g, '\n');
function sourceFunction(name) {
    const start = server.search(new RegExp('(?:async )?function ' + name + '\\('));
    assert.ok(start >= 0, name);
    return server.slice(start, server.indexOf('\n}', start) + 2);
}
function response() {
    return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, setHeader(key, value) { this.headers[key] = value; }, json(body) { this.body = body; return this; } };
}
function limitCall(limiter, key, ip = '192.0.2.1') {
    const res = response(); let accepted = false;
    limiter({ integration: key === null ? undefined : { id: key }, ip }, res, () => { accepted = true; });
    return { ...res, accepted };
}

test('sales traffic accepts more than ten successful orders without sharing the login budget', () => {
    const limiter = createIntegrationRateLimit();
    for (let count = 0; count < 120; count++) assert.equal(limitCall(limiter, 'shop-a').accepted, true);
    const limited = limitCall(limiter, 'shop-a');
    assert.equal(limited.statusCode, 429); assert.equal(limited.body.code, 'INTEGRATION_RATE_LIMITED');
    assert.ok(Number(limited.headers['Retry-After']) > 0);
});
test('one producer cannot exhaust another integration key behind the same source IP', () => {
    const limiter = createIntegrationRateLimit({ max: 2 });
    assert.equal(limitCall(limiter, 'shop-a').accepted, true);
    assert.equal(limitCall(limiter, 'shop-a').accepted, true);
    assert.equal(limitCall(limiter, 'shop-a').statusCode, 429);
    assert.equal(limitCall(limiter, 'shop-b').accepted, true);
    assert.equal(limitCall(limiter, 'shop-b').accepted, true);
    assert.equal(limitCall(limiter, 'shop-b').statusCode, 429);
});
test('changing source IP does not bypass the budget of an authenticated integration key', () => {
    const limiter = createIntegrationRateLimit({ max: 1 });
    assert.equal(limitCall(limiter, 'shop-a', '192.0.2.1').accepted, true);
    assert.equal(limitCall(limiter, 'shop-a', '192.0.2.2').statusCode, 429);
});
test('retry window restores access and expired buckets release bounded memory capacity', () => {
    let time = 100000;
    const limiter = createIntegrationRateLimit({ max: 1, windowMs: 1000, maxKeys: 1, now: () => time });
    assert.equal(limitCall(limiter, 'shop-a').accepted, true);
    assert.equal(limitCall(limiter, 'shop-b').statusCode, 503);
    assert.equal(limitCall(limiter, 'shop-a').statusCode, 429);
    time += 1000;
    assert.equal(limitCall(limiter, 'shop-b').accepted, true);
    time += 1000;
    assert.equal(limitCall(limiter, 'shop-b').accepted, true);
});
test('unauthenticated requests cannot allocate key budgets or rely on an IP fallback', () => {
    const limiter = createIntegrationRateLimit({ max: 1, maxKeys: 1 });
    for (let i = 0; i < 50; i++) assert.equal(limitCall(limiter, null).statusCode, 401);
    assert.equal(limitCall(limiter, 'valid-key').accepted, true);
    assert.throws(() => createIntegrationRateLimit({ max: NaN }));
    assert.throws(() => createIntegrationRateLimit({ windowMs: 0 }));
});

async function resourceRequest(claims, storedVersion, manager = true) {
    const context = vm.createContext({ dbReady: true, verifyToken: () => claims, isAccountToken, resourceError,
        db: { getProducerById: async () => ({ active: 1, auth_version: storedVersion }) },
        accessPolicy: { hydrate: async value => value } });
    vm.runInContext(sourceFunction('requireResourceAccount') + '\n' + sourceFunction('requireResourceManager'), context);
    const req = {}, res = response(); let accepted = false;
    await new Promise((resolve, reject) => {
        const json = res.json.bind(res); res.json = body => { json(body); resolve(); return res; };
        try {
            const result = context[manager ? 'requireResourceManager' : 'requireResourceAccount'](req, res, () => { accepted = true; resolve(); });
            result?.catch?.(reject);
        } catch (error) { reject(error); }
    });
    return { ...res, accepted };
}
test('password reset revokes old producer sessions on both PDF management and reading', async () => {
    const old = { sub: 'producer-a', producerId: 'producer-a', role: 'producer', authVersion: 0 };
    for (const manager of [true, false]) {
        const result = await resourceRequest(old, 1, manager);
        assert.equal(result.accepted, false); assert.equal(result.statusCode, 401); assert.equal(result.body.code, 'RESOURCE_SESSION_REVOKED'); assert.equal(result.body.revoked, true);
    }
    assert.equal((await resourceRequest({ ...old, authVersion: 1 }, 1)).accepted, true);
});
test('legacy producer sessions work only until the first recorded session revocation', async () => {
    const legacy = { sub: 'producer-a', producerId: 'producer-a', role: 'producer' };
    assert.equal((await resourceRequest(legacy, 0)).accepted, true);
    assert.equal((await resourceRequest(legacy, undefined)).accepted, true);
    assert.equal((await resourceRequest(legacy, 2)).statusCode, 401);
});

function claimHarness(license) {
    const calls = { claims: [], serialReads: 0 }, routes = new Map();
    const auth = (req, res, next) => {
        if (!req.allowed) return res.status(401).json({ error: 'Invalid integration key' });
        req.integration = { id: 'shop-a', producer_id: 'producer-a' }; next();
    };
    const limiter = createIntegrationRateLimit({ max: 120 });
    const context = vm.createContext({
        app: { post: (url, ...handlers) => routes.set(url, handlers) }, requireIntegrationKey: auth, integrationRateLimit: limiter,
        db: { findStudentByEmail: async () => ({ id: 'student-a' }), claimFreeLicense: async input => { calls.claims.push(input); return license; } },
        producerLicenseWorkspace: { readLicenseSerial: async () => { calls.serialReads++; return 'SYNTHETIC-RECOVERABLE-KEY'; } },
        console: { error() {} }, streamError: (res, error) => res.status(error.statusCode || 503).json({ code: error.code || 'UNAVAILABLE' })
    });
    const start = server.indexOf("app.post('/api/integrations/claim-license',");
    vm.runInContext(server.slice(start, server.indexOf('\n});', start) + 4), context);
    async function run(extra = {}) {
        const req = { allowed: true, ip: '192.0.2.1', body: { courseId: 'course-a', customerEmail: 'synthetic@example.invalid', orderId: 'order-a' }, ...extra };
        const res = response();
        for (const handler of routes.get('/api/integrations/claim-license')) {
            let next = false; await handler(req, res, () => { next = true; }); if (!next) break;
        }
        return res;
    }
    return { run, calls, handlers: routes.get('/api/integrations/claim-license'), auth, limiter };
}
test('claim route authenticates before its integration limiter and leaves login routes unchanged', async () => {
    const h = claimHarness({ id: 'license-a', course_id: 'course-a', status: 'active', expires_at: null });
    assert.equal(h.handlers[0], h.auth); assert.equal(h.handlers[1], h.limiter);
    for (let index = 0; index < 130; index++) assert.equal((await h.run({ allowed: false })).statusCode, 401);
    for (let index = 0; index < 11; index++) assert.equal((await h.run()).statusCode, 200);
    assert.equal(h.calls.claims.length, 11);
    assert.match(server, /app\.post\('\/api\/producer\/login', authRateLimit,/);
    assert.match(server, /app\.post\('\/api\/auth\/admin-login', authRateLimit,/);
});
test('repeated expired orders never disclose a serial or falsely return an active license', async () => {
    for (const license of [
        { status: 'active', expires_at: '2000-01-01T00:00:00Z' },
        { status: 'active', expires_at: 'not-a-date' },
        { status: 'expired', expires_at: null },
        { status: 'free', expires_at: '2000-01-01T00:00:00Z' }
    ]) {
        const h = claimHarness({ id: 'old-license', course_id: 'course-a', ...license });
        const result = await h.run();
        assert.equal(result.statusCode, 409); assert.equal(result.body.code, 'LICENSE_EXPIRED'); assert.equal(result.body.status, 'expired');
        assert.equal(result.body.licenseId, 'old-license'); assert.equal(h.calls.serialReads, 0); assert.equal(h.calls.claims.length, 1);
        assert.equal(result.headers['Cache-Control'], 'no-store');
    }
});
test('valid repeated orders preserve their license ID and return serials only for active access', async () => {
    const h = claimHarness({ id: 'same-license', course_id: 'course-a', status: 'active', expires_at: '2199-01-01T00:00:00Z' });
    const first = await h.run(), second = await h.run();
    assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200); assert.equal(first.body.licenseId, second.body.licenseId); assert.ok(first.body.licenseKey);
    for (const status of ['suspended', 'revoked', 'free']) {
        const blocked = claimHarness({ id: 'license-a', status, expires_at: null });
        assert.equal((await blocked.run()).body.code, 'LICENSE_NOT_ACTIVE'); assert.equal(blocked.calls.serialReads, 0);
    }
});
test('admin regeneration passes its generated plaintext only to the atomic vault-writing helper', async () => {
    const routes = new Map(); let captured;
    const context = vm.createContext({ app: { post: (url, ...handlers) => routes.set(url, handlers) }, requireAdmin: () => {}, crypto, uuidv4: () => 'new-license', process: { env: { JWT_SECRET: 'synthetic-test-secret-'.repeat(3) } }, console: { error() {} },
        db: { regenerateLicense: async input => { captured = input; return { ok: true, newLicenseId: input.newLicenseId, durationDays: 30, firstActivatedAt: null, studentId: null }; }, findStudentById: async () => null, logSuspiciousActivity: async () => {} } });
    const start = server.indexOf("app.post('/api/admin/licenses/:licenseId/regenerate',");
    vm.runInContext(server.slice(start, server.indexOf('\n});', start) + 4), context);
    const res = response();
    await routes.get('/api/admin/licenses/:licenseId/regenerate').at(-1)({ params: { licenseId: 'old-license' }, user: { sub: 'synthetic-admin' } }, res);
    assert.equal(res.statusCode, 200); assert.ok(captured.newLicenseKey);
    assert.equal(crypto.createHmac('sha256', 'synthetic-test-secret-'.repeat(3)).update(captured.newLicenseKey).digest('hex'), captured.newLicenseKeyHash);
    assert.equal(res.body.durationDays, 30); assert.equal(res.body.firstActivatedAt, null);
});
