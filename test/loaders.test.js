'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createLoaderService, mavenPath, isLoaderInstalled } = require('../src/main/loaders');
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

const fabricProfile = (loader, mc) => ({
  id: `fabric-loader-${loader}-${mc}`, inheritsFrom: mc, mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  libraries: [
    { name: `net.fabricmc:fabric-loader:${loader}`, url: 'https://maven.fabricmc.net/' },
    { name: 'net.fabricmc:intermediary:1.21.1', url: 'https://maven.fabricmc.net/' },
    { name: 'org.ow2.asm:asm:9.7', url: 'https://maven.fabricmc.net/' }
  ]
});

function fabricSetup({ mc = '1.21.1', loader = '0.16.9', profile } = {}) {
  const gameDir = tmp();
  const routes = {
    [`https://meta.fabricmc.net/v2/versions/loader/${mc}`]: [{ loader: { version: '0.17.0-beta.1', stable: false } }, { loader: { version: loader, stable: true } }],
    [`https://meta.fabricmc.net/v2/versions/loader/${mc}/${loader}/profile/json`]: profile || fabricProfile(loader, mc)
  };
  for (const rel of [`net/fabricmc/fabric-loader/${loader}/fabric-loader-${loader}.jar`, 'net/fabricmc/intermediary/1.21.1/intermediary-1.21.1.jar', 'org/ow2/asm/asm/9.7/asm-9.7.jar']) {
    routes[`https://maven.fabricmc.net/${rel}`] = `jar:${rel}`;
    routes[`https://maven.fabricmc.net/${rel}.sha1`] = sha1(`jar:${rel}`);
  }
  const transport = transportFor(routes);
  return { gameDir, transport, svc: createLoaderService({ gameDir, transport, sleep }) };
}

