'use strict';
// Valida el fix de auto-registro: simula resolve-perm de un alumno aprobado
// SIN dispositivo registrado (elcris20050824@gmail.com). Debe devolver 200 y
// dejar su dispositivo registrado. Luego revalida el flujo de Luis.
require('dotenv').config();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Pool } = require('pg');

const JWT_SECRET = process.env.JWT_SECRET;
const APP_SECRET = process.env.APP_SECRET;

function deriveCommandKey() {
    return crypto.hkdfSync('sha256', Buffer.from(JWT_SECRET, 'utf-8'),
        Buffer.from('cdp-playback-command-salt', 'utf-8'),
        Buffer.from('playback-command-v1', 'utf-8'), 32);
}
function encryptPermToken(videoId) {
    const key = deriveCommandKey();
    const iv = crypto.createHmac('sha256', APP_SECRET || JWT_SECRET).update(videoId).digest().subarray(0, 12);
    const vidBin = Buffer.from(videoId.replace(/-/g, ''), 'hex');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(vidBin), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64url');
}
function post(path, body, headers) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const r = http.request({ host: 'localhost', port: 3000, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
            res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
        r.on('error', reject);
        r.write(data); r.end();
    });
}
async function callResolvePerm(studentId, email, deviceId, videoId) {
    const token = jwt.sign(
        { sub: studentId, email, studentEmail: email, deviceId, approved: true },
        JWT_SECRET, { expiresIn: '10m', issuer: 'reproductor-cursos' }
    );
    const ts = Date.now();
    const sig = crypto.createHmac('sha256', APP_SECRET).update('resolve:' + ts).digest('hex');
    return post('/api/playback/resolve-perm', { perm: encryptPermToken(videoId), deviceId }, {
        'Authorization': 'Bearer ' + token, 'x-cdp-ts': String(ts), 'x-cdp-sig': sig,
    });
}

(async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const vid = (await pool.query("SELECT video_id,title FROM catalog WHERE status='ready' LIMIT 1")).rows[0];

    // CASO 1: alumno sin dispositivo → auto-registro
    const cris = (await pool.query("SELECT id,email FROM students WHERE email='elcris20050824@gmail.com'")).rows[0];
    const newDevice = 'dev_test_autoreg_0001';
    const r1 = await callResolvePerm(cris.id, cris.email, newDevice, vid.video_id);
    const b1 = JSON.parse(r1.body);
    console.log(`[auto-registro] HTTP ${r1.status} →`, b1.error || 'manifestUrl OK');
    const devRow = (await pool.query('SELECT status FROM devices WHERE student_id=$1 AND fingerprint=$2', [cris.id, newDevice])).rows[0];
    console.log('[auto-registro] fila en devices:', JSON.stringify(devRow || null));

    // CASO 2: mismo alumno, SEGUNDO dispositivo → debe rechazarse (max_devices=1)
    const r2 = await callResolvePerm(cris.id, cris.email, 'dev_test_autoreg_0002', vid.video_id);
    const b2 = JSON.parse(r2.body);
    console.log(`[limite]       HTTP ${r2.status} →`, b2.error || 'INESPERADO: permitido');

    // CASO 3: Luis sigue funcionando
    const r3 = await callResolvePerm('adb3c240-6e18-491c-90db-c23ff8257939', 'luisadolforamoscastillo@gmail.com', 'dev_0682431aa34d96e7', vid.video_id);
    const b3 = JSON.parse(r3.body);
    console.log(`[luis]         HTTP ${r3.status} →`, b3.error || 'manifestUrl OK');

    // Limpieza: quitar el dispositivo de prueba para no ocupar el cupo real de Cris
    await pool.query('DELETE FROM devices WHERE fingerprint=$1', [newDevice]);
    console.log('[limpieza] dispositivo de prueba eliminado');
    await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
