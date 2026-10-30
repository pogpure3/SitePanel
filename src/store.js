'use strict';

const fs = require('fs');
const { config } = require('./config');
const secure = require('./securefile');

// Простое JSON-хранилище: { sites: [], settings: {} }.
// Запись отложенная (debounce), синхронизация при выходе.
//
// Два свойства, которые здесь защищаются специально:
//   1. Битый db.json НИКОГДА не должен молча превратиться в пустой реестр и быть
//      затёртым. Раньше `catch { /* первый запуск */ }` не отличал «файла ещё нет»
//      от «файл повреждён», и первая же мутация переписывала единственную копию
//      пустым состоянием — со всеми сайтами, доменами и портами (SP-01).
//   2. Ошибка записи (ENOSPC, EACCES, read-only ФС) не должна выглядеть как успех:
//      иначе API отвечает `{ok:true}` за изменения, которых на диске нет (SP-06).

const SITE_TYPES = new Set(['node', 'static', 'docker']);
// Чем запускается Docker-сайт: одиночный Dockerfile или docker-compose-файл.
const DOCKER_FLAVORS = new Set(['dockerfile', 'compose']);

// Версия схемы состояния (SP-15). Файл без version — легаси до введения версий;
// файл с БОЛЬШЕЙ версией читается как есть с предупреждением, чтобы откат панели
// на старый код не молча терял новые поля.
const STATE_VERSION = 1;

const state = {
  version: STATE_VERSION,
  sites: [],
  settings: {
    leEmail: config.leEmail,
    leStaging: config.leStaging,
    alerts: {
      enabled: true,
      telegramToken: '',
      telegramChatId: '',
      diskThreshold: 80,
      memThreshold: 80,
    },
  },
};

let saveTimer = null;

// Аварийный режим: реестр повреждён (или не читается). Пока он включён, flush()
// отказывается писать, чтобы не затереть возможно восстановимые данные.
let recoveryMode = false;
let recoveryReason = null;
// Последняя ошибка сохранения — чтобы её можно было показать в интерфейсе,
// а не только в журнале.
let lastSaveError = null;

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Привести запись сайта к ожидаемой форме.
 * Битые записи отбрасываются: раньше запись без `domains` роняла сырой
 * http-листенер прокси и оставляла запрос без ответа (SP-07).
 * @param {object} raw запись из db.json
 * @returns {{site: object|null, why: string|null}}
 */
function validateSite(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { site: null, why: 'запись не объект' };
  if (typeof raw.id !== 'string' || !raw.id.trim()) return { site: null, why: 'нет id' };

  const site = { ...raw };
  site.id = raw.id.trim();

  if (typeof site.name !== 'string' || !site.name.trim()) site.name = site.id;

  if (!Array.isArray(site.domains)) {
    site.domains = [];
  } else {
    const domains = [];
    for (const d of site.domains) {
      const normalized = normalizeDomain(d);
      if (normalized) domains.push(normalized);
      else console.error(`[store] сайт ${site.id}: домен ${JSON.stringify(d)} отброшен как невалидный`);
    }
    site.domains = domains;
  }

  if (!SITE_TYPES.has(site.type)) {
    if (site.type !== undefined) {
      console.error(`[store] сайт ${site.id}: неизвестный тип ${JSON.stringify(site.type)}, принят как static`);
    }
    site.type = 'static';
  }

  if (site.port === null || site.port === undefined) {
    site.port = null;
  } else {
    const port = Number(site.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) site.port = port;
    else {
      console.error(`[store] сайт ${site.id}: недопустимый порт ${JSON.stringify(site.port)}, сброшен в null`);
      site.port = null;
    }
  }

  if (typeof site.autoStart !== 'boolean') site.autoStart = false;
  if (typeof site.noindex !== 'boolean') site.noindex = false;
  if (typeof site.status !== 'string') site.status = 'stopped';

  // Docker-сайт: containerPort — порт приложения ВНУТРИ контейнера (панель
  // публикует его на 127.0.0.1:<port>); dockerFlavor — чем запускается проект.
  // Мусор вместо числа обнуляется: без containerPort деплой детектирует порт
  // из EXPOSE/ports, а до этого публиковать нечего.
  if (site.containerPort === null || site.containerPort === undefined || site.containerPort === '') {
    site.containerPort = null;
  } else {
    const cp = Number(site.containerPort);
    if (Number.isInteger(cp) && cp > 0 && cp < 65536) site.containerPort = cp;
    else site.containerPort = null;
  }
  site.dockerFlavor = DOCKER_FLAVORS.has(site.dockerFlavor) ? site.dockerFlavor : null;

  // Расписание бэкапов (по образцу Backups ispmanager). Дефолт выключен:
  // бэкапы без ведома администратора занимали бы диск сами по себе.
  if (!site.backupSchedule || typeof site.backupSchedule !== 'object' || Array.isArray(site.backupSchedule)) {
    site.backupSchedule = { enabled: false, intervalHours: 24, keep: 5, scope: 'full', lastRunAt: null, lastError: null };
  } else {
    const s = site.backupSchedule;
    const norm = {
      enabled: s.enabled === true,
      intervalHours: Number(s.intervalHours),
      keep: Number.isInteger(Number(s.keep)) ? Number(s.keep) : 5,
      scope: ['full', 'site', 'database'].includes(s.scope) ? s.scope : 'full',
      lastRunAt: Number(s.lastRunAt) || null,
      lastError: typeof s.lastError === 'string' ? s.lastError : null,
    };
    // Интервал дробный не запрещён: 0.1 ч = 6 минут — режим для тестов и
    // «перед деплоем прогнать вручную»; меньше 0.05 ч (3 мин) смысла нет.
    if (!Number.isFinite(norm.intervalHours) || norm.intervalHours < 0.05 || norm.intervalHours > 8760) {
      norm.intervalHours = 24;
    }
    if (norm.keep < 1 || norm.keep > 100) norm.keep = 5;
    site.backupSchedule = norm;
  }

  // Телеметрия (health/fails) живёт в памяти монитора, а не в реестре (M-02):
  // ключи из старых db.json выбрасываются, чтобы не возвращались на диск.
  delete site.health;
  delete site.fails;

  return { site, why: null };
}

