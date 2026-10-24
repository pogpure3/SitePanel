'use strict';

/* SitePanel — фронтенд админ-панели (vanilla JS).
   Оболочка в стиле nginx-ui: боковое меню, шапка с хлебной крошкой,
   три темы оформления. Страница строится один раз; периодический опрос
   обновляет только изменившиеся элементы (patchRow / patchDetail /
   patchDashboard), чтобы интерфейс не мигал и не терял состояние. */

const app = document.getElementById('app');
const THEME_LABELS = { api: 'Осень', light: 'Светлая', dark: 'Тёмная' };
let view = { name: 'dashboard' };
let sitesCache = [];
let pollTimer = null;
let activeLogTimer = null; // автообновление логов на странице сайта
let refreshSeq = 0;        // маркер свежести: устаревшие ответы не патчат DOM

/* ---------- API ---------- */

const API_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // деплой может идти минутами

async function api(method, path, body, opts = {}) {
  // X-Requested-With обязателен: сервер отклоняет мутирующие запросы без него (защита от CSRF).
  const init = { method, headers: { 'X-Requested-With': 'XMLHttpRequest' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  // Таймаут (U-11): зависший запрос раньше оставлял интерфейс «замороженным»
  // без сообщения. ctl.abort() отклоняет fetch — ниже превращаем в понятную ошибку.
  const timeoutMs = opts.timeoutMs || API_DEFAULT_TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, { ...init, signal: ctl.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Таймаут: сервер не ответил за ${Math.round(timeoutMs / 1000)} с`);
    throw new Error('Нет связи с панелью: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
  let data = {};
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

// Глобальный индикатор загрузки для multipart-загрузок (U-11).
function showProgress(pct) {
  const box = document.getElementById('globalProgress');
  if (!box) return;
  box.classList.remove('hidden');
  box.querySelector('.global-progress-bar').style.width = (pct === undefined ? 40 : pct) + '%';
}

function hideProgress() {
  const box = document.getElementById('globalProgress');
  if (!box) return;
  box.classList.add('hidden');
  box.querySelector('.global-progress-bar').style.width = '0%';
}

async function apiUpload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round(e.loaded / e.total * 100);
      showProgress(pct); // прогресс виден и там, где onProgress не передан (U-11)
      if (onProgress) onProgress(pct);
    });
    xhr.addEventListener('load', () => {
      hideProgress();
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* noop */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Ошибка ${xhr.status}`));
    });
    xhr.addEventListener('error', () => { hideProgress(); reject(new Error('Сетевая ошибка')); });
    xhr.send(formData);
  });
}

/* ---------- Тема ---------- */

function currentTheme() {
  const theme = document.documentElement.getAttribute('data-theme');
  return ['api', 'light', 'dark'].includes(theme) ? theme : 'dark';
}

function applyThemeControl() {
  const theme = currentTheme();
  document.getElementById('themeLabel').textContent = THEME_LABELS[theme];
  document.querySelectorAll('[data-theme-choice]').forEach((choice) => {
    choice.setAttribute('aria-checked', String(choice.dataset.themeChoice === theme));
  });
  // Открытому терминалу тоже меняем палитру (term объявлен ниже по модулю,
  // но applyThemeControl вызывается только после инициализации).
  if (term) term.options.theme = terminalTheme();
}

function setTheme(next, persist = true) {
  if (!['api', 'light', 'dark'].includes(next)) next = 'dark';
  document.documentElement.setAttribute('data-theme', next);
  if (persist) {
    try { localStorage.setItem('sp-theme', next); } catch { /* приватный режим */ }
  }
  applyThemeControl();
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== 'https://prtl.evil-mesh.ru') return;
  if (event.data?.type !== 'mesh-theme' || !['api', 'light', 'dark'].includes(event.data.theme)) return;
  setTheme(event.data.theme, false);
});

/* ---------- Модальные окна: доступность ---------- */

// Возврат фокуса при закрытии: храним элемент, который открыл окно.
const modalReturnFocus = new Map();
let focusBeforeModal = null;

function openModal(id) {
  const backdrop = document.getElementById(id);
  if (!backdrop) return;
  const active = document.activeElement;
  modalReturnFocus.set(id, active && active !== document.body ? active : null);
  if (focusBeforeModal === null) focusBeforeModal = active;
  backdrop.classList.remove('hidden');
  // Фон не должен быть доступен скринридеру и Tab, пока окно открыто (U-04).
  for (const el of document.querySelectorAll('#app, .topbar, .sidebar')) el.inert = true;
  // Фокус — на первый интерактивный элемент окна.
  const focusables = backdrop.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  const first = [...focusables].find((el) => !el.disabled && el.offsetParent !== null);
  if (first) first.focus();
}

function closeModal(id) {
  const backdrop = document.getElementById(id);
  if (!backdrop) return;
  backdrop.classList.add('hidden');
  if (![...document.querySelectorAll('.modal-backdrop')].some((b) => !b.classList.contains('hidden'))) {
    for (const el of document.querySelectorAll('#app, .topbar, .sidebar')) el.inert = false;
  }
  const prev = modalReturnFocus.get(id);
  modalReturnFocus.delete(id);
  if (prev && document.contains(prev)) prev.focus();
}

// Не выпускаем фокус из открытого окна.
function focusableIn(root) {
  return [...root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.disabled && el.offsetParent !== null);
}

