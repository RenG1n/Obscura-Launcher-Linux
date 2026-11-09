'use strict';
// Mod loaders: Fabric and Quilt (official Meta APIs + Maven: the launcher
// downloads the profile and every library itself) and Forge / NeoForge
// (official installer from the project's Maven, run with the game's Java).
// All of them produce a normal version folder under versions/<id>/ that
// @xmcl/core launches through "inheritsFrom", exactly like the official
// launcher does.
//
// Self-healing: an already installed loader is re-checked on every launch.
// Missing libraries (cleaned by the user, eaten by an antivirus) are fetched
// again instead of the game crashing with ClassNotFoundException.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const net = require('./net');
const { VERSION_ID_RE } = require('./settings');

const LOADERS = Object.freeze(['vanilla', 'fabric', 'forge', 'quilt', 'neoforge']);
const MARKER = '.obscura-installed';

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FABRIC_HOSTS = ['meta.fabricmc.net', 'maven.fabricmc.net'];
const FABRIC_LIB_HOSTS = ['maven.fabricmc.net', 'repo1.maven.org', 'repo.maven.apache.org', 'libraries.minecraft.net'];
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const FORGE_METADATA = `${FORGE_MAVEN}/maven-metadata.xml`;
const FORGE_HOSTS = ['files.minecraftforge.net', 'maven.minecraftforge.net'];

// Quilt Meta mirrors Fabric Meta (v3, same shape as Fabric's v2 loader/profile
// endpoints) — Quilt's own tooling is a fork of Fabric's for this exact reason.
const QUILT_META = 'https://meta.quiltmc.org/v3';
const QUILT_HOSTS = ['meta.quiltmc.org', 'maven.quiltmc.org'];
const QUILT_LIB_HOSTS = ['maven.quiltmc.org', 'repo1.maven.org', 'repo.maven.apache.org', 'maven.fabricmc.net', 'libraries.minecraft.net'];
// NeoForge's installer is a fork of Forge's (same --installClient CLI). Its Maven
// (Reposilite) exposes a small JSON API for version listing, unlike Forge's XML/promos.
const NEOFORGE_VERSIONS_API = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const NEOFORGE_HOSTS = ['maven.neoforged.net'];

const LOADER_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;
const FORGE_LIST_TTL_MS = 10 * 60 * 1000;
const INSTALLER_TIMEOUT_MS = 25 * 60 * 1000;

// Fabric and Quilt share one installer: only the endpoints and the notion of "stable" differ.
const PROFILE_LOADERS = Object.freeze({
  fabric: {
    label: 'Fabric', meta: FABRIC_META, hosts: FABRIC_HOSTS, libHosts: FABRIC_LIB_HOSTS,
    defaultRepo: 'https://maven.fabricmc.net/', idPrefix: 'fabric-loader',
    isStable: (row) => row.loader.stable === true
  },
  quilt: {
    label: 'Quilt', meta: QUILT_META, hosts: QUILT_HOSTS, libHosts: QUILT_LIB_HOSTS,
    defaultRepo: 'https://maven.quiltmc.org/repository/release/', idPrefix: 'quilt-loader',
    isStable: (row) => !/beta|pre|rc/i.test(row.loader.version)
  }
});

class LoaderError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'LoaderError';
    this.code = code;
  }
}

const LABEL = { fabric: 'Fabric', forge: 'Forge', quilt: 'Quilt', neoforge: 'NeoForge' };

/**
 * Minecraft version -> the prefix NeoForge's own version numbers start with.
 *   1.20.4  -> "20.4."      1.21   -> "21.0."
 *   26.1    -> "26.1.0."    26.1.2 -> "26.1.2."   (year-based Minecraft versions keep all three parts)
 * Anything else (snapshots, 1.20.1 and older) has no NeoForge build: null.
 */
