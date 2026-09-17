'use strict';

const crypto = require('node:crypto');

const PREFIX = '/api/producer/workspace';
const error = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const id = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw error('INVALID_ID', 'Identificador inválido.');
  return value;
};
const textField = (value, max, field) => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value)) throw error('INVALID_FIELD', `${field} no es válido.`);
  return value.trim() || null;
};
const emailField = value => {
  const email = textField(value, 254, 'Correo');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw error('INVALID_EMAIL', 'Correo no válido.');
  return email?.toLowerCase() || null;
};
const integer = (value, min, max, code) => {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw error(code, 'El número indicado está fuera del intervalo permitido.');
  }
  return Number(value);
};
/** Kept for callers that still validate the historical column; course licenses no longer take a duration. */
function normalizeDurationDays(value) {
  return value === undefined || value === null || value === '' ? null : integer(value, 1, 3650, 'INVALID_DURATION');
}
function pagination(query = {}) {
  const page = integer(query.page ?? 1, 1, 1000000, 'INVALID_PAGINATION');
  const pageSize = integer(query.pageSize ?? 50, 1, 100, 'INVALID_PAGINATION');
  return { page, pageSize, offset: (page - 1) * pageSize };
}
/**
 * Course licenses are permanent: time never changes a license's status.
 * Suspension and revocation remain the only administrative states.
 */
function effectiveStatus(row) {
  return row.status;
}
/**
 * Availability as the panel shows it:
 *  available  – free key, not reserved, ready to hand out.
 *  reserved   – free key already tied to a buyer email (sale or reservation) but not yet activated.
 *  in_use     – claimed by a student account (stays in use even with zero live activations).
 *  suspended / revoked – not distributable; listed only under "Todas" or their own filter.
 */
function availabilityOf(row) {
  if (row.status === 'revoked') return 'revoked';
  if (row.status === 'suspended') return 'suspended';
  if (row.status === 'active' || row.student_id || row.assigned_at) return 'in_use';
  if (row.customer_email || row.reserved_email) return 'reserved';
  return 'available';
}
const AVAILABILITY_SQL = {
  available: `l.status='free' AND l.student_id IS NULL AND l.assigned_at IS NULL AND COALESCE(l.customer_email,'')='' AND COALESCE(l.reserved_email,'')=''`,
  reserved: `l.status='free' AND l.student_id IS NULL AND l.assigned_at IS NULL AND (COALESCE(l.customer_email,'')<>'' OR COALESCE(l.reserved_email,'')<>'')`,
  in_use: `(l.status='active' OR (l.status='free' AND (l.student_id IS NOT NULL OR l.assigned_at IS NOT NULL)))`,
  suspended: `l.status='suspended'`,
  revoked: `l.status='revoked'`,
};
const STATUS_ALIASES = { free: 'available', active: 'in_use', assigned: 'in_use' };

