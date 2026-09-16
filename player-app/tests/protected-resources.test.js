'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ResourceAccess, boundedRequest, publicUrl, parseResourceLink, supportedProtection, trustedSender, MAX_PAGE_BYTES } = require('../protected-resources');
const ID = '845ad03d-adef-4a71-b512-c01397518923';
function fixture() {
    let clock = 1000, value = { allowed: true, token: 'private-session', deviceId: 'fixed-pc', apiBase: 'https://test.example' };
    const calls = [], invalidations = [];
    let descriptor = { resource: { id: ID, name: 'Lección', protection: 'protected', pageCount: 2, version: 1 }, watermark: { email: 'student@example.test', code: 'MARK123' }, leaseSeconds: 30 };
    let handler = async (url, options) => { calls.push({ url, options }); return url.includes('/pages/') ? png() : descriptor; };
    const access = new ResourceAccess({ getContext: () => value, now: () => clock, request: (...args) => handler(...args), onInvalidate: message => invalidations.push(message) });
    return { access, calls, invalidations, get descriptor() { return descriptor; }, set descriptor(v) { descriptor = v; },
        clock: v => { clock = v; }, context: v => { value = { ...value, ...v }; }, handler: v => { handler = v; } };
}
function png() {
    const buffer = Buffer.alloc(40); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
    buffer.write('IHDR', 12, 'ascii'); buffer.writeUInt32BE(1200, 16); buffer.writeUInt32BE(1600, 20); return buffer;
}

test('protected document sends credentials only to main HTTP and returns bounded page without secrets', async () => {
    const f = fixture(); const descriptor = await f.access.open(ID); const page = await f.access.page(2);
    assert.equal(descriptor.name, 'Lección'); assert.equal(page.page, 2); assert.equal(page.version, '1');
    assert.equal(f.calls[1].url, `https://test.example/api/resources/${ID}/pages/2?version=1`);
    assert.deepEqual(f.calls[1].options.headers, { Authorization: 'Bearer private-session', 'X-Device-ID': 'fixed-pc' });
    assert.ok(!JSON.stringify({ descriptor, page }).includes('private-session'));
});
test('page buffers are zeroed after transfer to the renderer', async () => {
    const f = fixture(); await f.access.open(ID); const buffer = png(); f.handler(async () => buffer);
    const page = await f.access.page(1); assert.ok(page.png); assert.ok(buffer.every(value => value === 0));
});
for (const update of [{ allowed: false }, { token: 'different-user' }, { deviceId: 'different-device' }, { apiBase: 'https://other.example' }])
    test('late page is discarded if authorization context changes: ' + Object.keys(update)[0], async () => {
        const f = fixture(); await f.access.open(ID); const buffer = png();
        f.handler(async () => { f.context(update); return buffer; });
        await assert.rejects(f.access.page(1), { code: 'RESOURCE_SESSION_CHANGED' });
        assert.equal(f.access.active, null); assert.ok(buffer.every(value => value === 0));
    });
