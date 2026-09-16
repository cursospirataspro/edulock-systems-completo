// Diagnóstico completo actual: students, Firebase, licencias, códigos, solicitudes
require('dotenv').config({ path: __dirname + '/.env' });
const admin = require('firebase-admin');
const { Pool } = require('pg');
const fs = require('fs');
let cred;
if (process.env.FIREBASE_SERVICE_ACCOUNT) cred = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
else cred = admin.credential.cert(require(__dirname + '/firebase-service-account.json'));
admin.initializeApp({ credential: cred });

const EMAILS = ['lventura001@icloud.com', 'romarintorres@gmail.com'];

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const email of EMAILS) {
    console.log(`\n════ ${email} ════`);
    const s = (await p.query('SELECT * FROM students WHERE lower(email)=lower($1)', [email])).rows[0];
    console.log('students:', s ? JSON.stringify({ id: s.id, student_id: s.student_id, name: s.name, active: s.active, approval: s.approval_status, uid: s.firebase_uid, last_login: s.last_login, allowed: s.allowed_videos }) : 'NO EXISTE');
    const u = await admin.auth().getUserByEmail(email).catch(() => null);
    console.log('firebase:', u ? `uid=${u.uid} verified=${u.emailVerified} lastLogin=${u.metadata.lastSignInTime || 'NUNCA'} disabled=${u.disabled}` : 'NO EXISTE');
    const r = (await p.query('SELECT id, status, device_id FROM registration_requests WHERE lower(email)=lower($1)', [email])).rows;
    console.log('solicitudes:', JSON.stringify(r));
    if (s) {
      const lic = (await p.query('SELECT * FROM licenses WHERE student_id::text=$1::text OR student_id::text=$2::text', [s.id, s.student_id])).rows;
      console.log('licenses:', JSON.stringify(lic));
      const act = (await p.query('SELECT id, status, created_at FROM activations WHERE student_id::text=$1::text', [s.id])).rows;
      console.log('activations:', JSON.stringify(act));
      const codes = (await p.query('SELECT * FROM student_codes WHERE student_id::text=$1::text OR student_id::text=$2::text', [s.id, s.student_id])).rows.map(c => ({ ...c }));
      console.log('student_codes:', JSON.stringify(codes));
      const dev = (await p.query('SELECT fingerprint, device_name, status FROM devices WHERE student_id=$1', [s.id])).rows;
      console.log('devices:', JSON.stringify(dev));
    }
  }
  // esquema licenses para saber cómo se generan
  const cols = (await p.query(`SELECT column_name FROM information_schema.columns WHERE table_name='licenses' ORDER BY ordinal_position`)).rows.map(r => r.column_name);
  console.log('\ncolumnas licenses:', cols.join(', '));
  const sample = (await p.query('SELECT * FROM licenses LIMIT 2')).rows;
  console.log('muestra licenses:', JSON.stringify(sample, null, 1));
  await p.end();
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
