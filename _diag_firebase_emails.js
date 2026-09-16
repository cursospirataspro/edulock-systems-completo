// Buscar en Firebase Auth usuarios con email parecido a lventura001 / romarintorres
require('dotenv').config({ path: __dirname + '/.env' });
const admin = require('firebase-admin');
const fs = require('fs');

// Localizar credenciales igual que el server (env JSON o archivo local)
let cred;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  cred = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
} else if (fs.existsSync(__dirname + '/firebase-service-account.json')) {
  cred = admin.credential.cert(require(__dirname + '/firebase-service-account.json'));
} else {
  console.error('No encuentro credenciales Firebase');
  process.exit(1);
}
admin.initializeApp({ credential: cred });

(async () => {
  let next;
  const matches = [];
  do {
    const page = await admin.auth().listUsers(1000, next);
    for (const u of page.users) {
      const e = (u.email || '').toLowerCase();
      if (e.includes('lventura') || e.includes('romarin')) {
        matches.push({ uid: u.uid, email: u.email, verified: u.emailVerified, created: u.metadata.creationTime, lastSignIn: u.metadata.lastSignInTime, providers: u.providerData.map(p => p.providerId) });
      }
    }
    next = page.pageToken;
  } while (next);
  console.log(JSON.stringify(matches, null, 2));
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });

