'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { registerIpc } = require('../src/main/ipc');
const { SettingsStore } = require('../src/main/settings');
const { BackgroundStore } = require('../src/main/backgrounds');
const { Logger } = require('../src/main/logger');
const { tmp } = require('./helpers');

const TRUSTED = pathToFileURL(path.join(tmp(), 'renderer', 'index.html')).href;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

async function setup(extra = {}) {
  const dir = tmp();
  const handlers = new Map();
  const settings = new SettingsStore(dir);
  await settings.load();
  const logger = new Logger({ dir: null });
  const game = { async play(i) { return { echoed: i }; }, cancel: () => false, state: () => ({ busy: false }) };
  const channels = registerIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    trustedUrl: TRUSTED,
    logger,
    services: {
      settings, backgrounds: new BackgroundStore(path.join(dir, 'bg')),
      versions: { getManifest: async () => { throw new Error('secret stack /home/user/x'); } },
      auth: { status: () => ({ loggedIn: false }) }, game, system: {}, emitAuthCode: () => {}, ...extra
    }
  });
  const good = { senderFrame: { url: TRUSTED, parent: null } };
  const call = (ch, ev, ...args) => handlers.get(ch)(ev, ...args);
  return { channels, call, good, handlers };
}

test('only the documented channels are registered', async () => {
  const { channels } = await setup();
  assert.deepEqual(channels.sort(), [
    'auth:cancel', 'auth:login', 'auth:logout', 'auth:remove', 'auth:select', 'auth:status',
    'background:clear', 'background:get', 'background:select', 'background:setCustom',
    'builds:create', 'builds:delete', 'builds:duplicate', 'builds:list', 'builds:openFolder', 'builds:openModsFolder', 'builds:rename', 'builds:update',
    'errors:list', 'errors:openFolder',
    'game:cancel', 'game:openFolder', 'game:openModsFolder', 'game:play', 'game:state',
    'java:cancel', 'java:install', 'java:list', 'java:remove', 'loaders:list',
    'modrinth:addMod', 'modrinth:browse', 'modrinth:listInstalled', 'modrinth:removeMod', 'modrinth:search',
    'mrpack:importFile', 'mrpack:importUrl',
    'settings:get', 'settings:update', 'system:info', 'versions:list',
    'visual:info', 'visual:openFolder'
  ]);
});

test('calls from other pages, subframes or missing frames are rejected', async () => {
  const { call, handlers } = await setup();
  for (const ev of [
    { senderFrame: { url: 'https://evil.example/index.html', parent: null } },
    { senderFrame: { url: TRUSTED, parent: {} } },
    { senderFrame: { url: 'file:///other/index.html', parent: null } },
    {}, null
  ]) {
    for (const ch of handlers.keys()) {
      const res = await call(ch, ev);
      assert.equal(res.ok, false);
      assert.equal(res.error.code, 'FORBIDDEN');
    }
  }
});

test('settings:update validates and persists; bad input returns a coded error', async () => {
  const { call, good } = await setup();
  assert.deepEqual((await call('settings:update', good, { ramGb: 8 })).data.ramGb, 8);
  assert.equal((await call('settings:get', good)).data.ramGb, 8);
  for (const bad of [{ ramGb: 999 }, { ramGb: '8' }, { version: '../x' }, { javaPath: 'rm -rf' }, { hack: 1 }, null, 'x']) {
    const res = await call('settings:update', good, bad);
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.error.code, 'VALIDATION');
  }
  assert.equal((await call('settings:get', good)).data.ramGb, 8);
});

test('unexpected errors never leak messages or stacks to the renderer', async () => {
  const { call, good } = await setup();
  const res = await call('versions:list', good);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'INTERNAL');
  assert.ok(!/secret|home/.test(res.error.message));
});

test('background:setCustom only accepts real images and persists the choice', async () => {
  const { call, good } = await setup();
  assert.equal((await call('background:setCustom', good, 'string')).ok, false);
  assert.equal((await call('background:setCustom', good, new Uint8Array(Buffer.from('<svg onload=alert(1)>'.repeat(5))))).ok, false);
  const ok = await call('background:setCustom', good, new Uint8Array(PNG));
  assert.equal(ok.ok, true);
  assert.match(ok.data.dataUrl, /^data:image\/png;base64,/);
  const state = await call('background:get', good);
  assert.equal(state.data.id, 'custom');
  assert.equal((await call('background:select', good, 'nope')).ok, false);
  assert.equal((await call('background:select', good, 'builtin-2')).ok, true);
});

