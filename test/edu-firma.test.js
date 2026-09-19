'use strict';
/**
 * Comprueba el ciclo completo del contenedor .edu con firma RSA:
 *   empaquetar → firmar → comprobar firma → descifrar → lectura por rangos.
 *
 * Lo que se quiere demostrar es que un .edu se comporta como el .ipr de
 * Infoprotector: el archivo en disco es opaco, no contiene el mp4, y el
 * reproductor rechaza cualquier contenedor que no venga firmado por ESTE
 * servidor. Sin eso, cambiar el archivo por otro sería trivial.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');

const raiz = path.join(__dirname, '..');
const { packEdu, deriveCek, signEdu } = require(path.join(raiz, 'edu-packer.js'));

// El lector lee la clave pública de ./edu-public-key.js al cargarse. Para poder
// probar con una pareja recién generada, se carga el módulo con esa dependencia
// sustituida en lugar de tocar el archivo real del repositorio.
function cargarLector(publicKeyPem) {
    const rutaLector = path.join(raiz, 'player-app', 'edu-native.js');
    const rutaClave = path.join(raiz, 'player-app', 'edu-public-key.js');
    delete require.cache[require.resolve(rutaLector)];
    const original = Module._load;
    Module._load = function (peticion, padre, esMain) {
        if (peticion === './edu-public-key.js') return { PUBLIC_KEY: publicKeyPem };
        return original.call(this, peticion, padre, esMain);
    };
    try {
        return require(rutaLector);
    } finally {
        Module._load = original;
        delete require.cache[require.resolve(rutaLector)];
        delete require.cache[rutaClave];
    }
}

function pareja() {
    return crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
}

const MASTER = crypto.randomBytes(32).toString('hex');
const CONTENT_ID = 'clase-de-prueba-001';
// Un "vídeo" de 200 KB: más de 8 KB, así que ocupa varios trozos cifrados.
const MP4 = crypto.randomBytes(200 * 1024);

test('un .edu firmado se abre y devuelve el mp4 original', () => {
    const { publicKey, privateKey } = pareja();
    const { edu, salt, firmado } = packEdu(MP4, {
        contentId: CONTENT_ID, title: 'Clase de prueba',
        masterKeyHex: MASTER, signingKeyPem: privateKey,
    });
    assert.equal(firmado, true, 'el contenedor debería salir firmado');

    const lector = cargarLector(publicKey);
    const cek = deriveCek(MASTER, Buffer.from(salt, 'hex'), CONTENT_ID);
    const { mp4 } = lector.decryptEdu(edu, cek);
    assert.ok(mp4.equals(MP4), 'el mp4 recuperado debe ser idéntico al original');
});

test('el contenedor en disco no contiene el vídeo en claro', () => {
    const { privateKey } = pareja();
    const { edu } = packEdu(MP4, { contentId: CONTENT_ID, masterKeyHex: MASTER, signingKeyPem: privateKey });
    // Ninguna tira larga del original debe aparecer tal cual dentro del .edu.
    const muestra = MP4.subarray(1000, 1064);
    assert.equal(edu.indexOf(muestra), -1, 'el .edu no debe llevar el mp4 en claro');
    assert.ok(edu.subarray(0, 4).equals(Buffer.from('EDU!')), 'debe empezar por EDU!');
});

test('se rechaza un contenedor manipulado', () => {
    const { publicKey, privateKey } = pareja();
    const { edu, salt } = packEdu(MP4, { contentId: CONTENT_ID, masterKeyHex: MASTER, signingKeyPem: privateKey });
    const alterado = Buffer.from(edu);
    alterado[500] = alterado[500] ^ 0xff;      // un solo bit cambiado

    const lector = cargarLector(publicKey);
    const cek = deriveCek(MASTER, Buffer.from(salt, 'hex'), CONTENT_ID);
    assert.throws(() => lector.decryptEdu(alterado, cek), /firma inválida|firma invalida/i);
});

test('se rechaza un contenedor firmado por otra clave', () => {
    const mio = pareja();
    const ajeno = pareja();
    const { edu, salt } = packEdu(MP4, { contentId: CONTENT_ID, masterKeyHex: MASTER, signingKeyPem: ajeno.privateKey });

    const lector = cargarLector(mio.publicKey);
    const cek = deriveCek(MASTER, Buffer.from(salt, 'hex'), CONTENT_ID);
    assert.throws(() => lector.decryptEdu(edu, cek), /firma inválida|firma invalida/i);
});

test('un reproductor que exige firma rechaza un .edu sin firmar', () => {
    const { publicKey } = pareja();
    const { edu, salt } = packEdu(MP4, { contentId: CONTENT_ID, masterKeyHex: MASTER, signingKeyPem: null });

    const lector = cargarLector(publicKey);
    const cek = deriveCek(MASTER, Buffer.from(salt, 'hex'), CONTENT_ID);
    assert.throws(() => lector.decryptEdu(edu, cek), /no est[aá] firmado/i);
});

test('la clave de un contenido no sirve para otro', () => {
    const { publicKey, privateKey } = pareja();
    const a = packEdu(MP4, { contentId: 'clase-A', masterKeyHex: MASTER, signingKeyPem: privateKey });
    const lector = cargarLector(publicKey);
    const cekB = deriveCek(MASTER, Buffer.from(a.salt, 'hex'), 'clase-B');
    assert.throws(() => lector.decryptEdu(a.edu, cekB));
});

test('lectura por rangos: se descifra solo el trozo pedido', () => {
    const { publicKey, privateKey } = pareja();
    const { edu, salt } = packEdu(MP4, { contentId: CONTENT_ID, masterKeyHex: MASTER, signingKeyPem: privateKey });

    const lector = cargarLector(publicKey);
    const cek = deriveCek(MASTER, Buffer.from(salt, 'hex'), CONTENT_ID);
    const st = lector.openEdu(edu, cek);
    assert.equal(Number(st.origLen), MP4.length);

    // readRange usa rangos INCLUSIVOS, como la cabecera Range de HTTP.
    // Un rango a mitad del archivo, cruzando el límite de un trozo de 8 KB.
    const desde = 8192 - 10, hasta = 8192 + 4096;
    const trozo = lector.readRange(st, desde, hasta);
    assert.ok(trozo.equals(MP4.subarray(desde, hasta + 1)), 'el rango debe coincidir con el original');

    // El principio y el final también, que es donde suelen estar los índices mp4.
    assert.ok(lector.readRange(st, 0, 4095).equals(MP4.subarray(0, 4096)));
    assert.ok(lector.readRange(st, MP4.length - 4096, MP4.length - 1).equals(MP4.subarray(MP4.length - 4096)));

    // Un rango que se pasa del final se recorta, no revienta.
    assert.equal(lector.readRange(st, MP4.length - 10, MP4.length + 5000).length, 10);
});

test('signEdu sin clave devuelve el contenedor tal cual', () => {
    const buf = Buffer.from('contenido cualquiera');
    assert.ok(signEdu(buf, null).equals(buf));
    assert.ok(signEdu(buf, '').equals(buf));
});

test('se puede abrir desde disco sin cargar el archivo en memoria', () => {
    const fs = require('fs');
    const os = require('os');
    const { publicKey, privateKey } = pareja();
    const { edu, salt } = packEdu(MP4, { contentId: CONTENT_ID, masterKeyHex: MASTER, signingKeyPem: privateKey });

    const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edu-')), 'clase.edu');
    fs.writeFileSync(ruta, edu);

    const lector = cargarLector(publicKey);
    const cek = deriveCek(MASTER, Buffer.from(salt, 'hex'), CONTENT_ID);
    const st = lector.openEduFile(ruta, cek);
    try {
        assert.equal(st.origLen, MP4.length);
        assert.equal(st.firmado, true);
        assert.equal(st.buf, null, 'no debe tener el contenedor en memoria');
        // Los mismos rangos que por memoria, byte a byte.
        assert.ok(lector.readRange(st, 0, 4095).equals(MP4.subarray(0, 4096)));
        assert.ok(lector.readRange(st, 8182, 12288).equals(MP4.subarray(8182, 12289)));
        assert.ok(lector.readRange(st, MP4.length - 4096, MP4.length - 1).equals(MP4.subarray(MP4.length - 4096)));
        assert.ok(lector.readRange(st, 0, MP4.length - 1).equals(MP4));
    } finally {
        st.close();
        fs.rmSync(path.dirname(ruta), { recursive: true, force: true });
    }
});

test('desde disco también se rechaza un contenedor manipulado', () => {
    const fs = require('fs');
    const os = require('os');
    const { publicKey, privateKey } = pareja();
    const { edu, salt } = packEdu(MP4, { contentId: CONTENT_ID, masterKeyHex: MASTER, signingKeyPem: privateKey });
    const alterado = Buffer.from(edu);
    alterado[5000] ^= 0xff;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-'));
    const ruta = path.join(dir, 'clase.edu');
    fs.writeFileSync(ruta, alterado);

    const lector = cargarLector(publicKey);
    const cek = deriveCek(MASTER, Buffer.from(salt, 'hex'), CONTENT_ID);
    try {
        assert.throws(() => lector.openEduFile(ruta, cek), /firma invalida|firma inválida/i);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
