package com.edulock.player.edu

import android.content.Context
import android.util.Log
import com.edulock.player.api.ApiClient
import com.edulock.player.api.data.EduKeyRequest
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Prepara una clase .edu para reproducirse en el teléfono:
 *
 *   1. pide la clave de contenido al servidor (solo la da con licencia válida),
 *   2. descarga el contenedor cifrado al almacenamiento privado de la app,
 *   3. lo abre comprobando la firma del servidor y el HMAC.
 *
 * El archivo en disco es el .edu tal cual: cifrado de punta a punta. La clave
 * vive únicamente en memoria mientras dura la reproducción, así que si alguien
 * saca el archivo del teléfono se lleva ruido.
 */
object EduLoader {

    private const val TAG = "EduLoader"
    private const val CARPETA = "edu"

    class EduLoadException(mensaje: String, causa: Throwable? = null) : Exception(mensaje, causa)

    /** Lo que necesita el reproductor para pintar la clase. */
    class Preparado(
        val abierto: EduContainer.Abierto,
        val archivo: File,
        val marcaDeAgua: String,
        val titulo: String,
    )

    private fun carpeta(context: Context): File =
        File(context.filesDir, CARPETA).apply { mkdirs() }

    private fun archivoDe(context: Context, contentId: String): File {
        // El contentId viene del servidor, pero se limpia igualmente: nunca debe
        // poder construir una ruta fuera de la carpeta de la app.
        val seguro = contentId.replace(Regex("[^A-Za-z0-9._-]"), "_").take(80)
        if (seguro.isBlank()) throw EduLoadException("identificador de contenido inválido")
        return File(carpeta(context), "$seguro.edu")
    }

    /**
     * Deja la clase lista para reproducir. Se llama fuera del hilo principal:
     * descarga y comprobación de firma pueden tardar.
     */
    suspend fun preparar(
        context: Context,
        contentId: String,
        tokenReproduccion: String,
        onProgreso: (leidos: Long, total: Long) -> Unit = { _, _ -> },
    ): Preparado = withContext(Dispatchers.IO) {
        val api = ApiClient.getService()
        val cabecera = "Bearer $tokenReproduccion"

        // 1) Clave de contenido. Primero la clave: si el alumno no tiene acceso,
        //    no tiene sentido gastarle datos descargando el vídeo.
        val clave = try {
            api.getEduKey(EduKeyRequest(contentId), cabecera)
        } catch (e: Exception) {
            throw EduLoadException("No se pudo obtener la clave de esta clase. Comprueba tu licencia y tu conexión.", e)
        }
        val cekHex = clave.cek
        if (cekHex.isNullOrBlank()) {
            throw EduLoadException(clave.error ?: "El servidor no entregó la clave de esta clase.")
        }
        val cek = EduContainer.deHex(cekHex)

        // 2) Contenedor. Si ya está descargado y se abre bien, se reutiliza.
        val archivo = archivoDe(context, contentId)
        if (archivo.exists() && archivo.length() > 76) {
            try {
                val st = EduContainer.abrir(archivo, cek, EduKeys.PUBLIC_KEY)
                Log.i(TAG, "Contenedor ya descargado y verificado: ${archivo.length()} bytes")
                return@withContext Preparado(st, archivo, st.marcaDeAgua, st.titulo)
            } catch (e: Exception) {
                // Descarga a medias o clave cambiada: se vuelve a bajar.
                Log.w(TAG, "El .edu guardado no sirve (${e.message}); se descarga de nuevo")
                archivo.delete()
            }
        }

        descargar(contentId, cabecera, archivo, onProgreso)

        // 3) Abrir comprobando firma y HMAC.
        val st = try {
            EduContainer.abrir(archivo, cek, EduKeys.PUBLIC_KEY)
        } catch (e: Exception) {
            archivo.delete()
            throw EduLoadException(e.message ?: "El contenido protegido no se pudo verificar.", e)
        }
        Preparado(st, archivo, st.marcaDeAgua, st.titulo)
    }

    private suspend fun descargar(
        contentId: String,
        cabecera: String,
        destino: File,
        onProgreso: (Long, Long) -> Unit,
    ) {
        val respuesta = try {
            ApiClient.getService().downloadEdu(contentId, cabecera)
        } catch (e: Exception) {
            throw EduLoadException("No se pudo descargar la clase. Comprueba tu conexión.", e)
        }
        if (!respuesta.isSuccessful) {
            throw EduLoadException("El servidor rechazó la descarga (código ${respuesta.code()}).")
        }
        val cuerpo = respuesta.body() ?: throw EduLoadException("El servidor no envió el contenido.")

        // Se escribe a un archivo temporal y se renombra al final: así nunca queda
        // una descarga a medias con nombre de archivo bueno.
        val temporal = File(destino.parentFile, destino.name + ".parcial")
        try {
            val total = cuerpo.contentLength()
            var leidos = 0L
            cuerpo.byteStream().use { entrada ->
                temporal.outputStream().use { salida ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = entrada.read(buf)
                        if (n < 0) break
                        salida.write(buf, 0, n)
                        leidos += n
                        onProgreso(leidos, total)
                    }
                }
            }
            if (!temporal.renameTo(destino)) {
                throw EduLoadException("No se pudo guardar la clase descargada.")
            }
        } catch (e: EduLoadException) {
            temporal.delete(); throw e
        } catch (e: Exception) {
            temporal.delete()
            throw EduLoadException("La descarga se interrumpió. Vuelve a intentarlo.", e)
        }
    }

    /** Borra los contenedores descargados. Se llama al cerrar sesión. */
    fun limpiar(context: Context) {
        try { carpeta(context).listFiles()?.forEach { it.delete() } }
        catch (e: Exception) { Log.w(TAG, "No se pudo limpiar la caché .edu: ${e.message}") }
    }
}
