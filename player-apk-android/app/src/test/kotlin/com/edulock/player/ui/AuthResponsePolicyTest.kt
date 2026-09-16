package com.edulock.player.ui

import com.edulock.player.api.data.LoginResponse
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthResponsePolicyTest {
    @Test fun approvedSessionRequiresSuccessfulHttpAndNonemptyToken() {
        val approved = LoginResponse(status = "approved", role = "admin", token = "synthetic-session")
        assertTrue(AuthResponsePolicy.canStartSession(200, approved))
        for (http in listOf(0, 199, 300, 400, 401, 403, 404, 409, 429, 500, 503)) {
            assertFalse("HTTP $http must never save a token", AuthResponsePolicy.canStartSession(http, approved))
        }
        for (token in listOf(null, "", " ", "\n")) {
            assertFalse(AuthResponsePolicy.canStartSession(200, approved.copy(token = token)))
        }
        assertFalse(AuthResponsePolicy.canStartSession(200, null))
    }

    @Test fun aTokenCannotOverrideSuspensionPendingRejectionOrAnUnknownStatus() {
        for (status in listOf(null, "", "pending", "suspended", "rejected", "not_registered", "account_sync_required", "error")) {
            assertFalse(status, AuthResponsePolicy.canStartSession(200, LoginResponse(status = status, token = "synthetic-session")))
        }
    }

    @Test fun accountAbsenceRequiresTheCompleteAuthoritativeContract() {
        val absent = LoginResponse(status = "not_registered", code = "ACCOUNT_NOT_REGISTERED", registrationAllowed = true)
        assertTrue(AuthResponsePolicy.canRegisterAutomatically(200, absent))
        for (response in listOf(null, absent.copy(status = null), absent.copy(code = null),
            absent.copy(registrationAllowed = null), absent.copy(registrationAllowed = false),
            absent.copy(code = "ACCOUNT_LOOKUP_UNAVAILABLE"), absent.copy(status = "account_sync_required"),
            absent.copy(status = "registration_required"))) {
            assertFalse(AuthResponsePolicy.canRegisterAutomatically(200, response))
        }
    }

    @Test fun aFailedHttpResponseCannotProveAbsenceEvenWithAnAbsencePayload() {
        val absent = LoginResponse(status = "not_registered", code = "ACCOUNT_NOT_REGISTERED", registrationAllowed = true)
        for (http in listOf(0, 199, 300, 400, 401, 403, 404, 409, 429, 500, 503)) {
            assertFalse("HTTP $http", AuthResponsePolicy.canRegisterAutomatically(http, absent))
        }
    }

    @Test fun onlyAmbiguousCredentialAndMissingUserCodesRequestAnAuthoritativeLookup() {
        for (code in listOf("ERROR_USER_NOT_FOUND", "ERROR_INVALID_CREDENTIAL", "ERROR_INVALID_LOGIN_CREDENTIALS")) {
            assertTrue(code, AuthResponsePolicy.mayCheckAccount(code))
        }
        for (code in listOf(null, "", "ERROR_WRONG_PASSWORD", "ERROR_NETWORK_REQUEST_FAILED", "ERROR_USER_DISABLED",
            "ERROR_TOO_MANY_REQUESTS", "ERROR_INVALID_EMAIL", "no user record", "password is invalid")) {
            assertFalse(code, AuthResponsePolicy.mayCheckAccount(code))
        }
    }

    @Test fun existingFirebaseIdentityRequiresManualCompletionWithSuccessfulHttp() {
        val incomplete = LoginResponse(status = "registration_required", code = "REGISTRATION_REQUIRED")
        assertTrue(AuthResponsePolicy.needsManualRegistration(200, incomplete))
        assertFalse(AuthResponsePolicy.canRegisterAutomatically(200, incomplete))
        assertFalse(AuthResponsePolicy.needsManualRegistration(503, incomplete))
        assertFalse(AuthResponsePolicy.needsManualRegistration(401, incomplete))
        assertFalse(AuthResponsePolicy.needsManualRegistration(200, incomplete.copy(code = "ACCOUNT_SYNC_REQUIRED")))
        assertFalse(AuthResponsePolicy.needsManualRegistration(200, incomplete.copy(status = "suspended")))
    }

    @Test fun providerErrorsDoNotClaimThatAnAccountIsAbsent() {
        for (code in listOf("ERROR_USER_NOT_FOUND", "ERROR_INVALID_CREDENTIAL", "ERROR_INVALID_LOGIN_CREDENTIALS", "unexpected")) {
            val message = AuthResponsePolicy.firebaseErrorMessage(code)
            assertFalse(message.contains("no registrado", ignoreCase = true))
            assertFalse(message.contains("no existe", ignoreCase = true))
        }
        assertTrue(AuthResponsePolicy.firebaseErrorMessage("ERROR_USER_DISABLED").contains("deshabilitada"))
        assertTrue(AuthResponsePolicy.firebaseErrorMessage("ERROR_WRONG_PASSWORD").contains("incorrecta"))
    }
}
