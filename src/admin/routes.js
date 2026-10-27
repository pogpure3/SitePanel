'use strict';

// REST API админ-панели.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const os = require('os');
const { config } = require('../config');
const store = require('../store');
const auth = require('../auth');
const manager = require('../sites/manager');
const backups = require('../sites/backups');
const certs = require('../ssl/certs');
const acme = require('../ssl/acme');
const monitor = require('../monitor');
const dashboard = require('../dashboard');
const alerts = require('../alerts');
const terminal = require('./terminal');
const runtimes = require('./runtimes');

const router = express.Router();
router.use(auth.middleware);

/**
 * Защита от CSRF (A-03). HTTP Basic браузер подставляет автоматически, поэтому
 * сторонняя страница может отправить POST на панель (simple request) — ответ
 * она не прочитает, но действие выполнится. Барьеров два:
 *  1) X-Requested-With: произвольный заголовок вынуждает preflight, а CORS
 *     в панели не разрешён — кросс-доменный fetch до обработчика не дойдёт;
 *  2) Origin/Referer, если браузер их прислал, обязаны совпадать с хостом
 *     панели; Sec-Fetch-Site: cross-site отклоняется всегда.
 * Запросы без Origin/Referer (curl, тесты, серверные клиенты) проходят по
 * заголовку X-Requested-With — браузерный кросс-сайтовый POST Origin пришлёт.
 */
const CSRF_HEADER = 'x-requested-with';

function sameHost(value, host) {
  try {
    return new URL(String(value)).host.toLowerCase() === String(host || '').toLowerCase();
  } catch {
    return false;
  }
}

function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.headers[CSRF_HEADER] !== 'XMLHttpRequest') {
    return res.status(403).json({
      error: 'Запрос отклонён: отсутствует заголовок X-Requested-With (защита от CSRF).',
    });
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !sameHost(origin, req.headers.host)) {
    return res.status(403).json({ error: 'Запрос отклонён: Origin не совпадает с адресом панели (защита от CSRF).' });
  }
  const referer = req.headers.referer;
  if (referer !== undefined && !sameHost(referer, req.headers.host)) {
    return res.status(403).json({ error: 'Запрос отклонён: Referer не совпадает с адресом панели (защита от CSRF).' });
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    return res.status(403).json({ error: 'Запрос отклонён: Sec-Fetch-Site: cross-site (защита от CSRF).' });
  }
  return next();
}
router.use(csrfGuard);

/* ---------- multipart ---------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: config.tmpDir,
    filename: (_req, file, cb) => cb(null, 'upload-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.zip'),
  }),
  limits: { fileSize: config.uploadMaxMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.zip') return cb(null, true);
    cb(new Error('Только .zip архивы'));
  },
});

// Загрузка произвольных файлов (файловый менеджер).
const uploadAny = multer({
  storage: multer.diskStorage({
    destination: config.tmpDir,
    filename: (_req, file, cb) => cb(null, 'fm-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function cleanupFile(file) {
  if (file && file.path) fs.rm(file.path, { force: true }, () => {});
}

function wrap(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (req.file) cleanupFile(req.file);
      res.status(err.status || 500).json({ error: err.message || String(err) });
    });
  };
}

function findSite(req) {
  const site = store.getSite(req.params.id);
  if (!site) {
    const err = new Error('Сайт не найден');
    err.status = 404;
    throw err;
  }
  return site;
}

function serializeSite(site, withStats = true) {
  const out = {
    id: site.id,
    name: site.name,
    type: site.type,
    status: site.status,
    domains: site.domains,
    port: site.port,
    autoStart: !!site.autoStart,
    noindex: !!site.noindex,
    hasBackup: !!site.hasBackup,
    gitUrl: site.gitUrl || null,
    gitBranch: site.gitBranch || null,
    gitSubdir: site.gitSubdir || null,
    ssl: site.ssl || { status: 'none' },
    backupSchedule: backups.scheduleOf(site),
    containerPort: site.containerPort || null,
    dockerFlavor: site.dockerFlavor || null,
    // health — телеметрия монитора из памяти, не поле записи (M-02).
    health: monitor.healthFor(site.id),
    // Диагностика цикла перезапусков: attempts — текущий бэкофф, crashLoop — лимит исчерпан.
    restartAttempts: site.restartAttempts || 0,
    restartCount: site.restartCount || 0,
    lastCrashAt: site.lastCrashAt || null,
    crashLoop: !!site.crashLoop,
    lastDeployWarning: site.lastDeployWarning || null,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
    running: manager.isRunning(site),
  };
  if (withStats && out.running) {
    return monitor.statsFor(site).then((stats) => ({ ...out, stats }));
  }
  return Promise.resolve(out);
}

/* ---------- Сайты ---------- */

