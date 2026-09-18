'use strict';
// "Mis Cursos" (capa opcional del reproductor). Estas pruebas comprueban dos cosas:
//   1. que el interruptor solo se enciende para la sesión del productor que lo tiene activo;
//   2. que el panel NO puede usarse como atajo: la autorización de cada clase es la de siempre.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmbeddedCatalog } = require('../lib/embedded-catalog');
const { createAccessPolicy } = require('../lib/access-policy');

function fixture(overrides = {}) {
    const state = {
        producer: { id: 'producer-a', active: 1, embedded_catalog_enabled: true },
        session: { id: 'sid-a', student_id: 'student-a', license_id: 'license-a', course_id: 'course-a', producer_id: 'producer-a', device_id: 'device-a', ended_at: null },
        ...overrides,
    };
    const db = {
        getContentSession: async id => (state.session && state.session.id === id ? state.session : null),
        getProducerById: async id => (state.producer && state.producer.id === id ? state.producer : null),
    };
    return { state, catalog: createEmbeddedCatalog({ db }) };
}
const claims = { sub: 'student-a', sid: 'sid-a', licenseId: 'license-a', courseId: 'course-a', deviceId: 'device-a', hasLicense: true, allowedVideos: ['course-a'] };

test('caso 1 y 2: el interruptor del productor decide, y el valor por omisión mantiene la experiencia actual', async () => {
    const on = fixture();
    assert.equal(await on.catalog.enabledFor(claims), true);
    const off = fixture();
    off.state.producer.embedded_catalog_enabled = false;                  // valor por omisión de la columna
    assert.equal(await off.catalog.enabledFor(claims), false);
    const missing = fixture();
    delete missing.state.producer.embedded_catalog_enabled;               // productor anterior a la migración
    assert.equal(await missing.catalog.enabledFor(claims), false);
    const truthy = fixture();
    for (const value of [1, 'true', 'yes', {}]) {                          // solo el booleano verdadero enciende
        truthy.state.producer.embedded_catalog_enabled = value;
        assert.equal(await truthy.catalog.enabledFor(claims), false);
    }
});

test('caso 5: un productor suspendido nunca muestra el panel, aunque tenga el interruptor encendido', async () => {
    const f = fixture();
    f.state.producer.active = 0;
    assert.equal(await f.catalog.enabledFor(claims), false);
    f.state.producer.active = false;
    assert.equal(await f.catalog.enabledFor(claims), false);
    f.state.producer = null;
    assert.equal(await f.catalog.enabledFor(claims), false);
});

test('caso 8 y 9: sin sesión de contenido abierta, o con la de otro alumno u otra licencia, el panel no se ofrece', async () => {
    const ended = fixture();
    ended.state.session.ended_at = '2026-09-18T00:00:00Z';
    assert.equal(await ended.catalog.enabledFor(claims), false);
    const other = fixture();
    other.state.session.student_id = 'student-b';
    assert.equal(await other.catalog.enabledFor(claims), false);
    const relicensed = fixture();
    relicensed.state.session.license_id = 'license-b';
    assert.equal(await relicensed.catalog.enabledFor(claims), false);
    const f = fixture();
    assert.equal(await f.catalog.enabledFor({ ...claims, sid: undefined }), false, 'sesión limitada (aún sin licencia)');
    assert.equal(await f.catalog.enabledFor({ ...claims, sid: 'sid-desconocida' }), false);
    assert.equal(await f.catalog.enabledFor(null), false);
    assert.equal(await f.catalog.enabledFor({ sub: 'admin-a', admin: true, sid: 'sid-a' }), false, 'el panel es del alumno, no del administrador');
});

test('el contenido sin productor y los fallos de base de datos caen al modo tradicional', async () => {
    const orphan = fixture();
    orphan.state.session.producer_id = null;
    assert.equal(await orphan.catalog.enabledFor(claims), false);
    const broken = createEmbeddedCatalog({ db: { getContentSession: async () => { throw new Error('base de datos no disponible'); }, getProducerById: async () => null } });
    assert.equal(await broken.enabledFor(claims), false);
    const legacy = createEmbeddedCatalog({ db: { getProducerById: async () => ({ active: 1, embedded_catalog_enabled: true }) } });
    assert.equal(await legacy.enabledFor(claims), false, 'sin sesiones de contenido no hay panel');
    assert.throws(() => createEmbeddedCatalog({}), TypeError);
});

