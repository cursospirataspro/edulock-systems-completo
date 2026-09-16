'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
let name='';try{name=new URL(process.env.DATABASE_URL||'').pathname.slice(1);}catch{}
if(!/^edulock_qa(?:_[a-zA-Z0-9-]+)*$/.test(name)){console.error('REFUSED: isolated edulock_qa database required');process.exit(1);}
const db=require('../database-pg'),{createProducerMail}=require('../lib/producer-mail');
const producerId=crypto.randomUUID(),courseId=crypto.randomUUID(),studentId=crypto.randomUUID(),licenses=[];
const serial='SYNTHETIC-TEST-SERIAL-ONLY',secret='synthetic-mail-secret-'.repeat(3);
const calls=[],replies=[];
const mail=createProducerMail({db,secret,env:{RESEND_API_KEY:'SYNTHETIC-NEVER-SENT',MAIL_FROM:'Edulock QA <qa@example.invalid>'},getLicenseSerial:async()=>serial,request:async(url,options)=>{calls.push({url,options});const status=replies.shift()||200;return{ok:status===200,status,json:async()=>status===200?{id:'synthetic-provider-'+calls.length}:{error:'synthetic-failure'}};}});
test.before(async()=>{await db.initDb();await db.createProducer({id:producerId,email:'mail-'+producerId+'@example.invalid',passwordHash:'synthetic',maxLicenses:10,maxDevices:2});await db.createCourse({id:courseId,name:'Synthetic mail course',producerId});await db.createStudent({id:studentId,email:'mail-student-'+studentId+'@example.invalid',studentId,name:'Synthetic student',active:true,allowedVideos:[]});await db.pool.query("UPDATE students SET producer_id=$1,approval_status='approved' WHERE id=$2",[producerId,studentId]);});
test.after(async()=>{try{await db.pool.query('DELETE FROM producer_mail_outbox WHERE producer_id=$1',[producerId]);await db.pool.query('DELETE FROM licenses WHERE id=ANY($1::text[])',[licenses]);await db.pool.query('DELETE FROM courses WHERE id=$1',[courseId]);await db.pool.query('DELETE FROM students WHERE id=$1',[studentId]);await db.pool.query('DELETE FROM producers WHERE id=$1',[producerId]);}finally{await db.pool.end();}});
async function fixture(){const id=crypto.randomUUID();licenses.push(id);await db.createFreeLicense({id,licenseKeyHash:crypto.randomBytes(32).toString('hex'),courseId,producerId});await db.pool.query("UPDATE licenses SET status='active',student_id=$1,customer_email=$2 WHERE id=$3",[studentId,'mail-student-'+studentId+'@example.invalid',id]);return id;}
test('concurrent enqueue creates one encrypted message; provider acceptance is not delivery',async()=>{
    const licenseId=await fixture();const jobs=await Promise.all([mail.enqueue({producerId,licenseId}),mail.enqueue({producerId,licenseId})]);assert.equal(jobs[0].id,jobs[1].id);
    const row=(await db.pool.query('SELECT * FROM producer_mail_outbox WHERE id=$1',[jobs[0].id])).rows[0];assert.ok(!row.payload.includes(serial));assert.match(mail.open(row.payload,row.id).text,/SYNTHETIC-TEST-SERIAL-ONLY/);
    const result=await mail.processOne();assert.equal(result.status,'accepted');assert.notEqual(result.status,'delivered');assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.resend.com/emails');
    const persisted=(await db.pool.query('SELECT * FROM producer_mail_outbox WHERE id=$1',[row.id])).rows[0];assert.equal(persisted.payload,'');assert.equal(persisted.status,'accepted');
    assert.equal((await mail.enqueue({producerId,licenseId})).duplicate,true);assert.equal(await mail.processOne(),null);assert.equal(calls.length,1);
});
test('revoked or rotated license cancels queued email before any provider call',async()=>{
    const licenseId=await fixture(),job=await mail.enqueue({producerId,licenseId}),before=calls.length;
    await db.pool.query("UPDATE licenses SET status='revoked' WHERE id=$1",[licenseId]);assert.equal(await mail.processOne(),null);assert.equal(calls.length,before);
    assert.equal((await db.pool.query('SELECT status FROM producer_mail_outbox WHERE id=$1',[job.id])).rows[0].status,'cancelled');
});
test('transient failure retries same encrypted payload and same provider idempotency key',async()=>{
    const licenseId=await fixture(),job=await mail.enqueue({producerId,licenseId});replies.push(503,200);
    assert.equal((await mail.processOne()).status,'queued');
    await db.pool.query('UPDATE producer_mail_outbox SET next_attempt_at=$1 WHERE id=$2',[new Date(Date.now()-1000).toISOString(),job.id]);
    assert.equal((await mail.processOne()).status,'accepted');
    const [first,second]=calls.slice(-2);assert.equal(first.options.body,second.options.body);assert.equal(first.options.headers['Idempotency-Key'],second.options.headers['Idempotency-Key']);
});
test('uncertain message older than provider retry window requires review and never resends',async()=>{
    const licenseId=await fixture(),job=await mail.enqueue({producerId,licenseId}),before=calls.length;
    await db.pool.query("UPDATE producer_mail_outbox SET created_at=$1,status='sending' WHERE id=$2",[new Date(Date.now()-21*3600000).toISOString(),job.id]);
    assert.equal(await mail.processOne(),null);assert.equal(calls.length,before);assert.equal((await db.pool.query('SELECT status FROM producer_mail_outbox WHERE id=$1',[job.id])).rows[0].status,'manual_review');
});
test('terminal delivery states never acknowledge a nonexistent new send',async()=>{
    for(const status of ['failed','cancelled','manual_review']) {
        const licenseId=await fixture(),job=await mail.enqueue({producerId,licenseId}),before=calls.length;
        await db.pool.query('UPDATE producer_mail_outbox SET status=$1 WHERE id=$2',[status,job.id]);
        await assert.rejects(mail.enqueue({producerId,licenseId}),e=>e.code==='MAIL_RETRY_REQUIRED'&&e.statusCode===409);
        assert.equal(await mail.processOne(),null);assert.equal(calls.length,before);
        assert.equal(Number((await db.pool.query('SELECT count(*) n FROM producer_mail_outbox WHERE license_id=$1',[licenseId])).rows[0].n),1);
    }
});
