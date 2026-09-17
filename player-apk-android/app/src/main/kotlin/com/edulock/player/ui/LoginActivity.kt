package com.edulock.player.ui

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.text.method.LinkMovementMethod
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.lifecycleScope
import com.edulock.player.R
import com.edulock.player.api.ApiClient
import com.edulock.player.api.data.AccountStatusRequest
import com.edulock.player.api.data.FirebaseLoginRequest
import com.edulock.player.api.data.LoginResponse
import com.edulock.player.utils.ActivationStore
import com.edulock.player.utils.DeviceFingerprintAdvanced
import com.edulock.player.utils.NotificationPermissionHelper
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.android.material.snackbar.Snackbar
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityTokenRequest
import com.google.firebase.FirebaseNetworkException
import com.google.firebase.FirebaseTooManyRequestsException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseAuthUserCollisionException
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.UserProfileChangeRequest
import com.google.gson.Gson
import java.io.IOException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import retrofit2.Response

/**
 * Firebase proves identity; only the server grants an approved application session.
 * Account absence, incomplete registration, and failed verification stay distinct.
 */
class LoginActivity : AppCompatActivity() {
    private lateinit var emailInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var nameInput: EditText
    private lateinit var termsCheckbox: CheckBox
    private lateinit var loginButton: Button
    private lateinit var registerButton: Button
    private lateinit var toggleModeButton: Button
    private lateinit var forgotPasswordButton: Button
    private lateinit var cancelRegistrationButton: Button
    private lateinit var completeRegistrationButton: Button
    private lateinit var authStatus: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var scrollView: ScrollView

