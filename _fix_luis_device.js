'use strict';
// Registra el dispositivo aprobado de luisadolforamoscastillo@gmail.com en la tabla devices.
// El admin ya aprobó este fingerprint en registration_requests (a5bbaf32-...), pero el
// registro en devices nunca se materializó → resolve-perm devolvía 403.
require('dotenv').config();
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    const studentId   = 'adb3c240-6e18-491c-90db-c23ff8257939';
    const fingerprint = 'dev_0682431aa34d96e7'; // MacBook-Air-de-Luis.local (solicitud aprobada)
    const now = new Date().toISOString();

    const existing = await pool.query(
        'SELECT id,status FROM devices WHERE student_id=$1 AND fingerprint=$2',
        [studentId, fingerprint]
    );
    if (existing.rows.length) {
        console.log('Ya existe:', JSON.stringify(existing.rows[0]));
    } else {
        await pool.query(
            `INSERT INTO devices (id, student_id, fingerprint, device_name, browser, os, city, status, first_seen, last_seen)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`,
            [randomUUID(), studentId, fingerprint,
             'MacBook-Air-de-Luis.local', 'Apple Mac17,4', 'darwin', null, now, now]
        );
        console.log('Dispositivo registrado OK para luisadolforamoscastillo@gmail.com');
    }

    const check = await pool.query(
        'SELECT fingerprint,status,first_seen FROM devices WHERE student_id=$1', [studentId]
    );
    console.log(JSON.stringify(check.rows, null, 2));
    await pool.end();
})().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
