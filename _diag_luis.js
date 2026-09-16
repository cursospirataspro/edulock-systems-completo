'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    const email = 'luisadolforamoscastillo@gmail.com';

    const studentRes = await pool.query(
        'SELECT * FROM students WHERE email ILIKE $1',
        [email]
    );

    const regRes = await pool.query(
        'SELECT * FROM registration_requests WHERE email ILIKE $1',
        [email]
    ).catch(e => ({ rows: [{ error: e.message }] }));
    console.log('=== REGISTRATION REQUESTS ===');
    console.log(JSON.stringify(regRes.rows, null, 2));

    // Si la solicitud tiene device_id, ver a quién pertenece ese fingerprint ahora
    for (const r of regRes.rows) {
        const fp = r.device_id || r.deviceid || r.device_fingerprint;
        if (!fp) continue;
        const owner = await pool.query('SELECT d.student_id, d.status, d.last_seen, s.email FROM devices d LEFT JOIN students s ON s.id=d.student_id WHERE d.fingerprint=$1', [fp]).catch(e => ({ rows: [{ error: e.message }] }));
        console.log(`=== OWNER OF DEVICE ${fp} ===`);
        console.log(JSON.stringify(owner.rows, null, 2));
        const ownerByCol = await pool.query('SELECT id,email FROM students WHERE device_id=$1', [fp]).catch(e => ({ rows: [{ error: e.message }] }));
        console.log(`=== students.device_id = ${fp} ===`);
        console.log(JSON.stringify(ownerByCol.rows, null, 2));
    }

    const dupRes = await pool.query(
        "SELECT id,email,student_id,active,approval_status,firebase_uid,last_login FROM students WHERE email ILIKE '%luisadolfo%' OR email ILIKE '%ramoscastillo%'"
    ).catch(e => ({ rows: [{ error: e.message }] }));
    console.log('=== SIMILAR EMAILS ===');
    console.log(JSON.stringify(dupRes.rows, null, 2));
    console.log('=== STUDENT ===');
    console.log(JSON.stringify(studentRes.rows, null, 2));

    if (studentRes.rows[0]) {
        const id = studentRes.rows[0].id;

        const devRes = await pool.query(
            'SELECT id,student_id,fingerprint,device_name,browser,os,city,status,first_seen,last_seen FROM devices WHERE student_id=$1 ORDER BY last_seen DESC',
            [id]
        );
        console.log('=== DEVICES ===');
        console.log(JSON.stringify(devRes.rows, null, 2));

        const auditRes = await pool.query(
            'SELECT video_id,device_id,fingerprint,student_email,ip,delivered_at FROM audit_log WHERE student_email ILIKE $1 OR user_id=$2 ORDER BY delivered_at DESC LIMIT 10',
            [email, id]
        );
        console.log('=== RECENT AUDIT (last 10) ===');
        console.log(JSON.stringify(auditRes.rows, null, 2));

        const suspRes = await pool.query(
            'SELECT type,severity,description,device_id,created_at FROM suspicious_activity WHERE student_id=$1 ORDER BY created_at DESC LIMIT 15',
            [id]
        ).catch(e => ({ rows: [{ error: e.message }] }));
        console.log('=== SUSPICIOUS ACTIVITY (last 15) ===');
        console.log(JSON.stringify(suspRes.rows, null, 2));

        // Si el device_id del alumno o de auditoría existe, ver a quién pertenece en devices
        const fps = new Set();
        if (studentRes.rows[0].device_id) fps.add(studentRes.rows[0].device_id);
        for (const a of auditRes.rows) if (a.device_id) fps.add(a.device_id);
        for (const fp of fps) {
            const ownerRes = await pool.query(
                "SELECT student_id,fingerprint,status,last_seen FROM devices WHERE fingerprint=$1",
                [fp]
            );
            console.log(`=== DEVICE OWNERSHIP fp=${fp} ===`);
            console.log(JSON.stringify(ownerRes.rows, null, 2));
        }

        const actRes = await pool.query(
            'SELECT id,student_id,device_id,status,created_at,last_used_at FROM activations WHERE student_id=$1 ORDER BY created_at DESC LIMIT 10',
            [id]
        ).catch(e => ({ rows: [{ error: e.message }] }));
        console.log('=== ACTIVATIONS ===');
        console.log(JSON.stringify(actRes.rows, null, 2));
    } else {
        console.log('>>> El alumno NO existe en la tabla students <<<');
    }

    await pool.end();
})().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
