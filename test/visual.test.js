'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createVisualService, VisualError, SUBDIRS, STATE_FILE } = require('../src/main/visual');
const { SettingsStore, VISUAL_PROFILE } = require('../src/main/settings');
const { createGameService } = require('../src/main/game');
const { registerIpc } = require('../src/main/ipc');
const { Logger } = require('../src/main/logger');
const { tmp } = require('./helpers');

function world({ jars = {}, manifest } = {}) {
  const base = tmp();
  const bundled = path.join(base, 'bundled');
  fs.mkdirSync(bundled, { recursive: true });
  for (const [name, data] of Object.entries(jars)) fs.writeFileSync(path.join(bundled, name), data);
  if (manifest) fs.writeFileSync(path.join(bundled, 'manifest.json'), JSON.stringify(manifest));
  const root = path.join(base, 'visual');
  const apiCalls = [];
  const svc = createVisualService({ root, bundledDir: bundled, installFabricApi: async (o) => { apiCalls.push(o); fs.writeFileSync(path.join(root, 'mods', 'fabric-api-0.1.jar'), 'api'); } });
  return { base, bundled, root, svc, apiCalls, mods: path.join(root, 'mods') };
}

test('the fixed profile is Minecraft 1.21.11 + Fabric with its own folder and the same subfolders as builds', () => {
  assert.deepEqual({ ...VISUAL_PROFILE }, { mcVersion: '1.21.11', loader: 'fabric', loaderVersion: '' });
  const w = world();
  const folder = w.svc.folder();
  assert.equal(folder, w.root);
  for (const sub of SUBDIRS) assert.ok(fs.statSync(path.join(folder, sub)).isDirectory(), sub);
  assert.equal(w.svc.modsFolder(), w.mods);
});

test('prepare copies the shipped jar, installs Fabric API once and is idempotent', async () => {
  const w = world({ jars: { 'visual-1.0.jar': 'MOD' } });
  const r = await w.svc.prepare();
  assert.deepEqual(r.warnings, []);
  assert.equal(fs.readFileSync(path.join(w.mods, 'visual-1.0.jar'), 'utf8'), 'MOD');
  assert.equal(w.apiCalls.length, 1);
  await w.svc.prepare();
  assert.equal(w.apiCalls.length, 1, 'Fabric API is already there');
  assert.deepEqual(fs.readdirSync(w.mods).filter((n) => n.endsWith('.tmp')), []);
});

test('a changed jar is overwritten, a renamed one replaces the old copy, foreign jars are never touched', async () => {
  const w = world({ jars: { 'visual-1.0.jar': 'V1' }, manifest: { fabricApi: false } });
  await w.svc.prepare();
  fs.writeFileSync(path.join(w.mods, 'player-extra.jar'), 'mine');
  fs.writeFileSync(path.join(w.bundled, 'visual-1.0.jar'), 'V1b');
  await w.svc.prepare();
  assert.equal(fs.readFileSync(path.join(w.mods, 'visual-1.0.jar'), 'utf8'), 'V1b');
  fs.rmSync(path.join(w.bundled, 'visual-1.0.jar'));
  fs.writeFileSync(path.join(w.bundled, 'visual-2.0.jar'), 'V2');
  await w.svc.prepare();
  assert.deepEqual(fs.readdirSync(w.mods).sort(), ['player-extra.jar', 'visual-2.0.jar']);
  const state = JSON.parse(fs.readFileSync(path.join(w.root, STATE_FILE), 'utf8'));
  assert.deepEqual(Object.keys(state.managed), ['visual-2.0.jar']);
});

test('no jar yet: a warning, never an error, and Fabric API is not downloaded for nothing', async () => {
  const w = world();
  const r = await w.svc.prepare();
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /не найден/);
  assert.equal(w.apiCalls.length, 0);
  assert.equal(w.svc.info().ready, false);
  fs.writeFileSync(path.join(w.mods, 'dropped-by-hand.jar'), 'x');
  assert.equal(w.svc.info().ready, true, 'a jar put into the folder by hand counts');
  assert.equal((await w.svc.prepare()).warnings.length, 0);
});

