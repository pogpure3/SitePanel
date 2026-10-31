'use strict';

/* global window, document, loopBadge, statusLabelFull, sslInfoHtml, openModal, closeModal */

// Индикаторы состояния/SSL и модалки — проверяются в РЕАЛЬНОМ браузере
// (Playwright): функции вызываются в загруженной панелью странице, DOM настоящий.
// Раньше app.js исполнялся в vm-песочнице с заглушками DOM: это (а) ловилось
// сканером безопасности как динамическое исполнение кода, (б) проверяло заглушки,
// а не реальный браузерный DOM. Без Playwright (CI без браузеров) работают
// статические проверки исходников — они же страхуют от случайного удаления
// функций при рефакторинге.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { startPanel } = require('./helpers/panel');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
  if (!fs.existsSync(chromium.executablePath())) chromium = null;
} catch { /* Playwright не установлен — статический fallback */ }

const PUB = path.join(__dirname, '..', 'src', 'admin', 'public');
// Порядок загрузки = index.html (views ДО каркаса app.js).
const VIEW_ORDER = [
  'views-list', 'views-site', 'views-files', 'views-backups',
  'views-dashboard', 'views-settings', 'views-users', 'views-terminal',
];
const FRONTEND = VIEW_ORDER
  .map((n) => fs.readFileSync(path.join(PUB, n + '.js'), 'utf8'))
  .concat([fs.readFileSync(path.join(PUB, 'app.js'), 'utf8')])
  .join(String.fromCharCode(10));

/** Запускает панель и браузер; в t.after — закрытие того и другого. */
async function withBrowser(t) {
  const panel = await startPanel({});
  const browser = await chromium.launch();
  t.after(async () => {
    try { await browser.close(); } catch { /* уже закрыт */ }
    await panel.stop();
  });
  const page = await browser.newPage();
  await page.goto(panel.base + '/', { waitUntil: 'domcontentloaded' });
  // Каркас рисует дашборд после первого ответа API.
  await page.waitForFunction(() => typeof window.loopBadge === 'function', null, { timeout: 15000 });
  return { panel, page };
}

/* ---------- Статические проверки (работают всегда) ---------- */

test('исходники содержат функции индикаторов и модалок (страховка от потери при рефакторинге)', () => {
  for (const fn of ['function loopBadge(', 'function statusLabelFull(', 'function sslInfoHtml(', 'function openModal(', 'function closeModal(']) {
    assert.ok(FRONTEND.includes(fn), `во фронтенде нет ${fn}`);
  }
  for (const marker of ['loop-warn', 'loop-bad', 'цикл перезапуска', 'Покрытие привязанных доменов']) {
    assert.ok(FRONTEND.includes(marker), `во фронтенде нет маркера ${marker}`);
  }
});

/* ---------- Поведение в реальном браузере ---------- */

test('loopBadge: обычный работающий сайт — без индикатора', async (t) => {
  if (!chromium) return t.skip('playwright не установлен — остаются статические проверки');
  const { page } = await withBrowser(t);
  const html = await page.evaluate(() => loopBadge({ status: 'running', restartAttempts: 0, restartCount: 0 }));
  assert.equal(html, '');
});

test('loopBadge: идёт серия падений — жёлтый индикатор с номером попытки', async (t) => {
  if (!chromium) return t.skip('playwright не установлен — остаются статические проверки');
  const { page } = await withBrowser(t);
  const html = await page.evaluate(() => loopBadge({ status: 'crashed', restartAttempts: 2, restartCount: 2 }));
  assert.match(html, /loop-warn/);
  assert.match(html, /перезапуск №2/);
});

test('loopBadge: лимит исчерпан — красный индикатор «цикл перезапуска»', async (t) => {
  if (!chromium) return t.skip('playwright не установлен — остаются статические проверки');
  const { page } = await withBrowser(t);
  const html = await page.evaluate(() => loopBadge({
    status: 'crashed', crashLoop: true, restartAttempts: 6, restartCount: 6, lastCrashAt: 1791673542402,
  }));
  assert.match(html, /loop-bad/);
  assert.match(html, /цикл перезапуска/);
  assert.match(html, /6/, 'должно быть видно число перезапусков');
});

test('statusLabelFull: показывает причину состояния', async (t) => {
  if (!chromium) return t.skip('playwright не установлен — остаются статические проверки');
  const { page } = await withBrowser(t);
  const crash = await page.evaluate(() => statusLabelFull('crashed', { crashLoop: true, restartCount: 6, restartAttempts: 6 }));
  assert.match(crash, /цикл перезапуска/);
  assert.match(crash, /6/);
  const plain = await page.evaluate(() => statusLabelFull('running', {}));
  assert.equal(plain, 'Работает');
});

