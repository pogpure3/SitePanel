'use strict';

// Регрессии этапа 6 плана: качество кода и процессы.
//   SP-15  версия схемы и нормализация настроек (мусор в порогах алертов);
//   P-04   сборка в staging ДО остановки сайта: неудачный деплой не касается
//          работающей версии;
//   T-02   сбой записи db.json (EACCES) виден в API как 5xx, а не «ок»;
//   7.4    /healthz отвечает без авторизации и без лишних деталей.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startPanel, api, fetchWithHost, makeZip, sleep } = require('./helpers/panel');

const isPosix = process.platform !== 'win32';

async function withPanel(t, env, opts) {
  const panel = await startPanel(env || {}, opts);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-stage6-'));
  t.after(async () => {
    await panel.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ }
  });
  return { panel, tmp };
}

async function uploadSite(panel, tmp, name, files, autoStart = true) {
  const zip = path.join(tmp, `${name}.zip`);
  makeZip(path.join(tmp, name), files, zip);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), `${name}.zip`);
  form.append('name', name);
  form.append('autoStart', autoStart ? 'true' : 'false');
  const res = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const site = await res.json();
  assert.equal(res.status, 200, `деплой не удался: ${JSON.stringify(site)}`);
  return site;
}

/* ---------- SP-15: версия схемы и нормализация настроек ---------- */

test('SP-15: мусорные пороги алертов нормализуются, db.json получает version', async (t) => {
  const { panel } = await withPanel(t, {}, {
    prepare: (dataDir) => {
      // «Легаси»-файл: без version, с мусором в порогах.
      fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
        sites: [],
        settings: { alerts: { enabled: true, diskThreshold: 'garbage', memThreshold: 999 } },
      }));
    },
  });
  const settings = await api(panel, 'GET', '/api/settings');
  assert.equal(settings.data.alerts.diskThreshold, 80, 'мусорный порог диска не нормализован (SP-15)');
  assert.equal(settings.data.alerts.memThreshold, 80, 'порог 999 (>99) не нормализован (SP-15)');

  // После первой записи файл получает version; телеметрии в реестре нет (M-02).
  await api(panel, 'PUT', '/api/settings', { leEmail: 'x@example.com' });
  const db = JSON.parse(fs.readFileSync(path.join(panel.dataDir, 'db.json'), 'utf8'));
  assert.equal(db.version, 1, 'db.json без version после записи (SP-15)');
});

/* ---------- P-04: неудачный деплой не останавливает работающий сайт ---------- */

test('P-04: деплой битого архива не касается работающей версии', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'bg', {
    'index.html': '<h1>OLD-VERSION</h1>',
  }, false);
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'bg.local' });
  await api(panel, 'POST', `/api/sites/${site.id}/start`);
  await sleep(300);

  // Битый архив (не zip): распаковка падает ДО остановки сайта (P-04).
  const brokenZip = path.join(tmp, 'broken.zip');
  fs.writeFileSync(brokenZip, 'this is not a zip archive');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(brokenZip)]), 'broken.zip');
  form.append('name', 'update');
  const res = await fetch(`${panel.base}/api/sites/${site.id}/update`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  assert.ok(res.status >= 400, `битый архив принят как успех: ${res.status}`);

  // Сайт ни на миг не перестал работать: статус running, старый контент отдаётся.
  const after = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.equal(after.data.status, 'running', 'работающий сайт остановился из-за битого архива (P-04)');
  const served = await fetchWithHost(panel.httpPort, 'bg.local', '/');
  assert.ok(served.body.includes('OLD-VERSION'), 'прежняя версия не отвечает');
});

/* ---------- T-02: сбой записи виден в API ---------- */

test('T-02: EACCES на data/ превращается в 5xx, панель живёт, запись восстанавливается', async (t) => {
  if (!isPosix) return t.skip('права каталога проверяются на POSIX');
  const { panel } = await withPanel(t);
  await api(panel, 'PUT', '/api/settings', { leEmail: 'before@example.com' });

  const dataDir = panel.dataDir;
  fs.chmodSync(dataDir, 0o500); // только чтение+выполнение: запись невозможна
  try {
    const res = await api(panel, 'PUT', '/api/settings', { leEmail: 'lost@example.com' });
    assert.ok(res.status >= 500, `сбой записи вернул ${res.status}, ожидался 5xx (T-02)`);
    assert.match(String(res.data.error), /не сохранены|EACCES|аварийн/i, 'текст ошибки не о записи');
  } finally {
    fs.chmodSync(dataDir, 0o700);
  }
  const recovered = await api(panel, 'PUT', '/api/settings', { leEmail: 'after@example.com' });
  assert.equal(recovered.status, 200, 'после восстановления прав запись не заработала');
});

/* ---------- 7.4: healthz без авторизации ---------- */

test('7.4: /healthz отвечает без учётных данных и не раскрывает деталей', async (t) => {
  const { panel } = await withPanel(t);
  const res = await fetch(panel.base + '/healthz');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Number.isFinite(body.uptimeSec));
  assert.ok(!('sites' in body) && !('dataDir' in body) && !('nodeVersion' in body), 'healthz раскрывает детали');
});
