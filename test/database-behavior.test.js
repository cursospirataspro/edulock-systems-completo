'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Deliberately inject a fake pg module and an empty environment. This suite
// cannot load .env, contact PostgreSQL or use any application credentials.
function loadDb(handler) {
    const calls = []; let releases = 0;
    const query = async (sql, params = []) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        calls.push({ sql: normalized, params: [...params] });
        return { rows: await handler(normalized, params) || [] };
    };
    class Pool { on() {} query(...args) { return query(...args); } async connect() { return { query, release() { releases++; } }; } }
    const exports = {};
    const context = vm.createContext({ module: { exports }, exports, console: { log() {}, error() {} }, process: { env: {} },
        require(name) { if (name === 'pg') return { Pool }; if (name === 'uuid') return { v4: crypto.randomUUID }; if (name === 'crypto' || name === 'node:crypto') return crypto; if (name === './lib/producer-licenses') return require('../lib/producer-licenses'); throw new Error(`Unexpected dependency ${name}`); } });
    new vm.Script(fs.readFileSync(path.join(__dirname, '../database-pg.js'), 'utf8'), { filename: 'database-pg.js' }).runInContext(context);
    return { db: context.module.exports, calls, releases: () => releases };
}

test('missing and malformed permission data fails closed; an explicit wildcard stays explicit', async () => {
    for (const raw of [undefined, null, '', '{broken', 'null', 'true', '{}', '"*"']) {
        const { db } = loadDb(() => [{ id: 'student', active: 1, allowed_videos: raw }]);
        assert.equal(JSON.stringify((await db.findStudentById('student')).allowedVideos), '[]');
    }
    for (const raw of ['*', '["*"]']) {
        const { db } = loadDb(() => [{ id: 'student', active: 1, allowed_videos: raw }]);
        assert.equal(JSON.stringify((await db.findStudentById('student')).allowedVideos), '["*"]');
    }
});

test('updating a catalog status does not overwrite a key or omitted metadata', async () => {
    const { db, calls } = loadDb(() => [{ video_id: 'video', key_id: 'kept-key', status: 'ready' }]);
    const video = await db.updateCatalogEntry({ videoId: 'video', status: 'ready' });
    assert.equal(video.keyId, 'kept-key');
    assert.equal(calls[0].sql.includes('key_id='), false);
    assert.equal(calls[0].sql.includes('segment_count='), false);
    assert.deepEqual(calls[0].params, ['ready', 'video']);
    await db.updateCatalogEntry({ videoId: 'video', keyId: null, error: null });
    assert.ok(calls[1].sql.includes('key_id=$1')); assert.equal(calls[1].params[0], null);
});

test('course creation retains producer ownership and cannot reuse an id from another producer', async () => {
    const { db, calls } = loadDb(sql => sql.includes('FROM producers') ? [{ id: 'producer-one', active: 1 }] : sql.startsWith('SELECT') ? [{ id: 'course', producer_id: 'producer-one' }] : []);
    assert.equal((await db.createCourse({ id: 'course', name: 'Course', producerId: 'producer-one' })).producerId, 'producer-one');
    assert.equal(calls.find(call => call.sql.startsWith('INSERT INTO courses')).params[5], 'producer-one');
    await assert.rejects(db.createCourse({ id: 'course', name: 'Course', producerId: 'producer-two' }), { code: 'COURSE_OWNER_CONFLICT' });
});

test('module parent and video assignment must belong to the same course', async () => {
    const { db, calls } = loadDb(sql => {
        if (sql.includes('FROM producers')) return [{ id: 'producer-one', active: 1 }];
        if (sql.includes('FROM courses')) return [{ id: 'course', producer_id: 'producer-one' }];
        if (sql.includes('FROM modules')) return [{ id: 'module', course_id: 'another-course' }];
        if (sql.includes('FROM catalog')) return [{ video_id: 'video', course_id: 'course' }];
    });
    await assert.rejects(db.createModule({ id: 'new', courseId: 'course', parentId: 'module', name: 'New', producerId: 'producer-one' }), { code: 'INVALID_PARENT_MODULE' });
    await assert.rejects(db.moveVideoToModule('video', 'module'), { code: 'MODULE_COURSE_MISMATCH' });
    assert.equal(calls.some(c => c.sql.startsWith('INSERT') || c.sql.startsWith('UPDATE')), false);
});

