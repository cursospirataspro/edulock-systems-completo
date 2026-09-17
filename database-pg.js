'use strict';
/**
 * database-pg.js — PostgreSQL async backend
 * Drop-in async replacement for database.js using pg Pool.
 * Call db.initDb() at startup before accepting requests.
 */

const { Pool } = require('pg');
const { v4: uuid4 } = require('uuid');
const crypto = require('crypto');

// ================================================================
//  CIFRADO EN REPOSO (campos sensibles: bunny_url, links, PDFs, etc.)
//  Todo lo que se guarde en columnas de referencia va cifrado con
//  AES-256-GCM usando una subclave derivada del EDU_MASTER_KEY. Así la
//  BD nunca contiene URLs/links en texto plano. Retrocompatible: si un
//  valor no lleva el prefijo 'enc1:', se devuelve tal cual (datos viejos).
// ================================================================
const FIELD_KEY = (() => {
    const master = process.env.EDU_MASTER_KEY || process.env.APP_SECRET || process.env.JWT_SECRET || '';
    if (!master) return null;
    return crypto.createHash('sha256').update('edulock-field-enc|' + master).digest(); // 32 bytes
})();
function encField(plain) {
    if (plain == null || plain === '') return plain;
    const s = String(plain);
    if (!FIELD_KEY || s.startsWith('enc1:')) return plain; // sin clave o ya cifrado
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', FIELD_KEY, iv);
    const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
    return 'enc1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decField(stored) {
    if (stored == null || stored === '') return stored;
    if (typeof stored !== 'string' || !stored.startsWith('enc1:')) return stored; // texto plano (compat)
    if (!FIELD_KEY) return stored;
    try {
        const raw = Buffer.from(stored.slice(5), 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', FIELD_KEY, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch { return stored; }
}
module.exports._encField = encField;   // export para pruebas/uso puntual
module.exports._decField = decField;

const isLocalDb = /@(localhost|127\.0\.0\.1)(:|\/)/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: (process.env.NODE_ENV === 'production' && !isLocalDb) ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => console.error('[db-pg] Pool error:', err.message));

async function q(sql, params = []) {
    return pool.query(sql, params);
}

function dbError(code, message, statusCode = 409) {
    return Object.assign(new Error(message), { code, statusCode });
}

async function transaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        throw error;
    } finally { client.release(); }
}

// ================================================================
//  SCHEMA + INIT
// ================================================================

async function initDb() {
    await q(`
        CREATE TABLE IF NOT EXISTS students (
            id             TEXT PRIMARY KEY,
            email          TEXT NOT NULL UNIQUE,
            student_id     TEXT NOT NULL,
            name           TEXT NOT NULL DEFAULT '',
            active         INTEGER NOT NULL DEFAULT 1,
            allowed_videos TEXT NOT NULL DEFAULT '*',
            device_id      TEXT,
            created_at     TEXT NOT NULL,
            last_login     TEXT
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_students_email ON students(email)`);

    await q(`
        CREATE TABLE IF NOT EXISTS audit_log (
            id            BIGSERIAL PRIMARY KEY,
            fingerprint   TEXT NOT NULL,
            user_id       TEXT NOT NULL,
            video_id      TEXT NOT NULL,
            device_id     TEXT NOT NULL DEFAULT 'desconocido',
            student_email TEXT NOT NULL DEFAULT '',
            ip            TEXT NOT NULL DEFAULT 'desconocida',
            user_agent    TEXT NOT NULL DEFAULT 'desconocido',
            delivered_at  TEXT NOT NULL,
            event_type    TEXT
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_audit_user  ON audit_log(user_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_audit_video ON audit_log(video_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_audit_fp    ON audit_log(fingerprint)`);

    await q(`
        CREATE TABLE IF NOT EXISTS catalog (
            video_id      TEXT PRIMARY KEY,
            title         TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'processing',
            segment_count INTEGER NOT NULL DEFAULT 0,
            key_id        TEXT,
            error         TEXT,
            uploaded_at   TEXT NOT NULL,
            source_type   TEXT NOT NULL DEFAULT 'local',
            bunny_url     TEXT,
            course_id     TEXT,
            sort_order    INTEGER NOT NULL DEFAULT 0,
            module_id     TEXT
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_catalog_course ON catalog(course_id)`);

    await q(`
        CREATE TABLE IF NOT EXISTS active_sessions (
            session_id   TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL,
            video_id     TEXT NOT NULL,
            started_at   BIGINT NOT NULL,
            last_seen    BIGINT NOT NULL,
            current_pos  INTEGER NOT NULL DEFAULT 0
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON active_sessions(user_id)`);
    await q(`ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS device_id TEXT`);

    await q(`
        CREATE TABLE IF NOT EXISTS allowed_domains (
            domain TEXT PRIMARY KEY
        )
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS courses (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            author     TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS modules (
            id         TEXT PRIMARY KEY,
            course_id  TEXT NOT NULL,
            parent_id  TEXT,
            name       TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_modules_course ON modules(course_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_modules_parent ON modules(parent_id)`);

    await q(`
        CREATE TABLE IF NOT EXISTS app_config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        )
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS playback_sessions (
            session_id    TEXT PRIMARY KEY,
            student_id    TEXT NOT NULL,
            student_email TEXT NOT NULL,
            course_id     TEXT NOT NULL,
            lesson_id     TEXT NOT NULL,
            device_id     TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            expires_at    TEXT NOT NULL
        )
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS devices (
            id          TEXT PRIMARY KEY,
            student_id  TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            device_name TEXT,
            browser     TEXT,
            os          TEXT,
            city        TEXT,
            status      TEXT NOT NULL DEFAULT 'active',
            first_seen  TEXT NOT NULL,
            last_seen   TEXT NOT NULL,
            UNIQUE(student_id, fingerprint)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_devices_student ON devices(student_id)`);

    await q(`
        CREATE TABLE IF NOT EXISTS playback_progress (
            id               TEXT PRIMARY KEY,
            student_id       TEXT NOT NULL,
            video_id         TEXT NOT NULL,
            course_id        TEXT,
            progress_percent REAL NOT NULL DEFAULT 0,
            last_position    INTEGER NOT NULL DEFAULT 0,
            started_at       TEXT NOT NULL,
            last_seen_at     TEXT NOT NULL,
            completed        INTEGER NOT NULL DEFAULT 0,
            device_id        TEXT,
            UNIQUE(student_id, video_id)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_progress_student ON playback_progress(student_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_progress_video   ON playback_progress(video_id)`);
    // Migración: agregar columna city si no existe (para guardar ciudad por IP al reproducir)
    await q(`ALTER TABLE playback_progress ADD COLUMN IF NOT EXISTS city TEXT`).catch(() => {});
    // Migración: agregar columna documents para recursos descargables por video y módulo
    await q(`ALTER TABLE catalog ADD COLUMN IF NOT EXISTS documents TEXT DEFAULT '[]'`).catch(() => {});
    await q(`ALTER TABLE modules ADD COLUMN IF NOT EXISTS documents TEXT DEFAULT '[]'`).catch(() => {});
    // Migración: publicCode único por video para portadas públicas
    await q(`ALTER TABLE catalog ADD COLUMN IF NOT EXISTS public_code TEXT`).catch(() => {});
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_public_code ON catalog(public_code) WHERE public_code IS NOT NULL`).catch(() => {});

    // Migración: Bunny Stream — biblioteca por curso, colección por módulo (auto-provisión)
    await q(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS bunny_library_id    TEXT`).catch(() => {});
    await q(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS bunny_library_key   TEXT`).catch(() => {});
    await q(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS bunny_pull_zone     TEXT`).catch(() => {});
    await q(`ALTER TABLE modules ADD COLUMN IF NOT EXISTS bunny_collection_id TEXT`).catch(() => {});

    await q(`
        CREATE TABLE IF NOT EXISTS launch_tokens (
            token      TEXT PRIMARY KEY,
            video_id   TEXT NOT NULL,
            expires_at BIGINT NOT NULL,
            used       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (NOW()::text)
        )
    `);
    await q(`ALTER TABLE launch_tokens ADD COLUMN IF NOT EXISTS opened INTEGER NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE launch_tokens ADD COLUMN IF NOT EXISTS opened_at BIGINT`);
    await q(`CREATE INDEX IF NOT EXISTS idx_launch_tokens_video ON launch_tokens(video_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_launch_tokens_exp   ON launch_tokens(expires_at)`);

    await q(`
        CREATE TABLE IF NOT EXISTS playback_events (
            id               BIGSERIAL PRIMARY KEY,
            student_id       TEXT NOT NULL,
            video_id         TEXT NOT NULL,
            course_id        TEXT,
            device_id        TEXT,
            event_type       TEXT NOT NULL,
            progress_percent REAL,
            current_pos      INTEGER,
            metadata         TEXT,
            created_at       TEXT NOT NULL
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_pb_events_student ON playback_events(student_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_pb_events_video   ON playback_events(video_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_pb_events_type    ON playback_events(event_type)`);

    await q(`
        CREATE TABLE IF NOT EXISTS suspicious_activity (
            id          BIGSERIAL PRIMARY KEY,
            student_id  TEXT NOT NULL,
            device_id   TEXT,
            type        TEXT NOT NULL,
            severity    TEXT NOT NULL DEFAULT 'low',
            description TEXT,
            metadata    TEXT,
            reviewed    INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_suspicious_student  ON suspicious_activity(student_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_suspicious_type     ON suspicious_activity(type)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_suspicious_reviewed ON suspicious_activity(reviewed)`);

    // Auditoría granular por segmento HLS — detecta patrones de descarga masiva
    await q(`
        CREATE TABLE IF NOT EXISTS segment_requests (
            id          BIGSERIAL PRIMARY KEY,
            student_id  TEXT,
            video_id    TEXT NOT NULL,
            session_id  TEXT,
            device_id   TEXT,
            seg_index   INTEGER,
            ip          TEXT,
            user_agent  TEXT,
            created_at  TEXT NOT NULL
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_segreq_student ON segment_requests(student_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_segreq_video   ON segment_requests(video_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_segreq_created ON segment_requests(created_at)`);

    await q(`
        CREATE TABLE IF NOT EXISTS student_codes (
            student_id TEXT PRIMARY KEY,
            code       TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        )
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS used_nonces (
            nonce   TEXT PRIMARY KEY,
            used_at TEXT NOT NULL
        )
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS pending_play_tokens (
            token      TEXT PRIMARY KEY,
            cmd        TEXT NOT NULL,
            auth       TEXT NOT NULL,
            expires_at BIGINT NOT NULL,
            is_dev     INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (NOW()::text)
        )
    `);

    await q(`
        CREATE TABLE IF NOT EXISTS player_versions (
            id             BIGSERIAL PRIMARY KEY,
            min_version    TEXT NOT NULL DEFAULT '1.0.0',
            latest_version TEXT NOT NULL DEFAULT '1.0.0',
            download_url   TEXT,
            message        TEXT,
            updated_at     TEXT NOT NULL
        )
    `);

    // ---- Sistema de Aprobación de Usuarios ----
    await q(`
        CREATE TABLE IF NOT EXISTS registration_requests (
            id              TEXT PRIMARY KEY,
            firebase_uid    TEXT,
            email           TEXT NOT NULL,
            email_verified  INTEGER NOT NULL DEFAULT 0,
            name            TEXT NOT NULL DEFAULT '',
            device_id       TEXT NOT NULL,
            device_model    TEXT NOT NULL DEFAULT '',
            device_name     TEXT NOT NULL DEFAULT '',
            device_serial   TEXT NOT NULL DEFAULT '',
            os_version      TEXT NOT NULL DEFAULT '',
            os_version_code TEXT NOT NULL DEFAULT '',
            cpu_cores       TEXT NOT NULL DEFAULT '',
            total_ram       TEXT NOT NULL DEFAULT '',
            android_id      TEXT NOT NULL DEFAULT '',
            build_fingerprint TEXT NOT NULL DEFAULT '',
            brand           TEXT NOT NULL DEFAULT '',
            manufacturer    TEXT NOT NULL DEFAULT '',
            fcm_token       TEXT NOT NULL DEFAULT '',
            status          TEXT NOT NULL DEFAULT 'pending',
            requested_at    TEXT NOT NULL,
            reviewed_at     TEXT,
            reviewed_by     TEXT,
            notes           TEXT
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_reg_requests_email  ON registration_requests(email)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_reg_requests_device ON registration_requests(device_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_reg_requests_status ON registration_requests(status)`);
    // Verification is evidence from the decoded Firebase identity, never from
    // a client-supplied form field. A failed migration must block account work.
    await q(`ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0`);

    // Agregar columnas faltantes a registration_requests si existen
    try {
        await q(`ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS device_serial TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS os_version TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS os_version_code TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS cpu_cores TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS total_ram TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS android_id TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS build_fingerprint TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS manufacturer TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE registration_requests ADD COLUMN IF NOT EXISTS fcm_token TEXT NOT NULL DEFAULT ''`);
    } catch (e) { /* ya existen */ }

    // Acceso por curso: qué cursos tiene cada alumno habilitados
    await q(`
        CREATE TABLE IF NOT EXISTS student_courses (
            student_id  TEXT NOT NULL,
            course_id   TEXT NOT NULL,
            granted_at  TEXT NOT NULL,
            granted_by  TEXT NOT NULL DEFAULT 'admin',
            PRIMARY KEY (student_id, course_id)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_sc_student ON student_courses(student_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_sc_course  ON student_courses(course_id)`);

    // ---- Tabla para rastreo forense de reproducción (Watermarking) ----
    await q(`
        CREATE TABLE IF NOT EXISTS watermark_logs (
            id                  BIGSERIAL PRIMARY KEY,
            user_id             TEXT NOT NULL,
            video_id            TEXT NOT NULL,
            media_token         TEXT,
            device_id           TEXT NOT NULL,
            device_model        TEXT NOT NULL DEFAULT '',
            build_fingerprint   TEXT NOT NULL DEFAULT '',
            os_version          TEXT NOT NULL DEFAULT '',
            cpu_cores           TEXT NOT NULL DEFAULT '',
            android_id          TEXT NOT NULL DEFAULT '',
            device_serial       TEXT NOT NULL DEFAULT '',
            brand               TEXT NOT NULL DEFAULT '',
            manufacturer        TEXT NOT NULL DEFAULT '',
            timestamp           TEXT NOT NULL,
            watched_percentage  INTEGER DEFAULT 0,
            ip_address          TEXT,
            user_agent          TEXT,
            created_at          TEXT NOT NULL DEFAULT (NOW()::text)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_watermark_user    ON watermark_logs(user_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_watermark_video   ON watermark_logs(video_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_watermark_device  ON watermark_logs(device_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_watermark_timestamp ON watermark_logs(timestamp)`);

    // Preparación Firebase: columna firebase_uid en students + device_info + password_hash
    try {
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS password_hash TEXT`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS firebase_uid TEXT`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved'`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS max_devices INTEGER NOT NULL DEFAULT 1`);
        // El predeterminado ahora es 1 dispositivo por cuenta (estricto).
        await q(`ALTER TABLE students ALTER COLUMN max_devices SET DEFAULT 1`).catch(() => {});
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS device_model TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS device_name  TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS device_serial TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS os_version TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS os_version_code TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS cpu_cores TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS total_ram TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS android_id TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS build_fingerprint TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS manufacturer TEXT NOT NULL DEFAULT ''`);
        await q(`ALTER TABLE students ADD COLUMN IF NOT EXISTS fcm_token TEXT NOT NULL DEFAULT ''`);
    } catch (e) { /* ya existe */}

    // Migración única: el predeterminado anterior era 2 dispositivos. Ahora la regla
    // es 1 dispositivo por cuenta. Pasamos a 1 a quienes tengan el antiguo default (2),
    // SOLO una vez, para no pisar ajustes manuales que el admin haga después.
    try {
        const flag = (await q(`SELECT value FROM app_config WHERE key='migrated_maxdev_default1'`)).rows[0];
        if (!flag) {
            await q(`UPDATE students SET max_devices = 1 WHERE max_devices IS NULL OR max_devices = 2`);
            await q(`INSERT INTO app_config (key, value) VALUES ('migrated_maxdev_default1','1')
                     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
        }
    } catch (e) { /* no bloquear arranque */ }

    // Migración: renombrar current_time → current_pos (era palabra reservada de PostgreSQL)
    try {
        await q(`ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS current_pos INTEGER NOT NULL DEFAULT 0`);
    } catch (e) { /* ya existe o tabla no tiene la columna */ }
    try {
        await q(`ALTER TABLE playback_events ADD COLUMN IF NOT EXISTS current_pos INTEGER`);
    } catch (e) { /* ya existe */ }

    // ── Tabla licenses (sistema de llaves de activación) ──────────────────────
    await q(`
        CREATE TABLE IF NOT EXISTS licenses (
            id              TEXT PRIMARY KEY,
            license_key_hash TEXT NOT NULL UNIQUE,
            student_id      TEXT NOT NULL,
            course_id       TEXT,
            status          TEXT NOT NULL DEFAULT 'active',
            max_devices     INTEGER NOT NULL DEFAULT 2,
            created_at      TEXT NOT NULL,
            expires_at      TEXT,
            revoked_at      TEXT,
            revoked_by      TEXT,
            notes           TEXT
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_licenses_student ON licenses(student_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_licenses_key    ON licenses(license_key_hash)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status)`);

    // ── Tabla activations (activación local por dispositivo) ──────────────────
    await q(`
        CREATE TABLE IF NOT EXISTS activations (
            id                   TEXT PRIMARY KEY,
            license_id           TEXT NOT NULL,
            student_id           TEXT NOT NULL,
            device_id            TEXT NOT NULL,
            activation_token_hash TEXT NOT NULL UNIQUE,
            status               TEXT NOT NULL DEFAULT 'active',
            created_at           TEXT NOT NULL,
            last_used_at         TEXT,
            expires_at           TEXT,
            revoked_at           TEXT,
            revoked_by           TEXT,
            UNIQUE(license_id, device_id)
        )
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_activations_license ON activations(license_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_activations_student ON activations(student_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_activations_device  ON activations(device_id)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_activations_token   ON activations(activation_token_hash)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_activations_status  ON activations(status)`);

    // ---- Tombstone: videos eliminados por el admin (no deben re-sembrarse nunca) ----
    await q(`
        CREATE TABLE IF NOT EXISTS deleted_videos (
            video_id   TEXT PRIMARY KEY,
            deleted_at TEXT NOT NULL
        )
    `);

    console.log('[db-pg] Schema listo (watermark_logs + device_info + licenses + activations agregadas)');

    // Reconciliación (idempotente): sincroniza allowed_videos de alumnos que
    // tienen cursos asignados en student_courses pero cuyo allowed_videos quedó
    // desincronizado. Esto era la causa de que a algunos alumnos no les
    // apareciera el botón/lista de "Cursos" en su panel pese a tener cursos
    // asignados. No toca a alumnos con acceso total ('*').
    try {
        const r = await q(`
            UPDATE students s
            SET allowed_videos = sc.ids
            FROM (
                SELECT student_id, to_json(array_agg(course_id))::text AS ids
                FROM student_courses
                GROUP BY student_id
            ) sc
            WHERE s.id = sc.student_id
              AND s.allowed_videos <> '*'
              AND s.allowed_videos <> sc.ids
        `);
        if (r.rowCount > 0) console.log(`[db-pg] Reconciliación cursos: ${r.rowCount} alumno(s) sincronizado(s)`);
    } catch (e) { console.error('[db-pg] Reconciliación cursos falló:', e.message); }

    // ── Lotes de seriales + venta automatizada (PDF Mejoras 3 y 4) ────────────
    // Un lote agrupa N licencias de un curso generadas de golpe. Las licencias
    // pueden nacer SIN alumno (status 'free') y asignarse luego a un comprador.
    await q(`
        CREATE TABLE IF NOT EXISTS license_lots (
            id          TEXT PRIMARY KEY,
            course_id   TEXT,
            quantity    INTEGER NOT NULL DEFAULT 0,
            notes       TEXT,
            created_by  TEXT,
            created_at  TEXT NOT NULL
        )
    `).catch(() => {});
    // licenses: soportar licencias libres (sin alumno) y trazabilidad de venta.
    await q(`ALTER TABLE licenses ALTER COLUMN student_id DROP NOT NULL`).catch(() => {});
    await q(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS lot_id         TEXT`).catch(() => {});
    await q(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS customer_email TEXT`).catch(() => {});
    await q(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS order_id       TEXT`).catch(() => {});
    await q(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS assigned_at    TEXT`).catch(() => {});
    await q(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS suspended_at   TEXT`).catch(() => {});
    await q(`CREATE INDEX IF NOT EXISTS idx_licenses_lot ON licenses(lot_id)`).catch(() => {});

    // API keys de integración de ventas (Hotmart/WooCommerce/etc.) — permisos mínimos.
    await q(`
        CREATE TABLE IF NOT EXISTS integration_keys (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            key_hash    TEXT NOT NULL UNIQUE,
            scopes      TEXT NOT NULL DEFAULT 'claim-license',
            active      INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL,
            last_used   TEXT
        )
    `).catch(() => {});

    // ── DRM propio (.edu) — registro de contenidos cifrados (guía DRM) ────────
    // Guarda solo datos NO secretos (salt, url en Bunny). La clave (CEK) NO se
    // almacena: el servidor la re-deriva del MASTER_KEY bajo demanda por sesión.
    await q(`
        CREATE TABLE IF NOT EXISTS edu_content (
            content_id  TEXT PRIMARY KEY,
            salt        TEXT NOT NULL,
            bunny_url   TEXT,
            title       TEXT,
            watermark   TEXT,
            flags       INTEGER NOT NULL DEFAULT 0,
            course_id   TEXT,
            video_id    TEXT,
            created_at  TEXT NOT NULL
        )
    `).catch(() => {});

    // ── Multi-tenancy: PRODUCTORES (clientes) — cada uno tiene su panel aislado ──
    // El "owner" (tú) los crea y les fija cuotas. Cada dato de contenido lleva
    // producer_id para aislar lo de cada cliente.
    await q(`
        CREATE TABLE IF NOT EXISTS producers (
            id              TEXT PRIMARY KEY,
            email           TEXT NOT NULL UNIQUE,
            password_hash   TEXT,
            name            TEXT,
            active          INTEGER NOT NULL DEFAULT 1,
            max_licenses    INTEGER NOT NULL DEFAULT 100,   -- cuántas licencias puede generar
            max_devices     INTEGER NOT NULL DEFAULT 2,     -- tope de dispositivos por licencia
            max_students    INTEGER NOT NULL DEFAULT 0,     -- 0 = sin límite
            notes           TEXT,
            created_at      TEXT NOT NULL,
            last_login      TEXT
        )
    `).catch(() => {});
    // Columna producer_id en las tablas con contenido (aislamiento por cliente).
    for (const t of ['courses','catalog','students','licenses','license_lots','edu_content','modules']) {
        await q(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS producer_id TEXT`).catch(() => {});
    }
    await q(`CREATE INDEX IF NOT EXISTS idx_courses_producer  ON courses(producer_id)`).catch(() => {});
    await q(`CREATE INDEX IF NOT EXISTS idx_catalog_producer  ON catalog(producer_id)`).catch(() => {});
    await q(`CREATE INDEX IF NOT EXISTS idx_students_producer ON students(producer_id)`).catch(() => {});
    await q(`CREATE INDEX IF NOT EXISTS idx_licenses_producer ON licenses(producer_id)`).catch(() => {});

    // Producer auth_version for session invalidation on password/suspension changes
    await q(`ALTER TABLE producers ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0`).catch(() => {});

    // Producer-student junction table (shared students across producers)
    await q(`
        CREATE TABLE IF NOT EXISTS producer_students (
            producer_id TEXT NOT NULL,
            student_id  TEXT NOT NULL,
            linked_at   TEXT,
            linked_via  TEXT DEFAULT 'license_activation',
            PRIMARY KEY (producer_id, student_id)
        )
    `).catch(() => {});

    // Producer-course assignment table
    await q(`
        CREATE TABLE IF NOT EXISTS producer_courses (
            producer_id TEXT NOT NULL,
            course_id   TEXT NOT NULL,
            assigned_at TEXT,
            PRIMARY KEY (producer_id, course_id)
        )
    `).catch(() => {});

    // License columns for unbound licenses and producer tracking
    await q(`ALTER TABLE licenses ALTER COLUMN student_id DROP NOT NULL`).catch(() => {});
    await q(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS batch_id TEXT`).catch(() => {});
    await q(`ALTER TABLE licenses ADD COLUMN IF NOT EXISTS reserved_email TEXT`).catch(() => {});

    // Durable upload/provision state. These migrations must succeed: silently
    // losing idempotency would make a retry create a second remote resource.
    await q(`CREATE TABLE IF NOT EXISTS stream_resources (
        resource_key TEXT PRIMARY KEY,
        remote_name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'reserved',
        remote_id TEXT,
        updated_at TEXT NOT NULL
    )`);
    await q(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS bunny_token_key TEXT`);
    await q(`CREATE TABLE IF NOT EXISTS stream_operations (
        id TEXT PRIMARY KEY,
        actor_key TEXT NOT NULL,
        course_id TEXT NOT NULL,
        module_id TEXT,
        title TEXT NOT NULL,
        file_size BIGINT NOT NULL,
        file_sha256 TEXT NOT NULL,
        video_id TEXT,
        state TEXT NOT NULL DEFAULT 'reserved',
        upload_percent INTEGER NOT NULL DEFAULT 0,
        provider_status INTEGER,
        encode_progress INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`);
    await q(`ALTER TABLE stream_operations ADD COLUMN IF NOT EXISTS error_detail TEXT`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_operations_video
             ON stream_operations(video_id) WHERE video_id IS NOT NULL`);
    await q(`CREATE INDEX IF NOT EXISTS idx_stream_operations_pending ON stream_operations(state, updated_at)`);

    // Optional public/protected resources live separately from legacy document
    // links. A failed migration must stop startup instead of weakening access.
    await require('./lib/resource-repository').createResourceRepository({ db: { pool } }).init();
    await require('./lib/producer-business').ensureSchema({ pool });
    await require('./lib/producer-mail').ensureSchema({ pool });
    await require('./lib/producer-content').ensureSchema({ pool });
    await require('./lib/producer-licenses').ensureSchema(pool);

    await _seedCoursesFromEnv();
    await _seedCatalogFromEnv();
    await _seedDomainsFromEnv();

    // Migración (idempotente): cifrar en reposo los links que quedaron en texto plano.
    // Corre tras crear TODAS las tablas. Solo toca filas que NO empiezan por 'enc1:'.
    if (FIELD_KEY) {
        try {
            let n = 0;
            const cat = (await q(`SELECT video_id, bunny_url, documents FROM catalog WHERE (bunny_url IS NOT NULL AND bunny_url NOT LIKE 'enc1:%') OR (documents IS NOT NULL AND documents NOT LIKE 'enc1:%')`)).rows;
            for (const r of cat) {
                const bu = (r.bunny_url && !String(r.bunny_url).startsWith('enc1:')) ? encField(r.bunny_url) : r.bunny_url;
                const dc = (r.documents && !String(r.documents).startsWith('enc1:')) ? encField(r.documents) : r.documents;
                await q('UPDATE catalog SET bunny_url=$1, documents=$2 WHERE video_id=$3', [bu, dc, r.video_id]); n++;
            }
            const mods = (await q(`SELECT id, documents FROM modules WHERE documents IS NOT NULL AND documents NOT LIKE 'enc1:%'`)).rows;
            for (const r of mods) { await q('UPDATE modules SET documents=$1 WHERE id=$2', [encField(r.documents), r.id]); n++; }
            const edus = (await q(`SELECT content_id, bunny_url FROM edu_content WHERE bunny_url IS NOT NULL AND bunny_url NOT LIKE 'enc1:%'`)).rows;
            for (const r of edus) { await q('UPDATE edu_content SET bunny_url=$1 WHERE content_id=$2', [encField(r.bunny_url), r.content_id]); n++; }
            if (n) console.log(`[db-pg] Cifrado en reposo aplicado a ${n} registro(s) existente(s).`);
        } catch (e) { console.warn('[db-pg] migración cifrado-en-reposo:', e.message); }
    }

    try {
        const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        await q('DELETE FROM used_nonces WHERE used_at < $1', [cutoff]);
        await q('DELETE FROM pending_play_tokens WHERE expires_at < $1', [Date.now()]);
    } catch {}
}

// ================================================================
//  SEEDS
// ================================================================

async function _seedCoursesFromEnv() {
    const raw = process.env.COURSES_SEED;
    if (!raw) return;
    let entries;
    try { entries = JSON.parse(raw); } catch { console.error('[db-pg] COURSES_SEED inválido'); return; }
    if (!Array.isArray(entries)) return;
    for (const c of entries) {
        if (!c.id || !c.name) continue;
        try {
            await q(
                `INSERT INTO courses (id, name, author, sort_order, created_at)
                 VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
                [c.id, c.name, c.author || '', c.sortOrder || 0, c.createdAt || new Date().toISOString()]
            );
        } catch (err) { console.error('[db-pg] Curso seed error:', err.message); }
    }
    console.log('[db-pg] Cursos seed OK');
}

async function _seedCatalogFromEnv() {
    let entries = [];
    if (process.env.CATALOG_SEED) {
        try { entries = JSON.parse(process.env.CATALOG_SEED); }
        catch { console.error('[db-pg] CATALOG_SEED inválido'); return; }
    } else {
        const p1 = process.env.CATALOG_SEED_1;
        const p2 = process.env.CATALOG_SEED_2;
        const p3 = process.env.CATALOG_SEED_3;
        if (!p1) return;
        try {
            if (p1) entries.push(...JSON.parse(p1));
            if (p2) entries.push(...JSON.parse(p2));
            if (p3) entries.push(...JSON.parse(p3));
        } catch { console.error('[db-pg] CATALOG_SEED_N inválido'); return; }
    }
    if (!Array.isArray(entries)) return;
    // No re-sembrar videos que el admin eliminó deliberadamente (tombstones)
    let deletedSet = new Set();
    try {
        const dRes = await q('SELECT video_id FROM deleted_videos');
        deletedSet = new Set(dRes.rows.map(r => r.video_id));
    } catch { /* tabla puede no existir aún en primer arranque */ }
    let skipped = 0;
    for (const e of entries) {
        if (!e.videoId || !e.bunnyUrl) continue;
        if (deletedSet.has(e.videoId)) { skipped++; continue; }
        try {
            await q(
                `INSERT INTO catalog (video_id, title, status, segment_count, key_id, error, uploaded_at, source_type, bunny_url, course_id, sort_order)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (video_id) DO NOTHING`,
                [
                    e.videoId, e.title || e.videoId, e.status || 'ready',
                    e.segmentCount || 0, e.keyId || null, null,
                    e.uploadedAt || new Date().toISOString(),
                    e.sourceType || 'bunny', encField(e.bunnyUrl),
                    e.courseId || null, e.sortOrder || 0,
                ]
            );
        } catch (err) { console.error('[db-pg] Catalog seed error:', err.message); }
    }
    console.log(`[db-pg] Catálogo seed OK${skipped ? ` (omitidos ${skipped} eliminados)` : ''}`);
}

async function _seedDomainsFromEnv() {
    const raw = process.env.ALLOWED_DOMAINS_SEED;
    if (!raw) return;
    try {
        const domains = JSON.parse(raw);
        if (!Array.isArray(domains)) return;
        for (const d of domains) {
            if (typeof d === 'string' && d.trim()) {
                await q('INSERT INTO allowed_domains (domain) VALUES ($1) ON CONFLICT DO NOTHING', [d.trim()]);
            }
        }
        console.log('[db-pg] Dominios seed:', domains.length);
    } catch { console.error('[db-pg] ALLOWED_DOMAINS_SEED inválido'); }
}

// ================================================================
//  HELPERS
// ================================================================

function parseAllowedVideos(raw) {
    if (raw === '*') return ['*'];
    if (!raw) return [];
    try {
        const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
        return Array.isArray(parsed) ? [...new Set(parsed.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))] : [];
    } catch { return []; }
}

function serializeAllowedVideos(arr) {
    if (!Array.isArray(arr)) return '[]';
    if (arr.includes('*')) return '*';
    return JSON.stringify(arr);
}

function rowToStudent(row) {
    if (!row) return null;
    return {
        id:              row.id,
        email:           row.email,
        studentId:       row.student_id,
        name:            row.name,
        active:          row.active === 1 || row.active === true,
        allowedVideos:   parseAllowedVideos(row.allowed_videos),
        deviceId:        row.device_id     || null,
        createdAt:       row.created_at,
        lastLogin:       row.last_login    || null,
        // Campos de seguridad (antes faltaban — causaban que approval_status fuera siempre undefined)
        approval_status: row.approval_status || 'approved',
        firebase_uid:    row.firebase_uid   || null,
        deviceModel:     row.device_model   || '',
        deviceName:      row.device_name    || '',
        // Límite de dispositivos del alumno (antes se perdía aquí, por lo que la
        // activación de licencia siempre caía al límite de la licencia = 1).
        max_devices:     row.max_devices != null ? parseInt(row.max_devices, 10) : 1,
        producerId:      row.producer_id || null,
    };
}

function rowToCatalog(r) {
    if (!r) return null;
    let docs = [];
    try { docs = JSON.parse(decField(r.documents) || '[]'); } catch { docs = []; }
    return {
        videoId:      r.video_id,
        title:        r.title,
        status:       r.status,
        segmentCount: r.segment_count,
        keyId:        r.key_id,
        error:        r.error,
        uploadedAt:   r.uploaded_at,
        sourceType:   r.source_type || 'local',
        bunnyUrl:     decField(r.bunny_url) || null,
        courseId:     r.course_id || null,
        sortOrder:    r.sort_order || 0,
        moduleId:     r.module_id || null,
        documents:    docs,
        publicCode:   r.public_code || null,
        producerId:   r.producer_id || null,
    };
}

function rowToCourse(r) {
    if (!r) return null;
    return { id: r.id, name: r.name, author: r.author, sortOrder: r.sort_order, createdAt: r.created_at,
             bunnyLibraryId: r.bunny_library_id || null, bunnyPullZone: r.bunny_pull_zone || null,
             producerId: r.producer_id || null };
}

function rowToModule(r) {
    if (!r) return null;
    let docs = [];
    try { docs = JSON.parse(decField(r.documents) || '[]'); } catch { docs = []; }
    return { id: r.id, courseId: r.course_id, parentId: r.parent_id || null, name: r.name, sortOrder: r.sort_order, createdAt: r.created_at, documents: docs, bunnyCollectionId: r.bunny_collection_id || null, producerId: r.producer_id || null };
}

// ================================================================
//  API — STUDENTS
// ================================================================

function normalizeAccountIdentity({ uid, email }, requireUid = true) {
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const normalizedUid = typeof uid === 'string' ? uid.trim() : '';
    if (!normalizedEmail || normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
        (requireUid && !normalizedUid) || normalizedUid.length > 128 ||
        (uid != null && typeof uid !== 'string')) {
        throw dbError('INVALID_ACCOUNT_IDENTITY', 'La identidad de la cuenta no es válida.', 400);
    }
    return { uid: normalizedUid || null, email: normalizedEmail };
}

async function lockAccountIdentity(client, identity) {
    // One lock namespace and stable ordering for login, registration and admin
    // approval: a retry cannot create a second student or steal a UID binding.
    const keys = ['edulock-account-email:' + identity.email];
    if (identity.uid) keys.push('edulock-account-uid:' + identity.uid);
    for (const key of keys.sort()) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    }
}

async function accountStudents(client, identity) {
    const rows = (await client.query(
        `SELECT * FROM students WHERE firebase_uid=$1 OR LOWER(TRIM(email))=$2 ORDER BY id FOR UPDATE`,
        [identity.uid, identity.email]
    )).rows;
    // Historical databases can contain differently cased emails or repeated
    // Firebase UIDs. Never choose an arbitrary first row in that situation.
    if (rows.length > 1) throw dbError('ACCOUNT_DUPLICATE', 'La cuenta tiene registros duplicados. Requiere revisión del administrador.');
    const row = rows[0] || null;
    if (row && (row.email.trim().toLowerCase() !== identity.email ||
        (row.firebase_uid && identity.uid && row.firebase_uid !== identity.uid))) {
        throw dbError('ACCOUNT_IDENTITY_MISMATCH', 'El correo y la identidad de la cuenta no coinciden.');
    }
    return row;
}

async function accountRegistrations(client, identity) {
    const rows = (await client.query(
        `SELECT * FROM registration_requests WHERE firebase_uid=$1 OR LOWER(TRIM(email))=$2
         ORDER BY CASE status WHEN 'suspended' THEN 0 WHEN 'rejected' THEN 1 WHEN 'pending' THEN 2
             WHEN 'approved' THEN 3 ELSE 0 END, requested_at DESC, id FOR UPDATE`, [identity.uid, identity.email]
    )).rows;
    if (rows.some(row => row.email.trim().toLowerCase() !== identity.email ||
        (row.firebase_uid && identity.uid && row.firebase_uid !== identity.uid))) {
        throw dbError('ACCOUNT_IDENTITY_MISMATCH', 'La solicitud pertenece a otra identidad de cuenta.');
    }
    return rows;
}

module.exports.resolveFirebaseAccount = async ({ uid, email, emailVerified } = {}) => {
    const identity = normalizeAccountIdentity({ uid, email });
    return transaction(async client => {
        await lockAccountIdentity(client, identity);
        let student = await accountStudents(client, identity);
        if (student) {
            if (!student.firebase_uid) {
                if (emailVerified !== true) throw dbError('EMAIL_VERIFICATION_REQUIRED', 'Verifica tu correo antes de vincular la cuenta existente.', 403);
                student = (await client.query('UPDATE students SET firebase_uid=$1 WHERE id=$2 RETURNING *',
                    [identity.uid, student.id])).rows[0];
            }
            // Linking never changes grants, license ownership, devices or a
            // suspension. The caller must still enforce the account state.
            return { student: rowToStudent(student), registration: null };
        }
        const registrations = await accountRegistrations(client, identity);
        // A restrictive request outranks an old approval when no student exists.
        // Approved-without-student is a synchronization error for the caller;
        // authentication is never permission to self-create a wildcard user.
        return { student: null, registration: registrations[0] || null };
    });
};

module.exports.findStudentByEmail = async (email) => {
    const res = await q('SELECT * FROM students WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1', [email]);
    return rowToStudent(res.rows[0]);
};

module.exports.getStudentByFirebaseUid = async (firebaseUid) => {
    const res = await q('SELECT * FROM students WHERE firebase_uid = $1', [firebaseUid]);
    return rowToStudent(res.rows[0]);
};

module.exports.linkFirebaseUid = async (studentId, firebaseUid) => {
    await q('UPDATE students SET firebase_uid=$1 WHERE id=$2', [firebaseUid, studentId]);
};

module.exports.findStudentByDeviceId = async (deviceId) => {
    const res = await q('SELECT * FROM students WHERE device_id=$1 LIMIT 1', [deviceId]);
    return rowToStudent(res.rows[0]);
};

