'use strict';
// A one-job child process owns all PDF.js and native canvas resources. Its
// parent enforces the deadline and can discard a native crash without losing
// the HTTP server. No URL input, PDF JavaScript or attachments are executed.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function execute(workerData) {
    if (!workerData || !['inspect', 'render'].includes(workerData.operation) || !Buffer.isBuffer(workerData.bytes)
        || workerData.bytes.length < 8 || workerData.bytes.length > 25 * 1024 * 1024
        || workerData.bytes.subarray(0, 1024).indexOf('%PDF-') < 0) throw Object.assign(new Error(), { code: 'PDF_INVALID' });
    const runtime = path.join(__dirname, '..', 'pdf-runtime', 'node_modules');
    const canvasModule = require(path.join(runtime, '@napi-rs/canvas'));
    for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) if (!globalThis[name]) globalThis[name] = canvasModule[name];
    const pdfjs = await import(pathToFileURL(path.join(runtime, 'pdfjs-dist/legacy/build/pdf.mjs')).href);
    const task = pdfjs.getDocument({ data: new Uint8Array(workerData.bytes), isEvalSupported: false,
        useSystemFonts: false, disableFontFace: true, stopAtErrors: true, verbosity: 0,
        maxImageSize: 16 * 1024 * 1024, canvasMaxAreaInBytes: 48 * 1024 * 1024,
        standardFontDataUrl: path.join(runtime, 'pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/',
        cMapUrl: path.join(runtime, 'pdfjs-dist/cmaps').replaceAll('\\', '/') + '/', cMapPacked: true });
    let document;
    try {
        document = await task.promise;
        if (document.numPages < 1 || document.numPages > 200) throw Object.assign(new Error(), { code: 'PDF_PAGE_LIMIT' });
        const selected = workerData.page || 1;
        if (!Number.isInteger(selected) || selected < 1 || selected > document.numPages) throw Object.assign(new Error(), { code: 'PDF_PAGE_INVALID' });
        if (workerData.operation === 'inspect') {
            // Validate every page's dimensions; unsupported geometry fails the
            // upload rather than producing an unbounded canvas on first view.
            for (let index = 1; index <= document.numPages; index++) {
                const page = await document.getPage(index);
                const viewport = page.getViewport({ scale: 1 });
                if (![viewport.width, viewport.height].every(n => Number.isFinite(n) && n > 0 && n <= 14400)) throw Object.assign(new Error(), { code: 'PDF_DIMENSIONS_INVALID' });
                page.cleanup();
            }
            return { ok: true, pageCount: document.numPages };
        } else {
            const page = await document.getPage(selected);
            const natural = page.getViewport({ scale: 1 });
            if (![natural.width, natural.height].every(n => Number.isFinite(n) && n > 0 && n <= 14400)) throw Object.assign(new Error(), { code: 'PDF_DIMENSIONS_INVALID' });
            const scale = Math.min(2, 1800 / Math.max(natural.width, natural.height));
            const viewport = page.getViewport({ scale });
            const canvas = canvasModule.createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
            await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)' }).promise;
            if (typeof workerData.watermark === 'string' && workerData.watermark) {
                const context = canvas.getContext('2d');
                context.save();
                context.fillStyle = 'rgba(90,65,135,0.20)';
                context.font = Math.max(13, Math.floor(canvas.width / 55)) + 'px sans-serif';
                context.translate(canvas.width / 2, canvas.height / 2);
                context.rotate(-Math.PI / 12);
                const text = workerData.watermark.slice(0, 290);
                const step = Math.max(260, context.measureText(text).width + 60);
                for (let y = -canvas.height; y < canvas.height; y += 170) {
                    for (let x = -canvas.width; x < canvas.width; x += step) context.fillText(text, x, y);
                }
                context.restore();
            }
            const png = canvas.toBuffer('image/png');
            if (png.length > 12 * 1024 * 1024) throw Object.assign(new Error(), { code: 'PDF_PAGE_TOO_LARGE' });
            return { ok: true, pageCount: document.numPages, png };
        }
    } finally { if (document) await document.destroy(); else await task.destroy(); }
}

let completed = false;
process.once('disconnect', () => { if (!completed) process.exit(1); });
process.once('message', async job => {
    let result;
    try { result = await execute(job); }
    catch (e) { result = { ok: false, code: e.name === 'PasswordException' ? 'PDF_PASSWORD_UNSUPPORTED'
        : /^PDF_[A-Z_]+$/.test(e.code || '') ? e.code
        : e.code === 'MODULE_NOT_FOUND' || e.code === 'ERR_MODULE_NOT_FOUND' ? 'PDF_RUNTIME_UNAVAILABLE' : 'PDF_INVALID' }; }
    finally { if (Buffer.isBuffer(job?.bytes)) job.bytes.fill(0); }
    completed = true;
    if (!process.connected || !process.send) { process.exitCode = 1; return; }
    // execute() has already awaited document.destroy(). The send callback means
    // serialization completed, so clearing PNG memory cannot change parent data.
    process.send(result, sendError => {
        if (result.png) result.png.fill(0);
        if (sendError) process.exitCode = 1;
        if (process.connected) process.disconnect();
    });
});
