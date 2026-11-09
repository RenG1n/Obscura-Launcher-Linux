// Obscura renderer. It has no access to Node.js: everything that touches the
// system goes through the small `window.obscura` API exposed by preload.js.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const api = window.obscura;

const toast = $('#toast');
let toastTimer;
function showToast(message, ms = 3600, kind = '') {
  const host = document.querySelector('dialog[open]') || document.body; // a modal window sits above the page, so the toast moves into it
  if (toast.parentElement !== host) host.append(toast);
  toast.textContent = message;
  toast.classList.remove('error', 'success');
  if (kind) toast.classList.add(kind);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), ms);
}
const showError = (message, ms = 6000) => showToast(message, ms, 'error');

// ---------------------------------------------------------------- numbered errors
const errorDialog = $('#errorDialog');
let shownReport = null;
function openErrorDialog(report) {
  shownReport = report;
  $('#errorCode').textContent = report.code;
  $('#errorNumber').textContent = `№${report.number}`;
  $('#errorTitle').textContent = report.title;
  $('#errorCause').textContent = report.cause;
  $('#errorFix').textContent = report.fix;
  const detail = report.detail ? String(report.detail) : '';
  $('#errorDetail').textContent = detail;
  $('#errorDetailBox').hidden = !detail;
  $('#errorFile').textContent = report.file ? `Подробный отчёт: errors\\${report.file}` : 'Отчёт не удалось сохранить на диск.';
  if (!errorDialog.open) errorDialog.showModal();
}
function reportText(r) {
  return [`${r.code} №${r.number} — ${r.title}`, `Что случилось: ${r.cause}`, `Что делать: ${r.fix}`, r.detail ? `Причина: ${r.detail}` : '', r.file ? `Отчёт: ${r.file}` : ''].filter(Boolean).join('\n');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* permission denied: use the legacy path */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}
$('#errorClose').addEventListener('click', () => errorDialog.close());
$('#errorCopy').addEventListener('click', async () => {
  if (!shownReport) return;
  showToast((await copyText(reportText(shownReport))) ? 'Описание ошибки скопировано.' : 'Не удалось скопировать: выделите текст вручную.', 2600, 'success');
});
async function openErrorsFolder() {
  try { await call(api.errors.openFolder()); } catch (err) { fail(err); }
}
$('#errorOpenFolder').addEventListener('click', openErrorsFolder);

async function openGameFolder() {
  try { await call(api.game.openFolder()); } catch (err) { fail(err); }
}
async function openModsFolder() {
  try { await call(api.game.openModsFolder()); } catch (err) { fail(err); }
}
$('#openGameFolderButton').addEventListener('click', openGameFolder);
$('#openModsFolderButton').addEventListener('click', openModsFolder);

/** Show a failure: numbered window for serious errors, short toast with the code for minor ones. */
function fail(err, ms = 6000) {
  const report = err && err.report;
  if (!report) return showError(err.message, ms);
  refreshErrorList();
  if (report.dialog) return openErrorDialog(report);
  showError(`[${report.code}] ${err.message}`, ms);
}

/** Unwrap { ok, data } / { ok:false, error } returned by the main process. */
async function call(promise) {
  const res = await promise;
  if (!res || !res.ok) {
    const error = new Error((res && res.error && res.error.message) || 'Неизвестная ошибка.');
    error.code = res && res.error && res.error.code;
    error.report = (res && res.error && res.error.report) || null; // numbered error report from the main process
    throw error;
  }
  return res.data;
}


// ---------------------------------------------------------------- appearance customization (stored locally in the renderer)
const appearanceDefaults = { theme: 'dark', accent: '#c8f169', bg: '#111315', sidebar: '#0d0f10', customizationOpen: false };
const lightPalette = { bg: '#dadde1', sidebar: '#eceef0', panel: '#e7e9ec', panelRaised: '#dfe2e5', line: '#c6cbd1', lineSoft: '#d2d6db', text: '#24272b', muted: '#565e65', muted2: '#71787e' };
function readAppearance() { try { return { ...appearanceDefaults, ...JSON.parse(localStorage.getItem('obscuraAppearance') || '{}') }; } catch { return { ...appearanceDefaults }; } }
function applyAppearance() {
  const a = readAppearance();
  const root = document.documentElement;
  root.classList.toggle('theme-light', a.theme === 'light');
  root.classList.toggle('theme-dark', a.theme !== 'light');
  root.style.colorScheme = a.theme === 'light' ? 'light' : 'dark';
  const palette = a.theme === 'light' ? lightPalette : { bg: '#111315', sidebar: '#0d0f10', panel: '#171a1c', panelRaised: '#1b1e20', line: '#2a2e30', lineSoft: '#222628', text: '#f0f1ee', muted: '#858b8d', muted2: '#62696b' };
  root.style.setProperty('--bg', a.bg || palette.bg); root.style.setProperty('--sidebar', a.sidebar || palette.sidebar);
  root.style.setProperty('--panel', palette.panel); root.style.setProperty('--panel-raised', palette.panelRaised); root.style.setProperty('--line', palette.line); root.style.setProperty('--line-soft', palette.lineSoft); root.style.setProperty('--text', palette.text); root.style.setProperty('--muted', palette.muted); root.style.setProperty('--muted-2', palette.muted2); root.style.setProperty('--accent', a.accent);
  const shell = $('#appShell');
  const ids = { accentColorInput: a.accent, baseColorInput: a.bg, sidebarColorInput: a.sidebar };
  Object.entries(ids).forEach(([id, value]) => { const el = document.getElementById(id); if (el) el.value = value; });
  document.querySelectorAll('[data-theme-choice]').forEach(btn => btn.classList.toggle('active', btn.dataset.themeChoice === a.theme));
  const toggle = $('#customizationToggle'); const panel = $('#customizationPanel');
  if (toggle && panel) { toggle.checked = !!a.customizationOpen; panel.hidden = !a.customizationOpen; panel.classList.toggle('is-open', !!a.customizationOpen); }
  updateAvatarColor();
}
function saveAppearance(patch) { const next = { ...readAppearance(), ...patch }; localStorage.setItem('obscuraAppearance', JSON.stringify(next)); applyAppearance(); }
function updateAvatarColor() {
  const el = $('#avatarLetter'); if (!el) return;
  const a = readAppearance();
  const licensed = el.dataset.accountType === 'licensed';
  const file = a.theme === 'light' ? (licensed ? 'account-licensed-dark.png' : 'account-offline-dark.png') : (licensed ? 'account-licensed-light.png' : 'account-offline-light.png');
  el.innerHTML = `<img class="account-type-icon" src="./assets/icons/${file}" alt="${licensed ? 'Microsoft — лицензия' : 'Офлайн — без лицензии'}">`;
  el.className = `avatar account-avatar ${licensed ? 'microsoft-avatar' : 'local-avatar'}`;
  el.title = licensed ? 'Microsoft — лицензия' : 'Офлайн — без лицензии';
}
['accentColorInput','baseColorInput','sidebarColorInput'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('input', () => saveAppearance({ [({accentColorInput:'accent',baseColorInput:'bg',sidebarColorInput:'sidebar'})[id]]: el.value })); });
document.querySelectorAll('[data-theme-choice]').forEach(btn => btn.addEventListener('click', () => {
  const theme = btn.dataset.themeChoice;
  const defaults = theme === 'light' ? { bg: '#dadde1', sidebar: '#eceef0' } : { bg: '#111315', sidebar: '#0d0f10' };
  saveAppearance({ theme, ...defaults });
  showToast(theme === 'light' ? 'Включена светлая тема.' : 'Включена тёмная тема.');
}));
$('#customizationToggle').addEventListener('change', e => saveAppearance({ customizationOpen: e.target.checked }));
$('#resetAppearanceButton').addEventListener('click', () => { const a = readAppearance(); localStorage.setItem('obscuraAppearance', JSON.stringify({ ...appearanceDefaults, theme: a.theme, customizationOpen: a.customizationOpen, ...(a.theme === 'light' ? { bg: '#dadde1', sidebar: '#eceef0' } : {}) })); applyAppearance(); showToast('Цвета оформления сброшены.'); });
applyAppearance();

