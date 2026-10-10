'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { config } = require('./config');

// Аутентификация админки: HTTP Basic + scrypt.
// При первом запуске генерируется случайный пароль и печатается в консоль.

let auth = null;

function load() {
  try {
    auth = JSON.parse(fs.readFileSync(config.authFile, 'utf8'));
  } catch {
    auth = null;
  }
  if (!auth || !auth.user || !auth.hash) {
    createInitial();
  }
}

function createInitial() {
  const password = crypto.randomBytes(9).toString('base64url');
  auth = { user: 'admin', ...hashPassword(password) };
  fs.writeFileSync(config.authFile, JSON.stringify(auth, null, 2));
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────┐');
  console.log('  │  Учётные данные админ-панели (первый запуск):    │');
  console.log(`  │  Логин:  admin                                   │`);
  console.log(`  │  Пароль: ${password.padEnd(41)}│`);
  console.log('  │  Сохранены в data/auth.json                      │');
  console.log('  └──────────────────────────────────────────────────┘');
  console.log('');
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}

function checkCredentials(user, password) {
  if (!auth || user !== auth.user) return false;
  const { hash } = hashPassword(password, auth.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(auth.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function changePassword(newUser, password) {
  auth = { user: newUser || auth.user, ...hashPassword(password) };
  fs.writeFileSync(config.authFile, JSON.stringify(auth, null, 2));
}

// Express-мiddleware. PANEL_NO_AUTH=1 отключает проверку — для случаев,
// когда авторизацию выполняет внешний реверс-прокси.
function middleware(req, res, next) {
  if (process.env.PANEL_NO_AUTH === '1') return next();
  const header = req.headers.authorization || '';
  const m = /^Basic (.+)$/.exec(header);
  if (m) {
    const [user, pass] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    if (checkCredentials(user, pass)) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="SitePanel", charset="UTF-8"');
  res.status(401).json({ error: 'Требуется авторизация' });
}

function getUser() {
  return auth ? auth.user : 'admin';
}

module.exports = { load, middleware, checkCredentials, changePassword, getUser };
