'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = Object.fromEntries(['admin', 'productor'].map(name => [name,
    fs.readFileSync(path.join(__dirname, '..', name + '.html'), 'utf8').replace(/\r\n/g, '\n')]));

function functionSource(panel, name) {
    const start = source[panel].search(new RegExp('(?:async )?function ' + name + '\\('));
    assert.ok(start >= 0, name + ' exists');
    const firstLine = source[panel].slice(start).split('\n')[0];
    if (/}\s*$/.test(firstLine)) return firstLine;
    return source[panel].slice(start, source[panel].indexOf('\n}', start) + 2);
}

function producerHarness({ limit = 0, used = 150 } = {}) {
    const nodes = new Map(), messages = [], writes = [];
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', disabled: false, classList: { remove() {} } });
        return nodes.get(id);
    };
    const profile = { name: 'Synthetic producer', quotas: { maxLicenses: limit, maxDevices: 2 }, usage: { licensesUsed: used } };
    node('lic-qty').value = '2'; node('lic-course').value = 'own-course';
    const context = vm.createContext({ $: node, _me: profile, _lastKeys: [],
        message: (_id, text) => messages.push(text), loadLots: async () => {}, loadLicenseItems: async () => {},
        api: async (method, route, body) => {
            if (method === 'GET' && route === '/api/producer/me') return profile;
            assert.equal(route, '/api/producer/license/generate-bulk');
            writes.push(body); profile.usage.licensesUsed += body.quantity;
            return { keys: Array.from({ length: body.quantity }, (_, i) => 'synthetic-' + i) };
        }
    });
    for (const name of ['producerLicenseQuota', 'refreshProfile', 'genLicenses']) {
        vm.runInContext(functionSource('productor', name), context);
    }
    return { context, node, messages, writes, profile };
}

test('unlimited producer quota displays correctly and permits new lots after prior usage', async () => {
    const h = producerHarness();
    await h.context.refreshProfile();
    assert.match(h.node('hd-quota').textContent, /150 licencias generadas · Sin límite/);
    assert.match(h.node('lic-quota').textContent, /Máximo 5000 por lote/);
    assert.equal(h.node('lic-qty').max, 5000);
    assert.equal(h.node('lic-btn').disabled, false);
    await h.context.genLicenses();
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].quantity, 2);
    assert.match(h.node('hd-quota').textContent, /152 licencias generadas/);
    assert.equal(h.node('lic-btn').disabled, false);
    h.node('lic-qty').value = '5001';
    await h.context.genLicenses();
    assert.equal(h.writes.length, 1, 'unlimited quota still respects the batch size limit');
});

test('finite producer quota clamps the proposed quantity, rejects an oversized lot and disables generation at the exact cap', async () => {
    const h = producerHarness({ limit: 4, used: 3 });
    await h.context.refreshProfile();
    assert.match(h.node('hd-quota').textContent, /3\/4 licencias/);
    assert.equal(h.node('lic-qty').max, 1);
    assert.equal(h.node('lic-qty').value, '1', 'the form never proposes more than the remaining quota');
    assert.equal(h.node('lic-devices-readonly').textContent, '2');
    h.node('lic-qty').value = '2';
    await h.context.genLicenses();
    assert.equal(h.writes.length, 0);
    assert.match(h.messages.at(-1), /supera tu cuota/);
    h.node('lic-qty').value = '1';
    await h.context.genLicenses();
    assert.equal(h.writes.length, 1);
    assert.equal(Object.hasOwn(h.writes[0], 'expiresAt'), false); assert.equal(Object.hasOwn(h.writes[0], 'maxDevices'), false);
    assert.equal(h.node('lic-btn').disabled, true);
    assert.match(h.node('lic-quota').textContent, /Disponibles: 0 licencias/);
});

test('missing or malformed producer quota cannot enable unlimited generation', async () => {
    for (const limit of [null, undefined, '', false, -1, 1.5, 'oops']) {
        const h = producerHarness(); h.profile.quotas.maxLicenses = limit;
        await assert.rejects(h.context.refreshProfile(), /confirmar tu cuota/);
        await h.context.genLicenses();
        assert.equal(h.writes.length, 0);
    }
});

