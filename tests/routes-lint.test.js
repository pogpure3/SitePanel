'use strict';

// Статическая проверка: нельзя отдавать в res.json() необработанный промис.
// Регрессия, которую этот тест ловит: manager.stop() стал async (мьютекс),
// а маршрут остался `res.json(manager.stop(site))` — Express сериализовал
// промис в пустой объект {}, и клиент молча терял результат.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Функции менеджера, которые асинхронны (возвращают промис).
const ASYNC_MANAGER = [
  'start', 'stop', 'restart', 'deploy', 'deployFromGit', 'rollback', 'removeSite',
];

test('res.json() не получает промис напрямую', () => {
  const files = [
    path.join(ROOT, 'src', 'admin', 'routes.js'),
  ];
  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = /res\.json\(\s*([^)]*)\)/.exec(line);
      if (!m) return;
      const arg = m[1];
      // await внутри вызова — корректно.
      if (/\bawait\b/.test(arg)) return;
      // Прямой вызов асинхронного метода менеджера без await.
      for (const fn of ASYNC_MANAGER) {
        if (new RegExp(`manager\\.${fn}\\s*\\(`).test(arg)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}: res.json(${arg.trim()})`);
        }
      }
      // Любой вызов .then()-подобного вида без await — подозрительно.
      if (/res\.json\(\s*[A-Za-z_$][\w$]*\.\w+\(/.test(arg) && !/await/.test(line)) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}: возможно необработанный промис: ${arg.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], 'Найдены необработанные промисы в ответах:\n' + offenders.join('\n'));
});

test('все маршруты обёрнуты в wrap() и используют await для менеджера', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'admin', 'routes.js'), 'utf8');
  // Каждый router.<method>( должен иметь wrap(async ...) в той же строке.
  const bad = [];
  const re = /router\.(get|post|put|patch|delete)\(([^\n]*)$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const line = m[2];
    if (!/wrap\(async/.test(line)) bad.push(m[0].trim());
  }
  assert.deepEqual(bad, [], 'Маршруты без wrap(async):\n' + bad.join('\n'));

  // manager.deploy/stop/... без await — типичная ошибка после введения мьютекса.
  const lines = src.split('\n');
  const missing = [];
  lines.forEach((line, i) => {
    for (const fn of ASYNC_MANAGER) {
      if (new RegExp(`manager\\.${fn}\\s*\\(`).test(line) && !/await/.test(line)) {
        missing.push(`routes.js:${i + 1}: ${line.trim()}`);
      }
    }
  });
  assert.deepEqual(missing, [], 'manager.* вызван без await:\n' + missing.join('\n'));
});
