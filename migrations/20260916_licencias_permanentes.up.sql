-- Licencias de curso sin vencimiento (2026-09-16).
-- Reversible: los valores retirados quedan en licenses_expiry_backup_20260916.
-- No cambia claves, alumnos, cursos, cupos, dispositivos, suspensiones ni revocaciones.
BEGIN;
CREATE TABLE IF NOT EXISTS licenses_expiry_backup_20260916 (
    id TEXT PRIMARY KEY,
    status TEXT,
    expires_at TEXT,
    duration_days INTEGER,
    backed_up_at TEXT NOT NULL
);
INSERT INTO licenses_expiry_backup_20260916 (id, status, expires_at, duration_days, backed_up_at)
SELECT id, status, expires_at, duration_days, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM licenses
WHERE expires_at IS NOT NULL OR duration_days IS NOT NULL
ON CONFLICT (id) DO NOTHING;
-- Licencias con estado historico 'expired' se dejan tal cual para revision manual
-- (ver query de revision en el .down.sql); no se reactivan indiscriminadamente.
UPDATE licenses SET expires_at = NULL, duration_days = NULL
WHERE expires_at IS NOT NULL OR duration_days IS NOT NULL;
COMMIT;
