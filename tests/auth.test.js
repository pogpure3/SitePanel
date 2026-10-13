'use strict';

// Регрессия: интерфейс админки не должен отдаваться без пароля.
// Раньше middleware авторизации стоял только на /api, поэтому index.html,
// app.js и style.css (оболочка панели) были публичными — посторонний видел
// сам интерфейс, его меню и разметку, а 401 приходил лишь на данные.

const test = require('node:test');
const assert = require('node:assert');

const { startPanel, api } = require('./helpers/panel');

/** Поднимает панель С ВКЛЮЧЁННОЙ авторизацией (PANEL_NO_AUTH=''). */
async function withAuthPanel(t, env = {}) {
  const panel = await startPanel({ ...env, PANEL_NO_AUTH: '' });
  t.after(async () => { await panel.stop(); });
  return panel;
}

function basicAuth(panel) {
  return 'Basic ' + Buffer.from(`${panel.auth.user}:${panel.auth.password}`).toString('base64');
}

test('статика админки требует авторизацию', async (t) => {
  const panel = await withAuthPanel(t);

  for (const p of ['/', '/index.html', '/app.js', '/style.css']) {
    const res = await fetch(panel.base + p);
    assert.equal(res.status, 401, `${p} без пароля должен вернуть 401, получено ${res.status}`);
    const wwwAuth = res.headers.get('www-authenticate');
    assert.ok(wwwAuth && wwwAuth.includes('Basic'), `${p} без WWW-Authenticate`);
    // Тело отказа не должно содержать разметку панели.
    const body = await res.text();
    assert.ok(!body.includes('<title>'), `${p} отдал разметку интерфейса без пароля`);
  }
});

test('статика админки доступна с авторизацией', async (t) => {
  const panel = await withAuthPanel(t);
  const headers = { Authorization: basicAuth(panel) };

  const index = await fetch(panel.base + '/', { headers });
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /<title>/, 'index.html не отдался с паролем');

  for (const p of ['/app.js', '/style.css']) {
    const res = await fetch(panel.base + p, { headers });
    assert.equal(res.status, 200, `${p} с паролем должен отдавать 200`);
    assert.ok((await res.text()).length > 0, `${p} пустой`);
  }
});

test('неверный пароль не открывает интерфейс', async (t) => {
  const panel = await withAuthPanel(t);
  const bad = 'Basic ' + Buffer.from('admin:definitely-not-the-password').toString('base64');
  const res = await fetch(panel.base + '/', { headers: { Authorization: bad } });
  assert.equal(res.status, 401);
});

test('API остаётся закрытым, а с паролем работает', async (t) => {
  const panel = await withAuthPanel(t);

  const noAuth = await fetch(panel.base + '/api/system', {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  assert.equal(noAuth.status, 401);

  const withAuth = await api(
    panel,
    'GET',
    '/api/system',
    undefined,
    { Authorization: basicAuth(panel) }
  );
  assert.equal(withAuth.status, 200);
  assert.ok(withAuth.data && withAuth.data.nodeVersion, 'нет данных system');
});

test('отказ авторизации не кэшируется', async (t) => {
  const panel = await withAuthPanel(t);
  const res = await fetch(panel.base + '/');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('PANEL_NO_AUTH=1 по-прежнему отключает встроенную авторизацию', async (t) => {
  // Опция нужна, когда авторизацию выполняет внешний реверс-прокси.
  const panel = await startPanel({ PANEL_NO_AUTH: '1' });
  t.after(async () => { await panel.stop(); });

  const res = await fetch(panel.base + '/');
  assert.equal(res.status, 200, 'с PANEL_NO_AUTH=1 статика должна отдаваться');
});
