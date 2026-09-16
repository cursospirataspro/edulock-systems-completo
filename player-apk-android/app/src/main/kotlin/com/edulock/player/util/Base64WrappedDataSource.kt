package com.edulock.player.util

import android.net.Uri
import android.util.Base64
import android.util.Log
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.upstream.DataSource
import com.google.android.exoplayer2.upstream.DataSpec
import com.google.android.exoplayer2.upstream.HttpDataSource
import com.google.android.exoplayer2.upstream.TransferListener
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * DataSource que intercepta respuestas JSON con formato {"d":"<base64>"} del servidor
 * y las decodifica transparentemente para que ExoPlayer reciba el contenido real (HLS M3U8 o segmentos TS).
 */
class Base64WrappedDataSource(private val upstream: HttpDataSource) : DataSource {

    companion object {
        private const val TAG = "Base64WrappedDS"
    }

    private var decodedBytes: ByteArray? = null
    private var readPosition = 0
    private var uri: Uri? = null

    override fun addTransferListener(transferListener: TransferListener) {
        upstream.addTransferListener(transferListener)
    }

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        decodedBytes = null
        readPosition = 0

        upstream.open(dataSpec)

        // Leer todo el contenido de la respuesta
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        var bytesRead: Int
        while (upstream.read(chunk, 0, chunk.size).also { bytesRead = it } != C.RESULT_END_OF_INPUT) {
            if (bytesRead > 0) buffer.write(chunk, 0, bytesRead)
        }
        upstream.close()

        val raw = buffer.toByteArray()
        val rawStr = raw.toString(Charsets.UTF_8).trim()

        // Detectar respuesta JSON wrapeada {"d":"<base64>"}
        decodedBytes = if (rawStr.startsWith("{") && rawStr.contains("\"d\"")) {
            try {
                val json = JSONObject(rawStr)
                val b64 = json.getString("d")
                val decoded = Base64.decode(b64, Base64.DEFAULT)
                Log.d(TAG, "Decodificado base64: ${decoded.size} bytes, empieza con: ${decoded.take(10).map { it.toInt().and(0xFF).toChar() }.joinToString("")}")
                decoded
            } catch (e: Exception) {
                Log.w(TAG, "JSON parse falló, usando raw: ${e.message}")
                raw
            }
        } else {
            raw
        }

        return decodedBytes!!.size.toLong()
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val bytes = decodedBytes ?: return C.RESULT_END_OF_INPUT
        if (readPosition >= bytes.size) return C.RESULT_END_OF_INPUT
        val toRead = minOf(length, bytes.size - readPosition)
        System.arraycopy(bytes, readPosition, buffer, offset, toRead)
        readPosition += toRead
        return toRead
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        try { upstream.close() } catch (_: Exception) {}
        decodedBytes = null
        readPosition = 0
    }
}

class Base64WrappedDataSourceFactory(private val upstream: HttpDataSource.Factory) : DataSource.Factory {
    override fun createDataSource(): DataSource = Base64WrappedDataSource(upstream.createDataSource())
}
