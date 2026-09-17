'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createActivationValidator } = require('../lib/activation-validator');
function fixture() {
  const state = {
    activation: { id: 'act-a', license_id: 'lic-a', student_id: 'student-a', device_id: 'device-a', status: 'active' },
    license: { id: 'lic-a', student_id: 'student-a', status: 'active', course_id: 'course-a', producer_id: 'producer-a' },
    student: { id: 'student-a', active: true, approval_status: 'approved', producerId: 'producer-a', allowedVideos: ['course-a'] },
    producer: { active: 1 }, devices: [{ fingerprint: 'device-a' }], touched: 0, authorized: 0,
    video: { courseId: 'course-a' },
  };
  const db = {
    getActivationByTokenHash: async () => state.activation, getLicenseById: async () => state.license,
    findStudentById: async () => state.student, getActiveDevicesByStudent: async () => state.devices,
    getProducerById: async () => state.producer, touchActivation: async () => { state.touched++; },
  };
  const accessPolicy = { authorizeVideo: async (claims, video, device) => {
    state.authorized++;
    assert.equal(claims.sub, 'student-a'); assert.equal(device, 'device-a');
    if (state.accessError) throw state.accessError;
    return { video: state.video };
  } };
  return { state, run: createActivationValidator({ db, jwtSecret: 'synthetic-test-only', accessPolicy }),
    body: { activationToken: 'synthetic-token', deviceId: 'device-a', videoId: 'video-a' } };
}
test('course-scoped activation validates an authorized video and returns the course', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(f.body), { valid: true, studentId: 'student-a', licenseId: 'lic-a', courseId: 'course-a' });
  assert.equal(f.state.authorized, 1); assert.equal(f.state.touched, 1);
});
test('a student who also buys from another producer still validates this producer license', async () => {
  const f = fixture(); f.state.student.producerId = 'another';
  assert.equal((await f.run(f.body)).valid, true);
});
test('revoked device and suspended producer invalidate a saved activation even without videoId', async () => {
  for (const mutate of [f => { f.state.devices = []; }, f => { f.state.producer.active = 0; }]) {
    const f = fixture(); delete f.body.videoId; mutate(f);
    await assert.rejects(f.run(f.body), e => e.status === 403); assert.equal(f.state.touched, 0);
  }
});
test('an expired or malformed activation lease never validates, while a legacy license date is ignored', async () => {
  for (const value of ['2020-01-01T00:00:00Z', 'invalid']) {
    const f = fixture(); f.state.activation.expires_at = value;
    await assert.rejects(f.run(f.body), { code: 'ACTIVATION_EXPIRED' }); assert.equal(f.state.touched, 0);
  }
  const permanent = fixture(); permanent.state.license.expires_at = '2020-01-01T00:00:00Z';
  assert.equal((await permanent.run(permanent.body)).valid, true);
});
test('wrong owner, device, inactive account and revoked credentials fail closed', async () => {
  for (const mutate of [f => { f.state.license.student_id = 'other'; }, f => { f.body.deviceId = 'other'; },
    f => { f.state.student.active = false; }, f => { f.state.student.approval_status = 'pending'; },
    f => { f.state.license.status = 'revoked'; }, f => { f.state.activation.status = 'revoked'; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.run(f.body), e => e.status === 403); assert.equal(f.state.touched, 0);
  }
});
test('a license for another course cannot validate this video even if the student has both courses', async () => {
  const f = fixture(); f.state.video.courseId = 'course-b';
  await assert.rejects(f.run(f.body), { code: 'VIDEO_NOT_ALLOWED' }); assert.equal(f.state.touched, 0);
});
test('current video policy denies access instead of trusting stale allowedVideos', async () => {
  const f = fixture(); f.state.accessError = Object.assign(new Error('denied'), { status: 403, code: 'LICENSE_REQUIRED' });
  await assert.rejects(f.run(f.body), { code: 'LICENSE_REQUIRED' }); assert.equal(f.state.touched, 0);
});
test('malformed requests are rejected before any successful validation', async () => {
  for (const body of [{}, { activationToken: {}, deviceId: 'device-a' }, { activationToken: 'a', deviceId: 'x'.repeat(101) },
    { activationToken: 'a', deviceId: 'device-a', videoId: {} }]) {
    const f = fixture(); await assert.rejects(f.run(body), { code: 'INVALID_ACTIVATION', status: 400 }); assert.equal(f.state.touched, 0);
  }
});
