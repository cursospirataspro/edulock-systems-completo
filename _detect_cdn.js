// _detect_cdn.js - Detectar el CDN hostname correcto para Bunny library 639343
const https = require('https');

const LIBRARY_ID = '639343';
// Primer video GUID (sabemos que existe en Bunny con status:4)
const TEST_GUID = '03814412-a27c-4e35-ac59-3a13770fb586';

function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000, ...opts }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function apiReq(method, hostname, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname, path, method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, body: raw }); } });
    });
    r.on('error', reject);
    r.setTimeout(20000, () => { r.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

async function main() {
  // 1. Obtener admin token y api key guardado
  console.log('1. Login admin...');
  const authResp = await apiReq('POST', 'edulocksystemsoficial.dpdns.org', '/api/auth/admin-login', {},
    {username:'admin@edulocksystemsoficial.dpdns.org', password:'123456789'});
  const adminToken = authResp.body.token;
  
  // 2. Obtener la API key de Bunny desde el servidor
  // Necesitamos hacer una peticion que exponga la key (no existe endpoint para esto)
  // Pero podemos hacer una peticion al servidor que pase la key al API de Bunny
  
  // 3. Probar el iframe embed de Bunny para obtener CDN hostname
  console.log('\n2. Fetching Bunny iframe embed...');
  const iframeUrl = `https://iframe.mediadelivery.net/embed/${LIBRARY_ID}/${TEST_GUID}`;
  const iframeResp = await fetchUrl(iframeUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  console.log('  Status:', iframeResp.status);
  
  // Buscar CDN hostname en el HTML
  const cdnMatches = iframeResp.body.match(/https:\/\/vz-[a-z0-9-]+\.b-cdn\.net/g);
  if (cdnMatches) {
    console.log('  CDN hostnames encontrados:', [...new Set(cdnMatches)]);
  } else {
    console.log('  No se encontro CDN hostname en iframe');
    // Mostrar extracto del HTML para debug
    const hlsMatch = iframeResp.body.match(/playlist\.m3u8[^"']*/);
    const hlsMatch2 = iframeResp.body.match(/"hlsUrl"[^,}]*/);
    const hlsMatch3 = iframeResp.body.match(/\.b-cdn\.net[^"']*/);
    if (hlsMatch) console.log('  playlist.m3u8 context:', hlsMatch[0].slice(0, 200));
    if (hlsMatch2) console.log('  hlsUrl:', hlsMatch2[0].slice(0, 200));
    if (hlsMatch3) console.log('  b-cdn.net:', hlsMatch3[0].slice(0, 200));
  }
  
  // 4. Buscar en el HTML otras referencias a CDN
  const mediaMatches = iframeResp.body.match(/https:\/\/[a-z0-9-]+\.(b-cdn\.net|mediadelivery\.net)[^"'\s]*/g);
  if (mediaMatches) {
    console.log('  Media URLs encontradas:', [...new Set(mediaMatches)].slice(0, 10));
  }
  
  // Mostrar primeros 2000 chars del HTML para debug
  console.log('\n  HTML snippet (first 2000 chars):');
  console.log(iframeResp.body.slice(0, 2000));
  
  // 5. Probar CDN hostnames alternativos
  console.log('\n3. Probando CDN hostname alternativo via /api/bunny/libraries...');
  // Llamar al endpoint de libraries con la account key del usuario
  // (no la tenemos, pero podemos probar con lo que hay)
  
  // 6. Verificar el hostname via llamada al API de Bunny Stream con GET /library/{id}
  // Necesitamos la apiKey guardada en la base de datos
  // La forma de obtenerla es hacer que el servidor la use y nos devuelva el CDN
  console.log('\n4. Llamando GET /api/bunny/videos para ver que CDN devuelve...');
  const vidsResp = await apiReq('GET', 'edulocksystemsoficial.dpdns.org', '/api/bunny/videos',
    { Authorization: `Bearer ${adminToken}` });
  console.log('  Status:', vidsResp.status);
  if (vidsResp.body && vidsResp.body.cdnHostname) {
    console.log('  cdnHostname guardado:', vidsResp.body.cdnHostname);
    
    // El servidor tiene acceso a la API key de Bunny
    // Necesitamos un endpoint que llame GET /library/{id} y nos devuelva el PullZoneId
    // o el CDN hostname completo
    
    // Por ahora, intentemos acceder a la thumbnail con varios posibles CDN hostnames
    // El pullZoneId de Bunny suele ser un número largo
  }
  
  // 7. Probar el video HLS via mediadelivery.net (endpoint publico de Bunny)
  console.log('\n5. Probando acceso via mediadelivery.net...');
  const mediaUrl = `https://stream.mediadelivery.net/${LIBRARY_ID}/${TEST_GUID}/playlist.m3u8`;
  const mediaResp = await fetchUrl(mediaUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://iframe.mediadelivery.net/' }
  });
  console.log('  stream.mediadelivery.net HLS status:', mediaResp.status);
  if (mediaResp.status === 200) {
    console.log('  HLS content:', mediaResp.body.slice(0, 200));
  }
  
  // 8. Probar variantes del hostname
  const variants = [
    `https://stream-${LIBRARY_ID}.b-cdn.net`,
    `https://video-${LIBRARY_ID}.b-cdn.net`,
  ];
  for (const cdn of variants) {
    const r = await fetchUrl(`${cdn}/${TEST_GUID}/playlist.m3u8`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }).catch(e => ({ status: 'ERR: ' + e.message }));
    console.log(`  ${cdn}: ${r.status}`);
  }
}

main().catch(e => console.error('FATAL:', e.message));
