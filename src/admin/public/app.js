'use strict';

/* SitePanel — фронтенд админ-панели (vanilla JS).
   Оболочка в стиле nginx-ui: боковое меню, шапка с хлебной крошкой,
   тёмная/светлая темы. Страница строится один раз; периодический опрос
   обновляет только изменившиеся элементы (patchRow / patchDetail /
   patchDashboard), чтобы интерфейс не мигал и не терял состояние. */

const app = document.getElementById('app');
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
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyThemeIcon() {
  const use = document.querySelector('#themeBtn use');
  if (use) use.setAttribute('href', currentTheme() === 'dark' ? '#i-sun' : '#i-moon');
  // Открытому терминалу тоже меняем палитру (term объявлен ниже по модулю,
  // но applyThemeIcon вызывается только после инициализации).
  if (term) term.options.theme = terminalTheme();
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('sp-theme', next); } catch { /* приватный режим */ }
  applyThemeIcon();
}

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

/* ---------- Список сайтов ---------- */

// URL сайта для перехода: первый привязанный домен, https при активном SSL.
function siteUrl(s) {
  if (!s.domains || !s.domains.length) return null;
  return (s.ssl && s.ssl.status === 'active' ? 'https://' : 'http://') + s.domains[0];
}

function siteRowHtml(s) {
  return `<tr class="site-row" data-id="${s.id}">
    <td>
      <div class="site-name-cell">
        <span class="status-dot"></span>
        <div style="min-width:0">
          <div class="site-name"><span class="site-title"></span>
            <span class="badge type"></span>
            <span class="ssl-slot"></span>
            <span class="loop-slot"></span>
          </div>
          <div class="site-cell-meta"></div>
        </div>
      </div>
    </td>
    <td class="cell-domains cell-dim" data-label="Домены"></td>
    <td class="cell-mem cell-dim" data-label="Память"></td>
    <td class="cell-updated cell-dim" data-label="Обновлён"></td>
    <td>
      <div class="row-actions">
        <button class="btn btn-sm btn-success act-start" title="Запустить">▶</button>
        <button class="btn btn-sm act-stop" title="Остановить">⏹</button>
        <button class="btn btn-sm act-restart" title="Перезапустить">🔄</button>
        <a class="btn btn-sm act-visit" title="Перейти на сайт" target="_blank" rel="noopener">🌐</a>
        <button class="btn btn-sm" data-open>Открыть</button>
      </div>
    </td>
  </tr>`;
}

function renderList(sites) {
  stopLogTimer(); // ушед со страницы сайта, не опрашиваем его логи (U-09)
  document.title = 'Сайты — SitePanel';
  if (!sites.length) {
    app.innerHTML = `
      <div class="page-head"><h1>Сайты</h1></div>
      <div class="empty-state">
        <div class="big">📦</div>
        <h2>Сайтов пока нет</h2>
        <p>Нажмите «Добавить сайт» и загрузите .zip архив со статическим сайтом<br>или Node.js-приложением.</p>
      </div>`;
    return;
  }
  app.innerHTML = `
    <div class="page-head">
      <h1>Сайты</h1>
    </div>
    <div class="list-bar">
      <input type="text" id="siteFilter" placeholder="Поиск: название или домен" autocomplete="off" aria-label="Поиск по сайтам">
    </div>
    <div class="table-card">
      <table class="sites-table">
        <thead><tr><th>Сайт</th><th>Домены</th><th>Память</th><th>Обновлён</th><th style="text-align:right">Действия</th></tr></thead>
        <tbody id="sitesBody">${sites.map(siteRowHtml).join('')}</tbody>
      </table>
    </div>`;

  // Делегирование: патч строк каждые 5с не перепривязывает обработчики.
  const body = document.getElementById('sitesBody');
  body.addEventListener('click', async (e) => {
    const row = e.target.closest('.site-row');
    if (!row) return;
    const id = row.dataset.id;
    const interactive = e.target.closest('button, a');
    if (interactive && !interactive.hasAttribute('data-open')) {
      if (!interactive.classList.contains('btn')) return;
      // Кнопки операций: блокируются на время запроса — двойной клик не шлёт два (U-11).
      const btn = interactive;
      btn.disabled = true;
      try {
        const r = await rowAction(id, btn);
        if (r && r.ok === false) throw new Error(r.error || 'Операция не выполнена');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
        refreshCurrentView().catch(() => {});
      }
      return;
    }
    navigate({ name: 'site', id });
  });

  const filter = document.getElementById('siteFilter');
  filter.addEventListener('input', applySiteFilter);

  for (const s of sites) {
    const row = body.querySelector(`.site-row[data-id="${s.id}"]`);
    if (row) patchRow(row, s);
  }
  applySiteFilter();
}

// Запуск/остановка/перезапуск из строки списка.
function rowAction(id, btn) {
  if (btn.classList.contains('act-start')) {
    return api('POST', `/api/sites/${id}/start`).then((r) => {
      toast(r.ok === false ? 'Не запустился: ' + (r.error || '') : 'Сайт запускается', r.ok === false ? 'error' : 'success');
      return r;
    });
  }
  if (btn.classList.contains('act-stop')) {
    return api('POST', `/api/sites/${id}/stop`).then((r) => {
      toast(r.ok === false ? 'Не остановился: ' + (r.error || '') : 'Сайт остановлен', r.ok === false ? 'error' : 'success');
      return r;
    });
  }
  if (btn.classList.contains('act-restart')) {
    return api('POST', `/api/sites/${id}/restart`).then((r) => { toast('Перезапуск...', 'success'); return r; });
  }
  return Promise.resolve({ ok: false, error: 'Неизвестная операция' });
}

// Клиентский фильтр списка: по названию и доменам.
function applySiteFilter() {
  const input = document.getElementById('siteFilter');
  const q = input ? input.value.trim().toLowerCase() : '';
  document.querySelectorAll('#app .site-row').forEach((row) => {
    const s = sitesCache.find((x) => x.id === row.dataset.id);
    if (!s) return;
    const hay = (s.name + ' ' + (s.domains || []).join(' ')).toLowerCase();
    row.style.display = !q || hay.includes(q) ? '' : 'none';
  });
}

// Обновляет одну строку таблицы на месте: статус, бейджи, метрики, видимость кнопок.
function patchRow(row, s) {
  const dot = row.querySelector('.status-dot');
  dot.className = 'status-dot ' + (s.status || '');
  dot.title = statusLabelFull(s.status, s);

  row.querySelector('.site-title').textContent = s.name;
  row.querySelector('.badge.type').textContent = s.type === 'node' ? 'Node.js' : 'Статика';
  row.querySelector('.ssl-slot').innerHTML = sslBadge(s.ssl);
  row.querySelector('.loop-slot').innerHTML = loopBadge(s);

  const meta = [];
  if (s.health && s.health.status === 'up') meta.push(`<span title="Ответ: ${s.health.lastMs} мс">💚 health ok</span>`);
  if (s.health && s.health.status === 'down') meta.push('<span title="Health-check не проходит">💔 health fail</span>');
  if (s.stats && s.stats.memoryMb) meta.push(`<span>RAM ${s.stats.memoryMb} МБ</span>`);
  row.querySelector('.site-cell-meta').innerHTML = meta.join('');

  row.querySelector('.cell-domains').textContent =
    s.domains && s.domains.length ? s.domains.join(', ') : 'Домен не привязан';
  row.querySelector('.cell-mem').textContent = s.stats && s.stats.memoryMb ? s.stats.memoryMb + ' МБ' : '—';
  row.querySelector('.cell-updated').textContent = fmtDate(s.updatedAt);

  // Кнопки следуют за статусом (в момент остановки running может ещё быть true).
  const running = s.status === 'running';
  row.querySelector('.act-start').classList.toggle('hidden', running);
  row.querySelector('.act-stop').classList.toggle('hidden', !running);
  row.querySelector('.act-restart').classList.toggle('hidden', !running);

  const visit = row.querySelector('.act-visit');
  const url = siteUrl(s);
  if (url) {
    visit.href = url;
    visit.title = 'Перейти на сайт — ' + url;
    visit.classList.remove('hidden');
  } else {
    visit.classList.add('hidden');
  }
}

