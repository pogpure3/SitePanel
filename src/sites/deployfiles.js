'use strict';

// Установка зависимостей сайта: определяем менеджер пакетов по lock-файлу
// и всегда ограничиваем выполнение таймаутом (зависший npm install иначе
// блокирует деплой навсегда, а вместе с ним — мьютекс сайта).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Приоритет: pnpm -> yarn -> bun -> npm. package-lock.json — самый частый случай.
const MANAGERS = [
  { name: 'pnpm', lock: ['pnpm-lock.yaml'], install: 'pnpm install --frozen-lockfile', frozenFallback: 'pnpm install' },
  { name: 'yarn', lock: ['yarn.lock'], install: 'yarn install --frozen-lockfile', frozenFallback: 'yarn install' },
  { name: 'bun', lock: ['bun.lockb', 'bun.lock'], install: 'bun install --frozen-lockfile', frozenFallback: 'bun install' },
  {
    name: 'npm',
    lock: ['package-lock.json', 'npm-shrinkwrap.json'],
    // ci ставит строго по lock-файлу; если он рассинхронизирован — падаем в install.
    install: 'npm ci --no-audit --no-fund',
    frozenFallback: 'npm install --no-audit --no-fund',
  },
];

const DEFAULT_FALLBACK = 'npm install --no-audit --no-fund';

// Переменные окружения, которые видят размещённые сайты (установка, сборка,
// рантайм). Раньше сюда попадало ВСЁ окружение панели (`...process.env`), то есть
// `PANEL_*` и любые секреты из `Environment=` systemd-юнита уезжали в код,
// залитый через панель (P-32). Список — allow-list: минимум, нужный node/npm,
// плюс явное расширение оператором через PANEL_SITE_ENV_PASSTHROUGH.
const PASSTHROUGH_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'USER',
  'LOGNAME',
  'TERM',
];

/**
 * Окружение для процессов размещённого сайта.
 * @param {object} [extra] дополнительные переменные (PORT, SITE_ID, …)
 * @returns {Record<string,string>}
 */
function siteEnv(extra = {}) {
  const env = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const extraKeys = String(process.env.PANEL_SITE_ENV_PASSTHROUGH || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const key of extraKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // PATH обязателен: без него не найдётся даже сам `node`.
  if (!env.PATH) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return { ...env, ...extra };
}

/** Определяет менеджер пакетов по lock-файлу в каталоге. */
function detectManager(dir) {
  for (const m of MANAGERS) {
    if (m.lock.some((f) => fs.existsSync(path.join(dir, f)))) return m;
  }
  return { name: 'npm', install: DEFAULT_FALLBACK, frozenFallback: DEFAULT_FALLBACK, lock: [] };
}

/** Ошибка из-за рассинхронизации lock-файла: тогда имеет смысл обычный install. */
function isLockMismatch(output) {
  const s = String(output || '');
  return (
    /lock\s*file/i.test(s) ||
    /frozen-lockfile/i.test(s) ||
    // npm: «`npm ci` can only install packages when ... are in sync»
    /npm ci/i.test(s) ||
    /OUTDATED_LOCKFILE/i.test(s)
  );
}

/**
 * Реестр ЖИВЫХ install/build-подпроцессов.
 *
 * Задача 2.2 (SP-05): инсталлятор деплоя — обычный (`shell:true`, своя группа) процесс,
 * он не попадает в общий реестр `processes` панели, поэтому SIGTERM при остановке
 * панели до него не доходил: установка продолжала писать в `data/tmp/deploy-*` уже
 * после выхода панели. Здесь команды регистрируются, а shutdown их гасит.
 */
const activeCommands = new Set();

function killActiveCommands(signal = 'SIGKILL') {
  const killed = [];
  for (const child of activeCommands) {
    if (!child || !child.pid) continue;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
      }
      killed.push(child.pid);
    } catch {
      /* уже мёртв */
    }
  }
  return killed;
}

/**
 * Запускает команду в каталоге с ограничением времени.
 * @returns {Promise<{code:number, timedOut:boolean, output:string}>}
 */
function runCommand(cmd, cwd, onLine, timeoutMs, extraEnv = {}, options = {}) {
  return new Promise((resolve) => {
    let child;
    // Бюджет времени стартует ДО spawn: между вызовами npmInstall (установка корня
    // монорепо, потом подкаталога, потом сборка) время не сбрасывается, иначе
    // суммарное удержание блокировки сайта ограничивалось бы только числом шагов (P-32).
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Date.now() + Math.max(1000, timeoutMs);
    const leftMs = Math.max(1000, deadline - Date.now());
    try {
      child = spawn(cmd, {
        cwd,
        shell: true,
        // Своя группа процессов: убийство по `-pgid` достаёт до npm/build-потомков,
        // а одиночный `child.kill('SIGKILL')` оставлял их жить после таймаута (P-22).
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: siteEnv({ PORT: '', ...extraEnv }),
      });
    } catch (err) {
      if (onLine) onLine('[panel] ' + err.message);
      return resolve({ code: 1, timedOut: false, output: err.message });
    }
    activeCommands.add(child);

    // Буферы ограничены: установка зависимостей болтает десятками мегабайт, и
    // неограниченный `all` держал их в памяти до конца команды (P-23).
    const MAX_ACC = 256 * 1024;
    const MAX_ALL = 1024 * 1024;
    let acc = '';
    let all = '';
    let allTruncated = false;
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // shell:true + detached — убиваем ГРУППУ, иначе потомки останутся висеть.
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      } catch {
        /* уже мёртв */
      }
      // Если группа не поднялась (detached не сработал), добиваем одиночный pid.
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* уже мёртв */ }
      }, 2000).unref();
    }, leftMs);

    const feed = (d) => {
      const text = d.toString();
      if (all.length < MAX_ALL) all += text; else allTruncated = true;
      acc += text;
      if (acc.length > MAX_ACC) acc = acc.slice(-MAX_ACC);
      let idx;
      while ((idx = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, idx).trimEnd();
        acc = acc.slice(idx + 1);
        if (line && onLine) onLine(line);
      }
    };

    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      activeCommands.delete(child);
      clearTimeout(timer);
      if (onLine) onLine('[panel] ' + err.message);
      resolve({ code: 1, timedOut: false, output: all });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      activeCommands.delete(child);
      clearTimeout(timer);
      if (acc.trim() && onLine) onLine(acc.trimEnd());
      if (allTruncated) all += '\n[panel] вывод команды усечён';
      resolve({ code: code === null ? 1 : code, timedOut, output: all });
    });
  });
}

module.exports = { detectManager, runCommand, isLockMismatch, siteEnv, MANAGERS, killActiveCommands, activeCommands };
