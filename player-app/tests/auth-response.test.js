'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAuthResponse, connectionFailure } = require('../auth-response');
for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) test('HTTP ' + status + ' cannot grant a session or registration redirect', () => {
  const response = normalizeAuthResponse({ status, body: { status: 'approved', token: 'should-not-escape', registrationAllowed: true } }, true);
  assert.equal(response.status, 'error'); assert.equal(response.registrationAllowed, false); assert.equal('token' in response, false);
});
for (const body of [null, '<html>Error</html>', [], undefined]) test('malformed transport body cannot open an account screen: ' + String(body), () => {
  const response = normalizeAuthResponse({ status: 200, body }, true);
  assert.equal(response.status, 'error'); assert.equal(response.registrationAllowed, false);
});
test('successful login requires a non-empty session token', () => {
  for (const token of [undefined, '', ' ', 123]) assert.equal(normalizeAuthResponse({ status: 200, body: { status: 'approved', token } }, true).code, 'INCOMPLETE_SESSION');
});
test('successful login preserves the authoritative session', () => {
  const response = normalizeAuthResponse({ status: 200, body: { status: 'approved', token: 'unit-session' } }, true);
  assert.equal(response.token, 'unit-session'); assert.equal(response.status, 'approved');
});
test('confirmed absence contract survives only a successful HTTP response', () => {
  const body = { status: 'not_registered', code: 'ACCOUNT_NOT_REGISTERED', registrationAllowed: true };
  assert.equal(normalizeAuthResponse({ status: 200, body }).registrationAllowed, true);
  assert.equal(normalizeAuthResponse({ status: 503, body }).registrationAllowed, false);
});
test('a pending registration does not need a login token', () => {
  assert.equal(normalizeAuthResponse({ status: 200, body: { status: 'pending', requestId: 'qa-only' } }).status, 'pending');
});
test('a network error has no registration permission or credentials', () => {
  const response = connectionFailure(); assert.equal(response.code, 'NETWORK_UNAVAILABLE');
  assert.equal(response.registrationAllowed, false); assert.equal('token' in response, false);
});
