package com.edulock.player

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.firebase.Firebase
import com.google.firebase.messaging.messaging
import com.edulock.player.api.ApiClient
import com.edulock.player.security.SecurityMonitorService
import com.edulock.player.utils.DeviceFingerprint
import com.edulock.player.utils.DeviceFingerprintAdvanced
import android.content.Intent

/**
 * EdulockApp.kt — Inicialización de la aplicación
 *
 * Responsabilidades:
 * 1. Inicializar EncryptedSharedPreferences para almacenamiento seguro
 * 2. Inicializar Firebase Cloud Messaging (FCM)
 * 3. Registrar el token FCM para notificaciones push
 * 4. Capturar información del dispositivo
 * 5. Iniciar SecurityMonitorService para protecciones anti-bypass
 * 6. Configurar logging centralizado
 */
class EdulockApp : Application() {

    companion object {
        private const val TAG = "EdulockApp"
        private lateinit var instance: EdulockApp

        fun getInstance(): EdulockApp = instance
    }

    override fun onCreate() {
        super.onCreate()
        instance = this

        Log.i(TAG, "🚀 Iniciando EDULOCK Player v1.1.0")

        // 0. Inicializar API Client
        initializeApiClient()

        // 1. Inicializar almacenamiento seguro
        initializeSecureStorage()

        // 2. Capturar información del dispositivo
        captureDeviceInformation()

        // 3. Inicializar Firebase Cloud Messaging
        initializeFirebaseMessaging()

        // 4. Iniciar servicio de seguridad
        startSecurityMonitoring()

        Log.i(TAG, "✅ Inicialización completada")
    }

    /**
     * Inicializar EncryptedSharedPreferences para almacenamiento seguro
     */
    private fun initializeSecureStorage() {
        try {
            val masterKey = MasterKey.Builder(this)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()

            val encryptedSharedPreferences = EncryptedSharedPreferences.create(
                this,
                "edulock_encrypted_prefs",
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )

            Log.d(TAG, "✅ EncryptedSharedPreferences inicializado")
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error inicializando almacenamiento: ${e.message}")
        }
    }

    /**
     * Capturar información completa del dispositivo (como reproductor PC)
     */
    private fun captureDeviceInformation() {
        try {
            val deviceInfo = DeviceFingerprintAdvanced.captureFullDeviceInfo(this)
            
            // Guardar en SharedPreferences para acceso rápido
            val prefs = getSharedPreferences("edulock_device", Context.MODE_PRIVATE)
            prefs.edit().apply {
                putString("device_model", deviceInfo.deviceModel)
                putString("device_id", deviceInfo.deviceId)
                putString("device_serial", deviceInfo.deviceSerial)
                putString("os_version", deviceInfo.osVersion)
                putInt("os_version_code", deviceInfo.osVersionCode)
                putInt("cpu_cores", deviceInfo.cpuCores)
                putString("total_ram", deviceInfo.totalRam)
                putString("android_id", deviceInfo.androidId)
                putString("build_fingerprint", deviceInfo.buildFingerprint)
                putLong("capture_time", deviceInfo.captureTime)
                apply()
            }

            Log.i(TAG, "📱 Información del dispositivo capturada:")
            Log.i(TAG, DeviceFingerprintAdvanced.formatDeviceInfo(deviceInfo))

        } catch (e: Exception) {
            Log.e(TAG, "❌ Error capturando información del dispositivo: ${e.message}")
        }
    }

    /**
     * Inicializar Firebase Cloud Messaging
     * Registrar para recibir notificaciones push
     */
    private fun initializeFirebaseMessaging() {
        try {
            Log.d(TAG, "🔥 Inicializando Firebase Cloud Messaging...")

            // Obtener token FCM actual
            Firebase.messaging.token.addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    val token = task.result
                    Log.i(TAG, "✅ Token FCM obtenido")
                    
                    // Guardar token en SharedPreferences
                    val prefs = getSharedPreferences("edulock_fcm", Context.MODE_PRIVATE)
                    prefs.edit().apply {
                        putString("fcm_token", token)
                        putLong("fcm_token_generated_at", System.currentTimeMillis())
                        apply()
                    }

                    // IMPORTANTE: En el LoginActivity, este token debe enviarse al backend
                    // para que Render pueda enviar notificaciones push a este dispositivo

                } else {
                    Log.e(TAG, "❌ Error obteniendo token FCM: ${task.exception?.message}")
                }
            }

            // Habilitar registro automático (auto-init)
            Firebase.messaging.isAutoInitEnabled = true

            Log.i(TAG, "🔥 Firebase Cloud Messaging configurado")

        } catch (e: Exception) {
            Log.e(TAG, "❌ Error inicializando FCM: ${e.message}")
        }
    }

    /**
     * Inicializar API Client de Retrofit
     * Configurar URL base del servidor
     */
    private fun initializeApiClient() {
        try {
            // URL del servidor en la VPS (producción) — mismo que el reproductor PC
            val defaultUrl = "https://edulocksystemsoficial.dpdns.org/"
            val prefs = getSharedPreferences("edulock_config", Context.MODE_PRIVATE)
            val apiBaseUrl = prefs.getString("api_base_url", defaultUrl) ?: defaultUrl
            
            ApiClient.setBaseUrl(apiBaseUrl)
            Log.i(TAG, "✅ API Client configurado: $apiBaseUrl")
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error inicializando API Client: ${e.message}")
        }
    }

    /**
     * Iniciar servicio de monitoreo de seguridad
     */
    private fun startSecurityMonitoring() {
        try {
            val intent = Intent(this, SecurityMonitorService::class.java)
            startService(intent)
            Log.i(TAG, "🔒 SecurityMonitorService iniciado")
        } catch (e: Exception) {
            Log.e(TAG, "❌ Error iniciando SecurityMonitorService: ${e.message}")
        }
    }
}
