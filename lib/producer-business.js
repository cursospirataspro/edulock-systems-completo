'use strict';
const crypto = require('node:crypto');
const fail = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const clean = (value, max, required = false) => {
    if (typeof value !== 'string' || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (required && !value.trim())) throw fail('INVALID_FIELD', 'Revisa los campos del formulario.');
    return value.trim();
};
function requestInput(body = {}) {
    if (!['licenses', 'storage', 'support'].includes(body.kind)) throw fail('INVALID_REQUEST', 'Selecciona el tipo de solicitud.');
    const quantity = body.kind === 'support' ? 0 : Number(body.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < (body.kind === 'support' ? 0 : 1) || quantity > 1000000) throw fail('INVALID_QUANTITY', 'La cantidad debe ser un entero entre 1 y 1.000.000.');
    return { kind: body.kind, quantity, message: clean(body.message || '', 2000, body.kind === 'support') };
}
function validPassword(value) {
    if (typeof value !== 'string' || value.length < 10 || value.length > 200 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) throw fail('PASSWORD_POLICY', 'Usa entre 10 y 200 caracteres, con letras y números.');
    return value;
}
async function ensureSchema(db) {
    await db.pool.query(`ALTER TABLE producers ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0`);
    await db.pool.query(`ALTER TABLE integration_keys ADD COLUMN IF NOT EXISTS producer_id TEXT`);
    await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_integration_producer ON integration_keys(producer_id)`);
    await db.pool.query(`CREATE TABLE IF NOT EXISTS producer_service_requests (
        id TEXT PRIMARY KEY, producer_id TEXT NOT NULL, kind TEXT NOT NULL,
        quantity INTEGER NOT NULL, message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        admin_reply TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        decided_by TEXT, license_limit_before INTEGER, license_limit_after INTEGER
    )`);
    await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_producer_requests ON producer_service_requests(producer_id,created_at)`);
}
async function transaction(pool, fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
}
function serviceRow(r) {
    return { id: r.id, producerId: r.producer_id, producerName: r.producer_name, producerEmail: r.producer_email,
        kind: r.kind, quantity: r.quantity, message: r.message, status: r.status, adminReply: r.admin_reply,
        createdAt: r.created_at, updatedAt: r.updated_at, licenseLimitAfter: r.license_limit_after };
}
function mountProducerBusiness(app, { db, requireProducer, requireAdmin, hashPassword, verifyPassword, issueProducerToken, secret, getPublicBase, mailConfigured = () => false }) {
    const prefix = '/api/producer/workspace';
    const q = (sql, params = []) => db.pool.query(sql, params);
    const route = (method, path, auth, fn) => app[method](path, auth, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try { await fn(req, res); }
        catch (e) { res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'No se pudo completar la operación. Inténtalo de nuevo.', code: e.code || 'WORKSPACE_ERROR' }); }
    });
    route('get', prefix + '/overview', requireProducer, async (req, res) => {
        const pid = req.producer.id;
        const row = (await q(`SELECT
          (SELECT COUNT(*)::int FROM courses WHERE producer_id=$1) projects,
          (SELECT COUNT(*)::int FROM catalog WHERE producer_id=$1) videos,
          (SELECT COUNT(*)::int FROM licenses WHERE producer_id=$1) licenses,
          (SELECT COUNT(*)::int FROM students WHERE producer_id=$1) customers,
          (SELECT COUNT(*)::int FROM activations a JOIN licenses l ON l.id=a.license_id WHERE l.producer_id=$1 AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at>$2)) active_activations,
          (SELECT COUNT(*)::int FROM producer_service_requests WHERE producer_id=$1 AND status='pending') open_requests`, [pid, new Date().toISOString()])).rows[0];
        res.json({ projects: row.projects, videos: row.videos, licenses: row.licenses, customers: row.customers, activeActivations: row.active_activations, openRequests: row.open_requests });
    });
    route('get', prefix + '/account', requireProducer, async (req, res) => {
        const p = req.producer;
        const usage = (await q(`SELECT (SELECT COUNT(*)::int FROM licenses WHERE producer_id=$1) licenses, (SELECT COUNT(*)::int FROM students WHERE producer_id=$1) students`, [p.id])).rows[0];
        res.json({ email: p.email, name: p.name || '', quotas: { maxLicenses: p.max_licenses, maxDevices: p.max_devices, maxStudents: p.max_students },
            usage: { licensesUsed: usage.licenses, studentsUsed: usage.students }, mail: { configured: mailConfigured(), provider: 'Resend' },
            features: { automaticBilling: false, globalBlacklist: false } });
    });
    route('patch', prefix + '/account', requireProducer, async (req, res) => {
        const name = clean(req.body.name, 120, true);
        await q('UPDATE producers SET name=$1 WHERE id=$2', [name, req.producer.id]); res.json({ ok: true, name });
    });
    route('post', prefix + '/account/password', requireProducer, async (req, res) => {
        const password = validPassword(req.body.newPassword);
        const p = await transaction(db.pool, async client => {
            const current = (await client.query('SELECT * FROM producers WHERE id=$1 FOR UPDATE', [req.producer.id])).rows[0];
            if (!current || Number(current.active) !== 1 || !verifyPassword(String(req.body.currentPassword || ''), current.password_hash)) throw fail('CURRENT_PASSWORD_INVALID', 'La contraseña actual no es correcta.', 403);
            return (await client.query('UPDATE producers SET password_hash=$1,auth_version=auth_version+1 WHERE id=$2 RETURNING *', [hashPassword(password), current.id])).rows[0];
        });
        res.json({ ok: true, token: issueProducerToken(p) });
    });
    route('get', prefix + '/integrations', requireProducer, async (req, res) => {
        const keys = (await q('SELECT id,name,scopes,active,created_at,last_used FROM integration_keys WHERE producer_id=$1 ORDER BY created_at DESC', [req.producer.id])).rows;
        res.json({ keys: keys.map(k => ({ id: k.id, name: k.name, scopes: k.scopes, active: !!k.active, createdAt: k.created_at, lastUsed: k.last_used })),
            claimUrl: getPublicBase(req) + '/api/integrations/claim-license', mailConfigured: mailConfigured() });
    });
    route('post', prefix + '/integrations', requireProducer, async (req, res) => {
        if (!secret) throw fail('INTEGRATIONS_UNAVAILABLE', 'Integraciones no disponibles.', 503);
        const name = clean(req.body.name, 80, true), id = crypto.randomUUID(), apiKey = 'edp_' + crypto.randomBytes(32).toString('base64url');
        await transaction(db.pool, async client => {
            await client.query('SELECT id FROM producers WHERE id=$1 FOR UPDATE', [req.producer.id]);
            const count = Number((await client.query('SELECT COUNT(*) n FROM integration_keys WHERE producer_id=$1 AND active=1', [req.producer.id])).rows[0].n);
            if (count >= 20) throw fail('KEY_LIMIT', 'Revoca una clave antes de crear otra (máximo 20 activas).', 409);
            await client.query(`INSERT INTO integration_keys(id,name,key_hash,scopes,active,created_at,producer_id) VALUES($1,$2,$3,'claim-license',1,$4,$5)`,
                [id, name, crypto.createHmac('sha256', secret).update(apiKey).digest('hex'), new Date().toISOString(), req.producer.id]);
        });
        res.status(201).json({ id, name, apiKey });
    });
    route('delete', prefix + '/integrations/:id', requireProducer, async (req, res) => {
        const result = await q('UPDATE integration_keys SET active=0 WHERE id=$1 AND producer_id=$2 RETURNING id', [req.params.id, req.producer.id]);
        if (!result.rows.length) throw fail('NOT_FOUND', 'Clave no encontrada.', 404); res.json({ ok: true });
    });
    route('get', prefix + '/service-requests', requireProducer, async (req, res) => res.json({ requests: (await q('SELECT * FROM producer_service_requests WHERE producer_id=$1 ORDER BY created_at DESC LIMIT 200', [req.producer.id])).rows.map(serviceRow) }));
    route('post', prefix + '/service-requests', requireProducer, async (req, res) => {
        const input = requestInput(req.body), now = new Date().toISOString();
        const request = await transaction(db.pool, async client => {
            await client.query('SELECT id FROM producers WHERE id=$1 FOR UPDATE', [req.producer.id]);
            const pending = Number((await client.query("SELECT COUNT(*) n FROM producer_service_requests WHERE producer_id=$1 AND status='pending'", [req.producer.id])).rows[0].n);
            if (pending >= 10) throw fail('REQUEST_LIMIT', 'Ya tienes diez solicitudes pendientes. Espera la respuesta del administrador.', 409);
            return (await client.query(`INSERT INTO producer_service_requests(id,producer_id,kind,quantity,message,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`, [crypto.randomUUID(), req.producer.id, input.kind, input.quantity, input.message, now])).rows[0];
        });
        res.status(201).json({ request: serviceRow(request) });
    });
    route('get', '/api/owner/service-requests', requireAdmin, async (_req, res) => res.json({ requests: (await q(`SELECT r.*,p.name producer_name,p.email producer_email FROM producer_service_requests r LEFT JOIN producers p ON p.id=r.producer_id ORDER BY r.created_at DESC LIMIT 500`)).rows.map(serviceRow) }));
    route('patch', '/api/owner/service-requests/:id', requireAdmin, async (req, res) => {
        if (!['approved', 'rejected'].includes(req.body.status)) throw fail('INVALID_STATUS', 'Selecciona aprobar o rechazar.');
        const reply = clean(req.body.adminReply || '', 2000);
        const request = await transaction(db.pool, async client => {
            const item = (await client.query('SELECT * FROM producer_service_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
            if (!item) throw fail('NOT_FOUND', 'Solicitud no encontrada.', 404);
            if (item.status !== 'pending') throw fail('REQUEST_DECIDED', 'Esta solicitud ya tiene una respuesta.', 409);
            const p = (await client.query('SELECT * FROM producers WHERE id=$1 FOR UPDATE', [item.producer_id])).rows[0];
            if (!p) throw fail('NOT_FOUND', 'Productor no encontrado.', 404);
            let after = p.max_licenses;
            if (req.body.status === 'approved' && item.kind === 'licenses') {
                if (Number(p.max_licenses) === 0) throw fail('UNLIMITED_QUOTA', 'Este productor ya tiene licencias sin límite.', 409);
                after = Number(p.max_licenses) + item.quantity;
                if (!Number.isSafeInteger(after) || after > 2147483647) throw fail('QUOTA_OVERFLOW', 'La cuota resultante supera el límite.');
                await client.query('UPDATE producers SET max_licenses=$1 WHERE id=$2', [after, p.id]);
            }
            if (req.body.status === 'approved' && item.kind === 'storage') throw fail('STORAGE_MANUAL', 'La ampliación de almacenamiento requiere contratar/configurar capacidad real. Responde al productor sin registrar una ampliación ficticia.', 409);
            return (await client.query(`UPDATE producer_service_requests SET status=$1,admin_reply=$2,updated_at=$3,decided_by=$4,license_limit_before=$5,license_limit_after=$6 WHERE id=$7 RETURNING *`, [req.body.status, reply, new Date().toISOString(), req.user?.sub || 'admin', p.max_licenses, after, item.id])).rows[0];
        });
        res.json({ request: serviceRow(request) });
    });
    route('get', prefix + '/security-events', requireProducer, async (req, res) => {
        const rows = (await q(`SELECT a.id,a.type,a.severity,a.description,a.created_at,a.reviewed,a.device_id,s.email
            FROM suspicious_activity a JOIN students s ON s.id=a.student_id
            WHERE s.producer_id=$1 ORDER BY a.created_at DESC LIMIT 200`, [req.producer.id])).rows;
        res.json({ events: rows.map(r => ({ id: r.id, type: r.type, severity: r.severity, description: r.description,
            createdAt: r.created_at, reviewed: !!r.reviewed, customerEmail: r.email, deviceId: r.device_id })), externalBlacklist: false });
    });
}
module.exports = { ensureSchema, mountProducerBusiness, requestInput, validPassword, transaction, serviceRow };