router.get('/sites', wrap(async (_req, res) => {
  res.json(await Promise.all(store.state.sites.map((s) => serializeSite(s))));
}));

router.get('/sites/:id', wrap(async (req, res) => {
  const site = findSite(req);
  res.json({ ...(await serializeSite(site)), history: monitor.getHistory(site.id) });
}));

router.post('/sites', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Загрузите .zip архив с сайтом' });
  const name = slugify(req.body.name || path.basename(req.file.originalname, '.zip'));
  const id = crypto.randomBytes(6).toString('hex');

  const site = {
    id,
    name,
    type: 'static',
    status: 'stopped',
    domains: [],
    port: null,
    startCommand: null,
    autoStart: req.body.autoStart === 'true' || req.body.autoStart === '1',
    ssl: { provider: null, status: 'none' },
    // Расписание бэкапов: validateSite проставит дефолт только при чтении db.json,
    // поэтому у свежесозданного сайта поле нужно сразу (до перезапуска панели).
    backupSchedule: { ...backups.DEFAULT_SCHEDULE },
    containerPort: null,
    dockerFlavor: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.state.sites.push(site);
  try {
    await manager.deploy(site, req.file.path);
  } catch (err) {
    // Деплой не удался — не оставляем битую запись.
    store.state.sites = store.state.sites.filter((s) => s.id !== id);
    store.flush();
    cleanupFile(req.file);
    return res.status(400).json({ error: 'Деплой не удался: ' + err.message });
  }
  cleanupFile(req.file);
  store.flush();
  res.json(await serializeSite(site));
}));

