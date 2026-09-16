'use strict';
// Valida los fixes de ambos casos contra el servidor vivo:
// 1. validateAppSig con reloj desviado (simula la laptop de Brayan con -3 horas)
// 2. Con reloj desviado 45 días → debe seguir rechazando
// 3. havscorp: estado final en students (visible para generar licencia)
require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const { Pool } = require('pg');

const APP_SECRET = process.env.APP_SECRET;

function post(path, body, headers) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const r = http.request({ host: 'localhost', port: 3000, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
            res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
        r.on('error', reject);
        r.write(data); r.end();
    });
}

async function tryActivate(skewMs, label) {
    const ts = Date.now() + skewMs;
    const sig = crypto.createHmac('sha256', APP_SECRET).update('resolve:' + ts).digest('hex');
    // Licencia falsa con formato válido: si pasa la firma, el error debe ser
    // "Licencia inválida" (401 de licencia), NO "Firma de reproductor expirada".
    const res = await post('/api/license/activate',
        { licenseKey: 'AAAA-BBBB-CCCC-DDDD', deviceId: 'dev_test_clock_skew' },
        { 'x-cdp-ts': String(ts), 'x-cdp-sig': sig });
    const b = JSON.parse(res.body);
    console.log(`[${label}] HTTP ${res.status} → ${b.error}`);
    return b.error || '';
}

(async () => {
    const e1 = await tryActivate(-3 * 3600 * 1000, 'reloj -3 horas   ');   // caso Brayan (zona horaria mal)
    const e2 = await tryActivate(-5 * 24 * 3600 * 1000, 'reloj -5 dias   '); // fecha atrasada
    const e3 = await tryActivate(-45 * 24 * 3600 * 1000, 'reloj -45 dias  '); // fuera de rango → rechazo esperado

    console.log('\nResultados:');
    console.log('  -3 horas :', e1.includes('Firma') ? '✗ AÚN BLOQUEA POR FIRMA' : '✓ pasa la firma (llega a validar la licencia)');
    console.log('  -5 días  :', e2.includes('Firma') ? '✗ AÚN BLOQUEA POR FIRMA' : '✓ pasa la firma');
    console.log('  -45 días :', e3.includes('Firma') ? '✓ rechazado correctamente (fuera de rango)' : '✗ INESPERADO: aceptó');

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const h = await pool.query("SELECT id,email,active,approval_status FROM students WHERE email='havscorp@hotmail.com'");
    console.log('\nhavscorp en students (visible para generar licencia):', h.rows.length ? '✓ SÍ · id=' + h.rows[0].id : '✗ NO');
    await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
