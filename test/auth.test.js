'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AuthService, AuthError, isAllowedLoginUrl } = require('../src/main/auth');
const { Logger, Redactor } = require('../src/main/logger');
const { tmp } = require('./helpers');

const TOKEN = 'mc-access-token-SECRET-987654321';
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('base64').split('').reverse().join('')),
  decryptString: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'base64').toString('utf8')
});

/** Fake prismarine-auth that exercises the cache factory and code callback like the real one. */
function fakeLib({ profile = { id: 'a'.repeat(32), name: 'Steve' }, needsCode = true, codeUrl = 'https://www.microsoft.com/link' } = {}) {
  class Authflow {
    constructor(username, cache, options, codeCallback) { Object.assign(this, { username, options, codeCallback, cache: cache({ username, cacheName: 'mca' }) }); }
    async getMinecraftJavaToken() {
      const cached = await this.cache.getCached();
      if (!cached.token) {
        if (!needsCode) throw new Error('unexpected');
        this.codeCallback({ user_code: 'ABCD1234', verification_uri: codeUrl, expires_in: 900 });
        await this.cache.setCachedPartial({ token: TOKEN, refresh: 'refresh-SECRET-TOKEN' });
      }
      return { token: TOKEN, entitlements: {}, profile };
    }
  }
  return () => ({ Authflow, Titles: { MinecraftNintendoSwitch: 'switch-id' } });
}

function make(opts = {}) {
  const dir = tmp();
  const logger = new Logger({ dir: null, redactor: new Redactor() });
  const opened = [];
  const auth = new AuthService({
    dir, safeStorage: opts.safeStorage || fakeSafeStorage(), logger, openExternal: (u) => opened.push(u),
    clientId: opts.clientId, loadLib: fakeLib(opts.lib)
  });
  return { auth, dir, opened, logger };
}

test('isAllowedLoginUrl accepts only https Microsoft hosts', () => {
  assert.ok(isAllowedLoginUrl('https://www.microsoft.com/link'));
  assert.ok(isAllowedLoginUrl('https://login.live.com/oauth20_remoteconnect.srf'));
  for (const u of ['http://www.microsoft.com/link', 'https://microsoft.com.evil.io/', 'https://evilmicrosoft.com/', 'javascript:alert(1)', 'file:///c:/x']) {
    assert.equal(isAllowedLoginUrl(u), false, u);
  }
});

test('device-code login returns a public profile, opens the Microsoft page, and stores tokens encrypted', async () => {
  const { auth, dir, opened, logger } = make();
  let shown;
  const profile = await auth.login((c) => { shown = c; });
  assert.deepEqual(profile, { name: 'Steve', uuid: 'a'.repeat(32) });
  assert.equal(shown.userCode, 'ABCD1234');
  assert.deepEqual(opened, ['https://www.microsoft.com/link']);
  assert.equal(auth.status().loggedIn, true);
  assert.ok(!JSON.stringify(auth.status()).includes(TOKEN));
  const scan = (folder) => {
    for (const name of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, name.name);
      if (name.isDirectory()) scan(full);
      else { const raw = fs.readFileSync(full, 'utf8'); assert.ok(!raw.includes(TOKEN) && !raw.includes('refresh-SECRET'), `${full} must not hold plaintext tokens`); }
    }
  };
  scan(dir);
  assert.ok(logger.safe(`cmd ${TOKEN}`).includes('[REDACTED]'));
});

test('a non-Microsoft verification URL aborts the login', async () => {
  const { auth, opened } = make({ lib: { codeUrl: 'https://phish.example/link' } });
  await assert.rejects(auth.login(() => {}), (e) => e.code === 'CANCELLED');
  assert.deepEqual(opened, []);
  assert.equal(auth.status().loggedIn, false);
});

test('accounts without a Minecraft profile get NO_LICENSE', async () => {
  const { auth } = make({ lib: { profile: null } });
  await assert.rejects(auth.login(() => {}), (e) => e.code === 'NO_LICENSE');
  assert.equal(auth.status().loggedIn, false);
});

test('getSession is silent: refreshes from cache, never asks for a code, requires prior login', async () => {
  const { auth, dir, logger } = make();
  await assert.rejects(auth.getSession(), (e) => e.code === 'LOGIN_REQUIRED');
  await auth.login(() => {});
  const s = await auth.getSession();
  assert.deepEqual({ ...s }, { accessToken: TOKEN, uuid: 'a'.repeat(32), name: 'Steve' });
  assert.ok(!logger.safe(TOKEN).includes('SECRET'));

  // A fresh process (new service, same dir) is still signed in thanks to the encrypted cache + profile file.
  const again = new AuthService({ dir, safeStorage: fakeSafeStorage(), logger, loadLib: fakeLib() });
  assert.equal(again.status().loggedIn, true);
  assert.equal((await again.getSession()).accessToken, TOKEN);
});

test('expired session in a fresh cache surfaces LOGIN_REQUIRED instead of prompting', async () => {
  const { auth } = make();
  await auth.login(() => {});
  await fs.promises.rm(path.join(auth.dir, 'accounts', auth.profile.cacheUser), { recursive: true, force: true }); // empty per-account cache
  const strictAuth = auth;
  strictAuth.loadLib = () => {
    const lib = fakeLib()();
    return lib;
  };
  await assert.rejects(strictAuth.getSession(), (e) => e instanceof AuthError && e.code === 'LOGIN_REQUIRED');
});

test('without OS-level encryption nothing is written to disk', async () => {
  const { auth, dir } = make({ safeStorage: fakeSafeStorage(false) });
  await auth.login(() => {});
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.bin')), []);
  assert.equal(auth.status().secureStorage, false);
});

test('logout deletes cached tokens and the profile file', async () => {
  const { auth, dir } = make();
  await auth.login(() => {});
  assert.ok(fs.readdirSync(dir).length >= 2);
  await auth.logout();
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(auth.status().loggedIn, false);
});

test('own Azure client id switches to the msal flow', async () => {
  let seen;
  const logger = new Logger({ dir: null });
  const lib = () => ({ Titles: {}, Authflow: class { constructor(u, c, o) { seen = o; } async getMinecraftJavaToken() { return { token: TOKEN, profile: { id: 'b'.repeat(32), name: 'Alex' } }; } } });
  const auth = new AuthService({ dir: tmp(), safeStorage: fakeSafeStorage(), logger, clientId: 'my-client-id', loadLib: lib });
  await auth.login(() => {});
  assert.deepEqual(seen, { flow: 'msal', authTitle: 'my-client-id' });
});
