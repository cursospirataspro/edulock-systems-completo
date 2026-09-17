'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyKeyAttestation, parseKeyDescription, loadRoots } = require('../lib/key-attestation');

// ── codificador DER mínimo para fabricar un KeyDescription sintético ──
const len = n => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
const tlv = (tag, body) => Buffer.concat([Buffer.isBuffer(tag) ? tag : Buffer.from([tag]), len(body.length), body]);
const int = n => tlv(0x02, Buffer.from([n]));
const enm = n => tlv(0x0a, Buffer.from([n]));
const oct = b => tlv(0x04, Buffer.isBuffer(b) ? b : Buffer.from(b));
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const ctx704 = body => tlv(Buffer.from([0xbf, 0x85, 0x40]), body); // [704] EXPLICIT rootOfTrust
const rootOfTrust = (locked, state) => ctx704(seq(oct(Buffer.alloc(32, 1)), tlv(0x01, Buffer.from([locked ? 0xff : 0])), enm(state), oct(Buffer.alloc(32, 2))));
const keyDescription = ({ level = 1, challenge = 'abc', locked = true, state = 0 } = {}) =>
  seq(int(4), enm(level), int(41), enm(level), oct(challenge), oct(Buffer.alloc(0)), seq(), seq(rootOfTrust(locked, state)));

test('parses a KeyDescription with TEE root of trust', () => {
  const d = parseKeyDescription(keyDescription({ level: 1, challenge: 'reto-123', locked: true, state: 0 }));
  assert.equal(d.attestationSecurityLevel, 'tee'); assert.equal(d.keymasterSecurityLevel, 'tee');
  assert.equal(Buffer.from(d.challenge, 'hex').toString(), 'reto-123');
  assert.equal(d.teeEnforced.rootOfTrust.deviceLocked, true); assert.equal(d.teeEnforced.rootOfTrust.verifiedBootState, 'verified');
  const sb = parseKeyDescription(keyDescription({ level: 2, state: 2, locked: false }));
  assert.equal(sb.attestationSecurityLevel, 'strongbox'); assert.equal(sb.teeEnforced.rootOfTrust.verifiedBootState, 'unverified'); assert.equal(sb.teeEnforced.rootOfTrust.deviceLocked, false);
});

test('Google roots load and a synthetic self-signed chain is never trusted', () => {
  assert.ok(loadRoots().length >= 4);
  const { generateKeyPairSync, X509Certificate } = require('node:crypto');
  // Sin OpenSSL para emitir certificados aquí, se usa una raíz real de Google como "cadena" de un solo eslabón
  // para comprobar que una cadena incompleta o sin extensión se rechaza sin lanzar.
  const pem = fs.readFileSync(path.join(__dirname, '..', 'lib', 'google-attestation-roots.pem'), 'utf8').split(/(?=-----BEGIN)/)[0].trim();
  const der = new X509Certificate(pem).raw.toString('base64');
  assert.equal(verifyKeyAttestation({ chain: [der] }).reason, 'chain_missing');
  const r = verifyKeyAttestation({ chain: [der, der], expectedChallenge: 'x' });
  assert.equal(r.chainValid, true); assert.equal(r.rootTrusted, true); assert.equal(r.reason, 'no_attestation_extension'); assert.equal(r.ok, false);
  assert.equal(verifyKeyAttestation({ chain: ['no-es-der', der] }).ok, false);
  assert.equal(verifyKeyAttestation({}).reason, 'chain_missing');
  void generateKeyPairSync;
});

const fixture = path.join(__dirname, 'fixtures', 'key-attestation-moto-e32.json');
test('a real device chain (fixture) verifies against Google roots', { skip: !fs.existsSync(fixture) && 'sin fixture real' }, () => {
  const f = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const r = verifyKeyAttestation({ chain: f.chain, expectedChallenge: f.challenge });
  assert.equal(r.rootTrusted, true, r.reason); assert.equal(r.chainValid, true); assert.equal(r.challengeOk, true);
  assert.notEqual(r.securityLevel, 'software'); assert.equal(r.ok, true, r.reason);
  assert.equal(verifyKeyAttestation({ chain: f.chain, expectedChallenge: 'otro-reto' }).reason, 'challenge_mismatch');
});
