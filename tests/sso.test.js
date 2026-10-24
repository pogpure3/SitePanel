'use strict';

const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const { startPanel } = require('./helpers/panel');
const { hashPassword } = require('../src/auth');

const secret = crypto.randomBytes(32).toString('hex');

function ticket(extra = {}) {
  const payload = Buffer.from(JSON.stringify({ aud: 'sitepanel', exp: Math.floor(Date.now() / 1000) + 30, jti: crypto.randomBytes(16).toString('hex'), ...extra })).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

test('SSO билет портала создаёт сессию и не проходит повторно', async (t) => {
  const panel = await startPanel({ PANEL_NO_AUTH: '', PANEL_SSO_SECRET: secret }, {
    prepare: (dir) => fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ user: 'admin', ...hashPassword('sso-test-password') })),
    auth: { user: 'admin', password: 'sso-test-password' },
  });
  t.after(async () => panel.stop());
  const signed = ticket();
  const post = () => fetch(panel.base + '/sso/callback', {
    method: 'POST', redirect: 'manual',
    headers: { Origin: 'https://prtl.evil-mesh.ru', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket: signed }),
  });
  const first = await post();
  assert.equal(first.status, 303);
  const cookie = first.headers.get('set-cookie') || '';
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const session = cookie.split(';')[0];
  assert.equal((await fetch(panel.base + '/api/system', { headers: { Cookie: session } })).status, 200);
  assert.equal((await post()).status, 403);
});
