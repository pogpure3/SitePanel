'use strict';

// SitePanel — панель управления сайтами.
// Точка входа: админ-панель (Express) + реверс-прокси 80/443.

const express = require('express');
const path = require('path');
const { config, ensureDirs } = require('./config');
const store = require('./store');
const auth = require('./auth');
const certs = require('./ssl/certs');
const acme = require('./ssl/acme');
const monitor = require('./monitor');
const dashboard = require('./dashboard');
const alerts = require('./alerts');
const manager = require('./sites/manager');
const backups = require('./sites/backups');
const cronMgr = require('./sites/cron');
const { createServers, listenServers, securityHeaders } = require('./httpserver');
const adminRoutes = require('./admin/routes');
const terminal = require('./admin/terminal');
const login = require('./admin/login');
const sso = require('./admin/sso');

// Защита от повторного входа в шатдаун (два сигнала подряд).
let shuttingDown = false;
// Замок единственного экземпляра: снимается на выходе (SP-08).
const instancelock = require('./instancelock');
let lockHeld = false;

async function main() {
  // Замок берём ДО ensureDirs и до записи данных: два экземпляра панели делят
  // db.json, data/tmp и pid-файлы сайтов, поэтому второй старт нужно отклонить,
  // пока он ещё ничего не испортил.
  const lock = instancelock.acquire(config.instanceLockFile);
  if (!lock.ok) {
    throw new Error(
      `Уже запущен другой экземпляр панели (pid ${lock.holder.pid} на ${lock.holder.hostname || '?'}` +
      `${lock.reason ? ', ' + lock.reason : ''}). Остановите его или удалите ${config.instanceLockFile}, если он протух.`
    );
  }
  lockHeld = true;

  ensureDirs();
  // Ужимаем права на секреты, созданные прежними версиями (privkey.pem, .env, db.json).
  const hardened = require('./securefile').hardenDataDir(config);
  if (hardened > 0) console.log(`  Права на секреты обновлены: ${hardened} файл(ов)`);
  store.load();
  if (!auth.load()) {
    // Битый auth.json: вход невозможен, а генерация нового пароля молча
    // уничтожила бы прежний доступ. Останавливаемся с понятным сообщением.
    throw new Error('Учётные данные админ-панели не загружены (см. сообщение выше). Исправьте data/auth.json и перезапустите панель.');
  }
  await certs.ensureDefaultCert();

  if (process.env.PANEL_NO_AUTH === '1') {
    console.warn('');
    console.warn('  !!! PANEL_NO_AUTH=1 — встроенная авторизация ОТКЛЮЧЕНА. !!!');
    console.warn('  Любой, кто дотянется до порта админки ' + config.adminPort + ', получит полный доступ.');
    const host = config.adminHost;
    if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      console.warn(`  Админка слушает ${host} — это небезопасно без внешней авторизации.`);
      console.warn('  Задайте PANEL_ADMIN_HOST=127.0.0.1 и отдавайте панель через реверс-прокси.');
    }
    console.warn('');
  }

  if (store.isRecoveryMode()) {
    console.warn('  Реестр сайтов в аварийном режиме: изменения не сохраняются (см. сообщение выше).');
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  // Healthcheck для внешнего мониторинга самой панели (I-06): раньше /api/system
  // требовал авторизацию, и следить за панелью снаружи было нечем. Отдаём только
  // факт живости и аптайм — без версий, путей и количества сайтов.
  app.get('/healthz', (_req, res) => res.json({ ok: true, uptimeSec: Math.round(process.uptime()) }));
  // Авторизация закрывает ВСЁ приложение админки, а не только /api.
  // Раньше middleware стоял лишь на /api (в admin/routes.js), поэтому оболочка
  // интерфейса — index.html, app.js, style.css — отдавалась без пароля: посторонний
  // видел саму панель, её меню и названия сайтов из разметки, а 401 приходил только
  // на данные. Теперь без учётных данных не отдаётся ничего.
  // PANEL_NO_AUTH=1 внутри middleware оставляет прежнюю возможность отдать
  // авторизацию внешнему реверс-прокси.
  // Страница входа и endpoints сессий — ДО middleware: форма сама является
  // точкой получения доступа (см. src/admin/login.js).
  app.get('/login', login.loginPage);
  app.get('/login.js', login.loginScript);
  app.post('/api/login', express.json({ limit: '16kb' }), login.loginApi);
  app.post('/api/logout', login.logoutApi);
  app.post('/api/password-reset/request', express.json({ limit: '16kb' }), login.passwordResetRequestApi);
  app.post('/api/password-reset/confirm', express.json({ limit: '16kb' }), login.passwordResetConfirmApi);
  app.post('/sso/callback', express.urlencoded({ extended: false, limit: '8kb' }), sso.callback);
  app.use(auth.middleware);
  // Лимит согласован с редактором файлов (EDIT_MAX_BYTES = 2 МБ в admin/routes.js):
  // при 1mb запрос на 1.5 МБ падал с HTML-страницей Express вместо JSON панели.
  app.use(express.json({ limit: '3mb' }));
  app.use('/api', adminRoutes);
  app.use(express.static(path.join(__dirname, 'admin', 'public')));
  // Неизвестный маршрут API — это JSON-404, а не index.html: иначе клиент
  // получает 200 text/html на опечатку в URL (U-06).
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Маршрут API не найден' }));
  // SPA fallback
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'public', 'index.html')));

  // Ошибки body-parser и multer приходят сюда: без этого клиент получал
  // HTML-страницу Express с 413/500 вместо JSON-контракта панели (H-11).
  app.use((err, _req, res, _next) => {
    const status = Number(err && (err.status || err.statusCode)) || 500;
    let message = (err && err.message) || 'Внутренняя ошибка';
    if (err && err.type === 'entity.too.large') message = `Тело запроса слишком велико (лимит ${Math.round(config.uploadMaxMb / 100)} МБ).`;
    if (err && err.type === 'entity.parse.failed') message = 'Тело запроса не является корректным JSON.';
    if (err && err.code === 'LIMIT_FILE_SIZE') message = `Файл слишком большой (лимит ${config.uploadMaxMb} МБ).`;
    if (status >= 500) console.error('[panel] ошибка обработки запроса:', err && err.stack ? err.stack : err);
    if (res.headersSent) return res.destroy();
    res.status(status).json({ error: message });
  });

  // host: по умолчанию только loopback — панель не должна светить админку в сеть
  // (прикрытие одним UFW недостаточно). Наружу её отдаёт nginx. Для прежнего
  // поведения — PANEL_ADMIN_HOST=0.0.0.0.
  const adminServer = app.listen(config.adminPort, config.adminHost, () => {
    console.log('  Админ-панель:           http://' + (config.adminHost === '0.0.0.0' ? 'localhost' : config.adminHost) + ':' + config.adminPort);
  });
  // Без обработчика 'error' занятый порт превращался в uncaughtException:
  // панель «жила», но админка молча не работала (SP-08).
  adminServer.on('error', (err) => {
    console.error(`Не удалось занять порт админки ${config.adminPort}: ${err.code || err.message}`);
    process.exit(1);
  });
  adminServer.keepAliveTimeout = 65000;
  // Веб-терминал: WS-канал на том же порту админки. Авторизация — через
  // одноразовые токены /api/terminal/token (Basic + CSRF); PANEL_TERMINAL=0
  // выключает функцию целиком.
  if (process.env.PANEL_TERMINAL !== '0') {
    terminal.attach(adminServer);
    console.log('  Веб-терминал:           ws-апгрейд на порту ' + config.adminPort);
  }

  const servers = createServers();
  await listenServers(servers);

  // boot() ДО монитора/дашборда/алертов: первый тик монитора (setTimeout 5с) мог
  // пройти раньше подъёма процессов и записать в реестр 'crashed' живому сайту —
  // панель показывала упавшим работающий сайт до следующего тика (M-01).
  await manager.boot();

  monitor.start();
  dashboard.start();
  alerts.start();
  // Плановые бэкапы после boot(): тик идёт сразу и берёт блокировки сайтов —
  // они должны быть свободны, как и для первого тика монитора (M-01).
  backups.start();
  // Cron-задания сайтов — тот же принцип: первый тик берёт блокировки.
  cronMgr.start();
  acme.startRenewalLoop();

  // Почасовая уборка data/tmp (SP-14): чистка при старте не спасает от
  // долгоживущего процесса — брошенные staging-каталоги копились неделями.
  const tmpSweeper = setInterval(() => {
    try {
      const cleaned = require('./sites/deploymark').cleanTemp();
      if (cleaned.files) {
        console.log(`  [tmp] почасовая уборка: ${cleaned.files} объектов, ${Math.round(cleaned.bytes / 1048576)} МБ`);
      }
    } catch (err) {
      console.error('[tmp] уборка не удалась:', err.message);
    }
  }, 3600000);
  tmpSweeper.unref();

  console.log('');
  console.log('  SitePanel запущен. Каталог данных: ' + config.dataDir);

  const shutdown = async (signal) => {
    // Идемпотентность: второй Ctrl+C/SIGTERM не должен повторно флашить реестр
    // и заводить второй таймер выхода (SP-25). Повторный сигнал = «выходим сейчас».
    if (shuttingDown) {
      console.log('  Повторный сигнал — завершаюсь немедленно.');
      process.exit(0);
    }
    shuttingDown = true;
    console.log(`\n  Остановка (${signal})...`);
    // Веб-терминал: гасим открытые shell-сессии до убийства процессов сайтов.
    try { terminal.shutdown(); } catch { /* сессий могло не быть */ }
    // Новые соединения больше не принимаем, пока завершаем процессы сайтов.
    // Активные сокеты не ждём бесконечно: после освобождения портов сайтов всё
    // равно завершим процесс панели.
    for (const server of [adminServer, servers.httpServer, servers.httpsServer]) {
      try { server.close(); } catch { /* сервер мог не слушать */ }
      try { server.closeAllConnections(); } catch { /* Node без этого метода */ }
    }
    // Ошибку записи в обработчике сигнала глотать нельзя: без этого шатдаун
    // выглядел успешным при несохранённых изменениях (SP-06).
    try {
      store.flush();
    } catch (err) {
      console.error('[panel] реестр не сохранён при остановке:', err.message);
    }
    // Install/build-подпроцессы деплоя живут вне `processes` сайтов, поэтому
    // раньше переживали остановку панели и продолжали писать в data/tmp (SP-05).
    try {
      const killed = manager.killActiveCommands('SIGTERM');
      if (killed.length) console.log(`  Прервано подпроцессов деплоя: ${killed.length}`);
    } catch (err) {
      console.error('[panel] не удалось погасить подпроцессы деплоя:', err.message);
    }
    // Не выходим, пока taskkill либо TERM→KILL не завершили дерево и порт сайта
    // не стал свободен. Иначе следующий boot получает EADDRINUSE (SP-09).
    await manager.shutdownProcesses();
    // Замок снимаем только после остановки сайтов: новый экземпляр не должен
    // стартовать параллельно с ещё завершающимися деревьями старого.
    if (lockHeld) {
      instancelock.release(config.instanceLockFile);
      lockHeld = false;
    }
    process.exit(0);
  };
  process.on('SIGINT', () => { shutdown('SIGINT').catch((err) => console.error('[panel] ошибка остановки:', err.message)); });
  process.on('SIGTERM', () => { shutdown('SIGTERM').catch((err) => console.error('[panel] ошибка остановки:', err.message)); });
  // Windows не умеет доставлять SIGTERM другому процессу Node: process.kill()
  // завершает его принудительно. IPC даёт тестам и процессу-надсмотрщику точный
  // эквивалент штатного сигнала, проходящий через тот же shutdown.
  process.on('message', (message) => {
    if (message && message.type === 'sitepanel-shutdown') {
      shutdown('IPC').catch((err) => console.error('[panel] ошибка остановки:', err.message));
    }
  });
}

main().catch((err) => {
  // Замок не должен пережить неудачный старт: иначе панель нельзя будет запустить
  // после исправления ошибки, пока файл не удалят руками (SP-08).
  if (lockHeld) {
    try { instancelock.release(config.instanceLockFile); } catch { /* не критично */ }
    lockHeld = false;
  }
  console.error('Не удалось запустить SitePanel:', err.panelMessage || err.message);
  if (String(err.code) === 'EADDRINUSE') {
    console.error(`Порт уже занят (${err.port || '?'}). Остановите прежний процесс или задайте другие порты.`);
  }
  if (String(err.code) === 'EACCES') {
    console.error(`Порт занят или требуются права администратора (ports ${config.httpPort}/${config.httpsPort}).`);
    console.error('Задайте другие порты: PANEL_HTTP_PORT=8080 PANEL_HTTPS_PORT=8443');
  }
  process.exit(1);
});

// Панель управляет чужими процессами и не должна падать целиком из-за одной
// необработанной ошибки в фоне (таймер перезапуска, алерт, ACME). Логируем и живём.
process.on('unhandledRejection', (reason) => {
  console.error('[panel] необработанная ошибка (промис):', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[panel] необработанное исключение:', err && err.stack ? err.stack : err);
});
