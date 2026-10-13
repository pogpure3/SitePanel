'use strict';

// Регрессия «этапа 2» PLAN.md: устойчивость процессов и деплоя (P1).
//
// Каждый тест назван своим идентификатором из PLAN.md:1562-1626 и отвечает на
// вопрос «какую поломку он ловит»:
//
//   T-05  обрыв деплоя между двумя renameSync оставлял сайт БЕЗ каталога:
//         `renameSync(dir, dir.backup)` проходил, панель умирала, и на старте
//         каталога не было ни у сайта, ни (для прокси) вообще (SP-05).
//   T-06  запись сайта без `domains` роняла сырой http-листенер: запрос
//         посетителя оставался без ответа навсегда (SP-07).
//   T-09/T-10 `appendFileSync` на каждый чанк stdout блокировал event loop, а
//         `readLogTail` читал ВЕСЬ файл в память (P-01, P-02, P-23).
//   T-11  деплой, при котором приложение не открыло порт, считался успешным (P-03).
//   T-13  `allocatePort()` смотрел только в реестр: занятый посторонним
//         процессом порт выдавался сайту, старт падал на EADDRINUSE (P-06).
//   T-32  «повисший» git clone держал блокировку сайта вечно (P-13).
//   T-34  zip-бомба с подделанным `header.size` и `PANEL_MAX_UNCOMPRESSED_MB=0`,
//         снимавший лимит целиком (P-15, P-16).
//   T-40  два параллельных деплоя node-сайтов получали ОДИН порт, а
//         `ensurePortFreed` убивал чужой процесс по переиспользованному pid (P-17, P-18).
//   T-41  `rmSync(dir)` + `renameSync(backup, dir)` в откате: падение между ними
//         теряло сайт целиком (P-20).
//   T-42  чтение лога и вывод команд не ограничивались по памяти (P-23).
//   T-43  завершение панели оставляло сирот на портах, а `boot()` сбрасывал
//         серию падений сайту в статусе crashed (P-25, P-33).
//   T-44  исчезнувший каталог сайта давал 500 и застрявший `starting` (P-27).
//   T-45  файловый менеджер писал в каталог, который деплой подменял (P-31).
//
// Файл требует общей блокировки сайта и настоящих процессов, поэтому запускать
// его нужно на тестовом сервере: node --test --test-timeout=600000 tests/durability.test.js
//
// Тесты T-12/T-30 и T-33 частично закрыты соседними файлами — за них написаны
// короткие заглушки со ссылкой, а не копии (см. ниже).

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { execFileSync } = require('child_process');

// Изолированный каталог данных ДО первого require модулей из src/: src/config.js
// читает PANEL_DATA_DIR в момент загрузки. Тесты, которым нужны настоящие панели,
// поднимают их отдельным процессом через харнесс (у него свой dataDir).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-dur-'));
process.env.PANEL_DATA_DIR = DATA_DIR;

const { test, after } = require('node:test');
const assert = require('node:assert');

const { startPanel, api, waitFor, makeZip, sleep, fetchWithHost, ROOT } = require('./helpers/panel');
const { config, ensureDirs } = require('../src/config');
const manager = require('../src/sites/manager');
const sitelog = require('../src/sites/sitelog');
const deploymark = require('../src/sites/deploymark');
const proc = require('../src/sites/proc');
const deployfiles = require('../src/sites/deployfiles');
const { runCommand } = deployfiles;
const store = require('../src/store');

const isPosix = process.platform !== 'win32';

after(() => {
  try { sitelog.closeAll(); } catch { /* уже закрыты */ }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch { /* временный каталог */ }
});

/* ---------- Вспомогательное ---------- */

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ }
}

function mkTmp(t, prefix = 'sitepanel-dur-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmrf(dir));
  return dir;
}

/** Панель + временный каталог для архивов. */
async function withPanel(t, env, opts) {
  const panel = await startPanel(env, opts);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-dur-zip-'));
  t.after(async () => {
    await panel.stop();
    rmrf(tmp);
  });
  return { panel, tmp };
}

function makeZipAt(tmp, name, files) {
  const zip = path.join(tmp, `${name}.zip`);
  makeZip(path.join(tmp, name), files, zip);
  return zip;
}

/** POST /api/sites без проверки статуса: часть тестов ждёт именно провал. */
async function postSite(panel, tmp, name, files, autoStart = true) {
  const zip = makeZipAt(tmp, name, files);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), `${name}.zip`);
  form.append('name', name);
  form.append('autoStart', autoStart ? 'true' : 'false');
  const res = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* не json */ }
  return { status: res.status, data, text };
}

async function uploadSite(panel, tmp, name, files, autoStart = true) {
  const r = await postSite(panel, tmp, name, files, autoStart);
  assert.equal(r.status, 200, `деплой «${name}» не удался: ${r.text.slice(0, 300)}`);
  return r.data;
}

async function updateSite(panel, tmp, siteId, name, files) {
  const zip = makeZipAt(tmp, name, files);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), path.basename(zip));
  const res = await fetch(panel.base + `/api/sites/${siteId}/update`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* не json */ }
  return { status: res.status, data, text };
}

/** GET / на внутреннем порту приложения. */
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

// Сервер node-сайта: отвечает маркером и явно падает, если порт не занялся.
const NODE_SERVER = (marker) => [
  "const http = require('http');",
  "const s = http.createServer((q, r) => r.end('" + marker + "'));",
  "s.on('error', (e) => { console.error('listen error:', e.code, e.message); process.exit(1); });",
  "s.listen(process.env.PORT, '127.0.0.1', () => console.log('listening on', process.env.PORT));",
].join('\n');

// Процесс, который живёт, но НИКОГДА не открывает порт (регрессия P-03).
const NEVER_LISTENING = "setTimeout(() => {}, 60000);\n";

const PKG = (start) => JSON.stringify({ name: 'app', version: '1.0.0', scripts: { start } });

function nodeSite(marker) {
  return { 'package.json': PKG('node server.js'), 'server.js': NODE_SERVER(marker) };
}

function ensureDataDirs() {
  ensureDirs();
}

/** pid панели из её замка единственного экземпляра. */
function readPanelPid(dataDir) {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'sitepanel.lock'), 'utf8'));
  assert.ok(Number.isInteger(raw.pid), `в замке нет pid: ${JSON.stringify(raw)}`);
  return raw.pid;
}

/** Копирует СОДЕРЖИМОЕ src в существующий dst. */
function copyDirInto(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    fs.cpSync(path.join(src, name), path.join(dst, name), { recursive: true, force: true });
  }
}

/**
 * Состояние «панель убита между двумя renameSync»: каталога сайта нет,
 * `.backup` есть, маркер деплоя на месте. Маркер пишем прямо в файл, потому что
 * модуль deploymark смотрит в data-каталог ЭТОГО процесса, а не панели.
 */
function seedCrashWindow(dataDir, siteId) {
  const dbFile = path.join(dataDir, 'db.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  db.sites.push({
    id: siteId, name: siteId, type: 'static', status: 'stopped',
    domains: [], port: null, autoStart: false,
  });
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));

  const dir = path.join(dataDir, 'sites', siteId);
  rmrf(dir);
  fs.mkdirSync(dir + '.backup', { recursive: true });
  fs.writeFileSync(path.join(dir + '.backup', 'index.html'), 'прежняя-версия');

  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, `deploy-${siteId}.json`),
    JSON.stringify({
      siteId,
      startedAt: Date.now(),
      staging: path.join(tmpDir, `deploy-${siteId}-0`),
      backup: dir + '.backup',
      phase: 'backing-up',
      hadDir: true,
      dir,
    })
  );
}

function waitProcessExit(pid, timeout = 15000) {
  return waitFor(() => !proc.isAlive(pid), { timeout, interval: 100, label: `процесс ${pid} завершился` });
}

/* =========================================================================
 * T-05 — обрыв деплоя между двумя renameSync
 * ========================================================================= */

test('T-05: обрыв деплоя между rename восстанавливается reconcile (юнит, 20 прогонов)', async (t) => {
  // В PLAN.md критерий готовности сформулирован как «серия из 20 деплоев с
  // SIGKILL посреди каждого». Гонять 20 настоящих панелей незачем: логика
  // восстановления — это deploymark.reconcile, поэтому 20 раз прогоняем именно
  // её на реальных каталогах, а полноценный сценарий с убитой панелью ниже
  // выполняется 2 раза (он дорогой: ~10 с на итерацию).
  ensureDataDirs();
  const id = 'unit05crash';
  const site = { id, name: id, type: 'static', status: 'stopped', domains: [], port: null, autoStart: false };
  const dir = path.join(config.sitesDir, id);
  const backup = dir + '.backup';
  t.after(() => { rmrf(dir); rmrf(backup); deploymark.removeMarker(id); });

  const messages = [];
  const log = (_site, text) => messages.push(text);

  for (let i = 1; i <= 20; i++) {
    rmrf(dir);
    rmrf(backup);
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'index.html'), `v1-${i}`);
    deploymark.writeMarker(id, {
      staging: path.join(config.tmpDir, `deploy-${id}-${i}`),
      backup,
      phase: 'backing-up',
      hadDir: true,
      dir,
    });
    assert.ok(fs.existsSync(deploymark.markerFile(id)), `прогон ${i}: маркер не записан`);

    const actions = deploymark.reconcile([site], log);

    assert.ok(fs.existsSync(dir), `прогон ${i}: каталог сайта не восстановлен из .backup`);
    assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), `v1-${i}`, `прогон ${i}: восстановлена не та версия`);
    assert.ok(!fs.existsSync(backup), `прогон ${i}: .backup не израсходован`);
    assert.ok(!fs.existsSync(deploymark.markerFile(id)), `прогон ${i}: маркер не удалён`);
    assert.equal(actions.length, 1, `прогон ${i}: ожидалось одно действие, получено ${JSON.stringify(actions)}`);
    assert.equal(actions[0].siteId, id);
  }

  assert.ok(
    messages.some((m) => /каталог восстановлен из/.test(m)),
    `в лог не попало сообщение о восстановлении: ${JSON.stringify(messages.slice(0, 3))}`
  );
});

