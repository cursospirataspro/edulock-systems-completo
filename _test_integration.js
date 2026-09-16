'use strict';
require('dotenv').config();
const http = require('http');
const db = require('./database.js');

function post(path, data, token) {
    return new Promise((res,rej) => {
        const body = JSON.stringify(data);
        const headers = {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const opts = { hostname:'localhost', port:3000, path, method:'POST', headers };
        const req = http.request(opts, r => {
            let d=''; r.on('data',c=>d+=c); r.on('end',()=>res({status:r.statusCode,body:d}));
        });
        req.on('error',rej);
        req.setTimeout(5000, () => { req.destroy(); rej(new Error('timeout')); });
        req.write(body); req.end();
    });
}
function get(path, token) {
    return new Promise((res,rej) => {
        const headers = {};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const opts = { hostname:'localhost', port:3000, path, method:'GET', headers };
        const req = http.request(opts, r => {
            let d=''; r.on('data',c=>d+=c); r.on('end',()=>res({status:r.statusCode,body:d}));
        });
        req.on('error',rej);
        req.setTimeout(5000, () => { req.destroy(); rej(new Error('timeout')); });
        req.end();
    });
}
function put(path, data, token) {
    return new Promise((res,rej) => {
        const body = JSON.stringify(data || {});
        const headers = {'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const opts = { hostname:'localhost', port:3000, path, method:'PUT', headers };
        const req = http.request(opts, r => {
            let d=''; r.on('data',c=>d+=c); r.on('end',()=>res({status:r.statusCode,body:d}));
        });
        req.on('error',rej);
        req.setTimeout(5000, () => { req.destroy(); rej(new Error('timeout')); });
        req.write(body); req.end();
    });
}

let passed = 0, failed = 0;
function check(name, condition, detail) {
    if (condition) { console.log('  ✓', name, detail ? '| ' + detail : ''); passed++; }
    else           { console.log('  ✗', name, detail ? '| ' + detail : ''); failed++; }
}

async function main() {
    console.log('\n=== TEST DE INTEGRACIÓN — Edulock Systems ===\n');

    // ── 1. Servidor responde ────────────────────────────────────────
    console.log('--- 1. Servidor y endpoints existentes ---');
    const health = await get('/api/health');
    check('/api/health', health.status === 200, 'status=' + health.status);
    const embed  = await get('/api/embed-status');
    check('/api/embed-status', embed.status === 200, 'status=' + embed.status);

    // ── 2. Auth anónima (sin romper nada) ──────────────────────────
    console.log('\n--- 2. Auth anónima (endpoint existente) ---');
    const autoRes  = await get('/api/auth/auto?did=test-device-security-001');
    check('/api/auth/auto', autoRes.status === 200, 'has token=' + !!JSON.parse(autoRes.body).token);
    const anonToken = JSON.parse(autoRes.body).token;

    const autoRes2 = await get('/api/auth/auto?did=test-device-security-002');
    check('/api/auth/auto (second device)', autoRes2.status === 200);
    const anonToken2 = JSON.parse(autoRes2.body).token;

    // ── 3. Nuevos endpoints sin auth → rechazar ────────────────────
    console.log('\n--- 3. Nuevos endpoints sin auth (deben rechazar) ---');
    check('/api/playback/generate-command (no auth)', (await post('/api/playback/generate-command', {})).status === 401);
    check('/api/playback/resolve (no auth)',          (await post('/api/playback/resolve', {})).status === 401);
    check('/api/playback/progress (no auth)',         (await post('/api/playback/progress', {})).status === 401);
    check('/api/playback/event-secure (no auth)',     (await post('/api/playback/event-secure', {})).status === 401);
    check('/api/suspicious-activity (no auth)',       (await get('/api/suspicious-activity')).status === 403);
    check('/api/playback/progress-all (no auth)',     (await get('/api/playback/progress-all')).status === 403);
    check('/api/student/code (no auth)',              (await get('/api/student/code')).status === 401);

    // ── 4. /api/student/code con token ────────────────────────────
    console.log('\n--- 4. Código de alumno para watermark ---');
    const codeRes  = await get('/api/student/code', anonToken);
    const codeData = JSON.parse(codeRes.body);
    check('/api/student/code', codeRes.status === 200, 'code=' + codeData.code);
    check('Code formato CDP-XXXXX', /^CDP-[A-Z0-9]{5}$/.test(codeData.code || ''), codeData.code);

    // Mismo alumno, mismo código (idempotente)
    const codeRes2 = await get('/api/student/code', anonToken);
    check('Code idempotente (mismo token)', JSON.parse(codeRes2.body).code === codeData.code);

    // ── 5. Eventos de seguridad con token ─────────────────────────
    console.log('\n--- 5. Eventos de seguridad ---');
    const testVid = '00000000-0000-4000-a000-000000000001';
    const evtPlay = await post('/api/playback/event-secure', { videoId: testVid, eventType: 'play', progressPercent: 10, currentTime: 60 }, anonToken);
    check('/api/playback/event-secure (play)', evtPlay.status === 200);
    const evtPause = await post('/api/playback/event-secure', { videoId: testVid, eventType: 'pause', progressPercent: 25, currentTime: 150 }, anonToken);
    check('/api/playback/event-secure (pause)', evtPause.status === 200);
    const evtDt = await post('/api/playback/event-secure', { videoId: testVid, eventType: 'devtools_open', metadata: { description: 'Integration test' } }, anonToken);
    check('/api/playback/event-secure (devtools_open)', evtDt.status === 200);
    const evtRec = await post('/api/playback/event-secure', { videoId: testVid, eventType: 'screen_recording_detected', metadata: { method: 'test' } }, anonToken);
    check('/api/playback/event-secure (screen_recording)', evtRec.status === 200);
    // Evento inválido → 200 (acepta cualquier eventType que esté en la lista)
    const evtBad = await post('/api/playback/event-secure', { videoId: testVid, eventType: 'invalid_type_xyz' }, anonToken);
    check('/api/playback/event-secure (invalid type)', evtBad.status === 200); // acepta silenciosamente (event filtrado en DB)

    // ── 6. Progreso con token ─────────────────────────────────────
    console.log('\n--- 6. Progreso de reproducción ---');
    const prog1 = await post('/api/playback/progress', { videoId: testVid, progressPercent: 35, currentTime: 210 }, anonToken);
    check('/api/playback/progress (35%)', prog1.status === 200);
    const prog2 = await post('/api/playback/progress', { videoId: testVid, progressPercent: 72, currentTime: 432 }, anonToken);
    check('/api/playback/progress (72%)', prog2.status === 200);
    // Verificar directamente en BD que se guardó
    const anonSub = JSON.parse(Buffer.from(anonToken.split('.')[1], 'base64url').toString()).sub;
    const savedProgress = db.getProgress(anonSub, testVid);
    check('Progreso guardado en BD', savedProgress != null, 'pct=' + savedProgress?.progress_percent);
    check('Progreso acumulativo (no regresión)', (savedProgress?.progress_percent || 0) >= 72);

    // ── 7. Sistema de comandos cifrados ───────────────────────────
    console.log('\n--- 7. Sistema de comandos cifrados ---');
    const catalog = db.loadCatalog();
    const readyVid = catalog.find(v => v.status === 'ready');

    if (readyVid) {
        console.log('  ℹ Video de prueba:', readyVid.videoId.slice(0,12) + '...' , readyVid.title?.slice(0,30));

        // generate-command
        const genRes  = await post('/api/playback/generate-command', { videoId: readyVid.videoId }, anonToken);
        const genData = JSON.parse(genRes.body);
        check('/api/playback/generate-command (200)', genRes.status === 200, 'status=' + genRes.status);
        check('Command tiene prefijo cdp://', !!genData.command?.startsWith('cdp://'));
        check('Command no contiene URL real', !genData.command?.includes('.m3u8') && !genData.command?.includes('http'));
        check('Command no contiene el videoId en claro', !genData.command?.includes(readyVid.videoId));
        check('Command tiene expiresIn=900', genData.expiresIn === 900);

        // resolve
        const resolveRes  = await post('/api/playback/resolve', { command: genData.command }, anonToken);
        const resolveData = JSON.parse(resolveRes.body);
        check('/api/playback/resolve (200)', resolveRes.status === 200, 'status=' + resolveRes.status);
        check('manifestUrl presente', !!resolveData.manifestUrl);
        check('studentCode presente', !!resolveData.studentCode, resolveData.studentCode);
        check('watermarkText incluye CDP-', resolveData.watermarkText?.includes('CDP-'), resolveData.watermarkText?.slice(0,50));
        check('mediaToken presente', !!resolveData.mediaToken);
        check('sessionId presente', !!resolveData.sessionId);

        // Anti-replay: mismo comando → debe fallar con 401
        const replayRes = await post('/api/playback/resolve', { command: genData.command }, anonToken);
        check('Anti-replay (401)', replayRes.status === 401, 'status=' + replayRes.status);
        check('Anti-replay message correcto', JSON.parse(replayRes.body).error?.includes('ya fue utilizado'));

        // Comando con tampering → debe fallar
        const tampered = genData.command.slice(0, -8) + 'AAAAAAAA';
        const tamperedRes = await post('/api/playback/resolve', { command: tampered }, anonToken);
        check('Tampering detectado', tamperedRes.status === 401, 'status=' + tamperedRes.status);

        // Nuevo comando con segundo token (diferente alumno) → debe fallar
        const gen2Res = await post('/api/playback/generate-command', { videoId: readyVid.videoId }, anonToken);
        if (gen2Res.status === 200) {
            const cmd2 = JSON.parse(gen2Res.body).command;
            // Intentar usar el comando del alumno 1 con el token del alumno 2
            const wrongUserRes = await post('/api/playback/resolve', { command: cmd2 }, anonToken2);
            // Nota: ambos son "guest" con sub diferente, así que debe fallar
            check('Student mismatch detectado', wrongUserRes.status === 403 || wrongUserRes.status === 401,
                'status=' + wrongUserRes.status + ' (expected 401/403 - different studentId)');
        }

        // Progreso después de resolve
        const prog3 = await post('/api/playback/progress', { videoId: readyVid.videoId, progressPercent: 55, currentTime: 330 }, anonToken);
        check('/api/playback/progress post-resolve', prog3.status === 200);

    } else {
        console.log('  ℹ Sin videos con status=ready — probando generate-command con video no existente');
        const genNoVid = await post('/api/playback/generate-command', { videoId: '00000000-0000-4000-a000-ffffffffffff' }, anonToken);
        check('generate-command con video no existente (404)', genNoVid.status === 404, 'status=' + genNoVid.status);
    }

    // ── 8. Actividad sospechosa en BD ─────────────────────────────
    console.log('\n--- 8. Actividad sospechosa (validación directa BD) ---');
    const suspAll = db.getSuspiciousActivity(50);
    check('Suspicious activity registrada', suspAll.length > 0, 'entries=' + suspAll.length);
    const dtEvents = suspAll.filter(s => s.type === 'devtools_open');
    const recEvents = suspAll.filter(s => s.type === 'screen_recording_detected');
    check('DevTools registrado', dtEvents.length > 0);
    check('Screen recording registrado', recEvents.length > 0);
    const unreviewed = db.countUnreviewed();
    check('Hay eventos sin revisar', unreviewed > 0, 'count=' + unreviewed);
    // Marcar como revisado
    if (suspAll.length > 0) {
        db.markSuspiciousReviewed(suspAll[0].id);
        check('markSuspiciousReviewed funciona', db.countUnreviewed() === unreviewed - 1);
    }

    // ── 9. Límite de dispositivos (BD directa) ────────────────────
    console.log('\n--- 9. Límite de 3 dispositivos ---');
    const testStudentId = 'device-test-student-xyz';
    db.resetStudentDevices(testStudentId);
    const d1 = db.registerOrValidateDevice(testStudentId, 'fp-AAA', { browser: 'Chrome' }, 3);
    check('Device 1 registrado', d1.ok && d1.reason === 'new');
    const d2 = db.registerOrValidateDevice(testStudentId, 'fp-BBB', { browser: 'Firefox' }, 3);
    check('Device 2 registrado', d2.ok && d2.reason === 'new');
    const d3 = db.registerOrValidateDevice(testStudentId, 'fp-CCC', { browser: 'Edge' }, 3);
    check('Device 3 registrado', d3.ok && d3.reason === 'new');
    const d4 = db.registerOrValidateDevice(testStudentId, 'fp-DDD', { browser: 'Brave' }, 3);
    check('Device 4 BLOQUEADO', !d4.ok && d4.reason === 'device_limit_exceeded');
    // Device existente debe seguir funcionando
    const d1Again = db.registerOrValidateDevice(testStudentId, 'fp-AAA', {}, 3);
    check('Device 1 sigue activo post-bloqueo', d1Again.ok && d1Again.reason === 'existing');
    check('countActiveDevices = 3', db.countActiveDevices(testStudentId) === 3);

    // ── 10. Nonces anti-replay (BD directa) ───────────────────────
    console.log('\n--- 10. Anti-replay de nonces ---');
    const nonce1 = 'test-nonce-' + Date.now();
    check('Nonce nuevo consumido', db.consumeNonce(nonce1) === true);
    check('Nonce replay bloqueado', db.consumeNonce(nonce1) === false);
    const nonce2 = 'test-nonce-' + (Date.now() + 1);
    check('Nonce diferente OK', db.consumeNonce(nonce2) === true);

    // ── 11. Códigos de alumno únicos ──────────────────────────────
    console.log('\n--- 11. Códigos de alumno únicos ---');
    const code1 = db.getOrCreateStudentCode('student-code-test-001');
    const code2 = db.getOrCreateStudentCode('student-code-test-002');
    check('Código generado formato CDP-', /^CDP-[A-Z0-9]{5}$/.test(code1), code1);
    check('Códigos diferentes por alumno', code1 !== code2, code1 + ' vs ' + code2);
    check('Código idempotente', db.getOrCreateStudentCode('student-code-test-001') === code1);

    // ── 12. Verificar que endpoints EXISTENTES siguen intactos ────
    console.log('\n--- 12. Compatibilidad con flujo existente ---');
    // El endpoint /api/video/:id/play existente sigue devolviendo manifestUrl directa
    // (sin pasar por el nuevo sistema de comandos) — backward compat total
    const catalog2 = db.loadCatalog();
    if (catalog2.find(v => v.status === 'ready')) {
        const vid = catalog2.find(v => v.status === 'ready');
        const playRes = await get('/api/video/' + vid.videoId + '/play', anonToken);
        check('/api/video/:id/play (flujo existente)', playRes.status === 200 || playRes.status === 403,
            'status=' + playRes.status + ' (200=ok, 403=video restringido)');
    } else {
        console.log('  ℹ Sin videos ready — omitiendo prueba de flujo existente');
    }

    // Session heartbeat existente sigue funcionando
    const heartbeatRes = await post('/api/session/heartbeat', { sessionId: 'nonexistent', mediaToken: 'invalid' });
    check('/api/session/heartbeat (flujo existente)', heartbeatRes.status === 401 || heartbeatRes.status === 400,
        'status=' + heartbeatRes.status);

    // ── Resumen ────────────────────────────────────────────────────
    console.log('\n=========================================');
    console.log('  PASADOS:', passed, '| FALLIDOS:', failed);
    if (failed === 0) {
        console.log('  ✅ TODOS LOS TESTS PASARON — SIN BUGS');
    } else {
        console.log('  ⚠️  HAY FALLOS — REVISAR ARRIBA');
    }
    console.log('=========================================\n');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('\n✗ ERROR FATAL:', e.message, e.stack?.split('\n')[1]);
    process.exit(1);
});
