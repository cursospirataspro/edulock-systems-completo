'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { MAX_BYTES } = require('./resource-storage');
const error = (code, status = 400) => Object.assign(new Error({
    PDF_INVALID: 'El archivo no es un PDF válido o no se pudo procesar.',
    PDF_PAGE_LIMIT: 'El PDF puede tener como máximo 200 páginas.',
    PDF_PASSWORD_UNSUPPORTED: 'Sube una copia del PDF sin contraseña de apertura.',
    PDF_BUSY: 'Hay otros documentos procesándose. Intenta de nuevo en unos segundos.',
    PDF_TIMEOUT: 'El PDF tardó demasiado en procesarse. Revisa el archivo e intenta de nuevo.',
    PDF_RUNTIME_UNAVAILABLE: 'El servicio de documentos todavía no está disponible.',
    PDF_PAGE_INVALID: 'La página solicitada no existe.',
    PDF_DIMENSIONS_INVALID: 'El tamaño de página de este PDF no está admitido.',
    PDF_PAGE_TOO_LARGE: 'No se pudo mostrar esta página por su tamaño.',
    PDF_PROCESS_FAILED: 'El servicio de documentos se interrumpió. Intenta de nuevo.'
}[code] || 'No se pudo procesar el PDF.'), { code, status });

function createPdfRenderer({ concurrency = 2, timeoutMs = 30000, workerFile = path.join(__dirname, 'pdf-render-worker.js') } = {}) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new TypeError('PDF concurrency must be between 1 and 4.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('PDF timeout must be between 1 and 60000 ms.');
    let active = 0;
    function run(operation, bytes, page, watermark) {
        if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES || bytes.length < 8 || bytes.subarray(0, 1024).indexOf('%PDF-') < 0) return Promise.reject(error('PDF_INVALID'));
        if (active >= concurrency) return Promise.reject(error('PDF_BUSY', 503));
        active++;
        return new Promise((resolve, reject) => {
            let settled = false, timer, child, result = null, failure = null, exitCode = null, exited = false;
            // The PDF process receives the job, never the server's SQL, Firebase,
            // JWT or storage credentials. Native canvas failure cannot crash the
            // HTTP server because there is no shared V8/native process lifetime.
            const childEnv = {};
            for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
                if (process.env[name] !== undefined) childEnv[name] = process.env[name];
            }
            try { child = fork(workerFile, [], { execPath: process.execPath, serialization: 'advanced',
                execArgv: ['--max-old-space-size=192', '--stack-size=4096'],
                env: childEnv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }); }
            catch { active--; reject(error('PDF_RUNTIME_UNAVAILABLE', 503)); return; }
            const finish = () => {
                if (settled) return;
                settled = true; clearTimeout(timer);
                active--;
                if (failure || !exited || exitCode !== 0 || !result) {
                    if (result?.png) result.png.fill(0);
                    reject(failure || error('PDF_PROCESS_FAILED', 503));
                } else resolve(result);
            };
            const stop = cause => {
                if (!failure) failure = cause;
                // Only this newly created child is targeted. No shell, PID
                // discovery, process tree operation or unrelated process kill.
                if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch {} }
            };
            timer = setTimeout(() => stop(error('PDF_TIMEOUT', 422)), timeoutMs);
            child.on('message', value => {
                if (settled || failure) return;
                if (result) return stop(error('PDF_PROCESS_FAILED', 503));
                if (!value?.ok) {
                    const codes = new Set(['PDF_INVALID', 'PDF_PAGE_LIMIT', 'PDF_PASSWORD_UNSUPPORTED', 'PDF_RUNTIME_UNAVAILABLE', 'PDF_PAGE_INVALID', 'PDF_DIMENSIONS_INVALID', 'PDF_PAGE_TOO_LARGE']);
                    const code = codes.has(value?.code) ? value.code : 'PDF_INVALID';
                    failure = error(code, code === 'PDF_RUNTIME_UNAVAILABLE' ? 503 : 400);
                    return; // The helper disconnects and exits normally after cleanup.
                }
                if (!Number.isInteger(value.pageCount) || value.pageCount < 1 || value.pageCount > 200)
                    return stop(error('PDF_PROCESS_FAILED', 503));
                if (operation === 'render') {
                    const png = value.png;
                    if (!Buffer.isBuffer(png) || png.length < 33 || png.length > 12 * 1024 * 1024
                        || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.toString('ascii', 12, 16) !== 'IHDR'
                        || png.readUInt32BE(16) < 1 || png.readUInt32BE(16) > 1800 || png.readUInt32BE(20) < 1 || png.readUInt32BE(20) > 1800)
                        return stop(error('PDF_PROCESS_FAILED', 503));
                    result = { pageCount: value.pageCount, png };
                } else if (value.png !== undefined) stop(error('PDF_PROCESS_FAILED', 503));
                else result = { pageCount: value.pageCount };
            });
            child.once('error', () => stop(error('PDF_RUNTIME_UNAVAILABLE', 503)));
            child.once('exit', code => { exited = true; exitCode = code; });
            // close follows exit and IPC delivery; no success can be reported
            // while the helper still owns PDF/canvas resources or before exit 0.
            child.once('close', finish);
            try { child.send({ operation, bytes, page, watermark }, sendError => { if (sendError && !settled) stop(error('PDF_RUNTIME_UNAVAILABLE', 503)); }); }
            catch { stop(error('PDF_RUNTIME_UNAVAILABLE', 503)); }
        });
    }
    return { inspect: bytes => run('inspect', bytes), render: (bytes, page, options = {}) => run('render', bytes, page, options.watermark) };
}
module.exports = { createPdfRenderer };
