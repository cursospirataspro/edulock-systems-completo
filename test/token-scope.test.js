'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { isAccountToken } = require('../lib/token-scope');
test('ordinary admin, producer and activated student sessions retain account scope', () => {
    for (const token of [{sub:'admin',admin:true},{sub:'producer',role:'producer',producerId:'producer'},{sub:'student',approved:true,deviceId:'device'},{sub:'student',role:'student'}]) assert.equal(isAccountToken(token),true);
});
test('an administrator preview token never acquires global account scope', () => {
    assert.equal(isAccountToken({sub:'admin',admin:true,role:'media',videoId:'video',sessionId:'session',allowedVideos:['*']}),false);
});
test('student playback and permanent link tokens cannot become account credentials', () => {
    for (const scope of [{videoId:'video'},{sessionId:'session'},{role:'media'},{role:'perm'}]) assert.equal(isAccountToken({sub:'student',...scope}),false);
});
test('missing identity and guest capabilities have no account scope', () => {
    for(const token of [null,{}, {sub:''}, {sub:'guest',guest:true}]) assert.equal(isAccountToken(token),false);
});
