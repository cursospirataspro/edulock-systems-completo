'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createResourceService, serializeResource, legacyPublicDocuments } = require('../lib/resource-service');
const { validateContent, createResourceRepository } = require('../lib/resource-repository');
function fixture() {
    const state = { resource: null, storageReads: 0, rendererCalls: 0, authorizations: 0, denied: false, producerActive: 1, discard: [], storagePuts: [],
        target: { targetKind: 'module', targetId: 'module-a', courseId: 'course-a', producerId: 'producer-a', documents: [{ name: 'Legacy', url: 'https://example.invalid/a.pdf?Original=%2F', type: 'document' }] } };
    const repository = {
        resolveTarget: async () => ({ ...state.target }), get: async () => { if (state.getError) throw new Error('SQL unavailable'); return state.resource && !state.resource.deletedAt ? { ...state.resource } : null; },
        listForTarget: async () => state.resource ? [{ ...state.resource }] : [],
        create: async input => {
            if (state.createError) throw Object.assign(new Error('SQL write failed, rollback confirmed'), { resourceWriteOutcome: 'rolled-back' });
            state.resource = { ...validateContent(input), ...state.target, id: crypto.randomUUID(), version: 1 };
            if (state.createCommitUncertain) throw Object.assign(new Error('COMMIT acknowledged by server but connection lost'), { code: 'ECONNRESET', resourceWriteOutcome: 'unknown' });
            return state.resource;
        },
        update: async (_id, changes, options) => {
            if (options.expectedVersion !== state.resource.version) throw Object.assign(new Error('stale'), { code: 'RESOURCE_VERSION_CONFLICT', statusCode: 409 });
            if (state.updateError) throw Object.assign(new Error('SQL write failed, rollback confirmed'), { resourceWriteOutcome: 'rolled-back' });
            state.resource = { ...state.resource, ...validateContent({ ...state.resource, ...changes }), version: state.resource.version + 1 };
            if (state.updateCommitUncertain) throw Object.assign(new Error('COMMIT acknowledged by server but connection lost'), { code: 'ECONNRESET', resourceWriteOutcome: 'unknown' });
            return state.resource;
        },
        delete: async (_id, options) => { if (options.expectedVersion !== state.resource.version) throw Object.assign(new Error('stale'), { code: 'RESOURCE_VERSION_CONFLICT' }); state.resource.deletedAt = new Date().toISOString(); return state.resource; }
    };
    const storage = { put: async () => { const key = crypto.randomUUID(); state.storagePuts.push(key); state.afterPut?.(); return key; }, discardUncommitted: async id => state.discard.push(id),
        read: async () => { state.storageReads++; state.readBytes = Buffer.from('%PDF-original'); state.afterRead?.(); return state.readBytes; } };
    const renderer = { inspect: async () => { state.afterInspect?.(); return { pageCount: 2 }; }, render: async (_bytes, _page, options) => {
        state.rendererCalls++; state.watermark = options.watermark; state.rendered = Buffer.from('png-bytes'); state.afterRender?.(); return { png: state.rendered };
    } };
    const accessPolicy = { authorizeResource: async () => { state.authorizations++; if (state.denied) throw Object.assign(new Error('revoked'), { code: 'LICENSE_REQUIRED', status: 403 }); } };
    const service = createResourceService({ repository, storage, renderer, accessPolicy, secret: 'synthetic-resource-test-secret', getProducer: async () => ({ active: state.producerActive }) });
    return { state, service, actor: { sub: 'producer-a', role: 'producer', producerId: 'producer-a', email: 'producer@example.invalid' },
        student: { sub: 'student-a', email: 'student@example.invalid' }, file: { buffer: Buffer.from('%PDF-fixture') },
        input: { targetKind: 'module', targetId: 'module-a', name: 'Example PDF', protection: 'protected' } };
}
test('legacy links remain public and unchanged; unsafe protocols are excluded', () => {
    const legacy = [{ name: 'A', url: 'https://example.invalid/File.pdf?Sig=%2f', type: 'document' }];
    const original = JSON.stringify(legacy);
    assert.equal(legacyPublicDocuments(legacy)[0].url, legacy[0].url);
    assert.equal(legacyPublicDocuments(legacy)[0].protection, 'public'); assert.equal(JSON.stringify(legacy), original);
    for (const url of ['javascript:alert(1)', 'data:application/pdf,secret', 'file:///secret', 'https://u:p@example.invalid/']) assert.equal(legacyPublicDocuments([{ name: 'x', url }]).length, 0);
});
test('protected DTO cannot reveal storage key or original URL', async () => {
    const f = fixture(); const dto = await f.service.upload(f.actor, f.input, f.file);
    assert.equal(dto.protection, 'protected'); assert.equal(dto.sourceKind, 'file'); assert.equal(dto.url, '/resources/' + dto.id);
    assert.equal(dto.storageKey, undefined); assert.equal(dto.publicUrl, undefined);
    const descriptor = await f.service.describe(f.student, dto.id, 'device'); assert.equal(descriptor.resource.url, undefined); assert.equal(descriptor.leaseSeconds, 30);
});
test('public link preserves URL and does not create encrypted storage', async () => {
    const f = fixture(); const url = 'https://example.invalid/My%20PDF.pdf?token=PublicValue';
    const result = await f.service.createLink(f.actor, { ...f.input, protection: 'public', url });
    assert.equal(result.url, url); assert.equal(result.sourceKind, 'link'); assert.deepEqual(await f.service.downloadPublic(result.id), { url });
    assert.equal(f.state.storageReads, 0);
});
test('protected upload needs actual file; labeling an external link protected is rejected', async () => {
    const f = fixture(); await assert.rejects(f.service.createLink(f.actor, { ...f.input, url: 'https://example.invalid/a.pdf' }), { code: 'RESOURCE_PDF_REQUIRED' });
    await assert.rejects(f.service.upload(f.actor, f.input, null), { code: 'RESOURCE_FILE_REQUIRED' });
});
test('upload defaults Libre and returns original bytes anonymously', async () => {
    const f = fixture(); const input = { ...f.input }; delete input.protection;
    const result = await f.service.upload(f.actor, input, f.file);
    assert.equal(result.protection, 'public'); assert.equal((await f.service.downloadPublic(result.id)).bytes.toString(), '%PDF-original'); assert.equal(f.state.authorizations, 0);
});
test('protected source download is denied even while student is authorized', async () => {
    const f = fixture(); const result = await f.service.upload(f.actor, f.input, f.file);
    await assert.rejects(f.service.downloadPublic(result.id), { code: 'RESOURCE_PROTECTED', status: 403 }); assert.equal(f.state.storageReads, 0);
});
test('producer cannot manage another owner resource or target', async () => {
    const f = fixture(); const other = { ...f.actor, producerId: 'foreign' };
    await assert.rejects(f.service.upload(other, f.input, f.file), { code: 'RESOURCE_FORBIDDEN' });
    const result = await f.service.upload(f.actor, f.input, f.file);
    for (const operation of [() => f.service.edit(other, result.id, { name: 'X', expectedVersion: 1 }), () => f.service.remove(other, result.id, { expectedVersion: 1 }), () => f.service.list(other, 'module', 'module-a')]) await assert.rejects(operation(), { code: 'RESOURCE_FORBIDDEN' });
});
test('denied student cannot receive descriptor or render any page', async () => {
    const f = fixture(); const result = await f.service.upload(f.actor, f.input, f.file); f.state.denied = true;
    await assert.rejects(f.service.describe(f.student, result.id, 'device'), { code: 'LICENSE_REQUIRED' });
    await assert.rejects(f.service.page(f.student, result.id, 'device', 1, 1), { code: 'LICENSE_REQUIRED' }); assert.equal(f.state.rendererCalls, 0);
});
test('authorized page has user-specific mark and is authorized again after rendering', async () => {
    const f = fixture(); const result = await f.service.upload(f.actor, f.input, f.file);
    const page = await f.service.page(f.student, result.id, 'device', 1, 1);
    assert.equal(page.png.toString(), 'png-bytes'); assert.equal(f.state.authorizations, 2); assert.match(f.state.watermark, /student@example\.invalid/); assert.ok(f.state.readBytes.every(n => n === 0));
});
for (const cause of ['license', 'version', 'SQL', 'delete']) test('page never returns after ' + cause + ' changes during rendering', async () => {
    const f = fixture(); const result = await f.service.upload(f.actor, f.input, f.file);
    f.state.afterRender = () => { if (cause === 'license') f.state.denied = true; if (cause === 'version') f.state.resource.version++; if (cause === 'SQL') f.state.getError = true; if (cause === 'delete') f.state.resource.deletedAt = 'now'; };
    await assert.rejects(f.service.page(f.student, result.id, 'device', 1, 1)); assert.ok(f.state.rendered.every(n => n === 0));
});
test('producer suspension during rendering also prevents the page response', async () => {
    const f = fixture(); const result = await f.service.upload(f.actor, f.input, f.file); f.state.afterRender = () => f.state.producerActive = 0;
    await assert.rejects(f.service.page(f.actor, result.id, 'device', 1, 1), { code: 'RESOURCE_FORBIDDEN' }); assert.ok(f.state.rendered.every(n => n === 0));
});
test('page index and stale/missing version fail before rendering', async () => {
    const f = fixture(); const result = await f.service.upload(f.actor, f.input, f.file);
    for (const page of [0, -1, 3, 1.5, NaN]) await assert.rejects(f.service.page(f.student, result.id, 'device', page, 1), { code: 'PDF_PAGE_INVALID' });
    await assert.rejects(f.service.page(f.student, result.id, 'device', 1, 2), { code: 'RESOURCE_VERSION_CONFLICT' });
    await assert.rejects(f.service.page(f.student, result.id, 'device', 1, undefined), { code: 'RESOURCE_VERSION_REQUIRED' }); assert.equal(f.state.rendererCalls, 0);
});
test('switching Libre to Protegido immediately closes the former public download', async () => {
    const f = fixture(); const result = await f.service.upload(f.actor, { ...f.input, protection: 'public' }, f.file);
    await f.service.downloadPublic(result.id); const changed = await f.service.edit(f.actor, result.id, { protection: 'protected', expectedVersion: 1 });
    assert.equal(changed.protection, 'protected'); await assert.rejects(f.service.downloadPublic(result.id), { code: 'RESOURCE_PROTECTED' });
    await assert.rejects(f.service.edit(f.actor, result.id, { protection: 'public', expectedVersion: 1 }), { code: 'RESOURCE_VERSION_CONFLICT' });
    await f.service.edit(f.actor, result.id, { protection: 'public', expectedVersion: 2 }); assert.ok((await f.service.downloadPublic(result.id)).bytes);
});
test('replacing a Libre file without choosing mode keeps Libre', async () => {
    const f = fixture(); const result = await f.service.upload(f.actor, { ...f.input, protection: 'public' }, f.file);
    assert.equal((await f.service.replaceFile(f.actor, result.id, { expectedVersion: 1 }, f.file)).protection, 'public');
});
test('an external link is never turned into a file stored on the server, not even by replacing its file', async () => {
    const f = fixture(); const result = await f.service.createLink(f.actor, { ...f.input, protection: 'public', url: 'https://example.invalid/a.pdf' });
    await assert.rejects(f.service.edit(f.actor, result.id, { protection: 'protected', expectedVersion: 1 }), { code: 'RESOURCE_FILE_REQUIRED' });
    await assert.rejects(f.service.replaceFile(f.actor, result.id, { protection: 'protected', expectedVersion: 1 }, f.file), { code: 'RESOURCE_REPLACE_LINK_FORBIDDEN' });
    await assert.rejects(f.service.replaceFile(f.actor, result.id, { expectedVersion: 1 }, f.file), { code: 'RESOURCE_REPLACE_LINK_FORBIDDEN' });
    assert.equal(f.state.resource.publicUrl, 'https://example.invalid/a.pdf', 'the link keeps its URL');
    assert.equal(f.state.resource.storageKey, null); assert.deepEqual(f.state.storagePuts, [], 'nothing was written to the server storage');
    // A PDF already hosted (historical) can still replace its file.
    const hosted = await f.service.upload(f.actor, { ...f.input, targetId: 'module-a', protection: 'protected' }, f.file);
    assert.equal((await f.service.replaceFile(f.actor, hosted.id, { expectedVersion: 1 }, f.file)).protection, 'protected');
});
test('a failed SQL upload discards only its new encrypted orphan', async () => {
    const f = fixture(); f.state.createError = true; await assert.rejects(f.service.upload(f.actor, f.input, f.file)); assert.equal(f.state.discard.length, 1);
});
test('cancelled upload cannot create a resource after PDF processing', async () => {
    const f = fixture(); let cancelled = false; f.file.cancelled = () => cancelled; f.state.afterInspect = () => cancelled = true;
    await assert.rejects(f.service.upload(f.actor, f.input, f.file), { code: 'RESOURCE_UPLOAD_CANCELLED' }); assert.equal(f.state.resource, null);
});
test('public plaintext is cleared if SQL recheck fails after reading', async () => {
    const f = fixture(); const result = await f.service.upload(f.actor, { ...f.input, protection: 'public' }, f.file); f.state.afterRead = () => f.state.getError = true;
    await assert.rejects(f.service.downloadPublic(result.id)); assert.ok(f.state.readBytes.every(n => n === 0));
});
test('soft deletion removes the public/reader entry without deleting the source blob', async () => {
    const f = fixture(); const result = await f.service.upload(f.actor, f.input, f.file); const deleted = await f.service.remove(f.actor, result.id, { expectedVersion: 1 });
    assert.ok(deleted.deletedAt); await assert.rejects(f.service.describe(f.student, result.id, 'device'), { code: 'RESOURCE_NOT_FOUND' }); assert.equal(f.state.discard.length, 0);
});
test('a lost COMMIT acknowledgement after create preserves the ciphertext referenced by the persisted row', async () => {
    const f = fixture(); f.state.createCommitUncertain = true;
    await assert.rejects(f.service.upload(f.actor, f.input, f.file), { code: 'ECONNRESET', resourceWriteOutcome: 'unknown' });
    assert.ok(f.state.resource); assert.equal(f.state.resource.storageKey, f.state.storagePuts[0]);
    assert.deepEqual(f.state.discard, []);
});
test('a lost COMMIT acknowledgement after replacement preserves the new source and reports failure', async () => {
    const f = fixture(); const resource = await f.service.upload(f.actor, f.input, f.file); const oldKey = f.state.resource.storageKey;
    f.state.updateCommitUncertain = true;
    await assert.rejects(f.service.replaceFile(f.actor, resource.id, { expectedVersion: 1 }, f.file), { code: 'ECONNRESET', resourceWriteOutcome: 'unknown' });
    assert.equal(f.state.resource.version, 2); assert.notEqual(f.state.resource.storageKey, oldKey);
    assert.equal(f.state.resource.storageKey, f.state.storagePuts[1]); assert.deepEqual(f.state.discard, []);
});
test('a confirmed rollback during replacement discards only its uncommitted new source', async () => {
    const f = fixture(); const resource = await f.service.upload(f.actor, f.input, f.file); const oldKey = f.state.resource.storageKey;
    f.state.updateError = true;
    await assert.rejects(f.service.replaceFile(f.actor, resource.id, { expectedVersion: 1 }, f.file), { resourceWriteOutcome: 'rolled-back' });
    assert.equal(f.state.resource.version, 1); assert.equal(f.state.resource.storageKey, oldKey);
    assert.deepEqual(f.state.discard, [f.state.storagePuts[1]]);
});
for (const operation of ['upload', 'replaceFile']) test('cancellation after encryption and before ' + operation + ' removes only the uncommitted file', async () => {
    const f = fixture(); let resource;
    if (operation === 'replaceFile') resource = await f.service.upload(f.actor, f.input, f.file);
    const previous = f.state.resource && { ...f.state.resource };
    let cancelled = false; f.file.cancelled = () => cancelled; f.state.afterPut = () => { cancelled = true; };
    await assert.rejects(operation === 'upload' ? f.service.upload(f.actor, f.input, f.file) : f.service.replaceFile(f.actor, resource.id, { expectedVersion: 1 }, f.file), { code: 'RESOURCE_UPLOAD_CANCELLED' });
    assert.deepEqual(f.state.resource, previous); assert.deepEqual(f.state.discard, [f.state.storagePuts.at(-1)]);
});

