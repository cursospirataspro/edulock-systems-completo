-- Pre-carga de la lista blanca de seguridad (anti-falsos-positivos).
-- Drivers/DLLs legítimos que suelen dar falso positivo en PCs reales
-- (MSI Afterburner, HWiNFO, CPU-Z, overlays de Steam/Discord, RGB,
--  Huawei PC Manager => perfwndmonmodule), + permitir hipervisor
-- (Windows 11 con VBS / Integridad de memoria / Core Isolation).
--
-- Ejecutar UNA vez contra la base de datos de Edulock Systems (PostgreSQL):
--   psql "<CONNECTION_STRING>" -f _seed_whitelist.sql
-- También se puede editar luego desde el panel admin
-- (Versión del Reproductor -> Lista blanca de seguridad).
INSERT INTO app_config (key, value) VALUES (
  'security_whitelist',
  '{"drivers":["rtcore64","winring0","winring0x64","cpuz141_x64","gdrv","inpoutx64","atillk64","msio64","hwrwdrv","nvoclock","openlibsys"],"dlls":["rtsshooks64.dll","rtsshooks.dll","gameoverlayrenderer64.dll","gameoverlayrenderer.dll","discordhook64.dll","nahimicmsiosd.dll","overwolf.dll","perfwndmonmodule.dll","perfwndmonmodule_x86.dll"],"allowHypervisor":true}'
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

SELECT key, value FROM app_config WHERE key = 'security_whitelist';
