/*
 * edu-player.js — Descifrado del formato .edu de Edulock en el navegador.
 * Usa SOLO WebCrypto (HKDF-SHA256 + AES-256-GCM + AES-256-CTR): primitivas
 * estándar y auditadas, nada de criptografía hecha a mano. Idéntico al
 * empaquetador Python (drm-edu/empaquetar.py) y al servidor (server.js).
 *
 * API principal:
 *   const mp4Bytes = await EduPlayer.decrypt(arrayBuffer, cekBytes);
 * Devuelve un Uint8Array con el mp4 en claro (MVP: en memoria → Blob).
 * Endurecimiento futuro: descifrar por trozos bajo demanda con MSE + fMP4
 * para que el mp4 no exista nunca entero (ver guía DRM §7).
 */
(function (global) {
  'use strict';
  const subtle = (global.crypto || {}).subtle;
  const te = new TextEncoder();

  async function hkdf(cek, infoStr, len) {
    const key = await subtle.importKey('raw', cek, 'HKDF', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(infoStr) },
      key, len * 8);
    return new Uint8Array(bits);
  }
  // info con bytes crudos (para "chunk" + u32LE): construimos el Uint8Array manualmente
  async function hkdfBytes(cek, infoBytes, len) {
    const key = await subtle.importKey('raw', cek, 'HKDF', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: infoBytes },
      key, len * 8);
    return new Uint8Array(bits);
  }

  function u32le(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
  function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

  async function decrypt(arrayBuffer, cek) {
    const raw = new Uint8Array(arrayBuffer);
    if (!(raw[0] === 0x45 && raw[1] === 0x44 && raw[2] === 0x55 && raw[3] === 0x21)) {
      throw new Error('magic inválido: no es un .edu');
    }
    const dv = new DataView(raw.buffer);
    // Footer HMAC (últimos 32 bytes)
    const body_all = raw.subarray(0, raw.length - 32);
    const mac = raw.subarray(raw.length - 32);
    const macKey = await subtle.importKey('raw', await hkdf(cek, 'mac', 32), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const macOk = await subtle.verify('HMAC', macKey, mac, body_all);
    if (!macOk) throw new Error('HMAC inválido — contenedor manipulado o clave incorrecta');

    let off = 4;
    /* version */ dv.getUint16(off, true); off += 2;
    /* flags   */ dv.getUint16(off, true); off += 2;
    const salt = raw.subarray(off, off + 16); off += 16;
    const hdrLen = dv.getUint32(off, true); off += 4;
    const hdrCt = raw.subarray(off, off + hdrLen); off += hdrLen;

    // Cabecera AES-256-GCM (nonce = salt[:12])
    const hKey = await subtle.importKey('raw', await hkdf(cek, 'header', 32), 'AES-GCM', false, ['decrypt']);
    const hPlain = await subtle.decrypt({ name: 'AES-GCM', iv: salt.subarray(0, 12), tagLength: 128 }, hKey, hdrCt);
    const meta = JSON.parse(new TextDecoder().decode(hPlain));

    // Cuerpo cifrado (entre cabecera y HMAC)
    const cuerpoCt = body_all.subarray(off);

    // Quitar transporte AES-256-CTR (counter = salt[:16], contador de 128 bits)
    const tKey = await subtle.importKey('raw', await hkdf(cek, 'transport', 32), 'AES-CTR', false, ['decrypt']);
    const cuerpoBuf = await subtle.decrypt({ name: 'AES-CTR', counter: salt.subarray(0, 16), length: 128 }, tKey, cuerpoCt);
    const cuerpo = new Uint8Array(cuerpoBuf);

    // Descifrar trozos AES-256-GCM con subclave por trozo
    let p = 0, idx = 0;
    let out = new Uint8Array(0);
    const parts = [];
    while (p < cuerpo.length) {
      const clen = new DataView(cuerpo.buffer, cuerpo.byteOffset + p, 4).getUint32(0, true); p += 4;
      const ct = cuerpo.subarray(p, p + clen); p += clen;
      const sub = await hkdfBytes(cek, concat(te.encode('chunk'), u32le(idx)), 32);
      const subKey = await subtle.importKey('raw', sub, 'AES-GCM', false, ['decrypt']);
      // nonce = salt[:4] || u64LE(idx)
      const nonce = new Uint8Array(12);
      nonce.set(salt.subarray(0, 4), 0);
      new DataView(nonce.buffer).setUint32(4, idx, true); // low 32 bits; high 32 = 0
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, subKey, ct);
      parts.push(new Uint8Array(pt));
      idx++;
    }
    // Concatenar
    let total = 0; for (const x of parts) total += x.length;
    out = new Uint8Array(total); let q = 0;
    for (const x of parts) { out.set(x, q); q += x.length; }
    return { mp4: out, meta };
  }

  const api = { decrypt, hkdf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.EduPlayer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