test('T-05: панель, убитая SIGKILL после деплоя, не теряет каталог сайта', async (t) => {
  const tmp = mkTmp(t);
  const copies = [];

  try {
    for (let i = 1; i <= 2; i++) {
      const panel = await startPanel({});
      let stopped = false;

      try {
        const site = await uploadSite(panel, tmp, `static05-${i}`, { 'index.html': `v1-${i}` }, false);
        const siteDir = path.join(panel.dataDir, 'sites', site.id);
        assert.ok(fs.existsSync(siteDir), 'деплой не создал каталог сайта');

        // Панель убиваем так, как это делает OOM-killer или kill -9: без
        // обработчиков и без шанса дописать состояние.
        const pid = readPanelPid(panel.dataDir);
        process.kill(pid, 'SIGKILL');
        await waitProcessExit(pid, 15000);

        // Данные убитой панели копируем ДО stop(): stop() их удаляет.
        const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-dur-copy-'));
        copies.push(copy);
        copyDirInto(panel.dataDir, copy);
        await panel.stop();
        stopped = true;

        // Второй сайт этой же панели оставлен ровно в окне между двумя rename:
        // каталога нет, .backup есть, маркер деплоя есть.
        const crashId = `crash05e2e${i}`;
        seedCrashWindow(copy, crashId);

        const panel2 = await startPanel({}, { prepare: (dir) => copyDirInto(copy, dir) });
        try {
          assert.ok(fs.existsSync(siteDir) === false, 'проверка идёт по каталогу второй панели');
          const restoredDir = path.join(panel2.dataDir, 'sites', site.id);
          assert.ok(fs.existsSync(restoredDir), `итерация ${i}: после SIGKILL каталог деплоя не появился у новой панели`);

          const crashDir = path.join(panel2.dataDir, 'sites', crashId);
          assert.ok(fs.existsSync(crashDir), `итерация ${i}: boot() не восстановил каталог из .backup`);
          assert.equal(
            fs.readFileSync(path.join(crashDir, 'index.html'), 'utf8'), 'прежняя-версия',
            `итерация ${i}: восстановлена не прежняя версия`
          );
          assert.ok(!fs.existsSync(crashDir + '.backup'), `итерация ${i}: .backup не израсходован`);
          assert.ok(
            !fs.existsSync(path.join(panel2.dataDir, 'tmp', `deploy-${crashId}.json`)),
            `итерация ${i}: маркер деплоя пережил реконсиляцию`
          );

          // Реконсиляция должна быть видна и в логе сайта.
          const logFile = path.join(panel2.dataDir, 'logs', `${crashId}.log`);
          assert.ok(fs.existsSync(logFile), `итерация ${i}: лог сайта не создан`);
          assert.match(
            fs.readFileSync(logFile, 'utf8'),
            /каталог восстановлен из .*\.backup/,
            `итерация ${i}: в логе нет сообщения о восстановлении каталога`
          );
        } finally {
          await panel2.stop();
        }
      } finally {
        if (!stopped) await panel.stop();
      }
    }
  } finally {
    for (const c of copies) rmrf(c);
  }
});

/* =========================================================================
 * T-06 — запись без domains не подвешивает публичный запрос
 * ========================================================================= */

test('T-06: запись сайта без domains отвечает на публичный запрос, а не висит', async (t) => {
  // Раньше такая запись роняла сырой http-листенер (`.includes` у undefined) и
  // посетитель не получал НИЧЕГО: соединение оставалось открытым навсегда.
  const panel = await startPanel({}, {
    prepare: (dir) => {
      fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
        sites: [
          // `domains` вообще нет в записи.
          { id: 'nodom000001', name: 'nodom', type: 'static', status: 'running', port: null, autoStart: false },
          // `domains` есть, но пустой массив.
          { id: 'emptydom001', name: 'emptydom', type: 'static', status: 'running', port: null, autoStart: false, domains: [] },
        ],
        settings: {},
      }, null, 2));
    },
  });
  t.after(async () => { await panel.stop(); });

  // Хост только ASCII: http.request отвергает не-ASCII в заголовке Host ещё до
  // отправки (ERR_INVALID_CHAR), а нам нужен ответ СЕРВЕРА.
  for (const host of ['nodom.local', 'emptydom.local', 'unknown-host.local']) {
    const res = await Promise.race([
      fetchWithHost(panel.httpPort, host, '/'),
      sleep(4000).then(() => ({ status: 'timeout', body: '', headers: {} })),
    ]);
    assert.notEqual(res.status, 'timeout', `запрос с Host: ${host} завис — листенер не ответил`);
    assert.ok([404, 503].includes(res.status), `Host: ${host} — неожиданный статус ${res.status}`);
    assert.ok(res.body && res.body.length > 0, `Host: ${host} — пустое тело заглушки`);
    assert.equal(res.headers['cache-control'], 'no-store', `Host: ${host} — заглушка кешируется`);
  }

  // Сами записи панель обязана сохранить (валидация правит их, а не выбрасывает).
  const list = await api(panel, 'GET', '/api/sites');
  assert.equal(list.status, 200, `GET /api/sites: ${list.status} ${list.text.slice(0, 200)}`);
  const ids = new Set((list.data || []).map((s) => s.id));
  assert.ok(ids.has('nodom000001') && ids.has('emptydom001'),
    `записи без domains потеряны: ${JSON.stringify([...ids])}`);
  for (const s of list.data) {
    assert.ok(Array.isArray(s.domains), `у сайта ${s.id} domains не массив: ${JSON.stringify(s.domains)}`);
  }
});

/* =========================================================================
 * T-09 / T-10 — логи: асинхронная запись и чтение только хвоста
 * ========================================================================= */

test('T-09: appendLog пишет асинхронно и не блокирует event loop', async (t) => {
  ensureDataDirs();
  const id = 'log09async';
  const site = { id, name: id, type: 'node', status: 'stopped', domains: [], port: null };
  t.after(() => { rmrf(manager.siteLogFile(site)); });

  // Старая реализация делала fs.appendFileSync на КАЖДЫЙ чанк вывода сайта:
  // болтливый сайт блокировал event loop панели целиком. Записывающих
  // синхронных вызовов быть не должно вообще.
  const origAppend = fs.appendFileSync;
  const origWriteSync = fs.writeSync;
  let syncCalls = 0;
  fs.appendFileSync = function patchedAppendFileSync() { syncCalls++; return origAppend.apply(this, arguments); };
  fs.writeSync = function patchedWriteSync() { syncCalls++; return origWriteSync.apply(this, arguments); };

  const N = 3000;
  const t0 = Date.now();
  try {
    for (let i = 0; i < N; i++) {
      manager.appendLog(site, `строка-${i} ${'x'.repeat(80)}`);
    }
  } finally {
    fs.appendFileSync = origAppend;
    fs.writeSync = origWriteSync;
  }
  const ms = Date.now() - t0;

  assert.equal(syncCalls, 0, `лог писался синхронно (${syncCalls} вызовов) — event loop блокируется`);
  assert.ok(ms < 2000, `${N} вызовов appendLog заняли ${ms} мс — запись блокирующая`);

  // Асинхронная запись всё равно обязана доехать до диска.
  sitelog.closeAll();
  await sleep(400);
  const tail = manager.readLogTail(site, 3);
  const lines = tail.split('\n').filter(Boolean);
  assert.equal(lines.length, 3, `в хвосте ${lines.length} строк: ${JSON.stringify(lines)}`);
  assert.match(lines[2], new RegExp(`^строка-${N - 1} `), `последняя строка потерялась: ${lines[2]}`);
  assert.ok(fs.statSync(manager.siteLogFile(site)).size > N * 80, 'лог пуст — записи не дошли до диска');
});

test('T-10: readLogTail читает только хвост большого файла', async (t) => {
  ensureDataDirs();
  const id = 'log10tail';
  const site = { id, name: id, type: 'node', status: 'stopped', domains: [], port: null };
  const file = manager.siteLogFile(site);
  t.after(() => { rmrf(file); });

  // Блок в 1 МБ из строк фиксированной длины — так файл собирается быстро.
  const block = [];
  let lineNo = 0;
  while (block.join('').length < 1024 * 1024) {
    block.push(`line-${String(lineNo).padStart(6, '0')} ${'y'.repeat(96)}\n`);
    lineNo++;
  }
  const blockBuf = Buffer.from(block.join(''));
  const fd = fs.openSync(file, 'w');
  try {
    for (let k = 0; k < 8; k++) fs.writeSync(fd, blockBuf);
  } finally {
    fs.closeSync(fd);
  }
  const total = fs.statSync(file).size;
  assert.ok(total > 6 * 1024 * 1024, `лог слишком мал для проверки: ${total} байт`);

  // Сколько байт реально запрошено у readSync — объективная мера «прочитан только хвост».
  const origReadSync = fs.readSync;
  let maxRequested = 0;
  let reads = 0;
  fs.readSync = function patchedReadSync(fd2, buf, off, len, pos) {
    if (len > maxRequested) maxRequested = len;
    reads++;
    return origReadSync.apply(this, arguments);
  };
  let tail;
  try {
    tail = manager.readLogTail(site, 5);
  } finally {
    fs.readSync = origReadSync;
  }

  assert.equal(reads, 1, `readLogTail сделал ${reads} чтений вместо одного`);
  assert.ok(maxRequested <= config.logTailMaxBytes,
    `прочитано ${maxRequested} байт — больше лимита logTailMaxBytes=${config.logTailMaxBytes}`);
  assert.ok(maxRequested < total / 100,
    `прочитано ${maxRequested} байт при файле ${total} байт — это не чтение хвоста`);

  const lines = tail.split('\n');
  assert.equal(lines.length, 5, `в хвосте ${lines.length} строк: ${JSON.stringify(lines).slice(0, 200)}`);
  assert.match(lines[4], new RegExp(`^line-${String(lineNo - 1).padStart(6, '0')} `),
    `последняя строка не последняя: ${lines[4]}`);
});

