'use strict';

// Мониторинг: периодические health-check'и, потребление памяти процессов.

const { execFile } = require('child_process');
const { config } = require('./config');
const store = require('./store');
const manager = require('./sites/manager');
const alerts = require('./alerts');

// Сколько подряд неудачных health-check считаем недоступностью (~1 мин).
const FAILS_TO_ALERT = 2;

const history = new Map(); // siteId -> [{t, ok, ms, code}] (в памяти, до 100 точек)
const HISTORY_MAX = 100;

// Телеметрия (health/fails) живёт ТОЛЬКО здесь (M-02): раньше она писалась в
// записи сайта, и db.json целиком переписывался на диске каждые 30 с даже без
// изменений — рост файла и износ диска ради данных, которые не обязаны
// переживать рестарт.
const telemetry = new Map(); // siteId -> { health, fails }

function telemetryFor(siteId) {
  let t = telemetry.get(siteId);
  if (!t) {
    t = { health: { status: 'unknown' }, fails: 0 };
    telemetry.set(siteId, t);
  }
  return t;
}

/** health из телеметрии — для API (вместо поля записи сайта). */
function healthFor(siteId) {
  const t = telemetry.get(siteId);
  return (t && t.health) || { status: 'unknown' };
}

/** Полная зачистка памяти по удалённому сайту (M-03): без этого ~100 точек
 *  истории и телеметрия оставались в Map навсегда. */
function forgetSite(siteId) {
  history.delete(siteId);
  telemetry.delete(siteId);
  statsCache.delete(siteId);
}

function pushHistory(siteId, point) {
  let arr = history.get(siteId);
  if (!arr) {
    arr = [];
    history.set(siteId, arr);
  }
  arr.push(point);
  if (arr.length > HISTORY_MAX) arr.shift();
}

async function checkSite(site) {
  const t0 = Date.now();
  let point;
  if (site.type === 'node' && manager.isRunning(site)) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(`http://127.0.0.1:${site.port}/`, { signal: ctl.signal, headers: { 'User-Agent': 'SitePanel-Healthcheck' } });
      clearTimeout(timer);
      point = { t: Date.now(), ok: res.status < 500, ms: Date.now() - t0, code: res.status };
    } catch (err) {
      point = { t: Date.now(), ok: false, ms: Date.now() - t0, code: 0, error: err.name === 'AbortError' ? 'timeout' : 'conn refused' };
    }
  } else if (site.type === 'static') {
    const up = site.status === 'running';
    point = { t: Date.now(), ok: up, ms: 0, code: up ? 200 : 503 };
  } else {
    point = { t: Date.now(), ok: false, ms: 0, code: 0 };
  }

  telemetryFor(site.id).health = {
    status: point.ok ? 'up' : 'down',
    lastCheck: point.t,
    lastMs: point.ms,
    lastCode: point.code,
  };
  if (site.status === 'running' && !point.ok && site.type === 'node' && !manager.isRunning(site)) {
    // Атомарная замена статуса: тик монитора стартовал ДО деплоя и видит запись
    // в состоянии, которой уже нет. Прямая запись перетирала 'starting'/'stopped',
    // выставленные деплоем, и роняла сайт в 'crashed' посреди работы (P-26).
    // setStatusIf применит переход, только если статус всё ещё 'running';
    // store.save() вызывается внутри — здесь он больше не нужен (M-02).
    manager.setStatusIf(site, 'running', 'crashed');
  }
  // Самолечение: процесс жив, а статус завис в crashed (например, после сбоя панели).
  if (site.status === 'crashed' && manager.isRunning(site)) {
    manager.setStatusIf(site, 'crashed', 'running');
  }
  return point;
}

// Guard наслоения тиков (M-02): при >=7 мёртвых сайтах тик длился дольше
// интервала, накладывался на следующий и умножал работу.
let tickRunning = false;

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    for (const site of store.state.sites) {
      if (site.status === 'running' || site.status === 'crashed') {
        try {
          const point = await checkSite(site);
          pushHistory(site.id, point);
          await evalSiteAlerts(site, point);
        } catch {
          /* не роняем цикл */
        }
      } else if (site.status === 'stopped') {
        // Ручная остановка — глушим алерт без сообщения о восстановлении.
        alerts.siteSilentClear(site.id);
      }
    }
  } finally {
    tickRunning = false;
  }
}

function start() {
  setInterval(tick, config.monitorTickMs);
  setTimeout(tick, 5000);
}

// Переходы для оповещений: не отвечает / восстановился.
// Дедупликация и состояние — внутри alerts (siteState), здесь только события.
async function evalSiteAlerts(site, point) {
  const t = telemetryFor(site.id);
  if (site.status === 'running' && point.ok) {
    t.fails = 0;
    await alerts.siteUp(site); // no-op, если алерт не отправлялся
    return;
  }
  if (site.status === 'crashed') {
    // Алерт о падении отправляет manager в момент exit (быстрее, чем тик монитора).
    return;
  }
  // running, но health-check проваливается.
  t.fails = (t.fails || 0) + 1;
  if (t.fails >= FAILS_TO_ALERT) {
    const detail = point.error ? (point.error === 'timeout' ? 'нет ответа за 5с' : 'соединение отклонено') : `HTTP ${point.code || '?'}`;
    await alerts.siteDown(site, `не отвечает (${detail})`);
  }
}

/* ---------- Память процесса (кроссплатформенно, без нативных зависимостей) ---------- */

function processMemoryMb(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const m = /"([\d.\s]+)K?"/.exec(stdout.split('\n')[0] || '');
        if (!m) return resolve(null);
        const kb = parseInt(m[1].replace(/[^\d]/g, ''), 10);
        resolve(Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024 * 10) / 10 : null);
      });
    } else {
      require('fs').readFile(`/proc/${pid}/status`, 'utf8', (err, data) => {
        if (err) return resolve(null);
        const m = /VmRSS:\s+(\d+)\s+kB/.exec(data);
        resolve(m ? Math.round(parseInt(m[1], 10) / 1024 * 10) / 10 : null);
      });
    }
  });
}

// Кэш статистики процессов (M-07): tasklist на Windows / чтение /proc на каждый
// GET /api/sites при активном UI на 50 сайтах давал тысячи процессов в час.
// Ключ по pid: после перезапуска сайта кэш не отдаёт устаревший pid.
const statsCache = new Map(); // siteId -> { pid, at, stats }
const STATS_TTL_MS = 5000;

async function statsFor(site) {
  if (site.type !== 'node' || !manager.isRunning(site)) {
    statsCache.delete(site.id);
    return null;
  }
  const proc = manager.getProcessInfo(site);
  // У подхваченного после перезапуска панели процесса (external) есть только pid,
  // а child === null — прежняя проверка `proc.child.pid` падала с
  // «Cannot read properties of null (reading 'pid')» и карточка сайта отдавала 500 (SP-04).
  if (!proc) return null;
  const pid = proc.child ? proc.child.pid : proc.pid;
  if (!pid) return null;
  const cached = statsCache.get(site.id);
  if (cached && cached.pid === pid && Date.now() - cached.at < STATS_TTL_MS) return cached.stats;
  const memoryMb = await processMemoryMb(pid);
  const stats = {
    pid,
    uptimeSec: Math.round((Date.now() - proc.startedAt) / 1000),
    memoryMb,
  };
  statsCache.set(site.id, { pid, at: Date.now(), stats });
  return stats;
}

function getHistory(siteId) {
  return history.get(siteId) || [];
}

module.exports = { start, tick, checkSite, statsFor, getHistory, healthFor, forgetSite };
