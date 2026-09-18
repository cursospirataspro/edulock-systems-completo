'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../renderer/auth.html'), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('(async () =>'));

// Exercises the complete shipped auth script and its HTML event bindings with
// synthetic Firebase/IPC boundaries. It does not claim a real browser or PC test.
async function fixture(options = {}) {
  const nodes = [], byId = new Map(), stack = [], timers = new Map(), events = new Map();
  const calls = { signIn: 0, popup: 0, created: 0, registrations: 0, sessions: [], lookups: [], success: 0, reloaded: 0, serverLogins: 0 };
  let now = 0, nextTimer = 0, activeElement = null;
  for (const token of html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, '').matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
    const tag = token[1].toLowerCase();
    if (token[0].startsWith('</')) {
      const index = stack.findLastIndex(n => n.tagName === tag);
      if (index >= 0) stack.splice(index);
      continue;
    }
    const attrs = Object.fromEntries([...token[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] ?? '']));
    const node = { tagName: tag, parent: stack.at(-1), attrs, children: [], listeners: new Map(), dataset: {},
      id: attrs.id || '', className: attrs.class || '', hidden: 'hidden' in attrs, disabled: 'disabled' in attrs,
      readOnly: 'readonly' in attrs, value: '', textContent: '', style: {},
      setAttribute(name, value) { this.attrs[name] = value; },
      addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); },
      async emit(type, extra = {}) { const event = { target: this, preventDefault() {}, ...extra }; for (const fn of this.listeners.get(type) || []) await fn(event); },
      async click() { if (this.disabled) return; await this.emit('click'); if (this.tagName === 'button' && (this.attrs.type || 'submit') === 'submit') await this.closest('form')?.emit('submit'); },
      focus() { activeElement = this; },
      closest(selector) { let current = this.parent; while (current && current.tagName !== selector) current = current.parent; return current; },
      querySelectorAll(selector) { return nodes.filter(n => { let p = n.parent; while (p && p !== this) p = p.parent; return p === this && matches(n, selector); }); }
    };
    node.classList = {
      contains(name) { return node.className.split(/\s+/).includes(name); },
      add(name) { if (!this.contains(name)) node.className += ' ' + name; },
      remove(name) { node.className = node.className.split(/\s+/).filter(c => c !== name).join(' '); }
    };
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) node.dataset[key.slice(5)] = value;
    node.parent?.children.push(node); nodes.push(node); if (node.id) byId.set(node.id, node);
    if (!['input', 'img', 'meta', 'link', 'br', 'hr', 'path'].includes(tag) && !token[0].endsWith('/>')) stack.push(node);
  }
  function matches(node, selector) {
    if (selector.includes(',')) return selector.split(',').some(s => matches(node, s.trim()));
    const tab = selector.match(/^\.tab\[data-tab="(.+)"\]$/);
    if (tab) return node.classList.contains('tab') && node.dataset.tab === tab[1];
    if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
    return node.tagName === selector;
  }
  const user = { uid: 'synthetic-firebase-uid', email: 'student@example.invalid', displayName: 'Alumno sintético',
    getIdToken: async () => 'synthetic-id-token', updateProfile: async () => {} };
  const auth = {
    currentUser: user,
    signInWithEmailAndPassword: async () => { calls.signIn++; if (options.loginError) throw { code: options.loginError }; return { user }; },
    signInWithPopup: async () => { calls.popup++; if (options.popupError) throw { code: options.popupError }; return { user }; },
    createUserWithEmailAndPassword: async () => { calls.created++; return { user }; },
    sendPasswordResetEmail: async () => {}, signOut: async () => {}
  };
  const authFactory = () => auth; authFactory.GoogleAuthProvider = function () {};
  const context = { document: { getElementById: id => byId.get(id), querySelectorAll: s => nodes.filter(n => matches(n, s)), querySelector: s => nodes.find(n => matches(n, s)) },
    console: { log() {}, error() {}, warn() {} }, location: { reload() { calls.reloaded++; } },
    addEventListener(type, callback) { events.set(type, callback); },
    setInterval(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay, next: now + delay, repeat: true }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay, next: now + delay, repeat: false }); return id; },
    clearTimeout(id) { timers.delete(id); },
    vcbPlayer: { getDeviceInfo: async () => { if (options.deviceError) throw new Error('Device unavailable'); return options.deviceInfo || { deviceId: 'synthetic-pc', deviceModel: 'PC sintético' }; },
      checkAccountStatus: async payload => { calls.lookups.push(payload); if (options.lookupError) throw new Error('Lookup unavailable'); return options.lookupResponse === undefined ? { status: 'registered', code: 'ACCOUNT_EXISTS' } : options.lookupResponse; },
      firebaseLogin: async () => { calls.serverLogins++; return options.serverLoginResponse
        ? options.serverLoginResponse(calls.serverLogins)
        : (options.response === undefined ? { status: 'approved', role: 'admin', token: 'synthetic-session' } : options.response); },
      registerRequest: async () => { calls.registrations++; return options.registrationResponse?.(calls.registrations) || { status: 'pending' }; },
      saveSession: async value => { if (options.sessionError) throw new Error('Disk unavailable'); if ('sessionResult' in options) return options.sessionResult; calls.sessions.push(value); return true; },
      clearSession: async () => {}, activationClear: async () => {}, authSuccess: () => calls.success++,
      activationHasLocal: async () => Boolean(options.activation), activationValidate: async () => ({ valid: true }),
      onLicenseRequired() {}, onLicenseRegenerated() {}
    }
  };
  if (!options.sdkUnavailable) context.firebase = { initializeApp() {}, auth: authFactory };
  context.window = context;
  await vm.runInNewContext(script, context);
  const node = id => { assert.ok(byId.has(id), id); return byId.get(id); };
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const due = [...timers.entries()].filter(([, t]) => t.next <= end).sort((a, b) => a[1].next - b[1].next)[0];
      if (!due) break;
      now = due[1].next;
      if (!due[1].repeat) timers.delete(due[0]); else due[1].next += due[1].delay;
      await due[1].fn();
    }
    now = end;
  }
  const login = async () => { node('login-email').value = user.email; node('login-pass').value = 'synthetic-password'; await node('btn-login').click(); };
  const tab = name => nodes.find(n => n.dataset.tab === name).click();
  return { node, nodes, calls, login, tab, advance, user, events, active: () => activeElement };
}