// Keep navigation anchored; scrolling down tucks labels away, scrolling up restores them.
let previousScrollY = window.scrollY;
let scrollTicking = false;
window.addEventListener('scroll', () => {
  if (scrollTicking) return;
  scrollTicking = true;
  window.requestAnimationFrame(() => {
    const current = window.scrollY;
    const delta = current - previousScrollY;
    if (current < 48) $('#appShell').classList.remove('sidebar-collapsed');
    else if (delta > 4) $('#appShell').classList.add('sidebar-collapsed');
    else if (delta < -4) $('#appShell').classList.remove('sidebar-collapsed');
    previousScrollY = current; scrollTicking = false;
  });
}, { passive: true });

// ---------------------------------------------------------------- navigation
const pageNames = { home: 'Главная', instances: 'Сборки', news: 'Новости', settings: 'Настройки' };
// "new" dot on the news item until the latest release note has been opened
const newsNavDot = Object.assign(document.createElement('span'), { className: 'nav-new', hidden: true, title: 'Есть свежие новости' });
$('.nav-item[data-page="news"]').append(newsNavDot);
const latestNews = typeof OBSCURA_NEWS !== 'undefined' && OBSCURA_NEWS[0] ? OBSCURA_NEWS[0].version : '';
function newsSeen() { try { return localStorage.getItem('obscuraNewsSeen'); } catch { return null; } }
function markNewsSeen() { newsNavDot.hidden = true; try { localStorage.setItem('obscuraNewsSeen', latestNews); } catch { /* storage may be unavailable */ } }
newsNavDot.hidden = !latestNews || newsSeen() === latestNews;
$$('.nav-item[data-page]').forEach((button) => {
  button.addEventListener('click', () => {
    const page = button.dataset.page;
    if (page === 'news') markNewsSeen();
    $$('.nav-item[data-page]').forEach((item) => item.classList.toggle('active', item === button));
    $$('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
    $('#pageCrumb').textContent = pageNames[page] || 'Главная';
    if (page === 'instances') loadBuilds();
  });
});
$$('.back-home').forEach((button) => button.addEventListener('click', () => $('[data-page="home"]').click()));
$('#minimizeHint').addEventListener('click', () => showToast('Obscura Release 1.1.0 — лаунчер Minecraft: Java Edition.'));

if (!api) {
  showError('Интерфейс запущен без Electron: запуск игры недоступен.', 8000);
  $('#playButton').disabled = true;
  throw new Error('window.obscura is not available');
}

// ---------------------------------------------------------------- news (release notes)
const tagLabels = { fixed: 'ИСПРАВЛЕНО', new: 'НОВОЕ', better: 'УЛУЧШЕНО' };
function renderNews() {
  const list = $('#newsList');
  if (!list || typeof OBSCURA_NEWS === 'undefined') return;
  // The first (newest) release is the only featured card. Older releases
  // automatically return to the neutral style, regardless of stale data flags.
  const cards = OBSCURA_NEWS.map((entry, index) => {
    const isLatest = index === 0;
    const card = document.createElement('article');
    card.className = isLatest ? 'news-card featured' : 'news-card';
    const head = document.createElement('div');
    head.className = 'news-head';
    const version = document.createElement('span');
    version.className = 'news-version';
    version.textContent = `v${entry.version}`;
    if (isLatest) {
      const badge = document.createElement('span');
      badge.className = 'news-badge';
      badge.textContent = entry.badge || 'ПОСЛЕДНЕЕ ОБНОВЛЕНИЕ';
      head.append(badge);
    }
    const date = document.createElement('span');
    date.className = 'news-date';
    date.textContent = entry.date;
    const title = document.createElement('h2');
    title.className = 'news-title';
    title.textContent = entry.title;
    head.append(version, date, title);
    if (entry.lead) head.append(Object.assign(document.createElement('p'), { className: 'news-lead', textContent: entry.lead }));
    const items = document.createElement('ul');
    items.className = 'news-items';
    entry.items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'news-item';
      const tag = document.createElement('span');
      tag.className = `news-tag ${tagLabels[item.tag] ? item.tag : 'new'}`;
      tag.textContent = tagLabels[item.tag] || tagLabels.new;
      const text = document.createElement('span');
      text.textContent = item.text;
      li.append(tag, text);
      items.append(li);
    });
    card.append(head, items);
    return card;
  });
  list.replaceChildren(...cards);
}
renderNews();

// ---------------------------------------------------------------- settings: RAM + version
const ramRange = $('#ramRange');
const ramValue = $('#ramValue');
const versionSelect = $('#versionSelect');
let currentSettings = null;
let latestIds = { release: null, snapshot: null };

ramRange.addEventListener('input', () => { ramValue.textContent = ramRange.value; });
ramRange.addEventListener('change', async () => {
  const wanted = Number(ramRange.value);
  try {
    currentSettings = await call(api.settings.update({ ramGb: wanted }));
  } catch (err) {
    fail(err);
    ramRange.value = currentSettings ? currentSettings.ramGb : 4;
    ramValue.textContent = ramRange.value;
  }
});

versionSelect.addEventListener('change', async () => {
  try {
    currentSettings = await call(api.settings.update({ version: versionSelect.value, loaderVersion: '' }));
    refreshLoaderVersions();
  } catch (err) {
    fail(err);
    versionSelect.value = currentSettings ? currentSettings.version : 'release';
  }
});

function option(value, label) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  return el;
}

async function loadVersions() {
  const note = $('#versionNote');
  try {
    const data = await call(api.versions.list());
    latestIds = { release: data.latest.release, snapshot: data.latest.snapshot };
    const releases = data.versions.filter((v) => v.type === 'release');
    versionSelect.replaceChildren(
      option('release', `Последний релиз (${data.latest.release})`),
      option('snapshot', `Последний snapshot (${data.latest.snapshot})`)
    );
    const group = document.createElement('optgroup');
    group.label = 'Релизы';
    releases.forEach((v) => group.append(option(v.id, v.id)));
    versionSelect.append(group);
    note.textContent = data.source === 'network'
      ? `Список Mojang · релизов: ${releases.length}`
      : 'Нет сети: список из кэша. Установленные версии запустятся.';
  } catch (err) {
    note.textContent = 'Не удалось загрузить список версий: доступны только встроенные пункты.';
  }
  const wanted = currentSettings ? currentSettings.version : 'release';
  versionSelect.value = [...versionSelect.options].some((o) => o.value === wanted) ? wanted : 'release';
}

// ---------------------------------------------------------------- system info (RAM bounds, Java)
async function loadSystem() {
  try {
    const info = await call(api.system.info());
    ramRange.min = String(info.memory.minGb);
    ramRange.max = String(info.memory.maxGb);
    const labels = $$('.range-labels span');
    if (labels.length === 2) { labels[0].textContent = `${info.memory.minGb} GB`; labels[1].textContent = `${info.memory.maxGb} GB`; }
    $('#ramNote').textContent = `В системе ${info.memory.totalGb} GB · свободно ${info.memory.freeGb} GB · максимум ${info.memory.maxGb} GB`;
    if (currentSettings && currentSettings.ramGb > info.memory.maxGb) {
      const was = currentSettings.ramGb;
      currentSettings = await call(api.settings.update({ ramGb: info.memory.maxGb }));
      showToast(`Память уменьшена с ${was} до ${info.memory.maxGb} GB: в этом компьютере ${info.memory.totalGb} GB.`, 6000);
    }
    if (currentSettings) ramRange.value = String(currentSettings.ramGb);
    ramValue.textContent = ramRange.value;
  } catch (err) {
    $('#javaInfo').textContent = err.message;
  }
}

