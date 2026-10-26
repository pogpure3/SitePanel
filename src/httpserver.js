'use strict';

// Реверс-прокси: порты 80/443, маршрутизация по Host,
// раздача ACME http-01 challenge, статика и проксирование на node-процессы.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const httpProxy = require('http-proxy');
const { config } = require('./config');
const store = require('./store');
const certs = require('./ssl/certs');
const acme = require('./ssl/acme');
const manager = require('./sites/manager');
const auth = require('./auth');

const PORTAL_FRAME_ORIGINS = new Map([
  ['panel.evil-mesh.ru', 'https://prtl.evil-mesh.ru'],
  ['pqr.evil-mesh.ru', 'https://prtl.evil-mesh.ru'],
  ['apitest.evil-mesh.ru', 'https://prtl.evil-mesh.ru'],
  ['beget.evil-mesh.ru', 'https://portal.evil-mesh.ru'],
  ['pg.evil-mesh.ru', 'https://portal.evil-mesh.ru'],
  ['p.evil-mesh.ru', 'https://portal.evil-mesh.ru'],
  ['pfapi.evil-mesh.ru', 'https://portal.evil-mesh.ru'],
  ['m.evil-mesh.ru', 'https://portal.evil-mesh.ru'],
]);

// Таймаут обязателен: без него зависший апстрим (приложение сайта приняло
// соединение и не отвечает) держал сокет и дескрипторы до бесконечности, а клиент
// не получал ни ответа, ни обрыва (H-06). Используется ИМЕННО `proxyTimeout`:
// в http-proxy он вешает таймаут на запрос К АПСТРИМУ и при срабатывании
// абортит его, поэтому ошибка доходит до обработчика ниже и клиент получает
// внятную страницу 502. Опция `timeout` делает `req.socket.setTimeout()` на
// сокете КЛИЕНТА: по истечении Node уничтожает соединение, и клиент видит голый
// ECONNRESET вместо ошибки (проверено пробой на сервере: proxyTimeout → 502 за
// 3.0 с; timeout → ECONNRESET за 3.0 с; оба → ECONNRESET). От медленных
// клиентов защищают headersTimeout/requestTimeout самого Node.
const proxy = httpProxy.createProxyServer({
  xfwd: true,
  proxyTimeout: config.proxyTimeoutMs,
});

proxy.on('error', (err, req, res) => {
  if (!res || res.headersSent) return;
  if (res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('502 — приложение не отвечает', 'Сайт запущен, но приложение не отвечает на внутреннем порту.'));
  }
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
};

// Экранирование подстановок в HTML. Заглушки отдаются БЕЗ авторизации и
// достижимы из интернета, а в них попадают подконтрольные запросу значения
// (Host, декодированный путь, имя сайта). Без экранирования это отражённый XSS
// на домене размещённого сайта (H-01).
function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Имя хоста из заголовка Host.
 * Учитывает IPv6-литерал: у `[::1]:8443` прежний `split(':')[0]` давал `'['`,
 * из-за чего запрос по IPv6 не находил сайт (H-02).
 */
function hostOf(req) {
  const raw = ((req.headers.host || '').split(',')[0] || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end < 0 ? raw : raw.slice(1, end);
  }
  const colon = raw.indexOf(':');
  const host = colon < 0 ? raw : raw.slice(0, colon);
  // Отвергаем всё, что не похоже на имя хоста или IP: заголовок управляется
  // клиентом, а его значение уходит в разметку и в Location.
  return /^[a-z0-9._-]+$/.test(host) ? host : '';
}

/* ---------- HTTP responses ---------- */

function page(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.card{text-align:center;max-width:560px;padding:2rem}h1{font-size:1.5rem;font-weight:600}p{color:#94a3b8;line-height:1.6}
a{color:#60a5fa}</style></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${body}</p></div></body></html>`;
}

function sendPlaceholder(res, code, title, body, extraHeaders) {
  // no-store: заглушки (404/403/503) не должны кэшироваться посредниками —
  // иначе временный сбой «прилипает» и скрывает настоящий контент.
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // Заглушки — тоже ответ сайта: запрещаем браузеру «угадывать» тип.
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': STUB_CSP,
    ...(extraHeaders || {}),
  });
  res.end(page(title, body));
}

/** Заглушка со строковым сообщением (значение экранируется). */
function sendPlaceholderText(res, code, title, text, extraHeaders) {
  return sendPlaceholder(res, code, title, esc(text), extraHeaders);
}

