const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8').replace(/\r\n/g, '\n');
const start = html.indexOf('async function loginAdminWithPassword(');
const end = html.indexOf('\n}', start);
assert.ok(start >= 0 && end > start);
const source = html.slice(start, end + 2);
function harness({ status = 200, body = { token:'synthetic-admin-token' }, firebase = true, networkError = false, admin = true } = {}) {
    const calls = [], saved = [], shown = [];
    const context = vm.createContext({ TOKEN:null,
        fetch:async (url, options) => {
            calls.push({ kind:'backend', url, body:JSON.parse(options.body) });
            if (networkError) throw new Error('offline');
            return { status, ok:status >= 200 && status < 300, json:async () => body };
        },
        _fbAuth:firebase ? { signInWithEmailAndPassword:async (username,password) => {
            calls.push({ kind:'firebase', username,password }); return { user:{ uid:'synthetic-user' } };
        } } : null,
        _loginWithFirebaseUser:async user => { calls.push({ kind:'firebase-backend', uid:user.uid }); return true; },
        parseJwt:token => token ? { admin, sub:'test-admin' } : {},
        saveToken:token => saved.push(token), showApp:payload => shown.push(payload)
    });
    vm.runInContext(source, context);
    return { login:context.loginAdminWithPassword, context, calls, saved, shown };
}
test('local administrator login succeeds without calling Firebase', async () => {
    const h = harness();
    assert.equal(await h.login('qa@edulock.invalid','synthetic-test-password'), true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, '/api/auth/admin-login');
    assert.equal(h.calls[0].body.username, 'qa@edulock.invalid');
    assert.equal(h.saved.length, 1); assert.equal(h.shown.length, 1);
    assert.equal(h.context.TOKEN, 'synthetic-admin-token');
});
test('only a credential 401 invokes the existing Firebase sign-in and exchange', async () => {
    const h = harness({ status:401, body:{ error:'Credenciales incorrectas' } });
    assert.equal(await h.login('qa@edulock.invalid','synthetic-test-password'), true);
    assert.deepEqual(h.calls.map(item => item.kind), ['backend','firebase','firebase-backend']);
    assert.equal(h.calls[1].username, 'qa@edulock.invalid');
    assert.equal(h.saved.length, 0);
});
test('permission, rate limit, and server errors never forward credentials to Firebase', async () => {
    for (const status of [400,403,429,500,503]) {
        const h = harness({ status, body:{ error:'Rejected' } });
        await assert.rejects(h.login('qa@edulock.invalid','synthetic-test-password'), /Rejected/);
        assert.equal(h.calls.length, 1); assert.equal(h.saved.length, 0);
    }
});
test('a network failure does not trigger a second authentication request', async () => {
    const h = harness({ networkError:true });
    await assert.rejects(h.login('qa@edulock.invalid','synthetic-test-password'), /offline/);
    assert.equal(h.calls.length, 1);
});
test('a local account can sign in when the Firebase SDK is unavailable', async () => {
    const h = harness({ firebase:false });
    assert.equal(await h.login('local-admin','synthetic-test-password'), true);
    assert.equal(h.shown.length, 1);
});
test('an invalid local response or non-admin token cannot open the panel', async () => {
    for (const config of [{ body:{} }, { admin:false }]) {
        const h = harness(config);
        await assert.rejects(h.login('qa@edulock.invalid','synthetic-test-password'), /sesión válida/);
        assert.equal(h.saved.length, 0); assert.equal(h.shown.length, 0); assert.equal(h.calls.length, 1);
    }
});
test('missing Firebase after a 401 gives an actionable error and all scripts compile', async () => {
    const h = harness({ status:401, firebase:false });
    await assert.rejects(h.login('qa@edulock.invalid','synthetic-test-password'), /Firebase no está disponible/);
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
});
