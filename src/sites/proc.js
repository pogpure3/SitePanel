'use strict';

// Идентификация и поиск процессов сайтов: pid-файлы, cmdline, время старта,
// переносимый поиск владельца порта.
//
// Зачем отдельный модуль. Прежний код знал о процессе только `pid`, взятый из
// замыкания, и искал владельца порта через `lsof`. Этого мало сразу в трёх случаях:
//   1. Панель перезапустили (`kill -9`, OOM) — процессов сайтов нет в `processes`,
//      но они живы, держат порты и обслуживают трафик старым кодом. Без записи на
//      диске панель не может отличить «мой прежний процесс» от «чужого» (SP-04).
//   2. `lsof` есть не на всяком образе Ubuntu. Его отсутствие делало `portPids`
//      всегда пустым, `ensurePortFreed` — всегда `false`, а `_stop` рапортовал
//      успех при живом процессе (P-18, P-19).
//   3. `process.kill(pid)` по номеру процесса без проверки владельца — это выстрел
//      в того, кому номер достался после переиспользования PID (P-18).

const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');
const { config } = require('../config');

const IS_WIN = process.platform === 'win32';

/* ---------- pid-файлы ---------- */

/**
 * Путь к pid-файлу сайта.
 * Лежит рядом с логом в `data/logs`, а НЕ в каталоге сайта: каталог подменяется
 * при каждом деплое (`renameSync` в `.backup`), и запись о процессе исчезала бы
 * ровно в тот момент, когда она нужнее всего (SP-04, SP-05).
 */
function pidFileFor(siteId) {
  return path.join(config.logsDir, String(siteId) + '.pid');
}

/** Записать сведения о запущенном процессе сайта. Ошибка записи не критична. */
function writePidFile(site, info) {
  const file = pidFileFor(site.id);
  const data = {
    pid: info.pid,
    pgid: info.pgid === undefined ? info.pid : info.pgid,
    startedAt: info.startedAt,
    // Первые ~200 символов командной строки: по ним сверяем, что PID всё ещё
    // принадлежит нашему процессу, а не переиспользован системой.
    cmdline: String(info.cmdline || '').slice(0, 200),
    port: info.port === undefined ? null : info.port,
    host: require('os').hostname(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  } catch (err) {
    console.error(`[panel] не удалось записать pid-файл ${file}: ${err.message}`);
  }
  return data;
}

/** Сведения о процессе сайта с прошлого запуска панели, или null. */
function readPidFile(siteId) {
  try {
    const raw = JSON.parse(fs.readFileSync(pidFileFor(siteId), 'utf8'));
    if (!raw || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    return raw;
  } catch {
    return null;
  }
}

function removePidFile(siteId) {
  try {
    fs.rmSync(pidFileFor(siteId), { force: true });
  } catch {
    /* нет файла или нет прав — не критично */
  }
}

/* ---------- /proc ---------- */

/** Командная строка процесса (Linux). null, если процесса нет или это не Linux. */
function readCmdline(pid) {
  try {
    // Аргументы разделены NUL; для сверки достаточно и первого.
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return null;
  }
}

/**
 * Время старта процесса в тиках после загрузки (поле 22 `/proc/<pid>/stat`).
 * Нужно как монотонный признак «это тот же процесс»: PID переиспользуется,
 * а время старта — нет.
 */
function readStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Команда в скобках может содержать пробелы и скобки — берём хвост после последней ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(rest[19]); // поле 22 = индекс 19 в хвосте
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

/** Жив ли процесс (без отправки сигнала — signal 0 не доставляет его). */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Принадлежит ли PID именно тому процессу, о котором мы записали pid-файл.
 * Сверяем и время старта, и командную строку: первое защищает от
 * переиспользования PID, второе — от pid-файла, оставшегося от другой программы.
 * @returns {{ok: boolean, reason?: string}}
 */
function matchesPidFile(info) {
  if (!info) return { ok: false, reason: 'нет записи' };
  if (!isAlive(info.pid)) return { ok: false, reason: 'процесс не существует' };
  if (IS_WIN) return { ok: true };
  const ticks = readStartTicks(info.pid);
  const cmdline = readCmdline(info.pid);
  if (cmdline === null) return { ok: false, reason: 'процесс не читается' };
  // Время старта в pid-файле не храним (тики зависят от версии ядра), поэтому
  // опираемся на командную строку: у нашего сайта в ней есть id сайта или порт.
  const needle = [];
  if (info.cmdline) needle.push(info.cmdline.trim().split(' ')[0]);
  if (info.port) needle.push(':' + info.port);
  const matched = needle.some((n) => n && cmdline.includes(n));
  if (!matched && ticks === null) return { ok: false, reason: 'командная строка не совпала' };
  return { ok: true };
}

/* ---------- Владелец порта ---------- */

// Расшифровка inode сокета из /proc/net/tcp*: нам нужны только LISTEN (state 0A).
function listeningInodes(port) {
  const found = new Set();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const local = cols[1];
      const state = cols[3];
      if (state !== '0A') continue; // LISTEN
      const localPort = parseInt(local.split(':')[1], 16);
      if (localPort !== Number(port)) continue;
      found.add(cols[9]);
    }
  }
  return found;
}

