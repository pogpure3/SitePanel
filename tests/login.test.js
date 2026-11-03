'use strict';

// Страница входа (/login) и сессии в cookie: доступ, редиректы, флаги cookie,
// выход, инвалидация сессий сменой пароля, общий антибрутфорс с Basic.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');

const { startPanel, api, apiRaw } = require('./helpers/panel');
const { hashPassword } = require('../src/auth');

const LOGIN_USER = 'admin';
const LOGIN_PASS = 'login-test-pass-123';

/** Панель с включённой авторизацией и известными учётными данными. */
async function withAuthPanel(t, env = {}) {
  const panel = await startPanel(
    { ...env, PANEL_NO_AUTH: '' },
    {
      // opts.auth — лишь запись для теста; настоящие учётные данные кладём
      // своим auth.json через prepare() (иначе панель сгенерирует случайный пароль).
      prepare: (dir) => {
        fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
          user: LOGIN_USER,
          ...hashPassword(LOGIN_PASS),
        }));
      },
      auth: { user: LOGIN_USER, password: LOGIN_PASS },
    },
  );
  t.after(async () => { await panel.stop(); });
  return panel;
}

function basicAuth(panel) {
  return 'Basic ' + Buffer.from(`${panel.auth.user}:${panel.auth.password}`).toString('base64');
}

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie') || '';
  const pair = raw.split(';')[0];
  return { raw, pair, value: pair.split('=')[1] || '' };
}

