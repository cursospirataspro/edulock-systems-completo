package com.edulock.player.ui

/** The caller supplies Firebase only after the user presses the recovery button. */
internal object PasswordRecovery {
    const val CONFIRMATION = "Si existe una cuenta con ese correo y permite recuperar la contraseña, recibirás instrucciones. Revisa también la carpeta de spam."

    fun normalizedEmail(raw: String): String? {
        val email = raw.trim()
        return email.takeIf { it.length <= 254 && Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$").matches(it) }
    }

    suspend fun request(rawEmail: String, sender: suspend (String) -> Unit): String {
        val email = normalizedEmail(rawEmail) ?: throw IllegalArgumentException("Ingresa un correo electrónico válido.")
        sender(email)
        return CONFIRMATION
    }
}
