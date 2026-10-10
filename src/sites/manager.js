'use strict';

// Запуск/остановка дочерних процессов сайтов и деплой zip-архивов.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const AdmZip = require('adm-zip');
const { config } = require('../config');
const store = require('../store');
const alerts = require('../alerts');
const { withSiteLock, forgetSiteLock, outsideLock } = require('./lock');
const { detectManager, runCommand, isLockMismatch } = require('./deployfiles');

// siteId -> { child, startedAt, stopping, restartTimer, restartAttempts }
const processes = new Map();

function siteDir(site) {
  return path.join(config.sitesDir, site.id);
}

function siteLogFile(site) {
  return path.join(config.logsDir, site.id + '.log');
}

/* ---------- Логи ---------- */

function appendLog(site, line) {
  try {
    fs.appendFileSync(siteLogFile(site), line + '\n');
  } catch {
    /* нет прав и т.п. — не роняем панель */
  }
}

function rotateLogIfNeeded(site) {
  try {
    const file = siteLogFile(site);
    const st = fs.statSync(file);
    if (st.size > 5 * 1024 * 1024) fs.renameSync(file, file + '.old');
  } catch {
    /* файла нет */
  }
}

function readLogTail(site, lines = 200) {
  try {
    const data = fs.readFileSync(siteLogFile(site), 'utf8');
    const arr = data.split('\n');
    return arr.slice(Math.max(0, arr.length - lines - 1)).join('\n');
  } catch {
    return '';
  }
}

/* ---------- Порты ---------- */

function usedInternalPorts() {
  return new Set(store.state.sites.filter((s) => s.port).map((s) => s.port));
}

