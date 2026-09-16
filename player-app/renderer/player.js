'use strict';
// ─── Campus Digital Player — Renderer Process ────────────────────────────────
// Requiere: window.vcbPlayer (expuesto por preload.js via contextBridge)
//           Hls (cargado desde node_modules/hls.js)

(function () {

// ── Estado global ─────────────────────────────────────────────────────────────
const STATE = {
    apiBase:       '',
    auth:          '',       // JWT del alumno (playerToken)
    mediaToken:    '',       // token de sesión por video (resolve-perm); NO reemplaza el JWT de login
    linkAuth:      '',
    playGeneration: 0,
    cmd:           '',       // comando cifrado (cdp://eyJ...)
    sessionId:     '',
    videoId:       '',
    studentCode:   '',
    studentEmail:  '',
    watermarkText: '',
    deviceId:      '',       // ID estable del dispositivo
    appVersion:    '',       // versión del reproductor
    isLoggedIn:    false,    // true solo después de que el usuario completó el login
    hls:           null,
    heartbeatTimer: null,
    wmTimer:        null,
    wmCourseId:     '__default__',   // curso para el canal SSE de watermark en vivo
    wmPos:          0,
    lastProgress:   0,
    lastProgressSent: 0,
    tokenExpAt:    0,        // epoch ms de expiración del JWT
};

// ── Referencias DOM ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const splash      = $('splash');
const playerArea  = $('player-area');
const video       = $('video');
const spinner     = $('spinner');
const overlay     = $('overlay');
const overlayTitle= $('overlay-title');
const overlayMsg  = $('overlay-msg');
const overlayRetry= $('overlay-retry');
const watermark   = $('watermark');
const btnPlay     = $('btn-play');
const btnMute     = $('btn-mute');
const btnFullscreen = $('btn-fullscreen');
const progressBar = $('progress-bar');
const progressWrap= $('progress-wrap');
const volSlider   = $('vol-slider');
const timeDisplay = $('time-display');
const qualitySelect = $('quality-select');
const speedSelect = $('speed-select');
const speedCustom = $('speed-custom');
const deviceBadge = $('device-badge');
const btnLogout   = $('btn-logout');

// ── Auto-fade del botón cerrar sesión (invisible tras 3s sin mover el ratón) ───────
let _logoutFadeTimer = null;
function _showLogoutBtn() {
    if (!btnLogout) return;
    btnLogout.classList.add('logout-visible');
    clearTimeout(_logoutFadeTimer);
    _logoutFadeTimer = setTimeout(() => {
        btnLogout.classList.remove('logout-visible');
    }, 3000);
}
document.addEventListener('mousemove', _showLogoutBtn);
document.addEventListener('mousedown', _showLogoutBtn);
document.addEventListener('touchstart', _showLogoutBtn);
if (btnLogout) {
    btnLogout.addEventListener('click', () => {
        stopPlayback();
        STATE.isLoggedIn = false;
        if (window.vcbPlayer?.logout) window.vcbPlayer.logout();
    });
}

// ── Inicialización ────────────────────────────────────────────────────────────
async function init() {
    // ── Integridad de runtime: detectar hooking por Frida u otras herramientas ──
    const runtimeSafe = (function detectRuntimeHooking() {
        const nativeChecks = [
            [window.fetch,                           'fetch'],
            [window.XMLHttpRequest.prototype.open,   'XHR.open'],
            [window.crypto.subtle && window.crypto.subtle.encrypt, 'crypto.encrypt'],
            [performance.now,                        'performance.now'],
        ];
        for (const [fn, name] of nativeChecks) {
            if (!fn) continue;
            const s = Function.prototype.toString.call(fn);
            if (!s.includes('[native code]')) {
                console.error('[VCB-SECURITY] Runtime hook detectado en:', name);
                window.vcbPlayer?.logout?.();
                return false;
            }
        }
        // Detección de depurador por timing (pausa del debugger statement)
        const _t0 = performance.now();
        // eslint-disable-next-line no-debugger
        debugger;
        if (performance.now() - _t0 > 150) {
            console.error('[VCB-SECURITY] Depurador activo detectado');
            window.vcbPlayer?.logout?.();
            return false;
        }
        return true;
    })();
    if (!runtimeSafe) return;

    const cfg = await window.vcbPlayer.getConfig();
    STATE.apiBase = cfg.apiBase;
    $('splash-version').textContent = cfg.version;

    // Mostrar info del dispositivo en badge
    const di = await window.vcbPlayer.getDeviceInfo();
    deviceBadge.textContent = `${di.username}@${di.hostname} · ${di.platform}`;
    STATE.deviceId   = di.deviceId   || '';
    STATE.appVersion = di.appVersion || '';

    // Confirmar que el usuario está autenticado
    STATE.isLoggedIn = false;

    // Cargar token del servidor desde sesión guardada en disco
    // Necesario para que resolve-perm y otros endpoints autenticados funcionen
    // sin pasar antes por un cdp:// link con auth=
    try {
        const session = await window.vcbPlayer.getSession();
        if (session && session.token) { STATE.auth = session.token; STATE.isLoggedIn = true; }
        if (session && session.email) STATE.studentEmail = session.email;
    } catch { /* no bloquear el arranque */ }

    // Mostrar botón cerrar sesión
    document.body.classList.add('player-active');

    // Enviar checkin de startup: registra en el servidor que el app fue abierto
    // Usa el token de sesión guardado en disco (del login de Firebase)
    sendStartupCheckin(di).catch(() => {});

    // Escuchar comandos cdp:// que lleguen mientras el reproductor está abierto
    window.vcbPlayer.onPlay(handleCdpPlay);
    window.vcbPlayer.onStopPlayback?.(() => { STATE.isLoggedIn = false; stopPlayback(); });

    // ── Seguridad: bloquear/reanudar reproducción por amenaza externa ─────────
    window.vcbPlayer.onSecurityBlocked((data) => {
        stopPlayback();
        showOverlay('🔒', data.title || 'Reproducción suspendida',
            (data.detail || 'Cierra la aplicación detectada.') + '\nAbre de nuevo tu enlace cuando puedas continuar.');
    });
    window.vcbPlayer.onSecurityCleared(() => { /* Reopen an authorized link to resume. */ });

    // Botones de UI
    overlayRetry.addEventListener('click', resetToSplash);
    btnPlay.addEventListener('click', togglePlay);
    btnMute.addEventListener('click', toggleMute);
    btnFullscreen.addEventListener('click', toggleFullscreen);
    volSlider.addEventListener('input', () => { video.volume = +volSlider.value; });
    progressWrap.addEventListener('click', seekTo);
    qualitySelect.addEventListener('change', changeQuality);
    speedSelect.addEventListener('change', onSpeedSelect);
    speedCustom.addEventListener('change', applyCustomSpeed);
    speedCustom.addEventListener('input',  applyCustomSpeed);
    video.addEventListener('loadeddata', () => { try { video.playbackRate = STATE.speed || 1; } catch {} });
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('waiting',  () => showSpinner(true));
    video.addEventListener('playing',  () => showSpinner(false));
    video.addEventListener('ended',    onVideoEnded);
    video.addEventListener('error',    onVideoError);

    // Actualizar icono del botón según el estado de pantalla completa (Electron nativo)
    if (window.vcbPlayer && typeof window.vcbPlayer.onFullscreenChanged === 'function') {
        window.vcbPlayer.onFullscreenChanged((isFs) => {
            btnFullscreen.textContent = isFs ? '🗗' : '⛶';
            btnFullscreen.title = isFs ? 'Salir de pantalla completa' : 'Pantalla completa';
        });
    }

    // Atajos de teclado: F11 alterna pantalla completa; ESC sale de ella.
    document.addEventListener('keydown', async (e) => {
        if (e.key === 'F11') {
            e.preventDefault();
            toggleFullscreen();
        } else if (e.key === 'Escape') {
            try {
                if (window.vcbPlayer?.isFullscreen && await window.vcbPlayer.isFullscreen()) {
                    window.vcbPlayer.toggleFullscreen();
                }
            } catch { /* noop */ }
        }
    });

    // Bloquear menú contextual en el video
    video.addEventListener('contextmenu', e => e.preventDefault());
}

// ── Startup checkin — notifica al servidor que el app fue abierto ─────────────
async function sendStartupCheckin(di) {
    try {
        const session = await window.vcbPlayer.getSession();
        if (!session || !session.token) return; // sin sesión guardada
        const base = (STATE.apiBase || '').replace(/\/$/, '');
        const resp = await fetch(base + '/api/device/checkin', {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${session.token}`,
            },
            body: JSON.stringify({
                deviceId:    di.deviceId    || '',
                hostname:    di.hostname    || '',
                platform:    di.platform    || '',
                arch:        di.arch        || '',
                cpus:        di.cpus        || 0,
                totalmem:    di.totalmem    || 0,
                deviceModel: di.deviceModel || '',
                osRelease:   di.osRelease   || '',
                appVersion:  di.appVersion  || '',
            }),
        });
        if (!resp.ok) console.warn('[VCB] startup checkin rechazado por servidor:', resp.status);
    } catch (err) { console.warn('[VCB] startup checkin falló:', err.message); }
}

// ── Canjear short-token por {cmd, auth} ──────────────────────────────────────
async function redeemShortToken(t) {
    const ts  = Date.now().toString();
    const sig = window.vcbPlayer?.computeAppSig
        ? await window.vcbPlayer.computeAppSig(t + ':' + ts)
        : '';
    const res = await fetch(`${STATE.apiBase}/api/playback/t/${encodeURIComponent(t)}?deviceId=${encodeURIComponent(STATE.deviceId)}`, {
        headers: { 'X-CDP-Ts': ts, 'X-CDP-Sig': sig },
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Token de acceso inválido o expirado.');
    }
    return res.json(); // { cmd, auth }
}

// ── Resolver enlace permanente cifrado ─────────────────────────────────────────
async function resolvePermanentLink(p) {
    const res = await apiFetch('/api/playback/resolve-perm', 'POST', { perm: p, deviceId: STATE.deviceId || '' });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { code: body.code });
    }
    return res.json(); // { manifestUrl, watermarkText, videoId, sessionId, sessionToken }
}

// ── Manejo del comando cdp:// ─────────────────────────────────────────────────
async function handleCdpPlay({ cmd, auth, t, p }) {
    // SEGURIDAD: rechazar reproducción si el usuario no inició sesión
    if (!STATE.isLoggedIn) {
        console.warn('[VCB] cdp-play recibido antes de login — ignorado');
        return;
    }

    if (!STATE.apiBase) {
        showOverlay('⚙️', 'Servidor no configurado', 'Configura la URL del servidor en la pantalla de inicio.');
        return;
    }

    stopPlayback();
    hideOverlay();
    const generation = STATE.playGeneration;

    // Enlace permanente autenticado y autorizado por el servidor
    if (p) {
        showSplash(false);
        showPlayerArea(true);
        showSpinner(true);
        try {
            const data = await resolvePermanentLink(p);
            if (generation !== STATE.playGeneration) return;
            STATE.watermarkText = data.watermarkText || '';
            STATE.videoId       = data.videoId || '';
            STATE.sessionId     = data.sessionId || '';
            // NO sobreescribir STATE.auth (JWT de login) con el sessionToken de este
            // video: STATE.auth debe permanecer estable para poder resolver el
            // siguiente enlace permanente al cambiar de video sin cerrar el reproductor.
            // El sessionToken es solo para heartbeat/segmentos de ESTE video.
            STATE.mediaToken    = data.sessionToken || '';
            // Config inicial del tamaño en tiempo real (por SO) para enlaces permanentes.
            if (data.watermarkConfig) _wmConfig = data.watermarkConfig[_WM_OS_KEY] || data.watermarkConfig;
            STATE.wmCourseId    = data.courseId || STATE.wmCourseId || '__default__';
            // Decodificar exp del sessionToken para heartbeat
            if (data.sessionToken) {
                try {
                    const pl = JSON.parse(atob(data.sessionToken.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
                    STATE.tokenExpAt = (pl.exp || 0) * 1000;
                } catch { STATE.tokenExpAt = Date.now() + 6 * 3600 * 1000; }
            }
            startWatermark();
            startHeartbeat();
            if (data.sourceType === 'edu') {
                await startEdu(data.eduContentId || data.contentId);
            } else if (data.sourceType === 'vdocipher') {
                await startVdoCipher(data.otp, data.playbackInfo);
            } else if (data.sourceType === 'vdocipher_direct') {
                await startVdoCipherDirect(data.directUrl);
            } else {
                await startHls(data.manifestUrl, STATE.mediaToken);
            }
        } catch (err) {
            if (generation !== STATE.playGeneration) return;
            if (err.code === 'LICENSE_REQUIRED') { window.vcbPlayer.requestLicense(); return; }
            showOverlay('🔒', 'Enlace inválido', err.message || 'No se pudo iniciar la reproducción.');
        }
        return;
    }

    // Si viene short-token, canjearlo por cmd+auth antes de continuar
    if (t) {
        showSplash(false);
        showPlayerArea(true);
        showSpinner(true);
        try {
            const redeemed = await redeemShortToken(t);
            if (generation !== STATE.playGeneration) return;
            cmd  = redeemed.cmd;
            auth = redeemed.auth;
        } catch (err) {
            if (generation !== STATE.playGeneration) return;
            showOverlay('🔒', 'Token inválido', err.message || 'No se pudo validar el link de acceso.');
            return;
        }
    }

    if (!cmd || !auth) {
        showOverlay('⚠️', 'Comando inválido', 'El enlace cdp:// recibido no contiene los datos necesarios.');
        return;
    }

    STATE.cmd  = cmd;
    STATE.linkAuth = auth;

    // Decodificar el JWT localmente para saber expiración (sin verificar firma)
    try {
        const payload = JSON.parse(atob(auth.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        STATE.tokenExpAt = (payload.exp || 0) * 1000;
    } catch { STATE.tokenExpAt = Date.now() + 15 * 60 * 1000; }

    if (!t) { // si vino de t=, ya mostramos la UI arriba
        showSplash(false);
        showPlayerArea(true);
        showSpinner(true);
    }

    try {
        await resolveAndPlay(generation);
    } catch (err) {
        if (generation !== STATE.playGeneration) return;
        if (err.code === 'LICENSE_REQUIRED') { window.vcbPlayer.requestLicense(); return; }
        console.error('[VCB] Error al resolver comando:', err);
        showOverlay('🔒', 'Error de acceso', err.message || 'No se pudo iniciar la reproducción.');
    }
}

// ── Resolver el comando en el servidor y reproducir ───────────────────────────
async function resolveAndPlay(generation = STATE.playGeneration) {
    const res = await apiFetch('/api/playback/resolve', 'POST', {
        command: STATE.cmd,
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { code: body.code });
    }

    const data = await res.json();
    if (generation !== STATE.playGeneration) return;
    // data: { sourceType, manifestUrl?, mediaToken, watermarkText, studentCode, ttl, sessionId }
    //       sourceType: 'bunny' | 'vdocipher'

    STATE.sessionId    = data.sessionId    || STATE.sessionId;
    STATE.watermarkText= data.watermarkText|| '';
    STATE.studentCode  = data.studentCode  || '';
    STATE.videoId      = data.videoId      || '';
    const mediaToken   = data.mediaToken || data.sessionToken || STATE.linkAuth;
    STATE.mediaToken = mediaToken;
    try { STATE.tokenExpAt = JSON.parse(atob(mediaToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000 || 0; } catch { STATE.tokenExpAt = 0; }

    // Config inicial del tamaño de píxeles en tiempo real (por SO). El canal SSE
    // luego empuja cualquier cambio del admin sin recargar.
    if (data.watermarkConfig) _wmConfig = data.watermarkConfig[_WM_OS_KEY] || data.watermarkConfig;
    STATE.wmCourseId   = data.courseId || STATE.wmCourseId || '__default__';

    showPlayerArea(true);
    showSpinner(true);
    startWatermark();
    startHeartbeat();

    if (data.sourceType === 'edu') {
        await startEdu(data.eduContentId || data.contentId);
        return;
    }
    if (data.sourceType === 'vdocipher') {
        await startVdoCipher(data.otp, data.playbackInfo);
        return;
    }
    if (data.sourceType === 'vdocipher_direct') {
        await startVdoCipherDirect(data.directUrl);
        return;
    }

    const manifestUrl  = data.manifestUrl;
    if (!manifestUrl) throw new Error('El servidor no devolvió la URL del manifiesto.');

    await startHls(manifestUrl, mediaToken);
}

// ── SecureLoader — decodifica el wrapper JSON {"d":"base64..."} del manifest ──
class SecureLoader {
    constructor(config) { this._inner = new Hls.DefaultConfig.loader(config); }
    get stats() { return this._inner.stats; }
    destroy() { this._inner.destroy(); }
    abort()   { this._inner.abort();   }
    load(context, config, callbacks) {
        const origSuccess = callbacks.onSuccess;
        this._inner.load(context, config, {
            ...callbacks,
            onSuccess(response, stats, ctx, net) {
                if (typeof response.data === 'string') {
                    try {
                        const j = JSON.parse(response.data);
                        if (j && j.d) {
                            response.data = atob(j.d.replace(/-/g, '+').replace(/_/g, '/'));
                        }
                    } catch {}
                }
                origSuccess(response, stats, ctx, net);
            }
        });
    }
}

// ── VdoCipher embed player ────────────────────────────────────────────────────
async function startVdoCipher(otp, playbackInfo) {
    stopHls();

    const video = document.getElementById('video');
    if (video) video.style.display = 'none';

    const controls = document.getElementById('controls');
    if (controls) controls.style.display = 'none';

    let vdoFrame = document.getElementById('vdo-frame');
    if (!vdoFrame) {
        // Usar <webview> en vez de <iframe> — tiene acceso nativo a plugins (Widevine CDM)
        vdoFrame = document.createElement('webview');
        vdoFrame.id = 'vdo-frame';
        vdoFrame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:none;z-index:10;background:#000;';
        // Popups are unnecessary for playback.
        vdoFrame.setAttribute('plugins', '');
        vdoFrame.setAttribute('allowfullscreen', '');
        vdoFrame.setAttribute('partition', 'persist:vdo');
        vdoFrame.setAttribute('webpreferences', 'plugins, contextIsolation=true, nodeIntegration=false');
        vdoFrame.setAttribute('useragent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
        const playerArea = document.getElementById('player-area');
        if (playerArea) playerArea.appendChild(vdoFrame);
    }

    const embedUrl = `https://player.vdocipher.com/v2/?otp=${encodeURIComponent(otp)}&playbackInfo=${encodeURIComponent(playbackInfo)}&primaryColor=%238b5cf6`;

    // FIX Error 2014 (VdoCipher domain verification):
    // Cargar el embed a través del servidor backend en lugar de directamente.
    // Así VdoCipher ve el dominio del servidor (en su whitelist) en vez de file:// (Electron).
    // Si no hay API base configurada, caer al embed directo como fallback.
    const token = STATE.mediaToken || STATE.auth || '';
    const proxyUrl = STATE.apiBase
        ? `${STATE.apiBase}/api/vdo-player?otp=${encodeURIComponent(otp)}&playbackInfo=${encodeURIComponent(playbackInfo)}&token=${encodeURIComponent(token)}`
        : embedUrl;

    // Listeners de error del webview (se registran solo una vez)
    if (!vdoFrame._listenersAdded) {
        vdoFrame._listenersAdded = true;

        // ── Ciclo de vida de carga ──────────────────────────────────────────
        vdoFrame.addEventListener('did-start-loading', () => {
            console.log('[VDO] >>> Iniciando carga del webview...');
        });

        vdoFrame.addEventListener('did-stop-loading', () => {
            console.log('[VDO] >>> Carga detenida (did-stop-loading)');
        });

        vdoFrame.addEventListener('did-finish-load', () => {
            console.log('[VDO] >>> Página cargada correctamente (did-finish-load)');
            // Abrir DevTools del webview para inspección

        });

        // Error de carga de la página del webview
        vdoFrame.addEventListener('did-fail-load', (e) => {
            if (e.errorCode === -3) return; // -3 = abortado al cambiar src, ignorar
            console.error('[VDO] did-fail-load:', e.errorCode);
            showOverlay('📡', 'Error al cargar VdoCipher',
                `Código ${e.errorCode}: ${e.errorDescription || 'No se pudo cargar el reproductor.'}`);
        });

        // Mensajes de consola dentro del webview (TODOS para diagnóstico)
        vdoFrame.addEventListener('console-message', (e) => {
            const levels = ['LOG', 'WARN', 'ERR', 'DBG'];
            const lvlStr = levels[e.level] || e.level;

            // Detectar Error 2014 de VdoCipher por mensaje de consola
            if (e.message && e.message.includes('2014')) {
                showOverlay('🔒', 'Error 2014 - Dominio no verificado',
                    'El dominio del servidor no está en la whitelist de VdoCipher.\n' +
                    'Ve a VdoCipher → Security → URL Whitelist y agrega:\n' +
                    STATE.apiBase.replace(/^https?:\/\//, '').split('/')[0]);
            }
        });

        // Respuesta HTTP de la página del webview
        vdoFrame.addEventListener('did-get-response-details', (e) => {
            console.log('[VDO] HTTP status:', e.httpResponseCode);
        });

        // Fallo en la carga del proceso del webview
        vdoFrame.addEventListener('crashed', () => {
            console.error('[VDO] webview CRASHED');
            showOverlay('💥', 'Error interno', 'El reproductor VdoCipher falló inesperadamente.');
        });

        vdoFrame.addEventListener('render-process-gone', (e) => {
            console.error('[VDO] render-process-gone:', JSON.stringify(e));
        });
    }


    vdoFrame.setAttribute('src', proxyUrl);
    vdoFrame.style.display = 'block';

    showSpinner(false);
}

function stopVdoCipher() {
    const vdoFrame = document.getElementById('vdo-frame');
    if (vdoFrame) {
        vdoFrame.setAttribute('src', 'about:blank');
        vdoFrame.remove();
    }
    const video = document.getElementById('video');
    if (video) video.style.display = '';
    const controls = document.getElementById('controls');
    if (controls) controls.style.display = '';
}

// ── VdoCipher link directo (video de cualquier cuenta) ────────────────────────
// Carga la URL directamente en el webview sin pasar por el proxy del servidor.
// Al no haber Referer de nuestro dominio, VdoCipher no aplica restricción de whitelist.
async function startVdoCipherDirect(directUrl) {
    stopHls();

    const video = document.getElementById('video');
    if (video) video.style.display = 'none';
    const controls = document.getElementById('controls');
    if (controls) controls.style.display = 'none';

    let vdoFrame = document.getElementById('vdo-frame');
    if (!vdoFrame) {
        vdoFrame = document.createElement('webview');
        vdoFrame.id = 'vdo-frame';
        // position:fixed para cubrir toda la ventana sin depender del flex padre
        vdoFrame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:none;z-index:10;background:#000;';
        // Popups are unnecessary for playback.
        vdoFrame.setAttribute('plugins', '');
        vdoFrame.setAttribute('allowfullscreen', '');
        // partition persist para que Widevine CDM quede registrado entre sesiones
        vdoFrame.setAttribute('partition', 'persist:vdo');
        vdoFrame.setAttribute('webpreferences', 'plugins, contextIsolation=true, nodeIntegration=false');
        // User-agent sin "Electron" — VdoCipher bloquea reproducción si detecta Electron en el UA
        vdoFrame.setAttribute('useragent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
        const playerArea = document.getElementById('player-area');
        if (playerArea) playerArea.appendChild(vdoFrame);
    }

    if (!vdoFrame._listenersAdded) {
        vdoFrame._listenersAdded = true;
        vdoFrame.addEventListener('did-start-loading', () => console.log('[VDO-DIRECT] Cargando...'));
        vdoFrame.addEventListener('did-finish-load',   () => {
            console.log('[VDO-DIRECT] Cargado OK');

        });
        vdoFrame.addEventListener('did-fail-load', (e) => {
            if (e.errorCode === -3) return;
            console.error('[VDO-DIRECT] did-fail-load:', e.errorCode, e.errorDescription);
            showOverlay('📡', 'Error al cargar el video', `Código ${e.errorCode}: ${e.errorDescription}`);
        });
        vdoFrame.addEventListener('console-message', (e) => {

            if (e.message && e.message.includes('2014')) {
                showOverlay('🔒', 'Error 2014', 'El OTP de este link ya expiró. Pide un link actualizado.');
            }
        });
        vdoFrame.addEventListener('crashed', () => {
            console.error('[VDO-DIRECT] crashed');
            showOverlay('💥', 'Error interno', 'El reproductor VdoCipher falló.');
        });
    }


    vdoFrame.setAttribute('src', directUrl);
    vdoFrame.style.display = 'block';
    showSpinner(false);
}

// ── HLS.js ────────────────────────────────────────────────────────────────────
// ── Reproducción de contenido protegido .edu (modelo InfoProtector) ───────────
// Descarga + descifra localmente en el proceso principal y reproduce vía edu://.
async function startEdu(contentId) {
    if (!contentId) throw new Error('Contenido protegido no especificado');
    stopHls();
    stopVdoCipher();
    const generation = STATE.playGeneration;
    try {
        if (STATE._eduId && STATE._eduId !== contentId && window.vcbPlayer.eduClose) {
            await window.vcbPlayer.eduClose(STATE._eduId);
        }
    } catch {}
    showSpinner(true);
    const r = await window.vcbPlayer.eduOpen({ contentId, deviceId: STATE.deviceId || '', mediaToken: STATE.mediaToken });
    if (generation !== STATE.playGeneration) return;
    if (!r || !r.ok) throw Object.assign(new Error((r && r.error) || 'No se pudo abrir el contenido protegido'), { code: r?.code });
    if (r.watermark) STATE.watermarkText = r.watermark;
    STATE._eduId  = contentId;
    STATE.videoId = STATE.videoId || contentId;
    video.src = r.url;
    video.addEventListener('canplay', () => showSpinner(false), { once: true });
    startWatermark();
    try { await video.play(); } catch {}
}

async function startHls(manifestUrl, mediaToken) {
    stopHls();
    stopVdoCipher();

    // Cabecera de autenticación para segmentos HLS
    // NOTA: solo añadir si hay token real. Si no hay token (enlace permanente),
    // NO añadir Authorization — causaría CORS preflight que el servidor rechaza
    // desde origen file:// (Electron). El token de guest va embebido en la URL.
    const xhrSetup = (xhr, url) => {
        const authToken = STATE.mediaToken || STATE.auth;
        if (authToken && (url.includes('/api/r/') || url.includes('/api/b/') || url.includes('/api/drm/'))) {
            xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
            if (mediaToken) xhr.setRequestHeader('X-Media-Token', mediaToken);
        }
    };

    if (typeof Hls === 'undefined') {
        // Fallback: reproducción nativa (Safari / formatos soportados)
        video.src = manifestUrl;
        video.play().catch(() => {});
        showSpinner(false);
        return;
    }

    if (Hls.isSupported()) {
        STATE.hls = new Hls({
            loader: SecureLoader,
            xhrSetup,
            debug: false,
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 90,
        });

        STATE.hls.loadSource(manifestUrl);
        STATE.hls.attachMedia(video);

        STATE.hls.on(Hls.Events.MANIFEST_PARSED, (_evt, d) => {
            populateQualityMenu(d.levels);
            showSpinner(false);
            video.play().catch(() => {});
        });

        let networkRetries = 0;
        STATE.hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        if (networkRetries < 3) {
                            networkRetries++;
                            STATE.hls.startLoad();
                        } else {
                            stopHls();
                            showOverlay('📡', 'Error de red', 'No se pudo cargar el video. Verifica tu conexión e intenta de nuevo.');
                        }
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        STATE.hls.recoverMediaError();
                        break;
                    default:
                        stopHls();
                        showOverlay('📡', 'Error de reproducción', 'No se pudo cargar el video. Comprueba tu conexión.');
                }
            }
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari nativo
        video.src = manifestUrl;
        video.play().catch(() => {});
        showSpinner(false);
    } else {
        throw new Error('Tu dispositivo no soporta reproducción HLS.');
    }
}

function stopHls() {
    if (STATE.hls) {
        STATE.hls.destroy();
        STATE.hls = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
    qualitySelect.innerHTML = '';
}

function populateQualityMenu(levels) {
    qualitySelect.innerHTML = '<option value="-1">Auto</option>';
    levels.forEach((lvl, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = lvl.height ? `${lvl.height}p` : `Nivel ${i + 1}`;
        qualitySelect.appendChild(opt);
    });
}

function changeQuality() {
    if (!STATE.hls) return;
    STATE.hls.currentLevel = +qualitySelect.value;
}

// ── Velocidad de reproducción (0.5x–3x + personalizada) ───────────────────
function setSpeed(rate) {
    if (!isFinite(rate) || rate <= 0) rate = 1;
    rate = Math.min(4, Math.max(0.25, rate));
    STATE.speed = rate;
    try { video.playbackRate = rate; } catch {}
}
function onSpeedSelect() {
    if (speedSelect.value === 'custom') {
        speedCustom.style.display = '';
        speedCustom.focus();
        applyCustomSpeed();
        return;
    }
    speedCustom.style.display = 'none';
    setSpeed(parseFloat(speedSelect.value));
}
function applyCustomSpeed() {
    const v = parseFloat(speedCustom.value);
    if (!isFinite(v)) return;
    setSpeed(v);
}

// ── Controles de video ────────────────────────────────────────────────────────
function togglePlay() {
    if (video.paused) { video.play(); btnPlay.textContent = '⏸'; }
    else              { video.pause(); btnPlay.textContent = '▶'; }
}

function toggleMute() {
    video.muted = !video.muted;
    btnMute.textContent = video.muted ? '🔇' : '🔊';
}

function toggleFullscreen() {
    // Preferir el fullscreen nativo de Electron (fiable con contentProtection).
    if (window.vcbPlayer && typeof window.vcbPlayer.toggleFullscreen === 'function') {
        window.vcbPlayer.toggleFullscreen();
        return;
    }
    // Fallback: API HTML5 (navegador/dev)
    if (!document.fullscreenElement) {
        playerArea.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen().catch(() => {});
    }
}

function seekTo(e) {
    if (!video.duration) return;
    const rect = progressWrap.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    video.currentTime = ratio * video.duration;
}

function onTimeUpdate() {
    if (!video.duration) return;

    const pct = video.currentTime / video.duration;
    progressBar.style.width = (pct * 100).toFixed(2) + '%';
    timeDisplay.textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(video.duration);
    btnPlay.textContent = video.paused ? '▶' : '⏸';

    STATE.lastProgress = Math.round(pct * 100);

    // Enviar progreso cada 30s
    const now = Date.now();
    if (now - STATE.lastProgressSent > 30_000) {
        STATE.lastProgressSent = now;
        sendProgress();
    }
}

function onVideoEnded() {
    STATE.lastProgress = 100;
    sendProgress();
    btnPlay.textContent = '▶';
}

function onVideoError() {
    if (!video.getAttribute('src') && !STATE.hls) return;
    // Ignorar si VdoCipher está activo — stopHls() hace video.src='' que dispara este evento espuriamente
    const vdoFrame = document.getElementById('vdo-frame');
    const vdoSrc = vdoFrame?.getAttribute('src') || '';
    if (vdoFrame && vdoFrame.style.display !== 'none' && vdoSrc && !vdoSrc.startsWith('about:')) return;
    showOverlay('⚠️', 'Error de reproducción', 'No se pudo reproducir el video. Intenta de nuevo.');
}

function fmtTime(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
    return `${m}:${pad(sec)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

// ── Progreso ──────────────────────────────────────────────────────────────────
async function sendProgress() {
    if (!STATE.sessionId || !STATE.auth) return;
    try {
        await apiFetch('/api/playback/progress', 'POST', {
            videoId:         STATE.videoId,
            progressPercent: STATE.lastProgress,
            currentTime:     Math.floor(video.currentTime || 0),
            sessionId:       STATE.sessionId,
        });
    } catch { /* silencioso — no interrumpir reproducción */ }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
function startHeartbeat() {
    stopHeartbeat();
    STATE.heartbeatTimer = setInterval(async () => {
        if (!STATE.sessionId || !STATE.auth) return;

        // Comprobar expiración del token
        const margin = 2 * 60 * 1000; // 2 minutos antes
        if (STATE.tokenExpAt && Date.now() > STATE.tokenExpAt) {
            // Token próximo a expirar — no hay refresh en el reproductor externo;
            // el token ya no es renovable aquí (es un token especial de 15min).
            // Pausar y notificar al usuario.
            stopPlayback();
            showOverlay('⏱', 'Sesión expirada', 'El token de reproducción ha expirado. Por favor vuelve al campus y genera un nuevo enlace de reproducción.');
            stopHeartbeat();
            return;
        }

        try {
            const generation = STATE.playGeneration;
            const response = await apiFetch('/api/session/heartbeat', 'POST', {
                sessionId:   STATE.sessionId,
                mediaToken:  STATE.mediaToken || STATE.auth,
                currentTime: Math.floor(video.currentTime || 0),
                deviceId:    STATE.deviceId || '',
            });
            const result = await response.json().catch(() => ({}));
            if (generation === STATE.playGeneration && ([401, 403].includes(response.status) || result.revoked)) {
                stopPlayback();
                showOverlay('🔒', 'Reproducción detenida', result.reason || result.error || 'La sesión ya no está autorizada. Abre de nuevo tu enlace.');
            }
        } catch { /* network outage: server still authorizes each media request */ }
    }, 30_000);
}

function stopHeartbeat() {
    if (STATE.heartbeatTimer) {
        clearInterval(STATE.heartbeatTimer);
        STATE.heartbeatTimer = null;
    }
}

// ── Marca de agua ─────────────────────────────────────────────────────────────
// 4 watermarks INDEPENDIENTES: Correo, IP, Código CDP, Fecha y Hora.
// Cada uno se mueve LIBREMENTE por cualquier parte del reproductor (no a una
// esquina fija). La posición se calcula al azar dentro del área visible y se
// limita (clamp) para que el texto SIEMPRE quede completo, sin cortarse.
// El watermark del correo (rojo) usa una fuente más grande (35px); el resto 16px.
// El TAMAÑO EN PÍXELES, color y grosor pueden cambiarse EN TIEMPO REAL desde el
// panel admin: llegan por un canal SSE y se re-renderizan sin recargar el video.
const WM_DEFS = [
    { id: 'wm-email',    key: 'email',    rotateMs: 9000,  transSec: 6 },
    { id: 'wm-ip',       key: 'ip',       rotateMs: 13000, transSec: 8 },
    { id: 'wm-code',     key: 'code',     rotateMs: 7000,  transSec: 5 },
    { id: 'wm-datetime', key: 'datetime', rotateMs: 11000, transSec: 7 },
];

// Estilo por defecto de cada marca (se usa hasta que el backend envía config).
const _WM_DEFAULT = {
    email:    { on: true, size: 35, color: '#ff2d2d', weight: 700, alpha: 0.6  },
    ip:       { on: true, size: 16, color: '#ffffff', weight: 600, alpha: 0.22 },
    code:     { on: true, size: 16, color: '#ffffff', weight: 600, alpha: 0.22 },
    datetime: { on: true, size: 16, color: '#ffffff', weight: 600, alpha: 0.22 },
};
function getWmOsKey() {
    const procPlatform = (typeof window !== 'undefined' && window.process && window.process.platform) || '';
    if (procPlatform === 'darwin') return 'mac';
    if (procPlatform === 'linux') return 'linux';
    if (procPlatform === 'win32') return 'windows';
    const ua = String(typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '').toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) return 'ios';
    if (/android/.test(ua)) return 'android';
    if (/macintosh|mac os x|mac/.test(ua)) return 'mac';
    if (/linux/.test(ua)) return 'linux';
    if (/windows|win/.test(ua)) return 'windows';
    return 'windows';
}
const _WM_OS_KEY = getWmOsKey();
let   _wmConfig  = null;        // config resuelta del SO (llega del backend por SSE)
let   _wmSSE     = null;        // canal EventSource abierto

let _wmClientIp = null;
const _wmTimers = [];
const _wmEls    = [];
let _wmResizeHandler = null;

// Convierte #rrggbb + alpha en rgba(). Fallback: blanco translúcido.
function _wmHexToRgba(hex, alpha) {
    const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''));
    if (!m) return `rgba(255,255,255,${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Estilo aplicable de una marca: valores por defecto + override de la config en
// vivo. El tamaño se valida al rango 6–80 px (igual que el clamp del servidor).
function _wmMarkStyle(key) {
    const d = _WM_DEFAULT[key] || _WM_DEFAULT.datetime;
    if (!_wmConfig || typeof _wmConfig !== 'object') return Object.assign({}, d);
    if (_wmConfig.enabled === false) return Object.assign({}, d, { on: false });
    const m = _wmConfig[key];
    if (!m || typeof m !== 'object') return Object.assign({}, d);
    const size   = parseInt(m.size, 10);
    const weight = parseInt(m.weight, 10);
    return {
        on:     m.on !== false,
        size:   (Number.isFinite(size)   && size   >= 6   && size   <= 80)  ? size   : d.size,
        color:  (typeof m.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(m.color)) ? m.color : d.color,
        weight: (Number.isFinite(weight) && weight >= 100 && weight <= 900) ? weight : d.weight,
        alpha:  d.alpha,
    };
}

// Pinta UNA marca dentro del contenedor y programa su rotación de posición.
function _wmPaintOne(def, parent) {
    const st = _wmMarkStyle(def.key);
    let el = document.getElementById(def.id);
    if (!st.on) { if (el) { try { el.remove(); } catch {} } return; }
    if (!el) {
        el = document.createElement('div');
        el.id = def.id;
        parent.appendChild(el);
    }
    Object.assign(el.style, {
        position:      'absolute',
        zIndex:        '20',
        pointerEvents: 'none',
        fontSize:      st.size + 'px',           // ◄◄ tamaño de píxeles en tiempo real
        fontWeight:    String(st.weight),
        color:         _wmHexToRgba(st.color, st.alpha),
        fontFamily:    'monospace',
        whiteSpace:    'nowrap',
        lineHeight:    '1.6',
        textShadow:    def.key === 'email' ? '0 1px 3px rgba(0,0,0,0.85)' : '0 1px 2px rgba(0,0,0,0.6)',
        transition:    `top ${def.transSec}s ease-in-out, left ${def.transSec}s ease-in-out`,
    });
    el.textContent = _wmValue(def.key);
    _wmEls.push(el);
    _wmRandomPos(el, parent);
    const timer = setInterval(() => {
        try {
            el.textContent = _wmValue(def.key);
            _wmRandomPos(el, parent);
        } catch {}
    }, def.rotateMs);
    _wmTimers.push(timer);
}

// Re-pinta TODAS las marcas (limpia timers/elementos previos). No cierra el SSE.
function _wmPaintAll(parent) {
    while (_wmTimers.length) { try { clearInterval(_wmTimers.pop()); } catch {} }
    while (_wmEls.length)    { try { _wmEls.pop().remove();       } catch {} }
    WM_DEFS.forEach(def => _wmPaintOne(def, parent));
}

function _wmFetchIp() {
    if (_wmClientIp) return;
    try {
        fetch('https://api.ipify.org?format=json', { cache: 'no-store' })
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (d && d.ip) {
                    _wmClientIp = d.ip;
                    const el = document.getElementById('wm-ip');
                    if (el) el.textContent = _wmValue('ip');
                }
            }).catch(() => {});
    } catch {}
}

function _wmValue(key) {
    if (key === 'email') {
        const e = STATE.studentEmail && STATE.studentEmail.includes('@')
            ? STATE.studentEmail
            : '';
        return e ? '\u2709 ' + e : '';
    }
    if (key === 'ip') {
        return _wmClientIp ? 'IP ' + _wmClientIp : '';
    }
    if (key === 'code') {
        return STATE.watermarkText || STATE.studentCode || 'CDP-?????';
    }
    if (key === 'datetime') {
        const now = new Date();
        const dd  = String(now.getDate()).padStart(2,'0');
        const mm  = String(now.getMonth()+1).padStart(2,'0');
        const hh  = String(now.getHours()).padStart(2,'0');
        const mn  = String(now.getMinutes()).padStart(2,'0');
        const ss  = String(now.getSeconds()).padStart(2,'0');
        return `${dd}/${mm}/${now.getFullYear()} ${hh}:${mn}:${ss}`;
    }
    return '';
}

// Coloca el elemento en una posición aleatoria dentro del área del reproductor,
// asegurando que el texto completo permanezca visible (sin cortarse en los bordes).
function _wmRandomPos(el, parent) {
    const pw = parent.clientWidth  || window.innerWidth;
    const ph = parent.clientHeight || window.innerHeight;
    const ew = el.offsetWidth  || 0;
    const eh = el.offsetHeight || 0;
    const margin  = 6;
    const maxLeft = Math.max(margin, pw - ew - margin);
    const maxTop  = Math.max(margin, ph - eh - margin);
    const left = margin + Math.random() * Math.max(0, maxLeft - margin);
    const top  = margin + Math.random() * Math.max(0, maxTop  - margin);
    el.style.left   = Math.round(left) + 'px';
    el.style.top    = Math.round(top)  + 'px';
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
}

// Reajusta los watermarks que hayan quedado fuera del área visible (p. ej. al
// cambiar el tamaño de la ventana o entrar/salir de pantalla completa).
function _wmClampAll(parent) {
    const pw = parent.clientWidth  || window.innerWidth;
    const ph = parent.clientHeight || window.innerHeight;
    const margin = 6;
    _wmEls.forEach(el => {
        const ew = el.offsetWidth  || 0;
        const eh = el.offsetHeight || 0;
        let left = parseFloat(el.style.left) || 0;
        let top  = parseFloat(el.style.top)  || 0;
        left = Math.min(Math.max(margin, left), Math.max(margin, pw - ew - margin));
        top  = Math.min(Math.max(margin, top),  Math.max(margin, ph - eh - margin));
        el.style.left = Math.round(left) + 'px';
        el.style.top  = Math.round(top)  + 'px';
    });
}

function startWatermark() {
    stopWatermark();
    _wmFetchIp();

    // El elemento original #watermark se usa como contenedor; vaciarlo.
    if (watermark) { watermark.textContent = ''; watermark.style.display = 'none'; }
    const parent = (watermark && watermark.parentElement) || document.body;

    _wmPaintAll(parent);

    // Mantener todo dentro del área visible al redimensionar / pantalla completa.
    _wmResizeHandler = () => { try { _wmClampAll(parent); } catch {} };
    window.addEventListener('resize', _wmResizeHandler);

    // Abrir el canal de tamaño de píxeles en tiempo real (idempotente).
    subscribeWmConfig();
}

// ── Tamaño de píxeles en tiempo real (SSE) ─────────────────────────────────
// Abre un canal persistente al backend; cuando el admin cambia tamaño/color/
// grosor desde el panel, llega un evento `config` y se re-renderizan las marcas
// sin recargar el video.
function subscribeWmConfig() {
    if (_wmSSE) return;                              // ya suscrito
    if (typeof EventSource === 'undefined') return;  // sin soporte
    if (!STATE.apiBase || !STATE.auth) return;       // sin datos para autenticar
    const courseId = STATE.wmCourseId || '__default__';
    const url = String(STATE.apiBase).replace(/\/+$/, '')
        + '/api/watermark/stream/' + encodeURIComponent(courseId)
        + '?token=' + encodeURIComponent(STATE.mediaToken || STATE.auth)
        + '&os='    + encodeURIComponent(_WM_OS_KEY);
    try {
        const es = new EventSource(url);
        _wmSSE = es;
        es.addEventListener('config', (e) => {
            try {
                const full = JSON.parse(e.data);
                _wmConfig = full[_WM_OS_KEY] || full || _wmConfig;
                const parent = (watermark && watermark.parentElement) || document.body;
                _wmPaintAll(parent);                 // ◄◄ re-render sin recargar
            } catch {}
        });
        es.onerror = () => { /* EventSource reintenta solo; conserva el último tamaño */ };
    } catch {}
}

function stopWatermark() {
    if (STATE.wmTimer) { clearInterval(STATE.wmTimer); STATE.wmTimer = null; }
    while (_wmTimers.length) { try { clearInterval(_wmTimers.pop()); } catch {} }
    while (_wmEls.length) { try { _wmEls.pop().remove(); } catch {} }
    if (_wmResizeHandler) { try { window.removeEventListener('resize', _wmResizeHandler); } catch {} _wmResizeHandler = null; }
    if (_wmSSE) { try { _wmSSE.close(); } catch {} _wmSSE = null; }
}

// ── Overlay ───────────────────────────────────────────────────────────────────
function showOverlay(icon, title, msg) {
    $('overlay-icon').textContent  = icon;
    overlayTitle.textContent = title;
    overlayMsg.textContent   = msg;
    overlay.classList.add('active');
    showSpinner(false);
}

function hideOverlay() {
    overlay.classList.remove('active');
}

function stopPlayback() {
    sendProgress();
    if (STATE.sessionId) apiFetch('/api/session/end', 'POST', {
        sessionId: STATE.sessionId, mediaToken: STATE.mediaToken || STATE.linkAuth,
        deviceId: STATE.deviceId,
    }).catch(() => {});
    STATE.playGeneration++;
    stopHls();
    stopVdoCipher();
    stopHeartbeat();
    stopWatermark();
    window.vcbPlayer?.eduClose?.().catch(() => {});
    STATE._eduId = '';
    STATE.mediaToken = '';
    STATE.linkAuth = '';
    STATE.cmd = '';
    STATE.sessionId = '';
    STATE.videoId = '';
    STATE.tokenExpAt = 0;
    STATE.lastProgress = 0;
    STATE.lastProgressSent = 0;
    STATE.wmCourseId = '__default__';
}

function resetToSplash() {
    stopPlayback();
    hideOverlay();
    showPlayerArea(false);
    showSplash(true);
}

// ── Spinner ───────────────────────────────────────────────────────────────────
function showSpinner(v) {
    if (v) spinner.classList.add('active');
    else   spinner.classList.remove('active');
}

// ── Transiciones de vista ─────────────────────────────────────────────────────
function showSplash(v) {
    splash.style.display = v ? 'flex' : 'none';
}

function showPlayerArea(v) {
    if (v) playerArea.classList.add('active');
    else   playerArea.classList.remove('active');
}

// ── API helper ────────────────────────────────────────────────────────────────
async function apiFetch(path, method = 'GET', body = null) {
    const base = (STATE.apiBase || '').replace(/\/$/, '');  // strip trailing slash
    const url  = base + path;

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${path === '/api/playback/resolve' ? STATE.linkAuth : STATE.auth}`,
    };
    // Agregar firma HMAC en las llamadas críticas de reproducción
    const isPlaybackEndpoint = path.startsWith('/api/playback/resolve') || path.startsWith('/api/playback/t/');
    if (isPlaybackEndpoint && window.vcbPlayer?.computeAppSig) {
        const ts  = Date.now().toString();
        const sig = await window.vcbPlayer.computeAppSig('resolve:' + ts);
        headers['X-CDP-Ts']  = ts;
        headers['X-CDP-Sig'] = sig;
    }
    // resolve-perm requiere JWT — se envía el token del alumno autenticado
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    return fetch(url, opts);
}

// ── Cleanup al cerrar ─────────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
    stopPlayback();
});

// ── Arranque ──────────────────────────────────────────────────────────────────
init().catch(err => {
    console.error('[VCB] Error en init:', err);
});

function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

})(); // fin IIFE
