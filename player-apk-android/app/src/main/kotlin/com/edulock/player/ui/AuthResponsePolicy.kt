package com.edulock.player.ui

import com.edulock.player.api.data.LoginResponse

/** Decisions shared by sign-in and account lookup; no Android or network state. */
internal object AuthResponsePolicy {
    fun canStartSession(httpCode: Int, response: LoginResponse?): Boolean =
        httpCode in 200..299 && response?.status == "approved" && !response.token.isNullOrBlank()

    fun canRegisterAutomatically(httpCode: Int, response: LoginResponse?): Boolean =
        httpCode in 200..299 && response?.status == "not_registered" &&
            response.code == "ACCOUNT_NOT_REGISTERED" && response.registrationAllowed == true

    fun mayCheckAccount(firebaseErrorCode: String?): Boolean =
        firebaseErrorCode in setOf("ERROR_USER_NOT_FOUND", "ERROR_INVALID_CREDENTIAL", "ERROR_INVALID_LOGIN_CREDENTIALS")

    fun needsManualRegistration(httpCode: Int, response: LoginResponse?): Boolean =
        httpCode in 200..299 && response?.status == "registration_required" && response.code == "REGISTRATION_REQUIRED"

    fun firebaseErrorMessage(code: String?): String = when (code) {
        "ERROR_INVALID_EMAIL" -> "Correo electrónico inválido."
        "ERROR_WRONG_PASSWORD" -> "Contraseña incorrecta."
        "ERROR_USER_DISABLED" -> "Tu cuenta está deshabilitada. Contacta al administrador."
        "ERROR_TOO_MANY_REQUESTS" -> "Demasiados intentos. Espera un momento e intenta nuevamente."
        "ERROR_EMAIL_ALREADY_IN_USE" -> "Ese correo ya tiene una cuenta. Inicia sesión con tu contraseña."
        "ERROR_WEAK_PASSWORD" -> "La contraseña debe tener al menos 6 caracteres."
        "ERROR_ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL" -> "Usa el método con el que creaste tu cuenta."
        "ERROR_USER_NOT_FOUND", "ERROR_INVALID_CREDENTIAL", "ERROR_INVALID_LOGIN_CREDENTIALS" -> "Correo o contraseña incorrectos."
        else -> "No se pudo completar la autenticación. Intenta nuevamente."
    }
}
