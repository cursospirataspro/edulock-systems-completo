// audit-firebase-accounts.js — PREVENCIÓN caso "correo de recuperación no llega"
// Garantiza que TODO alumno aprobado/activo tenga cuenta en Firebase Auth.
// Sin cuenta Firebase, "olvidé mi contraseña" nunca envía correo (caso Luis Ventura 01/08).
//
// Uso:  node audit-firebase-accounts.js         → solo reporta (dry-run)
//       node audit-firebase-accounts.js --fix   → crea cuentas faltantes y vincula firebase_uid
//
// Programado como tarea diaria "EdulockFirebaseAudit" (con --fix).
require('dotenv').config({ path: __dirname + '/.env' });
const admin = require('firebase-admin');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');

const FIX = process.argv.includes('--fix');

let cred;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  cred = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
} else if (fs.existsSync(__dirname + '/firebase-service-account.json')) {
  cred = admin.credential.cert(require(__dirname + '/firebase-service-account.json'));
} else {
  console.error('[audit-fb] Sin credenciales Firebase'); process.exit(1);
}
admin.initializeApp({ credential: cred });

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const students = (await p.query(
    `SELECT id, email, name, firebase_uid FROM students
     WHERE active = 1 AND approval_status = 'approved' AND email IS NOT NULL AND email <> ''`
  )).rows;

  // Mapa completo de usuarios Firebase (email → uid)
  const fbByEmail = new Map();
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const u of page.users) if (u.email) fbByEmail.set(u.email.toLowerCase(), u.uid);
    pageToken = page.pageToken;
  } while (pageToken);

  let ok = 0, missing = 0, fixed = 0, relinked = 0;
  for (const s of students) {
    const email = s.email.trim().toLowerCase();
    const uid = fbByEmail.get(email);

    if (uid) {
      ok++;
      // Cuenta existe pero students.firebase_uid desactualizado → re-vincular
      if (FIX && s.firebase_uid !== uid) {
        await p.query('UPDATE students SET firebase_uid=$1 WHERE id=$2', [uid, s.id]);
        relinked++;
        console.log(`[audit-fb] re-vinculado uid de ${email}`);
      }
      continue;
    }

    missing++;
    console.log(`[audit-fb] SIN CUENTA FIREBASE: ${email} (student ${s.id})`);
    if (!FIX) continue;

    try {
      // Contraseña aleatoria: el alumno la define con "olvidé mi contraseña"
      // (que ahora SÍ funciona porque la cuenta existe).
      const randomPass = crypto.randomBytes(18).toString('base64url');
      const user = await admin.auth().createUser({
        email,
        password: randomPass,
        emailVerified: true,
        displayName: s.name || undefined,
      });
      await p.query('UPDATE students SET firebase_uid=$1 WHERE id=$2', [user.uid, s.id]);
      fixed++;
      console.log(`[audit-fb] CREADA cuenta Firebase para ${email} → uid ${user.uid}`);
    } catch (e) {
      console.error(`[audit-fb] ERROR creando cuenta para ${email}:`, e.message);
    }
  }

  console.log(`[audit-fb] ${new Date().toISOString()} — total=${students.length} ok=${ok} sin_cuenta=${missing} creadas=${fixed} revinculadas=${relinked} modo=${FIX ? 'FIX' : 'dry-run'}`);
  await p.end();
  process.exit(0);
})().catch(e => { console.error('[audit-fb] FATAL:', e.message); process.exit(1); });
