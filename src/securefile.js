'use strict';

// Запись файлов с ограниченными правами.
//
// Приватные ключи SSL, .env, db.json (в нём могут лежать git-токены) и auth.json
// пишутся по умолчанию с режимом 0644 — то есть читаемы любым пользователем
// системы. Для панели, которая хостит чужие приложения, это лишняя поверхность
// атаки: код сайта исполняется на той же машине.
//
// На Windows аргумент mode у fs почти не влияет (права управляются ACL),
// поэтому ошибки игнорируем — на POSIX режим применяется.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Режимы, которые имеет смысл использовать. */
const MODE = {
  PRIVATE: 0o600, // файл только для владельца
  PRIVATE_DIR: 0o700, // каталог только для владельца
};

/**
 * Записать файл атомарно: временный файл рядом → fsync → rename → fsync каталога.
 *
 * Зачем не `fs.writeFileSync` напрямую: запись «в тот же файл» при потере питания
 * или падении процесса оставляет обрезанный файл (на ext4 — часто нулевой длины).
 * Для `db.json` это означает потерю реестра сайтов, для `privkey.pem` — нерабочий
 * TLS. fsync данных и каталога закрывает окно, в котором rename уже виден, а
 * содержимое ещё в кэше (SP-02).
 *
 * Имя временного файла уникально (pid + случайный суффикс), поэтому два процесса
 * панели не перемешивают буферы друг друга (часть SP-08).
 *
 * @param {string} file путь
 * @param {string|Buffer} data содержимое
 * @param {number} [mode] режим (по умолчанию 0600)
 * @returns {string} путь записанного файла
 */
function writePrivateAtomic(file, data, mode = MODE.PRIVATE) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'
  );

  let fd;
  try {
    fd = fs.openSync(tmp, 'w', mode);
  } catch (err) {
    // Каталога нет — создаём и пробуем ещё раз (вызывающие обычно делают это сами).
    if (err.code === 'ENOENT') {
      mkdirPrivate(dir);
      fd = fs.openSync(tmp, 'w', mode);
    } else {
      throw err;
    }
  }
  try {
    fs.writeFileSync(fd, data);
    try {
      fs.fchmodSync(fd, mode);
    } catch {
      /* Windows: права задаются ACL, а не mode */
    }
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* уже закрыт */ }
    try { fs.unlinkSync(tmp); } catch { /* нет файла */ }
    throw err;
  }
  fs.closeSync(fd);

  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* нет файла */ }
    throw err;
  }

  // Сбрасываем на диск и саму запись каталога: иначе после выключения питания
  // файла может не оказаться, хотя rename уже вернулся успешно.
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch {
    /* Windows и некоторые ФС не дают открыть каталог — не критично */
  }

  // Если файл уже существовал, режим мог остаться прежним — доводим явно.
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* Windows: права задаются ACL, а не mode */
  }
  return file;
}

/**
 * Записать файл, ограничив права владельцем (атомарно, см. writePrivateAtomic).
 * @param {string} file путь
 * @param {string|Buffer} data содержимое
 * @param {number} [mode] режим (по умолчанию 0600)
 */
function writePrivate(file, data, mode = MODE.PRIVATE) {
  return writePrivateAtomic(file, data, mode);
}

/** Создать каталог только для владельца. */
function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: MODE.PRIVATE_DIR });
  try {
    fs.chmodSync(dir, MODE.PRIVATE_DIR);
  } catch {
    /* Windows */
  }
}

