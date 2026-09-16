package com.edulock.player.utils

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.security.MessageDigest

/**
 * DeviceFingerprintAdvanced.kt — Captura avanzada de información del dispositivo
 *
 * Replica exactamente lo que hace el reproductor de PC:
 * - Modelo del dispositivo (Manufacturer + Model)
 * - Serial del dispositivo (Build.SERIAL o fallback)
 * - ID único persistente basado en hardware
 * - Información del SO (versión, API level)
 * - Información de hardware (RAM, CPU cores)
 *
 * Objetivo: Crear un "fingerprint" único y persistente para cada dispositivo
 * que no pueda falsificarse fácilmente.
 */
object DeviceFingerprintAdvanced {

    private const val TAG = "DeviceFingerprintAdvanced"

    /**
     * Estructura de información del dispositivo
     * Igual a lo que captura el reproductor de PC
     */
    data class DeviceInfo(
        val deviceModel: String,                  // "Samsung Galaxy A10" (Manufacturer + Model)
        val deviceSerial: String,                 // Serial del dispositivo
        val deviceId: String,                     // SHA-256 hex hash (dev_xxxxxxxxxxxxxxxx)
        val osVersion: String,                    // "Android 11" (SO + API level)
        val osVersionCode: Int,                   // API level (30, 31, 32, etc)
        val cpuCores: Int,                        // Número de cores disponibles
        val totalRam: String,                     // RAM total en MB/GB
        val androidId: String,                    // ANDROID_ID del dispositivo
        val buildFingerprint: String,             // Build.FINGERPRINT de Android
        val brand: String,                        // Build.BRAND (ej: "samsung")
        val manufacturer: String,                 // Build.MANUFACTURER (ej: "Samsung")
        val hwSerial: String,                     // Build.SERIAL (ej: "R38M7087CKL")
        val captureTime: Long                     // Timestamp de captura
    )

    /**
     * Captura TODA la información del dispositivo (como PC hace con WMI)
     * @param context Activity context
     * @return DeviceInfo con todos los datos
     */
    @SuppressLint("HardwareIds")
    fun captureFullDeviceInfo(context: Context): DeviceInfo {
        val now = System.currentTimeMillis()

        // 1. Modelo del dispositivo (Manufacturer + Model)
        val manufacturer = Build.MANUFACTURER
        val model = Build.MODEL
        val deviceModel = "$manufacturer $model"  // "Samsung Galaxy A10"

        // 2. Serial del dispositivo
        val deviceSerial = getDeviceSerial()

        // 3. ANDROID_ID (ID único del dispositivo)
        val androidId = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ANDROID_ID
        ) ?: "unknown"

        // 4. Build.FINGERPRINT (identificador único del build)
        val buildFingerprint = Build.FINGERPRINT

        // 5. Versión del SO
        val osVersion = "Android ${Build.VERSION.RELEASE}"
        val osVersionCode = Build.VERSION.SDK_INT

        // 6. CPU cores
        val cpuCores = Runtime.getRuntime().availableProcessors()

        // 7. RAM total disponible
        val totalRam = getTotalRAM(context)

        // 8. Brand (fabricante del brand)
        val brand = Build.BRAND

        // 9. Generar deviceId único (SHA-256 de múltiples fuentes)
        val deviceId = stableDeviceId(context, androidId, buildFingerprint, deviceSerial)