// Busca el UUID del alumno dueño de un fingerprint en la tabla devices
module.exports.findStudentByFingerprint = async (fingerprint) => {
    const res = await q(
        "SELECT student_id FROM devices WHERE fingerprint=$1 AND status='active' LIMIT 1",
        [fingerprint]
    );
    return res.rows[0]?.student_id || null;
};

// Actualiza dispositivo y last_login al iniciar sesión
module.exports.updateStudentLogin = async (id, deviceId, deviceModel, deviceName) => {
    await q(
        `UPDATE students SET device_id=$1, device_model=$2, device_name=$3, last_login=$4 WHERE id=$5`,
        [deviceId, deviceModel || '', deviceName || '', new Date().toISOString(), id]
    );
};

module.exports.findStudentById = async (id) => {
    const res = await q('SELECT * FROM students WHERE id = $1', [id]);
    return rowToStudent(res.rows[0]);
};

module.exports.getAllStudents = async () => {
    const res = await q('SELECT * FROM students ORDER BY created_at DESC');
    return res.rows.map(rowToStudent);
};

module.exports.createStudent = async ({ id, email, studentId, name, active, allowedVideos, createdAt }) => {
    await q(
        `INSERT INTO students (id, email, student_id, name, active, allowed_videos, device_id, created_at, last_login)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, email, studentId, name || '', active !== false ? 1 : 0,
         serializeAllowedVideos(allowedVideos), null,
         createdAt || new Date().toISOString(), null]
    );
    const res = await q('SELECT * FROM students WHERE id = $1', [id]);
    return rowToStudent(res.rows[0]);
};

module.exports.bindDevice = async (id, deviceId, lastLogin) => {
    await q('UPDATE students SET device_id=$1, last_login=$2 WHERE id=$3', [deviceId, lastLogin, id]);
};

module.exports.updateStudent = async (id, { name, active, allowedVideos, studentId, resetDevice, deviceId }) => {
    const row = (await q('SELECT * FROM students WHERE id=$1', [id])).rows[0];
    if (!row) return null;
    await q(
        `UPDATE students SET name=$1, active=$2, allowed_videos=$3, student_id=$4, device_id=$5 WHERE id=$6`,
        [
            name !== undefined          ? String(name).slice(0, 100)             : row.name,
            active !== undefined        ? (active ? 1 : 0)                       : row.active,
            allowedVideos !== undefined ? serializeAllowedVideos(allowedVideos)  : row.allowed_videos,
            studentId !== undefined     ? String(studentId).trim()               : row.student_id,
            resetDevice                 ? null : (deviceId !== undefined ? deviceId : row.device_id),
            id,
        ]
    );
    const res = await q('SELECT * FROM students WHERE id=$1', [id]);
    return rowToStudent(res.rows[0]);
};

module.exports.deleteStudent = async (id) => {
    // Borrado TOTAL de raiz: elimina el alumno y TODO lo asociado (dispositivos,
    // licencias, activaciones, sesiones, progreso, etc.) para que el dispositivo
    // quede libre y no vuelva a aparecer "el dispositivo ya tiene otra cuenta".
    let email = null;
    try {
        const r = await q('SELECT email FROM students WHERE id=$1', [id]);
        email = r.rows[0] ? r.rows[0].email : null;
    } catch {}

    // Se borran las activaciones antes que las licencias por si hay dependencias.
    const byStudentId = [
        'activations', 'licenses', 'devices', 'playback_sessions',
        'playback_progress', 'playback_events', 'suspicious_activity',
        'segment_requests', 'student_codes', 'student_courses',
    ];
    for (const t of byStudentId) {
        try { await q(`DELETE FROM ${t} WHERE student_id=$1`, [id]); }
        catch (e) { console.warn(`[deleteStudent] ${t}: ${e.message}`); }
    }

    // Tablas que referencian al alumno por user_id.
    const byUserId = ['audit_log', 'active_sessions', 'watermark_logs'];
    for (const t of byUserId) {
        try { await q(`DELETE FROM ${t} WHERE user_id=$1`, [id]); }
        catch (e) { console.warn(`[deleteStudent] ${t}: ${e.message}`); }
    }

    // Solicitud de registro asociada (por email) para que pueda re-registrarse limpio.
    if (email) {
        try { await q('DELETE FROM registration_requests WHERE email=$1', [email]); }
        catch (e) { console.warn(`[deleteStudent] registration_requests: ${e.message}`); }
    }

    // Finalmente, el propio alumno.
    await q('DELETE FROM students WHERE id=$1', [id]);
};

module.exports.importStudents = async (list) => {
    let added = 0, skipped = 0;
    for (const s of list) {
        const res = await q(
            `INSERT INTO students (id, email, student_id, name, active, allowed_videos, device_id, created_at, last_login)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (email) DO NOTHING`,
            [s.id, s.email, s.studentId, s.name || '', s.active !== false ? 1 : 0,
             serializeAllowedVideos(s.allowedVideos || ['*']), null,
             s.createdAt || new Date().toISOString(), null]
        );
        if (res.rowCount > 0) added++; else skipped++;
    }
    return { added, skipped };
};

// ================================================================
//  API — AUDIT LOG
// ================================================================

module.exports.logDelivery = async ({ fingerprint, userId, videoId, deviceId, studentEmail, ip, userAgent }) => {
    await q(
        `INSERT INTO audit_log (fingerprint, user_id, video_id, device_id, student_email, ip, user_agent, delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [fingerprint, userId, videoId, deviceId || 'desconocido',
         studentEmail || '', ip || 'desconocida', userAgent || 'desconocido',
         new Date().toISOString()]
    );
};

module.exports.detectLeak = async (fingerprint) => {
    const row = (await q('SELECT * FROM audit_log WHERE fingerprint=$1 LIMIT 1', [fingerprint])).rows[0];
    if (!row) return null;
    return { fingerprint: row.fingerprint, userId: row.user_id, videoId: row.video_id, deviceId: row.device_id, ip: row.ip, userAgent: row.user_agent, deliveredAt: row.delivered_at };
};

// Deriva un modelo de dispositivo y SO legibles a partir de un user-agent del navegador.
// Se usa como respaldo cuando la tabla devices no tiene info (p. ej. login web desde Mac).
function deviceFromUserAgent(ua) {
    if (!ua) return { model: '', os: '' };
    const s = String(ua);
    let browser = '';
    if (/Edg\//i.test(s))                                  browser = 'Edge';
    else if (/OPR\/|Opera/i.test(s))                       browser = 'Opera';
    else if (/Chrome\//i.test(s) && !/Chromium/i.test(s))  browser = 'Chrome';
    else if (/Firefox\//i.test(s))                         browser = 'Firefox';
    else if (/Version\/[\d.]+ .*Safari/i.test(s))          browser = 'Safari';
    let plat = '', os = '', m;
    if (/iPhone/i.test(s))                  { plat = 'iPhone'; m = s.match(/iPhone OS (\d+[_\d]*)/i); os = 'iOS' + (m ? ' ' + m[1].replace(/_/g, '.') : ''); }
    else if (/iPad/i.test(s))               { plat = 'iPad';   m = s.match(/OS (\d+[_\d]*)/i);        os = 'iPadOS' + (m ? ' ' + m[1].replace(/_/g, '.') : ''); }
    else if (/Macintosh|Mac OS X/i.test(s)) { plat = 'Mac';    m = s.match(/Mac OS X (\d+[_\d]*)/i);  os = 'macOS' + (m ? ' ' + m[1].replace(/_/g, '.') : ''); }
    else if (/Android/i.test(s))            { plat = 'Android'; m = s.match(/Android (\d+[.\d]*)/i);  os = 'Android' + (m ? ' ' + m[1] : ''); }
    else if (/Windows NT/i.test(s))         { plat = 'Windows'; m = s.match(/Windows NT (\d+\.\d+)/i); const map = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' }; os = 'Windows' + (m ? ' ' + (map[m[1]] || m[1]) : ''); }
    else if (/Linux/i.test(s))              { plat = 'Linux';  os = 'Linux'; }
    const model = (browser && plat) ? `${browser} en ${plat}` : (plat || browser || '');
    return { model, os };
}

module.exports.getAuditLog = async ({ userId, videoId, limit = 500, deliveryOnly = false } = {}) => {
    let rows, count;
    // deliveryOnly=true filtra solo entregas reales (event_type IS NULL)
    const deliveryFilter = deliveryOnly ? ' AND event_type IS NULL' : '';
    // Soporte de búsqueda por email (student_email) además de user_id
    const isEmail = userId && userId.includes('@');
    const uidFilter = isEmail
        ? `(user_id=$1 OR LOWER(student_email)=LOWER($1))`
        : `user_id=$1`;
    if (userId && videoId) {
        rows  = (await q(`SELECT * FROM audit_log WHERE ${uidFilter} AND video_id=$2${deliveryFilter} ORDER BY delivered_at DESC LIMIT $3`, [userId, videoId, limit])).rows;
        count = (await q(`SELECT COUNT(*) as n FROM audit_log WHERE ${uidFilter} AND video_id=$2${deliveryFilter}`, [userId, videoId])).rows[0].n;
    } else if (userId) {
        rows  = (await q(`SELECT * FROM audit_log WHERE ${uidFilter}${deliveryFilter} ORDER BY delivered_at DESC LIMIT $2`, [userId, limit])).rows;
        count = (await q(`SELECT COUNT(*) as n FROM audit_log WHERE ${uidFilter}${deliveryFilter}`, [userId])).rows[0].n;
    } else if (videoId) {
        rows  = (await q(`SELECT * FROM audit_log WHERE video_id=$1${deliveryFilter} ORDER BY delivered_at DESC LIMIT $2`, [videoId, limit])).rows;
        count = (await q(`SELECT COUNT(*) as n FROM audit_log WHERE video_id=$1${deliveryFilter}`, [videoId])).rows[0].n;
    } else {
        rows  = (await q(`SELECT * FROM audit_log WHERE TRUE${deliveryFilter} ORDER BY delivered_at DESC LIMIT $1`, [limit])).rows;
        count = (await q(`SELECT COUNT(*) as n FROM audit_log WHERE TRUE${deliveryFilter}`)).rows[0].n;
    }
    // Enriquecer con modelo de dispositivo desde tabla devices
    // devices.browser = modelo del dispositivo (ej: "samsung SM-S911U" o "EDULOCK Player 1.1.0")
    // devices.os      = sistema operativo (ej: "win32 10.0.26200")
    const deviceIds = [...new Set(rows.map(r => r.device_id).filter(Boolean))];
    const deviceMap = {};
    if (deviceIds.length) {
        try {
            const placeholders = deviceIds.map((_, i) => `$${i + 1}`).join(',');
            const dRes = await q(
                `SELECT fingerprint, browser, os, device_name FROM devices WHERE fingerprint IN (${placeholders})`,
                deviceIds
            );
            for (const d of dRes.rows) deviceMap[d.fingerprint] = d;
        } catch { /* no bloquear */ }
        // Fallback: buscar en watermark_logs si devices no tiene el modelo
        try {
            const missing = deviceIds.filter(id => !deviceMap[id] || !deviceMap[id].browser);
            if (missing.length) {
                const placeholders = missing.map((_, i) => `$${i + 1}`).join(',');
                const wRes = await q(
                    `SELECT DISTINCT ON (device_id) device_id, device_model, brand, manufacturer, os_version
                     FROM watermark_logs WHERE device_id IN (${placeholders}) AND NULLIF(device_model,'') IS NOT NULL
                     ORDER BY device_id, created_at DESC`,
                    missing
                );
                for (const w of wRes.rows) {
                    const model = [w.brand, w.device_model].filter(Boolean).join(' ').trim() || w.device_model;
                    deviceMap[w.device_id] = { browser: model, os: w.os_version || '' };
                }
            }
        } catch { /* no bloquear */ }
    }
    // Enriquecer email desde students.firebase_uid
    const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
    const emailMap = {};
    if (userIds.length) {
        try {
            const placeholders = userIds.map((_, i) => `$${i + 1}`).join(',');
            const eRes = await q(
                `SELECT firebase_uid, email FROM students WHERE NULLIF(firebase_uid,'') IN (${placeholders})`,
                userIds
            );
            for (const s of eRes.rows) if (s.firebase_uid) emailMap[s.firebase_uid] = s.email;
        } catch { /* no bloquear */ }
    }
    return {
        entries: rows.map(r => {
            const dev = deviceMap[r.device_id] || {};
            // browser = modelo del dispositivo (Samsung, EDULOCK Player, etc.)
            const deviceModel = dev.browser || dev.device_name || '';
            const deviceOs    = dev.os || '';
            // Respaldo: si no hay info de dispositivo o el modelo es un user-agent crudo,
            // derivar un modelo/SO legible desde el user-agent guardado en la entrega.
            let finalModel = deviceModel;
            let finalOs    = deviceOs;
            if (!finalModel || /^Mozilla\//i.test(finalModel)) {
                const parsed = deviceFromUserAgent(!finalModel ? r.user_agent : finalModel);
                if (parsed.model) finalModel = parsed.model;
                if (!finalOs && parsed.os) finalOs = parsed.os;
            }
            return {
                id:           r.id,
                fingerprint:  r.fingerprint,
                userId:       r.user_id,
                videoId:      r.video_id,
                deviceId:     r.device_id,
                deviceModel:  finalModel,
                deviceOs:     finalOs,
                studentEmail: r.student_email || emailMap[r.user_id] || '',
                ip:           r.ip,
                userAgent:    r.user_agent,
                deliveredAt:  r.delivered_at,
                eventType:    r.event_type || null,
            };
        }),
        total: parseInt(count, 10),
    };
};

// ================================================================
//  API — CATALOG
// ================================================================

module.exports.loadCatalog = async () => {
    const res = await q('SELECT * FROM catalog ORDER BY uploaded_at DESC');
    return res.rows.map(rowToCatalog);
};

module.exports.getCatalogById = async (videoId) => {
    const res = await q('SELECT * FROM catalog WHERE video_id=$1', [videoId]);
    return rowToCatalog(res.rows[0]);
};

module.exports.getCatalogByPublicCode = async (publicCode) => {
    const res = await q('SELECT * FROM catalog WHERE public_code=$1', [publicCode]);
    return rowToCatalog(res.rows[0]);
};

module.exports.setPublicCode = async (videoId, publicCode) => {
    await q('UPDATE catalog SET public_code=$1 WHERE video_id=$2', [publicCode, videoId]);
};

module.exports.getOrCreatePublicCode = async (videoId, proposedCode) => {
    if (typeof proposedCode !== 'string' || !proposedCode.trim()) {
        throw dbError('INVALID_PUBLIC_CODE', 'El código público propuesto es obligatorio.', 400);
    }
    // PostgreSQL serializes competing updates on this row. Each caller gets
    // the persisted code, including when another request created it first.
    const result = await q(`UPDATE catalog SET public_code=COALESCE(NULLIF(public_code,''),$2)
        WHERE video_id=$1 RETURNING public_code`, [videoId, proposedCode]);
    if (!result.rows[0]) throw dbError('VIDEO_NOT_FOUND', 'Video no encontrado.', 404);
    return result.rows[0].public_code;
};

module.exports.createLaunchToken = async (token, videoId, expiresAt) => {
    await q(
        'INSERT INTO launch_tokens (token, video_id, expires_at, used, created_at) VALUES ($1,$2,$3,0,$4)',
        [token, videoId, expiresAt, new Date().toISOString()]
    );
};

module.exports.getLaunchToken = async (token) => {
    const res = await q('SELECT * FROM launch_tokens WHERE token=$1', [token]);
    return res.rows[0] || null;
};

module.exports.markLaunchTokenUsed = async (token) => {
    await q('UPDATE launch_tokens SET used=1 WHERE token=$1', [token]);
};

// Check-in: el reproductor confirma que abrió este enlace (aunque el alumno
// aún no haya iniciado sesión). Solo marca si el token existe y no ha expirado.
module.exports.markLaunchTokenOpened = async (token) => {
    const res = await q(
        'UPDATE launch_tokens SET opened=1, opened_at=$2 WHERE token=$1 AND expires_at > $3 RETURNING token',
        [token, Date.now(), Date.now()]
    );
    return res.rows.length > 0;
};

module.exports.cleanExpiredLaunchTokens = async () => {
    await q('DELETE FROM launch_tokens WHERE expires_at < $1 OR used=1', [Date.now()]);
};

module.exports.addToCatalog = async ({ videoId, title, status, segmentCount, keyId, error, uploadedAt, sourceType, bunnyUrl, courseId, sortOrder, producerId }) => {
    return transaction(async client => {
        const candidate = (await client.query('SELECT producer_id FROM catalog WHERE video_id=$1', [videoId])).rows[0];
        const initialCourse = courseId ? (await client.query('SELECT producer_id FROM courses WHERE id=$1', [courseId])).rows[0] : null;
        const effectiveOwner = producerId || candidate?.producer_id || initialCourse?.producer_id || null;
        if (effectiveOwner) {
            const owner = (await client.query('SELECT id,active FROM producers WHERE id=$1 FOR UPDATE', [effectiveOwner])).rows[0];
            if (!owner || ![1, true].includes(owner.active)) throw dbError('PRODUCER_UNAVAILABLE', 'Productor no disponible.', 403);
        }
        const course = courseId ? (await client.query('SELECT id,producer_id FROM courses WHERE id=$1 FOR SHARE', [courseId])).rows[0] : null;
        if (courseId && !course) throw dbError('COURSE_NOT_FOUND', 'Curso no encontrado.', 404);
        if (course && (course.producer_id || null) !== effectiveOwner) throw dbError('COURSE_OWNER_CONFLICT', 'El video y el curso deben tener el mismo propietario.', 403);
        const existing = (await client.query('SELECT producer_id,course_id,module_id FROM catalog WHERE video_id=$1 FOR UPDATE', [videoId])).rows[0];
        if (existing && (existing.producer_id || null) !== effectiveOwner) throw dbError('VIDEO_OWNER_CONFLICT', 'El identificador del video pertenece a otra cuenta.', 409);
        if (existing && (existing.course_id || null) !== (courseId || null)) throw dbError('VIDEO_COURSE_CONFLICT', 'Usa la operación de mover video para cambiar su curso y sus recursos.', 409);
        const result = await client.query(
        `INSERT INTO catalog (video_id, title, status, segment_count, key_id, error, uploaded_at, source_type, bunny_url, course_id, sort_order, producer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (video_id) DO UPDATE SET
           title=EXCLUDED.title, status=EXCLUDED.status, segment_count=EXCLUDED.segment_count,
            key_id=COALESCE(EXCLUDED.key_id,catalog.key_id), error=EXCLUDED.error, source_type=EXCLUDED.source_type,
           bunny_url=EXCLUDED.bunny_url, course_id=EXCLUDED.course_id, sort_order=EXCLUDED.sort_order,
           producer_id=COALESCE(EXCLUDED.producer_id, catalog.producer_id)
         WHERE catalog.producer_id IS NOT DISTINCT FROM EXCLUDED.producer_id RETURNING video_id`,
        [videoId, title || videoId, status || 'processing', segmentCount || 0,
         keyId || null, error || null, uploadedAt || new Date().toISOString(),
         sourceType || 'local', encField(bunnyUrl || null), courseId || null, sortOrder || 0, effectiveOwner]
    );
        if (!result.rows.length) throw dbError('VIDEO_OWNER_CONFLICT', 'El identificador del video pertenece a otra cuenta.', 409);
    // Si el admin lo re-agrega deliberadamente, quitar el tombstone
        await client.query('DELETE FROM deleted_videos WHERE video_id=$1', [videoId]);
    });
};

module.exports.updateCatalogEntry = async (fields) => {
    const columns = { status: 'status', segmentCount: 'segment_count', keyId: 'key_id', error: 'error' };
    const values = [], assignments = [];
    for (const [field, column] of Object.entries(columns)) {
        if (Object.prototype.hasOwnProperty.call(fields, field) && fields[field] !== undefined) {
            values.push(fields[field]);
            assignments.push(`${column}=$${values.length}`);
        }
    }
    if (!assignments.length) return module.exports.getCatalogById(fields.videoId);
    values.push(fields.videoId);
    const result = await q(`UPDATE catalog SET ${assignments.join(', ')} WHERE video_id=$${values.length} RETURNING *`, values);
    return rowToCatalog(result.rows[0]);
};

module.exports.deleteCatalogEntry = async (videoId) => {
    await q('DELETE FROM catalog WHERE video_id=$1', [videoId]);
    // Registrar tombstone para que el seed de arranque no lo vuelva a crear
    try {
        await q(
            `INSERT INTO deleted_videos (video_id, deleted_at) VALUES ($1,$2)
             ON CONFLICT (video_id) DO NOTHING`,
            [videoId, new Date().toISOString()]
        );
    } catch { /* no bloquear la eliminación si falla el tombstone */ }
};

module.exports.getCatalogByCourse = async (courseId) => {
    const res = await q('SELECT * FROM catalog WHERE course_id=$1 ORDER BY sort_order ASC, uploaded_at DESC', [courseId]);
    return res.rows.map(rowToCatalog);
};

module.exports.getCatalogUnassigned = async () => {
    const res = await q('SELECT * FROM catalog WHERE course_id IS NULL ORDER BY uploaded_at DESC');
    return res.rows.map(rowToCatalog);
};

// ================================================================
//  API — COURSES
// ================================================================

module.exports.getAllCourses = async () => {
    const res = await q('SELECT * FROM courses ORDER BY sort_order ASC, created_at DESC');
    return res.rows.map(rowToCourse);
};

module.exports.getCourseById = async (id) => {
    const res = await q('SELECT * FROM courses WHERE id=$1', [id]);
    return rowToCourse(res.rows[0]);
};

module.exports.getCoursesByProducer = async (producerId) => {
    const res = await q('SELECT * FROM courses WHERE producer_id=$1 ORDER BY sort_order ASC, created_at DESC', [producerId]);
    return res.rows.map(rowToCourse);
};

module.exports.getCourseIdsByLibrary = async (libraryId) => {
    const res = await q('SELECT id FROM courses WHERE bunny_library_id=$1', [libraryId]);
    return res.rows.map(r => r.id);
};

module.exports.createCourse = async ({ id, name, author, sortOrder, producerId }) => {
    return transaction(async client => {
        if (producerId) {
            const producer = (await client.query('SELECT id,active FROM producers WHERE id=$1 FOR UPDATE', [producerId])).rows[0];
            if (!producer || ![1, true].includes(producer.active)) throw dbError('PRODUCER_UNAVAILABLE', 'Productor no disponible.', 403);
        }
        await client.query(
        'INSERT INTO courses (id, name, author, sort_order, created_at, producer_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING',
        [id, name, author || '', sortOrder || 0, new Date().toISOString(), producerId || null]
    );
    const res = await client.query('SELECT * FROM courses WHERE id=$1 FOR SHARE', [id]);
    if ((res.rows[0]?.producer_id || null) !== (producerId || null)) {
        throw dbError('COURSE_OWNER_CONFLICT', 'El identificador del curso pertenece a otra cuenta.');
    }
    return rowToCourse(res.rows[0]);
    });
};

module.exports.updateCourse = async (id, { name, author }) => {
    await q('UPDATE courses SET name=$1, author=$2 WHERE id=$3', [name, author || '', id]);
    const res = await q('SELECT * FROM courses WHERE id=$1', [id]);
    return rowToCourse(res.rows[0]);
};

module.exports.deleteCourse = async (id) => {
    return transaction(async client => {
        await client.query('UPDATE catalog SET course_id=NULL, module_id=NULL WHERE course_id=$1', [id]);
        await client.query('DELETE FROM modules WHERE course_id=$1', [id]);
        await client.query('DELETE FROM courses WHERE id=$1', [id]);
    });
};

module.exports.moveVideoToCourse = async (videoId, courseId) => {
    const video = await module.exports.getCatalogById(videoId);
    if (!video) throw dbError('VIDEO_NOT_FOUND', 'Video no encontrado.', 404);
    if (courseId) {
        const course = await module.exports.getCourseById(courseId);
        if (!course) throw dbError('COURSE_NOT_FOUND', 'Curso no encontrado.', 404);
        if ((course.producerId || null) !== (video.producerId || null)) {
            throw dbError('COURSE_OWNER_CONFLICT', 'No se puede mover contenido entre productores.', 403);
        }
    }
    const maxRes = await q('SELECT COALESCE(MAX(sort_order),0) as m FROM catalog WHERE course_id=$1', [courseId || null]);
    const maxSort = parseInt(maxRes.rows[0]?.m || 0, 10);
    await q('UPDATE catalog SET course_id=$1, module_id=NULL, sort_order=$2 WHERE video_id=$3', [courseId || null, maxSort + 1, videoId]);
};

module.exports.reorderVideos = async (videoOrders) => {
    for (const { videoId, sortOrder } of videoOrders) {
        await q('UPDATE catalog SET sort_order=$1 WHERE video_id=$2', [sortOrder, videoId]);
    }
};

// ================================================================
//  API — MODULES
// ================================================================

module.exports.getModulesByCourse = async (courseId) => {
    const res = await q('SELECT * FROM modules WHERE course_id=$1 ORDER BY sort_order ASC, created_at ASC', [courseId]);
    return res.rows.map(rowToModule);
};

module.exports.getModuleById = async (id) => {
    const res = await q('SELECT * FROM modules WHERE id=$1', [id]);
    return rowToModule(res.rows[0]);
};

module.exports.createModule = async ({ id, courseId, parentId, name, sortOrder, producerId }) => {
    return transaction(async client => {
    const initialCourse = (await client.query('SELECT producer_id FROM courses WHERE id=$1', [courseId])).rows[0];
    const effectiveOwner = producerId || initialCourse?.producer_id || null;
    if (effectiveOwner) {
        const producer = (await client.query('SELECT id,active FROM producers WHERE id=$1 FOR UPDATE', [effectiveOwner])).rows[0];
        if (!producer || ![1, true].includes(producer.active)) throw dbError('PRODUCER_UNAVAILABLE', 'Productor no disponible.', 403);
    }
    const course = rowToCourse((await client.query('SELECT * FROM courses WHERE id=$1 FOR SHARE', [courseId])).rows[0]);
    if (!course) throw dbError('COURSE_NOT_FOUND', 'Curso no encontrado.', 404);
    if (producerId && course.producerId !== producerId) throw dbError('COURSE_FORBIDDEN', 'Curso no disponible.', 403);
    if (parentId) {
        const parent = rowToModule((await client.query('SELECT * FROM modules WHERE id=$1 FOR SHARE', [parentId])).rows[0]);
        if (!parent || parent.courseId !== courseId || (parent.producerId || null) !== (course.producerId || null)) throw dbError('INVALID_PARENT_MODULE', 'El módulo padre no pertenece al curso.', 400);
    }
    await client.query(
        'INSERT INTO modules (id, course_id, parent_id, name, sort_order, created_at, producer_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',
        [id, courseId, parentId || null, name.trim().slice(0, 120), sortOrder || 0, new Date().toISOString(), course.producerId]
    );
    const res = await client.query('SELECT * FROM modules WHERE id=$1 FOR SHARE', [id]);
    if (res.rows[0]?.course_id !== courseId || (res.rows[0]?.parent_id || null) !== (parentId || null) || (res.rows[0]?.producer_id || null) !== (course.producerId || null)) {
        throw dbError('MODULE_CONFLICT', 'El identificador del módulo ya corresponde a otra ubicación.');
    }
    return rowToModule(res.rows[0]);
    });
};

module.exports.updateModule = async (id, { name, sortOrder }) => {
    const row = (await q('SELECT * FROM modules WHERE id=$1', [id])).rows[0];
    if (!row) return null;
    await q('UPDATE modules SET name=$1, sort_order=$2 WHERE id=$3',
        [name.trim().slice(0, 120), sortOrder !== undefined ? sortOrder : row.sort_order, id]);
    const res = await q('SELECT * FROM modules WHERE id=$1', [id]);
    return rowToModule(res.rows[0]);
};

module.exports.deleteModule = async (id) => {
    return transaction(async client => {
        const descendants = (await client.query(`WITH RECURSIVE subtree AS (
            SELECT id, course_id FROM modules WHERE id=$1
            UNION SELECT m.id, m.course_id FROM modules m JOIN subtree s
              ON m.parent_id=s.id AND m.course_id=s.course_id
        ) SELECT id FROM subtree`, [id])).rows.map(row => row.id);
        if (!descendants.length) return;
        await client.query('UPDATE catalog SET module_id=NULL WHERE module_id=ANY($1::text[])', [descendants]);
        await client.query('DELETE FROM modules WHERE id=ANY($1::text[])', [descendants]);
    });
};

module.exports.deleteModulesByCourse = async (courseId) => {
    return transaction(async client => {
        await client.query('UPDATE catalog SET module_id=NULL WHERE module_id IN (SELECT id FROM modules WHERE course_id=$1)', [courseId]);
        await client.query('DELETE FROM modules WHERE course_id=$1', [courseId]);
    });
};

module.exports.moveVideoToModule = async (videoId, moduleId) => {
    if (moduleId) {
        const video = await module.exports.getCatalogById(videoId);
        const mod = await module.exports.getModuleById(moduleId);
        if (!video || !mod || mod.courseId !== video.courseId) {
            throw dbError('MODULE_COURSE_MISMATCH', 'El módulo no pertenece al curso del video.', 400);
        }
    }
    await q('UPDATE catalog SET module_id=$1 WHERE video_id=$2', [moduleId || null, videoId]);
};

module.exports.updateCatalogDocuments = async (videoId, documents) => {
    const json = JSON.stringify(Array.isArray(documents) ? documents : []);
    await q('UPDATE catalog SET documents=$1 WHERE video_id=$2', [encField(json), videoId]);
};

module.exports.updateModuleDocuments = async (moduleId, documents) => {
    const json = JSON.stringify(Array.isArray(documents) ? documents : []);
    await q('UPDATE modules SET documents=$1 WHERE id=$2', [encField(json), moduleId]);
};

// ================================================================
//  API — APP CONFIG
// ================================================================

module.exports.getConfig = async (key) => {
    const res = await q('SELECT value FROM app_config WHERE key=$1', [key]);
    return res.rows[0] ? res.rows[0].value : null;
};

module.exports.setConfig = async (key, value) => {
    await q(
        'INSERT INTO app_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
        [key, value]
    );
};

// ================================================================
//  API — BUNNY STREAM (biblioteca por curso, colección por módulo)
// ================================================================

module.exports.setCourseBunnyLibrary = async (courseId, { libraryId, libraryKey, pullZone, tokenKey }) => {
    await q(`UPDATE courses SET bunny_library_id=$1, bunny_library_key=$2, bunny_pull_zone=$3,
             bunny_token_key=CASE WHEN bunny_library_id IS DISTINCT FROM $1 THEN $4 ELSE COALESCE($4,bunny_token_key) END WHERE id=$5`,
        [String(libraryId), libraryKey || null, pullZone || null, tokenKey || null, courseId]);
};

module.exports.getCourseBunny = async (courseId) => {
    const r = (await q('SELECT bunny_library_id, bunny_library_key, bunny_pull_zone, bunny_token_key FROM courses WHERE id=$1', [courseId])).rows[0];
    if (!r) return null;
    return { libraryId: r.bunny_library_id || null, libraryKey: r.bunny_library_key || null, pullZone: r.bunny_pull_zone || null, tokenKey: r.bunny_token_key || null };
};

module.exports.setModuleBunnyCollection = async (moduleId, collectionId) => {
    await q('UPDATE modules SET bunny_collection_id=$1 WHERE id=$2', [collectionId || null, moduleId]);
};

module.exports.getModuleBunnyCollection = async (moduleId) => {
    const r = (await q('SELECT bunny_collection_id FROM modules WHERE id=$1', [moduleId])).rows[0];
    return r ? (r.bunny_collection_id || null) : null;
};

// Session advisory locks serialize remote provisioning across Node processes.
// Callers must not open another lock with the same key inside this callback.
module.exports.withStreamLock = async (key, fn) => {
    const client = await pool.connect();
    let locked = false;
    try {
        const result = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`edulock-stream:${key}`]);
        locked = result.rows[0]?.locked === true;
        if (!locked) throw dbError('STREAM_BUSY', 'Esta operación sigue en curso. Consulta su estado antes de reintentar.');
        return await fn();
    } finally {
        try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`edulock-stream:${key}`]); }
        finally { client.release(); }
    }
};

