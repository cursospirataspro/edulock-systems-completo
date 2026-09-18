'use strict';
// Regresiones de la auditoría: F05 (contraseña de administrador por omisión),
// F06 (documentos cifrados que desaparecían del catálogo), F07 (éxito anunciado
// antes de guardar) y R03 (TLS de PostgreSQL sin verificar).
// Las funciones de server.js se extraen de su propio archivo y se ejecutan en un
// contexto aislado, igual que hacen las pruebas existentes del panel: se prueba
// el mismo texto que corre en producción, no una copia.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

/** Extrae una función completa de server.js por su primera línea. */
function extractFunction(header) {
    const start = serverSource.indexOf(header);
    assert.ok(start >= 0, 'no se encontró en server.js: ' + header);
    const end = serverSource.indexOf('\n}', start);
    assert.ok(end > start);
    return serverSource.slice(start, end + 2);
}

/** Contexto con un sistema de archivos simulado para probar loadUsers(). */
function authContext({ env = {}, users = null }) {
    const files = new Map();
    if (users) files.set('USERS', JSON.stringify(users, null, 2));
    const fakeFs = {
        existsSync: p => (String(p).includes('users.json') ? files.has('USERS') : true),
        readFileSync: () => files.get('USERS'),
        writeFileSync: (p, data) => files.set('USERS', data),
        mkdirSync: () => {},
    };
    const context = vm.createContext({
        process: { env }, fs: fakeFs, crypto, console: { log() {}, warn() {}, error() {} },
        path: { dirname: () => '/data', resolve: () => '/data/users.json' },
        USERS_PATH: '/data/users.json',
        uuidv4: () => '00000000-0000-4000-8000-000000000000',
        hashPassword: pass => 'hash:' + crypto.createHash('sha256').update(String(pass)).digest('hex'),
        verifyPassword: (pass, stored) => stored === 'hash:' + crypto.createHash('sha256').update(String(pass)).digest('hex'),
    });
    vm.runInContext(extractFunction('function adminPassFromEnv()'), context);
    vm.runInContext(extractFunction('function adminCredentialVersion()'), context);
    vm.runInContext(extractFunction('function loadUsers()'), context);
    return { context, files };
}

const adminUser = pass => ([{ id: 'a1', username: 'admin', admin: true, label: 'Administrador',
    passwordHash: 'hash:' + crypto.createHash('sha256').update(pass).digest('hex') }]);

// ── F05 ──────────────────────────────────────────────────────────────────────
test('F05: sin ADMIN_PASS no se restablece la contraseña del administrador existente', () => {
    const original = adminUser('una-contrasena-real-del-cliente');
    const { context, files } = authContext({ env: { ADMIN_USER: 'admin' }, users: original });
    const result = context.loadUsers();
    assert.equal(result[0].passwordHash, original[0].passwordHash,
        'la contraseña existente debe quedar intacta cuando ADMIN_PASS no está configurada');
    assert.equal(JSON.parse(files.get('USERS'))[0].passwordHash, original[0].passwordHash);
    assert.notEqual(result[0].passwordHash, 'hash:' + crypto.createHash('sha256').update('changeme').digest('hex'));
});

test('F05: sin ADMIN_PASS y sin administrador, el arranque se detiene en vez de crear uno conocido', () => {
    const { context } = authContext({ env: { ADMIN_USER: 'admin' }, users: null });
    assert.throws(() => context.loadUsers(), /ADMIN_PASS/);
});

test('F05: con ADMIN_PASS configurada el administrador se crea y se sincroniza como siempre', () => {
    const { context } = authContext({ env: { ADMIN_USER: 'admin', ADMIN_PASS: 'clave-sintetica-de-prueba' }, users: null });
    const users = context.loadUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].admin, true);
    assert.ok(context.verifyPassword('clave-sintetica-de-prueba', users[0].passwordHash));
});

