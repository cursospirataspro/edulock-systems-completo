'use strict';

const normalizedEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const failure = (message, code, status = 503) => Object.assign(new Error(message), { code, status });
const isEnabled = value => value === true || value === 1 || value === '1';
const text = (value, length = 150) => typeof value === 'string' ? value.trim().slice(0, length) : '';

// Identity decisions stay separate from transport and the UI. In particular,
// a failed lookup is never equivalent to a successful lookup with no result.
function createAccountAuth({ db, verifyFirebaseToken, lookupFirebaseUser, findLocalUser,
  adminEmail = '', signSession, isReady = () => true }) {
  const configuredAdmin = normalizedEmail(adminEmail);
  function ready() { if (!isReady()) throw failure('El servicio de cuentas está temporalmente no disponible. Intenta de nuevo.', 'DB_UNAVAILABLE'); }
  async function sql(work) {
    try { return await work(); }
    catch (error) {
      if (error.code && ['ACCOUNT_IDENTITY_MISMATCH', 'ACCOUNT_SYNC_REQUIRED', 'EMAIL_VERIFICATION_REQUIRED', 'ACCOUNT_DUPLICATE'].includes(error.code)) throw error;
      throw failure('No se pudo consultar tu cuenta. Intenta de nuevo; no necesitas registrarte otra vez.', 'DB_UNAVAILABLE');
    }
  }
  async function localUser(email) {
    try { return await findLocalUser(email); }
    catch { throw failure('No se pudo comprobar tu cuenta. Intenta de nuevo.', 'ACCOUNT_STORE_UNAVAILABLE'); }
  }
  async function accountStatus(body) {
    ready();
    const email = normalizedEmail(body?.email);
    if (!validEmail(email)) throw failure('Introduce un correo válido.', 'INVALID_EMAIL', 400);
    const local = await localUser(email);
    const known = await sql(async () => ({
      student: await db.findStudentByEmail(email),
      registration: await db.getRegistrationRequestByEmail(email),
      producer: await db.getProducerByEmail(email),
    }));
    // Do not expose roles or account details through this public, rate-limited
    // recovery endpoint. An existing SQL/local identity must never auto-register.
    const existsInApplication = email === configuredAdmin || !!local || !!known.student || !!known.registration || !!known.producer;
    let remote, confirmedMissing = false;
    try { remote = await lookupFirebaseUser(email); }
    catch (error) {
      if (error.code === 'auth/user-not-found') { remote = null; confirmedMissing = true; }
      else if (existsInApplication) return { status: 'account_exists', code: 'ACCOUNT_EXISTS', registrationAllowed: false,
        message: 'La cuenta existe. Revisa la contraseña o utiliza su método de acceso habitual.' };
      else throw failure('No se pudo confirmar el estado de la cuenta. Intenta de nuevo; no se abrirá el registro automáticamente.', 'ACCOUNT_LOOKUP_UNAVAILABLE');
    }
    if (!confirmedMissing && (!remote || typeof remote.uid !== 'string' || !remote.uid)) {
      throw failure('No se pudo confirmar el estado de la cuenta. Intenta de nuevo.', 'ACCOUNT_LOOKUP_UNAVAILABLE');
    }
    if (remote) return { status: 'account_exists', code: 'ACCOUNT_EXISTS', registrationAllowed: false,
      message: 'La cuenta existe. Revisa la contraseña o utiliza su método de acceso habitual.' };
    if (existsInApplication) return { status: 'account_sync_required', code: 'ACCOUNT_SYNC_REQUIRED', registrationAllowed: false,
      message: 'Tu cuenta ya existe en Edulock, pero su acceso necesita revisión. Contacta al administrador; no te registres otra vez.' };
    return { status: 'not_registered', code: 'ACCOUNT_NOT_REGISTERED', registrationAllowed: true,
      message: 'Usuario no registrado.' };
  }
  async function login(body) {
    ready();
    if (!body || typeof body.idToken !== 'string' || !body.idToken || body.idToken.length > 20000) {
      throw failure('La sesión de Firebase es obligatoria.', 'INVALID_FIREBASE_TOKEN', 400);
    }
    const deviceId = text(body.deviceId, 101);
    if (!deviceId || deviceId.length > 100) throw failure('No se pudo identificar este equipo. Reinicia el reproductor e intenta de nuevo.', 'DEVICE_ID_REQUIRED', 400);
    let decoded;
    try { decoded = await verifyFirebaseToken(body.idToken); }
    catch (error) {
      if (error.status === 503 || /(?:network|internal|credential|unavailable)/i.test(error.code || '')) {
        throw failure('No se pudo verificar tu sesión. Revisa la conexión e intenta de nuevo.', 'FIREBASE_UNAVAILABLE');
      }
      throw failure('Tu sesión venció o no es válida. Inicia sesión de nuevo.', 'INVALID_FIREBASE_TOKEN', 401);
    }
    const uid = text(decoded?.uid || decoded?.sub, 129), email = normalizedEmail(decoded?.email);
    if (!uid || uid.length > 128 || !validEmail(email)) throw failure('Tu cuenta requiere un correo válido.', 'INVALID_FIREBASE_IDENTITY', 401);
    const local = await localUser(email);
    const emailAdmin = email === configuredAdmin || local?.admin === true;
    // El admin configurado en .env (ADMIN_USER) es de confianza explícita;
    // solo exigir email_verified a admins cuyo email NO coincida con el .env.
    if (emailAdmin && decoded.admin !== true && decoded.email_verified !== true && email !== configuredAdmin) {
      throw failure('Verifica el correo de tu cuenta para acceder como administrador.', 'EMAIL_VERIFICATION_REQUIRED', 403);
    }
    const admin = decoded.admin === true || emailAdmin;
    const meta = { deviceName: text(body.deviceName), browser: text(body.appVersion ? 'Edulock Player ' + body.appVersion : body.deviceModel),
      os: text(body.platform && body.osRelease ? body.platform + ' ' + body.osRelease : body.osVersion || body.deviceName), city: '' };
    if (admin) {
      const device = await sql(() => db.registerOrValidateDevice('admin_' + uid, deviceId, meta, 10));
      if (!device || device.ok !== true) return deviceDenied(device);
      return approved({ sub: uid, email, admin: true, deviceId, approved: true }, 'admin', 'Administrador');
    }
    const account = await sql(() => db.resolveFirebaseAccount({ uid, email, emailVerified: decoded.email_verified === true }));
    const student = account.student;
    if (!student) {
      const registration = account.registration;
      if (registration) {
        if (registration.status === 'approved') throw failure('Tu cuenta está aprobada, pero necesita reparar su registro. Contacta al administrador.', 'ACCOUNT_SYNC_REQUIRED', 409);
        if (['pending', 'suspended', 'rejected'].includes(registration.status)) return {
          status: registration.status, code: 'REGISTRATION_' + registration.status.toUpperCase(), registrationAllowed: false, email };
        throw failure('No se pudo interpretar el estado de tu cuenta.', 'ACCOUNT_SYNC_REQUIRED', 409);
      }
      const owner = await sql(() => db.findStudentByDeviceId(deviceId));
      if (owner) throw failure('Este equipo está vinculado a otra cuenta. Contacta al administrador.', 'DEVICE_TAKEN', 403);
      // Firebase already authenticated this identity. It exists; absence of an
      // application enrollment is not permission to redirect automatically.
      return { status: 'registration_required', code: 'REGISTRATION_REQUIRED', registrationAllowed: false, email,
        message: 'Tu cuenta existe, pero falta completar tu registro en Edulock.' };
    }
    const state = student.approval_status || 'approved';
    if (!isEnabled(student.active) || ['suspended', 'rejected', 'pending'].includes(state)) {
      const status = !isEnabled(student.active) ? 'suspended' : state;
      return { status, code: 'ACCOUNT_' + status.toUpperCase(), registrationAllowed: false, email };
    }
    if (state !== 'approved') throw failure('Tu cuenta necesita revisión del administrador.', 'ACCOUNT_SYNC_REQUIRED', 409);
    const device = await sql(() => db.registerOrValidateDevice(student.id, deviceId, meta, 1));
    if (!device || device.ok !== true) return deviceDenied(device);
    return approved({ sub: student.id, email: student.email, studentEmail: student.email, deviceId, approved: true }, 'student', student.name);
  }
  function deviceDenied(result) {
    const blocked = result?.reason === 'device_blocked';
    throw failure(blocked ? 'Este equipo fue bloqueado por el administrador.' : 'Se alcanzó el límite de equipos de esta cuenta. Contacta al administrador.',
      blocked ? 'DEVICE_BLOCKED' : 'DEVICE_LIMIT_EXCEEDED', 403);
  }
  function approved(claims, role, name) {
    return { status: 'approved', role, token: signSession(claims), email: claims.email, name, registrationAllowed: false };
  }
  return { login, accountStatus };
}
module.exports = { createAccountAuth, normalizedEmail, validEmail };