// ---------------------------------------------------------------- mod loader (Fabric / Forge)
const loaderSelect = $('#loaderSelect');
const loaderVersionSelect = $('#loaderVersionSelect');
const loaderVersionWrap = $('#loaderVersionWrap');
const LOADER_NAMES = { fabric: 'Fabric', forge: 'Forge', quilt: 'Quilt', neoforge: 'NeoForge' };
let loaderRequest = 0;

function selectedMinecraftId() {
  const v = versionSelect.value;
  if (v === 'release') return latestIds.release;
  if (v === 'snapshot') return latestIds.snapshot;
  return v;
}

function setVersionNote(text, bad = false) {
  const note = $('#versionNote');
  note.textContent = text;
  note.classList.toggle('note-bad', bad);
}

async function refreshLoaderVersions() {
  const loader = loaderSelect.value;
  const ticket = ++loaderRequest;
  if (isVisualMode()) { loaderVersionWrap.hidden = true; return; } // fixed by the visual mod
  loaderVersionWrap.hidden = loader === 'vanilla';
  loaderVersionSelect.replaceChildren(option('', 'Авто (рекомендуемая)'));
  if (loader === 'vanilla') return;
  const mc = selectedMinecraftId();
  if (!mc) { setVersionNote('Дождитесь загрузки списка версий.'); return; }
  try {
    const list = await call(api.loaders.list(loader, mc));
    if (ticket !== loaderRequest) return; // a newer choice superseded this answer
    if (list.length === 0) {
      setVersionNote(`Для Minecraft ${mc} нет сборки ${LOADER_NAMES[loader]}. Выберите другую версию или Vanilla.`, true);
      return;
    }
    list.forEach((v) => loaderVersionSelect.append(option(v.id, `${v.id}${v.recommended ? ' · рекомендуется' : (v.stable ? '' : ' · новая')}`)));
    const saved = currentSettings ? currentSettings.loaderVersion : '';
    loaderVersionSelect.value = [...loaderVersionSelect.options].some((o) => o.value === saved) ? saved : '';
    setVersionNote(`${LOADER_NAMES[loader]} для Minecraft ${mc}: доступно сборок ${list.length}.`);
  } catch (err) {
    if (ticket !== loaderRequest) return;
    setVersionNote(`Список ${LOADER_NAMES[loader]} не получен (${err.message || 'нет сети'}). Запуск всё равно попробует установить его.`, true);
  }
}

loaderSelect.addEventListener('change', async () => {
  try {
    currentSettings = await call(api.settings.update({ loader: loaderSelect.value, loaderVersion: '' }));
    await refreshLoaderVersions();
    if (loaderSelect.value === 'vanilla') setVersionNote('Игра запустится без модов.');
  } catch (err) {
    fail(err);
    loaderSelect.value = currentSettings ? currentSettings.loader : 'vanilla';
  }
});
loaderVersionSelect.addEventListener('change', async () => {
  try {
    currentSettings = await call(api.settings.update({ loaderVersion: loaderVersionSelect.value }));
  } catch (err) { fail(err); }
});

// ---------------------------------------------------------------- Java manager (Settings)
const javaList = $('#javaList');

const closeLauncherToggle = $('#closeLauncherOnGameStartToggle');
closeLauncherToggle.addEventListener('change', async () => {
  try {
    currentSettings = await call(api.settings.update({ closeLauncherOnGameStart: closeLauncherToggle.checked }));
    showToast(closeLauncherToggle.checked ? 'Лаунчер будет закрываться после запуска игры.' : 'Автоматическое закрытие лаунчера отключено.');
  } catch (err) { fail(err); closeLauncherToggle.checked = currentSettings?.closeLauncherOnGameStart === true; }
});

const autoJavaToggle = $('#autoJavaToggle');
let javaActive = null;
const javaRows = new Map();

function javaRow(major, info) {
  const managed = info.managed.some((m) => m.major === major);
  const system = info.detected.filter((d) => d.major === major && d.source !== 'obscura');
  const item = document.createElement('div');
  item.className = 'java-item';
  const name = document.createElement('span'); name.className = 'j-name'; name.textContent = `Java ${major}`;
  const state = document.createElement('span'); state.className = 'j-state';
  const actions = document.createElement('span'); actions.className = 'j-actions';
  const progress = document.createElement('div'); progress.className = 'j-progress'; progress.hidden = true;
  const bar = document.createElement('div'); progress.append(bar);
  const label = major === 8 ? 'для версий до 1.17' : major === 17 ? 'для 1.17–1.20.4' : major === 21 ? 'для 1.20.5 и новее' : 'для самых новых версий';
  if (javaActive === major) {
    state.textContent = 'Устанавливается…';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary-button'; cancel.textContent = 'Отмена';
    cancel.addEventListener('click', () => { api.java.cancel(); });
    actions.append(cancel);
    progress.hidden = false; bar.classList.add('indeterminate');
  } else if (managed) {
    state.className = 'j-state ok'; state.textContent = `Установлена Obscura · ${label}`;
    const del = document.createElement('button'); del.type = 'button'; del.className = 'secondary-button'; del.textContent = 'Удалить';
    del.addEventListener('click', async () => {
      try { await call(api.java.remove(major)); showToast(`Java ${major} удалена.`); } catch (err) { fail(err); }
      loadJava();
    });
    actions.append(del);
  } else {
    state.textContent = system.length ? `Найдена в системе (${system[0].version}) · ${label}` : `Не установлена · ${label}`;
    if (system.length) state.className = 'j-state ok';
    const add = document.createElement('button'); add.type = 'button'; add.className = 'secondary-button'; add.textContent = 'Установить';
    add.addEventListener('click', () => installJava(major));
    actions.append(add);
  }
  item.append(name, state, actions, progress);
  javaRows.set(major, { state, bar, progress, actions });
  return item;
}

async function loadJava() {
  try {
    const info = await call(api.java.list());
    javaActive = info.active;
    autoJavaToggle.checked = info.autoJava !== false;
    javaRows.clear();
    javaList.replaceChildren(...info.supported.map((m) => javaRow(m, info)));
    const majors = [...new Set(info.detected.map((d) => d.major))].sort((a, b) => b - a);
    $('#javaInfo').textContent = majors.length ? `Доступно: ${majors.map((m) => `Java ${m}`).join(', ')}. Нужная версия подбирается под игру автоматически.` : 'Java пока нет. Нажмите «Установить» или запустите игру: лаунчер скачает нужную сам.';
    $('#javaBadge').textContent = majors.length ? 'НАЙДЕНА' : 'НЕТ';
  } catch (err) {
    $('#javaInfo').textContent = err.message;
  }
}

async function installJava(major) {
  javaActive = major;
  loadJavaRowBusy(major);
  try {
    await call(api.java.install(major));
    showToast(`Java ${major} установлена.`);
  } catch (err) {
    if (err.code === 'CANCELLED') showToast('Установка Java отменена.');
    else fail(err);
  }
  javaActive = null;
  loadJava();
}
function loadJavaRowBusy(major) {
  const row = javaRows.get(major);
  if (!row) return;
  row.state.textContent = 'Устанавливается…';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary-button'; cancel.textContent = 'Отмена';
  cancel.addEventListener('click', () => { api.java.cancel(); });
  row.actions.replaceChildren(cancel);
  row.progress.hidden = false;
  row.bar.classList.add('indeterminate');
}

api.java.onEvent((e) => {
  if (!e || typeof e !== 'object') return;
  const row = javaRows.get(e.major);
  if (!row) return;
  if (typeof e.message === 'string') row.state.textContent = e.message;
  row.progress.hidden = false;
  if (typeof e.percent === 'number') { row.bar.classList.remove('indeterminate'); row.bar.style.width = `${e.percent}%`; } else row.bar.classList.add('indeterminate');
});

autoJavaToggle.addEventListener('change', async () => {
  try {
    currentSettings = await call(api.settings.update({ autoJava: autoJavaToggle.checked }));
  } catch (err) { fail(err); autoJavaToggle.checked = currentSettings ? currentSettings.autoJava : true; }
});

// ---------------------------------------------------------------- backgrounds
const builtinBackgrounds = [
  { id: 'builtin-1', name: 'BACKGROUND 01', url: './assets/backgrounds/background-01.svg' },
  { id: 'builtin-2', name: 'BACKGROUND 02', url: './assets/backgrounds/background-02.svg' },
  { id: 'builtin-3', name: 'BACKGROUND 03', url: './assets/backgrounds/background-03.svg' }
];
let currentBackground = 'builtin-1';
function applyBackground(url, name) {
  const hero = $('#heroCard');
  hero.style.backgroundImage = `url("${url}")`;
  $('#backgroundName').textContent = name;
  hero.classList.remove('bg-swap');
  void hero.offsetWidth; // restart the CSS animation
  hero.classList.add('bg-swap');
}
function showBackground(state) {
  currentBackground = state.id;
  if (state.id === 'custom' && state.dataUrl) return applyBackground(state.dataUrl, 'CUSTOM BACKGROUND');
  const item = builtinBackgrounds.find((b) => b.id === state.id) || builtinBackgrounds[0];
  currentBackground = item.id;
  applyBackground(item.url, item.name);
}
async function nextBackground() {
  const index = builtinBackgrounds.findIndex((b) => b.id === currentBackground);
  const item = builtinBackgrounds[(index + 1) % builtinBackgrounds.length];
  try {
    await call(api.background.select(item.id));
    showBackground({ id: item.id });
    showToast(`Фон изменён: ${item.name.toLowerCase()}.`);
  } catch (err) { fail(err); }
}
$('#changeBackgroundButton').addEventListener('click', nextBackground);
$('#settingsBackgroundButton').addEventListener('click', nextBackground);
$('#authModeSelect').addEventListener('change', async () => {
  try {
    currentSettings = await call(api.settings.update({ authMode: $('#authModeSelect').value }));
    $('#localUsernameRow').hidden = currentSettings.authMode !== 'local';
    const status = await call(api.auth.status());
    renderAccount(status);
    showToast(currentSettings.authMode === 'local' ? 'Включён локальный офлайн-профиль.' : 'Включён режим Microsoft.');
  } catch (err) { fail(err); $('#authModeSelect').value = currentSettings ? currentSettings.authMode : 'microsoft'; }
});
$('#saveLocalUsernameButton').addEventListener('click', async () => {
  try {
    currentSettings = await call(api.settings.update({ localUsername: $('#localUsernameInput').value.trim() }));
    $('#localUsernameInput').value = currentSettings.localUsername;
    renderAccount(await call(api.auth.status()));
    showToast('Ник локального профиля сохранён.');
  } catch (err) { fail(err); if (currentSettings) $('#localUsernameInput').value = currentSettings.localUsername; }
});
$('#addAccountButton').addEventListener('click', () => login());
$('#accountSelect').addEventListener('change', async () => {
  if (!$('#accountSelect').value) return;
  try { renderAccount(await call(api.auth.select($('#accountSelect').value))); showToast('Активный аккаунт изменён.'); }
  catch (err) { fail(err); renderAccount(await call(api.auth.status())); }
});
$('#removeAccountButton').addEventListener('click', async () => {
  const uuid = $('#accountSelect').value;
  if (!uuid) return showToast('Сначала выбери аккаунт.');
  if (!window.confirm('Удалить выбранный аккаунт из списка Obscura?')) return;
  try { renderAccount(await call(api.auth.remove(uuid))); showToast('Аккаунт удалён из списка.'); }
  catch (err) { fail(err); }
});

const backgroundFileInput = $('#backgroundFileInput');
const MAX_BACKGROUND_SIDE = 2560;

/**
 * Decode any image the browser understands (PNG, JPEG, WebP, GIF, BMP, AVIF, SVG, ...),
 * shrink it to a sensible size and re-encode it as WebP. The main process then verifies
 * the bytes again, so the stored file is always a small, known-good image.
 */
async function imageFileToWebp(file) {
  if (!file || file.size === 0) throw new Error('Файл пустой.');
  if (file.size > 80 * 1024 * 1024) throw new Error('Файл слишком большой (максимум 80 MB).');
  let source;
  let width;
  let height;
  let cleanup = () => {};
  try {
    source = await createImageBitmap(file);
    width = source.width;
    height = source.height;
    cleanup = () => source.close();
  } catch {
    const url = URL.createObjectURL(file); // SVG and some formats decode only through <img>
    cleanup = () => URL.revokeObjectURL(url);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      source = img;
      width = img.naturalWidth || 1920;
      height = img.naturalHeight || 1080;
    } catch {
      cleanup();
      throw new Error('Не удалось открыть файл как изображение. Попробуйте PNG, JPEG, WebP, GIF, BMP, AVIF или SVG.');
    }
  }
  try {
    const longest = Math.max(width, height);
    let scale = Math.min(1, MAX_BACKGROUND_SIDE / longest);
    if (file.type === 'image/svg+xml' && longest < 1600) scale = 1600 / longest; // keep vectors crisp
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111315'; // transparent pixels sit on the launcher's own background colour
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    if (!blob || blob.type !== 'image/webp') throw new Error('Не удалось сохранить изображение.');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    cleanup();
  }
}

async function setBackgroundFromFile(file) {
  try {
    const bytes = await imageFileToWebp(file);
    const state = await call(api.background.setCustom(bytes)); // verified by content in the main process
    showBackground(state);
    showToast('Свой фон сохранён.', 3200, 'success');
  } catch (err) { fail(err); }
}

$('#changeBackgroundButton').addEventListener('contextmenu', (event) => {
  event.preventDefault();
  backgroundFileInput.click();
});
$('#pickBackgroundButton').addEventListener('click', () => backgroundFileInput.click());
$('#resetBackgroundButton').addEventListener('click', async () => {
  try {
    showBackground(await call(api.background.clear()));
    showToast('Возвращён встроенный фон.');
  } catch (err) { fail(err); }
});
backgroundFileInput.addEventListener('change', () => {
  const file = backgroundFileInput.files && backgroundFileInput.files[0];
  backgroundFileInput.value = '';
  if (file) setBackgroundFromFile(file);
});

// Drag & drop an image onto the hero card. Drops anywhere else must never navigate the window.
const heroCard = $('#heroCard');
const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
window.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
window.addEventListener('drop', (event) => { if (hasFiles(event)) event.preventDefault(); });
heroCard.addEventListener('dragover', (event) => { if (hasFiles(event)) heroCard.classList.add('drop'); });
['dragleave', 'dragend'].forEach((name) => heroCard.addEventListener(name, () => heroCard.classList.remove('drop')));
heroCard.addEventListener('drop', (event) => {
  heroCard.classList.remove('drop');
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file) setBackgroundFromFile(file);
});

// ---------------------------------------------------------------- account
const accountButton = $('#accountButton');
const authDialog = $('#authDialog');
let loginInProgress = false;

function renderAccount(status) {
  const localMode = currentSettings && currentSettings.authMode === 'local';
  const name = localMode ? (currentSettings.localUsername || 'Player') : (status.profile ? status.profile.name : 'Гость');
  $('#profileName').textContent = name;
  $('#profileStatus').textContent = localMode ? 'ОФЛАЙН · без лицензии' : (status.profile ? 'MICROSOFT · лицензия' : 'Не выполнен вход');
  const avatar = $('#avatarLetter');
  avatar.dataset.accountType = (!localMode && status.profile) ? 'licensed' : 'offline';
  updateAvatarColor();
  accountButton.title = status.accounts && status.accounts.length ? 'Управление аккаунтами' : 'Войти через Microsoft';
  renderAccountList(status);
  renderHomeProfileSelect(status);
}

