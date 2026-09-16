package com.edulock.player.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.OnBackPressedCallback
import com.edulock.player.R
import com.edulock.player.api.LicenseManager
import com.edulock.player.utils.ActivationStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * LicenseActivity — Pantalla de ingreso/activación de licencia (paridad con el PC).
 *
 * Aparece cuando el dispositivo no tiene una activación válida o cuando el admin
 * regeneró/revocó la licencia (expulsión). El usuario ingresa la clave
 * `XXXX-XXXX-XXXX-XXXX`; al activarse correctamente entra al catálogo.
 *
 * Intent extras opcionales:
 *   - EXTRA_MESSAGE: mensaje a mostrar (p.ej. "Tu licencia fue actualizada...").
 *   - EXTRA_EMAIL:   correo del alumno (informativo).
 */
class LicenseActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "LicenseActivity"
        const val EXTRA_MESSAGE = "extra_message"
        const val EXTRA_EMAIL = "extra_email"
        private val KEY_REGEX = Regex("^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$")
    }

    private lateinit var keyInput: EditText
    private lateinit var activateButton: Button
    private lateinit var logoutButton: Button
    private lateinit var statusView: TextView
    private lateinit var progress: ProgressBar
    private lateinit var subtitle: TextView
    private lateinit var emailView: TextView

    private var isFormatting = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { moveTaskToBack(true) }
        })

        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        )

        setContentView(R.layout.activity_license)

        keyInput = findViewById(R.id.licenseKeyInput)
        activateButton = findViewById(R.id.activateButton)
        logoutButton = findViewById(R.id.licenseLogoutButton)
        statusView = findViewById(R.id.licenseStatus)
        progress = findViewById(R.id.licenseProgress)
        subtitle = findViewById(R.id.licenseSubtitle)
        emailView = findViewById(R.id.licenseEmail)

        // Mensaje de expulsión (licencia regenerada/revocada)
        intent.getStringExtra(EXTRA_MESSAGE)?.takeIf { it.isNotBlank() }?.let {
            showStatus(it, isError = true)
        }
        intent.getStringExtra(EXTRA_EMAIL)?.takeIf { it.isNotBlank() }?.let {
            emailView.text = it
            emailView.visibility = View.VISIBLE
        }

        setupKeyFormatting()
        activateButton.setOnClickListener { onActivate() }
        logoutButton.setOnClickListener { onLogout() }
    }

    /** Formatea la clave como XXXX-XXXX-XXXX-XXXX mientras se escribe. */
    private fun setupKeyFormatting() {
        keyInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (isFormatting) return
                isFormatting = true
                val raw = (s?.toString() ?: "")
                    .uppercase()
                    .replace(Regex("[^A-Z0-9]"), "")
                    .take(16)
                val sb = StringBuilder()
                for (i in raw.indices) {
                    if (i > 0 && i % 4 == 0) sb.append('-')
                    sb.append(raw[i])
                }
                keyInput.setText(sb.toString())
                keyInput.setSelection(sb.length)
                isFormatting = false
            }
        })
    }

    private fun onActivate() {
        val key = keyInput.text.toString().trim().uppercase()
        if (!KEY_REGEX.matches(key)) {
            showStatus("Ingresa una clave con formato XXXX-XXXX-XXXX-XXXX.", isError = true)
            return
        }
        setLoading(true)
        showStatus("Activando licencia...", isError = false)

        CoroutineScope(Dispatchers.Main).launch {
            val result = LicenseManager.activate(this@LicenseActivity, key)
            setLoading(false)
            if (result.ok) {
                Log.i(TAG, "✅ Licencia activada")
                startActivity(Intent(this@LicenseActivity, WaitingActivity::class.java))
                finish()
            } else {
                val msg = when (result.code) {
                    "DEVICE_LIMIT_EXCEEDED" ->
                        "Alcanzaste el límite de dispositivos. Contacta al administrador."
                    "NETWORK_ERROR" ->
                        result.error ?: "Error de conexión. Revisa tu internet."
                    else ->
                        result.error ?: "No se pudo activar la licencia. Verifica la clave."
                }
                showStatus(msg, isError = true)
            }
        }
    }

    private fun onLogout() {
        // Limpiar sesión + activación y volver al login
        ActivationStore.clear(this)
        getSharedPreferences("edulock_auth", Context.MODE_PRIVATE).edit().clear().apply()
        startActivity(Intent(this, LoginActivity::class.java))
        finishAffinity()
    }

    private fun setLoading(loading: Boolean) {
        progress.visibility = if (loading) View.VISIBLE else View.GONE
        activateButton.isEnabled = !loading
        keyInput.isEnabled = !loading
    }

    private fun showStatus(message: String, isError: Boolean) {
        statusView.text = message
        statusView.setTextColor(getColor(if (isError) R.color.error else R.color.text_primary))
        statusView.visibility = View.VISIBLE
    }

}