/* ---------- Страница сайта ---------- */

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU');
}

function healthStripHtml(history) {
  const cells = (history || []).slice(-40).map((h) =>
    `<span class="health-cell ${h.ok ? 'ok' : 'fail'}" title="${esc(fmtTime(h.t) + ' · ' + (h.code || 'нет ответа') + ' · ' + h.ms + 'мс')}"></span>`
  ).join('');
  return cells || '<p class="hint">История проверок появится через несколько минут.</p>';
}

function sslInfoHtml(site) {
  const parts = [`<p>${sslBadge(site.ssl)}</p>`];
  if (site.ssl && site.ssl.error) parts.push(`<div class="warn">${esc(site.ssl.error)}</div>`);
  if (!site.ssl || site.ssl.status !== 'active') return parts.join('');

  parts.push(`<dl class="kv">
      <dt>Провайдер</dt><dd>${site.ssl.provider === 'letsencrypt' ? "Let's Encrypt" : 'Self-signed'}</dd>
      <dt>Выдан</dt><dd>${fmtDate(site.ssl.issuedAt)}</dd>
      <dt>Истекает</dt><dd>${fmtDate(site.ssl.expiresAt)}</dd>
    </dl>`);

  // Покрытие привязанных доменов сертификатом. Домены попадают в сертификат
  // только в момент выпуска: привязка нового домена сама по себе его туда
  // не добавляет, и без этой таблицы расхождение было невидимо.
  const sslDomains = Array.isArray(site.ssl.domains) ? site.ssl.domains : [];
  const bound = Array.isArray(site.domains) ? site.domains : [];
  const notCovered = bound.filter((d) => !sslDomains.includes(d));
  const stale = sslDomains.filter((d) => !bound.includes(d));

  parts.push('<p class="hint" style="margin:10px 0 6px">Покрытие привязанных доменов:</p>');
  parts.push('<div class="domain-list">' + (bound.map((d) => {
    const covered = sslDomains.includes(d);
    const badge = covered
      ? '<span class="badge ssl-ok" title="Домен входит в сертификат">покрыт</span>'
      : d.startsWith('*.')
        ? '<span class="badge" title="Wildcard не покрывается выпуском Let\'s Encrypt по HTTP-01 (нужен DNS-01)">без сертификата</span>'
        : '<span class="badge ssl-pending" title="Домен привязан, но его нет в сертификате">не покрыт</span>';
    return `<div class="domain-row"><span>${esc(d)}</span>${badge}</div>`;
  }).join('') || '<p class="hint">Нет привязанных доменов.</p>') + '</div>');

  if (notCovered.some((d) => !d.startsWith('*.'))) {
    parts.push('<div class="warn">Есть привязанные домены вне сертификата — перевыпустите сертификат («Выпустить Let\'s Encrypt»), чтобы добавить их.</div>');
  }
  if (stale.length) {
    parts.push(`<p class="hint">В сертификате есть домены, которые уже не привязаны к сайту: ${esc(stale.join(', '))}.</p>`);
  }
  return parts.join('');
}

