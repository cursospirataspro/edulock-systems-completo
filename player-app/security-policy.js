'use strict';

// Extra restrictions only. -3 delegates ordinary TLS validation to Chromium.
function certificateDecision(request) {
    const issuer = String(request.certificate?.issuerName || '').toLowerCase();
    const blocked = ['mitmproxy', 'burp suite', 'charles proxy', 'charles ca',
        'fiddler', 'proxyman', 'portswigger', 'owasp zap'];
    if (blocked.some(name => issuer.includes(name))) return -2;
    return -3;
}

function parseByteRange(value, length) {
    if (!Number.isSafeInteger(length) || length < 1) return null;
    if (!value) return { start: 0, end: length - 1, partial: false };
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || (!match[1] && !match[2])) return null;
    let start, end;
    if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
        start = Math.max(0, length - suffix);
        end = length - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : length - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || start > end) return null;
        end = Math.min(end, length - 1);
    }
    return { start, end, partial: true };
}

// Match the executable column, never text in another tasklist CSV field.
function findBlockedProcess(tasklistCsv, blockedNames, allowedNames = []) {
    const images = new Set(String(tasklistCsv || '').split(/\r?\n/).flatMap(line => {
        const match = /^\s*"((?:[^\"]|\"\")*)"(?:,|$)/.exec(line);
        return match ? [match[1].replace(/""/g, '"').trim().toLowerCase()] : [];
    }));
    const allowed = new Set(allowedNames.map(name => String(name).trim().toLowerCase()));
    return blockedNames.map(name => String(name).trim().toLowerCase())
        .find(name => {
            if (!name || !images.has(name)) return false;
            if (allowed.has(name)) return false;
            const bare = name.replace(/\.exe$/i, '');
            if (bare !== name && allowed.has(bare)) return false;
            return true;
        }) || false;
}

function classifyRdpSession(environment = {}, protocolType = null) {
    // WTSClientProtocolType, if supplied, takes precedence over inherited env vars.
    if (protocolType === 2) return { state: 'remote', reason: 'wts-rdp' };
    if (protocolType === 0) return { state: 'local', reason: 'wts-console' };
    const session = String(environment.SESSIONNAME || '').trim().toLowerCase();
    const client = String(environment.CLIENTNAME || '').trim().toLowerCase();
    if (/^rdp-tcp(?:#\d+)?$/.test(session)) return { state: 'remote', reason: 'rdp-session-name' };
    if (session === 'console' && (!client || client === 'console')) return { state: 'local', reason: 'console' };
    return { state: 'unknown', reason: 'session-unconfirmed' };
}

function matchingMacPrefixes(rawMacs, prefixes) {
    const values = Array.isArray(rawMacs) ? rawMacs : String(rawMacs || '').split(/[\s,]+/);
    const allowedPrefixes = new Set(prefixes.map(prefix => String(prefix).trim().toLowerCase().replace(/-/g, ':')));
    return [...new Set(values.flatMap(value => {
        const normalized = String(value || '').trim().toLowerCase().replace(/-/g, ':');
        if (!/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(normalized)) return [];
        const prefix = normalized.slice(0, 8);
        return allowedPrefixes.has(prefix) ? [prefix] : [];
    }))];
}

function classifyVmEvidence({ guestProcess = null, macPrefixes = [], hypervisorPresent = false } = {}) {
    if (guestProcess) return { state: 'guest', reason: 'guest-process', process: guestProcess };
    // Virtual adapter OUIs and VBS/Hyper-V on a physical host are contextual signals.
    if (macPrefixes.length) return { state: 'context', reason: 'virtual-adapter', macPrefixes };
    if (hypervisorPresent === true) return { state: 'context', reason: 'hypervisor-present' };
    return { state: 'no-indicator', reason: 'no-confirmed-guest-evidence' };
}

function booleanProbeState(error, stdout) {
    if (error) return 'unknown';
    const value = String(stdout || '').trim().toLowerCase();
    return value === 'true' ? 'enabled' : value === 'false' ? 'disabled' : 'unknown';
}

function classifySignatureStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    return ({ valid: 'valid', notsigned: 'unsigned', hashmismatch: 'hash-mismatch',
        nottrusted: 'untrusted', unknownerror: 'verification-error',
        notsupportedfileformat: 'unsupported-format', incompatible: 'incompatible' })[status] || 'unknown';
}

function parseDriverProbeResult(error, stdout, kind = 'known-driver') {
    if (error) return { state: 'unavailable', reason: 'command-failed', kind };
    const output = String(stdout || '').trim();
    if (!output || /[\r\n\0]/.test(output)) return { state: 'unavailable', reason: 'unexpected-output', kind };
    if (output.toLowerCase() === 'clean') return { state: 'clean', kind };
    if (output.startsWith('probe-error:')) return { state: 'unavailable', reason: output.slice(12), kind };
    const signature = /^signature-status:([^:]+):(.+)$/.exec(output);
    if (signature) return { state: 'detected', kind: 'driver-signature', name: signature[2],
        signatureStatus: signature[1], signatureState: classifySignatureStatus(signature[1]) };
    return { state: 'detected', kind, name: output };
}

function normalizeHardwareUuid(value) {
    const uuid = String(value || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(uuid)) return null;
    const digits = uuid.replace(/-/g, '');
    return /^0+$/.test(digits) || /^f+$/.test(digits) ? null : uuid;
}

module.exports = { certificateDecision, parseByteRange, findBlockedProcess, classifyRdpSession,
    matchingMacPrefixes, classifyVmEvidence, booleanProbeState, classifySignatureStatus,
    parseDriverProbeResult, normalizeHardwareUuid };