document.addEventListener('keydown', (e) => {
  const open = [...document.querySelectorAll('.modal-backdrop')].filter((b) => !b.classList.contains('hidden'));
  if (!open.length) return;
  const backdrop = open[open.length - 1];
  if (e.key === 'Escape') {
    // Не выходим из окна во время загрузки/деплоя.
    if (backdrop.dataset.busy === '1') return;
    e.preventDefault();
    closeModal(backdrop.id);
    return;
  }
  if (e.key !== 'Tab') return;
  const items = focusableIn(backdrop);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

/* ---------- Утилиты ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtUptime(sec) {
  if (!sec) return '—';
  if (sec < 60) return sec + 'с';
  if (sec < 3600) return Math.floor(sec / 60) + 'м ' + (sec % 60) + 'с';
  if (sec < 86400) return Math.floor(sec / 3600) + 'ч ' + Math.floor((sec % 3600) / 60) + 'м';
  return Math.floor(sec / 86400) + 'д ' + Math.floor((sec % 86400) / 3600) + 'ч';
}

function fmtBytes(n) {
  if (n === undefined || n === null) return '—';
  if (n < 1024) return n + ' Б';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' КБ';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' МБ';
  return (n / 1073741824).toFixed(2) + ' ГБ';
}

function statusLabel(s) {
  return { running: 'Работает', stopped: 'Остановлен', starting: 'Запускается...', crashed: 'Упал', unknown: '—' }[s] || s;
}

function typeLabel(t) {
  return { node: 'Node.js', docker: 'Docker', static: 'Статика' }[t] || t;
}

// Расширенная подпись статуса: показывает, что панель уже перезапускала сайт.
function statusLabelFull(s, site) {
  const n = (site && site.restartCount) || 0;
  const base = statusLabel(s);
  if (site && site.crashLoop) return base + ' (цикл перезапуска, попыток: ' + n + ')';
  if (n > 0) return base + ' (перезапусков: ' + n + ')';
  return base;
}

function sslBadge(ssl) {
  if (!ssl || ssl.status === 'none') return '<span class="badge">Без SSL</span>';
  if (ssl.status === 'active') {
    const days = ssl.expiresAt ? Math.round((ssl.expiresAt - Date.now()) / 86400000) : null;
    const prefix = ssl.provider === 'letsencrypt' ? "Let's Encrypt" : 'Self-signed';
    const until = days !== null ? ` · ${days} дн.` : '';
    return `<span class="badge ssl-ok" title="Истекает: ${esc(fmtDate(ssl.expiresAt))}">🔒 ${esc(prefix)}${until}</span>`;
  }
  if (ssl.status === 'pending') return '<span class="badge ssl-pending">⏳ Выпуск сертификата...</span>';
  return `<span class="badge ssl-error" title="${esc(ssl.error || '')}">⚠ Ошибка SSL</span>`;
}

// Индикатор цикла перезапусков: панель уже перезапускала сайт или сдалась.
// Без него постоянно падающий сайт выглядел как «Работает» в момент проверки.
function loopBadge(s) {
  if (s.crashLoop) {
    const when = s.lastCrashAt ? `, последнее падение ${esc(fmtDate(s.lastCrashAt))}` : '';
    const n = s.restartCount || 0;
    return `<span class="badge loop-bad" title="Превышен лимит автоперезапусков${when}">🔁 цикл перезапуска${n ? ' (' + n + ')' : ''}</span>`;
  }
  // Серия падений ещё идёт: бэкофф не сброшен (сбрасывается после стабильной работы).
  if ((s.restartAttempts || 0) > 0) {
    return `<span class="badge loop-warn" title="Идёт серия падений, попытка №${s.restartAttempts}">🔁 перезапуск №${s.restartAttempts}</span>`;
  }
  return '';
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function confirmDialog(title, text) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('confirmModal');
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmText').textContent = text;
    openModal('confirmModal');
    // Фокус по умолчанию — на отмене, чтобы случайный Enter не подтверждал удаление.
    const cancel = backdrop.querySelector('[data-close]');
    if (cancel) cancel.focus();
    const ok = document.getElementById('confirmOk');
    ok.onclick = () => { closeModal('confirmModal'); resolve(true); };
    backdrop.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => { closeModal('confirmModal'); resolve(false); }));
  });
}

function promptDialog(title, value = '') {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('promptModal');
    const input = document.getElementById('promptInput');
    document.getElementById('promptTitle').textContent = title;
    document.getElementById('promptInputLabel').textContent = title || 'Значение';
    input.value = value;
    openModal('promptModal');
    input.focus();
    input.select();
    const finish = (result) => { closeModal('promptModal'); resolve(result); };
    document.getElementById('promptOk').onclick = () => finish(input.value.trim());
    input.onkeydown = (e) => { if (e.key === 'Enter') finish(input.value.trim()); };
    backdrop.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => finish(null)));
  });
}

/* ---------- Опрос и обновления ---------- */

// Баннер состояния связи (U-01): ошибки API без истёкшей сессии показываем
// баннером; 401 (сессия истекла / вход не выполнен) уводит на /login —
// родной диалог Basic больше не используется нигде.
function showBanner(text, sticky) {
  const banner = document.getElementById('connBanner');
  if (!banner) return;
  banner.textContent = text;
  banner.classList.remove('hidden');
  banner.classList.toggle('sticky', !!sticky);
}

/** Сессия истекла — на страницу входа, сохраняя, откуда ушли. */
function redirectToLogin() {
  stopPolling();
  stopLogTimer();
  const next = encodeURIComponent(location.pathname + location.search + location.hash || '/');
  location.href = '/login?next=' + next;
}

function isAuthError(msg) {
  return String(msg || '').includes('Требуется авторизация') || String(msg || '').includes('Ошибка 401');
}

function hideBanner() {
  const banner = document.getElementById('connBanner');
  if (banner) banner.classList.add('hidden');
}

let pollInFlight = false;
let pollFailures = 0;

function startPolling() {
  clearTimeout(pollTimer);
  schedulePoll(5000);
}

function schedulePoll(delayMs) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollTick, delayMs);
}

async function pollTick() {
  // Скрытая вкладка не должна генерировать запросы (U-12);
  // ответ дольше интервала — не наслаиваемся вторым тиком.
  if (document.hidden || pollInFlight) {
    schedulePoll(5000);
    return;
  }
  // Не обновляем, пока пользователь печатает в поле ввода (включая терминал).
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) {
    schedulePoll(5000);
    return;
  }
  pollInFlight = true;
  try {
    await refreshCurrentView();
    if (pollFailures > 0) {
      pollFailures = 0;
      hideBanner();
    }
    schedulePoll(5000);
  } catch (err) {
    pollFailures++;
    const msg = String(err.message || '');
    if (msg.includes('Требуется авторизация')) {
      // 401 при живой сессии: браузер сам не повторит — уводим на форму входа.
      redirectToLogin();
      return;
    }
    // Экспоненциальный бэкофф: 10с → 20с → 40с → потолок 60с.
    showBanner('Нет связи с панелью — показаны устаревшие данные. Повтор через ' +
      Math.min(60, 10 * Math.pow(2, Math.min(pollFailures - 1, 3))) + 'с.');
    schedulePoll(Math.min(60000, 10000 * Math.pow(2, Math.min(pollFailures - 1, 3))));
  } finally {
    pollInFlight = false;
  }
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function stopLogTimer() {
  clearInterval(activeLogTimer);
  activeLogTimer = null;
}

/* ---------- Hash-роутинг (U-12) ---------- */

function viewToHash(v) {
  if (v.name === 'site') return '#/sites/' + v.id;
  if (v.name === 'files') return '#/sites/' + v.id + '/files';
  if (v.name === 'backups') return '#/sites/' + v.id + '/backups';
  if (v.name === 'settings') return '#/settings';
  if (v.name === 'list') return '#/sites';
  if (v.name === 'terminal') return '#/terminal';
  if (v.name === 'users') return '#/users';
  return '#/';
}

function viewFromHash() {
  const h = location.hash || '#/';
  let m = /^#\/sites\/([A-Za-z0-9]+)\/files$/.exec(h);
  if (m) return { name: 'files', id: m[1], path: '' };
  m = /^#\/sites\/([A-Za-z0-9]+)\/backups$/.exec(h);
  if (m) return { name: 'backups', id: m[1] };
  m = /^#\/sites\/([A-Za-z0-9]+)/.exec(h);
  if (m) return { name: 'site', id: m[1] };
  if (h === '#/settings') return { name: 'settings' };
  if (h === '#/sites') return { name: 'list' };
  if (h === '#/terminal') return { name: 'terminal' };
  if (h === '#/users') return { name: 'users' };
  return { name: 'dashboard' };
}

/** Смена вида с записью в URL: «Назад» и закладки работают (U-12). */
function navigate(v) {
  view = v;
  const target = viewToHash(v);
  if (location.hash !== target) location.hash = target; // hashchange увидит совпадение и не отрисует второй раз
  render();
}

window.addEventListener('hashchange', () => {
  const next = viewFromHash();
  if (viewToHash(view) === location.hash) return; // это мы сами через navigate()
  view = next;
  render();
});

/* ---------- Оболочка: меню, хлебная крошка ---------- */

const CRUMBS = {
  dashboard: 'Дашборд',
  list: 'Сайты',
  site: 'Сайты',
  files: 'Файлы',
  backups: 'Бэкапы',
  terminal: 'Терминал',
  users: 'Пользователи',
  settings: 'Настройки',
};

function syncShell() {
  // Активный пункт меню: сайт, файлы и бэкапы подсвечивают «Сайты».
  const active = view.name === 'site' || view.name === 'files' || view.name === 'backups' ? 'list' : view.name;
  document.querySelectorAll('.nav-item[data-nav]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === active);
  });
  document.getElementById('crumb').textContent = CRUMBS[view.name] || 'Панель';
  document.title = `${CRUMBS[view.name] || 'Панель'} — SitePanel`;
  // На телефоне меню закрывается после выбора пункта.
  document.body.classList.remove('sidebar-open');
}

