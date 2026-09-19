package com.edulock.player.api.data

/**
 * Models.kt — Modelos de datos (DTOs) para la API REST de EDULOCK.
 *
 * Cada clase mapea 1:1 con el cuerpo JSON que el backend (server.js) envía o
 * recibe. Gson usa los nombres de las propiedades como claves JSON, por lo que
 * los nombres aquí COINCIDEN EXACTAMENTE con las claves que usa el servidor.
 *
 * Convención:
 *  - Las respuestas (*Response) tienen TODOS los campos anulables con default
 *    `null` para que la deserialización de Gson nunca produzca NPE aunque el
 *    servidor omita un campo.
 *  - Las peticiones (*Request) contienen los campos que el servidor lee del
 *    cuerpo; los tipos coinciden con los valores que envía la app.
 */

// ════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN
// ════════════════════════════════════════════════════════════════════════════

/** POST /api/auth/login-email — login con email + contraseña (13 campos device). */
data class LoginRequest(
    val email: String,
    val password: String,
    val deviceId: String? = null,
    val deviceModel: String? = null,
    val deviceSerial: String? = null,
    val osVersion: String? = null,
    val osVersionCode: Int? = null,
    val cpuCores: Int? = null,
    val totalRam: String? = null,
    val androidId: String? = null,
    val buildFingerprint: String? = null,
    val brand: String? = null,
    val manufacturer: String? = null,
    val fcmToken: String? = null
)

/** Respuesta de login (login-email / firebase-login). */
data class LoginResponse(
    val role: String? = null,
    val token: String? = null,
    val expiresIn: String? = null,
    val status: String? = null,
    val email: String? = null,
    val name: String? = null,
    val message: String? = null,
    val error: String? = null,
    val code: String? = null,
    val registrationAllowed: Boolean? = null,
    val requiresLicense: Boolean? = null
)

/** Account existence is checked by the backend without sending a password. */
data class AccountStatusRequest(val email: String)

/** POST /api/auth/firebase-login — login con ID token de Firebase. */
data class FirebaseLoginRequest(
    val idToken: String,
    val uid: String? = null,
    val email: String? = null,
    val deviceId: String? = null,
    val deviceModel: String? = null,
    val fcmToken: String? = null,
    val deviceSerial: String? = null,
    val osVersion: String? = null,
    val totalRam: String? = null,
    val buildFingerprint: String? = null,
    val brand: String? = null,
    val manufacturer: String? = null,
    val androidId: String? = null,
    val integrityToken: String? = null,
    val keyAttestation: KeyAttestationPayload? = null
)

/** Cadena de certificados de atestación por hardware (Android Key Attestation), DER en base64, hoja → raíz. */
data class KeyAttestationPayload(val challenge: String, val chain: List<String>, val securityLevel: String? = null)
data class AttestationChallengeResponse(val challenge: String? = null, val expiresIn: Int? = null)

/** POST /api/auth/register-request — crear solicitud de registro. */
data class RegistrationRequest(
    val email: String,
    val name: String,
    val idToken: String? = null,
    val deviceId: String? = null,
    val deviceModel: String? = null,
    val deviceSerial: String? = null,
    val osVersion: String? = null,
    val totalRam: String? = null,
    val fcmToken: String? = null,
    val cpuCores: Int? = null,
    val buildFingerprint: String? = null,
    val brand: String? = null,
    val manufacturer: String? = null,
    val androidId: String? = null,
    val osVersionCode: Int? = null,
    val firebaseUid: String? = null
)

/** Respuesta de register-request. */
data class RegistrationResponse(
    val requestId: String? = null,
    val status: String? = null,
    val message: String? = null,
    val error: String? = null
)

/** GET /api/auth/check-device — estado de la solicitud de un dispositivo. */
data class CheckDeviceResponse(
    val status: String? = null,
    val email: String? = null,
    val name: String? = null,
    val requestId: String? = null,
    val error: String? = null
)

// ════════════════════════════════════════════════════════════════════════════
// CATÁLOGO Y VIDEOS
// ════════════════════════════════════════════════════════════════════════════

/** GET /api/my-catalog — catálogo jerárquico (cursos → módulos → videos). */
data class CatalogResponse(
    val courses: List<Course>? = null,
    val videos: List<VideoItem>? = null,
    val error: String? = null,
    val requiresLicense: Boolean? = null,
    /** "Mis Cursos": el servidor decide si este alumno puede navegar su curso dentro de la app.
     *  Ausente o false = experiencia de siempre (las clases se abren por sus enlaces). */
    val embeddedCatalogEnabled: Boolean? = null
)

/** Un curso del catálogo. */
data class Course(
    val id: String? = null,
    val name: String = "",
    val modules: List<CourseModule>? = null,
    val videos: List<VideoItem>? = null
)

