'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/resource-viewer.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const nodes = new Map(), images = [], timers = [], drawn = [];
    const context2d = { clearRect() { drawn.length = 0; }, drawImage(image) { drawn.push(image); } };
    function node(id) {
        if (!nodes.has(id)) nodes.set(id, { id, textContent: '', width: 0, height: 0, disabled: false, value: '1', style: {}, children: [], events: {},
            getContext: () => context2d, appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
            addEventListener(name, callback) { this.events[name] = callback; } });
        return nodes.get(id);
    }
    let clock = 0, pending = null, closed = 0, descriptorHandler, pageHandler, invalidated, lease;
    const api = {
        descriptor: () => descriptorHandler(), page: number => pageHandler(number), close: () => { closed++; },
        onInvalidate: cb => { invalidated = cb; }, onLease: cb => { lease = cb; },
    };
    descriptorHandler = async () => ({ ok: true, resource: { name: 'PDF', pageCount: 2, version: '1' }, watermark: { email: 'user@example.invalid', code: 'U123' }, leaseRemainingMs: 30000 });
    pageHandler = async number => ({ ok: true, page: number, version: '1', png: 'YWJj' });
    const win = { edulockDocument: api, innerWidth: 1000, events: {}, addEventListener(name, cb) { this.events[name] = cb; } };
    const sandbox = { window: win, document: { getElementById: node, createElement: name => ({ name }), addEventListener() {} },
        performance: { now: () => clock }, setInterval: callback => timers.push(callback),
        Image: class { constructor() { this.naturalWidth = 1200; this.naturalHeight = 1600; this.src = ''; images.push(this); } } };
    return { node, images, timers, drawn, win, start: () => vm.runInNewContext(source, sandbox), clock: value => { clock = value; },
        invalidate: message => invalidated(message), lease: value => lease(value),
        descriptor: fn => { descriptorHandler = fn; }, page: fn => { pageHandler = fn; }, get closed() { return closed; } };
}
test('renderer displays authorized image, page navigation, and user watermark', async () => {
    const f = fixture(); f.start(); await flush(); f.images[0].onload();
    assert.equal(f.drawn.length, 1); assert.equal(f.node('page').width, 1200);
    assert.equal(f.node('page-label').textContent, 'Página 1 de 2'); assert.equal(f.node('next').disabled, false);
    assert.equal(f.node('watermarks').children.length, 8); assert.equal(f.node('identity').textContent, 'user@example.invalid · U123');
    assert.equal(f.images[0].src, '');
    f.node('next').events.click(); await flush(); f.images[1].onload();
    assert.equal(f.node('page-label').textContent, 'Página 2 de 2'); assert.equal(f.node('next').disabled, true);
});
test('revocation immediately erases displayed canvas, identifiers and controls', async () => {
    const f = fixture(); f.start(); await flush(); f.images[0].onload();
    f.invalidate('Licencia revocada'); assert.equal(f.node('page').width, 0); assert.equal(f.drawn.length, 0);
    assert.equal(f.node('identity').textContent, ''); assert.equal(f.node('watermarks').children.length, 0);
    assert.equal(f.node('status').textContent, 'Licencia revocada'); assert.equal(f.node('next').disabled, true);
});
test('pending image decode cannot redraw after revocation', async () => {
    const f = fixture(); f.start(); await flush(); const image = f.images[0], callback = image.onload;
    f.invalidate('Cerrado'); callback(); assert.equal(f.drawn.length, 0); assert.equal(f.node('page').width, 0); assert.equal(image.src, '');
});
test('pending page response is ignored after close without allocating an image', async () => {
    const f = fixture(); let resolve; f.page(() => new Promise(done => { resolve = done; }));
    f.start(); await flush(); f.invalidate('Cerrado'); resolve({ ok: true, page: 1, version: '1', png: 'YWJj' }); await flush();
    assert.equal(f.images.length, 0); assert.equal(f.node('page').width, 0);
});
test('closing before descriptor resolves prevents page request and watermark leak', async () => {
    const f = fixture(); let resolve, requested = false;
    f.descriptor(() => new Promise(done => { resolve = done; })); f.page(async () => { requested = true; });
    f.start(); f.invalidate('Cerrado'); resolve({ ok: true, resource: { pageCount: 1 }, leaseRemainingMs: 30000 }); await flush();
    assert.equal(requested, false); assert.equal(f.node('identity').textContent, '');
});
test('expired lease clears screen and closes native viewer', async () => {
    const f = fixture(); f.start(); await flush(); f.images[0].onload(); f.clock(30000); f.timers[0]();
    assert.equal(f.node('page').width, 0); assert.equal(f.closed, 1);
});
test('a late heartbeat cannot revive expired protected content', async () => {
    const f = fixture(); f.start(); await flush(); f.images[0].onload(); f.clock(31000); f.lease(30000);
    assert.equal(f.node('page').width, 0); assert.equal(f.node('next').disabled, true);
});
test('version mismatch erases old screen and refuses received bytes', async () => {
    const f = fixture(); f.page(async page => ({ ok: true, page, version: '2', png: 'YWJj' })); f.start(); await flush();
    assert.equal(f.images.length, 0); assert.equal(f.node('page').width, 0); assert.equal(f.node('next').disabled, true);
});
test('network error clears document instead of retaining last readable page', async () => {
    const f = fixture(); f.start(); await flush(); f.images[0].onload();
    f.page(async () => { throw new Error('offline'); }); f.node('next').events.click(); await flush();
    assert.equal(f.node('page').width, 0); assert.equal(f.drawn.length, 0); assert.match(f.node('status').textContent, /conexión/);
});
test('failed image decoding clears protected state and shows a useful error', async () => {
    const f = fixture(); f.start(); await flush(); f.images[0].onerror();
    assert.equal(f.node('page').width, 0); assert.match(f.node('status').textContent, /mostrar la página/);
});