test('mavenPath builds repository paths and refuses traversal', () => {
  assert.equal(mavenPath('net.fabricmc:fabric-loader:0.16.9'), 'net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar');
  assert.equal(mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');
  for (const bad of ['a:b', '../x:y:1', 'a:b:../../1', 'a/b:c:1', '', 'a:b:c d']) assert.throws(() => mavenPath(bad), (e) => e.code === 'LOADER_FAILED', bad);
});

test('Fabric: lists versions, installs profile + verified libraries, picks stable by default', async () => {
  const { gameDir, svc, transport } = fabricSetup();
  const list = await svc.listVersions('fabric', '1.21.1');
  assert.deepEqual(list, [{ id: '0.17.0-beta.1', stable: false }, { id: '0.16.9', stable: true }]);
  const progress = [];
  const id = await svc.ensure('fabric', '1.21.1', '', { onProgress: (p) => progress.push(p.percent) });
  assert.equal(id, 'fabric-loader-0.16.9-1.21.1');
  const json = JSON.parse(fs.readFileSync(path.join(gameDir, 'versions', id, `${id}.json`), 'utf8'));
  assert.equal(json.inheritsFrom, '1.21.1');
  assert.ok(fs.existsSync(path.join(gameDir, 'libraries', 'org', 'ow2', 'asm', 'asm', '9.7', 'asm-9.7.jar')));
  assert.equal(progress[progress.length - 1], 100);
  assert.equal(isLoaderInstalled(gameDir, id), true);
  // second call: already installed, no network needed for libraries
  const before = transport.calls.length;
  assert.equal(await svc.ensure('fabric', '1.21.1', '0.16.9'), id);
  assert.ok(transport.calls.length - before <= 1);
});

test('Fabric: unsupported Minecraft version and unknown loader version are coded errors', async () => {
  const { svc } = fabricSetup();
  await assert.rejects(svc.ensure('fabric', '1.2.3', ''), (e) => e.code === 'NET_HTTP' || e.code === 'LOADER_UNSUPPORTED');
  const gameDir = tmp();
  const transport = transportFor({ 'https://meta.fabricmc.net/v2/versions/loader/1.2.3': [] });
  const s2 = createLoaderService({ gameDir, transport, sleep });
  await assert.rejects(s2.ensure('fabric', '1.2.3', ''), (e) => e.code === 'LOADER_UNSUPPORTED' && /не поддерживает/.test(e.message));
  await assert.rejects(svc.ensure('fabric', '1.21.1', '9.9.9'), (e) => e.code === 'LOADER_UNSUPPORTED');
});

test('Fabric: a library with a bad checksum aborts the install and leaves no version behind', async () => {
  const { gameDir, svc, transport } = fabricSetup();
  // corrupt one sha1 route by replacing the transport's table through a wrapper
  const orig = transport.get.bind(transport);
  transport.get = (url, o, cb) => orig(url.href.endsWith('asm-9.7.jar.sha1') ? new URL('https://maven.fabricmc.net/bad.sha1') : url, o, cb);
  const t2 = { calls: [], get(url, o, cb) {
    if (url.href.endsWith('asm-9.7.jar.sha1')) { const req = new EventEmitter(); req.destroy = () => {}; setImmediate(() => { const res = new PassThrough(); res.statusCode = 200; const b = 'a'.repeat(40); res.headers = { 'content-length': '40' }; cb(res); res.end(b); }); return req; }
    return orig(url, o, cb);
  } };
  const s = createLoaderService({ gameDir, transport: t2, sleep });
  await assert.rejects(s.ensure('fabric', '1.21.1', ''), (e) => e.code === 'NET_CHECKSUM');
  assert.equal(isLoaderInstalled(gameDir, 'fabric-loader-0.16.9-1.21.1'), false);
});

test('Fabric: profiles with mismatching ids, foreign library hosts or traversal names are refused', async () => {
  const bad1 = { ...fabricProfile('0.16.9', '1.21.1'), id: 'something-else' };
  await assert.rejects(fabricSetup({ profile: bad1 }).svc.ensure('fabric', '1.21.1', ''), (e) => e.code === 'LOADER_FAILED');
  const bad2 = fabricProfile('0.16.9', '1.21.1'); bad2.libraries.push({ name: 'x:y:1', url: 'https://evil.example/' });
  await assert.rejects(fabricSetup({ profile: bad2 }).svc.ensure('fabric', '1.21.1', ''), (e) => e.code === 'NET_HOST');
  const bad3 = fabricProfile('0.16.9', '1.21.1'); bad3.libraries.push({ name: '../../x:y:1', url: 'https://maven.fabricmc.net/' });
  await assert.rejects(fabricSetup({ profile: bad3 }).svc.ensure('fabric', '1.21.1', ''), (e) => e.code === 'LOADER_FAILED');
});

function forgeSetup({ jar = 'FAKE-FORGE-INSTALLER', sha = null, run } = {}) {
  const gameDir = tmp();
  const full = '1.20.1-47.3.0';
  const base = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
  const transport = transportFor({
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json': { promos: { '1.20.1-recommended': '47.3.0', '1.20.1-latest': '47.3.5', '1.19-latest': 'bad version!' } },
    [base]: jar,
    [`${base}.sha1`]: sha || sha1(jar)
  });
  const runs = [];
  const fakeRun = run || (async (file, args, opts) => {
    runs.push({ file, args, cwd: opts.cwd });
    assert.ok(fs.existsSync(path.join(gameDir, 'launcher_profiles.json')), 'launcher_profiles.json must exist for the installer');
    assert.ok(fs.existsSync(args[1]), 'installer jar was downloaded');
    const id = '1.20.1-forge-47.3.0';
    fs.mkdirSync(path.join(gameDir, 'versions', id), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'versions', id, `${id}.json`), JSON.stringify({ id, inheritsFrom: '1.20.1' }));
  });
  return { gameDir, runs, svc: createLoaderService({ gameDir, transport, sleep, run: fakeRun }) };
}

