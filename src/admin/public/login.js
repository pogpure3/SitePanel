'use strict';

/* Логика страницы входа (/login). Файл отдаётся без авторизации — в нём нет
   ничего, кроме работы формы; вся защита на сервере. */

(function () {
  /* ---------- Тема (как в панели: localStorage sp-theme) ---------- */
  var themeLabels = { api: 'Осень', light: 'Светлая', dark: 'Тёмная' };
  var theme = null;
  try { theme = localStorage.getItem('sp-theme'); } catch (e) { /* приватный режим */ }
  if (theme !== 'api' && theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('themeLabel').textContent = themeLabels[theme];
    document.querySelectorAll('[data-theme-choice]').forEach(function (choice) {
      choice.setAttribute('aria-checked', String(choice.getAttribute('data-theme-choice') === theme));
    });
  }
  applyTheme();
  var themeToggle = document.getElementById('themeSelect');
  var themeMenu = document.getElementById('themeMenu');
  function closeThemePicker() {
    themeMenu.hidden = true;
    themeToggle.setAttribute('aria-expanded', 'false');
  }
  themeToggle.addEventListener('click', function () {
    themeMenu.hidden = !themeMenu.hidden;
    themeToggle.setAttribute('aria-expanded', String(!themeMenu.hidden));
  });
  themeMenu.addEventListener('click', function (event) {
    var choice = event.target.closest('[data-theme-choice]');
    if (!choice) return;
    theme = choice.getAttribute('data-theme-choice');
    try { localStorage.setItem('sp-theme', theme); } catch (e) { /* noop */ }
    applyTheme();
    closeThemePicker();
  });
  document.addEventListener('click', function (event) {
    if (!event.target.closest('#themePicker')) closeThemePicker();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || themeMenu.hidden) return;
    closeThemePicker();
    themeToggle.focus();
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
