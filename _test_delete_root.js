'use strict';
/**
 * _test_delete_root.js — Prueba E2E del borrado de raíz de un alumno.
 * 1. Crea un alumno de PRUEBA con rastros en TODAS las tablas relacionadas
 *    y un usuario real en Firebase Auth.
 * 2. Lo elimina vía el endpoint real DELETE /api/students/:id (servidor vivo).
 * 3. Audita TODAS las tablas y Firebase buscando cualquier rastro.
 * 4. Verifica que puede volver a registrarse (register-request + device libre).
 * 5. Limpia los datos de la prueba de re-registro.
 */
require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const http = require('http');
const { randomUUID } = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const EMAIL  = 'test.delete.root@qa-edulock.local';
const DEVICE = 'dev_qa_delete_root_01';

function req(method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const h = { 'Content-Type': 'application/json', ...headers };
        if (data) h['Content-Length'] = Buffer.byteLength(data);
        const r = http.request({ host: 'localhost', port: 3000, path, method, headers: h }, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

(async () => {
    const sid = randomUUID();
    const now = new Date().toISOString();

    // ── 0. Firebase: crear usuario real de prueba ────────────────────────────
    let fbUid = null, admin = null;
    try {
        admin = require('firebase-admin');
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        }
        const old = await admin.auth().getUserByEmail(EMAIL).catch(() => null);
        if (old) await admin.auth().deleteUser(old.uid);
        const u = await admin.auth().createUser({ email: EMAIL, password: 'Qa123456!', displayName: 'QA Delete Root' });
        fbUid = u.uid;
        console.log('[setup] Usuario Firebase creado:', fbUid);
    } catch (e) {
        console.log('[setup] Firebase no disponible en este entorno:', e.message);
    }

    // ── 1. Crear alumno + rastros en todas las tablas ────────────────────────
    await pool.query(`INSERT INTO students (id,email,student_id,name,active,allowed_videos,created_at,firebase_uid,approval_status,max_devices)
                      VALUES ($1,$2,'qa-delete','QA Delete Root',1,'*',$3,$4,'approved',1)`, [sid, EMAIL, now, fbUid]);
    await pool.query(`INSERT INTO devices (id,student_id,fingerprint,device_name,status,first_seen,last_seen)
                      VALUES ($1,$2,$3,'QA-PC','active',$4,$4)`, [randomUUID(), sid, DEVICE, now]);
    await pool.query(`INSERT INTO registration_requests (id,firebase_uid,email,name,device_id,status,requested_at)
                      VALUES ($1,$2,$3,'QA Delete Root',$4,'approved',$5)`, [randomUUID(), fbUid, EMAIL, DEVICE, now]).catch(e => console.log('  (reg_req:', e.message + ')'));
    await pool.query(`INSERT INTO audit_log (fingerprint,user_id,video_id,device_id,student_email,ip,user_agent,delivered_at)
                      VALUES ('qa-fp',$1,'qa-video',$2,$3,'1.2.3.4','qa',$4)`, [sid, DEVICE, EMAIL, now]);
    await pool.query(`INSERT INTO active_sessions (session_id,user_id,video_id,started_at,last_seen)
                      VALUES ($1,$2,'qa-video',$3,$3)`, [randomUUID(), sid, Date.now()]);
    // Tablas opcionales (pueden no existir o tener otras columnas — best effort)
    const optional = [
        [`INSERT INTO student_codes (student_id,code) VALUES ($1,'CDP-QA001')`, [sid]],
        [`INSERT INTO student_courses (student_id,course_id,assigned_by) VALUES ($1,'qa-course','qa')`, [sid]],
        [`INSERT INTO playback_progress (id,student_id,video_id,progress_percent,last_position,started_at,last_seen_at,completed)
          VALUES ($1,$2,'qa-video',10,5,'${now}','${now}',0)`, [randomUUID(), sid]],
        [`INSERT INTO playback_events (id,student_id,video_id,event_type,created_at) VALUES ($1,$2,'qa-video','heartbeat','${now}')`, [randomUUID(), sid]],
        [`INSERT INTO suspicious_activity (id,student_id,device_id,type,severity,description,created_at)
          VALUES ($1,$2,$3,'qa','low','qa test','${now}')`, [randomUUID(), sid, DEVICE]],
        [`INSERT INTO licenses (id,student_id,course_id,license_key_hash,status,created_at) VALUES ($1,$2,'qa','qa-hash','active','${now}')`, [randomUUID(), sid]],
        [`INSERT INTO activations (id,student_id,device_id,status,created_at) VALUES ($1,$2,$3,'active','${now}')`, [randomUUID(), sid, DEVICE]],
    ];
    for (const [sql, params] of optional) {
        try { await pool.query(sql, params); } catch (e) { console.log('  (opcional omitida:', e.message.slice(0, 60) + ')'); }
    }
    console.log('[setup] Alumno QA creado con rastros:', sid);

    // ── 2. Eliminar vía endpoint real con JWT admin ──────────────────────────
    const adminToken = jwt.sign({ sub: 'qa-admin', admin: true }, JWT_SECRET, { expiresIn: '5m', issuer: 'reproductor-cursos' });
    const del = await req('DELETE', `/api/students/${sid}`, null, { Authorization: 'Bearer ' + adminToken });
    console.log(`\n[delete] HTTP ${del.status} →`, JSON.stringify(del.body));

    // ── 3. Auditar rastros en TODAS las tablas ──────────────────────────────
    console.log('\n[auditoría de rastros]');
    const checks = [];
    const cols = await pool.query(`SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name IN ('student_id','user_id','email','student_email','firebase_uid','device_id','fingerprint')
        ORDER BY table_name`);
    const byTable = {};
    for (const r of cols.rows) (byTable[r.table_name] ||= []).push(r.column_name);

    let leftovers = 0;
    for (const [table, columns] of Object.entries(byTable)) {
        const conds = [];
        const params = [];
        for (const c of columns) {
            if (['student_id', 'user_id'].includes(c)) { params.push(sid); conds.push(`${c}=$${params.length}`); }
            if (['email', 'student_email'].includes(c)) { params.push(EMAIL); conds.push(`${c}=$${params.length}`); }
            if (c === 'firebase_uid' && fbUid) { params.push(fbUid); conds.push(`${c}=$${params.length}`); }
            if (['device_id', 'fingerprint'].includes(c)) { params.push(DEVICE); conds.push(`${c}=$${params.length}`); }
        }
        if (!conds.length) continue;
        try {
            const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${conds.join(' OR ')}`, params);
            if (r.rows[0].n > 0) { console.log(`  ✗ RASTRO en ${table}: ${r.rows[0].n} fila(s)`); leftovers += r.rows[0].n; }
        } catch (e) { console.log(`  (no auditable ${table}: ${e.message.slice(0, 50)})`); }
    }
    if (!leftovers) console.log('  ✓ CERO rastros en las ' + Object.keys(byTable).length + ' tablas con columnas de alumno');

    // ── 4. Verificar Firebase ────────────────────────────────────────────────
    if (admin && fbUid) {
        const still = await admin.auth().getUser(fbUid).catch(() => null);
        const byEmail = await admin.auth().getUserByEmail(EMAIL).catch(() => null);
        console.log('\n[firebase]', (!still && !byEmail) ? '✓ Usuario ELIMINADO de Firebase Auth' : '✗ AÚN EXISTE en Firebase');
    }

    // ── 5. Re-registro: mismo email y mismo dispositivo ─────────────────────
    console.log('\n[re-registro]');
    const rr = await req('POST', '/api/auth/register-request', {
        email: EMAIL, name: 'QA Delete Root 2', deviceId: DEVICE, deviceModel: 'QA-PC', deviceName: 'QA-PC',
    });
    console.log(`  register-request → HTTP ${rr.status}:`, JSON.stringify(rr.body));
    const chk = await req('GET', `/api/auth/check-device?deviceId=${DEVICE}`);
    console.log(`  check-device     → HTTP ${chk.status}:`, JSON.stringify(chk.body));

    // ── 6. Limpieza de la prueba ─────────────────────────────────────────────
    await pool.query('DELETE FROM registration_requests WHERE email=$1', [EMAIL]);
    if (admin) { const u = await admin.auth().getUserByEmail(EMAIL).catch(() => null); if (u) await admin.auth().deleteUser(u.uid); }
    console.log('\n[limpieza] Datos QA eliminados');
    await pool.end();
    process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
