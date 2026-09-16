package com.edulock.player.ui

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import android.os.Bundle
import android.widget.ProgressBar
import android.widget.TextView
import android.content.Intent
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.SimpleExoPlayer
import com.google.android.exoplayer2.source.hls.HlsMediaSource
import com.google.android.exoplayer2.upstream.DefaultHttpDataSource
import com.google.android.exoplayer2.ui.StyledPlayerView
import com.google.android.exoplayer2.trackselection.DefaultTrackSelector
import com.google.android.exoplayer2.C
import androidx.core.view.WindowCompat
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.edulock.player.R
import com.edulock.player.api.ApiClient
import com.edulock.player.api.data.HeartbeatRequest
import com.edulock.player.api.data.ProgressRequest
import com.edulock.player.api.data.WatermarkLogRequest
import com.edulock.player.utils.DeviceFingerprintAdvanced
import com.edulock.player.utils.DeviceChangeDetector
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.FrameLayout
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * PlayerActivity.kt — Reproducción de videos con rastreo forense
 *
 * Responsabilidades:
 * 1. Reproducir HLS con DRM Widevine
 * 2. Rastrear reproducción (watermarking forense)
 * 3. Capturar info del dispositivo en cada play
 * 4. Detectar cambios de dispositivo
 * 5. Mantener security (FLAG_SECURE)
 */
class PlayerActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "PlayerActivity"
        const val EXTRA_VIDEO_ID = "videoId"
        const val EXTRA_VIDEO_TITLE = "videoTitle"
        const val EXTRA_MANIFEST_URL = "manifestUrl"
        const val EXTRA_MEDIA_TOKEN = "mediaToken"
        const val EXTRA_WATERMARK_TEXT = "watermarkText"
        const val EXTRA_SESSION_ID = "sessionId"
        const val EXTRA_SOURCE_TYPE = "sourceType"
        const val EXTRA_VDO_OTP = "vdoOtp"
        const val EXTRA_VDO_PLAYBACK_INFO = "vdoPlaybackInfo"
        const val EXTRA_VDO_DIRECT_URL = "vdoDirectUrl"
        // Token con el que se autentica el manifiesto. Para enlaces cdp:// es el
        // mediaToken (bloqueado al video); si falta, se usa el JWT de login.
        const val EXTRA_AUTH_TOKEN = "authToken"
        // Configuración de marcas de agua en tiempo real (JSON string de la config
        // resuelta-o-completa) y el id del curso para suscribirse al stream SSE.
        const val EXTRA_WATERMARK_CONFIG = "watermarkConfig"
        const val EXTRA_COURSE_ID = "courseId"
    }

    private var exoPlayer: ExoPlayer? = null
    private var vdoWebView: WebView? = null
    private var playbackBlocked = false
    private var vdoInterrupted = false
    private lateinit var playerView: StyledPlayerView
    private lateinit var titleView: TextView
    private lateinit var loadingView: ProgressBar
    private lateinit var qualityButton: android.widget.ImageButton
    private var trackSelector: DefaultTrackSelector? = null

    // Estado de sesión (para progress + heartbeat)
    private var currentVideoId: String = ""
    private var currentMediaToken: String = ""
    private var currentSessionId: String? = null
    private var currentDeviceId: String = ""
    private var heartbeatJob: Job? = null
    private var lastProgressSent: Long = 0L

    // Watermark visual
    private lateinit var watermarkView: android.widget.TextView
    private var watermarkHandler: Handler? = null
    private var watermarkRunnable: Runnable? = null
    // 4 marcas de agua INDEPENDIENTES (Correo, IP, Código CDP, Fecha/Hora) que se
    // mueven libremente por cualquier parte del reproductor. El correo (rojo) usa
    // un tamaño mayor (22sp); el resto mantiene el tamaño normal (11sp).
    private val wmViews = mutableListOf<TextView>()
    private val wmRunnables = mutableListOf<Runnable>()
    private var wmClientIp: String = ""
    private var wmEmail: String = ""
    private var wmCode: String = ""

    // Configuración de marcas de agua en tiempo real (tamaño/color/peso/on por
    // marca). Se inicializa con el `watermarkConfig` del play/resolve y se
    // actualiza en vivo por SSE. Es el objeto del SO `android` (o el objeto
    // completo si no viene desagregado por SO).
    @Volatile private var _wmConfig: JsonObject? = null
    private var wmCourseId: String = "__default__"
    private var sseCall: Call? = null
    private var sseJob: Job? = null
    private var sseClient: OkHttpClient? = null
    // Intervalos de movimiento por marca (ms) — se conservan intactos.
    private val wmIntervals = mapOf(
        "email" to 9000L, "ip" to 13000L, "code" to 7000L, "datetime" to 11000L
    )

    // Anti-grabación: detección de pantallas virtuales (grabadoras/cast)
    private var displayManager: android.hardware.display.DisplayManager? = null
    private var displayListener: android.hardware.display.DisplayManager.DisplayListener? = null
    private var captureBlocked: Boolean = false

    private val apiService get() = ApiClient.getService()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // ✅ SECURITY: FLAG_SECURE para prevenir capturas de pantalla
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        )
        
        setContentView(R.layout.activity_player)
        
        // ✅ SECURITY: detección activa de grabación de pantalla / casting / grabadoras flotantes

        
        // Obtener datos del intent
        val videoId = intent.getStringExtra(EXTRA_VIDEO_ID) ?: ""
        val videoTitle = intent.getStringExtra(EXTRA_VIDEO_TITLE) ?: "Video"
        val sourceType = intent.getStringExtra(EXTRA_SOURCE_TYPE) ?: "bunny"
        val manifestUrl = intent.getStringExtra(EXTRA_MANIFEST_URL) ?: ""
        val mediaToken = intent.getStringExtra(EXTRA_MEDIA_TOKEN) ?: ""
        val watermarkText = intent.getStringExtra(EXTRA_WATERMARK_TEXT) ?: ""
        val vdoOtp = intent.getStringExtra(EXTRA_VDO_OTP) ?: ""
        val vdoPlaybackInfo = intent.getStringExtra(EXTRA_VDO_PLAYBACK_INFO) ?: ""

        // Config de marcas de agua en tiempo real (primer pintado + suscripción SSE).
        wmCourseId = intent.getStringExtra(EXTRA_COURSE_ID)?.takeIf { it.isNotBlank() } ?: "__default__"
        _wmConfig = parseWmConfig(intent.getStringExtra(EXTRA_WATERMARK_CONFIG) ?: "")

        Log.i(TAG, "🎬 Reproduciendo: $videoTitle (ID: $videoId, tipo: $sourceType)")

        // Inicializar UI
        playerView = findViewById(R.id.player_view)
        titleView = findViewById(R.id.video_title)
        loadingView = findViewById(R.id.loading_spinner)
        watermarkView = findViewById(R.id.watermark_text)
        qualityButton = findViewById(R.id.quality_button)
        currentDeviceId = DeviceFingerprintAdvanced.captureFullDeviceInfo(this).deviceId
        startScreenCaptureGuard()

        titleView.text = videoTitle

        // Inicializar reproductor según sourceType
        when (sourceType) {
            "edu" -> showError("Los videos .edu requieren Edulock para escritorio.")
            "vdocipher" -> {
                if (vdoOtp.isNotEmpty() && vdoPlaybackInfo.isNotEmpty()) {
                    currentVideoId = videoId
                    currentMediaToken = mediaToken
                    currentSessionId = intent.getStringExtra(EXTRA_SESSION_ID)?.takeIf { it.isNotBlank() } ?: extractSessionId(mediaToken)
                    initializeVdoCipherPlayer(vdoOtp, vdoPlaybackInfo, watermarkText)
                } else {
                    showError("Credenciales VdoCipher no disponibles")
                }
            }
            "vdocipher_direct" -> {
                val directUrl = intent.getStringExtra(EXTRA_VDO_DIRECT_URL) ?: ""
                if (directUrl.isNotEmpty()) {
                    currentVideoId = videoId
                    currentMediaToken = mediaToken
                    currentSessionId = intent.getStringExtra(EXTRA_SESSION_ID)?.takeIf { it.isNotBlank() } ?: extractSessionId(mediaToken)
                    initializeVdoCipherDirect(directUrl, watermarkText)
                } else {
                    showError("URL VdoCipher no disponible")
                }
            }
            else -> {
                if (manifestUrl.isNotEmpty()) {
                    currentVideoId  = videoId
                    currentMediaToken = mediaToken
                    currentSessionId = intent.getStringExtra(EXTRA_SESSION_ID)?.takeIf { it.isNotBlank() } ?: extractSessionId(mediaToken)
                    initializePlayer(videoId, manifestUrl, mediaToken, watermarkText)
                } else {
                    showError("URL de reproducción no disponible")
                }
            }
        }
    }

    /**
     * Inicializar WebView para reproducción VdoCipher
     */
    private fun initializeVdoCipherPlayer(otp: String, playbackInfo: String, watermarkText: String) {
        try {
            // Ocultar ExoPlayer, mostrar WebView
            playerView.visibility = android.view.View.GONE
            qualityButton.visibility = android.view.View.GONE
            loadingView.visibility = android.view.View.VISIBLE

            val webView = WebView(this).apply {
                id = android.view.View.generateViewId()
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    setPluginState(WebSettings.PluginState.ON)
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    cacheMode = WebSettings.LOAD_DEFAULT
                    allowFileAccess = false
                    allowContentAccess = false
                }
                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView?, url: String?) {
                        if (playbackBlocked || url == "about:blank") return
                        loadingView.visibility = android.view.View.GONE
                        startWatermark(watermarkText)
                        startHeartbeat()
                        Log.i(TAG, "▶️ VdoCipher WebView cargado")
                    }
                }
            }

            vdoWebView = webView
            val container = playerView.parent as? FrameLayout
            container?.addView(webView)

            val embedUrl = "https://player.vdocipher.com/v2/?otp=${otp}&playbackInfo=${playbackInfo}&primaryColor=%238b5cf6"
            webView.loadUrl(embedUrl)

        } catch (e: Exception) {
            Log.e(TAG, "❌ Error iniciando VdoCipher: ${e.message}")
            showError("Error al inicializar reproductor VdoCipher: ${e.message}")
        }
    }

    /**
     * Inicializar WebView para una URL directa de VdoCipher (sourceType vdocipher_direct).
     */
    private fun initializeVdoCipherDirect(directUrl: String, watermarkText: String) {
        try {
            playerView.visibility = android.view.View.GONE
            qualityButton.visibility = android.view.View.GONE
            loadingView.visibility = android.view.View.VISIBLE

            val webView = WebView(this).apply {
                id = android.view.View.generateViewId()
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    cacheMode = WebSettings.LOAD_DEFAULT
                    allowFileAccess = false
                    allowContentAccess = false
                }
                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView?, url: String?) {
                        if (playbackBlocked || url == "about:blank") return
                        loadingView.visibility = android.view.View.GONE
                        startWatermark(watermarkText)
                        startHeartbeat()
                        Log.i(TAG, "▶️ VdoCipher directo cargado")
                    }
                }
            }

            vdoWebView = webView
            val container = playerView.parent as? FrameLayout
            container?.addView(webView)
            webView.loadUrl(directUrl)

        } catch (e: Exception) {
            Log.e(TAG, "❌ Error iniciando VdoCipher directo: ${e.message}")
            showError("Error al inicializar reproductor VdoCipher: ${e.message}")
        }
    }
    private fun initializePlayer(videoId: String, manifestUrl: String, mediaToken: String, watermarkText: String) {
        try {
            // Para enlaces cdp:// se usa el mediaToken (bloqueado al video); si no
            // viene, se usa el JWT de login del catálogo. Así el mismo enlace abre
            // cualquier dispositivo autorizado.
            val manifestAuth = intent.getStringExtra(EXTRA_AUTH_TOKEN)?.takeIf { it.isNotBlank() }
                ?: getJwtToken()

            // Añadir el token también como parámetro en la URL (igual que el
            // reproductor PC). El servidor lee `?token=` como fallback si la
            // cabecera Authorization se pierde en un redirect http→https. Esto
            // evita el 403 "Sin acceso a este video" cuando un proxy/CDN elimina
            // las cabeceras al redirigir.
            val authedManifestUrl = if (manifestAuth.isNotBlank() && !manifestUrl.contains("token=")) {
                val sep = if (manifestUrl.contains("?")) "&" else "?"
                "$manifestUrl${sep}token=${android.net.Uri.encode(manifestAuth)}"
            } else manifestUrl

            // DataSource con headers para app nativa: Authorization + X-Native-App
            val dataSourceFactory = DefaultHttpDataSource.Factory()
                .setDefaultRequestProperties(mapOf(
                    "Authorization" to "Bearer $manifestAuth",
                    "X-Native-App" to "1",
                    "Accept" to "application/x-mpegURL, */*"
                ))
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(30000)
                .setReadTimeoutMs(30000)

            // HlsMediaSource que usa nuestro DataSource autenticado
            val hlsSource = HlsMediaSource.Factory(dataSourceFactory)
                .createMediaSource(MediaItem.fromUri(authedManifestUrl))

            // TrackSelector para control de calidad
            trackSelector = DefaultTrackSelector(this).apply {
                setParameters(buildUponParameters().setForceHighestSupportedBitrate(false))
            }

            // Crear instancia de ExoPlayer con trackSelector
            exoPlayer = SimpleExoPlayer.Builder(this)
                .setTrackSelector(trackSelector!!)
                .build().apply {

                setMediaSource(hlsSource)
                prepare()
                
                // Agregar listener para rastrear reproducción
                addListener(object : com.google.android.exoplayer2.Player.Listener {
                    override fun onPlaybackStateChanged(state: Int) {
                        when (state) {
                            com.google.android.exoplayer2.Player.STATE_READY -> {
                                Log.i(TAG, "▶️ Reproducción iniciada: $videoId")
                                loadingView.visibility = android.view.View.GONE
                                showQualityButtonIfAvailable()
                                logPlaybackStart(videoId, mediaToken, watermarkText)
                                startHeartbeat()
                                startWatermark(watermarkText)
                            }
                            com.google.android.exoplayer2.Player.STATE_ENDED -> {
                                Log.i(TAG, "⏹️ Reproducción finalizada: $videoId")
                                qualityButton.visibility = android.view.View.GONE
                                logPlaybackEnd(videoId, mediaToken)
                                sendProgress(100)
                                endSession()
                                stopHeartbeat()
                                stopWatermark()
                            }
                            else -> {}
                        }
                    }

                    override fun onPlayerError(error: com.google.android.exoplayer2.PlaybackException) {
                        val cause = error.cause?.message ?: "sin causa"
                        val code = error.errorCode
                        Log.e(TAG, "❌ Error de reproducción code=$code: ${error.message} | causa: $cause")
                        showError("Error código $code\n${error.message}\nCausa: $cause")
                    }
                })
            }

            playerView.player = exoPlayer
            loadingView.visibility = android.view.View.VISIBLE

        } catch (e: Exception) {
            Log.e(TAG, "❌ Error inicializando player: ${e.message}")
            showError("Error al inicializar reproductor: ${e.message}")
        }
    }

    private fun showQualityButtonIfAvailable() {
        val player = exoPlayer ?: return
        val mappedTrackInfo = trackSelector?.currentMappedTrackInfo ?: return
        for (rendererIndex in 0 until mappedTrackInfo.rendererCount) {
            if (player.getRendererType(rendererIndex) == C.TRACK_TYPE_VIDEO) {
                val trackGroups = mappedTrackInfo.getTrackGroups(rendererIndex)
                if (trackGroups.length > 0) {
                    qualityButton.visibility = android.view.View.VISIBLE
                    qualityButton.setOnClickListener { showQualityDialog(rendererIndex) }
                    return
                }
            }
        }
    }

    private fun showQualityDialog(rendererIndex: Int) {
        val player = exoPlayer ?: return
        val selector = trackSelector ?: return
        val mappedTrackInfo = selector.currentMappedTrackInfo ?: return

        // Recopilar todos los formatos de video disponibles
        data class QualityOption(val label: String, val groupIndex: Int, val trackIndex: Int)
        val options = mutableListOf<QualityOption>()

        val trackGroups = mappedTrackInfo.getTrackGroups(rendererIndex)
        for (gi in 0 until trackGroups.length) {
            val group = trackGroups[gi]
            for (ti in 0 until group.length) {
                val fmt = group.getFormat(ti)
                val h = fmt.height
                val w = fmt.width
                val kbps = if (fmt.bitrate > 0) " (${fmt.bitrate / 1000}kbps)" else ""
                val lbl = when {
                    h >= 1080 -> "1080p$kbps"
                    h >= 720  -> "720p$kbps"
                    h >= 480  -> "480p$kbps"
                    h >= 360  -> "360p$kbps"
                    h > 0     -> "${h}p$kbps"
                    w > 0     -> "${w}x${h}$kbps"
                    else      -> "Calidad ${gi * group.length + ti + 1}$kbps"
                }
                options.add(QualityOption(lbl, gi, ti))
            }
        }

        // Opción "Auto" siempre primero
        val labels = arrayOfNulls<String>(options.size + 1)
        labels[0] = "🔄 Auto (adaptativo)"
        options.forEachIndexed { i, o -> labels[i + 1] = o.label }

        // Detectar selección actual basada en override activo
        val currentOverride = selector.parameters.getSelectionOverride(rendererIndex, trackGroups)
        val currentChecked = if (currentOverride == null) 0 else {
            options.indexOfFirst { o -> o.groupIndex == currentOverride.groupIndex && o.trackIndex == currentOverride.tracks[0] }
                .let { if (it < 0) 0 else it + 1 }
        }

        android.app.AlertDialog.Builder(this)
            .setTitle("Calidad de video")
            .setSingleChoiceItems(labels, currentChecked) { dialog, which ->
                if (which == 0) {
                    // Auto: quitar override para que ExoPlayer elija adaptativamente
                    selector.setParameters(
                        selector.buildUponParameters()
                            .clearSelectionOverrides(rendererIndex)
                            .setRendererDisabled(rendererIndex, false)
                    )
                } else {
                    val opt = options[which - 1]
                    // SelectionOverride fuerza exactamente ese track del grupo
                    val override = DefaultTrackSelector.SelectionOverride(opt.groupIndex, opt.trackIndex)
                    selector.setParameters(
                        selector.buildUponParameters()
                            .setSelectionOverride(rendererIndex, trackGroups, override)
                    )
                }
                dialog.dismiss()
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    /**
     * ✅ NUEVO: Registrar inicio de reproducción (watermarking forense)
     */
    private fun logPlaybackStart(videoId: String, mediaToken: String, watermarkText: String) {
        CoroutineScope(Dispatchers.Main).launch {
            try {
                // Obtener información del dispositivo actual
                val deviceInfo = DeviceFingerprintAdvanced.captureFullDeviceInfo(this@PlayerActivity)
                currentDeviceId = deviceInfo.deviceId

                // Verificar si el dispositivo cambió
                val deviceChangeDetected = checkForDeviceChange(deviceInfo.deviceId)
                if (deviceChangeDetected) {
                    Log.w(TAG, "⚠️ CAMBIO DE DISPOSITIVO DETECTADO: ${deviceInfo.deviceId}")
                    // Optionally: mostrar alerta al usuario
                }

                // Crear request de watermarking
                val request = WatermarkLogRequest(
                    mediaToken = mediaToken,
                    videoId = videoId,
                    deviceId = deviceInfo.deviceId,
                    timestamp = System.currentTimeMillis(),
                    deviceModel = deviceInfo.deviceModel,
                    buildFingerprint = deviceInfo.buildFingerprint,
                    osVersion = deviceInfo.osVersion,
                    cpuCores = deviceInfo.cpuCores
                )

                // Enviar al backend
                withContext(Dispatchers.IO) {
                    try {
                        val response = apiService.logWatermark(
                            request,
                            "Bearer " + getJwtToken()
                        )
                        
                        if (response.ok) {
                            Log.i(TAG, "✅ Watermark registrado: $videoId desde ${deviceInfo.deviceModel}")
                        } else {
                            Log.w(TAG, "⚠️ Error en watermark: ${response.error}")
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "❌ Error enviando watermark: ${e.message}")
                    }
                }

            } catch (e: Exception) {
                Log.e(TAG, "❌ Error en logPlaybackStart: ${e.message}")
            }
        }
    }

    /**
     * Registrar fin de reproducción
     */
    private fun logPlaybackEnd(videoId: String, mediaToken: String) {
        CoroutineScope(Dispatchers.Main).launch {
            try {
                val duration = exoPlayer?.duration ?: 0
                val position = exoPlayer?.currentPosition ?: 0
                val watchedPercentage = if (duration > 0) (position * 100) / duration else 0

                Log.i(TAG, "📊 Reproducción completada: $videoId")
                Log.i(TAG, "   - Duración: $duration ms")
                Log.i(TAG, "   - Visto: $watchedPercentage%")

                // Aquí podrías enviar estadísticas al backend si es necesario
                
            } catch (e: Exception) {
                Log.e(TAG, "Error en logPlaybackEnd: ${e.message}")
            }
        }
    }

    /**
     * ✅ NUEVO: Verificar cambios de dispositivo
     * Compara el deviceId actual con el almacenado en login
     */
    private fun checkForDeviceChange(currentDeviceId: String): Boolean {
        // Usar el DeviceChangeDetector que tiene lógica anti-fraude
        return try {
            // Nota: Este método retorna true si debe bloquearse
            // Para logging, usamos el DeviceChangeDetector directamente
            val history = DeviceChangeDetector.getDeviceHistory(this)
            history.lastDeviceId != currentDeviceId && history.lastDeviceId != "unknown"
        } catch (e: Exception) {
            Log.e(TAG, "Error verificando cambio de dispositivo: ${e.message}")
            false
        }
    }

    /**
     * Obtener JWT token del almacenamiento local
     */
    private fun getJwtToken(): String {
        val prefs = getSharedPreferences("edulock_auth", Context.MODE_PRIVATE)
        return prefs.getString("jwt_token", "") ?: ""
    }

    /** Extraer sessionId del payload del JWT mediaToken */
    private fun extractSessionId(token: String): String? {
        return try {
            val parts = token.split(".")
            if (parts.size < 2) return null
            val payload = android.util.Base64.decode(
                parts[1].replace('-', '+').replace('_', '/'),
                android.util.Base64.DEFAULT
            ).toString(Charsets.UTF_8)
            val json = org.json.JSONObject(payload)
            json.optString("sessionId").takeIf { it.isNotEmpty() }
        } catch (e: Exception) { null }
    }

    /** Heartbeat cada 30s — igual que PC */
    private fun startHeartbeat() {
        stopHeartbeat()
        val sessionId = currentSessionId ?: return
        heartbeatJob = CoroutineScope(Dispatchers.IO).launch {
            while (isActive) {
                delay(30_000)
                try {
                    val pos = withContext(Dispatchers.Main) {
                        exoPlayer?.currentPosition?.div(1000)?.toInt() ?: 0
                    }
                    val resp = apiService.heartbeat(HeartbeatRequest(
                        sessionId   = sessionId,
                        mediaToken  = currentMediaToken,
                        currentTime = pos,
                        deviceId    = currentDeviceId
                    ))
                    if (resp.revoked == true) {
                        Log.w(TAG, "⚠️ Sesión revocada por servidor: ${resp.reason}")
                        withContext(Dispatchers.Main) {
                            stopPlayback()
                            showError("La sesión de reproducción fue revocada. Abre de nuevo tu enlace.")
                        }
                        return@launch
                    }
                } catch (e: Exception) {
                    if (e is retrofit2.HttpException && e.code() in listOf(401, 403)) {
                        withContext(Dispatchers.Main) {
                            stopPlayback()
                            showError("La sesión ya no está autorizada. Abre de nuevo tu enlace.")
                        }
                        return@launch
                    }
                    if (e is kotlinx.coroutines.CancellationException) throw e
                    Log.w(TAG, "Heartbeat sin respuesta")
                }

                // Progreso cada 30s (igual que PC)
                sendProgress()
            }
        }
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    /** Enviar progreso al servidor */
    private fun sendProgress(forcePct: Int? = null) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val jwt = getJwtToken()
                if (jwt.isEmpty() || currentVideoId.isEmpty()) return@launch
                val (pos, pct) = withContext(Dispatchers.Main) {
                    val dur = exoPlayer?.duration?.takeIf { it > 0 } ?: 1L
                    val cur = exoPlayer?.currentPosition ?: 0L
                    val p = ((cur * 100) / dur).toInt().coerceIn(0, 100)
                    Pair(cur.div(1000).toInt(), forcePct ?: p)
                }
                apiService.sendProgress(
                    ProgressRequest(
                        videoId         = currentVideoId,
                        progressPercent = pct,
                        currentTime     = pos,
                        sessionId       = currentSessionId
                    ),
                    "Bearer $jwt"
                )
            } catch (e: Exception) {
                Log.w(TAG, "sendProgress falló: ${e.message}")
            }
        }
    }

    /** Liberar sesión al terminar */
    private fun endSession() {
        val sessionId = currentSessionId ?: return
        CoroutineScope(Dispatchers.IO).launch {
            try {
                apiService.endSession(mapOf("sessionId" to sessionId, "mediaToken" to currentMediaToken, "deviceId" to currentDeviceId))
            } catch (e: Exception) {
                Log.w(TAG, "endSession falló: ${e.message}")
            }
        }
    }

    // ── Watermark visual: 4 marcas independientes con movimiento libre ─────────

    private fun startWatermark(label: String) {
        val prefs = getSharedPreferences("edulock_auth", android.content.Context.MODE_PRIVATE)
        wmEmail = prefs.getString("user_email", "") ?: ""
        wmCode  = label
        stopWatermark()
        fetchClientIp()
        watermarkHandler = Handler(Looper.getMainLooper())
        renderWatermarks()
        // Suscribirse al canal de tamaño de píxeles en tiempo real (SSE).
        subscribeWmConfig()
    }

    // (Re)pinta las 4 marcas aplicando el estilo resuelto de la config en vivo.
    // Se llama al iniciar y cada vez que llega una nueva config por SSE.
    private fun renderWatermarks() {
        val container = watermarkView.parent as? FrameLayout ?: return
        watermarkView.visibility = android.view.View.GONE
        val handler = watermarkHandler ?: Handler(Looper.getMainLooper()).also { watermarkHandler = it }

        // Limpiar marcas previas (sin tocar el canal SSE).
        wmRunnables.forEach { handler.removeCallbacks(it) }
        wmRunnables.clear()
        wmViews.forEach { tv ->
            try { tv.animate().cancel() } catch (_: Exception) {}
            container.removeView(tv)
        }
        wmViews.clear()

        listOf("email", "ip", "code", "datetime").forEach { key ->
            val st = resolveWmStyle(key)
            if (!st.on) return@forEach
            val tv = TextView(this).apply {
                setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, st.sizeSp)   // ◄◄ tamaño en tiempo real
                setTextColor(st.colorArgb)
                setTypeface(typeface, if (st.bold) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
                setShadowLayer(3f, 0f, 1f, android.graphics.Color.argb(220, 0, 0, 0))
                setSingleLine(true)
                maxLines = 1
                ellipsize = null
                includeFontPadding = false
            }
            val lp = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
            lp.gravity = Gravity.TOP or Gravity.START
            tv.layoutParams = lp
            container.addView(tv)
            wmViews.add(tv)

            val interval = wmIntervals[key] ?: 10000L
            val r = object : Runnable {
                override fun run() {
                    val value = wmValue(key)
                    tv.text = value
                    tv.visibility = if (value.isBlank()) android.view.View.INVISIBLE else android.view.View.VISIBLE
                    moveWatermarkRandom(tv, container)
                    handler.postDelayed(this, interval)
                }
            }
            wmRunnables.add(r)
            handler.post(r)
        }
    }

    // Estilo aplicable de una marca: por defecto (correo 35sp rojo; resto 11sp
    // blanco) + override de la config en vivo. Tamaño válido 6–80, peso 100–900.
    private data class WmStyle(val on: Boolean, val sizeSp: Float, val colorArgb: Int, val bold: Boolean)

    private fun defaultWmStyle(key: String): WmStyle =
        if (key == "email") WmStyle(true, 35f, android.graphics.Color.argb(153, 255, 45, 45), true)
        else WmStyle(true, 11f, android.graphics.Color.argb(90, 255, 255, 255), true)

    private fun resolveWmStyle(key: String): WmStyle {
        val d = defaultWmStyle(key)
        val cfg = _wmConfig ?: return d
        return try {
            val enabledEl = cfg.get("enabled")
            if (enabledEl != null && enabledEl.isJsonPrimitive && !enabledEl.asBoolean) return d.copy(on = false)
            val m = cfg.get(key)?.takeIf { it.isJsonObject }?.asJsonObject ?: return d
            val on = m.get("on")?.takeIf { it.isJsonPrimitive }?.let { runCatching { it.asBoolean }.getOrDefault(true) } ?: true
            val size = m.get("size")?.takeIf { it.isJsonPrimitive }?.let { runCatching { it.asInt }.getOrNull() }
            val sizeSp = if (size != null && size in 6..80) size.toFloat() else d.sizeSp
            val baseAlpha = if (key == "email") 153 else 90
            val colorArgb = m.get("color")?.takeIf { it.isJsonPrimitive }?.let { runCatching { it.asString }.getOrNull() }
                ?.let { parseHexColor(it, baseAlpha) } ?: d.colorArgb
            val weight = m.get("weight")?.takeIf { it.isJsonPrimitive }?.let { runCatching { it.asInt }.getOrNull() }
            val bold = if (weight != null && weight in 100..900) weight >= 600 else d.bold
            WmStyle(on, sizeSp, colorArgb, bold)
        } catch (_: Exception) { d }
    }

    private fun parseHexColor(hex: String, alpha: Int): Int? {
        val m = Regex("^#([0-9a-fA-F]{6})$").find(hex.trim()) ?: return null
        val n = m.groupValues[1].toLong(16).toInt()
        return android.graphics.Color.argb(alpha, (n shr 16) and 0xFF, (n shr 8) and 0xFF, n and 0xFF)
    }

    // Extrae el objeto de config del SO `android` (o el objeto completo si el
    // backend no lo desagrega por SO). Devuelve null si el JSON es inválido/vacío.
    private fun parseWmConfig(json: String): JsonObject? {
        if (json.isBlank()) return null
        return try {
            val root = JsonParser.parseString(json)
            if (!root.isJsonObject) return null
            val obj = root.asJsonObject
            val os = obj.get("android")
            if (os != null && os.isJsonObject) os.asJsonObject else obj
        } catch (_: Exception) { null }
    }

    // Abre un canal SSE persistente contra la VPS; cuando el admin cambia
    // tamaño/color/grosor, llega un evento `config` y se re-renderiza sin recargar
    // el video. Reintenta solo ante caídas de red.
    private fun subscribeWmConfig() {
        if (sseJob != null) return
        val jwt = getJwtToken()
        if (jwt.isBlank()) return
        val base = ApiClient.getBaseUrl().trimEnd('/')
        val enc: (String) -> String = { java.net.URLEncoder.encode(it, "UTF-8") }
        val url = "$base/api/watermark/stream/${enc(wmCourseId)}?token=${enc(jwt)}&os=android"
        val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)   // sin timeout de lectura: stream persistente
            .retryOnConnectionFailure(true)
            .build()
        sseClient = client
        val req = Request.Builder().url(url).header("Accept", "text/event-stream").build()
        sseJob = CoroutineScope(Dispatchers.IO).launch {
            while (isActive) {
                try {
                    val call = client.newCall(req)
                    sseCall = call
                    call.execute().use { resp ->
                        val src = resp.body?.source()
                        if (resp.isSuccessful && src != null) {
                            val sb = StringBuilder()
                            while (isActive && !src.exhausted()) {
                                val line = src.readUtf8Line() ?: break
                                when {
                                    line.startsWith("data:") -> sb.append(line.removePrefix("data:").trim())
                                    line.isBlank() -> {
                                        val data = sb.toString(); sb.setLength(0)
                                        if (data.isNotBlank()) applyWmConfigJson(data)
                                    }
                                    // Las líneas `event:` y los comentarios `:` (heartbeat) se ignoran.
                                }
                            }
                        }
                    }
                } catch (_: Exception) { /* se reintenta abajo */ }
                if (isActive) delay(5000)   // reconexión tras caída
            }
        }
    }

    private fun applyWmConfigJson(data: String) {
        val cfg = parseWmConfig(data) ?: return
        _wmConfig = cfg
        runOnUiThread { try { renderWatermarks() } catch (_: Exception) {} }
    }

    private fun wmValue(key: String): String = when (key) {
        "email"    -> if (wmEmail.contains("@")) "\u2709 $wmEmail" else ""
        "ip"       -> if (wmClientIp.isNotBlank()) "IP $wmClientIp" else ""
        "code"     -> wmCode.takeIf { it.isNotBlank() } ?: "EDULOCK"
        "datetime" -> SimpleDateFormat("dd/MM/yyyy HH:mm:ss", Locale.getDefault()).format(Date())
        else       -> ""
    }

    /**
     * Mueve la marca de agua a una posición aleatoria DENTRO del área del
     * reproductor, dejando un margen para que el texto SIEMPRE quede completo
     * (no se corta en los bordes).
     */
    private fun moveWatermarkRandom(tv: TextView, container: FrameLayout) {
        tv.post {
            val pw = container.width
            val ph = container.height
            if (pw <= 0 || ph <= 0) return@post
            val ew = tv.width
            val eh = tv.height
            val margin = 12
            val maxX = (pw - ew - margin).coerceAtLeast(margin)
            val maxY = (ph - eh - margin).coerceAtLeast(margin)
            val x = (margin..maxX).random()
            val y = (margin..maxY).random()
            tv.animate().translationX(x.toFloat()).translationY(y.toFloat())
                .setDuration(1500).start()
        }
    }

    /** Obtiene la IP pública del cliente para la marca de agua (fail-safe). */
    private fun fetchClientIp() {
        if (wmClientIp.isNotBlank()) return
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val conn = java.net.URL("https://api.ipify.org").openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 4000
                conn.readTimeout = 4000
                val ip = conn.inputStream.bufferedReader().use { it.readText() }.trim()
                conn.disconnect()
                if (ip.isNotBlank() && ip.length < 50) wmClientIp = ip
            } catch (e: Exception) {
                Log.w(TAG, "fetchClientIp falló: ${e.message}")
            }
        }
    }

    private fun stopWatermark() {
        val handler = watermarkHandler
        wmRunnables.forEach { handler?.removeCallbacks(it) }
        wmRunnables.clear()
        val container = if (::watermarkView.isInitialized) watermarkView.parent as? FrameLayout else null
        wmViews.forEach { tv ->
            try { tv.animate().cancel() } catch (_: Exception) {}
            container?.removeView(tv)
        }
        wmViews.clear()
        watermarkRunnable?.let { watermarkHandler?.removeCallbacks(it) }
        watermarkHandler = null
        watermarkRunnable = null
        watermarkView.text = ""
        watermarkView.visibility = android.view.View.INVISIBLE

        // Cerrar el canal SSE de tamaño en tiempo real.
        try { sseCall?.cancel() } catch (_: Exception) {}
        sseCall = null
        sseJob?.cancel()
        sseJob = null
        sseClient = null
    }

    /**
     * ✅ SECURITY: detección de grabación / casting / grabadoras flotantes.
     * Aunque FLAG_SECURE ya hace que cualquier captura/grabación se vea en negro,
     * aquí detectamos pantallas virtuales (grabadoras de pantalla, screen mirroring,
     * grabadoras flotantes que crean un VirtualDisplay) y pausamos la reproducción.
     */
    private fun startScreenCaptureGuard() {
        try {
            val dm = getSystemService(Context.DISPLAY_SERVICE) as android.hardware.display.DisplayManager
            displayManager = dm
            val listener = object : android.hardware.display.DisplayManager.DisplayListener {
                override fun onDisplayAdded(displayId: Int) { evaluateDisplays() }
                override fun onDisplayChanged(displayId: Int) { evaluateDisplays() }
                override fun onDisplayRemoved(displayId: Int) { evaluateDisplays() }
            }
            displayListener = listener
            dm.registerDisplayListener(listener, Handler(Looper.getMainLooper()))
            evaluateDisplays()
        } catch (e: Exception) {
            Log.w(TAG, "No se pudo iniciar guardia de captura: ${e.message}")
        }
    }

    private fun stopScreenCaptureGuard() {
        try {
            displayListener?.let { displayManager?.unregisterDisplayListener(it) }
        } catch (_: Exception) { }
        displayListener = null
        displayManager = null
    }

    /** Detecta si hay una pantalla virtual de grabación/cast activa. */
    private fun isRecordingActive(): Boolean {
        val dm = displayManager ?: return false
        return try {
            dm.displays.any { d ->
                d.displayId != android.view.Display.DEFAULT_DISPLAY &&
                (d.flags and android.view.Display.FLAG_PRESENTATION) == 0
            }
        } catch (_: Exception) { false }
    }

    private fun evaluateDisplays() {
        val active = isRecordingActive()
        if (active && !captureBlocked) {
            captureBlocked = true
            stopPlayback()
            android.app.AlertDialog.Builder(this)
                .setTitle("Grabación detectada")
                .setMessage("Se detectó una grabación de pantalla, transmisión o grabadora externa activa. " +
                    "La reproducción se ha bloqueado. Detén la grabación para continuar.")
                .setCancelable(false)
                .setPositiveButton("Salir") { _, _ -> finish() }
                .show()
        } else if (!active) {
            captureBlocked = false
        }
    }

    /**
     * Mostrar mensaje de error
     */
    private fun showError(message: String) {
        Log.e(TAG, message)
        loadingView.visibility = android.view.View.GONE
        
        // Mostrar alerta
        android.app.AlertDialog.Builder(this)
            .setTitle("Error")
            .setMessage(message)
            .setPositiveButton("OK") { _, _ ->
                finish()
            }
            .setCancelable(false)
            .show()
    }

    private fun stopPlayback() {
        playbackBlocked = true
        stopHeartbeat()
        stopWatermark()
        exoPlayer?.pause()
        exoPlayer?.clearMediaItems()
        vdoWebView?.let { view ->
            view.stopLoading()
            view.loadUrl("about:blank")
            (view.parent as? android.view.ViewGroup)?.removeView(view)
            view.destroy()
        }
        vdoWebView = null
    }

    override fun onDestroy() {
        super.onDestroy()
        stopHeartbeat()
        stopWatermark()
        stopScreenCaptureGuard()
        stopPlayback()
        sendProgress()
        endSession()
        exoPlayer?.release()
        exoPlayer = null
    }

    override fun onPause() {
        super.onPause()
        exoPlayer?.pause()
        if (vdoWebView != null) { vdoInterrupted = true; stopPlayback() }
    }

    override fun onResume() {
        super.onResume()
        evaluateDisplays()
        if (!captureBlocked && !playbackBlocked) exoPlayer?.play()
        if (vdoInterrupted) { vdoInterrupted = false; showError("La reproducción se pausó al salir. Abre de nuevo tu enlace para continuar.") }
    }
}
