'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createClient, createEditor, publicUrl, pdfFile, conversionWarning, MAX_PDF_BYTES } = require('../public/js/resource-editor.js');
const target = { kind: 'video', id: 'video-own / test' };
const file = { name: 'Apuntes.PDF', size: 2048 };
const publicResource = { id: 'resource-own', name: 'Apuntes', type: 'document', sourceKind: 'link', protection: 'public', version: 3, url: 'https://example.invalid/apuntes.pdf?public=1' };
const fileResource = { ...publicResource, sourceKind: 'file', url: '/resources/resource-own/download' };
class TestForm {
    constructor() { this.fields = new Map(); }
    append(key, value) { this.fields.set(key, value); }
}
function harness(replies = []) {
    const requests = []; let token = 'synthetic-token', unauthorized = 0;
    const client = createClient({ FormData: TestForm, getToken: () => token, onUnauthorized: () => unauthorized++,
        fetch: async (route, init) => {
            requests.push({ route, ...init });
            const reply = replies.shift() || {};
            if (reply.error) throw reply.error;
            return { ok: (reply.status || 200) < 400, status: reply.status || 200,
                json: async () => { if (reply.invalidJson) throw new Error('invalid JSON'); return reply.data === undefined ? { resource: publicResource } : reply.data; } };
        } });
    return { client, requests, setToken: value => { token = value; }, unauthorized: () => unauthorized };
}