function allocatePort() {
  const used = usedInternalPorts();
  for (let p = config.internalPortFrom; p < config.internalPortFrom + 5000; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error('Нет свободных внутренних портов');
}

/* ---------- Статус сайта ---------- */

function setStatus(site, status) {
  site.status = status;
  store.save();
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
  const p = processes.get(site.id);
  // Процесс, убитый сигналом, имеет exitCode === null, но signalCode !== null.
  return !!aliveChild(p);
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

/* ---------- Запуск / остановка ---------- */

async function _start(site, opts = {}) {
  if (isRunning(site)) return { ok: true, message: 'Уже запущен' };
  const manual = opts.manual === true;
  if (manual) resetBackoff(site);

  rotateLogIfNeeded(site);
  const dir = siteDir(site);
  if (!fs.existsSync(dir)) return { ok: false, error: 'Каталог сайта не найден' };

  if (site.type === 'static') {
    setStatus(site, 'running');
    appendLog(site, `[panel] ${ts()} статический сайт включён`);
    return { ok: true };
  }

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

    const proc = { child, startedAt: Date.now(), stopping: false, restartTimer: null, restartAttempts: 0, inStartup: true };
    processes.set(site.id, proc);

    child.stdout.on('data', (d) => appendLog(site, d.toString().trimEnd()));
    child.stderr.on('data', (d) => appendLog(site, d.toString().trimEnd()));

    child.on('exit', (code, signal) => {
      appendLog(site, `[panel] ${ts()} процесс завершён (code=${code} signal=${signal})`);
      if (proc.stopping) return; // штатная остановка: статус уже выставлен stop()/shutdown
      // Пока идёт окно старта, повторами управляет сам _start: иначе его retry
      // и запланированный здесь бэкофф запустили бы два процесса на один порт.
      if (proc.inStartup) return;
      scheduleCrashRestart(site, proc, code, signal);
    });

    return { child, proc };
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
    const { child, proc } = attemptStart();

    await new Promise((r) => setTimeout(r, 1500));
    proc.inStartup = false;
    if (child.exitCode === null && child.signalCode === null) {
      setStatus(site, 'running');
      // Полный сброс бэкоффа — только если процесс ДЕЙСТВИТЕЛЬНО прожил всё окно.
      // Таймер срабатывает позже, поэтому к моменту вызова процесс мог уже упасть:
      // без проверки падающий сайт сбрасывал себе бэкофф и никогда не доходил до лимита.
      proc.stableTimer = setTimeout(() => {
        if (!aliveChild(proc) || processes.get(site.id) !== proc) return;
        clearBackoffOnStable(site);
        store.save();
      }, stableWindowMs());
      return { ok: true };
    }

    // Процесс уже закрылся и его exit-обработчик мог уйти в бэкофф — отменяем,
    // чтобы повтор не конфликтовал с запланированным автоперезапуском.
    if (proc.restartTimer) clearTimeout(proc.restartTimer);
    proc.stopping = true;
    if (processes.get(site.id) === proc) processes.delete(site.id);

    if (attempt < MAX_START_ATTEMPTS) {
      appendLog(site, `[panel] ${ts()} процесс завершился сразу (code=${child.exitCode}), повторный запуск — возможно, порт ${site.port} ещё освобождается`);
      if (site.port) await waitPortFree(site.port, 5000);
      resetBackoff(site); // неудачные попытки старта — не серия падений
      setStatus(site, 'starting');
      continue;
    }

    setStatus(site, 'crashed');
    return { ok: false, error: `Процесс завершился сразу (code=${child.exitCode}), см. логи` };
  }
}

async function _stop(site) {
  if (site.type === 'static') {
    setStatus(site, 'stopped');
    appendLog(site, `[panel] ${ts()} статический сайт отключён`);
    return { ok: true };
  }
  const proc = processes.get(site.id);
  if (proc) {
    if (proc.restartTimer) clearTimeout(proc.restartTimer);
    if (proc.cooldownTimer) clearTimeout(proc.cooldownTimer);
    if (proc.stableTimer) clearTimeout(proc.stableTimer);
    proc.stopping = true;
    site.crashLoop = false; // цикл перезапуска прерван вручную
    setStatus(site, 'stopped');
    const pid = proc.child.pid;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else if (pid) {
        // detached-процесс — лидер своей группы: убиваем группу (npm + node + потомки).
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          proc.child.kill('SIGTERM');
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
        proc.child.kill('SIGTERM');
      }
    } catch {
      /* уже мёртв */
    }
    if (site.type === 'node') {
      // Удаляем запись только если процесс действительно завершился и новый не успел
      // стартовать: иначе для isRunning() сайт оставался бы «работающим» после остановки.
      setTimeout(() => {
        if (processes.get(site.id) !== proc) return;
        if (proc.child.exitCode === null && proc.child.signalCode === null) return;
        processes.delete(site.id);
      }, 3000);
    }
    appendLog(site, `[panel] ${ts()} остановлен администратором`);
  } else {
    setStatus(site, 'stopped');
  }
  if (site.type === 'node') {
    // npm/cmd может оставить «осиротевший» node на порту — освобождаем принудительно,
    // иначе следующий запуск получит EADDRINUSE.
    await ensurePortFreed(site);
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
async function portFree(port) {
  const probe = () =>
    new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(false); });
      s.once('error', () => resolve(true));
    });
  if (!(await probe())) return false;
  await new Promise((r) => setTimeout(r, 120));
  return probe();
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
 * Кто слушает порт (PID). На Windows taskkill /T не всегда достаёт до node,
 * запущенного через npm/cmd — тогда порт остаётся занят «осиротевшим» процессом.
 */
function portPids(port) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve([]);
        const pids = new Set();
        for (const line of String(stdout).split('\n')) {
          const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
          if (m && Number(m[1]) === Number(port)) pids.add(Number(m[2]));
        }
        resolve([...pids]);
      });
      return;
    }
    execFile('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split('\n').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite));
    });
  });
}

/** Освобождает порт сайта: сначала ждём, затем добиваем найденного слушателя. */
async function ensurePortFreed(site, timeoutMs = 4000) {
  if (!site.port) return true;
  if (await waitPortFree(site.port, timeoutMs)) return true;
  const pids = await portPids(site.port);
  if (!pids.length) return false;
  for (const pid of pids) {
    if (pid === process.pid) continue; // не убиваем сами себя
    appendLog(site, `[panel] ${ts()} порт ${site.port} занят процессом ${pid} (осиротел) — завершаем принудительно`);
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      /* уже мёртв */
    }
  }
  return waitPortFree(site.port, 5000);
}

/* ---------- Деплой ---------- */

function detectType(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const cmd = pkg.scripts && (pkg.scripts.start || pkg.scripts.main);
    if (cmd) {
      return { type: 'node', startCommand: 'npm start' };
    }
  } catch {
    /* не node-проект */
  }
  return { type: 'static', startCommand: null };
}

