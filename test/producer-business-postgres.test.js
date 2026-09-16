'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
let name='';try{name=new URL(process.env.DATABASE_URL||'').pathname.slice(1);}catch{}
if(!/^edulock_qa(?:_[a-zA-Z0-9-]+)*$/.test(name)){console.error('REFUSED: isolated edulock_qa database required');process.exit(1);}
const db=require('../database-pg'),{mountProducerBusiness}=require('../lib/producer-business');
const pid=crypto.randomUUID(),other=crypto.randomUUID(),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const routes=new Map(),auth=(_req,_res,next)=>next();
const app=Object.fromEntries(['get','post','patch','delete'].map(method=>[method,(url,...fns)=>routes.set(method+' '+url,fns)]));
mountProducerBusiness(app,{db,requireProducer:auth,requireAdmin:auth,secret:'qa-business-secret-'.repeat(3),getPublicBase:()=> 'https://example.invalid',hashPassword:hash,verifyPassword:(value,digest)=>hash(value)===digest,issueProducerToken:p=>'version-'+p.auth_version});
async function call(method,path,body={},params={},producerId=pid){
    const req={body,params,query:{},producer:await db.getProducerById(producerId),user:{sub:'synthetic-qa-admin'}};
    const res={code:200,setHeader(){},status(n){this.code=n;return this;},json(value){this.body=value;return this;}};
    await routes.get(method+' '+path).at(-1)(req,res);return res;
}
test.before(async()=>{await db.initDb();for(const id of[pid,other])await db.createProducer({id,email:'business-'+id+'@example.invalid',passwordHash:hash('Synthetic-old-123'),maxLicenses:5,maxDevices:2,maxStudents:3});});
test.after(async()=>{try{for(const table of['producer_service_requests','integration_keys'])await db.pool.query(`DELETE FROM ${table} WHERE producer_id=ANY($1::text[])`,[[pid,other]]);await db.pool.query('DELETE FROM producers WHERE id=ANY($1::text[])',[[pid,other]]);}finally{await db.pool.end();}});
test('request appears only to its producer and owner approval changes quota once',async()=>{
    const created=await call('post','/api/producer/workspace/service-requests',{kind:'licenses',quantity:7,message:'Synthetic QA'});
    assert.equal(created.code,201);const id=created.body.request.id;
    const foreign=await call('get','/api/producer/workspace/service-requests',{}, {},other);assert.ok(!foreign.body.requests.some(r=>r.id===id));
    const results=await Promise.all([call('patch','/api/owner/service-requests/:id',{status:'approved',adminReply:'Synthetic approval'},{id}),call('patch','/api/owner/service-requests/:id',{status:'approved'},{id})]);
    assert.deepEqual(results.map(r=>r.code).sort(),[200,409]);assert.equal((await db.getProducerById(pid)).max_licenses,12);
    const own=await call('get','/api/producer/workspace/service-requests');assert.equal(own.body.requests.find(r=>r.id===id).status,'approved');
});
test('storage approval cannot claim capacity that was never provisioned',async()=>{
    const created=await call('post','/api/producer/workspace/service-requests',{kind:'storage',quantity:40});
    const response=await call('patch','/api/owner/service-requests/:id',{status:'approved'},{id:created.body.request.id});
    assert.equal(response.code,409);assert.equal(response.body.code,'STORAGE_MANUAL');
});
test('integration keys are private to producer and only hashed in SQL',async()=>{
    const created=await call('post','/api/producer/workspace/integrations',{name:'Synthetic shop'});assert.equal(created.code,201);
    const record=(await db.pool.query('SELECT * FROM integration_keys WHERE id=$1',[created.body.id])).rows[0];
    assert.equal(record.producer_id,pid);assert.notEqual(record.key_hash,created.body.apiKey);
    assert.equal(record.key_hash,crypto.createHmac('sha256','qa-business-secret-'.repeat(3)).update(created.body.apiKey).digest('hex'));
    const foreign=await call('delete','/api/producer/workspace/integrations/:id',{}, {id:created.body.id},other);assert.equal(foreign.code,404);
    const list=await call('get','/api/producer/workspace/integrations');assert.ok(!JSON.stringify(list.body).includes(created.body.apiKey));assert.ok(!JSON.stringify(list.body).includes(record.key_hash));
    assert.equal((await call('delete','/api/producer/workspace/integrations/:id',{}, {id:created.body.id})).code,200);
});
test('password change checks current password and increments session version',async()=>{
    const denied=await call('post','/api/producer/workspace/account/password',{currentPassword:'wrong',newPassword:'Synthetic-new-123'});assert.equal(denied.code,403);
    const changed=await call('post','/api/producer/workspace/account/password',{currentPassword:'Synthetic-old-123',newPassword:'Synthetic-new-123'});assert.equal(changed.code,200);assert.equal(changed.body.token,'version-1');
    const p=await db.getProducerById(pid);assert.equal(p.password_hash,hash('Synthetic-new-123'));assert.equal(p.auth_version,1);
});
test('overview and account return database counts, quotas, and honest unavailable services',async()=>{
    const overview=await call('get','/api/producer/workspace/overview');assert.equal(overview.code,200);assert.equal(overview.body.projects,0);
    const account=await call('get','/api/producer/workspace/account');assert.equal(account.body.quotas.maxLicenses,12);assert.equal(account.body.mail.configured,false);assert.equal(account.body.features.automaticBilling,false);
});
