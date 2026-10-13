'use strict';

// Регрессии этапа 3 плана: HTTP/TLS/ACME/секреты.
//   H-03  файловый менеджер проверял путь ЛЕКСИЧЕСКИ: симлинк наружу читался
//         и перезаписывался через GET/PUT /api/sites/:id/file;
//   H-04  challenge-карта ключовалась одним токеном и чистилась целиком в finally —
//         параллельный выпуск сертификата терял свои challenge;
//   H-07  X-Forwarded-Proto доверялся любому клиенту: заголовком «https» гасился
//         редирект на HTTPS и включался HSTS;
//   H-08  статика отдавалась без ETag/Last-Modified — каждый визит качал файл целиком;
//   H-13  заголовки безопасности ставились только Express-мидлварёй админки: трафик
//         сайтов и заглушки шли без nosniff/X-Frame-Options, заглушки — без CSP;
//   H-14  Authorization панели и подделанные X-Forwarded-* уходили в приложения сайтов;
//   H-17  ensureDefaultCert проверял только privkey.pem: пропажа fullchain.pem
//         роняла весь процесс панели;
//   H-19  POST /ssl/issue принимал произвольные строки в domains;
//   H-20  режимы файлов из архива применялись как есть (0777, setuid);
//   H-21  WebSocket-апгрейд шёл на приложение с любым Origin;
//   A-02  токен Telegram отдавался в /api/settings открытым текстом;
//   A-03  CSRF держался только на X-Requested-With;
//   A-05  смена пароля не оставляла записи в журнале.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { startPanel, api, fetchWithHost, makeZip, sleep, ROOT } = require('./helpers/panel');

/* ---------- Чистые функции ---------- */

test('H-04: challenge-карта ключуется доменом и чистится только по своим токенам', () => {
  const acme = require('../src/ssl/acme');
  acme.setChallenge('a.example.test', 'tok-1', 'ka-a1');
  acme.setChallenge('a.example.test', 'tok-2', 'ka-a2');
  acme.setChallenge('b.example.test', 'tok-1', 'ka-b1');

  assert.equal(acme.getChallenge('a.example.test', 'tok-1'), 'ka-a1');
  // Чужой домен — не повод отдавать challenge (H-04).
  assert.equal(acme.getChallenge('b.example.test', 'tok-2'), null);
  assert.equal(acme.getChallenge('evil.example.test', 'tok-1'), null);
  assert.equal(acme.getChallenge('', 'tok-1'), null);

  acme.removeChallenge('a.example.test', 'tok-1');
  assert.equal(acme.getChallenge('a.example.test', 'tok-1'), null, 'свой токен не удалён');
  assert.equal(acme.getChallenge('a.example.test', 'tok-2'), 'ka-a2', 'удаление затронуло чужой токен');
  assert.equal(acme.getChallenge('b.example.test', 'tok-1'), 'ka-b1', 'удаление затронуло другой домен');
  acme.removeChallenge('a.example.test', 'tok-2');
  acme.removeChallenge('b.example.test', 'tok-1');
});

test('H-21: originAllowed пропускает домен сайта и wildcard, отсекает чужой origin', () => {
  const { originAllowed } = require('../src/httpserver');
  const site = { domains: ['app.example.test', '*.sub.example.test'] };
  assert.equal(originAllowed(undefined, site, 'app.example.test'), true, 'не-браузерный клиент без Origin');
  assert.equal(originAllowed('https://app.example.test', site, 'app.example.test'), true);
  assert.equal(originAllowed('https://x.sub.example.test', site, 'app.example.test'), true, 'wildcard-поддомен');
  assert.equal(originAllowed('https://sub.example.test', site, 'app.example.test'), true, 'база wildcard');
  assert.equal(originAllowed('https://evil.example.test', site, 'app.example.test'), false, 'чужой origin');
  assert.equal(originAllowed('not a url', site, 'app.example.test'), false, 'мусор вместо Origin');
  const empty = { domains: [] };
  assert.equal(originAllowed('https://other.test', empty, 'other.test'), true, 'совпадение с Host без привязки');
});

/* ---------- Вспомогательное ---------- */

async function withPanel(t, env, opts = {}) {
  const panel = await startPanel(env || {}, opts);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-stage3-'));
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

/** GET через публичный прокси с произвольными заголовками (Host обязателен). */
function requestWithHeaders(port, host, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'GET', headers: { Host: host, ...headers } },
      (res) => {
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** WS-апгрейд через панель: { upgraded, status } (status 0 — сокет разрушен). */
function wsProbe(port, host, origin) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/',
      headers: {
        Host: host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        ...(origin ? { Origin: origin } : {}),
      },
    });
    req.on('upgrade', (res, socket) => {
      done({ upgraded: true, status: res.statusCode });
      socket.destroy();
    });
    req.on('response', (res) => done({ upgraded: false, status: res.statusCode }));
    req.on('error', () => done({ upgraded: false, status: 0 }));
    req.end();
  });
}

// Node-сайт, который: (а) отдаёт JSON с интересующими заголовками запроса,
// (б) проводит WS-рукопожатие только для Origin своего домена.
const ECHO_SERVER = [
  "const http = require('http');",
  "const crypto = require('crypto');",
  "const s = http.createServer((q, r) => {",
  "  r.setHeader('content-type', 'application/json');",
  "  r.end(JSON.stringify({",
  "    auth: q.headers.authorization || null,",
  "    xff: q.headers['x-forwarded-for'] || null,",
  "    xfh: q.headers['x-forwarded-host'] || null,",
  "    xfp: q.headers['x-forwarded-proto'] || null,",
  "  }));",
  "});",
  "s.on('upgrade', (q, sock) => {",
  "  if (q.headers.origin !== 'https://echo3.local') return sock.destroy();",
  "  const accept = crypto.createHash('sha1')",
  "    .update(String(q.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')",
  "    .digest('base64');",
  "  sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');",
  "});",
  "s.listen(Number(process.env.PORT), '127.0.0.1');",
].join('\n');

const ECHO_PKG = JSON.stringify({ name: 'echo', version: '1.0.0', scripts: { start: 'node server.js' } });

/** Поднимает node-сайт-эхо, привязывает домен, ждёт готовности. */
async function uploadEchoSite(t, panel, tmp, domain) {
  const site = await uploadSite(panel, tmp, domain.replace(/\./g, '-'), {
    'package.json': ECHO_PKG,
    'server.js': ECHO_SERVER,
  });
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain });
  await api(panel, 'POST', `/api/sites/${site.id}/start`);
  await sleep(300);
  return site;
}

/* ---------- H-13: заголовки безопасности на трафике сайтов ---------- */

test('H-13: статика и заглушки получают nosniff/X-Frame-Options/Referrer-Policy, заглушки — CSP', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'hdrstatic', { 'index.html': '<h1>ok</h1>' }, false);
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'hdr.local' });
  await api(panel, 'POST', `/api/sites/${site.id}/start`);
  await sleep(300);

  const ok = await fetchWithHost(panel.httpPort, 'hdr.local', '/');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['x-content-type-options'], 'nosniff', 'статики нет nosniff (H-13)');
  assert.equal(ok.headers['x-frame-options'], 'SAMEORIGIN', 'статики нет X-Frame-Options (H-13)');
  assert.equal(ok.headers['referrer-policy'], 'no-referrer');

  const miss = await fetchWithHost(panel.httpPort, 'hdr.local', '/missing.js');
  assert.equal(miss.status, 404);
  assert.equal(miss.headers['x-content-type-options'], 'nosniff');
  assert.ok(miss.headers['content-security-policy'], 'заглушка без CSP (H-13)');
  assert.ok(String(miss.headers['content-security-policy']).includes("default-src 'none'"));

  const nodomain = await fetchWithHost(panel.httpPort, 'nobody.local', '/');
  assert.equal(nodomain.status, 404);
  assert.ok(nodomain.headers['content-security-policy'], 'заглушка «домен не настроен» без CSP (H-13)');
});

