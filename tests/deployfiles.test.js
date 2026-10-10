'use strict';

// Определение менеджера пакетов и running-команды.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectManager, isLockMismatch } = require('../src/sites/deployfiles');

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('detectManager: выбирает менеджер по lock-файлу', (t) => {
  const cases = [
    { lock: 'package-lock.json', expect: 'npm' },
    { lock: 'npm-shrinkwrap.json', expect: 'npm' },
    { lock: 'yarn.lock', expect: 'yarn' },
    { lock: 'pnpm-lock.yaml', expect: 'pnpm' },
    { lock: 'bun.lockb', expect: 'bun' },
  ];
  for (const c of cases) {
    const dir = tmpProject({ 'package.json': '{}', [c.lock]: '' });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.equal(detectManager(dir).name, c.expect, `${c.lock} должен давать ${c.expect}`);
  }
});

test('detectManager: без lock-файла — npm install', (t) => {
  const dir = tmpProject({ 'package.json': '{}' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pm = detectManager(dir);
  assert.equal(pm.name, 'npm');
  assert.match(pm.install, /npm install/);
});

test('detectManager: pnpm имеет приоритет над npm', (t) => {
  const dir = tmpProject({ 'package.json': '{}', 'package-lock.json': '', 'pnpm-lock.yaml': '' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(detectManager(dir).name, 'pnpm');
});

test('npm ci имеет запасной вариант при рассинхроне lock-файла', (t) => {
  const dir = tmpProject({ 'package.json': '{}', 'package-lock.json': '' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pm = detectManager(dir);
  assert.match(pm.install, /npm ci/);
  assert.match(pm.frozenFallback, /npm install/);
});

test('isLockMismatch распознаёт ошибки frozen-lockfile', () => {
  assert.equal(isLockMismatch('npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync'), true);
  assert.equal(isLockMismatch('error Your lockfile needs to be updated'), true);
  assert.equal(isLockMismatch('ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"'), true);
  assert.equal(isLockMismatch('npm ERR! network timeout'), false);
  assert.equal(isLockMismatch(''), false);
});
