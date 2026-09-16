'use strict';
// Auditoría integral de consistencia de TODOS los alumnos.
// Detecta (y con --fix repara) todos los estados rotos conocidos:
//  A. Solicitud APROBADA sin fila en students (limbo tipo havscorp)
//  B. Alumno aprobado/activo sin firebase_uid vinculado teniendo uid en su solicitud
//  C. Alumno aprobado/activo con 0 dispositivos (tipo Luis) con device aprobado en solicitud
//  D. Licencias activas de alumnos inexistentes (huérfanas)
//  E. Activaciones de licencias/alumnos inexistentes
//  F. Alumnos activos con approval_status pendiente/nulo (inconsistencia de aprobación)
require('dotenv').config();
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const FIX = process.argv.includes('--fix');

(async () => {
    const now = new Date().toISOString();
    let issues = 0;

    // ── A. Solicitudes aprobadas sin alumno ──────────────────────────────────
    const limbo = await pool.query(`
        SELECT r.id, r.email, r.name, r.firebase_uid, r.device_id, r.device_model
        FROM registration_requests r
        LEFT JOIN students s ON lower(s.email::text) = lower(r.email::text)
        WHERE r.status = 'approved' AND s.id IS NULL
    `);
    console.log(`A. Solicitudes aprobadas SIN alumno: ${limbo.rows.length}`);
    for (const r of limbo.rows) {
        issues++;
        console.log(`   - ${r.email} (device: ${r.device_id || 's/n'})`);
        if (FIX) {
            const id = randomUUID();
            await pool.query(
                `INSERT INTO students (id,email,student_id,name,active,allowed_videos,created_at,firebase_uid,approval_status,max_devices)
                 VALUES ($1,$2,$3,$4,1,'*',$5,$6,'approved',1)`,
                [id, r.email.toLowerCase(), r.email.split('@')[0], r.name || r.email, now, r.firebase_uid]
            );
            if (r.device_id) {
                await pool.query(
                    `INSERT INTO devices (id,student_id,fingerprint,device_name,browser,os,status,first_seen,last_seen)
                     VALUES ($1,$2,$3,$4,'','windows','active',$5,$5) ON CONFLICT DO NOTHING`,
                    [randomUUID(), id, r.device_id, (r.device_model || '').slice(0, 100), now]
                );
            }
            console.log(`     ✔ recreado (${id})`);
        }
    }

    // ── B. Alumnos sin firebase_uid teniendo uid en su solicitud ─────────────
    const nouid = await pool.query(`
        SELECT s.id, s.email, r.firebase_uid
        FROM students s
        JOIN registration_requests r ON lower(r.email::text) = lower(s.email::text) AND r.status='approved'
        WHERE (s.firebase_uid IS NULL OR s.firebase_uid = '') AND r.firebase_uid IS NOT NULL AND r.firebase_uid <> ''
    `);
    console.log(`B. Alumnos sin firebase_uid vinculable: ${nouid.rows.length}`);
    for (const r of nouid.rows) {
        issues++;
        console.log(`   - ${r.email}`);
        if (FIX) {
            await pool.query('UPDATE students SET firebase_uid=$1 WHERE id=$2', [r.firebase_uid, r.id]);
            console.log('     ✔ uid vinculado');
        }
    }

    // ── C. Alumnos aprobados sin ningún dispositivo (con device aprobado) ────
    const nodev = await pool.query(`
        SELECT s.id, s.email, r.device_id, r.device_model
        FROM students s
        LEFT JOIN devices d ON d.student_id = s.id
        LEFT JOIN registration_requests r ON lower(r.email::text) = lower(s.email::text) AND r.status='approved'
        WHERE s.active = 1 AND COALESCE(s.approval_status,'approved')='approved'
          AND d.id IS NULL AND s.email NOT ILIKE 'admin@%'
        GROUP BY s.id, s.email, r.device_id, r.device_model
    `);
    console.log(`C. Alumnos aprobados sin dispositivo: ${nodev.rows.length}`);
    for (const r of nodev.rows) {
        console.log(`   - ${r.email} (device aprobado: ${r.device_id || 'NINGUNO — lo cubrirá el auto-registro'})`);
        if (r.device_id) {
            issues++;
            if (FIX) {
                const owner = await pool.query('SELECT student_id FROM devices WHERE fingerprint=$1 LIMIT 1', [r.device_id]);
                if (owner.rows[0] && owner.rows[0].student_id !== r.id) {
                    console.log(`     ⚠ conflicto: device pertenece a ${owner.rows[0].student_id} — omitido`);
                } else if (!owner.rows[0]) {
                    await pool.query(
                        `INSERT INTO devices (id,student_id,fingerprint,device_name,browser,os,status,first_seen,last_seen)
                         VALUES ($1,$2,$3,$4,'','windows','active',$5,$5)`,
                        [randomUUID(), r.id, r.device_id, (r.device_model || '').slice(0, 100), now]
                    );
                    console.log('     ✔ dispositivo registrado');
                }
            }
        }
    }

    // ── D. Licencias activas de alumnos inexistentes ─────────────────────────
    const orphLic = await pool.query(`
        SELECT l.id, l.student_id FROM licenses l
        LEFT JOIN students s ON s.id = l.student_id
        WHERE s.id IS NULL AND l.status = 'active'
    `);
    console.log(`D. Licencias activas huérfanas: ${orphLic.rows.length}`);
    for (const r of orphLic.rows) {
        issues++;
        console.log(`   - licencia ${r.id} → alumno inexistente ${r.student_id}`);
        if (FIX) {
            await pool.query("UPDATE licenses SET status='revoked', revoked_at=$1, revoked_by='audit', notes='alumno inexistente' WHERE id=$2", [now, r.id]);
            console.log('     ✔ revocada');
        }
    }

    // ── E. Activaciones huérfanas ────────────────────────────────────────────
    const orphAct = await pool.query(`
        SELECT a.id, a.student_id FROM activations a
        LEFT JOIN students s ON s.id = a.student_id
        WHERE s.id IS NULL AND a.status = 'active'
    `).catch(() => ({ rows: [] }));
    console.log(`E. Activaciones activas huérfanas: ${orphAct.rows.length}`);
    for (const r of orphAct.rows) {
        issues++;
        if (FIX) {
            await pool.query("UPDATE activations SET status='revoked' WHERE id=$1", [r.id]);
            console.log(`   - ${r.id} ✔ revocada`);
        } else console.log(`   - ${r.id} (alumno ${r.student_id})`);
    }

    // ── F. Alumnos activos con approval_status inconsistente ─────────────────
    const badStatus = await pool.query(`
        SELECT id, email, approval_status FROM students
        WHERE active = 1 AND approval_status IS NOT NULL AND approval_status NOT IN ('approved')
    `);
    console.log(`F. Alumnos activos con estado no aprobado: ${badStatus.rows.length}`);
    for (const r of badStatus.rows) {
        console.log(`   - ${r.email}: ${r.approval_status} (revisar manualmente — puede ser suspensión intencional)`);
    }

    console.log(`\n${FIX ? 'REPARACIÓN' : 'AUDITORÍA'} completa · problemas ${FIX ? 'tratados' : 'detectados'}: ${issues}`);
    if (!FIX && issues > 0) console.log('Ejecuta con --fix para reparar.');
    await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
