'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createResourceWindows } = require('../resource-window');
const ID = '845ad03d-adef-4a71-b512-c01397518923';
const descriptor = () => ({ resource: { id: ID, name: 'Test PDF', protection: 'protected', pageCount: 2, version: 1 }, watermark: { email: 'test@example.invalid', code: 'TEST' }, leaseSeconds: 30 });
function fixture({ platform = 'win32', release = '10.0.22631', response = descriptor(), request: customRequest } = {}) {
    const handles = new Map(), listeners = new Map(), instances = [], opened = [];
    const ipcMain = { handle: (name, callback) => handles.set(name, callback), on: (name, callback) => listeners.set(name, callback) };
    const partition = new EventEmitter(); partition.clearCache = async () => {};
    partition.setPermissionRequestHandler = fn => { partition.permission = fn; };
    partition.setPermissionCheckHandler = fn => { partition.permissionCheck = fn; };
    partition.webRequest = { onBeforeRequest: fn => { partition.request = fn; } };
    class Window extends EventEmitter {
        constructor(options) {
            super(); this.options = options; this.dead = false; this.webContents = new EventEmitter();
            this.webContents.mainFrame = { url: '' }; this.webContents.getURL = () => this.webContents.mainFrame.url;
            this.webContents.session = partition; this.webContents.send = (name, body) => { this.lastMessage = { name, body }; };
            this.webContents.setWindowOpenHandler = fn => { this.newWindow = fn; }; instances.push(this);
        }
        setContentProtection(value) { this.protected = value; }
        setMenu(value) { this.menu = value; }
        isDestroyed() { return this.dead; }
        destroy() { this.dead = true; this.emit('closed'); }
        show() { this.shown = true; }
        async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; this.emit('ready-to-show'); }
    }
    const main = new Window({}); main.webContents.mainFrame.url = pathToFileURL(path.resolve(__dirname, '../renderer/index.html')).href;
    const requests = [];
    const controller = createResourceWindows({ BrowserWindow: Window, ipcMain, shell: { openExternal: async url => opened.push(url) },
        getMainWindow: () => main, getContext: () => ({ allowed: true, token: 'private-token', deviceId: 'fixed-device', apiBase: 'https://qa.example' }),
        platform, release, request: customRequest || (async (...args) => { requests.push(args); return response; }) });
    const event = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
    return { handles, listeners, instances, partition, controller, main, opened, requests, event };
}