// Real repository transaction sequencing with an injected PostgreSQL transport:
// the transaction itself must distinguish rollback evidence from a lost COMMIT
// acknowledgement. No database or filesystem writes occur in these fault probes.
function transactionProbe({ statementFailure = false, commitFailure = false, rollbackFailure = false, connectFailure = false } = {}) {
    const state = { commitAttempted: false, persisted: false, rollbackAttempted: false, released: false };
    const connectionError = () => Object.assign(new Error('synthetic transport loss'), { code: 'ECONNRESET' });
    const client = { release: () => { state.released = true; }, query: async sql => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'COMMIT') { state.commitAttempted = true; state.persisted = true; if (commitFailure) throw connectionError(); return { rows: [] }; }
        if (sql === 'ROLLBACK') { state.rollbackAttempted = true; if (rollbackFailure) throw connectionError(); return { rows: [] }; }
        if (sql.startsWith('SELECT * FROM modules')) return { rows: [{ id: 'module-a', course_id: 'course-a', producer_id: null }] };
        if (sql.startsWith('SELECT id,producer_id FROM courses')) return { rows: [{ id: 'course-a', producer_id: null }] };
        if (sql.startsWith('INSERT INTO protected_resources')) {
            if (statementFailure) throw Object.assign(new Error('synthetic rejected SQL statement'), { code: '40001' });
            return { rows: [{ id: crypto.randomUUID(), version: 1 }] };
        }
        throw new Error('Unexpected SQL in transaction probe: ' + sql);
    } };
    const db = { pool: { query: async () => ({ rows: [] }), connect: async () => { if (connectFailure) throw connectionError(); return client; } } };
    const repository = createResourceRepository({ db });
    return { state, create: () => repository.create({ targetKind: 'module', targetId: 'module-a', name: 'Synthetic PDF', type: 'document', protection: 'protected', publicUrl: null, storageKey: crypto.randomUUID(), mimeType: 'application/pdf', byteSize: 100, pageCount: 1 }) };
}
test('repository marks rolled-back only after a pre-COMMIT failure and confirmed ROLLBACK', async () => {
    const probe = transactionProbe({ statementFailure: true });
    await assert.rejects(probe.create(), { code: '40001', resourceWriteOutcome: 'rolled-back' });
    assert.equal(probe.state.commitAttempted, false); assert.equal(probe.state.rollbackAttempted, true); assert.equal(probe.state.persisted, false); assert.equal(probe.state.released, true);
});
test('successful ROLLBACK after a lost COMMIT acknowledgement still means unknown outcome', async () => {
    const probe = transactionProbe({ commitFailure: true });
    await assert.rejects(probe.create(), { code: 'ECONNRESET', resourceWriteOutcome: 'unknown' });
    assert.equal(probe.state.commitAttempted, true); assert.equal(probe.state.persisted, true); assert.equal(probe.state.rollbackAttempted, true); assert.equal(probe.state.released, true);
});
test('an unconfirmed ROLLBACK never authorizes cleanup', async () => {
    const probe = transactionProbe({ statementFailure: true, rollbackFailure: true });
    await assert.rejects(probe.create(), { code: '40001', resourceWriteOutcome: 'unknown' }); assert.equal(probe.state.released, true);
});
test('connection failure carries unknown outcome and never invents rollback evidence', async () => {
    const probe = transactionProbe({ connectFailure: true });
    await assert.rejects(probe.create(), { code: 'ECONNRESET', resourceWriteOutcome: 'unknown' });
    assert.equal(probe.state.rollbackAttempted, false); assert.equal(probe.state.commitAttempted, false);
});
