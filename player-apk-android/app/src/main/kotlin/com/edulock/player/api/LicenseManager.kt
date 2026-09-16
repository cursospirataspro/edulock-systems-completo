package com.edulock.player.api

import android.content.Context
import android.util.Log
import com.google.gson.Gson
import com.edulock.player.api.data.LicenseActivateRequest
import com.edulock.player.api.data.LicenseActivateResponse
import com.edulock.player.api.data.SessionActivateLicenseRequest
import com.edulock.player.api.data.SessionActivateLicenseResponse
import com.edulock.player.api.data.ValidateActivationRequest
import com.edulock.player.api.data.ValidateActivationResponse
import com.edulock.player.utils.ActivationStore
import com.edulock.player.utils.AppSignature
import com.edulock.player.utils.DeviceFingerprintAdvanced
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * LicenseManager.kt — Lógica de activación/validación de licencia (paridad con el PC).
 *
 * - activate(): canjea una clave de licencia y guarda la activación local.
 * - validate(): valida la activación local contra el servidor; si el admin
 *   regeneró/revocó la licencia, borra la activación local y lo señala con `revoked`.
 */
object LicenseManager {

    private const val TAG = "LicenseManager"
    private val APP_VERSION get() = com.edulock.player.BuildConfig.VERSION_NAME

    /** Códigos que invalidan la activación local (debe pedirse la licencia de nuevo). */
    private val REVOKE_CODES = setOf(
        "LICENSE_REGENERATED", "ACTIVATION_REVOKED", "ACTIVATION_NOT_FOUND",
        "ACTIVATION_EXPIRED", "ACCOUNT_SUSPENDED", "DEVICE_MISMATCH"
    )

    private val gson = Gson()

    data class ActivateResult(
        val ok: Boolean,
        val code: String? = null,
        val error: String? = null
    )

    data class ValidationResult(
        val valid: Boolean,
        val code: String? = null,
        val error: String? = null,
        /** true cuando la activación local ya no sirve y se debe re-ingresar la licencia. */
        val revoked: Boolean = false,
        /** true cuando hubo un fallo de red (no expulsar al usuario). */
        val networkError: Boolean = false
    )

    /** deviceId estable del dispositivo (mismo que se usa en el login). */
    private fun deviceId(context: Context): String =
        DeviceFingerprintAdvanced.captureFullDeviceInfo(context).deviceId

    /**
     * Activa una clave de licencia en este dispositivo.
     * En caso de éxito guarda la activación localmente.
     */
    suspend fun activate(context: Context, licenseKey: String): ActivateResult = withContext(Dispatchers.IO) {
        try {
            val devId = deviceId(context)
            val jwt = com.edulock.player.utils.SessionManager.validToken(context)
            val req = SessionActivateLicenseRequest(
                licenseKey = licenseKey.trim().uppercase(),
                deviceId = devId
            )
            val resp = ApiClient.getService().sessionActivateLicense("Bearer $jwt", req)

            if (resp.isSuccessful) {
                val body = resp.body() ?: return@withContext ActivateResult(false, error = "Respuesta inválida del servidor")
                val newToken = body.token
                if (newToken.isNullOrBlank()) {
                    return@withContext ActivateResult(false, error = "Respuesta inválida del servidor")
                }
                // Save Stage 2 JWT
                context.getSharedPreferences("edulock_auth", Context.MODE_PRIVATE).edit()
                    .putString("jwt_token", newToken).putLong("login_timestamp", System.currentTimeMillis()).apply()
                // Save activation state locally
                ActivationStore.save(
                    context,
                    activationToken = newToken,
                    licenseId = body.licenseId,
                    studentId = null,
                    courseId = body.courseId,
                    deviceId = devId
                )
                ActivateResult(true)
            } else {
                val err = parseErrorSession(resp.errorBody()?.string())
                ActivateResult(false, code = err.first, error = err.second)
            }
        } catch (e: Exception) {
            Log.w(TAG, "activate() error: ${e.message}")
            ActivateResult(false, code = "NETWORK_ERROR", error = "Error de conexión: ${e.message}")
        }
    }

    /**
     * Valida la activación local contra el servidor. Si la licencia fue
     * regenerada/revocada, borra la activación local y devuelve revoked=true.
     */
    suspend fun validate(context: Context, videoId: String? = null): ValidationResult = withContext(Dispatchers.IO) {
        val local = ActivationStore.read(context)
            ?: return@withContext ValidationResult(false, code = "NO_LOCAL_ACTIVATION", revoked = true)

        try {
            val devId = deviceId(context)
            val (ts, sig) = AppSignature.headers()
            val req = ValidateActivationRequest(
                activationToken = local.activationToken,
                deviceId = devId,
                videoId = videoId
            )
            val resp = ApiClient.getService().validateActivation(ts.toString(), sig, req)

            if (resp.isSuccessful && resp.body()?.valid == true) {
                return@withContext ValidationResult(true)
            }

            val body = resp.body()
            val err = if (resp.isSuccessful) body?.code to body?.error else parseError(resp.errorBody()?.string())
            val code = err.first ?: "VALIDATION_FAILED"
            val revoked = REVOKE_CODES.contains(code)
            if (revoked) {
                ActivationStore.clear(context)
            }
            ValidationResult(false, code = code, error = err.second, revoked = revoked)
        } catch (e: Exception) {
            Log.w(TAG, "validate() error: ${e.message}")
            // Fallo de red transitorio: no expulsar al usuario
            ValidationResult(false, code = "NETWORK_ERROR", error = e.message, networkError = true)
        }
    }

    /** Extrae (code, error) de un cuerpo de error JSON `{ error, code }`. */
    private fun parseError(json: String?): Pair<String?, String?> {
        if (json.isNullOrBlank()) return null to null
        return try {
            val r = gson.fromJson(json, LicenseActivateResponse::class.java)
            r.code to r.error
        } catch (_: Exception) {
            null to null
        }
    }

    private fun parseErrorSession(json: String?): Pair<String?, String?> {
        if (json.isNullOrBlank()) return null to null
        return try {
            val r = gson.fromJson(json, SessionActivateLicenseResponse::class.java)
            r.code to r.error
        } catch (_: Exception) {
            null to null
        }
    }

    fun isRevokeCode(code: String?): Boolean = code != null && REVOKE_CODES.contains(code)
}
