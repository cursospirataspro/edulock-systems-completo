'use strict';
/**
 * server.js — Backend principal: autenticación, DRM, HLS, marcas de agua
 *
 * ENDPOINTS:
 *
 *  Autenticación
 *    POST /api/auth/login          → Emite JWT de usuario
 *    POST /api/auth/refresh        → Renueva JWT (si no expiró)
 *
 *  Videos
 *    GET  /api/video/:videoId/play → Devuelve URL firmada del .m3u8 + token DRM
 *    GET  /api/video/list          → [ADMIN] Lista videos disponibles
 *    POST /api/video/upload        → [ADMIN] Sube video y lanza procesamiento HLS
 *
 *  DRM / Claves
 *    GET  /api/drm/key/:keyId      → Sirve clave AES-128 binaria (autenticado)
 *    POST /api/drm/clearkey        → Licencia ClearKey EME (autenticado)
 *    POST /api/drm/widevine        → Proxy licencia Widevine (autenticado)
 *
 *  Auditoría
 *    POST /api/watermark/log       → Registra apertura del reproductor
 *    GET  /api/watermark/detect    → [ADMIN] Identifica fingerprint de video filtrado
 *    GET  /api/audit/log           → [ADMIN] Ver log de entregas
 *
 *  Archivos estáticos
 *    GET  /                        → index.html (reproductor)
 */

require('dotenv').config();

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');

const { getKeyBuffer, getKeyHex, getVideoIdForKey, generateKey, buildClearKeyLicense, proxyWidevineLicense } = require('./drm-manager');
const { generateFingerprint, buildWatermarkText } = require('./watermark-manager');
const { getPresignedUrl, listFiles, LOCAL_MODE } = require('./storage');
const { processVideo }                       = require('./hls-processor');
const db = require('./database-pg');
const { createAccessPolicy, hasVideoAccess } = require('./lib/access-policy');
const { createPlayerHandshake } = require('./lib/player-handshake');
const { createAccountAuth, normalizedEmail } = require('./lib/account-auth');
const { createPlayerSessions } = require('./lib/player-sessions');
const accessPolicy = createAccessPolicy({ db });
const { createResourceRepository } = require('./lib/resource-repository');
const { isAccountToken } = require('./lib/token-scope');
const { createResourceStorage } = require('./lib/resource-storage');
const { createPdfRenderer } = require('./lib/pdf-renderer');
const { createResourceService, serializeResource, legacyPublicDocuments } = require('./lib/resource-service');
const { installResourceRoutes, resourceError } = require('./lib/resource-routes');
const resourceRepository = createResourceRepository({ db });
const resourceStorage = createResourceStorage({ directory: process.env.RESOURCE_STORAGE_DIR, configuredKey: process.env.RESOURCE_STORAGE_KEY });
const pdfRenderer = createPdfRenderer();
const { createActivationValidator } = require('./lib/activation-validator');
const {verifyResourceSignature,belongsToVideo,rewriteBunnyManifest,segmentIV}=require('./lib/hls-manifest');
const {fetchBunnyText}=require('./lib/bunny-media-fetch');
const { createStreamService, STAGES: STREAM_STAGES } = require('./lib/stream-service');
const streamService = createStreamService({ db, getAccountKey: getBunnyAccountKey, createKey: generateKey, logger: console });
const https = require('https');
const http  = require('http');

const watermarkConfigStore = new Map();
const watermarkStreamClients = new Map();
const WATERMARK_DEFAULT = {
    enabled: true,
    visible: { size: 13, color: '#ffffff', weight: 600, alpha: 0.22, enabled: true },
    // Marca forense casi invisible (rejilla con la huella de la sesión). Valores = los del reproductor.
    forensic: { on: true, size: 11, color: '#808080', weight: 500, alpha: 0.02, enabled: true },
    email:    { on: true, size: 35, color: '#ff2d2d', weight: 700, alpha: 0.60 },
    ip:       { on: true, size: 16, color: '#ffffff', weight: 600, alpha: 0.22 },
    code:     { on: true, size: 16, color: '#ffffff', weight: 600, alpha: 0.22 },
    datetime: { on: true, size: 16, color: '#ffffff', weight: 600, alpha: 0.22 },
};
const DEFAULT_WATERMARK_CONFIG = { windows: WATERMARK_DEFAULT };

function mergeWatermarkConfig(base) {
    return {
        enabled: base.enabled !== undefined ? base.enabled : WATERMARK_DEFAULT.enabled,
        visible: { ...WATERMARK_DEFAULT.visible, ...(base.visible || {}) },
        forensic: { ...WATERMARK_DEFAULT.forensic, ...(base.forensic || {}) },
        email: { ...WATERMARK_DEFAULT.email, ...(base.email || {}) },
        ip: { ...WATERMARK_DEFAULT.ip, ...(base.ip || {}) },
        code: { ...WATERMARK_DEFAULT.code, ...(base.code || {}) },
        datetime: { ...WATERMARK_DEFAULT.datetime, ...(base.datetime || {}) },
    };
}

const WATERMARK_CONFIG_KEY = 'watermark_config';
const WATERMARK_OS_KEYS = ['windows', 'mac', 'linux', 'android', 'ios'];

// El panel y el reproductor usan "mac"; versiones anteriores emitían "macos".
function normalizeWatermarkOs(os) {
    const o = String(os || 'windows').toLowerCase();
    if (o === 'macos' || o === 'darwin') return 'mac';
    if (o === 'iphone') return 'ios';
    return WATERMARK_OS_KEYS.includes(o) ? o : 'windows';
}

// Ámbitos de configuración: "__default__" | "<courseId>" | "producer:<producerId>"
function isValidWatermarkScope(scope) {
    return scope === '__default__' || /^[0-9a-f-]{36}$/i.test(scope) || /^producer:[A-Za-z0-9_-]{1,64}$/.test(scope);
}

// Configuración CRUDA de un ámbito (lo que edita el panel), rellenada con los defaults.
function getWatermarkConfig(scope = '__default__', os = 'windows') {
    os = normalizeWatermarkOs(os);
    const stored = watermarkConfigStore.get(scope) || {};
    const base = (stored && typeof stored === 'object' && stored[os]) ? stored[os] : {};
    return mergeWatermarkConfig(base);
}

// Configuración EFECTIVA para una reproducción: predeterminado ← productor ← curso.
// Cada capa solo sobreescribe las claves que define, por elemento.
function resolveWatermarkConfig({ courseId = null, producerId = null } = {}, os = 'windows') {
    os = normalizeWatermarkOs(os);
    const layers = [];
    const def = watermarkConfigStore.get('__default__');
    if (def && def[os]) layers.push(def[os]);
    if (producerId) {
        const p = watermarkConfigStore.get('producer:' + producerId);
        if (p && p[os]) layers.push(p[os]);
    }
    if (courseId && courseId !== '__default__') {
        const c = watermarkConfigStore.get(courseId);
        if (c && c[os]) layers.push(c[os]);
    }
    const base = {};
    for (const layer of layers) {
        if (!layer || typeof layer !== 'object') continue;
        for (const [k, v] of Object.entries(layer)) {
            if (v && typeof v === 'object' && !Array.isArray(v)) base[k] = { ...(base[k] || {}), ...v };
            else base[k] = v;
        }
    }
    return mergeWatermarkConfig(base);
}

// courseId → producerId (con caché corta) para que el push en vivo por productor
// llegue a los reproductores, que solo conocen su curso y su video.
const _wmOwnerCache = new Map();
async function watermarkOwnerFor({ courseId = null, videoId = null } = {}) {
    const key = `${courseId || ''}|${videoId || ''}`;
    const hit = _wmOwnerCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    let producerId = null;
    try {
        if (courseId && courseId !== '__default__' && db.getCourseById) {
            const course = await db.getCourseById(courseId);
            producerId = course?.producerId || null;
        }
        if (!producerId && videoId && db.getCatalogById) {
            const video = await db.getCatalogById(videoId);
            producerId = video?.producerId || null;
        }
    } catch { /* sin BD: sin productor */ }
    const value = { producerId };
    _wmOwnerCache.set(key, { value, exp: Date.now() + 120000 });
    return value;
}

async function loadStoredWatermarkConfig() {
    try {
        const raw = await db.getConfig(WATERMARK_CONFIG_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            for (const [courseId, cfg] of Object.entries(parsed)) {
                if (cfg && typeof cfg === 'object') {
                    // Migración: guardados antiguos arrastraban el forensic por defecto del
                    // servidor (8px/6%), que nadie eligió. Se descarta para usar el actual (11px/2%).
                    for (const osCfg of Object.values(cfg)) {
                        const f = osCfg && osCfg.forensic;
                        if (f && f.size === 8 && f.color === '#c8c8c8' && f.alpha === 0.06) delete osCfg.forensic;
                    }
                    watermarkConfigStore.set(courseId, cfg);
                }
            }
        }
        console.log('[watermark] configuración cargada desde BD');
    } catch (err) {
        console.warn('[watermark] no se pudo cargar configuración persistente:', err.message);
    }
}

async function persistWatermarkConfigStore() {
    try {
        const obj = Object.fromEntries(watermarkConfigStore.entries());
        await db.setConfig(WATERMARK_CONFIG_KEY, JSON.stringify(obj));
    } catch (err) {
        console.warn('[watermark] no se pudo guardar configuración persistente:', err.message);
    }
}

// Tras cualquier cambio (predeterminado, productor o curso) se recalcula la
// configuración efectiva de CADA reproductor conectado y se le envía solo si cambió.
function broadcastWatermarkConfig() {
    for (const clients of watermarkStreamClients.values()) {
        for (const client of clients) {
            try {
                if (client.res.writableEnded) continue;
                const payload = resolveWatermarkConfig({ courseId: client.courseId, producerId: client.producerId }, client.os);
                const json = JSON.stringify(payload);
                if (json === client.lastJson) continue;
                client.lastJson = json;
                client.res.write(`event: config\ndata: ${json}\n\n`);
            } catch {}
        }
    }
}

// ── Firebase Admin SDK ────────────────────────────────────────────────────────
let firebaseAdmin = null;
let firebasePrivileged = false;
try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
        let svcAccount = null;
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            // Producción alternativa: JSON del service account en variable de entorno
            svcAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } else {
            // Local: archivo (si existe)
            try { svcAccount = require('./firebase-service-account.json'); } catch (_) { svcAccount = null; }
        }
        if (svcAccount) {
            firebasePrivileged = true;
            admin.initializeApp({ credential: admin.credential.cert(svcAccount) });
            console.log('[Firebase] Admin SDK inicializado con service account (login + FCM)');
        } else if (process.env.FIREBASE_PROJECT_ID) {
            // Sin service account: init solo con projectId → verifica ID tokens (login)
            // con las claves públicas de Google. No habilita FCM ni createUser.
            admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
            console.log('[Firebase] Admin SDK inicializado solo con projectId (login; sin FCM). Ver FIREBASE_SETUP.md');
        } else {
            throw new Error('falta firebase-service-account.json o FIREBASE_PROJECT_ID');
        }
    }
    firebaseAdmin = admin;
} catch (e) {
    console.warn('[Firebase] Admin SDK no disponible:', e.message);
}

// ---- Catálogo: ahora en PostgreSQL vía database-pg.js ----
const loadCatalog    = async () => await db.loadCatalog();
const addToCatalog   = async (e) => await db.addToCatalog(e);
const saveCatalog    = () => {}; // no-op: PostgreSQL es transaccional

// ── Persistencia 100% en VPS + PostgreSQL local ───────────────────────────────
// La sincronización de "seeds" a un servicio externo quedó eliminada al migrar a
// la VPS de Edulock. Estas funciones son no-op para no tocar los call sites.
async function syncCatalogSeed() { /* no-op: VPS + PostgreSQL local */ }
async function syncDomainsSeed()  { /* no-op: VPS + PostgreSQL local */ }

// ---- Alumnos: ahora en SQLite vía database.js ----
const findStudentByEmail = async (email) => await db.findStudentByEmail(email);

// ================================================================
//  HELPERS — BUNNY.NET / FETCH REMOTO
// ================================================================

// SSRF: solo se permiten dominios de Bunny.net
const SAFE_BUNNY_RE = /^https:\/\/[a-z0-9-]+\.(?:b-cdn\.net|bunnycdn\.com|mediadelivery\.net)\//i;
function isSafeBunnyUrl(url) { return SAFE_BUNNY_RE.test(url); }

// SSRF: validate document URLs — reject file://, localhost, private IPs
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

// Token auth key para el pull zone de Bunny Stream
const BUNNY_TOKEN_KEY = process.env.BUNNY_TOKEN_KEY || '';

/**
 * Genera una URL firmada con token auth de Bunny CDN (Advanced — HMAC-SHA256).
 * Implementación oficial: https://github.com/BunnyWay/BunnyCDN.TokenAuthentication
 * @param {string} url - URL original de Bunny (sin token)
 * @param {number} expiresIn - Segundos de validez (default 24h)
 * @returns {string} URL con token auth (query string format)
 */
function signBunnyUrl(url, expiresIn = 3600, securityKey = BUNNY_TOKEN_KEY) {
    if (!securityKey) return url;
    const parsed=new URL(url);
    parsed.searchParams.delete('token');parsed.searchParams.delete('expires');
    const expires=String(Math.floor(Date.now()/1000)+expiresIn);
    const signingData=[...parsed.searchParams.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('&');
    const token='HS256-'+crypto.createHmac('sha256',securityKey).update(parsed.pathname+expires+signingData).digest('base64url');
    parsed.searchParams.set('token',token);parsed.searchParams.set('expires',expires);
    return parsed.href;
}
async function signCourseBunnyUrl(url,entry) {
    const lib=entry.courseId?await db.getCourseBunny(entry.courseId):null;
    let key = lib?.tokenKey || BUNNY_TOKEN_KEY || '';
    if (!key && lib?.libraryId) {
        key = await fetchPullZoneTokenKey(lib.libraryId);
        if (key && entry.courseId) {
            db.setCourseBunnyLibrary(entry.courseId, { libraryId: lib.libraryId, libraryKey: lib.libraryKey, pullZone: lib.pullZone, tokenKey: key }).catch(() => {});
        }
    }
    if (!key) key = await db.getConfig('bunny_token_key') || '';
    if (!key) {
        const globalLib = await db.getConfig('bunny_library_id');
        if (globalLib) {
            key = await fetchPullZoneTokenKey(globalLib);
            if (key) db.setConfig('bunny_token_key', key).catch(() => {});
        }
    }
    return signBunnyUrl(url,3600,key);
}

// ── Bunny STORAGE (para subir los .edu) — configurable desde el panel ─────────
async function getBunnyStorageConfig() {
    const g = async (k) => { try { return await db.getConfig(k); } catch { return ''; } };
    const zone = (await g('bunny_storage_zone')) || process.env.BUNNY_STORAGE_ZONE || '';
    const key  = (await g('bunny_storage_key'))  || process.env.BUNNY_STORAGE_KEY  || '';
    const host = ((await g('bunny_storage_host')) || process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com')
        .replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const pull = ((await g('bunny_pull_base')) || process.env.BUNNY_PULL_BASE || '').replace(/\/+$/, '');
    return { zone, key, host, pull };
}
// Sube un Buffer a Bunny Storage (PUT con AccessKey). pathInZone p.ej. "edu/abc.edu".
function bunnyStoragePut(host, zone, key, pathInZone, buffer) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            method: 'PUT', hostname: host, path: `/${zone}/${pathInZone}`,
            headers: { AccessKey: key, 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length },
            timeout: 120000,
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300)
                ? resolve(true)
                : reject(new Error(`Bunny Storage HTTP ${res.statusCode} ${d.slice(0, 120)}`)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Bunny Storage timeout')); });
        req.write(buffer); req.end();
    });
}

// ================================================================
//  BUNNY STREAM — auto-provisión (biblioteca por curso, colección por módulo)
//  Doc: api.bunny.net (cuenta) + video.bunnycdn.com (por biblioteca).
// ================================================================
async function getBunnyAccountKey() {
    try { return (await db.getConfig('bunny_account_key')) || process.env.BUNNY_ACCOUNT_KEY || ''; }
    catch { return process.env.BUNNY_ACCOUNT_KEY || ''; }
}

// Petición JSON genérica a la API de Bunny. Devuelve el objeto parseado.
function bunnyJson(method, host, apiPath, accessKey, bodyObj) {
    return new Promise((resolve, reject) => {
        const payload = bodyObj != null ? Buffer.from(JSON.stringify(bodyObj)) : null;
        const headers = { AccessKey: accessKey, Accept: 'application/json' };
        if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
        const req = https.request({ method, hostname: host, path: apiPath, headers, timeout: 60000 }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); }
                } else {
                    reject(new Error(`Bunny ${method} ${apiPath} → HTTP ${res.statusCode} ${d.slice(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Bunny API timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}

// Sube el archivo de video (bytes crudos) a un video ya creado en Stream.
function bunnyPutVideoFile(libraryId, libraryKey, guid, buffer) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            method: 'PUT', hostname: 'video.bunnycdn.com',
            path: `/library/${libraryId}/videos/${guid}`,
            headers: { AccessKey: libraryKey, 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length },
            timeout: 600000,
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300)
                ? resolve(true)
                : reject(new Error(`Bunny upload HTTP ${res.statusCode} ${d.slice(0, 160)}`)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Bunny upload timeout')); });
        req.write(buffer); req.end();
    });
}

// Obtiene el Token Authentication Key del pull zone de una biblioteca Bunny.
// Usa la Account API Key para consultar la API de pull zones.
const _tokenKeyCache = new Map();
async function fetchPullZoneTokenKey(libraryId) {
    if (_tokenKeyCache.has(libraryId)) return _tokenKeyCache.get(libraryId);
    const acct = await getBunnyAccountKey();
    if (!acct) return '';
    try {
        const lib = await bunnyJson('GET', 'api.bunny.net', `/videolibrary/${libraryId}`, acct, null);
        const pzId = lib.PullZoneId;
        if (!pzId) return '';
        const pz = await bunnyJson('GET', 'api.bunny.net', `/pullzone/${pzId}`, acct, null);
        const key = pz.ZoneSecurityKey || '';
        if (key) _tokenKeyCache.set(libraryId, key);
        return key;
    } catch (e) {
        console.warn('[bunny] Error obteniendo token key para library', libraryId, e.message);
        return '';
    }
}

// Crea una biblioteca de video en Stream con SOLO la región principal (Frankfurt),
// sin replicación (desactiva Singapur, LA, NY, etc.). Devuelve { id, key, pullZone }.
async function bunnyCreateLibrary(name) {
    const acct = await getBunnyAccountKey();
    if (!acct) throw new Error('Falta la Bunny Account API Key (config del panel).');
    // 1) Crear la biblioteca sin regiones de replicación.
    const lib = await bunnyJson('POST', 'api.bunny.net', '/videolibrary', acct,
        { Name: String(name).slice(0, 100), ReplicationRegions: [] });
    const libraryId = lib.Id;
    const libraryKey = lib.ApiKey;
    // 2) Forzar sin replicación (por si la cuenta replica por defecto).
    try { await bunnyJson('POST', 'api.bunny.net', `/videolibrary/${libraryId}`, acct, { ReplicationRegions: [] }); } catch {}
    // 3) Resolver el hostname del pull zone y su Token Authentication Key.
    let pullZone = '';
    let tokenKey = '';
    try {
        const pzId = lib.PullZoneId;
        if (pzId) {
            const pz = await bunnyJson('GET', 'api.bunny.net', `/pullzone/${pzId}`, acct, null);
            const host = (pz.Hostnames || []).map(h => h.Value).find(v => /b-cdn\.net$/i.test(v)) || (pz.Hostnames || [])[0]?.Value;
            if (host) pullZone = host;
            if (pz.ZoneSecurityKey) tokenKey = pz.ZoneSecurityKey;
        }
    } catch {}
    return { libraryId, libraryKey, pullZone, tokenKey };
}

// Crea una colección (= módulo) dentro de la biblioteca. Devuelve el guid.
async function bunnyCreateCollection(libraryId, libraryKey, name) {
    const r = await bunnyJson('POST', 'video.bunnycdn.com', `/library/${libraryId}/collections`, libraryKey,
        { name: String(name).slice(0, 100) });
    return r.guid || r.Guid || null;
}

// Crea el objeto de video (antes de subir el archivo). Devuelve el guid.
async function bunnyCreateVideo(libraryId, libraryKey, title, collectionId) {
    const body = { title: String(title).slice(0, 200) };
    if (collectionId) body.collectionId = collectionId;
    const r = await bunnyJson('POST', 'video.bunnycdn.com', `/library/${libraryId}/videos`, libraryKey, body);
    return r.guid || r.Guid || null;
}

// Estado de transcodificación: { status, encodeProgress }.
// status Bunny: 0 creado, 1 subido, 2 procesando, 3 transcodificando, 4 listo, 5 error.
async function bunnyGetVideo(libraryId, libraryKey, guid) {
    return bunnyJson('GET', 'video.bunnycdn.com', `/library/${libraryId}/videos/${guid}`, libraryKey, null);
}

// Asegura que un curso tenga su biblioteca en Bunny (la crea si falta). Devuelve la config.
async function ensureCourseLibrary(courseId, courseName) {
    let b = await db.getCourseBunny(courseId);
    if (b && b.libraryId) return b;
    const created = await bunnyCreateLibrary(courseName || ('Curso ' + courseId));
    await db.setCourseBunnyLibrary(courseId, created);
    console.log(`[bunny] Biblioteca creada para curso ${courseId}: lib=${created.libraryId} pz=${created.pullZone}`);
    return created;
}

/** Resuelve una URL relativa a una URL base.
 *  Preserva el prefijo de token Bunny CDN (bcdn_token=...) si existe en base. */
function resolveUrl(base, relative) {
    if (/^https?:\/\//.test(relative)) return relative;
    try {
        const resolved = new URL(relative, base);
        // Bunny CDN pone la auth como prefijo del path: /bcdn_token=...&expires=.../
        // Si base tiene ese prefijo y la URL resuelta lo perdió, restaurarlo
        const baseUrl = new URL(base);
        const tokenMatch = baseUrl.pathname.match(/^(\/bcdn_token=[^/]+\/)/);
        if (tokenMatch && !resolved.pathname.startsWith('/bcdn_token=')) {
            resolved.pathname = tokenMatch[1] + resolved.pathname.replace(/^\//, '');
        }
        return resolved.href;
    } catch {
        const u = new URL(base);
        if (relative.startsWith('/')) return u.origin + relative;
        const dir = u.pathname.substring(0, u.pathname.lastIndexOf('/') + 1);
        return u.origin + dir + relative;
    }
}

const { Transform } = require('stream');

/**
 * Crea un Transform stream que cifra AES-128-CBC en tiempo real.
 * El cifrado se aplica en bloques de 16 bytes conforme llegan los chunks,
 * permitiendo empezar a enviar bytes cifrados sin esperar el segmento completo.
 */
function createAES128CipherStream(keyHex, segIndex) {
    const iv = segmentIV(segIndex);
    return crypto.createCipheriv('aes-128-cbc', Buffer.from(keyHex, 'hex'), iv);
}

/**
 * Envía un manifest HLS envuelto en JSON+base64 para ocultar el contenido
 * a extensiones de descarga que inspeccionan Content-Type y cuerpo.
 */
function sendManifest(res, content, req) {
    res.setHeader('Cache-Control', 'no-store');
    // Si el cliente es la app nativa (acepta HLS), enviar raw M3U8
    const accept = (req && req.headers['accept']) || '';
    const xNative = (req && req.headers['x-native-app']) === '1';
    if (xNative || accept.includes('application/x-mpegURL') || accept.includes('application/vnd.apple.mpegurl')) {
        res.setHeader('Content-Type', 'application/x-mpegURL');
        return res.end(content);
    }
    // Web player: base64-JSON (anti-piratería)
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ d: Buffer.from(content).toString('base64url') }));
}

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '2h';
const STUDENT_JWT_EXPIRES = process.env.STUDENT_JWT_EXPIRES_IN || '2h';
const MEDIA_TTL      = parseInt(process.env.MEDIA_TOKEN_TTL || '1800', 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '1', 10);
// Secreto compartido app↔servidor para verificar que las peticiones vienen del reproductor oficial.
// Debe coincidir con APP_SECRET en player-app/config.json.
const APP_SECRET = process.env.APP_SECRET || '';

// Shared player contract: identity, license, provider and active media session.
const playerSessions = createPlayerSessions({ db, jwt, jwtSecret: JWT_SECRET, accessPolicy });
const playerHandshake = createPlayerHandshake({
    db, jwt, jwtSecret: JWT_SECRET, accessPolicy, getWatermarkConfig, resolveWatermarkConfig, generateFingerprint, sessions: playerSessions,
    mediaTtl: MEDIA_TTL, maxConcurrent: MAX_CONCURRENT, isReady: () => dbReady,
    publicBase: req => process.env.PUBLIC_URL || process.env.BASE_URL || `${req.protocol}://${req.get('host')}`,
    verifyFirebaseToken: async token => {
        if (!firebaseAdmin) throw Object.assign(new Error('Autenticación Google no disponible.'), { status: 503, code: 'FIREBASE_UNAVAILABLE' });
        return firebaseAdmin.auth().verifyIdToken(token);
    },
    requestVdoOtp: async videoId => {
        if (!process.env.VDOCIPHER_API_SECRET) throw Object.assign(new Error('VdoCipher no configurado.'), { status: 503, code: 'VDO_UNAVAILABLE' });
        const body = JSON.stringify({ ttl: 300 });
        return new Promise((resolve, reject) => {
            const request = https.request({ hostname: 'dev.vdocipher.com', path: `/api/videos/${encodeURIComponent(videoId)}/otp`,
                method: 'POST', timeout: 10000, headers: { Authorization: `Apisecret ${process.env.VDOCIPHER_API_SECRET}`,
                    'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
                let raw = '';
                response.on('data', chunk => { raw += chunk; if (raw.length > 100000) request.destroy(new Error('VdoCipher response too large')); });
                response.on('error', reject);
                response.on('end', () => {
                    try {
                        const result = JSON.parse(raw);
                        if (response.statusCode !== 200 || !result.otp || !result.playbackInfo) throw new Error('VdoCipher rejected the request');
                        resolve(result);
                    } catch { reject(Object.assign(new Error('No se pudo preparar VdoCipher.'), { status: 502, code: 'VDO_UNAVAILABLE' })); }
                });
            });
            request.on('error', () => reject(Object.assign(new Error('No se pudo conectar con VdoCipher.'), { status: 502, code: 'VDO_UNAVAILABLE' })));
            request.on('timeout', () => request.destroy(new Error('timeout')));
            request.end(body);
        });
    },
});

// ── DRM propio (.edu) — MASTER_KEY para derivar la clave por video (guía DRM) ──
// La CEK de cada video se deriva: CEK = HKDF(MASTER_KEY, salt || content_id).
// El servidor la re-deriva por sesión y la entrega solo con licencia válida; nunca
// se almacena la CEK. MASTER_KEY debe ser independiente de JWT_SECRET.
const EDU_MASTER_KEY = process.env.EDU_MASTER_KEY || '';
function deriveEduCek(saltHex, contentId) {
    const salt = Buffer.from(saltHex, 'hex');
    const info = Buffer.concat([Buffer.from('edu-cek|'), salt, Buffer.from('|'), Buffer.from(contentId)]);
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(EDU_MASTER_KEY, 'hex'), Buffer.alloc(0), info, 32));
}

// ── Validar firma HMAC del reproductor ────────────────────────────────────────
// Rechaza peticiones que no vengan del reproductor oficial firmado.
// Modo de fallo: si APP_SECRET no está configurado, se permite sin firma (dev).
function validateAppSig(req, res, next) {
    if (!APP_SECRET) return next(); // sin secreto configurado → no se valida (dev)
    const tsRaw = String(req.headers['x-cdp-ts'] || '').trim();
    const ts  = parseFloat(tsRaw) || 0;
    const sig  = req.headers['x-cdp-sig']  || '';
    const now  = Date.now();
    const SIG_TOLERANCE_MS = 5 * 60 * 1000;
    if (!sig) {
        return res.status(401).json({ error: 'Firma de reproductor ausente.' });
    }
    if (!ts || !/^\d+(\.\d+)?$/.test(tsRaw) || Math.abs(now - ts) > SIG_TOLERANCE_MS) {
        return res.status(401).json({ error: 'Firma de reproductor expirada. Verifica la fecha y hora de tu equipo.' });
    }
    // Observabilidad: registrar desfases grandes de reloj (no bloquea)
    if (Math.abs(now - ts) > 10 * 60_000) {
        console.warn(`[appsig] desfase de reloj del cliente: ${Math.round((now - ts) / 60000)} min · ip=${req.ip || '?'} · path=${req.path}`);
    }
    // El mensaje firmado varía según el endpoint para evitar reutilización entre endpoints
    // Se firma el timestamp EXACTAMENTE como lo envió el cliente: players antiguos
    // pueden mandar decimales ("...456.5") y parseInt rompía la firma a mitad de las veces.
    const isRedeem  = req.path.startsWith('/api/playback/t/');
    const token     = isRedeem ? (req.params.token || '') : '';
    const message   = isRedeem ? (token + ':' + tsRaw) : ('resolve:' + tsRaw);
    const expected  = crypto.createHmac('sha256', APP_SECRET).update(message).digest('hex');
    try {
        if (!crypto.timingSafeEqual(Buffer.from(sig.padEnd(64, '0')), Buffer.from(expected.padEnd(64, '0')))) {
            return res.status(401).json({ error: 'Reproductor no autorizado.' });
        }
    } catch {
        return res.status(401).json({ error: 'Reproductor no autorizado.' });
    }
    next();
}

/**
 * Resuelve la URL base pública del servidor.
 * Prioriza PUBLIC_URL del .env; si no existe, la deduce del request.
 */
function getPublicBase(req) {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host  = req.headers['x-forwarded-host']  || req.headers['host'] || `localhost:${PORT}`;
    return `${proto}://${host}`;
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('[FATAL] JWT_SECRET no configurado o demasiado corto. Edita .env');
    process.exit(1);
}

// ================================================================
//  MIDDLEWARES GLOBALES
// ================================================================

app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));

// CORS — permite peticiones desde dominios configurados en BD + Electron (null origin)
const STATIC_ORIGINS = [];

// Caché de dominios permitidos (se refresca al conectar la BD y cada 5 min)
let cachedAllowedDomains = [];
async function refreshAllowedDomains() {
    try {
        cachedAllowedDomains = await db.getAllowedDomains();
    } catch (e) {
        // Mantiene la caché anterior si falla
    }
}

app.use(async (req, res, next) => {
    const origin = req.headers['origin'] || '';
    const dbDomains = cachedAllowedDomains;
    // 'null' es el origin que envía Electron/file:// al hacer peticiones cross-origin
    const isNullOrigin = origin === 'null';
    const allowed = isNullOrigin
        || STATIC_ORIGINS.some(o => o.test(origin))
        || dbDomains.some(d => origin === d || origin === d.replace(/\/$/, ''));
    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', isNullOrigin ? '*' : origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Media-Token, X-CDP-Ts, X-CDP-Sig, X-Device-ID');
        res.setHeader('Access-Control-Expose-Headers', 'X-Resource-Version');
        res.setHeader('Access-Control-Allow-Credentials', isNullOrigin ? 'false' : 'true');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});


app.use(async (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Permitir iframe solo desde dominios configurados en BD (+ 'self')
    const dbDomains = cachedAllowedDomains;
    const frameAncestors = ["'self'", ...dbDomains].join(' ');
    res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
    // Deshabilitar caché para rutas de API y DRM
    if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
    }
    next();
});

// ================================================================
//  HELPERS DE AUTENTICACIÓN
// ================================================================

/**
 * Extrae y verifica el JWT del header Authorization: Bearer <token>
 * Devuelve el payload o null si inválido.
 */
function verifyToken(req) {
    const header = req.headers['authorization'] || '';
    if (!header.startsWith('Bearer ')) return null;
    try {
        return jwt.verify(header.slice(7), JWT_SECRET);
    } catch {
        return null;
    }
}

/** Middleware: rechaza peticiones sin JWT válido */
async function requireAuth(req, res, next) {
    if (!dbReady) return res.status(503).json({ error: 'Servidor iniciando, reintenta en unos segundos' });
    const payload = verifyToken(req);
    if (!payload) return res.status(401).json({ error: 'No autorizado' });
    try { req.user = await accessPolicy.hydrate(payload); next(); }
    catch (error) { sendAccessError(res, error); }
}
function sendAccessError(res, error) {
    return res.status(error.status || 503).json({ error: error.status ? error.message : 'No se pudo comprobar el acceso. Reintenta.', code: error.code || 'ACCESS_UNAVAILABLE', revoked: error.status === 401 || error.status === 403 });
}
function requestDevice(req, claims) { return req.headers['x-device-id'] || req.query.dv || req.body?.deviceId || claims?.deviceId || ''; }
function mediaJwt(req) { return (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.token || req.body?.mediaToken; }
async function authorizeMedia(req, videoId, token = mediaJwt(req)) {
    let claims;
    try { claims = jwt.verify(token, JWT_SECRET); } catch { const e=new Error('Sesión expirada. Inicia sesión de nuevo.');e.status=401;e.code='TOKEN_EXPIRED';throw e; }
    if (!claims.sessionId || claims.videoId !== videoId) { const e = new Error('Abre el video para iniciar una sesión de reproducción.'); e.status = 403; e.code = 'SESSION_REQUIRED'; throw e; }
    return accessPolicy.authorizeSession(claims, claims.sessionId, requestDevice(req, claims));
}
async function requireBodyVideo(req,res,next) {
    try {
        const videoId=req.params.videoId || req.body?.videoId;
        if (!videoId) return res.status(400).json({error:'videoId requerido'});
        const context=await accessPolicy.authorizeVideo(req.user,videoId,requestDevice(req,req.user));
        req.user=context.user;req.playback=context;next();
    } catch(error) { sendAccessError(res,error); }
}

/** Middleware: rechaza peticiones que no sean del administrador */
function requireAdmin(req, res, next) {
    if (!dbReady) return res.status(503).json({ error: 'Servidor iniciando, reintenta en unos segundos' });
    const payload = verifyToken(req);
    if (!isAccountToken(payload) || payload.admin !== true) return res.status(403).json({ error: 'Acceso denegado' });
    req.user = payload;
    next();
}

async function requireResourceAccount(req, res, next) {
    if (!dbReady) return res.status(503).json({ error: 'Servidor iniciando. Intenta de nuevo.', code: 'RESOURCE_UNAVAILABLE' });
    const claims = verifyToken(req);
    if (!claims) return res.status(401).json({ error: 'Inicia sesión para abrir el recurso.', code: 'RESOURCE_AUTH_REQUIRED' });
    if (!isAccountToken(claims)) return res.status(403).json({ error: 'Inicia sesión con tu cuenta para abrir o administrar recursos.', code: 'RESOURCE_ACCOUNT_TOKEN_REQUIRED' });
    try {
        if (claims.admin === true) req.user = claims;
        else if (claims.role === 'producer' && claims.producerId) {
            const producer = await db.getProducerById(claims.producerId);
            if (!producer || !(producer.active === 1 || producer.active === true)) return res.status(403).json({ error: 'La cuenta productora está suspendida.', code: 'RESOURCE_FORBIDDEN' });
            if (Number(claims.authVersion || 0) !== Number(producer.auth_version || 0)) return res.status(401).json({ error: 'Tu sesión terminó. Vuelve a entrar.', code: 'RESOURCE_SESSION_REVOKED', revoked: true });
            req.user = claims;
        } else req.user = await accessPolicy.hydrate(claims);
        next();
    } catch (e) { resourceError(res, e); }
}
function requireResourceManager(req, res, next) {
    requireResourceAccount(req, res, () => {
        if (req.user.admin !== true && req.user.role !== 'producer') return res.status(403).json({ error: 'Sólo el propietario puede administrar los recursos.', code: 'RESOURCE_FORBIDDEN' });
        next();
    });
}

// Content permissions are authoritative server-side; see lib/access-policy.js.

// ================================================================
//  RATE-LIMIT DE AUTENTICACIÓN (P1)
//  Frena fuerza bruta en login (admin y alumno) sin penalizar el uso normal.
//  Ventana deslizante en memoria por IP+ruta. Nota: en cluster PM2 el límite
//  es por-worker; para límite global usar Redis (ver notas del PDF, Mejora 2).
// ================================================================
const _authHits = new Map();
const AUTH_RL_WINDOW_MS = parseInt(process.env.AUTH_RL_WINDOW_MS || '900000', 10);
const AUTH_RL_MAX       = parseInt(process.env.AUTH_RL_MAX       || '10', 10);
const AUTH_RL_FILE      = path.resolve('./data/rate-limits.json');
(function _rlLoad() {
    try {
        const raw = JSON.parse(fs.readFileSync(AUTH_RL_FILE, 'utf-8'));
        const now = Date.now();
        for (const [k, v] of Object.entries(raw)) { if (v.resetAt > now) _authHits.set(k, v); }
    } catch {}
})();
function _rlPersist() {
    try {
        const obj = {};
        const now = Date.now();
        for (const [k, v] of _authHits) { if (v.resetAt > now) obj[k] = v; }
        fs.mkdirSync(path.dirname(AUTH_RL_FILE), { recursive: true });
        fs.writeFileSync(AUTH_RL_FILE, JSON.stringify(obj), 'utf-8');
    } catch {}
}
function authRateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = ip + '|' + req.path;
    const now = Date.now();
    let e = _authHits.get(key);
    if (!e || e.resetAt < now) { e = { count: 0, resetAt: now + AUTH_RL_WINDOW_MS }; _authHits.set(key, e); }
    e.count++;
    if (e.count > AUTH_RL_MAX) {
        const retry = Math.ceil((e.resetAt - now) / 1000);
        res.setHeader('Retry-After', String(retry));
        console.warn('[AUTH-RL] bloqueado ip=%s path=%s count=%d', ip, req.path, e.count);
        _rlPersist();
        return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
    }
    next();
}
setInterval(() => { const now = Date.now(); for (const [k, e] of _authHits) if (e.resetAt < now) _authHits.delete(k); _rlPersist(); }, 60 * 1000).unref?.();