function renderSite(site) {
  stopLogTimer();
  document.title = `${site.name} — SitePanel`;
  document.getElementById('crumb').textContent = site.name;

  app.innerHTML = `
    <div id="detailRoot" data-id="${site.id}">
      <div class="page-head">
        <button class="back-btn" id="backBtn">← Все сайты</button>
        <h1><span class="status-dot" id="dStatusDot"></span> <span id="dName">${esc(site.name)}</span></h1>
        <span class="ssl-slot" id="dSslBadge"></span>
        <span class="loop-slot" id="dLoopBadge"></span>
        <button class="btn btn-sm" id="renameSiteBtn" title="Переименовать сайт">✎</button>
      </div>

      <div class="detail-grid">
        <div class="panel">
          <h2>Обзор</h2>
          <dl class="kv">
            <dt>Статус</dt><dd id="dStatus"></dd>
            <dt>Тип</dt><dd id="dType"></dd>
            <dt>Внутренний порт</dt><dd id="dPort"></dd>
            <dt>PID</dt><dd id="dPid">—</dd>
            <dt>Память</dt><dd id="dMem">—</dd>
            <dt>Аптайм процесса</dt><dd id="dUptime">—</dd>
            <dt>Обновлён</dt><dd id="dUpdated"></dd>
            <dt>Создан</dt><dd id="dCreated"></dd>
            <dt>Git</dt><dd id="dGit">—</dd>
          </dl>
          <label class="checkbox" style="margin-top:10px"><input type="checkbox" id="autoStartBox"> Запускать автоматически при старте панели</label>
          <div class="warn hidden" id="dWarn"></div>
          <div class="actions-row">
            <button class="btn btn-sm btn-success act-start">▶ Запустить</button>
            <button class="btn btn-sm act-stop">⏹ Остановить</button>
            <button class="btn btn-sm act-restart">🔄 Перезапустить</button>
            <button class="btn btn-sm act-files">📁 Файлы</button>
            <label class="btn btn-sm" style="margin:0">
              ⬆ Обновить (загрузить zip)
              <input type="file" accept=".zip" id="updateFile" style="display:none">
            </label>
            <button class="btn btn-sm btn-primary act-gitupdate">⬇ Обновить из Git</button>
            <button class="btn btn-sm act-rollback">↩ Откатить предыдущую версию</button>
          </div>
        </div>

        <div class="panel">
          <h2>Домены</h2>
          <div class="domain-list" id="domainList"></div>
          <form class="inline-form" id="addDomainForm">
            <input type="text" name="domain" placeholder="example.com или *.example.com" aria-label="Домен для привязки" autocomplete="off">
            <button class="btn btn-primary" type="submit">Привязать</button>
          </form>
          <p class="domain-hint">После привязки домена создайте A-запись, указывающую на IP этого сервера. Для wildcard <code>*.domain</code> сертификат Let's Encrypt не выпускается (нужен DNS-01), но маршрутизация работает.</p>
        </div>

        <div class="panel">
          <h2>SSL-сертификат</h2>
          <div id="dSslInfo"></div>
          <div class="actions-row">
            <button class="btn btn-primary btn-sm" id="issueLeBtn">🔒 Выпустить Let's Encrypt</button>
            <button class="btn btn-sm" id="selfsignedBtn">Self-signed (для тестов)</button>
            <button class="btn btn-sm btn-danger" id="sslOffBtn">Отключить SSL</button>
          </div>
          <p class="domain-hint">Let's Encrypt выпускается по HTTP-01 challenge: домен должен указывать на этот сервер, порт 80 должен быть доступен из интернета. После выпуска HTTP автоматически перенаправляется на HTTPS.</p>
        </div>

        <div class="panel">
          <h2>Бэкапы</h2>
          <div id="dBackupInfo"></div>
          <div class="actions-row">
            <button class="btn btn-sm btn-primary" id="backupScheduleBtn">⚙ Расписание</button>
            <button class="btn btn-sm act-backup-now">💾 Создать сейчас</button>
            <button class="btn btn-sm" id="backupOpenBtn">📂 Все бэкапы</button>
          </div>
        </div>

        <div class="panel">
          <h2>Мониторинг</h2>
          <div id="dHealth"></div>
          <div class="health-strip" id="dHealthStrip"></div>
        </div>

        <div class="panel span2">
          <h2>Логи</h2>
          <div class="actions-row" style="margin:0 0 10px">
            <button class="btn btn-sm" id="logRefresh">Обновить</button>
            <label class="checkbox hint"><input type="checkbox" id="logAuto"> Автообновление каждые 2с</label>
          </div>
          <pre class="log-box" id="logBox">Загрузка...</pre>
        </div>

        <div class="panel span2" style="border-color:#7f1d1d">
          <h2>Опасная зона</h2>
          <div class="actions-row" style="margin:0">
            <button class="btn btn-danger btn-sm" id="deleteSiteBtn">🗑 Удалить сайт</button>
            <span class="hint" style="align-self:center">Сайт будет остановлен, файлы, домены и сертификаты удалены.</span>
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById('backBtn').onclick = () => navigate({ name: 'list' });

  const siteId = site.id;
  // Кнопка блокируется на время операции (U-11): двойной клик не шлёт второй
  // DELETE/rollback; {ok:false} при HTTP 200 показывается как ошибка (U-08).
  const act = (sel, fn) => {
    const el = app.querySelector(sel);
    if (!el) return;
    el.addEventListener('click', async () => {
      el.disabled = true;
      try {
        const r = await fn();
        if (r && r.ok === false) throw new Error(r.error || 'Операция не выполнена');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        el.disabled = false;
        refreshCurrentView().catch(() => {});
      }
    });
  };
  act('.act-start', async () => {
    const r = await api('POST', `/api/sites/${siteId}/start`);
    toast(r.ok === false ? 'Не запустился: ' + (r.error || '') : 'Сайт запускается', r.ok === false ? 'error' : 'success');
    return r;
  });
  act('.act-stop', async () => {
    const r = await api('POST', `/api/sites/${siteId}/stop`);
    toast(r.ok === false ? 'Не остановился: ' + (r.error || '') : 'Сайт остановлен', r.ok === false ? 'error' : 'success');
    return r;
  });
  act('.act-restart', () => api('POST', `/api/sites/${siteId}/restart`).then(() => toast('Перезапуск...', 'success')));
  act('.act-files', () => { navigate({ name: 'files', id: siteId, path: '' }); });
  act('.act-backup-now', async () => {
    toast('Создаём бэкап...');
    const r = await api('POST', `/api/sites/${siteId}/backups`);
    toast(`Бэкап создан (${fmtBytes(r.backup && r.backup.sizeBytes)})`, 'success');
    return r;
  });
  document.getElementById('backupOpenBtn').onclick = () => navigate({ name: 'backups', id: siteId });
  document.getElementById('backupScheduleBtn').onclick = () => openBackupSchedule(siteId, site.backupSchedule);
  act('.act-rollback', async () => {
    if (!(await confirmDialog('Откатить версию?', 'Текущая версия будет заменена предыдущей (бэкапом).'))) return undefined;
    const r = await api('POST', `/api/sites/${siteId}/rollback`);
    toast(r.ok === false ? 'Откат не удался: ' + (r.error || '') : 'Откат выполнен', r.ok === false ? 'error' : 'success');
    return r;
  });

  // Переименование и автозапуск (U-03): раньше были доступны только через API.
  const renameBtn = document.getElementById('renameSiteBtn');
  renameBtn.onclick = async () => {
    const name = await promptDialog('Новое название сайта', site.name);
    if (!name || name === site.name) return;
    try {
      await api('PATCH', `/api/sites/${siteId}`, { name });
      toast('Сайт переименован', 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const autoStartBox = document.getElementById('autoStartBox');
  autoStartBox.checked = !!site.autoStart;
  autoStartBox.addEventListener('change', async () => {
    try {
      await api('PATCH', `/api/sites/${siteId}`, { autoStart: autoStartBox.checked });
      toast(autoStartBox.checked ? 'Автозапуск включён' : 'Автозапуск выключен', 'success');
    } catch (err) {
      toast(err.message, 'error');
      autoStartBox.checked = !!site.autoStart;
    }
  });

  // Обновление сайта загрузкой zip
  const updateFile = document.getElementById('updateFile');
  updateFile.addEventListener('change', async () => {
    if (!updateFile.files.length) return;
    const fd = new FormData();
    fd.append('file', updateFile.files[0]);
    try {
      toast('Деплой новой версии...');
      const r = await apiUpload(`/api/sites/${siteId}/update`, fd);
      // ok:false при HTTP 200 значит «распаковано, но не запустилось» (U-08).
      if (r.ok) toast('Сайт обновлён', 'success');
      // Новая версия не запустилась: панель уже вернула предыдущую из бэкапа.
      else toast((r.result && r.result.error) || 'Деплой завершился, но сайт не запустился', 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
    render();
  });

  // Обновление из Git
  act('.act-gitupdate', async () => {
    toast('Обновление из Git-репозитория...');
    const r = await api('POST', `/api/sites/${siteId}/update-git`, {});
    if (r.ok) toast('Сайт обновлён из Git', 'success');
    else toast((r.result && r.result.error) || 'Обновление не удалось', 'error');
    render();
  });

  // Домены
  document.getElementById('addDomainForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.querySelector('input[name=domain]');
    try {
      await api('POST', `/api/sites/${siteId}/domains`, { domain: input.value });
      toast('Домен привязан', 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // SSL
  act('#issueLeBtn', async () => {
    if (!site.domains.length) return toast('Сначала привяжите домен', 'error');
    const leDomains = site.domains.filter((d) => !d.startsWith('*'));
    if (await confirmDialog("Выпустить сертификат Let's Encrypt?", `Домены: ${leDomains.join(', ')}. Убедитесь, что DNS указывает на этот сервер и порт 80 доступен.`)) {
      toast("Выпуск сертификата Let's Encrypt — это занимает до минуты...");
      try {
        await api('POST', `/api/sites/${siteId}/ssl/issue`, { domains: leDomains });
        toast('Сертификат выпущен', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
      render();
    }
  });
  act('#selfsignedBtn', async () => {
    await api('POST', `/api/sites/${siteId}/ssl/selfsigned`);
    toast('Self-signed сертификат выпущен', 'success');
    render();
  });
  act('#sslOffBtn', async () => {
    if (await confirmDialog('Отключить SSL?', 'HTTPS перестанет работать для этого сайта.')) {
      await api('POST', `/api/sites/${siteId}/ssl/disable`);
      toast('SSL отключён');
      render();
    }
  });

  // Логи
  const logBox = document.getElementById('logBox');
  async function refreshLog() {
    try {
      const data = await api('GET', `/api/sites/${siteId}/logs?lines=300`);
      logBox.textContent = data.log || '(логи пусты)';
      logBox.scrollTop = logBox.scrollHeight;
    } catch { /* noop */ }
  }
  refreshLog();
  document.getElementById('logRefresh').addEventListener('click', refreshLog);
  document.getElementById('logAuto').addEventListener('change', (e) => {
    stopLogTimer();
    if (e.target.checked) activeLogTimer = setInterval(refreshLog, 2000);
  });

  // Удаление
  document.getElementById('deleteSiteBtn').addEventListener('click', async () => {
    if (!(await confirmDialog(`Удалить сайт «${site.name}»?`, 'Файлы сайта, логи и сертификаты будут удалены безвозвратно.'))) return;
    try {
      await api('DELETE', `/api/sites/${siteId}`);
      toast('Сайт удалён', 'success');
      navigate({ name: 'list' });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  patchDetail(site);
}

// Точечное обновление страницы сайта: только изменяемые значения.
function patchDetail(site) {
  const root = document.getElementById('detailRoot');
  if (!root || root.dataset.id !== site.id) return;

  const dot = document.getElementById('dStatusDot');
  dot.className = 'status-dot ' + (site.status || '');
  dot.title = statusLabelFull(site.status, site);
  document.getElementById('dName').textContent = site.name;
  document.getElementById('dSslBadge').innerHTML = sslBadge(site.ssl);
  document.getElementById('dLoopBadge').innerHTML = loopBadge(site);

  document.getElementById('dStatus').textContent = statusLabelFull(site.status, site);
  document.getElementById('dType').textContent = site.type === 'node' ? 'Node.js-приложение' : 'Статический сайт';
  document.getElementById('dPort').textContent = site.port || '—';
  document.getElementById('dPid').textContent = site.stats && site.stats.pid ? site.stats.pid : '—';
  document.getElementById('dMem').textContent = site.stats && site.stats.memoryMb ? site.stats.memoryMb + ' МБ' : '—';
  document.getElementById('dUptime').textContent = site.stats ? fmtUptime(site.stats.uptimeSec) : '—';
  document.getElementById('dUpdated').textContent = fmtDate(site.updatedAt);
  document.getElementById('dCreated').textContent = fmtDate(site.createdAt);
  document.getElementById('dGit').innerHTML = site.gitUrl
    ? `${esc(site.gitUrl)}${site.gitBranch ? ' · ' + esc(site.gitBranch) : ''}`
    : '—';

  const warn = document.getElementById('dWarn');
  if (site.lastDeployWarning) {
    warn.textContent = '⚠ ' + site.lastDeployWarning;
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }

  // Кнопки следуют за статусом (см. patchRow).
  const running = site.status === 'running';
  app.querySelector('.act-start').classList.toggle('hidden', running);
  app.querySelector('.act-stop').classList.toggle('hidden', !running);
  app.querySelector('.act-restart').classList.toggle('hidden', !running);
  app.querySelector('.act-gitupdate').classList.toggle('hidden', !site.gitUrl);
  app.querySelector('.act-rollback').classList.toggle('hidden', !site.hasBackup);
  const sslOff = document.getElementById('sslOffBtn');
  if (sslOff) sslOff.classList.toggle('hidden', !site.ssl || site.ssl.status === 'none');

  const h = site.health;
  document.getElementById('dHealth').innerHTML = h && h.lastCheck
    ? `<dl class="kv">
         <dt>Health-check</dt><dd>${h.status === 'up' ? '💚 проходит' : '💔 не проходит'} (${h.lastCode || 'нет ответа'}, ${h.lastMs} мс)</dd>
         <dt>Последняя проверка</dt><dd>${fmtDate(h.lastCheck)}</dd>
       </dl>`
    : '<p class="hint">Проверки выполняются каждые 30 секунд.</p>';
  document.getElementById('dHealthStrip').innerHTML = healthStripHtml(site.history);
  document.getElementById('dSslInfo').innerHTML = sslInfoHtml(site);
  document.getElementById('dBackupInfo').innerHTML = backupInfoHtml(site.backupSchedule);

  // Домены с кнопкой отвязки (U-08): раньше #domainList никогда не заполнялся.
  const domainBox = document.getElementById('domainList');
  if (domainBox) {
    const domains = Array.isArray(site.domains) ? site.domains : [];
    domainBox.innerHTML = domains.length
      ? domains.map((d) =>
          `<div class="domain-row"><span>${esc(d)}</span>` +
          `<button class="remove" data-rm-domain="${esc(d)}" title="Отвязать ${esc(d)}" aria-label="Отвязать домен ${esc(d)}">✕</button></div>`
        ).join('')
      : '<p class="hint">Домены не привязаны.</p>';
    domainBox.querySelectorAll('[data-rm-domain]').forEach((btn) => {
      btn.addEventListener('click', () => {
        api('DELETE', `/api/sites/${site.id}/domains/${encodeURIComponent(btn.dataset.rmDomain)}`)
          .then(() => { toast('Домен отвязан', 'success'); render(); })
          .catch((err) => toast(err.message, 'error'));
      });
    });
  }
}

/* ---------- Файловый менеджер ---------- */

function fmJoin(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

async function openEditor(siteId, filePath) {
  let data;
  try {
    data = await api('GET', `/api/sites/${siteId}/file?path=${encodeURIComponent(filePath)}`);
  } catch (err) {
    return toast(err.message, 'error');
  }
  if (data.binary) return toast('Бинарный файл — доступно только скачивание', 'error');
  const backdrop = document.getElementById('editModal');
  const area = document.getElementById('editArea');
  document.getElementById('editTitle').textContent = data.path;
  area.value = data.content;
  openModal('editModal');
  area.focus();
  document.getElementById('editSave').onclick = async () => {
    try {
      await api('PUT', `/api/sites/${siteId}/file`, { path: data.path, content: area.value });
      closeModal('editModal');
      toast('Файл сохранён', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

async function renderFiles() {
  let site;
  try {
    site = await api('GET', '/api/sites/' + view.id);
  } catch (err) {
    return toast(err.message, 'error');
  }
  document.title = `Файлы — ${site.name} — SitePanel`;
  document.getElementById('crumb').textContent = `Файлы — ${site.name}`;
  stopLogTimer();

  let data;
  try {
    data = await api('GET', `/api/sites/${view.id}/files?path=${encodeURIComponent(view.path || '')}`);
  } catch (err) {
    app.innerHTML = `
      <div class="page-head">
        <button class="back-btn" id="backBtn">← К сайту</button>
        <h1>📁 Файлы</h1>
      </div>
      <div class="panel"><p class="hint">${esc(err.message)}</p></div>`;
    document.getElementById('backBtn').onclick = () => navigate({ name: 'site', id: view.id });
    return;
  }

  const segs = (view.path || '').split('/').filter(Boolean);
  const crumbs = [`<a data-crumb="">${esc(data.root)}</a>`].concat(
    segs.map((s, i) => `<a data-crumb="${esc(segs.slice(0, i + 1).join('/'))}">${esc(s)}</a>`)
  ).join(' / ');

  const rows = [];
  if (segs.length) {
    rows.push(`<tr><td>↩</td><td class="fm-name" data-nav="${esc(segs.slice(0, -1).join('/'))}">..</td><td></td><td></td><td></td></tr>`);
  }
  for (const e of data.entries) {
    const p = fmJoin(view.path, e.name);
    const actions = e.dir
      ? `<button data-rename="${esc(p)}" title="Переименовать">✎</button><button data-del="${esc(p)}" title="Удалить">✕</button>`
      : `<button data-edit="${esc(p)}" title="Редактировать">✏️</button>` +
        `<button data-rename="${esc(p)}" title="Переименовать">✎</button>` +
        `<a href="/api/sites/${view.id}/file?path=${encodeURIComponent(p)}&download=1" title="Скачать">⬇</a>` +
        `<button data-del="${esc(p)}" title="Удалить">✕</button>`;
    rows.push(`<tr>
      <td>${e.dir ? '📁' : '📄'}</td>
      <td class="fm-name" data-nav="${e.dir ? esc(p) : ''}" data-edit-file="${e.dir ? '' : esc(p)}">${esc(e.name)}</td>
      <td>${e.dir ? '—' : fmtBytes(e.size)}</td>
      <td>${fmtDate(e.mtime)}</td>
      <td class="fm-actions">${actions}</td>
    </tr>`);
  }

  app.innerHTML = `
    <div class="page-head">
      <button class="back-btn" id="backBtn">← К сайту</button>
      <h1>📁 ${esc(site.name)}</h1>
    </div>
    <div class="panel">
      <div class="fm-bar">
        <span class="crumbs" id="fmCrumbs">${crumbs}</span>
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="fmRefresh" title="Обновить">🔄</button>
        <button class="btn btn-sm" id="fmMkdir">📁 Папка</button>
        <button class="btn btn-sm" id="fmNewFile">📄 Файл</button>
        <label class="btn btn-sm" style="margin:0">⬆ Загрузить<input type="file" id="fmUpload" style="display:none"></label>
      </div>
      <table class="fm-table">
        <thead><tr><th style="width:30px"></th><th>Имя</th><th style="width:90px">Размер</th><th style="width:130px">Изменён</th><th style="width:150px"></th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      ${data.entries.length ? '' : '<p class="hint" style="margin-top:10px">Каталог пуст</p>'}
    </div>`;

  const nav = (p) => { view.path = p; renderFiles(); };
  const siteId = view.id;

  document.getElementById('backBtn').onclick = () => navigate({ name: 'site', id: siteId });
  document.getElementById('fmRefresh').onclick = () => renderFiles();
  document.querySelectorAll('#fmCrumbs a').forEach((a) => (a.onclick = () => nav(a.dataset.crumb)));

  document.getElementById('fmMkdir').onclick = async () => {
    const name = await promptDialog('Имя новой папки');
    if (!name) return;
    try {
      await api('POST', `/api/sites/${siteId}/files/mkdir`, { path: fmJoin(view.path, name) });
      renderFiles();
    } catch (err) { toast(err.message, 'error'); }
  };

  document.getElementById('fmNewFile').onclick = async () => {
    const name = await promptDialog('Имя нового файла', 'file.txt');
    if (!name) return;
    try {
      await api('PUT', `/api/sites/${siteId}/file`, { path: fmJoin(view.path, name), content: '' });
      openEditor(siteId, fmJoin(view.path, name));
      renderFiles();
    } catch (err) { toast(err.message, 'error'); }
  };

  const upload = document.getElementById('fmUpload');
  upload.addEventListener('change', async () => {
    if (!upload.files.length) return;
    const file = upload.files[0];
    const fd = new FormData();
    fd.append('file', file);
    fd.append('path', view.path || '');
    if (/\.zip$/i.test(file.name) && await confirmDialog('Распаковать архив?', `Файлы из «${file.name}» будут распакованы в текущий каталог, сам архив удалён.`)) {
      fd.append('extract', '1');
      // Явное подтверждение распаковки: сервер отвергает extract без него (P-31).
      fd.append('confirm', '1');
    }
    try {
      const r = await apiUpload(`/api/sites/${siteId}/files/upload`, fd);
      toast(r.extracted ? 'Архив загружен и распакован' : 'Файл загружен', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    renderFiles();
  });

  app.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => { if (el.dataset.nav !== '' && el.dataset.nav !== undefined) nav(el.dataset.nav); });
  });
  app.querySelectorAll('[data-edit-file]').forEach((el) => {
    el.addEventListener('click', () => { if (el.dataset.editFile) openEditor(siteId, el.dataset.editFile); });
  });
  app.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openEditor(siteId, b.dataset.edit)));
  app.querySelectorAll('[data-rename]').forEach((b) => {
    b.onclick = async () => {
      const old = b.dataset.rename;
      const newName = await promptDialog('Переименовать', old.split('/').pop());
      if (!newName) return;
      try {
        await api('POST', `/api/sites/${siteId}/files/rename`, { from: old, to: newName });
        renderFiles();
      } catch (err) { toast(err.message, 'error'); }
    };
  });
  app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const p = b.dataset.del;
      if (await confirmDialog('Удалить?', `${p}${p.includes('/') ? '' : ' (каталоги удаляются с содержимым)'}`)) {
        try {
          await api('DELETE', `/api/sites/${siteId}/file?path=${encodeURIComponent(p)}`);
          renderFiles();
        } catch (err) { toast(err.message, 'error'); }
      }
    };
  });
}

/* ---------- Бэкапы ---------- */

function fmtInterval(h) {
  const n = Number(h) || 0;
  if (n >= 24 && n % 24 === 0) {
    const d = n / 24;
    return d + ' дн.';
  }
  return (n % 1 === 0 ? n : n.toFixed(1)) + ' ч';
}

function backupInfoHtml(sched) {
  if (!sched) return '<p class="hint">—</p>';
  const badge = sched.enabled
    ? `<span class="badge ssl-ok">По расписанию: каждые ${esc(fmtInterval(sched.intervalHours))}, хранить ${esc(sched.keep)}</span>`
    : '<span class="badge">По расписанию: выключено</span>';
  const last = sched.lastRunAt
    ? `<div class="hint">Последний бэкап: ${fmtDate(sched.lastRunAt)}</div>`
    : '<div class="hint">Бэкапов ещё не было</div>';
  const err = sched.lastError ? `<div class="warn">⚠ ${esc(sched.lastError)}</div>` : '';
  return `${badge}${last}${err}`;
}

function openBackupSchedule(siteId, sched) {
  document.getElementById('backupEnabled').checked = !!(sched && sched.enabled);
  document.getElementById('backupInterval').value = (sched && sched.intervalHours) || 24;
  document.getElementById('backupKeep').value = (sched && sched.keep) || 5;
  openModal('backupModal');
  document.getElementById('backupModalSave').onclick = async () => {
    const body = {
      enabled: document.getElementById('backupEnabled').checked,
      intervalHours: Number(document.getElementById('backupInterval').value),
      keep: Number(document.getElementById('backupKeep').value),
    };
    try {
      await api('PUT', `/api/sites/${siteId}/backups/schedule`, body);
      closeModal('backupModal');
      toast(body.enabled ? 'Расписание бэкапов сохранено' : 'Расписание бэкапов выключено', 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

async function renderBackups() {
  let site;
  try {
    site = await api('GET', '/api/sites/' + view.id);
  } catch (err) {
    return toast(err.message, 'error');
  }
  document.title = `Бэкапы — ${site.name} — SitePanel`;
  document.getElementById('crumb').textContent = `Бэкапы — ${site.name}`;
  stopLogTimer(); // ушед со страницы сайта, не опрашиваем его логи (U-09)

  const siteId = view.id;
  let data;
  try {
    data = await api('GET', `/api/sites/${siteId}/backups`);
  } catch (err) {
    app.innerHTML = `
      <div class="page-head">
        <button class="back-btn" id="backBtn">← К сайту</button>
        <h1>💾 Бэкапы</h1>
      </div>
      <div class="panel"><p class="hint">${esc(err.message)}</p></div>`;
    document.getElementById('backBtn').onclick = () => navigate({ name: 'site', id: siteId });
    return;
  }

  const rows = data.backups.map((b) => `<tr>
    <td class="fm-name">${esc(b.name.replace(/\.zip$/, ''))}</td>
    <td>${fmtBytes(b.sizeBytes)}</td>
    <td>${b.trigger === 'scheduled' ? 'По расписанию' : 'Вручную'}</td>
    <td>${fmtDate(b.ts)}</td>
    <td class="fm-actions">
      <a href="/api/sites/${siteId}/backups/${encodeURIComponent(b.name)}/download" title="Скачать">⬇</a>
      <button data-restore="${esc(b.name)}" title="Восстановить">↩</button>
      <button data-del="${esc(b.name)}" title="Удалить">✕</button>
    </td>
  </tr>`).join('');

  app.innerHTML = `
    <div class="page-head">
      <button class="back-btn" id="backBtn">← К сайту</button>
      <h1>💾 ${esc(site.name)}</h1>
    </div>
    <div class="panel">
      <div class="fm-bar">
        <span class="hint">Хранится: ${data.totals.count} · ${fmtBytes(data.totals.sizeBytes)}</span>
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="bkRefresh" title="Обновить">🔄</button>
        <button class="btn btn-sm btn-primary" id="bkNow">💾 Создать сейчас</button>
        <button class="btn btn-sm" id="bkSchedule">⚙ Расписание</button>
      </div>
      <table class="fm-table">
        <thead><tr><th>Бэкап</th><th style="width:90px">Размер</th><th style="width:130px">Триггер</th><th style="width:130px">Создан</th><th style="width:150px"></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${data.backups.length ? '' : '<p class="hint" style="margin-top:10px">Бэкапов ещё нет — создайте первый вручную или включите расписание.</p>'}
      <p class="hint" style="margin-top:10px">Восстановление заменяет текущие файлы сайта содержимым бэкапа; сайт будет остановлен и запущен снова (для Node.js-приложений зависимости ставятся заново — это может занять пару минут). Ручной бэкап отодвигает следующий плановый на полный интервал.</p>
    </div>`;

  document.getElementById('backBtn').onclick = () => navigate({ name: 'site', id: siteId });
  document.getElementById('bkRefresh').onclick = () => renderBackups();
  document.getElementById('bkNow').onclick = async () => {
    const btn = document.getElementById('bkNow');
    btn.disabled = true;
    try {
      toast('Создаём бэкап...');
      const r = await api('POST', `/api/sites/${siteId}/backups`);
      toast(`Бэкап создан (${fmtBytes(r.backup && r.backup.sizeBytes)})`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    renderBackups();
  };
  document.getElementById('bkSchedule').onclick = () => openBackupSchedule(siteId, data.schedule);

  app.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.onclick = async () => {
      if (!(await confirmDialog('Восстановить из бэкапа?', `Текущие файлы сайта «${site.name}» будут заменены содержимым бэкапа ${btn.dataset.restore}.`))) return;
      btn.disabled = true;
      try {
        toast('Восстановление...');
        const r = await api('POST', `/api/sites/${siteId}/backups/${encodeURIComponent(btn.dataset.restore)}/restore`);
        if (r.ok === false) toast('Файлы восстановлены, но сайт не запустился: ' + (r.error || ''), 'error');
        else toast('Восстановлено из бэкапа', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
      renderBackups();
    };
  });
  app.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => {
      if (!(await confirmDialog('Удалить бэкап?', `${btn.dataset.del} будет удалён безвозвратно.`))) return;
      try {
        await api('DELETE', `/api/sites/${siteId}/backups/${encodeURIComponent(btn.dataset.del)}`);
        renderBackups();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  });
}

/* ---------- Дашборд ---------- */

// SVG-спарклайн по массиву точек {t, v}.
function sparkline(points, color, max) {
  const pts = (points || []).filter((p) => p.v !== null && p.v !== undefined);
  if (pts.length < 2) return '<div class="spark-empty">Собираем данные...</div>';
  const W = 300, H = 56, PAD = 2;
  const top = max || Math.max(100, ...pts.map((p) => p.v));
  const step = (W - PAD * 2) / (pts.length - 1);
  const y = (v) => H - PAD - (v / top) * (H - PAD * 2);
  const line = pts.map((p, i) => `${PAD + i * step},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${PAD},${H - PAD} ${line} ${PAD + (pts.length - 1) * step},${H - PAD}`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark">
    <polygon points="${area}" fill="${color}" opacity="0.12"/>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>`;
}

