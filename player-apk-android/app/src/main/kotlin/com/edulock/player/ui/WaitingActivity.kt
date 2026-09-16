package com.edulock.player.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.OnBackPressedCallback
import com.edulock.player.R
import com.edulock.player.api.ApiClient
import com.edulock.player.api.LicenseManager
import com.edulock.player.api.data.DeviceCheckinRequest
import com.edulock.player.api.data.ResolveCommandRequest
import com.edulock.player.api.data.ResolvePermRequest
import com.edulock.player.api.data.ResolveResponse
import com.edulock.player.utils.ActivationStore
import com.edulock.player.utils.AppSignature
import com.edulock.player.utils.DeviceFingerprintAdvanced
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * WaitingActivity — Pantalla de espera (paridad exacta con el reproductor PC).
 *
 * No muestra catálogo: tras iniciar sesión y activar la licencia, el APK queda
 * "Esperando comando de reproducción…". La reproducción solo arranca cuando se
 * abre un enlace `cdp://play?t=...` (o `p=`), igual que el .exe de Windows.
 *
 * El mismo enlace funciona en PC y Android: el esquema `cdp://` abre el .exe en
 * Windows y este APK en Android (intent-filter en SplashActivity).
 */
class WaitingActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "WaitingActivity"
        /** SharedPref donde SplashActivity deja el enlace edulock:// pendiente. */
        const val PREF_PENDING_CDP = "pending_cdp"
        private const val PREFS = "edulock_auth"

        /** edulock:// es el esquema actual; cdp:// se acepta por enlaces antiguos. */
        fun isDeepLink(raw: String?): Boolean =
            raw != null && (raw.startsWith("edulock:", ignoreCase = true) || raw.startsWith("cdp:", ignoreCase = true))
    }

    private lateinit var subtitle: TextView
    private lateinit var hint: TextView
    private lateinit var progress: ProgressBar
    private lateinit var logoutBtn: Button

    private val apiService get() = ApiClient.getService()

    private var licenseGuardJob: Job? = null
    private var expelled = false
    private var resolving = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { moveTaskToBack(true) }
        })

        // Anti-captura de pantalla y anti-grabación (igual que el resto de la app)
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        )

        setContentView(R.layout.activity_waiting)

        subtitle = findViewById(R.id.waiting_subtitle)
        hint = findViewById(R.id.waiting_hint)
        // Pulso suave del texto de espera (mismo efecto que el splash del PC)
        hint.startAnimation(android.view.animation.AlphaAnimation(1f, 0.4f).apply {
            duration = 1000
            repeatMode = android.view.animation.Animation.REVERSE
            repeatCount = android.view.animation.Animation.INFINITE
        })
        progress = findViewById(R.id.waiting_progress)
        logoutBtn = findViewById(R.id.waiting_logout)

        subtitle.text = "${getString(R.string.waiting_subtitle)} · v${currentVersionName()}"
        logoutBtn.setOnClickListener { onLogout() }
        // Paridad con el reproductor de PC: los videos se abren solo desde enlaces
        // externos (portadas edulock://). Dentro de la app solo queda el panel de documentos/PDF.
        findViewById<Button>(R.id.waiting_catalog).apply {
            visibility = android.view.View.VISIBLE
            setText(R.string.resources_open_documents)
            setOnClickListener {
                startActivity(Intent(this@WaitingActivity, CatalogActivity::class.java)
                    .putExtra(CatalogActivity.EXTRA_DOCS_ONLY, true))
            }
        }

        Log.i(TAG, "🕒 Esperando comando de reproducción…")

        // Checkin de inicio (igual que PC al abrir la app)
        sendStartupCheckin()

        // Guardia de licencia: valida al abrir y cada 60s. Si el admin regeneró/
        // revocó la licencia, expulsa a la pantalla de licencia (igual que el PC).
        startLicenseGuard()

        // Procesar un enlace que haya llegado directo a esta actividad
        intent?.dataString?.let { stashPendingCdp(it) }
        processPendingCdp()
    }

    override fun onNewIntent(newIntent: Intent?) {
        super.onNewIntent(newIntent)
        if (newIntent != null) setIntent(newIntent)
        newIntent?.dataString?.let { stashPendingCdp(it) }
        processPendingCdp()
    }

    override fun onResume() {
        super.onResume()
        // Captura enlaces dejados por SplashActivity/Login/License mientras navegábamos
        processPendingCdp()
    }

    override fun onDestroy() {
        super.onDestroy()
        licenseGuardJob?.cancel()
    }

    // ── Manejo del enlace edulock:// ──────────────────────────────────────────

    private fun stashPendingCdp(raw: String) {
        if (!isDeepLink(raw)) return
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(PREF_PENDING_CDP, raw).apply()
    }

    private fun takePendingCdp(): String? {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(PREF_PENDING_CDP, null)
        if (raw != null) prefs.edit().remove(PREF_PENDING_CDP).apply()
        return raw
    }

    private fun processPendingCdp() {
        if (resolving) return
        val raw = takePendingCdp() ?: return
        val resourceId = ResourcePolicy.deepLinkId(raw)
        if (resourceId != null) {
            startActivity(Intent(this, ResourceActivity::class.java).putExtra(ResourceActivity.EXTRA_RESOURCE_ID, resourceId))
            return
        }
        resolveAndPlay(raw)
    }

    /** Normaliza y extrae los parámetros del enlace edulock://play?... (o cdp:// legado) */
    private fun parseCdp(raw: String): Map<String, String> {
        return try {
            val normalized = raw
                .replace(Regex("^(edulock|cdp)://", RegexOption.IGNORE_CASE), "edulock://")
                .replace(Regex("^(edulock|cdp):(?!//)", RegexOption.IGNORE_CASE), "edulock://")
            val uri = Uri.parse(normalized)
            val out = HashMap<String, String>()
            for (key in listOf("t", "p", "cmd", "auth")) {
                uri.getQueryParameter(key)?.takeIf { it.isNotBlank() }?.let { out[key] = it }
            }
            out
        } catch (_: Exception) {
            emptyMap()
        }
    }

    private fun resolveAndPlay(raw: String) {
        val params = parseCdp(raw)
        if (params.isEmpty()) {
            toast("El enlace de video no es válido.")
            return
        }
        resolving = true
        setResolving(true)

        CoroutineScope(Dispatchers.Main).launch {
            try {
                val data: ResolveResponse = withContext(Dispatchers.IO) {
                    when {
                        params.containsKey("p") -> resolvePerm(params["p"]!!)
                        params.containsKey("t") -> resolveShortToken(params["t"]!!)
                        params.containsKey("cmd") && params.containsKey("auth") ->
                            resolveCommand(params["cmd"]!!, params["auth"]!!)
                        else -> throw IllegalStateException("El enlace no contiene un comando de reproducción.")
                    }
                }
                launchPlayer(data)
            } catch (e: Exception) {
                if (e is CourseLicenseRequired) {
                    val isAdmin = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("user_role", "student") == "admin"
                    if (isAdmin) {
                        // El admin nunca pasa por la pantalla de licencia (igual que en PC).
                        toast(e.message ?: "Este video requiere una licencia de curso.")
                        return@launch
                    }
                    if (!params.containsKey("t")) {
                        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(PREF_PENDING_CDP, raw).apply()
                    }
                    startActivity(Intent(this@WaitingActivity, LicenseActivity::class.java))
                    finish()
                    return@launch
                }
                Log.e(TAG, "Error resolviendo enlace: ${e.message}")
                toast(e.message ?: "No se pudo iniciar la reproducción.")
            } finally {
                resolving = false
                setResolving(false)
            }
        }
    }

    /** cdp://play?t=TOKEN → canjea short-token y resuelve el comando. */
    private suspend fun resolveShortToken(token: String): ResolveResponse {
        val deviceId = DeviceFingerprintAdvanced.captureFullDeviceInfo(this).deviceId
        val (rts, rsig) = AppSignature.redeemHeaders(token)
        val redeem = apiService.redeemPlaybackToken(token, rts.toString(), rsig, deviceId)
        if (!redeem.isSuccessful) {
            throw Exception(errorMessage(redeem.errorBody()?.string(),
                "Token de acceso inválido o expirado. Genera un nuevo enlace desde tu campus."))
        }
        val body = redeem.body()
        val cmd = body?.cmd
        val auth = body?.auth
        if (cmd.isNullOrBlank() || auth.isNullOrBlank()) {
            throw Exception("El enlace no devolvió un comando válido.")
        }
        return resolveCommand(cmd, auth)
    }

    /** Resuelve un comando cifrado con su JWT de reproductor (auth del enlace). */
    private suspend fun resolveCommand(cmd: String, auth: String): ResolveResponse {
        val (ts, sig) = AppSignature.headers()
        val resp = apiService.resolvePlaybackCommand(
            ts.toString(), sig, "Bearer $auth", ResolveCommandRequest(cmd)
        )
        if (!resp.isSuccessful) {
            throw Exception(errorMessage(resp.errorBody()?.string(),
                "No se pudo validar la sesión de reproducción."))
        }
        return resp.body() ?: throw Exception("Respuesta vacía del servidor.")
    }

    /** cdp://play?p=TOKEN → enlace permanente, usa el JWT del alumno logueado. */
    private suspend fun resolvePerm(perm: String): ResolveResponse {
        val jwt = com.edulock.player.utils.SessionManager.validToken(this)
        if (jwt.isEmpty()) throw Exception("Inicia sesión para abrir este enlace.")
        val deviceId = DeviceFingerprintAdvanced.captureFullDeviceInfo(this).deviceId
        val (ts, sig) = AppSignature.headers()
        val resp = apiService.resolvePermLink(
            ts.toString(), sig, "Bearer $jwt", ResolvePermRequest(perm, deviceId)
        )
        if (!resp.isSuccessful) {
            throw Exception(errorMessage(resp.errorBody()?.string(),
                "Enlace inválido o no autorizado para tu cuenta."))
        }
        return resp.body() ?: throw Exception("Respuesta vacía del servidor.")
    }

    /** Lanza PlayerActivity con los datos resueltos (HLS bunny o VdoCipher). */
    private fun launchPlayer(data: ResolveResponse) {
        val intent = Intent(this, PlayerActivity::class.java).apply {
            putExtra(PlayerActivity.EXTRA_SESSION_ID, data.sessionId ?: "")
            putExtra(PlayerActivity.EXTRA_VIDEO_ID, data.videoId ?: "")
            putExtra(PlayerActivity.EXTRA_VIDEO_TITLE, "")
            putExtra(PlayerActivity.EXTRA_WATERMARK_TEXT, data.watermarkText ?: "")
            putExtra(PlayerActivity.EXTRA_MEDIA_TOKEN, data.mediaToken ?: data.sessionToken ?: "")
            putExtra(PlayerActivity.EXTRA_COURSE_ID, data.courseId ?: "__default__")
            putExtra(PlayerActivity.EXTRA_WATERMARK_CONFIG, data.watermarkConfig?.toString() ?: "")
        }
        when (data.sourceType) {
            "edu" -> {
                toast("Este video .edu requiere Edulock para escritorio. Android admite Bunny Stream/HLS y VdoCipher.")
                return
            }
            "vdocipher" -> {
                if (data.otp.isNullOrBlank() || data.playbackInfo.isNullOrBlank()) {
                    toast("Credenciales de video no disponibles.")
                    return
                }
                intent.putExtra(PlayerActivity.EXTRA_SOURCE_TYPE, "vdocipher")
                intent.putExtra(PlayerActivity.EXTRA_VDO_OTP, data.otp)
                intent.putExtra(PlayerActivity.EXTRA_VDO_PLAYBACK_INFO, data.playbackInfo)
            }
            "vdocipher_direct" -> {
                if (data.directUrl.isNullOrBlank()) {
                    toast("URL de video no disponible.")
                    return
                }
                intent.putExtra(PlayerActivity.EXTRA_SOURCE_TYPE, "vdocipher_direct")
                intent.putExtra(PlayerActivity.EXTRA_VDO_DIRECT_URL, data.directUrl)
            }
            else -> {
                val manifest = data.manifestUrl
                if (manifest.isNullOrBlank()) {
                    toast("El servidor no devolvió la URL del video.")
                    return
                }
                intent.putExtra(PlayerActivity.EXTRA_SOURCE_TYPE, "bunny")
                intent.putExtra(PlayerActivity.EXTRA_MANIFEST_URL, manifest)
                // El manifest se autentica con el token bloqueado al video. Los
                // enlaces `t=`/`cmd=` devuelven `mediaToken`; los enlaces
                // permanentes `p=` devuelven `sessionToken` (role:perm, también
                // bloqueado al videoId). Sin este fallback el token quedaba vacío
                // y se usaba el JWT de login → el servidor respondía 403 "Sin
                // acceso a este video". Así el mismo enlace abre cualquier
                // dispositivo autorizado, igual que el reproductor de PC.
                intent.putExtra(
                    PlayerActivity.EXTRA_AUTH_TOKEN,
                    data.mediaToken ?: data.sessionToken ?: ""
                )
            }
        }
        startActivity(intent)
    }

    private class CourseLicenseRequired : Exception("Ingresa una licencia válida para este curso.")

    private fun errorMessage(errorBody: String?, fallback: String): String {
        val code = try { org.json.JSONObject(errorBody ?: "{}").optString("code") } catch (_: Exception) { "" }
        if (code == "LICENSE_REQUIRED") throw CourseLicenseRequired()
        if (errorBody.isNullOrBlank()) return fallback
        return try {
            org.json.JSONObject(errorBody).optString("error").takeIf { it.isNotBlank() } ?: fallback
        } catch (_: Exception) { fallback }
    }

    // ── Guardia de licencia (igual que el PC) ─────────────────────────────────

    private fun startLicenseGuard() {
        licenseGuardJob?.cancel()
        licenseGuardJob = CoroutineScope(Dispatchers.Main).launch {
            delay(3000)
            while (isActive && !expelled) {
                // 1) Actualización obligatoria: si el admin publica una nueva versión
                //    mínima, expulsar de inmediato (no se puede seguir usando la app).
                if (checkMandatoryUpdate()) break
                // 2) Licencia: si fue regenerada/revocada, expulsar a la pantalla de licencia.
                val isAdmin = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("user_role", "student") == "admin"
                val result = if (isAdmin) LicenseManager.ValidationResult(true) else LicenseManager.validate(this@WaitingActivity)
                if (result.revoked) {
                    expelToLicense(
                        result.error
                            ?: "Tu licencia fue actualizada por el administrador. Ingresa la nueva licencia para continuar."
                    )
                    break
                }
                delay(60_000)
            }
        }
    }

    /**
     * Comprueba en línea la versión mínima requerida. Si la versión instalada es
     * menor, muestra una actualización OBLIGATORIA (no cancelable) y cierra la app.
     * Devuelve true si se bloqueó (para detener el guard).
     */
    private suspend fun checkMandatoryUpdate(): Boolean {
        return try {
            val v = withContext(Dispatchers.IO) { apiService.getPlayerVersion() }
            val minVersion = v.minVersion
            val current = currentVersionName()
            if (!minVersion.isNullOrBlank() && compareSemver(current, minVersion) < 0) {
                val link = v.downloads?.get("android")?.takeIf { it.isNotBlank() } ?: v.downloadUrl
                expelled = true
                showMandatoryUpdate(minVersion, v.message, link)
                true
            } else false
        } catch (_: Exception) {
            // Fallo de red transitorio: no bloquear.
            false
        }
    }

    private fun compareSemver(a: String, b: String): Int {
        val pa = a.split(".").map { it.filter(Char::isDigit).toIntOrNull() ?: 0 }
        val pb = b.split(".").map { it.filter(Char::isDigit).toIntOrNull() ?: 0 }
        val n = maxOf(pa.size, pb.size)
        for (i in 0 until n) {
            val x = pa.getOrElse(i) { 0 }
            val y = pb.getOrElse(i) { 0 }
            if (x != y) return x - y
        }
        return 0
    }

    private fun showMandatoryUpdate(minVersion: String, message: String?, link: String?) {
        val msg = buildString {
            append(message?.takeIf { it.isNotBlank() }
                ?: "Hay una nueva versión del reproductor disponible.")
            append("\n\nDebes actualizar a la versión $minVersion o superior para poder continuar. ")
            append("No podrás ver ni reproducir contenido hasta actualizar.")
        }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Actualización obligatoria")
            .setMessage(msg)
            .setCancelable(false)
            .setPositiveButton("Actualizar ahora") { _, _ ->
                if (!link.isNullOrBlank()) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) } catch (_: Exception) { }
                }
                finishAffinity()
            }
            .setNegativeButton("Salir") { _, _ -> finishAffinity() }
            .show()
    }

    private fun expelToLicense(message: String) {
        if (expelled) return
        expelled = true
        Log.w(TAG, "🔒 Licencia inválida/regenerada — expulsando a la pantalla de licencia.")
        val intent = Intent(this, LicenseActivity::class.java)
            .putExtra(LicenseActivity.EXTRA_MESSAGE, message)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        startActivity(intent)
        finish()
    }

    // ── Sesión / utilidades ───────────────────────────────────────────────────

    private fun onLogout() {
        ActivationStore.clear(this)
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        startActivity(Intent(this, LoginActivity::class.java))
        finishAffinity()
    }

    private fun sendStartupCheckin() {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val jwt = com.edulock.player.utils.SessionManager.validToken(this@WaitingActivity)
                if (jwt.isEmpty()) return@launch
                val di = DeviceFingerprintAdvanced.captureFullDeviceInfo(this@WaitingActivity)
                val am = getSystemService(ACTIVITY_SERVICE) as android.app.ActivityManager
                val memInfo = android.app.ActivityManager.MemoryInfo()
                am.getMemoryInfo(memInfo)
                val request = DeviceCheckinRequest(
                    deviceId    = di.deviceId,
                    hostname    = di.deviceModel,
                    platform    = "Android",
                    arch        = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64",
                    cpus        = di.cpuCores,
                    totalmem    = memInfo.totalMem,
                    deviceModel = di.deviceModel,
                    osRelease   = di.osVersion,
                    appVersion  = currentVersionName()
                )
                apiService.deviceCheckin(request, "Bearer $jwt")
                Log.i(TAG, "✅ Checkin enviado: ${di.deviceModel}")
            } catch (e: Exception) {
                Log.w(TAG, "Checkin falló (no crítico): ${e.message}")
            }
        }
    }

    private fun getJwtToken(): String {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getString("jwt_token", "") ?: ""
    }

    private fun currentVersionName(): String {
        return try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.1.0"
        } catch (_: Exception) { "1.1.0" }
    }

    private fun setResolving(active: Boolean) {
        progress.visibility = if (active) View.VISIBLE else View.GONE
        hint.text = getString(if (active) R.string.waiting_resolving else R.string.waiting_hint)
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
    }

}
