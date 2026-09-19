'use strict';
/*
 * Pruebas del recolector de consumo y costos.
 *
 * Se centran en los errores que costarían dinero o confianza: presentar un
 * reparto como si fuera una factura, enseñar un cero cuando lo que pasa es que
 * no se pudo leer, repartir entre clientes un consumo que no es suyo, filtrar
 * la clave de la cuenta en un mensaje de error, o recolectar dos veces a la vez
 * y contar el doble.
 *
 * No necesitan base de datos ni red: se inyecta un `pool` y un `peticion` de
 * mentira que devuelven lo que cada caso necesita.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createBunnyUsageClient, MOTIVOS } = require('../lib/bunny-usage-client.js');
const { createConsumptionRepository } = require('../lib/consumption-repository.js');
const { createConsumptionService, CALIDAD } = require('../lib/consumption-service.js');

const CLAVE = 'clave-secretisima-de-la-cuenta-0123456789';

/** Cliente con la red simulada: responde según la ruta pedida. */
function clienteCon(respuestas, opciones = {}) {
    const vistas = [];
    const cliente = createBunnyUsageClient({
        obtenerClave: async () => (opciones.clave === undefined ? CLAVE : opciones.clave),
        reintentos: opciones.reintentos === undefined ? 2 : opciones.reintentos,
        peticion: async (ruta, clave) => {
            vistas.push({ ruta, clave });
            for (const [patron, r] of respuestas) {
                if (patron instanceof RegExp ? patron.test(ruta) : ruta.includes(patron)) {
                    if (typeof r === 'function') return r(vistas.length);
                    return r;
                }
            }
            return { estado: 200, cuerpo: '[]' };
        },
    });
    return { cliente, vistas };
}

const json = obj => ({ estado: 200, cuerpo: JSON.stringify(obj) });

// ════════════════════════════════════════════════════════════════════════════
//  CLIENTE DEL PROVEEDOR
// ════════════════════════════════════════════════════════════════════════════

test('sin clave configurada no se sale a la red', async () => {
    const { cliente, vistas } = clienteCon([], { clave: '' });
    await assert.rejects(() => cliente.facturacion(), e => e.motivo === MOTIVOS.SIN_CLAVE);
    assert.equal(vistas.length, 0, 'no debe intentar la petición sin clave');
});

test('una clave rechazada no se reintenta: insistir no la arregla', async () => {
    const { cliente, vistas } = clienteCon([['/billing', { estado: 401, cuerpo: 'unauthorized' }]]);
    await assert.rejects(() => cliente.facturacion(), e => e.motivo === MOTIVOS.CLAVE_RECHAZADA);
    assert.equal(vistas.length, 1, 'un 401 no mejora reintentando');
});

test('una cuenta sin saldo se distingue de un fallo cualquiera', async () => {
    for (const r of [{ estado: 402, cuerpo: '{}' },
                     { estado: 400, cuerpo: '{"Message":"insufficient_balance"}' }]) {
        const { cliente } = clienteCon([['/billing', r]]);
        await assert.rejects(() => cliente.facturacion(), e => e.motivo === MOTIVOS.SIN_SALDO);
    }
});

test('un 5xx se reintenta y, si sigue, se declara al proveedor caído', async () => {
    const { cliente, vistas } = clienteCon([['/billing', { estado: 503, cuerpo: 'nope' }]], { reintentos: 2 });
    await assert.rejects(() => cliente.facturacion(), e => e.motivo === MOTIVOS.PROVEEDOR_CAIDO);
    assert.equal(vistas.length, 3, 'debe intentarlo tres veces en total');
});

test('un 429 se reintenta y acaba bien si el proveedor cede', async () => {
    const { cliente, vistas } = clienteCon([['/billing', n =>
        n === 1 ? { estado: 429, cuerpo: '' } : json({ Balance: 5, ThisMonthCharges: 1 })]]);
    const f = await cliente.facturacion();
    assert.equal(f.saldo, 5);
    assert.equal(vistas.length, 2);
});

test('una respuesta que no es JSON no se toma por buena', async () => {
    const { cliente } = clienteCon([['/billing', { estado: 200, cuerpo: '<html>error</html>' }]]);
    await assert.rejects(() => cliente.facturacion(), e => e.motivo === MOTIVOS.RESPUESTA_RARA);
});

test('la clave de la cuenta no aparece en el error', async () => {
    const { cliente } = clienteCon([['/billing', { estado: 401, cuerpo: 'AccessKey ' + CLAVE + ' inválida' }]]);
    await assert.rejects(() => cliente.facturacion(), e => {
        const texto = e.message + ' ' + (e.stack || '');
        assert.ok(!texto.includes(CLAVE), 'la clave se filtró en el error');
        return true;
    });
});

