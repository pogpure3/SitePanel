'use strict';

// Мьютекс на сайт: сериализует операции, меняющие файлы и процесс
// (деплой, откат, старт/стоп, удаление), чтобы два параллельных запроса
// не работали с одним каталогом и не порождали два процесса на один порт.

const { AsyncLocalStorage } = require('async_hooks');

const chains = new Map(); // siteId -> Promise (хвост очереди)
const held = new AsyncLocalStorage(); // siteId, удерживаемый текущей операцией

/**
 * Выполняет fn, удерживая блокировку сайта. Вызовы для одного siteId
 * выполняются строго по очереди; для разных сайтов — параллельно.
 * @param {string} siteId
 * @param {Function} fn
 */
function withSiteLock(siteId, fn) {
  const id = String(siteId);
  // Повторный вход (fn вызывает другую публичную функцию того же сайта) —
  // это ошибка, приводящая к самоблокировке. Падаем сразу, а не висим.
  if (held.getStore() === id) {
    return Promise.reject(new Error('Внутренняя ошибка: повторный вход в блокировку сайта ' + id));
  }

  const prev = chains.get(id) || Promise.resolve();
  const run = prev.then(
    () => held.run(id, fn),
    () => held.run(id, fn)
  );
  // Хвост очереди не должен «залипать» на ошибке предыдущей операции.
  chains.set(id, run.then(() => {}, () => {}));
  return run;
}

/** Снимает запись после удаления сайта (иначе Map растёт). */
function forgetSiteLock(siteId) {
  chains.delete(String(siteId));
}

/** Для диагностики/тестов: есть ли незавершённые операции. */
function pendingLocks() {
  return [...chains.keys()].length;
}

/**
 * Снимает контекст блокировки для асинхронного продолжения.
 * Нужно для таймеров, созданных внутри защищённой операции (бэкофф, остывание):
 * AsyncLocalStorage протекает в их колбэки, и попытка взять блокировку заново
 * выглядела бы как повторный вход. Для нового запуска контекст не нужен.
 */
function outsideLock(fn) {
  return (...args) => held.exit(fn, undefined, ...args);
}

module.exports = { withSiteLock, forgetSiteLock, pendingLocks, outsideLock };
