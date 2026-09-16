// Reconstrucción completa: Luis (BD+Firebase desde cero) y Rocio (nueva clave),
// más licencias oficiales XXXX-XXXX-XXXX-XXXX para ambos.
require('dotenv').config({ path: __dirname + '/.env' });
const admin = require('firebase-admin');
const { Pool } = require('pg');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
let cred;
if (process.env.FIREBASE_SERVICE_ACCOUNT) cred = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
else cred = admin.credential.cert(require(__dirname + '/firebase-service-account.json'));
admin.initializeApp({ credential: cred });

const CASES = [
  { email: 'lventura001@icloud.com', name: 'Luis Armando Ventura Escobar', studentId: 'Luis_Armando_Ventura_Escobar', pass: 'Luis2026#Fx' },
  { email: 'romarintorres@gmail.com', name: 'Rocio Marin', studentId: 'Rocio_Mabel_Marin_Torres', pass: 'Rocio2026#Fx' },
];

function makeLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let raw = '';
  const buf = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) raw += chars[buf[i] % chars.length];
  return `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}`;
}

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const resumen = [];

  for (const c of CASES) {
    console.log(`\n════ ${c.email} ════`);

    // 1. Cuenta Firebase (crear o resetear clave)
    let user = await admin.auth().getUserByEmail(c.email).catch(() => null);
    if (!user) {
      user = await admin.auth().createUser({ email: c.email, password: c.pass, emailVerified: true, displayName: c.name });
      console.log(`Firebase: cuenta CREADA uid=${user.uid}`);
    } else {
      await admin.auth().updateUser(user.uid, { password: c.pass, emailVerified: true, disabled: false });
      console.log(`Firebase: clave ACTUALIZADA uid=${user.uid}`);
    }

    // 2. Fila en students (crear si falta, vincular uid)
    let s = (await p.query('SELECT * FROM students WHERE lower(email)=lower($1)', [c.email])).rows[0];
    if (!s) {
      const id = uuidv4();
      await p.query(
        `INSERT INTO students (id, email, student_id, name, active, allowed_videos, created_at, firebase_uid, approval_status, max_devices)
         VALUES ($1, $2, $3, $4, 1, '*', NOW(), $5, 'approved', 1)`,
        [id, c.email, c.studentId, c.name, user.uid]
      );
      s = (await p.query('SELECT * FROM students WHERE id=$1', [id])).rows[0];
      console.log(`students: fila CREADA id=${id}`);
    } else {
      await p.query(`UPDATE students SET firebase_uid=$1, active=1, approval_status='approved', name=COALESCE(NULLIF(name,''),$2) WHERE id=$3`, [user.uid, c.name, s.id]);
      console.log(`students: fila OK id=${s.id} (uid vinculado)`);
    }

    // 3. Licencia oficial (igual que POST /api/license/generate)
    const licenseKey = makeLicenseKey();
    const licenseKeyHash = crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret').update(licenseKey).digest('hex');
    const licenseId = uuidv4();
    await p.query(
      `INSERT INTO licenses (id, license_key_hash, student_id, course_id, status, max_devices, created_at)
       VALUES ($1, $2, $3, NULL, 'active', 2, NOW())`,
      [licenseId, licenseKeyHash, s.id]
    );
    console.log(`licencia: generada ${licenseKey} (id ${licenseId})`);

    resumen.push({ email: c.email, clave: c.pass, licencia: licenseKey, uid: user.uid, studentDbId: s.id });
  }

  // 4. Verificación final: visibles como los ve el panel (getAllStudents = tabla students)
  console.log('\n════ VERIFICACIÓN FINAL ════');
  for (const c of CASES) {
    const s = (await p.query(`SELECT email, student_id, name, active, approval_status, firebase_uid FROM students WHERE lower(email)=lower($1)`, [c.email])).rows[0];
    const u = await admin.auth().getUserByEmail(c.email).catch(() => null);
    const lic = (await p.query(`SELECT COUNT(*)::int n FROM licenses WHERE student_id::text=(SELECT id::text FROM students WHERE lower(email)=lower($1)) AND status='active'`, [c.email])).rows[0];
    console.log(`${c.email}: BD=${!!s} (${s && s.approval_status}/${s && s.active}) Firebase=${!!u} vinculado=${s && u && s.firebase_uid === u.uid} licenciasActivas=${lic.n}`);
  }

  console.log('\n════ CREDENCIALES PARA ENTREGAR ════');
  for (const r of resumen) {
    console.log(`\n${r.email}`);
    console.log(`  Contraseña nueva: ${r.clave}`);
    console.log(`  Licencia:         ${r.licencia}`);
  }
  await p.end();
  process.exit(0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
