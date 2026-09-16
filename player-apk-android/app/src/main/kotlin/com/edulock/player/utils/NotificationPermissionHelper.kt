package com.edulock.player.utils

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * NotificationPermissionHelper.kt — Solicitud de permisos de notificación
 *
 * En Android 13+, se requiere permiso POST_NOTIFICATIONS en tiempo de ejecución
 * para poder mostrar notificaciones push.
 *
 * Esta clase maneja:
 * - Verificación de permisos
 * - Solicitud de permisos si es necesario
 * - Callbacks cuando el usuario acepta/rechaza
 */
object NotificationPermissionHelper {

    private const val TAG = "NotificationPermissionHelper"
    const val PERMISSION_REQUEST_CODE = 101

    /**
     * Verifica si la APP tiene permiso para mostrar notificaciones
     */
    fun hasNotificationPermission(context: Context): Boolean {
        // En Android 12 e inferiores, no es necesario permiso especial
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true
        }

        // En Android 13+, verificar el permiso POST_NOTIFICATIONS
        val hasPermission = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED

        Log.d(TAG, "Permiso de notificaciones: ${if (hasPermission) "✅ Concedido" else "❌ No concedido"}")
        return hasPermission
    }

    /**
     * Solicita permiso de notificaciones al usuario (si es Android 13+)
     * @param activity Activity que hace la solicitud
     * @return true si el permiso ya estaba concedido, false si se necesita solicitar
     */
    fun requestNotificationPermission(activity: Activity): Boolean {
        // En Android 12 e inferiores, permiso automático
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            Log.d(TAG, "Android < 13: Permiso de notificaciones automático")
            return true
        }

        // Verificar si ya tiene permiso
        if (hasNotificationPermission(activity)) {
            Log.d(TAG, "Permiso ya concedido")
            return true
        }

        // Solicitar permiso
        Log.d(TAG, "Solicitando permiso POST_NOTIFICATIONS...")
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            PERMISSION_REQUEST_CODE
        )

        return false
    }

    /**
     * Procesar resultado de solicitud de permiso
     * Llamar desde Activity.onRequestPermissionsResult()
     */
    fun handlePermissionResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
        onGranted: () -> Unit,
        onDenied: () -> Unit
    ) {
        if (requestCode != PERMISSION_REQUEST_CODE) {
            return
        }

        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "✅ Permiso de notificaciones CONCEDIDO por usuario")
            onGranted()
        } else {
            Log.w(TAG, "❌ Permiso de notificaciones RECHAZADO por usuario")
            onDenied()
        }
    }

    /**
     * Mensaje a mostrar al usuario cuando se solicita permiso
     */
    fun getPermissionExplanation(): String {
        return """
            EDULOCK Player necesita permiso para notificaciones.
            
            Recibirás notificaciones cuando:
            • Tu solicitud de acceso sea aprobada
            • Tu acceso sea rechazado o suspendido
            • Haya anuncios importantes
            
            Puedes cambiar esto después en Configuración.
        """.trimIndent()
    }
}
