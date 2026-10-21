'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.PANEL_DATA_DIR || path.join(ROOT, 'data');

const config = {
  root: ROOT,
  dataDir: DATA_DIR,
  sitesDir: path.join(DATA_DIR, 'sites'),
  certsDir: path.join(DATA_DIR, 'certs'),
  logsDir: path.join(DATA_DIR, 'logs'),
  tmpDir: path.join(DATA_DIR, 'tmp'),
  backupsDir: path.join(DATA_DIR, 'backups'),
  dbFile: path.join(DATA_DIR, 'db.json'),
  authFile: path.join(DATA_DIR, 'auth.json'),
  configFile: path.join(DATA_DIR, 'config.json'),
  acmeDir: path.join(DATA_DIR, 'acme'),

  // Порты. 80/443 требуют прав администратора (Windows) / root или CAP_NET_BIND_SERVICE (Linux).
  adminPort: posInt(process.env.PANEL_ADMIN_PORT, 3000, 1, 65535),
  // Интерфейс админки. По умолчанию только loopback: наружу панель отдаёт nginx,
  // а открытый в сеть админ-порт — лишняя поверхность (H-09). Прежнее поведение
  // возвращается значением PANEL_ADMIN_HOST=0.0.0.0.
  adminHost: process.env.PANEL_ADMIN_HOST || '127.0.0.1',
  httpPort: posInt(process.env.PANEL_HTTP_PORT, 80, 1, 65535),
  httpsPort: posInt(process.env.PANEL_HTTPS_PORT, 443, 1, 65535),

  // Let's Encrypt
  leEmail: process.env.PANEL_LE_EMAIL || '',
  leStaging: bool(process.env.PANEL_LE_STAGING, false),
  leRenewDays: posInt(process.env.PANEL_LE_RENEW_DAYS, 30, 1, 365),

  uploadMaxMb: posInt(process.env.PANEL_UPLOAD_MAX_MB, 300, 1, 4096),
  internalPortFrom: posInt(process.env.PANEL_INTERNAL_PORT_FROM, 10000, 1024, 65000),

  // Автоперезапуск упавших сайтов.
  // Бэкофф сбрасывается только после стабильной работы restartStableSec секунд,
  // иначе сайт, падающий позже 1.5с, перезапускался бы бесконечно с интервалом 1с.
  restartMaxAttempts: posInt(process.env.PANEL_RESTART_MAX_ATTEMPTS, 5, 1, 1000),
  restartStableSec: posInt(process.env.PANEL_RESTART_STABLE_SEC, 60, 1, 86400),
  restartCooldownMin: posInt(process.env.PANEL_RESTART_COOLDOWN_MIN, 10, 1, 10080),

  // Распаковка архива: защита от zip-бомб.
  // posInt, а не int: при `PANEL_MAX_UNCOMPRESSED_MB=0` (или отрицательном)
  // прежний `int()` возвращал 0, сравнение `totalBytes > maxBytes` становилось
  // заведомо ложным и лимит ИСЧЕЗАЛ. Ноль здесь не «отключает» защиту, а ломает её.
  maxUncompressedMb: posInt(process.env.PANEL_MAX_UNCOMPRESSED_MB, 2048, 1, 65536),
  maxZipEntries: posInt(process.env.PANEL_MAX_ZIP_ENTRIES, 50000, 1, 1000000),
  // Ограничение времени на npm/yarn/pnpm install и сборку.
  installTimeoutMin: posInt(process.env.PANEL_INSTALL_TIMEOUT_MIN, 10, 1, 1440),
  // Общий бюджет деплоя: install + сборка + повторный проход + второй install
  // для подкаталога раньше давали до часа удержания блокировки сайта (P-32).
  deployTimeoutMin: posInt(process.env.PANEL_DEPLOY_TIMEOUT_MIN, 30, 1, 1440),
  // Клонирование репозитория: «повисший» хост держал блокировку сайта вечно.
  gitTimeoutMin: posInt(process.env.PANEL_GIT_TIMEOUT_MIN, 5, 1, 1440),

  // Проксирование в приложение сайта: зависший upstream держал соединение
  // до таймаутов Node (300 с) и занимал сокет (H-06).
  proxyTimeoutMs: posInt(process.env.PANEL_PROXY_TIMEOUT_MS, 60000, 1000, 600000),
  // Сколько ждать, пока приложение сайта откроет порт после старта (P-03).
  appListenWaitMs: posInt(process.env.PANEL_APP_LISTEN_WAIT_MS, 10000, 500, 120000),

  // Кому верить заголовкам X-Forwarded-* (H-07). По умолчанию — только loopback
  // (nginx на той же машине). PANEL_TRUST_PROXY='1.2.3.4,5.6.7.8' — явный список
  // адресов фронт-прокси (заменяет умолчание); '*' — доверять всем (небезопасно).
  trustProxy: parseTrustProxy(process.env.PANEL_TRUST_PROXY),

  // Передавать приложению реальный адрес клиента из X-Forwarded-For доверенного
  // фронт-прокси (nginx). По умолчанию выключено: панель отбрасывает клиентские
  // X-Forwarded-*, чтобы приложение не поверило подделке (H-14). Включать
  // только когда панель действительно стоит за nginx/traefik.
  forwardClientIp: process.env.PANEL_FORWARD_CLIENT_IP === '1',

  // Логи сайтов: одна ротация на старте + чтение всего файла в память были
  // главным путём к OOM одним запросом (P-01, P-02, P-23).
  logMaxBytes: posInt(process.env.PANEL_LOG_MAX_BYTES, 4 * 1024 * 1024, 64 * 1024, 1024 * 1024 * 1024),
  logGenerations: posInt(process.env.PANEL_LOG_GENERATIONS, 3, 1, 10),
  // Потолок на объём, который вообще читается в память (хвост лога, вывод сборки).
  logTailMaxBytes: posInt(process.env.PANEL_LOG_TAIL_MAX_BYTES, 256 * 1024, 4096, 16 * 1024 * 1024),
  cmdOutputMaxBytes: posInt(process.env.PANEL_CMD_OUTPUT_MAX_BYTES, 256 * 1024, 4096, 16 * 1024 * 1024),

  // Блокировка единственного экземпляра панели (SP-08).
  instanceLockFile: path.join(DATA_DIR, 'sitepanel.lock'),
  // Состояние защёлок алертов между перезапусками (SP-22).
  stateFile: path.join(DATA_DIR, 'state.json'),

  // Период health-check тика монитора. Переменная нужна тестам (ждать 30 с
  // нельзя) и тем, кто хочет чаще/реже; нижняя граница защищает от DDoS самого себя.
  monitorTickMs: posInt(process.env.PANEL_MONITOR_TICK_MS, 30000, 250, 600000),

  // Плановые бэкапы сайтов. PANEL_BACKUPS=0 выключает функцию целиком —
  // по той же схеме, что PANEL_TERMINAL=0 у веб-терминала.
  backupsEnabled: bool(process.env.PANEL_BACKUPS, true),
  // Период опроса расписания: нижняя граница — для тестов, ждать час нельзя.
  backupCheckSec: posInt(process.env.PANEL_BACKUP_CHECK_SEC, 60, 1, 86400),
  // Потолок размера сайта, упаковываемого в бэкап. adm-zip держит архив в
  // памяти: без своего лимита бэкап большого сайта уронил бы панель по OOM,
  // а общий maxUncompressedMb (2 ГБ по умолчанию) слишком велик для памяти.
  backupMaxSiteMb: posInt(process.env.PANEL_BACKUP_MAX_MB, 512, 1, 16384),

  // Docker-сайты: бюджет на docker build / compose build. Сборка с npm/pip
  // внутри может идти долго; зависший билд не должен держать блокировку сайта
  // вечно (та же логика, что PANEL_INSTALL_TIMEOUT_MIN у node-сайтов).
  dockerBuildTimeoutMin: posInt(process.env.PANEL_DOCKER_BUILD_TIMEOUT_MIN, 10, 1, 1440),
  // Выключатель Docker-сайтов целиком: сборка чужого Dockerfile исполняет
  // RUN-команды на хосте через docker (у панели права docker-группы/root).
  // PANEL_DOCKER_SITES=0 — деплой и запуск docker-типа отвергаются с внятной
  // ошибкой (по образцу PANEL_TERMINAL / PANEL_BACKUPS).
  dockerSitesEnabled: bool(process.env.PANEL_DOCKER_SITES, true),
};

