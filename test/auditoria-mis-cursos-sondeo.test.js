'use strict';
// F09: la consulta silenciosa de "Mis Cursos" en el reproductor de PC.
// Se ejecuta el archivo real del reproductor sobre un DOM mínimo simulado, de modo
// que se prueba el mismo código que se distribuye, no una copia.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'player-app', 'renderer', 'courses-drawer.js'), 'utf8');

/** DOM mínimo: lo justo que el archivo necesita para arrancar y reaccionar. */
function crearDom() {
    const oyentesDocumento = new Map();
    const nuevoElemento = id => ({
        id, hidden: true, textContent: '', style: {}, dataset: {},
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {},
        replaceChildren() {}, appendChild() {}, append() {},
        querySelectorAll: () => [], querySelector: () => null,
        setAttribute() {}, removeAttribute() {},
    });
    const elementos = new Map();
    for (const id of ['btn-courses', 'courses-drawer', 'courses-backdrop', 'courses-tree',
                      'courses-status', 'btn-resources', 'courses-close', 'courses-refresh', 'btn-logout']) {
        elementos.set(id, nuevoElemento(id));
    }
    const document = {
        getElementById: id => elementos.get(id) || null,
        createElement: nuevoElemento,
        addEventListener(tipo, fn) { (oyentesDocumento.get(tipo) || oyentesDocumento.set(tipo, []).get(tipo)).push(fn); },
        dispatch(tipo, detail) { for (const fn of oyentesDocumento.get(tipo) || []) fn({ type: tipo, detail }); },
    };
    return { document, elementos, oyentesDocumento };
}

/** Ejecuta el archivo con un servidor simulado y control del reloj. */
function montar({ respuestas }) {
    const { document, elementos } = crearDom();
    const llamadas = [];
    let resolverPendiente = null;
    const temporizadores = [];
    const api = {
        async getResourceCatalog() {
            llamadas.push(Date.now());
            const siguiente = respuestas.shift();
            if (typeof siguiente === 'function') return siguiente();
            if (siguiente === 'pendiente') return new Promise(resolve => { resolverPendiente = resolve; });
            return siguiente;
        },
        onSecurityBlocked() {}, onStopPlayback() {}, onLicenseRegenerated() {},
    };
    const contexto = vm.createContext({
        window: { vcbPlayer: api, addEventListener() {} },
        document,
        CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
        setTimeout: (fn, ms) => { const t = { fn, ms, cancelado: false }; temporizadores.push(t); return t; },
        clearTimeout: t => { if (t) t.cancelado = true; },
        console,
        Date,
        Math,
    });
    contexto.window.document = document;
    vm.runInContext(source, contexto);
    const correr = () => {
        const pendientes = temporizadores.splice(0, temporizadores.length);
        for (const t of pendientes) if (!t.cancelado) t.fn();
    };
    return { elementos, llamadas, correr, document, resolver: valor => resolverPendiente && resolverPendiente(valor) };
}

const ok = habilitado => ({ ok: true, catalog: { embeddedCatalogEnabled: habilitado } });

test('F09: la consulta silenciosa enciende el botón cuando el productor lo habilitó', async () => {
    const m = montar({ respuestas: [ok(true)] });
    assert.equal(m.elementos.get('btn-courses').hidden, true, 'al arrancar el botón está oculto');
    m.correr();                               // vence el temporizador inicial
    await new Promise(r => setImmediate(r));
    assert.equal(m.elementos.get('btn-courses').hidden, false);
    assert.equal(m.llamadas.length, 1, 'una sola consulta');
});

test('F09: una respuesta que llega tarde tras cerrar sesión no vuelve a encender el botón', async () => {
    const m = montar({ respuestas: ['pendiente'] });
    m.correr();                               // arranca la consulta, que se queda en vuelo
    await new Promise(r => setImmediate(r));
    // El alumno cierra sesión mientras la respuesta viaja.
    m.document.dispatch('edulock:video-changed', { videoId: '' });
    const botonCerrar = m.elementos.get('btn-logout');
    m.document.dispatch('edulock:session-changed', { loggedIn: false });
    // Ahora llega la respuesta antigua diciendo que estaba habilitado.
    m.resolver(ok(true));
    await new Promise(r => setImmediate(r));
    assert.equal(m.elementos.get('btn-courses').hidden, true,
        'una respuesta de la sesión anterior no puede reabrir el panel');
    assert.ok(botonCerrar);
});

test('F09: un fallo de conexión al arrancar se reintenta, sin bucle ni consultas duplicadas', async () => {
    const fallo = () => { throw new Error('sin red'); };
    const m = montar({ respuestas: [fallo, fallo, ok(true)] });
    m.correr(); await new Promise(r => setImmediate(r));
    assert.equal(m.llamadas.length, 1);
    assert.equal(m.elementos.get('btn-courses').hidden, true);

    m.correr(); await new Promise(r => setImmediate(r));      // primer reintento
    assert.equal(m.llamadas.length, 2);

    m.correr(); await new Promise(r => setImmediate(r));      // segundo reintento: ya responde
    assert.equal(m.llamadas.length, 3);
    assert.equal(m.elementos.get('btn-courses').hidden, false);
});

test('F09: los reintentos son limitados y no siguen para siempre', async () => {
    const fallo = () => { throw new Error('sin red'); };
    const m = montar({ respuestas: [fallo, fallo, fallo, fallo, fallo, fallo] });
    for (let i = 0; i < 8; i++) { m.correr(); await new Promise(r => setImmediate(r)); }
    assert.ok(m.llamadas.length <= 4, 'como mucho el intento inicial y tres reintentos, no un bucle: ' + m.llamadas.length);
    assert.equal(m.elementos.get('btn-courses').hidden, true);
});

test('F09: al cambiar la sesión se vuelve a preguntar en vez de conservar lo de antes', async () => {
    const m = montar({ respuestas: [ok(false), ok(true)] });
    m.correr(); await new Promise(r => setImmediate(r));
    assert.equal(m.elementos.get('btn-courses').hidden, true);
    m.document.dispatch('edulock:session-changed', { loggedIn: true });
    m.correr(); await new Promise(r => setImmediate(r));
    assert.equal(m.llamadas.length, 2, 'el cambio de sesión provoca una consulta nueva');
    assert.equal(m.elementos.get('btn-courses').hidden, false);
});

test('F09: el archivo del reproductor emite el evento de sesión que escucha el panel', () => {
    const player = fs.readFileSync(path.join(__dirname, '..', 'player-app', 'renderer', 'player.js'), 'utf8');
    assert.ok(player.includes("edulock:session-changed"),
        'player.js debe emitir el evento; si no, la escucha del panel sería código muerto');
    assert.ok(source.includes("addEventListener('edulock:session-changed'"));
});
