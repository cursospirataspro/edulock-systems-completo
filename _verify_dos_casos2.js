require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const q = async (label, sql) => {
    try {
      const r = await p.query(sql);
      console.log(`\n=== ${label} (${r.rows.length}) ===`);
      console.log(JSON.stringify(r.rows, null, 2));
    } catch (e) { console.log(`\n=== ${label} ERROR: ${e.message}`); }
  };
  await q('reg_requests ambos', `SELECT * FROM registration_requests WHERE email ILIKE '%lventura%' OR email ILIKE '%romarin%'`);
  await q('student_courses total', `SELECT COUNT(*)::int AS n FROM student_courses`);
  await q('alumno sano de referencia', `SELECT email, allowed_videos, approval_status, active, firebase_uid IS NOT NULL AS has_fb FROM students WHERE last_login IS NOT NULL ORDER BY last_login DESC LIMIT 3`);
  await p.end();
})();

