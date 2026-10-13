'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { config } = require('./config');
const secure = require('./securefile');

// Аутентификация админки: HTTP Basic + scrypt.
// При первом запуске генерируется случайный пароль и печатается в консоль.
//
// Важные свойства:
//   1. Битый auth.json НЕ приводит к генерации нового пароля: файл откладывается
//      в сторону, панель отказывается стартовать. Раньше один испорченный байт
//      молча обнулял пароль и перезаписывал файл — доступ терялся навсегда (SP-03).
//   2. scrypt асинхронный: синхронный вызов (~35–50 мс) на каждый запрос в одном
//      с 50 мс) занимает event loop, который обслуживает и реверс-прокси сайтов,
//      поэтому десяток параллельных запросов к админке замедлял отклик сайтов
//      в сотни раз (A-01).
//   3. Неудачные попытки ограничены: задержка + счётчик по IP + блокировка.
//   4. Пароль, содержащий ':', не усекается — header режется по ПЕРВОМУ ':'.

let auth = null;

// --- Ограничение попыток входа -------------------------------------------------

// PANEL_LOGIN_RATE: сколько неудач с одного адреса допускается в окне (0 — выключить).
const LOGIN_MAX_FAILS = intEnv('PANEL_LOGIN_MAX_FAILS', 10);
const LOGIN_WINDOW_MS = intEnv('PANEL_LOGIN_WINDOW_MS', 5 * 60 * 1000);
// Блокировка адреса после исчерпания окна.
const LOGIN_LOCKOUT_MS = intEnv('PANEL_LOGIN_LOCKOUT_MS', 15 * 60 * 1000);
// Потолок одновременных проверок пароля: защищает пул от залпа запросов.
const LOGIN_MAX_CONCURRENT = intEnv('PANEL_LOGIN_MAX_CONCURRENT', 2);
// Искусственная задержка ответа при неудаче, мс.
const LOGIN_FAIL_DELAY_MS = intEnv('PANEL_LOGIN_FAIL_DELAY_MS', 500);
// Сколько держать результат УДАЧНОЙ проверки, мс (0 — выключить кэш).
// HTTP Basic перепроверяется на КАЖДЫЙ запрос, а загрузка страницы админки — это
// десятки запросов, каждый из которых раньше стоил полный scrypt. Кэш снимает
// нагрузку на пул потоков, который делится с реверс-прокси сайтов.
const VERIFY_TTL_MS = intEnv('PANEL_AUTH_CACHE_MS', 60000);
const VERIFY_CACHE_MAX = 512;

/** @type {Map<string, {fails: number, first: number, lockedUntil: number}>} */
const attempts = new Map();
let loginSlots = 0;

function intEnv(name, dflt) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function clientIp(req) {
  // X-Forwarded-For не используем: за панелью может стоять что угодно, а
  // доверенный прокси не выделен. Для локального реверс-прокси адрес и так ::1.
  const addr = (req.socket && req.socket.remoteAddress) || 'unknown';
  return String(addr).replace(/^::ffff:/, '');
}

function pruneAttempts(now) {
  for (const [ip, st] of attempts) {
    if (st.lockedUntil && st.lockedUntil > now) continue;
    if (now - st.first > LOGIN_WINDOW_MS) attempts.delete(ip);
  }
}

/** Сколько миллисекунд осталось до снятия блокировки (0 — не заблокирован). */
function lockoutLeft(ip, now = Date.now()) {
  const st = attempts.get(ip);
  if (!st || !st.lockedUntil) return 0;
  return st.lockedUntil > now ? st.lockedUntil - now : 0;
}

