'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { performance } = require('node:perf_hooks');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGE_BYTES = 12 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function resourceError(code, message) { return Object.assign(new Error(message), { code }); }
function publicUrl(value, apiBase) {
    try {
        let url;
        if (typeof value === 'string' && /^\/resources\/[^/]+\/download$/.test(value)) {
            const id = value.split('/')[2];
            if (!UUID.test(id)) return null;
            const base = new URL(apiBase);
            if (base.username || base.password || !['https:', 'http:'].includes(base.protocol)) return null;
            url = new URL(value, base.origin);
        } else url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
    } catch { return null; }
}
function parseResourceLink(value) {
    try {
        const url = new URL(value);
        const id = url.searchParams.get('id');
        return ['edulock:', 'cdp:'].includes(url.protocol) && url.hostname === 'resource' && UUID.test(id || '')
            && [...url.searchParams.keys()].every(key => key === 'id') && url.searchParams.getAll('id').length === 1
            && !url.username && !url.password && !url.port && !url.hash && ['', '/'].includes(url.pathname)
            ? id.toLowerCase() : null;
    } catch { return null; }
}
function supportedProtection(platform, release) {
    return platform === 'win32' && Number(String(release).split('.')[2]) >= 19041;
}
/**
 * Expande los nombres cortos 8.3 de Windows (C:\Users\KENDOR~1\...).
 *
 * Hace falta porque el ejecutable portable se extrae en %TEMP%, y en una cuenta
 * cuyo nombre lleva espacios Windows entrega esa ruta en forma corta. Entonces
 * la direccion que reporta la ventana y la que se calcula desde __dirname
 * apuntan al mismo archivo pero como texto no coinciden, y la comprobacion de
 * ventana de confianza rechazaba peticiones legitimas: «Mis materiales» y «Mis
 * Cursos» dejaban de funcionar para esos usuarios.
 *
 * Solo se normaliza la parte REAL del disco; lo que va dentro del app.asar se
 * conserva tal cual, porque ahi no hay nada que resolver.
 */
function rutaCanonica(fileUrl) {
    let ruta;
    try { ruta = fileURLToPath(fileUrl); } catch { return null; }
    const marca = path.sep + 'app.asar';
    const corte = ruta.indexOf(marca);
    const raiz = corte >= 0 ? ruta.slice(0, corte) : ruta;
    const resto = corte >= 0 ? ruta.slice(corte) : '';
    try { return path.join(fs.realpathSync.native(raiz), resto); }
    catch { return ruta; }
}

/**
 * La peticion viene de la ventana esperada, de su marco principal, y esa ventana
 * sigue mostrando exactamente la pagina autorizada. La comparacion se hace sobre
 * la ruta canonica, no sobre el texto de la direccion.
 */
function trustedSender(event, win, exactUrl) {
    if (!(win && !win.isDestroyed() && event.sender === win.webContents
        && event.senderFrame === win.webContents.mainFrame)) return false;
    const esperada = rutaCanonica(exactUrl);
    if (!esperada) return false;
    const iguales = (url) => {
        const r = rutaCanonica(url);
        return !!r && r.toLowerCase() === esperada.toLowerCase();
    };
    return iguales(event.senderFrame?.url) && iguales(win.webContents.getURL());
}