/* =========================================================================
 * T-11 — приложение не открыло порт: ожидается провал
 * ========================================================================= */

test('T-11: деплой, при котором приложение не открыло порт, сообщает о провале', async (t) => {
  const { panel, tmp } = await withPanel(t, { PANEL_APP_LISTEN_WAIT_MS: '2000' });

  // Первый деплой: сайт стартует, но порт не слушает (P-03). Сама панель
  // обязана назвать это провалом, а не отдать «running».
  const held = { 'package.json': PKG('node hold.js'), 'hold.js': NEVER_LISTENING };
  const first = await postSite(panel, tmp, 'nolisten', held, true);
  assert.equal(first.status, 200, `деплой упал по HTTP: ${first.status} ${first.text.slice(0, 200)}`);
  assert.notEqual(first.data.status, 'running',
    `сайт без слушающего порта объявлен работающим: ${JSON.stringify(first.data)}`);

  const siteId = first.data.id;
  t.after(async () => { try { await api(panel, 'POST', `/api/sites/${siteId}/stop`); } catch { /* панель уже мертва */ } });

  // Внутренний порт действительно никто не слушает.
  assert.equal((await getInternal(first.data.port)).status, 0,
    'на внутреннем порту кто-то отвечает, хотя приложение не должно было слушать');

  // Причина видна в логе сайта — иначе «провал» неотличим от сбоя панели.
  const logs = await api(panel, 'GET', `/api/sites/${siteId}/logs?lines=80`);
  assert.equal(logs.status, 200);
  assert.match(String(logs.data.log), /не открыло порт/,
    `в логе нет причины (порт не открылся):\n${String(logs.data.log).slice(-500)}`);

  // Обновление существующего рабочего сайта на «молчащую» версию обязано
  // вернуть честный ok=false (а не «успешно» с нерабочим сайтом).
  const good = await uploadSite(panel, tmp, 'good11', nodeSite('v1'));
  await waitFor(async () => (await getInternal(good.port)).status === 200, {
    timeout: 20000, label: 'первая версия отвечает',
  });
  const upd = await updateSite(panel, tmp, good.id, 'nolisten-v2', held);
  assert.equal(upd.status, 200, `обновление упало по HTTP: ${upd.status} ${upd.text.slice(0, 200)}`);
  assert.equal(upd.data.ok, false, `обновление на неслушающую версию объявлено успешным: ${JSON.stringify(upd.data).slice(0, 300)}`);
  const updErr = String((upd.data.result && upd.data.result.error) || '');
  assert.match(updErr, /не открыло порт|запуск|Восстановлена/i, `непонятная ошибка результата: ${updErr}`);
});

/* =========================================================================
 * T-12 / T-30 / T-33 — закрыто соседними файлами
 * ========================================================================= */

test('T-12: validateGitUrl (покрыто в tests/gitvalidate.test.js)', (t) => {
  t.skip('покрыто в tests/gitvalidate.test.js — инъекции, схемы, переводы строк');
});

test('T-30: подкаталог с .. не трогает каталог соседнего сайта', (t) => {
  // Сам отказ validateSubdir('..'/'../..'/'../../sites/<id>') уже проверен в
  // tests/gitvalidate.test.js (P-11) — здесь проверяется ВТОРАЯ половина
  // требования PLAN.md: каталог соседнего сайта остаётся на месте, потому что
  // до файловых операций дело не доходит.
  ensureDataDirs();
  const dirA = path.join(config.sitesDir, 'neighbourA');
  const dirB = path.join(config.sitesDir, 'neighbourB');
  t.after(() => { rmrf(dirA); rmrf(dirB); });
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirA, 'index.html'), 'A');
  fs.writeFileSync(path.join(dirB, 'index.html'), 'B');

  const bad = ['..', '../..', '../../sites/neighbourB', 'apps/../..', './..', 'a/b/../../..', '../etc', '/etc'];
  for (const sub of bad) {
    assert.throws(() => manager.validateSubdir(sub), `подкаталог «${sub}» принят`);
  }

  assert.equal(fs.readFileSync(path.join(dirB, 'index.html'), 'utf8'), 'B', 'каталог соседнего сайта изменён');
  assert.equal(fs.readFileSync(path.join(dirA, 'index.html'), 'utf8'), 'A', 'каталог сайта изменён');
  assert.ok(!fs.existsSync(path.join(config.sitesDir, 'etc')), 'в data/sites появился посторонний каталог');
});

test('T-30: assertInside отклоняет любой путь за пределы базового каталога', (t) => {
  // Вторая линия обороны того же требования (P-11). validateSubdir — проверка
  // ЛЕКСИЧЕСКАЯ, но путь можно собрать и без '..' (симлинк, абсолютный сегмент,
  // склейка). assertInside сравнивает РАЗРЕШЁННЫЕ пути, поэтому он обязан
  // отказать и там, где регулярка ничего не заметила. Раньше эта функция не
  // покрывалась ничем: снятие проверки `rel` не роняло ни один тест.
  ensureDataDirs();
  const base = path.join(config.sitesDir, 'contain30');
  t.after(() => rmrf(base));
  fs.mkdirSync(path.join(base, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(base, 'inner', 'index.html'), 'ok');

  // Внутри — принимается, включая вложенный и нормализованный путь.
  assert.equal(manager.assertInside(base, path.join(base, 'inner', 'index.html')),
    path.join(path.resolve(base), 'inner', 'index.html'), 'путь внутри каталога отклонён');
  assert.equal(manager.assertInside(base, path.join(base, 'inner', '..', 'inner'), 'x'),
    path.join(path.resolve(base), 'inner'), 'нормализация не выполнена');
  assert.equal(manager.assertInside(base, base), path.resolve(base), 'сам базовый каталог отклонён');

  // Снаружи — отказ, и это именно выход за пределы, а не «не найдено».
  const outside = [
    path.join(base, '..', 'neighbour'),
    path.join(base, '..', '..', 'etc'),
    path.parse(base).root,
    path.resolve(base) + path.sep + '..',
  ];
  for (const p of outside) {
    assert.throws(() => manager.assertInside(base, p, 'подкаталог'), /выход за пределы/,
      `путь за пределы каталога принят: ${p}`);
  }

  // Каталог соседа не тронут: проверка отказывает ДО любых файловых операций.
  assert.equal(fs.readFileSync(path.join(base, 'inner', 'index.html'), 'utf8'), 'ok');
});

test('T-33: сайт с port = null (покрыто в tests/proxy-security.test.js)', (t) => {
  t.skip('покрыто в tests/proxy-security.test.js — P-14: сайт без порта отвечает заглушкой');
});

/* =========================================================================
 * T-13 — allocatePort при занятом ОС-порту
 * ========================================================================= */

test('T-13: allocatePort пропускает порт, занятый в ОС', async (t) => {
  ensureDataDirs();
  // Свободный кандидат в реестре панели не занят (сайтов нет), поэтому
  // «пропустить его» allocatePort может только по проверке уровня ОС.
  const first = await manager.allocatePort();
  assert.ok(Number.isInteger(first) && first >= config.internalPortFrom,
    `allocatePort вернул ${first} при internalPortFrom=${config.internalPortFrom}`);

  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(first, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => { if (srv.listening) srv.close(() => resolve()); else resolve(); }));

  assert.equal(await proc.portBusy(first), true, 'порт не занят — тест проверяет не то');

  const second = await manager.allocatePort();
  assert.notEqual(second, first, 'allocatePort выдал порт, занятый посторонним процессом (P-06)');
  assert.ok(second > first, `неожиданный кандидат ${second} вместо пропуска ${first}`);

  // Освободили порт — кандидат снова первый: разница была именно из-за ОС.
  await new Promise((resolve) => srv.close(resolve));
  const third = await waitFor(async () => {
    const p = await manager.allocatePort();
    return p === first ? p : false;
  }, { timeout: 5000, interval: 300, label: 'порт снова свободен для allocatePort' });
  assert.equal(third, first);
});

/* =========================================================================
 * T-32 — таймаут git clone и освобождение блокировки
 * ========================================================================= */

