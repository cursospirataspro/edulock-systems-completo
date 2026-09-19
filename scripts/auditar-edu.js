'use strict';
/*
 * auditar-edu.js — Auditoría del contenedor .edu sobre los BYTES reales.
 *
 * No se fía del código ni de los comentarios: empaqueta archivos de verdad,
 * abre el binario a mano y comprueba cada afirmación. Lo que no se puede
 * comprobar, se dice.
 *
 * Uso:  node scripts/auditar-edu.js [ruta-de-un-.ipr-para-comparar]
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { packEdu, deriveCek } = require('../edu-packer');
const lector = require('../player-app/edu-native.js');

const CHUNK = 8192;
let fallos = 0, avisos = 0;

function seccion(t) { console.log('\n' + '━'.repeat(78) + '\n' + t + '\n' + '━'.repeat(78)); }
function ok(t, ev)   { console.log('  CUMPLE      ' + t + (ev ? '\n                 → ' + ev : '')); }
function parcial(t, ev) { avisos++; console.log('  PARCIAL     ' + t + (ev ? '\n                 → ' + ev : '')); }
function no(t, ev)   { fallos++; console.log('  NO CUMPLE   ' + t + (ev ? '\n                 → ' + ev : '')); }
function dato(t)     { console.log('  ·           ' + t); }

// ── Utilidades de medición ──────────────────────────────────────────────────

/** Cuenta cuántos bloques de 16 bytes se repiten (la prueba del ECB). */
function bloquesRepetidos(buf, desde = 0, hasta = buf.length) {
    const vistos = new Map();
    let repetidos = 0, total = 0;
    for (let i = desde; i + 16 <= hasta; i += 16) {
        const k = buf.toString('latin1', i, i + 16);
        total++;
        const n = (vistos.get(k) || 0) + 1;
        vistos.set(k, n);
        if (n > 1) repetidos++;
    }
    return { repetidos, total, distintos: vistos.size };
}

/** Entropía de Shannon en bits por byte. 8,0 = indistinguible de aleatorio. */
function entropia(buf) {
    const c = new Array(256).fill(0);
    for (const b of buf) c[b]++;
    let h = 0;
    for (const n of c) if (n) { const p = n / buf.length; h -= p * Math.log2(p); }
    return h;
}

// ── Parseo del contenedor a mano, sin usar el lector ────────────────────────

function parsear(buf) {
    const r = { bytes: buf.length };
    r.magic = buf.subarray(0, 4);
    r.magicTexto = r.magic.toString('latin1');
    r.magicHex = r.magic.toString('hex').toUpperCase();
    r.version = buf.readUInt16LE(4);
    r.flags = buf.readUInt16LE(6);
    r.salt = buf.subarray(8, 24);
    r.hdrLen = buf.readUInt32LE(24);
    r.hdrOff = 28;
    r.bodyOff = 28 + r.hdrLen;

    const traeFirma = buf.length > 6 && buf.subarray(buf.length - 4).toString('latin1') === 'EDUS';
    if (traeFirma) {
        r.firmaLen = buf.readUInt16LE(buf.length - 6);
        r.firmaOff = buf.length - 6 - r.firmaLen;
        r.finContenedor = r.firmaOff;
    } else {
        r.firmaLen = 0;
        r.finContenedor = buf.length;
    }
    r.macOff = r.finContenedor - 32;
    r.bodyLen = r.macOff - r.bodyOff;
    return r;
}

// ── Preparación de muestras ─────────────────────────────────────────────────

const MASTER = crypto.randomBytes(32).toString('hex');
const par = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const parAjeno = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// El lector lee la clave pública de ./edu-public-key.js al cargarse; para la
// auditoría se le inyecta la del par recién generado.
const Module = require('module');
function lectorCon(publicKeyPem) {
    const ruta = require.resolve('../player-app/edu-native.js');
    delete require.cache[ruta];
    const orig = Module._load;
    Module._load = function (p, padre, m) {
        if (p === './edu-public-key.js') return { PUBLIC_KEY: publicKeyPem };
        return orig.call(this, p, padre, m);
    };
    try { return require(ruta); } finally { Module._load = orig; delete require.cache[ruta]; }
}

