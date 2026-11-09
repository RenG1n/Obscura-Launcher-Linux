'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const net = require('../src/main/net');
const { tmp } = require('./helpers');

/** Fake https transport: routes[url] = {status, headers, body} | function(callNumber) */
function fakeTransport(routes) {
  const calls = [];
  return {
    calls,
    get(url, options, cb) {
      const href = url.href;
      calls.push(href);
      const req = new EventEmitter();
      req.destroy = (err) => { setImmediate(() => req.emit('error', err)); };
      setImmediate(() => {
        let r = routes[href];
        if (typeof r === 'function') r = r(calls.filter((c) => c === href).length);
        if (!r) { req.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })); return; }
        if (r.error) { req.emit('error', Object.assign(new Error(r.error), { code: r.error })); return; }
        const res = new PassThrough();
        res.statusCode = r.status || 200;
        res.headers = { ...(r.headers || {}) };
        if (r.body !== undefined && r.contentLength !== false) res.headers['content-length'] = String(Buffer.byteLength(r.body));
        cb(res);
        if (r.midError) { res.write(Buffer.from(String(r.body).slice(0, 3))); setImmediate(() => res.destroy(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))); return; }
        res.end(r.body);
      });
      return req;
    }
  };
}
const sleep = () => Promise.resolve();
const H = ['example.com', '*.cdn.example.com'];

test('hostAllowed: exact hosts and *.suffix patterns only', () => {
  assert.equal(net.hostAllowed(H, 'example.com'), true);
  assert.equal(net.hostAllowed(H, 'a.cdn.example.com'), true);
  assert.equal(net.hostAllowed(H, 'cdn.example.com'), false);
  assert.equal(net.hostAllowed(H, 'evilexample.com'), false);
  assert.equal(net.hostAllowed(H, 'example.com.evil.net'), false);
});

test('only https on allowed hosts, no credentials in URLs', () => {
  for (const bad of ['http://example.com/x', 'https://evil.net/x', 'https://u:p@example.com/x', 'ftp://example.com/x', 'garbage']) {
    assert.throws(() => net.assertUrl(bad, H), (e) => e.code === 'NET_HOST', bad);
  }
  assert.ok(net.assertUrl('https://example.com/x', H));
});

test('fetchJson follows redirects between allowed hosts and parses', async () => {
  const transport = fakeTransport({
    'https://example.com/a': { status: 302, headers: { location: 'https://x.cdn.example.com/b' } },
    'https://x.cdn.example.com/b': { body: '{"ok":true}' }
  });
  assert.deepEqual(await net.fetchJson('https://example.com/a', { hosts: H, transport, sleep }), { ok: true });
});

test('a redirect to a foreign host is refused (not followed)', async () => {
  const transport = fakeTransport({
    'https://example.com/a': { status: 302, headers: { location: 'https://evil.net/steal' } },
    'https://evil.net/steal': { body: 'x' }
  });
  await assert.rejects(net.fetchText('https://example.com/a', { hosts: H, transport, sleep }), (e) => e.code === 'NET_HOST');
  assert.ok(!transport.calls.includes('https://evil.net/steal'));
});

test('redirect loops stop', async () => {
  const transport = fakeTransport({ 'https://example.com/a': { status: 302, headers: { location: 'https://example.com/a' } } });
  await assert.rejects(net.fetchText('https://example.com/a', { hosts: H, transport, sleep, maxRedirects: 3 }), (e) => e.code === 'NET_HTTP');
});

test('HTTP errors carry the status; 404 is not retried, 503 is', async () => {
  const t404 = fakeTransport({ 'https://example.com/a': { status: 404, body: '' } });
  await assert.rejects(net.fetchText('https://example.com/a', { hosts: H, transport: t404, sleep }), /HTTP 404/);
  assert.equal(t404.calls.length, 1);
  const t503 = fakeTransport({ 'https://example.com/a': (n) => (n < 3 ? { status: 503, body: '' } : { body: 'fine' }) });
  assert.equal(await net.fetchText('https://example.com/a', { hosts: H, transport: t503, sleep, retries: 3 }), 'fine');
  assert.equal(t503.calls.length, 3);
});

