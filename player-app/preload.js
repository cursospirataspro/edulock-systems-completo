'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Buffer para resolver race condition: el main process envía 'cdp-play' antes
// de que el renderer haya completado init() y registrado el callback via onPlay().
ipcRenderer.on('cdp-play', (_event, data) => {
    window.__vcbPendingPlay = data;
});

contextBridge.exposeInMainWorld('vcbPlayer', {

    getConfig: () => ipcRenderer.invoke('get-config'),

    getResourceCatalog: () => ipcRenderer.invoke('resource-catalog'),
    openResource: (id) => ipcRenderer.invoke('resource-open', id),
    openPublicResource: (url) => ipcRenderer.invoke('resource-open-public', url),

    setApiBase: (url) => ipcRenderer.invoke('set-api-base', url),

    getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),

    onPlay: (callback) => {
        ipcRenderer.on('cdp-play', (_event, data) => callback(data));
        if (window.__vcbPendingPlay) {
            const p = window.__vcbPendingPlay;
            window.__vcbPendingPlay = null;
            setTimeout(() => callback(p), 0);
        }
    },

    offPlay: () => {
        ipcRenderer.removeAllListeners('cdp-play');
    },

    reportError: (message) => ipcRenderer.send('player-error', message),

    close: () => ipcRenderer.send('close-player'),

    openExternal: (url) => ipcRenderer.send('open-external', url),

    // ── Pantalla completa nativa (Electron) ──────────────────────────────────
    toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
    isFullscreen: () => ipcRenderer.invoke('is-fullscreen'),
    onFullscreenChanged: (cb) => ipcRenderer.on('fullscreen-changed', (_e, isFs) => cb(isFs)),

    computeAppSig: (message) => ipcRenderer.invoke('compute-sig', message),
    getServerTime: () => ipcRenderer.invoke('get-server-time'),
    onTokenRefreshed: (cb) => ipcRenderer.on('token-refreshed', (_e, token) => cb(token)),

    // ── Auth / Registro ──────────────────────────────────────────────────────
    // Enviar solicitud de registro al servidor
    // Verificar estado de la cuenta para este dispositivo
    // Verificar token Firebase con el servidor y obtener sesión
    firebaseLogin: (data) => ipcRenderer.invoke('auth-firebase-login', data),
    checkAccountStatus: (data) => ipcRenderer.invoke('auth-account-status', { email: data?.email }),
    // Notificar al main que el auth fue exitoso (cierra ventana auth, muestra main)
    authSuccess: () => ipcRenderer.send('auth-success'),

    // ── Sesión persistente ───────────────────────────────────────────────────
    // Guardar sesión en disco (userData/session.json) para sobrevivir reinicios
    saveSession: (data) => ipcRenderer.invoke('save-session', data),
    // Leer sesión guardada (para enviar checkin de startup al servidor)
    getSession: () => ipcRenderer.invoke('get-session'),
    // Borrar sesión guardada (logout explícito)
    clearSession: () => ipcRenderer.invoke('clear-session'),
    // Escuchar bloqueo de seguridad (amenaza detectada) y limpieza
    onSecurityBlocked: (cb) => ipcRenderer.on('security-blocked', (_e, data) => cb(data)),
    onSecurityCleared: (cb) => ipcRenderer.on('security-cleared', () => cb()),

    // Licencia regenerada/revocada por el admin: forzar re-activación
    onLicenseRegenerated: (cb) => ipcRenderer.on('license-regenerated', (_e, data) => cb(data || {})),

    onStopPlayback: (cb) => ipcRenderer.on('stop-playback', () => cb()),
    requestLicense: () => ipcRenderer.send('request-license'),
    onLicenseRequired: (cb) => ipcRenderer.on('license-required', () => cb()),

    // Cerrar sesión y volver a la ventana de auth
    logout: () => ipcRenderer.send('logout'),

    // ── Activación local (sistema de licencias) ──────────────────────────────
    // Verificar si hay activación guardada localmente
    activationHasLocal: (deviceId) => ipcRenderer.invoke('activation-has-local', deviceId),
    // Validar activación local contra el servidor
    activationValidate: (deviceId) => ipcRenderer.invoke('activation-validate', deviceId),
    // Activar licencia nueva en este dispositivo
    activationActivateLicense: (opts) => ipcRenderer.invoke('activation-activate-license', opts),
    // Borrar activación local
    activationClear: () => ipcRenderer.invoke('activation-clear'),
    // Obtener OTP de VdoCipher para reproducir un video
    vdocipherOtp: (opts) => ipcRenderer.invoke('vdocipher-otp', opts),

    // ── DRM propio .edu (modelo InfoProtector) ────────────────────────────────
    // Descarga + descifra localmente un contenido protegido; devuelve una URL
    // edu:// que el <video> reproduce (el mp4 nunca toca el disco).
    eduOpen: (opts) => ipcRenderer.invoke('edu-open', opts),
    eduClose: (contentId) => ipcRenderer.invoke('edu-close', contentId),
});
