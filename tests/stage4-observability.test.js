'use strict';

// Регрессии этапа 4 плана: наблюдаемость и эксплуатация.
//   M-02  телеметрия (health/fails) писалась в db.json каждые 30 с, тики
//         монитора наслаивались;
//   M-03  история проверок удалённого сайта оставалась в памяти навсегда;
//   M-04  hardenDataDir обходил всё дерево data/ при каждом старте;
//   M-05  diskCheckedAt ставился до вызова readDisk(): карточка диска при сбое
//         показывала старое значение, а rejection уходил в unhandledRejection;
//   SP-22 защёлки алертов жили только в памяти — после рестарта алерт
//         повторялся, «восстановился» не приходило;
//   H-10  TRACE не обрабатывался публичным прокси, у статики не было
//         X-Sitepanel-Site; перепроверка блокировки закодированных путей.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { startPanel, api, makeZip, sleep } = require('./helpers/panel');

const isPosix = process.platform !== 'win32';

/* ---------- M-02: телеметрия не попадает в db.json ---------- */

test('M-02: тик монитора пишет health в память, но не в db.json', async (t) => {
  const panel = await startPanel({ PANEL_MONITOR_TICK_MS: '300' });
  t.after(() => panel.stop());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-stage4-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

  const zip = path.join(tmp, 'tele.zip');
  makeZip(path.join(tmp, 'tele'), { 'index.html': '<h1>ok</h1>' }, zip);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), 'tele.zip');
  form.append('name', 'tele');
  form.append('autoStart', 'true');
  const created = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const site = await created.json();
  assert.equal(created.status, 200, `деплой не удался: ${JSON.stringify(site)}`);

  // Ждём несколько тиков: health обновляется в памяти (M-01: тик стартует после boot).
  await sleep(1500);

  const list = await api(panel, 'GET', '/api/sites');
  const fromApi = list.data.find((s) => s.id === site.id);
  assert.ok(fromApi, 'сайт не найден в API');
  assert.equal(fromApi.health.status, 'up', `health не обновлён в памяти: ${JSON.stringify(fromApi.health)}`);

  const db = JSON.parse(fs.readFileSync(path.join(panel.dataDir, 'db.json'), 'utf8'));
  const record = db.sites.find((s) => s.id === site.id);
  assert.ok(record, 'запись сайта пропала из db.json');
  assert.ok(!('health' in record), 'телеметрия health попала в db.json (M-02)');
  assert.ok(!('fails' in record), 'телеметрия fails попала в db.json (M-02)');
});

/* ---------- M-03: forgetSite зачищает память ---------- */

test('M-03: forgetSite удаляет историю, телеметрию и кэш статистики', async () => {
  const store = require('../src/store');
  const monitor = require('../src/monitor');
  const id = 'forget-' + Date.now();
  store.state.sites.push({ id, name: id, type: 'static', status: 'running', domains: [], port: null });

  await monitor.tick();
  assert.ok(monitor.getHistory(id).length > 0, 'тик не записал историю');
  assert.notEqual(monitor.healthFor(id).status, 'unknown', 'тик не записал health');

  monitor.forgetSite(id);
  assert.deepEqual(monitor.getHistory(id), [], 'история пережила удаление (M-03)');
  assert.equal(monitor.healthFor(id).status, 'unknown', 'телеметрия пережила удаление (M-03)');
});

/* ---------- M-04: hardenDataDir однократно и точечно ---------- */

test('M-04: hardenDataDir выполняется один раз по маркеру', async (t) => {
  if (!isPosix) return t.skip('режимы проверяются на POSIX');
  const secure = require('../src/securefile');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-harden-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const dbFile = path.join(dataDir, 'db.json');
  fs.writeFileSync(dbFile, '{}', { mode: 0o644 });

  const first = secure.hardenDataDir({ dataDir });
  assert.ok(first >= 1, `первый прогон должен ужать секреты, получено ${first}`);
  assert.equal(fs.statSync(dbFile).mode & 0o777, 0o600, 'db.json не ужат первым прогоном');
  assert.ok(fs.existsSync(path.join(dataDir, '.permissions-hardened')), 'маркер не записан');

  const second = secure.hardenDataDir({ dataDir });
  assert.equal(second, 0, 'второй прогон не должен работать (M-04)');
});

test('M-04: hardenDataDir не создаёт каталог данных и не трогает node_modules', async (t) => {
  if (!isPosix) return t.skip('режимы проверяются на POSIX');
  const secure = require('../src/securefile');
  const missing = path.join(os.tmpdir(), 'sp-harden-missing-' + Date.now());
  t.after(() => { try { fs.rmSync(missing, { recursive: true, force: true }); } catch { /* noop */ } });
  assert.equal(secure.hardenDataDir({ dataDir: missing }), 0);
  assert.ok(!fs.existsSync(missing), 'hardenDataDir создал отсутствующий каталог');
});

/* ---------- M-05: карточка диска при сбое ---------- */

