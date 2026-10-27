'use strict';

// Ресурсы сервера (Node.js, PHP, Docker, Next.js): обнаружение установленных
// версий, список доступных и установка/обновление. apt-пакеты ставятся
// системным пакетным менеджером, Next.js — глобально через npm.

const { execFile } = require('child_process');

// Версия из ответа CLI проходит строгую проверку: она же вернётся в select
// формы и пойдёт в argv установщика (без shell, но проверка дёшева и честна).
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+~:_-]{0,63}$/;

const RESOURCES = [
  { id: 'nodejs', title: 'Node.js', kind: 'apt', pkg: 'nodejs', bin: 'node' },
  { id: 'php', title: 'PHP', kind: 'apt', pkg: 'php', bin: 'php' },
  { id: 'docker', title: 'Docker', kind: 'apt', pkg: 'docker-ce', bin: 'docker' },
  { id: 'nextjs', title: 'Next.js (глобально, npm)', kind: 'npm', pkg: 'next', bin: 'next' },
];

function run(cmd, args, opts = {}) {
  // shortcut: на Windows dev-машине npm — npm.cmd, а Node отказывается спавнить
  // .cmd без shell (EINVAL) — синхронный бросок гасим, ресурс получит пустой
  // список. На стендах (Linux) npm — обычный бинар, всё работает.
  if (cmd === 'npm' && process.platform === 'win32') cmd = 'npm.cmd';
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { timeout: opts.timeoutMs || 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '') });
      });
    } catch {
      return resolve({ code: 1, out: '' });
    }
    if (!child) resolve({ code: 1, out: '' });
  });
}

/** Первая версия вида 1.2.3 в выводе `bin --version`. */
function parseVersion(out) {
  const m = /v?(\d+(?:\.\d+)+[-\w.]*)/.exec(String(out));
  return m ? m[1] : null;
}

async function installedVersion(res) {
  const r = await run(res.bin, ['--version'], { timeoutMs: 8000 });
  if (r.code !== 0) return null;
  return parseVersion(r.out);
}

/** Доступные версии apt-пакета (madison) — уникальные, свежие сверху. */
async function aptVersions(pkg) {
  const r = await run('apt-cache', ['madison', pkg]);
  if (r.code !== 0) return [];
  const seen = new Set();
  const list = [];
  for (const line of r.out.split('\n')) {
    const ver = line.split('|')[1]?.trim();
    if (ver && VERSION_RE.test(ver) && !seen.has(ver)) {
      seen.add(ver);
      list.push(ver);
    }
  }
  return list.slice(0, 30);
}

/** Релизные версии npm-пакета (без -canary/-rc), свежие сверху. */
async function npmVersions(pkg) {
  const r = await run('npm', ['view', pkg, 'versions', '--json'], { timeoutMs: 60000 });
  if (r.code !== 0) return [];
  let arr;
  try { arr = JSON.parse(r.out); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.filter((v) => /^\d+\.\d+\.\d+$/.test(v)).slice(-30).reverse();
}

/** Сводка по всем ресурсам: установленная версия + доступные. */
async function listRuntimes() {
  const out = [];
  for (const res of RESOURCES) {
    const [installed, available] = await Promise.all([
      installedVersion(res),
      res.kind === 'apt' ? aptVersions(res.pkg) : npmVersions(res.pkg),
    ]);
    out.push({ id: res.id, title: res.title, kind: res.kind, installed, available });
  }
  return out;
}

/**
 * Установить/обновить ресурс. Версия опциональна: без неё apt/npm возьмут
 * кандидата. Установка идёт без shell (execFile), версия строго валидируется.
 * @returns {Promise<{ok: boolean, output: string}>}
 */
async function installRuntime(id, version) {
  const res = RESOURCES.find((r) => r.id === id);
  if (!res) {
    const err = new Error('Неизвестный ресурс');
    err.status = 404;
    throw err;
  }
  if (version !== undefined && version !== null && version !== '' && !VERSION_RE.test(version)) {
    const err = new Error('Недопустимая версия');
    err.status = 400;
    throw err;
  }
  const args = res.kind === 'apt'
    ? ['install', '-y', '--allow-downgrades', ...(version ? [`${res.pkg}=${version}`] : [res.pkg])]
    : ['install', '-g', version ? `${res.pkg}@${version}` : `${res.pkg}@latest`];
  const r = await run(res.kind === 'apt' ? 'apt-get' : 'npm', args, { timeoutMs: 10 * 60 * 1000 });
  const tail = r.out.length > 4000 ? '…' + r.out.slice(-4000) : r.out;
  if (r.code !== 0) {
    const err = new Error('Установка не удалась (код ' + r.code + '):\n' + tail);
    err.status = 500;
    throw err;
  }
  return { ok: true, output: tail };
}

module.exports = { listRuntimes, installRuntime, parseVersion, RESOURCES };