// Точечное обновление текущего вида без перестроения страницы.
async function refreshCurrentView() {
  const seq = ++refreshSeq;
  const v = view; // вид на момент запроса: пока ждали ответ, могли уйти на другую страницу
  try {
    if (v.name === 'list') {
      const sites = await api('GET', '/api/sites');
      if (seq !== refreshSeq || view !== v) return; // устаревший ответ не патчит DOM
      sitesCache = sites;
      const domIds = [...document.querySelectorAll('#app .site-row')].map((c) => c.dataset.id).join(',');
      const apiIds = sites.map((s) => s.id).join(',');
      if (domIds !== apiIds) {
        renderList(sites); // состав сайтов изменился — перестраиваем список
      } else {
        for (const s of sites) {
          const row = document.querySelector(`#app .site-row[data-id="${s.id}"]`);
          if (row) patchRow(row, s);
        }
        applySiteFilter();
      }
    } else if (v.name === 'site') {
      const site = await api('GET', '/api/sites/' + v.id);
      if (seq !== refreshSeq || view !== v) return;
      const root = document.getElementById('detailRoot');
      if (!root || root.dataset.id !== site.id) renderSite(site);
      else patchDetail(site);
    } else if (v.name === 'dashboard') {
      const data = await api('GET', '/api/dashboard');
      if (seq !== refreshSeq || view !== v) return;
      const root = document.getElementById('dashRoot');
      if (root) patchDashboard(data);
      else renderDashboard(data);
    }
    // terminal и users — статичные страницы, опрос им ничего не обновляет.
    loadSysInfo();
  } catch (err) {
    if (isAuthError(err.message)) {
      redirectToLogin();
      throw err; // чтобы pollTick остановил бэкофф-логику на 401
    }
    if (String(err.message || '').includes('не найден') && view.name === 'site') navigate({ name: 'list' });
    else throw err;
  }
}

// Полная (пере)сборка текущего вида.
async function render() {
  // Уходя со страницы терминала, гасим сессию: WS и shell не должны жить в фоне.
  if (view.name !== 'terminal') stopTerminal();
  syncShell();
  const v = view; // пока грузим данные, вид могли сменить — старый ответ не рисуем
  try {
    if (v.name === 'list') {
      sitesCache = await api('GET', '/api/sites');
      if (view !== v) return;
      renderList(sitesCache);
    } else if (v.name === 'site') {
      const site = await api('GET', '/api/sites/' + v.id);
      if (view !== v) return;
      renderSite(site);
    } else if (v.name === 'files') {
      await renderFiles();
    } else if (v.name === 'backups') {
      await renderBackups();
    } else if (v.name === 'dashboard') {
      const data = await api('GET', '/api/dashboard');
      if (view !== v) return;
      renderDashboard(data);
    } else if (v.name === 'settings') {
      const [settings, system] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/system')]);
      if (view !== v) return;
      renderSettings(settings, system);
    } else if (v.name === 'terminal') {
      renderTerminal();
    } else if (v.name === 'users') {
      await renderUsers();
    }
    loadSysInfo();
  } catch (err) {
    if (isAuthError(err.message)) {
      redirectToLogin();
      return;
    }
    showBanner('Не удалось загрузить данные: ' + err.message);
  }
}

async function loadSysInfo() {
  try {
    const sys = await api('GET', '/api/system');
    document.getElementById('sysInfo').textContent =
      `Сайтов: ${sys.sites} · Работает: ${sys.running} · аптайм панели ${fmtUptime(sys.panelUptimeSec)}`;
  } catch { /* noop */ }
}

/* ---------- Инициализация оболочки ---------- */

document.getElementById('brandBtn').addEventListener('click', () => navigate({ name: 'list' }));
document.getElementById('listBtn').addEventListener('click', () => navigate({ name: 'list' }));
document.getElementById('dashBtn').addEventListener('click', () => navigate({ name: 'dashboard' }));
document.getElementById('terminalBtn').addEventListener('click', () => navigate({ name: 'terminal' }));
document.getElementById('usersBtn').addEventListener('click', () => navigate({ name: 'users' }));
document.getElementById('settingsBtn').addEventListener('click', () => navigate({ name: 'settings' }));
const themeToggle = document.getElementById('themeSelect');
const themeMenu = document.getElementById('themeMenu');
function closeThemePicker() {
  themeMenu.hidden = true;
  themeToggle.setAttribute('aria-expanded', 'false');
}
themeToggle.addEventListener('click', () => {
  themeMenu.hidden = !themeMenu.hidden;
  themeToggle.setAttribute('aria-expanded', String(!themeMenu.hidden));
});
themeMenu.addEventListener('click', (event) => {
  const choice = event.target.closest('[data-theme-choice]');
  if (!choice) return;
  setTheme(choice.dataset.themeChoice);
  closeThemePicker();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#themePicker')) closeThemePicker();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || themeMenu.hidden) return;
  closeThemePicker();
  themeToggle.focus();
});
applyThemeControl();

// Выход: гасим сессию на сервере и возвращаемся на форму входа.
document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await api('POST', '/api/logout', {});
  } catch { /* сессия могла истечь — cookie всё равно сброшена */ }
  location.href = '/login';
});

document.getElementById('collapseBtn').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('sp-sidebar', document.body.classList.contains('sidebar-collapsed') ? '1' : ''); } catch { /* noop */ }
  // Терминалу нужно пересчитать размеры после смены ширины колонки.
  if (termResizeHandler) termResizeHandler();
});
try { if (localStorage.getItem('sp-sidebar') === '1') document.body.classList.add('sidebar-collapsed'); } catch { /* noop */ }

document.getElementById('menuBtn').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-open');
});
document.getElementById('sidebarBackdrop').addEventListener('click', () => {
  document.body.classList.remove('sidebar-open');
});

document.getElementById('addSiteBtn').addEventListener('click', () => {
  openModal('addModal');
});

// Закрытие модалок: клик по подложке и кнопки «Отмена».
// Во время операции (busy) закрытие блокируется — как Escape (U-04).
document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
  backdrop.addEventListener('click', (e) => {
    if (e.target !== backdrop) return;
    if (backdrop.dataset.busy === '1') return;
    closeModal(backdrop.id);
  });
  backdrop.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (backdrop.dataset.busy === '1') return;
      closeModal(backdrop.id);
    });
  });
});

// Переключение источника: zip / git
function syncSourceFields() {
  const source = document.querySelector('input[name="source"]:checked').value;
  document.getElementById('zipFields').classList.toggle('hidden', source !== 'zip');
  document.getElementById('gitFields').classList.toggle('hidden', source !== 'git');
}
document.querySelectorAll('input[name="source"]').forEach((r) => r.addEventListener('change', syncSourceFields));

// Добавление сайта
document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const source = document.querySelector('input[name="source"]:checked').value;
  const submit = document.getElementById('addSubmit');
  const progress = document.getElementById('addProgress');
  const bar = progress.querySelector('.progress-bar');
  submit.disabled = true;
  progress.classList.remove('hidden');
  bar.style.width = '0%';
  // Пока идёт деплой, окно не закрывается по Escape/клику по подложке.
  document.getElementById('addModal').dataset.busy = '1';

  try {
    let site;
    if (source === 'git') {
      if (!form.gitUrl.value.trim()) throw new Error('Укажите URL репозитория');
      site = await api('POST', '/api/sites/git', {
        url: form.gitUrl.value.trim(),
        branch: form.gitBranch.value.trim() || undefined,
        subdir: form.gitSubdir.value.trim() || undefined,
        token: form.gitToken.value.trim() || undefined,
        name: form.name.value.trim() || undefined,
        autoStart: form.autoStart.checked,
      });
    } else {
      if (!form.file.files.length) throw new Error('Выберите ZIP-архив');
      const fd = new FormData();
      fd.append('file', form.file.files[0]);
      fd.append('name', form.name.value);
      fd.append('autoStart', form.autoStart.checked ? 'true' : 'false');
      site = await apiUpload('/api/sites', fd, (pct) => (bar.style.width = pct + '%'));
    }
    closeModal('addModal');
    form.reset();
    syncSourceFields();
    toast(`Сайт «${site.name}» развёрнут (${typeLabel(site.type)})`, 'success');
    navigate({ name: 'site', id: site.id });
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    submit.disabled = false;
    progress.classList.add('hidden');
    delete document.getElementById('addModal').dataset.busy;
  }
});

view = viewFromHash(); // открытие по ссылке вида #/sites/<id> (U-12)
render();
startPolling();