test('T-32: gitClone по повисшему адресу завершается по таймауту и отпускает блокировку (МЕДЛЕННЫЙ, ~1 мин)', async (t) => {
  // «Повисший» адрес делаем сами: локальный слушатель принимает TCP-соединение
  // и НИЧЕГО не отвечает. Прежде такой clone держал блокировку сайта вечно и
  // останавливал ВСЕ операции этого сайта, включая остановку (P-13).
  //
  // Раньше здесь стоял 10.255.255.1, но в этом окружении git сдавался сам за
  // ~15 с (быстрый отказ сети), и тест падал на «панель не держала свой
  // таймаут», ничего не проверяя. Локальный tarpit висит гарантированно, пока
  // его не закроют, поэтому проверяется именно таймаут панели.
  const tarpit = net.createServer(() => { /* принять и молчать */ });
  const sockets = new Set();
  tarpit.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => {
    tarpit.once('error', reject);
    tarpit.listen(0, '127.0.0.1', resolve);
  });
  const hangPort = tarpit.address().port;

  // Прибираемся за собой, не дожидаясь вечно: `server.close()` завершается
  // только когда закроются ВСЕ соединения, а соединение с «молчащим» сервером
  // держит выживший git-remote-https (именно потому проверяемый дефект и
  // существует). Без этого t.after висел бы до таймаута всего файла, то есть
  // тест «падал бы» не по существу — это уже наблюдалось (600 с, 11 тестов).
  t.after(async () => {
    for (const s of sockets) { try { s.destroy(); } catch { /* уже закрыт */ } }
    try { tarpit.closeAllConnections(); } catch { /* нет в старых Node */ }
    await Promise.race([
      new Promise((resolve) => tarpit.close(() => resolve())),
      sleep(3000),
    ]);
    // Клона могло не быть вовсе (после починки) — тогда pkill просто не найдёт
    // цели и вернёт 1; это не ошибка.
    if (isPosix) {
      try {
        execFileSync('pkill', ['-9', '-f', `git-remote-https origin https://127.0.0.1:${hangPort}`],
          { stdio: 'ignore' });
      } catch { /* нечего убивать */ }
    }
  });

  const { panel, tmp } = await withPanel(t, { PANEL_GIT_TIMEOUT_MIN: '1' });

  const t0 = Date.now();
  const pending = fetch(panel.base + '/api/sites/git', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `https://127.0.0.1:${hangPort}/user/repo.git`, name: 'hang32' }),
  });

  // Пока деплой висит на клоне, панель обязана обслуживать остальные запросы:
  // зависший git clone не должен замораживать админку и весь сайт.
  const waiting = await waitFor(async () => {
    const r = await api(panel, 'GET', '/api/sites');
    assert.equal(r.status, 200, `панель не отвечает, пока идёт git clone: ${r.status}`);
    return (r.data || []).find((s) => s.name === 'hang32');
  }, { timeout: 20000, interval: 300, label: 'git-деплой появился в реестре' });
  assert.ok(waiting.id, `висящий деплой без id: ${JSON.stringify(waiting)}`);
  // Каталога у сайта ещё нет — клон пишет только в staging панели.
  assert.ok(!fs.existsSync(path.join(panel.dataDir, 'sites', waiting.id)),
    'каталог сайта создан до успешного клона');

  // Ждём ответа с ЖЁСТКИМ дедлайном. Ждать `await pending` нельзя: если панель
  // не завершила клон, промис не разрешится никогда и повиснет весь файл, а не
  // один тест. Дедлайн заведомо больше таймаута панели (60 с при
  // PANEL_GIT_TIMEOUT_MIN=1) и меньше --test-timeout файла.
  const SETTLE_DEADLINE_MS = 150000;
  let res = null;
  let text = '';
  const outcome = await Promise.race([
    pending.then(async (r) => ({ kind: 'answer', r, body: await r.text() })),
    sleep(SETTLE_DEADLINE_MS).then(() => ({ kind: 'hung' })),
  ]);
  const ms = Date.now() - t0;

  if (outcome.kind === 'answer') {
    res = outcome.r;
    text = outcome.body;
  }

  // Ниже — требования PLAN.md к T-32. Они сформулированы как обязательные, и
  // тест намеренно их НЕ ослабляет: если панель не отпускает блокировку, тест
  // обязан упасть с внятной диагностикой, а не «подстроиться».
  assert.notEqual(outcome.kind, 'hung',
    `панель не завершила висящий клон за ${SETTLE_DEADLINE_MS} мс: таймаут клонирования не срабатывает, ` +
    `блокировка сайта удерживается вечно и POST /api/sites/git не отвечает никогда`);

  let data = null;
  try { data = JSON.parse(text); } catch { /* не json */ }

  // Верхняя граница — именно таймаут панели (PANEL_GIT_TIMEOUT_MIN=1), а не
  // «git сам сдался»: без таймаута запрос не завершался никогда.
  assert.ok(ms >= 40000, `запрос завершился за ${ms} мс — панель не держала свой таймаут клонирования`);
  assert.ok(ms < SETTLE_DEADLINE_MS, `таймаут не сработал: запрос шёл ${ms} мс`);
  assert.ok(res.status !== 200 || !(data && data.ok),
    `висящий git clone объявлен успехом: ${res.status} ${text.slice(0, 200)}`);
  assert.match(text, /Git|git|клон/i, `в ответе нет причины: ${text.slice(0, 200)}`);

  // Ключевое: catch деплоя выполнился (запись убрана) — значит блокировка сайта
  // отпущена, а не удерживается неразрешённым промисом.
  const after = await api(panel, 'GET', '/api/sites');
  assert.ok(!(after.data || []).some((s) => s.id === waiting.id),
    'битая запись git-деплоя осталась в реестре — catch не выполнился');

  const tStop = Date.now();
  const stop = await api(panel, 'POST', `/api/sites/${waiting.id}/stop`);
  assert.equal(stop.status, 404, `операция над сайтом вернула ${stop.status}: ${stop.text.slice(0, 200)}`);
  assert.ok(Date.now() - tStop < 5000, 'следующая операция не прошла сразу — блокировка не отпущена');

  // И следующая полноценная операция проходит: панель не «залипла».
  const fresh = await uploadSite(panel, tmp, 'after32', nodeSite('ok'));
  assert.ok(fresh.id, `деплой после таймаута не удался: ${JSON.stringify(fresh).slice(0, 200)}`);
  await waitFor(async () => (await getInternal(fresh.port)).status === 200, {
    timeout: 20000, label: 'сайт после таймаута git clone запустился',
  });
});

/* =========================================================================
 * T-34 — zip-бомба и пределы конфигурации
 * ========================================================================= */

/** Патчит ЗАЯВЛЕННЫЙ размер (local header + central directory) во всех записях. */
function patchDeclaredSizes(buf, declaredSize) {
  const SIG_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const SIG_CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let i = 0;
  while ((i = buf.indexOf(SIG_LOCAL, i)) !== -1) {
    buf.writeUInt32LE(declaredSize, i + 22);
    const nl = buf.readUInt16LE(i + 26);
    const el = buf.readUInt16LE(i + 28);
    i = i + 30 + nl + el;
  }
  i = 0;
  while ((i = buf.indexOf(SIG_CENTRAL, i)) !== -1) {
    buf.writeUInt32LE(declaredSize, i + 24);
    const nl = buf.readUInt16LE(i + 28);
    const el = buf.readUInt16LE(i + 30);
    const cl = buf.readUInt16LE(i + 32);
    i = i + 46 + nl + el + cl;
  }
  return buf;
}

