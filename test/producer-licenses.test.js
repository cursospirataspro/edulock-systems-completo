'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createProducerLicenseWorkspace, createSerialVault, ensureSchema, storePreparedSerials,
  activateLicensePolicy, normalizeDurationDays, effectiveStatus, availabilityOf } = require('../lib/producer-licenses');

// Synthetic pools only: these tests never load .env, use real serials, or connect to a service.
const SECRET = 'synthetic-test-secret-with-at-least-32-bytes';
const KEY = 'ABCD-EFGH-JKLM-NPQR';
const now = new Date().toISOString();
const future = new Date(Date.now() + 86400000 * 30).toISOString();
const baseLicense = () => ({ id: 'license-a', producer_id: 'producer-a', course_id: 'course-a', lot_id: 'lot-a',
  student_id: 'student-a', license_key_hash: 'old-hash', status: 'active', max_devices: 2, created_at: now, expires_at: null,
  first_activated_at: now, duration_days: null, assigned_at: now });
function harness({ producer = { id: 'producer-a', active: 1, max_devices: 5 }, license = baseLicense(), handler = () => null, vaultKey = SECRET } = {}) {
  const calls = []; let releases = 0;
  async function query(rawSql, params = []) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    const positions = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
    assert.equal(Math.max(0, ...positions), params.length, `SQL bindings must match: ${sql}`);
    calls.push({ sql, params });
    const result = await handler(sql, params);
    if (result != null) return Array.isArray(result) ? { rows: result } : result;
    if (sql === 'SELECT * FROM producers WHERE id=$1 FOR UPDATE') return { rows: producer ? [producer] : [] };
    if (sql.startsWith('SELECT * FROM licenses WHERE id=$1 AND producer_id=$2 FOR UPDATE')) return { rows: license ? [license] : [] };
    if (sql.includes('COUNT(*) AS n')) return { rows: [{ n: 0 }] };
    return { rows: [] };
  }
  const pool = { query, async connect() { return { query, release() { releases++; } }; } };
  return { service: createProducerLicenseWorkspace({ pool, vaultKey, jwtSecret: SECRET }), pool, calls, releases: () => releases };
}

test('serial vault ciphertext is randomized, authenticated, and bound to tenant and license', () => {
  const vault = createSerialVault(SECRET);
  const first = vault.encrypt(KEY, 'producer-a', 'license-a'), second = vault.encrypt(KEY, 'producer-a', 'license-a');
  assert.notEqual(first, second); assert.equal(first.includes(KEY), false);
  assert.equal(vault.decrypt(first, 'producer-a', 'license-a'), KEY);
  assert.throws(() => vault.decrypt(first, 'producer-b', 'license-a'), { code: 'SERIAL_INTEGRITY_ERROR' });
  assert.throws(() => vault.decrypt(first, 'producer-a', 'license-b'), { code: 'SERIAL_INTEGRITY_ERROR' });
  const parts = first.split(':'); parts[3] = Buffer.from('altered ciphertext').toString('base64url');
  assert.throws(() => vault.decrypt(parts.join(':'), 'producer-a', 'license-a'), { code: 'SERIAL_INTEGRITY_ERROR' });
  assert.throws(() => createSerialVault(SECRET + '-different').decrypt(first, 'producer-a', 'license-a'), { code: 'SERIAL_INTEGRITY_ERROR' });
});

test('vault and serial signing reject a missing or short secret', async () => {
  const vault = createSerialVault('short', { jwtSecret: '' });
  assert.equal(vault.available, false);
  assert.throws(() => vault.encrypt(KEY, 'producer-a', 'license-a'), { code: 'SERIAL_VAULT_UNAVAILABLE' });
  const h = harness({ vaultKey: 'short' });
  await assert.rejects(h.service.exportLot('producer-a', 'lot-a'), { code: 'SERIAL_VAULT_UNAVAILABLE' });
  assert.equal(h.calls.length, 0);
});