// ================================================================
//  REVOCACIÓN EN TIEMPO REAL (P0-2 del PDF)
//  Los tokens de alumno son de larga duración; para que suspender/eliminar/
//  revocar a un alumno CORTE su acceso sin esperar a que expire el token, se
//  revalida su estado contra la BD (con caché de 60s para no sobrecargar).
//  El heartbeat aplica esto cada ~30s → expulsión casi inmediata del reproductor.
// ================================================================
const _studentStatusCache = new Map(); // sub -> { revoked, checkedAt }
const STUDENT_STATUS_TTL_MS = 60 * 1000;
function invalidateStudentStatus(sub) { if (sub) _studentStatusCache.delete(sub); }
async function studentAccessRevoked(sub) {
    if (!sub || String(sub).startsWith('guest')) return false;
    const c = _studentStatusCache.get(sub);
    if (c && (Date.now() - c.checkedAt) < STUDENT_STATUS_TTL_MS) return c.revoked;
    let revoked = false;
    try {
        const r = await db.pool.query('SELECT active, approval_status FROM students WHERE id=$1', [sub]);
        const st = r.rows[0];
        // Sin registro de alumno → no bloquear (tokens de sesión de campus usan otro sub).
        if (st) {
            const active   = st.active !== false && st.active !== 0 && st.active !== '0';
            const approved = !st.approval_status || st.approval_status === 'approved';
            revoked = !(active && approved);
        }
    } catch { revoked = false; }
    _studentStatusCache.set(sub, { revoked, checkedAt: Date.now() });
    return revoked;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of _studentStatusCache) if (now - e.checkedAt > STUDENT_STATUS_TTL_MS) _studentStatusCache.delete(k); }, 5 * 60 * 1000).unref?.();

// ================================================================
//  USUARIOS EN MEMORIA (reemplazar por base de datos en producción)
//  Las contraseñas se almacenan como hashes bcrypt-like (PBKDF2 aquí
//  para evitar dependencia externa; usa bcrypt en producción real).
// ================================================================

const USERS_PATH = path.resolve('./data/users.json');

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    const attempt = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}

function loadUsers() {
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASS || 'changeme';

    if (!fs.existsSync(USERS_PATH)) {
        // Crear usuario admin inicial desde .env
        const dir = path.dirname(USERS_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const users = [{
            id: uuidv4(),
            username: adminUser,
            email: adminUser.includes('@') ? adminUser : undefined,
            passwordHash: hashPassword(adminPass),
            admin: true,
            label: 'Administrador',
        }];
        fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), { mode: 0o600 });
        return users;
    }

    let users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));

    // Sincronizar credenciales admin desde .env
    const adminEntry = users.find(u => u.admin);
    if (adminEntry) {
        let changed = false;
        if (adminEntry.username !== adminUser) {
            // Preservar username anterior como email si era un correo
            if (!adminEntry.email && adminEntry.username.includes('@')) {
                adminEntry.email = adminEntry.username;
            }
            adminEntry.username = adminUser;
            changed = true;
        }
        // Siempre asegurar que email coincida con username si es correo
        if (adminUser.includes('@') && adminEntry.email !== adminUser) {
            adminEntry.email = adminUser;
            changed = true;
        }
        // Regenerar hash solo si no hay hash válido o el hash no verifica contra ADMIN_PASS
        let hashOk = false;
        try {
            if (adminEntry.passwordHash && adminEntry.passwordHash.includes(':')) {
                hashOk = verifyPassword(adminPass, adminEntry.passwordHash);
            }
        } catch (_) { hashOk = false; }
        if (!hashOk) {
            adminEntry.passwordHash = hashPassword(adminPass);
            changed = true;
            console.log('[auth] Admin password hash regenerado desde env');
        }
        if (changed) {
            try { fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), { mode: 0o600 }); } catch {}
            console.log(`[auth] Admin sincronizado: ${adminUser}`);
        }
    }

    return users;
}

function findUser(username) {
    const wanted = normalizedEmail(username);
    return loadUsers().find(u => normalizedEmail(u.username) === wanted || normalizedEmail(u.email) === wanted) || null;
}

// ================================================================
//  UTILIDAD: GEOLOCALIZACIÓN + DETECCIÓN VPN/PROXY (ip-api.com)
// ================================================================

// Cache simple en memoria: ip → { data, expiresAt }
const _ipInfoCache = new Map();
const IP_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

/**
 * Consulta ip-api.com (free, 45 req/min).
 * Devuelve { country, city, proxy, hosting } o null si falla.
 * Nunca lanza excepción — fallo silencioso para no bloquear flujo principal.
 */
async function lookupIpInfo(ip) {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) return null;
    const cached = _ipInfoCache.get(ip);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 3000);
        try {
            http.get(`http://ip-api.com/json/${ip}?fields=status,country,city,proxy,hosting`, (res) => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => {
                    clearTimeout(timeout);
                    try {
                        const j = JSON.parse(raw);
                        if (j.status !== 'success') { resolve(null); return; }
                        const data = { country: j.country || '', city: j.city || '', proxy: !!j.proxy, hosting: !!j.hosting };
                        _ipInfoCache.set(ip, { data, expiresAt: Date.now() + IP_CACHE_TTL_MS });
                        resolve(data);
                    } catch { resolve(null); }
                });
            }).on('error', () => { clearTimeout(timeout); resolve(null); });
        } catch { clearTimeout(timeout); resolve(null); }
    });
}

// ================================================================
//  RUTAS: AUTENTICACIÓN
// ================================================================

app.get('/api/time', (_req, res) => {
    res.json({ ts: Date.now() });
});

// --- Login de alumnos: email + ID de alumno + fingerprint de dispositivo ---
app.post('/api/auth/login', authRateLimit, async (req, res) => {
    const { email, studentId, deviceFingerprint } = req.body || {};
    if (typeof email !== 'string' || typeof studentId !== 'string') {
        return res.status(400).json({ error: 'Email e ID de alumno requeridos' });
    }

    const emailNorm = email.trim().toLowerCase();
    const studentIdNorm = studentId.trim();
    const student = await findStudentByEmail(emailNorm);

    // Fallo idéntico si no existe o si ID no coincide (evita enumeración de emails)
    if (!student || student.studentId !== studentIdNorm) {
        return res.status(401).json({ error: 'Email o ID de alumno incorrecto' });
    }
    if (!student.active) {
        return res.status(403).json({ error: 'Acceso desactivado. Contacta al administrador.' });
    }

    // Vinculación de dispositivo: primer login → guarda; login distinto → rechaza
    const fp = (typeof deviceFingerprint === 'string') ? deviceFingerprint.slice(0, 64) : '';
    if (fp) {
        if (student.deviceId && student.deviceId !== fp) {
            return res.status(403).json({
                error: 'Este acceso está vinculado a otro dispositivo. Contacta al administrador para desvincular.'
            });
        }
        await db.bindDevice(student.id, fp || student.deviceId, new Date().toISOString());
    }

    const token = jwt.sign(
        {
            sub: student.id,
            email: student.email,
            label: student.name || student.email,
            deviceId: fp || student.deviceId || 'unknown',
            allowedVideos: Array.isArray(student.allowedVideos) ? student.allowedVideos : ['*'],
            admin: false,
        },
        JWT_SECRET,
        { expiresIn: STUDENT_JWT_EXPIRES, issuer: 'reproductor-cursos' }
    );

    // Detección VPN/proxy en background (no bloquea la respuesta)
    const clientIp = req.ip || req.connection?.remoteAddress || '';
    lookupIpInfo(clientIp).then(async geo => {
        if (geo && (geo.proxy || geo.hosting)) {
            await db.logSuspiciousActivity({
                studentId: student.id,
                deviceId:  fp || student.deviceId || null,
                type:      'vpn_proxy_detected',
                severity:  'medium',
                description: `Login desde IP con VPN/proxy detectado. País: ${geo.country}, Ciudad: ${geo.city}`,
                metadata:  { ip: clientIp, country: geo.country, city: geo.city, proxy: geo.proxy, hosting: geo.hosting },
            });
        }
    }).catch(() => {});

    res.json({ token, expiresIn: STUDENT_JWT_EXPIRES });
});

/**
 * POST /api/auth/login-email
 * Login para APK: email + password + 13 campos device info
 * Body: { email, password, deviceId, deviceModel, deviceSerial, osVersion, osVersionCode, cpuCores, totalRam,
 *         androidId, buildFingerprint, brand, manufacturer, fcmToken }
 */
app.post('/api/auth/login-email', authRateLimit, async (req, res) => {
    const { email, password, deviceId, deviceModel, deviceSerial, osVersion, osVersionCode, cpuCores, totalRam,
            androidId, buildFingerprint, brand, manufacturer, fcmToken } = req.body || {};

    if (!email || !password) {
        return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }

    try {
        // Buscar estudiante por email
        const result = await db.pool.query('SELECT * FROM students WHERE email = $1', [email.toLowerCase().trim()]);
        const student = result?.rows?.[0];

        // Validación: usuario no encontrado → 401 inmediato
        if (!student) {
            return res.status(401).json({ error: 'Email o contraseña incorrecto' });
        }

        // Verificar contraseña:
        // - Si tiene password_hash (registrado por APK): verificar con PBKDF2
        // - Si no tiene password_hash (usuario antiguo con studentId): aceptar studentId como contraseña
        let valid = false;
        if (student.password_hash) {
            try {
                valid = verifyPassword(password, student.password_hash);
            } catch (e) {
                console.error('[auth/login-email] verifyPassword error:', e.message);
                valid = false;
            }
        } else {
            // Usuario antiguo: la "contraseña" es su studentId
            valid = (student.student_id && password === student.student_id);
        }

        if (!valid) {
            return res.status(401).json({ error: 'Email o contraseña incorrecto' });
        }

        if (!student.active) {
            return res.status(403).json({ error: 'Acceso desactivado. Contacta al administrador.' });
        }

        // Verificar aprobación (si la columna existe; usuarios viejos no la tienen → asumir approved)
        const approvalStatus = student.approval_status || 'approved';
        if (approvalStatus !== 'approved') {
            return res.status(403).json({ 
                error: `Cuenta ${approvalStatus}. ${
                    approvalStatus === 'pending' ? 'Esperando aprobación del administrador.' : 'Contacta al administrador.'
                }`
            });
        }

        // Guardar información del dispositivo en la BD (tolerante a columnas faltantes)
        try {
            await db.pool.query(`
                UPDATE students SET
                    device_id = $1,
                    device_model = COALESCE($2, device_model),
                    device_serial = COALESCE($3, device_serial),
                    os_version = COALESCE($4, os_version),
                    os_version_code = COALESCE($5, os_version_code),
                    cpu_cores = COALESCE($6, cpu_cores),
                    total_ram = COALESCE($7, total_ram),
                    android_id = COALESCE($8, android_id),
                    build_fingerprint = COALESCE($9, build_fingerprint),
                    brand = COALESCE($10, brand),
                    manufacturer = COALESCE($11, manufacturer),
                    fcm_token = COALESCE($12, fcm_token),
                    last_login = NOW()::text
                WHERE id = $13
            `, [deviceId || null, deviceModel || null, deviceSerial || null, osVersion || null,
                osVersionCode || null, cpuCores || null, totalRam || null,
                androidId || null, buildFingerprint || null, brand || null,
                manufacturer || null, fcmToken || null, student.id]);
        } catch (updateErr) {
            // Si fallan columnas nuevas, hacer update mínimo
            console.warn('[auth/login-email] Full update failed, doing minimal update:', updateErr.message);
            await db.pool.query(`UPDATE students SET device_id = $1, last_login = NOW()::text WHERE id = $2`,
                [deviceId || null, student.id]);
        }

        // ── Verificación de integridad del dispositivo Android ─────────
        const rootIndicators = [];
        if (buildFingerprint) {
            const fp = String(buildFingerprint).toLowerCase();
            if (fp.includes('test-keys'))    rootIndicators.push('test-keys');
            if (fp.includes('userdebug'))    rootIndicators.push('userdebug');
            if (fp.includes('lineageos'))    rootIndicators.push('lineageos');
            if (fp.includes('cyanogenmod'))  rootIndicators.push('cyanogenmod');
        }
        const isRooted = req.body.isRooted === true;
        const hasSu    = req.body.hasSu === true;
        if (isRooted || hasSu) rootIndicators.push(isRooted ? 'root-flag' : 'su-binary');

        if (rootIndicators.length > 0) {
            console.warn(`[auth/login-email] [INTEGRITY] Dispositivo con indicadores de root: ${rootIndicators.join(', ')} email=${email} device=${deviceId} fingerprint=${buildFingerprint || '?'}`);
            return res.status(403).json({
                error: 'Dispositivo no compatible. Por seguridad, no se permite el acceso desde dispositivos modificados.',
                code: 'DEVICE_INTEGRITY_FAILED',
                indicators: rootIndicators
            });
        }

        // Generar JWT
        const token = jwt.sign(
            {
                sub: student.id,
                email: student.email,
                label: student.name || student.email,
                deviceId: deviceId || 'unknown',
                admin: false,
            },
            JWT_SECRET,
            { expiresIn: STUDENT_JWT_EXPIRES, issuer: 'reproductor-cursos' }
        );

        console.log(`[auth/login-email] ✅ Login exitoso: ${email} device=${deviceId}`);

        // Detección VPN/proxy en background
        const clientIp = req.ip || req.connection?.remoteAddress || '';
        lookupIpInfo(clientIp).then(async geo => {
            if (geo && (geo.proxy || geo.hosting)) {
                await db.pool.query(
                    `INSERT INTO suspicious_activity (student_id, device_id, type, severity, description, metadata, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, NOW()::text)`,
                    [student.id, deviceId, 'vpn_proxy_detected', 'medium',
                     `Login desde IP con VPN/proxy. País: ${geo.country}, Ciudad: ${geo.city}`,
                     JSON.stringify({ ip: clientIp, country: geo.country, city: geo.city, proxy: geo.proxy, hosting: geo.hosting })]
                );
            }
        }).catch(() => {});

        res.json({ token, expiresIn: STUDENT_JWT_EXPIRES, status: 'approved', email });
    } catch (error) {
        console.error('[auth/login-email] Error:', error.message, error.stack?.split('\n')[1]);
        res.status(500).json({ error: 'Error en autenticación', detail: error.message });
    }
});

// --- Login de administrador: username + contraseña ---
app.post('/api/auth/admin-login', authRateLimit, async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Credenciales requeridas' });
    }
    const uname = username.trim().toLowerCase();
    const envUser = process.env.ADMIN_USER || 'admin';
    const envPass = process.env.ADMIN_PASS || 'changeme';

    // Comparación directa contra env vars (fuente de verdad primaria)
    let valid = false;
    let userId, userLabel;
    if (uname === envUser.trim().toLowerCase() && password === envPass) {
        valid = true;
        userId = 'env-admin';
        userLabel = 'Administrador';
    } else {
        // Fallback: buscar en users.json con hash
        const user = findUser(uname);
        const hash = user?.passwordHash || `${crypto.randomBytes(16).toString('hex')}:${crypto.randomBytes(32).toString('hex')}`;
        try { valid = user?.admin === true ? verifyPassword(password, hash) : false; } catch (_) { valid = false; }
        if (valid && user) { userId = user.id; userLabel = user.label || user.username; }
    }

    if (!valid) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const token = jwt.sign(
        { sub: userId, username: uname, admin: true, label: userLabel },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES, issuer: 'reproductor-cursos' }
    );
    res.json({ token, expiresIn: JWT_EXPIRES });
});

app.post('/api/auth/refresh', async (req, res) => {
    const header = req.headers['authorization'] || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    let payload;
    try {
        payload = jwt.verify(header.slice(7), JWT_SECRET);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            payload = jwt.verify(header.slice(7), JWT_SECRET, { ignoreExpiration: true });
            const expiredAgo = Date.now() - (payload.exp * 1000);
            if (expiredAgo > 24 * 60 * 60 * 1000) return res.status(401).json({ error: 'Token expirado hace mas de 24h. Inicia sesion de nuevo.', code: 'TOKEN_EXPIRED' });
        } else {
            return res.status(401).json({ error: 'Token invalido' });
        }
    }
    if (!isAccountToken(payload)) return res.status(403).json({ error: 'Inicia sesion para renovar tu cuenta.', code: 'ACCOUNT_TOKEN_REQUIRED' });
    const { sub, username, admin, label, email, deviceId, allowedVideos, producer, producerId, hasLicense, licenseId, courseId, role, sid } = payload;
    if (sid) {
        // Un token de contenido cuya sesión ya se cerró no se renueva: hay que ingresar la licencia otra vez.
        const session = await db.getContentSession(sid).catch(() => null);
        if (!session || session.ended_at) return res.status(401).json({ error: 'Tu sesión de contenido terminó. Ingresa tu licencia de nuevo.', code: 'SESSION_ENDED' });
    }
    const expiresIn = admin ? JWT_EXPIRES : STUDENT_JWT_EXPIRES;
    const token = jwt.sign(
        { sub, username, admin, label, email, deviceId, allowedVideos, producer, producerId, hasLicense, licenseId, courseId, role, sid },
        JWT_SECRET,
        { expiresIn, issuer: 'reproductor-cursos' }
    );
    res.json({ token, expiresIn });
});

// ================================================================
//  SESSION — ONE LICENSE PER SESSION (Section 15)
// ================================================================

function hashLicenseKey(licenseKey) {
    return crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret')
        .update(licenseKey).digest('hex');
}

/**
 * POST /api/session/activate-license
 * Activa una licencia en la sesión actual. Devuelve Stage 2 JWT con acceso a un curso.
 * Body: { licenseKey, deviceId? }
 */
app.post('/api/session/activate-license', requireAuth, async (req, res) => {
    if (req.user.admin) return res.json({ status: 'admin', hasLicense: true, allowedVideos: ['*'] });
    // Misma transacción que /api/license/activate: reclama el serial (libre → activo, ligado al alumno),
    // vincula productor↔alumno, concede el curso, activa el dispositivo (cupo por licencia) y abre la
    // sesión de contenido. Idempotente para el mismo (licencia, dispositivo).
    if (req.body && !req.body.deviceId && req.user.deviceId && req.user.deviceId !== 'unknown') req.body.deviceId = req.user.deviceId;
    try { res.json({ status: 'activated', ...(await playerHandshake.activate(req)) }); }
    catch (error) { sendAccessError(res, error); }
});

/**
 * POST /api/auth/logout
 * Cierra la sesión de contenido en el servidor. Body opcional: { deviceId }.
 * Conserva la licencia, el dispositivo y el contador de activaciones: al volver a entrar se
 * pide la licencia de nuevo y el mismo equipo no consume un cupo adicional.
 */
app.post('/api/auth/logout', async (req, res) => {
    const header = req.headers['authorization'] || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
    let payload;
    try { payload = jwt.verify(header.slice(7), JWT_SECRET, { ignoreExpiration: true }); }
    catch { return res.status(401).json({ error: 'Token invalido' }); }
    if (!payload?.sub || payload.admin === true || payload.role === 'producer' || payload.producer === true) return res.json({ ok: true, ended: 0 });
    const deviceId = typeof req.body?.deviceId === 'string' && req.body.deviceId.trim() ? req.body.deviceId.trim().slice(0, 64) : (payload.deviceId || null);
    try {
        let ended = await db.endContentSessions({ studentId: payload.sub, sid: payload.sid || null, deviceId: null, reason: 'logout' });
        if (deviceId) ended += await db.endContentSessions({ studentId: payload.sub, deviceId, reason: 'logout' });
        await db.pool.query('DELETE FROM active_sessions WHERE user_id=$1 AND ($2::text IS NULL OR device_id=$2 OR device_id IS NULL)', [payload.sub, deviceId]);
        res.json({ ok: true, ended });
    } catch (error) {
        console.error('[auth/logout]', error.message);
        res.status(503).json({ error: 'No se pudo cerrar la sesión en el servidor. Reintenta.' });
    }
});

/**
 * GET /api/health
 * Health check para el balanceador / monitoreo.
 */
app.get('/api/health', async (req, res) => res.status(dbReady ? 200 : 503).json({ status: dbReady ? 'ok' : 'starting', dbReady, build: process.env.EDULOCK_BUILD_ID || 'development', ts: Date.now() }));

// Diagnóstico DB — solo accesible por administradores autenticados
let _lastDbError = null;
app.get('/api/db-test', requireAdmin, async (req, res) => {
    try {
        const connTest = await db.testConnection();
        // Try running initDb to catch the exact failing statement
        let initError = null;
        try { await db.initDb(); initError = null; } catch(e) { initError = e.message + ' code=' + e.code + ' detail=' + e.detail; }
        res.json({ ok: true, dbReady, connTest, initError, lastDbError: _lastDbError });
    } catch (err) {
        res.status(500).json({ ok: false, dbReady, error: err.message, code: err.code });
    }
});

/**
 * GET /api/auth/auto
 * Emite un JWT de sesión anónima sin credenciales.
 * Acepta ?did=<deviceFingerprint> para embeber el ID del dispositivo en el token.
 */
app.get('/api/auth/auto', async (req, res) => {
    const sessionId = uuidv4();
    // Sanitizar deviceId: solo hex/alfanumérico, max 64 chars
    const rawDid = (req.query.did || '').slice(0, 64).replace(/[^a-zA-Z0-9]/g, '');
    const deviceId = rawDid || 'anon-' + sessionId.slice(0, 8);
    // Sanitizar studentEmail: formato básico de email, max 254 chars
    const rawUid = (req.query.uid || '').slice(0, 254).trim();
    const studentEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawUid) ? rawUid : '';
    const token = jwt.sign(
        {
            sub:           sessionId,
            email:         studentEmail || 'guest',
            label:         deviceId,
            deviceId,
            studentEmail,
            allowedVideos: [], // sin acceso a ningún video — requiere login real
            guest:         true,
            admin:         false,
        },
        JWT_SECRET,
        { expiresIn: '1h', issuer: 'reproductor-cursos' } // vida corta para tokens anónimos
    );
    res.json({ token, expiresIn: '1h' });
});

/**
 * GET /api/embed-status
 * Indica si hay restricción de dominios activa (público, sin auth).
 */
app.get('/api/embed-status', async (req, res) => {
    const domains = await db.getAllowedDomains();
    res.json({ restricted: domains.length > 0 });
});

// ================================================================
//  RUTAS: REPRODUCCIÓN DE VIDEO
// ================================================================

/**
 * GET /api/video/:videoId/play
 * Devuelve una URL pre-firmada de corta duración para el manifest .m3u8
 * y el fingerprint de marca de agua específico para este usuario.
 */
app.get('/api/video/:videoId/play', requireAuth, requireBodyVideo, async (req, res) => {
    const { videoId } = req.params;
    // Validar videoId (UUID v4)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(videoId)) {
        return res.status(400).json({ error: 'videoId inválido' });
    }

    // Validar dominio de origen — solo permitir dominios configurados
    const allowedDomains = await db.getAllowedDomains();
    if (allowedDomains.length > 0) {
        const origin  = req.headers['origin']  || '';
        const referer = req.headers['referer'] || '';
        // Same-origin (iframe en el dominio propio) → origin y referer vacíos o propios → permitir
        const _selfHost = (process.env.PUBLIC_URL || 'edulocksystemsoficial.dpdns.org').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const isSameOrigin = (!origin && !referer)
            || origin.includes(_selfHost)
            || referer.includes(_selfHost);
        const isDomainAllowed = allowedDomains.some(d =>
            origin.startsWith(d) || referer.startsWith(d)
        );
        if (!isSameOrigin && !isDomainAllowed && !req.user.admin) {
            return res.status(403).json({ error: 'Reproducción no permitida desde este sitio.' });
        }
    }

    try { res.json(await playerHandshake.resolve(req, req.params.videoId, requestDevice(req, req.user))); }
    catch (error) { sendAccessError(res, error); }
});

/**
 * GET /api/vdo-player
 * Sirve una página HTML que embebe el reproductor VdoCipher.
 * Usada por la app Electron (webview) para que el origen sea este servidor
 * (dominio ya whitelisteado en VdoCipher) en lugar de file:// → evita Error 2014.
 */
