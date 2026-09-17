package com.edulock.player.utils

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.edulock.player.api.ApiClient
import com.edulock.player.api.data.KeyAttestationPayload
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec

/**
 * Atestación por hardware (Android Key Attestation).
 * Pide un desafío al servidor, genera una clave EC en el Keystore del dispositivo con ese desafío
 * (StrongBox si existe, si no TEE) y devuelve la cadena de certificados que el hardware firma y
 * que termina en una raíz de Google. El servidor la verifica. Si algo falla devuelve null y el
 * inicio de sesión sigue exactamente igual: nunca bloquea al alumno.
 */
object KeyAttestation {
    private const val TAG = "KeyAttestation"
    private const val ALIAS = "edulock_attestation"

    suspend fun collect(context: Context): KeyAttestationPayload? = withContext(Dispatchers.IO) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return@withContext null
        try {
            val challenge = withTimeoutOrNull(5000L) {
                ApiClient.getService().attestationChallenge().body()?.challenge
            } ?: return@withContext null
            val strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
                context.packageManager.hasSystemFeature("android.hardware.strongbox_keystore")
            val chain = generate(challenge, strongBox) ?: generate(challenge, false) ?: return@withContext null
            KeyAttestationPayload(challenge = challenge, chain = chain, securityLevel = if (strongBox) "strongbox" else "tee")
        } catch (e: Exception) {
            Log.w(TAG, "sin atestación: ${e.message}")
            null
        } finally {
            try { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS) } catch (_: Exception) { }
        }
    }

    private fun generate(challenge: String, strongBox: Boolean): List<String>? {
        return try {
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAttestationChallenge(challenge.toByteArray(Charsets.UTF_8))
            if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true)
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            generator.initialize(spec.build())
            generator.generateKeyPair()
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val certs = keyStore.getCertificateChain(ALIAS)
            if (certs == null || certs.size < 2) null else certs.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
        } catch (e: Exception) {
            Log.w(TAG, "keystore ${if (strongBox) "StrongBox" else "TEE"}: ${e.message}")
            null
        }
    }
}
