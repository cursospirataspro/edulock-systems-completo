'use strict';
/**
 * _qa_device_limit_test.js — Prueba de enforcement ESTRICTO del límite de dispositivos.
 * Usa el código real de database.js (SQLite). Crea un alumno temporal, prueba todos
 * los escenarios y luego limpia (borra el alumno y sus dispositivos).
 *
 * NO toca datos de producción (Render usa PostgreSQL). Solo el app.db local de dev.
 */
const db = require('./database');

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else      { fail++; console.log('  FAIL  ' + name); }
}

const SID = 'qa_test_student_' + Date.now();
const EMAIL = SID + '@qa.local';

function fp(n) { return 'fp-device-' + n; }

(function run() {
    console.log('=== QA: Enforcement estricto de límite de dispositivos (SQLite) ===\n');

    // Crear alumno temporal
    db.createStudent({ id: SID, email: EMAIL, studentId: 'QA01', name: 'QA Test', active: true, allowedVideos: '*' });

    // --- Escenario 1: límite por defecto debe ser 1 ---
    console.log('[1] Límite por defecto = 1');
    const def = db.getStudentMaxDevices(SID);
    check('default max_devices === 1', def === 1);

    // PC1 se registra OK
    let r1 = db.registerOrValidateDevice(SID, fp(1), { os: 'win' }, 1);
    check('PC1 (nuevo) aceptado', r1.ok === true && r1.reason === 'new');

    // PC2 RECHAZADO (límite 1)
    let r2 = db.registerOrValidateDevice(SID, fp(2), { os: 'win' }, 1);
    check('PC2 RECHAZADO por límite', r2.ok === false && r2.reason === 'device_limit_exceeded');
    check('mensaje reporta limit=1', r2.limit === 1);

    // PC1 vuelve a entrar muchas veces → siempre OK, no cuenta como nuevo
    for (let i = 0; i < 5; i++) {
        const rr = db.registerOrValidateDevice(SID, fp(1), { os: 'win' }, 1);
        if (!(rr.ok === true && rr.reason === 'existing')) { check('PC1 reentrada #' + i, false); break; }
    }
    check('PC1 reentra 5x sin bloqueo (existing)', db.countActiveDevices(SID) === 1);

    // --- Escenario 2: subir a 2 ---
    console.log('\n[2] Admin sube max_devices = 2');
    const set2 = db.setStudentMaxDevices(SID, 2);
    check('setStudentMaxDevices(2) === 2', set2 === 2);
    let r2b = db.registerOrValidateDevice(SID, fp(2), { os: 'win' }, 1);
    check('PC2 ahora aceptado', r2b.ok === true && r2b.reason === 'new');
    let r3 = db.registerOrValidateDevice(SID, fp(3), { os: 'win' }, 1);
    check('PC3 RECHAZADO (límite 2)', r3.ok === false && r3.reason === 'device_limit_exceeded');
    check('activos === 2', db.countActiveDevices(SID) === 2);

    // --- Escenario 3: subir a 3 ---
    console.log('\n[3] Admin sube max_devices = 3');
    db.setStudentMaxDevices(SID, 3);
    let r3b = db.registerOrValidateDevice(SID, fp(3), { os: 'win' }, 1);
    check('PC3 ahora aceptado', r3b.ok === true && r3b.reason === 'new');
    let r4 = db.registerOrValidateDevice(SID, fp(4), { os: 'win' }, 1);
    check('PC4 RECHAZADO (límite 3)', r4.ok === false && r4.reason === 'device_limit_exceeded');
    check('activos === 3', db.countActiveDevices(SID) === 3);

    // --- Escenario 4: bajar a 1 NO expulsa pero bloquea nuevos ---
    console.log('\n[4] Admin baja max_devices = 1 (con 3 ya registrados)');
    db.setStudentMaxDevices(SID, 1);
    check('límite ahora 1', db.getStudentMaxDevices(SID) === 1);
    // Los 3 ya registrados siguen entrando (no se expulsan silenciosamente)
    const e1 = db.registerOrValidateDevice(SID, fp(1), {}, 1);
    const e2 = db.registerOrValidateDevice(SID, fp(2), {}, 1);
    const e3 = db.registerOrValidateDevice(SID, fp(3), {}, 1);
    check('PC1/2/3 ya registrados siguen OK (existing)',
        e1.reason === 'existing' && e2.reason === 'existing' && e3.reason === 'existing');
    // Un dispositivo NUEVO sí se bloquea
    const e5 = db.registerOrValidateDevice(SID, fp(5), {}, 1);
    check('PC5 (nuevo) RECHAZADO tras bajar límite', e5.ok === false && e5.reason === 'device_limit_exceeded');

    // --- Escenario 5: reset y volver a empezar ---
    console.log('\n[5] Reset de dispositivos');
    db.resetStudentDevices(SID);
    check('activos === 0 tras reset', db.countActiveDevices(SID) === 0);
    const after = db.registerOrValidateDevice(SID, fp(9), {}, 1);
    check('nuevo dispositivo entra como primero', after.ok === true && after.reason === 'new');

    // --- Escenario 6: fallback ignora valores inválidos ---
    console.log('\n[6] setStudentMaxDevices con valores inválidos');
    check('set(0) clamp a 1', db.setStudentMaxDevices(SID, 0) === 1);
    check('set(-5) clamp a 1', db.setStudentMaxDevices(SID, -5) === 1);
    check('set(999) clamp a 50', db.setStudentMaxDevices(SID, 999) === 50);
    check('set("abc") clamp a 1', db.setStudentMaxDevices(SID, 'abc') === 1);

    // Limpieza
    db.resetStudentDevices(SID);
    db.deleteStudent(SID);

    console.log('\n=== RESULTADO: ' + pass + ' PASS / ' + fail + ' FAIL ===');
    process.exit(fail === 0 ? 0 : 1);
})();
