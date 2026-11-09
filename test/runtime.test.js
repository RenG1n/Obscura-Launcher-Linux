'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const rt = require('../src/main/runtime');
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
        if (!r) return req.emit('error', Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
        const res = new PassThrough();
        res.statusCode = r.status || 200;
        res.headers = { ...(r.headers || {}), 'content-length': String(Buffer.byteLength(r.body)) };
        cb(res);
        res.end(r.body);
      });
      return req;
    }
  };
}

const LINK = (v) => `https://github.com/adoptium/temurin${v}-binaries/releases/download/jdk-${v}+1/OpenJDK${v}U-jre_x64_windows_hotspot_${v}.zip`;
const sleep = () => Promise.resolve();

/** A fake "zip": the test's extract hook materialises a JRE folder, the bytes are only hashed. */
function setup({ major = 21, platform = 'win32', javaMajor = major, corrupt = false, link } = {}) {
  const dir = tmp();
  const body = `archive-for-${major}`;
  const sha = crypto.createHash('sha256').update(corrupt ? 'other' : body).digest('hex');
  const api = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=${platform === 'win32' ? 'windows' : 'linux'}&vendor=eclipse`;
  const url = link || LINK(major);
  const transport = transportFor({
    [api]: { body: JSON.stringify([{ binary: { package: { link: url, checksum: sha, size: body.length } } }]) },
    [url]: { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/x/jre.zip' }, body: '' },
    'https://release-assets.githubusercontent.com/x/jre.zip': { body }
  });
  const extracted = [];
  const mgr = new rt.RuntimeManager({
    dir: path.join(dir, 'runtime'), platform, arch: 'x64', transport, sleep,
    extract: async (archive, dest) => {
      extracted.push(archive);
      const exe = path.join(dest, `jdk-${major}.0.1-jre`, 'bin', platform === 'win32' ? 'java.exe' : 'java');
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, 'x');
    },
    probe: async (p) => ({ path: p, version: `${javaMajor}.0.1`, major: javaMajor, is64Bit: true })
  });
  return { dir, mgr, transport, extracted };
}

test('majorForRequired: old games get 8, others the smallest supported LTS that fits', () => {
  assert.equal(rt.majorForRequired(8), 8);
  assert.equal(rt.majorForRequired(undefined), 8);
  assert.equal(rt.majorForRequired(16), 17);
  assert.equal(rt.majorForRequired(17), 17);
  assert.equal(rt.majorForRequired(18), 21);
  assert.equal(rt.majorForRequired(21), 21);
  assert.equal(rt.majorForRequired(22), 25);
  assert.equal(rt.majorForRequired(25), 25);
  assert.equal(rt.majorForRequired(27), 27);
});

test('install: downloads through redirects, verifies SHA-256, unpacks, proves java -version, lists it', async () => {
  const { mgr, extracted } = setup({ major: 21 });
  const events = [];
  const res = await mgr.install(21, { onProgress: (e) => events.push(e.phase) });
  assert.equal(res.major, 21);
  assert.match(res.path, /java-21[\\/]bin[\\/]java\.exe$/);
  assert.deepEqual(events.filter((v, i, a) => a.indexOf(v) === i), ['lookup', 'download', 'extract', 'verify', 'done']);
  assert.equal(extracted.length, 1);
  assert.deepEqual(mgr.list().map((j) => j.major), [21]);
  assert.equal(mgr.state().active, null);
  assert.ok(!fs.readdirSync(path.dirname(res.path.replace(/java-21.*/, 'x'))).some((n) => n.startsWith('.tmp')), 'no temp folders left');
});

test('a tampered archive (checksum mismatch) is rejected and nothing is installed', async () => {
  const { mgr } = setup({ major: 17, corrupt: true });
  await assert.rejects(mgr.install(17), (e) => e.code === 'NET_CHECKSUM');
  assert.deepEqual(mgr.list(), []);
});

test('the download link must be an official Temurin release on github.com', async () => {
  const { mgr } = setup({ major: 21, link: 'https://github.com/evil/repo/releases/download/x/jre.zip' });
  await assert.rejects(mgr.install(21), (e) => e.code === 'JAVA_INSTALL_FAILED' && /неожиданный адрес/.test(e.message));
  const t = setup({ major: 21, link: 'https://evil.example/jre.zip' });
  await assert.rejects(t.mgr.install(21), (e) => e.code === 'JAVA_INSTALL_FAILED');
  assert.deepEqual(t.mgr.list(), []);
});

test('a runtime that does not start, or is the wrong major, is not kept', async () => {
  const bad = setup({ major: 21 });
  bad.mgr.probe = async () => null;
  await assert.rejects(bad.mgr.install(21), (e) => e.code === 'JAVA_EXTRACT' && /не запускается/.test(e.message));
  assert.deepEqual(bad.mgr.list(), []);
  const wrong = setup({ major: 21, javaMajor: 17 });
  await assert.rejects(wrong.mgr.install(21), (e) => e.code === 'JAVA_EXTRACT' && /ожидалась 21/.test(e.message));
  assert.deepEqual(wrong.mgr.list(), []);
});

test('a failed reinstall keeps the previous working copy', async () => {
  const { mgr, dir } = setup({ major: 21 });
  await mgr.install(21);
  const before = mgr.list()[0].path;
  mgr.probe = async () => null;
  await assert.rejects(mgr.install(21));
  assert.deepEqual(mgr.list().map((j) => j.path), [before]);
  assert.ok(fs.existsSync(before));
});

test('only supported majors; one installation at a time; remove works', async () => {
  const { mgr } = setup({ major: 21 });
  for (const bad of [0, -1, 9, '21', null, 1000, 3.5]) await assert.rejects(mgr.install(bad), (e) => e.code === 'JAVA_INSTALL_FAILED', String(bad));
  const first = mgr.install(21);
  await assert.rejects(mgr.install(17), (e) => e.code === 'BUSY');
  await first;
  assert.deepEqual((await mgr.remove(21)), { removed: true });
  assert.deepEqual(mgr.list(), []);
  await assert.rejects(mgr.remove('../x'), (e) => e.code === 'VALIDATION');
});

test('cancel stops an installation and cleans up', async () => {
  const { mgr } = setup({ major: 21 });
  const p = mgr.install(21);
  assert.equal(mgr.cancel(), true);
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
  assert.deepEqual(mgr.list(), []);
  assert.equal(mgr.state().active, null);
});

test('real extraction: a .tar.gz with a fake "java" really unpacks and runs (Linux/macOS only)', async (t) => {
  if (process.platform === 'win32') return t.skip('tar.gz check is for the Linux CI');
  const dir = tmp();
  const src = path.join(dir, 'src', 'jdk-21.0.4+7-jre', 'bin');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'java'), '#!/bin/sh\necho \'openjdk version "21.0.4" 2024-07-16 LTS\' >&2\necho \'OpenJDK 64-Bit Server VM Temurin-21.0.4+7\' >&2\n', { mode: 0o755 });
  const archive = path.join(dir, 'jre.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', path.join(dir, 'src'), 'jdk-21.0.4+7-jre']);
  const body = fs.readFileSync(archive);
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const link = 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_linux_hotspot_21.0.4_7.tar.gz';
  const transport = {
    get(url, o, cb) {
      const req = new EventEmitter(); req.destroy = () => {};
      setImmediate(() => {
        const res = new PassThrough(); res.statusCode = 200;
        const payload = url.hostname === 'api.adoptium.net' ? Buffer.from(JSON.stringify([{ binary: { package: { link, checksum: sha, size: body.length } } }])) : body;
        res.headers = { 'content-length': String(payload.length) }; cb(res); res.end(payload);
      });
      return req;
    }
  };
  const mgr = new rt.RuntimeManager({ dir: path.join(dir, 'runtime'), platform: 'linux', arch: 'x64', transport, sleep });
  const res = await mgr.install(21);
  assert.equal(res.version, '21.0.4');
  assert.equal(res.path, path.join(dir, 'runtime', 'java-21', 'bin', 'java'));
  assert.deepEqual(mgr.list().map((j) => j.major), [21]);
});
