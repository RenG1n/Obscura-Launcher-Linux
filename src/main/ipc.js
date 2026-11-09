'use strict';
// The only door between the renderer and the system. Every channel is listed
// here, accepts plain validated data, checks that the call really comes from
// the launcher's own page, and returns { ok, data } / { ok:false, error }.
// Errors are reduced to a code + redacted message; stacks never reach the UI.
const { BACKGROUND_IDS } = require('./settings');
const { MAX_BYTES } = require('./backgrounds');

function toPublicError(err, logger, reporter = null, ctx = {}) {
  const byName = { ValidationError: 'VALIDATION', BackgroundError: 'BACKGROUND' };
  const known = err && ['ValidationError', 'BackgroundError', 'GameError', 'AuthError', 'VersionError', 'LoaderError', 'RuntimeError', 'NetError', 'ModrinthError', 'MrpackError', 'ZipError', 'BuildError', 'VisualError'].includes(err.name);
  const code = err && typeof err.code === 'string' && /^[A-Z_]{3,32}$/.test(err.code)
    ? err.code
    : (known && byName[err.name]) || 'INTERNAL';
  let report = null;
  try { report = reporter ? reporter.report(err, ctx) : null; } catch { /* reporting must never break the reply */ }
  if (!known && !report) logger.error(err);
  const message = known ? logger.safe(err.message) : (report ? `${report.title}.` : 'Внутренняя ошибка лаунчера. Подробности — в логе.');
  return report ? { code, message, report } : { code, message };
}

/**
 * @param {{ ipcMain: {handle:Function}, trustedUrl: string, logger: any, services: any, emit: (channel:string,payload:any)=>void }} opts
 * @returns {string[]} registered channel names
 */
