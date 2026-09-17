// Herramienta de operación: ejecutar en el VPS desde /opt/reproductor con NODE_PATH=/opt/reproductor/node_modules node <archivo>.
// Prueba decisiva del recorrido completo de un alumno NUEVO contra el servidor desplegado, sin intervención manual:
//   A) registro real (Firebase + /api/auth/firebase-login) → B) licencia → C) reproducción → D) cerrar sesión →
//   E) volver a entrar (pide licencia otra vez; el mismo equipo no consume cupo) + pruebas adicionales.
// Solo crea datos sintéticos (correos @edulock-qa.invalid, productor/curso QA) y los limpia al terminar.
// Nunca imprime claves, tokens ni correos reales.
process.chdir('/opt/reproductor'); require('dotenv').config({ path: '/opt/reproductor/.env' });
const crypto = require('crypto'); const db = require('/opt/reproductor/database-pg.js');
const BASE = process.env.QA_BASE || 'http://127.0.0.1:3000', PUBLIC = process.env.PUBLIC_URL || 'https://edulocksystemsoficial.dpdns.org';
const APP_SECRET = process.env.APP_SECRET, JWT_SECRET = process.env.JWT_SECRET;
// Clave pública del proyecto Firebase (la misma que usan el reproductor de PC y el APK; no es un secreto).
const FIREBASE_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyASI4Qa_GVmylE4QjkkzTdSNxLt1NgXSu4';
const COURSE = '66dbd2f0-395d-4e11-b6c7-0b12d681732f', VIDEO = '868b24ae-261b-4691-aa23-ce88ee26d705', CODE = 'EDU-868B24AE-5781';
const sig = () => { const ts = String(Date.now()); return { 'x-cdp-ts': ts, 'x-cdp-sig': crypto.createHmac('sha256', APP_SECRET).update('resolve:' + ts).digest('hex') }; };
const hashKey = key => crypto.createHmac('sha256', JWT_SECRET).update(key).digest('hex');
async function call(method, url, { body, token, headers = {} } = {}) {
  const h = { ...headers }; if (body) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
  const res = await fetch(url.startsWith('http') ? url : BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, bytes: Buffer.byteLength(text) };
}
const unwrap = r => (r.json && typeof r.json.d === 'string') ? Buffer.from(r.json.d, 'base64').toString('utf8') : r.text;
const results = []; let section = '';
const step = (name, ok, detail = '') => { results.push({ section, name, ok, detail }); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + section + '] ' + name + (detail ? ' — ' + detail : '')); };
const info = msg => console.log('INFO ' + msg);
const http = r => 'HTTP ' + r.status + (r.json?.code ? ' ' + r.json.code : '') + (r.json?.error ? ' "' + String(r.json.error).slice(0, 70) + '"' : '');
const claims = token => { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; } };
const newKey = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({ length: 16 }, () => a[crypto.randomInt(a.length)]).join('').match(/.{4}/g).join('-'); };

