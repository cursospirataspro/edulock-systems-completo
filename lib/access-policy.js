'use strict';

class AccessError extends Error {
  constructor(message, code = 'ACCESS_DENIED', status = 403) {
    super(message); this.code = code; this.status = status;
  }
}
const enabled = value => value === true || value === 1 || value === '1';
const expired = value => value != null && value !== '' && (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now());
function hasVideoAccess(user, videoId, courseId) {
  if (!user || user.guest || user.role === 'producer') return false;
  if (user.admin === true) return true;
  if (user.videoId && user.videoId !== videoId) return false;
  const allowed = Array.isArray(user.allowedVideos) ? user.allowedVideos : [];
  return allowed.includes('*') || allowed.includes(videoId) || !!courseId && allowed.includes(courseId);
}

function createAccessPolicy({ db }) {
  async function hydrate(claims) {
    if (!claims || !claims.sub) throw new AccessError('Inicia sesión para continuar.', 'AUTH_REQUIRED', 401);
    if (claims.admin === true) return { ...claims, allowedVideos: ['*'] };
    if (claims.guest || claims.role === 'producer') throw new AccessError('Se requiere una cuenta de alumno.', 'STUDENT_REQUIRED');
    const student = await db.findStudentById(claims.sub);
    if (!student || !enabled(student.active) || student.approval_status && student.approval_status !== 'approved') {
      throw new AccessError('La cuenta no está activa o aprobada.', 'ACCOUNT_REVOKED');
    }
    return { ...claims, email: student.email, allowedVideos: Array.isArray(student.allowedVideos) ? student.allowedVideos : [], student };
  }

  async function authorizeVideo(claims, videoId, deviceId, { requireActivation = true } = {}) {
    const user = await hydrate(claims);
    const video = await db.getCatalogById(videoId);
    if (!video) throw new AccessError('Video no encontrado.', 'VIDEO_NOT_FOUND', 404);
    if (!hasVideoAccess(user, videoId, video.courseId)) {
      if (video.courseId && (!user.videoId || user.videoId === videoId)) {
        throw new AccessError('Activa una licencia de este curso en tu dispositivo.', 'LICENSE_REQUIRED');
      }
      throw new AccessError('No tienes acceso a este video.', 'VIDEO_FORBIDDEN');
    }
    if (user.admin === true) return { user, video, license: null };
    const device = typeof deviceId === 'string' && deviceId ? deviceId : user.deviceId;
    if (user.deviceId && device && user.deviceId !== device) throw new AccessError('El dispositivo no corresponde a esta sesión.', 'DEVICE_MISMATCH');
    if (!requireActivation) return { user, video, license: null };
    if (!device || device === 'unknown') throw new AccessError('Activa tu licencia en este dispositivo.', 'LICENSE_REQUIRED');
    const rows = (await db.pool.query(`
      SELECT l.*, a.status AS activation_status, a.expires_at AS activation_expires_at,
             d.status AS device_status, p.active AS producer_active
      FROM licenses l
      LEFT JOIN activations a ON a.license_id=l.id AND a.student_id=l.student_id AND a.device_id=$2
      LEFT JOIN devices d ON d.student_id=l.student_id AND d.fingerprint=$2
      LEFT JOIN producers p ON p.id=l.producer_id
      WHERE l.student_id=$1 AND (l.course_id=$3 OR l.course_id IS NULL)
      ORDER BY l.created_at DESC`, [user.sub, device, video.courseId || null])).rows;
    const license = rows.find(row => {
      if (row.status !== 'active' || expired(row.expires_at)) return false;
      if (row.activation_status !== 'active' || expired(row.activation_expires_at)) return false;
      if (row.device_status !== 'active') return false;
      if (row.producer_id && (!enabled(row.producer_active) || row.producer_id !== video.producerId)) return false;
      return true;
    });
    if (!license) throw new AccessError('Activa una licencia vigente de este curso en tu dispositivo.', 'LICENSE_REQUIRED');
    return { user, video, license };
  }

  async function authorizeSession(claims, sessionId, deviceId) {
    if (!claims || !claims.sessionId || claims.sessionId !== sessionId || !claims.videoId) {
      throw new AccessError('La sesión no corresponde a esta reproducción.', 'SESSION_MISMATCH');
    }
    const context = await authorizeVideo(claims, claims.videoId, deviceId);
    const row = (await db.pool.query('SELECT * FROM active_sessions WHERE session_id=$1', [sessionId])).rows[0];
    if (!row || row.user_id !== claims.sub || row.video_id !== claims.videoId) {
      throw new AccessError('La sesión de reproducción terminó.', 'SESSION_REVOKED');
    }
    const device = deviceId || context.user.deviceId;
    if (row.device_id && row.device_id !== device) {
      throw new AccessError('El dispositivo no corresponde a esta sesión.', 'DEVICE_MISMATCH');
    }
    return context;
  }

  async function authorizeResource(claims, resource, deviceId) {
    if (!resource || resource.deletedAt) throw new AccessError('Recurso no encontrado.', 'RESOURCE_NOT_FOUND', 404);
    if (resource.targetKind === 'video') {
      const context = await authorizeVideo(claims, resource.targetId, deviceId);
      if ((context.video.courseId || null) !== (resource.courseId || null) || (context.video.producerId || null) !== (resource.producerId || null)) {
        throw new AccessError('El recurso cambió de curso o propietario.', 'RESOURCE_TARGET_CHANGED', 409);
      }
      return { ...context, resource };
    }
    const user = await hydrate(claims);
    if (resource.targetKind !== 'module' || !resource.courseId) throw new AccessError('El recurso no tiene un curso válido.', 'RESOURCE_TARGET_CHANGED', 409);
    if (user.admin === true) return { user, resource, license: null };
    if (user.videoId || user.sessionId || !(user.allowedVideos.includes('*') || user.allowedVideos.includes(resource.courseId))) {
      throw new AccessError('Activa una licencia de este curso para abrir el documento.', 'LICENSE_REQUIRED');
    }
    const device = typeof deviceId === 'string' && deviceId ? deviceId : user.deviceId;
    if (user.deviceId && user.deviceId !== device) throw new AccessError('El dispositivo no corresponde a esta sesión.', 'DEVICE_MISMATCH');
    if (!device || device === 'unknown') throw new AccessError('Activa la licencia en este dispositivo.', 'LICENSE_REQUIRED');
    const rows = (await db.pool.query(`
      SELECT l.*, a.status AS activation_status, a.expires_at AS activation_expires_at,
             d.status AS device_status, p.active AS producer_active
      FROM licenses l
      LEFT JOIN activations a ON a.license_id=l.id AND a.student_id=l.student_id AND a.device_id=$2
      LEFT JOIN devices d ON d.student_id=l.student_id AND d.fingerprint=$2
      LEFT JOIN producers p ON p.id=l.producer_id
      WHERE l.student_id=$1 AND (l.course_id=$3 OR l.course_id IS NULL)
      ORDER BY l.created_at DESC`, [user.sub, device, resource.courseId])).rows;
    const license = rows.find(row => row.status === 'active' && !expired(row.expires_at) &&
      row.activation_status === 'active' && !expired(row.activation_expires_at) && row.device_status === 'active' &&
      (!row.producer_id || enabled(row.producer_active) && row.producer_id === resource.producerId));
    if (!license) throw new AccessError('Activa una licencia vigente de este curso en tu dispositivo.', 'LICENSE_REQUIRED');
    return { user, resource, license };
  }
  return { hydrate, authorizeVideo, authorizeSession, authorizeResource };
}
module.exports = { AccessError, createAccessPolicy, hasVideoAccess };
