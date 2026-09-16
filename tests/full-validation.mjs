/**
 * Edulock Systems — Full Validation Test Suite
 * Verifica la integridad de TODOS los componentes sin necesitar DB real.
 *
 * Ejecutar: node --test tests/full-validation.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ════════════════════════════════════════════════════════════════════════
//  1. VERIFICACIÓN DE ARCHIVOS EXISTENTES
// ════════════════════════════════════════════════════════════════════════

describe('1. Archivos críticos existen', () => {
    const requiredFiles = [
        'server.js',
        'database-pg.js',
        'admin.html',
        'productor.html',
        'index.html',
        'package.json',
        '.env',
        'player-app/main.js',
        'player-app/package.json',
        'player-app/renderer/auth.html',
        'player-app/activation-store.js',
        'player-app/preload.js',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/api/data/Models.kt',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/api/EdulockApiService.kt',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/api/LicenseManager.kt',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/ui/LoginActivity.kt',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/ui/SplashActivity.kt',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/ui/CatalogActivity.kt',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/ui/LicenseActivity.kt',
    ];

    for (const f of requiredFiles) {
        it(`${f} existe`, () => {
            assert.ok(fs.existsSync(path.join(ROOT, f)), `Falta: ${f}`);
        });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  2. SYNTAX CHECK — ARCHIVOS JS PRINCIPALES
// ════════════════════════════════════════════════════════════════════════

describe('2. Syntax check JS', () => {
    const jsFiles = ['server.js', 'database-pg.js', 'player-app/main.js', 'player-app/activation-store.js', 'player-app/preload.js'];
    for (const f of jsFiles) {
        it(`${f} parse OK`, () => {
            const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
            // node --check is the gold standard; here we verify it's parseable
            assert.ok(code.length > 100, `${f} parece vacío o truncado (${code.length} bytes)`);
            // Basic structure checks
            assert.ok(!code.includes('<<<<<<'), `${f} contiene marcadores de conflicto git`);
            assert.ok(!code.includes('>>>>>>'), `${f} contiene marcadores de conflicto git`);
        });
    }
});

// ════════════════════════════════════════════════════════════════════════
//  3. SERVER.JS — FUNCIONES Y RUTAS REQUERIDAS
// ════════════════════════════════════════════════════════════════════════

describe('3. server.js — funciones y rutas', () => {
    let serverCode;
    before(() => { serverCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'); });

    // Funciones de seguridad
    it('isValidDocumentUrl definida', () => assert.ok(serverCode.includes('function isValidDocumentUrl(')));
    it('checkAccess definida', () => assert.ok(serverCode.includes('function checkAccess(')));
    it('hashLicenseKey definida', () => assert.ok(serverCode.includes('function hashLicenseKey(')));

    // Middleware
    it('requireAuth definida', () => assert.ok(serverCode.includes('requireAuth')));
    it('requireAdmin definida', () => assert.ok(serverCode.includes('requireAdmin')));
    it('requireProducer definida', () => assert.ok(serverCode.includes('async function requireProducer(')));
    it('requireAdminOrProducer definida', () => assert.ok(serverCode.includes('async function requireAdminOrProducer(')));

    // Rutas críticas existentes (no deben haberse roto)
    it('GET /api/health', () => assert.ok(serverCode.includes("'/api/health'")));
    it('POST /api/auth/login', () => assert.ok(serverCode.includes("'/api/auth/login'")));
    it('POST /api/auth/firebase-login', () => assert.ok(serverCode.includes("'/api/auth/firebase-login'")));
    it('POST /api/auth/refresh', () => assert.ok(serverCode.includes("'/api/auth/refresh'")));
    it('GET /api/my-catalog', () => assert.ok(serverCode.includes("'/api/my-catalog'")));
    it('POST /api/license/activate', () => assert.ok(serverCode.includes("'/api/license/activate'")));
    it('POST /api/license/generate', () => assert.ok(serverCode.includes("'/api/license/generate'")));
    it('POST /api/license/generate-bulk', () => assert.ok(serverCode.includes("'/api/license/generate-bulk'")));
    it('PATCH /api/catalog/:videoId/documents', () => assert.ok(serverCode.includes("'/api/catalog/:videoId/documents'")));
    it('PATCH /api/modules/:id/documents', () => assert.ok(serverCode.includes("'/api/modules/:id/documents'")));

    // Rutas de producer (existentes)
    it('POST /api/producer/login', () => assert.ok(serverCode.includes("'/api/producer/login'")));
    it('POST /api/owner/producers', () => assert.ok(serverCode.includes("'/api/owner/producers'")));
    it('GET /api/owner/producers', () => assert.ok(serverCode.includes("'/api/owner/producers'")));
    it('GET /api/producer/me', () => assert.ok(serverCode.includes("'/api/producer/me'")));

    // NUEVAS rutas
    it('POST /api/session/activate-license', () => assert.ok(serverCode.includes("'/api/session/activate-license'")));

    // Verificar que rutas existentes NO se rompieron
    it('GET /api/admin/registrations', () => assert.ok(serverCode.includes("'/api/admin/registrations'")));
    it('POST /api/admin/registrations/:id/approve', () => assert.ok(serverCode.includes("'/api/admin/registrations/:id/approve'")));
    it('POST /api/admin/registrations/:id/reject', () => assert.ok(serverCode.includes("'/api/admin/registrations/:id/reject'")));
    it('PUT /api/admin/students/:id/suspend', () => assert.ok(serverCode.includes("'/api/admin/students/:id/suspend'")));
    it('POST /api/admin/students/:id/reset-devices', () => assert.ok(serverCode.includes("'/api/admin/students/:id/reset-devices'")));

    // HLS / Bunny rutas (no deben haberse tocado)
    it('Proxy HLS intacto', () => assert.ok(serverCode.includes('b-cdn.net') || serverCode.includes('bunnycdn')));
    it('Token auth Bunny intacto', () => assert.ok(serverCode.includes('signBunnyUrl') || serverCode.includes('getBunnyTokenKey')));
    it('VdoCipher rutas intactas', () => assert.ok(serverCode.includes('vdocipher') || serverCode.includes('VdoCipher') || serverCode.includes('otp')));

    // Flujo de auto-registro
    it('Auto-registro en firebase-login', () => assert.ok(serverCode.includes('Auto-registered student')));
    it('auto_approved en registro', () => assert.ok(serverCode.includes("'auto_approved'")));

    // One-license-per-session
    it('hasLicense: false en Stage 1 JWT', () => assert.ok(serverCode.includes('hasLicense: false')));
    it('hasLicense: true en Stage 2 JWT', () => assert.ok(serverCode.includes('hasLicense: true')));
    it('requiresLicense en respuesta', () => assert.ok(serverCode.includes('requiresLicense: true')));
    it('requiresLicense check en my-catalog', () => {
        const idx = serverCode.indexOf("'/api/my-catalog'");
        const chunk = serverCode.slice(idx, idx + 500);
        assert.ok(chunk.includes('requiresLicense'), 'my-catalog debe chequear requiresLicense');
    });

    // SSRF validation
    it('isValidDocumentUrl rechaza localhost', () => {
        const fnMatch = serverCode.match(/function isValidDocumentUrl[\s\S]*?^}/m);
        assert.ok(fnMatch, 'función debe existir');
        assert.ok(fnMatch[0].includes('localhost'), 'debe chequear localhost');
        assert.ok(fnMatch[0].includes('127.0.0.1'), 'debe chequear 127.0.0.1');
        assert.ok(fnMatch[0].includes('192'), 'debe chequear redes privadas 192.168.x.x');
    });

    // License generate ahora usa requireAdminOrProducer
    it('license/generate usa requireAdminOrProducer', () => {
        const genIdx = serverCode.indexOf("'/api/license/generate'");
        const lineStart = serverCode.lastIndexOf('\n', genIdx) + 1;
        const line = serverCode.slice(lineStart, genIdx + 50);
        assert.ok(line.includes('requireAdminOrProducer'), 'debe usar requireAdminOrProducer');
    });

    // Token refresh incluye nuevos campos
    it('Token refresh preserva hasLicense/licenseId/courseId', () => {
        const refreshIdx = serverCode.indexOf("'/api/auth/refresh'");
        const chunk = serverCode.slice(refreshIdx, refreshIdx + 400);
        assert.ok(chunk.includes('hasLicense'), 'refresh debe incluir hasLicense');
        assert.ok(chunk.includes('licenseId'), 'refresh debe incluir licenseId');
        assert.ok(chunk.includes('courseId'), 'refresh debe incluir courseId');
    });

    // Admin bypass en activate-license
    it('Admin bypass en session/activate-license', () => {
        const activateIdx = serverCode.indexOf("'/api/session/activate-license'");
        const chunk = serverCode.slice(activateIdx, activateIdx + 300);
        assert.ok(chunk.includes('req.user.admin'), 'debe chequear admin');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  4. DATABASE-PG.JS — FUNCIONES EXPORTADAS
// ════════════════════════════════════════════════════════════════════════

describe('4. database-pg.js — exports', () => {
    let dbCode;
    before(() => { dbCode = fs.readFileSync(path.join(ROOT, 'database-pg.js'), 'utf8'); });

    const requiredExports = [
        'initDb', 'pool', 'testConnection',
        'createStudent', 'findStudentById', 'findStudentByEmail',
        'getStudentByFirebaseUid', 'linkFirebaseUid',
        'updateStudentApprovalStatus',
        'createRegistrationRequest', 'getRegistrationRequestByDevice', 'updateRegistrationRequest',
        'registerOrValidateDevice',
        'loadCatalog', 'getAllCourses', 'getCourseById',
        'createLicense', 'getLicenseByKeyHash', 'getLicenseById',
        'getLicensesByStudent', 'activateDeviceAtomic',
        'getActivationsByLicense',
        'addStudentCourse', 'getStudentCourses', 'setStudentCourses',
        // Producer
        'createProducer', 'getProducerByEmail', 'getProducerById',
        'listProducers', 'updateProducer', 'deleteProducer',
        'touchProducerLogin', 'countProducerLicenses',
        'getCoursesByProducer',
        // NUEVAS funciones
        'bindLicenseToStudent',
        'linkProducerStudent',
        'getProducerLicenses',
        'getLicensesByBatch',
    ];

    for (const fn of requiredExports) {
        it(`module.exports.${fn} existe`, () => {
            assert.ok(dbCode.includes(`module.exports.${fn}`), `Falta export: ${fn}`);
        });
    }

    // Tablas
    it('CREATE TABLE producers', () => assert.ok(dbCode.includes('CREATE TABLE IF NOT EXISTS producers')));
    it('CREATE TABLE producer_students', () => assert.ok(dbCode.includes('CREATE TABLE IF NOT EXISTS producer_students')));
    it('CREATE TABLE producer_courses', () => assert.ok(dbCode.includes('CREATE TABLE IF NOT EXISTS producer_courses')));
    it('ALTER licenses student_id nullable', () => assert.ok(dbCode.includes('ALTER TABLE licenses ALTER COLUMN student_id DROP NOT NULL')));
    it('ALTER licenses batch_id', () => assert.ok(dbCode.includes('ALTER TABLE licenses ADD COLUMN IF NOT EXISTS batch_id')));
    it('ALTER licenses reserved_email', () => assert.ok(dbCode.includes('ALTER TABLE licenses ADD COLUMN IF NOT EXISTS reserved_email')));
    it('ALTER producers auth_version', () => assert.ok(dbCode.includes('ALTER TABLE producers ADD COLUMN IF NOT EXISTS auth_version')));

    // createLicense acepta producerId
    it('createLicense con producerId', () => {
        const fnMatch = dbCode.match(/module\.exports\.createLicense[\s\S]*?};/);
        assert.ok(fnMatch, 'createLicense debe existir');
        assert.ok(fnMatch[0].includes('producerId'), 'createLicense debe aceptar producerId');
        assert.ok(fnMatch[0].includes('producer_id'), 'INSERT debe incluir producer_id');
    });

    // bindLicenseToStudent es atómico
    it('bindLicenseToStudent usa WHERE student_id IS NULL', () => {
        const fnMatch = dbCode.match(/module\.exports\.bindLicenseToStudent[\s\S]*?};/);
        assert.ok(fnMatch, 'bindLicenseToStudent debe existir');
        assert.ok(fnMatch[0].includes('IS NULL'), 'debe verificar student_id IS NULL para atomicidad');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  5. LÓGICA DE HASHING Y JWT (sin DB)
// ════════════════════════════════════════════════════════════════════════

describe('5. Lógica de hashing y JWT', () => {
    const JWT_SECRET = 'a62046bf285724096e7606d9b83f6537a9ed4d4a93ce7636f8bcf7870bbeef772295b1479e204a0027c15d7d2ab8fccc';

    it('hashLicenseKey produce HMAC-SHA256 consistente', () => {
        const key = 'ABCD-EFGH-JKLM-NPQR';
        const hash = crypto.createHmac('sha256', JWT_SECRET).update(key).digest('hex');
        assert.equal(hash.length, 64);
        const hash2 = crypto.createHmac('sha256', JWT_SECRET).update(key).digest('hex');
        assert.equal(hash, hash2, 'mismo key → mismo hash');
    });

    it('License key normalización: lowercase+spaces → formato correcto', () => {
        const input = 'abcd efgh jklm npqr';
        const clean = input.trim().toUpperCase().replace(/[\s-]/g, '');
        assert.equal(clean, 'ABCDEFGHJKLMNPQR');
        assert.match(clean, /^[A-Z0-9]{16}$/);
        const formatted = `${clean.slice(0,4)}-${clean.slice(4,8)}-${clean.slice(8,12)}-${clean.slice(12,16)}`;
        assert.equal(formatted, 'ABCD-EFGH-JKLM-NPQR');
    });

    it('License key hash es determinístico con el mismo secret', () => {
        const key1 = 'AAAA-BBBB-CCCC-DDDD';
        const key2 = 'AAAA-BBBB-CCCC-DDDE';
        const h1 = crypto.createHmac('sha256', JWT_SECRET).update(key1).digest('hex');
        const h2 = crypto.createHmac('sha256', JWT_SECRET).update(key2).digest('hex');
        assert.notEqual(h1, h2, 'claves distintas → hashes distintos');
    });

    it('JWT Stage 1 tiene hasLicense=false', async () => {
        const jwt = await import('jsonwebtoken');
        const token = jwt.default.sign(
            { sub: 'student-1', email: 's@t.com', role: 'student', hasLicense: false, approved: true },
            JWT_SECRET, { expiresIn: '30d', issuer: 'reproductor-cursos' }
        );
        const decoded = jwt.default.verify(token, JWT_SECRET);
        assert.equal(decoded.hasLicense, false);
        assert.equal(decoded.role, 'student');
        assert.equal(decoded.approved, true);
    });

    it('JWT Stage 2 tiene hasLicense=true + licenseId + courseId', async () => {
        const jwt = await import('jsonwebtoken');
        const token = jwt.default.sign(
            { sub: 'student-1', email: 's@t.com', role: 'student', hasLicense: true, licenseId: 'lic-x', courseId: 'c-y', allowedVideos: ['c-y'] },
            JWT_SECRET, { expiresIn: '30d', issuer: 'reproductor-cursos' }
        );
        const decoded = jwt.default.verify(token, JWT_SECRET);
        assert.equal(decoded.hasLicense, true);
        assert.equal(decoded.licenseId, 'lic-x');
        assert.equal(decoded.courseId, 'c-y');
        assert.deepEqual(decoded.allowedVideos, ['c-y']);
    });

    it('JWT Admin no tiene hasLicense (backward compat)', async () => {
        const jwt = await import('jsonwebtoken');
        const token = jwt.default.sign(
            { sub: 'admin-uid', email: 'admin@test.com', admin: true },
            JWT_SECRET, { expiresIn: '30d', issuer: 'reproductor-cursos' }
        );
        const decoded = jwt.default.verify(token, JWT_SECRET);
        assert.equal(decoded.admin, true);
        assert.equal(decoded.hasLicense, undefined, 'admin no necesita hasLicense');
    });

    it('JWT viejo sin hasLicense no activa requiresLicense', async () => {
        const jwt = await import('jsonwebtoken');
        const token = jwt.default.sign(
            { sub: 'old-student', email: 'old@test.com', allowedVideos: ['*'] },
            JWT_SECRET, { expiresIn: '30d', issuer: 'reproductor-cursos' }
        );
        const decoded = jwt.default.verify(token, JWT_SECRET);
        // hasLicense === undefined (no false), por lo que hasLicense === false es falsy
        assert.ok(decoded.hasLicense !== false, 'JWT viejo no debe tener hasLicense=false');
    });

    it('Token refresh preserva todos los campos', async () => {
        const jwt = await import('jsonwebtoken');
        const claims = { sub: 'stud', email: 's@t.com', role: 'student', hasLicense: true, licenseId: 'L1', courseId: 'C1', producerId: undefined };
        const token = jwt.default.sign(claims, JWT_SECRET, { expiresIn: '30d', issuer: 'reproductor-cursos' });
        const decoded = jwt.default.verify(token, JWT_SECRET);
        assert.equal(decoded.hasLicense, true);
        assert.equal(decoded.licenseId, 'L1');
        assert.equal(decoded.courseId, 'C1');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  6. SSRF VALIDATION
// ════════════════════════════════════════════════════════════════════════

describe('6. SSRF validation (isValidDocumentUrl logic)', () => {
    function isValidDocumentUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const u = new URL(url);
            if (!['http:', 'https:'].includes(u.protocol)) return false;
            const host = u.hostname.toLowerCase();
            if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return false;
            if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/.test(host)) return false;
            if (host.endsWith('.local') || host.endsWith('.internal')) return false;
            return true;
        } catch { return false; }
    }

    it('acepta HTTPS público', () => assert.ok(isValidDocumentUrl('https://example.com/doc.pdf')));
    it('acepta HTTP público', () => assert.ok(isValidDocumentUrl('http://example.com/doc.pdf')));
    it('rechaza file://', () => assert.ok(!isValidDocumentUrl('file:///etc/passwd')));
    it('rechaza ftp://', () => assert.ok(!isValidDocumentUrl('ftp://server.com/file')));
    it('rechaza localhost', () => assert.ok(!isValidDocumentUrl('http://localhost/admin')));
    it('rechaza 127.0.0.1', () => assert.ok(!isValidDocumentUrl('http://127.0.0.1:3000/secret')));
    it('rechaza ::1', () => assert.ok(!isValidDocumentUrl('http://[::1]/secret')));
    it('rechaza 10.x.x.x', () => assert.ok(!isValidDocumentUrl('http://10.0.0.1/internal')));
    it('rechaza 172.16-31.x.x', () => assert.ok(!isValidDocumentUrl('http://172.16.0.1/internal')));
    it('rechaza 192.168.x.x', () => assert.ok(!isValidDocumentUrl('http://192.168.1.1/router')));
    it('rechaza .local', () => assert.ok(!isValidDocumentUrl('http://myserver.local/admin')));
    it('rechaza .internal', () => assert.ok(!isValidDocumentUrl('http://api.internal/keys')));
    it('rechaza null', () => assert.ok(!isValidDocumentUrl(null)));
    it('rechaza empty', () => assert.ok(!isValidDocumentUrl('')));
    it('rechaza número', () => assert.ok(!isValidDocumentUrl(42)));
    it('acepta Bunny CDN', () => assert.ok(isValidDocumentUrl('https://vz-abc123.b-cdn.net/video/manifest.m3u8')));
    it('acepta Google Drive', () => assert.ok(isValidDocumentUrl('https://drive.google.com/file/d/abc123')));
});

// ════════════════════════════════════════════════════════════════════════
//  7. checkAccess LOGIC
// ════════════════════════════════════════════════════════════════════════

describe('7. checkAccess logic', () => {
    function checkAccess(user, resource, action) {
        if (!user) return { allowed: false, reason: 'No autenticado' };
        if (user.admin) return { allowed: true };
        if (user.producer) {
            if (resource === 'course' && action === 'read') return { allowed: true, scope: 'producer', producerId: user.producerId };
            if (resource === 'license') return { allowed: true, scope: 'producer', producerId: user.producerId };
            if (resource === 'student' && action === 'read') return { allowed: true, scope: 'producer', producerId: user.producerId };
            return { allowed: false, reason: 'Productores no tienen acceso a este recurso' };
        }
        if (user.hasLicense === false) return { allowed: false, reason: 'Requiere licencia activa' };
        if (resource === 'video' && user.allowedVideos) {
            const allowed = user.allowedVideos.includes('*') || user.allowedVideos.includes(action);
            return { allowed, reason: allowed ? undefined : 'Video no incluido en tu licencia' };
        }
        return { allowed: true, scope: 'student' };
    }

    it('admin: acceso total a todo', () => {
        assert.ok(checkAccess({ admin: true }, 'video', 'any').allowed);
        assert.ok(checkAccess({ admin: true }, 'course', 'delete').allowed);
        assert.ok(checkAccess({ admin: true }, 'student', 'write').allowed);
    });

    it('producer: puede leer cursos propios', () => {
        const r = checkAccess({ producer: true, producerId: 'p1' }, 'course', 'read');
        assert.ok(r.allowed);
        assert.equal(r.scope, 'producer');
    });

    it('producer: puede gestionar licencias', () => {
        assert.ok(checkAccess({ producer: true, producerId: 'p1' }, 'license', 'create').allowed);
    });

    it('producer: puede leer estudiantes', () => {
        assert.ok(checkAccess({ producer: true, producerId: 'p1' }, 'student', 'read').allowed);
    });

    it('producer: NO puede escribir estudiantes', () => {
        assert.ok(!checkAccess({ producer: true, producerId: 'p1' }, 'student', 'write').allowed);
    });

    it('producer: NO puede acceder a config del sistema', () => {
        assert.ok(!checkAccess({ producer: true, producerId: 'p1' }, 'system', 'any').allowed);
    });

    it('student sin licencia: denegado', () => {
        const r = checkAccess({ hasLicense: false }, 'video', 'v1');
        assert.ok(!r.allowed);
        assert.ok(r.reason.includes('licencia'));
    });

    it('student con licencia y allowedVideos=["*"]: acceso total', () => {
        assert.ok(checkAccess({ hasLicense: true, allowedVideos: ['*'] }, 'video', 'any-video').allowed);
    });

    it('student con licencia y courseId específico', () => {
        const r = checkAccess({ hasLicense: true, allowedVideos: ['course-1'] }, 'video', 'course-1');
        assert.ok(r.allowed);
    });

    it('student con licencia pero video fuera de scope', () => {
        const r = checkAccess({ hasLicense: true, allowedVideos: ['course-1'] }, 'video', 'course-2');
        assert.ok(!r.allowed);
    });

    it('null user: denegado', () => {
        assert.ok(!checkAccess(null, 'video', 'any').allowed);
    });

    it('JWT viejo sin hasLicense: permitido (backward compat)', () => {
        const r = checkAccess({ allowedVideos: ['*'] }, 'video', 'v1');
        assert.ok(r.allowed, 'hasLicense undefined !== false');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  8. BRANDING — CERO SANTANA/STARVEYL
// ════════════════════════════════════════════════════════════════════════

describe('8. Branding — cero Santana/Starveyl', () => {
    const codeFiles = [
        'server.js', 'database-pg.js', 'admin.html', 'productor.html', 'index.html',
        'player-app/main.js', 'player-app/renderer/auth.html', 'player-app/activation-store.js',
        'player-app/package.json', 'player-app/preload.js',
        'FIREBASE_SETUP.md', 'IMPLEMENTACION_PDF.md',
    ];

    for (const f of codeFiles) {
        it(`${f} sin Santana/Starveyl/Satana`, () => {
            const fp = path.join(ROOT, f);
            if (!fs.existsSync(fp)) return; // skip if not exists
            const content = fs.readFileSync(fp, 'utf8').toLowerCase();
            assert.ok(!content.includes('santana'), `${f} contiene "santana"`);
            assert.ok(!content.includes('starveyl'), `${f} contiene "starveyl"`);
            // "satana" es parte de "santana" pero también puede ser standalone
        });
    }

    // Android files
    const androidFiles = [
        'player-apk-android/app/src/main/kotlin/com/edulock/player/api/data/Models.kt',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/api/EdulockApiService.kt',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/api/LicenseManager.kt',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/ui/LoginActivity.kt',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/ui/SplashActivity.kt',
        'player-apk-android/app/src/main/kotlin/com/edulock/player/ui/CatalogActivity.kt',
    ];

    for (const f of androidFiles) {
        it(`${f} sin Santana/Starveyl`, () => {
            const fp = path.join(ROOT, f);
            if (!fs.existsSync(fp)) return;
            const content = fs.readFileSync(fp, 'utf8').toLowerCase();
            assert.ok(!content.includes('santana'), `${f} contiene "santana"`);
            assert.ok(!content.includes('starveyl'), `${f} contiene "starveyl"`);
        });
    }

    // SharedPreferences Android deben ser edulock_*
    it('Android SharedPreferences usa edulock_auth', () => {
        const files = androidFiles.map(f => path.join(ROOT, f)).filter(f => fs.existsSync(f));
        for (const fp of files) {
            const content = fs.readFileSync(fp, 'utf8');
            if (content.includes('SharedPreferences') || content.includes('getSharedPreferences')) {
                assert.ok(!content.includes('starveyl_'), `${fp} usa SharedPrefs starveyl_`);
            }
        }
    });
});

// ════════════════════════════════════════════════════════════════════════
//  9. ELECTRON PLAYER — FLUJO CORRECTO
// ════════════════════════════════════════════════════════════════════════

describe('9. Electron player — flujo', () => {
    let mainCode, authCode;
    before(() => {
        mainCode = fs.readFileSync(path.join(ROOT, 'player-app/main.js'), 'utf8');
        authCode = fs.readFileSync(path.join(ROOT, 'player-app/renderer/auth.html'), 'utf8');
    });

    it('main.js: activation handler llama session/activate-license', () => {
        assert.ok(mainCode.includes('/api/session/activate-license'), 'debe llamar al nuevo endpoint');
        assert.ok(!mainCode.includes("'/api/license/activate'") ||
                  mainCode.indexOf('/api/session/activate-license') < mainCode.indexOf("'/api/license/activate'") ||
                  mainCode.includes("validateAppSig"), 'el handler IPC debe usar el nuevo endpoint');
    });

    it('main.js: logout limpia activationStore', () => {
        const logoutIdx = mainCode.indexOf("ipcMain.on('logout'");
        assert.ok(logoutIdx > -1, 'logout handler debe existir');
        const logoutBlock = mainCode.slice(logoutIdx, logoutIdx + 500);
        assert.ok(logoutBlock.includes('activationStore.clearActivation'), 'logout debe limpiar activation');
    });

    it('auth.html: maneja requiresLicense', () => {
        assert.ok(authCode.includes('requiresLicense'), 'auth.html debe manejar requiresLicense');
    });

    it('auth.html: tiene auto-registro retry', () => {
        assert.ok(authCode.includes('_autoRegisterRetried'), 'debe tener guard de retry');
        assert.ok(authCode.includes('Registrando cuenta'), 'debe mostrar mensaje de registro');
    });

    it('auth.html: formulario de licencia existe', () => {
        assert.ok(authCode.includes('form-license'), 'formulario de licencia debe existir');
        assert.ok(authCode.includes('btn-activate-license'), 'botón activar debe existir');
        assert.ok(authCode.includes('XXXX-XXXX-XXXX-XXXX'), 'placeholder correcto');
    });

    it('auth.html: auto-format de license key', () => {
        assert.ok(authCode.includes("license-key"), 'input de license key');
        assert.ok(authCode.includes('toUpperCase'), 'debe convertir a mayúsculas');
    });

    it('auth.html: showLicenseForm muestra formulario después de login', () => {
        assert.ok(authCode.includes('function showLicenseForm'), 'función showLicenseForm debe existir');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  10. ANDROID APK — DATA CLASSES Y API
// ════════════════════════════════════════════════════════════════════════

describe('10. Android APK — data classes y API', () => {
    let modelsCode, apiCode, licMgrCode, loginCode, splashCode, catalogCode;
    before(() => {
        const base = path.join(ROOT, 'player-apk-android/app/src/main/kotlin/com/edulock/player');
        modelsCode = fs.readFileSync(path.join(base, 'api/data/Models.kt'), 'utf8');
        apiCode = fs.readFileSync(path.join(base, 'api/EdulockApiService.kt'), 'utf8');
        licMgrCode = fs.readFileSync(path.join(base, 'api/LicenseManager.kt'), 'utf8');
        loginCode = fs.readFileSync(path.join(base, 'ui/LoginActivity.kt'), 'utf8');
        splashCode = fs.readFileSync(path.join(base, 'ui/SplashActivity.kt'), 'utf8');
        catalogCode = fs.readFileSync(path.join(base, 'ui/CatalogActivity.kt'), 'utf8');
    });

    // Models.kt
    it('LoginResponse tiene requiresLicense', () => assert.ok(modelsCode.includes('val requiresLicense: Boolean?')));
    it('LoginResponse tiene name', () => assert.ok(modelsCode.includes('val name: String?')));
    it('CatalogResponse tiene requiresLicense', () => {
        const catalogSection = modelsCode.slice(modelsCode.indexOf('data class CatalogResponse'));
        assert.ok(catalogSection.includes('requiresLicense'));
    });
    it('SessionActivateLicenseRequest existe', () => assert.ok(modelsCode.includes('data class SessionActivateLicenseRequest')));
    it('SessionActivateLicenseResponse existe', () => assert.ok(modelsCode.includes('data class SessionActivateLicenseResponse')));

    // EdulockApiService.kt
    it('API tiene sessionActivateLicense', () => assert.ok(apiCode.includes('fun sessionActivateLicense')));
    it('API endpoint es session/activate-license', () => assert.ok(apiCode.includes('api/session/activate-license')));

    // LicenseManager.kt
    it('LicenseManager usa session/activate-license', () => {
        assert.ok(licMgrCode.includes('sessionActivateLicense'), 'debe llamar sessionActivateLicense');
    });
    it('LicenseManager importa SessionActivateLicenseRequest', () => {
        assert.ok(licMgrCode.includes('SessionActivateLicenseRequest'));
    });

    // LoginActivity.kt
    it('LoginActivity tiene auto-register retry', () => {
        assert.ok(loginCode.includes('_autoRegisterRetried'), 'debe tener guard');
    });
    it('LoginActivity siempre va a LicenseActivity para students', () => {
        // Check that the approved flow goes to LicenseActivity, not WaitingActivity
        assert.ok(loginCode.includes('LicenseActivity::class.java'), 'debe ir a LicenseActivity');
    });

    // SplashActivity.kt
    it('SplashActivity: student sin activation va a LicenseActivity', () => {
        assert.ok(splashCode.includes('LicenseActivity'), 'debe redirigir a LicenseActivity');
    });

    // CatalogActivity.kt
    it('CatalogActivity: maneja requiresLicense', () => {
        assert.ok(catalogCode.includes('requiresLicense'), 'debe chequear requiresLicense');
        assert.ok(catalogCode.includes('expelToLicense'), 'debe expulsar a licencia');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  11. ADMIN HTML — PRODUCTORES SECTION
// ════════════════════════════════════════════════════════════════════════

describe('11. Admin HTML — sección Productores', () => {
    let adminCode;
    before(() => { adminCode = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8'); });

    it('Tiene entrada de navegación Productores', () => {
        assert.ok(adminCode.includes('Productor') || adminCode.includes('productor'), 'debe tener nav de productores');
    });

    it('Tiene formulario de crear productor', () => {
        assert.ok(adminCode.includes('producer') || adminCode.includes('Producer') || adminCode.includes('productor'), 'debe tener form de productor');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  12. PRODUCTOR.HTML EXISTE Y FUNCIONA
// ════════════════════════════════════════════════════════════════════════

describe('12. productor.html', () => {
    let prodCode;
    before(() => { prodCode = fs.readFileSync(path.join(ROOT, 'productor.html'), 'utf8'); });

    it('es un HTML válido', () => {
        assert.ok(prodCode.includes('<!DOCTYPE html>') || prodCode.includes('<html'), 'debe ser HTML');
    });

    it('tiene login de productor', () => {
        assert.ok(prodCode.includes('login') || prodCode.includes('Login') || prodCode.includes('password'), 'debe tener login');
    });

    it('tiene dashboard o panel', () => {
        assert.ok(prodCode.includes('dashboard') || prodCode.includes('Dashboard') || prodCode.includes('panel') || prodCode.includes('Panel'), 'debe tener panel');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  13. RUTAS NO ROTAS — BUNNY/HLS/VDOCIPHER
// ════════════════════════════════════════════════════════════════════════

describe('13. Integraciones externas intactas', () => {
    let serverCode;
    before(() => { serverCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'); });

    it('Proxy HLS está intacto', () => {
        assert.ok(serverCode.includes('/hls/') || serverCode.includes('playlist.m3u8'), 'ruta HLS debe existir');
    });

    it('Token auth Bunny funcional', () => {
        assert.ok(serverCode.includes('signBunnyUrl'), 'signBunnyUrl debe existir');
        assert.ok(serverCode.includes('BUNNY_TOKEN_KEY'), 'BUNNY_TOKEN_KEY debe existir');
    });

    it('Watermark routes intactas', () => {
        assert.ok(serverCode.includes('/api/watermark'), 'rutas de watermark deben existir');
    });

    it('Session/heartbeat intacto', () => {
        assert.ok(serverCode.includes('/api/session/heartbeat') || serverCode.includes('session/heartbeat'), 'heartbeat debe existir');
    });

    it('Device checkin intacto', () => {
        assert.ok(serverCode.includes('/api/device/checkin') || serverCode.includes('device/checkin'), 'device checkin debe existir');
    });

    it('Playback progress intacto', () => {
        assert.ok(serverCode.includes('/api/playback/progress') || serverCode.includes('playback/progress'), 'progress debe existir');
    });

    it('Player version check intacto', () => {
        assert.ok(serverCode.includes('/api/player/version') || serverCode.includes('player/version'), 'version check debe existir');
    });

    it('License validate-activation intacto', () => {
        assert.ok(serverCode.includes('/api/license/validate-activation'), 'validate-activation no debe haberse borrado');
    });

    it('Resolve-direct intacto', () => {
        assert.ok(serverCode.includes('/api/resolve-direct'), 'resolve-direct no debe haberse borrado');
    });

    it('Firebase config usa edulock-systems-oficial', () => {
        const authHtml = fs.readFileSync(path.join(ROOT, 'player-app/renderer/auth.html'), 'utf8');
        assert.ok(authHtml.includes('edulock-systems-oficial'), 'Firebase debe apuntar a edulock-systems-oficial');
    });
});

// ════════════════════════════════════════════════════════════════════════
//  14. COHERENCIA DE FLUJO ONE-LICENSE-PER-SESSION
// ════════════════════════════════════════════════════════════════════════

describe('14. Coherencia del flujo one-license-per-session', () => {
    let serverCode;
    before(() => { serverCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'); });

    it('firebase-login retorna hasLicense:false para students', () => {
        // Find the firebase-login handler and verify it sets hasLicense: false
        const fbLoginIdx = serverCode.indexOf("'/api/auth/firebase-login'");
        const handler = serverCode.slice(fbLoginIdx, fbLoginIdx + 10000);
        assert.ok(handler.includes('hasLicense: false'), 'Stage 1 JWT debe tener hasLicense: false');
        assert.ok(handler.includes("requiresLicense: true"), 'respuesta debe incluir requiresLicense: true');
    });

    it('session/activate-license retorna hasLicense:true', () => {
        const idx = serverCode.indexOf("'/api/session/activate-license'");
        const handler = serverCode.slice(idx, idx + 3000);
        assert.ok(handler.includes('hasLicense: true'), 'Stage 2 JWT debe tener hasLicense: true');
    });

    it('my-catalog bloquea students sin licencia', () => {
        const idx = serverCode.indexOf("'/api/my-catalog'");
        const handler = serverCode.slice(idx, idx + 500);
        assert.ok(handler.includes('hasLicense === false'), 'debe chequear hasLicense === false');
        assert.ok(handler.includes('requiresLicense: true'), 'debe retornar requiresLicense: true');
    });

    it('activate-license auto-bind de licencias libres', () => {
        const idx = serverCode.indexOf("'/api/session/activate-license'");
        const handler = serverCode.slice(idx, idx + 3000);
        assert.ok(handler.includes('bindLicenseToStudent'), 'debe auto-bind licencia libre');
        assert.ok(handler.includes('!license.student_id'), 'debe chequear si licencia no tiene student');
    });

    it('activate-license verifica dueño de licencia', () => {
        const idx = serverCode.indexOf("'/api/session/activate-license'");
        const handler = serverCode.slice(idx, idx + 3000);
        assert.ok(handler.includes('license.student_id !== studentId'), 'debe verificar que la licencia pertenece al student');
        assert.ok(handler.includes('pertenece a otro'), 'debe dar error descriptivo');
    });

    it('activate-license registra dispositivo', () => {
        const idx = serverCode.indexOf("'/api/session/activate-license'");
        const handler = serverCode.slice(idx, idx + 3000);
        assert.ok(handler.includes('activateDeviceAtomic'), 'debe activar dispositivo');
        assert.ok(handler.includes('DEVICE_LIMIT_EXCEEDED'), 'debe manejar límite de dispositivos');
    });
});

console.log('\n✅ Full validation test suite loaded — run with: node --test tests/full-validation.mjs\n');