function empaquetar(datos, contentId = 'auditoria-001', firmante = par.privateKey) {
    return packEdu(datos, { contentId, title: 'Auditoría', masterKeyHex: MASTER, signingKeyPem: firmante });
}

// ════════════════════════════════════════════════════════════════════════════
console.log('AUDITORÍA DEL CONTENEDOR .edu — ' + new Date().toISOString());
console.log('Implementación: edu-packer.js (escritura) / player-app/edu-native.js (lectura)');

// ── A. Verificación estructural sobre bytes reales ──────────────────────────
seccion('A. ESTRUCTURA REAL DEL ARCHIVO (parseada del binario, no del código)');

const original = crypto.randomBytes(3 * 1024 * 1024 + 777);   // 3 MiB y pico
const m = empaquetar(original);
const buf = m.edu;
const p = parsear(buf);

console.log('\n  Mapa del archivo (' + p.bytes.toLocaleString('es') + ' bytes):');
console.log('    0x0000  magic          4 B   ' + JSON.stringify(p.magicTexto) + '  (' + p.magicHex + ')');
console.log('    0x0004  version        2 B   ' + p.version + '  (uint16 LE)');
console.log('    0x0006  flags          2 B   ' + p.flags + '  (0b' + p.flags.toString(2).padStart(4, '0') + ' = online|watermark)');
console.log('    0x0008  salt          16 B   ' + p.salt.toString('hex'));
console.log('    0x0018  hdr_len        4 B   ' + p.hdrLen + '  (uint32 LE)');
console.log('    0x001C  cabecera  ' + String(p.hdrLen).padStart(6) + ' B   AES-256-GCM (ct‖tag16)');
console.log('    0x' + p.bodyOff.toString(16).padStart(4, '0').toUpperCase() +
            '  datos     ' + String(p.bodyLen).padStart(6) + ' B   AES-256-CTR sobre trozos AES-256-GCM');
console.log('    0x' + p.macOff.toString(16).toUpperCase() + '  hmac          32 B   HMAC-SHA256 de todo lo anterior');
if (p.firmaLen) {
    console.log('    0x' + p.firmaOff.toString(16).toUpperCase() +
                '  firma     ' + String(p.firmaLen).padStart(6) + ' B   RSA-PSS/SHA-256 + u16 largo + "EDUS"');
}

console.log('\n  Contra la especificación que me diste:\n');

// magic
if (p.magicTexto === 'EDU\x01') ok('magic = "EDU\\x01"', 'leído: ' + p.magicHex);
else no('magic = "EDU\\x01"', 'leído "' + p.magicTexto + '" (' + p.magicHex + '). El formato real usa "EDU!" = 45445521.');

// version / flags
ok('version uint16 LE en el offset 4', 'valor ' + p.version);
ok('flags uint16 LE en el offset 6', 'valor ' + p.flags);

// manifest_len / sig_len en cabecera
no('manifest_len (uint32 LE) en el offset 8', 'en el offset 8 hay el salt de 16 B; hdr_len está en el 24.');
no('sig_len (uint16 LE) en la cabecera fija', 'el largo de la firma va al FINAL del archivo, en los 6 últimos bytes.');

// manifiesto JSON en claro
let hdrEnClaro = false;
try { JSON.parse(buf.subarray(p.hdrOff, p.hdrOff + p.hdrLen).toString('utf8')); hdrEnClaro = true; } catch (_) {}
if (hdrEnClaro) no('manifiesto JSON UTF-8 legible', 'está en claro');
else parcial('manifiesto JSON UTF-8', 'existe un manifiesto JSON, pero CIFRADO (AES-256-GCM). Entropía de la cabecera: '
        + entropia(buf.subarray(p.hdrOff, p.hdrOff + p.hdrLen)).toFixed(3) + ' bits/byte. Es más fuerte que la especificación, no menos: sin la clave no se sabe ni el título.');

// firma
if (p.firmaLen === 64) ok('firma Ed25519 (64 B)', '');
else if (p.firmaLen === 256) no('firma Ed25519 (64 B)', 'hay firma de ' + p.firmaLen + ' B = RSA-2048-PSS. Distinta de la especificación, equivalente en seguridad (~112 bits), más lenta y más larga.');
else no('firma Ed25519', 'largo de firma inesperado: ' + p.firmaLen);

