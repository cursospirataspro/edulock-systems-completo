/**
 * firebase-notification.js — Servicio de notificaciones push
 *
 * Responsabilidades:
 * 1. Inicializar Firebase Admin SDK
 * 2. Enviar notificaciones push a dispositivos Android (vía FCM)
 * 3. Enviar mensajes a tópicos (broadcasts)
 * 4. Registrar logs de notificaciones enviadas
 *
 * Uso:
 *   const notif = require('./firebase-notification');
 *   await notif.sendApprovalNotification(deviceId, email, courseIds);
 *   await notif.sendRejectionNotification(deviceId, email, reason);
 *   await notif.sendSuspensionNotification(deviceId, email, reason);
 */

'use strict';

require('dotenv').config();

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

let isInitialized = false;

/**
 * Inicializar Firebase Admin SDK
 * Busca firebase-service-account.json
 */
function initializeFirebase() {
    if (isInitialized) return true;

    try {
        const serviceAccountPath = path.resolve(
            process.env.FIREBASE_KEY_PATH ||
            './firebase-service-account.json'
        );

        if (!fs.existsSync(serviceAccountPath)) {
            console.error('[Firebase] ❌ No encontrado:', serviceAccountPath);
            console.error('[Firebase] Crear firebase-service-account.json descargado desde Google Cloud Console');
            return false;
        }

        const serviceAccount = require(serviceAccountPath);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DB_URL || undefined,
        });

        isInitialized = true;
        console.log('[Firebase] ✅ Admin SDK inicializado');
        return true;

    } catch (err) {
        console.error('[Firebase] ❌ Error inicializando:', err.message);
        return false;
    }
}

/**
 * Enviar notificación de APROBACIÓN
 * @param {string} fcmToken Token de FCM del dispositivo
 * @param {string} email Email del usuario
 * @param {Array<string>} courseIds IDs de cursos asignados
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendApprovalNotification(fcmToken, email, courseIds = []) {
    if (!isInitialized && !initializeFirebase()) {
        return {
            success: false,
            error: 'Firebase no inicializado',
        };
    }

    if (!fcmToken) {
        console.warn('[Firebase] ⚠️ FCM token vacío para:', email);
        return {
            success: false,
            error: 'FCM token not provided',
        };
    }

    try {
        const courseNames = courseIds.map(id => formatCourseName(id)).join(', ');
        const coursesText = courseIds.length > 0
            ? `\n\nCursos asignados:\n${courseIds.map(id => `• ${formatCourseName(id)}`).join('\n')}`
            : '';

        const message = {
            notification: {
                title: '✅ ¡Tu acceso fue APROBADO!',
                body: `Hola ${email}!\n\nTu solicitud ha sido aprobada.${coursesText}`,
            },
            data: {
                type: 'registration_approved',
                status: 'approved',
                email: email,
                courseIds: courseIds.join(','),
                timestamp: Date.now().toString(),
                action: 'open_app',
            },
            token: fcmToken,
        };

        const response = await admin.messaging().send(message);

        console.log(`[Firebase] ✅ Notificación de aprobación enviada a ${email}`);
        console.log(`[Firebase] Message ID: ${response}`);

        return {
            success: true,
            messageId: response,
        };

    } catch (error) {
        console.error(`[Firebase] ❌ Error enviando notificación de aprobación:`, error.message);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * Enviar notificación de RECHAZO
 * @param {string} fcmToken Token de FCM del dispositivo
 * @param {string} email Email del usuario
 * @param {string} reason Razón del rechazo (opcional)
 */
