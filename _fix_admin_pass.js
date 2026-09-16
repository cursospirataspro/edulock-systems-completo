'use strict';
// Actualiza el hash de contraseña del admin en data/users.json
// usando ADMIN_PASS del .env
require('dotenv').config();
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const USERS_PATH = path.resolve('./data/users.json');
const pass = process.env.ADMIN_PASS;
if (!pass) { console.error('ADMIN_PASS no definida en .env'); process.exit(1); }

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.pbkdf2Sync(pass, salt, 310000, 32, 'sha256').toString('hex');
const newHash = `${salt}:${hash}`;

const users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
users[0].passwordHash = newHash;
fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2), { mode: 0o600 });
console.log('✓ Password hash actualizado para:', users[0].username);
console.log('  Nueva contraseña:', pass);
