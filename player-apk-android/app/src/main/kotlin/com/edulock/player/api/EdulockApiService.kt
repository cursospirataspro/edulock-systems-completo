package com.edulock.player.api

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Header
import retrofit2.http.Streaming
import com.edulock.player.api.data.*

/**
 * EdulockApiService.kt — Interfaz REST para la API de Render
 *
 * Define todos los endpoints disponibles:
 * - Autenticación (login, registro, verificación)
 * - Reproducción de videos (obtener URLs, DRM)
 * - Catálogo
 * - Auditoría (watermark logging)
 *
 * Esta interfaz es consumida por Retrofit para generar
 * las llamadas HTTP automáticamente.
 */
interface EdulockApiService {

    companion object {
        const val TAG = "EdulockApiService"
    }

    // ════════════════════════════════════════════════════════════════════════════════
    // AUTENTICACIÓN
    // ════════════════════════════════════════════════════════════════════════════════

    /**
     * POST /api/auth/login
     * Autenticación del usuario
     *
     * Request body:
     * {
     *   "email": "usuario@ejemplo.com",
     *   "password": "password123",
     *   "deviceId": "dev_a1b2c3d4...",
     *   "deviceModel": "Samsung Galaxy A10",
     *   "fcmToken": "eNgc0O9d_qE:APA91bGm7x..."
     * }
     *
     * Response: { "token": "eyJhbGciOiJIUzI1NiIs..." }
     */
    @POST("api/auth/login-email")
    suspend fun login(@Body request: LoginRequest): LoginResponse

    /**
     * POST /api/auth/firebase-login
     * Login con token Firebase (igual que la app Windows)
     * Devuelve Response para poder leer el cuerpo de error (403/401) y mostrar el motivo real.
     */
    @POST("api/auth/firebase-login")
    suspend fun firebaseLogin(@Body request: FirebaseLoginRequest): Response<LoginResponse>

    @POST("api/auth/account-status")
    suspend fun checkAccountStatus(@Body request: AccountStatusRequest): Response<LoginResponse>

    /**
     * POST /api/auth/register-request
     * Crear solicitud de registro (pendiente de aprobación admin)
     *
     * Request body:
     * {
     *   "email": "nuevo@ejemplo.com",
     *   "name": "Juan Pérez",
     *   "password": "password123",
     *   "deviceId": "dev_a1b2c3d4...",
     *   "deviceModel": "Samsung Galaxy A10",
     *   "deviceSerial": "R38M7087CKL",
     *   "osVersion": "Android 11",
     *   "totalRam": "4.0 GB",
     *   "fcmToken": "eNgc0O9d_qE:APA91bGm7x..."
     * }
     *
     * Response: { "requestId": "req_uuid123456789" }
     */
    @POST("api/auth/register-request")
    suspend fun registerRequest(@Body request: RegistrationRequest): Response<RegistrationResponse>

    /**
     * GET /api/auth/check-device?deviceId=...
     * Verificar estado de la solicitud de registro
     *
     * Query param: deviceId (ej: "dev_a1b2c3d4...")
     *
     * Response: {
     *   "status": "pending" | "approved" | "rejected" | "suspended" | "none",
     *   "email": "usuario@ejemplo.com",
     *   "name": "Juan Pérez"
     * }
     */
    @GET("api/auth/check-device")
    suspend fun checkDeviceStatus(@Query("deviceId") deviceId: String): CheckDeviceResponse

    /**
     * POST /api/auth/firebase-login
     * Autenticar con Firebase token (opcional)
     */
    @POST("api/auth/firebase-login")
    suspend fun firebaseLogin(@Body request: Map<String, String>): LoginResponse

    // ════════════════════════════════════════════════════════════════════════════════
    // CATÁLOGO Y VIDEOS
    // ════════════════════════════════════════════════════════════════════════════════

    /**
     * GET /api/my-catalog
     * Obtener lista de videos/cursos disponibles para el usuario
     *
     * Header: Authorization: Bearer <JWT_TOKEN>
     *
     * Response: {
     *   "videos": [
     *     { "id": "video_uuid", "title": "Curso Python", ... },
     *     { "id": "video_uuid2", "title": "Curso React", ... }
     *   ]
     * }
     */
    @GET("api/my-catalog")
    suspend fun getVideoList(
        @Header("Authorization") authorization: String
    ): CatalogResponse

    /**
     * GET /api/video/{videoId}/play
     * Obtener URL de reproducción (HLS manifest) y token de reproducción
     *
     * Params: videoId (UUID del video)
     * Header: Authorization: Bearer <JWT_TOKEN>
     *
     * Response: {
     *   "manifestUrl": "https://vz-cdn.b-cdn.net/.../playlist.m3u8",
     *   "mediaToken": "eyJhbGciOiJIUzI1NiIs...",
     *   "watermarkText": "EDULOCK|timestamp|email|deviceId",
     *   "drmKey": "base64_encoded_key"
     * }
     */
    @GET("api/video/{videoId}/play")
    suspend fun getPlayUrl(
        @Path("videoId") videoId: String,
        @Header("Authorization") authorization: String
    ): PlayUrlResponse

    /**
     * GET /api/video/{videoId}/drm-key
     * Obtener clave DRM para descifrar el contenido
     *
     * Params: videoId (UUID del video)
     * Header: Authorization: Bearer <JWT_TOKEN>
     */
    @GET("api/video/{videoId}/drm-key")
    suspend fun getDrmKey(
        @Path("videoId") videoId: String,
        @Header("Authorization") authorization: String
    ): DrmKeyResponse

    /**
     * POST /api/edu/key
     * Clave del contenedor .edu para esta sesion. El servidor la re-deriva cada
     * vez a partir de su clave maestra y solo la entrega con licencia valida:
     * nunca se almacena, ni en el servidor ni en el telefono.
     *
     * Header: Authorization: Bearer <token de reproduccion>
     */
    @POST("api/edu/key")
    suspend fun getEduKey(
        @Body request: EduKeyRequest,
        @Header("Authorization") authorization: String
    ): EduKeyResponse

    /**
     * GET /api/edu/data/{contentId}
     * Descarga el contenedor .edu. Los bytes van cifrados; sin la clave de arriba
     * no sirven de nada, asi que se pueden guardar en el almacenamiento privado
     * de la app mientras dura la reproduccion.
     */
    @Streaming
    @GET("api/edu/data/{contentId}")
    suspend fun downloadEdu(
        @Path("contentId") contentId: String,
        @Header("Authorization") authorization: String
    ): retrofit2.Response<okhttp3.ResponseBody>

    // ════════════════════════════════════════════════════════════════════════════════
    // AUDITORÍA Y WATERMARKING
    // ════════════════════════════════════════════════════════════════════════════════

    /**
     * POST /api/watermark/log
     * Registrar evento de reproducción (auditoría forense)
     *
     * Request body:
     * {
     *   "mediaToken": "eyJhbGciOiJIUzI1NiIs...",
     *   "videoId": "video_uuid",
     *   "deviceId": "dev_a1b2c3d4...",
     *   "timestamp": 1622206335000
     * }
     *
     * Response: { "ok": true }
     */
    @POST("api/watermark/log")
    suspend fun logWatermark(
        @Body request: WatermarkLogRequest,
        @Header("Authorization") authorization: String
    ): WatermarkLogResponse

    // ════════════════════════════════════════════════════════════════════════════════
    // VERIFICACIÓN Y ESTADO
    // ════════════════════════════════════════════════════════════════════════════════

    /**
     * GET /api/status
     * Verificar que el servidor está disponible
     */
    @GET("api/status")
    suspend fun checkServerStatus(): GenericResponse

    /**
     * GET /api/player/version
     * Obtener versión mínima requerida del reproductor (actualización obligatoria)
     */
    @GET("api/player/version")
    suspend fun getPlayerVersion(@Query("platform") platform: String = "android"): PlayerVersionResponse

    // ════════════════════════════════════════════════════════════════════════════════
    // SESIÓN Y PROGRESO (igual que PC)
    // ════════════════════════════════════════════════════════════════════════════════

    /**
     * POST /api/device/checkin
     * Registrar que la app fue abierta (igual que PC al iniciar)
     */
    @POST("api/device/checkin")
    suspend fun deviceCheckin(
        @Body request: DeviceCheckinRequest,
        @Header("Authorization") authorization: String
    ): GenericResponse

    /**
     * POST /api/playback/progress
     * Enviar progreso del video cada 30s (igual que PC)
     */
    @POST("api/playback/progress")
    suspend fun sendProgress(
        @Body request: ProgressRequest,
        @Header("Authorization") authorization: String
    ): GenericResponse

    /**
     * POST /api/session/heartbeat
     * Mantener sesión activa cada 30s durante reproducción (igual que PC)
     */
    @POST("api/session/heartbeat")
    suspend fun heartbeat(
        @Body request: HeartbeatRequest
    ): HeartbeatResponse

    /**
     * POST /api/session/end
     * Liberar sesión al terminar reproducción
     */
    @POST("api/session/end")
    suspend fun endSession(
        @Body body: Map<String, String>
    ): GenericResponse

    // ════════════════════════════════════════════════════════════════════════════════
    // LICENCIAS (paridad con el reproductor PC — requiere firma HMAC del app oficial)
    // ════════════════════════════════════════════════════════════════════════════════

    /**
     * POST /api/license/activate
     * Activa una clave de licencia en este dispositivo. Requiere las cabeceras
     * x-cdp-ts / x-cdp-sig (firma HMAC del reproductor oficial).
     */
    @POST("api/license/activate")
    suspend fun activateLicense(
        @Header("x-cdp-ts") ts: String,
        @Header("x-cdp-sig") sig: String,
        @Header("Authorization") authorization: String,
        @Body request: LicenseActivateRequest
    ): Response<LicenseActivateResponse>

    /**
     * POST /api/license/validate-activation
     * Valida la activación local y detecta si el admin regeneró/revocó la licencia.
     * Requiere firma HMAC. Códigos de error: LICENSE_REGENERATED, ACTIVATION_REVOKED, ...
     */
    @POST("api/license/validate-activation")
    suspend fun validateActivation(
        @Header("x-cdp-ts") ts: String,
        @Header("x-cdp-sig") sig: String,
        @Body request: ValidateActivationRequest
    ): Response<ValidateActivationResponse>

    /**
     * POST /api/session/activate-license
     * Activa una licencia en la sesión actual (one-license-per-session).
     * Devuelve Stage 2 JWT con acceso a un curso.
     */
    @POST("api/session/activate-license")
    suspend fun sessionActivateLicense(
        @Header("Authorization") authorization: String,
        @Body request: SessionActivateLicenseRequest
    ): Response<SessionActivateLicenseResponse>

    /**
     * GET /api/auth/attestation-challenge
     * Desafío de un solo uso para la atestación por hardware (Android Key Attestation).
     */
    @GET("api/auth/attestation-challenge")
    suspend fun attestationChallenge(): Response<AttestationChallengeResponse>

    /**
     * POST /api/auth/logout
     * Cierra la sesión de contenido en el servidor. La licencia, el dispositivo y el contador
     * de activaciones se conservan; al volver a entrar se pide la licencia de nuevo.
     */
    @POST("api/auth/logout")
    suspend fun logout(
        @Header("Authorization") authorization: String,
        @Body request: LogoutRequest
    ): Response<okhttp3.ResponseBody>

    // ════════════════════════════════════════════════════════════════════════════════
    // REPRODUCCIÓN POR ENLACE cdp:// (paridad con el reproductor PC)
    // El mismo enlace cdp://play?t=... / cdp://play?p=... abre el PC o el APK.
    // ════════════════════════════════════════════════════════════════════════════════

    /**
     * GET /api/playback/t/:token
     * Canjea un short-token (cdp://play?t=TOKEN) por { cmd, auth }.
     * Requiere firma HMAC con mensaje "<token>:<ts>" (AppSignature.redeemHeaders).
     */
    @GET("api/playback/t/{token}")
    suspend fun redeemPlaybackToken(
        @Path("token") token: String,
        @Header("x-cdp-ts") ts: String,
        @Header("x-cdp-sig") sig: String,
        @Query("deviceId") deviceId: String? = null
    ): Response<RedeemTokenResponse>

    /**
     * POST /api/playback/resolve
     * Resuelve el comando cifrado y devuelve la URL del manifiesto / OTP.
     * Requiere firma HMAC "resolve:<ts>" (AppSignature.headers) + JWT del reproductor.
     */
    @POST("api/playback/resolve")
    suspend fun resolvePlaybackCommand(
        @Header("x-cdp-ts") ts: String,
        @Header("x-cdp-sig") sig: String,
        @Header("Authorization") authorization: String,
        @Body request: ResolveCommandRequest
    ): Response<ResolveResponse>

    /**
     * POST /api/playback/resolve-perm
     * Resuelve un enlace permanente (cdp://play?p=TOKEN).
     * Requiere firma HMAC "resolve:<ts>" + JWT del alumno logueado + deviceId registrado.
     */
    @POST("api/playback/resolve-perm")
    suspend fun resolvePermLink(
        @Header("x-cdp-ts") ts: String,
        @Header("x-cdp-sig") sig: String,
        @Header("Authorization") authorization: String,
        @Body request: ResolvePermRequest
    ): Response<ResolveResponse>
}
