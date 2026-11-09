'use strict';
// Визуальный мод: a fixed profile (Minecraft 1.21.11 + Fabric) with its own folder
// (mods/saves/config/resourcepacks/shaderpacks/screenshots), exactly like a build, but
// without a version or loader choice. versions/libraries/assets stay shared in gameDir.
//
// The mod's .jar ships with the launcher (visual-mod/ next to the app, or
// resources/visual-mod/ in an installed copy). Before every launch it is copied into
// <visual folder>/mods. Files the launcher copied are tracked, so replacing the jar in a
// new launcher version removes the old one; any other jar the player put there is left alone.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { VISUAL_PROFILE } = require('./settings');

const SUBDIRS = ['mods', 'saves', 'config', 'resourcepacks', 'shaderpacks', 'screenshots'];
const STATE_FILE = '.obscura-visual.json';
const FABRIC_API_SLUG = 'fabric-api';

class VisualError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'VisualError';
    this.code = code;
  }
}

function sha1File(file, fsImpl) {
  return crypto.createHash('sha1').update(fsImpl.readFileSync(file)).digest('hex');
}

/**
 * @param {{ root: string, bundledDir?: string|null, fsImpl?: typeof fs, logger?: any,
 *           installFabricApi?: (o:{signal?:AbortSignal}) => Promise<any> }} opts
 */
function createVisualService({ root, bundledDir = null, fsImpl = fs, logger = null, installFabricApi: initialInstaller = null } = {}) {
  let installFabricApi = initialInstaller;
  const modsDir = path.join(root, 'mods');
  const statePath = path.join(root, STATE_FILE);
  const log = (level, msg) => { if (logger && logger[level]) logger[level](msg); };

  function ensureFolders() {
    for (const sub of SUBDIRS) fsImpl.mkdirSync(path.join(root, sub), { recursive: true });
  }

  function readState() {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
      return { managed: parsed && typeof parsed.managed === 'object' && parsed.managed ? parsed.managed : {} };
    } catch { return { managed: {} }; }
  }
  function writeState(state) {
    fsImpl.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  /** Jars that ship with the launcher: [{ name, file }]. A bare file name only: no paths, no hidden files. */
  function bundledJars() {
    if (!bundledDir) return [];
    let names = [];
    try { names = fsImpl.readdirSync(bundledDir); } catch { return []; }
    return names
      .filter((n) => /\.jar$/i.test(n) && !n.startsWith('.') && n === path.basename(n))
      .sort()
      .map((name) => ({ name, file: path.join(bundledDir, name) }));
  }

  /** visual-mod/manifest.json: { "fabricApi": false } turns the automatic Fabric API download off. */
  function bundledManifest() {
    if (!bundledDir) return {};
    try {
      const m = JSON.parse(fsImpl.readFileSync(path.join(bundledDir, 'manifest.json'), 'utf8'));
      return m && typeof m === 'object' ? m : {};
    } catch { return {}; }
  }

  function modFiles() {
    try { return fsImpl.readdirSync(modsDir).filter((n) => /\.jar$/i.test(n)).sort(); } catch { return []; }
  }

  function syncBundled() {
    const state = readState();
    const jars = bundledJars();
    const keep = new Set(jars.map((j) => j.name));
    // Jars this launcher copied earlier that are no longer shipped (renamed or replaced mod build).
    for (const name of Object.keys(state.managed)) {
      if (!keep.has(name) && name === path.basename(name)) {
        try { fsImpl.rmSync(path.join(modsDir, name), { force: true }); } catch (err) { log('warn', `Visual mod: could not remove old ${name}: ${err.message}`); }
        delete state.managed[name];
      }
    }
    const copied = [];
    for (const jar of jars) {
      const dest = path.join(modsDir, jar.name);
      let hash;
      try { hash = sha1File(jar.file, fsImpl); } catch (err) { throw new VisualError('VISUAL_FAILED', `Не удалось прочитать файл визуального мода ${jar.name}: ${err.message}`, { cause: err }); }
      let same = false;
      try { same = fsImpl.existsSync(dest) && sha1File(dest, fsImpl) === hash; } catch { same = false; }
      if (!same) {
        const tmp = `${dest}.${process.pid}.tmp`;
        try {
          fsImpl.copyFileSync(jar.file, tmp);
          fsImpl.renameSync(tmp, dest);
        } catch (err) {
          try { fsImpl.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
          throw new VisualError('VISUAL_FAILED', `Не удалось скопировать визуальный мод в папку игры: ${err.message}`, { cause: err });
        }
        copied.push(jar.name);
      }
      state.managed[jar.name] = { sha1: hash };
    }
    writeState(state);
    return { copied, shipped: jars.map((j) => j.name) };
  }

  return {
    profile: VISUAL_PROFILE,
    /** The Modrinth service needs this service's folders, so the downloader is attached after both exist. */
    setFabricApiInstaller(fn) { installFabricApi = typeof fn === 'function' ? fn : null; },
    folder() { ensureFolders(); return root; },
    modsFolder() { ensureFolders(); return modsDir; },
    /** Shape of a "build" for the Modrinth service (it only needs get/folder/modsFolder). */
    asBuild() {
      return {
        get: () => ({ id: 'visual', name: 'Визуальный мод', mcVersion: VISUAL_PROFILE.mcVersion, loader: VISUAL_PROFILE.loader, loaderVersion: '' }),
        folder: () => this.folder(),
        modsFolder: () => this.modsFolder()
      };
    },
    /** What the UI needs to explain the state: nothing here is a path. */
    info() {
      const shipped = bundledJars().map((j) => j.name);
      const present = modFiles();
      return { mcVersion: VISUAL_PROFILE.mcVersion, loader: VISUAL_PROFILE.loader, shipped, installed: present, ready: shipped.length > 0 || present.length > 0 };
    },
    /**
     * Called before every launch of the visual mode. Returns { warnings: string[] };
     * only a failure to write the files throws. A missing mod or an unreachable
     * Fabric API download are warnings: the game still starts.
     */
    async prepare({ signal } = {}) {
      ensureFolders();
      const warnings = [];
      const { copied, shipped } = syncBundled();
      if (copied.length) log('info', `Visual mod: copied ${copied.join(', ')}`);
      const installed = modFiles();
      if (installed.length === 0) {
        warnings.push('Файл визуального мода не найден: игра запустится только с Fabric. Положите .jar в папку визуального мода (кнопка 🧩).');
      } else if (shipped.length === 0) {
        log('info', 'Visual mod: no bundled jar, using the files already in the mods folder');
      }
      const wantsApi = bundledManifest().fabricApi !== false;
      if (installed.length > 0 && wantsApi && installFabricApi && !installed.some((n) => /^fabric-api-/i.test(n))) {
        try {
          await installFabricApi({ signal });
          log('info', 'Visual mod: Fabric API installed');
        } catch (err) {
          if (signal && signal.aborted) throw new VisualError('CANCELLED', 'Установка отменена.');
          log('warn', `Visual mod: Fabric API download failed: ${err && err.message}`);
          warnings.push('Не удалось скачать Fabric API для визуального мода (проверьте интернет). Если игра не запустится — повторите запуск с сетью.');
        }
      }
      return { warnings };
    }
  };
}

module.exports = { createVisualService, VisualError, SUBDIRS, STATE_FILE };
