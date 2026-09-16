'use strict';
/*
 * edu-native.js — Descifrado del formato .edu en el proceso PRINCIPAL de Electron.
 * Corre con Node nativo (crypto), fuera del contexto web del renderer, para que la
 * clave (CEK) nunca viva en la página. Idéntico al empaquetador Python y al servidor.
 *
 * El mp4 descifrado se mantiene SOLO en memoria del proceso principal y se sirve al
 * <video> por un protocolo propio con soporte de Range. Nunca se escribe a disco.
 */
const crypto = require('crypto');

function hkdf(cek, info, len = 32) {
    return Buffer.from(crypto.hkdfSync('sha256', cek, Buffer.alloc(0), info, len));
}
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

// Descifra un contenedor .edu completo dada la CEK. Devuelve { mp4: Buffer, meta }.
function decryptEdu(buf, cek) {
    if (!(buf[0] === 0x45 && buf[1] === 0x44 && buf[2] === 0x55 && buf[3] === 0x21)) {
        throw new Error('magic inválido: no es un .edu');
    }
    const bodyAll = buf.subarray(0, buf.length - 32);
    const mac = buf.subarray(buf.length - 32);
    const expect = crypto.createHmac('sha256', hkdf(cek, Buffer.from('mac'))).update(bodyAll).digest();
    if (!crypto.timingSafeEqual(mac, expect)) throw new Error('HMAC inválido — contenedor manipulado o clave incorrecta');

    let off = 4;
    off += 2; // version
    off += 2; // flags
    const salt = buf.subarray(off, off + 16); off += 16;
    const hdrLen = buf.readUInt32LE(off); off += 4;
    const hdrCt = buf.subarray(off, off + hdrLen); off += hdrLen;

    // Cabecera AES-256-GCM (nonce = salt[:12], tag = últimos 16)
    const hKey = hkdf(cek, Buffer.from('header'));
    const hd = crypto.createDecipheriv('aes-256-gcm', hKey, salt.subarray(0, 12));
    hd.setAuthTag(hdrCt.subarray(hdrCt.length - 16));
    const hjson = Buffer.concat([hd.update(hdrCt.subarray(0, hdrCt.length - 16)), hd.final()]);
    const meta = JSON.parse(hjson.toString('utf8'));

    // Cuerpo cifrado (entre cabecera y HMAC)
    const cuerpoCt = bodyAll.subarray(off);
    // Transporte AES-256-CTR (counter inicial = salt[:16])
    const tKey = hkdf(cek, Buffer.from('transport'));
    const td = crypto.createDecipheriv('aes-256-ctr', tKey, salt.subarray(0, 16));
    const cuerpo = Buffer.concat([td.update(cuerpoCt), td.final()]);

    // Trozos AES-256-GCM con subclave por trozo
    const parts = []; let p = 0, idx = 0;
    while (p < cuerpo.length) {
        const clen = cuerpo.readUInt32LE(p); p += 4;
        const ct = cuerpo.subarray(p, p + clen); p += clen;
        const sub = hkdf(cek, Buffer.concat([Buffer.from('chunk'), u32le(idx)]));
        const nonce = Buffer.alloc(12);
        salt.subarray(0, 4).copy(nonce, 0);
        nonce.writeUInt32LE(idx >>> 0, 4);
        const d = crypto.createDecipheriv('aes-256-gcm', sub, nonce);
        d.setAuthTag(ct.subarray(ct.length - 16));
        parts.push(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]));
        idx++;
    }
    return { mp4: Buffer.concat(parts), meta };
}

// ================================================================
//  DESCIFRADO POR TROZOS BAJO DEMANDA (guía §7)
//  El mp4 NUNCA existe entero: solo se descifra el trozo que se pide.
//  Se mantiene en RAM el .edu CIFRADO (inútil sin la CEK) + estado de parseo.
// ================================================================

