'use strict';

/* Вид: Список сайтов — вынесено из app.js (там общий каркас: api, модалки, роутинг).
   Файл загружается ДО app.js: каркас вызывает эти функции по ходу,
   ссылки на глобалы (app, api, esc, navigate, …) разрешаются в рантайме. */
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
  row.querySelector('.badge.type').textContent = typeLabel(s.type);
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
