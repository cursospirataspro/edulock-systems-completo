-- Reversión: elimina las sesiones de contenido (no toca licencias, activaciones ni dispositivos).
BEGIN;
DROP INDEX IF EXISTS idx_content_sessions_open;
DROP TABLE IF EXISTS content_sessions;
DELETE FROM app_config WHERE key='migrated_pending_students_20260917';
COMMIT;