function ring(pct, color) {
  const R = 26, C = 2 * Math.PI * R;
  const off = C * (1 - Math.min(100, Math.max(0, pct || 0)) / 100);
  return `<svg viewBox="0 0 64 64" class="ring">
    <circle cx="32" cy="32" r="${R}" fill="none" stroke="var(--border)" stroke-width="6"/>
    <circle cx="32" cy="32" r="${R}" fill="none" stroke="${color}" stroke-width="6"
      stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
      transform="rotate(-90 32 32)"/>
    <text x="32" y="37" text-anchor="middle" class="ring-text">${pct === null || pct === undefined ? '—' : pct + '%'}</text>
  </svg>`;
}

function renderDashboard(data) {
  stopLogTimer(); // ушед со страницы сайта, не опрашиваем его логи (U-09)
  document.title = 'Дашборд — SitePanel';
  app.innerHTML = `
    <div id="dashRoot">
      <div class="page-head"><h1>Дашборд</h1></div>
      <div class="dash-grid">
        <div class="panel dash-card">
          <h2>Процессор</h2>
          <div class="dash-row">${ring(data.cpu.pct, '#60a5fa')}
            <div class="dash-facts">
              <div class="dash-big" id="dCpuPct">${data.cpu.pct === null ? '—' : data.cpu.pct + '%'}</div>
              <div class="hint">${data.cpu.cores} ядер${data.cpu.model ? ' · ' + esc(String(data.cpu.model).slice(0, 40)) : ''}</div>
              <div class="hint">load average: ${data.cpu.loadavg.join(' / ') || '—'}</div>
            </div>
          </div>
          <div id="dCpuSpark">${sparkline(data.history.cpu, '#60a5fa')}</div>
        </div>

        <div class="panel dash-card">
          <h2>Память</h2>
          <div class="dash-row">${ring(data.mem.pct, '#a78bfa')}
            <div class="dash-facts">
              <div class="dash-big" id="dMemPct">${data.mem.pct === null ? '—' : data.mem.pct + '%'}</div>
              <div class="hint" id="dMemDetail">${fmtBytes(data.mem.used)} из ${fmtBytes(data.mem.total)}</div>
            </div>
          </div>
          <div id="dMemSpark">${sparkline(data.history.mem, '#a78bfa', 100)}</div>
        </div>

        <div class="panel dash-card">
          <h2>Хранилище <span class="hint" id="dDiskPath"></span></h2>
          <div class="dash-row" id="dDiskRing"></div>
          <div class="hint" id="dDiskDetail" style="margin-top:6px"></div>
          <div class="disk-bar"><div class="disk-bar-fill" id="dDiskBar"></div></div>
        </div>

        <div class="panel dash-card">
          <h2>Сайты</h2>
          <div class="dash-row">
            <div class="dash-big" id="dSites">${data.sites ? data.sites.running : '—'}<span class="hint"> / ${data.sites ? data.sites.total : '—'}</span></div>
          </div>
          <div class="hint" id="dSitesHint" style="margin-top:8px">работает / всего</div>
          <div class="hint" id="dServerInfo" style="margin-top:8px"></div>
        </div>
      </div>
    </div>`;
  patchDashboard(data);
}