test('Forge: lists recommended + latest, downloads the installer with SHA-1 check and runs it with the game Java', async () => {
  const { gameDir, svc, runs } = forgeSetup();
  assert.deepEqual(await svc.listVersions('forge', '1.20.1'), [{ id: '47.3.0', stable: true, recommended: true }, { id: '47.3.5', stable: false, recommended: false }]);
  assert.deepEqual(await svc.listVersions('forge', '1.19'), []);
  const id = await svc.ensure('forge', '1.20.1', '', { javaPath: 'C:\\java\\bin\\java.exe' });
  assert.equal(id, '1.20.1-forge-47.3.0');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].file, 'C:\\java\\bin\\java.exe');
  assert.deepEqual([runs[0].args[0], runs[0].args[2], runs[0].args[3]], ['-jar', '--installClient', gameDir]);
  assert.equal(isLoaderInstalled(gameDir, id), true);
  assert.ok(!fs.existsSync(path.join(gameDir, '.tmp-forge')), 'temporary installer folder removed');
  assert.equal(await svc.ensure('forge', '1.20.1', '47.3.0', { javaPath: 'x' }), id);
  assert.equal(runs.length, 1, 'already installed: installer is not run again');
});

test('Forge: no build for the version, no Java, and unknown version are coded errors', async () => {
  const { svc } = forgeSetup();
  await assert.rejects(svc.ensure('forge', '1.19', '', { javaPath: 'j' }), (e) => e.code === 'LOADER_UNSUPPORTED');
  await assert.rejects(svc.ensure('forge', '1.20.1', '', {}), (e) => e.code === 'LOADER_FAILED');
  await assert.rejects(svc.ensure('forge', '1.20.1', '1.1.1', { javaPath: 'j' }), (e) => e.code === 'LOADER_UNSUPPORTED');
});

test('Forge: a tampered installer (SHA-1 mismatch) is never executed', async () => {
  const { svc, runs } = forgeSetup({ sha: 'b'.repeat(40) });
  await assert.rejects(svc.ensure('forge', '1.20.1', '', { javaPath: 'j' }), (e) => e.code === 'NET_CHECKSUM');
  assert.equal(runs.length, 0);
});

test('Forge: installer failure is reported with its output; a silent "success" without a version is an error too', async () => {
  const failing = forgeSetup({ run: async () => { throw Object.assign(new Error('exit 1'), { output: 'line1\nERROR: could not download libraries\n' }); } });
  await assert.rejects(failing.svc.ensure('forge', '1.20.1', '', { javaPath: 'j' }), (e) => e.code === 'LOADER_FAILED' && /could not download libraries/.test(e.message));
  const silent = forgeSetup({ run: async () => {} });
  await assert.rejects(silent.svc.ensure('forge', '1.20.1', '', { javaPath: 'j' }), (e) => e.code === 'LOADER_FAILED' && /не появилась/.test(e.message));
  assert.ok(!fs.existsSync(path.join(silent.gameDir, '.tmp-forge')));
});

const quiltProfile = (loader, mc) => ({
  id: `quilt-loader-${loader}-${mc}`, inheritsFrom: mc, mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient',
  libraries: [
    { name: `org.quiltmc:quilt-loader:${loader}`, url: 'https://maven.quiltmc.org/repository/release/' },
    { name: 'org.quiltmc:hashed:1.21.1', url: 'https://maven.quiltmc.org/repository/release/' }
  ]
});
function quiltSetup({ mc = '1.21.1', loader = '0.26.0' } = {}) {
  const gameDir = tmp();
  const routes = {
    [`https://meta.quiltmc.org/v3/versions/loader/${mc}`]: [{ loader: { version: '0.27.0-beta.1' } }, { loader: { version: loader } }],
    [`https://meta.quiltmc.org/v3/versions/loader/${mc}/${loader}/profile/json`]: quiltProfile(loader, mc)
  };
  for (const rel of [`org/quiltmc/quilt-loader/${loader}/quilt-loader-${loader}.jar`, 'org/quiltmc/hashed/1.21.1/hashed-1.21.1.jar']) {
    routes[`https://maven.quiltmc.org/repository/release/${rel}`] = `jar:${rel}`;
    routes[`https://maven.quiltmc.org/repository/release/${rel}.sha1`] = sha1(`jar:${rel}`);
  }
  const transport = transportFor(routes);
  return { gameDir, transport, svc: createLoaderService({ gameDir, transport, sleep }) };
}

