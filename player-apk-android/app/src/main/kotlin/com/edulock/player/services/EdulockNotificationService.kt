package com.edulock.player.services

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.edulock.player.R
import com.edulock.player.ui.SplashActivity

/**
 * EdulockNotificationService.kt — Servicio de notificaciones push Firebase
 *
 * Recibe notificaciones push desde Render cuando:
 * - El usuario es APROBADO
 * - El acceso es RECHAZADO
 * - El acceso es SUSPENDIDO
 * - Hay anuncios o eventos importantes
 *
 * Responsabilidades:
 * 1. Recibir mensaje FCM desde Firebase
 * 2. Extraer datos (estado, email, cursos asignados, etc.)
 * 3. Mostrar notificación al usuario
 * 4. Guardar el estado en SharedPreferences
 * 5. Notificar a la APK que hay un evento importante
 */
class EdulockNotificationService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "EdulockNotificationService"
        private const val CHANNEL_ID = "edulock_notifications"
        private const val CHANNEL_NAME = "EDULOCK Notificaciones"
        private const val NOTIFICATION_ID_APPROVAL = 1001
        private const val NOTIFICATION_ID_REJECTION = 1002
        private const val NOTIFICATION_ID_SUSPENSION = 1003
    }

    /**
     * Se llama cuando se recibe un mensaje remoto desde Firebase
     * @param remoteMessage Mensaje enviado desde el backend
     */
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        Log.d(TAG, "📬 Notificación recibida de Firebase")

        // Extraer datos
        val data = remoteMessage.data
        val title = data["title"] ?: "EDULOCK Player"
        val body = data["body"] ?: ""
        val notificationType = data["type"] ?: "info"
        val email = data["email"] ?: ""
        val status = data["status"] ?: ""  // "approved", "rejected", "suspended"
        val courseIds = data["courseIds"]?.split(",") ?: emptyList()

        Log.i(TAG, "📨 Tipo: $notificationType, Status: $status, Email: $email")

        // Procesar según el tipo
        when (notificationType) {
            "registration_approved" -> handleApprovalNotification(
                title = title,
                body = body,
                email = email,
                courseIds = courseIds,
                data = data
            )

            "registration_rejected" -> handleRejectionNotification(
                title = title,
                body = body,
                email = email,
                data = data
            )

            "registration_suspended" -> handleSuspensionNotification(
                title = title,
                body = body,
                email = email,
                data = data
            )

            else -> {
                // Notificación genérica
                showNotification(
                    title = title,
                    body = body,
                    notificationId = 1000 + (Math.random() * 1000).toInt()
                )
            }
        }

        // Guardar en preferences que hay una notificación nueva
        saveNotificationEvent(notificationType, data)
    }

    /**
     * Se llama cuando se registra un nuevo token FCM
     * @param token El token de FCM para este dispositivo
     */
    override fun onNewToken(token: String) {
        Log.d(TAG, "Token de notificaciones actualizado")

        // Guardar token en SharedPreferences para enviarlo al backend
        val sharedPref = getSharedPreferences("edulock_fcm", Context.MODE_PRIVATE)
        sharedPref.edit().apply {
            putString("fcm_token", token)
            putLong("fcm_token_timestamp", System.currentTimeMillis())
            apply()
        }

        // IMPORTANTE: Enviar este token al backend cuando el usuario inicie sesión
        // Para que el backend sepa dónde enviar futuras notificaciones
        Log.i(TAG, "✅ Token guardado en SharedPreferences (se enviará al backend en próximo login)")
    }

    /**
     * Manejar notificación de APROBACIÓN
     */
    private fun handleApprovalNotification(
        title: String,
        body: String,
        email: String,
        courseIds: List<String>,
        data: Map<String, String>
    ) {
        Log.i(TAG, "✅ APROBACIÓN recibida para: $email")
        Log.i(TAG, "📚 Cursos asignados: $courseIds")

        // Guardar estado en preferences
        val sharedPref = getSharedPreferences("edulock_registration", Context.MODE_PRIVATE)
        sharedPref.edit().apply {
            putString("registration_status", "approved")
            putString("approved_email", email)
            putString("assigned_courses", courseIds.joinToString(","))
            putLong("approval_timestamp", System.currentTimeMillis())
            apply()
        }

        // Mostrar notificación visual
        val expandedBody = buildString {
            append(body)
            append("\n\n📚 Cursos asignados:\n")
            courseIds.forEachIndexed { index, courseId ->
                append("• ${formatCourseName(courseId)}")
                if (index < courseIds.size - 1) append("\n")
            }
        }

        showNotification(
            title = "✅ $title",
            body = expandedBody,
            notificationId = NOTIFICATION_ID_APPROVAL,
            importanceHigh = true
        )

        // Notificar a la APK que hay una actualización importante
        // (si la APK está abierta, puede actualizar UI inmediatamente)
        broadcastApprovalNotification(email, courseIds)
    }

    /**
     * Manejar notificación de RECHAZO
     */
    private fun handleRejectionNotification(
        title: String,
        body: String,
        email: String,
        data: Map<String, String>
    ) {
        Log.w(TAG, "❌ RECHAZO recibido para: $email")

        val reason = data["reason"] ?: "No especificado"

        val sharedPref = getSharedPreferences("edulock_registration", Context.MODE_PRIVATE)
        sharedPref.edit().apply {
            putString("registration_status", "rejected")
            putString("rejected_email", email)
            putString("rejection_reason", reason)
            putLong("rejection_timestamp", System.currentTimeMillis())
            apply()
        }

        showNotification(
            title = "❌ $title",
            body = "Tu solicitud ha sido rechazada.\nRazón: $reason",
            notificationId = NOTIFICATION_ID_REJECTION,
            importanceHigh = true
        )

        broadcastRejectionNotification(email, reason)
    }

    /**
     * Manejar notificación de SUSPENSIÓN
     */
    private fun handleSuspensionNotification(
        title: String,
        body: String,
        email: String,
        data: Map<String, String>
    ) {
        Log.w(TAG, "⚠️ SUSPENSIÓN recibida para: $email")

        val reason = data["reason"] ?: "Violación de términos de servicio"

        val sharedPref = getSharedPreferences("edulock_registration", Context.MODE_PRIVATE)
        sharedPref.edit().apply {
            putString("registration_status", "suspended")
            putString("suspended_email", email)
            putString("suspension_reason", reason)
            putLong("suspension_timestamp", System.currentTimeMillis())
            apply()
        }

        showNotification(
            title = "⚠️ $title",
            body = "Tu acceso ha sido suspendido.\nRazón: $reason",
            notificationId = NOTIFICATION_ID_SUSPENSION,
            importanceHigh = true
        )

        broadcastSuspensionNotification(email, reason)
    }

    /**
     * Mostrar notificación visual al usuario
     */
    private fun showNotification(
        title: String,
        body: String,
        notificationId: Int,
        importanceHigh: Boolean = false
    ) {
        // Crear canal de notificación (requerido en Android 8+)
        createNotificationChannel(importanceHigh)

        // Intent para cuando el usuario toca la notificación
        val intent = Intent(this, SplashActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("from_notification", true)
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Crear la notificación
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(if (importanceHigh) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .build()

        // Mostrar la notificación
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(notificationId, notification)

        Log.i(TAG, "🔔 Notificación mostrada: ID=$notificationId")
    }

    /**
     * Crear canal de notificación (Android 8+)
     */
    private fun createNotificationChannel(isHighPriority: Boolean = false) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val importance = if (isHighPriority) {
                NotificationManager.IMPORTANCE_HIGH
            } else {
                NotificationManager.IMPORTANCE_DEFAULT
            }

            val channel = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, importance).apply {
                description = "Notificaciones de EDULOCK Player"
                enableVibration(true)
                enableLights(true)
            }

            val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
        }
    }

    /**
     * Guardar evento de notificación en SharedPreferences
     */
    private fun saveNotificationEvent(type: String, data: Map<String, String>) {
        val sharedPref = getSharedPreferences("edulock_notifications_log", Context.MODE_PRIVATE)
        sharedPref.edit().apply {
            putString("last_notification_type", type)
            putString("last_notification_timestamp", System.currentTimeMillis().toString())
            data.forEach { (key, value) ->
                putString("last_notif_$key", value)
            }
            apply()
        }
    }

    /**
     * Enviar broadcast a la APK notificando aprobación
     * (para que actualice UI inmediatamente si está abierta)
     */
    private fun broadcastApprovalNotification(email: String, courses: List<String>) {
        val intent = Intent("com.edulock.REGISTRATION_APPROVED").apply {
            putExtra("email", email)
            putExtra("courses", courses.toTypedArray())
        }
        sendBroadcast(intent)
    }

    /**
     * Enviar broadcast a la APK notificando rechazo
     */
    private fun broadcastRejectionNotification(email: String, reason: String) {
        val intent = Intent("com.edulock.REGISTRATION_REJECTED").apply {
            putExtra("email", email)
            putExtra("reason", reason)
        }
        sendBroadcast(intent)
    }

    /**
     * Enviar broadcast a la APK notificando suspensión
     */
    private fun broadcastSuspensionNotification(email: String, reason: String) {
        val intent = Intent("com.edulock.ACCOUNT_SUSPENDED").apply {
            putExtra("email", email)
            putExtra("reason", reason)
        }
        sendBroadcast(intent)
    }

    /**
     * Formatea el nombre del curso para mostrar
     */
    private fun formatCourseName(courseId: String): String {
        return when (courseId) {
            "course_python" -> "Python"
            "course_react" -> "React"
            "course_nodejs" -> "Node.js"
            "course_vue" -> "Vue.js"
            "course_angular" -> "Angular"
            else -> courseId.replace("course_", "").capitalize()
        }
    }
}
