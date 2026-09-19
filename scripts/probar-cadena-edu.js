'use strict';
/*
 * probar-cadena-edu.js — Prueba de extremo a extremo con las claves REALES.
 *
 * Empaqueta un vídeo con la clave maestra y la clave de firma que usa el
 * servidor, y lo abre con la clave pública que llevan incrustada los dos
 * reproductores. Si esto pasa, un .edu creado por el servidor se abre en el PC
 * y en el teléfono; si falla, es que las claves no se corresponden.
 *
 * No imprime ninguna clave.
 *
 * Uso:  node scripts/probar-cadena-edu.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { packEdu, deriveCek } = require('../edu-packer');

function leerClaveDeFirma() {
    const ruta = process.env.EDU_SIGNING_KEY_FILE || '';
    if (!ruta) throw new Error('EDU_SIGNING_KEY_FILE no está en el .env');
    const abs = path.isAbsolute(ruta) ? ruta : path.join(__dirname, '..', ruta);
    if (!fs.existsSync(abs)) throw new Error('No existe la clave de firma: ' + abs);
    return fs.readFileSync(abs, 'utf8');
}

function main() {
    const master = process.env.EDU_MASTER_KEY || '';
    if (!/^[0-9a-f]{64}$/i.test(master.trim())) throw new Error('EDU_MASTER_KEY inválida o ausente en el .env');
    const firma = leerClaveDeFirma();

    // Clave pública tal y como la lleva cada reproductor.
    const publicaPC = require('../player-app/edu-public-key.js').PUBLIC_KEY;
    const kotlin = fs.readFileSync(path.join(__dirname, '..', 'player-apk-android', 'app', 'src', 'main',
        'kotlin', 'com', 'edulock', 'player', 'edu', 'EduKeys.kt'), 'utf8');
    const m = kotlin.match(/const val PUBLIC_KEY: String = "([\s\S]*?)"\s*$/m);
    const publicaAndroid = m ? JSON.parse('"' + m[1] + '"') : '';

    console.log('1. Claves cargadas');
    console.log('   EDU_MASTER_KEY       : presente y válida (64 hex)');
    console.log('   clave de firma       : ' + (firma.includes('PRIVATE KEY') ? 'PEM privado correcto' : 'NO es un PEM privado'));
    console.log('   pública en PC        : ' + (publicaPC.includes('PUBLIC KEY') ? 'presente' : 'AUSENTE'));
    console.log('   pública en Android   : ' + (publicaAndroid.includes('PUBLIC KEY') ? 'presente' : 'AUSENTE'));
    console.log('   ambas coinciden      : ' + (publicaPC.trim() === publicaAndroid.trim()));
    if (publicaPC.trim() !== publicaAndroid.trim()) throw new Error('Los dos reproductores llevan claves distintas');

    // 2. Empaquetar como lo haría el servidor al subir una clase.
    const original = crypto.randomBytes(512 * 1024 + 321);
    const contentId = 'prueba-cadena-' + crypto.randomBytes(3).toString('hex');
    const { edu, salt, firmado } = packEdu(original, {
        contentId, title: 'Prueba de cadena', masterKeyHex: master, signingKeyPem: firma,
    });
    console.log('\n2. Empaquetado por el servidor');
    console.log('   ' + original.length.toLocaleString('es') + ' B → ' + edu.length.toLocaleString('es') + ' B, firmado: ' + firmado);
    if (!firmado) throw new Error('el contenedor salió sin firmar');

    // 3. Abrirlo con la clave pública incrustada en el reproductor de PC.
    const lector = require('../player-app/edu-native.js');
    if (!lector.EDU_PUBLIC_KEY) throw new Error('el reproductor de PC no lleva clave pública');
    const cek = deriveCek(master, Buffer.from(salt, 'hex'), contentId);
    const { mp4 } = lector.decryptEdu(edu, cek);
    const igual = mp4.equals(original);
    console.log('\n3. Abierto por el reproductor de PC');
    console.log('   firma verificada y vídeo recuperado byte a byte: ' + igual);
    if (!igual) throw new Error('el vídeo recuperado no coincide');

    // 4. Un contenedor firmado por OTRA clave debe rechazarse.
    const ajeno = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const falso = packEdu(original, { contentId, title: 'Falso', masterKeyHex: master, signingKeyPem: ajeno.privateKey });
    let rechazado = false;
    try { lector.decryptEdu(falso.edu, deriveCek(master, Buffer.from(falso.salt, 'hex'), contentId)); }
    catch (e) { rechazado = /firma/i.test(e.message); }
    console.log('\n4. Contenedor firmado por otro emisor: ' + (rechazado ? 'rechazado' : 'ACEPTADO — MAL'));
    if (!rechazado) throw new Error('se aceptó una firma ajena');

    // 5. Dejar una muestra para que Android la abra con la misma clave real.
    const destino = path.join(__dirname, '..', 'player-apk-android', 'app', 'src', 'test', 'resources');
    fs.writeFileSync(path.join(destino, 'cadena-real.edu'), edu);
    fs.writeFileSync(path.join(destino, 'cadena-real.json'), JSON.stringify({
        contentId, salt, origLen: original.length,
        sha256: crypto.createHash('sha256').update(original).digest('hex'),
    }, null, 2));
    fs.writeFileSync(path.join(destino, 'cadena-real.bin'), original);
    console.log('\n5. Muestra firmada con la clave real escrita para la prueba de Android.');
    console.log('\nLa cadena completa funciona.');
}

main();