test('email and password have accessible labels; real forms submit with Enter and focus the email', async () => {
  const h = await fixture();
  for (const id of ['login-email', 'login-pass', 'reg-name', 'reg-email', 'reg-pass', 'reg-pass2', 'license-key']) {
    assert.ok(h.nodes.some(n => n.tagName === 'label' && n.attrs.for === id), id);
  }
  assert.equal(h.node('form-login').tagName, 'form');
  assert.equal(h.node('form-register').tagName, 'form');
  assert.equal(h.node('btn-login').attrs.type, 'submit');
  assert.equal(h.active().id, 'login-email');
});

test('existing approved admin signs in, persists the session, and never opens registration', async () => {
  const h = await fixture(); await h.login(); await h.advance(4000);
  assert.equal(h.calls.sessions.length, 1); assert.equal(h.calls.success, 1);
  assert.equal(h.calls.created, 0); assert.equal(h.calls.registrations, 0);
  assert.equal(h.node('form-register').classList.contains('active'), false);
});

test('an approved learner without a local license opens activation, not registration', async () => {
  const h = await fixture({ response: { status: 'approved', role: 'student', token: 'synthetic-session' } });
  await h.login(); await h.advance(4000);
  assert.equal(h.node('form-license').classList.contains('active'), true);
  assert.equal(h.node('form-register').classList.contains('active'), false);
  assert.equal(h.calls.success, 0);
});

for (const code of ['auth/invalid-credential', 'auth/invalid-login-credentials', 'auth/wrong-password', 'auth/user-not-found', 'auth/network-request-failed', 'auth/too-many-requests', 'auth/user-disabled']) {
  test(`${code} alone never proves absence or triggers automatic registration`, async () => {
    const h = await fixture({ loginError: code }); await h.login(); await h.advance(4000);
    assert.equal(h.node('form-login').classList.contains('active'), true);
    assert.equal(h.node('btn-cancel-register').hidden, true);
    assert.equal(h.calls.created, 0); assert.equal(h.calls.registrations, 0);
    assert.ok(h.node('login-status').classList.contains('error'));
  });
}

// Una respuesta del servidor que NO afirma con autoridad que la cuenta no existe
// jamas puede convertirse en una cuenta nueva. La pestana de registro solo se abre
// a mano y con los campos editables por la persona.
for (const response of [null, { status: 'pending' }, { status: 'rejected' }, { status: 'suspended' }, { status: 'wrong_device' }, { status: 'device_taken' }, { status: 'account_mismatch', error: 'Identidad inconsistente' }, { status: 'error', error: 'Base de datos no disponible' }]) {
  test(`backend ${response?.status || 'empty response'} cannot become a new account`, async () => {
    const h = await fixture({ response }); await h.login(); await h.advance(8000);
    assert.equal(h.node('form-register').classList.contains('active'), false,
      'no puede abrirse el registro por su cuenta');
    assert.equal(h.node('btn-complete-register').hidden, true);
    // Abrir la pestana a mano deja los datos editables: nada queda prefijado.
    await h.tab('register');
    assert.equal(h.node('reg-email').readOnly, false);
    assert.equal(h.calls.created, 0, 'no se crea ninguna cuenta');
    assert.equal(h.calls.registrations, 0, 'no se envia ninguna solicitud de registro');
  });
}

