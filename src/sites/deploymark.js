'use strict';

// Маркеры незавершённого деплоя и реконсиляция при старте.
//
// Проблема, которую решает модуль (SP-05). Деплой подменяет каталог сайта двумя
// шагами: `renameSync(dir, dir.backup)`, затем `renameSync(staging, dir)`. Между
// ними каталога сайта НЕ существует. Прежний код не оставлял об этом никакой
// записи: панель, убитая (SIGKILL, OOM, выключение) в этом окне, при следующем
// старте видела `dir.backup` и отсутствие `dir` — и не знала, что это следствие
// обрыва, а не осознанного удаления. Сайт оставался без каталога: `_start` отвечал
// «Каталог сайта не найден», восстановления не было.
//
// Поэтому перед первым rename пишется маркер в `data/tmp` (каталог, который
// переживает подмену каталога сайта):
//   { id, staging, backup, phase: 'backing-up' | 'swapped', startedAt }
// и удаляется только после успешного завершения. При старте панели `reconcile()`
// возвращает каталог на место, если маркер остался.

const fs = require('fs');
const path = require('path');
const { config } = require('../config');

function markerFile(siteId) {
  return path.join(config.tmpDir, 'deploy-' + String(siteId) + '.json');
}

function writeMarker(siteId, data) {
  const file = markerFile(siteId);
  const payload = { siteId: String(siteId), startedAt: Date.now(), ...data };
  try {
    fs.mkdirSync(config.tmpDir, { recursive: true, mode: 0o700 });
    // Атомарно: обрыв записи не должен оставить неразбираемый маркер, иначе
    // реконсиляция не поймёт, что делать.
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`[panel] не удалось записать маркер деплоя ${file}: ${err.message}`);
  }
  return payload;
}

function readMarker(siteId) {
  try {
    const raw = JSON.parse(fs.readFileSync(markerFile(siteId), 'utf8'));
    return raw && raw.siteId ? raw : null;
  } catch {
    return null;
  }
}

function removeMarker(siteId) {
  try {
    fs.rmSync(markerFile(siteId), { force: true });
  } catch {
    /* нет файла — не критично */
  }
}

/** Все незакрытые маркеры деплоя (после аварии панели). */
function listMarkers() {
  try {
    const out = [];
    for (const name of fs.readdirSync(config.tmpDir)) {
      const m = /^deploy-(.+)\.json$/.exec(name);
      if (!m) continue;
      const raw = readMarker(m[1]);
      if (raw) out.push(raw);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Разобраться с каталогами сайта, брошенными аварийным деплоем.
 *
 * Возможные состояния после обрыва:
 *   A) `dir` есть, `dir.backup` есть, маркер есть → подмена не началась или уже
 *      завершилась; каталог на месте, staging подчищаем.
 *   B) `dir` НЕТ, `dir.backup` есть → обрыв между rename'ами; возвращаем бэкап.
 *   C) `dir` есть, `dir.backup` есть, staging есть → обрыв ПОСЛЕ подмены, но до
 *      удаления staging; новая версия уже на месте, staging — мусор.
 *   D) `dir` НЕТ, `dir.backup` НЕТ, staging есть → обрыв до первого rename;
 *      staging ещё не подменён, вернуть его на место нельзя (не проверен),
 *      поэтому оставляем как есть и пишем в лог.
 *
 * @param {Array<object>} sites записи реестра
 * @param {Function} log функция логирования (site, текст)
 * @returns {Array<{siteId: string, action: string}>}
 */