/** Довести права уже существующего файла (для миграции старых установок). */
function tighten(file, mode = MODE.PRIVATE) {
  try {
    fs.chmodSync(file, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Разовая миграция: ужать права на уже созданные секреты в каталоге данных.
 * Панель, установленная до этой правки, писала privkey.pem, .env, db.json
 * и auth.json с режимом 0644 — читаемыми любому пользователю машины.
 * Вызывается при старте; на Windows chmod почти ничего не делает и это нормально.
 *
 * Выполняется ОДИН РАЗ по маркеру (M-04): раньше каждый старт обходил всё
 * дерево data/ — включая node_modules сайтов — и выставлял права заново,
 * в том числе в цикле перезапусков. Список путей теперь фиксированный; при
 * его изменении нужно поднять HARDEN_VERSION — миграция выполнится ещё раз.
 *
 * @param {object} config из src/config.js (используется dataDir)
 * @returns {number} сколько файлов/каталогов удалось ужать
 */
const HARDEN_VERSION = 2;

function hardenDataDir(config) {
  if (process.platform === 'win32') return 0;
  const fsMod = fs;
  const dataDir = config.dataDir;
  if (!fsMod.existsSync(dataDir)) return 0;
  const marker = path.join(dataDir, '.permissions-hardened');
  try {
    if (fsMod.readFileSync(marker, 'utf8').trim() === String(HARDEN_VERSION)) return 0;
  } catch { /* маркера нет — выполняем миграцию */ }

  let fixed = 0;

  const tightenDirIfNeeded = (dir) => {
    try {
      if ((fsMod.statSync(dir).mode & 0o777) !== MODE.PRIVATE_DIR) {
        fsMod.chmodSync(dir, MODE.PRIVATE_DIR);
        fixed++;
      }
    } catch { /* нет каталога — нечего делать */ }
  };

  const tightenIfNeeded = (file, mode) => {
    try {
      const st = fsMod.statSync(file);
      // Сравниваем ИМЕННО биты прав, а не величину: режимы 0444/0440/0400
      // численно МЕНЬШЕ 0600, но по-прежнему читаемы группой и остальными.
      // Раньше условие `(mode & 0o777) > mode` такие файлы пропускало (H-16).
      if ((st.mode & 0o777) !== mode) {
        fsMod.chmodSync(file, mode);
        fixed++;
      }
    } catch {
      /* нет файла — нечего делать */
    }
  };

  // Сам каталог данных: в нём db.json с git-токенами и auth.json (H-16).
  tightenDirIfNeeded(dataDir);
  for (const name of ['sites', 'certs', 'logs', 'tmp', 'acme']) {
    tightenDirIfNeeded(path.join(dataDir, name));
  }
  // Секреты верхнего уровня. state.json — защёлки алертов, секрет не обязателен,
  // но читать его посторонним незачем.
  for (const name of ['db.json', 'auth.json', 'state.json']) {
    tightenIfNeeded(path.join(dataDir, name), MODE.PRIVATE);
  }

  // Каталоги сайтов: сам каталог 0700 и переносимые секреты 0600. Вглубь
  // (node_modules, контент сайта) не спускаем — это не секреты панели (M-04).
  try {
    for (const e of fsMod.readdirSync(path.join(dataDir, 'sites'), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(dataDir, 'sites', e.name);
      tightenDirIfNeeded(dir);
      for (const secret of ['.env', 'config.json']) {
        tightenIfNeeded(path.join(dir, secret), MODE.PRIVATE);
      }
    }
  } catch { /* каталога sites может не быть */ }

  // Сертификаты: каталог сайта 0700 и privkey.pem 0600; fullchain.pem —
  // публичный, остаётся 0644.
  try {
    for (const e of fsMod.readdirSync(path.join(dataDir, 'certs'), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(dataDir, 'certs', e.name);
      tightenDirIfNeeded(dir);
      tightenIfNeeded(path.join(dir, 'privkey.pem'), MODE.PRIVATE);
    }
  } catch { /* каталога certs может не быть */ }

  // Ключ аккаунта Let's Encrypt: по нему панель аутентифицируется в ACME.
  try {
    for (const e of fsMod.readdirSync(path.join(dataDir, 'acme'), { withFileTypes: true })) {
      if (e.isFile() && /^account-.*\.pem$/.test(e.name)) {
        tightenIfNeeded(path.join(dataDir, 'acme', e.name), MODE.PRIVATE);
      }
    }
  } catch { /* каталога acme может не быть */ }

  // Маркер — после прохода; при падении записи миграция повторится при старте.
  try {
    writePrivateAtomic(marker, HARDEN_VERSION + '\n');
  } catch { /* не критично */ }
  return fixed;
}

module.exports = { writePrivate, writePrivateAtomic, mkdirPrivate, tighten, hardenDataDir, MODE };
