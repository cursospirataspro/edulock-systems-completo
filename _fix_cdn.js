// _fix_cdn.js - Obtener el CDN hostname correcto de la libreria 639343 de Bunny
const https = require('https');

const BASE = 'edulocksystemsoficial.dpdns.org';
const LIBRARY_ID = '639343';

function apiReq(method, hostname, path, extraHeaders = {}, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname, path, method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) },
    };
    const r = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        console.log(`  HTTP ${res.statusCode}`);
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => { r.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

async function main() {
  // 1. Obtener admin token
  console.log('1. Admin login...');
  const auth = await apiReq('POST', BASE, '/api/auth/admin-login', {},
    {username:'admin@edulocksystemsoficial.dpdns.org', password:'123456789'});
  const adminToken = auth.token;
  if (!adminToken) { console.error('Login failed:', auth); return; }
  console.log('  OK');

  // 2. Obtener config de Bunny guardada en el servidor
  console.log('\n2. Bunny config...');
  const conf = await apiReq('GET', BASE, '/api/bunny/config', {Authorization:`Bearer ${adminToken}`});
  console.log('  libraryId:', conf.libraryId);
  console.log('  cdnHostname:', conf.cdnHostname);

  // 3. Llamar directamente al API de Bunny Stream para obtener los detalles de la libreria
  // Esto nos dará el hostname correcto
  console.log('\n3. Obtener detalles de la libreria desde Bunny Stream API...');
  // Necesitamos el apiKey - lo pasamos por query al endpoint de bunny/videos para que el servidor lo use
  // O podemos llamar desde aqui directamente pero necesitamos el apiKey
  
  // Llamar GET /api/bunny/videos para ver el CDN que usa actualmente
  const vidsResp = await apiReq('GET', BASE, '/api/bunny/videos', {Authorization:`Bearer ${adminToken}`});
  console.log('  cdnHostname en videos:', vidsResp.cdnHostname);
  console.log('  total videos:', vidsResp.total);
  if (vidsResp.videos && vidsResp.videos.length > 0) {
    console.log('  Primer video guid:', vidsResp.videos[0].guid);
    console.log('  Primer video hlsUrl:', vidsResp.videos[0].hlsUrl);
    console.log('  Primer video status:', vidsResp.videos[0].status);
  }

  // 4. Verificar si algunos videos en Bunny tienen status != 4 (no listos)
  const notReady = vidsResp.videos ? vidsResp.videos.filter(v => v.status !== 4) : [];
  console.log('\n4. Videos no listos (status != 4):', notReady.length);
  notReady.slice(0, 5).forEach(v => console.log(`  - ${v.title} (status: ${v.status})`));

  // 5. Verificar la URL de un video especifico mediante el thumbnail de Bunny
  // Los thumbnails son accesibles como: https://vz-*.b-cdn.net/{guid}/{thumbnail}.jpg
  // Si el CDN hostname es correcto, al menos el thumbnail deberia funcionar
  console.log('\n5. Verificando acceso al CDN...');
  if (vidsResp.videos && vidsResp.videos.length > 0) {
    const guid = vidsResp.videos[0].guid;
    const cdn = vidsResp.cdnHostname || 'https://vz-c27bf7e5-30f.b-cdn.net';
    
    // Probar con thumbnail
    const thumbUrl = `${cdn}/${guid}/thumbnail.jpg`;
    const hlsUrl = `${cdn}/${guid}/playlist.m3u8`;
    
    for (const url of [thumbUrl, hlsUrl]) {
      await new Promise((res) => {
        const r = https.get(url, {timeout:5000, headers:{'User-Agent':'Mozilla/5.0','Referer':cdn+'/'}}, (resp) => {
          resp.resume();
          console.log(`  ${url.includes('thumbnail') ? 'thumbnail' : 'HLS'}: HTTP ${resp.statusCode}`);
          res();
        });
        r.on('error', e => { console.log(`  ERROR: ${e.message}`); res(); });
      });
    }
  }

  // 6. Intentar obtener info de la libreria desde el API de Bunny Stream con el apiKey guardado
  // Llamamos al endpoint del servidor que puede hacer esta peticion
  console.log('\n6. Verificando videos existentes en catalogo actual...');
  const courseResp = await apiReq('GET', BASE, '/api/courses', {Authorization:`Bearer ${adminToken}`});
  const aless = courseResp.courses ? courseResp.courses.find(c => c.name && c.name.includes('Aless')) : null;
  console.log('  Aless Futures:', aless ? `ID=${aless.id} videos=${aless.videoCount}` : 'NO ENCONTRADO');

  if (aless) {
    const vids = await apiReq('GET', BASE, `/api/courses/${aless.id}/videos`, {Authorization:`Bearer ${adminToken}`});
    const sample = vids.videos ? vids.videos.slice(0, 3) : [];
    sample.forEach(v => {
      console.log(`  - ${v.title}`);
      console.log(`    bunnyUrl: ${v.bunnyUrl}`);
    });
  }
}

main().catch(e => console.error('FATAL:', e.message));
