'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { packEdu, deriveCek } = require('../../edu-packer');
const { openEdu, readRange } = require('../edu-native');

test('server EDU packer and native reader agree across chunk and CTR boundaries', () => {
    const original = crypto.randomBytes(8192 * 3 + 257);
    const masterKeyHex = crypto.randomBytes(32).toString('hex');
    const { edu, salt } = packEdu(original, { contentId: 'test-only', masterKeyHex });
    const cek = deriveCek(masterKeyHex, Buffer.from(salt, 'hex'), 'test-only');
    const state = openEdu(edu, cek);
    for (const [start, end] of [[0, 0], [0, 8191], [8190, 8205], [17, 8193], [16387, original.length - 1], [0, original.length - 1]]) {
        assert.deepEqual(readRange(state, start, end), original.subarray(start, end + 1));
    }
    state.closed = true;
    assert.throws(() => readRange(state, 0, 9), /cerrado/);
});

test('tampered, truncated and wrong-key EDU files fail before playback', () => {
    const masterKeyHex = crypto.randomBytes(32).toString('hex');
    const { edu, salt } = packEdu(Buffer.alloc(100, 7), { contentId: 'integrity-test', masterKeyHex });
    const cek = deriveCek(masterKeyHex, Buffer.from(salt, 'hex'), 'integrity-test');
    assert.throws(() => openEdu(edu, crypto.randomBytes(32)), /HMAC/);
    assert.throws(() => openEdu(edu.subarray(0, 30), cek), /inválidos/);
    const altered = Buffer.from(edu);
    altered[altered.length - 40] ^= 1;
    assert.throws(() => openEdu(altered, cek), /HMAC/);
});