test('de las zonas de almacenamiento no se copian las contraseñas', async () => {
    const { cliente } = clienteCon([['/storagezone', json([{
        Id: 7, Name: 'zona', StorageUsed: 100, FilesStored: 2, Region: 'DE',
        Password: 'secreto-de-escritura', ReadOnlyPassword: 'secreto-de-lectura',
    }])]]);
    const z = await cliente.zonasDeAlmacenamiento();
    const texto = JSON.stringify(z);
    assert.ok(!texto.includes('secreto'), 'se copiaron contraseñas de la zona');
    assert.equal(z[0].bytes, 100);
});

test('las bibliotecas se piden por páginas hasta agotarlas', async () => {
    const { cliente, vistas } = clienteCon([['/videolibrary', n => n === 1
        ? json({ Items: [{ Id: 1, Name: 'a', StorageUsage: 10 }], HasMoreItems: true })
        : json({ Items: [{ Id: 2, Name: 'b', StorageUsage: 20 }], HasMoreItems: false })]]);
    const b = await cliente.bibliotecas();
    assert.equal(b.length, 2);
    assert.equal(vistas.length, 2);
    assert.match(vistas[1].ruta, /page=2/);
});

// ════════════════════════════════════════════════════════════════════════════
//  REPOSITORIO
// ════════════════════════════════════════════════════════════════════════════

/** Pool de mentira con soporte para transacciones. */
function poolFalso(responder = () => ({ rows: [] })) {
    const sentencias = [];
    const query = async (sql, params) => {
        sentencias.push({ sql: String(sql), params });
        return responder(String(sql), params) || { rows: [], rowCount: 0 };
    };
    return {
        sentencias,
        pool: { query, connect: async () => ({ query, release() {} }) },
    };
}

test('una calidad inventada no llega a la base', async () => {
    const { pool } = poolFalso();
    const repo = createConsumptionRepository({ db: { pool } });
    await assert.rejects(
        () => repo.guardarSnapshots('t1', [{ metrica: 'x', unidad: 'bytes', valor: 1, calidad: 'buenisimo' }]),
        /calidad desconocida/i);
});

test('una tanda de snapshots entra entera o no entra', async () => {
    let n = 0;
    const { pool, sentencias } = poolFalso(sql => {
        if (/INSERT INTO consumption_snapshots/.test(sql) && ++n === 2) throw new Error('se cayó a medias');
        return { rows: [] };
    });
    const repo = createConsumptionRepository({ db: { pool } });
    await assert.rejects(() => repo.guardarSnapshots('t1', [
        { metrica: 'a', unidad: 'bytes', valor: 1, calidad: 'medido' },
        { metrica: 'b', unidad: 'bytes', valor: 2, calidad: 'medido' },
    ]), /se cayó a medias/);
    assert.ok(sentencias.some(s => /ROLLBACK/.test(s.sql)), 'debe deshacer la tanda a medias');
    assert.ok(!sentencias.some(s => /COMMIT/.test(s.sql)), 'no puede confirmar una tanda rota');
});

test('las tarifas solo generan versión nueva cuando el precio cambia', async () => {
    const { pool, sentencias } = poolFalso(sql =>
        /FROM consumption_rates/.test(sql)
            ? { rows: [{ codigo_region: 'DE', precio_gb: '0.01', moneda: 'EUR' },
                        { codigo_region: 'BR', precio_gb: '0.045', moneda: 'EUR' }] }
            : { rows: [] });
    const repo = createConsumptionRepository({ db: { pool } });
    const escritas = await repo.guardarTarifas([
        { codigo: 'DE', precioPorGb: 0.01 },     // igual: no se escribe
        { codigo: 'BR', precioPorGb: 0.05 },     // cambió: sí
        { codigo: 'JP', precioPorGb: 0.03 },     // nueva: sí
    ]);
    assert.equal(escritas, 2);
    const insertadas = sentencias.filter(s => /INSERT INTO consumption_rates/.test(s.sql));
    assert.equal(insertadas.length, 2);
    assert.ok(!insertadas.some(s => s.params[0] === 'DE'), 'no debe versionar un precio que no cambió');
});

test('las tarifas vigentes se piden por la más reciente de cada región', async () => {
    const { pool, sentencias } = poolFalso(() => ({ rows: [] }));
    const repo = createConsumptionRepository({ db: { pool } });
    await repo.tarifasVigentes();
    const sql = sentencias[0].sql;
    assert.match(sql, /DISTINCT ON \(codigo_region\)/);
    assert.match(sql, /vigente_desde DESC/);
});

