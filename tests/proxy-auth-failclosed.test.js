'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const auth = require('../src/auth');
const store = require('../src/store');
const { _proxyToNode, _routeUpgrade } = require('../src/httpserver');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('H-14: ошибка проверки Basic fail-closed для HTTP и WebSocket', async (t) => {
  const originalCheck = auth.checkCredentials;
  const originalLookup = store.getSiteByDomain;
  auth.checkCredentials = async () => { throw new Error('scrypt unavailable'); };

  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.end('secret reached upstream');
  });
  const upstreamPort = await listen(upstream);
  const site = { id: 'failclosed', type: 'node', status: 'running', port: upstreamPort, domains: ['failclosed.local'] };
  const frontend = http.createServer((req, res) => _proxyToNode(site, req, res, 'failclosed.local'));
  const frontendPort = await listen(frontend);

  t.after(async () => {
    auth.checkCredentials = originalCheck;
    store.getSiteByDomain = originalLookup;
    await close(frontend);
    await close(upstream);
  });

  const basic = 'Basic ' + Buffer.from('admin:panel-password').toString('base64');
  const response = await fetch(`http://127.0.0.1:${frontendPort}/`, {
    headers: { Authorization: basic },
  });
  assert.equal(response.status, 503, 'ошибка проверки не должна переходить к proxy.web');
  assert.equal(upstreamHits, 0, 'HTTP upstream получил запрос после ошибки проверки Authorization');

  store.getSiteByDomain = () => site;
  let destroyed = false;
  const wsReq = {
    url: '/',
    headers: { host: 'failclosed.local', authorization: basic },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const socket = { destroy: () => { destroyed = true; } };
  await _routeUpgrade(wsReq, socket, Buffer.alloc(0));
  assert.equal(destroyed, true, 'WebSocket должен быть закрыт при ошибке проверки Authorization');
  assert.equal(wsReq.headers.authorization, undefined, 'возможный пароль панели должен удаляться даже в fail-closed ветке');
  assert.equal(upstreamHits, 0, 'WS upstream не должен вызываться после ошибки проверки Authorization');
});