        return DeviceInfo(
            deviceModel = deviceModel,
            deviceSerial = deviceSerial,
            deviceId = deviceId,
            osVersion = osVersion,
            osVersionCode = osVersionCode,
            cpuCores = cpuCores,
            totalRam = totalRam,
            androidId = androidId,
            buildFingerprint = buildFingerprint,
            brand = brand,
            manufacturer = manufacturer,
            hwSerial = deviceSerial,
            captureTime = now
        )
    }

    /**
     * El serial restringido no está disponible para una aplicación normal.
     * La identidad estable conserva la activación existente y no depende
     * de obtener permisos privilegiados de telefonía.
     */
    private fun getDeviceSerial(): String {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                "unknown"
            } else {
                Build.SERIAL
            }
        } catch (e: Exception) {
            Log.w(TAG, "No se pudo obtener serial: ${e.message}")
            "unknown"
        }
    }

    @Synchronized
    private fun stableDeviceId(context: Context, androidId: String, fingerprint: String, serial: String): String {
        val prefs = context.getSharedPreferences("edulock_device_identity", Context.MODE_PRIVATE)
        prefs.getString("device_id", null)?.takeIf { it.isNotBlank() }?.let { return it }
        // Preserve an existing licensed identity before freezing the legacy hash.
        val prior = ActivationStore.read(context)?.deviceId?.takeIf { it.isNotBlank() }
        val id = prior ?: generateAdvancedDeviceId(androidId, fingerprint, serial)
        check(id != "dev_unknown") { "No se pudo identificar el dispositivo" }
        check(prefs.edit().putString("device_id", id).commit()) { "No se pudo guardar el dispositivo" }
        return id
    }

    /**
     * Calcula RAM total en formato legible
     */
    private fun getTotalRAM(context: Context): String {
        return try {
            val runtime = Runtime.getRuntime()
            val memInfo = ActivityManager.MemoryInfo()
            val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            activityManager.getMemoryInfo(memInfo)

            val totalMemory = memInfo.totalMem
            val gb = totalMemory / (1024.0 * 1024.0 * 1024.0)
            val mb = totalMemory / (1024.0 * 1024.0)

            when {
                gb >= 1.0 -> String.format("%.1f GB", gb)
                else -> String.format("%.0f MB", mb)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error calculando RAM: ${e.message}")
            "unknown"
        }
    }

    /**
     * Genera un Device ID único basado en múltiples fuentes
     * Usa SHA-256, igual que el reproductor de PC
     * Formato: "dev_<16 caracteres hex>"
     *
     * Entrada: androidId + buildFingerprint + deviceSerial + ANDROID_ID persistente
     * Salida: SHA-256 hash (primeros 16 caracteres en hex)
     */
    private fun generateAdvancedDeviceId(
        androidId: String,
        buildFingerprint: String,
        deviceSerial: String
    ): String {
        try {
            // Concatenar múltiples valores para mayor entropía
            val input = "$androidId|$buildFingerprint|$deviceSerial"
            val bytes = MessageDigest.getInstance("SHA-256")
                .digest(input.toByteArray())
            val hexString = bytes.joinToString("") { "%02x".format(it) }
            return "dev_${hexString.substring(0, 16)}"
        } catch (e: Exception) {
            Log.e(TAG, "Error generando deviceId: ${e.message}")
            return "dev_unknown"
        }
    }

    /**
     * Formatea la información del dispositivo para logging/watermark
     */
    fun formatDeviceInfo(info: DeviceInfo): String {
        return buildString {
            appendLine("═══════════════════════════════════════")
            appendLine("📱 INFORMACIÓN DEL DISPOSITIVO")
            appendLine("═══════════════════════════════════════")
            appendLine("Modelo: ${info.deviceModel}")
            appendLine("Serial: ${info.deviceSerial}")
            appendLine("Device ID: ${info.deviceId}")
            appendLine("SO: ${info.osVersion} (API ${info.osVersionCode})")
            appendLine("CPU Cores: ${info.cpuCores}")
            appendLine("RAM Total: ${info.totalRam}")
            appendLine("Brand: ${info.brand}")
            appendLine("Build: ${info.buildFingerprint}")
            appendLine("Android ID: ${info.androidId}")
            appendLine("═══════════════════════════════════════")
        }
    }

    /**
     * Formatea para watermark/auditoria (formato compacto)
     * Formato: EDULOCK|timestamp|deviceId|modelo|serial
     */
    fun formatWatermarkText(
        context: Context,
        email: String,
        deviceInfo: DeviceInfo
    ): String {
        val timestamp = System.currentTimeMillis()
        return "EDULOCK|$timestamp|$email|${deviceInfo.deviceId}|${deviceInfo.deviceModel}"
    }
}