// Пользовательский config.json перекрывает значения по умолчанию.
// Значения проходят ту же проверку, что и переменные окружения: раньше файл
// подставлял числа «как есть», поэтому `{"httpsPort": -1}` или
// `{"maxUncompressedMb": 0}` снимал защиту наравне с env (P-16).
const USER_CONFIG_RANGES = {
  adminPort: [1, 65535],
  httpPort: [1, 65535],
  httpsPort: [1, 65535],
  leRenewDays: [1, 365],
  maxUncompressedMb: [1, 65536],
  maxZipEntries: [1, 1000000],
  installTimeoutMin: [1, 1440],
  uploadMaxMb: [1, 4096],
};

function loadUserConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(config.configFile, 'utf8'));
  } catch {
    return; /* файла ещё нет — используем значения по умолчанию */
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  for (const key of ['adminPort', 'httpPort', 'httpsPort', 'leEmail', 'leStaging', 'leRenewDays']) {
    if (raw[key] !== undefined) config[key] = raw[key];
  }
  for (const [key, [min, max]] of Object.entries(USER_CONFIG_RANGES)) {
    if (raw[key] === undefined) continue;
    const n = Number(raw[key]);
    if (Number.isInteger(n) && n >= min && n <= max) config[key] = n;
    else console.error(`[config] config.json: ${key}=${JSON.stringify(raw[key])} вне диапазона ${min}..${max} — оставлено ${config[key]}`);
  }
}
loadUserConfig();

