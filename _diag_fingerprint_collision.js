'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    const fp = 'dev_f9686c3aee14b6b9';

    const devices = await pool.query(
        'SELECT id, student_id, fingerprint, device_name, status, first_seen, last_seen FROM devices WHERE fingerprint=$1 ORDER BY first_seen',
        [fp]
    );
    console.log('DEVICES con este fingerprint:', JSON.stringify(devices.rows, null, 2));

    const ids = devices.rows.map(d => d.student_id);
    if (ids.length) {
        const students = await pool.query(
            `SELECT id, email, active, approval_status, device_id, created_at FROM students WHERE id = ANY($1)`,
            [ids]
        );
        console.log('STUDENTS dueños:', JSON.stringify(students.rows, null, 2));
    }

    await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