test('schema migrations fail closed instead of silently accepting a missing security table', async () => {
  const statements = [];
  await assert.rejects(ensureSchema({ async query(sql) { statements.push(sql); if (sql.includes('producer_license_serials')) throw new Error('synthetic migration failure'); } }), /synthetic migration/);
  assert.equal(statements.some(sql => sql.includes('producer_customer_profiles')), false);
  assert.ok(statements.some(sql => sql.includes('MIN(a.created_at)')));
});

test('generation custody encrypts before persistence, rejects foreign insertion and never stores plaintext', async () => {
  const vault = createSerialVault(SECRET), h = harness({ handler(sql) { return sql.startsWith('INSERT INTO producer_license_serials') ? [{ license_id: 'license-a' }] : null; } });
  await storePreparedSerials(h.pool, { producerId: 'producer-a', licenses: [{ id: 'license-a', key: KEY }], vault });
  assert.equal(JSON.stringify(h.calls).includes(KEY), false);
  const insert = h.calls[0];
  assert.match(insert.sql, /WHERE id=\$1 AND producer_id=\$2/);
  assert.equal(vault.decrypt(insert.params[2], 'producer-a', 'license-a'), KEY);
  const foreign = harness();
  await assert.rejects(storePreparedSerials(foreign.pool, { producerId: 'producer-b', licenses: [{ id: 'license-a', key: KEY }], vault }), { code: 'LICENSE_NOT_FOUND' });
});

test('list licenses binds every filter, escapes LIKE wildcards, hashes full serial, returns the full key and omits vault secrets', async () => {
  const vault = createSerialVault(SECRET), ciphertext = vault.encrypt(KEY, 'producer-a', 'license-a');
  const h = harness({ handler(sql) {
    if (sql.startsWith('SELECT COUNT(*) AS total')) return [{ total: 3, available: 1, reserved: 0, in_use: 2, suspended: 0, revoked: 0 }];
    if (sql.startsWith('SELECT COUNT(*)')) return [{ n: 1 }];
    if (sql.startsWith('SELECT l.id,l.lot_id')) return [{ ...baseLicense(), serial_suffix: 'NPQR', ciphertext, license_key_hash: 'must-not-leak', student_name: 'Alumna QA', student_email: 'alumna@example.invalid' }];
    return null;
  } });
  const response = await h.service.listLicenses('producer-a', { q: KEY, lotId: 'lot-a', courseId: 'course-a', status: 'in_use', page: 2, pageSize: 10 });
  assert.equal(response.total, 1); assert.equal(response.page, 2); assert.equal(response.licenses[0].serialAvailable, true);
  assert.equal(response.licenses[0].serial, KEY); assert.equal(response.licenses[0].availability, 'in_use');
  assert.equal(response.licenses[0].studentName, 'Alumna QA'); assert.equal(Object.hasOwn(response.licenses[0], 'expiresAt'), false);
  assert.deepEqual(response.counts, { total: 3, available: 1, reserved: 0, inUse: 2, suspended: 0, revoked: 0 });
  assert.equal(JSON.stringify(response).includes('must-not-leak'), false);
  assert.ok(h.calls.every(call => call.params[0] === 'producer-a'));
  assert.ok(h.calls.some(c => c.params.includes(crypto.createHmac('sha256', SECRET).update(KEY).digest('hex'))));
  assert.deepEqual(h.calls.at(-1).params.slice(-2), [10, 10]);
  await h.service.listLicenses('producer-a', { q: '10%_sale' });
  assert.ok(h.calls.at(-1).params.includes('%10\\%\\_sale%'));
  // Legacy aliases keep working and the join never depends on students.producer_id.
  await h.service.listLicenses('producer-a', { status: 'free' });
  assert.equal(h.calls.at(-1).sql.includes('s.producer_id'), false);
  assert.match(h.calls.at(-1).sql, /l\.status='free' AND l\.student_id IS NULL/);
});

test('unfiltered license queries have valid PostgreSQL parameter arity', async () => {
  const h = harness();
  assert.deepEqual(await h.service.listLicenses('producer-a'), { licenses: [], total: 0, page: 1, pageSize: 50, counts: { total: 0, available: 0, reserved: 0, inUse: 0, suspended: 0, revoked: 0 } });
});

