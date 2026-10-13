'use strict';

// Хранилище сертификатов: self-signed по умолчанию, LE-сертификаты на диске,
// динамический SNI для HTTPS-прокси.

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');
const selfsigned = require('selfsigned');
const { config } = require('../config');
const store = require('../store');
const secure = require('../securefile');

const cache = new Map(); // "siteId:dir" -> { ctx, mtime }

function certDir(site) {
  return path.join(config.certsDir, site.id);
}

function defaultDir() {
  return path.join(config.certsDir, '_default');
}

/* ---------- Self-signed ---------- */

// Параметры self-signed. algorithm задаём явно: у selfsigned по умолчанию
// 'sha1', и сертификат с подписью SHA-1 современные клиенты (Chrome, Firefox,
// curl с OpenSSL 3) отвергают на уровне рукопожатия, ещё до проверки цепочки.
// Симптом ровно такой: `curl https://127.0.0.1:8443/` падает с
// `TLS alert handshake failure`, хотя `openssl s_client` соединение устанавливает.
const SIGN_ALGORITHM = 'sha256';

function ensureDefaultCert() {
  const dir = defaultDir();
  const keyFile = path.join(dir, 'privkey.pem');
  const crtFile = path.join(dir, 'fullchain.pem');
  if (fs.existsSync(keyFile)) return;
  secure.mkdirPrivate(dir);
  const pems = selfsigned.generate([{ name: 'commonName', value: 'sitepanel.local' }], {
    days: 825,
    keySize: 2048,
    algorithm: SIGN_ALGORITHM,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
  });
  secure.writePrivate(keyFile, pems.private);
  secure.writePrivate(crtFile, pems.cert, 0o644);
}

function issueSelfSigned(site) {
  const domains = site.domains.length ? site.domains : ['localhost'];
  const altNames = domains
    .filter((d) => !d.startsWith('*'))
    .map((d) => ({ type: 2, value: d }));
  if (!altNames.length) altNames.push({ type: 2, value: 'localhost' });
  const pems = selfsigned.generate([{ name: 'commonName', value: domains[0].replace('*.', 'wild.') }], {
    days: 825,
    keySize: 2048,
    algorithm: SIGN_ALGORITHM,
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  saveCertFiles(site, pems.private, pems.cert);
  site.ssl = {
    provider: 'self-signed',
    status: 'active',
    domains: domains.filter((d) => !d.startsWith('*')),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 825 * 86400000,
    error: null,
  };
  store.save();
}

/* ---------- Файлы сертификатов ---------- */

function saveCertFiles(site, keyPem, fullchainPem) {
  const dir = certDir(site);
  // Каталог и приватный ключ — только для владельца панели: 0644 на privkey.pem
  // делал бы TLS-ключи читаемыми любому пользователю на машине.
  secure.mkdirPrivate(dir);
  secure.writePrivate(path.join(dir, 'privkey.pem'), keyPem);
  secure.writePrivate(path.join(dir, 'fullchain.pem'), fullchainPem, 0o644);
}

function readCertFiles(site) {
  try {
    const dir = certDir(site);
    return {
      key: fs.readFileSync(path.join(dir, 'privkey.pem')),
      cert: fs.readFileSync(path.join(dir, 'fullchain.pem')),
    };
  } catch {
    return null;
  }
}

function removeCertFiles(site) {
  fs.rmSync(certDir(site), { recursive: true, force: true });
  for (const key of cache.keys()) if (key.startsWith(site.id + ':')) cache.delete(key);
}

/* ---------- SNI ---------- */

function buildContext(site, fallback) {
  const files = site ? readCertFiles(site) : null;
  const dir = site ? certDir(site) : defaultDir();
  const stamp = site ? JSON.stringify(site.ssl && site.ssl.status) + fileStamp(dir) : fileStamp(dir);
  const cacheKey = (site ? site.id : '_default') + ':' + (site ? 'site' : 'def');
  const hit = cache.get(cacheKey);
  if (hit && hit.stamp === stamp) return hit.ctx;

  let ctx;
  if (files) {
    try {
      ctx = tls.createSecureContext(files);
    } catch {
      ctx = null;
    }
  }
  if (!ctx) {
    ctx = tls.createSecureContext(defaultCertFiles());
  }
  cache.set(cacheKey, { ctx, stamp });
  return ctx;
}

function fileStamp(dir) {
  try {
    return fs.statSync(path.join(dir, 'fullchain.pem')).mtimeMs + ':' + fs.statSync(path.join(dir, 'privkey.pem')).mtimeMs;
  } catch {
    return 'none';
  }
}

// SNICallback для https-сервера.
function sniCallback(servername, cb) {
  const site = store.getSiteByDomain(servername);
  let ctx;
  try {
    ctx = site && site.ssl && site.ssl.status === 'active' ? buildContext(site) : buildContext(null);
  } catch {
    ctx = buildContext(null);
  }
  cb(null, ctx);
}

/* ---------- Служебное ---------- */

// Срок действия из PEM (для отображения в панели).
function certExpiresAt(pem) {
  try {
    const x509 = new crypto.X509Certificate(pem);
    return new Date(x509.validTo).getTime();
  } catch {
    return null;
  }
}

// Файлы сертификата по умолчанию. Нужны как «контекст по умолчанию» для
// https-сервера: без явных key/cert клиент, не приславший SNI (запрос по IP),
// получает не сертификат, а `TLS alert handshake failure` (alert 40) — SNICallback
// при отсутствии SNI не вызывается вообще.
function defaultCertFiles() {
  return {
    key: fs.readFileSync(path.join(defaultDir(), 'privkey.pem')),
    cert: fs.readFileSync(path.join(defaultDir(), 'fullchain.pem')),
  };
}

module.exports = {
  ensureDefaultCert,
  issueSelfSigned,
  saveCertFiles,
  readCertFiles,
  removeCertFiles,
  sniCallback,
  certExpiresAt,
  certDir,
  defaultCertFiles,
};
