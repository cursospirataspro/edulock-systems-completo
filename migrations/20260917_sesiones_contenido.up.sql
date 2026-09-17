-- 2026-09-17 · Sesiones de contenido (una licencia = un curso por sesión) y cuentas pendientes históricas.
-- Seguro de repetir. Antes de aplicar en producción: pg_dump (ver docs/2026-09-16-bunny-licencias-estudiantes.md §11).
BEGIN;
CREATE TABLE IF NOT EXISTS content_sessions (
    id            TEXT PRIMARY KEY,
    student_id    TEXT NOT NULL,
    license_id    TEXT NOT NULL,
    course_id     TEXT,
    producer_id   TEXT,
    device_id     TEXT NOT NULL,
    activation_id TEXT,
    created_at    TEXT NOT NULL,
    last_seen     TEXT,
    ended_at      TEXT,
    ended_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_content_sessions_open ON content_sessions(student_id, device_id) WHERE ended_at IS NULL;
-- Cuentas que esperaban aprobación manual: el registro es automático y el acceso lo decide la licencia.
UPDATE students SET approval_status='approved' WHERE approval_status='pending';
INSERT INTO app_config (key, value) VALUES ('migrated_pending_students_20260917','1') ON CONFLICT (key) DO NOTHING;
COMMIT;
