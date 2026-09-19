package com.edulock.player.edu

import android.net.Uri
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.upstream.DataSource
import com.google.android.exoplayer2.upstream.DataSpec
import com.google.android.exoplayer2.upstream.TransferListener

/**
 * Fuente de datos de ExoPlayer que lee de un contenedor .edu ya abierto.
 *
 * ExoPlayer pide rangos del mp4 (cabecera, índice, y luego los trozos que va
 * reproduciendo) y cada petición se sirve descifrando solo los trozos que la
 * cubren. El mp4 completo no se reconstruye nunca: ni en memoria ni en disco,
 * ni siquiera temporalmente. Al buscar en la barra de tiempo, ExoPlayer vuelve
 * a abrir en otra posición y se descifra únicamente esa parte.
 */
class EduDataSource(private val abierto: EduContainer.Abierto) : DataSource {

    private var uri: Uri? = null
    private var posicion = 0L
    private var restantes = 0L
    private var abiertoParaLeer = false

    // Búfer de un trozo ya descifrado, para no repetir trabajo entre lecturas
    // consecutivas: ExoPlayer suele pedir el mp4 en tiradas pequeñas.
    private var cacheDesde = -1L
    private var cacheHasta = -1L
    private var cache: ByteArray? = null

    override fun addTransferListener(transferListener: TransferListener) { /* no aplica */ }

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        posicion = dataSpec.position
        if (posicion > abierto.largoOriginal) throw EduContainer.EduException("posición fuera del vídeo")
        restantes = if (dataSpec.length == C.LENGTH_UNSET.toLong()) {
            abierto.largoOriginal - posicion
        } else {
            minOf(dataSpec.length, abierto.largoOriginal - posicion)
        }
        abiertoParaLeer = true
        return restantes
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (!abiertoParaLeer) return C.RESULT_END_OF_INPUT
        if (length == 0) return 0
        if (restantes <= 0) return C.RESULT_END_OF_INPUT

        val pedidos = minOf(length.toLong(), restantes).toInt()
        val trozo = leerConCache(posicion, pedidos)
        System.arraycopy(trozo, 0, buffer, offset, trozo.size)
        posicion += trozo.size
        restantes -= trozo.size
        return trozo.size
    }

    /**
     * Sirve la petición desde el trozo descifrado que ya se tiene; si no encaja,
     * descifra el bloque alineado que la contiene y lo guarda.
     */
    private fun leerConCache(desde: Long, cuantos: Int): ByteArray {
        val guardado = cache
        if (guardado != null && desde >= cacheDesde && desde <= cacheHasta) {
            val dentro = (desde - cacheDesde).toInt()
            val disponibles = minOf(cuantos, guardado.size - dentro)
            return guardado.copyOfRange(dentro, dentro + disponibles)
        }

        // Se descifra siempre por trozos completos: es el trabajo mínimo posible.
        val tam = abierto.tamTrozo
        val inicioBloque = (desde / tam) * tam
        val finBloque = minOf(inicioBloque + tam.toLong() * BLOQUES_POR_LECTURA, abierto.largoOriginal) - 1
        val nuevo = EduContainer.leerRango(abierto, inicioBloque, finBloque)
        cache = nuevo
        cacheDesde = inicioBloque
        cacheHasta = inicioBloque + nuevo.size - 1

        val dentro = (desde - inicioBloque).toInt()
        val disponibles = minOf(cuantos, nuevo.size - dentro)
        return nuevo.copyOfRange(dentro, dentro + disponibles)
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        abiertoParaLeer = false
        cache = null
        cacheDesde = -1L
        cacheHasta = -1L
    }

    companion object {
        /** 8 KB por trozo × 32 = 256 KB por lectura: suficiente para no ir byte a byte. */
        private const val BLOQUES_POR_LECTURA = 32
    }
}

/**
 * Fábrica para MediaSource. Todas las fuentes comparten el mismo contenedor
 * abierto: la firma y el HMAC se comprueban una sola vez, al abrirlo.
 */
class EduDataSourceFactory(private val abierto: EduContainer.Abierto) : DataSource.Factory {
    override fun createDataSource(): DataSource = EduDataSource(abierto)
}
