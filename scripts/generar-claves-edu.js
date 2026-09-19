'use strict';
/**
 * Genera las claves del formato .edu:
 *
 *   1. EDU_MASTER_KEY — clave maestra de la que se deriva la clave de cada
 *      contenido. Va en el .env del SERVIDOR y no sale de ahí nunca.
 *   2. Pareja RSA-2048 — la privada firma los contenedores en el servidor; la
 *      pública se incrusta en LOS DOS reproductores para comprobar esa firma.
 *
 * Uso:  node scripts/generar-claves-edu.js [ruta-de-la-clave-privada]
 *
 * Escribe:
 *   - la clave PRIVADA en un archivo PEM (por defecto data/edu-signing.pem, con
 *     permisos 600). El servidor la lee con EDU_SIGNING_KEY_FILE.
 *   - la clave PÚBLICA en player-app/edu-public-key.js (reproductor de PC) y en
 *     player-apk-android/.../edu/EduKeys.kt (reproductor de Android).
 * Imprime la línea de EDU_MASTER_KEY que hay que pegar en el .env.
 *
 * Importante: si algún día se cambian estas claves, los .edu ya publicados dejan
 * de poder abrirse. No se rotan a la ligera.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const destinoPublica = path.join(raiz, 'player-app', 'edu-public-key.js');
const destinoAndroid = path.join(raiz, 'player-apk-android', 'app', 'src', 'main',
    'kotlin', 'com', 'edulock', 'player', 'edu', 'EduKeys.kt');
const destinoPrivadaPorDefecto = path.join(raiz, 'data', 'edu-signing.pem');

function generar() {
    const master = crypto.randomBytes(32).toString('hex');           // 64 caracteres
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { master, publicKey, privateKey };
}

// Clave pública para el reproductor de PC (módulo de Node).
function escribirClavePublica(pem) {
    const lineas = [
        "'use strict';",
        '// Clave PUBLICA del servidor para comprobar la firma de los contenedores .edu.',
        '// Generada por scripts/generar-claves-edu.js. Se puede publicar sin riesgo:',
        '// sirve para COMPROBAR firmas, no para crearlas.',
        'module.exports = { PUBLIC_KEY: ' + JSON.stringify(pem) + ' };',
        '',
    ];
    fs.writeFileSync(destinoPublica, lineas.join('\n'), 'utf8');
}

// La misma clave pública, para el reproductor de Android (constante de Kotlin).
function escribirClavePublicaAndroid(pem) {
    const lineas = [
        'package com.edulock.player.edu',
        '',
        '/**',
        ' * Clave PÚBLICA del servidor, usada para comprobar la firma de los contenedores',
        ' * .edu. La escribe scripts/generar-claves-edu.js al generar la pareja de claves.',
        ' *',
        ' * Se puede publicar sin riesgo: sirve para COMPROBAR firmas, no para crearlas.',
        ' * Vacía = no se comprueba la firma (solo para desarrollo).',
        ' */',
        'object EduKeys {',
        // JSON.stringify produce una cadena con comillas y \n escapados, que es
        // exactamente la sintaxis que Kotlin espera para un literal de una línea.
        '    const val PUBLIC_KEY: String = ' + JSON.stringify(pem),
        '}',
        '',
    ];
    fs.writeFileSync(destinoAndroid, lineas.join('\n'), 'utf8');
}

function escribirClavePrivada(pem, destino) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, pem, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(destino, 0o600); } catch (_) { /* en Windows no aplica */ }
}

if (require.main === module) {
    const destinoPrivada = process.argv[2] || destinoPrivadaPorDefecto;
    if (fs.existsSync(destinoPrivada)) {
        console.error('Ya existe ' + destinoPrivada + '.');
        console.error('Si la sobrescribes, los .edu firmados con la clave anterior dejarán de abrirse.');
        console.error('Bórrala a mano si de verdad quieres generar una pareja nueva.');
        process.exit(1);
    }

    const { master, publicKey, privateKey } = generar();
    escribirClavePublica(publicKey);
    escribirClavePublicaAndroid(publicKey);
    escribirClavePrivada(privateKey, destinoPrivada);

    console.log('Claves del formato .edu generadas.\n');
    console.log('── Pon esto en el .env del servidor ' + '─'.repeat(40));
    console.log('EDU_MASTER_KEY=' + master);
    console.log('EDU_SIGNING_KEY_FILE=' + destinoPrivada);
    console.log('\n── Escrito en disco ' + '─'.repeat(56));
    console.log('privada (NO publicar, permisos 600): ' + destinoPrivada);
    console.log('pública (reproductor de PC)        : ' + destinoPublica);
    console.log('pública (reproductor de Android)   : ' + destinoAndroid);
    console.log('\nHay que recompilar LOS DOS reproductores para que lleven la clave nueva.');
}

module.exports = { generar, escribirClavePublica, escribirClavePublicaAndroid, escribirClavePrivada };
