'use strict';
const crypto = require('node:crypto');

function fail(message, code, status = 403) {
    return Object.assign(new Error(message), { code, status });
}

function createPlayerHandshake({ db, jwt, jwtSecret, accessPolicy, verifyFirebaseToken,
    getWatermarkConfig, generateFingerprint, requestVdoOtp, sessions, mediaTtl = 1800,
    maxConcurrent = 1, isReady = () => true, publicBase = req => `${req.protocol}://${req.get('host')}` }) {
    const hash = value => crypto.createHmac('sha256', jwtSecret).update(value).digest('hex');
    function requireReady() { if (!isReady()) throw fail('Servidor iniciando. Intenta de nuevo.', 'DB_UNAVAILABLE', 503); }

    async function register(body) {
        requireReady();
        const { idToken, deviceId, name } = body || {};
        if (typeof idToken !== 'string' || !idToken || typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 100) {
            throw fail('idToken y deviceId requeridos.', 'INVALID_REGISTRATION', 400);
        }
        let decoded;
        try { decoded = await verifyFirebaseToken(idToken); }
        catch (error) {
            if (error.status === 503) throw error;
            throw fail('Token Firebase inválido o expirado.', 'INVALID_FIREBASE_TOKEN', 401);
        }
        const email = typeof decoded.email === 'string' ? decoded.email.trim().toLowerCase() : '';
        const firebaseUid = decoded.uid || decoded.sub;
        if (!email || !firebaseUid) throw fail('La cuenta Firebase necesita correo e identidad.', 'INVALID_FIREBASE_IDENTITY', 401);
        const existing = await db.getRegistrationRequestByDevice(deviceId);
        if (existing) {
            if (String(existing.email || '').trim().toLowerCase() !== email ||
                existing.firebase_uid && existing.firebase_uid !== firebaseUid) {
                throw fail('Este dispositivo corresponde a otra cuenta.', 'DEVICE_TAKEN');
            }
            if (['rejected', 'suspended'].includes(existing.status)) {
                throw Object.assign(fail('Tu solicitud no está aprobada.', 'REGISTRATION_REJECTED'), { registrationStatus: existing.status });
            }
            if (existing.status === 'pending' && name && name !== existing.name) {
                await db.updateRegistrationName(existing.id, String(name).trim().slice(0, 100));
            }
            return { status: existing.status, requestId: existing.id, message: existing.status === 'approved' ? 'Cuenta ya aprobada' : 'Solicitud pendiente de aprobación' };
        }
        // Body identity and password fields are intentionally not forwarded.
        let requestId;
        try {
            requestId = await db.createRegistrationRequest({
                email, firebaseUid, emailVerified: decoded.email_verified === true, deviceId, name: String(name || decoded.name || '').slice(0, 100),
                deviceModel: String(body.deviceModel || '').slice(0, 100),
                deviceName: String(body.deviceName || body.osVersion || '').slice(0, 100),
            });
        } catch (error) {
            if (error.statusCode) throw fail('No se pudo registrar este dispositivo con tu cuenta.', error.code, error.statusCode);
            throw error;
        }
        const current = await db.getRegistrationRequestByDevice(deviceId);
        const status = current?.status || 'pending';
        if (['rejected', 'suspended'].includes(status)) throw Object.assign(fail('Tu solicitud no está aprobada.', 'REGISTRATION_REJECTED'), { registrationStatus: status });
        return { status, requestId: current?.id || requestId, message: status === 'approved' ? 'Cuenta ya aprobada' : 'Solicitud enviada. Esperando aprobación del administrador.' };
    }

    async function activate(req) {
        requireReady();
        const { licenseKey, deviceId } = req.body || {};
        const compact = typeof licenseKey === 'string' ? licenseKey.trim().toUpperCase().replace(/[\s-]/g, '') : '';
        if (!/^[A-Z0-9]{16}$/.test(compact) || typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 64) {
            throw fail('Formato de licencia o dispositivo inválido.', 'INVALID_ACTIVATION', 400);
        }
        const licenseKeyHash = hash(compact.match(/.{4}/g).join('-'));
        const license = await db.getLicenseByKeyHash(licenseKeyHash);
        if (!license) throw fail('Licencia inválida o no encontrada.', 'LICENSE_NOT_FOUND', 401);
        const authorization = req.headers?.authorization || '';
        let user;
        if (authorization) {
            let claims;
            try {
                if (!authorization.startsWith('Bearer ')) throw new Error('bearer');
                claims = jwt.verify(authorization.slice(7), jwtSecret);
            } catch { throw fail('Inicia sesión de nuevo.', 'AUTH_REQUIRED', 401); }
            user = await accessPolicy.hydrate(claims);
            if (user.admin || user.videoId || user.sessionId || user.role === 'perm') {
                throw fail('Activa la licencia con la cuenta del alumno.', 'STUDENT_IDENTITY_REQUIRED');
            }
        } else {
            // Compatibility only for an already assigned, active legacy serial.
            if (license.status !== 'active' || !license.student_id) throw fail('Inicia sesión para reclamar esta licencia.', 'AUTH_REQUIRED', 401);
            user = await accessPolicy.hydrate({ sub: license.student_id });
        }
        if (user.deviceId && user.deviceId !== 'unknown' && user.deviceId !== deviceId) {
            throw fail('El dispositivo no corresponde a tu sesión.', 'DEVICE_MISMATCH');
        }
        const activationToken = crypto.randomBytes(32).toString('base64url');
        const result = await db.claimAndActivateLicenseAtomic({
            licenseKeyHash, studentId: user.sub, deviceId,
            activationTokenHash: hash(activationToken),
            maxAllowed: Number(user.student?.max_devices) || undefined,
            expiresAt: license.expires_at || null,
        });
        if (!result.ok) {
            const code = String(result.reason || 'ACTIVATION_FAILED').toUpperCase();
            const messages = {
                DEVICE_LIMIT_EXCEEDED: 'Dispositivos máximos alcanzados. Contacta al administrador.',
                DEVICE_BLOCKED: 'Este dispositivo está bloqueado.',
                LICENSE_OWNER_MISMATCH: 'Esta licencia pertenece a otra cuenta.',
                LICENSE_EXPIRED: 'La licencia está vencida.',
                LICENSE_INACTIVE: 'La licencia no está activa.',
                PRODUCER_INACTIVE: 'El productor de la licencia está suspendido.',
            };
            throw fail(messages[code] || 'No se pudo activar la licencia. Revisa su vigencia y tu cuenta.', code);
        }
        const fresh = await accessPolicy.hydrate({ sub: user.sub, deviceId });
        const token = jwt.sign({ sub: fresh.sub, email: fresh.email, deviceId,
            allowedVideos: fresh.allowedVideos, approved: true }, jwtSecret, { expiresIn: '30d', issuer: 'reproductor-cursos' });
        return { activationId: result.activationId, activationToken, licenseId: result.license.id,
            studentId: result.license.student_id, courseId: result.license.course_id || null,
            expiresAt: result.expiresAt, maxDevices: result.maxDevices, token };
    }

    async function resolve(req, videoId, deviceId, role = 'media') {
        requireReady();
        const { user, video } = await accessPolicy.authorizeVideo(req.user, videoId, deviceId);
        if (video.status !== 'ready') throw fail('El video todavía no está disponible.', 'VIDEO_NOT_READY', 404);
        const edu = await db.getEduByVideo(videoId);
        if (video.sourceType === 'edu' && !edu) throw fail('El contenido protegido no está registrado.', 'EDU_UNAVAILABLE', 503);
        let provider;
        if (edu) provider = { sourceType: 'edu', eduContentId: edu.content_id };
        else if (video.sourceType === 'vdocipher_direct') {
            let url;
            try { url = new URL(video.bunnyUrl); } catch { throw fail('URL VdoCipher inválida.', 'VIDEO_URL_INVALID', 502); }
            if (url.protocol !== 'https:' || url.hostname !== 'player.vdocipher.com') throw fail('URL VdoCipher inválida.', 'VIDEO_URL_INVALID', 502);
            provider = { sourceType: 'vdocipher_direct', directUrl: url.href };
        } else if (video.sourceType === 'vdocipher') {
            const otp = await requestVdoOtp(video.bunnyUrl || video.videoId || videoId);
            if (!otp?.otp || !otp.playbackInfo) throw fail('No se pudo preparar VdoCipher.', 'VDO_UNAVAILABLE', 502);
            provider = { sourceType: 'vdocipher', otp: otp.otp, playbackInfo: otp.playbackInfo };
        } else provider = { sourceType: 'bunny' };

        const studentCode = user.admin ? 'ADMIN' : await db.getOrCreateStudentCode(user.sub);
        const fingerprint = generateFingerprint(user.sub, videoId);
        const watermarkText = edu
            ? String(edu.watermark || '').replaceAll('{ID_COMPRADOR}', user.email || user.sub)
            : `${studentCode} · ${user.email || fingerprint.slice(0, 8)} · ${new Date().toISOString()}`;
        const sessionId = crypto.randomUUID();
        await sessions.create({ sessionId, userId: user.sub, videoId, deviceId, maxConcurrent: user.admin ? null : maxConcurrent });
        try {
            await db.logDelivery({ userId: user.sub, videoId, fingerprint, deviceId,
                studentEmail: user.email || '', ip: req.ip || '', userAgent: req.headers?.['user-agent'] || '' });
            const ttl = role === 'perm' ? 7200 : mediaTtl;
            const mediaToken = jwt.sign({ sub: user.sub, email: user.email || '', videoId, sessionId,
                role, deviceId, admin: user.admin === true,
                allowedVideos: user.admin ? ['*'] : [videoId], fingerprint, watermarkText }, jwtSecret,
                { expiresIn: ttl, issuer: 'reproductor-cursos' });
            if (provider.sourceType === 'bunny') {
                provider.manifestUrl = `${publicBase(req).replace(/\/$/, '')}/api/r/${encodeURIComponent(videoId)}?token=${encodeURIComponent(mediaToken)}`;
            }
            const watermarkConfig = Object.fromEntries(['windows', 'macos', 'linux', 'android'].map(os => [os, getWatermarkConfig(video.courseId || '__default__', os)]));
            return { ...provider, videoId, courseId: video.courseId || null, sessionId, mediaToken,
                sessionToken: mediaToken, watermarkText, studentCode, watermarkConfig, ttl };
        } catch (error) {
            await db.endSession(sessionId).catch(() => {});
            throw error;
        }
    }

    return { register, activate, resolve };
}
module.exports = { createPlayerHandshake };