test('absence requires all three authoritative fields and counts down 3, 2, 1 before changing forms', async () => {
  const h = await fixture({ response: { status: 'not_registered', code: 'ACCOUNT_NOT_REGISTERED', registrationAllowed: true } });
  // El flujo vigente reintenta primero el alta automatica; la cuenta atras del
  // registro manual solo aparece si ese reintento tampoco encuentra la cuenta.
  await h.login();
  assert.match(h.node('login-status').textContent, /Registrando cuenta/);
  await h.advance(1500);
  assert.match(h.node('login-status').textContent, /3 segundos/);
  assert.equal(h.node('btn-cancel-register').hidden, false);
  await h.advance(1000); assert.match(h.node('login-status').textContent, /2 segundos/);
  await h.advance(1000); assert.match(h.node('login-status').textContent, /1 segundo/);
  assert.equal(h.node('form-register').classList.contains('active'), false);
  await h.advance(999); assert.equal(h.node('form-register').classList.contains('active'), false);
  await h.advance(1); assert.equal(h.node('form-register').classList.contains('active'), true);
  assert.equal(h.calls.created, 0); assert.equal(h.calls.registrations, 0);
});

for (const action of ['cancel', 'edit-email', 'edit-password', 'change-tab', 'unload']) {
  test(`${action} cancels the countdown without a delayed redirect`, async () => {
    const h = await fixture({ response: { status: 'not_registered', code: 'ACCOUNT_NOT_REGISTERED', registrationAllowed: true } });
    await h.login(); await h.advance(1500); await h.advance(1000);
    if (action === 'cancel') await h.node('btn-cancel-register').click();
    if (action === 'edit-email') await h.node('login-email').emit('input');
    if (action === 'edit-password') await h.node('login-pass').emit('input');
    if (action === 'change-tab') { await h.tab('register'); await h.tab('login'); }
    if (action === 'unload') h.events.get('beforeunload')();
    await h.advance(10000);
    assert.equal(h.node('form-login').classList.contains('active'), true);
    assert.equal(h.node('btn-cancel-register').hidden, true);
  });
}

for (const response of [{ status: 'not_registered' }, { status: 'not_registered', code: 'ACCOUNT_NOT_REGISTERED' }, { status: 'not_registered', registrationAllowed: true }, { status: 'not_registered', code: 'ACCOUNT_NOT_REGISTERED', registrationAllowed: 'true' }]) {
  test(`incomplete absence evidence ${JSON.stringify(response)} never redirects`, async () => {
    const h = await fixture({ response }); await h.login(); await h.advance(4000);
    assert.equal(h.node('form-login').classList.contains('active'), true);
    assert.equal(h.node('btn-cancel-register').hidden, true);
  });
}

test('an existing Firebase account offers manual completion and retains its verified email', async () => {
  const h = await fixture({ response: { status: 'registration_required', code: 'REGISTRATION_REQUIRED' } });
  await h.login(); await h.advance(4000);
  assert.equal(h.node('form-login').classList.contains('active'), true);
  assert.match(h.node('login-status').textContent, /Tu cuenta existe/);
  await h.node('btn-complete-register').click();
  assert.equal(h.node('form-register').classList.contains('active'), true);
  assert.equal(h.node('reg-email').readOnly, true);
  assert.equal(h.node('reg-email').value, h.user.email);
  assert.equal(h.node('reg-pass').closest('div').style.display, 'none');
  const altasPrevias = h.calls.serverLogins;
  await h.node('btn-register').click();
  // Completar el alta NO puede crear una segunda cuenta de Firebase: se reutiliza
  // la identidad ya verificada y solo se vuelve a intentar el alta en el servidor.
  assert.equal(h.calls.created, 0, 'no se crea otra cuenta de Firebase');
  assert.equal(h.calls.serverLogins, altasPrevias + 1, 'se reintenta el alta en el servidor');
  assert.equal(h.node('reg-email').readOnly, true, 'busy state must not unlock the authenticated email');
  await h.tab('login'); await h.tab('register');
  assert.equal(h.node('reg-email').readOnly, false);
  assert.equal(h.node('reg-pass').closest('div').style.display, '');
});

test('a failed SQL registration can retry without recreating its Firebase account', async () => {
  // El primer alta en el servidor falla; el segundo intento debe reutilizar la
  // cuenta de Firebase ya creada en vez de crear otra.
  const h = await fixture({ serverLoginResponse: n => n === 1
    ? { status: 'error', error: 'Servidor temporalmente no disponible' }
    : { status: 'approved', role: 'student', token: 'synthetic-session' } });
  await h.tab('register'); h.node('reg-name').value = 'Alumno sintético'; h.node('reg-email').value = h.user.email;
  h.node('reg-pass').value = h.node('reg-pass2').value = 'synthetic-password';
  await h.node('btn-register').click();
  assert.equal(h.calls.created, 1, 'la cuenta de Firebase se crea una vez');
  assert.equal(h.calls.serverLogins, 1);
  await h.node('btn-register').click();
  assert.equal(h.calls.created, 1, 'el reintento no puede crear una segunda cuenta de Firebase');
  assert.equal(h.calls.serverLogins, 2, 'el alta en el servidor sí se reintenta');
});

