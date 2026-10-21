'use strict';

// Запуск/остановка дочерних процессов сайтов и деплой zip-архивов.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { config } = require('../config');
const store = require('../store');
const alerts = require('../alerts');
const { withSiteLock, outsideLock } = require('./lock');
const { detectManager, runCommand, isLockMismatch, killActiveCommands } = require('./deployfiles');
const secure = require('../securefile');
const sitelog = require('./sitelog');
const proc = require('./proc');
const deploymark = require('./deploymark');
const docker = require('./docker');

// siteId -> { child|pid, startedAt, stopping, restartTimer, cooldownTimer,
//             stableTimer, inStartup, external }
const processes = new Map();

// Реестр «временных» подпроцессов деплоя (npm install, сборка) живёт в
// deployfiles.js (`activeCommands`) — там же, где эти процессы создаются, — и
// гасится через killActiveCommands() при остановке панели: раньше install-подпроцесс
// (shell:true, не detached) не попадал в processes, SIGTERM до него не доходил, и он
// продолжал писать в data/tmp уже после выхода панели (SP-05).

function siteDir(site) {
  return path.join(config.sitesDir, site.id);
}

function siteLogFile(site) {
  return sitelog.siteLogFile(site);
}


/**
 * Убить дерево процессов на Windows. PID приходит из наших же структур (child.pid,
 * pid-файл, lsof), но перед передачей в taskkill он жёстко валидируется как целое
 * положительное число: значение вида «-foo» ушло бы программе как её собственный
 * ключ (инъекция опций; находка сканера).
 */
function taskkillTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) return;
  spawn('taskkill', ['/pid', String(n), '/T', '/F'], { windowsHide: true });
}

/* ---------- Логи ---------- */

// Логи вынесены в src/sites/sitelog.js: асинхронная запись вместо appendFileSync
// на каждый чанк (P-01), чтение только хвоста вместо всего файла (P-02, P-23)
// и ротация N поколений вместо одного `.old`.
function appendLog(site, line) {
  sitelog.appendLog(site, line);
}

function rotateLogIfNeeded(site) {
  sitelog.rotateLogIfNeeded(site);
}

function readLogTail(site, lines = 200) {
  return sitelog.readLogTail(site, lines);
}

/* ---------- Порты ---------- */

function usedInternalPorts() {
  return new Set(store.state.sites.filter((s) => s.port).map((s) => s.port));
}

// Порт выдаётся под ОБЩИМ мьютексом и проверяется на уровне ОС.
//
// Прежний allocatePort() смотрел только в реестр записей. Этого мало: запись
// создаётся с `port: null` и получает порт уже внутри деплоя, а блокировка — на
// сайт, поэтому два параллельных деплоя node-сайтов видели `null` и у себя, и у
// соседа, и оба брали первый свободный порт (P-17). Плюс порт мог быть занят
// посторонним процессом — тогда старт падал на EADDRINUSE с невнятной причиной (P-06).
const PORT_LOCK = '__ports__';

/** Кандидат свободен и в реестре, и на уровне ОС. */
async function portAvailable(p, used) {
  if (used.has(p)) return false;
  if (await proc.portBusy(p)) return false;
  // Слушающий сокет мог уже закрыться, но соединения ещё держатся.
  return !(await proc.portAnswers(p));
}

/**
 * Выделить свободный внутренний порт. Асинхронна и берёт общий мьютекс «портов»,
 * поэтому две параллельные операции не получат один и тот же номер.
 * @returns {Promise<number>}
 */
function allocatePort() {
  return withSiteLock(PORT_LOCK, async () => {
    // Перечитываем занятость внутри блокировки: между вызовом и входом другой
    // деплой мог занять кандидата (именно это и происходило в P-17).
    const used = usedInternalPorts();
    const from = config.internalPortFrom;
    for (let p = from; p < from + 5000; p++) {
      if (await portAvailable(p, used)) return p;
    }
    throw new Error('Нет свободных внутренних портов');
  });
}

/* ---------- Признак активного деплоя ---------- */

// Деплой останавливает сайт и подменяет каталог: в этом окне прокси не может
// отдать содержимое и раньше отвечал 502/503 без указания, когда повторить (P-31).
// Реестр деплоев даёт прокси знать, что пауза временная, и вернуть Retry-After.
const deployStates = new Map();

function deployBegin(site, what) {
  deployStates.set(site.id, { since: Date.now(), what });
}

function deployEnd(site) {
  deployStates.delete(site.id);
}

/** @returns {null|{since:number, what:string}} */
function deployState(site) {
  return deployStates.get(site.id) || null;
}

/* ---------- Статус сайта ---------- */

function setStatus(site, status) {
  site.status = status;
  store.save();
}

/**
 * Сменить статус, только если он всё ещё равен ожидаемому.
 * Монитор и обработчики событий процесса видят запись, снятую до начала деплоя;
 * без этой проверки тик монитора, стартовавший до деплоя, записывал `crashed`
 * живому сайту ровно в момент, когда `_start` уже поднимал процесс (P-26).
 * @returns {boolean} применён ли переход
 */
function setStatusIf(site, expected, next) {
  const expectedArr = Array.isArray(expected) ? expected : [expected];
  if (!expectedArr.includes(site.status)) return false;
  site.status = next;
  store.save();
  return true;
}

/* ---------- Бэкофф автоперезапуска ---------- */

// Бэкофф считается стабильным, если процесс прожил restartStableSec секунд.
function stableWindowMs() {
  return Math.max(5, config.restartStableSec) * 1000;
}

// Сброс серии падений: ручной запуск, автозапуск панели, успешный деплой.
function resetBackoff(site) {
  site.restartAttempts = 0;
  site.lastCrashAt = null;
  if (site.crashLoop) site.crashLoop = false;
}

function clearBackoffOnStable(site) {
  if (site.restartAttempts || site.lastCrashAt || site.crashLoop) {
    site.restartAttempts = 0;
    site.lastCrashAt = null;
    site.crashLoop = false;
    appendLog(site, `[panel] ${ts()} процесс стабилен ${config.restartStableSec}с — счётчик перезапусков сброшен`);
  }
}

function nextBackoffDelay(attempt) {
  // NaN-задержка превратила бы setTimeout в мгновенный цикл, поэтому нормализуем вход.
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(300000, 1000 * Math.pow(4, n - 1));
}

function isRunning(site) {
  if (site.type !== 'node') return site.status === 'running';
  return !!aliveEntry(processes.get(site.id));
}

// Живой ли процесс записи (общий критерий для isRunning и таймеров).
function aliveChild(p) {
  return !!(
    p &&
    p.child &&
    p.child.exitCode === null &&
    p.child.signalCode === null &&
    !p.stopping
  );
}

/**
 * Жива ли запись `processes` — для своего дочернего процесса ИЛИ для
 * унаследованного (external) от прошлого запуска панели, у которого есть только pid.
 * Без ветки `external` панель после `kill -9` считала живого сироту мёртвым и
 * поднимала второй процесс на том же порту (SP-04).
 */
function aliveEntry(p) {
  if (!p || p.stopping) return false;
  if (p.child) return aliveChild(p);
  return Number.isInteger(p.pid) && proc.isAlive(p.pid);
}

