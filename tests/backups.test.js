'use strict';

// Плановые бэкапы: ручной бэкап, восстановление (статика и node), ротация,
// валидация расписания, планировщик, выключатель PANEL_BACKUPS=0, уборка
// бэкапов при удалении сайта.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { startPanel, api, waitFor, makeZip, sleep } = require('./helpers/panel');

async function withPanel(t, env) {
  const panel = await startPanel(env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-bk-'));
  t.after(async () => {
    await panel.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ }
  });
  return { panel, tmp };
}

function makeZipAt(tmp, name, files) {
  const zip = path.join(tmp, `${name}.zip`);
  makeZip(path.join(tmp, name), files, zip);
  return zip;
}

async function uploadNew(panel, zip, name) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), path.basename(zip));
  form.append('name', name);
  form.append('autoStart', 'true');
  const res = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const data = await res.json();
  assert.equal(res.status, 200, `деплой не удался: ${JSON.stringify(data)}`);
  return data;
}

async function updateSite(panel, siteId, zip) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), path.basename(zip));
  const res = await fetch(panel.base + `/api/sites/${siteId}/update`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  return { status: res.status, data: await res.json() };
}

function getInternal(port, p = '/') {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ status: 0, error: err.code || err.message }));
    req.end();
  });
}

const OK_SERVER = (marker) => [
  "const http = require('http');",
  "const s = http.createServer((q, r) => r.end('" + marker + "'));",
  "s.on('error', (e) => { console.error('listen error:', e.code, e.message); process.exit(1); });",
  "s.listen(process.env.PORT, '127.0.0.1', () => console.log('listening on', process.env.PORT));",
].join('\n');

const backupsDirOf = (panel, siteId) => path.join(panel.dataDir, 'backups', siteId);

test('ручной бэкап: zip на диске, sidecar-метаданные, запись в списке, скачивание', async (t) => {
  const { panel, tmp } = await withPanel(t, {});
  const zip = makeZipAt(tmp, 'v1', { 'index.html': '<h1>v1</h1>', 'data.json': '{"a":1}' });
  const site = await uploadNew(panel, zip, 'bk-manual');

  const r = await api(panel, 'POST', `/api/sites/${site.id}/backups`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  assert.match(r.data.backup.name, /^\d{8}-\d{6}\.zip$/);

  const zipPath = path.join(backupsDirOf(panel, site.id), r.data.backup.name);
  assert.ok(fs.existsSync(zipPath), 'архив лежит в data/backups/<id>/');
  const meta = JSON.parse(fs.readFileSync(zipPath + '.json', 'utf8'));
  assert.equal(meta.files, 2);
  assert.equal(meta.trigger, 'manual');
  assert.ok(meta.sizeBytes > 0);

  const list = await api(panel, 'GET', `/api/sites/${site.id}/backups`);
  assert.equal(list.status, 200);
  assert.equal(list.data.totals.count, 1);
  assert.equal(list.data.backups[0].name, r.data.backup.name);
  assert.equal(list.data.backups[0].trigger, 'manual');
  assert.equal(list.data.backups[0].enabled, undefined, 'расписание не путается с записью бэкапа');

  const dl = await fetch(panel.base + `/api/sites/${site.id}/backups/${r.data.backup.name}/download`);
  assert.equal(dl.status, 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 2)], [0x50, 0x4b], 'PK — zip-магия');
});

test('восстановление статического сайта возвращает прежнее содержимое', async (t) => {
  const { panel, tmp } = await withPanel(t, {});
  const v1 = makeZipAt(tmp, 'v1', { 'index.html': '<h1>v1</h1>' });
  const site = await uploadNew(panel, v1, 'bk-restore');

  const created = await api(panel, 'POST', `/api/sites/${site.id}/backups`);
  const name = created.data.backup.name;

  const v2 = makeZipAt(tmp, 'v2', { 'index.html': '<h1>v2</h1>' });
  const upd = await updateSite(panel, site.id, v2);
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  const after = await api(panel, 'GET', `/api/sites/${site.id}/file?path=index.html`);
  assert.ok(after.data.content.includes('v2'), 'перед восстановлением на месте v2');

  const res = await api(panel, 'POST', `/api/sites/${site.id}/backups/${name}/restore`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.ok, true, JSON.stringify(res.data));
  const restored = await api(panel, 'GET', `/api/sites/${site.id}/file?path=index.html`);
  assert.ok(restored.data.content.includes('v1'), 'после восстановления вернулось v1');
});

