'use strict';

// Docker-сайты: юнит-тесты детекта типа/порта и валидации полей (без docker)
// + интеграционные с реальным docker CLI (скипаются, если docker недоступен —
// паттерн tests/ui-browser.test.js с Playwright).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { startPanel, api, waitFor, makeZip } = require('./helpers/panel');

let hasDocker = false;
try {
  execSync('docker version --format {{.Server.Version}}', { stdio: 'ignore', timeout: 15000 });
  hasDocker = true;
} catch {
  /* docker недоступен — интеграционные тесты скипаются */
}

/* ---------- Юнит: детект типа и порта (docker не нужен) ---------- */

function makeProjectDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-docker-detect-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } });
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

const NODE_PKG = JSON.stringify({ name: 'app', scripts: { start: 'node server.js' } });

test('detectType: Dockerfile и compose-файлы важнее package.json', (t) => {
  const { detectType, detectDockerFlavor } = require('../src/sites/manager');

  const df = makeProjectDir(t, { Dockerfile: 'FROM node:22-alpine\n', 'package.json': NODE_PKG });
  assert.deepEqual(detectType(df), { type: 'docker', startCommand: null, dockerFlavor: 'dockerfile' });
  assert.equal(detectDockerFlavor(df), 'dockerfile');

  for (const compose of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const dir = makeProjectDir(t, { [compose]: 'services:\n  app:\n    build: .\n', 'package.json': NODE_PKG });
    assert.equal(detectType(dir).type, 'docker', compose);
    assert.equal(detectType(dir).dockerFlavor, 'compose', compose);
  }

  const node = makeProjectDir(t, { 'package.json': NODE_PKG, 'server.js': '' });
  assert.equal(detectType(node).type, 'node');

  const empty = makeProjectDir(t, { 'index.html': '<h1>hi</h1>' });
  assert.equal(detectType(empty).type, 'static');
});

test('detectType: deploy/-подкаталог (Docker-файлы с контекстом на корень репо)', (t) => {
  const { detectType, detectContainerPort } = require('../src/sites/manager');

  // Layout вида api-progression: deploy/Dockerfile + deploy/docker-compose.yml
  // (build: context ..) + исходники в корне, package.json отсутствует.
  const layout = makeProjectDir(t, {
    'deploy/Dockerfile': 'FROM node:24-alpine\nWORKDIR /app\nCOPY server.js ./\nEXPOSE 7011\nCMD ["node", "server.js"]\n',
    'deploy/docker-compose.yml': [
      'services:',
      '  pumping-api:',
      '    build:',
      '      context: ..',
      '      dockerfile: deploy/Dockerfile',
      '    ports:',
      '      - "7011:7011"',
      '',
    ].join('\n'),
    'server.js': "require('http').createServer(() => {}).listen(process.env.PORT || 7011)",
  });
  assert.deepEqual(detectType(layout), { type: 'docker', startCommand: null, dockerFlavor: 'compose' });
  assert.equal(detectContainerPort(layout, 'compose'), 7011, 'порт из deploy/compose');

  // Только deploy/Dockerfile без compose — тоже docker (dockerfile-флейвор).
  const dfOnly = makeProjectDir(t, {
    'deploy/Dockerfile': 'FROM node:22-alpine\nEXPOSE 3000\n',
    'server.js': '',
  });
  assert.equal(detectType(dfOnly).type, 'docker');
  assert.equal(detectType(dfOnly).dockerFlavor, 'dockerfile');
  assert.equal(detectContainerPort(dfOnly, 'dockerfile'), 3000, 'EXPOSE из deploy/Dockerfile');

  // Файлы в корне приоритетнее deploy/.
  const rootWins = makeProjectDir(t, {
    'docker-compose.yml': 'services:\n  app:\n    build: .\n    ports:\n      - 3000\n',
    'deploy/docker-compose.yml': 'services:\n  app:\n    build: .\n    ports:\n      - 9999\n',
  });
  assert.equal(detectContainerPort(rootWins, 'compose'), 3000);
});

test('detectContainerPort: EXPOSE и короткий ports, длинный синтаксис — не парсим', (t) => {
  const { detectContainerPort } = require('../src/sites/manager');

  const withExpose = makeProjectDir(t, {
    Dockerfile: 'FROM node:22-alpine\nEXPOSE 4000\nCMD ["node", "srv.js"]\n',
  });
  assert.equal(detectContainerPort(withExpose, 'dockerfile'), 4000);

  const withCompose = makeProjectDir(t, {
    'docker-compose.yml': [
      'services:',
      '  app:',
      '    build: .',
      '    ports:',
      '      - "7011:7011"    # хвостовой комментарий — порт обязан детектиться',
      '',
    ].join('\n'),
  });
  assert.equal(detectContainerPort(withCompose, 'compose'), 7011, 'комментарий в строке порта не мешает детекту');

  const bare = makeProjectDir(t, {
    'docker-compose.yml': 'services:\n  app:\n    build: .\n    ports:\n      - 3000\n',
  });
  assert.equal(detectContainerPort(bare, 'compose'), 3000);

  const long = makeProjectDir(t, {
    'docker-compose.yml': 'services:\n  app:\n    build: .\n    ports:\n      - target: 3000\n        published: 8080\n',
  });
  assert.equal(detectContainerPort(long, 'compose'), null, 'длинный синтаксис не парсим — порт спросим у пользователя');
});

