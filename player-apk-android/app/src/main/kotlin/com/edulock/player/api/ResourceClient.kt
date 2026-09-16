package com.edulock.player.api

import com.edulock.player.api.data.ResourceViewResponse
import com.google.gson.Gson
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Only the configured API receives the bearer token. No redirects or disk cache. */
internal object ResourceClient {
    private val http = OkHttpClient.Builder().cache(null).followRedirects(false).followSslRedirects(false)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS).build()
    private val gson = Gson()
    private suspend fun request(path: String, jwt: String, deviceId: String, maxBytes: Int): Payload {
        require(jwt.isNotBlank() && deviceId.isNotBlank()) { "Inicia sesión para abrir este recurso." }
        val call = http.newCall(Request.Builder().url(ApiClient.getBaseUrl().trimEnd('/') + path)
            .header("Authorization", "Bearer $jwt").header("X-Device-ID", deviceId)
            .header("Cache-Control", "no-store").build())
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { if (continuation.isActive) continuation.resumeWithException(e) }
                override fun onResponse(call: Call, response: Response) {
                    try {
                        val result = response.use { value ->
                            if (!value.isSuccessful) throw IOException(when (value.code) {
                                401 -> "La sesión terminó. Inicia sesión nuevamente."
                                403 -> "Tu cuenta, dispositivo o licencia no tiene permiso para este recurso."
                                404 -> "Este recurso ya no está disponible."
                                409 -> "El recurso cambió. Ciérralo y vuelve a abrirlo."
                                else -> "No se pudo comprobar el acceso al recurso (HTTP ${value.code})."
                            })
                            val body = value.body ?: throw IOException("El servidor devolvió una respuesta vacía.")
                            if (body.contentLength() > maxBytes) throw IOException("La página supera el tamaño permitido.")
                            val output = ByteArrayOutputStream()
                            body.byteStream().use { input ->
                                val buffer = ByteArray(8192)
                                while (true) {
                                    if (!continuation.isActive) throw IOException("Solicitud cancelada.")
                                    val count = input.read(buffer); if (count < 0) break
                                    if (output.size() + count > maxBytes) throw IOException("La página supera el tamaño permitido.")
                                    output.write(buffer, 0, count)
                                }
                                buffer.fill(0)
                            }
                            Payload(output.toByteArray(), value.header("Content-Type"), value.header("X-Resource-Version"))
                        }
                        if (continuation.isActive) continuation.resume(result) else result.bytes.fill(0)
                    } catch (error: Exception) { if (continuation.isActive) continuation.resumeWithException(error) }
                }
            })
        }
    }
    suspend fun view(id: String, jwt: String, deviceId: String): ResourceViewResponse {
        require(com.edulock.player.ui.ResourcePolicy.validId(id))
        val payload = request("/api/resources/$id/view", jwt, deviceId, 256 * 1024)
        try {
            if (payload.mime?.substringBefore(';')?.trim() != "application/json") throw IOException("Respuesta de acceso no válida.")
            return gson.fromJson(String(payload.bytes, Charsets.UTF_8), ResourceViewResponse::class.java) ?: throw IOException("Respuesta de acceso vacía.")
        } finally { payload.bytes.fill(0) }
    }
    suspend fun page(id: String, page: Int, version: Int, jwt: String, deviceId: String): ByteArray {
        require(com.edulock.player.ui.ResourcePolicy.validId(id) && page in 1..200 && version >= 1)
        val payload = request("/api/resources/$id/pages/$page?version=$version", jwt, deviceId, com.edulock.player.ui.ResourcePolicy.MAX_FRAME_BYTES)
        if (!com.edulock.player.ui.ResourcePolicy.validFrame(payload.mime, payload.version, version, payload.bytes)) {
            payload.bytes.fill(0); throw IOException("La página recibida no coincide con la versión autorizada.")
        }
        return payload.bytes
    }
    private data class Payload(val bytes: ByteArray, val mime: String?, val version: String?)
}
