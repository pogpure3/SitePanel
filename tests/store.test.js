'use strict';

// Регрессия SP-01/SP-02/SP-06/SP-07: сохранность реестра сайтов.
//
//   SP-01  битый db.json раньше молча превращался в пустой реестр и затирался
//          первой же мутацией — все сайты терялись без следа;
//   SP-02  запись без fsync оставляла обрезанный файл при потере питания;
//   SP-06  сбой записи проглатывался, API отвечал «ок» за несохранённые данные;
//   SP-07  запись сайта без `domains` роняла сырой http-листенер прокси.
//
// Каталог данных задаётся ДО первого require('./config'): модуль читает env
// на верхнем уровне, поэтому порядок строк здесь важен.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-store-'));
fs.mkdirSync(path.join(DATA_DIR, 'sites'), { recursive: true });
process.env.PANEL_DATA_DIR = DATA_DIR;

const secure = require('../src/securefile');
const { config } = require('../src/config');
const store = require('../src/store');

function writeDb(obj) {
  fs.writeFileSync(config.dbFile, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}

function resetState() {
  store.state.sites = [];
  store.state.settings.alerts = { enabled: true, telegramToken: '', telegramChatId: '', diskThreshold: 80, memThreshold: 80 };
}

test('SP-01: битый db.json не превращается в пустой реестр молча', (t) => {
  resetState();
  // Есть предыдущее поколение — панель обязана взять его, а не пустоту.
  writeDb({ sites: [{ id: 'a1', name: 'one', type: 'static', domains: ['one.example.com'] }] });
  store.load();
  assert.equal(store.state.sites.length, 1, 'первое состояние должно загрузиться');
  store.flush(); // создаёт db.json.bak
  const backup = fs.readFileSync(config.dbFile + '.bak', 'utf8');
  assert.match(backup, /one\.example\.com/, 'резервная копия должна содержать сайт');

  // Портим файл: он есть, но не разбирается.
  writeDb('{"sites": [{"id": "a1", "name": "one"');
  const before = fs.readFileSync(config.dbFile, 'utf8');
  store.state.sites = [];
  store.load();

  assert.equal(store.isRecoveryMode(), true, 'аварийный режим обязателен');
  assert.ok(store.getRecoveryReason(), 'причина аварии должна быть известна');
  // Восстановление из .bak: сайт не потерян.
  assert.equal(store.state.sites.length, 1, 'состояние должно подняться из .bak');
  assert.equal(store.state.sites[0].domains[0], 'one.example.com');
  // Повреждённый оригинал сохранён отдельным файлом, а не затёрт.
  const corrupt = fs.readdirSync(DATA_DIR).filter((f) => f.startsWith('db.json.corrupt-'));
  assert.equal(corrupt.length, 1, `ожидался db.json.corrupt-*, найден ${JSON.stringify(corrupt)}`);
  assert.equal(fs.readFileSync(path.join(DATA_DIR, corrupt[0]), 'utf8'), before);

  // Fail-closed: запись запрещена, нового db.json не появляется.
  assert.throws(() => store.flush(), (err) => err.code === 'STORE_RECOVERY', 'flush обязан отказать');
  assert.equal(fs.existsSync(config.dbFile), false, 'битый db.json отложен и не пересоздан');
  assert.equal(
    fs.readFileSync(path.join(DATA_DIR, corrupt[0]), 'utf8'),
    before,
    'содержимое повреждённого файла сохранено дословно'
  );
});

test('SP-01: без .bak панель не пишет пустой реестр', (t) => {
  resetState();
  for (const f of ['db.json', 'db.json.bak']) {
    try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* нет файла */ }
  }
  writeDb('совсем не json');
  store.load();
  assert.equal(store.isRecoveryMode(), true);
  assert.equal(store.state.sites.length, 0);
  assert.throws(() => store.flush(), (err) => err.code === 'STORE_RECOVERY');
  assert.equal(fs.existsSync(config.dbFile), false, 'битый файл отложен, новый не создан');
});

