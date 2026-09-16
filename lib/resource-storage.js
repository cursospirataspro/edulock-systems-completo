'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const MAGIC = Buffer.from('EDPDF1');
const MAX_BYTES = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failure = (code, message, status = 503) => Object.assign(new Error(message), { code, status });

function createResourceStorage({ directory, configuredKey } = {}) {
    const base = path.resolve(directory || path.join(__dirname, '..', '.private-resources'));
    let initialized;
    async function initialize() {
        await fs.mkdir(base, { recursive: true, mode: 0o700 });
        const st = await fs.lstat(base);
        if (!st.isDirectory() || st.isSymbolicLink()) throw failure('RESOURCE_STORAGE_INVALID', 'El almacenamiento de recursos no está disponible.');
        const real = await fs.realpath(base);
        let key;
        if (configuredKey !== undefined && configuredKey !== '') {
            if (!/^[0-9a-f]{64}$/i.test(configuredKey)) throw failure('RESOURCE_KEY_INVALID', 'La clave de recursos no es válida.');
            key = Buffer.from(configuredKey, 'hex');
        } else {
            const keyPath = path.join(real, 'master.key');
            try { await fs.writeFile(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
            catch (e) { if (e.code !== 'EEXIST') throw e; }
            const keyStat = await fs.lstat(keyPath);
            if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.size !== 32) throw failure('RESOURCE_KEY_INVALID', 'La clave de recursos no está disponible.');
            key = await fs.readFile(keyPath);
        }
        return { real, key };
    }
    async function context(id) {
        if (!UUID.test(id || '')) throw failure('RESOURCE_STORAGE_ID_INVALID', 'Identificador de archivo no válido.', 400);
        initialized ||= initialize().catch(e => { initialized = undefined; throw e; });
        const { real, key } = await initialized;
        return { key, file: path.join(real, id.toLowerCase() + '.enc') };
    }
    return {
        async put(bytes) {
            if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) throw failure('RESOURCE_SIZE_INVALID', 'El PDF debe ocupar como máximo 25 MiB.', 400);
            const storageKey = crypto.randomUUID();
            const { key, file } = await context(storageKey);
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            cipher.setAAD(Buffer.from(storageKey));
            const data = Buffer.concat([MAGIC, iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
            await fs.writeFile(file, data, { flag: 'wx', mode: 0o600 });
            return storageKey;
        },
        async read(storageKey) {
            const { key, file } = await context(storageKey);
            const st = await fs.lstat(file);
            if (!st.isFile() || st.isSymbolicLink() || st.size < 35 || st.size > MAX_BYTES + 34) throw failure('RESOURCE_FILE_INVALID', 'No se pudo abrir el recurso.');
            const encrypted = await fs.readFile(file);
            if (!encrypted.subarray(0, 6).equals(MAGIC)) throw failure('RESOURCE_FILE_INVALID', 'No se pudo abrir el recurso.');
            try {
                const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(6, 18));
                decipher.setAAD(Buffer.from(storageKey.toLowerCase()));
                decipher.setAuthTag(encrypted.subarray(-16));
                return Buffer.concat([decipher.update(encrypted.subarray(18, -16)), decipher.final()]);
            } catch { throw failure('RESOURCE_INTEGRITY_FAILED', 'No se pudo verificar la integridad del recurso.'); }
        },
        // Only orphaned files created by a failed upload are removed. Published
        // resources are soft-deleted in SQL; their recovery remains possible.
        async discardUncommitted(storageKey) {
            const { file } = await context(storageKey);
            const st = await fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
            if (st && (!st.isFile() || st.isSymbolicLink())) throw failure('RESOURCE_FILE_INVALID', 'Archivo de recurso no válido.');
            if (st) await fs.unlink(file);
        }
    };
}
module.exports = { createResourceStorage, MAX_BYTES };
