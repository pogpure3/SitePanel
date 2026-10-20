'use strict';

// Docker-сайты: всё, что связано с запуском проектов через docker CLI.
// Вынесено из manager.js (был ~2100 строк): здесь констант/детект/валидация
// compose, сборка, контейнеры, порты; manager.js оставляет у себя тонкие
// ветки _startDocker/_stopDocker и их вызовы в жизненном цикле сайта.
//
// Все docker-операции принимают site (запись из db.json) и логируют через
// manager.appendLog; менеджер процессов панели не используется — контейнер
// живёт своей жизнью (restart policy), панель лишь инспектирует его.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { spawn } = require('child_process');
const { config } = require('../config');
const { runCommand } = require('./deployfiles');

// Замыкание на manager не заводим: циклический require (manager <-> docker).
// Вместо этого manager.js инжектирует зависимости через docker.init({ manager }).
let manager = null;
// Приватные _stop/_start manager'а (без локa — applyContainerPort держит лок сам).
let managerStop = null;
let managerStart = null;
let waitPortFree = null;

function init({ manager: m, stopInternal, startInternal, waitPortFree: wpf }) {
  manager = m;
  managerStop = stopInternal;
  managerStart = startInternal;
  waitPortFree = wpf;
}

// Тонкие обёртки к manager (инжекция вместо циклического require).
function setStatus(site, status) { return manager.setStatus(site, status); }
function setStatusIf(site, from, to) { return manager.setStatusIf(site, from, to); }
function appendLog(site, line) { return manager.appendLog(site, line); }
function siteDir(site) { return manager.siteDir(site); }
function ts() { return new Date().toISOString(); }
async function waitListening(site, timeoutMs) { return manager.waitListening(site, timeoutMs); }
function withSiteLock(siteId, fn) { return manager.withSiteLock(siteId, fn); }
const alerts = {
  siteDown: (site, reason) => manager.alerts.siteDown(site, reason),
};

/* ---------- Docker-сайты ---------- */

// Проект — каталог сайта с Dockerfile (флейвор dockerfile) или docker-compose-файлом
// (флейвор compose). Панель билдит и запускает через docker CLI; контейнеры и образы
// именуются префиксом sitepanel-<id>, чтобы не пересекаться с чужими и уметь их
// находить после рестарта панели (контейнер переживает панель).
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const DOCKER_PREFIX = 'sitepanel-';

function dockerProjectName(site) {
  return DOCKER_PREFIX + site.id;
}

function dockerImageName(site) {
  return DOCKER_PREFIX + site.id;
}

/** Dockerfile каталога: корень или deploy/. Путь относительно dir. */
function dockerfileRel(dir) {
  for (const p of ['Dockerfile', 'deploy/Dockerfile']) {
    if (fs.existsSync(path.join(dir, p))) return p;
  }
  return null;
}

/**
 * Флейвор проекта по файлам каталога. null — это не Docker-проект.
 * Многие проекты держат Docker-файлы в подкаталоге deploy/ с build-контекстом
 * на КОРЕНЬ репозитория (COPY server.js и т.п.) — такой layout тоже поддерживаем:
 * панель собирает с контекстом корня сайта и явным -f.
 */
function detectDockerFlavor(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  if (COMPOSE_FILES.some((f) => fs.existsSync(path.join(dir, f)))) return 'compose';
  if (dockerfileRel(dir) === 'Dockerfile') return 'dockerfile';
  if (COMPOSE_FILES.some((f) => fs.existsSync(path.join(dir, 'deploy', f)))) return 'compose';
  if (dockerfileRel(dir)) return 'dockerfile';
  return null;
}

/**
 * Порт приложения внутри контейнера: EXPOSE из Dockerfile или короткий синтаксис
 * ports из compose-файла ("8080:3000" → 3000). YAML-парсера в панели нет, поэтому
 * compose читается построчным regex только по короткому синтаксису; если порт не
 * нашёлся — сайт остаётся с containerPort пользователя или дефолтом 3000.
 * @returns {number|null}
 */
