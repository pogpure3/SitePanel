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
 * Запускает команду в каталоге с ограничением времени.
 * @returns {Promise<{code:number, timedOut:boolean, output:string}>}
 */
function runCommand(cmd, cwd, onLine, timeoutMs, extraEnv = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, PORT: '', ...extraEnv },
      });
    } catch (err) {
      if (onLine) onLine('[panel] ' + err.message);
      return resolve({ code: 1, timedOut: false, output: err.message });
    }

    let acc = '';
    let all = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // shell:true — убиваем дерево, иначе дочерние процессы останутся висеть.
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      } catch {
        /* уже мёртв */
      }
    }, Math.max(1000, timeoutMs));

    const feed = (d) => {
      const text = d.toString();
      all += text;
      acc += text;
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
      clearTimeout(timer);
      if (onLine) onLine('[panel] ' + err.message);
      resolve({ code: 1, timedOut: false, output: all });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (acc.trim() && onLine) onLine(acc.trimEnd());
      resolve({ code: code === null ? 1 : code, timedOut, output: all });
    });
  });
}

module.exports = { detectManager, runCommand, isLockMismatch, MANAGERS };
