'use strict';

// Регрессия T-04/P-12/P-13/P-28/P-29: блокировка сайта.
//
// `withSiteLock` — единственное, что мешает двум запросам одновременно
// распаковывать архив в один каталог и поднимать два процесса на один порт.
// Здесь проверяются три свойства, которые раньше не покрывались:
//   * операции одного сайта строго последовательны, разных — параллельны;
//   * повторный вход падает сразу, а не самоблокируется навсегда;
//   * запись в Map освобождается, а не копится по одной на каждый сайт.

const test = require('node:test');
const assert = require('node:assert');

const { withSiteLock, forgetSiteLock, pendingLocks, outsideLock } = require('../src/sites/lock');
const { sleep } = require('./helpers/panel');

test('операции одного сайта выполняются строго по очереди', async () => {
  const order = [];
  const task = (n) => withSiteLock('serial', async () => {
    order.push(`start${n}`);
    await sleep(30);
    order.push(`end${n}`);
  });
  await Promise.all([task(1), task(2), task(3)]);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
});

test('операции разных сайтов идут параллельно', async () => {
  const events = [];
  const started = Date.now();
  await Promise.all([
    withSiteLock('a', async () => { events.push('a-start'); await sleep(120); events.push('a-end'); }),
    withSiteLock('b', async () => { events.push('b-start'); await sleep(120); events.push('b-end'); }),
  ]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 230, `последовательное выполнение: ${elapsed} мс вместо параллельного`);
  assert.deepEqual(events.slice(0, 2), ['a-start', 'b-start']);
});

test('повторный вход отклоняется, а не подвешивает операцию', async () => {
  await assert.rejects(
    () => withSiteLock('reentrant', async () => withSiteLock('reentrant', async () => 'никогда')),
    /повторный вход/
  );
  // После отказа блокировка снова свободна.
  assert.equal(await withSiteLock('reentrant', async () => 'ok'), 'ok');
});

test('ошибка внутри операции не «залипает» в очереди', async () => {
  await assert.rejects(() => withSiteLock('failing', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withSiteLock('failing', async () => 'после ошибки'), 'после ошибки');
});

test('ожидание предыдущей операции: результат не теряется', async () => {
  let value = 0;
  const inc = () => withSiteLock('counter', async () => {
    const cur = value;
    await sleep(10);
    value = cur + 1;
  });
  await Promise.all([inc(), inc(), inc()]);
  assert.equal(value, 3, 'при гонке значение потерялось бы');
});

test('P-29: запись освобождается после завершения операций', async () => {
  for (let i = 0; i < 20; i++) {
    await withSiteLock(`site-${i}`, async () => i);
  }
  // Даём микрозадачам доехать.
  await sleep(20);
  assert.equal(pendingLocks(), 0, `Map держит ${pendingLocks()} записей вместо 0`);
});

test('P-29: запись освобождается и после ошибки', async () => {
  for (let i = 0; i < 10; i++) {
    await withSiteLock(`err-${i}`, async () => { throw new Error('fail'); }).catch(() => {});
  }
  await sleep(20);
  assert.equal(pendingLocks(), 0);
});

test('P-29: forgetSiteLock снимает запись', async () => {
  await withSiteLock('forgettable', async () => 'x');
  forgetSiteLock('forgettable');
  assert.equal(pendingLocks(), 0);
});

test('P-28: forgetSiteLock внутри удерживаемой операции не ломает очередь', async () => {
  // Так делает removeSite: снимает запись, ещё удерживая блокировку.
  const out = await withSiteLock('remove-me', async () => {
    forgetSiteLock('remove-me');
    return 'done';
  });
  assert.equal(out, 'done');
  // Следующая операция того же сайта проходит нормально (очередь не потеряна).
  assert.equal(await withSiteLock('remove-me', async () => 'again'), 'again');
});

test('outsideLock: таймер из операции берёт блокировку заново без отказа', async () => {
  // removeSite/бэкофф планируют таймер ВНУТРИ удерживаемой операции; колбэк
  // наследует AsyncLocalStorage, и без outsideLock такой запуск выглядел бы
  // повторным входом. Ждать его внутри той же блокировки нельзя (самоблокировка),
  // поэтому операция только планирует таймер, а результат забираем снаружи.
  let resume;
  const done = new Promise((resolve) => { resume = resolve; });
  let innerError = null;

  await withSiteLock('timers', async () => {
    setTimeout(outsideLock(() => {
      withSiteLock('timers', async () => 'inner-ok').then(resume, (err) => { innerError = err; resume(null); });
    }), 10);
  });

  const result = await done;
  assert.equal(innerError, null, `внутренний запуск отказал: ${innerError && innerError.message}`);
  assert.equal(result, 'inner-ok');
});