function detectContainerPort(dir, flavor) {
  try {
    if (flavor === 'dockerfile') {
      const df = dockerfileRel(dir) || 'Dockerfile';
      const text = fs.readFileSync(path.join(dir, df), 'utf8');
      const exposes = [...text.matchAll(/^\s*EXPOSE\s+(\d{1,5})\s*$/gmi)]
        .map((m) => Number(m[1]))
        .filter((p) => p > 0 && p < 65536);
      if (exposes.length) return exposes[0];
      return null;
    }
    if (flavor === 'compose') {
      const main = composeMainFile(dir);
      if (!main) return null;
      let services;
      try {
        services = yaml.load(fs.readFileSync(path.join(dir, main), 'utf8')).services;
      } catch { return null; }
      const first = services && typeof services === 'object' ? Object.values(services)[0] : null;
      const ports = first && Array.isArray(first.ports) ? first.ports : [];
      // Поддержан и короткий ("8080:3000"), и длинный (target: 3000) синтаксис.
      for (const p of ports) {
        if (typeof p === 'string' || typeof p === 'number') {
          const parts = String(p).split(':').map(Number);
          const cport = parts[parts.length - 1];
          if (Number.isInteger(cport) && cport > 0 && cport < 65536) return cport;
        } else if (p && typeof p === 'object' && Number.isInteger(p.target)) {
          if (p.target > 0 && p.target < 65536) return p.target;
        }
      }
    }
  } catch { /* нечитаемый файл — вернём null, порт попросим у пользователя */ }
  return null;
}

/** Команда docker run: публикация только на 127.0.0.1, наружу — реверс-прокси панели. */
function dockerRunCmd(site) {
  const cp = Number(site.containerPort) || 3000;
  // -e PORT: многие образы слушают порт из окружения; тем, кому он не нужен, env безвреден.
  return `docker run -d --name ${dockerProjectName(site)} --restart unless-stopped ` +
    `-p 127.0.0.1:${site.port}:${cp} -e PORT=${cp} -e HOST=0.0.0.0 -e SITE_ID=${site.id} -e SITEPANEL=1 ` +
    `${dockerImageName(site)}`;
}

/** docker-команда с логом в журнал сайта: build/up/start/stop. Бросает при не-нулевом коде. */
async function dockerRunLogged(site, cmd, { timeoutMin = null, label = 'Команда docker' } = {}) {
  if (process.env.SP_TRACE) console.log('[trace] dockerRunLogged:', label, new Error().stack.split(String.fromCharCode(10)).slice(2, 6).join(String.fromCharCode(10) + 'at '));
  appendLog(site, `[panel] ${ts()} ${label}: ${cmd}`);
  const res = await runCommand(cmd, siteDir(site), (line) => appendLog(site, line),
    Math.max(1, timeoutMin || config.dockerBuildTimeoutMin) * 60000);
  if (res.code !== 0) {
    const why = res.timedOut ? 'превышен таймаут' : `код ${res.code}`;
    throw new Error(`${label} не удалась (${why}) — подробности в логах сайта`);
  }
  return res;
}

/**
 * Тихий docker-вызов без лога (inspect/ps/version). Различает «команда
 * завершилась» и «docker не ответил»: code -1 — spawn-ошибка или зависание
 * (таймаут), такой ответ трактуется вызывающими как «неизвестность», а не
 * как «контейнер мёртв» — иначе сбой демона ронял бы все docker-сайты.
 * @returns {Promise<{code:number, out:string}>}
 */
function execDocker(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('docker', args, { windowsHide: true });
    } catch {
      return resolve({ code: -1, out: '' });
    }
    let out = '';
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      try { child.kill('SIGKILL'); } catch { /* уже мёртв */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); failed = true; resolve({ code: -1, out }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: failed || code === null ? -1 : code, out });
    });
  });
}

/**
 * ID контейнеров compose-проекта по label. Имя контейнера задаёт ПОЛЬЗОВАТЕЛЬ
 * (container_name в compose-файле — например, «pumping-api»), поэтому искать
 * по sitepanel-<id> нельзя; label com.docker.compose.project панель задаёт сама.
 * @returns {string[]|null} null — docker не ответил.
 */
async function composeContainerIds(site, { onlyRunning = false } = {}) {
  const res = await execDocker([
    'ps', onlyRunning ? '-q' : '-aq', '--filter', `label=com.docker.compose.project=${dockerProjectName(site)}`,
  ]);
  if (res.code !== 0) return null;
  return res.out.trim() ? res.out.trim().split('\n').filter(Boolean) : [];
}

async function dockerContainerExists(site) {
  if (site.dockerFlavor === 'compose') {
    const ids = await composeContainerIds(site);
    return ids !== null && ids.length > 0;
  }
  const res = await execDocker(['inspect', '--format', '{{.State.Status}}', dockerProjectName(site)]);
  return res.code === 0;
}

/**
 * Состояние контейнеров сайта: 'running' | 'stopped' | 'missing' | 'unknown'.
 * unknown (docker не ответил) монитором трактуется как «не знаем» — статус
 * сайта НЕ меняется, в журнал пишется предупреждение.
 */
async function dockerContainerState(site) {
  if (site.dockerFlavor === 'compose') {
    const ids = await composeContainerIds(site);
    if (ids === null) return 'unknown';
    if (!ids.length) return 'missing';
    const res = await execDocker(['inspect', '--format', '{{.State.Running}}', ...ids]);
    if (res.code !== 0) return 'unknown';
    // Для multi-container проекта «работает» = живы ВСЕ контейнеры: упавший
    // сервис зависимости — тоже падение сайта. split по \n даёт и пустой
    // хвост ("true\n" -> ['true','']) — фильтруем: без этого eveny-ветка
    // считала живой контейнер «остановленным» и роняла сайт в crashed
    // на каждом тике (ревью-фикс #2/#3 поймал это на живом стенде).
    const states = res.out.split('\n').map((s) => s.trim()).filter(Boolean);
    return states.length && states.every((s) => s === 'true') ? 'running' : 'stopped';
  }
  const res = await execDocker(['inspect', '--format', '{{.State.Running}}', dockerProjectName(site)]);
  if (res.code !== 0) {
    // inspect по точному имени: не-нулевый код при живом демоне = контейнера
    // нет. Отличить от сбоя CLI позволяет только code -1.
    return res.code === -1 ? 'unknown' : 'missing';
  }
  return res.out.trim() === 'true' ? 'running' : 'stopped';
}

/** Docker CLI доступен и compose достаточно свеж для тегов !override/!reset? */
async function assertDockerAvailable() {
  const ver = await execDocker(['version', '--format', '{{.Server.Version}}'], 15000);
  if (ver.code !== 0) {
    const err = new Error('Docker недоступен на этом сервере — Docker-сайты нельзя запустить (проверьте установку docker и права панели)');
    err.dockerUnavailable = true;
    throw err;
  }
  const comp = await execDocker(['compose', 'version', '--short'], 15000);
  if (comp.code === 0) {
    const m = /(\d+)\.(\d+)/.exec(comp.out.trim());
    if (m && (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 24))) {
      throw new Error(`Требуется docker compose >= 2.24 (найдено ${comp.out.trim()}) — теги !override/!reset не поддерживаются`);
    }
  }
  return ver.out.trim();
}

/** Сборка образа/проекта из каталога сайта. */
async function dockerBuild(site) {
  if (site.dockerFlavor === 'compose') {
    // composeBaseArgs даёт -f пару: при deploy/-layout основной файл лежит в
    // подкаталоге — без явного -f compose его не найдёт (cwd — корень сайта).
    await dockerRunLogged(site, `${composeBaseArgs(site)} build`, { label: 'Сборка Docker (compose build)' });
  } else {
    const df = dockerfileRel(siteDir(site)) || 'Dockerfile';
    // Dockerfile из deploy/ собирается с контекстом КОРНЯ сайта: их COPY ссылаются
    // на файлы репозитория (COPY server.js, COPY lib ./lib), а не на deploy/.
    const fArg = df === 'Dockerfile' ? '' : ` -f ${df}`;
    await dockerRunLogged(site, `docker build -t ${dockerImageName(site)}${fArg} .`, { label: 'Сборка Docker-образа' });
  }
}
/* ---------- Docker: старт / остановка / пересоздание ---------- */

