'use strict';
/*
 * admin-analytics.js — Servicio compartido de métricas del panel.
 *
 * Una sola definición de cada indicador para el Home, Analítica, los detalles y
 * las exportaciones: si dos pantallas muestran "alumnos", muestran lo mismo.
 *
 * REGLAS QUE CUMPLE
 *
 *  - Cada valor viaja con su unidad, su ámbito temporal, su fuente y su calidad.
 *    `null` significa «no hay dato»; cero solo se devuelve cuando está medido.
 *  - No se inventan estados. Si el modelo no tiene «publicado», el indicador se
 *    llama «Formaciones» y no «Formaciones publicadas».
 *  - No se confunden conceptos: una licencia generada no es una asignada, una
 *    autorización no es una reproducción y un heartbeat no es actividad humana.
 *  - Solo lee. No crea recursos, no llama al proveedor de video y no toca Bunny.
 *
 * DICCIONARIO DE FUENTES (medido sobre la base real, no supuesto)
 *
 *   producers            cuentas de cliente/productor. Tiene created_at y active.
 *   students             cuentas de alumno. Tabla distinta de producers; hoy no
 *                        comparten ningún correo, así que son cuentas separadas.
 *   courses              formaciones. NO tiene estado de publicación.
 *   catalog              clases. status ∈ {ready, processing, error}; source_type
 *                        distingue 'edu' de los demás orígenes.
 *   edu_content          contenedores .edu; se relaciona con catalog por video_id,
 *                        así que NO debe sumarse al conteo de clases.
 *   licenses             status ∈ {free, active, ...}; free = generada y sin dueño.
 *                        La clave se guarda hasheada (license_key_hash).
 *   watermark_logs       lo escribe el reproductor al empezar a reproducir de
 *                        verdad. Es la señal más cercana a un inicio real.
 *   playback_progress    posición y porcentaje por alumno y clase.
 *   audit_log            84 % son heartbeats. NO es una fuente de reproducciones.
 *   stream_operations    file_size = tamaño del ORIGINAL subido, no el consumo
 *                        físico del proveedor.
 *
 * COLUMNAS DE TEXTO CON FECHA: audit_log.delivered_at y playback_progress
 * (started_at/last_seen_at) se guardan como texto; hay que convertirlas con
 * ::timestamptz antes de compararlas. Está contemplado en cada consulta.
 */

/** Etiquetas de calidad de un dato, para que la interfaz no invente certezas. */
const CALIDAD = {
    MEDIDO: 'medido',            // contado directamente en nuestra base
    DERIVADO: 'derivado',        // deducido de registros con una regla explícita
    ESTIMADO: 'estimado',        // calculado con supuestos declarados
    PARCIAL: 'parcial',          // la fuente no cubre todo el ámbito
    NO_DISPONIBLE: 'no_disponible',
};

/** Envuelve un valor con todo lo que hace falta para interpretarlo. */
function metrica({ valor, unidad = null, ambito = 'actual', periodo = null,
    fuente, calidad = CALIDAD.MEDIDO, nota = null, detalle = null }) {
    return { valor: valor === undefined ? null : valor, unidad, ambito, periodo, fuente, calidad, nota, detalle };
}

/**
 * @param {object} deps
 * @param {object} deps.db  capa de base de datos con `pool` (database-pg.js)
 */
/*
 * Convierte lo que pide el panel en un rango concreto. El dueño lee sus cifras
 * en America/Lima, así que «hoy» y «este mes» se cortan por ese huso y no por
 * el del servidor, que corre en UTC: si no, «hoy» empezaría cinco horas antes.
 */
const ZONA = 'America/Lima';

function partesEnLima(d) {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-CA', {
        timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(d)) if (x.type !== 'literal') p[x.type] = x.value;
    return p;
}

/** Medianoche de Lima del día al que pertenece `d`, como instante real. */
function inicioDelDiaLima(d) {
    const p = partesEnLima(d);
    const yaEnLima = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    // La diferencia entre el reloj de Lima y UTC para ESE instante; se calcula
    // en vez de fijarse a -5 para no romperse si algún día cambia la regla.
    const desfase = yaEnLima - Math.floor(d.getTime() / 1000) * 1000;
    return new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - desfase);
}

