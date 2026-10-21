'use strict';

/* Вид: Пользователи — вынесено из app.js (там общий каркас: api, модалки, роутинг).
   Файл загружается ДО app.js: каркас вызывает эти функции по ходу,
   ссылки на глобалы (app, api, esc, navigate, …) разрешаются в рантайме. */
/* ---------- Пользователи ---------- */

async function renderUsers() {
  stopLogTimer();
  let data;
  try {
    data = await api('GET', '/api/users');
  } catch (err) {
    showBanner('Не удалось загрузить пользователей: ' + err.message);
    return;
  }
  document.title = 'Пользователи — SitePanel';
  const users = Array.isArray(data.users) ? data.users : [];
  app.innerHTML = `
    <div class="page-head"><h1>Пользователи</h1></div>
    <div class="detail-grid">
      <div class="panel">
        <h2>Учётные записи</h2>
        <table class="users-table">
          <thead><tr><th>Логин</th><th>Роль</th></tr></thead>
          <tbody>
            ${users.map((u) => `<tr>
              <td><strong>${esc(u.user)}</strong></td>
              <td><span class="role-badge">${esc(u.role || 'admin')}</span></td>
            </tr>`).join('')}
          </tbody>
        </table>
        <p class="hint" style="margin-top:12px">${esc(data.note || '')} Учетные данные хранятся в <code>data/auth.json</code> (scrypt); вход — через страницу <code>/login</code> (сессия в HttpOnly-cookie), для API и скриптов доступен HTTP Basic. Неудачные попытки ограничены: 10 за 5 минут с одного адреса — блокировка на 15 минут; смена пароля гасит все активные сессии.</p>
      </div>

      <div class="panel">
        <h2>Смена логина и пароля</h2>
        <form id="passForm">
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Логин
            <input type="text" name="user" value="${esc(users.length ? users[0].user : '')}" style="margin-top:6px">
          </label>
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Новый пароль (мин. 8 символов)
            <input type="password" name="password" style="margin-top:6px" autocomplete="new-password">
          </label>
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Повторите новый пароль
            <input type="password" name="password2" style="margin-top:6px" autocomplete="new-password">
          </label>
          <div class="actions-row"><button class="btn btn-primary btn-sm" type="submit">Сменить пароль</button></div>
          <p class="hint" style="margin-top:12px">После смены пароля браузер запросит вход заново.</p>
        </form>
      </div>
    </div>`;

  document.getElementById('passForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const password = form.password.value;
    if (password.length < 8) return toast('Пароль должен быть не короче 8 символов', 'error');
    if (password !== form.password2.value) return toast('Пароли не совпадают', 'error');
    try {
      await api('POST', '/api/password', { user: form.user.value, password });
      toast('Пароль изменён. Обновите страницу и войдите с новым паролем.', 'success');
      form.password.value = '';
      form.password2.value = '';
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