test('malformed filters and pagination cannot become SQL or unbounded queries', async () => {
  for (const query of [{ page: 0 }, { pageSize: 1000 }, { page: '1 OR TRUE' }, { q: ['abc'] }, { lotId: "' OR TRUE --" }, { status: 'anything' }]) {
    const h = harness();
    await assert.rejects(h.service.listLicenses('producer-a', query), err => err.statusCode === 400);
    assert.equal(h.calls.length, 0);
  }
});

test('course licenses are permanent: legacy expiry values never change the effective status', () => {
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.equal(effectiveStatus({ status: 'active', expires_at: past }), 'active');
  assert.equal(effectiveStatus({ status: 'free', expires_at: past }), 'free');
  assert.equal(effectiveStatus({ status: 'suspended', expires_at: past }), 'suspended');
  assert.equal(effectiveStatus({ status: 'revoked', expires_at: past }), 'revoked');
});

test('availability distinguishes distributable, reserved, in-use, suspended and revoked keys', () => {
  assert.equal(availabilityOf({ status: 'free' }), 'available');
  assert.equal(availabilityOf({ status: 'free', customer_email: 'buyer@example.invalid' }), 'reserved');
  assert.equal(availabilityOf({ status: 'free', reserved_email: 'buyer@example.invalid' }), 'reserved');
  assert.equal(availabilityOf({ status: 'active', student_id: 'student-a' }), 'in_use');
  assert.equal(availabilityOf({ status: 'active', student_id: null, customer_email: 'sold@example.invalid' }), 'in_use', 'a sold key with zero live activations stays in use');
  assert.equal(availabilityOf({ status: 'suspended', student_id: 'student-a' }), 'suspended');
  assert.equal(availabilityOf({ status: 'revoked' }), 'revoked');
});

test('foreign licenses fail before changes and always release the transaction', async () => {
  for (const action of [s => s.updateLicense('producer-a', 'foreign', { customerEmail: 'x@example.invalid' }), s => s.setLicenseStatus('producer-a', 'foreign', 'suspended'), s => s.reissueLicense('producer-a', 'foreign', true)]) {
    const h = harness({ license: null });
    await assert.rejects(action(h.service), { code: 'LICENSE_NOT_FOUND' });
    assert.equal(h.calls.some(c => /^(UPDATE|INSERT|DELETE)/.test(c.sql)), false);
    assert.equal(h.calls.at(-1).sql, 'ROLLBACK'); assert.equal(h.releases(), 1);
    assert.deepEqual(h.calls.find(c => c.sql.includes('FROM licenses')).params, ['foreign', 'producer-a']);
  }
});

test('a suspended producer cannot change an otherwise owned license', async () => {
  const h = harness({ producer: { id: 'producer-a', active: 0 } });
  await assert.rejects(h.service.updateLicense('producer-a', 'license-a', { customerEmail: 'x@example.invalid' }), { code: 'PRODUCER_INACTIVE' });
  assert.equal(h.calls.some(c => c.sql.includes('FROM licenses')), false);
});

test('a producer can only reserve a free key for an email; every other field is refused before any query', async () => {
  for (const [fields, code] of [[{ notes: 'x' }, 'FIELD_NOT_EDITABLE'], [{ buyerName: 'x' }, 'FIELD_NOT_EDITABLE'], [{ producerId: 'producer-b' }, 'FIELD_NOT_EDITABLE'],
    [{ studentId: 'student-b' }, 'FIELD_NOT_EDITABLE'], [{ status: 'active' }, 'FIELD_NOT_EDITABLE'], [{}, 'EMPTY_UPDATE'],
    [{ maxDevices: 1 }, 'DEVICE_LIMIT_ADMIN_ONLY'], [{ expiresAt: future }, 'LICENSE_EXPIRY_UNSUPPORTED'], [{ durationDays: 30 }, 'LICENSE_EXPIRY_UNSUPPORTED']]) {
    const h = harness();
    await assert.rejects(h.service.updateLicense('producer-a', 'license-a', fields), { code });
    assert.equal(h.calls.length, 0, `${code} must be refused without touching the database`);
  }
  const free = harness({ license: { ...baseLicense(), status: 'free', student_id: null, assigned_at: null, first_activated_at: null } });
  const response = await free.service.updateLicense('producer-a', 'license-a', { customerEmail: 'Buyer@Example.invalid' });
  const update = free.calls.find(c => c.sql.startsWith('UPDATE licenses'));
  assert.match(update.sql, /SET customer_email=\$1 WHERE id=\$2 AND producer_id=\$3/);
  assert.deepEqual(update.params, ['buyer@example.invalid', 'license-a', 'producer-a']);
  assert.equal(response.license.customerEmail, 'buyer@example.invalid'); assert.equal(response.license.availability, 'reserved');
  assert.ok(free.calls.some(c => c.sql.startsWith('INSERT INTO producer_workspace_audit')));
  assert.equal(free.calls.at(-1).sql, 'COMMIT');
});

