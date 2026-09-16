'use strict';

// These tests require an explicitly named disposable QA database. All fixture
// rows are tracked by generated UUID, and no mail/provider endpoint is called.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
let databaseName = '';
try { databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL || '').pathname.slice(1)); } catch {}
const allowed = /^edulock_qa(?:_[a-zA-Z0-9-]+)*$/;
if (!allowed.test(databaseName)) {
  console.error('REFUSED: producer license tests require an explicitly named edulock_qa database.');
  process.exit(1);
}
for (const key of ['COURSES_SEED', 'CATALOG_SEED', 'CATALOG_SEED_1', 'CATALOG_SEED_2', 'CATALOG_SEED_3', 'ALLOWED_DOMAINS_SEED']) delete process.env[key];
// Test-process-only secrets isolate new synthetic serials from all application keys.
const previousJwt = process.env.JWT_SECRET, previousVault = process.env.LICENSE_VAULT_KEY;
process.env.JWT_SECRET = 'synthetic-producer-license-test-signing-secret';
process.env.LICENSE_VAULT_KEY = 'synthetic-producer-license-test-vault-secret';
const db = require('../database-pg');
const { createProducerLicenseWorkspace, ensureSchema } = require('../lib/producer-licenses');
const service = createProducerLicenseWorkspace({ pool: db.pool });
const registry = { producers: [], students: [], courses: [], licenses: [], license_lots: [], videos: [], sessions: [] };
const id = kind => { const value = crypto.randomUUID(); registry[kind].push(value); return value; };
const query = (...args) => db.pool.query(...args);
const hash = value => crypto.createHmac('sha256', process.env.JWT_SECRET).update(value).digest('hex');
function key() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 16 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('').match(/.{4}/g).join('-');
}
before(async () => {
  const actual = (await query('SELECT current_database() AS name')).rows[0].name;
  assert.equal(actual, databaseName); assert.match(actual, allowed);
  await db.initDb(); await ensureSchema(db.pool);
});
after(async () => {
  try {
    const deletes = [
      ['producer_mail_outbox', 'producer_id', registry.producers],
      ['producer_workspace_audit', 'producer_id', registry.producers],
      ['producer_customer_profiles', 'producer_id', registry.producers],
      ['producer_license_device_blocks', 'producer_id', registry.producers],
      ['producer_license_serials', 'producer_id', registry.producers],
      ['producer_content_settings', 'producer_id', registry.producers],
      ['playback_sessions', 'session_id', registry.sessions],
      ['active_sessions', 'session_id', registry.sessions],
      ['suspicious_activity', 'student_id', registry.students],
      ['activations', 'license_id', registry.licenses],
      ['devices', 'student_id', registry.students],
      ['student_courses', 'student_id', registry.students],
      ['licenses', 'id', registry.licenses],
      ['license_lots', 'id', registry.license_lots],
      ['catalog', 'video_id', registry.videos],
      ['deleted_videos', 'video_id', registry.videos],
      ['courses', 'id', registry.courses],
      ['students', 'id', registry.students],
      ['producers', 'id', registry.producers]
    ];
    for (const [table, column, values] of deletes) if (values.length) {
      // Optional sibling-service tables may not exist in a minimal test database.
      if (!(await query('SELECT to_regclass($1) AS name', [table])).rows[0].name) continue;
      await query(`DELETE FROM ${table} WHERE ${column}=ANY($1::text[])`, [values]);
    }
  } finally {
    if (previousJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousJwt;
    if (previousVault === undefined) delete process.env.LICENSE_VAULT_KEY; else process.env.LICENSE_VAULT_KEY = previousVault;
    await db.pool.end();
  }
});
async function fixture({ quantity = 2, maxDevices = 2, durationDays = null, maxLicenses = 10 } = {}) {
  const producerId = id('producers'), studentId = id('students'), courseId = id('courses');
  await db.createProducer({ id: producerId, email: `${producerId}@licenses-qa.invalid`, passwordHash: hash('synthetic'), name: 'Synthetic producer', maxLicenses, maxDevices, maxStudents: 0 });
  await db.createStudent({ id: studentId, email: `${studentId}@licenses-qa.invalid`, studentId: `qa-${studentId}`, name: 'Synthetic student', active: true, allowedVideos: [] });
  await query("UPDATE students SET approval_status='approved',max_devices=$1,producer_id=$2 WHERE id=$3", [maxDevices, producerId, studentId]);
  await db.createCourse({ id: courseId, name: 'Synthetic license course', producerId });
  const lotId = id('license_lots'), licenses = Array.from({ length: quantity }, () => { const serial = key(); return { id: id('licenses'), key: serial, hash: hash(serial) }; });
  const generated = await db.createProducerLotAtomic({ producerId, maxLicenses, lot: { id: lotId, courseId, maxDevices, durationDays, name: 'Lote QA', notes: 'Synthetic QA only', createdBy: 'test' }, licenses });
  assert.equal(generated.ok, true);
  return { producerId, studentId, studentEmail: `${studentId}@licenses-qa.invalid`, courseId, lotId, licenses, maxDevices };
}
async function activate(f, license = f.licenses[0], deviceId = crypto.randomUUID(), expiresAt = null) {
  return db.claimAndActivateLicenseAtomic({ licenseKeyHash: license.hash, studentId: f.studentId, deviceId,
    activationTokenHash: hash(crypto.randomUUID()), maxAllowed: f.maxDevices, expiresAt });
}
async function sessions(f, deviceId, courseId = f.courseId) {
  const videoId = id('videos');
  await db.addToCatalog({ videoId, title: 'QA session video', status: 'ready', sourceType: 'local', courseId, producerId: f.producerId });
  const activeId = id('sessions'), playbackId = id('sessions'), now = new Date().toISOString();
  await query('INSERT INTO active_sessions(session_id,user_id,video_id,started_at,last_seen,device_id) VALUES($1,$2,$3,$4,$4,$5)', [activeId, f.studentId, videoId, Date.now(), deviceId]);
  await query('INSERT INTO playback_sessions(session_id,student_id,student_email,course_id,lesson_id,device_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [playbackId, f.studentId, f.studentEmail, courseId, videoId, deviceId, now, new Date(Date.now() + 3600000).toISOString()]);
  return { activeId, playbackId };
}
async function assertSession(pair, exists) {
  assert.equal((await query('SELECT 1 FROM active_sessions WHERE session_id=$1', [pair.activeId])).rows.length, exists ? 1 : 0);
  assert.equal((await query('SELECT 1 FROM playback_sessions WHERE session_id=$1', [pair.playbackId])).rows.length, exists ? 1 : 0);
}

test('real generation stores encrypted serials atomically and exports them from a new service instance', async () => {
  const f = await fixture();
  const stored = (await query('SELECT * FROM producer_license_serials WHERE producer_id=$1 ORDER BY license_id', [f.producerId])).rows;
  assert.equal(stored.length, 2); assert.equal(JSON.stringify(stored).includes(f.licenses[0].key), false);
  const fresh = createProducerLicenseWorkspace({ pool: db.pool });
  const csv = await fresh.exportLot(f.producerId, f.lotId);
  for (const license of f.licenses) {
    assert.ok(csv.includes(license.key));
    assert.equal(await fresh.readLicenseSerial({ producerId: f.producerId, licenseId: license.id }), license.key);
  }
  const lots = await fresh.listLots(f.producerId);
  assert.equal(lots.lots[0].name, 'Lote QA'); assert.equal(lots.lots[0].total, 2); assert.equal(lots.lots[0].exportableCount, 2);
});

test('real search, status, course and lot filters stay within producer ownership', async () => {
  const a = await fixture(), b = await fixture();
  const own = await service.listLicenses(a.producerId, { q: a.licenses[0].key, lotId: a.lotId, courseId: a.courseId, status: 'free', pageSize: 1 });
  assert.equal(own.total, 1); assert.equal(own.licenses[0].id, a.licenses[0].id);
  assert.equal(own.licenses[0].serialAvailable, true);
  assert.equal(JSON.stringify(own).includes(a.licenses[0].key), false);
  assert.equal(JSON.stringify(own).includes(a.licenses[0].hash), false);
  assert.equal((await service.listLicenses(a.producerId, { lotId: b.lotId })).total, 0);
  assert.equal((await service.listLicenses(a.producerId, { q: b.licenses[0].key })).total, 0);
  assert.equal(await service.readLicenseSerial({ producerId: a.producerId, licenseId: b.licenses[0].id }), null);
  await assert.rejects(service.exportLot(a.producerId, b.lotId), { code: 'LOT_NOT_FOUND' });
  await assert.rejects(service.updateLicense(a.producerId, b.licenses[0].id, { notes: 'Intrusion' }), { code: 'LICENSE_NOT_FOUND' });
  await assert.rejects(service.listActivations(a.producerId, b.licenses[0].id), { code: 'LICENSE_NOT_FOUND' });
});

test('real metadata and customer profiles persist without transferring an assigned account', async () => {
  const f = await fixture();
  const activated = await activate(f); assert.equal(activated.ok, true);
  await service.updateLicense(f.producerId, f.licenses[0].id, { buyerName: 'Comprador QA', buyerPhone: '12345', orderId: 'QA-ORDER', notes: 'Note' });
  await assert.rejects(service.updateLicense(f.producerId, f.licenses[0].id, { customerEmail: 'another@qa.invalid' }), { code: 'ASSIGNED_BUYER_IMMUTABLE' });
  const listed = await service.listCustomers(f.producerId, { q: f.studentEmail });
  assert.equal(listed.total, 1); assert.equal(listed.customers[0].activeLicenses, 1); assert.equal(listed.customers[0].name, 'Comprador QA');
  await service.updateCustomer(f.producerId, { email: f.studentEmail, name: 'Nombre ficha', notes: 'Nueva nota' });
  await service.updateCustomer(f.producerId, { email: f.studentEmail, phone: '67890' });
  const again = await service.listCustomers(f.producerId);
  assert.equal(again.customers[0].name, 'Nombre ficha'); assert.equal(again.customers[0].phone, '67890'); assert.equal(again.customers[0].notes, 'Nueva nota');
  const other = await fixture();
  await assert.rejects(service.updateCustomer(other.producerId, { email: f.studentEmail, notes: 'Intrusion' }), { code: 'CUSTOMER_NOT_FOUND' });
});

test('real suspension revokes activations and only matching course sessions; reactivation requires a fresh activation', async () => {
  const f = await fixture(), deviceId = crypto.randomUUID();
  assert.equal((await activate(f, f.licenses[0], deviceId)).ok, true);
  const current = await sessions(f, deviceId), otherCourse = id('courses');
  await db.createCourse({ id: otherCourse, name: 'Other retained course', producerId: f.producerId });
  const unrelated = await sessions(f, deviceId, otherCourse);
  await service.setLicenseStatus(f.producerId, f.licenses[0].id, 'suspended');
  await assertSession(current, false); await assertSession(unrelated, true);
  assert.equal((await db.getLicenseById(f.licenses[0].id)).status, 'suspended');
  assert.equal((await service.listActivations(f.producerId, f.licenses[0].id)).activations[0].status, 'revoked');
  assert.equal((await activate(f, f.licenses[0], deviceId)).ok, false);
  await service.setLicenseStatus(f.producerId, f.licenses[0].id, 'active');
  assert.equal((await service.listActivations(f.producerId, f.licenses[0].id)).activations[0].status, 'revoked');
  assert.equal((await activate(f, f.licenses[0], deviceId)).ok, true);
});

test('real serial rotation preserves quota and assignment, invalidates old hash and replaces ciphertext in one transaction', async () => {
  const f = await fixture({ quantity: 1, maxLicenses: 1 }), deviceId = crypto.randomUUID();
  assert.equal((await activate(f, f.licenses[0], deviceId)).ok, true);
  const current = await sessions(f, deviceId), before = await db.getLicenseById(f.licenses[0].id);
  const rotated = await service.reissueLicense(f.producerId, before.id, true);
  assert.notEqual(rotated.key, f.licenses[0].key);
  assert.equal(await db.countProducerLicenses(f.producerId), 1);
  assert.equal(await db.getLicenseByKeyHash(f.licenses[0].hash), null);
  const after = await db.getLicenseById(before.id);
  for (const field of ['id', 'student_id', 'course_id', 'lot_id', 'producer_id', 'max_devices', 'expires_at', 'first_activated_at', 'status']) assert.equal(after[field], before[field]);
  assert.equal(after.license_key_hash, hash(rotated.key));
  assert.equal(await service.readLicenseSerial({ producerId: f.producerId, licenseId: before.id }), rotated.key);
  await assertSession(current, false);
  assert.equal((await activate(f, f.licenses[0], deviceId)).ok, false);
  assert.equal((await activate(f, { id: before.id, hash: hash(rotated.key) }, deviceId)).ok, true);
  await service.setLicenseStatus(f.producerId, before.id, 'revoked');
  await assert.rejects(service.reissueLicense(f.producerId, before.id, true), { code: 'LICENSE_REVOKED' });
  await assert.rejects(service.setLicenseStatus(f.producerId, before.id, 'active'), { code: 'LICENSE_REVOKED' });
});

test('real device reset frees the global device slot so a different computer can activate', async () => {
  const f = await fixture({ quantity: 1, maxDevices: 1 }), firstDevice = crypto.randomUUID(), secondDevice = crypto.randomUUID();
  const first = await activate(f, f.licenses[0], firstDevice); assert.equal(first.ok, true);
  assert.equal((await activate(f, f.licenses[0], secondDevice)).ok, false);
  await service.activationAction(f.producerId, first.activationId, 'reset');
  assert.equal((await query('SELECT status FROM devices WHERE student_id=$1 AND fingerprint=$2', [f.studentId, firstDevice])).rows[0].status, 'inactive');
  const second = await activate(f, f.licenses[0], secondDevice); assert.equal(second.ok, true);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM devices WHERE student_id=$1 AND status='active'", [f.studentId])).rows[0].n, 1);
});

test('real device block persists across retries and unblocking does not undo administrator blocks', async () => {
  const f = await fixture({ quantity: 1, maxDevices: 1 }), deviceId = crypto.randomUUID();
  const activation = await activate(f, f.licenses[0], deviceId); assert.equal(activation.ok, true);
  await service.activationAction(f.producerId, activation.activationId, 'block');
  const blocked = await activate(f, f.licenses[0], deviceId); assert.equal(blocked.ok, false); assert.equal(blocked.reason, 'device_blocked');
  assert.equal((await service.listActivations(f.producerId, f.licenses[0].id)).activations[0].blocked, true);
  await query("UPDATE devices SET status='blocked' WHERE student_id=$1 AND fingerprint=$2", [f.studentId, deviceId]);
  await service.activationAction(f.producerId, activation.activationId, 'unblock');
  assert.equal((await query('SELECT status FROM devices WHERE student_id=$1 AND fingerprint=$2', [f.studentId, deviceId])).rows[0].status, 'blocked');
  const still = await activate(f, f.licenses[0], deviceId); assert.equal(still.ok, false); assert.equal(still.reason, 'device_blocked');
});

test('real reset keeps a device registered if a second license still uses it', async () => {
  const f = await fixture({ quantity: 2, maxDevices: 1 }), deviceId = crypto.randomUUID();
  const a = await activate(f, f.licenses[0], deviceId), b = await activate(f, f.licenses[1], deviceId);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  await service.activationAction(f.producerId, a.activationId, 'reset');
  assert.equal((await query('SELECT status FROM devices WHERE student_id=$1 AND fingerprint=$2', [f.studentId, deviceId])).rows[0].status, 'active');
  assert.equal((await service.listActivations(f.producerId, f.licenses[1].id)).activations[0].status, 'active');
});

test('real relative duration starts on first successful activation and never restarts on another computer or serial rotation', async () => {
  const f = await fixture({ quantity: 1, durationDays: 2 }), deviceId = crypto.randomUUID();
  const before = await db.getLicenseById(f.licenses[0].id);
  assert.equal(before.expires_at, null); assert.equal(before.first_activated_at, null);
  const first = await activate(f, f.licenses[0], deviceId); assert.equal(first.ok, true);
  const persisted = await db.getLicenseById(f.licenses[0].id);
  assert.equal(Date.parse(persisted.expires_at) - Date.parse(persisted.first_activated_at), 2 * 86400000);
  assert.equal(first.expiresAt, persisted.expires_at);
  const second = await activate(f, f.licenses[0], crypto.randomUUID()); assert.equal(second.ok, true);
  assert.equal((await db.getLicenseById(persisted.id)).expires_at, persisted.expires_at);
  await assert.rejects(service.updateLicense(f.producerId, persisted.id, { durationDays: 5 }), { code: 'DURATION_ALREADY_STARTED' });
  const rotated = await service.reissueLicense(f.producerId, persisted.id, true);
  assert.equal((await activate(f, { id: persisted.id, hash: hash(rotated.key) }, deviceId)).ok, true);
  assert.equal((await db.getLicenseById(persisted.id)).expires_at, persisted.expires_at);
});

test('real failed activation rolls back first activation time and idempotent sale claims consume only one key', async () => {
  const f = await fixture({ quantity: 2, maxDevices: 1, durationDays: 3 }), deviceId = crypto.randomUUID();
  await query("INSERT INTO devices(id,student_id,fingerprint,status,first_seen,last_seen) VALUES($1,$2,$3,'blocked',$4,$4)", [crypto.randomUUID(), f.studentId, deviceId, new Date().toISOString()]);
  const failed = await activate(f, f.licenses[0], deviceId); assert.equal(failed.ok, false);
  assert.equal((await db.getLicenseById(f.licenses[0].id)).first_activated_at, null);
  const input = { courseId: f.courseId, customerEmail: f.studentEmail, studentId: f.studentId, producerId: f.producerId, orderId: crypto.randomUUID() };
  const claims = await Promise.all([db.claimFreeLicense(input), db.claimFreeLicense(input)]);
  assert.equal(claims[0].id, claims[1].id);
  const assigned = await db.getLicenseById(claims[0].id); assert.equal(assigned.first_activated_at, null);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM licenses WHERE producer_id=$1 AND status='active'", [f.producerId])).rows[0].n, 1);
  assert.equal(await db.countProducerLicenses(f.producerId), 2);
});

test('real lot rename and movement preserve course and ciphertext; cross-course movement is refused', async () => {
  const f = await fixture(), target = id('license_lots');
  await query('INSERT INTO license_lots(id,course_id,quantity,created_at,producer_id) VALUES($1,$2,0,$3,$4)', [target, f.courseId, new Date().toISOString(), f.producerId]);
  await service.updateLot(f.producerId, target, { name: 'Destino QA', notes: 'Moved keys' });
  assert.equal((await service.moveLot(f.producerId, f.lotId, target)).moved, 2);
  assert.equal((await service.listLots(f.producerId)).lots.find(lot => lot.id === target).total, 2);
  assert.equal((await service.listLots(f.producerId)).lots.find(lot => lot.id === f.lotId).total, 0);
  assert.ok((await service.exportLot(f.producerId, target)).includes(f.licenses[0].key));
  assert.equal(await db.countProducerLicenses(f.producerId), 2);
  const anotherCourse = id('courses'), otherLot = id('license_lots');
  await db.createCourse({ id: anotherCourse, name: 'Other course', producerId: f.producerId });
  await query('INSERT INTO license_lots(id,course_id,quantity,created_at,producer_id) VALUES($1,$2,0,$3,$4)', [otherLot, anotherCourse, new Date().toISOString(), f.producerId]);
  await assert.rejects(service.moveLot(f.producerId, target, otherLot), { code: 'LOT_COURSE_MISMATCH' });
});

test('real historical hash-only license cannot be exported until explicit rotation, and tampering fails closed', async () => {
  const f = await fixture({ quantity: 1 });
  await query('DELETE FROM producer_license_serials WHERE license_id=$1', [f.licenses[0].id]);
  assert.equal(await service.readLicenseSerial({ producerId: f.producerId, licenseId: f.licenses[0].id }), null);
  await assert.rejects(service.exportLot(f.producerId, f.lotId), { code: 'HISTORICAL_SERIALS_UNAVAILABLE' });
  const rotated = await service.reissueLicense(f.producerId, f.licenses[0].id, true);
  assert.ok((await service.exportLot(f.producerId, f.lotId)).includes(rotated.key));
  await query("UPDATE producer_license_serials SET ciphertext='v1:invalid:invalid:invalid' WHERE license_id=$1", [f.licenses[0].id]);
  await assert.rejects(service.exportLot(f.producerId, f.lotId), { code: 'SERIAL_INTEGRITY_ERROR' });
});

test('real quota and active activation caps are enforced on edits and concurrent generations', async () => {
  const f = await fixture({ quantity: 1, maxLicenses: 2, maxDevices: 2 });
  await assert.rejects(service.updateLicense(f.producerId, f.licenses[0].id, { maxDevices: 3 }), { code: 'DEVICE_QUOTA_EXCEEDED' });
  assert.equal((await activate(f)).ok, true); assert.equal((await activate(f)).ok, true);
  await assert.rejects(service.updateLicense(f.producerId, f.licenses[0].id, { maxDevices: 1 }), { code: 'ACTIVE_DEVICES_EXCEED_LIMIT' });
  const create = () => { const serial = key(); return db.createProducerLotAtomic({ producerId: f.producerId,
    lot: { id: id('license_lots'), courseId: f.courseId, maxDevices: 1 }, licenses: [{ id: id('licenses'), key: serial, hash: hash(serial) }] }); };
  const results = await Promise.all([create(), create()]);
  assert.equal(results.filter(result => result.ok).length, 1); assert.equal(await db.countProducerLicenses(f.producerId), 2);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM producer_license_serials WHERE producer_id=$1', [f.producerId])).rows[0].n, 2);
});

test('real serial reading within a transaction does not acquire a second database client', async () => {
  const f = await fixture({ quantity: 1 }), client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM licenses WHERE id=$1 FOR UPDATE', [f.licenses[0].id]);
    assert.equal(await service.readLicenseSerial({ producerId: f.producerId, licenseId: f.licenses[0].id, client }), f.licenses[0].key);
    await client.query('ROLLBACK');
  } finally { client.release(); }
});

test('real admin regeneration preserves started duration, buyer metadata and device blocks while keeping the new serial exportable', async () => {
  const f = await fixture({ quantity: 1, durationDays: 30 }), deviceId = crypto.randomUUID();
  const activated = await activate(f, f.licenses[0], deviceId); assert.equal(activated.ok, true);
  await service.updateLicense(f.producerId, f.licenses[0].id, { buyerName: 'Comprador QA', buyerPhone: '12345' });
  await service.activationAction(f.producerId, activated.activationId, 'block');
  const previous = await db.getLicenseById(f.licenses[0].id), serial = key(), newId = id('licenses');
  const result = await db.regenerateLicense({ oldLicenseId: previous.id, newLicenseId: newId, newLicenseKey: serial, newLicenseKeyHash: hash(serial) });
  assert.equal(result.ok, true);
  const replacement = await db.getLicenseById(newId);
  for (const field of ['duration_days', 'first_activated_at', 'expires_at', 'buyer_name', 'buyer_phone', 'student_id', 'course_id', 'lot_id']) assert.equal(replacement[field], previous[field]);
  assert.equal((await db.getLicenseById(previous.id)).status, 'revoked');
  assert.equal(await service.readLicenseSerial({ producerId: f.producerId, licenseId: newId }), serial);
  assert.ok((await service.exportLot(f.producerId, f.lotId)).includes(serial));
  const blocked = await activate(f, { id: newId, hash: hash(serial) }, deviceId); assert.equal(blocked.ok, false); assert.equal(blocked.reason, 'device_blocked');
  assert.equal(result.durationDays, 30); assert.equal(result.firstActivatedAt, previous.first_activated_at);
});

test('real admin regeneration of an unused relative license keeps the clock unstarted and invalid input rolls back access', async () => {
  const f = await fixture({ quantity: 1, durationDays: 7 }), oldId = f.licenses[0].id, serial = key();
  await assert.rejects(db.regenerateLicense({ oldLicenseId: oldId, newLicenseId: id('licenses'), newLicenseKeyHash: hash(serial) }), { code: 'NEW_SERIAL_REQUIRED' });
  await assert.rejects(db.regenerateLicense({ oldLicenseId: oldId, newLicenseId: id('licenses'), newLicenseKey: serial, newLicenseKeyHash: 'wrong' }), { code: 'SERIAL_HASH_MISMATCH' });
  assert.equal((await db.getLicenseById(oldId)).status, 'free'); assert.equal(await db.countProducerLicenses(f.producerId), 1);
  const newId = id('licenses');
  await db.regenerateLicense({ oldLicenseId: oldId, newLicenseId: newId, newLicenseKey: serial, newLicenseKeyHash: hash(serial) });
  const next = await db.getLicenseById(newId);
  assert.equal(next.first_activated_at, null); assert.equal(next.expires_at, null); assert.equal(next.duration_days, 7);
  assert.equal((await activate(f, { id: newId, hash: hash(serial) })).ok, true);
  const activated = await db.getLicenseById(newId);
  assert.equal(Date.parse(activated.expires_at) - Date.parse(activated.first_activated_at), 7 * 86400000);
});
