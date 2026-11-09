'use strict';
// Minecraft version discovery from Mojang's official version manifest.
// Only the manifest URL below is hard-coded; every other URL comes from the
// manifest itself and must be https on a Mojang host before it is used.
const fs = require('node:fs');
const path = require('node:path');
const { VERSION_ID_RE } = require('./settings');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const ALLOWED_HOSTS = new Set(['piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com']);

class VersionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'VersionError';
    this.code = code;
  }
}

function assertMojangUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new VersionError('BAD_MANIFEST', 'Манифест содержит некорректный URL.'); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new VersionError('BAD_MANIFEST', 'Манифест указывает на неразрешённый адрес.');
  }
  return url.href;
}

/** Validate and normalize the manifest shape. Throws VersionError on anything unexpected. */
function parseManifest(json) {
  const bad = () => new VersionError('BAD_MANIFEST', 'Получен некорректный манифест версий Minecraft.');
  if (!json || typeof json !== 'object') throw bad();
  const latest = json.latest;
  if (!latest || typeof latest.release !== 'string' || typeof latest.snapshot !== 'string') throw bad();
  if (!Array.isArray(json.versions) || json.versions.length === 0) throw bad();
  const versions = [];
  for (const v of json.versions) {
    if (!v || typeof v.id !== 'string' || !VERSION_ID_RE.test(v.id)) continue;
    if (typeof v.type !== 'string' || typeof v.url !== 'string') continue;
    try { assertMojangUrl(v.url); } catch { continue; }
    versions.push({
      id: v.id,
      type: v.type,
      url: v.url,
      sha1: typeof v.sha1 === 'string' ? v.sha1 : undefined,
      releaseTime: typeof v.releaseTime === 'string' ? v.releaseTime : ''
    });
  }
  if (versions.length === 0) throw bad();
  return { latest: { release: latest.release, snapshot: latest.snapshot }, versions };
}

class VersionService {
  /**
   * @param {{ cacheFile?: string|null, fetchImpl?: typeof fetch, timeoutMs?: number, url?: string }} opts
   */
  constructor({ cacheFile = null, fetchImpl = globalThis.fetch, timeoutMs = 15000, url = MANIFEST_URL } = {}) {
    this.cacheFile = cacheFile;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.url = url;
    this.memory = null; // { manifest, source, fetchedAt }
  }

  /** @returns {Promise<{ manifest: ReturnType<typeof parseManifest>, source: 'network'|'cache', fetchedAt: number }>} */
  async getManifest({ force = false } = {}) {
    if (this.memory && !force && Date.now() - this.memory.fetchedAt < 5 * 60 * 1000) return this.memory;
    try {
      assertMojangUrl(this.url);
      const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } });
      if (!res.ok) throw new VersionError('NETWORK', `Сервер Mojang ответил: HTTP ${res.status}.`);
      const manifest = parseManifest(await res.json());
      this.memory = { manifest, source: 'network', fetchedAt: Date.now() };
      await this._writeCache(manifest);
      return this.memory;
    } catch (err) {
      const cached = await this._readCache();
      if (cached) {
        this.memory = { manifest: cached.manifest, source: 'cache', fetchedAt: Date.now() };
        return this.memory;
      }
      if (err instanceof VersionError) throw err;
      throw new VersionError('NETWORK', 'Не удалось получить список версий Minecraft. Проверьте подключение к интернету.', { cause: err });
    }
  }

  async _writeCache(manifest) {
    if (!this.cacheFile) return;
    try {
      await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify({ savedAt: Date.now(), manifest }), 'utf8');
      await fs.promises.rename(tmp, this.cacheFile);
    } catch { /* cache is best-effort */ }
  }

  async _readCache() {
    if (!this.cacheFile) return null;
    try {
      const data = JSON.parse(await fs.promises.readFile(this.cacheFile, 'utf8'));
      return { manifest: parseManifest(data.manifest) };
    } catch { return null; }
  }

  /** Map a UI value ("release", "snapshot" or an exact id) to a manifest entry. */
  resolve(manifest, requested) {
    let id = requested;
    if (requested === 'release') id = manifest.latest.release;
    else if (requested === 'snapshot') id = manifest.latest.snapshot;
    const entry = manifest.versions.find((v) => v.id === id);
    if (!entry) throw new VersionError('UNKNOWN_VERSION', `Версия «${String(requested).slice(0, 40)}» не найдена в манифесте Mojang.`);
    return entry;
  }

  /** Compact list for the UI. Old alpha/beta entries are excluded. */
  list(manifest) {
    return manifest.versions
      .filter((v) => v.type === 'release' || v.type === 'snapshot')
      .map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
  }
}

module.exports = { VersionService, VersionError, parseManifest, assertMojangUrl, MANIFEST_URL, ALLOWED_HOSTS };
