// Detalle de actividad de las cuentas duplicadas/typo antes de corregir
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
  const show = async (email) => {
    const u = await admin.auth().getUserByEmail(email).catch(() => null);
    console.log(`\n${email}:`);
    if (!u) return console.log('  Firebase: NO EXISTE');
    console.log(`  Firebase uid=${u.uid} creada=${u.metadata.creationTime} ultimoLogin=${u.metadata.lastSignInTime || 'NUNCA'} providers=${u.providerData.map(x => x.providerId).join(',')}`);
    const s = (await p.query('SELECT id, email, last_login, firebase_uid, approval_status, active FROM students WHERE lower(email)=lower($1)', [email])).rows[0];
    console.log('  Student BD:', s ? `id=${s.id} last_login=${s.last_login} uid_bd=${s.firebase_uid} status=${s.approval_status}` : 'NO EXISTE');
    if (s) {
      const d = (await p.query('SELECT fingerprint, device_name, last_seen FROM devices WHERE student_id=$1', [s.id])).rows;
      console.log('  Devices:', JSON.stringify(d));
    }
  };
  await show('lujandcruz12@gmail.com');   // Firebase sin BD
  await show('lujandceuz12@gmail.com');   // student BD (posible typo)
  await show('jhernandez12343@gmail.com');  // correcto
  await show('jhernandez12343@gmail.comj'); // typo
  await show('elcris20050824@gmail.com');   // pedir credenciales temporales
  await p.end();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });

