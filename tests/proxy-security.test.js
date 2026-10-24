'use strict';

// Регрессия H-01/H-02/H-03/H-11/P-14/U-06: HTTP-слой и заглушки.
//
//   H-01  Host и декодированный путь подставлялись в HTML заглушек без экранирования —
//         отражённый XSS на домене размещённого сайта, без авторизации;
//   H-02  hostOf() ломался на IPv6-литерале ([::1]:8443 → '['), а редирект 301
//         собирался из подконтрольного клиенту Host (открытый редирект);
//   H-03  раздача статики проверяла путь ЛЕКСИЧЕСКИ: симлинк внутри каталога сайта
//         позволял отдать /etc/passwd или .env соседнего сайта;
//   P-14  прокси на site.port=null не отвечал никогда — запрос висел навсегда;
//   U-06  неизвестный /api/* возвращал index.html со статусом 200.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startPanel, api, fetchWithHost, makeZip, sleep } = require('./helpers/panel');

/* ---------- Чистые функции ---------- */

test('H-01: esc экранирует метасимволы HTML', () => {
  const { esc } = require('../src/httpserver');
  assert.equal(esc('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(esc('"\'&<>'), '&quot;&#39;&amp;&lt;&gt;');
  assert.equal(esc(undefined), '');
  assert.equal(esc(null), '');
  assert.equal(esc(0), '0');
});

test('H-01: заглушка не пропускает HTML из Host', () => {
  const { page } = require('../src/httpserver');
  const html = page('Домен не настроен', `домен <b>${require('../src/httpserver').esc('<img src=x onerror=alert(1)>.evil')}</b>`);
  assert.ok(!html.includes('<img'), 'тег из Host попал в разметку');
  assert.ok(html.includes('&lt;img'), 'ожидалось экранирование');
});

test('H-02: hostOf разбирает IPv6-литерал и порт', () => {
  const { hostOf } = require('../src/httpserver');
  const req = (host) => ({ headers: { host } });
  assert.equal(hostOf(req('example.com')), 'example.com');
  assert.equal(hostOf(req('Example.COM:8443')), 'example.com');
  assert.equal(hostOf(req('[::1]:8443')), '::1', 'раньше возвращался символ "["');
  assert.equal(hostOf(req('[2001:db8::1]')), '2001:db8::1');
  assert.equal(hostOf(req('a.example.com, b.example.com')), 'a.example.com');
  assert.equal(hostOf(req(undefined)), '');
  // Заголовок управляется клиентом: посторонние символы отбрасываются целиком.
  assert.equal(hostOf(req('<b>injected</b>.evil')), '');
  assert.equal(hostOf(req('evil .test')), '');
});

test('Portal — единственный разрешённый предок встроенной админ-панели', () => {
  const { securityHeaders } = require('../src/httpserver');
  const headersFor = (host) => {
    const headers = new Map();
    securityHeaders(
      { headers: { host }, path: '/', socket: { remoteAddress: '127.0.0.1' }, secure: false },
      { setHeader: (name, value) => headers.set(name.toLowerCase(), value) },
      () => {}
    );
    return headers;
  };

  const embedded = headersFor('panel.evil-mesh.ru');
  assert.equal(embedded.get('x-frame-options'), undefined);
  assert.match(embedded.get('content-security-policy'), /frame-ancestors https:\/\/prtl\.evil-mesh\.ru/);

  const ordinary = headersFor('other.evil-mesh.ru');
  assert.equal(ordinary.get('x-frame-options'), 'DENY');
  assert.match(ordinary.get('content-security-policy'), /frame-ancestors 'none'/);
});

/* ---------- Вспомогательное ---------- */

async function withPanel(t, env) {
  const panel = await startPanel(env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-proxy-'));
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
  const data = await res.json();
  assert.equal(res.status, 200, `деплой не удался: ${JSON.stringify(data)}`);
  return data;
}

/* ---------- Заглушки через публичный прокси ---------- */

test('H-01: неизвестный домен — заглушка без разметки из Host', async (t) => {
  const { panel } = await withPanel(t);
  const payload = '<img src=x onerror=alert(1)>';
  const res = await fetchWithHost(panel.httpPort, `${payload}.evil`, '/');
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes('<img src=x'), `payload из Host ушёл в тело: ${res.body}`);
  assert.ok(!res.body.includes('onerror'), 'часть payload из Host отражена в теле');
  // hostOf() отбрасывает имя хоста с посторонними символами целиком, поэтому
  // в заглушке остаётся подстановка по умолчанию, а не экранированный payload.
  assert.ok(res.body.includes('не привязан'), `заглушка не отдана: ${res.body.slice(0, 200)}`);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('H-01: путь с HTML в статике не отражается как разметка', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'xss-static', { 'index.html': '<h1>ok</h1>' });
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'xss.static.local' });

  const res = await fetchWithHost(panel.httpPort, 'xss.static.local', '/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E');
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes('<img src=x'), `payload из пути ушёл в тело: ${res.body}`);
  assert.ok(res.body.includes('&lt;img'), 'ожидалось экранирование пути');
});

