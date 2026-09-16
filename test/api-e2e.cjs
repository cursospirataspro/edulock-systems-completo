'use strict';
// Explicit integration runner; only the isolated Edulock QA database is permitted.
require('dotenv').config({quiet:true});
const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/edulock_qa_'))throw Error('Sólo se permite ejecutar en la base QA aislada');
const db=require('../database-pg'),jwt=require('jsonwebtoken');
const base=process.env.PUBLIC_URL;const report={startedAt:new Date().toISOString(),checks:[],assets:[]};
const stateFile='.qa-e2e-state.json';let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):{};
function save(){fs.writeFileSync(stateFile,JSON.stringify(state,null,2),{mode:0o600});}
function check(name,value){assert.ok(value,name);report.checks.push(name);console.log('PASS '+name);}
async function api(route,{token,body,method,form,expected=200,app=false}={}){
 const headers={};if(token)headers.Authorization='Bearer '+token;
 if(route.startsWith('/api/r/'))headers.Accept='application/vnd.apple.mpegurl';
 if(body)headers['Content-Type']='application/json';
 if(app){const ts=String(Date.now());headers['x-cdp-ts']=ts;headers['x-cdp-sig']=crypto.createHmac('sha256',process.env.APP_SECRET).update('resolve:'+ts).digest('hex');}
 const res=await fetch(base+route,{method:method||(body||form?'POST':'GET'),headers,body:form||(body?JSON.stringify(body):undefined),signal:AbortSignal.timeout(240000)});
 const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}
 assert.equal(res.status,expected,route+' '+JSON.stringify(typeof data==='object'?{error:data.error,code:data.code}:text.slice(0,160)));
 return data;
}
async function upload(courseId,moduleId,token,prefix,label){
 const idKey=label+'Operation';state[idKey] ||= crypto.randomUUID();save();
 const form=new FormData();form.set('courseId',courseId);form.set('moduleId',moduleId);form.set('title','Clase QA · '+label);form.set('operationId',state[idKey]);form.set('video',new Blob([fs.readFileSync('qa-clip.mp4')],{type:'video/mp4'}),'qa-clip.mp4');
 const result=await api(prefix+'/stream/upload',{token,form});check(label+' upload operation persisted',!!result.videoId);
 let status;
 for(let i=0;i<60;i++){
  status=await api(prefix+'/stream/status/'+result.videoId,{token});
  if(status.ready)break;if(status.failed)throw Error(label+' Bunny status '+JSON.stringify(status));
  await new Promise(r=>setTimeout(r,5000));
 }
 check(label+' transcoding finished',status.ready===true);
 const operation=await api(prefix+'/stream/operations/'+state[idKey],{token});check(label+' durable operation ready',operation.ready===true||operation.phase==='ready');
 return result.videoId;
}
(async()=>{
 const health=await api('/api/health');check('health reports initialized database',health.dbReady===true);
 for(const route of ['/server.js','/database-pg.js','/.env','/package.json','/data/keys.json','/lib/access-policy.js'])await api(route,{expected:404});
 check('source and runtime files not public',true);
 const admin=await api('/api/auth/admin-login',{body:{username:process.env.ADMIN_USER,password:process.env.ADMIN_PASS}});const adminToken=admin.token;
 if(process.env.QA_ALLOW_BUNNY!=='1')throw Error('QA_ALLOW_BUNNY=1 requerido para pruebas con recursos nuevos en Bunny');
 if(!state.adminCourse){const c=await api('/api/courses',{token:adminToken,body:{id:crypto.randomUUID(),name:'QA Edulock Admin 20260912'},expected:201});check('admin course provisioned',!!c.bunnyLibraryId&&!c.bunnyWarning);state.adminCourse=c;save();}
 if(!state.adminModule){state.adminModule=await api('/api/courses/'+state.adminCourse.id+'/modules',{token:adminToken,body:{name:'Módulo de prueba'},expected:201});save();}
 if(!state.producer){state.producer=await api('/api/owner/producers',{token:adminToken,body:{email:'stream-qa@edulock.invalid',name:'Productor QA',maxLicenses:5,maxStudents:3,maxDevices:1}});save();}
 const producerToken=(await api('/api/producer/login',{body:{email:state.producer.email,password:state.producer.password}})).token;
 await api('/api/producer/license/generate-bulk',{token:producerToken,body:{quantity:1},expected:400});check('producer must select a course before generating serials',true);
 await api('/api/license/generate-bulk',{token:adminToken,body:{quantity:1},expected:400});check('admin must select a course before generating serials',true);
 if(!state.producerCourse){const c=await api('/api/producer/courses',{token:producerToken,body:{id:crypto.randomUUID(),name:'QA Edulock Productor 20260912'},expected:201});check('producer course provisioned',!!c.course.bunnyLibraryId&&!c.warning);state.producerCourse=c.course;save();}
 if(!state.producerModule){state.producerModule=(await api('/api/producer/courses/'+state.producerCourse.id+'/modules',{token:producerToken,body:{name:'Módulo de prueba'},expected:201})).module;save();}
 await api('/api/producer/courses/'+state.adminCourse.id+'/modules',{token:producerToken,expected:404});check('producer cannot read another owner course',true);
 if(!fs.existsSync('qa-clip.mp4'))cp.execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=600:sample_rate=44100','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart','qa-clip.mp4']);
 if(!state.adminVideo){state.adminVideo=await upload(state.adminCourse.id,state.adminModule.id,adminToken,'/api','admin');save();}
 if(!state.producerVideo){state.producerVideo=await upload(state.producerCourse.id,state.producerModule.id,producerToken,'/api/producer','producer');save();}
 const link=await api('/api/producer/video/'+state.producerVideo+'/sublink',{token:producerToken,method:'POST'});check('producer class sublink created',link.sublink?.includes('/cover/'));
 const repeatedLink=await api('/api/producer/video/'+state.producerVideo+'/sublink',{token:producerToken,method:'POST'});check('copying the class link again preserves previously shared URLs',repeatedLink.publicCode===link.publicCode);
 const publicVideo=await api('/api/public/video/'+link.publicCode);check('class cover metadata remains available',publicVideo.title==='Clase QA · producer'&&!!publicVideo.duration);
 const thumbnail=await fetch(publicVideo.thumbnailUrl,{signal:AbortSignal.timeout(20000)});check('class thumbnail loads through the protected course CDN',thumbnail.status===200&&(thumbnail.headers.get('content-type')||'').startsWith('image/'));
 await api('/api/producer/stream/status/'+state.adminVideo,{token:producerToken,expected:403});check('producer cannot inspect another owner upload',true);
 for(const course of [state.adminCourse,state.producerCourse]){
  const lib=await db.getCourseBunny(course.id);check(course.name+' has CDN token key',!!lib.tokenKey);
  report.assets.push({courseId:course.id,libraryId:lib.libraryId,name:course.name});
 }
 if(process.env.QA_PHASE==='stream'){report.success=true;fs.writeFileSync('qa-stream-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({success:true,checks:report.checks.length,assets:report.assets}));return;}
 if(!state.student){state.student=crypto.randomUUID();await db.createStudent({id:state.student,email:'learner-qa@edulock.invalid',studentId:'QA-STUDENT',name:'Alumno QA',allowedVideos:[]});await db.pool.query("UPDATE students SET approval_status='approved',max_devices=1 WHERE id=$1",[state.student]);save();}
 const deviceId='qa-device-20260912';const identity=jwt.sign({sub:state.student,deviceId,email:'learner-qa@edulock.invalid',allowedVideos:[]},process.env.JWT_SECRET,{expiresIn:'1h'});
 const launch=await api('/api/public/video/'+link.publicCode+'/launch',{method:'POST'});
 const perm=new URL(launch.deepLink).searchParams.get('p');
 if(!state.license){const lot=await api('/api/producer/license/generate-bulk',{token:producerToken,body:{courseId:state.producerCourse.id,quantity:1,maxDevices:1}});state.license=lot.keys[0];save();}
 const activation=await api('/api/license/activate',{token:identity,body:{licenseKey:state.license,deviceId,appVersion:'QA'},app:true});check('free producer license claimed and activated',activation.courseId===state.producerCourse.id);
 const entry=await db.getCatalogById(state.producerVideo);
 const playback=await api('/api/playback/resolve-perm',{token:identity,body:{perm,deviceId},app:true});
 const mediaToken=playback.mediaToken||playback.sessionToken;check('resolve creates a distinct media session',!!playback.sessionId&&!!mediaToken&&mediaToken!==identity);
 let master=await api('/api/r/'+entry.videoId,{token:mediaToken});check('fresh permission after license claim ignores old empty JWT grants',typeof master==='string'&&master.startsWith('#EXTM3U'));
 let rendition=master;if(master.includes('#EXT-X-STREAM-INF')){const url=master.split('\n').find(l=>l.startsWith('http'));rendition=await api(url.slice(base.length));}
 check('rendition has encryption metadata after EXTM3U',rendition.startsWith('#EXTM3U')&&rendition.includes('#EXT-X-KEY'));
 const segmentUrl=rendition.split('\n').find(l=>l.startsWith('http'));const keyUrl=(rendition.match(/URI="([^"]+)"/)||[])[1];
 const segmentRes=await fetch(segmentUrl);const encryptedSegment=Buffer.from(await segmentRes.arrayBuffer());check('authorized encrypted segment served',segmentRes.status===200&&encryptedSegment.byteLength>0);
 const keyRes=await fetch(keyUrl);const aesKey=Buffer.from(await keyRes.arrayBuffer());check('authorized AES key served',keyRes.status===200&&aesKey.byteLength===16);
 const ivHex=(rendition.match(/IV=0x([0-9a-f]+)/i)||[])[1]||BigInt(new URL(segmentUrl).searchParams.get('idx')||0).toString(16).padStart(32,'0');
 const decipher=crypto.createDecipheriv('aes-128-cbc',aesKey,Buffer.from(ivHex,'hex'));
 const decodedSegment=Buffer.concat([decipher.update(encryptedSegment),decipher.final()]);fs.writeFileSync('qa-decoded-segment.ts',decodedSegment);
 const probe=JSON.parse(cp.execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_type,codec_name,width,height','-of','json','qa-decoded-segment.ts'],{encoding:'utf8'}));
 check('proxy key and IV decrypt a valid video stream',probe.streams.some(s=>s.codec_type==='video'&&s.width>0));
 const tampered=new URL(segmentUrl);tampered.searchParams.set('enc',tampered.searchParams.get('enc')==='0'?'1':'0');check('client cannot turn encryption off',(await fetch(tampered)).status===403);
 await api('/api/r/'+state.adminVideo,{token:mediaToken,expected:403});check('license scoped to its course',true);
 const direct=await fetch(entry.bunnyUrl,{signal:AbortSignal.timeout(20000)});check('unsigned Bunny CDN playlist denied',[401,403].includes(direct.status));
 await db.pool.query("UPDATE licenses SET status='revoked' WHERE id=$1",[activation.licenseId]);
 await api('/api/r/'+entry.videoId,{token:mediaToken,expected:403});check('revocation immediately stops an existing JWT',true);
 await db.pool.query("UPDATE licenses SET status='active' WHERE id=$1",[activation.licenseId]);
 await api('/api/session/heartbeat',{body:{sessionId:playback.sessionId,mediaToken,deviceId,currentTime:1}});check('heartbeat accepts its own live session',true);
 await api('/api/session/heartbeat',{body:{sessionId:crypto.randomUUID(),mediaToken,deviceId,currentTime:1},expected:403});check('heartbeat rejects another session',true);
 await api('/api/session/end',{body:{sessionId:playback.sessionId,mediaToken,deviceId}});
 await api('/api/r/'+entry.videoId,{token:mediaToken,expected:403});check('ending a session immediately stops its media token',true);
 report.finishedAt=new Date().toISOString();report.success=true;
 fs.writeFileSync('qa-e2e-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({success:true,checks:report.checks.length,assets:report.assets}));
})().catch(e=>{report.success=false;report.error=e.message;fs.writeFileSync('qa-e2e-report.json',JSON.stringify(report,null,2));console.error(e.stack);process.exitCode=1;}).finally(()=>db.pool.end());