function neoforgeMcPrefix(mcId) {
  const legacy = /^1\.(\d+)(?:\.(\d+))?$/.exec(mcId);
  if (legacy) return `${legacy[1]}.${legacy[2] || '0'}.`;
  const yearly = /^(\d{2})\.(\d+)(?:\.(\d+))?$/.exec(mcId);
  if (yearly && Number(yearly[1]) >= 26) return `${yearly[1]}.${yearly[2]}.${yearly[3] || '0'}.`;
  return null;
}

function checkMc(mcId) {
  if (typeof mcId !== 'string' || !VERSION_ID_RE.test(mcId)) throw new LoaderError('VALIDATION', 'Недопустимая версия Minecraft.');
}
function checkLoader(loader) {
  if (!['fabric', 'forge', 'quilt', 'neoforge'].includes(loader)) throw new LoaderError('VALIDATION', 'Неизвестный загрузчик.');
}
function checkLoaderVersion(v) {
  if (v !== '' && v !== undefined && v !== null && !(typeof v === 'string' && LOADER_VERSION_RE.test(v))) throw new LoaderError('VALIDATION', 'Недопустимая версия загрузчика.');
}

/** Maven coordinate "group:artifact:version[:classifier][@ext]" -> repository-relative path. */
function mavenPath(name) {
  const m = /^([^:@\s]+):([^:@\s]+):([^:@\s]+)(?::([^:@\s]+))?(?:@([A-Za-z0-9]+))?$/.exec(String(name));
  if (!m) throw new LoaderError('LOADER_FAILED', `Некорректное имя библиотеки в профиле загрузчика: ${String(name).slice(0, 60)}`);
  const [, group, artifact, version, classifier, ext = 'jar'] = m;
  for (const part of [group, artifact, version, classifier || '']) if (part.includes('..') || part.includes('/') || part.includes('\\')) throw new LoaderError('LOADER_FAILED', 'Небезопасное имя библиотеки.');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

const escapeRe = (s) => String(s).replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
const byVersionDesc = (a, b) => b.localeCompare(a, undefined, { numeric: true });

function nonEmptyFile(file) {
  try { return fs.statSync(file).size > 0; } catch { return false; }
}

function readMarker(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; } // older launchers wrote a bare timestamp
}
function writeMarker(dir, extra = {}) {
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ at: new Date().toISOString(), ...extra }));
}

function isLoaderInstalled(gameDir, id, fsImpl = fs) {
  const dir = path.join(gameDir, 'versions', id);
  return fsImpl.existsSync(path.join(dir, `${id}.json`)) && fsImpl.existsSync(path.join(dir, MARKER));
}

/** Best-effort stop of a process and everything it started (the Forge installer runs child JVMs). */
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* already gone */ }
}

/**
 * Run an installer without a shell. Output is read as a stream and only the
 * last lines are kept (no maxBuffer cliff); `onLine` lets the UI show what the
 * installer is doing. Rejects with err.output = the tail of the output.
 */
