'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const java = require('../src/main/java');

const files = new Set([
  'C:\\Tools\\jdk21\\bin\\java.exe',
  'C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe',
  'C:\\Users\\Иван\\AppData\\Local\\Programs\\Eclipse Adoptium\\jdk-21.0.4-hotspot\\bin\\java.exe',
  'D:\\Games\\jdk17\\bin\\java.exe'
].map((p) => p.toLowerCase()));
const dirs = new Map([['c:\\users\\иван\\appdata\\local\\programs\\eclipse adoptium', ['jdk-21.0.4-hotspot']]]);
const fakeFs = {
  statSync: (p) => { if (files.has(String(p).toLowerCase())) return { isFile: () => true }; throw new Error('ENOENT'); },
  readdirSync: (d) => { const k = String(d).toLowerCase(); if (dirs.has(k)) return dirs.get(k).map((n) => ({ name: n, isDirectory: () => true })); throw new Error('ENOENT'); },
  realpathSync: (p) => p
};
const found = (env) => java.findCandidates({ platform: 'win32', env, fsImpl: fakeFs }).map((c) => c.path);

test('JAVA_HOME with quotes, trailing slash, or pointing at bin is understood', () => {
  for (const home of ['"C:\\Tools\\jdk21"', ' C:\\Tools\\jdk21\\ ', 'C:\\Tools\\jdk21\\bin', '"C:\\Tools\\jdk21\\bin"']) {
    assert.deepEqual(found({ JAVA_HOME: home, PATH: '' }), ['C:\\Tools\\jdk21\\bin\\java.exe'], home);
  }
});

test('PATH entries with quotes, spaces and empty items are understood', () => {
  const paths = found({ PATH: ' "C:\\Program Files\\Common Files\\Oracle\\Java\\javapath" ;;D:\\Games\\jdk17\\bin;' });
  assert.deepEqual(paths, ['C:\\Program Files\\Common Files\\Oracle\\Java\\javapath\\java.exe', 'D:\\Games\\jdk17\\bin\\java.exe']);
  assert.deepEqual(found({ Path: 'D:\\Games\\jdk17\\bin' }), ['D:\\Games\\jdk17\\bin\\java.exe']);
});

test('per-user installs under LOCALAPPDATA\\Programs are found, including non-ASCII profile names', () => {
  assert.deepEqual(found({ LOCALAPPDATA: 'C:\\Users\\Иван\\AppData\\Local', PATH: '' }), ['C:\\Users\\Иван\\AppData\\Local\\Programs\\Eclipse Adoptium\\jdk-21.0.4-hotspot\\bin\\java.exe']);
});

test('empty environment and missing folders never throw', () => {
  assert.deepEqual(found({}), []);
  assert.deepEqual(java.findCandidates({ platform: 'linux', env: {}, fsImpl: fakeFs }), []);
});

test('probeJava survives broken executables: errors, timeouts, garbage, wrong output', async () => {
  const exec = (impl) => (file, args, opts, cb) => impl(cb);
  assert.equal(await java.probeJava('x', { exec: exec((cb) => cb(new Error('spawn ENOENT'), '', '')) }), null);
  assert.equal(await java.probeJava('x', { exec: exec((cb) => cb(Object.assign(new Error('timeout'), { killed: true }), '', '')) }), null);
  assert.equal(await java.probeJava('x', { exec: exec((cb) => cb(null, 'Hello world', 'not java at all')) }), null);
  assert.equal(await java.probeJava('x', { exec: () => { throw new Error('sync throw'); } }), null);
  const ok = await java.probeJava('C:\\j\\java.exe', { exec: exec((cb) => cb(null, '', 'openjdk version "21.0.4" 2024-07-16 LTS\nOpenJDK Runtime Environment Temurin-21.0.4+7\nOpenJDK 64-Bit Server VM Temurin-21.0.4+7 (build 21.0.4+7-LTS, mixed mode, sharing)')) });
  assert.deepEqual(ok, { path: 'C:\\j\\java.exe', version: '21.0.4', major: 21, is64Bit: true });
});

test('detectJava drops candidates that fail to run and de-duplicates the same file', async () => {
  const exec = (file, args, opts, cb) => (file.includes('broken') ? cb(new Error('nope')) : cb(null, '', 'java version "1.8.0_392"\nJava HotSpot(TM) 64-Bit Server VM'));
  const fs2 = { statSync: () => ({ isFile: () => true }), readdirSync: () => [], realpathSync: (p) => (p.includes('link') ? 'C:\\real\\bin\\java.exe' : p) };
  const out = await java.detectJava({ platform: 'win32', env: { PATH: 'C:\\real\\bin;C:\\link\\bin;C:\\broken\\bin' }, fsImpl: fs2, exec });
  assert.equal(out.length, 1);
  assert.equal(out[0].major, 8);
});
