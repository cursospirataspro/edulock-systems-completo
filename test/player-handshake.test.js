'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayerHandshake } = require('../lib/player-handshake');

function fixture() {
    const state = { events: [], student: { sub: 'student-a', email: 'a@example.test', deviceId: 'device-a', allowedVideos: ['course-a'], student: { max_devices: 2 } },
        video: { videoId: 'video-a', courseId: 'course-a', status: 'ready', sourceType: 'bunny' }, edu: null,
        license: { id: 'license-a', student_id: null, course_id: 'course-a', status: 'free' }, owner: null, enrolled: null, reject: null };
    const db = {
        findStudentByDeviceId: async () => state.owner || null,
        enrollFirebaseStudent: async data => { state.enrolled = { ...data }; return { student: { id: 'student-new', email: data.email, active: 1, approval_status: 'approved' }, created: true }; },
        getLicenseByKeyHash: async () => state.license,
        claimAndActivateLicenseAtomic: async data => { state.events.push(['activate', data]); return { ok: true, activationId: 'activation-a', license: { ...state.license, student_id: data.studentId }, maxDevices: 2, expiresAt: null }; },
        getEduByVideo: async () => { state.events.push(['edu']); return state.edu; },
        cleanExpiredSessions: async () => {}, countActiveSessions: async () => 0,
        getOrCreateStudentCode: async () => 'CODE',
        createSession: async (...args) => { state.events.push(['session', ...args]); },
        createSessionAtomic: async (...args) => { state.events.push(['session', ...args]); return { ok: true }; },
        logDelivery: async data => { state.events.push(['delivery', data]); },
        endSession: async id => { state.events.push(['end', id]); },
    };
    const jwt = { verify: token => { if (token !== 'valid') throw new Error('invalid'); return state.student; },
        sign: claims => { state.claims = claims; return 'signed-token'; } };
    const accessPolicy = {
        hydrate: async claims => ({ ...state.student, ...claims }),
        authorizeVideo: async () => { state.events.push(['authorize']); if (state.reject) throw state.reject; return { user: state.student, video: state.video }; },
    };
    const options = { db, jwt, jwtSecret: 'unit-only-random-key', accessPolicy,
        sessions: { create: async data => { state.events.push(['session', data]); return { sessionId: data.sessionId }; } },
        verifyFirebaseToken: async token => { if (token !== 'firebase-valid') throw new Error('invalid'); return { uid: 'firebase-a', email: 'A@example.test' }; },
        getWatermarkConfig: (courseId, os) => ({ courseId, os }), generateFingerprint: () => 'fingerprint',
        requestVdoOtp: async () => { state.events.push(['otp']); return { otp: 'opaque', playbackInfo: 'opaque-info' }; },
        publicBase: () => 'https://player.example.test' };
    return { state, db, options, service: createPlayerHandshake(options), req: { user: state.student, headers: {}, ip: '127.0.0.1' } };
}

