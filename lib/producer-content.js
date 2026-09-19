'use strict';

// Producer content management. Remote provider credentials and media URLs never
// enter this DTO layer. Removing a catalog entry does not delete provider files.
const { randomBytes, randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const fail = (code, message, statusCode = 400, extra = {}) => { throw Object.assign(new Error(message), { code, statusCode, ...extra }); };
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEFAULT_PRESENTATION = Object.freeze({ coverUrl: null, theme: 'dark', description: '' });
const DEFAULT_SETTINGS = Object.freeze({ purchaseUrl: null, description: '', embedOrigins: [] });

function identifier(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x20\x7f/\\]/.test(value)) fail('CONTENT_INVALID_ID', 'Identificador inválido.');
    return value;
}
function textValue(value, max, required = false) {
    if (typeof value !== 'string' || value.trim().length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (required && !value.trim())) fail('CONTENT_INVALID_TEXT', `El texto debe contener ${required ? 'entre 1 y' : 'como máximo'} ${max} caracteres.`);
    return value.trim();
}
function httpsUrl(value) {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) fail('CONTENT_INVALID_URL', 'Usa una URL HTTPS sin credenciales.');
    let url; try { url = new URL(value); } catch { fail('CONTENT_INVALID_URL', 'Usa una URL HTTPS válida.'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) fail('CONTENT_INVALID_URL', 'Usa una URL HTTPS sin credenciales.');
    return url.href;
}
function sortOrder(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) fail('CONTENT_INVALID_ORDER', 'El orden debe ser un entero entre 0 y 1000000.');
    return value;
}
function embedOrigins(value) {
    if (!Array.isArray(value) || value.length > 10) fail('CONTENT_INVALID_EMBED_ORIGINS', 'Indica hasta 10 orígenes HTTPS para insertar el contenido.');
    const result = [];
    for (const item of value) {
        const clean = httpsUrl(item);
        if (!clean) fail('CONTENT_INVALID_EMBED_ORIGINS', 'Cada origen debe ser un dominio HTTPS válido.');
        const url = new URL(clean), host = url.hostname.toLowerCase();
        if ((url.pathname !== '/' || url.search || url.hash) || !host.includes('.') || isIP(host.replace(/^\[|\]$/g, '')) || /(^|\.)(localhost|local)$/.test(host) || !/^[a-z0-9.-]+$/.test(host)) fail('CONTENT_INVALID_EMBED_ORIGINS', 'Usa orígenes HTTPS con dominio público, sin ruta, IP ni localhost.');
        result.push(url.origin);
    }
    return [...new Set(result)];
}
function safeEmbedOrigins(value) { try { return embedOrigins(value || []); } catch { return []; } }
function inputObject(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) fail('CONTENT_INVALID_INPUT', 'Indica los cambios que quieres guardar.');
    for (const key of Object.keys(input)) if (!allowed.includes(key)) fail('CONTENT_UNKNOWN_FIELD', 'Este campo no se puede modificar desde el panel del productor.');
}
function validateSettings(input, presentation = false) {
    const allowed = presentation ? ['coverUrl', 'theme', 'description'] : ['purchaseUrl', 'description', 'embedOrigins'];
    inputObject(input, allowed);
    const result = {};
    for (const key of allowed) if (own(input, key)) {
        if (key === 'embedOrigins') result[key] = embedOrigins(input[key]);
        else if (key.endsWith('Url')) result[key] = httpsUrl(input[key]);
        else if (key === 'theme') {
            if (!['dark', 'light'].includes(input.theme)) fail('CONTENT_INVALID_THEME', 'Selecciona tema oscuro o claro.');
            result.theme = input.theme;
        } else result.description = textValue(input.description, 2000);
    }
    return result;
}
function validatePatch(kind, input) {
    const allowed = kind === 'course' ? ['name', 'author', 'sortOrder', 'settings'] : kind === 'module' ? ['name', 'parentId', 'sortOrder', 'playlistPublished'] : ['title', 'courseId', 'moduleId', 'sortOrder', 'presentation'];
    inputObject(input, allowed);
    const out = {};
    for (const key of Object.keys(input)) {
        if (['name', 'title'].includes(key)) out[key] = textValue(input[key], key === 'title' ? 200 : 120, true);
        else if (key === 'author') out.author = textValue(input.author, 100);
        else if (key === 'sortOrder') out.sortOrder = sortOrder(input.sortOrder);
        else if (key.endsWith('Id')) out[key] = input[key] === null || input[key] === '' ? null : identifier(input[key]);
        else if (key === 'playlistPublished') {
            if (typeof input[key] !== 'boolean') fail('CONTENT_INVALID_PLAYLIST', 'La publicación de la lista debe ser verdadera o falsa.');
            out[key] = input[key];
        } else out[key] = validateSettings(input[key], key === 'presentation');
    }
    return out;
}
function asJson(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return {}; return value; }
function documentsPresent(value) {
    if (!value) return false;
    try { const result = typeof value === 'string' ? JSON.parse(value) : value; return !Array.isArray(result) || result.length > 0; } catch { return true; }
}
function presentationDto(value) {
    const data = asJson(value);
    return { coverUrl: typeof data.coverUrl === 'string' ? data.coverUrl : null, theme: data.theme === 'light' ? 'light' : 'dark', description: typeof data.description === 'string' ? data.description : '' };
}
function courseDto(row) {
    const settings = asJson(row.settings);
    return { id: row.id, name: row.name, author: row.author || '', sortOrder: row.sort_order || 0, createdAt: row.created_at,
        settings: { purchaseUrl: typeof settings.purchaseUrl === 'string' ? settings.purchaseUrl : null, description: typeof settings.description === 'string' ? settings.description : '', embedOrigins: safeEmbedOrigins(settings.embedOrigins) } };
}
function legacyDocumentCount(value) {
    if (!value) return 0;
    try { const result = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(result) ? result.length : 1; } catch { return 1; }
}
function moduleDto(row) {
    return { id: row.id, courseId: row.course_id, parentId: row.parent_id || null, name: row.name, sortOrder: row.sort_order || 0,
        createdAt: row.created_at, playlistCode: row.playlist_code || null, playlistUrl: row.playlist_code ? '/playlist/' + encodeURIComponent(row.playlist_code) : null,
        bunnyCollectionId: row.bunny_collection_id || null, attachments: Number(row.attachments || 0) + legacyDocumentCount(row.documents) };
}
function videoDto(row) {
    return { videoId: row.video_id, courseId: row.course_id || null, moduleId: row.module_id || null, title: row.title, status: row.status,
        sourceType: row.source_type || 'local', sortOrder: row.sort_order || 0, publicCode: row.public_code || null, createdAt: row.uploaded_at,
        presentation: presentationDto(row.settings), attachments: Number(row.attachments || 0) + legacyDocumentCount(row.documents),
        collectionSyncPending: row.collection_sync_pending === true };
}

