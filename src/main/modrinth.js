'use strict';
// Modrinth integration: search public mods and add them straight into a
// build's own mods/ folder (see builds.js). Public API, no key needed:
// https://docs.modrinth.com/api/ . Only the "mod" project type is handled —
// this is for adding mods to a build, not resource/shader packs.
const fs = require('node:fs');
const path = require('node:path');
const net = require('./net');
const { VERSION_ID_RE } = require('./settings');

const API = 'https://api.modrinth.com/v2';
const API_HOSTS = ['api.modrinth.com'];
const CDN_HOSTS = ['cdn.modrinth.com', 'cdn-raw.modrinth.com'];
const MANIFEST_NAME = '.obscura-mods.json';
const PROJECT_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/; // Modrinth accepts either the base62 id or the slug
const MAX_DEPENDENCY_MODS = 20; // per add-mod call — a sane ceiling against a bad/cyclical dependency graph

// Modrinth's own category slugs for mods (the catalog window's filter chips) and sort orders.
const CATEGORIES = Object.freeze(['optimization', 'utility', 'library', 'decoration', 'adventure', 'magic', 'technology', 'storage', 'worldgen', 'mobs', 'equipment', 'food', 'game-mechanics', 'transportation']);
const SORTS = Object.freeze(['relevance', 'downloads', 'newest', 'updated', 'follows']);
const PAGE_SIZE_DEFAULT = 12;

/** Loaders whose mods a build can use. Quilt runs Fabric mods too, so a Quilt build sees both. */
function compatibleLoaders(loader) {
  if (!loader || loader === 'vanilla') return [];
  return loader === 'quilt' ? ['quilt', 'fabric'] : [loader];
}

class ModrinthError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ModrinthError';
    this.code = code;
  }
}

function checkProjectId(id) {
  if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) throw new ModrinthError('VALIDATION', 'Недопустимый идентификатор мода.');
  return id;
}
function checkMc(mcVersion) {
  if (typeof mcVersion !== 'string' || !VERSION_ID_RE.test(mcVersion)) throw new ModrinthError('VALIDATION', 'Недопустимая версия Minecraft.');
  return mcVersion;
}

