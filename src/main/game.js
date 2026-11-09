'use strict';
// Orchestrates one "Play" press: resolve version -> install if needed ->
// check account -> pick Java -> validate RAM -> launch.
// All collaborators are injected so the flow can be tested without Electron,
// the network or Minecraft. Every failure is turned into a numbered report
// (see errors.js) that carries the context in which it happened.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validatePatch, VISUAL_PROFILE } = require('./settings');
const { majorForRequired } = require('./runtime');

const LOADER_LABEL = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', quilt: 'Quilt', neoforge: 'NeoForge' };

class GameError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'GameError';
    this.code = code;
  }
}

const MARKER = '.obscura-installed';
const OUTPUT_LINES = 60;

/** Java major version a game version needs. Loader profiles inherit it from vanilla; versions older than 1.17 do not declare one: Java 8. */
function readRequiredJavaMajor(gameDir, id, fsImpl = fs, depth = 0) {
  try {
    const json = JSON.parse(fsImpl.readFileSync(path.join(gameDir, 'versions', id, `${id}.json`), 'utf8'));
    const own = json && json.javaVersion && json.javaVersion.majorVersion;
    const parent = typeof json.inheritsFrom === 'string' && depth < 3 ? readRequiredJavaMajor(gameDir, json.inheritsFrom, fsImpl, depth + 1) : 0;
    const major = Number.isInteger(own) && own > 0 ? Math.max(own, parent) : (parent || 8);
    return major;
  } catch {
    return 8;
  }
}

function isInstalled(gameDir, id, fsImpl = fs) {
  const dir = path.join(gameDir, 'versions', id);
  return ['.json', '.jar'].every((ext) => fsImpl.existsSync(path.join(dir, `${id}${ext}`))) &&
    fsImpl.existsSync(path.join(dir, MARKER));
}

