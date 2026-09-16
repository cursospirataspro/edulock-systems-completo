// InvestigaciÃ³n de hallazgos de la auditorÃ­a global
require('dotenv').config({ path: __dirname + '/.env' });
const admin = require('firebase-admin');
const { Pool } = require('pg');
const fs = require('fs');

let cred;
if (process.env.FIREBASE_SERVICE_ACCOUNT) cred = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
else cred = admin.credential.cert(require(__dirname + '/firebase-service-account.json'));
admin.initializeApp({ credential: cred });

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = async (label, sql, params = []) => {
    try {
      const r = await p.query(sql, params);
      console.log(`\n=== ${label} (${r.rows.length}) ===`);
      console.log(JSON.stringify(r.rows, null, 1));
    } catch (e) { console.log(`\n=== ${label} ERROR: ${e.message}`); }
  };

  // 1. Â¿Los 4 con activaciÃ³n revocada tienen otra activaciÃ³n activa?
  await q('activaciones de los 4 con revoked', `
    SELECT s.email, a.status, a.created_at
    FROM activations a JOIN students s ON s.id::text = a.student_id::text
    WHERE s.email IN ('albertoamasifuenfx@gmail.com','luisfel_10@outlook.com','rigobeita10@gmail.com','corellaalejandro445@gmail.com')
    ORDER BY s.email, a.created_at`);

  // 2. Â¿Emails parecidos en students para las 4 cuentas Firebase sin BD?
  await q('students parecidos a firebase-sin-bd', `
    SELECT email, student_id, approval_status, active FROM students
    WHERE email ILIKE '%jcirae%' OR email ILIKE '%lujan%' OR email ILIKE '%juan.diego%' OR email ILIKE '%juandiego%' OR email ILIKE '%gutisol%'`);

  // 3. Â¿Existe jhernandez... (sin la j final) en students o Firebase?
  await q('students jhernandez', `SELECT email, approval_status, active FROM students WHERE email ILIKE '%jhernandez%'`);
  const fb = await admin.auth().getUserByEmail('jhernandez12343@gmail.com').catch(() => null);
  console.log('\nFirebase jhernandez12343@gmail.com:', fb ? fb.uid : 'NO EXISTE');
  const fbj = await admin.auth().getUserByEmail('jhernandez12343@gmail.comj').catch(() => null);
  console.log('Firebase jhernandez12343@gmail.comj:', fbj ? fbj.uid : 'NO EXISTE');

  // 4. Solicitudes pendientes: detalle completo
  await q('solicitudes pendientes detalle', `SELECT id, email, name, status, device_id, device_model FROM registration_requests WHERE status='pending'`);

  // 5. El device huÃ©rfano real (no admin_)
  await q('device huerfano real', `SELECT * FROM devices WHERE student_id = '6c3f17d3-64c2-45f4-a5a5-b3e8ecdcfe0b'`);

  // 6. Â¿CÃ³mo registra devices el admin? (muestra de admin_)
  await q('devices admin_ muestra', `SELECT student_id, device_name, last_seen FROM devices WHERE student_id LIKE 'admin_%' LIMIT 3`);

  await p.end();
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