test('composeFirstService: первый сервис верхнего уровня, вложенность игнорируется', () => {
  const { composeFirstService } = require('../src/sites/manager');
  const yaml = [
    'services:',
    '  web-app:',
    '    build: .',
    '    depends_on:',
    '      redis:',
    '        condition: service_started',
    '  redis:',
    '    image: redis:7',
  ].join('\n');
  assert.equal(composeFirstService(yaml), 'web-app');
  assert.equal(composeFirstService('version: "3"\n'), null);
  assert.equal(composeFirstService('services: {}\n'), null, 'вложенный объект сервисов не парсим');
});

test('store: тип docker и поля containerPort/dockerFlavor проходят валидацию', () => {
  const { validateSite } = require('../src/store');
  const ok = validateSite({ id: 'dk1', type: 'docker', containerPort: 4000, dockerFlavor: 'compose' }).site;
  assert.equal(ok.type, 'docker');
  assert.equal(ok.containerPort, 4000);
  assert.equal(ok.dockerFlavor, 'compose');

  const junk = validateSite({ id: 'dk2', type: 'docker', containerPort: 'nonsense', dockerFlavor: 'evil' }).site;
  assert.equal(junk.containerPort, null, 'мусорный порт обнуляется');
  assert.equal(junk.dockerFlavor, null, 'чужой flavor отбрасывается');

  const wrong = validateSite({ id: 'wrong', type: 'kubernetes' }).site;
  assert.equal(wrong.type, 'static', 'неизвестный тип по-прежнему статика');
});

/* ---------- Интеграция (реальный docker) ---------- */

const SERVER_JS = (marker) => [
  "const http = require('http');",
  `const s = http.createServer((q, r) => r.end('${marker}'));`,
  "s.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('listening', process.env.PORT || 3000));",
].join('\n');

const DOCKERFILE = (marker) => [
  'FROM node:22-alpine',
  'WORKDIR /app',
  'COPY server.js server.js',
  'EXPOSE 3000',
  `CMD ["node", "-e", ${JSON.stringify(SERVER_JS(marker))}]`,
].join('\n');

const COMPOSE = 'services:\n  app:\n    build: .\n';

async function uploadZip(panel, tmp, name, files) {
  const zip = path.join(tmp, `${name}.zip`);
  makeZip(path.join(tmp, name), files, zip);
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

function getInternal(port, p = '/') {
  const http = require('http');
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

/** waitFor с диагностикой: при провале добавляем статус и хвост лога сайта. */
async function waitForSiteAnswer(panel, site, marker, label, timeout) {
  try {
    await waitFor(async () => ((await getInternal(site.port)).body === marker ? true : null),
      { timeout, interval: 1000, label });
  } catch (err) {
    let extra = '';
    try {
      const detail = await api(panel, 'GET', `/api/sites/${site.id}`);
      const log = await api(panel, 'GET', `/api/sites/${site.id}/logs?lines=150`);
      extra = `\n--- статус: ${JSON.stringify(detail.data && {
        status: detail.data.status, port: detail.data.port,
        containerPort: detail.data.containerPort, dockerFlavor: detail.data.dockerFlavor,
      })}\n--- лог сайта (хвост):\n${(log.data && log.data.log || '').slice(-2500)}`;
    } catch { /* панель тоже могла умереть */ }
    throw new Error(err.message + extra);
  }
}

test('интеграция: сайт из Dockerfile деплоится, проксируется, стартует/останавливается', { timeout: 10 * 60 * 1000 }, async (t) => {
  if (!hasDocker) return t.skip('docker CLI недоступен — интеграционный тест скипается');
  const panel = await startPanel({});
  t.after(async () => { await panel.stop(); });

  const site = await uploadZip(panel, os.tmpdir(), 'dockerfile-site', {
    Dockerfile: DOCKERFILE('v1'),
    'server.js': SERVER_JS('v1'),
  });
  assert.equal(site.type, 'docker', 'сайт определён как docker');
  assert.equal(site.dockerFlavor, 'dockerfile');
  assert.equal(site.containerPort, 3000, 'порт из EXPOSE');
  assert.ok(site.port, 'панель выделила host-порт');

  await waitForSiteAnswer(panel, site, 'v1', 'контейнер отвечает на published-порту', 180000);

  // Стоп → порт молчит; старт → снова отвечает.
  const stop = await api(panel, 'POST', `/api/sites/${site.id}/stop`);
  assert.equal(stop.status, 200, JSON.stringify(stop.data));
  assert.equal((await getInternal(site.port)).status, 0, 'после stop порт не отвечает');
  const start = await api(panel, 'POST', `/api/sites/${site.id}/start`);
  assert.equal(start.status, 200, JSON.stringify(start.data));
  await waitForSiteAnswer(panel, site, 'v1', 'старт после остановки', 60000);

  // Обновление: новая версия → пересборка образа → recreate → v2.
  const zip2 = path.join(os.tmpdir(), 'dockerfile-site-v2.zip');
  makeZip(path.join(os.tmpdir(), 'dockerfile-site-v2'), {
    Dockerfile: DOCKERFILE('v2'),
    'server.js': SERVER_JS('v2'),
  }, zip2);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip2)]), 'dockerfile-site-v2.zip');
  const upd = await fetch(panel.base + `/api/sites/${site.id}/update`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  assert.equal(upd.status, 200, JSON.stringify(await upd.json()));
  await waitForSiteAnswer(panel, site, 'v2', 'после обновления отвечает v2', 240000);

  // Удаление: контейнер и образ проекта исчезают.
  const del = await api(panel, 'DELETE', `/api/sites/${site.id}`);
  assert.equal(del.status, 200);
  await waitFor(async () => {
    const { execSync } = require('child_process');
    let ps = '';
    let images = '';
    try {
      ps = execSync(`docker ps -a --filter name=sitepanel-${site.id} --format {{.ID}}`, { encoding: 'utf8', timeout: 15000 });
      images = execSync(`docker images sitepanel-${site.id} --format {{.ID}}`, { encoding: 'utf8', timeout: 15000 });
    } catch { /* docker пропал — не ждём */ }
    return ps.trim() === '' && images.trim() === '' ? true : null;
  }, { timeout: 60000, interval: 1000, label: 'контейнер и образ удалены' });
});

