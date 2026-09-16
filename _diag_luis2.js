'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    const totalDevices = await pool.query('SELECT COUNT(*)::int AS n FROM devices');
    console.log('total devices rows:', totalDevices.rows[0].n);

    const recentDevices = await pool.query(
        'SELECT d.student_id, s.email, d.fingerprint, d.os, d.status, d.last_seen FROM devices d LEFT JOIN students s ON s.id=d.student_id ORDER BY d.last_seen DESC LIMIT 8'
    );
    console.log('=== RECENT DEVICES ===');
    console.log(JSON.stringify(recentDevices.rows, null, 2));

    const recentLogins = await pool.query(
        "SELECT email, last_login, approval_status, max_devices FROM students WHERE last_login IS NOT NULL ORDER BY last_login DESC LIMIT 8"
    );
    console.log('=== RECENT LOGINS ===');
    console.log(JSON.stringify(recentLogins.rows, null, 2));

    // ¿El fingerprint del Mac de Luis aparece bajo cualquier otra cuenta/estado?
    const fp = await pool.query("SELECT * FROM devices WHERE fingerprint LIKE 'dev_0682%'");
    console.log('=== ANY ROW WITH LUIS FP ===');
    console.log(JSON.stringify(fp.rows, null, 2));

    // Prueba controlada: ejecutar la misma secuencia de registerOrValidateDevice en transacción con ROLLBACK
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const studentId = 'adb3c240-6e18-491c-90db-c23ff8257939';
        const fingerprint = 'dev_0682431aa34d96e7';
        const now = new Date().toISOString();
        const stRes = await client.query('SELECT max_devices FROM students WHERE id=$1 FOR UPDATE', [studentId]);
        console.log('FOR UPDATE ok, max_devices =', stRes.rows[0]?.max_devices);
        const { randomUUID } = require('crypto');
        await client.query(
            `INSERT INTO devices (id, student_id, fingerprint, device_name, browser, os, city, status, first_seen, last_seen)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`,
            [randomUUID(), studentId, fingerprint, 'MacBook-Air-de-Luis.local', 'EDULOCK Player', 'darwin', null, now, now]
        );
        console.log('INSERT into devices ok (rolled back)');
        await client.query('ROLLBACK');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        console.log('>>> registerOrValidateDevice REPRO FAILED:', e.message);
    } finally {
        client.release();
    }

    await pool.end();
})().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