function resolverPeriodo({ preset = null, dias = null, desde = null, hasta = null } = {}) {
    const ahora = new Date();
    const finDeHoy = new Date(inicioDelDiaLima(ahora).getTime() + 24 * 3600 * 1000);

    if (desde || hasta) {
        const d = new Date(String(desde || '') + 'T00:00:00');
        const h = new Date(String(hasta || '') + 'T00:00:00');
        if (!isNaN(d) && !isNaN(h) && d <= h) {
            const di = inicioDelDiaLima(d);
            const hf = new Date(inicioDelDiaLima(h).getTime() + 24 * 3600 * 1000);
            // Un rango a medida se acota a un año: más allá las consultas dejan
            // de responder en un tiempo razonable y el panel se queda colgado.
            if (hf - di <= 366 * 24 * 3600 * 1000) {
                return { desde: di, hasta: hf, etiqueta: String(desde) + ' a ' + String(hasta), clave: 'rango' };
            }
        }
        // Un rango inválido no se adivina: se cae al de siempre y se dice.
        return { ...resolverPeriodo({ preset: '30d' }), avisoRango: 'El rango pedido no es válido; se muestran los últimos 30 días.' };
    }

    switch (String(preset || '')) {
        case 'hoy':
            return { desde: inicioDelDiaLima(ahora), hasta: finDeHoy, etiqueta: 'hoy', clave: 'hoy' };
        case 'mes': {
            const p = partesEnLima(ahora);
            const primero = inicioDelDiaLima(new Date(Date.UTC(+p.year, +p.month - 1, 1, 12)));
            return { desde: primero, hasta: finDeHoy, etiqueta: 'este mes', clave: 'mes' };
        }
        case '7d':
        case '30d':
        case '90d': {
            const n = parseInt(preset, 10);
            return { desde: new Date(finDeHoy.getTime() - n * 24 * 3600 * 1000), hasta: finDeHoy,
                     etiqueta: 'últimos ' + n + ' días', clave: preset };
        }
    }
    const pedido = parseInt(dias, 10);
    const n = Number.isFinite(pedido) && pedido > 0 ? Math.min(365, pedido) : 30;
    return { desde: new Date(finDeHoy.getTime() - n * 24 * 3600 * 1000), hasta: finDeHoy,
             etiqueta: 'últimos ' + n + ' días', clave: n + 'd' };
}

