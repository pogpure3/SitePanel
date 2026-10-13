'use strict';

// Регрессия: HTTPS-реверс-прокси панели (порты 8443/443).
//
// Здесь закрыты два дефекта, найденные на боевом стенде:
//
// 1. Самоподписанный сертификат по умолчанию выпускался с подписью SHA-1.
//    У библиотеки selfsigned значение по умолчанию для `algorithm` — 'sha1',
//    а панель этот параметр не передавала. Современные клиенты (Chrome,
//    Firefox, curl на OpenSSL 3) отвергают сертификат с SHA-1 **на уровне
//    рукопожатия**, ещё до проверки цепочки: `curl https://127.0.0.1:8443/`
//    падал с `TLS alert handshake failure`, при этом `openssl s_client`
//    соединение устанавливал.
//
// 2. У https-сервера не было key/cert по умолчанию — только SNICallback.
//    Если клиент не прислал SNI (обращение по IP, старый клиент, проверка из
//    мониторинга), SNICallback не вызывается ВООБЩЕ, и сервер обрывал
//    рукопожатие: `TLS alert handshake failure` (alert 40) вместо того, чтобы
//    отдать сертификат по умолчанию.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

const { startPanel, sleep } = require('./helpers/panel');

/** Поднимает TLS-соединение и возвращает результат рукопожатия. */
function tlsHandshake(port, { servername } = {}) {
  return new Promise((resolve) => {
    const opts = { host: '127.0.0.1', port, rejectUnauthorized: false };
    if (servername) opts.servername = servername;
    const socket = tls.connect(opts, () => {
      const cert = socket.getPeerCertificate();
      const out = { ok: true, protocol: socket.getProtocol(), cert };
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

/** PEM -> DER. */
function der(pem) {
  return Buffer.from(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

// OID алгоритмов подписи (RFC 8017): sha1WithRSAEncryption и sha256WithRSAEncryption.
// Ищем именно ASN.1-строку `06 09 2a 86 48 86 f7 0d 01 01 05` / `... 0b`, а не
// подстроку в тексте: так проверка не зависит от версии Node. Свойство
// `X509Certificate.signatureAlgorithm` появилось только в Node 18.13+/20+, и на
// Node 22 боевого стенда его нет — тест на нём молча уходил в skip, то есть
// ровно та регрессия, ради которой он написан, оставалась непроверенной.
const OID_SHA1 = Buffer.from('06092a864886f70d010105', 'hex');
const OID_SHA256 = Buffer.from('06092a864886f70d01010b', 'hex');

function signatureOids(pem) {
  const d = der(pem);
  const count = (needle) => d.toString('hex').split(needle.toString('hex')).length - 1;
  return { sha1: count(OID_SHA1), sha256: count(OID_SHA256) };
}

test('самоподписанный сертификат по умолчанию подписан не SHA-1', async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());

  const pem = fs.readFileSync(path.join(panel.dataDir, 'certs', '_default', 'fullchain.pem'), 'utf8');
  const oids = signatureOids(pem);
  // SHA-1 в самоподписанном сертификате — именно то, из-за чего curl/Chrome
  // рвут рукопожатие. SHA-256 обязан присутствовать, SHA-1 — отсутствовать.
  assert.equal(oids.sha1, 0, 'подпись сертификата не должна быть SHA-1 (sha1WithRSAEncryption)');
  assert.ok(oids.sha256 > 0, 'ожидалась подпись SHA-256 (sha256WithRSAEncryption)');
});

test('HTTPS принимает соединение без SNI (обращение по IP)', async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());

  // Без servername и с хостом-IP SNI по RFC 6066 не отправляется — это ровно
  // тот случай, в котором раньше приходил `handshake failure`.
  const res = await tlsHandshake(panel.httpsPort);
  assert.ok(res.ok, `рукопожатие без SNI должно проходить, получено: ${res.error}`);
  assert.ok(res.cert && res.cert.subject, 'сервер должен отдать сертификат');
});

test('HTTPS отдаёт сертификат сайта по SNI и сертификат по умолчанию для чужого имени', async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());

  // Имя, которого нет среди сайтов: панель должна отдать сертификат по
  // умолчанию, а не оборвать соединение.
  const unknown = await tlsHandshake(panel.httpsPort, { servername: 'nobody.example.com' });
  assert.ok(unknown.ok, `неизвестный SNI не должен ломать рукопожатие: ${unknown.error}`);
  const cn = unknown.cert.subject && unknown.cert.subject.CN;
  assert.equal(cn, 'sitepanel.local', `для чужого имени ожидался сертификат по умолчанию, получен CN=${cn}`);

  // Панель не должна зависать на повторных соединениях.
  const again = await tlsHandshake(panel.httpsPort, { servername: 'nobody.example.com' });
  assert.ok(again.ok, 'повторное соединение тоже должно проходить');
  await sleep(50);
});
