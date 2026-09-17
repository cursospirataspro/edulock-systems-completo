'use strict';

const normalizedEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const failure = (message, code, status = 503) => Object.assign(new Error(message), { code, status });

// Identity decisions stay separate from transport and the UI. In particular,
// a failed lookup is never equivalent to a successful lookup with no result.
function createAccountAuth({ db, lookupFirebaseUser, findLocalUser, adminEmail = '', isReady = () => true }) {
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
      producer: await db.getProducerByEmail(email),
    }));
    // Do not expose roles or account details through this public, rate-limited
    // recovery endpoint. An existing SQL/local identity must never auto-register.
    const existsInApplication = email === configuredAdmin || !!local || !!known.student || !!known.producer;
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
  return { accountStatus };
}
module.exports = { createAccountAuth, normalizedEmail, validEmail };
