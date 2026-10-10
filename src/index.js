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
const { createServers, listenServers, securityHeaders } = require('./httpserver');
const adminRoutes = require('./admin/routes');

async function main() {
  ensureDirs();
  store.load();
  auth.load();
  certs.ensureDefaultCert();

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', adminRoutes);
  app.use(express.static(path.join(__dirname, 'admin', 'public')));
  // SPA fallback
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'admin', 'public', 'index.html')));

  const adminServer = app.listen(config.adminPort, () => {
    console.log('  Админ-панель:           http://localhost:' + config.adminPort);
  });
  adminServer.keepAliveTimeout = 65000;

  const servers = createServers();
  await listenServers(servers);

  monitor.start();
  dashboard.start();
  alerts.start();
  acme.startRenewalLoop();
  await manager.boot();

  console.log('');
  console.log('  SitePanel запущен. Каталог данных: ' + config.dataDir);

  const shutdown = () => {
    console.log('\n  Остановка...');
    // Глушим процессы напрямую, не трогая статусы: кто был running —
    // останется running в db и поднимется при следующем старте панели.
    for (const site of store.state.sites) {
      const proc = manager.getProcessInfo(site);
      if (proc && proc.child && proc.child.exitCode === null && proc.child.signalCode === null) {
        proc.stopping = true;
        try {
          if (process.platform === 'win32') {
            require('child_process').spawn('taskkill', ['/pid', String(proc.child.pid), '/T', '/F'], { windowsHide: true });
          } else {
            process.kill(-proc.child.pid, 'SIGTERM');
          }
        } catch {
          /* уже мёртв */
        }
      }
    }
    store.flush();
    setTimeout(() => process.exit(0), 1200);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Не удалось запустить SitePanel:', err.message);
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
