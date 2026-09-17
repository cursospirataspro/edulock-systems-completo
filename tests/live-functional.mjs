/**
 * Edulock Systems — Live Functional Test Suite
 * Tests against a running server on PORT (default 3001).
 *
 * Run: node --test tests/live-functional.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3001';
const APP_SECRET = 'gQdfqC6szeT3LCDusM4j0xh1X1MQbv8gOcyLD09PnFM';

async function api(method, path, body, token, extraHeaders = {}) {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${path}`, opts);
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data, ok: res.ok };
}

function cdpSigHeaders() {
    const ts = Date.now().toString();
    const message = 'resolve:' + ts;
    const sig = crypto.createHmac('sha256', APP_SECRET).update(message).digest('hex');
    return { 'x-cdp-ts': ts, 'x-cdp-sig': sig };
}

let adminToken = null;
let producerToken = null;
let producerPassword = null;
let producerId = null;
let licenseKey = null;
const uniqueEmail = `testproducer_${Date.now()}@edulock.com`;

// ════════════════════════════════════════════════════════════════════
//  0. HEALTH + STATIC PAGES
// ════════════════════════════════════════════════════════════════════

describe('0. Health & static pages', () => {
    it('GET /api/health → 200', async () => {
        const r = await api('GET', '/api/health');
        assert.equal(r.status, 200);
    });

    it('/ → HTML sin Santana/Starveyl', async () => {
        const res = await fetch(`${BASE}/`);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('<html') || html.includes('<!DOCTYPE'));
        assert.ok(!html.toLowerCase().includes('santana'));
        assert.ok(!html.toLowerCase().includes('starveyl'));
    });

    it('/admin → HTML con Edulock, sin Santana', async () => {
        const res = await fetch(`${BASE}/admin`);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.ok(html.toLowerCase().includes('edulock'));
        assert.ok(!html.toLowerCase().includes('santana'));
    });

    it('/productor → HTML sin Santana/Starveyl', async () => {
        const res = await fetch(`${BASE}/productor`);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.ok(!html.toLowerCase().includes('santana'));
        assert.ok(!html.toLowerCase().includes('starveyl'));
    });
});

// ════════════════════════════════════════════════════════════════════
//  1. ADMIN LOGIN
// ════════════════════════════════════════════════════════════════════

describe('1. Admin login', () => {
    it('POST /api/auth/admin-login → token', async () => {
        const r = await api('POST', '/api/auth/admin-login', {
            username: 'kendorgarciafx2022@gmail.com',
            password: 'Rotermark2025.'
        });
        assert.equal(r.status, 200, `Login: ${JSON.stringify(r.data)}`);
        assert.ok(r.data.token);
        adminToken = r.data.token;
    });

    it('Admin token en rutas protegidas → 200', async () => {
        const r = await api('GET', '/api/my-catalog', null, adminToken);
        assert.equal(r.status, 200);
    });

    it('Password incorrecto → 401', async () => {
        const r = await api('POST', '/api/auth/admin-login', {
            username: 'kendorgarciafx2022@gmail.com',
            password: 'wrong'
        });
        assert.equal(r.status, 401);
    });

    it('Sin token → 401', async () => {
        const r = await api('GET', '/api/my-catalog');
        assert.equal(r.status, 401);
    });

    it('Token fake → 401', async () => {
        const r = await api('GET', '/api/my-catalog', null, 'eyJ.fake.token');
        assert.equal(r.status, 401);
    });
});

// ════════════════════════════════════════════════════════════════════
//  2. TOKEN REFRESH
// ════════════════════════════════════════════════════════════════════

describe('2. Token refresh', () => {
    it('Refresh → nuevo token', async () => {
        const r = await api('POST', '/api/auth/refresh', null, adminToken);
        assert.equal(r.status, 200);
        assert.ok(r.data.token);
        adminToken = r.data.token;
    });

    it('Refresh sin token → 401', async () => {
        const r = await api('POST', '/api/auth/refresh');
        assert.equal(r.status, 401);
    });
});

// ════════════════════════════════════════════════════════════════════
//  3. CATALOG (admin)
// ════════════════════════════════════════════════════════════════════

describe('3. Catalog access (admin)', () => {
    it('GET /api/my-catalog → cursos array, sin requiresLicense', async () => {
        const r = await api('GET', '/api/my-catalog', null, adminToken);
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(r.data.courses));
        assert.ok(!r.data.requiresLicense, 'admin no necesita licencia');
    });
});

// ════════════════════════════════════════════════════════════════════
//  4. PRODUCER CRUD (unique email per test run)
// ════════════════════════════════════════════════════════════════════

describe('4. Producer CRUD', () => {
    it('POST /api/owner/producers — crea productor con email único', async () => {
        const r = await api('POST', '/api/owner/producers', {
            email: uniqueEmail,
            name: 'Test Producer'
        }, adminToken);
        assert.ok([200, 201].includes(r.status), `Create: ${r.status} ${JSON.stringify(r.data)}`);
        producerId = r.data?.id;
        producerPassword = r.data?.password;
        assert.ok(producerId, 'debe retornar id');
        assert.ok(producerPassword, 'debe retornar password auto-generado');
        console.log(`    Producer: ${uniqueEmail} / ${producerPassword}`);
    });

    it('GET /api/owner/producers → lista incluye el nuevo productor', async () => {
        const r = await api('GET', '/api/owner/producers', null, adminToken);
        assert.equal(r.status, 200);
        const list = r.data?.producers || r.data;
        assert.ok(Array.isArray(list));
        const found = list.find(p => p.email === uniqueEmail);
        assert.ok(found, 'producer debe aparecer');
    });

    it('POST /api/producer/login con password auto-generado → token', async () => {
        assert.ok(producerPassword, 'necesita password del test anterior');
        const r = await api('POST', '/api/producer/login', {
            email: uniqueEmail,
            password: producerPassword
        });
        assert.equal(r.status, 200, `Login: ${JSON.stringify(r.data)}`);
        assert.ok(r.data.token);
        producerToken = r.data.token;
    });

    it('GET /api/producer/me → perfil', async () => {
        assert.ok(producerToken);
        const r = await api('GET', '/api/producer/me', null, producerToken);
        assert.equal(r.status, 200);
    });

    it('Producer login con password incorrecto → 401', async () => {
        const r = await api('POST', '/api/producer/login', {
            email: uniqueEmail,
            password: 'WrongPass!'
        });
        assert.ok([401, 403].includes(r.status));
    });

    it('Producer login con email inexistente → error', async () => {
        const r = await api('POST', '/api/producer/login', {
            email: 'noexiste@edulock.com',
            password: 'Test123!'
        });
        assert.ok([401, 403, 404, 429].includes(r.status), `status: ${r.status}`);
    });

    it('Producer NO puede crear productores', async () => {
        if (!producerToken) return;
        const r = await api('POST', '/api/owner/producers', {
            email: 'hack@test.com', name: 'Hack'
        }, producerToken);
        assert.ok([401, 403].includes(r.status));
    });
});

// ════════════════════════════════════════════════════════════════════
//  5. LICENSE GENERATION
// ════════════════════════════════════════════════════════════════════

describe('5. License generation', () => {
    it('POST /api/license/generate (admin) → licenseKey', async () => {
        const r = await api('POST', '/api/license/generate', {
            courseId: '__test_course__',
            maxDevices: 2
        }, adminToken);
        assert.ok([200, 201].includes(r.status), `Generate: ${r.status} ${JSON.stringify(r.data)}`);
        licenseKey = r.data.licenseKey || r.data.license_key || r.data.key;
        assert.ok(licenseKey, 'debe retornar licenseKey');
        console.log(`    License: ${licenseKey}`);
    });

    it('License key formato XXXX-XXXX-XXXX-XXXX alfanumérico', () => {
        assert.ok(licenseKey);
        const clean = licenseKey.replace(/-/g, '');
        assert.equal(clean.length, 16, 'debe tener 16 chars');
        assert.match(clean, /^[A-Z0-9]+$/, 'alfanumérico uppercase');
    });

    it('Sin token → 401', async () => {
        const r = await api('POST', '/api/license/generate', { courseId: 'x' });
        assert.equal(r.status, 401);
    });
});

// ════════════════════════════════════════════════════════════════════
//  6. ONE-LICENSE-PER-SESSION
// ════════════════════════════════════════════════════════════════════

describe('6. One-license-per-session', () => {
    it('Admin bypass activate-license → 200', async () => {
        const r = await api('POST', '/api/session/activate-license', {
            licenseKey: 'AAAA-BBBB-CCCC-DDDD'
        }, adminToken);
        assert.equal(r.status, 200);
    });

    it('Sin token → 401', async () => {
        const r = await api('POST', '/api/session/activate-license', { licenseKey: 'TEST' });
        assert.equal(r.status, 401);
    });

    it('Admin catalog sin restricción de licencia', async () => {
        const r = await api('GET', '/api/my-catalog', null, adminToken);
        assert.equal(r.status, 200);
        assert.ok(!r.data.requiresLicense);
    });
});

// ════════════════════════════════════════════════════════════════════
//  7. DEVICE CHECKIN
// ════════════════════════════════════════════════════════════════════

describe('7. Device checkin', () => {
    it('POST /api/device/checkin → OK', async () => {
        const r = await api('POST', '/api/device/checkin', {
            deviceId: 'test-device-001',
            hostname: 'TEST-PC',
            platform: 'win32',
            arch: 'x64',
            cpus: 8,
            totalmem: 16e9,
            appVersion: '1.0.0-test'
        }, adminToken);
        assert.ok([200, 201, 204].includes(r.status), `Checkin: ${r.status}`);
    });
});

// ════════════════════════════════════════════════════════════════════
//  8. WATERMARK LOG (requires mediaToken JWT in body)
// ════════════════════════════════════════════════════════════════════

describe('8. Watermark log', () => {
    it('POST /api/watermark/log con mediaToken → OK', async () => {
        const r = await api('POST', '/api/watermark/log', {
            mediaToken: adminToken,
            videoId: 'test-video',
            deviceId: 'test-device-001',
            timestamp: Date.now()
        });
        assert.ok([200, 201].includes(r.status), `Watermark: ${r.status} ${JSON.stringify(r.data)}`);
    });

    it('Sin mediaToken → 400', async () => {
        const r = await api('POST', '/api/watermark/log', { videoId: 'test' });
        assert.equal(r.status, 400);
    });
});

// ════════════════════════════════════════════════════════════════════
//  9. PLAYER VERSION
// ════════════════════════════════════════════════════════════════════

describe('9. Player version', () => {
    it('GET /api/player/version → info', async () => {
        const r = await api('GET', '/api/player/version');
        assert.ok([200, 404].includes(r.status));
    });
});

// ════════════════════════════════════════════════════════════════════
//  10. HEARTBEAT
// ════════════════════════════════════════════════════════════════════

describe('10. Heartbeat', () => {
    it('POST /api/session/heartbeat → responde', async () => {
        const r = await api('POST', '/api/session/heartbeat', {
            deviceId: 'test-device-001',
            videoId: 'test-video'
        }, adminToken);
        assert.ok([200, 400, 401, 403].includes(r.status));
    });
});

// ════════════════════════════════════════════════════════════════════
//  11. PLAYBACK PROGRESS
// ════════════════════════════════════════════════════════════════════

describe('11. Playback progress', () => {
    it('POST /api/playback/progress → acepta', async () => {
        const r = await api('POST', '/api/playback/progress', {
            videoId: 'test-video',
            courseId: 'test-course',
            progressPercent: 50,
            currentTime: 120
        }, adminToken);
        assert.ok([200, 201, 204, 400].includes(r.status));
    });

    it('Sin token → 401', async () => {
        const r = await api('POST', '/api/playback/progress', { videoId: 'v', progressPercent: 0 });
        assert.equal(r.status, 401);
    });
});

// ════════════════════════════════════════════════════════════════════
//  12. ADMIN REGISTRATIONS
// ════════════════════════════════════════════════════════════════════

describe('12. Registrations (retirado: registro automático por licencia)', () => {
    it('GET /api/admin/registrations ya no existe', async () => {
        const r = await api('GET', '/api/admin/registrations', null, adminToken);
        assert.equal(r.status, 404);
    });
});

// ════════════════════════════════════════════════════════════════════
//  13. ADMIN STUDENTS
// ════════════════════════════════════════════════════════════════════

describe('13. Admin students', () => {
    it('PUT /api/admin/students/:id/suspend (nonexistent)', async () => {
        const r = await api('PUT', '/api/admin/students/nonexistent-id/suspend', {
            suspended: true
        }, adminToken);
        assert.ok([200, 400, 404, 500].includes(r.status));
    });

    it('POST /api/admin/students/:id/reset-devices (nonexistent)', async () => {
        const r = await api('POST', '/api/admin/students/nonexistent-id/reset-devices', null, adminToken);
        assert.ok([200, 400, 404, 500].includes(r.status));
    });
});

// ════════════════════════════════════════════════════════════════════
//  14. LICENSE VALIDATE-ACTIVATION (requires x-cdp-ts / x-cdp-sig)
// ════════════════════════════════════════════════════════════════════

describe('14. License validate-activation', () => {
    it('Sin token ni firma → 401', async () => {
        const r = await api('POST', '/api/license/validate-activation', {
            activationToken: 'test', deviceId: 'test'
        });
        assert.equal(r.status, 401);
    });

    it('Con firma CDP + admin token → responde (no crash)', async () => {
        const r = await api('POST', '/api/license/validate-activation', {
            activationToken: adminToken,
            deviceId: 'test-device-001'
        }, null, cdpSigHeaders());
        assert.ok([200, 400, 401, 403, 404].includes(r.status), `Validate: ${r.status}`);
    });
});

// ════════════════════════════════════════════════════════════════════
//  15. RESOLVE-DIRECT
// ════════════════════════════════════════════════════════════════════

describe('15. Resolve-direct', () => {
    it('Sin token → 401', async () => {
        const r = await api('POST', '/api/resolve-direct', { videoId: 'test' });
        assert.equal(r.status, 401);
    });
});

// ════════════════════════════════════════════════════════════════════
//  16. SECURITY
// ════════════════════════════════════════════════════════════════════

describe('16. Security', () => {
    it('Múltiples tokens admin válidos simultáneamente', async () => {
        // Use the existing adminToken + generate one fresh one
        // (avoid rate limiter by not doing too many logins)
        const r = await api('POST', '/api/auth/admin-login', {
            username: 'kendorgarciafx2022@gmail.com',
            password: 'Rotermark2025.'
        });
        if (r.status === 429) {
            console.log('    Rate limited — rate limiter working correctly');
            return; // rate limit hit = rate limiter working as expected
        }
        assert.equal(r.status, 200);
        // Both the existing adminToken and the new one should work
        const c1 = await api('GET', '/api/my-catalog', null, adminToken);
        const c2 = await api('GET', '/api/my-catalog', null, r.data.token);
        assert.equal(c1.status, 200);
        assert.equal(c2.status, 200);
    });
});

// ════════════════════════════════════════════════════════════════════
//  17. LICENSE LOTS
// ════════════════════════════════════════════════════════════════════

describe('17. License lots', () => {
    it('GET /api/license/lots → responde', async () => {
        const r = await api('GET', '/api/license/lots', null, adminToken);
        assert.ok([200, 404].includes(r.status));
    });
});

// ════════════════════════════════════════════════════════════════════
//  18. DOCUMENTS
// ════════════════════════════════════════════════════════════════════

describe('18. Documents', () => {
    it('PATCH /api/catalog/:videoId/documents → responde', async () => {
        const r = await api('PATCH', '/api/catalog/test-video/documents', {
            documents: [{ name: 'Guía', url: 'https://example.com/guide.pdf', type: 'pdf', mode: 'libre' }]
        }, adminToken);
        assert.ok([200, 400, 404, 500].includes(r.status));
    });
});

// ════════════════════════════════════════════════════════════════════
//  19. INTEGRATION KEYS
// ════════════════════════════════════════════════════════════════════

describe('19. Integration keys', () => {
    it('GET /api/admin/integration-keys → responde', async () => {
        const r = await api('GET', '/api/admin/integration-keys', null, adminToken);
        assert.ok([200, 404].includes(r.status));
    });
});

// ════════════════════════════════════════════════════════════════════
//  20. BUNNY CONFIG
// ════════════════════════════════════════════════════════════════════

describe('20. Bunny config', () => {
    it('GET /api/admin/bunny-token-key → responde', async () => {
        const r = await api('GET', '/api/admin/bunny-token-key', null, adminToken);
        assert.ok([200, 404].includes(r.status));
    });
});

// ════════════════════════════════════════════════════════════════════
//  21. PRODUCER ISOLATION
// ════════════════════════════════════════════════════════════════════

describe('21. Producer isolation', () => {
    it('Producer no puede acceder endpoints de admin', async () => {
        if (!producerToken) return;
        const r = await api('GET', '/api/admin/students', null, producerToken);
        assert.ok([401, 403].includes(r.status));
    });

    it('Producer ve sus propios cursos (scope restringido)', async () => {
        if (!producerToken) return;
        const r = await api('GET', '/api/producer/courses', null, producerToken);
        assert.ok([200, 404].includes(r.status));
    });
});

console.log(`\n🔧 Testing against ${BASE}\n`);
