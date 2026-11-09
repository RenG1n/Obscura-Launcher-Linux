'use strict';
// Obscura-managed Java runtimes. Downloads Eclipse Temurin JREs from the
// official Adoptium API into <userData>\runtime\java-<major>, verifies the
// SHA-256 published by Adoptium, unpacks, and proves the result by running
// `java -version`. Works the same for the installed and the portable build.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const net = require('./net');
const { probeJava } = require('./java');

/** Majors offered in the UI: 8 (old games), 17, 21 and 25 (current LTS lines). */
const SUPPORTED_MAJORS = Object.freeze([8, 17, 21, 25]);

const HOSTS = ['api.adoptium.net', 'github.com', '*.githubusercontent.com'];
const LINK_RE = /^https:\/\/github\.com\/adoptium\/temurin\d+-binaries\/releases\/download\/[^?#]+$/;

class RuntimeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

/** Smallest managed major that can run a game needing `required` (Java 8 era games need exactly 8). */
function majorForRequired(required) {
  const r = Number.isInteger(required) && required > 0 ? required : 8;
  if (r <= 8) return 8;
  for (const m of SUPPORTED_MAJORS) if (m >= r && m >= 17) return m;
  return r; // newer than anything listed: ask Adoptium for exactly that feature release
}

function adoptiumTarget(platform = process.platform, arch = process.arch) {
  const osName = { win32: 'windows', linux: 'linux', darwin: 'mac' }[platform];
  const cpu = { x64: 'x64', arm64: 'aarch64' }[arch];
  if (!osName || !cpu) throw new RuntimeError('JAVA_INSTALL_FAILED', `Автоустановка Java не поддерживается на ${platform}/${arch}.`);
  return { os: osName, arch: cpu };
}

function exeName(platform) { return platform === 'win32' ? 'java.exe' : 'java'; }

/** Find <root>/bin/java or <root>/<single-folder>/bin/java (also macOS Contents/Home). */
function findJavaIn(root, { platform = process.platform, fsImpl = fs } = {}) {
  const exe = exeName(platform);
  const isFile = (p) => { try { return fsImpl.statSync(p).isFile(); } catch { return false; } };
  const direct = [path.join(root, 'bin', exe), path.join(root, 'Contents', 'Home', 'bin', exe)];
  for (const p of direct) if (isFile(p)) return p;
  let entries = [];
  try { entries = fsImpl.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    for (const p of [path.join(root, e.name, 'bin', exe), path.join(root, e.name, 'Contents', 'Home', 'bin', exe)]) if (isFile(p)) return p;
  }
  return null;
}

function defaultExtract(archive, destDir, { platform = process.platform, exec = execFile } = {}) {
  const run = (file, args) => new Promise((resolve, reject) => {
    exec(file, args, { timeout: 10 * 60 * 1000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => (err ? reject(new RuntimeError('JAVA_EXTRACT', `Не удалось распаковать Java: ${String(stderr || err.message).slice(0, 300)}`, { cause: err })) : resolve()));
  });
  fs.mkdirSync(destDir, { recursive: true });
  // bsdtar ships with Windows 10 1803+ and unpacks both .zip and .tar.gz; it refuses ".." paths.
  return run('tar', ['-xf', archive, '-C', destDir]).catch(async (err) => {
    if (platform === 'win32' && /\.zip$/i.test(archive)) {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', archive, destDir]);
      return;
    }
    throw err;
  });
}

/** Windows antivirus often holds fresh files for a moment: retry the rename a few times. */
async function moveDir(from, to, sleep) {
  for (let i = 1; ; i++) {
    try { await fs.promises.rename(from, to); return; } catch (err) {
      if (i >= 5 || !/EPERM|EBUSY|EACCES/.test(String(err && err.code))) throw err;
      await sleep(400 * i);
    }
  }
}

class RuntimeManager {
  /**
   * @param {{ dir: string, logger?: any, platform?: string, arch?: string, transport?: any, sleep?: Function,
   *           extract?: Function, probe?: Function, fsImpl?: any, apiBase?: string }} opts
   */
  constructor({ dir, logger = null, platform = process.platform, arch = process.arch, transport, sleep, extract, probe = probeJava, fsImpl = fs, apiBase = 'https://api.adoptium.net' } = {}) {
    this.dir = dir;
    this.logger = logger;
    this.platform = platform;
    this.arch = arch;
    this.transport = transport;
    this.sleep = sleep;
    this.extract = extract || ((a, d) => defaultExtract(a, d, { platform }));
    this.probe = probe;
    this.fs = fsImpl;
    this.apiBase = apiBase;
    this.active = null; // { major, abort }
  }

  _dirFor(major) { return path.join(this.dir, `java-${major}`); }

  /** Installed managed runtimes: [{ major, path }] (fast: no process is started). */
  list() {
    const out = [];
    let names = [];
    try { names = this.fs.readdirSync(this.dir); } catch { return out; }
    for (const name of names) {
      const m = /^java-(\d{1,3})$/.exec(name);
      if (!m) continue;
      const exe = findJavaIn(path.join(this.dir, name), { platform: this.platform, fsImpl: this.fs });
      if (exe) out.push({ major: Number(m[1]), path: exe });
    }
    return out.sort((a, b) => a.major - b.major);
  }

  state() {
    return { active: this.active ? this.active.major : null };
  }

  cancel() {
    if (!this.active) return false;
    this.active.abort.abort();
    return true;
  }

  async _lookup(major, signal) {
    const target = adoptiumTarget(this.platform, this.arch);
    const url = `${this.apiBase}/v3/assets/latest/${major}/hotspot?architecture=${target.arch}&image_type=jre&os=${target.os}&vendor=eclipse`;
    const data = await net.fetchJson(url, { hosts: HOSTS, transport: this.transport, sleep: this.sleep, signal, maxBytes: 4 * 1024 * 1024 });
    const pkg = Array.isArray(data) ? data.map((a) => a && a.binary && a.binary.package).find((p) => p && typeof p.link === 'string') : null;
    if (!pkg) throw new RuntimeError('JAVA_INSTALL_FAILED', `Для Java ${major} на этой системе нет сборки Eclipse Temurin.`);
    if (!LINK_RE.test(pkg.link)) throw new RuntimeError('JAVA_INSTALL_FAILED', 'Adoptium вернул неожиданный адрес загрузки. Установка остановлена ради безопасности.');
    if (typeof pkg.checksum !== 'string' || !/^[0-9a-f]{64}$/i.test(pkg.checksum)) throw new RuntimeError('JAVA_INSTALL_FAILED', 'Adoptium не вернул контрольную сумму SHA-256. Установка остановлена.');
    const ext = /\.zip$/i.test(pkg.link) ? '.zip' : /\.tar\.gz$/i.test(pkg.link) ? '.tar.gz' : null;
    if (!ext) throw new RuntimeError('JAVA_INSTALL_FAILED', 'Неподдерживаемый формат архива Java.');
    return { link: pkg.link, sha256: pkg.checksum.toLowerCase(), ext, size: Number(pkg.size) || 0 };
  }

  /**
   * Download, verify, unpack and test a Temurin JRE. Returns { major, path, version }.
   * Reinstalling replaces the previous copy only after the new one has passed `java -version`.
   */
  async install(major, { signal, onProgress } = {}) {
    if (!SUPPORTED_MAJORS.includes(major) && !(Number.isInteger(major) && major > 25 && major < 100)) {
      throw new RuntimeError('JAVA_INSTALL_FAILED', `Java ${String(major).slice(0, 8)} недоступна для установки.`);
    }
    if (this.active) throw new RuntimeError('BUSY', `Уже устанавливается Java ${this.active.major}.`);
    const abort = new AbortController();
    this.active = { major, abort };
    const forward = () => abort.abort();
    if (signal) { if (signal.aborted) abort.abort(); else signal.addEventListener('abort', forward, { once: true }); }
    const work = path.join(this.dir, `.tmp-java-${major}-${process.pid}`);
    const emit = (phase, percent, message) => { if (onProgress) { try { onProgress({ major, phase, percent, message }); } catch { /* UI gone */ } } };
    try {
      await fs.promises.rm(work, { recursive: true, force: true });
      await fs.promises.mkdir(work, { recursive: true });
      emit('lookup', null, `Ищу Java ${major} (Eclipse Temurin)…`);
      const asset = await this._lookup(major, abort.signal);
      const archive = path.join(work, `jre${asset.ext}`);
      emit('download', 0, `Скачиваю Java ${major}…`);
      await net.downloadFile(asset.link, archive, {
        hosts: HOSTS, transport: this.transport, sleep: this.sleep, signal: abort.signal, sha256: asset.sha256, maxBytes: 400 * 1024 * 1024,
        onProgress: (p) => emit('download', p.percent === null ? null : Math.round(p.percent * 0.85), `Скачиваю Java ${major}…`)
      });
      emit('extract', 88, `Распаковываю Java ${major}…`);
      const unpacked = path.join(work, 'unpacked');
      await this.extract(archive, unpacked);
      if (abort.signal.aborted) throw new net.NetError('CANCELLED', 'Отменено.');
      const exe = findJavaIn(unpacked, { platform: this.platform, fsImpl: this.fs });
      if (!exe) throw new RuntimeError('JAVA_EXTRACT', 'В архиве Java не найден исполняемый файл java. Файлы распакованы неверно.');
      emit('verify', 94, `Проверяю Java ${major}…`);
      const info = await this.probe(exe);
      if (!info) throw new RuntimeError('JAVA_EXTRACT', 'Скачанная Java не запускается (java -version не отработал).');
      if (info.major !== major) throw new RuntimeError('JAVA_EXTRACT', `Скачана Java ${info.major}, ожидалась ${major}.`);
      // Swap into place only now that the new copy is proven good.
      const finalDir = this._dirFor(major);
      const javaHome = path.dirname(path.dirname(exe)); // the folder that contains bin/
      await fs.promises.rm(finalDir, { recursive: true, force: true });
      await moveDir(javaHome, finalDir, this.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))));
      const finalExe = findJavaIn(finalDir, { platform: this.platform, fsImpl: this.fs });
      emit('done', 100, `Java ${major} установлена.`);
      if (this.logger) this.logger.info(`Installed managed Java ${info.version} to ${finalDir}`);
      return { major, path: finalExe, version: info.version };
    } finally {
      if (signal) signal.removeEventListener('abort', forward);
      this.active = null;
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  async remove(major) {
    if (!Number.isInteger(major) || major < 1 || major > 99) throw new RuntimeError('VALIDATION', 'Некорректная версия Java.');
    if (this.active && this.active.major === major) throw new RuntimeError('BUSY', `Java ${major} сейчас устанавливается.`);
    await fs.promises.rm(this._dirFor(major), { recursive: true, force: true });
    return { removed: true };
  }
}

module.exports = { RuntimeManager, RuntimeError, SUPPORTED_MAJORS, majorForRequired, findJavaIn, adoptiumTarget, HOSTS, LINK_RE };
