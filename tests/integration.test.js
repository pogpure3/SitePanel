'use strict';

// Интеграционные тесты: поднимаем настоящую панель и проверяем поведение по HTTP.
// Запуск: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startPanel, api, apiRaw, waitFor, makeZip, fetchWithHost, sleep } = require('./helpers/panel');

/** Поднимает панель и гарантирует остановку + удаление временных файлов. */
async function withPanel(t, env) {
  const panel = await startPanel(env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-artifacts-'));
  t.after(async () => {
    await panel.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ }
  });
  return { panel, tmp };
}

async function uploadSite(panel, tmp, siteName, files, { autoStart = true } = {}) {
  const zip = path.join(tmp, `${siteName}.zip`);
  makeZip(path.join(tmp, siteName), files, zip);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), `${siteName}.zip`);
  form.append('name', siteName);
  form.append('autoStart', autoStart ? 'true' : 'false');
  const res = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const data = await res.json();
  assert.equal(res.status, 200, `деплой не удался: ${JSON.stringify(data)}`);
  return data;
}

async function bindDomain(panel, siteId, domain) {
  const r = await api(panel, 'POST', `/api/sites/${siteId}/domains`, { domain });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

/* ---------- 1.4 Заголовки безопасности ---------- */

test('security headers присутствуют на ответах админки', async (t) => {
  const { panel } = await withPanel(t);
  const res = await fetch(panel.base + '/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp && csp.includes("default-src 'self'"), `CSP отсутствует: ${csp}`);
  assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP без frame-ancestors');
  assert.ok(csp.includes("object-src 'none'"), 'CSP без object-src');
  // HSTS только при TLS — по http не должен появляться.
  assert.equal(res.headers.get('strict-transport-security'), null);
});

test('HSTS включается за TLS-терминирующим прокси', async (t) => {
  const { panel } = await withPanel(t);
  const res = await fetch(panel.base + '/', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000');
});

test('API-ответы не кэшируются', async (t) => {
  const { panel } = await withPanel(t);
  const res = await fetch(panel.base + '/api/system', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

/* ---------- 1.5 CSRF ---------- */

test('мутирующий запрос без X-Requested-With отклоняется', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'csrf-site', { 'index.html': '<h1>ok</h1>' });

  const blocked = await apiRaw(panel, 'POST', `/api/sites/${site.id}/stop`);
  assert.equal(blocked.status, 403, 'POST без заголовка должен быть отклонён');
  assert.match(String(blocked.data && blocked.data.error), /CSRF/i);

  const blockedPatch = await apiRaw(panel, 'PATCH', `/api/sites/${site.id}`, { name: 'hacked' });
  assert.equal(blockedPatch.status, 403);

  // GET (safe method) заголовка не требует.
  const okGet = await apiRaw(panel, 'GET', '/api/sites');
  assert.equal(okGet.status, 200);

  // С заголовком запрос проходит.
  const allowed = await api(panel, 'POST', `/api/sites/${site.id}/stop`);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.ok, true);
});

/* ---------- 1.1 Секреты не раздаются ---------- */

test('статический сайт не отдаёт .env, .git и node_modules', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'secret-site', {
    'index.html': '<h1>public</h1>',
    'app.js': 'console.log(1)',
    '.env': 'SECRET_TOKEN=super-secret-value',
    '.git/config': '[core]\n\trepositoryformatversion = 0',
    'node_modules/left-pad/index.js': 'module.exports = 1',
    'db_config.json': '{"password":"leaked"}',
  });
  await bindDomain(panel, site.id, 'secret.test');

  // fetch() выбрасывает Host, поэтому ходим через прокси «сырым» http-запросом.
  const get = (p) => fetchWithHost(panel.httpPort, 'secret.test', p);

  // Контроль: обычный контент раздаётся.
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.body, /public/);

  // Секреты и служебные каталоги — 404 и без утечки содержимого.
  for (const p of ['/.env', '/.git/config', '/node_modules/left-pad/index.js']) {
    const r = await get(p);
    assert.equal(r.status, 404, `${p} должен отдавать 404, получено ${r.status}`);
    assert.ok(!r.body.includes('super-secret-value'), `${p} утёк секрет`);
  }
});

