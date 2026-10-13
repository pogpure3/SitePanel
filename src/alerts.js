'use strict';

// Оповещения Telegram: диск/память выше порога.
// Антифлап: алерт при пересечении порога, повтор раз в 30 минут,
// сообщение о восстановлении при возврате на 5% ниже порога (гистерезис).

const fs = require('fs');
const { config } = require('./config');
const store = require('./store');
const dashboard = require('./dashboard');
const secure = require('./securefile');

const CHECK_INTERVAL_MS = 30000;
const REPEAT_MS = 30 * 60 * 1000;
const HYSTERESIS = 5;

const state = {
  disk: { alerted: false, lastSent: 0 },
  mem: { alerted: false, lastSent: 0 },
};

// Состояние алертов по сайтам: siteId -> { alerted, lastSent }
const siteState = new Map();
const SITE_REPEAT_MS = REPEAT_MS;

/* ---------- Персистентность защёлок (SP-22) ----------
 * Раньше защёлки жили только в памяти: после рестарта панели алерт
 * отправлялся повторно при неизменной проблеме, а сообщение «восстановился»
 * не приходило никогда. Состояние маленькое — пишется в data/state.json
 * атомарно, с задержкой, чтобы частые переходы не порождали запись на каждый чих.
 */

const STATE_VERSION = 1;
let persistTimer = null;

function getStateSnapshot() {
  const sites = {};
  for (const [id, v] of siteState) sites[id] = { ...v };
  return { version: STATE_VERSION, disk: { ...state.disk }, mem: { ...state.mem }, sites };
}

function persistState() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      secure.writePrivateAtomic(config.stateFile, JSON.stringify(getStateSnapshot(), null, 2));
    } catch (err) {
      // Потеря состояния защёлок не стоит паники: worst case — повторный алерт.
      console.error('[alerts] не удалось сохранить состояние защёлок:', err.message);
    }
  }, 1000);
}

function restoreState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
  } catch {
    return false; // файла нет или он бит — начинаем с чистого состояния
  }
  if (!raw || typeof raw !== 'object' || raw.version !== STATE_VERSION) return false;
  for (const key of ['disk', 'mem']) {
    const v = raw[key];
    if (v && typeof v === 'object') {
      state[key] = { alerted: !!v.alerted, lastSent: Number(v.lastSent) || 0 };
    }
  }
  if (raw.sites && typeof raw.sites === 'object') {
    for (const [id, v] of Object.entries(raw.sites)) {
      if (v && typeof v === 'object') {
        siteState.set(String(id), { alerted: !!v.alerted, lastSent: Number(v.lastSent) || 0 });
      }
    }
  }
  return true;
}

function host() {
  try {
    return dashboard.snapshot().server.hostname;
  } catch {
    return '';
  }
}

function siteLabel(site) {
  const domain = site.domains && site.domains.length ? site.domains[0] : null;
  return `«${site.name}»${domain ? ` (${domain})` : ''}`;
}

/**
 * Сайт недоступен. Дедупликация: пока проблема не уйдёт, сообщения
 * повторяются не чаще SITE_REPEAT_MS; повторный вызов без восстановления
 * не создаёт дубликатов.
 */
async function siteDown(site, reason) {
  const st = siteState.get(site.id) || { alerted: false, lastSent: 0 };
  if (st.alerted && Date.now() - st.lastSent < SITE_REPEAT_MS) return;
  const ok = await send(`⚠️ SitePanel [${host()}]: сайт ${siteLabel(site)} — ${reason}`);
  if (ok) {
    siteState.set(site.id, { alerted: true, lastSent: Date.now() });
    persistState();
  }
}

/** Сайт снова отвечает (после алерта о падении). */
async function siteUp(site) {
  const st = siteState.get(site.id);
  if (!st || !st.alerted) return;
  const ok = await send(`✅ SitePanel [${host()}]: сайт ${siteLabel(site)} восстановился`);
  if (ok) {
    siteState.delete(site.id);
    persistState();
  }
}

/** Ручная остановка / удаление — сбрасываем алерт без сообщения. */
function siteSilentClear(siteId) {
  if (siteState.delete(siteId)) persistState();
}

function fmtGb(n) {
  return (n / 1073741824).toFixed(1);
}

/**
 * Токен бота не должен попадать в журналы (A-02): часть текстов ошибок может
 * содержать URL запроса, а в нём токен стоит в пути.
 */
function redactToken(text) {
  const a = store.state.settings.alerts;
  const token = a && a.telegramToken;
  const s = String(text);
  return token ? s.split(token).join('***').split('bot' + token).join('bot***') : s;
}

async function send(text) {
  const a = store.state.settings.alerts;
  if (!a || !a.telegramToken || !a.telegramChatId) return false;
  // api.telegram.org иногда отвечает transient-сбоями — одна повторная попытка.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${a.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: a.telegramChatId, text }),
      });
      if (res.ok) return true;
      console.error('[alerts] telegram error', res.status, redactToken((await res.text()).slice(0, 200)));
      return false; // внятная ошибка API — ретраить бессмысленно
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      console.error('[alerts] send failed:', redactToken(err.message));
      return false;
    }
  }
  return false;
}

async function checkMetric(kind, label, pct, threshold, extra) {
  const st = state[kind];
  const a = store.state.settings.alerts;
  const above = pct >= threshold;
  const below = pct < threshold - HYSTERESIS;
  const host = dashboard.snapshot().server.hostname;

  if (above && (!st.alerted || Date.now() - st.lastSent > REPEAT_MS)) {
    const text = `⚠️ SitePanel [${host}]: ${label} — ${pct}% (порог ${threshold}%)${extra ? '\n' + extra : ''}`;
    if (await send(text)) {
      st.alerted = true;
      st.lastSent = Date.now();
      persistState();
    }
  } else if (!above && below && st.alerted) {
    const text = `✅ SitePanel [${host}]: ${label} вернулась к ${pct}% (порог ${threshold}%)`;
    if (await send(text)) {
      st.alerted = false;
      st.lastSent = 0;
      persistState();
    }
  }
}

async function check() {
  const a = store.state.settings.alerts;
  if (!a || a.enabled === false) return;
  try {
    const snap = dashboard.snapshot();
    if (snap.disk && snap.disk.pct !== null && snap.disk.total) {
      await checkMetric('disk', 'Диск', snap.disk.pct, a.diskThreshold,
        `Занято ${fmtGb(snap.disk.used)} из ${fmtGb(snap.disk.total)} ГБ (${snap.disk.path})`);
    }
    if (snap.mem.pct !== null) {
      await checkMetric('mem', 'Память', snap.mem.pct, a.memThreshold,
        `Занято ${fmtGb(snap.mem.used)} из ${fmtGb(snap.mem.total)} ГБ`);
    }
  } catch (err) {
    console.error('[alerts] check failed:', err.message);
  }
}

function start() {
  // Защёлки восстанавливаются до первого тика: иначе после рестарта панели
  // алерт при неизменной проблеме уходил повторно (SP-22).
  const restored = restoreState();
  if (restored) console.log('  Состояние алертов восстановлено из data/state.json');
  check();
  setInterval(check, CHECK_INTERVAL_MS);
}

module.exports = {
  start,
  check,
  send,
  siteDown,
  siteUp,
  siteSilentClear,
  getStateSnapshot,
  persistState,
  restoreState,
};
