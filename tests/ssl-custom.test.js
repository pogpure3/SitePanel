'use strict';

// Свой SSL-сертификат: установка fullchain+privkey через API, отдача по SNI,
// отклонение несоответствующего ключа и сайта без доменов.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const selfsigned = require('selfsigned');

const { startPanel, api, makeZip } = require('./helpers/panel');

function handshake(port, servername) {
  return new Promise((resolve) => {
    const opts = { host: '127.0.0.1', port, rejectUnauthorized: false };
    if (servername) opts.servername = servername;
    const socket = tls.connect(opts, () => {
      const cert = socket.getPeerCertificate();
      const out = { ok: true, cert };
      socket.end();
      resolve(out);
    });
    socket.on('error', (err) => resolve({ ok: false, error: err.message }));
    socket.setTimeout(8000, () => {
      socket.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
  });
}

async function genPair(domain) {
  // selfsigned 5.x generate() асинхронный.
  const pems = await selfsigned.generate([{ name: 'commonName', value: domain }], {
    days: 30,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: domain }] }],
  });
  return { cert: pems.cert, key: pems.private };
}

async function uploadSsl(panel, siteId, cert, key) {
  const form = new FormData();
  form.append('cert', new Blob([cert]), 'fullchain.pem');
  form.append('key', new Blob([key]), 'privkey.pem');
  const res = await fetch(panel.base + `/api/sites/${siteId}/ssl/custom`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  return { status: res.status, data: await res.json() };
}

test('свой сертификат устанавливается и отдаётся по SNI', async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-ssl-custom-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ } });

  const zip = path.join(tmp, 'demo.zip');
  makeZip(path.join(tmp, 'demo'), { 'index.html': '<h1>demo</h1>' }, zip);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), 'demo.zip');
  form.append('name', 'demo');
  const created = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const site = await created.json();
  assert.equal(created.status, 200, `сайт не создался: ${JSON.stringify(site)}`);

  const bound = await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'custom.example.com' });
  assert.equal(bound.status, 200, JSON.stringify(bound.data));

  const pair = await genPair('custom.example.com');
  const res = await uploadSsl(panel, site.id, pair.cert, pair.key);
  assert.equal(res.status, 200, `установка не удалась: ${JSON.stringify(res.data)}`);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.ssl.provider, 'custom');
  assert.equal(res.data.ssl.status, 'active');
  assert.ok(res.data.ssl.domains.includes('custom.example.com'), `SAN не распознан: ${JSON.stringify(res.data.ssl.domains)}`);
  assert.ok(res.data.ssl.expiresAt > Date.now(), 'срок сертификата не распознан');

  const hs = await handshake(panel.httpsPort, 'custom.example.com');
  assert.ok(hs.ok, `рукопожатие с SNI не прошло: ${hs.error}`);
  const expected = new crypto.X509Certificate(pair.cert).fingerprint256;
  assert.equal(hs.cert.fingerprint256, expected, 'по SNI отдаётся не загруженный сертификат');
});

test('ключ не соответствует сертификату — 400', async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-ssl-bad-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ } });

  const zip = path.join(tmp, 'demo.zip');
  makeZip(path.join(tmp, 'demo'), { 'index.html': '<h1>demo</h1>' }, zip);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), 'demo.zip');
  form.append('name', 'demo');
  const created = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const site = await created.json();
  await api(panel, 'POST', `/api/sites/${site.id}/domains`, { domain: 'mismatch.example.com' });

  const good = await genPair('mismatch.example.com');
  const other = await genPair('other.example.com');
  const res = await uploadSsl(panel, site.id, good.cert, other.key);
  assert.equal(res.status, 400, `mismatch должен отклоняться, получено ${res.status}`);
  assert.match(res.data.error, /не соответствует/);
});

test('у сайта без доменов свой сертификат не ставится — 400', async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sitepanel-ssl-nodomain-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* noop */ } });

  const zip = path.join(tmp, 'demo.zip');
  makeZip(path.join(tmp, 'demo'), { 'index.html': '<h1>demo</h1>' }, zip);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(zip)]), 'demo.zip');
  form.append('name', 'demo');
  const created = await fetch(panel.base + '/api/sites', {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    body: form,
  });
  const site = await created.json();

  const pair = await genPair('nop.example.com');
  const res = await uploadSsl(panel, site.id, pair.cert, pair.key);
  assert.equal(res.status, 400, `ожидается 400 без доменов, получено ${res.status}`);
});
