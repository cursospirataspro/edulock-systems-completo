package com.edulock.player.edu

import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.math.BigInteger
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.MGF1ParameterSpec
import java.security.spec.PSSParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

/**
 * Lector del contenedor .edu para Android. Replica byte a byte el lector de
 * escritorio (player-app/edu-native.js), de modo que un mismo archivo se abre
 * igual en el PC y en el teléfono.
 *
 * Disposición del archivo:
 *
 *   "EDU!" | u16 versión | u16 flags | salt(16) | u32 largoCabecera |
 *   cabecera(AES-256-GCM) | cuerpo(AES-256-CTR sobre trozos AES-256-GCM) |
 *   HMAC-SHA256(32) | [ firma RSA-PSS | u16 largo | "EDUS" ]
 *
 * Dos decisiones importantes:
 *
 *  - Se lee sobre un archivo, no sobre un ByteArray. Un vídeo de clase no cabe
 *    en la memoria de un teléfono, y el .edu en disco no es un riesgo: sin la
 *    CEK —que solo existe en memoria durante la sesión— no se puede abrir.
 *  - El vídeo se descifra trozo a trozo, bajo demanda. El mp4 completo no llega
 *    a existir en ningún momento, ni en RAM ni en disco.
 */
object EduContainer {

    private val MAGIC = byteArrayOf(0x45, 0x44, 0x55, 0x21)     // E D U !
    private val SIG_MAGIC = byteArrayOf(0x45, 0x44, 0x55, 0x53)  // E D U S
    private const val TAG_LEN = 16
    private const val MAC_LEN = 32
    private const val BLOQUE_LECTURA = 64 * 1024

    class EduException(mensaje: String) : Exception(mensaje)

    // ── Fuente de bytes ─────────────────────────────────────────────────────

    /** De dónde salen los bytes del contenedor. */
    interface Fuente : Closeable {
        val tamano: Long
        fun leer(off: Long, len: Int): ByteArray
    }

    /** Para pruebas y contenedores pequeños. */
    class FuenteMemoria(private val datos: ByteArray) : Fuente {
        override val tamano: Long get() = datos.size.toLong()
        override fun leer(off: Long, len: Int): ByteArray =
            datos.copyOfRange(off.toInt(), (off + len).toInt())
        override fun close() {}
    }

    /** La que usa el reproductor: el .edu descargado en el almacenamiento privado. */
    class FuenteArchivo(archivo: File) : Fuente {
        private val raf = RandomAccessFile(archivo, "r")
        override val tamano: Long = raf.length()
        @Synchronized override fun leer(off: Long, len: Int): ByteArray {
            val buf = ByteArray(len)
            raf.seek(off)
            raf.readFully(buf)
            return buf
        }
        @Synchronized override fun close() { try { raf.close() } catch (_: Exception) {} }
    }

    /** Contenedor abierto y comprobado, listo para leer rangos. */
    class Abierto(
        val fuente: Fuente,
        val cek: ByteArray,
        val salt: ByteArray,
        val claveTransporte: ByteArray,
        val inicioCuerpo: Long,
        val tamTrozo: Int,
        val totalTrozos: Int,
        val largoOriginal: Long,
        val meta: JSONObject,
        val firmado: Boolean,
    ) : Closeable {
        val titulo: String get() = meta.optString("title", "")
        val marcaDeAgua: String get() = meta.optString("watermark", "")
        override fun close() { fuente.close() }
    }

    // ── Primitivas ──────────────────────────────────────────────────────────

    /**
     * HKDF-SHA256 con sal vacía, igual que crypto.hkdfSync de Node.
     * (HMAC rellena la clave con ceros hasta 64 bytes, así que una sal vacía y
     * una de 32 ceros dan exactamente el mismo PRK.)
     */
    fun hkdf(clave: ByteArray, info: ByteArray, largo: Int = 32): ByteArray {
        val extraer = Mac.getInstance("HmacSHA256")
        extraer.init(SecretKeySpec(ByteArray(32), "HmacSHA256"))
        val prk = extraer.doFinal(clave)

        val expandir = Mac.getInstance("HmacSHA256")
        expandir.init(SecretKeySpec(prk, "HmacSHA256"))
        val salida = ByteArrayOutputStream()
        var bloque = ByteArray(0)
        var contador = 1
        while (salida.size() < largo) {
            expandir.reset()
            expandir.update(bloque)
            expandir.update(info)
            expandir.update(contador.toByte())
            bloque = expandir.doFinal()
            salida.write(bloque)
            contador++
        }
        return salida.toByteArray().copyOf(largo)
    }