async function _startDocker(site) {
  if (!config.dockerSitesEnabled) {
    return { ok: false, error: 'Docker-сайты отключены на этом сервере (PANEL_DOCKER_SITES=0)' };
  }
  setStatus(site, 'starting');
  const flavor = site.dockerFlavor || detectDockerFlavor(siteDir(site)) || 'dockerfile';
  try {
    // Override мог не пережить подмену каталога (rollback/ручные правки) —
    // без него у проекта не будет публикации порта. Существующий override
    // тоже перегенерируем: пользовательский compose могли отредактировать
    // файловым менеджером, и валидация безопасности должна пройти заново.
    if (flavor === 'compose') {
      const main = composeMainFile(siteDir(site));
      const override = main ? main + '.sitepanel-override.yml' : null;
      if (!override || !fs.existsSync(path.join(siteDir(site), override))) {
        writeComposeOverride(site);
      } else {
        validateComposeSafety(siteDir(site), main);
      }
    }
    // up -d идемпотентен (создаёт/поднимает, работающее не трогает); --no-build:
    // образ собирается при деплое, повседневный старт не пересобирает проект.
    await startDockerContainers(site);
  } catch (err) {
    setStatusIf(site, ['starting', 'running'], 'crashed');
    alerts.siteDown(site, `не удалось запустить контейнер: ${err.message}`).catch(() => {});
    return { ok: false, error: err.message };
  }
  // Контейнерным приложениям нужно больше времени на старт, чем «сырому» node
  // (образ поднимается дольше). Короткое окно превращало медленный, но живой
  // контейнер в «не запустился» со всеми вытекающими (автооткат).
  const wait = await waitListening(site, Math.max(config.appListenWaitMs, 30000));
  if (!wait.ok) {
    setStatusIf(site, ['starting', 'running'], 'crashed');
    alerts.siteDown(site, `контейнер запущен, но порт ${site.port} не открылся`).catch(() => {});
    return { ok: false, error: 'Контейнер запущен, но порт не открылся — подробности в логах сайта' };
  }
  setStatus(site, 'running');
  appendLog(site, `[panel] ${ts()} docker-сайт запущен (127.0.0.1:${site.port} → контейнер:${site.containerPort || '?'})`);
  return { ok: true };
}

/**
 * Остановить/поднять контейнеры проекта БЕЗ статуса сайта: низкоуровневые
 * операции для _stopDocker/_startDocker и консистентного бэкапа (контейнеры
 * гасятся на время упаковки SQLite-баз). Бросают при ошибке.
 */
async function stopDockerContainers(site) {
  const flavor = site.dockerFlavor || detectDockerFlavor(siteDir(site)) || 'dockerfile';
  if (!(await dockerContainerExists(site))) return;
  if (flavor === 'compose') {
    // stop, а не down: повторный старт поднимет те же контейнеры с теми же
    // настройками (down удалил бы их вместе с томами без explicit -v — нет).
    await dockerRunLogged(site, `${composeBaseArgs(site)} stop`,
      { timeoutMin: 2, label: 'docker compose stop' });
  } else {
    await dockerRunLogged(site, `docker stop ${dockerProjectName(site)}`, { timeoutMin: 2, label: 'docker stop' });
  }
}

