'use strict';
/*
 * Consumo y costos del proveedor de vídeo.
 *
 * Reglas que manda el diseño de la analítica, y que aquí importan más que en
 * ningún otro sitio porque de estas cifras salen decisiones de dinero:
 *
 *  · Lo que el proveedor cobra es MEDIDO: es su cifra, no la nuestra.
 *  · El reparto de ese cobro entre formaciones es DERIVADO: lo calculamos
 *    nosotros repartiendo por peso, y se dice.
 *  · Lo que no se ha podido leer es NO DISPONIBLE con su motivo, nunca cero.
 *    Un cero en una factura se lee como «no gastaste nada», que es lo contrario
 *    de «no lo pude comprobar».
 *  · La cuenta del proveedor tiene contenido que no es de Edulock. Ese consumo
 *    se declara aparte y no se reparte entre los clientes: cobrarle a alguien
 *    un tráfico que no generó sería peor que no tener la cifra.
 */

const JOB = 'consumo-proveedor';
const GIGA = 1024 * 1024 * 1024;

const CALIDAD = {
    MEDIDO: 'medido',
    DERIVADO: 'derivado',
    ESTIMADO: 'estimado',
    PARCIAL: 'parcial',
    NO_DISPONIBLE: 'no_disponible',
};

/** Cada cuánto se considera que una lectura dejó de ser fresca. */
const HORAS_HASTA_CADUCAR = 6;

