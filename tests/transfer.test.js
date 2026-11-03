'use strict';

// Перенос сайта: экспорт (архив с manifest.json) и импорт на тот же экземпляр.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const { startPanel, api, makeZip } = require('./helpers/panel');

async function createSite(panel, tmp, name, files) {
  const zip = path.join(tmp, name + '.zip');
  makeZip(path.join(tmp, name), files, zip);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), name + '.zip');
  form.append('name', name);
  const res = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const site = await res.json();
  assert.equal(res.status, 200, `сайт не создался: ${JSON.stringify(site)}`);
  return site;
}

async function exportSite(panel, siteId) {
  const res = await fetch(panel.base + `/api/sites/${siteId}/export`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  assert.equal(res.status, 200, `экспорт не удался: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

test('перенос: экспорт содержит манифест и файлы, импорт восстанавливает настройки', async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-transfer-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ } });

  const site = await createSite(panel, tmp, 'mover', { 'index.html': '<h1>v1</h1>', 'app.js': 'console.log(1)' });
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'transfer.example.com' });
  await api(panel, 'PATCH', `/api/sites/${site.id}`, { noindex: true, autoStart: true });

  const zipBuf = await exportSite(panel, site.id);
  const zip = new AdmZip(zipBuf);
  const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
  assert.equal(manifest.format, 'sitepanel-export');
  assert.deepEqual(manifest.site.domains, ['transfer.example.com']);
  assert.equal(manifest.site.noindex, true);
  assert.equal(zip.getEntry('index.html').getData().toString('utf8'), '<h1>v1</h1>', 'файл сайта должен быть в архиве');

  // Импорт в ту же панель: сайт с теми же настройками, но новым id.
  const form = new FormData();
  form.append('file', new Blob([zipBuf]), 'export.zip');
  const res = await fetch(panel.base + '/api/sites/import', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const imported = await res.json();
  assert.equal(res.status, 200, `импорт не удался: ${JSON.stringify(imported)}`);
  assert.notEqual(imported.id, site.id);
  assert.deepEqual(imported.domains, ['transfer.example.com']);
  assert.equal(imported.noindex, true);
  assert.equal(imported.autoStart, true);

  // manifest.json не попал в webroot, файлы сайта на месте.
  const siteDir = path.join(panel.dataDir, 'sites', imported.id);
  assert.equal(fs.existsSync(path.join(siteDir, 'manifest.json')), false, 'manifest.json не должен оставаться в каталоге сайта');
  assert.equal(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'), '<h1>v1</h1>');
  assert.equal(fs.existsSync(path.join(siteDir, 'app.js')), true);
});

test('перенос: обычный zip без manifest.json отклоняется', async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-transfer-bad-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ } });

  const zipPath = path.join(tmp, 'plain.zip');
  makeZip(path.join(tmp, 'plain'), { 'index.html': '<h1>x</h1>' }, zipPath);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zipPath)]), 'plain.zip');
  const res = await fetch(panel.base + '/api/sites/import', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const data = await res.json();
  assert.equal(res.status, 400, `ожидается 400, получено ${res.status}: ${JSON.stringify(data)}`);
  assert.match(data.error, /manifest\.json/);
});