    private var isRegistrationMode = false
    private var isLoading = false
    private var pendingRegistrationUser: FirebaseUser? = null
    private var incompleteRegistrationUser: FirebaseUser? = null
    private var countdownJob: Job? = null
    private var authJob: Job? = null
    private var authGeneration = 0
    private var _autoRegisterRetried = false
    private val apiService get() = ApiClient.getService()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(
            android.view.WindowManager.LayoutParams.FLAG_SECURE,
            android.view.WindowManager.LayoutParams.FLAG_SECURE
        )
        setContentView(R.layout.activity_login)
        initializeUI()
        if (savedInstanceState?.getBoolean("registration_mode") == true) {
            val savedUid = savedInstanceState.getString("registration_uid")
            val user = FirebaseAuth.getInstance().currentUser?.takeIf { savedUid != null && it.uid == savedUid }
            showRegistrationMode(true, user, savedInstanceState.getString("registration_email"))
            nameInput.setText(savedInstanceState.getString("registration_name").orEmpty())
        }
        requestNotificationPermissionsIfNeeded()
        if (intent.getBooleanExtra("from_notification", false)) {
            showStatus("Inicia sesión para comprobar el estado de tu acceso.")
        }
    }

    private fun initializeUI() {
        emailInput = findViewById(R.id.emailInput)
        passwordInput = findViewById(R.id.passwordInput)
        nameInput = findViewById(R.id.nameInput)
        termsCheckbox = findViewById(R.id.termsCheckbox)
        loginButton = findViewById(R.id.loginButton)
        registerButton = findViewById(R.id.registerButton)
        toggleModeButton = findViewById(R.id.toggleModeButton)
        forgotPasswordButton = findViewById(R.id.forgotPasswordButton)
        cancelRegistrationButton = findViewById(R.id.cancelRegistrationButton)
        completeRegistrationButton = findViewById(R.id.completeRegistrationButton)
        authStatus = findViewById(R.id.authStatus)
        progressBar = findViewById(R.id.progressBar)
        scrollView = findViewById(R.id.scrollView)

        loginButton.setOnClickListener { handleLoginOrRegister() }
        registerButton.setOnClickListener { handleLoginOrRegister() }
        toggleModeButton.setOnClickListener { showRegistrationMode(!isRegistrationMode) }
        forgotPasswordButton.setOnClickListener { handlePasswordRecovery() }
        cancelRegistrationButton.setOnClickListener {
            cancelCountdown()
            showStatus("Registro automático cancelado. Puedes corregir tu correo o abrir Registrarse.")
            emailInput.requestFocus()
        }
        completeRegistrationButton.setOnClickListener {
            val user = incompleteRegistrationUser ?: return@setOnClickListener
            showRegistrationMode(true, user)
            showStatus("Tu identidad ya está verificada. Confirma tu nombre y solicita acceso.")
        }
        listOf(emailInput, passwordInput).forEach { field ->
            field.doAfterTextChanged {
                cancelCountdown()
                incompleteRegistrationUser = null
                completeRegistrationButton.visibility = View.GONE
                authStatus.visibility = View.GONE
            }
        }
        passwordInput.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_DONE) {
                handleLoginOrRegister()
                true
            } else false
        }
        termsCheckbox.movementMethod = LinkMovementMethod.getInstance()
        emailInput.requestFocus()
    }

    private fun requestNotificationPermissionsIfNeeded() {
        if (!NotificationPermissionHelper.hasNotificationPermission(this)) {
            AlertDialog.Builder(this)
                .setTitle("Notificaciones de acceso")
                .setMessage(NotificationPermissionHelper.getPermissionExplanation())
                .setPositiveButton("Aceptar") { _, _ ->
                    NotificationPermissionHelper.requestNotificationPermission(this)
                }
                .setNegativeButton("Ahora no", null)
                .show()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        NotificationPermissionHelper.handlePermissionResult(
            requestCode, permissions, grantResults,
            onGranted = { showSnackbar("Notificaciones habilitadas") },
            onDenied = { showSnackbar("Puedes consultar el estado de tu acceso iniciando sesión.") }
        )
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("registration_mode", isRegistrationMode)
        if (isRegistrationMode) {
            outState.putString("registration_uid", pendingRegistrationUser?.uid)
            outState.putString("registration_email", emailInput.text.toString())
            outState.putString("registration_name", nameInput.text.toString())
        }
        super.onSaveInstanceState(outState)
    }

    override fun onPause() {
        val wasCounting = countdownJob != null
        cancelCountdown()
        if (wasCounting) showStatus("Registro automático cancelado al salir de la pantalla.")
        super.onPause()
    }

    override fun onStop() {
        cancelCountdown()
        authGeneration++
        authJob?.cancel()
        authJob = null
        setLoadingState(false)
        super.onStop()
    }

    private fun cancelCountdown() {
        countdownJob?.cancel()
        countdownJob = null
        cancelRegistrationButton.visibility = View.GONE
    }

    private fun startCountdown(httpCode: Int, response: LoginResponse?, email: String): Boolean {
        if (!AuthResponsePolicy.canRegisterAutomatically(httpCode, response)) return false
        cancelCountdown()
        incompleteRegistrationUser = null
        completeRegistrationButton.visibility = View.GONE
        cancelRegistrationButton.visibility = View.VISIBLE
        countdownJob = lifecycleScope.launch {
            for (seconds in 3 downTo 1) {
                val unit = if (seconds == 1) "segundo" else "segundos"
                showStatus("Usuario no registrado. Abriremos el registro en $seconds $unit. Puedes cancelar.")
                delay(1000)
            }
            countdownJob = null
            cancelRegistrationButton.visibility = View.GONE
            showRegistrationMode(true, email = email)
            showStatus("Completa tus datos para solicitar acceso.")
        }
        return true
    }

    private fun showRegistrationMode(register: Boolean, user: FirebaseUser? = null, email: String? = null) {
        cancelCountdown()
        completeRegistrationButton.visibility = View.GONE
        incompleteRegistrationUser = null
        isRegistrationMode = register
        pendingRegistrationUser = if (register) user else null
        nameInput.visibility = if (register) View.VISIBLE else View.GONE
        termsCheckbox.visibility = if (register) View.VISIBLE else View.GONE
        registerButton.visibility = if (register) View.VISIBLE else View.GONE
        loginButton.visibility = if (register) View.GONE else View.VISIBLE
        forgotPasswordButton.visibility = if (register) View.GONE else View.VISIBLE
        passwordInput.visibility = if (register && user != null) View.GONE else View.VISIBLE
        passwordInput.hint = if (register) "Crea una contraseña" else "Contraseña"
        toggleModeButton.text = if (register) "¿Ya tienes cuenta? Inicia sesión" else "¿No tienes cuenta? Regístrate"
        passwordInput.text.clear()
        if (user?.email != null || email != null) emailInput.setText(user?.email ?: email)
        if (user != null && nameInput.text.isNullOrBlank()) nameInput.setText(user.displayName.orEmpty())
        termsCheckbox.isChecked = false
        authStatus.visibility = View.GONE
        setLoadingState(false)
        if (register) nameInput.requestFocus() else emailInput.requestFocus()
        scrollView.smoothScrollTo(0, 0)
    }

    private fun preserveRegistrationUser(user: FirebaseUser) {
        pendingRegistrationUser = user
        emailInput.setText(user.email.orEmpty())
        emailInput.isEnabled = false
        passwordInput.text.clear()
        passwordInput.visibility = View.GONE
    }

    private fun handleLoginOrRegister() {
        if (isLoading) return
        cancelCountdown()
        completeRegistrationButton.visibility = View.GONE
        incompleteRegistrationUser = null
        val email = emailInput.text.toString().trim()
        val password = passwordInput.text.toString()
        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()) {
            showStatus("Ingresa un correo electrónico válido.")
            return
        }
        if (isRegistrationMode) {
            val name = nameInput.text.toString().trim()
            if (name.isBlank()) { showStatus("Ingresa tu nombre completo."); return }
            if (!termsCheckbox.isChecked) { showStatus("Debes aceptar los términos de servicio."); return }
            if (pendingRegistrationUser == null && password.length < 6) {
                showStatus("La contraseña debe tener al menos 6 caracteres.")
                return
            }
            runAuth { performRegistration(email, name, password) }
        } else {
            if (password.isBlank()) { showStatus("Ingresa tu contraseña."); return }
            runAuth { performLogin(email, password) }
        }
    }

    private fun runAuth(operation: suspend () -> Unit) {
        val generation = ++authGeneration
        setLoadingState(true)
        showStatus("Verificando...")
        authJob = lifecycleScope.launch {
            try {
                operation()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                showStatus(errorMessage(error))
            } finally {
                if (generation == authGeneration) setLoadingState(false)
            }
        }
    }

    private fun handlePasswordRecovery() {
        if (isLoading || isRegistrationMode) return
        cancelCountdown()
        completeRegistrationButton.visibility = View.GONE
        incompleteRegistrationUser = null
        val email = PasswordRecovery.normalizedEmail(emailInput.text.toString())
        if (email == null || !android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()) {
            showStatus("Ingresa tu correo electrónico para recuperar el acceso.")
            emailInput.requestFocus()
            return
        }
        runAuth {
            showStatus("Solicitando la recuperación de acceso...")
            val message = PasswordRecovery.request(email) { address ->
                try {
                    awaitFirebase(FirebaseAuth.getInstance().sendPasswordResetEmail(address))
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    // Keep the same honest response with or without Firebase's
                    // email-enumeration protection. This does not create users.
                    if ((causeOf(error) as? FirebaseAuthException)?.errorCode != "ERROR_USER_NOT_FOUND") throw error
                }
            }
            showStatus(message)
        }
    }

    private suspend fun <T> awaitFirebase(task: Task<T>): T =
        withContext(Dispatchers.IO) { Tasks.await(task, 25, TimeUnit.SECONDS) }

    private fun causeOf(error: Throwable): Throwable =
        if (error is ExecutionException && error.cause != null) causeOf(error.cause!!) else error

    private fun errorMessage(error: Throwable): String {
        val cause = causeOf(error)
        return when (cause) {
            is FirebaseNetworkException, is IOException, is TimeoutException ->
                "No se pudo conectar con el servicio de acceso. Revisa tu conexión e intenta nuevamente."
            is FirebaseTooManyRequestsException ->
                "Demasiados intentos. Espera un momento e intenta nuevamente."
            is FirebaseAuthException -> AuthResponsePolicy.firebaseErrorMessage(cause.errorCode)
            else -> "No se pudo completar la operación. Tu cuenta se conserva; intenta nuevamente."
        }
    }

    private suspend fun performLogin(email: String, password: String) {
        val user = try {
            awaitFirebase(FirebaseAuth.getInstance().signInWithEmailAndPassword(email, password)).user
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            val code = (causeOf(error) as? FirebaseAuthException)?.errorCode
            if (AuthResponsePolicy.mayCheckAccount(code)) {
                val http = apiService.checkAccountStatus(AccountStatusRequest(email))
                val response = readResponse(http, LoginResponse::class.java)
                if (startCountdown(http.code(), response, email)) return
                val message = when {
                    response?.code == "ACCOUNT_SYNC_REQUIRED" ->
                        "Tu cuenta está registrada, pero no se pudo validar su acceso. Contacta al administrador; no necesitas registrarte otra vez."
                    response?.code == "REGISTRATION_REQUIRED" ->
                        "Tu cuenta ya existe. Comprueba tu contraseña o utiliza el método con el que la creaste."
                    !http.isSuccessful || response == null || response.status == "error" || response.code == "ACCOUNT_LOOKUP_UNAVAILABLE" ->
                        "No se pudo comprobar tu cuenta en este momento. Intenta nuevamente; no necesitas registrarte otra vez."
                    else -> errorMessage(error)
                }
                showStatus(message)
                return
            }
            throw error
        }
        if (user == null) { showStatus("No se pudo verificar tu identidad. Intenta nuevamente."); return }
        completeFirebaseLogin(user)
    }

    private suspend fun requestIntegrityToken(): String? = withContext(Dispatchers.IO) {
        try {
            val mgr = IntegrityManagerFactory.create(this@LoginActivity)
            val nonce = java.util.UUID.randomUUID().toString().replace("-", "")
            val req = IntegrityTokenRequest.builder().setNonce(nonce).build()
            val tokenResponse = Tasks.await(mgr.requestIntegrityToken(req), 8, TimeUnit.SECONDS)
            tokenResponse.token()
        } catch (_: Exception) { null }
    }

    private suspend fun completeFirebaseLogin(user: FirebaseUser) {
        val idToken = awaitFirebase(user.getIdToken(true)).token
        if (idToken.isNullOrBlank()) { showStatus("No se pudo verificar tu identidad. Intenta nuevamente."); return }
        val info = withContext(Dispatchers.IO) { DeviceFingerprintAdvanced.captureFullDeviceInfo(this@LoginActivity) }
        if (info.deviceId.isBlank()) { showStatus("No se pudo identificar este dispositivo. Intenta nuevamente."); return }
        val integrityTk = requestIntegrityToken()
        val http = apiService.firebaseLogin(FirebaseLoginRequest(
            idToken = idToken, uid = user.uid, email = user.email, deviceId = info.deviceId,
            deviceModel = info.deviceModel, fcmToken = getSharedPreferences("edulock_fcm", Context.MODE_PRIVATE).getString("fcm_token", ""),
            deviceSerial = info.deviceSerial, osVersion = info.osVersion, totalRam = info.totalRam,
            buildFingerprint = info.buildFingerprint, brand = info.brand, manufacturer = info.manufacturer, androidId = info.androidId,
            integrityToken = integrityTk
        ))
        val response = readResponse(http, LoginResponse::class.java)
        if (AuthResponsePolicy.canStartSession(http.code(), response)) {
            val approved = requireNotNull(response)
            val email = user.email.orEmpty()
            val saved = withContext(Dispatchers.IO) {
                getSharedPreferences("edulock_auth", Context.MODE_PRIVATE).edit()
                    .putString("jwt_token", approved.token)
                    .putString("user_role", approved.role ?: "student")
                    .putString("user_email", email)
                    .putString("device_id", info.deviceId)
                    .putLong("login_timestamp", System.currentTimeMillis())
                    .commit()
            }
            if (!saved) { showStatus("No se pudo guardar la sesión. Revisa el espacio disponible e intenta nuevamente."); return }
            val next = if (approved.role == "admin") {
                Intent(this, WaitingActivity::class.java)
            } else {
                // One-license-per-session: always go to LicenseActivity for students
                Intent(this, LicenseActivity::class.java).putExtra(LicenseActivity.EXTRA_EMAIL, email)
            }
            startActivity(next)
            finish()
            return
        }
        // Auto-registration: retry once on not_registered (server should auto-register)
        if ((http.isSuccessful && response?.status == "not_registered") ||
            AuthResponsePolicy.needsManualRegistration(http.code(), response)) {
            if (!_autoRegisterRetried) {
                _autoRegisterRetried = true
                showStatus("Registrando cuenta...")
                delay(1500)
                completeFirebaseLogin(user)
                return
            }
            if (isRegistrationMode) {
                preserveRegistrationUser(user)
            } else {
                incompleteRegistrationUser = user
                completeRegistrationButton.visibility = View.VISIBLE
            }
            showStatus("Tu cuenta existe, pero falta completar tu registro en Edulock.")
            return
        }
        showStatus(loginFailureMessage(http.code(), response))
    }

    private fun loginFailureMessage(httpCode: Int, response: LoginResponse?): String = when {
        httpCode >= 500 -> "El servicio de acceso no está disponible. Intenta nuevamente."
        httpCode == 429 -> "Demasiados intentos. Espera un momento e intenta nuevamente."
        response?.status == "suspended" -> "Tu cuenta está suspendida. Contacta al administrador."
        response?.code == "ACCOUNT_SYNC_REQUIRED" || response?.status == "account_sync_required" ->
            "Tu cuenta está registrada, pero requiere una revisión del administrador. No necesitas registrarte otra vez."
        response?.status == "approved" -> "El servidor no entregó una sesión válida. Intenta nuevamente."
        else -> response?.error?.takeIf { it.isNotBlank() }?.take(300)
            ?: "No se pudo validar tu acceso. Intenta nuevamente."
    }

    // Registro automático: la cuenta de Edulock se crea al instante al iniciar sesión con
    // Firebase. No hay solicitud ni aprobación del administrador; el acceso lo decide la licencia.
    private suspend fun performRegistration(email: String, name: String, password: String) {
        val auth = FirebaseAuth.getInstance()
        val user = pendingRegistrationUser ?: try {
            awaitFirebase(auth.createUserWithEmailAndPassword(email, password)).user
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (causeOf(error) is FirebaseAuthUserCollisionException) {
                awaitFirebase(auth.signInWithEmailAndPassword(email, password)).user
            } else throw error
        }
        if (user == null) { showStatus("No se pudo verificar tu cuenta. Intenta nuevamente."); return }
        if (name.isNotBlank() && user.displayName != name) {
            try { awaitFirebase(user.updateProfile(UserProfileChangeRequest.Builder().setDisplayName(name).build())) } catch (_: Exception) { }
        }
        preserveRegistrationUser(user)
        showStatus("Creando tu cuenta en Edulock...")
        completeFirebaseLogin(user)
    }

    private fun <T> readResponse(http: Response<T>, type: Class<T>): T? =
        http.body() ?: try { http.errorBody()?.string()?.let { Gson().fromJson(it, type) } } catch (_: Exception) { null }

    private fun setLoadingState(loading: Boolean) {
        isLoading = loading
        progressBar.visibility = if (loading) View.VISIBLE else View.GONE
        loginButton.isEnabled = !loading
        registerButton.isEnabled = !loading
        toggleModeButton.isEnabled = !loading
        forgotPasswordButton.isEnabled = !loading
        completeRegistrationButton.isEnabled = !loading
        emailInput.isEnabled = !loading && pendingRegistrationUser == null
        passwordInput.isEnabled = !loading
        nameInput.isEnabled = !loading
        termsCheckbox.isEnabled = !loading
    }

    private fun showStatus(message: String) {
        authStatus.text = message
        authStatus.visibility = View.VISIBLE
    }

    private fun showSnackbar(message: String) {
        Snackbar.make(scrollView, message, Snackbar.LENGTH_LONG).show()
    }
}

