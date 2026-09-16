'use strict';
function normalizeAuthResponse(response, requireSession = false) {
  const body = response?.body;
  const object = body && typeof body === 'object' && !Array.isArray(body);
  const httpOk = Number.isInteger(response?.status) && response.status >= 200 && response.status < 300;
  if (!object || !httpOk) {
    return { status: 'error', code: object && typeof body.code === 'string' ? body.code : 'ACCOUNT_SERVICE_UNAVAILABLE',
      error: object && typeof body.error === 'string' ? body.error : 'No se pudo comprobar tu cuenta. Intenta de nuevo.',
      registrationAllowed: false, httpStatus: response?.status || 0 };
  }
  if (requireSession && body.status === 'approved' && (typeof body.token !== 'string' || !body.token.trim())) {
    return { status: 'error', code: 'INCOMPLETE_SESSION', error: 'No se pudo iniciar una sesión válida. Intenta de nuevo.', registrationAllowed: false };
  }
  return { ...body, httpStatus: response.status };
}
function connectionFailure() {
  return { status: 'error', code: 'NETWORK_UNAVAILABLE', error: 'No se pudo conectar con Edulock. Revisa tu conexión e intenta de nuevo.', registrationAllowed: false };
}
module.exports = { normalizeAuthResponse, connectionFailure };