function registerIpc({ ipcMain, trustedUrl, logger, services }) {
  const { settings, backgrounds, versions, auth, game, system, emitAuthCode, errors = null, loaders = null, javaManager = null, builds = null, modrinth = null, mrpack = null, visual = null } = services;
  const MAX_MRPACK_BYTES = 128 * 1024 * 1024;
  const reporter = errors ? errors.reporter : null;
  const channels = [];

  const isTrusted = (event) => {
    const frame = event && event.senderFrame;
    if (!frame || typeof frame.url !== 'string') return false;
    try {
      const a = new URL(frame.url);
      const b = new URL(trustedUrl);
      const norm = (u) => (process.platform === 'win32' ? decodeURIComponent(u.pathname).toLowerCase() : decodeURIComponent(u.pathname));
      return a.protocol === 'file:' && norm(a) === norm(b) && frame.parent === null;
    } catch { return false; }
  };

  const handle = (channel, fn, ctx = {}) => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrusted(event)) {
        logger.warn(`Rejected IPC call on ${channel} from untrusted frame`);
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Запрос отклонён.' } };
      }
      try {
        return { ok: true, data: await fn(...args) };
      } catch (err) {
        return { ok: false, error: toPublicError(err, logger, ctx.quiet ? null : reporter, { phase: ctx.phase || channel }) };
      }
    });
  };

  handle('settings:get', async () => settings.get());
  handle('settings:update', async (patch) => {
    // The visual mod switch decides which folder and version the next launch uses: not while one is being prepared.
    if (patch && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, 'visualMode') && game && typeof game.state === 'function' && game.state().busy) {
      throw Object.assign(new Error('Дождитесь окончания подготовки к запуску (или нажмите «Отмена») и переключите визуальный мод ещё раз.'), { name: 'ValidationError', code: 'VALIDATION' });
    }
    const updated = await settings.update(patch);
    return updated;
  });

  handle('system:info', async () => system.info());

  handle('versions:list', async () => {
    const { manifest, source } = await versions.getManifest();
    return { source, latest: manifest.latest, versions: versions.list(manifest) };
  });

  handle('background:get', async () => {
    const id = settings.get().background;
    if (id === 'custom') {
      const dataUrl = await backgrounds.loadCustomDataUrl();
      if (dataUrl) return { id, dataUrl };
      await settings.update({ background: 'builtin-1' }); // file vanished: fall back
      return { id: 'builtin-1', dataUrl: null };
    }
    return { id, dataUrl: null };
  });
  handle('background:select', async (id) => {
    if (typeof id !== 'string' || !BACKGROUND_IDS.includes(id)) throw Object.assign(new Error('Неизвестный фон.'), { name: 'ValidationError', code: 'VALIDATION' });
    if (id === 'custom' && !(await backgrounds.hasCustom())) throw Object.assign(new Error('Свой фон ещё не выбран.'), { name: 'ValidationError', code: 'VALIDATION' });
    await settings.update({ background: id });
    return { id };
  });
  handle('background:setCustom', async (bytes) => {
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
      throw Object.assign(new Error('Не удалось прочитать изображение.'), { name: 'ValidationError', code: 'VALIDATION' });
    }
    const size = bytes.byteLength;
    if (size > MAX_BYTES) throw Object.assign(new Error('Файл слишком большой.'), { name: 'ValidationError', code: 'VALIDATION' });
    await backgrounds.saveCustom(bytes);
    await settings.update({ background: 'custom' });
    return { id: 'custom', dataUrl: await backgrounds.loadCustomDataUrl() };
  });

  handle('background:clear', async () => {
    await backgrounds.removeCustom();
    await settings.update({ background: 'builtin-1' });
    return { id: 'builtin-1', dataUrl: null };
  });

  handle('auth:status', async () => auth.status());
  handle('auth:login', async () => auth.login((code) => emitAuthCode(code)), { phase: 'login' });
  handle('auth:cancel', async () => ({ cancelled: auth.cancelLogin() }));
  handle('auth:logout', async () => auth.logout());
  handle('auth:select', async (uuid) => auth.selectAccount(uuid));
  handle('auth:remove', async (uuid) => auth.removeAccount(uuid));

  handle('game:play', async (input) => {
    if (!input || typeof input !== 'object') throw Object.assign(new Error('Некорректный запрос.'), { name: 'ValidationError', code: 'VALIDATION' });
    return game.play({
      version: input.version,
      repair: input.repair === true,
      ...(input.loader !== undefined ? { loader: input.loader } : {}),
      ...(input.loaderVersion !== undefined ? { loaderVersion: input.loaderVersion } : {}),
      ...(input.buildId !== undefined ? { buildId: input.buildId } : {})
    });
  });
  const bad = (message) => Object.assign(new Error(message), { name: 'ValidationError', code: 'VALIDATION' });
  handle('builds:list', async () => (builds ? builds.list() : []));
  handle('builds:create', async (input) => {
    if (!builds) throw bad('Сборки недоступны.');
    if (!input || typeof input !== 'object') throw bad('Некорректный запрос.');
    return builds.create({ name: input.name, mcVersion: input.mcVersion, loader: input.loader, loaderVersion: input.loaderVersion });
  });
  handle('builds:rename', async (id, name) => {
    if (!builds) throw bad('Сборки недоступны.');
    return builds.rename(id, name);
  });
  handle('builds:update', async (id, patch) => {
    if (!builds) throw bad('Сборки недоступны.');
    if (!patch || typeof patch !== 'object') throw bad('Некорректный запрос.');
    return builds.update(id, patch);
  });
  handle('builds:duplicate', async (id, name) => {
    if (!builds) throw bad('Сборки недоступны.');
    return builds.duplicate(id, name);
  });
  handle('builds:delete', async (id) => {
    if (!builds) throw bad('Сборки недоступны.');
    return builds.remove(id);
  });
  handle('builds:openFolder', async (id) => {
    if (!builds || !builds.openFolder) return { opened: false };
    await builds.openFolder(id);
    return { opened: true };
  });
  handle('builds:openModsFolder', async (id) => {
    if (!builds || !builds.openModsFolder) return { opened: false };
    await builds.openModsFolder(id);
    return { opened: true };
  });
  handle('modrinth:search', async (input) => {
    if (!modrinth) throw bad('Modrinth недоступен.');
    if (!input || typeof input !== 'object') throw bad('Некорректный запрос.');
    return modrinth.search({ query: input.query, mcVersion: input.mcVersion, loader: input.loader, category: input.category, sort: input.sort, limit: input.limit, offset: input.offset });
  });
  handle('modrinth:browse', async (input) => {
    if (!modrinth) throw bad('Modrinth недоступен.');
    if (!input || typeof input !== 'object' || typeof input.buildId !== 'string') throw bad('Некорректный запрос.');
    return modrinth.browse({ buildId: input.buildId, query: input.query, category: input.category, sort: input.sort, page: input.page, pageSize: input.pageSize });
  }, { phase: 'modrinth', quiet: true }); // a failed lookup is shown inside the window, it is not an incident
  handle('modrinth:addMod', async (input) => {
    if (!modrinth) throw bad('Modrinth недоступен.');
    if (!input || typeof input !== 'object' || !input.buildId || !input.projectId) throw bad('Некорректный запрос.');
    return modrinth.addMod({ buildId: input.buildId, projectId: input.projectId, versionId: input.versionId || null, title: input.title || '', iconUrl: input.iconUrl || '' });
  });
  handle('modrinth:listInstalled', async (buildId) => {
    if (!modrinth) return [];
    return modrinth.listInstalled(buildId);
  });
  handle('modrinth:removeMod', async (buildId, filename) => {
    if (!modrinth) throw bad('Modrinth недоступен.');
    return modrinth.removeMod(buildId, filename);
  });
  handle('mrpack:importUrl', async (input) => {
    if (!mrpack) throw bad('Импорт модпаков недоступен.');
    if (!input || typeof input !== 'object' || !input.url) throw bad('Укажите ссылку на модпак.');
    return mrpack.importPack({ url: input.url, name: input.name || '' });
  });
  handle('mrpack:importFile', async (bytes, name) => {
    if (!mrpack) throw bad('Импорт модпаков недоступен.');
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) throw bad('Не удалось прочитать файл модпака.');
    if (bytes.byteLength > MAX_MRPACK_BYTES) throw bad('Файл модпака слишком большой.');
    return mrpack.importPack({ buffer: Buffer.from(bytes), name: name || '' });
  });
  handle('loaders:list', async (loader, mcVersion) => {
    if (!loaders) throw bad('Загрузчики недоступны.');
    if (typeof loader !== 'string' || typeof mcVersion !== 'string') throw bad('Некорректный запрос.');
    return loaders.listVersions(loader, mcVersion);
  }, { phase: 'loader', quiet: true }); // a failed lookup is shown inline, it is not an incident
  handle('java:list', async () => {
    if (!javaManager) throw bad('Менеджер Java недоступен.');
    return javaManager.info();
  });
  handle('java:install', async (major) => {
    if (!javaManager) throw bad('Менеджер Java недоступен.');
    if (!Number.isInteger(major)) throw bad('Некорректная версия Java.');
    return javaManager.install(major);
  }, { phase: 'java-install' });
  handle('java:remove', async (major) => {
    if (!javaManager) throw bad('Менеджер Java недоступен.');
    if (!Number.isInteger(major)) throw bad('Некорректная версия Java.');
    return javaManager.remove(major);
  });
  handle('java:cancel', async () => ({ cancelled: javaManager ? javaManager.cancel() : false }));
  handle('visual:info', async () => {
    if (!visual) throw bad('Визуальный мод недоступен.');
    return visual.info();
  });
  handle('visual:openFolder', async () => {
    if (!visual || !visual.openFolder) return { opened: false };
    await visual.openFolder(); // always the fixed visual-mod folder; the renderer cannot choose a path
    return { opened: true };
  });
  handle('errors:list', async () => (reporter ? reporter.list(15) : []));
  handle('errors:openFolder', async () => {
    if (!errors || !errors.openFolder) return { opened: false };
    await errors.openFolder(); // always the fixed errors folder; the renderer cannot choose a path
    return { opened: true };
  });

  handle('game:cancel', async () => ({ cancelled: game.cancel() }));
  handle('game:state', async () => game.state());
  handle('game:openFolder', async () => {
    if (!game.openFolder) return { opened: false };
    await game.openFolder();
    return { opened: true };
  });
  handle('game:openModsFolder', async () => {
    if (!game.openModsFolder) return { opened: false };
    await game.openModsFolder();
    return { opened: true };
  });

  return channels;
}

module.exports = { registerIpc, toPublicError };
