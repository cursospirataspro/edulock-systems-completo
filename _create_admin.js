/**
 * _create_admin.js
 * Crea el usuario admin@edulocksystemsoficial.dpdns.org en el nuevo Firebase y lo registra en la DB.
 * Ejecutar UNA vez: node _create_admin.js
 */
'use strict';

const admin = require('firebase-admin');
const path  = require('path');

// Cargar service account del nuevo proyecto
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const ADMIN_EMAIL    = 'admin@edulocksystemsoficial.dpdns.org';
const ADMIN_PASSWORD = '123456789';
const ADMIN_NAME     = 'Administrador Edulock Systems';

async function createAdmin() {
  console.log(`Creando usuario admin en Firebase (proyecto: ${serviceAccount.project_id})...`);

  let uid;
  try {
    // Intentar crear nuevo usuario
    const userRecord = await admin.auth().createUser({
      email:         ADMIN_EMAIL,
      password:      ADMIN_PASSWORD,
      displayName:   ADMIN_NAME,
      emailVerified: true,
    });
    uid = userRecord.uid;
    console.log(`✅ Usuario Firebase creado: ${uid}`);
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      // Ya existe — actualizar contraseña
      const existing = await admin.auth().getUserByEmail(ADMIN_EMAIL);
      uid = existing.uid;
      await admin.auth().updateUser(uid, {
        password:      ADMIN_PASSWORD,
        displayName:   ADMIN_NAME,
        emailVerified: true,
      });
      console.log(`ℹ️  Usuario ya existía, contraseña actualizada: ${uid}`);
    } else {
      throw err;
    }
  }

  // Registrar en la base de datos local (database.js — SQLite)
  const db = require('./database.js');

  const studentId = uid;

  // database.js devuelve null si no encuentra (no promesas, es sincrónico)
  const existingById    = db.findStudentById(studentId);
  const existingByEmail = db.findStudentByEmail(ADMIN_EMAIL);
  const existing = existingById || existingByEmail;

  if (existing) {
    db.updateStudent(existing.id || studentId, { active: true, name: ADMIN_NAME });
    console.log(`✅ Admin actualizado en DB local: ${ADMIN_EMAIL}`);
  } else {
    db.createStudent({
      id:            studentId,
      email:         ADMIN_EMAIL,
      name:          ADMIN_NAME,
      studentId:     'ADMIN-001',
      active:        true,
      allowedVideos: ['*'],
    });
    console.log(`✅ Admin registrado en DB local: ${ADMIN_EMAIL}`);
  }

  console.log('\n=== ADMIN CREADO EXITOSAMENTE ===');
  console.log(`Email:    ${ADMIN_EMAIL}`);
  console.log(`Password: ${ADMIN_PASSWORD}`);
  console.log(`UID:      ${uid}`);
  console.log(`Proyecto: ${serviceAccount.project_id}`);
  console.log('================================\n');

  process.exit(0);
}

createAdmin().catch(err => {
  console.error('❌ Error:', err.message || err);
  process.exit(1);
});
