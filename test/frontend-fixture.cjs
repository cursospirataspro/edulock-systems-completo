// Local UI fixture only: synthetic accounts/data, no database or remote API calls.
// Serves productor.html / admin.html with enough of the producer API to review the
// panel visually (licenses, lots, students, uploads). Keys shown here are fake.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const courses = [{ id: 'course-1', name: 'Curso de prueba (fixture)', author: 'Fixture', bunnyLibraryId: '0' }];
const modules = [{ id: 'module-1', courseId: 'course-1', name: 'Módulo 1 — Introducción', parentId: null, sortOrder: 10, bunnyCollectionId: null, attachments: 1 },
    { id: 'module-2', courseId: 'course-1', name: 'Módulo 2 — Práctica', parentId: null, sortOrder: 20, bunnyCollectionId: '11111111-2222-4333-8444-555555555555', attachments: 0 },
    { id: 'module-3', courseId: 'course-1', name: 'Conceptos básicos', parentId: 'module-1', sortOrder: 10, bunnyCollectionId: null, attachments: 0 }];
const videos = [{ videoId: 'video-a', title: 'Clase 1 · Bienvenida', courseId: 'course-1', moduleId: 'module-1', sortOrder: 10, status: 'ready', sourceType: 'bunny', publicCode: 'FIXTURE-A', attachments: 2, presentation: { coverUrl: null, theme: 'dark', description: 'Presentación del curso.' } },
    { videoId: 'video-b', title: 'Clase 2 · Preparación', courseId: 'course-1', moduleId: 'module-3', sortOrder: 10, status: 'ready', sourceType: 'bunny', publicCode: null, attachments: 0, presentation: { coverUrl: null, theme: 'dark', description: '' } },
    { videoId: 'video-c', title: 'Clase 3 · Ejercicio inicial', courseId: 'course-1', moduleId: 'module-2', sortOrder: 10, status: 'processing', sourceType: 'bunny', publicCode: null, attachments: 0, presentation: { coverUrl: null, theme: 'dark', description: '' } },
    { videoId: 'video-d', title: 'Clase suelta (sin módulo)', courseId: 'course-1', moduleId: null, sortOrder: 10, status: 'ready', sourceType: 'bunny', publicCode: null, attachments: 0, presentation: { coverUrl: null, theme: 'dark', description: '' } }];
