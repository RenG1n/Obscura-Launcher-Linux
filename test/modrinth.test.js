'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createModrinthService, ModrinthError } = require('../src/main/modrinth');
const { createBuildsService } = require('../src/main/builds');
const { tmp } = require('./helpers');

function transportFor(routes) {
  const calls = [];
  return {
    calls,
    get(url, o, cb) {
      calls.push(url.href);
      const req = new EventEmitter();
      req.destroy = (e) => setImmediate(() => req.emit('error', e));
      setImmediate(() => {
        const r = routes[url.href];
        const res = new PassThrough();
        if (!r) { res.statusCode = 404; res.headers = {}; cb(res); res.end(''); return; }
        res.statusCode = 200;
        const body = typeof r === 'string' ? r : JSON.stringify(r);
        res.headers = { 'content-length': String(Buffer.byteLength(body)) };
        cb(res); res.end(body);
      });
      return req;
    }
  };
}
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sleep = () => Promise.resolve();

function searchUrl({ query = '', facets, limit = 20, offset = 0, index }) {
  const url = new URL('https://api.modrinth.com/v2/search');
  url.searchParams.set('query', query);
  url.searchParams.set('facets', JSON.stringify(facets));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('index', index);
  return url.href;
}
function versionsUrl(projectId, mcVersion, loader) {
  const url = new URL(`https://api.modrinth.com/v2/project/${projectId}/version`);
  if (loader) url.searchParams.set('loaders', JSON.stringify([loader]));
  url.searchParams.set('game_versions', JSON.stringify([mcVersion]));
  return url.href;
}
function fileEntry(name) {
  const body = `jar:${name}`;
  return { body, file: { url: `https://cdn.modrinth.com/${name}`, filename: name, primary: true, hashes: { sha1: sha1(body) }, size: body.length } };
}

function setup({ mcVersion = '1.21.1', loader = 'fabric', resolveVersion } = {}) {
  const gameDir = tmp();
  const builds = createBuildsService({ root: path.join(gameDir, 'builds') });
  const build = builds.create({ name: 'Test', mcVersion, loader });
  const routes = {};
  const transport = transportFor(routes);
  const svc = createModrinthService({ builds, transport, sleep, resolveVersion });
  return { gameDir, builds, build, routes, transport, svc };
}

test('search: builds facets for mc version + loader and maps hits', async () => {
  const { routes, svc } = setup();
  routes[searchUrl({ query: 'sodium', facets: [['project_type:mod'], ['versions:1.21.1'], ['categories:fabric'], ['client_side:required', 'client_side:optional']], limit: 20, offset: 0, index: 'relevance' })] = {
    total_hits: 1,
    hits: [{ project_id: 'AANobbMI', slug: 'sodium', title: 'Sodium', description: 'Fast', icon_url: 'https://x/icon.png', downloads: 5, author: 'jellysquid', categories: ['optimization'] }]
  };
  const result = await svc.search({ query: 'sodium', mcVersion: '1.21.1', loader: 'fabric' });
  assert.equal(result.total, 1);
  assert.deepEqual(result.hits[0], { projectId: 'AANobbMI', slug: 'sodium', title: 'Sodium', description: 'Fast', iconUrl: 'https://x/icon.png', downloads: 5, author: 'jellysquid', categories: ['optimization'] });
});

test('addMod: downloads the primary file, writes the manifest, skips an already-installed project', async () => {
  const { gameDir, build, routes, svc } = setup();
  const main = fileEntry('sodium-0.5.jar');
  routes[versionsUrl('sodium', build.mcVersion, 'fabric')] = [
    { id: 'v1', name: 'Sodium 0.5', version_number: '0.5', date_published: '2026-01-01', dependencies: [], files: [main.file] }
  ];
  routes[main.file.url] = main.body;

  const installed = await svc.addMod({ buildId: build.id, projectId: 'sodium' });
  assert.deepEqual(installed.map((m) => m.filename), ['sodium-0.5.jar']);
  const modsDir = path.join(gameDir, 'builds', build.id, 'mods');
  assert.ok(fs.existsSync(path.join(modsDir, 'sodium-0.5.jar')));
  const manifest = JSON.parse(fs.readFileSync(path.join(modsDir, '..', '.obscura-mods.json'), 'utf8'));
  assert.equal(manifest['sodium-0.5.jar'].projectId, 'sodium');

  // second call for the same project: nothing new installed
  const again = await svc.addMod({ buildId: build.id, projectId: 'sodium' });
  assert.deepEqual(again, []);
});

