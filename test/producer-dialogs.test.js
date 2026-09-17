'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = Object.fromEntries(['admin', 'productor'].map(name => [name,
    fs.readFileSync(path.join(__dirname, '..', name + '.html'), 'utf8').replace(/\r\n/g, '\n')]));
function source(panel, name) {
    const start = html[panel].search(new RegExp('(?:async )?function ' + name + '\\('));
    assert.ok(start >= 0, name);
    return html[panel].slice(start, html[panel].indexOf('\n}', start) + 2);
}
const forbiddenNativeDialog = () => { throw new Error('Native dialogs are unavailable'); };

test('the class link is returned for the popup, validated as http(s) and never written to a removed inline block', async () => {
    const context = vm.createContext({ $: () => { throw new Error('mkSublink must not touch page nodes'); }, URL, location: { origin: 'https://qa.example.invalid' },
        prompt: forbiddenNativeDialog, alert: forbiddenNativeDialog, confirm: forbiddenNativeDialog,
        api: async () => ({ sublink: 'https://qa.example.invalid/cover/synthetic-code' }), message: () => {} });
    vm.runInContext(source('productor', 'mkSublink'), context);
    const button = { disabled: false };
    assert.equal(await context.mkSublink('synthetic-video', button), 'https://qa.example.invalid/cover/synthetic-code');
    assert.equal(button.disabled, false);
    assert.equal(await context.mkSublink('synthetic-video', { disabled: true }), null, 'a busy button does not repeat the request');
    const bad = vm.createContext({ $: () => ({}), URL, location: { origin: 'https://qa.example.invalid' }, api: async () => ({ sublink: 'javascript:alert(1)' }) });
    vm.runInContext(source('productor', 'mkSublink'), bad);
    await assert.rejects(bad.mkSublink('synthetic-video', { disabled: false }), /enlace de clase válido/);
    assert.equal(html.productor.includes('copyVideoLink'), false, 'the old inline copy block is gone');
    assert.equal(html.productor.includes('Insertar portada'), false, 'the cover embed button is gone from the producer UI');
});

function dialogHarness(panel, fails = false) {
    const nodes = new Map(), listeners = new Map(), messages = [];
    const dialog = { open: false, returnValue: '',
        showModal() { if (fails) throw new Error('unavailable'); this.open = true; },
        addEventListener(event, handler) { listeners.set(event, handler); },
        removeEventListener(event) { listeners.delete(event); },
        close(value) { if (value !== undefined) this.returnValue = value; this.open = false; const handler = listeners.get('close'); listeners.delete('close'); handler?.(); }
    };
    const node = id => {
        if (id.endsWith('-dialog')) return dialog;
        if (!nodes.has(id)) nodes.set(id, { textContent: '' });
        return nodes.get(id);
    };
    const context = vm.createContext({ $: node, confirm: forbiddenNativeDialog,
        message: (_id, text) => messages.push(text), producerAdminMessage: text => messages.push(text) });
    const name = panel === 'productor' ? 'requestLicenseRevocation' : 'requestProducerAction';
    vm.runInContext(source(panel, name), context);
    const run = () => panel === 'productor' ? context[name]({ id: 'own-license', courseName: 'Own course' })
        : context[name]('Restablecer contraseña', 'Cliente sintético', 'Generar contraseña');
    return { run, dialog, messages, node };
}

// The producer panel no longer has a bespoke revocation dialog: its confirmations go through the shared
// workspace dialog (covered in producer-workspace-ui.test.js). Only the owner panel keeps this pattern.
test('HTML confirmations stay pending until an explicit choice; cancel and Escape never approve', async () => {
    for (const panel of ['admin']) {
        const h = dialogHarness(panel); let resolved = false;
        const pending = h.run().then(value => { resolved = true; return value; });
        await Promise.resolve(); assert.equal(resolved, false); assert.equal(h.dialog.open, true);
        assert.equal(await h.run(), false, 'a second action cannot reuse an open confirmation');
        h.dialog.close(); assert.equal(await pending, false, 'Escape/default closure cancels');
        const cancelled = h.run(); h.dialog.close('cancel'); assert.equal(await cancelled, false);
        const accepted = h.run(); h.dialog.close(panel === 'productor' ? 'revoke' : 'accept'); assert.equal(await accepted, true);
    }
});

test('a failed HTML dialog refuses the action without falling back to automatic approval', async () => {
    for (const panel of ['admin']) {
        const h = dialogHarness(panel, true);
        assert.equal(await h.run(), false); assert.equal(h.messages.length, 1);
        assert.match(h.messages[0], /No se pudo abrir/);
    }
});

test('owner password reset waits for confirmation and shows the new credential inline', async () => {
    let approved = false; const calls = [], nodes = new Map();
    const node = id => { if (!nodes.has(id)) nodes.set(id, { style: {}, innerHTML: '' }); return nodes.get(id); };
    const context = vm.createContext({ $: node, esc: String, alert: forbiddenNativeDialog, confirm: forbiddenNativeDialog,
        requestProducerAction: async () => approved, producerAdminMessage() {},
        api: async (...args) => { calls.push(args); return { newPassword: 'synthetic-test-password' }; } });
    vm.runInContext(source('admin', 'resetProducerPass'), context);
    await context.resetProducerPass('own-producer'); assert.equal(calls.length, 0);
    approved = true; await context.resetProducerPass('own-producer');
    assert.equal(calls.length, 1); assert.equal(calls[0][2].resetPassword, true);
    assert.equal(node('pr-new').style.display, 'block');
    assert.match(node('pr-new').innerHTML, /synthetic-test-password/);
});
