'use strict';

// Короткий одноразовый HMAC-билет от Mesh Portal. Это мост для тестового
// стенда; при подключении нескольких независимых проектов его заменит OIDC.

const crypto = require('crypto');
const auth = require('../auth');
const { effectiveScheme } = require('../httpserver');

const usedTickets = new Map();

function validTicket(req, ticket) {
  if (req.headers.origin !== 'https://prtl.evil-mesh.ru') return false;
  const secret = process.env.PANEL_SSO_SECRET;
  const [payload, signature] = String(ticket || '').split('.');
  if (!secret || !payload || !signature || String(ticket || '').split('.').length !== 2) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(signature); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return false; }
  const now = Math.floor(Date.now() / 1000);
  if (!data || data.aud !== 'sitepanel' || typeof data.jti !== 'string' || !/^[0-9a-f]{32}$/.test(data.jti) || !Number.isInteger(data.exp) || data.exp < now || data.exp > now + 60 || usedTickets.has(data.jti)) return false;
  usedTickets.set(data.jti, data.exp);
  for (const [jti, exp] of usedTickets) if (exp < now) usedTickets.delete(jti);
  return true;
}

function callback(req, res) {
  if (!validTicket(req, req.body && req.body.ticket)) return res.status(403).type('text/plain').send('SSO ticket rejected');
  const { token, maxAgeSec } = auth.createSession();
  const parts = [`${auth.SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (effectiveScheme(req, Boolean(req.secure)) === 'https') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  res.redirect(303, '/');
}

module.exports = { callback, validTicket };