/** @param {{ builds: ReturnType<typeof import('./builds').createBuildsService>, transport?: any, sleep?: any, fsImpl?: typeof fs, resolveVersion?: (alias: 'release'|'snapshot') => Promise<string> }} deps */
function createModrinthService({ builds, transport, sleep, fsImpl = fs, resolveVersion = null } = {}) {
  const netOpts = (hosts, extra = {}) => ({ hosts, transport, sleep, ...extra });

  function manifestPath(buildId) {
    return path.join(builds.folder(buildId), MANIFEST_NAME);
  }
  function readManifest(buildId) {
    try { return JSON.parse(fsImpl.readFileSync(manifestPath(buildId), 'utf8')); } catch { return {}; }
  }
  function writeManifest(buildId, data) {
    fsImpl.writeFileSync(manifestPath(buildId), JSON.stringify(data, null, 2));
  }

  /** The concrete Minecraft version of a build ("release"/"snapshot" aliases resolve to the current id). */
  async function mcOf(build) {
    if (build.mcVersion !== 'release' && build.mcVersion !== 'snapshot') return build.mcVersion;
    if (!resolveVersion) throw new ModrinthError('VALIDATION', 'Укажите у сборки конкретную версию Minecraft.');
    return checkMc(await resolveVersion(build.mcVersion));
  }

  /** Search mods. loader may be '' (any) or a loader id matching Modrinth's category names. */
  async function search({ query = '', mcVersion = '', loader = '', category = '', sort = '', limit = 20, offset = 0, signal } = {}) {
    const facets = [['project_type:mod']];
    if (mcVersion) facets.push([`versions:${checkMc(mcVersion)}`]);
    const loaders = compatibleLoaders(loader);
    if (loaders.length) facets.push(loaders.map((l) => `categories:${l}`));
    if (category) {
      if (!CATEGORIES.includes(category)) throw new ModrinthError('VALIDATION', 'Неизвестная категория модов.');
      facets.push([`categories:${category}`]);
    }
    facets.push(['client_side:required', 'client_side:optional']); // server-only mods are useless in a launcher
    if (sort && !SORTS.includes(sort)) throw new ModrinthError('VALIDATION', 'Неизвестный порядок сортировки.');
    const url = new URL(`${API}/search`);
    url.searchParams.set('query', query || '');
    url.searchParams.set('facets', JSON.stringify(facets));
    url.searchParams.set('limit', String(Math.min(50, Math.max(1, Number(limit) || 20))));
    url.searchParams.set('offset', String(Math.max(0, Number(offset) || 0)));
    url.searchParams.set('index', sort && (sort !== 'relevance' || query) ? sort : (query ? 'relevance' : 'downloads'));
    const data = await net.fetchJson(url.href, netOpts(API_HOSTS, { signal }));
    const hits = Array.isArray(data && data.hits) ? data.hits : [];
    return {
      total: Number(data && data.total_hits) || hits.length,
      hits: hits.map((h) => ({
        projectId: h.project_id,
        slug: h.slug,
        title: h.title,
        description: h.description,
        iconUrl: h.icon_url || null,
        downloads: h.downloads || 0,
        author: h.author || '',
        categories: Array.isArray(h.display_categories) ? h.display_categories : (Array.isArray(h.categories) ? h.categories : [])
      }))
    };
  }

  /**
   * The mod catalog for one build: what the "Добавить моды" window shows. Minecraft version and loader come
   * from the build itself (a Fabric build only ever sees Fabric mods, a Forge build only Forge mods, …), and
   * every hit says whether it is already installed.
   */
  async function browse({ buildId, query = '', category = '', sort = '', page = 1, pageSize = PAGE_SIZE_DEFAULT, signal } = {}) {
    const build = builds.get(buildId);
    if (build.loader === 'vanilla') throw new ModrinthError('VALIDATION', 'У этой сборки не выбран загрузчик модов.');
    if (typeof query !== 'string' || query.length > 100) throw new ModrinthError('VALIDATION', 'Слишком длинный поисковый запрос.');
    const mcVersion = await mcOf(build);
    const size = Math.min(30, Math.max(6, Math.floor(Number(pageSize)) || PAGE_SIZE_DEFAULT));
    const pageNo = Math.min(Math.floor(10000 / size), Math.max(1, Math.floor(Number(page)) || 1));
    const result = await search({ query: query.trim(), mcVersion, loader: build.loader, category, sort, limit: size, offset: (pageNo - 1) * size, signal });
    const have = new Set(listInstalled(buildId).map((m) => m.projectId));
    return {
      mcVersion, loader: build.loader, page: pageNo, pageSize: size,
      total: result.total, pages: Math.max(1, Math.ceil(Math.min(result.total, 10000) / size)),
      hits: result.hits.map((h) => ({ ...h, installed: have.has(h.projectId) }))
    };
  }

  /** Versions of one project compatible with mcVersion + loader, newest first. */
  async function projectVersions({ projectId, mcVersion, loader, signal }) {
    checkProjectId(projectId); checkMc(mcVersion);
    const url = new URL(`${API}/project/${encodeURIComponent(projectId)}/version`);
    const loaders = compatibleLoaders(loader);
    if (loaders.length) url.searchParams.set('loaders', JSON.stringify(loaders));
    url.searchParams.set('game_versions', JSON.stringify([mcVersion]));
    const list = await net.fetchJson(url.href, netOpts(API_HOSTS, { signal }));
    if (!Array.isArray(list)) throw new ModrinthError('MODRINTH_FAILED', 'Modrinth вернул неожиданный ответ.');
    return list.map((v) => ({
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      changelog: v.changelog || '',
      datePublished: v.date_published,
      dependencies: Array.isArray(v.dependencies) ? v.dependencies.map((d) => ({ projectId: d.project_id, versionId: d.version_id, type: d.dependency_type })) : [],
      files: Array.isArray(v.files) ? v.files.map((f) => ({ url: f.url, filename: f.filename, primary: !!f.primary, sha1: f.hashes && f.hashes.sha1, size: f.size })) : []
    }));
  }

  async function bestVersion({ projectId, mcVersion, loader, versionId, signal }) {
    const versions = await projectVersions({ projectId, mcVersion, loader, signal });
    if (versionId) {
      const exact = versions.find((v) => v.id === versionId);
      if (!exact) throw new ModrinthError('MODRINTH_UNSUPPORTED', `Выбранная версия мода недоступна для Minecraft ${mcVersion}.`);
      return exact;
    }
    if (versions.length === 0) throw new ModrinthError('MODRINTH_UNSUPPORTED', `На Modrinth нет версии этого мода для Minecraft ${mcVersion}${loader && loader !== 'vanilla' ? ` (${loader})` : ''}.`);
    return versions[0];
  }

  async function downloadFile(file, modsDir, { signal, onProgress } = {}) {
    const url = net.assertUrl(file.url, CDN_HOSTS);
    const dest = path.join(modsDir, path.basename(file.filename || path.basename(url.pathname)));
    await net.downloadFile(url.href, dest, netOpts(CDN_HOSTS, { signal, sha1: file.sha1, maxBytes: 256 * 1024 * 1024, onProgress }));
    return path.basename(dest);
  }

  /**
   * Add a mod (and its required dependencies, recursively) to a build's mods/ folder.
   * Returns the list of { projectId, title, filename } actually installed in this call
   * (already-installed projects are skipped).
   */
  async function addMod({ buildId, projectId, versionId = null, title = '', iconUrl = '', signal, onProgress } = {}) {
    checkProjectId(projectId);
    const build = builds.get(buildId);
    if (build.loader === 'vanilla') throw new ModrinthError('VALIDATION', 'У этой сборки не выбран загрузчик модов.');
    const modsDir = builds.modsFolder(buildId);
    fsImpl.mkdirSync(modsDir, { recursive: true });
    const manifest = readManifest(buildId);
    const installed = [];
    const seen = new Set(Object.values(manifest).map((m) => m.projectId));
    const mcVersion = await mcOf(build);
    const queue = [{ projectId, versionId }];
    let guard = 0;

    while (queue.length) {
      if (++guard > MAX_DEPENDENCY_MODS) throw new ModrinthError('MODRINTH_FAILED', `Слишком много зависимостей (> ${MAX_DEPENDENCY_MODS}) — остановлено для безопасности.`);
      const item = queue.shift();
      if (seen.has(item.projectId)) continue;
      const version = await bestVersion({ projectId: item.projectId, mcVersion, loader: build.loader, versionId: item.versionId, signal });
      const file = version.files.find((f) => f.primary) || version.files[0];
      if (!file) throw new ModrinthError('MODRINTH_FAILED', 'У версии мода нет файла для загрузки.');
      if (file.sha1 && !/^[0-9a-f]{40}$/i.test(file.sha1)) throw new ModrinthError('MODRINTH_FAILED', 'Modrinth вернул некорректную контрольную сумму.');
      if (onProgress) onProgress({ stage: 'download', projectId: item.projectId });
      const filename = await downloadFile(file, modsDir, { signal });
      seen.add(item.projectId);
      const isRoot = item.projectId === projectId;
      const entry = {
        projectId: item.projectId, versionId: version.id, filename, addedAt: new Date().toISOString(),
        title: (isRoot && typeof title === 'string' && title) || '',
        iconUrl: (isRoot && typeof iconUrl === 'string' && iconUrl) || ''
      };
      manifest[filename] = entry;
      installed.push(entry);
      for (const dep of version.dependencies) {
        if (dep.type === 'required' && dep.projectId && !seen.has(dep.projectId)) queue.push({ projectId: dep.projectId, versionId: dep.versionId || null });
      }
    }
    writeManifest(buildId, manifest);
    return installed;
  }

  /** Installed mods for a build, cross-checked against what's actually on disk. */
  function listInstalled(buildId) {
    const modsDir = builds.modsFolder(buildId);
    let onDisk = new Set();
    try { onDisk = new Set(fsImpl.readdirSync(modsDir)); } catch { /* no mods folder yet */ }
    const manifest = readManifest(buildId);
    const out = [];
    let changed = false;
    for (const [filename, entry] of Object.entries(manifest)) {
      if (!onDisk.has(filename)) { delete manifest[filename]; changed = true; continue; } // removed outside the launcher
      out.push({ ...entry, filename });
    }
    if (changed) writeManifest(buildId, manifest);
    return out;
  }

  function removeMod(buildId, filename) {
    if (typeof filename !== 'string' || !filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      throw new ModrinthError('VALIDATION', 'Недопустимое имя файла.');
    }
    const modsDir = builds.modsFolder(buildId);
    fsImpl.rmSync(path.join(modsDir, filename), { force: true });
    const manifest = readManifest(buildId);
    if (manifest[filename]) { delete manifest[filename]; writeManifest(buildId, manifest); }
    return { removed: true };
  }

  return { search, browse, projectVersions, addMod, listInstalled, removeMod };
}

module.exports = { createModrinthService, ModrinthError, MANIFEST_NAME, CATEGORIES, SORTS };
