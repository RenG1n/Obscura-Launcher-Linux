'use strict';
// Minimal ZIP reader: central directory + local headers, store/deflate only.
// No ZIP64, no encryption, no streaming — the .mrpack archives this exists
// for are small. Uses only Node builtins (zlib for inflate).
const zlib = require('node:zlib');

class ZipError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ZipError';
  }
}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;

function findEOCD(buf) {
  const maxBack = Math.min(buf.length, 65535 + EOCD_MIN);
  for (let i = buf.length - EOCD_MIN; i >= buf.length - maxBack && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError('Не похоже на ZIP-архив (не найден конец центрального каталога).');
}

/** Returns [{ name, method, compSize, size, localOffset }] for every entry in the archive. */
function readEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < EOCD_MIN) throw new ZipError('Файл слишком мал, чтобы быть ZIP-архивом.');
  const eocdOff = findEOCD(buf);
  const total = buf.readUInt16LE(eocdOff + 10);
  const cdOff = buf.readUInt32LE(eocdOff + 16);
  if (cdOff === 0xffffffff || total === 0xffff) throw new ZipError('ZIP64-архивы не поддерживаются.');
  const entries = [];
  let off = cdOff;
  for (let i = 0; i < total; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDIR_SIG) throw new ZipError('Повреждён центральный каталог ZIP.');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('ZIP64-записи не поддерживаются.');
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, size, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompresses one entry (as returned by readEntries) and returns its data as a Buffer. */
function extract(buf, entry) {
  const off = entry.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOCAL_SIG) throw new ZipError(`Повреждён локальный заголовок записи "${entry.name}".`);
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  if (dataStart + entry.compSize > buf.length) throw new ZipError(`Запись "${entry.name}" повреждена (выходит за границы файла).`);
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    try { return zlib.inflateRawSync(raw); } catch (err) { throw new ZipError(`Не удалось распаковать "${entry.name}": архив повреждён.`, { cause: err }); }
  }
  throw new ZipError(`Неподдерживаемый метод сжатия (${entry.method}) для "${entry.name}".`);
}

module.exports = { readEntries, extract, ZipError };
