require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
const URL_NUEVA = 'https://edulocksystemsoficial.dpdns.org/public/downloads/EdulockFX-Player-Setup-1.0.1.exe';
(async () => {
  const prev = await p.query(`SELECT value FROM app_config WHERE key='dl_windows'`);
  console.log('dl_windows anterior:', prev.rows[0] && prev.rows[0].value);
  await p.query(
    `INSERT INTO app_config (key, value) VALUES ('dl_windows', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [URL_NUEVA]
  );
  const r = await p.query(`SELECT value FROM app_config WHERE key='dl_windows'`);
  console.log('dl_windows nuevo:', r.rows[0].value);
  await p.end();
})().catch(e => { console.error(e.message); process.exit(1); });