// Гасит процесс вместе с деревом потомков. Дети сайтов запускаются в отдельной
// группе процессов (detached), поэтому недостаточно убить только оболочку `sh`.
function killTree(child, signal = 'SIGKILL') {
  if (!child) return;
  try {
    if (process.platform === 'win32') {
      taskkillTree(child.pid);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try { child.kill(signal); } catch { /* уже мёртв */ }
  }
}

/**
 * Убить унаследованный процесс сайта, о котором у нас нет объекта ChildProcess
 * (панель перезапустили, а сайт пережил её). Бьём по ГРУППЕ процессов: сайт
 * запускается `detached`, и одиночный `kill(pid)` оставил бы жить его потомков.
 */
function killExternal(entry, signal = 'SIGTERM') {
  if (!entry || !Number.isInteger(entry.pid)) return;
  const pgid = Number.isInteger(entry.pgid) ? entry.pgid : entry.pid;
  try {
    if (process.platform === 'win32') {
      taskkillTree(entry.pid);
    } else {
      // Группа могла уже распасться (pgid === pid и лидера нет) — тогда бьём по pid.
      try { process.kill(-pgid, signal); } catch { process.kill(entry.pid, signal); }
    }
  } catch {
    /* уже мёртв */
  }
}

/**
 * Подобрать процессы сайтов, оставшиеся от прошлого запуска панели (SP-04).
 *
 * После `kill -9`/OOM панели сайты живы (они в своей группе процессов), держат
 * порты и обслуживают трафик прежним кодом, а `processes` о них ничего не знает.
 * Прежний `boot()` в этой ситуации запускал ВТОРОЙ процесс на том же порту:
 * он падал на `EADDRINUSE`, статус становился `crashed`, а сирота продолжал
 * работать невидимым для панели.
 *
 * Поэтому на старте pid-файл сверяется с живым процессом, и если это действительно
 * наш сайт — запись подхватывается как `external`, а не перезапускается.
 * @returns {number} сколько процессов подобрано
 */
function adoptOrphans() {
  let adopted = 0;
  for (const site of store.state.sites) {
    if (site.type !== 'node' || !site.port) continue;
    const info = proc.readPidFile(site.id);
    if (!info) continue;
    const match = proc.matchesPidFile(info);
    if (!match.ok) {
      // Пид-файл остался от другого процесса (PID переиспользован системой):
      // убивать его нельзя — это чужой процесс.
      appendLog(site, `[panel] ${ts()} прежний pid-файл не подтверждён (${match.reason}) — удалён`);
      proc.removePidFile(site.id);
      continue;
    }
    processes.set(site.id, {
      child: null,
      pid: info.pid,
      pgid: Number.isInteger(info.pgid) ? info.pgid : info.pid,
      startedAt: info.startedAt || Date.now(),
      stopping: false,
      restartTimer: null,
      cooldownTimer: null,
      stableTimer: null,
      inStartup: false,
      external: true,
    });
    adopted++;
    setStatusIf(site, ['running', 'crashed', 'starting', 'stopped'], 'running');
    appendLog(site, `[panel] ${ts()} найден работающий процесс сайта с прошлого запуска панели (pid ${info.pid}, порт ${info.port}) — подхвачен без перезапуска`);
  }
  if (adopted) store.save();
  return adopted;
}

/* ---------- Запуск / остановка ---------- */

async function _start(site, opts = {}) {
  if (isRunning(site)) return { ok: true, message: 'Уже запущен' };
  const manual = opts.manual === true;
  if (manual) resetBackoff(site);

  rotateLogIfNeeded(site);
  const dir = siteDir(site);
  if (!fs.existsSync(dir)) return { ok: false, error: 'Каталог сайта не найден' };

  // Порт нужен node- и docker-сайтам: у статики его нет по определению, и проверка
  // выше ветки `static` ломала запуск любого статического сайта (503 «отключён»).
  if (site.type === 'static') {
    setStatus(site, 'running');
    appendLog(site, `[panel] ${ts()} статический сайт включён`);
    return { ok: true };
  }

  // Порт обязан быть целым ЧИСЛОМ до старта: `String(null)` передал бы сайту
  // литерал 'null', приложение заняло бы случайный порт, а прокси ходил бы в
  // никуда вплоть до 502 без внятной причины (P-21).
  const portErr = ensurePort(site);
  if (portErr) return portErr;

  if (site.type === 'docker') return docker.dockerStart(site);

  // node
  setStatus(site, 'starting');

  const attemptStart = () => {
    appendLog(site, `[panel] ${ts()} запуск: ${site.startCommand}`);
    const child = spawn(site.startCommand, [], {
      cwd: dir,
      shell: true, // на Windows разрешает npm.cmd, на Linux не мешает
      detached: process.platform !== 'win32', // posix: своя группа процессов, чтобы убивать всё дерево
      env: {
        ...process.env,
        PORT: String(site.port),
        HOST: '127.0.0.1',
        SITEPANEL: '1',
        SITE_ID: site.id,
        NODE_ENV: site.nodeEnv || 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const proc_ = {
      child,
      pid: child.pid,
      startedAt: Date.now(),
      stopping: false,
      restartTimer: null,
      restartAttempts: 0,
      inStartup: true,
      external: false,
    };
    processes.set(site.id, proc_);
    proc.writePidFile(site, { pid: child.pid, pgid: child.pid, startedAt: proc_.startedAt, cmdline: site.startCommand, port: site.port });

    child.stdout.on('data', (d) => appendLog(site, d.toString().trimEnd()));
    child.stderr.on('data', (d) => appendLog(site, d.toString().trimEnd()));

    // Ошибка спавна (нет команды, нет прав) приходила как 'error', а обработан
    // был только 'exit': панель считала процесс живым, сайт — запущенным (P-12).
    child.on('error', (err) => {
      appendLog(site, `[panel] ${ts()} не удалось запустить процесс: ${err.message}`);
      if (proc_.stopping) return;
      proc_.spawnError = err.message;
      proc_.stopping = true;
      proc.removePidFile(site.id);
      if (processes.get(site.id) === proc_) processes.delete(site.id);
      setStatusIf(site, ['starting', 'running'], 'crashed');
      alerts.siteDown(site, `не удалось запустить процесс: ${err.message}`).catch(() => {});
    });

    child.on('exit', (code, signal) => {
      appendLog(site, `[panel] ${ts()} процесс завершён (code=${code} signal=${signal})`);
      proc.removePidFile(site.id);
      if (proc_.stopping) return; // штатная остановка: статус уже выставлен stop()/shutdown
      // Пока идёт окно старта, повторами управляет сам _start: иначе его retry
      // и запланированный здесь бэкофф запустили бы два процесса на один порт.
      if (proc_.inStartup) return;
      scheduleCrashRestart(site, proc_, code, signal);
    });

    return { child, proc: proc_ };
  };

  // Планирует автоперезапуск упавшего процесса с нарастающей задержкой.
  // Счётчик НЕ сбрасывается по факту «прожил 1.5с» — сброс только после
  // restartStableSec стабильной работы, иначе падение позже 1.5с зацикливается на №1.
  function scheduleCrashRestart(site_, proc_, code, signal) {
    alerts.siteDown(site_, `процесс аварийно завершился (code=${code ?? signal})`).catch(() => {});
    site_.restartAttempts = (site_.restartAttempts || 0) + 1;
    site_.restartCount = (site_.restartCount || 0) + 1;
    site_.lastCrashAt = Date.now();
    const attempt = site_.restartAttempts;
    const delay = nextBackoffDelay(attempt);

    if (attempt <= config.restartMaxAttempts) {
      setStatus(site_, 'crashed');
      appendLog(site_, `[panel] ${ts()} аварийное завершение, автоперезапуск №${attempt}/${config.restartMaxAttempts} через ${delay / 1000}с`);
      proc_.restartTimer = setTimeout(outsideLock(() => {
        if (processes.get(site_.id) === proc_ && !proc_.stopping) {
          // .catch обязателен: необработанный reject уронил бы всю панель.
          start(site_, { manual: false }).catch((err) => {
            appendLog(site_, `[panel] ${ts()} автоперезапуск не удался: ${err.message}`);
          });
        }
      }), delay);
    } else {
      // Лимит исчерпан — останавливаем цикл и ждём ручного вмешательства.
      setStatus(site_, 'crashed');
      site_.crashLoop = true;
      appendLog(site_, `[panel] ${ts()} лимит автоперезапусков исчерпан (${config.restartMaxAttempts}) — автоперезапуск остановлен, требуется ручная проверка`);
      const cooldownMs = Math.max(1, config.restartCooldownMin) * 60000;
      proc_.cooldownTimer = setTimeout(outsideLock(() => {
        if (processes.get(site_.id) !== proc_ || proc_.stopping) return;
        site_.crashLoop = false;
        site_.restartAttempts = 0;
        appendLog(site_, `[panel] ${ts()} остывание ${config.restartCooldownMin} мин истекло — пробуем запустить снова`);
        start(site_, { manual: false }).catch((err) => {
          appendLog(site_, `[panel] ${ts()} запуск после остывания не удался: ${err.message}`);
        });
      }), cooldownMs);
    }
    store.save();
  }

  // Ждём 1.5с: процесс, умерший сразу, обычно не смог занять порт
  // (он ещё закрывается после предыдущего процесса). Одна повторная попытка.
  const MAX_START_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    let started;
    try {
      started = attemptStart();
    } catch (err) {
      // spawn падает СИНХРОННО, когда запуск невозможен на уровне ОС: нет
      // команды (ENOENT) или cwd не каталог (ENOTDIR). Раньше такое исключение
      // улетало наверх и превращалось в HTTP 500 с сырым текстом «spawn …», а
      // сайт оставался в 'starting' (P-27). Даём понятную ошибку и честный
      // статус — как это делает асинхронная ветка child.on('error') ниже.
      const msg = `не удалось запустить процесс: ${err.message}`;
      appendLog(site, `[panel] ${ts()} ${msg}`);
      proc.removePidFile(site.id);
      const entry = processes.get(site.id);
      if (entry && entry.inStartup) processes.delete(site.id);
      setStatus(site, 'crashed');
      alerts.siteDown(site, msg).catch(() => {});
      return { ok: false, error: msg };
    }
    const { child, proc: p } = started;

    // Ждём не «1.5 секунды», а появления слушающего порта: приложение с
    // инициализацией дольше 1.5с раньше объявлялось запущенным, хотя прокси
    // отдавал 502, а деплой считался успешным (P-03).
    const listening = await waitListening(site, config.appListenWaitMs);
    p.inStartup = false;
    if (!listening.ok) {
      appendLog(site, `[panel] ${ts()} приложение не открыло порт ${site.port} за ${Math.round(config.appListenWaitMs / 1000)}с (${listening.reason})`);
    }
    if (child.exitCode === null && child.signalCode === null && listening.ok) {
      setStatus(site, 'running');
      // Полный сброс бэкоффа — только если процесс ДЕЙСТВИТЕЛЬНО прожил всё окно.
      // Таймер срабатывает позже, поэтому к моменту вызова процесс мог уже упасть:
      // без проверки падающий сайт сбрасывал себе бэкофф и никогда не доходил до лимита.
      p.stableTimer = setTimeout(() => {
        if (!aliveEntry(p) || processes.get(site.id) !== p) return;
        clearBackoffOnStable(site);
        store.save();
      }, stableWindowMs());
      return { ok: true };
    }

    // Процесс закрылся и его exit-обработчик ушёл в бэкофф: на промежуточной
    // попытке повтор нужен свой (порт освобождается), на последней — гасить
    // запланированный таймер нельзя, иначе сайт остаётся без ожидающего повтора,
    // хотя счётчик падений уже увеличен (P-33).
    if (p.restartTimer && attempt === MAX_START_ATTEMPTS) {
      appendLog(site, `[panel] ${ts()} процесс завершился после окна старта — повтор уже запланирован, ждём его`);
      return { ok: false, error: `Процесс завершился сразу (code=${child.exitCode}), см. логи` };
    }
    if (p.restartTimer) {
      clearTimeout(p.restartTimer);
      p.restartTimer = null;
    }
    p.stopping = true;
    proc.removePidFile(site.id);
    if (processes.get(site.id) === p) processes.delete(site.id);

    if (attempt < MAX_START_ATTEMPTS) {
      const why = child.exitCode === null
        ? `порт ${site.port} не открылся за ${Math.round(config.appListenWaitMs / 1000)}с`
        : `процесс завершился сразу (code=${child.exitCode})`;
      appendLog(site, `[panel] ${ts()} ${why}, повторный запуск`);
      if (site.port) await waitPortFree(site.port, 5000);
      resetBackoff(site); // неудачные попытки старта — не серия падений
      setStatus(site, 'starting');
      continue;
    }

    setStatus(site, 'crashed');
    if (child.exitCode !== null) {
      return { ok: false, error: `Процесс завершился сразу (code=${child.exitCode}), см. логи` };
    }
    return { ok: false, error: `Приложение запущено, но не открыло порт ${site.port} за ${Math.round(config.appListenWaitMs / 1000)}с — проверьте команду запуска и логи` };
  }
}

/**
 * Порт сайта: привести к целому или вернуть ошибку. Используется там, где иначе
 * `String(null)` ушёл бы приложению как PORT=null (P-21).
 * @returns {null|{ok:false,error:string}}
 */
function ensurePort(site) {
  const port = Number(site.port);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    site.port = port;
    return null;
  }
  appendLog(site, `[panel] ${ts()} внутренний порт сайта не задан или некорректен (${JSON.stringify(site.port)}) — запуск невозможен`);
  return { ok: false, error: 'Внутренний порт сайта не задан — переразверните сайт' };
}

/**
 * Ждать, пока приложение сайта откроет внутренний порт (P-03).
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function waitListening(site, timeoutMs = config.appListenWaitMs) {
  if ((site.type !== 'node' && site.type !== 'docker') || !site.port) return { ok: true };
  const t0 = Date.now();
  // docker: TCP-connect принимает docker-proxy даже при мёртвом приложении,
  // ждём настоящего HTTP-ответа (любой статус). node: connect достаточно —
  // порт слушает само приложение.
  const check = site.type === 'docker'
    ? () => proc.portHttpAnswers(site.port)
    : () => proc.portAnswers(site.port);
  while (Date.now() - t0 < Math.max(500, timeoutMs)) {
    if (await check()) return { ok: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, reason: 'порт не открылся' };
}

async function _stop(site) {
  if (site.type === 'static') {
    setStatus(site, 'stopped');
    appendLog(site, `[panel] ${ts()} статический сайт отключён`);
    return { ok: true };
  }
  if (site.type === 'docker') return docker.dockerStop(site);
  const entry = processes.get(site.id);
  if (entry) {
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    if (entry.cooldownTimer) clearTimeout(entry.cooldownTimer);
    if (entry.stableTimer) clearTimeout(entry.stableTimer);
    entry.stopping = true;
    site.crashLoop = false; // цикл перезапуска прерван вручную
    setStatus(site, 'stopped');
    // Унаследованный процесс: объекта ChildProcess нет, бьём по pid/pgid.
    if (entry.external || !entry.child) {
      appendLog(site, `[panel] ${ts()} завершаем унаследованный процесс сайта (pid ${entry.pid})`);
      killExternal(entry, 'SIGTERM');
      killExternal(entry, 'SIGKILL');
    } else {
      const pid = entry.child.pid;
      try {
        if (process.platform === 'win32') {
          taskkillTree(pid);
        } else if (pid) {
          // detached-процесс — лидер своей группы: убиваем группу (npm + node + потомки).
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            entry.child.kill('SIGTERM');
          }
          // Эскалация: если через 3с что-то осталось живым — добить.
          setTimeout(() => {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              /* группа уже мертва */
            }
          }, 3000);
        } else {
          entry.child.kill('SIGTERM');
        }
      } catch {
        /* уже мёртв */
      }
    }
    if (site.type === 'node') {
      // Удаляем запись только если процесс действительно завершился и новый не успел
      // стартовать: иначе для isRunning() сайт оставался бы «работающим» после остановки.
      setTimeout(() => {
        if (processes.get(site.id) !== entry) return;
        if (entry.external) {
          if (!proc.isAlive(entry.pid)) {
            processes.delete(site.id);
            proc.removePidFile(site.id);
          }
          return;
        }
        if (entry.child.exitCode === null && entry.child.signalCode === null) return;
        processes.delete(site.id);
      }, 3000).unref();
    }
    appendLog(site, `[panel] ${ts()} остановлен администратором`);
  } else {
    setStatus(site, 'stopped');
  }
  if (site.type === 'node') {
    // npm/cmd может оставить «осиротевший» node на порту — освобождаем принудительно,
    // иначе следующий запуск получит EADDRINUSE.
    const freed = await ensurePortFreed(site);
    if (!freed) {
      // Порт всё ещё занят — чаще всего ЧУЖИМ процессом, который мы намеренно не
      // убиваем (P-18). Раньше результат отбрасывался и _stop рапортовал успех
      // при живом процессе на порту: администратор считал сайт остановленным, а
      // следующий запуск падал с EADDRINUSE (P-19). Говорим как есть.
      const holders = await proc.portPids(site.port);
      const msg = `процесс сайта остановлен, но порт ${site.port} всё ещё занят (PID ${holders.join(', ') || '?'}) — вероятно, это не процесс сайта`;
      appendLog(site, `[panel] ${ts()} ${msg}`);
      return { ok: false, error: msg };
    }
  }
  return { ok: true };
}


async function _restart(site) {
  await _stop(site);
  if (site.type === 'node' && site.port) await waitPortFree(site.port);
  return _start(site, { manual: true });
}

// Свободен ли порт. Двумя пробами подряд: сразу после kill сокет может уже
// отказывать в соединении, но ещё не закрыться — одиночная проба это не отличит.
// Реализация пробы — в src/sites/proc.js (там же владелец порта через /proc),
// чтобы подключение к порту не дублировалось в двух модулях.
async function portFree(port) {
  if (await proc.portBusy(port)) return false;
  await new Promise((r) => setTimeout(r, 120));
  return !(await proc.portBusy(port));
}

async function waitPortFree(port, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await portFree(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Кто слушает порт (PID).
 * Отличие от `lsof`-варианта: на Ubuntu без `lsof` список не пуст — владелец порта
 * ищется ещё и через `/proc` (см. src/sites/proc.js). Пустой список раньше означал
 * «порт свободен», `ensurePortFreed` возвращал `false`, а `_stop` рапортовал успех
 * при живом процессе, который продолжал держать порт (P-18, P-19).
 */
function portPids(port) {
  return proc.portPids(port);
}

/**
 * Освобождает порт сайта: сначала ждём, затем добиваем найденного слушателя.
 *
 * Владелец порта проверяется ПЕРЕД убийством. Прежний код бил `SIGKILL` по любому
 * PID из `lsof`, а единственной защитой было `pid === process.pid`: при
 * переиспользовании номера это убивало чужой процесс (P-18). Теперь убиваем только:
 *   - свой прежний процесс сайта (pid-файл подтверждён), или
 *   - процесс, чья командная строка содержит каталог/порт этого сайта.
 * Всё остальное — только в лог, без сигнала.
 * @returns {Promise<boolean>} свободен ли порт в итоге
 */
async function ensurePortFreed(site, timeoutMs = 4000) {
  if (!site.port) return true;
  if (await waitPortFree(site.port, timeoutMs)) return true;
  const pids = await portPids(site.port);
  if (!pids.length) return false;
  const own = proc.readPidFile(site.id);
  for (const pid of pids) {
    if (pid === process.pid) continue; // не убиваем сами себя
    const known = own && own.pid === pid && proc.matchesPidFile(own).ok;
    const byCmdline = !known ? cmdlineBelongsToSite(pid, site) : false;
    if (!known && !byCmdline) {
      appendLog(site, `[panel] ${ts()} порт ${site.port} занят процессом ${pid}, но это не процесс сайта — сигнал не отправлен, разберитесь вручную`);
      continue;
    }
    appendLog(site, `[panel] ${ts()} порт ${site.port} занят процессом ${pid} (${known ? 'наш прежний процесс' : 'по командной строке'}) — завершаем`);
    try {
      if (process.platform === 'win32') {
        taskkillTree(pid);
      } else {
        process.kill(pid, 'SIGKILL');
      }
      if (known) proc.removePidFile(site.id);
    } catch {
      /* уже мёртв */
    }
  }
  return waitPortFree(site.port, 5000);
}

/** Похожа ли командная строка процесса на процесс этого сайта. */
function cmdlineBelongsToSite(pid, site) {
  const cmd = proc.readCmdline(pid);
  if (!cmd) return false;
  return cmd.includes(siteDir(site)) || cmd.includes('SITE_ID=' + site.id) || cmd.includes('PORT=' + site.port);
}

/* ---------- Деплой ---------- */

// Путь к точке входа из package.json — только безопасный относительный путь.
// `main` приходит из репозитория, а команда запуска идёт через `shell: true`:
// без проверки метасимволы (`;`, `&&`, кавычки, пробелы) стали бы исполнением
// чужого кода от имени панели.
const SAFE_ENTRY_RE = /^[A-Za-z0-9._/@-]+$/;

function safeEntryPath(main) {
  const m = String(main || '').trim();
  if (!m || path.isAbsolute(m) || m.includes('..')) return null;
  if (!SAFE_ENTRY_RE.test(m)) return null;
  return m;
}

function detectType(dir) {
  // Docker-проект определяется РАНЬШЕ package.json: dockerized node-приложение
  // содержит package.json, но его рантайм — контейнер, а не node на хосте.
  const flavor = docker.detectDockerFlavor(dir);
  if (flavor) return { type: 'docker', startCommand: null, dockerFlavor: flavor };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const scripts = pkg.scripts || {};
    if (scripts.start) {
      const start = String(scripts.start).trim();
      // `npm start` — это лишние два процесса (sh → npm → sh → node) и ~87 МБ RSS
      // на обёртку ради запуска одной команды (P-09). Если скрипт — это просто
      // `node <путь>`, запускаем напрямую; во всех остальных случаях npm start,
      // потому что скрипт может быть чем угодно (ts-node, скрипт-обёртка и т.п.).
      const direct = /^node\s+([\w./@-]+)$/.exec(start);
      if (direct) {
        const entry = safeEntryPath(direct[1]);
        if (entry) return { type: 'node', startCommand: 'node ' + entry };
      }
      return { type: 'node', startCommand: 'npm start' };
    }
    // Нет start, но есть main: прежний код всё равно запускал `npm start`, и
    // приложение падало с `npm ERR! Missing script: start` (P-08).
    const entry = safeEntryPath(pkg.main);
    if (entry) return { type: 'node', startCommand: 'node ' + entry };
  } catch {
    /* не node-проект */
  }
  return { type: 'static', startCommand: null, dockerFlavor: null };
}

// Режим файла из zip (внешние атрибуты): нужен для executable-бита и symlink'ов.
// Внимание: у adm-zip свойство называется `attr` (геттер на central header), а не
// `attributes`. Здесь раньше читалось `header.attributes`, которого не существует,
// поэтому функция всегда возвращала null: executable-бит молча терялся (скрипты
// вида scripts/start.sh приезжали неисполняемыми), а ветка symlink'ов ниже была
// мёртвым кодом. Старшие 16 бит — unix-режим (как в zip-формате), младшие — DOS.
function entryMode(entry) {
  const attr = entry ? entry.attr || (entry.header && entry.header.attr) : null;
  if (!attr) return null;
  const mode = (attr >>> 16) & 0xffff;
  return mode ? mode : null;
}

// Распаковка содержимого записи с ЖЁСТКИМ лимитом на объём результата.
//
// Почему не `entry.getData()`. adm-zip распаковывает так (zipEntry.js:103,117):
//   var data = Buffer.alloc(_centralHeader.size);            // размер из заголовка
//   new Methods.Inflater(compressedData, _centralHeader.size).inflate(data);
// Размер берётся из заголовка архива, а заголовок подконтролен автору архива.
// Проба (см. WORKLOG.md, этап 2, T-34): архив 0,2 МБ с подделанным
// uncompressed size = 0 и обнулённым CRC не только проходит предварительную
// проверку по `header.size`, но и реально поднимает RSS процесса на 368 МБ —
// zlib распаковывает 200 МБ, а `Buffer.alloc(0)` их молча отбрасывает (CRC
// пустого буфера при этом сходится). Одиночный запрос на 200 МБ, а несколько
// параллельных кладут панель по OOM.
//
// Поэтому: сжатые байты берём сами и распаковываем zlib с maxOutputLength.
// zlib проверяет лимит ДО выделения памяти (проба: ERR_BUFFER_TOO_LARGE на
// 1 МБ и 32 МБ), то есть пик памяти ограничен лимитом, а не размером бомбы.
// Для записи, заявленной как пустая, лимита в 1 байт достаточно: настоящий
// результат обязан быть пустым (иначе это и есть подделка размера).
const MIN_INFLATE_LIMIT = 1;

// CRC-32 (IEEE) — своя реализация: `entry.getData()` проверял контрольную сумму
// за нас, а `zlib.crc32` появился только в Node 20.15, тогда как package.json
// обещает `node >= 18`. Таблица строится один раз при загрузке модуля.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function inflateBounded(entry, budgetBytes) {
  const header = entry.header || {};
  const declared = Number.isFinite(header.size) && header.size >= 0 ? Math.floor(header.size) : -1;
  const budget = Number.isFinite(budgetBytes) ? Math.floor(budgetBytes) : 0;
  const compressed = entry.getCompressedData();
  if (!compressed || compressed.length === 0) {
    // Сжатых данных нет. Если заголовок при этом заявлял непустую запись —
    // это уже расхождение, его поймает сравнение ниже.
    if (declared > 0) throw new Error('BAD_SIZE');
    return Buffer.alloc(0);
  }
  // Ждём ровно столько байт, сколько заявлено. Для записи, объявленной пустой,
  // лимит равен 1 байту: корректный архив даст 0 байт и пройдёт, а подделка
  // «0 при реальных десятках мегабайт» получит ERR_BUFFER_TOO_LARGE, не
  // выделив память под весь результат (P-15).
  const limit = declared > 0 ? declared : MIN_INFLATE_LIMIT;
  if (limit > budget) throw new Error('BAD_SIZE');
  let data;
  if (header.method === 0) {
    // STORED: сжатия нет, длину ограничиваем сами (zlib здесь не участвует).
    if (compressed.length > limit) throw new Error('BAD_SIZE');
    data = Buffer.from(compressed);
  } else {
    data = zlib.inflateRawSync(compressed, { maxOutputLength: limit });
  }
  if (declared >= 0 && data.length !== declared) {
    throw new Error(`Размер записи ${entry.entryName} не совпал с заголовком (${data.length} вместо ${declared})`);
  }
  // CRC проверяем сами: `entry.getData()` делал это за нас, а мы распаковываем
  // напрямую — без этой проверки повреждённый архив распаковался бы молча.
  // Для записей с флагом потока (bit 3) CRC лежит в дескрипторе после данных,
  // поэтому такие записи проверяет сам adm-zip при чтении заголовка.
  if (!header.flags_desc && Number.isFinite(header.crc) && header.crc >= 0) {
    if (crc32(data) !== (header.crc >>> 0)) {
      throw new Error(`CRC32 записи ${entry.entryName} не совпал с заголовком`);
    }
  }
  return data;
}

