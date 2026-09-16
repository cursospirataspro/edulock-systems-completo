'use strict';
/**
 * _genlink_dev.js — genera un link cdp:// con 1 año de expiración para pruebas.
 * NO usar en producción. Solo para desarrollo local.
 *
 * Uso: node _genlink_dev.js
 */
require('dotenv').config();

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('ERROR: JWT_SECRET no encontrado en .env'); process.exit(1); }

// ─── Replicar cifrado exacto de server.js ────────────────────────────────────

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

// ─── Obtener video y estudiante de la BD ─────────────────────────────────────

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
if (!fs.existsSync(DB_PATH)) { console.error('ERROR: BD no encontrada en', DB_PATH); process.exit(1); }

const db = new Database(DB_PATH); // escritura habilitada para guardar short-token

// Obtener el video del usuario (vz-06ba72ec) o el primero disponible
const video =
    db.prepare("SELECT video_id AS videoId, title FROM catalog WHERE status='ready' AND bunny_url LIKE '%vz-06ba72ec%' ORDER BY uploaded_at DESC LIMIT 1").get() ||
    db.prepare("SELECT video_id AS videoId, title FROM catalog WHERE status='ready' ORDER BY uploaded_at DESC LIMIT 1").get();
if (!video) { console.error('ERROR: No hay videos en el catálogo. Ejecuta primero _add_video.js'); process.exit(1); }

// Obtener estudiante de prueba
const student = db.prepare("SELECT id, email FROM students WHERE email='alumno.prueba@test.com' LIMIT 1").get();
if (!student) { console.error('ERROR: Estudiante de prueba no encontrado. Haz login primero con _genlink.js'); process.exit(1); }

// ─── Generar link con 1 año de expiración ────────────────────────────────────
// NOTA: El nonce se registra solo cuando el reproductor llama a /resolve (primera vez).
// No se pre-inserta aquí para no marcarlo como "ya usado".

const ONE_YEAR_MS  = 365 * 24 * 60 * 60 * 1000;
const deviceId     = 'test-device-fingerprint-001';
const sessionId    = uuidv4();
// Nonce con prefijo DEV_ → el servidor omite el anti-replay para este link.
// Esto permite reutilizar el link ilimitadamente solo en entorno local de pruebas.
const nonce        = 'DEV_' + crypto.randomBytes(8).toString('hex');
const expiresAt    = new Date(Date.now() + ONE_YEAR_MS).toISOString();

const payload = {
    v:         1,
    videoId:   video.videoId,
    courseId:  null,
    moduleId:  null,
    studentId: student.id,
    deviceId,
    sessionId,
    expiresAt,
    nonce,
};

const token      = encryptCommand(payload);
const command    = `cdp://${token}`;

// JWT del player con 1 año de expiración
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

// Short-token DEV (22 chars base64url)
const shortToken = crypto.randomBytes(16).toString('base64url');

const playerUrl = `cdp://play?t=${shortToken}`;

// ─── Guardar short-token en la BD (DEV: reutilizable, 1 año) ─────────────────
// Asegurarse de que la tabla existe (puede que sea una BD nueva)
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

// ─── Resultado ───────────────────────────────────────────────────────────────

console.log('  [DEV] Link corto de prueba con 1 ANO de expiracion');
console.log('  Alumno : ' + student.email);
console.log('  Video  : ' + video.title);
console.log('  Token  : ' + shortToken + ' (' + playerUrl.length + ' chars)');
console.log('  Expira : ' + new Date(Date.now() + ONE_YEAR_MS).toLocaleDateString('es-MX'));
console.log('  NOTA   : USO ILIMITADO (token DEV). Solo para pruebas locales.\n');
console.log('══════════════════════════════════════════════════════════════');
console.log(playerUrl);
console.log('══════════════════════════════════════════════════════════════');
