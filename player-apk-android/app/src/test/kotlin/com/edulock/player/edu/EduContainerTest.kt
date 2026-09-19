package com.edulock.player.edu

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Comprueba que el lector de Android abre contenedores .edu producidos de verdad
 * por el servidor (edu-packer.js). Las muestras las genera
 * scripts/generar-muestra-edu.js; si el formato cambiara en un lado y no en el
 * otro, estas pruebas se caen.
 *
 * Es la única manera de asegurar que Kotlin y Node hablan el mismo formato: los
 * dos leen y escriben los mismos bytes, no una descripción del formato.
 */
class EduContainerTest {

    private fun recurso(nombre: String): File {
        val url = javaClass.classLoader!!.getResource(nombre)
            ?: throw IllegalStateException(
                "Falta $nombre. Genera las muestras con: node scripts/generar-muestra-edu.js")
        return File(url.toURI())
    }

    private val datos: JSONObject by lazy { JSONObject(recurso("muestra.json").readText()) }
    private val original: ByteArray by lazy { recurso("muestra-original.bin").readBytes() }
    private val clavePublica: String by lazy { datos.getString("publicKeyPem") }

    private fun cek(saltHex: String = datos.getString("salt")): ByteArray =
        EduContainer.derivarCek(
            datos.getString("masterKeyHex"),
            EduContainer.deHex(saltHex),
            datos.getString("contentId"),
        )

    @Test
    fun `abre un contenedor firmado por el servidor`() {
        EduContainer.abrir(recurso("muestra.edu"), cek(), clavePublica).use { st ->
            assertTrue("debería venir firmado", st.firmado)
            assertEquals(original.size.toLong(), st.largoOriginal)
            assertEquals(8192, st.tamTrozo)
            assertEquals("Clase de muestra", st.titulo)
        }
    }

    @Test
    fun `el video completo se recupera byte a byte`() {
        EduContainer.abrir(recurso("muestra.edu"), cek(), clavePublica).use { st ->
            val todo = EduContainer.leerRango(st, 0, st.largoOriginal - 1)
            assertArrayEquals(original, todo)
        }
    }

    @Test
    fun `los rangos sueltos coinciden con el original`() {
        EduContainer.abrir(recurso("muestra.edu"), cek(), clavePublica).use { st ->
            val n = original.size

            // Principio y final: donde el mp4 guarda sus índices.
            assertArrayEquals(original.copyOfRange(0, 4096), EduContainer.leerRango(st, 0, 4095))
            assertArrayEquals(
                original.copyOfRange(n - 4096, n),
                EduContainer.leerRango(st, (n - 4096).toLong(), (n - 1).toLong()))

            // Un rango que cruza el límite de un trozo de 8 KB.
            assertArrayEquals(
                original.copyOfRange(8182, 12289),
                EduContainer.leerRango(st, 8182, 12288))

            // El último trozo, que está incompleto.
            val inicioUltimo = (st.totalTrozos - 1).toLong() * st.tamTrozo
            assertArrayEquals(
                original.copyOfRange(inicioUltimo.toInt(), n),
                EduContainer.leerRango(st, inicioUltimo, (n - 1).toLong()))

            // Un byte suelto en medio.
            assertArrayEquals(
                original.copyOfRange(100_000, 100_001),
                EduContainer.leerRango(st, 100_000, 100_000))
        }
    }

    @Test
    fun `un rango que se pasa del final se recorta`() {
        EduContainer.abrir(recurso("muestra.edu"), cek(), clavePublica).use { st ->
            val trozo = EduContainer.leerRango(st, st.largoOriginal - 10, st.largoOriginal + 5000)
            assertEquals(10, trozo.size)
            assertEquals(0, EduContainer.leerRango(st, st.largoOriginal, st.largoOriginal + 10).size)
        }
    }

    @Test
    fun `el archivo en disco no contiene el video en claro`() {
        val contenedor = recurso("muestra.edu").readBytes()
        val muestra = original.copyOfRange(1000, 1064)
        var encontrado = false
        outer@ for (i in 0..contenedor.size - muestra.size) {
            for (j in muestra.indices) {
                if (contenedor[i + j] != muestra[j]) continue@outer
            }
            encontrado = true
            break
        }
        assertTrue("el .edu no debe llevar el vídeo en claro", !encontrado)
    }

    @Test
    fun `se rechaza un contenedor manipulado`() {
        val bytes = recurso("muestra.edu").readBytes()
        bytes[5000] = (bytes[5000].toInt() xor 0xff).toByte()
        try {
            EduContainer.abrir(bytes, cek(), clavePublica)
            fail("debería haber rechazado el contenedor alterado")
        } catch (e: EduContainer.EduException) {
            assertTrue(e.message!!, e.message!!.contains("firma"))
        }
    }

    @Test
    fun `se rechaza un contenedor sin firmar cuando se exige firma`() {
        try {
            EduContainer.abrir(
                recurso("muestra-sin-firma.edu"),
                cek(datos.getString("saltSinFirma")),
                clavePublica)
            fail("debería haber rechazado el contenedor sin firma")
        } catch (e: EduContainer.EduException) {
            assertTrue(e.message!!, e.message!!.contains("no está firmado"))
        }
    }

    @Test
    fun `la clave de otro contenido no abre este`() {
        val otra = EduContainer.derivarCek(
            datos.getString("masterKeyHex"),
            EduContainer.deHex(datos.getString("salt")),
            "otro-contenido")
        try {
            EduContainer.abrir(recurso("muestra.edu"), otra, clavePublica)
            fail("debería haber rechazado la clave ajena")
        } catch (e: EduContainer.EduException) {
            assertTrue(e.message!!, e.message!!.contains("HMAC"))
        }
    }

    @Test
    fun `el HKDF da el mismo resultado que el del servidor`() {
        // Si esto difiere, todo lo demás falla de formas difíciles de leer.
        val esperado = datos.getString("salt")
        val a = cek()
        val b = EduContainer.derivarCek(
            datos.getString("masterKeyHex"), EduContainer.deHex(esperado), datos.getString("contentId"))
        assertArrayEquals(a, b)
        assertEquals(32, a.size)
        assertNotEquals(0, a.count { it.toInt() != 0 })
    }
}
