// Correcciones finales de la auditorÃ­a global
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

  // 1. Credenciales temporales para elcris20050824@gmail.com
  const u = await admin.auth().getUserByEmail('elcris20050824@gmail.com');
  await admin.auth().updateUser(u.uid, { password: 'ElCris2026!', emailVerified: true });
  console.log('[1] elcris20050824@gmail.com â†’ contraseÃ±a temporal: ElCris2026!');
  const link = await admin.auth().generatePasswordResetLink('elcris20050824@gmail.com').catch(e => 'error: ' + e.message);
  console.log('    Link directo para definir su propia clave:', link);

  // 2. Borrar solicitud de prueba diagnÃ³stica (basura de test)
  const r1 = await p.query(`DELETE FROM registration_requests WHERE email='diagreg_229722327@example.com' RETURNING id`);
  console.log(`[2] Solicitud de prueba diagreg borrada: ${r1.rowCount}`);

  // 3. Jonas Hernandez: borrar restos del typo ".comj"
  //    (ya tiene cuenta correcta jhernandez12343@gmail.com funcionando en el MISMO dispositivo)
  //    La solicitud pendiente .comj apunta a su mismo device â†’ podÃ­a confundir a check-device.
  const r2 = await p.query(`DELETE FROM registration_requests WHERE email='jhernandez12343@gmail.comj' RETURNING id`);
  console.log(`[3a] Solicitud typo .comj borrada: ${r2.rowCount}`);
  const uj = await admin.auth().getUserByEmail('jhernandez12343@gmail.comj').catch(() => null);
  if (uj) { await admin.auth().deleteUser(uj.uid); console.log('[3b] Cuenta Firebase typo .comj eliminada'); }

  // 4. Device huÃ©rfano (alumno ya no existe en BD)
  const r3 = await p.query(`DELETE FROM devices WHERE id='3496f1ac-0c2f-4000-8d71-45fa56a8910c' AND student_id='6c3f17d3-64c2-45f4-a5a5-b3e8ecdcfe0b' RETURNING id`);
  console.log(`[4] Device huÃ©rfano borrado: ${r3.rowCount}`);

  // 5. Verificar que "olvidÃ© mi contraseÃ±a" funciona para TODOS:
  //    muestra aleatoria de 5 alumnos â†’ generar link de reset (misma operaciÃ³n que dispara el correo)
  const sample = (await p.query(`SELECT email FROM students WHERE active=1 AND approval_status='approved' ORDER BY random() LIMIT 5`)).rows;
  console.log('\n[5] Prueba de recuperaciÃ³n de contraseÃ±a (muestra aleatoria):');
  for (const s of sample) {
    try {
      await admin.auth().generatePasswordResetLink(s.email.trim());
      console.log(`    OK  ${s.email}`);
    } catch (e) {
      console.log(`    FALLA ${s.email}: ${e.message}`);
    }
  }

  await p.end();
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

