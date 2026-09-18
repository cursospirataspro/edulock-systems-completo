'use strict';
const crypto = require('node:crypto');

function fail(message, code, status = 403) {
    return Object.assign(new Error(message), { code, status });
}

function createPlayerHandshake({ db, jwt, jwtSecret, accessPolicy, verifyFirebaseToken,
    getWatermarkConfig, resolveWatermarkConfig, generateFingerprint, requestVdoOtp, sessions, mediaTtl = 1800,
    maxConcurrent = 1, isReady = () => true, publicBase = req => `${req.protocol}://${req.get('host')}` }) {
    const hash = value => crypto.createHmac('sha256', jwtSecret).update(value).digest('hex');
    function requireReady() { if (!isReady()) throw fail('Servidor iniciando. Intenta de nuevo.', 'DB_UNAVAILABLE', 503); }

    // Registro automático: la cuenta queda creada y aprobada al instante. No existe
    // solicitud ni aprobación del administrador; el acceso lo decide la licencia.
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
        // A computer already bound to another account cannot enroll a second one.
        const owner = typeof db.findStudentByDeviceId === 'function' ? await db.findStudentByDeviceId(deviceId).catch(() => null) : null;
        if (owner && String(owner.email || '').trim().toLowerCase() !== email) throw fail('Este dispositivo corresponde a otra cuenta.', 'DEVICE_TAKEN');
        // Body identity and password fields are intentionally not forwarded.
        let enrolled;
        try { enrolled = await db.enrollFirebaseStudent({ uid: firebaseUid, email, name: String(name || decoded.name || '').slice(0, 100) }); }
        catch (error) {
            if (error.statusCode) throw fail('No se pudo crear la cuenta en este dispositivo.', error.code, error.statusCode);
            throw error;
        }
        if (Number(enrolled.student?.active) === 0 || enrolled.student?.active === false || ['suspended', 'rejected'].includes(enrolled.student?.approval_status)) {
            throw Object.assign(fail('Tu cuenta está suspendida. Contacta al administrador.', 'ACCOUNT_SUSPENDED'), { registrationStatus: 'suspended' });
        }
        return { status: 'approved', studentId: enrolled.student.id, created: enrolled.created === true,
            message: enrolled.created ? 'Cuenta creada. Inicia sesión y activa tu licencia.' : 'Cuenta ya registrada. Inicia sesión y activa tu licencia.' };
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
            // La identidad sale siempre de la sesión del alumno: una clave de licencia sola, aunque
            // esté activa y asignada, nunca abre una sesión (cuenta → licencia → curso).
            throw fail('Inicia sesión para reclamar esta licencia.', 'AUTH_REQUIRED', 401);
        }
        if (user.deviceId && user.deviceId !== 'unknown' && user.deviceId !== deviceId) {
            throw fail('El dispositivo no corresponde a tu sesión.', 'DEVICE_MISMATCH');
        }
        const activationToken = crypto.randomBytes(32).toString('base64url');
        // Cupo por licencia (licenses.max_devices); el cupo global del alumno no limita una licencia válida.
        const result = await db.claimAndActivateLicenseAtomic({
            licenseKeyHash, studentId: user.sub, deviceId,
            activationTokenHash: hash(activationToken),
            expiresAt: null, // permanent course license; technical leases live in sessions/tokens
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
        // Sesión de contenido: UNA licencia, UN curso, este dispositivo. El token solo autoriza ese curso.
        const courseId = result.license.course_id || null;
        const producerId = result.license.producer_id || result.producerId || null;
        const sid = crypto.randomUUID();
        if (typeof db.createContentSession === 'function') {
            await db.createContentSession({ id: sid, studentId: user.sub, licenseId: result.license.id, courseId, producerId, deviceId, activationId: result.activationId });
        }
        const fresh = await accessPolicy.hydrate({ sub: user.sub, deviceId });
        const allowedVideos = courseId ? [courseId] : [];
        const token = jwt.sign({ sub: fresh.sub, email: fresh.email, deviceId, role: 'student', approved: true,
            hasLicense: true, licenseId: result.license.id, courseId, producerId, allowedVideos, sid },
        jwtSecret, { expiresIn: '30d', issuer: 'reproductor-cursos' });
        return { activationId: result.activationId, activationToken, licenseId: result.license.id,
            studentId: result.license.student_id, courseId, producerId, hasLicense: true, allowedVideos, sid,
            expiresAt: result.expiresAt, maxDevices: result.maxDevices, reused: result.reused === true, token };
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
                allowedVideos: user.admin ? ['*'] : [videoId], fingerprint, watermarkText,
                // La reproducción hereda la licencia/curso/sesión de contenido del token del alumno.
                licenseId: user.licenseId || undefined, courseId: user.courseId || undefined, sid: user.sid || undefined }, jwtSecret,
                { expiresIn: ttl, issuer: 'reproductor-cursos' });
            if (provider.sourceType === 'bunny') {
                provider.manifestUrl = `${publicBase(req).replace(/\/$/, '')}/api/r/${encodeURIComponent(videoId)}?token=${encodeURIComponent(mediaToken)}`;
            }
            // Configuración efectiva (predeterminado ← productor ← curso) por sistema.
            // "macos" se mantiene como alias de "mac" para reproductores antiguos.
            const wmFor = os => resolveWatermarkConfig
                ? resolveWatermarkConfig({ courseId: video.courseId || null, producerId: video.producerId || null }, os)
                : getWatermarkConfig(video.courseId || '__default__', os);
            const watermarkConfig = Object.fromEntries(['windows', 'mac', 'linux', 'android', 'ios'].map(os => [os, wmFor(os)]));
            watermarkConfig.macos = watermarkConfig.mac;
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
