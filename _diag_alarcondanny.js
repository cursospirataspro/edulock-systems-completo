require('dotenv').config({ path: __dirname + '/.env' });
const admin = require('firebase-admin');
const { Pool } = require('pg');

const EMAIL = 'alarcondanny88@gmail.com';
const cred = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
admin.initializeApp({ credential: cred });

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const tables = ['students', 'registration_requests', 'access_requests'];
  for (const table of tables) {
    const exists = (await p.query(`SELECT to_regclass($1) AS name`, [`public.${table}`])).rows[0].name;
    if (!exists) continue;
    const rows = (await p.query(`SELECT * FROM ${table} WHERE lower(trim(email))=lower($1)`, [EMAIL])).rows;
    console.log(`\n${table}:`, JSON.stringify(rows, null, 2));
  }
  const student = (await p.query('SELECT * FROM students WHERE lower(trim(email))=lower($1)', [EMAIL])).rows[0];
  if (student) {
    for (const table of ['licenses', 'activations', 'devices', 'student_codes', 'sessions']) {
      const exists = (await p.query(`SELECT to_regclass($1) AS name`, [`public.${table}`])).rows[0].name;
      if (!exists) continue;
      const cols = (await p.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table])).rows.map(r => r.column_name);
      if (!cols.includes('student_id')) continue;
      const rows = (await p.query(`SELECT * FROM ${table} WHERE student_id::text IN ($1::text,$2::text)`, [student.id, student.student_id || ''])).rows;
      console.log(`\n${table}:`, JSON.stringify(rows, null, 2));
    }
  }
  const fb = await admin.auth().getUserByEmail(EMAIL).catch(e => ({ lookupError: e.code || e.message }));
  console.log('\nfirebase:', JSON.stringify(fb.lookupError ? fb : {
    uid: fb.uid, email: fb.email, disabled: fb.disabled, emailVerified: fb.emailVerified,
    providers: fb.providerData.map(x => x.providerId), metadata: fb.metadata
  }, null, 2));
  await p.end();
})().catch(e => { console.error('FATAL:', e.stack || e.message); process.exitCode = 1; });
