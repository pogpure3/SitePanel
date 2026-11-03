'use strict';

// Внешнее SSH-назначение бэкапов: валидация настроек, сокрытие ключа из API,
// запись ошибки синхронизации без отказа самого бэкапа.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startPanel, api, waitFor, makeZip } = require('./helpers/panel');

async function createSite(panel, tmp, name) {
  const zip = path.join(tmp, name + '.zip');
  makeZip(path.join(tmp, name), { 'index.html': '<h1>demo</h1>' }, zip);
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

test('remote: валидация настроек', async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-bkremote-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ } });

  const site = await createSite(panel, tmp, 'app');

  const badPort = await api(panel, 'PUT', `/api/sites/${site.id}/backups/remote`, { port: 0 });
  assert.equal(badPort.status, 400, JSON.stringify(badPort.data));

  const incomplete = await api(panel, 'PUT', `/api/sites/${site.id}/backups/remote`, { enabled: true, host: 'h' });
  assert.equal(incomplete.status, 400, 'включение без user/dir должно отклоняться');

  const saved = await api(panel, 'PUT', `/api/sites/${site.id}/backups/remote`, {
    enabled: true, host: '127.0.0.1', port: 1, user: 'u', dir: '/tmp/bk', key: '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----\n',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.remote.enabled, true);
  assert.equal(saved.data.remote.hasKey, true);
  assert.ok(!('key' in saved.data.remote), 'ключ не должен возвращаться из API');

  // GET /backups тоже не отдаёт ключ.
  const list = await api(panel, 'GET', `/api/sites/${site.id}/backups`);
  assert.equal(list.data.remote.hasKey, true);
  assert.ok(!('key' in list.data.remote));
  assert.equal(list.data.remote.port, 1);
});

test('remote: ошибка копирования не отменяет бэкап', async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-bkremote-fail-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ } });

  const site = await createSite(panel, tmp, 'app');

  // Порт 1: соединение отвергается сразу (или ssh отсутствует — тоже ошибка,
  // которую панель обязана записать, а не потерять).
  const saved = await api(panel, 'PUT', `/api/sites/${site.id}/backups/remote`, {
    enabled: true, host: '127.0.0.1', port: 1, user: 'u', dir: '/tmp/bk',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));

  const created = await api(panel, 'POST', `/api/sites/${site.id}/backups`, { scope: 'full' });
  assert.equal(created.status, 200, `бэкап должен создаться несмотря на недоступный remote: ${JSON.stringify(created.data)}`);
  const name = created.data.backup.name;

  await waitFor(async () => {
    const list = await api(panel, 'GET', `/api/sites/${site.id}/backups`);
    return list.data.remote.lastSyncError;
  }, { timeout: 45000, interval: 500, label: 'ошибка синхронизации в backupRemote' });

  const list = await api(panel, 'GET', `/api/sites/${site.id}/backups`);
  assert.ok(list.data.backups.some((b) => b.name === name), 'бэкап должен остаться в списке');
  assert.ok(list.data.remote.lastSyncError.length > 0);
});