/** Un módulo del curso (puede anidar submódulos vía `children`). */
data class CourseModule(
    val id: String? = null,
    val courseId: String? = null,
    val parentId: String? = null,
    val name: String? = null,
    val sortOrder: Int? = null,
    val videos: List<VideoItem>? = null,
    val children: List<CourseModule>? = null,
    val documents: List<ResourceItem>? = null
)

/** Un video del catálogo / lista aplanada. */
data class VideoItem(
    val id: String = "",
    val videoId: String? = null,
    val title: String? = null,
    val description: String? = null,
    val thumbnail: String? = null,
    val duration: Int? = null,
    val sortOrder: Int? = null,
    val documents: List<ResourceItem>? = null,
    val resourceItem: ResourceItem? = null
)

/** Legacy entries omit protection and remain ordinary public links. */
data class ResourceItem(
    val id: String? = null,
    val resourceId: String? = null,
    val name: String? = null,
    val protection: String? = null,
    val url: String? = null,
    val sourceKind: String? = null,
    val pageCount: Int? = null,
    val version: Int? = null
)
data class ResourceWatermark(val email: String? = null, val code: String? = null)
data class ResourceViewResponse(
    val resource: ResourceItem? = null,
    val watermark: ResourceWatermark? = null,
    val leaseSeconds: Int? = null,
    val url: String? = null
)

/** GET /api/video/{videoId}/play — URL de reproducción / credenciales de video. */
data class PlayUrlResponse(
    val sourceType: String? = null,
    val manifestUrl: String? = null,
    // Direccion directa de VdoCipher. Sin este campo el catalogo no podia
    // reproducir ese tipo de clase aunque el servidor lo enviara (F08).
    val directUrl: String? = null,
    val mediaToken: String? = null,
    val watermarkText: String? = null,
    val otp: String? = null,
    val playbackInfo: String? = null,
    val vdoVideoId: String? = null,
    val drmKey: String? = null,
    val sessionId: String? = null,
    val ttl: Long? = null,
    val courseId: String? = null,
    /** Identificador del contenedor .edu cuando la clase esta protegida asi. */
    val eduContentId: String? = null,
    val watermarkConfig: com.google.gson.JsonElement? = null,
    val error: String? = null,
    /** DRM opcional. Si el servidor entrega un esquema y su licencia, ExoPlayer la usa;
     *  si no vienen, la reproduccion sigue siendo la de siempre (HLS con clave del servidor). */
    val drmScheme: String? = null,
    val drmLicenseUrl: String? = null,
    val drmHeaders: Map<String, String>? = null
)

/** GET /api/video/{videoId}/drm-key — clave DRM para descifrar contenido. */
data class DrmKeyResponse(
    val drmKey: String? = null,
    val key: String? = null,
    val error: String? = null
)

// ════════════════════════════════════════════════════════════════════════════
// AUDITORÍA Y MARCA DE AGUA
// ════════════════════════════════════════════════════════════════════════════

/** POST /api/watermark/log — registrar evento de reproducción (auditoría). */
data class WatermarkLogRequest(
    val mediaToken: String,
    val videoId: String,
    val deviceId: String,
    val timestamp: Long,
    val deviceModel: String? = null,
    val buildFingerprint: String? = null,
    val osVersion: String? = null,
    val cpuCores: Int? = null
)

/** Respuesta de watermark/log. */
data class WatermarkLogResponse(
    val ok: Boolean = false,
    // El servidor responde {success:true}; sin leer este campo el registro se
    // guardaba bien pero la app anotaba un aviso de error que no existia.
    val success: Boolean = false,
    val error: String? = null
) {
    val registrado: Boolean get() = ok || success
}

// ════════════════════════════════════════════════════════════════════════════
// ESTADO Y VERSIÓN
// ════════════════════════════════════════════════════════════════════════════

/** Respuesta genérica `{ ok, ... }` usada por varios endpoints. */
data class GenericResponse(
    val ok: Boolean? = null,
    val status: String? = null,
    val message: String? = null,
    val error: String? = null
)

/** GET /api/player/version — versión mínima requerida + enlaces de descarga. */
data class PlayerVersionResponse(
    val minVersion: String? = null,
    val latestVersion: String? = null,
    val downloadUrl: String? = null,
    val message: String? = null,
    val downloads: Map<String, String>? = null
)

// ════════════════════════════════════════════════════════════════════════════
// SESIÓN Y PROGRESO
// ════════════════════════════════════════════════════════════════════════════

/** POST /api/device/checkin — registrar apertura de la app. */
data class DeviceCheckinRequest(
    val deviceId: String,
    val hostname: String? = null,
    val platform: String? = null,
    val arch: String? = null,
    val cpus: Int? = null,
    val totalmem: Long? = null,
    val deviceModel: String? = null,
    val osRelease: String? = null,
    val appVersion: String? = null
)

