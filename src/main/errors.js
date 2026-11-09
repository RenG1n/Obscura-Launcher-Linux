'use strict';
// Numbered error catalog + reporter.
//   * Every problem gets a stable code (OBS-xxx) with a plain-language cause and a fix.
//   * Every occurrence gets a running incident number and a report file in <userData>\errors\
//     containing the cause, the fix, the context and the (redacted) technical details.
// Ranges: 1xx network/installation, 2xx account, 3xx Java/memory, 4xx game process,
//         5xx settings/files, 9xx internal.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describeError } = require('./logger');

const CATALOG = Object.freeze({
  'OBS-101': { title: 'Нет связи с серверами Mojang', dialog: true,
    cause: 'Лаунчеру не удалось подключиться к серверу, с которого скачиваются файлы игры: нет интернета, адрес блокирует провайдер, антивирус или брандмауэр, либо включён неработающий VPN или прокси.',
    fix: 'Проверьте интернет и отключите VPN/прокси на время установки. Выполните «npm run doctor» — он покажет, какой именно адрес не открывается. Добавьте Obscura в исключения антивируса и брандмауэра и повторите.' },
  'OBS-102': { title: 'Ошибка сертификата при загрузке', dialog: true,
    cause: 'Соединение с сервером отклонено из-за недоверенного сертификата. Так бывает, если антивирус или программа безопасности подменяет HTTPS-трафик, либо на компьютере неверно выставлены дата и время.',
    fix: 'Проверьте дату и время в системе. Временно отключите проверку HTTPS в антивирусе или добавьте Obscura в исключения, затем повторите.' },
  'OBS-103': { title: 'Сервер ответил ошибкой', dialog: true,
    cause: 'Сервер Mojang или Microsoft получил запрос, но вернул код ошибки (например, 403 — доступ закрыт, 429 — слишком много запросов, 5xx — сбой на стороне сервера).',
    fix: 'Подождите несколько минут и повторите. Если код 403 повторяется, адрес может быть закрыт для вашей сети или региона — попробуйте другой интернет.' },
  'OBS-104': { title: 'Не хватает места на диске', dialog: true,
    cause: 'При записи файлов система сообщила, что на диске закончилось свободное место. Игре с ресурсами нужно около 1 ГБ.',
    fix: 'Освободите место на диске, где лежат данные Obscura (Windows: %APPDATA%, Linux: ~/.config), и повторите установку.' },
  'OBS-105': { title: 'Нет прав на запись или файл занят', dialog: true,
    cause: 'Система не разрешила записать или изменить файл: папка защищена антивирусом («контролируемый доступ к папкам» в Windows), файл открыт другой программой или нет прав на запись.',
    fix: 'Закройте другие окна Minecraft, добавьте папку данных Obscura (Windows: %APPDATA%\\Obscura, Linux: ~/.config/Obscura) в исключения антивируса и проверьте права на запись, затем повторите.' },
  'OBS-106': { title: 'Скачанный файл повреждён', dialog: true,
    cause: 'Контрольная сумма скачанного файла не совпала с ожидаемой. Файл мог оборваться из-за нестабильного соединения.',
    fix: 'Повторите установку: лаунчер перекачает только повреждённые файлы. Если повторяется — смените сеть.' },
  'OBS-107': { title: 'Версия Minecraft не найдена', dialog: true,
    cause: 'Выбранной версии нет в официальном списке Mojang (она могла быть удалена или название введено неверно).',
    fix: 'Выберите версию из списка в лаунчере.' },
  'OBS-108': { title: 'Не удалось получить список версий', dialog: true,
    cause: 'Лаунчер не смог загрузить официальный список версий Minecraft, а сохранённой копии на диске ещё нет.',
    fix: 'Проверьте интернет (и отключите VPN), затем перезапустите лаунчер. После первого успешного запуска список сохраняется и доступен без сети.' },
  'OBS-109': { title: 'Установка не создала файлы игры', dialog: true,
    cause: 'Установка завершилась без ошибки, но нужные файлы версии не появились. Скорее всего, их удалил антивирус.',
    fix: 'Добавьте папку данных Obscura (Windows: %APPDATA%\\Obscura, Linux: ~/.config/Obscura) в исключения антивируса и повторите установку.' },
  'OBS-110': { title: 'Загрузчик недоступен для этой версии', dialog: true,
    cause: 'Для выбранной версии Minecraft нет официальной сборки Fabric или Forge (или выбранной версии загрузчика нет в списке).',
    fix: 'Выберите другую версию Minecraft или другой загрузчик. Fabric обычно выходит для всех релизов, Forge — только для части версий.' },
  'OBS-111': { title: 'Не удалось установить загрузчик', dialog: true,
    cause: 'Fabric или Forge не установился: сервер загрузчика недоступен, файл не прошёл проверку, либо установщик Forge завершился с ошибкой.',
    fix: 'Повторите запуск. Если ошибка повторяется, откройте файл отчёта: в нём последние строки вывода установщика. Можно запустить игру без загрузчика (Vanilla).' },
  'OBS-112': { title: 'Адрес загрузки заблокирован защитой лаунчера', dialog: true,
    cause: 'Сервер вернул адрес, которого нет в списке разрешённых (лаунчер скачивает файлы только с официальных серверов Mojang, Fabric, Forge и Adoptium).',
    fix: 'Повторите позже. Если ошибка повторяется, отправьте файл отчёта: возможно, ваша сеть подменяет ответы серверов.' },
  'OBS-199': { title: 'Установка игры не удалась', dialog: true,
    cause: 'Во время скачивания или установки произошла ошибка, которую лаунчер не смог отнести к известной причине.',
    fix: 'Повторите установку. Если ошибка повторяется, отправьте файл отчёта из папки ошибок.' },

  'OBS-201': { title: 'Нужно войти в аккаунт Microsoft', dialog: false,
    cause: 'Для запуска игры нужен вход в аккаунт Microsoft с купленной Minecraft: Java Edition. Вход ещё не выполнен или сессия истекла.',
    fix: 'Нажмите «•••» у профиля слева внизу и войдите по коду.' },
  'OBS-202': { title: 'Не удалось войти в аккаунт', dialog: true,
    cause: 'Вход через Microsoft/Xbox/Minecraft не завершился: код не был введён вовремя, вход отклонён или сервис вернул ошибку.',
    fix: 'Повторите вход и введите код на странице microsoft.com/link в течение нескольких минут. Если ошибка повторяется, откройте файл отчёта — в нём точная причина.' },
  'OBS-203': { title: 'На аккаунте нет Minecraft: Java Edition', dialog: true,
    cause: 'Аккаунт Microsoft вошёл успешно, но к нему не привязана лицензия Minecraft: Java Edition (или аккаунт детский и требует разрешения родителей в Xbox).',
    fix: 'Войдите в тот аккаунт, на котором куплена игра, либо приобретите её на minecraft.net. Для детского аккаунта проверьте семейные разрешения Xbox.' },
  'OBS-204': { title: 'Вход уже выполняется', dialog: false,
    cause: 'Окно входа уже открыто.', fix: 'Завершите или отмените текущий вход.' },
  'OBS-205': { title: 'Нет связи с серверами Microsoft/Xbox', dialog: true,
    cause: 'При входе лаунчер не смог подключиться к серверам Microsoft, Xbox или Minecraft. Причина — интернет, VPN, антивирус или блокировка адреса.',
    fix: 'Проверьте интернет, отключите VPN и выполните «npm run doctor» — раздел «Доступность серверов» покажет, какой адрес закрыт.' },

  'OBS-301': { title: 'Не найдена подходящая Java', dialog: true,
    cause: 'Для выбранной версии Minecraft нужна определённая Java, а на компьютере её нет: Minecraft 1.20.5 и новее требует Java 21, 1.18–1.20.4 — Java 17, 1.17 — Java 16, 1.16.5 и старше — Java 8.',
    fix: 'Включите «Автоустановка Java» или нажмите «Установить» нужную версию в «Настройки → Java». Можно также установить Java 64-bit (например, Eclipse Temurin с adoptium.net) вручную. Найденные версии видно в «Настройки → Java».' },
  'OBS-302': { title: 'Недопустимый объём памяти', dialog: true,
    cause: 'Выбранный объём оперативной памяти больше, чем можно выделить на этом компьютере (1 ГБ всегда остаётся системе), либо Java 32-bit не может использовать больше 1 ГБ.',
    fix: 'Уменьшите ползунок памяти на главной странице. Для Java 32-bit установите 64-битную Java.' },

  'OBS-310': { title: 'Не удалось установить Java', dialog: true,
    cause: 'Автоматическая загрузка Java (Eclipse Temurin с adoptium.net) не удалась: нет связи с серверами Adoptium/GitHub, файл не прошёл проверку SHA-256 или не хватило места.',
    fix: 'Проверьте интернет и повторите. Если сеть ограничена, установите Java вручную (adoptium.net) или выберите файл java (Linux) / java.exe (Windows) в настройках.' },
  'OBS-311': { title: 'Скачанная Java не запускается', dialog: true,
    cause: 'Java скачана и проверена, но не распаковалась или не запускается: антивирус мог заблокировать файлы либо в системе нет утилиты tar.',
    fix: 'Добавьте папку данных Obscura (Windows: %APPDATA%\\Obscura, Linux: ~/.config/Obscura) в исключения антивируса и повторите установку в «Настройки → Java». Лаунчер использует tar (есть в Linux и в Windows 10 1803+) или PowerShell.' },

  'OBS-401': { title: 'Игра завершилась с ошибкой', dialog: true,
    cause: 'Minecraft запустился, но закрылся с ненулевым кодом — произошёл сбой в самой игре или в её библиотеках.',
    fix: 'Откройте файл отчёта: в нём последние строки вывода игры. Попробуйте другую версию Java, меньше памяти или переустановите версию.' },
  'OBS-402': { title: 'Java слишком старая для этой версии', dialog: true,
    cause: 'Игра собрана для более новой Java, чем та, что запустила её (ошибка UnsupportedClassVersionError).',
    fix: 'Установите Java нужной версии (см. «Настройки → Java») и повторите.' },
  'OBS-403': { title: 'Java не смогла стартовать', dialog: true,
    cause: 'Виртуальная машина Java отказалась запуститься: чаще всего выбран слишком большой объём памяти или Java 32-bit.',
    fix: 'Уменьшите объём памяти на главной странице и используйте Java 64-bit.' },
  'OBS-404': { title: 'Игре не хватило памяти', dialog: true,
    cause: 'Minecraft исчерпал выделенную память (OutOfMemoryError).',
    fix: 'Увеличьте объём памяти на главной странице (если позволяет компьютер) и закройте лишние программы.' },
  'OBS-405': { title: 'Не удалось запустить процесс Java', dialog: true,
    cause: 'Система не смогла запустить найденный файл Java: он удалён, повреждён или заблокирован антивирусом.',
    fix: 'Переустановите Java и добавьте её в исключения антивируса.' },
  'OBS-406': { title: 'Игра уже запускается', dialog: false,
    cause: 'Подготовка к запуску или сама игра уже работает.', fix: 'Дождитесь окончания или нажмите «Отмена».' },

  'OBS-501': { title: 'Недопустимое значение настройки', dialog: false,
    cause: 'Введено значение, которое лаунчер не принимает.', fix: 'Выберите значение из допустимого диапазона.' },
  'OBS-502': { title: 'Изображение для фона отклонено', dialog: false,
    cause: 'Файл не удалось прочитать как изображение или он слишком большой.', fix: 'Выберите другое изображение (PNG, JPEG, WebP, GIF, BMP, AVIF, SVG).' },

  'OBS-503': { title: 'Не удалось подготовить визуальный мод', dialog: true,
    cause: 'Лаунчер не смог скопировать файл визуального мода в его папку: файл мода отсутствует или повреждён в поставке лаунчера, нет прав на запись либо диск заполнен.',
    fix: 'Закройте игру и повторите запуск. Если ошибка остаётся, переустановите лаунчер и проверьте права на папку данных Obscura. Пока можно выключить переключатель визуального мода и играть без него.' },

  'OBS-900': { title: 'Внутренняя ошибка лаунчера', dialog: true,
    cause: 'В самом лаунчере произошёл непредвиденный сбой.',
    fix: 'Перезапустите лаунчер. Если ошибка повторяется, отправьте файл отчёта из папки ошибок.' },
  'OBS-901': { title: 'Необработанный сбой в лаунчере', dialog: true,
    cause: 'В главном процессе лаунчера возникло исключение, которое никто не перехватил.',
    fix: 'Перезапустите лаунчер и отправьте файл отчёта из папки ошибок.' }
});

