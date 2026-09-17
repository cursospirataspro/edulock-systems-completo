'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../lib/producer-licenses');
const SECRET = 'synthetic-administrator-license-signing-secret';
const KEY = 'ABCD-EFGH-JKLM-NPQR';
const HASH = crypto.createHmac('sha256', SECRET).update(KEY).digest('hex');
const oldLicense = () => ({ id: 'old-license', producer_id: 'producer-a', student_id: 'student-a', course_id: 'course-a', lot_id: 'lot-a',
  status: 'active', max_devices: 2, expires_at: '2030-02-01T00:00:00.000Z', duration_days: 30, first_activated_at: '2030-01-02T00:00:00.000Z',
  customer_email: 'synthetic@example.invalid', order_id: 'order-a', notes: 'Notes', assigned_at: '2030-01-01T00:00:00.000Z',
  buyer_name: 'Synthetic Buyer', buyer_phone: '12345' });
function load({ old = oldLicense(), signingSecret = SECRET, custodyFails = false, vaultKey = SECRET } = {}) {
  const calls = []; let releases = 0;
  const query = async (input, params = []) => {
    const sql = input.replace(/\s+/g, ' ').trim(); calls.push({ sql, params: [...params] });
    if (sql === 'SELECT * FROM licenses WHERE id=$1 FOR UPDATE') return { rows: old ? [old] : [] };
    if (sql.startsWith('SELECT DISTINCT device_id')) return { rows: [{ device_id: 'device-a' }] };
    if (sql.startsWith('INSERT INTO producer_license_serials')) return { rows: custodyFails ? [] : [{ license_id: 'new-license' }] };
    return { rows: [] };
  };
  class Pool { on() {} query(...args) { return query(...args); } async connect() { return { query, release() { releases++; } }; } }
  const vault = policy.createSerialVault(vaultKey, { jwtSecret: SECRET });
  const context = vm.createContext({ module: { exports: {} }, console: { log() {}, error() {} }, process: { env: { JWT_SECRET: signingSecret } },
    require(name) {
      if (name === 'pg') return { Pool };
      if (name === 'uuid') return { v4: crypto.randomUUID };
      if (name === 'node:crypto' || name === 'crypto') return crypto;
      if (name === './lib/producer-licenses') return { ...policy, createSerialVault: () => vault,
        storePreparedSerials: (client, input) => policy.storePreparedSerials(client, { ...input, vault }) };
      throw new Error(`Unexpected dependency ${name}`);
    }
  });
  new vm.Script(fs.readFileSync(path.join(__dirname, '../database-pg.js'), 'utf8')).runInContext(context);
  return { db: context.module.exports, calls, releases: () => releases, vault };
}
const request = () => ({ oldLicenseId: 'old-license', newLicenseId: 'new-license', newLicenseKeyHash: HASH, newLicenseKey: KEY });

test('admin regeneration keeps history and commercial fields, never propagates legacy validity, and seals the replacement atomically', async () => {
  const h = load(), result = await h.db.regenerateLicense(request());
  assert.equal(result.ok, true); assert.equal(result.durationDays, null); assert.equal(result.firstActivatedAt, oldLicense().first_activated_at);
  assert.equal(result.expiresAt, null);
  const insert = h.calls.find(call => call.sql.startsWith('INSERT INTO licenses'));
  assert.equal(insert.params[7], null, 'a replacement course license is permanent');
  assert.deepEqual(insert.params.slice(14), [null, oldLicense().first_activated_at, 'Synthetic Buyer', '12345']);
  const custody = h.calls.find(call => call.sql.startsWith('INSERT INTO producer_license_serials'));
  assert.ok(custody); assert.equal(h.vault.decrypt(custody.params[2], 'producer-a', 'new-license'), KEY);
  assert.equal(JSON.stringify(h.calls).includes(KEY), false);
  assert.equal(h.calls.at(-1).sql, 'COMMIT'); assert.equal(h.releases(), 1);
  assert.ok(h.calls.some(call => call.sql.startsWith('INSERT INTO producer_license_device_blocks')));
});

test('admin regeneration cannot revoke the original if replacement plaintext is absent or mismatches its hash', async () => {
  for (const [fields, code] of [[{ newLicenseKey: undefined }, 'NEW_SERIAL_REQUIRED'], [{ newLicenseKeyHash: 'invalid-hash' }, 'SERIAL_HASH_MISMATCH']]) {
    const h = load();
    await assert.rejects(h.db.regenerateLicense({ ...request(), ...fields }), { code });
    assert.equal(h.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)), false);
    assert.equal(h.calls.at(-1).sql, 'ROLLBACK'); assert.equal(h.releases(), 1);
  }
});

test('admin regeneration refuses missing signing and custody configuration before changing existing access', async () => {
  for (const [options, code] of [[{ signingSecret: '' }, 'SERIAL_SIGNING_UNAVAILABLE'], [{ vaultKey: 'short' }, 'SERIAL_VAULT_UNAVAILABLE']]) {
    const h = load(options);
    await assert.rejects(h.db.regenerateLicense(request()), { code });
    assert.equal(h.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)), false);
    assert.equal(h.calls.at(-1).sql, 'ROLLBACK');
  }
});

test('failed custody write rolls back both the new license and revocation instead of returning an unrecoverable key', async () => {
  const h = load({ custodyFails: true });
  await assert.rejects(h.db.regenerateLicense(request()), { code: 'LICENSE_NOT_FOUND' });
  assert.ok(h.calls.some(call => call.sql.startsWith('UPDATE licenses')));
  assert.ok(h.calls.some(call => call.sql.startsWith('INSERT INTO licenses')));
  assert.equal(h.calls.at(-1).sql, 'ROLLBACK'); assert.equal(h.calls.some(call => call.sql === 'COMMIT'), false);
});

test('unused license stays unstarted and permanent during administrator replacement', async () => {
  const h = load({ old: { ...oldLicense(), student_id: null, first_activated_at: null, expires_at: null, assigned_at: null } });
  const result = await h.db.regenerateLicense(request());
  assert.equal(result.firstActivatedAt, null); assert.equal(result.expiresAt, null); assert.equal(result.durationDays, null);
  const insert = h.calls.find(call => call.sql.startsWith('INSERT INTO licenses'));
  assert.equal(insert.params[4], 'free'); assert.equal(insert.params[15], null);
});

test('owner-only legacy licenses retain backward compatibility without creating producer custody', async () => {
  const h = load({ old: { ...oldLicense(), producer_id: null } });
  assert.equal((await h.db.regenerateLicense({ ...request(), newLicenseKey: undefined })).ok, true);
  assert.equal(h.calls.some(call => call.sql.startsWith('INSERT INTO producer_license_serials')), false);
});
