'use strict';

// Страница входа (/login) и API сессий (/api/login, /api/logout).
//
// Эти обработчики регистрируются ДО auth.middleware: форма сама является
// точкой получения доступа. CSRF-барьер здесь свой (те же три проверки, что
// в admin/routes.js — заголовок X-Requested-With, Origin/Referer, Sec-Fetch-Site):
// без него сторонняя страница могла бы POST'ом залогинить жертву в чужую
// учётку (login CSRF) — заголовок произвольный и preflight не проходит.
//
// Cookie сессии: HttpOnly (не читается JS), SameSite=Lax (отправляется при
// переходе по ссылке с чужого сайта — иначе каждый внешний линк выкидывал бы
// на /login), Secure при HTTPS (за TLS-терминирующим nginx — по
// X-Forwarded-Proto от доверенного источника), Path=/.
// CSRF-защита мутаций /api при этом НЕ ослабевает: сессионная cookie так же
// автоматически прикладывается браузером к кросс-сайтовому POST, как и Basic,
// поэтому существующий guard обязателен как прежде.

const path = require('path');
const auth = require('../auth');
const { effectiveScheme } = require('../httpserver');

const LOGIN_PAGE = path.join(__dirname, 'public', 'login.html');
const LOGIN_SCRIPT = path.join(__dirname, 'public', 'login.js');

function sameHost(value, host) {
  try {
    return new URL(String(value)).host.toLowerCase() === String(host || '').toLowerCase();
  } catch {
    return false;
  }
}

/** Тот же набор проверок, что в csrfGuard (admin/routes.js). */
function csrfOk(req) {
  if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return false;
  const origin = req.headers.origin;
  if (origin !== undefined && !sameHost(origin, req.headers.host)) return false;
  const referer = req.headers.referer;
  if (referer !== undefined && !sameHost(referer, req.headers.host)) return false;
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  return true;
}

/** Куда вернуть пользователя после входа: только путь внутри панели. */
function safeNext(raw) {
  const s = String(raw || '');
  // '/' или '/что-то'; '//' и '\\' — протокол-относительные/пути Windows, наружу не пускаем.
  if (s === '/' || (/^\/[^/\\]/.test(s) && !s.includes('\\'))) return s;
  return '/';
}

/**
 * GET /login — форма входа. Ушедший сессию или анонимный пользователь получает
 * страницу; уже вошедший — сразу уходит на next или в панель.
 */
function loginPage(req, res) {
  if (process.env.PANEL_NO_AUTH === '1') return res.redirect(302, '/');
  const sid = auth.sessionFromRequest(req);
  if (sid && auth.isSessionValid(sid)) {
    return res.redirect(302, safeNext(req.query && req.query.next));
  }
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(LOGIN_PAGE);
}

/**
 * GET /login.js — скрипт страницы входа. Как и сама страница, отдаётся БЕЗ
 * авторизации (иначе форма мертва: остальная статика закрыта middleware).
 * Содержит только работу формы — никаких секретов.
 */
function loginScript(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript; charset=utf-8');
  res.sendFile(LOGIN_SCRIPT);
}

/**
 * POST /api/login — проверка учётных данных и выдача сессии.
 * Антибрутфорс общий с Basic (счётчики по IP в auth.js).
 */
async function loginApi(req, res) {
  if (!csrfOk(req)) {
    return res.status(403).json({ error: 'Запрос отклонён: отсутствует заголовок X-Requested-With (защита от CSRF).' });
  }
  const user = typeof req.body.user === 'string' ? req.body.user : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!user || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }
  try {
    const result = await auth.attemptLogin(user, password, auth.clientIp(req));
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    const { token, maxAgeSec } = auth.createSession();
    const secure = effectiveScheme(req, Boolean(req.secure)) === 'https';
    const parts = [
      `${auth.SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSec}`,
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
    // Событие доступа — в журнал (как и смена пароля); сам пароль не логируется.
    console.log(`[auth] вход через форму (user: ${JSON.stringify(user).slice(0, 60)}, ip: ${auth.clientIp(req)})`);
    res.json({ ok: true, user: auth.getUser() });
  } catch (err) {
    console.error('[auth] ошибка входа через форму:', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка при входе' });
  }
}

/**
 * POST /api/logout — погасить сессию и сбросить cookie.
 * Без авторизации вызов безопасен: гасит только переданный токен.
 */
function logoutApi(req, res) {
  if (!csrfOk(req)) {
    return res.status(403).json({ error: 'Запрос отклонён: отсутствует заголовок X-Requested-With (защита от CSRF).' });
  }
  const sid = auth.sessionFromRequest(req);
  if (sid) auth.destroySession(sid);
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  console.log(`[auth] выход через форму (ip: ${auth.clientIp(req)})`);
  res.json({ ok: true });
}

module.exports = {
  loginPage,
  loginScript,
  loginApi,
  logoutApi,
  safeNext,
  // для тестов
  _csrfOk: csrfOk,
};