// CSP для заглушек. Заглушки отдаются сырым http-сервером, мимо Express-мидлвари
// админки, поэтому раньше шли вообще без CSP — а в них отражаются значения из
// запроса, то есть отсутствие CSP усиливало XSS (H-01, H-13). Инлайновые стили
// нужны: разметка заглушек содержит <style>.
const STUB_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

/**
 * Сколько секунд просить клиента подождать во время деплоя.
 * Обещать «через секунду» нельзя (деплой — это установка зависимостей и сборка),
 * но и держать клиента за минуту на быстром деплое незачем.
 */
function retryAfterSeconds(state) {
  const since = state && Number(state.since) ? Number(state.since) : Date.now();
  const elapsed = Math.max(0, Date.now() - since);
  return Math.max(5, Math.min(60, Math.ceil(elapsed / 1000) + 5));
}


/* ---------- Маршрутизация ---------- */

// Пути, которые не должны раздаваться даже если лежат в каталоге сайта:
//   .env, .git/**, .htaccess и прочие dot-файлы (секреты и служебные данные),
//   node_modules (после npm install попадает в корень и не является контентом).
// Проверка идёт по сегментам URL, а не по «начинается с точки» у всего пути.
const BLOCKED_SEGMENTS = new Set(['node_modules']);

function isBlockedPath(urlPath) {
  const segs = String(urlPath || '').replace(/\\/g, '/').split('/');
  return segs.some((s) => s && (s.startsWith('.') || BLOCKED_SEGMENTS.has(s.toLowerCase())));
}