// Точечное обновление значений без перестроения страницы.
function patchDashboard(data) {
  if (!document.getElementById('dashRoot')) return;
  document.getElementById('dCpuPct').textContent = data.cpu.pct === null ? '—' : data.cpu.pct + '%';
  document.getElementById('dMemPct').textContent = data.mem.pct === null ? '—' : data.mem.pct + '%';
  document.getElementById('dMemDetail').textContent = `${fmtBytes(data.mem.used)} из ${fmtBytes(data.mem.total)}`;
  document.getElementById('dCpuSpark').innerHTML = sparkline(data.history.cpu, '#60a5fa');
  document.getElementById('dMemSpark').innerHTML = sparkline(data.history.mem, '#a78bfa', 100);

  // Кольца перерисовываем целиком (внутри .dash-row первый элемент).
  const rows = document.querySelectorAll('#dashRoot .dash-row');
  rows[0].querySelector('.ring').outerHTML = ring(data.cpu.pct, '#60a5fa');
  rows[1].querySelector('.ring').outerHTML = ring(data.mem.pct, '#a78bfa');

  if (data.disk) {
    document.getElementById('dDiskPath').textContent = data.disk.path || '';
    document.getElementById('dDiskRing').innerHTML = ring(data.disk.pct, data.disk.pct > 90 ? '#f87171' : data.disk.pct > 75 ? '#fbbf24' : '#34d399');
    document.getElementById('dDiskDetail').textContent = `${fmtBytes(data.disk.used)} занято из ${fmtBytes(data.disk.total)}`;
    const bar = document.getElementById('dDiskBar');
    bar.style.width = Math.min(100, data.disk.pct || 0) + '%';
    bar.style.background = data.disk.pct > 90 ? '#f87171' : data.disk.pct > 75 ? '#fbbf24' : '#34d399';
  } else {
    document.getElementById('dDiskRing').innerHTML = '<p class="hint">Размер диска определить не удалось</p>';
  }
  document.getElementById('dSites').innerHTML = `${data.sites ? data.sites.running : '—'}<span class="hint"> / ${data.sites ? data.sites.total : '—'}</span>`;
  document.getElementById('dServerInfo').innerHTML =
    `${esc(data.server.hostname)} · ${esc(data.server.platform)} · Node ${esc(data.nodeVersion)}<br>` +
    `сервер работает ${fmtUptime(data.server.osUptimeSec)} · панель ${fmtUptime(data.panelUptimeSec)}<br>` +
    `<code>${esc(data.dataDir)}</code>`;
}