module.exports.getStreamResource = async key =>
    (await q('SELECT * FROM stream_resources WHERE resource_key=$1', [key])).rows[0] || null;

module.exports.setStreamResource = async (key, { remoteName, state, remoteId = null }) => {
    await q(`INSERT INTO stream_resources(resource_key, remote_name, state, remote_id, updated_at)
             VALUES($1,$2,$3,$4,$5)
             ON CONFLICT(resource_key) DO UPDATE SET state=EXCLUDED.state,
               remote_id=COALESCE(EXCLUDED.remote_id, stream_resources.remote_id), updated_at=EXCLUDED.updated_at`,
    [key, remoteName, state, remoteId == null ? null : String(remoteId), new Date().toISOString()]);
};

// Forgets a remote association that no longer exists (e.g. a collection deleted in
// Bunny) so the next provisioning attempt reconciles or creates it again.
module.exports.clearStreamResource = async key => { await q('DELETE FROM stream_resources WHERE resource_key=$1', [key]); };

module.exports.getStreamOperation = async id =>
    (await q('SELECT * FROM stream_operations WHERE id=$1', [id])).rows[0] || null;
module.exports.getStreamOperationByVideo = async videoId =>
    (await q('SELECT * FROM stream_operations WHERE video_id=$1', [videoId])).rows[0] || null;

module.exports.reserveStreamOperation = async ({ id, actorKey, courseId, moduleId, title, fileSize, fileSha256 }) => {
    const now = new Date().toISOString();
    await q(`INSERT INTO stream_operations(id, actor_key, course_id, module_id, title, file_size, file_sha256, created_at, updated_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT(id) DO NOTHING`,
    [id, actorKey, courseId, moduleId || null, title, fileSize, fileSha256, now]);
    return module.exports.getStreamOperation(id);
};

module.exports.updateStreamOperation = async (id, fields) => {
    const columns = { videoId: 'video_id', state: 'state', uploadPercent: 'upload_percent',
        providerStatus: 'provider_status', encodeProgress: 'encode_progress', errorCode: 'error_code', errorDetail: 'error_detail' };
    const values = [], sets = [];
    for (const [key, column] of Object.entries(columns)) if (fields[key] !== undefined) {
        values.push(fields[key]); sets.push(`${column}=$${values.length}`);
    }
    values.push(new Date().toISOString()); sets.push(`updated_at=$${values.length}`);
    values.push(id);
    return (await q(`UPDATE stream_operations SET ${sets.join(', ')} WHERE id=$${values.length} RETURNING *`, values)).rows[0] || null;
};

module.exports.getPendingStreamVideos = async (limit = 20) => {
    const count = Math.max(1, Math.min(100, Number(limit) || 20));
    return (await q(`SELECT c.video_id FROM catalog c
        JOIN courses co ON co.id=c.course_id
        LEFT JOIN stream_operations op ON op.video_id=c.video_id
        WHERE c.source_type='bunny' AND co.bunny_library_id IS NOT NULL
          AND (c.status IN ('processing','uploading') OR op.state IN ('processing','uploading'))
        ORDER BY COALESCE(op.updated_at,c.uploaded_at) ASC LIMIT $1`, [count])).rows.map(r => r.video_id);
};

// ================================================================
//  API — LISTA BLANCA DE SEGURIDAD (anti-falsos-positivos)
// ================================================================

const DEFAULT_SECURITY_WHITELIST = { drivers: [], dlls: [], allowHypervisor: false };

module.exports.getSecurityWhitelist = async () => {
    try {
        const res = await q('SELECT value FROM app_config WHERE key=$1', ['security_whitelist']);
        if (!res.rows[0] || !res.rows[0].value) return { ...DEFAULT_SECURITY_WHITELIST };
        const parsed = JSON.parse(res.rows[0].value);
        return {
            drivers: Array.isArray(parsed.drivers) ? parsed.drivers : [],
            dlls: Array.isArray(parsed.dlls) ? parsed.dlls : [],
            allowHypervisor: parsed.allowHypervisor === true,
        };
    } catch {
        return { ...DEFAULT_SECURITY_WHITELIST };
    }
};

module.exports.setSecurityWhitelist = async ({ drivers, dlls, allowHypervisor }) => {
    const clean = (arr) => (Array.isArray(arr) ? arr : [])
        .map(s => String(s || '').trim().toLowerCase())
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i)   // únicos
        .slice(0, 200)
        .map(s => s.slice(0, 120));
    const payload = {
        drivers: clean(drivers),
        dlls: clean(dlls),
        allowHypervisor: allowHypervisor === true,
    };
    await q(
        'INSERT INTO app_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
        ['security_whitelist', JSON.stringify(payload)]
    );
    return payload;
};

// ================================================================
//  API — ACTIVE SESSIONS
// ================================================================

module.exports.createSession = async (sessionId, userId, videoId, deviceId = null) => {
    const now = Date.now();
    await q(
        `INSERT INTO active_sessions (session_id, user_id, video_id, started_at, last_seen, current_pos, device_id)
         VALUES ($1,$2,$3,$4,$5,0,$6)
         ON CONFLICT (session_id) DO UPDATE SET user_id=$2, video_id=$3, started_at=$4, last_seen=$5, current_pos=0, device_id=$6`,
        [sessionId, userId, videoId, now, now, deviceId]
    );
};

module.exports.heartbeatSession = async (sessionId, currentTime) => {
    const ct = Math.floor(Number(currentTime) || 0);
    const res = await q('UPDATE active_sessions SET last_seen=$1, current_pos=$2 WHERE session_id=$3', [Date.now(), ct, sessionId]);
    return (res.rowCount || 0) > 0;
};

module.exports.getActiveSessionsByUser = async (userId) => {
    const threshold = Date.now() - 90_000;
    const res = await q('SELECT * FROM active_sessions WHERE user_id=$1 AND last_seen>$2', [userId, threshold]);
    return res.rows;
};

module.exports.endSession = async (sessionId) => {
    await q('DELETE FROM active_sessions WHERE session_id=$1', [sessionId]);
};

module.exports.countActiveSessions = async (userId) => {
    const threshold = Date.now() - 90_000;
    const res = await q('SELECT COUNT(*) as n FROM active_sessions WHERE user_id=$1 AND last_seen>$2', [userId, threshold]);
    return parseInt(res.rows[0].n, 10);
};

module.exports.cleanExpiredSessions = async () => {
    const threshold = Date.now() - 90_000;
    await q('DELETE FROM active_sessions WHERE last_seen<$1', [threshold]);
};

// ================================================================
//  API — ALLOWED DOMAINS
// ================================================================

module.exports.getAllowedDomains = async () => {
    const res = await q('SELECT domain FROM allowed_domains ORDER BY domain');
    return res.rows.map(r => r.domain);
};

module.exports.addAllowedDomain = async (domain) => {
    await q('INSERT INTO allowed_domains (domain) VALUES ($1) ON CONFLICT DO NOTHING', [domain]);
};

module.exports.removeAllowedDomain = async (domain) => {
    await q('DELETE FROM allowed_domains WHERE domain=$1', [domain]);
};

// ================================================================
//  API — PLAYBACK SESSIONS
// ================================================================

