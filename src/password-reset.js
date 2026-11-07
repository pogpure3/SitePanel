'use strict';

const crypto = require('crypto');
const auth = require('./auth');
const { sendEmail } = require('./mailer');
const { config } = require('./config');

const REQUEST_COOLDOWN_MS = 60 * 1000;
let activeToken = null;
let lastSentAt = 0;
let requestInFlight = false;

function codedError(code, message, retryAfterSec) {
  const err = new Error(message);
  err.code = code;
  if (retryAfterSec) err.retryAfterSec = retryAfterSec;
  return err;
}

function resetUrl(token) {
  let url;
  try {
    url = new URL(config.publicUrl);
  } catch {
    throw codedError('NOT_CONFIGURED', 'Не задан корректный PANEL_PUBLIC_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw codedError('NOT_CONFIGURED', 'PANEL_PUBLIC_URL должен использовать HTTP(S)');
  }
  url.pathname = '/login';
  url.search = '';
  // Fragment не уходит на сервер и не попадает в access-логи nginx.
  url.hash = `reset=${token}`;
  return url.toString();
}

function validateResetEmail() {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.passwordResetEmail)) {
    throw codedError('NOT_CONFIGURED', 'Не задан корректный PANEL_PASSWORD_RESET_EMAIL');
  }
}

async function sendResetMail(url) {
  return sendEmail(
    config.passwordResetEmail,
    'Сброс пароля SitePanel',
    [
      'Получен запрос на сброс пароля SitePanel.',
      '',
      `Ссылка действует ${config.passwordResetTtlMin} минут:`,
      url,
      '',
      'Если вы не запрашивали сброс, ничего не делайте.',
    ].join('\n')
  );
}

/** Создать одноразовый токен и отправить ссылку. Токен сохраняется только хешем. */
async function requestReset() {
  validateResetEmail();
  // Проверяем URL до SMTP: неверная настройка не должна отправлять бесполезное письмо.
  const token = crypto.randomBytes(32).toString('hex');
  const url = resetUrl(token);
  const now = Date.now();
  const left = REQUEST_COOLDOWN_MS - (now - lastSentAt);
  if (requestInFlight || left > 0) {
    throw codedError('RATE_LIMIT', 'Запрос уже отправлен. Повторите позже.', Math.max(1, Math.ceil(left / 1000)));
  }

  requestInFlight = true;
  try {
    const sent = await sendResetMail(url);
    if (sent === false) throw codedError('NOT_CONFIGURED', 'SMTP не настроен');
    activeToken = {
      hash: crypto.createHash('sha256').update(token).digest(),
      expiresAt: Date.now() + config.passwordResetTtlMin * 60 * 1000,
    };
    lastSentAt = Date.now();
  } catch (err) {
    if (err && (err.code === 'NOT_CONFIGURED' || err.code === 'RATE_LIMIT')) throw err;
    throw codedError('DELIVERY_FAILED', 'Не удалось отправить письмо для сброса пароля');
  } finally {
    requestInFlight = false;
  }
}

/** Проверить и погасить токен, затем сменить пароль штатным механизмом. */
function confirmReset(token, password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw codedError('INVALID_PASSWORD', 'Пароль должен быть не короче 8 символов');
  }
  if (!activeToken) {
    throw codedError('INVALID_TOKEN', 'Ссылка недействительна или устарела');
  }
  if (activeToken.expiresAt <= Date.now()) {
    activeToken = null;
    throw codedError('INVALID_TOKEN', 'Ссылка недействительна или устарела');
  }
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) {
    throw codedError('INVALID_TOKEN', 'Ссылка недействительна или устарела');
  }
  const supplied = crypto.createHash('sha256').update(token).digest();
  if (!crypto.timingSafeEqual(activeToken.hash, supplied)) {
    throw codedError('INVALID_TOKEN', 'Ссылка недействительна или устарела');
  }
  // changePassword сначала атомарно пишет auth.json и только затем меняет память
  // и сессии. Токен тоже гасим лишь после этого durable commit: при ENOSPC/EIO
  // владелец сможет повторить сброс, а не останется без рабочей ссылки.
  const result = auth.changePassword('', password);
  activeToken = null;
  return result;
}

module.exports = { requestReset, confirmReset };