/* ---------- Настройки ---------- */

/** Современный контрол порога: степпер (− значение +) + слайдер с заполненной дорожкой. */
function stepperHtml(name, value, label) {
  const pct = Math.round(((Number(value) || 1) - 1) / 98 * 100);
  return `
    <div class="stepper-card">
      <div class="stepper-label">${esc(label)}</div>
      <div class="stepper" data-stepper>
        <button type="button" class="stepper-btn" data-step="-1" aria-label="Уменьшить: ${esc(label)}">−</button>
        <input type="number" min="1" max="99" name="${name}" value="${Number(value) || 1}" inputmode="numeric" aria-label="${esc(label)}">
        <button type="button" class="stepper-btn" data-step="1" aria-label="Увеличить: ${esc(label)}">+</button>
      </div>
      <input type="range" class="stepper-slider" min="1" max="99" value="${Number(value) || 1}"
        style="--fill:${pct}%" data-slider-for="${name}" aria-label="${esc(label)} — ползунок">
    </div>`;
}

/** Связывает степпер и слайдер: кнопки ±, ручной ввод и ползунок меняют одно значение. */
function wireSteppers() {
  app.querySelectorAll('[data-stepper]').forEach((st) => {
    const input = st.querySelector('input[type="number"]');
    const slider = app.querySelector(`[data-slider-for="${input.name}"]`);
    const minus = st.querySelector('[data-step="-1"]');
    const plus = st.querySelector('[data-step="1"]');
    const clamp = (v) => Math.min(99, Math.max(1, Math.round(Number(v) || 1)));
    const sync = (raw) => {
      const v = clamp(raw);
      input.value = v;
      if (slider) {
        slider.value = v;
        slider.style.setProperty('--fill', Math.round((v - 1) / 98 * 100) + '%');
      }
      if (minus) minus.disabled = v <= 1;
      if (plus) plus.disabled = v >= 99;
    };
    if (minus) minus.addEventListener('click', () => sync(Number(input.value) - 1));
    if (plus) plus.addEventListener('click', () => sync(Number(input.value) + 1));
    input.addEventListener('change', () => sync(input.value));
    if (slider) slider.addEventListener('input', () => sync(slider.value));
    sync(input.value);
  });
}