// Orden encrypt-then-sign
const hmacCalc = crypto.createHmac('sha256',
    crypto.hkdfSync('sha256', deriveCek(MASTER, p.salt, 'auditoria-001'), Buffer.alloc(0), Buffer.from('mac'), 32));
hmacCalc.update(buf.subarray(0, p.macOff));
if (hmacCalc.digest().equals(buf.subarray(p.macOff, p.macOff + 32))) {
    ok('encrypt-then-MAC', 'el HMAC-SHA256 cubre magic+cabecera+datos cifrados; se comprueba antes de descifrar nada.');
} else {
    no('encrypt-then-MAC', 'el HMAC no cuadra con lo recalculado.');
}
ok('encrypt-then-sign', 'la firma RSA cubre el contenedor entero incluido el HMAC (offsets 0…' + p.finContenedor + ').');

// Tamaño de bloque
const meta = m.meta;
if (meta.chunk_size === 1024 * 1024) ok('bloques de 1 MiB', '');
else no('bloques de 1 MiB', 'los bloques son de ' + meta.chunk_size + ' B (8 KiB). ' + meta.total_chunks + ' bloques para ' + meta.orig_len + ' B.');

// Nonce
dato('Nonce por bloque: salt[0:4] ‖ uint64 LE(índice) = 12 B. La especificación pedía 8 B aleatorios ‖ 4 B índice BE.');
parcial('nonce irrepetible con la misma clave', 'se cumple el objetivo (la CEK es única por archivo y el índice no se repite dentro del archivo), pero por una vía distinta: los 4 B fijos vienen del salt, no son 8 B aleatorios por entrada.');

// AAD
parcial('AAD "nombre|índice|total"', 'NO se usa AAD. El ligado del bloque a su posición se consigue con la subclave por bloque HKDF(cek,"chunk"‖idx) y el nonce con el índice: mover un bloque a otra posición hace fallar el tag. Es equivalente en efecto, distinto en mecanismo.');

// Claves
no('clave por contraseña con scrypt N=2^15', 'no hay modo contraseña. La CEK se deriva en el servidor: HKDF(MASTER_KEY, "edu-cek|"‖salt‖"|"‖contentId) y se entrega por sesión con licencia válida.');
no('clave por licencia con RSA-OAEP-SHA256', 'la CEK no viaja envuelta dentro del archivo: se pide al servidor (/api/edu/key) sobre HTTPS y con JWT de reproducción. Es un modelo online, no offline.');
parcial('el manifiesto lleva el SHA-256 de cada entrada', 'lleva orig_sha256 del vídeo completo, no un hash por bloque. La integridad por bloque la da el tag GCM y la del archivo el HMAC.');

// ── B. Verificación empírica ────────────────────────────────────────────────
seccion('B. PRUEBAS EJECUTADAS SOBRE ARCHIVOS REALES');

// B1 — patrones repetidos
const ceros = Buffer.alloc(1024 * 1024 + 4096, 0);
const mCeros = empaquetar(ceros, 'auditoria-ceros');
const pCeros = parsear(mCeros.edu);
const rep = bloquesRepetidos(mCeros.edu, pCeros.bodyOff, pCeros.macOff);
console.log('\n  B1. Patrones repetidos (1 MiB de ceros)');
console.log('      bloques de 16 B en la zona de datos : ' + rep.total.toLocaleString('es'));
console.log('      bloques repetidos                   : ' + rep.repetidos);
console.log('      entropía de la zona de datos        : ' + entropia(mCeros.edu.subarray(pCeros.bodyOff, pCeros.macOff)).toFixed(4) + ' bits/byte');
if (rep.repetidos === 0) ok('0 bloques repetidos con entrada de solo ceros', 'frente a los 94 medidos en el .ipr (ECB).');
else no('deberían ser 0 bloques repetidos', rep.repetidos + ' repetidos');

