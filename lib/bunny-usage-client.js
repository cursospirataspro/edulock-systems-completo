'use strict';
/*
 * Adaptador de SOLO LECTURA sobre la API de Bunny para las cifras de consumo.
 *
 * Todo lo que sale de aquí lleva su origen pegado, porque no todo vale lo mismo:
 * lo que Bunny cobra este mes es una cifra suya y se puede afirmar; el reparto
 * de ese cobro entre bibliotecas lo calculamos nosotros y es una aproximación.
 * Mezclar las dos cosas sería la forma más fácil de que alguien tome una
 * decisión de dinero creyendo que tiene un dato exacto.
 *
 * Este módulo no crea, no borra y no modifica nada en el proveedor: solo GET.
 */

const https = require('https');

const HOST = 'api.bunny.net';
const GIGA = 1024 * 1024 * 1024;

/*
 * Motivos por los que una lectura puede no estar disponible. Se distinguen
 * porque cada uno se arregla de una manera distinta, y decirle al dueño «no
 * disponible» a secas cuando lo que pasa es que su cuenta no tiene saldo sería
 * mandarle a buscar un fallo que no está en el código.
 */
const MOTIVOS = {
    SIN_CLAVE: 'sin_clave',
    CLAVE_RECHAZADA: 'clave_rechazada',
    SIN_SALDO: 'sin_saldo',
    LIMITE: 'limite_de_peticiones',
    PROVEEDOR_CAIDO: 'proveedor_no_responde',
    RESPUESTA_RARA: 'respuesta_inesperada',
};

class ErrorDeProveedor extends Error {
    constructor(motivo, mensaje, estado = null) {
        super(mensaje);
        this.name = 'ErrorDeProveedor';
        this.motivo = motivo;
        this.estado = estado;
    }
}

/** Traduce el código HTTP al motivo que le sirve a quien lo va a leer. */
function motivoDe(estado, cuerpo) {
    if (estado === 401 || estado === 403) return MOTIVOS.CLAVE_RECHAZADA;
    if (estado === 402 || /insufficient_balance/i.test(cuerpo || '')) return MOTIVOS.SIN_SALDO;
    if (estado === 429) return MOTIVOS.LIMITE;
    if (estado >= 500) return MOTIVOS.PROVEEDOR_CAIDO;
    return MOTIVOS.RESPUESTA_RARA;
}

const numero = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * @param {object} opciones
 * @param {() => Promise<string>} opciones.obtenerClave  devuelve la Account API Key
 * @param {number} [opciones.tiempoLimite]  milisegundos por petición
 * @param {number} [opciones.reintentos]    reintentos ante fallo transitorio
 * @param {Function} [opciones.peticion]    inyectable en pruebas
 */
