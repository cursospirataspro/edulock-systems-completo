'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { certificateDecision, parseByteRange } = require('../security-policy');
const { powershellCommand, driverProbe, unsignedDriverProbe, dllProbe } = require('../platform-probes');

test('PowerShell probes preserve Windows paths and use encoded input compatible with 5.1', () => {
    const scripts = [driverProbe(['example']), unsignedDriverProbe(), dllProbe(12345)];
    for (const script of scripts) {
        // Windows NT paths contain literal ??; actual 5.1 parsing is exercised
        // by driver-probe.test.js rather than rejecting those path characters.
        const command = powershellCommand(script);
        assert.equal(Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le'), script);
    }
    assert.ok(scripts[1].includes('\\system32\\'));
    assert.ok(scripts[2].includes('\\windows\\'));
    assert.throws(() => dllProbe('123;exit'));
});

test('TLS never overrides platform validation with unconditional acceptance', () => {
    for (const request of [
        { hostname: 'example.test', verificationResult: 'net::ERR_CERT_DATE_INVALID' },
        { hostname: 'example.test', verificationResult: 'net::ERR_CERT_COMMON_NAME_INVALID' },
        { hostname: 'example.test', isIssuedByKnownRoot: false },
        { hostname: 'example.test', isIssuedByKnownRoot: true },
    ]) assert.equal(certificateDecision(request), -3);
    assert.equal(certificateDecision({ certificate: { issuerName: 'mitmproxy' } }), -2);
});

test('EDU byte ranges include suffix, clipped end, and reject unsatisfiable ranges', () => {
    assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9, partial: true });
    assert.deepEqual(parseByteRange('bytes=5-', 10), { start: 5, end: 9, partial: true });
    assert.deepEqual(parseByteRange('bytes=5-50', 10), { start: 5, end: 9, partial: true });
    for (const range of ['bytes=-0', 'bytes=10-', 'bytes=9-2', 'junk', 'bytes=1-2,5-6']) {
        assert.equal(parseByteRange(range, 10), null);
    }
});

function renderer(fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({}) })) {
    const nodes = new Map();
    const intervals = new Map();
    const calls = { paused: 0, closed: 0, removed: 0, fetch: [] };
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, {
            id, style: {}, classList: { add() {}, remove() {} },
            addEventListener() {}, setAttribute() {}, removeAttribute() {},
            pause() { calls.paused++; }, load() {},
            remove() { calls.removed++; nodes.delete(id); },
            currentTime: 0, innerHTML: '',
        });
        return nodes.get(id);
    };
    const context = {
        console: { log() {}, warn() {}, error() {} },
        navigator: { platform: 'Win32', userAgent: '' },
        document: { getElementById: node, addEventListener() {}, body: node('body') },
        addEventListener() {}, removeEventListener() {},
        vcbPlayer: { eduClose: async () => { calls.closed++; } },
        setTimeout() {}, clearTimeout() {},
        setInterval(fn) { const id = intervals.size + 1; intervals.set(id, fn); return id; },
        clearInterval(id) { intervals.delete(id); },
        fetch: async (...args) => { calls.fetch.push(args); return fetchImpl(...args); },
        atob: text => Buffer.from(text, 'base64').toString(), URL,
    };
    context.window = context;
    const source = fs.readFileSync(path.join(__dirname, '../renderer/player.js'), 'utf8');
    const prefix = source.slice(0, source.indexOf('// ── Arranque'));
    vm.runInNewContext(prefix + '\nglobalThis.subject = { STATE, stopPlayback, startHeartbeat, handleCdpPlay, apiFetch }; })();', context);
    return { ...context.subject, calls, intervals };
}

test('teardown closes all providers and clears media state while retaining login identity', async () => {
    const r = renderer();
    Object.assign(r.STATE, { auth: 'identity', mediaToken: 'old-media', linkAuth: 'old-link', _eduId: 'old-edu', sessionId: 'session', videoId: 'video' });
    r.STATE.hls = { destroy() { r.calls.hlsDestroyed = true; } };
    r.stopPlayback();
    assert.equal(r.STATE.auth, 'identity');
    assert.equal(r.STATE.mediaToken, '');
    assert.equal(r.STATE.linkAuth, '');
    assert.equal(r.STATE.sessionId, '');
    assert.equal(r.STATE._eduId, '');
    assert.equal(r.calls.hlsDestroyed, true);
    assert.ok(r.calls.paused > 0);
    assert.equal(r.calls.closed, 1);
    assert.ok(r.calls.removed > 0);
    assert.ok(r.calls.fetch.some(([url, opts]) => url.endsWith('/api/session/end') && JSON.parse(opts.body).mediaToken === 'old-media'));
});

test('a stale resolve cannot start media after teardown', async () => {
    let resolveFetch;
    const r = renderer(() => new Promise(resolve => { resolveFetch = resolve; }));
    Object.assign(r.STATE, { auth: 'identity', isLoggedIn: true, apiBase: 'https://local.test' });
    const pending = r.handleCdpPlay({ p: 'first' });
    r.stopPlayback();
    resolveFetch({ ok: true, json: async () => ({ videoId: 'stale', sessionToken: 'stale-token' }) });
    await pending;
    assert.equal(r.STATE.videoId, '');
    assert.equal(r.STATE.mediaToken, '');
});

test('heartbeat revocation stops playback and does not discard login identity', async () => {
    const r = renderer(async () => ({ status: 403, ok: false, json: async () => ({ revoked: true }) }));
    Object.assign(r.STATE, { auth: 'identity', sessionId: 's1', mediaToken: 'm1' });
    r.startHeartbeat();
    await [...r.intervals.values()][0]();
    assert.equal(r.STATE.sessionId, '');
    assert.equal(r.STATE.auth, 'identity');
    assert.equal(r.intervals.size, 0);
    assert.equal(r.calls.closed, 1);
});

test('legacy resolver uses link auth, other APIs retain login identity', async () => {
    const r = renderer();
    Object.assign(r.STATE, { auth: 'identity', linkAuth: 'legacy' });
    await r.apiFetch('/api/playback/resolve');
    await r.apiFetch('/api/playback/resolve-perm');
    assert.equal(r.calls.fetch[0][1].headers.Authorization, 'Bearer legacy');
    assert.equal(r.calls.fetch[1][1].headers.Authorization, 'Bearer identity');
});

test('changed JavaScript and inline auth script parse without executing the app', () => {
    for (const name of ['main.js', 'preload.js', 'activation-store.js', 'edu-native.js', 'renderer/player.js']) {
        new vm.Script(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), { filename: name });
    }
    const html = fs.readFileSync(path.join(__dirname, '../renderer/auth.html'), 'utf8');
    for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(body);
});