function renderAccountList(status) {
  const select = $('#accountSelect');
  if (!select) return;
  const accounts = Array.isArray(status.accounts) ? status.accounts : (status.profile ? [status.profile] : []);
  select.replaceChildren(...(accounts.length ? accounts.map(a => {
    const o = option(a.uuid, `${a.name} — MICROSOFT / лицензия`);
    if (status.profile && status.profile.uuid === a.uuid) o.selected = true;
    return o;
  }) : [option('', 'Нет аккаунтов Microsoft')]));
}

function renderHomeProfileSelect(status) {
  const select = $('#profileSelect');
  if (!select) return;
  const accounts = Array.isArray(status.accounts) ? status.accounts : (status.profile ? [status.profile] : []);
  const localName = currentSettings && currentSettings.localUsername ? currentSettings.localUsername : 'Player';
  const options = [option('local', `${localName} — ОФЛАЙН / без лицензии`)];
  for (const account of accounts) options.push(option(`microsoft:${account.uuid}`, `${account.name} — MICROSOFT / лицензия`));
  select.replaceChildren(...options);
  const localMode = currentSettings && currentSettings.authMode === 'local';
  select.value = localMode ? 'local' : (status.profile ? `microsoft:${status.profile.uuid}` : 'local');
}

$('#profileSelect').addEventListener('change', async () => {
  const value = $('#profileSelect').value;
  try {
    if (value === 'local') {
      currentSettings = await call(api.settings.update({ authMode: 'local' }));
      $('#authModeSelect').value = 'local';
      $('#localUsernameRow').hidden = false;
      renderAccount(await call(api.auth.status()));
      showToast('Выбран офлайн-профиль без лицензии.');
      return;
    }
    if (value.startsWith('microsoft:')) {
      const uuid = value.slice('microsoft:'.length);
      const status = await call(api.auth.select(uuid));
      currentSettings = await call(api.settings.update({ authMode: 'microsoft' }));
      $('#authModeSelect').value = 'microsoft';
      $('#localUsernameRow').hidden = true;
      renderAccount(status);
      showToast(`Выбран Microsoft-аккаунт: ${status.profile ? status.profile.name : 'аккаунт'}.`);
    }
  } catch (err) {
    fail(err);
    renderAccount(await call(api.auth.status()));
  }
});

api.auth.onCode(({ userCode, url }) => {
  $('#authCode').textContent = userCode;
  $('#authUrl').textContent = url;
  if (!authDialog.open) authDialog.showModal();
});
$('#authCancel').addEventListener('click', async () => {
  await api.auth.cancel();
  if (authDialog.open) authDialog.close();
});
authDialog.addEventListener('cancel', () => { api.auth.cancel(); });

async function login() {
  if (loginInProgress) return false;
  loginInProgress = true;
  try {
    const profile = await call(api.auth.login());
    currentSettings = await call(api.settings.update({ authMode: 'microsoft' }));
    $('#authModeSelect').value = 'microsoft';
    $('#localUsernameRow').hidden = true;
    const status = await call(api.auth.status());
    renderAccount(status && status.profile ? status : { loggedIn: true, profile });
    showToast(`Выбран Microsoft-аккаунт: ${profile.name}.`);
    return true;
  } catch (err) {
    if (err.code !== 'CANCELLED') fail(err);
    return false;
  } finally {
    loginInProgress = false;
    if (authDialog.open) authDialog.close();
    $('#authCode').textContent = '—';
  }
}
accountButton.addEventListener('click', async () => {
  const status = await call(api.auth.status());
  if (!status.loggedIn) return login();
  $('[data-page="settings"]').click();
  $('#accountSelect').focus();
});
$('.profile-card .avatar').addEventListener('click', () => accountButton.click());

// ---------------------------------------------------------------- play / progress
const playButton = $('#playButton');
const cancelButton = $('#cancelButton');
const progressBox = $('#launchProgress');
const progressText = $('#launchProgressText');
const progressBar = $('#launchProgressBar');

const playLabel = $('#playLabel');
function setBusy(busy) {
  playButton.disabled = busy;
  visualToggle.disabled = busy;
  visualSwitch.classList.toggle('disabled', busy);
  playLabel.textContent = busy ? 'Подготовка…' : 'Запустить игру';
  progressBox.hidden = !busy;
  if (!busy) { cancelButton.hidden = true; progressBar.classList.remove('indeterminate'); progressBar.style.width = '0'; }
}
function setProgress(text, percent) {
  progressBox.hidden = false;
  progressText.textContent = text;
  if (typeof percent === 'number') {
    progressBar.classList.remove('indeterminate');
    progressBar.style.width = `${percent}%`;
  } else {
    progressBar.style.width = '';
    progressBar.classList.add('indeterminate');
  }
}

api.game.onEvent((event) => {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'status') {
    cancelButton.hidden = !['installing', 'java', 'loader', 'visual'].includes(event.phase);
    setProgress(String(event.message || ''), event.phase === 'running' ? 100 : null);
    if (event.phase === 'running') setTimeout(() => setBusy(false), 1800);
  } else if (event.type === 'progress') {
    const base = typeof event.message === 'string' && event.message ? event.message.replace(/[….]+$/, '') : 'Установка';
    const label = typeof event.percent === 'number' ? `${base}… ${event.percent}%` : `${base}…`;
    setProgress(label, typeof event.percent === 'number' ? event.percent : null);
  } else if (event.type === 'warning') {
    showToast(String(event.message), 6000);
  } else if (event.type === 'error' || event.type === 'exited') {
    setBusy(false);
    if (event.report) {
      refreshErrorList();
      if (event.report.dialog) return openErrorDialog(event.report);
    }
    showToast(String(event.message || ''), 6000, event.type === 'error' || event.code ? 'error' : '');
  }
});

playButton.addEventListener('click', async () => {
  setBusy(true);
  setProgress('Подготовка…', null);
  try {
    await call(api.game.play({ version: versionSelect.value }));
  } catch (err) {
    setBusy(false);
    if (err.code === 'LOGIN_REQUIRED') {
      showToast('Для запуска в режиме Microsoft сначала нажми кнопку аккаунта и выполни вход.', 5200);
      return;
    }
    if (err.code === 'CANCELLED') return showToast('Отменено.');
    fail(err);
  }
});
cancelButton.addEventListener('click', () => { api.game.cancel(); });

// ---------------------------------------------------------------- visual mod (switch next to Play)
// While it is on: Minecraft 1.21.11 + Fabric, its own folder. The main process enforces this
// (settings reject version/loader changes, play() ignores them); here the controls just show it.
const VISUAL_MC = '1.21.11';
const visualToggle = $('#visualToggle');
const visualSwitch = $('#visualSwitch');
const openVisualModsButton = $('#openVisualModsButton');

function isVisualMode() { return Boolean(currentSettings && currentSettings.visualMode); }

function applyVisualMode() {
  const on = isVisualMode();
  visualToggle.checked = on;
  openVisualModsButton.hidden = !on;
  $('.version-card').classList.toggle('visual-locked', on);
  $('#versionCardStatus').textContent = on ? 'VISUAL' : 'JAVA';
  versionSelect.disabled = on;
  loaderSelect.disabled = on;
  loaderVersionSelect.disabled = on;
  if (on) {
    if (![...versionSelect.options].some((o) => o.value === VISUAL_MC)) versionSelect.append(option(VISUAL_MC, VISUAL_MC));
    versionSelect.value = VISUAL_MC;
    loaderSelect.value = 'fabric';
    loaderVersionWrap.hidden = true;
    setVersionNote(`Визуальный мод: Minecraft ${VISUAL_MC} · Fabric, отдельная папка. Чтобы снова выбирать версии — выключите переключатель справа от кнопки запуска.`);
  } else {
    const savedVersion = currentSettings ? currentSettings.version : 'release';
    versionSelect.value = [...versionSelect.options].some((o) => o.value === savedVersion) ? savedVersion : 'release';
    loaderSelect.value = currentSettings ? (currentSettings.loader || 'vanilla') : 'vanilla';
    refreshLoaderVersions();
  }
}

visualToggle.addEventListener('change', async () => {
  const want = visualToggle.checked;
  try {
    currentSettings = await call(api.settings.update({ visualMode: want }));
    applyVisualMode();
    if (!want) return showToast('Визуальный мод выключен: версию и загрузчик снова можно выбирать.');
    const info = await call(api.visual.info()).catch(() => null);
    if (info && !info.ready) showToast(`Визуальный мод включён (Minecraft ${VISUAL_MC} · Fabric), но файл мода ещё не добавлен: положите .jar в папку модов (кнопка 🧩).`, 7000);
    else showToast(`Визуальный мод включён: Minecraft ${VISUAL_MC} · Fabric, отдельная папка.`);
  } catch (err) {
    fail(err);
    visualToggle.checked = isVisualMode();
  }
});
openVisualModsButton.addEventListener('click', async () => {
  try { await call(api.visual.openFolder()); } catch (err) { fail(err); }
});

// ---------------------------------------------------------------- builds (сборки: own mods/saves/config per profile)
const buildsList = $('#buildsList');
const buildsEmptyState = $('#buildsEmptyState');
const newBuildButton = $('#newBuildButton');
const newBuildForm = $('#newBuildForm');
const newBuildName = $('#newBuildName');
const newBuildVersion = $('#newBuildVersion');
const newBuildLoader = $('#newBuildLoader');
const LOADER_LABEL = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', quilt: 'Quilt', neoforge: 'NeoForge' };
let buildsCache = [];
let buildVersionsLoaded = false;

async function populateVersionSelect(select) {
  select.replaceChildren(option('release', 'Последний релиз'), option('snapshot', 'Последний snapshot'));
  try {
    const data = await call(api.versions.list());
    select.replaceChildren(
      option('release', `Последний релиз (${data.latest.release})`),
      option('snapshot', `Последний snapshot (${data.latest.snapshot})`)
    );
    const group = document.createElement('optgroup');
    group.label = 'Релизы';
    data.versions.filter((v) => v.type === 'release').forEach((v) => group.append(option(v.id, v.id)));
    select.append(group);
  } catch { /* release/snapshot aliases above still work offline */ }
}

function mk(cls, text, titleText) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.textContent = text;
  if (titleText) btn.title = titleText;
  return btn;
}

function buildCard(b) {
  const wrap = document.createElement('div');
  wrap.className = 'build-card-wrap';
  wrap.dataset.id = b.id;

  const card = document.createElement('div');
  card.className = 'build-card';

  const info = document.createElement('div');
  info.className = 'build-card-info';
  const title = document.createElement('strong');
  title.textContent = b.name;
  const meta = document.createElement('span');
  const verLabel = b.mcVersion === 'release' ? 'Релиз' : b.mcVersion === 'snapshot' ? 'Snapshot' : b.mcVersion;
  meta.textContent = `${verLabel} · ${LOADER_LABEL[b.loader] || b.loader}`;
  info.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'build-card-actions';
  actions.append(mk('primary-button build-play', '▶ Играть'));
  actions.append(mk('secondary-button build-mods-toggle', '🧰 Добавить моды'));
  actions.append(
    mk('icon-button build-open-mods', '🧩', 'Папка модов'),
    mk('icon-button build-open-folder', '📁', 'Папка сборки'),
    mk('secondary-button build-rename', 'Переименовать'),
    mk('secondary-button build-duplicate', 'Дублировать'),
    mk('secondary-button build-delete', 'Удалить')
  );
  card.append(info, actions);
  wrap.append(card);

  return wrap;
}

function renderBuilds() {
  buildsEmptyState.hidden = buildsCache.length > 0;
  buildsList.replaceChildren(...buildsCache.map(buildCard));
}

// ---------------------------------------------------------------- mod catalog window ("Добавить моды")
const modsDialog = $('#modsDialog');
const modsGrid = $('#modsGrid');
const modsInstalledList = $('#modsInstalled');
const MOD_CATEGORIES = [
  ['', 'Все'], ['optimization', 'Оптимизация'], ['utility', 'Утилиты'], ['library', 'Библиотеки'], ['decoration', 'Декор'],
  ['adventure', 'Приключения'], ['magic', 'Магия'], ['technology', 'Технологии'], ['storage', 'Хранение'], ['worldgen', 'Генерация мира'],
  ['mobs', 'Мобы'], ['equipment', 'Снаряжение'], ['food', 'Еда'], ['game-mechanics', 'Механики'], ['transportation', 'Транспорт']
];
const CATEGORY_LABEL = Object.fromEntries(MOD_CATEGORIES.filter(([id]) => id));
Object.assign(CATEGORY_LABEL, { cursed: 'Хаос', economy: 'Экономика', management: 'Управление', minigame: 'Мини-игры', social: 'Социальное' });
const modsState = { build: null, tab: 'browse', query: '', category: '', sort: 'downloads', page: 1, request: 0, installedIds: new Set() };

function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.0', '')} млн`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace('.0', '')} тыс.`;
  return String(n);
}
function modIcon(url, size = 'md') {
  const holder = document.createElement('div');
  holder.className = `mod-icon ${size}`;
  const fallback = () => { holder.replaceChildren(Object.assign(document.createElement('span'), { textContent: '🧩' })); };
  if (!url) { fallback(); return holder; }
  const img = document.createElement('img');
  img.src = url; img.alt = ''; img.loading = 'lazy';
  img.onerror = fallback;
  holder.append(img);
  return holder;
}
const emptyNote = (text) => Object.assign(document.createElement('div'), { className: 'mods-empty', textContent: text });

function setModsTab(tab) {
  modsState.tab = tab;
  $$('.mods-tab').forEach((t) => { const on = t.dataset.tab === tab; t.classList.toggle('active', on); t.setAttribute('aria-selected', String(on)); });
  $('#modsBrowse').hidden = tab !== 'browse';
  $('#modsResultInfo').hidden = tab !== 'browse';
  modsInstalledList.hidden = tab !== 'installed';
  if (tab === 'installed') loadInstalledMods(); else loadModCatalog();
}

function renderModsCategories() {
  $('#modsCats').replaceChildren(...MOD_CATEGORIES.map(([id, label]) => {
    const chip = mk(`mods-chip${modsState.category === id ? ' active' : ''}`, label);
    chip.dataset.category = id;
    chip.setAttribute('aria-pressed', String(modsState.category === id));
    return chip;
  }));
}

/** 1 … 4 5 [6] 7 8 … 40 */
function pageNumbers(current, total) {
  const set = new Set([1, total, current - 2, current - 1, current, current + 1, current + 2]);
  const list = [...set].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out = [];
  list.forEach((n, i) => { if (i && n - list[i - 1] > 1) out.push('…'); out.push(n); });
  return out;
}
function renderPager(page, pages) {
  const pager = $('#modsPager');
  pager.hidden = pages <= 1;
  if (pages <= 1) return pager.replaceChildren();
  const btn = (label, target, { active = false, disabled = false, aria } = {}) => {
    const b = mk(`mods-page${active ? ' active' : ''}`, label);
    b.dataset.page = String(target);
    b.disabled = disabled;
    if (aria) b.setAttribute('aria-label', aria);
    if (active) b.setAttribute('aria-current', 'page');
    return b;
  };
  pager.replaceChildren(
    btn('‹', page - 1, { disabled: page <= 1, aria: 'Предыдущая страница' }),
    ...pageNumbers(page, pages).map((n) => (n === '…' ? Object.assign(document.createElement('span'), { className: 'mods-page-gap', textContent: '…' }) : btn(String(n), n, { active: n === page }))),
    btn('›', page + 1, { disabled: page >= pages, aria: 'Следующая страница' })
  );
}

