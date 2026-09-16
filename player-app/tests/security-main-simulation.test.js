'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../security-policy');
const probes = require('../platform-probes');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = source.indexOf('const REMOTE_TOOLS =');
const end = source.indexOf('// Detecta el puerto de Frida', start);
assert.ok(start >= 0 && end > start, 'security function boundaries found');
const csv = names => names.map(name => `"${name}","123","Console","1","123 K"`).join('\r\n');

function machine(fixture = {}) {
    const records = [];
    const context = {
        ...policy, ...probes, IS_WIN: true, process: { pid: 12345, env: fixture.environment || { SESSIONNAME: 'Console', CLIENTNAME: 'Console' } },
        checkFridaPort: async () => false,
        log: { info: (...args) => records.push(args), warn: (...args) => records.push(args) },
        exec(command, options, callback) {
            const encoded = /-EncodedCommand\s+(\S+)/i.exec(command);
            const text = encoded ? Buffer.from(encoded[1], 'base64').toString('utf16le') : command;
            let output;
            let error = null;
            if (text.startsWith('tasklist')) output = csv(fixture.processes || []);
            else if (/Win32_Process/.test(text)) output = '';
            else if (/Get-NetTCPConnection/.test(text)) output = fixture.network || 'clean';
            else if (/Get-NetAdapter/.test(text)) output = fixture.macs || '';
            else if (/Win32_ComputerSystem/.test(text)) output = fixture.hypervisor ? 'hypervisor' : 'bare-metal';
            else if (/Win32_SystemDriver/.test(text) && /\.Modules/.test(text)) {
                // Combined rootkit probe: PROBE1 (known drivers), PROBE2 (unsigned), PROBE3 (DLL inject)
                const p1 = fixture.driverError ? '' : (fixture.driver || 'clean');
                const p2 = fixture.signatureError ? '' : (fixture.signature || 'clean');
                const p3 = fixture.module || 'clean';
                output = `PROBE1:${p1}\nPROBE2:${p2}\nPROBE3:${p3}`;
            } else if (/Win32_SystemDriver/.test(text)) {
                const signing = /Get-AuthenticodeSignature/.test(text);
                output = signing ? fixture.signature || 'clean' : fixture.driver || 'clean';
                if (signing ? fixture.signatureError : fixture.driverError) error = new Error('Synthetic access denied');
            } else if (/\.Modules/.test(text)) output = fixture.module || 'clean';
            else throw new Error('Unexpected simulated command: ' + text.slice(0, 90));
            queueMicrotask(() => callback(error, output));
        },
    };
    vm.runInNewContext(source.slice(start, end) + '\n globalThis.api={checkRemoteSession,checkRemoteTools,checkVirtualMachine,checkRootkitIndicators,checkUnauthorizedNetworkConnections};', context, { timeout: 1000 });
    return { ...context.api, records };
}

for (const [name, fixture, expected] of [
    ['local Console with Console client', {}, false],
    ['similar Claude process name', { processes: ['my-claude.exe'] }, false],
    ['real Claude process remains blocked', { processes: ['claude.exe'] }, 'ai:claude.exe'],
    ['confirmed RDP remains blocked', { environment: { SESSIONNAME: 'RDP-Tcp#2' } }, 'rdp'],
    ['VMware host processes and virtual adapter', { processes: ['vmnat.exe', 'vmware-vmx.exe'], macs: '00:50:56:AA:BB:CC' }, false],
    ['physical Hyper-V WSL Docker host', { processes: ['vmcompute.exe', 'vmmem.exe'], macs: '00:15:5D:11:22:33', hypervisor: true }, false],
    ['virtual-looking middle MAC bytes', { macs: 'AA:00:15:5D:11:22' }, false],
    ['confirmed VMware guest process remains blocked', { processes: ['vmtoolsd.exe'] }, 'vm:vmtoolsd.exe'],
    ['similar VM guest executable name', { processes: ['backup-vboxservice.exe'] }, false],
    ['known blocked driver remains blocked', { driver: 'gdrv' }, 'rootkit:gdrv'],
    ['unsigned driver remains blocked', { signature: 'VendorDriver' }, 'rootkit:unsigned-driver:vendordriver'],
    ['untrusted driver preserves signature status', { signature: 'signature-status:NotTrusted:VendorDriver' }, 'rootkit:driver-signature:NotTrusted:VendorDriver'],
    ['driver query denied does not block', { driverError: true }, false],
    ['signature query denied does not block', { signatureError: true }, false],
    ['missing driver file does not block', { signature: 'probe-error:driver-file-unavailable:Vendor' }, false],
    ['module anomaly remains subject to review policy', { module: 'C:\\Vendor\\overlay.dll' }, 'rootkit:dll-inject:C:\\Vendor\\overlay.dll'],
]) test(`main security simulation: ${name}`, async () => assert.equal(await machine(fixture).checkRemoteSession(), expected));

test('main security simulation: sharing a CDN IP alone does not prove stream theft', async () => {
    const fixture = machine({ network: 'intruder:2222:Teams' });
    assert.equal(await fixture.checkUnauthorizedNetworkConnections(), false);
    assert.equal(fixture.records.length, 1);
});
