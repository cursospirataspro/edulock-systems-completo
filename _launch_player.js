'use strict';
// Genera un cdp:// URL fresco y lanza el player con él.
// Si el player ya está abierto, el mecanismo single-instance le enviará la URL.
const http  = require('http');
const path  = require('path');
const { spawn } = require('child_process');

function request(method, p, body, token) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = { 'Content-Type': 'application/json' };
        if (data) headers['Content-Length'] = Buffer.byteLength(data);
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const req = http.request({ host: 'localhost', port: 3000, path: p, method, headers }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d }); } });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function main() {
    // 1. Login admin para obtener el catálogo
    const lo = await request('POST', '/api/auth/admin-login', {
        username: 'kendorgarciafx2022@gmail.com',
        password: 'Rotermark2025.'
    });
    if (!lo.token) { console.error('Admin login failed:', JSON.stringify(lo)); process.exit(1); }

    // 2. Tomar el primer video del catálogo
    const cat = await request('GET', '/api/video/catalog', null, lo.token);
    const videos = cat.catalog || cat.videos || [];
    if (!videos.length) { console.error('No hay videos en catálogo. Ejecuta primero _test_playback.js'); process.exit(1); }
    const v = videos[0];
    console.log('Video:', v.title, '|', v.videoId);

    // 3. Login alumno de prueba
    const al = await request('POST', '/api/auth/login', {
        email:             'alumno.prueba@test.com',
        studentId:         'TEST001',
        deviceFingerprint: 'test-device-fingerprint-001',
    });
    if (!al.token) { console.error('Student login failed:', JSON.stringify(al)); process.exit(1); }

    // 4. Generar playerUrl
    const cmd = await request('POST', '/api/playback/generate-command', {
        videoId:  v.videoId,
        deviceId: 'test-device-fingerprint-001',
    }, al.token);

    if (!cmd.playerUrl) { console.error('generate-command failed:', JSON.stringify(cmd)); process.exit(1); }

    console.log('\nplayerUrl generada:');
    console.log(cmd.playerUrl.slice(0, 80) + '...');
    console.log('\nLanzando player con esta URL...\n');

    // 5. Lanzar electron con la URL como argumento.
    // Si el player ya está abierto → single-instance lock → la URL se envía al player abierto.
    // Si no está abierto → el player arranca con la URL.
    const isWin      = process.platform === 'win32';
    const electronBin = path.join(__dirname, 'player-app', 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron');
    const playerDir   = path.join(__dirname, 'player-app');
    const mainScript  = path.join(playerDir, 'main.js');

    // En Windows los .cmd requieren cmd.exe para ejecutarse
    const spawnCmd  = isWin ? 'cmd.exe' : electronBin;
    const spawnArgs = isWin ? ['/c', electronBin, mainScript, cmd.playerUrl] : [mainScript, cmd.playerUrl];

    const child = spawn(spawnCmd, spawnArgs, {
        cwd:      playerDir,
        detached: true,
        stdio:    'ignore',
    });
    child.unref();

    console.log('✓ Electron lanzado con la URL cdp://');
    console.log('  Si el player ya estaba abierto, el video debe empezar automáticamente.');
    console.log('  Si no estaba abierto, se abrirá ahora y comenzará a reproducir.\n');
    console.log('  playerToken (válido 15 min):');
    console.log(' ', cmd.playerToken.slice(0, 50) + '...');
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
