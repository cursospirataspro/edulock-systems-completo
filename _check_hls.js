// _check_hls.js - Verificar qué GUIDs de Bunny tienen HLS válido
const https = require('https');

const CDN = 'https://vz-c27bf7e5-30f.b-cdn.net';

// Los GUIDs que teníamos trabajando ANTES (de la importación wizard anterior)
const OLD_WORKING_GUIDS = [
  '03814412-a27c-4e35-ac59-3a13770fb586',  // clase respondiendo dudas
  'a238d116-d902-4539-bc3c-24f0e6e2b1de',  // cambios de estructura
  '5f5e20e2-f47b-44c6-ba89-d44fcf04ca23',  // activos futuros
  'be52fc70-be59-4d5c-91ef-4e0e0d7cbe53',  // absorciones footprint 4
  'e410716b-b7bb-455d-a280-80f1d3d0e4ad',  // absorciones footprint 5
  'a6cb0903-17c7-40e7-ac35-a8f9f7e0ab3b',  // configuracion ninja
  'a055dbdb-9e19-4bd3-8292-c5b5df5c0123',  // absorcion agotamiento
  '65519e6f-1996-452e-a715-9a1b2c3d4e5f',  // como mirar noticias
  '47e3c5df-423f-49d0-8de0-56e7f8a9b0c1',  // live-trading 1
];

// Algunos de los nuevos GUIDs del rebuild (de la API de Bunny)
const NEW_GUIDS = [
  'c4efe017-4b22-437a-8a05-c0ed25245307',  // Video Introducción - RETURNS 404
  'bdb13758-07d5-4c7f-a197-e35eb6b2c776',  // 1. Qué es el Trading
  '8a867e02-9d0e-4972-b9b3-fe50d199a1ee',  // 2. Velas Japonesas
];

function fetchStatus(guid) {
  return new Promise((resolve) => {
    const url = `${CDN}/${guid}/playlist.m3u8`;
    const r = https.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': CDN + '/',
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ guid, status: res.statusCode, preview: body.slice(0, 100) }));
    });
    r.on('error', e => resolve({ guid, status: 'ERR', preview: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ guid, status: 'TIMEOUT', preview: '' }); });
  });
}

async function main() {
  console.log('=== GUIDs ANTERIORES (deberian funcionar) ===');
  for (const g of OLD_WORKING_GUIDS) {
    const r = await fetchStatus(g);
    console.log(`${r.status === 200 ? '✅' : '❌'} ${r.guid} → HTTP ${r.status}`);
    if (r.status === 200) console.log('   Preview:', r.preview);
  }
  
  console.log('\n=== GUIDs NUEVOS DEL REBUILD ===');
  for (const g of NEW_GUIDS) {
    const r = await fetchStatus(g);
    console.log(`${r.status === 200 ? '✅' : '❌'} ${r.guid} → HTTP ${r.status}`);
  }
  
  // Verificar el bunny config guardado
  console.log('\n=== BUNNY CONFIG GUARDADO EN EL SERVIDOR ===');
  const confResp = await new Promise((resolve, reject) => {
    const body = JSON.stringify({username:'admin@edulocksystemsoficial.dpdns.org', password:'123456789'});
    const r = https.request({hostname:'edulocksystemsoficial.dpdns.org', path:'/api/auth/admin-login', method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}}, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    r.write(body); r.end();
  });
  const adminToken = confResp.token;
  
  const bunnyConf = await new Promise((resolve, reject) => {
    const r = https.request({hostname:'edulocksystemsoficial.dpdns.org', path:'/api/bunny/config', method:'GET',
      headers:{Authorization:`Bearer ${adminToken}`}}, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    r.end();
  });
  console.log('bunnyConfig:', JSON.stringify(bunnyConf, null, 2));
}

main().catch(e => console.error('FATAL:', e.message));
