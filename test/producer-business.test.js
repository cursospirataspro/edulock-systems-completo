'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { requestInput, validPassword, transaction, mountProducerBusiness } = require('../lib/producer-business');
const { createProducerMail } = require('../lib/producer-mail');
test('requests reject quota exploits and only accept supported operations', () => {
    for (const quantity of [-1,0,1.5,Infinity,'1 OR 1=1',1000001]) assert.throws(() => requestInput({kind:'licenses',quantity}));
    assert.throws(() => requestInput({kind:'global-admin',quantity:1}));
    assert.deepEqual(requestInput({kind:'licenses',quantity:'12',message:'  Ampliar  '}),{kind:'licenses',quantity:12,message:'Ampliar'});
    assert.throws(() => requestInput({kind:'support',message:''}));
    assert.throws(() => requestInput({kind:'support',message:'a'.repeat(2001)}));
});
test('new passwords have bounded length and reject missing character classes', () => {
    for(const password of ['',null,'1234567890','abcdefghij','Aa1'.repeat(70)])assert.throws(()=>validPassword(password));
    assert.equal(validPassword('Synthetic-new-123!'),'Synthetic-new-123!');
});
test('transaction failure rolls back and releases connection without a commit', async () => {
    const calls=[],pool={connect:async()=>({query:async sql=>calls.push(sql),release:()=>calls.push('release')})};
    await assert.rejects(transaction(pool,async()=>{throw Error('write failed');}),/write failed/);
    assert.deepEqual(calls,['BEGIN','ROLLBACK','release']);
});
function routes(pool) {
    const map=new Map(),auth=()=>{},app=Object.fromEntries(['get','post','patch','delete'].map(method=>[method,(path,...fns)=>map.set(method+' '+path,fns)]));
    mountProducerBusiness(app,{db:{pool},requireProducer:auth,requireAdmin:auth,secret:'test'.repeat(16),getPublicBase:()=> 'https://example.invalid',hashPassword:()=>'',verifyPassword:()=>false,issueProducerToken:()=>''});
    return {map,async call(key,req){const res={code:200,setHeader(){},status(n){this.code=n;return this;},json(value){this.body=value;}};await map.get(key).at(-1)(req,res);return res;}};
}
test('producer key deletion cannot target another owner and conceals missing records', async()=>{
    let captured;const h=routes({query:async(sql,args)=>{captured={sql,args};return{rows:[]};}});
    const res=await h.call('delete /api/producer/workspace/integrations/:id',{params:{id:'other-key'},producer:{id:'me'}});
    assert.equal(res.code,404);assert.deepEqual(captured.args,['other-key','me']);assert.match(captured.sql,/producer_id=\$2/);
});
test('account update ignores attempts to alter quota, role and owner',async()=>{
    let captured;const h=routes({query:async(sql,args)=>{captured={sql,args};return{rows:[]};}});
    const res=await h.call('patch /api/producer/workspace/account',{body:{name:'My studio',max_licenses:999999,role:'admin',producerId:'other'},producer:{id:'me'}});
    assert.equal(res.code,200);assert.deepEqual(captured.args,['My studio','me']);assert.equal(captured.sql,'UPDATE producers SET name=$1 WHERE id=$2');
});
test('mail without a configured provider neither stores nor sends a message',async()=>{
    let calls=0;const mail=createProducerMail({db:{pool:{query:()=>calls++}},secret:'a'.repeat(40),env:{},getLicenseSerial:()=>calls++,request:()=>calls++});
    assert.equal(mail.configured(),false);assert.equal(await mail.processOne(),null);
    await assert.rejects(mail.enqueue({producerId:'me',licenseId:'license'}),{code:'MAIL_NOT_CONFIGURED'});assert.equal(calls,0);
});
test('mail outbox encryption binds the row ID and detects tampering',()=>{
    const mail=createProducerMail({db:{},secret:'a'.repeat(40),env:{}}),payload={text:'SYNTHETIC-SERIAL-SECRET'},encrypted=mail.seal(payload,'id-a');
    assert.ok(!encrypted.includes(payload.text));assert.deepEqual(mail.open(encrypted,'id-a'),payload);
    assert.throws(()=>mail.open(encrypted,'id-b'));
    const parts=encrypted.split('.');parts[2]=Buffer.alloc(16).toString('base64');assert.throws(()=>mail.open(parts.join('.'),'id-a'));
});