test('el arriendo no se concede si otro lo tiene vivo', async () => {
    const { pool } = poolFalso(sql =>
        /UPDATE consumption_sync/.test(sql) ? { rows: [], rowCount: 0 } : { rows: [] });
    const repo = createConsumptionRepository({ db: { pool } });
    assert.equal(await repo.tomarArriendo('j', 'otro', 300), false);
});

test('el arriendo se toma con una sola sentencia condicionada, sin hueco entre comprobar y escribir', async () => {
    const { pool, sentencias } = poolFalso(sql =>
        /UPDATE consumption_sync/.test(sql) ? { rows: [{ job: 'j' }], rowCount: 1 } : { rows: [] });
    const repo = createConsumptionRepository({ db: { pool } });
    assert.equal(await repo.tomarArriendo('j', 'yo', 300), true);
    const upd = sentencias.find(s => /UPDATE consumption_sync/.test(s.sql));
    assert.match(upd.sql, /arrendado_hasta IS NULL OR arrendado_hasta < NOW\(\)/,
        'la condición debe ir dentro del UPDATE, no en un SELECT aparte');
});

// ════════════════════════════════════════════════════════════════════════════
//  SERVICIO
// ════════════════════════════════════════════════════════════════════════════

/** Repositorio de mentira con memoria, para probar el servicio sin base. */
function repoFalso({ metricas = [], sync = {}, tarifas = [] } = {}) {
    const guardado = [];
    return {
        guardado,
        asegurarEsquema: async () => {},
        tomarArriendo: async () => sync.libre !== false,
        liberarArriendo: async (j, d, r) => { guardado.push({ liberado: r }); },
        estadoDeSincronizacion: async () => ({
            job: 'consumo-proveedor', nuncaEjecutado: !metricas.length,
            ultimoIntento: sync.ultimoIntento || null, ultimoOk: sync.ultimoOk || null,
            ultimoError: sync.ultimoError || null, intentos: 1, fallos: 0,
        }),
        ultimasMetricas: async ({ ambito }) => metricas.filter(m => m.ambito === ambito),
        resumenDeFrescura: async () => ({
            total: metricas.length,
            ultima: metricas.reduce((m, x) => (!m || x.tomadoEn > m ? x.tomadoEn : m), null),
        }),
        serieDeMetrica: async () => [],
        guardarSnapshots: async (tanda, filas) => { guardado.push({ tanda, filas }); return filas.length; },
        guardarTarifas: async () => 0,
        tarifasVigentes: async () => tarifas,
        historialDeTarifa: async () => [],
        purgar: async () => 0,
    };
}

const dbCon = (cursos = []) => ({ pool: { query: async () => ({ rows: cursos }) } });

test('sin lecturas guardadas se dice por qué, y no se enseña un cero', async () => {
    const s = createConsumptionService({
        db: dbCon(), cliente: {}, repositorio: repoFalso({ metricas: [] }),
    });
    const r = await s.resumen();
    assert.equal(r.disponible, false);
    assert.equal(r.calidad, CALIDAD.NO_DISPONIBLE);
    assert.match(r.motivo, /todavía no/i);
    assert.ok(!('indicadores' in r), 'no puede publicar indicadores que no tiene');
});

test('un proveedor caído no hace fallar la sincronización: se anota y se sigue', async () => {
    const caido = () => { const e = new Error('503'); e.motivo = MOTIVOS.PROVEEDOR_CAIDO; throw e; };
    const repo = repoFalso();
    const s = createConsumptionService({
        db: dbCon(), repositorio: repo,
        cliente: { facturacion: caido, bibliotecas: caido, zonasDeAlmacenamiento: caido,
                   usoPorPullZone: caido, estadisticas: caido, tarifas: caido },
        logger: { error() {}, warn() {}, log() {} },
    });
    const r = await s.sincronizar();
    assert.equal(r.hecho, false);
    assert.equal(r.fallos.length, 6, 'las seis lecturas deben quedar anotadas');
    assert.ok(r.fallos.every(f => f.motivo === MOTIVOS.PROVEEDOR_CAIDO));
});