/* ---------- H-14: Authorization панели и X-Forwarded-* до upstream ---------- */

test('H-14: учётка панели не доходит до сайта, чужая Authorization и пересобранные X-Forwarded-* доходят', async (t) => {
  const { panel, tmp } = await withPanel(t); // NO_AUTH=1, но учётка сгенерирована и ей можно входить
  const m = /Пароль:\s+(\S+)/.exec(panel.bootLog());
  assert.ok(m, 'сгенерированный пароль не найден в логе панели');
  const panelPassword = m[1];
  await uploadEchoSite(t, panel, tmp, 'echo3.local');

  const b64 = (s) => Buffer.from(s).toString('base64');

  // Basic с учёткой ПАНЕЛИ — удаляется из запроса к сайту (H-14).
  const panelCreds = await requestWithHeaders(panel.httpPort, 'echo3.local', '/', {
    Authorization: 'Basic ' + b64(`admin:${panelPassword}`),
    'X-Forwarded-For': '9.9.9.9',
    'X-Forwarded-Host': 'evil.test',
    'X-Forwarded-Proto': 'https',
  });
  assert.equal(panelCreds.status, 200);
  // Заголовки безопасности проставлены и на проксированном ответе (H-13/H-14:
  // setHeader до proxy.web должен пережить проксирование).
  assert.equal(panelCreds.headers['x-content-type-options'], 'nosniff', 'на ответе прокси нет nosniff');
  const seen = JSON.parse(panelCreds.body.toString('utf8'));
  assert.equal(seen.auth, null, 'учётные данные панели утекли в приложение сайта (H-14)');

  // Чужая Basic (собственная авторизация сайта, например MeshCentral) — проходит.
  const siteCreds = await requestWithHeaders(panel.httpPort, 'echo3.local', '/', {
    Authorization: 'Basic ' + b64('siteuser:sitepass'),
  });
  assert.equal(JSON.parse(siteCreds.body.toString('utf8')).auth, 'Basic ' + b64('siteuser:sitepass'),
    'собственная Basic-авторизация сайта не дошла до приложения');

  // Подделанный X-Forwarded-* отброшен и собран заново из сокета (H-14).
  const xf = await requestWithHeaders(panel.httpPort, 'echo3.local', '/', {
    'X-Forwarded-For': '9.9.9.9',
    'X-Forwarded-Host': 'evil.test',
    'X-Forwarded-Proto': 'https',
  });
  const xfSeen = JSON.parse(xf.body.toString('utf8'));
  // Windows отдаёт IPv6-mapped адрес; важно, что подделка «9.9.9.9» вытеснена
  // реальным адресом сокета (H-14).
  const realIp = String(xfSeen.xff).replace(/^::ffff:/, '');
  assert.equal(realIp, '127.0.0.1', `X-Forwarded-For начинается с подделки: ${xfSeen.xff}`);
  assert.equal(xfSeen.xfh, 'echo3.local', `X-Forwarded-Host не из реестра: ${xfSeen.xfh}`);
  assert.equal(xfSeen.xfp, 'http', 'панель проксирует по http — апстрим должен видеть http');
});

/* ---------- H-21: WebSocket-апгрейд и Origin ---------- */

test('H-21: WS-апгрейд с чужим Origin разрушается, со своим доходит до 101', async (t) => {
  const { panel, tmp } = await withPanel(t);
  await uploadEchoSite(t, panel, tmp, 'echo3.local');

  const ok = await wsProbe(panel.httpPort, 'echo3.local', 'https://echo3.local');
  assert.equal(ok.upgraded, true, `сайт не ответил 101 на валидный апгрейд: ${JSON.stringify(ok)}`);

  const evil = await wsProbe(panel.httpPort, 'echo3.local', 'https://evil.example');
  assert.equal(evil.upgraded, false, 'кросс-сайтовый WS-апгрейд прошёл (H-21)');
});

