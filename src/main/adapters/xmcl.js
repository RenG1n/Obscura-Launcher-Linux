'use strict';
// Thin adapters over the maintained @xmcl libraries (Voxelum). They do the
// actual downloads/verification (installer) and build the launch command line
// from Mojang's own version JSON (core) - nothing is hard-coded here.
// Libraries are required lazily so unit tests and `doctor` can report a
// missing/changed API instead of crashing at startup.

/** Export names this file depends on. scripts/doctor.js checks them against the installed versions. */
const REQUIRED_EXPORTS = {
  '@xmcl/installer': ['install'],
  '@xmcl/core': ['launch']
};

function createInstaller() {
  return {
    /**
     * @param {{id:string,url:string,type?:string,sha1?:string}} meta entry from Mojang's manifest
     * @param {string} gameDir
     * @param {{signal?: AbortSignal, onProgress?: (p:{percent:number|null}) => void}} opts
     */
    async install(meta, gameDir, { signal, onProgress } = {}) {
      const lib = require('@xmcl/installer');
      if (typeof lib.installTask === 'function') {
        const task = lib.installTask(meta, gameDir);
        const onAbort = () => { try { task.cancel(); } catch { /* already finished */ } };
        if (signal) {
          if (signal.aborted) onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        }
        let last = 0;
        const report = () => {
          const now = Date.now();
          if (now - last < 150) return;
          last = now;
          const total = Number(task.total);
          const progress = Number(task.progress);
          const percent = total > 0 && Number.isFinite(progress) ? Math.min(100, Math.round((progress / total) * 100)) : null;
          if (onProgress) onProgress({ percent });
        };
        try {
          await task.startAndWait({ onUpdate: report, onStart: report });
        } finally {
          if (signal) signal.removeEventListener('abort', onAbort);
        }
        return;
      }
      // Fallback for API variants without task support: no progress, no cancel.
      if (typeof lib.install !== 'function') throw new Error('@xmcl/installer: функция install не найдена.');
      await lib.install(meta, gameDir);
    }
  };
}

function createLauncher({ launcherName = 'Obscura', launcherVersion = '0.2.0' } = {}) {
  return {
    async launch({ gameDir, gamePath, resourcePath, version, javaPath, maxMemoryMb, minMemoryMb, session }) {
      const { launch } = require('@xmcl/core');
      if (typeof launch !== 'function') throw new Error('@xmcl/core: функция launch не найдена.');
      return launch({
        // gamePath: where this run writes saves/screenshots and reads mods/config/options.txt
        // (per-build folder when launching a build, else the shared gameDir).
        // resourcePath: where versions/libraries/assets live — always the shared gameDir,
        // so builds don't re-download the same game files.
        gamePath: gamePath || gameDir,
        resourcePath: resourcePath || gameDir,
        javaPath,
        version,
        gameProfile: { id: session.uuid, name: session.name },
        accessToken: session.accessToken,
        userType: session.userType || 'msa',
        launcherName,
        launcherBrand: launcherName,
        maxMemory: maxMemoryMb,
        minMemory: minMemoryMb,
        extraExecOption: { windowsHide: false }
      });
    }
  };
}

module.exports = { createInstaller, createLauncher, REQUIRED_EXPORTS };
