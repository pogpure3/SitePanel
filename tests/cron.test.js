'use strict';

// Cron-задания сайтов: разбор выражений, создание через API, ручной запуск,
// запуск по расписанию, обработка падений и валидация.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cronMgr = require('../src/sites/cron');
const { startPanel, api, waitFor, makeZip } = require('./helpers/panel');

/* ---------- Разбор cron-выражений ---------- */

test('cronMatches: базовые выражения', () => {
  const m = (expr, iso) => cronMgr.matches(new Date(iso), cronMgr.assertSchedule(expr));
  assert.equal(m('* * * * *', '2026-11-03T10:07:00'), true);
  assert.equal(m('7 10 * * *', '2026-11-03T10:07:30'), true, 'минуты/часы');
  assert.equal(m('8 10 * * *', '2026-11-03T10:07:00'), false);
  assert.equal(m('*/15 * * * *', '2026-11-03T10:45:00'), true, 'шаг');
  assert.equal(m('*/15 * * * *', '2026-11-03T10:44:00'), false);
  assert.equal(m('0 9 * * 1-5', '2026-11-03T09:00:00'), true, '2026-11-03 — вторник');
  assert.equal(m('0 9 * * 1-5', '2026-11-08T09:00:00'), false, 'воскресенье вне 1-5');
  assert.equal(m('0 0 29 2 *', '2028-02-29T00:00:00'), true, '29 февраля');
  assert.equal(m('0 0 29 2 *', '2027-03-01T00:00:00'), false);
  // 7 и 0 — воскресенье.
  assert.equal(m('0 12 * * 7', '2026-11-08T12:00:00'), true);
  assert.equal(m('0 12 * * 0', '2026-11-08T12:00:00'), true);
  // dom и dow ограничены оба — правило «или» классического cron.
  assert.equal(m('0 0 1 * 1', '2026-11-02T00:00:00'), true, 'понедельник (dow) при dom=1');
  assert.equal(m('0 0 1 * 1', '2026-11-01T00:00:00'), true, 'первое число (dom) при dow=понедельник');
  assert.equal(m('0 0 5 * 1', '2026-11-10T00:00:00'), false, 'ни dom, ни dow');
});

test('cronMatches: диапазоны со шагом и невалидные выражения', () => {
  const m = (expr, iso) => cronMgr.matches(new Date(iso), cronMgr.assertSchedule(expr));
  assert.equal(m('1-10/3 * * * *', '2026-11-03T10:07:00'), true, '1,4,7,10');
  assert.equal(m('1-10/3 * * * *', '2026-11-03T10:08:00'), false);
  assert.throws(() => cronMgr.assertSchedule('* * * *'), { status: 400 }, '4 поля');
  assert.throws(() => cronMgr.assertSchedule('60 * * * *'), { status: 400 }, 'минуты 60');
  assert.throws(() => cronMgr.assertSchedule('* * * * 8'), { status: 400 }, 'день недели 8');
  assert.throws(() => cronMgr.assertSchedule('a * * * *'), { status: 400 });
});

/* ---------- E2E ---------- */

async function createSite(panel, tmp, name) {
  const zip = path.join(tmp, name + '.zip');
  makeZip(path.join(tmp, name), { 'index.html': '<h1>demo</h1>' }, zip);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), name + '.zip');
  form.append('name', name);
  const res = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const site = await res.json();
  assert.equal(res.status, 200, `сайт не создался: ${JSON.stringify(site)}`);
  return site;
}

function cronApi(panel, siteId, p = '', method = 'GET', body) {
  return api(panel, method, `/api/sites/${siteId}/cron${p}`, body, {});
}

