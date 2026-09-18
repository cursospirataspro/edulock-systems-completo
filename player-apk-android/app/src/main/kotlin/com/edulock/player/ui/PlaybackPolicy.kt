package com.edulock.player.ui

/**
 * Decide cómo reproducir a partir de la respuesta del servidor, con las mismas
 * reglas para un enlace y para el catálogo. No toca Android ni la red: solo
 * traduce una respuesta en un plan de reproducción, de modo que las dos
 * pantallas no puedan divergir (F08).
 *
 * Regla central de credenciales (F01): el manifiesto, sus variantes, las claves
 * y los segmentos se piden SIEMPRE con el token de reproducción, que está atado
 * a este video y a esta sesión. El JWT de la cuenta no sirve para media —el
 * servidor lo rechaza con SESSION_REQUIRED— así que aquí nunca se usa como
 * sustituto: si falta el token de reproducción, el plan queda incompleto y se
 * dice con claridad en lugar de intentar una petición que va a fallar.
 */
internal object PlaybackPolicy {

    /** Respuesta de reproducción normalizada, venga del enlace o del catálogo. */
    data class Source(
        val sourceType: String? = null,
        val manifestUrl: String? = null,
        val directUrl: String? = null,
        val otp: String? = null,
        val playbackInfo: String? = null,
        val mediaToken: String? = null,
        val sessionToken: String? = null,
        val drmScheme: String? = null,
        val drmLicenseUrl: String? = null,
        val error: String? = null
    )

    sealed class Plan {
        /** HLS del servicio de video, autenticado con el token de reproducción. */
        data class Hls(
            val manifestUrl: String,
            val mediaToken: String,
            val drmScheme: String?,
            val drmLicenseUrl: String?
        ) : Plan()

        data class VdoOtp(val otp: String, val playbackInfo: String, val mediaToken: String) : Plan()
        data class VdoDirect(val directUrl: String, val mediaToken: String) : Plan()

        /** El formato existe pero esta plataforma no lo reproduce aquí. */
        data class Unsupported(val message: String) : Plan()

        /** Faltan datos o credenciales para reproducir. */
        data class Incomplete(val message: String) : Plan()

        /** El servidor negó la reproducción y explicó por qué. */
        data class Rejected(val message: String) : Plan()
    }

    /**
     * Token con el que se autentica el contenido. Los enlaces temporales
     * devuelven `mediaToken`; los permanentes devuelven `sessionToken`, que
     * también está atado al video. Cualquiera de los dos sirve; el JWT de la
     * cuenta, no.
     */
    fun mediaCredential(source: Source): String? =
        source.mediaToken?.takeIf { it.isNotBlank() } ?: source.sessionToken?.takeIf { it.isNotBlank() }

    fun plan(source: Source): Plan {
        val credential = mediaCredential(source)
        val tipo = source.sourceType?.trim()?.lowercase()

        if (tipo == "edu") {
            return Plan.Unsupported("Este video .edu requiere Edulock para escritorio. Android admite Bunny Stream/HLS y VdoCipher.")
        }

        return when (tipo) {
            "vdocipher" -> {
                if (source.otp.isNullOrBlank() || source.playbackInfo.isNullOrBlank()) {
                    Plan.Incomplete("Credenciales de video no disponibles.")
                } else {
                    Plan.VdoOtp(source.otp, source.playbackInfo, credential.orEmpty())
                }
            }
            "vdocipher_direct" -> {
                if (source.directUrl.isNullOrBlank()) Plan.Incomplete("URL de video no disponible.")
                else Plan.VdoDirect(source.directUrl, credential.orEmpty())
            }
            else -> {
                if (source.manifestUrl.isNullOrBlank()) {
                    val motivo = source.error?.takeIf { it.isNotBlank() }
                    if (motivo != null) Plan.Rejected(motivo)
                    else Plan.Incomplete("El servidor no devolvió la URL del video.")
                } else if (credential.isNullOrBlank()) {
                    // Sin token de reproducción no se puede pedir el manifiesto: el
                    // servidor exige un token atado a este video y a esta sesión.
                    Plan.Incomplete("La sesión de reproducción no está disponible. Vuelve a abrir la clase.")
                } else {
                    Plan.Hls(source.manifestUrl, credential, source.drmScheme, source.drmLicenseUrl)
                }
            }
        }
    }
}