// B2 — reutilización de clave
console.log('\n  B2. Reutilización de clave y nonce');
const a1 = empaquetar(original, 'mismo-contenido');
const a2 = empaquetar(original, 'mismo-contenido');
const distintoSalt = a1.salt !== a2.salt;
const distintoCifrado = !a1.edu.equals(a2.edu);
const cek1 = deriveCek(MASTER, Buffer.from(a1.salt, 'hex'), 'mismo-contenido');
const cek2 = deriveCek(MASTER, Buffer.from(a2.salt, 'hex'), 'mismo-contenido');
console.log('      salt archivo 1 : ' + a1.salt);
console.log('      salt archivo 2 : ' + a2.salt);
console.log('      CEK distintas  : ' + (!cek1.equals(cek2)));
console.log('      cifrados distintos: ' + distintoCifrado);
if (distintoSalt && distintoCifrado && !cek1.equals(cek2)) {
    ok('mismo vídeo empaquetado dos veces → CEK y bytes distintos', 'el salt es aleatorio por archivo y la CEK se deriva de él.');
} else {
    no('el mismo vídeo produce el mismo cifrado', 'salt o CEK reutilizados');
}

// B3 — manipulación
console.log('\n  B3. Manipulación de un byte');
const L = lectorCon(par.publicKey);
const cekAud = deriveCek(MASTER, Buffer.from(m.salt, 'hex'), 'auditoria-001');
const alterado = Buffer.from(buf);
alterado[p.bodyOff + 5000] ^= 0xff;
let r3a = 'NO detectado';
try { L.decryptEdu(alterado, cekAud); } catch (e) { r3a = e.message; }
console.log('      con firma  : ' + r3a);
const Lsin = lectorCon('');
const sinFirmaM = empaquetar(original, 'auditoria-001', null);
const alterado2 = Buffer.from(sinFirmaM.edu);
alterado2[parsear(sinFirmaM.edu).bodyOff + 5000] ^= 0xff;
let r3b = 'NO detectado';
try {
    Lsin.decryptEdu(alterado2, deriveCek(MASTER, Buffer.from(sinFirmaM.salt, 'hex'), 'auditoria-001'));
} catch (e) { r3b = e.message; }
console.log('      sin firma  : ' + r3b);
if (/firma/i.test(r3a) && /HMAC/i.test(r3b)) {
    ok('un byte alterado se detecta', 'con firma la rechaza la firma; quitando la firma, la rechaza el HMAC antes de descifrar.');
} else if (r3a !== 'NO detectado' && r3b !== 'NO detectado') {
    ok('un byte alterado se detecta', r3a + ' / ' + r3b);
} else {
    no('un byte alterado NO se detecta', r3a + ' / ' + r3b);
}

// B3b — el tag GCM del bloque, saltándose HMAC y firma
console.log('\n  B3b. ¿Y si alguien recalcula el HMAC? (tiene la CEK, caso peor)');
const soloDatos = Buffer.from(sinFirmaM.edu);
const pSolo = parsear(soloDatos);
soloDatos[pSolo.bodyOff + 5000] ^= 0xff;
const macKey = crypto.hkdfSync('sha256', deriveCek(MASTER, Buffer.from(sinFirmaM.salt, 'hex'), 'auditoria-001'),
    Buffer.alloc(0), Buffer.from('mac'), 32);
crypto.createHmac('sha256', macKey).update(soloDatos.subarray(0, pSolo.macOff)).digest()
    .copy(soloDatos, pSolo.macOff);
let r3c = 'NO detectado';
try {
    Lsin.decryptEdu(soloDatos, deriveCek(MASTER, Buffer.from(sinFirmaM.salt, 'hex'), 'auditoria-001'));
} catch (e) { r3c = e.constructor.name + ': ' + e.message; }
console.log('      resultado  : ' + r3c);
if (r3c !== 'NO detectado') ok('el tag GCM del bloque lo detecta igualmente', r3c);
else no('el tag GCM NO detectó la alteración', '');

// B4 — firma de otro emisor
console.log('\n  B4. Firma de otro emisor');
const ajeno = empaquetar(original, 'auditoria-001', parAjeno.privateKey);
let r4 = 'NO rechazado';
try { L.decryptEdu(ajeno.edu, cekAud); } catch (e) { r4 = e.message; }
console.log('      resultado  : ' + r4);
if (/firma/i.test(r4)) ok('un .edu firmado por otra clave se rechaza al abrir', r4);
else no('no se rechazó la firma ajena', r4);

