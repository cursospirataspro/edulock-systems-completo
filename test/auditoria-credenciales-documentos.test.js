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

// ── N02 ──────────────────────────────────────────────────────────────────────
test('N02: el filtro de origen compara el host exacto, no una subcadena', () => {
    const cuerpo = routeBody("app.get('/api/video/:videoId/play'");
    const inicio = cuerpo.indexOf('const _selfHost');
    const fin = cuerpo.indexOf('if (!isSameOrigin');
    const contexto = vm.createContext({ URL, process: { env: { PUBLIC_URL: 'https://edulock.test' } } });
    const evaluar = vm.runInContext(
        '(origin, referer, allowedDomains) => {' + cuerpo.slice(inicio, fin) +
        ' return { isSameOrigin, isDomainAllowed }; }', contexto);

    assert.equal(evaluar('https://edulock.test', '', []).isSameOrigin, true, 'el propio dominio pasa');
    assert.equal(evaluar('https://app.edulock.test', '', []).isSameOrigin, true, 'un subdominio real pasa');
    assert.equal(evaluar('https://edulock.test.sitio-ajeno.test', '', []).isSameOrigin, false,
        'un dominio que solo contiene el nuestro NO puede pasar');
    assert.equal(evaluar('https://cliente.test', '', ['https://cliente.test']).isDomainAllowed, true);
    assert.equal(evaluar('https://cliente.test.ajeno.test', '', ['https://cliente.test']).isDomainAllowed, false,
        'empezar igual no basta para ser un dominio autorizado');
});

// ── F03 ──────────────────────────────────────────────────────────────────────
test('F03: borrar un módulo desde admin cierra sus recursos y no deja nada colgando', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'database-pg.js'), 'utf8');
    const inicio = fuente.indexOf('module.exports.deleteModule =');
    const bloque = fuente.slice(inicio, fuente.indexOf('module.exports.deleteModulesByCourse'));
    assert.ok(bloque.includes('UPDATE protected_resources SET deleted_at=NOW()'),
        'ningún documento puede quedar apuntando a un módulo inexistente');
    assert.ok(bloque.includes('DELETE FROM producer_content_settings'));
    assert.ok(bloque.includes('DELETE FROM stream_resources WHERE resource_key = ANY'));
    assert.ok(bloque.includes('enqueueProviderDeletion'),
        'el borrado en el servicio de video se anota igual que en el panel del productor');
    assert.ok(bloque.indexOf('enqueueProviderDeletion') < bloque.indexOf('DELETE FROM modules WHERE id=ANY'),
        'el descriptor remoto se captura antes de borrar');
});

test('F03: la ruta de admin responde 404 cuando el módulo no existe', () => {
    const cuerpo = routeBody("app.delete('/api/modules/:id'");
    assert.ok(cuerpo.includes('res.status(404)'));
    assert.ok(cuerpo.includes('resultado.deleted.length'));
});

// ── R01 ──────────────────────────────────────────────────────────────────────
test('R01: cada clase guarda en qué biblioteca vive y se opera sobre la suya', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'database-pg.js'), 'utf8');
    assert.ok(fuente.includes('ALTER TABLE catalog ADD COLUMN IF NOT EXISTS bunny_library_id'));
    assert.ok(fuente.includes('module.exports.setVideoLibrary'));
    assert.ok(fuente.includes('module.exports.getCoursePreviousLibraries'));
    const stream = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stream-service.js'), 'utf8');
    assert.ok(stream.includes('async function libraryForVideo('));
    assert.ok(stream.includes('await libraryForVideo(entry.courseId, videoId)'),
        'el estado de una clase se consulta en su propia biblioteca');
    assert.ok(stream.includes('BUNNY_VIDEO_OTHER_LIBRARY'),
        'una clase de una biblioteca anterior no se reorganiza dentro de la nueva');
});

// ── R05 ──────────────────────────────────────────────────────────────────────
const rutaAndroid = (...partes) => path.join(__dirname, '..', 'player-apk-android', 'app', 'src', 'main',
    'kotlin', 'com', 'edulock', 'player', 'ui', ...partes);

test('R05: Android informa la versión real de la compilación', () => {
    const catalogo = fs.readFileSync(rutaAndroid('CatalogActivity.kt'), 'utf8');
    assert.ok(!/appVersion\s*=\s*"1\.0\.0"/.test(catalogo), 'no puede enviar una versión fija');
    assert.ok(catalogo.includes('BuildConfig.VERSION_NAME'));
    const espera = fs.readFileSync(rutaAndroid('WaitingActivity.kt'), 'utf8');
    assert.ok(!/\?: "1\.1\.0"/.test(espera));
});

