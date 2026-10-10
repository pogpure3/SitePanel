'use strict';

// Тестовый харнесс: поднимает реальную панель на свободных портах
// с изолированным каталогом данных, чтобы тесты не трогали рабочий data/.

const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

// Порт 0 дал бы гонку «освободили → заняли», поэтому берём три разных.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * Свободный блок из count портов подряд.
 * Внутренние порты сайтов панель выделяет последовательно от PANEL_INTERNAL_PORT_FROM,
 * поэтому нужен именно непрерывный диапазон — иначе панель займёт порт чужого
 * сервиса (DSH, Steam и т.п.) и тесты получат чужие ответы.
 */
async function freePortBlock(count = 30) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const start = 20000 + Math.floor(Math.random() * 20000);
    let ok = true;
    for (let p = start; p < start + count; p++) {
      if (!(await canBind(p))) { ok = false; break; }
    }
    if (ok) return start;
  }
  throw new Error('Не удалось найти свободный блок портов для тестовой панели');
}

async function threePorts() {
  const used = new Set();
  const out = [];
  while (out.length < 3) {
    const p = await freePort();
    if (!used.has(p)) {
      used.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Запускает панель.
 * @param {object} [env] дополнительные переменные окружения
 * @returns {Promise<{adminPort:number,httpPort:number,httpsPort:number,dataDir:string,base:string,stop:Function}>}
 */
async function startPanel(env = {}) {
  const [adminPort, httpPort, httpsPort] = await threePorts();
  // Свой непрерывный блок внутренних портов на каждую панель: порт 10000 занят
  // у всех сразу, а занятый чужим сервисом порт ломает запуск (EADDRINUSE).
  const internalFrom = await freePortBlock(30);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-test-'));

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANEL_ADMIN_PORT: String(adminPort),
      PANEL_HTTP_PORT: String(httpPort),
      PANEL_HTTPS_PORT: String(httpsPort),
      PANEL_INTERNAL_PORT_FROM: String(internalFrom),
      PANEL_DATA_DIR: dataDir,
      // Авторизация в тестах API не нужна — проверяем поведение, а не Basic.
      PANEL_NO_AUTH: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let out = '';
  let exited = false;
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  child.on('exit', (code, signal) => {
    exited = true;
    // Тихая смерть панели — главная причина «непонятных» ошибок в тестах.
    console.error(`\n[panel] процесс панели завершился: code=${code} signal=${signal}\n${out}\n`);
  });

  const base = `http://127.0.0.1:${adminPort}`;

  // Ждём готовности админки (до 30с: на первом запуске генерируется сертификат).
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Панель завершилась при старте (code=${child.exitCode}):\n${out}`);
    }
    try {
      const res = await fetch(`${base}/api/system`, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (res.ok) break;
    } catch {
      /* ещё не слушает */
    }
    if (Date.now() > deadline) throw new Error(`Панель не поднялась за 30с:\n${out}`);
    await sleep(200);
  }

  const stop = async () => {
    // Сайты — внуки панели (npm -> node): при убийстве панели они осиротеют
    // и продолжат держать порты. Гасим их по портам из db.json.
    await killPortListeners(readSitePorts(dataDir));
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* временный каталог — не критично */
    }
  };

  return { adminPort, httpPort, httpsPort, dataDir, base, stop, bootLog: () => out };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Внутренние порты сайтов из db.json панели. */
function readSitePorts(dataDir) {
  try {
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
    return (db.sites || []).map((s) => s.port).filter(Boolean);
  } catch {
    return [];
  }
}

/** Гасит процессы, слушающие указанные порты (чтобы тесты не оставляли сирот). */
function killPortListeners(ports) {
  if (!ports.length) return Promise.resolve();
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      // POSIX: у панели отдельная группа процессов, но подстрахуемся через lsof.
      const lsof = require('child_process');
      let pending = ports.length;
      for (const p of ports) {
        lsof.execFile('lsof', ['-t', `-iTCP:${p}`, '-sTCP:LISTEN'], { windowsHide: true }, (err, stdout) => {
          if (!err) {
            for (const pid of String(stdout).split('\n').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)) {
              try { process.kill(pid, 'SIGKILL'); } catch { /* уже мёртв */ }
            }
          }
          if (--pending === 0) resolve();
        });
      }
      if (!pending) resolve();
      return;
    }
    require('child_process').execFile(
      'netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve();
        const wanted = new Set(ports.map(Number));
        const pids = new Set();
        for (const line of String(stdout).split('\n')) {
          const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
          if (m && wanted.has(Number(m[1]))) pids.add(m[2]);
        }
        if (!pids.size) return resolve();
        let pending = pids.size;
        for (const pid of pids) {
          require('child_process').execFile('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true }, () => {
            if (--pending === 0) resolve();
          });
        }
      }
    );
  });
}

/** API-запрос с корректным CSRF-заголовком. */
async function api(panel, method, p, body) {
  const opts = { method, headers: { 'X-Requested-With': 'XMLHttpRequest' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(panel.base + p, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* не json */ }
  return { status: res.status, data, text, headers: res.headers };
}

/** Запрос БЕЗ CSRF-заголовка — для проверки защиты. */
async function apiRaw(panel, method, p, body, extraHeaders = {}) {
  const opts = { method, headers: { ...extraHeaders } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(panel.base + p, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* не json */ }
  return { status: res.status, data, text, headers: res.headers };
}

/** Опрашивает условие до таймаута. */
async function waitFor(fn, { timeout = 30000, interval = 500, label = 'условие' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`Не дождались: ${label}`);
    await sleep(interval);
  }
}

/**
 * GET через реверс-прокси с произвольным Host.
 * fetch() из Node (undici) молча выбрасывает заголовок Host — он запрещён
 * спецификацией, поэтому для маршрутизации по домену нужен http.request.
 */
function fetchWithHost(port, host, p = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'GET', headers: { Host: host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Создаёт zip-архив с заданными файлами (относительный путь -> содержимое).
 * @param {string} dir каталог для сборки архива
 * @param {Record<string,string>} files
 * @param {string} zipPath
 */
function makeZip(dir, files, zipPath) {
  const AdmZip = require(path.join(ROOT, 'node_modules', 'adm-zip'));
  fs.mkdirSync(dir, { recursive: true });
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    zip.addLocalFile(full, path.dirname(name) === '.' ? '' : path.dirname(name));
  }
  zip.writeZip(zipPath);
}

module.exports = { startPanel, sleep, api, apiRaw, waitFor, makeZip, freePort, freePortBlock, fetchWithHost, ROOT };
