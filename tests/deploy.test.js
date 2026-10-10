'use strict';

// Надёжность деплоя: авто-откат при неудачном старте и сериализация операций.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { startPanel, api, waitFor, makeZip, sleep } = require('./helpers/panel');

async function withPanel(t, env) {
  const panel = await startPanel(env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-b2-'));
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

/** GET / на внутреннем порту приложения — проверяет, что оно реально живо. */
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

// Сервер с явной обработкой ошибки: если порт занят — увидим причину в логе сайта.
const OK_SERVER = (marker) => [
  "const http = require('http');",
  "const s = http.createServer((q, r) => r.end('" + marker + "'));",
  "s.on('error', (e) => { console.error('listen error:', e.code, e.message); process.exit(1); });",
  "s.listen(process.env.PORT, '127.0.0.1', () => console.log('listening on', process.env.PORT));",
].join('\n');

const PKG = (start) => JSON.stringify({ name: 'app', version: '1.0.0', scripts: { start } });

/* ---------- Авто-откат ---------- */

test('неудачный старт новой версии откатывает её из бэкапа', async (t) => {
  const { panel, tmp } = await withPanel(t);

  // v1 — рабочая.
  const v1 = makeZipAt(tmp, 'v1', {
    'package.json': PKG('node server.js'),
    'server.js': OK_SERVER('v1'),
  });
  const site = await uploadNew(panel, v1, 'rollback-demo');
  assert.equal(site.type, 'node');
  await waitFor(async () => (await getInternal(site.port)).status === 200, {
    timeout: 20000, label: 'v1 отвечает на внутреннем порту',
  });
  assert.equal((await getInternal(site.port)).body, 'v1');

  // v2 — падает при старте (синтаксическая ошибка).
  const v2 = makeZipAt(tmp, 'v2', {
    'package.json': PKG('node server.js'),
    'server.js': 'this is not valid javascript {{{',
  });
  const upd = await updateSite(panel, site.id, v2);

  assert.equal(upd.status, 200, 'деплой прошёл по HTTP, ошибка — в результате');
  assert.equal(upd.data.ok, false, 'результат должен сообщать о неудаче');
  assert.equal(upd.data.result.rolledBack, true, 'должен быть выполнен откат');
  assert.match(String(upd.data.result.error), /предыдущая версия|Восстановлена/i);
  assert.equal(upd.data.site.hasBackup, false, 'бэкап израсходован на откат');

  // Главное: сайт снова обслуживает СТАРУЮ версию, а не лежит.
  await waitFor(async () => (await getInternal(site.port)).status === 200, {
    timeout: 20000, label: 'откатанная v1 отвечает',
  });
  assert.equal((await getInternal(site.port)).body, 'v1', 'должна работать прежняя версия');

  const after = await api(panel, 'GET', `/api/sites/${site.id}`);
  if (after.data.status !== 'running') {
    const logs = await api(panel, 'GET', `/api/sites/${site.id}/logs?lines=60`);
    assert.fail(
      `сайт должен быть запущен после отката, получено status=${after.data.status} ` +
      `crashLoop=${after.data.crashLoop} attempts=${after.data.restartAttempts} running=${after.data.running}\n` +
      `--- лог сайта ---\n${logs.data.log}`
    );
  }
});

test('без бэкапа неудачный старт просто сообщает об ошибке', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const broken = makeZipAt(tmp, 'broken-first', {
    'package.json': PKG('node server.js'),
    'server.js': 'syntax error here {{{',
  });
  const site = await uploadNew(panel, broken, 'first-deploy-broken');
  // Первый деплой: бэкапа нет, откатывать нечего.
  assert.equal(site.status, 'crashed', `ожидался crashed, получено ${site.status}`);
  const r = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.equal(r.data.crashLoop, false, 'это не цикл перезапусков, а неудачный первый старт');
});

/* ---------- Сериализация операций ---------- */

test('параллельные рестарты выполняются по очереди, без гонки за порт', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const zip = makeZipAt(tmp, 'serial', {
    'package.json': PKG('node server.js'),
    'server.js': OK_SERVER('serial'),
  });
  const site = await uploadNew(panel, zip, 'serial-demo');
  await waitFor(async () => (await getInternal(site.port)).status === 200, {
    timeout: 20000, label: 'первый запуск',
  });

  // Три одновременных рестарта: без мьютекса они бы наслаивались друг на друга
  // (stop/start вперемешку) и могли оставить два процесса на одном порту.
  const results = await Promise.all([
    api(panel, 'POST', `/api/sites/${site.id}/restart`),
    api(panel, 'POST', `/api/sites/${site.id}/restart`),
    api(panel, 'POST', `/api/sites/${site.id}/restart`),
  ]);
  for (const r of results) {
    if (r.status !== 200 || !r.data.ok) {
      const logs = await api(panel, 'GET', `/api/sites/${site.id}/logs?lines=80`);
      assert.fail(`рестарт вернул HTTP ${r.status}: ${JSON.stringify(r.data)}\n--- лог сайта ---\n${logs.data.log}`);
    }
  }

  // Сайт обслуживает запросы, и на порту ровно один слушатель.
  await waitFor(async () => (await getInternal(site.port)).status === 200, {
    timeout: 20000, label: 'сайт отвечает после серии рестартов',
  });

  const after = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.equal(after.data.status, 'running');
  assert.ok(after.data.stats && after.data.stats.pid, 'должен быть один живой процесс с PID');
});

test('параллельные deploy и stop не ломают сайт', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const zip = makeZipAt(tmp, 'mix', {
    'package.json': PKG('node server.js'),
    'server.js': OK_SERVER('mix'),
  });
  const site = await uploadNew(panel, zip, 'mix-demo');
  await waitFor(async () => (await getInternal(site.port)).status === 200, {
    timeout: 20000, label: 'первый запуск',
  });

  // Деплой и остановка одновременно: мьютекс должен дать детерминированный итог.
  const [deployRes, stopRes] = await Promise.all([
    updateSite(panel, site.id, zip),
    api(panel, 'POST', `/api/sites/${site.id}/stop`),
  ]);
  assert.equal(deployRes.status, 200);
  assert.equal(stopRes.status, 200);
  if (!stopRes.data || stopRes.data.ok !== true) {
    assert.fail(`stop вернул: ${JSON.stringify(stopRes.data)} (raw: ${String(stopRes.text).slice(0, 200)})`);
  }

  // Итоговое состояние согласовано: либо остановлен, либо работает — без «залипших» статусов.
  const final = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.ok(['running', 'stopped', 'crashed'].includes(final.data.status), `странный статус: ${final.data.status}`);
  if (final.data.status === 'running') {
    assert.equal((await getInternal(site.port)).status, 200, 'если running — порт должен отвечать');
  } else {
    assert.equal(final.data.running, false);
  }
  await sleep(500);
});
