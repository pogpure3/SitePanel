'use strict';

// Let's Encrypt через acme-client (HTTP-01 challenge).
// Challenge-токены раздаются реверс-прокси на порту 80 по пути /.well-known/acme-challenge/.

const fs = require('fs');
const path = require('path');
const acme = require('acme-client');
const { config } = require('../config');
const store = require('../store');
const certs = require('./certs');
const manager = require('../sites/manager');
const secure = require('../securefile');

// token -> keyAuthorization (живёт в памяти, нужен только на время заказа).
// Ключ — «домен|токен»: раньше карта была общей, и завершение выпуска для сайта A
// в finally стирало токены сайта B — параллельный выпуск падал по таймауту (H-04).
const pendingChallenges = new Map();

// Выпуск сертификата — сетевая операция на минуты; два выпуска для одного сайта
// одновременно (ручной + цикл продления) писали два CSR в одни файлы (H-18).
const MIN_ISSUE_INTERVAL_MS = 60 * 1000;

function challengeKey(domain, token) {
  return String(domain).toLowerCase() + '|' + String(token);
}

function setChallenge(domain, token, keyAuthorization) {
  pendingChallenges.set(challengeKey(domain, token), keyAuthorization);
}

function removeChallenge(domain, token) {
  pendingChallenges.delete(challengeKey(domain, token));
}

function directoryUrl(staging) {
  return staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
}

function accountKeyFile(staging) {
  return path.join(config.acmeDir, 'account-' + (staging ? 'staging' : 'production') + '.pem');
}

async function loadAccountKey(staging) {
  const file = accountKeyFile(staging);
  secure.mkdirPrivate(config.acmeDir);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const key = await acme.crypto.createPrivateKey();
  // Ключ аккаунта ACME — приватный: им панель аутентифицируется в Let's Encrypt.
  secure.writePrivate(file, key);
  return key;
}

/**
 * Выпуск сертификата Let's Encrypt для сайта.
 * @param {object} site запись БД
 * @param {object} opts { domains: string[], email: string, staging: boolean }
 */
async function issueCertificate(site, opts = {}) {
  // Выпуск — долгая операция; лок сайта не даёт ручному выпуску наложиться на
  // цикл продления того же сайта (два CSR, две записи в одни файлы) (H-18).
  return manager.withSiteLock(site.id, () => issueCertificateLocked(site, opts));
}

async function issueCertificateLocked(site, opts = {}) {
  const domains = (opts.domains && opts.domains.length ? opts.domains : site.domains)
    .filter((d) => !d.startsWith('*')); // wildcard через HTTP-01 невозможен
  if (!domains.length) throw new Error('Нет доменов без wildcard для выпуска сертификата');

  // Повторный выпуск раньше чем через минуту расходовал лимит дубликатов
  // Let's Encrypt (5/нед) на нечаянные повторные клики (H-18).
  if (site.ssl && site.ssl.issuedAt && Date.now() - site.ssl.issuedAt < MIN_ISSUE_INTERVAL_MS) {
    throw new Error('Сертификат выпускался меньше минуты назад — повторите позже');
  }

  const email = opts.email || store.state.settings.leEmail;
  // Целевой каталог (staging/production) для УЖЕ выпущенного сайта берётся из
  // его записи: иначе переключение глобальной настройки молча переводило
  // существующий сайт между staging и production при продлении (H-18).
  const staging = opts.staging !== undefined
    ? !!opts.staging
    : site.ssl && site.ssl.staging !== undefined && site.ssl.provider === 'letsencrypt'
      ? !!site.ssl.staging
      : !!store.state.settings.leStaging;

  // Токены, выпущенные ЭТИМ заказом: finally раньше стирал ВСЕ токены карты,
  // роняя параллельный выпуск для другого сайта (H-04).
  const ownTokens = new Set();

  site.ssl = site.ssl || {};
  site.ssl.provider = 'letsencrypt';
  site.ssl.status = 'pending';
  site.ssl.staging = staging;
  site.ssl.requestedDomains = domains;
  site.ssl.error = null;
  store.save();

  try {
    const accountKey = await loadAccountKey(staging);
    const client = new acme.Client({
      directoryUrl: directoryUrl(staging),
      accountKey,
    });

    // acme-client 5.x: auto() требует готовый CSR, ключ сертификата возвращается из createCsr.
    const [certKeyPem, csrPem] = await acme.crypto.createCsr({
      commonName: domains[0],
      altNames: domains,
      keySize: 2048,
    });

    const certPem = await client.auto({
      csr: csrPem,
      domains,
      email: email || undefined,
      termsOfServiceAgreed: true,
      skipChallengeVerification: true, // проверку делает сам Let's Encrypt
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        if (challenge.type === 'http-01') {
          const domain = _authz.identifier.value;
          manager.appendLog(site, `[ssl] challenge: подготовлен токен ${challenge.token} для ${domain}`);
          setChallenge(domain, challenge.token, keyAuthorization);
          ownTokens.add(challengeKey(domain, challenge.token));
        }
      },
      challengeRemoveFn: async (_authz, challenge) => {
        if (challenge.type === 'http-01') removeChallenge(_authz.identifier.value, challenge.token);
      },
    });

    certs.saveCertFiles(site, certKeyPem, certPem);
    const info = acme.crypto.readCertificateInfo(certPem);
    // acme-client 5.x: domains — объект { commonName, altNames }.
    const certDomains = Array.from(new Set([info.domains.commonName, ...(info.domains.altNames || [])].filter(Boolean)));
    site.ssl.status = 'active';
    site.ssl.domains = certDomains;
    site.ssl.issuedAt = Date.now();
    site.ssl.expiresAt = certs.certExpiresAt(certPem) || (info.expires ? new Date(info.expires).getTime() : null);
    site.ssl.error = null;
    store.flush();
    manager.appendLog(site, `[ssl] сертификат выпущен для ${certDomains.join(', ')} (действует до ${site.ssl.expiresAt ? new Date(site.ssl.expiresAt).toISOString() : '?'})`);
    return { ok: true };
  } catch (err) {
    site.ssl.status = 'error';
    site.ssl.error = String(err.message || err).slice(0, 500);
    store.save();
    manager.appendLog(site, `[ssl] ОШИБКА выпуска сертификата: ${site.ssl.error}`);
    throw err;
  } finally {
    // Удаляем только свои токены: общая очистка карты теряла challenge
    // параллельного выпуска другого сайта (H-04).
    for (const key of ownTokens) pendingChallenges.delete(key);
  }
}

