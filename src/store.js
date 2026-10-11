'use strict';

const fs = require('fs');
const { config } = require('./config');
const secure = require('./securefile');

// Простое JSON-хранилище: { sites: [], settings: {} }.
// Запись отложенная (debounce), синхронизация при выходе.

const state = {
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

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.dbFile, 'utf8'));
    if (Array.isArray(raw.sites)) state.sites = raw.sites;
    if (raw.settings) Object.assign(state.settings, raw.settings);
  } catch {
    /* первый запуск */
  }
  return state;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = config.dbFile + '.tmp';
  // В db.json лежат git-токены и e-mail — файл не должен быть читаем всем.
  secure.writePrivate(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, config.dbFile);
}

function getSite(id) {
  return state.sites.find((s) => s.id === id) || null;
}

function getSiteByDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d) return null;
  // Сначала точное совпадение, затем wildcard *.example.com.
  for (const site of state.sites) {
    if (site.domains.includes(d)) return site;
  }
  for (const site of state.sites) {
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
  return state.sites.some((s) => s.id !== exceptSiteId && s.domains.includes(d));
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

module.exports = { state, load, save, flush, getSite, getSiteByDomain, domainTaken, normalizeDomain };