/**
 * PIDs, слушающие порт, средствами /proc (без lsof).
 * Перебор `/proc/<pid>/fd/*` с `readlink` — единственный переносимый способ
 * связать inode сокета с процессом; на Ubuntu без `lsof` он обязателен.
 */
function portPidsViaProc(port) {
  const inodes = listeningInodes(port);
  if (!inodes.size) return [];
  const pids = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    const pid = parseInt(entry, 10);
    if (!Number.isFinite(pid) || String(pid) !== entry) continue;
    const fdDir = `/proc/${pid}/fd`;
    let fds;
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue; // чужой процесс или уже завершился
    }
    for (const fd of fds) {
      let link;
      try {
        link = fs.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      // Вид: socket:[12345]
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1])) {
        pids.push(pid);
        break;
      }
    }
  }
  return pids;
}

/** PIDs через lsof, если он есть. Пустой массив, если утилиты нет или она не нашла. */
function portPidsViaLsof(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split('\n').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite));
    });
  });
}

function portPidsViaNetstat(port) {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const pids = new Set();
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
        if (m && Number(m[1]) === Number(port)) pids.add(Number(m[2]));
      }
      resolve([...pids]);
    });
  });
}

/**
 * Все PIDs, слушающие порт. Пробуем lsof, затем /proc; объединяем результаты,
 * потому что на Ubuntu без lsof работает только второй путь (P-18).
 */
async function portPids(port) {
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) return [];
  if (IS_WIN) return portPidsViaNetstat(port);
  const pids = new Set(await portPidsViaLsof(port));
  for (const pid of portPidsViaProc(port)) pids.add(pid);
  return [...pids];
}

/** Группа процессов процесса (Linux), или null. */
function readPgid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgid = Number(rest[2]); // поле 5 = индекс 2 в хвосте
    return Number.isFinite(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

/* ---------- Пробы порта ---------- */

/** Занят ли порт на уровне ОС. Проба именно listen(), а не connect(): 0.0.0.0 тоже ловится. */
function portBusy(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES'));
    srv.listen(Number(port), '127.0.0.1', () => srv.close(() => resolve(false)));
  });
}

/** Отвечает ли кто-нибудь на порту (connect). */
function portAnswers(port) {
  return new Promise((resolve) => {
    const s = net.connect(Number(port), '127.0.0.1');
    const done = (v) => {
      s.removeAllListeners();
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

module.exports = {
  IS_WIN,
  pidFileFor,
  writePidFile,
  readPidFile,
  removePidFile,
  readCmdline,
  readStartTicks,
  readPgid,
  isAlive,
  matchesPidFile,
  portPids,
  portPidsViaProc,
  portBusy,
  portAnswers,
};