test('addMod: pulls in required dependencies but not optional ones', async () => {
  const { gameDir, build, routes, svc } = setup();
  const core = fileEntry('mymod-1.0.jar');
  const lib = fileEntry('fabric-api-0.1.jar');
  const opt = fileEntry('optional-lib-1.0.jar');
  routes[versionsUrl('mymod', build.mcVersion, 'fabric')] = [
    { id: 'v1', name: 'MyMod 1.0', version_number: '1.0', date_published: '2026-01-01', files: [core.file],
      dependencies: [{ project_id: 'fabric-api', version_id: null, dependency_type: 'required' }, { project_id: 'opt-lib', version_id: null, dependency_type: 'optional' }] }
  ];
  routes[versionsUrl('fabric-api', build.mcVersion, 'fabric')] = [
    { id: 'v2', name: 'Fabric API', version_number: '0.1', date_published: '2026-01-01', files: [lib.file], dependencies: [] }
  ];
  routes[core.file.url] = core.body;
  routes[lib.file.url] = lib.body;
  routes[opt.file.url] = opt.body; // must never be requested

  const installed = await svc.addMod({ buildId: build.id, projectId: 'mymod' });
  assert.deepEqual(installed.map((m) => m.filename).sort(), ['fabric-api-0.1.jar', 'mymod-1.0.jar']);
  assert.ok(!fs.existsSync(path.join(gameDir, 'builds', build.id, 'mods', 'optional-lib-1.0.jar')));
});

test('addMod: a dependency cycle is bounded, not an infinite loop', async () => {
  const { build, routes, svc } = setup();
  const a = fileEntry('a.jar');
  const b = fileEntry('b.jar');
  routes[versionsUrl('a', build.mcVersion, 'fabric')] = [{ id: 'va', name: 'A', version_number: '1', date_published: '', files: [a.file], dependencies: [{ project_id: 'b', version_id: null, dependency_type: 'required' }] }];
  routes[versionsUrl('b', build.mcVersion, 'fabric')] = [{ id: 'vb', name: 'B', version_number: '1', date_published: '', files: [b.file], dependencies: [{ project_id: 'a', version_id: null, dependency_type: 'required' }] }];
  routes[a.file.url] = a.body;
  routes[b.file.url] = b.body;
  const installed = await svc.addMod({ buildId: build.id, projectId: 'a' });
  assert.deepEqual(installed.map((m) => m.filename).sort(), ['a.jar', 'b.jar']);
});

test('addMod: no compatible version is a coded error; tampered file is rejected', async () => {
  const { build, routes, svc } = setup();
  routes[versionsUrl('nope', build.mcVersion, 'fabric')] = [];
  await assert.rejects(svc.addMod({ buildId: build.id, projectId: 'nope' }), (e) => e.code === 'MODRINTH_UNSUPPORTED');

  const bad = fileEntry('bad.jar');
  routes[versionsUrl('badmod', build.mcVersion, 'fabric')] = [{ id: 'v1', name: 'Bad', version_number: '1', date_published: '', files: [{ ...bad.file, hashes: { sha1: 'f'.repeat(40) } }], dependencies: [] }];
  routes[bad.file.url] = bad.body;
  await assert.rejects(svc.addMod({ buildId: build.id, projectId: 'badmod' }), (e) => e.code === 'NET_CHECKSUM');
});

test('addMod: rejects a vanilla build (no loader to install mods for)', async () => {
  const { builds, svc } = setup();
  const vanilla = builds.create({ name: 'Vanilla', mcVersion: '1.21.1', loader: 'vanilla' });
  await assert.rejects(svc.addMod({ buildId: vanilla.id, projectId: 'sodium' }), (e) => e.code === 'VALIDATION');
});