// ── El panel no es una autorización: cada clase vuelve a pasar por la política de acceso ──
function policyFixture() {
    const state = {
        student: { id: 'student-a', email: 'student-a@example.test', active: true, approval_status: 'approved' },
        video: { videoId: 'video-a', courseId: 'course-a', producerId: 'producer-a', status: 'ready' },
        licenses: [{ id: 'license-a', status: 'active', course_id: 'course-a', producer_id: 'producer-a', producer_active: 1, activation_status: 'active', device_status: 'active' }],
        contentSessions: { 'sid-a': { id: 'sid-a', student_id: 'student-a', license_id: 'license-a', course_id: 'course-a', device_id: 'device-a', ended_at: null } },
    };
    const db = {
        findStudentById: async () => state.student,
        getCatalogById: async id => (state.video.videoId === id ? state.video : null),
        getContentSession: async id => state.contentSessions[id] || null,
        pool: { query: async (sql, params) => ({ rows: sql.includes('FROM licenses') ? state.licenses.filter(l => l.id === params[3] && (l.course_id == null || l.course_id === params[2])) : [] }) },
    };
    return { state, policy: createAccessPolicy({ db }) };
}

test('caso 3 y 4: una clase de otro curso o de otro productor se rechaza aunque figure en el árbol', async () => {
    const other = policyFixture();
    other.state.video = { videoId: 'video-b', courseId: 'course-b', producerId: 'producer-a', status: 'ready' };
    await assert.rejects(other.policy.authorizeVideo(claims, 'video-b', 'device-a'), { code: 'COURSE_NOT_IN_SESSION' });
    const foreign = policyFixture();
    foreign.state.video = { videoId: 'video-a', courseId: 'course-a', producerId: 'producer-b', status: 'ready' };
    await assert.rejects(foreign.policy.authorizeVideo(claims, 'video-a', 'device-a'), { code: 'LICENSE_REQUIRED' });
});

test('casos 5 a 8: productor suspendido, licencia revocada, dispositivo ajeno y sesión terminada bloquean la reproducción', async () => {
    for (const [name, patch, code] of [
        ['productor suspendido', { producer_active: 0 }, 'LICENSE_REQUIRED'],
        ['licencia revocada', { status: 'revoked' }, 'LICENSE_REQUIRED'],
        ['activación revocada', { activation_status: 'revoked' }, 'LICENSE_REQUIRED'],
        ['dispositivo bloqueado', { device_status: 'blocked' }, 'LICENSE_REQUIRED'],
    ]) {
        const f = policyFixture();
        Object.assign(f.state.licenses[0], patch);
        await assert.rejects(f.policy.authorizeVideo(claims, 'video-a', 'device-a'), { code }, name);
    }
    const wrongDevice = policyFixture();
    await assert.rejects(wrongDevice.policy.authorizeVideo(claims, 'video-a', 'device-b'), { code: 'DEVICE_MISMATCH' });
    const ended = policyFixture();
    ended.state.contentSessions['sid-a'].ended_at = '2026-09-18T00:00:00Z';
    await assert.rejects(ended.policy.authorizeVideo(claims, 'video-a', 'device-a'), { code: 'SESSION_ENDED' });
});

test('caso 9: un alumno sin licencia activada no obtiene contenido por el panel', async () => {
    const f = policyFixture();
    await assert.rejects(f.policy.authorizeVideo({ sub: 'student-a', deviceId: 'device-a' }, 'video-a', 'device-a'), { code: 'LICENSE_REQUIRED' });
    await assert.rejects(f.policy.authorizeVideo({ sub: 'student-a', deviceId: 'device-a', allowedVideos: ['*'] }, 'video-a', 'device-a'), { code: 'LICENSE_REQUIRED' });
});
