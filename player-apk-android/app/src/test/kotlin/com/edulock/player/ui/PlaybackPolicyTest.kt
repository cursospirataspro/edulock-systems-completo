package com.edulock.player.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * F01 y F08: la respuesta de reproducción se interpreta igual venga del enlace o
 * del catálogo, y el contenido se pide siempre con el token de reproducción.
 */
class PlaybackPolicyTest {

    @Test
    fun `el manifiesto se autentica con el token de reproduccion, nunca con el de la cuenta`() {
        val plan = PlaybackPolicy.plan(
            PlaybackPolicy.Source(
                sourceType = "bunny",
                manifestUrl = "https://edulock.test/api/r/abc",
                mediaToken = "token-de-reproduccion"
            )
        )
        assertTrue(plan is PlaybackPolicy.Plan.Hls)
        assertEquals("token-de-reproduccion", (plan as PlaybackPolicy.Plan.Hls).mediaToken)
    }

    @Test
    fun `un enlace permanente usa su token de sesion, que tambien esta atado al video`() {
        val plan = PlaybackPolicy.plan(
            PlaybackPolicy.Source(
                sourceType = "bunny",
                manifestUrl = "https://edulock.test/api/r/abc",
                sessionToken = "token-de-enlace-permanente"
            )
        )
        assertEquals("token-de-enlace-permanente", (plan as PlaybackPolicy.Plan.Hls).mediaToken)
    }

    @Test
    fun `sin token de reproduccion no se intenta pedir el manifiesto`() {
        val plan = PlaybackPolicy.plan(
            PlaybackPolicy.Source(sourceType = "bunny", manifestUrl = "https://edulock.test/api/r/abc")
        )
        assertTrue("debe quedar incompleto en vez de usar el JWT de la cuenta", plan is PlaybackPolicy.Plan.Incomplete)
    }

    @Test
    fun `el catalogo reproduce vdocipher_direct igual que el enlace`() {
        val plan = PlaybackPolicy.plan(
            PlaybackPolicy.Source(
                sourceType = "vdocipher_direct",
                directUrl = "https://proveedor.test/v/1",
                mediaToken = "token-de-reproduccion"
            )
        )
        assertTrue(plan is PlaybackPolicy.Plan.VdoDirect)
        assertEquals("https://proveedor.test/v/1", (plan as PlaybackPolicy.Plan.VdoDirect).directUrl)
    }

    @Test
    fun `vdocipher_direct sin direccion se informa como datos incompletos`() {
        val plan = PlaybackPolicy.plan(PlaybackPolicy.Source(sourceType = "vdocipher_direct", mediaToken = "t"))
        assertTrue(plan is PlaybackPolicy.Plan.Incomplete)
    }

    @Test
    fun `vdocipher con otp completo se reproduce`() {
        val plan = PlaybackPolicy.plan(
            PlaybackPolicy.Source(sourceType = "vdocipher", otp = "OTP", playbackInfo = "INFO", mediaToken = "t")
        )
        assertTrue(plan is PlaybackPolicy.Plan.VdoOtp)
    }

    @Test
    fun `faltar credenciales se distingue de faltar la direccion del contenido`() {
        val sinOtp = PlaybackPolicy.plan(PlaybackPolicy.Source(sourceType = "vdocipher", mediaToken = "t"))
        val sinContenedor = PlaybackPolicy.plan(PlaybackPolicy.Source(sourceType = "edu", mediaToken = "t"))
        assertTrue(sinOtp is PlaybackPolicy.Plan.Incomplete)
        assertTrue(sinContenedor is PlaybackPolicy.Plan.Incomplete)
    }

    @Test
    fun `una clase edu con contenedor y token se reproduce en el telefono`() {
        // Android ya descifra el contenedor .edu; antes esto devolvia Unsupported
        // y el alumno de movil se quedaba sin la clase.
        val plan = PlaybackPolicy.plan(
            PlaybackPolicy.Source(sourceType = "edu", eduContentId = "edu-abc123", mediaToken = "t")
        )
        assertTrue(plan is PlaybackPolicy.Plan.Edu)
        assertEquals("edu-abc123", (plan as PlaybackPolicy.Plan.Edu).contentId)
        assertEquals("t", plan.mediaToken)
    }

    @Test
    fun `una clase edu sin token de reproduccion no se intenta abrir`() {
        // Sin el token atado al video el servidor no entrega la clave: es mejor
        // decirlo que lanzar una descarga que va a fallar.
        val plan = PlaybackPolicy.plan(PlaybackPolicy.Source(sourceType = "edu", eduContentId = "edu-abc123"))
        assertTrue(plan is PlaybackPolicy.Plan.Incomplete)
    }

    @Test
    fun `una clase edu acepta el sessionToken de un enlace permanente`() {
        val plan = PlaybackPolicy.plan(
            PlaybackPolicy.Source(sourceType = "edu", eduContentId = "edu-abc123", sessionToken = "s")
        )
        assertTrue(plan is PlaybackPolicy.Plan.Edu)
        assertEquals("s", (plan as PlaybackPolicy.Plan.Edu).mediaToken)
    }

    @Test
    fun `un rechazo del servidor se transmite con su motivo`() {
        val plan = PlaybackPolicy.plan(PlaybackPolicy.Source(sourceType = "bunny", error = "Sin licencia para este curso."))
        assertTrue(plan is PlaybackPolicy.Plan.Rejected)
        assertEquals("Sin licencia para este curso.", (plan as PlaybackPolicy.Plan.Rejected).message)
    }

    @Test
    fun `una respuesta vacia no se confunde con un rechazo`() {
        val plan = PlaybackPolicy.plan(PlaybackPolicy.Source(sourceType = "bunny"))
        assertTrue(plan is PlaybackPolicy.Plan.Incomplete)
    }

    @Test
    fun `el DRM llega intacto al plan cuando el servidor lo entrega`() {
        val plan = PlaybackPolicy.plan(
            PlaybackPolicy.Source(
                sourceType = "bunny",
                manifestUrl = "https://edulock.test/api/r/abc",
                mediaToken = "t",
                drmScheme = "widevine",
                drmLicenseUrl = "https://edulock.test/api/drm/licencia"
            )
        ) as PlaybackPolicy.Plan.Hls
        assertEquals("widevine", plan.drmScheme)
        assertEquals("https://edulock.test/api/drm/licencia", plan.drmLicenseUrl)
    }
}
