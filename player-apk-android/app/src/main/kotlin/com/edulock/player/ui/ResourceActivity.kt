package com.edulock.player.ui

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.edulock.player.api.ResourceClient
import com.edulock.player.api.ApiClient
import com.edulock.player.api.data.ResourceItem
import com.edulock.player.utils.ActivationStore
import com.edulock.player.utils.DeviceFingerprintAdvanced
import com.edulock.player.utils.SessionManager
import com.google.firebase.auth.FirebaseAuth
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/** A protected document is a short-lived authorized page, never a local PDF. */
class ResourceActivity : AppCompatActivity(), SharedPreferences.OnSharedPreferenceChangeListener {
    companion object {
        const val EXTRA_RESOURCE_ID = "resource_id"
        fun open(context: Context, item: ResourceItem) {
            when (item.protection) {
                "protected" -> {
                    val id = item.resourceId ?: item.id
                    if (ResourcePolicy.validId(id)) context.startActivity(Intent(context, ResourceActivity::class.java).putExtra(EXTRA_RESOURCE_ID, id))
                    else android.widget.Toast.makeText(context, "El recurso no tiene un identificador válido.", android.widget.Toast.LENGTH_LONG).show()
                }
                null, "public" -> {
                    val url = ResourcePolicy.publicUrl(item.url, ApiClient.getBaseUrl())
                    if (url == null) android.widget.Toast.makeText(context, "El enlace público no es válido.", android.widget.Toast.LENGTH_LONG).show()
                    else try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                    catch (_: Exception) { android.widget.Toast.makeText(context, "No hay un navegador disponible para abrir el enlace.", android.widget.Toast.LENGTH_LONG).show() }
                }
                else -> android.widget.Toast.makeText(context, "El tipo de protección de este recurso no es compatible. Actualiza el reproductor.", android.widget.Toast.LENGTH_LONG).show()
            }
        }
    }
    private val prefs by lazy { getSharedPreferences("edulock_auth", Context.MODE_PRIVATE) }
    private val lease = ResourceLease()
    private var resourceId = ""
    private var foreground = false
    private var selectedPage = 1
    private var pageRequest = 0L
    private var jwt = ""
    private var deviceId = ""
    private var watermark = ""
    private var authorizing: Job? = null
    private var pageJob: Job? = null
    private var heartbeatJob: Job? = null
    private var expiryJob: Job? = null
    private lateinit var title: TextView
    private lateinit var status: TextView
    private lateinit var counter: TextView
    private lateinit var pageView: ProtectedPageView
    private lateinit var previous: Button
    private lateinit var next: Button
    private lateinit var retry: Button
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        resourceId = intent.getStringExtra(EXTRA_RESOURCE_ID)?.lowercase() ?: ""
        selectedPage = savedInstanceState?.getInt("selected_page", 1)?.coerceIn(1, 200) ?: 1
        buildUi()
        prefs.registerOnSharedPreferenceChangeListener(this)
        if (!ResourcePolicy.validId(resourceId)) block("El enlace del recurso no es válido.")
    }
    private fun buildUi() {
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(20, 16, 16)); setPadding(12, 8, 12, 8) }
        val heading = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        heading.addView(Button(this).apply { text = "Cerrar"; setOnClickListener { finish() } })
        title = TextView(this).apply { text = "Documento protegido"; textSize = 18f; setTextColor(Color.WHITE); maxLines = 2 }
        heading.addView(title, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        layout.addView(heading)
        status = TextView(this).apply { setTextColor(Color.WHITE); textSize = 14f; setPadding(8, 12, 8, 12); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        layout.addView(status)
        pageView = ProtectedPageView(this)
        layout.addView(pageView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        val controls = LinearLayout(this).apply { gravity = Gravity.CENTER; orientation = LinearLayout.HORIZONTAL }
        previous = Button(this).apply { text = "Anterior"; isEnabled = false; setOnClickListener { requestPage(selectedPage - 1) } }
        next = Button(this).apply { text = "Siguiente"; isEnabled = false; setOnClickListener { requestPage(selectedPage + 1) } }
        counter = TextView(this).apply { text = "—"; setTextColor(Color.WHITE); gravity = Gravity.CENTER }
        controls.addView(previous); controls.addView(counter, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)); controls.addView(next)
        layout.addView(controls)
        val zoom = LinearLayout(this).apply { gravity = Gravity.CENTER }
        zoom.addView(Button(this).apply { text = "−"; contentDescription = "Reducir página"; setOnClickListener { pageView.zoomBy(0.8f) } })
        zoom.addView(Button(this).apply { text = "+"; contentDescription = "Ampliar página"; setOnClickListener { pageView.zoomBy(1.25f) } })
        retry = Button(this).apply { text = "Reintentar"; setOnClickListener { beginAuthorization() } }
        zoom.addView(retry)
        layout.addView(zoom)
        layout.addView(Button(this).apply { text = "Cerrar sesión"; setOnClickListener {
            clearAccess(); FirebaseAuth.getInstance().signOut(); ActivationStore.clear(this@ResourceActivity); prefs.edit().clear().apply()
            startActivity(Intent(this@ResourceActivity, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)); finish()
        } })
        setContentView(layout)
    }
    override fun onResume() { super.onResume(); foreground = true; if (ResourcePolicy.validId(resourceId)) beginAuthorization() }
    override fun onPause() { foreground = false; clearAccess(); super.onPause() }
    override fun onDestroy() { clearAccess(); prefs.unregisterOnSharedPreferenceChangeListener(this); super.onDestroy() }
    override fun onSaveInstanceState(outState: Bundle) { outState.putInt("selected_page", selectedPage); super.onSaveInstanceState(outState) }
    override fun onSharedPreferenceChanged(sharedPreferences: SharedPreferences?, key: String?) {
        if ((key == "jwt_token" || key == null) && prefs.getString("jwt_token", "").isNullOrBlank()) block("La sesión terminó. Inicia sesión nuevamente.")
    }
    private fun clearAccess() {
        lease.invalidate(); pageRequest++
        authorizing?.cancel(); pageJob?.cancel(); heartbeatJob?.cancel(); expiryJob?.cancel()
        authorizing = null; pageJob = null; heartbeatJob = null; expiryJob = null
        jwt = ""; deviceId = ""; watermark = ""
        if (::pageView.isInitialized) pageView.clear()
        if (::previous.isInitialized) { previous.isEnabled = false; next.isEnabled = false; counter.text = "—" }
    }
    private fun block(message: String) { clearAccess(); if (::status.isInitialized) { status.text = message; retry.visibility = View.VISIBLE } }
    private fun beginAuthorization() {
        if (!foreground) return
        clearAccess()
        if (prefs.getString("jwt_token", "").isNullOrBlank()) {
            prefs.edit().putString(WaitingActivity.PREF_PENDING_CDP, "edulock://resource?id=$resourceId").apply()
            startActivity(Intent(this, LoginActivity::class.java)); finish(); return
        }
        status.text = "Comprobando permiso de acceso…"; retry.visibility = View.GONE
        val ticket = lease.generation
        authorizing = lifecycleScope.launch {
            try {
                deviceId = withContext(Dispatchers.IO) { DeviceFingerprintAdvanced.captureFullDeviceInfo(this@ResourceActivity).deviceId }
                if (deviceId.isBlank()) throw IOException("No se pudo identificar este dispositivo.")
                if (authorize(ticket, initial = true)) { requestPage(selectedPage); startGuards(ticket) }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (foreground && ticket == lease.generation) block(error.message ?: "No se pudo comprobar el permiso de acceso.") }
        }
    }
    private suspend fun authorize(ticket: Long, initial: Boolean): Boolean {
        val startedAt = SystemClock.elapsedRealtime()
        if (prefs.getString("jwt_token", "").isNullOrBlank()) throw IOException("La sesión terminó.")
        val token = SessionManager.validToken(this)
        val response = ResourceClient.view(resourceId, token, deviceId)
        if (!foreground || ticket != lease.generation) return false
        if (response.resource?.protection == "public") {
            val url = ResourcePolicy.publicUrl(response.url ?: response.resource.url, ApiClient.getBaseUrl())
            if (!initial || url == null) { block("El recurso cambió. Ciérralo y vuelve a abrirlo."); return false }
            clearAccess()
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))); finish() }
            catch (_: Exception) { block("No hay un navegador disponible para abrir este recurso libre.") }
            return false
        }
        if (!ResourcePolicy.validProtectedView(resourceId, response)) throw IOException("La autorización del documento no es válida.")
        val resource = response.resource!!
        if (!lease.accept(startedAt, SystemClock.elapsedRealtime(), resource.version!!, resource.pageCount!!, response.leaseSeconds!!)) throw IOException("El permiso venció o el documento cambió. Vuelve a abrirlo.")
        jwt = token; watermark = response.watermark!!.email + " · " + response.watermark.code
        title.text = resource.name ?: "Documento protegido"
        selectedPage = selectedPage.coerceIn(1, resource.pageCount)
        return true
    }
    private fun startGuards(ticket: Long) {
        expiryJob = lifecycleScope.launch {
            while (isActive && foreground && ticket == lease.generation) {
                if (!lease.valid(SystemClock.elapsedRealtime()) || prefs.getString("jwt_token", "").isNullOrBlank()) { block("El permiso de acceso venció. Comprueba la conexión e intenta nuevamente."); break }
                delay(250)
            }
        }
        heartbeatJob = lifecycleScope.launch {
            while (isActive && foreground && ticket == lease.generation) {
                delay(15_000)
                try { if (!authorize(ticket, initial = false)) break }
                catch (error: CancellationException) { throw error }
                catch (error: Exception) { if (foreground && ticket == lease.generation) block(error.message ?: "No se pudo renovar el permiso de acceso."); break }
            }
        }
    }
    private fun requestPage(page: Int) {
        val version = lease.version ?: return
        val ticket = lease.generation
        if (!foreground || !lease.permits(ticket, version, page, SystemClock.elapsedRealtime())) return
        pageJob?.cancel(); val request = ++pageRequest; pageView.clear(); selectedPage = page
        previous.isEnabled = false; next.isEnabled = false; counter.text = "$page / ${lease.pageCount}"; status.text = "Cargando página…"
        pageJob = lifecycleScope.launch {
            var bitmap: Bitmap? = null
            try {
                val bytes = ResourceClient.page(resourceId, page, version, jwt, deviceId)
                try {
                    withContext(Dispatchers.IO) {
                        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                        if (!ResourcePolicy.validPngSize(bounds.outWidth, bounds.outHeight)) throw IOException("Las dimensiones de la página no son compatibles.")
                        bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888; inMutable = true })
                            ?: throw IOException("No se pudo leer la página.")
                    }
                } finally { bytes.fill(0) }
                if (!foreground || request != pageRequest || !lease.permits(ticket, version, page, SystemClock.elapsedRealtime())) return@launch
                pageView.show(bitmap!!, watermark); bitmap = null
                pageView.contentDescription = "Página $page de ${lease.pageCount}. Usa los botones para ampliar o cambiar de página."
                status.text = "Documento protegido · $watermark"; previous.isEnabled = page > 1; next.isEnabled = page < (lease.pageCount ?: 0)
            } catch (error: CancellationException) { throw error }
            catch (_: OutOfMemoryError) { if (foreground && request == pageRequest && ticket == lease.generation) block("No hay suficiente memoria para mostrar esta página. Cierra otras aplicaciones e intenta nuevamente.") }
            catch (error: Exception) { if (foreground && request == pageRequest && ticket == lease.generation) block(error.message ?: "No se pudo cargar la página.") }
            finally { bitmap?.let { if (!it.isRecycled) { if (it.isMutable) it.eraseColor(Color.TRANSPARENT); it.recycle() } } }
        }
    }
}

/** Canvas-only frame: there is no WebView, text selection, print or save action. */
private class ProtectedPageView(context: Context) : View(context) {
    private var bitmap: Bitmap? = null
    private var mark = ""
    private var zoom = 1f
    private var panX = 0f
    private var panY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val markPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; textSize = 13 * resources.displayMetrics.scaledDensity; color = Color.argb(210, 180, 35, 45) }
    private val pinch = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean { zoomBy(detector.scaleFactor); return true }
    })
    init { setBackgroundColor(Color.rgb(30, 26, 26)); isClickable = true; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES }
    fun show(value: Bitmap, watermark: String) { clear(); bitmap = value; mark = watermark; invalidate() }
    fun clear() { val old = bitmap; bitmap = null; mark = ""; zoom = 1f; panX = 0f; panY = 0f; invalidate(); old?.let { if (!it.isRecycled) { if (it.isMutable) it.eraseColor(Color.TRANSPARENT); it.recycle() } } }
    fun zoomBy(factor: Float) { if (bitmap != null) { zoom = (zoom * factor).coerceIn(1f, 4f); if (zoom == 1f) { panX = 0f; panY = 0f }; invalidate() } }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val frame = bitmap ?: return
        if (frame.isRecycled) return
        val fit = minOf(width.toFloat() / frame.width, height.toFloat() / frame.height) * zoom
        canvas.save(); canvas.translate((width - frame.width * fit) / 2f + panX, (height - frame.height * fit) / 2f + panY); canvas.scale(fit, fit); canvas.drawBitmap(frame, 0f, 0f, paint); canvas.restore()
        canvas.drawText(mark, width / 2f, height / 2f, markPaint)
        canvas.drawText(mark, width / 2f, height - 24f, markPaint)
    }
    override fun onTouchEvent(event: MotionEvent): Boolean {
        pinch.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { lastX = event.x; lastY = event.y }
            MotionEvent.ACTION_MOVE -> { if (!pinch.isInProgress && zoom > 1f) { panX = (panX + event.x - lastX).coerceIn(-width * zoom / 2, width * zoom / 2); panY = (panY + event.y - lastY).coerceIn(-height * zoom / 2, height * zoom / 2); invalidate() }; lastX = event.x; lastY = event.y }
            MotionEvent.ACTION_UP -> performClick()
        }
        return true
    }
    override fun performClick(): Boolean { super.performClick(); return true }
}
