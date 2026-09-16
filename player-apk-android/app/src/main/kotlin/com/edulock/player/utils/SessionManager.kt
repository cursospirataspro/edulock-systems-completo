package com.edulock.player.utils

import android.content.Context
import android.util.Base64
import com.google.firebase.auth.FirebaseAuth
import com.google.gson.JsonParser
import com.edulock.player.api.ApiClient
import com.edulock.player.api.data.FirebaseLoginRequest
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

/** Renueva silenciosamente el JWT del backend usando la sesión persistente de Firebase. */
object SessionManager {
    private const val PREFS = "edulock_auth"
    private val refreshMutex = Mutex()

    suspend fun validToken(context: Context): String = refreshMutex.withLock {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val current = prefs.getString("jwt_token", "") ?: ""
        if (current.isBlank()) throw SessionExpiredException("Tu sesión terminó. Inicia sesión nuevamente.")
        if (hasEnoughLifetime(current)) return@withLock current
        val user = FirebaseAuth.getInstance().currentUser
            ?: throw SessionExpiredException("Tu sesión terminó. Inicia sesión nuevamente.")
        val firebaseToken = suspendCoroutine { continuation ->
            user.getIdToken(true)
                .addOnSuccessListener { continuation.resume(it) }
                .addOnFailureListener { continuation.resumeWithException(it) }
        }.token
            ?: throw SessionExpiredException("No se pudo renovar la sesión de Firebase.")
        val device = DeviceFingerprintAdvanced.captureFullDeviceInfo(context)
        val fcm = context.getSharedPreferences("edulock_fcm", Context.MODE_PRIVATE).getString("fcm_token", "") ?: ""
        val response = ApiClient.getService().firebaseLogin(FirebaseLoginRequest(
            idToken = firebaseToken, uid = user.uid, email = user.email,
            deviceId = device.deviceId, deviceModel = device.deviceModel, fcmToken = fcm,
            deviceSerial = device.deviceSerial, osVersion = device.osVersion,
            totalRam = device.totalRam, buildFingerprint = device.buildFingerprint,
            brand = device.brand, manufacturer = device.manufacturer, androidId = device.androidId
        ))
        if (!com.edulock.player.ui.AuthResponsePolicy.canStartSession(response.code(), response.body())) {
            throw SessionExpiredException(response.body()?.error ?: "No se pudo renovar la sesión (HTTP ${response.code()}).")
        }
        val renewed = response.body()!!.token!!
        if (prefs.getString("jwt_token", "") != current || FirebaseAuth.getInstance().currentUser?.uid != user.uid) {
            throw SessionExpiredException("La sesión cambió. Inicia sesión nuevamente.")
        }
        prefs.edit().putString("jwt_token", renewed).putLong("login_timestamp", System.currentTimeMillis()).apply()
        renewed
    }

    fun clearBackendToken(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("jwt_token").apply()
    }

    private fun hasEnoughLifetime(token: String): Boolean = try {
        val json = String(Base64.decode(token.split('.')[1], Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
        JsonParser.parseString(json).asJsonObject.get("exp").asLong > System.currentTimeMillis() / 1000 + 300
    } catch (_: Exception) { false }
}

class SessionExpiredException(message: String) : Exception(message)
