'use strict';
const crypto = require('node:crypto');

function resourceSignature(secret, kind, videoId, url, mode = '', index = '') {
    return crypto.createHmac('sha256', secret).update(JSON.stringify([kind, videoId, url, String(mode), String(index)])).digest('base64url');
}
function verifyResourceSignature(secret, signature, ...parts) {
    if (typeof signature !== 'string') return false;
    const expected = Buffer.from(resourceSignature(secret, ...parts));
    const supplied = Buffer.from(signature);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
function stripTokenPrefix(pathname) { return pathname.replace(/^\/bcdn_token=[^/]+\//, '/'); }
function belongsToVideo(candidate, playlistUrl) {
    try {
        const url = new URL(candidate), base = new URL(playlistUrl);
        const directory = stripTokenPrefix(base.pathname).slice(0, stripTokenPrefix(base.pathname).lastIndexOf('/') + 1);
        return url.protocol === 'https:' && !url.username && !url.password && url.origin === base.origin &&
            stripTokenPrefix(url.pathname).startsWith(directory) && directory !== '/';
    } catch { return false; }
}

// HLS defines the AES IV as the media sequence encoded as a 128-bit
// big-endian integer. Keep the decimal string intact across URL parameters.
function segmentIV(index) {
    if (typeof index === 'number' && !Number.isSafeInteger(index) || !/^\d+$/.test(String(index))) throw new Error('Índice HLS inválido.');
    const sequence = BigInt(index);
    if (sequence >= 1n << 128n) throw new Error('Índice HLS fuera de rango.');
    return Buffer.from(sequence.toString(16).padStart(32, '0'), 'hex');
}

function rewriteBunnyManifest({ content, targetUrl, catalogUrl, videoId, token, baseUrl, keyUri, secret }) {
    if (!content.trimStart().startsWith('#EXTM3U')) throw new Error('Bunny no devolvió una lista HLS válida.');
    const lines = content.replace(/\r/g, '').split('\n');
    const master = lines.some(line => /^#EXT-X-(STREAM-INF|I-FRAME-STREAM-INF):/.test(line.trim()));
    // The proxy returns complete resources. Byte ranges and low-latency
    // partial segments need a separate signed Range contract to work.
    if (lines.some(line => /^#EXT-X-(BYTERANGE:|PART:|PART-INF:|PRELOAD-HINT:|RENDITION-REPORT:|SESSION-KEY:)/.test(line.trim()) || /[:,]BYTERANGE=/.test(line))) {
        throw new Error('Este formato HLS requiere rangos, partes o claves de sesión que el proxy todavía no admite.');
    }
    const resolve = relative => {
        const url = new URL(relative, targetUrl).href;
        if (!belongsToVideo(url, catalogUrl)) throw new Error('La lista contiene un recurso ajeno al video.');
        return url;
    };
    const link = (kind, url, mode = '', index = '') => {
        const sig = resourceSignature(secret, kind, videoId, url, mode, index);
        const query = new URLSearchParams({ token, sig });
        if (kind === 'manifest') {
            query.set('sub', Buffer.from(url).toString('base64url'));
            return `${baseUrl}/api/r/${videoId}?${query}`;
        }
        if (kind === 'key') {
            query.set('videoId', videoId); query.set('k', Buffer.from(url).toString('base64url'));
            return `${baseUrl}/api/drm/proxy-key?${query}`;
        }
        query.set('seg', Buffer.from(url).toString('base64url')); query.set('enc', String(mode)); query.set('idx', String(index));
        return `${baseUrl}/api/b/${videoId}?${query}`;
    };
    const uriAttributes = (line, kind, mode = '', index = '') => line.replace(/URI="([^"]+)"/g,
        (_, uri) => `URI="${link(kind, resolve(uri), mode, index)}"`);
    const keyLine = index => {
        if (!keyUri) throw new Error('El video no tiene una clave de reproducción disponible.');
        return `#EXT-X-KEY:METHOD=AES-128,URI="${keyUri}",IV=0x${segmentIV(index).toString('hex')}`;
    };
    const sequenceTag = lines.map(line => line.trim()).find(line => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'));
    const sequence = sequenceTag ? sequenceTag.slice('#EXT-X-MEDIA-SEQUENCE:'.length).trim() : '0';
    segmentIV(sequence);
    let index = BigInt(sequence), upstreamEncrypted = false;
    const result = [];
    for (const line of lines) {
        const text = line.trim();
        if (master) {
            if (text && !text.startsWith('#')) result.push(link('manifest', resolve(text)));
            else if (/^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/.test(text)) result.push(uriAttributes(line, 'manifest'));
            else result.push(line);
        } else if (text.startsWith('#EXT-X-KEY:')) {
            const attributes = text.slice('#EXT-X-KEY:'.length);
            const method = (attributes.match(/(?:^|,)METHOD=([^,]+)/) || [])[1];
            const keyFormat = (attributes.match(/(?:^|,)KEYFORMAT="([^"]+)"/) || [])[1];
            if (!['NONE', 'AES-128'].includes(method) || keyFormat && keyFormat !== 'identity') {
                throw new Error('El DRM de esta biblioteca requiere otro reproductor.');
            }
            upstreamEncrypted = method === 'AES-128';
            if (upstreamEncrypted && !/(?:^|,)URI="[^"]+"/.test(attributes)) throw new Error('La clave HLS no tiene una URI válida.');
            result.push(upstreamEncrypted ? uriAttributes(line, 'key') : line);
        } else if (text.startsWith('#EXT-X-MAP:')) {
            if (!upstreamEncrypted) result.push(keyLine(0));
            result.push(uriAttributes(line, 'segment', upstreamEncrypted ? 0 : 1, 0));
        } else if (text && !text.startsWith('#')) {
            if (!upstreamEncrypted) result.push(keyLine(index));
            result.push(link('segment', resolve(text), upstreamEncrypted ? 0 : 1, index));
            index++;
        } else result.push(line);
    }
    return result.join('\n');
}
module.exports = { resourceSignature, verifyResourceSignature, belongsToVideo, segmentIV, rewriteBunnyManifest };
