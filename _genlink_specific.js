'use strict';
/**
 * _genlink_specific.js — genera short-token DEV para un video específico.
 * Uso: node _genlink_specific.js
 */
require('dotenv').config();
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path     = require('path');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('ERROR: JWT_SECRET no en .env'); process.exit(1); }

const db = new Database(path.join(__dirname, 'data', 'app.db'));

// ─── Video a enlazar ─────────────────────────────────────────────────────────
const VIDEO_ID  = 'e59a8e21-2a05-4989-a90c-72f58a10c0be';
const BUNNY_URL = 'https://vz-06ba72ec-646.b-cdn.net/e59a8e21-2a05-4989-a90c-72f58a10c0be/playlist.m3u8';
const TITLE     = 'Estrategia J - Video';

// 1. Insertar en catálogo si no existe
db.prepare(`
    INSERT OR IGNORE INTO catalog
        (video_id, title, status, segment_count, key_id, error, uploaded_at, source_type, bunny_url)
    VALUES (?, ?, 'ready', 0, null, null, datetime('now'), 'bunny', ?)
`).run(VIDEO_ID, TITLE, BUNNY_URL);

// 2. Estudiante de prueba
const student = db.prepare("SELECT id, email FROM students WHERE email='alumno.prueba@test.com' LIMIT 1").get();
if (!student) { console.error('ERROR: alumno.prueba@test.com no encontrado'); process.exit(1); }

// 3. Cifrar comando (igual que server.js)
function deriveCommandKey() {
    return crypto.hkdfSync(
        'sha256',
        Buffer.from(JWT_SECRET, 'utf-8'),
        Buffer.from('cdp-playback-command-salt', 'utf-8'),
        Buffer.from('playback-command-v1', 'utf-8'),
        32
    );
}
function encryptCommand(payload) {
    const key    = deriveCommandKey();
    const iv     = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data   = Buffer.from(JSON.stringify(payload), 'utf-8');
    const enc    = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return Buffer.from(JSON.stringify({
        v:   1,
        iv:  iv.toString('base64url'),
        enc: enc.toString('base64url'),
        tag: tag.toString('base64url'),
    })).toString('base64url');
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const deviceId    = 'test-device-fingerprint-001';
const nonce       = 'DEV_' + crypto.randomBytes(8).toString('hex');

const payload = {
    v:         1,
    videoId:   VIDEO_ID,
    courseId:  null,
    moduleId:  null,
    studentId: student.id,
    deviceId,
    sessionId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + ONE_YEAR_MS).toISOString(),
    nonce,
};

const command = 'cdp://' + encryptCommand(payload);

// 4. JWT del player (1 año)
const playerJwt = jwt.sign(
    {
        sub:           student.id,
        email:         student.email,
        deviceId,
        allowedVideos: ['*'],
        scope:         'player',
        admin:         false,
    },
    JWT_SECRET,
    { expiresIn: '365d', issuer: 'reproductor-cursos' }
);

// 5. Short-token DEV (reutilizable, 1 año)
const shortToken = crypto.randomBytes(16).toString('base64url');

db.exec(`
    CREATE TABLE IF NOT EXISTS pending_play_tokens (
        token      TEXT PRIMARY KEY,
        cmd        TEXT NOT NULL,
        auth       TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        is_dev     INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    )
`);

db.prepare(`
    INSERT OR REPLACE INTO pending_play_tokens (token, cmd, auth, expires_at, is_dev)
    VALUES (?, ?, ?, ?, 1)
`).run(shortToken, command, playerJwt, Date.now() + ONE_YEAR_MS);

db.close();

const playerUrl = 'cdp://play?t=' + shortToken;

console.log('  Video  : ' + VIDEO_ID);
console.log('  Titulo : ' + TITLE);
console.log('  Alumno : ' + student.email);
console.log('  Token  : ' + shortToken + ' (' + playerUrl.length + ' chars)');
console.log('  Expira : ' + new Date(Date.now() + ONE_YEAR_MS).toLocaleDateString('es-MX'));
console.log('  Uso    : ILIMITADO (token DEV)\n');
console.log('\u2550'.repeat(62));
console.log(playerUrl);
console.log('\u2550'.repeat(62));