test('device limits are administrator-only for producers, at generation and at edit time', async () => {
  const h = harness({ producer: { id: 'producer-a', active: 1, max_devices: 2 } });
  await assert.rejects(h.service.updateLicense('producer-a', 'license-a', { maxDevices: 3 }), { code: 'DEVICE_LIMIT_ADMIN_ONLY' });
  await assert.rejects(h.service.updateLicense('producer-a', 'license-a', { maxDevices: 1 }), { code: 'DEVICE_LIMIT_ADMIN_ONLY' });
  assert.equal(h.calls.length, 0);
});

test('assigned buyer identity cannot be transferred using contact metadata', async () => {
  const h = harness();
  await assert.rejects(h.service.updateLicense('producer-a', 'license-a', { customerEmail: 'different@example.invalid' }), { code: 'ASSIGNED_BUYER_IMMUTABLE' });
  assert.equal(h.calls.some(c => c.sql.startsWith('UPDATE')), false); assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
});

test('license validity cannot be introduced through the workspace: no expiry, no duration, no activations touched', async () => {
  const h = harness();
  await assert.rejects(h.service.updateLicense('producer-a', 'license-a', { expiresAt: future }), { code: 'LICENSE_EXPIRY_UNSUPPORTED' });
  await assert.rejects(h.service.updateLicense('producer-a', 'license-a', { customerEmail: 'a@example.invalid', durationDays: 5 }), { code: 'LICENSE_EXPIRY_UNSUPPORTED' });
  assert.equal(h.calls.length, 0);
  for (const invalid of [0, -1, 3651, 1.2, '3 days', true]) assert.throws(() => normalizeDurationDays(invalid), { code: 'INVALID_DURATION' });
  assert.equal(normalizeDurationDays('30'), 30);
});

test('license suspension is reversible but revocation remains terminal', async () => {
  const h = harness();
  await h.service.setLicenseStatus('producer-a', 'license-a', 'suspended');
  assert.equal(h.calls.find(c => c.sql.startsWith('UPDATE licenses')).params[0], 'suspended');
  assert.ok(h.calls.some(c => c.sql.startsWith('UPDATE activations')));
  const resume = harness({ license: { ...baseLicense(), status: 'suspended' } });
  assert.equal((await resume.service.setLicenseStatus('producer-a', 'license-a', 'active')).status, 'active');
  const free = harness({ license: { ...baseLicense(), status: 'suspended', student_id: null, assigned_at: null } });
  assert.equal((await free.service.setLicenseStatus('producer-a', 'license-a', 'active')).status, 'free');
  const revoked = harness({ license: { ...baseLicense(), status: 'revoked' } });
  await assert.rejects(revoked.service.setLicenseStatus('producer-a', 'license-a', 'active'), { code: 'LICENSE_REVOKED' });
  await assert.rejects(revoked.service.updateLicense('producer-a', 'license-a', { customerEmail: 'x@example.invalid' }), { code: 'LICENSE_REVOKED' });
  assert.equal((await revoked.service.setLicenseStatus('producer-a', 'license-a', 'revoked')).unchanged, true);
});