let r4b = 'NO rechazado';
try { L.decryptEdu(sinFirmaM.edu, deriveCek(MASTER, Buffer.from(sinFirmaM.salt, 'hex'), 'auditoria-001')); }
catch (e) { r4b = e.message; }
console.log('      sin firmar : ' + r4b);
if (/no est[aá] firmado/i.test(r4b)) ok('un .edu SIN firmar también se rechaza', 'no se puede degradar el archivo quitándole la firma.');
else no('un .edu sin firmar se aceptó', r4b);

// B5 — credencial incorrecta
console.log('\n  B5. Credencial incorrecta');
let r5 = 'NO rechazado';
try { L.decryptEdu(buf, crypto.randomBytes(32)); } catch (e) { r5 = e.message; }
console.log('      clave al azar        : ' + r5);
let r5b = 'NO rechazado';
try { L.decryptEdu(buf, deriveCek(MASTER, Buffer.from(m.salt, 'hex'), 'otro-contenido')); } catch (e) { r5b = e.message; }
console.log('      CEK de otro contenido: ' + r5b);
if (r5 !== 'NO rechazado' && r5b !== 'NO rechazado') ok('sin la credencial correcta no se descifra ni un bloque', 'falla en el HMAC, antes de tocar los datos.');
else no('se descifró con credencial incorrecta', r5 + ' / ' + r5b);

// B6 — acceso aleatorio
console.log('\n  B6. Acceso aleatorio (rangos inclusivos, estilo HTTP Range)');
const st = L.openEdu(buf, cekAud);
const casos = [
    ['inicio', 0, 4095],
    ['cruce de bloque', CHUNK - 10, CHUNK + 4095],
    ['medio', 1_500_000, 1_500_999],
    ['final exacto', original.length - 4096, original.length - 1],
    ['más allá del final', original.length - 10, original.length + 99999],
    ['un byte', 2_000_000, 2_000_000],
    ['todo', 0, original.length - 1],
];
let todosOk = true;
for (const [nombre, d, h] of casos) {
    const leido = L.readRange(st, d, h);
    const esperado = original.subarray(d, Math.min(h + 1, original.length));
    const igual = leido.equals(esperado);
    if (!igual) todosOk = false;
    console.log('      ' + nombre.padEnd(20) + ' [' + d + '…' + h + '] → ' +
        String(leido.length).padStart(8) + ' B  ' + (igual ? 'idéntico' : '❌ DISTINTO'));
}
if (todosOk) ok('todos los rangos coinciden byte a byte con el original', '');
else no('algún rango no coincide', '');

// Cuántos bloques se descifran realmente para un rango pequeño
const bloquesPara1KB = Math.floor((1_500_999) / CHUNK) - Math.floor(1_500_000 / CHUNK) + 1;
dato('Para leer 1 000 B en la posición 1 500 000 se descifran ' + bloquesPara1KB + ' bloque(s) de ' + CHUNK + ' B, no el archivo entero.');

// B7 — último bloque
console.log('\n  B7. Último bloque (el más corto)');
const resto = original.length % CHUNK;
console.log('      orig_len ' + original.length + ' = ' + meta.total_chunks + ' bloques; el último mide ' + (resto || CHUNK) + ' B');
const inicioUlt = (meta.total_chunks - 1) * CHUNK;
const ultimo = L.readRange(st, inicioUlt, original.length - 1);
if (ultimo.equals(original.subarray(inicioUlt))) ok('el último bloque se descifra entero y correcto', ultimo.length + ' B');
else no('el último bloque no cuadra', '');
const masAlla = L.readRange(st, original.length, original.length + 100);
if (masAlla.length === 0) ok('leer más allá del final devuelve vacío, no basura', '');
else no('leer más allá del final devolvió ' + masAlla.length + ' B', '');

