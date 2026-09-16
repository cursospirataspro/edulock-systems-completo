'use strict';
// Detecta todos los alumnos aprobados/activos SIN ningún dispositivo en la tabla
// devices (mismo estado roto que Luis) y muestra su solicitud aprobada si existe.
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    const res = await pool.query(`
        SELECT s.id, s.email, s.name, s.last_login, s.max_devices,
               r.device_id AS approved_device, r.device_name AS approved_device_name,
               r.device_model AS approved_device_model, r.status AS request_status
        FROM students s
        LEFT JOIN devices d ON d.student_id = s.id
        LEFT JOIN registration_requests r ON lower(r.email::text) = lower(s.email::text) AND r.status = 'approved'
        WHERE s.active = 1
          AND COALESCE(s.approval_status, 'approved') = 'approved'
          AND d.id IS NULL
        ORDER BY s.created_at DESC
    `).catch(async (e) => {
        // fallback si lower() no existe para el tipo (citext etc.)
        console.log('(fallback query:', e.message + ')');
        return pool.query(`
            SELECT s.id, s.email, s.name, s.last_login, s.max_devices,
                   r.device_id AS approved_device, r.device_name AS approved_device_name,
                   r.device_model AS approved_device_model, r.status AS request_status
            FROM students s
            LEFT JOIN devices d ON d.student_id = s.id
            LEFT JOIN registration_requests r ON r.email = s.email AND r.status = 'approved'
            WHERE s.active = 1
              AND COALESCE(s.approval_status, 'approved') = 'approved'
              AND d.id IS NULL
            ORDER BY s.created_at DESC
        `);
    });

    console.log(`Alumnos aprobados SIN dispositivo registrado: ${res.rows.length}`);
    console.log(JSON.stringify(res.rows, null, 2));

    // Para cada dispositivo aprobado, ver si otro alumno ya lo posee (conflicto)
    for (const r of res.rows) {
        if (!r.approved_device) continue;
        const owner = await pool.query(
            'SELECT student_id FROM devices WHERE fingerprint=$1 LIMIT 1', [r.approved_device]
        );
        if (owner.rows[0] && owner.rows[0].student_id !== r.id) {
            console.log(`CONFLICTO: device ${r.approved_device} de ${r.email} ya pertenece a ${owner.rows[0].student_id}`);
        }
    }
    await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
