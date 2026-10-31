'use strict';

// Браузерный прогон UI (задача 6.2 / T-25/T-38/T-39 плана).
// Требует playwright + chromium: npm i -D playwright && npx playwright install chromium.
// Без установленного браузера весь файл скипается — набор остаётся зелёным
// на стендах и CI без Chromium.
//
// Проверки:
//   T-25  интерфейс открывается и работает без ошибок консоли;
//   U-12  hash-роутинг: #/sites/<id> открывает страницу сайта напрямую;
//   U-02  ячейки истории health видимы (display, а не 0x0);
//   U-04  модальное окно закрывается кликом по подложке;
//   U-08  домены видны в карточке и отвязываются кнопкой;
//   U-09  автообновление логов останавливается при уходе со страницы сайта;
//   A-02  поле токена Telegram — password и пустое.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startPanel, api, makeZip, sleep } = require('./helpers/panel');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
  if (!fs.existsSync(chromium.executablePath())) chromium = null;
} catch { /* playwright не установлен — скипаем */ }

async function withBrowser(t, panel) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  t.after(async () => {
    await browser.close();
    await panel.stop();
  });
  return { page, consoleErrors };
}

async function uploadStaticSite(t, panel, tmp, name, domain) {
  const zip = path.join(tmp, `${name}.zip`);
  makeZip(path.join(tmp, name), { 'index.html': '<h1>ok</h1>' }, zip);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), `${name}.zip`);
  form.append('name', name);
  form.append('autoStart', 'false');
  const res = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const site = await res.json();
  assert.equal(res.status, 200, `деплой не удался: ${JSON.stringify(site)}`);
  if (domain) await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain });
  return site;
}