    private fun u32le(n: Int): ByteArray = byteArrayOf(
        (n and 0xff).toByte(), ((n ushr 8) and 0xff).toByte(),
        ((n ushr 16) and 0xff).toByte(), ((n ushr 24) and 0xff).toByte(),
    )

    private fun leerU32le(b: ByteArray, off: Int): Long =
        (b[off].toLong() and 0xff) or ((b[off + 1].toLong() and 0xff) shl 8) or
            ((b[off + 2].toLong() and 0xff) shl 16) or ((b[off + 3].toLong() and 0xff) shl 24)

    private fun leerU16le(b: ByteArray, off: Int): Int =
        (b[off].toInt() and 0xff) or ((b[off + 1].toInt() and 0xff) shl 8)

    /**
     * CEK = HKDF(MASTER_KEY, "edu-cek|" || salt || "|" || contentId).
     * El teléfono NO la deriva: la clave la entrega el servidor por sesión, con
     * licencia válida. Está aquí para que las pruebas puedan generar la misma.
     */
    fun derivarCek(masterKeyHex: String, salt: ByteArray, contentId: String): ByteArray {
        val info = ByteArrayOutputStream()
        info.write("edu-cek|".toByteArray(Charsets.UTF_8))
        info.write(salt)
        info.write("|".toByteArray(Charsets.UTF_8))
        info.write(contentId.toByteArray(Charsets.UTF_8))
        return hkdf(deHex(masterKeyHex), info.toByteArray(), 32)
    }

    fun deHex(hex: String): ByteArray {
        val limpio = hex.trim()
        if (limpio.length % 2 != 0) throw EduException("hexadecimal de longitud impar")
        val out = ByteArray(limpio.length / 2)
        for (i in out.indices) {
            val alto = Character.digit(limpio[i * 2], 16)
            val bajo = Character.digit(limpio[i * 2 + 1], 16)
            if (alto < 0 || bajo < 0) throw EduException("hexadecimal inválido")
            out[i] = ((alto shl 4) or bajo).toByte()
        }
        return out
    }

    private const val ALFABETO_B64 =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    /**
     * Base64 propio, en lugar de android.util.Base64 o java.util.Base64: el
     * primero no existe al correr las pruebas en el PC y el segundo exige API 26,
     * por encima del minimo que soporta la app.
     */
    private fun deBase64(texto: String): ByteArray {
        val salida = ByteArrayOutputStream()
        var acumulador = 0
        var bits = 0
        for (c in texto) {
            if (c == '=') break
            val v = ALFABETO_B64.indexOf(c)
            if (v < 0) continue                      // saltos de linea, espacios, cabeceras
            acumulador = (acumulador shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                salida.write((acumulador ushr bits) and 0xff)
            }
        }
        return salida.toByteArray()
    }

    private fun descodificarPem(pem: String): ByteArray = deBase64(
        pem.replace("-----BEGIN PUBLIC KEY-----", "")
            .replace("-----END PUBLIC KEY-----", "")
    )

    // ── Firma ───────────────────────────────────────────────────────────────

