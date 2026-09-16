'use strict';
/*
 * edu-packer.js — Empaquetador DRM del servidor (formato .edu).
 * Convierte un mp4 (Buffer) en un contenedor .edu cifrado, idéntico al
 * empaquetador Python (drm-edu/empaquetar.py) y descifrable por el reproductor
 * de escritorio (edu-native.js) y el web (edu-player.js).
 *
 * Se usa al SUBIR un video desde el panel: el servidor lo empaqueta y lo sube a
 * Bunny (modelo InfoProtector: "subes → se protege").
 */
const crypto = require('crypto');

const MAGIC   = Buffer.from('EDU!');   // 45 44 55 21
const VERSION = 1;
const CHUNK   = 8192;
const FLAG_ONLINE    = 1 << 0;
const FLAG_WATERMARK = 1 << 1;

function hkdf(key, info, n = 32) {
    return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), info, n));
}
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; }
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; }

// CEK = HKDF(MASTER_KEY, "edu-cek|" || salt || "|" || content_id)
function deriveCek(masterKeyHex, salt, contentId) {
    const info = Buffer.concat([Buffer.from('edu-cek|'), salt, Buffer.from('|'), Buffer.from(contentId)]);
    return hkdf(Buffer.from(masterKeyHex, 'hex'), info, 32);
}

// Empaqueta un mp4 (Buffer) en un .edu (Buffer). Devuelve { edu, salt, meta }.
function packEdu(mp4, { contentId, title = '', watermark = 'buyer:{ID_COMPRADOR}', masterKeyHex }) {
    const salt = crypto.randomBytes(16);
    const cek  = deriveCek(masterKeyHex, salt, contentId);
    const flags = FLAG_ONLINE | FLAG_WATERMARK;

    // Capa 1: trozos AES-256-GCM con subclave por trozo
    const bodyParts = []; let total_chunks = 0;
    for (let i = 0; i < mp4.length; i += CHUNK) {
        const trozo = mp4.subarray(i, i + CHUNK);
        const idx = i / CHUNK;
        const sub = hkdf(cek, Buffer.concat([Buffer.from('chunk'), u32le(idx)]));
        const nonce = Buffer.concat([salt.subarray(0, 4), u64le(idx)]); // 12 bytes
        const cipher = crypto.createCipheriv('aes-256-gcm', sub, nonce);
        const ct = Buffer.concat([cipher.update(trozo), cipher.final()]);
        const tag = cipher.getAuthTag();
        const blob = Buffer.concat([ct, tag]);            // ct || tag (igual que Python)
        bodyParts.push(u32le(blob.length), blob);
        total_chunks++;
    }
    let body = Buffer.concat(bodyParts);

    // Capa 2: transporte AES-256-CTR
    const tKey = hkdf(cek, Buffer.from('transport'));
    const tc = crypto.createCipheriv('aes-256-ctr', tKey, salt.subarray(0, 16));
    body = Buffer.concat([tc.update(body), tc.final()]);

    // Cabecera cifrada AES-256-GCM
    const meta = { content_id: contentId, title, key_mode: 'online', key_ref: contentId,
        watermark, flags, orig_sha256: crypto.createHash('sha256').update(mp4).digest('hex'),
        chunk_size: CHUNK, total_chunks, orig_len: mp4.length };
    const hKey = hkdf(cek, Buffer.from('header'));
    const hc = crypto.createCipheriv('aes-256-gcm', hKey, salt.subarray(0, 12));
    const hct = Buffer.concat([hc.update(Buffer.from(JSON.stringify(meta), 'utf8')), hc.final()]);
    const hdr = Buffer.concat([hct, hc.getAuthTag()]);

    // Ensamblar contenedor
    let out = Buffer.concat([MAGIC, u16le(VERSION), u16le(flags), salt, u32le(hdr.length), hdr, body]);
    // HMAC-SHA256 final
    const mac = crypto.createHmac('sha256', hkdf(cek, Buffer.from('mac'))).update(out).digest();
    out = Buffer.concat([out, mac]);
    return { edu: out, salt: salt.toString('hex'), meta };
}

module.exports = { packEdu, deriveCek };
