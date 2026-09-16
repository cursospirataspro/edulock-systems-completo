'use strict';
// Limpieza puntual SOLO para havscorp@hotmail.com: elimina la fila huérfana
// en `devices` que quedó apuntando al student_id viejo (borrado) y que
// colisionaba con el fingerprint del dispositivo real del alumno.
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ORPHAN_STUDENT_ID = '738cd655-47bc-4d54-9f2e-ca779e9d76c1';
const REAL_STUDENT_ID   = '07e4c5c8-9485-4159-975b-80710dc0c9af'; // havscorp@hotmail.com
const FINGERPRINT       = 'dev_f9686c3aee14b6b9';

(async () => {
    // Verificación de seguridad: el student_id huérfano NO debe existir en students,
    // y el student_id real SÍ debe existir y ser havscorp@hotmail.com, antes de borrar nada.
    const orphanExists = await pool.query('SELECT id FROM students WHERE id=$1', [ORPHAN_STUDENT_ID]);
    const realStudent   = await pool.query('SELECT id, email FROM students WHERE id=$1', [REAL_STUDENT_ID]);

    if (orphanExists.rows.length) {
        console.error('ABORTADO: el student_id huérfano SÍ existe en students. No se borra nada.');
        process.exit(1);
    }
    if (!realStudent.rows.length || realStudent.rows[0].email !== 'havscorp@hotmail.com') {
        console.error('ABORTADO: no se pudo confirmar el alumno real. No se borra nada.');
        process.exit(1);
    }

    const before = await pool.query('SELECT id, student_id, status FROM devices WHERE fingerprint=$1', [FINGERPRINT]);
    console.log('ANTES:', JSON.stringify(before.rows, null, 2));

    const del = await pool.query(
        'DELETE FROM devices WHERE student_id=$1 AND fingerprint=$2 RETURNING id, student_id',
        [ORPHAN_STUDENT_ID, FINGERPRINT]
    );
    console.log('FILA HUERFANA ELIMINADA:', JSON.stringify(del.rows, null, 2));

    const after = await pool.query('SELECT id, student_id, status FROM devices WHERE fingerprint=$1', [FINGERPRINT]);
    console.log('DESPUES:', JSON.stringify(after.rows, null, 2));

    await pool.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
