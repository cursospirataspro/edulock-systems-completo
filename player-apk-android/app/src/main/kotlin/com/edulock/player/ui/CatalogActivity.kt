package com.edulock.player.ui

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.widget.ProgressBar
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.edulock.player.R
import com.edulock.player.api.ApiClient
import com.edulock.player.api.LicenseManager
import com.edulock.player.api.data.DeviceCheckinRequest
import com.edulock.player.api.data.VideoItem
import com.edulock.player.utils.DeviceFingerprintAdvanced
import com.edulock.player.utils.SessionManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * CatalogActivity.kt — Catálogo de videos disponibles
 *
 * Responsabilidades:
 * 1. Obtener lista de videos permitidos del usuario
 * 2. Mostrar en RecyclerView
 * 3. Al seleccionar: obtener URL de reproducción
 * 4. Navegar a PlayerActivity
 */
class CatalogActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "CatalogActivity"
    }

    private lateinit var recyclerView: RecyclerView
    private lateinit var loadingView: ProgressBar
    private lateinit var adapter: VideoAdapter

    private val apiService get() = ApiClient.getService()
    private val videos = mutableListOf<VideoItem>()

    private var licenseGuardJob: Job? = null
    private var expelled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Anti-captura de pantalla y anti-grabación
        window.setFlags(
            android.view.WindowManager.LayoutParams.FLAG_SECURE,
            android.view.WindowManager.LayoutParams.FLAG_SECURE
        )

        setContentView(R.layout.activity_catalog)

        Log.i(TAG, "📚 Catálogo de videos abierto")

        // Inicializar UI
        recyclerView = findViewById(R.id.videos_recycler)
        loadingView = findViewById(R.id.loading_spinner)

        // Configurar RecyclerView
        adapter = VideoAdapter(videos) { videoItem ->
            if (videoItem.resourceItem != null) ResourceActivity.open(this, videoItem.resourceItem)
            else playVideo(videoItem)
        }
        recyclerView.layoutManager = LinearLayoutManager(this)
        recyclerView.adapter = adapter
        findViewById<android.widget.Button>(R.id.logout_button).setOnClickListener { finish() }

        // Cargar videos
        loadVideos()

        // Checkin de inicio (igual que PC al abrir la app)
        sendStartupCheckin()

        // Guardia de licencia: valida al abrir y cada 60s. Si el admin regeneró/
        // revocó la licencia, expulsa a la pantalla de licencia (igual que el PC).
        startLicenseGuard()
    }

    override fun onDestroy() {
        super.onDestroy()
        licenseGuardJob?.cancel()
    }

    /**
     * Valida la activación al abrir el catálogo y luego periódicamente. Ante
     * LICENSE_REGENERATED / ACTIVATION_REVOKED / etc. expulsa a LicenseActivity.
     */
    private fun startLicenseGuard() {
        licenseGuardJob?.cancel()
        licenseGuardJob = CoroutineScope(Dispatchers.Main).launch {
            // Pequeña espera inicial para no competir con la carga del catálogo
            delay(3000)
            while (isActive && !expelled) {
                val result = LicenseManager.validate(this@CatalogActivity)
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

    /**
     * Cargar lista de videos del servidor y aplanar la jerarquía cursos→módulos→videos
     */
    private fun loadVideos() {
        Log.d(TAG, "Cargando videos...")
        loadingView.visibility = android.view.View.VISIBLE

        lifecycleScope.launch {
            try {
                val jwtToken = SessionManager.validToken(this@CatalogActivity)
                if (jwtToken.isEmpty()) {
                    showError("No autorizado. Por favor inicia sesión de nuevo.")
                    return@launch
                }

                val response = withContext(Dispatchers.IO) {
                    apiService.getVideoList("Bearer $jwtToken")
                }

                // Aplanar estructura: courses → modules → videos
                val flatVideos = mutableListOf<VideoItem>()

                response.courses?.forEach { course ->
                    // Videos directos del curso (sin módulo)
                    course.videos?.forEach { v ->
                        flatVideos.add(VideoItem(
                            id = v.videoId ?: v.id,
                            videoId = v.videoId,
                            title = v.title,
                            description = course.name,
                            thumbnail = v.thumbnail,
                            duration = v.duration,
                            documents = v.documents
                        ))
                        appendResources(v.documents, "${course.name} › ${v.title ?: "Video"}", flatVideos)
                    }
                    // Videos dentro de módulos (recursivo)
                    course.modules?.let { extractModuleVideos(it, course.name, flatVideos) }
                }

                // Si la respuesta es plana (fallback)
                response.videos?.forEach { v ->
                    flatVideos.add(v)
                    appendResources(v.documents, v.title ?: "Video", flatVideos)
                }

                if (flatVideos.isNotEmpty()) {
                    videos.clear()
                    videos.addAll(flatVideos)
                    adapter.notifyDataSetChanged()
                    Log.i(TAG, "✅ ${videos.size} videos cargados")
                } else {
                    videos.clear(); adapter.notifyDataSetChanged()
                    showError("No hay cursos ni recursos disponibles")
                }

            } catch (e: Exception) {
                Log.e(TAG, "Error cargando videos: ${e.message}")
                showError("Error al cargar videos: ${e.message}")
            } finally {
                loadingView.visibility = android.view.View.GONE
            }
        }
    }

    /**
     * Extrae videos de módulos recursivamente
     */
    private fun extractModuleVideos(
        modules: List<com.edulock.player.api.data.CourseModule>,
        courseName: String,
        result: MutableList<VideoItem>
    ) {
        modules.forEach { mod ->
            appendResources(mod.documents, "$courseName › ${mod.name ?: "Módulo"}", result)
            mod.videos?.forEach { v ->
                result.add(VideoItem(
                    id = v.videoId ?: v.id,
                    videoId = v.videoId,
                    title = v.title,
                    description = "$courseName › ${mod.name}",
                    thumbnail = v.thumbnail,
                    duration = v.duration,
                    documents = v.documents
                ))
                appendResources(v.documents, "$courseName › ${mod.name ?: "Módulo"} › ${v.title ?: "Video"}", result)
            }
            mod.children?.let { extractModuleVideos(it, courseName, result) }
        }
    }

    private fun appendResources(documents: List<com.edulock.player.api.data.ResourceItem>?, location: String, result: MutableList<VideoItem>) {
        documents?.forEach { resource ->
            result.add(VideoItem(id = resource.resourceId ?: resource.id ?: "", title = resource.name ?: "Recurso", description = location, resourceItem = resource))
        }
    }

    /**
     * Reproducir video seleccionado
     */
    private fun playVideo(video: VideoItem) {
        val realId = video.videoId ?: video.id
        Log.i(TAG, "▶️ Reproduciendo: ${video.title} (ID: $realId)")
        
        CoroutineScope(Dispatchers.Main).launch {
            try {
                loadingView.visibility = android.view.View.VISIBLE

                val jwtToken = SessionManager.validToken(this@CatalogActivity)
                if (jwtToken.isEmpty()) {
                    showError("No autorizado")
                    return@launch
                }

                // Validar licencia antes de reproducir (igual que el PC antes del OTP).
                val lic = LicenseManager.validate(this@CatalogActivity, realId)
                if (lic.revoked) {
                    loadingView.visibility = android.view.View.GONE
                    expelToLicense(
                        lic.error
                            ?: "Tu licencia fue actualizada por el administrador. Ingresa la nueva licencia para continuar."
                    )
                    return@launch
                }

                // Obtener URL de reproducción y token de media
                val playResponse = withContext(Dispatchers.IO) {
                    apiService.getPlayUrl(realId, "Bearer $jwtToken")
                }

                if (playResponse.manifestUrl != null && playResponse.mediaToken != null) {
                    Log.i(TAG, "✅ URL obtenida (Bunny): ${video.title}")

                    // Navegar a PlayerActivity
                    val intent = Intent(this@CatalogActivity, PlayerActivity::class.java).apply {
                        putExtra(PlayerActivity.EXTRA_VIDEO_ID, realId)
                        putExtra(PlayerActivity.EXTRA_VIDEO_TITLE, video.title)
                        putExtra(PlayerActivity.EXTRA_MANIFEST_URL, playResponse.manifestUrl)
                        putExtra(PlayerActivity.EXTRA_MEDIA_TOKEN, playResponse.mediaToken)
                        putExtra(PlayerActivity.EXTRA_WATERMARK_TEXT, playResponse.watermarkText ?: "")
                        putExtra(PlayerActivity.EXTRA_COURSE_ID, playResponse.courseId ?: "__default__")
                        putExtra(PlayerActivity.EXTRA_WATERMARK_CONFIG, playResponse.watermarkConfig?.toString() ?: "")
                    }
                    startActivity(intent)

                } else if (playResponse.sourceType == "vdocipher" &&
                           playResponse.otp != null && playResponse.playbackInfo != null) {
                    Log.i(TAG, "✅ OTP VdoCipher obtenido: ${video.title}")

                    val intent = Intent(this@CatalogActivity, PlayerActivity::class.java).apply {
                        putExtra(PlayerActivity.EXTRA_VIDEO_ID, realId)
                        putExtra(PlayerActivity.EXTRA_VIDEO_TITLE, video.title)
                        putExtra(PlayerActivity.EXTRA_SOURCE_TYPE, "vdocipher")
                        putExtra(PlayerActivity.EXTRA_VDO_OTP, playResponse.otp)
                        putExtra(PlayerActivity.EXTRA_VDO_PLAYBACK_INFO, playResponse.playbackInfo)
                        putExtra(PlayerActivity.EXTRA_MEDIA_TOKEN, playResponse.mediaToken ?: "")
                        putExtra(PlayerActivity.EXTRA_WATERMARK_TEXT, playResponse.watermarkText ?: "")
                        putExtra(PlayerActivity.EXTRA_COURSE_ID, playResponse.courseId ?: "__default__")
                        putExtra(PlayerActivity.EXTRA_WATERMARK_CONFIG, playResponse.watermarkConfig?.toString() ?: "")
                    }
                    startActivity(intent)

                } else {
                    showError("No se puede reproducir este video: ${playResponse.error}")
                }

            } catch (e: Exception) {
                Log.e(TAG, "Error reproduciendo: ${e.message}")
                showError("Error: ${e.message}")
            } finally {
                loadingView.visibility = android.view.View.GONE
            }
        }
    }

    /**
     * Obtener JWT token
     */
    private fun getJwtToken(): String {
        val prefs = getSharedPreferences("edulock_auth", Context.MODE_PRIVATE)
        return prefs.getString("jwt_token", "") ?: ""
    }

    /**
     * Checkin de inicio — igual que PC al arrancar (registra dispositivo en el servidor)
     */
    private fun sendStartupCheckin() {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val jwt = SessionManager.validToken(this@CatalogActivity)
                if (jwt.isEmpty()) return@launch
                val di = DeviceFingerprintAdvanced.captureFullDeviceInfo(this@CatalogActivity)
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
                    appVersion  = "1.0.0"
                )
                apiService.deviceCheckin(request, "Bearer $jwt")
                Log.i(TAG, "✅ Checkin enviado: ${di.deviceModel}")
            } catch (e: Exception) {
                Log.w(TAG, "Checkin falló (no crítico): ${e.message}")
            }
        }
    }

    /**
     * Mostrar error
     */
    private fun showError(message: String) {
        Log.e(TAG, message)
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
}
