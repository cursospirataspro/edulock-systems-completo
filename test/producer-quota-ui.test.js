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
    for (const name of ['producerLicenseQuota', 'refreshProfile', 'producerLicenseExpiry', 'genLicenses']) {
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

test('finite producer quota rejects an oversized lot and disables generation at the exact cap', async () => {
    const h = producerHarness({ limit: 4, used: 3 });
    await h.context.refreshProfile();
    assert.match(h.node('hd-quota').textContent, /3\/4 licencias/);
    assert.equal(h.node('lic-qty').max, 1);
    await h.context.genLicenses();
    assert.equal(h.writes.length, 0);
    assert.match(h.messages.at(-1), /supera tu cuota/);
    h.node('lic-qty').value = '1';
    await h.context.genLicenses();
    assert.equal(h.writes.length, 1);
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

test('producer batch converts an optional local expiry to UTC and blocks a past expiry', async () => {
    const h = producerHarness();
    h.node('lic-expires').value = '2099-01-02T15:30';
    await h.context.genLicenses();
    assert.equal(h.writes[0].expiresAt, new Date('2099-01-02T15:30').toISOString());
    h.node('lic-expires').value = '';
    await h.context.genLicenses();
    assert.equal(h.writes[1].expiresAt, null);
    h.node('lic-expires').value = '2020-01-01T00:00';
    await h.context.genLicenses();
    assert.equal(h.writes.length, 2);
    assert.match(h.messages.at(-1), /vencimiento futuro/);
});

test('producer revocation requires confirmation and refreshes the license controls after success', async () => {
    let confirmed = false;
    const calls = [], messages = [];
    const context = vm.createContext({ requestLicenseRevocation: async () => confirmed, message: (_id, text) => messages.push(text),
        api: async (...args) => calls.push(args), loadLicenseItems: async () => {}, loadLots: async () => {}, loadActivations: async () => {} });
    vm.runInContext(functionSource('productor', 'revokeProducerLicense'), context);
    const license = { id: 'own-license', courseName: 'Course' }, button = { disabled: false };
    await context.revokeProducerLicense(license, button);
    assert.equal(calls.length, 0); assert.equal(button.disabled, false);
    confirmed = true;
    await context.revokeProducerLicense(license, button);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], '/api/producer/licenses/own-license/revoke');
    assert.match(messages[0], /Licencia revocada/);
    assert.equal(button.disabled, true);
});

test('a refused producer revocation does not claim success or disable retry', async () => {
    const messages = [], button = { disabled: false };
    const context = vm.createContext({ requestLicenseRevocation: async () => true, message: (_id, text) => messages.push(text),
        api: async () => { throw new Error('Licencia no encontrada'); } });
    vm.runInContext(functionSource('productor', 'revokeProducerLicense'), context);
    await context.revokeProducerLicense({ id: 'foreign-license' }, button);
    assert.equal(button.disabled, false); assert.equal(messages[0], 'Licencia no encontrada');
});

test('producer individual list renders state, expiry and bounded pagination without serials', async () => {
    const nodes = new Map(), rows = [], buttons = [], requests = [];
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', disabled: false,
            replaceChildren() { rows.length = 0; }, append(row) { rows.push(row); } });
        return nodes.get(id);
    };
    node('license-lot-filter').value = 'own-lot';
    const context = vm.createContext({ $: node, _licensePage: 1, _licenseRequest: 0,
        document: { createElement: tag => tag === 'tr' ? { innerHTML: '', children: Array.from({ length: 7 }, () => ({ append(button) { buttons.push(button); } })) } : {} },
        api: async (_method, url) => { requests.push(url); return { page: 2, pageSize: 50, total: 51, licenses: [
            { id: 'available-id', courseName: '<img src=x onerror=bad()>', status: 'free', effectiveStatus: 'expired', expiresAt: '2020-01-01T00:00:00Z', activeActivations: 0, maxDevices: 2, createdAt: '2019-01-01T00:00:00Z', license_key_hash: 'NEVER-SHOW' },
            { id: 'revoked-id', courseName: 'Course', status: 'revoked', expiresAt: null, activeActivations: 0, maxDevices: 2 }
        ] }; }, revokeProducerLicense() {}
    });
    for (const name of ['esc', 'licenseDate', 'loadLicenseItems']) vm.runInContext(functionSource('productor', name), context);
    await context.loadLicenseItems(2);
    assert.match(requests[0], /page=2&lotId=own-lot/);
    assert.match(rows[0].innerHTML, /Vencida/);
    assert.match(rows[0].innerHTML, /&lt;img/);
    assert.doesNotMatch(rows[0].innerHTML, /<img|NEVER-SHOW/);
    assert.match(rows[1].innerHTML, /Revocada/);
    assert.equal(buttons.length, 1, 'revoked licenses offer no second action');
    assert.equal(node('license-prev').disabled, false);
    assert.equal(node('license-next').disabled, true);
});
