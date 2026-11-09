'use strict';
// Behaviour added in 1.1.0: year-based Minecraft versions for NeoForge, old Forge layouts,
// self-healing of installed loaders and the streaming installer runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createLoaderService, neoforgeMcPrefix, isLoaderInstalled, defaultRun, MARKER } = require('../src/main/loaders');
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
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_META = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const NEO_API = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const logger = () => { const l = { warns: [], infos: [], warn: (m) => l.warns.push(m), info: (m) => l.infos.push(m), error() {} }; return l; };

test('neoforgeMcPrefix: classic and year-based Minecraft versions', () => {
  const cases = { '1.20.4': '20.4.', '1.21': '21.0.', '1.21.11': '21.11.', '26.1': '26.1.0.', '26.1.2': '26.1.2.', '26.2': '26.2.0.' };
  for (const [mc, prefix] of Object.entries(cases)) assert.equal(neoforgeMcPrefix(mc), prefix, mc);
  for (const mc of ['26.1-snapshot-1', '25w14craftmine', 'b1.7.3', '1.x', '', '12.3']) assert.equal(neoforgeMcPrefix(mc), null, mc);
});

test('NeoForge 26.1.x: lists builds of that exact release only, newest stable is recommended, betas are flagged', async () => {
  const gameDir = tmp();
  const transport = transportFor({ [NEO_API]: { versions: ['26.1.0.9-beta', '26.1.0.10-beta', '26.1.2.76', '26.1.2.82', '26.1.2.9', '21.1.57', '26.2.0.1-beta'] } });
  const svc = createLoaderService({ gameDir, transport, sleep });
  const two = await svc.listVersions('neoforge', '26.1.2');
  assert.deepEqual(two.map((v) => v.id), ['26.1.2.82', '26.1.2.76', '26.1.2.9']);
  assert.equal(two.filter((v) => v.recommended).length, 1);
  assert.equal(two[0].recommended, true);
  const zero = await svc.listVersions('neoforge', '26.1');
  assert.deepEqual(zero.map((v) => v.id), ['26.1.0.10-beta', '26.1.0.9-beta']);
  assert.deepEqual(zero.map((v) => v.stable), [false, false]);
  assert.equal(zero[0].recommended, true, 'a Minecraft version with only betas still gets a pick');
  assert.deepEqual(await svc.listVersions('neoforge', '26.3'), []);
});

test('Forge: the Maven index adds older builds after the promoted ones; a missing index falls back quietly', async () => {
  const gameDir = tmp();
  const xml = '<metadata><versioning><versions><version>1.20.1-47.2.0</version><version>1.20.1-47.3.0</version><version>1.20.1-47.3.5</version><version>1.20-46.0.14</version><version>1.7.10-10.13.4.1614-1.7.10</version></versions></versioning></metadata>';
  const withIndex = transportFor({ [FORGE_PROMOS]: { promos: { '1.20.1-recommended': '47.3.0', '1.20.1-latest': '47.3.5' } }, [FORGE_META]: xml });
  const log = logger();
  const svc = createLoaderService({ gameDir, transport: withIndex, sleep, logger: log });
  assert.deepEqual(await svc.listVersions('forge', '1.20.1'), [
    { id: '47.3.0', stable: true, recommended: true }, { id: '47.3.5', stable: false, recommended: false }, { id: '47.2.0', stable: true, recommended: false }
  ]);
  assert.deepEqual((await svc.listVersions('forge', '1.20')).map((v) => v.id), ['46.0.14'], 'a prefix of another Minecraft version does not leak builds');
  assert.deepEqual((await svc.listVersions('forge', '1.7.10')).map((v) => v.id), ['10.13.4.1614'], 'the duplicated -<mc> suffix is stripped');
  assert.equal(withIndex.calls.filter((u) => u === FORGE_META).length, 1, 'the index is cached');
  const noIndex = createLoaderService({ gameDir, transport: transportFor({ [FORGE_PROMOS]: { promos: { '1.20.1-latest': '47.3.5' } } }), sleep, logger: log });
  assert.deepEqual(await noIndex.listVersions('forge', '1.20.1'), [{ id: '47.3.5', stable: false, recommended: false }]);
  assert.ok(log.warns.some((w) => /index unavailable/i.test(w)));
});