function defaultRun(file, args, opts = {}) {
  const { cwd, signal, onLine, timeoutMs = INSTALLER_TIMEOUT_MS } = opts;
  return new Promise((resolve, reject) => {
    const tail = [];
    const push = (raw) => {
      const line = String(raw).replace(/\s+$/, '');
      if (!line) return;
      tail.push(line.slice(0, 500));
      if (tail.length > 200) tail.shift();
      if (onLine) { try { onLine(line); } catch { /* UI callbacks must not break the install */ } }
    };
    const rest = { out: '', err: '' };
    const feed = (key) => (chunk) => {
      rest[key] += chunk;
      const parts = rest[key].split(/\r?\n/);
      rest[key] = parts.pop();
      parts.forEach(push);
      if (rest[key].length > 4096) { push(rest[key]); rest[key] = ''; }
    };
    let child;
    try {
      child = spawn(file, args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { err.output = ''; reject(err); return; }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', feed('out')); child.stderr.on('data', feed('err'));
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => killTree(child);
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const done = (fn) => { if (settled) return; settled = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(); };
    child.on('error', (err) => done(() => { err.output = tail.join('\n'); reject(err); }));
    child.on('close', (code, sig) => done(() => {
      push(rest.out); push(rest.err);
      const output = tail.join('\n');
      if (code === 0) return resolve({ stdout: output, stderr: '' });
      const err = new Error(timedOut ? 'installer timed out' : `installer exited with ${code === null ? `signal ${sig}` : `code ${code}`}`);
      err.exitCode = code; err.output = output;
      reject(err);
    }));
  });
}

function createLoaderService({ gameDir, logger = null, transport, sleep, run = defaultRun, tmpDir = null } = {}) {
  const netOpts = (hosts, extra = {}) => ({ hosts, transport, sleep, ...extra });
  const warn = (msg) => { if (logger) logger.warn(msg); };
  const versionsDir = () => path.join(gameDir, 'versions');
  let forgeListCache = null; // { at, byMc: Map } — the Maven index is large, do not refetch it per click
  let forgeIndexFailedAt = 0; // an unreachable index must not slow down every version pick

  // ------------------------------------------------------- Fabric / Quilt
  async function profileVersions(kind, mcId, signal) {
    const cfg = PROFILE_LOADERS[kind];
    const list = await net.fetchJson(`${cfg.meta}/versions/loader/${encodeURIComponent(mcId)}`, netOpts(cfg.hosts, { signal }));
    const out = [];
    for (const row of Array.isArray(list) ? list : []) {
      const v = row && row.loader && row.loader.version;
      if (typeof v !== 'string' || !LOADER_VERSION_RE.test(v)) continue;
      out.push({ id: v, stable: cfg.isStable(row) });
    }
    return out;
  }

  /** [{ rel, url }] for every library of a Fabric/Quilt profile; refuses foreign hosts and unsafe names. */
  function profileLibraries(kind, profile) {
    const cfg = PROFILE_LOADERS[kind];
    const libs = [];
    for (const lib of profile.libraries) {
      if (!lib || typeof lib.name !== 'string') continue;
      const rel = mavenPath(lib.name);
      const base = typeof lib.url === 'string' && lib.url ? lib.url : cfg.defaultRepo;
      const url = new URL(rel, base.endsWith('/') ? base : `${base}/`);
      net.assertUrl(url.href, cfg.libHosts);
      libs.push({ rel, url: url.href });
    }
    return libs;
  }

  /** Download the libraries that are missing (4 at a time). The first failure stops the rest. */
  async function downloadLibraries(kind, libs, { signal, onProgress } = {}) {
    const cfg = PROFILE_LOADERS[kind];
    const todo = libs.filter((lib) => !nonEmptyFile(path.join(gameDir, 'libraries', ...lib.rel.split('/'))));
    let done = 0;
    const emit = () => { if (onProgress) onProgress({ percent: Math.round((done / Math.max(1, todo.length)) * 100) }); };
    emit();
    const queue = [...todo];
    let failure = null;
    const worker = async () => {
      while (!failure) {
        const lib = queue.shift();
        if (!lib) return;
        try {
          const dest = path.join(gameDir, 'libraries', ...lib.rel.split('/'));
          let sha1;
          try { sha1 = (await net.fetchText(`${lib.url}.sha1`, netOpts(cfg.libHosts, { signal, maxBytes: 1024, retries: 1 }))).trim().split(/\s+/)[0]; } catch (err) { if (err && err.code === 'CANCELLED') throw err; sha1 = undefined; }
          if (sha1 && !/^[0-9a-f]{40}$/i.test(sha1)) sha1 = undefined;
          await net.downloadFile(lib.url, dest, netOpts(cfg.libHosts, { signal, sha1, maxBytes: 128 * 1024 * 1024 }));
          done++;
          emit();
        } catch (err) { failure = failure || err; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
    if (failure) throw failure;
    return todo.length;
  }

  /** An installed Fabric/Quilt profile whose libraries went missing is repaired in place. Never fatal. */
  async function healProfileLoader(kind, id, { signal, onProgress }) {
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(versionsDir(), id, `${id}.json`), 'utf8'));
      if (!profile || !Array.isArray(profile.libraries)) return;
      const libs = profileLibraries(kind, profile);
      if (libs.every((lib) => nonEmptyFile(path.join(gameDir, 'libraries', ...lib.rel.split('/'))))) return;
      if (logger) logger.info(`${PROFILE_LOADERS[kind].label}: restoring missing libraries of ${id}`);
      await downloadLibraries(kind, libs, { signal, onProgress });
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw new LoaderError('CANCELLED', 'Установка отменена.');
      if (signal && signal.aborted) throw new LoaderError('CANCELLED', 'Установка отменена.');
      warn(`Could not verify or restore libraries of ${id}: ${err && err.message}`);
    }
  }

  async function installProfileLoader(kind, mcId, wanted, { signal, onProgress, repair }) {
    const cfg = PROFILE_LOADERS[kind];
    const idOf = (v) => `${cfg.idPrefix}-${v}-${mcId}`;
    if (wanted && !repair && isLoaderInstalled(gameDir, idOf(wanted))) {
      await healProfileLoader(kind, idOf(wanted), { signal, onProgress });
      return idOf(wanted);
    }
    const versions = await profileVersions(kind, mcId, signal);
    if (versions.length === 0) throw new LoaderError('LOADER_UNSUPPORTED', `${cfg.label} не поддерживает Minecraft ${mcId}.`);
    const loaderVersion = wanted ? wanted : (versions.find((v) => v.stable) || versions[0]).id;
    if (wanted && !versions.some((v) => v.id === wanted)) throw new LoaderError('LOADER_UNSUPPORTED', `${cfg.label} Loader ${wanted} недоступен для Minecraft ${mcId}.`);
    const id = idOf(loaderVersion);
    if (!repair && isLoaderInstalled(gameDir, id)) {
      await healProfileLoader(kind, id, { signal, onProgress });
      return id;
    }

    const profile = await net.fetchJson(`${cfg.meta}/versions/loader/${encodeURIComponent(mcId)}/${encodeURIComponent(loaderVersion)}/profile/json`, netOpts(cfg.hosts, { signal }));
    if (!profile || typeof profile !== 'object' || profile.id !== id || profile.inheritsFrom !== mcId || !Array.isArray(profile.libraries) || typeof profile.mainClass !== 'string') {
      throw new LoaderError('LOADER_FAILED', `${cfg.label} вернул неожиданный профиль версии.`);
    }
    await downloadLibraries(kind, profileLibraries(kind, profile), { signal, onProgress });
    const dir = path.join(versionsDir(), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(profile, null, 2));
    writeMarker(dir);
    if (onProgress) onProgress({ percent: 100 });
    return id;
  }

  // -------------------------------------------- shared installer machinery
  /** 1.13+ version JSONs list libraries with a download URL; an installed loader must still have them on disk. */
  function missingInstallerLibraries(id) {
    const dir = path.join(versionsDir(), id);
    let json;
    try { json = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')); } catch { return []; }
    const skip = new Set(Array.isArray(readMarker(dir).skip) ? readMarker(dir).skip : []);
    const out = [];
    for (const lib of Array.isArray(json.libraries) ? json.libraries : []) {
      const a = lib && lib.downloads && lib.downloads.artifact;
      // Only plain downloadable libraries: ones built by installer processors (empty url) or limited by OS rules are skipped.
      if (!a || typeof a.path !== 'string' || !a.url || lib.rules || a.path.includes('..') || skip.has(a.path)) continue;
      if (!nonEmptyFile(path.join(gameDir, 'libraries', ...a.path.split('/')))) out.push(a.path);
    }
    return out;
  }

  /** Names of the version folders created or touched for this loader build, expected id first. */
  function listVersionDirs() {
    try { return fs.readdirSync(versionsDir()); } catch { return []; }
  }

  async function runInstaller({ label, workName, version, expectedId, urls, hosts, matches, javaPath, signal, onProgress }) {
    // 1. Checksum first: nothing unverified is ever executed. Several URL shapes exist for old Forge builds.
    let jarUrl = null;
    let sha1 = null;
    let lastErr = null;
    for (const url of urls) {
      try {
        const text = (await net.fetchText(`${url}.sha1`, netOpts(hosts, { signal, maxBytes: 1024, retries: 2 }))).trim().split(/\s+/)[0];
        if (/^[0-9a-f]{40}$/i.test(text)) { jarUrl = url; sha1 = text; break; }
      } catch (err) {
        if (err && err.code === 'CANCELLED') throw new LoaderError('CANCELLED', 'Установка отменена.');
        lastErr = err;
      }
    }
    if (!jarUrl) throw new LoaderError('LOADER_FAILED', `Не удалось получить контрольную сумму установщика ${label}. Установка остановлена.`, lastErr ? { cause: lastErr } : undefined);

    const work = tmpDir || path.join(gameDir, workName);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    try {
      const installer = path.join(work, `${label.toLowerCase()}-${version}-installer.jar`);
      await net.downloadFile(jarUrl, installer, netOpts(hosts, { signal, sha1, maxBytes: 200 * 1024 * 1024, onProgress: (p) => { if (onProgress) onProgress({ percent: p.percent === null ? null : Math.round(p.percent * 0.2) }); } }));
      // The installers insist on a launcher_profiles.json next to the game files.
      fs.mkdirSync(gameDir, { recursive: true });
      const profiles = path.join(gameDir, 'launcher_profiles.json');
      if (!fs.existsSync(profiles)) fs.writeFileSync(profiles, JSON.stringify({ profiles: {}, version: 3 }));
      const before = new Set(listVersionDirs());
      if (onProgress) onProgress({ percent: null, message: `Запускаю установщик ${label} (это может занять несколько минут)…` });
      let lastEmit = 0;
      const onLine = (line) => {
        const now = Date.now();
        if (!onProgress || now - lastEmit < 500) return;
        lastEmit = now;
        onProgress({ percent: null, message: `Установщик ${label}: ${line.slice(0, 70)}…` });
      };
      try {
        await run(javaPath, ['-jar', installer, '--installClient', gameDir], { cwd: work, signal, onLine });
      } catch (err) {
        if (signal && signal.aborted) throw new LoaderError('CANCELLED', 'Установка отменена.');
        const lines = String((err && err.output) || (err && err.message) || '').split(/\r?\n/).filter(Boolean);
        warn(`${label} installer failed:\n${lines.slice(-60).join('\n')}`);
        const tail = lines.slice(-6).join(' ').slice(0, 400);
        throw new LoaderError('LOADER_FAILED', `Установщик ${label} завершился с ошибкой: ${tail}`, { cause: err });
      }
      const after = listVersionDirs();
      const hasJson = (n) => fs.existsSync(path.join(versionsDir(), n, `${n}.json`));
      const created = after.filter((n) => !before.has(n) && matches(n) && hasJson(n));
      const existing = after.filter((n) => matches(n) && hasJson(n));
      const id = created.includes(expectedId) ? expectedId : (after.includes(expectedId) && hasJson(expectedId) ? expectedId : (created[0] || existing[0]));
      if (!id || !hasJson(id)) throw new LoaderError('LOADER_FAILED', `Установщик ${label} завершился, но версия не появилась в папке игры.`);
      const dir = path.join(versionsDir(), id);
      writeMarker(dir);
      // Whatever the installer legitimately did not produce must not trigger a reinstall on every launch.
      const leftover = missingInstallerLibraries(id);
      if (leftover.length) { warn(`${label}: ${leftover.length} library file(s) listed by ${id} were not created by the installer; they will be ignored.`); writeMarker(dir, { skip: leftover }); }
      if (onProgress) onProgress({ percent: 100 });
      return id;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** Install via an official installer, or repair an installed build whose libraries disappeared. */
  async function installViaInstaller(spec, mcId, wanted, { signal, onProgress, javaPath, repair }) {
    const { label } = spec;
    const settled = async (id) => {
      if (repair) return null;
      if (!isLoaderInstalled(gameDir, id)) return null;
      const missing = missingInstallerLibraries(id);
      if (missing.length === 0) return id;
      if (!javaPath) { warn(`${label}: ${missing.length} libraries of ${id} are missing and Java is unknown; launching as is.`); return id; }
      if (logger) logger.info(`${label}: ${missing.length} library file(s) of ${id} are missing; running the installer again`);
      try { return await spec.install(mcId, spec.versionOf(id), { signal, onProgress, javaPath, expectedId: id }); } catch (err) {
        if (err && err.code === 'CANCELLED') throw err;
        if (signal && signal.aborted) throw new LoaderError('CANCELLED', 'Установка отменена.');
        warn(`${label}: could not restore libraries of ${id}: ${err && err.message}; launching as is.`);
        return id;
      }
    };
    if (wanted) {
      const have = spec.findInstalledExact(mcId, wanted);
      if (have) { const id = await settled(have); if (id) return id; }
    }
    if (!javaPath) throw new LoaderError('LOADER_FAILED', `Для установки ${label} нужна Java.`);
    const versions = await spec.versions(mcId, signal);
    if (versions.length === 0) throw new LoaderError('LOADER_UNSUPPORTED', spec.noBuildMessage(mcId));
    const version = wanted ? wanted : (versions.find((v) => v.recommended) || versions[0]).id;
    if (wanted && !versions.some((v) => v.id === wanted)) throw new LoaderError('LOADER_UNSUPPORTED', spec.unknownVersionMessage(wanted, mcId));
    const have = spec.findInstalledExact(mcId, version);
    if (have) { const id = await settled(have); if (id) return id; }
    return spec.install(mcId, version, { signal, onProgress, javaPath, expectedId: spec.expectedId(mcId, version) });
  }

  // ------------------------------------------------------------------- Forge
  /** Forge build ids from the Maven index, grouped by Minecraft version: Map<mc, string[]> (newest first). */
  async function forgeIndex(signal) {
    if (forgeListCache && Date.now() - forgeListCache.at < FORGE_LIST_TTL_MS) return forgeListCache.byMc;
    if (forgeIndexFailedAt && Date.now() - forgeIndexFailedAt < 2 * 60 * 1000) throw new LoaderError('LOADER_FAILED', 'Индекс сборок Forge недоступен.');
    let xml;
    try {
      xml = await net.fetchText(FORGE_METADATA, netOpts(FORGE_HOSTS, { signal, maxBytes: 16 * 1024 * 1024, retries: 2 }));
    } catch (err) {
      if (!(err && err.code === 'CANCELLED')) forgeIndexFailedAt = Date.now();
      throw err;
    }
    forgeIndexFailedAt = 0;
    const byMc = new Map();
    for (const m of xml.matchAll(/<version>([^<]{3,80})<\/version>/g)) {
      // "1.20.1-47.3.0" or, for a few old builds, "1.7.10-10.13.4.1614-1.7.10"
      const parts = /^(\d[0-9A-Za-z.]*)-(.+)$/.exec(m[1]);
      if (!parts) continue;
      const mc = parts[1];
      const ver = parts[2].endsWith(`-${mc}`) ? parts[2].slice(0, -(mc.length + 1)) : parts[2];
      if (!LOADER_VERSION_RE.test(ver)) continue;
      if (!byMc.has(mc)) byMc.set(mc, []);
      byMc.get(mc).push(ver);
    }
    for (const list of byMc.values()) list.sort(byVersionDesc);
    forgeListCache = { at: Date.now(), byMc };
    return byMc;
  }

  async function forgeVersions(mcId, signal) {
    const data = await net.fetchJson(FORGE_PROMOS, netOpts(FORGE_HOSTS, { signal }));
    const promos = data && typeof data.promos === 'object' && data.promos ? data.promos : {};
    const ok = (v) => typeof v === 'string' && LOADER_VERSION_RE.test(v);
    const out = [];
    const rec = promos[`${mcId}-recommended`];
    const latest = promos[`${mcId}-latest`];
    if (ok(rec)) out.push({ id: rec, stable: true, recommended: true });
    if (ok(latest) && latest !== rec) out.push({ id: latest, stable: false, recommended: false });
    // Older builds of the same Minecraft version, so any release can be picked. The index is optional.
    try {
      const all = (await forgeIndex(signal)).get(mcId) || [];
      for (const id of all) if (!out.some((v) => v.id === id)) out.push({ id, stable: true, recommended: false });
    } catch (err) {
      if (err && err.code === 'CANCELLED') throw err;
      warn(`Forge build index unavailable (${err && err.message}); only the promoted builds are offered.`);
    }
    return out;
  }

  /** Forge writes "<mc>-forge-<ver>" (and "<mc>-Forge<ver>-<mc>" for a few old builds). Returns <ver> or null. */
  function forgeVersionOfId(id, mcId) {
    const m = new RegExp(`^${escapeRe(mcId)}-forge-?(.+)$`, 'i').exec(id);
    if (!m) return null;
    return m[1].endsWith(`-${mcId}`) ? m[1].slice(0, -(mcId.length + 1)) : m[1];
  }
  function findForgeInstalled(mcId, version) {
    const expected = `${mcId}-forge-${version}`;
    if (isLoaderInstalled(gameDir, expected)) return expected;
    for (const n of listVersionDirs()) {
      if (forgeVersionOfId(n, mcId) === version && isLoaderInstalled(gameDir, n)) return n;
    }
    return null;
  }

  const forgeSpec = {
    label: 'Forge',
    versions: forgeVersions,
    noBuildMessage: (mc) => `Для Minecraft ${mc} нет официальной сборки Forge.`,
    unknownVersionMessage: (v, mc) => `Forge ${v} недоступен для Minecraft ${mc}.`,
    expectedId: (mc, v) => `${mc}-forge-${v}`,
    versionOf: null, // set below (needs mcId)
    findInstalledExact: (mc, v) => findForgeInstalled(mc, v),
    install(mcId, version, { signal, onProgress, javaPath, expectedId }) {
      const full = `${mcId}-${version}`;
      const urls = [`${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`, `${FORGE_MAVEN}/${full}-${mcId}/forge-${full}-${mcId}-installer.jar`];
      return runInstaller({
        label: 'Forge', workName: '.tmp-forge', version, expectedId, urls, hosts: FORGE_HOSTS, javaPath, signal, onProgress,
        matches: (n) => forgeVersionOfId(n, mcId) === version
      });
    }
  };

  // ---------------------------------------------------------------- NeoForge
  async function neoforgeVersions(mcId, signal) {
    const prefix = neoforgeMcPrefix(mcId);
    if (!prefix) return []; // NeoForge only exists for 1.20.2+ and the year-based versions (26.1+)
    const data = await net.fetchJson(NEOFORGE_VERSIONS_API, netOpts(NEOFORGE_HOSTS, { signal }));
    const all = data && Array.isArray(data.versions) ? data.versions : [];
    const newestFirst = all.filter((v) => typeof v === 'string' && v.startsWith(prefix) && LOADER_VERSION_RE.test(v)).sort(byVersionDesc);
    const stableOf = (v) => !/alpha|beta|rc|pre|snapshot/i.test(v);
    // "Recommended" is the newest stable build; when a Minecraft version only has betas, the newest beta.
    const pick = newestFirst.find(stableOf) || newestFirst[0];
    return newestFirst.map((id) => ({ id, stable: stableOf(id), recommended: id === pick }));
  }

  const neoforgeSpec = {
    label: 'NeoForge',
    versions: neoforgeVersions,
    noBuildMessage: (mc) => `Для Minecraft ${mc} нет сборки NeoForge.`,
    unknownVersionMessage: (v, mc) => `NeoForge ${v} недоступен для Minecraft ${mc}.`,
    expectedId: (_mc, v) => `neoforge-${v}`,
    versionOf: (id) => id.replace(/^neoforge-/, ''),
    findInstalledExact: (_mc, v) => (isLoaderInstalled(gameDir, `neoforge-${v}`) ? `neoforge-${v}` : null),
    install(mcId, version, { signal, onProgress, javaPath, expectedId }) {
      return runInstaller({
        label: 'NeoForge', workName: '.tmp-neoforge', version, expectedId,
        urls: [`${NEOFORGE_MAVEN}/${version}/neoforge-${version}-installer.jar`], hosts: NEOFORGE_HOSTS, javaPath, signal, onProgress,
        matches: (n) => /neoforge/i.test(n) && n.includes(version)
      });
    }
  };

  /** Spec bound to one Minecraft version so the repair path can map an id back to a loader version. */
  const bound = (spec, mcId) => ({ ...spec, versionOf: spec.versionOf || ((id) => forgeVersionOfId(id, mcId) || id) });

  return {
    /** [{ id, stable, recommended? }], best first. Throws LoaderError / NetError. */
    async listVersions(loader, mcId, { signal } = {}) {
      checkLoader(loader); checkMc(mcId);
      if (loader === 'fabric' || loader === 'quilt') return profileVersions(loader, mcId, signal);
      if (loader === 'neoforge') return neoforgeVersions(mcId, signal);
      return forgeVersions(mcId, signal);
    },
    /** Newest already-installed loader build for a Minecraft version (for offline play), or null. */
    findInstalled(loader, mcId, loaderVersion = '') {
      try {
        checkLoader(loader); checkMc(mcId);
        const names = fs.readdirSync(versionsDir());
        const found = [];
        for (const n of names) {
          let ver = null;
          if (loader === 'fabric' || loader === 'quilt') {
            const m = new RegExp(`^${PROFILE_LOADERS[loader].idPrefix}-(.+)-${escapeRe(mcId)}$`).exec(n);
            ver = m ? m[1] : null;
          } else if (loader === 'neoforge') {
            const m = /^neoforge-(.+)$/.exec(n);
            ver = m && neoforgeMcPrefix(mcId) && m[1].startsWith(neoforgeMcPrefix(mcId)) ? m[1] : null;
          } else {
            ver = forgeVersionOfId(n, mcId);
          }
          if (ver && isLoaderInstalled(gameDir, n) && (!loaderVersion || ver === loaderVersion)) found.push({ n, ver });
        }
        found.sort((a, b) => a.ver.localeCompare(b.ver, undefined, { numeric: true }));
        return found.length ? found[found.length - 1].n : null;
      } catch { return null; }
    },
    /** Make sure the loader is installed (and its libraries are present); returns the version id to launch. */
    async ensure(loader, mcId, loaderVersion, { signal, onProgress, javaPath, repair = false } = {}) {
      checkLoader(loader); checkMc(mcId); checkLoaderVersion(loaderVersion);
      if (logger) logger.info(`Ensuring ${LABEL[loader]} for Minecraft ${mcId}${loaderVersion ? ` (${loaderVersion})` : ''}`);
      const wanted = loaderVersion || '';
      if (loader === 'fabric' || loader === 'quilt') return installProfileLoader(loader, mcId, wanted, { signal, onProgress, repair });
      const spec = bound(loader === 'neoforge' ? neoforgeSpec : forgeSpec, mcId);
      return installViaInstaller(spec, mcId, wanted, { signal, onProgress, javaPath, repair });
    }
  };
}

module.exports = { createLoaderService, LoaderError, LOADERS, LOADER_VERSION_RE, mavenPath, isLoaderInstalled, neoforgeMcPrefix, defaultRun, MARKER };
