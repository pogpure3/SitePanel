'use strict';

// Права на файлы с секретами: приватные ключи SSL, .env, db.json, auth.json
// не должны быть читаемы другими пользователями системы (0644 — регрессия).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const secure = require('../src/securefile');

const isPosix = process.platform !== 'win32';
const modeOf = (f) => fs.statSync(f).mode & 0o777;

test('writePrivate: файл получает режим 0600', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-secure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'privkey.pem');
  secure.writePrivate(file, 'KEY');
  assert.equal(fs.readFileSync(file, 'utf8'), 'KEY');
  if (isPosix) assert.equal(modeOf(file), 0o600, 'приватный файл должен быть 0600');
});

test('writePrivate: сужает права у уже существующего файла', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-secure2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, 'old', { mode: 0o644 });
  if (isPosix) {
    fs.chmodSync(file, 0o644);
    assert.equal(modeOf(file), 0o644, 'подготовка: файл открыт');
  }
  secure.writePrivate(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  if (isPosix) assert.equal(modeOf(file), 0o600, 'writeFileSync не меняет режим — нужен chmod');
});

test('mkdirPrivate: каталог получает режим 0700', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-secure3-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'certs', 'abc');
  secure.mkdirPrivate(dir);
  assert.ok(fs.existsSync(dir));
  if (isPosix) assert.equal(modeOf(dir), 0o700, 'каталог с ключами должен быть 0700');
});

test('writePrivate принимает явный режим (публичный сертификат — 0644)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-secure4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fullchain.pem');
  secure.writePrivate(file, 'CERT', 0o644);
  if (isPosix) assert.equal(modeOf(file), 0o644);
});

test('hardenDataDir: ужимает уже созданные секреты', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-hard-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const certsDir = path.join(dataDir, 'certs', 'site1');
  const sitesDir = path.join(dataDir, 'sites', 'site1');
  fs.mkdirSync(certsDir, { recursive: true });
  fs.mkdirSync(sitesDir, { recursive: true });
  const files = {
    [path.join(certsDir, 'privkey.pem')]: 'KEY',
    [path.join(sitesDir, '.env')]: 'SECRET=1',
    [path.join(dataDir, 'db.json')]: '{}',
    [path.join(dataDir, 'auth.json')]: '{}',
  };
  for (const f of Object.keys(files)) fs.writeFileSync(f, files[f], { mode: 0o644 });

  const fixed = secure.hardenDataDir({ dataDir });
  if (isPosix) {
    assert.ok(fixed >= 4, `ожидалось ≥4 исправленных файла, получено ${fixed}`);
    for (const f of Object.keys(files)) {
      assert.equal(modeOf(f), 0o600, `${path.basename(f)} должен стать 0600`);
    }
  } else {
    assert.equal(fixed, 0, 'на Windows режимы не применяются');
  }
});

test('hardenDataDir: не падает на пустом/отсутствующем каталоге', () => {
  assert.equal(secure.hardenDataDir({ dataDir: path.join(os.tmpdir(), 'sp-nonexistent-' + Date.now()) }), 0);
});

test('hardenDataDir: закрывает ключ аккаунта ACME (account-*.pem)', (t) => {
  // Регрессия с реальной установки: data/acme/account-production.pem лежал как 0644.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-acme-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const acmeDir = path.join(dataDir, 'acme');
  fs.mkdirSync(acmeDir, { recursive: true });

  const prod = path.join(acmeDir, 'account-production.pem');
  const stage = path.join(acmeDir, 'account-staging.pem');
  for (const f of [prod, stage]) fs.writeFileSync(f, 'ACME-KEY', { mode: 0o644 });

  secure.hardenDataDir({ dataDir });
  if (isPosix) {
    assert.equal(modeOf(prod), 0o600, 'ключ аккаунта production должен быть 0600');
    assert.equal(modeOf(stage), 0o600, 'ключ аккаунта staging должен быть 0600');
  }
});

test('hardenDataDir: не трогает публичный fullchain.pem', (t) => {
  // Публичная часть цепочки не секрет — ей положен 0644.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-chain-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = path.join(dataDir, 'certs', 's1');
  fs.mkdirSync(dir, { recursive: true });
  const chain = path.join(dir, 'fullchain.pem');
  fs.writeFileSync(chain, 'CERT', { mode: 0o644 });

  secure.hardenDataDir({ dataDir });
  if (isPosix) assert.equal(modeOf(chain), 0o644, 'fullchain.pem остаётся читаемым');
});

test('исходники: секреты пишутся через secure, а не напрямую', () => {
  const root = path.join(__dirname, '..', 'src');
  const checks = [
    ['ssl/certs.js', /fs\.writeFileSync\(/, 'приватные ключи'],
    ['ssl/acme.js', /fs\.writeFileSync\(/, 'ключ аккаунта ACME'],
    ['auth.js', /fs\.writeFileSync\(/, 'auth.json'],
    ['store.js', /fs\.writeFileSync\(/, 'db.json'],
  ];
  const bad = [];
  for (const [rel, re, what] of checks) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    if (re.test(src)) bad.push(`${rel}: остался прямой fs.writeFileSync (${what})`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});
