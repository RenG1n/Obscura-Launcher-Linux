'use strict';
// Persistent, validated launcher settings. The renderer can only change fields
// through validated patches; invalid values on disk fall back to defaults.
const fs = require('node:fs');
const path = require('node:path');

const VERSION_ALIASES = ['release', 'snapshot'];
const BACKGROUND_IDS = ['builtin-1', 'builtin-2', 'builtin-3', 'custom'];
const RAM_MIN_GB = 2;
const RAM_MAX_GB = 16;
// Minecraft version ids: "1.21.8", "25w14craftmine", "1.21.5-pre1", "b1.7.3" ...
const LOADER_IDS = ['vanilla', 'fabric', 'forge', 'quilt', 'neoforge'];
const LOADER_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;
// Visual mod mode: the game version and the loader are fixed by the mod itself.
const VISUAL_PROFILE = Object.freeze({ mcVersion: '1.21.11', loader: 'fabric', loaderVersion: '' });
const VISUAL_LOCKED_KEYS = Object.freeze(['version', 'loader', 'loaderVersion']);
const VERSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const DEFAULTS = Object.freeze({
  version: 'release',
  ramGb: 4,
  background: 'builtin-1',
  javaPath: null,
  authMode: 'microsoft',
  localUsername: 'Player',
  loader: 'vanilla',
  loaderVersion: '',
  autoJava: true,
  closeLauncherOnGameStart: false,
  visualMode: false,
});

const validators = {
  version(v) {
    if (typeof v !== 'string' || !(VERSION_ALIASES.includes(v) || VERSION_ID_RE.test(v))) {
      throw new ValidationError('Недопустимая версия Minecraft.');
    }
    return v;
  },
  ramGb(v) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < RAM_MIN_GB || v > RAM_MAX_GB) {
      throw new ValidationError(`Память должна быть целым числом от ${RAM_MIN_GB} до ${RAM_MAX_GB} GB.`);
    }
    return v;
  },
  background(v) {
    if (!BACKGROUND_IDS.includes(v)) throw new ValidationError('Неизвестный фон.');
    return v;
  },
  authMode(v) {
    if (!['microsoft', 'local'].includes(v)) throw new ValidationError('Неизвестный режим авторизации.');
    return v;
  },
  localUsername(v) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(v)) throw new ValidationError('Ник локального профиля должен содержать 3–16 символов: латинские буквы, цифры или _.');
    return v;
  },
  loader(v) {
    if (!LOADER_IDS.includes(v)) throw new ValidationError('Неизвестный загрузчик.');
    return v;
  },
  loaderVersion(v) {
    if (v !== '' && !(typeof v === 'string' && LOADER_VERSION_RE.test(v))) throw new ValidationError('Недопустимая версия загрузчика.');
    return v;
  },
  autoJava(v) {
    if (typeof v !== 'boolean') throw new ValidationError('Автоустановка Java: значение должно быть «вкл» или «выкл».');
    return v;
  },
  closeLauncherOnGameStart(v) {
    if (typeof v !== 'boolean') throw new ValidationError('Параметр закрытия лаунчера должен быть включён или выключен.');
    return v;
  },
  visualMode(v) {
    if (typeof v !== 'boolean') throw new ValidationError('Визуальный мод: значение должно быть «вкл» или «выкл».');
    return v;
  },
  javaPath(v) {
    if (v === null) return null;
    if (typeof v !== 'string' || v.length === 0 || v.length > 1024 || v.includes('\0')) {
      throw new ValidationError('Недопустимый путь к Java.');
    }
    if (!path.isAbsolute(v) && !path.win32.isAbsolute(v)) throw new ValidationError('Путь к Java должен быть абсолютным.');
    const base = (path.win32.basename(v) || '').toLowerCase();
    if (!['java', 'java.exe', 'javaw.exe'].includes(base)) {
      throw new ValidationError('Укажите исполняемый файл java или java.exe.');
    }
    return v;
  }
};

/** Validate a patch; throws ValidationError. Unknown keys are rejected. */
function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('Некорректные настройки.');
  }
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(validators, key)) {
      throw new ValidationError(`Неизвестная настройка: ${String(key).slice(0, 40)}`);
    }
    out[key] = validators[key](value);
  }
  return out;
}

/** Lenient sanitize used when loading from disk: bad fields fall back to defaults. */
function sanitize(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of Object.keys(validators)) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      try { out[key] = validators[key](raw[key]); } catch { /* keep default */ }
    }
  }
  return out;
}

class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    this._queue = Promise.resolve();
  }
  async load() {
    try {
      const text = await fs.promises.readFile(this.file, 'utf8');
      this.data = sanitize(JSON.parse(text));
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // Corrupted file: keep a copy for inspection and start from defaults.
        try { await fs.promises.rename(this.file, `${this.file}.corrupt`); } catch { /* ignore */ }
      }
      this.data = { ...DEFAULTS };
    }
    return this.get();
  }
  get() {
    return { ...this.data };
  }
  async update(patch) {
    const valid = validatePatch(patch);
    // While the visual mod is on, the version and the loader belong to it. The patch may
    // switch the mode off (and then change them in the same call), nothing else may touch them.
    if (this.data.visualMode && valid.visualMode !== false) {
      const locked = VISUAL_LOCKED_KEYS.find((key) => Object.prototype.hasOwnProperty.call(valid, key));
      if (locked) throw new ValidationError(`Включён визуальный мод: версия игры и загрузчик зафиксированы (Minecraft ${VISUAL_PROFILE.mcVersion}, Fabric). Выключите его, чтобы выбрать другую версию.`);
    }
    this.data = { ...this.data, ...valid };
    await this._persist();
    return this.get();
  }
  _persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    // Serialize writes; write to a temp file then rename so a crash never leaves a half-written file.
    this._queue = this._queue.then(async () => {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, snapshot, 'utf8');
      await fs.promises.rename(tmp, this.file);
    });
    return this._queue;
  }
}

module.exports = {
  SettingsStore, ValidationError, validatePatch, sanitize, DEFAULTS,
  VERSION_ALIASES, BACKGROUND_IDS, LOADER_IDS, LOADER_VERSION_RE, RAM_MIN_GB, RAM_MAX_GB, VERSION_ID_RE,
  VISUAL_PROFILE, VISUAL_LOCKED_KEYS
};
