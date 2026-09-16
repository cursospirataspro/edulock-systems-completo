'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isAccountToken } = require('../lib/token-scope');
const { resourceError } = require('../lib/resource-routes');

// Exercise the exact middleware installed in server.js without starting the
// application, loading credentials, connecting PostgreSQL or signing JWTs.
// The verification seam supplies claims equivalent to already verified tokens.
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('function requireAdmin(');
const end = source.indexOf('// Content permissions', start);
assert.ok(start >= 0 && end > start, 'Resource middleware must remain available for its wiring regression test.');
const middleware = source.slice(start, end);
async function invoke(name, claims, options = {}) {
    const calls = { producerReads: 0, hydrations: 0 };
    const context = {
        dbReady: options.dbReady !== false,
        verifyToken: () => claims,
        isAccountToken,
        resourceError,
        db: { getProducerById: async () => { calls.producerReads++; return options.producerMissing ? null : { active: options.producerActive === undefined ? 1 : options.producerActive }; } },
        accessPolicy: { hydrate: async value => { calls.hydrations++; if (options.hydrateError) throw Object.assign(new Error('La cuenta no está activa.'), { status: 403, code: 'ACCOUNT_REVOKED' }); return { ...value, allowedVideos: ['synthetic-course'] }; } }
    };
    vm.createContext(context); vm.runInContext(middleware, context);
    return new Promise((resolve, reject) => {
        const req = {}, outcome = { accepted: false, status: null, body: null, calls };
        const res = { status(code) { outcome.status = code; return this; }, json(body) { outcome.body = body; resolve(outcome); return this; } };
        try {
            const pending = context[name](req, res, () => { outcome.accepted = true; outcome.user = req.user; resolve(outcome); });
            if (pending && typeof pending.catch === 'function') pending.catch(reject);
        } catch (error) { reject(error); }
    });
}

test('fresh admin session can manage resources without being mistaken for a playback capability', async () => {
    const result = await invoke('requireResourceManager', { sub: 'synthetic-admin', admin: true });
    assert.equal(result.accepted, true); assert.equal(result.user.admin, true);
    assert.deepEqual(result.calls, { producerReads: 0, hydrations: 0 });
});
for (const scope of [
    { role: 'media', videoId: 'video-a', sessionId: 'session-a' },
    { role: 'perm', videoId: 'video-a', sessionId: 'session-a' },
    { videoId: 'video-a' }, { sessionId: 'session-a' }, { role: 'media' }, { role: 'perm' },
]) test('admin preview scope cannot manage resources: ' + JSON.stringify(scope), async () => {
    const result = await invoke('requireResourceManager', { sub: 'synthetic-admin', admin: true, allowedVideos: ['*'], ...scope });
    assert.equal(result.accepted, false); assert.equal(result.status, 403); assert.equal(result.body.code, 'RESOURCE_ACCOUNT_TOKEN_REQUIRED');
    assert.deepEqual(result.calls, { producerReads: 0, hydrations: 0 });
});
for (const role of ['media', 'perm']) test('student ' + role + ' JWT cannot open a resource or pass hydration as an account token', async () => {
    const result = await invoke('requireResourceAccount', { sub: 'synthetic-student', role, videoId: 'video-a', sessionId: 'session-a' });
    assert.equal(result.accepted, false); assert.equal(result.status, 403); assert.equal(result.calls.hydrations, 0);
});
test('fresh student account can enter the reader but not the resource management routes', async () => {
    const claims = { sub: 'synthetic-student', deviceId: 'device-a', approved: true };
    const reader = await invoke('requireResourceAccount', claims);
    assert.equal(reader.accepted, true); assert.equal(reader.calls.hydrations, 1);
    const manager = await invoke('requireResourceManager', claims);
    assert.equal(manager.accepted, false); assert.equal(manager.status, 403); assert.equal(manager.calls.hydrations, 1);
});
test('resource manager rechecks that a producer account still exists and remains active', async () => {
    const claims = { sub: 'synthetic-producer', role: 'producer', producerId: 'producer-a' };
    assert.equal((await invoke('requireResourceManager', claims)).accepted, true);
    for (const options of [{ producerActive: 0 }, { producerMissing: true }]) {
        const result = await invoke('requireResourceManager', claims, options);
        assert.equal(result.accepted, false); assert.equal(result.status, 403); assert.equal(result.calls.producerReads, 1);
    }
});
test('guest, missing token and revoked student never reach the resource handler', async () => {
    assert.equal((await invoke('requireResourceAccount', null)).status, 401);
    assert.equal((await invoke('requireResourceAccount', { sub: 'guest', admin: true, guest: true })).status, 403);
    const revoked = await invoke('requireResourceAccount', { sub: 'synthetic-student' }, { hydrateError: true });
    assert.equal(revoked.accepted, false); assert.equal(revoked.status, 403);
});
test('startup failure returns unavailable instead of accepting an admin capability', async () => {
    const result = await invoke('requireResourceManager', { sub: 'synthetic-admin', admin: true }, { dbReady: false });
    assert.equal(result.accepted, false); assert.equal(result.status, 503);
});
test('general admin middleware also rejects scoped preview JWTs before the admin bypass', async () => {
    const admin = { sub: 'synthetic-admin', admin: true };
    assert.equal((await invoke('requireAdmin', admin)).accepted, true);
    for (const scope of [{ role: 'media', videoId: 'video-a', sessionId: 'session-a' }, { role: 'perm' }, { guest: true }]) {
        const result = await invoke('requireAdmin', { ...admin, ...scope });
        assert.equal(result.accepted, false); assert.equal(result.status, 403);
    }
});