const NET_RE = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_\w*(TIMEOUT|SOCKET|CONNECT)\w*|fetch failed|socket hang up|network|timed? ?out|TimeoutError|AbortError.*timeout/i;
const CERT_RE = /CERT_|UNABLE_TO_VERIFY|SELF[_ -]SIGNED|certificate|ERR_TLS|DEPTH_ZERO/i;
const HTTP_RE = /(?:HTTP|status(?:Code)?|responded with|код)\D{0,6}(\d{3})\b/i;

/** Flatten an error and everything nested in it (AggregateError members, causes) into searchable text. */
function chainText(err, depth = 0, seen = new Set()) {
  if (err === null || err === undefined) return '';
  if (typeof err !== 'object') return String(err);
  if (seen.has(err) || depth > 4) return '';
  seen.add(err);
  const parts = [err.name, err.code, err.message, err.syscall, err.statusCode, err.status];
  if (Array.isArray(err.errors)) for (const e of err.errors.slice(0, 20)) parts.push(chainText(e, depth + 1, seen));
  if (err.cause) parts.push(chainText(err.cause, depth + 1, seen));
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join(' | ');
}

function codeFromText(text, ctx = {}) {
  if (/ENOSPC|no space left/i.test(text)) return 'OBS-104';
  if (/\b(EACCES|EPERM|EBUSY|EMFILE)\b|operation not permitted|permission denied|resource busy/i.test(text)) return 'OBS-105';
  if (CERT_RE.test(text)) return 'OBS-102';
  if (/checksum|sha-?1|integrity|corrupt|hash mismatch|digest/i.test(text)) return 'OBS-106';
  const http = HTTP_RE.exec(text);
  if (http && Number(http[1]) >= 400 && Number(http[1]) < 600) return 'OBS-103';
  if (NET_RE.test(text)) return ctx.phase === 'auth' ? 'OBS-205' : 'OBS-101';
  return null;
}

