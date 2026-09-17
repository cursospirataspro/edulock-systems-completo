'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountAuth } = require('../lib/account-auth');
const missing = () => Object.assign(new Error('not found'), { code: 'auth/user-not-found' });

function fixture() {
  const state = { calls: [], claims: [], ready: true, remote: { uid: 'firebase-a', email: 'a@example.test' },
    decoded: { uid: 'firebase-a', email: 'A@example.test', email_verified: true }, local: null,
    student: { id: 'student-a', email: 'a@example.test', name: 'QA', active: 1, approval_status: 'approved' },
    producer: null, device: { ok: true }, owner: null };
  const db = {};
  for (const [method, field] of Object.entries({ findStudentByEmail: 'student', getProducerByEmail: 'producer', findStudentByDeviceId: 'owner', registerOrValidateDevice: 'device' })) {
    db[method] = async (...args) => { state.calls.push([method, ...args]); if (state.fail === method) throw new Error('SQL unavailable'); return state[field]; };
  }
  const service = createAccountAuth({ db, adminEmail: ' ADMIN@example.test ', isReady: () => state.ready,
    findLocalUser: async email => { if (state.localError) throw new Error('file unreadable'); state.lookupEmail = email; return state.local; },
    lookupFirebaseUser: async email => { state.remoteLookup = email; if (state.remoteError) throw state.remoteError; return state.remote; },
    verifyFirebaseToken: async token => { if (state.tokenError) throw state.tokenError; state.token = token; return state.decoded; },
    signSession: claims => { state.claims.push(claims); return 'synthetic-signed-session'; } });
  return { state, db, service, body: { idToken: 'synthetic-id-token', deviceId: 'device-a', appVersion: '1.0.2', platform: 'win32', osRelease: '10.0' } };
}

test('only authoritative Firebase user-not-found plus no SQL/local identity permits automatic registration', async () => {
  const f = fixture(); f.state.student = null; f.state.remoteError = missing();
  assert.deepEqual(await f.service.accountStatus({ email: ' NEW@example.test ' }), {
    status: 'not_registered', code: 'ACCOUNT_NOT_REGISTERED', registrationAllowed: true, message: 'Usuario no registrado.' });
  assert.equal(f.state.remoteLookup, 'new@example.test'); assert.equal(f.state.claims.length, 0);
});
for (const remote of [null, undefined, {}, { uid: '' }]) test('an incomplete Firebase directory response cannot confirm absence: ' + JSON.stringify(remote), async () => {
  const f = fixture(); f.state.student = null; f.state.remote = remote;
  await assert.rejects(f.service.accountStatus({ email: 'a@example.test' }), { code: 'ACCOUNT_LOOKUP_UNAVAILABLE', status: 503 });
});
for (const code of ['auth/insufficient-permission', 'auth/internal-error', 'ETIMEDOUT', 'ACCOUNT_LOOKUP_UNAVAILABLE']) test('directory error is not absence: ' + code, async () => {
  const f = fixture(); f.state.student = null; f.state.remoteError = Object.assign(new Error('error'), { code });
  await assert.rejects(f.service.accountStatus({ email: 'a@example.test' }), { code: 'ACCOUNT_LOOKUP_UNAVAILABLE', status: 503 });
});
for (const field of ['student', 'producer', 'local']) test('an existing ' + field + ' prevents registration when Firebase is missing', async () => {
  const f = fixture(); f.state.student = null; f.state[field] = { id: 'existing' }; f.state.remoteError = missing();
  const result = await f.service.accountStatus({ email: 'a@example.test' });
  assert.equal(result.code, 'ACCOUNT_SYNC_REQUIRED'); assert.equal(result.registrationAllowed, false);
});
test('configured administrator remains existing without any student row', async () => {
  const f = fixture(); f.state.student = null; f.state.remoteError = missing();
  const result = await f.service.accountStatus({ email: ' ADMIN@EXAMPLE.TEST ' });
  assert.equal(result.code, 'ACCOUNT_SYNC_REQUIRED'); assert.equal(result.registrationAllowed, false);
});
test('an existing Firebase user is not sent to registration after a bad password', async () => {
  const f = fixture(); f.state.student = null;
  const result = await f.service.accountStatus({ email: 'a@example.test' });
  assert.equal(result.status, 'account_exists'); assert.equal(result.registrationAllowed, false);
  assert.equal('role' in result, false); assert.equal('uid' in result, false);
});
test('known application identity remains existing when privileged directory lookup is unavailable', async () => {
  const f = fixture(); f.state.remoteError = new Error('No credential');
  const result = await f.service.accountStatus({ email: 'a@example.test' });
  assert.equal(result.status, 'account_exists'); assert.equal(result.registrationAllowed, false);
});
for (const method of ['findStudentByEmail', 'getProducerByEmail']) test('failed SQL ' + method + ' is not an absent account', async () => {
  const f = fixture(); f.state.fail = method; f.state.remoteError = missing();
  await assert.rejects(f.service.accountStatus({ email: 'a@example.test' }), { code: 'DB_UNAVAILABLE', status: 503 });
  assert.equal(f.state.remoteLookup, undefined);
});
for (const email of ['', 'bad', 'x@y', 'a\n@example.test', 'a'.repeat(250) + '@b.test', null]) test('malformed account lookup is rejected: ' + String(email).slice(0, 24), async () => {
  const f = fixture(); await assert.rejects(f.service.accountStatus({ email }), { code: 'INVALID_EMAIL', status: 400 }); assert.equal(f.state.calls.length, 0);
});
test('the account status service exposes no login path: sessions are issued only by firebase-login with automatic enrollment', () => {
  const f = fixture();
  assert.equal(typeof f.service.login, 'undefined'); assert.equal(typeof f.service.accountStatus, 'function');
});
