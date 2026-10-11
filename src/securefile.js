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

/** Режимы, которые имеет смысл использовать. */
const MODE = {
  PRIVATE: 0o600, // файл только для владельца
  PRIVATE_DIR: 0o700, // каталог только для владельца
};

/**
 * Записать файл, ограничив права владельцем.
 * @param {string} file путь
 * @param {string|Buffer} data содержимое
 * @param {number} [mode] режим (по умолчанию 0600)
 */
function writePrivate(file, data, mode = MODE.PRIVATE) {
  fs.writeFileSync(file, data, { mode });
  // Если файл уже существовал, writeFileSync не меняет его режим — доводим явно.
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* Windows: права задаются ACL, а не mode */
  }
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

  const tightenIfNeeded = (file, mode) => {
    try {
      const st = fsMod.statSync(file);
      if ((st.mode & 0o777) > mode) {
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
      const full = require('path').join(dir, e.name);
      if (e.isDirectory()) {
        // Каталог с ключами сайта — только для владельца.
        try {
          if ((fsMod.statSync(full).mode & 0o777) > MODE.PRIVATE_DIR) fsMod.chmodSync(full, MODE.PRIVATE_DIR);
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

module.exports = { writePrivate, mkdirPrivate, tighten, hardenDataDir, MODE };