test('UI: дашборд, hash-роутинг, домены, health-полоска, модалка, токен, таймер логов', { timeout: 120000 }, async (t) => {
  if (!chromium) return t.skip('playwright не установлен (npm i -D playwright && npx playwright install chromium)');
  const panel = await startPanel({ PANEL_MONITOR_TICK_MS: '300' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-ui-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ } });

  const site = await uploadStaticSite(t, panel, tmp, 'uisite', 'uisite.local');
  await api(panel, 'POST', `/api/sites/${site.id}/start`);
  await sleep(1200); // пару тиков монитора — для истории health

  const { page, consoleErrors } = await withBrowser(t, panel);

  // Дашборд открывается и рендерится.
  await page.goto(panel.base + '/#/', { waitUntil: 'networkidle' });
  await page.waitForSelector('h1');
  assert.ok(await page.locator('h1', { hasText: 'Дашборд' }).count(), 'дашборд не отрисован');
  assert.ok(await page.locator('#dDiskSpark').count(), 'нет графика использования диска');
  assert.ok(await page.locator('#dNetworkSpark').count(), 'нет графика сетевой нагрузки');
  assert.equal(await page.locator('#dNetworkRx').count(), 1, 'нет скорости приёма');
  assert.equal(await page.locator('#dNetworkTx').count(), 1, 'нет скорости передачи');
  assert.ok(await page.locator('#dDiskIoSpark').count(), 'нет графика чтения/записи диска');
  assert.equal(await page.locator('#dDiskRead').count(), 1, 'нет скорости чтения диска');
  assert.equal(await page.locator('#dDiskWrite').count(), 1, 'нет скорости записи диска');

  // U-12: прямая ссылка #/sites/<id> открывает страницу сайта (закладки работают).
  // Same-document навигация (смена только хеша) резолвится мгновенно — ждём DOM.
  await page.goto(panel.base + '/#/sites/' + site.id);
  await page.waitForSelector('#detailRoot', { timeout: 10000 });
  assert.equal(await page.locator('#dName').textContent(), 'uisite', 'имя сайта не отрисовано');

  // U-08: домены видны и отвязываются кнопкой.
  const domainRow = page.locator('#domainList .domain-row', { hasText: 'uisite.local' });
  await domainRow.waitFor({ timeout: 10000 });
  assert.ok(await domainRow.count(), 'домен не виден в карточке сайта (U-08)');
  await domainRow.locator('button.remove').click();
  // Функция исполняется в браузере, где document определён.
  // eslint-disable-next-line no-undef
  await page.waitForFunction(() => document.querySelectorAll('#domainList .domain-row').length === 0, { timeout: 10000 });
  assert.ok(true, 'домен отвязан (U-08)');

  // U-02: ячейки истории имеют ненулевой размер (display:inline-block, не inline).
  await page.waitForTimeout(1500);
  const cell = page.locator('#dHealthStrip .health-cell').first();
  if (await cell.count()) {
    const box = await cell.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, 'ячейка истории 0x0 — .health-cell не видима (U-02)');
  }

  // U-04: модалка добавления закрывается кликом по подложке.
  await page.click('#addSiteBtn');
  assert.ok(!(await page.locator('#addModal').evaluate((el) => el.classList.contains('hidden'))), 'модалка не открылась');
  await page.mouse.click(10, 10); // угол — подложка
  assert.ok(await page.locator('#addModal').evaluate((el) => el.classList.contains('hidden')), 'клик по подложке не закрыл модалку (U-04)');

  // A-02: токен Telegram — password и пустой, подсказка вместо значения.
  await page.goto(panel.base + '/#/settings');
  await page.waitForSelector('#alertForm input[name="token"]', { timeout: 10000 });
  const token = page.locator('#alertForm input[name="token"]');
  assert.equal(await token.getAttribute('type'), 'password', 'поле токена не password (A-02)');
  assert.equal(await token.inputValue(), '', 'токен подставлен в DOM (A-02)');

  // T-39/U-09: автообновление логов не тикает после ухода со страницы сайта.
  await page.goto(panel.base + '/#/sites/' + site.id);
  let logRequests = 0;
  page.on('request', (req) => { if (req.url().includes('/logs')) logRequests++; });
  await page.waitForSelector('#logBox', { timeout: 10000 });
  await page.click('#logRefresh'); // один ручной запрос
  await page.waitForTimeout(300);
  const afterManual = logRequests;
  assert.ok(afterManual >= 1, 'ручное обновление логов не выполнено');
  await page.check('#logAuto'); // включаем автообновление каждые 2с
  await page.waitForTimeout(500);
  await page.click('#dashBtn'); // уходим на дашборд
  await page.waitForTimeout(4500); // больше двух интервалов автообновления
  assert.ok(logRequests <= afterManual + 1, `таймер логов тикает после ухода со страницы: +${logRequests - afterManual} (U-09)`);

  assert.deepEqual(consoleErrors, [], `ошибки в консоли браузера: ${consoleErrors.slice(0, 3)}`);
});

test('UI: терминал подключается и выполняет команду (e2e)', { timeout: 60000 }, async (t) => {
  if (!chromium) return t.skip('playwright не установлен (npm i -D playwright && npx playwright install chromium)');
  const panel = await startPanel();
  const { page, consoleErrors } = await withBrowser(t, panel);

  await page.goto(panel.base + '/#/terminal', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#terminalBox .xterm', { timeout: 15000 });
  // Серверное приветствие дошло до эмулятора: канал сервер -> браузер жив.
  await page.waitForFunction(() => {
    let text = '';
    // eslint-disable-next-line no-undef
    document.querySelectorAll('#terminalBox .xterm-rows > div').forEach((r) => { text += r.textContent; });
    return text.length > 0;
  }, { timeout: 20000 });
  // Команда через onData-канал xterm: браузер -> сервер -> shell -> обратно.
  // eslint-disable-next-line no-undef
  await page.evaluate(() => term.input('echo TERMINAL_E2E_MARKER\r'));
  await page.waitForFunction(() => {
    let text = '';
    // eslint-disable-next-line no-undef
    document.querySelectorAll('#terminalBox .xterm-rows > div').forEach((r) => { text += r.textContent; });
    return text.includes('TERMINAL_E2E_MARKER');
  }, { timeout: 20000 });

  assert.deepEqual(consoleErrors, [], `ошибки в консоли браузера: ${consoleErrors.slice(0, 3)}`);
});