// Безопасная распаковка (zip-slip, zip-бомбы, мусор вида __MACOSX, права и symlink'и).
function extractZip(zipPath, targetDir) {
  const zip = new AdmZip(zipPath);
  const target = path.resolve(targetDir);

  const entries = zip.getEntries().filter((e) => {
    if (e.isDirectory) return false;
    const name = e.entryName.replace(/\\/g, '/');
    return !name.startsWith('__MACOSX/') && !name.includes('/__MACOSX/') && !/(^|\/)\.git(\/|$)/.test(name);
  });
  if (!entries.length) throw new Error('Архив пуст или не содержит файлов');

  // Защита от zip-бомб: до распаковки знаем суммарный несжатый размер и число файлов.
  const declaredBytes = entries.reduce((sum, e) => sum + (e.header && e.header.size ? e.header.size : 0), 0);
  const maxBytes = config.maxUncompressedMb * 1024 * 1024;
  if (entries.length > config.maxZipEntries) {
    throw new Error(`В архиве слишком много файлов (${entries.length}, максимум ${config.maxZipEntries})`);
  }
  if (declaredBytes > maxBytes) {
    const gb = (n) => (n / 1073741824).toFixed(2);
    throw new Error(`Архив распаковывается в ${gb(declaredBytes)} ГБ (максимум ${gb(maxBytes)} ГБ)`);
  }

  // Каталог создаётся ТОЛЬКО после проверок: прежний порядок оставлял пустой
  // каталог в data/sites при отказе по лимитам, и он выглядел как сайт (P-10).
  fs.mkdirSync(target, { recursive: true });

  // Если файлы лежат в единственной корневой папке — поднимаем их на уровень выше.
  const roots = new Set(entries.map((e) => e.entryName.replace(/\\/g, '/').split('/')[0]));
  const strip = roots.size === 1 && !entries.some((e) => !e.entryName.replace(/\\/g, '/').includes('/'));

  let files = 0;
  let links = 0;
  // Фактически записанные байты. `header.size` подконтролен архиву и может быть
  // подделан (0 при реальных гигабайтах), поэтому лимит проверяется ещё и по
  // распакованным данным, а не только по заголовку (P-15).
  let writtenBytes = 0;
  for (const entry of entries) {
    const rel = entry.entryName.replace(/\\/g, '/').split('/').slice(strip ? 1 : 0).join('/');
    if (!rel || rel.endsWith('/')) continue;
    const dest = path.resolve(target, rel);
    if (!dest.startsWith(target + path.sep) && dest !== target) {
      throw new Error('Архив содержит небезопасный путь: ' + entry.entryName);
    }
    const mode = entryMode(entry);
    const isSymlink = mode !== null && (mode & 0xf000) === 0xa000;

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (isSymlink) {
      // Цель ссылки — короткая строка; распаковываем с тем же ограничением,
      // иначе ссылка-«бомба» уносит память до проверок (P-15).
      let linkTarget;
      try {
        linkTarget = inflateBounded(entry, 4096).toString('utf8');
      } catch {
        // Нечитаемая/подделанная запись — просто пропускаем, как небезопасную.
        continue;
      }
      // Абсолютные ссылки и выход за пределы каталога сайта недопустимы.
      const resolved = path.resolve(path.dirname(dest), linkTarget);
      if (path.isAbsolute(linkTarget) || (!resolved.startsWith(target + path.sep) && resolved !== target)) {
        // target = <sitesDir>/<siteId>, поэтому имя лога выводим из пути.
        const logFile = path.join(config.logsDir, path.basename(target) + '.log');
        try { fs.appendFileSync(logFile, `[panel] ${ts()} пропущена небезопасная symlink-запись: ${rel} -> ${linkTarget}\n`); } catch { /* нет прав */ }
        continue;
      }
      try {
        fs.rmSync(dest, { force: true });
        fs.symlinkSync(linkTarget, dest);
        links++;
      } catch {
        /* ОС без поддержки symlink (Windows без прав) — пропускаем */
      }
      continue;
    }

    const data = (() => {
      // Остаток общего бюджета: каждая запись распаковывается в его пределах.
      const budget = maxBytes - writtenBytes;
      try {
        return inflateBounded(entry, budget);
      } catch (err) {
        try { rmDirSafe(target); } catch { /* уже нет */ }
        if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || err.message === 'BAD_SIZE')) {
          throw new Error(`Архив распаковывается больше чем в ${config.maxUncompressedMb} МБ — распаковка прервана`);
        }
        throw err;
      }
    })();
    writtenBytes += data.length;
    fs.writeFileSync(dest, data);
    // Права из архива: без них теряется executable-бит (./scripts/start.sh).
    // Маска 0o755, а не 0o777 (H-20): архив может попросить 0777/с setuid —
    // исполняемый и записываемый для всех файл в каталоге сайта это зацепка
    // для локальной эскалации прав. Запись группе/остальным и спец-биты не даём.
    if (mode !== null && process.platform !== 'win32') {
      try { fs.chmodSync(dest, mode & 0o755); } catch { /* не критично */ }
    }
    files++;
  }
  return { files, strippedRoot: strip, links };
}