/**
 * Число с проверкой границ. Значение вне диапазона (в том числе 0 и отрицательное)
 * заменяется значением по умолчанию с предупреждением.
 *
 * Почему это отдельная функция, а не `int()`: пределы читались без проверки, и
 * `PANEL_MAX_UNCOMPRESSED_MB=0` («чтобы отключить лимит») на деле снимал защиту от
 * zip-бомб целиком — условие `totalBytes > maxBytes` становилось заведомо ложным.
 * Молча принять такой мусор нельзя: администратор уверен, что защита настроена (P-16).
 * @param {string|undefined} v значение из окружения
 * @param {number} dflt значение по умолчанию
 * @param {number} min наименьшее допустимое значение
 * @param {number} max наибольшее допустимое значение
 */
function posInt(v, dflt, min, max) {
  if (v === undefined || v === '') return dflt;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) {
    console.error(`[config] значение ${JSON.stringify(v)} не число — используется ${dflt}`);
    return dflt;
  }
  if (n < min || n > max) {
    console.error(`[config] значение ${n} вне диапазона ${min}..${max} — используется ${dflt}`);
    return dflt;
  }
  return n;
}

function bool(v, dflt) {
  if (v === undefined) return dflt;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Список доверенных фронт-прокси для X-Forwarded-* (H-07).
 * undefined/пусто → [] (доверяем только loopback, см. httpserver.trustedForwarder);
 * '*' или 'all' → 'all' (доверять всем — осознанное решение оператора);
 * иначе — массив адресов, разделённых запятой. Мусор отбрасывается с логом.
 */
function parseTrustProxy(v) {
  if (v === undefined || v === '') return [];
  const s = String(v).trim().toLowerCase();
  if (s === '*' || s === 'all') return 'all';
  const list = s.split(',').map((p) => p.trim()).filter(Boolean);
  return list.length ? list : [];
}

function ensureDirs() {
  // mode здесь обязателен: без него на umask 022 каталоги создаются 0755 и до
  // первого hardenDataDir() (следующий вызов в src/index.js:23) будущие
  // auth.json/db.json/certs читаемы другим локальным пользователям, а если
  // процесс упадёт между вызовами — останутся такими навсегда (H-16).
  for (const dir of [DATA_DIR, config.sitesDir, config.certsDir, config.logsDir, config.tmpDir, config.acmeDir, config.backupsDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

module.exports = { config, ensureDirs };
