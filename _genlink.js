'use strict';
const http = require('http');
const fs   = require('fs');

function req(method, path, body, token) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const h = { 'Content-Type': 'application/json' };
        if (data) h['Content-Length'] = Buffer.byteLength(data);
        if (token) h['Authorization'] = 'Bearer ' + token;
        const r = http.request({ host:'localhost', port:3000, path, method, headers:h }, res => {
            let d=''; res.on('data',c=>d+=c);
            res.on('end',()=>{ try{resolve(JSON.parse(d))}catch{resolve({_raw:d})} });
        });
        r.on('error',reject);
        if (data) r.write(data);
        r.end();
    });
}

async function main() {
    // 1. Admin login
    const lo = await req('POST','/api/auth/admin-login',{
        username:'kendorgarciafx2022@gmail.com',
        password:'Rotermark2025.'
    });
    if (!lo.token) { console.error('ADMIN LOGIN FAIL:', JSON.stringify(lo)); process.exit(1); }

    // 2. Verificar/añadir video
    let cat = await req('GET','/api/video/catalog',null,lo.token);
    let videos = cat.catalog || [];
    let videoId, videoTitle;

    if (!videos.length) {
        let raw = fs.readFileSync('./backup_render_1421videos_2026-05-22.json','utf-8');
        if (raw.charCodeAt(0)===0xFEFF) raw=raw.slice(1);
        const bv = JSON.parse(raw).catalog.value[0];
        const ar = await req('POST','/api/catalog/add-bunny',{title:bv.title,bunnyUrl:bv.bunnyUrl},lo.token);
        videoId    = ar.videoId;
        videoTitle = ar.title;
        console.log('  Video añadido al catálogo:', videoTitle);
    } else {
        videoId    = videos[0].videoId;
        videoTitle = videos[0].title;
        console.log('  Video en catálogo:', videoTitle);
    }

    // 3. Login alumno de prueba
    const al = await req('POST','/api/auth/login',{
        email:'alumno.prueba@test.com',
        studentId:'TEST001',
        deviceFingerprint:'test-device-fingerprint-001'
    });
    if (!al.token) { console.error('STUDENT LOGIN FAIL:', JSON.stringify(al)); process.exit(1); }

    // 4. Generar playerUrl
    const cmd = await req('POST','/api/playback/generate-command',{
        videoId,
        deviceId:'test-device-fingerprint-001'
    }, al.token);

    if (!cmd.playerUrl) { console.error('GENERATE FAIL:', JSON.stringify(cmd)); process.exit(1); }

    const url = cmd.playerUrl;
    console.log('  Alumno: alumno.prueba@test.com (CDP-86XUT)');
    console.log('  Video : ' + videoTitle);
    console.log('  Expira: 15 minutos\n');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(url);
    console.log('══════════════════════════════════════════════════════════════');
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
