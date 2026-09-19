'use strict';
/*
 * Pruebas del servicio de métricas del panel.
 *
 * Se centran en los errores de conteo que los documentos prohíben expresamente:
 * sumar cuentas que son la misma persona, tratar una licencia generada como
 * vendida, contar heartbeats como reproducciones, contar dos veces una clase que
 * además tiene contenedor .edu, o presentar el tamaño de los originales como si
 * fuera el consumo facturable del proveedor.
 *
 * No necesitan base de datos: se le da al servicio un `pool` de mentira que
 * devuelve filas controladas, y se comprueba qué hace con ellas.
 */
const test = require('node:test');
const assert = require('node:assert');
const { createAdminAnalytics, CALIDAD, resolverPeriodo } = require('../lib/admin-analytics.js');

/** Pool falso: responde según la primera consulta que encaje con un patrón. */
function poolCon(respuestas) {
    const vistas = [];
    return {
        vistas,
        pool: {
            async query(sql, params) {
                vistas.push({ sql, params });
                for (const [patron, filas] of respuestas) {
                    if (patron instanceof RegExp ? patron.test(sql) : sql.includes(patron)) {
                        return { rows: typeof filas === 'function' ? filas(sql, params) : filas };
                    }
                }
                return { rows: [{}] };
            },
        },
    };
}

test('el servicio exige la capa de base de datos', () => {
    assert.throws(() => createAdminAnalytics({}), /base de datos/i);
    assert.throws(() => createAdminAnalytics({ db: {} }), /base de datos/i);
});

// ── Clientes ────────────────────────────────────────────────────────────────

