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

test('class link is shown inline with an open link and refreshed list when native dialogs are unavailable', async () => {
    const nodes = new Map(); let refreshed = 0;
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', href: '', hidden: true, classList: { remove() { node(id).hidden = false; } } });
        return nodes.get(id);
    };
    const context = vm.createContext({ $: node, URL, location: { origin: 'https://qa.example.invalid' },
        prompt: forbiddenNativeDialog, alert: forbiddenNativeDialog, confirm: forbiddenNativeDialog,
        api: async () => ({ sublink: 'https://qa.example.invalid/cover/synthetic-code' }),
        loadVideos: async () => { refreshed++; }, message: () => {} });
    vm.runInContext(source('productor', 'mkSublink'), context);
    const button = { disabled: false };
    await context.mkSublink('synthetic-video', button);
    assert.equal(node('video-link').value, 'https://qa.example.invalid/cover/synthetic-code');
    assert.equal(node('video-link-open').href, node('video-link').value);
    assert.equal(node('video-link-result').hidden, false);
    assert.equal(refreshed, 1); assert.equal(button.disabled, false);
});

test('copying the class link reports clipboard success or selects text without claiming a failed copy', async () => {
    let copied, selected = 0; const messages = [];
    const input = { value: 'https://qa.example.invalid/cover/synthetic', focus() {}, select() { selected++; } };
    const context = vm.createContext({ $: () => input, navigator: { clipboard: { writeText: async value => { copied = value; } } },
        message: (_id, text) => messages.push(text) });
    vm.runInContext(source('productor', 'copyVideoLink'), context);
    await context.copyVideoLink(); assert.equal(copied, input.value); assert.equal(messages.at(-1), 'Enlace copiado.');
    context.navigator.clipboard = undefined;
    await context.copyVideoLink(); assert.equal(selected, 1); assert.match(messages.at(-1), /Ctrl\+C/);
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
