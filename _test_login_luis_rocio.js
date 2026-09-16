// 1) Inserta solicitudes de registro APROBADAS para ambos (visibles en el panel)
// 2) PRUEBA REAL de login: email+contraseña → Firebase (signInWithPassword) →
//    POST /api/auth/firebase-login → debe devolver status=approved + JWT.
require('dotenv').config({ path: __dirname + '/.env' });
const admin = require('firebase-admin');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const fs = require('fs');
let cred;
if (process.env.FIREBASE_SERVICE_ACCOUNT) cred = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
else cred = admin.credential.cert(require(__dirname + '/firebase-service-account.json'));
admin.initializeApp({ credential: cred });

const API_KEY = 'AIzaSyAEuF1oavtUrfxR2F7OnXoztqF5RiBqpxo'; // web API key del proyecto (pública por diseño)
const CASES = [
  { email: 'lventura001@icloud.com', pass: 'Luis2026#Fx', name: 'Luis Armando Ventura Escobar', deviceId: 'dev_admin_recreado_luis' },
  { email: 'romarintorres@gmail.com', pass: 'Rocio2026#Fx', name: 'Rocio Marin', deviceId: 'dev_55c3591af6a49dec' }, // su device real
];

function postJson(host, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname: host, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });

  // ── 1. Solicitudes de registro aprobadas (para que aparezcan en el panel) ──
  for (const c of CASES) {
    const u = await admin.auth().getUserByEmail(c.email);
    const existing = (await p.query('SELECT id, status FROM registration_requests WHERE lower(email)=lower($1)', [c.email])).rows[0];
    if (existing) {
      await p.query(`UPDATE registration_requests SET status='approved', reviewed_at=$1, reviewed_by='admin@edulocksystemsoficial.dpdns.org' WHERE id=$2`, [new Date().toISOString(), existing.id]);
      console.log(`[solicitud] ${c.email}: existente → marcada approved`);
    } else {
      await p.query(
        `INSERT INTO registration_requests (id, firebase_uid, email, name, device_id, device_model, device_name, status, requested_at, reviewed_at, reviewed_by, notes)
         VALUES ($1,$2,$3,$4,$5,'','', 'approved', $6, $6, 'admin@edulocksystemsoficial.dpdns.org', 'Recreada por soporte 01/08')`,
        [uuidv4(), u.uid, c.email.toLowerCase(), c.name, c.deviceId, new Date().toISOString()]
      );
      console.log(`[solicitud] ${c.email}: CREADA con status=approved`);
    }
  }

  // ── 2. Prueba de login real ──
  console.log('\n════ PRUEBA DE LOGIN (como el reproductor) ════');
  let todoOk = true;
  for (const c of CASES) {
    // Paso A: Firebase signInWithPassword (lo que hace el player con email+clave)
    const fb = await postJson('identitytoolkit.googleapis.com', `/v1/accounts:signInWithPassword?key=${API_KEY}`, {
      email: c.email, password: c.pass, returnSecureToken: true,
    });
    if (fb.status !== 200) { console.log(`✗ ${c.email}: Firebase RECHAZÓ la clave → ${JSON.stringify(fb.body.error && fb.body.error.message)}`); todoOk = false; continue; }
    console.log(`✓ ${c.email}: Firebase aceptó email+contraseña (uid ${fb.body.localId})`);

    // Paso B: firebase-login en nuestro servidor (sin deviceId para no ocupar su cupo de dispositivo)
    const srv = await postJson('edulocksystemsoficial.dpdns.org', '/api/auth/firebase-login', { idToken: fb.body.idToken });
    if (srv.status === 200 && srv.body.status === 'approved' && srv.body.token) {
      console.log(`✓ ${c.email}: servidor → APPROVED, JWT emitido (${String(srv.body.token).slice(0, 25)}...), nombre="${srv.body.name}"`);
    } else {
      console.log(`✗ ${c.email}: servidor respondió ${srv.status} → ${JSON.stringify(srv.body)}`); todoOk = false;
    }
  }

  // ── 3. Visibilidad en el panel ──
  console.log('\n════ VISIBILIDAD EN EL PANEL ════');
  for (const c of CASES) {
    const s = (await p.query(`SELECT approval_status, active FROM students WHERE lower(email)=lower($1)`, [c.email])).rows[0];
    const r = (await p.query(`SELECT status FROM registration_requests WHERE lower(email)=lower($1)`, [c.email])).rows[0];
    console.log(`${c.email}: Lista de alumnos=${s ? 'SÍ (' + s.approval_status + ')' : 'NO'} | Solicitudes de Registro=${r ? 'SÍ (' + r.status + ')' : 'NO'}`);
  }

  console.log(todoOk ? '\n✔ TODO FUNCIONA: ambas cuentas inician sesión correctamente.' : '\n✗ HAY FALLOS — revisar arriba.');
  await p.end();
  process.exit(todoOk ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
