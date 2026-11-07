'use strict';

// Cron-задания сайтов: выполнение команд по cron-выражению из каталога сайта.
//
// Формат: классическое 5-поле (минуты часы дни-месяца месяцы дни-недели),
// поддерживаются списки (a,b), диапазоны (a-b), шаги (*/n, a-b/n), 7 = 0
// (воскресенье). Пропущенные во время простоя панели слоты НЕ догоняются:
// повторять пропущенное пакетом опаснее, чем один раз не выполнить.
//
// Параллельность: одно задание не запускается повторно, пока предыдущий
// запуск не закончился; сам запуск берёт блокировку сайта — команда и деплой
// не работают в одном каталоге одновременно (каталог подменяется rename'ом).
//
// Результаты — в db.json (последний запуск + история до 20 записей) и в лог
// сайта; падение по расписанию уходит в алерты, как плановый бэкап.

const fs = require('fs');
const { spawn } = require('child_process');
const { config } = require('../config');
const store = require('../store');
const manager = require('./manager');
const alerts = require('../alerts');
const { withSiteLock } = require('./lock');

const HISTORY_MAX = 20;
const DEFAULT_TIMEOUT_SEC = 60;
const KILL_GRACE_MS = 1000;
const TREE_EXIT_WAIT_MS = 5000;

// Идущие запуски: jobId → Promise. Без этого тик каждые CRON_CHECK_SEC ставил
// бы в очередь новый запуск, пока предыдущий ждёт блокировки сайта.
const RUNNING = new Set();

/* ---------- Разбор cron-выражения ---------- */

function parseField(raw, min, max) {
  const out = new Set();
  for (const part of String(raw).split(',')) {
    const m = /^(?:(\d+)|\*|\*(?:\/(\d+))?|(\d+)-(\d+)(?:\/(\d+))?)$/.exec(part.trim());
    if (!m) throwInvalid(part);
    let start;
    let end;
    let step = m[2] || m[5] ? Number(m[2] || m[5]) : 1;
    if (part.trim() === '*') {
      start = min;
      end = max;
    } else if (m[3] !== undefined) {
      start = Number(m[3]);
      end = Number(m[4]);
    } else if (m[2] !== undefined) {
      start = min;
      end = max;
    } else {
      start = end = Number(m[1]);
    }
    if (!Number.isInteger(step) || step < 1) throwInvalid(part);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throwInvalid(part);
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

function throwInvalid(part) {
  const err = new Error(`Некорректное cron-выражение (поле «${part.trim()}»). Формат: мин часы день-месяца месяц день-недели, поддерживаются * , - /`);
  err.status = 400;
  throw err;
}

/** Разобрать выражение один раз; бросает ошибку 400 на невалидном. */
function parseExpression(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) {
    const err = new Error('Cron-выражение должно состоять из 5 полей: мин часы день-месяца месяц день-недели');
    err.status = 400;
    throw err;
  }
  const [min, hour, dom, mon, dow] = fields.map((f, i) => {
    const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]][i];
    return parseField(f, limits[0], limits[1]);
  });
  // 7 = воскресенье (как в классическом cron) — свести к 0.
  if (dow.has(7)) dow.add(0);
  return { min, hour, dom, mon, dow };
}

/** Совпадает ли дата с разобранным выражением (dom и dow — по правилу «или», если оба ограничены). */
function matches(date, parsed) {
  const min = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();
  if (!parsed.min.has(min) || !parsed.hour.has(hour) || !parsed.mon.has(mon)) return false;
  const domRestricted = !isWildcard(parsed.dom, 1, 31);
  const dowRestricted = !isWildcard(parsed.dow, 0, 7);
  if (domRestricted && dowRestricted) return parsed.dom.has(dom) || parsed.dow.has(dow);
  return parsed.dom.has(dom) && parsed.dow.has(dow);
}

function isWildcard(set, min, max) {
  if (set.size !== max - min + 1) return false;
  for (let v = min; v <= max; v++) if (!set.has(v)) return false;
  return true;
}

/** Публичная проверка выражения: возвращает разобранную форму или бросает 400. */
function assertSchedule(expr) {
  return parseExpression(expr);
}

/* ---------- Задания в записи сайта ---------- */

function jobsOf(site) {
  if (!Array.isArray(site.cronJobs)) site.cronJobs = [];
  return site.cronJobs;
}