router.post('/sites/git', wrap(async (req, res) => {
  const url = manager.validateGitUrl(req.body.url);
  const branch = manager.validateGitBranch(req.body.branch);
  const token = manager.validateGitToken(req.body.token);
  const subdir = manager.validateSubdir(req.body.subdir);
  const name = slugify(req.body.name || (subdir ? subdir.split('/').pop() : url.split('/').pop().replace(/\.git$/, '')));
  const id = crypto.randomBytes(6).toString('hex');

  const site = {
    id,
    name,
    type: 'static',
    status: 'stopped',
    domains: [],
    port: null,
    startCommand: null,
    autoStart: !!req.body.autoStart,
    ssl: { provider: null, status: 'none' },
    // Расписание бэкапов: validateSite проставит дефолт только при чтении db.json,
    // поэтому у свежесозданного сайта поле нужно сразу (до перезапуска панели).
    backupSchedule: { ...backups.DEFAULT_SCHEDULE },
    containerPort: null,
    dockerFlavor: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.state.sites.push(site);
  try {
    await manager.deployFromGit(site, { url, branch, token, subdir });
  } catch (err) {
    // Деплой не удался — не оставляем битую запись.
    store.state.sites = store.state.sites.filter((s) => s.id !== id);
    store.flush();
    return res.status(400).json({ error: 'Деплой из Git не удался: ' + err.message });
  }
  store.flush();
  res.json(await serializeSite(site));
}));

router.post('/sites/:id/update-git', wrap(async (req, res) => {
  const site = findSite(req);
  if (!site.gitUrl) return res.status(400).json({ error: 'Сайт не привязан к Git-репозиторию' });
  const result = await manager.deployFromGit(site, {
    url: req.body.url || site.gitUrl,
    branch: req.body.branch || site.gitBranch,
    token: req.body.token || site.gitToken,
    subdir: req.body.subdir !== undefined ? manager.validateSubdir(req.body.subdir) : site.gitSubdir,
  });
  res.json({ ok: !!(result && result.ok), result, site: await serializeSite(site) });
}));

router.post('/sites/:id/update', upload.single('file'), wrap(async (req, res) => {
  const site = findSite(req);
  if (!req.file) return res.status(400).json({ error: 'Загрузите .zip архив' });
  // deploy() не бросает при неудачном СТАРТЕ (архив уже распакован и, возможно,
  // выполнен откат) — результат нужно вернуть клиенту, а не терять.
  let result;
  try {
    result = await manager.deploy(site, req.file.path);
  } finally {
    cleanupFile(req.file);
  }
  res.json({ ok: !!(result && result.ok), result, site: await serializeSite(site) });
}));

router.post('/sites/:id/rollback', wrap(async (req, res) => {
  const site = findSite(req);
  const r = await Promise.resolve(manager.rollback(site));
  res.json({ ok: r.ok, ...r });
}));

router.post('/sites/:id/start', wrap(async (req, res) => {
  const site = findSite(req);
  res.json(await manager.start(site, { manual: true }));
}));

router.post('/sites/:id/stop', wrap(async (req, res) => {
  const site = findSite(req);
  res.json(await manager.stop(site));
}));

router.post('/sites/:id/restart', wrap(async (req, res) => {
  const site = findSite(req);
  res.json(await manager.restart(site));
}));

router.delete('/sites/:id', wrap(async (req, res) => {
  const site = findSite(req);
  await manager.removeSite(site);
  certs.removeCertFiles(site);
  // Бэкапы сайта переживать удаление не должны: сироты в data/backups/<id>
  // занимали бы диск вечно.
  try { backups.removeAll(site.id); } catch { /* уже нет — не критично */ }
  // История проверок и кэш статистики в памяти не должны переживать удаление (M-03).
  monitor.forgetSite(site.id);
  store.state.sites = store.state.sites.filter((s) => s.id !== site.id);
  store.flush();
  res.json({ ok: true });
}));

router.get('/sites/:id/logs', wrap(async (req, res) => {
  const site = findSite(req);
  const lines = Math.min(1000, parseInt(req.query.lines, 10) || 200);
  res.json({ log: manager.readLogTail(site, lines) });
}));

router.patch('/sites/:id', wrap(async (req, res) => {
  const site = findSite(req);
  if (req.body.name) site.name = slugify(req.body.name);
  if (req.body.autoStart !== undefined) site.autoStart = !!req.body.autoStart;
  if (req.body.noindex !== undefined) site.noindex = !!req.body.noindex;
  // containerPort: порт приложения внутри контейнера docker-сайта. null —
  // заново детектировать из EXPOSE/ports при следующем деплое.
  let portApplied = null;
  if (req.body.containerPort !== undefined) {
    let cp = null;
    if (req.body.containerPort !== null && req.body.containerPort !== '') {
      cp = Number(req.body.containerPort);
      if (!Number.isInteger(cp) || cp <= 0 || cp >= 65536) {
        return res.status(400).json({ error: 'containerPort: целое число 1..65535 или null' });
      }
    }
    if (site.type === 'docker' && cp !== (site.containerPort || null)) {
      site.containerPort = cp;
      // Применяем сразу: пересоздание контейнеров с новой публикацией.
      // Раньше порт «применялся» только при следующем деплое.
      const r = await manager.applyContainerPort(site);
      portApplied = r && r.ok ? 'restarted' : 'failed';
      if (portApplied === 'failed') {
        return res.status(500).json({ error: 'Порт сохранён, но пересоздание контейнера не удалось: ' + (r.error || '') });
      }
    } else {
      site.containerPort = cp;
    }
  }
  // flush(), а не save(): ошибка записи должна вернуть 5xx, а не «ок» через 250 мс.
  store.flush();
  const out = await serializeSite(site);
  if (portApplied) out.containerPortApplied = portApplied;
  res.json(out);
}));

/* ---------- Домены ---------- */

router.post('/sites/:id/domains', wrap(async (req, res) => {
  const site = findSite(req);
  const domain = store.normalizeDomain(req.body.domain);
  if (!domain) return res.status(400).json({ error: 'Некорректное доменное имя' });
  if (store.domainTaken(domain, site.id)) {
    return res.status(409).json({ error: `Домен ${domain} уже привязан к другому сайту` });
  }
  if (!site.domains.includes(domain)) site.domains.push(domain);
  store.flush();
  res.json({ ok: true, domains: site.domains });
}));

router.delete('/sites/:id/domains/:domain', wrap(async (req, res) => {
  const site = findSite(req);
  let raw;
  try {
    raw = decodeURIComponent(req.params.domain);
  } catch {
    // '%' в сегменте бросал URIError и отдавал 500 (T-18).
    return res.status(400).json({ error: 'Некорректное имя домена в пути' });
  }
  const domain = store.normalizeDomain(raw);
  if (!domain) return res.status(400).json({ error: 'Некорректное доменное имя' });
  site.domains = site.domains.filter((d) => d !== domain);
  store.flush();
  res.json({ ok: true, domains: site.domains });
}));

/* ---------- SSL ---------- */

router.post('/sites/:id/ssl/selfsigned', wrap(async (req, res) => {
  const site = findSite(req);
  if (!site.domains.length) return res.status(400).json({ error: 'Сначала привяжите домен' });
  await certs.issueSelfSigned(site);
  res.json({ ok: true, ssl: site.ssl });
}));

router.post('/sites/:id/ssl/issue', wrap(async (req, res) => {
  const site = findSite(req);
  // Домены выпуска валидируются тем же normalizeDomain, что и привязка доменов
  // (H-19): раньше произвольные строки попадали в сохраняемый site.ssl.domains,
  // в CSR и в продление, минуя все проверки.
  let domains = req.body.domains;
  if (domains !== undefined) {
    if (!Array.isArray(domains)) {
      return res.status(400).json({ error: 'domains должен быть массивом' });
    }
    domains = domains.map((d) => store.normalizeDomain(d));
    if (domains.some((d) => !d)) {
      return res.status(400).json({ error: 'Список domains содержит некорректное доменное имя' });
    }
  }
  try {
    await acme.issueCertificate(site, {
      domains,
      email: req.body.email,
      staging: req.body.staging,
    });
    res.json({ ok: true, ssl: site.ssl });
  } catch (err) {
    res.status(502).json({ error: 'Не удалось выпустить сертификат: ' + err.message, ssl: site.ssl });
  }
}));

router.post('/sites/:id/ssl/disable', wrap(async (req, res) => {
  const site = findSite(req);
  certs.removeCertFiles(site);
  site.ssl = { provider: null, status: 'none' };
  store.flush();
  res.json({ ok: true, ssl: site.ssl });
}));

router.get('/sites/:id/health', wrap(async (req, res) => {
  const site = findSite(req);
  res.json({ history: monitor.getHistory(site.id), health: monitor.healthFor(site.id) });
}));

/* ---------- Настройки и система ---------- */

router.get('/settings', wrap(async (_req, res) => {
  const a = store.state.settings.alerts;
  res.json({
    leEmail: store.state.settings.leEmail,
    leStaging: !!store.state.settings.leStaging,
    alerts: {
      enabled: a.enabled !== false,
      // Токен не покидает сервер (A-02): любая XSS в оболочке забирала его из DOM,
      // а значение приезжало в каждый ответ /api/settings.
      telegramTokenSet: !!a.telegramToken,
      telegramTokenHint: a.telegramToken ? '***' + String(a.telegramToken).slice(-4) : '',
      telegramChatId: a.telegramChatId || '',
      diskThreshold: a.diskThreshold || 80,
      memThreshold: a.memThreshold || 80,
    },
    httpPort: config.httpPort,
    httpsPort: config.httpsPort,
    adminPort: config.adminPort,
    uploadMaxMb: config.uploadMaxMb,
    user: auth.getUser(),
  });
}));

router.put('/settings', wrap(async (req, res) => {
  if (req.body.leEmail !== undefined) store.state.settings.leEmail = String(req.body.leEmail || '').trim();
  if (req.body.leStaging !== undefined) store.state.settings.leStaging = !!req.body.leStaging;
  if (req.body.alerts && typeof req.body.alerts === 'object') {
    const a = store.state.settings.alerts;
    const inc = req.body.alerts;
    if (inc.enabled !== undefined) a.enabled = !!inc.enabled;
    // A-02: токен меняется только новым значением. Пустая строка или маска вида
    // «***1234» (что вернёт GET) означают «оставить прежний» — иначе сохранение
    // настроек из формы, не трогавшей токен, стирало бы его. Явно стереть можно
    // полем telegramTokenReset: true.
    if (inc.telegramTokenReset === true) a.telegramToken = '';
    else if (inc.telegramToken !== undefined) {
      const t = String(inc.telegramToken).trim();
      if (t && !/^\*\*\*/.test(t)) a.telegramToken = t;
    }
    if (inc.telegramChatId !== undefined) a.telegramChatId = String(inc.telegramChatId).trim();
    for (const key of ['diskThreshold', 'memThreshold']) {
      if (inc[key] === undefined) continue;
      const v = parseInt(inc[key], 10);
      if (!Number.isFinite(v) || v < 1 || v > 99) {
        return res.status(400).json({ error: 'Порог должен быть числом от 1 до 99' });
      }
      a[key] = v;
    }
  }
  store.flush();
  res.json({ ok: true });
}));

router.post('/alerts/test', wrap(async (_req, res) => {
  const a = store.state.settings.alerts;
  if (!a.telegramToken || !a.telegramChatId) {
    return res.status(400).json({ error: 'Укажите токен бота и chat_id в настройках' });
  }
  const ok = await alerts.send(`🧪 SitePanel: тестовое оповещение с ${require('os').hostname()}`);
  res.json({ ok, error: ok ? undefined : 'Telegram не принял сообщение — проверьте токен и chat_id в журнале панели' });
}));

router.post('/password', wrap(async (req, res) => {
  const { user, password } = req.body;
  // Валидация типа обязательна: с объектом в поле user панель записывала
  // `"user": {...}` в auth.json и вход ломался навсегда (H-12).
  if (user !== undefined && user !== null && user !== '' && typeof user !== 'string') {
    return res.status(400).json({ error: 'Логин должен быть строкой' });
  }
  if (typeof password !== 'string') {
    return res.status(400).json({ error: 'Пароль должен быть строкой' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
  }
  try {
    const result = auth.changePassword(user, password);
    // Смена пароля — событие доступа: без записи в журнале подмена учётных данных
    // не оставляла бы следа (A-05). Пароль не логируется.
    console.log(`[auth] пароль изменён (user: ${result.user}, ip: ${req.socket.remoteAddress})`);
    res.json({ ok: true, user: result.user });
  } catch (err) {
    const status = err.code === 'INVALID_USER' || err.code === 'INVALID_PASSWORD' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
}));

router.get('/dashboard', wrap(async (_req, res) => {
  const data = dashboard.snapshot();
  data.sites = {
    total: store.state.sites.length,
    running: store.state.sites.filter((s) => s.status === 'running').length,
  };
  res.json(data);
}));

/* ---------- Терминал и пользователи ---------- */

// Токен выдаётся только авторизованному запросу (auth.middleware выше) с
// CSRF-заголовком: WebSocket сам Basic не подставляет, поэтому рукопожатие
// подтверждается одноразовым токеном (см. src/admin/terminal.js).
router.post('/terminal/token', wrap(async (_req, res) => {
  try {
    res.json(terminal.issueToken());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}));

router.get('/terminal/status', wrap(async (_req, res) => {
  res.json({ enabled: !terminal.isDisabled(), sessions: terminal.sessionCount() });
}));

// Список учётных записей. Панель администрируется одной учёткой (auth.json),
// страница «Пользователи» показывает её и позволяет сменить логин/пароль.
router.get('/users', wrap(async (_req, res) => {
  res.json({
    users: [{ user: auth.getUser(), role: 'admin' }],
    note: 'Панель использует одну учётную запись администратора (data/auth.json).',
  });
}));

router.get('/system', wrap(async (_req, res) => {
  res.json({
    nodeVersion: process.version,
    platform: `${os.type()} ${os.arch()}`,
    panelUptimeSec: Math.round(process.uptime()),
    totalmemGb: Math.round(os.totalmem() / 1073741824 * 10) / 10,
    freememGb: Math.round(os.freemem() / 1073741824 * 10) / 10,
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    sites: store.state.sites.length,
    running: store.state.sites.filter((s) => s.status === 'running').length,
    httpPort: config.httpPort,
    httpsPort: config.httpsPort,
    adminPort: config.adminPort,
    dataDir: config.dataDir,
  });
}));

/* ---------- Файловый менеджер ---------- */

const EDIT_MAX_BYTES = 2 * 1024 * 1024; // редактирование текстовых файлов до 2 МБ

// Разрешаем пути только внутри каталога сайта (защита от ../ и абсолютных путей).
// Лексической проверки мало: симлинк внутри каталога может вести наружу, и через
// чтение или PUT файла утекал .env соседа — поэтому вторая, «реальная» проверка
// через realpath (H-03).
const { realInside } = require('../httpserver');

function safePath(site, rel, { mustExist = false } = {}) {
  const root = path.resolve(manager.siteDir(site));
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(root, clean);
  if (target !== root && !target.startsWith(root + path.sep)) {
    const err = new Error('Путь вне каталога сайта');
    err.status = 400;
    throw err;
  }
  // realInside разворачивает симлинки; для ещё не существующего файла смотрит
  // ближайшего существующего родителя (создание нового файла валидно).
  if (!realInside(root, target)) {
    const err = new Error('Путь вне каталога сайта (симлинк)');
    err.status = 400;
    throw err;
  }
  if (mustExist && !fs.existsSync(target)) {
    const err = new Error('Не найдено: ' + (clean || '/'));
    err.status = 404;
    throw err;
  }
  return { root, target, rel: path.relative(root, target) };
}

function sanitizeName(name) {
  const n = String(name || '').replace(/[\\/]/g, '_').trim();
  if (!n || n === '.' || n === '..' || /[^\w.\- ()А-Яа-яё]/i.test(n)) {
    const err = new Error('Недопустимое имя файла');
    err.status = 400;
    throw err;
  }
  return n;
}

function looksBinary(buf) {
  const slice = buf.subarray(0, 8000);
  return slice.includes(0);
}

router.get('/sites/:id/files', wrap(async (req, res) => {
  const site = findSite(req);
  const { root, target, rel } = safePath(site, req.query.path, { mustExist: true });
  const st = await fs.promises.stat(target);
  if (!st.isDirectory()) return res.status(400).json({ error: 'Это не каталог' });
  const dirents = await fs.promises.readdir(target, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    try {
      const s = await fs.promises.stat(path.join(target, d.name));
      entries.push({ name: d.name, dir: d.isDirectory(), size: s.size, mtime: s.mtimeMs });
    } catch { /* исчез при чтении — пропускаем */ }
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'ru') : a.dir ? -1 : 1));
  res.json({ path: rel.split(path.sep).join('/'), root: path.basename(root), entries });
}));

router.get('/sites/:id/file', wrap(async (req, res) => {
  const site = findSite(req);
  const { target, rel } = safePath(site, req.query.path, { mustExist: true });
  const st = await fs.promises.stat(target);
  if (st.isDirectory()) return res.status(400).json({ error: 'Это каталог' });
  if (req.query.download === '1') return res.download(target);
  if (st.size > EDIT_MAX_BYTES) {
    return res.status(413).json({ error: 'Файл больше 2 МБ — доступно только скачивание', size: st.size });
  }
  const buf = await fs.promises.readFile(target);
  const binary = looksBinary(buf);
  res.json({ path: rel.split(path.sep).join('/'), size: st.size, binary, content: binary ? null : buf.toString('utf8') });
}));

// Файловый менеджер пишет в ТОТ ЖЕ каталог, который подменяет деплой: без общей
// блокировки запись в середине `renameSync(dir, dir.backup)` попадала в каталог,
// которого уже нет, либо в старую версию, которая через миг переставала быть
// сайтом (P-31). Все операции с файлами выполняются под локом сайта.
router.put('/sites/:id/file', wrap(async (req, res) => {
  const site = findSite(req);
  const { target, rel } = safePath(site, req.body.path);
  if (!rel) return res.status(400).json({ error: 'Не указан файл' });
  const content = typeof req.body.content === 'string' ? req.body.content : '';
  if (Buffer.byteLength(content, 'utf8') > EDIT_MAX_BYTES) {
    return res.status(413).json({ error: 'Файл больше 2 МБ' });
  }
  await manager.withSiteLock(site.id, () => fs.promises.writeFile(target, content, 'utf8'));
  res.json({ ok: true });
}));

router.post('/sites/:id/files/mkdir', wrap(async (req, res) => {
  const site = findSite(req);
  const { target } = safePath(site, req.body.path);
  await manager.withSiteLock(site.id, () => fs.promises.mkdir(target));
  res.json({ ok: true });
}));

router.post('/sites/:id/files/rename', wrap(async (req, res) => {
  const site = findSite(req);
  const from = safePath(site, req.body.from, { mustExist: true });
  if (!from.rel) return res.status(400).json({ error: 'Нельзя переименовать корень' });
  const name = sanitizeName(req.body.to);
  const to = path.join(from.root, path.dirname(from.rel), name);
  await manager.withSiteLock(site.id, () => fs.promises.rename(from.target, to));
  res.json({ ok: true });
}));

router.delete('/sites/:id/file', wrap(async (req, res) => {
  const site = findSite(req);
  const { target, rel } = safePath(site, req.query.path, { mustExist: true });
  if (!rel) return res.status(400).json({ error: 'Нельзя удалить корень сайта' });
  await manager.withSiteLock(site.id, () => fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  res.json({ ok: true });
}));

router.post('/sites/:id/files/upload', uploadAny.single('file'), wrap(async (req, res) => {
  const site = findSite(req);
  const dir = safePath(site, req.body.path, { mustExist: true });
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  const name = sanitizeName(req.body.name || req.file.originalname);
  const dest = path.join(dir.target, name);
  let extracted = false;
  // Распаковка заменяет дерево сайта и уничтожает сам архив, поэтому требует
  // ЯВНОГО подтверждения: одного `extract=1` мало — распаковка не должна
  // запускаться случайным/повторным запросом (P-31). Оболочка подтверждает
  // распаковку диалогом и посылает confirm=1.
  if (req.body.extract === '1' && req.body.confirm !== '1') {
    await fs.promises.rm(req.file.path, { force: true });
    return res.status(400).json({
      error: 'Для распаковки архива нужно явное подтверждение (confirm=1): содержимое каталога будет заменено, а архив удалён',
    });
  }
  // Распаковка архива пишет в тот же каталог, что и деплой: держим лок на обе
  // операции целиком, а не только на перемещение файла (P-07).
  await manager.withSiteLock(site.id, async () => {
    await fs.promises.rename(req.file.path, dest).catch(async (err) => {
      // Между дисками rename может упасть — копируем.
      if (err.code === 'EXDEV') {
        await fs.promises.copyFile(req.file.path, dest);
        await fs.promises.rm(req.file.path, { force: true });
        return;
      }
      throw err;
    });
    if (req.body.extract === '1' && /\.zip$/i.test(name)) {
      await manager.extractZip(dest, dir.target);
      await fs.promises.rm(dest, { force: true });
      extracted = true;
    }
  });
  res.json({ ok: true, extracted });
}));

/* ---------- Бэкапы ---------- */

// Список бэкапов и расписание. Форма `const x = f(); res.json(x)`, а не
// `res.json(f())`: lint-тест (routes-lint) считает вызов вида res.json(x.y())
// подозрением на необработанный промис.
router.get('/sites/:id/backups', wrap(async (req, res) => {
  const site = findSite(req);
  const summary = backups.summary(site);
  res.json(summary);
}));

// Расписание — частичное обновление: переданные поля меняются, остальные остаются.
router.put('/sites/:id/backups/schedule', wrap(async (req, res) => {
  const site = findSite(req);
  site.backupSchedule = backups.normalizeScheduleInput(site, req.body || {});
  // flush(), а не save(): ошибка записи должна вернуть 5xx, а не «ок» через 250 мс.
  store.flush();
  res.json({ ok: true, schedule: site.backupSchedule });
}));

// Создать бэкап сейчас. Блокирует сайт на время упаковки (секунды для
// небольших сайтов); таймаут клиента в интерфейсе — 5 минут.
router.post('/sites/:id/backups', wrap(async (req, res) => {
  const site = findSite(req);
  const backup = await backups.createBackup(site, 'manual');
  res.json({ ok: true, backup });
}));

router.post('/sites/:id/backups/:name/restore', wrap(async (req, res) => {
  const site = findSite(req);
  const zipPath = backups.resolveBackupPath(site, req.params.name);
  // restoreBackup сам остановит/поднимет сайт: {ok:false} здесь значит
  // «восстановлено, но сайт не запустился» — интерфейс покажет ошибку.
  const r = await manager.restoreBackup(site, zipPath);
  res.json(r);
}));

router.get('/sites/:id/backups/:name/download', wrap(async (req, res) => {
  const site = findSite(req);
  const zipPath = backups.resolveBackupPath(site, req.params.name);
  res.download(zipPath);
}));

router.delete('/sites/:id/backups/:name', wrap(async (req, res) => {
  const site = findSite(req);
  const r = await backups.deleteBackup(site, req.params.name);
  res.json(r);
}));

/* ---------- Ресурсы сервера (node/php/docker/next) ---------- */

router.get('/runtimes', wrap(async (_req, res) => {
  const list = await runtimes.listRuntimes();
  res.json({ runtimes: list });
}));

// Установка/обновление без версии ставит кандидата (apt) или latest (npm).
router.post('/runtimes/:id/install', wrap(async (req, res) => {
  const r = await runtimes.installRuntime(req.params.id, req.body && req.body.version);
  res.json(r);
}));

/* ---------- утилиты ---------- */

function slugify(s) {
  const slug = String(s).trim().toLowerCase().replace(/[^\wа-яё-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || 'site';
}

module.exports = router;