/**
 * Миграция разобранного состояния (SP-15).
 * @param {object} raw состояние из db.json
 * @returns {number} версия, с которой читаем
 */
function migrate(raw) {
  const from = typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 0;
  if (from > STATE_VERSION) {
    console.error(`[store] db.json версии ${from} новее поддерживаемой ${STATE_VERSION} — читаю как есть; ` +
      'поля новых версий сохранятся при следующей записи только если схема их допускает');
  }
  // Шаги миграций добавлять здесь: if (from < 2) { ... }
  return from;
}

/** Применить разобранное состояние. Невалидные записи отбрасываются с логом. */
function applyRaw(raw) {
  migrate(raw);
  if (Array.isArray(raw.sites)) {
    const accepted = [];
    let dropped = 0;
    for (const entry of raw.sites) {
      const { site, why } = validateSite(entry);
      if (site) accepted.push(site);
      else {
        dropped++;
        console.error(`[store] запись сайта отброшена (${why}): ${JSON.stringify(entry).slice(0, 200)}`);
      }
    }
    state.sites = accepted;
    if (dropped > 0) console.error(`[store] отброшено невалидных записей: ${dropped}`);
  }
  if (raw.settings && typeof raw.settings === 'object') {
    // Поверхностное слияние с защитой: `"alerts": null` раньше молча выключал
    // алерты и ронял PUT /api/settings на `a.enabled` (TypeError → 500).
    const incoming = { ...raw.settings };
    if (incoming.alerts !== undefined && (!incoming.alerts || typeof incoming.alerts !== 'object')) {
      console.error('[store] настройки alerts повреждены — оставлены значения по умолчанию');
      delete incoming.alerts;
    } else if (incoming.alerts) {
      incoming.alerts = { ...state.settings.alerts, ...incoming.alerts };
    }
    Object.assign(state.settings, incoming);
  }

  // Нормализация настроек: мусор в порогах (строка, NaN, вне диапазона) раньше
  // отключал сравнение `pct >= threshold` непредсказуемым образом (SP-15).
  for (const key of ['diskThreshold', 'memThreshold']) {
    const v = Number(state.settings.alerts[key]);
    if (!Number.isFinite(v) || v < 1 || v > 99) {
      if (state.settings.alerts[key] !== undefined && state.settings.alerts[key] !== '') {
        console.error(`[store] settings.alerts.${key}=${JSON.stringify(state.settings.alerts[key])} невалиден — оставлено 80`);
      }
      state.settings.alerts[key] = 80;
    }
  }
  state.version = STATE_VERSION;
}

/**
 * Уйти в аварийный режим: сохранить повреждённый файл, попробовать поднять
 * предыдущее поколение из db.json.bak.
 * Явное подтверждение (`PANEL_RECOVERY_ACCEPT=1`) позволяет принять текущее
 * состояние и снова разрешить запись — оригинал уже отложен в `.corrupt-*`.
 */