module.exports.createPlaybackSession = async ({ sessionId, studentId, studentEmail, courseId, lessonId, deviceId, ttlSeconds = 900 }) => {
    const now = new Date();
    const expires = new Date(now.getTime() + ttlSeconds * 1000);
    await q(
        `INSERT INTO playback_sessions (session_id, student_id, student_email, course_id, lesson_id, device_id, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [sessionId, studentId, studentEmail, courseId, lessonId, deviceId, now.toISOString(), expires.toISOString()]
    );
};

module.exports.getPlaybackSession = async (sessionId) => {
    const row = (await q('SELECT * FROM playback_sessions WHERE session_id=$1', [sessionId])).rows[0];
    if (!row) return null;
    return { sessionId: row.session_id, studentId: row.student_id, studentEmail: row.student_email, courseId: row.course_id, lessonId: row.lesson_id, deviceId: row.device_id, createdAt: row.created_at, expiresAt: row.expires_at };
};

module.exports.logPlaybackEvent = async ({ sessionId, studentId, lessonId, deviceId, ip, userAgent, eventType }) => {
    const fp = `pb:${sessionId}:${eventType}:${Date.now()}`;
    await q(
        `INSERT INTO audit_log (fingerprint, user_id, video_id, device_id, ip, user_agent, delivered_at, event_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [fp, studentId, lessonId, deviceId || 'unknown', ip || 'unknown', userAgent || 'unknown', new Date().toISOString(), eventType]
    );
};

module.exports.cleanExpiredPlaybackSessions = async () => {
    await q('DELETE FROM playback_sessions WHERE expires_at < $1', [new Date().toISOString()]);
};

// ================================================================
//  API — DEVICES
// ================================================================

module.exports.getDevicesByStudent = async (studentId) => {
    const res = await q('SELECT * FROM devices WHERE student_id=$1 ORDER BY first_seen ASC', [studentId]);
    return res.rows;
};

module.exports.getActiveDevicesByStudent = async (studentId) => {
    const res = await q("SELECT * FROM devices WHERE student_id=$1 AND status='active' ORDER BY first_seen ASC", [studentId]);
    return res.rows;
};

module.exports.countActiveDevices = async (studentId) => {
    const res = await q("SELECT COUNT(*) as n FROM devices WHERE student_id=$1 AND status='active'", [studentId]);
    return parseInt(res.rows[0].n, 10);
};

module.exports.registerOrValidateDevice = async (studentId, fingerprint, meta = {}, maxDevicesFallback = 1) => {
    const now = new Date().toISOString();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Admin identities (admin_<firebase uid>) have no students row. Lock
        // every device owner explicitly so the count+insert is also atomic for
        // them, including concurrent retries for the same fingerprint.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['edulock-device-owner:' + studentId]);

        // Límite efectivo: el valor real del alumno manda (fuente única de verdad).
        // Se bloquea la fila del alumno (FOR UPDATE) para impedir condiciones de carrera
        // (que dos logins simultáneos pasen el chequeo y se registren de más).
        let effectiveLimit = maxDevicesFallback;
        const stRes = await client.query('SELECT max_devices FROM students WHERE id=$1 FOR UPDATE', [studentId]);
        if (stRes.rows[0] && stRes.rows[0].max_devices != null) {
            effectiveLimit = parseInt(stRes.rows[0].max_devices, 10);
        }
        if (!Number.isFinite(effectiveLimit) || effectiveLimit < 1) effectiveLimit = 1;

        const existing = (await client.query('SELECT * FROM devices WHERE student_id=$1 AND fingerprint=$2', [studentId, fingerprint])).rows[0];
        if (existing) {
            if (existing.status === 'blocked') {
                await client.query('ROLLBACK');
                return { ok: false, device: existing, reason: 'device_blocked' };
            }
            await client.query(
                `UPDATE devices SET last_seen=$1,
                 browser = COALESCE(NULLIF($4,''), browser),
                 os      = COALESCE(NULLIF($5,''), os),
                 city    = COALESCE(NULLIF($6,''), city)
                 WHERE student_id=$2 AND fingerprint=$3`,
                [now, studentId, fingerprint,
                 (meta.browser || '').slice(0, 100),
                 (meta.os || '').slice(0, 100),
                 (meta.city || '').slice(0, 100)]
            );
            await client.query('COMMIT');
            return { ok: true, device: existing, reason: 'existing', limit: effectiveLimit };
        }

        const activeCount = parseInt((await client.query("SELECT COUNT(*) as n FROM devices WHERE student_id=$1 AND status='active'", [studentId])).rows[0].n, 10);
        if (activeCount >= effectiveLimit) {
            await client.query('ROLLBACK');
            return { ok: false, device: null, reason: 'device_limit_exceeded', limit: effectiveLimit, activeCount };
        }

        const id = uuid4();
        await client.query(
            `INSERT INTO devices (id, student_id, fingerprint, device_name, browser, os, city, status, first_seen, last_seen)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`,
            [id, studentId, fingerprint,
             (meta.deviceName || '').slice(0, 100), (meta.browser || '').slice(0, 100),
             (meta.os || '').slice(0, 100), (meta.city || '').slice(0, 100) || null,
             now, now]
        );
        const device = (await client.query('SELECT * FROM devices WHERE student_id=$1 AND fingerprint=$2', [studentId, fingerprint])).rows[0];
        await client.query('COMMIT');
        return { ok: true, device, reason: 'new', limit: effectiveLimit };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
};

// Devuelve el límite de dispositivos del alumno (default 1).
module.exports.getStudentMaxDevices = async (studentId) => {
    const r = await q('SELECT max_devices FROM students WHERE id=$1', [studentId]);
    const v = r.rows[0] ? parseInt(r.rows[0].max_devices, 10) : 1;
    return Number.isFinite(v) && v >= 1 ? v : 1;
};

// Establece el límite de dispositivos del alumno (mínimo 1).
module.exports.setStudentMaxDevices = async (studentId, n) => {
    let val = parseInt(n, 10);
    if (!Number.isFinite(val) || val < 1) val = 1;
    if (val > 50) val = 50;
    await q('UPDATE students SET max_devices=$1 WHERE id=$2', [val, studentId]);
    // Propagar el mismo límite a las licencias ACTIVAS del alumno, para que el
    // panel (que muestra license.max_devices) y el fallback de activación queden
    // consistentes con el límite del alumno.
    await q(`UPDATE licenses SET max_devices=$1 WHERE student_id=$2 AND status='active'`, [val, studentId]).catch(() => {});
    return val;
};

module.exports.resetStudentDevices = async (studentId) => {
    await q('DELETE FROM devices WHERE student_id=$1', [studentId]);
};

// ================================================================
//  API — PLAYBACK PROGRESS
// ================================================================

module.exports.saveProgress = async ({ studentId, videoId, courseId, progressPercent, lastPosition, deviceId, city }) => {
    const now = new Date().toISOString();
    const pct = Math.min(100, Math.max(0, Number(progressPercent) || 0));
    const pos = Math.floor(Number(lastPosition) || 0);
    const existing = (await q('SELECT id, started_at, completed FROM playback_progress WHERE student_id=$1 AND video_id=$2', [studentId, videoId])).rows[0];
    await q(
        `INSERT INTO playback_progress (id, student_id, video_id, course_id, progress_percent, last_position, started_at, last_seen_at, completed, device_id, city)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (student_id, video_id) DO UPDATE SET
           progress_percent = GREATEST(playback_progress.progress_percent, EXCLUDED.progress_percent),
           last_position    = EXCLUDED.last_position,
           last_seen_at     = EXCLUDED.last_seen_at,
           completed        = GREATEST(playback_progress.completed, EXCLUDED.completed),
           device_id        = EXCLUDED.device_id,
           city             = COALESCE(EXCLUDED.city, playback_progress.city)`,
        [existing?.id || uuid4(), studentId, videoId, courseId || null,
         pct, pos, existing?.started_at || now, now,
         pct >= 90 ? 1 : (existing?.completed || 0), deviceId || null,
         city ? city.slice(0, 100) : null]
    );
};

module.exports.getProgress = async (studentId, videoId) => {
    const res = await q('SELECT * FROM playback_progress WHERE student_id=$1 AND video_id=$2', [studentId, videoId]);
    return res.rows[0] || null;
};

module.exports.getProgressByStudent = async (studentId) => {
    const res = await q('SELECT * FROM playback_progress WHERE student_id=$1 ORDER BY last_seen_at DESC', [studentId]);
    return res.rows;
};

module.exports.getAllProgress = async (limit = 500) => {
    const res = await q('SELECT * FROM playback_progress ORDER BY last_seen_at DESC LIMIT $1', [limit]);
    return res.rows;
};

// ================================================================
//  API — PLAYBACK EVENTS
// ================================================================

const ALLOWED_PB_EVENTS = new Set([
    'play', 'pause', 'ended', 'seek', 'error',
    'devtools_open', 'screen_recording_detected', 'visibility_hidden',
    'progress_save', 'session_start', 'session_end',
    'device_blocked', 'token_expired', 'access_denied',
]);

module.exports.insertPlaybackEvent = async ({ studentId, videoId, courseId, deviceId, eventType, progressPercent, currentTime, metadata }) => {
    if (!ALLOWED_PB_EVENTS.has(eventType)) return;
    await q(
        `INSERT INTO playback_events (student_id, video_id, course_id, device_id, event_type, progress_percent, current_pos, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [studentId, videoId, courseId || null, deviceId || null, eventType,
         progressPercent != null ? Number(progressPercent) : null,
         currentTime     != null ? Math.floor(Number(currentTime)) : null,
         metadata ? JSON.stringify(metadata).slice(0, 500) : null,
         new Date().toISOString()]
    );
};

module.exports.getRecentEvents = async (limit = 100) => {
    const res = await q('SELECT * FROM playback_events ORDER BY created_at DESC LIMIT $1', [limit]);
    return res.rows;
};

module.exports.getEventsByStudent = async (studentId, limit = 200) => {
    const res = await q('SELECT * FROM playback_events WHERE student_id=$1 ORDER BY created_at DESC LIMIT $2', [studentId, limit]);
    return res.rows;
};

// ================================================================
//  API — SUSPICIOUS ACTIVITY
// ================================================================

module.exports.logSuspiciousActivity = async ({ studentId, deviceId, type, severity = 'low', description, metadata }) => {
    await q(
        `INSERT INTO suspicious_activity (student_id, device_id, type, severity, description, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [studentId, deviceId || null, type, severity,
         description ? String(description).slice(0, 500) : null,
         metadata ? JSON.stringify(metadata).slice(0, 1000) : null,
         new Date().toISOString()]
    );
};

module.exports.getSuspiciousActivity = async (limit = 200) => {
    const res = await q(`
        SELECT sa.*, COALESCE(
            NULLIF((SELECT st.email FROM students st
                      WHERE st.id = sa.student_id
                         OR st.student_id = sa.student_id
                         OR st.email = sa.student_id
                      LIMIT 1), ''),
            sa.student_id
        ) AS email
        FROM suspicious_activity sa
        ORDER BY sa.created_at DESC LIMIT $1`, [limit]);
    return res.rows;
};

module.exports.getUnreviewedSuspicious = async (limit = 100) => {
    const res = await q(`
        SELECT sa.*, COALESCE(
            NULLIF((SELECT st.email FROM students st
                      WHERE st.id = sa.student_id
                         OR st.student_id = sa.student_id
                         OR st.email = sa.student_id
                      LIMIT 1), ''),
            sa.student_id
        ) AS email
        FROM suspicious_activity sa
        WHERE sa.reviewed=0 ORDER BY sa.created_at DESC LIMIT $1`, [limit]);
    return res.rows;
};

module.exports.getSuspiciousByStudent = async (studentId, limit = 100) => {
    const res = await q(`
        SELECT sa.*, COALESCE(
            NULLIF((SELECT st.email FROM students st
                      WHERE st.id = sa.student_id
                         OR st.student_id = sa.student_id
                         OR st.email = sa.student_id
                      LIMIT 1), ''),
            sa.student_id
        ) AS email
        FROM suspicious_activity sa
        WHERE sa.student_id=$1 ORDER BY sa.created_at DESC LIMIT $2`, [studentId, limit]);
    return res.rows;
};

module.exports.markSuspiciousReviewed = async (id) => {
    await q('UPDATE suspicious_activity SET reviewed=1 WHERE id=$1', [id]);
};

module.exports.countUnreviewed = async () => {
    const res = await q('SELECT COUNT(*) as n FROM suspicious_activity WHERE reviewed=0');
    return parseInt(res.rows[0].n, 10);
};

// ================================================================
//  API — SEGMENT REQUESTS (auditoría granular HLS anti-descarga)
// ================================================================

module.exports.logSegmentRequest = async ({ studentId, videoId, sessionId, deviceId, segIndex, ip, userAgent }) => {
    await q(
        `INSERT INTO segment_requests (student_id, video_id, session_id, device_id, seg_index, ip, user_agent, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [studentId || null, videoId, sessionId || null, deviceId || null,
         Number.isFinite(segIndex) ? segIndex : null,
         ip ? String(ip).slice(0, 64) : null,
         userAgent ? String(userAgent).slice(0, 200) : null,
         new Date().toISOString()]
    );
};

// Agrega los consumidores con más segmentos en las últimas `hours` horas.
// Un alumno que pide cientos de segmentos distintos en poco tiempo está descargando.
module.exports.getSegmentAudit = async ({ hours = 24, limit = 100 } = {}) => {
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const res = await q(
        `SELECT sr.student_id, sr.video_id, sr.device_id,
                COUNT(*)                       AS total_requests,
                COUNT(DISTINCT sr.seg_index)   AS distinct_segments,
                MIN(sr.created_at)             AS first_seen,
                MAX(sr.created_at)             AS last_seen,
                COALESCE(
                    NULLIF((SELECT st.email FROM students st
                              WHERE st.id = sr.student_id
                                 OR st.student_id = sr.student_id
                                 OR st.email = sr.student_id
                              LIMIT 1), ''),
                    sr.student_id
                )                              AS email
           FROM segment_requests sr
          WHERE sr.created_at >= $1
          GROUP BY sr.student_id, sr.video_id, sr.device_id
          ORDER BY total_requests DESC
          LIMIT $2`,
        [since, limit]
    );
    return res.rows;
};

// Eventos de seguridad reportados por el reproductor (cliente): MITM, recorder,
// secure-boot/HVCI desactivado, sesión remota, etc. Se guardan en audit_log.
module.exports.getSecurityEvents = async (limit = 200) => {
    const res = await q(
        `SELECT id, video_id AS event, device_id, ip, user_agent AS details, delivered_at AS created_at
           FROM audit_log
          WHERE event_type = 'security_warning'
          ORDER BY delivered_at DESC
          LIMIT $1`,
        [limit]
    );
    return res.rows;
};

// ================================================================
//  API — STUDENT CODES
// ================================================================

module.exports.getOrCreateStudentCode = async (studentId) => {
    const existing = (await q('SELECT code FROM student_codes WHERE student_id=$1', [studentId])).rows[0];
    if (existing) return existing.code;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let attempts = 0; attempts < 50; attempts++) {
        let code = 'VBT-';
        for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
        const res = await q(
            'INSERT INTO student_codes (student_id, code, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING code',
            [studentId, code, new Date().toISOString()]
        );
        if (res.rowCount > 0) return code;
    }
    return 'VBT-' + studentId.slice(0, 5).toUpperCase();
};

// ================================================================
//  API — NONCES
// ================================================================

module.exports.consumeNonce = async (nonce) => {
    const res = await q(
        'INSERT INTO used_nonces (nonce, used_at) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING nonce',
        [nonce, new Date().toISOString()]
    );
    return (res.rowCount || 0) > 0;
};

module.exports.cleanOldNonces = async () => {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await q('DELETE FROM used_nonces WHERE used_at < $1', [cutoff]);
};

// ================================================================
//  API — PLAYBACK HISTORY
// ================================================================

module.exports.getPlaybackHistory = async ({ limit = 200, date = null, student = null } = {}) => {
    const params = [];
    let idx = 1;
    let sql = `
        SELECT pp.*,
               sc.code                                   AS student_code,
               COALESCE(pp.city, d.city)                 AS device_city,
               pp.device_id                                                     AS device_code,
               COALESCE(s.email, s2.email) AS student_email,
               COALESCE(s.name,  s2.name)  AS student_name,
               cat.title      AS video_title
        FROM   playback_progress pp
        LEFT JOIN student_codes sc ON sc.student_id = pp.student_id
        LEFT JOIN devices d ON d.fingerprint = pp.device_id
        LEFT JOIN students s  ON s.id          = pp.student_id
        LEFT JOIN students s2 ON s2.firebase_uid = pp.student_id
        LEFT JOIN catalog  cat ON cat.video_id  = pp.video_id
        WHERE  1=1
    `;
    if (date) {
        sql += ` AND SUBSTRING(pp.last_seen_at, 1, 10) = $${idx++}`;
        params.push(date);
    }
    if (student) {
        const pattern = '%' + student + '%';
        sql += ` AND (pp.student_id LIKE $${idx++} OR sc.code LIKE $${idx++}
                   OR COALESCE(s.email, s2.email) ILIKE $${idx++}
                   OR COALESCE(s.name, s2.name)  ILIKE $${idx++})`;
        params.push(pattern, pattern, pattern, pattern);
    }
    sql += ` ORDER BY pp.last_seen_at DESC LIMIT $${idx++}`;
    params.push(limit);
    return (await q(sql, params)).rows;
};

// ================================================================
//  API — LICENSES
// ================================================================

module.exports.createLicense = async ({ id, licenseKeyHash, studentId, courseId, maxDevices = 2, expiresAt, producerId, batchId, reservedEmail }) => {
    const now = new Date().toISOString();
    await q(
        `INSERT INTO licenses (id, license_key_hash, student_id, course_id, status, max_devices, created_at, expires_at, producer_id, batch_id, reserved_email)
         VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10)
         ON CONFLICT (license_key_hash) DO NOTHING`,
        [id, licenseKeyHash, studentId || null, courseId || null, maxDevices, now, null, producerId || null, batchId || null, reservedEmail || null]
    );
};

module.exports.getLicenseByKeyHash = async (keyHash) => {
    return (await q('SELECT * FROM licenses WHERE license_key_hash=$1', [keyHash])).rows[0] || null;
};

module.exports.getLicenseById = async (licenseId) => {
    return (await q('SELECT * FROM licenses WHERE id=$1', [licenseId])).rows[0] || null;
};

module.exports.getLicensesByStudent = async (studentId) => {
    return (await q('SELECT * FROM licenses WHERE student_id=$1 ORDER BY created_at DESC', [studentId])).rows;
};

module.exports.revokeLicense = async (licenseId, revokedBy) => {
    await q(`UPDATE licenses SET status='revoked', revoked_at=$1, revoked_by=$2 WHERE id=$3`,
        [new Date().toISOString(), revokedBy || 'admin', licenseId]);
};

// ================================================================
//  LOTES DE SERIALES + VENTA AUTOMATIZADA (PDF Mejoras 3, 4 y 5)
// ================================================================

// Crea un lote (agrupador) para N seriales de un curso.
module.exports.createLot = async ({ id, courseId, quantity, notes, createdBy, producerId }) => {
    await q(
        `INSERT INTO license_lots (id, course_id, quantity, notes, created_by, created_at, producer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, courseId || null, quantity || 0, notes || null, createdBy || 'admin', new Date().toISOString(), producerId || null]
    );
};

module.exports.getLots = async () => (await q(`
    SELECT l.*, c.name AS course_name,
           (SELECT COUNT(*) FROM licenses li WHERE li.lot_id = l.id) AS total,
           (SELECT COUNT(*) FROM licenses li WHERE li.lot_id = l.id AND li.status='free') AS free_count,
           (SELECT COUNT(*) FROM licenses li WHERE li.lot_id = l.id AND li.status<>'free') AS used_count
    FROM license_lots l LEFT JOIN courses c ON c.id = l.course_id
    ORDER BY l.created_at DESC`)).rows;

module.exports.getLicensesByLot = async (lotId) =>
    (await q('SELECT * FROM licenses WHERE lot_id=$1 ORDER BY created_at ASC', [lotId])).rows;

// Crea una licencia LIBRE (sin alumno) dentro de un lote.
module.exports.createFreeLicense = async ({ id, licenseKeyHash, courseId, lotId, maxDevices = 2, expiresAt, producerId }) => {
    await q(
        `INSERT INTO licenses (id, license_key_hash, student_id, course_id, status, max_devices, created_at, expires_at, lot_id, producer_id)
         VALUES ($1,$2,NULL,$3,'free',$4,$5,$6,$7,$8)
         ON CONFLICT (license_key_hash) DO NOTHING`,
        [id, licenseKeyHash, courseId || null, maxDevices, new Date().toISOString(), null, lotId || null, producerId || null]
    );
};

// Activaciones (quién usa los seriales del productor) — para su panel.
module.exports.getProducerActivations = async (producerId) => (await q(`
    SELECT a.device_id, a.status, a.created_at, a.last_used_at,
           l.customer_email, l.course_id
    FROM activations a JOIN licenses l ON l.id = a.license_id
    WHERE l.producer_id = $1
    ORDER BY a.created_at DESC LIMIT 500`, [producerId])).rows;

// Catálogo y lotes filtrados por productor (para el panel del cliente).
module.exports.getCatalogByProducer = async (producerId) => {
    const rows = (await q(`SELECT * FROM catalog WHERE producer_id=$1 ORDER BY uploaded_at DESC`, [producerId])).rows;
    for (const r of rows) { if (r.bunny_url) r.bunny_url = decField(r.bunny_url); if (r.documents) r.documents = decField(r.documents); }
    return rows;
};
module.exports.getLotsByProducer = async (producerId) => (await q(`
    SELECT l.*, c.name AS course_name,
           (SELECT COUNT(*) FROM licenses li WHERE li.lot_id = l.id) AS total,
           (SELECT COUNT(*) FROM licenses li WHERE li.lot_id = l.id AND li.status='free') AS free_count,
           (SELECT COUNT(*) FROM licenses li WHERE li.lot_id = l.id AND li.status='active') AS used_count,
           (SELECT COUNT(*) FROM licenses li WHERE li.lot_id = l.id AND li.status='revoked') AS revoked_count
    FROM license_lots l LEFT JOIN courses c ON c.id = l.course_id
    WHERE l.producer_id=$1 ORDER BY l.created_at DESC`, [producerId])).rows;

module.exports.getProducerLicenseItems = async ({ producerId, lotId = null, limit = 50, offset = 0 }) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 2147483647) {
        throw dbError('INVALID_PAGINATION', 'Paginación inválida.', 400);
    }
    const total = Number((await q(`SELECT COUNT(*) AS n FROM licenses
        WHERE producer_id=$1 AND ($2::text IS NULL OR lot_id=$2)`, [producerId, lotId])).rows[0].n);
    // Explicit columns: never return serial hashes or activation credentials.
    const rows = (await q(`SELECT l.id, l.lot_id, l.course_id, c.name AS course_name,
        l.status, l.max_devices, l.created_at, l.assigned_at, l.revoked_at,
        l.customer_email, (SELECT COUNT(*) FROM activations a WHERE a.license_id=l.id) AS activation_count,
        (SELECT COUNT(*) FROM activations a WHERE a.license_id=l.id AND a.status='active'
            AND (a.expires_at IS NULL OR a.expires_at>$5)) AS active_activations
        FROM licenses l LEFT JOIN courses c ON c.id=l.course_id AND c.producer_id=l.producer_id
        WHERE l.producer_id=$1 AND ($2::text IS NULL OR l.lot_id=$2)
        ORDER BY l.created_at DESC, l.id DESC LIMIT $3 OFFSET $4`,
        [producerId, lotId, limit, offset, new Date().toISOString()])).rows;
    return { rows, total };
};