function newId() {
  return 'job' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Привести тело POST/PUT к валидной форме задания. Частичное обновление:
 * PUT меняет только переданные поля.
 */
function normalizeJobInput(body, existing) {
  const cur = existing ? { ...existing } : {
    id: newId(),
    name: '',
    schedule: '',
    command: '',
    enabled: true,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastDurationMs: null,
    history: [],
  };
  if (body.schedule !== undefined) {
    assertSchedule(body.schedule); // бросает 400 на невалидном
    cur.schedule = String(body.schedule).trim();
  }
  if (body.command !== undefined) {
    const cmd = String(body.command).trim();
    if (!cmd || cmd.length > 1000) {
      const err = new Error('command: непустая строка до 1000 символов');
      err.status = 400;
      throw err;
    }
    cur.command = cmd;
  }
  if (!existing && !cur.command) {
    const err = new Error('command обязателен');
    err.status = 400;
    throw err;
  }
  if (!existing && !cur.schedule) {
    const err = new Error('schedule обязателен');
    err.status = 400;
    throw err;
  }
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (name.length > 100) {
      const err = new Error('name: до 100 символов');
      err.status = 400;
      throw err;
    }
    cur.name = name;
  }
  if (!cur.name) cur.name = 'Задание';
  if (body.enabled !== undefined) cur.enabled = body.enabled === true;
  if (body.timeoutSec !== undefined) {
    const n = Number(body.timeoutSec);
    if (!Number.isInteger(n) || n < 5 || n > 3600) {
      const err = new Error('timeoutSec: целое от 5 до 3600');
      err.status = 400;
      throw err;
    }
    cur.timeoutSec = n;
  }
  return cur;
}

function findJob(site, jobId) {
  const job = jobsOf(site).find((j) => j.id === String(jobId));
  if (!job) {
    const err = new Error('Задание не найдено');
    err.status = 404;
    throw err;
  }
  return job;
}

function sanitized(job) {
  const { history, ...rest } = job;
  return { ...rest, history: (history || []).slice(-HISTORY_MAX).reverse() };
}

/* ---------- Выполнение ---------- */

function ts() {
  return new Date().toISOString();
}

function recordResult(job, ok, code, durationMs, error) {
  job.lastRunAt = Date.now();
  job.lastStatus = ok ? 'ok' : 'failed';
  job.lastError = ok ? null : String(error || ('код выхода ' + code)).slice(0, 500);
  job.lastDurationMs = durationMs;
  job.history = (job.history || []);
  job.history.push({ at: job.lastRunAt, ok, code, durationMs });
  if (job.history.length > HISTORY_MAX) job.history = job.history.slice(-HISTORY_MAX);
  store.save();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid, group = false) {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

async function waitGone(pid, group) {
  const deadline = Date.now() + TREE_EXIT_WAIT_MS;
  while (processAlive(pid, group)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

/** Завершить shell вместе с потомками и подтвердить окончание до release лока.
 *  На POSIX у cron своя группа процессов; на Windows ждём taskkill /T /F. */
async function terminateTree(child) {
  if (!child || !child.pid) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    let taskkillOk = false;
    try {
      taskkillOk = await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => resolve(false));
        killer.on('close', (code) => resolve(code === 0));
      });
    } catch {
      taskkillOk = false;
    }
    if (!taskkillOk && processAlive(pid)) {
      try { child.kill('SIGKILL'); } catch { /* уже мёртв */ }
    }
    if (!await waitGone(pid, false)) {
      throw new Error(`дерево процессов ${pid} не завершилось после taskkill`);
    }
    return;
  }

  try { process.kill(-pid, 'SIGTERM'); } catch {
    try { child.kill('SIGTERM'); } catch { /* уже мёртв */ }
  }
  const graceDeadline = Date.now() + KILL_GRACE_MS;
  while (processAlive(pid, true) && Date.now() < graceDeadline) await delay(50);
  if (processAlive(pid, true)) {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { child.kill('SIGKILL'); } catch { /* уже мёртв */ }
    }
  }
  if (!await waitGone(pid, true)) {
    throw new Error(`группа процессов ${pid} не завершилась после SIGKILL`);
  }
}