function serveStatic(site, req, res) {
  // Тот же диагностический заголовок, что у node-сайтов (H-10).
  res.setHeader('X-Sitepanel-Site', site.id);
  const root = manager.siteDir(site);
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return sendPlaceholder(res, 400, '400 — неверный запрос', 'Некорректный URL.');
  }
  if (isBlockedPath(urlPath)) {
    // Отвечаем как «не найдено», чтобы не подтверждать наличие секретных файлов.
    return sendPlaceholderText(res, 404, '404 — не найдено', `Файл не найден: ${urlPath}`);
  }
  let filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    return sendPlaceholder(res, 403, '403 — доступ запрещён', 'Путь вне каталога сайта.');
  }
  // Симлинк внутри каталога может вести наружу (на .env соседа или /etc/passwd):
  // лексической проверки префикса мало, сверяем РЕАЛЬНЫЙ путь (H-03).
  const real = realInside(root, filePath);
  if (!real) {
    return sendPlaceholder(res, 403, '403 — доступ запрещён', 'Путь вне каталога сайта.');
  }
  filePath = real;
  let stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  }
  if (!stat) {
    return sendPlaceholderText(res, 404, '404 — не найдено', `Файл не найден: ${urlPath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  const isAsset = ext !== '.html' && ext !== '.htm';
  const type = MIME[ext] || 'application/octet-stream';
  const cacheControl = isAsset ? 'public, max-age=3600' : 'no-cache';

  // Условные запросы (H-08): ETag из размера и mtime, Last-Modified с точностью
  // HTTP-дат (1 с). Без них каждый визит качал файл целиком, даже неизменившийся.
  const etag = '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
  const lastModified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString();
  const baseHeaders = {
    'Content-Type': type,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    ETag: etag,
    'Last-Modified': lastModified,
    'Accept-Ranges': 'none',
  };
  if (notModified(req, etag, stat.mtimeMs)) {
    res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': cacheControl });
    return res.end();
  }

  // Сжатие на лету для текстовых типов (H-08). Мелкие файлы не сжимаем —
  // накладные расходы больше выигрыша; большие — не сжимаем, чтобы один
  // запрос не сжигал CPU на многометровом архиве.
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  const compressible = /^(text\/|application\/(json|xml|javascript))/i.test(type) || type.includes('svg');
  const doGzip = compressible
    && stat.size >= 1024
    && stat.size <= 8 * 1024 * 1024
    && /(^|,)\s*(gzip|\*)/i.test(acceptEncoding);

  if (doGzip) {
    res.writeHead(200, {
      ...baseHeaders,
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
    });
    const rs = fs.createReadStream(filePath);
    const gz = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });
    rs.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      if (err.code === 'ENOENT') return sendPlaceholder(res, 404, '404 — не найдено', 'Файл не найден.');
      sendPlaceholder(res, 500, '500 — ошибка', 'Не удалось прочитать файл.');
    });
    gz.on('error', () => { try { res.destroy(); } catch { /* уже закрыт */ } });
    rs.pipe(gz).pipe(res);
    return;
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
  const rs = fs.createReadStream(filePath);
  // Без обработчика 'error' исчезновение файла между statSync и чтением (деплой
  // переименовывает каталог сайта) давало uncaughtException и запрос без ответа.
  rs.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    if (err.code === 'ENOENT') return sendPlaceholder(res, 404, '404 — не найдено', 'Файл не найден.');
    sendPlaceholder(res, 500, '500 — ошибка', 'Не удалось прочитать файл.');
  });
  rs.pipe(res);
}

/**
 * Проверка условного запроса: If-None-Match (список тегов, W/-префикс игнорируется)
 * или If-Modified-Since, если ETag-заголовка нет.
 */
function notModified(req, etag, mtimeMs) {
  const inm = req.headers['if-none-match'];
  if (inm !== undefined) {
    const tags = String(inm).split(',').map((s) => s.trim().replace(/^W\//i, ''));
    return tags.includes(etag) || tags.includes('*');
  }
  const ims = req.headers['if-modified-since'];
  if (ims === undefined) return false;
  const since = Date.parse(String(ims));
  if (!Number.isFinite(since)) return false;
  // HTTP-даты хранят время с точностью до секунды — сравниваем в тех же единицах.
  return Math.floor(mtimeMs / 1000) * 1000 <= since;
}

/**
 * Реальный путь внутри каталога, или null.
 * `fs.realpathSync` разворачивает симлинки; для ещё не существующего файла
 * разворачиваем ближайший существующий родитель.
 */
function realInside(root, target) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  let probe = target;
  let real;
  while (true) {
    try {
      real = fs.realpathSync(probe);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  return target;
}

/**
 * Заголовки безопасности для трафика сайтов (H-13). Раньше они ставились только
 * Express-мидлварёй админки: сырые http-серверы прокси вызывали route() напрямую,
 * и каждый размещённый сайт шёл без nosniff/X-Frame-Options — встраиваемым в
 * iframe (кликджекинг) и подверженным MIME-sniffing, а заглушки — ещё и без CSP.
 */
function portalFrameOrigin(host) {
  return PORTAL_FRAME_ORIGINS.get(host) || null;
}

function applySiteSecurityHeaders(res, effectiveHttps, host) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const frameOrigin = portalFrameOrigin(host);
  if (frameOrigin) {
    // X-Frame-Options не умеет безопасно разрешить другой origin. CSP задаёт
    // единственного разрешённого предка вместо снятия защиты целиком.
    res.setHeader('Content-Security-Policy', `frame-ancestors ${frameOrigin}`);
  } else {
    // SAMEORIGIN отсекает чужие origin (кликджекинг), но не ломает фрейминг
    // сайта на его же домене.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (effectiveHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

/**
 * Можно ли верить X-Forwarded-* из этого соединения (H-07). Заголовок управляется
 * клиентом: попав напрямую на HTTP-порт, attacker заголовком X-Forwarded-Proto:
 * https гасил редирект на HTTPS и влиял на HSTS. По умолчанию доверяем только
 * loopback (nginx на той же машине); PANEL_TRUST_PROXY со списком адресов
 * ЗАМЕНЯЕТ умолчание (loopback туда нужно вписать явно), '*' доверяет всем.
 */
function trustedForwarder(req) {
  const ra = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (config.trustProxy === 'all') return true;
  if (Array.isArray(config.trustProxy) && config.trustProxy.length > 0) {
    return config.trustProxy.includes(ra);
  }
  return ra === '127.0.0.1' || ra === '::1';
}

/**
 * Схема запроса с учётом реверс-прокси: TLS терминирует nginx, поэтому схема
 * приходит в X-Forwarded-Proto — но только от доверенного источника (H-07).
 */
function effectiveScheme(req, isHttps) {
  if (isHttps) return 'https';
  if (!trustedForwarder(req)) return 'http';
  const xfp = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return xfp === 'https' ? 'https' : 'http';
}

/**
 * Убирает из запроса значения X-Forwarded-*, пришедшие от клиента: http-proxy
 * с xfwd ДОПИСЫВАЕТ к существующим значениям (web-incoming.js:82-85), и
 * подделанное «9.9.9.9» оставалось первым в списке. После очистки xfwd собирает
 * заголовки заново из реального сокета. X-Forwarded-Host xfwd не трогает —
 * ставим сами из проверенного hostOf (H-14).
 *
 * Если включён PANEL_FORWARD_CLIENT_IP и соединение пришло от доверенного
 * фронт-прокси, берём последний адрес его X-Forwarded-For — это клиент —
 * и передаём приложению (x-forwarded-for и x-real-ip). Иначе за nginx все
 * запросы выглядели бы как 127.0.0.1 и IP-whitelist приложений не работал бы.
 */
function sanitizeForwardHeaders(req, host) {
  const incomingXff = typeof req.headers['x-forwarded-for'] === 'string'
    ? req.headers['x-forwarded-for']
    : '';
  for (const key of Object.keys(req.headers)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('x-forwarded-') || lower === 'x-real-ip') delete req.headers[key];
  }
  if (host) req.headers['x-forwarded-host'] = host;

  if (config.forwardClientIp && incomingXff && trustedForwarder(req)) {
    const hops = incomingXff.split(',').map((s) => s.trim()).filter(Boolean);
    const client = hops.length ? hops[hops.length - 1] : '';
    if (client) {
      // xfwd допишет адрес сокета в конец; приложение берёт первый адрес
      req.headers['x-forwarded-for'] = client;
      req.headers['x-real-ip'] = client;
    }
  }
}

/**
 * Убирает учётные данные ПАНЕЛИ из запроса к сайту (H-14): браузер, закэшировавший
 * Basic панели для хоста, отправляет их и приложениям сайтов — любой размещённый
 * код собрал бы пароль панели. Сайты со СВОЕЙ Basic-авторизацией (MeshCentral)
 * получают чужой заголовок как есть: он не совпадает с учёткой панели.
 */
async function stripPanelAuthorization(req) {
  const header = req.headers.authorization;
  if (!header) return;
  const parsed = auth.parseBasic(header);
  if (!parsed) return;
  try {
    if (await auth.checkCredentials(parsed.user, parsed.pass)) delete req.headers.authorization;
  } catch { /* не учётка панели — уходит в сайт как есть */ }
}

function proxyToNode(site, req, res, host) {
  res.setHeader('X-Sitepanel-Site', site.id);
  const port = Number(site.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    // Порт не выделен/потерян (битый db.json): прокси на `null` не отдаёт ни
    // ошибки, ни ответа, и запрос висит вечно (P-14).
    return sendPlaceholder(res, 503, '503 — сайт недоступен', 'Внутренний порт сайта не задан. Переразверните сайт.');
  }
  sanitizeForwardHeaders(req, host);
  stripPanelAuthorization(req)
    .catch(() => {})
    .then(() => {
      proxy.web(req, res, { target: `http://127.0.0.1:${port}` }, (err) => {
        // Страховка на случай, если ошибка не дошла до общего обработчика.
        if (!err || !res || res.headersSent) return;
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('502 — приложение не отвечает', 'Сайт запущен, но приложение не отвечает на внутреннем порту.'));
      });
    });
}

