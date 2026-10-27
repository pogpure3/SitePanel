'use strict';

// Закрытие доменов сайта от индексации: флаг, PATCH, заголовок X-Robots-Tag.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startPanel, api, waitFor, makeZip, fetchWithHost } = require('./helpers/panel');

async function withPanel(t, env = {}) {
  const panel = await startPanel(env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-noidx-'));
  t.after(async () => {
    await panel.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });
  return { panel, tmp };
}

async function uploadSite(panel, tmp, name) {
  const zip = path.join(tmp, name + '.zip');
  makeZip(path.join(tmp, name), { 'index.html': '<h1>hi</h1>' }, zip);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), name + '.zip');
  form.append('name', name);
  form.append('autoStart', 'true');
  const res = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return data;
}

test('noindex: флаг в API, PATCH переключает, заголовок появляется и исчезает', async (t) => {
  const { panel, tmp } = await withPanel(t, {});
  const site = await uploadSite(panel, tmp, 'noidx');
  assert.equal(site.noindex, false, 'по умолчанию индексация открыта');

  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'noidx.local' });

  // Открыто: заголовка нет.
  await waitFor(async () => (await fetchWithHost(panel.httpPort, 'noidx.local')).status === 200 ? true : null,
    { label: 'сайт отвечает' });
  let r = await fetchWithHost(panel.httpPort, 'noidx.local');
  assert.equal(r.headers['x-robots-tag'], undefined, 'без флага заголовка быть не должно');

  // Закрыто: заголовок есть.
  const on = await api(panel, 'PATCH', `/api/sites/${site.id}`, { noindex: true });
  assert.equal(on.status, 200);
  assert.equal(on.data.noindex, true);
  r = await fetchWithHost(panel.httpPort, 'noidx.local');
  assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');

  // Снова открыто: заголовка нет.
  await api(panel, 'PATCH', `/api/sites/${site.id}`, { noindex: false });
  r = await fetchWithHost(panel.httpPort, 'noidx.local');
  assert.equal(r.headers['x-robots-tag'], undefined);
});

test('noindex: строка в PATCH трактуется как true (семантика как у autoStart)', async (t) => {
  const { panel, tmp } = await withPanel(t, {});
  const site = await uploadSite(panel, tmp, 'noidx2');
  const r = await api(panel, 'PATCH', `/api/sites/${site.id}`, { noindex: 'yes' });
  assert.equal(r.status, 200);
  assert.equal(r.data.noindex, true, 'truthy включает, false/undefined выключает');
  const off = await api(panel, 'PATCH', `/api/sites/${site.id}`, { noindex: false });
  assert.equal(off.data.noindex, false);
});
