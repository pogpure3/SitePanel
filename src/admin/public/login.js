'use strict';

/* Логика страницы входа (/login). Файл отдаётся без авторизации — в нём нет
   ничего, кроме работы формы; вся защита на сервере. */

(function () {
  /* ---------- Тема (как в панели: localStorage sp-theme) ---------- */
  var theme = null;
  try { theme = localStorage.getItem('sp-theme'); } catch (e) { /* приватный режим */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', theme);
    var btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
  }
  applyTheme();
  document.getElementById('themeBtn').addEventListener('click', function () {
    theme = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('sp-theme', theme); } catch (e) { /* noop */ }
    applyTheme();
  });

  /* ---------- Показать/скрыть пароль ---------- */
  var pass = document.forms.f.password;
  document.getElementById('eye').addEventListener('click', function () {
    var show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    this.classList.toggle('on', show);
    this.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
    pass.focus();
  });

  /* ---------- Отправка формы ---------- */
  // Куда вернуться после входа: только путь внутри панели.
  var next = '/';
  try {
    var raw = new URLSearchParams(location.search).get('next') || '/';
    if (raw === '/' || (/^\/[^/\\]/.test(raw) && raw.indexOf('\\') < 0)) next = raw;
    // Серверный редирект теряет fragment (#/sites/...): восстанавливаем из адреса
    // страницы входа, если пользователь попал сюда с хешем.
    if (next === '/' && /^#\/[a-z]/.test(location.hash || '')) next = '/' + location.hash;
  } catch (e) { /* остаётся '/' */ }

  var form = document.getElementById('f');
  var errBox = document.getElementById('err');
  var go = document.getElementById('go');

  function showError(text) {
    errBox.textContent = text;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var user = form.user.value.trim();
    var password = pass.value;
    if (!user || !password) {
      showError('Введите логин и пароль.');
      return;
    }
    go.disabled = true;
    showError('');
    fetch('/api/login', {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user: user, password: password }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    }).then(function (r) {
      if (r.status === 200 && r.data.ok) {
        location.href = next;
        return;
      }
      showError((r.data && r.data.error) || 'Не удалось войти (ошибка ' + r.status + ')');
      go.disabled = false;
      pass.focus();
      pass.select();
    }).catch(function () {
      showError('Нет связи с панелью. Проверьте адрес и повторите.');
      go.disabled = false;
    });
  });
})();
