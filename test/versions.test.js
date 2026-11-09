'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { VersionService, parseManifest, assertMojangUrl, VersionError } = require('../src/main/versions');
const { tmp, manifestJson, okFetch, failFetch } = require('./helpers');

test('parseManifest drops entries with foreign hosts or unsafe ids', () => {
  const m = parseManifest(manifestJson());
  assert.deepEqual(m.versions.map((v) => v.id), ['26w01a', '1.99.0', '1.16.5']);
  assert.equal(m.latest.release, '1.99.0');
});

test('parseManifest rejects garbage', () => {
  for (const bad of [null, {}, { latest: {}, versions: [] }, { latest: { release: 'a', snapshot: 'b' }, versions: [] }]) {
    assert.throws(() => parseManifest(bad), VersionError);
  }
});

test('assertMojangUrl only allows https on Mojang hosts', () => {
  assert.ok(assertMojangUrl('https://piston-meta.mojang.com/a'));
  for (const u of ['http://piston-meta.mojang.com/a', 'https://evil.com/a', 'https://piston-meta.mojang.com.evil.com/a', 'not a url']) {
    assert.throws(() => assertMojangUrl(u), VersionError);
  }
});

test('resolve maps aliases and rejects unknown ids', async () => {
  const svc = new VersionService({ fetchImpl: okFetch() });
  const { manifest, source } = await svc.getManifest();
  assert.equal(source, 'network');
  assert.equal(svc.resolve(manifest, 'release').id, '1.99.0');
  assert.equal(svc.resolve(manifest, 'snapshot').id, '26w01a');
  assert.equal(svc.resolve(manifest, '1.16.5').id, '1.16.5');
  assert.throws(() => svc.resolve(manifest, '9.9.9'), /не найдена/);
  assert.throws(() => svc.resolve(manifest, 'evil'), /не найдена/);
});

test('list returns only releases and snapshots', async () => {
  const svc = new VersionService({ fetchImpl: okFetch() });
  const { manifest } = await svc.getManifest();
  assert.deepEqual(svc.list(manifest).map((v) => v.id), ['26w01a', '1.99.0', '1.16.5']);
});

test('falls back to the disk cache when offline, and errors when there is none', async () => {
  const cacheFile = path.join(tmp(), 'cache', 'm.json');
  await new VersionService({ cacheFile, fetchImpl: okFetch() }).getManifest(); // warms cache
  const offline = await new VersionService({ cacheFile, fetchImpl: failFetch }).getManifest();
  assert.equal(offline.source, 'cache');
  assert.equal(offline.manifest.latest.release, '1.99.0');
  await assert.rejects(new VersionService({ cacheFile: path.join(tmp(), 'none.json'), fetchImpl: failFetch }).getManifest(), (e) => e.code === 'NETWORK');
});

test('HTTP errors surface as NETWORK without a cache', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(new VersionService({ fetchImpl }).getManifest(), (e) => e.code === 'NETWORK' && /503/.test(e.message));
});
