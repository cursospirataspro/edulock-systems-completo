package com.edulock.player.edu

/**
 * Clave PÚBLICA del servidor, usada para comprobar la firma de los contenedores
 * .edu. La escribe scripts/generar-claves-edu.js al generar la pareja de claves.
 *
 * Se puede publicar sin riesgo: sirve para COMPROBAR firmas, no para crearlas.
 * Vacía = no se comprueba la firma (solo para desarrollo).
 */
object EduKeys {
    const val PUBLIC_KEY: String = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjkfgoOyBJUKEFKPr21L2\nS86RymmPhXSCmnMESJxvfXsxCcOl6e9xATuHIckEPtTJzBKCnu4Uw7t/u1Hx4xbv\nZG/nAbLUJWNGHxjjZ8CWZ7Mnr86guuXgMuursKVptrzBHGSWwtgCxljSQ4B8Q32g\nD7Rs9R3n6XnyhigwPwyGQYXB6nQO1Fd+iEOcey4EFe09TC1KAaPRGUt6FxqHLQiG\nDAsZgVKFjOtmMfvDIbeRyMoK5mwMXcaqOsFHVXjoxx4s5EGcPH60lRiYYK2x+zPJ\nS2CGD4njocPnbo8bVhDWqDpalFGudh4zZKlhidPBCwxNrQdOOFTDQauZ3Kkp0SwI\nMwIDAQAB\n-----END PUBLIC KEY-----\n"
}