test('commercial claim refuses missing scope and rejects a course of another tenant', async () => {
    const { db, calls } = loadDb(sql => {
        if (sql.includes('FROM students')) return [{ id: 'student', email: 'synthetic@example.invalid', active: 1, approval_status: 'approved' }];
        if (sql.includes('FROM courses')) return [{ id: 'course', producer_id: 'producer-one' }];
    });
    await assert.rejects(db.claimFreeLicense({ studentId: 'student' }), { code: 'CLAIM_FIELDS_REQUIRED' });
    assert.equal(calls.length, 0);
    await assert.rejects(db.claimFreeLicense({ courseId: 'course', studentId: 'student', orderId: 'order' }), { code: 'COURSE_FORBIDDEN' });
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
    assert.equal(calls.some(c => c.sql.includes("status='free'")), false);
});

test('a repeated commercial order returns its same license and cannot move it to another student', async () => {
    const license = { id: 'license-one', course_id: 'course', student_id: 'student', status: 'active' };
    const { db, calls } = loadDb(sql => {
        if (sql.includes('FROM students')) return [{ id: 'student', active: 1, approval_status: 'approved' }];
        if (sql.includes('FROM courses')) return [{ id: 'course', producer_id: null }];
        if (sql.includes('FROM licenses')) return [license];
    });
    const input = { courseId: 'course', studentId: 'student', orderId: 'order' };
    assert.equal((await db.claimFreeLicense(input)).id, 'license-one');
    assert.equal((await db.claimFreeLicense(input)).id, 'license-one');
    assert.equal(calls.some(c => c.sql.startsWith('UPDATE licenses')), false);
    await assert.rejects(db.claimFreeLicense({ ...input, studentId: 'other' }), { code: 'ORDER_CONFLICT' });
});

function activationDb({ license = {}, existing = null, activeCount = 0, device = { status: 'active' }, student = {} } = {}) {
    const lic = { id: 'license', license_key_hash: 'synthetic-hash', status: 'free', student_id: null,
        course_id: 'course', producer_id: null, max_devices: 1, ...license };
    const st = { id: 'student', email: 'synthetic@example.invalid', active: 1, approval_status: 'approved', allowed_videos: '[]', max_devices: 2, ...student };
    return loadDb((sql, params) => {
        if (sql.includes('FROM licenses')) return [lic];
        if (sql.includes('FROM students')) return [st];
        if (sql.includes('FROM courses')) return [{ id: 'course', producer_id: null }];
        if (sql.includes('COUNT(*) AS n FROM activations')) return [{ n: activeCount }];
        if (sql.includes('COUNT(*) AS n FROM devices')) return [{ n: 0 }];
        if (sql.includes('FROM activations')) return existing ? [existing] : [];
        if (sql.includes('FROM devices')) return device ? [device] : [];
        if (sql.startsWith('UPDATE licenses')) return [{ ...lic, student_id: params[0], status: 'active' }];
    });
}
const activationInput = { licenseKeyHash: 'synthetic-hash', studentId: 'student', deviceId: 'synthetic-device', activationTokenHash: 'synthetic-token-hash', maxAllowed: 2 };

test('free serial is assigned, grants its course, and activates in one transaction', async () => {
    const { db, calls, releases } = activationDb();
    const result = await db.claimAndActivateLicenseAtomic(activationInput);
    assert.equal(result.ok, true); assert.equal(result.license.student_id, 'student'); assert.equal(result.maxDevices, 1);
    assert.ok(calls.some(c => c.sql.startsWith('INSERT INTO student_courses')));
    assert.ok(calls.some(c => c.sql.startsWith('UPDATE students SET allowed_videos') && c.params[0] === '["course"]'));
    assert.ok(calls.some(c => c.sql.startsWith('INSERT INTO activations')));
    assert.equal(calls.at(-1).sql, 'COMMIT'); assert.equal(releases(), 1);
});

