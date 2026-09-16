// Eliminar la cuenta Firebase NUNCA usada lujandcruz12@gmail.com,
// conservando la que el alumno usa para estudiar (lujandceuz12@gmail.com).
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

  // Seguridad: verificar que la cuenta a borrar NO tiene alumno ni solicitud en BD
  const enBd = await p.query(
    `SELECT 'student' AS tipo, email FROM students WHERE lower(email)='lujandcruz12@gmail.com'
     UNION ALL
     SELECT 'request', email FROM registration_requests WHERE lower(email)='lujandcruz12@gmail.com'`
  );
  if (enBd.rows.length) {
    console.error('ABORTADO: lujandcruz12@gmail.com sÃ­ tiene registros en BD:', JSON.stringify(enBd.rows));
    process.exit(1);
  }

  const borrar = await admin.auth().getUserByEmail('lujandcruz12@gmail.com').catch(() => null);
  if (!borrar) { console.log('lujandcruz12@gmail.com ya no existe en Firebase.'); }
  else {
    console.log(`Borrando lujandcruz12@gmail.com (uid ${borrar.uid}, Ãºltimo login: ${borrar.metadata.lastSignInTime || 'NUNCA'})`);
    await admin.auth().deleteUser(borrar.uid);
    console.log('Eliminada.');
  }

  // Confirmar que la cuenta EN USO queda intacta y consistente
  const usa = await admin.auth().getUserByEmail('lujandceuz12@gmail.com');
  const st = (await p.query(`SELECT email, firebase_uid, approval_status, active FROM students WHERE lower(email)='lujandceuz12@gmail.com'`)).rows[0];
  console.log(`\nCuenta conservada: lujandceuz12@gmail.com`);
  console.log(`  Firebase uid=${usa.uid} | BD uid=${st.firebase_uid} | vinculada=${usa.uid === st.firebase_uid} | status=${st.approval_status} active=${st.active}`);
  const link = await admin.auth().generatePasswordResetLink('lujandceuz12@gmail.com').then(() => 'OK').catch(e => 'FALLA: ' + e.message);
  console.log(`  RecuperaciÃ³n de contraseÃ±a: ${link}`);

  await p.end();
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

