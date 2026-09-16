require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const prev = await p.query('SELECT * FROM player_versions ORDER BY id DESC LIMIT 1');
  console.log('anterior:', JSON.stringify(prev.rows[0] || null));
  await p.query(
    `INSERT INTO player_versions (min_version, latest_version, download_url, message, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    ['1.0.0', '1.0.1',
     'https://edulocksystemsoficial.dpdns.org/public/downloads/EdulockFX-Player-Setup-1.0.1.exe',
     'v1.0.1: conexiÃ³n mÃ¡s confiable (respaldo DNS) y mensajes de recuperaciÃ³n de contraseÃ±a mejorados.']
  );
  const r = await p.query('SELECT * FROM player_versions ORDER BY id DESC LIMIT 1');
  console.log('nuevo:', JSON.stringify(r.rows[0]));
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });

