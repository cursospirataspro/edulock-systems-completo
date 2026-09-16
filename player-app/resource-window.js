'use strict';
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { ResourceAccess, publicUrl, supportedProtection, trustedSender } = require('./protected-resources');

function createResourceWindows({ BrowserWindow, ipcMain, shell, getMainWindow, getContext, lookup, request,
    platform = process.platform, release = os.release() }) {
    const viewerFile = path.join(__dirname, 'renderer', 'resource-viewer.html');
    const viewerUrl = pathToFileURL(viewerFile).href;
    const mainUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
    let window = null, heartbeatTimer = null, expiryTimer = null, busy = false, opening = false;
    const pageRequests = new Set();
    const access = new ResourceAccess({ getContext, lookup, request, onInvalidate: message => close(message) });
    function close(message) {
        clearInterval(heartbeatTimer); clearInterval(expiryTimer);
        heartbeatTimer = expiryTimer = null; busy = false;
        const prior = window; window = null;
        if (access.active) access.invalidate(message);
        if (prior && !prior.isDestroyed()) {
            prior.webContents.send('resource-invalidated', message || 'Documento cerrado.');
            prior.destroy();
        }
    }
    function fail(error) {
        return { ok: false, code: error.code || 'RESOURCE_UNAVAILABLE',
            error: error.code ? error.message : 'No se pudo abrir el documento. Comprueba tu conexión e inténtalo de nuevo.' };
    }
    function assertViewer(event) {
        if (!trustedSender(event, window, viewerUrl)) throw Object.assign(new Error('Ventana no autorizada.'), { code: 'RESOURCE_WINDOW_DENIED' });
    }
    function assertMain(event) {
        if (!trustedSender(event, getMainWindow(), mainUrl)) throw Object.assign(new Error('Ventana no autorizada.'), { code: 'RESOURCE_WINDOW_DENIED' });
    }
    async function open(id) {
        if (opening) return { ok: false, error: 'Espera a que termine de abrirse el documento.' };
        opening = true;
        try {
            close();
            const descriptor = await access.open(id);
            if (descriptor.protection === 'public') {
                await shell.openExternal(descriptor.url); return { ok: true, public: true };
            }
            if (!supportedProtection(platform, release)) {
                access.invalidate();
                return { ok: false, code: 'RESOURCE_PLATFORM_UNSUPPORTED', error: 'Este PDF protegido requiere Windows 10 versión 2004 o posterior, o Windows 11. Este sistema todavía no tiene un visor protegido validado.' };
            }
            const win = new BrowserWindow({ width: 1080, height: 820, minWidth: 640, minHeight: 480,
                title: descriptor.name, show: false, backgroundColor: '#101827', autoHideMenuBar: true,
                webPreferences: { preload: path.join(__dirname, 'resource-preload.js'), sandbox: true,
                    contextIsolation: true, nodeIntegration: false, devTools: false, webSecurity: true,
                    allowRunningInsecureContent: false, webviewTag: false, plugins: false,
                    partition: 'edulock-protected-documents' } });
            window = win;
            win.setContentProtection(true); win.setMenu(null);
            win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            win.webContents.on('will-navigate', event => event.preventDefault());
            win.webContents.on('will-frame-navigate', event => event.preventDefault());
            win.webContents.on('will-attach-webview', event => event.preventDefault());
            win.webContents.on('context-menu', event => event.preventDefault());
            win.webContents.on('before-input-event', (event, input) => {
                const key = String(input.key || '').toLowerCase();
                if (['f12', 'printscreen'].includes(key) || ((input.control || input.meta) && ['p', 's', 'u', 'i', 'j', 'c', 'x', 'a'].includes(key))) event.preventDefault();
            });
            // Separate nonpersistent partition; no permission, request, download, or remote navigation.
            const ses = win.webContents.session;
            ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
            ses.setPermissionCheckHandler(() => false);
            ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: ![viewerUrl,
                pathToFileURL(path.join(__dirname, 'renderer', 'resource-viewer.js')).href,
                pathToFileURL(path.join(__dirname, 'renderer', 'resource-viewer.css')).href].includes(details.url)
                && !details.url.startsWith('data:image/png;base64,') }));
            const preventDownload = (event, item) => { event.preventDefault(); item.cancel(); };
            ses.on('will-download', preventDownload);
            win.once('closed', () => {
                ses.removeListener('will-download', preventDownload);
                void ses.clearCache().catch(() => {});
                if (window === win) close();
            });
            win.webContents.on('render-process-gone', () => { if (window === win) close('El visor se cerró.'); });
            win.once('ready-to-show', () => { if (window === win) { try { access.assertActive(); win.show(); } catch { close(); } } });
            await win.loadFile(viewerFile);
            if (window !== win) return { ok: false, error: 'El documento se cerró antes de abrirse.' };
            heartbeatTimer = setInterval(async () => {
                if (busy || window !== win) return;
                busy = true;
                try { await access.heartbeat(); if (window === win) win.webContents.send('resource-lease', Math.max(0, access.active.deadline - access.now())); }
                catch { /* access invalidation closes the viewer */ }
                finally { busy = false; }
            }, 15000);
            expiryTimer = setInterval(() => { try { access.assertActive(); } catch { close(); } }, 250);
            return { ok: true };
        } catch (error) { close(); return fail(error); }
        finally { opening = false; }
    }
    ipcMain.handle('resource-catalog', async event => {
        try { assertMain(event); return { ok: true, catalog: await access.catalog() }; } catch (error) { return fail(error); }
    });
    ipcMain.handle('resource-open', async (event, id) => {
        try { assertMain(event); return await open(id); } catch (error) { return fail(error); }
    });
    ipcMain.handle('resource-open-public', async (event, value) => {
        try {
            assertMain(event); const url = publicUrl(value, getContext()?.apiBase);
            if (!url) return { ok: false, error: 'El enlace público no es válido.' };
            await shell.openExternal(url); return { ok: true };
        } catch (error) { return fail(error); }
    });
    ipcMain.handle('resource-descriptor', event => {
        try {
            assertViewer(event); const current = access.assertActive();
            return { ok: true, resource: { id: current.id, name: current.name, pageCount: current.pageCount, version: current.version },
                watermark: current.watermark, leaseRemainingMs: Math.max(0, current.deadline - access.now()) };
        } catch (error) { return fail(error); }
    });
    ipcMain.handle('resource-page', async (event, page) => {
        let requesting, registered = false;
        try {
            assertViewer(event); requesting = window;
            if (pageRequests.has(requesting)) return { ok: false, code: 'RESOURCE_BUSY', error: 'Espera a que termine de cargar la página.' };
            pageRequests.add(requesting); registered = true;
            return { ok: true, ...await access.page(page) };
        } catch (error) { return fail(error); }
        finally { if (registered) pageRequests.delete(requesting); }
    });
    ipcMain.on('resource-close', event => { if (trustedSender(event, window, viewerUrl)) close(); });
    return { open, close, invalidate: message => { access.invalidate(message); close(message); } };
}

module.exports = { createResourceWindows };
