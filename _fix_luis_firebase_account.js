// FIX: crear cuenta Firebase Auth para lventura001@icloud.com (student aprobado sin cuenta)
// y vincular firebase_uid en la BD. ContraseÃ±a temporal para entregar al alumno.
require('dotenv').config({ path: __dirname + '/.env' });
const admin = require('firebase-admin');
const { Pool } = require('pg');
const fs = require('fs');

let cred;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  cred = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
} else if (fs.existsSync(__dirname + '/firebase-service-account.json')) {
  cred = admin.credential.cert(require(__dirname + '/firebase-service-account.json'));
} else {
  console.error('Sin credenciales Firebase'); process.exit(1);
}
admin.initializeApp({ credential: cred });

const EMAIL = 'lventura001@icloud.com';
const TEMP_PASS = 'Edulock2026!';

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });

  // 1. Â¿Ya existe en Firebase?
  let user = await admin.auth().getUserByEmail(EMAIL).catch(() => null);
  if (user) {
    console.log('Ya existÃ­a en Firebase, uid=', user.uid, 'â†’ actualizando contraseÃ±a temporal');
    await admin.auth().updateUser(user.uid, { password: TEMP_PASS, emailVerified: true });
  } else {
    user = await admin.auth().createUser({
      email: EMAIL,
      password: TEMP_PASS,
      emailVerified: true,
      displayName: 'Luis Armando Ventura Escobar',
    });
    console.log('Cuenta Firebase creada, uid=', user.uid);
  }

  // 2. Vincular firebase_uid en students
  const r = await p.query(
    `UPDATE students SET firebase_uid=$1 WHERE lower(email)=lower($2) RETURNING id, email, firebase_uid, approval_status, active, max_devices`,
    [user.uid, EMAIL]
  );
  console.log('Student actualizado:', JSON.stringify(r.rows, null, 2));

  // 3. Generar link de restablecimiento por si prefiere su propia contraseÃ±a
  const link = await admin.auth().generatePasswordResetLink(EMAIL).catch(e => 'no disponible: ' + e.message);
  console.log('\nCredenciales temporales â†’', EMAIL, '/', TEMP_PASS);
  console.log('Link de restablecimiento (opcional):', link);

  await p.end();
  process.exit(0);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });

