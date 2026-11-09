'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CATALOG, ErrorReporter, classify } = require('../src/main/errors');
const { Logger, Redactor } = require('../src/main/logger');
const { GameError } = require('../src/main/game');
const { AuthError } = require('../src/main/auth');
const { VersionError } = require('../src/main/versions');
const { createGameService } = require('../src/main/game');
const { SettingsStore } = require('../src/main/settings');
const { VersionService } = require('../src/main/versions');
const { getMemoryInfo, validateRam, GB } = require('../src/main/ram');
const javaTools = require('../src/main/java');
const { tmp, okFetch, fakeChild } = require('./helpers');

const net = (code, extra = {}) => Object.assign(new Error(`connect ${code}`), { code, ...extra });
const agg = (...errs) => new AggregateError(errs, '');

test('catalog: every entry is complete and codes are unique OBS-nnn', () => {
  const codes = Object.keys(CATALOG);
  assert.equal(new Set(codes).size, codes.length);
  for (const [code, e] of Object.entries(CATALOG)) {
    assert.match(code, /^OBS-\d{3}$/);
    for (const k of ['title', 'cause', 'fix']) assert.ok(typeof e[k] === 'string' && e[k].length > 15, `${code}.${k}`);
    assert.equal(typeof e.dialog, 'boolean', `${code}.dialog`);
  }
});

test('classify: the empty AggregateError from the user\'s log maps to a network code', () => {
  const e = new GameError('INSTALL_FAILED', 'x', { cause: agg(net('ETIMEDOUT', { address: '1.2.3.4' }), net('ECONNRESET')) });
  assert.equal(classify(e, { phase: 'installing' }), 'OBS-101');
  assert.equal(classify(agg(net('ENOTFOUND')), { phase: 'installing' }), 'OBS-101');
});

test('classify: installation causes', () => {
  const inst = (cause) => new GameError('INSTALL_FAILED', 'fail', { cause });
  assert.equal(classify(inst(net('ENOSPC'))), 'OBS-104');
  assert.equal(classify(inst(net('EPERM'))), 'OBS-105');
  assert.equal(classify(inst(net('EBUSY'))), 'OBS-105');
  assert.equal(classify(inst(new Error('unable to verify the first certificate'))), 'OBS-102');
  assert.equal(classify(inst(net('CERT_HAS_EXPIRED'))), 'OBS-102');
  assert.equal(classify(inst(new Error('Response status 403 Forbidden'))), 'OBS-103');
  assert.equal(classify(inst(new Error('HTTP 503 Service Unavailable'))), 'OBS-103');
  assert.equal(classify(inst(new Error('sha1 checksum mismatch'))), 'OBS-106');
  assert.equal(classify(new GameError('INSTALL_FAILED', 'Установка завершилась, но файлы игры не найдены.')), 'OBS-109');
  assert.equal(classify(inst(new Error('something strange'))), 'OBS-199');
});

test('classify: account, java, ram, launch, settings, versions', () => {
  assert.equal(classify(new AuthError('LOGIN_REQUIRED', 'x')), 'OBS-201');
  assert.equal(classify(new AuthError('LOGIN_FAILED', 'x', { cause: new Error('nope') })), 'OBS-202');
  assert.equal(classify(new AuthError('LOGIN_FAILED', 'x', { cause: net('ENOTFOUND') })), 'OBS-205');
  assert.equal(classify(new AuthError('NO_LICENSE', 'x')), 'OBS-203');
  assert.equal(classify(new AuthError('BUSY', 'x'), { phase: 'login' }), 'OBS-204');
  assert.equal(classify(new GameError('JAVA_MISSING', 'x')), 'OBS-301');
  assert.equal(classify(new GameError('RAM_INVALID', 'x')), 'OBS-302');
  assert.equal(classify(new GameError('RUNNING', 'x')), 'OBS-406');
  assert.equal(classify(new GameError('BUSY', 'x')), 'OBS-406');
  assert.equal(classify(new GameError('LAUNCH_FAILED', 'x')), 'OBS-405');
  assert.equal(classify(new VersionError('UNKNOWN_VERSION', 'x')), 'OBS-107');
  assert.equal(classify(new VersionError('NETWORK', 'x', { cause: net('ENOTFOUND') })), 'OBS-108');
  assert.equal(classify(new VersionError('BAD_MANIFEST', 'x')), 'OBS-108');
  assert.equal(classify(Object.assign(new Error('x'), { name: 'ValidationError', code: 'VALIDATION' })), 'OBS-501');
  assert.equal(classify(Object.assign(new Error('x'), { name: 'BackgroundError', code: 'BACKGROUND' })), 'OBS-502');
  assert.equal(classify(new Error('boom')), 'OBS-900');
  assert.equal(classify(new Error('boom'), { phase: 'main' }), 'OBS-901');
});