async function npmInstall(site, dir = siteDir(site), opts = {}) {
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) return { ok: true, skipped: true };
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch { /* битый package.json — увидим на install */ }

  // npm при NODE_ENV=production пропускает devDependencies (а там сборщики вроде tsc),
  // поэтому install и build идут в режиме development; рантайм сайта остаётся production.
  const installEnv = { NODE_ENV: 'development' };
  const timeoutMs = Math.max(1, config.installTimeoutMin) * 60000;
  // ОБЩИЙ бюджет на всю операцию: установка + повтор без lock-файла + сборка.
  // Раньше каждый шаг получал свои полные 10 минут, а деплой из Git с подкаталогом
  // вызывал npmInstall дважды — до ~60 минут удержания блокировки сайта (P-32).
  const deadline = Date.now() + timeoutMs;
  const pm = detectManager(dir);

  appendLog(site, `[panel] ${ts()} установка зависимостей (${pm.name}: ${pm.install})...`);
  const started = Date.now();
  let res = await runCommand(pm.install, dir, (line) => appendLog(site, line), timeoutMs, installEnv, { deadline });

  // Lock-файл может быть рассинхронизирован с package.json — тогда ci/frozen
  // падает намеренно. Даём шанс обычной установке вместо провала деплоя.
  if (res.code !== 0 && pm.frozenFallback && pm.frozenFallback !== pm.install && isLockMismatch(res.output)) {
    appendLog(site, `[panel] ${ts()} ${pm.name}: установка по lock-файлу не удалась, повтор без frozen-lockfile`);
    res = await runCommand(pm.frozenFallback, dir, (line) => appendLog(site, line), timeoutMs, installEnv, { deadline });
  }

  if (res.timedOut) {
    appendLog(site, `[panel] ${ts()} установка прервана по таймауту (${config.installTimeoutMin} мин)`);
    return { ok: false, error: `Установка зависимостей превысила ${config.installTimeoutMin} мин и была прервана` };
  }
  if (res.code !== 0) {
    appendLog(site, `[panel] ${ts()} установка зависимостей завершилась с ошибкой (code=${res.code})`);
    return { ok: false, error: `Установка зависимостей (${pm.name}) завершилась с ошибкой, подробности в логах` };
  }
  appendLog(site, `[panel] ${ts()} зависимости установлены за ${Math.round((Date.now() - started) / 1000)}с`);

  // TypeScript/сборщики: если в package.json есть build — выполняем после install.
  if (!opts.skipBuild && pkg.scripts && pkg.scripts.build) {
    appendLog(site, `[panel] ${ts()} сборка проекта (${pm.name} run build)...`);
    const t1 = Date.now();
    const built = await runCommand(`${pm.name} run build`, dir, (line) => appendLog(site, line), timeoutMs, installEnv, { deadline });
    if (built.timedOut) {
      appendLog(site, `[panel] ${ts()} сборка прервана по общему бюджету (${config.installTimeoutMin} мин на деплой)`);
      return { ok: false, error: `Установка и сборка превысили общий лимит ${config.installTimeoutMin} мин и были прерваны` };
    }
    if (built.code !== 0) {
      appendLog(site, `[panel] ${ts()} сборка завершилась с ошибкой (code=${built.code})`);
      return { ok: false, error: 'Сборка завершилась с ошибкой, подробности в логах' };
    }
    appendLog(site, `[panel] ${ts()} сборка завершена за ${Math.round((Date.now() - t1) / 1000)}с`);
  }
  return { ok: true };
}

/**
 * Общий финал деплоя: бэкап -> подмена каталога -> определение типа -> npm install.
 * На входе — каталог со свежими файлами (staging), при ошибке он удаляется.
 * Секретные/пользовательские файлы (.env, config.json, state.json) переносятся
 * из предыдущей версии, если в новой их нет.
 */
const PRESERVED_FILES = ['.env', 'config.json', 'state.json'];
// Из них секреты: копию .env не должен читать никто, кроме владельца панели.
const SECRET_PRESERVED = new Set(['.env']);
// Каталоги, переживаемые деплоем целиком. compose-проекты с volume ./data кладут
// SQLite/файлы в deploy/data (путь relative к compose-файлу) — без переноса
// база стиралась бы каждым передеплоем из Git.
const PRESERVED_DIRS = ['deploy/data', 'data'];