    /**
     * Localiza el remolque de firma y la comprueba con la clave pública que
     * viene dentro de la app. Devuelve dónde termina el contenedor de verdad.
     *
     * Con clave pública configurada, un contenedor sin firma o firmado por otro
     * se rechaza: eso es lo que impide sustituir el archivo por uno cualquiera.
     */
    private fun comprobarFirma(fuente: Fuente, clavePublicaPem: String): Pair<Long, Boolean> {
        val n = fuente.tamano
        if (n <= 6) throw EduException("archivo .edu demasiado corto")

        val cola = fuente.leer(n - 6, 6)
        val traeFirma = cola[2] == SIG_MAGIC[0] && cola[3] == SIG_MAGIC[1] &&
            cola[4] == SIG_MAGIC[2] && cola[5] == SIG_MAGIC[3]

        if (!traeFirma) {
            if (clavePublicaPem.isNotBlank()) {
                throw EduException("el contenido no está firmado y este reproductor exige firma")
            }
            return Pair(n, false)
        }

        val largo = leerU16le(cola, 0)
        val corte = n - 6 - largo
        if (corte <= 0) throw EduException("remolque de firma inválido")
        if (clavePublicaPem.isBlank()) return Pair(corte, false)

        val firma = fuente.leer(corte, largo)
        val clave = KeyFactory.getInstance("RSA")
            .generatePublic(X509EncodedKeySpec(descodificarPem(clavePublicaPem)))
        val v = firmaRsaPss()
        v.setParameter(PSSParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, 32, 1))
        v.initVerify(clave)
        recorrer(fuente, 0, corte) { b, len -> v.update(b, 0, len) }
        if (!v.verify(firma)) {
            throw EduException("firma inválida — el contenido fue alterado o no lo emitió este servidor")
        }
        return Pair(corte, true)
    }

    /**
     * RSA-PSS con SHA-256. Android lo registra como "SHA256withRSA/PSS" y la JVM
     * de escritorio como "RSASSA-PSS"; se prueban los dos para que el mismo
     * codigo valga en el telefono y en las pruebas del PC.
     */
    private fun firmaRsaPss(): Signature =
        try { Signature.getInstance("SHA256withRSA/PSS") }
        catch (_: java.security.NoSuchAlgorithmException) { Signature.getInstance("RSASSA-PSS") }

    /** Recorre [desde, hasta) en bloques, sin cargar el archivo entero. */
    private inline fun recorrer(fuente: Fuente, desde: Long, hasta: Long, bloque: (ByteArray, Int) -> Unit) {
        var pos = desde
        while (pos < hasta) {
            val n = minOf(BLOQUE_LECTURA.toLong(), hasta - pos).toInt()
            bloque(fuente.leer(pos, n), n)
            pos += n
        }
    }

    // ── Apertura ────────────────────────────────────────────────────────────

    fun abrir(datos: ByteArray, cek: ByteArray, clavePublicaPem: String): Abierto =
        abrir(FuenteMemoria(datos), cek, clavePublicaPem)

    fun abrir(archivo: File, cek: ByteArray, clavePublicaPem: String): Abierto =
        abrir(FuenteArchivo(archivo), cek, clavePublicaPem)

    /**
     * Comprueba firma, HMAC y cabecera y devuelve el estado para leer rangos.
     * No descifra ni un byte de vídeo: eso ocurre trozo a trozo en [leerRango].
     */
    fun abrir(fuente: Fuente, cek: ByteArray, clavePublicaPem: String): Abierto {
        try {
            if (fuente.tamano < 76 || cek.size != 32) {
                throw EduException("Contenedor o clave .edu inválidos")
            }

            val (fin, firmado) = comprobarFirma(fuente, clavePublicaPem)

            val cabeza = fuente.leer(0, 28)
            if (!(cabeza[0] == MAGIC[0] && cabeza[1] == MAGIC[1] &&
                    cabeza[2] == MAGIC[2] && cabeza[3] == MAGIC[3])) {
                throw EduException("magic inválido: no es un .edu")
            }
            if (leerU16le(cabeza, 4) != 1 || (leerU16le(cabeza, 6) and 3.inv()) != 0) {
                throw EduException("Versión .edu no soportada")
            }

            // HMAC sobre todo menos los últimos 32 bytes del contenedor.
            val finCuerpo = fin - MAC_LEN
            if (finCuerpo <= 28) throw EduException("Contenedor .edu truncado")
            val hm = Mac.getInstance("HmacSHA256")
            hm.init(SecretKeySpec(hkdf(cek, "mac".toByteArray()), "HmacSHA256"))
            recorrer(fuente, 0, finCuerpo) { b, len -> hm.update(b, 0, len) }
            val esperado = hm.doFinal()
            if (!MessageDigest.isEqual(fuente.leer(finCuerpo, MAC_LEN), esperado)) {
                throw EduException("HMAC inválido — contenedor manipulado o clave incorrecta")
            }

            val salt = cabeza.copyOfRange(8, 24)
            val hdrLen = leerU32le(cabeza, 24)
            var off = 28L
            if (hdrLen < 16 || hdrLen > finCuerpo - off) throw EduException("Cabecera .edu inválida")

            val hdrCt = fuente.leer(off, hdrLen.toInt()); off += hdrLen
            val hc = Cipher.getInstance("AES/GCM/NoPadding")
            hc.init(Cipher.DECRYPT_MODE,
                SecretKeySpec(hkdf(cek, "header".toByteArray()), "AES"),
                GCMParameterSpec(128, salt, 0, 12))
            val meta = JSONObject(String(hc.doFinal(hdrCt), Charsets.UTF_8))

            val tamTrozo = if (meta.has("chunk_size")) meta.getInt("chunk_size") else 8192
            val largoOriginal = meta.optLong("orig_len", -1L)
            val totalTrozos = meta.optInt("total_chunks", -1)
            if (largoOriginal < 1) throw EduException(".edu sin longitud original válida")
            if (tamTrozo < 1 || tamTrozo > 4194304 ||
                totalTrozos.toLong() != (largoOriginal + tamTrozo - 1) / tamTrozo ||
                (finCuerpo - off) != largoOriginal + totalTrozos.toLong() * 20L) {
                throw EduException("Longitudes .edu inconsistentes")
            }

            return Abierto(
                fuente = fuente, cek = cek, salt = salt,
                claveTransporte = hkdf(cek, "transport".toByteArray()),
                inicioCuerpo = off, tamTrozo = tamTrozo, totalTrozos = totalTrozos,
                largoOriginal = largoOriginal, meta = meta, firmado = firmado,
            )
        } catch (e: Throwable) {
            fuente.close()
            throw e
        }
    }

    // ── Lectura por rangos ──────────────────────────────────────────────────

    /** Contador CTR = salt[:16] leído como entero de 128 bits + índice de bloque. */
    private fun ivCtr(salt16: ByteArray, bloque: Long): ByteArray {
        val v = BigInteger(1, salt16).add(BigInteger.valueOf(bloque))
            .mod(BigInteger.ONE.shiftLeft(128))
        val crudo = v.toByteArray()          // puede traer un 0x00 delante o medir menos de 16
        val iv = ByteArray(16)
        val desde = maxOf(0, crudo.size - 16)
        val cuantos = minOf(16, crudo.size)
        System.arraycopy(crudo, desde, iv, 16 - cuantos, cuantos)
        return iv
    }

    private fun entradaTrozo(st: Abierto): Long = 4L + st.tamTrozo + TAG_LEN
    private fun offsetTrozo(st: Abierto, i: Int): Long = st.inicioCuerpo + i * entradaTrozo(st)
    private fun largoCifradoTrozo(st: Abierto, i: Int): Int {
        val plano = if (i < st.totalTrozos - 1) st.tamTrozo.toLong()
                    else st.largoOriginal - i.toLong() * st.tamTrozo
        return (plano + TAG_LEN).toInt()
    }

    /**
     * Descifra SOLO el rango [desde, hasta] —ambos incluidos, como la cabecera
     * Range de HTTP— y devuelve exactamente esos bytes. El resto del vídeo sigue
     * cifrado.
     */
    fun leerRango(st: Abierto, desdePedido: Long, hastaPedido: Long): ByteArray {
        var desde = desdePedido
        var hasta = hastaPedido
        if (desde < 0) desde = 0
        if (hasta >= st.largoOriginal) hasta = st.largoOriginal - 1
        if (desde > hasta) return ByteArray(0)

        val primero = (desde / st.tamTrozo).toInt()
        val ultimo = (hasta / st.tamTrozo).toInt()
        val partes = ByteArrayOutputStream()

        for (i in primero..ultimo) {
            val inicioCt = offsetTrozo(st, i) + 4            // saltar el prefijo de longitud
            val largoCt = largoCifradoTrozo(st, i)

            // 1) quitar el transporte AES-256-CTR solo de esta región
            val offEnCuerpo = inicioCt - st.inicioCuerpo
            val bloque = offEnCuerpo / 16
            val intra = (offEnCuerpo % 16).toInt()
            val tc = Cipher.getInstance("AES/CTR/NoPadding")
            tc.init(Cipher.DECRYPT_MODE, SecretKeySpec(st.claveTransporte, "AES"),
                IvParameterSpec(ivCtr(st.salt, bloque)))
            if (intra > 0) tc.update(ByteArray(intra))        // alinear el keystream
            val ct = tc.doFinal(st.fuente.leer(inicioCt, largoCt))

            // 2) descifrar el trozo AES-256-GCM con su subclave
            val sub = hkdf(st.cek, "chunk".toByteArray() + u32le(i))
            val nonce = ByteArray(12)                          // salt[0:4] || u64le(i)
            System.arraycopy(st.salt, 0, nonce, 0, 4)
            System.arraycopy(u32le(i), 0, nonce, 4, 4)
            val g = Cipher.getInstance("AES/GCM/NoPadding")
            g.init(Cipher.DECRYPT_MODE, SecretKeySpec(sub, "AES"), GCMParameterSpec(128, nonce))
            partes.write(g.doFinal(ct))
        }

        val todo = partes.toByteArray()
        val recorte = (desde - primero.toLong() * st.tamTrozo).toInt()
        val cuantos = (hasta - desde + 1).toInt()
        return todo.copyOfRange(recorte, recorte + cuantos)
    }
}
