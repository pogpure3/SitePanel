'use strict';

// Дашборд: периодические замеры CPU / памяти / диска / сети с историей.
// CPU — дельта счётчиков os.cpus() между замерами (кроссплатформенно);
// память на Linux — из /proc/meminfo (учитывает кэши как доступные);
// диск — statfs/df по каталогу данных; сеть на Linux — /proc/net/dev.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { config } = require('./config');

const HISTORY_MAX = 120; // 10 минут при замере раз в 5с
const history = { cpu: [], mem: [], disk: [], diskIo: { read: [], write: [] }, network: { rx: [], tx: [] } };

let lastCpuTimes = cpuTimes();
let cpuPct = null;
let lastMem = readMem();
let disk = null;
let diskError = null;
let diskCheckedAt = 0;
let lastNetwork = readNetworkTotals();
let network = lastNetwork ? { interface: lastNetwork.interface, rx: null, tx: null } : null;
let lastDiskIo = readDiskIoTotals();
let diskIo = lastDiskIo ? { device: lastDiskIo.device, read: null, write: null } : null;

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

function parseNetworkStats(raw, interfaceName) {
  const stats = [];
  for (const line of raw.split(/\r?\n/).slice(2)) {
    const match = /^\s*([^:]+):\s*(.+)$/.exec(line);
    if (!match || match[1].trim() === 'lo') continue;
    const values = match[2].trim().split(/\s+/).map(Number);
    if (values.length < 16 || values.some((value) => !Number.isFinite(value))) continue;
    stats.push({ interface: match[1].trim(), rx: values[0], tx: values[8] });
  }
  if (interfaceName) return stats.find((item) => item.interface === interfaceName) || null;
  if (!stats.length) return null;
  return stats.reduce((sum, item) => ({ interface: 'все', rx: sum.rx + item.rx, tx: sum.tx + item.tx }), { rx: 0, tx: 0 });
}

function readNetworkTotals() {
  try {
    const route = fs.readFileSync('/proc/net/route', 'utf8').split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .find((cols) => cols[1] === '00000000' && (parseInt(cols[3], 16) & 2));
    return parseNetworkStats(fs.readFileSync('/proc/net/dev', 'utf8'), route ? route[0] : null);
  } catch {
    return null;
  }
}

function sampleNetwork(nowMs = Date.now()) {
  const current = readNetworkTotals();
  if (!current) {
    lastNetwork = null;
    network = null;
    return;
  }
  if (!lastNetwork || current.interface !== lastNetwork.interface) {
    lastNetwork = { ...current, sampledAt: nowMs };
    network = { interface: current.interface, rx: null, tx: null };
    return;
  }
  const elapsedSec = (nowMs - (lastNetwork.sampledAt || nowMs)) / 1000;
  network = {
    interface: current.interface,
    rx: elapsedSec > 0 ? Math.max(0, Math.round((current.rx - lastNetwork.rx) / elapsedSec)) : null,
    tx: elapsedSec > 0 ? Math.max(0, Math.round((current.tx - lastNetwork.tx) / elapsedSec)) : null,
  };
  lastNetwork = { ...current, sampledAt: nowMs };
}

function findMountDevice(raw, targetPath) {
  const target = path.posix.resolve(String(targetPath).replace(/\\/g, '/'));
  let best = null;
  for (const line of raw.split(/\r?\n/)) {
    const fields = line.split(' - ')[0].trim().split(/\s+/);
    if (fields.length < 5 || !/^\d+:\d+$/.test(fields[2])) continue;
    const mountpoint = fields[4].replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8)));
    const matches = mountpoint === '/' ? target.startsWith('/') : target === mountpoint || target.startsWith(mountpoint + '/');
    if (!matches || (best && best.mountpoint.length >= mountpoint.length)) continue;
    const [major, minor] = fields[2].split(':').map(Number);
    best = { major, minor, mountpoint };
  }
  return best;
}

