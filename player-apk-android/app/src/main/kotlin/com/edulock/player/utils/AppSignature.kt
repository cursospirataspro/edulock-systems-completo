package com.edulock.player.utils

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * AppSignature.kt — Firma HMAC del reproductor oficial (paridad con el PC).
 *
 * El servidor protege los endpoints de licencia con el middleware `validateAppSig`,
 * que exige dos cabeceras:
 *   - x-cdp-ts:  timestamp en milisegundos (validez ±90s contra el reloj del server)
 *   - x-cdp-sig: HMAC-SHA256(APP_SECRET, "resolve:" + ts) en hexadecimal
 *
 * El APP_SECRET se ensambla en tiempo de ejecución (igual que en el reproductor de
 * escritorio) para evitar su extracción trivial del APK descompilado. NUNCA debe
 * guardarse como string literal ni aparecer en logs.
 */
object AppSignature {

    /** Cabecera con el timestamp. */
    const val HEADER_TS = "x-cdp-ts"

    /** Cabecera con la firma. */
    const val HEADER_SIG = "x-cdp-sig"

    // APP_SECRET ensamblado por trozos (mismo valor que usa el reproductor PC).
    private fun appSecret(): String {
        val a = intArrayOf(103, 81, 100, 102, 113, 67, 54, 115) // gQdfqC6s
        val b = intArrayOf(122, 101, 84, 51, 76, 67, 68, 117)   // zeT3LCDu
        val c = intArrayOf(115, 77, 52, 106, 48, 120, 104, 49)  // sM4j0xh1
        val d = intArrayOf(88, 49, 77, 81, 98, 118, 56, 103)    // X1MQbv8g
        val e = intArrayOf(79, 99, 121, 76, 68, 48, 57, 80)     // OcyLD09P
        val f = intArrayOf(110, 70, 77)                         // nFM
        val sb = StringBuilder()
        for (arr in listOf(a, b, c, d, e, f)) {
            for (n in arr) sb.append(n.toChar())
        }
        return sb.toString()
    }

    /**
     * Calcula la firma para el instante [ts].
     * El mensaje firmado es "resolve:" + ts (igual que la app de escritorio para
     * los endpoints de licencia; el servidor solo usa otro mensaje en /api/playback/t/).
     */
    fun sign(ts: Long): String = hmacHex("resolve:$ts")

    /**
     * Firma para canjear un short-token en GET /api/playback/t/:token.
     * El servidor espera el mensaje "<token>:<ts>" (distinto a "resolve:<ts>").
     */
    fun signRedeem(token: String, ts: Long): String = hmacHex("$token:$ts")

    /** HMAC-SHA256(APP_SECRET, message) en hexadecimal. */
    private fun hmacHex(message: String): String {
        return try {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(appSecret().toByteArray(Charsets.UTF_8), "HmacSHA256"))
            val bytes = mac.doFinal(message.toByteArray(Charsets.UTF_8))
            bytes.joinToString("") { "%02x".format(it) }
        } catch (_: Exception) {
            ""
        }
    }

    /** Devuelve [timestamp, firma] listos para usar como cabeceras (mensaje "resolve:<ts>"). */
    fun headers(): Pair<Long, String> {
        val ts = System.currentTimeMillis()
        return ts to sign(ts)
    }

    /** Devuelve [timestamp, firma] para el canje de short-token (mensaje "<token>:<ts>"). */
    fun redeemHeaders(token: String): Pair<Long, String> {
        val ts = System.currentTimeMillis()
        return ts to signRedeem(token, ts)
    }
}
