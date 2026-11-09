'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createGameService, readRequiredJavaMajor } = require('../src/main/game');
const { SettingsStore } = require('../src/main/settings');
const { VersionService } = require('../src/main/versions');
const { getMemoryInfo, validateRam, GB } = require('../src/main/ram');
const javaTools = require('../src/main/java');
const { Logger, Redactor } = require('../src/main/logger');
const { ErrorReporter } = require('../src/main/errors');
const { tmp, okFetch, fakeChild } = require('./helpers');

const J = (major, p) => ({ path: p || `C:\\j${major}\\bin\\java.exe`, version: `${major}.0.1`, major, is64Bit: true });

async function setup(opts = {}) {
  const dir = tmp();
  const gameDir = path.join(dir, 'minecraft');
  const settings = new SettingsStore(path.join(dir, 'cfg'));
  await settings.load();
  if (opts.settings) await settings.update(opts.settings);
  const logger = new Logger({ dir: path.join(dir, 'logs'), redactor: new Redactor() });
  const reporter = new ErrorReporter({ dir: path.join(dir, 'errors'), logger });
  const events = [];
  const calls = { launch: [], loader: [], runtime: [] };
  const child = fakeChild();
  let javas = opts.javas || [];
  const managed = [];
  const runtime = opts.noRuntime ? null : {
    list: () => managed,
    async install(major, o) {
      calls.runtime.push(major);
      if (opts.runtimeError) throw opts.runtimeError;
      o.onProgress({ major, phase: 'download', percent: 50, message: 'x' });
      const p = `C:\\obscura\\java-${major}\\bin\\java.exe`;
      managed.push({ major, path: p });
      javas = [...javas, J(major, p)];
    }
  };
  const loaders = {
    async ensure(loader, mc, ver, o) {
      calls.loader.push({ loader, mc, ver, java: o.javaPath, repair: o.repair });
      if (opts.loaderError) throw opts.loaderError;
      const id = loader === 'fabric' ? `fabric-loader-0.16.9-${mc}` : `${mc}-forge-47.3.0`;
      const vdir = path.join(gameDir, 'versions', id);
      fs.mkdirSync(vdir, { recursive: true });
      fs.writeFileSync(path.join(vdir, `${id}.json`), JSON.stringify({ id, inheritsFrom: mc, ...(opts.loaderJava ? { javaVersion: { majorVersion: opts.loaderJava } } : {}) }));
      o.onProgress({ percent: 100 });
      return id;
    },
    findInstalled: () => opts.offlineLoader || null
  };
  const game = createGameService({
    settings, reporter, runtime, loaders,
    versions: new VersionService({ fetchImpl: okFetch() }),
    auth: { async getSession() { return { accessToken: 't', uuid: 'u'.repeat(32), name: 'Steve' }; } },
    java: { detectJava: async (o) => { calls.detect = o; return javas; }, pickJava: javaTools.pickJava },
    ram: { getMemoryInfo: () => getMemoryInfo({ totalmem: () => 16 * GB, freemem: () => 8 * GB }), validateRam },
    installer: { async install(meta, gdir) {
      const v = path.join(gdir, 'versions', meta.id); fs.mkdirSync(v, { recursive: true });
      fs.writeFileSync(path.join(v, `${meta.id}.json`), JSON.stringify({ id: meta.id, javaVersion: { majorVersion: opts.vanillaJava || 21 } }));
      fs.writeFileSync(path.join(v, `${meta.id}.jar`), 'jar');
    } },
    launcher: { async launch(a) { calls.launch.push(a); return child; } },
    gameDir, logger, retryDelayMs: 0, emit: (e) => events.push(e)
  });
  return { game, events, calls, gameDir, reporter, dir, settings, child };
}

