'use strict';

const failure = (message, code, status = 403) => Object.assign(new Error(message), { code, status });
function createPlayerSessions({ db, jwt, jwtSecret, accessPolicy, now = Date.now }) {
    async function create({ sessionId, userId, videoId, deviceId, maxConcurrent }) {
        if (!sessionId || !userId || !videoId || !deviceId) throw failure('Dispositivo requerido para reproducir.', 'DEVICE_REQUIRED', 400);
        if (maxConcurrent !== null && (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)) throw new Error('Invalid concurrent session limit');
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['player-session:' + userId]);
            const time = now();
            await client.query('DELETE FROM active_sessions WHERE user_id=$1 AND last_seen<$2', [userId, time - 90000]);
            // A new media item replaces only this user's previous item on this device.
            await client.query('DELETE FROM active_sessions WHERE user_id=$1 AND device_id=$2', [userId, deviceId]);
            if (maxConcurrent !== null) {
                const count = (await client.query('SELECT COUNT(*) AS n FROM active_sessions WHERE user_id=$1 AND last_seen>=$2', [userId, time - 90000])).rows[0];
                if (Number(count.n) >= maxConcurrent) throw failure('Ya tienes una reproducción activa. Cierra el otro video para continuar.', 'SESSION_LIMIT_EXCEEDED', 429);
            }
            await client.query('INSERT INTO active_sessions (session_id,user_id,video_id,device_id,started_at,last_seen,current_pos) VALUES ($1,$2,$3,$4,$5,$5,0)',
                [sessionId, userId, videoId, deviceId, time]);
            await client.query('COMMIT');
            return { sessionId };
        } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
        finally { client.release(); }
    }

    function identify(req) {
        const body = req.body || {};
        if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 100) throw failure('sessionId requerido.', 'SESSION_REQUIRED', 400);
        const token = body.mediaToken || String(req.headers?.authorization || '').replace(/^Bearer /, '');
        let claims;
        try { claims = jwt.verify(token, jwtSecret); }
        catch { throw failure('La sesión expiró. Abre el video de nuevo.', 'TOKEN_EXPIRED', 401); }
        if (!claims.sub || claims.guest || claims.role === 'producer') throw failure('Cuenta no autorizada.', 'AUTH_REQUIRED', 401);
        if (claims.sessionId && claims.sessionId !== body.sessionId) throw failure('La sesión no corresponde a esta reproducción.', 'SESSION_MISMATCH');
        const deviceId = body.deviceId || req.headers?.['x-device-id'] || claims.deviceId;
        if (claims.deviceId && deviceId !== claims.deviceId) throw failure('El dispositivo no corresponde a esta sesión.', 'DEVICE_MISMATCH');
        return { claims, deviceId, sessionId: body.sessionId, currentTime: body.currentTime };
    }

    async function heartbeat(req) {
        const { claims, deviceId, sessionId, currentTime } = identify(req);
        await accessPolicy.authorizeSession(claims, sessionId, deviceId);
        const position = Number(currentTime);
        if (currentTime != null && (!Number.isFinite(position) || position < 0 || position > 2147483647)) throw failure('Posición de reproducción inválida.', 'INVALID_POSITION', 400);
        if (!await db.heartbeatSession(sessionId, position || 0)) throw failure('La sesión de reproducción terminó.', 'SESSION_REVOKED');
        return { ok: true };
    }

    async function end(req) {
        const { claims, deviceId, sessionId } = identify(req);
        const row = (await db.pool.query('SELECT * FROM active_sessions WHERE session_id=$1', [sessionId])).rows[0];
        if (!row) return { ok: true }; // A completed session can be closed repeatedly.
        if (row.user_id !== claims.sub || claims.videoId && row.video_id !== claims.videoId) throw failure('La sesión pertenece a otra reproducción.', 'SESSION_MISMATCH');
        if (row.device_id && row.device_id !== deviceId) throw failure('El dispositivo no corresponde a esta sesión.', 'DEVICE_MISMATCH');
        // Closing one's own playback remains possible after license revocation.
        await db.endSession(sessionId);
        return { ok: true };
    }
    return { create, heartbeat, end };
}
module.exports = { createPlayerSessions };