test('si solo falla una lectura, lo demás sí se guarda', async () => {
    const repo = repoFalso();
    const s = createConsumptionService({
        db: dbCon(), repositorio: repo,
        cliente: {
            facturacion: async () => { const e = new Error('401'); e.motivo = MOTIVOS.CLAVE_RECHAZADA; throw e; },
            bibliotecas: async () => [{ id: '10', nombre: 'Curso', videos: 3, almacenamientoBytes: 100, traficoBytes: 50 }],
            zonasDeAlmacenamiento: async () => [],
            usoPorPullZone: async () => [],
            estadisticas: async () => ({ bytesTotales: 9, peticiones: 4, tasaDeAcierto: 50, serie: [] }),
            tarifas: async () => [],
        },
        logger: { error() {}, warn() {}, log() {} },
    });
    const r = await s.sincronizar();
    assert.equal(r.hecho, true, 'media foto fechada vale más que ninguna');
    assert.equal(r.fallos.length, 1);
    const filas = repo.guardado.find(g => g.filas).filas;
    assert.ok(filas.some(f => f.metrica === 'almacenamiento_bytes' && f.valor === 100));
    assert.ok(!filas.some(f => f.metrica === 'cargos_del_mes'), 'no se inventa lo que no se leyó');
});

test('lo que viene del proveedor se marca medido', async () => {
    const s = createConsumptionService({
        db: dbCon(),
        cliente: {}, repositorio: repoFalso({
            metricas: [
                { ambito: 'cuenta', metrica: 'cargos_del_mes', valor: 13.86, unidad: 'EUR',
                  calidad: 'medido', fuente: 'bunny', tomadoEn: new Date().toISOString() },
                { ambito: 'biblioteca', ambitoId: '10', metrica: 'almacenamiento_bytes', valor: 100,
                  unidad: 'bytes', calidad: 'medido', fuente: 'bunny', tomadoEn: new Date().toISOString() },
            ],
        }),
    });
    const r = await s.resumen();
    assert.equal(r.disponible, true);
    assert.equal(r.indicadores.cargosDelMes.valor, 13.86);
    assert.equal(r.indicadores.cargosDelMes.calidad, CALIDAD.MEDIDO);
    assert.equal(r.almacenamiento.calidad, CALIDAD.MEDIDO);
});

test('el costo por formación se declara derivado, nunca medido', async () => {
    const ahora = new Date().toISOString();
    const s = createConsumptionService({
        db: dbCon([{ id: 'c1', name: 'Curso 1', bunny_library_id: '10', producer_id: 'p1', productor: 'Cliente' }]),
        cliente: {}, repositorio: repoFalso({ metricas: [
            { ambito: 'cuenta', metrica: 'cargos_almacenamiento', valor: 10, unidad: 'EUR', calidad: 'medido', fuente: 'bunny', tomadoEn: ahora },
            { ambito: 'biblioteca', ambitoId: '10', metrica: 'almacenamiento_bytes', valor: 100, unidad: 'bytes', calidad: 'medido', fuente: 'bunny', tomadoEn: ahora, detalle: { nombre: 'Lib' } },
        ] }),
    });
    const r = await s.porFormacion();
    assert.equal(r.calidad, CALIDAD.DERIVADO);
    assert.equal(r.formaciones[0].calidadDelCosto, CALIDAD.DERIVADO);
    assert.match(r.nota, /no una factura por formación/i);
});

test('las bibliotecas que no son de ninguna formación no se reparten entre clientes', async () => {
    const ahora = new Date().toISOString();
    const s = createConsumptionService({
        db: dbCon([{ id: 'c1', name: 'Curso 1', bunny_library_id: '10', producer_id: 'p1', productor: 'Cliente' }]),
        cliente: {}, repositorio: repoFalso({ metricas: [
            { ambito: 'cuenta', metrica: 'cargos_almacenamiento', valor: 10, unidad: 'EUR', calidad: 'medido', fuente: 'bunny', tomadoEn: ahora },
            { ambito: 'biblioteca', ambitoId: '10', metrica: 'almacenamiento_bytes', valor: 100, unidad: 'bytes', calidad: 'medido', fuente: 'bunny', tomadoEn: ahora },
            { ambito: 'biblioteca', ambitoId: '99', metrica: 'almacenamiento_bytes', valor: 300, unidad: 'bytes', calidad: 'medido', fuente: 'bunny', tomadoEn: ahora },
        ] }),
    });
    const r = await s.porFormacion();
    assert.equal(r.formaciones.length, 1);
    assert.equal(r.fueraDeEdulock.length, 1);
    assert.equal(r.fueraDeEdulock[0].bibliotecaId, '99');
    // La de Edulock pesa 100 de 400: le toca la cuarta parte, no la mitad ni el total.
    assert.equal(r.formaciones[0].porcentajeDelAlmacenamiento, 25);
    assert.equal(r.formaciones[0].costoImputado, 2.5);
});

