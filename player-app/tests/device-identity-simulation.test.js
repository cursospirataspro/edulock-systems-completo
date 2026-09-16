'use strict';
// Execute the real get-device-info IPC handler with an in-memory filesystem and
// synthetic OS/WMIC responses. This never reads the machine's identifiers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const policy = require('../security-policy');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = source.indexOf("ipcMain.handle('get-device-info'");
const end = source.indexOf('// ─── Firma HMAC', start);
assert.ok(start >= 0 && end > start, 'get-device-info handler boundaries found');

function computer(options = {}) {
    const files = new Map();
    const commands = [];
    const devicePath = path.join('C:\\SyntheticUser', 'device_id.txt');
    if (options.saved !== undefined) files.set(devicePath, options.saved);
    let handler;
    let random = 0;
    function execute(command) {
        const encoded = /-EncodedCommand\s+(\S+)/i.exec(command);
        const plain = encoded ? Buffer.from(encoded[1], 'base64').toString('utf16le') : command;
        commands.push(plain);
        if (/wmic/i.test(plain) && options.noWmic) throw new Error('Synthetic WMIC ENOENT');
        if (/manufacturer \/value/i.test(plain)) return 'Manufacturer=' + (options.brand || 'Synthetic') + '\r\n';
        if (/model \/value/i.test(plain)) return 'Model=' + (options.model || 'Computer') + '\r\n';
        if (/MachineGuid/.test(plain)) {
            if (!options.guid) throw new Error('Synthetic registry access denied');
            return '    MachineGuid    REG_SZ    ' + options.guid + '\r\n';
        }
        if (/csproduct|ComputerSystemProduct/i.test(plain)) {
            if (!options.uuid) throw new Error('Synthetic UUID unavailable');
            return /wmic/i.test(plain) ? 'UUID=' + options.uuid + '\r\n' : options.uuid;
        }
        if (/Get-CimInstance.*Win32_ComputerSystem/i.test(plain)) return JSON.stringify({ Manufacturer: options.brand || 'Synthetic', Model: options.model || 'Computer' });
        throw new Error('Unexpected synthetic command: ' + plain);
    }
    const memoryFs = {
        existsSync: filename => files.has(filename),
        readFileSync: filename => { if (options.readDenied) throw new Error('Synthetic EACCES'); if (!files.has(filename)) throw new Error('ENOENT'); return files.get(filename); },
        writeFileSync: (filename, data) => { if (options.writeDenied) throw new Error('Synthetic EACCES'); files.set(filename, data); },
    };
    const context = {
        ...policy, IS_WIN: true, path, fs: memoryFs,
        app: { getPath: () => 'C:\\SyntheticUser', getVersion: () => '1.0.2' },
        log: { info() {}, warn() {}, error() {} },
        powershellCommand: require('../platform-probes').powershellCommand,
        os: { hostname: () => options.hostname || 'Synthetic-PC', platform: () => 'win32', arch: () => 'x64',
            cpus: () => [1, 2, 3, 4], totalmem: () => 8 * 1024 ** 3, userInfo: () => ({ username: 'Alumno José' }), release: () => '10.0.synthetic' },
        ipcMain: { handle: (name, callback) => { assert.equal(name, 'get-device-info'); handler = callback; } },
        require(name) {
            if (name === 'child_process') return { execSync: execute };
            if (name === 'crypto') return { createHash: crypto.createHash, randomUUID: () => `aaaaaaaa-bbbb-cccc-dddd-${String(++random).padStart(12, '0')}` };
            throw new Error('Unexpected synthetic require: ' + name);
        },
    };
    vm.runInNewContext(source.slice(start, end), context, { filename: 'device-info-simulation.js', timeout: 1000 });
    return { get: () => handler(), commands, files, devicePath, options };
}

for (const brand of ['Dell', 'HP', 'Lenovo', 'ASUS', 'MSI', 'Acer', 'Microsoft Surface', 'Gigabyte']) {
    test(`synthetic ${brand}: missing WMIC preserves identity across two starts`, async () => {
        const first = computer({ brand, noWmic: true, guid: 'abcdef01-2345-6789-abcd-0123456789ab' });
        const initial = await first.get();
        const next = computer({ brand, noWmic: true, guid: '11111111-2222-3333-4444-555555555555', saved: first.files.get(first.devicePath) });
        const reopened = await next.get();
        assert.match(initial.deviceId, /^dev_[0-9a-f]{16}$/);
        assert.equal(reopened.deviceId, initial.deviceId);
        assert.equal(next.commands.some(command => /MachineGuid|csproduct/.test(command)), false);
    });
}

test('synthetic PC: no WMIC and denied registry use a persisted random fallback', async () => {
    const first = computer({ noWmic: true });
    const initial = await first.get();
    const reopened = await computer({ noWmic: true, saved: first.files.get(first.devicePath) }).get();
    assert.equal(reopened.deviceId, initial.deviceId);
});

test('synthetic PCs: distinct MachineGuids have distinct identities', async () => {
    const first = await computer({ noWmic: true, guid: 'abcdef01-2345-6789-abcd-0123456789ab' }).get();
    const second = await computer({ noWmic: true, guid: '11111111-2222-3333-4444-555555555555' }).get();
    assert.notEqual(first.deviceId, second.deviceId);
});

test('synthetic PC: an existing legacy identity is preserved verbatim', async () => {
    const result = await computer({ noWmic: true, saved: 'legacy-device-identifier' }).get();
    assert.equal(result.deviceId, 'legacy-device-identifier');
});

test('synthetic PC: an empty identity file is repaired and reused', async () => {
    const device = computer({ noWmic: true, saved: '' });
    const first = await device.get();
    assert.equal(device.files.get(device.devicePath), first.deviceId);
    assert.equal((await device.get()).deviceId, first.deviceId);
});

test('synthetic PC: denied identity write is an explicit error before activation', async () => {
    await assert.rejects(computer({ noWmic: true, writeDenied: true }).get(), /No se pudo guardar la identidad/);
});

test('synthetic PC: unreadable existing identity is not silently replaced', async () => {
    await assert.rejects(computer({ noWmic: true, saved: 'old-identity', readDenied: true }).get(), /No se pudo leer la identidad/);
});

test('synthetic PC: lowercase all-F OEM UUID does not become a shared identity', async () => {
    const invalid = computer({ noWmic: true, uuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
    const absent = computer({ noWmic: true });
    assert.equal((await invalid.get()).deviceId, (await absent.get()).deviceId);
});

test('synthetic PC: manufacturer and model are read through CIM without WMIC', async () => {
    const device = computer({ brand: 'Lenovo', model: 'Portátil José', noWmic: true, saved: 'legacy-device' });
    assert.equal((await device.get()).deviceModel, 'Lenovo Portátil José');
    assert.equal(device.commands.some(command => /\bwmic\b/i.test(command)), false);
});
