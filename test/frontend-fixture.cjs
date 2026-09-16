// Local UI fixture only: synthetic accounts/data, no database or remote API calls.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const courses = [], modules = [], videos = [], operations = new Map();
let counter = 0;
function json(res, status, data) { res.writeHead(status, { 'Content-Type':'application/json' }); res.end(JSON.stringify(data)); }
async function readBody(req) { let body = ''; for await (const chunk of req) body += chunk; return body; }
function field(body, name) { const match = body.match(new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]+)')); return match && match[1]; }
const server = http.createServer(async (req,res) => {
    try {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (req.method === 'GET' && ['/', '/productor', '/productor.html', '/admin', '/admin.html', '/logo.png'].includes(pathname)) {
            const file = pathname.includes('admin') ? 'admin.html' : pathname === '/logo.png' ? 'logo.png' : 'productor.html';
            res.writeHead(200, { 'Content-Type':file.endsWith('png') ? 'image/png' : 'text/html; charset=utf-8' });
            res.end(fs.readFileSync(path.join(root, file))); return;
        }
        if (pathname === '/api/producer/login') return json(res,200,{ token:'local-ui-fixture-token' });
        if (pathname === '/api/producer/me') return json(res,200,{ id:'fixture-owner', name:'Productor de prueba', email:'fixture@example.invalid', quotas:{ maxLicenses:20,maxDevices:2 }, usage:{ licensesUsed:0 } });
        if (pathname === '/api/producer/courses') {
            if (req.method === 'GET') return json(res,200,{ courses });
            const input = JSON.parse(await readBody(req));
            const course = { id:'course-' + (++counter), name:input.name, author:input.author, bunnyWarning:'Servicio de prueba; no se creó una biblioteca real' };
            courses.push(course); return json(res,201,course);
        }
        const courseModules = pathname.match(/^\/api\/producer\/courses\/([^/]+)\/modules$/);
        if (courseModules) {
            if (req.method === 'GET') return json(res,200,{ modules:modules.filter(item => item.courseId === courseModules[1]) });
            const input = JSON.parse(await readBody(req));
            const module = { id:'module-' + (++counter), courseId:courseModules[1], ...input };
            modules.push(module); return json(res,201,module);
        }
        if (pathname === '/api/producer/stream/upload') {
            const body = await readBody(req);
            const operationId = field(body,'operationId');
            const video = { videoId:'video-' + (++counter), title:field(body,'title'), courseId:field(body,'courseId'), status:'processing', sourceType:'bunny' };
            const operation = { operationId, videoId:video.videoId, phase:'processing', ready:false, failed:false, encodeProgress:0, reads:0 };
            operations.set(operationId,operation); videos.push(video); return json(res,202,operation);
        }
        const operationRoute = pathname.match(/^\/api\/producer\/stream\/operations\/(.+)$/);
        if (operationRoute) {
            const operation = operations.get(operationRoute[1]);
            if (!operation) return json(res,404,{ error:'No existe la operación' });
            operation.reads++; operation.encodeProgress = Math.min(100, operation.reads * 35);
            if (operation.reads >= 3) { operation.ready = true; operation.phase = 'ready'; videos.find(v => v.videoId === operation.videoId).status = 'ready'; }
            return json(res,200,operation);
        }
        if (pathname === '/api/producer/videos') return json(res,200,{ videos });
        if (pathname === '/api/producer/licenses') return json(res,200,{ lots:[] });
        if (pathname === '/api/producer/activations') return json(res,200,{ activations:[] });
        if (/\/api\/producer\/video\/[^/]+\/sublink$/.test(pathname)) return json(res,200,{ sublink:'http://127.0.0.1:49310/cover/FIXTURE-ONLY' });
        if (pathname === '/api/producer/license/generate-bulk') {
            const input = JSON.parse(await readBody(req));
            return json(res,201,{ keys:Array.from({ length:input.quantity },(_,i) => 'FIXTURE-NOT-A-LICENSE-' + i) });
        }
        json(res,404,{ error:'Ruta no incluida en el entorno de prueba.' });
    } catch (error) { json(res,500,{ error:error.message }); }
});
server.listen(49310,'127.0.0.1',() => console.log('Synthetic frontend fixture at http://127.0.0.1:49310/productor'));
