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

// token -> keyAuthorization (живёт в памяти, нужен только на время заказа)
const pendingChallenges = new Map();

function directoryUrl(staging) {
  return staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
}

function accountKeyFile(staging) {
  return path.join(config.acmeDir, 'account-' + (staging ? 'staging' : 'production') + '.pem');
}

async function loadAccountKey(staging) {
  const file = accountKeyFile(staging);
  fs.mkdirSync(config.acmeDir, { recursive: true });
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const key = await acme.crypto.createPrivateKey();
  fs.writeFileSync(file, key);
  return key;
}

/**
 * Выпуск сертификата Let's Encrypt для сайта.
 * @param {object} site запись БД
 * @param {object} opts { domains: string[], email: string, staging: boolean }
 */
async function issueCertificate(site, opts = {}) {
  const domains = (opts.domains && opts.domains.length ? opts.domains : site.domains)
    .filter((d) => !d.startsWith('*')); // wildcard через HTTP-01 невозможен
  if (!domains.length) throw new Error('Нет доменов без wildcard для выпуска сертификата');

  const email = opts.email || store.state.settings.leEmail;
  const staging = opts.staging !== undefined ? opts.staging : !!store.state.settings.leStaging;

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
          manager.appendLog(site, `[ssl] challenge: подготовлен токен ${challenge.token} для ${_authz.identifier.value}`);
          pendingChallenges.set(challenge.token, keyAuthorization);
        }
      },
      challengeRemoveFn: async (_authz, challenge) => {
        if (challenge.type === 'http-01') pendingChallenges.delete(challenge.token);
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
    for (const [token] of pendingChallenges) pendingChallenges.delete(token);
  }
}

function getChallenge(token) {
  return pendingChallenges.get(token) || null;
}

/**
 * Автопродление: раз в сутки проверяем сертификаты, истекающие в течение
 * config.leRenewDays дней, и перевыпускаем их.
 */
function startRenewalLoop() {
  const check = async () => {
    for (const site of store.state.sites) {
      if (!site.ssl || site.ssl.provider !== 'letsencrypt' || site.ssl.status !== 'active') continue;
      const exp = site.ssl.expiresAt || 0;
      if (exp && exp - Date.now() < config.leRenewDays * 86400000) {
        manager.appendLog(site, '[ssl] автоматическое продление сертификата...');
        try {
          await issueCertificate(site, { domains: site.ssl.domains, staging: site.ssl.staging });
        } catch (err) {
          console.error(`[ssl] продление не удалось для ${site.name}:`, err.message);
        }
      }
    }
  };
  setInterval(check, 6 * 3600000); // 4 раза в сутки
  setTimeout(check, 30000); // и вскоре после старта
}

module.exports = { issueCertificate, getChallenge, startRenewalLoop };
