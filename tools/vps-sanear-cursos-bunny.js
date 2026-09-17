// Saneamiento Bunny para TODOS los cursos con biblioteca: biblioteca confirmada, colección por módulo y cada video de Bunny dentro de la colección de su módulo.
// Idempotente. No crea bibliotecas para cursos que nunca la tuvieron (eso ocurre al subir la primera clase). No borra nada. No imprime claves.
process.chdir('/opt/reproductor'); require('dotenv').config({ path: '/opt/reproductor/.env' });
const https = require('https');
const db = require('/opt/reproductor/database-pg.js');
const { createStreamService } = require('/opt/reproductor/lib/stream-service.js');
function call(method, host, path, key, body) { return new Promise(res => { const payload = body === undefined ? null : Buffer.from(JSON.stringify(body)); const headers = { AccessKey: key, Accept: 'application/json' }; if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; } const r = https.request({ method, hostname: host, path, headers, timeout: 20000 }, x => { let b = ''; x.on('data', c => b += c); x.on('end', () => res({ status: x.statusCode, body: b })); }); r.on('error', e => res({ status: 0, body: e.message })); r.end(payload || undefined); }); }
(async () => {
  const svc = createStreamService({ db, getAccountKey: async () => (await db.getConfig('bunny_account_key')) || '', createKey: async () => 'unused', logger: console });
  const courses = (await db.pool.query("SELECT id, name, producer_id FROM courses WHERE bunny_library_id IS NOT NULL ORDER BY created_at")).rows;
  const summary = [];
  for (const c of courses) {
    const line = { course: c.name, producer: c.producer_id || '(admin)', library: null, modules: 0, collectionsCreated: 0, videosMoved: 0, errors: [] };
    try {
      const lib = await svc.ensureCourseLibrary({ courseId: c.id, actor: { admin: true } });
      line.library = lib.libraryId + (lib.drm ? ' (DRM)' : '');
      const modules = (await db.pool.query("SELECT id, name, bunny_collection_id FROM modules WHERE course_id=$1", [c.id])).rows;
      line.modules = modules.length;
      for (const m of modules) {
        const before = m.bunny_collection_id;
        try { const id = await svc.ensureModuleCollection({ courseId: c.id, moduleId: m.id, actor: { admin: true } }); if (!before || before !== id) line.collectionsCreated++; }
        catch (e) { line.errors.push(`módulo ${m.name}: ${e.code} ${e.stage || ''} ${e.provider?.message || e.message}`); }
      }
      const videos = (await db.pool.query("SELECT video_id, title, module_id, bunny_url FROM catalog WHERE course_id=$1 AND source_type='bunny' AND module_id IS NOT NULL", [c.id])).rows;
      for (const v of videos) {
        const collectionId = await db.getModuleBunnyCollection(v.module_id);
        if (!collectionId) continue;
        // Videos antiguos: el GUID de Bunny vive en la URL (cifrada en la base; se lee descifrada), no en video_id.
        const entry = await db.getCatalogById(v.video_id);
        const guid = (String(entry?.bunnyUrl || '').match(/\/([0-9a-f-]{36})\//i) || [])[1] || v.video_id;
        const remote = await call('GET', 'video.bunnycdn.com', `/library/${lib.libraryId}/videos/${guid}`, lib.libraryKey);
        if (remote.status !== 200) { line.errors.push(`video ${v.title}: GET ${remote.status}`); continue; }
        const current = JSON.parse(remote.body).collectionId || '';
        if (current !== collectionId) {
          const upd = await call('POST', 'video.bunnycdn.com', `/library/${lib.libraryId}/videos/${guid}`, lib.libraryKey, { collectionId });
          if (upd.status === 200) line.videosMoved++; else line.errors.push(`video ${v.title}: POST ${upd.status}`);
        }
      }
    } catch (e) { line.errors.push(`curso: ${e.code} ${e.stage || ''} ${e.provider?.message || e.message}`); }
    summary.push(line);
  }
  console.log(JSON.stringify(summary, null, 1));
  await db.pool.end();
})().catch(e => { console.error('error', e.message); process.exit(1); });