function createAdminAnalytics({ db }) {
    if (!db || !db.pool) throw new Error('admin-analytics necesita la capa de base de datos');
    const q = (sql, params = []) => db.pool.query(sql, params);
    const num = v => (v === null || v === undefined ? null : Number(v));

    /*
     * En esta base casi todas las fechas se guardan como TEXTO
     * (courses.created_at, students.last_login, watermark_logs.created_at,
     * playback_progress...). Hay que convertirlas antes de compararlas, y
     * tolerar filas vacias o con basura sin tumbar la consulta entera.
     */
    const fecha = col => `(CASE WHEN ${col} ~ '^[0-9]{4}-' THEN ${col}::timestamptz END)`;

    /*
     * Restringe una consulta sobre watermark_logs a las clases de un cliente.
     * `__sin__` significa el contenido que no tiene cliente asignado, que se
     * mira aparte y nunca se reparte entre los demas.
     */
    function soloDelCliente(productorId, alias = 'w') {
        if (!productorId) return '';
        const deAlgunCliente = `SELECT 1 FROM catalog cat JOIN courses c ON c.id = cat.course_id
                                WHERE cat.video_id = ${alias}.video_id AND c.producer_id IS NOT NULL`;
        // Por exclusión: si la clase ya no existe, su actividad tampoco es de
        // ningún cliente, y tiene que seguir apareciendo en alguna parte.
        if (productorId === '__sin__') return ` AND NOT EXISTS (${deAlgunCliente})`;
        return ` AND EXISTS (SELECT 1 FROM catalog cat JOIN courses c ON c.id = cat.course_id
                             WHERE cat.video_id = ${alias}.video_id AND c.producer_id = $3)`;
    }

    /** `active` es INTEGER en students y producers, no booleano. */
    const activo = col => `(${col} = 1)`;

    /*
     * El período puede llegar como un número de días (lo habitual) o ya resuelto
     * como {desde, hasta, etiqueta} por resolverPeriodo. En los dos casos sale
     * lo mismo hacia las consultas: un intervalo con el final excluido.
     */
    function ventana(periodo = 30) {
        if (periodo && typeof periodo === 'object' && periodo.desde && periodo.hasta) {
            return {
                desde: new Date(periodo.desde),
                hasta: new Date(periodo.hasta),
                etiqueta: periodo.etiqueta || 'período seleccionado',
            };
        }
        const dias = Number(periodo) || 30;
        const hasta = new Date();
        const desde = new Date(hasta.getTime() - dias * 24 * 3600 * 1000);
        return { desde, hasta, etiqueta: 'últimos ' + dias + ' días' };
    }

    // ── 1. Clientes (productores) ───────────────────────────────────────────
    async function clientes() {
        const r = (await q(`SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE ${activo('active')})::int     AS habilitados,
                   count(*) FILTER (WHERE NOT ${activo('active')})::int AS suspendidos
            FROM producers`)).rows[0];
        return metrica({
            valor: r.total, unidad: 'clientes', fuente: 'producers',
            detalle: { habilitados: r.habilitados, suspendidos: r.suspendidos },
            nota: 'Un cliente es un productor de la plataforma, no un alumno ni una licencia.',
        });
    }

    // ── 2. Cuentas registradas ──────────────────────────────────────────────
    /*
     * Se llama «cuentas» y no «personas» a propósito: alumnos y productores son
     * tablas distintas y no existe una relación de identidad entre ellas. Si en
     * algún momento un correo aparece en las dos, se descuenta para no contar la
     * misma persona dos veces, y se avisa de que la cobertura es parcial.
     */
    async function cuentasRegistradas() {
        const r = (await q(`
            SELECT (SELECT count(*) FROM students)::int  AS alumnos,
                   (SELECT count(*) FROM producers)::int AS productores,
                   (SELECT count(*) FROM students s
                      JOIN producers p ON lower(p.email) = lower(s.email))::int AS compartidos`)).rows[0];
        const total = r.alumnos + r.productores - r.compartidos;
        return metrica({
            valor: total, unidad: 'cuentas', fuente: 'students + producers',
            calidad: r.compartidos > 0 ? CALIDAD.DERIVADO : CALIDAD.MEDIDO,
            detalle: { alumnos: r.alumnos, productores: r.productores, correosEnAmbas: r.compartidos },
            nota: r.compartidos > 0
                ? 'Hay ' + r.compartidos + ' correo(s) en las dos tablas; se descuentan del total.'
                : 'Son cuentas, no personas únicas: no existe una relación de identidad entre alumnos y productores.',
        });
    }

    // ── 3. Usuarios activos en el período ───────────────────────────────────
    /*
     * Actividad significativa = empezar a reproducir, avanzar en una clase o
     * iniciar sesión. Los heartbeats quedan FUERA: son sondeos de fondo, no una
     * acción de la persona.
     */
    async function usuariosActivos(periodo = 30) {
        const v = ventana(periodo);
        const r = (await q(`
            WITH alumnos AS (
                SELECT user_id::text AS id FROM watermark_logs
                  WHERE ${fecha('created_at')} >= $1 AND ${fecha('created_at')} < $2
                UNION
                SELECT student_id::text FROM playback_progress
                  WHERE ${fecha('last_seen_at')} >= $1 AND ${fecha('last_seen_at')} < $2
                UNION
                SELECT id::text FROM students
                  WHERE ${fecha('last_login')} >= $1 AND ${fecha('last_login')} < $2
            ),
            clientes AS (
                SELECT id::text AS id FROM producers
                  WHERE ${fecha('last_login')} >= $1 AND ${fecha('last_login')} < $2
            )
            SELECT (SELECT count(*) FROM alumnos)::int  AS alumnos,
                   (SELECT count(*) FROM clientes)::int AS productores`, [v.desde, v.hasta])).rows[0];
        return metrica({
            valor: r.alumnos + r.productores, unidad: 'usuarios',
            ambito: 'periodo', periodo: v.etiqueta,
            fuente: 'watermark_logs + playback_progress + last_login',
            calidad: CALIDAD.DERIVADO,
            detalle: { alumnos: r.alumnos, productores: r.productores },
            nota: 'Cuenta a quien reprodujo, avanzó en una clase o inició sesión. Los heartbeats no cuentan como actividad.',
        });
    }

    // ── 4. Formaciones ──────────────────────────────────────────────────────
    /*
     * El modelo NO tiene estado de publicación, así que el indicador no puede
     * llamarse «Formaciones publicadas». Se informa cuántas tienen al menos una
     * clase lista, que es lo que sí se puede comprobar.
     */
    async function formaciones() {
        const r = (await q(`
            SELECT (SELECT count(*) FROM courses)::int AS total,
                   (SELECT count(DISTINCT course_id) FROM catalog
                      WHERE status = 'ready' AND course_id IS NOT NULL)::int AS con_contenido,
                   (SELECT count(*) FROM courses WHERE producer_id IS NULL)::int AS sin_productor`)).rows[0];
        return metrica({
            valor: r.total, unidad: 'formaciones', fuente: 'courses',
            detalle: { conContenidoListo: r.con_contenido, sinProductor: r.sin_productor },
            nota: 'El modelo no guarda un estado de publicación; se informa cuántas tienen al menos una clase lista.',
        });
    }

    // ── 5. Licencias ────────────────────────────────────────────────────────
    /*
     * Generada ≠ asignada ≠ activada. `free` es una clave generada que todavía
     * no tiene dueño. Se cuentan identificadores de licencia, nunca activaciones
     * ni sesiones.
     */
    async function licencias() {
        /*
         * Solo cuentan las licencias cuya formación sigue existiendo. Al borrar
         * una formación sus licencias se quedan en la base con estado 'active',
         * pero no dan acceso a nada: contarlas inflaría una cifra que se lee
         * como negocio. Se declaran aparte, con su nombre, en vez de esconderlas.
         */
        const estados = (await q(`
            SELECT l.status, count(*)::int AS n, count(l.student_id)::int AS con_alumno
            FROM licenses l JOIN courses c ON c.id = l.course_id
            GROUP BY l.status`)).rows;
        const por = Object.fromEntries(estados.map(e => [e.status, e.n]));
        const activas = por.active || 0;
        const asignadas = estados.reduce((a, e) => a + e.con_alumno, 0);
        const activaciones = num((await q('SELECT count(*)::int AS n FROM activations')).rows[0].n);
        const huerfanas = num((await q(`
            SELECT count(*)::int AS n FROM licenses l
            LEFT JOIN courses c ON c.id = l.course_id
            WHERE c.id IS NULL`)).rows[0].n);
        return metrica({
            valor: activas, unidad: 'licencias', fuente: 'licenses.status',
            calidad: huerfanas ? CALIDAD.PARCIAL : CALIDAD.MEDIDO,
            detalle: {
                porEstado: por,
                generadasSinDueno: por.free || 0,
                asignadas,
                activacionesEnDispositivos: activaciones,
                deFormacionesBorradas: huerfanas,
            },
            nota: 'Son licencias distintas, no activaciones ni sesiones. Las licencias de curso no caducan.'
                + (huerfanas
                    ? ' No se cuentan ' + huerfanas + ' licencia(s) de formaciones ya borradas: siguen en la base pero no dan acceso a nada.'
                    : ''),
        });
    }

    // ── 6. Inicios de reproducción del período ──────────────────────────────
    /*
     * Se usa watermark_logs, que el reproductor escribe cuando la clase empieza
     * a verse de verdad. NO se usa audit_log: el 84 % de sus filas son
     * heartbeats. Se deduplica por alumno, clase y minuto para que un reintento
     * no cuente como otra reproducción.
     */
    async function inicios(periodo = 30) {
        const v = ventana(periodo);
        const r = (await q(`
            SELECT count(*)::int AS eventos,
                   count(DISTINCT (user_id, video_id, date_trunc('minute', ${fecha('created_at')})))::int AS deduplicados,
                   count(DISTINCT user_id)::int  AS alumnos,
                   count(DISTINCT video_id)::int AS clases
            FROM watermark_logs
            WHERE ${fecha('created_at')} >= $1 AND ${fecha('created_at')} < $2`, [v.desde, v.hasta])).rows[0];
        return metrica({
            valor: r.deduplicados, unidad: 'inicios',
            ambito: 'periodo', periodo: v.etiqueta,
            fuente: 'watermark_logs', calidad: CALIDAD.DERIVADO,
            detalle: { eventosBrutos: r.eventos, alumnos: r.alumnos, clases: r.clases },
            nota: 'Inicios de reproducción registrados por el reproductor, deduplicados por alumno, clase y minuto.',
        });
    }

    // ── 7. Clases listas ────────────────────────────────────────────────────
    async function clases() {
        const r = (await q(`SELECT status, source_type, count(*)::int AS n
            FROM catalog GROUP BY status, source_type`)).rows;
        const porEstado = {};
        const porOrigen = {};
        for (const f of r) {
            porEstado[f.status] = (porEstado[f.status] || 0) + f.n;
            porOrigen[f.source_type] = (porOrigen[f.source_type] || 0) + f.n;
        }
        // edu_content se relaciona con catalog por video_id: no se suma aparte.
        const edu = (await q(`SELECT count(*)::int AS registros,
                   count(*) FILTER (WHERE video_id IN (SELECT video_id FROM catalog))::int AS con_clase
            FROM edu_content`)).rows[0];
        return metrica({
            valor: porEstado.ready || 0, unidad: 'clases', fuente: 'catalog.status',
            detalle: {
                porEstado, porOrigen,
                contenedoresEdu: edu.registros,
                contenedoresEduConClase: edu.con_clase,
            },
            nota: 'Una clase con contenedor .edu se cuenta una sola vez: edu_content se relaciona con catalog por video_id.',
        });
    }

    // ── 8. Almacenamiento ───────────────────────────────────────────────────
    /*
     * Lo único medible hoy sin llamar al proveedor es el tamaño de los archivos
     * ORIGINALES que se subieron. Eso NO es el consumo físico facturable: no
     * incluye transcodificaciones, réplicas ni la envoltura del contenedor .edu.
     * El consumo real lo entrega el módulo de consumo y costos; mientras no
     * exista, aquí se declara así y no se disfraza de GB facturados.
     */
    async function almacenamiento() {
        const r = (await q(`SELECT count(*)::int AS operaciones,
                   count(file_size)::int AS con_tamano,
                   COALESCE(sum(file_size), 0)::bigint AS bytes
            FROM stream_operations`)).rows[0];
        const recursos = (await q(`SELECT COALESCE(sum(byte_size), 0)::bigint AS bytes,
                   count(*)::int AS n FROM protected_resources WHERE deleted_at IS NULL`)).rows[0];
        return metrica({
            valor: Number(r.bytes) + Number(recursos.bytes), unidad: 'bytes',
            fuente: 'stream_operations.file_size + protected_resources.byte_size',
            calidad: CALIDAD.PARCIAL,
            detalle: {
                medicion: 'archivos_originales_registrados',
                videosBytes: Number(r.bytes),
                documentosBytes: Number(recursos.bytes),
                operaciones: r.operaciones,
                sinTamano: r.operaciones - r.con_tamano,
                consumoDelProveedorConocido: false,
            },
            nota: 'Tamaño de los originales registrados, NO el consumo físico del proveedor. No incluye transcodificaciones, réplicas ni la envoltura del contenedor .edu.',
        });
    }

    // ── Resumen del Home: los ocho indicadores ──────────────────────────────
    /*
     * Cada bloque se calcula por separado y un fallo en uno no tumba a los
     * demás: el Home debe poder mostrar siete indicadores aunque el octavo no
     * tenga fuente.
     */
    async function resumenHome({ periodo = 30 } = {}) {
        const nombres = ['clientes', 'cuentasRegistradas', 'usuariosActivos', 'formaciones',
            'licencias', 'inicios', 'clases', 'almacenamiento'];
        const calculos = [clientes(), cuentasRegistradas(), usuariosActivos(periodo), formaciones(),
            licencias(), inicios(periodo), clases(), almacenamiento()];
        const hechos = await Promise.allSettled(calculos);
        const salida = { generadoEn: new Date().toISOString(), periodo: ventana(periodo).etiqueta, indicadores: {} };
        hechos.forEach((h, i) => {
            salida.indicadores[nombres[i]] = h.status === 'fulfilled' ? h.value : metrica({
                valor: null, fuente: 'error', calidad: CALIDAD.NO_DISPONIBLE,
                nota: 'No se pudo calcular: ' + String(h.reason && h.reason.message || h.reason).slice(0, 120),
            });
        });
        return salida;
    }

    // ── Formaciones con sus cifras, paginadas y ordenadas en el servidor ────
    const ORDENES = {
        alumnos: 'alumnos DESC, c.name ASC',
        alumnos_asc: 'alumnos ASC, c.name ASC',
        actividad: 'inicios_periodo DESC, c.name ASC',
        recientes: 'c.created_at DESC NULLS LAST, c.name ASC',
        actividad_ultima: 'ultima_actividad DESC NULLS LAST, c.name ASC',
        clases: 'clases_total DESC, c.name ASC',
        nombre: 'c.name ASC',
    };

    async function listaFormaciones({ pagina = 1, porPagina = 12, orden = 'alumnos',
        productorId = null, busqueda = null, periodo = 30 } = {}) {
        const p = Math.max(1, Number(pagina) || 1);
        const tam = Math.min(48, Math.max(1, Number(porPagina) || 12));
        const ordenSql = ORDENES[orden] || ORDENES.alumnos;   // lista cerrada: no llega SQL del cliente
        const v = ventana(periodo);

        const filtros = [];
        const args = [v.desde, v.hasta];
        if (productorId === '__sin__') filtros.push('c.producer_id IS NULL');
        else if (productorId) { args.push(productorId); filtros.push('c.producer_id = $' + args.length); }
        if (busqueda) {
            args.push('%' + String(busqueda).trim().toLowerCase() + '%');
            filtros.push('(lower(c.name) LIKE $' + args.length + ' OR lower(COALESCE(p.name, p.email, \'\')) LIKE $' + args.length + ')');
        }
        const donde = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';

        // Cada relación se agrega ANTES de unirla, para que una clase con tres
        // licencias no multiplique las filas de alumnos.
        const sql = `
            WITH clases AS (
                SELECT course_id,
                       count(*)::int AS total,
                       count(*) FILTER (WHERE status = 'ready')::int AS listas
                FROM catalog WHERE course_id IS NOT NULL GROUP BY course_id
            ),
            alumnos_curso AS (
                SELECT course_id, count(DISTINCT student_id)::int AS n
                FROM licenses
                WHERE status = 'active' AND student_id IS NOT NULL AND course_id IS NOT NULL
                GROUP BY course_id
            ),
            modulos AS (
                SELECT course_id,
                       count(*) FILTER (WHERE parent_id IS NULL)::int AS raiz,
                       count(*) FILTER (WHERE parent_id IS NOT NULL)::int AS hijos
                FROM modules GROUP BY course_id
            ),
            actividad AS (
                SELECT cat.course_id,
                       count(DISTINCT (w.user_id, w.video_id, date_trunc('minute', ${fecha('w.created_at')})))::int AS inicios,
                       max(${fecha('w.created_at')}) AS ultima
                FROM watermark_logs w
                JOIN catalog cat ON cat.video_id = w.video_id
                WHERE ${fecha('w.created_at')} >= $1 AND ${fecha('w.created_at')} < $2
                  AND cat.course_id IS NOT NULL
                GROUP BY cat.course_id
            )
            SELECT c.id, c.name, c.created_at, c.producer_id,
                   COALESCE(p.name, p.email)        AS productor,
                   COALESCE(cl.total, 0)            AS clases_total,
                   COALESCE(cl.listas, 0)           AS clases_listas,
                   COALESCE(ac.n, 0)                AS alumnos,
                   COALESCE(m.raiz, 0)              AS modulos,
                   COALESCE(m.hijos, 0)             AS submodulos,
                   COALESCE(a.inicios, 0)           AS inicios_periodo,
                   a.ultima                         AS ultima_actividad,
                   count(*) OVER ()::int            AS total_filas
            FROM courses c
            LEFT JOIN producers p     ON p.id = c.producer_id
            LEFT JOIN clases cl       ON cl.course_id = c.id
            LEFT JOIN alumnos_curso ac ON ac.course_id = c.id
            LEFT JOIN modulos m       ON m.course_id = c.id
            LEFT JOIN actividad a     ON a.course_id = c.id
            ${donde}
            ORDER BY ${ordenSql}
            LIMIT ${tam} OFFSET ${(p - 1) * tam}`;

        const filas = (await q(sql, args)).rows;
        const total = filas.length ? filas[0].total_filas : await (async () => {
            const args2 = args.slice(2);
            const r = await q(`SELECT count(*)::int AS n FROM courses c
                LEFT JOIN producers p ON p.id = c.producer_id ${donde.replace(/\$(\d+)/g, (_, d) => '$' + (Number(d) - 2))}`, args2);
            return r.rows[0].n;
        })();

        return {
            pagina: p, porPagina: tam, total,
            orden, periodo: v.etiqueta,
            formaciones: filas.map(f => ({
                id: f.id,
                nombre: f.name,
                productor: f.productor || null,
                productorId: f.producer_id || null,
                sinProductor: !f.producer_id,
                alumnosConAcceso: f.alumnos,
                clases: { listas: f.clases_listas, total: f.clases_total },
                modulos: f.modulos, submodulos: f.submodulos,
                iniciosPeriodo: f.inicios_periodo,
                ultimaActividad: f.ultima_actividad || null,
                creadoEn: f.created_at,
            })),
            nota: 'Alumnos con acceso = alumnos distintos con licencia activa de esa formación. La ordenación se aplica sobre todo el conjunto filtrado, no sobre la página.',
        };
    }

    // ════════════════════════════════════════════════════════════════════
    //  ANALÍTICA — lecturas del período
    // ════════════════════════════════════════════════════════════════════

    /*
     * Altas del período. `created_at` es TEXTO en las dos tablas, así que se
     * convierte antes de comparar. Una cuenta borrada no reaparece aquí: solo
     * se ven las filas que existen hoy, y eso se declara en la nota.
     */
    async function altas(periodo = 30) {
        const v = ventana(periodo);
        const r = (await q(`
            SELECT (SELECT count(*) FROM students
                      WHERE ${fecha('created_at')} >= $1 AND ${fecha('created_at')} < $2)::int  AS alumnos,
                   (SELECT count(*) FROM producers
                      WHERE ${fecha('created_at')} >= $1 AND ${fecha('created_at')} < $2)::int AS clientes`,
            [v.desde, v.hasta])).rows[0];
        return metrica({
            valor: r.alumnos + r.clientes, unidad: 'altas',
            ambito: 'periodo', periodo: v.etiqueta,
            fuente: 'students.created_at + producers.created_at',
            calidad: CALIDAD.PARCIAL,
            detalle: { alumnos: r.alumnos, clientes: r.clientes },
            nota: 'Cuenta las altas de cuentas que siguen existiendo. Una cuenta creada y luego borrada no aparece.',
        });
    }

    /*
     * Licencias asignadas durante el período. Se usa assigned_at, que es cuándo
     * se vinculó a un alumno, NO created_at. Y se llama «asignadas», no
     * «entregadas»: el sistema no registra la entrega al cliente como un evento
     * distinto, así que afirmarlo sería inventar.
     */
    async function licenciasAsignadas(periodo = 30) {
        const v = ventana(periodo);
        const r = (await q(`
            SELECT count(*)::int AS asignadas,
                   count(DISTINCT student_id)::int AS alumnos,
                   count(DISTINCT course_id)::int  AS formaciones
            FROM licenses
            WHERE assigned_at IS NOT NULL
              AND ${fecha('assigned_at')} >= $1 AND ${fecha('assigned_at')} < $2`, [v.desde, v.hasta])).rows[0];
        return metrica({
            valor: r.asignadas, unidad: 'licencias',
            ambito: 'periodo', periodo: v.etiqueta,
            fuente: 'licenses.assigned_at', calidad: CALIDAD.DERIVADO,
            detalle: { alumnos: r.alumnos, formaciones: r.formaciones },
            nota: 'Asignadas a un alumno en el período. No es una entrega confirmada al cliente ni una venta.',
        });
    }

    /** Resumen de la pestaña principal de Analítica. */
    async function resumenAnalitica({ periodo = 30 } = {}) {
        const nombres = ['altas', 'usuariosActivos', 'licenciasAsignadas', 'licenciasActivas',
            'inicios', 'formaciones', 'clases', 'almacenamiento'];
        const hechos = await Promise.allSettled([
            altas(periodo), usuariosActivos(periodo), licenciasAsignadas(periodo), licencias(),
            inicios(periodo), formaciones(), clases(), almacenamiento(),
        ]);
        const salida = { generadoEn: new Date().toISOString(), periodo: ventana(periodo).etiqueta, indicadores: {} };
        hechos.forEach((h, i) => {
            salida.indicadores[nombres[i]] = h.status === 'fulfilled' ? h.value : metrica({
                valor: null, fuente: 'error', calidad: CALIDAD.NO_DISPONIBLE,
                nota: 'No se pudo calcular: ' + String(h.reason && h.reason.message || h.reason).slice(0, 120),
            });
        });
        return salida;
    }

    /*
     * Serie diaria de actividad. Se apoya en generate_series para que los días
     * sin actividad salgan en cero de verdad, y no falten de la gráfica dando la
     * impresión de una línea continua que no existió.
     */
    async function serieActividad({ periodo = 30, productorId = null } = {}) {
        const v = ventana(periodo);
        const args = [v.desde, v.hasta];
        if (productorId && productorId !== '__sin__') args.push(productorId);
        const filas = (await q(`
            WITH dias AS (
                SELECT generate_series(date_trunc('day', $1::timestamptz),
                                       date_trunc('day', $2::timestamptz), interval '1 day') AS dia
            ),
            eventos AS (
                SELECT date_trunc('day', ${fecha('watermark_logs.created_at')}) AS dia,
                       count(DISTINCT watermark_logs.user_id)::int AS usuarios,
                       count(DISTINCT (watermark_logs.user_id, watermark_logs.video_id,
                             date_trunc('minute', ${fecha('watermark_logs.created_at')})))::int AS inicios
                FROM watermark_logs
                WHERE ${fecha('watermark_logs.created_at')} >= $1
                  AND ${fecha('watermark_logs.created_at')} < $2
                      ${soloDelCliente(productorId, 'watermark_logs')}
                GROUP BY 1
            )
            SELECT d.dia::date::text AS dia,
                   COALESCE(e.usuarios, 0) AS usuarios,
                   COALESCE(e.inicios, 0)  AS inicios
            FROM dias d LEFT JOIN eventos e ON e.dia = d.dia
            ORDER BY d.dia`, args)).rows;
        return {
            periodo: v.etiqueta, productorId: productorId || null,
            fuente: 'watermark_logs', calidad: CALIDAD.DERIVADO,
            puntos: filas.map(f => ({ dia: f.dia, usuarios: f.usuarios, inicios: f.inicios })),
            nota: 'Un día sin actividad vale cero porque está comprobado, no porque falte el dato.',
        };
    }

    /*
     * Tabla de clientes. Los alumnos de un cliente se cuentan UNA vez aunque
     * estén en dos de sus formaciones: por eso el conteo se hace sobre el
     * conjunto de sus cursos, no sumando los subtotales por curso.
     */
    async function listaProductores({ periodo = 30 } = {}) {
        const v = ventana(periodo);
        const filas = (await q(`
            WITH cursos AS (
                SELECT producer_id, count(*)::int AS n FROM courses
                WHERE producer_id IS NOT NULL GROUP BY producer_id
            ),
            alumnos AS (
                SELECT c.producer_id, count(DISTINCT l.student_id)::int AS n
                FROM licenses l JOIN courses c ON c.id = l.course_id
                WHERE l.status = 'active' AND l.student_id IS NOT NULL AND c.producer_id IS NOT NULL
                GROUP BY c.producer_id
            ),
            lic AS (
                SELECT c.producer_id,
                       count(*)::int AS total,
                       count(*) FILTER (WHERE l.status = 'active')::int AS activas
                FROM licenses l JOIN courses c ON c.id = l.course_id
                WHERE c.producer_id IS NOT NULL GROUP BY c.producer_id
            ),
            clases AS (
                SELECT c.producer_id, count(*)::int AS n
                FROM catalog cat JOIN courses c ON c.id = cat.course_id
                WHERE c.producer_id IS NOT NULL GROUP BY c.producer_id
            ),
            act AS (
                SELECT c.producer_id,
                       count(DISTINCT w.user_id)::int AS usuarios,
                       count(DISTINCT (w.user_id, w.video_id, date_trunc('minute', ${fecha('w.created_at')})))::int AS inicios
                FROM watermark_logs w
                JOIN catalog cat ON cat.video_id = w.video_id
                JOIN courses c   ON c.id = cat.course_id
                WHERE ${fecha('w.created_at')} >= $1 AND ${fecha('w.created_at')} < $2
                  AND c.producer_id IS NOT NULL
                GROUP BY c.producer_id
            )
            SELECT p.id, p.email, p.name, ${activo('p.active')} AS habilitado,
                   p.max_licenses, p.max_devices, p.embedded_catalog_enabled,
                   COALESCE(cu.n, 0) AS formaciones,
                   COALESCE(al.n, 0) AS alumnos,
                   COALESCE(li.total, 0)   AS licencias,
                   COALESCE(li.activas, 0) AS licencias_activas,
                   COALESCE(cl.n, 0) AS clases,
                   COALESCE(a.usuarios, 0) AS alumnos_activos,
                   COALESCE(a.inicios, 0)  AS inicios
            FROM producers p
            LEFT JOIN cursos cu  ON cu.producer_id = p.id
            LEFT JOIN alumnos al ON al.producer_id = p.id
            LEFT JOIN lic li     ON li.producer_id = p.id
            LEFT JOIN clases cl  ON cl.producer_id = p.id
            LEFT JOIN act a      ON a.producer_id = p.id
            ORDER BY alumnos DESC, p.name NULLS LAST, p.email`, [v.desde, v.hasta])).rows;

        // Contenido sin dueño: se declara aparte, nunca se reparte entre clientes.
        const huerfano = (await q(`
            SELECT count(*)::int AS formaciones,
                   (SELECT count(*) FROM catalog cat
                      LEFT JOIN courses c ON c.id = cat.course_id
                      WHERE cat.course_id IS NULL OR c.producer_id IS NULL)::int AS clases
            FROM courses WHERE producer_id IS NULL`)).rows[0];

        return {
            periodo: v.etiqueta,
            clientes: filas.map(f => ({
                id: f.id, nombre: f.name || f.email, correo: f.email,
                habilitado: f.habilitado,
                misCursos: f.embedded_catalog_enabled === true,
                cuota: { licencias: f.max_licenses, dispositivos: f.max_devices },
                formaciones: f.formaciones, clases: f.clases,
                alumnos: f.alumnos, alumnosActivos: f.alumnos_activos,
                licencias: { total: f.licencias, activas: f.licencias_activas },
                iniciosPeriodo: f.inicios,
            })),
            sinCliente: { formaciones: huerfano.formaciones, clases: huerfano.clases },
            nota: 'Un alumno presente en dos formaciones del mismo cliente cuenta una sola vez. El contenido sin cliente se declara aparte y no se reparte.',
        };
    }

    /*
     * Lo más visto y quién más ve, dentro del período. Se limita a lo que el
     * registro respalda: inicios de reproducción, no tiempo visto ni finalización,
     * porque de eso no hay un dato fiable en esta base.
     */
    async function topActividad({ periodo = 30, limite = 10, productorId = null } = {}) {
        const v = ventana(periodo);
        const n = Math.min(50, Math.max(1, parseInt(limite, 10) || 10));
        const args = [v.desde, v.hasta];
        if (productorId && productorId !== '__sin__') args.push(productorId);
        const delCliente = soloDelCliente(productorId, 'w');
        const clases = (await q(`
            SELECT w.video_id,
                   COALESCE(cat.title, '(clase eliminada)') AS titulo,
                   COALESCE(c.name, '') AS formacion,
                   count(DISTINCT (w.user_id, date_trunc('minute', ${fecha('w.created_at')})))::int AS inicios,
                   count(DISTINCT w.user_id)::int AS alumnos
            FROM watermark_logs w
            LEFT JOIN catalog cat ON cat.video_id = w.video_id
            LEFT JOIN courses c   ON c.id = cat.course_id
            WHERE ${fecha('w.created_at')} >= $1 AND ${fecha('w.created_at')} < $2 ${delCliente}
            GROUP BY w.video_id, cat.title, c.name
            ORDER BY inicios DESC, titulo
            LIMIT ${n}`, args)).rows;

        const alumnos = (await q(`
            SELECT w.user_id,
                   COALESCE(s.name, s.email, '(cuenta eliminada)') AS nombre,
                   count(DISTINCT (w.video_id, date_trunc('minute', ${fecha('w.created_at')})))::int AS inicios,
                   count(DISTINCT w.video_id)::int AS clases,
                   max(${fecha('w.created_at')}) AS ultima
            FROM watermark_logs w
            LEFT JOIN students s ON s.id = w.user_id OR lower(s.email) = lower(w.user_id)
            WHERE ${fecha('w.created_at')} >= $1 AND ${fecha('w.created_at')} < $2 ${delCliente}
            GROUP BY w.user_id, s.name, s.email
            ORDER BY inicios DESC, nombre
            LIMIT ${n}`, args)).rows;

        return {
            periodo: v.etiqueta, productorId: productorId || null,
            calidad: CALIDAD.DERIVADO, fuente: 'watermark_logs',
            clases: clases.map(c => ({
                videoId: c.video_id, titulo: c.titulo,
                formacion: c.formacion || null, inicios: c.inicios, alumnos: c.alumnos,
            })),
            alumnos: alumnos.map(a => ({
                nombre: a.nombre, inicios: a.inicios, clases: a.clases, ultima: a.ultima || null,
            })),
            nota: 'Se cuentan inicios de reproducción, no minutos vistos ni clases terminadas: eso no queda registrado.',
        };
    }

    /** Detalle de una formación: sus cifras y sus clases con actividad. */
    async function detalleFormacion(courseId, { periodo = 30 } = {}) {
        const v = ventana(periodo);
        const cab = (await q(`
            SELECT c.id, c.name, c.author, c.created_at, c.producer_id,
                   COALESCE(p.name, p.email) AS productor
            FROM courses c LEFT JOIN producers p ON p.id = c.producer_id
            WHERE c.id = $1`, [courseId])).rows[0];
        if (!cab) return null;

        const clases = (await q(`
            SELECT cat.video_id, cat.title, cat.status, cat.source_type, cat.module_id,
                   m.name AS modulo,
                   COALESCE(a.inicios, 0) AS inicios,
                   a.ultima
            FROM catalog cat
            LEFT JOIN modules m ON m.id = cat.module_id
            LEFT JOIN (
                SELECT video_id,
                       count(DISTINCT (user_id, video_id, date_trunc('minute', ${fecha('created_at')})))::int AS inicios,
                       max(${fecha('created_at')}) AS ultima
                FROM watermark_logs
                WHERE ${fecha('created_at')} >= $2 AND ${fecha('created_at')} < $3
                GROUP BY video_id
            ) a ON a.video_id = cat.video_id
            WHERE cat.course_id = $1
            ORDER BY cat.sort_order, cat.title`, [courseId, v.desde, v.hasta])).rows;

        const lic = (await q(`
            SELECT count(*)::int AS total,
                   count(*) FILTER (WHERE status = 'active')::int AS activas,
                   count(DISTINCT student_id) FILTER (WHERE status = 'active' AND student_id IS NOT NULL)::int AS alumnos
            FROM licenses WHERE course_id = $1`, [courseId])).rows[0];

        return {
            id: cab.id, nombre: cab.name, autor: cab.author,
            productor: cab.productor || null, sinProductor: !cab.producer_id,
            creadoEn: cab.created_at, periodo: v.etiqueta,
            licencias: { total: lic.total, activas: lic.activas },
            alumnosConAcceso: lic.alumnos,
            clases: clases.map(c => ({
                videoId: c.video_id, titulo: c.title, estado: c.status,
                origen: c.source_type, modulo: c.modulo || null,
                iniciosPeriodo: c.inicios, ultimaActividad: c.ultima || null,
            })),
            nota: 'No se muestran claves de licencia ni identificadores remotos del proveedor.',
        };
    }

    return {
        CALIDAD, metrica, ventana,
        clientes, cuentasRegistradas, usuariosActivos, formaciones,
        licencias, inicios, clases, almacenamiento,
        resumenHome, listaFormaciones, ORDENES,
        altas, licenciasAsignadas, resumenAnalitica, serieActividad,
        listaProductores, detalleFormacion, topActividad, resolverPeriodo,
    };
}

module.exports = { createAdminAnalytics, CALIDAD, resolverPeriodo };