// Abre un .edu: verifica magic + HMAC (una vez), descifra la cabecera y devuelve
// el estado para lecturas por rango. NO descifra el video.
function openEdu(buf, cek) {
    if (!Buffer.isBuffer(buf) || buf.length < 76 || !Buffer.isBuffer(cek) || cek.length !== 32) {
        throw new Error('Contenedor o clave .edu inválidos');
    }
    if (!(buf[0] === 0x45 && buf[1] === 0x44 && buf[2] === 0x55 && buf[3] === 0x21)) {
        throw new Error('magic inválido: no es un .edu');
    }
    const bodyAll = buf.subarray(0, buf.length - 32);
    const mac = buf.subarray(buf.length - 32);
    const expect = crypto.createHmac('sha256', hkdf(cek, Buffer.from('mac'))).update(bodyAll).digest();
    if (!crypto.timingSafeEqual(mac, expect)) throw new Error('HMAC inválido — contenedor manipulado o clave incorrecta');
    if (buf.readUInt16LE(4) !== 1 || (buf.readUInt16LE(6) & ~3)) throw new Error('Versión .edu no soportada');

    let off = 4; off += 2; off += 2;                    // magic, version, flags
    const salt = buf.subarray(off, off + 16); off += 16;
    const hdrLen = buf.readUInt32LE(off); off += 4;
    if (hdrLen < 16 || hdrLen > bodyAll.length - off) throw new Error('Cabecera .edu inválida');
    const hdrCt = buf.subarray(off, off + hdrLen); off += hdrLen;
    const hd = crypto.createDecipheriv('aes-256-gcm', hkdf(cek, Buffer.from('header')), salt.subarray(0, 12));
    hd.setAuthTag(hdrCt.subarray(hdrCt.length - 16));
    const meta = JSON.parse(Buffer.concat([hd.update(hdrCt.subarray(0, hdrCt.length - 16)), hd.final()]).toString('utf8'));

    const chunkSize = meta.chunk_size || 8192;
    if (!Number.isSafeInteger(meta.orig_len) || meta.orig_len < 1) throw new Error('.edu sin longitud original válida (re-empaquétalo)');
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 4194304 ||
        meta.total_chunks !== Math.ceil(meta.orig_len / chunkSize) ||
        bodyAll.length - off !== meta.orig_len + meta.total_chunks * 20) {
        throw new Error('Longitudes .edu inconsistentes');
    }
    return {
        buf, cek, salt,
        tKey: hkdf(cek, Buffer.from('transport')),
        bodyStart: off,
        chunkSize,
        totalChunks: meta.total_chunks,
        origLen: (typeof meta.orig_len === 'number') ? meta.orig_len : null,
        meta,
    };
}

// Contador CTR = (salt[:16] como entero BE de 128 bits) + blockIndex.
function ctrIv(salt16, blockIndex) {
    let v = 0n;
    for (let i = 0; i < 16; i++) v = (v << 8n) | BigInt(salt16[i]);
    v = (v + BigInt(blockIndex)) & ((1n << 128n) - 1n);
    const iv = Buffer.alloc(16);
    for (let i = 15; i >= 0; i--) { iv[i] = Number(v & 0xffn); v >>= 8n; }
    return iv;
}

// Cada trozo (salvo el último) es full: entrada = 4 (len) + chunkSize + 16 (tag).
function chunkEntrySize(st) { return 4 + st.chunkSize + 16; }
function bodyOffsetOfChunk(st, i) { return st.bodyStart + i * chunkEntrySize(st); }
function ctLenOfChunk(st, i) {
    const plain = (i < st.totalChunks - 1) ? st.chunkSize : (st.origLen - i * st.chunkSize);
    return plain + 16; // ct incluye el tag GCM
}

// Descifra SOLO el rango de plaintext [start, end] (inclusive). Descifra los
// trozos que lo cubren y devuelve exactamente esos bytes. El resto no se toca.
function readRange(st, start, end) {
    if (st.closed) throw new Error('Contenido .edu cerrado');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new Error('Rango .edu inválido');
    if (st.origLen == null) throw new Error('.edu sin orig_len (re-empaquétalo)');
    if (start < 0) start = 0;
    if (end >= st.origLen) end = st.origLen - 1;
    if (start > end) return Buffer.alloc(0);

    const first = Math.floor(start / st.chunkSize);
    const last  = Math.floor(end / st.chunkSize);
    const parts = [];
    for (let i = first; i <= last; i++) {
        const ctStart = bodyOffsetOfChunk(st, i) + 4;     // saltar el prefijo de longitud
        const ctLen   = ctLenOfChunk(st, i);
        // 1) quitar transporte AES-256-CTR SOLO de esta región (seekable)
        const bodyByteOff = ctStart - st.bodyStart;
        const blockIndex = Math.floor(bodyByteOff / 16);
        const intra = bodyByteOff % 16;
        const dec = crypto.createDecipheriv('aes-256-ctr', st.tKey, ctrIv(st.salt.subarray(0, 16), blockIndex));
        if (intra) dec.update(Buffer.alloc(intra));       // alinear el keystream
        const ct = dec.update(st.buf.subarray(ctStart, ctStart + ctLen));
        // 2) descifrar el trozo AES-256-GCM
        const sub = hkdf(st.cek, Buffer.concat([Buffer.from('chunk'), u32le(i)]));
        const nonce = Buffer.alloc(12);
        st.salt.subarray(0, 4).copy(nonce, 0);
        nonce.writeUInt32LE(i >>> 0, 4);
        const g = crypto.createDecipheriv('aes-256-gcm', sub, nonce);
        g.setAuthTag(ct.subarray(ct.length - 16));
        parts.push(Buffer.concat([g.update(ct.subarray(0, ct.length - 16)), g.final()]));
    }
    const full = Buffer.concat(parts);
    const sliceStart = start - first * st.chunkSize;
    return full.subarray(sliceStart, sliceStart + (end - start + 1));
}

module.exports = { decryptEdu, openEdu, readRange };
