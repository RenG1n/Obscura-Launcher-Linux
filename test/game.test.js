'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createGameService, isInstalled } = require('../src/main/game');
const { SettingsStore } = require('../src/main/settings');
const { VersionService } = require('../src/main/versions');
const { getMemoryInfo, validateRam, GB } = require('../src/main/ram');
const javaTools = require('../src/main/java');
const { Logger, Redactor } = require('../src/main/logger');
const { AuthError } = require('../src/main/auth');
const { tmp, okFetch, failFetch, fakeChild } = require('./helpers');

const TOKEN = 'ey-secret-access-token-VALUE-123456';

async function setup(opts = {}) {
  const dir = tmp();
  const gameDir = path.join(dir, 'minecraft');
  const settings = new SettingsStore(path.join(dir, 'cfg'));
  await settings.load();
  if (opts.settings) await settings.update(opts.settings);
  const redactor = new Redactor();
  const logger = new Logger({ dir: path.join(dir, 'logs'), redactor });
  const events = [];
  const calls = { install: [], launch: [] };
  const child = fakeChild();
  const installer = opts.installer || {
    async install(meta, gdir) {
      calls.install.push(meta.id);
      const vdir = path.join(gdir, 'versions', meta.id);
      fs.mkdirSync(vdir, { recursive: true });
      fs.writeFileSync(path.join(vdir, `${meta.id}.json`), JSON.stringify(opts.versionJson || { id: meta.id, javaVersion: { majorVersion: 21 } }));
      fs.writeFileSync(path.join(vdir, `${meta.id}.jar`), 'jar');
    }
  };
  const game = createGameService({
    settings,
    versions: new VersionService({ fetchImpl: opts.fetchImpl || okFetch() }),
    auth: opts.auth || { async getSession() { redactor.addSecret(TOKEN); return { accessToken: TOKEN, uuid: 'u'.repeat(32), name: 'Steve' }; } },
    java: { detectJava: async () => opts.javas || [{ path: 'C:\\j21\\bin\\java.exe', version: '21.0.2', major: 21, is64Bit: true }], pickJava: javaTools.pickJava },
    ram: { getMemoryInfo: () => getMemoryInfo({ totalmem: () => (opts.totalGb || 16) * GB, freemem: () => 8 * GB }), validateRam },
    installer,
    launcher: { async launch(args) { calls.launch.push(args); return child; } },
    gameDir, logger, retryDelayMs: 0, installAttempts: opts.installAttempts,
    emit: (e) => events.push(e)
  });
  return { game, events, calls, child, gameDir, settings, logger, dir };
}

test('happy path: resolves alias, installs, launches with validated RAM, never leaks the token', async () => {
  const t = await setup({ settings: { ramGb: 6 } });
  const result = await t.game.play({ version: 'release' });
  assert.deepEqual(result, { version: '1.99.0', pid: 4242 });
  assert.deepEqual(t.calls.install, ['1.99.0']);
  const launch = t.calls.launch[0];
  assert.equal(launch.maxMemoryMb, 6144);
  assert.equal(launch.javaPath, 'C:\\j21\\bin\\java.exe');
  assert.equal(launch.version, '1.99.0');
  assert.equal(launch.session.accessToken, TOKEN);
  assert.ok(isInstalled(t.gameDir, '1.99.0'));
  assert.deepEqual(t.events.filter((e) => e.type === 'status').map((e) => e.phase), ['resolving', 'installing', 'auth', 'java', 'launching', 'running']);

  // Game output containing the token is redacted in the log and never emitted to the UI.
  t.child.stdout.emit('data', Buffer.from(`Setting user: Steve ${TOKEN}\n`));
  t.child.emit('exit', 0);
  const log = fs.readFileSync(path.join(t.dir, 'logs', 'launcher.log'), 'utf8');
  assert.ok(log.includes('[game] Setting user: Steve'));
  assert.ok(!log.includes(TOKEN));
  assert.ok(!JSON.stringify(t.events).includes(TOKEN));
  assert.equal(t.game.state().running, false);
});

test('already installed versions are not downloaded again', async () => {
  const t = await setup();
  await t.game.play({ version: '1.99.0' });
  t.child.emit('exit', 0);
  await t.game.play({ version: '1.99.0' });
  assert.deepEqual(t.calls.install, ['1.99.0']);
  assert.equal(t.calls.launch.length, 2);
});

test('rejects invalid or unknown versions before any install', async () => {
  const t = await setup();
  for (const version of ['../../etc/passwd', '', null, 42, '9.9.9', 'evil']) {
    await assert.rejects(t.game.play({ version }), (e) => ['VALIDATION', 'UNKNOWN_VERSION'].includes(e.code) || e.name === 'ValidationError', String(version));
  }
  assert.equal(t.calls.install.length, 0);
  assert.equal(t.calls.launch.length, 0);
});

test('JAVA_MISSING explains which Java is needed', async () => {
  const t = await setup({ javas: [{ path: 'java', version: '1.8.0_392', major: 8, is64Bit: true }] });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'JAVA_MISSING' && /Java 21/.test(e.message) && /Найдено: 8/.test(e.message));
  assert.equal(t.calls.launch.length, 0);
});

test('versions without javaVersion (pre-1.17) need Java 8', async () => {
  const t = await setup({ versionJson: { id: '1.16.5' }, javas: [{ path: 'j8', version: '1.8.0_392', major: 8, is64Bit: true }, { path: 'j21', version: '21', major: 21, is64Bit: true }] });
  await t.game.play({ version: '1.16.5' });
  assert.equal(t.calls.launch[0].javaPath, 'j8');
});

test('RAM above what the machine can give is refused in the main process', async () => {
  const t = await setup({ settings: { ramGb: 16 }, totalGb: 8 });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'RAM_INVALID' && /8 GB/.test(e.message));
  assert.equal(t.calls.launch.length, 0);
});

test('32-bit Java cannot get more than 1 GB', async () => {
  const t = await setup({ javas: [{ path: 'j', version: '21', major: 21, is64Bit: false }] });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'RAM_INVALID' && /32/.test(e.message));
});

test('LOGIN_REQUIRED stops before Java and launch', async () => {
  const t = await setup({ auth: { async getSession() { throw new AuthError('LOGIN_REQUIRED', 'Войдите.'); } } });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'LOGIN_REQUIRED');
  assert.equal(t.calls.launch.length, 0);
});

test('cancel aborts the install, leaves no "installed" marker, and play works again', async () => {
  let started;
  const startedP = new Promise((r) => { started = r; });
  const installer = {
    install: (meta, gdir, { signal }) => new Promise((_, reject) => {
      fs.mkdirSync(path.join(gdir, 'versions', meta.id), { recursive: true });
      fs.writeFileSync(path.join(gdir, 'versions', meta.id, `${meta.id}.json`), '{}'); // partial install
      started();
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    })
  };
  const t = await setup({ installer });
  const playing = t.game.play({ version: '1.99.0' });
  await startedP;
  assert.equal(t.game.cancel(), true);
  await assert.rejects(playing, (e) => e.code === 'CANCELLED');
  assert.equal(isInstalled(t.gameDir, '1.99.0'), false);
  assert.equal(t.game.state().busy, false);
  assert.equal(t.game.cancel(), false);
});

test('a second Play while preparing or running is refused', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = await setup({
    installer: { install: async (meta, gdir) => {
      await gate;
      fs.mkdirSync(path.join(gdir, 'versions', meta.id), { recursive: true });
      fs.writeFileSync(path.join(gdir, 'versions', meta.id, `${meta.id}.json`), JSON.stringify({ javaVersion: { majorVersion: 21 } }));
      fs.writeFileSync(path.join(gdir, 'versions', meta.id, `${meta.id}.jar`), 'x');
    } }
  });
  const first = t.game.play({ version: '1.99.0' });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'BUSY');
  release();
  await first;
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'RUNNING');
});

