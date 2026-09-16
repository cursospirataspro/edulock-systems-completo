package com.edulock.player.ui

import com.edulock.player.api.data.ResourceViewResponse
import java.net.URI
import java.net.URLDecoder

/** Pure decisions: unknown modes, stale callbacks and expired leases never display a frame. */
internal object ResourcePolicy {
    const val MAX_FRAME_BYTES = 12 * 1024 * 1024
    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}")
    fun validId(id: String?): Boolean = id != null && uuid.matches(id)
    fun publicUrl(raw: String?, apiBase: String? = null): String? = try {
        val resolved = if (raw != null && Regex("/resources/[0-9a-fA-F-]{36}/download").matches(raw) && validId(raw.split('/')[2])) {
            val base = URI(apiBase ?: "")
            if (base.scheme !in setOf("http", "https") || base.host.isNullOrBlank() || base.userInfo != null) null else base.resolve(raw).toString()
        } else raw
        val uri = URI(resolved ?: "")
        resolved?.takeIf { it.length <= 4096 && uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank() && uri.userInfo == null && it.none { c -> c.code <= 32 || c.code == 127 } }
    } catch (_: Exception) { null }
    fun deepLinkId(raw: String?): String? = try {
        val uri = URI(raw ?: "")
        if (!uri.scheme.equals("cdp", true) || !uri.host.equals("resource", true) || !uri.path.isNullOrEmpty() || uri.userInfo != null || uri.port != -1) null
        else {
            val ids = (uri.rawQuery ?: "").split('&').map { it.split('=', limit = 2) }.filter { it[0] == "id" }
            if (ids.size != 1 || ids[0].size != 2) null else URLDecoder.decode(ids[0][1], "UTF-8").takeIf(::validId)?.lowercase()
        }
    } catch (_: Exception) { null }
    fun validProtectedView(id: String, response: ResourceViewResponse?): Boolean {
        val resource = response?.resource ?: return false
        return resource.id.equals(id, true) && resource.protection == "protected" && resource.version != null && resource.version >= 1 &&
            resource.pageCount in 1..200 && response.leaseSeconds in 1..30 &&
            !response.watermark?.email.isNullOrBlank() && !response.watermark?.code.isNullOrBlank() &&
            resource.url.isNullOrBlank() && response.url.isNullOrBlank()
    }
    fun validPngSize(width: Int, height: Int): Boolean = width in 1..8192 && height in 1..8192 && width.toLong() * height <= 8_000_000
    fun validFrame(contentType: String?, headerVersion: String?, expectedVersion: Int, bytes: ByteArray): Boolean {
        val signature = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        return expectedVersion >= 1 && contentType?.substringBefore(';')?.trim() == "image/png" && headerVersion == expectedVersion.toString() &&
            bytes.size in 24..MAX_FRAME_BYTES && signature.indices.all { bytes[it] == signature[it] }
    }
}

internal class ResourceLease {
    var generation = 0L; private set
    var version: Int? = null; private set
    var pageCount: Int? = null; private set
    private var deadline = 0L
    fun invalidate() { generation++; version = null; pageCount = null; deadline = 0 }
    fun accept(startedAt: Long, now: Long, nextVersion: Int, pages: Int, seconds: Int): Boolean {
        if (nextVersion < 1 || pages !in 1..200 || seconds !in 1..30 || startedAt < 0 || now < startedAt || now - startedAt >= seconds * 1000L) return false
        if (version != null && (now >= deadline || version != nextVersion || pageCount != pages)) return false
        version = nextVersion; pageCount = pages; deadline = startedAt + seconds * 1000L
        return true
    }
    fun valid(now: Long): Boolean = version != null && now >= 0 && now < deadline
    fun permits(ticket: Long, expectedVersion: Int, page: Int, now: Long): Boolean =
        ticket == generation && version == expectedVersion && page in 1..(pageCount ?: 0) && valid(now)
}