async function startDockerContainers(site) {
  const flavor = site.dockerFlavor || detectDockerFlavor(siteDir(site)) || 'dockerfile';
  if (flavor === 'compose') {
    const main = composeMainFile(siteDir(site));
    const override = main ? main + '.sitepanel-override.yml' : null;
    if (!override || !fs.existsSync(path.join(siteDir(site), override))) {
      writeComposeOverride(site);
    }
    await dockerRunLogged(site, `${composeBaseArgs(site)} up -d --no-build`,
      { timeoutMin: 5, label: 'docker compose up' });
  } else if (await dockerContainerExists(site)) {
    await dockerRunLogged(site, `docker start ${dockerProjectName(site)}`, { timeoutMin: 5, label: 'docker start' });
  } else {
    await dockerRunLogged(site, dockerRunCmd(site), { timeoutMin: 5, label: 'docker run' });
  }
}

async function _stopDocker(site) {
  setStatus(site, 'stopped');
  try {
    await stopDockerContainers(site);
  } catch (err) {
    appendLog(site, `[panel] ${ts()} остановка контейнера не удалась: ${err.message}`);
    return { ok: false, error: err.message };
  }
  // Published-порт держит docker-proxy от имени контейнера: после остановки
  // контейнера порт освобождается сам. ensurePortFreed здесь не годится — он
  // видит docker-proxy как ЧУЖОЙ процесс и отказывается его завершать.
  const freed = await waitPortFree(site.port, 15000);
  if (!freed) {
    return { ok: false, error: `Порт ${site.port} не освободился после остановки контейнера` };
  }
  appendLog(site, `[panel] ${ts()} docker-сайт остановлен`);
  return { ok: true };
}

/**
 * Основной compose-файл каталога: корень или подкаталог deploy/ (детерминированный
 * порядок). Возвращает путь ОТНОСИТЕЛЬНО dir — 'docker-compose.yml' или
 * 'deploy/docker-compose.yml': он идёт в -f (cwd — корень сайта) и в пути
 * override-файла рядом с оригиналом.
 */
function composeMainFile(dir) {
  for (const sub of ['', 'deploy/']) {
    for (const f of COMPOSE_FILES) {
      if (fs.existsSync(path.join(dir, sub + f))) return sub + f;
    }
  }
  return null;
}

/**
 * Имя ПЕРВОГО сервиса compose-файла. Полного YAML-парсера в панели нет —
 * ищем сервис верхнего уровня (отступ ровно 2 пробела) после `services:`.
 * Публикуем порт только ему: публиковать всем (например, БД) было бы дырой.
 * @returns {string|null}
 */
function composeFirstService(text) {
  // js-yaml, а не регексы по строкам: вложенные ключи и псевдо-services больше
  // не путаются, а «services: {}» честно даёт null.
  try {
    const doc = yaml.load(String(text));
    const services = doc && typeof doc === 'object' ? doc.services : null;
    if (!services || typeof services !== 'object' || Array.isArray(services)) return null;
    return Object.keys(services)[0] || null;
  } catch {
    return null;
  }
}

/** Ошибка деплоя compose-проекта с кодом 400 (клиентская, а не сбой панели). */
function composeFail(msg) {
  const err = new Error('compose отклонён: ' + msg);
  err.status = 400;
  return err;
}

