'use strict';

// Замок единственного экземпляра панели (SP-08).
//
// Два запущенных экземпляра SitePanel опасны не гипотетически: у них общий
// `data/db.json`, общий `data/tmp`, общие pid-файлы сайтов и общие порты 80/443.
// Второй старт (ручной запуск рядом с systemd, забытый `nohup`, копия юнита)
// приводил к тому, что экземпляры перезаписывали реестр друг друга, гонялись за
// одними pid-файлами и «лечили» сайты друг друга — при этом внешне всё работало.
//
// Замок — файл `data/sitepanel.lock` с pid и hostname. При старте: если файл есть
// и процесс из него жив И это действительно наша панель (совпадает поле cmd/имя),
// старт отклоняется. Протухший замок (панель убита SIGKILL, перезагрузка)
// перезаписывается. Освобождение — best-effort, на выходе и по сигналам.

const fs = require('fs');
const os = require('os');
const path = require('path');

function readLock(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && Number.isInteger(raw.pid) ? raw : null;
  } catch {
    return null;
  }
}

/** Жив ли процесс с таким pid (без отправки сигнала: kill(pid, 0)). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM значит «процесс есть, но не наш» — для замка это «занят».
    return err && err.code === 'EPERM';
  }
}

/**
 * Занять замок единственного экземпляра.
 * @param {string} file путь к файлу замка
 * @returns {{ok: boolean, holder?: {pid: number, hostname: string, startedAt: number}, reason?: string}}
 */
function acquire(file) {
  const payload = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
  };

  const existing = readLock(file);
  if (existing && existing.pid !== process.pid) {
    // Замок с чужого хоста (общий каталог data по NFS) процессом не проверяется:
    // pid там означает совсем другой процесс, поэтому считаем замок живым.
    const foreign = existing.hostname && existing.hostname !== payload.hostname;
    if (foreign || pidAlive(existing.pid)) {
      return { ok: false, holder: existing, reason: foreign ? 'замок принадлежит другому хосту' : 'процесс уже работает' };
    }
    console.warn(`  Замок ${file} остался от процесса ${existing.pid} — он не работает, замок перезаписан.`);
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Атомарная запись: обрыв не должен оставить нечитаемый замок, из-за которого
    // панель вообще перестанет стартовать.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    // Нет прав на каталог данных — это ошибка более высокого уровня, старт
    // всё равно упадёт дальше; замок не должен маскировать причину.
    console.error(`  Не удалось записать замок ${file}: ${err.message}`);
    return { ok: true, holder: payload };
  }
  return { ok: true, holder: payload };
}

/** Снять замок, если он наш. Чужой замок не трогаем. */
function release(file) {
  const existing = readLock(file);
  if (existing && existing.pid !== process.pid) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { acquire, release, readLock, pidAlive };