test('public links preserve their original URL including query, case and escapes', async () => {
    const h = harness();
    const url = 'https://example.invalid/A%20B.PDF?File=one%2Ftwo&foo=1#Page2';
    await h.client.save(target, { name: 'Apuntes', sourceKind: 'link', protection: 'public', type: 'document', url });
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].route, '/api/resources/link');
    assert.deepEqual(JSON.parse(h.requests[0].body), { targetKind: target.kind, targetId: target.id, name: 'Apuntes', type: 'document', url });
});
test('public ZIP, video and other materials remain links and need no PDF upload', async () => {
    for (const type of ['zip', 'video', 'link']) {
        const h = harness();
        await h.client.save(target, { name: 'Material', sourceKind: 'link', protection: 'public', type, url: 'https://example.invalid/material' });
        assert.equal(JSON.parse(h.requests[0].body).type, type);
    }
});
test('an external URL cannot be labelled protected when creating a resource', async () => {
    const h = harness();
    await assert.rejects(h.client.save(target, { name: 'Apuntes', sourceKind: 'link', protection: 'protected', type: 'document', url: publicResource.url }), /adjuntar su archivo/);
    assert.equal(h.requests.length, 0);
});
test('uploads preserve the user selection for both free and protected PDFs', async () => {
    for (const protection of ['public', 'protected']) {
        const h = harness([{ data: { resource: { ...fileResource, protection } } }]);
        const saved = await h.client.save({ kind: 'module', id: 'own-module' }, { name: 'Apuntes', sourceKind: 'file', protection, file });
        assert.equal(saved.protection, protection);
        const req = h.requests[0];
        assert.equal(req.method, 'POST'); assert.equal(req.route, '/api/resources/upload');
        assert.equal(req.headers['Content-Type'], undefined, 'browser must create multipart boundary');
        assert.equal(req.body.fields.get('file'), file);
        assert.equal(req.body.fields.get('protection'), protection);
        assert.equal(req.body.fields.get('targetKind'), 'module');
    }
});
test('invalid, empty and oversized PDFs are rejected before any request', async () => {
    for (const badFile of [undefined, { name: 'material.zip', size: 20 }, { name: 'bad.pdf.exe', size: 20 }, { name: 'empty.pdf', size: 0 }, { name: 'big.pdf', size: MAX_PDF_BYTES + 1 }]) {
        const h = harness();
        await assert.rejects(h.client.save(target, { name: 'Apuntes', sourceKind: 'file', protection: 'protected', file: badFile }));
        assert.equal(h.requests.length, 0);
    }
    assert.equal(pdfFile({ name: 'limit.pdf', size: MAX_PDF_BYTES }).size, MAX_PDF_BYTES);
});
test('unsafe protocols and URL credentials never become public links', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///C:/data.pdf', '//example.invalid/a.pdf', 'https://user:secret@example.invalid/file', 'not a URL']) assert.throws(() => publicUrl(url));
    assert.equal(publicUrl('http://example.invalid/file'), 'http://example.invalid/file');
});
test('external link to protected PDF requires file, explicit acknowledgement and saved version', async () => {
    const h = harness([{ data: { resource: { ...fileResource, protection: 'protected', version: 4 } } }]);
    const input = { name: publicResource.name, protection: 'protected', file };
    await assert.rejects(h.client.save(target, input, publicResource), /Confirma/);
    assert.equal(h.requests.length, 0);
    await h.client.save(target, { ...input, confirmConversion: true }, publicResource);
    const request = h.requests[0];
    assert.equal(request.method, 'PUT'); assert.equal(request.route, '/api/resources/resource-own/file');
    assert.equal(request.body.fields.get('expectedVersion'), '3');
    assert.equal(request.body.fields.get('protection'), 'protected');
    assert.equal(request.body.fields.get('file'), file);
});
test('converting external links does not silently lose a simultaneous rename', async () => {
    const h = harness();
    await assert.rejects(h.client.save(target, { name: 'Nombre distinto', protection: 'protected', file, confirmConversion: true }, publicResource), /nuevo nombre antes/);
    assert.equal(h.requests.length, 0);
});
test('a stored public PDF converts with PATCH and never exposes a client supplied blob URL', async () => {
    const h = harness([{ data: { resource: { ...fileResource, protection: 'protected', version: 4 } } }]);
    await h.client.save(target, { name: 'Apuntes', protection: 'protected', url: 'https://attacker.invalid/replaced', confirmConversion: true }, fileResource);
    assert.equal(h.requests[0].method, 'PATCH');
    assert.deepEqual(JSON.parse(h.requests[0].body), { name: 'Apuntes', protection: 'protected', expectedVersion: 3 });
});
test('making a protected PDF public requires explicit acknowledgement and keeps the blob', async () => {
    const previous = { ...fileResource, protection: 'protected' };
    const h = harness([{ data: { resource: { ...fileResource, version: 4 } } }]);
    await assert.rejects(h.client.save(target, { name: 'Apuntes', protection: 'public' }, previous), /Confirma/);
    await h.client.save(target, { name: 'Apuntes', protection: 'public', confirmConversion: true }, previous);
    assert.deepEqual(JSON.parse(h.requests[0].body), { name: 'Apuntes', protection: 'public', expectedVersion: 3 });
    assert.match(conversionWarning(previous, 'public'), /sin licencia/);
    assert.match(conversionWarning(publicResource, 'protected'), /seguirán existiendo/);
    assert.equal(conversionWarning(publicResource, 'public'), '');
});
test('renaming a resource with unchanged protection needs no conversion acknowledgement', async () => {
    const h = harness();
    await h.client.save(target, { name: 'Nuevo nombre', protection: 'public', url: publicResource.url }, publicResource);
    assert.equal(JSON.parse(h.requests[0].body).name, 'Nuevo nombre');
});
test('stale versions produce a conflict without automatically retrying or overriding', async () => {
    const h = harness([{ status: 409, data: { error: 'conflict', code: 'RESOURCE_VERSION_CONFLICT' } }]);
    await assert.rejects(h.client.save(target, { name: 'Apuntes', protection: 'public', url: publicResource.url }, publicResource), error => error.status === 409 && /otra sesión/.test(error.message));
    assert.equal(h.requests.length, 1);
    const missingCourse = harness([{ status: 409, data: { error: 'Asigna el video a un curso antes de proteger su PDF.', code: 'RESOURCE_TARGET_WITHOUT_COURSE' } }]);
    await assert.rejects(missingCourse.client.save(target, { name: 'Apuntes', sourceKind: 'file', protection: 'protected', file }),
        error => error.code === 'RESOURCE_TARGET_WITHOUT_COURSE' && /Asigna el video a un curso/.test(error.message) && !/otra sesión/.test(error.message));
    assert.equal(missingCourse.requests.length, 1);
});
test('connection loss during upload does not claim success or duplicate the upload', async () => {
    const h = harness([{ error: new Error('network reset') }]);
    await assert.rejects(h.client.save(target, { name: 'Apuntes', sourceKind: 'file', protection: 'public', file }), /confirmar la operación/);
    assert.equal(h.requests.length, 1);
});
test('malformed or partial success bodies do not claim a saved resource', async () => {
    for (const reply of [{ invalidJson: true }, { data: {} }, { data: { resource: { id: 'id', protection: 'protected' } } }, { data: { resource: { ...fileResource, version: undefined } } }]) {
        const h = harness([reply]);
        await assert.rejects(h.client.save(target, { name: 'Apuntes', sourceKind: 'file', protection: 'protected', file }));
        assert.equal(h.requests.length, 1);
    }
});
test('forbidden producer resources do not trigger logout, while unauthenticated access does', async () => {
    const h = harness([{ status: 403, data: { error: 'No tienes permiso.' } }, { status: 401, data: { error: 'Sesión vencida.' } }]);
    await assert.rejects(h.client.list(target), /permiso/); assert.equal(h.unauthorized(), 0);
    await assert.rejects(h.client.list(target), /vencida/); assert.equal(h.unauthorized(), 1);
});
test('each request uses the current token and no request starts without a session', async () => {
    const h = harness([{ data: { resources: [], legacyDocuments: [] } }]);
    h.setToken('new-synthetic-token'); await h.client.list(target);
    assert.equal(h.requests[0].headers.Authorization, 'Bearer new-synthetic-token');
    assert.equal(h.requests[0].route, '/api/resources?targetKind=video&targetId=video-own%20%2F%20test');
    h.setToken(''); await assert.rejects(h.client.list(target), /Inicia sesión/);
    assert.equal(h.requests.length, 1);
});
test('listing keeps legacy documents separate without mutating their fields or URLs', async () => {
    const legacy = [{ name: 'Antes', url: 'https://example.invalid/old?q=1', type: 'zip', extraMetadata: 'preserve' }];
    const h = harness([{ data: { resources: [publicResource], legacyDocuments: legacy } }]);
    const result = await h.client.list(target);
    assert.deepEqual(result.legacyDocuments, legacy);
    assert.equal(h.requests[0].method, 'GET');
});
test('a partial resource list is not treated as an empty set', async () => {
    const h = harness([{ data: { resources: [] } }]);
    await assert.rejects(h.client.list(target), /incompleta/);
});
test('deletion uses expectedVersion and requires a confirmation response', async () => {
    const h = harness([{ data: { ok: true } }, { data: {} }]);
    await h.client.remove(publicResource);
    assert.equal(h.requests[0].method, 'DELETE');
    assert.deepEqual(JSON.parse(h.requests[0].body), { expectedVersion: 3 });
    await assert.rejects(h.client.remove(publicResource), /confirmar la eliminación/);
});
test('invalid target, type, name, source, protection and absent version are refused locally', async () => {
    const h = harness();
    const input = { name: 'Apuntes', sourceKind: 'link', protection: 'public', type: 'document', url: publicResource.url };
    for (const badTarget of [null, { kind: 'course', id: 'any' }, { kind: 'video', id: '' }]) await assert.rejects(h.client.save(badTarget, input));
    for (const patch of [{ name: '' }, { name: 'x'.repeat(201) }, { type: 'executable' }, { protection: 'whatever' }, { sourceKind: 'unknown' }]) await assert.rejects(h.client.save(target, { ...input, ...patch }));
    await assert.rejects(h.client.save(target, input, { ...publicResource, version: 0 }));
    assert.equal(h.requests.length, 0);
});