module.exports.revokeProducerLicense = async ({ producerId, licenseId }) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Match activation's producer-before-license lock order.
        const producer = await lockLicenseProducer(client, producerId);
        const license = (await client.query(`SELECT id, status, student_id, course_id FROM licenses
            WHERE id=$1 AND producer_id=$2 FOR UPDATE`, [licenseId, producerId])).rows[0];
        if (!license) throw dbError('LICENSE_NOT_FOUND', 'Licencia no encontrada.', 404);
        if (license.status === 'revoked') {
            await client.query('COMMIT');
            return { licenseId, status: 'revoked', alreadyRevoked: true };
        }
        const now = new Date().toISOString(), actor = `producer:${producer.id}`;
        await client.query(`UPDATE licenses SET status='revoked', revoked_at=$1, revoked_by=$2
            WHERE id=$3 AND producer_id=$4`, [now, actor, licenseId, producerId]);
        await client.query(`UPDATE activations SET status='revoked', revoked_at=$1, revoked_by=$2
            WHERE license_id=$3 AND status<>'revoked'`, [now, actor, licenseId]);
        // The media policy checks these rows on every request. Other licenses,
        // devices and courses for this student remain untouched.
        await client.query(`INSERT INTO suspicious_activity
            (student_id, device_id, type, severity, description, metadata, created_at)
            VALUES ($1,NULL,'producer_license_revoked','low',$2,$3,$4)`,
        [license.student_id || actor, `El productor ${producer.email} revocó una licencia de su curso.`,
            JSON.stringify({ producerId, licenseId, courseId: license.course_id, actor }), now]);
        await client.query('COMMIT');
        return { licenseId, status: 'revoked', alreadyRevoked: false };
    } catch (error) {
        await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
};

// Toma atómicamente un serial LIBRE del curso y lo asigna a un comprador.
// Devuelve la fila de licencia asignada, o null si no quedan libres.
module.exports.claimFreeLicense = async ({ courseId, customerEmail, orderId, studentId, producerId = null }) => {
    if (!courseId || !studentId || !orderId) {
        throw dbError('CLAIM_FIELDS_REQUIRED', 'Curso, alumno y referencia de pedido son obligatorios.', 400);
    }
    const email = String(customerEmail || '').trim().toLowerCase();
    return transaction(async client => {
        // Serialize retries of this provider/order even before a license exists.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [`license-order:${producerId || 'owner'}:${orderId}`]);
        const producer = await lockLicenseProducer(client, producerId);
        const student = await lockLicenseStudent(client, studentId, producerId, producer);
        const course = (await client.query('SELECT * FROM courses WHERE id=$1', [courseId])).rows[0];
        if (!course || (course.producer_id || null) !== (producerId || null)) {
            throw dbError('COURSE_FORBIDDEN', 'El curso no pertenece al ámbito de la integración.', 403);
        }
        if (email && email !== String(student.email || '').trim().toLowerCase()) {
            throw dbError('CUSTOMER_MISMATCH', 'El correo del comprador no corresponde al alumno.', 409);
        }
        const previous = (await client.query(`SELECT * FROM licenses
            WHERE producer_id IS NOT DISTINCT FROM $1::text AND order_id=$2 ORDER BY created_at DESC FOR UPDATE`,
        [producerId || null, String(orderId)])).rows;
        if (previous.length) {
            if (previous.some(row => row.course_id !== courseId || row.student_id !== studentId) || previous.filter(row => row.status !== 'revoked').length > 1) {
                throw dbError('ORDER_CONFLICT', 'La referencia de pedido ya tiene otra asignación.');
            }
            return previous.find(row => row.status !== 'revoked') || previous[0];
        }
        const lic = (await client.query(`SELECT * FROM licenses
            WHERE status='free' AND course_id=$1 AND producer_id IS NOT DISTINCT FROM $2::text
            ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`,
        [courseId, producerId || null])).rows[0];
        if (!lic) return null;
        await grantLicenseCourse(client, student, lic, producerId);
        return (await client.query(`UPDATE licenses SET status='active', student_id=$1,
            customer_email=$2, order_id=$3, assigned_at=$4 WHERE id=$5 RETURNING *`,
        [studentId, email || student.email, String(orderId), new Date().toISOString(), lic.id])).rows[0];
    });
};

async function lockLicenseProducer(client, producerId) {
    if (!producerId) return null;
    const producer = (await client.query('SELECT * FROM producers WHERE id=$1 FOR UPDATE', [producerId])).rows[0];
    if (!producer || Number(producer.active) !== 1) throw dbError('PRODUCER_INACTIVE', 'Productor no disponible.', 403);
    return producer;
}

async function lockLicenseStudent(client, studentId, producerId, producer) {
    const student = (await client.query('SELECT * FROM students WHERE id=$1 FOR UPDATE', [studentId])).rows[0];
    if (!student || Number(student.active) !== 1 || (student.approval_status && student.approval_status !== 'approved')) {
        throw dbError('STUDENT_INACTIVE', 'Alumno no disponible o pendiente de aprobación.', 403);
    }
    if (producerId && student.producer_id && student.producer_id !== producerId) {
        throw dbError('STUDENT_OWNER_CONFLICT', 'El alumno pertenece a otro productor.', 403);
    }
    if (producer && !student.producer_id && Number(producer.max_students) > 0) {
        const count = Number((await client.query('SELECT COUNT(*) AS n FROM students WHERE producer_id=$1', [producerId])).rows[0].n);
        if (count >= Number(producer.max_students)) throw dbError('STUDENT_QUOTA_EXCEEDED', 'El productor alcanzó su cupo de alumnos.', 403);
    }
    return student;
}

async function grantLicenseCourse(client, student, license, producerId) {
    if (license.course_id) {
        const course = (await client.query('SELECT * FROM courses WHERE id=$1', [license.course_id])).rows[0];
        if (!course || (course.producer_id || null) !== (producerId || null)) {
            throw dbError('LICENSE_COURSE_MISMATCH', 'La licencia no corresponde a un curso de este ámbito.', 403);
        }
        await client.query(`INSERT INTO student_courses(student_id,course_id,granted_at,granted_by)
            VALUES($1,$2,$3,$4) ON CONFLICT(student_id,course_id) DO NOTHING`,
        [student.id, license.course_id, new Date().toISOString(), 'license']);
        const allowed = parseAllowedVideos(student.allowed_videos);
        if (!allowed.includes('*') && !allowed.includes(license.course_id)) {
            await client.query('UPDATE students SET allowed_videos=$1 WHERE id=$2',
                [serializeAllowedVideos([...allowed, license.course_id]), student.id]);
        }
    } else if (license.status === 'free' || producerId) {
        throw dbError('LICENSE_COURSE_REQUIRED', 'La licencia debe tener un curso asignado.', 409);
    }
    if (producerId && !student.producer_id) {
        await client.query('UPDATE students SET producer_id=$1 WHERE id=$2 AND producer_id IS NULL', [producerId, student.id]);
    }
}

// Máquina de estados: transiciones controladas (PDF Mejora 5).
const LICENSE_TRANSITIONS = {
    free:      ['active', 'revoked'],
    active:    ['suspended', 'revoked', 'expired'],
    suspended: ['active', 'revoked'],
    expired:   ['active', 'revoked'],
    revoked:   [],
};
module.exports.setLicenseStatus = async (licenseId, nextStatus, by) => {
    const lic = (await q('SELECT status FROM licenses WHERE id=$1', [licenseId])).rows[0];
    if (!lic) return { ok: false, error: 'Licencia no encontrada' };
    const allowed = LICENSE_TRANSITIONS[lic.status] || [];
    if (lic.status === nextStatus) return { ok: true, unchanged: true };
    if (!allowed.includes(nextStatus)) {
        return { ok: false, error: `Transición inválida: ${lic.status} → ${nextStatus}` };
    }
    const now = new Date().toISOString();
    const extra = nextStatus === 'revoked'   ? `, revoked_at='${now}', revoked_by='${(by||'admin').replace(/'/g,"")}'`
                : nextStatus === 'suspended' ? `, suspended_at='${now}'`
                : '';
    await q(`UPDATE licenses SET status=$1${extra} WHERE id=$2`, [nextStatus, licenseId]);
    return { ok: true, from: lic.status, to: nextStatus };
};

// ── Claves de integración de ventas ──────────────────────────────────────────
module.exports.createIntegrationKey = async ({ id, name, keyHash, scopes }) => {
    await q(
        `INSERT INTO integration_keys (id, name, key_hash, scopes, active, created_at)
         VALUES ($1,$2,$3,$4,1,$5)`,
        [id, name, keyHash, scopes || 'claim-license', new Date().toISOString()]
    );
};
module.exports.getIntegrationKeyByHash = async (keyHash) =>
    (await q(`SELECT * FROM integration_keys WHERE key_hash=$1 AND active=1`, [keyHash])).rows[0] || null;
module.exports.touchIntegrationKey = async (id) =>
    q(`UPDATE integration_keys SET last_used=$1 WHERE id=$2`, [new Date().toISOString(), id]).catch(() => {});
module.exports.listIntegrationKeys = async () =>
    (await q(`SELECT id, name, scopes, active, created_at, last_used FROM integration_keys ORDER BY created_at DESC`)).rows;
module.exports.revokeIntegrationKey = async (id) =>
    q(`UPDATE integration_keys SET active=0 WHERE id=$1`, [id]);

// ================================================================
//  DRM PROPIO (.edu) — registro de contenidos cifrados
// ================================================================
module.exports.registerEduContent = async ({ contentId, salt, bunnyUrl, title, watermark, flags, courseId, videoId, producerId }) => {
    await q(
        `INSERT INTO edu_content (content_id, salt, bunny_url, title, watermark, flags, course_id, video_id, created_at, producer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (content_id) DO UPDATE SET
            salt=EXCLUDED.salt, bunny_url=EXCLUDED.bunny_url, title=EXCLUDED.title,
            watermark=EXCLUDED.watermark, flags=EXCLUDED.flags,
            course_id=EXCLUDED.course_id, video_id=EXCLUDED.video_id,
            producer_id=COALESCE(EXCLUDED.producer_id, edu_content.producer_id)`,
        [contentId, salt, encField(bunnyUrl || null), title || null, watermark || null,
         flags || 0, courseId || null, videoId || null, new Date().toISOString(), producerId || null]
    );
};
module.exports.getEduContent = async (contentId) => {
    const r = (await q('SELECT * FROM edu_content WHERE content_id=$1', [contentId])).rows[0] || null;
    if (r && r.bunny_url) r.bunny_url = decField(r.bunny_url);
    return r;
};
module.exports.listEduContent = async () => {
    const rows = (await q('SELECT content_id, title, course_id, video_id, bunny_url, created_at FROM edu_content ORDER BY created_at DESC')).rows;
    for (const r of rows) { if (r.bunny_url) r.bunny_url = decField(r.bunny_url); }
    return rows;
};
module.exports.deleteEduContent = async (contentId) =>
    q('DELETE FROM edu_content WHERE content_id=$1', [contentId]);
// Busca el .edu asociado a un videoId (si el video se migró al modelo .edu).
module.exports.getEduByVideo = async (videoId) =>
    (await q('SELECT content_id, watermark, course_id FROM edu_content WHERE video_id=$1 LIMIT 1', [videoId])).rows[0] || null;

// ================================================================
//  MULTI-TENANCY: PRODUCTORES (clientes con panel propio)
// ================================================================
// Zero explicitly means unlimited for licenses/students. Only an omitted
// value receives the default; invalid input must never grant an unlimited cap.
function normalizeProducerQuotas(input = {}, { defaults = false } = {}) {
    const result = {};
    for (const [field, minimum, fallback] of [
        ['maxLicenses', 0, 100], ['maxDevices', 1, 2], ['maxStudents', 0, 0]
    ]) {
        const raw = input[field];
        if (raw === undefined) {
            if (defaults) result[field] = fallback;
            continue;
        }
        const numeric = typeof raw === 'number' ||
            (typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw.trim()));
        const value = numeric ? Number(raw) : NaN;
        if (!Number.isInteger(value) || value < minimum || value > 2147483647) {
            throw dbError('INVALID_PRODUCER_QUOTA',
                `${field} debe ser un número entero entre ${minimum} y 2147483647.`, 400);
        }
        result[field] = value;
    }
    return result;
}
module.exports.normalizeProducerQuotas = normalizeProducerQuotas;

function normalizeProducerLicenseExpiry(value) {
    if (value === undefined || value === null || value === '') return null;
    const validFormat = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value);
    const date = validFormat ? new Date(value) : null;
    const canonical = validFormat ? value.replace(/(?:\.(\d{1,3}))?Z$/, (_, ms) => '.' + (ms || '').padEnd(3, '0') + 'Z') : null;
    if (!date || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now() || date.toISOString() !== canonical) {
        throw dbError('INVALID_LICENSE_EXPIRY', 'El vencimiento debe ser una fecha futura válida en UTC.', 400);
    }
    return date.toISOString();
}
module.exports.normalizeProducerLicenseExpiry = normalizeProducerLicenseExpiry;

module.exports.createProducer = async ({ id, email, passwordHash, name, maxLicenses, maxDevices, maxStudents, notes }) => {
    const quotas = normalizeProducerQuotas({ maxLicenses, maxDevices, maxStudents }, { defaults: true });
    await q(
        `INSERT INTO producers (id, email, password_hash, name, active, max_licenses, max_devices, max_students, notes, created_at)
         VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9)`,
        [id, String(email).toLowerCase().trim(), passwordHash, name || null,
         quotas.maxLicenses, quotas.maxDevices, quotas.maxStudents,
         notes || null, new Date().toISOString()]
    );
};
module.exports.getProducerByEmail = async (email) =>
    (await q('SELECT * FROM producers WHERE email=$1', [String(email).toLowerCase().trim()])).rows[0] || null;
module.exports.getProducerById = async (id) =>
    (await q('SELECT * FROM producers WHERE id=$1', [id])).rows[0] || null;
module.exports.listProducers = async () => (await q(`
    SELECT p.*,
           (SELECT COUNT(*) FROM licenses l WHERE l.producer_id = p.id) AS licenses_used,
           (SELECT COUNT(*) FROM students s WHERE s.producer_id = p.id) AS students_count
    FROM producers p ORDER BY p.created_at DESC`)).rows;
module.exports.updateProducer = async (id, fields) => {
    const quotas = normalizeProducerQuotas({ maxLicenses: fields.max_licenses,
        maxDevices: fields.max_devices, maxStudents: fields.max_students });
    fields = { ...fields };
    for (const [camel, column] of [['maxLicenses', 'max_licenses'], ['maxDevices', 'max_devices'], ['maxStudents', 'max_students']]) {
        if (camel in quotas) fields[column] = quotas[camel];
    }
    const allowed = ['name', 'active', 'max_licenses', 'max_devices', 'max_students', 'notes', 'password_hash'];
    const sets = [], vals = []; let i = 1;
    for (const k of allowed) if (k in fields && fields[k] !== undefined) { sets.push(`${k}=$${i++}`); vals.push(fields[k]); }
    if (!sets.length) return;
    if (fields.password_hash !== undefined || fields.active === 0 || fields.active === false) sets.push('auth_version=auth_version+1');
    vals.push(id);
    await q(`UPDATE producers SET ${sets.join(', ')} WHERE id=$${i}`, vals);
};
module.exports.deleteProducer = async (id) => q('DELETE FROM producers WHERE id=$1', [id]);
module.exports.touchProducerLogin = async (id) =>
    q('UPDATE producers SET last_login=$1 WHERE id=$2', [new Date().toISOString(), id]).catch(() => {});
module.exports.countProducerLicenses = async (producerId) =>
    parseInt((await q('SELECT COUNT(*) AS n FROM licenses WHERE producer_id=$1', [producerId])).rows[0].n, 10) || 0;

