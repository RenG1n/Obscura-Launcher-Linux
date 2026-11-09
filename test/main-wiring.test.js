'use strict';
// Runs src/main/main.js against a fake `electron` module to verify how the app is wired
// (window security flags, trusted URL, IPC channels, hardening hooks) without needing Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { tmp } = require('./helpers');

function runMain() {
  const userData = tmp();
  const created = { windows: [], handlers: new Map(), appHandlers: new Map(), sessionCalls: [], contents: null, quit: 0, lock: 0 };
  class FakeWindow extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; created.windows.push(this); this.webContents = Object.assign(new EventEmitter(), { send() {}, setWindowOpenHandler(fn) { this.openHandler = fn; } }); }
    removeMenu() {} show() {} isDestroyed() { return false; }
    once(ev, fn) { super.once(ev, fn); return this; }
    async loadURL(url) { this.loaded = url; }
  }
  const fakeElectron = {
    app: {
      requestSingleInstanceLock: () => { created.lock++; return true; },
      on: (ev, fn) => created.appHandlers.set(ev, fn),
      whenReady: () => Promise.resolve(),
      getPath: () => userData, getVersion: () => '0.0.0-test', isPackaged: false, quit: () => { created.quit++; }
    },
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (ch, fn) => created.handlers.set(ch, fn) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    session: { defaultSession: { setPermissionRequestHandler: (fn) => created.sessionCalls.push(['request', fn]), setPermissionCheckHandler: (fn) => created.sessionCalls.push(['check', fn]) } },
    shell: { openExternal: () => {}, openPath: async () => '' }
  };
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'electron' ? fakeElectron : originalLoad.call(this, request, ...rest); };
  const mainPath = require.resolve('../src/main/main.js');
  delete require.cache[mainPath];
  try { require(mainPath); } finally { Module._load = originalLoad; }
  return { created, userData, mainPath };
}

test('main.js: secure window options, trusted URL, hardening and IPC wiring', async () => {
  const { created, userData } = runMain();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(created.lock, 1, 'single instance lock requested');
  assert.equal(created.windows.length, 1);
  const win = created.windows[0];
  const wp = win.opts.webPreferences;
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.sandbox, true);
  assert.equal(wp.webSecurity, true);
  assert.equal(wp.allowRunningInsecureContent, false);
  assert.ok(!('enableRemoteModule' in wp) && !wp.nodeIntegrationInWorker && !wp.nodeIntegrationInSubFrames);
  assert.ok(wp.preload.endsWith(path.join('src', 'preload', 'preload.js')) && require('node:fs').existsSync(wp.preload));
  const iconName = process.platform === 'linux' ? 'icon.png' : 'icon.ico';
  assert.ok(win.opts.icon.endsWith(path.join('build', iconName)) && require('node:fs').existsSync(win.opts.icon), 'icon file exists');
  assert.match(win.loaded, /^file:\/\/\/.*\/src\/renderer\/index\.html$/);
  assert.ok(require('node:fs').existsSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html')));

  // every permission request is denied
  const req = created.sessionCalls.find((c) => c[0] === 'request')[1];
  let granted = 'unset'; req(null, 'media', (v) => { granted = v; });
  assert.equal(granted, false);
  assert.equal(created.sessionCalls.find((c) => c[0] === 'check')[1](), false);

  // new windows denied, foreign navigation blocked, webview blocked
  const contents = win.webContents;
  created.appHandlers.get('web-contents-created')({}, contents);
  assert.deepEqual(contents.openHandler({ url: 'https://evil.example' }), { action: 'deny' });
  let prevented = 0;
  contents.emit('will-navigate', { preventDefault: () => prevented++ }, 'https://evil.example/');
  contents.emit('will-attach-webview', { preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  let allowed = 0;
  contents.emit('will-navigate', { preventDefault: () => allowed++ }, win.loaded);
  assert.equal(allowed, 0, 'its own page may reload');

  // IPC surface is exactly what the preload exposes
  const channels = [...created.handlers.keys()].sort();
  const preload = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  const used = [...preload.matchAll(/'((?:settings|system|versions|background|auth|game|errors|loaders|java|builds|modrinth|mrpack|visual):[A-Za-z]+)'/g)].map((m) => m[1]).filter((c) => !['auth:code', 'game:event', 'java:event'].includes(c)); // those are events pushed by main, not requests
  for (const ch of used) assert.ok(channels.includes(ch), `preload uses ${ch} which main handles`);
  for (const ch of channels) assert.ok(used.includes(ch), `main handles ${ch} which preload exposes`);

  // a real call through the registered handler works with the trusted frame and fails without it
  const trusted = { senderFrame: { url: win.loaded, parent: null } };
  const settings = await created.handlers.get('settings:get')(trusted);
  assert.equal(settings.ok, true);
  assert.equal(settings.data.ramGb, 4);
  const denied = await created.handlers.get('settings:get')({ senderFrame: { url: 'file:///C:/evil.html', parent: null } });
  assert.equal(denied.ok, false);
  assert.ok(require('node:fs').existsSync(path.join(userData, 'logs', 'launcher.log')), 'log file created in userData');
});
