package com.edulock.player.utils

import android.content.Context
import android.os.Build
import java.security.MessageDigest

/**
 * DeviceFingerprint - Captura básica de huella de dispositivo
 * @deprecated Usar DeviceFingerprintAdvanced para captura de 13 campos
 */
object DeviceFingerprint {

    fun getDeviceId(context: Context): String {
        val raw = "${Build.MANUFACTURER}_${Build.MODEL}_${Build.SERIAL}"
        return sha256(raw)
    }

    private fun sha256(input: String): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest(input.toByteArray())
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