test('network errors are retried and finally reported', async () => {
  const t = fakeTransport({ 'https://example.com/a': { error: 'ECONNRESET' } });
  await assert.rejects(net.fetchText('https://example.com/a', { hosts: H, transport: t, sleep, retries: 3 }), /ECONNRESET/);
  assert.equal(t.calls.length, 3);
});

test('bad JSON and oversized bodies are rejected', async () => {
  const t = fakeTransport({ 'https://example.com/j': { body: '<html>' }, 'https://example.com/big': { body: 'x'.repeat(5000) } });
  await assert.rejects(net.fetchJson('https://example.com/j', { hosts: H, transport: t, sleep }), (e) => e.code === 'NET_BAD_JSON');
  await assert.rejects(net.fetchText('https://example.com/big', { hosts: H, transport: t, sleep, maxBytes: 100 }), (e) => e.code === 'NET_TOO_LARGE');
});

test('downloadFile verifies sha256/sha1, writes atomically and reports progress', async () => {
  const dir = tmp();
  const body = 'hello java runtime'.repeat(100);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const sha1 = crypto.createHash('sha1').update(body).digest('hex');
  const t = fakeTransport({ 'https://example.com/f.zip': { body } });
  const seen = [];
  const dest = path.join(dir, 'sub', 'f.zip');
  await net.downloadFile('https://example.com/f.zip', dest, { hosts: H, transport: t, sleep, sha256, sha1, onProgress: (p) => seen.push(p.percent) });
  assert.equal(fs.readFileSync(dest, 'utf8'), body);
  assert.ok(!fs.existsSync(`${dest}.part`));
  assert.equal(seen[seen.length - 1], 100);
});

test('a wrong checksum leaves no file behind', async () => {
  const dir = tmp();
  const t = fakeTransport({ 'https://example.com/f': { body: 'tampered' } });
  const dest = path.join(dir, 'f');
  await assert.rejects(net.downloadFile('https://example.com/f', dest, { hosts: H, transport: t, sleep, sha256: 'ab'.repeat(32), retries: 1 }), (e) => e.code === 'NET_CHECKSUM' && /sha256/.test(e.message));
  assert.ok(!fs.existsSync(dest));
  assert.ok(!fs.existsSync(`${dest}.part`));
});

test('a connection dropped mid-download is retried from scratch and succeeds', async () => {
  const dir = tmp();
  const t = fakeTransport({ 'https://example.com/f': (n) => (n === 1 ? { body: 'complete-file', midError: true } : { body: 'complete-file' }) });
  const dest = path.join(dir, 'f');
  await net.downloadFile('https://example.com/f', dest, { hosts: H, transport: t, sleep, retries: 3 });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'complete-file');
  assert.equal(t.calls.length, 2);
});

test('a truncated body (content-length mismatch) is an error, not a corrupt file', async () => {
  const dir = tmp();
  const dest = path.join(dir, 'f');
  const t = { get(url, o, cb) { const req = new EventEmitter(); req.destroy = () => {}; setImmediate(() => { const res = new PassThrough(); res.statusCode = 200; res.headers = { 'content-length': '100' }; cb(res); res.end('short'); }); return req; } };
  await assert.rejects(net.downloadFile('https://example.com/f', dest, { hosts: H, transport: t, sleep, retries: 1 }), /не полностью/);
  assert.ok(!fs.existsSync(dest));
});

test('cancellation aborts and cleans up', async () => {
  const dir = tmp();
  const ac = new AbortController();
  const t = { get(url, o, cb) { const req = new EventEmitter(); req.destroy = (e) => setImmediate(() => req.emit('error', e)); setImmediate(() => { const res = new PassThrough(); res.statusCode = 200; res.headers = {}; cb(res); res.write('part'); setTimeout(() => ac.abort(), 5); }); return req; } };
  const dest = path.join(dir, 'f');
  await assert.rejects(net.downloadFile('https://example.com/f', dest, { hosts: H, transport: t, sleep, signal: ac.signal }), (e) => e.code === 'CANCELLED');
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
});
