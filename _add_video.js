'use strict';
const http = require('http');
function req(method, path, body, token) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const h = { 'Content-Type': 'application/json' };
        if (data) h['Content-Length'] = Buffer.byteLength(data);
        if (token) h['Authorization'] = 'Bearer ' + token;
        const r = http.request({ host:'localhost', port:3000, path, method, headers:h }, res => {
            let d=''; res.on('data',c=>d+=c);
            res.on('end',()=>{ try{resolve({s:res.statusCode,b:JSON.parse(d)})}catch{resolve({s:res.statusCode,b:d})} });
        });
        r.on('error',reject);
        if (data) r.write(data);
        r.end();
    });
}
async function main() {
    const lo = await req('POST','/api/auth/admin-login',{username:'kendorgarciafx2022@gmail.com',password:'Rotermark2025.'});
    if (!lo.b.token) { console.error('ADMIN LOGIN FAIL:', JSON.stringify(lo.b)); process.exit(1); }
    const adminTok = lo.b.token;

    // Agregar el video del usuario
    const add = await req('POST','/api/catalog/add-bunny',{
        title: 'Estrategia J - Clase Demo',
        bunnyUrl: 'https://vz-06ba72ec-646.b-cdn.net/e59a8e21-2a05-4989-a90c-72f58a10c0be/playlist.m3u8'
    }, adminTok);
    console.log('add-bunny:', add.s, JSON.stringify(add.b));

    if (add.s !== 201) { console.error('FAIL'); process.exit(1); }
    const videoId = add.b.videoId;

    // Student login
    const al = await req('POST','/api/auth/login',{email:'alumno.prueba@test.com',studentId:'TEST001',deviceFingerprint:'test-device-fingerprint-001'});
    if (!al.b.token) { console.error('STUDENT LOGIN FAIL:', JSON.stringify(al.b)); process.exit(1); }
    const stuTok = al.b.token;

    // Generate command
    const cmd = await req('POST','/api/playback/generate-command',{videoId,deviceId:'test-device-fingerprint-001'},stuTok);
    if (!cmd.b.playerUrl) { console.error('GENERATE FAIL:', JSON.stringify(cmd.b)); process.exit(1); }

    // Verify resolve works
    const qs = cmd.b.playerUrl.replace(/^cdp:\/\/play\?/i,'');
    const params = new URLSearchParams(qs);
    const reso = await req('POST','/api/playback/resolve',{command:params.get('cmd')},params.get('auth'));
    console.log('resolve:', reso.s, reso.s===200 ? 'OK - manifestUrl:'+reso.b.manifestUrl : JSON.stringify(reso.b).slice(0,200));

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(cmd.b.playerUrl);
    console.log('══════════════════════════════════════════════════════════════');
    console.log('Video: Estrategia J - Clase Demo');
    console.log('Expira: 15 minutos');
}
main().catch(e=>console.error('ERROR:', e.message));