app.get('/api/vdo-player', (req, res) => {
    const { otp, playbackInfo, token } = req.query;
    if (!otp || !playbackInfo || !token) {
        return res.status(400).send('Parámetros faltantes');
    }
    // Validar token JWT para evitar que alguien acceda sin autenticación
    try {
        jwt.verify(token, JWT_SECRET);
    } catch {
        return res.status(401).send('Token inválido o expirado');
    }
    // Validar formato de otp y playbackInfo (solo caracteres base64/URL-safe)
    if (!/^[A-Za-z0-9+/=._-]{10,1000}$/.test(otp) || !/^[A-Za-z0-9+/=._~-]{10,3000}$/.test(playbackInfo)) {
        return res.status(400).send('Formato inválido');
    }
    const otpSafe = JSON.stringify(otp);
    const pbSafe  = JSON.stringify(playbackInfo);
    const html = `<!DOCTYPE html><html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' https://player.vdocipher.com https://www.vdocipher.com; script-src 'self' 'unsafe-inline' https://player.vdocipher.com; style-src 'unsafe-inline'; connect-src https: wss:; img-src https: data: blob:; media-src https: blob:; frame-src https://player.vdocipher.com;">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden}#vdoplayer{width:100%;height:100%}</style>
</head>
<body>
<div id="vdoplayer"></div>
<script src="https://player.vdocipher.com/v2/api.js"></script>
<script>
VdoPlayer.getInstance({
  otp: ${otpSafe},
  playbackInfo: ${pbSafe},
  container: document.getElementById('vdoplayer'),
  configuration: { autoplay: true }
}).then(function(p){ window._vdoPlayer = p; }).catch(function(e){ console.error('[VDO]', e); });
</script>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    // Permitir que este frame sea cargado por Electron/file:// y por el servidor mismo
    res.setHeader('Content-Security-Policy', "default-src 'self' https://player.vdocipher.com https://www.vdocipher.com; script-src 'self' 'unsafe-inline' https://player.vdocipher.com; style-src 'unsafe-inline'; connect-src https: wss:; img-src https: data: blob:; media-src https: blob:;");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.send(html);
});

/**
 * GET /api/video/list  [ADMIN]
 * Lista los IDs de videos procesados disponibles en B2.
 */
app.get('/api/video/list', requireAdmin, async (req, res) => {
    try {
        const keys = await listFiles('hls/');
        // Extraer videoIds únicos de las rutas hls/<videoId>/...
        const ids = [...new Set(
            keys.map(k => k.split('/')[1]).filter(Boolean)
        )];
        res.json({ videos: ids });
    } catch (err) {
        console.error('[video/list]', err.message);
        res.status(500).json({ error: 'No se pudo obtener la lista de videos' });
    }
});

// ================================================================
//  RUTAS: DRM — CLAVES AES-128
// ================================================================

// ── Tokens de clave de un solo uso ───────────────────────────────────────────
// Cada vez que se sirve un manifest con #EXT-X-KEY, se genera un token
// específico (ktok) para esa petición de clave. Es de corta duración (15 min)
// y solo puede usarse MAX_KEY_USES veces (para tolerar reintentos de HLS.js).
// Esto impide que alguien que capture el tráfico con Wireshark pueda reusar
// la URL de la clave para descifrar segmentos fuera del reproductor.
const _keyTokens = new Map(); // ktok → { keyId, deviceId, exp, uses }
const MAX_KEY_USES = 3;
const KEY_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutos

setInterval(() => {
    const now = Date.now();
    for (const [t, v] of _keyTokens) {
        if (v.exp < now) _keyTokens.delete(t);
    }
}, 5 * 60 * 1000);

function generateKeyToken(keyId, claims) {
    const ktok = crypto.randomBytes(24).toString('hex');
    _keyTokens.set(ktok, {
        keyId,
        claims,
        exp: Date.now() + KEY_TOKEN_TTL_MS,
        uses: 0,
    });
    return ktok;
}

/**
 * GET /api/drm/key/:keyId
 * Devuelve la clave AES-128 binaria SOLO a clientes con JWT válido.
 * FFmpeg apunta el EXT-X-KEY URI a este endpoint.
 *
 * El reproductor HLS.js solicita este endpoint automáticamente cuando
 * encuentra EXT-X-KEY en el manifest.
 */
/**
 * GET /api/drm/proxy-key
 * Para videos de Bunny que ya vienen cifrados con su propia clave AES-128.
 * Proxea la clave original de Bunny pero detrás de autenticación JWT.
 */
app.get('/api/drm/proxy-key', async (req,res)=>{
    try {
        const videoId=req.query.videoId;
        const context=await authorizeMedia(req,videoId);
        const keyUrl=Buffer.from(String(req.query.k||''),'base64url').toString('utf8');
        if(!belongsToVideo(keyUrl,context.video.bunnyUrl)||!verifyResourceSignature(JWT_SECRET,req.query.sig,'key',videoId,keyUrl))return res.status(403).send('Recurso no autorizado');
        const target=await signCourseBunnyUrl(keyUrl,context.video);
        const targetParsed=new URL(target);
        const upstreamReq=https.get(target,{timeout:8000,headers:{Referer:targetParsed.origin+'/'}},up=>{
            if(up.statusCode!==200){up.resume();return res.status(502).send('Clave no disponible');}
            res.setHeader('Content-Type','application/octet-stream');res.setHeader('Cache-Control','no-store');up.pipe(res);
        });
        upstreamReq.on('timeout',()=>upstreamReq.destroy());
        upstreamReq.on('error',()=>{if(!res.headersSent)res.status(502).end();else res.end();});
        res.on('close',()=>upstreamReq.destroy());
    } catch(e){sendAccessError(res,e);}
});

app.get('/api/drm/key/:keyId',async(req,res)=>{
    try {
        const {keyId}=req.params;const videoId=getVideoIdForKey(keyId);
        if(!videoId)return res.status(404).send('Clave no encontrada');
        if(req.query.ktok){
            const entry=_keyTokens.get(req.query.ktok);
            if(!entry||entry.exp<Date.now()||entry.keyId!==keyId)return res.status(401).send('Token de clave expirado');
            if (!entry.claims.sessionId || entry.claims.videoId !== videoId) return res.status(403).send('Sesión de reproducción requerida');
            await accessPolicy.authorizeSession(entry.claims,entry.claims.sessionId,entry.claims.deviceId);
            entry.uses++;if(entry.uses>=MAX_KEY_USES)_keyTokens.delete(req.query.ktok);
        }else await authorizeMedia(req,videoId);
        const key=getKeyBuffer(keyId);if(!key)return res.status(404).send('Clave no encontrada');
        res.setHeader('Cache-Control','no-store');res.type('application/octet-stream').send(key);
    }catch(e){sendAccessError(res,e);}
});

/**
 * POST /api/drm/clearkey
 * Licencia ClearKey EME (W3C). El navegador envía { kids, type }.
 * Solo disponible para usuarios autenticados.
 */
app.post('/api/drm/clearkey', requireAuth, async (req, res) => {
    const { kids } = req.body || {};
    if (!Array.isArray(kids) || kids.length === 0) {
        return res.status(400).json({ error: 'kids requerido' });
    }
    // Validar formato base64url
    for (const k of kids) {
        if (typeof k !== 'string' || !/^[A-Za-z0-9_-]+=*$/.test(k)) {
            return res.status(400).json({ error: 'kid inválido' });
        }
    }
    try {
        for(const kid of kids){
            const hex=Buffer.from(kid,'base64url').toString('hex');
            if(hex.length!==32)return res.status(400).json({error:'kid inválido'});
            const keyId=hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
            const videoId=getVideoIdForKey(keyId);
            if(!videoId)return res.status(403).json({error:'Clave no autorizada'});
            await authorizeMedia(req,videoId);
        }
    }catch(e){return sendAccessError(res,e);}
    const license = buildClearKeyLicense(kids);
    res.json(license);
});

/**
 * POST /api/drm/widevine
 * Proxy de licencia Widevine (requiere EZDRM / BuyDRM configurado en .env).
 * El cuerpo debe ser el challenge binario enviado por el Widevine CDM.
 */
app.post('/api/drm/widevine', requireAuth, express.raw({ type: 'application/octet-stream', limit: '64kb' }), async (req, res) => {
    try {
        const response = await proxyWidevineLicense(req.body);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(response);
    } catch (err) {
        console.error('[drm/widevine]', err.message);
        res.status(502).json({ error: err.message });
    }
});

// ================================================================
//  RUTAS: SUBIDA DE VIDEO [ADMIN]
// ================================================================

const upload = multer({
    storage: multer.diskStorage({
        destination: os.tmpdir(),
        filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
    }),
    limits: { fileSize: Number(process.env.STREAM_MAX_FILE_BYTES) || 1024 * 1024 * 1024 }, // Configurable, 1 GiB por defecto
    fileFilter: (req, file, cb) => {
        const allowed = ['.mp4', '.mov', '.mkv', '.avi', '.webm'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) cb(null, true);
        else cb(new Error('Tipo de archivo no permitido'), false);
    },
});

app.post('/api/video/upload', requireAdmin, upload.single('video'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Archivo de video requerido (mp4, mov, mkv, avi, webm)' });

    const videoId = uuidv4();
    const title   = (req.body && req.body.title) ? req.body.title.slice(0, 120) : req.file.originalname;
    const localPath = req.file.path;

    // Añadir al catálogo inmediatamente (estado: procesando)
    addToCatalog({ videoId, title, status: 'processing', uploadedAt: new Date().toISOString(), segmentCount: 0 });

    // Responder de inmediato y procesar en segundo plano
    res.json({ videoId, status: 'processing', message: '¡Video recibido! El procesamiento HLS comenzó en segundo plano.' });

    const base = getPublicBase(req);
    try {
        const result = await processVideo(localPath, videoId, base);
        await db.updateCatalogEntry({ videoId, status: 'ready', segmentCount: result.segmentCount, keyId: result.keyId });
        console.log(`[upload] Video listo: ${videoId} (${result.segmentCount} segmentos)`);
        syncCatalogSeed();
    } catch (err) {
        await db.updateCatalogEntry({ videoId, status: 'error', error: err.message });
        console.error(`[upload] Error procesando video ${videoId}:`, err.message);
    } finally {
        fs.unlink(localPath, () => {});
    }
});

/**
 * GET /api/video/catalog  [ADMIN]
 * Devuelve el catálogo completo de videos con su estado de procesamiento.
 */
app.get('/api/video/catalog', requireAdmin, async (req, res) => {
    res.json({ catalog: await db.loadCatalog() });
});

/**
 * GET /api/video/catalog/export-seed  [ADMIN]
 * Devuelve el catálogo en formato JSON listo para pegar en CATALOG_SEED.
 * Permite persistir el catálogo entre reinicios.
 */
app.get('/api/video/catalog/export-seed', requireAdmin, async (req, res) => {
    const catalog = await db.loadCatalog();
    res.json(catalog);
});

/**
/**
 * DELETE /api/video/bulk  [ADMIN]
 * Elimina múltiples videos del catálogo en una sola petición.
 * Body: { videoIds: string[] }
 */
app.delete('/api/video/bulk', requireAdmin, async (req, res) => {
    const { videoIds } = req.body || {};
    if (!Array.isArray(videoIds) || !videoIds.length) return res.status(400).json({ error: 'videoIds (array) requerido' });
    // Validar cada ID antes de borrar
    for (const id of videoIds) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'videoId inválido: ' + id });
    }
    let deleted = 0;
    for (const videoId of videoIds) {
        try {
            await db.deleteCatalogEntry(videoId);
            if (LOCAL_MODE) {
                const dir = path.join('./public/hls', 'hls', videoId);
                if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
            }
            deleted++;
        } catch (e) { /* skip single failures */ }
    }
    syncCatalogSeed();
    res.json({ ok: true, deleted });
});

/**
 * DELETE /api/video/:videoId  [ADMIN]
 * Elimina un video del catálogo (y sus archivos si es modo local).
 */
app.delete('/api/video/:videoId', requireAdmin, async (req, res) => {
    const { videoId } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(videoId)) return res.status(400).json({ error: 'videoId inválido' });
    await db.deleteCatalogEntry(videoId);
    if (LOCAL_MODE) {
        const dir = path.join('./public/hls', 'hls', videoId);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    syncCatalogSeed();
    res.json({ ok: true });
});

// ================================================================
//  PANEL DE CURSOS APROBADOS — endpoints para el reproductor
// ================================================================

/**
 * GET /api/my-catalog  [alumno autenticado]
 * Devuelve los cursos, módulos y videos accesibles para el alumno logueado.
 * Estructura jerárquica: curso → módulos (con anidación) → videos + documentos.
 */
app.get('/api/my-catalog', requireAuth, async (req, res) => {
    try {
        // One-license-per-session: student must activate a license first
        if (!req.user.admin && req.user.hasLicense === false) {
            return res.json({ courses: [], requiresLicense: true });
        }
        const allowed   = req.user.admin ? ['*'] : (Array.isArray(req.user.allowedVideos) ? req.user.allowedVideos : ['*']);
        const allVideos = (await db.loadCatalog()).filter(v => v.status === 'ready');
        const videos    = allowed.includes('*') ? allVideos : allVideos.filter(v => allowed.includes(v.videoId) || allowed.includes(v.courseId));
        const courses   = await db.getAllCourses();

        // Obtener módulos de todos los cursos en un solo query
        const modRows = await db.pool.query('SELECT * FROM modules ORDER BY sort_order ASC, created_at ASC');
        const allMods = modRows.rows.map(r => {
            let docs = []; try { docs = JSON.parse(r.documents || '[]'); } catch {}
            return { id: r.id, courseId: r.course_id, parentId: r.parent_id || null, name: r.name, sortOrder: r.sort_order, documents: docs };
        });

        const visibleCourses = new Set(courses.filter(c => allowed.includes('*') || allowed.includes(c.id) || videos.some(v => v.courseId === c.id)).map(c => c.id));
        const resourceTargets = [...videos.map(v => ({ kind: 'video', id: v.videoId })),
            ...allMods.filter(m => visibleCourses.has(m.courseId)).map(m => ({ kind: 'module', id: m.id }))];
        const resourceRows = [];
        for (let offset = 0; offset < resourceTargets.length; offset += 1000) resourceRows.push(...await resourceRepository.listForTargets(resourceTargets.slice(offset, offset + 1000)));
        const attached = new Map();
        for (const row of resourceRows) {
            const key = row.targetKind + ':' + row.targetId;
            if (!attached.has(key)) attached.set(key, []);
            attached.get(key).push(serializeResource(row));
        }
        for (const video of videos) video.documents = [...legacyPublicDocuments(video.documents), ...(attached.get('video:' + video.videoId) || [])];
        for (const module of allMods) module.documents = [...legacyPublicDocuments(module.documents), ...(attached.get('module:' + module.id) || [])];

        // Construir árbol de módulos (con anidación via parentId)
        const buildTree = (mods, parentId) =>
            mods.filter(m => m.parentId === parentId)
                .map(m => ({ ...m, children: buildTree(mods, m.id) }));

        const result = courses
            .filter(c => visibleCourses.has(c.id))
            .map(c => {
                const courseMods = allMods.filter(m => m.courseId === c.id);
                const modTree    = buildTree(courseMods, null);
                const addVideos  = (nodes) => nodes.map(node => ({
                    ...node,
                    videos:   videos.filter(v => v.moduleId === node.id).map(v => ({ videoId: v.videoId, title: v.title, documents: v.documents || [], sortOrder: v.sortOrder })).sort((a,b) => a.sortOrder - b.sortOrder),
                    children: addVideos(node.children),
                }));
                const rootVideos = videos.filter(v => v.courseId === c.id && !v.moduleId).map(v => ({ videoId: v.videoId, title: v.title, documents: v.documents || [], sortOrder: v.sortOrder })).sort((a,b) => a.sortOrder - b.sortOrder);
                return { id: c.id, name: c.name, modules: addVideos(modTree), videos: rootVideos };
            });

        // Videos sin curso
        const unassigned = videos.filter(v => !v.courseId).map(v => ({ videoId: v.videoId, title: v.title, documents: v.documents || [], sortOrder: v.sortOrder }));
        if (unassigned.length) result.push({ id: '__none__', name: 'Sin curso', modules: [], videos: unassigned });

        res.json({ courses: result });
    } catch (err) {
        console.error('[my-catalog]', err);
        res.status(500).json({ error: 'Error al cargar catálogo' });
    }
});

/**
 * POST /api/resolve-direct  [alumno autenticado]
 * Genera manifest URL para un video directamente (sin expiración en el link).
 * El dispositivo se valida en tiempo real contra la BD.
 * Body: { videoId }
 */
app.post('/api/resolve-direct', requireAuth, requireBodyVideo, async (req, res) => {
    try { res.json(await playerHandshake.resolve(req, req.body.videoId, requestDevice(req, req.user))); }
    catch (error) { sendAccessError(res, error); }
});

/**
 * PATCH /api/catalog/:videoId/documents  [ADMIN]
 * Actualiza los documentos/recursos descargables de un video.
 * Body: { documents: [{ name, url, type }] }
 */
app.patch('/api/catalog/:videoId/documents', requireAdmin, async (req, res) => {
    try {
    const { videoId } = req.params;
    const { documents } = req.body || {};
    if (!Array.isArray(documents)) return res.status(400).json({ error: 'documents array requerido' });
    if (documents.length > 200 || documents.some(d => d?.resourceId || d?.protection === 'protected')) return res.status(400).json({ error: 'Gestiona los PDF protegidos desde Recursos.' });
    const clean = legacyPublicDocuments(documents);
    if (clean.length !== documents.length) return res.status(400).json({ error: 'Cada recurso libre necesita nombre y URL HTTP o HTTPS válida.' });
    if (!await db.getCatalogById(videoId)) return res.status(404).json({ error: 'Video no encontrado.' });
    await db.updateCatalogDocuments(videoId, clean);
    res.json({ ok: true, documents: clean });
    } catch (e) { resourceError(res, e); }
});

/**
 * PATCH /api/modules/:id/documents  [ADMIN]
 * Actualiza los documentos/recursos descargables de un módulo.
 * Body: { documents: [{ name, url, type }] }
 */
app.patch('/api/modules/:id/documents', requireAdmin, async (req, res) => {
    try {
    const { id } = req.params;
    const { documents } = req.body || {};
    if (!Array.isArray(documents)) return res.status(400).json({ error: 'documents array requerido' });
    if (documents.length > 200 || documents.some(d => d?.resourceId || d?.protection === 'protected')) return res.status(400).json({ error: 'Gestiona los PDF protegidos desde Recursos.' });
    const clean = legacyPublicDocuments(documents);
    if (clean.length !== documents.length) return res.status(400).json({ error: 'Cada recurso libre necesita nombre y URL HTTP o HTTPS válida.' });
    if (!(await db.pool.query('SELECT id FROM modules WHERE id=$1', [id])).rows.length) return res.status(404).json({ error: 'Módulo no encontrado.' });
    await db.updateModuleDocuments(id, clean);
    res.json({ ok: true, documents: clean });
    } catch (e) { resourceError(res, e); }
});

const resourceService = createResourceService({ repository: resourceRepository, storage: resourceStorage,
    renderer: pdfRenderer, accessPolicy, secret: JWT_SECRET, getProducer: id => db.getProducerById(id) });
installResourceRoutes(app, { service: resourceService, multer, requireAccount: requireResourceAccount,
    requireManager: requireResourceManager, deviceFor: req => requestDevice(req, req.user) });

/**
 * POST /api/catalog/add-bunny  [ADMIN]
 * Agrega un video de Bunny.net al catálogo sin subir ni procesar archivos.
 * El admin pega la URL HLS (.m3u8) de Bunny Stream.
 *
 * Body: { title, bunnyUrl }
 * bunnyUrl ejemplo: https://vz-XXXXXX.b-cdn.net/VIDEO-ID/playlist.m3u8
 */

/**
 * POST /api/catalog/restore-bulk  [ADMIN]
 * Restaura un array de videos preservando IDs originales (para recuperación tras reinicio).
 * Body: { videos: [{ videoId, title, bunnyUrl, courseId, sortOrder, keyId, uploadedAt }] }
 */
app.post('/api/catalog/restore-bulk', requireAdmin, async (req, res) => {
    const { videos } = req.body || {};
    if (!Array.isArray(videos)) return res.status(400).json({ error: 'videos array requerido' });
    let inserted = 0, skipped = 0;
    for (const v of videos) {
        if (!v.videoId || !v.bunnyUrl) { skipped++; continue; }
        if (!isSafeBunnyUrl(v.bunnyUrl)) { skipped++; continue; }
        const existing = await db.getCatalogById(v.videoId);
        if (existing) { skipped++; continue; }
        try {
            await db.addToCatalog({
                videoId:    v.videoId,
                title:      (v.title || v.videoId).slice(0, 120),
                status:     'ready',
                sourceType: 'bunny',
                bunnyUrl:   v.bunnyUrl,
                keyId:      v.keyId || null,
                courseId:   v.courseId || null,
                sortOrder:  v.sortOrder || 0,
                uploadedAt: v.uploadedAt || new Date().toISOString(),
            });
            inserted++;
        } catch { skipped++; }
    }
    res.json({ ok: true, inserted, skipped });
});
/**
 * POST /api/catalog/add-vdocipher-direct  [ADMIN]
 * Agrega un video pegando el link directo del player de VdoCipher.
 * Guarda la URL completa para cargarla directamente — funciona con videos de cualquier cuenta.
 * Body: { title, vdoUrl }
 */
app.post('/api/catalog/add-vdocipher-direct', requireAdmin, async (req, res) => {
    const { title, vdoUrl } = req.body || {};
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title requerido' });
    if (!vdoUrl || typeof vdoUrl !== 'string') return res.status(400).json({ error: 'vdoUrl requerido' });
    if (!vdoUrl.includes('player.vdocipher.com')) return res.status(400).json({ error: 'URL inválida: debe ser de player.vdocipher.com' });

    // Validar que tenga otp y playbackInfo
    let hasOtp = false;
    try {
        const urlObj = new URL(vdoUrl);
        hasOtp = !!(urlObj.searchParams.get('otp') && urlObj.searchParams.get('playbackInfo'));
    } catch {}
    if (!hasOtp) return res.status(400).json({ error: 'El link debe contener otp y playbackInfo. Copia el link completo del player.' });

    const videoId = uuidv4();
    await addToCatalog({
        videoId,
        title:      title.trim().slice(0, 120),
        status:     'ready',
        sourceType: 'vdocipher_direct',  // tipo especial: URL directa, no regenera OTP
        bunnyUrl:   vdoUrl.trim(),       // guarda la URL completa
        uploadedAt: new Date().toISOString(),
    });
    syncCatalogSeed();
    res.status(201).json({ videoId, title, status: 'ready', sourceType: 'vdocipher_direct' });
});

/**
 * POST /api/catalog/add-vdocipher  [ADMIN]
 * Agrega un video de VdoCipher al catálogo usando su Video ID.
 * Body: { title, vdoVideoId }
 */
app.post('/api/catalog/add-vdocipher', requireAdmin, async (req, res) => {
    const { title, vdoVideoId } = req.body || {};
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title requerido' });
    if (!vdoVideoId || typeof vdoVideoId !== 'string') return res.status(400).json({ error: 'vdoVideoId requerido' });
    const clean = vdoVideoId.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!clean) return res.status(400).json({ error: 'vdoVideoId inválido' });

    const videoId = uuidv4();
    await addToCatalog({
        videoId,
        title:      title.trim().slice(0, 120),
        status:     'ready',
        sourceType: 'vdocipher',
        bunnyUrl:   clean,   // reutilizamos la columna para guardar el VdoCipher Video ID
        uploadedAt: new Date().toISOString(),
    });
    syncCatalogSeed();
    res.status(201).json({ videoId, title, status: 'ready', sourceType: 'vdocipher', vdoVideoId: clean });
});

app.post('/api/catalog/add-bunny', requireAdmin, async (req, res) => {
    const { title, bunnyUrl } = req.body || {};
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title requerido' });
    if (!bunnyUrl || typeof bunnyUrl !== 'string') return res.status(400).json({ error: 'bunnyUrl requerido' });

    // Seguridad: solo dominios de Bunny.net permitidos
    if (!isSafeBunnyUrl(bunnyUrl)) {
        return res.status(400).json({ error: 'URL inválida. Solo se permiten dominios de Bunny.net (*.b-cdn.net, *.bunnycdn.com)' });
    }
    if (!bunnyUrl.includes('.m3u8')) {
        return res.status(400).json({ error: 'La URL debe apuntar a un archivo .m3u8' });
    }

    const videoId = uuidv4();
    // Generar clave AES-128 exclusiva para este video de Bunny
    const { keyId } = generateKey(videoId);

    addToCatalog({
        videoId,
        title:      title.trim().slice(0, 120),
        status:     'ready',
        sourceType: 'bunny',
        bunnyUrl:   bunnyUrl.trim(),
        keyId,
        uploadedAt: new Date().toISOString(),
    });

    syncCatalogSeed();
    res.status(201).json({ videoId, title, status: 'ready', sourceType: 'bunny' });
});

// ================================================================
//  RUTAS: DOMINIOS PERMITIDOS [ADMIN]
// ================================================================

/** GET /api/allowed-domains — Lista dominios permitidos */
app.get('/api/allowed-domains', requireAdmin, async (req, res) => {
    res.json({ domains: await db.getAllowedDomains() });
});

/** POST /api/allowed-domains — Agrega un dominio */
app.post('/api/allowed-domains', requireAdmin, async (req, res) => {
    const { domain } = req.body || {};
    if (!domain || typeof domain !== 'string') return res.status(400).json({ error: 'domain requerido' });
    const clean = domain.trim().toLowerCase().replace(/\/+$/, '');
    if (!/^https?:\/\/[a-z0-9.-]+/.test(clean)) return res.status(400).json({ error: 'Formato inválido. Ejemplo: https://edulocksystemsoficial.dpdns.org' });
    await db.addAllowedDomain(clean);
    syncDomainsSeed();
    res.json({ ok: true, domains: await db.getAllowedDomains() });
});

/** DELETE /api/allowed-domains — Elimina un dominio */
app.delete('/api/allowed-domains', requireAdmin, async (req, res) => {
    const { domain } = req.body || {};
    if (!domain) return res.status(400).json({ error: 'domain requerido' });
    await db.removeAllowedDomain(domain);
    syncDomainsSeed();
    res.json({ ok: true, domains: await db.getAllowedDomains() });
});

// ================================================================
//  RUTAS: CURSOS [ADMIN]
// ================================================================

/** GET /api/courses — Lista todos los cursos con conteo de videos */
app.get('/api/courses', requireAdmin, async (req, res) => {
    const courses = await db.getAllCourses();
    const catalog = await db.loadCatalog();
    const result = courses.map(c => ({
        ...c,
        videoCount: catalog.filter(v => v.courseId === c.id).length,
    }));
    const unassigned = catalog.filter(v => !v.courseId).length;
    res.json({ courses: result, unassignedCount: unassigned });
});

/** POST /api/courses — Crea un curso */
app.post('/api/courses', requireAdmin, async (req, res) => {
    try { const course = await createStreamCourse(req.body, {admin:true}); res.status(201).json(course); }
    catch(e) { streamError(res,e); }
});


/** POST /api/courses/restore-bulk — Restaura cursos preservando IDs originales */
app.post('/api/courses/restore-bulk', requireAdmin, async (req, res) => {
    const { courses } = req.body || {};
    if (!Array.isArray(courses)) return res.status(400).json({ error: 'courses array requerido' });
    let inserted = 0, skipped = 0;
    for (const c of courses) {
        if (!c.id || !c.name) { skipped++; continue; }
        try {
            const existing = await db.getCourseById(c.id);
            if (existing) { skipped++; continue; }
            await db.createCourse({ id: c.id, name: c.name.slice(0, 120), author: (c.author || '').slice(0, 100) });
            inserted++;
        } catch { skipped++; }
    }
    res.json({ ok: true, inserted, skipped });
});

/**
 * POST /api/audit/seed-devices  [ADMIN]
 * Restaura asociaciones email+deviceId en audit_log tras un deploy.
 * Acepta [{ studentEmail, deviceId }] — inserta un registro mínimo por par si no existe ya.
 */
app.post('/api/audit/seed-devices', requireAdmin, async (req, res) => {
    const { records } = req.body || {};
    if (!Array.isArray(records)) return res.status(400).json({ error: 'records array requerido' });
    let inserted = 0, skipped = 0;
    for (const r of records) {
        const email    = (r.studentEmail || '').slice(0, 254).trim();
        const deviceId = (r.deviceId     || '').slice(0, 128).trim();
        if (!email || !deviceId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
        try {
            const fp = `seed_${Buffer.from(email + ':' + deviceId).toString('base64').slice(0, 40)}`;
            // Verificar si ya existe un registro con este fingerprint
            const ex = await db.detectLeak(fp);
            if (ex) { skipped++; continue; }
            await db.logDelivery({
                fingerprint:   fp,
                userId:        email,
                videoId:       'restored_association',
                deviceId:      deviceId,
                studentEmail:  email,
                ip:            'restored',
                userAgent:     'restored',
            });
            inserted++;
        } catch { skipped++; }
    }
    res.json({ ok: true, inserted, skipped });
});

/** PUT /api/courses/:id — Actualiza nombre/autor */
app.put('/api/courses/:id', requireAdmin, async (req, res) => {
    const { name, author } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name requerido' });
    const course = await db.updateCourse(req.params.id, { name: name.trim().slice(0, 120), author: (author || '').trim().slice(0, 100) });
    if (!course) return res.status(404).json({ error: 'Curso no encontrado' });
    res.json(course);
});

/** DELETE /api/courses/all — Elimina TODOS los cursos (solo en emergencia de restauración) */
app.delete('/api/courses/all', requireAdmin, async (req, res) => {
    const courses = await db.getAllCourses();
    for (const c of courses) await db.deleteCourse(c.id);
    res.json({ ok: true, deleted: courses.length });
});

/** DELETE /api/courses/:id — Elimina un curso (videos quedan sin asignar) */
app.delete('/api/courses/:id', requireAdmin, async (req, res) => {
    await db.deleteCourse(req.params.id);
    syncCatalogSeed();
    res.json({ ok: true });
});

/** GET /api/courses/unassigned/videos — Videos sin curso (MUST be before :id route) */
app.get('/api/courses/unassigned/videos', requireAdmin, async (req, res) => {
    const videos = await db.getCatalogUnassigned();
    res.json({ videos });
});

/** GET /api/courses/:id/videos — Videos de un curso */
app.get('/api/courses/:id/videos', requireAdmin, async (req, res) => {
    const videos = await db.getCatalogByCourse(req.params.id);
    res.json({ videos });
});

/** POST /api/courses/move-video — Mover video a un curso (y opcionalmente a un módulo) */
app.post('/api/courses/move-video', requireAdmin, async (req, res) => {
    const { videoId, courseId, moduleId } = req.body || {};
    if (!videoId) return res.status(400).json({ error: 'videoId requerido' });
    await db.moveVideoToCourse(videoId, courseId || null);
    // Si se indica módulo, asignarlo; si moduleId===null explícito, desasignar
    if (moduleId !== undefined) await db.moveVideoToModule(videoId, moduleId || null);
    syncCatalogSeed();
    res.json({ ok: true });
});

/** POST /api/courses/bulk-move — Mover multiples videos a un curso */
app.post('/api/courses/bulk-move', requireAdmin, async (req, res) => {
    const { videoIds, courseId } = req.body || {};
    if (!Array.isArray(videoIds) || !videoIds.length) return res.status(400).json({ error: 'videoIds requerido (array no vacio)' });
    for (const vid of videoIds) {
        await db.moveVideoToCourse(vid, courseId || null);
    }
    syncCatalogSeed();
    res.json({ ok: true, moved: videoIds.length });
});

/** POST /api/courses/reorder — Reordenar videos dentro de un curso */
app.post('/api/courses/reorder', requireAdmin, async (req, res) => {
    const { orders } = req.body || {};
    if (!Array.isArray(orders)) return res.status(400).json({ error: 'orders requerido (array)' });
    await db.reorderVideos(orders);
    syncCatalogSeed();
    res.json({ ok: true });
});

// ================================================================
//  RUTAS: MÓDULOS [ADMIN]
// ================================================================

/** GET /api/courses/:id/modules — Lista todos los módulos de un curso */
app.get('/api/courses/:id/modules', requireAdmin, async (req, res) => {
    const modules = await db.getModulesByCourse(req.params.id);
    res.json({ modules });
});

/** POST /api/courses/:id/modules — Crea un módulo (o submódulo con parentId) */
app.post('/api/courses/:id/modules', requireAdmin, async (req, res) => {
    try { const mod = await createStreamModule(req.params.id,req.body,{admin:true}); res.status(201).json(mod); }
    catch(e) { streamError(res,e); }
});

/** PUT /api/modules/:id — Renombra o reordena un módulo */
app.put('/api/modules/:id', requireAdmin, async (req, res) => {
    const { name, sortOrder } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name requerido' });
    const mod = await db.updateModule(req.params.id, { name, sortOrder: sortOrder || 0 });
    if (!mod) return res.status(404).json({ error: 'Módulo no encontrado' });
    res.json(mod);
});

/** DELETE /api/modules/:id — Elimina un módulo (y sus hijos; videos quedan sin módulo) */
app.delete('/api/modules/:id', requireAdmin, async (req, res) => {
    await db.deleteModule(req.params.id);
    res.json({ ok: true });
});

/** POST /api/courses/set-module — Asigna un video a un módulo específico */
app.post('/api/courses/set-module', requireAdmin, async (req, res) => {
    const { videoId, moduleId } = req.body || {};
    if (!videoId) return res.status(400).json({ error: 'videoId requerido' });
    await db.moveVideoToModule(videoId, moduleId || null);
    res.json({ ok: true });
});

// ================================================================
//  RUTAS: BUNNY.NET API IMPORT [ADMIN]
// ================================================================

/** GET /api/bunny/config — Devuelve si hay config guardada (sin exponer la key) */
app.get('/api/bunny/config', requireAdmin, async (req, res) => {
    const hasKey = !!await db.getConfig('bunny_api_key');
    const libraryId = await db.getConfig('bunny_library_id') || '';
    const cdnHostname = await db.getConfig('bunny_cdn_hostname') || '';
    // accountKey: DB tiene prioridad, si no, usar env var BUNNY_ACCOUNT_KEY
    const accountKey = await db.getConfig('bunny_account_key') || process.env.BUNNY_ACCOUNT_KEY || '';
    res.json({ configured: hasKey, libraryId, cdnHostname, accountKey });
});

/** POST /api/bunny/config — Guarda API key, library ID y CDN hostname */
app.post('/api/bunny/config', requireAdmin, async (req, res) => {
    const { apiKey, libraryId, cdnHostname, accountKey } = req.body || {};
    if (!apiKey || !libraryId) return res.status(400).json({ error: 'apiKey y libraryId requeridos' });
    await db.setConfig('bunny_api_key', apiKey.trim());
    await db.setConfig('bunny_library_id', libraryId.trim());
    if (cdnHostname) {
        let cdn = cdnHostname.trim().replace(/\/$/, '');
        if (!/^https?:\/\//i.test(cdn)) cdn = 'https://' + cdn;
        await db.setConfig('bunny_cdn_hostname', cdn);
    }
    if (accountKey) await db.setConfig('bunny_account_key', accountKey.trim());
    res.json({ ok: true });
});

/**
 * GET /api/bunny/videos — Obtiene todos los videos de la biblioteca Bunny configurada.
 * Pagina automáticamente (Bunny devuelve max 100 por página).
 */
app.get('/api/bunny/videos', requireAdmin, async (req, res) => {
    const apiKey = req.query.apiKey || await db.getConfig('bunny_api_key');
    const libraryId = req.query.libraryId || await db.getConfig('bunny_library_id');
    // cdnHostname puede venir como query param (prioridad) o desde DB
    const cdnHostnameParam = (req.query.cdnHostname || '').trim().replace(/\/$/, '');
    if (!apiKey || !libraryId) return res.status(400).json({ error: 'Bunny API key y library ID requeridos. Configúralos primero.' });

    try {
        const allVideos = [];
        let page = 1;
        const perPage = 100;
        let total = Infinity;

        while (allVideos.length < total) {
            const data = await bunnyApiRequest(`/library/${libraryId}/videos?page=${page}&itemsPerPage=${perPage}&orderBy=title`, { extraHeaders: { AccessKey: apiKey } });
            if (!data.items || !data.items.length) break;
            total = data.totalItems || data.items.length;
            allVideos.push(...data.items);
            if (allVideos.length >= total || data.items.length < perPage) break;
            page++;
        }

        // Detectar CDN hostname: prioridad: query param > DB > auto-detección
        let cdnHostname = cdnHostnameParam || await db.getConfig('bunny_cdn_hostname') || '';
        if (cdnHostnameParam) await db.setConfig('bunny_cdn_hostname', cdnHostnameParam); // persist
        if (!cdnHostname) {
            // Intento 1: extraer hostname del thumbnailUrl de cualquier video (más confiable)
            const sampleVideo = allVideos.find(v => v.thumbnailUrl && v.thumbnailUrl.includes('.b-cdn.net'));
            if (sampleVideo) {
                const match = sampleVideo.thumbnailUrl.match(/^(https:\/\/[^/]+)/);
                if (match) { cdnHostname = match[1]; await db.setConfig('bunny_cdn_hostname', cdnHostname); }
            }
        }
        if (!cdnHostname) {
            // Intento 2: buscar en catálogo existente alguna bunnyUrl para extraer hostname
            const catalog = await db.loadCatalog();
            const sample = catalog.find(v => v.bunnyUrl && v.bunnyUrl.includes('.b-cdn.net'));
            if (sample) {
                const match = sample.bunnyUrl.match(/^(https:\/\/[^/]+)/);
                if (match) { cdnHostname = match[1]; await db.setConfig('bunny_cdn_hostname', cdnHostname); }
            }
        }

        const videos = allVideos.map(v => ({
            guid: v.guid,
            title: v.title || v.guid,
            status: v.status, // 4=ready
            hlsUrl: cdnHostname ? `${cdnHostname}/${v.guid}/playlist.m3u8` : null,
            dateUploaded: v.dateUploaded,
        }));

        res.json({ videos, cdnHostname, total: videos.length });
    } catch (err) {
        res.status(502).json({ error: 'Error conectando Bunny API: ' + err.message });
    }
});

/** POST /api/bunny/save-account-key — Guarda la account key de Bunny permanentemente en DB */
app.post('/api/bunny/save-account-key', requireAdmin, async (req, res) => {
    const { accountKey } = req.body || {};
    if (!accountKey) return res.status(400).json({ error: 'accountKey requerida' });
    await db.setConfig('bunny_account_key', accountKey.trim());
    res.json({ ok: true });
});

/** GET /api/bunny/token-key — Estado del Token Authentication Key de Bunny */
app.get('/api/bunny/token-key', requireAdmin, async (req, res) => {
    try {
        const dbKey = await db.getConfig('bunny_token_key');
        if (dbKey) return res.json({ source: 'db' });
        if (BUNNY_TOKEN_KEY) return res.json({ source: 'env' });
        const hasAccountKey = !!(await getBunnyAccountKey());
        res.json({ source: 'none', autoDiscovery: hasAccountKey });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/bunny/token-key — Guarda el Token Authentication Key de Bunny en DB */
app.post('/api/bunny/token-key', requireAdmin, async (req, res) => {
    const { tokenKey } = req.body || {};
    const value = (tokenKey || '').trim();
    if (value) {
        await db.setConfig('bunny_token_key', value);
    } else {
        await db.setConfig('bunny_token_key', '');
    }
    res.json({ ok: true });
});

/** POST /api/bunny/sync-token-keys — Auto-descubre y guarda los Token Auth Keys de todas las bibliotecas */
app.post('/api/bunny/sync-token-keys', requireAdmin, async (req, res) => {
    try {
        const acct = await getBunnyAccountKey();
        if (!acct) return res.status(400).json({ error: 'Falta la Bunny Account API Key' });
        const data = await bunnyJson('GET', 'api.bunny.net', '/videolibrary?page=1&perPage=1000', acct, null);
        const items = data.Items || data.items || [];
        let synced = 0, errors = 0;
        const globalLibId = await db.getConfig('bunny_library_id');
        for (const lib of items) {
            const libId = String(lib.Id || lib.id);
            const pzId = lib.PullZoneId;
            if (!pzId) continue;
            try {
                const pz = await bunnyJson('GET', 'api.bunny.net', `/pullzone/${pzId}`, acct, null);
                const tokenKey = pz.ZoneSecurityKey || '';
                if (!tokenKey) continue;
                _tokenKeyCache.set(libId, tokenKey);
                if (libId === globalLibId) {
                    await db.setConfig('bunny_token_key', tokenKey);
                }
                const courseIds = await db.getCourseIdsByLibrary(libId);
                for (const cid of courseIds) {
                    await db.setCourseBunnyLibrary(cid, { libraryId: libId, tokenKey });
                    synced++;
                }
            } catch (e) { errors++; }
        }
        res.json({ ok: true, libraries: items.length, synced, errors });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/bunny/library-raw — Devuelve info completa de la libreria (para detectar CDN hostname) */
app.get('/api/bunny/library-raw', requireAdmin, async (req, res) => {
    const apiKey = await db.getConfig('bunny_api_key');
    const libraryId = await db.getConfig('bunny_library_id');
    if (!apiKey || !libraryId) return res.status(400).json({ error: 'Bunny API key y library ID no configurados' });
    try {
        const data = await bunnyApiRequest(`/library/${libraryId}`, { extraHeaders: { AccessKey: apiKey } });
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Error obteniendo library info: ' + err.message });
    }
});

/** GET /api/bunny/libraries — Lista todas las bibliotecas de video de la cuenta Bunny */
app.get('/api/bunny/libraries', requireAdmin, async (req, res) => {
    const accountKey = (req.query.accountKey || '').trim();
    if (!accountKey) return res.status(400).json({ error: 'accountKey requerida' });
    try {
        const data = await bunnyApiRequest('/videolibrary?page=1&perPage=1000&includeAccessKey=true', {
            hostname: 'api.bunny.net',
            extraHeaders: { AccessKey: accountKey },
        });
        const items = data.Items || data.items || [];
        const libraries = items.map(l => ({
            id: l.Id || l.id,
            name: l.Name || l.name,
            apiKey: l.ApiKey || l.apiKey || '',
            pullZoneUrl: l.PullZoneUrl ? l.PullZoneUrl.replace(/\/$/, '') : ''
        }));
        res.json({ libraries });
    } catch (err) {
        res.status(502).json({ error: 'Error listando bibliotecas Bunny: ' + err.message });
    }
});

/**
 * POST /api/bunny/import — Crea un curso completo con estructura de módulos.
 * Body: { courseName, author, apiKey, libraryId, cdnHostname, structure }
 * structure: [{ name, type:'module'|'video', children:[], fileName, matchedGuid, matchedTitle, hlsUrl }]
 */
app.post('/api/bunny/import', requireAdmin, async (req, res) => {
    const { courseName, author, apiKey: reqApiKey, libraryId: reqLibId, cdnHostname: reqCdn, structure } = req.body || {};
    if (!courseName) return res.status(400).json({ error: 'courseName requerido' });
    if (!Array.isArray(structure)) return res.status(400).json({ error: 'structure requerida (array)' });

    const apiKey = reqApiKey || await db.getConfig('bunny_api_key');
    const libraryId = reqLibId || await db.getConfig('bunny_library_id');
    let cdnHostname = reqCdn || await db.getConfig('bunny_cdn_hostname') || '';
    if (cdnHostname && !/^https?:\/\//i.test(cdnHostname)) cdnHostname = 'https://' + cdnHostname;

    if (!apiKey || !libraryId) return res.status(400).json({ error: 'Bunny API key y library ID requeridos' });

    try {
        // Crear el curso
        const courseId = uuidv4();
        await db.createCourse({ id: courseId, name: courseName.trim().slice(0, 120), author: (author || '').trim().slice(0, 100) });

        let videoSortOrder = 1;

        // Función recursiva para procesar la estructura
        async function processItems(items, parentModuleId) {
            for (const item of items) {
                if (item.type === 'module') {
                    const modId = uuidv4();
                    await db.createModule({ id: modId, courseId, parentId: parentModuleId || null, name: item.name, sortOrder: item.sortOrder || 0 });
                    if (Array.isArray(item.children)) {
                        await processItems(item.children, modId);
                    }
                } else if (item.type === 'video') {
                    // Construir hlsUrl: prioridad: lo que viene del frontend → construir con guid + cdn
                    let hlsUrl = item.hlsUrl || null;
                    if (!hlsUrl && item.matchedGuid && cdnHostname) {
                        hlsUrl = `${cdnHostname}/${item.matchedGuid}/playlist.m3u8`;
                    }
                    if (!hlsUrl) continue; // sin guid ni url: saltar
                    if (!isSafeBunnyUrl(hlsUrl)) continue;
                    const videoId = uuidv4();
                    const { keyId } = generateKey(videoId);
                    await db.addToCatalog({
                        videoId,
                        title: (item.matchedTitle || item.fileName || item.name || 'Video').slice(0, 120),
                        status: 'ready',
                        sourceType: 'bunny',
                        bunnyUrl: hlsUrl,
                        keyId,
                        courseId,
                        sortOrder: videoSortOrder++,
                        uploadedAt: new Date().toISOString(),
                    });
                    if (parentModuleId) await db.moveVideoToModule(videoId, parentModuleId);
                }
            }
        }

        await processItems(structure, null);
        syncCatalogSeed();

        const course = await db.getCourseById(courseId);
        const modules = await db.getModulesByCourse(courseId);
        const videos = await db.getCatalogByCourse(courseId);
        res.status(201).json({ ok: true, courseId, course, modules: modules.length, videos: videos.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Helper: llama a la API de Bunny (Stream o Account) */
function bunnyApiRequest(path, { hostname = 'video.bunnycdn.com', extraHeaders = {} } = {}) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname,
            path,
            method: 'GET',
            headers: { Accept: 'application/json', ...extraHeaders },
        };
        const req = https.request(opts, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch { reject(new Error('Respuesta inválida de Bunny API')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout Bunny API')); });
        req.end();
    });
}

// ================================================================
//  SISTEMA DE APROBACIÓN DE USUARIOS
// ================================================================

/**
 * POST /api/auth/register-request
 * Registro automático: crea la cuenta del alumno al instante (sin aprobación).
 * El acceso al contenido lo decide la licencia del curso.
 * Body: { email, name, deviceId, deviceModel, deviceName, firebaseUid?, 
 *         deviceSerial?, osVersion?, osVersionCode?, cpuCores?, totalRam?, androidId?, buildFingerprint?, brand?, manufacturer?, fcmToken? }
 */
app.post('/api/auth/register-request', async (req, res) => {
    try { res.json(await playerHandshake.register(req.body)); }
    catch (error) {
        if (error.registrationStatus) return res.status(error.status || 403).json({ error: error.message, code: error.code, status: error.registrationStatus });
        sendAccessError(res, error);
    }
});

/**
 * POST /api/auth/firebase-login
 * Verifica un ID token de Firebase, retorna JWT de sesión si el alumno está aprobado.
 * Body: { idToken, deviceId, deviceModel?, deviceName? }
 */
const accountAuth = createAccountAuth({
    db, adminEmail: process.env.ADMIN_USER, findLocalUser: findUser, isReady: () => dbReady,
    signSession: claims => jwt.sign(claims, JWT_SECRET, { expiresIn: '30d', issuer: 'reproductor-cursos' }),
    verifyFirebaseToken: async token => {
        if (!firebaseAdmin) throw Object.assign(new Error('Firebase no disponible'), { status: 503 });
        return firebaseAdmin.auth().verifyIdToken(token, firebasePrivileged);
    },
    lookupFirebaseUser: async email => {
        if (!firebaseAdmin || !firebasePrivileged) throw Object.assign(new Error('Directory lookup unavailable'), { code: 'ACCOUNT_LOOKUP_UNAVAILABLE' });
        return firebaseAdmin.auth().getUserByEmail(email);
    },
});
function sendAccountError(res, error) {
    const status = error.status || error.statusCode || 503;
    return res.status(status).json({ status: 'error', code: error.code || 'ACCOUNT_SERVICE_UNAVAILABLE',
        error: error.status || error.statusCode ? error.message : 'No se pudo comprobar tu cuenta. Intenta de nuevo.', registrationAllowed: false });
}
app.post('/api/auth/account-status', authRateLimit, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await accountAuth.accountStatus(req.body)); }
    catch (error) { sendAccountError(res, error); }
});
// ── Desafío para la atestación por hardware (Android Key Attestation) ──
// El reproductor pide un desafío, genera una clave en el Keystore con ese desafío y envía la cadena
// de certificados en /api/auth/firebase-login. Se consume una sola vez y caduca a los 10 minutos.
const { verifyKeyAttestation } = require('./lib/key-attestation');
const _attestationChallenges = new Map();
function issueAttestationChallenge() {
    const now = Date.now();
    for (const [k, exp] of _attestationChallenges) if (exp < now) _attestationChallenges.delete(k);
    if (_attestationChallenges.size > 5000) _attestationChallenges.clear();
    const challenge = crypto.randomBytes(24).toString('base64url');
    _attestationChallenges.set(challenge, now + 10 * 60 * 1000);
    return challenge;
}
function consumeAttestationChallenge(challenge) {
    const exp = _attestationChallenges.get(challenge);
    _attestationChallenges.delete(challenge);
    return !!exp && exp >= Date.now();
}
app.get('/api/auth/attestation-challenge', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ challenge: issueAttestationChallenge(), expiresIn: 600 });
});
// Token OAuth para Play Integrity: cuenta de servicio (JSON) con el API habilitado en el proyecto de Google Cloud.
async function playIntegrityAccessToken() {
    if (process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT) {
        const { GoogleAuth } = require('google-auth-library');
        const auth = new GoogleAuth({ keyFile: process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT, scopes: ['https://www.googleapis.com/auth/playintegrity'] });
        return (await auth.getAccessToken()) || '';
    }
    return process.env.PLAY_INTEGRITY_KEY || '';
}

app.post('/api/auth/firebase-login', authRateLimit, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
    if (!firebaseAdmin) return res.status(503).json({ error: 'Firebase Admin no inicializado' });
    const { idToken, deviceId, deviceModel, deviceName, platform, osRelease, appVersion,
            deviceSerial, osVersion, osVersionCode, cpuCores, totalRam, androidId, buildFingerprint,
            brand, manufacturer, fcmToken, integrityToken, keyAttestation } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'idToken requerido' });

    let decoded;
    try {
        decoded = await firebaseAdmin.auth().verifyIdToken(idToken, firebasePrivileged);
    } catch (e) {
        return res.status(401).json({ error: 'Token Firebase inválido o expirado' });
    }

    const { uid, email } = decoded;
    const clientIp = req.ip || req.connection?.remoteAddress || '';
    console.log(`[firebase-login] uid=${uid} email=${email} device=${deviceId || 'n/a'} ip=${clientIp}`);

    // ── Atestación por hardware (Android Key Attestation, verificada contra las raíces de Google) ──
    // Solo registro y auditoría: nunca bloquea el inicio de sesión (decisión del propietario).
    let attestationSummary = null;
    if (keyAttestation && typeof keyAttestation === 'object') {
        try {
            const challenge = typeof keyAttestation.challenge === 'string' ? keyAttestation.challenge : '';
            const issued = consumeAttestationChallenge(challenge);
            const verdict = verifyKeyAttestation({ chain: keyAttestation.chain, expectedChallenge: issued ? challenge : '' });
            if (!issued && verdict.reason === 'challenge_mismatch') verdict.reason = 'challenge_unknown_or_expired';
            attestationSummary = { ...verdict, checkedAt: new Date().toISOString(), kind: 'android_key_attestation', challenge, chain: Array.isArray(keyAttestation.chain) ? keyAttestation.chain.slice(0, 6).map(c => String(c).slice(0, 4000)) : [] };
            console.log(`[firebase-login] [INTEGRITY] keyAttestation ok=${verdict.ok} root=${verdict.rootTrusted} level=${verdict.securityLevel} boot=${verdict.verifiedBootState} locked=${verdict.deviceLocked} reason=${verdict.reason || '-'} device=${deviceId || 'n/a'}`);
            if (!verdict.ok && deviceId) {
                db.pool.query(`INSERT INTO audit_log (fingerprint, user_id, video_id, device_id, ip, user_agent, delivered_at, event_type)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,'security_warning')`,
                ['', uid || '', 'attestation_failed', String(deviceId).slice(0, 100), clientIp, JSON.stringify({ reason: verdict.reason, level: verdict.securityLevel, boot: verdict.verifiedBootState, locked: verdict.deviceLocked }).slice(0, 500), new Date().toISOString()]).catch(() => {});
            }
        } catch (e) {
            console.warn(`[firebase-login] [INTEGRITY] keyAttestation error: ${e.message}`);
        }
    }

    // ── Play Integrity (Android): se descifra en Google si hay credenciales (cuenta de servicio o token) ──
    if (integrityToken && (process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT || process.env.PLAY_INTEGRITY_KEY)) {
        try {
            const pkg = process.env.PLAY_INTEGRITY_PACKAGE || 'edulock.systemsoficial.com';
            const bearer = await playIntegrityAccessToken();
            const piRes = await fetch(`https://playintegrity.googleapis.com/v1/${pkg}:decodeIntegrityToken`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
                body: JSON.stringify({ integrity_token: integrityToken }),
            }).then(r => r.json());
            const verdict = piRes?.tokenPayloadExternal?.deviceIntegrity?.deviceRecognitionVerdict || [];
            const meetsDi = verdict.includes('MEETS_DEVICE_INTEGRITY');
            console.log(`[firebase-login] [INTEGRITY] Play Integrity verdict=${JSON.stringify(verdict)} meetsDI=${meetsDi} device=${deviceId || 'n/a'}` + (piRes?.error ? ' error=' + JSON.stringify(piRes.error).slice(0, 160) : ''));
            if (attestationSummary) attestationSummary.playIntegrity = { verdict, meetsDeviceIntegrity: meetsDi };
        } catch (e) {
            console.warn(`[firebase-login] [INTEGRITY] Play Integrity check error: ${e.message}`);
        }
    } else if (integrityToken) {
        console.log(`[firebase-login] [INTEGRITY] integrityToken recibido; Play Integrity sin credenciales (la atestación por hardware ya cubre el dispositivo)`);
    }

    const geoInfo = await lookupIpInfo(clientIp).catch(() => null);
    const geoCity = geoInfo?.city || '';
    const osStr     = platform && osRelease ? `${platform} ${osRelease}` : (platform || deviceName || '');
    const browserStr = appVersion ? `Edulock Player ${appVersion}` : (deviceModel || '');

    // ── Admin check ──
    const envAdminUser = (process.env.ADMIN_USER || '').trim().toLowerCase();
    const knownAdminUser = email ? findUser(email.trim().toLowerCase()) : null;
    const isAdminEmail = email && (email.trim().toLowerCase() === envAdminUser);
    if (decoded.admin === true || isAdminEmail || (knownAdminUser && knownAdminUser.admin === true)) {
        if (deviceId) {
            await db.registerOrValidateDevice(
                `admin_${uid}`, deviceId,
                { deviceName: deviceName || '', browser: browserStr, os: osStr, city: geoCity },
                2
            ).catch(() => {});
        }
        if (email) {
            db.findStudentByEmail(email).then(s => {
                if (s && !s.firebase_uid) db.linkFirebaseUid(s.id, uid).catch(() => {});
            }).catch(() => {});
        }
        const adminToken = jwt.sign(
            { sub: uid, email, admin: true, deviceId: deviceId || 'unknown', approved: true },
            JWT_SECRET,
            { expiresIn: '30d', issuer: 'reproductor-cursos' }
        );
        return res.json({ status: 'approved', role: 'admin', token: adminToken, email, name: 'Administrador' });
    }

    // ── Alumno normal ──
    let student = await db.getStudentByFirebaseUid(uid).catch(() => null);
    if (!student && email) {
        student = await db.findStudentByEmail(email).catch(() => null);
        if (student) await db.linkFirebaseUid(student.id, uid).catch(() => {});
    }

    if (!student) {
        // Registro automático: la cuenta se crea aprobada al instante, sin solicitud ni
        // aprobación del administrador. El acceso al contenido lo decide la licencia.
        const enrolled = await db.enrollFirebaseStudent({ uid, email, name: decoded.name || '' });
        student = enrolled.student;
        if (enrolled.created) console.log(`[firebase-login] Auto-registered student: ${email} (${student.id})`);
    }

    const approvalStatus = student.approval_status || 'approved';
    if (approvalStatus === 'suspended') return res.json({ status: 'suspended', email });
    if (approvalStatus === 'rejected')  return res.json({ status: 'rejected', email });

    // ── Bloqueo y registro de dispositivo ──
    if (deviceId) {
        // Identidad ≠ autorización: iniciar sesión registra el equipo y respeta bloqueos explícitos,
        // pero el cupo de dispositivos se aplica por licencia al activarla (no un tope global por alumno).
        const devResult = await db.registerOrValidateDevice(
            student.id, deviceId,
            { deviceName: deviceName || '', browser: browserStr, os: osStr, city: geoCity },
            1, { enforceLimit: false }
        ).catch(() => ({ ok: true }));
        if (attestationSummary && devResult.ok !== false) db.setDeviceAttestation(student.id, deviceId, attestationSummary).catch(() => {});
        if (devResult.ok === false) {
            return res.status(403).json({
                status: 'wrong_device',
                error: devResult.reason === 'device_blocked'
                    ? 'Este dispositivo ha sido bloqueado por el administrador.'
                    : `Límite de dispositivos alcanzado. Esta cuenta ya está activa en ${devResult.limit || 1} dispositivo(s). Contacta al administrador para resetear tus dispositivos.`,
            });
        }
    }

    // Actualizar telemetría del dispositivo
    if (deviceId) {
        await db.pool.query(`
            UPDATE students SET device_model=$1, device_name=$2, device_serial=$3, os_version=$4,
                os_version_code=$5, cpu_cores=$6, total_ram=$7, android_id=$8, build_fingerprint=$9,
                brand=$10, manufacturer=$11, fcm_token=$12, last_login=NOW()::text
            WHERE id=$13
        `, [deviceModel || '', deviceName || '', deviceSerial || '', osVersion || '', osVersionCode || '',
            cpuCores || '', totalRam || '', androidId || '', buildFingerprint || '',
            brand || '', manufacturer || '', fcmToken || '', student.id]).catch(() => {});
    }

    // Stage 1 JWT: login sin acceso a contenido (one-license-per-session)
    const token = jwt.sign(
        { sub: student.id, email: student.email, studentEmail: student.email, deviceId: deviceId || 'unknown', approved: true, role: 'student', hasLicense: false },
        JWT_SECRET,
        { expiresIn: STUDENT_JWT_EXPIRES, issuer: 'reproductor-cursos' }
    );

    res.json({ status: 'approved', role: 'student', token, expiresIn: STUDENT_JWT_EXPIRES, requiresLicense: true });
});

