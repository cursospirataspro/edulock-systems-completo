'use strict';
// F02 y R02 contra PostgreSQL real: el borrado en el servicio de video se decide
// con las filas todavía vivas, se anota en la misma transacción y se ejecuta
// después desde una cola duradera que sobrevive a fallos y reinicios.
// Solo se ejecuta contra una base QA desechable y borra únicamente lo que crea.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

let databaseName = '';
try { databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL || '').pathname.slice(1)); } catch {}
const allowed = /^edulock_qa(?:_[a-zA-Z0-9-]+)*$/;
if (!allowed.test(databaseName)) { console.error('REFUSED: estas pruebas requieren una base QA llamada edulock_qa*.'); process.exit(1); }

const db = require('../database-pg');
const { createProducerContent } = require('../lib/producer-content');
const { createStreamService } = require('../lib/stream-service');

const creados = [];
const nuevoProductor = () => { const id = randomUUID(); creados.push(id); return id; };

before(async () => {
    const actual = (await db.pool.query('SELECT current_database() AS name')).rows[0].name;
    assert.match(actual, allowed, 'no se ejecuta fuera de una base QA desechable');
    await db.initDb();
});
after(async () => {
    if (creados.length) {
        await db.pool.query('DELETE FROM provider_deletions WHERE producer_id = ANY($1)', [creados]);
        await db.pool.query('DELETE FROM catalog WHERE producer_id = ANY($1)', [creados]);
        await db.pool.query('DELETE FROM modules WHERE producer_id = ANY($1)', [creados]);
        await db.pool.query('DELETE FROM courses WHERE producer_id = ANY($1)', [creados]);
        await db.pool.query('DELETE FROM producers WHERE id = ANY($1)', [creados]);
    }
    await db.pool.end();
});

/** Servicio de video simulado: anota cada borrado que recibe y puede fallar a voluntad. */
function proveedorSimulado({ fallaHasta = 0, faltante = false } = {}) {
    const borrados = [];
    let intentos = 0;
    const transport = {
        async json(method, host, path, key, body) {
            if (method === 'DELETE') {
                intentos++;
                if (intentos <= fallaHasta) { const e = new Error('red caída'); e.httpStatus = 502; throw e; }
                if (faltante) { const e = new Error('no existe'); e.httpStatus = 404; throw e; }
                borrados.push({ host, path });
                return {};
            }
            return {};
        },
        async upload() { return {}; },
    };
    return { transport, borrados, intentos: () => intentos };
}

async function escenario({ proveedor }) {
    const producerId = nuevoProductor();
    const courseId = randomUUID(), moduleId = randomUUID();
    await db.pool.query('INSERT INTO producers(id,email,password_hash,name,active,created_at) VALUES($1,$2,$3,$4,1,NOW())',
        [producerId, 'qa-f02-' + producerId + '@edulock.invalid', 'sin-uso', 'QA F02']);
    await db.pool.query('INSERT INTO courses(id,name,producer_id,created_at) VALUES($1,$2,$3,NOW())',
        [courseId, 'Curso QA borrado', producerId]);
    await db.pool.query('INSERT INTO modules(id,course_id,name,producer_id,sort_order,created_at) VALUES($1,$2,$3,$4,0,NOW())',
        [moduleId, courseId, 'Modulo QA borrado', producerId]);
    await db.setCourseBunnyLibrary(courseId, { libraryId: '987654', libraryKey: 'clave-sintetica-de-prueba' });
    await db.setModuleBunnyCollection(moduleId, 'coleccion-remota-123');
    // Procedencia: esta plataforma creó esa colección y esa biblioteca.
    await db.setStreamResource('module:' + moduleId, { remoteName: 'Modulo QA borrado', state: 'ready', remoteId: 'coleccion-remota-123' });
    await db.setStreamResource('course:' + courseId, { remoteName: 'Curso QA borrado', state: 'ready', remoteId: '987654' });

    const stream = createStreamService({ db, transport: proveedor.transport,
        getAccountKey: async () => 'clave-de-cuenta', createKey: async () => ({ keyId: 'clave-hls' }) });
    const content = createProducerContent({ db,
        generatePublicCode: () => 'EDU-' + randomUUID().slice(0, 8).toUpperCase(),
        describeProviderAsset: args => stream.describeProviderAsset(args),
        runProviderDeletions: args => stream.runProviderDeletions(args) });
    return { producerId, courseId, moduleId, stream, content };
}

test('F02: borrar un módulo sí borra su colección en el servicio de video', async () => {
    const proveedor = proveedorSimulado();
    const { producerId, moduleId, content } = await escenario({ proveedor });
    const resultado = await content.remove(producerId, 'module', moduleId);
    assert.equal(resultado.ok, true);
    assert.equal(resultado.providerFilesDeleted, true, 'la colección debe haberse borrado de verdad');
    assert.equal(proveedor.borrados.length, 1);
    assert.match(proveedor.borrados[0].path, /\/library\/987654\/collections\/coleccion-remota-123$/);
});

test('F02: borrar un curso sí borra su biblioteca', async () => {
    const proveedor = proveedorSimulado();
    const { producerId, courseId, moduleId, content } = await escenario({ proveedor });
    await db.pool.query('DELETE FROM modules WHERE id=$1', [moduleId]);   // el curso debe quedar vacío
    const resultado = await content.remove(producerId, 'course', courseId);
    assert.equal(resultado.providerFilesDeleted, true);
    assert.match(proveedor.borrados[0].path, /\/videolibrary\/987654$/);
});

