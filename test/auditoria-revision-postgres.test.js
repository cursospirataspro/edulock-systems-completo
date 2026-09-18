'use strict';
// Segunda revisión: defectos que quedaron en la primera corrección.
// Todo contra PostgreSQL real, en una base QA desechable.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

let databaseName = '';
try { databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL || '').pathname.slice(1)); } catch {}
const allowed = /^edulock_qa(?:_[a-zA-Z0-9-]+)*$/;
if (!allowed.test(databaseName)) { console.error('REFUSED: estas pruebas requieren una base QA llamada edulock_qa*.'); process.exit(1); }

const db = require('../database-pg');
const { createStreamService } = require('../lib/stream-service');

const creados = [];
const nuevoProductor = () => { const id = randomUUID(); creados.push(id); return id; };

before(async () => {
    const actual = (await db.pool.query('SELECT current_database() AS name')).rows[0].name;
    assert.match(actual, allowed);
    await db.initDb();
});
after(async () => {
    if (creados.length) {
        for (const tabla of ['provider_deletions', 'protected_resources', 'catalog', 'modules', 'courses', 'producers']) {
            const col = tabla === 'producers' ? 'id' : 'producer_id';
            await db.pool.query(`DELETE FROM ${tabla} WHERE ${col} = ANY($1)`, [creados]).catch(() => {});
        }
    }
    await db.pool.end();
});

async function escenario({ conClase = true } = {}) {
    const producerId = nuevoProductor();
    const courseId = randomUUID(), moduleId = randomUUID(), videoId = randomUUID();
    await db.pool.query('INSERT INTO producers(id,email,password_hash,name,active,created_at) VALUES($1,$2,$3,$4,1,NOW())',
        [producerId, 'qa-rev-' + producerId + '@edulock.invalid', 'sin-uso', 'QA revisión']);
    await db.pool.query('INSERT INTO courses(id,name,producer_id,created_at) VALUES($1,$2,$3,NOW())',
        [courseId, 'Curso QA revisión', producerId]);
    await db.pool.query('INSERT INTO modules(id,course_id,name,producer_id,sort_order,created_at) VALUES($1,$2,$3,$4,0,NOW())',
        [moduleId, courseId, 'Módulo QA revisión', producerId]);
    await db.setCourseBunnyLibrary(courseId, { libraryId: '555000', libraryKey: 'clave-sintetica' });
    await db.setModuleBunnyCollection(moduleId, 'col-rev');
    await db.setStreamResource('module:' + moduleId, { remoteName: 'Módulo QA revisión', state: 'ready', remoteId: 'col-rev' });
    await db.setStreamResource('course:' + courseId, { remoteName: 'Curso QA revisión', state: 'ready', remoteId: '555000' });
    if (conClase) {
        await db.pool.query(`INSERT INTO catalog(video_id,title,status,source_type,course_id,module_id,producer_id,uploaded_at)
            VALUES($1,$2,'ready','bunny',$3,$4,$5,NOW())`, [videoId, 'Clase QA', courseId, moduleId, producerId]);
    }
    return { producerId, courseId, moduleId, videoId };
}

// ── El punto bloqueante: conservar clases y borrar su biblioteca ─────────────
test('borrar un curso desde admin NO programa borrar la biblioteca si sus clases se conservan', async () => {
    const e = await escenario({ conClase: true });
    const resultado = await db.deleteCourse(e.courseId);
    assert.equal(resultado.deleted, true);
    assert.equal(resultado.queuedDeletions.length, 0,
        'no puede encolarse ningún borrado remoto mientras la clase sigue en el catálogo');
    assert.ok(resultado.providerKept >= 1);
    assert.match(resultado.providerNote || '', /se conservan/);
    // La clase sigue viva y sin curso, que es el comportamiento del panel de admin.
    const clase = (await db.pool.query('SELECT course_id FROM catalog WHERE video_id=$1', [e.videoId])).rows[0];
    assert.ok(clase, 'la clase se conserva');
    assert.equal(clase.course_id, null);
    // Y nada quedó encolado contra esa biblioteca.
    const encolados = Number((await db.pool.query('SELECT COUNT(*) n FROM provider_deletions WHERE course_id=$1', [e.courseId])).rows[0].n);
    assert.equal(encolados, 0);
});

test('un curso sin clases sí borra su biblioteca y sus colecciones', async () => {
    const e = await escenario({ conClase: false });
    const resultado = await db.deleteCourse(e.courseId);
    assert.equal(resultado.deleted, true);
    assert.equal(resultado.queuedDeletions.length, 2, 'la colección del módulo y la biblioteca del curso');
    const filas = (await db.pool.query('SELECT kind FROM provider_deletions WHERE course_id=$1 ORDER BY kind', [e.courseId])).rows;
    assert.deepEqual(filas.map(f => f.kind), ['course', 'module']);
});

