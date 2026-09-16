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
    // Admin login
    const lo = await req('POST','/api/auth/admin-login',{username:'kendorgarciafx2022@gmail.com',password:'Rotermark2025.'});
    if (!lo.b.token) { console.log('ADMIN FAIL:', JSON.stringify(lo.b)); return; }
    const adminTok = lo.b.token;

    // Catalog
    const cat = await req('GET','/api/video/catalog',null,adminTok);
    const videos = cat.b.catalog || [];
    console.log('Videos en catálogo:', videos.length);
    if (videos.length) console.log('Primer video:', JSON.stringify(videos[0]).slice(0,300));

    // Student login
    const al = await req('POST','/api/auth/login',{email:'alumno.prueba@test.com',studentId:'TEST001',deviceFingerprint:'test-device-fingerprint-001'});
    if (!al.b.token) { console.log('STUDENT FAIL:', JSON.stringify(al.b)); return; }
    const stuTok = al.b.token;

    if (!videos.length) { console.log('No hay videos'); return; }
    const videoId = videos[0].videoId;

    // Generate command
    const cmd = await req('POST','/api/playback/generate-command',{videoId,deviceId:'test-device-fingerprint-001'},stuTok);
    console.log('generate-command:', cmd.s, cmd.b.playerUrl ? 'playerUrl OK' : JSON.stringify(cmd.b).slice(0,300));

    if (!cmd.b.playerUrl) return;

    // Extract cmd and auth from playerUrl
    const qs = cmd.b.playerUrl.replace(/^cdp:\/\/play\?/i,'');
    const params = new URLSearchParams(qs);
    const cmdParam  = params.get('cmd');
    const authParam = params.get('auth');

    console.log('cmd param starts with:', cmdParam ? cmdParam.slice(0,30) : 'null');
    console.log('auth param starts with:', authParam ? authParam.slice(0,30) : 'null');

    // Resolve
    const reso = await req('POST','/api/playback/resolve',{command:cmdParam},authParam);
    console.log('resolve status:', reso.s);
    console.log('resolve body:', JSON.stringify(reso.b).slice(0,500));
}
main().catch(e=>console.error('ERROR:', e.message));
