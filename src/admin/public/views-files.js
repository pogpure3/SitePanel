'use strict';

/* Вид: Файловый менеджер — вынесено из app.js (там общий каркас: api, модалки, роутинг).
   Файл загружается ДО app.js: каркас вызывает эти функции по ходу,
   ссылки на глобалы (app, api, esc, navigate, …) разрешаются в рантайме. */
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
