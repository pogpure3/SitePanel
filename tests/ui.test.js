'use strict';

// Регресс-тест палитры: контраст текста по WCAG AA (>= 4.5:1).
// Значения берём из style.css, чтобы тест ловил будущие правки цветов.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'public', 'style.css'), 'utf8');

function luminance(hex) {
  const h = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Читает значение CSS-переменной из :root. */
function cssVar(name) {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(CSS);
  assert.ok(m, `в style.css не найдена переменная --${name}`);
  return m[1];
}

const AA = 4.5;

test('палитра: контраст текста >= 4.5:1 (WCAG AA)', () => {
  const bg = cssVar('bg');
  const card = cssVar('bg-card');
  const text = cssVar('text');
  const dim = cssVar('text-dim');
  const primary = cssVar('primary');

  const pairs = [
    // Кнопки: белый текст на основном цвете — главная регрессия (было 2.98:1).
    ['white on primary', '#ffffff', primary],
    ['white on primary-hover', '#ffffff', cssVar('primary-hover')],
    ['text on bg', text, bg],
    ['text on bg-card', text, card],
    ['text-dim on bg', dim, bg],
    ['text-dim on bg-card', dim, card],
  ];
  const bad = [];
  for (const [label, fg, b] of pairs) {
    const r = ratio(fg, b);
    if (r < AA) bad.push(`${label}: ${r.toFixed(2)}:1 (${fg} на ${b})`);
  }
  assert.deepEqual(bad, [], 'Контраст ниже AA:\n' + bad.join('\n'));
});

test('палитра: основной цвет не светлее порога для белого текста', () => {
  // #3b82f6 давал 2.98:1 — такой цвет нельзя использовать с белым текстом.
  const r = ratio('#ffffff', cssVar('primary'));
  assert.ok(r >= AA, `--primary даёт ${r.toFixed(2)}:1 с белым текстом, нужно >= ${AA}`);
});

test('палитра: текст на цветных кнопках >= 4.5:1', () => {
  // Регрессия: --text (#e2e8f0) на --primary давал 4.19:1 — не хватало до AA.
  const primary = cssVar('primary');
  const hover = cssVar('primary-hover');
  const bad = [];
  for (const [label, bg] of [['primary', primary], ['primary-hover', hover], ['success', '#14532d'], ['danger', '#7f1d1d']]) {
    const r = ratio('#ffffff', bg);
    if (r < AA) bad.push(`${label}: белый на ${bg} = ${r.toFixed(2)}:1`);
  }
  assert.deepEqual(bad, [], 'Текст кнопок ниже AA:\n' + bad.join('\n'));
});

test('style.css: есть prefers-reduced-motion', () => {
  assert.match(CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, 'нет блока prefers-reduced-motion');
});

test('палитра: --primary не используется как цвет текста на тёмном фоне', () => {
  // --primary тёмный (рассчитан на белый текст кнопок) и как цвет текста
  // на тёмном фоне даёт < 4.5:1. Текстовые акценты — светлый #60a5fa.
  const accent = '#60a5fa';
  const r = ratio(accent, cssVar('bg'));
  assert.ok(r >= AA, `акцентный цвет ${accent} даёт ${r.toFixed(2)}:1 на фоне`);

  // Только объявление самого свойства color (не border-color/background-color).
  const offenders = [];
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(CSS)) !== null) {
    const selector = m[1].trim().split('\n').pop().trim();
    if (/(^|[;\s{])color:\s*var\(--primary\)/.test(m[2])) offenders.push(selector || m[1].trim());
  }
  assert.deepEqual(offenders, [], 'текст цветом var(--primary):\n' + offenders.join('\n'));
});

test('style.css: шапка не ломает раскладку на узком экране', () => {
  assert.match(CSS, /\.topbar\s*\{[^}]*flex-wrap:\s*wrap/s, '.topbar без flex-wrap — будет горизонтальный скролл');
  assert.match(CSS, /\.topbar\s*\{[^}]*min-height:\s*56px/s, '.topbar без min-height');
  assert.match(CSS, /@media\s*\(max-width:\s*760px\)/, 'нет мобильного медиазапроса для шапки');
});

test('style.css: видимый фокус для клавиатуры', () => {
  assert.match(CSS, /:focus-visible\s*\{/, 'нет правил :focus-visible');
});

test('index.html: модалки и поля доступны', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'admin', 'public', 'index.html'), 'utf8');
  const dialogs = html.match(/role="dialog"/g) || [];
  assert.ok(dialogs.length >= 4, `ожидались role="dialog" у всех модалок, найдено ${dialogs.length}`);
  assert.equal((html.match(/aria-modal="true"/g) || []).length, dialogs.length, 'aria-modal не у всех диалогов');
  assert.match(html, /<label class="sr-only" for="promptInput"/, 'у promptInput нет метки');
  assert.match(html, /aria-live="polite"/, 'у тостов нет aria-live');
});