function handleRequest(req, res, isHttps) {
  try {
    return route(req, res, isHttps);
  } catch (err) {
    // Сырой http-листенер: исключение здесь раньше оставляло клиента без ответа
    // и подвешивало сокет навсегда (SP-07).
    console.error('[httpserver] ошибка обработки запроса:', err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      try {
        sendPlaceholder(res, 500, '500 — ошибка панели', 'Внутренняя ошибка при обработке запроса.');
      } catch {
        /* сокет уже закрыт */
      }
    } else {
      try { res.destroy(); } catch { /* уже закрыт */ }
    }
    return undefined;
  }
}

function route(req, res, isHttps) {
  const host = hostOf(req);
  const url = req.url || '/';

  // TRACE на публичном прокси не имеет легитимного применения и примыкает к
  // классу smuggling-атак — отвечаем отказом до маршрутизации (H-10). OPTIONS
  // не трогаем: CORS-preflight — легитимный сценарий размещённых приложений,
  // он уходит в приложение как обычный запрос.
  if (req.method === 'TRACE') {
    return sendPlaceholder(res, 405, '405 — метод не поддержан', 'Метод TRACE не поддерживается.', {
      Allow: 'GET, HEAD, POST, PUT, PATCH, DELETE',
    });
  }

  // За реверс-прокси (nginx) TLS уже терминирован — схема приходит в
  // X-Forwarded-Proto, но верим ему только от доверенного источника (H-07):
  // клиент, попавший напрямую на HTTP-порт, раньше этим заголовком гасил
  // редирект на HTTPS и влиял на HSTS.
  const effectiveHttps = effectiveScheme(req, isHttps) === 'https';
  applySiteSecurityHeaders(res, effectiveHttps, host);

  // ACME http-01 challenge — приоритетнее всего, схема не важна
  // (через прокси challenge может прийти уже по https).
  const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(url);
  if (m) {
    const token = m[1];
    // Challenge отдаётся только на том домене, для которого выпускается
    // сертификат: раньше токен отдавался на ЛЮБОМ Host (H-04).
    const payload = acme.getChallenge(host, token);
    if (payload) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(payload);
    }
    res.writeHead(404);
    return res.end('challenge not found');
  }

  const site = store.getSiteByDomain(host);

  if (!site) {
    return sendPlaceholder(res, 404, 'Домен не настроен',
      `Панель SitePanel работает, но домен <b>${esc(host || '?')}</b> не привязан ни к одному сайту.<br>Настройте привязку в админ-панели.`);
  }

  if (site.status !== 'running') {
    // Деплой на время останавливает сайт. Раньше клиент получал 503 без единой
    // подсказки, что это временно и когда повторить: для посетителя «идёт
    // обновление» и «сайт выключен» выглядели одинаково (P-31).
    const dep = manager.deployState(site);
    if (dep) {
      const retry = retryAfterSeconds(dep);
      return sendPlaceholderText(res, 503, 'Сайт обновляется',
        `Сайт «${site.name}» сейчас обновляется (${dep.what}). Повторите запрос через ${retry} с.`,
        { 'Retry-After': String(retry) });
    }
    return sendPlaceholderText(res, 503, 'Сайт отключён',
      `Сайт «${site.name}» сейчас остановлен (статус: ${site.status}).`);
  }

  // Перенаправление на HTTPS только если запрос реально пришёл по http
  // напрямую в панель (не через TLS-терминирующий прокси).
  if (!effectiveHttps && site.ssl && site.ssl.status === 'active') {
    // Домен берём ИЗ РЕЕСТРА, а не из заголовка Host: иначе открытый редирект
    // на произвольный хост с валидным сертификатом панели (фишинг) — H-02.
    const target = (Array.isArray(site.domains) && site.domains.find((d) => !d.startsWith('*.'))) || host;
    if (!target) return sendPlaceholder(res, 400, '400 — неверный запрос', 'Не удалось определить домен для перенаправления.');
    const safeUrl = /^\/[^\s]*$/.test(url) ? url : '/';
    const portPart = config.httpsPort === 443 ? '' : ':' + config.httpsPort;
    res.writeHead(301, { Location: 'https://' + target + portPart + safeUrl });
    return res.end();
  }

  // docker-сайт проксируется как node: панель публикует контейнер на
  // 127.0.0.1:<site.port>. Падать в serveStatic нельзя — иначе каталог сайта
  // (Dockerfile, исходники, секреты build-контекста) утечёт как статика.
  if (site.type === 'node' || site.type === 'docker') return proxyToNode(site, req, res, host);
  return serveStatic(site, req, res);
}