/* ---------- 1.3 Диск определяется на Windows ---------- */

test('метрики диска определяются (кроссплатформенно)', async (t) => {
  const { panel } = await withPanel(t);
  // readDisk асинхронный и вызывается на старте — даём ему завершиться.
  const snap = await waitFor(async () => {
    const r = await api(panel, 'GET', '/api/dashboard');
    return r.data && r.data.disk ? r.data : null;
  }, { timeout: 15000, label: 'метрики диска' });

  assert.ok(snap.disk.total > 0, 'total должен быть положительным');
  assert.ok(snap.disk.used >= 0, 'used не может быть отрицательным');
  assert.ok(snap.disk.pct >= 0 && snap.disk.pct <= 100, `pct вне диапазона: ${snap.disk.pct}`);
  assert.ok(snap.disk.path, 'path должен быть заполнен');
});

/* ---------- 1.2 Бэкофф перезапусков ---------- */

test('падающий сайт: бэкофф нарастает, затем автоперезапуск останавливается', async (t) => {
  const { panel, tmp } = await withPanel(t, {
    PANEL_RESTART_MAX_ATTEMPTS: '2',
    PANEL_RESTART_COOLDOWN_MIN: '60', // чтобы «остывание» не вмешалось в тест
  });

  // Падает через 3с: больше «окна стабильности» старой проверки в 1.5с —
  // именно этот случай раньше зацикливался на «№1 через 1с».
  const site = await uploadSite(panel, tmp, 'crasher', {
    'package.json': JSON.stringify({
      name: 'crasher',
      version: '1.0.0',
      scripts: { start: 'node server.js' },
    }),
    'server.js': [
      "const http = require('http');",
      "const s = http.createServer((q, r) => r.end('ok'));",
      "s.listen(process.env.PORT, '127.0.0.1', () => {",
      "  console.log('listening');",
      '  setTimeout(() => process.exit(7), 3000);',
      '});',
    ].join('\n'),
  });
  assert.equal(site.type, 'node', 'сайт должен определиться как Node.js');

  const state = await waitFor(async () => {
    const r = await api(panel, 'GET', `/api/sites/${site.id}`);
    return r.data && r.data.crashLoop ? r.data : null;
  }, { timeout: 45000, interval: 500, label: 'crashLoop (лимит перезапусков исчерпан)' });

  // Лимит достигнут и цикл остановлен — это и есть исправление.
  assert.equal(state.crashLoop, true, 'должен выставиться crashLoop');
  // Счётчик равен «лимит + падение, которое его переполнило» (2 разрешённых → 3).
  assert.ok(
    state.restartAttempts > 2,
    `бэкофф должен перевалить за лимит, получено ${state.restartAttempts}`
  );
  assert.ok(state.restartCount >= 3, `должно быть ≥3 перезапусков, получено ${state.restartCount}`);
  assert.ok(state.lastCrashAt, 'lastCrashAt должен быть заполнен');
  assert.equal(state.status, 'crashed');

  // Ключевая проверка: попытки РАЗНЫЕ (№1 и №2), а не бесконечное «№1».
  const logRes = await api(panel, 'GET', `/api/sites/${site.id}/logs?lines=500`);
  const log = logRes.data.log;
  assert.match(log, /автоперезапуск №1\/2/, `в логе нет №1/2:\n${log}`);
  assert.match(log, /автоперезапуск №2\/2/, `в логе нет №2/2 — бэкофф не нарастает:\n${log}`);
  assert.match(log, /лимит автоперезапусков исчерпан/, 'нет сообщения о достижении лимита');

  // Убеждаемся, что после лимита новых перезапусков не происходит.
  const before = state.restartCount;
  await sleep(8000);
  const after = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.equal(after.data.restartCount, before, 'после лимита перезапуски не должны продолжаться');
});

