'use strict';
/**
 * Genera un contenedor .edu de muestra para las pruebas del reproductor Android.
 *
 * El lector de Android está escrito en Kotlin y el empaquetador en Node: la única
 * forma de asegurar que hablan el mismo formato es que Android abra un archivo
 * producido de verdad por el servidor y le salga el original byte a byte. Eso es
 * lo que fabrica este script.
 *
 * Uso:  node scripts/generar-muestra-edu.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { packEdu } = require('../edu-packer');

const destino = path.join(__dirname, '..', 'player-apk-android', 'app', 'src', 'test', 'resources');
const CONTENT_ID = 'muestra-edu-001';

function main() {
    fs.mkdirSync(destino, { recursive: true });

    const master = crypto.randomBytes(32).toString('hex');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // 200 KB: varios trozos de 8 KB y un último trozo incompleto, que es donde
    // suelen aparecer los errores de longitudes.
    const original = crypto.randomBytes(200 * 1024 + 1234);

    const { edu, salt, firmado } = packEdu(original, {
        contentId: CONTENT_ID,
        title: 'Clase de muestra',
        masterKeyHex: master,
        signingKeyPem: privateKey,
    });
    if (!firmado) throw new Error('la muestra debería salir firmada');

    // El mismo contenedor sin firmar, para comprobar que Android lo rechaza.
    const sinFirma = packEdu(original, {
        contentId: CONTENT_ID, title: 'Clase de muestra',
        masterKeyHex: master, signingKeyPem: null,
    });

    fs.writeFileSync(path.join(destino, 'muestra.edu'), edu);
    fs.writeFileSync(path.join(destino, 'muestra-sin-firma.edu'), sinFirma.edu);
    fs.writeFileSync(path.join(destino, 'muestra-original.bin'), original);
    fs.writeFileSync(path.join(destino, 'muestra.json'), JSON.stringify({
        contentId: CONTENT_ID,
        masterKeyHex: master,
        salt,
        saltSinFirma: sinFirma.salt,
        publicKeyPem: publicKey,
        origLen: original.length,
        sha256: crypto.createHash('sha256').update(original).digest('hex'),
    }, null, 2));

    console.log('Muestras escritas en ' + destino);
    console.log('  muestra.edu             ' + edu.length + ' bytes (firmado)');
    console.log('  muestra-sin-firma.edu   ' + sinFirma.edu.length + ' bytes');
    console.log('  muestra-original.bin    ' + original.length + ' bytes');
}

if (require.main === module) main();