test('borrar un módulo desde admin no borra su colección si sus clases se conservan', async () => {
    const e = await escenario({ conClase: true });
    const resultado = await db.deleteModule(e.moduleId);
    assert.ok(resultado.deleted.includes(e.moduleId));
    assert.equal(resultado.queuedDeletions.length, 0);
    assert.ok(resultado.providerKept >= 1);
    const clase = (await db.pool.query('SELECT module_id FROM catalog WHERE video_id=$1', [e.videoId])).rows[0];
    assert.ok(clase && clase.module_id === null, 'la clase se conserva sin módulo');
});

// ── Movimiento atómico y coordinado ─────────────────────────────────────────
test('mover una clase entre cursos es una sola operación y arrastra sus documentos', async () => {
    const e = await escenario({ conClase: true });
    const segundo = randomUUID();
    await db.pool.query('INSERT INTO courses(id,name,producer_id,created_at) VALUES($1,$2,$3,NOW())',
        [segundo, 'Curso destino', e.producerId]);
    const recurso = randomUUID();
    // Un recurso de enlace publico: la tabla exige public_url o storage_key, no ambos.
    await db.pool.query(`INSERT INTO protected_resources(id,target_kind,target_id,course_id,producer_id,name,type,protection,public_url,created_at,updated_at)
        VALUES($1,'video',$2,$3,$4,'Guía','link','public','https://ejemplo.test/guia.pdf',$5,$5)`,
        [recurso, e.videoId, e.courseId, e.producerId, new Date().toISOString()]);

    const resultado = await db.moveVideo(e.videoId, segundo);
    assert.equal(resultado.courseId, segundo);
    assert.equal(resultado.moduleId, null, 'un módulo del curso anterior no existe en el destino');
    assert.equal(resultado.resourcesMoved, 1);
    const doc = (await db.pool.query('SELECT course_id FROM protected_resources WHERE id=$1', [recurso])).rows[0];
    assert.equal(doc.course_id, segundo, 'el documento no puede quedarse en el curso anterior');
    await db.pool.query('DELETE FROM protected_resources WHERE id=$1', [recurso]);
    await db.pool.query('DELETE FROM courses WHERE id=$1', [segundo]);
});

test('si el módulo de destino no pertenece al curso, no se aplica ningún cambio', async () => {
    const e = await escenario({ conClase: true });
    const otro = randomUUID(), moduloAjeno = randomUUID();
    await db.pool.query('INSERT INTO courses(id,name,producer_id,created_at) VALUES($1,$2,$3,NOW())', [otro, 'Otro curso', e.producerId]);
    await db.pool.query('INSERT INTO modules(id,course_id,name,producer_id,sort_order,created_at) VALUES($1,$2,$3,$4,0,NOW())',
        [moduloAjeno, otro, 'Módulo ajeno', e.producerId]);

    await assert.rejects(() => db.moveVideo(e.videoId, e.courseId, moduloAjeno), { code: 'MODULE_COURSE_MISMATCH' });
    // Lo decisivo: la clase NO puede haberse movido a medias.
    const clase = (await db.pool.query('SELECT course_id, module_id FROM catalog WHERE video_id=$1', [e.videoId])).rows[0];
    assert.equal(clase.course_id, e.courseId, 'el curso no puede haber cambiado');
    assert.equal(clase.module_id, e.moduleId, 'el módulo no puede haber cambiado');
    await db.pool.query('DELETE FROM modules WHERE id=$1', [moduloAjeno]);
    await db.pool.query('DELETE FROM courses WHERE id=$1', [otro]);
});

// ── Borrado de clase desde admin, por la cola ───────────────────────────────
test('borrar una clase desde admin encola el borrado de su video cuando lo creó esta plataforma', async () => {
    const e = await escenario({ conClase: true });
    const operacion = randomUUID();
    await db.reserveStreamOperation({ id: operacion, actorKey: 'admin', courseId: e.courseId, moduleId: e.moduleId,
        title: 'Clase QA', fileSize: 10, fileSha256: 'c'.repeat(64) });
    await db.updateStreamOperation(operacion, { videoId: e.videoId, state: 'ready' });
    await db.setStreamResource('upload:' + operacion, { remoteName: 'Clase QA', state: 'ready', remoteId: e.videoId });

    const resultado = await db.deleteCatalogEntryWithProvider(e.videoId);
    assert.equal(resultado.deleted, true);
    assert.equal(resultado.queuedDeletions.length, 1);
    const fila = (await db.pool.query('SELECT kind, remote_id FROM provider_deletions WHERE video_id=$1', [e.videoId])).rows[0];
    assert.equal(fila.kind, 'video');
    assert.equal(fila.remote_id, e.videoId);
    assert.equal((await db.pool.query('SELECT 1 FROM catalog WHERE video_id=$1', [e.videoId])).rowCount, 0);
    await db.pool.query('DELETE FROM stream_operations WHERE id=$1', [operacion]).catch(() => {});
});

test('borrar una clase ajena desde admin no encola nada en el proveedor', async () => {
    const e = await escenario({ conClase: true });
    const resultado = await db.deleteCatalogEntryWithProvider(e.videoId);
    assert.equal(resultado.deleted, true);
    assert.equal(resultado.queuedDeletions.length, 0);
    assert.match(resultado.providerNote || '', /no lo creó esta plataforma|clave/);
});
