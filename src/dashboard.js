'use strict';

// Дашборд: периодические замеры CPU / памяти / диска с историей.
// CPU — дельта счётчиков os.cpus() между замерами (кроссплатформенно);
// память на Linux — из /proc/meminfo (учитывает кэши как доступные);
// диск — df по каталогу данных (раз в минуту, чтобы не спамить).

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { config } = require('./config');

const HISTORY_MAX = 120; // 10 минут при замере раз в 5с
const history = { cpu: [], mem: [] };

let lastCpuTimes = cpuTimes();
let cpuPct = null;
let lastMem = readMem();
let disk = null;
let diskCheckedAt = 0;

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { idle, total };
}

function sampleCpu() {
  const now = cpuTimes();
  const dTotal = now.total - lastCpuTimes.total;
  const dIdle = now.idle - lastCpuTimes.idle;
  lastCpuTimes = now;
  if (dTotal > 0) cpuPct = Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
  return cpuPct;
}

function readMem() {
  // Linux: MemAvailable честнее os.freemem (кэш отдаваем и не считается занятым).
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const m = new RegExp('^' + key + ':\\s+(\\d+) kB', 'm').exec(raw);
      return m ? parseInt(m[1], 10) * 1024 : null;
    };
    const total = get('MemTotal');
    const available = get('MemAvailable');
    if (total && available !== null) {
      return { total, available, used: total - available };
    }
  } catch { /* не Linux */ }
  const total = os.totalmem();
  const available = os.freemem();
  return { total, available, used: total - available };
}

// df -kP как резерв для старых Node/нестандартных ФС.
function diskViaDf(pathArg) {
  return new Promise((resolve) => {
    execFile('df', ['-kP', pathArg], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      // Filesystem 1024-blocks Used Available Capacity Mounted on
      const m = /^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/m.exec(stdout);
      if (!m) return resolve(null);
      const total = parseInt(m[1], 10) * 1024;
      const used = parseInt(m[2], 10) * 1024;
      resolve({ total, used, pct: total ? Math.round((used / total) * 100) : null, path: m[4].trim() });
    });
  });
}

// Основной путь: fs.statfs (Node >= 18.15). Работает и на Windows, где df нет —
// из-за этого карточка «Хранилище» раньше оставалась пустой.
async function readDisk() {
  try {
    const st = await fs.promises.statfs(config.dataDir);
    if (st && st.bsize > 0 && st.blocks > 0) {
      const total = st.blocks * st.bsize;
      // bavail — доступно непривилегированному пользователю (резерв root не считаем).
      const free = Number.isFinite(st.bavail) ? st.bavail * st.bsize : st.bfree * st.bsize;
      const used = Math.max(0, total - free);
      disk = { total, used, pct: Math.round((used / total) * 100), path: config.dataDir };
      return;
    }
  } catch {
    /* statfs недоступен — пробуем df */
  }
  disk = await diskViaDf(config.dataDir);
}

function tick() {
  cpuPct = sampleCpu();
  lastMem = readMem();
  push(history.cpu, { t: Date.now(), v: cpuPct });
  push(history.mem, { t: Date.now(), v: lastMem.total ? Math.round((lastMem.used / lastMem.total) * 100) : null });
  if (!disk || Date.now() - diskCheckedAt > 60000) {
    diskCheckedAt = Date.now();
    readDisk();
  }
}

function push(arr, point) {
  arr.push(point);
  if (arr.length > HISTORY_MAX) arr.shift();
}

function start() {
  tick();
  setInterval(tick, 5000);
}

function snapshot() {
  const cpus = os.cpus();
  return {
    cpu: {
      pct: cpuPct,
      cores: cpus.length,
      model: cpus.length ? cpus[0].model.trim() : null,
      loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    },
    mem: { ...lastMem, pct: lastMem.total ? Math.round((lastMem.used / lastMem.total) * 100) : null },
    disk,
    server: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.arch()}`,
      osUptimeSec: Math.round(os.uptime()),
    },
    panelUptimeSec: Math.round(process.uptime()),
    nodeVersion: process.version,
    dataDir: config.dataDir,
    history: {
      cpu: history.cpu.slice(-60),
      mem: history.mem.slice(-60),
    },
  };
}

module.exports = { start, snapshot };