// Режим файла из zip (внешние атрибуты): нужен для executable-бита и symlink'ов.
function entryMode(entry) {
  const attr = entry.header && entry.header.attributes;
  if (!attr) return null;
  const mode = (attr >>> 16) & 0xffff;
  return mode ? mode : null;
}

// Безопасная распаковка (zip-slip, zip-бомбы, мусор вида __MACOSX, права и symlink'и).
function extractZip(zipPath, targetDir) {
  const zip = new AdmZip(zipPath);
  const target = path.resolve(targetDir);
  fs.mkdirSync(target, { recursive: true });

  const entries = zip.getEntries().filter((e) => {
    if (e.isDirectory) return false;
    const name = e.entryName.replace(/\\/g, '/');
    return !name.startsWith('__MACOSX/') && !name.includes('/__MACOSX/') && !/(^|\/)\.git(\/|$)/.test(name);
  });
  if (!entries.length) throw new Error('Архив пуст или не содержит файлов');

  // Защита от zip-бомб: до распаковки знаем суммарный несжатый размер и число файлов.
  const totalBytes = entries.reduce((sum, e) => sum + (e.header && e.header.size ? e.header.size : 0), 0);
  const maxBytes = config.maxUncompressedMb * 1024 * 1024;
  if (entries.length > config.maxZipEntries) {
    throw new Error(`В архиве слишком много файлов (${entries.length}, максимум ${config.maxZipEntries})`);
  }
  if (totalBytes > maxBytes) {
    const gb = (n) => (n / 1073741824).toFixed(2);
    throw new Error(`Архив распаковывается в ${gb(totalBytes)} ГБ (максимум ${gb(maxBytes)} ГБ)`);
  }

  // Если файлы лежат в единственной корневой папке — поднимаем их на уровень выше.
  const roots = new Set(entries.map((e) => e.entryName.replace(/\\/g, '/').split('/')[0]));
  const strip = roots.size === 1 && !entries.some((e) => !e.entryName.replace(/\\/g, '/').includes('/'));

  let files = 0;
  let links = 0;
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
      const linkTarget = entry.getData().toString('utf8');
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

    fs.writeFileSync(dest, entry.getData());
    // Права из архива: без них теряется executable-бит (./scripts/start.sh).
    if (mode !== null && process.platform !== 'win32') {
      try { fs.chmodSync(dest, mode & 0o777); } catch { /* не критично */ }
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
  const pm = detectManager(dir);

  appendLog(site, `[panel] ${ts()} установка зависимостей (${pm.name}: ${pm.install})...`);
  const started = Date.now();
  let res = await runCommand(pm.install, dir, (line) => appendLog(site, line), timeoutMs, installEnv);

  // Lock-файл может быть рассинхронизирован с package.json — тогда ci/frozen
  // падает намеренно. Даём шанс обычной установке вместо провала деплоя.
  if (res.code !== 0 && pm.frozenFallback && pm.frozenFallback !== pm.install && isLockMismatch(res.output)) {
    appendLog(site, `[panel] ${ts()} ${pm.name}: установка по lock-файлу не удалась, повтор без frozen-lockfile`);
    res = await runCommand(pm.frozenFallback, dir, (line) => appendLog(site, line), timeoutMs, installEnv);
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
    const built = await runCommand(`${pm.name} run build`, dir, (line) => appendLog(site, line), timeoutMs, installEnv);
    if (built.timedOut) {
      appendLog(site, `[panel] ${ts()} сборка прервана по таймауту (${config.installTimeoutMin} мин)`);
      return { ok: false, error: `Сборка превысила ${config.installTimeoutMin} мин и была прервана` };
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

async function finalizeDeploy(site, staging, opts = {}) {
  const dir = siteDir(site);
  try {
    // Сохраняем пользовательские файлы из текущей версии — их нет в репозитории.
    const preserved = {};
    if (fs.existsSync(dir)) {
      for (const f of PRESERVED_FILES) {
        const p = path.join(dir, f);
        if (fs.existsSync(p)) preserved[f] = fs.readFileSync(p);
      }
    }

    if (fs.existsSync(dir)) {
      const backup = dir + '.backup';
      fs.rmSync(backup, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      fs.renameSync(dir, backup);
      site.hasBackup = true;
    }
    fs.renameSync(staging, dir);

    const restored = [];
    for (const [f, data] of Object.entries(preserved)) {
      const np = path.join(dir, f);
      if (!fs.existsSync(np)) {
        fs.writeFileSync(np, data);
        restored.push(f);
      }
    }
    if (restored.length) appendLog(site, `[panel] ${ts()} перенесены из предыдущей версии: ${restored.join(', ')}`);

    const detected = detectType(dir);
    site.type = detected.type;
    site.startCommand = detected.startCommand;
    if (site.type === 'node' && !site.port) site.port = allocatePort();
    store.save();

    if (site.type === 'node') {
      if (opts.skipInstall) {
        // Установка и сборка прошли на этапе клонирования (иначе бы деплой упал раньше).
        delete site.lastDeployWarning;
      } else {
        const inst = await npmInstall(site);
        if (!inst.ok) site.lastDeployWarning = 'Установка зависимостей завершилась с ошибкой — сайт может не запуститься';
        else delete site.lastDeployWarning;
      }
    }
    site.updatedAt = Date.now();
    store.flush();
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
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
    // Сломанная версия остаётся рядом как .broken — для разбора полётов.
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
 * Полный деплой новой версии: стоп -> бэкап -> распаковка -> npm install -> старт.
 * @param {object} site запись из БД
 * @param {string} zipPath путь к загруженному архиву
 */
async function _deploy(site, zipPath) {
  const staging = path.join(config.tmpDir, 'deploy-' + site.id + '-' + Date.now());
  const wasRunning = isRunning(site);
  if (wasRunning) await _stop(site);

  try {
    const info = extractZip(zipPath, staging);
    appendLog(site, `[panel] ${ts()} деплой из архива: ${info.files} файлов${info.strippedRoot ? ' (корневая папка архива раскрыта)' : ''}`);
    await finalizeDeploy(site, staging);
  } catch (err) {
    appendLog(site, `[panel] ${ts()} ОШИБКА деплоя: ${err.message}`);
    fs.rmSync(staging, { recursive: true, force: true });
    if (wasRunning) await _start(site);
    throw err;
  }

  if (wasRunning || store.getSite(site.id).autoStart) {
    return startAfterDeploy(site);
  }
  return { ok: true };
}

/* ---------- Деплой из Git ---------- */

function validateGitUrl(url) {
  if (!url || typeof url !== 'string') throw new Error('Укажите URL репозитория');
  url = url.trim();
  if (url.startsWith('-') || /[\s"'`$;&|<>]/.test(url)) throw new Error('Некорректный URL репозитория');
  if (!/^https:\/\/[\w.-]+(:\d+)?\/[\w~.-]+\/[\w.-]+?(\.git)?\/?$/.test(url) && !/^git@[\w.-]+:[\w./~-]+(\.git)?$/.test(url)) {
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
  subdir = String(subdir).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!subdir) return null;
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(subdir)) throw new Error('Некорректный подкаталог репозитория');
  return subdir;
}

function gitClone(url, branch, dest) {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', '1', '--single-branch'];
    if (branch) args.push('--branch', branch);
    args.push(url, dest);
    const child = spawn('git', args, { windowsHide: true });
    let errOut = '';
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', (err) => reject(new Error('git недоступен: ' + err.message)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const m = /(?:fatal|error):\s*(.+)/.exec(errOut);
      const msg = m ? m[1].trim() : (errOut.split('\n').filter(Boolean).pop() || '');
      reject(new Error(('git clone: ' + msg).slice(0, 300)));
    });
  });
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  try { walk(dir); } catch { /* недоступен — не критично */ }
  return n;
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
  if (wasRunning) await _stop(site);

  // Токен в URL не сохраняется — только в site.gitToken, наружу API его не отдаёт.
  const cloneUrl = token && url.startsWith('https://') ? url.replace('https://', 'https://x-access-token:' + token + '@') : url;

  try {
    appendLog(site, `[panel] ${ts()} деплой из Git: ${url}${branch ? ' (ветка ' + branch + ')' : ''}${subdir ? ' [подкаталог ' + subdir + ']' : ''}`);
    await gitClone(cloneUrl, branch, staging);
    fs.rmSync(path.join(staging, '.git'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

    if (subdir) {
      if (!fs.existsSync(path.join(staging, subdir))) throw new Error(`В репозитории нет каталога "${subdir}"`);
      const appDir = path.join(staging, subdir);
      // Зависимости корня монорепо (typescript и т.п. инструменты) — без запуска его build.
      const rootInst = await npmInstall(site, staging, { skipBuild: true });
      if (!rootInst.ok) throw new Error(rootInst.error || 'установка зависимостей корня не удалась');
      // Зависимости и сборка самого подкаталога: tsc найдётся в ../node_modules.
      const inst = await npmInstall(site, appDir);
      if (!inst.ok) throw new Error(inst.error || 'установка/сборка не удалась, подробности в логах');
      const full = staging + '.full';
      fs.renameSync(staging, full);
      // ВАЖНО: путь к подкаталогу пересчитываем от нового корня full.
      fs.renameSync(path.join(full, subdir), staging);
      // Рантайм подкаталога может требовать пакеты монорепо — объединяем node_modules.
      const rootNodeModules = path.join(full, 'node_modules');
      if (fs.existsSync(rootNodeModules)) {
        fs.cpSync(rootNodeModules, path.join(staging, 'node_modules'), { recursive: true, force: true });
      }
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      // node_modules и собранный dist уже на месте — повторная установка не нужна.
      await finalizeDeploy(site, staging, { skipInstall: true });
    } else {
      appendLog(site, `[panel] ${ts()} получено файлов: ${countFiles(staging)}`);
      await finalizeDeploy(site, staging);
    }
    site.gitUrl = url;
    site.gitBranch = branch;
    site.gitSubdir = subdir;
    if (token) site.gitToken = token;
  } catch (err) {
    appendLog(site, `[panel] ${ts()} ОШИБКА деплоя из Git: ${err.message}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(staging + '.full', { recursive: true, force: true });
    if (wasRunning) await _start(site);
    throw err;
  }

  if (wasRunning || store.getSite(site.id).autoStart) {
    return startAfterDeploy(site);
  }
  return { ok: true };
}

async function _rollback(site) {
  const dir = siteDir(site);
  const backup = dir + '.backup';
  if (!fs.existsSync(backup)) return { ok: false, error: 'Бэкап не найден' };
  const wasRunning = isRunning(site);
  if (wasRunning) await _stop(site);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(backup, dir);
  site.hasBackup = false;
  const detected = detectType(dir);
  site.type = detected.type;
  site.startCommand = detected.startCommand;
  site.updatedAt = Date.now();
  store.flush();
  appendLog(site, `[panel] ${ts()} выполнен откат к предыдущей версии`);
  if (wasRunning || site.autoStart) return await _start(site);
  return { ok: true };
}

/* ---------- Загрузка / удаление ---------- */

async function boot() {
  for (const site of store.state.sites) {
    // Поднимаем и те, что остались в crashed: панель могла быть перезапущена
    // вместе с упавшим сайтом, а самолечение монитора сработало бы не сразу.
    // Это новый старт панели — серию падений считаем завершённой.
    if (site.autoStart && (site.status === 'running' || site.status === 'crashed')) {
      // Публичный start() — под мьютексом, чтобы автозапуск не пересекался
      // с запросом пользователя, пришедшим сразу после старта панели.
      start(site, { manual: true }).then((r) => {
        if (!r.ok) appendLog(site, `[panel] ${ts()} автозапуск не удался: ${r.error}`);
      });
    }
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
  return withSiteLock(site.id, async () => {
    try {
      return await _removeSite(site);
    } finally {
      forgetSiteLock(site.id);
    }
  });
}

module.exports = {
  processes,
  siteDir,
  siteLogFile,
  start,
  stop,
  restart,
  deploy,
  deployFromGit,
  validateGitUrl,
  validateGitBranch,
  validateGitToken,
  validateSubdir,
  rollback,
  boot,
  removeSite,
  isRunning,
  setStatus,
  readLogTail,
  appendLog,
  getProcessInfo,
  allocatePort,
  extractZip,
  resetBackoff,
  nextBackoffDelay,
};
