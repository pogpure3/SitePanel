'use strict';

// Мониторинг: периодические health-check'и, потребление памяти процессов.

const { execFile } = require('child_process');
const store = require('./store');
const manager = require('./sites/manager');
const alerts = require('./alerts');

// Сколько подряд неудачных health-check считаем недоступностью (~1 мин).
const FAILS_TO_ALERT = 2;

const history = new Map(); // siteId -> [{t, ok, ms, code}] (в памяти, до 100 точек)
const HISTORY_MAX = 100;

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

  site.health = {
    status: point.ok ? 'up' : 'down',
    lastCheck: point.t,
    lastMs: point.ms,
    lastCode: point.code,
  };
  if (site.status === 'running' && !point.ok && site.type === 'node' && !manager.isRunning(site)) {
    manager.setStatus(site, 'crashed');
  }
  // Самолечение: процесс жив, а статус завис в crashed (например, после сбоя панели).
  if (site.status === 'crashed' && manager.isRunning(site)) {
    manager.setStatus(site, 'running');
  }
  store.save();
  return point;
}

function start() {
  const tick = async () => {
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
  };
  setInterval(tick, 30000);
  setTimeout(tick, 5000);
}

// Переходы для оповещений: не отвечает / восстановился.
// Дедупликация и состояние — внутри alerts (siteState), здесь только события.
async function evalSiteAlerts(site, point) {
  if (site.status === 'running' && point.ok) {
    site.fails = 0;
    await alerts.siteUp(site); // no-op, если алерт не отправлялся
    return;
  }
  if (site.status === 'crashed') {
    // Алерт о падении отправляет manager в момент exit (быстрее, чем тик монитора).
    return;
  }
  // running, но health-check проваливается.
  site.fails = (site.fails || 0) + 1;
  if (site.fails >= FAILS_TO_ALERT) {
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

async function statsFor(site) {
  if (site.type !== 'node' || !manager.isRunning(site)) return null;
  const proc = manager.getProcessInfo(site);
  if (!proc || !proc.child.pid) return null;
  const memoryMb = await processMemoryMb(proc.child.pid);
  return {
    pid: proc.child.pid,
    uptimeSec: Math.round((Date.now() - proc.startedAt) / 1000),
    memoryMb,
  };
}

function getHistory(siteId) {
  return history.get(siteId) || [];
}

module.exports = { start, checkSite, statsFor, getHistory };
