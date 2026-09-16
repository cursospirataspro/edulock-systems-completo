'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountAuth } = require('../lib/account-auth');
const missing = () => Object.assign(new Error('not found'), { code: 'auth/user-not-found' });

function fixture() {
  const state = { calls: [], claims: [], ready: true, remote: { uid: 'firebase-a', email: 'a@example.test' },
    decoded: { uid: 'firebase-a', email: 'A@example.test', email_verified: true }, local: null,
    student: { id: 'student-a', email: 'a@example.test', name: 'QA', active: 1, approval_status: 'approved' },
    registration: null, producer: null, device: { ok: true }, owner: null };
  const db = {};
  for (const [method, field] of Object.entries({ findStudentByEmail: 'student', getRegistrationRequestByEmail: 'registration', getProducerByEmail: 'producer', findStudentByDeviceId: 'owner', registerOrValidateDevice: 'device' })) {
    db[method] = async (...args) => { state.calls.push([method, ...args]); if (state.fail === method) throw new Error('SQL unavailable'); return state[field]; };
  }
  db.resolveFirebaseAccount = async args => {
    state.calls.push(['resolveFirebaseAccount', args]);
    if (state.resolveError) throw state.resolveError;
    return { student: state.student, registration: state.registration };
  };
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
for (const field of ['student', 'registration', 'producer', 'local']) test('an existing ' + field + ' prevents registration when Firebase is missing', async () => {
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
for (const method of ['findStudentByEmail', 'getRegistrationRequestByEmail', 'getProducerByEmail']) test('failed SQL ' + method + ' is not an absent account', async () => {
  const f = fixture(); f.state.fail = method; f.state.remoteError = missing();
  await assert.rejects(f.service.accountStatus({ email: 'a@example.test' }), { code: 'DB_UNAVAILABLE', status: 503 });
  assert.equal(f.state.remoteLookup, undefined);
});
for (const email of ['', 'bad', 'x@y', 'a\n@example.test', 'a'.repeat(250) + '@b.test', null]) test('malformed account lookup is rejected: ' + String(email).slice(0, 24), async () => {
  const f = fixture(); await assert.rejects(f.service.accountStatus({ email }), { code: 'INVALID_EMAIL', status: 400 }); assert.equal(f.state.calls.length, 0);
});
test('approved student receives a session only after account and device validation', async () => {
  const f = fixture(); const result = await f.service.login(f.body);
  assert.equal(result.status, 'approved'); assert.equal(result.role, 'student');
  assert.equal(f.state.claims[0].sub, 'student-a'); assert.equal(f.state.claims[0].deviceId, 'device-a');
  assert.deepEqual(f.state.calls.map(c => c[0]), ['resolveFirebaseAccount', 'registerOrValidateDevice']);
  assert.equal(f.state.calls[0][1].email, 'a@example.test');
});
for (const status of ['pending', 'suspended', 'rejected']) test(status + ' account never receives a session or redirect', async () => {
  const f = fixture(); f.state.student.approval_status = status;
  const result = await f.service.login(f.body);
  assert.equal(result.status, status); assert.equal(result.registrationAllowed, false); assert.equal(f.state.claims.length, 0);
});
for (const active of [false, 0, '0', null]) test('inactive state ' + String(active) + ' cannot log in', async () => {
  const f = fixture(); f.state.student.active = active;
  assert.equal((await f.service.login(f.body)).status, 'suspended'); assert.equal(f.state.claims.length, 0);
});
test('Firebase account without application enrollment requires manual completion', async () => {
  const f = fixture(); f.state.student = null;
  const result = await f.service.login(f.body);
  assert.equal(result.status, 'registration_required'); assert.equal(result.code, 'REGISTRATION_REQUIRED');
  assert.equal(result.registrationAllowed, false); assert.equal(f.state.claims.length, 0);
  assert.equal(f.state.calls.some(c => /create|insert/i.test(c[0])), false);
});
for (const status of ['pending', 'rejected', 'suspended']) test('existing ' + status + ' registration is not a new registration', async () => {
  const f = fixture(); f.state.student = null; f.state.registration = { status };
  const result = await f.service.login(f.body);
  assert.equal(result.status, status); assert.equal(result.registrationAllowed, false); assert.equal(f.state.claims.length, 0);
});
test('approved registration missing a student cannot create a wildcard account during login', async () => {
  const f = fixture(); f.state.student = null; f.state.registration = { status: 'approved' };
  await assert.rejects(f.service.login(f.body), { code: 'ACCOUNT_SYNC_REQUIRED', status: 409 }); assert.equal(f.state.claims.length, 0);
});
test('SQL resolution failure cannot become not_registered', async () => {
  const f = fixture(); f.state.resolveError = new Error('connection reset');
  await assert.rejects(f.service.login(f.body), { code: 'DB_UNAVAILABLE', status: 503 }); assert.equal(f.state.claims.length, 0);
});
for (const code of ['ACCOUNT_IDENTITY_MISMATCH', 'ACCOUNT_DUPLICATE', 'EMAIL_VERIFICATION_REQUIRED']) test(code + ' is preserved without fallback or token', async () => {
  const f = fixture(); f.state.resolveError = Object.assign(new Error('Identity conflict'), { code, statusCode: 409 });
  await assert.rejects(f.service.login(f.body), { code }); assert.equal(f.state.claims.length, 0);
});
test('device database failure cannot grant a session', async () => {
  const f = fixture(); f.state.fail = 'registerOrValidateDevice';
  await assert.rejects(f.service.login(f.body), { code: 'DB_UNAVAILABLE', status: 503 }); assert.equal(f.state.claims.length, 0);
});
for (const reason of ['device_blocked', 'device_limit_exceeded']) test(reason + ' is an access failure, not missing registration', async () => {
  const f = fixture(); f.state.device = { ok: false, reason, limit: 1 };
  await assert.rejects(f.service.login(f.body), { code: reason === 'device_blocked' ? 'DEVICE_BLOCKED' : 'DEVICE_LIMIT_EXCEEDED', status: 403 });
  assert.equal(f.state.claims.length, 0);
});
test('verified administrator email works without a SQL student', async () => {
  const f = fixture(); f.state.student = null; f.state.decoded.email = 'ADMIN@EXAMPLE.TEST';
  const result = await f.service.login(f.body); assert.equal(result.role, 'admin'); assert.equal(f.state.claims[0].admin, true);
  assert.equal(f.state.calls[0][0], 'registerOrValidateDevice');
});
test('an unverified email cannot claim the configured administrator identity', async () => {
  const f = fixture(); f.state.decoded.email = 'admin@example.test'; f.state.decoded.email_verified = false;
  await assert.rejects(f.service.login(f.body), { code: 'EMAIL_VERIFICATION_REQUIRED', status: 403 }); assert.equal(f.state.claims.length, 0);
});
test('trusted Firebase admin claim is supported without an email-based grant', async () => {
  const f = fixture(); f.state.decoded.admin = true; f.state.decoded.email_verified = false;
  assert.equal((await f.service.login(f.body)).role, 'admin');
});
test('ordinary local user entry does not grant admin', async () => {
  const f = fixture(); f.state.local = { admin: false };
  assert.equal((await f.service.login(f.body)).role, 'student'); assert.notEqual(f.state.claims[0].admin, true);
});
test('administrator device limit is enforced too', async () => {
  const f = fixture(); f.state.decoded.admin = true; f.state.device = { ok: false, reason: 'device_limit_exceeded' };
  await assert.rejects(f.service.login(f.body), { code: 'DEVICE_LIMIT_EXCEEDED' }); assert.equal(f.state.claims.length, 0);
});
for (const body of [{}, { idToken: 't' }, { idToken: 't', deviceId: '' }, { idToken: 't', deviceId: 'x'.repeat(101) }]) test('incomplete identity input does not mint a session: ' + Object.keys(body).join(','), async () => {
  const f = fixture(); await assert.rejects(f.service.login(body)); assert.equal(f.state.claims.length, 0);
});
test('expired Firebase token is not classified as missing account', async () => {
  const f = fixture(); f.state.tokenError = Object.assign(new Error('expired'), { code: 'auth/id-token-expired' });
  await assert.rejects(f.service.login(f.body), { code: 'INVALID_FIREBASE_TOKEN', status: 401 }); assert.equal(f.state.calls.length, 0);
});
test('Firebase transport errors do not send user to registration', async () => {
  const f = fixture(); f.state.tokenError = Object.assign(new Error('network'), { code: 'auth/network-request-failed' });
  await assert.rejects(f.service.login(f.body), { code: 'FIREBASE_UNAVAILABLE', status: 503 }); assert.equal(f.state.calls.length, 0);
});
test('service startup and unreadable administrator file cannot confirm absence', async () => {
  const f = fixture(); f.state.ready = false;
  await assert.rejects(f.service.accountStatus({ email: 'a@example.test' }), { code: 'DB_UNAVAILABLE' });
  f.state.ready = true; f.state.localError = true;
  await assert.rejects(f.service.login(f.body), { code: 'ACCOUNT_STORE_UNAVAILABLE' }); assert.equal(f.state.claims.length, 0);
});