test('Forge 1.7.10 style: installer URL with the -<mc> suffix is found, and the odd folder name is recognised as installed', async () => {
  const gameDir = tmp();
  const full = '1.7.10-10.13.4.1614';
  const base = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}-1.7.10/forge-${full}-1.7.10-installer.jar`;
  const transport = transportFor({
    [FORGE_PROMOS]: { promos: { '1.7.10-recommended': '10.13.4.1614' } },
    [base]: 'OLD-INSTALLER', [`${base}.sha1`]: sha1('OLD-INSTALLER')
  });
  let runs = 0;
  const run = async () => {
    runs++;
    const id = '1.7.10-Forge10.13.4.1614-1.7.10';
    fs.mkdirSync(path.join(gameDir, 'versions', id), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'versions', id, `${id}.json`), JSON.stringify({ id, libraries: [] }));
  };
  const svc = createLoaderService({ gameDir, transport, sleep, run });
  const id = await svc.ensure('forge', '1.7.10', '', { javaPath: 'java' });
  assert.equal(id, '1.7.10-Forge10.13.4.1614-1.7.10');
  assert.equal(svc.findInstalled('forge', '1.7.10'), id);
  assert.equal(svc.findInstalled('forge', '1.7.10', '10.13.4.1614'), id);
  assert.equal(svc.findInstalled('forge', '1.7.10', '9.9.9'), null);
  assert.equal(await svc.ensure('forge', '1.7.10', '', { javaPath: 'java' }), id);
  assert.equal(await svc.ensure('forge', '1.7.10', '10.13.4.1614', { javaPath: 'java' }), id);
  assert.equal(runs, 1, 'not reinstalled on every launch');
});

// ---------------------------------------------------------------- self-healing
function fabricWorld() {
  const gameDir = tmp();
  const mc = '1.21.11';
  const loader = '0.18.0';
  const libs = [`net/fabricmc/fabric-loader/${loader}/fabric-loader-${loader}.jar`, 'net/fabricmc/intermediary/1.21.11/intermediary-1.21.11.jar', 'org/ow2/asm/asm/9.9/asm-9.9.jar'];
  const routes = {
    [`https://meta.fabricmc.net/v2/versions/loader/${mc}`]: [{ loader: { version: loader, stable: true } }],
    [`https://meta.fabricmc.net/v2/versions/loader/${mc}/${loader}/profile/json`]: {
      id: `fabric-loader-${loader}-${mc}`, inheritsFrom: mc, mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      libraries: [{ name: `net.fabricmc:fabric-loader:${loader}`, url: 'https://maven.fabricmc.net/' }, { name: 'net.fabricmc:intermediary:1.21.11', url: 'https://maven.fabricmc.net/' }, { name: 'org.ow2.asm:asm:9.9', url: 'https://maven.fabricmc.net/' }]
    }
  };
  for (const rel of libs) { routes[`https://maven.fabricmc.net/${rel}`] = `jar:${rel}`; routes[`https://maven.fabricmc.net/${rel}.sha1`] = sha1(`jar:${rel}`); }
  const transport = transportFor(routes);
  const log = logger();
  return { gameDir, mc, loader, libs, transport, log, svc: createLoaderService({ gameDir, transport, sleep, logger: log }) };
}

test('Fabric: a library deleted after the install is restored on the next launch, with or without a pinned version', async () => {
  const w = fabricWorld();
  const id = await w.svc.ensure('fabric', w.mc, '');
  const victim = path.join(w.gameDir, 'libraries', ...w.libs[2].split('/'));
  fs.rmSync(victim);
  const before = w.transport.calls.length;
  assert.equal(await w.svc.ensure('fabric', w.mc, w.loader), id);
  assert.ok(fs.existsSync(victim), 'the missing jar is back');
  assert.ok(w.transport.calls.length > before);
  // and now that everything is there, a pinned launch needs no network at all
  const calm = w.transport.calls.length;
  assert.equal(await w.svc.ensure('fabric', w.mc, w.loader), id);
  assert.equal(w.transport.calls.length, calm);
  fs.rmSync(victim);
  assert.equal(await w.svc.ensure('fabric', w.mc, ''), id, 'auto version path heals as well');
  assert.ok(fs.existsSync(victim));
});