async function runJob(site, job, trigger = 'manual') {
  const dir = manager.siteDir(site);
  if (!fs.existsSync(dir)) {
    recordResult(job, false, null, 0, 'Каталог сайта не найден');
    const err = new Error('Каталог сайта не найден');
    err.status = 404;
    throw err;
  }
  const t0 = Date.now();
  // Лок сайта: команда выполняется в каталоге, который деплой подменяет
  // rename'ом — сериализуем, как это делают бэкапы.
  return withSiteLock(site.id, () => new Promise((resolve, reject) => {
    let output = '';
    let child;
    let finished = false;
    let timedOut = false;
    let timeoutTimer;
    let termination = null;
    let terminationError = null;

    const finishOnce = ({ code = null, signal = null, spawnError = null, treeError = null } = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutTimer);
      const durationMs = Date.now() - t0;
      const ok = !spawnError && !timedOut && code === 0;
      const tail = output.trim().split('\n').slice(-8).join('\n').slice(0, 2000);
      const label = trigger === 'scheduled' ? 'по расписанию' : 'вручную';
      const failure = timedOut
        ? `превышен таймаут${treeError ? `; завершение дерева не подтверждено: ${treeError.message}` : ''}`
        : spawnError
          ? spawnError.message
          : signal
            ? `сигнал ${signal}`
            : `код выхода ${code}`;
      manager.appendLog(site, `[cron] ${ts()} «${job.name}» (${label}): ${ok ? 'успех' : failure} за ${Math.round(durationMs / 100) / 10}с${tail ? '\n' + tail : ''}`);
      recordResult(job, ok, timedOut ? null : code, durationMs, ok ? null : failure);
      if (ok) resolve({ ok: true, code, durationMs, output: tail });
      else if (spawnError) reject(spawnError);
      else if (timedOut) reject(new Error('Превышен таймаут выполнения'));
      else if (signal) reject(new Error(`Команда завершилась по сигналу ${signal}: ${tail.slice(0, 300)}`));
      else reject(new Error(`Команда завершилась с кодом ${code}: ${tail.slice(0, 300)}`));
    };

    const finishAfterTermination = (details) => {
      if (!timedOut || !termination) return finishOnce(details);
      termination.then(
        () => finishOnce({ ...details, treeError: terminationError }),
        (err) => finishOnce({ ...details, treeError: err })
      );
    };

    try {
      child = spawn(job.command, {
        shell: true,
        cwd: dir,
        // Своя группа: timeout должен завершить не только shell, но и потомков.
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: { ...process.env, SITE_ID: site.id, SITEPANEL: '1', CRON_TRIGGER: trigger },
      });
    } catch (err) {
      finishOnce({ spawnError: err });
      return;
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      // Promise всегда resolve: close/error могут прийти раньше завершения
      // эскалации, но rejected promise не должен стать unhandled до их прихода.
      termination = terminateTree(child).catch((err) => { terminationError = err; });
    }, (job.timeoutSec || DEFAULT_TIMEOUT_SEC) * 1000);
    timeoutTimer.unref();
    const onChunk = (c) => {
      if (output.length < 100000) output += c;
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (err) => finishAfterTermination({ spawnError: err }));
    child.on('close', (code, signal) => finishAfterTermination({ code, signal }));
  }));
}

/* ---------- Планировщик ---------- */

/** Задания, которым пора выполняться на эту минуту. Отдельно — удобно тестировать. */
function dueJobs(now = new Date()) {
  if (!config.cronEnabled) return [];
  const out = [];
  for (const site of store.state.sites) {
    for (const job of jobsOf(site)) {
      if (!job.enabled) continue;
      if (RUNNING.has(job.id)) continue;
      let parsed;
      try {
        parsed = parseExpression(job.schedule);
      } catch {
        continue; // битое выражение не роняет планировщик
      }
      const minuteStart = new Date(now);
      minuteStart.setSeconds(0, 0);
      if (!matches(now, parsed)) continue;
      // За эту минуту уже запускали (lastRunAt сохранён в db.json — переживает
      // рестарт панели): тик каждые 30с не даст второй запуск.
      if (job.lastRunAt && job.lastRunAt >= minuteStart.getTime()) continue;
      out.push({ site, job });
    }
  }
  return out;
}

function onScheduledFail(site, job, err) {
  job.lastError = String(err.message || err).slice(0, 500);
  store.save();
  alerts.send(`⚠️ SitePanel: cron-задание «${job.name}» сайта «${site.name}» не выполнилось: ${job.lastError}`).catch(() => {});
}

function tick() {
  for (const { site, job } of dueJobs()) {
    RUNNING.add(job.id);
    runJob(site, job, 'scheduled')
      .catch((err) => onScheduledFail(site, job, err))
      .finally(() => RUNNING.delete(job.id));
  }
}

function start() {
  if (!config.cronEnabled) return;
  tick();
  setInterval(tick, config.cronCheckSec * 1000).unref();
}

/** Сайт удаляется вместе со своими заданиями — снять их из RUNNING. */
function dropSite(siteId) {
  const site = store.state.sites.find((s) => s.id === siteId);
  if (!site) return;
  for (const job of jobsOf(site)) RUNNING.delete(job.id);
}

module.exports = {
  HISTORY_MAX,
  DEFAULT_TIMEOUT_SEC,
  assertSchedule,
  matches,
  jobsOf,
  normalizeJobInput,
  findJob,
  sanitized,
  runJob,
  dueJobs,
  tick,
  start,
  dropSite,
};
