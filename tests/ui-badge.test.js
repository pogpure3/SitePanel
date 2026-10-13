'use strict';

// Проверка индикатора цикла перезапуска: вычисляем loopBadge() из реального app.js
// в изолированной области видимости (без DOM и сборки).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'public', 'app.js'), 'utf8');

/** Заглушка DOM-элемента: app.js на старте вешает обработчики на шапку. */
function stubElement(id) {
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    title: '',
    href: '',
    disabled: false,
    offsetParent: {},
    dataset: {},
    style: {},
    files: [],
    classList: {
      _hidden: true,
      add(c) { if (c === 'hidden') this._hidden = true; },
      remove(c) { if (c === 'hidden') this._hidden = false; },
      toggle() {},
      contains(c) { return c === 'hidden' ? this._hidden : false; },
    },
    addEventListener() {},
    removeEventListener() {},
    focus() { el.focused = true; },
    select() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    remove() {},
    scrollIntoView() {},
    getAttribute: () => null,
    setAttribute() {},
    hasAttribute: () => false,
    closest: () => null,
    onclick: null,
    onkeydown: null,
  };
  return el;
}

function makeSandbox(overrides = {}) {
  const elements = new Map();
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    document: {
      addEventListener() {},
      getElementById: (id) => {
        if (overrides.elements && overrides.elements[id]) return overrides.elements[id];
        if (!elements.has(id)) elements.set(id, stubElement(id));
        return elements.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => stubElement(tag),
      activeElement: overrides.activeElement || null,
      contains: () => true,
      body: stubElement('body'),
    },
    // app.js подписывается на hashchange (U-12) и читает location.hash на старте.
    window: { addEventListener() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    location: { reload() {}, hash: '' },
    FormData: function FormData() { this.append = () => {}; },
    XMLHttpRequest: function XMLHttpRequest() {
      this.open = () => {};
      this.setRequestHeader = () => {};
      this.addEventListener = () => {};
      this.send = () => {};
      this.upload = { addEventListener: () => {} };
    },
    Blob: function Blob() {},
  };
  vm.createContext(sandbox);
  return sandbox;
}

/** Вычисляет выражение в контексте app.js (после его загрузки). */
function evalInApp(expr) {
  const sandbox = makeSandbox();
  vm.runInContext(APP, sandbox);
  return vm.runInContext(expr, sandbox);
}

test('loopBadge: обычный работающий сайт — без индикатора', () => {
  const html = evalInApp('loopBadge({ status: "running", restartAttempts: 0, restartCount: 0 })');
  assert.equal(html, '');
});

test('loopBadge: идёт серия падений — жёлтый индикатор с номером попытки', () => {
  const html = evalInApp('loopBadge({ status: "crashed", restartAttempts: 2, restartCount: 2 })');
  assert.match(html, /loop-warn/);
  assert.match(html, /перезапуск №2/);
});

test('loopBadge: лимит исчерпан — красный индикатор «цикл перезапуска»', () => {
  const html = evalInApp('loopBadge({ status: "crashed", crashLoop: true, restartAttempts: 6, restartCount: 6, lastCrashAt: 1791673542402 })');
  assert.match(html, /loop-bad/);
  assert.match(html, /цикл перезапуска/);
  assert.match(html, /6/, 'должно быть видно число перезапусков');
});

test('statusLabelFull: показывает причину состояния', () => {
  const crash = evalInApp('statusLabelFull("crashed", { crashLoop: true, restartCount: 6, restartAttempts: 6 })');
  assert.match(crash, /цикл перезапуска/);
  assert.match(crash, /6/);
  const plain = evalInApp('statusLabelFull("running", {})');
  assert.equal(plain, 'Работает');
});

/* ---------- sslInfoHtml: покрытие привязанных доменов сертификатом ---------- */

test('sslInfoHtml: показывает, какие привязанные домены не покрыты сертификатом', () => {
  const site = {
    domains: ['a.test', 'b.test'],
    ssl: { status: 'active', provider: 'letsencrypt', domains: ['a.test'], issuedAt: 1, expiresAt: 2 },
  };
  const html = evalInApp(`sslInfoHtml(${JSON.stringify(site)})`);
  assert.match(html, /Покрытие привязанных доменов/);
  assert.match(html, /a\.test/);
  assert.match(html, /покрыт/);
  assert.match(html, /b\.test/, 'непокрытый домен не показан');
  assert.match(html, /не покрыт/, 'нет пометки «не покрыт»');
  assert.match(html, /перевыпустите/i, 'нет подсказки о перевыпуске');
});

test('sslInfoHtml: домены сертификата, отвязанные от сайта, помечаются отдельно', () => {
  const site = {
    domains: ['a.test'],
    ssl: { status: 'active', provider: 'letsencrypt', domains: ['a.test', 'old.test'], issuedAt: 1, expiresAt: 2 },
  };
  const html = evalInApp(`sslInfoHtml(${JSON.stringify(site)})`);
  assert.match(html, /old\.test/, 'лишний домен сертификата не показан');
  assert.match(html, /уже не привязаны/);
});

test('sslInfoHtml: wildcard помечается «без сертификата» (HTTP-01 невозможен)', () => {
  const site = {
    domains: ['a.test', '*.w.test'],
    ssl: { status: 'active', provider: 'letsencrypt', domains: ['a.test'], issuedAt: 1, expiresAt: 2 },
  };
  const html = evalInApp(`sslInfoHtml(${JSON.stringify(site)})`);
  assert.match(html, /\*\.w\.test/);
  assert.match(html, /без сертификата/);
  assert.doesNotMatch(html, /перевыпустите/i, 'wildcard не должен требовать перевыпуска LE');
});

test('sslInfoHtml: без активного сертификата списка покрытия нет', () => {
  const site = { domains: ['a.test'], ssl: { status: 'none' } };
  const html = evalInApp(`sslInfoHtml(${JSON.stringify(site)})`);
  assert.doesNotMatch(html, /Покрытие привязанных доменов/);
  assert.match(html, /Без SSL/);
});

test('модалки: openModal/closeModal меняют класс и возвращают фокус', () => {
  const trigger = stubElement('trigger');
  const button = stubElement('okBtn');
  const backdrop = stubElement('testModal');

  const sandbox = makeSandbox({
    activeElement: trigger,
    elements: { testModal: backdrop },
  });
  // У модалки должна быть кнопка для передачи фокуса.
  backdrop.querySelectorAll = (sel) => (sel.includes('button') ? [button] : []);
  sandbox.document.querySelectorAll = (sel) => (sel === '.modal-backdrop' ? [backdrop] : []);

  vm.runInContext(APP, sandbox);

  vm.runInContext('openModal("testModal")', sandbox);
  assert.equal(backdrop.classList._hidden, false, 'окно должно открыться');
  assert.equal(button.focused, true, 'фокус должен уйти в окно');

  vm.runInContext('closeModal("testModal")', sandbox);
  assert.equal(backdrop.classList._hidden, true, 'окно должно закрыться');
  assert.equal(trigger.focused, true, 'фокус должен вернуться на триггер');
});