function renderSettings(settings, system) {
  stopLogTimer();
  document.title = 'Настройки — SitePanel';
  const a = settings.alerts || {};
  app.innerHTML = `
    <div class="page-head">
      <h1>Настройки</h1>
    </div>
    <div class="detail-grid">
      <div class="panel">
        <h2>Let's Encrypt</h2>
        <form id="leForm">
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            E-mail для уведомлений LE
            <input type="email" name="leEmail" value="${esc(settings.leEmail)}" placeholder="admin@example.com" style="margin-top:6px">
          </label>
          <label class="checkbox"><input type="checkbox" name="leStaging" ${settings.leStaging ? 'checked' : ''}> Staging-режим LE (тестовые сертификаты, без лимитов)</label>
          <div class="actions-row"><button class="btn btn-primary btn-sm" type="submit">Сохранить</button></div>
        </form>
      </div>

      <div class="panel">
        <h2>Оповещения Telegram</h2>
        <form id="alertForm">
          <label class="checkbox" style="margin-bottom:10px"><input type="checkbox" name="enabled" ${a.enabled !== false ? 'checked' : ''}> Включить оповещения</label>
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Bot token ${a.telegramTokenSet ? `<span style="color:var(--text-dim)">(сохранён, ${esc(a.telegramTokenHint || '***')})</span>` : ''}
            <input type="password" name="token" value="" placeholder="${a.telegramTokenSet ? 'введите новый токен, чтобы заменить' : '123456789:AA...'}" style="margin-top:6px" autocomplete="new-password">
          </label>
          ${a.telegramTokenSet ? '<label class="checkbox" style="margin-bottom:10px"><input type="checkbox" name="tokenReset"> Удалить сохранённый токен</label>' : ''}
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Chat ID
            <input type="text" name="chatId" value="${esc(a.telegramChatId || '')}" placeholder="-1001234567890 или 123456789" style="margin-top:6px" autocomplete="off">
          </label>
          <div class="stepper-grid">
            ${stepperHtml('disk', a.diskThreshold || 80, 'Порог диска, %')}
            ${stepperHtml('mem', a.memThreshold || 80, 'Порог памяти, %')}
          </div>
          <div class="actions-row">
            <button class="btn btn-primary btn-sm" type="submit">Сохранить</button>
            <button class="btn btn-sm" type="button" id="alertTest">🧪 Отправить тест</button>
          </div>
          <p class="hint" style="margin-top:12px">Проверка каждые 30 секунд. При превышении порога — сообщение в Telegram (повтор раз в 30 минут, пока проблема не уйдёт), при возврате на 5% ниже порога — уведомление о восстановлении. Также приходят сообщения о падении и восстановлении сайтов (алерт — при аварийном завершении процесса или если сайт не отвечает минуту).</p>
        </form>
      </div>

      <div class="panel span2">
        <h2>Система</h2>
        <dl class="kv">
          <dt>Версия Node.js</dt><dd>${esc(system.nodeVersion)}</dd>
          <dt>Платформа</dt><dd>${esc(system.platform)}</dd>
          <dt>Порты прокси</dt><dd>HTTP ${system.httpPort} · HTTPS ${system.httpsPort}</dd>
          <dt>Порт админки</dt><dd>${system.adminPort}</dd>
          <dt>Память сервера</dt><dd>свободно ${system.freememGb} из ${system.totalmemGb} ГБ</dd>
          <dt>Сайтов</dt><dd>${system.sites} (работает: ${system.running})</dd>
          <dt>Каталог данных</dt><dd><code>${esc(system.dataDir)}</code></dd>
        </dl>
        <p class="hint" style="margin-top:12px">Порты задаются переменными окружения <code>PANEL_HTTP_PORT</code>, <code>PANEL_HTTPS_PORT</code>, <code>PANEL_ADMIN_PORT</code> при запуске. Опция <code>PANEL_NO_AUTH=1</code> отключает встроенную авторизацию (если её выполняет внешний прокси). Логин и пароль меняются на странице «Пользователи».</p>
      </div>
    </div>`;

  document.getElementById('leForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', {
        leEmail: e.target.leEmail.value,
        leStaging: e.target.leStaging.checked,
      });
      toast('Настройки сохранены', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('alertForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const token = e.target.token.value.trim();
      const alerts = {
        enabled: e.target.enabled.checked,
        telegramChatId: e.target.chatId.value.trim(),
        diskThreshold: e.target.disk.value,
        memThreshold: e.target.mem.value,
      };
      // Токен отправляется только если введён новый: поле пустое по умолчанию,
      // и сохранение настроек не должно стирать сохранённый токен (A-02).
      if (token) alerts.telegramToken = token;
      if (e.target.tokenReset && e.target.tokenReset.checked) alerts.telegramTokenReset = true;
      await api('PUT', '/api/settings', { alerts });
      toast('Оповещения сохранены', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('alertTest').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/alerts/test', {});
      toast(r.ok ? 'Тестовое сообщение отправлено в Telegram' : 'Не удалось отправить: ' + (r.error || ''), r.ok ? 'success' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  wireSteppers();
}

/* ---------- Пользователи ---------- */

async function renderUsers() {
  stopLogTimer();
  let data;
  try {
    data = await api('GET', '/api/users');
  } catch (err) {
    showBanner('Не удалось загрузить пользователей: ' + err.message);
    return;
  }
  document.title = 'Пользователи — SitePanel';
  const users = Array.isArray(data.users) ? data.users : [];
  app.innerHTML = `
    <div class="page-head"><h1>Пользователи</h1></div>
    <div class="detail-grid">
      <div class="panel">
        <h2>Учётные записи</h2>
        <table class="users-table">
          <thead><tr><th>Логин</th><th>Роль</th></tr></thead>
          <tbody>
            ${users.map((u) => `<tr>
              <td><strong>${esc(u.user)}</strong></td>
              <td><span class="role-badge">${esc(u.role || 'admin')}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <p class="hint" style="margin-top:12px">${esc(data.note || '')} Учетные данные хранятся в <code>data/auth.json</code> (scrypt); вход — через страницу <code>/login</code> (сессия в HttpOnly-cookie), для API и скриптов доступен HTTP Basic. Неудачные попытки ограничены: 10 за 5 минут с одного адреса — блокировка на 15 минут; смена пароля гасит все активные сессии.</p>
      </div>

      <div class="panel">
        <h2>Смена логина и пароля</h2>
        <form id="passForm">
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Логин
            <input type="text" name="user" value="${esc(users.length ? users[0].user : '')}" style="margin-top:6px">
          </label>
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Новый пароль (мин. 8 символов)
            <input type="password" name="password" style="margin-top:6px" autocomplete="new-password">
          </label>
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Повторите новый пароль
            <input type="password" name="password2" style="margin-top:6px" autocomplete="new-password">
          </label>
          <div class="actions-row"><button class="btn btn-primary btn-sm" type="submit">Сменить пароль</button></div>
          <p class="hint" style="margin-top:12px">После смены пароля браузер запросит вход заново.</p>
        </form>
      </div>
    </div>`;

  document.getElementById('passForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const password = form.password.value;
    if (password.length < 8) return toast('Пароль должен быть не короче 8 символов', 'error');
    if (password !== form.password2.value) return toast('Пароли не совпадают', 'error');
    try {
      await api('POST', '/api/password', { user: form.user.value, password });
      toast('Пароль изменён. Обновите страницу и войдите с новым паролем.', 'success');
      form.password.value = '';
      form.password2.value = '';
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ---------- Терминал ---------- */

let term = null;        // экземпляр xterm
let termFit = null;     // addon-fit
let termWs = null;      // WebSocket сессии
let termResizeHandler = null;
let termSeq = 0;        // отменяет устаревшие подключения

function terminalTheme() {
  const dark = currentTheme() === 'dark';
  return {
    background: dark ? '#0b0e14' : '#ffffff',
    foreground: dark ? '#e6e9f0' : '#1c2230',
    cursor: dark ? '#60a5fa' : '#1d4ed8',
    cursorAccent: dark ? '#0b0e14' : '#ffffff',
    selectionBackground: dark ? 'rgba(96, 165, 250, .30)' : 'rgba(37, 99, 235, .20)',
    black: '#0b0e14', brightBlack: '#64748b',
    red: '#ef4444', green: '#22c55e', yellow: '#eab308',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e6e9f0',
  };
}

function termStatus(state, text) {
  const el = document.getElementById('termStatus');
  if (!el) return;
  el.className = 'term-status ' + state;
  el.innerHTML = `<span class="status-dot ${state === 'ok' ? 'running' : state === 'err' ? 'crashed' : 'stopped'}"></span> ${esc(text)}`;
}

function stopTerminal() {
  termSeq++;
  if (termResizeHandler) {
    window.removeEventListener('resize', termResizeHandler);
    termResizeHandler = null;
  }
  if (termWs) {
    try { termWs.close(); } catch { /* уже закрыт */ }
    termWs = null;
  }
  if (term) {
    try { term.dispose(); } catch { /* noop */ }
    term = null;
    termFit = null;
  }
}

function renderTerminal() {
  document.title = 'Терминал — SitePanel';
  app.innerHTML = `
    <div class="page-head"><h1>Терминал</h1></div>
    <div class="term-wrap">
      <div class="term-toolbar">
        <span class="term-tab"><svg class="icon"><use href="#i-term"/></svg> shell@${esc(location.hostname)}</span>
        <span class="term-status off" id="termStatus"><span class="status-dot stopped"></span> подключение...</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="termReconnect">Переподключить</button>
      </div>
      <div id="terminalBox"></div>
    </div>
    <p class="hint term-note">Терминал открывает shell на сервере с правами учетной записи панели — команды выполняются по-настоящему. Сессия закрывается при уходе со страницы; подключение защищено одноразовым токеном, а HTTP Basic панель подставляет сама.</p>`;

  document.getElementById('termReconnect').addEventListener('click', connectTerminal);
  connectTerminal();
}

async function connectTerminal() {
  const seq = ++termSeq;
  const box = document.getElementById('terminalBox');
  if (!box) return;
  // Чистим предыдущую сессию, но оставляем обработчик resize на месте до пересоздания.
  if (termResizeHandler) { window.removeEventListener('resize', termResizeHandler); termResizeHandler = null; }
  if (termWs) { try { termWs.close(); } catch { /* noop */ } termWs = null; }
  if (term) { try { term.dispose(); } catch { /* noop */ } term = null; }

  if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
    termStatus('err', 'xterm.js не загружен');
    box.innerHTML = '<p class="hint" style="padding:16px">Библиотека терминала (vendor/xterm.js) не найдена — проверьте выкладку.</p>';
    return;
  }

  termStatus('off', 'подключение...');
  let token;
  try {
    ({ token } = await api('POST', '/api/terminal/token'));
  } catch (err) {
    termStatus('err', 'нет токена');
    box.innerHTML = `<p class="hint" style="padding:16px">Терминал недоступен: ${esc(err.message)}</p>`;
    return;
  }
  if (seq !== termSeq) return; // пользователь ушёл со страницы, пока ждали токен

  term = new Terminal({
    fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: terminalTheme(),
  });
  termFit = new FitAddon.FitAddon();
  term.loadAddon(termFit);
  term.open(box);
  try { termFit.fit(); } catch { /* нулевые размеры — подождёт resize */ }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/terminal/ws?token=${encodeURIComponent(token)}`);
  // По умолчанию браузер заворачивает бинарные кадры в Blob: new Uint8Array(Blob)
  // дал бы пустой массив и весь вывод терминала молча пропадал.
  ws.binaryType = 'arraybuffer';
  termWs = ws;
  let firstOutput = false;

  term.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(d);
  });

  ws.onopen = () => {
    if (seq !== termSeq) return;
    // Начальный размер сессии: PTY получит его через resize-сообщение.
    try {
      const dim = termFit.proposeDimensions();
      ws.send(JSON.stringify({ type: 'resize', cols: (dim && dim.cols) || 80, rows: (dim && dim.rows) || 24 }));
    } catch { /* размер посчитает fit */ }
    termStatus('ok', 'подключено');
    term.focus();
  };

  ws.onmessage = (e) => {
    if (seq !== termSeq) return;
    if (!firstOutput) { firstOutput = true; termStatus('ok', 'подключено'); }
    term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  };

  ws.onclose = (e) => {
    if (seq !== termSeq) return;
    termStatus('off', e.wasClean ? 'сессия закрыта' : 'связь потеряна');
    term.write('\r\n\x1b[2m[SITEPANEL] Сессия закрыта. Нажмите «Переподключить».\x1b[0m\r\n');
  };

  ws.onerror = () => {
    if (seq !== termSeq) return;
    termStatus('err', 'ошибка соединения');
  };

  // Ресайз окна → fit + сообщение серверу.
  termResizeHandler = () => {
    if (!term || !termFit) return;
    try {
      termFit.fit();
      const dim = termFit.proposeDimensions();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: (dim && dim.cols) || 80, rows: (dim && dim.rows) || 24 }));
      }
    } catch { /* noop */ }
  };
  window.addEventListener('resize', termResizeHandler);
}

/* ---------- Инициализация оболочки ---------- */

document.getElementById('brandBtn').addEventListener('click', () => navigate({ name: 'list' }));
document.getElementById('listBtn').addEventListener('click', () => navigate({ name: 'list' }));
document.getElementById('dashBtn').addEventListener('click', () => navigate({ name: 'dashboard' }));
document.getElementById('terminalBtn').addEventListener('click', () => navigate({ name: 'terminal' }));
document.getElementById('usersBtn').addEventListener('click', () => navigate({ name: 'users' }));
document.getElementById('settingsBtn').addEventListener('click', () => navigate({ name: 'settings' }));
document.getElementById('themeBtn').addEventListener('click', toggleTheme);
applyThemeIcon();

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
    toast(`Сайт «${site.name}» развёрнут (${site.type === 'node' ? 'Node.js' : 'статика'})`, 'success');
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
