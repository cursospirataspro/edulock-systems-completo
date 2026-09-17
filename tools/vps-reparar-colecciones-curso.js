// Herramienta de operación: ejecutar en el VPS desde /opt/reproductor con NODE_PATH=/opt/reproductor/node_modules node <archivo>. Solo lectura salvo que el nombre indique reparación o prueba; nunca imprime claves.
// Reparación de solo la asociación afectada: biblioteca ya existente (755206) + colecciones de los 2 módulos de Octavio.
// No crea bibliotecas nuevas, no toca videos, no imprime claves.
process.chdir('/opt/reproductor');
require('dotenv').config({ path: '/opt/reproductor/.env' });
const db = require('/opt/reproductor/database-pg.js');
const { createStreamService } = require('/opt/reproductor/lib/stream-service.js');
(async () => {
  const svc = createStreamService({ db, getAccountKey: async () => (await db.getConfig('bunny_account_key')) || '', createKey: async () => 'unused-for-collections', logger: console });
  const courseId = process.argv[2] || '53aeed8e-973e-48f9-8557-4d516cdeaf61';
  const lib = await svc.ensureCourseLibrary({ courseId, actor: { admin: true } });
  console.log('library', JSON.stringify({ libraryId: lib.libraryId, pullZone: lib.pullZone, hasToken: !!lib.tokenKey, drm: lib.drm }));
  for (const moduleId of (await db.pool.query('select id from modules where course_id=$1', [courseId])).rows.map(r => r.id)) {
    try { const id = await svc.ensureModuleCollection({ courseId, moduleId, actor: { admin: true } }); console.log('module', moduleId, '-> collection', id); }
    catch (e) { console.log('module', moduleId, 'FAILED', e.code, e.stage, e.provider || '', e.message); }
  }
  const rows = (await db.pool.query("select id,name,bunny_collection_id from modules where course_id=$1", [courseId])).rows;
  console.log('modules in db', JSON.stringify(rows));
  const res = (await db.pool.query("select resource_key,state,remote_id from stream_resources where resource_key like 'module:%' or resource_key like 'course:%' order by updated_at desc")).rows;
  console.log('stream_resources', JSON.stringify(res));
  const ops = (await db.pool.query("select id,state,error_code,error_detail from stream_operations where course_id=$1", [courseId])).rows;
  console.log('operations', JSON.stringify(ops));
  await db.pool.end();
})().catch(e => { console.error('repair error', e.code, e.stage, e.message); process.exit(1); });
