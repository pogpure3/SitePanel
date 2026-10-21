'use strict';

/* Вид: Бэкапы сайта — вынесено из app.js (там общий каркас: api, модалки, роутинг).
   Файл загружается ДО app.js: каркас вызывает эти функции по ходу,
   ссылки на глобалы (app, api, esc, navigate, …) разрешаются в рантайме. */
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