test('el reparto cubre todo el almacenamiento: nada se pierde ni se cuenta dos veces', async () => {
    const ahora = new Date().toISOString();
    const s = createConsumptionService({
        db: dbCon([{ id: 'c1', name: 'C1', bunny_library_id: '10', producer_id: 'p1', productor: 'X' }]),
        cliente: {}, repositorio: repoFalso({ metricas: [
            { ambito: 'biblioteca', ambitoId: '10', metrica: 'almacenamiento_bytes', valor: 250, unidad: 'bytes', calidad: 'medido', fuente: 'bunny', tomadoEn: ahora },
            { ambito: 'biblioteca', ambitoId: '11', metrica: 'almacenamiento_bytes', valor: 250, unidad: 'bytes', calidad: 'medido', fuente: 'bunny', tomadoEn: ahora },
            { ambito: 'biblioteca', ambitoId: '12', metrica: 'almacenamiento_bytes', valor: 500, unidad: 'bytes', calidad: 'medido', fuente: 'bunny', tomadoEn: ahora },
        ] }),
    });
    const r = await s.porFormacion();
    const suma = [...r.formaciones, ...r.fueraDeEdulock]
        .reduce((a, x) => a + x.porcentajeDelAlmacenamiento, 0);
    assert.equal(Math.round(suma), 100);
});

test('una biblioteca compartida por dos formaciones se declara compartida', async () => {
    const ahora = new Date().toISOString();
    const s = createConsumptionService({
        db: dbCon([
            { id: 'c1', name: 'C1', bunny_library_id: '10', producer_id: 'p1', productor: 'X' },
            { id: 'c2', name: 'C2', bunny_library_id: '10', producer_id: 'p1', productor: 'X' },
        ]),
        cliente: {}, repositorio: repoFalso({ metricas: [
            { ambito: 'cuenta', metrica: 'cargos_almacenamiento', valor: 8, unidad: 'EUR', calidad: 'medido', fuente: 'bunny', tomadoEn: ahora },
            { ambito: 'biblioteca', ambitoId: '10', metrica: 'almacenamiento_bytes', valor: 100, unidad: 'bytes', calidad: 'medido', fuente: 'bunny', tomadoEn: ahora },
        ] }),
    });
    const r = await s.porFormacion();
    assert.equal(r.formaciones.length, 2);
    assert.ok(r.formaciones.every(f => f.compartidaCon === 2),
        'debe quedar claro que las dos miran el mismo consumo');
    assert.equal(r.cobroDeAlmacenamientoDelMes, 8,
        'el cobro del mes sigue siendo 8, no 16');
});

test('unos datos viejos se marcan como no frescos', async () => {
    const viejo = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
    const s = createConsumptionService({
        db: dbCon(), cliente: {}, repositorio: repoFalso({ metricas: [
            { ambito: 'cuenta', metrica: 'saldo', valor: 5, unidad: 'EUR', calidad: 'medido', fuente: 'bunny', tomadoEn: viejo },
        ] }),
    });
    const e = await s.estado();
    assert.equal(e.fresco, false);
    assert.ok(e.horasDeAntiguedad >= 19);
    const r = await s.resumen();
    assert.equal(r.fresco, false, 'el panel tiene que poder avisar de que mira una foto vieja');
});

test('no se recolecta dos veces a la vez', async () => {
    const s = createConsumptionService({
        db: dbCon(), cliente: {},
        repositorio: repoFalso({ sync: { libre: false } }),
    });
    const r = await s.sincronizar();
    assert.equal(r.hecho, false);
    assert.equal(r.motivo, 'ya_en_curso');
});

test('sin tarifas leídas no se inventa un precio por gigabyte', async () => {
    const s = createConsumptionService({ db: dbCon(), cliente: {}, repositorio: repoFalso({ tarifas: [] }) });
    const t = await s.tarifas();
    assert.equal(t.disponible, false);
    assert.equal(t.calidad, CALIDAD.NO_DISPONIBLE);
});

test('las tarifas leídas se agrupan por continente con su rango real', async () => {
    const s = createConsumptionService({ db: dbCon(), cliente: {}, repositorio: repoFalso({ tarifas: [
        { codigo: 'DE', continente: 'EU', precioPorGb: 0.01, moneda: 'EUR' },
        { codigo: 'BR', continente: 'SA', precioPorGb: 0.045, moneda: 'EUR' },
        { codigo: 'CL', continente: 'SA', precioPorGb: 0.01, moneda: 'EUR' },
    ] }) });
    const t = await s.tarifas();
    assert.equal(t.disponible, true);
    assert.deepEqual(t.porContinente.SA, { minimo: 0.01, maximo: 0.045, regiones: 2 });
});