test('sslInfoHtml: показывает, какие привязанные домены не покрыты сертификатом', async (t) => {
  if (!chromium) return t.skip('playwright не установлен — остаются статические проверки');
  const { page } = await withBrowser(t);
  const site = {
    domains: ['a.test', 'b.test'],
    ssl: { status: 'active', provider: 'letsencrypt', domains: ['a.test'], issuedAt: 1, expiresAt: 2 },
  };
  const html = await page.evaluate((s) => sslInfoHtml(s), site);
  assert.match(html, /Покрытие привязанных доменов/);
  assert.match(html, /a\.test/);
  assert.match(html, /b\.test/);
});

test('sslInfoHtml: домены сертификата, отвязанные от сайта, помечаются отдельно', async (t) => {
  if (!chromium) return t.skip('playwright не установлен — остаются статические проверки');
  const { page } = await withBrowser(t);
  const site = {
    domains: ['a.test'],
    ssl: { status: 'active', provider: 'letsencrypt', domains: ['a.test', 'old.test'], expiresAt: 2 },
  };
  const html = await page.evaluate((s) => sslInfoHtml(s), site);
  assert.match(html, /old\.test/);
  assert.match(html, /уже не привязан|отвязан/i);
});

test('sslInfoHtml: wildcard помечается «без сертификата» (HTTP-01 невозможен)', async (t) => {
  if (!chromium) return t.skip('playwright не установлен — остаются статические проверки');
  const { page } = await withBrowser(t);
  // Таблица покрытия рисуется только при активном сертификате: wildcard привязан,
  // но в сертификат не входит (выпуск по HTTP-01 его не покрывает).
  const site = {
    domains: ['*.a.test'],
    ssl: { status: 'active', provider: 'letsencrypt', domains: ['a.test'], issuedAt: 1, expiresAt: 2 },
  };
  const html = await page.evaluate((s) => sslInfoHtml(s), site);
  assert.match(html, /без сертификата/);
  assert.match(html, /DNS-01/);
});

test('sslInfoHtml: без активного сертификата списка покрытия нет', async (t) => {
  if (!chromium) return t.skip('playwright не установлен — остаются статические проверки');
  const { page } = await withBrowser(t);
  const site = { domains: ['a.test'], ssl: { status: 'none' } };
  const html = await page.evaluate((s) => sslInfoHtml(s), site);
  assert.doesNotMatch(html, /Покрытие привязанных доменов/);
  assert.match(html, /Без SSL/);
});

test('модалки: openModal/closeModal меняют класс и возвращают фокус', async (t) => {
  if (!chromium) return t.skip('playwright не установлен — остаются статические проверки');
  const { page } = await withBrowser(t);
  const result = await page.evaluate(() => {
    const trigger = document.getElementById('addSiteBtn');
    trigger.focus();
    openModal('confirmModal');
    const backdrop = document.getElementById('confirmModal');
    const opened = !backdrop.classList.contains('hidden');
    const focusInModal = backdrop.contains(document.activeElement);
    closeModal('confirmModal');
    const closed = backdrop.classList.contains('hidden');
    const focusBack = document.activeElement === trigger;
    return { opened, focusInModal, closed, focusBack };
  });
  assert.equal(result.opened, true, 'окно должно открыться');
  assert.equal(result.focusInModal, true, 'фокус должен уйти в окно');
  assert.equal(result.closed, true, 'окно должно закрыться');
  assert.equal(result.focusBack, true, 'фокус должен вернуться на триггер');
});

test('select: единый компонент меняет значение и подключает динамические списки', async (t) => {
  if (!chromium) return t.skip('playwright не установлен — остаются статические проверки');
  const { page } = await withBrowser(t);
  await page.evaluate(() => globalThis.openBackupSchedule('test', { scope: 'site', intervalHours: 24, keep: 5 }));
  const picker = page.locator('#backupScheduleScope').locator('..');
  await picker.locator('.select-toggle').click();
  assert.equal(await picker.locator('.select-toggle').getAttribute('aria-expanded'), 'true');
  await picker.locator('[data-select-index="2"]').click();
  assert.equal(await page.locator('#backupScheduleScope').inputValue(), 'full');
  assert.equal(await picker.locator('.select-toggle span').textContent(), 'Полный');
  await page.evaluate(() => closeModal('backupModal'));

  await page.evaluate(() => {
    const select = document.createElement('select');
    select.id = 'dynamic-select-test';
    select.setAttribute('aria-label', 'Динамический список');
    select.innerHTML = '<option value="a">Первый</option><option value="b">Второй</option>';
    document.body.appendChild(select);
  });
  await page.waitForFunction(() => document.querySelector('#dynamic-select-test')?.closest('.select-picker'));
  const dynamic = page.locator('#dynamic-select-test').locator('..');
  await dynamic.locator('.select-toggle').click();
  await dynamic.locator('[data-select-index="1"]').click();
  assert.equal(await page.locator('#dynamic-select-test').inputValue(), 'b');
  assert.equal(await dynamic.locator('.select-toggle span').textContent(), 'Второй');
});