test('offline: exact installed versions still launch, aliases report a network error', async () => {
  const online = await setup();
  await online.game.play({ version: '1.99.0' });
  online.child.emit('exit', 0);
  // same gameDir/settings, but the network is gone
  const offlineChild = fakeChild(7);
  const offline = createGameService({
    settings: online.settings,
    versions: new VersionService({ fetchImpl: failFetch }),
    auth: { async getSession() { return { accessToken: TOKEN, uuid: 'u', name: 'Steve' }; } },
    java: { detectJava: async () => [{ path: 'j', version: '21', major: 21, is64Bit: true }], pickJava: javaTools.pickJava },
    ram: { getMemoryInfo: () => getMemoryInfo({ totalmem: () => 16 * GB, freemem: () => 8 * GB }), validateRam },
    installer: { install: async () => { throw new Error('must not install'); } },
    launcher: { launch: async () => offlineChild },
    gameDir: online.gameDir, logger: online.logger, emit: () => {}
  });
  assert.equal((await offline.play({ version: '1.99.0' })).pid, 7);
  offlineChild.emit('exit', 0);
  await assert.rejects(offline.play({ version: 'release' }), (e) => e.code === 'NETWORK');
});

test('install failures are reported without raw secrets and clear the busy flag', async () => {
  const t = await setup({ installer: { install: async () => { throw new Error(`HTTP 500 Bearer ${TOKEN}`); } } });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'INSTALL_FAILED');
  assert.equal(t.game.state().busy, false);
});

function flakyInstaller(failTimes, calls) {
  let n = 0;
  return {
    async install(meta, gdir) {
      calls.push(meta.id);
      if (++n <= failTimes) throw new AggregateError([Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', address: '1.2.3.4', port: 443 })], '');
      const vdir = path.join(gdir, 'versions', meta.id);
      fs.mkdirSync(vdir, { recursive: true });
      fs.writeFileSync(path.join(vdir, `${meta.id}.json`), JSON.stringify({ javaVersion: { majorVersion: 21 } }));
      fs.writeFileSync(path.join(vdir, `${meta.id}.jar`), 'jar');
    }
  };
}

test('a flaky network: install is retried and succeeds on the next attempt', async () => {
  const calls = [];
  const t = await setup({ installer: flakyInstaller(2, calls) });
  const result = await t.game.play({ version: '1.99.0' });
  assert.equal(result.pid, 4242);
  assert.equal(calls.length, 3);
  assert.ok(t.events.some((e) => e.type === 'status' && /повтор 2 из 3/.test(e.message)));
  assert.ok(isInstalled(t.gameDir, '1.99.0'));
});

test('after all attempts fail, the message names the real cause instead of an empty AggregateError', async () => {
  const calls = [];
  const t = await setup({ installer: flakyInstaller(99, calls) });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'INSTALL_FAILED' && /ETIMEDOUT/.test(e.message) && /1\.2\.3\.4/.test(e.message) && /попыток: 3/.test(e.message));
  assert.equal(calls.length, 3);
  const log = fs.readFileSync(path.join(t.dir, 'logs', 'launcher.log'), 'utf8');
  assert.match(log, /Install attempt 3\/3 failed/);
  assert.match(log, /ETIMEDOUT/);
  assert.equal(t.game.state().busy, false);
});

test('cancelling during a failing install does not trigger retries', async () => {
  const calls = [];
  let t;
  const installer = { async install(meta, gdir, { signal }) { calls.push(1); t.game.cancel(); throw new Error('aborted'); } };
  t = await setup({ installer });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'CANCELLED');
  assert.equal(calls.length, 1);
});

test('local authentication mode launches with an offline profile without calling Microsoft auth', async () => {
  let authCalls = 0;
  const t = await setup({
    settings: { authMode: 'local', localUsername: 'Test_Player' },
    auth: { async getSession() { authCalls++; throw new Error('must not be called'); } }
  });
  await t.game.play({ version: '1.99.0' });
  const session = t.calls.launch[0].session;
  assert.equal(authCalls, 0);
  assert.equal(session.name, 'Test_Player');
  assert.equal(session.userType, 'offline');
  assert.equal(session.accessToken, '0');
  assert.match(session.uuid, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  t.child.emit('exit', 0);
});

test('settings reject invalid local profile names', async () => {
  const t = await setup({ settings: { authMode: 'local' } });
  await assert.rejects(t.settings.update({ localUsername: 'bad name' }), /Ник локального профиля/);
  assert.equal(t.calls.launch.length, 0);
});
