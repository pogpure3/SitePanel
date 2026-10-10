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
const certs = require('../ssl/certs');
const acme = require('../ssl/acme');
const monitor = require('../monitor');
const dashboard = require('../dashboard');
const alerts = require('../alerts');

const router = express.Router();
router.use(auth.middleware);

/**
 * Защита от CSRF. HTTP Basic браузер подставляет автоматически, поэтому
 * сторонняя страница может отправить POST на панель (simple request) — ответ
 * она не прочитает, но действие выполнится. Требуем заголовок X-Requested-With:
 * произвольные заголовки вынуждают preflight, а CORS в панели не разрешён,
 * значит кросс-доменный запрос до обработчика не дойдёт.
 */
const CSRF_HEADER = 'x-requested-with';

function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.headers[CSRF_HEADER] === 'XMLHttpRequest') return next();
  return res.status(403).json({
    error: 'Запрос отклонён: отсутствует заголовок X-Requested-With (защита от CSRF).',
  });
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
    hasBackup: !!site.hasBackup,
    gitUrl: site.gitUrl || null,
    gitBranch: site.gitBranch || null,
    gitSubdir: site.gitSubdir || null,
    ssl: site.ssl || { status: 'none' },
    health: site.health || { status: 'unknown' },
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
  store.save();
  res.json(await serializeSite(site));
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
  const domain = decodeURIComponent(req.params.domain).toLowerCase();
  site.domains = site.domains.filter((d) => d !== domain);
  store.flush();
  res.json({ ok: true, domains: site.domains });
}));

/* ---------- SSL ---------- */

router.post('/sites/:id/ssl/selfsigned', wrap(async (req, res) => {
  const site = findSite(req);
  if (!site.domains.length) return res.status(400).json({ error: 'Сначала привяжите домен' });
  certs.issueSelfSigned(site);
  res.json({ ok: true, ssl: site.ssl });
}));

router.post('/sites/:id/ssl/issue', wrap(async (req, res) => {
  const site = findSite(req);
  try {
    await acme.issueCertificate(site, {
      domains: req.body.domains,
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
  res.json({ history: monitor.getHistory(site.id), health: site.health || null });
}));

/* ---------- Настройки и система ---------- */

router.get('/settings', wrap(async (_req, res) => {
  const a = store.state.settings.alerts;
  res.json({
    leEmail: store.state.settings.leEmail,
    leStaging: !!store.state.settings.leStaging,
    alerts: {
      enabled: a.enabled !== false,
      telegramToken: a.telegramToken || '',
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
    if (inc.telegramToken !== undefined) a.telegramToken = String(inc.telegramToken).trim();
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
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });
  }
  auth.changePassword(user, password);
  res.json({ ok: true });
}));

router.get('/dashboard', wrap(async (_req, res) => {
  const data = dashboard.snapshot();
  data.sites = {
    total: store.state.sites.length,
    running: store.state.sites.filter((s) => s.status === 'running').length,
  };
  res.json(data);
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
function safePath(site, rel, { mustExist = false } = {}) {
  const root = path.resolve(manager.siteDir(site));
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(root, clean);
  if (target !== root && !target.startsWith(root + path.sep)) {
    const err = new Error('Путь вне каталога сайта');
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

router.put('/sites/:id/file', wrap(async (req, res) => {
  const site = findSite(req);
  const { target, rel } = safePath(site, req.body.path);
  if (!rel) return res.status(400).json({ error: 'Не указан файл' });
  const content = typeof req.body.content === 'string' ? req.body.content : '';
  if (Buffer.byteLength(content, 'utf8') > EDIT_MAX_BYTES) {
    return res.status(413).json({ error: 'Файл больше 2 МБ' });
  }
  await fs.promises.writeFile(target, content, 'utf8');
  res.json({ ok: true });
}));

router.post('/sites/:id/files/mkdir', wrap(async (req, res) => {
  const site = findSite(req);
  const { target } = safePath(site, req.body.path);
  await fs.promises.mkdir(target);
  res.json({ ok: true });
}));

router.post('/sites/:id/files/rename', wrap(async (req, res) => {
  const site = findSite(req);
  const from = safePath(site, req.body.from, { mustExist: true });
  if (!from.rel) return res.status(400).json({ error: 'Нельзя переименовать корень' });
  const name = sanitizeName(req.body.to);
  const to = path.join(from.root, path.dirname(from.rel), name);
  await fs.promises.rename(from.target, to);
  res.json({ ok: true });
}));

router.delete('/sites/:id/file', wrap(async (req, res) => {
  const site = findSite(req);
  const { target, rel } = safePath(site, req.query.path, { mustExist: true });
  if (!rel) return res.status(400).json({ error: 'Нельзя удалить корень сайта' });
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  res.json({ ok: true });
}));

router.post('/sites/:id/files/upload', uploadAny.single('file'), wrap(async (req, res) => {
  const site = findSite(req);
  const dir = safePath(site, req.body.path, { mustExist: true });
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  const name = sanitizeName(req.body.name || req.file.originalname);
  const dest = path.join(dir.target, name);
  await fs.promises.rename(req.file.path, dest).catch(async (err) => {
    // Между дисками rename может упасть — копируем.
    if (err.code === 'EXDEV') {
      await fs.promises.copyFile(req.file.path, dest);
      await fs.promises.rm(req.file.path, { force: true });
      return;
    }
    throw err;
  });
  let extracted = false;
  if (req.body.extract === '1' && /\.zip$/i.test(name)) {
    await manager.extractZip(dest, dir.target);
    await fs.promises.rm(dest, { force: true });
    extracted = true;
  }
  res.json({ ok: true, extracted });
}));

/* ---------- утилиты ---------- */

function slugify(s) {
  const slug = String(s).trim().toLowerCase().replace(/[^\wа-яё-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || 'site';
}

module.exports = router;
