'use strict';

// Регрессия T-03/P-11: валидаторы параметров git-деплоя.
//
// Это единственный барьер перед `git clone` и перед переименованием каталогов:
// URL уходит в spawn('git', [...]) как аргумент, а `subdir` — в путь на диске.
// Ослабление любой из проверок означает либо выполнение чужих команд через
// «-опцию» git, либо переезд/удаление каталога СОСЕДНЕГО сайта (P-11).

const test = require('node:test');
const assert = require('node:assert');

const { validateGitUrl, validateGitBranch, validateGitToken, validateSubdir } = require('../src/sites/manager');

/* ---------- URL репозитория ---------- */

test('validateGitUrl: принимает https и git@ формы', () => {
  for (const url of [
    'https://github.com/user/repo.git',
    'https://github.com/user/repo',
    'https://gitlab.example.com:8443/group/sub/repo.git',
    'https://gitlab.com/group/sub/deeper/repo.git',
    'https://github.com/user/my_repo.git',
    'git@github.com:user/repo.git',
    'git@github.com:user/repo',
    'git@gitlab.example.com:group/sub/repo.git',
  ]) {
    assert.equal(validateGitUrl(url), url, `должен быть принят: ${url}`);
  }
});

test('validateGitUrl: сегмент, похожий на опцию git, не проходит', () => {
  // Опция не может быть «спрятана» в путь: как только сегмент начинается с «-»,
  // git готов принять его за свой флаг (--upload-pack, -c, -u).
  for (const url of [
    'https://github.com/user/-o.git',
    'https://github.com/-c/repo.git',
    'https://github.com/user/repo/--upload-pack=id.git',
    'git@github.com:-x/repo.git',
  ]) {
    assert.throws(() => validateGitUrl(url), /Некорректный URL|Поддерживаются/, `должен быть отклонён: ${url}`);
  }
});

test('validateGitUrl: отбрасывает опции git и посторонние команды', () => {
  for (const url of [
    '--upload-pack=touch /tmp/pwned',
    '-u',
    '--config=core.pager=sh',
    'https://github.com/u/r.git; rm -rf /',
    'https://github.com/u/r.git && id',
    'https://github.com/u/r.git | tee /tmp/x',
    'https://github.com/u/r.git`id`',
    'https://github.com/u/r.git$(id)',
    'https://github.com/u/r.git\n--upload-pack=id',
    'git@github.com:user/repo.git\nrm -rf /',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.throws(() => validateGitUrl(url), /Некорректн|Укажите/, `должен быть отклонён: ${JSON.stringify(url)}`);
  }
});

test('validateGitUrl: отбрасывает неполные и чужие схемы', () => {
  for (const url of ['https://github.com/user', 'ftp://host/user/repo.git', 'github.com/user/repo', 'https://host']) {
    assert.throws(() => validateGitUrl(url), /Некорректный|Поддерживаются/, `должен быть отклонён: ${url}`);
  }
});

/* ---------- Ветка и токен ---------- */

test('validateGitBranch: принимает обычные имена, отбрасывает мусор', () => {
  assert.equal(validateGitBranch('main'), 'main');
  assert.equal(validateGitBranch('feature/new-ui'), 'feature/new-ui');
  assert.equal(validateGitBranch(''), null);
  assert.equal(validateGitBranch(undefined), null);
  for (const branch of ['main; rm -rf /', 'main$(id)', 'main`id`', 'main|x', 'main\nrm', 'main"x']) {
    assert.throws(() => validateGitBranch(branch), /Некорректное имя ветки/, `должна быть отклонена: ${branch}`);
  }
});

test('validateGitToken: принимает токен, отбрасывает мусор', () => {
  assert.equal(validateGitToken('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(validateGitToken('github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDE'), 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDE');
  assert.equal(validateGitToken(''), null);
  assert.equal(validateGitToken(undefined), null);
  for (const token of ['token;id', 'token$(id)', 'token with space', 'token"x']) {
    assert.throws(() => validateGitToken(token), /Некорректный формат токена/);
  }
});

/* ---------- Подкаталог репозитория (P-11) ---------- */

test('validateSubdir: принимает нормальные подкаталоги', () => {
  assert.equal(validateSubdir('apps/web'), 'apps/web');
  assert.equal(validateSubdir('packages/ui-kit'), 'packages/ui-kit');
  assert.equal(validateSubdir('./apps'), 'apps', 'ведущий "./" нормализуется');
  assert.equal(validateSubdir('apps/'), 'apps');
  assert.equal(validateSubdir('apps\\web'), 'apps/web', 'обратные слэши нормализуются');
  assert.equal(validateSubdir(''), null);
  assert.equal(validateSubdir(undefined), null);
});

test('P-11: validateSubdir запрещает выход за пределы репозитория', () => {
  // Именно эта форма уводила путь на каталог соседнего сайта:
  // path.join(staging, '../../sites/<id>') указывал в чужой каталог, панель
  // переименовывала его в staging — и сайт исчезал вместе со своими данными.
  for (const subdir of [
    '..',
    '../..',
    '../../sites/3ebc4e88346e',
    'apps/../../sites/victim',
    './..',
    'apps/..',
    '../etc',
    'a/b/../../..',
  ]) {
    assert.throws(() => validateSubdir(subdir), /Некорректный подкаталог/, `должен быть отклонён: ${subdir}`);
  }
});

test('P-11: ни один принятый подкаталог не выходит из каталога деплоя', () => {
  const path = require('path');
  const staging = path.resolve('/data/tmp/deploy-site123-1700000000000');
  const accepted = ['apps/web', 'packages/ui-kit', 'apps', 'a/b/c'];
  for (const subdir of accepted) {
    const target = path.resolve(staging, validateSubdir(subdir));
    const rel = path.relative(staging, target);
    assert.ok(!rel.startsWith('..') && !path.isAbsolute(rel), `${subdir} => ${target} вне staging`);
  }
});

test('validateSubdir: отбрасывает абсолютные пути и мусор', () => {
  for (const subdir of ['/etc', '///etc', 'apps//web', 'apps/we b', 'apps/web;id', 'apps/web$(id)', 'C:\\Windows']) {
    assert.throws(() => validateSubdir(subdir), /Некорректный подкаталог/, `должен быть отклонён: ${subdir}`);
  }
});