test('интеграция: docker-compose-проект деплоится и проксируется', { timeout: 10 * 60 * 1000 }, async (t) => {
  if (!hasDocker) return t.skip('docker CLI недоступен — интеграционный тест скипается');
  const panel = await startPanel({});
  t.after(async () => { await panel.stop(); });

  const site = await uploadZip(panel, os.tmpdir(), 'compose-site', {
    'docker-compose.yml': COMPOSE,
    Dockerfile: DOCKERFILE('c1'),
    'server.js': SERVER_JS('c1'),
  });
  assert.equal(site.type, 'docker');
  assert.equal(site.dockerFlavor, 'compose');

  await waitForSiteAnswer(panel, site, 'c1', 'compose-проект отвечает', 240000);

  const del = await api(panel, 'DELETE', `/api/sites/${site.id}`);
  assert.equal(del.status, 200);
});

test('интеграция: deploy/-layout (Dockerfile+compose в подкаталоге, контекст — корень) и перенос deploy/data', { timeout: 10 * 60 * 1000 }, async (t) => {
  if (!hasDocker) return t.skip('docker CLI недоступен — интеграционный тест скипается');
  const panel = await startPanel({});
  t.after(async () => { await panel.stop(); });

  const mkLayout = (marker) => ({
    'deploy/Dockerfile': [
      'FROM node:22-alpine',
      'WORKDIR /app',
      'COPY server.js ./',
      'EXPOSE 7011',
      'ENV PORT=7011',
      `CMD ["node", "server.js"]`,
    ].join('\n'),
    'deploy/docker-compose.yml': [
      'services:',
      '  svc:',
      '    build:',
      '      context: ..',
      '      dockerfile: deploy/Dockerfile',
      '    ports:',
      '      - "7011:7011"',
      '    volumes:',
      '      - ./data:/app/data',
    ].join('\n'),
    'server.js': SERVER_JS(marker),
  });

  const site = await uploadZip(panel, os.tmpdir(), 'deploy-layout', mkLayout('d1'));
  assert.equal(site.type, 'docker', JSON.stringify(site));
  assert.equal(site.dockerFlavor, 'compose');
  assert.equal(site.containerPort, 7011, 'порт из deploy/compose');

  await waitForSiteAnswer(panel, site, 'd1', 'deploy/-layout отвечает', 240000);

  // Пользовательские данные в deploy/data (volume ./data относительно compose-файла).
  const dataDir = path.join(panel.dataDir, 'sites', site.id, 'deploy', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'pumping.db'), 'SQLITE-SNAPSHOT');

  // Обновление zip: deploy/data обязан пережить подмену каталога.
  const zip2 = path.join(os.tmpdir(), 'deploy-layout-v2.zip');
  makeZip(path.join(os.tmpdir(), 'deploy-layout-v2'), mkLayout('d2'), zip2);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip2)]), 'deploy-layout-v2.zip');
  const upd = await fetch(panel.base + `/api/sites/${site.id}/update`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  assert.equal(upd.status, 200, JSON.stringify(await upd.json()));
  assert.equal(fs.readFileSync(path.join(dataDir, 'pumping.db'), 'utf8'), 'SQLITE-SNAPSHOT',
    'deploy/data пережил передеплой');
  await waitForSiteAnswer(panel, site, 'd2', 'после обновления отвечает d2', 240000);

  const del = await api(panel, 'DELETE', `/api/sites/${site.id}`);
  assert.equal(del.status, 200);
});