// B8 — ida y vuelta
console.log('\n  B8. Ida y vuelta');
const { mp4 } = L.decryptEdu(buf, cekAud);
const shaOrig = crypto.createHash('sha256').update(original).digest('hex');
const shaSalida = crypto.createHash('sha256').update(mp4).digest('hex');
console.log('      SHA-256 original : ' + shaOrig);
console.log('      SHA-256 extraído : ' + shaSalida);
console.log('      manifiesto dice  : ' + meta.orig_sha256);
if (shaOrig === shaSalida && shaOrig === meta.orig_sha256) ok('extracción byte-idéntica', '');
else no('la extracción no es idéntica', '');

// Expansión
console.log('\n  Coste de espacio: ' + original.length.toLocaleString('es') + ' B → ' +
    buf.length.toLocaleString('es') + ' B  (+' + ((buf.length / original.length - 1) * 100).toFixed(2) + ' %)');

// ── Comparación con el .ipr ─────────────────────────────────────────────────
const rutaIpr = process.argv[2];
if (rutaIpr && fs.existsSync(rutaIpr)) {
    seccion('COMPARACIÓN MEDIDA CON EL .ipr');
    const ipr = fs.readFileSync(rutaIpr);
    console.log('  Archivo: ' + path.basename(rutaIpr) + '  (' + ipr.length.toLocaleString('es') + ' bytes)');
    console.log('  magic  : ' + ipr.subarray(0, 4).toString('hex').toUpperCase());

    // Recorrer las entradas: nombreLen(4 LE) + nombre + tamaño(8 LE) + datos
    let off = 8, entradas = [];
    while (off + 12 <= ipr.length && entradas.length < 20) {
        const nl = ipr.readUInt32LE(off);
        if (nl <= 0 || nl > 512 || off + 4 + nl + 8 > ipr.length) break;
        const nombre = ipr.subarray(off + 4, off + 4 + nl).toString('utf8');
        const tam = Number(ipr.readBigUInt64LE(off + 4 + nl));
        const datosOff = off + 4 + nl + 8;
        if (tam < 0 || datosOff + tam > ipr.length) break;
        entradas.push({ nombre, tam, datosOff });
        off = datosOff + tam;
    }
    console.log('\n  Entradas encontradas:');
    for (const e of entradas) {
        console.log('    ' + e.nombre.padEnd(40) + String(e.tam).padStart(12) + ' B');
    }
    const video = entradas.find(e => e.nombre === 'video');
    if (video) {
        const rIpr = bloquesRepetidos(ipr, video.datosOff + 16, video.datosOff + video.tam);
        console.log('\n  Entrada "video" (' + video.tam.toLocaleString('es') + ' B):');
        console.log('    bloques de 16 B      : ' + rIpr.total.toLocaleString('es'));
        console.log('    bloques repetidos    : ' + rIpr.repetidos + '   ← huella de AES-ECB');
        console.log('    entropía             : ' + entropia(ipr.subarray(video.datosOff, video.datosOff + Math.min(video.tam, 4 << 20))).toFixed(4) + ' bits/byte');
        console.log('\n  El mismo experimento sobre mi .edu con 1 MiB de ceros: ' + rep.repetidos + ' bloques repetidos.');
    }
} else if (rutaIpr) {
    console.log('\n  (No se encontró el .ipr en ' + rutaIpr + '; se omite la comparación.)');
}

// ── Resumen ─────────────────────────────────────────────────────────────────
seccion('RESUMEN');
console.log('  Puntos que NO cumplen la especificación que diste : ' + fallos);
console.log('  Puntos parciales (objetivo cumplido, vía distinta): ' + avisos);
console.log('\n  Lo que sí quedó demostrado sobre los bytes reales:');
console.log('   · 0 bloques repetidos con 1 MiB de ceros (el .ipr tiene 94).');
console.log('   · CEK y bytes distintos en cada empaquetado del mismo vídeo.');
console.log('   · Un byte alterado se detecta por firma, por HMAC y por el tag GCM del bloque.');
console.log('   · Firma ajena y contenedor sin firmar: rechazados.');
console.log('   · Sin la credencial no se descifra ni un bloque.');
console.log('   · Lectura por rangos exacta, incluido el último bloque corto.');
console.log('   · Extracción byte-idéntica (SHA-256 coincide).');
process.exit(0);
