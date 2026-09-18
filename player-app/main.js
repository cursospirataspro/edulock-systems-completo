'use strict';
// Windows may detach the launcher's console while this GUI keeps running.
// A failed diagnostic write must not become an uncaught exception in the player.
for (const output of [process.stdout, process.stderr]) {
    if (output && typeof output.on === 'function') output.on('error', () => {});
}
const { certificateDecision, parseByteRange, findBlockedProcess, classifyRdpSession,
    matchingMacPrefixes, classifyVmEvidence, booleanProbeState, parseDriverProbeResult,
    normalizeHardwareUuid } = require('./security-policy');
const { powershellCommand, driverProbe, unsignedDriverProbe, dllProbe } = require('./platform-probes');
const { normalizeAuthResponse, connectionFailure } = require('./auth-response');
const { parseResourceLink } = require('./protected-resources');
const { createResourceWindows } = require('./resource-window');

const {
    app, BrowserWindow, ipcMain, shell,
    dialog, Menu, Tray, nativeImage, session, protocol, safeStorage,
} = require('electron');

// CastLabs Electron expone components API para Widevine CDM
// En Electron normal esta API no existe — el try/catch lo maneja gracefully
let components = null;
try { components = require('electron').components; } catch {}

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── DRM propio .edu (modelo InfoProtector): descarga + descifrado LOCAL ────────
// Descifrado POR TROZOS bajo demanda: el mp4 nunca existe entero (guía §7).
const { openEdu, readRange } = require('./edu-native');
const _eduBuffers = new Map(); // contentId -> estado openEdu (el .edu CIFRADO + parseo)
// El esquema edu:// debe registrarse como privilegiado ANTES de app ready.
try {
    protocol.registerSchemesAsPrivileged([
        { scheme: 'edu', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
    ]);
} catch (_) { /* si ya está registrado */ }

// AVISO LEGAL embebido (deterrente + base legal). Queda en las cadenas del binario.
const LEGAL_NOTICE =
    'Edulock Systems Player (c) Edulock Systems. Software propietario. ' +
    'Queda PROHIBIDA la ingenieria inversa, descompilacion, depuracion o analisis del ' +
    'Software y del formato .edu, por cualquier medio, incluidos modelos de inteligencia ' +
    'artificial. El contenido lleva marca de agua y es rastreable. Ver EULA.txt.';

/**
 * Abre un enlace en el navegador del sistema solo si es http o https. Antes
 * cualquier direccion que no fuera file:// se entregaba tal cual al sistema
 * operativo, incluidos esquemas que pueden lanzar otros programas (R04).
 */
function openExternalSafely(url) {
    try {
        const parsed = new URL(String(url));
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') shell.openExternal(parsed.href);
    } catch { /* direccion no valida: no se abre nada */ }
}

/** Host exacto (o subdominio real) de la lista de inicio de sesion. */
function isAuthWindowUrl(url) {
    try {
        const parsed = new URL(String(url));
        if (parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        const esHost = dominio => host === dominio || host.endsWith('.' + dominio);
        if (esHost('accounts.google.com')) return true;
        if (esHost('firebaseapp.com') && parsed.pathname.startsWith('/__/auth/')) return true;
        return false;
    } catch { return false; }
}

/**
 * Comprueba que un mensaje IPC venga de una ventana nuestra y de nuestra propia
 * pagina (file://), no de contenido remoto incrustado.
 */
function isTrustedSender(event) {
    try {
        const sender = event && event.sender;
        if (!sender || sender.isDestroyed()) return false;
        const propias = [mainWindow, authWindow].filter(Boolean).map(w => w.webContents);
        if (!propias.includes(sender)) return false;
        const origen = sender.getURL() || '';
        return origen.startsWith('file://');
    } catch { return false; }
}

// ─── Constantes ──────────────────────────────────────────────────────────────
// Modo de desarrollo. La bandera sola no basta: en un binario empaquetado
// app.isPackaged es true y IS_DEV queda en false pase lo que pase por la linea de
// ordenes. Antes cualquiera podia arrancar el reproductor distribuido con --dev y
// con eso se saltaba el control de sesion remota, el escaneo de seguridad
// periodico y la actualizacion obligatoria, ademas de abrir las herramientas de
// desarrollo (F04). Las excepciones de desarrollo solo existen ejecutando desde
// el codigo fuente.
const IS_DEV  = !app.isPackaged && process.argv.includes('--dev');
const IS_MAC  = process.platform === 'darwin';
const IS_WIN  = process.platform === 'win32';
const PROTOCOL    = 'edulock';
// Esquema anterior: ya no se registra en el SO (chocaba con otros reproductores
// que también usan cdp://), pero los enlaces antiguos se siguen entendiendo.
const LEGACY_PROTOCOL = 'cdp';
const DEEP_LINK_RE = /^(edulock|cdp):/i;
const APP_DISPLAY = 'Edulock Systems Player';

// Normaliza "edulock:play?..", "cdp://play?.." → "edulock://play?.." para new URL()
function normalizeDeepLink(rawUrl) {
    return String(rawUrl || '')
        .replace(/^(edulock|cdp):\/\//i, `${PROTOCOL}://`)
        .replace(/^(edulock|cdp):(?!\/\/)/i, `${PROTOCOL}://`);
}

// Nombre mostrado en diálogos del SO y en "Abrir con"
app.setName(APP_DISPLAY);

// A separate profile lets support validate the packaged application against a
// staging server without overwriting a customer's settings or saved session.
const profileDirectory = app.commandLine.getSwitchValue('profile-dir');
if (profileDirectory) {
    if (!path.isAbsolute(profileDirectory)) throw new Error('--profile-dir debe ser una ruta absoluta.');
    fs.mkdirSync(profileDirectory, { recursive: true });
    app.setPath('userData', profileDirectory);
    app.setPath('sessionData', profileDirectory);
}

const { exec } = require('child_process');

// Alias de logging — en producción va a la consola del proceso principal
const log = console;

// ─── Detección de herramientas de descarga, control remoto y bypass DRM ──────
// CRITERIO: se bloquean programas de descarga de streams, control remoto,
// ingeniería inversa/bypass Y grabadores de pantalla.
// NO se bloquean: apps de videollamadas (Zoom, Discord, Teams) ni procesos
// de fondo de GPU (NVIDIA/AMD).
const REMOTE_TOOLS = [
    // ── Control remoto / escritorio remoto ────────────────────────────────────
    'mstsc.exe',               // Remote Desktop Connection (Windows built-in)
    'msrdc.exe',               // Microsoft Remote Desktop (Store app)
    'teamviewer.exe', 'teamviewer_service.exe',
    'anydesk.exe',
    'rustdesk.exe',
    'parsec.exe',
    'winvnc.exe', 'tvnserver.exe', 'vncviewer.exe',
    'rfbserver.exe',
    'logmein.exe', 'logmeinrescue.exe',
    'connectwisecontrol.exe', 'screenconnect.exe',
    'splashtop.exe', 'splashtopstreamer.exe',
    'supremoservice.exe', 'supremo.exe',
    'ultraviewer.exe',
    'radmin.exe',
    'zoho_assist.exe',
    // ── Descargadores de HLS / m3u8 / streams de video ───────────────────────
    'ffmpeg.exe',              // descargador HLS más común: ffmpeg -i "manifest.m3u8"
    'ffprobe.exe',             // companion de ffmpeg
    'yt-dlp.exe',              // sucesor de youtube-dl, descarga HLS nativamente
    'ytdlp.exe',               // alias sin guión
    'youtube-dl.exe',          // original youtube-dl
    'youtube-dlp.exe',         // variante distribuida
    'streamlink.exe',          // descargador de streams HLS/DASH
    'livestreamer.exe',        // predecesor de streamlink
    'streamripper.exe',        // stream ripper
    'aria2c.exe',              // gestor de descargas con soporte HLS
    'n_m3u8dl-re.exe',         // descargador m3u8/HLS muy popular en piratería
    'n_m3u8dl.exe',            // versión antigua de N_m3u8DL
    'm3u8dl.exe',              // descargador m3u8 genérico
    'hlsdl.exe',               // HLS downloader dedicado
    'hlsloader.exe',           // HLS loader
    'mediadl.exe',             // descargador de medios
    'jdownloader.exe',         // JDownloader — soporta plugins HLS
    'jdownloader2.exe',
    'idman.exe',               // Internet Download Manager — intercepta HLS en navegadores
    'internetdownloadmanager.exe',
    // ── Herramientas de análisis, depuración e inyección (bypass DRM) ─────────
    'frida.exe', 'frida-server.exe', 'frida-agent.exe',
    'ida.exe', 'ida64.exe', 'idag.exe', 'idaq.exe', 'idaq64.exe',
    'x64dbg.exe', 'x32dbg.exe',
    'ollydbg.exe',
    'windbg.exe', 'windbgx.exe', 'cdb.exe',
    'ghidra.exe', 'analyzeheadless.exe',
    'cheatengine.exe', 'cheatengine-x86_64.exe',
    'processhacker.exe', 'processhacker2.exe',
    'systeminformer.exe',
    'wireshark.exe',
    'mitmproxy.exe', 'mitmweb.exe', 'mitmdump.exe',
    'fiddler.exe', 'fiddlereverywhere.exe',
    'charles.exe',
    'http toolkit.exe', 'httptoolkit.exe',
    'dnspy.exe', 'ilspy.exe',
    // ── Grabadores de pantalla ───────────────────────────────────────────────
    'obs64.exe', 'obs32.exe', 'obs.exe',           // OBS Studio
    'bdcam.exe', 'bandicam.exe',                    // Bandicam
    'camtasia.exe', 'camrec.exe',                   // Camtasia
    'camtasiastudio.exe',
    'sharex.exe',                                    // ShareX
    'snagit.exe', 'snagiteditor.exe',               // Snagit
    'action.exe', 'mirillis action!.exe',           // Mirillis Action!
    'screenpal.exe', 'screencastomatic.exe',        // ScreenPal
    'loom.exe',                                      // Loom
    'xsplit.exe', 'xsplitbroadcaster.exe',          // XSplit
    'xsplitgamecaster.exe',
    'flashbackrecorder.exe', 'bbflashback.exe',     // FlashBack
    'movavi screen recorder.exe',                    // Movavi
    'recexperts.exe',                                // EaseUS RecExperts
    'icecreamscreenrecorder.exe',                    // Icecream
    'apowerrec.exe',                                 // Apowersoft
    'screenrecorder.exe',                            // Generic
    'fraps.exe',                                     // Fraps
    'dxtory.exe',                                    // Dxtory
    'litecam.exe',                                   // LiteCam
    'vokoscreenng.exe',                              // vokoscreen
    'captura.exe',                                   // Captura
];

// ── Herramientas con IA (asistentes / IDEs / LLM locales) ─────────────────────
// Lista SEPARADA para poder reportar un evento propio (ai-tool-detected) en el
// panel Seguridad. Se detectan y BLOQUEAN la reproducción (no se cierran).
// Se evitan nombres cortos/ambiguos (p.ej. "jan.exe" chocaría con "trojan.exe").
const AI_TOOLS = [
    'claude.exe',              // Claude Desktop
    'cursor.exe',              // Cursor (IDE con IA)
    'windsurf.exe',            // Windsurf / Codeium
    'antigravity.exe',         // Google Antigravity
    'ollama.exe', 'ollama app.exe', // Ollama (LLM local)
    'lmstudio.exe', 'lm studio.exe', // LM Studio (LLM local)
    'gpt4all.exe',             // GPT4All
    'anythingllm.exe',         // AnythingLLM
    'msty.exe',                // Msty
];

function isRdpSession() {
    return classifyRdpSession(process.env).state === 'remote';
}

function checkRemoteTools() {
    return new Promise((resolve) => {
        if (!IS_WIN) { resolve(false); return; }
        exec('tasklist /fo csv /nh', { timeout: 5000 }, (err, stdout) => {
            if (err) { log.warn('[SECURITY] Consulta de procesos no disponible.'); resolve(false); return; }
            const allow = _securityWhitelist.toolAllow || [];
            // 1) Herramientas "clásicas" (control remoto, descargadores, debuggers) → evento normal
            const found = findBlockedProcess(stdout, REMOTE_TOOLS, allow);
            if (found) { resolve(found); return; }
            // 2) Herramientas de IA (fijas + las que agregues en el panel) → etiqueta 'ai:'
            const aiList = AI_TOOLS.concat(_securityWhitelist.aiBlock || []);
            const ai = findBlockedProcess(stdout, aiList, allow);
            resolve(ai ? ('ai:' + ai) : false);
        });
    });
}

// Detecta herramientas de grabación/análisis renombradas comparando la firma
// digital del ejecutable con el editor que le corresponde a ese nombre.
//
// Tres resultados distintos, que antes se confundían en uno solo (R08):
//   'threat'      → el binario ESTÁ firmado y el editor no es el que debería.
//                   Es la única señal que se considera comprobada.
//   'unsigned'    → el binario no tiene firma. Se registra, pero no se trata como
//                   amenaza: hay compilaciones legítimas sin firmar y bloquear
//                   por esto expulsaría a gente que no ha hecho nada.
//   'unavailable' → la comprobación no se pudo hacer (sin PowerShell, tiempo
//                   agotado, permisos). No es lo mismo que "limpio".
//
// Esta señal nunca sustituye a la autorización del servidor: el acceso al
// contenido lo decide el servidor con la licencia y la sesión, no este sondeo.
const SIGNED_BY = {
    'chrome.exe':    'Google LLC',
    'msedge.exe':    'Microsoft Corporation',
    'firefox.exe':   'Mozilla Corporation',
    'iexplore.exe':  'Microsoft Corporation',
    'explorer.exe':  'Microsoft Windows',
    'notepad.exe':   'Microsoft',        // Win11 Store Notepad firma como "Microsoft Corporation"
    'powershell.exe':'Microsoft Windows',
    'cmd.exe':       'Microsoft Windows',
};

/**
 * Devuelve { state, name, publisher } donde state es 'clean', 'threat',
 * 'unsigned' o 'unavailable'. Nunca lanza.
 */
function inspectProcessSignatures() {
    return new Promise((resolve) => {
        if (!IS_WIN) { resolve({ state: 'unavailable', reason: 'no-windows' }); return; }
        const entries = Object.entries(SIGNED_BY).map(([name, pub]) =>
            `@{N='${name}';P='${pub.replace(/'/g, "''")}'}`).join(',');
        const ps = [
            `$ErrorActionPreference='SilentlyContinue';`,
            `$map=@(${entries});`,
            `$procs=Get-CimInstance Win32_Process | Where-Object { $map.N -icontains $_.Name } | Select-Object Name,ExecutablePath;`,
            `$sinFirma=@();`,
            `foreach($proc in $procs){`,
            `  if(-not $proc.ExecutablePath){continue};`,
            `  $s=Get-AuthenticodeSignature $proc.ExecutablePath -EA SilentlyContinue;`,
            `  $esperado=($map|Where-Object{$_.N -ieq $proc.Name}|Select-Object -First 1).P;`,
            `  if(-not $s -or $s.Status -eq 'NotSigned' -or -not $s.SignerCertificate){ $sinFirma += $proc.Name; continue };`,
            `  if($s.Status -ne 'Valid'){ $sinFirma += ($proc.Name + '#' + $s.Status); continue };`,
            // Se comparan los campos CN y O del certificado, no toda la cadena del
            // asunto: asi un texto que aparezca en cualquier otro campo no cuenta.
            `  $sujeto=[string]$s.SignerCertificate.Subject;`,
            `  $campos=@();`,
            `  foreach($parte in ($sujeto -split ',')){ $t=$parte.Trim(); if($t -match '^(CN|O)='){ $campos += $t.Substring(3) } };`,
            `  $coincide=$false;`,
            `  foreach($c in $campos){ if($c -like "*$esperado*"){ $coincide=$true } };`,
            `  if($esperado -and -not $coincide){ 'threat:' + $proc.Name; exit }`,
            `};`,
            `if($sinFirma.Count -gt 0){ 'unsigned:' + ($sinFirma -join '|'); exit };`,
            `'clean'`,
        ].join('');
        exec(powershellCommand(ps), { timeout: 10000 }, (err, stdout) => {
            const salida = (stdout || '').trim();
            if (err && !salida) { resolve({ state: 'unavailable', reason: err.killed ? 'timeout' : 'error' }); return; }
            if (!salida) { resolve({ state: 'unavailable', reason: 'sin-salida' }); return; }
            if (salida.startsWith('threat:')) {
                const name = salida.slice(7);
                log.warn('[SECURITY] Proceso firmado por un editor que no le corresponde:', name);
                resolve({ state: 'threat', name });
                return;
            }
            if (salida.startsWith('unsigned:')) {
                // Se registra, pero no se bloquea: no es prueba de nada por si solo.
                log.info('[SECURITY] Ejecutables sin firma válida (solo registro):', salida.slice(9));
                resolve({ state: 'unsigned', name: salida.slice(9) });
                return;
            }
            resolve({ state: salida.toLowerCase() === 'clean' ? 'clean' : 'unavailable' });
        });
    });
}

/** Compatibilidad con el consumidor actual: solo una amenaza comprobada bloquea. */
async function checkProcessSignatures() {
    const resultado = await inspectProcessSignatures();
    if (resultado.state === 'threat') return resultado.name;
    if (resultado.state === 'unavailable') return 'probe-unavailable:process-signatures';
    return false;
}

// ── Detección comportamental: proceso ajeno conectado a nuestro servidor ──────
// Observa procesos que comparten un destino de red. Una IP puede pertenecer a
// un CDN compartido o a servicios legítimos: esta señal sola no prueba descarga
// del curso y no bloquea la reproducción.
// Solo es útil cuando el player ya tiene al menos una conexión al API (durante
// la reproducción), por eso solo se llama desde el escaneo periódico, no al arrancar.
function checkUnauthorizedNetworkConnections() {
    return new Promise((resolve) => {
        if (!IS_WIN) { resolve(false); return; }
        const myPid = process.pid;
        // 1. Obtener las IPs remotas de nuestras conexiones activas
        // 2. Ver si otro proceso está conectado a esas mismas IPs
        // 3. Excluir PIDs del sistema (0 = idle, 4 = System, <10 = OS internos)
        // 4. Devolver el nombre del proceso intruso o false
        const ps = [
            `$myPid=${myPid};`,
            `$myIps=(Get-NetTCPConnection -OwningProcess $myPid -State Established -EA SilentlyContinue).RemoteAddress|`,
            `  Where-Object{$_ -and $_ -ne '0.0.0.0' -and $_ -ne '::'}|Sort-Object -Unique;`,
            `if(-not $myIps){'no-connections';exit};`,
            `$intruders=Get-NetTCPConnection -State Established -EA SilentlyContinue|`,
            `  Where-Object{$myIps -contains $_.RemoteAddress -and $_.OwningProcess -ne $myPid -and $_.OwningProcess -gt 10};`,
            `if(-not $intruders){'clean';exit};`,
            `$intrudePid=($intruders|Select-Object -First 1).OwningProcess;`,
            `$name=(Get-Process -Id $intrudePid -EA SilentlyContinue).Name;`,
            // Excluir procesos del sistema y herramientas legítimas que pueden tener
            // conexiones HTTPS por razones normales (actualizaciones, telemetría, etc.)
            // Solo bloquear si es un descargador real, no cmd/powershell abiertos por el usuario
            `$safeProcs=@('powershell','pwsh','cmd','explorer','svchost','lsass','wininit','services','taskhostw','searchindexer','onedrive','dropbox','googledrivefs','brave','msedge','chrome','firefox','opera');`,
            `if($name -and $safeProcs -contains $name.ToLower()){'clean';exit};`,
            `if($name){('intruder:'+$intrudePid+':'+$name)}else{('intruder:'+$intrudePid+':unknown')}`,
        ].join('');
        exec(powershellCommand(ps), { timeout: 8000 }, (err, out) => {
            if (err) { resolve(false); return; }
            const result = (out || '').trim();
            if (!result || result === 'clean' || result === 'no-connections') {
                resolve(false);
                return;
            }
            if (result.startsWith('intruder:')) {
                // formato: intruder:<pid>:<name>
                const parts = result.split(':');
                const name = parts.slice(2).join(':') || 'unknown';
                log.info('[SECURITY] Contexto de red compartido, sin atribuir descarga del curso:', name, '(PID', parts[1] + ')');
                resolve(false);
            } else {
                resolve(false);
            }
        });
    });
}

// ─── Lista blanca de seguridad (anti-falsos-positivos) ───────────────────────
// El servidor puede autorizar drivers/DLLs legítimos (MSI Afterburner, HWiNFO,
// overlays de Discord/Steam, etc.) y el hipervisor (VBS/Core Isolation) para no
// bloquear PCs de usuarios legítimos. Se descarga al arrancar, best-effort.
let _securityWhitelist = { drivers: [], dlls: [], allowHypervisor: false, aiBlock: [], toolAllow: [] };

async function fetchSecurityWhitelist() {
    const cfg  = getConfig();
    const base = (cfg.API_BASE || '').replace(/\/$/, '');
    if (!base) return;
    try {
        const data = await new Promise((resolve, reject) => {
            const urlObj = new URL(`${base}/api/security/whitelist`);
            const mod    = urlObj.protocol === 'https:' ? require('https') : require('http');
            const req    = mod.get(urlObj.href, { timeout: 8000 }, res => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse')); } });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
        _securityWhitelist = {
            drivers: Array.isArray(data.drivers) ? data.drivers.map(s => String(s).toLowerCase()) : [],
            dlls: Array.isArray(data.dlls) ? data.dlls.map(s => String(s).toLowerCase()) : [],
            allowHypervisor: data.allowHypervisor === true,
            aiBlock: Array.isArray(data.aiBlock) ? data.aiBlock.map(s => String(s).toLowerCase()) : [],
            toolAllow: Array.isArray(data.toolAllow) ? data.toolAllow.map(s => String(s).toLowerCase()) : [],
        };
    } catch { /* sin conexión → se mantienen los valores por defecto (todo se verifica) */ }
}

async function checkRemoteSession() {
    if (isRdpSession()) return 'rdp';
    const fridaActive = await checkFridaPort();
    if (fridaActive) return 'frida-agent.exe';
    const tool = await checkRemoteTools();
    if (tool) return tool;
    // Segunda capa: verificar que procesos con nombres "legítimos" tengan firma válida
    const spoofed = await checkProcessSignatures();
    if (spoofed && spoofed.startsWith('probe-unavailable:')) {
        // No haber podido comprobar no es lo mismo que haber encontrado algo (R08).
        console.warn('[security] Sondeo de firmas no disponible (no bloquea):', spoofed);
    } else if (spoofed) return spoofed;
    // Tercera capa: detectar entornos de virtualización (VM/hipervisor)
    const vm = await checkVirtualMachine();
    // IMPORTANTE (anti falso-positivo): el bit CPUID de hipervisor NO es evidencia
    // fiable de estar DENTRO de una VM. Windows 11 con Core Isolation / VBS /
    // Hyper-V / WSL2 / Windows Sandbox activa ese bit en equipos FÍSICOS. Por eso
    // 'cpuid-hypervisor' NUNCA bloquea (solo se usaría para monitoreo). Solo se
    // bloquea ante procesos propios de guest; una MAC virtual es sólo contexto.
    if (vm && vm !== 'cpuid-hypervisor') return `vm:${vm}`;
    // Cuarta capa: detectar rootkits (drivers maliciosos + DLL injection)
    const rootkit = await checkRootkitIndicators();
    if (rootkit && rootkit.startsWith('probe-unavailable:')) {
        console.warn('[security] Probe no disponible (no bloquea):', rootkit);
    } else if (rootkit) {
        return `rootkit:${rootkit}`;
    }
    return false;
}

// ── Detección de rootkits y drivers maliciosos ────────────────────────────────
// Técnica 1: drivers BYOVD conocidos (Bring Your Own Vulnerable Driver).
//   Son drivers LEGÍTIMOS con vulnerabilidades que el malware usa para operar
//   en ring-0. Tenerlos cargados es una señal de alerta fuerte.
// Técnica 2: drivers sin firma fuera de System32 (todos los rootkits necesitan uno).
// Técnica 3: módulos DLL inyectados en nuestro propio proceso.
const KNOWN_BAD_DRIVERS = [
    // BYOVD drivers más abusados (fuente: loldrivers.io)
    'rtcore64',     // MSI Afterburner — muy abusado por ransomware y cheaters
    'gdrv',         // GIGABYTE — abusado por BlackByte ransomware
    'mhyprot2',     // Genshin Impact — ampliamente abusado para matar AV
    'dbutil_2_3',   // Dell — usado por UNC2596
    'winring0x64',  // OpenHardwareMonitor — abusado por varios malwares
    'winring0',
    'kprocesshacker',  // Process Hacker kernel driver
    'procexp152',      // Sysinternals Process Explorer (versiones vulnerables)
    'capcom',          // Capcom driver — el más clásico de bypass HVCI
    'mimidrv',         // Mimikatz kernel driver
    'cpuz141_x64',     // CPU-Z vulnerable driver
    'aswarpot',        // Avast driver abusado
    'rentdrv2',        // Troyano rentdrv
    'daxin',           // Daxin rootkit
    'iqvw64e',         // Intel Network Adapter abusado
    'ntoskrnl_mhook',  // MHook library
    'asrdrv104',       // ASRock driver BYOVD
    'zemana',          // Zemana AntiLogger kernel component
];

// Asociación orientativa por nombre; no verifica proveedor, versión o vulnerabilidad.
const DRIVER_TO_PROGRAM = {
    'rtcore64':     'MSI Afterburner',
    'gdrv':         'GIGABYTE App Center / EasyTune',
    'mhyprot2':     'Genshin Impact',
    'dbutil_2_3':   'Dell Support Assist',
    'winring0x64':  'Open Hardware Monitor / HWiNFO',
    'winring0':     'Open Hardware Monitor / HWiNFO',
    'kprocesshacker': 'Process Hacker',
    'procexp152':   'Process Explorer (Sysinternals)',
    'capcom':       'programa desconocido con driver Capcom',
    'cpuz141_x64':  'CPU-Z',
};

function checkRootkitIndicators() {
    return new Promise((resolve) => {
        if (!IS_WIN) { resolve(false); return; }

        // Un solo proceso PowerShell ejecuta las 3 probes secuencialmente,
        // eliminando 2 cold starts de powershell.exe (~4-6s de ahorro).
        const psDrivers = driverProbe(KNOWN_BAD_DRIVERS, _securityWhitelist.drivers);
        const psUnsigned = unsignedDriverProbe(_securityWhitelist.drivers);
        const pid = process.pid;
        const psInject = dllProbe(pid, _securityWhitelist.dlls);

        const combined = [
            '$r1 = & { ' + psDrivers + ' }',
            'Write-Output "PROBE1:$r1"',
            '$r2 = & { ' + psUnsigned + ' }',
            'Write-Output "PROBE2:$r2"',
            '$r3 = & { ' + psInject + ' }',
            'Write-Output "PROBE3:$r3"',
        ].join('; ');

        exec(powershellCommand(combined), { timeout: 20000 }, (err, stdout) => {
            if (err) { resolve('probe-unavailable:drivers'); return; }
            const out = String(stdout || '');
            const m1 = out.match(/PROBE1:(.+)/);
            const m2 = out.match(/PROBE2:(.+)/);
            const m3 = out.match(/PROBE3:(.+)/);
            const v1 = m1 ? m1[1].trim() : '';
            const v2 = m2 ? m2[1].trim() : '';
            const v3 = m3 ? m3[1].trim() : '';

            const result1 = parseDriverProbeResult(null, v1, 'known-driver');
            if (result1.state === 'detected') { resolve(result1.name.toLowerCase()); return; }
            if (result1.state === 'unavailable') { resolve('probe-unavailable:drivers'); return; }

            const result2 = parseDriverProbeResult(null, v2, 'unsigned-driver');
            if (result2.state === 'detected') {
                resolve(result2.kind === 'driver-signature'
                    ? `driver-signature:${result2.signatureStatus}:${result2.name}`
                    : `unsigned-driver:${result2.name.toLowerCase()}`);
                return;
            }
            if (result2.state === 'unavailable') { resolve('probe-unavailable:driver-signatures'); return; }

            const result3 = parseDriverProbeResult(null, v3, 'module-anomaly');
            if (result3.state === 'detected') { resolve(`dll-inject:${result3.name}`); return; }

            resolve(false);
        });
    });
}

// ── Detección de máquinas virtuales ──────────────────────────────────────────
// Combina tres técnicas: procesos de VM, prefijos de MAC de VM, y bit de
// hipervisor en CPUID. Un atacante necesitaría hackear las tres para pasar.

// Procesos propios de motores de virtualización conocidos.
// REGLA: incluir SOLO procesos que corren DENTRO del guest (dentro de la VM),
// nunca procesos que corren en el HOST aunque VMware/VirtualBox esté instalado.
// Procesos HOST de VMware (vmnat, vmnetdhcp, vmware-authd, vmware-vmx,
// vmware-usbarbitrator) se excluyen deliberadamente para evitar falsos positivos.
const VM_PROCESSES = [
    // VMware Tools — solo corren DENTRO del guest
    'vmtoolsd.exe',    // VMware Tools daemon (guest)
    'vmwaretray.exe',  // VMware Tools tray (guest)
    'vmwareuser.exe',  // VMware Tools user (guest)
    // VirtualBox Guest Additions — solo corren DENTRO del guest
    'vboxservice.exe', // VirtualBox Guest Additions service
    'vboxtray.exe',    // VirtualBox tray (guest)
    // Hyper-V guest — 'vmmem' en el HOST indica VM activa pero no estamos dentro
    // 'vmms.exe' y 'vmcompute.exe' son del HOST — eliminados
    // QEMU Guest Agent — solo dentro del guest
    'qemu-ga.exe',
    // Parallels Tools — solo dentro del guest
    'prl_tools.exe', 'prl_cc.exe',
    // Xen Guest Utilities
    'xenservice.exe', 'xenkbd.exe',
];

// Prefijos OUI de tarjetas de red virtuales
const VM_MAC_PREFIXES = [
    '00:0c:29',  // VMware
    '00:50:56',  // VMware ESX/ESXi
    '00:05:69',  // VMware
    '08:00:27',  // VirtualBox
    '52:54:00',  // QEMU / KVM (libvirt)
    '00:16:3e',  // Xen
    '00:1c:14',  // VMware
    '00:15:5d',  // Hyper-V
    '00:03:ff',  // Hyper-V (antiguo)
];

function checkVirtualMachine() {
    return new Promise((resolve) => {
        if (!IS_WIN) { resolve(false); return; }

        // Técnica 1: procesos de VM en tasklist (reutiliza el tasklist de checkRemoteTools)
        exec('tasklist /fo csv /nh', { timeout: 5000 }, (err, stdout) => {
            if (!err) {
                const evidence = classifyVmEvidence({ guestProcess: findBlockedProcess(stdout, VM_PROCESSES) });
                if (evidence.state === 'guest') { resolve(evidence.process); return; }
            }

            // Técnica 2+3 combinadas: MAC + CPUID en un solo PowerShell
            const psCombined = [
                `$mac=(Get-NetAdapter | Where-Object { $_.Name -notlike '*VMnet*' -and $_.Name -notlike '*VirtualBox Host*' -and $_.Name -notlike '*Loopback*' -and $_.Name -notlike '*vEthernet*' -and $_.Name -notlike '*Default Switch*' -and $_.Name -notlike '*WSL*' -and $_.InterfaceDescription -notlike '*Hyper-V Virtual*' } | Select-Object -ExpandProperty MacAddress) -join ',';`,
                `Write-Output "MAC:$mac";`,
                `try{$h=(Get-CimInstance Win32_ComputerSystem -EA Stop).HypervisorPresent;if($h -eq $true){Write-Output 'CPUID:hypervisor'}else{Write-Output 'CPUID:bare-metal'}}catch{Write-Output 'CPUID:unknown'}`,
            ].join('');
            exec(powershellCommand(psCombined), { timeout: 8000 }, (e2, out) => {
                const output = String(out || '');
                const macMatch = output.match(/MAC:(.+)/);
                if (macMatch && macMatch[1].trim()) {
                    const context = classifyVmEvidence({ macPrefixes: matchingMacPrefixes(macMatch[1].trim(), VM_MAC_PREFIXES) });
                    if (context.state === 'context') log.info('[SECURITY] Adaptador virtual observado; no confirma un invitado VM.');
                }
                const cpuidMatch = output.match(/CPUID:(\S+)/);
                const result = cpuidMatch ? cpuidMatch[1].trim() : '';
                if (result === 'hypervisor') { resolve('cpuid-hypervisor'); return; }
                resolve(false);
            });
        });
    });
}

// Detecta el puerto de Frida gadget/server (27042 es el default)
function checkFridaPort() {
    return new Promise((resolve) => {
        const net = require('net');
        const s = new net.Socket();
        s.setTimeout(300);
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('error',   () => resolve(false));
        s.on('timeout', () => { s.destroy(); resolve(false); });
        s.connect(27042, '127.0.0.1');
    });
}

// ─── Secret de aplicación ────────────────────────────────────────────────────
// Ensamblado en runtime para evitar extracción trivial desde el ASAR extraído.
// El valor se inyecta en getConfig() y NUNCA aparece en config.json ni en logs.
function _getAppSecret() {
    const _a = [103,81,100,102,113,67,54,115];  // gQdfqC6s
    const _b = [122,101,84,51,76,67,68,117];    // zeT3LCDu
    const _c = [115,77,52,106,48,120,104,49];   // sM4j0xh1
    const _d = [88,49,77,81,98,118,56,103];     // X1MQbv8g
    const _e = [79,99,121,76,68,48,57,80];      // OcyLD09P
    const _f = [110,70,77];                     // nFM
    return [..._a,..._b,..._c,..._d,..._e,..._f].map(n => String.fromCharCode(n)).join('');
}

// ─── Configuración (dos niveles) ─────────────────────────────────────────────
// config.json bundleado = valores por defecto (nunca se modifica)
// userData/config.json  = preferencias del usuario (se escribe aquí)
const BUNDLED_CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULTS = {
    API_BASE:  'http://localhost:3000',
    VERSION:   '1.0.0',
    APP_NAME:  'Edulock Systems Player',
    PROTOCOL:  PROTOCOL,
    AUTO_UPDATE: false,
};

let bundled = {};
try { bundled = JSON.parse(fs.readFileSync(BUNDLED_CONFIG_PATH, 'utf-8')); } catch { /* ok */ }

let userConfig = {};
let USER_CONFIG_PATH = '';   // se asigna después de app.ready
let SESSION_PATH     = '';   // userData/session.json — sesión persistente

function loadUserConfig() {
    try {
        if (fs.existsSync(USER_CONFIG_PATH)) {
            userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf-8'));
        }
    } catch { userConfig = {}; }
}

function getConfig() {
    // APP_SECRET se inyecta aquí en runtime, nunca viene de config.json
    return { ...DEFAULTS, ...bundled, ...userConfig, APP_SECRET: _getAppSecret() };
}

function saveUserConfig(partial) {
    userConfig = { ...userConfig, ...partial };
    try {
        fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2), 'utf-8');
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ─── Verificación de versión forzada contra el servidor ─────────────────────
function compareSemver(a, b) {
    // -1 si a < b, 0 igual, 1 si a > b
    const pa = (a || '0.0.0').split('.').map(Number);
    const pb = (b || '0.0.0').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
}

async function checkServerVersion() {
    const cfg  = getConfig();
    const base = (cfg.API_BASE || '').replace(/\/$/, '');
    if (!base || IS_DEV) return;
    const currentVersion = app.getVersion();
    try {
        const versionData = await new Promise((resolve, reject) => {
            // ?platform= para comparar contra la versión propia de este SO
            // (así forzar update de Windows NO obliga a actualizar Mac/Linux).
            const _os = IS_WIN ? 'windows' : (IS_MAC ? 'macos' : 'linux');
            const urlObj = new URL(`${base}/api/player/version?platform=${_os}`);
            const mod    = urlObj.protocol === 'https:' ? require('https') : require('http');
            const req    = mod.get(urlObj.href, { timeout: 10000 }, res => {
                let d = '';
                res.on('data', c => d += c);
                res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse')); } });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });
        const { minVersion, downloadUrl, message, downloads } = versionData;
        const platformKey = IS_WIN ? 'windows' : (IS_MAC ? 'macos' : 'linux');
        const winUrl = downloads?.[platformKey] || downloadUrl;
        if (minVersion && compareSemver(currentVersion, minVersion) < 0) {
            const { response } = await dialog.showMessageBox(mainWindow || null, {
                type:      'warning',
                title:     'Actualización requerida',
                message:   '🔔 Nueva actualización disponible',
                detail:    (message || `Se requiere la versión ${minVersion} o superior.`) +
                           `\nVersión instalada: ${currentVersion}\nVersión requerida: ${minVersion}`,
                buttons:   ['Actualizar ahora', 'Cancelar'],
                defaultId: 0,
                cancelId:  1,
                noLink:    true,
            });
            if (response === 0 && winUrl) shell.openExternal(winUrl);
            app.quit();
        }
    } catch { /* servidor no disponible — no interrumpir */ }
}

// ─── Auto-updater (electron-updater) ─────────────────────────────────────────
let autoUpdater = null;
try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.logger = null;          // sin logs en consola en producción
    autoUpdater.autoDownload = false;   // preguntar al usuario antes de bajar
    autoUpdater.autoInstallOnAppQuit = true;
} catch { /* electron-updater no disponible en dev sin empaquetar */ }

function checkForUpdates() {
    if (!autoUpdater) return;
    const cfg = getConfig();
    if (!cfg.AUTO_UPDATE) return;

    autoUpdater.on('update-available', (info) => {
        if (!mainWindow) return;
        dialog.showMessageBox(mainWindow, {
            type:    'info',
            title:   'Actualización disponible',
            message: `Versión ${info.version} disponible.`,
            detail:  'Se descargará la actualización en segundo plano y se instalará al cerrar el reproductor.',
            buttons: ['Descargar ahora', 'Recordarme después'],
        }).then(({ response }) => {
            if (response === 0) autoUpdater.downloadUpdate();
        });
    });

    autoUpdater.on('update-downloaded', () => {
        if (!mainWindow) return;
        dialog.showMessageBox(mainWindow, {
            type:    'info',
            title:   'Actualización lista',
            message: 'La actualización se instalará al cerrar el reproductor.',
            buttons: ['Instalar ahora', 'Instalar al cerrar'],
        }).then(({ response }) => {
            if (response === 0) {
                autoUpdater.quitAndInstall();
            }
        });
    });

    autoUpdater.on('error', () => { /* silencioso — no interrumpir reproducción */ });

    try { autoUpdater.checkForUpdates(); } catch { /* sin servidor de actualización configurado */ }
}

// ─── Single-instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
    process.exit(0);
}

// ─── Registro del protocolo edulock:// ───────────────────────────────────────
if (profileDirectory) {
    // Do not replace the user's installed edulock:// association during acceptance.
} else if (IS_DEV) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
        path.resolve(process.argv[1] || __filename),
    ]);
} else {
    // En modo portable el ejecutable real vive en una carpeta temporal que Windows
    // puede borrar; registramos el .exe portable (el lanzador reenvía los argumentos)
    // para que el enlace edulock:// siga funcionando entre reinicios.
    const portableExe = IS_WIN && process.env.PORTABLE_EXECUTABLE_FILE;
    if (portableExe) app.setAsDefaultProtocolClient(PROTOCOL, portableExe, []);
    else app.setAsDefaultProtocolClient(PROTOCOL);
    // Si una versión anterior de ESTE ejecutable dejó registrado cdp://, lo
    // liberamos para no interferir con otros programas que usan ese esquema.
    try {
        if (app.isDefaultProtocolClient(LEGACY_PROTOCOL)) app.removeAsDefaultProtocolClient(LEGACY_PROTOCOL);
    } catch { /* sin permisos o esquema no registrado */ }
}

// ─── Ventana principal ────────────────────────────────────────────────────────
let mainWindow = null;
let authWindow = null;
let resourceSecurityBlocked = false;
const resourceWindows = createResourceWindows({ BrowserWindow, ipcMain, shell,
    getMainWindow: () => mainWindow, lookup: dnsFallbackLookup,
    getContext: () => ({ allowed: _userIsLoggedIn && !resourceSecurityBlocked,
        token: readSavedSession()?.token, deviceId: readDeviceIdSync(), apiBase: getConfig().API_BASE }) });

// Protección: ¿el usuario completó el login?
let _userIsLoggedIn = false;
// URL cdp:// recibida antes de que el usuario iniciara sesión — se despacha después del login
let _pendingCdpUrl = null;

function getIconPath() {
    const d = path.join(__dirname, 'assets');
    if (IS_WIN) return path.join(d, 'icon.ico');
    if (IS_MAC) return path.join(d, 'icon.icns');
    return path.join(d, 'icon.png');
}

function createWindow() {
    const iconPath = getIconPath();
    const iconExists = fs.existsSync(iconPath);

    mainWindow = new BrowserWindow({
        width:           1280,
        height:          720,
        minWidth:        800,
        minHeight:       480,
        title:           getConfig().APP_NAME,
        backgroundColor: '#000000',
        show:            false,          // se muestra después de ready-to-show
        icon:            iconExists ? iconPath : undefined,
        webPreferences: {
            preload:                     path.join(__dirname, 'preload.js'),
            contextIsolation:            true,
            nodeIntegration:             false,
            sandbox:                     false,   // desactivado para permitir webview con plugins DRM
            devTools:                    IS_DEV,
            webSecurity:                 true,
            allowRunningInsecureContent: false,
            webviewTag:                  true,    // requerido para VdoCipher DRM via webview
            plugins:                     true,    // habilita plugins nativos (Widevine CDM)
        },
    });

    // Protección contra capturas de pantalla y grabación de pantalla.
    // En Windows usa SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE):
    // la ventana aparece negra/vacía en screenshots y grabaciones,
    // pero se muestra con normalidad al usuario frente al monitor.
    // OJO: WDA_EXCLUDEFROMCAPTURE solo existe desde Windows 10 build 19041.
    // En builds anteriores (o algunos GPU/drivers/VM/RDP) la ventana se ve
    // NEGRA para el propio usuario. Por eso se activa solo cuando es seguro,
    // evitando la "pantalla negra" que reportaban unos pocos alumnos.
    let _cpSupported = true;
    if (process.platform === 'win32') {
        const _build = parseInt((require('os').release().split('.')[2] || '0'), 10);
        _cpSupported = _build >= 19041;
    }
    if (_cpSupported) {
        mainWindow.setContentProtection(true);
    } else {
        console.warn('[player] Anti-captura desactivado: Windows build < 19041 (evita pantalla negra para el usuario).');
    }

    // Mostrar solo cuando el auth haya sido exitoso (via auth-success IPC)
    // mainWindow.once('ready-to-show', () => { mainWindow.show(); ... });
    // DevTools solo en dev (diagnóstico: usar F12 en menú contextual en producción)
    if (IS_DEV) {
        mainWindow.once('ready-to-show', () => {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
        });
    }

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    // Bloquear navegación externa
    mainWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('file://')) {
            e.preventDefault();
            openExternalSafely(url);   // solo http/https, nunca otros esquemas
        }
    });

    // Bloquear apertura de nuevas ventanas
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Avisar al renderer cuando cambia el estado de pantalla completa (actualiza icono)
    mainWindow.on('enter-full-screen', () => {
        if (mainWindow) mainWindow.webContents.send('fullscreen-changed', true);
    });
    mainWindow.on('leave-full-screen', () => {
        if (mainWindow) mainWindow.webContents.send('fullscreen-changed', false);
    });

    mainWindow.on('closed', () => { resourceWindows.invalidate(); mainWindow = null; });
}

function createAuthWindow() {
    const iconPath   = getIconPath();
    const iconExists = fs.existsSync(iconPath);

    authWindow = new BrowserWindow({
        width:           480,
        height:          620,
        resizable:       false,
        title:           'Iniciar sesión',
        backgroundColor: '#0d0d1a',
        show:            false,
        icon:            iconExists ? iconPath : undefined,
        webPreferences: {
            preload:          path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration:  false,
            sandbox:          true,
            devTools:         IS_DEV,
            webSecurity:      true,
        },
    });

    authWindow.setContentProtection(true);
    authWindow.setMenuBarVisibility(false);

    authWindow.once('ready-to-show', () => {
        authWindow.show();
        if (IS_DEV) authWindow.webContents.openDevTools({ mode: 'detach' });
    });

    authWindow.loadFile(path.join(__dirname, 'renderer', 'auth.html'));
    // Allow Firebase Google OAuth popups; deny everything else
    authWindow.webContents.setWindowOpenHandler(({ url }) => {
        // Se compara el host exacto, no una subcadena: con includes(), una
        // direccion como https://sitio.ajeno/?x=accounts.google.com pasaba el
        // filtro y se abria una ventana con la pagina del atacante (R04).
        if (isAuthWindowUrl(url)) {
            return { action: 'allow', overrideBrowserWindowOptions: { width: 500, height: 620, webPreferences: { sandbox: true } } };
        }
        return { action: 'deny' };
    });

    // If user closes auth window without logging in, quit the app
    authWindow.on('closed', () => {
        authWindow = null;
        // Solo cerrar si el login NO fue completado
        // (evita race condition: mainWindow.show() se llama async en did-finish-load)
        if (!_userIsLoggedIn) app.quit();
    });
}

// ─── Menú de aplicación minimal ──────────────────────────────────────────────
function buildAppMenu() {
    const cfg = getConfig();
    const template = [
        {
            label: 'Archivo',
            submenu: [
                { label: 'Cerrar reproductor', accelerator: 'Alt+F4', click: () => { if (mainWindow) mainWindow.close(); } },
                { type: 'separator' },
                { label: 'Salir', role: 'quit' },
            ],
        },
        {
            label: 'Reproducción',
            submenu: [
                { label: 'Pantalla completa', accelerator: 'F11', click: () => {
                    if (!mainWindow) return;
                    mainWindow.setFullScreen(!mainWindow.isFullScreen());
                }},
                { label: 'Salir de pantalla completa', accelerator: 'Escape', click: () => {
                    if (mainWindow?.isFullScreen()) mainWindow.setFullScreen(false);
                }},
            ],
        },
        {
            label: 'Ayuda',
            submenu: [
                { label: `${cfg.APP_NAME} v${cfg.VERSION}`, enabled: false },
                { type: 'separator' },
                { label: 'Abrir campus en el navegador', click: () => {
                    shell.openExternal(cfg.API_BASE);
                }},
                IS_DEV ? { label: 'DevTools', accelerator: 'F12', click: () => mainWindow?.webContents.openDevTools() } : null,
                IS_DEV ? { label: 'DevTools Webview', accelerator: 'F11', click: () => {
                    const wv = mainWindow?.webContents;
                    // Abrir devtools del webview vdo-frame si existe
                    mainWindow?.webContents.executeJavaScript(`
                        (function(){ const wv = document.getElementById('vdo-frame');
                        if(wv && wv.openDevTools) wv.openDevTools(); })()
                    `).catch(()=>{});
                }} : null,
            ].filter(Boolean),
        },
    ];

    // En macOS hay que adaptar el menú de aplicación
    if (IS_MAC) {
        template.unshift({
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        });
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Parseo de URL edulock:// ─────────────────────────────────────────────────
function parseCdpUrl(rawUrl) {
    try {
        const url  = new URL(normalizeDeepLink(rawUrl));
        const t    = url.searchParams.get('t')    || '';
        const p    = url.searchParams.get('p')    || '';
        const cmd  = url.searchParams.get('cmd')  || '';
        const auth = url.searchParams.get('auth') || '';
        if (t)           return { t };          // short-token (nuevo formato)
        if (p)           return { p };          // enlace permanente
        if (cmd && auth) return { cmd, auth };  // formato legado
        return null;
    } catch {
        return null;
    }
}

// CHECK-IN de apertura: apenas llega el deep link edulock://, avisamos al servidor
// que la app abrió realmente (aunque el usuario aún no haya iniciado sesión).
// Así la página web sabe con certeza que el reproductor está instalado y abrió.
function _pingLaunchCheckin(rawUrl) {
    try {
        const url = new URL(normalizeDeepLink(rawUrl));
        const lt  = url.searchParams.get('lt') || '';
        if (!lt) return;
        const apiBase = (getConfig().API_BASE || '').replace(/\/$/, '');
        if (!apiBase) return;
        httpFetch(`${apiBase}/api/public/launch/checkin`, { method: 'POST' }, { launchToken: lt })
            .catch(() => {});
    } catch { /* silencioso */ }
}

function dispatchCdpUrl(rawUrl) {
    // CHECK-IN: apenas llega el deep link, confirmamos al servidor que la app
    // abrió realmente (aunque el usuario aún no haya iniciado sesión). Así la
    // página web sabe con certeza que el reproductor está instalado y se abrió.
    _pingLaunchCheckin(rawUrl);
    if (!mainWindow) return;
    // SEGURIDAD: bloquear reproducción si el usuario no ha iniciado sesión
    if (!_userIsLoggedIn) {
        _pendingCdpUrl = rawUrl;          // guardar para despachar después del login
        if (authWindow) { authWindow.focus(); }
        return;
    }
    const parsed = parseCdpUrl(rawUrl);
    const resourceId = parseResourceLink(rawUrl);
    if (resourceId) {
        void resourceWindows.open(resourceId).then(result => {
            if (!result.ok && mainWindow && !mainWindow.isDestroyed())
                void dialog.showMessageBox(mainWindow, { type: 'info', title: 'Documento', message: result.error });
        });
        return;
    }
    if (!parsed) return;
    mainWindow.webContents.send('cdp-play', parsed);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
}

// ─── Segunda instancia / open-url ────────────────────────────────────────────
app.on('second-instance', (_event, argv) => {
    const cdpArg = argv.find(a => DEEP_LINK_RE.test(a));
    if (cdpArg) dispatchCdpUrl(cdpArg);
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.on('open-url', (event, url) => {
    event.preventDefault();
    if (app.isReady()) dispatchCdpUrl(url);
    else app.once('ready', () => dispatchCdpUrl(url));
});

// ─── Sesión persistente ─────────────────────────────────────────────────────
function _decodeJwtPayload(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    } catch { return null; }
}

// ── Sesion guardada: protegida con el almacen del sistema operativo ─────────
// El archivo contenia el token de la cuenta en texto plano dentro de userData.
// Ahora se cifra con safeStorage (DPAPI en Windows, Llavero en macOS, libsecret
// en Linux). Compatibilidad: un archivo antiguo en texto plano se sigue leyendo
// y se vuelve a escribir cifrado la primera vez, sin que el alumno note nada.
// Si el sistema no ofrece cifrado (por ejemplo, Linux sin llavero), se conserva
// el comportamiento anterior y se deja constancia, en vez de impedir el uso.
function writeSessionFile(data) {
    const plano = JSON.stringify(data);
    try {
        if (safeStorage && safeStorage.isEncryptionAvailable()) {
            const sobre = JSON.stringify({ v: 1, enc: safeStorage.encryptString(plano).toString('base64') });
            fs.writeFileSync(SESSION_PATH, sobre, { encoding: 'utf8', mode: 0o600 });
            return true;
        }
    } catch (e) { log.warn('[SESSION] no se pudo cifrar la sesion:', e.message); }
    fs.writeFileSync(SESSION_PATH, plano, { encoding: 'utf8', mode: 0o600 });
    return true;
}

function readSessionFile() {
    let raw;
    try { raw = fs.readFileSync(SESSION_PATH, 'utf8'); } catch { return null; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (parsed && parsed.v === 1 && typeof parsed.enc === 'string') {
        try { return JSON.parse(safeStorage.decryptString(Buffer.from(parsed.enc, 'base64'))); }
        catch (e) { log.warn('[SESSION] la sesion guardada no se pudo descifrar:', e.message); return null; }
    }
    // Archivo antiguo en texto plano: se migra a cifrado en el acto.
    try { writeSessionFile(parsed); } catch {}
    return parsed;
}

function isSavedSessionValid() {
    try {
        const session = readSessionFile();
        if (!session || !session.token) return false;
        const payload = _decodeJwtPayload(session.token);
        if (!payload) return false;
        // Sin exp = token permanente (alumnos con acceso sin caducidad)
        if (!payload.exp) return true;
        // Válida si faltan más de 1 hora para expirar
        return Date.now() < (payload.exp * 1000 - 3_600_000);
    } catch { return false; }
}

// Lee la sesión guardada (sin validar expiración). Devuelve el objeto o null.
function readSavedSession() {
    try { return readSessionFile(); }
    catch { return null; }
}

// Lee el deviceId persistido (device_id.txt) de forma síncrona, o null.
function readDeviceIdSync() {
    try {
        const p = path.join(app.getPath('userData'), 'device_id.txt');
        const v = fs.readFileSync(p, 'utf8').trim();
        return v || null;
    } catch { return null; }
}

/**
 * Decide si el usuario puede entrar directamente al reproductor sin pasar por
 * la pantalla de autenticación/activación.
 *
 * REGLA DE SEGURIDAD:
 *   - La sesión de login debe ser válida (no expirada).
 *   - Admin: entra directo (no usa licencias DRM).
 *   - Alumno: ADEMÁS debe tener una activación DRM local válida para este
 *     dispositivo. Sin activación → NO entra (se le pedirá la licencia).
 *   Esto cierra el hueco por el que un alumno sin licencia activada podía
 *   acceder al contenido solo por tener la sesión guardada.
 */
function canEnterDirectly() {
    if (!isSavedSessionValid()) return false;

    const session = readSavedSession();
    // Admin no requiere activación DRM
    if (session && session.role === 'admin') return true;

    // Alumno: exigir activación DRM local para este dispositivo
    try {
        const actStore = require('./activation-store');
        const devId = readDeviceIdSync();
        if (!devId) return false;
        return actStore.hasActivation(devId);
    } catch (e) {
        // En caso de error leyendo la activación, NO permitir el acceso directo
        // (fail-closed): es preferible volver a pedir la licencia.
        log.warn('[ACTIVATION] canEnterDirectly check error:', e.message);
        return false;
    }
}

ipcMain.handle('save-session', (_e, data) => {
    try { resourceWindows.invalidate(); writeSessionFile(data); return true; }
    catch { return false; }
});

ipcMain.handle('get-session', () => {
    try {
        if (!fs.existsSync(SESSION_PATH)) return null;
        return readSessionFile();
    } catch { return null; }
});

ipcMain.handle('clear-session', () => {
    resourceWindows.invalidate();
    stopTokenRefresh();
    try { if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH); return true; }
    catch { return false; }
});

let _refreshTimer = null;
function startTokenRefresh() {
    stopTokenRefresh();
    _refreshTimer = setInterval(async () => {
        try {
            const saved = readSavedSession();
            if (!saved || !saved.token) return;
            const parts = saved.token.split('.');
            if (parts.length !== 3) return;
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
            const expMs = (payload.exp || 0) * 1000;
            const remaining = expMs - Date.now();
            if (remaining > 10 * 60 * 1000) return;
            if (remaining < -24 * 60 * 60 * 1000) return;
            const cfg = getConfig();
            const r = await httpFetch(
                `${cfg.API_BASE}/api/auth/refresh`,
                { method: 'POST', headers: { Authorization: `Bearer ${saved.token}` } }
            );
            if (r.status === 200 && r.body && r.body.token) {
                writeSessionFile({ ...saved, token: r.body.token });
                log.info('[TOKEN-REFRESH] token renovado automaticamente');
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('token-refreshed', r.body.token);
                }
            }
        } catch (e) { log.warn('[TOKEN-REFRESH] error:', e.message); }
    }, 5 * 60 * 1000);
    _refreshTimer.unref?.();
}
function stopTokenRefresh() {
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}

let _eduEpoch = 0;
function clearEduBuffers(contentId) {
    _eduEpoch++;
    for (const [id, state] of _eduBuffers) {
        if (contentId && id !== contentId) continue;
        state.closed = true;
        state.cek?.fill(0);
        state.tKey?.fill(0);
        _eduBuffers.delete(id);
    }
}

// ── DRM .edu: abrir contenido protegido (descargar + descifrar en RAM) ────────
ipcMain.handle('edu-open', async (_e, { contentId, deviceId, mediaToken } = {}) => {
    const epoch = _eduEpoch;
    try {
        if (!contentId) return { ok: false, error: 'contentId requerido' };
        const cfg = getConfig();
        const apiBase = (cfg.API_BASE || '').replace(/\/$/, '');
        if (!apiBase) return { ok: false, error: 'Servidor no configurado' };

        // Token de sesión del alumno (login persistido en disco).
        let token = '';
        try { if (fs.existsSync(SESSION_PATH)) token = (readSessionFile() || {}).token || ''; } catch {}
        if (!token || !_userIsLoggedIn) return { ok: false, error: 'No hay sesión. Inicia sesión de nuevo.' };
        token = mediaToken || token;

        // 1) Clave online por sesión (el servidor valida licencia/acceso).
        const kr = await httpFetch(`${apiBase}/api/edu/key`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } }, { contentId, deviceId });
        if (kr.status !== 200 || !kr.body || !kr.body.cek) return { ok: false, code: kr.body?.code,
            error: kr.body?.error || 'No se pudo obtener la clave (' + kr.status + ')' };
        const cek = Buffer.from(kr.body.cek, 'hex');
        const watermark = kr.body.watermark || '';

        // 2) Descargar el .edu cifrado (proxy desde Bunny).
        const eduBuf = await httpGetBuffer(`${apiBase}/api/edu/data/${encodeURIComponent(contentId)}?token=${encodeURIComponent(token)}`);

        // 3) Abrir el .edu (verifica HMAC + cabecera). NO se descifra el video aquí:
        //    el mp4 se descifra por trozos, bajo demanda, según lo pide el <video>.
        //    En RAM solo queda el .edu CIFRADO (inútil sin la CEK) + la CEK.
        const state = openEdu(eduBuf, cek);
        if (epoch !== _eduEpoch || !_userIsLoggedIn) { state.cek.fill(0); state.tKey.fill(0); return { ok: false, error: 'Reproducción cancelada' }; }
        _eduBuffers.set(contentId, state);
        return { ok: true, url: `edu://media/${encodeURIComponent(contentId)}`, watermark };
    } catch (e) {
        log.warn('[EDU] edu-open error:', e.message);
        return { ok: false, error: e.message || 'Error abriendo contenido protegido' };
    }
});
ipcMain.handle('edu-close', (_e, contentId) => {
    clearEduBuffers(contentId);
    return true;
});

// ─── Habilitar Widevine CDM (CastLabs Electron nativo) ───────────────────────
// CastLabs Electron incluye widevinecdm.dll empaquetado — no depende de Chrome.
// Si no está disponible (Electron normal), cae al fallback buscando Chrome.
function loadWidevineCDM() {
    // 1. CastLabs: el CDM viene en la carpeta del ejecutable de Electron
    try {
        const exeDir = path.dirname(process.execPath);
        const castlabsCdm = path.join(exeDir, 'WidevineCdm', '_platform_specific', 'win_x64', 'widevinecdm.dll');
        const castlabsMf  = path.join(exeDir, 'WidevineCdm', 'manifest.json');
        if (fs.existsSync(castlabsCdm) && fs.existsSync(castlabsMf)) {
            const manifest = JSON.parse(fs.readFileSync(castlabsMf, 'utf8'));
            app.commandLine.appendSwitch('widevine-cdm-path', castlabsCdm);
            app.commandLine.appendSwitch('widevine-cdm-version', manifest.version || '4.10.2557.0');
            log.info('[DRM] Widevine CDM nativo CastLabs cargado: v' + manifest.version);
            return true;
        }
    } catch (e) {
        log.warn('[DRM] CastLabs CDM no encontrado, intentando Chrome:', e.message);
    }

    // 2. Fallback: buscar en Chrome instalado (Electron normal)
    if (!IS_WIN) return false;
    const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application',
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application'),
    ];
    for (const chromeBase of chromePaths) {
        try {
            if (!fs.existsSync(chromeBase)) continue;
            const versions = fs.readdirSync(chromeBase)
                .filter(e => /^\d+\.\d+/.test(e))
                .sort((a, b) => {
                    const pa = a.split('.').map(Number);
                    const pb = b.split('.').map(Number);
                    for (let i = 0; i < 4; i++) if ((pa[i]||0) !== (pb[i]||0)) return (pb[i]||0) - (pa[i]||0);
                    return 0;
                });
            for (const ver of versions) {
                const wvDir = path.join(chromeBase, ver, 'WidevineCdm');
                const wvDll = path.join(wvDir, '_platform_specific', 'win_x64', 'widevinecdm.dll');
                const wvMf  = path.join(wvDir, 'manifest.json');
                if (fs.existsSync(wvDll) && fs.existsSync(wvMf)) {
                    const manifest = JSON.parse(fs.readFileSync(wvMf, 'utf8'));
                    if (manifest.version) {
                        app.commandLine.appendSwitch('widevine-cdm-path', wvDll);
                        app.commandLine.appendSwitch('widevine-cdm-version', manifest.version);
                        log.info('[DRM] Widevine CDM cargado desde Chrome:', wvDll, 'v' + manifest.version);
                        return true;
                    }
                }
            }
        } catch (e) {
            log.warn('[DRM] Error buscando Widevine en Chrome:', e.message);
        }
    }
    log.warn('[DRM] Widevine CDM no encontrado — instala CastLabs Electron o Google Chrome para reproducción DRM');
    return false;
}

loadWidevineCDM();
app.commandLine.appendSwitch('enable-features', 'PlatformEncryptedContentIDs,ProtectedContentDelegation');
app.commandLine.appendSwitch('enable-blink-features', 'EncryptedMediaAnyOrigin');

// ─── Bloqueo de seguridad (llamado desde el chequeo de fondo) ────────────────
async function _handleSecurityBlock(remoteResult) {
    const isRdp     = remoteResult === 'rdp';
    const isVm      = typeof remoteResult === 'string' && remoteResult.startsWith('vm:');
    const isRootkit = typeof remoteResult === 'string' && remoteResult.startsWith('rootkit:');
    const isDllInject = typeof remoteResult === 'string' && remoteResult.startsWith('rootkit:dll-inject:');
    const isUnsigned  = typeof remoteResult === 'string' && remoteResult.startsWith('rootkit:unsigned-driver:');
    const isSignature = typeof remoteResult === 'string' && remoteResult.startsWith('rootkit:driver-signature:');
    const isAi      = typeof remoteResult === 'string' && remoteResult.startsWith('ai:');
    const appName   = typeof remoteResult === 'string' && !isRdp && !isVm && !isRootkit
        ? remoteResult.replace(/^ai:/, '').replace('.exe', '') : null;

    let message, detail;
    if (isSignature) {
        const signatureParts = remoteResult.slice('rootkit:driver-signature:'.length).split(':');
        message = 'No se pudo validar la firma de un controlador';
        detail = `Controlador: ${signatureParts.slice(1).join(':')}. Estado de Windows: ${signatureParts[0]}.\n\nLa política requiere una firma válida para este controlador.`;
    } else if (isRootkit) {
        const driverRaw = remoteResult.replace('rootkit:dll-inject:', '').replace('rootkit:unsigned-driver:', '').replace('rootkit:', '')
            .split('\\').pop().replace('.sys', '').replace('.dll', '').toLowerCase();
        const programName = DRIVER_TO_PROGRAM[driverRaw] || driverRaw;
        if (isDllInject) { message = 'Módulo pendiente de verificación'; detail = `El reproductor cargó el módulo "${driverRaw}" desde una ruta que requiere revisión.`; }
        else if (isUnsigned) { message = 'Driver del sistema sin firma detectado'; detail = `Windows devolvió NotSigned para el controlador activo "${driverRaw}".`; }
        else { message = 'Controlador bloqueado por la política de seguridad'; detail = `Se detectó un controlador activo: "${driverRaw}" (${programName}).`; }
    } else if (isVm) {
        message = 'Entorno de virtualización detectado';
        detail = 'El reproductor no puede ejecutarse dentro de una VM. Instálalo directamente en tu equipo físico.';
    } else if (isRdp) {
        message = 'Sesión remota detectada';
        detail = 'Se detectó una sesión de Escritorio Remoto (RDP). Cierra la conexión remota e intenta de nuevo.';
    } else if (isAi) {
        message = 'Herramienta de inteligencia artificial detectada';
        detail = `Se detectó "${appName}" en ejecución. Ciérrala completamente para usar el reproductor.`;
    } else {
        message = 'Acceso bloqueado';
        detail = appName
            ? `Se detectó "${appName}" en ejecución. Cierra las aplicaciones de control remoto, grabación de pantalla o de inteligencia artificial.`
            : 'Cierra las aplicaciones de control remoto, grabación de pantalla o de inteligencia artificial.';
    }

    const _evt = isDllInject ? 'module-anomaly' : isSignature ? 'driver-signature-unverified'
               : isRootkit ? 'rootkit-detected' : isVm ? 'vm-detected' : isRdp ? 'remote-session-rdp'
               : isAi ? 'ai-tool-detected' : 'remote-tool-detected';
    reportSecurityEvent(_evt, 'unknown', { raw: String(remoteResult).slice(0, 120) });

    await dialog.showMessageBox({
        type: 'error', title: 'Edulock Systems Player — Acceso bloqueado',
        message, detail, buttons: ['Entendido — Cerrar'],
    });
    app.quit();
}

// ─── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    // Load the selected server before version checks, security policy or events.
    USER_CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
    SESSION_PATH = path.join(app.getPath('userData'), 'session.json');
    loadUserConfig();
    // ── Fallback DNS para Chromium (streaming de video, Firebase SDK) ───────
    // Si el DNS del sistema no resuelve nuestro dominio, Chromium intenta
    // DNS-over-HTTPS (Cloudflare/Google) automáticamente.
    try {
        app.configureHostResolver({
            secureDnsMode: 'automatic',
            secureDnsServers: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
        });
        log.info('[DNS] Host resolver de Chromium con fallback DoH configurado');
    } catch (e) {
        log.warn('[DNS] configureHostResolver no disponible:', e.message);
    }

    // ── Protocolo edu:// — sirve el mp4 descifrado (en RAM) al <video> con Range ─
    // El mp4 nunca toca el disco; vive solo en el proceso principal.
    try {
        protocol.handle('edu', (request) => {
            let id = '';
            try { const u = new URL(request.url); id = decodeURIComponent((u.pathname || '').replace(/^\/+/, '')) || u.hostname; } catch { id = ''; }
            const st = _eduBuffers.get(id);
            if (!st) return new Response('not found', { status: 404 });
            const total = st.origLen;
            const base = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
            const range = request.headers.get('range') || request.headers.get('Range');
            const parsed = parseByteRange(range, total);
            if (!parsed) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${total}` } });
            const { start, end } = parsed;
            const status = parsed.partial ? 206 : 200;
            // Stream por trozos: se descifra SOLO la ventana pedida, nunca el mp4 entero.
            const CH = st.chunkSize;
            let pos = start;
            const stream = new ReadableStream({
                pull(controller) {
                    try {
                        if (pos > end) { controller.close(); return; }
                        const to = Math.min(pos + CH - 1, end);
                        controller.enqueue(new Uint8Array(readRange(st, pos, to)));
                        pos = to + 1;
                    } catch (e) { controller.error(e); }
                },
            });
            const headers = { ...base, 'Content-Length': String(end - start + 1) };
            if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
            return new Response(stream, { status, headers });
        });
        log.info('[EDU] protocolo edu:// registrado (streaming por trozos)');
    } catch (e) {
        log.warn('[EDU] protocol.handle falló:', e.message);
    }

    // ── CastLabs: esperar que Widevine CDM esté listo antes de abrir ventana ─
    if (components) {
        try {
            await components.whenReady();
            log.info('[DRM] CastLabs components listos:', components.status());
        } catch (e) {
            log.warn('[DRM] components.whenReady() falló:', e.message);
        }
    }

    // ── Permisos DRM para VdoCipher ──────────────────────────────────────────
    // Permite que el webview de VdoCipher solicite Widevine/protected-media
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media' || permission === 'protected-media-identifier' ||
            permission === 'clipboard-sanitized-write') {
            callback(true);
            return;
        }
        callback(false);
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
        if (permission === 'protected-media-identifier' || permission === 'media') return true;
        return null;
    });
    // Permitir el dominio de VdoCipher en la política de contenido
    session.defaultSession.webRequest.onHeadersReceived({ urls: ['*://player.vdocipher.com/*'] }, (details, callback) => {
        const headers = { ...details.responseHeaders };
        headers['access-control-allow-origin'] = ['*'];
        callback({ responseHeaders: headers });
    });

    // ── Certificate pinning ──────────────────────────────────────────────────
    // Bloquea proxies MITM (mitmproxy, Burp Suite, Fiddler, Charles, etc.)
    // y CAs no reconocidas para los hosts críticos de la app.
    const _reportedCertIssues = new Set(); // dedupe: reporta cada issue una sola vez
    for (const playbackSession of [session.defaultSession, session.fromPartition('persist:vdo')]) {
        playbackSession.setCertificateVerifyProc((request, callback) => {
            callback(certificateDecision(request));
        });
    }

    // Descargar la lista blanca de seguridad ANTES de los chequeos anti-manipulación
    // para no bloquear PCs legítimas autorizadas por el administrador.
    loadUserConfig();

    // ── Crear la ventana y mostrarla de inmediato ─────────────────────────────
    // Los chequeos de seguridad corren de fondo: el usuario ve el reproductor
    // abrirse rápido. Si se detecta amenaza real, se bloquea después.
    Menu.setApplicationMenu(null);
    createWindow();

    if (canEnterDirectly()) {
        _userIsLoggedIn = true;
        startTokenRefresh();
        mainWindow.once('ready-to-show', () => mainWindow.show());
    } else {
        createAuthWindow();  // primera vez, sesión expirada o sin activación DRM
    }

    // Capturar URL edulock:// si la app se lanzó directamente con ella (Windows)
    const cdpArg = process.argv
        .slice(IS_DEV ? 2 : 1)
        .find(a => DEEP_LINK_RE.test(a));

    if (cdpArg) {
        mainWindow.webContents.once('did-finish-load', () => dispatchCdpUrl(cdpArg));
    }

    // ── Chequeo de seguridad inicial (de fondo, no bloquea el arranque) ────────
    // Corre la whitelist + chequeo de amenazas + Secure Boot/HVCI sin hacer
    // esperar al usuario. Si hay amenaza real, bloquea en ese momento.
    syncServerClock();
    setInterval(syncServerClock, 30 * 60 * 1000).unref?.();

    (async () => {
        try {
            await fetchSecurityWhitelist();
            if (!IS_DEV) {
                const remoteResult = await checkRemoteSession();
                if (remoteResult) {
                    // Admin exento de detección de herramientas de IA
                    const isAiThreat = typeof remoteResult === 'string' && remoteResult.startsWith('ai:');
                    if (isAiThreat && readSavedSession()?.role === 'admin') {
                        log.info('[SECURITY] AI tool detectada en arranque pero usuario es admin — ignorado:', remoteResult);
                    } else {
                        _handleSecurityBlock(remoteResult);
                        return;
                    }
                }
            }
            // Secure Boot + HVCI — solo monitoreo, no bloquean
            if (IS_WIN && !IS_DEV) {
                const psCombined = [
                    `$ErrorActionPreference='Stop';`,
                    `try{$sb=Confirm-SecureBootUEFI;if($sb){'sb:true'}else{'sb:false'}}catch{'sb:unknown'};`,
                    `try{$p='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity';`,
                    `$v=(Get-ItemProperty -LiteralPath $p -EA Stop).Enabled;`,
                    `if($v -eq 1){'hvci:true'}elseif($v -eq 0){'hvci:false'}else{'hvci:unknown'}}catch{'hvci:unknown'}`,
                ].join('');
                exec(powershellCommand(psCombined), { timeout: 8000 }, (err, stdout) => {
                    const out = String(stdout || '');
                    if (/sb:false/.test(out)) { log.warn('[SECURITY] Secure Boot desactivado.'); reportSecurityEvent('secure-boot-disabled', 'unknown', { value: false }); }
                    if (/hvci:false/.test(out)) { log.warn('[SECURITY] HVCI desactivado.'); reportSecurityEvent('hvci-disabled', 'unknown', { hvci: false }); }
                });
            }
        } catch (e) {
            log.warn('[SECURITY] Error en chequeo inicial de fondo:', e.message);
        }
    })();

    // Verificar versión mínima en el servidor (5s tras arrancar, luego cada 5 min)
    // Estricto: si el admin publica una nueva versión mínima, el reproductor
    // detecta el cambio en pocos minutos y obliga a actualizar (cierra la app).
    setTimeout(() => {
        checkServerVersion();
        setInterval(checkServerVersion, 5 * 60 * 1000);
    }, 5000);

    // Verificar actualizaciones 5 segundos después de arrancar
    setTimeout(checkForUpdates, 5000);

    // ── Guardia de licencia ───────────────────────────────────────────────────
    // Detecta si el admin regeneró/revocó la licencia: valida al abrir (3s) y
    // luego cada 60s mientras el reproductor está en uso. Si ya no es válida,
    // expulsa al formulario de licencia (no permite seguir reproduciendo).
    setTimeout(runLicenseGuardCheck, 3000);
    setInterval(runLicenseGuardCheck, 60 * 1000);

    // Recargar whitelist de seguridad cada 60s para reflejar cambios del admin
    setInterval(() => { fetchSecurityWhitelist().catch(() => {}); }, 60_000);

    // Verificar sesión remota / herramientas de descarga cada 10 segundos durante uso
    if (!IS_DEV) {
        let _isBlocked   = false; // true mientras hay una amenaza activa
        let _scanRunning = false; // evitar solapamiento de escaneos

        setInterval(async () => {
            if (!mainWindow || _scanRunning) return;
            _scanRunning = true;

            try {
                // Capa 1: nombre de proceso conocido (grabación, análisis, descarga, RDP)
                let remote = await checkRemoteSession();

                // Capa 2 (comportamental): proceso ajeno conectado a nuestro servidor
                if (!remote) remote = await checkUnauthorizedNetworkConnections();

                if (!remote) {
                    // ── Sistema limpio ──────────────────────────────────────
                    if (_isBlocked) {
                        // Había amenaza → se cerró → reanudar
                        _isBlocked = false;
                        resourceSecurityBlocked = false;
                        log.info('[SECURITY] Amenaza eliminada — reanudando reproducción.');
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.restore();
                            mainWindow.focus();
                            mainWindow.webContents.send('security-cleared');
                        }
                    }
                    return;
                }

                // ── Amenaza detectada ───────────────────────────────────────
                const isRdp         = remote === 'rdp';
                const isVm          = typeof remote === 'string' && remote.startsWith('vm:');
                const isRootkit     = typeof remote === 'string' && remote.startsWith('rootkit:');
                const isDllInject   = typeof remote === 'string' && remote.startsWith('rootkit:dll-inject:');
                const isUnsigned    = typeof remote === 'string' && remote.startsWith('rootkit:unsigned-driver:');
                const isSignature = remote.startsWith('rootkit:driver-signature:');
                const isProbeUnavailable = remote.startsWith('probe-unavailable:');
                const isNetIntruder = typeof remote === 'string' && remote.startsWith('network-intruder:');
                const isAi          = typeof remote === 'string' && remote.startsWith('ai:');

                // probe-unavailable no es amenaza real → ignorar en escaneo periódico
                if (isProbeUnavailable) {
                    log.info('[SECURITY] Probe no disponible en escaneo periódico (ignorado):', remote);
                    return;
                }

                // Admin exento de detección de herramientas de IA
                if (isAi && readSavedSession()?.role === 'admin') {
                    log.info('[SECURITY] AI tool detectada pero usuario es admin — ignorado:', remote);
                    return;
                }

                resourceSecurityBlocked = true;
                resourceWindows.invalidate('La protección de seguridad cerró el documento.');
                const appName2      = (!isRdp && !isVm && !isRootkit && !isNetIntruder)
                    ? remote.replace(/^ai:/, '').replace('.exe', '')
                    : null;

                // Rootkits y VMs → cerrar la app (no se pueden resolver cerrando un programa)
                if (isRootkit || isVm) {
                    let message2, detail2;
                    if (isSignature) {
                        message2 = 'No se pudo validar la firma de un controlador';
                        detail2 = remote.slice('rootkit:driver-signature:'.length) + '.\n\nLa política requiere una firma válida. Este estado no confirma malware ni ausencia de firma. Contacta con soporte.';
                    } else if (isVm) {
                        message2 = 'Entorno de virtualización detectado';
                        detail2  = 'El reproductor no puede ejecutarse dentro de una máquina virtual.';
                    } else {
                        const driverRaw2 = remote
                            .replace('rootkit:dll-inject:', '')
                            .replace('rootkit:unsigned-driver:', '')
                            .replace('rootkit:', '')
                            .split('\\').pop()
                            .replace('.sys', '').replace('.dll', '')
                            .toLowerCase();
                        const program2 = DRIVER_TO_PROGRAM[driverRaw2] || driverRaw2;
                        if (isDllInject) {
                            message2 = 'Módulo pendiente de verificación';
                            detail2  = `Módulo cargado desde una ruta que requiere revisión: "${driverRaw2}".\n\nSu ruta no confirma inyección ni malware. Contacta con soporte para revisar firma y procedencia.`;
                        } else if (isUnsigned) {
                            message2 = 'Driver sin firma detectado';
                            detail2  = `Windows devolvió NotSigned para "${driverRaw2}".\n\nLa política requiere una firma válida; este resultado no confirma malware. Contacta con soporte.`;
                        } else {
                            message2 = 'Controlador bloqueado por la política de seguridad';
                            detail2  = `Controlador activo: "${driverRaw2}". Asociación orientativa: ${program2}.\n\nSu nombre coincide con la lista de bloqueo; esto no confirma una vulnerabilidad o malware. Contacta con soporte para verificar archivo, firma y versión. No elimines archivos del sistema.`;
                        }
                    }
                    await dialog.showMessageBox(mainWindow, {
                        type: 'error', title: 'Edulock Systems Player — Acceso bloqueado',
                        message: message2, detail: detail2,
                        buttons: ['Entendido — Cerrar reproductor'],
                    });
                    if (mainWindow) mainWindow.close();
                    return;
                }

                // Herramientas de escritorio remoto, grabación, descarga → minimizar y pausar
                let title2, detail2;
                if (isNetIntruder) {
                    const intruderName = remote.replace('network-intruder:', '');
                    title2  = `Descarga no autorizada: ${intruderName}`;
                    detail2 = `El proceso "${intruderName}" está descargando el contenido del curso. Ciérralo para continuar.`;
                } else if (isRdp) {
                    title2  = 'Sesión de Escritorio Remoto activa';
                    detail2 = 'Cierra la conexión RDP para continuar reproduciendo.';
                } else {
                    const isDownloader = ['ffmpeg','yt-dlp','ytdlp','youtube-dl','streamlink',
                        'aria2c','n_m3u8dl','hlsdl','jdownloader','idman'].some(t => (appName2||'').toLowerCase().includes(t));
                    const isRemoteDesk = ['mstsc','msrdc','anydesk','teamviewer','rustdesk',
                        'parsec','splashtop','ultraviewer','radmin','supremo','logmein',
                        'connectwisecontrol','screenconnect','zoho_assist'].some(t => (appName2||'').toLowerCase().includes(t));
                    title2  = isAi         ? `Herramienta de IA activa: ${appName2}`
                             : isDownloader ? `Herramienta de descarga: ${appName2}`
                             : isRemoteDesk ? `Control remoto activo: ${appName2}`
                             : `Aplicación bloqueada: ${appName2}`;
                    detail2 = `Cierra "${appName2}" para continuar reproduciendo.`;
                }

                // Reporte forense al panel Seguridad (evento propio para IA).
                try {
                    const evtRt = isNetIntruder ? 'network-intruder'
                               : isRdp          ? 'remote-session-rdp'
                               : isAi           ? 'ai-tool-detected'
                               : 'remote-tool-detected';
                    reportSecurityEvent(evtRt, 'unknown', { raw: String(remote).slice(0, 120), phase: 'runtime' });
                } catch {}

                log.warn('[SECURITY] Amenaza detectada:', remote, '— minimizando y pausando reproducción.');

                if (!_isBlocked) {
                    _isBlocked = true;
                    // Pausar el video en el renderer
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('security-blocked', { title: title2, detail: detail2 });
                        mainWindow.minimize();
                    }
                }
            } finally {
                _scanRunning = false;
            }
        }, 10_000);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
});

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => {
    const cfg = getConfig();
    return {
        apiBase:  cfg.API_BASE,
        version:  cfg.VERSION,
        appName:  cfg.APP_NAME,
        protocol: cfg.PROTOCOL,
    };
});

ipcMain.handle('set-api-base', (_e, newBase) => {
    if (typeof newBase !== 'string' || !/^https?:\/\/.+/.test(newBase.trim())) {
        return { ok: false, error: 'URL inválida. Debe comenzar con http:// o https://' };
    }
    return saveUserConfig({ API_BASE: newBase.trim().replace(/\/$/, '') });
});

ipcMain.on('player-error', (_e, msg) => {
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
        type:    'error',
        title:   'Error de reproducción',
        message: String(msg),
        buttons: ['Aceptar'],
    });
});

ipcMain.on('close-player', () => {
    if (mainWindow) mainWindow.close();
});

ipcMain.on('open-external', (event, url) => {
    if (!isTrustedSender(event)) return;
    openExternalSafely(url);
});

// Pantalla completa nativa de Electron (más fiable que la API HTML5 dentro de
// una ventana con contentProtection). Alterna el estado de la ventana principal.
ipcMain.on('toggle-fullscreen', () => {
    if (!mainWindow) return;
    const next = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
});

ipcMain.handle('is-fullscreen', () => {
    return mainWindow ? mainWindow.isFullScreen() : false;
});

ipcMain.handle('get-device-info', async () => {
    let deviceModel = '';
    try {
        if (IS_WIN) {
            const { execSync } = require('child_process');
            const modelScript = "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); Get-CimInstance Win32_ComputerSystem -ErrorAction Stop | Select-Object Manufacturer,Model | ConvertTo-Json -Compress";
            const info = JSON.parse(execSync(powershellCommand(modelScript), { encoding: 'utf8', timeout: 3000, windowsHide: true }));
            deviceModel = `${String(info.Manufacturer || '').trim()} ${String(info.Model || '').trim()}`.trim();
        }
    } catch { /* fallback below */ }

    // ── Stable hardware-based device ID ───────────────────────────────────────
    // Prioridad:
    //   1. MachineGuid de Windows  (HKLM\SOFTWARE\Microsoft\Cryptography)
    //   2. UUID WMI  (Win32_ComputerSystemProduct)
    //   3. Archivo persistente en userData  (fallback cross-platform)
    // El resultado se hashea con SHA-256 y se formatea como "dev_<hex16>".
    const deviceIdPath = path.join(app.getPath('userData'), 'device_id.txt');
    let deviceId;
    let hadSavedIdentity = false;
    const { createHash, randomUUID } = require('crypto');

    const toDevId = (raw) =>
        'dev_' + createHash('sha256').update(raw.trim().toLowerCase()).digest('hex').slice(0, 16);

    // 0. PRIORIDAD MÁXIMA: si ya existe un deviceId persistido, usarlo TAL CUAL.
    //    El deviceId debe ser INMUTABLE una vez establecido, porque la activación
    //    de licencia queda atada a él en el servidor. Si se recalculara desde el
    //    hardware en cada arranque (y una consulta fallara/timeout, o 'wmic' ya no
    //    existe en Windows 11 24H2), el deviceId cambiaría y el servidor respondería
    //    DEVICE_MISMATCH → pediría la licencia en CADA apertura.
    try {
        const saved = fs.readFileSync(deviceIdPath, 'utf8').trim();
        if (saved) { deviceId = saved; hadSavedIdentity = true; }
    } catch (error) {
        if (fs.existsSync(deviceIdPath)) throw new Error('No se pudo leer la identidad guardada del equipo. Revisa los permisos del perfil con soporte.');
    }

    if (!deviceId) {
        try {
            // 1. MachineGuid desde el registro de Windows (no requiere admin)
            if (IS_WIN) {
                const { execSync } = require('child_process');
                const regOut = execSync(
                    'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
                    { encoding: 'utf8', timeout: 3000 }
                );
                const match = regOut.match(/MachineGuid\s+REG_SZ\s+([a-f0-9\-]+)/i);
                const guid = normalizeHardwareUuid(match && match[1]);
                if (guid) deviceId = toDevId(guid);
            }
        } catch { /* seguir con siguientes opciones */ }
    }

    if (!deviceId) {
        try {
            // 2. UUID mediante CIM, sin dependencia del ejecutable WMIC opcional.
            if (IS_WIN) {
                const { execSync } = require('child_process');
                const uuidOut = execSync(powershellCommand('$ErrorActionPreference=\'Stop\'; (Get-CimInstance Win32_ComputerSystemProduct).UUID'),
                    { encoding: 'utf8', timeout: 3000, windowsHide: true });
                const uuid = normalizeHardwareUuid(uuidOut);
                if (uuid) deviceId = toDevId(uuid);
            }
        } catch { /* seguir */ }
    }

    if (!deviceId) {
        // 3. Último recurso: aleatorio. Se persiste y queda FIJO de por vida.
        deviceId = toDevId(randomUUID());
    }

    // Un archivo vacío se repara; una identidad existente se conserva. Nunca
    // devolver una identidad aleatoria como estable si no pudo persistirse.
    if (!hadSavedIdentity) {
        try {
            fs.writeFileSync(deviceIdPath, deviceId, 'utf8');
            if (fs.readFileSync(deviceIdPath, 'utf8').trim() !== deviceId) throw new Error('identity write verification failed');
        } catch (error) {
            throw new Error('No se pudo guardar la identidad del equipo. Revisa los permisos del perfil con soporte antes de activar una licencia.');
        }
    }


    return {
        hostname:    os.hostname(),
        platform:    os.platform(),
        arch:        os.arch(),
        cpus:        os.cpus().length,
        totalmem:    os.totalmem(),
        username:    os.userInfo().username,
        osRelease:   os.release(),
        appVersion:  app.getVersion(),
        deviceModel: deviceModel || os.hostname(),
        deviceId,
    };
});

// ─── Sincronización de reloj con el servidor ────────────────────────────────
// Compensa desfases de reloj del cliente para que las firmas HMAC usen tiempo
// del servidor (tolerancia de 5 min). Se sincroniza al arrancar y cada 30 min.
let _serverTimeOffset = 0;
// Siempre entero: el servidor hace parseInt del header x-cdp-ts y firma ese valor;
// un ".5" aquí produciría una firma distinta ("Reproductor no autorizado").
function serverNow() { return Math.round(Date.now() + _serverTimeOffset); }
async function syncServerClock() {
    try {
        const apiBase = (getConfig().API_BASE || '').replace(/\/$/, '');
        if (!apiBase) return;
        const t0 = Date.now();
        const r = await httpFetch(`${apiBase}/api/time`);
        const t1 = Date.now();
        if (r.status === 200 && r.body && r.body.ts) {
            const rtt = (t1 - t0) / 2;
            _serverTimeOffset = Math.round(r.body.ts - (t0 + rtt));
            if (Math.abs(_serverTimeOffset) > 5000) {
                log.warn(`[clock-sync] desfase corregido: ${Math.round(_serverTimeOffset / 1000)}s`);
            }
        }
    } catch {}
}

// ─── Firma HMAC-SHA256 para verificar autenticidad del app ────────────────────
const { createHmac } = require('crypto');
ipcMain.handle('compute-sig', (_e, message) => {
    const secret = getConfig().APP_SECRET || '';
    if (!secret) return '';
    return createHmac('sha256', secret).update(String(message)).digest('hex');
});
ipcMain.handle('get-server-time', () => serverNow());

// ── Auth IPC handlers ──────────────────────────────────────────────────────────
const https = require('https');
const http  = require('http');
const dns   = require('dns');

// ── Fallback DNS (DNS-over-HTTPS) ──────────────────────────────────────────
// Algunos ISP / routers no resuelven dominios de DNS dinámico (dpdns.org) y el
// alumno ve "getaddrinfo ENOTFOUND". Si el DNS del sistema falla, resolvemos
// vía Cloudflare (1.1.1.1) o Google (8.8.8.8) por IP directa — no dependen del
// DNS local. El certificado TLS de ambos incluye su IP, la conexión es segura.
const _dohCache = new Map(); // hostname → { ip, exp }

function _dohQuery(providerIp, dohPath, hostname) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: providerIp,
            path:     `${dohPath}?name=${encodeURIComponent(hostname)}&type=A`,
            headers:  { accept: 'application/dns-json' },
            timeout:  5000,
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try {
                    const ans = (JSON.parse(data).Answer || []).find(a => a.type === 1);
                    if (ans && ans.data) resolve({ ip: ans.data, ttl: Math.max(60, ans.TTL || 300) });
                    else reject(new Error('sin registro A'));
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('DoH timeout')); });
        req.end();
    });
}

async function _resolveViaDoH(hostname) {
    const hit = _dohCache.get(hostname);
    if (hit && hit.exp > Date.now()) return hit.ip;
    const providers = [
        ['1.1.1.1', '/dns-query'],
        ['8.8.8.8', '/resolve'],
    ];
    for (const [ip, dohPath] of providers) {
        try {
            const r = await _dohQuery(ip, dohPath, hostname);
            _dohCache.set(hostname, { ip: r.ip, exp: Date.now() + r.ttl * 1000 });
            log.info(`[DNS] Fallback DoH resolvió ${hostname} → ${r.ip} (vía ${ip})`);
            return r.ip;
        } catch { /* probar siguiente proveedor */ }
    }
    return null;
}

// Reemplazo de dns.lookup: sistema primero, DoH si falla.
function dnsFallbackLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    dns.lookup(hostname, options, (err, address, family) => {
        if (!err) return callback(null, address, family);
        _resolveViaDoH(hostname).then((ip) => {
            if (!ip) return callback(err);
            if (options && options.all) return callback(null, [{ address: ip, family: 4 }]);
            callback(null, ip, 4);
        }).catch(() => callback(err));
    });
}

function httpFetch(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const parsed  = new URL(url);
        const lib     = parsed.protocol === 'https:' ? https : http;
        const reqOpts = {
            hostname: parsed.hostname,
            port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path:     parsed.pathname + (parsed.search || ''),
            method:   options.method || 'GET',
            headers:  options.headers || {},
            timeout:  10000,
            lookup:   dnsFallbackLookup,
            servername: parsed.protocol === 'https:' ? parsed.hostname : undefined,
        };
        const bodyStr = body ? JSON.stringify(body) : null;
        if (bodyStr) {
            reqOpts.headers['Content-Type']   = 'application/json';
            reqOpts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }
        const req = lib.request(reqOpts, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

// Descarga binaria (GET) — para bajar el .edu cifrado del proxy de Bunny.
function httpGetBuffer(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            method: 'GET', headers, timeout: 60000,
            lookup: dnsFallbackLookup,
            servername: parsed.protocol === 'https:' ? parsed.hostname : undefined,
        }, (res) => {
            if (res.statusCode >= 400) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

// Envía un evento de seguridad al servidor de forma silenciosa (sin mostrar nada al usuario)
async function reportSecurityEvent(event, deviceId, details = {}) {
    try {
        const cfg    = getConfig();
        const apiBase = cfg.API_BASE;
        if (!apiBase) return;
        const ts  = serverNow();
        const sig = createHmac('sha256', cfg.APP_SECRET || '').update('resolve:' + ts).digest('hex');
        await httpFetch(
            `${apiBase}/api/security/report`,
            { method: 'POST', headers: { 'x-cdp-ts': String(ts), 'x-cdp-sig': sig } },
            { event, deviceId: deviceId || 'unknown', details }
        );
    } catch { /* silencioso — no afecta al usuario */ }
}

ipcMain.handle('auth-firebase-login', async (_e, data) => {
    try {
        const apiBase = getConfig().API_BASE;
        const res = await httpFetch(`${apiBase}/api/auth/firebase-login`, { method: 'POST' }, data);
        return normalizeAuthResponse(res, true);
    } catch (err) {
        return connectionFailure();
    }
});

ipcMain.handle('auth-account-status', async (_e, data) => {
    try {
        const apiBase = getConfig().API_BASE;
        const res = await httpFetch(`${apiBase}/api/auth/account-status`, { method: 'POST' }, { email: data?.email });
        return normalizeAuthResponse(res);
    } catch { return connectionFailure(); }
});

// ─── Activation IPC handlers (sistema de licencias) ──────────────────────────
const activationStore = require('./activation-store');

/**
 * Devuelve true si hay activación guardada localmente para el deviceId.
 */
ipcMain.handle('activation-has-local', async (_e, deviceId) => {
    return activationStore.hasActivation(deviceId);
});

/**
 * Lee la activación local y la valida con el servidor.
 * Returns: { valid, studentId, courseId } | { valid: false, code, error }
 */
ipcMain.handle('activation-validate', async (_e, deviceId) => {
    return validateActivationOnline(deviceId);
});

// Códigos que indican que la activación local ya no sirve (revocada/regenerada).
const ACTIVATION_REVOKE_CODES = [
    'LICENSE_REGENERATED', 'ACTIVATION_REVOKED', 'ACTIVATION_NOT_FOUND',
    'ACTIVATION_EXPIRED', 'ACCOUNT_SUSPENDED', 'DEVICE_MISMATCH',
];

/**
 * Valida la activación local contra el servidor.
 * Si el servidor indica que la licencia fue regenerada/revocada, borra la
 * activación local. Devuelve { valid } | { valid:false, code, revoked }.
 */
async function validateActivationOnline(deviceId) {
    const local = activationStore.readActivation(deviceId);
    if (!local) return { valid: false, code: 'NO_LOCAL_ACTIVATION', error: 'No hay activación local' };

    try {
        const cfg     = getConfig();
        const apiBase = cfg.API_BASE;
        const ts      = serverNow();
        const sig     = createHmac('sha256', cfg.APP_SECRET || '').update('resolve:' + ts).digest('hex');

        const res = await httpFetch(
            `${apiBase}/api/license/validate-activation`,
            { method: 'POST', headers: { 'x-cdp-ts': String(ts), 'x-cdp-sig': sig } },
            { activationToken: local.activationToken, deviceId }
        );

        if (res.body?.valid) {
            return { valid: true, studentId: res.body.studentId, courseId: res.body.courseId };
        }

        // Si el servidor revocó/regeneró la licencia, borrar la activación local
        const code = res.body?.code || 'VALIDATION_FAILED';
        const revoked = ACTIVATION_REVOKE_CODES.includes(code);
        if (revoked) {
            activationStore.clearActivation();
        }
        return { valid: false, code, revoked, error: res.body?.error || 'Activación inválida' };
    } catch (err) {
        return { valid: false, code: 'NETWORK_ERROR', error: err.message };
    }
}

/**
 * Fuerza la re-activación: limpia activación + sesión locales, detiene la
 * reproducción y reabre la ventana de autenticación/licencia. Se usa cuando el
 * admin regeneró/revocó la licencia mientras el reproductor estaba abierto.
 */
function forceReactivation(code) {
    resourceWindows.invalidate('La licencia cambió o ya no permite acceder al documento.');
    clearEduBuffers();
    try { activationStore.clearActivation(); } catch { /* ignore */ }
    _userIsLoggedIn = false;
    _pendingCdpUrl  = null;
    try { if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH); } catch { /* ignore */ }

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stop-playback');
        mainWindow.webContents.setAudioMuted(true);
        mainWindow.hide();
    }

    if (!authWindow) createAuthWindow();

    // Avisar a la ventana de auth para mostrar el mensaje de "licencia actualizada"
    const notify = () => {
        if (authWindow && !authWindow.isDestroyed()) {
            authWindow.webContents.send('license-regenerated', { code: code || 'LICENSE_REGENERATED' });
        }
    };
    if (authWindow) {
        if (authWindow.webContents.isLoading()) authWindow.webContents.once('did-finish-load', notify);
        else notify();
    }
}

// Chequeo periódico de licencia mientras el reproductor está en uso: detecta
// que el admin regeneró/revocó la licencia y expulsa al formulario de licencia.
let _licenseCheckRunning = false;
async function runLicenseGuardCheck() {
    if (_licenseCheckRunning || !_userIsLoggedIn) return;
    _licenseCheckRunning = true;
    try {
        const devId = readDeviceIdSync();
        if (!devId) return;
        if (readSavedSession()?.role === 'admin') return;
        if (!activationStore.hasActivation(devId)) { forceReactivation('NO_LOCAL_ACTIVATION'); return; }
        const r = await validateActivationOnline(devId);
        if (r && r.revoked) {
            log.warn('[ACTIVATION] Licencia regenerada/revocada (' + r.code + ') — expulsando.');
            forceReactivation(r.code);
        }
    } catch (e) {
        log.warn('[ACTIVATION] runLicenseGuardCheck error:', e.message);
    } finally {
        _licenseCheckRunning = false;
    }
}

/**
 * Activa una licencia nueva en este dispositivo.
 * Guarda la activación localmente si el servidor la acepta.
 * Returns: { ok, error }
 */
ipcMain.handle('activation-activate-license', async (_e, { licenseKey, deviceId }) => {
    try {
        const cfg     = getConfig();
        const apiBase = cfg.API_BASE;
        const session = readSavedSession();

        const res = await httpFetch(
            `${apiBase}/api/session/activate-license`,
            { method: 'POST', headers: { Authorization: 'Bearer ' + (session?.token || '') } },
            { licenseKey, deviceId }
        );

        if (res.status !== 200 || !res.body?.token) {
            return { ok: false, error: res.body?.error || 'No se pudo activar la licencia' };
        }

        // Save Stage 2 JWT (license-scoped)
        const saved = session || {};
        fs.writeFileSync(SESSION_PATH, JSON.stringify({ ...saved, token: res.body.token }), 'utf8');

        // Save activation state locally (activationToken real: lo valida /api/license/validate-activation)
        activationStore.saveActivation({
            activationId:    res.body.activationId || res.body.licenseId,
            activationToken: res.body.activationToken || res.body.token,
            licenseId:       res.body.licenseId,
            studentId:       saved.sub || '',
            courseId:        res.body.courseId || null,
            expiresAt:       null,
        }, deviceId);

        return { ok: true, studentId: saved.sub || '', hasLicense: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

/**
 * Borra la activación local (cuando el usuario hace logout o el servidor la revoca).
 */
ipcMain.handle('activation-clear', () => {
    activationStore.clearActivation();
    return { ok: true };
});

/**
 * Genera OTP de VdoCipher para un video.
 * Usa el activationToken guardado localmente.
 */
ipcMain.handle('vdocipher-otp', async (_e, { videoId, deviceId }) => {
    const local = activationStore.readActivation(deviceId);
    if (!local) return { ok: false, error: 'Sin activación local' };

    try {
        const cfg     = getConfig();
        const apiBase = cfg.API_BASE;
        const ts      = serverNow();
        const sig     = createHmac('sha256', cfg.APP_SECRET || '').update('resolve:' + ts).digest('hex');

        const res = await httpFetch(
            `${apiBase}/api/vdocipher/otp`,
            { method: 'POST', headers: { 'x-cdp-ts': String(ts), 'x-cdp-sig': sig } },
            { videoId, activationToken: local.activationToken, deviceId }
        );

        if (res.status !== 200 || !res.body?.otp) {
            return { ok: false, error: res.body?.error || 'No se pudo obtener el token de reproducción' };
        }
        return { ok: true, otp: res.body.otp, playbackInfo: res.body.playbackInfo };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// When auth window signals success, show main window
ipcMain.on('request-license', () => {
    resourceWindows.invalidate();
    clearEduBuffers();
    _userIsLoggedIn = false;
    if (mainWindow) {
        mainWindow.webContents.send('stop-playback');
        mainWindow.webContents.setAudioMuted(true);
        mainWindow.hide();
    }
    if (!authWindow) createAuthWindow();
    const notify = () => authWindow?.webContents.send('license-required');
    if (authWindow?.webContents.isLoading()) authWindow.webContents.once('did-finish-load', notify);
    else notify();
});

ipcMain.on('auth-success', () => {
    if (!canEnterDirectly()) return;
    _userIsLoggedIn = true;
    startTokenRefresh();
    if (mainWindow) mainWindow.webContents.setAudioMuted(false);
    if (authWindow) { authWindow.close(); authWindow = null; }
    if (mainWindow) {
        // Recargar index.html ahora que la sesión ya fue guardada en disco
        // → init() correrá con el token correcto y STATE.auth quedará poblado
        mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
        mainWindow.webContents.once('did-finish-load', () => {
            mainWindow.show();
            if (_pendingCdpUrl) {
                const pending = _pendingCdpUrl;
                _pendingCdpUrl = null;
                // Pequeño delay para que init() del renderer termine
                setTimeout(() => dispatchCdpUrl(pending), 300);
            }
        });
    }
});

// Cerrar sesión guardada (para logout explícito)
ipcMain.on('logout', () => {
    // Cierra la sesión de contenido también en el servidor (mejor esfuerzo): la licencia, el
    // dispositivo y el contador de activaciones se conservan; al volver se pide la licencia.
    try {
        const session = readSavedSession();
        if (session?.token) {
            let deviceId = '';
            try { deviceId = fs.readFileSync(path.join(app.getPath('userData'), 'device_id.txt'), 'utf8').trim(); } catch { /* sin id local */ }
            Promise.resolve(httpFetch(`${getConfig().API_BASE}/api/auth/logout`,
                { method: 'POST', headers: { Authorization: 'Bearer ' + session.token } }, { deviceId })).catch(() => {});
        }
    } catch { /* la limpieza local sigue igual */ }
    resourceWindows.invalidate('Se cerró la sesión.');
    clearEduBuffers();
    activationStore.clearActivation();
    _userIsLoggedIn = false;
    _pendingCdpUrl  = null;
    try { if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH); } catch { /* ok */ }
    if (mainWindow) {
        // Detener audio/video sin recargar la página (evita que init() corra sin sesión)
        mainWindow.webContents.send('stop-playback');
        mainWindow.webContents.setAudioMuted(true);
        mainWindow.hide();
    }
    createAuthWindow();
});