// Node HTTP never follows redirects or writes page bodies into Electron's disk cache.
function boundedRequest(url, { headers, binary = false, signal, lookup, timeoutMs = 12000 } = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
            return reject(resourceError('RESOURCE_SERVER_INVALID', 'La dirección del servidor no es válida.'));
        if (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
            return reject(resourceError('RESOURCE_HTTPS_REQUIRED', 'Los documentos protegidos requieren una conexión HTTPS.'));
        const chunks = [];
        let bytes = 0, deadline;
        const dispose = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
        const req = (parsed.protocol === 'https:' ? https : http).get(parsed, {
            headers: { ...headers, 'Cache-Control': 'no-store', Accept: binary ? 'image/png' : 'application/json' },
            timeout: timeoutMs, signal, lookup,
        }, response => {
            const max = binary ? MAX_PAGE_BYTES : 2 * 1024 * 1024;
            if (response.statusCode < 200 || response.statusCode >= 300) {
                response.resume();
                reject(resourceError('RESOURCE_ACCESS_DENIED', [401, 403, 404, 410].includes(response.statusCode)
                    ? 'El documento ya no está disponible para esta cuenta o licencia.' : 'No se pudo autorizar el documento. Inténtalo de nuevo.'));
                return;
            }
            const type = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
            if (type !== (binary ? 'image/png' : 'application/json') || Number(response.headers['content-length']) > max) {
                response.destroy(); reject(resourceError('RESOURCE_RESPONSE_INVALID', 'El servidor devolvió un documento no válido.')); return;
            }
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > max) { chunk.fill(0); dispose(); response.destroy(resourceError('RESOURCE_TOO_LARGE', 'La página supera el tamaño permitido.')); }
                else chunks.push(chunk);
            });
            response.on('error', error => { dispose(); reject(error); });
            response.on('aborted', () => { dispose(); reject(resourceError('RESOURCE_INTERRUPTED', 'La transferencia se interrumpió.')); });
            response.on('end', () => {
                clearTimeout(deadline);
                const body = Buffer.concat(chunks); dispose();
                if (binary) { resolve(body); return; }
                try { resolve(JSON.parse(body.toString('utf8'))); }
                catch { reject(resourceError('RESOURCE_RESPONSE_INVALID', 'La respuesta del servidor no es válida.')); }
                finally { body.fill(0); }
            });
        });
        deadline = setTimeout(() => req.destroy(resourceError('RESOURCE_TIMEOUT', 'Se agotó el tiempo de conexión.')), timeoutMs);
        req.on('timeout', () => req.destroy(resourceError('RESOURCE_TIMEOUT', 'Se agotó el tiempo de conexión.')));
        req.on('close', () => clearTimeout(deadline));
        req.on('error', error => { clearTimeout(deadline); dispose(); reject(error); });
    });
}