/** Serial encryption is purpose-separated from JWT signing. No development fallback secret. */
function createSerialVault(key, { jwtSecret = process.env.JWT_SECRET } = {}) {
  const material = key || process.env.LICENSE_VAULT_KEY || jwtSecret;
  let encryptionKey = null;
  if (Buffer.isBuffer(material) && material.length >= 32 || typeof material === 'string' && Buffer.byteLength(material) >= 32) {
    encryptionKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(material), Buffer.from('edulock'), Buffer.from('producer-license-vault-v1'), 32));
  }
  function ready() { if (!encryptionKey) throw error('SERIAL_VAULT_UNAVAILABLE', 'La custodia cifrada de seriales no está configurada.', 503); }
  const aad = (producerId, licenseId) => Buffer.from(JSON.stringify(['producer-license-vault-v1', id(producerId), id(licenseId)]));
  function encrypt(serial, producerId, licenseId) {
    ready();
    if (typeof serial !== 'string' || serial.length < 12 || serial.length > 128) throw error('INVALID_SERIAL', 'Serial inválido.');
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(aad(producerId, licenseId));
    const ciphertext = Buffer.concat([cipher.update(serial, 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
  }
  function decrypt(payload, producerId, licenseId) {
    ready();
    try {
      const parts = typeof payload === 'string' ? payload.split(':') : [];
      if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('format');
      const iv = Buffer.from(parts[1], 'base64url'), tag = Buffer.from(parts[2], 'base64url');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('format');
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
      decipher.setAAD(aad(producerId, licenseId)); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
    } catch { throw error('SERIAL_INTEGRITY_ERROR', 'No se pudo verificar el serial cifrado. No se exportó ninguna clave.', 409); }
  }
  return { available: !!encryptionKey, encrypt, decrypt, assertReady: ready };
}

async function ensureSchema(pool) {
  for (const statement of [
    `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS buyer_name TEXT`,
    `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS buyer_phone TEXT`,
    `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS duration_days INTEGER CHECK (duration_days BETWEEN 1 AND 3650)`,
    `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS first_activated_at TEXT`,
    `ALTER TABLE licenses ADD COLUMN IF NOT EXISTS suspension_previous_status TEXT`,
    `UPDATE licenses l SET first_activated_at=(SELECT MIN(a.created_at) FROM activations a WHERE a.license_id=l.id)
      WHERE l.first_activated_at IS NULL AND EXISTS(SELECT 1 FROM activations a WHERE a.license_id=l.id)`,
    `ALTER TABLE license_lots ADD COLUMN IF NOT EXISTS name TEXT`,
    `CREATE TABLE IF NOT EXISTS producer_license_serials (
       license_id TEXT PRIMARY KEY REFERENCES licenses(id) ON DELETE CASCADE,
       producer_id TEXT NOT NULL, ciphertext TEXT NOT NULL, suffix TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_producer_serial_owner ON producer_license_serials(producer_id)`,
    `CREATE TABLE IF NOT EXISTS producer_license_device_blocks (
       license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
       producer_id TEXT NOT NULL, device_id TEXT NOT NULL, created_at TEXT NOT NULL,
       PRIMARY KEY (license_id, device_id))`,
    `CREATE TABLE IF NOT EXISTS producer_customer_profiles (
       producer_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT, phone TEXT, notes TEXT, updated_at TEXT NOT NULL,
       PRIMARY KEY (producer_id, email))`,
    `CREATE TABLE IF NOT EXISTS producer_workspace_audit (
       id BIGSERIAL PRIMARY KEY, producer_id TEXT NOT NULL, action TEXT NOT NULL,
       target_id TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_producer_workspace_audit ON producer_workspace_audit(producer_id, created_at)`
  ]) await pool.query(statement);
}

/** Called inside the existing license generation transaction, after licenses are inserted. */
async function storePreparedSerials(client, { producerId, licenses, vault = createSerialVault() }) {
  vault.assertReady();
  for (const license of licenses) {
    const ciphertext = license.ciphertext || vault.encrypt(license.key, producerId, license.id);
    // Verify caller-provided ciphertext belongs to this exact tenant and license.
    const serial = vault.decrypt(ciphertext, producerId, license.id);
    const result = await client.query(`INSERT INTO producer_license_serials(license_id,producer_id,ciphertext,suffix,updated_at)
      SELECT id,producer_id,$3,$4,$5 FROM licenses WHERE id=$1 AND producer_id=$2
      ON CONFLICT(license_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,suffix=EXCLUDED.suffix,updated_at=EXCLUDED.updated_at
      WHERE producer_license_serials.producer_id=EXCLUDED.producer_id RETURNING license_id`,
    [license.id, producerId, ciphertext, serial.slice(-4), new Date().toISOString()]);
    if (!result.rows.length) throw error('LICENSE_NOT_FOUND', 'Licencia no encontrada.', 404);
  }
}

/**
 * Caller must hold the license row lock and commit together with a successful activation.
 * first_activated_at is recorded once as history; it never starts a validity period.
 */
async function activateLicensePolicy(client, license, { deviceId, now = new Date().toISOString() } = {}) {
  if (!license?.producer_id) return license;
  if (deviceId && (await client.query(`SELECT 1 FROM producer_license_device_blocks
    WHERE license_id=$1 AND producer_id=$2 AND device_id=$3`, [license.id, license.producer_id, deviceId])).rows.length) {
    throw error('device_blocked', 'El productor bloqueó este dispositivo para esta licencia.', 403);
  }
  if (!license.first_activated_at) {
    await client.query(`UPDATE licenses SET first_activated_at=$1 WHERE id=$2 AND producer_id=$3`, [now, license.id, license.producer_id]);
    license.first_activated_at = now;
  }
  return license;
}

function createProducerLicenseWorkspace({ pool, vaultKey, jwtSecret = process.env.JWT_SECRET, generateKey } = {}) {
  if (!pool?.query || !pool?.connect) throw new TypeError('PostgreSQL pool required');
  const vault = createSerialVault(vaultKey, { jwtSecret });
  const hashSerial = serial => {
    if (typeof jwtSecret !== 'string' || jwtSecret.length < 32) throw error('SERIAL_SIGNING_UNAVAILABLE', 'La firma de seriales no está configurada.', 503);
    return crypto.createHmac('sha256', jwtSecret).update(serial).digest('hex');
  };
  function newSerial() {
    if (generateKey) return generateKey();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const raw = Array.from({ length: 16 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
    const key = raw.match(/.{4}/g).join('-');
    return { key, hash: hashSerial(key) };
  }
  async function transaction(producerId, fn) {
    id(producerId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Consistent producer-before-license lock order prevents activation/generation races.
      const producer = (await client.query('SELECT * FROM producers WHERE id=$1 FOR UPDATE', [producerId])).rows[0];
      if (!producer || Number(producer.active) !== 1) throw error('PRODUCER_INACTIVE', 'El productor no está activo.', 403);
      const result = await fn(client, producer);
      await client.query('COMMIT'); return result;
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
    finally { client.release(); }
  }
  async function ownedLicense(client, producerId, licenseId) {
    const license = (await client.query('SELECT * FROM licenses WHERE id=$1 AND producer_id=$2 FOR UPDATE', [id(licenseId), producerId])).rows[0];
    if (!license) throw error('LICENSE_NOT_FOUND', 'Licencia no encontrada.', 404);
    return license;
  }
  const audit = (client, pid, action, targetId, details = {}) => client.query(`INSERT INTO producer_workspace_audit
    (producer_id,action,target_id,details,created_at) VALUES($1,$2,$3,$4,$5)`, [pid, action, targetId, JSON.stringify(details), new Date().toISOString()]);
  async function clearSessions(client, license, deviceId = null) {
    if (!license.student_id) return;
    // No producer action touches another producer's course or a global device block.
    await client.query(`DELETE FROM playback_sessions WHERE student_id=$1 AND course_id=$2
      AND ($3::text IS NULL OR device_id=$3)`, [license.student_id, license.course_id, deviceId]);
    await client.query(`DELETE FROM active_sessions WHERE user_id=$1 AND ($3::text IS NULL OR device_id=$3)
      AND video_id IN (SELECT video_id FROM catalog WHERE course_id=$2 AND producer_id=$4)`,
    [license.student_id, license.course_id, deviceId, license.producer_id]);
  }
  async function revokeActivations(client, license, deviceId = null) {
    await client.query(`UPDATE activations SET status='revoked',revoked_at=$1,revoked_by=$2
      WHERE license_id=$3 AND ($4::text IS NULL OR device_id=$4) AND status<>'revoked'`,
    [new Date().toISOString(), `producer:${license.producer_id}`, license.id, deviceId]);
    await clearSessions(client, license, deviceId);
  }
  function serialOf(row) {
    if (!vault.available || !row.ciphertext) return null;
    try { return vault.decrypt(row.ciphertext, row.producer_id, row.id); } catch { return null; }
  }
  function licenseView(row) {
    const serial = serialOf(row);
    return { id: row.id, lotId: row.lot_id, lotName: row.lot_name || '', courseId: row.course_id, courseName: row.course_name || '',
      status: row.status, effectiveStatus: effectiveStatus(row), availability: availabilityOf(row), maxDevices: Number(row.max_devices),
      customerEmail: row.customer_email || row.student_email || null, reservedEmail: row.reserved_email || null,
      studentId: row.student_id || null, studentName: row.student_name || '', studentEmail: row.student_email || null,
      serial, serialAvailable: !!serial, serialSuffix: row.serial_suffix || '',
      activationCount: Number(row.activation_count) || 0, activeActivations: Number(row.active_activations) || 0,
      createdAt: row.created_at, assignedAt: row.assigned_at, firstActivatedAt: row.first_activated_at || null,
      suspendedAt: row.suspended_at || null, revokedAt: row.revoked_at };
  }
  const LICENSE_SELECT = `SELECT l.id,l.lot_id,l.course_id,l.producer_id,l.status,l.max_devices,l.student_id,l.reserved_email,l.first_activated_at,
      l.customer_email,l.created_at,l.assigned_at,l.suspended_at,l.revoked_at,s.email AS student_email,s.name AS student_name,
      c.name AS course_name,lot.name AS lot_name,v.ciphertext,v.suffix AS serial_suffix,
      (SELECT COUNT(*) FROM activations a WHERE a.license_id=l.id) AS activation_count,
      (SELECT COUNT(*) FROM activations a WHERE a.license_id=l.id AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at>$2)) AS active_activations`;
  // The license row's producer_id is the ownership boundary. students.producer_id is
  // a legacy single-owner column and must not hide buyers of several producers.
  const LICENSE_JOINS = `FROM licenses l LEFT JOIN students s ON s.id=l.student_id`;
  const LICENSE_EXTRA_JOINS = `LEFT JOIN courses c ON c.id=l.course_id AND c.producer_id=l.producer_id
      LEFT JOIN license_lots lot ON lot.id=l.lot_id AND lot.producer_id=l.producer_id
      LEFT JOIN producer_license_serials v ON v.license_id=l.id AND v.producer_id=l.producer_id`;
  async function listLicenses(producerId, query = {}) {
    const pg = pagination(query), params = [id(producerId), new Date().toISOString()], clauses = ['l.producer_id=$1', '$2::text IS NOT NULL'];
    const append = (clause, value) => { params.push(value); clauses.push(clause.replace('?', `$${params.length}`)); };
    if (query.courseId) append('l.course_id=?', id(query.courseId));
    if (query.lotId) append('l.lot_id=?', id(query.lotId));
    if (query.status) {
      const status = STATUS_ALIASES[query.status] || query.status;
      if (!AVAILABILITY_SQL[status]) throw error('INVALID_STATUS', 'Estado inválido.');
      clauses.push(AVAILABILITY_SQL[status]);
    }
    if (query.q) {
      const search = textField(query.q, 254, 'Búsqueda');
      if (search) {
        const serialHash = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(search.toUpperCase()) ? hashSerial(search.toUpperCase()) : /^[a-fA-F0-9]{64}$/.test(search) ? search.toLowerCase() : '';
        params.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`, serialHash);
        const p = params.length - 1;
        clauses.push(`(l.id ILIKE $${p} OR l.customer_email ILIKE $${p} OR s.email ILIKE $${p} OR s.name ILIKE $${p}
          OR l.reserved_email ILIKE $${p} OR l.license_key_hash=$${p + 1})`);
      }
    }
    const where = clauses.join(' AND ');
    const counts = await countLicenses(producerId, query);
    const total = Number((await pool.query(`SELECT COUNT(*) AS n ${LICENSE_JOINS} WHERE ${where}`, params)).rows[0]?.n) || 0;
    const rows = (await pool.query(`${LICENSE_SELECT} ${LICENSE_JOINS} ${LICENSE_EXTRA_JOINS}
      WHERE ${where} ORDER BY l.created_at DESC,l.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pg.pageSize, pg.offset])).rows;
    return { licenses: rows.map(licenseView), total, page: pg.page, pageSize: pg.pageSize, counts };
  }
  /** Same availability definitions as the list, so tabs, filters and exports agree. */
  async function countLicenses(producerId, query = {}) {
    const params = [id(producerId)], clauses = ['l.producer_id=$1'];
    if (query.courseId) { params.push(id(query.courseId)); clauses.push(`l.course_id=$${params.length}`); }
    if (query.lotId) { params.push(id(query.lotId)); clauses.push(`l.lot_id=$${params.length}`); }
    const row = (await pool.query(`SELECT COUNT(*) AS total,
      ${Object.entries(AVAILABILITY_SQL).map(([key, sql]) => `COUNT(*) FILTER (WHERE ${sql}) AS ${key}`).join(',')}
      FROM licenses l WHERE ${clauses.join(' AND ')}`, params)).rows[0] || {};
    return { total: Number(row.total) || 0, available: Number(row.available) || 0, reserved: Number(row.reserved) || 0,
      inUse: Number(row.in_use) || 0, suspended: Number(row.suspended) || 0, revoked: Number(row.revoked) || 0 };
  }
  /**
   * The only editable field for a producer is the reservation email of a free key.
   * Device limits belong to the administrator; validity does not exist; buyer
   * contact data lives in the student account.
   */
  async function updateLicense(producerId, licenseId, fields = {}) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw error('INVALID_FIELDS', 'Datos inválidos.');
    if (Object.hasOwn(fields, 'maxDevices')) throw error('DEVICE_LIMIT_ADMIN_ONLY', 'Solo el administrador modifica el límite de dispositivos.', 403);
    if (Object.hasOwn(fields, 'expiresAt') || Object.hasOwn(fields, 'durationDays')) throw error('LICENSE_EXPIRY_UNSUPPORTED', 'Las licencias de curso no tienen vencimiento.');
    for (const key of Object.keys(fields)) if (key !== 'customerEmail') throw error('FIELD_NOT_EDITABLE', `El campo ${key} no se edita desde el panel del productor.`);
    if (!Object.hasOwn(fields, 'customerEmail')) throw error('EMPTY_UPDATE', 'No hay campos para actualizar.');
    const customerEmail = emailField(fields.customerEmail);
    return transaction(producerId, async client => {
      const license = await ownedLicense(client, producerId, licenseId);
      if (license.status === 'revoked') throw error('LICENSE_REVOKED', 'La revocación es definitiva.', 409);
      if (license.student_id || license.assigned_at) throw error('ASSIGNED_BUYER_IMMUTABLE', 'La cuenta que activó la licencia no se cambia editando los datos de contacto.', 409);
      const updated = (await client.query(`UPDATE licenses SET customer_email=$1 WHERE id=$2 AND producer_id=$3 RETURNING *`, [customerEmail, licenseId, producerId])).rows[0];
      await audit(client, producerId, 'license_updated', licenseId, { fields: ['customer_email'] });
      return { ok: true, license: licenseView(updated || { ...license, customer_email: customerEmail }) };
    });
  }
  async function setLicenseStatus(producerId, licenseId, status) {
    if (!['suspended', 'active', 'revoked'].includes(status)) throw error('INVALID_STATUS', 'Estado inválido.');
    return transaction(producerId, async client => {
      const license = await ownedLicense(client, producerId, licenseId);
      if (license.status === 'revoked') {
        if (status === 'revoked') return { ok: true, licenseId, status: 'revoked', unchanged: true };
        throw error('LICENSE_REVOKED', 'La revocación es definitiva.', 409);
      }
      const next = status === 'active' ? license.student_id || license.assigned_at ? 'active' : 'free' : status;
      if (license.status === next) return { ok: true, licenseId, status: next, unchanged: true };
      await client.query(`UPDATE licenses SET status=$1,suspended_at=$2,revoked_at=$3,revoked_by=$4,
        suspension_previous_status=$5 WHERE id=$6 AND producer_id=$7`,
      [next, next === 'suspended' ? new Date().toISOString() : null, next === 'revoked' ? new Date().toISOString() : null,
        next === 'revoked' ? `producer:${producerId}` : null, next === 'suspended' ? license.status : null, licenseId, producerId]);
      await revokeActivations(client, license);
      await audit(client, producerId, 'license_status', licenseId, { from: license.status, to: next });
      return { ok: true, licenseId, status: next, needsActivation: next === 'active' };
    });
  }
  async function listActivations(producerId, licenseId) {
    const found = (await pool.query('SELECT id FROM licenses WHERE id=$1 AND producer_id=$2', [id(licenseId), id(producerId)])).rows[0];
    if (!found) throw error('LICENSE_NOT_FOUND', 'Licencia no encontrada.', 404);
    const rows = (await pool.query(`SELECT a.id,a.device_id,a.status,a.created_at,a.last_used_at,a.expires_at,
      (b.device_id IS NOT NULL) AS blocked FROM activations a JOIN licenses l ON l.id=a.license_id
      LEFT JOIN producer_license_device_blocks b ON b.license_id=l.id AND b.device_id=a.device_id AND b.producer_id=l.producer_id
      WHERE a.license_id=$1 AND l.producer_id=$2 ORDER BY a.created_at DESC`, [licenseId, producerId])).rows;
    return { activations: rows.map(a => ({ id: a.id, deviceId: a.device_id, status: a.status, blocked: !!a.blocked,
      createdAt: a.created_at, lastUsedAt: a.last_used_at, expiresAt: a.expires_at })) };
  }
  async function activationAction(producerId, activationId, action) {
    if (!['reset', 'block', 'unblock'].includes(action)) throw error('INVALID_ACTION', 'Acción inválida.');
    return transaction(producerId, async client => {
      const initial = (await client.query(`SELECT a.id,a.license_id,l.student_id FROM activations a JOIN licenses l ON l.id=a.license_id
        WHERE a.id=$1 AND l.producer_id=$2`, [id(activationId), producerId])).rows[0];
      if (!initial) throw error('ACTIVATION_NOT_FOUND', 'Activación no encontrada.', 404);
      if (initial.student_id) {
        // The student may also buy from other producers; ownership is proven by the license, not by students.producer_id.
        const student = (await client.query('SELECT id FROM students WHERE id=$1 FOR UPDATE', [initial.student_id])).rows[0];
        if (!student) throw error('STUDENT_OWNER_CONFLICT', 'La cuenta del alumno ya no existe.', 409);
      }
      const license = await ownedLicense(client, producerId, initial.license_id);
      if (initial.student_id && license.student_id !== initial.student_id) throw error('LICENSE_CHANGED', 'La asignación cambió. Actualiza la lista y vuelve a intentarlo.', 409);
      const activation = (await client.query('SELECT id,device_id FROM activations WHERE id=$1 AND license_id=$2 FOR UPDATE', [activationId, license.id])).rows[0];
      if (!activation) throw error('ACTIVATION_NOT_FOUND', 'Activación no encontrada.', 404);
      if (action === 'block') await client.query(`INSERT INTO producer_license_device_blocks(license_id,producer_id,device_id,created_at)
        VALUES($1,$2,$3,$4) ON CONFLICT(license_id,device_id) DO NOTHING`, [license.id, producerId, activation.device_id, new Date().toISOString()]);
      if (action === 'unblock') await client.query(`DELETE FROM producer_license_device_blocks WHERE license_id=$1 AND producer_id=$2 AND device_id=$3`,
        [license.id, producerId, activation.device_id]);
      await revokeActivations(client, license, activation.device_id);
      if (initial.student_id && action !== 'unblock') {
        // Release a student's device slot only when no other license (of any
        // producer) still uses it. Administrator blocks and other courses remain intact.
        await client.query(`UPDATE devices d SET status='inactive' WHERE d.student_id=$1 AND d.fingerprint=$2 AND d.status='active'
          AND EXISTS(SELECT 1 FROM licenses l WHERE l.id=$3 AND l.producer_id=$4 AND l.student_id=d.student_id)
          AND NOT EXISTS(SELECT 1 FROM activations a WHERE a.student_id=d.student_id AND a.device_id=d.fingerprint AND a.status='active')`,
        [initial.student_id, activation.device_id, license.id, producerId]);
      }
      await audit(client, producerId, `activation_${action}`, activationId, { licenseId: license.id });
      return { ok: true, activationId, action, needsActivation: action !== 'block' };
    });
  }
  async function listLots(producerId, query = {}) {
    const courseId = query.courseId ? id(query.courseId) : null;
    const rows = (await pool.query(`SELECT lot.id,lot.name,lot.notes,lot.course_id,c.name AS course_name,lot.created_at,
      COUNT(l.id) AS total,
      COUNT(l.id) FILTER(WHERE ${AVAILABILITY_SQL.available}) AS available_count,
      COUNT(l.id) FILTER(WHERE ${AVAILABILITY_SQL.reserved}) AS reserved_count,
      COUNT(l.id) FILTER(WHERE ${AVAILABILITY_SQL.in_use}) AS in_use_count,
      COUNT(l.id) FILTER(WHERE l.status='suspended') AS suspended_count,
      COUNT(l.id) FILTER(WHERE l.status='revoked') AS revoked_count,
      COUNT(v.license_id) AS exportable_count FROM license_lots lot
      LEFT JOIN licenses l ON l.lot_id=lot.id AND l.producer_id=lot.producer_id
      LEFT JOIN courses c ON c.id=lot.course_id AND c.producer_id=lot.producer_id
      LEFT JOIN producer_license_serials v ON v.license_id=l.id AND v.producer_id=lot.producer_id
      WHERE lot.producer_id=$1 AND ($2::text IS NULL OR lot.course_id=$2)
      GROUP BY lot.id,c.name ORDER BY lot.created_at DESC,lot.id`, [id(producerId), courseId])).rows;
    return { lots: rows.map(lot => ({ id: lot.id, name: lot.name || '', notes: lot.notes || '', courseId: lot.course_id, courseName: lot.course_name || '',
      total: Number(lot.total), availableCount: Number(lot.available_count), freeCount: Number(lot.available_count), reservedCount: Number(lot.reserved_count),
      inUseCount: Number(lot.in_use_count), activeCount: Number(lot.in_use_count), suspendedCount: Number(lot.suspended_count),
      revokedCount: Number(lot.revoked_count), exportableCount: vault.available ? Number(lot.exportable_count) : 0, createdAt: lot.created_at })) };
  }
  async function updateLot(producerId, lotId, fields = {}) {
    const changes = {};
    if (Object.hasOwn(fields, 'name')) changes.name = textField(fields.name, 200, 'Nombre');
    if (Object.hasOwn(fields, 'notes')) changes.notes = textField(fields.notes, 4000, 'Notas');
    if (!Object.keys(changes).length) throw error('EMPTY_UPDATE', 'No hay campos para actualizar.');
    return transaction(producerId, async client => {
      const params = Object.values(changes);
      const result = await client.query(`UPDATE license_lots SET ${Object.keys(changes).map((key, i) => `${key}=$${i + 1}`).join(',')}
        WHERE id=$${params.length + 1} AND producer_id=$${params.length + 2} RETURNING id`, [...params, id(lotId), producerId]);
      if (!result.rows.length) throw error('LOT_NOT_FOUND', 'Lote no encontrado.', 404);
      await audit(client, producerId, 'lot_updated', lotId, { fields: Object.keys(changes) });
      return { ok: true, lotId, ...changes };
    });
  }
  async function moveLot(producerId, lotId, targetLotId) {
    id(lotId); id(targetLotId);
    if (lotId === targetLotId) throw error('SAME_LOT', 'Selecciona otro lote.');
    return transaction(producerId, async client => {
      const lots = (await client.query(`SELECT id,course_id FROM license_lots WHERE producer_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE`,
        [producerId, [lotId, targetLotId]])).rows;
      if (lots.length !== 2) throw error('LOT_NOT_FOUND', 'Lote no encontrado.', 404);
      if (!lots[0].course_id || lots[0].course_id !== lots[1].course_id) throw error('LOT_COURSE_MISMATCH', 'Sólo puedes mover licencias entre lotes del mismo curso.', 409);
      const inconsistent = (await client.query(`SELECT id FROM licenses WHERE lot_id=$1 AND
        (producer_id IS DISTINCT FROM $2 OR course_id IS DISTINCT FROM $3) LIMIT 1`, [lotId, producerId, lots[0].course_id])).rows;
      if (inconsistent.length) throw error('LOT_SCOPE_CONFLICT', 'El lote contiene una relación incompatible.', 409);
      const result = await client.query(`UPDATE licenses SET lot_id=$1 WHERE lot_id=$2 AND producer_id=$3 RETURNING id`, [targetLotId, lotId, producerId]);
      await client.query(`UPDATE license_lots lot SET quantity=(SELECT COUNT(*) FROM licenses l WHERE l.lot_id=lot.id AND l.producer_id=lot.producer_id)
        WHERE lot.producer_id=$1 AND lot.id=ANY($2::text[])`, [producerId, [lotId, targetLotId]]);
      await audit(client, producerId, 'lot_moved', lotId, { targetLotId, quantity: result.rows.length });
      return { ok: true, lotId, targetLotId, moved: result.rows.length };
    });
  }
  async function readLicenseSerial({ producerId, licenseId, client = pool }) {
    vault.assertReady();
    const row = (await client.query(`SELECT v.ciphertext FROM producer_license_serials v JOIN licenses l ON l.id=v.license_id AND l.producer_id=v.producer_id
      WHERE v.license_id=$1 AND v.producer_id=$2`, [id(licenseId), id(producerId)])).rows[0];
    if (!row) return null;
    return vault.decrypt(row.ciphertext, producerId, licenseId);
  }
  /** Plain serial of an owned license for copying or manual delivery. Free keys need no buyer; revoked keys are never handed out. */
  async function readLicensePlainSerial(producerId, licenseId) {
    const serial = await readLicenseSerial({ producerId, licenseId });
    if (!serial) throw error('LICENSE_SERIAL_UNAVAILABLE', 'Clave histórica no recuperable. Reemplázala para obtener una nueva.', 409);
    const row = (await pool.query(`SELECT l.status FROM licenses l WHERE l.id=$1 AND l.producer_id=$2`, [id(licenseId), id(producerId)])).rows[0];
    if (!row) throw error('LICENSE_NOT_FOUND', 'Licencia no encontrada.', 404);
    if (row.status === 'revoked') throw error('LICENSE_REVOKED', 'Esta licencia está revocada.', 409);
    return serial;
  }
  const csvCell = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""')}"`;
  function scopeClause(scope) {
    if (scope === undefined || scope === null || scope === '' || scope === 'all') return '';
    if (scope === 'available') return ` AND ${AVAILABILITY_SQL.available}`;
    throw error('INVALID_SCOPE', 'Alcance inválido.');
  }
  async function lotSerials(client, producerId, lotId, scope) {
    const lot = (await client.query('SELECT id FROM license_lots WHERE id=$1 AND producer_id=$2', [id(lotId), producerId])).rows[0];
    if (!lot) throw error('LOT_NOT_FOUND', 'Lote no encontrado.', 404);
    const rows = (await client.query(`SELECT l.id,l.status,l.student_id,l.assigned_at,l.reserved_email,l.customer_email,l.max_devices,v.ciphertext FROM licenses l
      LEFT JOIN producer_license_serials v ON v.license_id=l.id AND v.producer_id=l.producer_id
      WHERE l.lot_id=$1 AND l.producer_id=$2${scopeClause(scope)} ORDER BY l.created_at,l.id`, [lotId, producerId])).rows;
    const missing = rows.filter(row => !row.ciphertext).length;
    if (missing) throw error('HISTORICAL_SERIALS_UNAVAILABLE', `${missing} licencia(s) conservan sólo un hash y no se pueden recuperar. Reemplázalas explícitamente antes de entregar el lote completo.`, 409);
    return rows.map(row => ({ ...row, serial: vault.decrypt(row.ciphertext, producerId, row.id) }));
  }
  async function exportLot(producerId, lotId, { scope = 'all' } = {}) {
    vault.assertReady();
    return transaction(producerId, async client => {
      const rows = await lotSerials(client, producerId, lotId, scope);
      const lines = ['serial,licenseId,availability,status,customerEmail,maxDevices'];
      for (const row of rows) lines.push([row.serial, row.id, availabilityOf(row), row.status, row.customer_email, row.max_devices].map(csvCell).join(','));
      await audit(client, producerId, 'lot_exported', lotId, { quantity: rows.length, scope });
      return '﻿' + lines.join('\r\n') + '\r\n';
    });
  }
  /** Plain serials of a lot (optionally only the distributable ones) for the copy button. */
  async function listLotSerials(producerId, lotId, { scope = 'available' } = {}) {
    vault.assertReady();
    return transaction(producerId, async client => {
      const rows = await lotSerials(client, producerId, lotId, scope);
      await audit(client, producerId, 'lot_serials_copied', lotId, { quantity: rows.length, scope });
      return { lotId, scope, serials: rows.map(row => row.serial) };
    });
  }
  async function reissueLicense(producerId, licenseId, confirm) {
    if (confirm !== true) throw error('REISSUE_CONFIRMATION_REQUIRED', 'Confirma que la clave anterior dejará de funcionar.');
    vault.assertReady();
    return transaction(producerId, async client => {
      const license = await ownedLicense(client, producerId, licenseId);
      if (license.status === 'revoked') throw error('LICENSE_REVOKED', 'Una licencia revocada no puede reemitirse.', 409);
      const generated = newSerial();
      if (!generated.key || !generated.hash || generated.hash === license.license_key_hash) throw error('SERIAL_GENERATION_FAILED', 'No se pudo generar una nueva clave.', 503);
      await client.query('UPDATE licenses SET license_key_hash=$1 WHERE id=$2 AND producer_id=$3', [generated.hash, licenseId, producerId]);
      await storePreparedSerials(client, { producerId, licenses: [{ id: licenseId, key: generated.key }], vault });
      await revokeActivations(client, license);
      await audit(client, producerId, 'license_serial_rotated', licenseId, { previousHash: license.license_key_hash });
      return { ok: true, licenseId, key: generated.key, reissued: true, needsActivation: !!license.student_id };
    });
  }
  /**
   * Students of this producer: real accounts holding at least one of the producer's
   * licenses. One row per account, even with several licenses. Built from the
   * license→student relation, never from students.producer_id.
   */
  async function listStudents(producerId, query = {}) {
    const pg = pagination(query), search = query.q ? textField(query.q, 254, 'Búsqueda') : null;
    const courseId = query.courseId ? id(query.courseId) : null;
    const params = [id(producerId), search ? `%${search.replace(/[\\%_]/g, '\\$&')}%` : null, courseId, new Date().toISOString()];
    const base = `WITH owned AS (SELECT l.* FROM licenses l WHERE l.producer_id=$1 AND l.student_id IS NOT NULL),
      people AS (SELECT s.id,s.name,s.email,s.active,
        COUNT(o.id) AS license_count,
        COUNT(o.id) FILTER (WHERE o.status='active') AS active_licenses,
        COUNT(o.id) FILTER (WHERE o.status='suspended') AS suspended_licenses,
        COUNT(o.id) FILTER (WHERE o.status='revoked') AS revoked_licenses,
        (SELECT COUNT(*) FROM activations a JOIN owned x ON x.id=a.license_id WHERE x.student_id=s.id AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at>$4)) AS active_activations,
        (SELECT MAX(a.last_used_at) FROM activations a JOIN owned x ON x.id=a.license_id WHERE x.student_id=s.id) AS last_activity,
        MIN(o.assigned_at) AS first_assigned_at,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT c.name ORDER BY c.name),NULL) AS course_names
        FROM students s JOIN owned o ON o.student_id=s.id LEFT JOIN courses c ON c.id=o.course_id AND c.producer_id=$1
        WHERE ($2::text IS NULL OR s.email ILIKE $2 OR s.name ILIKE $2)
          AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM owned x WHERE x.student_id=s.id AND x.course_id=$3))
        GROUP BY s.id,s.name,s.email,s.active)
      SELECT * FROM people`;
    const total = Number((await pool.query(`SELECT COUNT(*) AS n FROM (${base}) filtered`, params)).rows[0]?.n) || 0;
    const rows = (await pool.query(`${base} ORDER BY last_activity DESC NULLS LAST,first_assigned_at DESC NULLS LAST,email LIMIT $5 OFFSET $6`, [...params, pg.pageSize, pg.offset])).rows;
    return { students: rows.map(row => ({ id: row.id, name: row.name || '', email: row.email, active: Number(row.active) === 1 || row.active === true,
      courses: Array.isArray(row.course_names) ? row.course_names : [], licenseCount: Number(row.license_count), activeLicenses: Number(row.active_licenses),
      suspendedLicenses: Number(row.suspended_licenses), revokedLicenses: Number(row.revoked_licenses), activeActivations: Number(row.active_activations),
      lastActivity: row.last_activity, firstAssignedAt: row.first_assigned_at })), total, page: pg.page, pageSize: pg.pageSize };
  }
  /** Student record limited to this producer's licenses, courses, devices and history. */
  async function getStudent(producerId, studentId) {
    const student = (await pool.query(`SELECT s.id,s.name,s.email,s.active,s.created_at,s.last_login,ps.linked_at,ps.linked_via
      FROM students s LEFT JOIN producer_students ps ON ps.student_id=s.id AND ps.producer_id=$1
      WHERE s.id=$2 AND EXISTS(SELECT 1 FROM licenses l WHERE l.producer_id=$1 AND l.student_id=s.id)`, [id(producerId), id(studentId)])).rows[0];
    if (!student) throw error('STUDENT_NOT_FOUND', 'Este alumno no tiene licencias de tu cuenta.', 404);
    const now = new Date().toISOString();
    const licenses = (await pool.query(`${LICENSE_SELECT} ${LICENSE_JOINS} ${LICENSE_EXTRA_JOINS}
      WHERE l.producer_id=$1 AND l.student_id=$3 ORDER BY l.created_at DESC,l.id DESC`, [producerId, now, studentId])).rows.map(licenseView);
    const activations = (await pool.query(`SELECT a.id,a.license_id,a.device_id,a.status,a.created_at,a.last_used_at,a.expires_at,
      (b.device_id IS NOT NULL) AS blocked FROM activations a JOIN licenses l ON l.id=a.license_id
      LEFT JOIN producer_license_device_blocks b ON b.license_id=l.id AND b.device_id=a.device_id AND b.producer_id=l.producer_id
      WHERE l.producer_id=$1 AND l.student_id=$2 ORDER BY a.created_at DESC`, [producerId, studentId])).rows;
    for (const license of licenses) {
      license.activations = activations.filter(a => a.license_id === license.id).map(a => ({ id: a.id, deviceId: a.device_id, status: a.status,
        blocked: !!a.blocked, createdAt: a.created_at, lastUsedAt: a.last_used_at, expiresAt: a.expires_at }));
    }
    return { student: { id: student.id, name: student.name || '', email: student.email, active: Number(student.active) === 1 || student.active === true,
      createdAt: student.created_at, lastLogin: student.last_login, linkedAt: student.linked_at, linkedVia: student.linked_via }, licenses };
  }
  function mount(app, requireProducer) {
    const route = (method, path, fn, csv = false) => app[method](PREFIX + path, requireProducer, async (req, res) => {
      try {
        if (!req.producer?.id || Number(req.producer.active) !== 1) throw error('PRODUCER_INACTIVE', 'El productor no está activo.', 403);
        const result = await fn(req, req.producer.id);
        res.set('Cache-Control', 'no-store');
        if (csv) { res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', `attachment; filename="licencias-${id(req.params.id)}.csv"`); return res.send(result); }
        return res.json(result);
      } catch (e) { return res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'No se pudo completar la operación.', code: e.code && e.statusCode ? e.code : 'WORKSPACE_ERROR' }); }
    });
    route('get', '/licenses', (req, pid) => listLicenses(pid, req.query));
    route('patch', '/licenses/:id', (req, pid) => updateLicense(pid, req.params.id, req.body));
    route('post', '/licenses/:id/status', (req, pid) => setLicenseStatus(pid, req.params.id, req.body?.status));
    route('post', '/licenses/:id/reissue', (req, pid) => reissueLicense(pid, req.params.id, req.body?.confirm));
    route('get', '/licenses/:id/activations', (req, pid) => listActivations(pid, req.params.id));
    for (const action of ['reset', 'block', 'unblock']) route('post', `/activations/:id/${action}`, (req, pid) => activationAction(pid, req.params.id, action));
    route('get', '/lots', (req, pid) => listLots(pid, req.query));
    route('patch', '/lots/:id', (req, pid) => updateLot(pid, req.params.id, req.body));
    route('post', '/lots/:id/move', (req, pid) => moveLot(pid, req.params.id, req.body?.targetLotId));
    route('get', '/lots/:id/export.csv', (req, pid) => exportLot(pid, req.params.id, { scope: req.query.scope || 'all' }), true);
    route('get', '/lots/:id/serials', (req, pid) => listLotSerials(pid, req.params.id, { scope: req.query.scope || 'available' }));
    route('get', '/licenses/:id/key', (req, pid) => readLicensePlainSerial(pid, req.params.id).then(key => ({ key })));
    route('get', '/students', (req, pid) => listStudents(pid, req.query));
    route('get', '/students/:id', (req, pid) => getStudent(pid, req.params.id));
  }
  return { mount, vault, listLicenses, countLicenses, updateLicense, setLicenseStatus, listActivations, activationAction,
    listLots, updateLot, moveLot, readLicenseSerial, readLicensePlainSerial, exportLot, listLotSerials, reissueLicense, listStudents, getStudent };
}

module.exports = { createProducerLicenseWorkspace, createSerialVault, ensureSchema, storePreparedSerials, activateLicensePolicy, normalizeDurationDays, effectiveStatus, availabilityOf };
