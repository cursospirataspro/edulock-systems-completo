'use strict';
const crypto = require('node:crypto');
const { MAX_BYTES } = require('./resource-storage');
const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function resourceError(res, error) {
    const status = error.status || error.statusCode;
    return res.status(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 503).json({
        error: status ? error.message : 'No se pudo completar la operación. Intenta de nuevo.',
        code: typeof error.code === 'string' && /^(RESOURCE|PDF)_[A-Z_]+$/.test(error.code) ? error.code : 'RESOURCE_UNAVAILABLE'
    });
}
function installResourceRoutes(app, { service, multer, requireAccount, requireManager, deviceFor }) {
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 8, fieldSize: 8192, parts: 10 } }).single('file');
    let uploads = 0;
    const uploadPdf = (req, res, next) => {
        if (uploads >= 3) return res.status(503).json({ error: 'Hay otros archivos subiendo. Intenta de nuevo en unos segundos.', code: 'PDF_BUSY' });
        uploads++;
        let released = false;
        const release = () => { if (!released) { uploads--; released = true; } };
        res.once('finish', release); res.once('close', release);
        upload(req, res, err => {
            if (err) return resourceError(res, { status: 400, code: 'RESOURCE_UPLOAD_INVALID', message: err.code === 'LIMIT_FILE_SIZE' ? 'El PDF debe ocupar como máximo 25 MiB.' : 'No se pudo recibir el PDF. Selecciona un solo archivo e intenta de nuevo.' });
            if (req.file) req.file.cancelled = () => req.aborted || res.destroyed;
            next();
        });
    };
    const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { if (!res.headersSent && !res.destroyed) resourceError(res, e); } finally { if (req.file?.buffer) req.file.buffer.fill(0); } };
    app.get('/api/resources', requireManager, wrap(async (req, res) => res.json(await service.list(req.user, req.query.targetKind, req.query.targetId))));
    app.post('/api/resources/link', requireManager, wrap(async (req, res) => res.status(201).json({ resource: await service.createLink(req.user, req.body || {}) })));
    // Los documentos nuevos se agregan solo por enlace: la subida de PDF nuevos está desactivada en el
    // servidor (no solo oculta en el panel). Los PDF ya existentes se conservan y pueden reemplazarse.
    app.post('/api/resources/upload', requireManager, (req, res) => resourceError(res, { status: 410, code: 'RESOURCE_UPLOAD_DISABLED', message: 'Los documentos nuevos se agregan por enlace desde «Recursos». La subida de PDF nuevos está desactivada; los PDF ya publicados se conservan.' }));
    app.patch('/api/resources/:id', requireManager, wrap(async (req, res) => res.json({ resource: await service.edit(req.user, req.params.id, req.body || {}) })));
    app.put('/api/resources/:id/file', requireManager, uploadPdf, wrap(async (req, res) => res.json({ resource: await service.replaceFile(req.user, req.params.id, req.body || {}, req.file) })));
    app.delete('/api/resources/:id', requireManager, wrap(async (req, res) => res.json({ ok: true, resource: await service.remove(req.user, req.params.id, req.body || {}) })));
    app.get('/api/resources/:id/view', requireAccount, wrap(async (req, res) => res.json(await service.describe(req.user, req.params.id, deviceFor(req)))));
    app.get('/api/resources/:id/pages/:page', requireAccount, wrap(async (req, res) => {
        if (!/^[1-9][0-9]{0,2}$/.test(req.params.page)) return resourceError(res, { status: 404, code: 'PDF_PAGE_INVALID', message: 'La página solicitada no existe.' });
        const result = await service.page(req.user, req.params.id, deviceFor(req), Number(req.params.page), req.query.version);
        res.set('Content-Type', 'image/png'); res.set('X-Resource-Version', String(result.version));
        res.set('Cache-Control', 'no-store, private'); res.send(result.png);
    }));
    app.get('/resources/:id/download', wrap(async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const result = await service.downloadPublic(req.params.id);
        if (result.url) return res.redirect(302, result.url);
        const name = result.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').replace(/\.pdf$/i, '') + '.pdf';
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', "attachment; filename=\"documento.pdf\"; filename*=UTF-8''" + encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()));
        res.send(result.bytes);
    }));
    app.get('/resources/:id', wrap(async (req, res) => {
        const resource = await service.publicInfo(req.params.id);
        res.set('Cache-Control', 'no-store');
        if (resource.protection === 'public') return res.redirect(302, resource.url);
        const nonce = crypto.randomBytes(18).toString('base64');
        res.set('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
        res.type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(resource.name)} — Edulock</title><style nonce="${nonce}">body{margin:0;background:#101322;color:#eaeefa;font:17px system-ui;display:grid;min-height:100vh;place-items:center}main{max-width:550px;padding:36px}h1{overflow-wrap:anywhere}a{display:inline-block;background:#6555de;color:white;padding:14px 22px;border-radius:10px;text-decoration:none}p{line-height:1.6;color:#bec6dd}.secondary{background:transparent;color:#bcaeff;padding-left:0}</style><main><p>EDULOCK SYSTEMS · PDF PROTEGIDO</p><h1>${escape(resource.name)}</h1><p>Abre este documento en el reproductor e inicia sesión con la cuenta que tiene acceso al curso.</p><a href="edulock://resource?id=${encodeURIComponent(resource.id)}">Abrir en el reproductor</a><p><a class="secondary" href="/download">Obtener el reproductor</a></p></main></html>`);
    }));
}
module.exports = { installResourceRoutes, resourceError };
