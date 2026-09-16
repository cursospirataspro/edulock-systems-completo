require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });
p.query(`SELECT key, value FROM app_config WHERE key ILIKE '%download%' OR key ILIKE '%version%' OR key ILIKE '%player%'`)
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); return p.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });

