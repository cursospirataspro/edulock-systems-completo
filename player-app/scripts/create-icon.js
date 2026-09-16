'use strict';
/**
 * scripts/create-icon.js
 * Genera los íconos necesarios para el build de Electron usando Node.js puro.
 *
 * Produce:
 *   assets/icon.png   — 256x256 PNG (fuente maestra)
 *   assets/icon.ico   — ICO multi-tamaño (16, 32, 48, 64, 128, 256 px)
 *
 * El ícono es un placeholder azul con la letra "C" (Campus).
 * Reemplaza assets/icon.png con tu logo real y ejecuta este script
 * de nuevo para regenerar el .ico — o proporciona directamente un
 * assets/icon.ico profesional y omite este script.
 */

const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// ─── CRC32 (necesario para el formato PNG) ────────────────────────────────────
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (const b of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const tBuf  = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.allocUnsafe(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([tBuf, data])), 0);
    return Buffer.concat([lenBuf, tBuf, data, crcBuf]);
}

// ─── Generador PNG puro Node.js ───────────────────────────────────────────────
function makePNG(size, drawFn) {
    // Cada scanline: byte de filtro (0) + size*4 bytes RGBA
    const raw = Buffer.alloc(size * (1 + size * 4), 0);

    for (let y = 0; y < size; y++) {
        const base = y * (1 + size * 4);
        raw[base] = 0; // filtro de scanline = none
        for (let x = 0; x < size; x++) {
            const [r, g, b, a] = drawFn(x, y, size);
            raw[base + 1 + x * 4 + 0] = r;
            raw[base + 1 + x * 4 + 1] = g;
            raw[base + 1 + x * 4 + 2] = b;
            raw[base + 1 + x * 4 + 3] = a;
        }
    }

    const ihdr = Buffer.allocUnsafe(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8]  = 8; // bit depth
    ihdr[9]  = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ─── Función de dibujo del ícono ─────────────────────────────────────────────
// Fondo: degradado azul oscuro → azul medio
// Símbolo: "C" simplificado (arco blanco)
function drawIcon(x, y, size) {
    const cx = size / 2;
    const cy = size / 2;
    const r  = size * 0.42;  // radio exterior
    const ri = size * 0.26;  // radio interior (hueco de la C)

    // Distancia al centro
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Ángulo para determinar la apertura de la "C"
    const angle = Math.atan2(dy, dx) * (180 / Math.PI); // -180..180

    // Degradado de fondo: azul oscuro (#0D47A1) → azul (#1E88E5)
    const t = (y / size);
    const bgR = Math.round(0x0D + (0x1E - 0x0D) * t);
    const bgG = Math.round(0x47 + (0x88 - 0x47) * t);
    const bgB = Math.round(0xA1 + (0xE5 - 0xA1) * t);

    // Píxel dentro del arco de la C?
    const inRing = dist >= ri && dist <= r;

    // La "C" tiene apertura a la derecha: excluye ángulos entre -38° y +38°
    const openingAngle = 38;
    const inOpening = angle >= -openingAngle && angle <= openingAngle;

    // Anti-aliasing simple en los bordes
    const outerEdge = r - dist;
    const innerEdge = dist - ri;
    const edgeSoftness = size * 0.025;

    let alpha = 255;
    // Bordes redondeados del anillo
    if (outerEdge < edgeSoftness) alpha = Math.round(255 * outerEdge / edgeSoftness);
    if (innerEdge < edgeSoftness) alpha = Math.min(alpha, Math.round(255 * innerEdge / edgeSoftness));

    // Suavizar apertura
    const absAngle = Math.abs(angle);
    const openEdge = Math.abs(absAngle - openingAngle);
    if (inRing && absAngle < openingAngle + edgeSoftness * 3) {
        if (absAngle > openingAngle) {
            alpha = Math.min(alpha, Math.round(255 * (1 - openEdge / (edgeSoftness * 3))));
        } else {
            return [bgR, bgG, bgB, 255]; // dentro de la apertura → fondo
        }
    }

    if (inRing && !inOpening && alpha > 0) {
        return [255, 255, 255, alpha]; // blanco con anti-alias
    }

    return [bgR, bgG, bgB, 255]; // fondo
}

// ─── Generar todos los tamaños ────────────────────────────────────────────────
const SIZES = [16, 32, 48, 64, 128, 256];

if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

// Si ya existe un icon.ico personalizado, no sobreescribir
const customIco = path.join(ASSETS_DIR, 'icon.ico');
const customPng = path.join(ASSETS_DIR, 'icon.png');
if (fs.existsSync(customIco) && fs.existsSync(customPng)) {
    const stat = fs.statSync(customIco);
    // Si el .ico tiene más de 1KB, asumimos que es un ícono personalizado
    if (stat.size > 1024) {
        console.log('  [iconos] Detectado icon.ico personalizado — se conserva sin cambios.');
        process.exit(0);
    }
}

const pngBuffers = [];

for (const size of SIZES) {
    const buf = makePNG(size, drawIcon);
    fs.writeFileSync(path.join(ASSETS_DIR, `icon-${size}.png`), buf);
    pngBuffers.push(buf);
    console.log(`  [iconos] icon-${size}.png generado`);
}

// icon.png maestro = 256x256
fs.copyFileSync(
    path.join(ASSETS_DIR, 'icon-256.png'),
    customPng
);
console.log('  [iconos] icon.png (256x256) listo');

// .ico multi-tamaño via png-to-ico (pure JS, sin binarios nativos)
try {
    const pngToIco = require('png-to-ico');
    pngToIco(pngBuffers)
        .then(icoBuffer => {
            fs.writeFileSync(customIco, icoBuffer);
            console.log('  [iconos] icon.ico creado (' + SIZES.join(', ') + ' px)');
        })
        .catch(err => {
            console.warn('  [iconos] Advertencia: no se pudo crear icon.ico —', err.message);
            console.warn('           El build usará el ícono predeterminado de Electron.');
        });
} catch {
    console.warn('  [iconos] png-to-ico no disponible. Ejecuta: npm install');
}
