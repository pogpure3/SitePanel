'use strict';

// Раннер тестов без внешних зависимостей.
// Зачем не `node --test` напрямую:
//   * на Node 20 нельзя передать glob («Could not find ... *.test.js»);
//   * bare-режим рекурсивно сканирует дерево и подхватывает тесты размещённых
//     сайтов из data/sites/*/tests/ — они падают и портят результат.
// Поэтому сами собираем только tests/*.test.js и передаём их списком.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Этот файл лежит в tests/, поэтому каталог тестов — рядом с ним.
const testsDir = __dirname;
const files = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(testsDir, f));

if (!files.length) {
  console.error('Не найдено ни одного tests/*.test.js');
  process.exit(1);
}

console.log(`Запускаю ${files.length} файл(ов) тестов:\n  ${files.map((f) => path.basename(f)).join('\n  ')}\n`);

const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});