test('окно стабильности не сбрасывает счётчик у мёртвого процесса', async (t) => {
  // Регрессия (наблюдалась на реальной панели):
  //   23:06:18 автоперезапуск №4/5 через 64с
  //   23:07:15 процесс стабилен 60с — счётчик перезапусков сброшен   <-- процесс уже мёртв
  // Таймер «процесс стабилен N секунд» взводится, пока процесс жив, а срабатывает
  // позже; без повторной проверки живости падающий сайт бесконечно сбрасывал себе
  // бэкофф и никогда не доходил до лимита.
  const { panel, tmp } = await withPanel(t, {
    PANEL_RESTART_MAX_ATTEMPTS: '1',
    PANEL_RESTART_STABLE_SEC: '5',
    PANEL_RESTART_COOLDOWN_MIN: '60',
  });

  // Падает через 3с — РАНЬШЕ окна стабильности (5с).
  const site = await uploadSite(panel, tmp, 'early-crasher', {
    'package.json': JSON.stringify({ name: 'early', version: '1.0.0', scripts: { start: 'node server.js' } }),
    'server.js': [
      "const http = require('http');",
      "http.createServer((q, r) => r.end('ok')).listen(process.env.PORT, '127.0.0.1', () => {",
      '  setTimeout(() => process.exit(9), 3000);',
      '});',
    ].join('\n'),
  });

  // Ждём достаточно, чтобы окно стабильности точно истекло (5с) и началась серия падений.
  await waitFor(async () => {
    const r = await api(panel, 'GET', `/api/sites/${site.id}`);
    return r.data && (r.data.restartCount || 0) >= 1 ? r.data : null;
  }, { timeout: 30000, interval: 500, label: 'первое падение' });
  await sleep(9000); // заведомо больше окна стабильности

  const logs = await api(panel, 'GET', `/api/sites/${site.id}/logs?lines=200`);
  const log = logs.data.log;
  assert.ok(
    !/процесс стабилен/.test(log),
    'счётчик сброшен, хотя процесс ни разу не прожил окно стабильности:\n' + log
  );
  // Серия падений продолжается, а не «обнуляется» тишиной.
  const after = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.ok((after.data.restartCount || 0) >= 1, 'нет зафиксированных перезапусков');
});

test('ручной запуск сбрасывает серию падений', async (t) => {
  const { panel, tmp } = await withPanel(t, {
    PANEL_RESTART_MAX_ATTEMPTS: '2',
    PANEL_RESTART_COOLDOWN_MIN: '60',
  });
  const site = await uploadSite(panel, tmp, 'crasher2', {
    'package.json': JSON.stringify({ name: 'crasher2', version: '1.0.0', scripts: { start: 'node server.js' } }),
    'server.js': "require('http').createServer((q,r)=>r.end('ok')).listen(process.env.PORT,'127.0.0.1',()=>setTimeout(()=>process.exit(7),3000));",
  });

  await waitFor(async () => {
    const r = await api(panel, 'GET', `/api/sites/${site.id}`);
    return r.data && r.data.crashLoop ? r.data : null;
  }, { timeout: 45000, interval: 500, label: 'crashLoop' });

  // Ручной рестарт — новая серия, счётчик обнуляется.
  const restarted = await api(panel, 'POST', `/api/sites/${site.id}/restart`);
  assert.equal(restarted.status, 200);
  assert.equal(restarted.data.ok, true, JSON.stringify(restarted.data));

  const after = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.equal(after.data.crashLoop, false, 'crashLoop должен сброситься');
  assert.ok(after.data.restartAttempts < 2, `счётчик должен обнулиться, получено ${after.data.restartAttempts}`);
});