test('listInstalled: drops manifest entries whose file was deleted outside the launcher', async () => {
  const { gameDir, build, routes, svc } = setup();
  const main = fileEntry('sodium-0.5.jar');
  routes[versionsUrl('sodium', build.mcVersion, 'fabric')] = [{ id: 'v1', name: 'Sodium', version_number: '0.5', date_published: '', files: [main.file], dependencies: [] }];
  routes[main.file.url] = main.body;
  await svc.addMod({ buildId: build.id, projectId: 'sodium' });
  assert.equal(svc.listInstalled(build.id).length, 1);
  fs.rmSync(path.join(gameDir, 'builds', build.id, 'mods', 'sodium-0.5.jar'));
  assert.deepEqual(svc.listInstalled(build.id), []);
});

test('removeMod: deletes the file and the manifest entry; refuses path traversal', async () => {
  const { gameDir, build, routes, svc } = setup();
  const main = fileEntry('sodium-0.5.jar');
  routes[versionsUrl('sodium', build.mcVersion, 'fabric')] = [{ id: 'v1', name: 'Sodium', version_number: '0.5', date_published: '', files: [main.file], dependencies: [] }];
  routes[main.file.url] = main.body;
  await svc.addMod({ buildId: build.id, projectId: 'sodium' });
  await assert.rejects(async () => svc.removeMod(build.id, '../../evil'), (e) => e.code === 'VALIDATION');
  svc.removeMod(build.id, 'sodium-0.5.jar');
  assert.ok(!fs.existsSync(path.join(gameDir, 'builds', build.id, 'mods', 'sodium-0.5.jar')));
  assert.deepEqual(svc.listInstalled(build.id), []);
});

const CLIENT = ['client_side:required', 'client_side:optional'];
const hit = (id, title, extra = {}) => ({ project_id: id, slug: id, title, description: `${title} desc`, icon_url: null, downloads: 10, author: 'a', categories: ['fabric', 'optimization'], display_categories: ['optimization'], ...extra });

test('browse: a Fabric build only asks for Fabric mods of its own Minecraft version, popular first, paged', async () => {
  const { routes, build, svc, transport } = setup({ mcVersion: '1.20.4', loader: 'fabric' });
  routes[searchUrl({ facets: [['project_type:mod'], ['versions:1.20.4'], ['categories:fabric'], CLIENT], limit: 12, offset: 24, index: 'downloads' })] = { total_hits: 100, hits: [hit('sodium', 'Sodium')] };
  const r = await svc.browse({ buildId: build.id, page: 3 });
  assert.equal(r.loader, 'fabric');
  assert.equal(r.mcVersion, '1.20.4');
  assert.equal(r.page, 3);
  assert.equal(r.pages, 9); // ceil(100 / 12)
  assert.equal(r.hits[0].title, 'Sodium');
  assert.deepEqual(r.hits[0].categories, ['optimization']);
  assert.ok(transport.calls.every((u) => !u.includes('forge')));
});

test('browse: a Forge build only sees Forge mods; category, sort and search text are passed through', async () => {
  const { routes, build, svc } = setup({ mcVersion: '1.20.1', loader: 'forge' });
  routes[searchUrl({ query: 'jei', facets: [['project_type:mod'], ['versions:1.20.1'], ['categories:forge'], ['categories:utility'], CLIENT], limit: 12, offset: 0, index: 'newest' })] = { total_hits: 1, hits: [hit('jei', 'JEI', { categories: ['forge'] })] };
  const r = await svc.browse({ buildId: build.id, query: ' jei ', category: 'utility', sort: 'newest' });
  assert.equal(r.hits[0].projectId, 'jei');
  assert.equal(r.pages, 1);
});

