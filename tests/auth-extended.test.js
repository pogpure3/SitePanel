'use strict';

// Регрессия SP-03 / A-01 / H-11 / H-12: учётные данные админки.
//
//   SP-03  битый auth.json молча генерировал новый пароль и затирал файл;
//   A-01   scrypt вызывался синхронно на каждый запрос и блокировал прокси сайтов;
//   H-11   кривой заголовок Basic (без ':') давал 500 со стеком вместо 401;
//   H-12   нестроковый user в POST /api/password навсегда ломал вход.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startPanel, sleep } = require('./helpers/panel');

/* ---------- Чистые функции (без запуска панели) ---------- */

test('parseBasic: кривой заголовок не превращается в исключение', () => {
  const auth = require('../src/auth');
  // Без ':' раньше split давал pass === undefined → scryptSync бросал TypeError.
  assert.equal(auth.parseBasic('Basic ' + Buffer.from('admin').toString('base64')), null);
  assert.equal(auth.parseBasic('Basic !!!notb64!!!'), null);
  assert.equal(auth.parseBasic(''), null);
  assert.equal(auth.parseBasic(undefined), null);
  assert.equal(auth.parseBasic('Bearer token'), null);

  const ok = auth.parseBasic('Basic ' + Buffer.from('admin:secret').toString('base64'));
  assert.deepEqual(ok, { user: 'admin', pass: 'secret' });
});

test('parseBasic: пароль, содержащий двоеточие, не усекается', () => {
  const auth = require('../src/auth');
  const parsed = auth.parseBasic('Basic ' + Buffer.from('admin:a:b:c').toString('base64'));
  assert.equal(parsed.user, 'admin');
  assert.equal(parsed.pass, 'a:b:c', 'полезе в scrypt должна уйти вся строка после первого ":"');
});

test('checkCredentials: нестроковые аргументы не роняют проверку', async () => {
  const auth = require('../src/auth');
  assert.equal(await auth.checkCredentials(undefined, undefined), false);
  assert.equal(await auth.checkCredentials({ evil: true }, 'password'), false);
  assert.equal(await auth.checkCredentials('admin', null), false);
});

test('hashPassword: асинхронный и синхронный варианты совпадают', async () => {
  const auth = require('../src/auth');
  const sync = auth.hashPassword('Пароль:С:Двоеточием', 'salt123');
  const async_ = await auth.hashPasswordAsync('Пароль:С:Двоеточием', 'salt123');
  assert.equal(async_.hash, sync.hash, 'результат не должен зависеть от способа вычисления');
  assert.equal(async_.salt, sync.salt);
});

/* ---------- Аварийный старт с битым auth.json (SP-03) ---------- */

test('SP-03: битый auth.json — панель не стартует и не затирает файл', async (t) => {
  let dataDir = null;
  const broken = '{ "user": "admin", "hash": 12345';
  const res = await startPanel(
    { PANEL_NO_AUTH: '' },
    {
      expectExit: true,
      prepare: (dir) => {
        dataDir = dir;
        fs.writeFileSync(path.join(dir, 'auth.json'), broken);
      },
    }
  );

  assert.notEqual(res.exitCode, 0, 'панель обязана завершиться с ошибкой, а не подняться с новым паролем');
  assert.match(res.output, /auth\.json/);
  assert.match(res.output, /не разбирается как JSON/);
  // Главное: новый пароль НЕ выдан, файл сохранён как .corrupt-*.
  assert.ok(!/Пароль:/.test(res.output), `панель напечатала новый пароль вместо аварии:\n${res.output}`);
  t.diagnostic(`аварийный старт: exit=${res.exitCode}`);
});

test('SP-03: auth.json без корректных полей тоже авария, а не новый пароль', async () => {
  const res = await startPanel(
    { PANEL_NO_AUTH: '' },
    {
      expectExit: true,
      prepare: (dir) => {
        // Валидный JSON, но user — объект (последствие H-12).
        fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ user: { evil: true }, salt: 'x', hash: 'ab' }));
      },
    }
  );
  assert.notEqual(res.exitCode, 0);
  assert.match(res.output, /user\/hash/);
  assert.ok(!/Пароль:/.test(res.output));
});