test('missing Java is downloaded automatically (exact major for the game) and then used', async () => {
  const t = await setup({ javas: [] });
  await t.game.play({ version: '1.99.0' });
  assert.deepEqual(t.calls.runtime, [21]);
  assert.equal(t.calls.launch[0].javaPath, 'C:\\obscura\\java-21\\bin\\java.exe');
  assert.ok(t.events.some((e) => e.type === 'status' && /Скачиваю Java 21/.test(e.message)));
  assert.ok(t.events.some((e) => e.type === 'progress' && e.phase === 'java' && e.percent === 50));
  assert.deepEqual(t.calls.detect.extraPaths, ['C:\\obscura\\java-21\\bin\\java.exe']);
});

test('a suitable Java that is already present is used and nothing is downloaded', async () => {
  const t = await setup({ javas: [J(21)] });
  await t.game.play({ version: '1.99.0' });
  assert.deepEqual(t.calls.runtime, []);
});

test('old games get Java 8, a 17-era game gets 17', async () => {
  const a = await setup({ javas: [J(21)], vanillaJava: 8 });
  await a.game.play({ version: '1.99.0' });
  assert.deepEqual(a.calls.runtime, [8], 'Java 8 games never run on 21');
  const b = await setup({ javas: [], vanillaJava: 17 });
  await b.game.play({ version: '1.99.0' });
  assert.deepEqual(b.calls.runtime, [17]);
});

test('autoJava off: a clear OBS-301 error instead of a download', async () => {
  const t = await setup({ javas: [], settings: { autoJava: false } });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'JAVA_MISSING' && /Автоустановка/.test(e.message));
  assert.deepEqual(t.calls.runtime, []);
  assert.equal(t.reporter.list()[0].code, 'OBS-301');
});

test('Java download failure becomes OBS-310 (or OBS-101/106 for network/checksum causes) and is reported with context', async () => {
  const t = await setup({ javas: [], runtimeError: Object.assign(new Error('boom'), { code: 'JAVA_INSTALL_FAILED' }) });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'JAVA_INSTALL_FAILED');
  assert.equal(t.reporter.list()[0].code, 'OBS-310');
  const net = await setup({ javas: [], runtimeError: Object.assign(new Error('ECONNRESET: соединение прервано.'), { code: 'NET_FAILED' }) });
  await assert.rejects(net.game.play({ version: '1.99.0' }), (e) => e.code === 'JAVA_INSTALL_FAILED');
  assert.equal(net.reporter.list()[0].code, 'OBS-101');
  const sum = await setup({ javas: [], runtimeError: Object.assign(new Error('Контрольная сумма sha256 не совпала'), { code: 'NET_CHECKSUM' }) });
  await assert.rejects(sum.game.play({ version: '1.99.0' }));
  assert.equal(sum.reporter.list()[0].code, 'OBS-106');
  const ext = await setup({ javas: [], runtimeError: Object.assign(new Error('не запускается'), { code: 'JAVA_EXTRACT' }) });
  await assert.rejects(ext.game.play({ version: '1.99.0' }));
  assert.equal(ext.reporter.list()[0].code, 'OBS-311');
});

test('cancelling during the Java download is a cancellation, not an error report', async () => {
  const t = await setup({ javas: [], runtimeError: Object.assign(new Error('x'), { code: 'CANCELLED' }) });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'CANCELLED');
  assert.deepEqual(t.reporter.list(), []);
});

test('Fabric: loader installed after Java, launches the loader version id', async () => {
  const t = await setup({ javas: [J(21)], settings: { loader: 'fabric' } });
  const res = await t.game.play({ version: '1.99.0' });
  assert.equal(res.version, 'fabric-loader-0.16.9-1.99.0');
  assert.equal(t.calls.launch[0].version, 'fabric-loader-0.16.9-1.99.0');
  assert.deepEqual(t.calls.loader.map((c) => [c.loader, c.mc, c.ver, c.java]), [['fabric', '1.99.0', '', 'C:\\j21\\bin\\java.exe']]);
  const phases = t.events.filter((e) => e.type === 'status').map((e) => e.phase);
  assert.ok(phases.indexOf('java') < phases.indexOf('loader') && phases.indexOf('loader') < phases.indexOf('launching'));
});