test('M-05: недоступный диск не обновляет метку, ошибка видна, восстановление работает', async (t) => {
  const dashboard = require('../src/dashboard');
  const { config } = require('../src/config');
  const origDataDir = config.dataDir;
  const missingDir = path.join(os.tmpdir(), 'sp-disk-missing-' + Date.now());
  // dataDir там, где не работают ОБА пути (statfs → ENOENT, df → ошибка):
  // именно этот случай раньше «замораживал» карточку с обновлённой меткой.
  config.dataDir = missingDir;
  t.after(() => {
    config.dataDir = origDataDir;
    try { fs.rmSync(missingDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  await dashboard.refreshDisk();
  const broken = dashboard.snapshot();
  assert.equal(broken.disk, null, `диск не должен показывать значение при сбое: ${JSON.stringify(broken.disk)}`);
  assert.ok(broken.diskError, 'ошибка чтения диска не видна в snapshot (M-05)');

  // Диск «появился» — следующий refreshDisk наполняет карточку и сбрасывает ошибку.
  fs.mkdirSync(config.dataDir, { recursive: true });
  await dashboard.refreshDisk();
  const ok = dashboard.snapshot();
  assert.ok(ok.disk && ok.disk.total > 0, `диск не восстановился: ${JSON.stringify(ok.disk)}`);
  assert.equal(ok.diskError, null, 'ошибка не сброшена после восстановления');
});

/* ---------- SP-22: защёлки алертов переживают рестарт ---------- */

test('SP-22: restoreState поднимает защёлки из state.json, persistState пишет их', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-alertstate-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  // Свежие модули с PANEL_DATA_DIR на временный каталог: config читает env при require.
  process.env.PANEL_DATA_DIR = tmp;
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}`)) delete require.cache[key];
  }
  const alerts = require('../src/alerts');

  fs.writeFileSync(
    path.join(tmp, 'state.json'),
    JSON.stringify({ version: 1, disk: { alerted: true, lastSent: 111 }, mem: { alerted: false, lastSent: 0 }, sites: { abc123: { alerted: true, lastSent: 222 } } }),
    'utf8'
  );

  assert.equal(alerts.restoreState(), true, 'restoreState не прочитал валидный файл');
  const snap = alerts.getStateSnapshot();
  assert.deepEqual(snap.sites.abc123, { alerted: true, lastSent: 222 }, 'защёлка сайта не восстановилась (SP-22)');
  assert.equal(snap.disk.alerted, true, 'защёлка диска не восстановилась');

  // persistState пишет атомарно (с задержкой 1 c) и в валидном формате.
  alerts.persistState();
  await sleep(1400);
  const written = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
  assert.equal(written.version, 1);
  assert.deepEqual(written.sites.abc123, { alerted: true, lastSent: 222 }, 'persistState потерял защёлку');
  assert.ok(fs.existsSync(path.join(tmp, 'state.json')));

  // Битый/чужой файл — не авария: restoreState возвращает false и состояние чистое.
  fs.writeFileSync(path.join(tmp, 'state.json'), 'not json', 'utf8');
  assert.equal(alerts.restoreState(), false);
  delete process.env.PANEL_DATA_DIR;
});

/* ---------- H-10: TRACE, OPTIONS, X-Sitepanel-Site, кодированные пути ---------- */

function request(port, host, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method, headers: { Host: host, ...headers } },
      (res) => {
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('H-10: TRACE отклоняется 405, OPTIONS доходит до приложения, у статики есть X-Sitepanel-Site', async (t) => {
  const panel = await startPanel({});
  t.after(() => panel.stop());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-h10-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

  const zip = path.join(tmp, 'h10.zip');
  makeZip(path.join(tmp, 'h10'), { 'index.html': '<h1>ok</h1>' }, zip);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), 'h10.zip');
  form.append('name', 'h10');
  form.append('autoStart', 'false');
  const created = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const site = await created.json();
  assert.equal(created.status, 200);
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'h10.local' });
  await api(panel, 'POST', `/api/sites/${site.id}/start`);
  await sleep(300);

  const trace = await request(panel.httpPort, 'h10.local', '/', { method: 'TRACE' });
  assert.equal(trace.status, 405, `TRACE прошёл маршрутизацию: ${trace.status} (H-10)`);
  assert.match(String(trace.headers.allow || ''), /GET/);

  const options = await request(panel.httpPort, 'h10.local', '/', { method: 'OPTIONS' });
  assert.equal(options.status, 200, 'OPTIONS должен доходить до приложения (preflight)');

  const page = await request(panel.httpPort, 'h10.local', '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['x-sitepanel-site'], site.id, 'у статики нет X-Sitepanel-Site (H-10)');

  // Перепроверка isBlockedPath: закодированные варианты не открывают .env
  // (сегмент '..' после декодирования отсекается, двойное кодирование остаётся
  // литеральным именем файла и не существует).
  for (const p of ['/%2e%2e/.env', '/..%2f.env', '/x/%252e%252e/.env', '/x/%25252e%25252e/.env']) {
    const res = await request(panel.httpPort, 'h10.local', p);
    assert.ok(res.status === 404 || res.status === 403, `${p} → ${res.status}`);
    assert.ok(!res.body.includes('SECRET'), `${p} отдал содержимое секрета`);
  }
});
