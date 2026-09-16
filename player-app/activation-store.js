'use strict';
/**
 * activation-store.js — Almacenamiento seguro de activación local para el reproductor Electron.
 *
 * FLUJO:
 *   1ª vez:  No hay activación → pedir licencia → POST /api/license/activate → guardar aquí.
 *   Luego:   Leer activación → POST /api/license/validate-activation → reproducir.
 *   Reset:   Servidor responde ACTIVATION_REVOKED → borrar activación → pedir licencia otra vez.
 *
 * SEGURIDAD:
 *   - El archivo se cifra con AES-256-GCM usando una clave derivada del device_id.
 *   - No se guarda la licencia original, solo el activation_token.
 *   - El activation_token solo funciona en el device_id donde se generó (el servidor lo verifica).
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const os      = require('os');
const { app } = require('electron');

const ACTIVATION_FILE = 'activation.enc';

// ─── Derivar clave de cifrado desde device_id + salt fijo de la app ──────────
// La clave depende del dispositivo: si alguien copia el archivo a otra PC,
// no puede descifrarlo (device_id diferente → clave diferente → falla).
function _deriveKey(deviceId) {
    // Salt fijo de la aplicación (puede ser el APP_SECRET parcial o un valor fijo)
    // No es un secreto perfecto, pero suma una capa al cifrado local.
    const APP_SALT = 'EDULOCK_ACTIVATION_STORE_v1_2026';
    return crypto.pbkdf2Sync(
        deviceId + APP_SALT,
        'activation-store-salt',
        100_000,
        32,
        'sha256'
    );
}

function _getFilePath() {
    const userData = app?.getPath('userData') || path.join(os.homedir(), '.edulock-player');
    if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
    return path.join(userData, ACTIVATION_FILE);
}

/**
 * Guarda la activación local cifrada.
 * @param {object} data - { activationId, activationToken, licenseId, studentId, courseId, expiresAt }
 * @param {string} deviceId - ID del dispositivo actual
 */
function saveActivation(data, deviceId) {
    const key = _deriveKey(deviceId);
    const iv  = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plain  = JSON.stringify({ ...data, deviceId, savedAt: new Date().toISOString() });
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Formato: iv(12) + tag(16) + ciphertext
    const payload = Buffer.concat([iv, tag, encrypted]);
    fs.writeFileSync(_getFilePath(), payload.toString('base64'), 'utf8');
}

/**
 * Lee la activación local. Devuelve null si no existe o está corrupta.
 * @param {string} deviceId - ID del dispositivo actual
 * @returns {object|null}
 */
function readActivation(deviceId) {
    const filePath = _getFilePath();
    if (!fs.existsSync(filePath)) return null;
    try {
        const raw     = Buffer.from(fs.readFileSync(filePath, 'utf8'), 'base64');
        const iv      = raw.slice(0, 12);
        const tag     = raw.slice(12, 28);
        const cipher  = raw.slice(28);
        const key     = _deriveKey(deviceId);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const plain = decipher.update(cipher) + decipher.final('utf8');
        const parsed = JSON.parse(plain);
        // Verificar que el deviceId guardado coincide con el actual
        if (parsed.deviceId !== deviceId) {
            console.warn('[activation-store] device_id mismatch — archivo de otra PC');
            return null;
        }
        return parsed;
    } catch (err) {
        console.warn('[activation-store] Error leyendo activación:', err.message);
        return null;
    }
}

/**
 * Borra la activación local (cuando el servidor la revoca o hay error fatal).
 */
function clearActivation() {
    const filePath = _getFilePath();
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* ignorar */ }
}

/**
 * Verifica si hay una activación guardada localmente (sin validar con servidor).
 * @param {string} deviceId
 * @returns {boolean}
 */
function hasActivation(deviceId) {
    return readActivation(deviceId) !== null;
}

module.exports = { saveActivation, readActivation, clearActivation, hasActivation };
