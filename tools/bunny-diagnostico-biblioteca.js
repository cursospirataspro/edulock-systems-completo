// Herramienta de operación: ejecutar en el VPS desde /opt/reproductor con NODE_PATH=/opt/reproductor/node_modules node <archivo>. Solo lectura salvo que el nombre indique reparación o prueba; nunca imprime claves.
// Diagnóstico de SOLO LECTURA de la biblioteca Bunny del curso (no imprime claves).
const https = require('https');
const { Pool } = require('pg');
const url = require('fs').readFileSync('/opt/reproductor/.env','utf8').match(/DATABASE_URL=(.*)/)[1].trim();
const pool = new Pool({ connectionString: url });
function get(host, path, key) {
  return new Promise(resolve => {
    const req = https.request({ method:'GET', hostname:host, path, headers:{ AccessKey:key, Accept:'application/json' }, timeout:20000 }, res => {
      let b=''; res.on('data', c => b+=c); res.on('end', () => resolve({ status:res.statusCode, body:b }));
    });
    req.on('error', e => resolve({ status:0, body:String(e.message) })); req.on('timeout', () => { req.destroy(); resolve({ status:0, body:'timeout' }); });
    req.end();
  });
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in (o||{})).map(k => [k, o[k]]));
(async () => {
  const cfg = (await pool.query("SELECT value FROM app_config WHERE key='bunny_account_key'")).rows[0];
  const accountKey = (cfg && cfg.value) || process.env.BUNNY_ACCOUNT_KEY || '';
  console.log('accountKey present:', !!accountKey, 'len', accountKey.length);
  const course = (await pool.query("SELECT id,name,bunny_library_id,bunny_library_key,bunny_pull_zone,bunny_token_key FROM courses WHERE id='53aeed8e-973e-48f9-8557-4d516cdeaf61'")).rows[0];
  console.log('course', { id:course.id, lib:course.bunny_library_id, hasLibKey:!!course.bunny_library_key, pullZone:course.bunny_pull_zone, hasToken:!!course.bunny_token_key });
  const lib = await get('api.bunny.net', `/videolibrary/${course.bunny_library_id}?includeAccessKey=true`, accountKey);
  let L = {}; try { L = JSON.parse(lib.body); } catch {}
  console.log('GET videolibrary ->', lib.status, lib.status>=300 ? lib.body.slice(0,400) : JSON.stringify(pick(L, ['Id','Name','StorageZoneId','PullZoneId','ReplicationRegions','EnableTokenAuthentication','EnableTokenIPVerification','PlayerTokenAuthenticationEnabled','EnableDRM','AllowDirectPlay','BlockNoneReferrer','VideoCount','StorageUsage','HasWatermark','DateCreated','AllowedReferrers','BlockedReferrers'])), 'apiKeyMatchesDb:', !!L.ApiKey && L.ApiKey===course.bunny_library_key);
  if (L.StorageZoneId) { const sz = await get('api.bunny.net', `/storagezone/${L.StorageZoneId}`, accountKey); let S={}; try{S=JSON.parse(sz.body);}catch{}
    console.log('GET storagezone ->', sz.status, sz.status>=300 ? sz.body.slice(0,400) : JSON.stringify(pick(S,['Id','Name','Region','ReplicationRegions','StorageUsed','FilesStored','DateModified']))); }
  if (L.PullZoneId) { const pz = await get('api.bunny.net', `/pullzone/${L.PullZoneId}`, accountKey); let P={}; try{P=JSON.parse(pz.body);}catch{}
    console.log('GET pullzone ->', pz.status, pz.status>=300 ? pz.body.slice(0,400) : JSON.stringify({ ...pick(P,['Id','Name','ZoneSecurityEnabled','ZoneSecurityIncludeHashRemoteIP','Enabled','Type','EnableGeoZoneUS','EnableGeoZoneEU','EnableGeoZoneASIA','EnableGeoZoneSA','EnableGeoZoneAF']), hasSecurityKey: typeof P.ZoneSecurityKey==='string' && P.ZoneSecurityKey.length>0, hostnames:(P.Hostnames||[]).map(h=>h.Value) })); }
  if (course.bunny_library_key) {
    const col = await get('video.bunnycdn.com', `/library/${course.bunny_library_id}/collections?page=1&itemsPerPage=100`, course.bunny_library_key);
    let C={}; try{C=JSON.parse(col.body);}catch{}
    console.log('GET collections ->', col.status, col.status>=300 ? col.body.slice(0,300) : JSON.stringify({ total:C.totalItems, items:(C.items||[]).map(i=>({guid:i.guid,name:i.name,videoCount:i.videoCount})) }));
    const vids = await get('video.bunnycdn.com', `/library/${course.bunny_library_id}/videos?page=1&itemsPerPage=100`, course.bunny_library_key);
    let V={}; try{V=JSON.parse(vids.body);}catch{}
    console.log('GET videos ->', vids.status, vids.status>=300 ? vids.body.slice(0,300) : JSON.stringify({ total:V.totalItems, items:(V.items||[]).map(i=>({guid:i.guid,title:i.title,status:i.status,collectionId:i.collectionId})) }));
  }
  const acct = await get('api.bunny.net', '/videolibrary?page=1&perPage=100', accountKey); let A=[]; try{A=JSON.parse(acct.body);}catch{}
  const items = Array.isArray(A)?A:(A.Items||[]);
  console.log('GET videolibrary list ->', acct.status, JSON.stringify(items.map(l=>({Id:l.Id,Name:l.Name,Replication:l.ReplicationRegions,VideoCount:l.VideoCount}))));
  await pool.end();
})().catch(e => { console.error('diag error', e.message); process.exit(1); });
