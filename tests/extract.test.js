'use strict';

// Регрессия: права доступа и symlink'и при распаковке zip-архива сайта.
//
// Раньше manager.js читал внешние атрибуты записи как `entry.header.attributes`,
// но у adm-zip это свойство называется `attr` (геттер на central header), и
// свойства `attributes` в библиотеке нет вообще. Опечатка делала entryMode()
// всегда возвращающей null: executable-бит молча терялся (скрипты вида
// scripts/start.sh приезжали неисполняемыми), а вся ветка обработки symlink'ов
// в extractZip была мёртвым кодом — небезопасные ссылки не отсекались как
// задумано, потому что до проверки дело не доходило.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const manager = require('../src/sites/manager');

const isPosix = process.platform !== 'win32';

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

/** Есть ли системный zip (умеет сохранять symlink'и и unix-права). */
function hasZipCli() {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Собирает zip системным zip: он пишет настоящие unix-режимы (включая symlink). */
function makeZipCli(dir, zipPath, names) {
  execFileSync('zip', ['-y', '-q', zipPath, ...names], { cwd: dir, stdio: 'ignore' });
}

/* ---------- entryMode: чтение внешних атрибутов ---------- */

test('entryMode: читает unix-режим из attr (регрессия на опечатку attributes)', () => {
  // Ровно те значения, которые выдаёт adm-zip для реальных записей.
  assert.equal(manager.entryMode({ attr: (0o100644 << 16) >>> 0 }), 0o100644, 'обычный файл');
  assert.equal(manager.entryMode({ attr: (0o100755 << 16) >>> 0 }), 0o100755, 'executable');
  assert.equal(manager.entryMode({ attr: (0o120777 << 16) >>> 0 }), 0o120777, 'symlink');
});

test('entryMode: понимает attr и на header (вложенный объект)', () => {
  assert.equal(manager.entryMode({ header: { attr: (0o100755 << 16) >>> 0 } }), 0o100755);
});

test('entryMode: несуществующее attributes даёт null — это и была ошибка', () => {
  // Документируем баг: именно так выглядела запись для старого кода, и он
  // возвращал null, из-за чего права не применялись.
  assert.equal(manager.entryMode({ header: { attributes: (0o100755 << 16) >>> 0 } }), null);
  assert.equal(manager.entryMode({ header: {} }), null);
  assert.equal(manager.entryMode({}), null);
  assert.equal(manager.entryMode(null), null);
  // Нулевой режим (DOS-атрибуты без unix-части) тоже null, а не 0.
  assert.equal(manager.entryMode({ attr: 0 }), null);
});

/* ---------- extractZip: права и symlink'и на диске ---------- */

test('extractZip: executable-бит из архива сохраняется', (t) => {
  if (!isPosix) return t.skip('unix-права только на POSIX');
  const src = tmpDir(t, 'sp-mode-src-');
  const out = tmpDir(t, 'sp-mode-out-');
  const zipPath = path.join(tmpDir(t, 'sp-mode-zip-'), 'site.zip');

  fs.mkdirSync(path.join(src, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(src, 'scripts', 'start.sh'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(src, 'scripts', 'start.sh'), 0o755);
  fs.writeFileSync(path.join(src, 'index.html'), '<h1>ok</h1>');
  fs.chmodSync(path.join(src, 'index.html'), 0o644);

  // adm-zip.addLocalFile берёт режим с диска — так архив и получает 0755.
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addLocalFile(path.join(src, 'scripts', 'start.sh'), 'scripts');
  zip.addLocalFile(path.join(src, 'index.html'));
  zip.writeZip(zipPath);

  manager.extractZip(zipPath, out);

  const modeOf = (p) => fs.statSync(p).mode & 0o777;
  assert.equal(modeOf(path.join(out, 'scripts', 'start.sh')), 0o755, 'скрипт должен остаться исполняемым');
  assert.equal(modeOf(path.join(out, 'index.html')) & 0o111, 0, 'обычный файл не должен стать исполняемым');
});

test('extractZip: symlink внутри каталога сайта создаётся', (t) => {
  if (!isPosix || !hasZipCli()) return t.skip('нужен POSIX и системный zip');
  const src = tmpDir(t, 'sp-link-src-');
  const out = tmpDir(t, 'sp-link-out-');
  const zipPath = path.join(tmpDir(t, 'sp-link-zip-'), 'site.zip');

  fs.writeFileSync(path.join(src, 'target.txt'), 'hello');
  fs.symlinkSync('target.txt', path.join(src, 'link.txt'));

  makeZipCli(src, zipPath, ['target.txt', 'link.txt']);
  const res = manager.extractZip(zipPath, out);

  assert.equal(res.links, 1, 'должна быть создана одна ссылка');
  assert.ok(fs.lstatSync(path.join(out, 'link.txt')).isSymbolicLink(), 'link.txt должен быть symlink');
  assert.equal(fs.readFileSync(path.join(out, 'link.txt'), 'utf8'), 'hello');
});

test('extractZip: symlink за пределы каталога сайта не создаётся', (t) => {
  if (!isPosix || !hasZipCli()) return t.skip('нужен POSIX и системный zip');
  const src = tmpDir(t, 'sp-evil-src-');
  const out = tmpDir(t, 'sp-evil-out-');
  const zipPath = path.join(tmpDir(t, 'sp-evil-zip-'), 'site.zip');

  fs.writeFileSync(path.join(src, 'index.html'), '<h1>ok</h1>');
  // Ссылка наружу: /etc/passwd (абсолютная) и ../outside (выход через «..»).
  fs.symlinkSync('/etc/passwd', path.join(src, 'absolute.txt'));
  fs.symlinkSync('../outside.txt', path.join(src, 'relative.txt'));

  makeZipCli(src, zipPath, ['index.html', 'absolute.txt', 'relative.txt']);
  const res = manager.extractZip(zipPath, out);

  assert.equal(res.links, 0, 'ни одна опасная ссылка не должна быть создана');
  assert.ok(!fs.existsSync(path.join(out, 'absolute.txt')), 'абсолютная ссылка отсечена');
  assert.ok(!fs.existsSync(path.join(out, 'relative.txt')), 'ссылка через .. отсечена');
  // Обычный контент при этом распакован.
  assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /ok/);
});
