'use strict';
// Import a .mrpack (Modrinth modpack format: https://docs.modrinth.com/modpacks/format_definition/).
// Accepts a local file or a link (a direct .mrpack URL, or a modrinth.com modpack
// page link that gets resolved through the API). Creates a new build (see
// builds.js) from the pack's declared Minecraft version + loader, downloads
// every declared file (hash-verified) and unpacks overrides/ + client-overrides/
// straight into the build's folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('./net');
const zip = require('./zip');
const { VERSION_ID_RE, LOADER_VERSION_RE } = require('./settings');

const API_HOSTS = ['api.modrinth.com'];
const PACK_HOSTS = ['cdn.modrinth.com']; // the .mrpack file itself
const FILE_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']; // files it lists, per the mrpack spec's allowed hosts
const LOADER_DEP_KEYS = [['fabric-loader', 'fabric'], ['quilt-loader', 'quilt'], ['neoforge', 'neoforge'], ['forge', 'forge']];
const MODRINTH_PAGE_RE = /^https:\/\/modrinth\.com\/modpack\/([^/?#]+)(?:\/version\/([^/?#]+))?\/?$/;

class MrpackError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'MrpackError';
    this.code = code;
  }
}

function parseIndex(buf) {
  let json;
  try { json = JSON.parse(buf.toString('utf8')); } catch (err) { throw new MrpackError('MRPACK_INVALID', 'modrinth.index.json повреждён или не является JSON.', { cause: err }); }
  if (!json || typeof json !== 'object' || json.game !== 'minecraft' || !json.dependencies || typeof json.dependencies.minecraft !== 'string') {
    throw new MrpackError('MRPACK_INVALID', 'Это не похоже на модпак Modrinth (.mrpack).');
  }
  if (!VERSION_ID_RE.test(json.dependencies.minecraft)) throw new MrpackError('MRPACK_INVALID', 'Некорректная версия Minecraft в модпаке.');
  let loader = 'vanilla';
  let loaderVersion = '';
  for (const [key, id] of LOADER_DEP_KEYS) {
    const v = json.dependencies[key];
    if (typeof v === 'string' && v) {
      if (!LOADER_VERSION_RE.test(v)) throw new MrpackError('MRPACK_INVALID', `Некорректная версия загрузчика (${key}) в модпаке.`);
      loader = id; loaderVersion = v;
      break;
    }
  }
  return {
    name: typeof json.name === 'string' && json.name.trim() ? json.name.trim().slice(0, 48) : 'Импортированная сборка',
    mcVersion: json.dependencies.minecraft,
    loader, loaderVersion,
    files: Array.isArray(json.files) ? json.files : []
  };
}