test('closing a pending request invalidates late bytes even after session is restored', async () => {
    const f = fixture(); await f.access.open(ID); const buffer = png();
    f.handler(async () => { f.access.invalidate(); return buffer; });
    await assert.rejects(f.access.page(1), { code: 'RESOURCE_SESSION_CHANGED' }); assert.ok(buffer.every(v => v === 0));
});
test('page HTTP failure clears active lease rather than leaving a last readable page', async () => {
    const f = fixture(); await f.access.open(ID); f.handler(async () => { throw new Error('revoked'); });
    await assert.rejects(f.access.page(1), /revoked/); assert.equal(f.access.active, null); assert.equal(f.invalidations.length, 1);
});
test('a page arriving at expiry is erased and refused', async () => {
    const f = fixture(); await f.access.open(ID); const buffer = png();
    f.handler(async () => { f.clock(31000); return buffer; });
    await assert.rejects(f.access.page(1), { code: 'RESOURCE_LEASE_EXPIRED' }); assert.ok(buffer.every(v => v === 0));
});
test('lease counts network time from dispatch and cannot revive after expiry', async () => {
    const f = fixture(); f.handler(async () => { f.clock(31001); return f.descriptor; });
    await assert.rejects(f.access.open(ID), { code: 'RESOURCE_LEASE_EXPIRED' }); assert.equal(f.access.active, null);
});
test('successful heartbeat renews only the same version and identity', async () => {
    const f = fixture(); await f.access.open(ID); f.clock(16000); await f.access.heartbeat();
    assert.equal(f.access.active.deadline, 46000);
});
for (const [label, mutate] of [
    ['version', f => { f.descriptor.resource.version = 2; }],
    ['page count', f => { f.descriptor.resource.pageCount = 3; }],
    ['watermark', f => { f.descriptor.watermark.code = 'different'; }],
    ['protection', f => { f.descriptor.resource.protection = 'public'; f.descriptor.resource.url = 'https://public.example/doc.pdf'; }],
]) test('heartbeat clears view after changed ' + label, async () => {
    const f = fixture(); await f.access.open(ID); mutate(f);
    await assert.rejects(f.access.heartbeat(), { code: 'RESOURCE_VERSION_CHANGED' }); assert.equal(f.access.active, null);
});
test('heartbeat network failure invalidates, and old lease is never extended', async () => {
    const f = fixture(); await f.access.open(ID); f.handler(async () => { throw new Error('offline'); });
    await assert.rejects(f.access.heartbeat(), /offline/); assert.equal(f.access.active, null);
});
test('public resources return safe links without invoking protected page loading', async () => {
    const f = fixture(); f.descriptor = { resource: { id: ID, protection: 'public', url: 'https://public.example/doc.pdf' } };
    assert.equal((await f.access.open(ID)).protection, 'public'); assert.equal(f.access.active, null);
});
for (const url of ['javascript:alert(1)', 'file:///C:/secret.pdf', 'https://user:pass@example.test/a', 'data:application/pdf,a', '//example.test'])
    test('public URL rejects unsafe value ' + url.split(':')[0], () => assert.equal(publicUrl(url), null));
test('public URL accepts ordinary HTTP/HTTPS resources', () => {
    assert.equal(publicUrl('https://example.test/document.pdf'), 'https://example.test/document.pdf');
    assert.equal(publicUrl('http://example.test/document.pdf'), 'http://example.test/document.pdf');
});
test('local public download resolves only the exact resource UUID route against the configured origin', () => {
    assert.equal(publicUrl(`/resources/${ID}/download`, 'https://server.example/base'), `https://server.example/resources/${ID}/download`);
    for (const value of ['//evil.example/file', '/api/secrets', `/resources/${ID}/download?redirect=https://evil.example`,
        '/resources/invalid/download', `/resources/${ID}/../private/download`]) assert.equal(publicUrl(value, 'https://server.example'), null);
});
test('resource deep link has exactly one UUID and carries no credentials', () => {
    assert.equal(parseResourceLink(`edulock://resource?id=${ID}`), ID);
    assert.equal(parseResourceLink(`cdp://resource?id=${ID}`), ID, 'legacy scheme still accepted');
    for (const url of [`edulock://resource?id=${ID}&token=secret`, `edulock://resource?id=${ID}&id=${ID}`, `edulock://resource?id=${ID}#x`,
        `edulock://other?id=${ID}`, 'edulock://resource?id=../../secret', `https://resource?id=${ID}`]) assert.equal(parseResourceLink(url), null);
});
for (const page of [0, -1, 3, 1.5, '1', {}, undefined]) test('invalid page is rejected before HTTP: ' + String(page), async () => {
    const f = fixture(); await f.access.open(ID); await assert.rejects(f.access.page(page), { code: 'RESOURCE_PAGE_INVALID' }); assert.equal(f.calls.length, 1);
});
for (const [label, mutate] of [
    ['PDF bytes', () => Buffer.from('%PDF fake original')],
    ['oversize', () => Buffer.alloc(MAX_PAGE_BYTES + 1)],
    ['dimensions', () => { const p = png(); p.writeUInt32BE(1801, 16); return p; }],
]) test('reject original or malformed protected page: ' + label, async () => {
    const f = fixture(); await f.access.open(ID); const buffer = mutate(); f.handler(async () => buffer);
    await assert.rejects(f.access.page(1), { code: 'RESOURCE_PAGE_INVALID' }); assert.ok(buffer.every(v => v === 0));
});
for (const update of [{ leaseSeconds: 31 }, { leaseSeconds: 0 }, { watermark: {} }, { resource: { id: ID, protection: 'protected', pageCount: 1, version: 'x' } }])
    test('incomplete descriptor never opens a viewer ' + JSON.stringify(update), async () => {
        const f = fixture(); Object.assign(f.descriptor, update);
        await assert.rejects(f.access.open(ID), { code: 'RESOURCE_RESPONSE_INVALID' }); assert.equal(f.access.active, null);
    });