test('missing token or failed persistence cannot claim successful login', async () => {
  for (const options of [{ response: { status: 'approved', role: 'admin' } }, { sessionError: true }, { sessionResult: false }, { sessionResult: undefined }]) {
    const h = await fixture(options); await h.login(); await h.advance(4000);
    assert.equal(h.calls.success, 0); assert.equal(h.calls.sessions.length, 0);
    assert.equal(h.node('form-register').classList.contains('active'), false);
    assert.equal(h.node('login-status').classList.contains('error'), true);
  }
});

test('blocked Firebase SDK shows a recoverable connection error rather than an inert form', async () => {
  const h = await fixture({ sdkUnavailable: true });
  assert.match(h.node('login-status').textContent, /servicio de acceso/);
  assert.equal(h.node('btn-login').disabled, true);
  assert.equal(h.node('btn-retry-auth').hidden, false); assert.equal(h.node('btn-retry-auth').disabled, false);
  await h.node('btn-retry-auth').click(); assert.equal(h.calls.reloaded, 1);
});

test('only authoritative absence after ambiguous Firebase failure triggers countdown; IPC never receives a password', async () => {
  for (const loginError of ['auth/user-not-found', 'auth/invalid-credential']) {
    const h = await fixture({ loginError, lookupResponse: { status: 'not_registered', code: 'ACCOUNT_NOT_REGISTERED', registrationAllowed: true } });
    await h.login(); assert.equal(h.calls.lookups.length, 1);
    assert.deepEqual(Object.keys(h.calls.lookups[0]), ['email']);
    assert.equal(h.calls.lookups[0].email, h.user.email);
    assert.match(h.node('login-status').textContent, /Usuario no registrado.*3 segundos/);
    await h.advance(3000);
    assert.equal(h.node('form-register').classList.contains('active'), true);
    assert.equal(h.node('reg-email').value, h.user.email);
    assert.equal(h.node('reg-email').readOnly, false, 'a missing account needs normal signup credentials');
  }
});

test('wrong password, disabled account, throttling, and network failure do not ask whether an account exists', async () => {
  for (const loginError of ['auth/wrong-password', 'auth/user-disabled', 'auth/too-many-requests', 'auth/network-request-failed']) {
    const h = await fixture({ loginError, lookupResponse: { status: 'not_registered', code: 'ACCOUNT_NOT_REGISTERED', registrationAllowed: true } });
    await h.login(); await h.advance(4000);
    assert.equal(h.calls.lookups.length, 0);
    assert.equal(h.node('form-login').classList.contains('active'), true);
  }
});

test('Firebase/SQL disagreement and unavailable account verification never become automatic signup', async () => {
  for (const options of [
    { lookupResponse: { status: 'account_sync_required', code: 'ACCOUNT_SYNC_REQUIRED' } },
    { lookupResponse: { status: 'registration_required', code: 'REGISTRATION_REQUIRED' } },
    { lookupResponse: { status: 'error', code: 'ACCOUNT_LOOKUP_UNAVAILABLE' } },
    { lookupResponse: null }, { lookupError: true },
    { lookupResponse: { status: 'not_registered', code: 'ACCOUNT_NOT_REGISTERED', registrationAllowed: false } }
  ]) {
    const h = await fixture({ loginError: 'auth/invalid-credential', ...options }); await h.login(); await h.advance(4000);
    assert.equal(h.node('form-login').classList.contains('active'), true);
    assert.equal(h.node('btn-cancel-register').hidden, true);
    assert.equal(h.node('btn-complete-register').hidden, true, 'manual completion also needs authenticated ownership');
    assert.equal(h.node('login-status').classList.contains('error'), true);
    assert.equal(h.calls.created, 0); assert.equal(h.calls.registrations, 0);
  }
});

test('missing device identity prevents signup/login with an unstable generated device ID', async () => {
  for (const options of [{ deviceError: true }, { deviceInfo: {} }, { deviceInfo: { deviceId: '  ' } }]) {
    const h = await fixture(options); await h.login();
    assert.match(h.node('login-status').textContent, /identificar este dispositivo/);
    assert.equal(h.calls.signIn, 0); assert.equal(h.calls.created, 0);
    assert.equal(h.node('btn-retry-auth').hidden, false);
    assert.equal(h.node('btn-register').disabled, true);
  }
});
