// Test de la lógica DoH del player (misma implementación)
const https = require('https');

function dohQuery(providerIp, dohPath, hostname) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: providerIp,
      path: `${dohPath}?name=${encodeURIComponent(hostname)}&type=A`,
      headers: { accept: 'application/dns-json' },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const ans = (JSON.parse(data).Answer || []).find(a => a.type === 1);
          if (ans && ans.data) resolve({ ip: ans.data, ttl: ans.TTL });
          else reject(new Error('sin registro A: ' + data.slice(0, 200)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

(async () => {
  const host = 'edulocksystemsoficial.dpdns.org';
  for (const [ip, p] of [['1.1.1.1', '/dns-query'], ['8.8.8.8', '/resolve']]) {
    try {
      const r = await dohQuery(ip, p, host);
      console.log(`OK  ${ip}${p} → ${host} = ${r.ip} (TTL ${r.ttl})`);
    } catch (e) {
      console.log(`FAIL ${ip}${p}: ${e.message}`);
    }
  }
  // Verificar que conectar por IP con SNI del dominio funciona (como hará el player)
  const { ip } = await dohQuery('1.1.1.1', '/dns-query', host);
  // Misma implementación que dnsFallbackLookup del player, forzando fallo del DNS local
  function lookupComoPlayer(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    // simular ENOTFOUND del sistema → ir directo a DoH (ya resuelto arriba)
    if (options && options.all) return callback(null, [{ address: ip, family: 4 }]);
    callback(null, ip, 4);
  }
  await new Promise((resolve) => {
    const req = https.request({ hostname: host, path: '/api/health', timeout: 8000, lookup: lookupComoPlayer, servername: host }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { console.log(`Ping vía IP DoH: HTTP ${res.statusCode} ${d.slice(0, 120)}`); resolve(); });
    });
    req.on('error', e => { console.log('Ping FAIL:', e.message); resolve(); });
    req.end();
  });
})();