function modCard(h) {
  const card = document.createElement('article');
  card.className = 'mod-card';
  const top = document.createElement('div');
  top.className = 'mod-card-top';
  const info = document.createElement('div');
  info.className = 'mod-card-info';
  const title = Object.assign(document.createElement('strong'), { textContent: h.title });
  const author = Object.assign(document.createElement('span'), { textContent: h.author ? `от ${h.author}` : '' });
  info.append(title, author);
  top.append(modIcon(h.iconUrl), info);
  const desc = Object.assign(document.createElement('p'), { textContent: h.description || '' });
  const foot = document.createElement('div');
  foot.className = 'mod-card-foot';
  const stats = document.createElement('div');
  stats.className = 'mod-card-stats';
  stats.append(Object.assign(document.createElement('span'), { className: 'mod-downloads', textContent: `⬇ ${formatCount(h.downloads)}`, title: `${h.downloads.toLocaleString('ru-RU')} скачиваний` }));
  h.categories.slice(0, 1).forEach((c) => stats.append(Object.assign(document.createElement('span'), { className: 'mod-tag', textContent: CATEGORY_LABEL[c] || c })));
  const installed = h.installed || modsState.installedIds.has(h.projectId);
  const add = mk(`${installed ? 'secondary-button' : 'primary-button'} mod-add`, installed ? '✓ Установлен' : '+ Добавить');
  add.disabled = installed;
  Object.assign(add.dataset, { projectId: h.projectId, title: h.title, iconUrl: h.iconUrl || '' });
  foot.append(stats, add);
  card.append(top, desc, foot);
  return card;
}

async function loadModCatalog() {
  const build = modsState.build;
  if (!build) return;
  const token = ++modsState.request;
  modsGrid.setAttribute('aria-busy', 'true');
  modsGrid.replaceChildren(...Array.from({ length: 6 }, () => Object.assign(document.createElement('div'), { className: 'mod-card skeleton' })));
  try {
    const res = await call(api.modrinth.browse({ buildId: build.id, query: modsState.query, category: modsState.category, sort: modsState.sort, page: modsState.page }));
    if (token !== modsState.request) return; // a newer request replaced this one
    modsGrid.removeAttribute('aria-busy');
    $('#modsEyebrow').textContent = `${LOADER_LABEL[res.loader] || res.loader} · Minecraft ${res.mcVersion}`;
    $('#modsResultInfo').textContent = res.total ? `Найдено: ${res.total.toLocaleString('ru-RU')} · страница ${res.page} из ${res.pages}` : '';
    if (res.hits.length === 0) modsGrid.replaceChildren(emptyNote(modsState.query || modsState.category ? 'Ничего не найдено. Попробуйте другой запрос или категорию.' : 'Для этой версии пока нет модов.'));
    else modsGrid.replaceChildren(...res.hits.map(modCard));
    renderPager(res.page, res.pages);
    modsGrid.scrollTop = 0;
  } catch (err) {
    if (token !== modsState.request) return;
    modsGrid.removeAttribute('aria-busy');
    $('#modsPager').replaceChildren();
    const box = emptyNote(`Не удалось загрузить каталог: ${err.message}`);
    const retry = mk('secondary-button', 'Повторить');
    retry.addEventListener('click', loadModCatalog);
    box.append(retry);
    modsGrid.replaceChildren(box);
  }
}

async function loadInstalledMods() {
  const build = modsState.build;
  if (!build) return;
  let list = [];
  try { list = await call(api.modrinth.listInstalled(build.id)); } catch (err) { fail(err); }
  modsState.installedIds = new Set(list.map((m) => m.projectId).filter(Boolean));
  $('#modsInstalledCount').textContent = list.length ? String(list.length) : '';
  if (modsState.tab !== 'installed') return;
  const folder = mk('secondary-button', '📁 Открыть папку модов');
  folder.addEventListener('click', () => call(api.builds.openModsFolder(build.id)).catch(fail));
  const rows = list.length ? list.map((m) => {
    const row = document.createElement('div');
    row.className = 'mod-row';
    const info = document.createElement('div');
    info.className = 'mod-card-info';
    info.append(Object.assign(document.createElement('strong'), { textContent: m.title || m.filename }), Object.assign(document.createElement('span'), { textContent: m.filename }));
    const remove = mk('secondary-button mod-remove', 'Удалить');
    remove.dataset.filename = m.filename;
    row.append(modIcon(m.iconUrl, 'sm'), info, remove);
    return row;
  }) : [emptyNote('Пока ничего не добавлено. Загляните в каталог — там самые популярные моды.')];
  modsInstalledList.replaceChildren(Object.assign(document.createElement('div'), { className: 'mods-installed-head' }), ...rows);
  modsInstalledList.firstChild.append(Object.assign(document.createElement('span'), { textContent: list.length ? `Установлено: ${list.length}` : '' }), folder);
}

async function addModFromCatalog(button) {
  const build = modsState.build;
  const { projectId, title, iconUrl } = button.dataset;
  button.disabled = true;
  button.textContent = 'Добавляю…';
  try {
    const installed = await call(api.modrinth.addMod({ buildId: build.id, projectId, title, iconUrl }));
    showToast(installed.length > 1 ? `«${title}» добавлен вместе с зависимостями (${installed.length}).` : `«${title}» добавлен.`, 2800, 'success');
    modsState.installedIds.add(projectId);
    button.className = 'secondary-button mod-add';
    button.textContent = '✓ Установлен';
    loadInstalledMods();
  } catch (err) {
    button.disabled = false;
    button.textContent = '+ Добавить';
    fail(err);
  }
}

function openModsDialog(build) {
  if (build.loader === 'vanilla') return showToast('Сначала выберите загрузчик модов (Fabric, Forge, Quilt или NeoForge) — у этой сборки его нет.', 4200);
  Object.assign(modsState, { build, tab: 'browse', query: '', category: '', sort: 'downloads', page: 1, installedIds: new Set() });
  const verLabel = build.mcVersion === 'release' ? 'последний релиз' : build.mcVersion === 'snapshot' ? 'последний snapshot' : build.mcVersion;
  $('#modsTitle').textContent = `Добавить моды · ${build.name}`;
  $('#modsEyebrow').textContent = `${LOADER_LABEL[build.loader] || build.loader} · Minecraft ${verLabel}`;
  $('#modsSearch').value = '';
  $('#modsSearch').placeholder = `Поиск модов для ${LOADER_LABEL[build.loader] || build.loader}…`;
  $('#modsSort').value = 'downloads';
  $('#modsInstalledCount').textContent = '';
  $('#modsResultInfo').textContent = '';
  renderModsCategories();
  if (!modsDialog.open) modsDialog.showModal();
  setModsTab('browse');
  loadInstalledMods(); // fills the "installed" counter and the ✓ marks
}

let modsSearchTimer;
$('#modsSearch').addEventListener('input', (e) => {
  clearTimeout(modsSearchTimer);
  modsSearchTimer = setTimeout(() => { modsState.query = e.target.value.trim(); modsState.page = 1; loadModCatalog(); }, 350);
});
$('#modsSort').addEventListener('change', (e) => { modsState.sort = e.target.value; modsState.page = 1; loadModCatalog(); });
$('#modsCats').addEventListener('click', (e) => {
  const chip = e.target.closest('.mods-chip');
  if (!chip) return;
  modsState.category = chip.dataset.category;
  modsState.page = 1;
  renderModsCategories();
  loadModCatalog();
});
$('#modsPager').addEventListener('click', (e) => {
  const b = e.target.closest('.mods-page');
  if (!b || b.disabled) return;
  modsState.page = Number(b.dataset.page);
  loadModCatalog();
});
modsGrid.addEventListener('click', (e) => { const b = e.target.closest('.mod-add'); if (b && !b.disabled) addModFromCatalog(b); });
modsInstalledList.addEventListener('click', async (e) => {
  const b = e.target.closest('.mod-remove');
  if (!b) return;
  b.disabled = true;
  try {
    await call(api.modrinth.removeMod(modsState.build.id, b.dataset.filename));
    showToast('Мод удалён.', 2200);
    await loadInstalledMods();
  } catch (err) { b.disabled = false; fail(err); }
});
$$('.mods-tab').forEach((t) => t.addEventListener('click', () => setModsTab(t.dataset.tab)));
$('#modsClose').addEventListener('click', () => modsDialog.close());
modsDialog.addEventListener('click', (e) => { if (e.target === modsDialog) modsDialog.close(); }); // click on the dimmed backdrop
modsDialog.addEventListener('close', () => { modsState.request++; modsState.build = null; if (toast.parentElement !== document.body) document.body.append(toast); });