/**
 * PUT /api/admin/students/:id/suspend
 * Suspende o restaura un alumno.
 * Body: { suspend: true/false, notes? }
 */
app.put('/api/admin/students/:id/suspend', requireAdmin, async (req, res) => {
    if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
    const { id } = req.params;
    const { suspend = true } = req.body || {};
    await db.updateStudentApprovalStatus(id, suspend ? 'suspended' : 'approved');
    invalidateStudentStatus(id); // revocación instantánea (P0-2)
    res.json({ ok: true });
});

/**
 * GET /api/admin/students/:id/courses
 * Lista los cursos asignados a un alumno.
 */
app.get('/api/admin/students/:id/courses', requireAdmin, async (req, res) => {
    if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
    const courses = await db.getStudentCourses(req.params.id);
    res.json({ courses });
});

/**
 * PUT /api/admin/students/:id/courses
 * Reemplaza todos los cursos del alumno.
 * Body: { courseIds: ['abc','def'] }
 */
app.put('/api/admin/students/:id/courses', requireAdmin, async (req, res) => {
    if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
    const { courseIds = [] } = req.body || {};
    await db.setStudentCourses(req.params.id, courseIds, 'admin');
    res.json({ ok: true });
});

/**
 * POST /api/admin/students/:id/courses
 * Agrega un curso a un alumno.
 * Body: { courseId }
 */
app.post('/api/admin/students/:id/courses', requireAdmin, async (req, res) => {
    if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
    const { courseId } = req.body || {};
    if (!courseId) return res.status(400).json({ error: 'courseId requerido' });
    await db.addStudentCourse(req.params.id, courseId, 'admin');
    res.json({ ok: true });
});

/**
 * DELETE /api/admin/students/:id/courses/:courseId
 * Quita un curso de un alumno.
 */
app.delete('/api/admin/students/:id/courses/:courseId', requireAdmin, async (req, res) => {
    if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
    await db.removeStudentCourse(req.params.id, req.params.courseId);
    res.json({ ok: true });
});

/**
 * Cambio de credenciales de admin.
 * En la VPS de Edulock las credenciales viven en el archivo .env (ADMIN_USER /
 * ADMIN_PASS), no en un panel externo. Este endpoint queda deshabilitado.
 */
app.post('/api/admin/update-credentials', requireAdmin, async (req, res) => {
    return res.status(501).json({
        error: 'En la VPS de Edulock, cambia ADMIN_USER / ADMIN_PASS editando el archivo .env y reiniciando el servicio (pm2 restart edulock).',
    });
});

// ================================================================
//  RUTAS: GESTIÓN DE ALUMNOS [ADMIN]
// ================================================================

/**
 * Garantiza que el alumno tenga cuenta en Firebase Auth y students.firebase_uid
 * vinculado. Sin cuenta Firebase, "olvidé mi contraseña" nunca envía correo
 * (caso Luis Ventura 01/08). Se crea con contraseña aleatoria: el alumno define
 * la suya con el flujo de recuperación o registrándose con el mismo email.
 * Fire-and-forget: nunca bloquea ni falla la petición del admin.
 */
function ensureFirebaseAccount(studentDbId, email, name) {
    if (!firebaseAdmin || !email) return;
    (async () => {
        try {
            let user = await firebaseAdmin.auth().getUserByEmail(email).catch(() => null);
            if (!user) {
                user = await firebaseAdmin.auth().createUser({
                    email,
                    password: crypto.randomBytes(18).toString('base64url'),
                    emailVerified: true,
                    displayName: name || undefined,
                });
                console.log(`[ensureFirebaseAccount] Cuenta Firebase creada para ${email} → ${user.uid}`);
            }
            await db.pool.query('UPDATE students SET firebase_uid=$1 WHERE id=$2', [user.uid, studentDbId]);
        } catch (e) {
            console.error(`[ensureFirebaseAccount] ${email}:`, e.message);
        }
    })();
}

/** GET /api/students  — Lista todos los alumnos */
app.get('/api/students', requireAdmin, async (req, res) => {
    res.json({ students: await db.getAllStudents() });
});

app.post('/api/students/import-json', requireAdmin, async (req, res) => {
    const { students: input } = req.body || {};
    if (!Array.isArray(input)) return res.status(400).json({ error: 'Se esperaba { students: [...] }' });

    const prepared = [];
    for (const s of input) {
        if (!s.email || !s.studentId) continue;
        const em = String(s.email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) continue;
        prepared.push({
            id: uuidv4(), email: em,
            studentId: String(s.studentId).trim(),
            name: s.name ? String(s.name).trim().slice(0, 100) : '',
            active: s.active !== false,
            allowedVideos: Array.isArray(s.allowedVideos) ? s.allowedVideos : ['*'],
            createdAt: new Date().toISOString(),
        });
    }
    const { added, skipped } = await db.importStudents(prepared);
    const total = (await db.getAllStudents()).length;
    // PREVENCIÓN: garantizar cuenta Firebase de cada alumno importado (asíncrono)
    for (const s of prepared) ensureFirebaseAccount(s.id, s.email, s.name);
    res.json({ added, skipped: skipped + (input.length - prepared.length), total });
});

/** POST /api/students/import-csv  — Importa CSV (email,studentId,nombre) */
const csvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (['.csv', '.txt'].includes(ext)) cb(null, true);
        else cb(new Error('Solo archivos CSV/TXT permitidos'), false);
    },
});

app.post('/api/students/import-csv', requireAdmin, csvUpload.single('csv'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Archivo CSV requerido' });

    const lines = req.file.buffer.toString('utf-8').split('\n').map(l => l.trim()).filter(Boolean);
    const startIdx = lines[0] && lines[0].toLowerCase().includes('email') ? 1 : 0;
    const prepared = [], errors = [];
    for (let i = startIdx; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim().replace(/^"|"$/g, ''));
        const [rawEmail, rawSid, rawName] = parts;
        if (!rawEmail || !rawSid) continue;
        const em = rawEmail.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { errors.push(`Fila ${i + 1}: email inválido`); continue; }
        prepared.push({ id: uuidv4(), email: em, studentId: rawSid, name: rawName || '', active: true, allowedVideos: ['*'], createdAt: new Date().toISOString() });
    }
    const { added, skipped } = await db.importStudents(prepared);
    const total = (await db.getAllStudents()).length;
    // PREVENCIÓN: garantizar cuenta Firebase de cada alumno importado (asíncrono)
    for (const s of prepared) ensureFirebaseAccount(s.id, s.email, s.name);
    res.json({ added, skipped, total, errors });
});

app.post('/api/students', requireAdmin, async (req, res) => {
    const { email, studentId, name, active, allowedVideos } = req.body || {};
    if (!email || !studentId) return res.status(400).json({ error: 'email y studentId requeridos' });
    const em = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: 'Email inválido' });
    if (await db.findStudentByEmail(em)) return res.status(409).json({ error: 'Ya existe un alumno con ese email' });
    const student = await db.createStudent({
        id: uuidv4(), email: em,
        studentId: String(studentId).trim(),
        name: name ? String(name).trim().slice(0, 100) : '',
        active: active !== false,
        allowedVideos: Array.isArray(allowedVideos) ? allowedVideos : ['*'],
        createdAt: new Date().toISOString(),
    });
    // PREVENCIÓN: garantizar cuenta Firebase para que "olvidé mi contraseña" siempre funcione
    ensureFirebaseAccount(student.id, em, student.name);
    res.status(201).json({ student });
});

app.put('/api/students/:id', requireAdmin, async (req, res) => {
    const { name, active, allowedVideos, studentId, resetDevice } = req.body || {};
    const updated = await db.updateStudent(req.params.id, { name, active, allowedVideos, studentId, resetDevice });
    if (!updated) return res.status(404).json({ error: 'Alumno no encontrado' });
    res.json({ student: updated });
});

app.delete('/api/students/:id', requireAdmin, async (req, res) => {
    const existing = await db.findStudentById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Alumno no encontrado' });

    // Borrado de RAIZ también en Firebase Auth: elimina la cuenta del alumno para
    // que, si quiere volver a registrarse, no aparezca ningún error de cuenta ya
    // existente. No bloquea el borrado en la BD si Firebase falla o no está.
    let firebaseDeleted = false;
    if (firebaseAdmin) {
        try {
            let uid = existing.firebase_uid || null;
            if (!uid && existing.email) {
                const fbUser = await firebaseAdmin.auth().getUserByEmail(existing.email).catch(() => null);
                uid = fbUser ? fbUser.uid : null;
            }
            if (uid) {
                await firebaseAdmin.auth().deleteUser(uid);
                firebaseDeleted = true;
            }
        } catch (e) {
            console.warn('[deleteStudent] Firebase deleteUser:', e.message);
        }
    }

    await db.deleteStudent(req.params.id);
    res.json({ ok: true, firebaseDeleted });
});

// ================================================================
//  RUTAS: PROXY DE MANIFEST Y SEGMENTOS
// ================================================================
//
//  PROBLEMA QUE RESUELVEN ESTAS RUTAS:
//
//  En B2 mode los segmentos .ts están en un bucket PRIVADO de Backblaze.
//  El manifest (.m3u8) contiene rutas RELATIVAS a esos segmentos.
//  Si el reproductor descargara el manifest directamente desde B2, las
//  peticiones de segmentos irían a B2 sin auth → 403.
//
//  En local mode el manifest estaba siendo servido como fichero ESTÁTICO
//  sin ninguna validación de JWT → descargable sin autenticación.
//
//  SOLUCIÓN: TODOS los manifests se sirven a través de este proxy.
//  El proxy:
//    1. Valida el JWT (Bearer header o ?token=)
//    2. Lee el manifest (desde disco local o descargando de B2)
//    3. Rewrites segment URLs → apuntan a /api/proxy/segment/:videoId/:seg
//    4. Devuelve el manifest reescrito al reproductor
//
//  Los segmentos .ts son CIFRADOS con AES-128 por FFmpeg → son datos
//  basura sin la clave. Servir segmentos sin auth es seguro.
//  La clave /api/drm/key/:keyId → siempre requiere JWT.
//
//  RESULTADO FINAL:
//    - Alguien con curl/wget/extensión de descarga sólo obtiene
//      segmentos .ts cifrados inutilizables.
//    - El manifest sólo se entrega con JWT válido y de corta duración.
//    - La clave AES-128 sólo se entrega con JWT válido que además debe
//      contener el videoId correcto.
//    - Sin clave → sin video. Sin JWT → sin clave.

/**
 * GET /api/proxy/manifest/:videoId
 * Sirve el .m3u8 con JWT validado y URLs de segmentos reescritas.
 *
 * MODO LOCAL : segmentos apuntan a /api/proxy/segment/:videoId/:seg (pasan por el servidor)
 * MODO B2    : segmentos apuntan a URLs pre-firmadas de B2 directamente.
 *              El servidor NO toca el contenido del segmento → escala ilimitado.
 *              Los segmentos son AES-128 cifrados → inútiles sin la clave.
 *              La clave sigue requiriendo JWT válido → protección intacta.
 */
app.get('/api/r/:videoId', async (req, res) => {
    const { videoId } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(videoId)) return res.status(400).send('videoId inválido');

    // Autenticación obligatoria — sin bypass 'guest' (P0: cierre del hueco de autorización).
    const token = (req.headers['authorization'] || '').replace('Bearer ', '') || req.query.token;
    let manifestPayload;
    try { manifestPayload = (await authorizeMedia(req,videoId,token)).user; } catch(e) { return sendAccessError(res,e); }

    const base = getPublicBase(req);
    const catalogEntry = await db.getCatalogById(videoId);

    // Autorización real contra el video (incluye acceso por curso).
    if (!hasVideoAccess(manifestPayload, videoId, catalogEntry && catalogEntry.courseId)) {
        return res.status(403).send('Sin acceso a este video');
    }

    // ====== MODO BUNNY.NET ================================================
    // La URL del manifest viene de la BD. Se proxea reescribiendo
    // todas las rutas relativas → nuestro propio servidor (con auth JWT).
    // El alumno nunca ve la URL real de Bunny.
    // ======================================================================
    if(catalogEntry && catalogEntry.sourceType==='bunny'){
        try {
            const rawUrl=req.query.sub?Buffer.from(String(req.query.sub),'base64url').toString('utf8'):catalogEntry.bunnyUrl;
            if(!belongsToVideo(rawUrl,catalogEntry.bunnyUrl))return res.status(403).send('Recurso no autorizado');
            if(req.query.sub&&!verifyResourceSignature(JWT_SECRET,req.query.sig,'manifest',videoId,rawUrl))return res.status(403).send('Lista no autorizada');
            const targetUrl=await signCourseBunnyUrl(rawUrl,catalogEntry);
            const content=await fetchBunnyText(targetUrl,{catalogUrl:catalogEntry.bunnyUrl});
            let effectiveKeyId = catalogEntry.keyId;
            if (!effectiveKeyId) {
                const newKey = generateKey(videoId);
                effectiveKeyId = newKey.keyId;
                await db.updateCatalogEntry({ videoId, keyId: effectiveKeyId });
                console.log(`[stream/manifest] Clave generada automáticamente para video ${videoId}: ${effectiveKeyId}`);
            }
            const ktok=generateKeyToken(effectiveKeyId,manifestPayload);
            const keyUri=base+'/api/drm/key/'+effectiveKeyId+'?ktok='+encodeURIComponent(ktok);
            const rewritten=rewriteBunnyManifest({content,targetUrl:rawUrl,catalogUrl:catalogEntry.bunnyUrl,videoId,token,baseUrl:base,keyUri,secret:JWT_SECRET});
            return sendManifest(res,rewritten,req);
        }catch(e){console.warn('[stream/manifest]',e.message);return res.status(502).send('Lista de reproducción no disponible');}
    }


    // ====== FIN MODO BUNNY ================================================

    if (LOCAL_MODE) {
        const quality    = req.query.q || null;
        const hlsBase    = path.join(__dirname, 'public', 'hls', 'hls', videoId);
        const masterPath = path.join(hlsBase, 'master.m3u8');
        const singlePath = path.join(hlsBase, 'playlist.m3u8');

        // Solicitud de rendición específica (multi-bitrate ABR)
        if (quality) {
            if (!/^(360p|720p|1080p)$/.test(quality)) return res.status(400).send('Calidad inválida');
            const renditionPath = path.join(hlsBase, `${quality}.m3u8`);
            if (!fs.existsSync(renditionPath)) return res.status(404).send('Calidad no disponible');
            let content = fs.readFileSync(renditionPath, 'utf-8');
            content = content.replace(/^(seg\w+\.ts)$/gm, `${base}/api/b/${videoId}/$1?token=${encodeURIComponent(token)}`);
            return sendManifest(res, content, req);
        }

        // Master manifest (videos multi-bitrate procesados con el nuevo pipeline)
        if (fs.existsSync(masterPath)) {
            let content = fs.readFileSync(masterPath, 'utf-8');
            content = content.replace(/^(360p|720p|1080p)\.m3u8$/gm,
                (_, q) => `${base}/api/r/${videoId}?q=${q}&token=${encodeURIComponent(token)}`);
            return sendManifest(res, content, req);
        }

        // Playlist única (backward compat: videos procesados con el pipeline anterior)
        if (!fs.existsSync(singlePath)) return res.status(404).send('Video no encontrado');
        let content = fs.readFileSync(singlePath, 'utf-8');
        content = content.replace(/^(seg\w+\.ts)$/gm, `${base}/api/b/${videoId}/$1?token=${encodeURIComponent(token)}`);
        return sendManifest(res, content, req);
    }

    // ==== MODO B2: segmentos se sirven DIRECTAMENTE desde B2 =================
    // Descarga el manifest de B2, reescribe URLs y devuelve manifest al cliente.
    // Para renditions → URLs pre-firmadas de segmentos (TTL 6h).
    // Para master     → URLs del proxy de manifest para cada rendition.
    // =========================================================================
    try {
        const { downloadBuffer, getPresignedUrl } = require('./storage');
        const quality = req.query.q || null;

        // Descargar el manifest correcto
        let buf;
        if (quality) {
            if (!/^(360p|720p|1080p)$/.test(quality)) return res.status(400).send('Calidad inválida');
            buf = await downloadBuffer(`hls/${videoId}/${quality}.m3u8`);
        } else {
            try { buf = await downloadBuffer(`hls/${videoId}/master.m3u8`); }
            catch { buf = await downloadBuffer(`hls/${videoId}/playlist.m3u8`); }
        }
        const content = buf.toString('utf-8');

        // Master manifest: reescribir referencias a renditions con URLs del proxy
        if (content.includes('#EXT-X-STREAM-INF')) {
            const rewritten = content.replace(/^(360p|720p|1080p)\.m3u8$/gm,
                (_, q) => `${base}/api/r/${videoId}?q=${q}&token=${encodeURIComponent(token)}`);
            return sendManifest(res, rewritten, req);
        }

        // Rendition / playlist única: generar pre-signed URLs por segmento (TTL 6h)
        const SEG_TTL = 6 * 3600;
        const lines   = content.split('\n');
        const segs    = lines.map(l => l.trim()).filter(l => /^seg\w+\.ts$/.test(l));
        const urlMap  = {};
        await Promise.all(segs.map(async (seg) => {
            urlMap[seg] = await getPresignedUrl(`hls/${videoId}/${seg}`, SEG_TTL);
        }));
        const rewritten = lines.map(l => { const t = l.trim(); return urlMap[t] ? urlMap[t] : l; }).join('\n');
        return sendManifest(res, rewritten, req);
    } catch (err) {
        console.error('[proxy/manifest B2]', err.message);
        return res.status(502).send('Error al obtener manifest de B2');
    }
});

/**
 * GET /api/proxy/segment/:videoId  — Bunny.net segments (vía ?seg=BASE64URL)
 * Requiere JWT. El parámetro ?seg= lleva la URL real de Bunny codificada.
 * El alumno nunca ve la URL real de Bunny — solo ve nuestro proxy.
 */
