'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    findBlockedProcess, classifyRdpSession, matchingMacPrefixes, classifyVmEvidence,
    booleanProbeState, classifySignatureStatus, parseDriverProbeResult, normalizeHardwareUuid,
} = require('../security-policy');

const csv = (...names) => names.map((name, index) => `"${name.replace(/"/g, '""')}","${100 + index}","Console","1","12,345 K"`).join('\r\n');
for (const [name, inventory, blocked, allowed, expected] of [
    ['exact known process', csv('chrome.exe', 'CLAUDE.EXE'), ['claude.exe'], [], 'claude.exe'],
    ['similar name is not blocked', csv('my-claude.exe'), ['claude.exe'], [], false],
    ['blocked text in another CSV field is ignored', '"chrome.exe","claude.exe","Console"', ['claude.exe'], [], false],
    ['allowed first process does not hide blocked second', csv('claude.exe', 'anydesk.exe'), ['claude.exe', 'anydesk.exe'], [' CLAUDE.EXE '], 'anydesk.exe'],
    ['similar allowlist does not suppress real blocked process', csv('claude.exe'), ['claude.exe'], ['my-claude.exe'], 'claude.exe'],
    ['guest executable name substring is ignored', csv('backup-vboxservice.exe'), ['vboxservice.exe'], [], false],
    ['guest executable exact match remains detected', csv('VBoxService.exe'), ['vboxservice.exe'], [], 'vboxservice.exe'],
    ['accented names and spaces remain exact', csv('Asistente José.exe'), ['asistente josé.exe'], [], 'asistente josé.exe'],
    ['escaped quotes in CSV are parsed', csv('test"app.exe'), ['test"app.exe'], [], 'test"app.exe'],
    ['localized tasklist no-results line is not a process', 'Información: no hay tareas en ejecución.', ['claude.exe'], [], false],
]) test(`tasklist: ${name}`, () => assert.equal(findBlockedProcess(inventory, blocked, allowed), expected));

for (const [name, environment, protocol, expected] of [
    ['local Console', { SESSIONNAME: 'Console' }, null, 'local'],
    ['Console client is not RDP', { SESSIONNAME: 'Console', CLIENTNAME: 'Console' }, null, 'local'],
    ['real RDP session', { SESSIONNAME: 'RDP-Tcp#12', CLIENTNAME: 'Alumno-PC' }, null, 'remote'],
    ['RDP session comparison ignores case', { SESSIONNAME: 'rdp-tcp#1' }, null, 'remote'],
    ['remote-looking client name alone is inconclusive', { CLIENTNAME: 'Alumno-PC' }, null, 'unknown'],
    ['missing environment is inconclusive', {}, null, 'unknown'],
    ['similar session name is not confirmed RDP', { SESSIONNAME: 'RDP-Tcp-helper' }, null, 'unknown'],
    ['positive WTS RDP overrides inherited Console', { SESSIONNAME: 'Console' }, 2, 'remote'],
    ['positive WTS Console overrides stale RDP variables', { SESSIONNAME: 'RDP-Tcp#1' }, 0, 'local'],
]) test(`session: ${name}`, () => assert.equal(classifyRdpSession(environment, protocol).state, expected));

const prefixes = ['00:15:5d', '00:50:56', '08:00:27'];
for (const [name, input, expected] of [
    ['Hyper-V OUI', '00-15-5D-11-22-33', ['00:15:5d']],
    ['VMware OUI mixed case', '00:50:56:AA:BB:CC', ['00:50:56']],
    ['OUI-looking middle bytes are not a prefix', 'AA:00:15:5D:11:22', []],
    ['malformed address is not evidence', '00:15:5d:not-a-mac', []],
    ['list returns unique matching prefixes', '00:15:5d:11:22:33,08-00-27-44-55-66,00:15:5d:77:88:99', ['00:15:5d', '08:00:27']],
    ['physical Intel-like adapter', '34:13:E8:11:22:33', []],
]) test(`MAC: ${name}`, () => assert.deepEqual(matchingMacPrefixes(input, prefixes), expected));