function registerFailure(ip, user) {
  const now = Date.now();
  pruneAttempts(now);
  const st = attempts.get(ip) || { fails: 0, first: now, lockedUntil: 0 };
  if (now - st.first > LOGIN_WINDOW_MS) {
    st.fails = 0;
    st.first = now;
  }
  st.fails++;
  if (LOGIN_MAX_FAILS > 0 && st.fails >= LOGIN_MAX_FAILS) {
    st.lockedUntil = now + LOGIN_LOCKOUT_MS;
    console.error(
      `[auth] вход заблокирован для ${ip} на ${Math.round(LOGIN_LOCKOUT_MS / 60000)} мин ` +
        `(неудачных попыток: ${st.fails}, логин: ${JSON.stringify(String(user)).slice(0, 60)})`
    );
  } else {
    console.error(
      `[auth] неудачная попытка входа с ${ip} (логин: ${JSON.stringify(String(user)).slice(0, 60)}, ` +
        `попытка ${st.fails} из ${LOGIN_MAX_FAILS})`
    );
  }
  attempts.set(ip, st);
}

function registerSuccess(ip) {
  if (attempts.delete(ip)) console.log(`[auth] успешный вход с ${ip}, счётчик неудач сброшен`);
}

/** Текущее состояние счётчиков — используется в тестах. */
function resetAttempts() {
  attempts.clear();
}

// --- Пароль --------------------------------------------------------------------

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Загрузка учётных данных.
 * @returns {boolean} true, если удалось загрузить или создать auth.json
 */
function load() {
  let text = null;
  try {
    text = fs.readFileSync(config.authFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Файл есть, но не читается (права, сбой ФС) — это авария, а не первый запуск.
      failHard(`auth.json не читается: ${err.code || err.message}`);
      return false;
    }
  }

  if (text === null) {
    createInitial(); // первый запуск
    return true;
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    failHard(`auth.json не разбирается как JSON: ${err.message}`, { corrupt: true });
    return false;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.user !== 'string' || !raw.user || typeof raw.hash !== 'string' || !/^[0-9a-f]+$/i.test(raw.hash)) {
    failHard('auth.json не содержит корректных полей user/hash', { corrupt: true });
    return false;
  }

  // Нормализация: в файл мог попасть не-строковый user (H-12) — тогда вход
  // ломается навсегда, потому что сравнение со строкой всегда ложно.
  if (raw.user !== raw.user.trim()) raw.user = raw.user.trim();
  // Параметры scrypt хранятся рядом с хешем. Файл без поля `params` считался по
  // дефолтным параметрам (N=16384) — их и подставляем: иначе пароль перестал бы
  // подходить сразу после обновления панели.
  const opts = paramsToOpts(raw.params) || DEFAULT_STORED_OPTS;
  if (raw.params !== undefined && !paramsToOpts(raw.params)) {
    console.error(`[auth] auth.json: некорректные params ${JSON.stringify(raw.params)} — проверка по прежним параметрам (N=${DEFAULT_STORED_OPTS.N})`);
  }
  auth = { user: raw.user, salt: String(raw.salt || ''), hash: raw.hash.toLowerCase(), opts };
  if (!raw.params) {
    // Файл старого формата: скажем об этом, потому что до первого удачного входа
    // он остаётся в «дефолтных» параметрах, а после — будет переписан с params.
    console.log('[auth] auth.json прежнего формата (без params): проверка по N=16384, хеш будет обновлён при первом успешном входе');
  }
  return true;
}

/** Авария с auth.json: отложить файл и запретить работу без явного решения. */
function failHard(reason, opts = {}) {
  auth = null;
  console.error('');
  console.error('  !!! Файл учётных данных (auth.json) повреждён — вход невозможен. !!!');
  console.error(`  Причина: ${reason}`);
  if (opts.corrupt) {
    const saved = `${config.authFile}.corrupt-${timestamp()}`;
    try {
      fs.renameSync(config.authFile, saved);
      console.error(`  Повреждённый файл сохранён: ${saved}`);
    } catch (err) {
      console.error(`  НЕ удалось сохранить повреждённый auth.json (${err.message}).`);
    }
  }
  console.error('  Новый пароль НЕ генерируется: иначе прежний доступ был бы потерян молча.');
  console.error('  Восстановите auth.json из резервной копии либо удалите его, чтобы');
  console.error('  панель создала новую учётную запись со случайным паролем.');
  console.error('');
}

