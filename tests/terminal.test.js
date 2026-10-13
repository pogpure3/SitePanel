'use strict';

// Юнит-тесты веб-терминала (src/admin/terminal.js): жизненный цикл одноразовых
// токенов, same-origin проверка апгрейда, выбор режима shell. Без реального
// spawn — процессы не запускаются, сессии не открываются.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Изолированный каталог данных не нужен: terminal.js ничего не пишет на диск,
// но config требуется другим модулям цепочки require (config -> store и т.д.).
process.env.PANEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-term-'));

const terminal = require('../src/admin/terminal');

test('токен: выдаётся, одноразовый, принимается один раз', () => {
  const { token } = terminal.issueToken();
  assert.match(token, /^[0-9a-f]{48}$/, 'токен — 48 hex-символов (24 байта)');
  assert.ok(terminal.takeToken(token), 'свежий токен принимается');
  assert.ok(!terminal.takeToken(token), 'повторное использование отвергается');
  assert.ok(!terminal.takeToken(''), 'пустой токен отвергается');
  assert.ok(!terminal.takeToken('x'.repeat(48)), 'неизвестный токен отвергается');
  assert.ok(!terminal.takeToken('<script>alert(1)</script>' + 'a'.repeat(24)), 'мусор вместо токена отвергается');
});

test('токен: переполнение очереди выдачи ограничено (429)', () => {
  const issued = [];
  for (let i = 0; i < 8; i++) issued.push(terminal.issueToken().token);
  assert.throws(() => terminal.issueToken(), (err) => err.status === 429, '9-й токен подряд не выдаётся');
  // Освобождаем: погашение токенов возвращает возможность выдачи.
  for (const t of issued) assert.ok(terminal.takeToken(t));
  const next = terminal.issueToken();
  assert.ok(next.token, 'после погашения очередь снова работает');
  assert.ok(terminal.takeToken(next.token));
});

test('origin: same-origin проходит, чужой и битый — нет', () => {
  const req = (origin, host, fwd) => ({
    headers: { ...(origin ? { origin } : {}), host, ...(fwd ? { 'x-forwarded-host': fwd } : {}) },
  });
  // Браузер на том же хосте (в том числе за nginx, который сохраняет Host).
  assert.ok(terminal._originAllowed(req('https://panel.example.ru', 'panel.example.ru')));
  assert.ok(terminal._originAllowed(req('https://panel.example.ru:8443', 'panel.example.ru:8443')));
  // Не-браузерный клиент без Origin — допустим (защита токеном).
  assert.ok(terminal._originAllowed(req(undefined, 'panel.example.ru')));
  // Чужой сайт — отвергается.
  assert.ok(!terminal._originAllowed(req('https://evil.example', 'panel.example.ru')));
  // Мусор в Origin — отвергается.
  assert.ok(!terminal._originAllowed(req('not a url', 'panel.example.ru')));
});

test('shellSpec: fallback-цепочка соответствует окружению', () => {
  const spec = terminal._shellSpec(120, 40);
  // node-pty — optional-зависимость: где собрался, там и полный PTY.
  let ptyLoaded = false;
  try { require('node-pty'); ptyLoaded = true; } catch { /* нет сборки */ }
  if (ptyLoaded) {
    assert.equal(spec.kind, 'pty');
    return;
  }
  if (process.platform === 'win32') {
    // Windows (локальная разработка): сырой shell без PTY.
    assert.equal(spec.kind, 'raw');
    assert.match(spec.file, /cmd(\.exe)?$/i);
  } else if (fs.existsSync('/usr/bin/script')) {
    // Linux с util-linux: режим script — настоящий PTY, размер в окружении.
    assert.equal(spec.kind, 'script');
    assert.equal(spec.env.LINES, '40');
    assert.equal(spec.env.COLUMNS, '120');
    assert.equal(spec.env.TERM, 'xterm-256color');
  } else {
    assert.equal(spec.kind, 'raw');
  }
});