test('support policy refuses unvalidated OS and old Windows', () => {
    assert.equal(supportedProtection('win32', '10.0.19041'), true);
    assert.equal(supportedProtection('win32', '10.0.22631'), true);
    for (const [platform, release] of [['win32', '10.0.18362'], ['win32', 'unknown'], ['darwin', '24.0.0'], ['linux', '6.1.0']])
        assert.equal(supportedProtection(platform, release), false);
});
test('privileged IPC accepts only the exact window, main frame and local page', () => {
    const url = 'file:///app/renderer/resource-viewer.html', frame = { url }, webContents = { mainFrame: frame, getURL: () => url };
    const win = { webContents, isDestroyed: () => false }, event = { sender: webContents, senderFrame: frame };
    assert.equal(trustedSender(event, win, url), true);
    assert.equal(trustedSender({ ...event, sender: {} }, win, url), false);
    assert.equal(trustedSender({ ...event, senderFrame: { url } }, win, url), false);
    assert.equal(trustedSender(event, { ...win, isDestroyed: () => true }, url), false);
    assert.equal(trustedSender(event, win, url + '?extra'), false);
    assert.equal(trustedSender(event, null, url), false);
});

async function withServer(handler, callback) {
    const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await callback(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise(resolve => server.close(resolve)); }
}
test('transport refuses redirects and never forwards session to another endpoint', async () => {
    let requests = 0;
    await withServer((_req, res) => { requests++; res.writeHead(302, { Location: '/elsewhere' }); res.end(); }, async base => {
        await assert.rejects(boundedRequest(base, { headers: { Authorization: 'Bearer private' } }), { code: 'RESOURCE_ACCESS_DENIED' });
    }); assert.equal(requests, 1);
});
test('transport does not accept PDF application type as a protected page', async () => {
    await withServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end('%PDF'); }, async base => {
        await assert.rejects(boundedRequest(base, { binary: true }), { code: 'RESOURCE_RESPONSE_INVALID' });
    });
});
test('transport handles authorized JSON with no credential reflection', async () => {
    await withServer((req, res) => {
        assert.equal(req.headers.authorization, 'Bearer private'); assert.equal(req.headers['x-device-id'], 'fixed');
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"resource":"ok"}');
    }, async base => assert.deepEqual(await boundedRequest(base, { headers: { Authorization: 'Bearer private', 'X-Device-ID': 'fixed' } }), { resource: 'ok' }));
});
test('transport rejects malformed JSON and oversized declared bodies', async () => {
    for (const oversized of [false, true]) await withServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...(oversized ? { 'Content-Length': 3000000 } : {}) }); res.end('{broken');
    }, async base => await assert.rejects(boundedRequest(base), { code: 'RESOURCE_RESPONSE_INVALID' }));
});
test('remote cleartext endpoints are refused before connecting', async () => {
    await assert.rejects(boundedRequest('http://example.test/private'), { code: 'RESOURCE_HTTPS_REQUIRED' });
});
test('slow trickling responses cannot extend the absolute network deadline', async () => {
    await withServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{');
        const timer = setInterval(() => res.write(' '), 10); res.once('close', () => clearInterval(timer));
    }, async base => { await assert.rejects(boundedRequest(base, { timeoutMs: 60 }), { code: 'RESOURCE_TIMEOUT' }); });
});
