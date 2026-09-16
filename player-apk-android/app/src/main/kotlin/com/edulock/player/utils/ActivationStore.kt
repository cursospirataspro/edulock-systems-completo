package com.edulock.player.utils

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * ActivationStore.kt — Almacenamiento local de la activación de licencia.
 *
 * Paridad con el reproductor PC (activation-store.js): guarda el `activationToken`
 * obtenido al activar una licencia, junto con metadatos. Se usa para:
 *   - Saber si el dispositivo ya tiene una licencia activada (no pedirla de nuevo).
 *   - Validar periódicamente contra el servidor y detectar si el admin la regeneró.
 *
 * Se cifra con EncryptedSharedPreferences (AndroidX Security). Si el cifrado falla
 * (algunos dispositivos viejos), cae a SharedPreferences normal para no romper la app.
 */
object ActivationStore {

    private const val TAG = "ActivationStore"
    private const val FILE = "edulock_activation"

    private const val K_TOKEN = "activation_token"
    private const val K_LICENSE = "license_id"
    private const val K_STUDENT = "student_id"
    private const val K_COURSE = "course_id"
    private const val K_DEVICE = "device_id"
    private const val K_SAVED_AT = "saved_at"

    data class Activation(
        val activationToken: String,
        val licenseId: String?,
        val studentId: String?,
        val courseId: String?,
        val deviceId: String?
    )

    private fun prefs(context: Context): SharedPreferences {
        return try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                context,
                FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        } catch (e: Exception) {
            Log.w(TAG, "EncryptedSharedPreferences no disponible, usando prefs normales: ${e.message}")
            context.getSharedPreferences("${FILE}_plain", Context.MODE_PRIVATE)
        }
    }

    fun save(
        context: Context,
        activationToken: String,
        licenseId: String?,
        studentId: String?,
        courseId: String?,
        deviceId: String?
    ) {
        prefs(context).edit().apply {
            putString(K_TOKEN, activationToken)
            putString(K_LICENSE, licenseId)
            putString(K_STUDENT, studentId)
            putString(K_COURSE, courseId)
            putString(K_DEVICE, deviceId)
            putLong(K_SAVED_AT, System.currentTimeMillis())
            apply()
        }
    }

    fun read(context: Context): Activation? {
        val p = prefs(context)
        val token = p.getString(K_TOKEN, null) ?: return null
        if (token.isBlank()) return null
        return Activation(
            activationToken = token,
            licenseId = p.getString(K_LICENSE, null),
            studentId = p.getString(K_STUDENT, null),
            courseId = p.getString(K_COURSE, null),
            deviceId = p.getString(K_DEVICE, null)
        )
    }

    fun has(context: Context): Boolean = read(context) != null

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