function enterRecovery(reason, opts = {}) {
  console.error('');
  console.error('  !!! Реестр сайтов (db.json) повреждён — включён аварийный режим. !!!');
  console.error(`  Причина: ${reason}`);
  recoveryMode = true;
  recoveryReason = reason;

  if (opts.corrupt) {
    const saved = `${config.dbFile}.corrupt-${timestamp()}`;
    try {
      fs.renameSync(config.dbFile, saved);
      console.error(`  Повреждённый файл сохранён: ${saved}`);
    } catch (err) {
      console.error(`  НЕ удалось сохранить повреждённый db.json (${err.message}) — файл оставлен на месте.`);
    }
  }

  const backup = config.dbFile + '.bak';
  try {
    const rawBak = JSON.parse(fs.readFileSync(backup, 'utf8'));
    applyRaw(rawBak);
    console.error(`  Состояние восстановлено из ${backup}: сайтов ${state.sites.length}.`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`  Резервная копия ${backup} не пригодна: ${err.message}`);
    console.error('  Резервной копии нет — стартуем с пустым реестром, запись на диск запрещена.');
  }

  if (process.env.PANEL_RECOVERY_ACCEPT === '1') {
    console.error('  PANEL_RECOVERY_ACCEPT=1 — восстановленное состояние принято, запись разрешена.');
    recoveryMode = false;
  } else {
    console.error('  Запись изменений ЗАПРЕЩЕНА. Проверьте данные и перезапустите панель');
    console.error('  либо подтвердите текущее состояние: PANEL_RECOVERY_ACCEPT=1');
  }
  console.error('');
}

function load() {
  let text;
  try {
    text = fs.readFileSync(config.dbFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return state; // первый запуск — это нормально
    enterRecovery(`db.json не читается: ${err.code || err.message}`, { corrupt: false });
    return state;
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    enterRecovery(`db.json не разбирается как JSON: ${err.message}`, { corrupt: true });
    return state;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    enterRecovery('db.json разобран, но это не объект состояния', { corrupt: true });
    return state;
  }

  applyRaw(raw);
  recoveryMode = false;
  recoveryReason = null;
  return state;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      flush();
    } catch (err) {
      // Фоновую запись никто не ждёт: без этой обёртки исключение из таймера
      // стало бы uncaughtException, а процесс продолжил бы отвечать «ок» (SP-06).
      lastSaveError = err;
      console.error('[store] отложенная запись db.json не удалась:', err.message);
    }
  }, 250);
}

/**
 * Синхронная запись реестра на диск.
 * Бросает при сбое — вызывающие в HTTP-маршрутах должны отдать 5xx, а не «ок».
 * @throws {Error} при аварийном режиме или ошибке ФС
 */
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;

  if (recoveryMode) {
    const err = new Error(
      `Изменения не сохранены: реестр в аварийном режиме (${recoveryReason}). ` +
        'Проверьте data/db.json и перезапустите панель.'
    );
    err.code = 'STORE_RECOVERY';
    lastSaveError = err;
    console.error('[store]', err.message);
    throw err;
  }

  const data = JSON.stringify(state, null, 2);

  // Ротация одного поколения: если следующая запись окажется битой, .bak
  // позволит вернуться на шаг назад (SP-01).
  try {
    if (fs.existsSync(config.dbFile)) fs.copyFileSync(config.dbFile, config.dbFile + '.bak');
  } catch (err) {
    console.error('[store] не удалось обновить db.json.bak:', err.message);
  }

  // В db.json лежат git-токены и e-mail — файл не должен быть читаем всем.
  // writePrivateAtomic делает tmp→fsync→rename и бросает при сбое.
  secure.writePrivateAtomic(config.dbFile, data);
  lastSaveError = null;
}

function getSite(id) {
  return state.sites.find((s) => s.id === id) || null;
}

function hasDomains(site) {
  return Array.isArray(site && site.domains);
}

function getSiteByDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d) return null;
  // Сначала точное совпадение, затем wildcard *.example.com.
  for (const site of state.sites) {
    if (hasDomains(site) && site.domains.includes(d)) return site;
  }
  for (const site of state.sites) {
    if (!hasDomains(site)) continue;
    for (const dn of site.domains) {
      if (dn.startsWith('*.')) {
        const base = dn.slice(2);
        if (d.endsWith('.' + base) && d.length > base.length + 1) return site;
      }
    }
  }
  return null;
}

function domainTaken(domain, exceptSiteId) {
  const d = normalizeDomain(domain);
  return state.sites.some((s) => s.id !== exceptSiteId && hasDomains(s) && s.domains.includes(d));
}

function normalizeDomain(domain) {
  if (!domain || typeof domain !== 'string') return null;
  let d = domain.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').split('/')[0].split(':')[0].split('@').pop();
  if (!d) return null;
  if (d === '*' || !/^\*?\.[a-z]/.test(d) && !/^[a-z0-9]/.test(d)) return null;
  if (!/^[a-z0-9*.-]+$/.test(d) || !d.includes('.')) return null;
  if (d.includes('..') || d.startsWith('.') || d.startsWith('-') || d.endsWith('-')) return null;
  return d;
}

/** Аварийный режим включён: записи на диск нет. */
function isRecoveryMode() {
  return recoveryMode;
}

function getRecoveryReason() {
  return recoveryReason;
}

/** Последняя ошибка сохранения (или null, если запись проходила). */
function getLastSaveError() {
  return lastSaveError;
}

module.exports = {
  state,
  load,
  save,
  flush,
  getSite,
  getSiteByDomain,
  domainTaken,
  normalizeDomain,
  validateSite,
  isRecoveryMode,
  getRecoveryReason,
  getLastSaveError,
};
