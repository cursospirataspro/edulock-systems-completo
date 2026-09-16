'use strict';
/**
 * _setup_firebase_admin.js
 * Crea la cuenta de admin en Firebase y le asigna custom claims { admin: true }.
 * Ejecutar UNA sola vez: node _setup_firebase_admin.js
 */
require('dotenv').config();
const admin = require('firebase-admin');

let svcAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    svcAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    svcAccount = require('./firebase-service-account.json');
}

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(svcAccount) });
}

const ADMIN_EMAIL = 'admin@edulocksystemsoficial.dpdns.org';
const ADMIN_PASS  = '123456789';

async function main() {
    let user;

    // Intentar obtener usuario existente
    try {
        user = await admin.auth().getUserByEmail(ADMIN_EMAIL);
        console.log('Usuario ya existe, uid:', user.uid);
        // Actualizar contraseña por si acaso
        await admin.auth().updateUser(user.uid, { password: ADMIN_PASS, displayName: 'Administrador' });
        console.log('Contraseña actualizada.');
    } catch (e) {
        if (e.code === 'auth/user-not-found') {
            // Crear usuario
            user = await admin.auth().createUser({
                email:         ADMIN_EMAIL,
                password:      ADMIN_PASS,
                displayName:   'Administrador',
                emailVerified: true,
            });
            console.log('Usuario creado, uid:', user.uid);
        } else {
            throw e;
        }
    }

    // Asignar custom claim admin: true
    await admin.auth().setCustomUserClaims(user.uid, { admin: true });
    console.log('Custom claim { admin: true } asignado correctamente.');
    console.log('');
    console.log('ADMIN_FIREBASE_UID =', user.uid);
    console.log('Listo. Tu cuenta de admin está configurada en Firebase.');
    process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