test('game:play forwards only the whitelisted fields', async () => {
  const { call, good } = await setup();
  const res = await call('game:play', good, { version: 'release', repair: true, javaPath: 'C:/evil.exe', args: ['-x'] });
  assert.deepEqual(res.data.echoed, { version: 'release', repair: true });
  assert.equal((await call('game:play', good, 'x')).ok, false);
});

test('background:clear removes the custom image and returns to a built-in background', async () => {
  const { call, good } = await setup();
  await call('background:setCustom', good, new Uint8Array(PNG));
  assert.equal((await call('background:get', good)).data.id, 'custom');
  const res = await call('background:clear', good);
  assert.deepEqual(res.data, { id: 'builtin-1', dataUrl: null });
  assert.equal((await call('background:get', good)).data.id, 'builtin-1');
  assert.equal((await call('background:select', good, 'custom')).ok, false, 'custom is unavailable once cleared');
});

test('java and loader channels validate input, forward whitelisted fields, and never expose paths', async () => {
  const dir = tmp();
  const handlers = new Map();
  const settings = new SettingsStore(dir); await settings.load();
  const seen = {};
  const channels = registerIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, trustedUrl: TRUSTED, logger: new Logger({ dir: null }),
    services: {
      settings, backgrounds: new BackgroundStore(path.join(dir, 'bg')), versions: {}, auth: {}, system: {}, emitAuthCode: () => {},
      game: { async play(i) { seen.play = i; return {}; }, cancel: () => false, state: () => ({}) },
      loaders: { async listVersions(l, v) { seen.list = [l, v]; return [{ id: '1', stable: true }]; } },
      javaManager: { async info() { return { supported: [8, 17, 21, 25], managed: [], detected: [] }; }, async install(m) { seen.install = m; return { major: m }; }, async remove(m) { seen.remove = m; return { removed: true }; }, cancel: () => true }
    }
  });
  assert.ok(channels.includes('java:install'));
  const good = { senderFrame: { url: TRUSTED, parent: null } };
  const call = (ch, ...a) => handlers.get(ch)(good, ...a);
  assert.equal((await call('loaders:list', 'fabric', '1.21.1')).ok, true);
  assert.deepEqual(seen.list, ['fabric', '1.21.1']);
  assert.equal((await call('loaders:list', 5, '1.21.1')).error.code, 'VALIDATION');
  assert.equal((await call('java:install', 21)).ok, true);
  assert.equal(seen.install, 21);
  for (const bad of ['21', 21.5, null, {}, [21]]) assert.equal((await call('java:install', bad)).error.code, 'VALIDATION', String(bad));
  for (const bad of ['../x', null]) assert.equal((await call('java:remove', bad)).error.code, 'VALIDATION');
  assert.equal((await call('java:cancel')).data.cancelled, true);
  await call('game:play', { version: '1.21.1', loader: 'fabric', loaderVersion: '0.16.9', javaPath: 'C:/evil.exe' });
  assert.deepEqual(seen.play, { version: '1.21.1', repair: false, loader: 'fabric', loaderVersion: '0.16.9' });
});

test('modrinth:browse forwards only the catalog fields and shows Modrinth errors readably', async () => {
  const { ModrinthError } = require('../src/main/modrinth');
  const seen = [];
  const modrinth = {
    browse: async (input) => { seen.push(input); if (input.query === 'boom') throw new ModrinthError('MODRINTH_UNSUPPORTED', 'Нет версии для этой сборки.'); return { hits: [] }; }
  };
  const { call, good } = await setup({ modrinth });
  assert.equal((await call('modrinth:browse', good, { buildId: 'b-1', query: 'x', category: 'magic', sort: 'newest', page: 2, pageSize: 12, evil: 1 })).ok, true);
  assert.deepEqual(seen[0], { buildId: 'b-1', query: 'x', category: 'magic', sort: 'newest', page: 2, pageSize: 12 });
  for (const bad of [null, 'x', {}, { buildId: 5 }]) assert.equal((await call('modrinth:browse', good, bad)).error.code, 'VALIDATION');
  const res = await call('modrinth:browse', good, { buildId: 'b-1', query: 'boom' });
  assert.equal(res.error.code, 'MODRINTH_UNSUPPORTED');
  assert.equal(res.error.message, 'Нет версии для этой сборки.');
});
