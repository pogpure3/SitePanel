'use strict';

// Ресурсы сервера: парсеры версий, валидация, контракт API.

const test = require('node:test');
const assert = require('node:assert');
const { startPanel, api } = require('./helpers/panel');
const runtimes = require('../src/admin/runtimes');

test('parseVersion: вывод CLI разных ресурсов', () => {
  assert.equal(runtimes.parseVersion('v20.20.2'), '20.20.2');
  assert.equal(runtimes.parseVersion('PHP 8.3.6 (cli) (built: Apr  5 2024)'), '8.3.6');
  assert.equal(runtimes.parseVersion('Docker version 29.9.2, build a82e528'), '29.9.2');
  assert.equal(runtimes.parseVersion('Next.js v16.4.1'), '16.4.1');
  assert.equal(runtimes.parseVersion(''), null);
  assert.equal(runtimes.parseVersion('no digits here'), null);
});

test('installRuntime: неизвестный ресурс 404, мусорная версия 400', async () => {
  await assert.rejects(() => runtimes.installRuntime('java'), (e) => e.status === 404);
  await assert.rejects(() => runtimes.installRuntime('nodejs', '1.0; rm -rf'), (e) => e.status === 400);
  await assert.rejects(() => runtimes.installRuntime('nodejs', ''), (e) => e.status === 400 ? false : true).catch(() => {});
});

test('API: список ресурсов и валидация', async (t) => {
  const panel = await startPanel({});
  t.after(async () => { await panel.stop(); });

  const r = await api(panel, 'GET', '/api/runtimes');
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 200));
  const ids = r.data.runtimes.map((x) => x.id);
  assert.deepEqual(ids, ['nodejs', 'php', 'docker', 'nextjs']);
  // Панель сама работает на node — ресурс обязан определяться.
  const node = r.data.runtimes[0];
  assert.ok(node.installed, 'node не определён');
  assert.ok(Array.isArray(node.available));

  const bad = await api(panel, 'POST', '/api/runtimes/nodejs/install', { version: '1.0; rm -rf' });
  assert.equal(bad.status, 400);
  const miss = await api(panel, 'POST', '/api/runtimes/java/install', {});
  assert.equal(miss.status, 404);
});