async function ensureSchema(db) {
    await db.pool.query(`CREATE TABLE IF NOT EXISTS producer_content_settings (
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('course','module','video')),
        entity_id TEXT NOT NULL,
        producer_id TEXT NOT NULL,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings)='object'),
        playlist_code TEXT UNIQUE,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(entity_kind,entity_id),
        CHECK (playlist_code IS NULL OR (entity_kind='module' AND playlist_code ~ '^[a-zA-Z0-9_-]{24}$'))
    )`);
    await db.pool.query('CREATE INDEX IF NOT EXISTS idx_producer_content_settings_owner ON producer_content_settings(producer_id,entity_kind)');
}

// Confirma que la clase sigue en el módulo que se acaba de sincronizar con el proveedor.
// `confirmed:false` deja la sincronización pendiente: un movimiento más nuevo la reemplazó,
// o la comprobación falló (`unknown:true`) y no poder comprobar nunca equivale a confirmar.
async function confirmStillInModule(db, videoId, courseId, moduleId) {
    if (!db || typeof db.getCatalogById !== 'function') return { confirmed: true };
    let now;
    try { now = await db.getCatalogById(videoId); }
    catch { return { confirmed: false, unknown: true }; }
    if (!now) return { confirmed: true }; // la clase ya no está en el catálogo: nada que sincronizar
    return { confirmed: (now.moduleId || null) === (moduleId || null) && (now.courseId || null) === (courseId || null) };
}

