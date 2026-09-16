'use strict';

// Windows VMP signing must follow executable edits and Authenticode signing,
// and precede NSIS/portable packaging. Never ship after a failed EVS check.
const { execFileSync } = require('node:child_process');
const { verifyWindowsPackage } = require('./verify-windows-package');

module.exports = async ({ appOutDir, electronPlatformName }) => {
    if (electronPlatformName !== 'win32') return;
    console.log('[EVS] ' + JSON.stringify(await verifyWindowsPackage(appOutDir)));
    const executable = process.env.EVS_VMP_EXECUTABLE || 'evs-vmp';
    for (const command of ['sign-pkg', 'verify-pkg']) {
        execFileSync(executable, ['--no-ask', command, '--streaming', appOutDir], {
            stdio: 'inherit', windowsHide: true, timeout: 120000,
        });
    }
    console.log('[EVS] Firma VMP streaming verificada antes de generar los instaladores.');
};