function parseDiskStats(raw, major, minor) {
  for (const line of raw.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14 || Number(fields[0]) !== major || Number(fields[1]) !== minor) continue;
    const readSectors = Number(fields[5]);
    const writtenSectors = Number(fields[9]);
    if (!Number.isFinite(readSectors) || !Number.isFinite(writtenSectors)) return null;
    return { device: fields[2], readBytes: readSectors * 512, writeBytes: writtenSectors * 512 };
  }
  return null;
}

function readDiskIoTotals() {
  try {
    const mount = findMountDevice(fs.readFileSync('/proc/self/mountinfo', 'utf8'), config.dataDir);
    if (!mount) return null;
    return parseDiskStats(fs.readFileSync('/proc/diskstats', 'utf8'), mount.major, mount.minor);
  } catch {
    return null;
  }
}

function sampleDiskIo(nowMs = Date.now()) {
  const current = readDiskIoTotals();
  if (!current) {
    lastDiskIo = null;
    diskIo = null;
    return;
  }
  if (!lastDiskIo || current.device !== lastDiskIo.device) {
    lastDiskIo = { ...current, sampledAt: nowMs };
    diskIo = { device: current.device, read: null, write: null };
    return;
  }
  const elapsedSec = (nowMs - (lastDiskIo.sampledAt || nowMs)) / 1000;
  diskIo = {
    device: current.device,
    read: elapsedSec > 0 ? Math.max(0, Math.round((current.readBytes - lastDiskIo.readBytes) / elapsedSec)) : null,
    write: elapsedSec > 0 ? Math.max(0, Math.round((current.writeBytes - lastDiskIo.writeBytes) / elapsedSec)) : null,
  };
  lastDiskIo = { ...current, sampledAt: nowMs };
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
      return { total, used, pct: Math.round((used / total) * 100), path: config.dataDir };
    }
  } catch {
    /* statfs недоступен — пробуем df */
  }
  return diskViaDf(config.dataDir);
}

/**
 * Обновление карточки диска (M-05). Раньше `diskCheckedAt` ставился ДО вызова,
 * а сам вызов шёл без await: при сбое `readDisk()` карточка показывала старое
 * значение, метка времени уже была обновлена — правда приходила только через
 * минуту, а rejection уходил в unhandledRejection. Теперь метка ставится только
 * при успехе (при сбое повтор на следующем тике), ошибка видна в snapshot.
 */
async function refreshDisk() {
  try {
    const result = await readDisk();
    if (result) {
      disk = result;
      diskError = null;
      diskCheckedAt = Date.now();
    } else {
      diskError = 'диск недоступен (statfs и df не ответили)';
    }
  } catch (err) {
    diskError = err.message;
  }
}

function tick() {
  cpuPct = sampleCpu();
  lastMem = readMem();
  const now = Date.now();
  sampleNetwork(now);
  sampleDiskIo(now);
  push(history.cpu, { t: now, v: cpuPct });
  push(history.mem, { t: now, v: lastMem.total ? Math.round((lastMem.used / lastMem.total) * 100) : null });
  if (disk) push(history.disk, { t: now, v: disk.pct });
  if (network && network.rx !== null) push(history.network.rx, { t: now, v: network.rx });
  if (network && network.tx !== null) push(history.network.tx, { t: now, v: network.tx });
  if (diskIo && diskIo.read !== null) push(history.diskIo.read, { t: now, v: diskIo.read });
  if (diskIo && diskIo.write !== null) push(history.diskIo.write, { t: now, v: diskIo.write });
  if (!disk || now - diskCheckedAt > 60000) {
    refreshDisk();
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
    diskError,
    diskIo,
    network,
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
      disk: history.disk.slice(-60),
      diskIo: {
        read: history.diskIo.read.slice(-60),
        write: history.diskIo.write.slice(-60),
      },
      network: {
        rx: history.network.rx.slice(-60),
        tx: history.network.tx.slice(-60),
      },
    },
  };
}

module.exports = { start, snapshot, refreshDisk, parseNetworkStats, findMountDevice, parseDiskStats };