/** @param {{ builds: ReturnType<typeof import('./builds').createBuildsService>, transport?: any, sleep?: any, fsImpl?: typeof fs }} deps */
function createMrpackService({ builds, transport, sleep, fsImpl = fs } = {}) {
  const netOpts = (hosts, extra = {}) => ({ hosts, transport, sleep, ...extra });

  /** A direct .mrpack link, or a modrinth.com modpack page link resolved via the API. Returns { url, sha1 }. */
  async function resolvePackUrl(rawUrl, { signal } = {}) {
    const trimmed = String(rawUrl || '').trim();
    if (/\.mrpack(?:[?#]|$)/i.test(trimmed)) {
      const u = net.assertUrl(trimmed, PACK_HOSTS);
      return { url: u.href, sha1: null };
    }
    const m = MODRINTH_PAGE_RE.exec(trimmed);
    if (!m) throw new MrpackError('VALIDATION', 'Укажите прямую ссылку на .mrpack или на страницу модпака на modrinth.com, либо выберите файл.');
    const [, slug, versionSlug] = m;
    const versions = await net.fetchJson(`${'https://api.modrinth.com/v2'}/project/${encodeURIComponent(slug)}/version`, netOpts(API_HOSTS, { signal }));
    if (!Array.isArray(versions) || versions.length === 0) throw new MrpackError('MRPACK_INVALID', 'У этого модпака нет опубликованных версий на Modrinth.');
    const version = versionSlug ? versions.find((v) => v.id === versionSlug || v.version_number === versionSlug) : versions[0];
    if (!version) throw new MrpackError('MRPACK_INVALID', 'Указанная версия модпака не найдена.');
    const files = Array.isArray(version.files) ? version.files : [];
    const file = files.find((f) => typeof f.filename === 'string' && f.filename.endsWith('.mrpack')) || files.find((f) => f.primary);
    if (!file) throw new MrpackError('MRPACK_INVALID', 'У этой версии модпака нет файла .mrpack.');
    const u = net.assertUrl(file.url, PACK_HOSTS);
    return { url: u.href, sha1: file.hashes && file.hashes.sha1 };
  }

  async function fetchPackBuffer({ url, filePath, buffer, signal }) {
    if (buffer) return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (filePath) {
      try { return fsImpl.readFileSync(filePath); } catch (err) { throw new MrpackError('MRPACK_READ_FAILED', 'Не удалось прочитать выбранный файл.', { cause: err }); }
    }
    if (url) {
      const resolved = await resolvePackUrl(url, { signal });
      const dest = path.join(os.tmpdir(), `obscura-mrpack-${Date.now()}-${Math.random().toString(36).slice(2)}.mrpack`);
      try {
        await net.downloadFile(resolved.url, dest, netOpts(PACK_HOSTS, { signal, sha1: resolved.sha1 || undefined, maxBytes: 128 * 1024 * 1024 }));
        return fsImpl.readFileSync(dest);
      } finally {
        fsImpl.rmSync(dest, { force: true });
      }
    }
    throw new MrpackError('VALIDATION', 'Укажите файл или ссылку на модпак.');
  }

  function safeRelPath(p, context) {
    if (typeof p !== 'string' || !p || p.includes('..') || path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) {
      throw new MrpackError('MRPACK_INVALID', `Недопустимый путь в модпаке (${context}): ${p}`);
    }
    return p.split('/').filter(Boolean);
  }

  /** Imports a .mrpack from a local file or a link, returning the new build. */
  async function importPack({ url = '', filePath = '', buffer = null, name = '', signal, onProgress } = {}) {
    const buf = await fetchPackBuffer({ url, filePath, buffer, signal });
    let entries;
    try { entries = zip.readEntries(buf); } catch (err) { throw new MrpackError('MRPACK_INVALID', 'Файл не является корректным .mrpack архивом.', { cause: err }); }
    const indexEntry = entries.find((e) => e.name === 'modrinth.index.json');
    if (!indexEntry) throw new MrpackError('MRPACK_INVALID', 'В архиве нет modrinth.index.json.');
    const index = parseIndex(zip.extract(buf, indexEntry));

    const build = builds.create({ name: name || index.name, mcVersion: index.mcVersion, loader: index.loader, loaderVersion: index.loaderVersion });
    const buildDir = builds.folder(build.id);
    try {
      const wanted = index.files.filter((f) => !(f.env && f.env.client === 'unsupported'));
      let done = 0;
      for (const f of wanted) {
        const rel = safeRelPath(f.path, 'files[]');
        const candidates = Array.isArray(f.downloads) ? f.downloads : [];
        let dlUrl = null;
        for (const u of candidates) { try { dlUrl = net.assertUrl(u, FILE_HOSTS).href; break; } catch { /* try next */ } }
        if (!dlUrl) throw new MrpackError('MRPACK_INVALID', `У файла "${f.path}" нет разрешённой ссылки для скачивания.`);
        const sha1 = f.hashes && f.hashes.sha1;
        await net.downloadFile(dlUrl, path.join(buildDir, ...rel), netOpts(FILE_HOSTS, { signal, sha1, maxBytes: 256 * 1024 * 1024 }));
        done++;
        if (onProgress) onProgress({ stage: 'files', done, total: wanted.length, percent: wanted.length ? Math.round((done / wanted.length) * 100) : 100 });
      }
      for (const prefix of ['overrides/', 'client-overrides/']) {
        for (const e of entries) {
          if (!e.name.startsWith(prefix) || e.name.endsWith('/')) continue;
          const rel = safeRelPath(e.name.slice(prefix.length), e.name);
          if (rel.length === 0) continue;
          const dest = path.join(buildDir, ...rel);
          fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
          fsImpl.writeFileSync(dest, zip.extract(buf, e));
        }
      }
    } catch (err) {
      try { builds.remove(build.id); } catch { /* best effort cleanup */ }
      throw err;
    }
    return build;
  }

  return { importPack, resolvePackUrl };
}

module.exports = { createMrpackService, MrpackError };
