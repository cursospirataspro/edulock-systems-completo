'use strict';
const https = require('node:https');
const { belongsToVideo } = require('./hls-manifest');

const bunnyHost = /(?:^|\.)(?:b-cdn\.net|bunnycdn\.com|mediadelivery\.net)$/i;
function failure(code, message) { return Object.assign(new Error(message), { code }); }

async function fetchBunnyText(url, { catalogUrl = url, maxBytes = 2 * 1024 * 1024,
    timeoutMs = 15000, maxRedirects = 1, request = https.get } = {}) {
    let current;
    try { current = new URL(url).href; }
    catch { throw failure('BUNNY_MEDIA_URL_INVALID', 'URL de reproducción no válida.'); }
    const initial = new URL(current);
    if (!bunnyHost.test(initial.hostname) || !belongsToVideo(current, catalogUrl)) {
        throw failure('BUNNY_MEDIA_URL_INVALID', 'URL de reproducción no permitida.');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
        !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) throw new TypeError('Invalid fetch limits');

    // One overall deadline covers redirects too, rather than restarting a
    // full timeout whenever the server changes its location.
    const deadline = Date.now() + timeoutMs;
    for (let redirects = 0; ; redirects++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw failure('BUNNY_MEDIA_TIMEOUT', 'Bunny no respondió dentro del plazo.');
        const result = await new Promise((resolve, reject) => {
            let settled = false, upstream, response;
            const finish = (error, value) => {
                if (settled) return;
                settled = true; clearTimeout(timer);
                if (error) { response?.destroy(); upstream?.destroy(); reject(error); }
                else resolve(value);
            };
            const timeout = () => finish(failure('BUNNY_MEDIA_TIMEOUT', 'Bunny no respondió dentro del plazo.'));
            const timer = setTimeout(timeout, remaining);
            try {
                const target = new URL(current);
                upstream = request(current, { timeout: remaining, headers: { Referer: target.origin + '/' } }, incoming => {
                    if (settled) { incoming.destroy(); return; }
                    response = incoming;
                    incoming.on('error', () => finish(failure('BUNNY_MEDIA_INTERRUPTED', 'La respuesta de Bunny se interrumpió.')));
                    incoming.on('aborted', () => finish(failure('BUNNY_MEDIA_INTERRUPTED', 'La respuesta de Bunny se interrumpió.')));
                    if ([301, 302, 303, 307, 308].includes(incoming.statusCode)) {
                        let location;
                        try { location = new URL(incoming.headers.location, current).href; }
                        catch { return finish(failure('BUNNY_MEDIA_REDIRECT_INVALID', 'Redirección de Bunny no válida.')); }
                        if (!incoming.headers.location || !belongsToVideo(location, catalogUrl) || redirects >= maxRedirects) {
                            return finish(failure('BUNNY_MEDIA_REDIRECT_INVALID', 'Redirección de Bunny no permitida.'));
                        }
                        finish(null, { redirect: location });
                        incoming.destroy();
                        return;
                    }
                    if (incoming.statusCode !== 200) return finish(failure('BUNNY_MEDIA_HTTP_ERROR', `Bunny respondió HTTP ${incoming.statusCode}.`));
                    const declaredLength = incoming.headers['content-length'];
                    if (declaredLength && Number(declaredLength) > maxBytes) return finish(failure('BUNNY_MEDIA_TOO_LARGE', 'La lista de reproducción excede el tamaño permitido.'));
                    const chunks = []; let length = 0;
                    incoming.on('data', chunk => {
                        length += chunk.length;
                        if (length > maxBytes) return finish(failure('BUNNY_MEDIA_TOO_LARGE', 'La lista de reproducción excede el tamaño permitido.'));
                        chunks.push(chunk);
                    });
                    incoming.on('end', () => finish(null, { content: Buffer.concat(chunks).toString('utf8') }));
                });
                upstream.on('error', () => finish(failure('BUNNY_MEDIA_CONNECTION_ERROR', 'No se pudo conectar con Bunny.')));
                upstream.on('timeout', timeout);
            } catch { finish(failure('BUNNY_MEDIA_CONNECTION_ERROR', 'No se pudo conectar con Bunny.')); }
        });
        if (!result.redirect) return result.content;
        current = result.redirect;
    }
}

module.exports = { fetchBunnyText };
