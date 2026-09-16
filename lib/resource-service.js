'use strict';
const crypto = require('node:crypto');
const { validateContent } = require('./resource-repository');
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }); };
const safeUrl = input => {
    if (typeof input !== 'string' || input.length > 4096) return null;
    try { const u = new URL(input); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? input : null; } catch { return null; }
};
function legacyPublicDocuments(documents) {
    return (Array.isArray(documents) ? documents : []).filter(d => d && typeof d.name === 'string' && d.name.trim() && safeUrl(d.url))
        .map(d => ({ name: d.name.slice(0, 200), url: d.url, type: ['document', 'link', 'zip', 'video'].includes(d.type) ? d.type : 'document', protection: 'public' }));
}
function serializeResource(row) {
    if (!row) return null;
    return { id: row.id, resourceId: row.id, targetKind: row.targetKind, targetId: row.targetId,
        name: row.name, type: row.type, protection: row.protection,
        sourceKind: row.storageKey ? 'file' : 'link',
        url: row.protection === 'protected' ? '/resources/' + row.id : row.publicUrl || '/resources/' + row.id + '/download',
        byteSize: row.byteSize, pageCount: row.pageCount, version: row.version,
        ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}) };
}
function createResourceService({ repository, storage, renderer, accessPolicy, secret, getProducer }) {
    function watermarkFor(actor, resource, deviceId) {
        return { email: typeof actor?.email === 'string' && actor.email ? actor.email.slice(0, 254) : 'Usuario autorizado',
            code: crypto.createHmac('sha256', secret).update([resource.id, actor?.sub || '', deviceId || ''].join('|')).digest('hex').slice(0, 12).toUpperCase() };
    }
    async function ownedTarget(actor, kind, id) {
        const target = await repository.resolveTarget(kind, id);
        assertOwner(actor, target);
        return target;
    }
    function assertOwner(actor, target) {
        if (actor?.admin === true) return;
        if (actor?.role !== 'producer' || !actor.producerId || actor.producerId !== target.producerId) fail('RESOURCE_FORBIDDEN', 'No puedes administrar este recurso.', 403);
    }
    async function existing(id) {
        const resource = await repository.get(id);
        if (!resource || resource.deletedAt) fail('RESOURCE_NOT_FOUND', 'El recurso ya no está disponible.', 404);
        return resource;
    }
    async function ownedResource(actor, id) {
        const resource = await existing(id);
        assertOwner(actor, resource);
        return resource;
    }
    function version(value) {
        if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) value = Number(value);
        if (!Number.isSafeInteger(value) || value < 1) fail('RESOURCE_VERSION_REQUIRED', 'Recarga el recurso antes de continuar.', 428);
        return value;
    }
    async function authorize(actor, resource, deviceId) {
        if (resource.protection !== 'protected') return;
        if (actor?.admin === true) return;
        if (actor?.role === 'producer' && actor.producerId === resource.producerId) {
            const producer = getProducer ? await getProducer(actor.producerId) : null;
            if (producer && (producer.active === 1 || producer.active === true)) return;
            fail('RESOURCE_FORBIDDEN', 'La cuenta productora está suspendida.', 403);
        }
        await accessPolicy.authorizeResource(actor, resource, deviceId);
    }
    async function pdfContent(file) {
        if (!file || !Buffer.isBuffer(file.buffer)) fail('RESOURCE_FILE_REQUIRED', 'Selecciona el archivo PDF.');
        if (file.cancelled?.()) fail('RESOURCE_UPLOAD_CANCELLED', 'La subida fue cancelada.', 499);
        const metadata = await renderer.inspect(file.buffer);
        if (file.cancelled?.()) fail('RESOURCE_UPLOAD_CANCELLED', 'La subida fue cancelada.', 499);
        return { mimeType: 'application/pdf', type: 'document', byteSize: file.buffer.length, pageCount: metadata.pageCount };
    }
    return {
        async list(actor, kind, id) {
            const target = await ownedTarget(actor, kind, id);
            return { resources: (await repository.listForTarget(kind, id)).map(serializeResource), legacyDocuments: legacyPublicDocuments(target.documents) };
        },
        async createLink(actor, input) {
            const target = await ownedTarget(actor, input.targetKind, input.targetId);
            if (input.protection != null && input.protection !== 'public') fail('RESOURCE_PDF_REQUIRED', 'Para proteger un PDF debes subir el archivo.');
            const content = { name: input.name, type: input.type || 'document', protection: 'public', publicUrl: input.url,
                storageKey: null, mimeType: null, byteSize: null, pageCount: null };
            validateContent(content);
            return serializeResource(await repository.create({ ...content, targetKind: target.targetKind, targetId: target.targetId, courseId: target.courseId, producerId: target.producerId }));
        },
        async upload(actor, input, file) {
            const target = await ownedTarget(actor, input.targetKind, input.targetId);
            const content = { ...(await pdfContent(file)), name: input.name, protection: input.protection || 'public', publicUrl: null, storageKey: crypto.randomUUID() };
            validateContent(content);
            const storageKey = await storage.put(file.buffer);
            let cancelledBeforeWrite = false;
            try { if (file.cancelled?.()) { cancelledBeforeWrite = true; fail('RESOURCE_UPLOAD_CANCELLED', 'La subida fue cancelada.', 499); }
                return serializeResource(await repository.create({ ...content, storageKey,
                targetKind: target.targetKind, targetId: target.targetId, courseId: target.courseId, producerId: target.producerId })); }
            catch (e) {
                if (cancelledBeforeWrite || e?.resourceWriteOutcome === 'rolled-back') await storage.discardUncommitted(storageKey).catch(() => {});
                // Preserve ciphertext when the database outcome is unknown.
                // Deleting it could destroy the source of a committed resource.
                throw e;
            }
        },
        async edit(actor, id, input) {
            const resource = await ownedResource(actor, id);
            const expectedVersion = version(input.expectedVersion);
            if (Object.keys(input).some(k => !['name', 'protection', 'url', 'expectedVersion'].includes(k))) fail('RESOURCE_INVALID_UPDATE', 'Este cambio no está admitido.');
            const changes = {};
            if (has(input, 'name')) changes.name = input.name;
            if (has(input, 'protection')) changes.protection = input.protection;
            if (has(input, 'url')) {
                if (resource.storageKey) fail('RESOURCE_INVALID_UPDATE', 'Un PDF alojado no se sustituye pegando una URL.');
                changes.publicUrl = input.url;
            }
            if (!resource.storageKey && changes.protection === 'protected') fail('RESOURCE_FILE_REQUIRED', 'Sube el PDF para activar su protección.');
            return serializeResource(await repository.update(id, changes, { expectedVersion }));
        },
        async replaceFile(actor, id, input, file) {
            const resource = await ownedResource(actor, id);
            const expectedVersion = version(input.expectedVersion);
            if (resource.version !== expectedVersion) fail('RESOURCE_VERSION_CONFLICT', 'Otra edición modificó el recurso. Recarga antes de guardar.', 409);
            const content = { ...(await pdfContent(file)), protection: input.protection || resource.protection, publicUrl: null };
            validateContent({ ...resource, ...content, storageKey: crypto.randomUUID() });
            const storageKey = await storage.put(file.buffer);
            let cancelledBeforeWrite = false;
            try { if (file.cancelled?.()) { cancelledBeforeWrite = true; fail('RESOURCE_UPLOAD_CANCELLED', 'La subida fue cancelada.', 499); }
                return serializeResource(await repository.update(id, { ...content, storageKey }, { expectedVersion })); }
            catch (e) {
                if (cancelledBeforeWrite || e?.resourceWriteOutcome === 'rolled-back') await storage.discardUncommitted(storageKey).catch(() => {});
                throw e;
            }
        },
        async remove(actor, id, input) {
            await ownedResource(actor, id);
            return serializeResource(await repository.delete(id, { expectedVersion: version(input.expectedVersion) }));
        },
        async describe(actor, id, deviceId) {
            const resource = await existing(id);
            await authorize(actor, resource, deviceId);
            const descriptor = serializeResource(resource);
            if (resource.protection === 'protected') delete descriptor.url;
            return { resource: descriptor, ...(resource.protection === 'protected' ? { watermark: watermarkFor(actor, resource, deviceId), leaseSeconds: 30 } : {}) };
        },
        async page(actor, id, deviceId, page, expectedVersion) {
            const resource = await existing(id);
            expectedVersion = version(expectedVersion);
            if (resource.protection !== 'protected') fail('RESOURCE_NOT_PROTECTED', 'Este recurso es libre. Abre su enlace.', 409);
            if (resource.version !== expectedVersion) fail('RESOURCE_VERSION_CONFLICT', 'El documento cambió. Vuelve a abrirlo.', 409);
            if (!Number.isSafeInteger(page) || page < 1 || page > resource.pageCount) fail('PDF_PAGE_INVALID', 'La página solicitada no existe.', 404);
            await authorize(actor, resource, deviceId);
            const bytes = await storage.read(resource.storageKey);
            let rendered;
            const watermark = watermarkFor(actor, resource, deviceId);
            try { rendered = await renderer.render(bytes, page, { watermark: watermark.email + ' · ' + watermark.code }); } finally { bytes.fill(0); }
            // Rendering can take seconds. Recheck both authorization and version
            // before sending a page, so revocation during work cannot win a race.
            try {
                const latest = await existing(id);
                if (latest.version !== expectedVersion || latest.protection !== 'protected') fail('RESOURCE_VERSION_CONFLICT', 'El documento cambió. Vuelve a abrirlo.', 409);
                await authorize(actor, latest, deviceId);
                return { png: rendered.png, version: latest.version };
            } catch (e) { rendered.png.fill(0); throw e; }
        },
        async publicInfo(id) { return serializeResource(await existing(id)); },
        async downloadPublic(id) {
            const resource = await existing(id);
            if (resource.protection !== 'public') fail('RESOURCE_PROTECTED', 'Este PDF requiere acceso desde el reproductor.', 403);
            if (resource.publicUrl) return { url: resource.publicUrl };
            const bytes = await storage.read(resource.storageKey);
            try {
                const latest = await existing(id);
                if (latest.protection !== 'public' || latest.version !== resource.version) fail('RESOURCE_VERSION_CONFLICT', 'El documento cambió. Vuelve a abrir el enlace.', 409);
                return { bytes, name: resource.name, mimeType: 'application/pdf' };
            } catch (e) { bytes.fill(0); throw e; }
        }
    };
}
module.exports = { createResourceService, serializeResource, legacyPublicDocuments };