app.get('/api/b/:videoId', async (req, res) => {
    if (!req.query.seg) return res.status(400).send('Parámetro seg requerido');

    const { videoId } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(videoId)) return res.status(400).send('videoId inválido');

    const token = (req.headers['authorization'] || '').replace('Bearer ', '') || req.query.token;
    let _segPayload;
    let segmentContext;
    try { segmentContext=await authorizeMedia(req,videoId,token);_segPayload=segmentContext.user; } catch(e){return sendAccessError(res,e);}

    // Auditoría granular por segmento (fire-and-forget — nunca bloquea el streaming)
    try {
        const _p = db.logSegmentRequest({
            studentId: _segPayload.sub || _segPayload.studentId || null,
            videoId,
            sessionId: _segPayload.sessionId || null,
            deviceId:  _segPayload.deviceId || null,
            segIndex:  parseInt(req.query.idx || '0', 10),
            ip:        req.ip,
            userAgent: req.headers['user-agent'] || '',
        });
        if (_p && typeof _p.catch === 'function') _p.catch(() => {});
    } catch { /* no bloquear reproducción */ }


    let segUrl;
    try { segUrl = Buffer.from(req.query.seg, 'base64url').toString('utf-8'); } catch {
        return res.status(400).send('Parámetro seg inválido');
    }
    if(!belongsToVideo(segUrl,segmentContext.video.bunnyUrl)||!verifyResourceSignature(JWT_SECRET,req.query.sig,'segment',videoId,segUrl,String(req.query.enc),String(req.query.idx)))return res.status(403).send('Segmento no autorizado');
    segUrl = await signCourseBunnyUrl(segUrl,segmentContext.video);

    // enc=0 → Bunny ya cifra sus segmentos, pasar sin re-cifrar
    if (req.query.enc === '0') {
        const mod = segUrl.startsWith('https') ? https : http;
        const parsedUrl = new URL(segUrl);
        const upReq = mod.get(segUrl, { timeout: 30000, headers: { Referer: `${parsedUrl.protocol}//${parsedUrl.host}/` } }, (upstream) => {
            if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
                upReq.destroy();
                const loc = upstream.headers.location;
                if (!isSafeBunnyUrl(loc)) { res.status(400).send('Redirect no permitido'); return; }
                const mod2 = loc.startsWith('https') ? https : http;
                mod2.get(loc, { timeout: 30000 }, (up2) => {
                    if (up2.statusCode !== 200) { res.status(502).send('Error Bunny'); return; }
                    up2.pipe(res);
                }).on('error', () => { if (!res.headersSent) res.status(502).send(''); });
                return;
            }
            if (upstream.statusCode !== 200) { res.status(502).send(`Bunny HTTP ${upstream.statusCode}`); return; }
            upstream.pipe(res);
            upstream.on('error', () => { if (!res.headersSent) res.status(502).send(''); else res.end(); });
        });
        upReq.on('error', () => { if (!res.headersSent) res.status(502).send('Error conectando Bunny'); });
        upReq.on('timeout', () => { upReq.destroy(); if (!res.headersSent) res.status(504).send('Timeout'); });
        res.on('close', () => upReq.destroy());
        return;
    }

    const segIdx = String(req.query.idx || '0');
    try { segmentIV(segIdx); } catch { return res.status(400).send('Índice de segmento inválido'); }

    const catalogEntry = await db.getCatalogById(videoId);
    if (!catalogEntry || !catalogEntry.keyId) return res.status(500).send('Clave no encontrada');
    const keyHex = getKeyHex(catalogEntry.keyId);
    if (!keyHex) return res.status(500).send('Clave inválida');

    // Headers: application/octet-stream → extensiones de descarga no lo reconocen como video
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');

    // Cifrado AES-128-CBC en streaming: no espera descarga completa del segmento
    const mod = segUrl.startsWith('https') ? https : http;
    const parsedUrl = new URL(segUrl);
    const reqOpts = {
        timeout: 30000,
        headers: { Referer: `${parsedUrl.protocol}//${parsedUrl.host}/` }
    };

    const upstreamReq = mod.get(segUrl, reqOpts, (upstream) => {
        if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
            // Redireccion: reintentar una sola vez
            upstreamReq.destroy();
            res.removeHeader('Content-Type');
            req.url = req.url; // keep url
            // Recurse manually
            const loc = upstream.headers.location;
            if (!isSafeBunnyUrl(loc)) { res.status(400).send('Redirect no permitido'); return; }
            const mod2 = loc.startsWith('https') ? https : http;
            const cipher2 = createAES128CipherStream(keyHex, segIdx);
            mod2.get(loc, reqOpts, (up2) => {
                if (up2.statusCode !== 200) { res.status(502).send('Error Bunny'); return; }
                up2.pipe(cipher2).pipe(res);
                up2.on('error', () => { if (!res.headersSent) res.status(502).send(''); });
            }).on('error', () => { if (!res.headersSent) res.status(502).send(''); });
            return;
        }
        if (upstream.statusCode !== 200) {
            if (!res.headersSent) res.status(502).send(`Bunny HTTP ${upstream.statusCode}`);
            return;
        }
        // Crear cipher stream y hacer pipe directo: Bunny → cifrador → cliente
        // El cliente empieza a recibir bytes cifrados inmediatamente
        const cipher = createAES128CipherStream(keyHex, segIdx);
        upstream.pipe(cipher).pipe(res);
        upstream.on('error', (e) => {
            console.error('[bunny stream upstream]', e.message);
            if (!res.headersSent) res.status(502).send('');
            else res.end();
        });
        cipher.on('error', (e) => {
            console.error('[bunny cipher]', e.message);
            if (!res.headersSent) res.status(502).send('');
            else res.end();
        });
    });
    upstreamReq.on('error', (e) => {
        console.error('[bunny req]', e.message);
        if (!res.headersSent) res.status(502).send('Error conectando Bunny');
    });
    upstreamReq.on('timeout', () => {
        upstreamReq.destroy();
        if (!res.headersSent) res.status(504).send('Timeout Bunny');
    });
    // Si el cliente cierra la conexión, cancelar la petición a Bunny
    res.on('close', () => upstreamReq.destroy());
});

/**
 * GET /api/proxy/segment/:videoId/:segname
 * Sirve el segmento .ts cifrado (sin auth — los datos son inutilizables
 * sin la clave AES-128, la cual siempre requiere JWT).
 * En local mode sirve desde disco; en B2 mode hace streaming desde B2.
 */
app.get('/api/b/:videoId/:segname', async (req, res) => {
    const { videoId, segname } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(videoId)) return res.status(400).send('videoId inválido');
    if (!/^seg\w{1,20}\.ts$/.test(segname)) return res.status(400).send('segname inválido');

    // Autenticación + autorización obligatoria (P0: este endpoint estaba SIN auth).
    const _tok = (req.headers['authorization'] || '').replace('Bearer ', '') || req.query.token;
    let _segPayload2;
    try{_segPayload2=(await authorizeMedia(req,videoId,_tok)).user;}catch(e){return sendAccessError(res,e);}

    // application/octet-stream: evita que extensiones de descarga lo reconozcan como video
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');

    if (LOCAL_MODE) {
        const segPath = path.join(__dirname, 'public', 'hls', 'hls', videoId, segname);
        if (!fs.existsSync(segPath)) return res.status(404).send('Segmento no encontrado');
        return res.sendFile(segPath);
    }

    // B2 mode: streaming desde B2
    const { downloadBuffer } = require('./storage');
    downloadBuffer(`hls/${videoId}/${segname}`)
        .then(buf => res.send(buf))
        .catch(err => {
            console.error('[proxy/segment]', err.message);
            res.status(502).send('Error al obtener segmento de B2');
        });
});

// ================================================================
//  RUTAS: SESIONES ACTIVAS
// ================================================================

/**
 * POST /api/session/heartbeat
 * El reproductor envía un ping cada 30s para mantener viva la sesión.
 * Si el JWT expiró o la sesión no existe → { revoked: true } → cliente pausa el video.
 */
app.post('/api/session/heartbeat', async (req, res) => {
    if (!dbReady) return res.status(503).json({ error: 'Servidor iniciando. Reintenta.', code: 'DB_UNAVAILABLE' });
    try { res.json(await playerSessions.heartbeat(req)); }
    catch (error) { sendAccessError(res, error); }
});

/**
 * POST /api/session/end
 * El reproductor avisa al servidor que terminó la reproducción.
 * Libera el slot de sesión para que el alumno pueda abrir otra pestaña.
 */
app.post('/api/session/end', async (req, res) => {
    if (!dbReady) return res.status(503).json({ error: 'Servidor iniciando. Reintenta.', code: 'DB_UNAVAILABLE' });
    try { res.json(await playerSessions.end(req)); }
    catch (error) { sendAccessError(res, error); }
});

// ================================================================
//  RUTAS: AUDITORÍA Y MARCA DE AGUA [ADMIN]
// ================================================================

/**
 * POST /api/audit/seed-devices  [ADMIN]
 * Restaura asociaciones correo+deviceId en audit_log tras cada deploy.
 * Body: { records: [{ studentEmail, deviceId }] }
 */
app.post('/api/audit/seed-devices', requireAdmin, async (req, res) => {
    const { records } = req.body || {};
    if (!Array.isArray(records) || records.length === 0)
        return res.status(400).json({ error: 'records array requerido' });

    let inserted = 0, skipped = 0;
    for (const r of records) {
        const email    = (r.studentEmail || '').trim().slice(0, 254);
        const deviceId = (r.deviceId     || '').trim().slice(0, 128);
        if (!email || !deviceId) { skipped++; continue; }
        try {
            await db.logDelivery({
                fingerprint:  `seed_${deviceId}`,
                userId:       email,
                videoId:      'seed',
                deviceId,
                studentEmail: email,
                ip:           'restored',
                userAgent:    'seed-restore',
            });
            inserted++;
        } catch { skipped++; }
    }
    res.json({ ok: true, inserted, skipped });
});

/**
 * POST /api/watermark/log
 * El reproductor cliente (APK o web) registra que comenzó la reproducción.
 * Guarda forensic watermarking con 13 campos de dispositivo.
 */
app.post('/api/watermark/log', async (req, res) => {
    const { mediaToken, videoId, deviceId, timestamp, deviceModel, buildFingerprint, osVersion, cpuCores,
            androidId, deviceSerial, brand, manufacturer, watchedPercentage } = req.body || {};
    
    if (!mediaToken) return res.status(400).json({ error: 'mediaToken requerido' });
    
    let decoded;
    try {
        decoded = jwt.verify(mediaToken, JWT_SECRET);
    } catch {
        return res.status(401).json({ error: 'Token inválido' });
    }
    
    const userId = decoded.sub || decoded.uid || 'unknown';
    const clientIp = req.ip || req.connection?.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';
    
    try {
        // Guardar watermark log en base de datos
        await db.pool.query(
            `INSERT INTO watermark_logs 
             (user_id, video_id, media_token, device_id, device_model, build_fingerprint, os_version, cpu_cores,
              android_id, device_serial, brand, manufacturer, timestamp, watched_percentage, ip_address, user_agent, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW()::text)`,
            [userId, videoId || 'unknown', mediaToken, deviceId || 'unknown', deviceModel || '', buildFingerprint || '',
             osVersion || '', cpuCores || '', androidId || '', deviceSerial || '', brand || '', manufacturer || '',
             timestamp || new Date().toISOString(), watchedPercentage || 0, clientIp, userAgent]
        );
        
        console.log(`[watermark] Registrado: user=${userId} video=${videoId} device=${deviceId}`);
        res.json({ success: true, message: 'Watermark logged successfully' });
    } catch (error) {
        console.error('[watermark/log] Error:', error.message);
        res.status(500).json({ error: 'Error al registrar watermark' });
    }
});

/**
 * GET /api/watermark/detect?fp=<fingerprint>  [ADMIN]
 * Busca a quién pertenece un fingerprint extraído de un video filtrado.
 */
app.get('/api/watermark/detect', requireAdmin, async (req, res) => {
    const fp = (req.query.fp || '').trim().toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(fp)) return res.status(400).json({ error: 'Fingerprint inválido (16 hex chars)' });
    const match = await db.detectLeak(fp);
    if (!match) return res.status(404).json({ error: 'Fingerprint no encontrado' });
    res.json(match);
});

// SSE en vivo. El reproductor se suscribe con su curso (y opcionalmente ?v=videoId);
// el servidor deduce el productor y envía la configuración EFECTIVA.
app.get('/api/watermark/stream/:courseId', async (req, res) => {
    const courseId = decodeURIComponent(req.params.courseId || '__default__');
    const os = normalizeWatermarkOs(req.query.os);
    const videoId = /^[0-9a-f-]{36}$/i.test(String(req.query.v || '')) ? String(req.query.v) : null;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const { producerId } = await watermarkOwnerFor({ courseId, videoId });
    const client = { res, os, courseId, videoId, producerId, lastJson: '' };
    client.lastJson = JSON.stringify(resolveWatermarkConfig({ courseId, producerId }, os));
    res.write(`event: config\ndata: ${client.lastJson}\n\n`);

    const clients = watermarkStreamClients.get(courseId) || [];
    clients.push(client);
    watermarkStreamClients.set(courseId, clients);

    // Latido: evita que nginx/proxies corten la conexión por inactividad.
    const ping = setInterval(() => { try { if (!res.writableEnded) res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => {
        clearInterval(ping);
        const remaining = (watermarkStreamClients.get(courseId) || []).filter(c => c.res !== res);
        if (remaining.length) watermarkStreamClients.set(courseId, remaining);
        else watermarkStreamClients.delete(courseId);
    });
});

app.post('/api/watermark/config', requireAdmin, async (req, res) => {
    const scope = String((req.body || {}).courseId || '__default__').trim();
    const os = normalizeWatermarkOs((req.body || {}).os);
    const config = (req.body || {}).config;
    if (!isValidWatermarkScope(scope)) return res.status(400).json({ error: 'Ámbito inválido' });
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'Configuración inválida' });
    const existing = watermarkConfigStore.get(scope) || {};
    const next = { ...existing };
    // clear=true → el ámbito deja de tener config propia para ese sistema y vuelve a heredar.
    if ((req.body || {}).clear === true && scope !== '__default__') delete next[os];
    else next[os] = config;
    if (Object.keys(next).length) watermarkConfigStore.set(scope, next);
    else watermarkConfigStore.delete(scope);
    console.log('[watermark] config update', { scope, os });
    await persistWatermarkConfigStore();
    broadcastWatermarkConfig();
    res.json({ ok: true, courseId: scope, os, config: getWatermarkConfig(scope, os) });
});

// Configuración cruda de un ámbito (la que edita el panel). Con ?effective=1 y
// courseId/producerId devuelve la configuración efectiva que vería un alumno.
app.get('/api/watermark/config', (req, res) => {
    const scope = String(req.query.courseId || '__default__');
    const os = normalizeWatermarkOs(req.query.os);
    if (String(req.query.effective || '') === '1') {
        const courseId = scope.startsWith('producer:') ? null : scope;
        const producerId = scope.startsWith('producer:') ? scope.slice(9) : (String(req.query.producerId || '') || null);
        return res.json({ ok: true, courseId: scope, os, effective: true, config: resolveWatermarkConfig({ courseId, producerId }, os) });
    }
    res.json({ ok: true, courseId: scope, os, config: getWatermarkConfig(scope, os), hasOwn: !!(watermarkConfigStore.get(scope) || {})[os] });
});

/**
 * GET /api/audit/log  [ADMIN]
 * Devuelve el log de entregas filtrable por userId y videoId.
 */
app.get('/api/audit/log', requireAdmin, async (req, res) => {
    let userId    = req.query.userId  || undefined;
    const videoId = req.query.videoId || undefined;
    const limit   = Math.min(parseInt(req.query.limit || '500', 10), 2000);
    // Si el userId parece email, buscar el Firebase UID del alumno en students
    if (userId && userId.includes('@')) {
        try {
            const sts = await db.getStudents();
            const found = (sts || []).find(s => (s.email || '').toLowerCase() === userId.toLowerCase());
            if (found) userId = found.firebase_uid || found.id || userId;
        } catch { /* si falla, buscar directamente */ }
    }
    const adminEmail = req.user.email || (process.env.ADMIN_USER || '').trim();
    const adminUid   = req.user.sub;
    const { entries, total } = await db.getAuditLog({ userId, videoId, limit, deliveryOnly: true });
    // Sustituir UID del admin por su email en registros históricos que no tenían email guardado
    if (adminEmail) {
        for (const e of entries) {
            if ((e.userId === adminUid || e.userId === 'admin') && !e.studentEmail) {
                e.studentEmail = adminEmail;
            }
        }
    }
    res.json({ entries, total });
});

// ================================================================
//  ARCHIVOS ESTÁTICOS
// ================================================================

// Only explicitly public frontend files are served. Runtime data and source stay private.
for (const name of ['index.html', 'admin.html', 'productor.html', 'logo.png']) {
    app.get('/' + name, (_req,res) => res.sendFile(path.join(__dirname,name)));
}
for (const name of ['cover.html','download.html','launch.html','edu-player.html','logo.png']) {
    app.get('/public/' + name, (_req,res) => res.sendFile(path.join(__dirname,'public',name)));
}
app.use('/public/js', express.static(path.join(__dirname,'public/js'),{dotfiles:'deny'}));

// Librerías JS propias (HLS.js, etc.) — servidas desde /js/
app.use('/js', express.static(path.join(__dirname, 'public/js'), {
    dotfiles: 'deny',
    maxAge: '7d', // caché de 7 días en el navegador, es un fichero estático inmutable
}));

app.use('/css', express.static(path.join(__dirname, 'public/css'), { dotfiles: 'deny', maxAge: '1h' }));

// Rutas explícitas del frontend
app.get('/', async (req, res) => {
    // Si viene ?v= (videoId), servir el reproductor embebible
    if (req.query.v || req.query.videoId) {
        return res.sendFile(path.join(__dirname, 'index.html'));
    }
    res.redirect('/admin.html');
});
app.get('/admin', async (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/productor', async (req, res) => res.sendFile(path.join(__dirname, 'productor.html')));

// ── Portadas públicas y descarga ────────────────────────────────────────────
app.get('/cover/:publicCode', async (req, res) => {
    try {
        const presentation = await require('./lib/producer-content').getPublicVideoPresentation(db, req.params.publicCode);
        const origins = presentation?.embedOrigins || [];
        res.setHeader('Content-Security-Policy', `frame-ancestors ${["'self'", ...cachedAllowedDomains, ...origins].join(' ')}`);
        res.sendFile(path.join(__dirname, 'public', 'cover.html'));
    } catch (_) { res.status(503).send('No se pudo cargar la portada. Inténtalo de nuevo.'); }
});
app.get('/download', (req, res) => res.sendFile(path.join(__dirname, 'public', 'download.html')));
app.get('/edu-player', (req, res) => res.sendFile(path.join(__dirname, 'public', 'edu-player.html')));

/**
 * GET /launch?t=TOKEN[&dl=DOWNLOAD_URL]
 * Página intermedia que intenta abrir el reproductor vía edulock://.
 * Si el reproductor no está instalado, redirige a la URL de descarga.
 * Si el token es inválido o ya expiró, muestra error.
 */
app.get('/launch', async (req, res) => {
    const { t, dl } = req.query;
    if (!t || !/^[A-Za-z0-9_-]{10,40}$/.test(t)) {
        return res.sendFile(path.join(__dirname, 'public', 'launch.html'));
    }
    // Verificar que el token exista (sin consumirlo — solo peek)
    const row = db._db
        ? null // fallback si no hay acceso directo
        : null;
    // Servir la página de lanzamiento (el JS del cliente maneja el cdp://)
    // Inyectamos la DOWNLOAD_URL configurada si el admin la tiene en app_config
    const downloadUrl = dl
        || (db.getConfig ? (await db.getConfig('DOWNLOAD_URL') || '') : '')
        || '';
    // Servir el HTML con la URL de descarga como variable JS global
    let html = require('fs').readFileSync(path.join(__dirname, 'public', 'launch.html'), 'utf8');
    html = html.replace(
        "window.__DOWNLOAD_URL__ || '#'",
        JSON.stringify(downloadUrl || '#')
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
});

// ================================================================
//  PLAYBACK API — Capa de comunicación para reproductores externos
//  No modifica ningún endpoint existente.
// ================================================================

const PLAYBACK_SESSION_TTL = 1800; // 30 minutos exactos en segundos
const ALLOWED_EVENT_TYPES = new Set([
    'lesson_opened', 'play_started', 'play_paused', 'play_resumed',
    'heartbeat', 'lesson_completed', 'lesson_closed', 'playback_error',
]);

/**
 * POST /api/playback/session
 * Inicia una sesión de reproducción desde un reproductor externo.
 * Valida alumno, dispositivo y acceso al video antes de emitir el token.
 */
app.post('/api/playback/session', async (req, res) => {
    const { studentEmail, studentId, deviceId, courseId, lessonId } = req.body || {};

    if (!studentEmail || !studentId || !deviceId || !courseId || !lessonId) {
        return res.status(400).json({ error: 'Faltan campos requeridos: studentEmail, studentId, deviceId, courseId, lessonId' });
    }

    const emailNorm = String(studentEmail).trim().toLowerCase();
    const student = await db.findStudentByEmail(emailNorm);

    // Respuesta idéntica para no existente o ID incorrecto (evita enumeración)
    if (!student || student.studentId !== String(studentId).trim()) {
        return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    if (!student.active) {
        return res.status(403).json({ error: 'Acceso desactivado. Contacta al administrador.' });
    }

    // Validar dispositivo: si ya tiene uno vinculado debe coincidir
    const fp = String(deviceId).slice(0, 64);
    if (student.deviceId && student.deviceId !== fp) {
        return res.status(403).json({ error: 'Dispositivo no autorizado para este acceso.' });
    }

    // Validar acceso al video (lessonId)
    const allowed = student.allowedVideos;
    if (!allowed.includes('*') && !allowed.includes(lessonId)) {
        return res.status(403).json({ error: 'Sin acceso a este contenido.' });
    }

    // Vincular dispositivo si es primer acceso
    if (!student.deviceId) {
        await db.bindDevice(student.id, fp, new Date().toISOString());
    }

    const sessionId = uuidv4();
    const now = new Date().toISOString();

    // Guardar sesión en BD
    await db.createPlaybackSession({
        sessionId,
        studentId:    student.studentId,
        studentEmail: student.email,
        courseId:     String(courseId),
        lessonId:     String(lessonId),
        deviceId:     fp,
        ttlSeconds:   PLAYBACK_SESSION_TTL,
    });

    // Token de sesión de corta vida (15 min) para autenticar eventos
    const sessionToken = jwt.sign(
        {
            sub:          student.id,
            sessionId,
            studentId:    student.studentId,
            studentEmail: student.email,
            courseId:     String(courseId),
            lessonId:     String(lessonId),
            deviceId:     fp,
            scope:        'playback',
        },
        JWT_SECRET,
        { expiresIn: `${PLAYBACK_SESSION_TTL}s`, issuer: 'reproductor-cursos' }
    );

    res.json({
        sessionId,
        studentId:    student.studentId,
        studentEmail: student.email,
        courseId:     String(courseId),
        lessonId:     String(lessonId),
        deviceId:     fp,
        sessionToken,
        expiresIn:    PLAYBACK_SESSION_TTL,
        timestamp:    now,
    });
});

/**
 * POST /api/playback/event
 * Recibe eventos del reproductor externo.
 * Requiere Authorization: Bearer <sessionToken> emitido por /api/playback/session
 */
app.post('/api/playback/event', async (req, res) => {
    // Verificar token de sesión
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Token de sesión requerido' });

    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET, { issuer: 'reproductor-cursos' });
    } catch {
        return res.status(401).json({ error: 'Token de sesión inválido o expirado' });
    }

    if (payload.scope !== 'playback') {
        return res.status(403).json({ error: 'Token no autorizado para este endpoint' });
    }

    const { eventType, timestamp, extra } = req.body || {};

    if (!eventType || !ALLOWED_EVENT_TYPES.has(eventType)) {
        return res.status(400).json({
            error: `eventType inválido. Permitidos: ${[...ALLOWED_EVENT_TYPES].join(', ')}`,
        });
    }

    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const userAgent = (req.headers['user-agent'] || 'unknown').slice(0, 200);

    await db.logPlaybackEvent({
        sessionId:    payload.sessionId,
        studentId:    payload.studentId,
        lessonId:     payload.lessonId,
        deviceId:     payload.deviceId,
        ip,
        userAgent,
        eventType,
        extra:        extra || null,
    });

    res.json({ ok: true, sessionId: payload.sessionId, eventType, timestamp: timestamp || new Date().toISOString() });
});

// ================================================================
//  (Integración externa de monitoreo eliminada — netamente Edulock)
// ================================================================

// ================================================================
//  SISTEMA DE COMANDOS CIFRADOS — Prioridad 1 y 2
//  No modifica ningún endpoint existente.
//  Flujo: campus → generate-command → cdp://TOKEN → resolve → manifestUrl
// ================================================================

/** Deriva una clave AES-256 para cifrado de comandos */
function deriveCommandKey() {
    return crypto.hkdfSync(
        'sha256',
        Buffer.from(JWT_SECRET, 'utf-8'),
        Buffer.from('cdp-playback-command-salt', 'utf-8'),
        Buffer.from('playback-command-v1', 'utf-8'),
        32
    );
}

/** Cifra un payload con AES-256-GCM */
function encryptCommand(payload) {
    const key = deriveCommandKey();
    const iv  = crypto.randomBytes(12); // 96 bits para GCM
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

/** Descifra un comando. Devuelve el payload o lanza error. */
function decryptCommand(token) {
    let outer;
    try {
        outer = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'));
    } catch {
        throw new Error('command_malformed');
    }
    if (!outer || outer.v !== 1 || !outer.iv || !outer.enc || !outer.tag) {
        throw new Error('command_malformed');
    }
    const key     = deriveCommandKey();
    const iv      = Buffer.from(outer.iv,  'base64url');
    const enc     = Buffer.from(outer.enc, 'base64url');
    const tag     = Buffer.from(outer.tag, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let plain;
    try {
        plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    } catch {
        throw new Error('command_tampered'); // GCM auth tag inválido
    }
    try {
        return JSON.parse(plain.toString('utf-8'));
    } catch {
        throw new Error('command_malformed');
    }
}

/**
 * Cifra un videoId en un token compacto (~59 chars) para enlaces permanentes.
 * Formato binario: IV(12) + Tag(16) + Enc(16) → base64url
 */
function encryptPermToken(videoId) {
    const key    = deriveCommandKey();
    // Deterministic IV derived from videoId so same video always yields same token
    const iv     = crypto.createHmac('sha256', APP_SECRET || JWT_SECRET)
                         .update(videoId)
                         .digest()
                         .subarray(0, 12);
    const vidBin = Buffer.from(videoId.replace(/-/g, ''), 'hex'); // 16 bytes
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc    = Buffer.concat([cipher.update(vidBin), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64url'); // ~59 chars
}

/** Descifra un token compacto de enlace permanente. Devuelve el videoId o lanza error. */
function decryptPermToken(token) {
    let buf;
    try { buf = Buffer.from(token, 'base64url'); } catch { throw new Error('perm_malformed'); }
    if (!buf || buf.length < 44) throw new Error('perm_malformed');
    const iv      = buf.subarray(0, 12);
    const tag     = buf.subarray(12, 28);
    const enc     = buf.subarray(28);
    const key     = deriveCommandKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let plain;
    try { plain = Buffer.concat([decipher.update(enc), decipher.final()]); }
    catch { throw new Error('perm_tampered'); }
    const hex = plain.toString('hex');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/**
 * POST /api/playback/generate-command
 * Genera un token cifrado de reproducción (sin URL real).
 * El campus llama esto después de validar el acceso del alumno.
 * El token resultante se puede pasar al reproductor como:
 *   cdp://eyJ...  ← no contiene ninguna URL real
 *
 * Requiere: Authorization: Bearer <student_jwt>
 * Body: { videoId, courseId?, moduleId? }
 * Response: { command: "cdp://eyJ..." }
 */
app.post('/api/playback/generate-command', requireAuth, async (req, res) => {
    const { videoId, courseId, moduleId } = req.body || {};

    if (!videoId || typeof videoId !== 'string') {
        return res.status(400).json({ error: 'videoId requerido' });
    }
    if (!/^[0-9a-f-]{36}$/i.test(videoId)) {
        return res.status(400).json({ error: 'videoId inválido' });
    }

    // Verificar que el video exista en el catálogo
    const videoEntry = await db.getCatalogById(videoId);
    if (!videoEntry || videoEntry.status !== 'ready') {
        return res.status(404).json({ error: 'Video no disponible' });
    }

    // Verificar acceso del alumno al video
    if (!req.user.admin) {
        const allowed = Array.isArray(req.user.allowedVideos) ? req.user.allowedVideos : [];
        if (!allowed.includes('*') && !allowed.includes(videoId)) {
            return res.status(403).json({ error: 'No tienes acceso a este video.' });
        }
    }

    const studentId = req.user.sub;
    const deviceId  = req.user.deviceId || 'unknown';

    // Validar dispositivo en la tabla de dispositivos (límite por alumno, default 1)
    // Solo aplica si el alumno no es admin
    if (!req.user.admin) {
        const browser = (req.headers['user-agent'] || '').slice(0, 100);
        const clientIp = req.ip || req.connection?.remoteAddress || '';
        // Lookup geo async; si no está en caché se hace en background y no bloquea
        const geoInfo = _ipInfoCache.get(clientIp)?.data || null;
        const city = geoInfo?.city || '';
        const result  = await db.registerOrValidateDevice(studentId, deviceId, { browser, city }, 1);
        if (!result.ok) {
            if (result.reason === 'device_limit_exceeded') {
                const lim = result.limit || 1;
                // Registrar intento de dispositivo extra
                await db.logSuspiciousActivity({
                    studentId,
                    deviceId,
                    type:        'extra_device_attempt',
                    severity:    'high',
                    description: `Intento de acceso desde un dispositivo extra. Límite del alumno: ${lim}.`,
                    metadata:    { videoId, courseId, userAgent: browser },
                });
                return res.status(403).json({
                    error: `Dispositivos máximos alcanzados (${lim}). Solo el administrador puede liberar o cambiar tus dispositivos.`,
                    code: 'DEVICE_LIMIT_EXCEEDED'
                });
            }
            if (result.reason === 'device_blocked') {
                return res.status(403).json({
                    error: 'Este dispositivo ha sido bloqueado. Contacta al administrador.'
                });
            }
        }
    }

    // Generar comando cifrado (15 minutos de expiración)
    const sessionId = uuidv4();
    const nonce     = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const payload = {
        v:         1,
        videoId,
        courseId:  courseId  || videoEntry.courseId  || null,
        moduleId:  moduleId  || videoEntry.moduleId  || null,
        studentId,
        deviceId,
        sessionId,
        expiresAt,
        nonce,
    };

    const token   = encryptCommand(payload);
    const command = `edulock://${token}`;

    // JWT corto para que el reproductor externo valide al alumno (15 min)
    const playerToken = jwt.sign(
        {
            sub:           studentId,
            email:         req.user.email || req.user.studentEmail || '',
            deviceId,
            allowedVideos: req.user.allowedVideos || [],
            scope:         'player',
            admin:         false,
        },
        JWT_SECRET,
        { expiresIn: '15m', issuer: 'reproductor-cursos' }
    );

    // Guardar short-token (22 chars) para que el link sea compacto
    const shortToken = crypto.randomBytes(16).toString('base64url');
    await db.storePendingToken(shortToken, command, playerToken, Date.now() + 15 * 60 * 1000, false);

    const playerUrl = `edulock://play?t=${shortToken}`;

    res.json({ command, sessionId, expiresIn: 900, playerToken, playerUrl, shortToken });
});

/**
 * GET /api/playback/t/:token
 * Canjea un short-token por {cmd, auth}. Sin autenticación — el token ES la credencial.
 * Tokens normales: un solo uso (se eliminan). Tokens DEV: reutilizables.
 * Si el token incluye deviceId en la query, valida que coincida con la sesión de activación.
 */
app.get('/api/playback/t/:token', validateAppSig, async (req, res) => {
    const { token } = req.params;
    if (!token || !/^[A-Za-z0-9_-]{10,40}$/.test(token)) {
        return res.status(400).json({ error: 'Token inválido' });
    }
    const entry = await db.consumePendingToken(token);
    if (!entry) {
        return res.status(404).json({ error: 'Token expirado o inválido. Genera un nuevo link desde tu campus.' });
    }

    // Si el Electron envía su deviceId, validar que la activación local sea válida para este device
    const deviceId = req.query.deviceId || req.headers['x-device-id'] || '';
    if (deviceId) {
        const crypto2 = require('crypto');
        // Verificar que exista al menos una activación activa para este dispositivo
        // Usamos getActivationByTokenHash si el Electron pasa su activationToken en header
        const activationToken = req.headers['x-activation-token'] || '';
        if (activationToken) {
            const tokenHash = crypto2.createHmac('sha256', process.env.JWT_SECRET || '').update(activationToken).digest('hex');
            const activation = await db.getActivationByTokenHash(tokenHash).catch(() => null);
            if (!activation || activation.status !== 'active') {
                return res.status(403).json({
                    error: 'Activación no válida o revocada. Vuelve a activar tu licencia.',
                    code: 'ACTIVATION_INVALID',
                });
            }
            if (activation.deviceId && activation.deviceId !== deviceId) {
                return res.status(403).json({
                    error: 'Este dispositivo no coincide con la activación registrada.',
                    code: 'DEVICE_MISMATCH',
                });
            }
            // Actualizar last_used_at
            await db.touchActivation(activation.id).catch(() => {});
        }
    }

    res.json({ cmd: entry.cmd, auth: entry.auth });
});

/**
 * POST /api/playback/resolve
 * Recibe un comando cifrado, lo valida por completo y devuelve la URL de reproducción.
 * El alumno NUNCA ve la URL real — la recibe solo en memoria el reproductor.
 *
 * Requiere: Authorization: Bearer <student_jwt>
 * Body: { command: "cdp://eyJ..." }
 * Response: { manifestUrl, mediaToken, watermarkText, studentCode, ttl, sessionId }
 */
app.post('/api/playback/resolve', validateAppSig, requireAuth, async (req, res) => {
    const { command } = req.body || {};
    if (!command || typeof command !== 'string') {
        return res.status(400).json({ error: 'No se pudo validar la sesión de reproducción.\nVuelve a ingresar desde Edulock Systems.' });
    }

    // Acepta el esquema actual (edulock://) y el legado (cdp://) de tokens ya emitidos
    const token = command.replace(/^(edulock|cdp):\/\//i, '');

    let payload;
    try {
        payload = decryptCommand(token);
    } catch (e) {
        const code = e.message || 'command_error';
        // Log técnico para admin, mensaje genérico para alumno
        await db.logSuspiciousActivity({
            studentId: req.user.sub,
            deviceId:  req.user.deviceId || 'unknown',
            type:      'invalid_command',
            severity:  'medium',
            description: `Error al descifrar comando: ${code}`,
        });
        return res.status(401).json({ error: 'No se pudo validar la sesión de reproducción.\nVuelve a ingresar desde Edulock Systems.' });
    }

    // ── Validación 1: Expiración
    if (!payload.expiresAt || !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now()) {
        return res.status(401).json({ error: 'Tu sesión de reproducción venció. Vuelve a abrir el video desde el campus.' });
    }

    // ── Validación 2: Nonce anti-replay
    // Los nonces con prefijo DEV_ son solo para pruebas locales y se pueden reutilizar.
    const isDevNonce = process.env.NODE_ENV === 'test' && typeof payload.nonce === 'string' && payload.nonce.startsWith('DEV_');
    if (!isDevNonce) {
        if (!payload.nonce || !await db.consumeNonce(payload.nonce)) {
            await db.logSuspiciousActivity({
                studentId: req.user.sub,
                deviceId:  req.user.deviceId || 'unknown',
                type:      'replay_attack',
                severity:  'high',
                description: 'Comando de reproducción reutilizado (nonce ya consumido).',
            });
            return res.status(401).json({ error: 'Este comando de reproducción ya fue utilizado.\nVuelve a generar uno nuevo desde el campus.' });
        }
    }

    // ── Validación 3: Alumno correcto
    if (payload.studentId !== req.user.sub && !req.user.admin) {
        await db.logSuspiciousActivity({
            studentId: req.user.sub,
            deviceId:  req.user.deviceId || 'unknown',
            type:      'student_mismatch',
            severity:  'high',
            description: `Comando generado para ${payload.studentId} pero usado por ${req.user.sub}`,
        });
        return res.status(403).json({ error: 'Este contenido solo puede abrirse desde el reproductor autorizado de Edulock Systems.' });
    }

    // ── Validación 4: Dispositivo correcto
    if (payload.deviceId && payload.deviceId !== (req.user.deviceId || 'unknown') && !req.user.admin) {
        await db.logSuspiciousActivity({
            studentId: req.user.sub,
            deviceId:  req.user.deviceId || 'unknown',
            type:      'device_mismatch',
            severity:  'high',
            description: `Comando generado para dispositivo ${payload.deviceId} pero usado desde ${req.user.deviceId}`,
        });
        return res.status(403).json({ error: 'Este dispositivo no está autorizado.\nContacta al administrador.' });
    }

    try { res.json(await playerHandshake.resolve(req, payload.videoId, requestDevice(req, req.user))); }
    catch (error) { sendAccessError(res, error); }
});

/**
 * GET /api/admin/perm-link/:videoId
 * Genera un enlace permanente cifrado para un video. Solo admin.
 * El enlace no expira y puede ser usado por múltiples alumnos con el reproductor oficial.
 */
app.get('/api/admin/perm-link/:videoId', requireAdmin, async (req, res) => {
    const { videoId } = req.params;
    if (!videoId || !/^[0-9a-f-]{36}$/i.test(videoId)) {
        return res.status(400).json({ error: 'videoId inválido' });
    }
    const videoEntry = await db.getCatalogById(videoId);
    if (!videoEntry || videoEntry.status !== 'ready') {
        return res.status(404).json({ error: 'Video no disponible' });
    }
    const token = encryptPermToken(videoId);
    res.json({ link: `edulock://play?p=${token}` });
});

/**
 * POST /api/playback/resolve-perm
 * Resuelve un enlace permanente cifrado.
 * Requiere:
 *   1. Firma HMAC del reproductor oficial (APP_SECRET) — valida que sea el .exe oficial
 *   2. JWT válido del alumno (requireAuth) — valida que tenga cuenta aprobada
 *   3. deviceId registrado y perteneciente al alumno — valida que sea su dispositivo
 * Así se cierra el vacío: APP_SECRET solo ya no alcanza.
 */
app.post('/api/playback/resolve-perm', validateAppSig, requireAuth, async (req, res) => {
    const { perm, deviceId } = req.body || {};
    if (typeof perm !== 'string' || !perm || perm.length > 4096) return res.status(400).json({ error: 'Token permanente requerido.' });
    if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 64) return res.status(400).json({ error: 'Dispositivo no identificado.', code: 'DEVICE_REQUIRED' });
    let videoId;
    try {
        videoId = decryptPermToken(perm);
        if (typeof videoId !== 'string' || !/^[0-9a-f-]{36}$/i.test(videoId)) throw new Error('Invalid video');
    } catch { return res.status(400).json({ error: 'Enlace permanente inválido.', code: 'INVALID_PERM_LINK' }); }
    try { res.json(await playerHandshake.resolve(req, videoId, deviceId, 'perm')); }
    catch (error) { sendAccessError(res, error); }
});

/**
 * POST /api/playback/progress
 * Guarda el progreso de reproducción del alumno (llamar cada 20-30s).
 * Throttling: el cliente debe espaciar las llamadas — el servidor acepta todas
 * pero la BD solo guarda si el progreso avanzó o pasaron >20s.
 *
 * Requiere: Authorization: Bearer <jwt>
 * Body: { videoId, courseId?, progressPercent, currentTime }
 */
app.post('/api/playback/progress', requireAuth, async (req, res) => {
    const { videoId, courseId, progressPercent, currentTime } = req.body || {};
    if (!videoId || progressPercent == null) {
        return res.status(400).json({ error: 'videoId y progressPercent requeridos' });
    }
    if (!/^[0-9a-f-]{36}$/i.test(videoId)) {
        return res.status(400).json({ error: 'videoId inválido' });
    }
    const pct = Math.min(100, Math.max(0, Number(progressPercent) || 0));
    const pos = Math.floor(Number(currentTime) || 0);
    console.log(`[progress] student=${req.user.sub} video=${videoId} pct=${pct}% pos=${pos}s`);

    // Capturar ciudad por IP (usa caché de 1h, fallo silencioso)
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
    const geoInfo  = await lookupIpInfo(clientIp).catch(() => null);
    const city     = geoInfo?.city || null;

    await db.saveProgress({
        studentId:       req.user.sub,
        videoId,
        courseId:        courseId || null,
        progressPercent: pct,
        lastPosition:    pos,
        deviceId:        req.user.deviceId || null,
        city,
    });

    res.json({ ok: true });
});

/**
 * POST /api/playback/event-secure
 * Registra un evento de reproducción (DevTools, grabación, pausa, etc.).
 * Throttling depende del cliente — el servidor acepta eventos válidos.
 *
 * Requiere: Authorization: Bearer <jwt>
 * Body: { videoId, eventType, progressPercent?, currentTime?, metadata? }
 */
app.post('/api/playback/event-secure', requireAuth, async (req, res) => {
    const { videoId, eventType, progressPercent, currentTime, metadata } = req.body || {};
    if (!videoId || !eventType) {
        return res.status(400).json({ error: 'videoId y eventType requeridos' });
    }
    if (!/^[0-9a-f-]{36}$/i.test(videoId)) {
        return res.status(400).json({ error: 'videoId inválido' });
    }

    await db.insertPlaybackEvent({
        studentId:       req.user.sub,
        videoId,
        courseId:        null,
        deviceId:        req.user.deviceId || null,
        eventType,
        progressPercent: progressPercent != null ? Number(progressPercent) : null,
        currentTime:     currentTime     != null ? Number(currentTime)     : null,
        metadata:        metadata || null,
    });

    // Si es un evento de seguridad, registrar en actividad sospechosa
    if (['devtools_open', 'screen_recording_detected'].includes(eventType)) {
        await db.logSuspiciousActivity({
            studentId:   req.user.sub,
            deviceId:    req.user.deviceId || 'unknown',
            type:        eventType,
            severity:    eventType === 'screen_recording_detected' ? 'high' : 'medium',
            description: metadata?.description || `Evento detectado: ${eventType}`,
            metadata:    { videoId, currentTime, ...metadata },
        });
    }

    res.json({ ok: true });
});

// ================================================================
//  NUEVAS RUTAS ADMIN — Actividad sospechosa, progreso, dispositivos
// ================================================================

/**
 * GET /api/suspicious-activity  [ADMIN]
 * Lista la actividad sospechosa registrada.
 */
app.get('/api/suspicious-activity', requireAdmin, async (req, res) => {
    const unreviewed = req.query.unreviewed === 'true';
    const limit      = Math.min(parseInt(req.query.limit || '200', 10), 1000);
    const studentId  = req.query.studentId || null;

    let items;
    if (studentId) {
        items = await db.getSuspiciousByStudent(studentId, limit);
    } else if (unreviewed) {
        items = await db.getUnreviewedSuspicious(limit);
    } else {
        items = await db.getSuspiciousActivity(limit);
    }
    const unreviewedCount = await db.countUnreviewed();
    res.json({ items, total: items.length, unreviewedCount });
});

/**
 * PUT /api/suspicious-activity/:id/review  [ADMIN]
 * Marca un registro de actividad sospechosa como revisado.
 */
app.put('/api/suspicious-activity/:id/review', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'id inválido' });
    await db.markSuspiciousReviewed(id);
    res.json({ ok: true });
});

/**
 * DELETE /api/suspicious-activity/:id  [ADMIN]
 * Elimina un registro de actividad sospechosa.
 */
app.delete('/api/suspicious-activity/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'id inválido' });
    await db.pool.query('DELETE FROM suspicious_activity WHERE id=$1', [id]).catch(() => {});
    res.json({ ok: true });
});

/**
 * GET /api/admin/security-events  [ADMIN]
 * Eventos de seguridad reportados por el reproductor (cliente): MITM detectado,
 * sesión remota, secure-boot/HVCI desactivado, grabador de pantalla, etc.
 */
app.get('/api/admin/security-events', requireAdmin, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
    try {
        const items = await db.getSecurityEvents(limit);
        res.json({ items, total: items.length });
    } catch (err) {
        console.error('[security-events]', err.message);
        res.json({ items: [], total: 0 });
    }
});

/**
 * GET /api/admin/segment-audit  [ADMIN]
 * Auditoría granular HLS: consumidores con más segmentos en una ventana de tiempo.
 * Un alumno que pide cientos de segmentos en poco tiempo está descargando el video.
 */
app.get('/api/admin/segment-audit', requireAdmin, async (req, res) => {
    const hours = Math.min(Math.max(parseInt(req.query.hours || '24', 10), 1), 720);
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    try {
        const rows = await db.getSegmentAudit({ hours, limit });
        // Detección por RITMO, no por cantidad bruta.
        // Adelantar el video manualmente o hacer scrubbing repetido infla
        // total_requests sin que haya descarga. Lo que SÍ delata una descarga
        // masiva es pedir muchos trozos por minuto, mucho más rápido que ver
        // el video en tiempo real (un reproductor normal pide ~6-10 trozos/min).
        // Solo marcamos cuando el ritmo es claramente automático.
        const MIN_REQUESTS = 120;   // volumen mínimo para considerarlo
        const MIN_RATE     = 40;    // trozos/min: >4x la velocidad de visionado real
        const items = rows.map(r => {
            const total = parseInt(r.total_requests, 10) || 0;
            const t0 = r.first_seen ? new Date(r.first_seen).getTime() : 0;
            const t1 = r.last_seen  ? new Date(r.last_seen).getTime()  : 0;
            const spanMin = Math.max((t1 - t0) / 60000, 0.5); // mínimo 0.5 min para no dividir por ~0
            const ratePerMin = Math.round(total / spanMin);
            return {
                ...r,
                total_requests:    total,
                distinct_segments: parseInt(r.distinct_segments, 10) || 0,
                span_minutes:      Math.round(spanMin),
                rate_per_min:      ratePerMin,
                suspicious:        total >= MIN_REQUESTS && ratePerMin >= MIN_RATE,
            };
        });
        res.json({ items, total: items.length, hours, flagged: items.filter(i => i.suspicious).length });
    } catch (err) {
        console.error('[segment-audit]', err.message);
        res.json({ items: [], total: 0, hours, flagged: 0 });
    }
});


/**
 * GET /api/dashboard/stats  [ADMIN]
 * Retorna stats agregados para el dashboard sin transferir registros crudos.
 * Mucho más rápido que traer 500 entradas y agruparlas en el cliente.
 */
app.get('/api/dashboard/stats', requireAdmin, async (req, res) => {
    try {
        const adminEmail = req.user.email || (process.env.ADMIN_USER || 'admin@edulocksystemsoficial.dpdns.org').trim();
        const adminUid   = req.user.sub;
        const [videoCountRes, deliveryCountRes, unreviewedRes, pendingRes, usersRes] = await Promise.all([
            db.pool.query("SELECT COUNT(*) AS n FROM catalog WHERE status='ready'").catch(() => ({ rows: [{ n: 0 }] })),
            db.pool.query('SELECT COUNT(*) AS n FROM audit_log WHERE event_type IS NULL').catch(() => ({ rows: [{ n: 0 }] })),
            db.pool.query('SELECT COUNT(*) AS n FROM suspicious_activity WHERE reviewed=0').catch(() => ({ rows: [{ n: 0 }] })),
            Promise.resolve({ rows: [{ n: 0 }] }), // ya no existen solicitudes de registro: el acceso lo decide la licencia
            db.pool.query(`
                SELECT
                    al.user_id AS uid,
                    COALESCE(
                        NULLIF(MAX(al.student_email), ''),
                        NULLIF(MAX(s.email), ''),
                        CASE WHEN al.user_id='admin' THEN $2
                             WHEN al.user_id = $1    THEN $2
                             ELSE al.user_id END
                    ) AS email,
                    COUNT(*)             AS cnt,
                    MAX(al.delivered_at) AS last_at
                FROM audit_log al
                LEFT JOIN students s ON NULLIF(s.firebase_uid,'') = al.user_id
                WHERE al.event_type IS NULL
                GROUP BY al.user_id
                ORDER BY last_at DESC
                LIMIT 200
            `, [adminUid, adminEmail]).catch(async () =>
                db.pool.query(`
                    SELECT user_id AS uid,
                           COALESCE(NULLIF(MAX(student_email),''), user_id) AS email,
                           COUNT(*) AS cnt, MAX(delivered_at) AS last_at
                    FROM audit_log WHERE event_type IS NULL
                    GROUP BY user_id ORDER BY last_at DESC LIMIT 200
                `).catch(() => ({ rows: [] }))
            ),
        ]);
        res.json({
            videoCount:      parseInt(videoCountRes.rows[0].n, 10),
            deliveryCount:   parseInt(deliveryCountRes.rows[0].n, 10),
            unreviewedCount: parseInt(unreviewedRes.rows[0].n, 10),
            pendingCount:    parseInt(pendingRes.rows[0].n, 10),
            users: (usersRes.rows || []).map(r => ({
                uid:    r.uid,
                email:  (r.uid === adminUid || r.uid === 'admin')
                    ? (adminEmail || r.email || r.uid)
                    : (r.email || r.uid),
                count:  parseInt(r.cnt, 10),
                lastAt: r.last_at,
            })),
        });
    } catch (err) {
        console.error('[dashboard/stats]', err);
        res.status(500).json({ error: 'Error al cargar stats' });
    }
});

/**
 * DELETE /api/audit/log/:id  [ADMIN]
 * Elimina un registro del log de auditoría por su ID.
 */
app.delete('/api/audit/log/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'id inválido' });
    await db.pool.query('DELETE FROM audit_log WHERE id=$1', [id]).catch(() => {});
    res.json({ ok: true });
});

/**
 * DELETE /api/audit/log/user/:userId  [ADMIN]
 * Elimina todos los registros de auditoría de un usuario.
 */
app.delete('/api/audit/log/user/:userId', requireAdmin, async (req, res) => {
    const userId = req.params.userId;
    if (!userId) return res.status(400).json({ error: 'userId requerido' });
    const result = await db.pool.query(
        'DELETE FROM audit_log WHERE user_id=$1 OR student_email=$1', [userId]
    ).catch(() => ({ rowCount: 0 }));
    res.json({ ok: true, deleted: result.rowCount });
});

/**
 * DELETE /api/devices/:id  [ADMIN]
 * Elimina un dispositivo específico por su UUID.
 */
app.delete('/api/devices/:id', requireAdmin, async (req, res) => {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'id inválido' });
    await db.pool.query('DELETE FROM devices WHERE id=$1', [id]).catch(() => {});
    res.json({ ok: true });
});

