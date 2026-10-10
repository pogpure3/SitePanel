'use strict';

// Реверс-прокси: порты 80/443, маршрутизация по Host,
// раздача ACME http-01 challenge, статика и проксирование на node-процессы.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const httpProxy = require('http-proxy');
const { config } = require('./config');
const store = require('./store');
const certs = require('./ssl/certs');
const acme = require('./ssl/acme');
const manager = require('./sites/manager');

const proxy = httpProxy.createProxyServer({ xfwd: true });

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

function hostOf(req) {
  return ((req.headers.host || '').split(',')[0] || '').trim().toLowerCase().split(':')[0];
}

/* ---------- HTTP responses ---------- */

function page(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.card{text-align:center;max-width:560px;padding:2rem}h1{font-size:1.5rem;font-weight:600}p{color:#94a3b8;line-height:1.6}
a{color:#60a5fa}</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

function sendPlaceholder(res, code, title, body) {
  // no-store: заглушки (404/403/503) не должны кэшироваться посредниками —
  // иначе временный сбой «прилипает» и скрывает настоящий контент.
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(page(title, body));
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
  const root = manager.siteDir(site);
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return sendPlaceholder(res, 400, '400 — неверный запрос', 'Некорректный URL.');
  }
  if (isBlockedPath(urlPath)) {
    // Отвечаем как «не найдено», чтобы не подтверждать наличие секретных файлов.
    return sendPlaceholder(res, 404, '404 — не найдено', `Файл не найден: ${urlPath}`);
  }
  let filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    return sendPlaceholder(res, 403, '403 — доступ запрещён', 'Путь вне каталога сайта.');
  }
  let stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  }
  if (!stat) {
    return sendPlaceholder(res, 404, '404 — не найдено', `Файл не найден: ${urlPath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  const isAsset = ext !== '.html' && ext !== '.htm';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isAsset ? 'public, max-age=3600' : 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
}

function proxyToNode(site, req, res) {
  res.setHeader('X-Sitepanel-Site', site.id);
  proxy.web(req, res, { target: `http://127.0.0.1:${site.port}` });
}

function handleRequest(req, res, isHttps) {
  const host = hostOf(req);
  const url = req.url || '/';

  // За реверс-прокси (nginx) TLS уже терминирован — учитываем X-Forwarded-Proto.
  const xfp = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const effectiveHttps = isHttps || xfp === 'https';

  // ACME http-01 challenge — приоритетнее всего, схема не важна
  // (через прокси challenge может прийти уже по https).
  const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(url);
  if (m) {
    const token = m[1];
    const payload = acme.getChallenge(token);
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
      `Панель SitePanel работает, но домен <b>${host || '?'}</b> не привязан ни к одному сайту.<br>Настройте привязку в админ-панели.`);
  }

  if (site.status !== 'running') {
    return sendPlaceholder(res, 503, 'Сайт отключён',
      `Сайт «${site.name}» сейчас остановлен (статус: ${site.status}).`);
  }

  // Перенаправление на HTTPS только если запрос реально пришёл по http
  // напрямую в панель (не через TLS-терминирующий прокси).
  if (!effectiveHttps && site.ssl && site.ssl.status === 'active') {
    // Host может содержать нестандартный порт HTTP — для HTTPS подставляем свой.
    const hostName = (req.headers.host || host).split(':')[0] || host;
    const portPart = config.httpsPort === 443 ? '' : ':' + config.httpsPort;
    res.writeHead(301, { Location: 'https://' + hostName + portPart + url });
    return res.end();
  }

  if (site.type === 'node') return proxyToNode(site, req, res);
  return serveStatic(site, req, res);
}

/* ---------- Серверы ---------- */

function createServers() {
  const httpServer = http.createServer((req, res) => handleRequest(req, res, false));

  const httpsServer = https.createServer(
    { SNICallback: certs.sniCallback },
    (req, res) => handleRequest(req, res, true)
  );

  // Websockets -> в node-приложения.
  const routeUpgrade = (req, socket, head) => {
    const site = store.getSiteByDomain(hostOf(req));
    if (site && site.type === 'node' && site.status === 'running') {
      proxy.ws(req, socket, head, { target: `http://127.0.0.1:${site.port}` });
    } else {
      socket.destroy();
    }
  };
  httpServer.on('upgrade', routeUpgrade);
  httpsServer.on('upgrade', routeUpgrade);

  return { httpServer, httpsServer };
}

function listenServers({ httpServer, httpsServer }) {
  return new Promise((resolve, reject) => {
    let pending = 2;
    const done = (err) => {
      if (err) return reject(err);
      if (--pending === 0) resolve();
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
const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Заголовки безопасности для ответов админ-панели.
 * Схема определяется для HSTS: за TLS-терминирующим прокси учитываем
 * X-Forwarded-Proto, иначе HSTS по http игнорируется браузером и смысла не имеет.
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', ADMIN_CSP);
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Панель может быть проксирована с TLS — тогда включаем HSTS.
  const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (req.secure || xfp === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  if (req.path.startsWith('/api')) {
    // Устаревшие клиенты не должны кэшировать ответы со статусами сайтов.
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

module.exports = { createServers, listenServers, securityHeaders, isBlockedPath, hostOf };