test('T-34: подделанный header.size отклоняется до создания каталога', async (t) => {
  ensureDataDirs();
  const work = mkTmp(t);
  const target = path.join(config.tmpDir, 'bomb-target-34');
  t.after(() => rmrf(target));

  // Архив крошечный, а заявленный несжатый размер — 3 ГБ: так выглядит zip-бомба
  // для того, кто доверяет header.size. Отказ обязан произойти ДО mkdirSync,
  // иначе в data/sites остаётся пустой каталог, выглядящий как сайт (P-10).
  const srcDir = path.join(work, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.html'), '<h1>ok</h1>');
  const zipPath = path.join(work, 'bomb.zip');
  const AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip'));
  const zip = new AdmZip();
  zip.addLocalFile(path.join(srcDir, 'index.html'));
  const buf = patchDeclaredSizes(zip.toBuffer(), 3 * 1024 * 1024 * 1024);

  rmrf(target);
  assert.throws(
    () => manager.extractZip(buf, target),
    /распаковывается|ГБ|МБ|максимум/i,
    'zip-бомба с подделанным header.size не отклонена'
  );
  assert.ok(!fs.existsSync(target), `каталог ${target} создан до проверки лимита (P-10)`);

  // Второй сценарий того же класса: подделанный размер МЕНЬШЕ реального
  // (заявлен 0 при реальном содержимом). Распаковка обязана упасть, а не
  // «успешно» создать недособранное дерево.
  const small = patchDeclaredSizes(zip.toBuffer(), 0);
  const target2 = path.join(config.tmpDir, 'bomb-target-34b');
  t.after(() => rmrf(target2));
  rmrf(target2);
  assert.throws(() => manager.extractZip(small, target2),
    'архив с заниженным header.size не отклонён — недособранный каталог выглядит как сайт');
  if (fs.existsSync(target2)) {
    const left = fs.readdirSync(target2, { recursive: true });
    assert.equal(left.length, 0, `распаковано ${left.length} объектов из отклонённого архива: ${JSON.stringify(left).slice(0, 200)}`);
  }
});

test('T-34: PANEL_MAX_UNCOMPRESSED_MB=0 и отрицательные значения не снимают лимит', () => {
  // Одна и та же ошибка в env и в config.json: лимит читался без проверки
  // диапазона, и `=0` делал условие `totalBytes > maxBytes` заведомо ложным,
  // то есть защита от zip-бомб исчезала молча (P-16).
  const configPath = path.join(ROOT, 'src', 'config.js');
  const child = (env) => {
    const script = [
      "process.env.PANEL_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'sp-cfg-'));",
      "const { config } = require(process.argv[1]);",
      "process.stdout.write(JSON.stringify({ maxUncompressedMb: config.maxUncompressedMb, maxZipEntries: config.maxZipEntries }));",
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', script, configPath], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  };

  const DFLT_MB = 2048;
  const DFLT_ENTRIES = 50000;

  assert.equal(child({ PANEL_MAX_UNCOMPRESSED_MB: '0' }).maxUncompressedMb, DFLT_MB, '=0 снял лимит');
  assert.equal(child({ PANEL_MAX_UNCOMPRESSED_MB: '-5' }).maxUncompressedMb, DFLT_MB, 'отрицательное значение сняло лимит');
  assert.equal(child({ PANEL_MAX_UNCOMPRESSED_MB: 'abc' }).maxUncompressedMb, DFLT_MB, 'мусор снял лимит');
  assert.equal(child({ PANEL_MAX_UNCOMPRESSED_MB: '999999' }).maxUncompressedMb, DFLT_MB, 'значение вне диапазона принято');
  assert.equal(child({ PANEL_MAX_UNCOMPRESSED_MB: '1' }).maxUncompressedMb, 1, 'нижняя граница диапазона не принята');
  assert.equal(child({ PANEL_MAX_ZIP_ENTRIES: '0' }).maxZipEntries, DFLT_ENTRIES, 'число файлов не ограничено');
  assert.equal(child({ PANEL_MAX_ZIP_ENTRIES: '-1' }).maxZipEntries, DFLT_ENTRIES, 'отрицательное число файлов принято');

  // Тот же предел защищён и от подмены через config.json.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cfg-json-'));
  try {
    fs.writeFileSync(path.join(work, 'config.json'), JSON.stringify({ maxUncompressedMb: 0 }));
    const script = [
      `process.env.PANEL_DATA_DIR = ${JSON.stringify(work)};`,
      "const { config } = require(process.argv[1]);",
      "process.stdout.write(String(config.maxUncompressedMb));",
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', script, configPath], {
      env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.equal(Number(out), DFLT_MB, 'config.json с maxUncompressedMb: 0 снял лимит');
  } finally {
    rmrf(work);
  }
});

/* =========================================================================
 * T-40 — два параллельных node-сайта: разные порты, чужие процессы целы
 * ========================================================================= */

test('T-40: параллельные деплои получают разные порты, остановка A не убивает B', async (t) => {
  const { panel, tmp } = await withPanel(t);

  const [a, b] = await Promise.all([
    uploadSite(panel, tmp, 'par-a', nodeSite('a')),
    uploadSite(panel, tmp, 'par-b', nodeSite('b')),
  ]);

  assert.ok(a.port && b.port, `порты не выделены: a=${a.port} b=${b.port}`);
  assert.notEqual(a.port, b.port, `два параллельных деплоя получили ОДИН порт ${a.port} (P-17)`);
  await waitFor(async () => (await getInternal(a.port)).status === 200, { timeout: 20000, label: 'сайт A отвечает' });
  await waitFor(async () => (await getInternal(b.port)).status === 200, { timeout: 20000, label: 'сайт B отвечает' });
  assert.equal((await getInternal(a.port)).body, 'a');
  assert.equal((await getInternal(b.port)).body, 'b');

  // Останавливаем A: B обязан продолжать работать (ensurePortFreed не должен
  // трогать процессы, не принадлежащие этому сайту, P-18).
  const stopA = await api(panel, 'POST', `/api/sites/${a.id}/stop`);
  assert.equal(stopA.status, 200, `остановка A: ${stopA.status} ${stopA.text.slice(0, 200)}`);
  assert.equal((await getInternal(b.port)).status, 200, 'остановка сайта A убила сайт B');
  assert.equal((await getInternal(b.port)).body, 'b');
  const bInfo = await api(panel, 'GET', `/api/sites/${b.id}`);
  assert.equal(bInfo.data.status, 'running', `сайт B перестал быть running: ${JSON.stringify(bInfo.data.status)}`);

  // Порт A занимает ПОСТОРОННИЙ процесс (сам тест). ensurePortFreed обязан
  // увидеть чужой pid и не отправить сигнал: прежняя версия била SIGKILL по
  // любому pid из lsof и убивала чужой процесс (P-18).
  //
  // Слушатель отвечает НАСТОЯЩИМ HTTP: иначе http.request падает на разборе
  // ответа и тест «доказывает» убийство чужого процесса там, где его не было.
  const FOREIGN_BODY = 'foreign-ok';
  const foreign = net.createServer((sock) => {
    sock.on('error', () => { /* клиент ушёл — не наша забота */ });
    sock.end(
      'HTTP/1.1 200 OK\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${FOREIGN_BODY.length}\r\n` +
      'Connection: close\r\n\r\n' +
      FOREIGN_BODY
    );
  });
  await new Promise((resolve, reject) => {
    foreign.once('error', reject);
    foreign.listen(a.port, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await Promise.race([
      new Promise((resolve) => { if (foreign.listening) foreign.close(() => resolve()); else resolve(); }),
      sleep(3000),
    ]);
  });

  const stopAgain = await api(panel, 'POST', `/api/sites/${a.id}/stop`);
  assert.equal(stopAgain.status, 200, `повторная остановка A: ${stopAgain.status}`);
  // Порт A держит ПОСТОРОННИЙ процесс, и панель обязана это признать: прежний код
  // отбрасывал результат ensurePortFreed и всегда отвечал {ok:true} — «остановлено»,
  // хотя порт занят, а следующий запуск упал бы с EADDRINUSE (P-19).
  assert.equal(stopAgain.data.ok, false,
    `остановка при чужом процессе на порту объявлена успехом: ${JSON.stringify(stopAgain.data)}`);
  assert.match(String(stopAgain.data.error || ''), /порт/i,
    `в ошибке нет упоминания порта: ${JSON.stringify(stopAgain.data)}`);

  // Если бы панель убила «владельца порта» A, этим процессом был бы сам тест —
  // поэтому проверяем, что он жив и по-прежнему отвечает на порту A.
  assert.ok(proc.isAlive(process.pid), 'панель убила посторонний процесс, владеющий портом');
  const foreignAnswer = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: a.port, path: '/', method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
  assert.equal(foreignAnswer.status, 200, 'посторонний слушатель порта A перестал отвечать — его убили');
  assert.equal(foreignAnswer.body, FOREIGN_BODY, 'на порту A отвечает уже не посторонний процесс');

  // И B по-прежнему цел.
  assert.equal((await getInternal(b.port)).status, 200, 'сайт B пострадал от остановки A');
});

/* =========================================================================
 * T-41 — прерывание отката
 * ========================================================================= */

test('T-41: откат не оставляет сайт без каталога, сломанная версия — как .broken', async (t) => {
  ensureDataDirs();
  const site = {
    id: 'rollback41', name: 'rollback41', type: 'static', status: 'stopped',
    domains: [], port: null, autoStart: false, startCommand: null,
  };
  const dir = path.join(config.sitesDir, site.id);
  t.after(() => { rmrf(dir); rmrf(dir + '.backup'); rmrf(dir + '.broken'); });

  // Сайт с «сломанной» текущей версией и рабочей версией в .backup.
  rmrf(dir); rmrf(dir + '.backup'); rmrf(dir + '.broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), 'новая-сломанная');
  fs.mkdirSync(dir + '.backup', { recursive: true });
  fs.writeFileSync(path.join(dir + '.backup', 'index.html'), 'прежняя-рабочая');

  const res = await manager.rollback(site);
  assert.equal(res.ok, true, `откат не выполнен: ${JSON.stringify(res)}`);

  // Главное требование PLAN.md: каталог сайта существует ВСЕГДА — даже если
  // между удалением и rename что-то упало. Прежняя версия возвращается из
  // .backup, а сломанная остаётся рядом как .broken (P-20).
  assert.ok(fs.existsSync(dir), 'откат оставил сайт без каталога (P-20)');
  assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), 'прежняя-рабочая',
    'после отката работает не прежняя версия');
  assert.ok(fs.existsSync(dir + '.broken'), 'сломанная версия потеряна — её нельзя разобрать');
  assert.equal(fs.readFileSync(path.join(dir + '.broken', 'index.html'), 'utf8'), 'новая-сломанная',
    '.broken содержит не сломанную версию');
  assert.ok(!fs.existsSync(dir + '.backup'), '.backup не израсходован на откат');
  assert.equal(site.type, 'static', `тип сайта не пересчитан: ${site.type}`);
});

/* =========================================================================
 * T-42 — память при чтении логов
 * ========================================================================= */

test('T-42: чтение хвоста большого лога не растит память, лимиты ограничены', async (t) => {
  ensureDataDirs();
  const id = 'log42big';
  const site = { id, name: id, type: 'node', status: 'stopped', domains: [], port: null };
  const file = manager.siteLogFile(site);
  t.after(() => rmrf(file));

  const block = [];
  let lineNo = 0;
  while (block.join('').length < 1024 * 1024) {
    block.push(`строка-${String(lineNo).padStart(6, '0')} ${'z'.repeat(96)}\n`);
    lineNo++;
  }
  const blockBuf = Buffer.from(block.join(''));
  const fd = fs.openSync(file, 'w');
  try {
    for (let k = 0; k < 32; k++) fs.writeSync(fd, blockBuf); // ~32 МБ
  } finally {
    fs.closeSync(fd);
  }
  const total = fs.statSync(file).size;
  assert.ok(total > 30 * 1024 * 1024, `лог слишком мал: ${total} байт`);

  // Если бы файл читался целиком (как до P-02/P-23), прирост heap был бы не
  // меньше размера файла. Проверяем именно отсутствие пропорциональности.
  global.gc && global.gc();
  const before = process.memoryUsage().heapUsed;
  const tail = manager.readLogTail(site, 200);
  const after = process.memoryUsage().heapUsed;
  const grown = Math.max(0, after - before);
  assert.ok(grown < 24 * 1024 * 1024,
    `чтение хвоста лога ${total} байт выросло в памяти на ${(grown / 1048576).toFixed(1)} МБ (P-23)`);
  assert.ok(tail.length > 0, 'хвост пуст');
  assert.ok(tail.split('\n').length <= 200, `в хвосте больше 200 строк: ${tail.split('\n').length}`);

  // Пределы, которые обязаны держать и буферы журнала, и вывод команд.
  assert.ok(config.logTailMaxBytes >= 4096 && config.logTailMaxBytes <= 16 * 1024 * 1024,
    `logTailMaxBytes вне допустимого диапазона: ${config.logTailMaxBytes}`);
  assert.ok(config.cmdOutputMaxBytes >= 4096 && config.cmdOutputMaxBytes <= 16 * 1024 * 1024,
    `cmdOutputMaxBytes вне допустимого диапазона: ${config.cmdOutputMaxBytes}`);
  assert.ok(config.cmdOutputMaxBytes < total,
    `вывод команды (${config.cmdOutputMaxBytes}) не ограничен размером лога (${total})`);
});

/* =========================================================================
 * T-43 — завершение панели и boot()
 * ========================================================================= */

test('T-43: завершение панели освобождает порт сайта, новый boot без EADDRINUSE', async (t) => {
  const tmp = mkTmp(t);
  const copies = [];

  const panel = await startPanel({});
  let site = null;
  try {
    site = await uploadSite(panel, tmp, 'shutdown43', nodeSite('v1'));
    await waitFor(async () => (await getInternal(site.port)).status === 200, {
      timeout: 20000, label: 'сайт запущен',
    });
    const port = site.port;

    // Штатное завершение (systemctl stop): панель обязана погасить дерево
    // процессов сайта, иначе следующий старт получит EADDRINUSE (SP-09).
    const pid = readPanelPid(panel.dataDir);
    process.kill(pid, 'SIGTERM');
    await waitProcessExit(pid, 20000);
    assert.equal(proc.isAlive(pid), false, 'панель не завершилась по SIGTERM');

    await waitFor(async () => !(await proc.portBusy(port)), {
      timeout: 15000, interval: 250, label: `порт ${port} освобождён после остановки панели`,
    });
    assert.ok(!proc.isAlive(pid), 'панель воскресла');

    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-dur-copy-'));
    copies.push(copy);
    copyDirInto(panel.dataDir, copy);
    await panel.stop();

    // Новая панель на тех же данных обязана подняться и поднять сайт на том же
    // порту (EADDRINUSE означал бы живого сироту или незакрытый сокет).
    const panel2 = await startPanel({}, { prepare: (dir) => copyDirInto(copy, dir) });
    try {
      await waitFor(async () => (await getInternal(port)).status === 200, {
        timeout: 30000, interval: 500, label: 'сайт поднялся после перезапуска панели',
      });
      // Порт отвечает РАНЬШЕ, чем manager успевает перевести статус в running:
      // waitListening опрашивает порт с интервалом. Поэтому ждём статус, а не
      // проверяем его мгновенно после первого ответа — иначе тест падал бы на
      // «starting», хотя сайт уже работает (гонка самого теста).
      const info = await waitFor(async () => {
        const r = await api(panel2, 'GET', `/api/sites/${site.id}`);
        return r.data && r.data.status === 'running' ? r.data : false;
      }, { timeout: 30000, interval: 300, label: 'статус сайта стал running после boot()' });
      assert.equal(info.port, port, 'сайт получил другой порт — прежний остался занят');
    } finally {
      await panel2.stop();
    }
  } finally {
    try { await panel.stop(); } catch { /* уже остановлена */ }
    for (const c of copies) rmrf(c);
  }
});

/* =========================================================================
 * 2.2 (SP-05) — install/build-подпроцессы деплоя гасятся при остановке панели
 * ========================================================================= */

test('SP-05: install-подпроцесс деплоя гасится по killActiveCommands, а не живёт после панели',
  { skip: !isPosix && 'только POSIX' }, async (t) => {
    ensureDataDirs();
    const work = mkTmp(t);

    // Команда живёт дольше, чем мы её наблюдать: если бы её никто не гасил,
    // она продолжила бы писать в data/tmp уже после выхода панели (SP-05).
    const started = Date.now();
    const running = runCommand('sleep 60', work, null, 60000);
    await sleep(700);
    const alivePids = [...deployfiles.activeCommands].map((c) => c.pid);
    assert.ok(alivePids.length >= 1, 'подпроцесс не зарегистрирован в реестре деплоя');

    const killed = manager.killActiveCommands('SIGKILL');
    assert.ok(killed.length >= 1, `killActiveCommands ничего не погасил: ${JSON.stringify(killed)}`);

    const res = await running;
    const ms = Date.now() - started;
    assert.ok(res.code !== 0, `убитая команда отчиталась успехом: ${JSON.stringify(res)}`);
    assert.ok(ms < 20000, `команда не была погашена, ждали ${ms} мс`);
    assert.equal(deployfiles.activeCommands.size, 0,
      'реестр деплоя не очистился после завершения команды — утечка ссылок на процессы');
  });

test('T-43: boot() не сбрасывает бэкофф сайту в статусе crashed', async (t) => {
  ensureDataDirs();
  const site = {
    id: 'boot43backoff', name: 'boot43backoff', type: 'node', status: 'crashed',
    domains: [], port: null, autoStart: true, startCommand: 'node server.js',
    restartAttempts: 3, restartCount: 3, lastCrashAt: Date.now(),
  };
  const saved = store.state.sites;
  store.state.sites = [site];
  t.after(() => {
    store.state.sites = saved;
    proc.removePidFile(site.id);
    rmrf(path.join(config.sitesDir, site.id));
  });

  await manager.boot();
  await sleep(500);

  // Каталога у сайта нет, поэтому автозапуск в boot() не поднимает процесс, но
  // серию падений он сбрасывать НЕ должен: иначе сайт, падающий сразу, получал
  // бы на каждом старте панели свежий счётчик и никогда не дошёл до лимита (P-25).
  assert.equal(site.restartAttempts, 3, 'boot() сбросил счётчик перезапусков сайту в статусе crashed');

  // Контраст: ручной запуск счётчик сбрасывает — проверка не вырождена.
  const manual = await manager.start(site, { manual: true });
  assert.equal(manual.ok, false, `запуск без каталога не должен «удаваться»: ${JSON.stringify(manual)}`);
  assert.match(String(manual.error), /Каталог сайта не найден/, `непонятная ошибка запуска: ${manual.error}`);
  assert.equal(site.restartAttempts, 0, 'ручной запуск не сбросил счётчик');
});

/* =========================================================================
 * T-44 — исчезнувший каталог сайта
 * ========================================================================= */

test('T-44: исчезнувший каталог сайта даёт понятную ошибку, а не 500 и не starting', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'gonedir44', nodeSite('v1'));
  await waitFor(async () => (await getInternal(site.port)).status === 200, {
    timeout: 20000, label: 'сайт запущен',
  });

  const dir = path.join(panel.dataDir, 'sites', site.id);
  assert.ok(fs.existsSync(dir), 'каталог сайта не создан');
  rmrf(dir);
  assert.ok(!fs.existsSync(dir), 'каталог не удалён — тест проверяет не то');

  const res = await api(panel, 'POST', `/api/sites/${site.id}/restart`);
  assert.equal(res.status, 200, `API вернул ${res.status} вместо понятного ответа: ${res.text.slice(0, 200)}`);
  assert.equal(res.data.ok, false, `запуск без каталога объявлен успехом: ${JSON.stringify(res.data)}`);
  assert.match(String(res.data.error), /Каталог сайта не найден/i, `нечитаемая ошибка: ${JSON.stringify(res.data)}`);

  const info = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.equal(info.status, 200, `GET сайта вернул ${info.status}`);
  assert.notEqual(info.data.status, 'starting', 'статус застрял в starting (P-27)');
  assert.notEqual(info.data.status, 'running', 'сайт объявлен running без каталога');
  assert.ok(['stopped', 'crashed'].includes(info.data.status),
    `неожиданный статус сайта: ${info.data.status}`);
});

/* =========================================================================
 * T-45 — файловый менеджер во время деплоя
 * ========================================================================= */

test('T-45: файловые операции во время деплоя не ломают каталог сайта', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'fm45', nodeSite('v1'));
  await waitFor(async () => (await getInternal(site.port)).status === 200, {
    timeout: 20000, label: 'v1 отвечает',
  });

  const dir = path.join(panel.dataDir, 'sites', site.id);
  // Файловые операции идут в ТОТ ЖЕ каталог, который деплой подменяет двумя
  // rename. Без общей блокировки запись попадала в каталог, которого уже нет,
  // либо в старую версию, которая через миг переставала быть сайтом (P-31).
  const [put, del, upd] = await Promise.all([
    api(panel, 'PUT', `/api/sites/${site.id}/file`, { path: 'extra.txt', content: 'x'.repeat(200) }),
    api(panel, 'DELETE', `/api/sites/${site.id}/file?path=extra.txt`),
    updateSite(panel, tmp, site.id, 'fm45-v2', nodeSite('v2')),
  ]);

  // Файловые операции либо применились, либо честно не нашли файл: «зависших»
  // и 5xx быть не должно.
  for (const [name, r] of [['PUT', put], ['DELETE', del]]) {
    assert.ok([200, 404].includes(r.status),
      `${name} файла во время деплоя вернул ${r.status}: ${r.text.slice(0, 200)}`);
  }

  assert.equal(upd.status, 200, `обновление упало по HTTP: ${upd.status} ${upd.text.slice(0, 200)}`);
  const ok = upd.data.ok === true;

  // Каталог сайта существует и содержит ЦЕЛОЕ дерево, а не половину.
  assert.ok(fs.existsSync(dir), 'после конкурентного деплоя каталог сайта пропал');
  for (const f of ['package.json', 'server.js']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `в каталоге сайта нет ${f} — дерево недособрано`);
  }

  // Флаг ok обязан быть честным: «успешно» означает, что работает НОВАЯ версия.
  const answer = await waitFor(async () => {
    const r = await getInternal(site.port);
    return r.status === 200 ? r : false;
  }, { timeout: 20000, interval: 500, label: 'сайт отвечает после конкурентного деплоя' });

  if (ok) {
    assert.equal(answer.body, 'v2', `деплой отчитался ok=true, но работает «${answer.body}»`);
  } else {
    assert.notEqual(answer.body, 'v2', 'деплой отчитался провалом, но обслуживается новая версия');
  }

  const info = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.equal(info.status, 200);
  assert.ok(['running', 'crashed', 'stopped'].includes(info.data.status),
    `неожиданный статус после конкурентных операций: ${info.data.status}`);
});

