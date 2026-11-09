'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Logger, Redactor } = require('../src/main/logger');
const { SettingsStore, validatePatch, sanitize, ValidationError, DEFAULTS } = require('../src/main/settings');
const { getMemoryInfo, validateRam, GB } = require('../src/main/ram');
const java = require('../src/main/java');
const { BackgroundStore, detectImageType, BackgroundError, MAX_BYTES } = require('../src/main/backgrounds');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'obscura-test-'));

// ---------------------------------------------------------------- logger
test('redactor masks registered secrets and token patterns', () => {
  const r = new Redactor();
  r.addSecret('super-secret-access-token-123');
  const out = r.redact('cmd: java --accessToken super-secret-access-token-123 --uuid abc and Bearer abc.def-ghi');
  assert.ok(!out.includes('super-secret'));
  assert.ok(!out.includes('abc.def-ghi'));
  const json = r.redact('{"access_token":"zzzzzzzzzz","refresh_token":"yyyyyyyyyy"}');
  assert.ok(!json.includes('zzzzzzzzzz') && !json.includes('yyyyyyyyyy'));
  const jwt = r.redact('t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk');
  assert.ok(!jwt.includes('eyJhbGci'));
  assert.ok(r.redact('XBL3.0 x=123456;tokenvalue').includes('[REDACTED]'));
});

test('logger writes redacted lines to file', () => {
  const dir = tmp();
  const redactor = new Redactor();
  redactor.addSecret('my-token-value-xyz');
  const log = new Logger({ dir, redactor });
  log.info('launching with my-token-value-xyz now');
  const text = fs.readFileSync(path.join(dir, 'launcher.log'), 'utf8');
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(!text.includes('my-token-value-xyz'));
});

// -------------------------------------------------------------- settings
test('settings validation accepts good and rejects bad values', () => {
  assert.deepEqual(validatePatch({ ramGb: 8, version: '1.21.8', background: 'custom' }), { ramGb: 8, version: '1.21.8', background: 'custom' });
  for (const bad of [
    { ramGb: 1 }, { ramGb: 17 }, { ramGb: 4.5 }, { ramGb: '4' }, { ramGb: NaN },
    { version: '../evil' }, { version: '' }, { version: 'a b' }, { version: 5 },
    { background: 'file:///etc/passwd' }, { javaPath: 'relative/java' }, { javaPath: '/bin/sh' },
    { unknown: 1 }, null, [], 'x'
  ]) {
    assert.throws(() => validatePatch(bad), ValidationError, JSON.stringify(bad));
  }
  assert.equal(validatePatch({ javaPath: '/usr/bin/java' }).javaPath, '/usr/bin/java');
  assert.equal(validatePatch({ javaPath: 'C:\\Program Files\\Java\\bin\\javaw.exe' }).javaPath.slice(-9), 'javaw.exe');
  assert.equal(validatePatch({ javaPath: null }).javaPath, null);
});

test('settings persist across instances and survive corruption', async () => {
  const dir = tmp();
  const a = new SettingsStore(dir);
  await a.load();
  assert.deepEqual(a.get(), DEFAULTS);
  await a.update({ ramGb: 6, version: '1.20.4' });
  const b = new SettingsStore(dir);
  assert.equal((await b.load()).ramGb, 6);
  assert.equal(b.get().version, '1.20.4');

  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
  const c = new SettingsStore(dir);
  assert.deepEqual(await c.load(), DEFAULTS);
  assert.ok(fs.existsSync(path.join(dir, 'settings.json.corrupt')));

  // invalid individual fields fall back, valid ones are kept
  assert.deepEqual(sanitize({ ramGb: 999, version: '1.19.4', background: 'nope' }), { ...DEFAULTS, version: '1.19.4' });
});

test('concurrent settings updates do not corrupt the file', async () => {
  const dir = tmp();
  const s = new SettingsStore(dir);
  await s.load();
  await Promise.all(Array.from({ length: 25 }, (_, i) => s.update({ ramGb: 2 + (i % 10) })));
  const reread = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(reread.ramGb, s.get().ramGb);
});

// ------------------------------------------------------------------- ram
test('RAM validation against real and simulated memory', () => {
  const fake = (total, free) => ({ totalmem: () => total * GB, freemem: () => free * GB });
  const info8 = getMemoryInfo(fake(8, 5));
  assert.equal(info8.maxGb, 7);
  assert.equal(validateRam(4, info8).ok, true);
  assert.equal(validateRam(8, info8).ok, false); // would leave nothing for the OS
  assert.equal(validateRam(1, info8).ok, false);
  assert.equal(validateRam(4.5, info8).ok, false);
  assert.equal(validateRam('4', info8).ok, false);
  const r = validateRam(7, info8);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length >= 1); // >75% total and > free
  assert.equal(validateRam(4, info8, { javaIs64Bit: false }).ok, false);
  const info4 = getMemoryInfo(fake(4, 1));
  assert.equal(info4.maxGb, 3);
  const info64 = getMemoryInfo(fake(64, 40));
  assert.equal(info64.maxGb, 16);
  assert.equal(validateRam(17, info64).ok, false);
  const real = getMemoryInfo();
  assert.ok(real.totalGb > 0 && real.maxGb >= 1);
});

// ------------------------------------------------------------------ java
test('java -version parsing', () => {
  assert.deepEqual(java.parseJavaVersionOutput('openjdk version "21.0.12.1" 2026-08-18\nOpenJDK 64-Bit Server VM'), { version: '21.0.12.1', major: 21, is64Bit: true });
  assert.equal(java.parseJavaVersionOutput('java version "1.8.0_392"\nJava HotSpot(TM) Client VM').major, 8);
  assert.equal(java.parseJavaVersionOutput('java version "1.8.0_392"\nJava HotSpot(TM) Client VM').is64Bit, false);
  assert.equal(java.parseJavaVersionOutput('Picked up JAVA_TOOL_OPTIONS: -Xmx1g\nopenjdk version "17.0.9" 2023-10-17\n64-Bit').major, 17);
  assert.equal(java.parseJavaVersionOutput('openjdk version "21" 2023-09-19').major, 21);
  assert.equal(java.parseJavaVersionOutput('openjdk version "9-ea"').major, 9);
  assert.equal(java.parseJavaVersionOutput('command not found'), null);
  assert.equal(java.parseJavaVersionOutput(''), null);
});

test('java selection rules', () => {
  const mk = (major, p = `/j${major}`, is64Bit = true) => ({ path: p, major, version: String(major), is64Bit });
  const all = [mk(8), mk(17), mk(21)];
  assert.equal(java.pickJava(all, 8).major, 8);
  assert.equal(java.pickJava([mk(17), mk(21)], 8), null); // legacy games must not get Java 17+
  assert.equal(java.pickJava(all, 17).major, 17); // lowest satisfying
  assert.equal(java.pickJava(all, 21).major, 21);
  assert.equal(java.pickJava([mk(17)], 21), null);
  assert.equal(java.pickJava(all, 17, '/j21').major, 21); // explicit preference honoured when usable
  assert.equal(java.pickJava(all, 21, '/j8').major, 21); // ...but never when unusable
});

test('real java detection on this machine, with noisy JAVA_TOOL_OPTIONS banner', async (t) => {
  const found = await java.detectJava();
  if (found.length === 0) { t.skip('на этом компьютере Java не установлена'); return; }
  assert.ok(found.every((j) => Number.isInteger(j.major) && j.major >= 8));
  assert.ok(found.every((j) => j.path));
});

test('java candidate discovery on an in-memory Windows filesystem', () => {
  const w = path.win32;
  const files = new Set([
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4.7-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Java\\jre1.8.0_392\\bin\\java.exe',
    'C:\\Program Files (x86)\\Java\\jre-old\\bin\\java.exe',
    'C:\\Users\\me\\AppData\\Roaming\\.minecraft\\runtime\\java-runtime-delta\\windows-x64\\java-runtime-delta\\bin\\java.exe',
    'C:\\Users\\me\\AppData\\Roaming\\.minecraft\\runtime\\jre-legacy\\windows-x64\\jre-legacy\\bin\\java.exe',
    'D:\\tools\\jdk\\bin\\java.exe',
    'C:\\Windows\\System32\\java.exe'
  ].map((f) => f.toLowerCase()));
  const norm = (p) => w.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
  const dirs = new Set();
  for (const f of files) { let d = w.dirname(f); while (d && !dirs.has(d)) { dirs.add(d); const n = w.dirname(d); if (n === d) break; d = n; } }
  const fakeFs = {
    statSync(p) { const n = norm(p); if (files.has(n)) return { isFile: () => true }; throw new Error('ENOENT'); },
    readdirSync(p) {
      const n = norm(p); if (!dirs.has(n)) throw new Error('ENOENT');
      const seen = new Map();
      for (const d of dirs) if (w.dirname(d) === n && d !== n) seen.set(w.basename(d), true);
      // names must keep original casing for later joins; recover from original strings
      return [...seen.keys()].map((lower) => {
        const orig = [...files].concat([...dirs]).find((x) => w.dirname(x) === n && w.basename(x) === lower);
        return { name: orig ? w.basename(orig) : lower, isDirectory: () => true };
      });
    },
    realpathSync: (p) => p
  };
  const env = {
    JAVA_HOME: 'D:\\tools\\jdk', PATH: 'C:\\Windows\\System32;C:\\nothing', ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'
  };
  const found = java.findCandidates({ platform: 'win32', env, fsImpl: fakeFs });
  const sources = new Map(found.map((c) => [c.path.toLowerCase(), c.source]));
  assert.equal(sources.get('d:\\tools\\jdk\\bin\\java.exe'), 'JAVA_HOME');
  assert.equal(sources.get('c:\\windows\\system32\\java.exe'), 'PATH');
  assert.equal(sources.get('c:\\program files\\eclipse adoptium\\jdk-21.0.4.7-hotspot\\bin\\java.exe'), 'install-dir');
  assert.equal(sources.get('c:\\program files\\java\\jre1.8.0_392\\bin\\java.exe'), 'install-dir');
  assert.equal(sources.get('c:\\program files (x86)\\java\\jre-old\\bin\\java.exe'), 'install-dir');
  assert.equal(sources.get('c:\\users\\me\\appdata\\roaming\\.minecraft\\runtime\\java-runtime-delta\\windows-x64\\java-runtime-delta\\bin\\java.exe'), 'minecraft-launcher');
  assert.equal(sources.get('c:\\users\\me\\appdata\\roaming\\.minecraft\\runtime\\jre-legacy\\windows-x64\\jre-legacy\\bin\\java.exe'), 'minecraft-launcher');
  assert.equal(found.length, 7);
});

// ----------------------------------------------------------- backgrounds
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);

test('background type detection is content-based', () => {
  assert.equal(detectImageType(PNG), 'png');
  assert.equal(detectImageType(JPG), 'jpg');
  assert.equal(detectImageType(WEBP), 'webp');
  assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(detectImageType(Buffer.from('MZ\x90\x00 this is an exe renamed .png ......')), null);
  assert.equal(detectImageType(Buffer.alloc(3)), null);
});

test('background store saves, replaces, loads and removes', async () => {
  const store = new BackgroundStore(tmp());
  assert.equal(await store.loadCustomDataUrl(), null);
  await store.saveCustom(new Uint8Array(PNG));
  assert.match(await store.loadCustomDataUrl(), /^data:image\/png;base64,/);
  await store.saveCustom(JPG.buffer.slice(JPG.byteOffset, JPG.byteOffset + JPG.byteLength)); // ArrayBuffer
  assert.match(await store.loadCustomDataUrl(), /^data:image\/jpeg;base64,/);
  assert.deepEqual(fs.readdirSync(store.dir), ['custom.jpg']); // old png removed
  await assert.rejects(store.saveCustom(Buffer.from('not an image at all, plain text')), BackgroundError);
  await assert.rejects(store.saveCustom(Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)])), BackgroundError);
  await assert.rejects(store.saveCustom('a string'), BackgroundError);
  assert.match(await store.loadCustomDataUrl(), /^data:image\/jpeg/); // failed saves did not clobber
  await store.removeCustom();
  assert.equal(await store.hasCustom(), false);
});