function createConsumptionService({ db, cliente, repositorio, ahora = () => new Date(), logger = console }) {
    if (!db || !db.pool) throw new Error('consumption-service necesita la capa de base de datos');
    if (!cliente) throw new Error('consumption-service necesita el cliente del proveedor');
    if (!repositorio) throw new Error('consumption-service necesita el repositorio');
    const q = (sql, params = []) => db.pool.query(sql, params);

    // ── Recolección ─────────────────────────────────────────────────────────

    /**
     * Una pasada completa. Devuelve qué se pudo leer y qué no; nunca lanza por
     * un fallo del proveedor, porque un proveedor caído no es un fallo del
     * servidor y no debe dejar rastro de excepción en los registros.
     */
    async function sincronizar({ dueno = 'servidor', segundosDeArriendo = 300 } = {}) {
        await repositorio.asegurarEsquema();
        if (!await repositorio.tomarArriendo(JOB, dueno, segundosDeArriendo)) {
            return { hecho: false, motivo: 'ya_en_curso',
                     nota: 'Otra ejecución tiene el arriendo; no se recolecta dos veces a la vez.' };
        }

        const tanda = ahora().toISOString() + '#' + Math.random().toString(36).slice(2, 8);
        const filas = [];
        const fallos = [];
        const hasta = ahora();
        const desde = new Date(hasta.getTime() - 30 * 24 * 3600 * 1000);

        // Cada lectura va por su cuenta: que la facturación falle no puede
        // impedir que se guarde el almacenamiento, que sí se pudo leer.
        const intentar = async (nombre, fn) => {
            try { return await fn(); }
            catch (e) {
                fallos.push({ lectura: nombre, motivo: e.motivo || 'error', mensaje: e.message });
                return null;
            }
        };

        const facturacion = await intentar('facturacion', () => cliente.facturacion());
        if (facturacion) {
            filas.push(metricaCuenta('cargos_del_mes', facturacion.cargosDelMes, facturacion.moneda,
                { porConcepto: facturacion.porConcepto }));
            filas.push(metricaCuenta('saldo', facturacion.saldo, facturacion.moneda));
            filas.push(metricaCuenta('saldo_disponible', facturacion.disponible, facturacion.moneda));
            for (const [concepto, valor] of Object.entries(facturacion.porConcepto || {})) {
                filas.push(metricaCuenta('cargos_' + concepto, valor, facturacion.moneda));
            }
        }

        const bibliotecas = await intentar('bibliotecas', () => cliente.bibliotecas());
        if (bibliotecas) {
            for (const b of bibliotecas) {
                const detalle = { nombre: b.nombre, videos: b.videos };
                filas.push(metrica('biblioteca', b.id, 'almacenamiento_bytes', b.almacenamientoBytes, 'bytes', detalle));
                filas.push(metrica('biblioteca', b.id, 'trafico_bytes', b.traficoBytes, 'bytes', detalle));
                filas.push(metrica('biblioteca', b.id, 'videos', b.videos, 'videos', detalle));
            }
            filas.push(metricaCuenta('bibliotecas', bibliotecas.length, 'bibliotecas'));
        }

        const zonas = await intentar('zonas', () => cliente.zonasDeAlmacenamiento());
        if (zonas) {
            for (const z of zonas) {
                const detalle = { nombre: z.nombre, region: z.region };
                filas.push(metrica('zona', z.id, 'almacenamiento_bytes', z.bytes, 'bytes', detalle));
                filas.push(metrica('zona', z.id, 'archivos', z.archivos, 'archivos', detalle));
            }
        }

        const pullzones = await intentar('pullzones', () => cliente.usoPorPullZone());
        if (pullzones) {
            for (const p of pullzones) {
                if (!p.bytes && !p.costo) continue;   // 84 zonas, casi todas en cero
                filas.push(metrica('pullzone', p.pullZoneId, 'trafico_bytes', p.bytes, 'bytes'));
                filas.push(metrica('pullzone', p.pullZoneId, 'costo_del_mes', p.costo, 'EUR'));
            }
        }

        const stats = await intentar('estadisticas', () => cliente.estadisticas({ desde, hasta }));
        if (stats) {
            filas.push(metricaCuenta('trafico_bytes_30d', stats.bytesTotales, 'bytes',
                { peticiones: stats.peticiones, tasaDeAcierto: stats.tasaDeAcierto }));
            filas.push(metricaCuenta('peticiones_30d', stats.peticiones, 'peticiones'));
        }

        let tarifasNuevas = 0;
        const tarifas = await intentar('tarifas', () => cliente.tarifas());
        if (tarifas) tarifasNuevas = await repositorio.guardarTarifas(tarifas);

        let guardadas = 0;
        let errorAlGuardar = null;
        try {
            guardadas = await repositorio.guardarSnapshots(tanda, filas);
        } catch (e) {
            errorAlGuardar = e;
            logger.error('[consumo] no se pudieron guardar los snapshots:', e.message);
        }

        // Se considera un fallo si no entró NADA. Si entró parte, la pasada
        // sirvió: es mejor media foto fechada que ninguna.
        const ok = !errorAlGuardar && guardadas > 0;
        await repositorio.liberarArriendo(JOB, dueno, {
            ok,
            error: errorAlGuardar ? errorAlGuardar.message
                 : (fallos.length ? fallos.map(f => f.lectura + ': ' + f.motivo).join('; ') : null),
            motivo: errorAlGuardar ? 'error_al_guardar' : (fallos[0] ? fallos[0].motivo : null),
        });

        return { hecho: ok, tanda, guardadas, tarifasNuevas, fallos, lecturasConDatos: contarLecturas(filas) };
    }

    const contarLecturas = filas => new Set(filas.map(f => f.ambito + ':' + f.metrica)).size;

    function metrica(ambito, ambitoId, nombre, valor, unidad, detalle = null) {
        return {
            ambito, ambitoId, metrica: nombre,
            valor: valor === null || valor === undefined ? null : valor,
            unidad,
            // Todo lo de esta función viene tal cual del proveedor.
            calidad: valor === null || valor === undefined ? CALIDAD.NO_DISPONIBLE : CALIDAD.MEDIDO,
            fuente: 'bunny', detalle,
        };
    }
    const metricaCuenta = (nombre, valor, unidad, detalle) =>
        metrica('cuenta', null, nombre, valor, unidad, detalle);

    // ── Lectura ─────────────────────────────────────────────────────────────

    /** Qué formación usa qué biblioteca, para poder repartir. */
    async function bibliotecasDeFormaciones() {
        const filas = (await q(`
            SELECT c.id, c.name, c.bunny_library_id, c.producer_id,
                   COALESCE(p.name, p.email) AS productor
            FROM courses c LEFT JOIN producers p ON p.id = c.producer_id
            WHERE c.bunny_library_id IS NOT NULL AND c.bunny_library_id <> ''`)).rows;
        const porBiblioteca = new Map();
        for (const f of filas) {
            const k = String(f.bunny_library_id);
            if (!porBiblioteca.has(k)) porBiblioteca.set(k, []);
            porBiblioteca.get(k).push({
                id: f.id, nombre: f.name, productor: f.productor || null, productorId: f.producer_id,
            });
        }
        return porBiblioteca;
    }

    /** Estado del recolector, con la frescura de lo último que trajo. */
    async function estado() {
        await repositorio.asegurarEsquema();
        const s = await repositorio.estadoDeSincronizacion(JOB);
        // La frescura se mide sobre TODAS las lecturas, no solo las de cuenta:
        // si falla la facturación pero sí se leen las bibliotecas, sigue habiendo
        // datos que enseñar y decir «no hay» sería falso.
        const { total, ultima } = await repositorio.resumenDeFrescura();
        const horas = ultima ? (ahora() - new Date(ultima)) / 3600000 : null;
        return {
            ...s,
            hayDatos: total > 0,
            lecturasGuardadas: total,
            datosDe: ultima,
            horasDeAntiguedad: horas === null ? null : Number(horas.toFixed(1)),
            fresco: horas !== null && horas <= HORAS_HASTA_CADUCAR,
        };
    }

    /**
     * Resumen de consumo y costos. Si el recolector nunca corrió, o corrió y
     * falló, se devuelve el motivo: no hay ninguna cifra que enseñar y decir
     * «0 €» sería mentir.
     */
    async function resumen() {
        const est = await estado();
        if (!est.hayDatos) {
            return {
                disponible: false,
                calidad: CALIDAD.NO_DISPONIBLE,
                motivo: est.nuncaEjecutado
                    ? 'El recolector de consumo todavía no ha llegado a ejecutarse.'
                    : 'Todavía no hay ninguna lectura guardada del proveedor.' +
                      (est.ultimoError ? ' Último intento: ' + est.ultimoError : ''),
                estado: est,
            };
        }

        const cuenta = new Map((await repositorio.ultimasMetricas({ ambito: 'cuenta' }))
            .map(m => [m.metrica, m]));
        const bibs = await repositorio.ultimasMetricas({ ambito: 'biblioteca' });
        const zonas = await repositorio.ultimasMetricas({ ambito: 'zona' });

        const almacenPorBiblioteca = porAmbito(bibs, 'almacenamiento_bytes');
        const traficoPorBiblioteca = porAmbito(bibs, 'trafico_bytes');
        const almacenPorZona = porAmbito(zonas, 'almacenamiento_bytes');

        const deFormaciones = await bibliotecasDeFormaciones();
        let bytesDeEdulock = 0, bytesFuera = 0, traficoEdulock = 0, traficoFuera = 0;
        for (const [id, bytes] of almacenPorBiblioteca) {
            if (deFormaciones.has(id)) bytesDeEdulock += bytes; else bytesFuera += bytes;
        }
        for (const [id, bytes] of traficoPorBiblioteca) {
            if (deFormaciones.has(id)) traficoEdulock += bytes; else traficoFuera += bytes;
        }
        const bytesTotales = bytesDeEdulock + bytesFuera;

        const cargos = cuenta.get('cargos_del_mes');
        const almacenamientoCobrado = cuenta.get('cargos_almacenamiento');

        return {
            disponible: true,
            datosDe: est.datosDe,
            fresco: est.fresco,
            horasDeAntiguedad: est.horasDeAntiguedad,
            moneda: 'EUR',
            estado: est,
            indicadores: {
                cargosDelMes: publicar(cargos, 'Lo que el proveedor lleva cobrado este mes. Es su cifra.'),
                saldo: publicar(cuenta.get('saldo'), 'Saldo de la cuenta en el proveedor.'),
                saldoDisponible: publicar(cuenta.get('saldo_disponible'), 'Saldo disponible para consumir.'),
                almacenamientoCobrado: publicar(almacenamientoCobrado,
                    'Parte del cobro del mes que corresponde a almacenamiento.'),
                traficoServido: publicar(cuenta.get('trafico_bytes_30d'),
                    'Bytes servidos por el proveedor en los últimos 30 días.'),
                peticiones: publicar(cuenta.get('peticiones_30d'), 'Peticiones servidas en 30 días.'),
            },
            almacenamiento: {
                totalBytes: bytesTotales,
                deEdulockBytes: bytesDeEdulock,
                fueraDeEdulockBytes: bytesFuera,
                bibliotecas: almacenPorBiblioteca.size,
                bibliotecasDeEdulock: [...almacenPorBiblioteca.keys()].filter(k => deFormaciones.has(k)).length,
                zonasDeAlmacenamientoBytes: [...almacenPorZona.values()].reduce((a, b) => a + b, 0),
                calidad: CALIDAD.MEDIDO,
                nota: 'Cifras del proveedor. La cuenta contiene bibliotecas que no pertenecen a ninguna formación de Edulock; ese consumo se declara aparte y no se reparte entre clientes.',
            },
            trafico: {
                deEdulockBytes: traficoEdulock,
                fueraDeEdulockBytes: traficoFuera,
                calidad: CALIDAD.MEDIDO,
                nota: 'Tráfico acumulado del mes por biblioteca, según el proveedor.',
            },
        };
    }

    const porAmbito = (filas, metricaNombre) => new Map(
        filas.filter(f => f.metrica === metricaNombre && f.valor !== null)
             .map(f => [String(f.ambitoId), Number(f.valor)]));

    function publicar(m, nota) {
        if (!m || m.valor === null) {
            return { valor: null, calidad: CALIDAD.NO_DISPONIBLE, nota: 'No se pudo leer del proveedor.' };
        }
        return {
            valor: m.valor, unidad: m.unidad, calidad: m.calidad,
            fuente: m.fuente, tomadoEn: m.tomadoEn, nota,
            detalle: m.detalle || undefined,
        };
    }

    /**
     * Reparto por formación. El almacenamiento de cada biblioteca es MEDIDO; el
     * dinero que se le imputa es DERIVADO, porque el proveedor cobra un total de
     * cuenta y aquí se reparte a prorrata del peso. Se dice en cada fila.
     */
    async function porFormacion() {
        const est = await estado();
        if (!est.hayDatos) {
            return { disponible: false, calidad: CALIDAD.NO_DISPONIBLE,
                     motivo: 'Todavía no hay lecturas del proveedor que repartir.', estado: est };
        }

        const bibs = await repositorio.ultimasMetricas({ ambito: 'biblioteca' });
        const almacen = porAmbito(bibs, 'almacenamiento_bytes');
        const trafico = porAmbito(bibs, 'trafico_bytes');
        const videos = porAmbito(bibs, 'videos');
        const nombres = new Map(bibs.filter(f => f.detalle && f.detalle.nombre)
            .map(f => [String(f.ambitoId), f.detalle.nombre]));

        const cuenta = new Map((await repositorio.ultimasMetricas({ ambito: 'cuenta' }))
            .map(m => [m.metrica, m]));
        const cobroAlmacen = (cuenta.get('cargos_almacenamiento') || {}).valor;
        const totalBytes = [...almacen.values()].reduce((a, b) => a + b, 0);

        const deFormaciones = await bibliotecasDeFormaciones();
        const formaciones = [];
        const fuera = [];

        for (const [idBiblioteca, bytes] of almacen) {
            const parte = totalBytes > 0 ? bytes / totalBytes : 0;
            const imputado = cobroAlmacen === null || cobroAlmacen === undefined
                ? null : Number((cobroAlmacen * parte).toFixed(4));
            const comun = {
                bibliotecaId: idBiblioteca,
                biblioteca: nombres.get(idBiblioteca) || null,
                almacenamientoBytes: bytes,
                traficoBytes: trafico.get(idBiblioteca) || 0,
                videos: videos.get(idBiblioteca) || 0,
                porcentajeDelAlmacenamiento: Number((parte * 100).toFixed(2)),
                costoImputado: imputado,
                calidadDelCosto: imputado === null ? CALIDAD.NO_DISPONIBLE : CALIDAD.DERIVADO,
            };
            const cursos = deFormaciones.get(idBiblioteca);
            if (cursos) {
                // Una biblioteca puede dar servicio a más de una formación. No se
                // duplica el costo: se declara compartido y se dice entre cuántas.
                for (const c of cursos) {
                    formaciones.push({
                        ...comun,
                        formacionId: c.id, formacion: c.nombre,
                        productor: c.productor, productorId: c.productorId,
                        compartidaCon: cursos.length > 1 ? cursos.length : null,
                    });
                }
            } else {
                fuera.push(comun);
            }
        }

        formaciones.sort((a, b) => b.almacenamientoBytes - a.almacenamientoBytes);
        fuera.sort((a, b) => b.almacenamientoBytes - a.almacenamientoBytes);

        return {
            disponible: true,
            datosDe: est.datosDe,
            moneda: 'EUR',
            cobroDeAlmacenamientoDelMes: cobroAlmacen === undefined ? null : cobroAlmacen,
            formaciones,
            fueraDeEdulock: fuera,
            nota: 'El almacenamiento y el tráfico por biblioteca son cifras del proveedor. El costo por formación es un reparto a prorrata del peso, no una factura por formación: el proveedor cobra por cuenta. Las bibliotecas que no pertenecen a ninguna formación se listan aparte y su consumo no se reparte.',
            calidad: CALIDAD.DERIVADO,
        };
    }

    /** Tarifas vigentes y cuándo cambiaron, para poder auditar un recálculo. */
    async function tarifas() {
        await repositorio.asegurarEsquema();
        const vigentes = await repositorio.tarifasVigentes();
        if (!vigentes.length) {
            return { disponible: false, calidad: CALIDAD.NO_DISPONIBLE,
                     motivo: 'Todavía no se han leído las tarifas del proveedor.' };
        }
        const porContinente = {};
        for (const t of vigentes) {
            const c = t.continente || 'sin continente';
            (porContinente[c] = porContinente[c] || []).push(t.precioPorGb);
        }
        return {
            disponible: true,
            calidad: CALIDAD.MEDIDO,
            moneda: vigentes[0].moneda,
            regiones: vigentes.length,
            porContinente: Object.fromEntries(Object.entries(porContinente).map(([c, ps]) => [c, {
                minimo: Math.min(...ps), maximo: Math.max(...ps), regiones: ps.length,
            }])),
            nota: 'Precio por gigabyte publicado por el proveedor. Se guarda una versión nueva solo cuando el precio cambia, para poder recalcular un mes pasado con la tarifa que regía entonces.',
        };
    }

    return { JOB, CALIDAD, GIGA, sincronizar, estado, resumen, porFormacion, tarifas };
}

module.exports = { createConsumptionService, CALIDAD, JOB };