/* ---------- H-07: доверие X-Forwarded-Proto ---------- */

test('H-07: X-Forwarded-Proto от loopback учитывается, от недоверенного адреса — нет', async (t) => {
  const a = await withPanel(t); // умолчание: loopback доверен
  const site = await uploadSite(a.panel, a.tmp, 'sslredir', { 'index.html': '<h1>ok</h1>' }, false);
  await api(a.panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'sslredir.local' });
  await api(a.panel, 'POST', `/api/sites/${site.id}/ssl/selfsigned`, {});
  await api(a.panel, 'POST', `/api/sites/${site.id}/start`);
  await sleep(300);

  // Без xfp — прямые http-запросы уводятся на https.
  const plain = await fetchWithHost(a.panel.httpPort, 'sslredir.local', '/');
  assert.equal(plain.status, 301, 'редирект на HTTPS пропал');
  assert.ok(String(plain.headers.location).startsWith('https://sslredir.local'));
  // xfp: https от доверенного loopback (за ним nginx) — схема уже https, без редиректа.
  const xf = await requestWithHeaders(a.panel.httpPort, 'sslredir.local', '/', { 'X-Forwarded-Proto': 'https' });
  assert.equal(xf.status, 200, 'доверенный X-Forwarded-Proto не учтён');

  // HSTS в админке: от loopback xfp https включает HSTS.
  const hsts = await requestWithHeaders(a.panel.adminPort, '127.0.0.1', '/api/system', {
    'X-Forwarded-Proto': 'https',
  });
  assert.ok(hsts.headers['strict-transport-security'], 'HSTS не включён за доверенным прокси');
});

test('H-07: PANEL_TRUST_PROXY заменяет умолчание — loopback больше не доверенный', async (t) => {
  const b = await withPanel(t, { PANEL_TRUST_PROXY: '192.0.2.7' });
  const site = await uploadSite(b.panel, b.tmp, 'sslredir2', { 'index.html': '<h1>ok</h1>' }, false);
  await api(b.panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'sslredir2.local' });
  await api(b.panel, 'POST', `/api/sites/${site.id}/ssl/selfsigned`, {});
  await api(b.panel, 'POST', `/api/sites/${site.id}/start`);
  await sleep(300);

  const xf = await requestWithHeaders(b.panel.httpPort, 'sslredir2.local', '/', { 'X-Forwarded-Proto': 'https' });
  assert.equal(xf.status, 301, 'xfp от недоверенного источника погасил редирект (H-07)');

  const hsts = await requestWithHeaders(b.panel.adminPort, '127.0.0.1', '/api/system', {
    'X-Forwarded-Proto': 'https',
  });
  assert.ok(!hsts.headers['strict-transport-security'], 'HSTS включён по недоверенному xfp (H-07)');
});

/* ---------- H-08: ETag/Last-Modified/304 и gzip ---------- */