test('H-02: редирект на HTTPS не использует подконтрольный Host', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'redir', { 'index.html': '<h1>ok</h1>' });
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'redir.local' });
  const r = await api(panel, 'POST', `/api/sites/${site.id}/ssl/selfsigned`);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  // Чужой Host не должен приводить к редиректу на чужой домен: панель вообще
  // не находит сайт по такому имени и обязана ответить заглушкой без Location
  // (прежде Location собирался из req.headers.host — открытый редирект, H-02).
  const res = await fetchWithHost(panel.httpPort, 'evil.attacker.test', '/');
  assert.equal(res.status, 404, `ожидалась заглушка, получено ${res.status}`);
  assert.ok(!res.headers.location, `открытый редирект: ${res.headers.location}`);

  // Редирект для своего домена ведёт на домен ИЗ РЕЕСТРА.
  const own = await fetchWithHost(panel.httpPort, 'redir.local', '/page?x=1');
  const location = own.headers.location || '';
  assert.ok(location.startsWith('https://redir.local'), `неожиданный Location: ${location}`);
  assert.ok(location.endsWith('/page?x=1'), `путь потерян: ${location}`);

  // Абсолютная форма request-target не должна попадать в Location целиком.
  const abs = await fetchWithHost(panel.httpPort, 'redir.local', 'http://evil.test/x');
  const absLocation = abs.headers.location || '';
  assert.ok(!absLocation.includes('evil.test'), `Location собран из request-target: ${absLocation}`);
});

/* ---------- H-03: симлинк за пределы каталога ---------- */

test('H-03: симлинк внутри каталога сайта не отдаёт файл наружу', async (t) => {
  if (process.platform === 'win32') return t.skip('симлинки проверяются на POSIX');
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'symlink', { 'index.html': '<h1>ok</h1>' }, false);
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'symlink.local' });

  // Секрет создаём вне каталога сайта, но внутри каталога данных.
  const secret = path.join(panel.dataDir, 'secret.txt');
  fs.writeFileSync(secret, 'TOP-SECRET-VALUE');
  const siteDir = path.join(panel.dataDir, 'sites', site.id);
  fs.symlinkSync(secret, path.join(siteDir, 'leak.txt'));

  await api(panel, 'POST', `/api/sites/${site.id}/start`);
  await sleep(300);

  const res = await fetchWithHost(panel.httpPort, 'symlink.local', '/leak.txt');
  assert.equal(res.status, 403, `симлинк наружу отдан со статусом ${res.status}: ${res.body.slice(0, 200)}`);
  assert.ok(!res.body.includes('TOP-SECRET-VALUE'), 'содержимое секрета утекло');
});

test('H-03: обычные файлы и симлинки ВНУТРИ каталога работают', async (t) => {
  if (process.platform === 'win32') return t.skip('симлинки проверяются на POSIX');
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'symlink-ok', { 'index.html': '<h1>ok</h1>', 'real.txt': 'REAL' }, false);
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'symlink-ok.local' });
  const siteDir = path.join(panel.dataDir, 'sites', site.id);
  fs.symlinkSync(path.join(siteDir, 'real.txt'), path.join(siteDir, 'alias.txt'));

  await api(panel, 'POST', `/api/sites/${site.id}/start`);
  await sleep(300);

  const ok = await fetchWithHost(panel.httpPort, 'symlink-ok.local', '/real.txt');
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'REAL');

  const alias = await fetchWithHost(panel.httpPort, 'symlink-ok.local', '/alias.txt');
  assert.equal(alias.status, 200, 'симлинк на файл внутри каталога должен отдаваться');
  assert.equal(alias.body, 'REAL');
});

/* ---------- P-14: прокси на несуществующий порт ---------- */