/** Путь resolved лежит внутри baseDir (каталог сайта)? */
function resolvedInside(baseDir, fromDir, rel) {
  const resolved = path.resolve(fromDir, String(rel));
  const root = path.resolve(baseDir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Разобрать compose-файл и проверить БЕЗОПАСНОСТЬ для хоста. Compose-файл —
 * чужой код конфигурации: без проверки второй сервис мог бы опубликовать порт
 * на 0.0.0.0 в обход панели и файрвола, а bind-маунт /, docker.sock или
 * network_mode: host — отдать хост целиком (панель работает от root).
 *
 * Правила: ports не трогаем здесь (их заменяет override по всем сервисам);
 * запрещаем network_mode: host|container:*, privileged, pid/ipc/*ns_mode: host,
 * cap_add, devices, external-сети, include, extends на внешний файл,
 * build.context и bind-источники volumes вне каталога сайта.
 * @returns {{services: object, names: string[]}}
 */
function validateComposeSafety(dir, relPath) {
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(path.join(dir, relPath), 'utf8'));
  } catch (err) {
    throw composeFail(`не удалось разобрать ${relPath} (${err.message})`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw composeFail(`${relPath}: ожидается YAML-объект`);
  const services = doc.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw composeFail(`${relPath}: секция services не найдена или не объект`);
  }
  const names = Object.keys(services);
  if (!names.length) throw composeFail(`${relPath}: секция services пуста`);

  const composeDir = path.dirname(path.join(dir, relPath));
  if (doc.include) throw composeFail('include не поддерживается');
  if (doc.networks && typeof doc.networks === 'object' && !Array.isArray(doc.networks)) {
    for (const [netName, net] of Object.entries(doc.networks)) {
      if (net && typeof net === 'object' && net.external) {
        throw composeFail(`сеть ${netName} помечена external — подключение к чужим сетям запрещено`);
      }
    }
  }

  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object' || Array.isArray(svc)) throw composeFail(`сервис ${name}: не объект`);
    const nm = svc.network_mode;
    if (nm === 'host' || (typeof nm === 'string' && nm.startsWith('container:'))) {
      throw composeFail(`сервис ${name}: network_mode "${nm}" запрещён`);
    }
    if (svc.privileged === true) throw composeFail(`сервис ${name}: privileged запрещён`);
    for (const key of ['pid', 'ipc', 'cgroupns_mode', 'userns_mode']) {
      const v = svc[key];
      if (v === 'host' || (v && typeof v === 'object' && v.mode === 'host')) {
        throw composeFail(`сервис ${name}: ${key}: host запрещён`);
      }
    }
    if (Array.isArray(svc.cap_add) && svc.cap_add.length) throw composeFail(`сервис ${name}: cap_add запрещён`);
    if (Array.isArray(svc.devices) && svc.devices.length) throw composeFail(`сервис ${name}: devices запрещён`);
    if (svc.extends && typeof svc.extends === 'object' && svc.extends.file) {
      throw composeFail(`сервис ${name}: extends на внешний файл запрещён`);
    }
    // build.context: только внутри каталога сайта (контекст уезжает в docker build).
    const ctx = svc.build && (typeof svc.build === 'string' ? svc.build : svc.build.context);
    if (ctx !== undefined && ctx !== null) {
      const ctxStr = String(ctx);
      if (path.isAbsolute(ctxStr) || !resolvedInside(dir, composeDir, ctxStr)) {
        throw composeFail(`сервис ${name}: build.context "${ctxStr}" вне каталога сайта запрещён`);
      }
    }
    // volumes: именованные тома и tmpfs разрешены; bind — только внутрь каталога сайта.
    const vols = Array.isArray(svc.volumes) ? svc.volumes : [];
    for (const v of vols) {
      let src = null;
      let explicitBind = false;
      if (typeof v === 'string' || typeof v === 'number') {
        const parts = String(v).split(':');
        if (parts.length === 1) continue; // анонимный том контейнера
        src = parts[0];
      } else if (v && typeof v === 'object') {
        if (v.type === 'tmpfs') continue;
        if (v.type === 'volume') continue;
        src = v.source !== undefined ? v.source : null;
        explicitBind = v.type === 'bind' || v.source !== undefined;
      }
      if (!src) continue; // целевой том без источника
      const s = String(src);
      if (s.startsWith('/') || s.startsWith('~')) {
        throw composeFail(`сервис ${name}: абсолютный bind "${s}" запрещён (тома docker.sock, / и т.п.)`);
      }
      // Короткий синтаксис: "./x:/dst" — bind; "name:/dst" — именованный том.
      if (explicitBind || s.startsWith('./') || s.startsWith('../')) {
        if (!resolvedInside(dir, composeDir, s)) {
          throw composeFail(`сервис ${name}: bind "${s}" выходит за каталог сайта`);
        }
      }
    }
  }
  return { services, names };
}