function createBunnyUsageClient({ obtenerClave, tiempoLimite = 20000, reintentos = 2, peticion = null } = {}) {
    if (typeof obtenerClave !== 'function') {
        throw new Error('bunny-usage-client necesita obtenerClave()');
    }

    const dormir = ms => new Promise(r => setTimeout(r, ms));

    function peticionReal(ruta, clave) {
        return new Promise((resolve, reject) => {
            const req = https.request(
                { method: 'GET', hostname: HOST, path: ruta, timeout: tiempoLimite,
                  headers: { AccessKey: clave, Accept: 'application/json' } },
                res => {
                    let cuerpo = '';
                    res.on('data', c => { cuerpo += c; });
                    res.on('end', () => resolve({ estado: res.statusCode, cuerpo }));
                });
            req.on('timeout', () => req.destroy(new Error('tiempo de espera agotado')));
            req.on('error', reject);
            req.end();
        });
    }

    /*
     * Una petición con reintentos. Solo se reintenta lo que puede arreglarse
     * solo (corte de red, 5xx, 429); una clave rechazada o una cuenta sin saldo
     * no mejoran por insistir, y reintentarlas solo retrasa el aviso.
     */
    async function pedir(ruta) {
        const clave = (await obtenerClave()) || '';
        if (!clave) throw new ErrorDeProveedor(MOTIVOS.SIN_CLAVE, 'No hay Account API Key configurada.');

        const hacer = peticion || peticionReal;
        let ultimo = null;
        for (let intento = 0; intento <= reintentos; intento++) {
            if (intento) await dormir(Math.min(4000, 400 * 2 ** (intento - 1)));
            let r;
            try {
                r = await hacer(ruta, clave);
            } catch (e) {
                ultimo = new ErrorDeProveedor(MOTIVOS.PROVEEDOR_CAIDO, e.message);
                continue;
            }
            if (r.estado >= 200 && r.estado < 300) {
                try {
                    return JSON.parse(r.cuerpo);
                } catch (_) {
                    throw new ErrorDeProveedor(MOTIVOS.RESPUESTA_RARA,
                        'La respuesta del proveedor no era JSON.', r.estado);
                }
            }
            const motivo = motivoDe(r.estado, r.cuerpo);
            // El cuerpo puede traer la clave repetida o datos de la cuenta: no se guarda.
            ultimo = new ErrorDeProveedor(motivo, 'El proveedor respondió ' + r.estado + '.', r.estado);
            if (motivo !== MOTIVOS.PROVEEDOR_CAIDO && motivo !== MOTIVOS.LIMITE) throw ultimo;
        }
        throw ultimo;
    }

    const fecha = d => new Date(d).toISOString().slice(0, 10);

    // ── Lecturas ────────────────────────────────────────────────────────────

    /** Lo que el proveedor dice que cuesta este mes. Es su cifra, no la nuestra. */
    async function facturacion() {
        const b = await pedir('/billing');
        return {
            saldo: numero(b.Balance),
            disponible: numero(b.AvailableBalance),
            cargosDelMes: numero(b.ThisMonthCharges),
            porConcepto: {
                almacenamiento: numero(b.MonthlyChargesStorage),
                traficoEU: numero(b.MonthlyChargesEUTraffic),
                traficoUS: numero(b.MonthlyChargesUSTraffic),
                traficoASIA: numero(b.MonthlyChargesASIATraffic),
                traficoAF: numero(b.MonthlyChargesAFTraffic),
                traficoSA: numero(b.MonthlyChargesSATraffic),
                codificacion: numero(b.MonthlyChargesPremiumEncoding),
                transcripcion: numero(b.MonthlyChargesTranscribe),
            },
            moneda: 'EUR',
        };
    }

    /** Uso por biblioteca de vídeo. Es lo que permite repartir por formación. */
    async function bibliotecas() {
        const salida = [];
        for (let pagina = 1; pagina <= 20; pagina++) {
            const r = await pedir(`/videolibrary?page=${pagina}&perPage=100`);
            for (const l of r.Items || []) {
                salida.push({
                    id: String(l.Id),
                    nombre: l.Name || '',
                    videos: numero(l.VideoCount) || 0,
                    almacenamientoBytes: numero(l.StorageUsage) || 0,
                    traficoBytes: numero(l.TrafficUsage) || 0,
                    zonaDeAlmacenamiento: l.StorageZoneId ? String(l.StorageZoneId) : null,
                });
            }
            if (!r.HasMoreItems) break;
        }
        return salida;
    }

    /** Zonas de almacenamiento. Aquí viven los contenedores .edu. */
    async function zonasDeAlmacenamiento() {
        const zonas = await pedir('/storagezone');
        // Nunca se copian Password ni ReadOnlyPassword: no hacen falta para medir
        // y guardarlas las dejaría escritas en la base y en los registros.
        return (Array.isArray(zonas) ? zonas : []).map(z => ({
            id: String(z.Id),
            nombre: z.Name || '',
            bytes: numero(z.StorageUsed) || 0,
            archivos: numero(z.FilesStored) || 0,
            region: z.Region || null,
        }));
    }

    /** Tráfico y costo del mes por pull zone, tal como los cobra el proveedor. */
    async function usoPorPullZone() {
        const r = await pedir('/billing/summary');
        return (Array.isArray(r) ? r : []).map(x => ({
            pullZoneId: String(x.PullZoneId),
            bytes: numero(x.MonthlyBandwidthUsed) || 0,
            costo: numero(x.MonthlyUsage) || 0,
        }));
    }

    /** Serie diaria de tráfico servido. */
    async function estadisticas({ desde, hasta }) {
        const r = await pedir(`/statistics?dateFrom=${fecha(desde)}&dateTo=${fecha(hasta)}`);
        const grafico = r.BandwidthUsedChart || {};
        return {
            bytesTotales: numero(r.TotalBandwidthUsed) || 0,
            peticiones: numero(r.TotalRequestsServed) || 0,
            tasaDeAcierto: numero(r.CacheHitRate),
            serie: Object.keys(grafico).sort().map(k => ({
                dia: String(k).slice(0, 10),
                bytes: numero(grafico[k]) || 0,
            })),
        };
    }

    /**
     * Tarifas por región. Se guardan con la fecha en que se leyeron para poder
     * recalcular un mes pasado con el precio que regía entonces, y no con el de
     * hoy: si el proveedor sube el precio, el histórico no debe cambiar solo.
     */
    async function tarifas() {
        const regiones = await pedir('/region');
        return (Array.isArray(regiones) ? regiones : []).map(r => ({
            codigo: r.RegionCode || String(r.Id),
            nombre: r.Name || '',
            continente: r.ContinentCode || null,
            pais: r.CountryCode || null,
            precioPorGb: numero(r.PricePerGigabyte),
        })).filter(r => r.precioPorGb !== null);
    }

    /** Una comprobación barata de que la cuenta responde. */
    async function comprobar() {
        await pedir('/storagezone');
        return true;
    }

    return {
        MOTIVOS, GIGA,
        facturacion, bibliotecas, zonasDeAlmacenamiento,
        usoPorPullZone, estadisticas, tarifas, comprobar,
    };
}

module.exports = { createBunnyUsageClient, ErrorDeProveedor, MOTIVOS, GIGA };
