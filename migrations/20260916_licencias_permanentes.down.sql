-- Reversion: restaura vencimientos y duraciones desde la copia de seguridad.
BEGIN;
UPDATE licenses l SET expires_at = b.expires_at, duration_days = b.duration_days
FROM licenses_expiry_backup_20260916 b WHERE b.id = l.id;
COMMIT;
-- Revision de estados historicos ambiguos (solo lectura):
-- SELECT id, status, expires_at, revoked_at, suspended_at FROM licenses WHERE status IN ('expired');
-- La tabla de respaldo se conserva; eliminarla es una decision manual:
-- DROP TABLE licenses_expiry_backup_20260916;