/** Минимальный локальный SMTP для сквозной проверки без внешней почты. */
async function smtpCapture(t) {
  let resolveMessage;
  const message = new Promise((resolve) => { resolveMessage = resolve; });
  const server = net.createServer((socket) => {
    let buffer = '';
    let dataMode = false;
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (dataMode) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          resolveMessage(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          dataMode = false;
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^EHLO /i.test(line)) socket.write('250-localhost\r\n250 PIPELINING\r\n');
        else if (/^DATA$/i.test(line)) {
          dataMode = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (/^QUIT$/i.test(line)) {
          socket.end('221 Bye\r\n');
          return;
        } else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, message };
}

test('страница /login доступна без пароля, интерфейс — нет', async (t) => {
  const panel = await withAuthPanel(t);

  const page = await fetch(panel.base + '/login', {
    headers: { Accept: 'text/html' },
    redirect: 'manual',
  });
  assert.equal(page.status, 200, '/login должен отдаваться без пароля');
  const html = await page.text();
  assert.match(html, /Вход в панель управления/, 'это не страница входа');
  assert.match(html, /Забыли пароль\?/, 'на странице входа нет сброса пароля');
  assert.match(html, /id="resetConfirm"/, 'на странице входа нет формы нового пароля');
  assert.ok(!html.includes('id="app"'), 'страница входа не должна содержать разметку панели');

  // Скрипт формы тоже должен отдаваться без пароля, иначе страница мертва.
  const script = await fetch(panel.base + '/login.js');
  assert.equal(script.status, 200, 'login.js не отдался без авторизации — форма не работает');
  const loginScript = await script.text();
  assert.match(loginScript, /\/api\/login/, 'в login.js нет обработчика формы');
  assert.match(loginScript, /\/api\/password-reset\/request/, 'в login.js нет запроса сброса');

  for (const p of ['/', '/app.js', '/style.css']) {
    const res = await fetch(panel.base + p, { headers: { Accept: 'text/html' }, redirect: 'manual' });
    // Браузерная навигация уходит на /login вместо родного диалога Basic.
    assert.equal(res.status, 302, `${p} с Accept: text/html должен редиректить, получено ${res.status}`);
    assert.match(res.headers.get('location') || '', /^\/login\?next=/, `${p}: неожиданный Location`);
  }

  // Контракт tests/auth.test.js: не-браузерные клиенты (curl, API) получают
  // прежние 401 + WWW-Authenticate.
  const apiRes = await fetch(panel.base + '/api/system');
  assert.equal(apiRes.status, 401);
  assert.ok((apiRes.headers.get('www-authenticate') || '').includes('Basic'));
});

test('успешный вход выдаёт HttpOnly-cookie, сессия работает', async (t) => {
  const panel = await withAuthPanel(t);

  const res = await api(panel, 'POST', '/api/login', { user: LOGIN_USER, password: LOGIN_PASS });
  assert.equal(res.status, 200, `вход не удался: ${res.text}`);
  assert.equal(res.data.ok, true);

  const { raw, value } = cookieFrom(res);
  assert.match(raw, /HttpOnly/i, 'cookie сессии без HttpOnly — читаема из JS');
  assert.match(raw, /SameSite=Lax/i, 'cookie сессии без SameSite');
  assert.match(raw, /Path=\//, 'cookie сессии без Path');
  assert.match(value, /^[0-9a-f]{48}$/, 'токен сессии — 48 hex-символов');
  // HTTP без TLS — Secure флага быть не должно (за nginx он ставится).
  assert.doesNotMatch(raw, /Secure/i, 'Secure на http-запросе не нужен');

  // Сессионная cookie авторизует и страницы, и API — без Basic.
  const page = await fetch(panel.base + '/', {
    headers: { Accept: 'text/html', Cookie: `sp_session=${value}` },
    redirect: 'manual',
  });
  assert.equal(page.status, 200, 'страница панели не открылась по сессии');
  const sys = await fetch(panel.base + '/api/system', { headers: { Cookie: `sp_session=${value}` } });
  assert.equal(sys.status, 200, '/api/system не открылся по сессии');

  // Битый/чужой токен не пускает.
  const bad = await fetch(panel.base + '/api/system', { headers: { Cookie: 'sp_session=' + 'a'.repeat(48) } });
  assert.equal(bad.status, 401, 'выдуманный токен сессии должен отклоняться');
});

test('неверный пароль даёт 401 и понятную ошибку', async (t) => {
  const panel = await withAuthPanel(t);
  const res = await api(panel, 'POST', '/api/login', { user: LOGIN_USER, password: require('crypto').randomBytes(10).toString('hex') });
  assert.equal(res.status, 401);
  assert.match(res.data.error, /Неверный логин или пароль/);
  assert.ok(!res.headers.get('set-cookie'), 'при неудаче cookie сессии выдаваться не должно');
});

test('сброс пароля отправляет одноразовую ссылку на почту по умолчанию', async (t) => {
  const smtp = await smtpCapture(t);
  const panel = await withAuthPanel(t, {
    PANEL_PUBLIC_URL: 'https://panel.example',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'SitePanel <no-reply@example.com>',
  });

  const requested = await api(panel, 'POST', '/api/password-reset/request', {});
  assert.equal(requested.status, 202, requested.text);
  const repeated = await api(panel, 'POST', '/api/password-reset/request', {});
  assert.equal(repeated.status, 429, 'повторный запрос не ограничен');
  assert.ok(repeated.headers.get('retry-after'), 'ограничение без Retry-After');
  const rawMail = await smtp.message;
  const rawBody = rawMail.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  const decodedBody = /Content-Transfer-Encoding:\s*base64/i.test(rawMail)
    ? Buffer.from(rawBody.replace(/\s/g, ''), 'base64').toString('utf8')
    : rawBody.replace(/=\r\n/g, '').replace(/=3D/gi, '=');
  const mail = rawMail + '\n' + decodedBody;
  assert.match(mail, /To: pogpure3@gmail\.com/i, 'письмо ушло не на адрес по умолчанию');
  const tokenMatch = /#reset=([0-9a-f]{64})/i.exec(mail);
  assert.ok(tokenMatch, 'в письме нет токена сброса');
  const token = tokenMatch[1].toLowerCase();

  // Чужой запрос не должен погасить действующую ссылку.
  const malformed = await api(panel, 'POST', '/api/password-reset/confirm', { token: 'bad', password: 'new-password-123' });
  assert.equal(malformed.status, 400);

  const changed = await api(panel, 'POST', '/api/password-reset/confirm', { token, password: 'new-password-123' });
  assert.equal(changed.status, 200, changed.text);
  const reused = await api(panel, 'POST', '/api/password-reset/confirm', { token, password: 'another-password-123' });
  assert.equal(reused.status, 400, 'одноразовый токен применился повторно');

  const oldLogin = await api(panel, 'POST', '/api/login', { user: LOGIN_USER, password: LOGIN_PASS });
  assert.equal(oldLogin.status, 401, 'старый пароль продолжает работать');
  const newLogin = await api(panel, 'POST', '/api/login', { user: LOGIN_USER, password: 'new-password-123' });
  assert.equal(newLogin.status, 200, 'новый пароль не работает');
});

test('сброс пароля без SMTP не выдаёт токен и сообщает о настройке', async (t) => {
  const panel = await withAuthPanel(t, { PANEL_PUBLIC_URL: 'https://panel.example' });
  const res = await api(panel, 'POST', '/api/password-reset/request', {});
  assert.equal(res.status, 503);
  assert.match(res.data.error, /не настроен/i);
});

test('без CSRF-заголовка вход отклоняется (login CSRF)', async (t) => {
  const panel = await withAuthPanel(t);
  const res = await apiRaw(panel, 'POST', '/api/login', { user: LOGIN_USER, password: LOGIN_PASS });
  assert.equal(res.status, 403, 'POST /api/login без X-Requested-With должен отклоняться');
  const requestReset = await apiRaw(panel, 'POST', '/api/password-reset/request', {});
  assert.equal(requestReset.status, 403, 'запрос сброса без X-Requested-With должен отклоняться');
  const confirmReset = await apiRaw(panel, 'POST', '/api/password-reset/confirm', {});
  assert.equal(confirmReset.status, 403, 'подтверждение сброса без X-Requested-With должно отклоняться');
});

test('выход гасит сессию', async (t) => {
  const panel = await withAuthPanel(t);
  const loginRes = await api(panel, 'POST', '/api/login', { user: LOGIN_USER, password: LOGIN_PASS });
  const { value } = cookieFrom(loginRes);

  const out = await api(panel, 'POST', '/api/logout', {}, { Cookie: `sp_session=${value}` });
  assert.equal(out.status, 200);
  const cleared = out.headers.get('set-cookie') || '';
  assert.match(cleared, /Max-Age=0/, 'выход должен сбрасывать cookie');

  const after = await fetch(panel.base + '/api/system', { headers: { Cookie: `sp_session=${value}` } });
  assert.equal(after.status, 401, 'сессия продолжает работать после выхода');
});

test('смена пароля гасит все активные сессии', async (t) => {
  const panel = await withAuthPanel(t);
  const loginRes = await api(panel, 'POST', '/api/login', { user: LOGIN_USER, password: LOGIN_PASS });
  const { value } = cookieFrom(loginRes);

  const newPassword = require('crypto').randomBytes(12).toString('hex');
  const changed = await api(panel, 'POST', '/api/password',
    { user: LOGIN_USER, password: newPassword }, { Authorization: basicAuth(panel) });
  assert.equal(changed.status, 200, `смена пароля не удалась: ${changed.text}`);

  const after = await fetch(panel.base + '/api/system', { headers: { Cookie: `sp_session=${value}` } });
  assert.equal(after.status, 401, 'сессия пережила смену пароля');

  // Возвращаем пароль: остальные тесты не зависят от panel.auth, но аккуратность дёшево.
  const back = await api(panel, 'POST', '/api/password',
    { user: LOGIN_USER, password: LOGIN_PASS },
    { Authorization: 'Basic ' + Buffer.from(`${LOGIN_USER}:${newPassword}`).toString('base64') });
  assert.equal(back.status, 200);
});

test('антибрутфорс общий для формы и Basic: блокировка по IP', async (t) => {
  const panel = await withAuthPanel(t, { PANEL_LOGIN_MAX_FAILS: '3', PANEL_LOGIN_FAIL_DELAY_MS: '0' });

  for (let i = 0; i < 3; i++) {
    const res = await api(panel, 'POST', '/api/login', { user: LOGIN_USER, password: 'nope-' + i });
    assert.equal(res.status, 401, `попытка ${i + 1}: ожидался 401`);
  }
  // Окно исчерпано — и форма, и Basic с ВЕРНЫМ паролем получают блокировку.
  // Форма отвечает 429; Basic исторически 401 с Retry-After (контракт auth-тестов).
  const form = await api(panel, 'POST', '/api/login', { user: LOGIN_USER, password: LOGIN_PASS });
  assert.equal(form.status, 429, 'форма входа не заблокирована после исчерпания попыток');
  const basic = await fetch(panel.base + '/api/system', { headers: { Authorization: basicAuth(panel) } });
  assert.equal(basic.status, 401, 'Basic не заблокирован после исчерпания попыток формы');
  assert.ok(basic.headers.get('retry-after'), 'Basic-блокировка без Retry-After');
});

test('уже вошедшего /login уводит в панель, кривой next — нет', async (t) => {
  const panel = await withAuthPanel(t);
  const loginRes = await api(panel, 'POST', '/api/login', { user: LOGIN_USER, password: LOGIN_PASS });
  const { value } = cookieFrom(loginRes);

  const home = await fetch(panel.base + '/login?next=%2F%23%2Fsites', {
    headers: { Accept: 'text/html', Cookie: `sp_session=${value}` },
    redirect: 'manual',
  });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/#/sites', 'не вернулся на next');

  // //evil.com и \-пути наружу не пускаем.
  for (const bad of ['%2F%2Fevil.example', '%5Cevil', 'https://evil.example']) {
    const r = await fetch(panel.base + '/login?next=' + bad, {
      headers: { Accept: 'text/html', Cookie: `sp_session=${value}` },
      redirect: 'manual',
    });
    const loc = r.headers.get('location') || '';
    assert.ok(!loc.includes('evil'), `next=${bad} пропустил наружу: ${loc}`);
  }
});
