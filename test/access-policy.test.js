'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createAccessPolicy, hasVideoAccess} = require('../lib/access-policy');

const moduleResource = () => ({id:'resource-a',targetKind:'module',targetId:'module-a',courseId:'course-a',producerId:'producer-a'});
test('PDF-only module grants access with its current course license and activated device',async()=>{
 const f=fixture();const result=await f.policy.authorizeResource(f.claims,moduleResource(),'device-a');assert.equal(result.license.id,'license-a');
});
for(const [name,patch] of [
 ['revoked license',{status:'revoked'}],
 ['revoked activation',{activation_status:'revoked'}],['expired activation',{activation_expires_at:'2020-01-01T00:00:00Z'}],
 ['blocked device',{device_status:'blocked'}],['suspended producer',{producer_active:0}],['foreign producer',{producer_id:'producer-b'}]
]) test('module PDF denies '+name,async()=>{const f=fixture();Object.assign(f.state.licenses[0],patch);await assert.rejects(f.policy.authorizeResource(f.claims,moduleResource(),'device-a'),{code:'LICENSE_REQUIRED'});});
test('module PDF rejects stale permissions, media-scoped tokens and another device',async()=>{
 const f=fixture();
 for(const extra of [{videoId:'video-a'},{sessionId:'session-a'}])await assert.rejects(f.policy.authorizeResource({...f.claims,...extra},moduleResource(),'device-a'),{code:'LICENSE_REQUIRED'});
 await assert.rejects(f.policy.authorizeResource(f.claims,moduleResource(),'device-b'),{code:'DEVICE_MISMATCH'});
 f.state.student.allowedVideos=[];await assert.rejects(f.policy.authorizeResource({...f.claims,allowedVideos:['*']},moduleResource(),'device-a'),{code:'LICENSE_REQUIRED'});
});
test('module PDF denies a deleted or suspended account and invalid targets',async()=>{
 const f=fixture();f.state.student.active=false;
 await assert.rejects(f.policy.authorizeResource(f.claims,moduleResource(),'device-a'),{code:'ACCOUNT_REVOKED'});
 f.state.student=null;await assert.rejects(f.policy.authorizeResource(f.claims,moduleResource(),'device-a'),{code:'ACCOUNT_REVOKED'});
 await assert.rejects(f.policy.authorizeResource({sub:'admin',admin:true},{...moduleResource(),courseId:null},'device-a'),{code:'RESOURCE_TARGET_CHANGED'});
 await assert.rejects(f.policy.authorizeResource(f.claims,{...moduleResource(),deletedAt:'now'},'device-a'),{code:'RESOURCE_NOT_FOUND'});
});
test('video PDF fails when its course or producer changed',async()=>{
 const f=fixture();const resource={...moduleResource(),targetKind:'video',targetId:'video-a'};
 for(const patch of [{courseId:'course-b'},{producerId:'producer-b'}])await assert.rejects(f.policy.authorizeResource(f.claims,{...resource,...patch},'device-a'),{code:'RESOURCE_TARGET_CHANGED'});
});

function fixture() {
 const state = {
  student:{id:'student-a',email:'student-a@example.test',active:true,approval_status:'approved',allowedVideos:['course-a']},
  video:{videoId:'video-a',courseId:'course-a',producerId:'producer-a'},
  licenses:[{id:'license-a',status:'active',course_id:'course-a',producer_id:'producer-a',producer_active:1,activation_status:'active',device_status:'active'}],
  sessions:[{session_id:'session-a',user_id:'student-a',video_id:'video-a'}]
 };
 const db = {findStudentById:async()=>state.student,getCatalogById:async()=>state.video,pool:{query:async(sql)=>({rows:sql.includes('FROM licenses')?state.licenses:state.sessions})}};
 return {state, policy:createAccessPolicy({db}), claims:{sub:'student-a',deviceId:'device-a'}};
}
test('missing permissions and videoId claim alone never grant access',()=>{
 assert.equal(hasVideoAccess({sub:'a',videoId:'video-a'},'video-a','course-a'),false);
 assert.equal(hasVideoAccess({allowedVideos:['course-a']},'video-a','course-a'),true);
 assert.equal(hasVideoAccess({videoId:'video-b',allowedVideos:['*']},'video-a','course-a'),false);
});
test('valid course license on its activated device grants playback',async()=>{
 const f=fixture(); const result=await f.policy.authorizeVideo(f.claims,'video-a','device-a');assert.equal(result.license.id,'license-a');
});
test('permissions come from current student, not stale wildcard JWT',async()=>{
 const f=fixture();f.state.student.allowedVideos=[];
 await assert.rejects(f.policy.authorizeVideo({...f.claims,allowedVideos:['*'],videoId:'video-a'},'video-a','device-a'),{code:'LICENSE_REQUIRED'});
});

