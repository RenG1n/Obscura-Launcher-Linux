'use strict';
// Small, strict HTTPS client used for everything the launcher downloads itself
// (Java runtimes, Fabric, Forge). Rules: https only, every hop (including
// redirects) must be on the caller's allowlist, hard size limits, optional
// checksum verification, cancellation, and retries for transient failures.
// Nothing here ever receives tokens.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

class NetError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'NetError';
    this.code = code;
  }
}

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRANSIENT = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|timed out|HTTP 5\d\d|HTTP 429/i;

/** hostPolicy: array of exact hosts or "*.suffix" patterns. */
function hostAllowed(policy, hostname) {
  const h = String(hostname || '').toLowerCase();
  return policy.some((p) => (p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}

function assertUrl(value, policy) {
  let url;
  try { url = new URL(value); } catch { throw new NetError('NET_HOST', `Некорректный адрес загрузки.`); }
  if (url.protocol !== 'https:' || url.username || url.password || !hostAllowed(policy, url.hostname)) {
    throw new NetError('NET_HOST', `Адрес загрузки не разрешён: ${url.hostname || '?'}`);
  }
  return url;
}

/** Open a response, following redirects only to allowed https hosts. */
function open(urlString, { hosts, signal, timeoutMs = 20000, maxRedirects = 5, transport = https, headers = {} }) {
  return new Promise((resolve, reject) => {
    const go = (target, left) => {
      let url;
      try { url = assertUrl(target, hosts); } catch (e) { return reject(e); }
      if (signal && signal.aborted) return reject(new NetError('CANCELLED', 'Отменено.'));
      const req = transport.get(url, { headers: { 'user-agent': 'Obscura-Launcher', accept: '*/*', ...headers }, timeout: timeoutMs }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return reject(new NetError('NET_HTTP', 'Слишком много перенаправлений.'));
          let next;
          try { next = new URL(res.headers.location, url).href; } catch { return reject(new NetError('NET_HOST', 'Некорректное перенаправление.')); }
          return go(next, left - 1);
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return reject(new NetError('NET_HTTP', `HTTP ${status} при загрузке ${url.hostname}${url.pathname.slice(0, 80)}`));
        }
        resolve(res);
      });
      req.on('timeout', () => req.destroy(new NetError('NET_TIMEOUT', `Превышено время ожидания ответа ${url.hostname} (timed out).`)));
      req.on('error', (err) => reject(err instanceof NetError ? err : new NetError('NET_FAILED', `${err.code || 'сетевая ошибка'}: ${err.message}`, { cause: err })));
      if (signal) signal.addEventListener('abort', () => req.destroy(new NetError('CANCELLED', 'Отменено.')), { once: true });
    };
    go(urlString, maxRedirects);
  });
}

async function withRetries(fn, { attempts = 3, sleep = sleepDefault, signal } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      if (err && err.code === 'CANCELLED') throw err;
      if (signal && signal.aborted) throw new NetError('CANCELLED', 'Отменено.');
      const text = `${err && err.code} ${err && err.message}`;
      if (i >= attempts || !TRANSIENT.test(text)) throw err;
      await sleep(600 * i);
    }
  }
  throw last;
}

function readBody(res, maxBytes, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { res.destroy(new NetError('NET_TOO_LARGE', 'Ответ сервера слишком большой.')); return; }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', (e) => reject(e instanceof NetError ? e : new NetError('NET_FAILED', `${e.code || 'сетевая ошибка'}: ${e.message}`, { cause: e })));
    res.on('aborted', () => reject(new NetError('NET_FAILED', 'ECONNRESET: соединение прервано.')));
    if (signal) signal.addEventListener('abort', () => res.destroy(new NetError('CANCELLED', 'Отменено.')), { once: true });
  });
}

async function fetchText(url, opts = {}) {
  const { maxBytes = 8 * 1024 * 1024, retries } = opts;
  return withRetries(async () => {
    const res = await open(url, opts);
    return (await readBody(res, maxBytes, opts.signal)).toString('utf8');
  }, { attempts: retries, sleep: opts.sleep, signal: opts.signal });
}

async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, opts);
  try { return JSON.parse(text); } catch (err) { throw new NetError('NET_BAD_JSON', 'Сервер вернул некорректный JSON.', { cause: err }); }
}

/**
 * Download to `dest` through a .part file. `sha1`/`sha256` (hex) are verified before the file
 * appears under its final name. Retries restart from zero (no resume: simpler and safer).
 */
async function downloadFile(url, dest, opts = {}) {
  const { sha1, sha256, maxBytes = 512 * 1024 * 1024, onProgress, signal } = opts;
  const part = `${dest}.part`;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const once = async () => {
    const res = await open(url, opts);
    const total = Number(res.headers['content-length']) || 0;
    const hashes = [];
    if (sha1) hashes.push(['sha1', crypto.createHash('sha1'), String(sha1).toLowerCase()]);
    if (sha256) hashes.push(['sha256', crypto.createHash('sha256'), String(sha256).toLowerCase()]);
    const out = fs.createWriteStream(part);
    let size = 0;
    let lastReport = 0;
    try {
      await new Promise((resolve, reject) => {
        out.on('error', reject);
        out.on('finish', resolve);
        res.on('error', (e) => reject(e instanceof NetError ? e : new NetError('NET_FAILED', `${e.code || 'сетевая ошибка'}: ${e.message}`, { cause: e })));
        res.on('aborted', () => reject(new NetError('NET_FAILED', 'ECONNRESET: соединение прервано.')));
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) { res.destroy(new NetError('NET_TOO_LARGE', 'Файл больше допустимого размера.')); return; }
          for (const h of hashes) h[1].update(chunk);
          if (onProgress) {
            const now = Date.now();
            if (now - lastReport > 150) { lastReport = now; onProgress({ received: size, total, percent: total ? Math.min(100, Math.round((size / total) * 100)) : null }); }
          }
        });
        res.pipe(out);
        if (signal) signal.addEventListener('abort', () => res.destroy(new NetError('CANCELLED', 'Отменено.')), { once: true });
      });
      if (total && size !== total) throw new NetError('NET_FAILED', 'ECONNRESET: файл загружен не полностью.');
      for (const [name, h, expected] of hashes) {
        if (h.digest('hex') !== expected) throw new NetError('NET_CHECKSUM', `Контрольная сумма ${name} не совпала: файл повреждён или подменён.`);
      }
      await fs.promises.rename(part, dest);
      if (onProgress) onProgress({ received: size, total: total || size, percent: 100 });
      return { size };
    } catch (err) {
      out.destroy();
      await fs.promises.rm(part, { force: true }).catch(() => {});
      throw err;
    }
  };
  return withRetries(once, { attempts: opts.retries, sleep: opts.sleep, signal });
}

module.exports = { NetError, fetchText, fetchJson, downloadFile, hostAllowed, assertUrl, open };