/**
 * Override-файл с публикацией порта. compose-проекты без ports не публикуют
 * ничего — панель проксирует свой host-порт, поэтому генерируем первому
 * сервису публикацию на 127.0.0.1. Тег !override ЗАМЕНЯЕТ пользовательский
 * ports; ВСЕ остальные сервисы получают ports: !reset [] — чужие публикации
 * (в том числе на 0.0.0.0) не проходят в обход панели и файрвола.
 * Попутно файл валидируется на опасные для хоста конструкции (см.
 * validateComposeSafety) — деплой падает с внятной ошибкой ДО запуска.
 */
function writeComposeOverride(site) {
  const main = composeMainFile(siteDir(site));
  if (!main) {
    const err = new Error('compose-файл не найден в каталоге сайта');
    err.status = 400;
    throw err;
  }
  const { names } = validateComposeSafety(siteDir(site), main); // бросает composeFail
  const cp = Number(site.containerPort) || 3000;
  // container_name сбрасывается у ВСЕХ сервисов: имя задаёт ПОЛЬЗОВАТЕЛЬ и
  // глобально уникально — два сайта из одного репо конфликтовали бы именем
  // контейнера. С compose-именем <проект>-<сервис>-1 коллизий нет.
  const blocks = [
    `  ${JSON.stringify(names[0])}:\n    container_name: !reset null\n    ports: !override ["127.0.0.1:${site.port}:${cp}"]`,
    ...names.slice(1).map((n) => `  ${JSON.stringify(n)}:\n    container_name: !reset null\n    ports: !reset []`),
  ];
  const content = '# Сгенерировано SitePanel — перезаписывается при деплое/старте.\n' +
    '# Порт наружу отдаёт реверс-прокси панели, публикация только на 127.0.0.1.\n' +
    '# Порты остальных сервисов и пользовательские container_name сброшены:\n' +
    '# публикации в обход панели и конфликты имён между сайтами невозможны.\n' +
    'services:\n' + blocks.join('\n') + '\n';
  const file = main + '.sitepanel-override.yml';
  fs.writeFileSync(path.join(siteDir(site), file), content);
  appendLog(site, `[panel] ${ts()} записан ${file} (публикация 127.0.0.1:${site.port} → ${cp}, сервис ${names[0]}, публикация портов остальных сервисов отключена)`);
  return file;
}

/** База compose-команды: проект + пара -f (основной файл + наш override). */
function composeBaseArgs(site, fallbackMain = 'docker-compose.yml') {
  const main = composeMainFile(siteDir(site)) || fallbackMain;
  return `docker compose -p ${dockerProjectName(site)} -f ${main} -f ${main}.sitepanel-override.yml`;
}

/**
 * Пересоздать контейнеры проекта на текущем образе. Нужен после отката/
 * восстановления: docker start поднимает контейнер СО СТАРЫМ образом — без
 * recreate откат каталога не изменил бы работающий сайт.
 */
async function dockerRecreate(site) {
  if (site.dockerFlavor === 'compose') {
    await dockerRunLogged(site, `${composeBaseArgs(site)} up -d --no-build`,
      { timeoutMin: 5, label: 'docker compose up (пересоздание)' });
  } else if (await dockerContainerExists(site)) {
    await dockerRunLogged(site, `docker rm -f ${dockerProjectName(site)}`, { timeoutMin: 2, label: 'docker rm -f' });
    // Контейнер создаст _startDocker через docker run — уже с новым образом.
  }
}

/**
 * Гарантировать .dockerignore каталога сайта. Build-контекст уезжает в демон
 * целиком: без отсечения `COPY . .` в пользовательском Dockerfile утаскивал
 * в слои образа секреты (.env — PRESERVED_FILES) и данные (deploy/data —
 * SQLite). Свой .dockerignore проекта не трогаем.
 */