test('clientes separa habilitados de suspendidos', async () => {
    const { pool } = poolCon([['FROM producers', [{ total: 5, habilitados: 4, suspendidos: 1 }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.clientes();
    assert.equal(m.valor, 5);
    assert.equal(m.detalle.habilitados, 4);
    assert.equal(m.detalle.suspendidos, 1);
    assert.equal(m.calidad, CALIDAD.MEDIDO);
});

// ── Cuentas registradas ─────────────────────────────────────────────────────

test('las cuentas incluyen a los productores, tengan licencia o no', async () => {
    const { pool } = poolCon([['FROM students', [{ alumnos: 40, productores: 3, compartidos: 0 }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.cuentasRegistradas();
    assert.equal(m.valor, 43, 'un productor forma parte del total de cuentas');
    assert.equal(m.detalle.alumnos, 40);
    assert.equal(m.detalle.productores, 3);
});

test('un correo presente en las dos tablas NO se cuenta dos veces', async () => {
    const { pool } = poolCon([['FROM students', [{ alumnos: 40, productores: 3, compartidos: 2 }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.cuentasRegistradas();
    assert.equal(m.valor, 41, '40 + 3 - 2');
    assert.equal(m.calidad, CALIDAD.DERIVADO, 'deja de ser un recuento directo');
    assert.match(m.nota, /descuentan/i);
});

test('sin solapamiento se avisa de que son cuentas, no personas', async () => {
    const { pool } = poolCon([['FROM students', [{ alumnos: 6, productores: 2, compartidos: 0 }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.cuentasRegistradas();
    assert.match(m.nota, /cuentas, no personas/i);
    assert.equal(m.unidad, 'cuentas');
});

// ── Actividad ───────────────────────────────────────────────────────────────

test('los usuarios activos NO se sacan de audit_log', async () => {
    const { pool, vistas } = poolCon([['WITH alumnos', [{ alumnos: 9, productores: 2 }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.usuariosActivos(30);
    assert.equal(m.valor, 11);
    assert.equal(m.ambito, 'periodo');
    assert.match(m.periodo, /30/);
    const sql = vistas.map(v => v.sql).join(' ');
    assert.ok(!/audit_log/.test(sql), 'audit_log es 84 % heartbeats: no puede ser fuente de actividad');
    assert.match(m.nota, /heartbeat/i);
});

test('la ventana de actividad tiene fin excluido', async () => {
    const { pool, vistas } = poolCon([['WITH alumnos', [{ alumnos: 1, productores: 0 }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    await s.usuariosActivos(7);
    const c = vistas.find(v => v.sql.includes('WITH alumnos'));
    assert.ok(c.sql.includes('< $2'), 'el final del rango debe quedar excluido');
    const [desde, hasta] = c.params;
    const dias = (hasta - desde) / 86400000;
    assert.ok(Math.abs(dias - 7) < 0.01, 'la ventana debe medir exactamente 7 días, medía ' + dias);
});

// ── Formaciones ─────────────────────────────────────────────────────────────

test('no se inventa un estado de publicación que el modelo no tiene', async () => {
    const { pool } = poolCon([['FROM courses', [{ total: 3, con_contenido: 2, sin_productor: 1 }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.formaciones();
    assert.equal(m.valor, 3);
    assert.equal(m.unidad, 'formaciones');
    assert.equal(m.detalle.conContenidoListo, 2);
    assert.match(m.nota, /no guarda un estado de publicaci/i);
});

test('las formaciones sin productor se declaran aparte', async () => {
    const { pool } = poolCon([['FROM courses', [{ total: 10, con_contenido: 7, sin_productor: 3 }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.formaciones();
    assert.equal(m.detalle.sinProductor, 3, 'no se les asigna un productor ficticio');
});

// ── Licencias ───────────────────────────────────────────────────────────────

test('licencias activas cuenta licencias, no activaciones', async () => {
    const { pool } = poolCon([
        ['GROUP BY l.status', [
            { status: 'free', n: 24, con_alumno: 0 },
            { status: 'active', n: 7, con_alumno: 6 },
        ]],
        ['FROM activations', [{ n: 18 }]],
        [/LEFT JOIN courses c/, [{ n: 0 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.licencias();
    assert.equal(m.valor, 7, 'siete licencias activas');
    assert.equal(m.detalle.activacionesEnDispositivos, 18, 'las activaciones van aparte');
    assert.notEqual(m.valor, m.detalle.activacionesEnDispositivos);
});

test('una licencia generada y libre no cuenta como asignada', async () => {
    const { pool } = poolCon([
        ['GROUP BY l.status', [
            { status: 'free', n: 24, con_alumno: 0 },
            { status: 'active', n: 7, con_alumno: 6 },
        ]],
        ['FROM activations', [{ n: 0 }]],
        [/LEFT JOIN courses c/, [{ n: 0 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.licencias();
    assert.equal(m.detalle.generadasSinDueno, 24);
    assert.equal(m.detalle.asignadas, 6, 'solo las que tienen alumno');
    assert.match(m.nota, /no caducan/i);
});

// ── Inicios de reproducción ─────────────────────────────────────────────────

test('los inicios se deduplican y salen de watermark_logs', async () => {
    const { pool, vistas } = poolCon([
        ['FROM watermark_logs', [{ eventos: 33, deduplicados: 21, alumnos: 5, clases: 4 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.inicios(30);
    assert.equal(m.valor, 21, 'se informa el valor deduplicado');
    assert.equal(m.detalle.eventosBrutos, 33, 'y se conserva el bruto para poder auditarlo');
    assert.equal(m.fuente, 'watermark_logs');
    assert.equal(m.calidad, CALIDAD.DERIVADO);
    assert.ok(/date_trunc\('minute'/.test(vistas[0].sql), 'un reintento en el mismo minuto no es otra reproducción');
});

// ── Clases ──────────────────────────────────────────────────────────────────

test('una clase con contenedor .edu no se cuenta dos veces', async () => {
    const { pool } = poolCon([
        ['GROUP BY status, source_type', [
            { status: 'ready', source_type: 'edu', n: 4 },
            { status: 'ready', source_type: 'bunny', n: 3 },
            { status: 'processing', source_type: 'bunny', n: 1 },
        ]],
        ['FROM edu_content', [{ registros: 4, con_clase: 4 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.clases();
    assert.equal(m.valor, 7, '4 + 3 listas; los 4 registros .edu YA están entre ellas');
    assert.equal(m.detalle.porEstado.processing, 1);
    assert.equal(m.detalle.contenedoresEdu, 4);
    assert.notEqual(m.valor, 11, 'sumar edu_content al catálogo sería contar doble');
});

test('se distingue el origen de cada clase', async () => {
    const { pool } = poolCon([
        ['GROUP BY status, source_type', [
            { status: 'ready', source_type: 'edu', n: 2 },
            { status: 'error', source_type: 'bunny', n: 1 },
        ]],
        ['FROM edu_content', [{ registros: 2, con_clase: 2 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.clases();
    assert.equal(m.detalle.porOrigen.edu, 2);
    assert.equal(m.detalle.porOrigen.bunny, 1);
    assert.equal(m.detalle.porEstado.error, 1);
});

// ── Almacenamiento ──────────────────────────────────────────────────────────

test('el almacenamiento NO se presenta como consumo del proveedor', async () => {
    const { pool } = poolCon([
        ['FROM stream_operations', [{ operaciones: 25, con_tamano: 25, bytes: '45036924' }]],
        ['FROM protected_resources', [{ bytes: '1000000', n: 2 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.almacenamiento();
    assert.equal(m.valor, 46036924);
    assert.equal(m.unidad, 'bytes');
    assert.equal(m.calidad, CALIDAD.PARCIAL, 'no es una medición completa');
    assert.equal(m.detalle.medicion, 'archivos_originales_registrados');
    assert.equal(m.detalle.consumoDelProveedorConocido, false);
    assert.match(m.nota, /NO el consumo f[ií]sico/i);
});

test('las operaciones sin tamaño se declaran, no se cuentan como cero', async () => {
    const { pool } = poolCon([
        ['FROM stream_operations', [{ operaciones: 10, con_tamano: 7, bytes: '500' }]],
        ['FROM protected_resources', [{ bytes: '0', n: 0 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.almacenamiento();
    assert.equal(m.detalle.sinTamano, 3);
});

// ── Resumen del Home ────────────────────────────────────────────────────────

test('el resumen devuelve los ocho indicadores', async () => {
    const { pool } = poolCon([
        ['FROM producers', [{ total: 2, habilitados: 2, suspendidos: 0 }]],
        ['FROM students', [{ alumnos: 6, productores: 2, compartidos: 0 }]],
        ['WITH alumnos', [{ alumnos: 3, productores: 1 }]],
        ['FROM courses', [{ total: 3, con_contenido: 2, sin_productor: 1 }]],
        ['GROUP BY l.status', [{ status: 'active', n: 7, con_alumno: 6 }]],
        ['FROM activations', [{ n: 8 }]],
        ['FROM watermark_logs', [{ eventos: 33, deduplicados: 20, alumnos: 4, clases: 3 }]],
        ['GROUP BY status, source_type', [{ status: 'ready', source_type: 'bunny', n: 3 }]],
        ['FROM edu_content', [{ registros: 0, con_clase: 0 }]],
        ['FROM stream_operations', [{ operaciones: 25, con_tamano: 25, bytes: '45036924' }]],
        ['FROM protected_resources', [{ bytes: '0', n: 0 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const r = await s.resumenHome({ dias: 30 });
    const esperados = ['clientes', 'cuentasRegistradas', 'usuariosActivos', 'formaciones',
        'licencias', 'inicios', 'clases', 'almacenamiento'];
    assert.deepEqual(Object.keys(r.indicadores).sort(), esperados.slice().sort());
    for (const k of esperados) {
        const m = r.indicadores[k];
        assert.ok('valor' in m && 'fuente' in m && 'calidad' in m, k + ' debe traer valor, fuente y calidad');
    }
    assert.equal(r.periodo, 'últimos 30 días');
});

test('si un indicador falla, los demás siguen funcionando', async () => {
    let n = 0;
    const pool = {
        async query(sql) {
            n++;
            if (sql.includes('FROM courses')) throw new Error('columna inexistente');
            if (sql.includes('FROM producers')) return { rows: [{ total: 2, habilitados: 2, suspendidos: 0 }] };
            if (sql.includes('FROM students')) return { rows: [{ alumnos: 6, productores: 2, compartidos: 0 }] };
            if (sql.includes('WITH alumnos')) return { rows: [{ alumnos: 1, productores: 0 }] };
            if (sql.includes('GROUP BY status, source_type')) return { rows: [] };
            if (sql.includes('GROUP BY l.status')) return { rows: [] };
            return { rows: [{ n: 0, operaciones: 0, con_tamano: 0, bytes: '0', registros: 0, con_clase: 0 }] };
        },
    };
    const s = createAdminAnalytics({ db: { pool } });
    const r = await s.resumenHome();
    assert.equal(r.indicadores.formaciones.valor, null, 'el que falla queda en null');
    assert.equal(r.indicadores.formaciones.calidad, CALIDAD.NO_DISPONIBLE, 'y nunca en cero');
    assert.equal(r.indicadores.clientes.valor, 2, 'los demás se calculan igual');
});

// ── Lista de formaciones ────────────────────────────────────────────────────

test('la ordenación viene de una lista cerrada: no se inyecta SQL', async () => {
    const { pool, vistas } = poolCon([[/WITH clases/, []]]);
    const s = createAdminAnalytics({ db: { pool } });
    await s.listaFormaciones({ orden: "nombre; DROP TABLE students --" });
    const sql = vistas.find(v => /WITH clases/.test(v.sql)).sql;
    assert.ok(!/DROP TABLE/i.test(sql), 'una ordenación inventada no puede llegar al SQL');
    assert.ok(sql.includes('ORDER BY alumnos DESC'), 'cae en el orden por omisión');
});

test('la búsqueda y el productor viajan como parámetros, no concatenados', async () => {
    const { pool, vistas } = poolCon([[/WITH clases/, []]]);
    const s = createAdminAnalytics({ db: { pool } });
    await s.listaFormaciones({ busqueda: "O'Brien", productorId: 'prod-1' });
    const c = vistas.find(v => /WITH clases/.test(v.sql));
    assert.ok(!c.sql.includes("O'Brien"), 'el texto de búsqueda no se concatena');
    assert.ok(c.params.some(p => String(p).includes("o'brien")), 'viaja como parámetro');
    assert.ok(c.params.includes('prod-1'));
});

test('el tamaño de página tiene tope y la ordenación es global', async () => {
    const { pool, vistas } = poolCon([[/WITH clases/, [{
        id: 'c1', name: 'Curso', created_at: null, producer_id: null, productor: null,
        clases_total: 2, clases_listas: 1, alumnos: 3, modulos: 1, submodulos: 0,
        inicios_periodo: 5, ultima_actividad: null, total_filas: 30,
    }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const r = await s.listaFormaciones({ porPagina: 500, pagina: 2 });
    assert.equal(r.porPagina, 48, 'se limita el tamaño de página');
    assert.equal(r.total, 30, 'el total es del conjunto completo, no de la página');
    const sql = vistas.find(v => /WITH clases/.test(v.sql)).sql;
    assert.ok(sql.includes('count(*) OVER ()'), 'el total se calcula en el servidor');
    assert.ok(sql.includes('LIMIT 48'));
});

test('las formaciones sin datos salen en cero, no desaparecen ni lideran', async () => {
    const { pool } = poolCon([[/WITH clases/, [{
        id: 'c2', name: 'Curso vacío', created_at: null, producer_id: null, productor: null,
        clases_total: 0, clases_listas: 0, alumnos: 0, modulos: 0, submodulos: 0,
        inicios_periodo: 0, ultima_actividad: null, total_filas: 1,
    }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const r = await s.listaFormaciones({});
    const f = r.formaciones[0];
    assert.equal(f.alumnosConAcceso, 0);
    assert.equal(f.ultimaActividad, null, 'sin actividad es null, no una fecha inventada');
    assert.equal(f.sinProductor, true, 'se marca explícitamente');
});

test('cada relación se agrega antes de unirse, para no multiplicar filas', async () => {
    const { pool, vistas } = poolCon([[/WITH clases/, []]]);
    const s = createAdminAnalytics({ db: { pool } });
    await s.listaFormaciones({});
    const sql = vistas.find(v => /WITH clases/.test(v.sql)).sql;
    for (const cte of ['clases AS', 'alumnos_curso AS', 'modulos AS', 'actividad AS']) {
        assert.ok(sql.includes(cte), 'falta agregar por separado: ' + cte);
    }
    assert.ok(/count\(DISTINCT student_id\)/.test(sql), 'los alumnos se cuentan distintos');
});


// ════════════════════════════════════════════════════════════════════════════
//  FASE 5 — períodos con nombre y lecturas de la página Analítica
// ════════════════════════════════════════════════════════════════════════════

const DIA = 24 * 3600 * 1000;
const cuantosDias = p => Math.round((p.hasta - p.desde) / DIA);

test('«hoy» abarca un solo día y su final aún no ha llegado', () => {
    const p = resolverPeriodo({ preset: 'hoy' });
    assert.equal(cuantosDias(p), 1);
    assert.equal(p.etiqueta, 'hoy');
    assert.ok(p.hasta > new Date());
});

test('los días empiezan a medianoche de Lima, no de UTC', () => {
    // Lima va cinco horas por detrás de UTC: su medianoche cae a las 05:00Z.
    for (const preset of ['hoy', '7d', '30d', 'mes']) {
        const p = resolverPeriodo({ preset });
        assert.equal(p.desde.getUTCHours(), 5, preset + ' no arranca a medianoche de Lima');
        assert.equal(p.hasta.getUTCHours(), 5, preset + ' no termina a medianoche de Lima');
    }
});

test('«este mes» empieza el día 1 y nunca dura más que un mes', () => {
    const p = resolverPeriodo({ preset: 'mes' });
    assert.equal(p.etiqueta, 'este mes');
    assert.ok(cuantosDias(p) >= 1 && cuantosDias(p) <= 31, 'duró ' + cuantosDias(p) + ' días');
});

test('un rango a medida incluye el día final completo', () => {
    const p = resolverPeriodo({ desde: '2026-03-01', hasta: '2026-03-10' });
    assert.equal(p.clave, 'rango');
    assert.equal(cuantosDias(p), 10, 'del 1 al 10 son diez días, no nueve');
    assert.equal(p.etiqueta, '2026-03-01 a 2026-03-10');
});

test('un rango imposible no se adivina: se avisa y se cae a 30 días', () => {
    for (const malo of [{ desde: 'basura', hasta: 'x' },
                        { desde: '2026-05-10', hasta: '2026-05-01' },
                        { desde: '2000-01-01', hasta: '2026-01-01' }]) {
        const p = resolverPeriodo(malo);
        assert.equal(p.etiqueta, 'últimos 30 días', JSON.stringify(malo));
        assert.ok(p.avisoRango, 'debe decir por qué no se usó el rango pedido');
    }
});

test('el número de días se acota entre 1 y 365', () => {
    assert.equal(cuantosDias(resolverPeriodo({ dias: 0 })), 30);
    assert.equal(cuantosDias(resolverPeriodo({ dias: -5 })), 30);
    assert.equal(cuantosDias(resolverPeriodo({ dias: 99999 })), 365);
    assert.equal(cuantosDias(resolverPeriodo({ dias: 7 })), 7);
});

test('un período ya resuelto llega tal cual a la consulta', async () => {
    const { pool, vistas } = poolCon([['FROM licenses', [{ asignadas: 2, alumnos: 2, formaciones: 1 }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const periodo = resolverPeriodo({ desde: '2026-03-01', hasta: '2026-03-10' });
    const m = await s.licenciasAsignadas(periodo);
    assert.equal(m.periodo, '2026-03-01 a 2026-03-10');
    assert.deepEqual(vistas[0].params, [periodo.desde, periodo.hasta]);
});

test('el resumen de analítica trae sus ocho indicadores y el período usado', async () => {
    const { pool } = poolCon([
        ['FROM students', [{ alumnos: 3, clientes: 1 }]],
        ['FROM licenses', [{ asignadas: 2, alumnos: 2, formaciones: 1 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const r = await s.resumenAnalitica({ periodo: resolverPeriodo({ preset: 'hoy' }) });
    assert.equal(r.periodo, 'hoy');
    for (const k of ['altas', 'usuariosActivos', 'licenciasAsignadas', 'licenciasActivas',
                     'inicios', 'formaciones', 'clases', 'almacenamiento']) {
        assert.ok(r.indicadores[k], 'falta ' + k);
        assert.ok('calidad' in r.indicadores[k], k + ' debe declarar su calidad');
    }
});

test('un indicador que revienta no tumba el resto del resumen', async () => {
    const pool = { async query(sql) {
        if (/FROM licenses/.test(sql)) throw new Error('columna inventada');
        return { rows: [{}] };
    } };
    const s = createAdminAnalytics({ db: { pool } });
    const r = await s.resumenAnalitica({ periodo: 30 });
    assert.equal(r.indicadores.licenciasAsignadas.calidad, CALIDAD.NO_DISPONIBLE);
    assert.equal(r.indicadores.licenciasAsignadas.valor, null, 'no disponible no es cero');
    assert.ok(Object.keys(r.indicadores).length === 8);
});

test('las altas se declaran parciales: una cuenta borrada ya no cuenta', async () => {
    const { pool } = poolCon([['FROM students', [{ alumnos: 4, clientes: 1 }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.altas(30);
    assert.equal(m.valor, 5);
    assert.equal(m.calidad, CALIDAD.PARCIAL);
    assert.match(m.nota, /borrada/i);
});

test('las licencias del período se llaman asignadas, no vendidas', async () => {
    const { pool } = poolCon([['FROM licenses', [{ asignadas: 9, alumnos: 7, formaciones: 2 }]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.licenciasAsignadas(30);
    assert.equal(m.valor, 9);
    assert.doesNotMatch(m.nota, /vendid|ingres/i, 'no hay dato de ventas en esta base');
    assert.match(m.nota, /no es una entrega confirmada/i);
});

test('la serie de actividad se mide sobre assigned/watermark, con un punto por día', async () => {
    const { pool, vistas } = poolCon([['generate_series', [
        { dia: '2026-03-01', usuarios: 0, inicios: 0 },
        { dia: '2026-03-02', usuarios: 2, inicios: 5 },
    ]]]);
    const s = createAdminAnalytics({ db: { pool } });
    const r = await s.serieActividad({ periodo: 30 });
    assert.equal(r.puntos.length, 2);
    assert.deepEqual(r.puntos[0], { dia: '2026-03-01', usuarios: 0, inicios: 0 });
    assert.match(vistas[0].sql, /generate_series/, 'los días vacíos se generan, no se omiten');
    assert.match(r.nota, /cero porque está comprobado/i);
});

test('la lista de clientes declara aparte el contenido sin dueño', async () => {
    const { pool } = poolCon([
        [/FROM producers p/, [{ id: 'p1', email: 'a@b.c', name: 'Cliente', habilitado: true,
            max_licenses: 10, max_devices: 2, embedded_catalog_enabled: false,
            formaciones: 2, alumnos: 3, licencias: 5, licencias_activas: 4, clases: 6,
            alumnos_activos: 1, inicios: 7 }]],
        [/FROM courses WHERE producer_id IS NULL/, [{ formaciones: 1, clases: 1 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const r = await s.listaProductores({ periodo: 30 });
    assert.equal(r.clientes.length, 1);
    assert.equal(r.clientes[0].alumnos, 3);
    assert.deepEqual(r.sinCliente, { formaciones: 1, clases: 1 });
    assert.match(r.nota, /no se reparte/i);
});

test('la lista de clientes no saca el hash de la contraseña', async () => {
    const { pool } = poolCon([
        [/FROM producers p/, [{ id: 'p1', email: 'a@b.c', name: 'X', habilitado: true,
            password_hash: '$2b$10$loquesea', formaciones: 0, alumnos: 0, licencias: 0,
            licencias_activas: 0, clases: 0, alumnos_activos: 0, inicios: 0 }]],
        [/FROM courses WHERE producer_id IS NULL/, [{ formaciones: 0, clases: 0 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const r = await s.listaProductores({ periodo: 30 });
    assert.ok(!JSON.stringify(r).includes('$2b$'), 'se filtró el hash de la contraseña');
});

test('el detalle de una formación inexistente devuelve vacío, no un error', async () => {
    const { pool } = poolCon([[/FROM courses c LEFT JOIN producers/, []]]);
    const s = createAdminAnalytics({ db: { pool } });
    assert.equal(await s.detalleFormacion('no-existe'), null);
});

test('la actividad destacada mide inicios, no minutos vistos', async () => {
    const { pool } = poolCon([
        [/LEFT JOIN catalog cat/, [{ video_id: 'v1', titulo: 'Clase', formacion: 'Curso', inicios: 4, alumnos: 2 }]],
        [/LEFT JOIN students s/, [{ user_id: 'u1', nombre: 'Ana', inicios: 4, clases: 2, ultima: null }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const r = await s.topActividad({ periodo: 30, limite: 5 });
    assert.equal(r.clases[0].inicios, 4);
    assert.equal(r.alumnos[0].nombre, 'Ana');
    assert.match(r.nota, /no minutos vistos/i);
});

test('el límite de la actividad destacada nunca entra crudo en la consulta', async () => {
    const { pool, vistas } = poolCon([[/LIMIT/, []]]);
    const s = createAdminAnalytics({ db: { pool } });
    await s.topActividad({ periodo: 30, limite: '10; DROP TABLE students' });
    assert.ok(vistas.length >= 2);
    for (const { sql } of vistas) {
        assert.doesNotMatch(sql, /DROP TABLE/i, 'se coló SQL del cliente');
        assert.match(sql, /LIMIT 10\s*$/, 'el límite debe quedar en un número');
    }
});

test('el límite de la actividad destacada se acota a 50', async () => {
    const { pool, vistas } = poolCon([[/LIMIT/, []]]);
    const s = createAdminAnalytics({ db: { pool } });
    await s.topActividad({ periodo: 30, limite: 9999 });
    for (const { sql } of vistas) assert.match(sql, /LIMIT 50\s*$/);
});

test('una licencia de una formación borrada no cuenta como activa', async () => {
    const { pool } = poolCon([
        // El JOIN con courses ya deja fuera las huérfanas: aquí llegan solo las vivas.
        ['GROUP BY l.status', [{ status: 'active', n: 3, con_alumno: 3 }]],
        ['FROM activations', [{ n: 4 }]],
        [/LEFT JOIN courses c/, [{ n: 2 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.licencias();
    assert.equal(m.valor, 3, 'las dos huérfanas no se suman');
    assert.equal(m.detalle.deFormacionesBorradas, 2, 'pero se declaran, no se esconden');
    assert.equal(m.calidad, CALIDAD.PARCIAL, 'con huérfanas la cifra deja de ser una medición limpia');
    assert.match(m.nota, /no dan acceso a nada/i);
});

test('sin licencias huérfanas la cifra vuelve a ser una medición', async () => {
    const { pool } = poolCon([
        ['GROUP BY l.status', [{ status: 'active', n: 5, con_alumno: 5 }]],
        ['FROM activations', [{ n: 5 }]],
        [/LEFT JOIN courses c/, [{ n: 0 }]],
    ]);
    const s = createAdminAnalytics({ db: { pool } });
    const m = await s.licencias();
    assert.equal(m.calidad, CALIDAD.MEDIDO);
    assert.equal(m.detalle.deFormacionesBorradas, 0);
    assert.doesNotMatch(m.nota, /borradas/i, 'no se avisa de un problema que no existe');
});