function createInitial() {
  const password = crypto.randomBytes(9).toString('base64url');
  auth = { user: 'admin', ...hashPassword(password, undefined, SCRYPT_OPTS), opts: SCRYPT_OPTS };
  persist();
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────┐');
  console.log('  │  Учётные данные админ-панели (первый запуск):    │');
  console.log(`  │  Логин:  admin                                   │`);
  console.log(`  │  Пароль: ${password.padEnd(41)}│`);
  console.log('  │  Сохранены в data/auth.json                      │');
  console.log('  └──────────────────────────────────────────────────┘');
  console.log('');
}

// Параметры scrypt подняты к рекомендованным для интерактивного входа (N=2^15).
// Прежние N=16384 (2^14) — минимум по умолчанию; хеш, посчитанный с ними, никак не
// совпадёт с хешем по новым параметрам, поэтому прежние значения сохранены как
// LEGACY: иначе после обновления панели вход ломался бы на всех существующих
// стендах с сообщением «неверный пароль» при верном пароле.
const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const LEGACY_SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
// Параметры, с которыми считался хеш, лежащий в файле. Раньше в auth.json их не
// было вовсе, и подразумевались дефолтные — то есть ровно LEGACY.
const DEFAULT_STORED_OPTS = LEGACY_SCRYPT_OPTS;

/** Проекция параметров в форму, которая пишется в auth.json. */
function optsToParams(opts) {
  return { N: opts.N, r: opts.r, p: opts.p };
}

/**
 * Проверить и нормализовать params из auth.json.
 * Недоверенный (испорченный) файл не должен давать ни огромный N — это отказ в
 * обслуживании на каждом входе, — ни мусорные значения.
 * @returns {{N:number,r:number,p:number,maxmem:number}|null}
 */
function paramsToOpts(params) {
  if (!params || typeof params !== 'object') return null;
  const n = Number(params.N);
  const r = Number(params.r);
  const p = Number(params.p);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  // Границы: снизу минимально осмысленные, сверху — те, что мы сами применяем.
  if (n < 1024 || r < 1 || p < 1) return null;
  if (n > SCRYPT_OPTS.N || r > SCRYPT_OPTS.r || p > SCRYPT_OPTS.p) return null;
  if ((n & (n - 1)) !== 0) return null; // N обязан быть степенью двойки
  return { N: n, r, p, maxmem: 128 * 1024 * 1024 };
}

function hashPassword(password, salt, opts = SCRYPT_OPTS) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32, opts).toString('hex');
  return { salt, hash, params: optsToParams(opts) };
}