test('classify: game crashes are told apart by their output', () => {
  const crash = (output) => classify(new GameError('GAME_EXIT', 'x'), { output });
  assert.equal(crash('Exception in thread "main" java.lang.UnsupportedClassVersionError: class file version 65.0'), 'OBS-402');
  assert.equal(crash('Error occurred during initialization of VM\nCould not reserve enough space for object heap'), 'OBS-403');
  assert.equal(crash('java.lang.OutOfMemoryError: Java heap space'), 'OBS-404');
  assert.equal(crash('some other crash'), 'OBS-401');
});

test('every code classify can return exists in the catalog', () => {
  const samples = [net('ETIMEDOUT'), net('ENOSPC'), new Error('x'), new GameError('GAME_EXIT', 'x'), new AuthError('LOGIN_FAILED', 'x'), null, undefined, 'string error', {}];
  for (const s of samples) for (const phase of ['installing', 'auth', 'main', undefined]) assert.ok(CATALOG[classify(s, { phase })], String(s));
});

test('reporter: numbered files with cause, fix, context; counter continues after restart', () => {
  const dir = path.join(tmp(), 'errors');
  const logger = new Logger({ dir: path.join(tmp(), 'logs') });
  const fixed = new Date('2026-10-26T08:50:00Z');
  const r1 = new ErrorReporter({ dir, logger, appVersion: '9.9.9', now: () => fixed });
  const a = r1.report(new GameError('JAVA_MISSING', 'Нужна Java 21'), { phase: 'java', resolvedVersion: '1.21.8', requiredJava: 21 });
  const b = r1.report(new GameError('INSTALL_FAILED', 'x', { cause: agg(net('ETIMEDOUT', { address: '9.9.9.9', port: 443 })) }), { phase: 'installing' });
  assert.deepEqual([a.number, b.number], ['0001', '0002']);
  assert.deepEqual([a.code, b.code], ['OBS-301', 'OBS-101']);
  assert.ok(fs.existsSync(path.join(dir, a.file)));
  const text = fs.readFileSync(path.join(dir, b.file), 'utf8');
  for (const needle of ['ОШИБКА OBS-101', '№0002', 'ЧТО СЛУЧИЛОСЬ', 'ЧТО ДЕЛАТЬ', 'Obscura 9.9.9', 'ETIMEDOUT', '9.9.9.9:443', 'phase: installing']) assert.ok(text.includes(needle), needle);
  const r2 = new ErrorReporter({ dir, logger });
  assert.equal(r2.report(new Error('later')).number, '0003');
  assert.deepEqual(r2.list().map((x) => [x.number, x.code]), [['0003', 'OBS-900'], ['0002', 'OBS-101'], ['0001', 'OBS-301']]);
  assert.match(r2.list()[0].title, /Внутренняя/);
});

test('reporter: secrets never reach the report file or the public report', () => {
  const dir = path.join(tmp(), 'errors');
  const redactor = new Redactor(); redactor.addSecret('TOKEN-SECRET-abcdef');
  const logger = new Logger({ dir: path.join(tmp(), 'l'), redactor });
  const rep = new ErrorReporter({ dir, logger });
  const r = rep.report(new GameError('GAME_EXIT', 'x'), { output: 'Setting user with TOKEN-SECRET-abcdef --accessToken TOKEN-SECRET-abcdef', phase: 'game' });
  const text = fs.readFileSync(path.join(dir, r.file), 'utf8');
  assert.ok(!text.includes('TOKEN-SECRET'));
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(!JSON.stringify(r).includes('TOKEN-SECRET'));
});

test('reporter: cancellations are not errors; the same error is reported once; old reports are pruned', () => {
  const dir = path.join(tmp(), 'errors');
  const rep = new ErrorReporter({ dir, logger: new Logger({ dir: null }) });
  assert.equal(rep.report(new GameError('CANCELLED', 'x')), null);
  const e = new Error('once');
  const first = rep.report(e);
  assert.equal(rep.report(e), first);
  assert.equal(rep.list().length, 1);
  for (let i = 0; i < 230; i++) rep.report(new Error(`e${i}`));
  assert.ok(fs.readdirSync(dir).length <= 200);
  assert.equal(rep.list(1)[0].number, '0231');
});