test('device actions are scoped to one license; reset does not remove a deliberate block', async () => {
  for (const action of ['block', 'unblock', 'reset']) {
    const h = harness({ handler(sql) {
      if (sql.startsWith('SELECT a.id,a.license_id')) return [{ id: 'activation-a', license_id: 'license-a', student_id: 'student-a' }];
      if (sql.startsWith('SELECT id FROM students')) return [{ id: 'student-a' }];
      if (sql.startsWith('SELECT id,device_id FROM activations')) return [{ id: 'activation-a', device_id: 'device-a' }];
      return null;
    } });
    await h.service.activationAction('producer-a', 'activation-a', action);
    const mutations = h.calls.filter(c => /^(DELETE|UPDATE|INSERT)/.test(c.sql));
    assert.equal(mutations.some(c => /^DELETE FROM devices/.test(c.sql)), false);
    const devices = mutations.find(c => c.sql.startsWith('UPDATE devices'));
    if (action !== 'unblock') {
      assert.match(devices.sql, /d.status='active'/); assert.match(devices.sql, /NOT EXISTS\(SELECT 1 FROM activations/);
      assert.deepEqual(devices.params, ['student-a', 'device-a', 'license-a', 'producer-a']);
      assert.equal(devices.sql.includes('s.producer_id'), false, 'ownership is proven by the license, never by students.producer_id');
    } else assert.equal(devices, undefined);
    assert.equal(mutations.some(c => c.sql.startsWith('INSERT INTO producer_license_device_blocks')), action === 'block');
    assert.equal(mutations.some(c => c.sql.startsWith('DELETE FROM producer_license_device_blocks')), action === 'unblock');
    assert.deepEqual(h.calls.find(c => c.sql.startsWith('DELETE FROM playback_sessions')).params, ['student-a', 'course-a', 'device-a']);
  }
});

test('a foreign activation cannot become a global device operation', async () => {
  const h = harness();
  await assert.rejects(h.service.activationAction('producer-a', 'foreign', 'block'), { code: 'ACTIVATION_NOT_FOUND' });
  assert.equal(h.calls.some(c => /^(UPDATE|INSERT|DELETE)/.test(c.sql)), false);
});

test('first activation is recorded once as history and never starts a validity period', async () => {
  const calls = [], first = '2026-01-01T00:00:00.000Z';
  const client = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  const license = { ...baseLicense(), first_activated_at: null, duration_days: 30 };
  await activateLicensePolicy(client, license, { deviceId: 'device-a', now: first });
  assert.equal(license.expires_at, null); assert.equal(license.first_activated_at, first);
  const update = calls.find(c => c.sql.startsWith('UPDATE licenses'));
  assert.equal(update.sql.includes('expires_at'), false); assert.deepEqual(update.params, [first, 'license-a', 'producer-a']);
  const updates = calls.filter(c => c.sql.startsWith('UPDATE licenses')).length;
  await activateLicensePolicy(client, license, { deviceId: 'device-b', now: '2026-01-10T00:00:00.000Z' });
  assert.equal(calls.filter(c => c.sql.startsWith('UPDATE licenses')).length, updates);
  assert.equal(license.first_activated_at, first);
});

test('blocked device is rejected before first activation date or expiry is changed', async () => {
  const calls = [], license = { ...baseLicense(), first_activated_at: null, duration_days: 30 };
  const client = { async query(sql, params) { calls.push({ sql, params }); return { rows: [{ '?column?': 1 }] }; } };
  await assert.rejects(activateLicensePolicy(client, license, { deviceId: 'device-a' }), { code: 'device_blocked' });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].params, ['license-a', 'producer-a', 'device-a']);
  assert.equal(license.first_activated_at, null);
});

