// DiagnÃ³stico: lventura001 (email con punto final) y romarintorres (ENOTFOUND)
require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const q = async (label, sql, params = []) => {
    try {
      const r = await p.query(sql, params);
      console.log(`\n=== ${label} (${r.rows.length}) ===`);
      console.log(JSON.stringify(r.rows, null, 2));
    } catch (e) {
      console.log(`\n=== ${label} ERROR: ${e.message}`);
    }
  };

  await q('students lventura/romarin', `SELECT id, email, name, status, created_at FROM students WHERE email ILIKE '%lventura%' OR email ILIKE '%romarin%'`);
  await q('access_requests', `SELECT id, email, status, created_at FROM access_requests WHERE email ILIKE '%lventura%' OR email ILIKE '%romarin%'`);
  await q('emails con espacios o punto final (todos)', `SELECT id, email, name FROM students WHERE email ~ '\\.$' OR email ~ '\\s' OR email <> lower(trim(email))`);
  await p.end();
})();