/** POST /api/playback/progress — progreso de reproducción. */
data class ProgressRequest(
    val videoId: String,
    val progressPercent: Int,
    val currentTime: Int,
    val sessionId: String? = null,
    val courseId: String? = null
)

/** POST /api/session/heartbeat — mantener sesión activa. */
data class HeartbeatRequest(
    val sessionId: String,
    val mediaToken: String,
    val currentTime: Int,
    val deviceId: String? = null
)

/** Respuesta de heartbeat. */
data class HeartbeatResponse(
    val ok: Boolean? = null,
    val revoked: Boolean? = null,
    val reason: String? = null,
    val error: String? = null
)

// ════════════════════════════════════════════════════════════════════════════
// LICENCIAS
// ════════════════════════════════════════════════════════════════════════════

/** POST /api/license/activate — activar una clave de licencia. */
data class LicenseActivateRequest(
    val licenseKey: String,
    val deviceId: String,
    val appVersion: String? = null
)

/** Respuesta de license/activate. */
data class LicenseActivateResponse(
    val token: String? = null,
    val activationId: String? = null,
    val activationToken: String? = null,
    val licenseId: String? = null,
    val studentId: String? = null,
    val courseId: String? = null,
    val expiresAt: String? = null,
    val code: String? = null,
    val error: String? = null
)

/** POST /api/session/activate-license — activar licencia en la sesión. */
data class SessionActivateLicenseRequest(
    val licenseKey: String,
    val deviceId: String? = null
)

/** Respuesta de session/activate-license. */
data class SessionActivateLicenseResponse(
    val status: String? = null,
    val token: String? = null,
    val activationToken: String? = null,
    val activationId: String? = null,
    val producerId: String? = null,
    val sid: String? = null,
    val hasLicense: Boolean? = null,
    val licenseId: String? = null,
    val courseId: String? = null,
    val allowedVideos: List<String>? = null,
    val error: String? = null,
    val code: String? = null
)

/** POST /api/license/validate-activation — validar activación local. */
data class ValidateActivationRequest(
    val activationToken: String,
    val deviceId: String,
    val videoId: String? = null
)

/** Respuesta de license/validate-activation. */
data class ValidateActivationResponse(
    val valid: Boolean? = null,
    val studentId: String? = null,
    val licenseId: String? = null,
    val courseId: String? = null,
    val code: String? = null,
    val error: String? = null
)

// ════════════════════════════════════════════════════════════════════════════
// REPRODUCCIÓN POR ENLACE cdp://
// ════════════════════════════════════════════════════════════════════════════

/** GET /api/playback/t/{token} — canje de short-token → { cmd, auth }. */
data class RedeemTokenResponse(
    val cmd: String? = null,
    val auth: String? = null,
    val code: String? = null,
    val error: String? = null
)

/** POST /api/playback/resolve — comando cifrado (cdp://play?t= / cmd=). */
data class ResolveCommandRequest(
    val command: String
)

/** POST /api/playback/resolve-perm — enlace permanente (cdp://play?p=). */
data class ResolvePermRequest(
    val perm: String,
    val deviceId: String
)

/** Respuesta de resolve / resolve-perm (Bunny HLS o VdoCipher). */
data class ResolveResponse(
    val sourceType: String? = null,
    val manifestUrl: String? = null,
    val directUrl: String? = null,
    val mediaToken: String? = null,
    val sessionToken: String? = null,
    val watermarkText: String? = null,
    val videoId: String? = null,
    val sessionId: String? = null,
    val studentCode: String? = null,
    val otp: String? = null,
    val playbackInfo: String? = null,
    val ttl: Long? = null,
    val courseId: String? = null,
    /** Identificador del contenedor .edu cuando la clase esta protegida asi. */
    val eduContentId: String? = null,
    val watermarkConfig: com.google.gson.JsonElement? = null,
    val error: String? = null,
    /** DRM opcional (mismo contrato que PlayUrlResponse). */
    val drmScheme: String? = null,
    val drmLicenseUrl: String? = null
)

/** POST /api/auth/logout — cierra la sesión de contenido en el servidor (conserva licencia y dispositivo). */
data class LogoutRequest(val deviceId: String? = null)


/** POST /api/edu/key — el servidor re-deriva la clave del contenedor por sesion. */
data class EduKeyRequest(
    val contentId: String
)

/**
 * Clave de contenido .edu. Vive solo en memoria mientras dura la reproduccion:
 * no se guarda en disco ni en preferencias. Sin ella el archivo descargado no
 * es mas que ruido.
 */
data class EduKeyResponse(
    val cek: String? = null,
    val contentId: String? = null,
    val salt: String? = null,
    val title: String? = null,
    val watermark: String? = null,
    val chunkSize: Int? = null,
    val error: String? = null
)