test('SP-03: отсутствие auth.json — нормальный первый запуск с новым паролем', async (t) => {
  const panel = await startPanel({ PANEL_NO_AUTH: '' });
  t.after(async () => { await panel.stop(); });
  assert.ok(panel.auth && panel.auth.password, 'пароль первого запуска должен быть выдан');
  const authFile = path.join(panel.dataDir, 'auth.json');
  assert.ok(fs.existsSync(authFile));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(authFile).mode & 0o777, 0o600, 'auth.json приватный');
  }
});

/* ---------- Совместимость параметров scrypt (блокер выкладки этапа 1) ---------- */
//
// Параметры scrypt были подняты с дефолтных N=16384 до N=32768. Хеш, посчитанный
// по одним параметрам, не совпадает с хешем по другим, поэтому панель обязана
// помнить, с какими параметрами считался хеш в файле. Иначе обновление панели на
// существующем стенде отсекало вход при верном пароле, а понять причину по логу
// было нельзя (сообщение было бы «неверный пароль»).

/** Хеш так, как его писал релиз 1.0.1: без params и с дефолтными параметрами. */
function legacyAuthFile(user, password) {
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return JSON.stringify({ user, salt, hash }, null, 2);
}

test('scrypt: файл релиза 1.0.1 (без params) принимает верный пароль', async (t) => {
  const password = 'LegacyPass-123';
  const panel = await startPanel(
    { PANEL_NO_AUTH: '' },
    {
      auth: { user: 'admin', password },
      prepare: (dir) => fs.writeFileSync(path.join(dir, 'auth.json'), legacyAuthFile('admin', password)),
    }
  );
  t.after(async () => { await panel.stop(); });

  const res = await fetch(panel.base + '/api/system', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${panel.auth.user}:${panel.auth.password}`).toString('base64'), 'X-Requested-With': 'XMLHttpRequest' },
  });
  assert.equal(res.status, 200, 'вход по паролю из файла прежнего формата обязан работать');
  t.diagnostic('старый auth.json: 200');
});

test('scrypt: после успешного входа файл получает params и обновлённый хеш', async (t) => {
  const password = 'LegacyPass-123';
  const panel = await startPanel(
    { PANEL_NO_AUTH: '' },
    {
      auth: { user: 'admin', password },
      prepare: (dir) => fs.writeFileSync(path.join(dir, 'auth.json'), legacyAuthFile('admin', password)),
    }
  );
  t.after(async () => { await panel.stop(); });
  const authFile = path.join(panel.dataDir, 'auth.json');
  const before = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  assert.equal(before.params, undefined, 'исходный файл — без params');
  assert.equal(before.user, 'admin');

  const res = await fetch(panel.base + '/api/system', {
    headers: { Authorization: 'Basic ' + Buffer.from(`admin:${password}`).toString('base64'), 'X-Requested-With': 'XMLHttpRequest' },
  });
  assert.equal(res.status, 200);

  const after = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  assert.equal(after.params && after.params.N, 32768, 'хеш обязан быть пересчитан на текущих параметрах');
  assert.notEqual(after.hash, before.hash, 'хеш обязан измениться вместе с параметрами');
  assert.equal(after.user, 'admin');
  assert.equal(after.salt, before.salt, 'соль сохраняется: менять её при апгрейде незачем');
  t.diagnostic(`params после входа: ${JSON.stringify(after.params)}`);
});

test('scrypt: неверный пароль к файлу прежнего формата отвергается, файл не трогается', async (t) => {
  const panel = await startPanel(
    { PANEL_NO_AUTH: '' },
    {
      auth: { user: 'admin', password: 'LegacyPass-123' },
      prepare: (dir) => fs.writeFileSync(path.join(dir, 'auth.json'), legacyAuthFile('admin', 'LegacyPass-123')),
    }
  );
  t.after(async () => { await panel.stop(); });
  const authFile = path.join(panel.dataDir, 'auth.json');
  const before = fs.readFileSync(authFile, 'utf8');

  const res = await fetch(panel.base + '/api/system', {
    headers: { Authorization: 'Basic ' + Buffer.from('admin:WrongPass-999').toString('base64'), 'X-Requested-With': 'XMLHttpRequest' },
  });
  assert.equal(res.status, 401);
  // Апгрейд разрешён только после успешной проверки: иначе неудачный вход
  // переписывал бы файл и подменял хеш, ничего не зная о пароле.
  assert.equal(fs.readFileSync(authFile, 'utf8'), before, 'неудачный вход не должен переписывать auth.json');
});

test('scrypt: недоверенные params (огромный N) игнорируются — отказа в обслуживании нет', async (t) => {
  const password = 'LegacyPass-123';
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex'); // посчитан по N=16384
  const panel = await startPanel(
    { PANEL_NO_AUTH: '' },
    {
      auth: { user: 'admin', password },
      // Файл испорчен или подделан: N вчетверо больше нашего. Если бы параметры
      // брались из файла как есть, каждый вход стоил бы ~4× scrypt и служил бы
      // усилителем отказа в обслуживании.
      prepare: (dir) =>
        fs.writeFileSync(
          path.join(dir, 'auth.json'),
          JSON.stringify({ user: 'admin', salt, hash, params: { N: 1048576, r: 8, p: 1 } }, null, 2)
        ),
    }
  );
  t.after(async () => { await panel.stop(); });

  const started = Date.now();
  const res = await fetch(panel.base + '/api/system', {
    headers: { Authorization: 'Basic ' + Buffer.from(`admin:${password}`).toString('base64'), 'X-Requested-With': 'XMLHttpRequest' },
  });
  const took = Date.now() - started;
  assert.equal(res.status, 200, 'вход обязан работать по прежним параметрам, а не падать');
  assert.ok(took < 10000, `вход занял ${took} мс — недоверенный N=1048576 не должен исполняться`);
  assert.match(panel.bootLog(), /некорректные params/, 'о подменённых параметрах должно быть сказано в логе');
  t.diagnostic(`вход с подменённым N: ${res.status} за ${took} мс`);
});

/* ---------- HTTP-поведение (H-11, H-12, A-01) ---------- */

test('H-11: Basic без двоеточия → 401, а не 500', async (t) => {
  const panel = await startPanel({ PANEL_NO_AUTH: '' });
  t.after(async () => { await panel.stop(); });

  for (const raw of [
    'Basic ' + Buffer.from('admin').toString('base64'),
    'Basic ' + Buffer.from('').toString('base64'),
    'Basic !!!not-base64!!!',
    'Basic',
  ]) {
    const res = await fetch(panel.base + '/api/system', {
      headers: { Authorization: raw, 'X-Requested-With': 'XMLHttpRequest' },
    });
    assert.equal(res.status, 401, `заголовок ${JSON.stringify(raw)} дал ${res.status}`);
    const text = await res.text();
    assert.ok(!/at .*\(.*:\d+:\d+\)/.test(text), `в теле ответа стек вызовов: ${text.slice(0, 120)}`);
  }
});

test('H-12: нестроковый user в POST /api/password не ломает вход', async (t) => {
  const panel = await startPanel({ PANEL_NO_AUTH: '' });
  t.after(async () => { await panel.stop(); });
  const basic = 'Basic ' + Buffer.from(`${panel.auth.user}:${panel.auth.password}`).toString('base64');
  const headers = { Authorization: basic, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' };

  const bad = await fetch(panel.base + '/api/password', {
    method: 'POST',
    headers,
    body: JSON.stringify({ user: { evil: true }, password: 'LongEnoughPassword1' }),
  });
  assert.equal(bad.status, 400, 'нестроковый логин обязан быть отклонён');

  // Прежний пароль продолжает работать — вход не сломан.
  const still = await fetch(panel.base + '/api/system', { headers });
  assert.equal(still.status, 200, 'прежний пароль должен остаться рабочим');

  // И в файле не появилось объекта вместо строки.
  const saved = JSON.parse(fs.readFileSync(path.join(panel.dataDir, 'auth.json'), 'utf8'));
  assert.equal(typeof saved.user, 'string', `в auth.json записан ${typeof saved.user}`);
});

test('H-12: пароль с двоеточием работает после смены', async (t) => {
  const panel = await startPanel({ PANEL_NO_AUTH: '' });
  t.after(async () => { await panel.stop(); });
  const headers = {
    Authorization: 'Basic ' + Buffer.from(`${panel.auth.user}:${panel.auth.password}`).toString('base64'),
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
  };
  const password = 'pa:ss:word:42';
  const changed = await fetch(panel.base + '/api/password', {
    method: 'POST',
    headers,
    body: JSON.stringify({ user: 'admin', password }),
  });
  assert.equal(changed.status, 200, JSON.stringify(await changed.clone().json().catch(() => ({}))));

  const withNew = await fetch(panel.base + '/api/system', {
    headers: { ...headers, Authorization: 'Basic ' + Buffer.from(`admin:${password}`).toString('base64') },
  });
  assert.equal(withNew.status, 200, 'пароль с ":" должен проходить проверку целиком');
});

test('H-12: смена пароля без изменения логина сохраняет прежний логин', async (t) => {
  const panel = await startPanel({ PANEL_NO_AUTH: '' });
  t.after(async () => { await panel.stop(); });
  const headers = {
    Authorization: 'Basic ' + Buffer.from(`${panel.auth.user}:${panel.auth.password}`).toString('base64'),
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
  };
  const ok = await fetch(panel.base + '/api/password', {
    method: 'POST',
    headers,
    body: JSON.stringify({ password: 'AnotherLongPassword1' }),
  });
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal(data.user, 'admin');
});

test('H-12: короткий пароль отклоняется', async (t) => {
  const panel = await startPanel({ PANEL_NO_AUTH: '' });
  t.after(async () => { await panel.stop(); });
  const headers = {
    Authorization: 'Basic ' + Buffer.from(`${panel.auth.user}:${panel.auth.password}`).toString('base64'),
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
  };
  for (const password of ['short', 12345678, null]) {
    const res = await fetch(panel.base + '/api/password', {
      method: 'POST',
      headers,
      body: JSON.stringify({ password }),
    });
    assert.equal(res.status, 400, `пароль ${JSON.stringify(password)} должен быть отклонён`);
  }
});

test('A-01: неудачные попытки логируются и включают блокировку', async (t) => {
  const panel = await startPanel({
    PANEL_NO_AUTH: '',
    PANEL_LOGIN_MAX_FAILS: '3',
    PANEL_LOGIN_FAIL_DELAY_MS: '0',
    PANEL_LOGIN_LOCKOUT_MS: '60000',
  });
  t.after(async () => { await panel.stop(); });
  const bad = 'Basic ' + Buffer.from('admin:wrong-password-here').toString('base64');

  for (let i = 0; i < 3; i++) {
    const res = await fetch(panel.base + '/api/system', { headers: { Authorization: bad } });
    assert.equal(res.status, 401, `попытка ${i + 1} должна дать 401`);
  }
  // После исчерпания окна адрес блокируется — даже верный пароль не проходит.
  const good = 'Basic ' + Buffer.from(`${panel.auth.user}:${panel.auth.password}`).toString('base64');
  const locked = await fetch(panel.base + '/api/system', { headers: { Authorization: good } });
  assert.equal(locked.status, 401, 'во время блокировки вход закрыт и для верного пароля');
  assert.ok(locked.headers.get('retry-after'), 'должен быть Retry-After');

  const log = panel.bootLog();
  assert.match(log, /неудачная попытка входа/, `неудачные попытки не логируются:\n${log}`);
  assert.match(log, /вход заблокирован/, 'блокировка должна попадать в лог');
});

test('A-01: успешный вход сбрасывает счётчик неудач', async (t) => {
  const panel = await startPanel({
    PANEL_NO_AUTH: '',
    PANEL_LOGIN_MAX_FAILS: '5',
    PANEL_LOGIN_FAIL_DELAY_MS: '0',
  });
  t.after(async () => { await panel.stop(); });
  const bad = 'Basic ' + Buffer.from('admin:wrong-password-here').toString('base64');
  const good = 'Basic ' + Buffer.from(`${panel.auth.user}:${panel.auth.password}`).toString('base64');

  await fetch(panel.base + '/api/system', { headers: { Authorization: bad } });
  const ok = await fetch(panel.base + '/api/system', { headers: { Authorization: good } });
  assert.equal(ok.status, 200);
  await sleep(50);
  assert.match(panel.bootLog(), /счётчик неудач сброшен/);
});

test('A-01: scrypt асинхронный — параллельные входы не блокируют прокси', async (t) => {
  // Замер: 8 одновременных авторизованных запросов не должны выстраивать
  // последовательную очередь длиннее, чем заметно для сайта на том же loop.
  const panel = await startPanel({ PANEL_NO_AUTH: '' });
  t.after(async () => { await panel.stop(); });
  const headers = { Authorization: 'Basic ' + Buffer.from(`${panel.auth.user}:${panel.auth.password}`).toString('base64') };

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => fetch(panel.base + '/api/system', { headers }))
  );
  const elapsed = Date.now() - started;
  for (const r of results) assert.equal(r.status, 200);
  assert.ok(elapsed < 5000, `8 параллельных входов заняли ${elapsed} мс`);
  t.diagnostic(`8 параллельных авторизованных запросов: ${elapsed} мс`);
});

test('A-06: PANEL_NO_AUTH=1 громко предупреждает в логе', async (t) => {
  const panel = await startPanel({ PANEL_NO_AUTH: '1' });
  t.after(async () => { await panel.stop(); });
  assert.match(panel.bootLog(), /PANEL_NO_AUTH=1.*ОТКЛЮЧЕНА/s, 'нет предупреждения об отключённой авторизации');
});

/* ---------- Кэш успешных проверок (A-01) ---------- */

test('A-01: смена пароля немедленно обесценивает кэш проверки', async (t) => {
  const panel = await startPanel({ PANEL_NO_AUTH: '' });
  t.after(async () => { await panel.stop(); });
  const old = panel.auth.password;
  const basic = (p) => 'Basic ' + Buffer.from(`admin:${p}`).toString('base64');

  // Прогреваем: успешная проверка попадает в кэш.
  assert.equal((await fetch(panel.base + '/api/system', { headers: { Authorization: basic(old) } })).status, 200);

  const changed = await fetch(panel.base + '/api/password', {
    method: 'POST',
    headers: {
      Authorization: basic(old),
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user: 'admin', password: 'NovyjParol123' }),
  });
  assert.equal(changed.status, 200);

  // Старый пароль больше не принимается, хотя успешно проверялся секунду назад.
  const withOld = await fetch(panel.base + '/api/system', { headers: { Authorization: basic(old) } });
  assert.equal(withOld.status, 401, 'кэш успешной проверки пережил смену пароля');

  const withNew = await fetch(panel.base + '/api/system', { headers: { Authorization: basic('NovyjParol123') } });
  assert.equal(withNew.status, 200);
});

test('A-01: неверный пароль не попадает в кэш', async (t) => {
  const panel = await startPanel({ PANEL_NO_AUTH: '' });
  t.after(async () => { await panel.stop(); });
  const basic = (p) => 'Basic ' + Buffer.from(`admin:${p}`).toString('base64');
  const wrong = 'ZavedomoNevernyjParol1';

  for (let i = 0; i < 3; i++) {
    const res = await fetch(panel.base + '/api/system', { headers: { Authorization: basic(wrong) } });
    assert.equal(res.status, 401, 'неверный пароль не должен становиться валидным');
  }
  assert.equal((await fetch(panel.base + '/api/system', { headers: { Authorization: basic(panel.auth.password) } })).status, 200);
});

test('A-01: кэш можно выключить (PANEL_AUTH_CACHE_MS=0)', async (t) => {
  const panel = await startPanel({ PANEL_NO_AUTH: '', PANEL_AUTH_CACHE_MS: '0' });
  t.after(async () => { await panel.stop(); });
  const headers = { Authorization: 'Basic ' + Buffer.from(`${panel.auth.user}:${panel.auth.password}`).toString('base64') };
  for (let i = 0; i < 3; i++) {
    assert.equal((await fetch(panel.base + '/api/system', { headers })).status, 200);
  }
});
