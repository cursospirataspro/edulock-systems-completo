// Herramienta de operación: ejecutar en el VPS desde /opt/reproductor con NODE_PATH=/opt/reproductor/node_modules node <archivo>. Solo lectura salvo que el nombre indique reparación o prueba; nunca imprime claves.
// Prueba real de reproducción contra el servidor desplegado, con alumno y licencia sintéticos.
// No imprime secretos. Limpia todas las filas sintéticas al terminar.
process.chdir('/opt/reproductor'); require('dotenv').config({ path: '/opt/reproductor/.env' });
const crypto = require('crypto'); const db = require('/opt/reproductor/database-pg.js');
const BASE = 'http://127.0.0.1:3000', PUBLIC = process.env.PUBLIC_URL || 'https://edulocksystemsoficial.dpdns.org';
const APP_SECRET = process.env.APP_SECRET, JWT_SECRET = process.env.JWT_SECRET;
const COURSE = '66dbd2f0-395d-4e11-b6c7-0b12d681732f', VIDEO = '868b24ae-261b-4691-aa23-ce88ee26d705', CODE = 'EDU-868B24AE-5781';
const sig = () => { const ts = String(Date.now()); return { 'x-cdp-ts': ts, 'x-cdp-sig': crypto.createHmac('sha256', APP_SECRET).update('resolve:' + ts).digest('hex') }; };
async function call(method, url, { body, token, headers = {}, raw = false } = {}) {
  const h = { ...headers }; if (body) h['Content-Type'] = 'application/json'; if (token) h.Authorization = 'Bearer ' + token;
  const res = await fetch(url.startsWith('http') ? url : BASE + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, bytes: Buffer.byteLength(text), ct: res.headers.get('content-type') };
}
const unwrap = r => (r.json && typeof r.json.d === 'string') ? Buffer.from(r.json.d, 'base64').toString('utf8') : r.text;
const results = [];
const step = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : '')); };
(async () => {
  const studentId = crypto.randomUUID(), email = `qa-alumno-20260916-${studentId.slice(0, 8)}@edulock-qa.invalid`, password = 'Qa-' + crypto.randomBytes(9).toString('base64url');
  const deviceId = 'qa-device-' + crypto.randomBytes(6).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = `${salt}:${crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256').toString('hex')}`;
  await db.createStudent({ id: studentId, email, studentId: 'qa-' + studentId.slice(0, 8), name: 'Alumno QA 2026-09-16', active: true, allowedVideos: [] });
  await db.pool.query("UPDATE students SET approval_status='approved', password_hash=$1, max_devices=2 WHERE id=$2", [passwordHash, studentId]);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = Array.from({ length: 16 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  const key = raw.match(/.{4}/g).join('-'), licenseId = crypto.randomUUID();
  await db.createFreeLicense({ id: licenseId, licenseKeyHash: crypto.createHmac('sha256', JWT_SECRET).update(key).digest('hex'), courseId: COURSE, lotId: null, maxDevices: 2, producerId: null });
  step('licencia de prueba creada sin vencimiento', (await db.getLicenseById(licenseId)).expires_at === null);
  try {
    const login = await call('POST', '/api/auth/login-email', { body: { email, password, deviceId, deviceModel: 'QA', osVersion: 'QA' } });
    step('login del alumno (email+contraseña)', login.status === 200 && !!login.json?.token, 'HTTP ' + login.status);
    const studentToken = login.json?.token;
    const act = await call('POST', '/api/license/activate', { body: { licenseKey: key, deviceId }, token: studentToken, headers: sig() });
    step('activación de la licencia en el dispositivo', act.status === 200 && !!act.json?.activationToken, 'HTTP ' + act.status + (act.json?.error ? ' ' + act.json.error : '') + ' expiresAt=' + act.json?.expiresAt);
    const launch = await call('POST', `/api/public/video/${CODE}/launch`, { body: {} });
    const perm = (launch.json?.deepLink || '').match(/[?&]p=([^&]+)/)?.[1];
    step('enlace permanente desde la portada pública', launch.status === 200 && !!perm, 'HTTP ' + launch.status);
    const resolve = await call('POST', '/api/playback/resolve-perm', { body: { perm, deviceId }, token: act.json?.token || studentToken, headers: sig() });
    step('resolve-perm (handshake del reproductor)', resolve.status === 200 && !!resolve.json?.manifestUrl, 'HTTP ' + resolve.status + (resolve.json?.error ? ' ' + resolve.json.error : '') + ' watermark=' + (resolve.json?.watermarkText || '').slice(0, 30));
    const mediaToken = resolve.json?.mediaToken;
    const manifestRes = await call('GET', resolve.json.manifestUrl.replace(PUBLIC, BASE)); const master = unwrap(manifestRes);
    step('lista HLS maestra vía servidor (JSON+base64)', manifestRes.status === 200 && master.startsWith('#EXTM3U'), 'HTTP ' + manifestRes.status + ' variantes=' + (master.match(/#EXT-X-STREAM-INF/g) || []).length);
    const hasAudioCodec = /CODECS="[^"]*mp4a/.test(master) || /#EXT-X-MEDIA:TYPE=AUDIO/.test(master);
    const variant = master.split('\n').find(l => l && !l.startsWith('#'));
    const variantUrl = variant.startsWith('http') ? variant.replace(PUBLIC, BASE) : BASE + variant;
    const playlistRes = await call('GET', variantUrl, { token: mediaToken }); const playlistText = unwrap(playlistRes);
    step('lista de calidad (segmentos y clave)', playlistRes.status === 200 && /#EXTINF/.test(playlistText), 'HTTP ' + playlistRes.status + ' segmentos=' + (playlistText.match(/#EXTINF/g) || []).length);
    console.log('INFO pista de audio en este video de demostración: ' + (hasAudioCodec ? 'sí (mp4a)' : 'no; el archivo original no la tiene, se comprueba aparte con el clip QA'));
    const keyUri = playlistText.match(/URI="([^"]+)"/)?.[1];
    if (keyUri) { const k = await call('GET', keyUri.replace(PUBLIC, BASE), { token: mediaToken }); step('clave de descifrado del reproductor', k.status === 200 && k.bytes >= 16, 'HTTP ' + k.status + ' bytes=' + k.bytes); }
    const seg = playlistText.split('\n').find(l => l && !l.startsWith('#'));
    const segRes = await fetch((seg.startsWith('http') ? seg.replace(PUBLIC, BASE) : BASE + seg), { headers: { Authorization: 'Bearer ' + mediaToken } });
    const segBytes = (await segRes.arrayBuffer()).byteLength;
    step('primer segmento de video vía proxy', segRes.status === 200 && segBytes > 1000, 'HTTP ' + segRes.status + ' bytes=' + segBytes);
    const prog = await call('POST', '/api/playback/progress', { body: { videoId: VIDEO, courseId: COURSE, progressPercent: 12, currentTime: 9 }, token: mediaToken });
    step('avance de reproducción registrado', prog.status === 200, 'HTTP ' + prog.status);
    const validate = await call('POST', '/api/license/validate-activation', { body: { activationToken: act.json?.activationToken, deviceId, videoId: VIDEO }, headers: sig() });
    step('validación de la activación guardada', validate.status === 200 && validate.json?.valid === true, 'HTTP ' + validate.status + ' ' + JSON.stringify(validate.json || {}).slice(0, 80));
    const relogin = await call('POST', '/api/auth/login-email', { body: { email, password, deviceId } });
    const ws = await call('POST', '/api/playback/resolve-perm', { body: { perm, deviceId }, token: relogin.json?.token, headers: sig() });
    // Regla vigente (una licencia por sesión): al volver a entrar se pide la licencia otra vez; la licencia y el cupo del equipo se conservan.
    const reactivated = await call('POST', '/api/license/activate', { body: { licenseKey: key, deviceId }, token: relogin.json?.token, headers: sig() });
    step('tras volver a entrar pide la licencia otra vez; la misma clave reactiva sin consumir cupo (la licencia no queda libre)', ws.status === 403 && ws.json?.code === 'LICENSE_REQUIRED' && reactivated.status === 200 && reactivated.json?.reused === true && (await db.getLicenseById(licenseId)).status === 'active', 'sin licencia HTTP ' + ws.status + ' · reactivación HTTP ' + reactivated.status + ' reused=' + reactivated.json?.reused + ' licencia=' + (await db.getLicenseById(licenseId)).status);
    // Each device logs in with its own session token (the JWT is bound to the device that signed in).
    const login2 = await call('POST', '/api/auth/login-email', { body: { email, password, deviceId: deviceId + '-2' } });
    const other = await call('POST', '/api/license/activate', { body: { licenseKey: key, deviceId: deviceId + '-2' }, token: login2.json?.token, headers: sig() });
    const login3 = await call('POST', '/api/auth/login-email', { body: { email, password, deviceId: deviceId + '-3' } });
    const third = await call('POST', '/api/license/activate', { body: { licenseKey: key, deviceId: deviceId + '-3' }, token: login3.json?.token, headers: sig() });
    step('límite de dispositivos (2): segundo equipo entra, tercero rechazado', other.status === 200 && third.status !== 200, '2º HTTP ' + other.status + ' · 3º HTTP ' + third.status + ' ' + (third.json?.code || ''));
  } catch (e) { step('excepción', false, e.message); }
  finally {
    const tables = (await db.pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('student_id','user_id') AND table_name NOT IN ('students')")).rows;
    for (const t of tables) await db.pool.query(`DELETE FROM ${t.table_name} WHERE ${t.column_name}=$1`, [studentId]).catch(() => {});
    await db.pool.query('DELETE FROM activations WHERE license_id=$1', [licenseId]);
    await db.pool.query('DELETE FROM licenses WHERE id=$1', [licenseId]);
    await db.pool.query('DELETE FROM students WHERE id=$1', [studentId]);
    const left = (await db.pool.query("SELECT (SELECT COUNT(*) FROM students WHERE email LIKE '%edulock-qa.invalid') s, (SELECT COUNT(*) FROM licenses WHERE id=$1) l", [licenseId])).rows[0];
    console.log('limpieza: alumnos qa restantes=' + left.s + ' licencias qa restantes=' + left.l);
    console.log('RESUMEN: ' + results.filter(r => r.ok).length + '/' + results.length + ' pasos correctos');
    await db.pool.end();
  }
})().catch(e => { console.error('error', e.message); process.exit(1); });
