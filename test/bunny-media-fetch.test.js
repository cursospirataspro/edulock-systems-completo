'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { fetchBunnyText } = require('../lib/bunny-media-fetch');
const url = 'https://synthetic.b-cdn.net/video/playlist.m3u8?token=synthetic-private-token';

function fixture(replies) {
    const requests = [];
    const request = (target, options, callback) => {
        const entry = { target, options, destroyed: false };
        const req = new EventEmitter(); req.destroy = () => { entry.destroyed = true; };
        requests.push(entry);
        const reply = replies.shift();
        process.nextTick(() => {
            if (reply?.hang) return;
            if (reply?.error) return req.emit('error', new Error('synthetic-private-token must not appear'));
            const response = reply?.open ? new Readable({ read() {} }) : Readable.from((reply?.chunks || ['#EXTM3U']).map(Buffer.from));
            response.statusCode = reply?.status || 200; response.headers = reply?.headers || {};
            entry.response = response; callback(response);
        });
        return req;
    };
    return { request, requests };
}

test('manifest fetch reads bounded chunks and permits one same-video relative redirect', async () => {
    const f = fixture([{ status: 302, headers: { location: '720p/playlist.m3u8' } }, { chunks: ['#EXT', 'M3U\n'] }]);
    assert.equal(await fetchBunnyText(url, { request: f.request }), '#EXTM3U\n');
    assert.equal(f.requests.length, 2); assert.ok(f.requests[1].target.includes('/video/720p/playlist.m3u8'));
});

test('foreign origins, videos and redirect loops are rejected before a second unsafe request', async () => {
    for (const location of ['https://other.b-cdn.net/video/a.m3u8', '/another-video/a.m3u8', 'http://synthetic.b-cdn.net/video/a.m3u8']) {
        const f = fixture([{ status: 302, headers: { location } }]);
        await assert.rejects(fetchBunnyText(url, { request: f.request }), { code: 'BUNNY_MEDIA_REDIRECT_INVALID' });
        assert.equal(f.requests.length, 1); assert.equal(f.requests[0].destroyed, true);
    }
    const f = fixture([{ status: 302, headers: { location: 'playlist.m3u8' } }, { status: 302, headers: { location: 'playlist.m3u8' } }]);
    await assert.rejects(fetchBunnyText(url, { request: f.request }), { code: 'BUNNY_MEDIA_REDIRECT_INVALID' });
    assert.equal(f.requests.length, 2);
});

test('oversized bodies and declared lengths abort upstream without retaining arbitrary content', async () => {
    for (const reply of [{ chunks: ['12345', '67890'] }, { headers: { 'content-length': '1000' }, open: true }]) {
        const f = fixture([reply]);
        await assert.rejects(fetchBunnyText(url, { request: f.request, maxBytes: 8 }), { code: 'BUNNY_MEDIA_TOO_LARGE' });
        assert.equal(f.requests[0].destroyed, true); assert.equal(f.requests[0].response.destroyed, true);
    }
});

test('deadline destroys a connection that never responds or never completes its body', async () => {
    for (const reply of [{ hang: true }, { open: true }]) {
        const f = fixture([reply]);
        await assert.rejects(fetchBunnyText(url, { request: f.request, timeoutMs: 20 }), { code: 'BUNNY_MEDIA_TIMEOUT' });
        assert.equal(f.requests[0].destroyed, true);
    }
});

test('provider errors and invalid initial URLs never expose tokens or arbitrary response bodies', async () => {
    for (const reply of [{ status: 403, chunks: ['synthetic-private-token'] }, { error: true }]) {
        const f = fixture([reply]);
        await assert.rejects(fetchBunnyText(url, { request: f.request }), error => !error.message.includes('synthetic-private-token'));
    }
    const f = fixture([]);
    for (const target of ['http://synthetic.b-cdn.net/video/p.m3u8', 'https://other.example/video/p.m3u8', 'https://user:password@synthetic.b-cdn.net/video/p.m3u8']) {
        await assert.rejects(fetchBunnyText(target, { request: f.request }), { code: 'BUNNY_MEDIA_URL_INVALID' });
    }
    assert.equal(f.requests.length, 0);
});