test('H-08: статика отдаёт ETag/Last-Modified, отвечает 304 и жмёт gzip', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const bigCss = 'body{margin:0}\n' + '/* padding */ '.repeat(400); // > 1 КБ, сжимаемый тип
  const site = await uploadSite(panel, tmp, 'cached', { 'index.html': '<h1>ok</h1>', 'style.css': bigCss }, false);
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'cached.local' });
  await api(panel, 'POST', `/api/sites/${site.id}/start`);
  await sleep(300);

  const first = await requestWithHeaders(panel.httpPort, 'cached.local', '/style.css');
  assert.equal(first.status, 200);
  assert.ok(first.headers.etag, 'нет ETag (H-08)');
  assert.ok(first.headers['last-modified'], 'нет Last-Modified (H-08)');
  assert.ok(!first.headers['content-encoding'], 'без Accept-Encoding ответ не должен сжиматься');
  assert.equal(first.headers['content-length'], String(Buffer.byteLength(bigCss)));

  const second = await requestWithHeaders(panel.httpPort, 'cached.local', '/style.css', {
    'If-None-Match': first.headers.etag,
  });
  assert.equal(second.status, 304, `If-None-Match не дал 304`);
  assert.equal(second.body.length, 0, '304 с телом');

  const ims = await requestWithHeaders(panel.httpPort, 'cached.local', '/style.css', {
    'If-Modified-Since': new Date(Date.now() + 60000).toUTCString(),
  });
  assert.equal(ims.status, 304, 'If-Modified-Since не дал 304');

  const gz = await requestWithHeaders(panel.httpPort, 'cached.local', '/style.css', {
    'Accept-Encoding': 'gzip',
  });
  assert.equal(gz.headers['content-encoding'], 'gzip', 'текстовый ассет не сжат (H-08)');
  assert.equal(gz.headers.vary, 'Accept-Encoding');
  assert.equal(zlib.gunzipSync(gz.body).toString('utf8'), bigCss, 'контент после распаковки не совпал');

  // HTML (no-cache) тоже отдаёт ETag — 304 работает и для него.
  const html = await requestWithHeaders(panel.httpPort, 'cached.local', '/');
  assert.ok(html.headers.etag);
});

/* ---------- H-03: файловый менеджер и симлинки ---------- */

test('H-03: симлинк наружу не читается и не перезаписывается файловым менеджером', async (t) => {
  if (process.platform === 'win32') return t.skip('симлинки проверяются на POSIX');
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'fmsymlink', { 'index.html': '<h1>ok</h1>', 'real.txt': 'REAL' }, false);
  const secret = path.join(panel.dataDir, 'secret.txt');
  fs.writeFileSync(secret, 'TOP-SECRET-VALUE');
  const siteDir = path.join(panel.dataDir, 'sites', site.id);
  fs.symlinkSync(secret, path.join(siteDir, 'leak.txt'));
  fs.symlinkSync(path.join(siteDir, 'real.txt'), path.join(siteDir, 'alias.txt'));

  // Чтение симлинка наружу — отказ (раньше возвращалось содержимое секрета).
  const read = await api(panel, 'GET', `/api/sites/${site.id}/file?path=leak.txt`);
  assert.equal(read.status, 400, `симлинк наружу прочитан: ${JSON.stringify(read.data)}`);
  assert.ok(!JSON.stringify(read.data).includes('TOP-SECRET-VALUE'), 'содержимое секрета утекло');

  // Запись через симлинк наружу — отказ (раньше перезаписывался чужой файл).
  const write = await api(panel, 'PUT', `/api/sites/${site.id}/file`, { path: 'leak.txt', content: 'pwned' });
  assert.equal(write.status, 400, `симлинк наружу перезаписан: ${JSON.stringify(write.data)}`);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'TOP-SECRET-VALUE', 'секрет на диске изменён');

  // Симлинк внутри каталога продолжает работать.
  const alias = await api(panel, 'GET', `/api/sites/${site.id}/file?path=alias.txt`);
  assert.equal(alias.status, 200, 'симлинк внутрь каталога сломан');
  assert.equal(alias.data.content, 'REAL');

  // Обычные файлы пишутся как прежде.
  const put = await api(panel, 'PUT', `/api/sites/${site.id}/file`, { path: 'real.txt', content: 'UPDATED' });
  assert.equal(put.status, 200, `обычная запись сломалась: ${JSON.stringify(put.data)}`);
});

/* ---------- A-02: токен Telegram не покидает сервер ---------- */

