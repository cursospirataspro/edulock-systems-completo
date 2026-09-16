require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const q = async (label, sql) => {
    try {
      const r = await p.query(sql);
      console.log(`\n=== ${label} (${r.rows.length}) ===`);
      console.log(JSON.stringify(r.rows, null, 2));
    } catch (e) {
      console.log(`\n=== ${label} ERROR: ${e.message}`);
    }
  };

  await q('tablas', `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`);
  await q('columnas students', `SELECT column_name FROM information_schema.columns WHERE table_name='students' ORDER BY ordinal_position`);
  await q('students match', `SELECT * FROM students WHERE email ILIKE '%lventura%' OR email ILIKE '%romarin%'`);
  await p.end();
})();