test('browse: "relevance" without a query falls back to popularity; a query keeps relevance', async () => {
  const { routes, build, svc } = setup();
  routes[searchUrl({ facets: [['project_type:mod'], ['versions:1.21.1'], ['categories:fabric'], CLIENT], limit: 12, offset: 0, index: 'downloads' })] = { total_hits: 0, hits: [] };
  routes[searchUrl({ query: 'x', facets: [['project_type:mod'], ['versions:1.21.1'], ['categories:fabric'], CLIENT], limit: 12, offset: 0, index: 'relevance' })] = { total_hits: 0, hits: [] };
  await svc.browse({ buildId: build.id, sort: 'relevance' });
  await svc.browse({ buildId: build.id, query: 'x', sort: 'relevance' });
});

test('browse: a Quilt build also sees Fabric mods (Quilt runs them)', async () => {
  const { routes, build, svc } = setup({ loader: 'quilt' });
  routes[searchUrl({ facets: [['project_type:mod'], ['versions:1.21.1'], ['categories:quilt', 'categories:fabric'], CLIENT], limit: 12, offset: 0, index: 'downloads' })] = { total_hits: 1, hits: [hit('lithium', 'Lithium')] };
  assert.equal((await svc.browse({ buildId: build.id })).hits[0].title, 'Lithium');
});

test('browse: marks mods that are already installed', async () => {
  const { routes, build, svc } = setup();
  const main = fileEntry('sodium-0.5.jar');
  routes[versionsUrl('sodium', build.mcVersion, 'fabric')] = [{ id: 'v1', name: 'S', version_number: '1', date_published: '', files: [main.file], dependencies: [] }];
  routes[main.file.url] = main.body;
  await svc.addMod({ buildId: build.id, projectId: 'sodium' });
  routes[searchUrl({ facets: [['project_type:mod'], ['versions:1.21.1'], ['categories:fabric'], CLIENT], limit: 12, offset: 0, index: 'downloads' })] = { total_hits: 2, hits: [hit('sodium', 'Sodium'), hit('lithium', 'Lithium')] };
  const r = await svc.browse({ buildId: build.id });
  assert.deepEqual(r.hits.map((h) => h.installed), [true, false]);
});

test('browse: "latest release" builds resolve to the real Minecraft version, for browsing and installing', async () => {
  const { routes, build, builds, svc } = setup({ mcVersion: 'release', resolveVersion: async () => '1.21.4' });
  assert.equal(build.mcVersion, 'release');
  routes[searchUrl({ facets: [['project_type:mod'], ['versions:1.21.4'], ['categories:fabric'], CLIENT], limit: 12, offset: 0, index: 'downloads' })] = { total_hits: 0, hits: [] };
  assert.equal((await svc.browse({ buildId: build.id })).mcVersion, '1.21.4');
  const main = fileEntry('m.jar');
  routes[versionsUrl('m', '1.21.4', 'fabric')] = [{ id: 'v1', name: 'M', version_number: '1', date_published: '', files: [main.file], dependencies: [] }];
  routes[main.file.url] = main.body;
  assert.equal((await svc.addMod({ buildId: build.id, projectId: 'm' })).length, 1);
  assert.ok(builds.get(build.id));
});

test('browse: validation — vanilla build, unknown category / sort, huge query, absurd page', async () => {
  const { builds, build, routes, svc } = setup();
  const vanilla = builds.create({ name: 'V', mcVersion: '1.21.1', loader: 'vanilla' });
  await assert.rejects(svc.browse({ buildId: vanilla.id }), (e) => e.code === 'VALIDATION');
  await assert.rejects(svc.browse({ buildId: build.id, category: 'x" OR 1=1' }), (e) => e.code === 'VALIDATION');
  await assert.rejects(svc.browse({ buildId: build.id, sort: 'random' }), (e) => e.code === 'VALIDATION');
  await assert.rejects(svc.browse({ buildId: build.id, query: 'a'.repeat(101) }), (e) => e.code === 'VALIDATION');
  routes[searchUrl({ facets: [['project_type:mod'], ['versions:1.21.1'], ['categories:fabric'], CLIENT], limit: 12, offset: 9984, index: 'downloads' })] = { total_hits: 99999, hits: [] };
  const r = await svc.browse({ buildId: build.id, page: 1e9 });
  assert.equal(r.page, 833); // capped by Modrinth's 10 000-result window
});