test('Forge via play input overrides the saved loader; vanilla skips loaders entirely', async () => {
  const t = await setup({ javas: [J(21)] });
  const res = await t.game.play({ version: '1.99.0', loader: 'forge', loaderVersion: '47.3.0' });
  assert.equal(res.version, '1.99.0-forge-47.3.0');
  assert.equal(t.calls.loader[0].ver, '47.3.0');
  const v = await setup({ javas: [J(21)] });
  const r2 = await v.game.play({ version: '1.99.0' });
  assert.equal(r2.version, '1.99.0');
  assert.deepEqual(v.calls.loader, []);
});

test('repair is forwarded to the loader installer', async () => {
  const t = await setup({ javas: [J(21)], settings: { loader: 'fabric' } });
  await t.game.play({ version: '1.99.0', repair: true });
  assert.equal(t.calls.loader[0].repair, true);
});

test('invalid loader input is rejected before anything is downloaded', async () => {
  const t = await setup({ javas: [J(21)] });
  for (const bad of [{ loader: 'bedrock' }, { loader: 'fabric', loaderVersion: '../x' }, { loader: 5 }]) {
    await assert.rejects(t.game.play({ version: '1.99.0', ...bad }), (e) => e.name === 'ValidationError');
  }
  assert.deepEqual(t.calls.runtime, []);
  assert.deepEqual(t.calls.loader, []);
});

test('loader errors are numbered: unsupported OBS-110, failed OBS-111', async () => {
  const a = await setup({ javas: [J(21)], settings: { loader: 'forge' }, loaderError: Object.assign(new Error('нет сборки'), { code: 'LOADER_UNSUPPORTED' }) });
  await assert.rejects(a.game.play({ version: '1.99.0' }));
  assert.equal(a.reporter.list()[0].code, 'OBS-110');
  const b = await setup({ javas: [J(21)], settings: { loader: 'forge' }, loaderError: Object.assign(new Error('Установщик Forge завершился с ошибкой'), { code: 'LOADER_FAILED' }) });
  await assert.rejects(b.game.play({ version: '1.99.0' }));
  assert.equal(b.reporter.list()[0].code, 'OBS-111');
  assert.equal(b.reporter.list()[0].dialog, true);
});

test('offline: when the loader check fails on the network, an installed loader build is launched', async () => {
  const t = await setup({ javas: [J(21)], settings: { loader: 'fabric' }, loaderError: Object.assign(new Error('ENOTFOUND'), { code: 'NET_FAILED' }), offlineLoader: 'fabric-loader-0.15.0-1.99.0' });
  fs.mkdirSync(path.join(t.gameDir, 'versions', 'fabric-loader-0.15.0-1.99.0'), { recursive: true });
  const res = await t.game.play({ version: '1.99.0' });
  assert.equal(res.version, 'fabric-loader-0.15.0-1.99.0');
});

test('a loader that needs a newer Java than the game triggers a second Java check/download', async () => {
  const t = await setup({ javas: [J(17)], vanillaJava: 17, loaderJava: 21, settings: { loader: 'fabric' } });
  await t.game.play({ version: '1.99.0' });
  assert.deepEqual(t.calls.runtime, [21]);
  assert.equal(t.calls.launch[0].javaPath, 'C:\\obscura\\java-21\\bin\\java.exe');
});

test('readRequiredJavaMajor follows inheritsFrom for loader profiles', () => {
  const dir = tmp();
  const w = (id, j) => { fs.mkdirSync(path.join(dir, 'versions', id), { recursive: true }); fs.writeFileSync(path.join(dir, 'versions', id, `${id}.json`), JSON.stringify(j)); };
  w('1.21.1', { javaVersion: { majorVersion: 21 } });
  w('fabric-loader-x-1.21.1', { inheritsFrom: '1.21.1' });
  w('1.8.9', {});
  w('forge-1.8.9', { inheritsFrom: '1.8.9' });
  assert.equal(readRequiredJavaMajor(dir, 'fabric-loader-x-1.21.1'), 21);
  assert.equal(readRequiredJavaMajor(dir, 'forge-1.8.9'), 8);
  assert.equal(readRequiredJavaMajor(dir, 'missing'), 8);
});
