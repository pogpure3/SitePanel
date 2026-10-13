'use strict';

/* SitePanel — фронтенд админ-панели (vanilla JS).
   Страница строится один раз; периодический опрос обновляет
   только изменившиеся элементы (patchCard / patchDetail),
   чтобы интерфейс не мигал и не терял состояние. */

const app = document.getElementById('app');
let view = { name: 'dashboard' };
let sitesCache = [];
let pollTimer = null;
let activeLogTimer = null; // автообновление логов на странице сайта
let refreshSeq = 0;        // маркер свежести: устаревшие ответы не патчат DOM

/* ---------- API ---------- */

async function api(method, path, body) {
  // X-Requested-With обязателен: сервер отклоняет мутирующие запросы без него (защита от CSRF).
  const opts = { method, headers: { 'X-Requested-With': 'XMLHttpRequest' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

async function apiUpload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded / e.total * 100));
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* noop */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Ошибка ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('Сетевая ошибка')));
    xhr.send(formData);
  });
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
  // Фокус — на первый интерактивный элемент окна.
  const focusables = backdrop.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  const first = [...focusables].find((el) => !el.disabled && el.offsetParent !== null);
  if (first) first.focus();
}

function closeModal(id) {
  const backdrop = document.getElementById(id);
  if (!backdrop) return;
  backdrop.classList.add('hidden');
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

function toast(msg, type = '') {  const el = document.createElement('div');
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

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    // Не обновляем, пока пользователь печатает в поле ввода.
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return;
    await refreshCurrentView();
  }, 5000);
}

function stopLogTimer() {
  clearInterval(activeLogTimer);
  activeLogTimer = null;
}

// Точечное обновление текущего вида без перестроения страницы.
async function refreshCurrentView() {
  const seq = ++refreshSeq;
  try {
    if (view.name === 'list') {
      const sites = await api('GET', '/api/sites');
      if (seq !== refreshSeq) return; // пока ждали ответ, пришёл более свежий — пропускаем
      const domIds = [...document.querySelectorAll('#app .site-card')].map((c) => c.dataset.id).join(',');
      const apiIds = sites.map((s) => s.id).join(',');
      if (domIds !== apiIds) {
        sitesCache = sites;
        renderList(sites); // состав сайтов изменился — перестраиваем список
      } else {
        sitesCache = sites;
        for (const s of sites) {
          const card = document.querySelector(`#app .site-card[data-id="${s.id}"]`);
          if (card) patchCard(card, s);
        }
      }
    } else if (view.name === 'site') {
      const site = await api('GET', '/api/sites/' + view.id);
      if (seq !== refreshSeq) return;
      const root = document.getElementById('detailRoot');
      if (!root || root.dataset.id !== site.id) renderSite(site);
      else patchDetail(site);
    } else if (view.name === 'dashboard') {
      const data = await api('GET', '/api/dashboard');
      if (seq !== refreshSeq) return;
      const root = document.getElementById('dashRoot');
      if (root) patchDashboard(data);
      else renderDashboard(data);
    }
    loadSysInfo();
  } catch (err) {
    const msg = String(err.message || '');
    if (msg.includes('Требуется авторизация')) location.reload();
    else if (msg.includes('не найден') && view.name === 'site') { view = { name: 'list' }; render(); }
  }
}

