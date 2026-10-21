'use strict';

/* Вид: Страница сайта (карточка) — вынесено из app.js (там общий каркас: api, модалки, роутинг).
   Файл загружается ДО app.js: каркас вызывает эти функции по ходу,
   ссылки на глобалы (app, api, esc, navigate, …) разрешаются в рантайме. */
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
            <dt id="dContainerPortLabel" class="hidden">Порт контейнера</dt><dd id="dContainerPort" class="hidden" style="cursor:pointer" title="Изменить порт приложения внутри контейнера"></dd>
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
  document.getElementById('dType').textContent = typeLabel(site.type) === 'Node.js' ? 'Node.js-приложение'
    : site.type === 'docker' ? 'Docker-контейнер' : 'Статический сайт';
  document.getElementById('dPort').textContent = site.port || '—';
  // Docker-сайт: какой порт панель публикует и какой порт слушает приложение
  // внутри контейнера. Правка — кликом (PATCH containerPort; null — заново
  // детектировать из EXPOSE/ports при следующем деплое).
  const cpl = document.getElementById('dContainerPortLabel');
  const cp = document.getElementById('dContainerPort');
  if (site.type === 'docker') {
    cpl.classList.remove('hidden');
    cp.classList.remove('hidden');
    cp.textContent = (site.containerPort || '?') + ' → 127.0.0.1:' + (site.port || '?') + ' ✎';
    cp.onclick = async () => {
      const v = await promptDialog('Порт приложения внутри контейнера', site.containerPort || '');
      if (v === null) return;
      const body = { containerPort: v.trim() === '' ? null : Number(v) };
      try {
        const r = await api('PATCH', `/api/sites/${site.id}`, body);
        if (r.containerPortApplied === 'restarted') toast('Порт контейнера применён — сайт перезапущен', 'success');
        else toast(body.containerPort ? 'Порт контейнера сохранён — применится при запуске' : 'Порт контейнера сброшен — определится при следующем деплое', 'success');
        render();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  } else {
    cpl.classList.add('hidden');
    cp.classList.add('hidden');
    cp.onclick = null;
  }
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