test('F05: la huella de la credencial cambia al cambiar la contraseña, lo que revoca las sesiones', () => {
    const a = authContext({ env: { ADMIN_USER: 'admin', ADMIN_PASS: 'clave-uno' }, users: adminUser('clave-uno') });
    const b = authContext({ env: { ADMIN_USER: 'admin', ADMIN_PASS: 'clave-dos' }, users: adminUser('clave-uno') });
    assert.notEqual(a.context.adminCredentialVersion(), b.context.adminCredentialVersion());
});

test('F05: el inicio de sesión de administrador ya no acepta ninguna contraseña por omisión', () => {
    assert.ok(!serverSource.includes("ADMIN_PASS || 'changeme'"),
        'server.js no debe contener ninguna contraseña de administrador por omisión');
    assert.ok(serverSource.includes('const envPass = adminPassFromEnv()'));
    assert.ok(serverSource.includes('if (envPass && uname === envUser'),
        'sin ADMIN_PASS configurada no puede haber una vía de acceso por variables de entorno');
});

// ── F06 ──────────────────────────────────────────────────────────────────────
const db = require('../database-pg.js');

test('F06: los documentos guardados en texto plano se siguen leyendo', () => {
    const r = db.parseDocuments(JSON.stringify([{ name: 'Guía', url: 'https://ejemplo.test/a.pdf' }]));
    assert.equal(r.reason, null);
    assert.equal(r.documents.length, 1);
    assert.equal(r.documents[0].name, 'Guía');
});

test('F06: los documentos cifrados se leen en vez de desaparecer', () => {
    const original = [{ name: 'Material histórico', url: 'https://ejemplo.test/b.pdf' }];
    const guardado = db._encField(JSON.stringify(original));
    const r = db.parseDocuments(guardado);
    assert.equal(r.reason, null, 'una fila cifrada no puede quedar como "sin materiales"');
    assert.deepEqual(r.documents, original);
});

test('F06: un valor cifrado que no se puede abrir se informa, no se convierte en lista vacía silenciosa', () => {
    const r = db.parseDocuments('enc1:' + Buffer.from('basura que no descifra').toString('base64'));
    assert.deepEqual(r.documents, []);
    assert.equal(r.reason, 'unreadable');
});

test('F06: se distingue "no hay materiales" de "están corruptos"', () => {
    assert.deepEqual(db.parseDocuments(null), { documents: [], reason: null });
    assert.deepEqual(db.parseDocuments(''), { documents: [], reason: null });
    assert.equal(db.parseDocuments('{esto no es json').reason, 'corrupt');
    assert.equal(db.parseDocuments('{"a":1}').reason, 'unexpected');
});

test('F06: ni el catálogo ni el repositorio de recursos vuelven a interpretar la columna sin descifrarla', () => {
    assert.ok(!serverSource.includes('JSON.parse(r.documents'),
        'server.js no debe interpretar la columna documents sin pasar por el conversor');
    const repo = fs.readFileSync(path.join(__dirname, '..', 'lib', 'resource-repository.js'), 'utf8');
    assert.ok(!repo.includes('JSON.parse(row.documents'),
        'resource-repository.js no debe interpretar la columna documents sin pasar por el conversor');
});

// ── F07 ──────────────────────────────────────────────────────────────────────
function routeBody(marker) {
    const from = serverSource.indexOf(marker);
    assert.ok(from >= 0, 'no se encontró la ruta ' + marker);
    const rest = serverSource.slice(from);
    return rest.slice(0, rest.indexOf('\n});'));
}

test('F07: el catálogo de Bunny se guarda antes de responder "listo"', () => {
    const cuerpo = routeBody("app.post('/api/catalog/add-bunny'");
    const guardado = cuerpo.indexOf('await addToCatalog(');
    const respuesta = cuerpo.indexOf('res.status(201)');
    assert.ok(guardado > 0, 'la escritura debe esperarse');
    assert.ok(guardado < respuesta, 'la escritura debe completarse antes de responder');
    assert.match(cuerpo, /catch \(error\)[\s\S]{0,300}res\.status\(500\)/,
        'si la escritura falla, la respuesta debe ser un error y no un éxito');
});