test('P-14: сайт без порта отвечает заглушкой, а не висит', async (t) => {
  // Порт теряется при порче db.json (SP-01): запись есть, тип node, статус
  // running, а port = null. Прежде прокси уходил на `http://127.0.0.1:null`
  // и не отдавал ни ответа, ни ошибки — запрос висел вечно (P-14).
  const panel = await startPanel({}, {
    prepare: (dir) => {
      fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
        sites: [{
          id: 'noport000001',
          name: 'noport',
          type: 'node',
          port: null,
          status: 'running',
          autoStart: false,
          domains: ['noport.local'],
        }],
      }, null, 2));
    },
  });
  t.after(async () => { await panel.stop(); });

  const res = await Promise.race([
    fetchWithHost(panel.httpPort, 'noport.local', '/'),
    sleep(4000).then(() => ({ status: 'timeout', body: '', headers: {} })),
  ]);
  assert.notEqual(res.status, 'timeout', 'запрос к сайту без порта завис');
  assert.equal(res.status, 503, `ожидалась 503, получено ${res.status}`);
  assert.ok(/порт/i.test(res.body), `неожиданное тело: ${res.body.slice(0, 160)}`);
});

/* ---------- U-06: маршруты API ---------- */

test('U-06: неизвестный маршрут /api/* — JSON-404, а не index.html', async (t) => {
  const { panel } = await withPanel(t);
  const res = await api(panel, 'GET', '/api/definitely-not-a-route');
  assert.equal(res.status, 404, `получено ${res.status}`);
  assert.ok(res.data && res.data.error, `тело не JSON: ${res.text.slice(0, 120)}`);
  assert.ok(!res.text.includes('<title>SitePanel'), 'отдан index.html вместо JSON');
});

test('U-06: несуществующий сайт отдаёт JSON-404', async (t) => {
  const { panel } = await withPanel(t);
  const res = await api(panel, 'GET', '/api/sites/deadbeefdead/');
  assert.equal(res.status, 404);
  assert.match(res.data.error, /не найден/i);
});

/* ---------- H-11: JSON-контракт ошибок вместо HTML Express ---------- */

test('H-11: слишком большое тело запроса — JSON-ошибка, а не HTML', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'bigbody', { 'index.html': '<h1>ok</h1>' });

  // Лимит парсера согласован с редактором (2 МБ) — 4 МБ должны дать 413 JSON.
  const big = 'x'.repeat(4 * 1024 * 1024);
  const res = await fetch(panel.base + `/api/sites/${site.id}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ path: 'index.html', content: big }),
  });
  assert.equal(res.status, 413, `получено ${res.status}`);
  const text = await res.text();
  assert.ok(!/<pre>/.test(text), `HTML-страница Express вместо JSON: ${text.slice(0, 120)}`);
  assert.ok(JSON.parse(text).error, 'нет поля error');
});

test('H-11: битый JSON в теле — JSON-ошибка 400', async (t) => {
  const { panel } = await withPanel(t);
  const res = await fetch(panel.base + '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: '{не json',
  });
  assert.equal(res.status, 400, `получено ${res.status}`);
  const text = await res.text();
  assert.ok(!/<pre>/.test(text));
  assert.ok(JSON.parse(text).error);
});

test('H-11: редактор файлов принимает файл до 2 МБ включительно', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'edit', { 'index.html': '<h1>ok</h1>' });

  const content = 'a'.repeat(1_500_000); // больше прежнего лимита парсера 1 МБ
  const res = await api(panel, 'PUT', `/api/sites/${site.id}/file`, { path: 'big.txt', content });
  assert.equal(res.status, 200, `запись 1.5 МБ отклонена: ${res.status} ${res.text.slice(0, 120)}`);

  const back = await api(panel, 'GET', `/api/sites/${site.id}/file?path=big.txt`);
  assert.equal(back.status, 200);
  assert.equal(back.data.content.length, content.length);
});

/* ---------- Обработка исключений в сыром листенере (SP-07) ---------- */

test('SP-07: запрос к сайту с битой записью не подвешивает прокси', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'good', { 'index.html': '<h1>ok</h1>' }, false);
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'good.local' });
  await api(panel, 'POST', `/api/sites/${site.id}/start`);
  await sleep(300);

  // Портим запись в файле и перезапускаем панель: валидация должна её починить,
  // а не уронить публичный слушатель.
  const patched = await startPanel({}, {
    prepare: (dir) => {
      fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
        sites: [{ id: 'bad', name: 'bad', type: 'node', status: 'running', port: null }],
      }, null, 2));
    },
  });
  t.after(async () => { await patched.stop(); });

  const res = await Promise.race([
    fetchWithHost(patched.httpPort, 'bad.local', '/'),
    sleep(4000).then(() => ({ status: 'timeout', body: '', headers: {} })),
  ]);
  assert.notEqual(res.status, 'timeout', 'публичный прокси не ответил — сокет подвешен');
  assert.equal(res.status, 404, 'запись без domains отброшена, домен неизвестен');
});
