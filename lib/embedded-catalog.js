'use strict';
/**
 * "Mis Cursos" dentro del reproductor: capa opcional de navegación por productor.
 *
 * Esta pieza SOLO decide si el reproductor debe mostrar el panel. No concede acceso a
 * nada: cada reproducción y cada documento vuelven a pasar por la política de acceso
 * de siempre (licencia de la sesión, curso, dispositivo, productor). Con el interruptor
 * apagado —el valor por omisión de todos los productores— el reproductor se comporta
 * exactamente igual que antes de existir esta capa.
 *
 * El productor se deriva SIEMPRE de la sesión de contenido abierta del alumno, nunca de
 * un dato enviado por el cliente.
 */
function createEmbeddedCatalog({ db }) {
    if (!db) throw new TypeError('db is required');

    async function enabledFor(claims) {
        try {
            if (!claims || typeof claims !== 'object') return false;
            if (claims.admin === true) return false;          // el panel es para alumnos
            if (!claims.sub || !claims.sid) return false;
            // Un token que dice explicitamente que no tiene licencia no habilita el
            // panel aunque traiga el identificador de una sesion abierta. En la
            // practica el servidor no emite esa combinacion, pero no se depende de
            // ello: el interruptor comprueba tambien lo que afirma el propio token.
            if (claims.hasLicense === false) return false;
            if (typeof db.getContentSession !== 'function') return false;
            const session = await db.getContentSession(claims.sid);
            if (!session || session.ended_at) return false;    // sesión cerrada o inexistente
            if (session.student_id !== claims.sub) return false;
            if (claims.licenseId && session.license_id !== claims.licenseId) return false;
            const producerId = session.producer_id || null;
            if (!producerId) return false;                     // contenido sin productor: modo tradicional
            const producer = await db.getProducerById(producerId);
            if (!producer) return false;
            if (!(producer.active === 1 || producer.active === true)) return false;  // suspendido: nunca
            return producer.embedded_catalog_enabled === true;
        } catch { return false; }                              // ante cualquier duda, modo tradicional
    }

    return { enabledFor };
}

module.exports = { createEmbeddedCatalog };
