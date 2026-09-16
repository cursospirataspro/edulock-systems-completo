'use strict';
// Repara alumnos aprobados sin dispositivo: registra en devices el fingerprint
// que el admin ya aprobó en registration_requests. Idempotente.
require('dotenv').config();
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    const res = await pool.query(`
        SELECT s.id, s.email,
               r.device_id AS fp, r.device_name AS dname, r.device_model AS dmodel
        FROM students s
        JOIN registration_requests r ON r.email = s.email AND r.status = 'approved'
        LEFT JOIN devices d ON d.student_id = s.id
        WHERE s.active = 1
          AND COALESCE(s.approval_status, 'approved') = 'approved'
          AND d.id IS NULL
          AND r.device_id IS NOT NULL
          AND r.device_id <> ''
          AND s.email NOT ILIKE 'admin@%'
    `);

    const now = new Date().toISOString();
    let fixed = 0, skipped = 0;
    for (const row of res.rows) {
        // No robar el dispositivo si ya pertenece a otra cuenta
        const owner = await pool.query('SELECT student_id FROM devices WHERE fingerprint=$1 LIMIT 1', [row.fp]);
        if (owner.rows[0] && owner.rows[0].student_id !== row.id) {
            console.log(`SKIP (conflicto): ${row.email} device ${row.fp} pertenece a ${owner.rows[0].student_id}`);
            skipped++;
            continue;
        }
        if (owner.rows[0]) { skipped++; continue; } // ya registrado para este alumno
        await pool.query(
            `INSERT INTO devices (id, student_id, fingerprint, device_name, browser, os, city, status, first_seen, last_seen)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`,
            [randomUUID(), row.id, row.fp, (row.dname || '').slice(0, 100), (row.dmodel || '').slice(0, 100), '', null, now, now]
        );
        console.log(`OK: ${row.email} → ${row.fp} (${row.dname || row.dmodel || 's/n'})`);
        fixed++;
    }
    console.log(`\nReparados: ${fixed} · Omitidos: ${skipped}`);

    // Verificación final: cuántos alumnos aprobados siguen sin dispositivo
    const remaining = await pool.query(`
        SELECT s.email FROM students s
        LEFT JOIN devices d ON d.student_id = s.id
        WHERE s.active = 1 AND COALESCE(s.approval_status,'approved')='approved' AND d.id IS NULL
    `);
    console.log(`Aún sin dispositivo (${remaining.rows.length}):`, remaining.rows.map(r => r.email).join(', ') || '—');
    await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
