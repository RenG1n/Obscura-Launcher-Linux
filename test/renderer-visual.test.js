'use strict';
// Runs the real renderer.js against a tiny fake DOM and a fake window.obscura, to check how the
// visual mod switch drives the page: locked selects, the extra folder button, restoring choices.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class El {
  constructor(id = '') {
    this.id = id; this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this.textContent = '';
    this.children = []; this.handlers = {}; this.dataset = {}; this.attrs = {}; this.props = {};
    this.style = { setProperty: (k, v) => { this.props[k] = v; }, removeProperty: (k) => { delete this.props[k]; }, getPropertyValue: (k) => this.props[k] || '' };
    const set = new Set();
    this.classList = { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c), toggle: (c, f) => { const on = f === undefined ? !set.has(c) : Boolean(f); on ? set.add(c) : set.delete(c); return on; } };
  }
  get options() { return this.children.flatMap((c) => (c.id === 'optgroup' ? c.children : [c])); } // like a real <select>: optgroups are flattened
  get firstChild() { return this.children[0] || null; }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  removeEventListener() {}
  async fire(ev) { for (const fn of this.handlers[ev] || []) await fn({ target: this, preventDefault() {}, stopPropagation() {} }); }
  append(...n) { this.children.push(...n); }
  appendChild(n) { this.children.push(n); return n; }
  replaceChildren(...n) { this.children = [...n]; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute() {}
  querySelector() { return new El(); }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {} click() {} remove() {} showModal() {} close() {} scrollIntoView() {} select() {}
  contains() { return false; }
  getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; }
}

function boot({ settings, versions = ['1.21.11', '1.20.4', '1.19.4'], visualInfo = { ready: true } } = {}) {
  const els = new Map();
  const get = (sel) => { if (!els.has(sel)) els.set(sel, new El(sel)); return els.get(sel); };
  const calls = [];
  let current = { version: 'release', ramGb: 4, background: 'builtin-1', javaPath: null, authMode: 'local', localUsername: 'Player', loader: 'vanilla', loaderVersion: '', autoJava: true, closeLauncherOnGameStart: false, visualMode: false, ...settings };
  const ok = (data) => Promise.resolve({ ok: true, data });
  const noop = () => ok({});
  const handler = { get: (_t, name) => (...a) => { calls.push([name, ...a]); return ok({}); } };
  const obscura = {
    settings: {
      get: () => ok({ ...current }),
      update: (patch) => {
        calls.push(['settings.update', patch]);
        if (current.visualMode && patch.visualMode !== false && ('version' in patch || 'loader' in patch || 'loaderVersion' in patch)) return Promise.resolve({ ok: false, error: { code: 'VALIDATION', message: 'Включён визуальный мод' } });
        current = { ...current, ...patch }; return ok({ ...current });
      }
    },
    system: { info: () => ok({ memory: { minGb: 2, maxGb: 16, totalGb: 32, freeGb: 20 }, java: [], platform: 'linux' }) },
    versions: { list: () => ok({ source: 'network', latest: { release: '1.21.11', snapshot: '26w01a' }, versions: versions.map((id) => ({ id, type: 'release' })) }) },
    background: { get: () => ok({ id: 'builtin-1', dataUrl: null }), select: noop, setCustom: noop, clear: noop },
    auth: { status: () => ok({ loggedIn: false, accounts: [], profile: null, secureStorage: false }), onCode: () => () => {}, login: noop, cancel: noop, logout: noop, select: noop, remove: noop },
    loaders: { list: (l, mc) => { calls.push(['loaders.list', l, mc]); return ok([{ id: '0.18.0', stable: true }]); } },
    java: { list: () => ok({ supported: [8, 17, 21, 25], managed: [], detected: [], active: null, autoJava: true }), install: noop, remove: noop, cancel: noop, onEvent: () => () => {} },
    errors: { list: () => ok([]), openFolder: noop },
    game: { play: (i) => { calls.push(['game.play', i]); return ok({}); }, cancel: noop, state: () => ok({ busy: false, running: false }), openFolder: noop, openModsFolder: noop, onEvent: () => () => {} },
    builds: { list: () => ok([]), create: noop, rename: noop, update: noop, duplicate: noop, delete: noop, openFolder: noop, openModsFolder: noop },
    modrinth: new Proxy({}, handler), mrpack: new Proxy({}, handler),
    visual: { info: () => ok(visualInfo), openFolder: () => { calls.push(['visual.openFolder']); return ok({ opened: true }); } }
  };
  const document = {
    querySelector: get, querySelectorAll: () => [], createElement: (tag) => new El(tag), addEventListener() {}, body: new El('body'), documentElement: new El('html'),
    getElementById: get, activeElement: null, createDocumentFragment: () => new El('frag'), createTextNode: (t) => Object.assign(new El('#text'), { textContent: t })
  };
  const window = { obscura, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), setTimeout, clearTimeout, getComputedStyle: () => ({}) };
  const storage = new Map();
  const ctx = vm.createContext({
    document, window, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise, Date, Math, JSON, Array, Object, Number, String, Boolean, Set, Map, Error, Uint8Array, ArrayBuffer, Intl, RegExp, parseInt, parseFloat, isNaN, encodeURIComponent,
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    navigator: { clipboard: { writeText: async () => {} } }, requestAnimationFrame: (f) => setTimeout(f, 0), FileReader: class {}, Image: class {}, Blob: class {}, getComputedStyle: () => ({}),
    CSS: { escape: (s) => s }, structuredClone: (x) => JSON.parse(JSON.stringify(x))
  });
  ctx.globalThis = ctx;
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'scripts', 'renderer.js'), 'utf8');
  const news = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'scripts', 'news-data.js'), 'utf8');
  vm.runInContext(news, ctx, { filename: 'news-data.js' });
  vm.runInContext(src, ctx, { filename: 'renderer.js' });
  return { get, calls, settings: () => current, ctx };
}
const settle = () => new Promise((r) => setTimeout(r, 80));

