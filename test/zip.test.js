'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readEntries, extract, ZipError } = require('../src/main/zip');
const { buildZip } = require('./helpers');

test('reads and extracts stored and deflated entries', () => {
  const zip = buildZip([
    { name: 'modrinth.index.json', data: Buffer.from('{"a":1}'), method: 8 },
    { name: 'overrides/config/x.toml', data: Buffer.from('x = 1\n'), method: 0 },
    { name: 'overrides/mods/thing.jar', data: Buffer.from('fake-jar-bytes-'.repeat(50)), method: 8 }
  ]);
  const entries = readEntries(zip);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.name), ['modrinth.index.json', 'overrides/config/x.toml', 'overrides/mods/thing.jar']);
  assert.equal(extract(zip, entries[0]).toString('utf8'), '{"a":1}');
  assert.equal(extract(zip, entries[1]).toString('utf8'), 'x = 1\n');
  assert.equal(extract(zip, entries[2]).toString('utf8'), 'fake-jar-bytes-'.repeat(50));
});

test('rejects non-ZIP and truncated input with ZipError', () => {
  assert.throws(() => readEntries(Buffer.from('not a zip')), ZipError);
  const zip = buildZip([{ name: 'a.txt', data: Buffer.from('hello'), method: 0 }]);
  assert.throws(() => readEntries(zip.subarray(0, zip.length - 30)), ZipError);
});
