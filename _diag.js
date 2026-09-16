// _diag.js - Diagnóstico del proxy HLS de Aless Futures
const https = require('https');

const BASE = 'edulocksystemsoficial.dpdns.org';
const VIDEO_ID = '5a8594d9-d134-4b12-b597-c6510f7a98cb';
// HLS URL del primer video (Video Introducción OBLIGATORIO)
const HLS_URL = 'https://vz-c27bf7e5-30f.b-cdn.net/c4efe017-4b22-437a-8a05-c0ed25245307/playlist.m3u8';

function req(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: BASE, path, method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const r = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        console.log(`  HTTP ${res.statusCode} — Content-Type: ${res.headers['content-type']}`);
        resolve({ status: res.statusCode, body: raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => { r.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

async function main() {
  // 1. Auto-auth
  console.log('\n1. Auto-auth...');
  const authResp = await req('GET', '/api/auth/auto?did=diag-test');
  let token;
  try {
    const j = JSON.parse(authResp.body);
    token = j.token;
    console.log('  token:', token ? `OK (${token.length} chars)` : 'MISSING');
    if (j.error) console.log('  error:', j.error);
  } catch(e) { console.log('  parse error:', authResp.body.slice(0, 200)); return; }

  // 2. Play endpoint
  console.log('\n2. Play endpoint...');
  const playResp = await req('GET', `/api/video/${VIDEO_ID}/play`, null, { Authorization: `Bearer ${token}` });
  let manifestUrl, mediaToken;
  try {
    const j = JSON.parse(playResp.body);
    manifestUrl = j.manifestUrl;
    mediaToken = j.mediaToken;
    console.log('  manifestUrl:', manifestUrl);
    console.log('  watermark:', j.watermarkText);
    if (j.error) console.log('  ERROR:', j.error);
  } catch(e) { console.log('  parse error:', playResp.body.slice(0, 400)); return; }

  if (!manifestUrl) { console.log('  No manifest URL'); return; }

  // 3. Proxy manifest (/api/r/:videoId)
  console.log('\n3. Proxy manifest...');
  const mResp = await req('GET', `${manifestUrl}?token=${encodeURIComponent(mediaToken)}`, null, { Authorization: `Bearer ${mediaToken}` });
  console.log('  body (first 500):', mResp.body.slice(0, 500));

  // 4. Probar fetchear la URL de Bunny directamente desde el servidor
  console.log('\n4. Fetch Bunny HLS directamente...');
  try {
    const bunnyResp = await new Promise((resolve, reject) => {
      const r = https.get(HLS_URL, {
        timeout: 10000,
        headers: { 
          'User-Agent': 'Mozilla/5.0 (compatible; edulock-systems)',
          'Referer': 'https://vz-c27bf7e5-30f.b-cdn.net/'
        }
      }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => resolve({ status: res.statusCode, body: raw.slice(0, 300) }));
      });
      r.on('error', reject);
    });
    console.log(`  Bunny HTTP: ${bunnyResp.status}`);
    console.log(`  Body: ${bunnyResp.body}`);
  } catch(e) { console.log('  Error:', e.message); }
}

main().catch(e => console.error('FATAL:', e.message));