test('A-02: токен не возвращается API, маска и пустота не затирают его, reset стирает', async (t) => {
  const { panel } = await withPanel(t);

  const put1 = await api(panel, 'PUT', '/api/settings', {
    alerts: { telegramToken: 'secret-token-abcd1234', telegramChatId: '42' },
  });
  assert.equal(put1.status, 200);

  const got1 = await api(panel, 'GET', '/api/settings');
  assert.ok(!got1.text.includes('secret-token'), 'токен вернулся в ответе API (A-02)');
  assert.equal(got1.data.alerts.telegramTokenSet, true);
  assert.equal(got1.data.alerts.telegramTokenHint, '***1234', `подсказка: ${got1.data.alerts.telegramTokenHint}`);

  // Форма, не трогавшая токен, отправляет маску или пустоту — токен сохраняется.
  await api(panel, 'PUT', '/api/settings', { alerts: { telegramToken: '***1234', telegramChatId: '42' } });
  await api(panel, 'PUT', '/api/settings', { alerts: { telegramToken: '', telegramChatId: '42' } });
  const got2 = await api(panel, 'GET', '/api/settings');
  assert.equal(got2.data.alerts.telegramTokenSet, true, 'маска/пустота затёрли токен');
  assert.equal(got2.data.alerts.telegramTokenHint, '***1234');

  // Новый токен заменяет прежний.
  await api(panel, 'PUT', '/api/settings', { alerts: { telegramToken: 'fresh-token-9999' } });
  const got3 = await api(panel, 'GET', '/api/settings');
  assert.equal(got3.data.alerts.telegramTokenHint, '***9999');

  // Явный reset стирает.
  await api(panel, 'PUT', '/api/settings', { alerts: { telegramTokenReset: true } });
  const got4 = await api(panel, 'GET', '/api/settings');
  assert.equal(got4.data.alerts.telegramTokenSet, false);
  assert.equal(got4.data.alerts.telegramTokenHint, '');
});

/* ---------- A-03: CSRF ---------- */

test('A-03: кросс-сайтовые Origin/Referer/Sec-Fetch-Site отклоняются, свой Origin проходит', async (t) => {
  const { panel } = await withPanel(t);
  const payload = { password: 'short' }; // короткий пароль: после CSRF-барьера маршрут даст 400

  // Все запросы идут через api() с валидным X-Requested-With — так проверяется
  // именно второй барьер (Origin/Referer/Sec-Fetch-Site), а не первый.
  const evilOrigin = await api(panel, 'POST', '/api/password', payload, { Origin: 'https://evil.example' });
  assert.equal(evilOrigin.status, 403, 'POST с чужим Origin прошёл (A-03)');

  const evilReferer = await api(panel, 'POST', '/api/password', payload, { Referer: 'https://evil.example/form' });
  assert.equal(evilReferer.status, 403, 'POST с чужим Referer прошёл (A-03)');

  const crossSite = await api(panel, 'POST', '/api/password', payload, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403, 'Sec-Fetch-Site: cross-site прошёл (A-03)');

  // Свой Origin (то, что шлёт браузер на той же панели) — CSRF-барьер пройден,
  // дальше работает валидация маршрута (400 на короткий пароль).
  const sameOrigin = await api(panel, 'POST', '/api/password', payload, { Origin: panel.base });
  assert.equal(sameOrigin.status, 400, `свой Origin отклонён: ${sameOrigin.status}`);

  // Без Origin/Referer (curl, тесты) — достаточно X-Requested-With.
  const noOrigin = await api(panel, 'POST', '/api/password', payload);
  assert.equal(noOrigin.status, 400);
});

/* ---------- A-05: смена пароля оставляет след в журнале ---------- */

test('A-05: успешная смена пароля пишется в журнал панели (без пароля в тексте)', async (t) => {
  const { panel } = await withPanel(t);
  const res = await api(panel, 'POST', '/api/password', { password: 'LongEnoughPass1' });
  assert.equal(res.status, 200);
  await sleep(200);
  const log = panel.bootLog();
  assert.ok(log.includes('[auth] пароль изменён'), 'смена пароля не отражена в журнале');
  assert.ok(!log.includes('LongEnoughPass1'), 'пароль попал в журнал');
});

/* ---------- H-17: пропажа fullchain.pem не роняет панель ---------- */

