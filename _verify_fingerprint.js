'use strict';
const crypto = require('crypto');
const { execSync } = require('child_process');

try {
    const regOut = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: 'utf8' });
    const match = regOut.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]+)/i);
    if (!match) { console.log('ERROR: No se encontro MachineGuid'); process.exit(1); }
    const guid = match[1];
    console.log('MachineGuid del equipo :', guid);

    const hash = crypto.createHash('sha256').update(guid.trim().toLowerCase()).digest('hex');
    const deviceId = 'dev_' + hash.slice(0, 16);
    console.log('Fingerprint nuevo      :', deviceId);
    console.log('');
    console.log('Fingerprints en Render (capturas anteriores):');
    console.log('  dev_a421e406dc83  (sesion 26/5 23:28)');
    console.log('  dev_c31a0bdd92f6  (sesion 26/5 21:50)');
    console.log('');
    const match1 = deviceId === 'dev_a421e406dc83';
    const match2 = deviceId === 'dev_c31a0bdd92f6';
    if (match1 || match2) {
        console.log('RESULTADO: Coincide con un registro existente en Render. El dispositivo quedara vinculado correctamente.');
    } else {
        console.log('RESULTADO: Es un fingerprint NUEVO. Al usar el app se creara un nuevo registro en Render.');
        console.log('           Esto es correcto: a partir de ahora sera siempre el mismo para este equipo.');
    }
} catch (e) {
    console.error('Error:', e.message);
}
