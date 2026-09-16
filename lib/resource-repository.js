'use strict';

const { randomUUID } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMITS = Object.freeze({ name: 200, url: 4096, pdfBytes: 25 * 1024 * 1024, pdfPages: 200, targets: 2000 });
const TYPES = new Set(['document', 'link', 'zip', 'video']);
const EDITABLE = new Set(['name', 'type', 'protection', 'publicUrl', 'storageKey', 'mimeType', 'byteSize', 'pageCount']);
const fail = (code, message, statusCode = 400) => { throw Object.assign(new Error(message), { code, statusCode }); };
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const owner = value => value == null || value === '' ? null : value;

function identifier(value, label = 'recurso') {
    if (typeof value !== 'string' || !UUID.test(value)) fail('RESOURCE_INVALID_ID', `Identificador de ${label} inválido.`);
    return value.toLowerCase();
}
function targetInput(kind, id) {
    if (kind !== 'video' && kind !== 'module') fail('RESOURCE_INVALID_TARGET', 'El destino debe ser un video o un módulo.');
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) fail('RESOURCE_INVALID_TARGET', 'Identificador del destino inválido.');
    return { kind, id };
}
function validateContent(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('RESOURCE_INVALID_INPUT', 'Recurso inválido.');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > LIMITS.name || /[\x00-\x1f\x7f]/.test(input.name)) fail('RESOURCE_INVALID_NAME', 'El nombre del recurso debe tener entre 1 y 200 caracteres.');
    if (!TYPES.has(input.type)) fail('RESOURCE_INVALID_TYPE', 'Tipo de recurso inválido.');
    if (input.protection !== 'public' && input.protection !== 'protected') fail('RESOURCE_INVALID_PROTECTION', 'Selecciona Libre o Protegido.');
    const publicUrl = input.publicUrl == null || input.publicUrl === '' ? null : input.publicUrl;
    const storageKey = input.storageKey == null || input.storageKey === '' ? null : identifier(input.storageKey, 'archivo');
    const mimeType = input.mimeType == null || input.mimeType === '' ? null : input.mimeType;
    const byteSize = input.byteSize == null ? null : input.byteSize;
    const pageCount = input.pageCount == null ? null : input.pageCount;
    if (mimeType != null && (typeof mimeType !== 'string' || mimeType.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType))) fail('RESOURCE_INVALID_MIME', 'Tipo de archivo inválido.');
    if (publicUrl) {
        if (typeof publicUrl !== 'string' || publicUrl.length > LIMITS.url || /[\x00-\x20\x7f]/.test(publicUrl)) fail('RESOURCE_INVALID_URL', 'Usa una URL pública HTTP o HTTPS válida.');
        let url; try { url = new URL(publicUrl); } catch { fail('RESOURCE_INVALID_URL', 'Usa una URL pública HTTP o HTTPS válida.'); }
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) fail('RESOURCE_INVALID_URL', 'Usa una URL pública HTTP o HTTPS sin credenciales.');
    }
    if (input.protection === 'protected' && publicUrl) fail('RESOURCE_PROTECTED_URL_FORBIDDEN', 'Un recurso protegido no puede conservar una URL pública.');
    if (Boolean(publicUrl) === Boolean(storageKey)) fail('RESOURCE_INVALID_SOURCE', 'Indica un enlace público o un archivo PDF almacenado.');
    if (storageKey) {
        if (input.type !== 'document' || mimeType !== 'application/pdf') fail('RESOURCE_PDF_REQUIRED', 'La protección y la carga de archivos requieren un PDF.');
        if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > LIMITS.pdfBytes) fail('RESOURCE_INVALID_SIZE', 'El PDF debe ocupar entre 1 byte y 25 MiB.');
        if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > LIMITS.pdfPages) fail('RESOURCE_INVALID_PAGES', 'El PDF debe tener entre 1 y 200 páginas.');
    } else {
        if (input.protection !== 'public') fail('RESOURCE_PDF_REQUIRED', 'Para proteger el PDF primero carga su archivo.');
        if (byteSize !== null || pageCount !== null) fail('RESOURCE_INVALID_SOURCE', 'Un enlace externo no puede declarar datos de un archivo almacenado.');
    }
    return { name: input.name.trim(), type: input.type, protection: input.protection, publicUrl, storageKey, mimeType, byteSize, pageCount };
}
function dto(row) {
    if (!row) return null;
    return { id: row.id, targetKind: row.target_kind, targetId: row.target_id, courseId: row.course_id,
        producerId: owner(row.producer_id), name: row.name, type: row.type, protection: row.protection,
        publicUrl: row.public_url, storageKey: row.storage_key, mimeType: row.mime_type,
        byteSize: row.byte_size == null ? null : Number(row.byte_size), pageCount: row.page_count,
        version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
}

function createResourceRepository({ db } = {}) {
    if (!db || !db.pool || typeof db.pool.query !== 'function' || typeof db.pool.connect !== 'function') throw new TypeError('Resource repository requires db.pool.');
    const pool = db.pool;
    async function transaction(work) {
        const client = await pool.connect().catch(error => {
            if (error && typeof error === 'object') error.resourceWriteOutcome = 'unknown';
            throw error;
        });
        let commitAttempted = false;
        try {
            await client.query('BEGIN');
            const result = await work(client);
            commitAttempted = true;
            await client.query('COMMIT');
            return result;
        } catch (error) {
            let rollbackConfirmed = false;
            try { await client.query('ROLLBACK'); rollbackConfirmed = true; } catch {}
            // A successful ROLLBACK after an uncertain COMMIT does not prove
            // that the preceding commit failed: PostgreSQL may already have
            // persisted the row before the connection lost its acknowledgement.
            if (error && typeof error === 'object') error.resourceWriteOutcome = !commitAttempted && rollbackConfirmed ? 'rolled-back' : 'unknown';
            throw error;
        }
        finally { client.release(); }
    }
    async function init() {
        await pool.query(`CREATE TABLE IF NOT EXISTS protected_resources (
            id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
            target_kind TEXT NOT NULL CHECK (target_kind IN ('video','module')),
            target_id TEXT NOT NULL,
            course_id TEXT,
            producer_id TEXT,
            name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
            type TEXT NOT NULL CHECK (type IN ('document','link','zip','video')),
            protection TEXT NOT NULL CHECK (protection IN ('public','protected')),
            public_url TEXT,
            storage_key TEXT UNIQUE CHECK (storage_key IS NULL OR storage_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
            mime_type TEXT,
            byte_size BIGINT,
            page_count INTEGER,
            version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT,
            CHECK ((public_url IS NOT NULL) <> (storage_key IS NOT NULL)),
            CHECK (public_url IS NULL OR (protection='public' AND byte_size IS NULL AND page_count IS NULL AND public_url ~ '^https?://')),
            CHECK (storage_key IS NULL OR (type='document' AND mime_type IS NOT NULL AND mime_type='application/pdf' AND byte_size IS NOT NULL AND byte_size BETWEEN 1 AND 26214400 AND page_count IS NOT NULL AND page_count BETWEEN 1 AND 200)),
            CHECK (protection <> 'protected' OR (public_url IS NULL AND storage_key IS NOT NULL)),
            CONSTRAINT protected_resources_protected_course_check CHECK (protection <> 'protected' OR (course_id IS NOT NULL AND length(trim(course_id)) > 0))
        )`);
        // Preserve existing public attachments on standalone videos. The lock
        // makes this own-table migration safe when several QA workers initialize.
        await transaction(async client => {
            await client.query('LOCK TABLE protected_resources IN ACCESS EXCLUSIVE MODE');
            await client.query('ALTER TABLE protected_resources ALTER COLUMN course_id DROP NOT NULL');
            await client.query(`DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='protected_resources'::regclass AND conname='protected_resources_protected_course_check') THEN
                    ALTER TABLE protected_resources ADD CONSTRAINT protected_resources_protected_course_check
                        CHECK (protection <> 'protected' OR (course_id IS NOT NULL AND length(trim(course_id)) > 0));
                END IF;
            END $$`);
        });
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_protected_resources_target ON protected_resources(target_kind,target_id,created_at,id) WHERE deleted_at IS NULL`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_protected_resources_owner ON protected_resources(producer_id,course_id) WHERE deleted_at IS NULL`);
    }
    async function resolve(client, kind, id) {
        targetInput(kind, id);
        const table = kind === 'video' ? 'catalog' : 'modules';
        const key = kind === 'video' ? 'video_id' : 'id';
        const row = (await client.query(`SELECT * FROM ${table} WHERE ${key}=$1 FOR SHARE`, [id])).rows[0];
        if (!row) fail('RESOURCE_TARGET_NOT_FOUND', 'El video o módulo ya no existe.', 404);
        let documents = []; try { const value = JSON.parse(row.documents || '[]'); if (Array.isArray(value)) documents = value; } catch {}
        if (!row.course_id) {
            if (kind !== 'video' || row.module_id) fail('RESOURCE_TARGET_WITHOUT_COURSE', 'El módulo debe pertenecer a un curso válido.', 409);
            return { targetKind: kind, targetId: id, courseId: null, producerId: owner(row.producer_id), videoId: id, moduleId: null, documents };
        }
        const course = (await client.query('SELECT id,producer_id FROM courses WHERE id=$1 FOR SHARE', [row.course_id])).rows[0];
        if (!course || owner(row.producer_id) !== owner(course.producer_id)) fail('RESOURCE_TARGET_OWNER_CONFLICT', 'El contenido y su curso no tienen el mismo propietario.', 409);
        const relatedId = kind === 'video' ? row.module_id : row.parent_id;
        if (relatedId) {
            const related = (await client.query('SELECT course_id,producer_id FROM modules WHERE id=$1 FOR SHARE', [relatedId])).rows[0];
            if (!related || related.course_id !== course.id || owner(related.producer_id) !== owner(course.producer_id)) fail('RESOURCE_TARGET_OWNER_CONFLICT', 'El módulo relacionado no pertenece al mismo curso y propietario.', 409);
        }
        return { targetKind: kind, targetId: id, courseId: course.id, producerId: owner(course.producer_id),
            videoId: kind === 'video' ? id : null, moduleId: kind === 'module' ? id : row.module_id || null, documents };
    }
    const resolveTarget = (kind, id) => transaction(client => resolve(client, kind, id));
    function requireSameTarget(resource, target) {
        if (resource.course_id !== target.courseId || owner(resource.producer_id) !== target.producerId) fail('RESOURCE_TARGET_CHANGED', 'El contenido cambió de curso o propietario. Revisa sus recursos antes de continuar.', 409);
    }
    function requireProtectedCourse(content, target) {
        if (content.protection === 'protected' && !target.courseId) fail('RESOURCE_TARGET_WITHOUT_COURSE', 'Asigna el video a un curso antes de proteger su PDF.', 409);
    }
    async function create(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('RESOURCE_INVALID_INPUT', 'Recurso inválido.');
        const id = input.id == null ? randomUUID() : identifier(input.id);
        const content = validateContent(input);
        targetInput(input.targetKind, input.targetId);
        return transaction(async client => {
            const target = await resolve(client, input.targetKind, input.targetId);
            requireProtectedCourse(content, target);
            if ((has(input, 'courseId') && input.courseId !== target.courseId) || (has(input, 'producerId') && owner(input.producerId) !== target.producerId)) fail('RESOURCE_TARGET_OWNER_CONFLICT', 'El recurso no corresponde al curso y propietario del destino.', 409);
            const now = new Date().toISOString();
            const values = [id, target.targetKind, target.targetId, target.courseId, target.producerId,
                content.name, content.type, content.protection, content.publicUrl, content.storageKey, content.mimeType, content.byteSize, content.pageCount, now];
            try {
                return dto((await client.query(`INSERT INTO protected_resources
                    (id,target_kind,target_id,course_id,producer_id,name,type,protection,public_url,storage_key,mime_type,byte_size,page_count,created_at,updated_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`, values)).rows[0]);
            } catch (error) { if (error.code === '23505') fail('RESOURCE_CONFLICT', 'El recurso o su archivo ya está registrado.', 409); throw error; }
        });
    }
    async function get(id) {
        id = identifier(id);
        return transaction(async client => {
            const row = (await client.query('SELECT * FROM protected_resources WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [id])).rows[0];
            if (!row) return null;
            requireSameTarget(row, await resolve(client, row.target_kind, row.target_id));
            return dto(row);
        });
    }
    async function listForTargets(targets) {
        if (!Array.isArray(targets) || targets.length > LIMITS.targets) fail('RESOURCE_INVALID_TARGET', 'Lista de destinos inválida.');
        const unique = [...new Map(targets.map(target => { const value = targetInput(target?.kind, target?.id); return [JSON.stringify([value.kind, value.id]), value]; })).values()];
        if (!unique.length) return [];
        return transaction(async client => {
            const rows = (await client.query(`SELECT r.* FROM protected_resources r JOIN unnest($1::text[],$2::text[]) AS t(kind,id)
                ON r.target_kind=t.kind AND r.target_id=t.id WHERE r.deleted_at IS NULL ORDER BY r.created_at,r.id FOR SHARE OF r`,
            [unique.map(value => value.kind), unique.map(value => value.id)])).rows;
            const checked = new Map();
            const result = [];
            for (const row of rows) {
                const key = JSON.stringify([row.target_kind, row.target_id]);
                if (!checked.has(key)) {
                    try { checked.set(key, await resolve(client, row.target_kind, row.target_id)); }
                    catch (error) {
                        if (['RESOURCE_TARGET_NOT_FOUND', 'RESOURCE_TARGET_WITHOUT_COURSE', 'RESOURCE_TARGET_OWNER_CONFLICT'].includes(error.code)) checked.set(key, null);
                        else throw error;
                    }
                }
                const target = checked.get(key);
                if (target && row.course_id === target.courseId && owner(row.producer_id) === target.producerId) result.push(dto(row));
            }
            return result;
        });
    }
    const listForTarget = (kind, id) => listForTargets([{ kind, id }]);
    function expected(options) {
        if (!options || !Number.isSafeInteger(options.expectedVersion) || options.expectedVersion < 1) fail('RESOURCE_VERSION_REQUIRED', 'Recarga el recurso antes de guardar los cambios.', 428);
        return options.expectedVersion;
    }
    async function mutate(id, changes, options, deleting) {
        id = identifier(id);
        const version = expected(options);
        if (!deleting) {
            if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(key => !EDITABLE.has(key))) fail('RESOURCE_INVALID_UPDATE', 'Solo se pueden editar los datos del recurso; su destino e identidad son inmutables.');
        }
        return transaction(async client => {
            const row = (await client.query('SELECT * FROM protected_resources WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
            if (!row) fail('RESOURCE_NOT_FOUND', 'El recurso ya no existe.', 404);
            if (row.version !== version) fail('RESOURCE_VERSION_CONFLICT', 'Otra edición modificó este recurso. Recarga antes de guardar.', 409);
            const target = await resolve(client, row.target_kind, row.target_id);
            requireSameTarget(row, target);
            const now = new Date().toISOString();
            if (deleting) return dto((await client.query('UPDATE protected_resources SET deleted_at=$2,updated_at=$2,version=version+1 WHERE id=$1 RETURNING *', [id, now])).rows[0]);
            const content = validateContent({ ...dto(row), ...changes });
            requireProtectedCourse(content, target);
            try {
                return dto((await client.query(`UPDATE protected_resources SET name=$2,type=$3,protection=$4,public_url=$5,storage_key=$6,mime_type=$7,
                    byte_size=$8,page_count=$9,updated_at=$10,version=version+1 WHERE id=$1 RETURNING *`,
                [id, content.name, content.type, content.protection, content.publicUrl, content.storageKey, content.mimeType, content.byteSize, content.pageCount, now])).rows[0]);
            } catch (error) { if (error.code === '23505') fail('RESOURCE_CONFLICT', 'El archivo ya pertenece a otro recurso.', 409); throw error; }
        });
    }
    return { init, resolveTarget, create, get, listForTarget, listForTargets,
        update: (id, changes, options) => mutate(id, changes, options, false),
        delete: (id, options) => mutate(id, null, options, true) };
}

module.exports = { createResourceRepository, validateContent, LIMITS };