test('lot movement refuses foreign lots and cross-course changes', async () => {
  const absent = harness();
  await assert.rejects(absent.service.moveLot('producer-a', 'lot-a', 'lot-b'), { code: 'LOT_NOT_FOUND' });
  const cross = harness({ handler(sql) { return sql.startsWith('SELECT id,course_id FROM license_lots') ? [{ id: 'lot-a', course_id: 'course-a' }, { id: 'lot-b', course_id: 'course-b' }] : null; } });
  await assert.rejects(cross.service.moveLot('producer-a', 'lot-a', 'lot-b'), { code: 'LOT_COURSE_MISMATCH' });
  assert.equal(cross.calls.some(c => c.sql.startsWith('UPDATE licenses')), false);
});

test('same-course lot movement preserves course, owner and total license quota', async () => {
  const h = harness({ handler(sql) {
    if (sql.startsWith('SELECT id,course_id FROM license_lots')) return [{ id: 'lot-a', course_id: 'course-a' }, { id: 'lot-b', course_id: 'course-a' }];
    if (sql.startsWith('UPDATE licenses SET lot_id=')) return [{ id: 'license-a' }];
    return null;
  } });
  assert.equal((await h.service.moveLot('producer-a', 'lot-a', 'lot-b')).moved, 1);
  const update = h.calls.find(c => c.sql.startsWith('UPDATE licenses'));
  assert.deepEqual(update.params, ['lot-b', 'lot-a', 'producer-a']);
  assert.equal(update.sql.includes('course_id='), false);
  assert.equal(h.calls.some(c => /^(INSERT INTO|DELETE FROM) licenses/.test(c.sql)), false);
});

test('historical serial lookup returns null and mixed export fails with no partial output', async () => {
  const h = harness({ handler(sql) {
    if (sql.startsWith('SELECT id FROM license_lots')) return [{ id: 'lot-a' }];
    if (sql.startsWith('SELECT l.id,l.status')) return [{ id: 'license-a', ciphertext: null }];
    return null;
  } });
  assert.equal(await h.service.readLicenseSerial({ producerId: 'producer-a', licenseId: 'license-a' }), null);
  await assert.rejects(h.service.exportLot('producer-a', 'lot-a'), { code: 'HISTORICAL_SERIALS_UNAVAILABLE' });
  assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(h.calls.some(c => c.sql.startsWith('INSERT INTO producer_workspace_audit')), false);
});

test('CSV exports decrypt the owned lot and escape spreadsheet formula injection', async () => {
  const vault = createSerialVault(SECRET), ciphertext = vault.encrypt(KEY, 'producer-a', 'license-a');
  const h = harness({ handler(sql) {
    if (sql.startsWith('SELECT id FROM license_lots')) return [{ id: 'lot-a' }];
    if (sql.startsWith('SELECT l.id,l.status')) return [{ id: 'license-a', status: 'active', ciphertext, customer_email: '=command@example.invalid', max_devices: 2 }];
    return null;
  } });
  const csv = await h.service.exportLot('producer-a', 'lot-a');
  assert.ok(csv.startsWith('\uFEFFserial,licenseId'));
  assert.ok(csv.includes(KEY)); assert.ok(csv.includes('"\'=command@example.invalid"'));
  assert.equal(JSON.stringify(h.calls.filter(c => c.sql.startsWith('INSERT'))).includes(KEY), false);
  assert.equal(h.calls.at(-1).sql, 'COMMIT');
});

test('serial reads accept an existing transaction client without acquiring another pool connection', async () => {
  const h = harness(), vault = createSerialVault(SECRET); let calls = 0;
  const serial = await h.service.readLicenseSerial({ producerId: 'producer-a', licenseId: 'license-a', client: {
    async query(sql, params) { calls++; assert.deepEqual(params, ['license-a', 'producer-a']); return { rows: [{ ciphertext: vault.encrypt(KEY, 'producer-a', 'license-a') }] }; }
  } });
  assert.equal(serial, KEY); assert.equal(calls, 1); assert.equal(h.calls.length, 0);
});

