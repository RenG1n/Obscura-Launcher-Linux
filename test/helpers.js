'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'obscura-test-'));

/** Builds a real (minimal, CRC-less) ZIP buffer for test fixtures — src/main/zip.js never checks CRC. */
function buildZip(files) {
  const localParts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const method = f.method ?? 8;
    const compData = method === 8 ? zlib.deflateRawSync(f.data) : f.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compData.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localOffset = offset;
    localParts.push(local, nameBuf, compData);
    offset += local.length + nameBuf.length + compData.length;

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(compData.length, 20);
    cdh.writeUInt32LE(f.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(localOffset, 42);
    central.push(cdh, nameBuf);
  }
  const centralBuf = Buffer.concat(central);
  const cdOffset = offset;
  const localBuf = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const manifestJson = () => ({
  latest: { release: '1.99.0', snapshot: '26w01a' },
  versions: [
    { id: '26w01a', type: 'snapshot', url: 'https://piston-meta.mojang.com/v1/packages/aaa/26w01a.json', sha1: 'aaa', releaseTime: '2026-01-01T00:00:00+00:00' },
    { id: '1.99.0', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/bbb/1.99.0.json', sha1: 'bbb', releaseTime: '2025-12-01T00:00:00+00:00' },
    { id: '1.16.5', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/ccc/1.16.5.json', sha1: 'ccc', releaseTime: '2021-01-01T00:00:00+00:00' },
    { id: 'evil', type: 'release', url: 'https://evil.example.com/x.json', releaseTime: '' },
    { id: '../../etc', type: 'release', url: 'https://piston-meta.mojang.com/x.json', releaseTime: '' }
  ]
});

const okFetch = (json = manifestJson()) => async () => ({ ok: true, status: 200, json: async () => json });
const failFetch = async () => { throw new TypeError('fetch failed'); };

/** A fake game process. */
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

module.exports = { tmp, manifestJson, okFetch, failFetch, fakeChild, buildZip };