async function loadBuilds() {
  try { buildsCache = await call(api.builds.list()); } catch { buildsCache = []; }
  renderBuilds();
}

async function playBuild(build) {
  $('[data-page="home"]').click();
  setBusy(true);
  setProgress(`Подготовка «${build.name}»…`, null);
  try {
    await call(api.game.play({ buildId: build.id }));
  } catch (err) {
    setBusy(false);
    if (err.code === 'LOGIN_REQUIRED') {
      showToast('Для запуска сборки в режиме Microsoft сначала выполни вход через кнопку аккаунта.', 5200);
      return;
    }
    if (err.code === 'CANCELLED') return showToast('Отменено.');
    fail(err);
  }
}
async function renameBuild(build) {
  const name = window.prompt('Новое название сборки:', build.name);
  if (name === null) return;
  try {
    await call(api.builds.rename(build.id, name));
    await loadBuilds();
    showToast('Сборка переименована.', 2400, 'success');
  } catch (err) { fail(err); }
}
async function duplicateBuild(build) {
  const name = window.prompt('Название копии:', `${build.name} (копия)`);
  if (name === null) return;
  try {
    await call(api.builds.duplicate(build.id, name));
    await loadBuilds();
    showToast('Сборка продублирована.', 2400, 'success');
  } catch (err) { fail(err); }
}
async function deleteBuild(build) {
  if (!window.confirm(`Удалить сборку «${build.name}» вместе с модами и сейвами? Это необратимо.`)) return;
  try {
    await call(api.builds.delete(build.id));
    await loadBuilds();
    showToast('Сборка удалена.', 2400);
  } catch (err) { fail(err); }
}

buildsList.addEventListener('click', (event) => {
  const wrap = event.target.closest('.build-card-wrap');
  if (!wrap) return;
  const build = buildsCache.find((b) => b.id === wrap.dataset.id);
  if (!build) return;
  if (event.target.closest('.build-play')) return playBuild(build);
  if (event.target.closest('.build-open-mods')) return void call(api.builds.openModsFolder(build.id)).catch(fail);
  if (event.target.closest('.build-open-folder')) return void call(api.builds.openFolder(build.id)).catch(fail);
  if (event.target.closest('.build-rename')) return renameBuild(build);
  if (event.target.closest('.build-duplicate')) return duplicateBuild(build);
  if (event.target.closest('.build-delete')) return deleteBuild(build);
  if (event.target.closest('.build-mods-toggle')) return openModsDialog(build);
});

newBuildButton.addEventListener('click', async () => {
  newBuildForm.hidden = !newBuildForm.hidden;
  if (!newBuildForm.hidden && !buildVersionsLoaded) {
    buildVersionsLoaded = true;
    await populateVersionSelect(newBuildVersion);
  }
});
$('#cancelBuildButton').addEventListener('click', () => { newBuildForm.hidden = true; });
$('#createBuildButton').addEventListener('click', async () => {
  const name = newBuildName.value.trim();
  if (!name) return showToast('Введите название сборки.', 3000);
  try {
    await call(api.builds.create({ name, mcVersion: newBuildVersion.value, loader: newBuildLoader.value }));
    newBuildName.value = '';
    newBuildForm.hidden = true;
    await loadBuilds();
    showToast('Сборка создана.', 2400, 'success');
  } catch (err) { fail(err); }
});

// ---------------------------------------------------------------- .mrpack import
const importPackForm = $('#importPackForm');
const importPackUrl = $('#importPackUrl');
const mrpackFileInput = $('#mrpackFileInput');
const importButtons = ['#importPackUrlButton', '#importPackFileButton'].map((s) => $(s));

async function runImport(task) {
  importButtons.forEach((b) => { b.disabled = true; });
  showToast('Импортирую модпак… это может занять несколько минут.', 60000);
  try {
    const build = await call(task());
    importPackForm.hidden = true;
    importPackUrl.value = '';
    await loadBuilds();
    showToast(`Сборка «${build.name}» импортирована.`, 3500, 'success');
  } catch (err) {
    fail(err);
  } finally {
    importButtons.forEach((b) => { b.disabled = false; });
  }
}

$('#importPackButton').addEventListener('click', () => { importPackForm.hidden = !importPackForm.hidden; });
$('#importPackCancelButton').addEventListener('click', () => { importPackForm.hidden = true; });
$('#importPackUrlButton').addEventListener('click', () => {
  const url = importPackUrl.value.trim();
  if (!url) return showToast('Вставьте ссылку на модпак.', 3000);
  runImport(() => api.mrpack.importUrl({ url }));
});
$('#importPackFileButton').addEventListener('click', () => mrpackFileInput.click());
mrpackFileInput.addEventListener('change', async () => {
  const file = mrpackFileInput.files && mrpackFileInput.files[0];
  mrpackFileInput.value = '';
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  runImport(() => api.mrpack.importFile(bytes, ''));
});

// ---------------------------------------------------------------- error journal (Settings)
async function refreshErrorList() {
  try {
    const items = await call(api.errors.list());
    const list = $('#errorList');
    $('#errorSummary').textContent = items.length
      ? `Последние ошибки (${items.length}). Нажмите на строку, чтобы увидеть причину и что делать.`
      : 'Ошибок пока не было.';
    list.replaceChildren(...items.slice(0, 5).map((item) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'error-row';
      const code = document.createElement('span'); code.className = 'e-code'; code.textContent = item.code;
      const num = document.createElement('span'); num.className = 'e-num'; num.textContent = `№${item.number}`;
      const title = document.createElement('span'); title.className = 'e-title'; title.textContent = item.title;
      const date = document.createElement('span'); date.className = 'e-date'; date.textContent = item.date;
      row.append(code, num, title, date);
      row.addEventListener('click', () => openErrorDialog({ ...item, detail: '' }));
      return row;
    }));
  } catch { /* the journal is optional */ }
}
$('#openErrorsButton').addEventListener('click', openErrorsFolder);

// ---------------------------------------------------------------- startup
(async function init() {
  try {
    currentSettings = await call(api.settings.get());
    closeLauncherToggle.checked = currentSettings.closeLauncherOnGameStart === true;
    $('#authModeSelect').value = currentSettings.authMode || 'microsoft';
    $('#localUsernameInput').value = currentSettings.localUsername || 'Player';
    $('#localUsernameRow').hidden = (currentSettings.authMode || 'microsoft') !== 'local';
    ramRange.value = String(currentSettings.ramGb);
    ramValue.textContent = ramRange.value;
    loaderSelect.value = currentSettings.loader || 'vanilla';
    loaderVersionWrap.hidden = loaderSelect.value === 'vanilla';
    showBackground(await call(api.background.get()));
    renderAccount(await call(api.auth.status()));
    const state = await call(api.game.state());
    if (state.running) setProgress('Игра запущена.', 100);
  } catch (err) { fail(err); }
  await loadSystem();
  await loadVersions();
  refreshLoaderVersions();
  applyVisualMode();
  loadJava();
  refreshErrorList();
  loadBuilds();
})();