/* =========================================================================
 * P-31 — распаковка архива из файлового менеджера требует явного подтверждения
 * ========================================================================= */

test('P-31: extract=1 без confirm=1 отвергается, архив не распакован и не потерян', async (t) => {
  const { panel, tmp } = await withPanel(t);
  const site = await uploadSite(panel, tmp, 'fm31', { 'index.html': '<h1>ok</h1>' });
  const dir = path.join(panel.dataDir, 'sites', site.id);

  // Архив с ДВУМЯ записями: одна в подкаталоге, одна в корне. Так распаковка
  // НЕ схлопывает единственную корневую папку (extractZip раскрывает её), и
  // проверка «появилось ли дерево» однозначна.
  const zip = makeZipAt(tmp, 'payload31', {
    'root31.txt': 'root',
    'inner31/secret.txt': 'boom',
  });
  const zipBuf = fs.readFileSync(zip);

  const uploadZip = async (extract, confirm) => {
    const form = new FormData();
    form.append('file', new Blob([zipBuf]), 'payload31.zip');
    form.append('path', '');
    if (extract) form.append('extract', extract);
    if (confirm) form.append('confirm', confirm);
    const res = await fetch(panel.base + `/api/sites/${site.id}/files/upload`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      body: form,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* не json */ }
    return { status: res.status, data, text };
  };

  // Без подтверждения распаковки НЕТ: иначе содержимое каталога заменялось бы
  // побочным эффектом одного поля формы (P-31).
  const noConfirm = await uploadZip('1', null);
  assert.equal(noConfirm.status, 400,
    `распаковка без подтверждения принята: ${noConfirm.status} ${noConfirm.text.slice(0, 200)}`);
  assert.match(String(noConfirm.data && noConfirm.data.error), /подтвержд/i);
  assert.ok(!fs.existsSync(path.join(dir, 'inner31')), 'распаковано без подтверждения');

  // С подтверждением — распаковывается, и архив (сам файл) удаляется.
  const withConfirm = await uploadZip('1', '1');
  assert.equal(withConfirm.status, 200,
    `распаковка с подтверждением упала: ${withConfirm.status} ${withConfirm.text.slice(0, 300)}`);
  assert.equal(withConfirm.data.extracted, true);
  assert.ok(fs.existsSync(path.join(dir, 'inner31', 'secret.txt')), 'архив не распакован при confirm=1');
  assert.ok(fs.existsSync(path.join(dir, 'root31.txt')), 'файл из корня архива не распакован');
  assert.ok(!fs.existsSync(path.join(dir, 'payload31.zip')), 'архив остался на диске после распаковки');

  // Обычная загрузка (без extract) подтверждения не требует.
  const plain = await uploadZip(null, null);
  assert.equal(plain.status, 200, `обычная загрузка отвергнута: ${plain.text.slice(0, 200)}`);
  assert.equal(plain.data.extracted, false);
});

