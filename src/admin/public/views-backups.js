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

function backupScopeLabel(scope) {
  if (scope === 'site') return 'Файлы сайта';
  if (scope === 'database') return 'База данных';
  return 'Полный';
}

function backupInfoHtml(sched) {
  if (!sched) return '<p class="hint">—</p>';
  const badge = sched.enabled
    ? `<span class="badge ssl-ok">По расписанию: ${backupScopeLabel(sched.scope).toLowerCase()}, каждые ${esc(fmtInterval(sched.intervalHours))}, хранить ${esc(sched.keep)}</span>`
    : '<span class="badge">По расписанию: выключено</span>';
  const last = sched.lastRunAt
    ? `<div class="hint">Последний бэкап: ${fmtDate(sched.lastRunAt)}</div>`
    : '<div class="hint">Бэкапов ещё не было</div>';
  const err = sched.lastError ? `<div class="warn">⚠ ${esc(sched.lastError)}</div>` : '';
  return `${badge}${last}${err}`;
}

function openBackupSchedule(siteId, sched) {
  document.getElementById('backupEnabled').checked = !!(sched && sched.enabled);
  const scopeSelect = document.getElementById('backupScheduleScope');
  scopeSelect.value = (sched && sched.scope) || 'full';
  syncSelectControl(scopeSelect);
  document.getElementById('backupInterval').value = (sched && sched.intervalHours) || 24;
  document.getElementById('backupKeep').value = (sched && sched.keep) || 5;
  openModal('backupModal');
  document.getElementById('backupModalSave').onclick = async () => {
    const body = {
      enabled: document.getElementById('backupEnabled').checked,
      scope: document.getElementById('backupScheduleScope').value,
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
    <td>${backupScopeLabel(b.scope)}</td>
    <td>${b.trigger === 'scheduled' ? 'По расписанию' : 'Вручную'}</td>
    <td>${fmtDate(b.ts)}</td>
    <td class="fm-actions">
      <a href="/api/sites/${siteId}/backups/${encodeURIComponent(b.name)}/download" title="Скачать" aria-label="Скачать ${esc(b.name)}">⬇</a>
      <button data-restore="${esc(b.name)}" title="Восстановить" aria-label="Восстановить ${esc(b.name)}">↩</button>
      <button data-sync="${esc(b.name)}" title="Скопировать на внешний сервер" aria-label="Скопировать ${esc(b.name)} на внешний сервер" ${data.remote && data.remote.enabled ? '' : 'hidden'}>☁</button>
      <button data-del="${esc(b.name)}" title="Удалить" aria-label="Удалить ${esc(b.name)}">✕</button>
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
        <button class="btn btn-sm" id="bkRefresh" title="Обновить" aria-label="Обновить список бэкапов">🔄</button>
        <label class="hint" for="bkScope">Состав</label>
        <select id="bkScope" aria-label="Состав бэкапа">
          <option value="site">Файлы сайта</option>
          <option value="database">База данных</option>
          <option value="full">Полный</option>
        </select>
        <button class="btn btn-sm btn-primary" id="bkNow">💾 Создать сейчас</button>
        <button class="btn btn-sm" id="bkSchedule">⚙ Расписание</button>
      </div>
      <div class="table-scroll">
        <table class="fm-table">
          <thead><tr><th>Бэкап</th><th style="width:90px">Размер</th><th style="width:120px">Состав</th><th style="width:130px">Триггер</th><th style="width:130px">Создан</th><th style="width:150px"></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${data.backups.length ? '' : '<p class="hint" style="margin-top:10px">Бэкапов ещё нет — создайте первый вручную или включите расписание.</p>'}
      <p class="hint" style="margin-top:10px">«Файлы сайта» не включают данные из <code>data/</code> и <code>deploy/data/</code>. «База данных» включает только эти каталоги. Состав планового бэкапа выбирается в расписании. При восстановлении сайт будет остановлен и запущен снова.</p>
    </div>
    <div class="panel" style="margin-top:14px">
      <h2>Внешняя копия (SSH)</h2>
      <label class="checkbox"><input type="checkbox" id="bkRemoteEnabled"> Копировать каждый новый бэкап на другой сервер по SSH</label>
      <div class="inline-form" style="margin-top:8px">
        <input type="text" id="bkRemoteUser" placeholder="user" aria-label="Пользователь на сервере" autocomplete="off" style="max-width:140px">
        <span class="hint">@</span>
        <input type="text" id="bkRemoteHost" placeholder="хост" aria-label="Хост" autocomplete="off">
        <input type="text" id="bkRemotePort" placeholder="22" aria-label="Порт SSH" autocomplete="off" style="max-width:80px">
        <input type="text" id="bkRemoteDir" placeholder="/backups/<сайт>" aria-label="Каталог на сервере" autocomplete="off">
        <button class="btn btn-primary" id="bkRemoteSave">Сохранить</button>
      </div>
      <textarea id="bkRemoteKey" rows="4" style="width:100%;margin-top:8px;font-family:monospace" placeholder="Приватный ключ OpenSSH (PEM) — необязательно; без него используется ключ пользователя панели на сервере" aria-label="Приватный ключ"></textarea>
      <div id="bkRemoteStatus" style="margin-top:6px"></div>
    </div>`;

  document.getElementById('backBtn').onclick = () => navigate({ name: 'site', id: siteId });
  document.getElementById('bkRefresh').onclick = () => renderBackups();
  document.getElementById('bkNow').onclick = async () => {
    const btn = document.getElementById('bkNow');
    btn.disabled = true;
    try {
      const scope = document.getElementById('bkScope').value;
      toast(`Создаём бэкап: ${backupScopeLabel(scope).toLowerCase()}...`);
      const r = await api('POST', `/api/sites/${siteId}/backups`, { scope });
      toast(`Бэкап создан (${fmtBytes(r.backup && r.backup.sizeBytes)})`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    renderBackups();
  };
  document.getElementById('bkSchedule').onclick = () => openBackupSchedule(siteId, data.schedule);

  // Внешнее SSH-назначение: подстановка текущих значений и сохранение.
  const remote = data.remote || {};
  document.getElementById('bkRemoteEnabled').checked = !!remote.enabled;
  document.getElementById('bkRemoteUser').value = remote.user || '';
  document.getElementById('bkRemoteHost').value = remote.host || '';
  document.getElementById('bkRemotePort').value = remote.port || 22;
  document.getElementById('bkRemoteDir').value = remote.dir || '';
  const remoteStatus = document.getElementById('bkRemoteStatus');
  remoteStatus.innerHTML = remote.enabled
    ? (remote.lastSyncError
      ? `<div class="warn">⚠ Последняя синхронизация не удалась: ${esc(remote.lastSyncError)}</div>`
      : remote.lastSyncAt
        ? `<div class="hint">Последняя копия: ${fmtDate(remote.lastSyncAt)}${remote.hasKey ? ' · ключ сохранён' : ' · ключ сервера'}</div>`
        : '<div class="hint">Синхронизация включена, копий ещё не было.</div>')
    : '<div class="hint">Выключено — бэкапы хранятся только на этом сервере.</div>';
  document.getElementById('bkRemoteSave').onclick = async () => {
    const body = {
      enabled: document.getElementById('bkRemoteEnabled').checked,
      user: document.getElementById('bkRemoteUser').value.trim(),
      host: document.getElementById('bkRemoteHost').value.trim(),
      port: Number(document.getElementById('bkRemotePort').value) || 22,
      dir: document.getElementById('bkRemoteDir').value.trim(),
    };
    const key = document.getElementById('bkRemoteKey').value.trim();
    if (key) body.key = key;
    try {
      await api('PUT', `/api/sites/${siteId}/backups/remote`, body);
      toast(body.enabled ? 'Внешняя копия включена' : 'Внешняя копия выключена', 'success');
      renderBackups();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  app.querySelectorAll('[data-restore]').forEach((btn) => {
    btn.onclick = async () => {
      const backup = data.backups.find((b) => b.name === btn.dataset.restore) || {};
      const scope = backup.scope || 'full';
      const target = scope === 'site' ? 'Файлы сайта будут заменены, база данных сохранится.'
        : scope === 'database' ? 'Будут заменены только каталоги базы данных.'
          : 'Файлы сайта и база данных будут заменены.';
      if (!(await confirmDialog('Восстановить из бэкапа?', `${target} Бэкап: ${btn.dataset.restore}.`))) return;
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
  app.querySelectorAll('[data-sync]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        toast('Копируем на внешний сервер...');
        await api('POST', `/api/sites/${siteId}/backups/${encodeURIComponent(btn.dataset.sync)}/sync`, {});
        toast('Бэкап скопирован на внешний сервер', 'success');
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
