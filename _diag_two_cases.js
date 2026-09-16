'use strict';
// Diagnóstico de dos casos: havscorp@hotmail.com y aguilar.rodriguez.brayan2006@gmail.com
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const EMAILS = ['havscorp@hotmail.com', 'aguilar.rodriguez.brayan2006@gmail.com'];

(async () => {
    for (const email of EMAILS) {
        console.log('\n════════════════════════════════════════════════');
        console.log('  ' + email);
        console.log('════════════════════════════════════════════════');

        const st = await pool.query('SELECT * FROM students WHERE email ILIKE $1', [email]);
        console.log('── students ──');
        console.log(st.rows.length ? JSON.stringify(st.rows.map(r => ({
            id: r.id, email: r.email, active: r.active, approval_status: r.approval_status,
            allowed_videos: r.allowed_videos, firebase_uid: r.firebase_uid, max_devices: r.max_devices,
            last_login: r.last_login, created_at: r.created_at,
        })), null, 2) : '  (sin fila)');

        const rr = await pool.query('SELECT id,firebase_uid,email,name,device_id,device_model,status,requested_at,reviewed_at,reviewed_by,notes FROM registration_requests WHERE email ILIKE $1 ORDER BY requested_at DESC', [email]);
        console.log('── registration_requests ──');
        console.log(rr.rows.length ? JSON.stringify(rr.rows, null, 2) : '  (sin filas)');

        const sid = st.rows[0]?.id;
        if (sid) {
            const dev = await pool.query('SELECT fingerprint,device_name,status,first_seen,last_seen FROM devices WHERE student_id=$1', [sid]);
            console.log('── devices ──');
            console.log(dev.rows.length ? JSON.stringify(dev.rows, null, 2) : '  (sin filas)');

            const lic = await pool.query('SELECT * FROM licenses WHERE student_id=$1', [sid]).catch(e => ({ rows: [{ err: e.message }] }));
            console.log('── licenses ──');
            console.log(lic.rows.length ? JSON.stringify(lic.rows, null, 2) : '  (sin filas)');

            const act = await pool.query('SELECT * FROM activations WHERE student_id=$1', [sid]).catch(e => ({ rows: [{ err: e.message }] }));
            console.log('── activations ──');
            console.log(act.rows.length ? JSON.stringify(act.rows, null, 2) : '  (sin filas)');

            const sc = await pool.query('SELECT * FROM student_courses WHERE student_id=$1', [sid]).catch(e => ({ rows: [{ err: e.message }] }));
            console.log('── student_courses ──');
            console.log(sc.rows.length ? JSON.stringify(sc.rows, null, 2) : '  (sin filas)');
        }

        // licencias por email si no hay student
        if (!sid) {
            const lic2 = await pool.query("SELECT l.* FROM licenses l JOIN students s ON s.id=l.student_id WHERE s.email ILIKE $1", [email]).catch(() => ({ rows: [] }));
            if (lic2.rows.length) { console.log('── licenses (via join) ──'); console.log(JSON.stringify(lic2.rows, null, 2)); }
        }
    }
    // Esquema de licenses para entender el flujo
    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='licenses' ORDER BY ordinal_position");
    console.log('\n── columnas tabla licenses ──');
    console.log(cols.rows.map(r => r.column_name).join(', '));
    await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
