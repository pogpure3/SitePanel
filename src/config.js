'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.PANEL_DATA_DIR || path.join(ROOT, 'data');

const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  sitesDir: path.join(DATA_DIR, 'sites'),
  certsDir: path.join(DATA_DIR, 'certs'),
  logsDir: path.join(DATA_DIR, 'logs'),
  tmpDir: path.join(DATA_DIR, 'tmp'),
  dbFile: path.join(DATA_DIR, 'db.json'),
  authFile: path.join(DATA_DIR, 'auth.json'),
  configFile: path.join(DATA_DIR, 'config.json'),
  acmeDir: path.join(DATA_DIR, 'acme'),

  // Порты. 80/443 требуют прав администратора (Windows) / root или CAP_NET_BIND_SERVICE (Linux).
  adminPort: int(process.env.PANEL_ADMIN_PORT, 3000),
  httpPort: int(process.env.PANEL_HTTP_PORT, 80),
  httpsPort: int(process.env.PANEL_HTTPS_PORT, 443),

  // Let's Encrypt
  leEmail: process.env.PANEL_LE_EMAIL || '',
  leStaging: bool(process.env.PANEL_LE_STAGING, false),
  leRenewDays: int(process.env.PANEL_LE_RENEW_DAYS, 30),

  uploadMaxMb: int(process.env.PANEL_UPLOAD_MAX_MB, 300),
  internalPortFrom: int(process.env.PANEL_INTERNAL_PORT_FROM, 10000),

  // Автоперезапуск упавших сайтов.
  // Бэкофф сбрасывается только после стабильной работы restartStableSec секунд,
  // иначе сайт, падающий позже 1.5с, перезапускался бы бесконечно с интервалом 1с.
  restartMaxAttempts: int(process.env.PANEL_RESTART_MAX_ATTEMPTS, 5),
  restartStableSec: int(process.env.PANEL_RESTART_STABLE_SEC, 60),
  restartCooldownMin: int(process.env.PANEL_RESTART_COOLDOWN_MIN, 10),

  // Распаковка архива: защита от zip-бомб.
  maxUncompressedMb: int(process.env.PANEL_MAX_UNCOMPRESSED_MB, 2048),
  maxZipEntries: int(process.env.PANEL_MAX_ZIP_ENTRIES, 50000),
  // Ограничение времени на npm/yarn/pnpm install и сборку.
  installTimeoutMin: int(process.env.PANEL_INSTALL_TIMEOUT_MIN, 10),
};

// Пользовательский config.json перекрывает значения по умолчанию.
function loadUserConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.configFile, 'utf8'));
    for (const key of ['adminPort', 'httpPort', 'httpsPort', 'leEmail', 'leStaging', 'leRenewDays']) {
      if (raw[key] !== undefined) config[key] = raw[key];
    }
  } catch {
    /* файла ещё нет — используем значения по умолчанию */
  }
}
loadUserConfig();

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function bool(v, dflt) {
  if (v === undefined) return dflt;
  return v === '1' || v === 'true' || v === 'yes';
}

function ensureDirs() {
  for (const dir of [DATA_DIR, config.sitesDir, config.certsDir, config.logsDir, config.tmpDir, config.acmeDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { config, ensureDirs };
