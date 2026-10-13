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
 * @param {object} config из src/config.js
 * @returns {number} сколько файлов удалось ужать
 */
function hardenDataDir(config) {
  if (process.platform === 'win32') return 0;
  const fsMod = fs;
  let fixed = 0;

  // Сам каталог данных тоже ужимаем: в нём лежат db.json с git-токенами и auth.json.
  // Раньше он оставался 0755 и просматривался любым пользователем машины (H-16).
  try {
    if ((fsMod.statSync(config.dataDir).mode & 0o777) !== MODE.PRIVATE_DIR) {
      fsMod.chmodSync(config.dataDir, MODE.PRIVATE_DIR);
      fixed++;
    }
  } catch { /* каталога нет — ensureDirs создаст его с нужным режимом */ }

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

  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fsMod.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Каталог с ключами сайта — только для владельца.
        try {
          if ((fsMod.statSync(full).mode & 0o777) !== MODE.PRIVATE_DIR) {
            fsMod.chmodSync(full, MODE.PRIVATE_DIR);
            fixed++;
          }
        } catch { /* не критично */ }
        walk(full, depth + 1);
      } else if (
        e.name === '.env' ||
        e.name === 'privkey.pem' ||
        e.name === 'auth.json' ||
        e.name === 'db.json' ||
        // Ключ аккаунта Let's Encrypt (data/acme/account-*.pem) — тоже приватный:
        // по нему панель аутентифицируется в ACME, утечка позволяет действовать от её имени.
        /^account-.*\.pem$/.test(e.name)
      ) {
        tightenIfNeeded(full, MODE.PRIVATE);
      }
    }
  };

  // data/ целиком: там лежат db.json, auth.json, certs/, sites/*/.env
  walk(config.dataDir);
  return fixed;
}

module.exports = { writePrivate, writePrivateAtomic, mkdirPrivate, tighten, hardenDataDir, MODE };
