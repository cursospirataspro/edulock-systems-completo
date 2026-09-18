'use strict';
/**
 * Atestación por hardware de Android (Key Attestation).
 *
 * El reproductor genera una clave en el Keystore del dispositivo con un desafío emitido por el
 * servidor; el hardware (TEE o StrongBox) devuelve una cadena de certificados firmada, en última
 * instancia, por una raíz de Google. Aquí se verifica esa cadena y se lee la extensión de
 * atestación (OID 1.3.6.1.4.1.11129.2.1.17): nivel de seguridad, desafío, estado de arranque
 * verificado y bloqueo del dispositivo. No requiere credenciales de Google Cloud.
 *
 * Referencia: https://developer.android.com/privacy-and-security/security-key-attestation
 */
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate, createPublicKey } = require('node:crypto');

const ATTESTATION_OID = '1.3.6.1.4.1.11129.2.1.17';
const OID_DER = Buffer.from('2b06010401d679020111', 'hex'); // codificación DER del OID anterior
const SECURITY_LEVELS = { 0: 'software', 1: 'tee', 2: 'strongbox' };
const BOOT_STATES = { 0: 'verified', 1: 'self_signed', 2: 'unverified', 3: 'failed' };
const TAG_ROOT_OF_TRUST = 704;
// Identidad de la aplicacion que pidio la atestacion: paquetes y huellas de firma.
const TAG_ATTESTATION_APPLICATION_ID = 709;

function loadRoots(file = path.join(__dirname, 'google-attestation-roots.pem')) {
  const pem = fs.readFileSync(file, 'utf8');
  return pem.split(/(?=-----BEGIN CERTIFICATE-----)/).map(s => s.trim()).filter(Boolean)
    .map(p => new X509Certificate(p).publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
}

// ── DER mínimo ──────────────────────────────────────────────────────────────
function readTlv(buf, offset) {
  let pos = offset;
  const first = buf[pos++];
  const constructed = (first & 0x20) !== 0;
  const cls = first >> 6;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let b;
    do { b = buf[pos++]; tag = (tag << 7) | (b & 0x7f); } while (b & 0x80);
  }
  let len = buf[pos++];
  if (len & 0x80) {
    const n = len & 0x7f; len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[pos++];
  }
  if (pos + len > buf.length) throw new Error('DER truncado');
  return { cls, constructed, tag, start: pos, end: pos + len, value: buf.subarray(pos, pos + len), next: pos + len };
}
function parseSequence(buf) {
  const items = []; let p = 0;
  while (p < buf.length) { const t = readTlv(buf, p); items.push(t); p = t.next; }
  return items;
}
const toInt = v => { let n = 0; for (const b of v) n = (n << 8) | b; return n; };

function parseAuthorizationList(buf) {
  const out = {};
  for (const item of parseSequence(buf)) {
    if (item.cls !== 2) continue; // context-specific [tag] EXPLICIT
    if (item.tag === TAG_ROOT_OF_TRUST) {
      const seq = readTlv(item.value, 0);
      const parts = parseSequence(seq.value);
      out.rootOfTrust = {
        verifiedBootKey: parts[0] ? parts[0].value.toString('hex') : null,
        deviceLocked: parts[1] ? parts[1].value[0] !== 0 : null,
        verifiedBootState: parts[2] ? (BOOT_STATES[toInt(parts[2].value)] || 'unknown') : null,
      };
    }
    if (item.tag === TAG_ATTESTATION_APPLICATION_ID) {
      // Viene envuelto en un OCTET STRING que contiene DER.
      try { out.attestationApplicationId = readTlv(item.value, 0).value; } catch { /* se ignora */ }
    }
  }
  return out;
}

/**
 * Identidad de la aplicacion que pidio la atestacion (etiqueta 709):
 * paquetes y huellas de las firmas. Sin esto, una cadena legitima emitida por
 * OTRA aplicacion del mismo telefono pasaba como propia (R07).
 */
function parseAttestationApplicationId(buf) {
  try {
    const out = { packages: [], signatureDigests: [] };
    // buf es el TLV completo de la SEQUENCE, asi que primero se abre.
    const outer = parseSequence(readTlv(buf, 0).value);
    // readTlv devuelve la etiqueta universal: SET es 17, no 0x31.
    const SET = 17;
    const packages = outer[0] && outer[0].tag === SET ? parseSequence(outer[0].value) : [];
    for (const entry of packages) {
      const fields = parseSequence(entry.value);
      if (fields[0]) out.packages.push({ name: fields[0].value.toString('utf8'), version: fields[1] ? toInt(fields[1].value) : null });
    }
    const digests = outer[1] && outer[1].tag === SET ? parseSequence(outer[1].value) : [];
    for (const d of digests) out.signatureDigests.push(d.value.toString('hex'));
    return out;
  } catch { return null; }
}

