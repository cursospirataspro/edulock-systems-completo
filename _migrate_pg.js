'use strict';
/**
 * _migrate_pg.js — Crea el esquema PostgreSQL y ejecuta los seeds.
 *
 * Uso: node _migrate_pg.js
 *
 * Requiere DATABASE_URL en .env (o como variable de entorno).
 * Ejecutar UNA VEZ en producción antes del primer deploy, o cada vez
 * que se agreguen tablas nuevas (las queries son idempotentes).
 */

require('dotenv').config();
const db = require('./database-pg');

(async () => {
    try {
        console.log('[migrate] Conectando a PostgreSQL...');
        await db.initDb();
        console.log('[migrate] Migración completada exitosamente.');
        await db.pool.end();
    } catch (err) {
        console.error('[migrate] Error:', err.message);
        process.exit(1);
    }
})();
