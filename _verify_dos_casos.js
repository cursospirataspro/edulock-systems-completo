require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const q = async (label, sql, params) => {
    try {
      const r = await p.query(sql, params);
      console.log(`\n=== ${label} (${r.rows.length}) ===`);
      console.log(JSON.stringify(r.rows, null, 2));
    } catch (e) { console.log(`\n=== ${label} ERROR: ${e.message}`); }
  };
  // Luis
  await q('devices Luis', `SELECT d.* FROM devices d JOIN students s ON s.id=d.student_id WHERE lower(s.email)='lventura001@icloud.com'`);
  await q('registration_requests Luis', `SELECT id,email,status,device_id,created_at FROM registration_requests WHERE email ILIKE '%lventura%'`);
  // Rocio
  await q('devices Rocio', `SELECT d.* FROM devices d JOIN students s ON s.id=d.student_id WHERE lower(s.email)='romarintorres@gmail.com'`);
  await q('registration_requests Rocio', `SELECT id,email,status,device_id,created_at FROM registration_requests WHERE email ILIKE '%romarin%'`);
  // Cursos asignados
  await q('student_courses ambos', `SELECT s.email, sc.* FROM student_courses sc JOIN students s ON s.id=sc.student_id WHERE lower(s.email) IN ('lventura001@icloud.com','romarintorres@gmail.com')`);
  await p.end();
})();

