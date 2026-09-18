'use strict';
// Migración e interruptor de "Mis Cursos" contra PostgreSQL real.
// Solo se ejecuta contra una base QA desechable y borra únicamente las filas que crea.
const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
let databaseName = '';
try { databaseName = decodeURIComponent(new URL(process.env.DATABASE_URL || '').pathname.slice(1)); } catch {}
const allowed = /^edulock_qa(?:_[a-zA-Z0-9-]+)*$/;
if (!allowed.test(databaseName)) { console.error('REFUSED: embedded catalog tests require an explicitly named edulock_qa database.'); process.exit(1); }
const db = require('../database-pg');
const created = [];
const newProducer = () => { const id = randomUUID(); created.push(id); return id; };

before(async () => {
    const actual = (await db.pool.query('SELECT current_database() AS name')).rows[0].name;
    assert.match(actual, allowed, 'refusing to run outside a disposable QA database');
    await db.initDb();   // aplica la migración aditiva (ADD COLUMN IF NOT EXISTS)
});
after(async () => {
    if (created.length) await db.pool.query('DELETE FROM producers WHERE id = ANY($1)', [created]);
    await db.pool.end();
});

test('la migración es aditiva: la columna existe, es booleana y nace en false para todos', async () => {
    const column = (await db.pool.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name='producers' AND column_name='embedded_catalog_enabled'`)).rows[0];
    assert.ok(column, 'la columna embedded_catalog_enabled debe existir');
    assert.equal(column.data_type, 'boolean');
    assert.equal(column.is_nullable, 'NO');
    assert.match(String(column.column_default), /false/i);
    const id = newProducer();
    await db.createProducer({ id, email: `qa-mis-cursos-${id.slice(0, 8)}@edulock-qa.invalid`, passwordHash: 'x:y', name: 'QA Mis Cursos' });
    const row = await db.getProducerById(id);
    assert.equal(row.embedded_catalog_enabled, false, 'un productor nuevo conserva la experiencia actual');
    assert.equal(row.active, 1);
    const pending = (await db.pool.query('SELECT COUNT(*)::int AS n FROM producers WHERE embedded_catalog_enabled IS NULL')).rows[0].n;
    assert.equal(pending, 0, 'ningún productor queda sin valor');
});

test('caso 10: OFF → ON → OFF se persiste y nunca toca `active` ni las demás cuotas', async () => {
    const id = newProducer();
    await db.createProducer({ id, email: `qa-mis-cursos-${id.slice(0, 8)}@edulock-qa.invalid`, passwordHash: 'x:y', name: 'QA switch', maxLicenses: 7, maxDevices: 3 });
    const before = await db.getProducerById(id);
    const snapshot = p => ({ active: p.active, max_licenses: p.max_licenses, max_devices: p.max_devices, max_students: p.max_students, auth_version: p.auth_version, password_hash: p.password_hash });

    await db.updateProducer(id, { embedded_catalog_enabled: true });
    const on = await db.getProducerById(id);
    assert.equal(on.embedded_catalog_enabled, true);
    assert.deepEqual(snapshot(on), snapshot(before), 'encender el panel no cambia nada más, ni cierra la sesión del productor');

    await db.updateProducer(id, { embedded_catalog_enabled: false });
    const off = await db.getProducerById(id);
    assert.equal(off.embedded_catalog_enabled, false);
    assert.deepEqual(snapshot(off), snapshot(before));

    // Suspender y reactivar no altera el interruptor, y viceversa: son conceptos independientes.
    await db.updateProducer(id, { embedded_catalog_enabled: true });
    await db.updateProducer(id, { active: 0 });
    const suspended = await db.getProducerById(id);
    assert.equal(suspended.active, 0);
    assert.equal(suspended.embedded_catalog_enabled, true, 'el interruptor se conserva; quien decide el acceso es `active`');
    await db.updateProducer(id, { active: 1 });
    assert.equal((await db.getProducerById(id)).embedded_catalog_enabled, true);

    // Una actualización que no menciona el campo lo deja intacto (API opcional).
    await db.updateProducer(id, { name: 'QA switch renombrado' });
    const renamed = await db.getProducerById(id);
    assert.equal(renamed.embedded_catalog_enabled, true);
    assert.equal(renamed.name, 'QA switch renombrado');
});

test('el interruptor de un productor no alcanza a los demás', async () => {
    const a = newProducer(), b = newProducer();
    for (const id of [a, b]) await db.createProducer({ id, email: `qa-mis-cursos-${id.slice(0, 8)}@edulock-qa.invalid`, passwordHash: 'x:y', name: 'QA aislado' });
    await db.updateProducer(a, { embedded_catalog_enabled: true });
    assert.equal((await db.getProducerById(a)).embedded_catalog_enabled, true);
    assert.equal((await db.getProducerById(b)).embedded_catalog_enabled, false);
});