for (const [name, input, expected] of [
    ['physical host with WSL virtual adapter', { macPrefixes: ['00:15:5d'] }, 'context'],
    ['physical host with VBS HVCI', { hypervisorPresent: true }, 'context'],
    ['physical host with Docker Hyper-V and virtual MAC', { macPrefixes: ['00:15:5d'], hypervisorPresent: true }, 'context'],
    ['confirmed VMware guest process', { guestProcess: 'vmtoolsd.exe', hypervisorPresent: true }, 'guest'],
    ['confirmed VirtualBox guest process', { guestProcess: 'vboxservice.exe' }, 'guest'],
    ['no VM signal does not claim hardware certification', {}, 'no-indicator'],
]) test(`VM context: ${name}`, () => assert.equal(classifyVmEvidence(input).state, expected));

for (const label of ['Secure Boot', 'HVCI']) {
    for (const [name, error, output, expected] of [
        ['enabled', null, 'True\r\n', 'enabled'], ['disabled', null, 'false', 'disabled'],
        ['access denied', new Error('Access denied'), '', 'unknown'],
        ['command unavailable', new Error('ENOENT'), '', 'unknown'],
        ['timeout with stale output', new Error('timeout'), 'true', 'unknown'],
        ['BIOS or unsupported empty response', null, '', 'unknown'],
        ['unexpected response', null, 'not available', 'unknown'],
    ]) test(`${label}: ${name}`, () => assert.equal(booleanProbeState(error, output), expected));
}

for (const [status, expected] of [
    ['Valid', 'valid'], ['NotSigned', 'unsigned'], ['NotTrusted', 'untrusted'],
    ['UnknownError', 'verification-error'], ['HashMismatch', 'hash-mismatch'],
    ['NotSupportedFileFormat', 'unsupported-format'], ['Incompatible', 'incompatible'], ['', 'unknown'],
]) test(`signature classification: ${status || 'missing'}`, () => assert.equal(classifySignatureStatus(status), expected));

for (const [name, error, output, expected] of [
    ['query error', new Error('access denied'), '', 'unavailable'],
    ['error plus partial match', new Error('timeout'), 'gdrv', 'unavailable'],
    ['empty output', null, '', 'unavailable'],
    ['multiline output', null, 'gdrv\nclean', 'unavailable'],
    ['missing file', null, 'probe-error:driver-file-unavailable:VendorDriver', 'unavailable'],
    ['clean', null, 'clean\r\n', 'clean'],
    ['known driver', null, 'gdrv', 'detected'],
    ['untrusted signature remains a restriction', null, 'signature-status:NotTrusted:VendorDriver', 'detected'],
]) test(`probe result: ${name}`, () => assert.equal(parseDriverProbeResult(error, output).state, expected));

test('an untrusted signature is not classified as an unsigned driver', () => {
    const result = parseDriverProbeResult(null, 'signature-status:NotTrusted:VendorDriver', 'unsigned-driver');
    assert.equal(result.kind, 'driver-signature');
    assert.equal(result.signatureState, 'untrusted');
    assert.equal(result.name, 'VendorDriver');
});

for (const [name, input, expected] of [
    ['valid hardware UUID', 'ABCDEF01-2345-6789-ABCD-0123456789AB', 'abcdef01-2345-6789-abcd-0123456789ab'],
    ['all zero OEM placeholder', '00000000-0000-0000-0000-000000000000', null],
    ['all uppercase F OEM placeholder', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', null],
    ['all lowercase f OEM placeholder', 'ffffffff-ffff-ffff-ffff-ffffffffffff', null],
    ['WMIC missing returns no UUID', '', null],
    ['malformed UUID', 'UUID=not-a-guid', null],
]) test(`hardware identity: ${name}`, () => assert.equal(normalizeHardwareUuid(input), expected));