function getChallenge(domain, token) {
  if (!domain) return null;
  return pendingChallenges.get(challengeKey(domain, token)) || null;
}

/**
 * Автопродление: проверяем сертификаты, истекающие в течение config.leRenewDays
 * дней, и перевыпускаем их — по ОДНОМУ сайту за тик (H-04): раньше все сайты
 * продлевались одновременно, складывая нагрузку на Let's Encrypt и на панель.
 * Интервал с джиттером, чтобы продления не выстраивались в регулярный шторм.
 */
let renewalTimer = null;

function scheduleRenewal(delayMs) {
  if (renewalTimer) clearTimeout(renewalTimer);
  renewalTimer = setTimeout(runRenewalTick, delayMs);
  renewalTimer.unref();
}

async function runRenewalTick() {
  let due = null;
  for (const site of store.state.sites) {
    if (!site.ssl || site.ssl.provider !== 'letsencrypt' || site.ssl.status !== 'active') continue;
    const exp = site.ssl.expiresAt || 0;
    if (exp && exp - Date.now() < config.leRenewDays * 86400000) {
      // Первый по очереди истекающий; на следующем тике возьмётся следующий.
      due = site;
      break;
    }
  }
  if (due) {
    manager.appendLog(due, '[ssl] автоматическое продление сертификата...');
    try {
      await issueCertificate(due, { domains: due.ssl.domains, staging: due.ssl.staging });
    } catch (err) {
      // Ошибка продления — в лог сайта (issueCertificate пишет туда же) и в журнал
      // панели; site.ssl.error хранит текст для карточки сайта (H-04).
      console.error(`[ssl] продление не удалось для ${due.name}:`, err.message);
    }
    // Есть ещё кандидаты — следующий тик скоро; нет — обычный интервал с джиттером.
    const stillDue = store.state.sites.some((s) => {
      if (!s.ssl || s.ssl.provider !== 'letsencrypt' || s.ssl.status !== 'active') return false;
      const exp = s.ssl.expiresAt || 0;
      return exp && exp - Date.now() < config.leRenewDays * 86400000;
    });
    scheduleRenewal(stillDue ? 5 * 60000 : 6 * 3600000 + Math.floor(Math.random() * 30 * 60000));
    return;
  }
  scheduleRenewal(6 * 3600000 + Math.floor(Math.random() * 30 * 60000));
}

function startRenewalLoop() {
  scheduleRenewal(30000 + Math.floor(Math.random() * 30000)); // вскоре после старта, с разбросом
}

module.exports = { issueCertificate, getChallenge, setChallenge, removeChallenge, startRenewalLoop };
