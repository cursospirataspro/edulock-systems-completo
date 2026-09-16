'use strict';
const http = require('http');
const fs   = require('fs');

// ─── Helpers HTTP ─────────────────────────────────────────────────────────────
function request(method, path, body, token) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'Content-Type': 'application/json' };
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const req = http.request({ host: 'localhost', port: 3000, path, method, headers }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve(JSON.parse(d)); }
                catch { resolve({ _raw: d }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
const get  = (p, t) => request('GET',    p, null, t);
const post = (p, b, t) => request('POST',   p, b,    t);
const del  = (p, t) => request('DELETE', p, null, t);

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    // ── 1. Login admin ─────────────────────────────────────────────────────────
    console.log('\n[1] Login admin...');
    const login = await post('/api/auth/admin-login', {
        username: 'kendorgarciafx2022@gmail.com',
        password: 'Rotermark2025.'
    });
    const AT = login.token;
    if (!AT) { console.error('FALLO LOGIN ADMIN:', JSON.stringify(login)); process.exit(1); }
    console.log('    OK -', AT.slice(0, 30) + '...');

    // ── 2. Restaurar 1 video de prueba desde backup ────────────────────────────
    console.log('\n[2] Restaurando video de prueba en catálogo...');
    // Tomar el primer video del backup
    let backupRaw = fs.readFileSync('./backup_render_1421videos_2026-05-22.json', 'utf-8');
    if (backupRaw.charCodeAt(0) === 0xFEFF) backupRaw = backupRaw.slice(1);
    const backupData = JSON.parse(backupRaw);
    const allVideos  = backupData.catalog.value;
    const testVideo  = allVideos[0]; // Clase 3

    // Verificar si ya existe en catálogo
    const catalog = await get('/api/video/catalog', AT);
    const exists = (catalog.catalog || catalog.videos || []).find(v => v.videoId === testVideo.videoId);

    if (exists) {
        console.log('    Ya existe:', testVideo.title, '(' + testVideo.videoId + ')');
    } else {
        // Restaurar via add-bunny (que acepta URL real de Bunny)
        const addRes = await post('/api/catalog/add-bunny', {
            title:    testVideo.title,
            bunnyUrl: testVideo.bunnyUrl,
        }, AT);
        if (addRes.error) {
            console.error('    ERROR add-bunny:', JSON.stringify(addRes));
            process.exit(1);
        }
        // El videoId asignado por el servidor puede ser diferente; usar el retornado
        testVideo.videoId = addRes.videoId || testVideo.videoId;
        console.log('    Añadido:', testVideo.title, '| videoId:', testVideo.videoId);
    }

    // ── 3. Crear alumno de prueba (si no existe) ───────────────────────────────
    console.log('\n[3] Creando alumno de prueba...');
    const TEST_EMAIL = 'alumno.prueba@test.com';
    const TEST_ID    = 'TEST001';

    const students = await get('/api/students', AT);
    const existing = (students.students || []).find(s => s.email === TEST_EMAIL);

    let student;
    if (existing) {
        student = existing;
        console.log('    Ya existe:', student.email, '| id:', student.id);
    } else {
        const cr = await post('/api/students', {
            email:         TEST_EMAIL,
            studentId:     TEST_ID,
            name:          'Alumno de Prueba',
            active:        true,
            allowedVideos: ['*'],
        }, AT);
        if (cr.error) { console.error('    ERROR crear alumno:', JSON.stringify(cr)); process.exit(1); }
        student = cr.student;
        console.log('    Creado:', student.email, '| id:', student.id);
    }

    // ── 4. Login como alumno ───────────────────────────────────────────────────
    console.log('\n[4] Login como alumno...');
    const studentLogin = await post('/api/auth/login', {
        email:             student.email,
        studentId:         student.studentId || TEST_ID,
        deviceFingerprint: 'test-device-fingerprint-001',
    });
    const ST = studentLogin.token;
    if (!ST) {
        console.error('    ERROR login alumno:', JSON.stringify(studentLogin));
        process.exit(1);
    }
    console.log('    OK -', ST.slice(0, 30) + '...');

    // ── 5. Obtener videoId activo del catálogo ─────────────────────────────────
    const catalog2 = await get('/api/video/catalog', AT);
    const catList = catalog2.catalog || catalog2.videos || [];
    const videoEntry = catList.find(v => v.title === testVideo.title) || catList[0];
    if (!videoEntry) { console.error('No hay videos en catálogo'); process.exit(1); }
    const videoId = videoEntry.videoId;
    console.log('\n[5] Video seleccionado:', videoEntry.title, '| videoId:', videoId);

    // ── 6. Generar comando cdp:// ──────────────────────────────────────────────
    console.log('\n[6] Generando playerUrl cdp://...');
    const cmdRes = await post('/api/playback/generate-command', {
        videoId,
        deviceId: 'test-device-fingerprint-001',
    }, ST);

    if (cmdRes.error) {
        console.error('    ERROR generate-command:', JSON.stringify(cmdRes));
        process.exit(1);
    }

    console.log('\n════════════════════════════════════════════════════════');
    console.log('  VIDEO     :', videoEntry.title);
    console.log('  ALUMNO    :', student.email, '(' + (student.studentId || TEST_ID) + ')');
    console.log('  sessionId :', cmdRes.sessionId);
    console.log('  expiresIn :', cmdRes.expiresIn, 'segundos (15 min)');
    console.log('\n  ► playerUrl (cdp://):\n');
    console.log('  ' + cmdRes.playerUrl);
    console.log('\n  ► playerToken JWT:\n  ' + cmdRes.playerToken);
    console.log('════════════════════════════════════════════════════════');

    // ── 7. Simular resolve (lo que haría el player Electron) ──────────────────
    // El player usa: Authorization: Bearer <playerToken>
    //                body: { command: "cdp://..." }
    console.log('\n[7] Simulando resolve del player...');

    // Extraer cmd del playerUrl  (cdp://play?cmd=cdp%3A%2F%2F...&auth=JWT)
    const qs = cmdRes.playerUrl.replace('cdp://play?', '');
    const params = new URLSearchParams(qs);
    const rawCommand = params.get('cmd');   // el comando cdp://... completo
    const playerToken = cmdRes.playerToken; // JWT de 15 min

    const resolveRes = await post('/api/playback/resolve', {
        command: rawCommand,   // body: { command: "cdp://..." }
    }, playerToken);           // Authorization: Bearer <playerToken>

    if (resolveRes.error) {
        console.error('\n    ERROR resolve:', JSON.stringify(resolveRes));
        process.exit(1);
    }

    console.log('\n════════════════════════════════════════════════════════');
    console.log('  ✓ RESOLVE OK — el player puede reproducir este video');
    console.log('  manifestUrl  :', resolveRes.manifestUrl);
    console.log('  watermarkText:', resolveRes.watermarkText);
    console.log('  studentCode  :', resolveRes.studentCode);
    console.log('  sessionId    :', resolveRes.sessionId);
    console.log('  ttl          :', resolveRes.ttl, 'seg');
    console.log('════════════════════════════════════════════════════════');

    console.log('\n✓ PRUEBA COMPLETA. El flujo cdp:// funciona correctamente.');
    console.log('\n  Para abrir en el player Electron:\n');
    console.log('  cd player-app && npm start');
    console.log('  Luego el player recibirá el cdp:// automáticamente.\n');
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