test('cron: создание, ручной запуск, падение и валидация', async (t) => {
  const panel = await startPanel({ PANEL_CRON_CHECK_SEC: '5' });
  t.after(() => panel.stop());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-cron-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ } });

  const site = await createSite(panel, tmp, 'app');
  assert.deepEqual((await cronApi(panel, site.id)).data.jobs, [], 'у нового сайта заданий нет');

  // Валидация: битое выражение и пустая команда.
  const badSchedule = await cronApi(panel, site.id, '', 'POST', { schedule: '*/5 * *', command: 'node -e "0"' });
  assert.equal(badSchedule.status, 400, '4 поля должны отклоняться');
  const noCommand = await cronApi(panel, site.id, '', 'POST', { schedule: '* * * * *' });
  assert.equal(noCommand.status, 400);

  // Создание и ручный запуск: команда пишет маркер в каталог сайта.
  const cmd = 'node -e "require(\'fs\').writeFileSync(\'cron-marker.txt\',\'done\')"';
  const created = await cronApi(panel, site.id, '', 'POST', { name: 'Маркер', schedule: '0 5 * * *', command: cmd });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const jobId = created.data.job.id;
  assert.equal(created.data.job.enabled, true);

  // По расписанию (0 5 * * *) сегодня не выполняется — маркера ещё нет.
  const ran = await cronApi(panel, site.id, `/${jobId}/run`, 'POST', {});
  assert.equal(ran.status, 200, JSON.stringify(ran.data));
  const marker = path.join(panel.dataDir, 'sites', site.id, 'cron-marker.txt');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'done', 'команда должна была выполниться в каталоге сайта');

  // Состояние задания обновилось.
  const after = (await cronApi(panel, site.id)).data.jobs.find((j) => j.id === jobId);
  assert.equal(after.lastStatus, 'ok');
  assert.equal(after.history.length, 1);

  // Падающая команда: 500 с кодом выхода, lastStatus failed.
  const failJob = await cronApi(panel, site.id, '', 'POST', { schedule: '* * * * *', command: 'node -e "process.exit(3)"' });
  const failedRun = await cronApi(panel, site.id, `/${failJob.data.job.id}/run`, 'POST', {});
  assert.equal(failedRun.status, 500);
  assert.match(failedRun.data.error, /кодом 3/);
  const failedJob = (await cronApi(panel, site.id)).data.jobs.find((j) => j.id === failJob.data.job.id);
  assert.equal(failedJob.lastStatus, 'failed');
  assert.match(failedJob.lastError, /код выхода 3/);

  // Удаление.
  const del = await cronApi(panel, site.id, `/${jobId}`, 'DELETE');
  assert.equal(del.status, 200);
  assert.deepEqual((await cronApi(panel, site.id)).data.jobs.filter((j) => j.id === jobId), []);
});

test('cron: задание выполняется по расписанию', async (t) => {
  const panel = await startPanel({ PANEL_CRON_CHECK_SEC: '2' });
  t.after(() => panel.stop());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-cron-sched-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ } });

  const site = await createSite(panel, tmp, 'app');
  const created = await cronApi(panel, site.id, '', 'POST', {
    schedule: '* * * * *',
    command: 'node -e "console.log(\'tick\')"',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const jobId = created.data.job.id;

  // Тик каждые 2 секунды — в текущей минуте задание должно выполниться само.
  await waitFor(async () => {
    const jobs = (await cronApi(panel, site.id)).data.jobs;
    return jobs.find((j) => j.id === jobId && j.lastStatus === 'ok');
  }, { timeout: 20000, interval: 500, label: 'плановый запуск cron-задания' });

  // Повторный тик в ту же минуту не создаёт второй запуск.
  const h1 = (await cronApi(panel, site.id)).data.jobs.find((j) => j.id === jobId).history.length;
  await new Promise((r) => setTimeout(r, 3500));
  const h2 = (await cronApi(panel, site.id)).data.jobs.find((j) => j.id === jobId).history.length;
  assert.ok(h2 - h1 <= 1, `в одной минуте не должно быть больше одного запуска (было ${h1}, стало ${h2})`);
});
