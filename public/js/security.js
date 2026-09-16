'use strict';
/**
 * security.js — Módulo de seguridad frontend para Edulock Systems
 *
 * PROTECCIONES IMPLEMENTADAS:
 *  1. Watermark dinámico con código estudiantil (5 posiciones rotativas)
 *  2. Detección de DevTools (pausa y registra el evento)
 *  3. Detección de grabación/screen sharing (overlay negro)
 *  4. Bloqueo de clic derecho sobre el video
 *  5. Protección suave para móviles (iOS/Android safe)
 *
 * DISEÑO:
 *  - No rompe la reproducción normal bajo ninguna circunstancia
 *  - Las protecciones fallan de forma segura (silent fail)
 *  - En iOS/Safari las detecciones agresivas se desactivan automáticamente
 *  - Todas las funciones son exportadas al objeto global CDP_SECURITY
 */

(function () {
    // ================================================================
    //  DETECCIÓN DE PLATAFORMA
    // ================================================================
    const IS_IOS     = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const IS_SAFARI  = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const IS_MOBILE  = IS_IOS || /Android/i.test(navigator.userAgent);
    const IS_MAC     = /Macintosh/i.test(navigator.userAgent) && !IS_MOBILE;

    // En iOS y Safari nativo, algunas protecciones agresivas rompen el player
    // → modo suave: solo watermark y registro, sin pausas forzadas
    const SOFT_MODE = IS_IOS || IS_SAFARI;

    // ================================================================
    //  CONFIGURACIÓN
    // ================================================================
    const CFG = {
        // Watermark
        WM_ROTATE_MS:       12000,  // Mover watermark cada 12 segundos
        WM_FORENSIC_MS:     60000,  // Mover watermark forense cada 60s
        WM_OPACITY_VISIBLE: 0.22,   // Opacidad watermark visible
        WM_OPACITY_FORENSIC:0.055,  // Opacidad watermark forense

        // DevTools detection
        DEVTOOLS_CHECK_MS:  2000,   // Revisar DevTools cada 2 segundos
        DEVTOOLS_THRESHOLD: 160,    // Diferencia px outer-inner que indica DevTools

        // Anti-grabación
        RECORDING_CHECK_MS: 1500,   // Revisar grabación cada 1.5s

        // Throttle de eventos al servidor
        EVENT_THROTTLE_MS:  10000,  // No enviar el mismo evento más de 1 vez cada 10s
    };

    // ================================================================
    //  ESTADO INTERNO
    // ================================================================
    let _apiBase        = '';
    let _authToken      = null;
    let _videoId        = null;
    let _studentCode    = null;
    let _studentEmail   = null;
    let _sessionId      = null;
    let _clientIp       = null;   // IP pública (se obtiene de forma independiente)

    let _wmTimer        = null;
    let _wmTimers       = [];      // timers de los 4 watermarks independientes
    let _wmEls          = [];      // elementos DOM de los 4 watermarks independientes
    let _fwTimer        = null;
    let _dtTimer        = null;
    let _recTimer       = null;

    let _devtoolsOpen   = false;
    let _recordingActive= false;
    let _overlayActive  = false;

    // Throttle: guarda el último ts de cada tipo de evento enviado
    const _lastEventSent = {};

    // ================================================================
    //  HELPERS INTERNOS
    // ================================================================
    function _log(msg, ...args) {
        // Solo en desarrollo; en producción silencioso
        try { if (window.location.hostname === 'localhost') console.log('[CDP-SEC]', msg, ...args); } catch {}
    }

    function _throttledSendEvent(eventType, extra = {}) {
        const now = Date.now();
        const last = _lastEventSent[eventType] || 0;
        if (now - last < CFG.EVENT_THROTTLE_MS) return;
        _lastEventSent[eventType] = now;
        _sendSecurityEvent(eventType, extra);
    }

    function _sendSecurityEvent(eventType, extra = {}) {
        if (!_apiBase || !_authToken || !_videoId) return;
        try {
            fetch(_apiBase + '/api/playback/event-secure', {
                method:  'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + _authToken,
                },
                body: JSON.stringify({
                    videoId:   _videoId,
                    eventType,
                    metadata:  extra,
                }),
                keepalive: true,
            }).catch(() => {});
        } catch {}
    }

    // ================================================================
    //  1. WATERMARK DINÁMICO — 5 posiciones rotativas
    // ================================================================

    // Posiciones legacy (se conservan por compatibilidad, ya no se usan directamente)
    const WM_POSITIONS = [
        { top: '8%',  left: '5%',   right: '',    bottom: '' },   // arriba-izq
        { top: '8%',  left: '',     right: '5%',  bottom: '' },   // arriba-der
        { top: '45%', left: '30%',  right: '',    bottom: '' },   // centro
        { top: '',    left: '5%',   right: '',    bottom: '12%'}, // abajo-izq
        { top: '',    left: '',     right: '5%',  bottom: '12%'}, // abajo-der
    ];

    let _wmPosIdx = 0;

    // ----------------------------------------------------------------
    //  4 WATERMARKS INDEPENDIENTES — cada uno con su propia trayectoria,
    //  tiempo y dato. NO se agrupan en una sola línea.
    //    1) Correo   2) IP   3) Código CDP   4) Fecha y Hora
    // ----------------------------------------------------------------
    const WM_DEFS = [
        {   // 1 · Correo — zona superior izquierda
            id: 'cdp-wm-email', key: 'email', rotateMs: 9000, transSec: 6,
            zone: [ {top:'9%',left:'6%'}, {top:'19%',left:'13%'}, {top:'7%',left:'21%'}, {top:'24%',left:'5%'} ],
        },
        {   // 2 · IP — zona superior derecha
            id: 'cdp-wm-ip', key: 'ip', rotateMs: 13000, transSec: 8,
            zone: [ {top:'10%',right:'6%'}, {top:'21%',right:'12%'}, {top:'8%',right:'19%'}, {top:'25%',right:'5%'} ],
        },
        {   // 3 · Código CDP — zona inferior izquierda
            id: 'cdp-wm-code', key: 'code', rotateMs: 7000, transSec: 5,
            zone: [ {bottom:'14%',left:'6%'}, {bottom:'25%',left:'13%'}, {bottom:'10%',left:'20%'}, {bottom:'27%',left:'4%'} ],
        },
        {   // 4 · Fecha y Hora — zona inferior derecha
            id: 'cdp-wm-datetime', key: 'datetime', rotateMs: 11000, transSec: 7,
            zone: [ {bottom:'14%',right:'6%'}, {bottom:'23%',right:'12%'}, {bottom:'9%',right:'19%'}, {bottom:'27%',right:'5%'} ],
        },
    ];

    // Calcula el texto de cada watermark de forma independiente.
    function _wmValue(key) {
        if (key === 'email') {
            const e = _studentEmail && _studentEmail.includes('@')
                ? _studentEmail
                : '';
            return e ? '\u2709 ' + e : '';
        }
        if (key === 'ip') {
            return _clientIp ? 'IP ' + _clientIp : '';
        }
        if (key === 'code') {
            return _studentCode || 'CDP-?????';
        }
        if (key === 'datetime') {
            const now  = new Date();
            const date = now.toLocaleDateString('es-MX', { day:'2-digit', month:'2-digit', year:'numeric' });
            const time = now.toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
            return date + ' ' + time;
        }
        return '';
    }

    // Obtiene la IP pública de forma independiente (sin tocar el backend).
    // Si falla, el watermark de IP simplemente queda vacío (fail-safe).
    function _fetchClientIp() {
        if (_clientIp) return;
        try {
            fetch('https://api.ipify.org?format=json', { cache: 'no-store' })
                .then(r => r.ok ? r.json() : null)
                .then(d => {
                    if (d && d.ip) {
                        _clientIp = d.ip;
                        const el = document.getElementById('cdp-wm-ip');
                        if (el) el.textContent = _wmValue('ip');
                    }
                })
                .catch(() => {});
        } catch {}
    }

    function _applyWmPosition(el, pos) {
        el.style.top    = pos.top    || '';
        el.style.left   = pos.left   || '';
        el.style.right  = pos.right  || '';
        el.style.bottom = pos.bottom || '';
    }

    /**
     * Inicializa el watermark mejorado (reemplaza el watermark básico de index.html).
     * Compatible con el overlay #watermark-overlay existente.
     */
    function initWatermark(opts) {
        const { apiBase, token, videoId, studentCode, studentEmail, sessionId } = opts || {};
        _apiBase      = apiBase     || _apiBase;
        _authToken    = token       || _authToken;
        _videoId      = videoId     || _videoId;
        _studentCode  = studentCode || _studentCode;
        _studentEmail = studentEmail|| _studentEmail;
        _sessionId    = sessionId   || _sessionId;

        const wmEl = document.getElementById('watermark-overlay');
        const fwEl = document.getElementById('watermark-forensic');
        if (!wmEl) return;

        // El overlay combinado original se deja vacío: ahora usamos 4 watermarks
        // independientes (correo, IP, código, fecha/hora) creados dinámicamente.
        wmEl.textContent = '';
        wmEl.style.display = 'none';
        const parent = wmEl.parentElement || document.body;

        // Iniciar obtención independiente de IP (no bloqueante)
        _fetchClientIp();

        // Limpiar timers/elementos previos
        _wmTimers.forEach(t => { try { clearInterval(t); } catch {} });
        _wmTimers = [];
        _wmEls.forEach(el => { try { el.remove(); } catch {} });
        _wmEls = [];

        WM_DEFS.forEach(def => {
            let el = document.getElementById(def.id);
            if (!el) {
                el = document.createElement('div');
                el.id = def.id;
                parent.appendChild(el);
            }
            // Estilo independiente (cada watermark se mueve por separado)
            el.style.position       = 'absolute';
            el.style.color          = 'rgba(255,255,255,0.20)';
            el.style.textShadow     = '1px 1px 2px rgba(0,0,0,0.8)';
            el.style.fontSize       = '16px';
            el.style.fontWeight     = '600';
            el.style.fontFamily     = 'monospace';
            el.style.letterSpacing  = '1px';
            el.style.whiteSpace     = 'nowrap';
            el.style.userSelect     = 'none';
            el.style.pointerEvents  = 'none';
            el.style.zIndex         = '20';
            el.style.opacity        = String(CFG.WM_OPACITY_VISIBLE);
            el.style.transition      = `top ${def.transSec}s ease-in-out, left ${def.transSec}s ease-in-out, right ${def.transSec}s ease-in-out, bottom ${def.transSec}s ease-in-out`;

            // Texto y posición inicial
            el.textContent = _wmValue(def.key);
            let idx = Math.floor(Math.random() * def.zone.length);
            _applyWmPosition(el, def.zone[idx]);

            // Cada watermark rota con su propio tiempo y trayectoria
            const timer = setInterval(() => {
                try {
                    el.textContent = _wmValue(def.key); // refresca (la hora cambia)
                    idx = (idx + 1) % def.zone.length;
                    _applyWmPosition(el, def.zone[idx]);
                } catch {}
            }, def.rotateMs);
            _wmTimers.push(timer);
            _wmEls.push(el);
        });

        // Watermark forense (casi invisible, esquinas)
        if (fwEl) {
            const fp  = (_studentCode || '').replace('CDP-', '');
            const ts  = Math.floor(Date.now() / 3600000).toString(16);
            fwEl.textContent = `${fp}·${ts}`;
            fwEl.style.opacity = String(CFG.WM_OPACITY_FORENSIC);

            const fwCorners = [
                { top: '4px',  left: '4px',  right: '',    bottom: ''    },
                { top: '4px',  right: '4px', left: '',     bottom: ''    },
                { bottom:'30px', left: '4px', top: '',     right: ''    },
                { bottom:'30px', right:'4px', top: '',     left: ''     },
            ];
            let _fwIdx = 0;
            _applyWmPosition(fwEl, fwCorners[_fwIdx]);
            if (_fwTimer) clearInterval(_fwTimer);
            _fwTimer = setInterval(() => {
                try {
                    _fwIdx = (_fwIdx + 1) % fwCorners.length;
                    _applyWmPosition(fwEl, fwCorners[_fwIdx]);
                } catch {}
            }, CFG.WM_FORENSIC_MS);
        }

        _log('Watermark iniciado. Código:', _studentCode);
    }

    // ================================================================
    //  2. DETECCIÓN DE DEVTOOLS
    //  Técnica: mide diferencia entre outer/inner window size.
    //  En iOS/Safari → modo suave (solo log, sin pausa).
    // ================================================================

    let _dtCooldown = false;

    function _checkDevTools() {
        try {
            const threshold = CFG.DEVTOOLS_THRESHOLD;
            const isOpen =
                window.outerWidth  - window.innerWidth  > threshold ||
                window.outerHeight - window.innerHeight > threshold;

            if (isOpen && !_devtoolsOpen) {
                _devtoolsOpen = true;
                _log('DevTools detectado');
                _throttledSendEvent('devtools_open', { ua: navigator.userAgent.slice(0, 100) });

                if (!SOFT_MODE) {
                    // Pausar video
                    try {
                        const vid = document.getElementById('hls-video');
                        if (vid && !vid.paused) {
                            vid.pause();
                        }
                    } catch {}
                    // Oscurecer player brevemente
                    if (!_dtCooldown) {
                        _dtCooldown = true;
                        _showSecurityOverlay('Por seguridad, el video ha sido pausado.\nCierra las herramientas de desarrollador para continuar.', 5000);
                        setTimeout(() => { _dtCooldown = false; }, 15000);
                    }
                }
            } else if (!isOpen && _devtoolsOpen) {
                _devtoolsOpen = false;
                _hideSecurityOverlay();
            }
        } catch {}
    }

    function startDevToolsDetection() {
        if (_dtTimer) clearInterval(_dtTimer);
        _dtTimer = setInterval(_checkDevTools, CFG.DEVTOOLS_CHECK_MS);
        _log('Detección DevTools activa. Modo suave:', SOFT_MODE);
    }

    // ================================================================
    //  3. DETECCIÓN DE GRABACIÓN DE PANTALLA
    //  Técnicas: Page Visibility API + Screen Capture API (si disponible)
    //  En iOS/Safari → solo register event, sin overlay.
    // ================================================================

    function _checkScreenRecording() {
        try {
            // Técnica 1: Page Visibility — si la página está oculta puede ser captura
            // (poco confiable, solo como indicador)
            if (document.hidden && !_recordingActive) {
                _recordingActive = true;
                _throttledSendEvent('visibility_hidden', {});
                return;
            }

            // Técnica 2: Screen Capture API — detectar si hay un MediaStream activo
            // Solo disponible en Chrome/Edge modernos
            if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
                // No podemos saber si OBS está abierto, pero podemos detectar
                // si la API fue usada recientemente — esto requiere que el usuario
                // haya dado permiso, así que es indicativo pero no definitivo.
                // No hacemos nada aquí automáticamente para no romper el flujo.
            }

            if (_recordingActive) {
                _recordingActive = false;
                _hideBlackOverlay();
            }
        } catch {}
    }

    // Escuchar cambios de visibilidad
    function _setupVisibilityListener() {
        document.addEventListener('visibilitychange', () => {
            try {
                if (document.hidden) {
                    _throttledSendEvent('visibility_hidden', {});
                }
            } catch {}
        });
    }

    // Screen sharing detection via Screen Capture API events
    function _setupScreenShareDetection() {
        if (SOFT_MODE) return; // No en iOS/Safari
        try {
            // Interceptar getDisplayMedia para detectar si alguien inicia grabación
            const originalGetDisplayMedia = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);
            if (originalGetDisplayMedia) {
                navigator.mediaDevices.getDisplayMedia = async function (...args) {
                    // Alguien llamó getDisplayMedia → grabación iniciando
                    _log('Screen share / grabación detectada via getDisplayMedia');
                    _recordingActive = true;
                    _throttledSendEvent('screen_recording_detected', { method: 'getDisplayMedia' });
                    if (!SOFT_MODE) {
                        _showBlackOverlay();
                        // Pausar video
                        try {
                            const vid = document.getElementById('hls-video');
                            if (vid && !vid.paused) vid.pause();
                        } catch {}
                    }
                    // Dejar que el navegador maneje la petición normalmente
                    // (no queremos bloquear al usuario legítimamente)
                    try {
                        const stream = await originalGetDisplayMedia(...args);
                        // Cuando el stream termine, quitar overlay
                        stream.getVideoTracks().forEach(track => {
                            track.addEventListener('ended', () => {
                                _recordingActive = false;
                                _hideBlackOverlay();
                            });
                        });
                        return stream;
                    } catch (e) {
                        _recordingActive = false;
                        _hideBlackOverlay();
                        throw e;
                    }
                };
            }
        } catch {}
    }

    function startRecordingDetection() {
        _setupVisibilityListener();
        _setupScreenShareDetection();
        if (_recTimer) clearInterval(_recTimer);
        _recTimer = setInterval(_checkScreenRecording, CFG.RECORDING_CHECK_MS);
        _log('Detección de grabación activa. Modo suave:', SOFT_MODE);
    }

    // ================================================================
    //  4. OVERLAYS DE SEGURIDAD
    // ================================================================

    let _secOverlay = null;
    let _blackOverlay = null;

    function _getOrCreateSecOverlay() {
        if (_secOverlay) return _secOverlay;
        _secOverlay = document.createElement('div');
        Object.assign(_secOverlay.style, {
            position:       'absolute',
            inset:          '0',
            zIndex:         '50',
            background:     'rgba(0,0,0,0.88)',
            display:        'none',
            alignItems:     'center',
            justifyContent: 'center',
            flexDirection:  'column',
            gap:            '12px',
            backdropFilter: 'blur(4px)',
        });
        const msg = document.createElement('p');
        Object.assign(msg.style, {
            color:      '#ff6b6b',
            fontSize:   '0.9rem',
            textAlign:  'center',
            padding:    '0 24px',
            whiteSpace: 'pre-line',
            fontFamily: 'Segoe UI, sans-serif',
        });
        _secOverlay.appendChild(msg);
        _secOverlay._msg = msg;
        const container = document.getElementById('player-container');
        if (container) container.appendChild(_secOverlay);
        return _secOverlay;
    }

    function _showSecurityOverlay(message, autohideMs = 0) {
        if (SOFT_MODE) return; // No mostrar overlays invasivos en iOS/Safari
        try {
            _overlayActive = true;
            const el = _getOrCreateSecOverlay();
            el._msg.textContent = message;
            el.style.display = 'flex';
            if (autohideMs > 0) {
                setTimeout(() => {
                    if (!_devtoolsOpen && !_recordingActive) _hideSecurityOverlay();
                }, autohideMs);
            }
        } catch {}
    }

    function _hideSecurityOverlay() {
        try {
            _overlayActive = false;
            if (_secOverlay) _secOverlay.style.display = 'none';
        } catch {}
    }

    function _getOrCreateBlackOverlay() {
        if (_blackOverlay) return _blackOverlay;
        _blackOverlay = document.createElement('div');
        Object.assign(_blackOverlay.style, {
            position:       'absolute',
            inset:          '0',
            zIndex:         '60',
            background:     '#000',
            display:        'none',
            alignItems:     'center',
            justifyContent: 'center',
        });
        const msg = document.createElement('p');
        Object.assign(msg.style, {
            color:      'rgba(255,255,255,0.6)',
            fontSize:   '0.8rem',
            textAlign:  'center',
            fontFamily: 'monospace',
        });
        msg.textContent = 'CDP · PROTECCIÓN ACTIVA';
        _blackOverlay.appendChild(msg);
        const container = document.getElementById('player-container');
        if (container) container.appendChild(_blackOverlay);
        return _blackOverlay;
    }

    function _showBlackOverlay() {
        if (SOFT_MODE) return;
        try {
            _getOrCreateBlackOverlay().style.display = 'flex';
        } catch {}
    }

    function _hideBlackOverlay() {
        try {
            if (_blackOverlay) _blackOverlay.style.display = 'none';
        } catch {}
    }

    // ================================================================
    //  5. PROTECCIÓN ADICIONAL — Clic derecho sobre el video
    // ================================================================

    function setupContextMenuBlock() {
        try {
            const vid = document.getElementById('hls-video');
            if (!vid) return;
            vid.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                return false;
            });
            // También en el contenedor
            const container = document.getElementById('player-container');
            if (container) {
                container.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    return false;
                });
            }
        } catch {}
    }

    // ================================================================
    //  6. FUNCIÓN PRINCIPAL DE INICIO
    // ================================================================

    /**
     * Inicializa todo el sistema de seguridad.
     * @param {object} opts
     * @param {string} opts.apiBase        — URL base del servidor (ej: https://...)
     * @param {string} opts.token          — JWT de autenticación del alumno
     * @param {string} opts.videoId        — ID del video en reproducción
     * @param {string} [opts.studentCode]  — Código CDP-XXXXX del alumno
     * @param {string} [opts.studentEmail] — Email del alumno (para watermark)
     * @param {string} [opts.sessionId]    — ID de sesión actual
     */
    function init(opts) {
        try {
            _log('Iniciando sistema de seguridad. Soft mode:', SOFT_MODE);

            // 1. Watermark dinámico
            initWatermark(opts);

            // 2. Bloqueo de clic derecho (siempre, en todos los dispositivos)
            setupContextMenuBlock();

            // 3. DevTools detection (no en iOS/Safari para no romper player)
            if (!SOFT_MODE) {
                startDevToolsDetection();
            }

            // 4. Detección de grabación
            startRecordingDetection();

        } catch (e) {
            // Si algo falla en seguridad, NO interrumpir la reproducción
            _log('Error al iniciar seguridad (no crítico):', e.message);
        }
    }

    /**
     * Actualiza el token JWT cuando se refresca (para que los eventos sigan enviándose).
     */
    function updateToken(newToken) {
        _authToken = newToken;
    }

    /**
     * Detiene todos los timers de seguridad (al cerrar el video).
     */
    function destroy() {
        try {
            if (_wmTimer)  clearInterval(_wmTimer);
            if (_fwTimer)  clearInterval(_fwTimer);
            if (_dtTimer)  clearInterval(_dtTimer);
            if (_recTimer) clearInterval(_recTimer);
            _wmTimer = _fwTimer = _dtTimer = _recTimer = null;
            // Limpiar los 4 watermarks independientes
            _wmTimers.forEach(t => { try { clearInterval(t); } catch {} });
            _wmTimers = [];
            _wmEls.forEach(el => { try { el.remove(); } catch {} });
            _wmEls = [];
            _hideSecurityOverlay();
            _hideBlackOverlay();
        } catch {}
    }

    // ================================================================
    //  EXPORTAR API PÚBLICA
    // ================================================================
    window.CDP_SECURITY = {
        init,
        initWatermark,
        startDevToolsDetection,
        startRecordingDetection,
        setupContextMenuBlock,
        updateToken,
        destroy,
        // Utilidades para el reproductor principal
        isIOS:   IS_IOS,
        isSafari:IS_SAFARI,
        isMobile:IS_MOBILE,
        softMode:SOFT_MODE,
    };

    _log('security.js cargado. Esperando init()...');

})();