test('F02: si el servicio de video falla, el pendiente queda en la cola y se reintenta solo', async () => {
    const proveedor = proveedorSimulado({ fallaHasta: 1 });
    const { producerId, moduleId, content, stream } = await escenario({ proveedor });
    const resultado = await content.remove(producerId, 'module', moduleId);
    assert.equal(resultado.providerFilesDeleted, false);
    assert.match(resultado.providerWarning || '', /pendiente/);
    assert.equal(proveedor.borrados.length, 0, 'todavía no se ha borrado nada en el proveedor');

    // El pendiente sigue anotado y le toca más tarde: se adelanta su turno como
    // haría el paso del tiempo, y el proceso periódico lo termina.
    await db.pool.query("UPDATE provider_deletions SET next_attempt_at = NOW() - INTERVAL '1 hour' WHERE state='pending'");
    const resumen = await stream.runProviderDeletions({ limit: 5 });
    assert.equal(resumen.done, 1, 'el reintento debe completar el borrado');
    assert.equal(proveedor.borrados.length, 1);
});

test('F02: el pendiente sobrevive a un reinicio porque está en la base, no en memoria', async () => {
    const proveedor = proveedorSimulado({ fallaHasta: 1 });
    const { producerId, moduleId, content } = await escenario({ proveedor });
    await content.remove(producerId, 'module', moduleId);
    const fila = (await db.pool.query('SELECT id,kind,state,library_id,remote_id FROM provider_deletions WHERE module_id=$1', [moduleId])).rows[0];
    assert.ok(fila, 'el borrado pendiente debe estar guardado en la base');
    assert.equal(fila.state, 'pending');
    assert.equal(fila.kind, 'module');
    assert.equal(fila.library_id, '987654');
    assert.equal(fila.remote_id, 'coleccion-remota-123');

    // Un proceso nuevo (como tras reiniciar el servidor) recoge el mismo pendiente.
    const otroProveedor = proveedorSimulado();
    const otroStream = createStreamService({ db, transport: otroProveedor.transport,
        getAccountKey: async () => 'clave-de-cuenta', createKey: async () => ({ keyId: 'clave-hls' }) });
    await db.pool.query("UPDATE provider_deletions SET next_attempt_at = NOW() - INTERVAL '1 hour' WHERE id=$1", [fila.id]);
    const resumen = await otroStream.runProviderDeletions({ limit: 5 });
    assert.ok(resumen.done >= 1, 'el proceso nuevo debe terminar el borrado pendiente');
});

test('F02: si el recurso ya no estaba, se cierra como hecho y no se reintenta para siempre', async () => {
    const proveedor = proveedorSimulado({ faltante: true });
    const { producerId, moduleId, content } = await escenario({ proveedor });
    const resultado = await content.remove(producerId, 'module', moduleId);
    assert.equal(resultado.providerFilesDeleted, false);
    assert.match(resultado.providerNote || '', /ya no estaba/);
    const fila = (await db.pool.query('SELECT state FROM provider_deletions WHERE module_id=$1', [moduleId])).rows[0];
    assert.equal(fila.state, 'gone');
});

test('R02: no se borra un video que esta plataforma no creó', async () => {
    const proveedor = proveedorSimulado();
    const { producerId, courseId, moduleId, content } = await escenario({ proveedor });
    const videoId = randomUUID();
    await db.pool.query(`INSERT INTO catalog(video_id,title,status,source_type,course_id,module_id,producer_id,uploaded_at)
        VALUES($1,$2,'ready','bunny',$3,$4,$5,NOW())`, [videoId, 'Clase ajena', courseId, moduleId, producerId]);
    // No hay ningún registro de que esta plataforma lo haya creado.
    const resultado = await content.remove(producerId, 'video', videoId);
    assert.equal(resultado.ok, true, 'el contenido local sí se quita del catálogo');
    assert.equal(resultado.providerFilesDeleted, false);
    assert.match(resultado.providerNote || '', /no lo creo esta plataforma/);
    assert.equal(proveedor.borrados.length, 0, 'no se puede tocar un video ajeno');
    assert.equal((await db.pool.query('SELECT COUNT(*) n FROM provider_deletions WHERE video_id=$1', [videoId])).rows[0].n, '0');
});

test('R02: sí se borra el video cuando consta que lo creó esta plataforma', async () => {
    const proveedor = proveedorSimulado();
    const { producerId, courseId, moduleId, content } = await escenario({ proveedor });
    const videoId = randomUUID(), operationId = randomUUID();
    await db.pool.query(`INSERT INTO catalog(video_id,title,status,source_type,course_id,module_id,producer_id,uploaded_at)
        VALUES($1,$2,'ready','bunny',$3,$4,$5,NOW())`, [videoId, 'Clase propia', courseId, moduleId, producerId]);
    await db.reserveStreamOperation({ id: operationId, actorKey: 'producer:' + producerId, courseId, moduleId,
        title: 'Clase propia', fileSize: 10, fileSha256: 'a'.repeat(64) });
    await db.updateStreamOperation(operationId, { videoId, state: 'ready' });
    await db.setStreamResource('upload:' + operationId, { remoteName: 'Clase propia', state: 'ready', remoteId: videoId });

    const resultado = await content.remove(producerId, 'video', videoId);
    assert.equal(resultado.providerFilesDeleted, true);
    assert.equal(proveedor.borrados.length, 1);
    assert.match(proveedor.borrados[0].path, new RegExp('/library/987654/videos/' + videoId + '$'));
});
