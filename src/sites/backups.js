'use strict';

// Плановые бэкапы сайтов (по образцу раздела Backups в ispmanager):
// полная копия каталога сайта в zip + расписание с ротацией «хранить N».
//
// Каталог данных: data/backups/<siteId>/<ГГГГММДД-ЧЧММСС>.zip — рядом с каждым
// архивом <имя>.json с метаданными (триггер, число файлов, несжатый размер,
// длительность). Список собирается с диска, а не из db.json: реестр и файлы
// не могут разъехаться.
//
// Блокировки. Создание читает каталог сайта, который деплой подменяет rename'ом
// (см. P-31), поэтому берёт withSiteLock само. Восстановление меняет и каталог,
// и процесс — оно реализовано в manager.js (_restoreBackup), где доступны
// внутренние _stop/_start: публичные start/stop берут блокировку сами, и
// withSiteLock поверх дал бы повторный вход, который lock.js отвергает.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { config } = require('../config');
const store = require('../store');
const manager = require('./manager');
const alerts = require('../alerts');
const { withSiteLock } = require('./lock');

const NAME_RE = /^\d{8}-\d{6}\.zip$/;
const DEFAULT_SCHEDULE = { enabled: false, intervalHours: 24, keep: 5, lastRunAt: null, lastError: null };

// siteId с уже запланированным/идущим плановым бэкапом: без этой защиты тик
// каждые backupCheckSec ставил бы в очередь новый бэкап, пока предыдущий
// ждёт своей очереди в блокировке сайта.
const RUNNING = new Set();

function backupDir(site) {
  return path.join(config.backupsDir, site.id);
}

function scheduleOf(site) {
  return site.backupSchedule || DEFAULT_SCHEDULE;
}

