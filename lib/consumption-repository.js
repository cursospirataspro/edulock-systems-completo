'use strict';
/*
 * Guarda y lee lo que el recolector trae del proveedor.
 *
 * Tres cosas viven aquí:
 *
 *  1. Snapshots. Cada lectura se guarda con su instante, su unidad, su fuente y
 *     su calidad. No se sobrescribe la anterior: el consumo es una serie, y sin
 *     historia no se puede decir «esto subió» ni recalcular un mes cerrado.
 *  2. Tarifas versionadas. Se guarda una fila nueva SOLO cuando el precio de una
 *     región cambia. Así un mes pasado se puede recalcular con el precio que
 *     regía entonces y no con el de hoy: si el proveedor sube la tarifa, el
 *     histórico no puede cambiar solo.
 *  3. Estado del trabajo de sincronización, con arriendo. Dos procesos (dos
 *     instancias, un reinicio a medias) no pueden recolectar a la vez: se
 *     duplicarían los snapshots y las cifras se leerían el doble de altas.
 */

const CALIDADES = new Set(['medido', 'derivado', 'estimado', 'parcial', 'no_disponible']);

function createConsumptionRepository({ db }) {
    if (!db || !db.pool) throw new Error('consumption-repository necesita la capa de base de datos');
    const q = (sql, params = []) => db.pool.query(sql, params);

    /*
     * El esquema se crea con IF NOT EXISTS, igual que el resto de la base, para
     * que arrancar contra una base ya poblada no falle ni pierda nada.
     */
    async function asegurarEsquema() {
        await q(`CREATE TABLE IF NOT EXISTS consumption_snapshots (
            id BIGSERIAL PRIMARY KEY,
            tomado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            tanda TEXT NOT NULL,
            ambito TEXT NOT NULL,
            ambito_id TEXT,
            metrica TEXT NOT NULL,
            valor NUMERIC,
            unidad TEXT NOT NULL,
            calidad TEXT NOT NULL,
            fuente TEXT NOT NULL,
            detalle JSONB
        )`);
        await q(`CREATE INDEX IF NOT EXISTS idx_consumo_metrica
                 ON consumption_snapshots (metrica, ambito, ambito_id, tomado_en DESC)`);
        await q(`CREATE INDEX IF NOT EXISTS idx_consumo_tanda ON consumption_snapshots (tanda)`);

        await q(`CREATE TABLE IF NOT EXISTS consumption_rates (
            id BIGSERIAL PRIMARY KEY,
            vigente_desde TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            codigo_region TEXT NOT NULL,
            nombre TEXT,
            continente TEXT,
            pais TEXT,
            precio_gb NUMERIC NOT NULL,
            moneda TEXT NOT NULL DEFAULT 'EUR'
        )`);
        await q(`CREATE INDEX IF NOT EXISTS idx_tarifas_region
                 ON consumption_rates (codigo_region, vigente_desde DESC)`);

        await q(`CREATE TABLE IF NOT EXISTS consumption_sync (
            job TEXT PRIMARY KEY,
            dueno TEXT,
            arrendado_hasta TIMESTAMPTZ,
            ultimo_intento TIMESTAMPTZ,
            ultimo_ok TIMESTAMPTZ,
            ultimo_error TEXT,
            ultimo_motivo TEXT,
            intentos BIGINT NOT NULL DEFAULT 0,
            fallos BIGINT NOT NULL DEFAULT 0
        )`);
    }

    // ── Snapshots ───────────────────────────────────────────────────────────

    /**
     * Escribe una tanda entera en UNA transacción. O entra toda o no entra
     * ninguna: media tanda daría un resumen con unas cifras de ahora y otras de
     * hace una hora, y nadie podría saber cuáles son cuáles.
     */
    async function guardarSnapshots(tanda, filas) {
        const buenas = (filas || []).filter(f => f && f.metrica && f.unidad);
        if (!buenas.length) return 0;
        for (const f of buenas) {
            if (!CALIDADES.has(f.calidad)) {
                throw new Error('calidad desconocida en la métrica ' + f.metrica + ': ' + f.calidad);
            }
        }
        const cli = await db.pool.connect();
        try {
            await cli.query('BEGIN');
            for (const f of buenas) {
                await cli.query(
                    `INSERT INTO consumption_snapshots
                        (tanda, ambito, ambito_id, metrica, valor, unidad, calidad, fuente, detalle)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                    [tanda, f.ambito || 'cuenta', f.ambitoId || null, f.metrica,
                     f.valor === null || f.valor === undefined ? null : String(f.valor),
                     f.unidad, f.calidad, f.fuente || 'bunny',
                     f.detalle ? JSON.stringify(f.detalle) : null]);
            }
            await cli.query('COMMIT');
            return buenas.length;
        } catch (e) {
            await cli.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            cli.release();
        }
    }

    /** La lectura más reciente de cada métrica dentro de un ámbito. */
    async function ultimasMetricas({ ambito = 'cuenta', ambitoId = null } = {}) {
        const filas = (await q(`
            SELECT DISTINCT ON (metrica, ambito_id)
                   metrica, ambito, ambito_id, valor, unidad, calidad, fuente, detalle, tomado_en
            FROM consumption_snapshots
            WHERE ambito = $1 AND ($2::text IS NULL OR ambito_id = $2)
            ORDER BY metrica, ambito_id, tomado_en DESC`, [ambito, ambitoId])).rows;
        return filas.map(normalizar);
    }

    /*
     * Cuántas lecturas hay y cuál es la más reciente, mirando TODOS los ámbitos.
     * Preguntarlo solo por el de cuenta haría que, si falla la facturación pero
     * sí se leen las bibliotecas, la página dijera «no hay datos» teniéndolos.
     */
    async function resumenDeFrescura() {
        const f = (await q(`SELECT count(*)::int AS total, max(tomado_en) AS ultima
                            FROM consumption_snapshots`)).rows[0] || {};
        return { total: Number(f.total || 0), ultima: f.ultima || null };
    }

    /** Serie histórica de una métrica, para ver cómo evoluciona. */
    async function serieDeMetrica({ metrica, ambito = 'cuenta', ambitoId = null, desde, hasta }) {
        const filas = (await q(`
            SELECT tomado_en, valor, unidad, calidad, fuente
            FROM consumption_snapshots
            WHERE metrica = $1 AND ambito = $2
              AND ($3::text IS NULL OR ambito_id = $3)
              AND tomado_en >= $4 AND tomado_en < $5
            ORDER BY tomado_en`, [metrica, ambito, ambitoId, desde, hasta])).rows;
        return filas.map(f => ({
            tomadoEn: f.tomado_en,
            valor: f.valor === null ? null : Number(f.valor),
            unidad: f.unidad, calidad: f.calidad, fuente: f.fuente,
        }));
    }

    function normalizar(f) {
        return {
            metrica: f.metrica, ambito: f.ambito, ambitoId: f.ambito_id,
            valor: f.valor === null ? null : Number(f.valor),
            unidad: f.unidad, calidad: f.calidad, fuente: f.fuente,
            detalle: f.detalle || null, tomadoEn: f.tomado_en,
        };
    }

    // ── Tarifas versionadas ─────────────────────────────────────────────────

    /**
     * Guarda solo las regiones cuyo precio cambió respecto a la última versión.
     * Escribirlas todas cada hora llenaría la tabla de copias idénticas y haría
     * imposible ver de un vistazo cuándo cambió un precio de verdad.
     */
    async function guardarTarifas(tarifas) {
        const vigentes = new Map();
        for (const t of await tarifasVigentes()) vigentes.set(t.codigo, t.precioPorGb);
        const cambiadas = (tarifas || []).filter(t =>
            t && t.codigo && Number.isFinite(Number(t.precioPorGb)) &&
            vigentes.get(t.codigo) !== Number(t.precioPorGb));
        for (const t of cambiadas) {
            await q(`INSERT INTO consumption_rates
                        (codigo_region, nombre, continente, pais, precio_gb, moneda)
                     VALUES ($1,$2,$3,$4,$5,$6)`,
                [t.codigo, t.nombre || null, t.continente || null, t.pais || null,
                 String(t.precioPorGb), t.moneda || 'EUR']);
        }
        return cambiadas.length;
    }

    /** Las tarifas que regían en un instante dado; por omisión, ahora. */
    async function tarifasVigentes(en = null) {
        const filas = (await q(`
            SELECT DISTINCT ON (codigo_region)
                   codigo_region, nombre, continente, pais, precio_gb, moneda, vigente_desde
            FROM consumption_rates
            WHERE ($1::timestamptz IS NULL OR vigente_desde <= $1)
            ORDER BY codigo_region, vigente_desde DESC`, [en])).rows;
        return filas.map(f => ({
            codigo: f.codigo_region, nombre: f.nombre, continente: f.continente, pais: f.pais,
            precioPorGb: Number(f.precio_gb), moneda: f.moneda, vigenteDesde: f.vigente_desde,
        }));
    }

    /** Historial de cambios de precio de una región. */
    async function historialDeTarifa(codigo) {
        const filas = (await q(`
            SELECT precio_gb, moneda, vigente_desde FROM consumption_rates
            WHERE codigo_region = $1 ORDER BY vigente_desde DESC LIMIT 50`, [codigo])).rows;
        return filas.map(f => ({
            precioPorGb: Number(f.precio_gb), moneda: f.moneda, vigenteDesde: f.vigente_desde,
        }));
    }

    // ── Arriendo del trabajo de sincronización ──────────────────────────────

    /**
     * Toma el arriendo si está libre o si el anterior ya venció. Es una sola
     * sentencia atómica a propósito: comprobar y después escribir dejaría un
     * hueco por el que dos procesos podrían entrar los dos.
     */
    async function tomarArriendo(job, dueno, segundos = 300) {
        await q(`INSERT INTO consumption_sync (job) VALUES ($1) ON CONFLICT (job) DO NOTHING`, [job]);
        const r = await q(`
            UPDATE consumption_sync
               SET dueno = $2,
                   arrendado_hasta = NOW() + ($3 || ' seconds')::interval,
                   ultimo_intento = NOW(),
                   intentos = intentos + 1
             WHERE job = $1
               AND (arrendado_hasta IS NULL OR arrendado_hasta < NOW())
         RETURNING job`, [job, dueno, String(Math.max(30, segundos))]);
        return r.rowCount === 1;
    }

    /** Suelta el arriendo y deja escrito cómo acabó el intento. */
    async function liberarArriendo(job, dueno, resultado = {}) {
        const ok = resultado.ok !== false;
        await q(`
            UPDATE consumption_sync
               SET arrendado_hasta = NULL,
                   dueno = NULL,
                   ultimo_ok = CASE WHEN $3 THEN NOW() ELSE ultimo_ok END,
                   ultimo_error = CASE WHEN $3 THEN NULL ELSE $4 END,
                   ultimo_motivo = CASE WHEN $3 THEN NULL ELSE $5 END,
                   fallos = CASE WHEN $3 THEN fallos ELSE fallos + 1 END
             WHERE job = $1 AND (dueno = $2 OR dueno IS NULL)`,
            [job, dueno, ok, (resultado.error || '').slice(0, 300) || null, resultado.motivo || null]);
    }

    async function estadoDeSincronizacion(job) {
        const f = (await q(`SELECT * FROM consumption_sync WHERE job = $1`, [job])).rows[0];
        if (!f) return { job, nuncaEjecutado: true };
        return {
            job,
            nuncaEjecutado: !f.ultimo_intento,
            enCurso: !!(f.arrendado_hasta && new Date(f.arrendado_hasta) > new Date()),
            ultimoIntento: f.ultimo_intento,
            ultimoOk: f.ultimo_ok,
            ultimoError: f.ultimo_error,
            ultimoMotivo: f.ultimo_motivo,
            intentos: Number(f.intentos),
            fallos: Number(f.fallos),
        };
    }

    /*
     * Los snapshots crecen sin parar. Se conservan por omisión 400 días: cubre
     * un año entero de comparaciones y no deja la tabla engordando para siempre.
     */
    async function purgar(diasAConservar = 400) {
        const r = await q(`DELETE FROM consumption_snapshots
                           WHERE tomado_en < NOW() - ($1 || ' days')::interval`,
            [String(Math.max(30, diasAConservar))]);
        return r.rowCount;
    }

    return {
        asegurarEsquema,
        guardarSnapshots, ultimasMetricas, serieDeMetrica, resumenDeFrescura,
        guardarTarifas, tarifasVigentes, historialDeTarifa,
        tomarArriendo, liberarArriendo, estadoDeSincronizacion, purgar,
    };
}

module.exports = { createConsumptionRepository, CALIDADES };
