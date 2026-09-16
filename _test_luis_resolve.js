'use strict';
// Simula el flujo del reproductor de Luis: JWT + firma HMAC + resolve-perm.
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

(async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const vid = (await pool.query("SELECT video_id,title FROM catalog WHERE status='ready' LIMIT 1")).rows[0];
    await pool.end();
    if (!vid) { console.error('No hay videos ready'); process.exit(1); }
    console.log('Video de prueba:', vid.title, vid.video_id);

    const studentId = 'adb3c240-6e18-491c-90db-c23ff8257939';
    const deviceId = 'dev_0682431aa34d96e7';
    const token = jwt.sign(
        { sub: studentId, email: 'luisadolforamoscastillo@gmail.com', studentEmail: 'luisadolforamoscastillo@gmail.com', deviceId, approved: true },
        JWT_SECRET, { expiresIn: '10m', issuer: 'reproductor-cursos' }
    );

    const perm = encryptPermToken(vid.video_id);
    const ts = Date.now();
    const sig = crypto.createHmac('sha256', APP_SECRET).update('resolve:' + ts).digest('hex');

    const res = await post('/api/playback/resolve-perm', { perm, deviceId }, {
        'Authorization': 'Bearer ' + token,
        'x-cdp-ts': String(ts),
        'x-cdp-sig': sig,
    });
    console.log('HTTP', res.status);
    try {
        const b = JSON.parse(res.body);
        console.log(JSON.stringify({ error: b.error, manifestUrl: b.manifestUrl ? 'OK (presente)' : undefined, watermarkText: b.watermarkText, sessionId: b.sessionId }, null, 2));
    } catch { console.log(res.body.slice(0, 400)); }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