function createProducerContent({ db, generatePublicCode, syncCollection, deleteProviderAsset,
    describeProviderAsset, runProviderDeletions } = {}) {
    if (!db?.pool?.query || !db.pool.connect) throw new TypeError('Producer content requires db.pool.');
    const pool = db.pool;
    async function transaction(producerId, work) {
        identifier(producerId);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Account-level serialization also coordinates with license quota edits.
            const producer = (await client.query('SELECT id,active FROM producers WHERE id=$1 FOR UPDATE', [producerId])).rows[0];
            if (!producer || ![1, true].includes(producer.active)) fail('CONTENT_PRODUCER_UNAVAILABLE', 'Cuenta de productor no disponible.', 403);
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
        finally { client.release(); }
    }
    async function owned(client, kind, id, producerId, lock = 'UPDATE') {
        identifier(id);
        const table = kind === 'course' ? 'courses' : kind === 'module' ? 'modules' : 'catalog';
        const key = kind === 'video' ? 'video_id' : 'id';
        const row = (await client.query(`SELECT * FROM ${table} WHERE ${key}=$1 AND producer_id=$2 FOR ${lock}`, [id, producerId])).rows[0];
        if (!row) fail('CONTENT_NOT_FOUND', 'Contenido no encontrado.', 404);
        return row;
    }
    async function saveSettings(client, kind, id, producerId, patch = {}, playlistCode) {
        const params = [kind, id, producerId, JSON.stringify(patch), new Date().toISOString()];
        const playlistSql = playlistCode === undefined ? '' : ',playlist_code=EXCLUDED.playlist_code';
        params.push(playlistCode === undefined ? null : playlistCode);
        const result = await client.query(`INSERT INTO producer_content_settings(entity_kind,entity_id,producer_id,settings,updated_at,playlist_code)
            VALUES ($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(entity_kind,entity_id) DO UPDATE
            SET settings=producer_content_settings.settings || EXCLUDED.settings,updated_at=EXCLUDED.updated_at${playlistSql}
            WHERE producer_content_settings.producer_id=EXCLUDED.producer_id RETURNING settings,playlist_code`, params);
        if (!result.rows.length) fail('CONTENT_OWNER_CONFLICT', 'La configuración pertenece a otra cuenta.', 409);
        return result.rows[0];
    }
    async function metadata(client, kind, id, producerId) {
        return (await client.query('SELECT settings,playlist_code FROM producer_content_settings WHERE entity_kind=$1 AND entity_id=$2 AND producer_id=$3', [kind, id, producerId])).rows[0] || {};
    }
    async function assertCourse(client, row, producerId) {
        if (!row.course_id) {
            if (row.module_id) fail('CONTENT_OWNER_CONFLICT', 'El video tiene una ubicación inconsistente.', 409);
            return null;
        }
        return owned(client, 'course', row.course_id, producerId, 'SHARE');
    }
    async function lockVideoOperation(client, videoId) {
        const operation = (await client.query('SELECT id FROM stream_operations WHERE video_id=$1', [videoId])).rows[0];
        if (operation) {
            const locked = (await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', ['edulock-stream:upload:' + operation.id])).rows[0];
            if (locked?.locked !== true) fail('CONTENT_UPLOAD_BUSY', 'La subida de este video sigue en curso. Espera a que termine antes de modificarlo.', 409);
        }
    }
    async function projects(producerId) {
        identifier(producerId);
        const [courses, modules, videos, attachments] = await Promise.all([
            pool.query(`SELECT c.id,c.name,c.author,c.sort_order,c.created_at,s.settings FROM courses c LEFT JOIN producer_content_settings s
                ON s.entity_kind='course' AND s.entity_id=c.id AND s.producer_id=c.producer_id WHERE c.producer_id=$1 ORDER BY c.sort_order,c.created_at,c.id`, [producerId]),
            pool.query(`SELECT m.id,m.course_id,m.parent_id,m.name,m.sort_order,m.created_at,m.bunny_collection_id,m.documents,s.playlist_code FROM modules m JOIN courses c ON c.id=m.course_id AND c.producer_id=m.producer_id
                LEFT JOIN producer_content_settings s ON s.entity_kind='module' AND s.entity_id=m.id AND s.producer_id=m.producer_id
                WHERE m.producer_id=$1 ORDER BY m.sort_order,m.created_at,m.id`, [producerId]),
            pool.query(`SELECT v.video_id,v.course_id,v.module_id,v.title,v.status,v.source_type,v.sort_order,v.public_code,v.uploaded_at,v.documents,v.collection_sync_pending,s.settings FROM catalog v
                LEFT JOIN producer_content_settings s ON s.entity_kind='video' AND s.entity_id=v.video_id AND s.producer_id=v.producer_id
                WHERE v.producer_id=$1 AND (v.course_id IS NULL OR EXISTS(SELECT 1 FROM courses c WHERE c.id=v.course_id AND c.producer_id=v.producer_id))
                ORDER BY v.sort_order,v.uploaded_at,v.video_id`, [producerId]),
            // Distintivo real de adjuntos: recursos vigentes por clase o módulo de este productor.
            pool.query(`SELECT target_kind,target_id,COUNT(*) AS count FROM protected_resources WHERE producer_id=$1 AND deleted_at IS NULL GROUP BY target_kind,target_id`, [producerId]).catch(() => ({ rows: [] }))
        ]);
        const counts = new Map(attachments.rows.map(r => [r.target_kind + ':' + r.target_id, Number(r.count)]));
        const withCount = (row, kind, id) => ({ ...row, attachments: counts.get(kind + ':' + id) || 0 });
        const moduleRows = modules.rows.map(row => withCount(row, 'module', row.id)), videoRows = videos.rows.map(row => withCount(row, 'video', row.video_id));
        return { projects: courses.rows.map(row => ({ ...courseDto(row), modules: moduleRows.filter(m => m.course_id === row.id).map(moduleDto), videos: videoRows.filter(v => v.course_id === row.id).map(videoDto) })), unassignedVideos: videoRows.filter(v => !v.course_id).map(videoDto) };
    }
    async function updateCourse(producerId, id, input) {
        const patch = validatePatch('course', input);
        return transaction(producerId, async client => {
            const row = await owned(client, 'course', id, producerId);
            const result = (await client.query('UPDATE courses SET name=$3,author=$4,sort_order=$5 WHERE id=$1 AND producer_id=$2 RETURNING *', [id, producerId, patch.name ?? row.name, patch.author ?? row.author, patch.sortOrder ?? row.sort_order])).rows[0];
            const meta = patch.settings ? await saveSettings(client, 'course', id, producerId, patch.settings) : await metadata(client, 'course', id, producerId);
            return courseDto({ ...result, ...meta });
        });
    }
    async function updateModule(producerId, id, input) {
        const patch = validatePatch('module', input);
        return transaction(producerId, async client => {
            const row = await owned(client, 'module', id, producerId);
            await assertCourse(client, row, producerId);
            if (own(patch, 'parentId') && patch.parentId) {
                const parent = await owned(client, 'module', patch.parentId, producerId, 'SHARE');
                if (parent.course_id !== row.course_id) fail('CONTENT_MODULE_COURSE_MISMATCH', 'El módulo padre debe pertenecer al mismo curso.', 409);
                const tree = (await client.query(`WITH RECURSIVE subtree AS (SELECT id FROM modules WHERE id=$1 AND producer_id=$2
                    UNION SELECT m.id FROM modules m JOIN subtree s ON m.parent_id=s.id WHERE m.course_id=$3 AND m.producer_id=$2)
                    SELECT id FROM subtree`, [id, producerId, row.course_id])).rows;
                if (tree.some(m => m.id === patch.parentId)) fail('CONTENT_MODULE_CYCLE', 'Un módulo no puede quedar dentro de sí mismo o de un descendiente.', 409);
            }
            const result = (await client.query('UPDATE modules SET name=$3,parent_id=$4,sort_order=$5 WHERE id=$1 AND producer_id=$2 RETURNING *', [id, producerId, patch.name ?? row.name, own(patch, 'parentId') ? patch.parentId : row.parent_id, patch.sortOrder ?? row.sort_order])).rows[0];
            let meta = await metadata(client, 'module', id, producerId);
            if (own(patch, 'playlistPublished')) {
                if (patch.playlistPublished) {
                    // Publication authorizes safe cover links, never direct provider media.
                    const rows = (await client.query('SELECT video_id,public_code FROM catalog WHERE module_id=$1 AND course_id=$2 AND producer_id=$3', [id, row.course_id, producerId])).rows;
                    for (const video of rows) if (!video.public_code) {
                        if (typeof generatePublicCode !== 'function') fail('CONTENT_LINK_UNAVAILABLE', 'No se pueden generar enlaces en este momento.', 503);
                        const code = generatePublicCode(video.video_id);
                        if (typeof code !== 'string' || !/^[a-zA-Z0-9_-]{6,200}$/.test(code)) fail('CONTENT_LINK_UNAVAILABLE', 'No se pudo generar el enlace del video.', 503);
                        await client.query('UPDATE catalog SET public_code=$2 WHERE video_id=$1 AND producer_id=$3 AND public_code IS NULL', [video.video_id, code, producerId]);
                    }
                }
                meta = await saveSettings(client, 'module', id, producerId, {}, patch.playlistPublished ? meta.playlist_code || randomBytes(18).toString('base64url') : null);
            }
            return moduleDto({ ...result, ...meta });
        });
    }
    async function updateVideo(producerId, id, input) {
        const patch = validatePatch('video', input);
        return transaction(producerId, async client => {
            const row = await owned(client, 'video', id, producerId);
            await lockVideoOperation(client, id);
            const oldCourse = await assertCourse(client, row, producerId);
            const courseId = own(patch, 'courseId') ? patch.courseId : row.course_id || null;
            const course = courseId ? await owned(client, 'course', courseId, producerId, 'SHARE') : null;
            const moduleId = own(patch, 'moduleId') ? patch.moduleId : courseId === (row.course_id || null) ? row.module_id || null : null;
            if (moduleId) {
                const module = await owned(client, 'module', moduleId, producerId, 'SHARE');
                if (!courseId || module.course_id !== courseId) fail('CONTENT_MODULE_COURSE_MISMATCH', 'El módulo debe pertenecer al curso seleccionado.', 409);
            }
            if (courseId !== (row.course_id || null)) {
                if (row.source_type === 'bunny' && (!oldCourse?.bunny_library_id || !course?.bunny_library_id || String(oldCourse.bunny_library_id) !== String(course.bunny_library_id))) fail('CONTENT_LIBRARY_MISMATCH', 'Este video usa la biblioteca de su curso. Para cambiarlo a otro curso con distinta biblioteca, vuelve a subirlo allí.', 409);
                const resources = (await client.query("SELECT id,producer_id,course_id,protection FROM protected_resources WHERE target_kind='video' AND target_id=$1 AND deleted_at IS NULL FOR UPDATE", [id])).rows;
                for (const resource of resources) {
                    if (resource.producer_id !== producerId || (resource.course_id || null) !== (row.course_id || null)) fail('CONTENT_OWNER_CONFLICT', 'Hay recursos con una ubicación inconsistente.', 409);
                    if (!courseId && resource.protection === 'protected') fail('CONTENT_PROTECTED_COURSE_REQUIRED', 'Los PDF protegidos necesitan un curso. Muévelos junto al video a otro curso.', 409);
                }
                await client.query("UPDATE protected_resources SET course_id=$2,version=version+1,updated_at=$3 WHERE target_kind='video' AND target_id=$1 AND deleted_at IS NULL", [id, courseId, new Date().toISOString()]);
                await client.query('UPDATE edu_content SET course_id=$2 WHERE video_id=$1 AND producer_id=$3', [id, courseId, producerId]);
            }
            const moduleChanged = (moduleId || null) !== (row.module_id || null);
            // El traslado entre módulos se confirma en la base y deja la colección de Bunny marcada como pendiente
            // hasta sincronizarla fuera de la transacción (nunca se espera al proveedor con la transacción abierta).
            const pendingSync = moduleChanged && row.source_type === 'bunny' && !!courseId;
            const result = (await client.query('UPDATE catalog SET title=$3,course_id=$4,module_id=$5,sort_order=$6,collection_sync_pending=CASE WHEN $7::boolean THEN TRUE ELSE collection_sync_pending END WHERE video_id=$1 AND producer_id=$2 RETURNING *', [id, producerId, patch.title ?? row.title, courseId, moduleId, patch.sortOrder ?? row.sort_order, pendingSync])).rows[0];
            const meta = patch.presentation ? await saveSettings(client, 'video', id, producerId, patch.presentation) : await metadata(client, 'video', id, producerId);
            return { dto: videoDto({ ...result, ...meta }), pendingSync, courseId, moduleId };
        }).then(async ({ dto, pendingSync, courseId, moduleId }) => {
            if (!pendingSync) return dto;
            if (typeof syncCollection !== 'function') return { ...dto, collectionSyncPending: true, providerWarning: 'La colección del servicio de video se sincronizará automáticamente.' };
            try {
                await syncCollection({ producerId, videoId: id, courseId, moduleId });
                // Solo el movimiento más reciente puede cerrar la sincronización: si la clase volvió a
                // moverse mientras el proveedor respondía, queda pendiente y la reconciliación la coloca
                // en su módulo actual. No poder comprobarlo tampoco cierra la sincronización.
                const check = await confirmStillInModule(db, id, courseId, moduleId);
                if (typeof db.setCollectionSyncPending === 'function') await db.setCollectionSyncPending(id, !check.confirmed);
                if (check.confirmed) return { ...dto, collectionSyncPending: false, providerWarning: null };
                return { ...dto, collectionSyncPending: true, providerWarning: check.unknown
                    ? 'La colección se sincronizó, pero no se pudo confirmar el módulo actual de la clase; se revisará automáticamente.'
                    : 'La clase volvió a moverse mientras se sincronizaba; la colección se ajustará automáticamente.' };
            } catch (error) {
                return { ...dto, collectionSyncPending: true, providerWarning: 'La clase se movió en Edulock. La colección del servicio de video no se pudo actualizar ahora y se reintentará automáticamente' + (error?.message ? ': ' + String(error.message).slice(0, 160) : '.') };
            }
        });
    }
    async function remove(producerId, kind, id) {
        if (!['course', 'module', 'video'].includes(kind)) fail('CONTENT_INVALID_KIND', 'Tipo de contenido inválido.');
        return transaction(producerId, async client => {
            // Existing tables have no foreign keys. Serialize dependency writes
            // during a removal; no media, licenses or student grants cascade.
            await client.query('LOCK TABLE courses,modules,catalog,protected_resources,licenses,license_lots,student_courses,stream_operations,edu_content IN SHARE ROW EXCLUSIVE MODE');
            const row = await owned(client, kind, id, producerId);
            const dependencies = {};
            if (kind === 'course') {
                const count = (await client.query(`SELECT (SELECT COUNT(*) FROM modules WHERE course_id=$1) AS modules,
                    (SELECT COUNT(*) FROM catalog WHERE course_id=$1) AS videos,
                    (SELECT COUNT(*) FROM licenses WHERE course_id=$1) AS licenses,
                    (SELECT COUNT(*) FROM license_lots WHERE course_id=$1) AS lots,
                    (SELECT COUNT(*) FROM student_courses WHERE course_id=$1) AS students,
                    (SELECT COUNT(*) FROM protected_resources WHERE course_id=$1 AND deleted_at IS NULL) AS resources,
                    (SELECT COUNT(*) FROM stream_operations WHERE course_id=$1 AND state NOT IN ('ready','failed','deleted')) AS uploads,
                    (SELECT COUNT(*) FROM edu_content WHERE course_id=$1) AS protectedFiles`, [id])).rows[0];
                for (const [key, value] of Object.entries(count)) if (Number(value)) dependencies[key] = Number(value);
            } else {
                const kindTarget = kind === 'video' ? 'video' : 'module';
                const count = (await client.query('SELECT COUNT(*) AS count FROM protected_resources WHERE target_kind=$1 AND target_id=$2 AND deleted_at IS NULL', [kindTarget, id])).rows[0];
                if (Number(count.count)) dependencies.resources = Number(count.count);
                if (documentsPresent(row.documents)) dependencies.legacyResources = 1;
                if (kind === 'module') {
                    const count = (await client.query(`SELECT (SELECT COUNT(*) FROM modules WHERE parent_id=$1) AS modules,
                        (SELECT COUNT(*) FROM catalog WHERE module_id=$1) AS videos,
                        (SELECT COUNT(*) FROM stream_operations WHERE module_id=$1 AND state NOT IN ('ready','failed','deleted')) AS uploads`, [id])).rows[0];
                    for (const [key, value] of Object.entries(count)) if (Number(value)) dependencies[key] = Number(value);
                } else if (!['ready', 'error', 'failed'].includes(row.status)) dependencies.processing = 1;
            }
            if (Object.keys(dependencies).length) fail('CONTENT_HAS_DEPENDENCIES', 'Primero mueve o elimina los elementos asociados. Las licencias y accesos existentes se conservan.', 409, { dependencies });
            // El borrado en el servicio de video se decide AHORA, con las filas
            // todavia vivas, y se anota en la misma transaccion. Antes se decidia
            // despues del borrado local, cuando la fila que guardaba el
            // identificador remoto ya no existia: la coleccion y la biblioteca
            // nunca llegaban a borrarse (F02).
            const courseOfRow = kind === 'course' ? id : (row.course_id || null);
            let queuedDeletion = null, providerNote = null, queuedEdu = null;
            if (typeof describeProviderAsset === 'function' && courseOfRow) {
                try {
                    const descriptor = await describeProviderAsset({ kind, courseId: courseOfRow,
                        moduleId: kind === 'module' ? id : null,
                        videoId: kind === 'video' ? id : null,
                        actor: { producerId } });
                    if (descriptor?.deletable) {
                        queuedDeletion = randomUUID();
                        await db.enqueueProviderDeletion(client, {
                            id: queuedDeletion, kind, producerId,
                            courseId: courseOfRow,
                            moduleId: kind === 'module' ? id : null,
                            videoId: kind === 'video' ? id : null,
                            libraryId: descriptor.libraryId, libraryKey: descriptor.libraryKey,
                            remoteId: descriptor.remoteId });
                    } else providerNote = descriptor?.reason || null;
                } catch (error) {
                    // No se pudo averiguar que borrar: se deja constancia y el
                    // contenido local se borra igual. Nunca al reves.
                    providerNote = 'no se pudo consultar el servicio de video: ' + (error?.message || 'error desconocido');
                }
            }
            await client.query('DELETE FROM producer_content_settings WHERE entity_kind=$1 AND entity_id=$2 AND producer_id=$3', [kind, id, producerId]);
            if (kind === 'video') {
                await lockVideoOperation(client, id);
                await client.query("UPDATE stream_operations SET state='deleted',error_code='CONTENT_DELETED',updated_at=$2 WHERE video_id=$1", [id, new Date().toISOString()]);
                // El contenedor .edu esta en el almacenamiento, no en el servicio
                // de streaming: su borrado va aparte o el archivo cifrado se queda
                // en Bunny aunque la clase desaparezca del panel.
                const protegido = (await client.query(
                    'SELECT content_id, bunny_url FROM edu_content WHERE video_id=$1 AND producer_id=$2',
                    [id, producerId])).rows[0];
                if (protegido?.content_id && typeof db.rutaDeContenedorEdu === 'function') {
                    const enZona = db.rutaDeContenedorEdu(protegido.bunny_url, protegido.content_id);
                    if (enZona) {
                        queuedEdu = randomUUID();
                        await db.enqueueProviderDeletion(client, {
                            id: queuedEdu, kind: 'edu', producerId,
                            courseId: courseOfRow, moduleId: null, videoId: id,
                            libraryId: enZona.zona, libraryKey: null, remoteId: enZona.ruta });
                    }
                }
                await client.query('DELETE FROM edu_content WHERE video_id=$1 AND producer_id=$2', [id, producerId]);
                await client.query('DELETE FROM catalog WHERE video_id=$1 AND producer_id=$2', [id, producerId]);
                await client.query('INSERT INTO deleted_videos(video_id,deleted_at) VALUES($1,$2) ON CONFLICT(video_id) DO NOTHING', [id, new Date().toISOString()]);
            } else await client.query(`DELETE FROM ${kind === 'course' ? 'courses' : 'modules'} WHERE id=$1 AND producer_id=$2`, [id, producerId]);
            return { ok: true, id, courseId: courseOfRow, queuedDeletion: queuedDeletion || queuedEdu, queuedEdu, providerNote };
        }).then(async result => {
            // La cola ya esta escrita y confirmada. Aqui solo se intenta ejecutar
            // el borrado externo enseguida; si falla, el pendiente se queda en la
            // cola y lo reintenta el proceso periodico, tambien tras un reinicio.
            if (!result.queuedDeletion) {
                return { ok: true, id: result.id, courseId: result.courseId,
                    providerFilesDeleted: false, providerNote: result.providerNote || null };
            }
            if (typeof runProviderDeletions !== 'function') {
                return { ok: true, id: result.id, courseId: result.courseId, providerFilesDeleted: false,
                    providerNote: 'el borrado en el servicio de video quedo pendiente' };
            }
            try {
                await runProviderDeletions({ limit: 5 });
                const row = typeof db.getProviderDeletion === 'function' ? await db.getProviderDeletion(result.queuedDeletion) : null;
                const state = row?.state || 'pending';
                if (state === 'done') return { ok: true, id: result.id, courseId: result.courseId, providerFilesDeleted: true };
                if (state === 'gone') return { ok: true, id: result.id, courseId: result.courseId, providerFilesDeleted: false,
                    providerNote: 'ya no estaba en el servicio de video' };
                return { ok: true, id: result.id, courseId: result.courseId, providerFilesDeleted: false,
                    providerWarning: 'Se elimino de Edulock. El borrado en el servicio de video quedo pendiente y se reintentara solo.' };
            } catch (error) {
                return { ok: true, id: result.id, courseId: result.courseId, providerFilesDeleted: false,
                    providerWarning: 'Se elimino de Edulock. El borrado en el servicio de video quedo pendiente y se reintentara solo.' };
            }
        });
    }
    async function storage(producerId, { q = '', courseId = null, kind = null } = {}) {
        identifier(producerId);
        q = textValue(q, 200);
        if (courseId) identifier(courseId);
        if (kind && !['video', 'resource'].includes(kind)) fail('CONTENT_INVALID_KIND', 'Selecciona videos o recursos.');
        const [videos, resources] = await Promise.all([
            pool.query(`SELECT v.video_id,v.title,v.course_id,v.module_id,v.status,v.uploaded_at,o.file_size FROM catalog v
                LEFT JOIN stream_operations o ON o.video_id=v.video_id AND o.actor_key=$2
                WHERE v.producer_id=$1 ORDER BY v.uploaded_at DESC,v.video_id`, [producerId, 'producer:' + producerId]),
            pool.query(`SELECT r.id,r.name,r.type,r.protection,r.course_id,r.target_kind,r.target_id,r.byte_size,r.created_at FROM protected_resources r
                WHERE r.producer_id=$1 AND r.deleted_at IS NULL ORDER BY r.created_at DESC,r.id`, [producerId])
        ]);
        let items = [
            ...videos.rows.map(v => ({ id: v.video_id, kind: 'video', name: v.title, courseId: v.course_id || null, moduleId: v.module_id || null, status: v.status, protection: 'protected', byteSize: v.file_size == null ? null : Number(v.file_size), createdAt: v.uploaded_at })),
            ...resources.rows.map(r => ({ id: r.id, kind: 'resource', name: r.name, type: r.type, courseId: r.course_id || null, targetKind: r.target_kind, targetId: r.target_id, protection: r.protection, byteSize: r.byte_size == null ? null : Number(r.byte_size), status: 'ready', createdAt: r.created_at }))
        ];
        const knownBytes = items.reduce((sum, item) => sum + (item.byteSize || 0), 0);
        const unknownSizeCount = items.filter(item => item.byteSize === null).length;
        const total = items.length;
        const needle = q.toLocaleLowerCase('es');
        items = items.filter(item => (!kind || item.kind === kind) && (!courseId || item.courseId === courseId) && (!needle || [item.name, item.id].some(value => String(value || '').toLocaleLowerCase('es').includes(needle))));
        return { items, total, filteredTotal: items.length, knownBytes, unknownSizeCount, capacityBytes: null, freeBytes: null, trafficBytes: null, measurement: 'registered_original_files', providerUsageKnown: false };
    }
    async function reorder(producerId, input) {
        // Dos alcances: el curso completo (contrato original) o un contenedor (hermanos de un módulo padre
        // o clases de un módulo) cuando se envía parentId (módulos) / moduleId (videos), incluso null.
        inputObject(input, ['kind', 'courseId', 'ids', 'parentId', 'moduleId']);
        if (!['modules', 'videos'].includes(input.kind) || !Array.isArray(input.ids) || input.ids.length > 5000) fail('CONTENT_INVALID_ORDER', 'Indica módulos o videos y hasta 5000 identificadores.');
        const courseId = input.courseId == null ? null : identifier(input.courseId);
        if (input.kind === 'modules' && !courseId) fail('CONTENT_INVALID_ORDER', 'Selecciona el curso de los módulos.');
        const containerKey = input.kind === 'modules' ? 'parentId' : 'moduleId';
        if (own(input, input.kind === 'modules' ? 'moduleId' : 'parentId')) fail('CONTENT_INVALID_ORDER', 'El contenedor no corresponde al tipo de elementos.');
        const scoped = own(input, containerKey);
        const container = scoped ? (input[containerKey] == null || input[containerKey] === '' ? null : identifier(input[containerKey])) : undefined;
        if (scoped && container && !courseId) fail('CONTENT_INVALID_ORDER', 'Selecciona el curso del contenedor.');
        const ids = input.ids.map(identifier);
        if (new Set(ids).size !== ids.length) fail('CONTENT_INVALID_ORDER', 'La lista de orden no puede repetir elementos.');
        return transaction(producerId, async client => {
            if (courseId) await owned(client, 'course', courseId, producerId, 'SHARE');
            if (scoped && container) {
                const parent = await owned(client, 'module', container, producerId, 'SHARE');
                if (parent.course_id !== courseId) fail('CONTENT_MODULE_COURSE_MISMATCH', 'El contenedor debe pertenecer al curso seleccionado.', 409);
            }
            const table = input.kind === 'modules' ? 'modules' : 'catalog', key = input.kind === 'modules' ? 'id' : 'video_id', column = input.kind === 'modules' ? 'parent_id' : 'module_id';
            const rows = scoped
                ? (await client.query(`SELECT ${key} AS id FROM ${table} WHERE course_id IS NOT DISTINCT FROM $1 AND producer_id=$2 AND ${column} IS NOT DISTINCT FROM $3 FOR UPDATE`, [courseId, producerId, container])).rows
                : (await client.query(`SELECT ${key} AS id FROM ${table} WHERE course_id IS NOT DISTINCT FROM $1 AND producer_id=$2 FOR UPDATE`, [courseId, producerId])).rows;
            const actual = new Set(rows.map(row => row.id));
            if (actual.size !== ids.length || ids.some(id => !actual.has(id))) fail('CONTENT_ORDER_CHANGED', 'El contenido cambió. Actualiza la lista y vuelve a ordenar.', 409);
            for (let index = 0; index < ids.length; index++) await client.query(`UPDATE ${table} SET sort_order=$3 WHERE ${key}=$1 AND producer_id=$2`, [ids[index], producerId, (index + 1) * 10]);
            return { ok: true, kind: input.kind, courseId, ...(scoped ? { [containerKey]: container } : {}), count: ids.length };
        });
    }
    async function playlist(code) {
        if (typeof code !== 'string' || !/^[a-zA-Z0-9_-]{24}$/.test(code)) fail('CONTENT_NOT_FOUND', 'Lista no encontrada.', 404);
        const row = (await pool.query(`SELECT m.id,m.name,m.course_id,m.producer_id,c.name AS course_name,cs.settings AS course_settings FROM producer_content_settings s
            JOIN modules m ON s.entity_kind='module' AND s.entity_id=m.id AND s.producer_id=m.producer_id
            JOIN courses c ON c.id=m.course_id AND c.producer_id=m.producer_id
            LEFT JOIN producer_content_settings cs ON cs.entity_kind='course' AND cs.entity_id=c.id AND cs.producer_id=c.producer_id
            JOIN producers p ON p.id=m.producer_id AND p.active=1 WHERE s.playlist_code=$1`, [code])).rows[0];
        if (!row) fail('CONTENT_NOT_FOUND', 'Lista no encontrada.', 404);
        const videos = (await pool.query(`SELECT v.video_id,v.title,v.public_code,s.settings FROM catalog v LEFT JOIN producer_content_settings s
            ON s.entity_kind='video' AND s.entity_id=v.video_id AND s.producer_id=v.producer_id
            WHERE v.module_id=$1 AND v.course_id=$2 AND v.producer_id=$3 AND v.public_code IS NOT NULL AND v.status='ready' ORDER BY v.sort_order,v.uploaded_at,v.video_id`, [row.id, row.course_id, row.producer_id])).rows;
        return { name: row.name, courseName: row.course_name, embedOrigins: safeEmbedOrigins(asJson(row.course_settings).embedOrigins), videos: videos.map(v => ({ title: v.title, url: '/cover/' + encodeURIComponent(v.public_code), ...presentationDto(v.settings) })) };
    }
    return { projects, updateCourse, updateModule, updateVideo, remove, storage, playlist, reorder };
}

async function getPublicVideoPresentation(db, publicCode) {
    const row = (await db.pool.query(`SELECT s.settings,cs.settings AS course_settings FROM catalog v LEFT JOIN producer_content_settings s
        ON s.entity_kind='video' AND s.entity_id=v.video_id AND s.producer_id=v.producer_id
        LEFT JOIN producer_content_settings cs ON cs.entity_kind='course' AND cs.entity_id=v.course_id AND cs.producer_id=v.producer_id
        JOIN producers p ON p.id=v.producer_id AND p.active=1 WHERE v.public_code=$1`, [publicCode])).rows[0];
    return { ...presentationDto(row?.settings), embedOrigins: safeEmbedOrigins(asJson(row?.course_settings).embedOrigins) };
}

function contentError(res, error) {
    const known = typeof error.code === 'string' && error.code.startsWith('CONTENT_');
    const status = known && Number.isInteger(error.statusCode) ? error.statusCode : 503;
    return res.status(status).json({ error: known ? error.message : 'No se pudo completar la operación. Intenta de nuevo.', code: known ? error.code : 'CONTENT_UNAVAILABLE', ...(known && error.dependencies ? { dependencies: error.dependencies } : {}) });
}
function mountProducerContent(app, { db, requireProducer, generatePublicCode, service, syncCollection,
    deleteProviderAsset, describeProviderAsset, runProviderDeletions } = {}) {
    if (typeof requireProducer !== 'function') throw new TypeError('Producer authentication is required.');
    service = service || createProducerContent({ db, generatePublicCode, syncCollection, deleteProviderAsset,
        describeProviderAsset, runProviderDeletions });
    const wrap = fn => async (req, res) => {
        try {
            if (!req.producer?.id) fail('CONTENT_PRODUCER_UNAVAILABLE', 'Acceso de productor requerido.', 403);
            res.set?.('Cache-Control', 'no-store, private');
            await fn(req, res);
        } catch (error) { if (!res.headersSent) contentError(res, error); }
    };
    const prefix = '/api/producer/workspace';
    app.get(prefix + '/projects', requireProducer, wrap(async (req, res) => res.json(await service.projects(req.producer.id))));
    for (const [plural, singular, method] of [['courses', 'course', 'updateCourse'], ['modules', 'module', 'updateModule'], ['videos', 'video', 'updateVideo']]) {
        app.patch(prefix + '/' + plural + '/:id', requireProducer, wrap(async (req, res) => res.json({ [singular]: await service[method](req.producer.id, req.params.id, req.body || {}) })));
        app.delete(prefix + '/' + plural + '/:id', requireProducer, wrap(async (req, res) => res.json(await service.remove(req.producer.id, singular, req.params.id))));
    }
    app.get(prefix + '/storage', requireProducer, wrap(async (req, res) => res.json(await service.storage(req.producer.id, req.query || {}))));
    app.post(prefix + '/reorder', requireProducer, wrap(async (req, res) => res.json(await service.reorder(req.producer.id, req.body || {}))));
    app.get('/playlist/:code', async (req, res) => {
        try {
            const data = await service.playlist(req.params.code);
            const nonce = randomBytes(18).toString('base64');
            res.set('Cache-Control', 'no-store');
            const ancestors = ["'self'", ...safeEmbedOrigins(data.embedOrigins)].join(' ');
            res.set('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${nonce}'; img-src https:; base-uri 'none'; frame-ancestors ${ancestors}; form-action 'none'`);
            res.removeHeader?.('X-Frame-Options');
            const items = data.videos.map(video => `<li>${video.coverUrl ? `<img src="${escapeHtml(video.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<div><a href="${escapeHtml(video.url)}">${escapeHtml(video.title)}</a>${video.description ? `<p>${escapeHtml(video.description)}</p>` : ''}</div></li>`).join('');
            res.type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(data.name)} — Edulock</title><style nonce="${nonce}">body{margin:0;background:#ffffff;color:#141010;font:16px system-ui}main{max-width:840px;margin:0 auto;padding:48px 24px}.brand{font-size:13px;letter-spacing:.15em;color:#c41f28;font-weight:700}h1{font-size:32px;margin:8px 0}p{color:#6d635d;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}ul{list-style:none;padding:0}li{background:#f7f5f4;border:1px solid #e4dfdd;border-radius:14px;display:flex;gap:20px;padding:20px;margin:16px 0}li div{min-width:0}li img{width:144px;height:88px;object-fit:cover;border-radius:8px}a{color:#a1121b;font-weight:650;text-decoration:none;overflow-wrap:anywhere}a:hover{text-decoration:underline}@media(max-width:520px){li{display:block}li img{width:100%;height:auto;margin-bottom:16px}}footer{border-top:1px solid #e4dfdd;padding-top:24px;margin-top:32px}</style><main><div class="brand">EDULOCK SYSTEMS</div><p>${escapeHtml(data.courseName)}</p><h1>${escapeHtml(data.name)}</h1><p>Selecciona una clase. Su reproducción requiere el acceso correspondiente y el reproductor de Edulock.</p><ul>${items || '<li>Todavía no hay clases publicadas en esta lista.</li>'}</ul><footer><a href="/download">Obtener el reproductor</a></footer></main></html>`);
        } catch (error) { if (!res.headersSent) contentError(res, error); }
    });
    return service;
}

module.exports = { ensureSchema, createProducerContent, mountProducerContent, getPublicVideoPresentation, validatePatch, validateSettings, httpsUrl, embedOrigins, documentsPresent, legacyDocumentCount, courseDto, moduleDto, videoDto, contentError, DEFAULT_PRESENTATION, DEFAULT_SETTINGS, confirmStillInModule };
