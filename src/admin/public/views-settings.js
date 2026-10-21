'use strict';

/* Вид: Настройки — вынесено из app.js (там общий каркас: api, модалки, роутинг).
   Файл загружается ДО app.js: каркас вызывает эти функции по ходу,
   ссылки на глобалы (app, api, esc, navigate, …) разрешаются в рантайме. */
/* ---------- Настройки ---------- */

/** Современный контрол порога: степпер (− значение +) + слайдер с заполненной дорожкой. */
function stepperHtml(name, value, label) {
  const pct = Math.round(((Number(value) || 1) - 1) / 98 * 100);
  return `
    <div class="stepper-card">
      <div class="stepper-label">${esc(label)}</div>
      <div class="stepper" data-stepper>
        <button type="button" class="stepper-btn" data-step="-1" aria-label="Уменьшить: ${esc(label)}">−</button>
        <input type="number" min="1" max="99" name="${name}" value="${Number(value) || 1}" inputmode="numeric" aria-label="${esc(label)}">
        <button type="button" class="stepper-btn" data-step="1" aria-label="Увеличить: ${esc(label)}">+</button>
      </div>
      <input type="range" class="stepper-slider" min="1" max="99" value="${Number(value) || 1}"
        style="--fill:${pct}%" data-slider-for="${name}" aria-label="${esc(label)} — ползунок">
    </div>`;
}

/** Связывает степпер и слайдер: кнопки ±, ручной ввод и ползунок меняют одно значение. */
function wireSteppers() {
  app.querySelectorAll('[data-stepper]').forEach((st) => {
    const input = st.querySelector('input[type="number"]');
    const slider = app.querySelector(`[data-slider-for="${input.name}"]`);
    const minus = st.querySelector('[data-step="-1"]');
    const plus = st.querySelector('[data-step="1"]');
    const clamp = (v) => Math.min(99, Math.max(1, Math.round(Number(v) || 1)));
    const sync = (raw) => {
      const v = clamp(raw);
      input.value = v;
      if (slider) {
        slider.value = v;
        slider.style.setProperty('--fill', Math.round((v - 1) / 98 * 100) + '%');
      }
      if (minus) minus.disabled = v <= 1;
      if (plus) plus.disabled = v >= 99;
    };
    if (minus) minus.addEventListener('click', () => sync(Number(input.value) - 1));
    if (plus) plus.addEventListener('click', () => sync(Number(input.value) + 1));
    input.addEventListener('change', () => sync(input.value));
    if (slider) slider.addEventListener('input', () => sync(slider.value));
    sync(input.value);
  });
}