function reconcile(sites, log) {
  const actions = [];
  const byId = new Map(sites.map((s) => [String(s.id), s]));

  // (1) Маркеры от сайтов, которых больше нет в реестре (удалён во время деплоя).
  for (const marker of listMarkers()) {
    const site = byId.get(String(marker.siteId));
    const dir = path.join(config.sitesDir, marker.siteId);
    const backup = dir + '.backup';
    if (!site) {
      // Каталог ничей: либо бэкап (прежняя версия), либо staging новой версии.
      // Не удаляем молча — переносим в tmp, чтобы освободить имя и не потерять данные.
      if (fs.existsSync(dir) && fs.existsSync(backup)) {
        // Удалённый сайт: каталог вернули в db? Считаем мусором аварийного деплоя.
        removeMarker(marker.siteId);
        continue;
      }
      if (!fs.existsSync(dir) && fs.existsSync(backup)) {
        try {
          fs.renameSync(backup, dir);
          actions.push({ siteId: String(marker.siteId), action: 'восстановлен каталог удалявшегося сайта из .backup' });
        } catch (err) {
          console.error(`[panel] не удалось вернуть каталог сайта ${marker.siteId}: ${err.message}`);
        }
      }
      removeMarker(marker.siteId);
      continue;
    }

    const staging = marker.staging;
    if (!fs.existsSync(dir) && fs.existsSync(backup)) {
      // Случай B: каталога нет, бэкап есть — возвращаем прежнюю версию.
      try {
        fs.renameSync(backup, dir);
        site.hasBackup = false;
        if (log) log(site, `[panel] незавершённый деплой: каталог восстановлен из ${path.basename(backup)} после аварийного завершения панели`);
        actions.push({ siteId: String(marker.siteId), action: 'каталог восстановлен из .backup' });
      } catch (err) {
        if (log) log(site, `[panel] НЕ удалось восстановить каталог из .backup: ${err.message}`);
        actions.push({ siteId: String(marker.siteId), action: 'восстановление не удалось: ' + err.message });
      }
    } else if (fs.existsSync(dir) && fs.existsSync(backup)) {
      // Случай A/C: каталог на месте. Какой из них актуален — неизвестно точно,
      // поэтому НЕ удаляем бэкап: он единственная копия прежней версии.
      if (log) log(site, '[panel] незавершённый деплой: каталог сайта на месте, бэкап сохранён для отката');
      actions.push({ siteId: String(marker.siteId), action: 'каталог на месте, бэкап сохранён' });
    } else if (fs.existsSync(dir)) {
      actions.push({ siteId: String(marker.siteId), action: 'каталог на месте' });
    }

    // Staging аварийного прогона удаляем: он не проверен и не подменён.
    if (staging && path.resolve(staging).startsWith(path.resolve(config.tmpDir) + path.sep)) {
      try {
        if (fs.existsSync(staging)) {
          fs.rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
          if (log) log(site, '[panel] незавершённый деплой: промежуточный каталог удалён');
        }
      } catch (err) {
        console.error(`[panel] не удалось удалить staging ${staging}: ${err.message}`);
      }
    }
    removeMarker(marker.siteId);
  }

  return actions;
}

/**
 * Убрать из `data/tmp` брошенные staging-каталоги и загрузки старше суток (SP-14).
 * Без этого каждый аварийный деплой навсегда оставлял `deploy-<id>-<ts>`, а
 * необработанная загрузка — файл до 100 МБ: диск тёк молча.
 * @returns {{files: number, bytes: number}}
 */
function cleanTemp(maxAgeMs = 24 * 60 * 60 * 1000) {
  let files = 0;
  let bytes = 0;
  const now = Date.now();
  let entries;
  try {
    entries = fs.readdirSync(config.tmpDir, { withFileTypes: true });
  } catch {
    return { files, bytes };
  }
  for (const entry of entries) {
    // Активные маркеры и их временные файлы не трогаем: по ним идёт реконсиляция.
    if (/^deploy-.*\.json(\.\d+\.tmp)?$/.test(entry.name)) continue;
    const full = path.join(config.tmpDir, entry.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs < maxAgeMs) continue;
    try {
      const size = entry.isDirectory() ? dirSize(full) : st.size;
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      files++;
      bytes += size;
    } catch (err) {
      console.error(`[panel] не удалось удалить ${full}: ${err.message}`);
    }
  }
  return { files, bytes };
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try { total += fs.statSync(full).size; } catch { /* исчез */ }
      }
    }
  };
  walk(dir);
  return total;
}

module.exports = {
  markerFile,
  writeMarker,
  readMarker,
  removeMarker,
  listMarkers,
  reconcile,
  cleanTemp,
};