function ensureSiteDockerignore(dir, site) {
  const p = path.join(dir, '.dockerignore');
  if (fs.existsSync(p)) return;
  const content = [
    '# Сгенерировано SitePanel при деплое: build-контекст не должен тащить',
    '# секреты и данные в слои образа. Свой .dockerignore проекта был бы сохранён.',
    '.env',
    'node_modules',
    'deploy/data',
    'data',
    '*.db',
    '*.db-shm',
    '*.db-wal',
  ].join('\n') + '\n';
  try {
    fs.writeFileSync(p, content);
    appendLog(site, `[panel] ${ts()} создан .dockerignore (секреты и данные не попадают в build-контекст)`);
  } catch { /* нет прав на запись — не блокируем деплой */ }
}

/**
 * Применить новый containerPort немедленно: остановить (если работал),
 * пересоздать контейнеры с новой публикацией порта, запустить. Вызывается из
 * PATCH /api/sites/:id — раньше порт «применялся» только при следующем деплое
 * (override не перезаписывался, docker start переиспользовал маппинг).
 */
async function applyContainerPort(site) {
  return withSiteLock(site.id, async () => {
    const wasRunning = site.status === 'running';
    if (wasRunning) await managerStop(site);
    if (site.dockerFlavor === 'compose') {
      writeComposeOverride(site); // пересчитает публикацию с новым containerPort
    } else if (await dockerContainerExists(site)) {
      await dockerRunLogged(site, `docker rm -f ${dockerProjectName(site)}`, { timeoutMin: 2, label: 'docker rm -f (смена порта контейнера)' });
    }
    if (wasRunning || site.autoStart) return managerStart(site);
    return { ok: true };
  });
}

/** Удалить контейнеры, образ и (для compose) тома проекта. Не бросает: сайт и так удаляется. */
async function dockerRemoveAll(site) {
  const name = dockerProjectName(site);
  const flavor = site.dockerFlavor || detectDockerFlavor(siteDir(site)) || 'dockerfile';
  try {
    if (flavor === 'compose') {
      try {
        await dockerRunLogged(site, `${composeBaseArgs(site)} down --rmi local --volumes`,
          { timeoutMin: 5, label: 'docker compose down' });
      } catch (composeErr) {
        // compose-файл мог исчезнуть из каталога (удаление битого сайта) —
        // добиваем контейнеры проекта напрямую по label.
        appendLog(site, `[panel] ${ts()} compose down не удался (${composeErr.message}) — удаляю контейнеры по label`);
        const ids = await execDocker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${name}`]);
        if (ids.code === 0 && ids.out.trim()) {
          await dockerRunLogged(site, `docker rm -f ${ids.out.trim().split('\n').join(' ')}`, { timeoutMin: 2, label: 'docker rm -f' });
        }
      }
    } else {
      if (await dockerContainerExists(site)) {
        await dockerRunLogged(site, `docker rm -f ${name}`, { timeoutMin: 2, label: 'docker rm -f' });
      }
      try {
        await dockerRunLogged(site, `docker rmi ${dockerImageName(site)}`, { timeoutMin: 5, label: 'docker rmi' });
      } catch { /* образа могло не быть — не критично */ }
    }
  } catch (err) {
    appendLog(site, `[panel] ${ts()} очистка docker-ресурсов не удалась: ${err.message} — проверьте docker ps вручную`);
  }
}

module.exports = {
  init,
  // НЕ «start»/«stop»: spread в module.exports manager затирал бы публичные
  // start/stop менеджера docker-обёртками (деплой статики уходил в docker run).
  dockerStart: (site) => _startDocker(site),
  dockerStop: (site) => _stopDocker(site),
  COMPOSE_FILES,
  DOCKER_PREFIX,
  dockerProjectName,
  dockerImageName,
  dockerfileRel,
  detectDockerFlavor,
  detectContainerPort,
  dockerRunCmd,
  dockerRunLogged,
  execDocker,
  composeContainerIds,
  dockerContainerExists,
  dockerContainerState,
  assertDockerAvailable,
  dockerBuild,
  composeFirstService,
  validateComposeSafety,
  composeMainFile,
  writeComposeOverride,
  composeBaseArgs,
  dockerRecreate,
  ensureSiteDockerignore,
  dockerRemoveAll,
  applyContainerPort,
  stopDockerContainers,
  startDockerContainers,
};