test('protected native window has no broad preload, persistent cache, tools, plugins, or permissive navigation', async () => {
    const f = fixture();
    try {
        assert.equal((await f.controller.open(ID)).ok, true); const win = f.instances[1], prefs = win.options.webPreferences;
        assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
        assert.equal(prefs.devTools, false); assert.equal(prefs.webviewTag, false); assert.equal(prefs.plugins, false);
        assert.ok(!prefs.partition.startsWith('persist:')); assert.ok(prefs.preload.endsWith('resource-preload.js'));
        assert.equal(win.protected, true); assert.equal(win.menu, null); assert.equal(win.shown, true);
        assert.deepEqual(win.newWindow(), { action: 'deny' });
        for (const name of ['will-navigate', 'will-frame-navigate', 'will-attach-webview', 'context-menu']) {
            let prevented = false; win.webContents.emit(name, { preventDefault() { prevented = true; } }); assert.equal(prevented, true, name);
        }
    } finally { f.controller.invalidate(); }
});
test('resource IPC cannot be invoked from auth/main renderer, subframe, or changed page', async () => {
    const f = fixture();
    try {
        await f.controller.open(ID); const win = f.instances[1];
        assert.equal(f.handles.get('resource-descriptor')(f.event(f.main)).code, 'RESOURCE_WINDOW_DENIED');
        assert.equal(f.handles.get('resource-descriptor')({ ...f.event(win), senderFrame: { url: win.webContents.getURL() } }).code, 'RESOURCE_WINDOW_DENIED');
        const response = f.handles.get('resource-descriptor')(f.event(win)); assert.equal(response.ok, true);
        assert.ok(!JSON.stringify(response).includes('private-token')); assert.ok(!JSON.stringify(response).includes('fixed-device'));
        win.webContents.mainFrame.url += '?x=1'; assert.equal(f.handles.get('resource-descriptor')(f.event(win)).code, 'RESOURCE_WINDOW_DENIED');
    } finally { f.controller.invalidate(); }
});
test('document renderer cannot use catalogue or public-open privileged IPC', async () => {
    const f = fixture();
    try {
        await f.controller.open(ID); const win = f.instances[1];
        assert.equal((await f.handles.get('resource-catalog')(f.event(win))).code, 'RESOURCE_WINDOW_DENIED');
        assert.equal((await f.handles.get('resource-open-public')(f.event(win), 'https://example.test')).code, 'RESOURCE_WINDOW_DENIED');
        assert.equal(f.opened.length, 0);
    } finally { f.controller.invalidate(); }
});
test('protected window denies external requests, other local files, downloads and device permissions', async () => {
    const f = fixture();
    try {
        await f.controller.open(ID); const win = f.instances[1];
        for (const url of ['https://example.test/a', 'file:///C:/private.txt', 'blob:opaque']) {
            let result; f.partition.request({ url }, value => { result = value; }); assert.equal(result.cancel, true);
        }
        let result; f.partition.request({ url: win.webContents.getURL() }, value => { result = value; }); assert.equal(result.cancel, false);
        let permission; f.partition.permission(null, 'media', allowed => { permission = allowed; }); assert.equal(permission, false);
        assert.equal(f.partition.permissionCheck(), false);
        let cancelled = 0; f.partition.emit('will-download', { preventDefault() { cancelled++; } }, { cancel() { cancelled++; } }); assert.equal(cancelled, 2);
    } finally { f.controller.invalidate(); }
});
test('print/save shortcuts are blocked while page navigation remains usable', async () => {
    const f = fixture();
    try {
        await f.controller.open(ID); const win = f.instances[1];
        for (const input of [{ key: 'p', control: true }, { key: 's', control: true }, { key: 'F12' }, { key: 'PrintScreen' }]) {
            let prevented = false; win.webContents.emit('before-input-event', { preventDefault() { prevented = true; } }, input); assert.equal(prevented, true);
        }
        let prevented = false; win.webContents.emit('before-input-event', { preventDefault() { prevented = true; } }, { key: 'ArrowRight' }); assert.equal(prevented, false);
    } finally { f.controller.invalidate(); }
});
test('logout/revocation invalidation destroys the protected window and denies late IPC', async () => {
    const f = fixture(); await f.controller.open(ID); const win = f.instances[1];
    f.controller.invalidate('Licencia revocada'); assert.equal(win.dead, true);
    assert.equal(win.lastMessage.name, 'resource-invalidated'); assert.equal(win.lastMessage.body, 'Licencia revocada');
    assert.equal(f.handles.get('resource-descriptor')(f.event(win)).code, 'RESOURCE_WINDOW_DENIED');
    assert.equal(f.partition.listenerCount('will-download'), 0);
});
test('unsupported platform never opens protected window or silently downloads PDF', async () => {
    const f = fixture({ platform: 'darwin', release: '24.0.0' });
    assert.equal((await f.controller.open(ID)).code, 'RESOURCE_PLATFORM_UNSUPPORTED'); assert.equal(f.instances.length, 1); assert.equal(f.opened.length, 0);
});
test('public mode opens a browser URL even on platforms without protected viewing', async () => {
    const f = fixture({ platform: 'linux', response: { resource: { id: ID, protection: 'public', url: 'https://example.test/free.pdf' } } });
    assert.equal((await f.controller.open(ID)).public, true); assert.deepEqual(f.opened, ['https://example.test/free.pdf']); assert.equal(f.instances.length, 1);
});
test('unknown windows cannot close a different reader session', async () => {
    const f = fixture();
    try {
        await f.controller.open(ID); const win = f.instances[1];
        f.listeners.get('resource-close')(f.event(f.main)); assert.equal(win.dead, false);
        f.listeners.get('resource-close')(f.event(win)); assert.equal(win.dead, true);
    } finally { f.controller.invalidate(); }
});
test('concurrent page IPC is limited without releasing another request lock', async () => {
    let release;
    const f = fixture({ request: async url => url.includes('/pages/') ? new Promise(resolve => { release = resolve; }) : descriptor() });
    try {
        await f.controller.open(ID); const win = f.instances[1], event = f.event(win);
        const first = f.handles.get('resource-page')(event, 1);
        assert.equal((await f.handles.get('resource-page')(event, 2)).code, 'RESOURCE_BUSY');
        assert.equal((await f.handles.get('resource-page')(event, 2)).code, 'RESOURCE_BUSY');
        f.controller.invalidate(); release(Buffer.alloc(40)); await first;
    } finally { f.controller.invalidate(); }
});