/* =========================================================================
 * M-01 — монитор стартует ПОСЛЕ manager.boot()
 * ========================================================================= */

test('M-01: monitor/dashboard/alerts стартуют после manager.boot()', async (t) => {
  // Поведенчески гонку «тик монитора раньше подъёма сайтов» поймать нельзя:
  // первый тик отложен на 5 с, а boot() на быстром стенде успевает раньше.
  // Поэтому проверяем сам ПОРЯДОК в src/index.js: если монитор снова окажется
  // выше boot(), первый тик успеет записать 'crashed' живому сайту — панель
  // покажет работающий сайт упавшим (M-01). Тест статический и намеренно
  // «прибит» к порядку строк, как tests/routes-lint.test.js.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  const bootAt = src.indexOf('await manager.boot()');
  assert.ok(bootAt >= 0, 'в src/index.js нет await manager.boot()');

  for (const call of ['monitor.start()', 'dashboard.start()', 'alerts.start()']) {
    const at = src.indexOf(call);
    assert.ok(at >= 0, `в src/index.js нет ${call}`);
    assert.ok(at > bootAt,
      `${call} вызывается РАНЬШЕ manager.boot() (строка ${src.slice(0, at).split('\n').length} против ${src.slice(0, bootAt).split('\n').length}) — тик монитора запишет crashed живому сайту (M-01)`);
  }
});

/* =========================================================================
 * T-34 (дополнение) — остальные ветки защиты от zip-бомб
 * =========================================================================
 * Первая версия T-34 проверяла только «заявлен 3 ГБ» и «заявлен 0» через
 * assert.throws. Этого мало: подмену `limit = declared` (то есть отказ от
 * собственного ограничения распаковки) тест НЕ ловил, потому что падение
 * приходило из ДРУГОЙ проверки, а проверки CRC и числа записей не были
 * покрыты вообще. Здесь каждая защита проверяется по своему признаку.
 */

/** Порча CRC в local и central заголовках при ЦЕЛЫХ размерах и данных. */
function patchCrc(buf) {
  const SIG_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const SIG_CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let patched = 0;
  let i = buf.indexOf(SIG_LOCAL);
  if (i !== -1) {
    buf.writeUInt32LE((buf.readUInt32LE(i + 14) ^ 0xffffffff) >>> 0, i + 14);
    patched++;
  }
  let j = buf.indexOf(SIG_CENTRAL);
  if (j !== -1) {
    buf.writeUInt32LE((buf.readUInt32LE(j + 16) ^ 0xffffffff) >>> 0, j + 16);
    patched++;
  }
  return patched;
}

test('T-34: архив с испорченным CRC при целых размерах отклоняется', async (t) => {
  ensureDataDirs();
  const work = mkTmp(t);
  const target = path.join(config.tmpDir, 'crc-target-34');
  t.after(() => rmrf(target));

  const AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip'));
  const limit = config.maxZipEntries;
  const before = path.join(config.tmpDir, 'crc-target-34-clean');
  t.after(() => rmrf(before));

  // ВАЖНО: `zip.toBuffer()` отдаёт ОДИН И ТОТ ЖЕ закешированный буфер, поэтому
  // портить его до контроля нельзя — иначе «честный» архив окажется уже
  // испорченным, и контроль упадёт на той же проверке CRC (именно так и было).
  // Сначала распаковываем заведомо целый архив, потом портим ЕГО КОПИЮ.
  const clean = new AdmZip();
  clean.addFile('a.txt', Buffer.from('hello crc world '.repeat(40), 'utf8'));
  const cleanBuf = clean.toBuffer();
  assert.equal(manager.extractZip(cleanBuf, before).files, 1, 'честный архив не распакован');
  assert.equal(limit, config.maxZipEntries, 'лимит записей изменился во время теста');

  const buf = Buffer.from(cleanBuf); // копия — оригинал остаётся целым
  assert.equal(patchCrc(buf), 2, 'не удалось испортить CRC — тест проверяет не то');

  rmrf(target);
  // Своя распаковка (getCompressedData + zlib) не проверяет CRC сама — без
  // явной проверки повреждённый архив распаковался бы МОЛЧА и сайт получил бы
  // битые данные вместо честной ошибки (P-15).
  assert.throws(() => manager.extractZip(buf, target), /CRC32/,
    'архив с испорченным CRC принят — проверка целостности отсутствует');
  if (fs.existsSync(target)) {
    const left = fs.readdirSync(target, { recursive: true });
    assert.equal(left.length, 0, `из отклонённого архива распаковано: ${JSON.stringify(left).slice(0, 200)}`);
  }
});

test('T-34: архив с числом записей больше лимита отклоняется до распаковки', async (t) => {
  ensureDataDirs();
  const work = mkTmp(t);
  const target = path.join(config.tmpDir, 'entries-target-34');
  t.after(() => rmrf(target));

  const AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip'));
  const zip = new AdmZip();
  zip.addFile('a.txt', Buffer.from('a'));
  zip.addFile('b.txt', Buffer.from('b'));
  const buf = zip.toBuffer();

  // Лимит сужаем на время теста: 50000 файлов делать незачем, важна ветка.
  const before = config.maxZipEntries;
  config.maxZipEntries = 1;
  try {
    rmrf(target);
    assert.throws(() => manager.extractZip(buf, target), /слишком много файлов/i,
      'архив с числом записей больше лимита принят');
    assert.ok(!fs.existsSync(target), `каталог ${target} создан до проверки числа записей`);
  } finally {
    config.maxZipEntries = before;
  }

  // Контроль: при лимите 2 тот же архив проходит.
  const okTarget = path.join(config.tmpDir, 'entries-target-34-ok');
  t.after(() => rmrf(okTarget));
  assert.equal(manager.extractZip(buf, okTarget).files, 2);
});

