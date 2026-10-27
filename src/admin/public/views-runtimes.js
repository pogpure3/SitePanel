'use strict';

/* Вид: ресурсы сервера (Node.js, PHP, Docker, Next.js) — версии и установка.
   Вынесено из app.js (там общий каркас). Загружается ДО app.js. */

async function renderRuntimes() {
  document.title = 'Ресурсы — SitePanel';
  document.getElementById('crumb').textContent = 'Ресурсы';
  stopLogTimer();

  app.innerHTML = `
    <div class="page-head"><h1>Ресурсы сервера</h1></div>
    <div class="panel">
      <p class="hint" style="margin-top:0">Версии ставятся системным apt (Node.js, PHP, Docker) или глобальным npm (Next.js).
      Установка и обновление меняют состояние всего сервера; сайты, работающие на обновляемом ресурсе, стоит перезапустить после смены версии.</p>
      <table class="fm-table" id="rtTable">
        <thead><tr><th>Ресурс</th><th style="width:140px">Установлен</th><th style="width:220px">Версия</th><th style="width:170px"></th></tr></thead>
        <tbody><tr><td colspan="4" class="hint">Загрузка…</td></tr></tbody>
      </table>
    </div>`;

  let data;
  try {
    data = await api('GET', '/api/runtimes');
  } catch (err) {
    document.querySelector('#rtTable tbody').innerHTML =
      `<tr><td colspan="4" class="hint">${esc(err.message)}</td></tr>`;
    return;
  }

  const rows = data.runtimes.map((r) => {
    const opts = r.available.map((v) =>
      `<option value="${esc(v)}"${v === r.installed ? ' selected' : ''}>${esc(v)}${v === r.installed ? ' (установлена)' : ''}</option>`
    ).join('');
    return `<tr>
      <td>${esc(r.title)}</td>
      <td>${r.installed ? `<span class="badge ssl-ok">${esc(r.installed)}</span>` : '<span class="badge">не установлен</span>'}</td>
      <td><select data-rt-version="${esc(r.id)}" ${r.available.length ? '' : 'disabled'}>${opts || '<option>—</option>'}</select></td>
      <td><button class="btn btn-sm btn-primary" data-rt-install="${esc(r.id)}">${r.installed ? 'Обновить' : 'Установить'}</button></td>
    </tr>`;
  }).join('');
  document.querySelector('#rtTable tbody').innerHTML = rows;

  document.querySelectorAll('[data-rt-install]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.rtInstall;
      const sel = document.querySelector(`[data-rt-version="${id}"]`);
      const version = sel && sel.value && !sel.value.includes('установлена') ? sel.value : undefined;
      if (version && !await confirmDialog('Изменить версию ресурса?',
        `${id}: будет установлена версия ${version}. Сервер меняет состояние всего стенда.`)) return;
      btn.disabled = true;
      btn.textContent = 'Выполняется…';
      try {
        const r = await api('POST', `/api/runtimes/${id}/install`, version ? { version } : {});
        toast('Готово. Хвост вывода: ' + String(r.output || '').slice(-200), 'success');
        renderRuntimes();
      } catch (err) {
        toast(String(err.message).slice(0, 300), 'error');
        btn.disabled = false;
        btn.textContent = 'Установить';
      }
    };
  });
}
