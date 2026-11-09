'use strict';
// Custom background storage. The renderer sends raw bytes; the main process
// verifies them by magic number (never trusting a file name or MIME type),
// enforces a size cap, and stores the copy inside the app's own data folder.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = {
  png: { ext: 'png', mime: 'image/png' },
  jpg: { ext: 'jpg', mime: 'image/jpeg' },
  webp: { ext: 'webp', mime: 'image/webp' }
};

class BackgroundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackgroundError';
  }
}

/** Identify png / jpeg / webp from content. Returns key of TYPES or null. SVG is deliberately not accepted. */
function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw new BackgroundError('Не удалось прочитать изображение.');
}

class BackgroundStore {
  constructor(dir) {
    this.dir = dir;
  }
  _existing() {
    try {
      return fs.readdirSync(this.dir).filter((n) => /^custom\.(png|jpg|webp)$/.test(n));
    } catch { return []; }
  }
  async saveCustom(input) {
    const buf = toBuffer(input);
    if (buf.length > MAX_BYTES) throw new BackgroundError(`Файл слишком большой (максимум ${MAX_BYTES / 1024 / 1024} MB).`);
    const type = detectImageType(buf);
    if (!type) throw new BackgroundError('Поддерживаются только PNG, JPEG и WebP.');
    await fs.promises.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, `custom.${TYPES[type].ext}`);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, target);
    for (const name of this._existing()) {
      if (name !== path.basename(target)) await fs.promises.rm(path.join(this.dir, name), { force: true });
    }
    return { type };
  }
  /** Returns a data: URL for the stored custom background, or null. */
  async loadCustomDataUrl() {
    const name = this._existing()[0];
    if (!name) return null;
    const buf = await fs.promises.readFile(path.join(this.dir, name));
    const type = detectImageType(buf); // re-verify what is on disk
    if (!type || buf.length > MAX_BYTES) return null;
    return `data:${TYPES[type].mime};base64,${buf.toString('base64')}`;
  }
  async hasCustom() {
    return this._existing().length > 0;
  }
  async removeCustom() {
    for (const name of this._existing()) await fs.promises.rm(path.join(this.dir, name), { force: true });
  }
}

module.exports = { BackgroundStore, BackgroundError, detectImageType, MAX_BYTES };