test('visual mode off at start: selects are free, the extra folder button is hidden', async () => {
  const p = boot({ settings: { version: '1.20.4', loader: 'fabric' } });
  await settle();
  assert.equal(p.get('#versionSelect').disabled, false);
  assert.equal(p.get('#loaderSelect').disabled, false);
  assert.equal(p.get('#openVisualModsButton').hidden, true);
  assert.equal(p.get('#visualToggle').checked, false);
  assert.equal(p.get('#versionSelect').value, '1.20.4');
});

test('switching on: version and loader are locked to 1.21.11 + Fabric, the folder button appears; switching off restores the old choice', async () => {
  const p = boot({ settings: { version: '1.20.4', loader: 'forge' } });
  await settle();
  const toggle = p.get('#visualToggle');
  toggle.checked = true;
  await toggle.fire('change'); await settle();
  assert.equal(JSON.stringify(p.calls.filter((c) => c[0] === 'settings.update').pop()), JSON.stringify(['settings.update', { visualMode: true }]));
  assert.equal(p.get('#versionSelect').disabled, true);
  assert.equal(p.get('#loaderSelect').disabled, true);
  assert.equal(p.get('#loaderVersionSelect').disabled, true);
  assert.equal(p.get('#versionSelect').value, '1.21.11');
  assert.equal(p.get('#loaderSelect').value, 'fabric');
  assert.equal(p.get('#openVisualModsButton').hidden, false, 'the visual mods folder button shows up');
  assert.equal(p.get('#versionCardStatus').textContent, 'VISUAL');
  assert.equal(p.get('.version-card').classList.contains('visual-locked'), true);

  await p.get('#openVisualModsButton').fire('click');
  assert.ok(p.calls.some((c) => c[0] === 'visual.openFolder'));

  toggle.checked = false;
  await toggle.fire('change'); await settle();
  assert.equal(p.get('#versionSelect').disabled, false, 'versions can be chosen again');
  assert.equal(p.get('#loaderSelect').disabled, false);
  assert.equal(p.get('#openVisualModsButton').hidden, true, 'the folder button hides again');
  assert.equal(p.get('#versionSelect').value, '1.20.4');
  assert.equal(p.get('#loaderSelect').value, 'forge');
  assert.equal(p.get('#versionCardStatus').textContent, 'JAVA');
});

test('the page starts already locked when the mode was saved as on, and does not list loader builds', async () => {
  const p = boot({ settings: { version: '1.20.4', loader: 'forge', visualMode: true } });
  await settle();
  assert.equal(p.get('#visualToggle').checked, true);
  assert.equal(p.get('#versionSelect').disabled, true);
  assert.equal(p.get('#versionSelect').value, '1.21.11');
  assert.equal(p.get('#openVisualModsButton').hidden, false);
  assert.equal(p.calls.filter((c) => c[0] === 'loaders.list').length, 0, 'no loader lookups while Fabric is fixed');
});

test('1.21.11 is offered even when the version list could not be loaded', async () => {
  const p = boot({ settings: { visualMode: true }, versions: ['1.20.4'] });
  await settle();
  assert.equal(p.get('#versionSelect').value, '1.21.11');
  assert.ok(p.get('#versionSelect').options.some((o) => o.value === '1.21.11'));
});

test('a refused switch (backend error) puts the checkbox back', async () => {
  const p = boot({ settings: {} });
  await settle();
  const toggle = p.get('#visualToggle');
  const real = p.ctx.window.obscura.settings.update;
  p.ctx.window.obscura.settings.update = () => Promise.resolve({ ok: false, error: { code: 'VALIDATION', message: 'Дождитесь окончания подготовки' } });
  toggle.checked = true;
  await toggle.fire('change'); await settle();
  assert.equal(toggle.checked, false);
  assert.equal(p.get('#versionSelect').disabled, false);
  p.ctx.window.obscura.settings.update = real;
});