test('Fabric: when restoring fails (offline) the installed loader is still returned and a warning is logged', async () => {
  const w = fabricWorld();
  const id = await w.svc.ensure('fabric', w.mc, '');
  fs.rmSync(path.join(w.gameDir, 'libraries', ...w.libs[0].split('/')));
  const offline = createLoaderService({ gameDir: w.gameDir, transport: transportFor({}), sleep, logger: w.log });
  assert.equal(await offline.ensure('fabric', w.mc, w.loader), id);
  assert.ok(w.log.warns.some((m) => /Could not verify or restore/.test(m)));
});

test('Fabric: the first failing library stops the other downloads', async () => {
  const w = fabricWorld();
  const orig = w.transport.get.bind(w.transport);
  w.transport.get = (url, o, cb) => {
    if (url.href.endsWith('fabric-loader-0.18.0.jar')) { const req = new EventEmitter(); req.destroy = () => {}; setImmediate(() => { const res = new PassThrough(); res.statusCode = 403; res.headers = {}; cb(res); res.end(''); }); return req; }
    return orig(url, o, cb);
  };
  await assert.rejects(w.svc.ensure('fabric', w.mc, ''), (e) => e.code === 'NET_HTTP');
  assert.equal(isLoaderInstalled(w.gameDir, `fabric-loader-${w.loader}-${w.mc}`), false, 'a half-installed loader is never marked as installed');
});