function adminHarness({ licenses = '0', devices = '2' } = {}) {
    const nodes = new Map(), writes = [], alerts = [];
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', style: {} });
        return nodes.get(id);
    };
    node('pr-email').value = 'synthetic@example.invalid'; node('pr-name').value = 'Synthetic';
    node('pr-maxlic').value = licenses; node('pr-maxdev').value = devices;
    const context = vm.createContext({ $: node, esc: String, alert: text => alerts.push(text), loadProducers() {},
        api: async (method, route, body) => {
            writes.push({ method, route, body });
            return { loginUrl: '/productor', email: 'synthetic@example.invalid', password: 'synthetic-only' };
        }
    });
    for (const name of ['parseProducerQuota', 'producerAdminMessage', 'createProducer']) vm.runInContext(functionSource('admin', name), context);
    return { context, writes, alerts, node };
}

test('owner form submits explicit zero unchanged and supports a finite quota', async () => {
    for (const value of ['0', '42']) {
        const h = adminHarness({ licenses: value });
        await h.context.createProducer();
        assert.equal(h.writes.length, 1);
        assert.equal(h.writes[0].body.maxLicenses, Number(value));
        assert.equal(h.writes[0].body.maxDevices, 2);
        assert.equal(h.alerts.length, 0);
    }
});

test('owner form rejects invalid quotas before creating an account', async () => {
    for (const value of ['', ' ', '-1', '2.5', '1e2', '10oops', '2147483648']) {
        const h = adminHarness({ licenses: value });
        await h.context.createProducer();
        assert.equal(h.writes.length, 0);
        assert.match(h.node('pr-msg').textContent, /número entero/);
    }
    const h = adminHarness({ devices: '0' });
    await h.context.createProducer();
    assert.equal(h.writes.length, 0);
});

test('owner quota cells retain numeric zero with the real admin escaping function', async () => {
    for (const [used, limit, expected] of [[0, 0, '0 / Sin límite'], [0, 100, '0 / 100'], [150, 0, '150 / Sin límite']]) {
        const node = { innerHTML: '' };
        const context = vm.createContext({ $: () => node, api: async () => ({ producers: [
            { id: 'synthetic', email: 'synthetic@example.invalid', maxLicenses: limit, licensesUsed: used, maxDevices: 2, studentsCount: 1, active: true }
        ] }) });
        vm.runInContext(functionSource('admin', 'esc'), context);
        vm.runInContext(functionSource('admin', 'loadProducers'), context);
        await context.loadProducers();
        const cells = [...node.innerHTML.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]);
        assert.equal(cells[2], expected);
    }
});

test('producer batch sends only course, quantity and lot name: no expiry, duration, notes or device limit', async () => {
    const h = producerHarness();
    h.node('lic-lot-name').value = '  Septiembre ';
    await h.context.genLicenses();
    assert.deepEqual(Object.keys(h.writes[0]).sort(), ['courseId', 'name', 'quantity']);
    assert.equal(h.writes[0].name, 'Septiembre');
    assert.match(h.messages.at(-1), /2 licencias creadas/);
    assert.equal(source.productor.includes('lic-expires'), false); assert.equal(source.productor.includes('lic-duration'), false);
    assert.equal(/Vencimiento|Días desde primera activación|Usa duración o fecha fija/.test(source.productor), false, 'no expiry wording remains in the producer panel');
});

test('legacy inline license list, revocation dialog and activation table no longer exist in the producer panel', () => {
    for (const name of ['revokeProducerLicense', 'requestLicenseRevocation', 'loadLicenseItems', 'loadLots', 'loadActivations', 'licenseDate', 'downloadCsv', 'producerLicenseExpiry']) {
        assert.equal(new RegExp('function ' + name + '\\(').test(source.productor), false, name + ' was removed');
    }
    assert.equal(source.productor.includes('license-revoke-dialog'), false);
    assert.equal(source.productor.includes('data-page="compradores"'), false);
    assert.ok(source.productor.includes('data-page="estudiantes"'));
});
