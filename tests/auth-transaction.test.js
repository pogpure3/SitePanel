'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// config.js читает окружение при require: изолируем auth.json до загрузки модулей.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-auth-transaction-'));
process.env.PANEL_DATA_DIR = dataDir;
process.env.PANEL_PUBLIC_URL = 'https://panel.test';
process.env.PANEL_PASSWORD_RESET_EMAIL = 'owner@example.test';

const auth = require('../src/auth');
const secure = require('../src/securefile');

const oldPassword = 'old-password-123';
fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify({
  user: 'admin',
  ...auth.hashPassword(oldPassword),
}), 'utf8');
const authFile = path.join(dataDir, 'auth.json');
assert.equal(auth.load(), true);

let mailedToken = null;
const mailerPath = require.resolve('../src/mailer');
require.cache[mailerPath] = {
  id: mailerPath,
  filename: mailerPath,
  loaded: true,
  exports: {
    sendEmail: async (_to, _subject, text) => {
      const match = /#reset=([0-9a-f]{64})/.exec(text);
      mailedToken = match && match[1];
      return true;
    },
  },
};
const passwordReset = require('../src/password-reset');

test.after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* noop */ }
});

test('смена и сброс пароля коммитятся только после успешной записи auth.json', async () => {
  const originalWrite = secure.writePrivate;
  const before = fs.readFileSync(authFile, 'utf8');
  const directSession = auth.createSession();
  secure.writePrivate = () => {
    const err = new Error('disk full');
    err.code = 'ENOSPC';
    throw err;
  };

  try {
    assert.throws(() => auth.changePassword('', 'direct-new-password-123'), /disk full/);
    assert.equal(await auth.checkCredentials('admin', oldPassword), true, 'старый пароль изменился в памяти после неудачной записи');
    assert.equal(await auth.checkCredentials('admin', 'direct-new-password-123'), false, 'не записанный пароль стал рабочим');
    assert.equal(auth.isSessionValid(directSession.token), true, 'сессия погашена до durable commit');
    assert.equal(fs.readFileSync(authFile, 'utf8'), before, 'auth.json изменился после ошибки durable commit');

    await passwordReset.requestReset();
    assert.match(String(mailedToken), /^[0-9a-f]{64}$/, 'тестовый reset-token не получен из письма');
    const resetSession = auth.createSession();
    assert.throws(() => passwordReset.confirmReset(mailedToken, 'reset-new-password-123'), /disk full/);
    assert.equal(await auth.checkCredentials('admin', oldPassword), true, 'reset изменил память после ENOSPC');
    assert.equal(auth.isSessionValid(resetSession.token), true, 'reset погасил сессию до записи auth.json');

    // Тот же token обязан остаться пригодным: ошибка диска не считается использованием.
    secure.writePrivate = originalWrite;
    const changed = passwordReset.confirmReset(mailedToken, 'reset-new-password-123');
    assert.equal(changed.user, 'admin');
    assert.equal(await auth.checkCredentials('admin', 'reset-new-password-123'), true);
    assert.equal(await auth.checkCredentials('admin', oldPassword), false);
    assert.notEqual(fs.readFileSync(authFile, 'utf8'), before, 'успешный reset не записал новый auth.json');
    assert.equal(auth.isSessionValid(resetSession.token), false, 'после успешного commit сессия должна быть погашена');
    assert.throws(() => passwordReset.confirmReset(mailedToken, 'another-password-123'), /недействительна|устарела/);
  } finally {
    secure.writePrivate = originalWrite;
  }
});
