'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// El Electron userData path en Windows es %APPDATA%\<app-name>
// El app-name viene de package.json "name": "campus-digital-player"
const appName = 'campus-digital-player';
const configPath = path.join(os.homedir(), 'AppData', 'Roaming', appName, 'config.json');

console.log('Config path:', configPath);
console.log('Exists:', fs.existsSync(configPath));

if (fs.existsSync(configPath)) {
    const current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    console.log('Current config:', JSON.stringify(current, null, 2));

    // Forzar API_BASE a localhost:3000
    current.API_BASE = 'http://localhost:3000';
    fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf-8');
    console.log('\n✔ Config actualizado a http://localhost:3000');
    console.log('New config:', JSON.stringify(current, null, 2));
} else {
    // Crear con valores correctos
    const cfg = { API_BASE: 'http://localhost:3000' };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
    console.log('✔ Config creado:', JSON.stringify(cfg, null, 2));
}
