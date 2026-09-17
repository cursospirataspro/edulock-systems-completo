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
 await assert.rejects(f.policy.authorizeResource({...f.claims,licenseId:undefined,allowedVideos:['*']},moduleResource(),'device-a'),{code:'LICENSE_REQUIRED'});
 await assert.rejects(f.policy.authorizeResource({...f.claims,allowedVideos:['*']},moduleResource(),'device-a'),{code:'LICENSE_REQUIRED'},'wildcard ignored: allowedVideos must name the course');
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
 state.contentSessions={'sid-a':{id:'sid-a',student_id:'student-a',license_id:'license-a',course_id:'course-a',device_id:'device-a',ended_at:null}};
 const db = {findStudentById:async()=>state.student,getCatalogById:async()=>state.video,
  getContentSession:async id=>state.contentSessions[id]||null,
  pool:{query:async(sql,params)=>({rows:sql.includes('FROM licenses')?state.licenses.filter(l=>l.id===params[3]&&(l.course_id==null||l.course_id===params[2])):state.sessions})}};
 // Token de contenido (etapa 2): identidad + licencia de ESTA sesión + curso + dispositivo + sesión de contenido.
 return {state, policy:createAccessPolicy({db}), claims:{sub:'student-a',deviceId:'device-a',hasLicense:true,licenseId:'license-a',courseId:'course-a',allowedVideos:['course-a'],sid:'sid-a'}};
}
test('missing permissions and videoId claim alone never grant access',()=>{
 assert.equal(hasVideoAccess({sub:'a',videoId:'video-a'},'video-a','course-a'),false);
 assert.equal(hasVideoAccess({allowedVideos:['course-a']},'video-a','course-a'),true);
 assert.equal(hasVideoAccess({videoId:'video-b',allowedVideos:['*']},'video-a','course-a'),false);
});
test('valid course license on its activated device grants playback',async()=>{
 const f=fixture(); const result=await f.policy.authorizeVideo(f.claims,'video-a','device-a');assert.equal(result.license.id,'license-a');
});
test('permissions come from the session license, never from a wildcard or student-wide JWT',async()=>{
 const f=fixture();
 // Wildcard en un token de alumno se ignora; sin licencia de sesión no hay contenido aunque el alumno tenga cursos.
 await assert.rejects(f.policy.authorizeVideo({sub:'student-a',deviceId:'device-a',allowedVideos:['*']},'video-a','device-a'),{code:'LICENSE_REQUIRED'});
 f.state.student.allowedVideos=['course-a','course-b'];
 await assert.rejects(f.policy.authorizeVideo({sub:'student-a',deviceId:'device-a',hasLicense:false,allowedVideos:[]},'video-a','device-a'),{code:'LICENSE_REQUIRED'});
 await assert.rejects(f.policy.authorizeVideo({sub:'student-a',deviceId:'device-a',allowedVideos:['course-a']},'video-a','device-a'),{code:'LICENSE_REQUIRED'});
});
test('one license per session: course B is denied under a course A session even if the student owns both',async()=>{
 const f=fixture();
 f.state.licenses.push({id:'license-b',status:'active',course_id:'course-b',producer_id:'producer-a',producer_active:1,activation_status:'active',device_status:'active'});
 f.state.video={videoId:'video-b',courseId:'course-b',producerId:'producer-a'};
 await assert.rejects(f.policy.authorizeVideo(f.claims,'video-b','device-a'),{code:'COURSE_NOT_IN_SESSION'});
 await assert.rejects(f.policy.authorizeResource(f.claims,{...moduleResource(),courseId:'course-b'},'device-a'),{code:'COURSE_NOT_IN_SESSION'});
 // Un token manipulado que declare el curso B pero la licencia A tampoco entra: la licencia debe ser la del curso.
 await assert.rejects(f.policy.authorizeVideo({...f.claims,courseId:'course-b',allowedVideos:['course-b']},'video-b','device-a'),{code:'LICENSE_REQUIRED'});
 // La sesión de la licencia B sí reproduce el curso B.
 f.state.contentSessions['sid-b']={id:'sid-b',student_id:'student-a',license_id:'license-b',course_id:'course-b',device_id:'device-a',ended_at:null};
 const ok=await f.policy.authorizeVideo({...f.claims,licenseId:'license-b',courseId:'course-b',allowedVideos:['course-b'],sid:'sid-b'},'video-b','device-a');
 assert.equal(ok.license.id,'license-b');
});
test('logout ends the content session: the old token no longer plays, while license and activation stay untouched',async()=>{
 const f=fixture();
 f.state.contentSessions['sid-a'].ended_at='2026-09-17T00:00:00Z';
 await assert.rejects(f.policy.authorizeVideo(f.claims,'video-a','device-a'),{code:'SESSION_ENDED',status:401});
 await assert.rejects(f.policy.authorizeResource(f.claims,moduleResource(),'device-a'),{code:'SESSION_ENDED'});
 assert.equal(f.state.licenses[0].status,'active'); assert.equal(f.state.licenses[0].activation_status,'active');
 // Una sesión de otro alumno o de otra licencia tampoco sirve.
 f.state.contentSessions['sid-a'].ended_at=null; f.state.contentSessions['sid-a'].student_id='student-b';
 await assert.rejects(f.policy.authorizeVideo(f.claims,'video-a','device-a'),{code:'SESSION_ENDED'});
 f.state.contentSessions['sid-a'].student_id='student-a'; f.state.contentSessions['sid-a'].license_id='license-b';
 await assert.rejects(f.policy.authorizeVideo(f.claims,'video-a','device-a'),{code:'SESSION_ENDED'});
 delete f.state.contentSessions['sid-a'];
 await assert.rejects(f.policy.authorizeVideo(f.claims,'video-a','device-a'),{code:'SESSION_ENDED'});
});
test('a media token inherits the session license and cannot escape to another course',async()=>{
 const f=fixture();
 const media={sub:'student-a',deviceId:'device-a',videoId:'video-a',sessionId:'session-a',allowedVideos:['video-a'],licenseId:'license-a',courseId:'course-a',sid:'sid-a'};
 assert.equal((await f.policy.authorizeSession(media,'session-a','device-a')).license.id,'license-a');
 await assert.rejects(f.policy.authorizeVideo({...media,licenseId:undefined},'video-a','device-a'),{code:'LICENSE_REQUIRED'});
});

test('a first course link requests activation without granting access, while unscoped videos stay forbidden',async()=>{
 const f=fixture();f.claims={sub:'student-a',deviceId:'device-a',hasLicense:false,allowedVideos:[]};
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
