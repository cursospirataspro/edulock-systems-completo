package com.edulock.player.ui

import com.edulock.player.api.data.ResourceItem
import com.edulock.player.api.data.ResourceViewResponse
import com.edulock.player.api.data.ResourceWatermark
import org.junit.Assert.*
import org.junit.Test

class ResourcePolicyTest {
    private val id = "34831ae4-3b98-4b4e-9b8d-ab546ee9c03c"
    private fun response() = ResourceViewResponse(ResourceItem(id = id, name = "Documento", protection = "protected", pageCount = 10, version = 3), ResourceWatermark("student@example.invalid", "EDU-SYNTHETIC"), 30)
    @Test fun validCdpResourceAndEncodedUuidUseOnlyTheExpectedCommand() {
        assertEquals(id, ResourcePolicy.deepLinkId("cdp://resource?id=$id"))
        assertEquals(id, ResourcePolicy.deepLinkId("CDP://RESOURCE?id=${id.uppercase()}"))
        for (raw in listOf("cdp://play?id=$id", "https://resource?id=$id", "cdp://resource/path?id=$id", "cdp://user@resource?id=$id", "cdp://resource:80?id=$id", "cdp://resource?id=$id&id=$id", "cdp://resource?id=../file", "cdp://resource?id=", "cdp://resource")) assertNull(raw, ResourcePolicy.deepLinkId(raw))
    }
    @Test fun publicLinksAllowDownloadableHttpHttpsWithoutCredentials() {
        assertEquals("https://example.invalid/free.pdf", ResourcePolicy.publicUrl("https://example.invalid/free.pdf"))
        assertEquals("http://example.invalid/file.zip", ResourcePolicy.publicUrl("http://example.invalid/file.zip"))
        for (raw in listOf("javascript:alert(1)", "data:application/pdf;base64,AAAA", "file:///sdcard/a.pdf", "content://file", "cdp://resource?id=$id", "//example.invalid/a", "https://user:pass@example.invalid/a", "https://example.invalid/a b")) assertNull(raw, ResourcePolicy.publicUrl(raw))
    }
    @Test fun relativeDownloadIsBoundToConfiguredApiAndCannotNavigateToArbitraryPaths() {
        assertEquals("https://api.example.invalid/resources/$id/download", ResourcePolicy.publicUrl("/resources/$id/download", "https://api.example.invalid/"))
        for (path in listOf("/admin", "/resources/$id/../admin", "/resources/$id/download?token=secret", "/resources/not-a-uuid/download", "//evil.invalid/resources/$id/download")) assertNull(path, ResourcePolicy.publicUrl(path, "https://api.example.invalid/"))
        assertNull(ResourcePolicy.publicUrl("/resources/$id/download", "file:///tmp/"))
        assertNull(ResourcePolicy.publicUrl("/resources/$id/download", "https://user:secret@api.example.invalid/"))
    }
    @Test fun validProtectedAuthorizationRequiresExactResourceAndCompleteMetadata() {
        assertTrue(ResourcePolicy.validProtectedView(id, response()))
        assertFalse(ResourcePolicy.validProtectedView(id, null))
        assertFalse(ResourcePolicy.validProtectedView(id, response().copy(resource = null)))
        for (resource in listOf(response().resource!!.copy(id = "another"), response().resource!!.copy(protection = "public"), response().resource!!.copy(protection = null), response().resource!!.copy(pageCount = null), response().resource!!.copy(pageCount = 0), response().resource!!.copy(pageCount = 201), response().resource!!.copy(version = null), response().resource!!.copy(version = 0))) assertFalse(ResourcePolicy.validProtectedView(id, response().copy(resource = resource)))
    }
    @Test fun protectedAuthorizationCannotExposeAnOriginalUrlOrOmitTheWatermark() {
        assertFalse(ResourcePolicy.validProtectedView(id, response().copy(url = "https://example.invalid/raw.pdf")))
        assertFalse(ResourcePolicy.validProtectedView(id, response().copy(resource = response().resource!!.copy(url = "https://example.invalid/raw.pdf"))))
        for (watermark in listOf(null, ResourceWatermark("", "code"), ResourceWatermark("student@example.invalid", ""))) assertFalse(ResourcePolicy.validProtectedView(id, response().copy(watermark = watermark)))
    }
    @Test fun authorizationCannotExtendTheLeaseBeyondThirtySeconds() {
        for (seconds in listOf(null, 0, -1, 31, Int.MAX_VALUE)) assertFalse(ResourcePolicy.validProtectedView(id, response().copy(leaseSeconds = seconds)))
        assertTrue(ResourcePolicy.validProtectedView(id, response().copy(leaseSeconds = 1)))
    }
    @Test fun pageDecodeRejectsOversizedDimensionsAndMemoryExpansion() {
        assertTrue(ResourcePolicy.validPngSize(1800, 1800))
        assertTrue(ResourcePolicy.validPngSize(1000, 8000))
        for ((width, height) in listOf(0 to 1800, -1 to 100, 8193 to 1, 4000 to 4000, Int.MAX_VALUE to Int.MAX_VALUE)) assertFalse(ResourcePolicy.validPngSize(width, height))
    }
    @Test fun initialLeaseDoesNotPermitAnyFrame() {
        val lease = ResourceLease(); assertFalse(lease.valid(0)); assertFalse(lease.permits(0, 1, 1, 0))
    }
    @Test fun leaseDeadlineStartsBeforeNetworkDelayAndExpiresAtTheExactBoundary() {
        val lease = ResourceLease(); assertTrue(lease.accept(1000, 6000, 3, 10, 30))
        assertTrue(lease.valid(30_999)); assertFalse(lease.valid(31_000))
        assertTrue(lease.permits(lease.generation, 3, 1, 30_999)); assertFalse(lease.permits(lease.generation, 3, 1, 31_000))
    }
    @Test fun slowOrInvalidAuthorizationsNeverGrantANewLease() {
        for ((start, now, version, pages, seconds) in listOf(listOf(1000, 31000, 3, 10, 30), listOf(1000, 999, 3, 10, 30), listOf(-1, 0, 3, 10, 30), listOf(0, 1, 0, 10, 30), listOf(0, 1, 3, 201, 30), listOf(0, 1, 3, 10, 31))) {
            val lease = ResourceLease(); assertFalse(lease.accept(start.toLong(), now.toLong(), version, pages, seconds)); assertFalse(lease.valid(now.toLong()))
        }
    }
    @Test fun successfulHeartbeatExtendsOnlyAnUnchangedResourceVersionAndPageCount() {
        val lease = ResourceLease(); assertTrue(lease.accept(0, 100, 3, 10, 30)); val ticket = lease.generation
        assertTrue(lease.accept(15000, 15500, 3, 10, 30)); assertTrue(lease.permits(ticket, 3, 5, 44000))
        assertFalse(lease.accept(30000, 31000, 4, 10, 30)); assertFalse(lease.accept(30000, 31000, 3, 11, 30))
    }
    @Test fun backgroundLogoutAndFailureInvalidateAllExistingPageCallbacks() {
        val lease = ResourceLease(); assertTrue(lease.accept(0, 100, 3, 10, 30)); val ticket = lease.generation
        lease.invalidate(); assertFalse(lease.valid(200)); assertFalse(lease.permits(ticket, 3, 1, 200))
        assertTrue(lease.accept(300, 400, 3, 10, 30)); assertFalse(lease.permits(ticket, 3, 1, 500)); assertTrue(lease.permits(lease.generation, 3, 1, 500))
    }
    @Test fun staleVersionOrOutOfRangePageNeverRendersUnderAValidLease() {
        val lease = ResourceLease(); assertTrue(lease.accept(0, 100, 3, 10, 30))
        assertFalse(lease.permits(lease.generation, 2, 1, 200)); assertFalse(lease.permits(lease.generation, 3, 0, 200)); assertFalse(lease.permits(lease.generation, 3, 11, 200))
    }
    @Test fun lateHeartbeatCannotReviveAnAlreadyExpiredLease() {
        val lease = ResourceLease(); assertTrue(lease.accept(0, 100, 3, 10, 30))
        assertFalse(lease.accept(15000, 30000, 3, 10, 30)); assertFalse(lease.valid(30000))
        lease.invalidate(); assertTrue(lease.accept(31000, 31200, 3, 10, 30))
    }
    @Test fun aFrameNeedsPngBytesAndTheExactAuthorizedVersion() {
        val bytes = ByteArray(24)
        byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a).copyInto(bytes)
        assertTrue(ResourcePolicy.validFrame("image/png", "3", 3, bytes))
        assertTrue(ResourcePolicy.validFrame("image/png; charset=binary", "3", 3, bytes))
        for (version in listOf(null, "", "2", "03", "3 ", "3\n")) assertFalse(ResourcePolicy.validFrame("image/png", version, 3, bytes))
        for (mime in listOf(null, "text/html", "application/pdf", "application/octet-stream")) assertFalse(ResourcePolicy.validFrame(mime, "3", 3, bytes))
        assertFalse(ResourcePolicy.validFrame("image/png", "3", 3, "%PDF-1.7 original PDF bytes".toByteArray()))
        assertFalse(ResourcePolicy.validFrame("image/png", "3", 3, bytes.copyOf(8)))
        assertFalse(ResourcePolicy.validFrame("image/png", "3", 3, bytes.copyOf(ResourcePolicy.MAX_FRAME_BYTES + 1)))
    }
}