test('T-34: подделанный размер «0» при реальных данных не растит память', async (t) => {
  ensureDataDirs();
  const work = mkTmp(t);
  const target = path.join(config.tmpDir, 'bomb0-target-34');
  t.after(() => rmrf(target));

  // 200 МБ нулей сжимаются в ~200 КБ. Патчим ЗАЯВЛЕННЫЙ размер в 0, оставляя
  // сжатые данные настоящими: именно такую бомбу header.size не выдаёт.
  const AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip'));
  const zip = new AdmZip();
  zip.addFile('payload.bin', Buffer.alloc(200 * 1024 * 1024));
  const buf = patchDeclaredSizes(zip.toBuffer(), 0);
  assert.ok(buf.length < 1024 * 1024, `архив должен быть крошечным, а он ${buf.length} байт`);

  global.gc && global.gc();
  const rssBefore = process.memoryUsage().rss;
  rmrf(target);

  // Проверяем ПРИЧИНУ отказа, а не факт исключения: без собственного
  // ограничения распаковки zlib падает на maxOutputLength=0 с «out of range»,
  // и assert.throws прошёл бы, хотя память уже выделена.
  let err = null;
  try {
    manager.extractZip(buf, target);
  } catch (e) {
    err = e;
  }
  const rssDelta = process.memoryUsage().rss - rssBefore;

  assert.ok(err, 'zip-бомба с заявленным размером 0 распакована');
  assert.match(err.message, /распаковывается больше чем/i,
    `отказ пришёл не из ограничения распаковки: ${err.message}`);
  assert.ok(rssDelta < 120 * 1024 * 1024,
    `распаковка съела ${Math.round(rssDelta / 1048576)} МБ памяти — лимит не защищает (P-15)`);
  if (fs.existsSync(target)) {
    const left = fs.readdirSync(target, { recursive: true });
    assert.equal(left.length, 0, `на диск попало: ${JSON.stringify(left).slice(0, 200)}`);
  }
});

/* =========================================================================
 * H-06 — во время деплоя публичный запрос получает 503 с Retry-After
 * ========================================================================= */

test('H-06: во время деплоя публичный запрос получает 503 с Retry-After', async (t) => {
  // Приложение открывает порт только через 6 с: пока оно не слушает, деплой
  // ещё идёт, и признак деплоя активен.
  const SLOW_SERVER = [
    "const http = require('http');",
    'setTimeout(() => {',
    "  const s = http.createServer((q, r) => r.end('slow-ok'));",
    "  s.listen(Number(process.env.PORT), '127.0.0.1');",
    '}, 6000);',
  ].join('\n');

  const { panel, tmp } = await withPanel(t, { PANEL_APP_LISTEN_WAIT_MS: '15000' });
  const slow = { 'package.json': PKG('node server.js'), 'server.js': SLOW_SERVER };

  const site = await uploadSite(panel, tmp, 'slow06', slow);
  const dom = await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'slow.local' });
  assert.equal(dom.status, 200, `домен не привязан: ${dom.status} ${dom.text.slice(0, 200)}`);
  await waitFor(async () => (await getInternal(site.port)).status === 200, {
    timeout: 25000, interval: 500, label: 'медленная версия отвечает',
  });

  // Обновление: панель останавливает сайт, и до запуска новой версии запрос
  // посетителя обязан получить 503 + Retry-After, а не «сайт отключён» без
  // подсказки или вообще ничего (SP-07/H-06).
  const upd = updateSite(panel, tmp, site.id, 'slow06-v2', {
    'package.json': PKG('node server.js'),
    'server.js': SLOW_SERVER.replace('slow-ok', 'slow-ok-2'),
  });

  const probes = [];
  for (let i = 0; i < 8; i++) {
    await sleep(700);
    probes.push(await Promise.race([
      fetchWithHost(panel.httpPort, 'slow.local', '/').catch((e) => ({ status: 0, error: e.code || e.message, headers: {} })),
      sleep(5000).then(() => ({ status: 'timeout', headers: {} })),
    ]));
  }
  const res = await upd;

  const during = probes.filter((p) => p.status === 503);
  assert.ok(during.length > 0,
    `ни одна проба во время деплоя не получила 503: ${JSON.stringify(probes.map((p) => p.status))}`);
  assert.ok(during.every((p) => p.headers && p.headers['retry-after']),
    `503 без Retry-After — клиент не знает, когда повторить: ${JSON.stringify(during.map((p) => p.headers))}`);
  assert.ok(during.every((p) => Number(p.headers['retry-after']) >= 1),
    `Retry-After не число секунд: ${JSON.stringify(during.map((p) => p.headers['retry-after']))}`);
  assert.equal(res.status, 200, `обновление упало по HTTP: ${res.status} ${res.text.slice(0, 200)}`);

  // После деплоя прежний 503 сменяется рабочим ответом.
  const after = await waitFor(async () => {
    const r = await fetchWithHost(panel.httpPort, 'slow.local', '/').catch(() => ({ status: 0 }));
    return r.status === 200 ? r : false;
  }, { timeout: 25000, interval: 500, label: 'сайт отвечает после деплоя' });
  assert.equal(after.body, 'slow-ok-2', `после деплоя обслуживается «${after.body}»`);
});

/* =========================================================================
 * H-06 — зависший апстрим не держит сокет бесконечно
 * ========================================================================= */

test('H-06: молчащий апстрим обрывается по proxyTimeout, а не висит', async (t) => {
  // Приложение принимает TCP-соединение (порт открыт — панель считает сайт
  // запущенным) и НИКОГДА не отвечает.
  const TARPIT = [
    "const net = require('net');",
    "setTimeout(() => net.createServer(() => {}).listen(Number(process.env.PORT), '127.0.0.1'), 100);",
  ].join('\n');

  const { panel, tmp } = await withPanel(t, { PANEL_PROXY_TIMEOUT_MS: '3000' });
  const site = await uploadSite(panel, tmp, 'hang06', { 'package.json': PKG('node server.js'), 'server.js': TARPIT });
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'hang.local' });

  const t0 = Date.now();
  const res = await Promise.race([
    fetchWithHost(panel.httpPort, 'hang.local', '/').catch((e) => ({ status: 0, error: e.code || e.message })),
    sleep(20000).then(() => ({ status: 'timeout' })),
  ]);
  const ms = Date.now() - t0;

  // Без proxyTimeout/timeout у createProxyServer клиент не получал НИ ответа,
  // НИ обрыва: сокет и дескрипторы оставались занятыми навсегда (H-06).
  assert.notEqual(res.status, 'timeout', `запрос к молчащему апстриму висел ${ms} мс — таймаут прокси не работает`);
  assert.ok([502, 503, 504].includes(res.status),
    `неожиданный ответ вместо 502/504: ${JSON.stringify(res).slice(0, 200)}`);
  assert.ok(ms < 15000, `таймаут прокси сработал только через ${ms} мс (задан 3000 мс)`);
});

/* =========================================================================
 * T-31 — недоступный cwd: спавн падает, сайт получает crashed, а не starting
 * ========================================================================= */

test('T-31: сбой спавна процесса даёт crashed и причину в логе, а не вечный starting', async (t) => {
  const { panel, tmp } = await withPanel(t, { PANEL_APP_LISTEN_WAIT_MS: '1500' });
  const site = await uploadSite(panel, tmp, 'badcwd31', nodeSite('v1'));
  await waitFor(async () => (await getInternal(site.port)).status === 200, {
    timeout: 20000, label: 'сайт запущен',
  });
  await api(panel, 'POST', `/api/sites/${site.id}/stop`);

  // Каталог подменяем ОБЫЧНЫМ ФАЙЛОМ: existsSync его видит, поэтому проверка
  // «каталога нет» не срабатывает. ПРОБА (.vps/probe-serror.cjs на сервере)
  // показала, что при `shell: true` такой cwd даёт СИНХРОННЫЙ бросок
  // `spawn ENOTDIR` из самого spawn (а не событие 'error'), и раньше исключение
  // улетало в wrap() как HTTP 500, оставляя сайт в 'starting' (P-27). Именно
  // этот путь ловит try/catch вокруг attemptStart; асинхронный child.on('error')
  // остаётся страховкой на случай, когда недоступен сам /bin/sh.
  const dir = path.join(panel.dataDir, 'sites', site.id);
  rmrf(dir);
  fs.writeFileSync(dir, 'not a directory');

  const res = await api(panel, 'POST', `/api/sites/${site.id}/restart`);
  assert.equal(res.status, 200, `API вернул ${res.status}: ${res.text.slice(0, 200)}`);
  assert.equal(res.data.ok, false, `запуск с недоступным cwd объявлен успехом: ${JSON.stringify(res.data)}`);

  const info = await api(panel, 'GET', `/api/sites/${site.id}`);
  assert.equal(info.status, 200);
  assert.notEqual(info.data.status, 'starting', 'статус застрял в starting после сбоя спавна');
  assert.notEqual(info.data.status, 'running', 'сайт объявлен running, хотя процесс не стартовал');
  assert.equal(info.data.status, 'crashed', `ожидался crashed, получен ${info.data.status}`);

  const logs = await api(panel, 'GET', `/api/sites/${site.id}/logs?lines=100`);
  assert.equal(logs.status, 200);
  assert.match(String(logs.data.log), /не удалось запустить процесс/,
    `в логе нет причины сбоя спавна:\n${String(logs.data.log).slice(-600)}`);
});

/* =========================================================================
 * P-26 — setStatusIf не затирает статус, выставленный другой операцией
 * ========================================================================= */

test('P-26: setStatusIf меняет статус только при ожидаемом текущем', async (t) => {
  ensureDataDirs();
  const site = { id: 'setst26', name: 'setst26', type: 'node', status: 'starting', domains: [], port: null };
  const saved = store.state.sites;
  store.state.sites = [site];
  t.after(() => { store.state.sites = saved; });

  // Тик монитора стартовал ДО деплоя и видит запись, которой уже нет. Прямая
  // запись перетирала 'starting'/'stopped' и роняла сайт в 'crashed' посреди
  // работы. setStatusIf обязан применить переход только при совпадении.
  assert.equal(manager.setStatusIf(site, 'running', 'crashed'), false,
    'setStatusIf применил переход, хотя текущий статус не совпал (P-26)');
  assert.equal(site.status, 'starting', `статус затёрт на ${site.status}`);

  // Контроль: при совпадении переход применяется — проверка не вырождена.
  assert.equal(manager.setStatusIf(site, ['starting', 'running'], 'crashed'), true);
  assert.equal(site.status, 'crashed');
});
