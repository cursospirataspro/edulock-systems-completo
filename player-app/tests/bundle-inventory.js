'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const asar = require('@electron/asar');
const archive = path.join(__dirname, '../dist/win-unpacked/resources/app.asar');
const files = new Set(asar.listPackage(archive).map(name => name.replace(/\\/g, '/')));
const required = ['/main.js', '/preload.js', '/activation-store.js', '/edu-native.js',
    '/security-policy.js', '/platform-probes.js', '/renderer/player.js', '/renderer/auth.html',
    '/renderer/index.html', '/renderer/courses-drawer.js', '/node_modules/hls.js/dist/hls.min.js'];
for (const name of required) assert.ok(files.has(name), 'Missing packaged file: ' + name);
process.stdout.write(JSON.stringify({ archive, requiredPresent: required, fileCount: files.size }, null, 2));
