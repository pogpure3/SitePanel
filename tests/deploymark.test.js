'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { config } = require('../src/config');
const deploymark = require('../src/sites/deploymark');

function withTempData(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-deploymark-'));
  const previous = { tmpDir: config.tmpDir, sitesDir: config.sitesDir };
  config.tmpDir = path.join(root, 'tmp');
  config.sitesDir = path.join(root, 'sites');
  fs.mkdirSync(config.tmpDir, { recursive: true });
  fs.mkdirSync(config.sitesDir, { recursive: true });
  t.after(() => {
    config.tmpDir = previous.tmpDir;
    config.sitesDir = previous.sitesDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('маркер: ошибка записи прерывает файловую транзакцию', (t) => {
  const root = withTempData(t);
  const blocker = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  config.tmpDir = blocker;

  assert.throws(
    () => deploymark.writeMarker('site', { phase: 'backing-up' }),
    /EEXIST|ENOTDIR/,
  );
});

test('reconcile сохраняет маркер, если каталог пока нельзя восстановить', (t) => {
  withTempData(t);
  const id = 'retry-restore';
  const dir = path.join(config.sitesDir, id);
  const backup = dir + '.backup';
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'index.html'), 'old');
  deploymark.writeMarker(id, { backup, dir, phase: 'backing-up' });

  const renameSync = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (from === backup && to === dir) throw new Error('temporary rename failure');
    return renameSync(from, to);
  };
  try {
    const actions = deploymark.reconcile([{ id }], () => {});
    assert.match(actions[0].action, /восстановление не удалось/);
  } finally {
    fs.renameSync = renameSync;
  }

  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(backup), true);
  assert.equal(fs.existsSync(deploymark.markerFile(id)), true);
});
