const h = require('https');

function req(method, path, body, headers) {
  return new Promise((res, rej) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'edulocksystemsoficial.dpdns.org',
      path, method,
      headers: Object.assign({'Content-Type':'application/json'}, headers || {})
    };
    if (bodyStr) opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const r = h.request(opts, resp => {
      let d = ''; resp.on('data', c => d+=c);
      resp.on('end', () => res({status: resp.statusCode, body: d}));
    });
    r.on('error', rej);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

async function run() {
  const login = await req('POST', '/api/auth/admin-login', {username:'admin@edulocksystemsoficial.dpdns.org', password:'123456789'});
  console.log('LOGIN:', login.status);
  const data = JSON.parse(login.body);
  const TOKEN = data.token;
  if (!TOKEN) { console.log('No token:', login.body); return; }

  function auth(method, path) {
    return new Promise((res, rej) => {
      const r = h.request({
        hostname: 'edulocksystemsoficial.dpdns.org',
        path, method,
        headers: { Authorization: 'Bearer ' + TOKEN }
      }, resp => {
        let d = ''; resp.on('data', c => d+=c);
        resp.on('end', () => res({status: resp.statusCode, preview: d.slice(0,100)}));
      });
      r.on('error', rej); r.end();
    });
  }

  const routes = [
    '/api/video/catalog',
    '/api/courses',
    '/api/audit/log',
    '/api/admin/registrations',
    '/api/suspicious-activity',
  ];
  for (const p of routes) {
    const x = await auth('GET', p);
    console.log(x.status, p, '-', x.preview.replace(/\n/g,'').slice(0,60));
  }
}

run().catch(e => console.error(e));