test('registration creates the account immediately from the verified Firebase identity, with no approval and no password forwarded', async () => {
    const f = fixture();
    const result = await f.service.register({ idToken: 'firebase-valid', deviceId: 'device-a', name: 'Alumno', email: 'victim@example.test', firebaseUid: 'victim', password: 'must-not-forward' });
    assert.equal(result.status, 'approved'); assert.equal(result.created, true); assert.equal(result.studentId, 'student-new');
    assert.equal(f.state.enrolled.email, 'a@example.test'); assert.equal(f.state.enrolled.uid, 'firebase-a'); assert.equal(f.state.enrolled.name, 'Alumno');
    assert.equal('password' in f.state.enrolled, false); assert.equal(JSON.stringify(result).includes('pending'), false);
});
test('registration rejects invalid Firebase token and a device already bound to another account', async () => {
    const f = fixture();
    await assert.rejects(f.service.register({ idToken: 'invalid', deviceId: 'device-a' }), { code: 'INVALID_FIREBASE_TOKEN' });
    f.state.owner = { id: 'student-b', email: 'another@example.test' };
    await assert.rejects(f.service.register({ idToken: 'firebase-valid', deviceId: 'device-a' }), { code: 'DEVICE_TAKEN' });
    assert.equal(f.state.enrolled, null, 'no account is created for a taken device');
});
test('a free serial requires student login and uses only the atomic activation operation', async () => {
    const f = fixture(); f.req.body = { licenseKey: 'AAAA-BBBB-CCCC-DDDD', deviceId: 'device-a' };
    await assert.rejects(f.service.activate(f.req), { code: 'AUTH_REQUIRED' }); assert.equal(f.state.events.length, 0);
    f.req.headers.authorization = 'Bearer valid';
    const result = await f.service.activate(f.req);
    assert.equal(result.token, 'signed-token'); assert.equal(result.studentId, 'student-a');
    assert.equal(f.state.events[0][0], 'activate'); assert.equal(f.state.events[0][1].studentId, 'student-a');
    assert.equal(f.state.events[0][1].deviceId, 'device-a'); assert.deepEqual(f.state.claims.allowedVideos, ['course-a']);
});
test('invalid authorization cannot fall back to a legacy active serial', async () => {
    const f = fixture(); f.state.license.status = 'active'; f.state.license.student_id = 'student-a';
    f.req.body = { licenseKey: 'AAAA-BBBB-CCCC-DDDD', deviceId: 'device-a' }; f.req.headers.authorization = 'Bearer invalid';
    await assert.rejects(f.service.activate(f.req), { code: 'AUTH_REQUIRED' }); assert.equal(f.state.events.length, 0);
});
test('revoked access is checked before any EDU lookup, OTP request or session creation', async () => {
    const f = fixture(); f.state.reject = Object.assign(new Error('license'), { code: 'LICENSE_REQUIRED' }); f.state.edu = { content_id: 'edu-a' };
    await assert.rejects(f.service.resolve(f.req, 'video-a', 'device-a'), { code: 'LICENSE_REQUIRED' });
    assert.deepEqual(f.state.events, [['authorize']]);
});
test('EDU receives a full session with real course and separate media claims', async () => {
    const f = fixture(); f.state.edu = { content_id: 'edu-a', watermark: '{ID_COMPRADOR}' };
    const result = await f.service.resolve(f.req, 'video-a', 'device-a', 'perm');
    assert.equal(result.sourceType, 'edu'); assert.equal(result.eduContentId, 'edu-a'); assert.equal(result.courseId, 'course-a');
    assert.ok(result.sessionId); assert.equal(result.mediaToken, result.sessionToken); assert.equal(result.watermarkText, 'a@example.test');
    assert.equal(f.state.claims.sub, 'student-a'); assert.equal(f.state.claims.videoId, 'video-a'); assert.equal(f.state.claims.deviceId, 'device-a');
    assert.equal(f.state.claims.sessionId, result.sessionId); assert.equal(f.req.user, f.state.student);
});
test('admin retains real sub and authorized claims instead of an email-derived fake identity', async () => {
    const f = fixture(); f.state.student.admin = true;
    const result = await f.service.resolve(f.req, 'video-a', 'device-a', 'perm');
    assert.equal(f.state.claims.sub, 'student-a'); assert.equal(f.state.claims.admin, true); assert.deepEqual(f.state.claims.allowedVideos, ['*']);
    assert.match(result.manifestUrl, /^https:\/\/player\.example\.test\/api\/r\/video-a\?token=/);
});
test('EDU database failures do not fall back to unprotected HLS', async () => {
    const f = fixture(); f.db.getEduByVideo = async () => { throw new Error('db unavailable'); };
    await assert.rejects(f.service.resolve(f.req, 'video-a', 'device-a'), /db unavailable/);
    assert.equal(f.state.events.some(([kind]) => kind === 'session'), false);
});
test('VdoCipher requires exact HTTPS embed hostname and sessions are cleaned on later failures', async () => {
    const f = fixture(); f.state.video.sourceType = 'vdocipher_direct'; f.state.video.bunnyUrl = 'https://player.vdocipher.com.attacker.test';
    await assert.rejects(f.service.resolve(f.req, 'video-a', 'device-a'), { code: 'VIDEO_URL_INVALID' });
    f.state.video.bunnyUrl = 'https://player.vdocipher.com/v2/?opaque=unit';
    f.db.logDelivery = async () => { throw new Error('write failed'); };
    await assert.rejects(f.service.resolve(f.req, 'video-a', 'device-a'), /write failed/);
    assert.equal(f.state.events.at(-1)[0], 'end');
});