// Genera un lote de licencias del productor de forma ATÓMICA respetando la cuota.
// Bloquea la fila del productor (FOR UPDATE) para serializar generaciones concurrentes.
module.exports.createProducerLotAtomic = async ({ producerId, maxLicenses, lot, licenses }) => {
    // Las licencias de curso son permanentes: ninguna ruta puede introducir caducidad.
    if ((lot.expiresAt != null && lot.expiresAt !== '') || (lot.durationDays != null && lot.durationDays !== '')) {
        throw dbError('LICENSE_EXPIRY_UNSUPPORTED', 'Las licencias de curso no tienen vencimiento.', 400);
    }
    const workspacePolicy = require('./lib/producer-licenses');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const producer = (await client.query('SELECT * FROM producers WHERE id=$1 FOR UPDATE', [producerId])).rows[0];
        if (!producer || Number(producer.active) !== 1) throw dbError('PRODUCER_INACTIVE', 'Productor no disponible.', 403);
        if (!lot.courseId) throw dbError('COURSE_REQUIRED', 'Selecciona el curso del lote.', 400);
        const course = (await client.query('SELECT producer_id FROM courses WHERE id=$1', [lot.courseId])).rows[0];
        if (!course || course.producer_id !== producerId) throw dbError('COURSE_FORBIDDEN', 'Curso no disponible.', 403);
        if (!Array.isArray(licenses) || !licenses.length) throw dbError('EMPTY_LOT', 'El lote debe contener licencias.', 400);
        const devices = Number(lot.maxDevices);
        if (!Number.isInteger(devices) || devices < 1 || devices > Math.max(1, Number(producer.max_devices) || 1)) {
            throw dbError('DEVICE_QUOTA_EXCEEDED', 'Dispositivos por licencia fuera del cupo permitido.', 403);
        }
        // Read the current cap while holding the lock, never trust a stale JWT.
        maxLicenses = normalizeProducerQuotas({ maxLicenses: producer.max_licenses ?? null }).maxLicenses;
        const c = await client.query('SELECT COUNT(*) AS n FROM licenses WHERE producer_id=$1', [producerId]);
        const used = parseInt(c.rows[0].n, 10) || 0;
        if (maxLicenses > 0 && used + licenses.length > maxLicenses) {
            await client.query('ROLLBACK');
            return { ok: false, used, limit: maxLicenses };
        }
        const now = new Date().toISOString();
        await client.query(
            `INSERT INTO license_lots (id, course_id, quantity, notes, created_by, created_at, producer_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [lot.id, lot.courseId || null, licenses.length, lot.notes || null, lot.createdBy || '', now, producerId]
        );
        for (const l of licenses) {
            await client.query(
                `INSERT INTO licenses (id, license_key_hash, student_id, course_id, status, max_devices, created_at, lot_id, producer_id, expires_at)
                 VALUES ($1,$2,NULL,$3,'free',$4,$5,$6,$7,NULL)`,
                [l.id, l.hash, lot.courseId || null, lot.maxDevices, now, lot.id, producerId]
            );
        }
        const prepared = licenses.filter(item => item.key || item.ciphertext);
        if (prepared.length) {
            if (prepared.length !== licenses.length) throw dbError('PARTIAL_SERIALS', 'El lote no contiene todos sus seriales.', 400);
            await workspacePolicy.storePreparedSerials(client, { producerId, licenses: prepared });
        }
        if (lot.name) await client.query('UPDATE license_lots SET name=$1 WHERE id=$2 AND producer_id=$3', [String(lot.name).trim().slice(0, 120), lot.id, producerId]);
        await client.query('COMMIT');
        return { ok: true, used };
    } catch (e) {
        await client.query('ROLLBACK'); throw e;
    } finally {
        client.release();
    }
};

/**
 * Regenera una licencia de forma ATÓMICA (transacción):
 *   1. Bloquea y lee la licencia anterior (hereda student_id, course_id,
 *      max_devices y expires_at).
 *   2. Revoca TODAS las activaciones de la licencia anterior.
 *   3. Cierra las playback_sessions activas de esos dispositivos.
 *      (NO se bloquea el dispositivo: debe poder volver a iniciar sesión para
 *       ingresar la nueva licencia y crear una activación nueva.)
 *   4. Marca la licencia anterior como 'revoked'.
 *   5. Crea la licencia nueva 'active' conservando la configuración.
 * Devuelve contadores para la auditoría.
 * @returns {{ ok, oldLicenseId, newLicenseId, studentId, courseId, maxDevices,
 *             expiresAt, revokedActivations, blockedDevices, closedSessions, deviceCount }}
 *          | {{ ok:false, reason:'not_found' }}
 */
module.exports.regenerateLicense = async ({ oldLicenseId, newLicenseId, newLicenseKeyHash, newLicenseKey, revokedBy = 'admin' }) => {
    const now = new Date().toISOString();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Lock + lectura de la licencia anterior
        const old = (await client.query('SELECT * FROM licenses WHERE id=$1 FOR UPDATE', [oldLicenseId])).rows[0];
        if (!old) { await client.query('ROLLBACK'); return { ok: false, reason: 'not_found' }; }

        // A producer's replacement must remain recoverable. Verify and encrypt
        // the new serial before revoking anything, and persist custody in this
        // same transaction. The plaintext serial never becomes a SQL value.
        let preparedSerial = null;
        if (old.producer_id) {
            if (typeof newLicenseKey !== 'string' || !/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(newLicenseKey)) {
                throw dbError('NEW_SERIAL_REQUIRED', 'La regeneración requiere el nuevo serial para guardarlo cifrado.', 400);
            }
            if (typeof process.env.JWT_SECRET !== 'string' || process.env.JWT_SECRET.length < 32) {
                throw dbError('SERIAL_SIGNING_UNAVAILABLE', 'La firma de seriales no está configurada.', 503);
            }
            const expectedHash = require('node:crypto').createHmac('sha256', process.env.JWT_SECRET).update(newLicenseKey).digest('hex');
            if (newLicenseKeyHash !== expectedHash) throw dbError('SERIAL_HASH_MISMATCH', 'El serial no corresponde a su firma.', 400);
            const vault = require('./lib/producer-licenses').createSerialVault();
            preparedSerial = { id: newLicenseId, ciphertext: vault.encrypt(newLicenseKey, old.producer_id, newLicenseId) };
        }

        // 2. Dispositivos que tenían activación con esta licencia (para limpieza)
        const actRows = (await client.query(
            'SELECT DISTINCT device_id FROM activations WHERE license_id=$1', [oldLicenseId]
        )).rows;
        const deviceIds = actRows.map(r => r.device_id).filter(Boolean);

        // 3. Revocar todas las activaciones de la licencia anterior
        const revokedActivations = (await client.query(
            `UPDATE activations SET status='revoked', revoked_at=$1, revoked_by=$2
             WHERE license_id=$3 AND status='active' RETURNING id`,
            [now, revokedBy, oldLicenseId]
        )).rows.length;

        // 4. Cerrar playback_sessions activas de esos dispositivos.
        //    IMPORTANTE: NO se bloquea el dispositivo. Bloquearlo impediría que el
        //    alumno vuelva a iniciar sesión para ingresar la nueva licencia
        //    ("Este dispositivo ha sido bloqueado por el administrador"). Con
        //    revocar la activación + cerrar la sesión ya se expulsa al usuario; el
        //    dispositivo queda activo y, al activar la nueva licencia, se crea una
        //    activación nueva.
        let closedSessions = 0;
        if (deviceIds.length) {
            closedSessions = (await client.query(
                `DELETE FROM playback_sessions
                 WHERE (student_id=$1 OR student_id=(SELECT student_id FROM students WHERE id=$1))
                   AND device_id = ANY($2::text[]) RETURNING session_id`,
                [old.student_id, deviceIds]
            )).rows.length;
        }

        // A license reset must not undo a separate administrator device block.
        const unblockedDevices = 0;
        closedSessions += (await client.query(`DELETE FROM active_sessions WHERE user_id=$1
            AND ($2::text IS NULL OR video_id IN (SELECT video_id FROM catalog WHERE course_id=$2)) RETURNING session_id`,
        [old.student_id, old.course_id || null])).rows.length;

        // 5. Revocar la licencia anterior
        await client.query(
            `UPDATE licenses SET status='revoked', revoked_at=$1, revoked_by=$2 WHERE id=$3`,
            [now, revokedBy, oldLicenseId]
        );

        // 6. Crear la licencia nueva conservando la configuración
        await client.query(
            `INSERT INTO licenses (id, license_key_hash, student_id, course_id, status, max_devices, created_at, expires_at,
                producer_id, lot_id, customer_email, order_id, notes, assigned_at,
                duration_days, first_activated_at, buyer_name, buyer_phone)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [newLicenseId, newLicenseKeyHash, old.student_id, old.course_id, old.student_id ? 'active' : 'free',
             old.max_devices, now, null, old.producer_id, old.lot_id, old.customer_email, old.order_id, old.notes, old.assigned_at,
             null, old.first_activated_at ?? null, old.buyer_name ?? null, old.buyer_phone ?? null]
        );
        if (preparedSerial) {
            await require('./lib/producer-licenses').storePreparedSerials(client, { producerId: old.producer_id, licenses: [preparedSerial] });
            // Replacing a serial must not silently clear a producer's explicit
            // block for a particular computer.
            await client.query(`INSERT INTO producer_license_device_blocks(license_id,producer_id,device_id,created_at)
                SELECT $1,producer_id,device_id,created_at FROM producer_license_device_blocks
                WHERE license_id=$2 AND producer_id=$3 ON CONFLICT(license_id,device_id) DO NOTHING`,
            [newLicenseId, oldLicenseId, old.producer_id]);
        }

        await client.query('COMMIT');
        return {
            ok: true,
            oldLicenseId,
            newLicenseId,
            studentId:  old.student_id,
            courseId:   old.course_id,
            maxDevices: old.max_devices,
            expiresAt:  null,
            durationDays: null,
            firstActivatedAt: old.first_activated_at ?? null,
            revokedActivations,
            blockedDevices: deviceIds.length, // dispositivos cuya activación/sesión se cerró (NO bloqueados)
            closedSessions,
            unblockedDevices,
            deviceCount: deviceIds.length,
        };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
};

// ================================================================
//  API — ACTIVATIONS
// ================================================================

module.exports.createActivation = async ({ id, licenseId, studentId, deviceId, activationTokenHash, expiresAt }) => {
    const now = new Date().toISOString();
    await q(
        `INSERT INTO activations (id, license_id, student_id, device_id, activation_token_hash, status, created_at, last_used_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8)
         ON CONFLICT (license_id, device_id) DO UPDATE
           SET activation_token_hash=EXCLUDED.activation_token_hash,
               status='active', last_used_at=$7, expires_at=$8, revoked_at=NULL, revoked_by=NULL`,
        [id, licenseId, studentId, deviceId, activationTokenHash, now, now, expiresAt || null]
    );
};

module.exports.getActivationByTokenHash = async (tokenHash) => {
    return (await q('SELECT * FROM activations WHERE activation_token_hash=$1', [tokenHash])).rows[0] || null;
};

module.exports.getActivationsByLicense = async (licenseId) => {
    return (await q('SELECT * FROM activations WHERE license_id=$1 ORDER BY created_at DESC', [licenseId])).rows;
};

module.exports.countActiveActivationsByLicense = async (licenseId) => {
    const r = await q(`SELECT COUNT(*) FROM activations WHERE license_id=$1 AND status='active'`, [licenseId]);
    return parseInt(r.rows[0].count, 10);
};

/**
 * Activa un dispositivo para una licencia de forma ATÓMICA (sin escapes).
 * Bloquea la fila de la licencia (FOR UPDATE) para serializar activaciones
 * concurrentes del mismo código → impide que dos dispositivos pasen el chequeo
 * de límite a la vez. Reactiva si el dispositivo ya estaba activado.
 * @returns {{ ok:true, activationId, reused }} | {{ ok:false, reason, limit, activeCount }}
 */
module.exports.activateDeviceAtomic = async ({ licenseId, studentId, deviceId, activationTokenHash, maxAllowed, expiresAt }) => {
    const now   = new Date().toISOString();
    const limit = Number.isFinite(maxAllowed) && maxAllowed >= 1 ? maxAllowed : 1;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Lock de la licencia: serializa activaciones concurrentes del mismo código.
        const license = (await client.query('SELECT * FROM licenses WHERE id=$1 FOR UPDATE', [licenseId])).rows[0];
        if (!license || license.status !== 'active' || license.student_id !== studentId) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'license_inactive' };
        }
        await require('./lib/producer-licenses').activateLicensePolicy(client, license, { deviceId, now });
        // El derecho al curso es permanente; solo el arrendamiento técnico de la activación puede llevar plazo.
        const boundedExpiries = [expiresAt].filter(Boolean).map(value => Date.parse(value));
        if (boundedExpiries.some(value => !Number.isFinite(value) || value <= Date.now())) throw dbError('invalid_expiry', 'Vencimiento de activación inválido.', 400);
        expiresAt = boundedExpiries.length ? new Date(Math.min(...boundedExpiries)).toISOString() : null;

        const existing = (await client.query(
            'SELECT id, status, expires_at FROM activations WHERE license_id=$1 AND device_id=$2', [licenseId, deviceId]
        )).rows[0];

        const activeCount = parseInt((await client.query(
            `SELECT COUNT(*) FROM activations WHERE license_id=$1 AND status='active'
             AND (expires_at IS NULL OR expires_at > $2)`, [licenseId, now]
        )).rows[0].count, 10);

        const alreadyActive = existing?.status === 'active' && (!existing.expires_at || Date.parse(existing.expires_at) > Date.now());
        const licenseLimit = Math.min(limit, Math.max(1, Number(license.max_devices) || 1));
        if (!alreadyActive && activeCount >= licenseLimit) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'device_limit_exceeded', limit: licenseLimit, activeCount };
        }

        const insertId = existing ? existing.id : uuid4();
        const ret = await client.query(
            `INSERT INTO activations (id, license_id, student_id, device_id, activation_token_hash, status, created_at, last_used_at, expires_at)
             VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8)
             ON CONFLICT (license_id, device_id) DO UPDATE
               SET activation_token_hash=EXCLUDED.activation_token_hash,
                   status='active', last_used_at=$7, expires_at=$8, revoked_at=NULL, revoked_by=NULL
             RETURNING id`,
            [insertId, licenseId, studentId, deviceId, activationTokenHash, now, now, expiresAt || null]
        );
        await client.query('COMMIT');
        return { ok: true, activationId: ret.rows[0].id, reused: !!existing };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
};

// Claims a known serial and activates a device in the SAME transaction. Nothing
// is assigned when ownership, quota, device, expiry or activation checks fail.
module.exports.claimAndActivateLicenseAtomic = async ({ licenseKeyHash, studentId, deviceId, activationTokenHash, maxAllowed, expiresAt }) => {
    if (!licenseKeyHash || !studentId || !deviceId || !activationTokenHash) return { ok: false, reason: 'invalid_input' };
    try {
        return await transaction(async client => {
            const initial = (await client.query('SELECT * FROM licenses WHERE license_key_hash=$1', [licenseKeyHash])).rows[0];
            if (!initial) throw dbError('license_not_found', 'Licencia no encontrada.', 404);
            const producer = await lockLicenseProducer(client, initial.producer_id);
            const student = await lockLicenseStudent(client, studentId, initial.producer_id, producer);
            const license = (await client.query('SELECT * FROM licenses WHERE license_key_hash=$1 FOR UPDATE', [licenseKeyHash])).rows[0];
            if (!license || !['free', 'active'].includes(license.status)) throw dbError('license_inactive', 'Licencia no activa.', 403);
            if (license.student_id && license.student_id !== studentId) throw dbError('license_owner_mismatch', 'Licencia asignada a otra cuenta.', 403);
            if (license.status === 'active' && !license.student_id && license.customer_email &&
                String(license.customer_email).trim().toLowerCase() !== String(student.email).trim().toLowerCase()) {
                throw dbError('license_owner_mismatch', 'Licencia asignada a otra cuenta.', 403);
            }
            const now = new Date().toISOString();
            await require('./lib/producer-licenses').activateLicensePolicy(client, license, { deviceId, now });
            const caps = [Number(license.max_devices), Number(maxAllowed), Number(producer?.max_devices)].filter(v => Number.isInteger(v) && v > 0);
            const limit = caps.length ? Math.min(...caps) : 1;
            const existing = (await client.query('SELECT * FROM activations WHERE license_id=$1 AND device_id=$2', [license.id, deviceId])).rows[0];
            const activeCount = Number((await client.query(`SELECT COUNT(*) AS n FROM activations WHERE license_id=$1
                AND status='active' AND (expires_at IS NULL OR expires_at > $2)`, [license.id, now])).rows[0].n);
            const alreadyActive = existing?.status === 'active' && (!existing.expires_at || Date.parse(existing.expires_at) > Date.now());
            if (!alreadyActive && activeCount >= limit) throw Object.assign(dbError('device_limit_exceeded', 'Cupo de activaciones alcanzado.', 403), { limit, activeCount });

            const device = (await client.query('SELECT * FROM devices WHERE student_id=$1 AND fingerprint=$2', [studentId, deviceId])).rows[0];
            if (device?.status === 'blocked') throw dbError('device_blocked', 'Dispositivo bloqueado.', 403);
            const deviceLimit = Math.max(1, Number(student.max_devices) || limit);
            if (!device || device.status !== 'active') {
                const deviceCount = Number((await client.query("SELECT COUNT(*) AS n FROM devices WHERE student_id=$1 AND status='active'", [studentId])).rows[0].n);
                if (deviceCount >= deviceLimit) throw Object.assign(dbError('device_limit_exceeded', 'Cupo de dispositivos alcanzado.', 403), { limit: deviceLimit, activeCount: deviceCount });
            }
            await grantLicenseCourse(client, student, license, initial.producer_id);
            const assigned = (await client.query(`UPDATE licenses SET status='active', student_id=$1,
                customer_email=COALESCE(customer_email,$2), assigned_at=COALESCE(assigned_at,$3)
                WHERE id=$4 RETURNING *`, [studentId, student.email, now, license.id])).rows[0];
            await client.query(`INSERT INTO devices(id,student_id,fingerprint,status,first_seen,last_seen)
                VALUES($1,$2,$3,'active',$4,$4) ON CONFLICT(student_id,fingerprint)
                DO UPDATE SET status='active',last_seen=EXCLUDED.last_seen`, [uuid4(), studentId, deviceId, now]);
            // Licencia permanente: solo el plazo técnico de la activación (si lo hay) acota el token.
            const validExpiries = [expiresAt].filter(Boolean).map(v => Date.parse(v));
            if (validExpiries.some(v => !Number.isFinite(v) || v <= Date.now())) throw dbError('invalid_expiry', 'Vencimiento de activación inválido.', 400);
            const activationExpiry = validExpiries.length ? new Date(Math.min(...validExpiries)).toISOString() : null;
            const activationId = existing?.id || uuid4();
            await client.query(`INSERT INTO activations(id,license_id,student_id,device_id,activation_token_hash,status,created_at,last_used_at,expires_at)
                VALUES($1,$2,$3,$4,$5,'active',$6,$6,$7) ON CONFLICT(license_id,device_id)
                DO UPDATE SET activation_token_hash=EXCLUDED.activation_token_hash,status='active',last_used_at=EXCLUDED.last_used_at,
                expires_at=EXCLUDED.expires_at,revoked_at=NULL,revoked_by=NULL`,
            [activationId, license.id, studentId, deviceId, activationTokenHash, now, activationExpiry]);
            return { ok: true, license: assigned, activationId, reused: !!existing, expiresAt: activationExpiry, maxDevices: limit };
        });
    } catch (error) {
        if (error.statusCode) return { ok: false, reason: error.code, limit: error.limit, activeCount: error.activeCount };
        throw error;
    }
};