class ResourceAccess {
    constructor({ getContext, request = boundedRequest, now = () => performance.now(), onInvalidate = () => {}, lookup } = {}) {
        this.getContext = getContext; this.request = request; this.now = now;
        this.onInvalidate = onInvalidate; this.lookup = lookup; this.epoch = 0; this.active = null;
        this.abort = new AbortController();
    }
    context() {
        const value = this.getContext();
        if (!value?.allowed || typeof value.token !== 'string' || !value.token || !value.deviceId || !value.apiBase)
            throw resourceError('RESOURCE_LOGIN_REQUIRED', 'Inicia sesión y activa tu licencia para abrir el documento.');
        return { token: value.token, deviceId: value.deviceId, apiBase: value.apiBase.replace(/\/$/, '') };
    }
    sameContext(a) {
        try { const b = this.context(); return a.token === b.token && a.deviceId === b.deviceId && a.apiBase === b.apiBase; }
        catch { return false; }
    }
    invalidate(message = 'Se cerró el documento protegido.') {
        const hadActive = !!this.active;
        this.epoch++; this.active = null; this.abort.abort(); this.abort = new AbortController();
        if (hadActive) this.onInvalidate(message);
    }
    async fetch(relative, binary = false) {
        const context = this.context(), epoch = this.epoch;
        const result = await this.request(context.apiBase + relative, { binary, lookup: this.lookup,
            signal: this.abort.signal, headers: { Authorization: 'Bearer ' + context.token, 'X-Device-ID': context.deviceId } });
        if (epoch !== this.epoch || !this.sameContext(context)) {
            if (Buffer.isBuffer(result)) result.fill(0);
            throw resourceError('RESOURCE_SESSION_CHANGED', 'La sesión cambió. Vuelve a abrir el documento.');
        }
        return result;
    }
    descriptor(body, id) {
        const resource = body?.resource;
        if (!resource || resource.id?.toLowerCase() !== id || !['public', 'protected'].includes(resource.protection))
            throw resourceError('RESOURCE_RESPONSE_INVALID', 'La información del documento no es válida.');
        if (resource.protection === 'public') {
            const url = publicUrl(resource.url, this.context().apiBase);
            if (!url) throw resourceError('RESOURCE_URL_INVALID', 'El enlace público no es válido.');
            return { id, protection: 'public', url };
        }
        if (!Number.isInteger(resource.pageCount) || resource.pageCount < 1 || resource.pageCount > 200
            || !['number', 'string'].includes(typeof resource.version) || !Number.isSafeInteger(Number(resource.version)) || Number(resource.version) < 1
            || !Number.isFinite(body.leaseSeconds) || body.leaseSeconds <= 0 || body.leaseSeconds > 30
            || typeof body.watermark?.email !== 'string' || !body.watermark.email
            || typeof body.watermark?.code !== 'string' || !body.watermark.code)
            throw resourceError('RESOURCE_RESPONSE_INVALID', 'La autorización del documento está incompleta.');
        return { id, protection: 'protected', name: String(resource.name || 'Documento protegido').slice(0, 250),
            pageCount: resource.pageCount, version: String(resource.version), leaseSeconds: body.leaseSeconds,
            watermark: { email: body.watermark.email.slice(0, 254), code: body.watermark.code.slice(0, 120) } };
    }
    async open(id) {
        if (!UUID.test(id || '')) throw resourceError('RESOURCE_ID_INVALID', 'El documento no es válido.');
        this.invalidate();
        id = id.toLowerCase();
        // Count the lease from request dispatch, never from receipt after a slow network.
        const start = this.now();
        const descriptor = this.descriptor(await this.fetch('/api/resources/' + id + '/view'), id);
        if (descriptor.protection === 'protected') {
            this.active = { ...descriptor, deadline: start + descriptor.leaseSeconds * 1000, context: this.context() };
            this.assertActive();
        }
        return descriptor;
    }
    assertActive() {
        if (!this.active || this.now() >= this.active.deadline || !this.sameContext(this.active.context)) {
            this.invalidate('La autorización venció. Vuelve a abrir el documento con conexión.');
            throw resourceError('RESOURCE_LEASE_EXPIRED', 'La autorización venció. Vuelve a abrir el documento con conexión.');
        }
        return this.active;
    }
    async heartbeat() {
        const active = this.assertActive(), start = this.now(), epoch = this.epoch;
        try {
            const descriptor = this.descriptor(await this.fetch('/api/resources/' + active.id + '/view'), active.id);
            this.assertActive();
            if (this.active !== active || descriptor.protection !== 'protected' || descriptor.version !== active.version
                || descriptor.pageCount !== active.pageCount || descriptor.watermark.email !== active.watermark.email
                || descriptor.watermark.code !== active.watermark.code)
                throw resourceError('RESOURCE_VERSION_CHANGED', 'El documento cambió. Vuelve a abrirlo para ver la versión actual.');
            active.deadline = start + descriptor.leaseSeconds * 1000;
            this.assertActive();
            return { leaseSeconds: descriptor.leaseSeconds };
        } catch (error) { if (epoch === this.epoch) this.invalidate(error.message); throw error; }
    }
    async page(page) {
        const active = this.assertActive(), epoch = this.epoch;
        if (!Number.isInteger(page) || page < 1 || page > active.pageCount)
            throw resourceError('RESOURCE_PAGE_INVALID', 'La página solicitada no existe.');
        let buffer;
        try {
            buffer = await this.fetch('/api/resources/' + active.id + '/pages/' + page + '?version=' + encodeURIComponent(active.version), true);
            this.assertActive();
            if (this.active !== active || !Buffer.isBuffer(buffer) || buffer.length > MAX_PAGE_BYTES || buffer.length < 33
                || !buffer.subarray(0, 8).equals(PNG) || buffer.toString('ascii', 12, 16) !== 'IHDR')
                throw resourceError('RESOURCE_PAGE_INVALID', 'La página recibida no es válida.');
            const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
            if (!width || !height || width > 1800 || height > 1800)
                throw resourceError('RESOURCE_PAGE_INVALID', 'Las dimensiones de la página no son válidas.');
            return { page, version: active.version, png: buffer.toString('base64'),
                leaseRemainingMs: Math.max(0, active.deadline - this.now()) };
        } catch (error) { if (epoch === this.epoch) this.invalidate(error.message); throw error; }
        finally { if (Buffer.isBuffer(buffer)) buffer.fill(0); }
    }
    async catalog() { return this.fetch('/api/my-catalog'); }
}

module.exports = { ResourceAccess, boundedRequest, publicUrl, parseResourceLink, supportedProtection, trustedSender, MAX_PAGE_BYTES };