/** Асинхронный вариант: не блокирует event loop (A-01). */
function hashPasswordAsync(password, salt, opts = SCRYPT_OPTS) {
  return new Promise((resolve, reject) => {
    const s = salt || crypto.randomBytes(16).toString('hex');
    crypto.scrypt(String(password), s, 32, opts, (err, derived) => {
      if (err) return reject(err);
      resolve({ salt: s, hash: derived.toString('hex'), params: optsToParams(opts) });
    });
  });
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

/* ---------- Кэш успешных проверок ---------------------------------------------
 * Ключ — пара логин/пароль, значение — срок годности. Хранится только ХЭШ ключа:
 * держать пароль в памяти процесса незачем. Инвалидируется при смене пароля.
 */
const verifyCache = new Map();

function cacheKey(user, password) {
  return crypto.createHash('sha256').update(user).update('\0').update(password).digest('hex');
}

function invalidateVerifyCache() {
  verifyCache.clear();
}

function verifyCacheGet(user, password) {
  if (VERIFY_TTL_MS <= 0) return null;
  const key = cacheKey(user, password);
  const until = verifyCache.get(key);
  if (!until) return null;
  if (until < Date.now()) {
    verifyCache.delete(key);
    return null;
  }
  return key;
}

function verifyCacheSet(user, password) {
  if (VERIFY_TTL_MS <= 0) return;
  const key = cacheKey(user, password);
  // Простейшее вытеснение: Map сохраняет порядок вставки, чистим самые старые.
  if (verifyCache.size >= VERIFY_CACHE_MAX) {
    const oldest = verifyCache.keys().next().value;
    if (oldest !== undefined) verifyCache.delete(oldest);
  }
  verifyCache.set(key, Date.now() + VERIFY_TTL_MS);
}

/**
 * Проверка учётных данных. Асинхронная — см. пункт 2 в шапке файла.
 * @returns {Promise<boolean>}
 */
async function checkCredentials(user, password) {
  if (!auth) return false;
  if (typeof user !== 'string' || typeof password !== 'string') return false;

  // Успешная проверка кэшируется: Basic-схема заставляет перепроверять пароль на
  // каждый статический файл админки, а scrypt занимает потоки пула, которые
  // нужны реверс-прокси сайтов (A-01).
  const cached = verifyCacheGet(user, password);
  if (cached) return true;

  if (user !== auth.user) {
    // Всё равно тратим время на scrypt: иначе существование логина видно по
    // времени ответа, а scrypt защищает и от исчерпания CPU (A-01).
    await hashPasswordAsync(password, auth.salt, auth.opts).catch(() => null);
    return false;
  }
  const { hash } = await hashPasswordAsync(password, auth.salt, auth.opts);
  const ok = safeEqualHex(hash, auth.hash);
  if (ok) {
    verifyCacheSet(user, password);
    upgradeHashIfNeeded(password);
  }
  return ok;
}

/**
 * Обновить хеш до текущих параметров scrypt, если он посчитан по прежним.
 * Делается только после УСПЕШНОЙ проверки — пароль в этот момент известен, и
 * пересчитать хеш можно, не спрашивая его у пользователя. Ошибка записи не должна
 * ломать вход: старый хеш продолжает работать, а попытка повторится позже.
 */
function upgradeHashIfNeeded(password) {
  if (!auth || !auth.opts) return;
  const cur = auth.opts;
  if (cur.N >= SCRYPT_OPTS.N && cur.r >= SCRYPT_OPTS.r && cur.p >= SCRYPT_OPTS.p) return;
  try {
    // Соль сохраняем прежнюю: менять её незачем, а лишняя случайность здесь
    // только усложнила бы разбор инцидентов.
    const fresh = hashPassword(password, auth.salt, SCRYPT_OPTS);
    const wasN = cur.N;
    auth = { user: auth.user, salt: fresh.salt, hash: fresh.hash, opts: SCRYPT_OPTS };
    invalidateVerifyCache();
    verifyCacheSet(auth.user, password);
    persist();
    console.log(`[auth] хеш пароля обновлён до N=${SCRYPT_OPTS.N} (был N=${wasN})`);
  } catch (err) {
    console.error(`[auth] не удалось обновить хеш пароля (вход по-прежнему работает): ${err.message}`);
  }
}

/**
 * Смена логина/пароля.
 * @param {string} newUser новый логин (пустой — оставить прежний)
 * @param {string} password новый пароль
 * @throws {Error} с code='INVALID_USER' | 'INVALID_PASSWORD' — их обрабатывает маршрут
 */
function changePassword(newUser, password) {
  if (!auth) {
    const err = new Error('Учётные данные не загружены — смена пароля невозможна');
    err.code = 'NO_AUTH';
    throw err;
  }
  if (typeof password !== 'string' || password.length < 8) {
    const err = new Error('Пароль должен быть не короче 8 символов');
    err.code = 'INVALID_PASSWORD';
    throw err;
  }
  let user = auth.user;
  if (newUser !== undefined && newUser !== null && newUser !== '') {
    if (typeof newUser !== 'string') {
      const err = new Error('Логин должен быть строкой');
      err.code = 'INVALID_USER';
      throw err;
    }
    user = newUser.trim();
    if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(user)) {
      const err = new Error('Логин может содержать только латиницу, цифры и . _ @ -');
      err.code = 'INVALID_USER';
      throw err;
    }
  }
  // `opts` хранится в памяти отдельно от `params` в файле: первое — рабочие
  // параметры scrypt, второе — их проекция для записи.
  auth = { user, ...hashPassword(password, undefined, SCRYPT_OPTS), opts: SCRYPT_OPTS };
  // Прежние успешные проверки больше не действительны.
  invalidateVerifyCache();
  persist();
  console.log(`[auth] пароль изменён (логин: ${JSON.stringify(user)})`);
  return { user };
}

