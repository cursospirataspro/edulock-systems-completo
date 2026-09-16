'use strict';
// Optional transactional delivery. Encrypted outbox; provider acceptance is not
// labelled delivery. No mail is sent until a verified sender and API key exist.
const crypto = require('node:crypto');
const { transaction } = require('./producer-business');
const error = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
async function ensureSchema(db) {
    await db.pool.query(`CREATE TABLE IF NOT EXISTS producer_mail_outbox (
        id TEXT PRIMARY KEY,producer_id TEXT NOT NULL,license_id TEXT NOT NULL,recipient TEXT NOT NULL,
        payload TEXT NOT NULL,serial_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,provider_id TEXT,error_code TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,next_attempt_at TEXT NOT NULL,
        UNIQUE(producer_id,license_id,serial_hash,recipient)
    )`);
}
function createProducerMail({ db, secret, getLicenseSerial, env = process.env, request = fetch }) {
    const encryptionKey = secret ? Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from('edulock-mail-outbox-v1'), 32)) : null;
    const configured = () => !!(encryptionKey && env.RESEND_API_KEY && env.MAIL_FROM && /^[^\r\n]+@[^\s\r\n]+/.test(env.MAIL_FROM));
    function seal(value, id) {
        const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
        cipher.setAAD(Buffer.from(id));
        return [iv.toString('base64'), Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64'), cipher.getAuthTag().toString('base64')].join('.');
    }
    function open(value, id) {
        const [iv, ciphertext, tag] = value.split('.').map(v => Buffer.from(v, 'base64'));
        const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
        cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString());
    }
    async function enqueue({ producerId, licenseId }) {
        if (!configured()) throw error('MAIL_NOT_CONFIGURED', 'El envío de correo aún no está configurado.', 503);
        return transaction(db.pool, async client => {
            const row = (await client.query(`SELECT l.*,s.email student_email,c.name course_name,p.active producer_active
                FROM licenses l JOIN producers p ON p.id=l.producer_id LEFT JOIN students s ON s.id=l.student_id
                LEFT JOIN courses c ON c.id=l.course_id WHERE l.id=$1 AND l.producer_id=$2 FOR UPDATE OF l`, [licenseId, producerId])).rows[0];
            if (!row || Number(row.producer_active) !== 1) throw error('NOT_FOUND', 'Licencia no disponible.', 404);
            if (row.status !== 'active' || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) throw error('LICENSE_NOT_ACTIVE', 'La licencia debe estar activa para enviarla.');
            const recipient = row.customer_email || row.student_email;
            if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw error('CUSTOMER_EMAIL_REQUIRED', 'El comprador necesita un correo válido.');
            const previous = (await client.query(`SELECT id,status,provider_id FROM producer_mail_outbox WHERE producer_id=$1 AND license_id=$2 AND serial_hash=$3 AND recipient=$4`, [producerId, licenseId, row.license_key_hash, recipient])).rows[0];
            if (previous) {
                if (!['queued', 'sending', 'accepted'].includes(previous.status)) {
                    throw error('MAIL_RETRY_REQUIRED', 'El intento anterior no se completó y necesita revisión en el registro de correos. No se ha programado otro envío.');
                }
                return { id: previous.id, status: previous.status, duplicate: true };
            }
            const serial = await getLicenseSerial({ producerId, licenseId, client });
            if (!serial) throw error('SERIAL_UNAVAILABLE', 'Este serial histórico no puede recuperarse. Reemítelo antes de enviarlo.');
            const id = crypto.randomUUID(), now = new Date().toISOString();
            const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
            const course = (row.course_name || 'tu curso').replace(/[\r\n]/g, ' ').slice(0, 120);
            const brand = String(env.PUBLIC_URL || 'https://edulocksystemsoficial.dpdns.org').replace(/\/+$/, '');
            const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7ded9;">
<tr><td style="background:#141010;padding:26px 24px;text-align:center;">
<img src="${brand}/logo.png" alt="Edulock Systems" width="64" height="64" style="display:inline-block;border:0;outline:none;">
<div style="color:#ffffff;font-size:18px;font-weight:bold;margin-top:10px;letter-spacing:0.3px;">Edulock <span style="color:#ff5560;">Systems</span></div></td></tr>
<tr><td style="padding:30px 30px 8px;">
<h1 style="margin:0 0 6px;font-size:20px;color:#141010;">Tu acceso está listo</h1>
<p style="margin:0 0 18px;font-size:14px;color:#6d635d;line-height:1.6;">Aquí tienes tu licencia para <strong style="color:#141010;">${esc(course)}</strong>. Es personal &mdash; no la compartas.</p>
<div style="border:2px solid #d81f2a;border-radius:10px;padding:16px;text-align:center;background:#fbecec;">
<div style="font-size:11px;color:#a1121b;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Tu licencia</div>
<div style="font-family:'Courier New',monospace;font-size:19px;font-weight:bold;color:#141010;word-break:break-all;">${esc(serial)}</div></div></td></tr>
<tr><td style="padding:18px 30px 6px;">
<p style="margin:0 0 8px;font-size:13px;color:#141010;font-weight:bold;">Cómo activarla:</p>
<p style="margin:0 0 4px;font-size:13px;color:#6d635d;line-height:1.7;">1. Abre <strong>Edulock Systems Player</strong> e inicia sesión con tu cuenta.</p>
<p style="margin:0 0 4px;font-size:13px;color:#6d635d;line-height:1.7;">2. Pega esta licencia cuando el reproductor la pida.</p>
<p style="margin:0;font-size:13px;color:#6d635d;line-height:1.7;">3. Tu formación queda habilitada en ese dispositivo.</p></td></tr>
<tr><td style="padding:22px 30px 28px;">
<div style="border-top:1px solid #e7ded9;padding-top:16px;font-size:11px;color:#94897f;line-height:1.6;">Este correo es automático. Si no reconoces esta compra, puedes ignorarlo.<br><strong style="color:#6d635d;">Edulock Systems</strong> &mdash; Protección de contenido.</div></td></tr>
</table></td></tr></table></body></html>`;
            const payload = { from: env.MAIL_FROM, to: [recipient], subject: 'Tu acceso a ' + course,
                text: `Tu licencia para ${course} es:\n\n${serial}\n\nConserva esta clave y actívala en Edulock Systems Player con tu cuenta. No la compartas.\n`,
                html };
            await client.query(`INSERT INTO producer_mail_outbox(id,producer_id,license_id,recipient,payload,serial_hash,created_at,updated_at,next_attempt_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$7)`, [id, producerId, licenseId, recipient, seal(payload, id), row.license_key_hash, now]);
            return { id, status: 'queued' };
        });
    }
    async function processOne() {
        if (!configured()) return null;
        // Claim with a transaction, then a fixed provider idempotency key. The
        // provider keeps keys for 24h; uncertain jobs are never retried past 20h.
        const row = await transaction(db.pool, async client => {
            const now = new Date().toISOString();
            const next = (await client.query(`SELECT * FROM producer_mail_outbox WHERE status IN ('queued','sending') AND next_attempt_at<=$1 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [now])).rows[0];
            if (!next) return null;
            const license = (await client.query(`SELECT l.status,l.expires_at,l.license_key_hash,p.active FROM licenses l JOIN producers p ON p.id=l.producer_id WHERE l.id=$1 AND l.producer_id=$2`, [next.license_id, next.producer_id])).rows[0];
            if (!license || Number(license.active) !== 1 || license.status !== 'active' || license.license_key_hash !== next.serial_hash || (license.expires_at && Date.parse(license.expires_at) <= Date.now())) {
                await client.query("UPDATE producer_mail_outbox SET status='cancelled',payload='',error_code='LICENSE_CHANGED',updated_at=$1 WHERE id=$2", [now, next.id]); return null;
            }
            if (Date.now() - Date.parse(next.created_at) >= 20 * 3600000 || next.attempts >= 5) {
                await client.query("UPDATE producer_mail_outbox SET status='manual_review',error_code='DELIVERY_UNCERTAIN',updated_at=$1 WHERE id=$2", [now, next.id]); return null;
            }
            await client.query("UPDATE producer_mail_outbox SET status='sending',attempts=attempts+1,next_attempt_at=$1,updated_at=$2 WHERE id=$3", [new Date(Date.now() + 60000).toISOString(), now, next.id]);
            return next;
        });
        if (!row) return null;
        let accepted = null, errorCode = 'PROVIDER_UNAVAILABLE', terminal = false;
        try {
            const payload = open(row.payload, row.id);
            const response = await request('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': 'edulock-license/' + row.id }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
            const body = await response.json();
            if (response.ok && typeof body.id === 'string') accepted = body.id;
            else { errorCode = 'PROVIDER_HTTP_' + response.status; terminal = response.status >= 400 && response.status < 500 && ![408,409,429].includes(response.status); }
        } catch (_) { /* No provider text, payload, serial or key enters logs. */ }
        await db.pool.query(`UPDATE producer_mail_outbox SET status=$1,provider_id=$2,error_code=$3,next_attempt_at=$4,updated_at=$5,payload=CASE WHEN $6 THEN '' ELSE payload END WHERE id=$7`,
            [accepted ? 'accepted' : terminal ? 'failed' : 'queued', accepted, accepted ? null : errorCode, new Date(Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts)).toISOString(), new Date().toISOString(), !!accepted, row.id]);
        return { id: row.id, status: accepted ? 'accepted' : terminal ? 'failed' : 'queued' };
    }
    function mount(app, requireProducer) {
        app.post('/api/producer/workspace/licenses/:id/email', requireProducer, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try { res.status(202).json(await enqueue({ producerId: req.producer.id, licenseId: req.params.id })); }
            catch (e) { res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'No se pudo preparar el correo.', code: e.code || 'MAIL_ERROR' }); }
        });
        app.get('/api/producer/workspace/deliveries', requireProducer, async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try { res.json({ configured: configured(), deliveries: (await db.pool.query(`SELECT id,license_id,recipient,status,attempts,error_code,created_at,updated_at FROM producer_mail_outbox WHERE producer_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.producer.id])).rows }); }
            catch (_) { res.status(500).json({ error: 'No se pudo consultar el registro de correos.' }); }
        });
    }
    return { configured, enqueue, processOne, mount, seal, open };
}
module.exports = { ensureSchema, createProducerMail };
