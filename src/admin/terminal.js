'use strict';

// Веб-терминал админ-панели: WebSocket-канал к shell на сервере.
//
// Модель доступа. Токены одноразовые и короткоживущие: браузер получает их
// обычным авторизованным запросом (Basic + CSRF-заголовок), а WebSocket сам
// заголовков Basic не подставляет — поэтому рукопожатие подтверждается токеном
// из query. Токен гасится при первом использовании, живёт 30 секунд и не даёт
// повторного подключения после обрыва. Авторизация — ТОЛЬКО на выдаче токена:
// кто смог получить токен, тот уже прошёл Basic-проверку.
//
// PTY. Полноценный эмулятор терминала требует псевдотерминала на сервере.
// Нативный node-pty не входит в обязательные зависимости (сборка требует g++),
// поэтому три режима, по убыванию качества:
//   1) node-pty (optionalDependencies, если собрался) — полный PTY, resize;
//   2) `script -qfc <shell> /dev/null` из util-linux — настоящий PTY, но без
//      ioctl-ресайза: начальный размер задаётся через LINES/COLUMNS окружения,
//      последующие ресайзы делаются инъекцией `stty rows N cols M` во вход
//      (в терминале это видно как набранная команда — осознанная деградация);
//   3) сырой shell с пайпами — на Windows для локальной разработки.
//
// Отключение целиком: PANEL_TERMINAL=0.

const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { WebSocketServer } = require('ws');

const WS_PATH = '/api/terminal/ws';

// Лимиты: терминал — привилегированная функция, толпой её не открываем.
// Токены в полёте ограничены отдельно, чтобы невалидированные запросы не копились.
const TOKEN_TTL_MS = 30_000;
const MAX_PENDING_TOKENS = 8;
const MAX_SESSIONS = intEnv('PANEL_TERMINAL_MAX_SESSIONS', 3);
// Потолок на одно входящее сообщение (ввод пользователя): защита от переполнения
// памяти одним соединением.
const MAX_INPUT_BYTES = 16 * 1024;
// Полное отключение функции: PANEL_TERMINAL=0.
const TERMINAL_DISABLED = process.env.PANEL_TERMINAL === '0';

// node-pty — лучший режим; отсутствие сборки — не ошибка.
let pty = null;
try { pty = require('node-pty'); } catch { /* fallback ниже */ }

/** @type {Map<string, number>} токен -> expiresAt */
const tokens = new Map();
/** @type {Set<{child: object, kind: string, kill: Function}>} */
const sessions = new Set();

function intEnv(name, dflt) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function isDisabled() {
  return TERMINAL_DISABLED;
}

/* ---------- Токены ---------- */

function pruneTokens(now = Date.now()) {
  for (const [t, exp] of tokens) if (exp <= now) tokens.delete(t);
}

/**
 * Выдать одноразовый токен. Бросает {status:429} при переполнении очереди.
 */
function issueToken() {
  if (TERMINAL_DISABLED) {
    const err = new Error('Терминал отключён (PANEL_TERMINAL=0)');
    err.status = 403;
    throw err;
  }
  pruneTokens();
  if (tokens.size >= MAX_PENDING_TOKENS) {
    const err = new Error('Слишком много запросов токена — повторите через полминуты');
    err.status = 429;
    throw err;
  }
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return { token, ttlMs: TOKEN_TTL_MS, wsPath: WS_PATH };
}

/** Одноразовость: токен либо гасится, либо не принимается вовсе. */
function takeToken(token) {
  pruneTokens();
  if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return false;
  return tokens.delete(token);
}

/* ---------- Выбор shell ---------- */