const operations = new Map();
const courseRequests = new Map();
const courseSettings = new Map([['course-1', { purchaseUrl: null, description: 'Curso de demostración del fixture local.', embedOrigins: [] }]]);
const resources = new Map([['video:video-a', [{ id: 'res-1', name: 'Guía en PDF (enlace externo)', type: 'document', protection: 'public', sourceKind: 'link', url: 'https://example.invalid/guia.pdf', version: 1 }, { id: 'res-2', name: 'Apuntes protegidos (PDF alojado)', type: 'document', protection: 'protected', sourceKind: 'file', url: '/resources/res-2/download', version: 1, byteSize: 120000, pageCount: 4 }]]]);
let counter = 100; // los ids nuevos no deben chocar con los datos iniciales (module-1, video-a…)
const now = new Date().toISOString();
const fakeKey = n => `FIXT-${String(n).padStart(4, '0')}-NOTA-REAL`;
const students = [{ id: 'student-1', name: 'Alumna de prueba', email: 'alumna@fixture.invalid', active: true, createdAt: now, lastLogin: now, linkedAt: now, linkedVia: 'license_activation' }];
const lots = [{ id: 'lot-1', name: 'Septiembre (fixture)', notes: '', courseId: 'course-1', courseName: courses[0].name, createdAt: now }];
const licenses = [
    { id: 'lic-1', lotId: 'lot-1', courseId: 'course-1', status: 'free', availability: 'available', serial: fakeKey(1), maxDevices: 2, activationCount: 0, activeActivations: 0, createdAt: now },
    { id: 'lic-2', lotId: 'lot-1', courseId: 'course-1', status: 'free', availability: 'available', serial: fakeKey(2), maxDevices: 2, activationCount: 0, activeActivations: 0, createdAt: now },
    { id: 'lic-3', lotId: 'lot-1', courseId: 'course-1', status: 'active', availability: 'in_use', serial: fakeKey(3), maxDevices: 2, activationCount: 1, activeActivations: 1, createdAt: now, assignedAt: now, studentId: 'student-1', studentName: 'Alumna de prueba', studentEmail: 'alumna@fixture.invalid', customerEmail: 'alumna@fixture.invalid' },
    { id: 'lic-4', lotId: 'lot-1', courseId: 'course-1', status: 'free', availability: 'reserved', serial: fakeKey(4), maxDevices: 2, activationCount: 0, activeActivations: 0, createdAt: now, customerEmail: 'reserva@fixture.invalid' },
    { id: 'lic-5', lotId: 'lot-1', courseId: 'course-1', status: 'suspended', availability: 'suspended', serial: fakeKey(5), maxDevices: 2, activationCount: 1, activeActivations: 0, createdAt: now, assignedAt: now, studentId: 'student-1', studentName: 'Alumna de prueba', studentEmail: 'alumna@fixture.invalid', suspendedAt: now },
    { id: 'lic-6', lotId: 'lot-1', courseId: 'course-1', status: 'revoked', availability: 'revoked', serial: null, serialSuffix: 'ZZZZ', maxDevices: 2, activationCount: 0, activeActivations: 0, createdAt: now, revokedAt: now },
];
const activations = [{ id: 'act-1', licenseId: 'lic-3', deviceId: 'fixture-device-aaaa', status: 'active', blocked: false, createdAt: now, lastUsedAt: now, expiresAt: null },
    { id: 'act-2', licenseId: 'lic-5', deviceId: 'fixture-device-bbbb', status: 'revoked', blocked: true, createdAt: now, lastUsedAt: now, expiresAt: null }];
const view = l => ({ ...l, lotName: lots.find(x => x.id === l.lotId)?.name || '', courseName: courses.find(c => c.id === l.courseId)?.name || '', serialAvailable: !!l.serial, effectiveStatus: l.status, reservedEmail: null });
const counts = list => ({ total: list.length, available: list.filter(l => l.availability === 'available').length, reserved: list.filter(l => l.availability === 'reserved').length,
    inUse: list.filter(l => l.availability === 'in_use').length, suspended: list.filter(l => l.availability === 'suspended').length, revoked: list.filter(l => l.availability === 'revoked').length });