/**
 * DELETE /api/playback/progress/:studentId/:videoId  [ADMIN]
 * Elimina el registro de progreso de un alumno para un video.
 */
app.delete('/api/playback/progress/:studentId/:videoId', requireAdmin, async (req, res) => {
    const { studentId, videoId } = req.params;
    await db.pool.query(
        'DELETE FROM playback_progress WHERE student_id=$1 AND video_id=$2',
        [studentId, videoId]
    ).catch(() => {});
    res.json({ ok: true });
});



/**
 * GET /api/students/:id/progress  [ADMIN]
 * Progreso de reproducción de un alumno específico.
 */
app.get('/api/students/:id/progress', requireAdmin, async (req, res) => {
    const progress = await db.getProgressByStudent(req.params.id);
    const catalog  = await db.loadCatalog();
    const vidMap   = {};
    for (const v of catalog) vidMap[v.videoId] = v;
    const enriched = progress.map(p => ({
        ...p,
        videoTitle: vidMap[p.video_id]?.title || p.video_id,
    }));
    res.json({ progress: enriched, total: enriched.length });
});

/**
 * GET /api/students/:id/devices  [ADMIN]
 * Lista de dispositivos autorizados de un alumno. El id puede ser el student ID o 'admin_<uid>'.
 */
app.get('/api/students/:id/devices', requireAdmin, async (req, res) => {
    const id = req.params.id;
    // Si el admin pasa su email, buscar el uid de Firebase y usar admin_<uid>
    let lookupId = id;
    if (id.includes('@')) {
        // Es un email de admin — buscar todos los ids que empiecen con 'admin_'
        // No tenemos mapeo email→uid aquí, así que listamos todos los admin devices
        const allDevices = await db.getDevicesByStudent(`admin_${id}`).catch(() => []);
        return res.json({ devices: allDevices, total: allDevices.length, maxDevices: null });
    }
    const devices = await db.getDevicesByStudent(lookupId);
    let maxDevices = 1;
    try { maxDevices = await db.getStudentMaxDevices(lookupId); } catch { maxDevices = 1; }
    res.json({ devices, total: devices.length, maxDevices });
});

/**
 * PUT /api/admin/students/:id/max-devices  [ADMIN]
 * Establece la cantidad de dispositivos permitidos para un alumno (mínimo 1).
 */
app.put('/api/admin/students/:id/max-devices', requireAdmin, async (req, res) => {
    const id = req.params.id;
    if (id.includes('@')) {
        return res.status(400).json({ error: 'Usa el ID del alumno, no el email.' });
    }
    const n = parseInt(req.body && req.body.maxDevices, 10);
    if (!Number.isFinite(n) || n < 1) {
        return res.status(400).json({ error: 'maxDevices debe ser un número entero mayor o igual a 1.' });
    }
    const student = await db.findStudentById(id).catch(() => null);
    if (!student) return res.status(404).json({ error: 'Alumno no encontrado.' });
    const applied = await db.setStudentMaxDevices(id, n);
    res.json({ ok: true, maxDevices: applied });
});

/**
 * GET /api/admin/my-devices  [ADMIN]
 * Muestra los dispositivos del propio administrador.
 */
app.get('/api/admin/my-devices', requireAdmin, async (req, res) => {
    if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
    const adminStudentId = `admin_${req.user.sub}`;
    const devices = await db.getDevicesByStudent(adminStudentId).catch(() => []);
    res.json({ devices, total: devices.length });
});

/**
 * GET /api/admin/all-devices  [ADMIN]
 * Lista todos los dispositivos registrados con info del alumno enriquecida.
 */
app.get('/api/admin/all-devices', requireAdmin, async (req, res) => {
    if (!dbReady) return res.status(503).json({ error: 'DB no disponible' });
    const adminUid   = req.user.sub;
    const adminEmail = req.user.email || 'Administrador';

    const rows = await db.pool.query(`
        SELECT d.*,
               s.email  AS student_email,
               s.name   AS student_name
        FROM   devices d
        LEFT JOIN students s ON s.id = d.student_id
        ORDER  BY d.last_seen DESC NULLS LAST
        LIMIT  500
    `).catch(() => ({ rows: [] }));

    const devices = rows.rows.map(d => {
        const sid = d.student_id || '';
        const isAdmin = sid === `admin_${adminUid}` || sid.startsWith('admin_');
        return {
            ...d,
            student_email: isAdmin ? adminEmail : (d.student_email || sid),
            student_name:  isAdmin ? 'Administrador' : (d.student_name || ''),
        };
    });

    res.json({ devices, total: devices.length });
});

/**
 * DELETE /api/students/:id/devices  [ADMIN]
 * Resetea todos los dispositivos de un alumno (permite registrar nuevos desde cero).
 */
app.delete('/api/students/:id/devices', requireAdmin, async (req, res) => {
    await db.resetStudentDevices(req.params.id);
    res.json({ ok: true, message: 'Dispositivos eliminados. El alumno podrá registrar nuevos dispositivos según su límite.' });
});

/**
 * GET /api/student/code  [alumno autenticado]
 * Devuelve el código único del alumno para el watermark.
 */
app.get('/api/student/code', requireAuth, async (req, res) => {
    if (req.user.admin) return res.status(403).json({ error: 'Solo para alumnos' });
    const code = await db.getOrCreateStudentCode(req.user.sub);
    res.json({ code });
});

/**
 * GET /api/playback/progress-all  [ADMIN]
 * Progreso de reproducción de todos los alumnos.
 */
app.get('/api/playback/progress-all', requireAdmin, async (req, res) => {
    const adminUid   = req.user.sub;
    const adminEmail = req.user.email || 'Administrador';
    const limit    = Math.min(parseInt(req.query.limit || '500', 10), 2000);
    const progress = await db.getAllProgress(limit);
    const catalog  = await db.loadCatalog();
    const students = await db.getAllStudents();

    // Obtener fingerprints de devices para resolver device-IDs a estudiantes y obtener ciudad/código
    const deviceRows = await db.pool.query(
        'SELECT fingerprint, student_id, id, city FROM devices WHERE fingerprint IS NOT NULL'
    ).catch(() => ({ rows: [] }));

    const vidMap        = {};
    const stuMap        = {};   // por UUID de PostgreSQL
    const stuByFirebase = {};   // por firebase_uid
    const stuByDevice   = {};   // por fingerprint → student_id (UUID PostgreSQL)
    const devByFp       = {};   // por fingerprint → { code, city }

    for (const v of catalog)       vidMap[v.videoId]          = v;
    for (const s of students) {
        stuMap[s.id] = s;
        if (s.firebase_uid) stuByFirebase[s.firebase_uid]     = s;
    }
    for (const d of deviceRows.rows) {
        if (d.fingerprint && d.student_id) stuByDevice[d.fingerprint] = d.student_id;
        if (d.fingerprint) devByFp[d.fingerprint] = {
            code: d.fingerprint || '',
            city: d.city || '',
        };
    }

    const enriched = progress.map(p => {
        const sid = p.student_id || '';
        const devInfo = devByFp[p.device_id] || {};

        // Registros del administrador: Firebase UID directo o prefijo admin_
        if (sid === adminUid || sid.startsWith('admin_') || sid.startsWith('admin:')) {
            return {
                ...p,
                videoTitle:   vidMap[p.video_id]?.title || p.video_id,
                studentEmail: adminEmail,
                studentName:  'Administrador',
                device_code:  devInfo.code || '',
                device_city:  devInfo.city || p.city || '',
            };
        }

        // 1. Buscar por UUID de PostgreSQL (flujo normal de alumnos)
        let stu = stuMap[sid];
        // 2. Buscar por firebase_uid vinculado al alumno
        if (!stu) stu = stuByFirebase[sid];
        // 3. Buscar por device fingerprint → student_id → alumno
        if (!stu && stuByDevice[sid]) stu = stuMap[stuByDevice[sid]];

        return {
            ...p,
            videoTitle:   vidMap[p.video_id]?.title || p.video_id,
            studentEmail: stu?.email || sid,
            studentName:  stu?.name  || '',
            device_code:  devInfo.code || '',
            device_city:  devInfo.city || p.city || '',
        };
    });
    res.json({ progress: enriched, total: enriched.length });
});

/**
 * POST /api/security/report
 * El reproductor reporta silenciosamente eventos de seguridad del sistema
 * (Secure Boot desactivado, HVCI desactivado) sin mostrar nada al usuario.
 * Solo acepta peticiones firmadas con APP_SECRET (HMAC).
 */
app.post('/api/security/report', validateAppSig, async (req, res) => {
    const { event, deviceId, details } = req.body || {};
    if (!event || typeof event !== 'string') return res.json({ ok: true });
    const dId = (typeof deviceId === 'string' ? deviceId : '').slice(0, 64) || 'unknown';
    const evtClean = event.slice(0, 50);
    const det = details ? JSON.stringify(details).slice(0, 500) : '';
    console.log(`[SECURITY-REPORT] event=${evtClean} device=${dId} ip=${req.ip}`);
    try {
        await db.pool.query(
            `INSERT INTO audit_log (fingerprint, user_id, video_id, device_id, ip, user_agent, delivered_at, event_type)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
                `sec_${evtClean}_${dId}_${Date.now()}`,
                'system',
                evtClean,
                dId,
                req.ip || 'unknown',
                det || evtClean,
                new Date().toISOString(),
                'security_warning',
            ]
        ).catch(() => {});
    } catch { /* no bloquear */ }
    res.json({ ok: true });
});

/**
 * POST /api/device/checkin
 * El reproductor notifica al servidor que el app fue abierto.
 * Registra en audit_log con event_type='startup' y actualiza last_seen del dispositivo.
 * Requiere JWT válido (token de sesión Firebase del alumno).
 */
app.post('/api/device/checkin', requireAuth, async (req, res) => {
    const { deviceId, hostname, platform, arch, cpus, totalmem, deviceModel, osRelease, appVersion } = req.body || {};
    const studentId = req.user.sub;
    const dId = (typeof deviceId === 'string' ? deviceId : '').slice(0, 64) || 'unknown';
    console.log(`[checkin] student=${studentId} device=${dId} platform=${platform || '?'} appVersion=${appVersion || '?'}`);
    try {
        // Actualizar last_seen (y browser/os si están disponibles) en la tabla devices
        const osStr     = platform && osRelease ? `${platform} ${osRelease}` : (platform || '');
        const browserStr = appVersion ? `EDULOCK Player ${appVersion}` : '';
        const hostnameStr = hostname || deviceModel || '';
        const updateParams = [new Date().toISOString(), dId];
        let updateSql = `UPDATE devices SET last_seen=$1`;
        if (osStr)       { updateParams.push(osStr.slice(0, 100));       updateSql += `, os=$${updateParams.length}`; }
        if (browserStr)  { updateParams.push(browserStr.slice(0, 100));  updateSql += `, browser=$${updateParams.length}`; }
        if (hostnameStr) { updateParams.push(hostnameStr.slice(0, 100)); updateSql += `, device_name=$${updateParams.length}`; }
        updateSql += ` WHERE fingerprint=$2`;
        await db.pool.query(updateSql, updateParams).catch(() => {});

        // Los eventos de startup ya quedan registrados en devices.last_seen — no
        // necesitamos crear entradas en audit_log que contaminen el log de entregas.
    } catch { /* no bloquear al usuario si falla */ }
    res.json({ ok: true });
});

// Helpers de links de descarga por plataforma (Windows/Android/macOS/Linux/iOS)
const PLATFORM_KEYS = ['windows', 'android', 'macos', 'linux', 'ios'];
async function getPlatformDownloads() {
    const out = {};
    for (const k of PLATFORM_KEYS) {
        try { out[k] = (await db.getConfig('dl_' + k)) || ''; }
        catch { out[k] = ''; }
    }
    return out;
}
async function setPlatformDownloads(downloads) {
    for (const k of PLATFORM_KEYS) {
        if (!(k in downloads)) continue;
        const val = downloads[k] ? String(downloads[k]).trim().slice(0, 500) : '';
        try { await db.setConfig('dl_' + k, val); } catch { /* no bloquear */ }
    }
}

// GET /api/player/version — versión mínima requerida del reproductor
app.get('/api/player/version', async (req, res) => {
    const v = await db.getPlayerVersion();
    const downloads = await getPlatformDownloads();
    res.json({ minVersion: v.minVersion, latestVersion: v.latestVersion, downloadUrl: v.downloadUrl, message: v.message, downloads });
});

// PUT /api/player/version [ADMIN] — actualiza versión mínima/última del reproductor
app.put('/api/player/version', requireAdmin, async (req, res) => {
    const { minVersion, latestVersion, downloadUrl, message, downloads } = req.body || {};
    if (!minVersion || !latestVersion) {
        return res.status(400).json({ error: 'minVersion y latestVersion requeridos' });
    }
    const semverRe = /^\d+\.\d+\.\d+$/;
    if (!semverRe.test(minVersion) || !semverRe.test(latestVersion)) {
        return res.status(400).json({ error: 'Formato de versión inválido (ej: 1.2.3)' });
    }
    await db.setPlayerVersion({ minVersion, latestVersion, downloadUrl: downloadUrl || null, message: message || null });
    // Links de descarga por plataforma (guardados en app_config)
    if (downloads && typeof downloads === 'object') {
        await setPlatformDownloads(downloads);
    }
    const v = await db.getPlayerVersion();
    const dls = await getPlatformDownloads();
    res.json({ ok: true, ...v, downloads: dls });
});

// GET /api/public/downloads — disponibilidad de descargas por plataforma (público)
// Usado por la página /download para mostrar DISPONIBLE / PRÓXIMAMENTE dinámicamente.
app.get('/api/public/downloads', async (req, res) => {
    const downloads = await getPlatformDownloads();
    const v = await db.getPlayerVersion().catch(() => ({ latestVersion: '1.0.0' }));
    res.json({ downloads, latestVersion: v.latestVersion });
});

// ── Lista blanca de seguridad (drivers/DLLs legítimos + hipervisor) ───────────
// Config key: security_whitelist (JSON en app_config).
// GET público: lo consultan el panel admin (carga) y el reproductor.
// PUT admin: lo guarda el panel.
const SECURITY_WHITELIST_DEFAULT = {
    drivers: [],
    dlls: [],
    allowHypervisor: false,
    aiBlock: [],    // herramientas de IA / análisis a BLOQUEAR (además de las fijas)
    toolAllow: [],  // excepciones: nombres que NUNCA se bloquean (lista blanca)
};
function normalizeWhitelistList(arr, max = 500) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const item of arr) {
        const v = String(item || '').trim().toLowerCase().slice(0, 120);
        if (!v || seen.has(v)) continue;
        // Solo nombres de archivo/proceso simples (evita inyección de rutas/JSON).
        // Se permiten espacios para procesos como "ollama app.exe".
        if (!/^[a-z0-9._+ -]+$/.test(v)) continue;
        seen.add(v);
        out.push(v);
        if (out.length >= max) break;
    }
    return out;
}

app.get('/api/security/whitelist', async (req, res) => {
    try {
        const raw = await db.getConfig('security_whitelist');
        if (!raw) return res.json(SECURITY_WHITELIST_DEFAULT);
        let parsed;
        try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object') return res.json(SECURITY_WHITELIST_DEFAULT);
        res.json({
            drivers: Array.isArray(parsed.drivers) ? parsed.drivers : [],
            dlls: Array.isArray(parsed.dlls) ? parsed.dlls : [],
            allowHypervisor: parsed.allowHypervisor === true,
            aiBlock: Array.isArray(parsed.aiBlock) ? parsed.aiBlock : [],
            toolAllow: Array.isArray(parsed.toolAllow) ? parsed.toolAllow : [],
        });
    } catch (e) {
        res.status(500).json({ error: 'No se pudo cargar la lista blanca' });
    }
});

app.put('/api/security/whitelist', requireAdmin, async (req, res) => {
    const { drivers, dlls, allowHypervisor, aiBlock, toolAllow } = req.body || {};
    const payload = {
        drivers: normalizeWhitelistList(drivers),
        dlls: normalizeWhitelistList(dlls),
        allowHypervisor: allowHypervisor === true,
        aiBlock: normalizeWhitelistList(aiBlock),
        toolAllow: normalizeWhitelistList(toolAllow),
    };
    try {
        await db.setConfig('security_whitelist', JSON.stringify(payload));
        res.json({ ok: true, ...payload });
    } catch (e) {
        res.status(500).json({ error: 'No se pudo guardar la lista blanca' });
    }
});

// GET /api/playback/history — historial diario de reproducción [ADMIN]
app.get('/api/playback/history', requireAdmin, async (req, res) => {
    const limit   = Math.min(parseInt(req.query.limit || '200', 10), 1000);
    const date    = req.query.date   || null;
    const student = req.query.student || null;
    const adminUid   = req.user.sub;
    const adminEmail = req.user.email || 'Administrador';

    const items = await db.getPlaybackHistory({ limit, date, student });

    // Resolver registros del administrador (Firebase UID o prefijo admin_)
    const enriched = items.map(r => {
        const sid = r.student_id || '';
        if (sid === adminUid || sid.startsWith('admin_') || sid.startsWith('admin:')) {
            return { ...r, student_email: adminEmail, student_name: 'Administrador' };
        }
        return r;
    });

    res.json({ items: enriched, total: enriched.length });
});

// ================================================================
//  SISTEMA DE PORTADAS PÚBLICAS (cover / launch)
// ================================================================

/**
 * Genera un publicCode único para un video.
 * Formato: EDU-XXXXXXXX-XXXX
 */
function generatePublicCode(videoId) {
    // Usa los primeros 8 chars del videoId (sin guiones) + 4 chars aleatorios
    const base = videoId.replace(/-/g, '').substring(0, 8).toUpperCase();
    const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `EDU-${base}-${rand}`;
}

/**
 * GET /api/admin/video/:videoId/public-code
 * Obtiene o genera el publicCode de un video. Solo admin.
 */
app.get('/api/admin/video/:videoId/public-code', requireAdmin, async (req, res) => {
    try {
        const { videoId } = req.params;
        if (!/^[0-9a-f-]{36}$/i.test(videoId)) return res.status(400).json({ error: 'videoId inválido' });
        const entry = await db.getCatalogById(videoId);
        if (!entry) return res.status(404).json({ error: 'Video no encontrado' });
        if (!entry.publicCode) {
            entry.publicCode = await db.getOrCreatePublicCode(videoId, generatePublicCode(videoId));
        }
        const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
        res.json({ publicCode: entry.publicCode, coverUrl: `${base}/cover/${entry.publicCode}` });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * POST /api/admin/video/:videoId/generate-public-code
 * Fuerza regenerar el publicCode (invalida el anterior). Solo admin.
 */
app.post('/api/admin/video/:videoId/generate-public-code', requireAdmin, async (req, res) => {
    try {
        const { videoId } = req.params;
        if (!/^[0-9a-f-]{36}$/i.test(videoId)) return res.status(400).json({ error: 'videoId inválido' });
        const entry = await db.getCatalogById(videoId);
        if (!entry) return res.status(404).json({ error: 'Video no encontrado' });
        const code = generatePublicCode(videoId);
        await db.setPublicCode(videoId, code);
        const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
        res.json({ publicCode: code, coverUrl: `${base}/cover/${code}` });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * GET /api/public/video/:publicCode
 * Devuelve solo datos públicos del video — sin URLs reales ni datos privados.
 */

// Caché en memoria: videoId → { durationSecs, ts }
const _durationCache = new Map();

async function getBunnyDuration(videoId, bunnyUrl) {
    const cached = _durationCache.get(videoId);
    if (cached && (Date.now() - cached.ts) < 24 * 60 * 60 * 1000) return cached.durationSecs;
    try {
        const entry = await db.getCatalogById(videoId);
        const courseLibrary = entry?.courseId ? await db.getCourseBunny(entry.courseId) : null;
        const apiKey    = courseLibrary?.libraryKey || await db.getConfig('bunny_api_key');
        const libraryId = courseLibrary?.libraryId || await db.getConfig('bunny_library_id');
        if (!apiKey || !libraryId) return null;
        // Extraer GUID del video de la bunnyUrl: .../GUID/playlist.m3u8
        const m = (bunnyUrl || '').match(/\/([0-9a-f-]{36})\//i);
        if (!m) return null;
        const guid = m[1];
        const data = await bunnyApiRequest(`/library/${libraryId}/videos/${guid}`, { extraHeaders: { AccessKey: apiKey } });
        const secs = data.length || null;
        if (secs) _durationCache.set(videoId, { durationSecs: secs, ts: Date.now() });
        return secs;
    } catch {
        return null;
    }
}

function formatDuration(secs) {
    if (!secs) return null;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
}

app.get('/api/public/video/:publicCode', async (req, res) => {
    try {
        const { publicCode } = req.params;
        if (!publicCode || !/^[A-Z]{2,4}-[0-9A-F]{8}-[0-9A-F]{4}$/.test(publicCode)) {
            return res.status(400).json({ error: 'Código inválido' });
        }
        const entry = await db.getCatalogByPublicCode(publicCode);
        if (!entry || entry.status !== 'ready') {
            return res.status(404).json({ error: 'Video no disponible' });
        }

        // Thumbnail: se sirve por NUESTRO proxy para no exponer el host/GUID de Bunny.
        let thumbnailUrl = null;
        if (entry.sourceType === 'bunny' && entry.bunnyUrl) {
            const base0 = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
            thumbnailUrl = `${base0}/api/public/video/${publicCode}/thumb`;
        }

        // Duración: consultar Bunny API con caché
        const durationSecs = await getBunnyDuration(entry.videoId, entry.bunnyUrl);

        const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
        const presentation = await require('./lib/producer-content').getPublicVideoPresentation(db, publicCode);
        res.json({
            title:        entry.title,
            thumbnailUrl: presentation?.coverUrl || thumbnailUrl,
            theme: presentation?.theme || 'dark',
            description: presentation?.description || '',
            duration:     formatDuration(durationSecs),
            coverUrl:     `${base}/cover/${publicCode}`,
            downloadUrl:  `${base}/download`,
            message:      'Este video está protegido contra copia. Para verlo, debe instalar Edulock Systems Player.',
        });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * GET /api/public/video/:publicCode/thumb
 * Proxy de la miniatura de Bunny. El navegador nunca ve el host/GUID real:
 * la imagen se descarga server-side y se reenvía. Sin auth (es solo la portada).
 */
app.get('/api/public/video/:publicCode/thumb', async (req, res) => {
    try {
        const { publicCode } = req.params;
        if (!publicCode || !/^[A-Z]{2,4}-[0-9A-F]{8}-[0-9A-F]{4}$/.test(publicCode)) {
            return res.status(400).end();
        }
        const entry = await db.getCatalogByPublicCode(publicCode);
        if (!entry || entry.status !== 'ready' || entry.sourceType !== 'bunny' || !entry.bunnyUrl) {
            return res.status(404).end();
        }
        const thumbReal = entry.bunnyUrl.replace(/\/playlist\.m3u8(\?.*)?$/, '/thumbnail.jpg');
        if (!isSafeBunnyUrl(thumbReal)) return res.status(400).end();
        const signed = await signCourseBunnyUrl(thumbReal, entry);

        const parsedUrl = new URL(signed);
        const mod = signed.startsWith('https') ? https : http;
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const upstream = mod.get(signed, { timeout: 15000, headers: { Referer: `${parsedUrl.protocol}//${parsedUrl.host}/` } }, (up) => {
            if (up.statusCode !== 200) { if (!res.headersSent) res.status(502).end(); up.resume(); return; }
            res.setHeader('Content-Type', up.headers['content-type'] || 'image/jpeg');
            up.pipe(res);
            up.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.end(); });
        });
        upstream.on('error', () => { if (!res.headersSent) res.status(502).end(); });
        upstream.on('timeout', () => { upstream.destroy(); if (!res.headersSent) res.status(504).end(); });
        res.on('close', () => upstream.destroy());
    } catch {
        if (!res.headersSent) res.status(500).end();
    }
});

