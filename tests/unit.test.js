'use strict';

// Юнит-тесты чистой логики: защита путей и математика бэкоффа.

const test = require('node:test');
const assert = require('node:assert');

const { isBlockedPath } = require('../src/httpserver');

test('isBlockedPath: блокирует dot-файлы и node_modules', () => {
  // Секреты и служебные данные — не должны раздаваться.
  assert.equal(isBlockedPath('/.env'), true);
  assert.equal(isBlockedPath('/.git/config'), true);
  assert.equal(isBlockedPath('/sub/.env'), true);
  assert.equal(isBlockedPath('/node_modules/express/index.js'), true);
  assert.equal(isBlockedPath('/NODE_MODULES/x.js'), true, 'регистр не важен');
  assert.equal(isBlockedPath('/.htaccess'), true);
  assert.equal(isBlockedPath('/.well-known/security.txt'), true);
  assert.equal(isBlockedPath('/a/./b'), true);
});

test('isBlockedPath: пропускает обычный контент', () => {
  assert.equal(isBlockedPath('/'), false);
  assert.equal(isBlockedPath('/index.html'), false);
  assert.equal(isBlockedPath('/assets/app.js'), false);
  assert.equal(isBlockedPath('/uploads/photo.png'), false);
  assert.equal(isBlockedPath('/my.node_modules/x'), false, 'подстрока — не сегмент');
  assert.equal(isBlockedPath('/env'), false);
  assert.equal(isBlockedPath(''), false);
});

test('nextBackoffDelay: нарастает и ограничена сверху', () => {
  const { nextBackoffDelay } = require('../src/sites/manager');
  assert.equal(nextBackoffDelay(1), 1000);
  assert.equal(nextBackoffDelay(2), 4000);
  assert.equal(nextBackoffDelay(3), 16000);
  assert.equal(nextBackoffDelay(4), 64000);
  assert.equal(nextBackoffDelay(5), 256000);
  assert.equal(nextBackoffDelay(9), 300000, 'потолок 5 минут');
  // Некорректный вход не должен давать NaN/0-задержку (иначе — цикл перезапусков).
  assert.equal(nextBackoffDelay(0), 1000);
  assert.equal(nextBackoffDelay(undefined), 1000);
});

test('конфиг: бэкофф и порты по умолчанию', () => {
  const { config } = require('../src/config');
  assert.equal(config.restartMaxAttempts, 5);
  assert.equal(config.restartStableSec, 60);
  assert.equal(config.restartCooldownMin, 10);
});
