'use strict';
const crypto = require('node:crypto');
const active = value => value === 1 || value === true || value === '1';
const expired = value => value != null && value !== '' && (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now());
const fail = (message, code, status = 403) => Object.assign(new Error(message), { code, status });

function createActivationValidator({ db, jwtSecret, accessPolicy }) {
  return async function validate(body = {}) {
    const { activationToken, deviceId, videoId } = body;
    if (typeof activationToken !== 'string' || !activationToken || typeof deviceId !== 'string' || !deviceId || deviceId.length > 100 ||
        videoId != null && (typeof videoId !== 'string' || !videoId)) {
      throw fail('Activación y dispositivo válidos requeridos.', 'INVALID_ACTIVATION', 400);
    }
    const tokenHash = crypto.createHmac('sha256', jwtSecret).update(activationToken).digest('hex');
    const activation = await db.getActivationByTokenHash(tokenHash);
    if (!activation) throw fail('Activación no encontrada.', 'ACTIVATION_NOT_FOUND', 401);
    if (activation.status !== 'active') throw fail('Activación revocada. Ingresa tu licencia nuevamente.', 'ACTIVATION_REVOKED');
    if (activation.device_id !== deviceId) throw fail('Dispositivo no autorizado.', 'DEVICE_MISMATCH');
    if (expired(activation.expires_at)) throw fail('Activación expirada.', 'ACTIVATION_EXPIRED');
    const [license, student, devices] = await Promise.all([
      db.getLicenseById(activation.license_id), db.findStudentById(activation.student_id),
      db.getActiveDevicesByStudent(activation.student_id),
    ]);
    if (!license || license.status !== 'active' || license.student_id !== activation.student_id) {
      throw fail('Tu licencia fue actualizada o revocada. Ingresa la licencia vigente.', 'LICENSE_REGENERATED');
    }
    if (!student || !active(student.active) || student.approval_status && student.approval_status !== 'approved') {
      throw fail('Cuenta suspendida o pendiente de aprobación.', 'ACCOUNT_SUSPENDED');
    }
    if (!devices.some(device => device.fingerprint === deviceId)) throw fail('Dispositivo revocado.', 'DEVICE_REVOKED');
    if (license.producer_id) {
      const producer = await db.getProducerById(license.producer_id);
      // The license row binds student and producer; students.producer_id is a legacy single-owner
      // column and must not reject a buyer who also holds licenses from other producers.
      if (!producer || !active(producer.active)) {
        throw fail('Productor no disponible.', 'PRODUCER_INACTIVE');
      }
    }
    if (videoId) {
      const context = await accessPolicy.authorizeVideo({ sub: student.id, deviceId }, videoId, deviceId);
      if (license.course_id && license.course_id !== context.video.courseId) {
        throw fail('Esta activación corresponde a otro curso.', 'VIDEO_NOT_ALLOWED');
      }
    }
    await db.touchActivation(activation.id);
    return { valid: true, studentId: activation.student_id, licenseId: activation.license_id, courseId: license.course_id || null };
  };
}
module.exports = { createActivationValidator };