test('R05: la apertura de una clase está atada al ciclo de vida y no se duplica', () => {
    const catalogo = fs.readFileSync(rutaAndroid('CatalogActivity.kt'), 'utf8');
    const bloque = catalogo.slice(catalogo.indexOf('private fun playVideo'), catalogo.indexOf('private fun sendStartupCheckin'));
    assert.ok(bloque.includes('lifecycleScope.launch'), 'no puede usar un ámbito suelto');
    assert.ok(bloque.includes('if (abriendoClase)'), 'un segundo toque no puede abrir otra petición');
    assert.ok(bloque.includes('abriendoClase = false'));
    assert.ok(!catalogo.includes('CoroutineScope(Dispatchers.Main).launch'),
        'ningún trabajo con vistas puede sobrevivir a la pantalla');
});

test('R05: el reproductor suelta también el WebView al cerrarse', () => {
    const player = fs.readFileSync(rutaAndroid('PlayerActivity.kt'), 'utf8');
    const bloque = player.slice(player.indexOf('override fun onDestroy'), player.indexOf('override fun onPause'));
    assert.ok(bloque.includes('exoPlayer?.release()'));
    assert.ok(bloque.includes('w.destroy()'), 'el WebView de VdoCipher también debe liberarse');
});

// ── F04 ──────────────────────────────────────────────────────────────────────
test('F04: el binario distribuido no admite modo de desarrollo por línea de órdenes', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'player-app', 'main.js'), 'utf8');
    assert.ok(main.includes("const IS_DEV  = !app.isPackaged && process.argv.includes('--dev')"),
        'la bandera sola no puede activar el modo de desarrollo');
    assert.ok(!/const IS_DEV\s+=\s+process\.argv\.includes\('--dev'\);/.test(main));
});

// ── R04 ──────────────────────────────────────────────────────────────────────
test('R04: la sesión guardada se protege con el almacén del sistema y migra la antigua', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'player-app', 'main.js'), 'utf8');
    assert.ok(main.includes('safeStorage'), 'debe usarse el almacén del sistema operativo');
    assert.ok(main.includes('function writeSessionFile(') && main.includes('function readSessionFile('));
    assert.ok(!/fs\.writeFileSync\(SESSION_PATH, JSON\.stringify/.test(main),
        'ya no puede escribirse la sesión en texto plano directamente');
});

test('R04: los dominios del inicio de sesión se comparan por host y solo se abren http/https', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'player-app', 'main.js'), 'utf8');
    assert.ok(main.includes('function isAuthWindowUrl('));
    assert.ok(!main.includes("url.includes('accounts.google.com')"));
    assert.ok(main.includes('function openExternalSafely('));
    assert.ok(main.includes('function isTrustedSender('), 'los canales sensibles comprueban quién llama');
});

// ── R08 ──────────────────────────────────────────────────────────────────────
test('R08: se distinguen amenaza comprobada, binario sin firma y comprobación no disponible', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'player-app', 'main.js'), 'utf8');
    const bloque = main.slice(main.indexOf('function inspectProcessSignatures'), main.indexOf('// ── Detección comportamental'));
    for (const estado of ["'threat'", "'unsigned'", "'unavailable'", "'clean'"]) {
        assert.ok(bloque.includes(estado), 'falta el estado ' + estado);
    }
    assert.ok(bloque.includes('probe-unavailable:process-signatures'),
        'no haber podido comprobar no puede contarse como hallazgo');
    assert.ok(!/if \(err\) \{ resolve\(false\); return; \}/.test(bloque),
        'un fallo del sondeo no puede devolver lo mismo que "limpio"');
});

test('F03: borrar un curso desde admin no deja documentos ni registros colgando', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '..', 'database-pg.js'), 'utf8');
    const inicio = fuente.indexOf('module.exports.deleteCourse =');
    const bloque = fuente.slice(inicio, fuente.indexOf('module.exports.moveVideoToCourse'));
    assert.ok(bloque.includes('UPDATE protected_resources SET deleted_at=NOW()'));
    assert.ok(bloque.includes('DELETE FROM stream_resources WHERE resource_key = ANY'));
    assert.ok(bloque.includes('enqueueProviderDeletion'));
    assert.ok(bloque.indexOf('enqueueProviderDeletion') < bloque.indexOf('DELETE FROM courses WHERE id=$1'),
        'el descriptor remoto se captura antes de borrar');
    assert.ok(!/DELETE FROM licenses/.test(bloque),
        'las licencias y los accesos de los alumnos no se tocan: es una decisión del propietario');
    assert.ok(bloque.includes('decide el'), 'la contradicción entre paneles queda documentada en el código');
});