test('a first course link requests activation without granting access, while unscoped videos stay forbidden',async()=>{
 const f=fixture();f.state.student.allowedVideos=[];
 await assert.rejects(f.policy.authorizeVideo(f.claims,'video-a','device-a'),{code:'LICENSE_REQUIRED'});
 f.state.video.courseId=null;await assert.rejects(f.policy.authorizeVideo(f.claims,'video-a','device-a'),{code:'VIDEO_FORBIDDEN'});
 f.state.video.courseId='course-a';await assert.rejects(f.policy.authorizeVideo({...f.claims,videoId:'video-b'},'video-a','device-a'),{code:'VIDEO_FORBIDDEN'});
});
for(const [name,mutate] of [
 ['deleted account',f=>f.state.student=null],
 ['suspended account',f=>f.state.student.active=false],
 ['pending account',f=>f.state.student.approval_status='pending'],
]) test(name+' cannot reuse a media token',async()=>{const f=fixture();mutate(f);await assert.rejects(f.policy.authorizeVideo({...f.claims,videoId:'video-a'},'video-a','device-a'),{code:'ACCOUNT_REVOKED'});});
for(const [name,patch] of [
 ['revoked license',{status:'revoked'}],
 ['revoked activation',{activation_status:'revoked'}],['expired activation',{activation_expires_at:'2020-01-01T00:00:00Z'}],
 ['blocked device',{device_status:'blocked'}], ['suspended producer',{producer_active:0}],
 ['another producer',{producer_id:'producer-b'}],
]) test(name+' cannot authorize playback',async()=>{const f=fixture();Object.assign(f.state.licenses[0],patch);await assert.rejects(f.policy.authorizeVideo(f.claims,'video-a','device-a'),{code:'LICENSE_REQUIRED'});});
test('a legacy stored license date never blocks playback or documents: the course right is permanent',async()=>{
 const f=fixture();Object.assign(f.state.licenses[0],{expires_at:'2020-01-01T00:00:00Z'});
 assert.equal((await f.policy.authorizeVideo(f.claims,'video-a','device-a')).license.id,'license-a');
 assert.equal((await f.policy.authorizeResource(f.claims,moduleResource(),'device-a')).license.id,'license-a');
});
test('device mismatch cannot reuse an otherwise valid license',async()=>{const f=fixture();await assert.rejects(f.policy.authorizeVideo(f.claims,'video-a','device-b'),{code:'DEVICE_MISMATCH'});});
test('producer JWT and public guest cannot enter student APIs',async()=>{const f=fixture();for(const extra of [{role:'producer'},{guest:true}])await assert.rejects(f.policy.hydrate({...f.claims,...extra}),{code:'STUDENT_REQUIRED'});});
test('database failure is propagated instead of granting permission',async()=>{const policy=createAccessPolicy({db:{findStudentById:async()=>{throw new Error('offline')}}});await assert.rejects(policy.hydrate({sub:'a'}),/offline/);});
test('heartbeat can only update the exact owned session',async()=>{
 const f=fixture();const token={...f.claims,videoId:'video-a',sessionId:'session-a'};
 await f.policy.authorizeSession(token,'session-a','device-a');
 await assert.rejects(f.policy.authorizeSession(token,'session-b','device-a'),{code:'SESSION_MISMATCH'});
 f.state.sessions[0].user_id='student-b';await assert.rejects(f.policy.authorizeSession(token,'session-a','device-a'),{code:'SESSION_REVOKED'});
});

test('session authorization checks its persisted device and permits historical null device rows',async()=>{
 const f=fixture();const token={...f.claims,videoId:'video-a',sessionId:'session-a'};
 f.state.sessions[0].device_id='device-a';await f.policy.authorizeSession(token,'session-a','device-a');
 f.state.sessions[0].device_id='another-device';await assert.rejects(f.policy.authorizeSession(token,'session-a','device-a'),{code:'DEVICE_MISMATCH'});
 f.state.sessions[0].device_id=null;await f.policy.authorizeSession(token,'session-a','device-a');
});