test('H-17: без fullchain.pem панель стартует и перегенерирует сертификат', async (t) => {
  const { panel } = await withPanel(t, {}, {
    prepare: (dataDir) => {
      const dir = path.join(dataDir, 'certs', '_default');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'privkey.pem'), 'not-a-real-key-but-present');
      // fullchain.pem отсутствует: раньше ensureDefaultCert считал всё хорошим,
      // и процесс падал ENOENT при создании https-сервера (H-17).
    },
  });
  const crt = path.join(panel.dataDir, 'certs', '_default', 'fullchain.pem');
  assert.ok(fs.existsSync(crt), 'fullchain.pem не перегенерирован');
  assert.ok(fs.readFileSync(crt, 'utf8').includes('BEGIN CERTIFICATE'), 'сертификат не похож на PEM');
});

/* ---------- H-19: валидация domains в /ssl/issue ---------- */

test('H-19: /ssl/issue отклоняет невалидные domains, не трогая ssl сайта', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'sslissue', { 'index.html': '<h1>ok</h1>' }, false);
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'sslissue.local' });

  const bad = await api(panel, 'POST', `/api/sites/${site.id}/ssl/issue`, { domains: ['sslissue.local', 'not a domain!'] });
  assert.equal(bad.status, 400, `невалидный domains принят: ${JSON.stringify(bad.data)}`);

  const notArray = await api(panel, 'POST', `/api/sites/${site.id}/ssl/issue`, { domains: 'sslissue.local' });
  assert.equal(notArray.status, 400, 'строка в domains принята');

  const after = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.equal(after.data.ssl.status, 'none', 'неудачный выпуск изменил ssl сайта');
});

/* ---------- H-20: маска режимов из архива ---------- */

test('H-20: файл из архива с режимом 0777 распаковывается как 0755', async (t) => {
  if (process.platform === 'win32') return t.skip('права проверяются на POSIX');
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'modes', { 'index.html': '<h1>ok</h1>' }, false);
  const siteDir = path.join(panel.dataDir, 'sites', site.id);

  // Архив собираем напрямую adm-zip'ом: addLocalFile читает режим из fs,
  // поэтому права выставляем ДО упаковки (makeZip создаёт файлы заново).
  const srcDir = path.join(tmp, 'modes-zip');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'run.sh'), '#!/bin/sh\necho hi\n');
  fs.writeFileSync(path.join(srcDir, 'note.txt'), 'note');
  fs.chmodSync(path.join(srcDir, 'run.sh'), 0o777);
  fs.chmodSync(path.join(srcDir, 'note.txt'), 0o666);
  const AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip'));
  const zip = new AdmZip();
  zip.addLocalFile(path.join(srcDir, 'run.sh'), '');
  zip.addLocalFile(path.join(srcDir, 'note.txt'), '');
  const zipPath = path.join(tmp, 'modes.zip');
  zip.writeZip(zipPath);

  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zipPath)]), 'modes.zip');
  form.append('path', '/');
  form.append('name', 'modes.zip');
  form.append('extract', '1');
  form.append('confirm', '1');
  const res = await fetch(`${panel.base}/api/sites/${site.id}/files/upload`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const data = await res.json();
  assert.equal(res.status, 200, `распаковка не удалась: ${JSON.stringify(data)}`);
  assert.equal(data.extracted, true);

  const runMode = fs.statSync(path.join(siteDir, 'run.sh')).mode & 0o777;
  assert.equal(runMode, 0o755, `режим 0777 применился как есть: ${runMode.toString(8)} (H-20)`);
  const noteMode = fs.statSync(path.join(siteDir, 'note.txt')).mode & 0o777;
  assert.equal(noteMode, 0o644, `запись для всех осталась: ${noteMode.toString(8)}`);
  // executable-бит владельца сохранён (иначе ломаются ./scripts/start.sh из архивов).
  assert.ok(runMode & 0o100, 'потерян executable-бит');
});
