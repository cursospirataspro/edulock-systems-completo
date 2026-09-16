'use strict';
const http = require('http');
const https = require('https');

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

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, {headers:{Referer: new URL(url).origin + '/'}}, res => {
            let d=''; res.on('data',c=>d+=c);
            res.on('end',()=>resolve({s:res.statusCode,body:d.slice(0,300)}));
        }).on('error', reject);
    });
}

async function main() {
    // Admin login
    const lo = await req('POST','/api/auth/admin-login',{username:'kendorgarciafx2022@gmail.com',password:'Rotermark2025.'});
    const adminTok = lo.b.token;

    // Student login
    const al = await req('POST','/api/auth/login',{email:'alumno.prueba@test.com',studentId:'TEST001',deviceFingerprint:'test-device-fingerprint-001'});
    const stuTok = al.b.token;

    // Catalog
    const cat = await req('GET','/api/video/catalog',null,adminTok);
    const videos = cat.b.catalog || [];
    console.log('Videos en catálogo:', videos.length);
    videos.forEach(v => console.log(' -', v.title, '|', v.videoId, '|', v.bunnyUrl ? v.bunnyUrl.slice(0,60) : '(sin bunnyUrl)'));

    if (!videos.length) { console.log('Catálogo vacío'); return; }

    // Generate command for first video
    const videoId = videos[0].videoId;
    const genCmd = await req('POST','/api/playback/generate-command',{videoId,deviceId:'test-device-fingerprint-001'},stuTok);
    if (!genCmd.b.playerUrl) { console.log('generate-command FAIL:', JSON.stringify(genCmd.b)); return; }

    const qs = genCmd.b.playerUrl.replace(/^cdp:\/\/play\?/i,'');
    const params = new URLSearchParams(qs);
    const cmdParam  = params.get('cmd');
    const authParam = params.get('auth');

    // Resolve
    const reso = await req('POST','/api/playback/resolve',{command:cmdParam},authParam);
    console.log('\nResolve status:', reso.s);
    if (reso.s !== 200) { console.log('Resolve FAIL:', JSON.stringify(reso.b)); return; }

    const manifestUrl = reso.b.manifestUrl;
    const mediaToken = reso.b.mediaToken;
    console.log('manifestUrl:', manifestUrl);

    // Fetch the manifest via server proxy
    const manifestRes = await new Promise((resolve,reject) => {
        http.get(manifestUrl, {headers:{'Authorization':'Bearer '+authParam,'X-Media-Token':mediaToken}}, res => {
            let d=''; res.on('data',c=>d+=c);
            res.on('end',()=>resolve({s:res.statusCode,body:d.slice(0,500)}));
        }).on('error',reject);
    });
    console.log('\nManifest status:', manifestRes.s);
    console.log('Manifest body (first 500 chars):', manifestRes.body);

    // Test direct BunnyNet URL
    console.log('\n--- Testing user\'s specific BunnyNet URL ---');
    const bunnyUrl = 'https://vz-06ba72ec-646.b-cdn.net/e59a8e21-2a05-4989-a90c-72f58a10c0be/playlist.m3u8';
    const bunnyRes = await fetchUrl(bunnyUrl).catch(e => ({s:'ERR',body:e.message}));
    console.log('BunnyNet direct fetch:', bunnyRes.s, bunnyRes.body.slice(0,200));
}
main().catch(e=>console.error('ERROR:', e.message, e.stack));