test('reactivating an old revoked device still consumes quota', async () => {
    const { db, calls } = activationDb({ license: { status: 'active', student_id: 'student' }, existing: { id: 'activation', status: 'revoked' }, activeCount: 1 });
    const result = await db.claimAndActivateLicenseAtomic(activationInput);
    assert.equal(result.ok, false); assert.equal(result.reason, 'device_limit_exceeded');
    assert.equal(calls.some(c => c.sql.startsWith('UPDATE licenses')), false);
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('a blocked device cannot consume or bind a free serial', async () => {
    const { db, calls } = activationDb({ device: { status: 'blocked' } });
    const result = await db.claimAndActivateLicenseAtomic(activationInput);
    assert.equal(result.reason, 'device_blocked');
    assert.equal(calls.some(c => c.sql.startsWith('UPDATE licenses') || c.sql.startsWith('INSERT INTO student_courses')), false);
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('active license owner is checked again inside the transaction, and legacy expiry values no longer block a permanent license', async () => {
    const { db, calls } = activationDb({ license: { status: 'active', student_id: 'other' } });
    assert.equal((await db.claimAndActivateLicenseAtomic(activationInput)).ok, false);
    assert.equal(calls.some(c => c.sql.startsWith('INSERT INTO activations')), false);
    for (const license of [{ expires_at: '2020-01-01T00:00:00.000Z' }, { expires_at: 'invalid-date' }, { duration_days: 3 }]) {
        const permanent = activationDb({ license });
        const result = await permanent.db.claimAndActivateLicenseAtomic(activationInput);
        assert.equal(result.ok, true); assert.equal(result.expiresAt, null, 'the activation token carries no course validity');
        assert.equal(permanent.calls.some(c => c.sql.startsWith('UPDATE licenses SET first_activated_at=$1,expires_at')), false);
    }
});

test('producer lot honors current database quota rather than caller-supplied quota', async () => {
    const { db, calls } = loadDb(sql => {
        if (sql.includes('FROM producers')) return [{ id: 'producer', active: 1, max_licenses: 2, max_devices: 1 }];
        if (sql.includes('FROM courses')) return [{ producer_id: 'producer' }];
        if (sql.includes('COUNT(*)')) return [{ n: 2 }];
    });
    const result = await db.createProducerLotAtomic({ producerId: 'producer', maxLicenses: 999,
        lot: { id: 'lot', courseId: 'course', maxDevices: 1 }, licenses: [{ id: 'new', hash: 'synthetic' }] });
    assert.equal(result.ok, false); assert.equal(result.limit, 2);
    assert.equal(calls.some(c => c.sql.startsWith('INSERT INTO license_lots')), false);
});

test('producer creation preserves unlimited quotas and applies defaults only to omitted values', async () => {
    const { db, calls } = loadDb(() => []);
    await db.createProducer({ id: 'unlimited', email: 'unlimited@example.invalid', maxLicenses: 0, maxStudents: '0', maxDevices: '1' });
    assert.deepEqual(calls[0].params.slice(4, 7), [0, 1, 0]);
    await db.createProducer({ id: 'default', email: 'default@example.invalid' });
    assert.deepEqual(calls[1].params.slice(4, 7), [100, 2, 0]);
    await db.createProducer({ id: 'finite', email: 'finite@example.invalid', maxLicenses: '23', maxDevices: 3, maxStudents: 11 });
    assert.deepEqual(calls[2].params.slice(4, 7), [23, 3, 11]);
});

test('invalid producer quotas are rejected before writes, including updates', async () => {
    const { db, calls } = loadDb(() => []);
    for (const value of [null, '', ' ', true, false, -1, 1.5, '2extra', '1e2', NaN, Infinity, 2147483648]) {
        for (const field of ['maxLicenses', 'maxDevices', 'maxStudents']) {
            await assert.rejects(db.createProducer({ id: 'invalid', email: 'invalid@example.invalid', [field]: value }),
                { code: 'INVALID_PRODUCER_QUOTA', statusCode: 400 });
        }
        await assert.rejects(db.updateProducer('invalid', { max_licenses: value }), { code: 'INVALID_PRODUCER_QUOTA', statusCode: 400 });
    }
    await assert.rejects(db.createProducer({ id: 'invalid', email: 'invalid@example.invalid', maxDevices: 0 }), { code: 'INVALID_PRODUCER_QUOTA' });
    assert.equal(calls.length, 0);
});

test('updating a quota to zero preserves unlimited and never replaces omitted quotas', async () => {
    const { db, calls } = loadDb(() => []);
    await db.updateProducer('producer', { name: 'New name', max_licenses: '0', max_devices: undefined });
    assert.deepEqual(calls[0].params, ['New name', 0, 'producer']);
    assert.equal(calls[0].sql.includes('max_devices'), false);
    assert.equal(calls[0].sql.includes('max_students'), false);
});

test('an unlimited producer can generate another lot after having used licenses', async () => {
    const { db, calls } = loadDb(sql => {
        if (sql.includes('FROM producers')) return [{ id: 'producer', active: 1, max_licenses: 0, max_devices: 1 }];
        if (sql.includes('FROM courses')) return [{ producer_id: 'producer' }];
        if (sql.includes('COUNT(*)')) return [{ n: 150 }];
    });
    const result = await db.createProducerLotAtomic({ producerId: 'producer', maxLicenses: 1,
        lot: { id: 'lot', courseId: 'course', maxDevices: 1 }, licenses: [{ id: 'new', hash: 'synthetic' }] });
    assert.equal(result.ok, true);
    assert.ok(calls.some(c => c.sql.startsWith('INSERT INTO licenses')));
    assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('malformed stored producer quota cannot become unlimited when creating a lot', async () => {
    for (const limit of [-1, null, undefined, 'bad']) {
        const { db, calls } = loadDb(sql => {
            if (sql.includes('FROM producers')) return [{ id: 'producer', active: 1, max_licenses: limit, max_devices: 1 }];
            if (sql.includes('FROM courses')) return [{ producer_id: 'producer' }];
        });
        await assert.rejects(db.createProducerLotAtomic({ producerId: 'producer',
            lot: { id: 'lot', courseId: 'course', maxDevices: 1 }, licenses: [{ id: 'new', hash: 'synthetic' }] }),
            { code: 'INVALID_PRODUCER_QUOTA' });
        assert.equal(calls.some(c => c.sql.startsWith('INSERT')), false);
        assert.equal(calls.at(-1).sql, 'ROLLBACK');
    }
});

test('producer lot inserts every serial as a permanent license (expires_at NULL literal, no duration column update)', async () => {
    const { db, calls } = loadDb(sql => {
        if (sql.includes('FROM producers')) return [{ id: 'producer', active: 1, max_licenses: 0, max_devices: 1 }];
        if (sql.includes('FROM courses')) return [{ producer_id: 'producer' }];
        if (sql.includes('COUNT(*)')) return [{ n: 0 }];
    });
    assert.equal((await db.createProducerLotAtomic({ producerId: 'producer',
        lot: { id: 'lot', courseId: 'course', maxDevices: 1 },
        licenses: [{ id: 'first', hash: 'one' }, { id: 'second', hash: 'two' }] })).ok, true);
    const inserts = calls.filter(c => c.sql.startsWith('INSERT INTO licenses'));
    assert.equal(inserts.length, 2);
    assert.ok(inserts.every(c => /expires_at\)\s+VALUES \([^)]*NULL\)/.test(c.sql) && c.params.length === 7));
    assert.equal(calls.some(c => c.sql.includes('duration_days')), false);
});

test('any expiry or duration on a producer batch is refused before touching the database', async () => {
    const { db, calls } = loadDb(() => []);
    for (const lot of [{ expiresAt: new Date(Date.now() + 86400000).toISOString() }, { expiresAt: 'invalid' }, { expiresAt: '2020-01-01T00:00:00Z' }, { durationDays: 30 }, { durationDays: '5' }]) {
        await assert.rejects(db.createProducerLotAtomic({ producerId: 'producer',
            lot: { courseId: 'course', maxDevices: 1, ...lot }, licenses: [{ id: 'new', hash: 'synthetic' }] }),
            { code: 'LICENSE_EXPIRY_UNSUPPORTED', statusCode: 400 });
    }
    assert.equal(calls.length, 0);
});

test('producer license listing binds producer and lot while selecting no credential columns', async () => {
    const { db, calls } = loadDb(sql => sql.startsWith('SELECT COUNT') ? [{ n: '1' }] : [{ id: 'mine' }]);
    const result = await db.getProducerLicenseItems({ producerId: 'producer', lotId: 'own-lot', limit: 50, offset: 50 });
    assert.equal(result.total, 1); assert.equal(result.rows[0].id, 'mine');
    assert.deepEqual(calls[0].params, ['producer', 'own-lot']);
    assert.deepEqual(calls[1].params.slice(0, 4), ['producer', 'own-lot', 50, 50]);
    assert.match(calls[1].sql, /WHERE l\.producer_id=\$1/);
    assert.doesNotMatch(calls[1].sql, /license_key_hash|activation_token_hash|l\.\*/);
    await assert.rejects(db.getProducerLicenseItems({ producerId: 'producer', limit: 101 }), { code: 'INVALID_PAGINATION' });
});

function producerRevocationDb({ found = true, status = 'active', active = 1, auditFails = false } = {}) {
    return loadDb(sql => {
        if (sql.includes('FROM licenses')) return found ? [{ id: 'license', status, student_id: 'student', course_id: 'course' }] : [];
        if (sql.includes('FROM producers')) return [{ id: 'producer', active, email: 'synthetic@example.invalid' }];
        if (auditFails && sql.startsWith('INSERT INTO suspicious_activity')) throw new Error('audit failed');
    });
}

test('producer revocation updates only its license and activations, with an audit in the same transaction', async () => {
    const { db, calls } = producerRevocationDb();
    const result = await db.revokeProducerLicense({ producerId: 'producer', licenseId: 'license' });
    assert.equal(result.alreadyRevoked, false);
    const lookup = calls.find(c => c.sql.includes('FROM licenses'));
    assert.match(lookup.sql, /WHERE id=\$1 AND producer_id=\$2 FOR UPDATE/);
    assert.deepEqual(lookup.params, ['license', 'producer']);
    const updates = calls.filter(c => c.sql.startsWith('UPDATE'));
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0].params.slice(1), ['producer:producer', 'license', 'producer']);
    assert.equal(updates[1].params.at(-1), 'license');
    assert.equal(calls.some(c => /(?:UPDATE devices|DELETE FROM)/.test(c.sql)), false);
    const audit = calls.find(c => c.sql.startsWith('INSERT INTO suspicious_activity'));
    assert.equal(JSON.parse(audit.params[2]).licenseId, 'license');
    assert.equal(JSON.parse(audit.params[2]).producerId, 'producer');
    assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('foreign or missing licenses and suspended producers cannot be revoked', async () => {
    for (const options of [{ found: false }, { active: 0 }]) {
        const { db, calls } = producerRevocationDb(options);
        await assert.rejects(db.revokeProducerLicense({ producerId: 'producer', licenseId: 'license' }),
            { code: options.found === false ? 'LICENSE_NOT_FOUND' : 'PRODUCER_INACTIVE' });
        assert.equal(calls.some(c => c.sql.startsWith('UPDATE') || c.sql.startsWith('INSERT')), false);
        assert.equal(calls.at(-1).sql, 'ROLLBACK');
    }
});

test('repeated revocation is idempotent, and failed audit rolls back instead of claiming success', async () => {
    const already = producerRevocationDb({ status: 'revoked' });
    assert.equal((await already.db.revokeProducerLicense({ producerId: 'producer', licenseId: 'license' })).alreadyRevoked, true);
    assert.equal(already.calls.some(c => c.sql.startsWith('UPDATE') || c.sql.startsWith('INSERT')), false);
    const failed = producerRevocationDb({ auditFails: true });
    await assert.rejects(failed.db.revokeProducerLicense({ producerId: 'producer', licenseId: 'license' }), /audit failed/);
    assert.equal(failed.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(failed.calls.some(c => c.sql === 'COMMIT'), false);
});

test('advisory lock contention releases its connection and never runs a second provision callback', async () => {
    const { db, releases } = loadDb(() => [{ locked: false }]); let called = false;
    await assert.rejects(db.withStreamLock('course', () => { called = true; }), { code: 'STREAM_BUSY' });
    assert.equal(called, false); assert.equal(releases(), 1);
});

test('registration retries return the persisted request id and reject another verified identity', async () => {
    const { db, calls } = loadDb(sql => sql.includes('FROM registration_requests')
        ? [{ id: 'persisted-id', email: 'synthetic@example.invalid', firebase_uid: 'verified-uid' }] : []);
    const input = { email: ' Synthetic@Example.invalid ', deviceId: 'device-one', firebaseUid: 'verified-uid' };
    assert.equal(await db.createRegistrationRequest(input), 'persisted-id');
    assert.equal(calls.some(c => c.sql.startsWith('INSERT')), false);
    assert.ok(calls.some(c => c.sql.includes('pg_advisory_xact_lock')));
    await assert.rejects(db.createRegistrationRequest({ ...input, firebaseUid: 'another-uid' }), { code: 'REGISTRATION_DEVICE_OWNER_CONFLICT' });
    await assert.rejects(db.createRegistrationRequest({ ...input, email: 'other@example.invalid' }), { code: 'REGISTRATION_DEVICE_OWNER_CONFLICT' });
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('public link lookup returns the stored code and reports missing videos', async () => {
    const { db, calls } = loadDb(() => [{ public_code: 'already-shared' }]);
    assert.equal(await db.getOrCreatePublicCode('video', 'different-proposal'), 'already-shared');
    assert.match(calls[0].sql, /COALESCE\(NULLIF\(public_code,''\),\$2\)/);
    assert.deepEqual(calls[0].params, ['video', 'different-proposal']);
    const absent = loadDb(() => []).db;
    await assert.rejects(absent.getOrCreatePublicCode('missing', 'proposal'), { code: 'VIDEO_NOT_FOUND', statusCode: 404 });
});
