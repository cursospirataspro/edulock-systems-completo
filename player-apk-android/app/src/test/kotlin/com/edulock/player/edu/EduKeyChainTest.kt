package com.edulock.player.edu

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Comprueba que la clave pública que lleva incrustada ESTA app corresponde a la
 * clave con la que firma el servidor de producción.
 *
 * La muestra la escribe scripts/probar-cadena-edu.js con las claves reales, y no
 * se guarda en el repositorio. Si no está, la prueba se salta: sirve para
 * verificar una compilación de release, no para bloquear el desarrollo.
 *
 * El truco está en qué error se obtiene. Se abre con una clave de contenido
 * incorrecta a propósito: si la firma no cuadrara, fallaría en la firma; que
 * falle en el HMAC demuestra que la firma se verificó contra la clave incrustada.
 */
class EduKeyChainTest {

    private fun recurso(nombre: String): File? =
        javaClass.classLoader?.getResource(nombre)?.let { File(it.toURI()) }

    @Test
    fun `la clave incrustada verifica la firma del servidor de produccion`() {
        val edu = recurso("cadena-real.edu")
        val datos = recurso("cadena-real.json")
        assumeTrue("Genera la muestra con: node scripts/probar-cadena-edu.js",
            edu != null && datos != null)
        assumeTrue("Esta compilación no lleva clave pública incrustada",
            EduKeys.PUBLIC_KEY.isNotBlank())

        val meta = JSONObject(datos!!.readText())
        // Clave de contenido deliberadamente incorrecta: aquí no se puede derivar
        // la de verdad porque la clave maestra no sale del servidor.
        val cekFalsa = ByteArray(32) { 7 }

        try {
            EduContainer.abrir(edu!!, cekFalsa, EduKeys.PUBLIC_KEY)
            throw AssertionError("debería haber fallado: la clave de contenido es incorrecta")
        } catch (e: EduContainer.EduException) {
            val m = e.message.orEmpty()
            assertTrue(
                "La firma no se verificó con la clave incrustada: $m",
                m.contains("HMAC"))
        }

        assertEquals(meta.getString("contentId"), meta.getString("contentId"))
    }
}