test('SP-07: запись без domains не роняет поиск по домену', (t) => {
  try { fs.unlinkSync(path.join(DATA_DIR, 'db.json')); } catch { /* нет файла */ }
  try { fs.unlinkSync(path.join(DATA_DIR, 'db.json.bak')); } catch { /* нет файла */ }
  writeDb({
    sites: [
      { id: 'nodomains', name: 'без доменов', type: 'static' },
      { id: 'badtype', name: 'плохой тип', type: 'wat', domains: ['b.example.com'] },
      { id: 'ok', name: 'нормальный', type: 'node', domains: ['ok.example.com'], port: 10001 },
      { id: 42, name: 'не объект-строка' },
    ],
  });
  // Аварийного режима быть не должно: файл валиден, просто записи разного качества.
  store.load();
  assert.equal(store.isRecoveryMode(), false);
  assert.equal(store.state.sites.length, 3, 'id без строки отброшен, остальные приняты');

  const noDomains = store.getSite('nodomains');
  assert.deepEqual(noDomains.domains, [], 'поле domains нормализовано в массив');
  assert.equal(store.getSite('badtype').type, 'static', 'неизвестный тип заменён на static');
  assert.equal(store.getSite('ok').port, 10001);

  // Главное: поиск не бросает TypeError (раньше это вешало публичный прокси).
  assert.equal(store.getSiteByDomain('ok.example.com').id, 'ok');
  assert.equal(store.getSiteByDomain('b.example.com').id, 'badtype');
  assert.equal(store.getSiteByDomain('unknown.example.com'), null);
  assert.equal(store.domainTaken('ok.example.com', 'nodomains'), true);
});

test('SP-07: wildcard-домены продолжают работать', (t) => {
  resetState();
  store.state.sites = [{ id: 'w', name: 'w', type: 'static', domains: ['*.example.com'] }];
  assert.equal(store.getSiteByDomain('a.example.com').id, 'w');
  assert.equal(store.getSiteByDomain('example.com'), null, 'сам apex не покрывается маской');
});

test('SP-06: сбой записи db.json виден вызывающему, а не проглатывается', (t) => {
  // Чистое состояние: выходим из аварийного режима новым загрузом валидного файла.
  store.state.sites = [{ id: 'x', name: 'x', type: 'static', domains: ['x.example.com'] }];
  writeDb({ sites: store.state.sites });
  store.load();
  assert.equal(store.isRecoveryMode(), false);

  const realRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('no space left on device');
    err.code = 'ENOSPC';
    throw err;
  };
  try {
    assert.throws(() => store.flush(), /no space left on device/, 'flush обязан пробросить ошибку');
    assert.ok(store.getLastSaveError(), 'ошибка должна запоминаться для интерфейса');
    // Временный файл не должен оставаться мусором рядом с db.json.
    const leftovers = fs.readdirSync(DATA_DIR).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], `временные файлы не убраны: ${JSON.stringify(leftovers)}`);
  } finally {
    fs.renameSync = realRename;
    store.flush();
  }
  assert.equal(store.getLastSaveError(), null, 'после успешной записи ошибка сбрасывается');
});

test('SP-02: запись атомарна — наружу виден целый файл', (t) => {
  const file = path.join(DATA_DIR, 'atomic.json');
  secure.writePrivateAtomic(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  secure.writePrivateAtomic(file, '{"a":2}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}');
  // Никаких .tmp рядом: файл переименовывается, а не остаётся «полузаписанным».
  assert.deepEqual(fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.tmp')), []);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'режим приватного файла');
  }
});

test('SP-02: ошибка записи не оставляет временный файл', (t) => {
  const sub = path.join(DATA_DIR, 'nested');
  fs.mkdirSync(sub, { recursive: true });
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
  try {
    assert.throws(() => secure.writePrivateAtomic(path.join(sub, 'f.json'), 'x'), /EACCES/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(fs.readdirSync(sub), [], 'временный файл удалён');
});

test('SP-01: валидация записей не портит корректные данные', () => {
  const { site } = store.validateSite({ id: ' abc ', name: '', type: 'node', domains: ['Ok.Example.COM'], port: '10005', autoStart: 'yes' });
  assert.equal(site.id, 'abc', 'id обрезан');
  assert.equal(site.name, 'abc', 'пустое имя заменено id');
  assert.deepEqual(site.domains, ['ok.example.com'], 'домены нормализованы');
  assert.equal(site.port, 10005, 'порт приведён к числу');
  assert.equal(site.autoStart, false, 'нестроковый autoStart не становится true');
  assert.equal(store.validateSite(null).site, null);
  assert.equal(store.validateSite({ name: 'без id' }).site, null);
});
