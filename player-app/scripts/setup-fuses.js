/**
 * afterPack hook — Electron Fuses
 * Deshabilita superficies de ataque del runtime de Electron:
 *   - RunAsNode: impide usar el binario como `node` standalone
 *   - EnableNodeOptionsEnvironmentVariable: impide NODE_OPTIONS=--require attacker.js
 *   - EnableNodeCliInspectArguments: impide --inspect / --inspect-brk para adjuntar depurador
 *   - EnableEmbeddedAsarIntegrityValidation: valida el ASAR contra su hash embebido
 *   - OnlyLoadAppFromAsar: carga código sólo desde el ASAR validado
 *   - EnableCookieEncryption: cifra cookies en disco con clave del SO
 */
const { FuseV1Options, FuseVersion, flipFuses } = require('@electron/fuses');
const path = require('path');

module.exports = async ({ appOutDir, packager }) => {
    const platform = packager.platform.name; // 'windows', 'mac', 'linux'
    let exePath;
    if (platform === 'windows') {
        exePath = path.join(appOutDir, packager.appInfo.productFilename + '.exe');
    } else if (platform === 'mac') {
        exePath = path.join(appOutDir, packager.appInfo.productFilename + '.app',
            'Contents', 'MacOS', packager.appInfo.productFilename);
    } else {
        // Linux: el binario usa el "name" del package.json (ej. "edulock-player")
        exePath = path.join(appOutDir, packager.appInfo.name);
    }

    console.log('[setup-fuses] Aplicando Electron Fuses a:', exePath);

    // EVS admits exactly this hardened fuse set on supported ECS releases.
    // https://github.com/castlabs/electron-releases/wiki/FAQ
    await flipFuses(exePath, {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]:                          false,
        [FuseV1Options.EnableCookieEncryption]:             true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]:      false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]:                true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]:   true,
    });

    console.log('[setup-fuses] Fuses aplicados correctamente.');
};