/** Decide which catalog entry describes this error. Always returns a code that exists in CATALOG. */
function classify(err, ctx = {}) {
  const text = `${chainText(err)} ${ctx.output || ''}`;
  const own = err && typeof err === 'object' ? err.code : undefined;
  const byCode = {
    JAVA_MISSING: 'OBS-301', RAM_INVALID: 'OBS-302', BUSY: ctx.phase === 'login' ? 'OBS-204' : 'OBS-406', RUNNING: 'OBS-406',
    LAUNCH_FAILED: 'OBS-405', UNKNOWN_VERSION: 'OBS-107', LOGIN_REQUIRED: 'OBS-201', NO_LICENSE: 'OBS-203',
    VALIDATION: 'OBS-501', BACKGROUND: 'OBS-502', LOADER_UNSUPPORTED: 'OBS-110', NET_HOST: 'OBS-112', JAVA_EXTRACT: 'OBS-311',
    VISUAL_FAILED: 'OBS-503', MODRINTH_UNSUPPORTED: 'OBS-110', MODRINTH_FAILED: 'OBS-501', MRPACK_INVALID: 'OBS-501', MRPACK_READ_FAILED: 'OBS-501', BUILD_NOT_FOUND: 'OBS-501', NOT_FOUND: 'OBS-501'
  };
  if (own && byCode[own]) return byCode[own];
  if (own === 'LOGIN_FAILED') return codeFromText(text, { phase: 'auth' }) || 'OBS-202';
  if (own === 'NETWORK' || own === 'BAD_MANIFEST') {
    const c = codeFromText(text, ctx);
    return c === 'OBS-102' || c === 'OBS-103' ? c : 'OBS-108';
  }
  if (own === 'GAME_EXIT') {
    if (/UnsupportedClassVersionError|class file version/i.test(text)) return 'OBS-402';
    if (/Could not create the Java Virtual Machine|Invalid maximum heap size|Could not reserve enough space|Error occurred during initialization of VM/i.test(text)) return 'OBS-403';
    if (/OutOfMemoryError/i.test(text)) return 'OBS-404';
    return 'OBS-401';
  }
  if (own === 'JAVA_INSTALL_FAILED') return codeFromText(text, ctx) || 'OBS-310';
  if (own === 'LOADER_FAILED') return codeFromText(text, ctx) || 'OBS-111';
  if (own === 'INSTALL_FAILED') {
    if (/файлы игры не найдены/.test(text)) return 'OBS-109';
    return codeFromText(text, ctx) || 'OBS-199';
  }
  if (err && /ENOENT/.test(text) && ctx.phase === 'launching') return 'OBS-405';
  const generic = codeFromText(text, ctx);
  if (generic) return generic;
  return ctx.phase === 'main' ? 'OBS-901' : 'OBS-900';
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stampLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const FILE_RE = /^(\d{4,})_(OBS-\d{3})_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.txt$/;
const KEEP_FILES = 200;

class ErrorReporter {
  /**
   * @param {{ dir: string, logger: any, appVersion?: string, now?: () => Date }} opts
   */
  constructor({ dir, logger, appVersion = 'dev', now = () => new Date() }) {
    this.dir = dir;
    this.logger = logger;
    this.appVersion = appVersion;
    this.now = now;
    this.next = 1;
    try {
      for (const name of fs.readdirSync(dir)) {
        const m = FILE_RE.exec(name);
        if (m) this.next = Math.max(this.next, Number(m[1]) + 1);
      }
    } catch { /* folder not created yet */ }
  }

  static entry(code) { return CATALOG[code] || CATALOG['OBS-900']; }

  /**
   * Record an error. Returns a public report object (safe for the UI) or null for cancellations.
   * Reporting the same error object twice returns the first report.
   */
  report(err, ctx = {}) {
    if (err && typeof err === 'object' && err.__obscuraReport) return err.__obscuraReport;
    if (err && typeof err === 'object' && err.code === 'CANCELLED') return null;
    let code;
    try { code = classify(err, ctx); } catch { code = 'OBS-900'; }
    const entry = ErrorReporter.entry(code);
    const incident = this.next++;
    const time = this.now();
    const fileName = `${pad(incident, 4)}_${code}_${stampLocal(time)}.txt`;
    const redact = (t) => (this.logger && this.logger.safe ? this.logger.safe(t) : String(t));
    const lines = [
      `ОШИБКА ${code} — ${entry.title}`,
      `Номер случая: №${pad(incident, 4)}`,
      `Время: ${time.toISOString()}  (локальное: ${stampLocal(time).replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')})`,
      '',
      'ЧТО СЛУЧИЛОСЬ',
      entry.cause,
      '',
      'ЧТО ДЕЛАТЬ',
      entry.fix,
      '',
      'КОНТЕКСТ',
      `Лаунчер: Obscura ${this.appVersion}`,
      `Система: ${os.type()} ${os.release()} ${os.arch()}, свободно ОЗУ ${(os.freemem() / 1024 ** 3).toFixed(1)} из ${(os.totalmem() / 1024 ** 3).toFixed(1)} ГБ`,
      ...Object.entries(ctx).filter(([k, v]) => k !== 'output' && v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${v}`),
      '',
      'ТЕХНИЧЕСКИЕ ПОДРОБНОСТИ',
      redact(describeError(err))
    ];
    if (ctx.output) lines.push('', 'ПОСЛЕДНИЕ СТРОКИ ВЫВОДА ИГРЫ', redact(ctx.output));
    const tail = this._logTail(60);
    if (tail) lines.push('', 'ПОСЛЕДНИЕ СТРОКИ ЖУРНАЛА ЛАУНЧЕРА', redact(tail));
    lines.push('', '— Токены и пароли в этом файле скрыты ([REDACTED]). Файл можно отправлять разработчику. —');

    let file = null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, fileName), lines.join('\r\n'), 'utf8');
      file = fileName;
      this._prune();
    } catch (writeErr) {
      if (this.logger) this.logger.warn(`Could not write error report: ${writeErr && writeErr.message}`);
    }
    if (this.logger) this.logger.error(`[${code} №${pad(incident, 4)}] ${entry.title}\n${describeError(err)}`);
    const first = redact(describeError(err)).split('\n')[0].slice(0, 240);
    const publicReport = Object.freeze({
      incident, number: pad(incident, 4), code, title: entry.title, cause: entry.cause, fix: entry.fix,
      dialog: Boolean(entry.dialog), file, detail: first, time: time.toISOString()
    });
    if (err && typeof err === 'object') { try { Object.defineProperty(err, '__obscuraReport', { value: publicReport }); } catch { /* frozen */ } }
    return publicReport;
  }

  _logTail(count) {
    try {
      const file = this.logger && this.logger.file;
      if (!file) return '';
      return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-count).join('\n');
    } catch { return ''; }
  }

  _prune() {
    try {
      const files = fs.readdirSync(this.dir).filter((n) => FILE_RE.test(n)).sort();
      for (const old of files.slice(0, Math.max(0, files.length - KEEP_FILES))) fs.rmSync(path.join(this.dir, old), { force: true });
    } catch { /* best effort */ }
  }

  /** Newest first. Only data derived from file names is returned. */
  list(limit = 15) {
    try {
      return fs.readdirSync(this.dir)
        .map((name) => ({ name, m: FILE_RE.exec(name) }))
        .filter((x) => x.m)
        .sort((a, b) => Number(b.m[1]) - Number(a.m[1]))
        .slice(0, limit)
        .map(({ name, m }) => ({
          incident: Number(m[1]), number: m[1].padStart(4, '0'), code: m[2], title: ErrorReporter.entry(m[2]).title,
          cause: ErrorReporter.entry(m[2]).cause, fix: ErrorReporter.entry(m[2]).fix, dialog: Boolean(ErrorReporter.entry(m[2]).dialog),
          date: `${m[3]} ${m[4].replace(/-/g, ':')}`, file: name
        }));
    } catch { return []; }
  }
}

module.exports = { CATALOG, ErrorReporter, classify, chainText, FILE_RE };
