'use strict';
// "Сборки" (builds): named Minecraft profiles, each with its own folder
// (mods/saves/config/resourcepacks/shaderpacks/screenshots), separate from
// the shared gameDir. versions/libraries/assets stay shared in gameDir (see
// adapters/xmcl.js resourcePath) so each build does not re-download them —
// the same model MultiMC/Prism use (per-instance data, shared metadata cache).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { VERSION_ID_RE, VERSION_ALIASES, LOADER_IDS, LOADER_VERSION_RE } = require('./settings');

class BuildError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BuildError';
    this.code = code;
  }
}

const ID_RE = /^b-[0-9a-f]{16}$/;
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/;
const SUBDIRS = ['mods', 'saves', 'config', 'resourcepacks', 'shaderpacks', 'screenshots'];

function checkName(name) {
  if (typeof name !== 'string') throw new BuildError('VALIDATION', 'Укажите название сборки.');
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 48) throw new BuildError('VALIDATION', 'Название сборки — от 1 до 48 символов.');
  if (FORBIDDEN_NAME_CHARS.test(trimmed)) throw new BuildError('VALIDATION', 'Название не должно содержать \\ / : * ? " < > |');
  return trimmed;
}
function checkVersion(v) {
  if (typeof v !== 'string' || !(VERSION_ALIASES.includes(v) || VERSION_ID_RE.test(v))) throw new BuildError('VALIDATION', 'Недопустимая версия Minecraft.');
  return v;
}
function checkLoader(l) {
  if (typeof l !== 'string' || !LOADER_IDS.includes(l)) throw new BuildError('VALIDATION', 'Неизвестный загрузчик.');
  return l;
}
function checkLoaderVersion(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || !LOADER_VERSION_RE.test(v)) throw new BuildError('VALIDATION', 'Недопустимая версия загрузчика.');
  return v;
}
function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new BuildError('VALIDATION', 'Недопустимый идентификатор сборки.');
  return id;
}

function copyDir(src, dest, fsImpl) {
  fsImpl.mkdirSync(dest, { recursive: true });
  for (const entry of fsImpl.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, fsImpl);
    else if (entry.isFile()) fsImpl.copyFileSync(s, d);
  }
}

function newId(dirOf, fsImpl) {
  let id;
  do { id = `b-${crypto.randomBytes(8).toString('hex')}`; } while (fsImpl.existsSync(dirOf(id)));
  return id;
}

/** @param {{root:string, fsImpl?: typeof fs}} opts */
function createBuildsService({ root, fsImpl = fs }) {
  fsImpl.mkdirSync(root, { recursive: true });
  const dirOf = (id) => path.join(root, id);
  const metaOf = (id) => path.join(dirOf(id), 'build.json');

  function readMeta(id) {
    try {
      const raw = JSON.parse(fsImpl.readFileSync(metaOf(id), 'utf8'));
      if (!raw || typeof raw !== 'object' || raw.id !== id) return null;
      return raw;
    } catch {
      return null;
    }
  }
  function writeMeta(build) {
    fsImpl.writeFileSync(metaOf(build.id), JSON.stringify(build, null, 2));
  }

  function list() {
    let entries;
    try { entries = fsImpl.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
      const meta = readMeta(e.name);
      if (meta) out.push(meta);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return out;
  }

  function get(id) {
    checkId(id);
    const meta = readMeta(id);
    if (!meta) throw new BuildError('NOT_FOUND', 'Сборка не найдена.');
    return meta;
  }

  function folder(id) {
    checkId(id);
    return dirOf(id);
  }
  function modsFolder(id) {
    return path.join(folder(id), 'mods');
  }

  function create({ name, mcVersion, loader = 'vanilla', loaderVersion = '' } = {}) {
    const cleanName = checkName(name);
    const cleanVersion = checkVersion(mcVersion);
    const cleanLoader = checkLoader(loader);
    const cleanLoaderVersion = checkLoaderVersion(loaderVersion);
    const id = newId(dirOf, fsImpl);
    const now = new Date().toISOString();
    for (const sub of SUBDIRS) fsImpl.mkdirSync(path.join(dirOf(id), sub), { recursive: true });
    const build = { id, name: cleanName, mcVersion: cleanVersion, loader: cleanLoader, loaderVersion: cleanLoaderVersion, createdAt: now, updatedAt: now };
    writeMeta(build);
    return build;
  }

  function rename(id, name) {
    const build = get(id);
    build.name = checkName(name);
    build.updatedAt = new Date().toISOString();
    writeMeta(build);
    return build;
  }

  function update(id, patch = {}) {
    const build = get(id);
    if (patch.mcVersion !== undefined) build.mcVersion = checkVersion(patch.mcVersion);
    if (patch.loader !== undefined) build.loader = checkLoader(patch.loader);
    if (patch.loaderVersion !== undefined) build.loaderVersion = checkLoaderVersion(patch.loaderVersion);
    build.updatedAt = new Date().toISOString();
    writeMeta(build);
    return build;
  }

  function duplicate(id, name) {
    const src = get(id);
    const cleanName = checkName(name);
    const id2 = newId(dirOf, fsImpl);
    copyDir(dirOf(src.id), dirOf(id2), fsImpl);
    const now = new Date().toISOString();
    const build = { ...src, id: id2, name: cleanName, createdAt: now, updatedAt: now };
    writeMeta(build);
    return build;
  }

  function remove(id) {
    checkId(id);
    fsImpl.rmSync(dirOf(id), { recursive: true, force: true });
    return { removed: true };
  }

  return { list, get, create, rename, update, duplicate, remove, folder, modsFolder };
}

module.exports = { createBuildsService, BuildError, SUBDIRS };