test('fabricApi:false in the manifest skips the download; a failing download is only a warning; cancel is an error', async () => {
  const off = world({ jars: { 'm.jar': 'M' }, manifest: { fabricApi: false } });
  assert.deepEqual((await off.svc.prepare()).warnings, []);
  assert.equal(off.apiCalls.length, 0);
  const base = tmp();
  const bundled = path.join(base, 'b'); fs.mkdirSync(bundled); fs.writeFileSync(path.join(bundled, 'm.jar'), 'M');
  const failing = createVisualService({ root: path.join(base, 'v'), bundledDir: bundled, installFabricApi: async () => { throw new Error('offline'); } });
  const r = await failing.prepare();
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Fabric API/);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(failing.prepare({ signal: ac.signal }), (e) => e instanceof VisualError && e.code === 'CANCELLED');
});

test('an unreadable bundled jar or an unwritable mods folder is a coded VISUAL_FAILED error', async () => {
  const w = world({ jars: { 'm.jar': 'M' } });
  fs.mkdirSync(w.mods, { recursive: true });
  fs.mkdirSync(path.join(w.mods, 'm.jar')); // a directory where the jar must go
  await assert.rejects(w.svc.prepare(), (e) => e.code === 'VISUAL_FAILED');
});

test('only plain .jar names are copied: no hidden files, no other extensions', async () => {
  const w = world({ jars: { 'a.jar': 'A', '.hidden.jar': 'H', 'readme.txt': 'T' }, manifest: { fabricApi: false } });
  await w.svc.prepare();
  assert.deepEqual(fs.readdirSync(w.mods), ['a.jar']);
});

// ------------------------------------------------------------------ settings lock
async function settingsStore(initial) {
  const s = new SettingsStore(tmp());
  await s.load();
  if (initial) await s.update(initial);
  return s;
}

test('settings: visualMode defaults to off, is boolean-only and persists', async () => {
  const dir = tmp();
  const s = new SettingsStore(dir); await s.load();
  assert.equal(s.get().visualMode, false);
  await assert.rejects(s.update({ visualMode: 'yes' }), (e) => e.name === 'ValidationError');
  await s.update({ visualMode: true });
  const again = new SettingsStore(dir); await again.load();
  assert.equal(again.get().visualMode, true);
});

test('settings: while the visual mod is on, version and loader cannot be changed; they come back untouched after switching off', async () => {
  const s = await settingsStore({ version: '1.20.4', loader: 'forge', loaderVersion: '49.0.0' });
  await s.update({ visualMode: true });
  for (const patch of [{ version: '1.21.8' }, { loader: 'vanilla' }, { loaderVersion: '' }, { ramGb: 6, version: '1.19.4' }]) {
    await assert.rejects(s.update(patch), (e) => e.name === 'ValidationError' && /визуальный мод/i.test(e.message), JSON.stringify(patch));
  }
  assert.equal((await s.update({ ramGb: 6 })).ramGb, 6, 'other settings stay editable');
  assert.equal((await s.update({ visualMode: true })).visualMode, true);
  const off = await s.update({ visualMode: false });
  assert.deepEqual([off.version, off.loader, off.loaderVersion], ['1.20.4', 'forge', '49.0.0']);
  assert.equal((await s.update({ version: '1.21.8' })).version, '1.21.8');
  const both = await s.update({ visualMode: true });
  assert.equal(both.visualMode, true);
  assert.equal((await s.update({ visualMode: false, version: '1.19.4' })).version, '1.19.4', 'one call may switch off and change');
});

// ------------------------------------------------------------------ game flow
test('play in visual mode: forces 1.21.11 + Fabric whatever the page asks, launches in the visual folder, prepares the mod after the loader', async () => {
  const dir = tmp();
  const gameDir = path.join(dir, 'minecraft');
  const settings = new SettingsStore(path.join(dir, 'cfg')); await settings.load();
  await settings.update({ loader: 'forge', version: '1.20.4' });
  await settings.update({ visualMode: true });
  const order = [];
  const events = [];
  const launches = [];
  const loaderCalls = [];
  const visual = { folder: () => path.join(dir, 'visual'), async prepare() { order.push('visual'); return { warnings: ['нет мода'] }; } };
  const loaders = { async ensure(loader, mc, ver) {
    order.push('loader'); loaderCalls.push({ loader, mc, ver });
    const id = `fabric-loader-0.18.0-${mc}`;
    fs.mkdirSync(path.join(gameDir, 'versions', id), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'versions', id, `${id}.json`), JSON.stringify({ id, inheritsFrom: mc }));
    return id;
  }, findInstalled: () => null };
  const { EventEmitter } = require('node:events');
  const child = Object.assign(new EventEmitter(), { pid: 77, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const game = createGameService({
    settings, visual, loaders, gameDir, logger: new Logger({ dir: null }), emit: (e) => events.push(e),
    versions: { getManifest: async () => ({ manifest: {} }), resolve: (_m, v) => ({ id: v }) },
    auth: { async getSession() { return { accessToken: 't', uuid: 'u'.repeat(32), name: 'Steve' }; } },
    java: { detectJava: async () => [{ path: '/j21/bin/java', version: '21.0.1', major: 21, is64Bit: true }], pickJava: (i) => i[0] },
    ram: { getMemoryInfo: () => ({}), validateRam: () => ({ ok: true, valueGb: 4, warnings: [] }) },
    installer: { async install(meta, gdir) { fs.mkdirSync(path.join(gdir, 'versions', meta.id), { recursive: true }); fs.writeFileSync(path.join(gdir, 'versions', meta.id, `${meta.id}.json`), JSON.stringify({ id: meta.id, javaVersion: { majorVersion: 21 } })); fs.writeFileSync(path.join(gdir, 'versions', meta.id, `${meta.id}.jar`), 'j'); } },
    launcher: { async launch(o) { launches.push(o); return child; } }
  });
  const r = await game.play({ version: '1.8.9', loader: 'vanilla', loaderVersion: '1.2.3' });
  assert.deepEqual(loaderCalls, [{ loader: 'fabric', mc: '1.21.11', ver: '' }]);
  assert.deepEqual(order, ['loader', 'visual']);
  assert.equal(launches[0].gamePath, path.join(dir, 'visual'));
  assert.equal(launches[0].resourcePath, gameDir, 'versions/libraries/assets stay shared');
  assert.equal(launches[0].version, 'fabric-loader-0.18.0-1.21.11');
  assert.equal(r.version, 'fabric-loader-0.18.0-1.21.11');
  assert.ok(events.some((e) => e.type === 'warning' && e.message === 'нет мода'));
  assert.ok(events.some((e) => e.type === 'status' && e.phase === 'running' && /визуальный мод/.test(e.message)));
  assert.equal(settings.get().loader, 'forge', 'the saved choice is untouched');
});

test('play with visual mode off ignores the visual service entirely', async () => {
  // covered by game.test.js (no `visual` dependency at all); here only: a visual-mode launch without the service is a coded error
  const dir = tmp();
  const settings = new SettingsStore(path.join(dir, 'cfg')); await settings.load();
  await settings.update({ visualMode: true });
  const game = createGameService({ settings, gameDir: path.join(dir, 'g'), logger: new Logger({ dir: null }), emit() {}, versions: {}, auth: {}, java: {}, ram: {}, installer: {}, launcher: {} });
  await assert.rejects(game.play({ version: 'release' }), (e) => e.code === 'VISUAL_FAILED');
});

// ------------------------------------------------------------------ ipc
test('ipc: visual:info works, switching the mode while a launch is being prepared is refused, openFolder takes no path', async () => {
  const handlers = new Map();
  const dir = tmp();
  const settings = new SettingsStore(dir); await settings.load();
  let busy = false;
  const opened = [];
  const visual = { info: () => ({ ready: false }), openFolder: async (...a) => opened.push(a) };
  const url = require('node:url').pathToFileURL(path.join(dir, 'index.html')).href;
  registerIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, trustedUrl: url, logger: new Logger({ dir: null }), services: { settings, backgrounds: {}, versions: {}, auth: {}, game: { state: () => ({ busy }) }, system: {}, visual, emitAuthCode() {} } });
  const ev = { senderFrame: { url, parent: null } };
  assert.deepEqual(await handlers.get('visual:info')(ev), { ok: true, data: { ready: false } });
  assert.equal((await handlers.get('settings:update')(ev, { visualMode: true })).data.visualMode, true);
  busy = true;
  const refused = await handlers.get('settings:update')(ev, { visualMode: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'VALIDATION');
  assert.equal(settings.get().visualMode, true);
  assert.equal((await handlers.get('settings:update')(ev, { ramGb: 5 })).ok, true, 'other settings are not affected by the guard');
  busy = false;
  await handlers.get('visual:openFolder')(ev, '/etc');
  assert.deepEqual(opened, [[]], 'the renderer cannot choose what gets opened');
});

// ------------------------------------------------------------------ renderer wiring
test('renderer: every element id the script looks up exists in index.html, and the visual controls are in the Play row', () => {
  const root = path.join(__dirname, '..', 'src', 'renderer');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'scripts', 'renderer.js'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...js.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]).filter((id) => !ids.has(id));
  assert.deepEqual([...new Set(missing)], []);
  const row = /<div class="hero-actions">([\s\S]*?)<div class="launch-progress"/.exec(html)[1];
  for (const id of ['playButton', 'visualToggle', 'openVisualModsButton']) assert.ok(row.includes(`id="${id}"`), `${id} sits in the Play row`);
  assert.match(row, /id="openVisualModsButton"[^>]*\bhidden\b/, 'the visual folder button is hidden until the mode is on');
  assert.ok(row.indexOf('id="visualToggle"') > row.indexOf('id="playButton"'), 'the switch is to the right of Play');
  assert.match(js, /openVisualModsButton\.hidden = !on/);
});

// ------------------------------------------------------------------ the mod that actually ships
test('shipped visual mod (visual-mod/*.jar): compatible with the fixed profile, and Fabric API is not switched off if the mod needs it', async () => {
  const { readEntries, extract } = require('../src/main/zip');
  const dir = path.join(__dirname, '..', 'visual-mod');
  const jars = fs.readdirSync(dir).filter((n) => /\.jar$/i.test(n));
  if (jars.length === 0) return; // no mod added yet: nothing to check
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  for (const name of jars) {
    const buf = fs.readFileSync(path.join(dir, name));
    const entry = readEntries(buf).find((e) => e.name === 'fabric.mod.json');
    assert.ok(entry, `${name}: fabric.mod.json present (it is a Fabric mod)`);
    const mod = JSON.parse(extract(buf, entry).toString('utf8'));
    const deps = mod.depends || {};
    assert.match(String(deps.minecraft || ''), /1\.21(\.11|\.x|\.\*)?/, `${name}: built for Minecraft ${VISUAL_PROFILE.mcVersion}`);
    const javaMin = /(\d+)/.exec(String(deps.java || '0'));
    assert.ok(!javaMin || Number(javaMin[1]) <= 21, `${name}: Java 21 (what 1.21.11 uses) is enough`);
    if (deps['fabric-api'] || deps.fabric) assert.notEqual(manifest.fabricApi, false, `${name} requires Fabric API, so manifest.fabricApi must stay on`);
    assert.notEqual(mod.environment, 'server', `${name}: a client mod`);
  }
  // and the real launcher code carries it into the visual folder byte for byte
  const base = tmp();
  const svc = createVisualService({ root: path.join(base, 'visual'), bundledDir: dir, installFabricApi: async () => { fs.writeFileSync(path.join(base, 'visual', 'mods', 'fabric-api-x.jar'), 'a'); } });
  const r = await svc.prepare();
  assert.deepEqual(r.warnings, []);
  for (const name of jars) assert.deepEqual(fs.readFileSync(path.join(base, 'visual', 'mods', name)), fs.readFileSync(path.join(dir, name)));
  assert.equal(svc.info().ready, true);
});