function createGameService(deps) {
  const { settings, versions, auth, java, ram, installer, launcher, gameDir, logger, emit, reporter = null, fsImpl = fs, runtime = null, loaders = null, builds = null, visual = null } = deps;
  let busy = null;      // { abort: AbortController }
  let running = null;   // { pid }

  const send = (event) => { try { emit(event); } catch { /* UI may be gone */ } };
  const report = (err, ctx) => { try { return reporter ? reporter.report(err, ctx) : null; } catch { return null; } };

  async function play(input) {
    if (busy) throw new GameError('BUSY', 'Подготовка к запуску уже идёт.');
    if (running) throw new GameError('RUNNING', 'Игра уже запущена.');
    const abort = new AbortController();
    busy = { abort };
    const ctx = { phase: 'start', requestedVersion: input && typeof input.version === 'string' ? input.version : undefined };
    try {
      let buildDir = null;
      let visualOn = false;
      if (input && input.buildId) {
        if (!builds) throw new GameError('BUILDS_UNAVAILABLE', 'Сборки недоступны.');
        let build;
        try { build = builds.get(input.buildId); } catch (err) {
          throw new GameError(err && err.code === 'NOT_FOUND' ? 'BUILD_NOT_FOUND' : 'VALIDATION', (err && err.message) || 'Недопустимая сборка.', { cause: err });
        }
        ctx.buildId = build.id;
        ctx.requestedVersion = build.mcVersion;
        buildDir = builds.folder(build.id);
        input = { ...input, version: build.mcVersion, loader: build.loader, loaderVersion: build.loaderVersion || undefined };
      } else if (settings.get().visualMode) {
        // Visual mod mode: Minecraft and the loader are fixed by the mod, and it has its own folder.
        // This is decided here, from the saved setting, so no request from the page can change it.
        if (!visual) throw new GameError('VISUAL_FAILED', 'Визуальный мод недоступен в этой копии лаунчера.');
        visualOn = true;
        ctx.visual = true;
        ctx.requestedVersion = VISUAL_PROFILE.mcVersion;
        buildDir = visual.folder();
        input = { ...(input || {}), version: VISUAL_PROFILE.mcVersion, loader: VISUAL_PROFILE.loader, loaderVersion: undefined };
      }
      const { version } = validatePatch({ version: input && input.version });
      const s = settings.get();
      const wanted = {};
      if (input && input.loader !== undefined) wanted.loader = input.loader;
      if (input && input.loaderVersion !== undefined) wanted.loaderVersion = input.loaderVersion;
      const picked = validatePatch(wanted);
      const loader = picked.loader !== undefined ? picked.loader : s.loader;
      const loaderVersion = picked.loaderVersion !== undefined ? picked.loaderVersion : (picked.loader !== undefined ? '' : s.loaderVersion);
      ctx.ramGb = s.ramGb;
      ctx.loader = loader;
      if (loader !== 'vanilla' && !loaders) throw new GameError('LOADER_FAILED', 'Поддержка загрузчиков недоступна.');

      // 1. Resolve the requested version through Mojang's manifest.
      ctx.phase = 'resolving';
      send({ type: 'status', phase: 'resolving', message: 'Проверяю версию…' });
      let meta;
      try {
        const { manifest } = await versions.getManifest();
        meta = versions.resolve(manifest, version);
      } catch (err) {
        // Offline: an exact id that is already fully installed can still be launched.
        if (err && err.code === 'NETWORK' && !['release', 'snapshot'].includes(version) && isInstalled(gameDir, version, fsImpl)) {
          meta = { id: version };
        } else {
          throw new GameError(err.code || 'VERSION', err.message, { cause: err });
        }
      }
      ctx.resolvedVersion = meta.id;

      // 2. Install (first run of a version only; `repair` forces a re-check).
      if ((input && input.repair === true) || !isInstalled(gameDir, meta.id, fsImpl)) {
        ctx.phase = 'installing';
        send({ type: 'status', phase: 'installing', message: `Устанавливаю Minecraft ${meta.id}…`, progress: null });
        const attempts = Math.max(1, deps.installAttempts || 3);
        for (let attempt = 1; ; attempt++) {
          try {
            await installer.install(meta, gameDir, {
              signal: abort.signal,
              onProgress: (p) => send({ type: 'progress', phase: 'installing', ...p })
            });
            break;
          } catch (err) {
            if (abort.signal.aborted) throw new GameError('CANCELLED', 'Установка отменена.');
            logger.error(`Install attempt ${attempt}/${attempts} failed:\n${logger.describe(err)}`);
            if (attempt >= attempts) {
              const detail = logger.describe(err).split('\n').slice(0, 3).join(' ').slice(0, 280);
              ctx.attempts = attempts;
              throw new GameError('INSTALL_FAILED', `Не удалось установить Minecraft ${meta.id} (попыток: ${attempts}): ${detail}`, { cause: err });
            }
            send({ type: 'status', phase: 'installing', message: `Сбой сети, повтор ${attempt + 1} из ${attempts}…`, progress: null });
            await new Promise((resolve) => setTimeout(resolve, deps.retryDelayMs ?? 2500));
            if (abort.signal.aborted) throw new GameError('CANCELLED', 'Установка отменена.');
          }
        }
        if (abort.signal.aborted) throw new GameError('CANCELLED', 'Установка отменена.');
        if (!fsImpl.existsSync(path.join(gameDir, 'versions', meta.id, `${meta.id}.jar`))) {
          throw new GameError('INSTALL_FAILED', 'Установка завершилась, но файлы игры не найдены.');
        }
        await fsImpl.promises.writeFile(path.join(gameDir, 'versions', meta.id, MARKER), new Date().toISOString());
      }

      // 3. Account. Local profiles are for offline/local play only; they do not authenticate
      // with Microsoft or grant access to authenticated online servers.
      ctx.phase = 'auth';
      let session;
      if (s.authMode === 'local') {
        const name = s.localUsername;
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name || '')) throw new GameError('INVALID_LOCAL_NAME', 'Ник локального профиля должен содержать 3–16 латинских букв, цифр или _.');
        const hex = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest('hex').split('');
        hex[12] = '3'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
        const raw = hex.join('');
        session = { name, uuid: `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`, accessToken: '0', userType: 'offline' };
        send({ type: 'status', phase: 'auth', message: `Локальный профиль: ${name} (офлайн-режим)…` });
      } else {
        send({ type: 'status', phase: 'auth', message: 'Проверяю аккаунт Microsoft…' });
        session = await auth.getSession(); // throws AuthError when login is required
      }

      // 4. Java (downloaded automatically when missing and "Автоустановка Java" is on).
      ctx.phase = 'java';
      send({ type: 'status', phase: 'java', message: 'Ищу подходящую Java…' });
      const ensureJava = async (requiredMajor) => {
        ctx.requiredJava = requiredMajor;
        const detect = async () => {
          const managed = runtime ? runtime.list().map((r) => r.path) : [];
          const found = await java.detectJava({ extraPath: s.javaPath, extraPaths: managed });
          ctx.foundJava = found.map((j) => j.major).join(', ') || 'нет';
          return found;
        };
        let installs = await detect();
        let pick = java.pickJava(installs, requiredMajor, s.javaPath);
        // A Java 8 found on the system (not ours, not the user's explicit pick) can
        // carry a stale cacerts/TLS stack. Asset and library downloads still work
        // fine — the launcher does those itself over its own networking — but
        // anything the game process fetches over HTTPS, notably a server-pushed
        // resource pack, can silently fail the handshake while everything else
        // looks normal. For this one legacy bucket, try to get our own fresh Java 8
        // instead, falling back to the system one we already found if that fails.
        const needsFreshJava8 = pick && requiredMajor <= 8 && pick.source !== 'obscura' && pick.path !== s.javaPath;
        if (pick && !needsFreshJava8) return pick;
        if (pick && needsFreshJava8 && !(runtime && s.autoJava)) return pick;
        if (runtime && s.autoJava) {
          const major = majorForRequired(requiredMajor);
          ctx.phase = 'java-install';
          ctx.javaDownload = major;
          send({ type: 'status', phase: 'java', message: `Скачиваю Java ${major} (Eclipse Temurin)…`, progress: null });
          try {
            await runtime.install(major, { signal: abort.signal, onProgress: (p) => send({ type: 'progress', phase: 'java', percent: p.percent, message: p.message }) });
          } catch (err) {
            if (abort.signal.aborted || (err && err.code === 'CANCELLED')) throw new GameError('CANCELLED', 'Установка отменена.');
            if (pick) return pick; // already had a usable (if older) Java — don't block launch on this
            if (err && ['JAVA_INSTALL_FAILED', 'JAVA_EXTRACT', 'BUSY'].includes(err.code)) throw new GameError(err.code === 'BUSY' ? 'JAVA_INSTALL_FAILED' : err.code, err.message, { cause: err });
            throw new GameError('JAVA_INSTALL_FAILED', `Не удалось скачать Java ${major}: ${logger.describe(err).split('\n')[0].slice(0, 240)}`, { cause: err });
          }
          ctx.phase = 'java';
          installs = await detect();
          pick = java.pickJava(installs, requiredMajor, s.javaPath);
          if (pick) return pick;
        }
        if (pick) return pick;
        const found = installs.length ? ` Найдено: ${installs.map((j) => j.major).join(', ')}.` : ' Java не найдена.';
        throw new GameError('JAVA_MISSING', `Для Minecraft ${meta.id} нужна Java ${requiredMajor}${requiredMajor <= 8 ? ' (именно 8)' : ' или новее'}.${found} Включите «Автоустановка Java» или установите Java в «Настройки → Java».`);
      };
      let chosen = await ensureJava(readRequiredJavaMajor(gameDir, meta.id, fsImpl));
      ctx.javaPath = chosen.path;
      ctx.javaVersion = chosen.version;

      // 4b. Mod loader (Fabric / Forge): installed on top of the vanilla version.
      let launchId = meta.id;
      if (loader !== 'vanilla') {
        ctx.phase = 'loader';
        const label = LOADER_LABEL[loader] || loader;
        send({ type: 'status', phase: 'loader', message: `Проверяю ${label}…`, progress: null });
        try {
          launchId = await loaders.ensure(loader, meta.id, loaderVersion, {
            signal: abort.signal, javaPath: chosen.path, repair: Boolean(input && input.repair === true),
            onProgress: (p) => send({ type: 'progress', phase: 'loader', percent: p.percent, message: p.message || `Устанавливаю ${label}…` })
          });
        } catch (err) {
          if (abort.signal.aborted || (err && err.code === 'CANCELLED')) throw new GameError('CANCELLED', 'Установка отменена.');
          const offline = loaders.findInstalled ? loaders.findInstalled(loader, meta.id, loaderVersion) : null;
          if (offline && err && /^NET_(FAILED|TIMEOUT|HTTP)$/.test(String(err.code))) {
            logger.warn(`Loader check failed (${err.code}); using the installed ${offline}`);
            launchId = offline;
          } else {
            throw err;
          }
        }
        ctx.launchVersion = launchId;
        // The loader may need a newer Java than vanilla alone (e.g. a loader built for Java 21).
        const needed = readRequiredJavaMajor(gameDir, launchId, fsImpl);
        if (needed > chosen.major && !java.pickJava([chosen], needed, s.javaPath)) {
          ctx.phase = 'java';
          chosen = await ensureJava(needed);
          ctx.javaPath = chosen.path;
          ctx.javaVersion = chosen.version;
        }
      }

      // 4c. Visual mod: copy the shipped jar into its own mods folder (and Fabric API when it needs it).
      if (visualOn) {
        ctx.phase = 'visual';
        send({ type: 'status', phase: 'visual', message: 'Готовлю визуальный мод…', progress: null });
        let prepared;
        try {
          prepared = await visual.prepare({ signal: abort.signal });
        } catch (err) {
          if (abort.signal.aborted || (err && err.code === 'CANCELLED')) throw new GameError('CANCELLED', 'Установка отменена.');
          throw err;
        }
        for (const message of (prepared && prepared.warnings) || []) send({ type: 'warning', message });
      }

      // 5. Memory, validated against the real machine.
      const memory = ram.validateRam(s.ramGb, ram.getMemoryInfo(), { javaIs64Bit: chosen.is64Bit });
      if (!memory.ok) throw new GameError('RAM_INVALID', memory.error);
      for (const warning of memory.warnings) send({ type: 'warning', message: warning });

      // 6. Launch.
      ctx.phase = 'launching';
      send({ type: 'status', phase: 'launching', message: 'Запускаю игру…' });
      logger.info(`Launching ${launchId} with Java ${chosen.version} (${chosen.path}), ${memory.valueGb} GB`);
      const child = await launcher.launch({
        gameDir,
        gamePath: buildDir || gameDir,
        resourcePath: gameDir,
        version: launchId,
        javaPath: chosen.path,
        maxMemoryMb: memory.valueGb * 1024,
        minMemoryMb: Math.min(1024, memory.valueGb * 1024),
        session
      });
      running = { pid: child.pid };
      const gameCtx = { ...ctx, phase: 'game' };
      const recent = [];
      const pipe = (stream, level) => {
        if (!stream) return;
        stream.on('data', (chunk) => {
          for (const line of String(chunk).split(/\r?\n/)) {
            if (!line.trim()) continue;
            logger[level](`[game] ${line}`);
            recent.push(line);
            if (recent.length > OUTPUT_LINES) recent.shift();
          }
        });
      };
      pipe(child.stdout, 'info');
      pipe(child.stderr, 'warn');
      child.on('error', (err) => {
        running = null;
        const r = report(new GameError('LAUNCH_FAILED', 'Не удалось запустить процесс Java.', { cause: err }), { ...gameCtx, phase: 'launching' });
        send({ type: 'error', code: 'LAUNCH_FAILED', message: 'Не удалось запустить процесс Java.', report: r });
      });
      child.on('exit', (code) => {
        running = null;
        logger.info(`Game exited with code ${code}`);
        if (typeof code === 'number' && code !== 0) {
          const err = new GameError('GAME_EXIT', `Игра завершилась с кодом ${code}.`);
          const r = report(err, { ...gameCtx, exitCode: code, output: logger.safe(recent.join('\n')) });
          send({ type: 'exited', code, message: `Игра завершилась с кодом ${code}.`, report: r });
        } else {
          send({ type: 'exited', code, message: 'Игра закрыта.' });
        }
      });
      send({ type: 'status', phase: 'running', message: `Minecraft ${meta.id}${loader !== 'vanilla' ? ` (${LOADER_LABEL[loader] || loader})` : ''}${visualOn ? ' · визуальный мод' : ''} запущен.`, pid: child.pid });
      return { version: launchId, pid: child.pid };
    } catch (err) {
      if (err && typeof err === 'object' && err.code !== 'CANCELLED') report(err, ctx);
      throw err;
    } finally {
      busy = null;
    }
  }

  return {
    play,
    cancel() {
      if (!busy) return false;
      busy.abort.abort();
      return true;
    },
    state() {
      return { busy: Boolean(busy), running: Boolean(running), pid: running ? running.pid : null };
    }
  };
}

module.exports = { createGameService, GameError, isInstalled, readRequiredJavaMajor, MARKER };