test('восстановление node-сайта: зависимости ставятся заново, сайт отвечает', async (t) => {
  const { panel, tmp } = await withPanel(t, {});
  const mk = (marker) => makeZipAt(tmp, `app-${marker}`, {
    'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { start: 'node server.js' } }),
    'server.js': OK_SERVER(marker),
  });
  const site = await uploadNew(panel, mk('v1'), 'bk-node');
  assert.ok(site.port, 'node-сайту выделен порт');
  await waitFor(async () => ((await getInternal(site.port)).body === 'v1' ? true : null), { label: 'старт v1' });

  const created = await api(panel, 'POST', `/api/sites/${site.id}/backups`);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const name = created.data.backup.name;

  const upd = await updateSite(panel, site.id, mk('v2'));
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  await waitFor(async () => ((await getInternal(site.port)).body === 'v2' ? true : null), { label: 'старт v2' });

  const res = await api(panel, 'POST', `/api/sites/${site.id}/backups/${name}/restore`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  await waitFor(async () => ((await getInternal(site.port)).body === 'v1' ? true : null), { timeout: 45000, label: 'сайт поднялся на v1 после восстановления' });
});

test('ротация: keep=2 хранит два свежих бэкапа', async (t) => {
  const { panel, tmp } = await withPanel(t, {});
  const zip = makeZipAt(tmp, 'v1', { 'index.html': '<h1>x</h1>' });
  const site = await uploadNew(panel, zip, 'bk-rotate');

  const sched = await api(panel, 'PUT', `/api/sites/${site.id}/backups/schedule`, { keep: 2 });
  assert.equal(sched.status, 200, JSON.stringify(sched.data));
  for (let i = 0; i < 3; i++) {
    await sleep(1100); // имя бэкапа — метка с точностью до секунды
    const r = await api(panel, 'POST', `/api/sites/${site.id}/backups`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const list = await api(panel, 'GET', `/api/sites/${site.id}/backups`);
  assert.equal(list.data.totals.count, 2, 'лишние бэкапы удалены ротацией');
  const left = fs.readdirSync(backupsDirOf(panel, site.id)).filter((f) => f.endsWith('.zip'));
  assert.equal(left.length, 2);
});

test('валидация расписания и имени бэкапа', async (t) => {
  const { panel, tmp } = await withPanel(t, {});
  const zip = makeZipAt(tmp, 'v1', { 'index.html': '<h1>x</h1>' });
  const site = await uploadNew(panel, zip, 'bk-valid');

  assert.equal((await api(panel, 'PUT', `/api/sites/${site.id}/backups/schedule`, { intervalHours: 0.01 })).status, 400);
  assert.equal((await api(panel, 'PUT', `/api/sites/${site.id}/backups/schedule`, { intervalHours: 'abc' })).status, 400);
  assert.equal((await api(panel, 'PUT', `/api/sites/${site.id}/backups/schedule`, { keep: 0 })).status, 400);
  assert.equal((await api(panel, 'PUT', `/api/sites/${site.id}/backups/schedule`, { keep: 1.5 })).status, 400);

  const ok = await api(panel, 'PUT', `/api/sites/${site.id}/backups/schedule`, { enabled: true, intervalHours: 12, keep: 3 });
  assert.equal(ok.status, 200);
  const detail = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.deepEqual(detail.data.backupSchedule, { enabled: true, intervalHours: 12, keep: 3, lastRunAt: null, lastError: null });

  // Мусорное имя — 400, корректное по формату, но несуществующее — 404.
  assert.equal((await api(panel, 'POST', `/api/sites/${site.id}/backups/${encodeURIComponent('../etc.zip')}/restore`)).status, 400);
  assert.equal((await api(panel, 'POST', `/api/sites/${site.id}/backups/evil/restore`)).status, 400);
  assert.equal((await api(panel, 'POST', `/api/sites/${site.id}/backups/20200101-000000.zip/restore`)).status, 404);
  assert.equal((await api(panel, 'DELETE', `/api/sites/${site.id}/backups/evil`)).status, 400);
  assert.equal((await api(panel, 'GET', `/api/sites/${site.id}/backups/20200101-000000.zip/download`)).status, 404);
});

test('планировщик создаёт бэкап по расписанию', async (t) => {
  const { panel, tmp } = await withPanel(t, { PANEL_BACKUP_CHECK_SEC: '1' });
  const zip = makeZipAt(tmp, 'v1', { 'index.html': '<h1>sched</h1>' });
  const site = await uploadNew(panel, zip, 'bk-sched');

  const sched = await api(panel, 'PUT', `/api/sites/${site.id}/backups/schedule`, { enabled: true, intervalHours: 0.05, keep: 3 });
  assert.equal(sched.status, 200, JSON.stringify(sched.data));

  const list = await waitFor(async () => {
    const l = await api(panel, 'GET', `/api/sites/${site.id}/backups`);
    return l.data && l.data.totals.count > 0 ? l.data : null;
  }, { timeout: 20000, label: 'плановый бэкап' });
  assert.equal(list.backups[0].trigger, 'scheduled');
  const detail = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.ok(detail.data.backupSchedule.lastRunAt, 'lastRunAt проставлен');
  assert.equal(detail.data.backupSchedule.lastError, null);
});

test('PANEL_BACKUPS=0 выключает планировщик целиком', async (t) => {
  const { panel, tmp } = await withPanel(t, { PANEL_BACKUPS: '0', PANEL_BACKUP_CHECK_SEC: '1' });
  const zip = makeZipAt(tmp, 'v1', { 'index.html': '<h1>off</h1>' });
  const site = await uploadNew(panel, zip, 'bk-off');

  const sched = await api(panel, 'PUT', `/api/sites/${site.id}/backups/schedule`, { enabled: true, intervalHours: 0.05, keep: 3 });
  assert.equal(sched.status, 200);
  await sleep(3000);
  const list = await api(panel, 'GET', `/api/sites/${site.id}/backups`);
  assert.equal(list.data.totals.count, 0, 'плановых бэкапов нет');
});

test('удаление сайта удаляет и его бэкапы', async (t) => {
  const { panel, tmp } = await withPanel(t, {});
  const zip = makeZipAt(tmp, 'v1', { 'index.html': '<h1>x</h1>' });
  const site = await uploadNew(panel, zip, 'bk-gone');
  await api(panel, 'POST', `/api/sites/${site.id}/backups`);
  assert.ok(fs.existsSync(backupsDirOf(panel, site.id)), 'каталог бэкапов создан');

  const del = await api(panel, 'DELETE', `/api/sites/${site.id}`);
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(backupsDirOf(panel, site.id)), false, 'каталог бэкапов удалён вместе с сайтом');
});

test('dueSites: выбор сайтов, которым пора на бэкап', () => {
  const backups = require('../src/sites/backups');
  const store = require('../src/store');
  const now = Date.now();
  const sched = (enabled, intervalHours, lastRunAt) => ({ enabled, intervalHours, keep: 5, lastRunAt, lastError: null });
  store.state.sites = [
    { id: 'off', backupSchedule: sched(false, 24, null) },
    { id: 'never', backupSchedule: sched(true, 24, null) },
    { id: 'stale', backupSchedule: sched(true, 1, now - 2 * 3600000) },
    { id: 'fresh', backupSchedule: sched(true, 24, now - 1000) },
    { id: 'boundary', backupSchedule: sched(true, 0.05, now - 180000 - 1) },
    { id: 'just-now', backupSchedule: sched(true, 0.05, now - 179000) },
  ];
  try {
    assert.deepEqual(backups.dueSites(now).map((s) => s.id), ['never', 'stale', 'boundary']);
  } finally {
    store.state.sites = [];
  }
});
