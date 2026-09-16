'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const { NtExecutable, NtExecutableResource } = require('resedit');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');

async function verifyWindowsPackage(directory) {
    const exePath = path.join(directory, 'Edulock Systems Player.exe');
    const asarPath = path.join(directory, 'resources', 'app.asar');
    const expected = { RunAsNode: false, EnableCookieEncryption: true,
        EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false,
        EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true,
        LoadBrowserProcessSpecificV8Snapshot: false, GrantFileProtocolExtraPrivileges: true };
    const wire = await getCurrentFuseWire(exePath);
    for (const [name, enabled] of Object.entries(expected)) {
        assert.equal(wire[FuseV1Options[name]], enabled ? 49 : 48, 'Unexpected fuse: ' + name);
    }
    const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
    const resources = NtExecutableResource.from(exe).entries;
    const entries = resources.filter(entry => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR');
    assert.equal(entries.length, 1, 'Expected one Windows ASAR integrity resource');
    const embedded = JSON.parse(Buffer.from(entries[0].bin).toString('utf8'));
    const appEntry = embedded.find(item => item.file.toLowerCase() === 'resources\\app.asar');
    assert.ok(appEntry, 'Missing app.asar embedded header hash');
    assert.equal(appEntry.alg.toLowerCase(), 'sha256');
    const headerHash = crypto.createHash('sha256').update(asar.getRawHeader(asarPath).headerString).digest('hex');
    assert.equal(appEntry.value.toLowerCase(), headerHash, 'Embedded ASAR hash mismatch');
    const names = asar.listPackage(asarPath).map(name => name.replace(/\\/g, '/'));
    assert.ok(!names.some(name => /^\/(dist[^/]*|test|tests|scripts|qa-private)(\/|$)/.test(name)), 'Development artifacts included');
    const sourceRoot = path.resolve(__dirname, '..');
    const files = ['main.js', 'preload.js', 'auth-response.js', 'platform-probes.js', 'security-policy.js', 'activation-store.js', 'edu-native.js',
        'protected-resources.js', 'resource-window.js', 'resource-preload.js', 'renderer/player.js', 'renderer/auth.html',
        'renderer/index.html', 'renderer/resource-viewer.html', 'renderer/resource-viewer.js', 'renderer/resource-viewer.css', 'renderer/resource-catalog.js'];
    for (const name of files) assert.ok(asar.extractFile(asarPath, name).equals(fs.readFileSync(path.join(sourceRoot, name))), 'Packaged source mismatch: ' + name);
    return { success: true, verifiedFuses: Object.keys(expected).length, embeddedAsarHashVerified: true,
        headerHash, sourceFilesVerified: files.length, packagedEntries: names.length };
}

module.exports = { verifyWindowsPackage };
if (require.main === module) verifyWindowsPackage(path.resolve(process.argv[2] || 'dist-evs-acceptance/win-unpacked'))
    .then(report => console.log(JSON.stringify(report)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