test('reissue requires explicit confirmation, rotates the existing row, preserves quota and revokes sessions', async () => {
  const h = harness({ handler(sql) { return sql.startsWith('INSERT INTO producer_license_serials') ? [{ license_id: 'license-a' }] : null; } });
  await assert.rejects(h.service.reissueLicense('producer-a', 'license-a', false), { code: 'REISSUE_CONFIRMATION_REQUIRED' });
  assert.equal(h.calls.length, 0);
  const result = await h.service.reissueLicense('producer-a', 'license-a', true);
  assert.match(result.key, /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
  assert.equal(result.licenseId, 'license-a');
  assert.equal(h.calls.some(c => /^(INSERT INTO|DELETE FROM) licenses/.test(c.sql)), false);
  const update = h.calls.find(c => c.sql.startsWith('UPDATE licenses'));
  assert.deepEqual(update.params.slice(-2), ['license-a', 'producer-a']);
  assert.equal(update.params[0], crypto.createHmac('sha256', SECRET).update(result.key).digest('hex'));
  assert.ok(h.calls.some(c => c.sql.startsWith('UPDATE activations')));
  assert.equal(JSON.stringify(h.calls).includes(result.key), false);
});

test('reissue rolls back if encrypted custody cannot be saved and does not revive revoked licenses', async () => {
  const failure = harness();
  await assert.rejects(failure.service.reissueLicense('producer-a', 'license-a', true), { code: 'LICENSE_NOT_FOUND' });
  assert.equal(failure.calls.at(-1).sql, 'ROLLBACK');
  const revoked = harness({ license: { ...baseLicense(), status: 'revoked' } });
  await assert.rejects(revoked.service.reissueLicense('producer-a', 'license-a', true), { code: 'LICENSE_REVOKED' });
  assert.equal(revoked.calls.some(c => c.sql.startsWith('UPDATE licenses')), false);
});

test('student listing is derived from the license→student relation of owned licenses, one row per account', async () => {
  const h = harness({ handler(sql) {
    if (sql.startsWith('SELECT COUNT(*) AS n FROM (WITH owned')) return [{ n: 1 }];
    if (sql.startsWith('WITH owned AS')) return [{ id: 'student-a', name: 'Alumna QA', email: 'client@example.invalid', active: 1, license_count: '2', active_licenses: '1',
      suspended_licenses: '1', revoked_licenses: '0', active_activations: '1', last_activity: now, first_assigned_at: now, course_names: ['Curso A', 'Curso B'] }];
    return null;
  } });
  const result = await h.service.listStudents('producer-a', { q: 'client', courseId: 'course-a', page: 1, pageSize: 20 });
  assert.equal(result.total, 1); assert.equal(result.students[0].licenseCount, 2); assert.deepEqual(result.students[0].courses, ['Curso A', 'Curso B']);
  assert.ok(h.calls.every(c => c.params[0] === 'producer-a'));
  const sql = h.calls.at(-1).sql;
  assert.ok(sql.includes('WHERE l.producer_id=$1 AND l.student_id IS NOT NULL'));
  assert.equal(sql.includes('s.producer_id'), false, 'students.producer_id must not hide buyers of several producers');
  assert.equal(JSON.stringify(result).includes('password'), false);
  await assert.rejects(h.service.listStudents('producer-a', { courseId: "' OR TRUE --" }), { code: 'INVALID_ID' });
});

test('a student record exposes only this producer licenses, keys and devices, and refuses strangers', async () => {
  const vault = createSerialVault(SECRET), ciphertext = vault.encrypt(KEY, 'producer-a', 'license-a');
  const stranger = harness();
  await assert.rejects(stranger.service.getStudent('producer-a', 'student-b'), { code: 'STUDENT_NOT_FOUND' });
  const h = harness({ handler(sql) {
    if (sql.startsWith('SELECT s.id,s.name,s.email,s.active,s.created_at')) return [{ id: 'student-a', name: 'Alumna QA', email: 'client@example.invalid', active: 1, created_at: now, last_login: now, linked_at: now, linked_via: 'license_activation' }];
    if (sql.startsWith('SELECT l.id,l.lot_id')) return [{ ...baseLicense(), ciphertext, student_email: 'client@example.invalid', student_name: 'Alumna QA' }];
    if (sql.startsWith('SELECT a.id,a.license_id,a.device_id')) return [{ id: 'activation-a', license_id: 'license-a', device_id: 'device-a', status: 'active', created_at: now, last_used_at: now, expires_at: null, blocked: false }];
    return null;
  } });
  const record = await h.service.getStudent('producer-a', 'student-a');
  assert.equal(record.student.email, 'client@example.invalid'); assert.equal(record.licenses.length, 1);
  assert.equal(record.licenses[0].serial, KEY); assert.equal(record.licenses[0].activations[0].deviceId, 'device-a');
  assert.ok(h.calls.every(c => c.params[0] === 'producer-a'));
  assert.ok(h.calls.every(c => !/s\.producer_id/.test(c.sql)));
});

test('a free key can be read for delivery without a buyer; revoked keys are never handed out', async () => {
  const vault = createSerialVault(SECRET), ciphertext = vault.encrypt(KEY, 'producer-a', 'license-a');
  const free = harness({ handler(sql) {
    if (sql.startsWith('SELECT v.ciphertext')) return [{ ciphertext }];
    if (sql.startsWith('SELECT l.status FROM licenses')) return [{ status: 'free' }];
    return null;
  } });
  assert.equal(await free.service.readLicensePlainSerial('producer-a', 'license-a'), KEY);
  const revoked = harness({ handler(sql) {
    if (sql.startsWith('SELECT v.ciphertext')) return [{ ciphertext }];
    if (sql.startsWith('SELECT l.status FROM licenses')) return [{ status: 'revoked' }];
    return null;
  } });
  await assert.rejects(revoked.service.readLicensePlainSerial('producer-a', 'license-a'), { code: 'LICENSE_REVOKED' });
  const historical = harness();
  await assert.rejects(historical.service.readLicensePlainSerial('producer-a', 'license-a'), { code: 'LICENSE_SERIAL_UNAVAILABLE' });
});

test('lot serial copies and CSV exports respect an explicit available-only scope and refuse unknown scopes', async () => {
  const vault = createSerialVault(SECRET), ciphertext = vault.encrypt(KEY, 'producer-a', 'license-a');
  const h = harness({ handler(sql) {
    if (sql.startsWith('SELECT id FROM license_lots')) return [{ id: 'lot-a' }];
    if (sql.startsWith('SELECT l.id,l.status')) return [{ id: 'license-a', status: 'free', ciphertext, max_devices: 2 }];
    return null;
  } });
  const copied = await h.service.listLotSerials('producer-a', 'lot-a', { scope: 'available' });
  assert.deepEqual(copied.serials, [KEY]);
  assert.match(h.calls.find(c => c.sql.startsWith('SELECT l.id,l.status')).sql, /l\.status='free' AND l\.student_id IS NULL/);
  const csv = await h.service.exportLot('producer-a', 'lot-a', { scope: 'available' });
  assert.ok(csv.includes('serial,licenseId,availability,status')); assert.ok(csv.includes('available'));
  await assert.rejects(h.service.exportLot('producer-a', 'lot-a', { scope: 'everything' }), { code: 'INVALID_SCOPE' });
});

test('route adapter requires active producer middleware and applies no-store to serial responses', async () => {
  const h = harness(), routes = [], auth = () => {};
  const app = Object.fromEntries(['get', 'patch', 'post'].map(method => [method, (path, middleware, handler) => routes.push({ method, path, middleware, handler })]));
  h.service.mount(app, auth);
  assert.equal(routes.length, 16);
  assert.equal(routes.some(route => route.path.endsWith('/customers')), false, 'Compradores is replaced by Estudiantes');
  assert.ok(routes.some(route => route.path.endsWith('/students')));
  assert.ok(routes.every(route => route.middleware === auth));
  const response = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, set(key, value) { this.headers[key] = value; return this; }, json(value) { this.body = value; }, send(value) { this.body = value; } };
  await routes.find(route => route.path.endsWith('/licenses')).handler({ producer: null, query: {} }, response);
  assert.equal(response.statusCode, 403); assert.equal(h.calls.length, 0);
  await routes.find(route => route.path.endsWith('/licenses')).handler({ producer: { id: 'producer-a', active: 1 }, query: {} }, response);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});
