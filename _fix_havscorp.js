'use strict';
// Recrea la fila de students para havscorp@hotmail.com desde su solicitud
// aprobada (64476469-53ad-4f9b-b5af-f88875fa0462). Idempotente.
require('dotenv').config();
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    const email = 'havscorp@hotmail.com';
    const exists = await pool.query('SELECT id FROM students WHERE email ILIKE $1', [email]);
    if (exists.rows.length) {
        console.log('Ya existe:', exists.rows[0].id);
    } else {
        const reg = (await pool.query("SELECT * FROM registration_requests WHERE email=$1 AND status='approved'", [email])).rows[0];
        if (!reg) { console.error('No hay solicitud aprobada'); process.exit(1); }
        const id = randomUUID();
        await pool.query(
            `INSERT INTO students (id, email, student_id, name, active, allowed_videos, created_at, firebase_uid, approval_status, max_devices)
             VALUES ($1,$2,$3,$4,1,'*',$5,$6,'approved',1)`,
            [id, email, email.split('@')[0], reg.name || email, new Date().toISOString(), reg.firebase_uid]
        );
        // Registrar tambien su dispositivo aprobado para que el login no tropiece
        await pool.query(
            `INSERT INTO devices (id, student_id, fingerprint, device_name, browser, os, status, first_seen, last_seen)
             VALUES ($1,$2,$3,$4,$5,'windows','active',$6,$6)
             ON CONFLICT DO NOTHING`,
            [randomUUID(), id, reg.device_id, reg.device_model || 'Surface Pro 7', '', new Date().toISOString()]
        );
        console.log('Alumno recreado:', id, '· device:', reg.device_id);
    }
    const check = await pool.query('SELECT id,email,active,approval_status,allowed_videos,firebase_uid FROM students WHERE email ILIKE $1', [email]);
    console.log(JSON.stringify(check.rows, null, 2));
    await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