test('Quilt: lists versions, installs profile + verified libraries', async () => {
  const { gameDir, svc } = quiltSetup();
  const list = await svc.listVersions('quilt', '1.21.1');
  assert.deepEqual(list, [{ id: '0.27.0-beta.1', stable: false }, { id: '0.26.0', stable: true }]);
  const id = await svc.ensure('quilt', '1.21.1', '');
  assert.equal(id, 'quilt-loader-0.26.0-1.21.1');
  const json = JSON.parse(fs.readFileSync(path.join(gameDir, 'versions', id, `${id}.json`), 'utf8'));
  assert.equal(json.inheritsFrom, '1.21.1');
  assert.equal(isLoaderInstalled(gameDir, id), true);
});

test('Quilt: unsupported Minecraft version is a coded error', async () => {
  const gameDir = tmp();
  const transport = transportFor({ 'https://meta.quiltmc.org/v3/versions/loader/1.2.3': [] });
  const svc = createLoaderService({ gameDir, transport, sleep });
  await assert.rejects(svc.ensure('quilt', '1.2.3', ''), (e) => e.code === 'LOADER_UNSUPPORTED');
});

function neoforgeSetup({ jar = 'FAKE-NEOFORGE-INSTALLER', sha = null, run, version = '20.2.86' } = {}) {
  const gameDir = tmp();
  const base = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
  const transport = transportFor({
    'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge': { versions: ['20.2.86', '20.2.59', '21.1.57'] },
    [base]: jar,
    [`${base}.sha1`]: sha || sha1(jar)
  });
  const runs = [];
  const fakeRun = run || (async (file, args, opts) => {
    runs.push({ file, args, cwd: opts.cwd });
    assert.ok(fs.existsSync(path.join(gameDir, 'launcher_profiles.json')), 'launcher_profiles.json must exist for the installer');
    assert.ok(fs.existsSync(args[1]), 'installer jar was downloaded');
    const id = `neoforge-${version}`;
    fs.mkdirSync(path.join(gameDir, 'versions', id), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'versions', id, `${id}.json`), JSON.stringify({ id, inheritsFrom: '1.20.2' }));
  });
  return { gameDir, runs, svc: createLoaderService({ gameDir, transport, sleep, run: fakeRun }) };
}

test('NeoForge: lists versions matching the MC prefix, downloads + runs the installer', async () => {
  const { gameDir, svc, runs } = neoforgeSetup();
  const list = await svc.listVersions('neoforge', '1.20.2');
  assert.deepEqual(list.map((v) => v.id), ['20.2.86', '20.2.59']);
  assert.equal(list[0].recommended, true);
  const id = await svc.ensure('neoforge', '1.20.2', '', { javaPath: 'java' });
  assert.equal(id, 'neoforge-20.2.86');
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].args[0], runs[0].args[2], runs[0].args[3]], ['-jar', '--installClient', gameDir]);
  assert.equal(isLoaderInstalled(gameDir, id), true);
  assert.ok(!fs.existsSync(path.join(gameDir, '.tmp-neoforge')));
});

test('NeoForge: versions before 1.20.2 and missing Java are coded errors', async () => {
  const { svc } = neoforgeSetup();
  await assert.rejects(svc.ensure('neoforge', '1.19.4', '', { javaPath: 'j' }), (e) => e.code === 'LOADER_UNSUPPORTED');
  await assert.rejects(svc.ensure('neoforge', '1.20.2', '', {}), (e) => e.code === 'LOADER_FAILED');
});

test('inputs are validated before any network call', async () => {
  const { svc, transport } = fabricSetup();
  for (const [l, mc, v] of [['bedrock', '1.21.1', ''], ['fabric', '../x', ''], ['fabric', '1.21.1', '../../x'], ['vanilla', '1.21.1', ''], ['fabric', 5, '']]) {
    await assert.rejects(svc.ensure(l, mc, v), (e) => e.code === 'VALIDATION', JSON.stringify([l, mc, v]));
  }
  assert.equal(transport.calls.length, 0);
});
