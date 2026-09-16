// AuditorÃ­a INTEGRAL de alumnos â€” detecta cualquier inconsistencia conocida.
require('dotenv').config({ path: __dirname + '/.env' });
const admin = require('firebase-admin');
const { Pool } = require('pg');
const fs = require('fs');

let cred;
if (process.env.FIREBASE_SERVICE_ACCOUNT) cred = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
else if (fs.existsSync(__dirname + '/firebase-service-account.json')) cred = admin.credential.cert(require(__dirname + '/firebase-service-account.json'));
else { console.error('Sin credenciales Firebase'); process.exit(1); }
admin.initializeApp({ credential: cred });

const problemas = [];
const nota = (categoria, detalle) => problemas.push({ categoria, detalle });

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const students = (await p.query('SELECT * FROM students')).rows;

  // Firebase completo
  const fbByEmail = new Map(); const fbByUid = new Map();
  let tok;
  do {
    const page = await admin.auth().listUsers(1000, tok);
    for (const u of page.users) { if (u.email) fbByEmail.set(u.email.toLowerCase(), u); fbByUid.set(u.uid, u); }
    tok = page.pageToken;
  } while (tok);

  // â”€â”€ 1. Emails malformados / duplicados â”€â”€
  const seen = new Map();
  for (const s of students) {
    const e = (s.email || '');
    if (!e) { nota('email-vacio', `student ${s.id} (${s.student_id})`); continue; }
    if (e !== e.trim() || /\s/.test(e)) nota('email-con-espacios', e);
    if (/\.$/.test(e)) nota('email-punto-final', e);
    if (e !== e.toLowerCase()) nota('email-mayusculas', e);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())) nota('email-invalido', e);
    const k = e.trim().toLowerCase();
    if (seen.has(k)) nota('email-duplicado', `${e} (ids ${seen.get(k)} y ${s.id})`);
    else seen.set(k, s.id);
  }

  // â”€â”€ 2. Estado de aprobaciÃ³n / activaciÃ³n â”€â”€
  for (const s of students) {
    if (s.approval_status === 'approved' && s.active !== 1) nota('aprobado-pero-inactivo', `${s.email}`);
    if (s.approval_status !== 'approved' && s.active === 1) nota('activo-sin-aprobar', `${s.email} (status=${s.approval_status})`);
    if (s.max_devices == null || s.max_devices < 1) nota('max-devices-invalido', `${s.email} (max=${s.max_devices})`);
  }

  const aprobados = students.filter(s => s.active === 1 && s.approval_status === 'approved');

  // â”€â”€ 3. Firebase: cuenta faltante, deshabilitada, uid desvinculado â”€â”€
  for (const s of aprobados) {
    const fb = fbByEmail.get((s.email || '').trim().toLowerCase());
    if (!fb) { nota('firebase-sin-cuenta', s.email); continue; }
    if (fb.disabled) nota('firebase-deshabilitada', s.email);
    if (s.firebase_uid && s.firebase_uid !== fb.uid) nota('firebase-uid-desincronizado', `${s.email} (bd=${s.firebase_uid} fb=${fb.uid})`);
    if (!s.firebase_uid) nota('firebase-uid-sin-vincular', s.email);
  }

  // â”€â”€ 4. Devices: exceso sobre lÃ­mite y huÃ©rfanos â”€â”€
  const devCols = (await p.query(`SELECT column_name FROM information_schema.columns WHERE table_name='devices'`)).rows.map(r => r.column_name);
  const devs = (await p.query('SELECT * FROM devices')).rows;
  const byStudent = new Map();
  for (const d of devs) {
    const sid = d.student_id;
    byStudent.set(sid, (byStudent.get(sid) || 0) + 1);
    if (!students.find(s => s.id === sid)) nota('device-huerfano', `device ${d.id || d.device_id} â†’ student inexistente ${sid}`);
  }
  for (const s of students) {
    const n = byStudent.get(s.id) || 0;
    if (n > (s.max_devices || 1)) nota('devices-exceden-limite', `${s.email}: ${n} devices, max ${s.max_devices}`);
  }

  // â”€â”€ 5. Solicitudes de registro en limbo â”€â”€
  const reqs = (await p.query('SELECT * FROM registration_requests')).rows;
  const emailsStudents = new Set(students.map(s => (s.email || '').toLowerCase()));
  for (const r of reqs) {
    const re = (r.email || '').toLowerCase();
    if (r.status === 'approved' && !emailsStudents.has(re)) nota('solicitud-aprobada-sin-student', `${r.email} (req ${r.id})`);
    if (r.status === 'pending') nota('solicitud-pendiente', `${r.email} (esperando aprobaciÃ³n del admin)`);
  }

  // â”€â”€ 6. Usuarios Firebase sin rastro en BD (registrados nunca aprobados/limbo) â”€â”€
  const emailsReqs = new Set(reqs.map(r => (r.email || '').toLowerCase()));
  for (const [email, u] of fbByEmail) {
    if (!emailsStudents.has(email) && !emailsReqs.has(email)) nota('firebase-sin-bd', `${email} (uid ${u.uid}) â€” cuenta Firebase sin alumno ni solicitud`);
  }

  // â”€â”€ 7. Activaciones/licencias revocadas de alumnos activos â”€â”€
  try {
    const act = (await p.query(`SELECT a.*, s.email FROM activations a JOIN students s ON s.id::text = a.student_id::text WHERE s.active=1 AND a.status IS NOT NULL AND a.status NOT IN ('active','ok')`)).rows;
    for (const a of act) nota('activacion-no-activa', `${a.email}: status=${a.status}`);
  } catch (e) { nota('_info', 'activations no auditable: ' + e.message); }

  // â”€â”€ Resumen â”€â”€
  console.log(`\nAlumnos totales: ${students.length} | aprobados+activos: ${aprobados.length} | devices: ${devs.length} | solicitudes: ${reqs.length} | cuentas Firebase: ${fbByEmail.size}`);
  if (!problemas.length) {
    console.log('\nâœ” SIN PROBLEMAS: todos los alumnos estÃ¡n consistentes en BD y Firebase.');
  } else {
    const porCat = {};
    for (const pr of problemas) (porCat[pr.categoria] = porCat[pr.categoria] || []).push(pr.detalle);
    for (const [cat, items] of Object.entries(porCat)) {
      console.log(`\nâ–  ${cat} (${items.length})`);
      items.slice(0, 30).forEach(i => console.log('   -', i));
    }
  }
  await p.end();
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });

