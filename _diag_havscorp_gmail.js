'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    const like = '%havscorp%';

    const student = await pool.query(
        'SELECT id,email,active,approval_status,allowed_videos,firebase_uid,max_devices,device_id,created_at,last_login FROM students WHERE email ILIKE $1',
        [like]
    );
    console.log('STUDENTS (like havscorp):', JSON.stringify(student.rows, null, 2));

    const reg = await pool.query(
        "SELECT id,email,status,device_id,device_model,firebase_uid,requested_at,reviewed_at FROM registration_requests WHERE email ILIKE $1 ORDER BY requested_at DESC",
        [like]
    );
    console.log('REGISTRATION_REQUESTS (like havscorp):', JSON.stringify(reg.rows, null, 2));

    for (const s of student.rows) {
        const devices = await pool.query(
            'SELECT id,fingerprint,device_name,status,first_seen,last_seen FROM devices WHERE student_id=$1',
            [s.id]
        );
        console.log('DEVICES for', s.email, ':', JSON.stringify(devices.rows, null, 2));
    }

    await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