function defaultShell() {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return process.env.SHELL && fs.existsSync(process.env.SHELL)
    ? process.env.SHELL
    : (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
}

/**
 * Три режима запуска, см. шапку файла.
 * @returns {{kind:'pty'|'script'|'raw', file:string, args:string[], env:object}}
 */
function shellSpec(cols, rows) {
  const shell = defaultShell();
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  if (pty) return { kind: 'pty', shell, env };
  if (process.platform !== 'win32' && fs.existsSync('/usr/bin/script')) {
    return {
      kind: 'script',
      file: '/usr/bin/script',
      args: ['-qfc', shell, '/dev/null'],
      env: { ...env, LINES: String(rows), COLUMNS: String(cols) },
    };
  }
  return { kind: 'raw', file: shell, args: process.platform === 'win32' ? [] : ['-i'], env };
}

/* ---------- Сессии ---------- */

function sessionCount() {
  return sessions.size;
}

/**
 * Запустить shell и связать с сокетом. Возвращает дескриптор сессии.
 */
function startSession(ws, { cols = 80, rows = 24 } = {}) {
  const spec = shellSpec(cols, rows);
  const safeCols = Math.min(500, Math.max(2, cols | 0));
  const safeRows = Math.min(200, Math.max(2, rows | 0));

  let child;
  let resize = () => {};
  if (spec.kind === 'pty') {
    child = pty.spawn(spec.shell, ['-i'], {
      name: 'xterm-256color',
      cols: safeCols,
      rows: safeRows,
      env: spec.env,
      cwd: process.env.HOME || '/',
    });
    resize = (c, r) => { try { child.resize(c, r); } catch { /* сессия гаснет */ } };
  } else {
    child = spawn(spec.file || spec.shell, spec.args || [], {
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Отдельная группа: на закрытии убиваем всё дерево (npm-дети и т.п.).
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    resize = (c, r) => {
      // Деградация без PTY: ресайз — обычная команда во входном потоке.
      if (spec.kind === 'script') {
        try { child.stdin.write(`stty rows ${r} cols ${c}\n`); } catch { /* гаснет */ }
      }
    };
  }

  const session = { child, kind: spec.kind, resize, closed: false };

  const killTree = () => {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session);
    try {
      if (spec.kind === 'pty') child.kill();
      else if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* уже мёртв */ }
  };

  // UTF-8 собирается через StringDecoder: чанки stdout режут мультибайтные
  // символы посередине, и побайтовый toString давал бы «кракозябры».
  const decoder = new StringDecoder('utf8');
  const onData = (chunk) => {
    if (ws.readyState === ws.OPEN) {
      // Текстовые кадры, а не бинарные: часть вебвью (in-app browser) не доставляет
      // бинарные кадры WebSocket-клиенту — ввод до сервера доходил, вывод нет.
      // xterm.write() принимает строки напрямую.
      ws.send(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    }
  };
  if (spec.kind === 'pty') {
    child.onData(onData);
    child.onExit(killTree);
  } else {
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', killTree);
    child.on('error', (err) => {
      onData(`\r\n[SitePanel] не удалось запустить shell: ${err.message}\r\n`);
      killTree();
      try { ws.close(1011, 'shell failed'); } catch { /* уже закрыт */ }
    });
  }

  ws.on('message', (data, isBinary) => {
    if (session.closed) return;
    const buf = isBinary ? data : Buffer.from(data);
    if (process.env.PANEL_TERMINAL_DEBUG === '1') {
      console.log(`[terminal] msg ${buf.length}B binary=${isBinary}: ${JSON.stringify(buf.toString('utf8').slice(0, 60))}`);
    }
    if (buf.length > MAX_INPUT_BYTES) return;
    // JSON-сообщения — служебные (resize); всё прочее — ввод пользователя.
    if (buf.length > 0 && buf[0] === 0x7b /* '{' */) {
      try {
        const msg = JSON.parse(buf.toString('utf8'));
        if (msg && msg.type === 'resize') {
          resize(Math.min(500, Math.max(2, msg.cols | 0)), Math.min(200, Math.max(2, msg.rows | 0)));
          return;
        }
      } catch { /* не JSON — обычный ввод */ }
    }
    try {
      if (spec.kind === 'pty') {
        child.write(buf.toString('utf8'));
      } else {
        // cmd.exe с пайпами не считает одиночный CR концом строки (Enter в xterm
        // шлёт именно '\r'): на Windows в raw-режиме дополняем до CRLF.
        const text = process.platform === 'win32' && spec.kind === 'raw'
          ? buf.toString('utf8').replace(/\r(?!\n)/g, '\r\n')
          : buf;
        child.stdin.write(text);
      }
    } catch { /* поток закрылся */ }
  });

  ws.on('close', killTree);
  ws.on('error', killTree);

  // Приветственная строка — ясность, чей терминал и в каком режиме.
  const host = require('os').hostname();
  onData(`SitePanel shell @ ${host} (режим: ${spec.kind === 'pty' ? 'PTY' : spec.kind})\r\n`);
  sessions.add(session);
  return session;
}

/* ---------- WebSocket-сервер ---------- */

let wss = null;

/**
 * Same-origin для рукопожатия (H-21): браузерный кросс-сайтовый WS несёт чужой
 * Origin. Отсутствие Origin — не-браузерный клиент; ему всё равно нужен токен,
 * который без Basic и CSRF-заголовка не выдать.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let h;
  try {
    h = new URL(String(origin)).host.toLowerCase();
  } catch {
    return false;
  }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0].trim().toLowerCase();
  return h === host;
}

/**
 * Повесить терминал на HTTP-сервер админки.
 * @param {import('http').Server} server
 */
function attach(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });
  wss.on('connection', (ws) => {
    if (sessions.size >= MAX_SESSIONS) {
      try { ws.close(1008, 'too many sessions'); } catch { /* noop */ }
      return;
    }
    startSession(ws, {});
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const pathname = (req.url || '').split('?')[0];
      if (pathname !== WS_PATH) return socket.destroy(); // апгрейды не к терминалу админке не нужны
      if (TERMINAL_DISABLED) return socket.destroy();
      if (!originAllowed(req)) return socket.destroy();
      const url = new URL(req.url, 'http://x');
      if (!takeToken(url.searchParams.get('token') || '')) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch {
      try { socket.destroy(); } catch { /* noop */ }
    }
  });
}

/** Погасить все сессии (остановка панели). */
function shutdown() {
  for (const s of [...sessions]) {
    try {
      if (s.kind === 'pty') s.child.kill();
      else if (process.platform !== 'win32') process.kill(-s.child.pid, 'SIGKILL');
      else s.child.kill('SIGKILL');
    } catch { /* уже мёртв */ }
  }
  sessions.clear();
  tokens.clear();
}

module.exports = {
  WS_PATH,
  issueToken,
  takeToken,
  attach,
  shutdown,
  isDisabled,
  sessionCount,
  // для тестов
  _shellSpec: shellSpec,
  _originAllowed: originAllowed,
};
