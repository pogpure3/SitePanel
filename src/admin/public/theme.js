/* Тема применяется до первой отрисовки страницы: без этого в тёмной теме
   вспыхивает светлый фон (и наоборот). CSP запрещает inline-скрипты, поэтому
   логика живёт во внешнем файле. Хранится в localStorage под ключом sp-theme;
   по умолчанию — системная настройка, при недоступности — тёмная. */
(function () {
  var t = null;
  try {
    t = localStorage.getItem('sp-theme');
    if (t !== 'light' && t !== 'dark') {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    try { document.documentElement.setAttribute('data-theme', 'dark'); } catch (e2) { /* noop */ }
  }
})();
