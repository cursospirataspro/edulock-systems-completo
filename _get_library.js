// _get_library.js
const https = require('https');
function req(method, path, body, headers={}) {
  return new Promise((resolve,reject)=>{
    const bs = body?JSON.stringify(body):null;
    const r = https.request({hostname:'edulocksystemsoficial.dpdns.org',path,method,
      headers:{'Content-Type':'application/json',...headers,...(bs?{'Content-Length':Buffer.byteLength(bs)}:{})}
    },(res)=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>{try{resolve(JSON.parse(raw));}catch{resolve(raw);}});});
    r.on('error',reject);r.setTimeout(20000,()=>{r.destroy();reject(new Error('Timeout'));});
    if(bs)r.write(bs);r.end();
  });
}
async function main(){
  const tok = (await req('POST','/api/auth/admin-login',{username:'admin@edulocksystemsoficial.dpdns.org',password:'123456789'})).token;
  const lib = await req('GET','/api/bunny/library-raw',null,{Authorization:`Bearer ${tok}`});
  console.log(JSON.stringify(lib, null, 2));
}
main().catch(e=>console.error(e.message));
