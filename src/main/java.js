'use strict';
// Java detection and selection. Never uses a shell; executables are invoked
// with execFile and a timeout, and only to print their version.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PROBE_TIMEOUT_MS = 8000;

/**
 * Parse the output of `java -version` (printed to stderr). Tolerates extra lines
 * such as "Picked up JAVA_TOOL_OPTIONS: ...".
 */
function parseJavaVersionOutput(text) {
  const match = /(?:java|openjdk) version "([^"]+)"/i.exec(String(text));
  if (!match) return null;
  const version = match[1];
  let major;
  const legacy = /^1\.(\d+)/.exec(version); // 1.8.0_392 -> 8
  if (legacy) major = Number(legacy[1]);
  else {
    const modern = /^(\d+)/.exec(version); // 17.0.9 / 21 / 9-ea
    if (!modern) return null;
    major = Number(modern[1]);
  }
  const is64Bit = /64-Bit/i.test(text);
  return { version, major, is64Bit };
}

function probeJava(javaPath, { exec = execFile, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      exec(javaPath, ['-version'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        const parsed = parseJavaVersionOutput(`${stderr || ''}\n${stdout || ''}`);
        if (!parsed) return resolve(null);
        resolve({ path: javaPath, ...parsed });
      });
    } catch {
      resolve(null);
    }
  });
}

function exeName(platform) { return platform === 'win32' ? 'java.exe' : 'java'; }

/** Windows environment values often carry stray spaces or surrounding quotes: ` "C:\\Program Files\\x" `. */
function cleanPathValue(value) {
  let v = String(value || '').trim();
  while (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).trim();
  return v;
}

function safeReaddir(dir, fsImpl) {
  try { return fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
function isFile(p, fsImpl) {
  try { return fsImpl.statSync(p).isFile(); } catch { return false; }
}

/** Collect candidate java executables on disk (no execution). Returns [{path, source}]. */
function findCandidates({ platform = process.platform, env = process.env, fsImpl = fs, extraPath = null, extraPaths = [] } = {}) {
  const exe = exeName(platform);
  const sep = platform === 'win32' ? path.win32 : path.posix;
  const out = [];
  const add = (p, source) => { if (isFile(p, fsImpl)) out.push({ path: p, source }); };

  if (extraPath) add(extraPath, 'settings');
  for (const p of extraPaths || []) add(p, 'obscura'); // runtimes downloaded by Obscura itself
  const javaHome = cleanPathValue(env.JAVA_HOME);
  if (javaHome) {
    add(sep.join(javaHome, 'bin', exe), 'JAVA_HOME');
    add(sep.join(javaHome, exe), 'JAVA_HOME'); // JAVA_HOME mistakenly pointing at ...\bin
  }

  const pathDirs = String(env.PATH || env.Path || '').split(sep === path.win32 ? ';' : ':').map(cleanPathValue).filter(Boolean);
  for (const dir of pathDirs) add(sep.join(dir, exe), 'PATH');

  const vendorRoots = [];
  if (platform === 'win32') {
    const pf = [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'];
    for (const base of pf) {
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'AdoptOpenJDK']) {
        vendorRoots.push(sep.join(base, vendor));
      }
    }
    // Per-user installers (Temurin and others can install without admin rights)
    if (env.LOCALAPPDATA) {
      for (const vendor of ['Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'Java']) {
        vendorRoots.push(sep.join(env.LOCALAPPDATA, 'Programs', vendor));
      }
    }
    // JREs bundled by the official Minecraft launcher (classic and Microsoft Store editions)
    const mcRuntime = [];
    if (env.APPDATA) mcRuntime.push(sep.join(env.APPDATA, '.minecraft', 'runtime'));
    if (env.LOCALAPPDATA) {
      mcRuntime.push(sep.join(env.LOCALAPPDATA, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'));
    }
    for (const rt of mcRuntime) {
      // runtime/<component>/<platform>/<component>/bin/java.exe
      for (const comp of safeReaddir(rt, fsImpl)) {
        if (!comp.isDirectory()) continue;
        for (const plat of safeReaddir(sep.join(rt, comp.name), fsImpl)) {
          if (!plat.isDirectory()) continue;
          add(sep.join(rt, comp.name, plat.name, comp.name, 'bin', exe), 'minecraft-launcher');
        }
      }
    }
  } else {
    vendorRoots.push('/usr/lib/jvm', '/usr/lib64/jvm', '/usr/java', '/opt/java', '/opt/jdk', '/Library/Java/JavaVirtualMachines');
    if (env.HOME) {
      // Per-user JDK managers (SDKMAN, IntelliJ downloads) and the JRE bundled by the official Minecraft launcher.
      vendorRoots.push(sep.join(env.HOME, '.sdkman', 'candidates', 'java'), sep.join(env.HOME, '.jdks'));
      const rt = sep.join(env.HOME, '.minecraft', 'runtime'); // runtime/<component>/<platform>/<component>/bin/java
      for (const comp of safeReaddir(rt, fsImpl)) {
        if (!comp.isDirectory()) continue;
        for (const plat of safeReaddir(sep.join(rt, comp.name), fsImpl)) {
          if (!plat.isDirectory()) continue;
          add(sep.join(rt, comp.name, plat.name, comp.name, 'bin', exe), 'minecraft-launcher');
        }
      }
    }
  }
  for (const root of vendorRoots) {
    for (const entry of safeReaddir(root, fsImpl)) {
      if (!entry.isDirectory()) continue;
      add(sep.join(root, entry.name, 'bin', exe), 'install-dir');
      add(sep.join(root, entry.name, 'Contents', 'Home', 'bin', exe), 'install-dir');
    }
  }
  return out;
}

/** Detect usable Java installations. Returns [{path, version, major, is64Bit, source}], newest first. */
async function detectJava(opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const candidates = findCandidates({ ...opts, fsImpl });
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    let key = c.path;
    try { key = fsImpl.realpathSync(c.path); } catch { /* keep path */ }
    if (process.platform === 'win32') key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  const probed = await Promise.all(unique.map(async (c) => {
    const info = await probeJava(c.path, opts);
    return info ? { ...info, source: c.source } : null;
  }));
  return probed.filter(Boolean).sort((a, b) => b.major - a.major);
}

/**
 * Choose a Java for a game version that needs `requiredMajor`.
 *  - Java 8 era games (required <= 8) need exactly 8; newer JVMs break them.
 *  - Otherwise any JVM >= required works; prefer the lowest that satisfies it
 *    (closest to what Mojang tested), and prefer the user's explicit choice.
 */
function pickJava(installs, requiredMajor, preferredPath = null) {
  const ok = (j) => (requiredMajor <= 8 ? j.major === 8 : j.major >= requiredMajor);
  const usable = installs.filter(ok);
  if (usable.length === 0) return null;
  if (preferredPath) {
    const pref = usable.find((j) => j.path === preferredPath);
    if (pref) return pref;
  }
  // Prefer the runtime Obscura itself downloaded from Adoptium over any Java found
  // elsewhere on the system. A years-old system JRE (very common for the Java-8-era
  // requirement) often carries an outdated cacerts/TLS stack: asset and library
  // downloads still work because those go through the launcher's own networking,
  // but anything the *game process* fetches over HTTPS itself — in particular a
  // server-pushed resource/texture pack — can silently fail the TLS handshake and
  // never install, while the rest of the game looks fine. Obscura's managed build
  // is always freshly fetched, so it doesn't have this problem.
  const managed = usable.find((j) => j.source === 'obscura');
  if (managed) return managed;
  return [...usable].sort((a, b) => a.major - b.major || Number(b.is64Bit) - Number(a.is64Bit))[0];
}

module.exports = { parseJavaVersionOutput, probeJava, findCandidates, detectJava, pickJava };