function forgeLibWorld({ producesMissing = false } = {}) {
  const gameDir = tmp();
  const mc = '1.20.1';
  const ver = '47.3.0';
  const id = `${mc}-forge-${ver}`;
  const base = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${ver}/forge-${mc}-${ver}-installer.jar`;
  const transport = transportFor({ [FORGE_PROMOS]: { promos: { [`${mc}-recommended`]: ver } }, [base]: 'INSTALLER', [`${base}.sha1`]: sha1('INSTALLER') });
  const libPath = 'net/minecraftforge/fmlcore/1.20.1-47.3.0/fmlcore-1.20.1-47.3.0.jar';
  const versionJson = {
    id, inheritsFrom: mc,
    libraries: [
      { name: 'net.minecraftforge:fmlcore:1.20.1-47.3.0', downloads: { artifact: { path: libPath, url: 'https://maven.minecraftforge.net/x.jar', sha1: 'a' } } },
      { name: 'net.minecraftforge:forge:1.20.1-47.3.0:client', downloads: { artifact: { path: 'net/minecraftforge/forge/1.20.1-47.3.0/forge-1.20.1-47.3.0-client.jar', url: '' } } },
      { name: 'org.lwjgl:lwjgl-natives:1', rules: [{ action: 'allow', os: { name: 'osx' } }], downloads: { artifact: { path: 'org/lwjgl/never.jar', url: 'https://x/y.jar' } } }
    ]
  };
  const runs = [];
  const run = async () => {
    runs.push(1);
    fs.mkdirSync(path.join(gameDir, 'versions', id), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'versions', id, `${id}.json`), JSON.stringify(versionJson));
    if (!producesMissing) { const f = path.join(gameDir, 'libraries', ...libPath.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'jar'); }
  };
  const log = logger();
  return { gameDir, id, libFile: path.join(gameDir, 'libraries', ...libPath.split('/')), runs, log, svc: createLoaderService({ gameDir, transport, sleep, run, logger: log }) };
}

test('Forge: an installed build whose library vanished is repaired by running the installer again', async () => {
  const w = forgeLibWorld();
  assert.equal(await w.svc.ensure('forge', '1.20.1', '', { javaPath: 'java' }), w.id);
  assert.equal(w.runs.length, 1);
  assert.equal(await w.svc.ensure('forge', '1.20.1', '47.3.0', { javaPath: 'java' }), w.id);
  assert.equal(w.runs.length, 1, 'all downloadable libraries present: nothing to do (processor-made and OS-restricted entries are ignored)');
  fs.rmSync(w.libFile);
  assert.equal(await w.svc.ensure('forge', '1.20.1', '47.3.0', { javaPath: 'java' }), w.id);
  assert.equal(w.runs.length, 2, 'installer ran again to restore the library');
  assert.ok(fs.existsSync(w.libFile));
});

test('Forge: a library the installer never creates is remembered and does not cause a reinstall on every launch', async () => {
  const w = forgeLibWorld({ producesMissing: true });
  assert.equal(await w.svc.ensure('forge', '1.20.1', '', { javaPath: 'java' }), w.id);
  assert.equal(w.runs.length, 1);
  const marker = JSON.parse(fs.readFileSync(path.join(w.gameDir, 'versions', w.id, MARKER), 'utf8'));
  assert.deepEqual(marker.skip, ['net/minecraftforge/fmlcore/1.20.1-47.3.0/fmlcore-1.20.1-47.3.0.jar']);
  await w.svc.ensure('forge', '1.20.1', '', { javaPath: 'java' });
  await w.svc.ensure('forge', '1.20.1', '47.3.0', { javaPath: 'java' });
  assert.equal(w.runs.length, 1);
});

test('Forge: a failed repair never blocks launching an installed build', async () => {
  const w = forgeLibWorld();
  await w.svc.ensure('forge', '1.20.1', '', { javaPath: 'java' });
  fs.rmSync(w.libFile);
  const broken = createLoaderService({ gameDir: w.gameDir, transport: transportFor({}), sleep, logger: w.log, run: async () => { throw new Error('nope'); } });
  assert.equal(await broken.ensure('forge', '1.20.1', '47.3.0', { javaPath: 'java' }), w.id);
  assert.ok(w.log.warns.some((m) => /could not restore libraries/.test(m)));
});

test('an old marker (a bare timestamp written by 1.0.x) still counts as installed', () => {
  const gameDir = tmp();
  const id = 'fabric-loader-0.16.9-1.21.1';
  fs.mkdirSync(path.join(gameDir, 'versions', id), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'versions', id, `${id}.json`), '{}');
  fs.writeFileSync(path.join(gameDir, 'versions', id, MARKER), '2026-01-01T00:00:00.000Z');
  assert.equal(isLoaderInstalled(gameDir, id), true);
  const svc = createLoaderService({ gameDir, transport: transportFor({}), sleep });
  assert.equal(svc.findInstalled('fabric', '1.21.1'), id);
});

// ------------------------------------------------------------------ installer runner
test('defaultRun: success, onLine and an output flood that execFile(maxBuffer) would not survive', async () => {
  const lines = [];
  const code = "for (let i=0;i<200000;i++) console.log('line '+i+' '+'x'.repeat(60)); console.log('done'); ";
  const res = await defaultRun(process.execPath, ['-e', code], { onLine: (l) => lines.push(l) });
  assert.ok(res.stdout.split('\n').length <= 200, 'only the tail is kept');
  assert.match(res.stdout, /done$/);
  assert.ok(lines.length > 100000);
});

test('defaultRun: failure carries the output tail and the exit code; a missing executable is an error too', async () => {
  await assert.rejects(defaultRun(process.execPath, ['-e', "console.log('a'); console.error('boom: could not download'); process.exit(3)"]), (e) => e.exitCode === 3 && /boom: could not download/.test(e.output));
  await assert.rejects(defaultRun(path.join(tmp(), 'no-such-java'), ['-version']), (e) => e.code === 'ENOENT' && e.output === '');
});

test('defaultRun: aborting kills the installer and rejects promptly', async () => {
  const ac = new AbortController();
  const started = Date.now();
  const p = defaultRun(process.execPath, ['-e', "console.log('start'); setTimeout(()=>{}, 60000)"], { signal: ac.signal, onLine: () => ac.abort() });
  await assert.rejects(p, (e) => /exited with/.test(e.message));
  assert.ok(Date.now() - started < 15000);
});
