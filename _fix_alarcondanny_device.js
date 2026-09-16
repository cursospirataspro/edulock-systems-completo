require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');

const EMAIL = 'alarcondanny88@gmail.com';

(async () => {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const student = (await client.query(
      `SELECT id, email, active, approval_status, firebase_uid, max_devices
       FROM students WHERE lower(trim(email))=lower($1) FOR UPDATE`, [EMAIL]
    )).rows[0];
    if (!student) throw new Error('Alumno no encontrado');
    if (!student.active || student.approval_status !== 'approved' || !student.firebase_uid) {
      throw new Error('La cuenta no está en estado seguro para resetear dispositivos');
    }

    const removed = (await client.query(
      `DELETE FROM devices WHERE student_id=$1 RETURNING id, fingerprint, device_name, status`,
      [student.id]
    )).rows;
    await client.query('COMMIT');

    const licenses = (await client.query(
      `SELECT id, status, max_devices, expires_at FROM licenses WHERE student_id=$1 ORDER BY created_at DESC`,
      [student.id]
    )).rows;
    const activations = (await client.query(
      `SELECT id, device_id, status FROM activations WHERE student_id=$1 ORDER BY created_at DESC`,
      [student.id]
    )).rows;
    const remainingDevices = (await client.query(
      `SELECT id FROM devices WHERE student_id=$1`, [student.id]
    )).rowCount;

    console.log(JSON.stringify({
      ok: true,
      student,
      removedDevices: removed,
      remainingDevices,
      licenses,
      activations,
      passwordChanged: false,
      firebaseUidChanged: false,
    }, null, 2));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await p.end();
  }
})().catch(e => { console.error('FATAL:', e.message); process.exitCode = 1; });
