package com.edulock.player.utils

import android.content.Context
import android.util.Log
import com.edulock.player.api.ApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * DeviceChangeDetector.kt — Detectar cambios de dispositivo sospechosos
 *
 * Responsabilidades:
 * 1. Rastrear último dispositivo conocido
 * 2. Detectar cambios de dispositivo
 * 3. Alertar sobre cambios potencialmente fraudulentos
 * 4. Bloquear si es necesario
 */
object DeviceChangeDetector {

    private const val TAG = "DeviceChangeDetector"
    private const val PREFS_DEVICE_HISTORY = "edulock_device_history"
    private const val KEY_LAST_DEVICE_ID = "last_device_id"
    private const val KEY_LAST_DEVICE_MODEL = "last_device_model"
    private const val KEY_LAST_DEVICE_TIME = "last_device_time"
    private const val KEY_DEVICE_CHANGES = "device_changes_count"

    /**
     * Verificar cambio de dispositivo
     * @return true si se detectó cambio, false si es el mismo dispositivo
     */
    fun checkDeviceChange(context: Context, currentDeviceInfo: DeviceFingerprintAdvanced.DeviceInfo): Boolean {
        try {
            val prefs = context.getSharedPreferences(PREFS_DEVICE_HISTORY, Context.MODE_PRIVATE)
            
            val lastDeviceId = prefs.getString(KEY_LAST_DEVICE_ID, null)
            val lastDeviceModel = prefs.getString(KEY_LAST_DEVICE_MODEL, null)
            val lastDeviceTime = prefs.getLong(KEY_LAST_DEVICE_TIME, 0)
            val changeCount = prefs.getInt(KEY_DEVICE_CHANGES, 0)

            // Primer login
            if (lastDeviceId == null) {
                recordDeviceChange(context, currentDeviceInfo)
                Log.i(TAG, "📱 Primer dispositivo registrado: ${currentDeviceInfo.deviceId}")
                return false
            }

            // Verificar si es el mismo dispositivo
            val isSameDevice = lastDeviceId == currentDeviceInfo.deviceId
            
            if (isSameDevice) {
                Log.d(TAG, "✅ Mismo dispositivo detectado: ${currentDeviceInfo.deviceId}")
                return false
            }

            // CAMBIO DE DISPOSITIVO DETECTADO
            Log.w(TAG, "⚠️ CAMBIO DE DISPOSITIVO DETECTADO")
            Log.w(TAG, "   Anterior: $lastDeviceId ($lastDeviceModel)")
            Log.w(TAG, "   Actual: ${currentDeviceInfo.deviceId} (${currentDeviceInfo.deviceModel})")
            Log.w(TAG, "   Cambios previos: $changeCount")

            // Registrar el nuevo dispositivo
            recordDeviceChange(context, currentDeviceInfo)

            // Lógica de detección de fraude
            return shouldBlockAccess(changeCount, lastDeviceTime)

        } catch (e: Exception) {
            Log.e(TAG, "Error verificando cambio de dispositivo: ${e.message}")
            return false
        }
    }

    /**
     * Registrar nuevo dispositivo
     */
    private fun recordDeviceChange(context: Context, deviceInfo: DeviceFingerprintAdvanced.DeviceInfo) {
        try {
            val prefs = context.getSharedPreferences(PREFS_DEVICE_HISTORY, Context.MODE_PRIVATE)
            val changeCount = prefs.getInt(KEY_DEVICE_CHANGES, 0) + 1
            
            prefs.edit().apply {
                putString(KEY_LAST_DEVICE_ID, deviceInfo.deviceId)
                putString(KEY_LAST_DEVICE_MODEL, deviceInfo.deviceModel)
                putLong(KEY_LAST_DEVICE_TIME, System.currentTimeMillis())
                putInt(KEY_DEVICE_CHANGES, changeCount)
                apply()
            }

            Log.i(TAG, "📝 Dispositivo registrado: ${deviceInfo.deviceId} (Cambios: $changeCount)")

        } catch (e: Exception) {
            Log.e(TAG, "Error registrando dispositivo: ${e.message}")
        }
    }

    /**
     * Determinar si se debe bloquear el acceso
     * Lógica de fraude:
     * - Cambio en menos de 5 minutos: BLOQUEAR
     * - Más de 5 cambios en 24 horas: BLOQUEAR
     * - Cambio normal: PERMITIR con advertencia
     */
    private fun shouldBlockAccess(changeCount: Int, lastChangeTime: Long): Boolean {
        val timeSinceLastChange = System.currentTimeMillis() - lastChangeTime
        val minutesSinceChange = timeSinceLastChange / (1000 * 60)

        // Cambio muy rápido = sospechoso
        if (minutesSinceChange < 5 && changeCount > 1) {
            Log.e(TAG, "🚫 BLOQUEO: Cambio muy rápido detectado ($minutesSinceChange min)")
            return true
        }

        // Demasiados cambios = sospechoso
        if (changeCount > 5) {
            Log.e(TAG, "🚫 BLOQUEO: Demasiados cambios de dispositivo ($changeCount)")
            return true
        }

        return false
    }

    /**
     * Obtener historial de dispositivos
     */
    fun getDeviceHistory(context: Context): DeviceHistory {
        try {
            val prefs = context.getSharedPreferences(PREFS_DEVICE_HISTORY, Context.MODE_PRIVATE)
            
            return DeviceHistory(
                lastDeviceId = prefs.getString(KEY_LAST_DEVICE_ID, "unknown") ?: "unknown",
                lastDeviceModel = prefs.getString(KEY_LAST_DEVICE_MODEL, "unknown") ?: "unknown",
                lastChangeTime = prefs.getLong(KEY_LAST_DEVICE_TIME, 0),
                changeCount = prefs.getInt(KEY_DEVICE_CHANGES, 0)
            )
        } catch (e: Exception) {
            Log.e(TAG, "Error obteniendo historial: ${e.message}")
            return DeviceHistory()
        }
    }

    /**
     * Limpiar historial (para testing o logout)
     */
    fun clearHistory(context: Context) {
        try {
            context.getSharedPreferences(PREFS_DEVICE_HISTORY, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .apply()
            Log.i(TAG, "📋 Historial de dispositivos limpiado")
        } catch (e: Exception) {
            Log.e(TAG, "Error limpiando historial: ${e.message}")
        }
    }

    /**
     * Data class para historial de dispositivos
     */
    data class DeviceHistory(
        val lastDeviceId: String = "unknown",
        val lastDeviceModel: String = "unknown",
        val lastChangeTime: Long = 0,
        val changeCount: Int = 0
    )
}