test('F07: la subida solo responde "procesando" cuando la fila ya quedó registrada', () => {
    const cuerpo = routeBody("app.post('/api/video/upload'");
    const guardado = cuerpo.indexOf('await addToCatalog(');
    const respuesta = cuerpo.indexOf("status: 'processing'", guardado);
    assert.ok(guardado > 0 && respuesta > guardado);
    assert.ok(cuerpo.includes('res.status(500)'));
});

test('F07: no queda ninguna llamada a addToCatalog sin esperar', () => {
    for (const linea of serverSource.split('\n')) {
        if (/[^a-zA-Z.]addToCatalog\(/.test(linea) && !linea.includes('const addToCatalog')) {
            assert.match(linea, /await\s+(db\.)?addToCatalog\(/, 'sin await: ' + linea.trim().slice(0, 80));
        }
    }
});

// ── R03 ──────────────────────────────────────────────────────────────────────
test('R03: la conexión local sigue sin TLS, como antes', () => {
    for (const host of ['', 'localhost', '127.0.0.1', '::1', '/var/run/postgresql']) {
        assert.equal(db._databaseTls(host, {}), false, 'host local: ' + host);
    }
});

test('R03: la conexión remota verifica el certificado y la identidad del servidor', () => {
    const tls = db._databaseTls('base.ejemplo.net', { DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----' });
    assert.equal(tls.rejectUnauthorized, true);
    assert.equal(tls.servername, 'base.ejemplo.net');
    assert.ok(tls.ca);
});

test('R03: una base remota sin autoridad certificadora detiene el arranque en vez de degradarse', () => {
    assert.throws(() => db._databaseTls('base.ejemplo.net', {}), /autoridad certificadora/);
});

test('R03: solo una orden explícita permite conectarse sin verificar', () => {
    const tls = db._databaseTls('base.ejemplo.net', { PGSSLMODE: 'no-verify' });
    assert.equal(tls.rejectUnauthorized, false);
});

test('R03: ya no queda ningún rejectUnauthorized:false incondicional', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'database-pg.js'), 'utf8');
    assert.ok(!/ssl:\s*\(process\.env\.NODE_ENV[^\n]*rejectUnauthorized:\s*false/.test(source));
});

// ── R06 ──────────────────────────────────────────────────────────────────────
test('R06: renombrar un módulo desde el panel de admin no cambia su posición', async () => {
    const cuerpo = routeBody("app.put('/api/modules/:id'");
    const llamadas = [];
    const contexto = vm.createContext({
        db: { updateModule: async (id, patch) => { llamadas.push({ id, patch }); return { id, ...patch }; } },
        Number,
    });
    const handler = vm.runInContext('(async (req, res) => {' + cuerpo.slice(cuerpo.indexOf('{') + 1) + '})', contexto);
    const respuesta = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };

    // Solo se renombra: el orden no se envía y no debe tocarse.
    await handler({ params: { id: 'm1' }, body: { name: 'Nuevo nombre' } }, respuesta);
    assert.deepEqual(JSON.parse(JSON.stringify(llamadas.at(-1).patch)), { name: 'Nuevo nombre' },
        'sin orden enviado, la posición no puede formar parte del cambio');

    // Un cero explícito sí se respeta.
    await handler({ params: { id: 'm1' }, body: { name: 'Otro', sortOrder: 0 } }, respuesta);
    assert.deepEqual(JSON.parse(JSON.stringify(llamadas.at(-1).patch)), { name: 'Otro', sortOrder: 0 });

    // Una posición válida se aplica.
    await handler({ params: { id: 'm1' }, body: { name: 'Otro', sortOrder: 7 } }, respuesta);
    assert.equal(llamadas.at(-1).patch.sortOrder, 7);

    // Una posición inválida se rechaza en vez de guardarse.
    const antes = llamadas.length;
    await handler({ params: { id: 'm1' }, body: { name: 'Otro', sortOrder: -3 } }, respuesta);
    assert.equal(respuesta.code, 400);
    assert.equal(llamadas.length, antes, 'no se escribe nada con una posición inválida');
});

// ── F01 ──────────────────────────────────────────────────────────────────────
// El servidor exige, para el manifiesto y sus derivados, un token atado al video
// y a la sesión. El JWT de la cuenta no vale: esta es la razón por la que el
// catálogo de Android no llegaba a reproducir.
const jwt = require('jsonwebtoken');

function authorizeMediaAislada(secreto) {
    const cuerpo = extractFunction('async function authorizeMedia(');
    const contexto = vm.createContext({
        jwt, JWT_SECRET: secreto,
        accessPolicy: { authorizeSession: async (claims, sessionId) => ({ user: claims, sessionId }) },
        requestDevice: () => 'dispositivo-de-prueba',
        mediaJwt: () => '',
    });
    vm.runInContext(cuerpo, contexto);
    return contexto.authorizeMedia;
}

test('F01: el servidor rechaza el JWT de la cuenta para pedir el manifiesto', async () => {
    const secreto = 'secreto-sintetico-de-prueba';
    const authorizeMedia = authorizeMediaAislada(secreto);
    const cuenta = jwt.sign({ sub: 'alumno', email: 'qa@edulock.invalid', role: 'student' }, secreto);
    await assert.rejects(() => authorizeMedia({ headers: {}, query: {} }, 'video-1', cuenta),
        error => error.code === 'SESSION_REQUIRED' && error.status === 403);
});

test('F01: un token de reproducción de otro video tampoco sirve', async () => {
    const secreto = 'secreto-sintetico-de-prueba';
    const authorizeMedia = authorizeMediaAislada(secreto);
    const otro = jwt.sign({ sub: 'alumno', videoId: 'video-2', sessionId: 's1' }, secreto);
    await assert.rejects(() => authorizeMedia({ headers: {}, query: {} }, 'video-1', otro),
        error => error.code === 'SESSION_REQUIRED');
});

test('F01: el token de reproducción del propio video sí se acepta', async () => {
    const secreto = 'secreto-sintetico-de-prueba';
    const authorizeMedia = authorizeMediaAislada(secreto);
    const bueno = jwt.sign({ sub: 'alumno', videoId: 'video-1', sessionId: 's1' }, secreto);
    const contexto = await authorizeMedia({ headers: {}, query: {} }, 'video-1', bueno);
    assert.equal(contexto.user.videoId, 'video-1');
});

test('F01: el catálogo de Android entrega ese token al reproductor', () => {
    const catalogo = fs.readFileSync(path.join(__dirname, '..', 'player-apk-android', 'app', 'src', 'main',
        'kotlin', 'com', 'edulock', 'player', 'ui', 'CatalogActivity.kt'), 'utf8');
    assert.ok(catalogo.includes('EXTRA_AUTH_TOKEN, plan.mediaToken'),
        'sin esto el reproductor volvería a autenticar el manifiesto con el JWT de la cuenta');
    const reproductor = fs.readFileSync(path.join(__dirname, '..', 'player-apk-android', 'app', 'src', 'main',
        'kotlin', 'com', 'edulock', 'player', 'ui', 'PlayerActivity.kt'), 'utf8');
    assert.ok(!reproductor.includes('?: getJwtToken()'),
        'el manifiesto no puede volver a caer en el JWT de la cuenta');
});

test('F08: las dos pantallas de Android usan la misma política de reproducción', () => {
    const base = path.join(__dirname, '..', 'player-apk-android', 'app', 'src', 'main', 'kotlin', 'com', 'edulock', 'player', 'ui');
    for (const archivo of ['CatalogActivity.kt', 'WaitingActivity.kt']) {
        const texto = fs.readFileSync(path.join(base, archivo), 'utf8');
        assert.ok(texto.includes('PlaybackPolicy.plan('), archivo + ' debe usar la política compartida');
        assert.ok(texto.includes('VdoDirect'), archivo + ' debe contemplar vdocipher_direct');
    }
});
