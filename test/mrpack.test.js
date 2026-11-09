'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createMrpackService, MrpackError } = require('../src/main/mrpack');
const { createBuildsService } = require('../src/main/builds');
const { tmp, buildZip } = require('./helpers');

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
        const body = typeof r === 'string' ? r : Buffer.isBuffer(r) ? r : JSON.stringify(r);
        res.headers = { 'content-length': String(Buffer.byteLength(body)) };
        cb(res); res.end(body);
      });
      return req;
    }
  };
}
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sleep = () => Promise.resolve();

function samplePack({ mcVersion = '1.21.1', loaderKey = 'fabric-loader', loaderVersion = '0.16.9', modBody = Buffer.from('fake-mod-bytes') } = {}) {
  const index = {
    formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: 'Cozy Pack',
    dependencies: { minecraft: mcVersion, [loaderKey]: loaderVersion },
    files: [{
      path: 'mods/cool-mod.jar',
      hashes: { sha1: sha1(modBody) },
      env: { client: 'required', server: 'required' },
      downloads: ['https://cdn.modrinth.com/data/xyz/versions/1/cool-mod.jar'],
      fileSize: modBody.length
    }]
  };
  const zipBuf = buildZip([
    { name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index)), method: 8 },
    { name: 'overrides/config/cool.toml', data: Buffer.from('setting = true\n'), method: 0 },
    { name: 'client-overrides/config/cool.toml', data: Buffer.from('setting = "client"\n'), method: 0 }
  ]);
  return { zipBuf, modBody, modUrl: index.files[0].downloads[0] };
}

function setup() {
  const gameDir = tmp();
  const builds = createBuildsService({ root: path.join(gameDir, 'builds') });
  const routes = {};
  const transport = transportFor(routes);
  const svc = createMrpackService({ builds, transport, sleep });
  return { gameDir, builds, routes, transport, svc };
}

test('importPack: from a local file creates a build and installs files + overrides (client wins)', async () => {
  const { gameDir, routes, svc } = setup();
  const { zipBuf, modBody, modUrl } = samplePack();
  routes[modUrl] = modBody;
  const filePath = path.join(gameDir, 'pack.mrpack');
  fs.writeFileSync(filePath, zipBuf);

  const build = await svc.importPack({ filePath });
  assert.equal(build.name, 'Cozy Pack');
  assert.equal(build.mcVersion, '1.21.1');
  assert.equal(build.loader, 'fabric');
  assert.equal(build.loaderVersion, '0.16.9');

  const dir = path.join(gameDir, 'builds', build.id);
  assert.equal(fs.readFileSync(path.join(dir, 'mods', 'cool-mod.jar')).toString(), modBody.toString());
  assert.equal(fs.readFileSync(path.join(dir, 'config', 'cool.toml'), 'utf8'), 'setting = "client"\n'); // client-overrides applied after overrides
});

test('importPack: from a direct .mrpack URL', async () => {
  const { gameDir, routes, svc } = setup();
  const { zipBuf, modBody, modUrl } = samplePack({ loaderKey: 'quilt-loader', loaderVersion: '0.26.0' });
  routes[modUrl] = modBody;
  routes['https://cdn.modrinth.com/pack.mrpack'] = zipBuf;

  const build = await svc.importPack({ url: 'https://cdn.modrinth.com/pack.mrpack' });
  assert.equal(build.loader, 'quilt');
  assert.ok(fs.existsSync(path.join(gameDir, 'builds', build.id, 'mods', 'cool-mod.jar')));
});

test('importPack: resolves a modrinth.com modpack page link via the API', async () => {
  const { routes, svc } = setup();
  const { zipBuf, modBody, modUrl } = samplePack();
  routes[modUrl] = modBody;
  routes['https://api.modrinth.com/v2/project/cozy-pack/version'] = [
    { id: 'v2', version_number: '2.0', files: [{ filename: 'pack-v2.mrpack', url: 'https://cdn.modrinth.com/pack-v2.mrpack', primary: true, hashes: { sha1: sha1(zipBuf) } }] },
    { id: 'v1', version_number: '1.0', files: [{ filename: 'pack-v1.mrpack', url: 'https://cdn.modrinth.com/pack-v1.mrpack', primary: true, hashes: { sha1: sha1(zipBuf) } }] }
  ];
  routes['https://cdn.modrinth.com/pack-v2.mrpack'] = zipBuf;
  const build = await svc.importPack({ url: 'https://modrinth.com/modpack/cozy-pack' });
  assert.equal(build.name, 'Cozy Pack');
});

test('importPack: no modrinth.index.json, bad JSON, and a mismatched file hash are coded errors; the half-made build is removed', async () => {
  const { builds, routes, svc } = setup();

  const noIndex = buildZip([{ name: 'overrides/readme.txt', data: Buffer.from('hi'), method: 0 }]);
  await assert.rejects(svc.importPack({ filePath: writeTmp(noIndex) }), (e) => e.code === 'MRPACK_INVALID');

  const badJson = buildZip([{ name: 'modrinth.index.json', data: Buffer.from('not json'), method: 8 }]);
  await assert.rejects(svc.importPack({ filePath: writeTmp(badJson) }), (e) => e.code === 'MRPACK_INVALID');

  const { zipBuf, modUrl } = samplePack();
  routes[modUrl] = Buffer.from('tampered bytes, not the real mod');
  const before = builds.list().length;
  await assert.rejects(svc.importPack({ filePath: writeTmp(zipBuf) }), (e) => e.code === 'NET_CHECKSUM');
  assert.equal(builds.list().length, before); // the build created for this attempt was rolled back

  function writeTmp(buf) {
    const p = path.join(tmp(), 'p.mrpack');
    fs.writeFileSync(p, buf);
    return p;
  }
});

test('importPack: refuses a download URL outside the allowed hosts', async () => {
  const { svc } = setup();
  const index = { formatVersion: 1, game: 'minecraft', dependencies: { minecraft: '1.21.1' }, files: [{ path: 'mods/x.jar', hashes: {}, downloads: ['https://evil.example.com/x.jar'] }] };
  const zipBuf = buildZip([{ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index)), method: 8 }]);
  const p = path.join(tmp(), 'p.mrpack');
  fs.writeFileSync(p, zipBuf);
  await assert.rejects(svc.importPack({ filePath: p }), (e) => e.code === 'MRPACK_INVALID');
});

test('importPack: path traversal in a file entry is rejected', async () => {
  const { svc } = setup();
  const index = { formatVersion: 1, game: 'minecraft', dependencies: { minecraft: '1.21.1' }, files: [{ path: '../../evil.jar', hashes: {}, downloads: ['https://cdn.modrinth.com/x.jar'] }] };
  const zipBuf = buildZip([{ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index)), method: 8 }]);
  const p = path.join(tmp(), 'p.mrpack');
  fs.writeFileSync(p, zipBuf);
  await assert.rejects(svc.importPack({ filePath: p }), (e) => e.code === 'MRPACK_INVALID');
});