test('reporter: a read-only/missing folder never throws', () => {
  const rep = new ErrorReporter({ dir: path.join(tmp(), 'a\0b'), logger: new Logger({ dir: null }) });
  const r = rep.report(new Error('x'));
  assert.equal(r.file, null);
  assert.equal(r.code, 'OBS-900');
});

async function gameSetup(opts = {}) {
  const dir = tmp();
  const logger = new Logger({ dir: path.join(dir, 'logs'), redactor: new Redactor() });
  const reporter = new ErrorReporter({ dir: path.join(dir, 'errors'), logger });
  const settings = new SettingsStore(path.join(dir, 'cfg')); await settings.load();
  const events = []; const child = fakeChild();
  const game = createGameService({
    settings, versions: new VersionService({ fetchImpl: okFetch() }),
    auth: { async getSession() { return { accessToken: 'tok-12345678', uuid: 'u', name: 'S' }; } },
    java: { detectJava: async () => opts.javas || [{ path: 'j', version: '21', major: 21, is64Bit: true }], pickJava: javaTools.pickJava },
    ram: { getMemoryInfo: () => getMemoryInfo({ totalmem: () => 16 * GB, freemem: () => 8 * GB }), validateRam },
    installer: opts.installerOverride ? { install: opts.installerOverride } : { async install(meta, g) { const v = path.join(g, 'versions', meta.id); fs.mkdirSync(v, { recursive: true }); fs.writeFileSync(path.join(v, `${meta.id}.json`), JSON.stringify({ javaVersion: { majorVersion: 21 } })); fs.writeFileSync(path.join(v, `${meta.id}.jar`), 'j'); } },
    launcher: { launch: async () => child },
    gameDir: path.join(dir, 'minecraft'), logger, reporter, retryDelayMs: 0, emit: (e) => events.push(e)
  });
  return { game, reporter, events, child, dir };
}

test('game flow: a failure creates a numbered report with context (version, phase, Java)', async () => {
  const t = await gameSetup({ javas: [{ path: 'j8', version: '1.8.0', major: 8, is64Bit: true }] });
  await assert.rejects(t.game.play({ version: '1.99.0' }), (e) => e.code === 'JAVA_MISSING');
  const [r] = t.reporter.list();
  assert.equal(r.code, 'OBS-301');
  const text = fs.readFileSync(path.join(t.dir, 'errors', r.file), 'utf8');
  for (const needle of ['resolvedVersion: 1.99.0', 'phase: java', 'requiredJava: 21', 'foundJava: 8']) assert.ok(text.includes(needle), needle);
});

test('game flow: cancelled installs are not reported', async () => {
  let started; const startedP = new Promise((r) => { started = r; });
  const t = await gameSetup({ installerOverride: (meta, g, { signal }) => new Promise((_, reject) => { started(); signal.addEventListener('abort', () => reject(new Error('aborted'))); }) });
  const playing = t.game.play({ version: '1.99.0' });
  await startedP;
  assert.equal(t.game.cancel(), true);
  await assert.rejects(playing, (e) => e.code === 'CANCELLED');
  assert.equal(t.reporter.list().length, 0);
});

test('game flow: a crash after launch is reported with the last game output and the exit event carries the report', async () => {
  const t = await gameSetup();
  await t.game.play({ version: '1.99.0' });
  t.child.stderr.emit('data', Buffer.from('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space\n'));
  t.child.emit('exit', 1);
  const exited = t.events.find((e) => e.type === 'exited');
  assert.equal(exited.report.code, 'OBS-404');
  const text = fs.readFileSync(path.join(t.dir, 'errors', exited.report.file), 'utf8');
  assert.ok(text.includes('ПОСЛЕДНИЕ СТРОКИ ВЫВОДА ИГРЫ') && text.includes('OutOfMemoryError') && text.includes('exitCode: 1'));
});

test('game flow: a clean exit creates no report', async () => {
  const t = await gameSetup();
  await t.game.play({ version: '1.99.0' });
  t.child.emit('exit', 0);
  assert.equal(t.reporter.list().length, 0);
  assert.equal(t.events.find((e) => e.type === 'exited').report, undefined);
});