/**
 * Проверка Origin на WebSocket-апгрейде (H-21): браузерный WS-кросс-запрос
 * всегда несёт Origin чужого сайта, поэтому апгрейд с посторонним Origin
 * разрушаем. Отсутствие Origin — не-браузерный клиент (инструменты, серверные
 * клиенты), пропускаем. Приложения всё равно обязаны проверять авторизацию
 * на своих WS-маршрутах: панель лишь отсекает заведомо кросс-сайтовые апгрейды.
 */
function originAllowed(originHeader, site, reqHost) {
  if (!originHeader) return true;
  let h;
  try {
    h = new URL(String(originHeader)).host.toLowerCase();
  } catch {
    return false;
  }
  const domains = Array.isArray(site.domains) ? site.domains : [];
  for (const d of domains) {
    const dd = String(d).toLowerCase();
    if (dd.startsWith('*.')) {
      const base = dd.slice(2);
      if (h === base || h.endsWith('.' + base)) return true;
    } else if (h === dd) {
      return true;
    }
  }
  return h === reqHost;
}

/* ---------- Серверы ---------- */

function createServers() {
  const httpServer = http.createServer((req, res) => handleRequest(req, res, false));

  // key/cert обязательны и помимо SNICallback: если клиент не прислал SNI
  // (обращение по IP, старый клиент, проверка из мониторинга), SNICallback не
  // вызывается вовсе, и без явного сертификата сервер обрывает рукопожатие
  // `TLS alert handshake failure` (alert 40) вместо того, чтобы показать
  // сертификат по умолчанию. Для сайтов со своим сертификатом работает SNICallback.
  const httpsServer = https.createServer(
    { SNICallback: certs.sniCallback, ...certs.defaultCertFiles() },
    (req, res) => handleRequest(req, res, true)
  );

  // Websockets -> в node-приложения и docker-контейнеры (публикуются одинаково:
  // 127.0.0.1:<site.port>).
  const routeUpgrade = (req, socket, head) => {
    const site = store.getSiteByDomain(hostOf(req));
    const port = site ? Number(site.port) : NaN;
    if (!site || (site.type !== 'node' && site.type !== 'docker') || site.status !== 'running' || !Number.isInteger(port) || port <= 0) {
      return socket.destroy();
    }
    // Кросс-сайтовый WS-апгрейд браузер помечает чужим Origin — не пускаем (H-21).
    if (!originAllowed(req.headers.origin, site, hostOf(req))) {
      return socket.destroy();
    }
    sanitizeForwardHeaders(req, hostOf(req));
    // H-14 и для WS: закэшированный Basic панели не должен уходить в сайт
    // (HTTP-путь чистит stripPanelAuthorization, апгрейд раньше пропускал).
    stripPanelAuthorization(req)
      .catch(() => {})
      .then(() => {
        proxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
      });
  };
  httpServer.on('upgrade', routeUpgrade);
  httpsServer.on('upgrade', routeUpgrade);

  return { httpServer, httpsServer };
}