async function sendRejectionNotification(fcmToken, email, reason = 'Información insuficiente') {
    if (!isInitialized && !initializeFirebase()) {
        return { success: false, error: 'Firebase no inicializado' };
    }

    if (!fcmToken) {
        console.warn('[Firebase] ⚠️ FCM token vacío para:', email);
        return { success: false, error: 'FCM token not provided' };
    }

    try {
        const message = {
            notification: {
                title: '❌ Solicitud Rechazada',
                body: `Tu solicitud de acceso ha sido rechazada.\n\nRazón: ${reason}`,
            },
            data: {
                type: 'registration_rejected',
                status: 'rejected',
                email: email,
                reason: reason,
                timestamp: Date.now().toString(),
                action: 'show_message',
            },
            token: fcmToken,
        };

        const response = await admin.messaging().send(message);

        console.log(`[Firebase] ✅ Notificación de rechazo enviada a ${email}`);

        return {
            success: true,
            messageId: response,
        };

    } catch (error) {
        console.error(`[Firebase] ❌ Error enviando notificación de rechazo:`, error.message);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * Enviar notificación de SUSPENSIÓN
 * @param {string} fcmToken Token de FCM del dispositivo
 * @param {string} email Email del usuario
 * @param {string} reason Razón de la suspensión
 */
async function sendSuspensionNotification(fcmToken, email, reason = 'Violación de términos de servicio') {
    if (!isInitialized && !initializeFirebase()) {
        return { success: false, error: 'Firebase no inicializado' };
    }

    if (!fcmToken) {
        console.warn('[Firebase] ⚠️ FCM token vacío para:', email);
        return { success: false, error: 'FCM token not provided' };
    }

    try {
        const message = {
            notification: {
                title: '⚠️ Cuenta Suspendida',
                body: `Tu acceso ha sido suspendido.\n\nRazón: ${reason}`,
            },
            data: {
                type: 'registration_suspended',
                status: 'suspended',
                email: email,
                reason: reason,
                timestamp: Date.now().toString(),
                action: 'show_warning',
            },
            token: fcmToken,
        };

        const response = await admin.messaging().send(message);

        console.log(`[Firebase] ✅ Notificación de suspensión enviada a ${email}`);

        return {
            success: true,
            messageId: response,
        };

    } catch (error) {
        console.error(`[Firebase] ❌ Error enviando notificación de suspensión:`, error.message);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * Enviar notificación a un tópico (broadcast a todos los suscritos)
 * @param {string} topic Nombre del tópico (ej: "announcements", "urgent")
 * @param {string} title Título
 * @param {string} body Cuerpo del mensaje
 * @param {Object} data Datos adicionales
 */
async function sendTopicNotification(topic, title, body, data = {}) {
    if (!isInitialized && !initializeFirebase()) {
        return { success: false, error: 'Firebase no inicializado' };
    }

    try {
        const message = {
            notification: {
                title: title,
                body: body,
            },
            data: {
                timestamp: Date.now().toString(),
                ...data,
            },
            topic: topic,
        };

        const response = await admin.messaging().send(message);

        console.log(`[Firebase] ✅ Notificación de tópico enviada a ${topic}`);

        return {
            success: true,
            messageId: response,
        };

    } catch (error) {
        console.error(`[Firebase] ❌ Error enviando notificación de tópico:`, error.message);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * Suscribir dispositivo a un tópico
 * @param {string} fcmToken Token FCM
 * @param {string} topic Nombre del tópico
 */
async function subscribeToTopic(fcmToken, topic) {
    if (!isInitialized && !initializeFirebase()) {
        return false;
    }

    try {
        await admin.messaging().subscribeToTopic(fcmToken, topic);
        console.log(`[Firebase] ✅ Token suscrito a tópico: ${topic}`);
        return true;
    } catch (error) {
        console.error(`[Firebase] ❌ Error suscribiendo a tópico:`, error.message);
        return false;
    }
}

/**
 * Desuscribir dispositivo de un tópico
 * @param {string} fcmToken Token FCM
 * @param {string} topic Nombre del tópico
 */
async function unsubscribeFromTopic(fcmToken, topic) {
    if (!isInitialized && !initializeFirebase()) {
        return false;
    }

    try {
        await admin.messaging().unsubscribeFromTopic(fcmToken, topic);
        console.log(`[Firebase] ✅ Token desuscrito de tópico: ${topic}`);
        return true;
    } catch (error) {
        console.error(`[Firebase] ❌ Error desuscribiendo de tópico:`, error.message);
        return false;
    }
}

/**
 * Formatea el nombre del curso para mostrar
 */
function formatCourseName(courseId) {
    const names = {
        'course_python': 'Python',
        'course_react': 'React',
        'course_nodejs': 'Node.js',
        'course_vue': 'Vue.js',
        'course_angular': 'Angular',
    };
    return names[courseId] || courseId.replace('course_', '').toUpperCase();
}

// ================================================================
// EXPORTAR
// ================================================================

module.exports = {
    initializeFirebase,
    sendApprovalNotification,
    sendRejectionNotification,
    sendSuspensionNotification,
    sendTopicNotification,
    subscribeToTopic,
    unsubscribeFromTopic,
};