module.exports.touchActivation = async (activationId) => {
    await q(`UPDATE activations SET last_used_at=$1 WHERE id=$2`, [new Date().toISOString(), activationId]);
};

/**
 * Alias compatible con server.js: obtiene una sesión de reproducción activa (no expirada).
 */
module.exports.getActiveSession = async (sessionId) => {
    const row = (await q(
        `SELECT * FROM playback_sessions WHERE session_id=$1 AND expires_at > $2`,
        [sessionId, new Date().toISOString()]
    )).rows[0];
    if (!row) return null;
    return {
        sessionId: row.session_id,
        studentId: row.student_id,
        videoId:   row.lesson_id,   // lesson_id almacena el videoId en este sistema
        courseId:  row.course_id,
        deviceId:  row.device_id,
        expiresAt: row.expires_at,
    };
};

/**
 * Alias compatible con server.js: busca un alumno por su UUID (sub del JWT).
 */
module.exports.getStudentById = module.exports.findStudentById;

/**
 * Revoca todas las activaciones activas de un alumno.
 * La licencia NO se revoca — el alumno puede volver a activar.
 */
module.exports.resetStudentActivations = async (studentId, revokedBy = 'admin') => {
    const now = new Date().toISOString();
    const rows = (await q(
        `UPDATE activations SET status='revoked', revoked_at=$1, revoked_by=$2
         WHERE student_id=$3 AND status='active'
         RETURNING id`,
        [now, revokedBy, studentId]
    )).rows;
    // También revocar los devices vinculados al alumno
    await q(`UPDATE devices SET status='blocked' WHERE student_id=$1`, [studentId]);
    return rows.length;
};

/**
 * Limpieza profunda por alumno: elimina rastro de dispositivos/licencias/activaciones
 * y limpia huellas de dispositivo en students.
 * Se ejecuta dentro de transacción y SOLO afecta al alumno indicado.
 */
module.exports.hardResetStudentDeviceState = async (studentId) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const deviceCount = parseInt((await client.query(
            'SELECT COUNT(*)::int AS n FROM devices WHERE student_id=$1',
            [studentId]
        )).rows[0].n, 10) || 0;

        const activationCount = parseInt((await client.query(
            'SELECT COUNT(*)::int AS n FROM activations WHERE student_id=$1',
            [studentId]
        )).rows[0].n, 10) || 0;

        const licenseCount = parseInt((await client.query(
            'SELECT COUNT(*)::int AS n FROM licenses WHERE student_id=$1',
            [studentId]
        )).rows[0].n, 10) || 0;

        await client.query('DELETE FROM playback_sessions WHERE student_id=$1', [studentId]);
        await client.query('DELETE FROM active_sessions WHERE user_id=$1', [studentId]);
        await client.query('DELETE FROM playback_progress WHERE student_id=$1', [studentId]);
        await client.query('DELETE FROM playback_events WHERE student_id=$1', [studentId]);
        await client.query('DELETE FROM watermark_logs WHERE user_id=$1', [studentId]);
        await client.query('DELETE FROM suspicious_activity WHERE student_id=$1', [studentId]);

        // Primero borrar activaciones, luego licencias para no dejar residuos.
        await client.query('DELETE FROM activations WHERE student_id=$1', [studentId]);
        await client.query('DELETE FROM licenses WHERE student_id=$1', [studentId]);
        await client.query('DELETE FROM devices WHERE student_id=$1', [studentId]);

        await client.query(
            `UPDATE students
             SET device_id = NULL,
                 last_login = NULL,
                 device_model = '',
                 device_name = '',
                 device_serial = '',
                 os_version = '',
                 os_version_code = '',
                 cpu_cores = '',
                 total_ram = '',
                 android_id = '',
                 build_fingerprint = '',
                 brand = '',
                 manufacturer = '',
                 fcm_token = ''
             WHERE id = $1`,
            [studentId]
        );

        await client.query('COMMIT');
        return { ok: true, deviceCount, activationCount, licenseCount };
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
};

// ================================================================
//  API — SHORT TOKENS
// ================================================================

module.exports.storePendingToken = async (token, cmd, auth, expiresAtMs, isDev = false) => {
    await q(
        `INSERT INTO pending_play_tokens (token, cmd, auth, expires_at, is_dev)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (token) DO UPDATE SET cmd=EXCLUDED.cmd, auth=EXCLUDED.auth, expires_at=EXCLUDED.expires_at, is_dev=EXCLUDED.is_dev`,
        [token, cmd, auth, expiresAtMs, isDev ? 1 : 0]
    );
};

module.exports.consumePendingToken = async (token) => {
    const now = Date.now();
    let row = (await q('DELETE FROM pending_play_tokens WHERE token=$1 AND expires_at>$2 AND COALESCE(is_dev,0)=0 RETURNING *', [token, now])).rows[0];
    // Explicit development tokens retain their existing reusable behavior.
    if (!row) row = (await q('SELECT * FROM pending_play_tokens WHERE token=$1 AND expires_at>$2 AND is_dev=1', [token, now])).rows[0];
    if (!row) return null;
    return { cmd: row.cmd, auth: row.auth };
};

// ================================================================
//  API — PLAYER VERSION
// ================================================================

module.exports.getPlayerVersion = async () => {
    const row = (await q('SELECT * FROM player_versions ORDER BY id DESC LIMIT 1')).rows[0];
    if (!row) return { minVersion: '1.0.0', latestVersion: '1.0.0', downloadUrl: null, message: null };
    return { minVersion: row.min_version, latestVersion: row.latest_version, downloadUrl: row.download_url || null, message: row.message || null };
};

module.exports.setPlayerVersion = async ({ minVersion, latestVersion, downloadUrl, message }) => {
    await q(
        `INSERT INTO player_versions (min_version, latest_version, download_url, message, updated_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [(minVersion || '1.0.0').slice(0, 20), (latestVersion || '1.0.0').slice(0, 20),
         downloadUrl ? String(downloadUrl).slice(0, 500) : null,
         message     ? String(message).slice(0, 300)     : null,
         new Date().toISOString()]
    );
};

// ================================================================
//  API — REGISTRATION REQUESTS (Sistema de Aprobación)
// ================================================================

module.exports.createRegistrationRequest = async ({ email, name, deviceId, deviceModel, deviceName, firebaseUid, emailVerified = false }) => {
    const identity = normalizeAccountIdentity({ uid: firebaseUid, email }, false);
    const normalizedEmail = identity.email;
    const normalizedDevice = String(deviceId || '').trim();
    if (!normalizedEmail || !normalizedDevice || normalizedDevice.length > 100) {
        throw dbError('REGISTRATION_FIELDS_INVALID', 'Email y dispositivo válidos son obligatorios.', 400);
    }
    return transaction(async client => {
        await lockAccountIdentity(client, identity);
        // Historical rows need not be unique. Serialize by device instead of
        // adding a UNIQUE migration that could fail against existing data.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['edulock-registration:' + normalizedDevice]);
        const existing = (await client.query(
            'SELECT * FROM registration_requests WHERE device_id=$1 ORDER BY requested_at DESC LIMIT 1 FOR UPDATE', [normalizedDevice]
        )).rows[0];
        if (existing) {
            if (existing.email.toLowerCase().trim() !== normalizedEmail ||
                existing.firebase_uid && existing.firebase_uid !== identity.uid) {
                throw dbError('REGISTRATION_DEVICE_OWNER_CONFLICT', 'Este dispositivo ya tiene una solicitud de otra cuenta.', 403);
            }
            await accountRegistrations(client, identity);
            await client.query(`UPDATE registration_requests SET firebase_uid=COALESCE(NULLIF(firebase_uid,''),$1),
                email_verified=CASE WHEN $2 THEN 1 ELSE email_verified END WHERE id=$3`,
                [identity.uid, !!identity.uid && emailVerified === true, existing.id]);
            return existing.id;
        }
        await accountRegistrations(client, identity);
        const id = uuid4();
        await client.query(
            `INSERT INTO registration_requests (id, firebase_uid, email, name, device_id, device_model, device_name, status, requested_at, email_verified)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9)`,
            [id, identity.uid, normalizedEmail, String(name || '').trim().slice(0,100),
             normalizedDevice, String(deviceModel || '').slice(0,100), String(deviceName || '').slice(0,100), new Date().toISOString(),
             identity.uid && emailVerified === true ? 1 : 0]
        );
        return id;
    });
};

module.exports.getRegistrationRequests = async (status = null) => {
    const sql = status
        ? 'SELECT * FROM registration_requests WHERE status=$1 ORDER BY requested_at DESC'
        : 'SELECT * FROM registration_requests ORDER BY requested_at DESC';
    const params = status ? [status] : [];
    return (await q(sql, params)).rows;
};

module.exports.getRegistrationRequestByEmail = async (email) => {
    return (await q(`SELECT * FROM registration_requests WHERE LOWER(TRIM(email))=LOWER(TRIM($1))
        ORDER BY requested_at DESC, id LIMIT 1`, [email])).rows[0] || null;
};

module.exports.getRegistrationRequestByDevice = async (deviceId) => {
    return (await q('SELECT * FROM registration_requests WHERE device_id=$1 ORDER BY requested_at DESC LIMIT 1', [deviceId])).rows[0] || null;
};

module.exports.updateRegistrationRequest = async (id, { status, reviewedBy, notes }) => {
    await q(
        `UPDATE registration_requests SET status=$1, reviewed_at=$2, reviewed_by=$3, notes=$4 WHERE id=$5`,
        [status, new Date().toISOString(), reviewedBy || 'admin', notes || null, id]
    );
};

module.exports.updateRegistrationName = async (id, name) => {
    await q('UPDATE registration_requests SET name=$1 WHERE id=$2', [name, id]);
};

module.exports.approveRegistrationAtomic = async ({ requestId, courseIds = [], notes = null, maxDevices = 1, reviewedBy = 'admin' } = {}) => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128 ||
        !Array.isArray(courseIds) || courseIds.some(id => typeof id !== 'string' || !uuid.test(id)) ||
        new Set(courseIds).size !== courseIds.length ||
        (notes !== null && typeof notes !== 'string') || typeof reviewedBy !== 'string' || !reviewedBy.trim()) {
        throw dbError('REGISTRATION_APPROVAL_INVALID', 'Solicitud, cursos o datos de aprobación inválidos.', 400);
    }
    if (typeof maxDevices !== 'number' || !Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 50) {
        throw dbError('INVALID_DEVICE_LIMIT', 'El límite de dispositivos debe ser un entero entre 1 y 50.', 400);
    }
    return transaction(async client => {
        // Read without a row lock first so every identity workflow acquires
        // identity advisory locks before student/registration row locks.
        const preview = (await client.query('SELECT * FROM registration_requests WHERE id=$1', [requestId])).rows[0];
        if (!preview) throw dbError('REGISTRATION_NOT_FOUND', 'Solicitud no encontrada.', 404);
        const identity = normalizeAccountIdentity({ uid: preview.firebase_uid, email: preview.email }, false);
        await lockAccountIdentity(client, identity);
        const registration = (await client.query('SELECT * FROM registration_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0];
        if (!registration) throw dbError('REGISTRATION_NOT_FOUND', 'Solicitud no encontrada.', 404);
        if ((registration.firebase_uid || null) !== (preview.firebase_uid || null) || registration.email !== preview.email) {
            throw dbError('ACCOUNT_IDENTITY_MISMATCH', 'La identidad de la solicitud cambió. Vuelve a revisar la cuenta.');
        }
        await accountRegistrations(client, identity);
        let student = await accountStudents(client, identity);
        if (registration.status === 'suspended' || student && (Number(student.active) !== 1 || student.approval_status === 'suspended')) {
            throw dbError('ACCOUNT_SUSPENDED', 'La cuenta está suspendida. Restáurala explícitamente antes de aprobar esta solicitud.');
        }
        if (student && !student.firebase_uid && identity.uid && registration.email_verified !== 1) {
            throw dbError('EMAIL_VERIFICATION_REQUIRED', 'Falta verificar el correo para vincular esta cuenta existente.', 403);
        }
        if (courseIds.length) {
            const courses = (await client.query('SELECT id FROM courses WHERE id=ANY($1::text[]) ORDER BY id FOR KEY SHARE', [courseIds])).rows;
            if (courses.length !== courseIds.length) throw dbError('COURSE_NOT_FOUND', 'Uno de los cursos seleccionados no existe.', 400);
        }
        const now = new Date().toISOString();
        // This wildcard is the explicit administrator's all-courses approval.
        // resolveFirebaseAccount cannot enter this path or create a student.
        const allowedVideos = courseIds.length ? JSON.stringify(courseIds) : '*';
        if (!student) {
            student = (await client.query(`INSERT INTO students
                (id,email,student_id,name,active,allowed_videos,created_at,firebase_uid,approval_status,max_devices)
                VALUES($1,$2,$3,$4,1,$5,$6,$7,'approved',$8) RETURNING *`,
                [uuid4(), identity.email, identity.email.split('@')[0], registration.name || identity.email,
                 allowedVideos, now, identity.uid, maxDevices])).rows[0];
        } else {
            // Preserve identity, producer, device, creation data and all license
            // relationships. Only the explicitly approved access is replaced.
            student = (await client.query(`UPDATE students SET allowed_videos=$1,approval_status='approved',
                max_devices=$2,firebase_uid=COALESCE(NULLIF(firebase_uid,''),$3) WHERE id=$4 RETURNING *`,
                [allowedVideos, maxDevices, identity.uid, student.id])).rows[0];
        }
        await client.query('DELETE FROM student_courses WHERE student_id=$1', [student.id]);
        for (const courseId of courseIds) {
            await client.query(`INSERT INTO student_courses(student_id,course_id,granted_at,granted_by) VALUES($1,$2,$3,$4)`,
                [student.id, courseId, now, reviewedBy]);
        }
        // Same device policy as setStudentMaxDevices, within this transaction.
        await client.query("UPDATE licenses SET max_devices=$1 WHERE student_id=$2 AND status='active'", [maxDevices, student.id]);
        await client.query(`UPDATE registration_requests SET status='approved',reviewed_at=$1,reviewed_by=$2,notes=$3 WHERE id=$4`,
            [now, reviewedBy, notes, requestId]);
        return { ok: true, studentId: student.id, maxDevices };
    });
};

// ================================================================
//  API — STUDENT COURSES (Acceso por Curso)
// ================================================================

module.exports.getStudentCourses = async (studentId) => {
    return (await q('SELECT course_id, granted_at, granted_by FROM student_courses WHERE student_id=$1', [studentId])).rows;
};

/**
 * Mantiene students.allowed_videos sincronizado con los cursos asignados.
 * allowed_videos es la ÚNICA fuente que usa el reproductor (/api/my-catalog y
 * la validación de acceso a videos). Sin esta sincronización, asignar cursos por
 * la tabla student_courses NO se reflejaba en el panel del alumno y el botón de
 * "Cursos" no aparecía.
 *
 * Regla: nunca degrada a un alumno con acceso total ('*') salvo que se le
 * asignen cursos específicos. Si se quedó sin cursos y ya era restringido, se
 * revoca el acceso ('[]').
 */
async function syncAllowedVideosFromCourses(studentId) {
    const st = (await q('SELECT allowed_videos FROM students WHERE id=$1', [studentId])).rows[0];
    if (!st) return;
    const courseIds = (await q('SELECT course_id FROM student_courses WHERE student_id=$1', [studentId]))
        .rows.map(r => r.course_id);
    if (courseIds.length > 0) {
        await q('UPDATE students SET allowed_videos=$1 WHERE id=$2', [JSON.stringify(courseIds), studentId]);
    } else if (st.allowed_videos !== '*') {
        await q('UPDATE students SET allowed_videos=$1 WHERE id=$2', ['[]', studentId]);
    }
    // Si allowed_videos === '*' y no hay cursos → se deja intacto (acceso total).
}

module.exports.setStudentCourses = async (studentId, courseIds, grantedBy = 'admin') => {
    // Delete all existing and insert new ones atomically
    await q('DELETE FROM student_courses WHERE student_id=$1', [studentId]);
    for (const courseId of courseIds) {
        await q(
            `INSERT INTO student_courses (student_id, course_id, granted_at, granted_by)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [studentId, courseId, new Date().toISOString(), grantedBy]
        );
    }
    await syncAllowedVideosFromCourses(studentId);
};

module.exports.addStudentCourse = async (studentId, courseId, grantedBy = 'admin') => {
    await q(
        `INSERT INTO student_courses (student_id, course_id, granted_at, granted_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [studentId, courseId, new Date().toISOString(), grantedBy]
    );
    await syncAllowedVideosFromCourses(studentId);
};

module.exports.removeStudentCourse = async (studentId, courseId) => {
    await q('DELETE FROM student_courses WHERE student_id=$1 AND course_id=$2', [studentId, courseId]);
    await syncAllowedVideosFromCourses(studentId);
};

module.exports.hasStudentCourseAccess = async (studentId, courseId) => {
    // If student has allowed_videos = '*' (full access), always true
    const st = (await q('SELECT allowed_videos FROM students WHERE id=$1', [studentId])).rows[0];
    if (!st) return false;
    if (st.allowed_videos === '*') return true;
    const row = (await q('SELECT 1 FROM student_courses WHERE student_id=$1 AND course_id=$2', [studentId, courseId])).rows[0];
    return !!row;
};

module.exports.updateStudentApprovalStatus = async (studentId, approvalStatus) => {
    await q(`UPDATE students SET approval_status=$1 WHERE id=$2`, [approvalStatus, studentId]);
};

module.exports.countPendingRegistrations = async () => {
    const res = await q("SELECT COUNT(*) as n FROM registration_requests WHERE status='pending'");
    return parseInt(res.rows[0].n, 10);
};

// ================================================================
//  PRODUCER-STUDENT LINKING & LICENSE BINDING
// ================================================================

module.exports.linkProducerStudent = async (producerId, studentId, linkedVia) => {
    await q(
        `INSERT INTO producer_students (producer_id, student_id, linked_at, linked_via)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [producerId, studentId, new Date().toISOString(), linkedVia || 'license_activation']
    );
};

module.exports.bindLicenseToStudent = async (licenseId, studentId) => {
    const res = await q(
        `UPDATE licenses SET student_id=$1 WHERE id=$2 AND student_id IS NULL RETURNING id`,
        [studentId, licenseId]
    );
    return res.rowCount > 0;
};

module.exports.getProducerLicenses = async (producerId) => {
    return (await q(
        `SELECT l.*, s.email as student_email, s.name as student_name, c.name as course_name
         FROM licenses l
         LEFT JOIN students s ON s.id = l.student_id
         LEFT JOIN courses c ON c.id = l.course_id
         WHERE l.producer_id = $1
         ORDER BY l.created_at DESC`,
        [producerId]
    )).rows;
};

module.exports.getLicensesByBatch = async (batchId) => {
    return (await q(
        `SELECT l.*, s.email as student_email, c.name as course_name
         FROM licenses l
         LEFT JOIN students s ON s.id = l.student_id
         LEFT JOIN courses c ON c.id = l.course_id
         WHERE l.batch_id = $1
         ORDER BY l.created_at`,
        [batchId]
    )).rows;
};

// ================================================================
//  EXPORTS
// ================================================================

module.exports.initDb = initDb;
module.exports.pool  = pool;
module.exports._db   = null; // compat shim — was raw SQLite instance

module.exports.testConnection = async () => {
    const client = await pool.connect();
    try {
        const r = await client.query('SELECT NOW() as now, current_database() as db');
        return r.rows[0];
    } finally {
        client.release();
    }
};