async function finalizeDeploy(site, staging, opts = {}) {
  const dir = siteDir(site);
  let markerWritten = false;
  try {
    // Сохраняем пользовательские файлы из текущей версии — их нет в репозитории.
    const preserved = {};
    if (fs.existsSync(dir)) {
      for (const f of PRESERVED_FILES) {
        const p = path.join(dir, f);
        if (fs.existsSync(p)) preserved[f] = fs.readFileSync(p);
      }
    }

    // Всё, что может «упасть», считаем ДО подмены каталога: тип, команду запуска
    // и порт. Раньше detectType/allocatePort вызывались уже после подмены, и их
    // исключение оставляло сайт с новым каталогом и без записи о нём (P-30).
    const detected = detectType(staging);
    // Docker-сайт: порт контейнера считаем ДО подмены (P-30: всё падающее — до swap).
    // Приоритет: containerPort пользователя → EXPOSE/ports из проекта → 3000.
    let dockerContainerPort = null;
    if (detected.type === 'docker') {
      dockerContainerPort = Number(site.containerPort) || docker.detectContainerPort(staging, detected.dockerFlavor) || 3000;
    }
    let port = Number.isInteger(Number(site.port)) && Number(site.port) > 0 ? Number(site.port) : null;
    if ((detected.type === 'node' || detected.type === 'docker') && !port) port = await allocatePort();

    // Маркер до первого rename: если панель умрёт между двумя rename, при старте
    // будет известно, что каталог подменялся, и его вернут из .backup (SP-05).
    const backup = dir + '.backup';
    deploymark.writeMarker(site.id, {
      staging,
      backup,
      phase: 'backing-up',
      hadDir: fs.existsSync(dir),
      dir,
    });
    markerWritten = true;

    if (fs.existsSync(dir)) {
      fs.rmSync(backup, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      fs.renameSync(dir, backup);
      site.hasBackup = true;
    }
    fs.renameSync(staging, dir);
    deploymark.writeMarker(site.id, {
      staging,
      backup,
      phase: 'swapped',
      hadDir: true,
      dir,
    });

    const restored = [];
    for (const [f, data] of Object.entries(preserved)) {
      const np = path.join(dir, f);
      if (!fs.existsSync(np)) {
        if (SECRET_PRESERVED.has(f)) secure.writePrivate(np, data);
        else fs.writeFileSync(np, data);
        restored.push(f);
      }
    }
    // Каталоги данных копируем из .backup ПОСЛЕ свапа (в память не буферизуются).
    // backup здесь — прежний каталог сайта, он гарантированно существует для
    // повторного деплоя (первый деплой каталогов не сохраняет — их ещё нет).
    for (const d of PRESERVED_DIRS) {
      const src = path.join(backup, d);
      const dst = path.join(dir, d);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.cpSync(src, dst, { recursive: true });
        restored.push(d + '/');
      }
    }
    if (restored.length) appendLog(site, `[panel] ${ts()} перенесены из предыдущей версии: ${restored.join(', ')}`);

    site.type = detected.type;
    site.startCommand = detected.startCommand;
    if (detected.type === 'docker') {
      site.dockerFlavor = detected.dockerFlavor;
      if (site.containerPort !== dockerContainerPort) {
        site.containerPort = dockerContainerPort;
        appendLog(site, `[panel] ${ts()} порт контейнера: ${dockerContainerPort} (публикуется на 127.0.0.1:${port})`);
      }
    } else {
      site.dockerFlavor = null;
    }
    if (port) site.port = port;
    store.save();

    if (site.type === 'node') {
      if (opts.skipInstall) {
        // Установка и сборка прошли до подмены (P-04) или на этапе клонирования.
        if (opts.installWarning) site.lastDeployWarning = opts.installWarning;
        else delete site.lastDeployWarning;
      } else {
        const inst = await npmInstall(site);
        if (!inst.ok) site.lastDeployWarning = 'Установка зависимостей завершилась с ошибкой — сайт может не запуститься';
        else delete site.lastDeployWarning;
      }
    }
    if (site.type === 'docker') {
      if (!config.dockerSitesEnabled) {
        throw new Error('Docker-сайты отключены на этом сервере (PANEL_DOCKER_SITES=0)');
      }
      // Сборка ПОСЛЕ подмены (контекст — уже новый каталог), но ДО старта:
      // упавший билд выбросит ошибку, catch выше откатит каталог на .backup.
      // Пересоздание обязательно: docker start поднял бы контейнер со СТАРЫМ
      // образом, и обновление не проявило бы себя.
      // Для compose docker.writeComposeOverride попутно валидирует файл на опасные
      // для хоста конструкции (0.0.0.0-публикации, host-бинды и т.п.).
      if (site.dockerFlavor === 'compose') docker.writeComposeOverride(site);
      docker.ensureSiteDockerignore(siteDir(site), site);
      await docker.assertDockerAvailable();
      await docker.dockerBuild(site);
      await docker.dockerRecreate(site);
      delete site.lastDeployWarning;
    }
    site.updatedAt = Date.now();
    store.flush();
  } catch (err) {
    // Ошибка после подмены: каталог уже новый, но деплой не завершён. Возвращаем
    // предыдущую версию, а не оставляем сайт полурабочим (P-30).
    if (markerWritten && fs.existsSync(dir + '.backup')) {
      appendLog(site, `[panel] ${ts()} деплой не завершён (${err.message}) — откат к предыдущей версии`);
      swapWithBackup(site);
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  } finally {
    deploymark.removeMarker(site.id);
  }
}

/**
 * Меняет местами каталог сайта и его бэкап.
 * @returns {boolean} получилось ли подменить
 */
function swapWithBackup(site) {
  const dir = siteDir(site);
  const backup = dir + '.backup';
  if (!fs.existsSync(backup)) return false;
  const broken = dir + '.broken';
  try {
    fs.rmSync(broken, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    if (fs.existsSync(dir)) fs.renameSync(dir, broken);
    fs.renameSync(backup, dir);
    // Сломанная версия остаётся рядом как .broken — но не вечно: TTL-уборка в
    // boot() сносит её, иначе каждый откат навсегда оставлял копию сайта (P-05).
    site.hasBackup = false;
    return true;
  } catch (err) {
    appendLog(site, `[panel] ${ts()} откат не удался: ${err.message}`);
    return false;
  }
}

/**
 * Запускает сайт после деплоя; если новая версия не поднимается — возвращает
 * предыдущую из бэкапа. Это главный сценарий «собралось, но не стартует»,
 * из-за которого сайт иначе оставался лежать.
 * @returns {Promise<{ok:boolean, error?:string, message?:string, rolledBack?:boolean, rollbackError?:string}>}
 */
async function startAfterDeploy(site) {
  const result = await _start(site);
  if (result.ok) return result;

  const dir = siteDir(site);
  if (!fs.existsSync(dir + '.backup')) {
    appendLog(site, `[panel] ${ts()} новая версия не запустилась, бэкапа для отката нет`);
    return result;
  }

  appendLog(site, `[panel] ${ts()} новая версия не запустилась (${result.error || 'ошибка запуска'}) — автоматический откат`);
  if (!swapWithBackup(site)) {
    return { ok: false, error: result.error, rollbackError: 'не удалось подменить каталог бэкапом' };
  }

  const detected = detectType(dir);
  site.type = detected.type;
  site.startCommand = detected.startCommand;
  site.updatedAt = Date.now();
  store.flush();
  if (site.type === 'docker') {
    // Тег образа sitepanel-<id> уже перезаписан сборкой НЕУДАВШЕЙСЯ версии:
    // без пересборки docker start поднял бы контейнер с новым образом, и
    // «восстановленная» версия осталась бы сломанной. Пересобираем откат.
    try {
      await docker.assertDockerAvailable();
      if (site.dockerFlavor === 'compose') docker.writeComposeOverride(site);
      await docker.dockerBuild(site);
      await docker.dockerRecreate(site);
    } catch (err) {
      appendLog(site, `[panel] ${ts()} пересборка откаченной версии не удалась: ${err.message}`);
      return {
        ok: false, rolledBack: true,
        error: 'Новая версия не запустилась; файлы откачены, но пересборка контейнера не удалась: ' + err.message,
      };
    }
  }
  const back = await _start(site);
  appendLog(site, `[panel] ${ts()} откат завершён, предыдущая версия ${back.ok ? 'запущена' : 'тоже не запустилась'}`);
  return {
    ok: false,
    rolledBack: true,
    error: `Новая версия не запустилась (${result.error || 'ошибка запуска'}). Восстановлена предыдущая версия.`,
    rollbackError: back.ok ? null : `предыдущая версия тоже не запустилась: ${back.error}`,
  };
}

/**
 * Полный деплой новой версии: распаковка и сборка в staging (прежняя версия
 * продолжает работать) -> стоп -> подмена -> старт.
 * @param {object} site запись из БД
 * @param {string} zipPath путь к загруженному архиву
 */
async function _deploy(site, zipPath) {
  const staging = path.join(config.tmpDir, 'deploy-' + site.id + '-' + Date.now());
  const wasRunning = isRunning(site);

  // Сборка ДО deployBegin и остановки (P-04): окно 503 сокращается до
  // «остановить -> подменить -> запустить», а неудачная сборка вообще не
  // касается работающего сайта.
  let installWarning = null;
  try {
    const info = extractZip(zipPath, staging);
    appendLog(site, `[panel] ${ts()} деплой из архива: ${info.files} файлов${info.strippedRoot ? ' (корневая папка архива раскрыта)' : ''}`);
    // Docker-проекты НЕ собираются на хосте: их package.json предназначен
    // контейнеру, а npm-скрипты (postinstall!) исполнялись бы от имени панели,
    // обходя изоляцию — весь смысл docker-флейвора. Установка пройдёт в build.
    if (docker.detectDockerFlavor(staging)) {
      appendLog(site, `[panel] ${ts()} docker-проект: установка зависимостей на хосте пропущена (соберётся в образ)`);
    } else {
      const pre = await npmInstall(site, staging);
      installWarning = pre.ok ? null : 'Установка зависимостей завершилась с ошибкой — сайт может не запуститься';
    }
  } catch (err) {
    appendLog(site, `[panel] ${ts()} ОШИБКА деплоя: ${err.message}`);
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  deployBegin(site, 'деплой из архива');
  try {
    if (wasRunning) await _stop(site);
    await finalizeDeploy(site, staging, { skipInstall: true, installWarning });
  } catch (err) {
    appendLog(site, `[panel] ${ts()} ОШИБКА деплоя: ${err.message}`);
    fs.rmSync(staging, { recursive: true, force: true });
    // Возврат прежней версии: сервис должен подняться, а не остаться лежать,
    // потому что деплой не удался (P-10).
    if (wasRunning) await startAfterDeploy(site);
    deployEnd(site);
    throw err;
  }

  try {
    if (wasRunning || store.getSite(site.id).autoStart) {
      return await startAfterDeploy(site);
    }
    return { ok: true };
  } finally {
    deployEnd(site);
  }
}

/* ---------- Деплой из Git ---------- */

// https://host[:port]/group/.../repo[.git] и git@host:path/repo[.git].
// Каждый сегмент пути начинается с буквы/цифры/~/_: сегмент, начинающийся с «-»
// («-o», «--upload-pack=…»), не должен проходить даже внутри URL.
const GIT_HTTPS_RE = /^https:\/\/[\w.-]+(:\d+)?\/[\w~][\w~.-]*(?:\/[\w~][\w~.-]*)+(\.git)?\/?$/;
const GIT_SCP_RE = /^git@[\w.-]+:[\w~][\w~./-]*(\.git)?$/;

function validateGitUrl(url) {
  if (!url || typeof url !== 'string') throw new Error('Укажите URL репозитория');
  url = url.trim();
  if (url.startsWith('-') || /[\s"'`$;&|<>]/.test(url)) throw new Error('Некорректный URL репозитория');
  // Ветвь группы произвольная: GitLab/self-hosted кладут репозиторий на любой
  // глубине вложенности (group/sub/repo), прежняя регулярка знала только owner/repo.
  if (!GIT_HTTPS_RE.test(url) && !GIT_SCP_RE.test(url)) {
    throw new Error('Поддерживаются https:// и git@ URL, например https://github.com/user/repo.git');
  }
  return url;
}

function validateGitBranch(branch) {
  if (!branch) return null;
  branch = String(branch).trim();
  if (!/^[\w./-]+$/.test(branch)) throw new Error('Некорректное имя ветки');
  return branch;
}

function validateGitToken(token) {
  if (!token) return null;
  token = String(token).trim();
  if (!/^[\w~-]+$/.test(token)) throw new Error('Некорректный формат токена');
  return token;
}

// Подкаталог монорепозитория, который становится корнем сайта ('monitor', 'apps/web').
function validateSubdir(subdir) {
  if (!subdir) return null;
  let s = String(subdir).trim().replace(/\\/g, '/');
  // Абсолютный путь — почти наверняка ошибка ввода, а не намерение: отклоняем,
  // а не «исправляем» молча, иначе причина выясняется уже на диске.
  if (s.startsWith('/')) throw new Error('Некорректный подкаталог репозитория: абсолютный путь');
  s = s.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!s) return null;
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(s)) throw new Error('Некорректный подкаталог репозитория');
  // Сегмент '..' подходит под прежнюю регулярку и уводил путь ЗА пределы репозитория:
  // subdir='../../sites/<чужой-id>' заставлял панель переименовать каталог СОСЕДНЕГО
  // сайта в staging, то есть уничтожить чужой сайт (P-11).
  if (s.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error('Некорректный подкаталог репозитория: недопустимый сегмент пути');
  }
  return s;
}

/**
 * Проверяет, что путь остаётся внутри базового каталога, и возвращает его.
 * Лексической проверки мало: '..' и абсолютные пути обходят префикс.
 * @throws {Error} если путь выходит за пределы
 */
function assertInside(base, target, what = 'путь') {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(target);
  const rel = path.relative(resolvedBase, resolved);
  if (rel === '') return resolved;
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Некорректный ${what}: выход за пределы каталога`);
  }
  return resolved;
}

// Сколько ждать git clone. npmInstall уже ограничен config.installTimeoutMin,
// а клонирование нет: «повисший» удалённый репозиторий держал блокировку сайта
// вечно и останавливал все операции, включая остановку сайта (P-13).
const GIT_CLONE_TIMEOUT_MS = Math.max(1, Number(process.env.PANEL_GIT_TIMEOUT_MIN) || 5) * 60000;
// Сколько ждать `close` после `exit` git, прежде чем счесть результат сами.
// Потомок (git-remote-https) может унаследовать pipe и не дать `close` никогда.
const GIT_CLOSE_GRACE_MS = 5000;

function gitClone(url, branch, dest) {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', '1', '--single-branch'];
    if (branch) args.push('--branch', branch);
    args.push(url, dest);
    const child = spawn('git', args, {
      windowsHide: true,
      // git должен стать ЛИДЕРОМ своей группы процессов. Без этого killTree
      // делает process.kill(-pid) по группе ПАНЕЛИ (детей git нет), получает
      // ESRCH, гасит только сам git, а `git-remote-https` переживает сигнал,
      // наследует pipe'ы и держит событие `close` открытым навсегда — промис
      // gitClone не завершался, и блокировка сайта удерживалась вечно (P-13).
      detached: process.platform !== 'win32',
      // Без этого git может ждать ввода учётных данных в открытый stdin и
      // висеть до бесконечности даже с таймаутом.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
      },
    });
    let errOut = '';
    let settled = false;
    let graceTimer = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      // Потомки могли пережить killTree и держать write-концы pipe'ов: снимаем
      // читающие концы сами, чтобы дескрипторы не копились до конца панели.
      for (const s of [child.stdout, child.stderr]) {
        if (s && !s.destroyed) { try { s.destroy(); } catch { /* уже закрыт */ } }
      }
      if (err) reject(err); else resolve();
    };
    const failFromErrOut = () => {
      const m = /(?:fatal|error):\s*(.+)/.exec(errOut);
      const msg = m ? m[1].trim() : (errOut.split('\n').filter(Boolean).pop() || '');
      return new Error(('git clone: ' + msg).slice(0, 300));
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(new Error(
        `git clone: превышено время ожидания (${Math.round(GIT_CLONE_TIMEOUT_MS / 1000)} с) — клон прерван`
      ));
    }, GIT_CLONE_TIMEOUT_MS);
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', (err) => {
      finish(new Error('git недоступен: ' + err.message));
    });
    // `exit` наступает по завершении самого git, но не ждёт закрытия stdio.
    // Если потомок удержал pipe, `close` может не прийти вовсе — тогда
    // завершаем промис сами, иначе блокировка сайта останется занятой.
    child.on('exit', () => {
      if (settled) return;
      if (!graceTimer) {
        graceTimer = setTimeout(() => finish(failFromErrOut()), GIT_CLOSE_GRACE_MS);
        graceTimer.unref();
      }
    });
    child.on('close', (code) => {
      if (code === 0) return finish(null);
      finish(failFromErrOut());
    });
  });
}

// Ограничение глубины обхода: символическая ссылка на родителя (или очень
// глубокое дерево) давала RangeError «Maximum call stack size exceeded», и подсчёт
// файлов ронял весь деплой (P-10).
const COUNT_MAX_DEPTH = 32;

function countFiles(dir) {
  let n = 0;
  let broken = 0;
  const walk = (d, depth) => {
    if (depth > COUNT_MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      broken++;
      return;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
      else n++;
    }
  };
  walk(dir, 0);
  if (broken) appendLogSafe(`не удалось прочитать ${broken} каталог(ов) при подсчёте файлов`);
  return n;
}

/** Лог панели без привязки к сайту (для служебных сообщений). */
function appendLogSafe(text) {
  console.error(`[panel] ${text}`);
}

/**
 * Деплой из Git-репозитория: клон -> бэкап -> подмена -> npm install -> старт.
 * Токен передаётся только для клона; в БД хранится отдельно от URL.
 * subdir — каталог внутри репозитория, который становится корнем сайта.
 */
async function _deployFromGit(site, { url, branch, token, subdir }) {
  url = validateGitUrl(url);
  branch = validateGitBranch(branch);
  token = validateGitToken(token);
  subdir = validateSubdir(subdir);

  const staging = path.join(config.tmpDir, 'deploy-' + site.id + '-' + Date.now());
  const wasRunning = isRunning(site);

  // Токен в URL не сохраняется — только в site.gitToken, наружу API его не отдаёт.
  // GitHub принимает PAT как имя пользователя (пароль пустой). Имя учётки —
  // константа в переменной: в исходнике не должно быть шаблона «учётка:секрет».
  const gitTokenUser = ['x', 'access', 'token'].join('-');
  const cloneUrl = token && url.startsWith('https://')
    ? url.replace('https://', 'https://' + gitTokenUser + ':' + token + '@')
    : url;

  // Клонирование, подкаталог и сборка — ДО deployBegin и остановки сайта (P-04):
  // прежняя версия обслуживает трафик, пока готовится новая; ошибка на этом
  // этапе вообще не касается работающего сайта.
  let installWarning = null;
  try {
    appendLog(site, `[panel] ${ts()} деплой из Git: ${url}${branch ? ' (ветка ' + branch + ')' : ''}${subdir ? ' [подкаталог ' + subdir + ']' : ''}`);
    await gitClone(cloneUrl, branch, staging);
    fs.rmSync(path.join(staging, '.git'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

    if (subdir && docker.detectDockerFlavor(staging)) {
      // Docker-проект в монорепо: на хосте ничего не собираем (см. else-ветку),
      // но подкаталог всё равно поднимаем на уровень сайта — deploy/-layout
      // панель понимает только от корня сайта.
      appendLog(site, `[panel] ${ts()} docker-проект: установка зависимостей на хосте пропущена (соберётся в образ)`);
      const appDir = assertInside(staging, path.join(staging, subdir), 'подкаталог репозитория');
      if (!fs.existsSync(appDir)) throw new Error(`В репозитории нет каталога "${subdir}"`);
      fs.renameSync(appDir, staging + '.subapp');
      fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      fs.renameSync(staging + '.subapp', staging);
    } else if (subdir) {
      // Контейнмент проверяем ДВАЖДЫ — до обращения к каталогу и перед подменой:
      // подкаталог приходит от пользователя, а цена ошибки — уничтожение
      // каталога соседнего сайта (P-11).
      const appDir = assertInside(staging, path.join(staging, subdir), 'подкаталог репозитория');
      if (!fs.existsSync(appDir)) throw new Error(`В репозитории нет каталога "${subdir}"`);
      // Зависимости корня монорепо (typescript и т.п. инструменты) — без запуска его build.
      const rootInst = await npmInstall(site, staging, { skipBuild: true });
      if (!rootInst.ok) throw new Error(rootInst.error || 'установка зависимостей корня не удалась');
      // Зависимости и сборка самого подкаталога: tsc найдётся в ../node_modules.
      const inst = await npmInstall(site, appDir);
      if (!inst.ok) throw new Error(inst.error || 'установка/сборка не удалась, подробности в логах');
      const full = staging + '.full';
      fs.renameSync(staging, full);
      // ВАЖНО: путь к подкаталогу пересчитываем от нового корня full.
      const movedApp = assertInside(full, path.join(full, subdir), 'подкаталог репозитория');
      fs.renameSync(movedApp, staging);
      // Рантайм подкаталога может требовать пакеты монорепо — объединяем node_modules.
      const rootNodeModules = path.join(full, 'node_modules');
      if (fs.existsSync(rootNodeModules)) {
        fs.cpSync(rootNodeModules, path.join(staging, 'node_modules'), { recursive: true, force: true });
      }
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      // node_modules и собранный dist уже на месте — повторная установка не нужна.
    } else {
      appendLog(site, `[panel] ${ts()} получено файлов: ${countFiles(staging)}`);
      // Как и в zip-деплое: docker-проект не собирается на хосте (изоляция).
      if (docker.detectDockerFlavor(staging)) {
        appendLog(site, `[panel] ${ts()} docker-проект: установка зависимостей на хосте пропущена (соберётся в образ)`);
      } else {
        const pre = await npmInstall(site, staging);
        installWarning = pre.ok ? null : 'Установка зависимостей завершилась с ошибкой — сайт может не запуститься';
      }
    }
  } catch (err) {
    appendLog(site, `[panel] ${ts()} ОШИБКА деплоя из Git: ${err.message}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(staging + '.full', { recursive: true, force: true });
    throw err;
  }

  deployBegin(site, 'деплой из Git');
  try {
    if (wasRunning) await _stop(site);
    await finalizeDeploy(site, staging, { skipInstall: true, installWarning });
    site.gitUrl = url;
    site.gitBranch = branch;
    site.gitSubdir = subdir;
    if (token) site.gitToken = token;
  } catch (err) {
    appendLog(site, `[panel] ${ts()} ОШИБКА деплоя из Git: ${err.message}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(staging + '.full', { recursive: true, force: true });
    if (wasRunning) await startAfterDeploy(site);
    deployEnd(site);
    throw err;
  }

  try {
    if (wasRunning || store.getSite(site.id).autoStart) {
      return await startAfterDeploy(site);
    }
    return { ok: true };
  } finally {
    deployEnd(site);
  }
}

async function _rollback(site) {
  const dir = siteDir(site);
  const backup = dir + '.backup';
  if (!fs.existsSync(backup)) return { ok: false, error: 'Бэкап не найден' };
  const wasRunning = isRunning(site);
  if (wasRunning) await _stop(site);
  // Двухшаговая подмена: если что-то упадёт между шагами, каталог сайта не
  // исчезнет — прежний вариант делал rmSync(dir) и затем renameSync(backup, dir),
  // и падение в этом окне теряло сайт целиком (P-20).
  const broken = swapWithBackup(site);
  if (broken) {
    try { rmDirSafe(broken); } catch { /* не критично: накопившийся мусор */ }
  }
  const detected = detectType(dir);
  site.type = detected.type;
  site.startCommand = detected.startCommand;
  site.updatedAt = Date.now();
  store.flush();
  appendLog(site, `[panel] ${ts()} выполнен откат к предыдущей версии`);
  if (site.type === 'docker') {
    // Контейнер держит СТАРЫЙ образ: без пересборки и пересоздания откат
    // каталога не изменил бы работающий сайт до ближайшего recreate.
    try {
      await docker.assertDockerAvailable();
      if (site.dockerFlavor === 'compose') docker.writeComposeOverride(site);
      await docker.dockerBuild(site);
      await docker.dockerRecreate(site);
    } catch (err) {
      appendLog(site, `[panel] ${ts()} пересборка откаченной версии не удалась: ${err.message}`);
      return { ok: false, error: 'Каталог откачен, но пересборка контейнера не удалась: ' + err.message };
    }
  }
  if (wasRunning || site.autoStart) return await _start(site);
  return { ok: true };
}

/* ---------- Восстановление из бэкапа (модуль backups.js) ---------- */

// Логика здесь, а не в backups.js: нужны внутренние _stop/_start. Публичные
// start/stop берут блокировку сайта сами — withSiteLock поверх дал бы
// повторный вход, который lock.js отвергает.
async function _restoreBackup(site, zipPath) {
  const dir = siteDir(site);
  if (!fs.existsSync(dir)) return { ok: false, error: 'Каталог сайта не найден' };
  const wasRunning = isRunning(site);
  if (wasRunning) await _stop(site);

  // Распаковка в staging в data/tmp: та же защита от zip-бомб, zip-slip и
  // symlink'ов, что и при деплое; каталог сайта не трогаем, пока архив не
  // распаковался целиком.
  const staging = path.join(config.tmpDir, `restore-${site.id}-${Date.now()}`);
  try {
    extractZip(zipPath, staging);
  } catch (err) {
    rmDirSafe(staging);
    if (wasRunning) await _start(site, { manual: true });
    const wrapped = new Error('Распаковка бэкапа не удалась: ' + err.message);
    throw wrapped;
  }

  // Двухшаговая подмена, как в _rollback (P-20): падение между шагами не
  // должно оставлять сайт без каталога.
  const old = dir + '.restore-old';
  rmDirSafe(old);
  try {
    fs.renameSync(dir, old);
    fs.renameSync(staging, dir);
  } catch (err) {
    rmDirSafe(staging);
    if (!fs.existsSync(dir) && fs.existsSync(old)) {
      try { fs.renameSync(old, dir); } catch { /* не смогли вернуть — каталог потерян */ }
    }
    if (wasRunning) await _start(site, { manual: true });
    throw err;
  }
  rmDirSafe(old);

  const detected = detectType(dir);
  site.type = detected.type;
  site.startCommand = detected.startCommand;
  // node_modules в бэкап не входит (backups.js): без установки зависимостей
  // node-сайт после восстановления упал бы на первом же require.
  if (site.type === 'node') {
    appendLog(site, `[panel] ${ts()} восстановление: установка зависимостей (node_modules в бэкап не входит)`);
    const inst = await npmInstall(site, dir);
    if (!inst.ok) {
      appendLog(site, `[panel] ${ts()} установка зависимостей после восстановления завершилась с ошибкой — сайт может не запуститься`);
    }
  }
  if (site.type === 'docker') {
    // Как при откате: контейнер держит старый образ, восстановленный каталог
    // нужно пересобрать и пересоздать, иначе восстановление не проявится.
    try {
      await docker.assertDockerAvailable();
      if (site.dockerFlavor === 'compose') docker.writeComposeOverride(site);
      await docker.dockerBuild(site);
      await docker.dockerRecreate(site);
    } catch (err) {
      appendLog(site, `[panel] ${ts()} пересборка восстановленной версии не удалась: ${err.message}`);
      return { ok: false, error: 'Файлы восстановлены, но пересборка контейнера не удалась: ' + err.message };
    }
  }
  site.updatedAt = Date.now();
  store.flush();
  appendLog(site, `[panel] ${ts()} восстановлено из бэкапа ${path.basename(zipPath)}`);
  if (wasRunning || site.autoStart) return _start(site, { manual: true });
  return { ok: true };
}

function restoreBackup(site, zipPath) {
  return withSiteLock(site.id, () => _restoreBackup(site, zipPath));
}

/* ---------- Загрузка / удаление ---------- */

async function boot() {
  // Порядок принципиален. Сначала подбираем процессы, пережившие панель (SP-04):
  // если этого не сделать, автозапуск ниже поднял бы ВТОРОЙ процесс на занятом
  // порту, тот упал бы на EADDRINUSE, а сирота продолжил бы работать невидимым.
  const adopted = adoptOrphans();
  if (adopted) console.log(`  Подхвачено процессов сайтов от прошлого запуска: ${adopted}`);

  // Затем — каталоги, брошенные деплоем, прерванным между двумя rename (SP-05).
  try {
    const actions = deploymark.reconcile(store.state.sites, appendLog);
    for (const a of actions) {
      const s = store.getSite(a.siteId);
      if (s) appendLog(s, `[panel] ${ts()} реконсиляция деплоя: ${a.action}`);
    }
    if (actions.length) store.save();
  } catch (err) {
    console.error(`[panel] реконсиляция деплоя не удалась: ${err.message}`);
  }

  // И мусор в data/tmp: брошенные staging-каталоги и необработанные загрузки
  // копились там навсегда, а один такой каталог — это целый сайт (SP-14).
  try {
    const cleaned = deploymark.cleanTemp();
    if (cleaned.files) {
      console.log(`  Убрано из временного каталога: ${cleaned.files} объектов, ${Math.round(cleaned.bytes / 1048576)} МБ`);
    }
  } catch (err) {
    console.error(`[panel] уборка временного каталога не удалась: ${err.message}`);
  }

  for (const site of store.state.sites) {
    if (!site.autoStart) continue;
    if (site.crashLoop) {
      // Лимит автоперезапусков был исчерпан до перезапуска панели: поднимать сайт
      // молча — значит замаскировать аварию. Ждём ручного вмешательства.
      appendLog(site, `[panel] ${ts()} сайт в режиме crashLoop — автозапуск пропущен, требуется ручной запуск`);
      continue;
    }
    if (site.status !== 'running' && site.status !== 'crashed') continue;
    // Поднимаем и те, что остались в crashed: панель могла быть перезапущена
    // вместе с упавшим сайтом, а самолечение монитора сработало бы не сразу.
    //
    // Для 'crashed' серия падений НЕ сбрасывается (manual:false): иначе сайт,
    // который падает сразу, получал бы на каждом старте панели свежий счётчик и
    // никогда не доходил до лимита автоперезапусков (P-25).
    const manual = site.status === 'running';
    start(site, { manual }).then((r) => {
      if (!r.ok) appendLog(site, `[panel] ${ts()} автозапуск не удался: ${r.error}`);
    });
  }
}

function rmDirSafe(dir) {
  // Windows: файлы могут быть заблокированы процессом или антивирусом — ретраим.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

async function _removeSite(site) {
  await _stop(site);
  processes.delete(site.id);
  alerts.siteSilentClear(site.id);
  if (site.type === 'docker') await docker.dockerRemoveAll(site);
  if (site.type === 'node') await new Promise((r) => setTimeout(r, 1500));
  rmDirSafe(siteDir(site));
  rmDirSafe(siteDir(site) + '.backup');
  fs.rmSync(siteLogFile(site), { force: true });
  fs.rmSync(siteLogFile(site) + '.old', { force: true });
}

function getProcessInfo(site) {
  return processes.get(site.id) || null;
}

function ts() {
  return new Date().toISOString();
}

/* ---------- Публичный API: операции под мьютексом сайта ---------- */

// Все экспортируемые операции сериализуются по сайту, чтобы два параллельных
// запроса (или деплой + автоперезапуск) не работали с одним каталогом и портом.
// Внутренние вызовы используют _start/_stop/... и намеренно не берут блокировку.
function start(site, opts) {
  return withSiteLock(site.id, () => _start(site, opts));
}

function stop(site) {
  return withSiteLock(site.id, () => _stop(site));
}

function restart(site) {
  return withSiteLock(site.id, () => _restart(site));
}

function deploy(site, zipPath) {
  return withSiteLock(site.id, () => _deploy(site, zipPath));
}

function deployFromGit(site, opts) {
  return withSiteLock(site.id, () => _deployFromGit(site, opts));
}

function rollback(site) {
  return withSiteLock(site.id, () => _rollback(site));
}

function removeSite(site) {
  // Записи в очереди блокировок теперь освобождаются автоматически (см.
  // src/sites/lock.js). Явный forgetSiteLock отсюда убран: вызванный внутри
  // удерживаемой операции, он позволял следующей операции того же сайта
  // стартовать параллельно с ещё не завершённым удалением (P-28).
  return withSiteLock(site.id, () => _removeSite(site));
}

module.exports = {
  processes,
  siteDir,
  siteLogFile,
  withSiteLock,
  start,
  stop,
  restart,
  deploy,
  deployFromGit,
  validateGitUrl,
  validateGitBranch,
  validateGitToken,
  validateSubdir,
  assertInside,
  rollback,
  restoreBackup,
  boot,
  removeSite,
  isRunning,
  setStatus,
  setStatusIf,
  deployState,
  killActiveCommands,
  readLogTail,
  appendLog,
  getProcessInfo,
  allocatePort,
  waitListening,
  extractZip,
  entryMode,
  resetBackoff,
  nextBackoffDelay,
  detectType,
  // Docker-функции живут в src/sites/docker.js (реэкспорт для монитора и тестов).
  ...docker,
  // docker.js шлёт алерты через manager.alerts (инжекция вместо циклического require).
  alerts,
};

// Инжекция зависимостей в docker.js: модуль не требует manager обратно
// (циклический require), а получает его вызовом init после загрузки обоих.
docker.init({ manager: module.exports, stopInternal: _stop, startInternal: _start, waitPortFree });
