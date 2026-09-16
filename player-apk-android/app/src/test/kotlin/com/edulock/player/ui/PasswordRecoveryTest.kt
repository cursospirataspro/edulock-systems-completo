package com.edulock.player.ui

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class PasswordRecoveryTest {
    @Test fun sendsOnlyTheValidatedEmailOnceThroughAnExplicitSender() = runBlocking {
        val recipients = mutableListOf<String>()
        val message = PasswordRecovery.request("  learner@example.invalid  ") { recipients.add(it) }
        assertEquals(listOf("learner@example.invalid"), recipients)
        assertEquals(PasswordRecovery.CONFIRMATION, message)
        assertTrue(message.startsWith("Si existe una cuenta"))
    }

    @Test fun invalidAddressesNeverReachTheSender() = runBlocking {
        var sent = 0
        for (email in listOf("", "  ", "missing-domain", "name@@example.invalid", "x y@example.invalid", "x@example", "x@e.invalid\nextra", "x".repeat(255) + "@e.invalid")) {
            try {
                PasswordRecovery.request(email) { sent++ }
                fail("Invalid email accepted")
            } catch (_: IllegalArgumentException) { }
        }
        assertEquals(0, sent)
    }

    @Test fun aNetworkFailureCannotReturnAConfirmationAndCanBeRetried() = runBlocking {
        val failure = IOException("synthetic network failure")
        var attempts = 0
        try {
            PasswordRecovery.request("learner@example.invalid") { attempts++; throw failure }
            fail("Network failure must remain a failure")
        } catch (error: IOException) { assertSame(failure, error) }
        val result = PasswordRecovery.request("learner@example.invalid") { attempts++ }
        assertEquals(2, attempts)
        assertEquals(PasswordRecovery.CONFIRMATION, result)
    }

    @Test fun lifecycleCancellationCannotBeReportedAsSuccess() = runBlocking {
        val cancellation = CancellationException("synthetic stop")
        try {
            PasswordRecovery.request("learner@example.invalid") { throw cancellation }
            fail("Cancelled recovery must not report success")
        } catch (error: CancellationException) { assertSame(cancellation, error) }
    }
}
