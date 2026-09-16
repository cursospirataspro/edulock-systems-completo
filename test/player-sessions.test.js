'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayerSessions } = require('../lib/player-sessions');

function fixture() {
    const state = { rows: [{ session_id: 'session-a', user_id: 'student-a', video_id: 'video-a', device_id: 'device-a', last_seen: 100000 }], calls: [], authorized: [], updated: [], ended: [], released: false, denied: false };
    let snapshot;
    const query = async (sql, args) => {
        state.calls.push(sql);
        if (sql === 'BEGIN') snapshot = structuredClone(state.rows);
        if (sql === 'ROLLBACK') state.rows = snapshot;
        if (sql.startsWith('DELETE') && sql.includes('last_seen')) state.rows = state.rows.filter(r => r.user_id !== args[0] || r.last_seen >= args[1]);
        if (sql.startsWith('DELETE') && sql.includes('device_id')) state.rows = state.rows.filter(r => r.user_id !== args[0] || r.device_id !== args[1]);
        if (sql.includes('COUNT(*)')) return { rows: [{ n: state.rows.filter(r => r.user_id === args[0] && r.last_seen >= args[1]).length }] };
        if (sql.startsWith('INSERT')) state.rows.push({ session_id: args[0], user_id: args[1], video_id: args[2], device_id: args[3], last_seen: args[4] });
        if (sql.startsWith('SELECT *')) return { rows: state.rows.filter(r => r.session_id === args[0]) };
        return { rows: [] };
    };
    const db = { pool: { connect: async () => ({ query, release: () => { state.released = true; } }), query },
        heartbeatSession: async (...args) => { state.updated.push(args); return true; },
        endSession: async id => { state.ended.push(id); state.rows = state.rows.filter(r => r.session_id !== id); } };
    const claims = { sub: 'student-a', videoId: 'video-a', sessionId: 'session-a', deviceId: 'device-a' };
    const jwt = { verify: token => { if (token !== 'valid') throw new Error('expired'); return claims; } };
    const accessPolicy = { authorizeSession: async (...args) => { state.authorized.push(args); if (state.denied) throw Object.assign(new Error('revoked'), { code: 'LICENSE_REQUIRED', status: 403 }); } };
    return { state, claims, service: createPlayerSessions({ db, jwt, jwtSecret: 'unit-only', accessPolicy, now: () => 100000 }),
        req: { body: { sessionId: 'session-a', mediaToken: 'valid', deviceId: 'device-a', currentTime: 12 }, headers: {} } };
}
test('new media atomically replaces the same device and leaves other users intact', async () => {
    const f = fixture(); f.state.rows.push({ session_id: 'other-user', user_id: 'student-b', device_id: 'device-a', last_seen: 100000 });
    await f.service.create({ sessionId: 'session-new', userId: 'student-a', videoId: 'video-b', deviceId: 'device-a', maxConcurrent: 1 });
    assert.deepEqual(f.state.rows.map(r => r.session_id), ['other-user', 'session-new']);
    assert.equal(f.state.calls[0], 'BEGIN'); assert.ok(f.state.calls[1].includes('pg_advisory_xact_lock'));
    assert.equal(f.state.calls.at(-1), 'COMMIT'); assert.equal(f.state.released, true);
});
test('concurrent device limit rolls back without disturbing existing playback', async () => {
    const f = fixture();
    await assert.rejects(f.service.create({ sessionId: 'session-new', userId: 'student-a', videoId: 'video-b', deviceId: 'device-b', maxConcurrent: 1 }), { code: 'SESSION_LIMIT_EXCEEDED', status: 429 });
    assert.deepEqual(f.state.rows.map(r => r.session_id), ['session-a']); assert.equal(f.state.calls.at(-1), 'ROLLBACK'); assert.equal(f.state.released, true);
});
test('expired records stop consuming slots and admin explicitly has no count limit', async () => {
    const f = fixture(); f.state.rows[0].last_seen = 1;
    await f.service.create({ sessionId: 'session-new', userId: 'student-a', videoId: 'video-b', deviceId: 'device-b', maxConcurrent: 1 });
    assert.deepEqual(f.state.rows.map(r => r.session_id), ['session-new']);
    f.state.calls = [];
    await f.service.create({ sessionId: 'admin-new', userId: 'student-a', videoId: 'video-c', deviceId: 'device-c', maxConcurrent: null });
    assert.equal(f.state.calls.some(sql => sql.includes('COUNT(*)')), false);
});
test('heartbeat checks current access before updating any record', async () => {
    const f = fixture(); f.state.denied = true;
    await assert.rejects(f.service.heartbeat(f.req), { code: 'LICENSE_REQUIRED' }); assert.equal(f.state.updated.length, 0);
    f.state.denied = false; assert.deepEqual(await f.service.heartbeat(f.req), { ok: true }); assert.deepEqual(f.state.updated, [['session-a', 12]]);
});
test('expired media, swapped session and wrong device never update or close playback', async () => {
    for (const [key, value, code] of [['mediaToken', 'bad', 'TOKEN_EXPIRED'], ['sessionId', 'other', 'SESSION_MISMATCH'], ['deviceId', 'other', 'DEVICE_MISMATCH']]) {
        const f = fixture(); f.req.body[key] = value;
        await assert.rejects(f.service.heartbeat(f.req), { code }); await assert.rejects(f.service.end(f.req), { code });
        assert.equal(f.state.updated.length + f.state.ended.length, 0);
    }
});
test('closing own session works after license revocation and is idempotent', async () => {
    const f = fixture(); f.state.denied = true;
    assert.deepEqual(await f.service.end(f.req), { ok: true }); assert.deepEqual(await f.service.end(f.req), { ok: true });
    assert.deepEqual(f.state.ended, ['session-a']); assert.equal(f.state.authorized.length, 0);
});
test('out-of-range progress cannot overflow the PostgreSQL integer position', async () => {
    const f = fixture(); f.req.body.currentTime = 2147483648;
    await assert.rejects(f.service.heartbeat(f.req), { code: 'INVALID_POSITION', status: 400 });
    assert.equal(f.state.updated.length, 0);
});
test('identity token can close only its own matching device record', async () => {
    const f = fixture(); delete f.claims.sessionId; delete f.claims.videoId;
    f.state.rows[0].user_id = 'student-b';
    await assert.rejects(f.service.end(f.req), { code: 'SESSION_MISMATCH' });
    f.state.rows[0].user_id = 'student-a'; f.state.rows[0].device_id = 'device-b';
    await assert.rejects(f.service.end(f.req), { code: 'DEVICE_MISMATCH' });
});