function parseKeyDescription(der) {
  const seq = readTlv(der, 0);
  const f = parseSequence(seq.value);
  return {
    attestationVersion: toInt(f[0].value),
    attestationSecurityLevel: SECURITY_LEVELS[toInt(f[1].value)] || 'unknown',
    keymasterVersion: toInt(f[2].value),
    keymasterSecurityLevel: SECURITY_LEVELS[toInt(f[3].value)] || 'unknown',
    challenge: f[4].value.toString('hex'),
    softwareEnforced: parseAuthorizationList(f[6].value),
    teeEnforced: parseAuthorizationList(f[7].value),
  };
}

/** Localiza la extensión de atestación dentro del DER del certificado hoja. */
function extractAttestationExtension(certDer) {
  const idx = certDer.indexOf(OID_DER);
  if (idx < 0) return null;
  // Extension ::= SEQUENCE { extnID OID, critical BOOLEAN OPTIONAL, extnValue OCTET STRING }
  let p = idx + OID_DER.length;
  let t = readTlv(certDer, p);
  if (t.tag === 1 && t.cls === 0) t = readTlv(certDer, t.next); // BOOLEAN critical
  if (t.tag !== 4) throw new Error('extensión de atestación inesperada');
  return parseKeyDescription(t.value);
}

/**
 * Verifica una cadena (hoja → raíz) en base64 DER.
 * Nunca lanza: devuelve { ok, reason, ... } para que el inicio de sesión jamás dependa de ella.
 */
function verifyKeyAttestation({ chain, expectedChallenge, roots = loadRoots(), expectedPackage = null } = {}) {
  const result = { ok: false, reason: null, rootTrusted: false, chainValid: false, challengeOk: false,
    securityLevel: null, keymasterSecurityLevel: null, verifiedBootState: null, deviceLocked: null, certificates: 0,
    // Vigencia de los certificados: antes no se miraba, asi que una cadena
    // caducada se registraba como valida.
    validityOk: null,
    // Identidad de la aplicacion que pidio la atestacion.
    applicationPackages: [], applicationSignatureDigests: [], applicationIdMatches: null,
    // La revocacion NO se consulta: se deja dicho para que el registro no se lea
    // como "este dispositivo no esta revocado".
    revocationChecked: false, revocationSource: null };
  try {
    if (!Array.isArray(chain) || chain.length < 2) { result.reason = 'chain_missing'; return result; }
    const certs = chain.map(b64 => new X509Certificate(Buffer.from(String(b64), 'base64')));
    result.certificates = certs.length;
    for (let i = 0; i < certs.length; i++) {
      const issuer = certs[i + 1] || certs[i];
      if (!certs[i].verify(issuer.publicKey)) { result.reason = 'signature_invalid_at_' + i; return result; }
    }
    result.chainValid = true;
    // Vigencia de cada eslabon (R07).
    const ahora = Date.now();
    for (let i = 0; i < certs.length; i++) {
      const desde = Date.parse(certs[i].validFrom), hasta = Date.parse(certs[i].validTo);
      if (Number.isFinite(desde) && ahora < desde) { result.validityOk = false; result.reason = 'certificate_not_yet_valid_at_' + i; return result; }
      if (Number.isFinite(hasta) && ahora > hasta) { result.validityOk = false; result.reason = 'certificate_expired_at_' + i; return result; }
    }
    result.validityOk = true;
    const rootSpki = certs[certs.length - 1].publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    result.rootTrusted = roots.includes(rootSpki);
    const desc = extractAttestationExtension(certs[0].raw);
    if (!desc) { result.reason = 'no_attestation_extension'; return result; }
    result.securityLevel = desc.attestationSecurityLevel;
    result.keymasterSecurityLevel = desc.keymasterSecurityLevel;
    const rot = desc.teeEnforced.rootOfTrust || desc.softwareEnforced.rootOfTrust || {};
    result.verifiedBootState = rot.verifiedBootState || null;
    result.deviceLocked = rot.deviceLocked ?? null;
    // Identidad de la aplicacion, cuando el dispositivo la incluye.
    const appIdRaw = desc.softwareEnforced.attestationApplicationId || desc.teeEnforced.attestationApplicationId || null;
    const appId = appIdRaw ? parseAttestationApplicationId(appIdRaw) : null;
    if (appId) {
      result.applicationPackages = appId.packages.map(x => x.name);
      result.applicationSignatureDigests = appId.signatureDigests;
      if (expectedPackage) result.applicationIdMatches = result.applicationPackages.includes(expectedPackage);
    }
    const expected = expectedChallenge ? Buffer.from(String(expectedChallenge), 'utf8').toString('hex') : null;
    result.challengeOk = !!expected && desc.challenge === expected;
    if (!result.rootTrusted) { result.reason = 'root_not_google'; return result; }
    if (!result.challengeOk) { result.reason = 'challenge_mismatch'; return result; }
    if (result.securityLevel === 'software') { result.reason = 'software_only'; return result; }
    if (result.applicationIdMatches === false) { result.reason = 'application_id_mismatch'; return result; }
    result.ok = true;
    return result;
  } catch (error) {
    result.reason = 'parse_error:' + error.message;
    return result;
  }
}

module.exports = { verifyKeyAttestation, extractAttestationExtension, parseKeyDescription, parseAttestationApplicationId, loadRoots, ATTESTATION_OID };