// Полная (пере)сборка текущего вида.
async function render() {
  try {
    if (view.name === 'list') {
      sitesCache = await api('GET', '/api/sites');
      renderList(sitesCache);
    } else if (view.name === 'site') {
      const site = await api('GET', '/api/sites/' + view.id);
      renderSite(site);
    } else if (view.name === 'files') {
      await renderFiles();
    } else if (view.name === 'dashboard') {
      renderDashboard(await api('GET', '/api/dashboard'));
    } else if (view.name === 'settings') {
      const [settings, system] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/system')]);
      renderSettings(settings, system);
    }
    loadSysInfo();
  } catch (err) {
    const msg = String(err.message || '');
    if (msg.includes('Требуется авторизация')) location.reload();
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

function renderList(sites) {
  document.title = 'SitePanel — панель управления сайтами';
  if (!sites.length) {
    app.innerHTML = `
      <div class="empty-state">
        <div class="big">📦</div>
        <h2>Сайтов пока нет</h2>
        <p>Нажмите «Добавить сайт» и загрузите .zip архив со статическим сайтом<br>или Node.js-приложением.</p>
      </div>`;
    return;
  }
  app.innerHTML = sites.map((s) => `
    <div class="site-card" data-id="${s.id}">
      <span class="status-dot"></span>
      <div class="site-main">
        <div class="site-name"><span class="site-title"></span>
          <span class="badge type"></span>
          <span class="ssl-slot"></span>
          <span class="loop-slot"></span>
        </div>
        <div class="site-meta"></div>
      </div>
      <div class="site-actions">
        <button class="btn btn-sm btn-success act-start" title="Запустить">▶</button>
        <button class="btn btn-sm act-stop" title="Остановить">⏹</button>
        <button class="btn btn-sm act-restart" title="Перезапустить">🔄</button>
        <a class="btn btn-sm act-visit" title="Перейти на сайт" target="_blank" rel="noopener">🌐</a>
        <button class="btn btn-sm" data-open>Открыть</button>
      </div>
    </div>`).join('');

  app.querySelectorAll('.site-card').forEach((card) => {
    const id = card.dataset.id;
    const site = () => sitesCache.find((s) => s.id === id);
    card.addEventListener('click', (e) => {
      const interactive = e.target.closest('button, a');
      if (interactive && !interactive.hasAttribute('data-open')) return;
      view = { name: 'site', id };
      render();
    });
    // Кнопки есть не у всех состояний — привязываем один раз, видимость переключаем.
    const action = (sel, fn) => {
      const btn = card.querySelector(sel);
      if (btn) btn.addEventListener('click', () => fn().catch((err) => toast(err.message, 'error')));
    };
    action('.act-start', async () => { await api('POST', `/api/sites/${id}/start`); toast('Сайт запускается', 'success'); refreshCurrentView(); });
    action('.act-stop', async () => { await api('POST', `/api/sites/${id}/stop`); toast('Сайт остановлен', 'success'); refreshCurrentView(); });
    action('.act-restart', async () => { await api('POST', `/api/sites/${id}/restart`); toast('Перезапуск...', 'success'); refreshCurrentView(); });
    patchCard(card, site() || {});
  });
}

// Обновляет одну карточку на месте: статус, бейджи, метрики, видимость кнопок.
function patchCard(card, s) {
  const dot = card.querySelector('.status-dot');
  dot.className = 'status-dot ' + (s.status || '');
  dot.title = statusLabelFull(s.status, s);

  card.querySelector('.site-title').textContent = s.name;
  card.querySelector('.badge.type').textContent = s.type === 'node' ? 'Node.js' : 'Статика';
  card.querySelector('.ssl-slot').innerHTML = sslBadge(s.ssl);
  card.querySelector('.loop-slot').innerHTML = loopBadge(s);

  const meta = [];
  meta.push(`<span>${s.domains && s.domains.length ? s.domains.map(esc).join(', ') : 'Домен не привязан'}</span>`);
  if (s.health && s.health.status === 'up') meta.push(`<span title="Ответ: ${s.health.lastMs} мс">💚 health ok</span>`);
  if (s.health && s.health.status === 'down') meta.push('<span title="Health-check не проходит">💔 health fail</span>');
  if (s.stats && s.stats.memoryMb) meta.push(`<span>RAM ${s.stats.memoryMb} МБ</span>`);
  card.querySelector('.site-meta').innerHTML = meta.join('');

  // Кнопки следуют за статусом (в момент остановки running может ещё быть true).
  const running = s.status === 'running';
  card.querySelector('.act-start').classList.toggle('hidden', running);
  card.querySelector('.act-stop').classList.toggle('hidden', !running);
  card.querySelector('.act-restart').classList.toggle('hidden', !running);

  const visit = card.querySelector('.act-visit');
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

function healthStripHtml(history) {
  const cells = (history || []).slice(-40).map((h) =>
    `<span class="health-cell ${h.ok ? 'ok' : 'fail'}" title="${esc(new Date(h.t).toLocaleTimeString('ru-RU') + ' · ' + (h.code || 'нет ответа') + ' · ' + h.ms + 'мс')}"></span>`
  ).join('');
  return cells || '<p class="hint">История проверок появится через несколько минут.</p>';
}

function sslInfoHtml(site) {
  const parts = [`<p>${sslBadge(site.ssl)}</p>`];
  if (site.ssl && site.ssl.error) parts.push(`<div class="warn">${esc(site.ssl.error)}</div>`);
  if (site.ssl && site.ssl.status === 'active') {
    parts.push(`<dl class="kv">
      <dt>Провайдер</dt><dd>${site.ssl.provider === 'letsencrypt' ? "Let's Encrypt" : 'Self-signed'}</dd>
      <dt>Выдан</dt><dd>${fmtDate(site.ssl.issuedAt)}</dd>
      <dt>Истекает</dt><dd>${fmtDate(site.ssl.expiresAt)}</dd>
    </dl>`);
  }
  return parts.join('');
}

function renderSite(site) {
  stopLogTimer();
  document.title = `${site.name} — SitePanel`;

  app.innerHTML = `
    <div id="detailRoot" data-id="${site.id}">
      <div class="page-head">
        <button class="back-btn" id="backBtn">← Все сайты</button>
        <h1><span class="status-dot" id="dStatusDot"></span> <span id="dName">${esc(site.name)}</span></h1>
        <span class="ssl-slot" id="dSslBadge"></span>
        <span class="loop-slot" id="dLoopBadge"></span>
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
            <input type="text" name="domain" placeholder="example.com или *.example.com" autocomplete="off">
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
          <h2>Мониторинг</h2>
          <div id="dHealth"></div>
          <div id="dHealthStrip"></div>
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

  document.getElementById('backBtn').onclick = () => { view = { name: 'list' }; render(); };

  const siteId = site.id;
  const act = (sel, fn) => {
    const el = app.querySelector(sel);
    if (el) el.addEventListener('click', () => fn().catch((err) => toast(err.message, 'error')));
  };
  act('.act-start', async () => { await api('POST', `/api/sites/${siteId}/start`); toast('Сайт запускается', 'success'); refreshCurrentView(); });
  act('.act-stop', async () => { await api('POST', `/api/sites/${siteId}/stop`); toast('Сайт остановлен', 'success'); refreshCurrentView(); });
  act('.act-restart', async () => { await api('POST', `/api/sites/${siteId}/restart`); toast('Перезапуск...', 'success'); refreshCurrentView(); });
  act('.act-files', () => { view = { name: 'files', id: siteId, path: '' }; render(); });
  act('.act-rollback', async () => {
    if (await confirmDialog('Откатить версию?', 'Текущая версия будет заменена предыдущей (бэкапом).')) {
      await api('POST', `/api/sites/${siteId}/rollback`);
      toast('Откат выполнен', 'success');
      render();
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
    if (await confirmDialog(`Удалить сайт «${site.name}»?`, 'Файлы сайта, логи и сертификаты будут удалены безвозвратно.')) {
      await api('DELETE', `/api/sites/${siteId}`);
      toast('Сайт удалён', 'success');
      view = { name: 'list' };
      render();
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

  // Кнопки следуют за статусом (см. patchCard).
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
}

/* ---------- Файловый менеджер ---------- */

const TEXT_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'html', 'htm', 'css', 'scss', 'less', 'txt', 'md', 'log', 'env', 'yml', 'yaml', 'xml', 'csv', 'sh', 'bash', 'py', 'conf', 'ini', 'toml', 'svg', 'gitignore', 'dockerfile', 'example', 'sql', 'lock', 'map', 'htaccess', 'properties']);

function isTextFile(name) {
  const base = name.split('/').pop();
  if (!base.includes('.')) return true; // Dockerfile, .env, LICENSE и т.п.
  const ext = base.startsWith('.') ? base.slice(1).split('.').pop() : base.split('.').pop();
  return TEXT_EXT.has((ext || '').toLowerCase());
}

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
    document.getElementById('backBtn').onclick = () => { view = { name: 'site', id: view.id }; render(); };
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

  document.getElementById('backBtn').onclick = () => { view = { name: 'site', id: siteId }; render(); };
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
  document.title = 'Дашборд — SitePanel';
  app.innerHTML = `
    <div id="dashRoot">
      <div class="page-head"><h1>📊 Дашборд</h1></div>
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

function renderSettings(settings, system) {
  stopLogTimer();
  document.title = 'Настройки — SitePanel';
  const a = settings.alerts || {};
  app.innerHTML = `
    <div class="page-head">
      <button class="back-btn" id="backBtn">← Все сайты</button>
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
            Bot token
            <input type="text" name="token" value="${esc(a.telegramToken || '')}" placeholder="123456789:AA..." style="margin-top:6px" autocomplete="off">
          </label>
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Chat ID
            <input type="text" name="chatId" value="${esc(a.telegramChatId || '')}" placeholder="-1001234567890 или 123456789" style="margin-top:6px" autocomplete="off">
          </label>
          <div style="display:flex;gap:12px">
            <label style="flex:1;color:var(--text-dim);font-size:13px">
              Порог диска, %
              <input type="number" min="1" max="99" name="disk" value="${a.diskThreshold || 80}" style="margin-top:6px">
            </label>
            <label style="flex:1;color:var(--text-dim);font-size:13px">
              Порог памяти, %
              <input type="number" min="1" max="99" name="mem" value="${a.memThreshold || 80}" style="margin-top:6px">
            </label>
          </div>
          <div class="actions-row">
            <button class="btn btn-primary btn-sm" type="submit">Сохранить</button>
            <button class="btn btn-sm" type="button" id="alertTest">🧪 Отправить тест</button>
          </div>
          <p class="hint" style="margin-top:12px">Проверка каждые 30 секунд. При превышении порога — сообщение в Telegram (повтор раз в 30 минут, пока проблема не уйдёт), при возврате на 5% ниже порога — уведомление о восстановлении. Также приходят сообщения о падении и восстановлении сайтов (алерт — при аварийном завершении процесса или если сайт не отвечает минуту).</p>
        </form>
      </div>

      <div class="panel">
        <h2>Доступ к панели</h2>
        <form id="passForm">
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Логин
            <input type="text" name="user" value="${esc(settings.user)}" style="margin-top:6px">
          </label>
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Новый пароль (мин. 8 символов)
            <input type="password" name="password" style="margin-top:6px">
          </label>
          <div class="actions-row"><button class="btn btn-primary btn-sm" type="submit">Сменить пароль</button></div>
          <p class="hint" style="margin-top:12px">После смены пароля браузер запросит вход заново.</p>
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
        <p class="hint" style="margin-top:12px">Порты задаются переменными окружения <code>PANEL_HTTP_PORT</code>, <code>PANEL_HTTPS_PORT</code>, <code>PANEL_ADMIN_PORT</code> при запуске. Опция <code>PANEL_NO_AUTH=1</code> отключает встроенную авторизацию (если её выполняет внешний прокси).</p>
      </div>
    </div>`;

  document.getElementById('backBtn').onclick = () => { view = { name: 'list' }; render(); };

  document.getElementById('leForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('PUT', '/api/settings', {
      leEmail: e.target.leEmail.value,
      leStaging: e.target.leStaging.checked,
    });
    toast('Настройки сохранены', 'success');
  });

  document.getElementById('alertForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', {
        alerts: {
          enabled: e.target.enabled.checked,
          telegramToken: e.target.token.value.trim(),
          telegramChatId: e.target.chatId.value.trim(),
          diskThreshold: e.target.disk.value,
          memThreshold: e.target.mem.value,
        },
      });
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

  document.getElementById('passForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = e.target.password.value;
    if (password.length < 8) return toast('Пароль должен быть не короче 8 символов', 'error');
    try {
      await api('POST', '/api/password', { user: e.target.user.value, password });
      toast('Пароль изменён. Обновите страницу и войдите с новым паролем.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ---------- Инициализация ---------- */

document.getElementById('brandBtn').addEventListener('click', () => { view = { name: 'list' }; render(); });
document.getElementById('listBtn').addEventListener('click', () => { view = { name: 'list' }; render(); });
document.getElementById('dashBtn').addEventListener('click', () => { view = { name: 'dashboard' }; render(); });
document.getElementById('settingsBtn').addEventListener('click', () => { view = { name: 'settings' }; render(); });

document.getElementById('addSiteBtn').addEventListener('click', () => {
  openModal('addModal');
});

// Закрытие модалок: клик по подложке и кнопки «Отмена».
document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal(backdrop.id);
  });
  backdrop.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(backdrop.id));
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
    view = { name: 'site', id: site.id };
    render();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    submit.disabled = false;
    progress.classList.add('hidden');
    delete document.getElementById('addModal').dataset.busy;
  }
});

render();
startPolling();
