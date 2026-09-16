package com.edulock.player.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.edulock.player.R
import com.edulock.player.api.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * SplashActivity - Pantalla de carga inicial
 */
class SplashActivity : AppCompatActivity() {

    override fun onNewIntent(newIntent: Intent?) {
        super.onNewIntent(newIntent)
        if (newIntent != null) setIntent(newIntent)
        newIntent?.dataString?.takeIf { it.startsWith("cdp:", ignoreCase = true) }?.let { raw ->
            getSharedPreferences("edulock_auth", Context.MODE_PRIVATE).edit().putString(WaitingActivity.PREF_PENDING_CDP, raw).apply()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Anti-captura de pantalla y anti-grabación
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        )

        setContentView(R.layout.activity_splash)

        // Si la app se abrió desde un enlace cdp://play?..., guardarlo para que
        // WaitingActivity lo procese tras pasar por login/licencia (igual que el PC,
        // que despacha el comando solo después del login).
        intent?.dataString?.let { raw ->
            if (raw.startsWith("cdp:", ignoreCase = true)) {
                getSharedPreferences("edulock_auth", Context.MODE_PRIVATE)
                    .edit().putString(WaitingActivity.PREF_PENDING_CDP, raw).apply()
            }
        }

        Handler(Looper.getMainLooper()).postDelayed({
            checkVersionThenContinue()
        }, 1500)
    }

    /**
     * Verifica la versión mínima requerida del reproductor antes de continuar.
     * Si la versión instalada es menor a la mínima, muestra una actualización
     * OBLIGATORIA y bloquea el acceso (no se puede ver ni reproducir nada).
     */
    private fun checkVersionThenContinue() {
        CoroutineScope(Dispatchers.Main).launch {
            try {
                val v = withContext(Dispatchers.IO) { ApiClient.getService().getPlayerVersion() }
                val minVersion = v.minVersion
                val current = currentVersionName()
                if (!minVersion.isNullOrBlank() && isOutdated(current, minVersion)) {
                    val link = v.downloads?.get("android")?.takeIf { it.isNotBlank() } ?: v.downloadUrl
                    showMandatoryUpdate(minVersion, v.message, link)
                    return@launch
                }
            } catch (_: Exception) {
                // Sin conexión o error: no bloquear por fallo de red transitorio
            }
            goNext()
        }
    }

    private fun goNext() {
        val prefs = getSharedPreferences("edulock_auth", Context.MODE_PRIVATE)
        val token = prefs.getString("jwt_token", "") ?: ""
        val dest = when {
            token.isEmpty() -> LoginActivity::class.java
            prefs.getString("user_role", "student") == "admin" -> WaitingActivity::class.java
            // Logueado pero sin licencia activada en este dispositivo → pedir licencia.
            // Si ya hay activación local, la pantalla de espera valida en línea y expulsa si fue regenerada.
            !com.edulock.player.utils.ActivationStore.has(this) -> LicenseActivity::class.java
            else -> WaitingActivity::class.java
        }
        startActivity(Intent(this, dest))
        finish()
    }

    private fun currentVersionName(): String {
        return try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "0.0.0"
        } catch (_: Exception) { "0.0.0" }
    }

    /** Devuelve true si current < min (comparación semver simple x.y.z). */
    private fun isOutdated(current: String, min: String): Boolean {
        return compareSemver(current, min) < 0
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
        AlertDialog.Builder(this)
            .setTitle("Actualización obligatoria")
            .setMessage(msg)
            .setCancelable(false)
            .setPositiveButton("Actualizar ahora") { _, _ ->
                if (!link.isNullOrBlank()) {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)))
                    } catch (_: Exception) { }
                }
                finishAffinity()
            }
            .setNegativeButton("Salir") { _, _ -> finishAffinity() }
            .show()
    }
}