function renderSettings(settings, system) {
  stopLogTimer();
  document.title = 'Настройки — SitePanel';
  const a = settings.alerts || {};
  app.innerHTML = `
    <div class="page-head">
      <h1>Настройки</h1>
    </div>
    <div class="detail-grid">
      <div class="panel">
        <h2>Let's Encrypt</h2>
        <form id="leForm">
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            E-mail для уведомлений LE
            <input type="email" name="leEmail" value="${esc(settings.leEmail)}" placeholder="admin@example.com" style="margin-top:6px">
          </label>
          <label class="checkbox"><input type="checkbox" name="leStaging" ${settings.leStaging ? 'checked' : ''}> Staging-режим LE (тестовые сертификаты, без лимитов)</label>
          <div class="actions-row"><button class="btn btn-primary btn-sm" type="submit">Сохранить</button></div>
        </form>
      </div>

      <div class="panel">
        <h2>Оповещения Telegram</h2>
        <form id="alertForm">
          <label class="checkbox" style="margin-bottom:10px"><input type="checkbox" name="enabled" ${a.enabled !== false ? 'checked' : ''}> Включить оповещения</label>
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Bot token ${a.telegramTokenSet ? `<span style="color:var(--text-dim)">(сохранён, ${esc(a.telegramTokenHint || '***')})</span>` : ''}
            <input type="password" name="token" value="" placeholder="${a.telegramTokenSet ? 'введите новый токен, чтобы заменить' : '123456789:AA...'}" style="margin-top:6px" autocomplete="new-password">
          </label>
          ${a.telegramTokenSet ? '<label class="checkbox" style="margin-bottom:10px"><input type="checkbox" name="tokenReset"> Удалить сохранённый токен</label>' : ''}
          <label style="display:block;color:var(--text-dim);font-size:13px;margin-bottom:10px">
            Chat ID
            <input type="text" name="chatId" value="${esc(a.telegramChatId || '')}" placeholder="-1001234567890 или 123456789" style="margin-top:6px" autocomplete="off">
          </label>
          <div class="stepper-grid">
            ${stepperHtml('disk', a.diskThreshold || 80, 'Порог диска, %')}
            ${stepperHtml('mem', a.memThreshold || 80, 'Порог памяти, %')}
          </div>
          <div class="actions-row">
            <button class="btn btn-primary btn-sm" type="submit">Сохранить</button>
            <button class="btn btn-sm" type="button" id="alertTest">🧪 Отправить тест</button>
          </div>
          <p class="hint" style="margin-top:12px">Проверка каждые 30 секунд. При превышении порога — сообщение в Telegram (повтор раз в 30 минут, пока проблема не уйдёт), при возврате на 5% ниже порога — уведомление о восстановлении. Также приходят сообщения о падении и восстановлении сайтов (алерт — при аварийном завершении процесса или если сайт не отвечает минуту).</p>
        </form>
      </div>

      <div class="panel span2">
        <h2>Система</h2>
        <dl class="kv">
          <dt>Версия Node.js</dt><dd>${esc(system.nodeVersion)}</dd>
          <dt>Платформа</dt><dd>${esc(system.platform)}</dd>
          <dt>Порты прокси</dt><dd>HTTP ${system.httpPort} · HTTPS ${system.httpsPort}</dd>
          <dt>Порт админки</dt><dd>${system.adminPort}</dd>
          <dt>Память сервера</dt><dd>свободно ${system.freememGb} из ${system.totalmemGb} ГБ</dd>
          <dt>Сайтов</dt><dd>${system.sites} (работает: ${system.running})</dd>
          <dt>Каталог данных</dt><dd><code>${esc(system.dataDir)}</code></dd>
        </dl>
        <p class="hint" style="margin-top:12px">Порты задаются переменными окружения <code>PANEL_HTTP_PORT</code>, <code>PANEL_HTTPS_PORT</code>, <code>PANEL_ADMIN_PORT</code> при запуске. Опция <code>PANEL_NO_AUTH=1</code> отключает встроенную авторизацию (если её выполняет внешний прокси). Логин и пароль меняются на странице «Пользователи».</p>
      </div>
    </div>`;

  document.getElementById('leForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', {
        leEmail: e.target.leEmail.value,
        leStaging: e.target.leStaging.checked,
      });
      toast('Настройки сохранены', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('alertForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const token = e.target.token.value.trim();
      const alerts = {
        enabled: e.target.enabled.checked,
        telegramChatId: e.target.chatId.value.trim(),
        diskThreshold: e.target.disk.value,
        memThreshold: e.target.mem.value,
      };
      // Токен отправляется только если введён новый: поле пустое по умолчанию,
      // и сохранение настроек не должно стирать сохранённый токен (A-02).
      if (token) alerts.telegramToken = token;
      if (e.target.tokenReset && e.target.tokenReset.checked) alerts.telegramTokenReset = true;
      await api('PUT', '/api/settings', { alerts });
      toast('Оповещения сохранены', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('alertTest').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/alerts/test', {});
      toast(r.ok ? 'Тестовое сообщение отправлено в Telegram' : 'Не удалось отправить: ' + (r.error || ''), r.ok ? 'success' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  wireSteppers();
}