// Exercise the actual modal state transitions with a deliberately small DOM.
// Browser rendering and real network permissions are tested separately in QA.
function editorHarness({ listError, saveError, resources = [] } = {}) {
    const all = new Map(), calls = [], modalNodes = new Map();
    class Node {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.attrs = {}; this.listeners = new Map(); this.children = []; this.textContent = ''; this.value = ''; this.files = []; this.options = [{}, {}]; this.hidden = false; this.open = false; this.checked = false; this.disabled = false; }
        setAttribute(key, value) { this.attrs[key] = value; if (key === 'id') all.set(value, this); }
        getAttribute(key) { return this.attrs[key]; }
        append(...items) { this.children.push(...items); }
        replaceChildren(...items) { this.children = items; }
        addEventListener(type, handler) { this.listeners.set(type, handler); }
        async dispatch(type) { return this.listeners.get(type)?.({ preventDefault() {} }); }
        querySelectorAll(selector) {
            if (selector === '[data-er]') return [...modalNodes.values()];
            if (selector === 'button') return [...modalNodes.values()].filter(item => item.tagName === 'BUTTON');
            return [];
        }
        set innerHTML(value) {
            if (this.tagName !== 'DIALOG') return;
            for (const match of value.matchAll(/<([a-z]+)[^>]*data-er="([^"]+)"[^>]*>/g)) {
                const node = new Node(match[1]); node.attrs['data-er'] = match[2]; node.hidden = /\bhidden\b/.test(match[0]); modalNodes.set(match[2], node);
            }
        }
        reset() { for (const item of modalNodes.values()) { item.value = ''; item.checked = false; item.files = []; } }
        reportValidity() { return true; }
        showModal() { this.open = true; }
        close() { this.open = false; return this.dispatch('close'); }
        focus() {}
        scrollIntoView() {}
    }
    const document = { createElement: tag => new Node(tag), getElementById: id => all.get(id), head: new Node('head'), body: new Node('body'), location: { origin: 'https://example.invalid' } };
    let savedId = 0;
    const client = {
        list: async () => { if (listError) throw new Error(listError); return { resources: [...resources], legacyDocuments: [] }; },
        save: async (context, input, existing) => {
            calls.push({ context, input, existing }); if (saveError) throw typeof saveError === 'string' ? new Error(saveError) : saveError;
            return { ...fileResource, id: existing?.id || 'new-' + (++savedId), name: input.name, protection: input.protection, version: 4 };
        },
        remove: async () => ({ ok: true })
    };
    const editor = createEditor({ document, client });
    return { editor, nodes: modalNodes, calls, document, client };
}
test('new modal opens as Libre, external links cannot silently enable protection, switching to PDF still defaults Libre', async () => {
    const h = editorHarness(); await h.editor.open({ ...target, title: 'Mi clase' });
    assert.equal(h.nodes.get('protection').value, 'public');
    assert.equal(h.nodes.get('protection').options[1].disabled, true);
    h.nodes.get('source').value = 'file'; await h.nodes.get('source').dispatch('change');
    assert.equal(h.nodes.get('protection').value, 'public');
    assert.equal(h.nodes.get('protection').options[1].disabled, false);
    assert.equal(h.nodes.get('file-field').hidden, false);
    assert.equal(h.nodes.get('url-field').hidden, true);
});
test('failed list prevents mutations and remains visibly an error', async () => {
    const h = editorHarness({ listError: 'Base de datos temporalmente no disponible.' });
    await h.editor.open(target);
    assert.equal(h.nodes.get('fieldset').disabled, true);
    assert.equal(h.nodes.get('save').disabled, true);
    await h.nodes.get('form').dispatch('submit'); assert.equal(h.calls.length, 0);
    assert.match(h.nodes.get('status').textContent, /no disponible/);
});
test('a failed save keeps the chosen protection and file for review and never says saved', async () => {
    const h = editorHarness({ saveError: 'No se pudo confirmar la operación.' }); await h.editor.open(target);
    h.nodes.get('source').value = 'file'; await h.nodes.get('source').dispatch('change');
    h.nodes.get('name').value = 'Apuntes'; h.nodes.get('file').files = [file];
    h.nodes.get('protection').value = 'protected'; await h.nodes.get('protection').dispatch('change');
    await h.nodes.get('form').dispatch('submit');
    assert.equal(h.calls[0].input.protection, 'protected');
    assert.equal(h.nodes.get('protection').value, 'protected');
    assert.equal(h.nodes.get('file').files[0], file);
    assert.match(h.nodes.get('status').textContent, /No se pudo/);
    assert.equal(h.nodes.get('save').disabled, false);
});
test('successful protected upload reports server-confirmed status then resets next resource to Libre', async () => {
    const h = editorHarness(); await h.editor.open(target);
    h.nodes.get('source').value = 'file'; await h.nodes.get('source').dispatch('change');
    h.nodes.get('name').value = 'Apuntes'; h.nodes.get('file').files = [file];
    h.nodes.get('protection').value = 'protected'; await h.nodes.get('protection').dispatch('change');
    await h.nodes.get('form').dispatch('submit');
    assert.equal(h.calls.length, 1);
    assert.equal(h.nodes.get('status').textContent, 'Recurso guardado como Protegido.');
    assert.equal(h.nodes.get('protection').value, 'public');
});
test('ambiguous save disables retry until a fresh list is fetched', async () => {
    const error = new Error('No se pudo confirmar la operación. Actualiza la lista.'); error.refreshRequired = true;
    const h = editorHarness({ saveError: error }); await h.editor.open(target);
    h.nodes.get('source').value = 'file'; await h.nodes.get('source').dispatch('change');
    h.nodes.get('name').value = 'Apuntes'; h.nodes.get('file').files = [file];
    await h.nodes.get('form').dispatch('submit');
    assert.equal(h.nodes.get('save').disabled, true);
    await h.nodes.get('form').dispatch('submit'); assert.equal(h.calls.length, 1);
    await h.nodes.get('refresh').dispatch('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.nodes.get('save').disabled, false);
    assert.equal(h.nodes.get('name').value, '');
});
test('changing a public file to protected shows acknowledgement without needing a replacement PDF', async () => {
    const h = editorHarness({ resources: [fileResource] }); await h.editor.open(target);
    await h.nodes.get('list').children[0].children.at(-1).children[0].dispatch('click');
    h.nodes.get('protection').value = 'protected'; await h.nodes.get('protection').dispatch('change');
    assert.equal(h.nodes.get('warning').hidden, false);
    assert.equal(h.nodes.get('confirm-conversion').required, true);
    assert.equal(h.nodes.get('file-field').hidden, true);
    assert.match(h.nodes.get('warning-text').textContent, /copias descargadas/);
    h.nodes.get('confirm-conversion').checked = true;
    h.nodes.get('protection').value = 'public'; await h.nodes.get('protection').dispatch('change');
    assert.equal(h.nodes.get('confirm-conversion').checked, false, 'each conversion choice needs fresh consent');
});
test('external link conversion requires a PDF and prevents losing a new name in a different endpoint', async () => {
    const h = editorHarness({ resources: [publicResource] }); await h.editor.open(target);
    await h.nodes.get('list').children[0].children.at(-1).children[0].dispatch('click');
    h.nodes.get('protection').value = 'protected'; await h.nodes.get('protection').dispatch('change');
    assert.equal(h.nodes.get('file-field').hidden, false);
    assert.equal(h.nodes.get('file').required, true);
    assert.equal(h.nodes.get('url-field').hidden, true);
    assert.equal(h.nodes.get('name').readOnly, true);
    assert.equal(h.nodes.get('name').value, publicResource.name);
});
test('logout discards pending results so the next account cannot see prior resource state', async () => {
    const h = editorHarness(); await h.editor.open(target);
    let finish;
    h.client.save = async () => new Promise(resolve => { finish = resolve; });
    h.nodes.get('name').value = 'Pending account A resource';
    const pending = h.nodes.get('form').dispatch('submit');
    h.editor.invalidate();
    await h.editor.open({ kind: 'module', id: 'account-b-module', title: 'Cuenta B' });
    finish({ ...fileResource, name: 'Pending account A resource' }); await pending;
    assert.equal(h.nodes.get('context').textContent, 'Módulo: Cuenta B');
    assert.equal(h.nodes.get('status').textContent, '');
    assert.equal(h.nodes.get('list').children[0].tagName, 'P');
    assert.equal(h.nodes.get('name').value, '');
});
test('rendering a resource name as text cannot inject markup or executable links', async () => {
    const h = editorHarness({ resources: [{ ...publicResource, name: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' }] });
    await h.editor.open(target);
    const row = h.nodes.get('list').children[0];
    assert.equal(row.children[0].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(row.children.some(node => node.tagName === 'A'), false);
});
test('both panels load the shared editor before their script and all inline scripts compile', () => {
    for (const panel of ['admin', 'productor']) {
        const html = fs.readFileSync(path.join(__dirname, '..', panel + '.html'), 'utf8');
        assert.ok(html.indexOf('/js/resource-editor.js') < html.indexOf('<script>'));
        for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    }
});
test('legacy module resources are copied from server data and render untrusted names as text', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
    function functionSource(name) {
        const start = html.indexOf('function ' + name + '(');
        return html.slice(start, html.indexOf('\n}', start) + 2);
    }
    const nodes = new Map();
    const $ = id => { if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', innerHTML: '', classList: { add() {} } }); return nodes.get(id); };
    const legacy = [{ name: '<img onerror=alert(1)>', url: 'https://example.invalid/a?x=<script>', type: 'document', extraMetadata: 'keep' }];
    const context = vm.createContext({ $, _docsContext: {}, _docsList: [], _videoDocsCache: {}, allModulesCache: [{ id: 'm', documents: legacy }],
        esc: value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;') });
    vm.runInContext(functionSource('renderDocsList'), context);
    vm.runInContext(functionSource('openLegacyDocsModal'), context);
    context.openLegacyDocsModal('module', 'm', 'Module');
    assert.equal(context._docsList.length, 1);
    assert.equal(context._docsList[0].extraMetadata, 'keep');
    context._docsList[0].name = 'Updated draft'; assert.equal(legacy[0].name, '<img onerror=alert(1)>', 'unsaved edits cannot alter cached documents');
    assert.ok(!$('docs-list').innerHTML.includes('<img'));
    assert.ok(!$('docs-list').innerHTML.includes('<script>'));
    assert.match($('docs-list').innerHTML, /&lt;img/);
    assert.ok(!html.includes('onclick="openDocsModal('), 'resource names are no longer interpolated into executable inline code');
});