/** Имя вида 20261019-031500.zip из текущего времени. */
function stampName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.zip`;
}

function assertBackupName(name) {
  if (!NAME_RE.test(String(name || ''))) {
    const err = new Error('Некорректное имя файла бэкапа');
    err.status = 400;
    throw err;
  }
  return name;
}

function metaFile(site, name) {
  return path.join(backupDir(site), name + '.json');
}

function readMeta(site, name) {
  try {
    const raw = JSON.parse(fs.readFileSync(metaFile(site, name), 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch { /* битые метаданные не ломают список */ }
  return {};
}

function resolveBackupPath(site, name) {
  assertBackupName(name);
  const p = path.join(backupDir(site), name);
  if (!fs.existsSync(p)) {
    const err = new Error('Бэкап не найден');
    err.status = 404;
    throw err;
  }
  return p;
}

/** Свободно на диске под каталогом; null — не смогли узнать (проверка пропускается). */
async function freeBytes(dir) {
  try {
    const st = await fs.promises.statfs(dir);
    return st.bsize * st.bavail;
  } catch {
    return null;
  }
}

/**
 * Рекурсивно упаковать каталог сайта. node_modules пропускается: деплой
 * переустанавливает зависимости, а с ними бэкап разрастается в разы.
 * Симлинки не упаковываются: в архиве они небезопасны, а extractZip при
 * восстановлении уже умеет их отбрасывать — проще не класть.
 */
function addDirToZip(zip, absDir, rel, stats) {
  const maxBytes = config.backupMaxSiteMb * 1048576;
  for (const d of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (d.name === 'node_modules') continue;
    const abs = path.join(absDir, d.name);
    const entryPath = rel ? `${rel}/${d.name}` : d.name;
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) {
      addDirToZip(zip, abs, entryPath, stats);
      continue;
    }
    if (!d.isFile()) continue;
    const st = fs.statSync(abs);
    stats.bytes += st.size;
    if (stats.bytes > maxBytes) {
      const err = new Error(`Каталог сайта больше ${config.backupMaxSiteMb} МБ — в бэкап не упаковывается (лимит меняет PANEL_BACKUP_MAX_MB)`);
      err.status = 413;
      throw err;
    }
    stats.files++;
    zip.addLocalFile(abs, rel, d.name);
  }
}

/**
 * Полный бэкап каталога сайта. Возвращает метаданные созданного архива.
 * Все бэкапы (плановые и ручные, любые сайты) гоняются через глобальную
 * очередь: adm-zip держит архив в памяти, а обход дерева синхронный —
 * параллельные упаковки мёржили RSS (лимит × число сайтов) и вместе
 * блокировали event loop (панель, прокси, health-checks замирали).
 * @param {'manual'|'scheduled'} trigger
 */
function createBackup(site, trigger) {
  return serializeBackupRun(() => withSiteLock(site.id, () => _createBackup(site, trigger)));
}

// Очередь бэкапов: хвост не «залипает» на ошибке предыдущего запуска.
let backupsChain = Promise.resolve();
function serializeBackupRun(fn) {
  const run = backupsChain.then(fn, fn);
  backupsChain = run.then(() => {}, () => {});
  return run;
}

async function _createBackup(site, trigger) {
  const dir = manager.siteDir(site);
  if (!fs.existsSync(dir)) {
    const err = new Error('Каталог сайта не найден');
    err.status = 404;
    throw err;
  }
  const t0 = Date.now();

  // Упаковка в память adm-zip: лимит размера (и счётчики) проверяется прямо при
  // обходе, до записи временного файла. Свободное место проверяем после обхода,
  // но до writeZip — обрыв по месту не оставит недописанный архив в списке.
  const zip = new AdmZip();
  const stats = { files: 0, bytes: 0 };
  addDirToZip(zip, dir, '', stats);
  if (!stats.files) {
    const err = new Error('Каталог сайта пуст — нечего бэкапить');
    err.status = 400;
    throw err;
  }
  const free = await freeBytes(config.backupsDir);
  if (free !== null && free < stats.bytes + 64 * 1048576) {
    const err = new Error(`На диске мало места (свободно ${Math.round(free / 1048576)} МБ) — бэкап не создан`);
    err.status = 507;
    throw err;
  }

  const name = stampName();
  const tmpZip = path.join(config.tmpDir, `backup-${site.id}-${Date.now()}.zip`);
  try {
    zip.writeZip(tmpZip);
    fs.mkdirSync(backupDir(site), { recursive: true });
    fs.renameSync(tmpZip, path.join(backupDir(site), name));
  } catch (err) {
    // Недописанный tmp-zip иначе ждал бы почасовой чистки сутки (ENOSPC и т.п.).
    try { fs.rmSync(tmpZip, { force: true }); } catch { /* уже нет */ }
    throw err;
  }

  const sizeBytes = fs.statSync(path.join(backupDir(site), name)).size;
  const meta = {
    trigger,
    files: stats.files,
    bytes: stats.bytes,
    sizeBytes,
    durationMs: Date.now() - t0,
    createdAt: t0,
  };
  fs.writeFileSync(metaFile(site, name), JSON.stringify(meta, null, 2));

  prune(site, scheduleOf(site).keep);
  const sched = scheduleOf(site);
  sched.lastRunAt = t0;
  sched.lastError = null;
  store.save();
  manager.appendLog(site, `[panel] ${ts()} бэкап создан (${trigger === 'scheduled' ? 'по расписанию' : 'вручную'}): ${name}, ` +
    `${stats.files} файл(ов), ${Math.round(sizeBytes / 1024)} КБ за ${Math.round(meta.durationMs / 100) / 10}с`);
  return { name, ...meta };
}

/** Ротация: хранить последние keep архивов, старшие удаляются вместе с метаданными. */
function prune(site, keep) {
  const list = listBackups(site);
  for (const b of list.slice(Math.max(1, keep))) {
    tryRemove(site, b.name);
  }
}

function tryRemove(site, name) {
  try { fs.rmSync(path.join(backupDir(site), name), { force: true }); } catch { /* нет прав — оставим */ }
  try { fs.rmSync(metaFile(site, name), { force: true }); } catch { /* нет прав */ }
}

/** Список бэкапов сайта, свежие сверху. */
function listBackups(site) {
  const dir = backupDir(site);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => NAME_RE.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      out.push({ name, ts: st.mtimeMs, sizeBytes: st.size, ...readMeta(site, name) });
    } catch { /* исчез при чтении — пропускаем */ }
  }
  out.sort((a, b) => b.name.localeCompare(a.name));
  return out;
}

function deleteBackup(site, name) {
  assertBackupName(name);
  return withSiteLock(site.id, () => {
    resolveBackupPath(site, name);
    tryRemove(site, name);
    return { ok: true };
  });
}

/** Каталог бэкапов удаляется вместе с сайтом. */
function removeAll(siteId) {
  fs.rmSync(path.join(config.backupsDir, siteId), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/** Сводка для API: расписание + список + суммарный объём. */
function summary(site) {
  const list = listBackups(site);
  return {
    schedule: { ...scheduleOf(site) },
    backups: list,
    totals: { count: list.length, sizeBytes: list.reduce((sum, b) => sum + (b.sizeBytes || 0), 0) },
  };
}

/**
 * Привести тело PUT /backups/schedule к валидной форме. Частичное обновление:
 * переданные поля меняются, остальные остаются как были.
 */
function normalizeScheduleInput(site, body) {
  const cur = { ...scheduleOf(site) };
  if (body.enabled !== undefined) cur.enabled = body.enabled === true;
  if (body.intervalHours !== undefined) {
    const n = Number(body.intervalHours);
    if (!Number.isFinite(n) || n < 0.05 || n > 8760) {
      const err = new Error('intervalHours: число от 0.05 до 8760 часов');
      err.status = 400;
      throw err;
    }
    cur.intervalHours = n;
  }
  if (body.keep !== undefined) {
    const n = Number(body.keep);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      const err = new Error('keep: целое от 1 до 100');
      err.status = 400;
      throw err;
    }
    cur.keep = n;
  }
  return cur;
}

/** Сайты, которым пора делать плановый бэкап. Отдельная функция — её удобно тестировать. */
function dueSites(now = Date.now()) {
  if (!config.backupsEnabled) return [];
  return store.state.sites.filter((site) => {
    const s = scheduleOf(site);
    if (!s.enabled) return false;
    if (RUNNING.has(site.id)) return false;
    return !s.lastRunAt || now - s.lastRunAt >= s.intervalHours * 3600000;
  });
}

function onScheduledFail(site, err) {
  const sched = scheduleOf(site);
  sched.lastError = String(err.message || err).slice(0, 500);
  store.save();
  manager.appendLog(site, `[panel] ${ts()} плановый бэкап не удался: ${sched.lastError}`);
  // Уведомление — только про плановые: ручной бэкап делает администратор,
  // он видит ошибку в интерфейсе в моменте.
  alerts.send(`⚠️ SitePanel: плановый бэкап сайта «${site.name}» не удался: ${sched.lastError}`).catch(() => {});
}

function tick() {
  for (const site of dueSites()) {
    RUNNING.add(site.id);
    createBackup(site, 'scheduled')
      .catch((err) => onScheduledFail(site, err))
      .finally(() => RUNNING.delete(site.id));
  }
}

function start() {
  if (!config.backupsEnabled) return;
  // Первый тик сразу: расписание, «просроченное» пока панель была выключена,
  // должно догонять, а не ждать полного интервала.
  tick();
  setInterval(tick, config.backupCheckSec * 1000).unref();
}

function ts() {
  return new Date().toISOString();
}

module.exports = {
  DEFAULT_SCHEDULE,
  NAME_RE,
  backupDir,
  scheduleOf,
  normalizeScheduleInput,
  createBackup,
  listBackups,
  deleteBackup,
  resolveBackupPath,
  removeAll,
  summary,
  dueSites,
  tick,
  start,
};
