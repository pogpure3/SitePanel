'use strict';

/* Вид: Веб-терминал — вынесено из app.js (там общий каркас: api, модалки, роутинг).
   Файл загружается ДО app.js: каркас вызывает эти функции по ходу,
   ссылки на глобалы (app, api, esc, navigate, …) разрешаются в рантайме. */
/* ---------- Терминал ---------- */

let term = null;        // экземпляр xterm
let termFit = null;     // addon-fit
let termWs = null;      // WebSocket сессии
let termResizeHandler = null;
let termSeq = 0;        // отменяет устаревшие подключения

function terminalTheme() {
  const theme = currentTheme();
  const dark = theme === 'dark';
  const autumn = theme === 'api';
  return {
    background: dark ? '#0b0e14' : autumn ? '#fffaf4' : '#ffffff',
    foreground: dark ? '#e6e9f0' : autumn ? '#32261c' : '#172033',
    cursor: dark ? '#60a5fa' : autumn ? '#9c4a1e' : '#1d4ed8',
    cursorAccent: dark ? '#0b0e14' : autumn ? '#fffaf4' : '#ffffff',
    selectionBackground: dark ? 'rgba(96, 165, 250, .30)' : autumn ? 'rgba(196, 98, 45, .20)' : 'rgba(29, 78, 216, .18)',
    black: '#0b0e14', brightBlack: '#64748b',
    red: '#ef4444', green: '#22c55e', yellow: '#eab308',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e6e9f0',
  };
}

function termStatus(state, text) {
  const el = document.getElementById('termStatus');
  if (!el) return;
  el.className = 'term-status ' + state;
  el.innerHTML = `<span class="status-dot ${state === 'ok' ? 'running' : state === 'err' ? 'crashed' : 'stopped'}"></span> ${esc(text)}`;
}

function stopTerminal() {
  termSeq++;
  if (termResizeHandler) {
    window.removeEventListener('resize', termResizeHandler);
    termResizeHandler = null;
  }
  if (termWs) {
    try { termWs.close(); } catch { /* уже закрыт */ }
    termWs = null;
  }
  if (term) {
    try { term.dispose(); } catch { /* noop */ }
    term = null;
    termFit = null;
  }
}

function renderTerminal() {
  document.title = 'Терминал — SitePanel';
  app.innerHTML = `
    <div class="page-head"><h1>Терминал</h1></div>
    <div class="term-wrap">
      <div class="term-toolbar">
        <span class="term-tab"><svg class="icon"><use href="#i-term"/></svg> shell@${esc(location.hostname)}</span>
        <span class="term-status off" id="termStatus"><span class="status-dot stopped"></span> подключение...</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="termReconnect">Переподключить</button>
      </div>
      <div id="terminalBox"></div>
    </div>
    <p class="hint term-note">Терминал открывает shell на сервере с правами учетной записи панели — команды выполняются по-настоящему. Сессия закрывается при уходе со страницы; подключение защищено одноразовым токеном, а HTTP Basic панель подставляет сама.</p>`;

  document.getElementById('termReconnect').addEventListener('click', connectTerminal);
  connectTerminal();
}

async function connectTerminal() {
  const seq = ++termSeq;
  const box = document.getElementById('terminalBox');
  if (!box) return;
  // Чистим предыдущую сессию, но оставляем обработчик resize на месте до пересоздания.
  if (termResizeHandler) { window.removeEventListener('resize', termResizeHandler); termResizeHandler = null; }
  if (termWs) { try { termWs.close(); } catch { /* noop */ } termWs = null; }
  if (term) { try { term.dispose(); } catch { /* noop */ } term = null; }

  if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
    termStatus('err', 'xterm.js не загружен');
    box.innerHTML = '<p class="hint" style="padding:16px">Библиотека терминала (vendor/xterm.js) не найдена — проверьте выкладку.</p>';
    return;
  }

  termStatus('off', 'подключение...');
  let token;
  try {
    ({ token } = await api('POST', '/api/terminal/token'));
  } catch (err) {
    termStatus('err', 'нет токена');
    box.innerHTML = `<p class="hint" style="padding:16px">Терминал недоступен: ${esc(err.message)}</p>`;
    return;
  }
  if (seq !== termSeq) return; // пользователь ушёл со страницы, пока ждали токен

  term = new Terminal({
    fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    theme: terminalTheme(),
  });
  termFit = new FitAddon.FitAddon();
  term.loadAddon(termFit);
  term.open(box);
  try { termFit.fit(); } catch { /* нулевые размеры — подождёт resize */ }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/terminal/ws?token=${encodeURIComponent(token)}`);
  // По умолчанию браузер заворачивает бинарные кадры в Blob: new Uint8Array(Blob)
  // дал бы пустой массив и весь вывод терминала молча пропадал.
  ws.binaryType = 'arraybuffer';
  termWs = ws;
  let firstOutput = false;

  term.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(d);
  });

  ws.onopen = () => {
    if (seq !== termSeq) return;
    // Начальный размер сессии: PTY получит его через resize-сообщение.
    try {
      const dim = termFit.proposeDimensions();
      ws.send(JSON.stringify({ type: 'resize', cols: (dim && dim.cols) || 80, rows: (dim && dim.rows) || 24 }));
    } catch { /* размер посчитает fit */ }
    termStatus('ok', 'подключено');
    term.focus();
  };

  ws.onmessage = (e) => {
    if (seq !== termSeq) return;
    if (!firstOutput) { firstOutput = true; termStatus('ok', 'подключено'); }
    term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  };

  ws.onclose = (e) => {
    if (seq !== termSeq) return;
    termStatus('off', e.wasClean ? 'сессия закрыта' : 'связь потеряна');
    term.write('\r\n\x1b[2m[SITEPANEL] Сессия закрыта. Нажмите «Переподключить».\x1b[0m\r\n');
  };

  ws.onerror = () => {
    if (seq !== termSeq) return;
    termStatus('err', 'ошибка соединения');
  };

  // Ресайз окна → fit + сообщение серверу.
  termResizeHandler = () => {
    if (!term || !termFit) return;
    try {
      termFit.fit();
      const dim = termFit.proposeDimensions();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: (dim && dim.cols) || 80, rows: (dim && dim.rows) || 24 }));
      }
    } catch { /* noop */ }
  };
  window.addEventListener('resize', termResizeHandler);
}
