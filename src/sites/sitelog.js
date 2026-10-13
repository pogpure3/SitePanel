'use strict';

// Логи сайтов: асинхронная запись, чтение только хвоста, ротация N поколений.
//
// Почему это отдельный модуль. Прежняя реализация делала `fs.appendFileSync` на
// КАЖДЫЙ чанк stdout/stderr (`P-01`) — болтливый сайт (веб-сервер с access-логом)
// блокировал event loop панели, то есть напрямую тормозил админку и соседние сайты.
// `readLogTail` читал файл ЦЕЛИКОМ в память и только потом резал (`P-02`): лог на
// 3 ГБ означал аллокацию 3 ГБ, а `GET /logs?lines=1` был готовым примитивом для
// OOM одним запросом. Ротация была одна (`file` → `file.old`), сжатия нет, и
// происходила только при старте сайта — то есть у долгоживущего сайта лог не
// ограничивался ничем.

const fs = require('fs');
const path = require('path');
const { config } = require('../config');

// siteId -> { stream, pending, dropped, sinceRotateCheck, file }
const streams = new Map();

// Размер записи, при котором считаем, что поток не успевает (backpressure).
// Держать неограниченный буфер в памяти нельзя: тот же OOM, только с другой стороны.
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const ROTATE_CHECK_EVERY = 2000;

function logFileFor(siteId) {
  return path.join(config.logsDir, String(siteId) + '.log');
}

function siteLogFile(site) {
  return logFileFor(site.id);
}

/**
 * Одно поколение ротации: `file.N-1` → `file.N`, последнее удаляется.
 * Синхронно и без сжатия: ротация вызывается редко (по объёму), а её результат
 * нужен немедленно, чтобы освободить место под новые записи.
 */
function rotateFile(file) {
  const gens = Math.max(1, config.logGenerations);
  try {
    fs.rmSync(`${file}.${gens}`, { force: true });
    for (let i = gens - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
  } catch (err) {
    console.error(`[panel] ротация лога ${file} не удалась: ${err.message}`);
  }
}

/** Закрыть поток лога сайта: без этого rename файла на Windows упадёт (EBUSY). */
function closeStream(siteId) {
  const entry = streams.get(siteId);
  if (!entry) return;
  streams.delete(siteId);
  try {
    entry.stream.end();
  } catch {
    /* уже закрыт */
  }
}

function closeAll() {
  for (const id of [...streams.keys()]) closeStream(id);
}

function openStream(siteId) {
  const file = logFileFor(siteId);
  const stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
  // Ошибка потока (диск полон, каталог удалён) не должна ронять панель:
  // сайт продолжает работать, а лог — это диагностика, а не данные.
  stream.on('error', (err) => {
    console.error(`[panel] запись лога ${file} не удалась: ${err.message}`);
    const entry = streams.get(siteId);
    if (entry && entry.stream === stream) {
      streams.delete(siteId);
      try { stream.destroy(); } catch { /* уже мёртв */ }
    }
  });
  const entry = { stream, pending: 0, dropped: 0, writes: 0, file };
  streams.set(siteId, entry);
  return entry;
}

function streamFor(siteId) {
  const entry = streams.get(siteId);
  if (entry && !entry.stream.destroyed) return entry;
  return openStream(siteId);
}

/** Проверить размер и при превышении — ротировать (закрыв поток, чтобы не писать в переименованный файл). */
function rotateIfNeeded(siteId, entry) {
  let size = entry.stream.bytesWritten;
  try {
    size = fs.statSync(entry.file).size;
  } catch {
    /* файла ещё нет */
  }
  if (size <= config.logMaxBytes) return false;
  closeStream(siteId);
  rotateFile(entry.file);
  return true;
}

/**
 * Добавить строку в лог сайта. Асинхронно, с ограничением буфера.
 * @param {object} site запись сайта
 * @param {string} line строка без завершающего перевода
 */
function appendLog(site, line) {
  const text = String(line == null ? '' : line);
  if (!text) return;
  const siteId = String(site.id);
  let entry = streamFor(siteId);

  if (entry.pending > MAX_PENDING_BYTES) {
    // Поток не успевает за сайтом: теряем строки, но не память панели.
    // Об этом обязательно пишем в лог при первой потере — иначе «пропавшие»
    // строки выглядят как ошибка панели, а не как перегрузка диска.
    if (entry.dropped === 0) {
      entry.pending += text.length + 1;
      entry.stream.write(`[panel] лог не успевает за выводом, часть строк будет потеряна\n`);
    }
    entry.dropped++;
    return;
  }

  const chunk = text + '\n';
  entry.pending += Buffer.byteLength(chunk, 'utf8');
  entry.writes++;
  entry.stream.write(chunk, () => {
    entry.pending -= Buffer.byteLength(chunk, 'utf8');
    if (entry.pending < 0) entry.pending = 0;
  });

  if (entry.writes % ROTATE_CHECK_EVERY === 0) {
    entry = streamFor(siteId); // ротация могла заменить запись
    rotateIfNeeded(siteId, entry);
  }
}

/** Принудительная проверка ротации (например, при старте сайта). */
function rotateLogIfNeeded(site) {
  const entry = streamFor(String(site.id));
  rotateIfNeeded(String(site.id), entry);
}

/**
 * Хвост лога: последние `lines` строк, прочитанные с конца файла.
 * В память попадает не больше `config.logTailMaxBytes` (по умолчанию 256 КБ),
 * независимо от размера файла — раньше читался весь файл (P-02, P-23).
 */
function readLogTail(site, lines = 200) {
  const file = siteLogFile(site);
  const wantBytes = Math.min(config.logTailMaxBytes, Math.max(4096, lines * 400));
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - wantBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf8');
    // Первая строка почти наверняка обрезана посередине: отбрасываем её, если
    // прочитали не с начала файла.
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl < 0 ? '' : text.slice(nl + 1);
    }
    const arr = text.split('\n');
    if (arr.length && arr[arr.length - 1] === '') arr.pop();
    return arr.slice(Math.max(0, arr.length - lines)).join('\n');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* уже закрыт */ }
    }
  }
}

/** Удалить все поколения лога сайта (при удалении сайта). */
function removeLogs(site) {
  closeStream(String(site.id));
  const file = siteLogFile(site);
  for (let i = 0; i <= Math.max(1, config.logGenerations); i++) {
    try {
      fs.rmSync(i === 0 ? file : `${file}.${i}`, { force: true });
    } catch {
      /* нет файла — не критично */
    }
  }
}

module.exports = {
  logFileFor,
  siteLogFile,
  appendLog,
  readLogTail,
  rotateLogIfNeeded,
  rotateFile,
  removeLogs,
  closeStream,
  closeAll,
};