function json(res, status, data) { res.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }); res.end(JSON.stringify(data)); }
async function readBody(req) { let body = ''; for await (const chunk of req) body += chunk; return body; }
function field(body, name) { const match = body.match(new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]+)')); return match && match[1]; }
const server = http.createServer(async (req,res) => {
    try {
        const url = new URL(req.url, 'http://localhost'), pathname = url.pathname;
        if (req.method === 'GET' && ['/', '/productor', '/productor.html', '/admin', '/admin.html', '/logo.png'].includes(pathname)) {
            const file = pathname.includes('admin') ? 'admin.html' : pathname === '/logo.png' ? 'logo.png' : 'productor.html';
            res.writeHead(200, { 'Content-Type':file.endsWith('png') ? 'image/png' : 'text/html; charset=utf-8' });
            res.end(fs.readFileSync(path.join(root, file))); return;
        }
        if (req.method === 'GET' && /^\/(css|js)\/[a-z0-9._-]+\.(css|js)$/i.test(pathname)) {
            const file = path.join(root, 'public', pathname);
            if (!fs.existsSync(file)) return json(res, 404, { error: 'No existe' });
            res.writeHead(200, { 'Content-Type': pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8' });
            res.end(fs.readFileSync(file)); return;
        }
        if (pathname === '/api/producer/login') return json(res,200,{ token:'local-ui-fixture-token' });
        if (pathname === '/api/producer/me') return json(res,200,{ id:'fixture-owner', name:'Productor de prueba', email:'fixture@example.invalid', quotas:{ maxLicenses:20,maxDevices:2,maxStudents:0 }, usage:{ licensesUsed:licenses.length } });
        if (pathname === '/api/producer/courses') {
            if (req.method === 'GET') return json(res,200,{ courses });
            const input = JSON.parse(await readBody(req));
            if (!input.name || !String(input.name).trim()) return json(res, 400, { error: 'Nombre del curso requerido' });
            if (input.requestId && courseRequests.has(input.requestId)) { const prior = courseRequests.get(input.requestId); return json(res, 201, { course: { ...prior, replayed: true }, warning: prior.bunnyWarning }); }
            const course = { id:'course-' + (++counter), name:input.name.trim(), author:(input.author || '').trim(), bunnyWarning:'Servicio de prueba; no se creó una biblioteca real' };
            if (input.requestId) courseRequests.set(input.requestId, course);
            courseSettings.set(course.id, { purchaseUrl: null, description: String(input.description || '').trim(), embedOrigins: [] });
            courses.push(course); return json(res,201,{ course, warning: course.bunnyWarning });
        }
        const collectionRepair = pathname.match(/^\/api\/producer\/courses\/([^/]+)\/modules\/([^/]+)\/collection$/);
        if (collectionRepair && req.method === 'POST') {
            const module = modules.find(m => m.id === collectionRepair[2]);
            if (!module) return json(res, 404, { error: 'Módulo no encontrado' });
            module.bunnyCollectionId = 'fixture-collection-' + module.id;
            return json(res, 200, { ok: true, moduleId: module.id, collectionId: module.bunnyCollectionId });
        }
        const courseModules = pathname.match(/^\/api\/producer\/courses\/([^/]+)\/modules$/);
        if (courseModules) {
            if (req.method === 'GET') return json(res,200,{ modules:modules.filter(item => item.courseId === courseModules[1]) });
            const input = JSON.parse(await readBody(req));
            const siblings = modules.filter(m => m.courseId === courseModules[1] && (m.parentId || null) === (input.parentId || null));
            const module = { id:'module-' + (++counter), courseId:courseModules[1], bunnyCollectionId: null, attachments: 0, parentId: input.parentId || null, name: input.name, sortOrder: Math.max(0, ...siblings.map(m => m.sortOrder || 0)) + 10 };
            modules.push(module); return json(res,201,{ module, warning: 'Servicio de prueba; la colección se prepara al subir' });
        }
        if (pathname === '/api/producer/stream/upload') {
            const body = await readBody(req);
            const operationId = field(body,'operationId');
            if (url.searchParams.get('fail') || field(body, 'title') === 'FALLA') {
                return json(res, 502, { error: 'Bunny respondió HTTP 400.', code: 'BUNNY_HTTP_ERROR', retryable: false, stage: 'library-protect', stageLabel: 'Protección de la biblioteca (DRM básico)',
                    provider: { status: 400, errorKey: 'VideoLibrary.TokenAuthAndDrmConflict', message: 'Cannot have Token Authentication and Basic DRM enabled at the same time' } });
            }
            const video = { videoId:'video-' + (++counter), title:field(body,'title'), courseId:field(body,'courseId'), moduleId: field(body,'moduleId') || null, sortOrder: 999, status:'processing', sourceType:'bunny', publicCode: null, attachments: 0, presentation: { coverUrl: null, theme: 'dark', description: '' } };
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
        const sublink = pathname.match(/\/api\/producer\/video\/([^/]+)\/sublink$/);
        if (sublink) { const v = videos.find(x => x.videoId === sublink[1]); if (!v) return json(res, 404, { error: 'Video no encontrado' }); v.publicCode = v.publicCode || ('FIXTURE-' + v.videoId.toUpperCase()); return json(res,200,{ publicCode: v.publicCode, sublink:'http://127.0.0.1:49310/cover/' + v.publicCode }); }
        if (pathname === '/api/resources' && req.method === 'GET') { const key = url.searchParams.get('targetKind') + ':' + url.searchParams.get('targetId'); return json(res, 200, { resources: resources.get(key) || [], legacyDocuments: [] }); }
        if (pathname === '/api/resources/link' && req.method === 'POST') { const input = JSON.parse(await readBody(req)); const key = input.targetKind + ':' + input.targetId; const item = { id: 'res-' + (++counter), name: input.name, type: input.type, protection: 'public', sourceKind: 'link', url: input.url, version: 1 }; resources.set(key, [...(resources.get(key) || []), item]); const target = input.targetKind === 'video' ? videos.find(v => v.videoId === input.targetId) : modules.find(m => m.id === input.targetId); if (target) target.attachments = (target.attachments || 0) + 1; return json(res, 201, { resource: item }); }
        const resourceRoute = pathname.match(/^\/api\/resources\/([^/]+)$/);
        if (resourceRoute && (req.method === 'PATCH' || req.method === 'DELETE')) { for (const [key, list] of resources) { const item = list.find(r => r.id === resourceRoute[1]); if (!item) continue; if (req.method === 'DELETE') { resources.set(key, list.filter(r => r !== item)); return json(res, 200, { ok: true }); } const input = JSON.parse(await readBody(req)); Object.assign(item, { name: input.name ?? item.name, url: input.url ?? item.url, protection: input.protection ?? item.protection, version: item.version + 1 }); return json(res, 200, { resource: item }); } return json(res, 404, { error: 'Recurso no encontrado' }); }
        if (pathname === '/api/producer/license/generate-bulk') {
            const input = JSON.parse(await readBody(req));
            if (input.expiresAt || input.durationDays) return json(res, 400, { error: 'Las licencias de curso no tienen vencimiento.', code: 'LICENSE_EXPIRY_UNSUPPORTED' });
            const keys = Array.from({ length:input.quantity },(_,i) => fakeKey(licenses.length + i + 1));
            const lot = { id: 'lot-' + (++counter), name: input.name || 'Lote sin nombre', notes: '', courseId: input.courseId, courseName: courses.find(c => c.id === input.courseId)?.name || '', createdAt: new Date().toISOString() };
            lots.unshift(lot);
            keys.forEach((serial, i) => licenses.unshift({ id: 'lic-' + (licenses.length + 1 + i), lotId: lot.id, courseId: input.courseId, status: 'free', availability: 'available', serial, maxDevices: 2, activationCount: 0, activeActivations: 0, createdAt: lot.createdAt }));
            return json(res,200,{ lotId: lot.id, quantity: input.quantity, maxDevices: 2, keys });
        }
        // Workspace API (subset)
        const ws = pathname.startsWith('/api/producer/workspace') ? pathname.slice('/api/producer/workspace'.length) : null;
        if (ws !== null) {
            if (ws === '/overview') return json(res,200,{ projects: courses.length, videos: videos.length, licenses: licenses.length, students: students.length, activeActivations: 1, openRequests: 0 });
            if (ws === '/account') return json(res,200,{ email:'fixture@example.invalid', name:'Productor de prueba', quotas:{ maxLicenses:20, maxDevices:2, maxStudents:0 }, usage:{ licensesUsed: licenses.length, studentsUsed: students.length }, mail:{ configured:false, provider:'Resend' }, features:{ automaticBilling:false, globalBlacklist:false } });
            if (ws === '/projects') return json(res,200,{ projects: courses.map(c => ({ ...c, settings: courseSettings.get(c.id) || { purchaseUrl: null, description: '', embedOrigins: [] }, modules: modules.filter(m => m.courseId === c.id).map(m => ({ playlistCode: null, playlistUrl: m.playlistPublished ? '/playlist/fixture-' + m.id : null, ...m })), videos: videos.filter(v => v.courseId === c.id) })), unassignedVideos: videos.filter(v => !v.courseId) });
            const courseRoute = ws.match(/^\/courses\/([^/]+)$/);
            if (courseRoute) { const c = courses.find(x => x.id === courseRoute[1]); if (!c) return json(res, 404, { error: 'Contenido no encontrado.', code: 'CONTENT_NOT_FOUND' }); if (req.method === 'DELETE') { if (modules.some(m => m.courseId === c.id) || videos.some(v => v.courseId === c.id)) return json(res, 409, { error: 'Primero mueve o elimina los elementos asociados.', code: 'CONTENT_HAS_DEPENDENCIES' }); courses.splice(courses.indexOf(c), 1); return json(res, 200, { ok: true }); } const input = JSON.parse(await readBody(req)); if (input.name) c.name = input.name; if (input.author !== undefined) c.author = input.author; if (input.settings) courseSettings.set(c.id, { ...(courseSettings.get(c.id) || {}), ...input.settings }); return json(res, 200, { course: { ...c, settings: courseSettings.get(c.id) } }); }
            const moduleRoute = ws.match(/^\/modules\/([^/]+)$/);
            if (moduleRoute) { const m = modules.find(x => x.id === moduleRoute[1]); if (!m) return json(res, 404, { error: 'Contenido no encontrado.', code: 'CONTENT_NOT_FOUND' });
                if (req.method === 'DELETE') { if (modules.some(x => x.parentId === m.id) || videos.some(v => v.moduleId === m.id) || m.attachments) return json(res, 409, { error: 'Primero mueve o elimina los elementos asociados. Las licencias y accesos existentes se conservan.', code: 'CONTENT_HAS_DEPENDENCIES', dependencies: { videos: videos.filter(v => v.moduleId === m.id).length } }); modules.splice(modules.indexOf(m), 1); return json(res, 200, { ok: true }); }
                const input = JSON.parse(await readBody(req));
                if (Object.prototype.hasOwnProperty.call(input, 'parentId')) { const parent = input.parentId ? modules.find(x => x.id === input.parentId) : null; if (input.parentId && !parent) return json(res, 404, { error: 'Contenido no encontrado.', code: 'CONTENT_NOT_FOUND' }); let cursor = parent; while (cursor) { if (cursor.id === m.id) return json(res, 409, { error: 'Un módulo no puede quedar dentro de sí mismo o de un descendiente.', code: 'CONTENT_MODULE_CYCLE' }); cursor = modules.find(x => x.id === cursor.parentId); } m.parentId = input.parentId || null; }
                if (input.name) m.name = input.name; if (typeof input.playlistPublished === 'boolean') m.playlistPublished = input.playlistPublished;
                return json(res, 200, { module: { playlistUrl: m.playlistPublished ? '/playlist/fixture-' + m.id : null, ...m } }); }
            const videoRoute = ws.match(/^\/videos\/([^/]+)$/);
            if (videoRoute) { const v = videos.find(x => x.videoId === videoRoute[1]); if (!v) return json(res, 404, { error: 'Contenido no encontrado.', code: 'CONTENT_NOT_FOUND' });
                if (req.method === 'DELETE') { videos.splice(videos.indexOf(v), 1); return json(res, 200, { ok: true, providerFilesDeleted: false }); }
                const input = JSON.parse(await readBody(req)); let providerWarning = null;
                if (Object.prototype.hasOwnProperty.call(input, 'moduleId') && v.title.includes('FALLA-MOVER')) return json(res, 502, { error: 'Fallo simulado al mover la clase.', code: 'FIXTURE_MOVE_FAILED' });
                if (Object.prototype.hasOwnProperty.call(input, 'moduleId')) { if (input.moduleId && !modules.some(m => m.id === input.moduleId && m.courseId === v.courseId)) return json(res, 409, { error: 'El módulo debe pertenecer al curso seleccionado.', code: 'CONTENT_MODULE_COURSE_MISMATCH' }); if ((input.moduleId || null) !== (v.moduleId || null)) { v.moduleId = input.moduleId || null; v.sortOrder = 999; if (url.searchParams.get('bunnyFail') || v.title.includes('FALLA-BUNNY')) { v.collectionSyncPending = true; providerWarning = 'La clase se movió en Edulock. La colección de Bunny no se pudo actualizar ahora y se reintentará automáticamente.'; } else v.collectionSyncPending = false; } }
                if (input.title) v.title = input.title; if (input.presentation) v.presentation = { ...v.presentation, ...input.presentation };
                return json(res, 200, { video: { ...v, providerWarning } }); }
            if (ws === '/reorder' && req.method === 'POST') { const input = JSON.parse(await readBody(req)); if ((input.ids || []).some(id => videos.find(x => x.videoId === id)?.title.includes('FALLA-ORDEN'))) return json(res, 500, { error: 'Fallo simulado al guardar el orden.' }); const isModules = input.kind === 'modules'; const key = isModules ? 'parentId' : 'moduleId'; const scoped = Object.prototype.hasOwnProperty.call(input, key);
                const list = (isModules ? modules : videos).filter(item => item.courseId === input.courseId && (!scoped || (item[key] || null) === (input[key] || null))); const ids = new Set(list.map(item => isModules ? item.id : item.videoId));
                if (ids.size !== input.ids.length || input.ids.some(id => !ids.has(id))) return json(res, 409, { error: 'El contenido cambió. Actualiza la lista y vuelve a ordenar.', code: 'CONTENT_ORDER_CHANGED' });
                input.ids.forEach((id, index) => { const item = list.find(item => (isModules ? item.id : item.videoId) === id); item.sortOrder = (index + 1) * 10; }); return json(res, 200, { ok: true, kind: input.kind, count: input.ids.length }); }
            if (ws === '/lots') return json(res,200,{ lots: lots.map(lot => { const own = licenses.filter(l => l.lotId === lot.id); const c = counts(own); return { ...lot, total: c.total, availableCount: c.available, freeCount: c.available, reservedCount: c.reserved, inUseCount: c.inUse, activeCount: c.inUse, suspendedCount: c.suspended, revokedCount: c.revoked, exportableCount: own.filter(l => l.serial).length }; }) });
            if (ws === '/licenses' && req.method === 'GET') {
                const status = url.searchParams.get('status') || '', lotId = url.searchParams.get('lotId') || '', q = (url.searchParams.get('q') || '').toLowerCase();
                const scoped = licenses.filter(l => (!lotId || l.lotId === lotId));
                const list = scoped.filter(l => (!status || l.availability === status) && (!q || String(l.serial || '').toLowerCase().includes(q) || String(l.studentEmail || l.customerEmail || '').toLowerCase().includes(q)));
                return json(res,200,{ licenses: list.map(view), total: list.length, page: 1, pageSize: 30, counts: counts(scoped) });
            }
            const licenseId = ws.match(/^\/licenses\/([^/]+)(\/[a-z]+)?$/);
            if (licenseId) {
                const license = licenses.find(l => l.id === licenseId[1]);
                if (!license) return json(res,404,{ error:'Licencia no encontrada.', code:'LICENSE_NOT_FOUND' });
                if (licenseId[2] === '/activations') return json(res,200,{ activations: activations.filter(a => a.licenseId === license.id) });
                if (licenseId[2] === '/key') return license.serial ? json(res,200,{ key: license.serial }) : json(res,409,{ error:'Clave histórica no recuperable.', code:'LICENSE_SERIAL_UNAVAILABLE' });
                if (licenseId[2] === '/status') { const input = JSON.parse(await readBody(req)); license.status = input.status === 'active' ? (license.studentId ? 'active' : 'free') : input.status; license.availability = license.status === 'suspended' ? 'suspended' : license.status === 'revoked' ? 'revoked' : license.studentId ? 'in_use' : 'available'; return json(res,200,{ ok:true, licenseId: license.id, status: license.status }); }
                if (licenseId[2] === '/reissue') { license.serial = fakeKey(900 + (++counter)); return json(res,200,{ ok:true, licenseId: license.id, key: license.serial, reissued: true }); }
                if (req.method === 'PATCH') { const input = JSON.parse(await readBody(req)); if (Object.keys(input).some(k => k !== 'customerEmail')) return json(res,400,{ error:'Campo no editable', code:'FIELD_NOT_EDITABLE' }); license.customerEmail = input.customerEmail || null; license.availability = license.customerEmail ? 'reserved' : 'available'; return json(res,200,{ ok:true, license: view(license) }); }
            }
            const lotRoute = ws.match(/^\/lots\/([^/]+)\/(serials|export\.csv)$/);
            if (lotRoute) {
                const own = licenses.filter(l => l.lotId === lotRoute[1] && (url.searchParams.get('scope') !== 'available' || l.availability === 'available'));
                if (lotRoute[2] === 'serials') return json(res,200,{ lotId: lotRoute[1], scope: url.searchParams.get('scope') || 'available', serials: own.map(l => l.serial).filter(Boolean) });
                res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' }); return res.end('serial,licenseId,availability,status,customerEmail,maxDevices\r\n' + own.map(l => `"${l.serial}","${l.id}","${l.availability}","${l.status}","",2`).join('\r\n'));
            }
            const activationRoute = ws.match(/^\/activations\/([^/]+)\/(reset|block|unblock)$/);
            if (activationRoute) { const a = activations.find(x => x.id === activationRoute[1]); if (!a) return json(res,404,{ error:'Activación no encontrada.' }); if (activationRoute[2] === 'block') a.blocked = true; if (activationRoute[2] === 'unblock') a.blocked = false; if (activationRoute[2] !== 'unblock') a.status = 'revoked'; return json(res,200,{ ok:true }); }
            if (ws === '/students') {
                const q = (url.searchParams.get('q') || '').toLowerCase();
                const list = students.filter(s => !q || s.email.includes(q) || s.name.toLowerCase().includes(q)).map(s => { const own = licenses.filter(l => l.studentId === s.id); return { id: s.id, name: s.name, email: s.email, active: s.active, courses: [...new Set(own.map(l => courses.find(c => c.id === l.courseId)?.name).filter(Boolean))], licenseCount: own.length, activeLicenses: own.filter(l => l.status === 'active').length, suspendedLicenses: own.filter(l => l.status === 'suspended').length, revokedLicenses: 0, activeActivations: activations.filter(a => own.some(l => l.id === a.licenseId) && a.status === 'active').length, lastActivity: now, firstAssignedAt: now }; });
                return json(res,200,{ students: list, total: list.length, page: 1, pageSize: 30 });
            }
            const studentRoute = ws.match(/^\/students\/([^/]+)$/);
            if (studentRoute) {
                const s = students.find(x => x.id === studentRoute[1]); if (!s) return json(res,404,{ error:'Este alumno no tiene licencias de tu cuenta.', code:'STUDENT_NOT_FOUND' });
                return json(res,200,{ student: s, licenses: licenses.filter(l => l.studentId === s.id).map(l => ({ ...view(l), activations: activations.filter(a => a.licenseId === l.id) })) });
            }
            if (ws === '/storage') return json(res,200,{ items: [], total: 0, knownBytes: 0, unknownSizeCount: 0, capacityBytes: null });
            if (ws === '/integrations') return json(res,200,{ keys: [], claimUrl: 'http://127.0.0.1:49310/api/integrations/claim-license', mailConfigured: false });
            if (ws === '/deliveries') return json(res,200,{ deliveries: [], configured: false });
            if (ws === '/service-requests') return json(res,200,{ requests: [] });
            if (ws === '/security-events') return json(res,200,{ events: [] });
        }
        json(res,404,{ error:'Ruta no incluida en el entorno de prueba.' });
    } catch (error) { json(res,500,{ error:error.message }); }
});
server.listen(49310,'127.0.0.1',() => console.log('Synthetic frontend fixture at http://127.0.0.1:49310/productor'));
