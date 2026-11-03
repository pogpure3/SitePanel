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
  var successBox = document.getElementById('success');
  var go = document.getElementById('go');
  var title = document.getElementById('title');
  var hint = document.getElementById('hint');
  var requestForm = document.getElementById('resetRequest');
  var confirmForm = document.getElementById('resetConfirm');

  function showError(text) {
    errBox.textContent = text;
    if (text) successBox.textContent = '';
  }

  function showView(view, heading) {
    form.hidden = view !== form;
    requestForm.hidden = view !== requestForm;
    confirmForm.hidden = view !== confirmForm;
    title.textContent = heading;
    hint.hidden = view !== form;
    showError('');
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, data: data };
      });
    });
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
    postJson('/api/login', { user: user, password: password }).then(function (r) {
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

  /* ---------- Сброс пароля ---------- */
  var resetMatch = /^#reset=([0-9a-f]{64})$/.exec(location.hash || '');
  var resetToken = resetMatch ? resetMatch[1] : '';
  if (resetToken) showView(confirmForm, 'Новый пароль');

  document.getElementById('forgot').addEventListener('click', function () {
    showView(requestForm, 'Сброс пароля');
  });
  document.querySelectorAll('[data-back-login]').forEach(function (button) {
    button.addEventListener('click', function () {
      history.replaceState(null, '', location.pathname + location.search);
      resetToken = '';
      showView(form, 'Вход в панель управления');
    });
  });

  requestForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var button = document.getElementById('sendReset');
    button.disabled = true;
    showError('');
    postJson('/api/password-reset/request', {}).then(function (r) {
      if (r.status === 202 && r.data.ok) {
        successBox.textContent = r.data.message || 'Ссылка отправлена.';
        button.textContent = 'Отправлено';
        return;
      }
      showError((r.data && r.data.error) || 'Не удалось отправить письмо.');
      button.disabled = false;
    }).catch(function () {
      showError('Нет связи с панелью. Проверьте адрес и повторите.');
      button.disabled = false;
    });
  });

  confirmForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var password = confirmForm.password.value;
    if (password.length < 8) return showError('Пароль должен быть не короче 8 символов.');
    if (password !== confirmForm.confirm.value) return showError('Пароли не совпадают.');
    if (!resetToken) return showError('Ссылка недействительна или устарела.');
    var button = document.getElementById('saveReset');
    button.disabled = true;
    showError('');
    postJson('/api/password-reset/confirm', { token: resetToken, password: password }).then(function (r) {
      if (r.status === 200 && r.data.ok) {
        history.replaceState(null, '', location.pathname + location.search);
        resetToken = '';
        confirmForm.reset();
        showView(form, 'Вход в панель управления');
        successBox.textContent = 'Пароль изменён. Войдите с новым паролем.';
        pass.focus();
        return;
      }
      showError((r.data && r.data.error) || 'Не удалось изменить пароль.');
      button.disabled = false;
    }).catch(function () {
      showError('Нет связи с панелью. Проверьте адрес и повторите.');
      button.disabled = false;
    });
  });
})();