/**
 * Записать auth.json. В файл идёт только то, что нужно для проверки пароля:
 * рабочие параметры с `maxmem` — деталь реализации, в хранилище им не место.
 */
function persist() {
  secure.writePrivate(
    config.authFile,
    JSON.stringify({ user: auth.user, salt: auth.salt, hash: auth.hash, params: optsToParams(auth.opts || SCRYPT_OPTS) }, null, 2)
  );
}

/** Проверка формы логина (для маршрутов и нормализации). */
function normalizeUser(user) {
  if (typeof user !== 'string') return null;
  const u = user.trim();
  if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(u)) return null;
  return u;
}

/** Разбор заголовка Basic: режем по ПЕРВОМУ ':' — пароль может содержать ':'. */
function parseBasic(header) {
  const m = /^Basic\s+(.+)$/i.exec(String(header || '').trim());
  if (!m) return null;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null; // кривой Basic без ':' → 401, а не 500 (H-11)
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Express-middleware. PANEL_NO_AUTH=1 отключает проверку — для случаев,
 * когда авторизацию выполняет внешний реверс-прокси.
 */
function middleware(req, res, next) {
  if (process.env.PANEL_NO_AUTH === '1') return next();

  const ip = clientIp(req);
  const left = lockoutLeft(ip);
  if (left > 0) {
    res.setHeader('Retry-After', String(Math.ceil(left / 1000)));
    return deny(res, req, `Слишком много неудачных попыток входа. Повторите через ${Math.ceil(left / 60000)} мин.`);
  }

  const parsed = parseBasic(req.headers.authorization);
  if (!parsed) return deny(res, req);

  // Ограничиваем число одновременных проверок: scrypt дорог, а запросов может
  // быть сколько угодно. Лишние ждут очереди, а не забивают пул libuv.
  const run = async () => {
    loginSlots++;
    try {
      const ok = await checkCredentials(parsed.user, parsed.pass);
      if (ok) {
        registerSuccess(ip);
        return next();
      }
      registerFailure(ip, parsed.user);
      if (LOGIN_FAIL_DELAY_MS > 0) await sleep(LOGIN_FAIL_DELAY_MS);
      return deny(res, req);
    } catch (err) {
      console.error('[auth] ошибка проверки учётных данных:', err.message);
      return deny(res, req);
    } finally {
      loginSlots--;
    }
  };

  if (LOGIN_MAX_CONCURRENT > 0 && loginSlots >= LOGIN_MAX_CONCURRENT) {
    // Подождать освобождения места, но не бесконечно.
    const deadline = Date.now() + 5000;
    const wait = () => {
      if (loginSlots < LOGIN_MAX_CONCURRENT) return run();
      if (Date.now() > deadline) {
        res.setHeader('Retry-After', '2');
        return deny(res, req, 'Сервер занят проверкой учётных данных, повторите запрос.');
      }
      return sleep(25).then(wait);
    };
    return wait();
  }
  return run();
}

function deny(res, req, message) {
  if (res.headersSent || res.writableEnded) return;
  res.setHeader('WWW-Authenticate', 'Basic realm="SitePanel", charset="UTF-8"');
  // Ответ-отказ не должен кэшироваться: иначе браузер или посредник могут
  // закрепить 401 для статики и сломать вход после ввода пароля.
  res.setHeader('Cache-Control', 'no-store');
  res.status(401).json({ error: message || 'Требуется авторизация' });
}

function getUser() {
  return auth ? auth.user : 'admin';
}

/** true, если учётные данные загружены. */
function isReady() {
  return !!auth;
}

module.exports = {
  load,
  middleware,
  checkCredentials,
  changePassword,
  getUser,
  hashPassword,
  hashPasswordAsync,
  parseBasic,
  normalizeUser,
  lockoutLeft,
  resetAttempts,
  isReady,
};