function listenServers({ httpServer, httpsServer }) {
  return new Promise((resolve, reject) => {
    let pending = 2;
    let settled = false;
    const done = (err) => {
      if (settled) return;
      if (err) {
        settled = true;
        // Понятный текст вместо сырого стека: чаще всего порт занят прежним
        // экземпляром панели или nginx (SP-08).
        if (err && err.code === 'EADDRINUSE') {
          err.panelMessage = `Порт ${err.port || ''} уже занят другим процессом — остановите прежний экземпляр панели (systemctl status sitepanel) или задайте другой порт.`;
        }
        return reject(err);
      }
      if (--pending === 0) {
        settled = true;
        resolve();
      }
    };
    httpServer.once('error', done);
    httpsServer.once('error', done);
    httpServer.listen(config.httpPort, () => {
      console.log(`  HTTP  (реверс-прокси):  порт ${config.httpPort}`);
      done();
    });
    httpsServer.listen(config.httpsPort, () => {
      console.log(`  HTTPS (реверс-прокси):  порт ${config.httpsPort} (SNI)`);
      done();
    });
  });
}

/* ---------- Безопасность HTTP ---------- */

// CSP для админки: скрипты только внешним файлом (/app.js), инлайновых <script> нет.
// style-src допускает inline — разметка собирается строками со style="...".
// Manrope загружается с тех же двух Google Fonts origin, что и API прокачки.
const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data: https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Заголовки безопасности для ответов админ-панели.
 * Схема определяется для HSTS: за TLS-терминирующим прокси учитываем
 * X-Forwarded-Proto — но только от доверенного источника (H-07).
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const frameOrigin = portalFrameOrigin(hostOf(req));
  if (!frameOrigin) res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', frameOrigin
    ? ADMIN_CSP.replace("frame-ancestors 'none'", `frame-ancestors ${frameOrigin}`)
    : ADMIN_CSP);
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (effectiveScheme(req, Boolean(req.secure)) === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  if (req.path.startsWith('/api')) {
    // Устаревшие клиенты не должны кэшировать ответы со статусами сайтов.
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

module.exports = {
  createServers,
  listenServers,
  securityHeaders,
  isBlockedPath,
  hostOf,
  esc,
  page,
  realInside,
  originAllowed,
  effectiveScheme,
};