/**
 * POST /api/public/video/:publicCode/launch
 * Genera un launchToken temporal (5 minutos). No requiere auth.
 */
app.post('/api/public/video/:publicCode/launch', async (req, res) => {
    try {
        const { publicCode } = req.params;
        if (!publicCode || !/^[A-Z]{2,4}-[0-9A-F]{8}-[0-9A-F]{4}$/.test(publicCode)) {
            return res.status(400).json({ error: 'Código inválido' });
        }
        const entry = await db.getCatalogByPublicCode(publicCode);
        if (!entry || entry.status !== 'ready') {
            return res.status(404).json({ error: 'Video no disponible' });
        }
        const permToken   = encryptPermToken(entry.videoId);
        const launchToken = crypto.randomBytes(22).toString('base64url');
        const expiresAt   = Date.now() + 5 * 60 * 1000;
        await db.createLaunchToken(launchToken, entry.videoId, expiresAt);
        const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
        res.json({
            launchToken,
            deepLink:    `edulock://play?p=${permToken}&lt=${encodeURIComponent(launchToken)}`,
            expiresIn:   300,
            downloadUrl: `${base}/download?video=${publicCode}`,
        });
        db.cleanExpiredLaunchTokens().catch(() => {});
    } catch (e) {
        console.error('[launch]', e.message);
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * GET /api/public/video/:publicCode/open
 * Redirect directo al protocolo edulock:// — funciona como navegación normal,
 * preservando el "user gesture" del clic del usuario en el navegador.
 * Chrome/Edge bloquean protocolos custom desde fetch+click asíncrono,
 * pero respetan redirects HTTP 302 hacia protocolos registrados.
 */
app.get('/api/public/video/:publicCode/open', async (req, res) => {
    try {
        const { publicCode } = req.params;
        if (!publicCode || !/^[A-Z]{2,4}-[0-9A-F]{8}-[0-9A-F]{4}$/.test(publicCode)) {
            return res.status(400).send('Código inválido');
        }
        const entry = await db.getCatalogByPublicCode(publicCode);
        if (!entry || entry.status !== 'ready') {
            return res.status(404).send('Video no disponible');
        }
        const permToken   = encryptPermToken(entry.videoId);
        const launchToken = crypto.randomBytes(22).toString('base64url');
        const expiresAt   = Date.now() + 5 * 60 * 1000;
        await db.createLaunchToken(launchToken, entry.videoId, expiresAt);
        const deepLink = `edulock://play?p=${permToken}&lt=${encodeURIComponent(launchToken)}`;
        res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<title>Abriendo reproductor…</title>
<style>body{background:#0d0d0d;color:#f5f5f5;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;gap:16px}
.open-btn{display:inline-block;padding:14px 32px;background:#c72b24;color:#fff;border-radius:8px;font-size:18px;font-weight:600;text-decoration:none;transition:background .2s}
.open-btn:hover{background:#a82520}
a{color:#c72b24}</style>
</head><body>
<p style="font-size:20px">Abriendo Edulock Systems Player…</p>
<a class="open-btn" href="${deepLink}">Abrir reproductor</a>
<p style="color:#9ca3af;font-size:14px">Si el reproductor no se abrió automáticamente, haz clic en el botón de arriba.</p>
<p><a href="/cover/${publicCode}">← Volver a la página del video</a></p>
<script>window.location.href="${deepLink}"</script>
</body></html>`);
        db.cleanExpiredLaunchTokens().catch(() => {});
    } catch (e) {
        console.error('[open-redirect]', e.message);
        res.status(500).send('Error interno');
    }
});

/**
 * POST /api/public/launch/checkin
 * El reproductor confirma que abrió el deep link (fire-and-forget desde main.js).
 */
app.post('/api/public/launch/checkin', async (req, res) => {
    try {
        const { launchToken } = req.body || {};
        if (!launchToken || typeof launchToken !== 'string') return res.status(400).json({ error: 'launchToken requerido' });
        const ok = await db.markLaunchTokenOpened(launchToken);
        res.json({ ok });
    } catch {
        res.status(500).json({ error: 'Error interno' });
    }
});

/**
 * GET /api/public/launch/status?lt=TOKEN
 * La página cover.html consulta si el reproductor ya abrió el enlace.
 */
app.get('/api/public/launch/status', async (req, res) => {
    try {
        const lt = req.query.lt;
        if (!lt || typeof lt !== 'string') return res.status(400).json({ error: 'lt requerido' });
        const row = await db.getLaunchToken(lt);
        if (!row) return res.json({ expired: true, opened: false });
        if (row.expires_at < Date.now()) return res.json({ expired: true, opened: !!row.opened });
        res.json({ expired: false, opened: !!row.opened });
    } catch {
        res.status(500).json({ error: 'Error interno' });
    }
});

// ================================================================
//  ARRANQUE
// ================================================================

// Inicializar base de datos PostgreSQL con reintentos y arrancar servidor
let dbReady = false;

async function initDbWithRetry(maxAttempts = Infinity, delayMs = 3000) {
    let attempt = 0;
    while (true) {
        attempt++;
        try {
            await db.initDb();
            dbReady = true;
            console.log('[db-pg] Tablas inicializadas correctamente');
            await refreshAllowedDomains();
            await loadStoredWatermarkConfig();
            return;
        } catch (err) {
            console.error(`[db-pg] Intento ${attempt} fallido: ${err.message} (code=${err.code})`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}

// Arrancar servidor inmediatamente y conectar DB en background
setInterval(async () => {
    if (dbReady) {
        await db.cleanExpiredSessions().catch(() => {});
        await db.cleanExpiredPlaybackSessions().catch(() => {});
        await db.cleanOldNonces().catch(() => {});
        refreshAllowedDomains();
    }
}, 60_000);

// ================================================================
//  LICENSE & ACTIVATION SYSTEM
// ================================================================

/**
 * POST /api/license/generate
 * [ADMIN] Genera una nueva clave de licencia para un alumno/curso.
 * Body: { studentId, courseId, maxDevices, expiresAt }
 * Returns: { licenseKey, licenseId }
 */
// ================================================================
//  MULTI-TENANCY: PRODUCTORES (clientes con panel propio)
//  Owner (tú, requireAdmin) los crea y fija cuotas. El productor entra a SU panel.
// ================================================================

// Middleware: exige JWT de productor (role='producer'). Valida que siga activo.
async function requireProducer(req, res, next) {
    if (!dbReady) return res.status(503).json({ error: 'Servidor iniciando' });
    const payload = verifyToken(req);
    if (!payload || payload.role !== 'producer' || !payload.producerId) {
        return res.status(403).json({ error: 'Acceso de productor requerido' });
    }
    try {
        const p = await db.getProducerById(payload.producerId);
        if (!p || !(p.active === 1 || p.active === true)) {
            return res.status(403).json({ error: 'Cuenta de productor suspendida', revoked: true });
        }
        if (Number(payload.authVersion || 0) !== Number(p.auth_version || 0)) {
            return res.status(401).json({ error: 'Tu sesión terminó. Vuelve a entrar.', revoked: true });
        }
        req.producer = p;
    } catch { return res.status(500).json({ error: 'Error validando productor' }); }
    req.user = payload;
    next();
}

// Middleware: permite admin O productor
async function requireAdminOrProducer(req, res, next) {
    const payload = verifyToken(req);
    if (!payload) return res.status(401).json({ error: 'Token inválido' });
    if (payload.admin) { req.user = payload; return next(); }
    if (payload.role !== 'producer' || !payload.producerId) return res.status(403).json({ error: 'Acceso denegado' });
    try {
        const p = await db.getProducerById(payload.producerId);
        if (!p || !(p.active === 1 || p.active === true)) return res.status(403).json({ error: 'Cuenta de productor suspendida', revoked: true });
        req.producer = p;
    } catch { return res.status(500).json({ error: 'Error validando productor' }); }
    req.user = payload;
    next();
}

// Central access check: admin=unlimited, producer=own scope, student=license scope
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

// Login del productor (su panel). Devuelve JWT con role='producer'.
app.post('/api/producer/login', authRateLimit, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Correo y contraseña requeridos' });
    const p = await db.getProducerByEmail(email);
    if (!p || !p.password_hash) return res.status(401).json({ error: 'Credenciales incorrectas' });
    let ok = false; try { ok = verifyPassword(password, p.password_hash); } catch { ok = false; }
    if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas' });
    if (!(p.active === 1 || p.active === true)) return res.status(403).json({ error: 'Cuenta suspendida. Contacta al administrador.' });
    db.touchProducerLogin(p.id);
    const token = jwt.sign(
        { sub: p.id, producerId: p.id, email: p.email, role: 'producer', label: p.name || p.email, authVersion: Number(p.auth_version || 0) },
        JWT_SECRET, { expiresIn: JWT_EXPIRES, issuer: 'reproductor-cursos' }
    );
    res.json({ token, expiresIn: JWT_EXPIRES, name: p.name || '', email: p.email,
               quotas: { maxLicenses: p.max_licenses, maxDevices: p.max_devices, maxStudents: p.max_students } });
});

// ── Owner: gestión de productores ────────────────────────────────────────────
/** POST /api/owner/producers — crea un productor y devuelve su contraseña UNA vez. */
app.post('/api/owner/producers', requireAdmin, async (req, res) => {
    const { email, name, maxLicenses = 100, maxDevices = 2, maxStudents = 0, notes } = req.body || {};
    let quotas;
    try { quotas = db.normalizeProducerQuotas({ maxLicenses, maxDevices, maxStudents }, { defaults: true }); }
    catch (error) { return res.status(400).json({ error: error.message, code: error.code }); }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
        return res.status(400).json({ error: 'Correo válido requerido' });
    }
    if (await db.getProducerByEmail(email)) return res.status(409).json({ error: 'Ya existe un productor con ese correo' });
    // Contraseña legible generada automáticamente (se muestra 1 vez).
    const password = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) + '9';
    const id = uuidv4();
    await db.createProducer({ id, email, passwordHash: hashPassword(password), name,
        ...quotas, notes });
    res.json({ ok: true, id, email: String(email).toLowerCase().trim(), password,
        loginUrl: `${getPublicBase(req)}/productor`,
        note: 'Entrega este correo y contraseña al cliente. La contraseña no se puede recuperar después.' });
});

/** GET /api/owner/producers — lista con uso (licencias/alumnos). */
app.get('/api/owner/producers', requireAdmin, async (_req, res) => {
    try {
        const rows = await db.listProducers();
        res.json({ producers: rows.map(p => ({
            id: p.id, email: p.email, name: p.name, active: p.active === 1 || p.active === true,
            maxLicenses: p.max_licenses, maxDevices: p.max_devices, maxStudents: p.max_students,
            licensesUsed: parseInt(p.licenses_used, 10) || 0, studentsCount: parseInt(p.students_count, 10) || 0,
            createdAt: p.created_at, lastLogin: p.last_login, notes: p.notes,
        })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/** PUT /api/owner/producers/:id — cuotas / activar-suspender / renombrar / resetear clave. */
app.put('/api/owner/producers/:id', requireAdmin, async (req, res) => {
    const { name, active, maxLicenses, maxDevices, maxStudents, notes, resetPassword } = req.body || {};
    let quotas;
    try { quotas = db.normalizeProducerQuotas({ maxLicenses, maxDevices, maxStudents }); }
    catch (error) { return res.status(400).json({ error: error.message, code: error.code }); }
    const fields = {};
    if (name !== undefined)        fields.name = String(name).slice(0, 120);
    if (active !== undefined)      fields.active = active ? 1 : 0;
    if (quotas.maxLicenses !== undefined) fields.max_licenses = quotas.maxLicenses;
    if (quotas.maxDevices !== undefined)  fields.max_devices = quotas.maxDevices;
    if (quotas.maxStudents !== undefined) fields.max_students = quotas.maxStudents;
    if (notes !== undefined)       fields.notes = String(notes).slice(0, 500);
    let newPassword = null;
    if (resetPassword) {
        newPassword = crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) + '9';
        fields.password_hash = hashPassword(newPassword);
    }
    await db.updateProducer(req.params.id, fields);
    res.json({ ok: true, ...(newPassword ? { newPassword } : {}) });
});

/** DELETE /api/owner/producers/:id */
app.delete('/api/owner/producers/:id', requireAdmin, async (req, res) => {
    await db.deleteProducer(req.params.id);
    res.json({ ok: true });
});

// ================================================================
//  PANEL DEL PRODUCTOR (cliente) — TODO aislado a su producer_id
// ================================================================

/** GET /api/producer/me — perfil + cuotas + uso (encabezado del panel). */
app.get('/api/producer/me', requireProducer, async (req, res) => {
    const p = req.producer;
    const used = await db.countProducerLicenses(p.id).catch(() => 0);
    res.json({
        id: p.id, email: p.email, name: p.name || '',
        quotas: { maxLicenses: p.max_licenses, maxDevices: p.max_devices, maxStudents: p.max_students },
        usage:  { licensesUsed: used },
    });
});

/** GET /api/producer/videos — SUS videos. */
app.get('/api/producer/videos', requireProducer, async (req, res) => {
    try {
        const rows = await db.getCatalogByProducer(req.producer.id);
        res.json({ videos: rows.map(r => ({
            videoId: r.video_id, title: r.title, status: r.status,
            sourceType: r.source_type, publicCode: r.public_code || null, createdAt: r.uploaded_at,
        })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/producer/upload — sube video → .edu en Bunny bajo el prefijo del productor. */
app.post('/api/producer/upload', requireProducer, upload.single('video'), async (req, res) => {
    const cleanup = () => { try { if (req.file) fs.unlinkSync(req.file.path); } catch {} };
    try {
        if (!EDU_MASTER_KEY || EDU_MASTER_KEY.length < 32) { cleanup(); return res.status(500).json({ error: 'Servidor sin EDU_MASTER_KEY' }); }
        if (!req.file) return res.status(400).json({ error: 'Archivo de video requerido' });
        const { zone, key, host, pull } = await getBunnyStorageConfig();
        if (!zone || !key) { cleanup(); return res.status(400).json({ error: 'La plataforma aún no tiene Bunny Storage configurado. Contacta al administrador.' }); }

        const pid       = req.producer.id;
        const title     = ((req.body && req.body.title) || req.file.originalname || 'Video').slice(0, 120);
        const videoId   = uuidv4();
        const contentId = 'edu-' + pid.slice(0, 8) + '-' + uuidv4().slice(0, 8);

        const mp4 = fs.readFileSync(req.file.path);
        const { packEdu } = require('./edu-packer');
        const { edu, salt } = packEdu(mp4, { contentId, title, masterKeyHex: EDU_MASTER_KEY });

        const pathInZone = `edu/${pid}/${contentId}.edu`;   // aislamiento por productor en Bunny
        await bunnyStoragePut(host, zone, key, pathInZone, edu);
        const bunnyUrl = pull ? `${pull}/${pathInZone}` : `https://${host}/${zone}/${pathInZone}`;

        await db.registerEduContent({ contentId, salt, bunnyUrl, title, watermark: 'buyer:{ID_COMPRADOR}', flags: 3, videoId, producerId: pid });
        await addToCatalog({ videoId, title, status: 'ready', sourceType: 'edu', uploadedAt: new Date().toISOString(), producerId: pid });

        cleanup();
        res.json({ ok: true, videoId, contentId, bytes: edu.length });
    } catch (e) { cleanup(); console.error('[producer/upload]', e.message); res.status(500).json({ error: e.message }); }
});

/** POST /api/producer/video/:videoId/sublink — genera el sublink de SU video. */
app.post('/api/producer/video/:videoId/sublink', requireProducer, async (req, res) => {
    const { videoId } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(videoId)) return res.status(400).json({ error: 'videoId inválido' });
    const entry = await db.getCatalogById(videoId);
    if (!entry || entry.producerId !== req.producer.id) return res.status(403).json({ error: 'Ese video no te pertenece' });
    const code = await db.getOrCreatePublicCode(videoId, generatePublicCode(videoId));
    res.json({ publicCode: code, sublink: `${getPublicBase(req)}/cover/${code}` });
});

/** POST /api/producer/license/generate-bulk — genera seriales dentro de SU cuota. */
app.post('/api/producer/license/generate-bulk', requireProducer, async (req, res) => {
    const p = req.producer;
    const { quantity, notes = null, courseId } = req.body || {};
    if (!courseId) return res.status(400).json({ error: 'Selecciona el curso de estas licencias.' });
    try { await ownedStreamCourse(courseId, { producerId: p.id }); }
    catch (e) { return streamError(res, e); }
    const qty = typeof quantity === 'number' || (typeof quantity === 'string' && /^\d+$/.test(quantity)) ? Number(quantity) : NaN;
    if (!Number.isInteger(qty) || qty < 1 || qty > 5000) return res.status(400).json({ error: 'Cantidad inválida (1-5000)' });

    // Las licencias de curso son permanentes: ninguna petición puede introducir caducidad.
    if ((req.body.expiresAt != null && req.body.expiresAt !== '') || (req.body.durationDays != null && req.body.durationDays !== '')) {
        return res.status(400).json({ error: 'Las licencias de curso no tienen vencimiento.', code: 'LICENSE_EXPIRY_UNSUPPORTED' });
    }
    // Dispositivos por licencia: solo el administrador define el tope; el productor no lo modifica.
    let maxDevices;
    try { maxDevices = db.normalizeProducerQuotas({ maxDevices: p.max_devices }).maxDevices; }
    catch (e) { return streamError(res, e); }
    if (req.body.maxDevices !== undefined && Number(req.body.maxDevices) !== maxDevices) {
        return res.status(403).json({ error: 'Solo el administrador modifica el límite de dispositivos.', code: 'DEVICE_LIMIT_ADMIN_ONLY' });
    }

    // Generar claves y guardarlas de forma ATÓMICA (cuota sin condición de carrera).
    const lotId = uuidv4();
    const keys = [], licenses = [];
    for (let i = 0; i < qty; i++) {
        const { key, hash } = genLicenseKey();
        keys.push(key);
        licenses.push({ id: uuidv4(), hash, key });
    }
    let r;
    try {
        r = await db.createProducerLotAtomic({
            producerId: p.id, maxLicenses: p.max_licenses,
            lot: { id: lotId, courseId, name: req.body.name, notes, createdBy: p.email, maxDevices }, licenses,
        });
    } catch (e) { return streamError(res, e); }
    if (!r.ok) {
        return res.status(403).json({
            error: `Cuota excedida: usadas ${r.used} de ${r.limit}. Puedes generar ${Math.max(0, r.limit - r.used)} más.`,
            code: 'QUOTA_EXCEEDED',
        });
    }
    res.json({ lotId, quantity: qty, maxDevices, keys, note: 'Las claves quedan guardadas y puedes copiarlas desde Licencias y lotes.' });
});

/** GET /api/producer/licenses — SUS lotes/licencias. */
app.get('/api/producer/licenses', requireProducer, async (req, res) => {
    try { res.json({ lots: await db.getLotsByProducer(req.producer.id) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

/** Individual licenses, without hashes or activation credentials. */
app.get('/api/producer/licenses/items', requireProducer, async (req, res) => {
    const rawPage = req.query.page === undefined ? '1' : req.query.page;
    const page = typeof rawPage === 'string' && /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
    const pageSize = 50, offset = (page - 1) * pageSize;
    if (!Number.isInteger(page) || page < 1 || offset > 2147483647) return res.status(400).json({ error: 'Página inválida.' });
    const lotId = req.query.lotId || null;
    if (lotId !== null && (typeof lotId !== 'string' || !/^[0-9a-f-]{36}$/i.test(lotId))) return res.status(400).json({ error: 'Lote inválido.' });
    try {
        const result = await db.getProducerLicenseItems({ producerId: req.producer.id, lotId, limit: pageSize, offset });
        res.json({ page, pageSize, total: result.total, licenses: result.rows.map(l => ({
            id: l.id, lotId: l.lot_id, courseId: l.course_id, courseName: l.course_name || '',
            status: l.status, effectiveStatus: l.status,
            maxDevices: l.max_devices, createdAt: l.created_at, assignedAt: l.assigned_at,
            revokedAt: l.revoked_at, customerEmail: l.customer_email || null,
            activationCount: Number(l.activation_count) || 0, activeActivations: Number(l.active_activations) || 0
        })) });
    } catch (e) { return streamError(res, e); }
});

app.post('/api/producer/licenses/:licenseId/revoke', requireProducer, async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.licenseId || '')) return res.status(400).json({ error: 'Licencia inválida.' });
    try { res.json({ ok: true, ...await db.revokeProducerLicense({ producerId: req.producer.id, licenseId: req.params.licenseId }) }); }
    catch (e) { return streamError(res, e); }
});

/** GET /api/producer/activations — quién activó/usa SUS seriales (control de uso). */
app.get('/api/producer/activations', requireProducer, async (req, res) => {
    try {
        const rows = await db.getProducerActivations(req.producer.id);
        res.json({ activations: rows.map(a => ({
            device: (a.device_id || '').slice(0, 16), customerEmail: a.customer_email || null,
            status: a.status, activatedAt: a.created_at, lastUsed: a.last_used_at,
        })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/license/generate', requireAdminOrProducer, async (req, res) => {
    const { studentId, courseId } = req.body || {};
    if (req.body?.expiresAt != null && req.body.expiresAt !== '' || req.body?.durationDays != null && req.body.durationDays !== '') {
        return res.status(400).json({ error: 'Las licencias de curso no tienen vencimiento.', code: 'LICENSE_EXPIRY_UNSUPPORTED' });
    }
    let maxDevices = parseInt(req.body?.maxDevices, 10) || 2;

    // studentId is now optional — unbound licenses can be generated without a student
    if (studentId) {
        const student = await db.findStudentById(studentId);
        if (!student) return res.status(404).json({ error: 'Alumno no encontrado' });
    }

    // Producer can only generate for their assigned courses
    const producerId = req.user.producerId || null;
    if (producerId && courseId) {
        const producerCourses = await db.getCoursesByProducer(producerId).catch(() => []);
        if (!producerCourses.some(c => c.id === courseId)) {
            return res.status(403).json({ error: 'No tienes acceso a este curso' });
        }
    }
    if (producerId) {
        // Solo el administrador define el límite de dispositivos de un productor.
        const producer = await db.getProducerById(producerId).catch(() => null);
        if (!producer) return res.status(403).json({ error: 'Productor no disponible.' });
        if (req.body?.maxDevices !== undefined && Number(req.body.maxDevices) !== Number(producer.max_devices)) {
            return res.status(403).json({ error: 'Solo el administrador modifica el límite de dispositivos.', code: 'DEVICE_LIMIT_ADMIN_ONLY' });
        }
        maxDevices = Number(producer.max_devices) || 1;
    }

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let rawKey = '';
    const rndBuf = crypto.randomBytes(16);
    for (let i = 0; i < 16; i++) rawKey += chars[rndBuf[i] % chars.length];
    const licenseKey = `${rawKey.slice(0,4)}-${rawKey.slice(4,8)}-${rawKey.slice(8,12)}-${rawKey.slice(12,16)}`;

    const licenseKeyHash = crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret')
        .update(licenseKey).digest('hex');
    const licenseId = uuidv4();

    await db.createLicense({
        id: licenseId,
        licenseKeyHash,
        studentId: studentId || null,
        courseId: courseId || null,
        maxDevices,
        expiresAt: null,
        producerId,
    });

    res.json({ licenseKey, licenseId, studentId: studentId || null, courseId: courseId || null, maxDevices });
});

// ================================================================
//  LOTES DE SERIALES + VENTA AUTOMATIZADA (PDF Mejoras 3, 4 y 5)
// ================================================================

// Genera una clave legible XXXX-XXXX-XXXX-XXXX (base32 sin ambigüos) y su hash.
function genLicenseKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let raw = '';
    const buf = crypto.randomBytes(16);
    for (let i = 0; i < 16; i++) raw += chars[buf[i] % chars.length];
    const key = `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}`;
    const hash = crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret').update(key).digest('hex');
    return { key, hash };
}

/**
 * POST /api/license/generate-bulk  [ADMIN]
 * Crea un lote de N seriales LIBRES de un curso, listos para vender/repartir.
 * Body: { courseId?, quantity, maxDevices?, expiresAt?, notes? }
 * Devuelve los seriales en claro UNA sola vez (se guardan hasheados) → exporta a CSV.
 */
app.post('/api/license/generate-bulk', requireAdmin, async (req, res) => {
    const { courseId = null, quantity, maxDevices = 2, notes = null } = req.body || {};
    if (req.body?.expiresAt != null && req.body.expiresAt !== '' || req.body?.durationDays != null && req.body.durationDays !== '') {
        return res.status(400).json({ error: 'Las licencias de curso no tienen vencimiento.', code: 'LICENSE_EXPIRY_UNSUPPORTED' });
    }
    if (!courseId) return res.status(400).json({ error: 'Selecciona el curso de estas licencias.' });
    const licenseCourse = await db.getCourseById(courseId);
    if (!licenseCourse) return res.status(404).json({ error: 'Curso no encontrado.' });
    if (licenseCourse.producerId) return res.status(403).json({ error: 'Genera las licencias de este curso desde la cuenta de su productor para respetar su cuota.' });
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty < 1 || qty > 5000) {
        return res.status(400).json({ error: 'quantity debe estar entre 1 y 5000' });
    }
    const lotId = uuidv4();
    await db.createLot({ id: lotId, courseId, quantity: qty, notes, createdBy: req.user?.username || 'admin' });

    const keys = [];
    for (let i = 0; i < qty; i++) {
        const { key, hash } = genLicenseKey();
        const licenseId = uuidv4();
        await db.createFreeLicense({
            id: licenseId, licenseKeyHash: hash, courseId, lotId,
            maxDevices: parseInt(maxDevices, 10) || 2, expiresAt: null,
        });
        keys.push(key);
    }
    res.json({ lotId, courseId, quantity: qty, keys,
               note: 'Guarda estos seriales ahora: se almacenan hasheados y no se pueden recuperar después.' });
});

/** GET /api/license/lots  [ADMIN] — resumen de lotes (total / libres / usados). */
app.get('/api/license/lots', requireAdmin, async (_req, res) => {
    try { res.json({ lots: await db.getLots() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/license/lots/:id/licenses  [ADMIN] — licencias de un lote (sin la clave en claro). */
app.get('/api/license/lots/:id/licenses', requireAdmin, async (req, res) => {
    try {
        const rows = await db.getLicensesByLot(req.params.id);
        res.json({ licenses: rows.map(r => ({
            id: r.id, status: r.status, studentId: r.student_id, customerEmail: r.customer_email,
            orderId: r.order_id, maxDevices: r.max_devices, createdAt: r.created_at,
            assignedAt: r.assigned_at,
        })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/admin/licenses/:id/status  [ADMIN]
 * Máquina de estados: body { status: 'suspended'|'active'|'revoked' }.
 */
app.post('/api/admin/licenses/:id/status', requireAdmin, async (req, res) => {
    const { status } = req.body || {};
    if (!['suspended', 'active', 'revoked'].includes(status)) {
        return res.status(400).json({ error: "status debe ser 'suspended', 'active' o 'revoked'" });
    }
    const r = await db.setLicenseStatus(req.params.id, status, req.user?.username || 'admin');
    if (!r.ok) return res.status(409).json(r);
    res.json(r);
});

// ── Claves de integración de ventas (admin) ──────────────────────────────────
/** POST /api/admin/integration-keys  [ADMIN] — crea una API key (se muestra 1 vez). */
app.post('/api/admin/integration-keys', requireAdmin, async (req, res) => {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name requerido' });
    const apiKey = 'edk_' + crypto.randomBytes(24).toString('base64url');
    const keyHash = crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret').update(apiKey).digest('hex');
    const id = uuidv4();
    await db.createIntegrationKey({ id, name: name.slice(0, 80), keyHash, scopes: 'claim-license' });
    res.json({ id, name, apiKey, note: 'Guarda esta clave ahora: no se puede recuperar después.' });
});

/** GET /api/admin/integration-keys  [ADMIN] */
app.get('/api/admin/integration-keys', requireAdmin, async (_req, res) => {
    res.json({ keys: await db.listIntegrationKeys() });
});

/** DELETE /api/admin/integration-keys/:id  [ADMIN] */
app.delete('/api/admin/integration-keys/:id', requireAdmin, async (req, res) => {
    await db.revokeIntegrationKey(req.params.id);
    res.json({ ok: true });
});

// Middleware: valida la API key de integración (header x-api-key). Permisos mínimos.
async function requireIntegrationKey(req, res, next) {
    if (!dbReady) return res.status(503).json({ error: 'Servidor iniciando' });
    const apiKey = req.headers['x-api-key'] || '';
    if (!apiKey) return res.status(401).json({ error: 'x-api-key requerido' });
    const keyHash = crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret').update(apiKey).digest('hex');
    const row = await db.getIntegrationKeyByHash(keyHash);
    if (!row) return res.status(401).json({ error: 'API key inválida' });
    if (row.producer_id) {
        const producer = await db.getProducerById(row.producer_id);
        if (!producer || Number(producer.active) !== 1) return res.status(403).json({ error: 'Productor no disponible.' });
    }
    if (!String(row.scopes || '').split(/[ ,]+/).includes('claim-license')) return res.status(403).json({ error: 'La clave no permite asignar licencias.' });
    db.touchIntegrationKey(row.id);
    req.integration = row;
    next();
}

/**
 * POST /api/integrations/claim-license   [API KEY de integración]
 * La tienda (Hotmart/WooCommerce/etc.) reclama un serial libre al vender.
 * Body: { courseId, customerEmail, orderId }
 * Devuelve la asignación idempotente y el serial cuando la bóveda del productor
 * lo conserva. Un pedido vencido no asigna otra clave ni se presenta como activo.
 */
const integrationRateLimit = require('./lib/integration-rate-limit').createIntegrationRateLimit({
    max: Number(process.env.INTEGRATION_RL_MAX || 120),
    windowMs: Number(process.env.INTEGRATION_RL_WINDOW_MS || 60000)
});
app.post('/api/integrations/claim-license', requireIntegrationKey, integrationRateLimit, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { courseId = null, customerEmail = null, orderId = null } = req.body || {};
    if (!courseId || !customerEmail || !orderId) return res.status(400).json({ error: 'courseId, customerEmail y orderId requeridos' });
    try {
        const student = await db.findStudentByEmail(String(customerEmail).trim().toLowerCase());
        if (!student) return res.status(409).json({ error: 'El comprador debe registrarse antes de asignar su licencia.', code: 'STUDENT_REQUIRED' });
        const lic = await db.claimFreeLicense({ courseId, customerEmail, orderId, studentId: student.id, producerId: req.integration?.producer_id || null });
        if (!lic) return res.status(409).json({ error: 'No quedan seriales libres para ese curso', code: 'NO_FREE_LICENSES' });
        if (lic.status === 'expired') {
            return res.status(409).json({ error: 'La licencia de este pedido está vencida. Revisa su vigencia desde el panel.', code: 'LICENSE_EXPIRED', status: 'expired', licenseId: lic.id });
        }
        if (lic.status !== 'active') return res.status(409).json({ error: 'La licencia del pedido no está activa.', code: 'LICENSE_NOT_ACTIVE' });
        const licenseKey = req.integration?.producer_id
            ? await producerLicenseWorkspace.readLicenseSerial({ producerId: req.integration.producer_id, licenseId: lic.id }) : null;
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, licenseId: lic.id, courseId: lic.course_id, status: lic.status, customerEmail, orderId,
            ...(licenseKey ? { licenseKey } : { serialAvailable: false }) });
    } catch (e) {
        console.error('[claim-license]', e.message);
        streamError(res, e);
    }
});

// ================================================================
//  DRM PROPIO (.edu) — registro, entrega de clave ONLINE y datos (guía DRM)
//  Modelo: el .edu cifrado vive en Bunny; la clave (CEK) se deriva del
//  MASTER_KEY y se entrega por sesión validando licencia. La CEK nunca se
//  almacena ni viaja dentro del reproductor.
// ================================================================

/** POST /api/edu/register  [ADMIN] — registra un .edu ya empaquetado y subido a Bunny. */
app.post('/api/edu/register', requireAdmin, async (req, res) => {
    const { contentId, salt, bunnyUrl, title, watermark, flags, courseId, videoId } = req.body || {};
    if (!contentId || !salt) return res.status(400).json({ error: 'contentId y salt requeridos' });
    if (!/^[0-9a-f]{32}$/i.test(salt)) return res.status(400).json({ error: 'salt inválido (16 bytes hex)' });
    if (bunnyUrl && !isSafeBunnyUrl(bunnyUrl)) return res.status(400).json({ error: 'bunnyUrl no es de Bunny' });
    await db.registerEduContent({ contentId, salt, bunnyUrl, title, watermark,
        flags: parseInt(flags, 10) || 0, courseId: courseId || null, videoId: videoId || null });
    res.json({ ok: true, contentId });
});

// ── Config de Bunny STORAGE (para subir los .edu) ─────────────────────────────
app.get('/api/bunny/storage-config', requireAdmin, async (_req, res) => {
    const { zone, key, host, pull } = await getBunnyStorageConfig();
    // Widevine L1 (PREPARADO, inactivo — ver drm-edu/WIDEVINE_L1.md).
    const drmEnabled = (await db.getConfig('bunny_drm_enabled')) === 'true';
    const drmLicenseUrl = (await db.getConfig('bunny_drm_license_url')) || '';
    res.json({ configured: !!(zone && key), zone, host, pull, hasKey: !!key, drmEnabled, drmLicenseUrl });
});
app.post('/api/bunny/storage-config', requireAdmin, async (req, res) => {
    const { zone, key, host, pull, drmEnabled, drmLicenseUrl } = req.body || {};
    if (zone !== undefined) await db.setConfig('bunny_storage_zone', String(zone || '').trim());
    if (key)                await db.setConfig('bunny_storage_key',  String(key).trim());
    if (host !== undefined) await db.setConfig('bunny_storage_host', String(host || 'storage.bunnycdn.com').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''));
    if (pull !== undefined) await db.setConfig('bunny_pull_base',    String(pull || '').trim().replace(/\/+$/, ''));
    // Widevine L1 (se guarda para el futuro; hoy no cambia el flujo de reproducción).
    if (drmEnabled !== undefined)    await db.setConfig('bunny_drm_enabled', drmEnabled ? 'true' : 'false');
    if (drmLicenseUrl !== undefined) await db.setConfig('bunny_drm_license_url', String(drmLicenseUrl || '').trim());
    res.json({ ok: true });
});

/**
 * POST /api/edu/upload  [ADMIN] — SUBIR y auto-convertir a .edu (modelo InfoProtector).
 * multipart: video (archivo) + { contentId?, videoId?, courseId?, title? }
 * El servidor empaqueta el mp4 a .edu, lo sube a TU Bunny Storage y lo registra.
 */
app.post('/api/edu/upload', requireAdmin, upload.single('video'), async (req, res) => {
    const cleanup = () => { try { if (req.file) fs.unlinkSync(req.file.path); } catch {} };
    try {
        if (!EDU_MASTER_KEY || EDU_MASTER_KEY.length < 32) { cleanup(); return res.status(500).json({ error: 'EDU_MASTER_KEY no configurada en el servidor' }); }
        if (!req.file) return res.status(400).json({ error: 'Archivo de video requerido' });
        const { zone, key, host, pull } = await getBunnyStorageConfig();
        if (!zone || !key) { cleanup(); return res.status(400).json({ error: 'Configura tu Bunny Storage primero (panel → Bunny Storage).' }); }

        const title     = ((req.body && req.body.title) || req.file.originalname || 'Video').slice(0, 120);
        const courseId  = (req.body && req.body.courseId) || null;
        const videoId   = (req.body && req.body.videoId) || uuidv4();
        const contentId = ((req.body && req.body.contentId) || ('edu-' + uuidv4().slice(0, 8)))
            .toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 60);

        // 1) Empaquetar a .edu (cifrado, derivando la CEK del MASTER_KEY del servidor).
        const mp4 = fs.readFileSync(req.file.path);
        const { packEdu } = require('./edu-packer');
        const { edu, salt } = packEdu(mp4, { contentId, title, masterKeyHex: EDU_MASTER_KEY });

        // 2) Subir el .edu a TU Bunny Storage.
        const pathInZone = `edu/${contentId}.edu`;
        await bunnyStoragePut(host, zone, key, pathInZone, edu);

        // 3) URL de descarga: pull zone público si está configurado, si no la Storage API (proxy con AccessKey).
        const bunnyUrl = pull ? `${pull}/${pathInZone}` : `https://${host}/${zone}/${pathInZone}`;

        // 4) Registrar el contenido protegido (y crear/asociar entrada de catálogo).
        await db.registerEduContent({ contentId, salt, bunnyUrl, title,
            watermark: 'buyer:{ID_COMPRADOR}', flags: 3, courseId, videoId });
        try {
            await addToCatalog({ videoId, title, status: 'ready', sourceType: 'edu',
                courseId: courseId || null, uploadedAt: new Date().toISOString(), segmentCount: 0 });
        } catch (_) { /* si el catálogo ya lo tiene, ignorar */ }

        cleanup();
        res.json({ ok: true, contentId, videoId, courseId, bytes: edu.length, bunnyUrl });
    } catch (e) {
        cleanup();
        console.error('[edu/upload]', e.message);
        res.status(500).json({ error: e.message || 'Error al subir/convertir el video' });
    }
});

/** GET /api/edu/list  [ADMIN] */
app.get('/api/edu/list', requireAdmin, async (_req, res) => {
    res.json({ items: await db.listEduContent() });
});

/** DELETE /api/edu/:contentId  [ADMIN] */
app.delete('/api/edu/:contentId', requireAdmin, async (req, res) => {
    await db.deleteEduContent(req.params.contentId);
    res.json({ ok: true });
});

// ================================================================
//  BUNNY STREAM — subida directa desde el panel (con estado en vivo)
// ================================================================

/**
 * POST /api/stream/upload  [ADMIN]  multipart: video + { courseId, moduleId?, title? }
 * Sube el mp4 directo a Bunny Stream, dentro de la biblioteca del curso y la
 * colección del módulo (las crea si faltan). Lo deja en el catálogo en estado
 * 'processing'; el panel consulta /api/stream/status para el avance en vivo.
 */
function streamError(res,e) {
    const status=e.statusCode || e.status || 503;
    const body={error:e.message || 'No se pudo completar la operación',code:e.code,retryable:e.retryable===true};
    if(e.stage){body.stage=e.stage;body.stageLabel=(typeof STREAM_STAGES==='object'&&STREAM_STAGES[e.stage])||e.stage;}
    // Solo rechazos de validación (4xx) del proveedor: ErrorKey/Message cortos, nunca cuerpos ni claves.
    if(e.provider&&Number(e.httpStatus)>=400&&Number(e.httpStatus)<500)body.provider={status:e.httpStatus,errorKey:e.provider.errorKey||null,message:e.provider.message||null};
    res.status(status).json(body);
}
async function createStreamCourse(body={},actor) {
    if(typeof body.name!=='string'||!body.name.trim()) throw Object.assign(new Error('Nombre del curso requerido'),{statusCode:400});
    const description=typeof body.description==='string'?body.description.trim().slice(0,2000):'';
    const course=await db.createCourse({id:body.id||uuidv4(),name:body.name.trim().slice(0,120),author:String(body.author||'').trim().slice(0,100),producerId:actor.producerId||null});
    // Descripción breve: mismo dato que edita Configuración (settings.description). Un fallo aquí no crea otro curso.
    if(description&&actor.producerId){
        try { await producerContentService.updateCourse(actor.producerId,course.id,{settings:{description}}); course.description=description; }
        catch(e){ course.settingsWarning='La descripción no se guardó: '+e.message+'. Puedes escribirla desde Configuración.'; }
    }
    try {
        const lib=await streamService.ensureCourseLibrary({courseId:course.id,actor});
        course.bunnyLibraryId=lib.libraryId; course.bunnyPullZone=lib.pullZone;
    } catch(e) { course.bunnyWarning=e.message; course.provisioningWarning=e.message; }
    return course;
}
async function createStreamModule(courseId,body={},actor) {
    await ownedStreamCourse(courseId,actor);
    if(typeof body.name!=='string'||!body.name.trim()) throw Object.assign(new Error('Nombre del módulo requerido'),{statusCode:400});
    // Sin sortOrder el módulo se coloca al final de sus hermanos; el orden se cambia arrastrando.
    const mod=await db.createModule({id:body.id||uuidv4(),courseId,parentId:body.parentId||null,name:body.name.trim().slice(0,120),sortOrder:body.sortOrder==null||body.sortOrder===''?undefined:Number(body.sortOrder)||0,producerId:actor.producerId||null});
    try { mod.bunnyCollectionId=await streamService.ensureModuleCollection({courseId,moduleId:mod.id,actor}); }
    catch(e) {mod.bunnyWarning=e.message;mod.provisioningWarning=e.message;}
    return mod;
}
async function ownedStreamCourse(id,actor) {
    const c=await db.getCourseById(id);
    if(!c || (!actor.admin && c.producerId!==actor.producerId)) throw Object.assign(new Error('Curso no encontrado'),{statusCode:404});
    return c;
}
const streamActor=req=>req.producer?{producerId:req.producer.id}:{admin:true};
async function receiveStreamUpload(req,res) {
    try {
        if(!req.file) return res.status(400).json({error:'Archivo de video requerido'});
        const result=await streamService.uploadVideo({filePath:req.file.path,title:String(req.body.title||req.file.originalname||'Video').slice(0,200),courseId:req.body.courseId,moduleId:req.body.moduleId||null,operationId:req.body.operationId,actor:streamActor(req)});
        res.json({ok:true,...result});
    } catch(e) {streamError(res,e);}
    finally {if(req.file) await fs.promises.unlink(req.file.path).catch(()=>{});}
}
async function streamStatus(req,res) {
    try {res.json(await streamService.getVideoStatus({videoId:req.params.videoId,actor:streamActor(req)}));}
    catch(e) {streamError(res,e);}
}
async function streamOperation(req,res) {
    try {res.json(await streamService.getOperationStatus({operationId:req.params.operationId,actor:streamActor(req)}));}
    catch(e) {streamError(res,e);}
}
app.post('/api/stream/upload',requireAdmin,upload.single('video'),receiveStreamUpload);
app.get('/api/stream/status/:videoId',requireAdmin,streamStatus);
app.get('/api/stream/operations/:operationId',requireAdmin,streamOperation);
app.get('/api/producer/courses',requireProducer,async(req,res)=>{
    try {res.json({courses:await db.getCoursesByProducer(req.producer.id)});} catch(e){streamError(res,e);}
});
app.post('/api/producer/courses',requireProducer,async(req,res)=>{
    try {const course=await createStreamCourse(req.body,streamActor(req));res.status(201).json({course,warning:course.bunnyWarning});}catch(e){streamError(res,e);}
});
app.get('/api/producer/courses/:courseId/modules',requireProducer,async(req,res)=>{
    try {await ownedStreamCourse(req.params.courseId,streamActor(req));res.json({modules:await db.getModulesByCourse(req.params.courseId)});}catch(e){streamError(res,e);}
});
app.post('/api/producer/courses/:courseId/modules',requireProducer,async(req,res)=>{
    try {const mod=await createStreamModule(req.params.courseId,req.body,streamActor(req));res.status(201).json({module:mod,warning:mod.bunnyWarning});}catch(e){streamError(res,e);}
});
async function repairStreamModuleCollection(req,res) {
    try {
        await ownedStreamCourse(req.params.courseId,streamActor(req));
        const collectionId=await streamService.ensureModuleCollection({courseId:req.params.courseId,moduleId:req.params.moduleId,actor:streamActor(req)});
        res.json({ok:true,moduleId:req.params.moduleId,collectionId});
    } catch(e) {streamError(res,e);}
}
app.post('/api/producer/courses/:courseId/modules/:moduleId/collection',requireProducer,repairStreamModuleCollection);
app.post('/api/stream/courses/:courseId/modules/:moduleId/collection',requireAdmin,repairStreamModuleCollection);
app.post('/api/producer/stream/upload',requireProducer,upload.single('video'),receiveStreamUpload);
app.get('/api/producer/stream/status/:videoId',requireProducer,streamStatus);
app.get('/api/producer/stream/operations/:operationId',requireProducer,streamOperation);
let streamReconciling=false, collectionReconcileAt=0;
const streamReconcileTimer=setInterval(async()=>{
    if(!dbReady||streamReconciling)return;
    streamReconciling=true;
    try {
        await streamService.reconcilePending({limit:20});
        // Cada 10 minutos: módulos de cualquier productor guardados sin colección.
        if(Date.now()-collectionReconcileAt>10*60*1000){collectionReconcileAt=Date.now();await streamService.reconcileCollections({limit:20});}
        // Clases movidas de módulo cuya colección de Bunny no se pudo actualizar en el momento.
        await streamService.reconcileVideoCollections({limit:20});
    } catch(e){console.warn('[stream/reconcile]',e.message);}finally{streamReconciling=false;}
},15000);
streamReconcileTimer.unref();
process.once('SIGTERM',()=>{
    clearInterval(streamReconcileTimer);
    streamService.stop();
    httpServer.close(()=>db.pool.end().finally(()=>process.exit(0)));
    setTimeout(()=>process.exit(0),5000).unref();
});


/**
 * POST /api/edu/key   [ALUMNO autenticado] — entrega de clave ONLINE por sesión.
 * Body: { contentId }. Valida licencia/acceso, re-deriva la CEK y la devuelve.
 * La CEK va sobre HTTPS y gated por JWT (mismo modelo que /api/drm/key).
 */
app.post('/api/edu/key', requireAuth, async (req, res) => {
    if (!EDU_MASTER_KEY || EDU_MASTER_KEY.length < 32) {
        return res.status(500).json({ error: 'EDU_MASTER_KEY no configurada en el servidor' });
    }
    const { contentId } = req.body || {};
    if (!contentId) return res.status(400).json({ error: 'contentId requerido' });
    const c = await db.getEduContent(contentId);
    if (!c) return res.status(404).json({ error: 'Contenido no encontrado' });

    try { await authorizeMedia(req, c.video_id); }
    catch (error) { return sendAccessError(res, error); }

    const cek = deriveEduCek(c.salt, contentId);
    // Marca de agua personalizada por comprador (correo del alumno).
    const wm = (c.watermark || '').replace('{ID_COMPRADOR}', req.user.email || req.user.sub || 'alumno');
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        cek: cek.toString('hex'),
        contentId,
        salt: c.salt,
        title: c.title || '',
        watermark: wm,
        chunkSize: 8192,
    });
});

/**
 * GET /api/edu/data/:contentId   [ALUMNO autenticado] — proxy del .edu desde Bunny.
 * Soporta Range para que el reproductor descargue por trozos. El alumno nunca ve
 * la URL real de Bunny. Los bytes van cifrados: inútiles sin la CEK.
 */
app.get('/api/edu/data/:contentId', async (req, res) => {
    const c = await db.getEduContent(req.params.contentId);
    if (!c || !c.bunny_url) return res.status(404).send('No encontrado');
    try { await authorizeMedia(req, c.video_id); }
    catch (error) { return sendAccessError(res, error); }
    if (!isSafeBunnyUrl(c.bunny_url)) return res.status(400).send('URL inválida');

    // Si el .edu está en la Storage API de Bunny, hay que autenticar con AccessKey
    // (server-side, oculto al alumno). Si es un pull zone público, se firma con token.
    const isStorageApi = /(^|\.)storage\.bunnycdn\.com$/i.test(new URL(c.bunny_url).host);
    let target = c.bunny_url;
    const headers = {};
    if (isStorageApi) {
        const st = await getBunnyStorageConfig();
        if (st.key) headers['AccessKey'] = st.key;
    } else {
        target = signBunnyUrl(c.bunny_url);
    }
    const parsed = new URL(target);
    headers['Referer'] = `${parsed.protocol}//${parsed.host}/`;
    const mod = target.startsWith('https') ? https : http;
    if (req.headers['range']) headers['Range'] = req.headers['range'];

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    const up = mod.get(target, { timeout: 30000, headers }, (upstream) => {
        if (upstream.statusCode >= 400) { if (!res.headersSent) res.status(502).send('Error Bunny'); upstream.resume(); return; }
        if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
        if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
        res.status(upstream.statusCode === 206 ? 206 : 200);
        upstream.pipe(res);
        upstream.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.end(); });
    });
    up.on('error', () => { if (!res.headersSent) res.status(502).send('Error conectando Bunny'); });
    up.on('timeout', () => { up.destroy(); if (!res.headersSent) res.status(504).send('Timeout'); });
    res.on('close', () => up.destroy());
});

/**
 * POST /api/license/activate
 * El reproductor Electron activa una licencia en un dispositivo.
 * Body: { licenseKey, deviceId, appVersion }
 * Returns: { activationId, activationToken, expiresAt }
 *
 * Seguridad:
 *  - Requiere firma HMAC del reproductor oficial (APP_SECRET).
 *  - Valida límite de dispositivos.
 *  - Devuelve token cifrado que el Electron guarda localmente.
 */
app.post('/api/license/activate', validateAppSig, async (req, res) => {
    try { res.json(await playerHandshake.activate(req)); }
    catch (error) { sendAccessError(res, error); }
});

/**
 * POST /api/license/validate-activation
 * El reproductor valida su activación local antes de reproducir.
 * Body: { activationToken, deviceId, videoId }
 * Returns: { valid: true, studentId, courseId }
 */
app.post('/api/license/validate-activation', validateAppSig, async (req, res) => {
    try { res.json(await createActivationValidator({ db, jwtSecret: JWT_SECRET, accessPolicy })(req.body || {})); }
    catch (error) { sendAccessError(res, error); }
});
/**
 * POST /api/admin/students/:id/reset-devices
 * [ADMIN] Limpieza profunda por alumno.
 * Elimina dispositivos/licencias/activaciones y huellas de dispositivo.
 * También revoca sesiones activas de Firebase para forzar re-login.
 */
app.post('/api/admin/students/:id/reset-devices', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const student = await db.findStudentById(id);
    if (!student) return res.status(404).json({ error: 'Alumno no encontrado' });

    const revokedBy = req.user?.email || req.user?.sub || 'admin';
    const reset = await db.hardResetStudentDeviceState(id);

    let firebaseRevoked = false;
    if (firebaseAdmin && student.firebase_uid) {
        try {
            await firebaseAdmin.auth().revokeRefreshTokens(student.firebase_uid);
            firebaseRevoked = true;
        } catch (e) {
            console.warn('[reset-devices] no se pudo revocar sesiones Firebase:', e.message);
        }
    }

    await db.logSuspiciousActivity({
        studentId: id,
        deviceId:  'admin',
        type:      'devices_reset',
        severity:  'low',
        description: `Admin ${revokedBy} ejecutó reset profundo. devices=${reset.deviceCount}, activations=${reset.activationCount}, licenses=${reset.licenseCount}, firebaseRevoked=${firebaseRevoked}`,
    });

    res.json({
        ok: true,
        reset,
        firebaseSessionsRevoked: firebaseRevoked,
        revokedCount: reset.activationCount,
        message: `Reset completo aplicado. Dispositivos borrados: ${reset.deviceCount}, activaciones borradas: ${reset.activationCount}, licencias borradas: ${reset.licenseCount}.`,
    });
});

/**
 * GET /api/admin/students/:id/activations
 * [ADMIN] Lista activaciones de un alumno.
 */
app.get('/api/admin/students/:id/activations', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const licenses = await db.getLicensesByStudent(id);
    const result = [];
    for (const lic of licenses) {
        const acts = await db.getActivationsByLicense(lic.id);
        result.push({ ...lic, activations: acts });
    }
    res.json(result);
});

/**
 * GET /api/admin/students/:id/licenses
 * [ADMIN] Lista licencias de un alumno.
 */
app.get('/api/admin/students/:id/licenses', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const licenses = await db.getLicensesByStudent(id);
    res.json(licenses);
});

/**
 * DELETE /api/admin/licenses/:licenseId
 * [ADMIN] Revoca una licencia específica.
 */
app.delete('/api/admin/licenses/:licenseId', requireAdmin, async (req, res) => {
    const { licenseId } = req.params;
    const revokedBy = req.user?.email || req.user?.sub || 'admin';
    await db.revokeLicense(licenseId, revokedBy);
    res.json({ ok: true });
});

/**
 * POST /api/admin/licenses/:licenseId/regenerate
 * [ADMIN] Regenera una licencia: crea una NUEVA licencia activa heredando la
 * configuración de la anterior (alumno, curso, max_devices, expiración) y
 * revoca por completo la anterior de forma transaccional:
 *   - Licencia anterior → 'revoked'.
 *   - Todas las activaciones (activation_tokens) de la anterior → 'revoked'.
 *   - Dispositivos conservan su estado y deben reactivar con la nueva clave.
 *   - playback_sessions activas de esos dispositivos → cerradas.
 * Devuelve la clave nueva en texto plano UNA sola vez (para copiar).
 */
app.post('/api/admin/licenses/:licenseId/regenerate', requireAdmin, async (req, res) => {
    try {
        const { licenseId } = req.params;
        if (!licenseId) return res.status(400).json({ error: 'licenseId requerido' });

        const adminId = req.user?.email || req.user?.sub || 'admin';

        // Generar clave nueva legible: XXXX-XXXX-XXXX-XXXX (base32 sin ambigüos)
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let rawKey = '';
        const rndBuf = crypto.randomBytes(16);
        for (let i = 0; i < 16; i++) rawKey += chars[rndBuf[i] % chars.length];
        const licenseKey = `${rawKey.slice(0,4)}-${rawKey.slice(4,8)}-${rawKey.slice(8,12)}-${rawKey.slice(12,16)}`;
        const newLicenseKeyHash = crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret')
            .update(licenseKey).digest('hex');
        const newLicenseId = uuidv4();

        const result = await db.regenerateLicense({
            oldLicenseId: licenseId,
            newLicenseId,
            newLicenseKeyHash,
            newLicenseKey: licenseKey,
            revokedBy: adminId,
        });

        if (!result.ok) {
            return res.status(404).json({ error: 'Licencia no encontrada' });
        }

        // ── Auditoría ────────────────────────────────────────────────────────
        const student = await db.findStudentById(result.studentId).catch(() => null);
        const email   = student?.email || '';
        await db.logSuspiciousActivity({
            studentId: result.studentId,
            deviceId:  'admin',
            type:      'license_regenerated',
            severity:  'medium',
            description: `Admin ${adminId} regeneró la licencia de ${email || result.studentId}. ` +
                `Anterior ${result.oldLicenseId} → revocada (nueva ${result.newLicenseId}). ` +
                `Activaciones revocadas: ${result.revokedActivations}, ` +
                `dispositivos cerrados: ${result.blockedDevices}, ` +
                `sesiones cerradas: ${result.closedSessions}, ` +
                `dispositivos desbloqueados: ${result.unblockedDevices || 0}. ` +
                `max_devices conservado: ${result.maxDevices}.`,
        }).catch(() => {});

        res.json({
            ok: true,
            licenseKey,                       // texto plano: solo se muestra aquí
            licenseId:   result.newLicenseId,
            oldLicenseId: result.oldLicenseId,
            studentId:   result.studentId,
            courseId:    result.courseId,
            maxDevices:  result.maxDevices,
            firstActivatedAt: result.firstActivatedAt,
            revokedActivations: result.revokedActivations,
            blockedDevices:     result.blockedDevices,
            closedSessions:     result.closedSessions,
        });
    } catch (err) {
        console.error('[license/regenerate]', err.message);
        res.status(500).json({ error: 'No se pudo regenerar la licencia' });
    }
});

// ================================================================
//  VDOCIPHER INTEGRATION
// ================================================================

/**
 * POST /api/vdocipher/otp
 * Genera un OTP (One-Time Password) de VdoCipher para reproducción segura.
 * Requiere que el alumno tenga sesión válida o activación válida.
 * Body: { videoId, activationToken, deviceId }   (desde el reproductor Electron)
 *   ó  Authorization: Bearer <student_jwt>        (desde el player web)
 * Returns: { otp, playbackInfo }
 */
app.post('/api/vdocipher/otp', validateAppSig, async (req, res) => {
    const VDOCIPHER_API_SECRET = process.env.VDOCIPHER_API_SECRET;
    if (!VDOCIPHER_API_SECRET) {
        return res.status(503).json({ error: 'VdoCipher no configurado en este servidor' });
    }

    const { videoId, activationToken, deviceId } = req.body || {};
    let studentId = null;

    // Ruta 1: desde Electron con activation token
    if (activationToken && deviceId) {
        const tokenHash = crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret')
            .update(String(activationToken)).digest('hex');
        const activation = await db.getActivationByTokenHash(tokenHash);
        if (!activation || activation.status !== 'active' || activation.device_id !== String(deviceId).slice(0, 64)) {
            return res.status(403).json({ error: 'Activación inválida o revocada', code: 'ACTIVATION_INVALID' });
        }
        if (activation.expires_at && new Date(activation.expires_at) < new Date()) {
            return res.status(403).json({ error: 'Activación expirada', code: 'ACTIVATION_EXPIRED' });
        }
        // Verificar que la licencia siga activa (detecta regeneración por el admin)
        const lic = await db.getLicenseById(activation.license_id);
        if (!lic || lic.status !== 'active') {
            return res.status(403).json({
                error: 'Tu licencia fue actualizada por el administrador. Ingresa la nueva licencia para continuar.',
                code:  'LICENSE_REGENERATED',
            });
        }
        studentId = activation.student_id;
        await db.touchActivation(activation.id);
    }
    // Ruta 2: desde player web con JWT
    else {
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'Se requiere autenticación' });
        try {
            const payload = jwt.verify(token, process.env.JWT_SECRET || 'secret', { issuer: 'reproductor-cursos' });
            studentId = payload.sub;
        } catch {
            return res.status(401).json({ error: 'Token inválido o expirado' });
        }
    }

    if (!videoId) return res.status(400).json({ error: 'videoId requerido' });

    // Validar acceso al video
    const student = await db.findStudentById(studentId);
    if (!student || !student.active) {
        return res.status(403).json({ error: 'Cuenta suspendida' });
    }
    const allowed = Array.isArray(student.allowedVideos) ? student.allowedVideos : ['*'];
    if (!allowed.includes('*') && !allowed.includes(videoId)) {
        return res.status(403).json({ error: 'Sin acceso a este video' });
    }

    // Generar OTP en VdoCipher
    try {
        const otpBody = JSON.stringify({
            ttl: 300,
        });
        const otpRes = await new Promise((resolve, reject) => {
            const reqOtp = https.request({
                hostname: 'dev.vdocipher.com',
                path:     `/api/videos/${encodeURIComponent(videoId)}/otp`,
                method:   'POST',
                headers: {
                    'Authorization': `Apisecret ${VDOCIPHER_API_SECRET}`,
                    'Content-Type':  'application/json',
                    'Accept':        'application/json',
                    'Content-Length': Buffer.byteLength(otpBody),
                },
                timeout: 10000,
            }, r => {
                let d = '';
                r.on('data', c => d += c);
                r.on('end', () => {
                    try { resolve({ status: r.statusCode, body: JSON.parse(d) }); }
                    catch { reject(new Error('parse')); }
                });
            });
            reqOtp.on('error', reject);
            reqOtp.on('timeout', () => { reqOtp.destroy(); reject(new Error('timeout')); });
            reqOtp.write(otpBody);
            reqOtp.end();
        });

        if (otpRes.status !== 200 || !otpRes.body.otp) {
            console.error('[vdocipher/otp] Error:', otpRes.status, JSON.stringify(otpRes.body));
            return res.status(502).json({ error: 'No se pudo generar token de reproducción' });
        }

        // Log de entrega
        const fingerprint = generateFingerprint(studentId, videoId);
        await db.logDelivery({
            userId:       studentId,
            videoId,
            fingerprint,
            deviceId:     deviceId || 'web',
            studentEmail: student.email || '',
            ip:           (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim(),
            userAgent:    (req.headers['user-agent'] || '').slice(0, 200),
        });

        res.json({ otp: otpRes.body.otp, playbackInfo: otpRes.body.playbackInfo });
    } catch (err) {
        console.error('[vdocipher/otp]', err.message);
        res.status(500).json({ error: 'Error al generar token de reproducción' });
    }
});

/**
 * GET /api/playback/session/:id/video-token
 * Llamado desde player.campuscliente.com con ?session=SESSION_ID.
 * Valida la sesión activa y devuelve un OTP de VdoCipher para reproducir el video.
 *
 * Acepta:
 *   - Origin: PLAYER_DOMAIN (browser web)
 *   - Origin: null (Electron)
 * Requiere: Authorization: Bearer <playerToken> emitido por /api/playback/generate-command
 */
const PLAYER_DOMAIN = process.env.PLAYER_DOMAIN || '';

app.get('/api/playback/session/:id/video-token', requireAuth, async (req, res) => {
    const origin = req.headers['origin'] || '';
    const isElectron = origin === 'null' || origin === '';
    const isAllowedWeb = PLAYER_DOMAIN && (origin === PLAYER_DOMAIN || origin === PLAYER_DOMAIN.replace(/\/$/, ''));

    // CORS estricto: solo Electron o el dominio del player configurado
    if (!isElectron && !isAllowedWeb) {
        return res.status(403).json({ error: 'Origen no permitido' });
    }

    const sessionId = req.params.id;
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        return res.status(400).json({ error: 'session_id inválido' });
    }

    // Buscar la sesión activa
    const session = await db.getActiveSession(sessionId).catch(() => null);
    if (!session) {
        return res.status(404).json({ error: 'Sesión no encontrada o expirada' });
    }

    // Validar que el alumno del JWT coincide con el dueño de la sesión
    if (session.studentId && session.studentId !== req.user.sub && !req.user.admin) {
        return res.status(403).json({ error: 'No autorizado para esta sesión' });
    }

    const videoId = session.videoId;
    if (!videoId) {
        return res.status(400).json({ error: 'La sesión no tiene videoId' });
    }

    // Verificar que el alumno tenga la cuenta activa
    const student = await db.getStudentById(req.user.sub).catch(() => null);
    if (!student || !student.active) {
        return res.status(403).json({ error: 'Cuenta suspendida' });
    }

    // Generar OTP de VdoCipher
    const VDOCIPHER_API_SECRET = process.env.VDOCIPHER_API_SECRET;
    if (!VDOCIPHER_API_SECRET) {
        return res.status(500).json({ error: 'VdoCipher no configurado' });
    }

    const https = require('https');
    const annotationText = `${(req.user.sub || '').slice(0, 8)}.${new Date().toISOString().slice(0, 10)}`;

    const otpPayload = JSON.stringify({
        annotate: annotationText,
        whitelistHref: PLAYER_DOMAIN ? [PLAYER_DOMAIN] : [],
    });

    const otp = await new Promise((resolve, reject) => {
        const opts = {
            hostname: 'dev.vdocipher.com',
            path: `/api/videos/${videoId}/otp`,
            method: 'POST',
            headers: {
                Authorization: `Apisecret ${VDOCIPHER_API_SECRET}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(otpPayload),
            },
        };
        const req2 = https.request(opts, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    if (j.otp && j.playbackInfo) resolve(j);
                    else reject(new Error(j.message || 'VdoCipher error'));
                } catch { reject(new Error('VdoCipher parse error')); }
            });
        });
        req2.on('error', reject);
        req2.write(otpPayload);
        req2.end();
    }).catch(e => ({ error: e.message }));

    if (otp.error) {
        return res.status(502).json({ error: 'Error generando token de video: ' + otp.error });
    }

    res.json({
        otp: otp.otp,
        playbackInfo: otp.playbackInfo,
        sessionId,
        videoId,
    });
});

/**
 * GET /api/vdocipher/config
 * [ADMIN] Verifica si VdoCipher está configurado.
 */
app.get('/api/vdocipher/config', requireAdmin, async (req, res) => {
    const configured = !!process.env.VDOCIPHER_API_SECRET;
    res.json({ configured, note: configured ? 'VdoCipher API Secret está configurado' : 'Falta env VDOCIPHER_API_SECRET' });
});

// ================================================================
//  CATCH-ALL 404 — debe ir DESPUÉS de todas las rutas para no
//  interceptar endpoints definidos más abajo (licencias, vdocipher, etc.)
// ================================================================
const { mountProducerBusiness } = require('./lib/producer-business');
const { createProducerLicenseWorkspace } = require('./lib/producer-licenses');
const { mountProducerContent } = require('./lib/producer-content');
const { createProducerMail } = require('./lib/producer-mail');
const producerLicenseWorkspace = createProducerLicenseWorkspace({ pool: db.pool, vaultKey: process.env.LICENSE_VAULT_KEY || JWT_SECRET, jwtSecret: JWT_SECRET });
const producerMail = createProducerMail({ db, secret: JWT_SECRET, getLicenseSerial: producerLicenseWorkspace.readLicenseSerial });
producerLicenseWorkspace.mount(app, requireProducer);
const producerContentService = mountProducerContent(app, { db, requireProducer, generatePublicCode, getPublicBase,
    syncCollection: ({ producerId, videoId, courseId, moduleId }) => streamService.syncVideoCollection({ courseId, videoId, moduleId, actor: { producerId } }) });
mountProducerBusiness(app, { db, requireProducer, requireAdmin, hashPassword, verifyPassword, secret: JWT_SECRET, getPublicBase,
    mailConfigured: producerMail.configured,
    issueProducerToken: p => jwt.sign({ sub: p.id, producerId: p.id, email: p.email, role: 'producer', label: p.name || p.email, authVersion: Number(p.auth_version || 0) }, JWT_SECRET, { expiresIn: JWT_EXPIRES, issuer: 'reproductor-cursos' }) });
producerMail.mount(app, requireProducer);
let producerMailBusy = false;
const producerMailTimer = setInterval(async () => {
    if (!dbReady || producerMailBusy || !producerMail.configured()) return;
    producerMailBusy = true;
    try { await producerMail.processOne(); } catch (_) { console.warn('[producer-mail] No se pudo procesar la cola.'); }
    finally { producerMailBusy = false; }
}, 15000);
producerMailTimer.unref();
app.use(async (req, res) => res.status(404).json({ error: 'No encontrado' }));

// ================================================================
//  GLOBAL ERROR HANDLERS — evita que errores async cierren el proceso
// ================================================================
app.use((err, req, res, next) => {
    console.error('[Express error]', err?.message || err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Error interno del servidor' });
});

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason?.message || reason);
    // No cerrar el proceso — solo logear
});

process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err?.message || err);
    // No cerrar el proceso para evitar 502 en bucle
});

const httpServer = app.listen(PORT, process.env.BIND_HOST || '0.0.0.0', () => {
    console.log('');
    console.log('=========================================');
    console.log('  Reproductor DRM — Servidor iniciado');
    console.log(`  Reproductor: http://localhost:${PORT}`);
    console.log(`  Admin panel: http://localhost:${PORT}/admin`);
    console.log(`  Modo: ${LOCAL_MODE ? 'LOCAL (sin B2)' : 'Backblaze B2'}`);
    console.log('');
    console.log('  Credenciales admin: configuradas vía variables de entorno (ADMIN_USER / ADMIN_PASS)');
    console.log('=========================================');
    console.log('');
    // Inicializar DB en background para no bloquear el arranque
    initDbWithRetry();
});