// ── Firebase (Identity Toolkit REST): exactamente lo que hace el reproductor al crear cuenta / iniciar sesión.
async function firebase(action, body) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${FIREBASE_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('firebase ' + action + ' HTTP ' + r.status + ' ' + (j.error?.message || ''));
  return j;
}
const loginEdulock = (idToken, deviceId) => call('POST', '/api/auth/firebase-login', { body: { idToken, deviceId, deviceModel: 'QA-PC', platform: 'win32', appVersion: '1.1.2' } });
const activate = (token, key, deviceId) => call('POST', '/api/session/activate-license', { body: { licenseKey: key, deviceId }, token });
async function play(token, deviceId, perm) {
  const resolve = await call('POST', '/api/playback/resolve-perm', { body: { perm, deviceId }, token, headers: sig() });
  if (resolve.status !== 200) return { resolve };
  const manifestRes = await call('GET', resolve.json.manifestUrl.replace(PUBLIC, BASE)); const master = unwrap(manifestRes);
  if (manifestRes.status !== 200 || !master.startsWith('#EXTM3U')) return { resolve, manifestStatus: manifestRes.status, manifestError: master.slice(0, 80), segStatus: 0, segBytes: 0 };
  const variant =master.split('\n').find(l => l && !l.startsWith('#')) || '';
  const playlistRes = await call('GET', variant.startsWith('http') ? variant.replace(PUBLIC, BASE) : BASE + variant, { token: resolve.json.mediaToken });
  const playlist = unwrap(playlistRes);
  const seg = playlist.split('\n').find(l => l && !l.startsWith('#')) || '';
  const segRes = await fetch(seg.startsWith('http') ? seg.replace(PUBLIC, BASE) : BASE + seg, { headers: { Authorization: 'Bearer ' + resolve.json.mediaToken } });
  const segBytes = (await segRes.arrayBuffer()).byteLength;
  return { resolve, master, manifestStatus: manifestRes.status, playlistStatus: playlistRes.status, segments: (playlist.match(/#EXTINF/g) || []).length, segStatus: segRes.status, segBytes,
    audio: /CODECS="[^"]*mp4a/.test(master) || /#EXT-X-MEDIA:TYPE=AUDIO/.test(master) };
}
const count = async (sql, params) => Number((await db.pool.query(sql, params)).rows[0].n);

(async () => {
  const stamp = new Date().toISOString().slice(0, 10), tag = crypto.randomBytes(4).toString('hex');
  const email = `qa-alumno-${stamp}-${tag}@edulock-qa.invalid`, password = 'Qa-' + crypto.randomBytes(9).toString('base64url');
  const email2 = `qa-otro-${stamp}-${tag}@edulock-qa.invalid`, reservedEmail = `qa-reservado-${stamp}-${tag}@edulock-qa.invalid`;
  const dev1 = 'qa-pc-' + tag, dev2 = 'qa-movil-' + tag, dev3 = 'qa-tercero-' + tag;
  const keyA = newKey(), keyB = newKey(), keyR = newKey();
  const licA = crypto.randomUUID(), licB = crypto.randomUUID(), licR = crypto.randomUUID();
  const producerId = crypto.randomUUID(), courseB = crypto.randomUUID();
  const studentIds = new Set(); const firebaseTokens = [];
  const cleanupIds = { licenses: [licA, licB, licR], producer: producerId, course: courseB };
  try {
    // ── Preparación (lado vendedor): el productor QA y sus claves ya existen antes de que el alumno llegue.
    await db.createProducer({ id: producerId, email: `qa-productor-${tag}@edulock-qa.invalid`, passwordHash: 'x', name: 'Productor QA ' + stamp, maxDevices: 2 });
    await db.createCourse({ id: courseB, name: 'Curso QA ' + stamp, author: 'QA', sortOrder: 9999, producerId });
    await db.createFreeLicense({ id: licA, licenseKeyHash: hashKey(keyA), courseId: COURSE, lotId: null, maxDevices: 2, producerId: null });
    await db.createFreeLicense({ id: licB, licenseKeyHash: hashKey(keyB), courseId: courseB, lotId: null, maxDevices: 2, producerId });
    await db.createFreeLicense({ id: licR, licenseKeyHash: hashKey(keyR), courseId: COURSE, lotId: null, maxDevices: 2, producerId: null });
    await db.pool.query('UPDATE licenses SET customer_email=$1 WHERE id=$2', [reservedEmail, licR]);
    section = 'prep';
    step('claves QA creadas sin vencimiento', (await count('SELECT COUNT(*) AS n FROM licenses WHERE id = ANY($1) AND expires_at IS NULL', [[licA, licB, licR]])) === 3);

    // ── A) Registro de un alumno nuevo desde el reproductor (sin admin)
    section = 'A registro';
    const before = await db.findStudentByEmail(email);
    step('el alumno no existía antes', !before);
    const signUp = await firebase('signUp', { email, password, returnSecureToken: true }); firebaseTokens.push(signUp.idToken);
    const login = await loginEdulock(signUp.idToken, dev1);
    step('firebase-login crea la cuenta al instante (sin solicitud ni aprobación)', login.status === 200 && login.json?.status === 'approved' && !!login.json?.token && login.json?.requiresLicense === true, http(login) + ' status=' + login.json?.status);
    const student = await db.findStudentByEmail(email); if (student) studentIds.add(student.id);
    step('fila de alumno automática y aprobada', !!student && student.approval_status === 'approved' && Number(student.active) === 1);
    step('no se creó ninguna solicitud de registro pendiente', (await count("SELECT COUNT(*) AS n FROM registration_requests WHERE lower(email)=lower($1) AND status='pending'", [email])) === 0);
    const t1 = login.json?.token, c1 = claims(t1 || '');
    step('token de sesión limitada (hasLicense=false, sin licencia ni curso)', c1.hasLicense === false && !c1.licenseId && !c1.sid);
    const cat0 = await call('GET', '/api/my-catalog', { token: t1 });
    step('catálogo vacío: pide licencia', cat0.status === 200 && cat0.json?.requiresLicense === true && (cat0.json?.courses || []).length === 0, http(cat0));
    const launch = await call('POST', `/api/public/video/${CODE}/launch`, { body: {} });
    const perm = (launch.json?.deepLink || '').match(/[?&]p=([^&]+)/)?.[1];
    step('enlace permanente público disponible', launch.status === 200 && !!perm, http(launch));
    const noLic = await play(t1, dev1, perm);
    step('sin licencia no hay contenido (identidad ≠ autorización)', noLic.resolve.status === 403 && noLic.resolve.json?.code === 'LICENSE_REQUIRED', http(noLic.resolve));

    // ── B) Licencia → sesión de contenido de UN curso
    section = 'B licencia';
    const act1 = await activate(t1, keyA, dev1);
    const t2 = act1.json?.token, c2 = claims(t2 || '');
    step('activación por /api/session/activate-license', act1.status === 200 && !!t2 && !!act1.json?.activationToken && act1.json?.hasLicense === true, http(act1) + ' reused=' + act1.json?.reused);
    step('token de contenido atado a licencia+curso+dispositivo+sesión', c2.hasLicense === true && c2.licenseId === licA && c2.courseId === COURSE && c2.deviceId === dev1 && !!c2.sid && JSON.stringify(c2.allowedVideos) === JSON.stringify([COURSE]));
    const licRowA = await db.getLicenseById(licA);
    step('licencia libre → activa y ligada al alumno, sin vencimiento', licRowA.status === 'active' && licRowA.student_id === student?.id && licRowA.expires_at === null);
    step('sesión de contenido abierta en el servidor', (await count('SELECT COUNT(*) AS n FROM content_sessions WHERE id=$1 AND ended_at IS NULL', [c2.sid])) === 1);
    step('activación única (licencia, dispositivo)', (await count("SELECT COUNT(*) AS n FROM activations WHERE license_id=$1 AND status='active'", [licA])) === 1);
    const cat1 = await call('GET', '/api/my-catalog', { token: t2 });
    step('catálogo muestra solo el curso de la licencia', cat1.status === 200 && (cat1.json?.courses || []).length === 1 && (cat1.json.courses[0].id || cat1.json.courses[0].courseId) === COURSE, http(cat1) + ' cursos=' + (cat1.json?.courses || []).length);

    // ── C) Reproducción
    section = 'C reproducción';
    const p1 = await play(t2, dev1, perm);
    step('resolve-perm con la sesión de contenido', p1.resolve.status === 200 && !!p1.resolve.json?.manifestUrl, http(p1.resolve));
    step('lista maestra + lista de calidad + primer segmento vía servidor', p1.manifestStatus === 200 && p1.playlistStatus === 200 && p1.segStatus === 200 && p1.segBytes > 1000, `manifest HTTP ${p1.manifestStatus} ${p1.manifestError || ''} segmentos=${p1.segments} bytes=${p1.segBytes}`);
    info('pista de audio anunciada en el video de demostración: ' + (p1.audio ? 'sí (mp4a)' : 'no (el archivo original no la trae; el pipeline de audio se comprobó aparte)'));
    const val = await call('POST', '/api/license/validate-activation', { body: { activationToken: act1.json.activationToken, deviceId: dev1, videoId: VIDEO }, headers: sig() });
    step('validación local de la activación (arranque del reproductor)', val.status === 200 && val.json?.valid === true, http(val));
    const refresh1 = await call('POST', '/api/auth/refresh', { token: t2 });
    step('renovar token con la sesión abierta conserva la licencia y la sesión', refresh1.status === 200 && claims(refresh1.json?.token || '').sid === c2.sid && claims(refresh1.json?.token || '').licenseId === licA, http(refresh1));

    // ── D) Cerrar sesión
    section = 'D cerrar sesión';
    const out = await call('POST', '/api/auth/logout', { body: { deviceId: dev1 }, token: t2 });
    step('logout en el servidor', out.status === 200 && out.json?.ok === true && out.json.ended >= 1, http(out) + ' ended=' + out.json?.ended);
    const afterOut = await play(t2, dev1, perm);
    step('el token de contenido anterior ya no reproduce', afterOut.resolve.status === 401 && afterOut.resolve.json?.code === 'SESSION_ENDED', http(afterOut.resolve));
    const refresh2 = await call('POST', '/api/auth/refresh', { token: t2 });
    step('el token anterior tampoco se puede renovar', refresh2.status === 401 && refresh2.json?.code === 'SESSION_ENDED', http(refresh2));
    const catOut = await call('GET', '/api/my-catalog', { token: t2 });
    step('catálogo cerrado con el token anterior', catOut.status === 401, http(catOut));
    const act = (await db.pool.query('SELECT status FROM activations WHERE license_id=$1 AND device_id=$2', [licA, dev1])).rows[0];
    const dev = (await db.pool.query('SELECT status FROM devices WHERE student_id=$1 AND fingerprint=$2', [student.id, dev1])).rows[0];
    step('licencia, activación y dispositivo se conservan (no se libera cupo ni se borra nada)', (await db.getLicenseById(licA)).status === 'active' && act?.status === 'active' && dev?.status === 'active');
    step('la sesión de contenido quedó terminada con motivo logout', (await count("SELECT COUNT(*) AS n FROM content_sessions WHERE id=$1 AND ended_at IS NOT NULL AND ended_reason='logout'", [c2.sid])) === 1);

    // ── E) Volver a entrar: pide licencia otra vez; el mismo equipo no consume otro cupo
    section = 'E reingreso';
    const signIn = await firebase('signInWithPassword', { email, password, returnSecureToken: true }); firebaseTokens.push(signIn.idToken);
    const login2 = await loginEdulock(signIn.idToken, dev1);
    const t3 = login2.json?.token;
    step('inicio de sesión de nuevo → sesión limitada, pide licencia', login2.status === 200 && login2.json?.requiresLicense === true && claims(t3 || '').hasLicense === false, http(login2));
    const noLic2 = await play(t3, dev1, perm);
    step('sin volver a ingresar la licencia no hay contenido', noLic2.resolve.status === 403 && noLic2.resolve.json?.code === 'LICENSE_REQUIRED', http(noLic2.resolve));
    const act2 = await activate(t3, keyA, dev1);
    const t4 = act2.json?.token;
    step('misma clave, mismo equipo: reactivación idempotente (reused)', act2.status === 200 && act2.json?.reused === true && claims(t4 || '').licenseId === licA, http(act2) + ' reused=' + act2.json?.reused);
    step('el mismo equipo sigue contando una sola vez para la licencia', (await count("SELECT COUNT(*) AS n FROM activations WHERE license_id=$1 AND status='active'", [licA])) === 1);
    const p2 = await play(t4, dev1, perm);
    step('vuelve a reproducir', p2.resolve.status === 200 && p2.segStatus === 200 && p2.segBytes > 1000, http(p2.resolve));

    // ── Pruebas adicionales
    section = '1 un curso por sesión';
    const actB = await activate(t3, keyB, dev1);
    const tB = actB.json?.token;
    step('licencia del productor QA (curso B) activa en el mismo equipo', actB.status === 200 && claims(tB || '').courseId === courseB && claims(tB || '').producerId === producerId, http(actB));
    const crossPlay = await play(tB, dev1, perm);
    step('con la sesión del curso B, el curso A se niega', crossPlay.resolve.status === 403 && crossPlay.resolve.json?.code === 'COURSE_NOT_IN_SESSION', http(crossPlay.resolve));
    const prevA = await play(t4, dev1, perm);
    step('la sesión anterior (curso A) quedó reemplazada en este equipo', prevA.resolve.status === 401 && prevA.resolve.json?.code === 'SESSION_ENDED', http(prevA.resolve));
    const catB = await call('GET', '/api/my-catalog', { token: tB });
    step('catálogo de la sesión B muestra solo el curso B', catB.status === 200 && (catB.json?.courses || []).length === 1 && (catB.json.courses[0].id || catB.json.courses[0].courseId) === courseB, http(catB));
    section = '2 alumno del productor';
    step('el alumno aparece en Estudiantes del productor QA (licencia ligada + vínculo productor↔alumno)',
      (await count('SELECT COUNT(*) AS n FROM licenses WHERE producer_id=$1 AND student_id=$2', [producerId, student.id])) === 1 &&
      (await count('SELECT COUNT(*) AS n FROM producer_students WHERE producer_id=$1 AND student_id=$2', [producerId, student.id])) === 1);
    const actA3 = await activate(t3, keyA, dev1);
    step('regresar al curso A con su clave vuelve a funcionar sin consumir cupo', actA3.status === 200 && actA3.json?.reused === true && (await play(actA3.json.token, dev1, perm)).resolve.status === 200, http(actA3));

    section = '3 dispositivos por licencia';
    const signIn2 = await firebase('signInWithPassword', { email, password, returnSecureToken: true }); firebaseTokens.push(signIn2.idToken);
    const loginD2 = await loginEdulock(signIn2.idToken, dev2);
    step('segundo equipo inicia sesión (el cupo global antiguo ya no bloquea)', loginD2.status === 200 && loginD2.json?.status === 'approved', http(loginD2) + ' status=' + loginD2.json?.status);
    const actD2 = await activate(loginD2.json?.token, keyA, dev2);
    step('licencia A (máx. 2) activa en el segundo equipo', actD2.status === 200 && actD2.json?.reused === false, http(actD2));
    const pD2 = await play(actD2.json?.token, dev2, perm);
    step('mientras el equipo 1 sigue reproduciendo, el equipo 2 espera (una reproducción activa por cuenta)', pD2.resolve.status === 429 && pD2.resolve.json?.code === 'SESSION_LIMIT_EXCEEDED', http(pD2.resolve));
    const signIn3 = await firebase('signInWithPassword', { email, password, returnSecureToken: true }); firebaseTokens.push(signIn3.idToken);
    const loginD3 = await loginEdulock(signIn3.idToken, dev3);
    const actD3 = await activate(loginD3.json?.token, keyA, dev3);
    step('tercer equipo rechazado por el límite de la licencia (2)', loginD3.status === 200 && actD3.status === 403 && actD3.json?.code === 'DEVICE_LIMIT_EXCEEDED', 'login3 ' + http(loginD3) + ' · activación ' + http(actD3));
    step('la licencia sigue con exactamente 2 activaciones', (await count("SELECT COUNT(*) AS n FROM activations WHERE license_id=$1 AND status='active'", [licA])) === 2);
    const again1 = await activate(t3, keyA, dev1);
    step('con el cupo lleno, el primer equipo reactiva sin problema (mismo equipo = una vez)', again1.status === 200 && again1.json?.reused === true, http(again1));
    section = '4 logout por equipo';
    const outD1 = await call('POST', '/api/auth/logout', { body: { deviceId: dev1 }, token: again1.json?.token });
    const stillD2 = await play(actD2.json?.token, dev2, perm);
    step('cerrar sesión en el equipo 1 libera la reproducción y no afecta la sesión del equipo 2', outD1.status === 200 && stillD2.resolve.status === 200 && stillD2.segStatus === 200, http(outD1) + ' / equipo2 ' + http(stillD2.resolve));
    section = '5 clave reservada';
    const actR = await activate(t3, keyR, dev1);
    const rowR = await db.getLicenseById(licR);
    step('clave reservada a otro correo: rechazada sin consumir cupo ni asignarse', actR.status === 403 && actR.json?.code === 'LICENSE_OWNER_MISMATCH' && rowR.status === 'free' && !rowR.student_id &&
      (await count('SELECT COUNT(*) AS n FROM activations WHERE license_id=$1', [licR])) === 0, http(actR));
    section = '6 clave de otro alumno';
    const other = { id: crypto.randomUUID(), salt: crypto.randomBytes(16).toString('hex') }; studentIds.add(other.id);
    const pw2 = 'Qa-' + crypto.randomBytes(9).toString('base64url');
    await db.createStudent({ id: other.id, email: email2, studentId: 'qa-' + other.id.slice(0, 8), name: 'Alumno QA 2', active: true, allowedVideos: [] });
    await db.pool.query("UPDATE students SET approval_status='approved', password_hash=$1 WHERE id=$2", [`${other.salt}:${crypto.pbkdf2Sync(pw2, other.salt, 310000, 32, 'sha256').toString('hex')}`, other.id]);
    const loginO = await call('POST', '/api/auth/login-email', { body: { email: email2, password: pw2, deviceId: 'qa-otro-' + tag } });
    const actO = await activate(loginO.json?.token, keyA, 'qa-otro-' + tag);
    step('otra cuenta no puede usar una clave ya ligada', loginO.status === 200 && actO.status === 403 && actO.json?.code === 'LICENSE_OWNER_MISMATCH', http(actO));
    section = '7 activación doble simultánea';
    const [dupA, dupB] = await Promise.all([activate(t3, keyA, dev1), activate(t3, keyA, dev1)]);
    step('dos activaciones simultáneas del mismo equipo → ambas OK y una sola activación', dupA.status === 200 && dupB.status === 200 &&
      (await count("SELECT COUNT(*) AS n FROM activations WHERE license_id=$1 AND device_id=$2", [licA, dev1])) === 1, http(dupA) + ' / ' + http(dupB));
    section = '8 token manipulado';
    const { exp, iat, nbf, iss, ...base } = claims(dupB.json.token);
    const forged = require('jsonwebtoken').sign({ ...base, courseId: courseB, allowedVideos: [courseB] }, JWT_SECRET, { issuer: 'reproductor-cursos', expiresIn: '1h' });
    const launchB = null; // el curso B no tiene video: basta comprobar que el curso A se niega con el token manipulado
    const forgedPlay = await play(forged, dev1, perm);
    step('un token que declare otro curso con la misma licencia no reproduce', forgedPlay.resolve.status === 403, http(forgedPlay.resolve));
    section = '9 flujo antiguo';
    const regs = await call('GET', '/api/admin/registrations', { token: t3 });
    step('las rutas de solicitudes de registro ya no existen', regs.status === 404, http(regs));
    step('todas las licencias QA siguen sin vencimiento tras activarse', (await count('SELECT COUNT(*) AS n FROM licenses WHERE id = ANY($1) AND expires_at IS NULL', [[licA, licB, licR]])) === 3);
    section = '10 versión';
    const ver = await call('GET', '/api/player/version');
    step('servidor responde versión de reproductores', ver.status === 200 && !!ver.json?.latestVersion, http(ver) + ' latest=' + ver.json?.latestVersion + ' min=' + ver.json?.minVersion);
    void launchB;
  } catch (e) { step('excepción', false, e.message); }
  finally {
    section = 'limpieza';
    for (const idToken of firebaseTokens.slice(-1)) { try { await firebase('delete', { idToken }); info('cuenta Firebase QA eliminada'); } catch (e) { info('no se pudo eliminar la cuenta Firebase QA: ' + e.message); } }
    const ids = [...studentIds];
    const tables = (await db.pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('student_id','user_id') AND table_name NOT IN ('students')")).rows;
    for (const id of ids) for (const t of tables) await db.pool.query(`DELETE FROM ${t.table_name} WHERE ${t.column_name}=$1`, [id]).catch(() => {});
    await db.pool.query('DELETE FROM activations WHERE license_id = ANY($1)', [cleanupIds.licenses]).catch(() => {});
    await db.pool.query('DELETE FROM content_sessions WHERE license_id = ANY($1)', [cleanupIds.licenses]).catch(() => {});
    await db.pool.query('DELETE FROM licenses WHERE id = ANY($1)', [cleanupIds.licenses]).catch(() => {});
    await db.pool.query('DELETE FROM students WHERE id = ANY($1)', [ids]).catch(() => {});
    await db.pool.query('DELETE FROM producer_students WHERE producer_id=$1', [cleanupIds.producer]).catch(() => {});
    await db.pool.query('DELETE FROM producer_courses WHERE producer_id=$1', [cleanupIds.producer]).catch(() => {});
    await db.pool.query('DELETE FROM courses WHERE id=$1', [cleanupIds.course]).catch(() => {});
    await db.pool.query('DELETE FROM producers WHERE id=$1', [cleanupIds.producer]).catch(() => {});
    const left = (await db.pool.query("SELECT (SELECT COUNT(*) FROM students WHERE email LIKE '%edulock-qa.invalid') s, (SELECT COUNT(*) FROM producers WHERE email LIKE '%edulock-qa.invalid') p, (SELECT COUNT(*) FROM licenses WHERE id = ANY($1)) l", [cleanupIds.licenses])).rows[0];
    console.log(`limpieza: alumnos qa restantes=${left.s} productores qa restantes=${left.p} licencias qa restantes=${left.l}`);
    const failed = results.filter(r => !r.ok);
    console.log('RESUMEN: ' + (results.length - failed.length) + '/' + results.length + ' pasos correctos' + (failed.length ? ' · fallaron: ' + failed.map(f => '[' + f.section + '] ' + f.name).join(' | ') : ''));
    await db.pool.end();
  }
})().catch(e => { console.error('error', e.message); process.exit(1); });
