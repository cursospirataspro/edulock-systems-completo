'use strict';

// Authenticated sales traffic has a separate per-key budget from login attempts.
// This in-memory limiter is per Node worker; shared infrastructure can impose an
// additional global budget without coupling unrelated producers by source IP.
function createIntegrationRateLimit({ max = 120, windowMs = 60000, maxKeys = 10000, now = Date.now } = {}) {
    for (const [name, value, upper] of [['max', max, 1000000], ['windowMs', windowMs, 3600000], ['maxKeys', maxKeys, 1000000]]) {
        if (!Number.isSafeInteger(value) || value < 1 || value > upper) throw new TypeError('Invalid integration rate-limit option: ' + name);
    }
    if (typeof now !== 'function') throw new TypeError('Integration limiter requires a clock.');
    const buckets = new Map();
    let lastSweep = 0;
    return function integrationRateLimit(req, res, next) {
        const key = req.integration?.id;
        if (typeof key !== 'string' || !key || key.length > 200) return res.status(401).json({ error: 'Autentica la integración antes de emitir licencias.', code: 'INTEGRATION_AUTH_REQUIRED' });
        const current = now();
        if (current - lastSweep >= windowMs || buckets.size >= maxKeys) {
            for (const [id, item] of buckets) if (item.resetAt <= current) buckets.delete(id);
            lastSweep = current;
        }
        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= current) {
            if (!bucket && buckets.size >= maxKeys) {
                res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
                return res.status(503).json({ error: 'La integración está ocupada. Reintenta el mismo pedido en unos momentos.', code: 'INTEGRATION_BUSY' });
            }
            bucket = { count: 0, resetAt: current + windowMs }; buckets.set(key, bucket);
        }
        bucket.count++;
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
        if (bucket.count > max) {
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - current) / 1000))));
            return res.status(429).json({ error: 'La integración alcanzó su límite temporal. Reintenta el mismo pedido después del plazo indicado.', code: 'INTEGRATION_RATE_LIMITED' });
        }
        next();
    };
}

module.exports = { createIntegrationRateLimit };
