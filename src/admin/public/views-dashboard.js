'use strict';

/* Вид: Дашборд — вынесено из app.js (там общий каркас: api, модалки, роутинг).
   Файл загружается ДО app.js: каркас вызывает эти функции по ходу,
   ссылки на глобалы (app, api, esc, navigate, …) разрешаются в рантайме. */
/* ---------- Дашборд ---------- */

// SVG-спарклайн по массиву точек {t, v}.
function sparkline(points, color, max) {
  const pts = (points || []).filter((p) => p.v !== null && p.v !== undefined);
  if (pts.length < 2) return '<div class="spark-empty">Собираем данные...</div>';
  const W = 300, H = 56, PAD = 2;
  const top = max || Math.max(100, ...pts.map((p) => p.v));
  const step = (W - PAD * 2) / (pts.length - 1);
  const y = (v) => H - PAD - (v / top) * (H - PAD * 2);
  const line = pts.map((p, i) => `${PAD + i * step},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${PAD},${H - PAD} ${line} ${PAD + (pts.length - 1) * step},${H - PAD}`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark">
    <polygon points="${area}" fill="${color}" opacity="0.12"/>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>`;
}

function ring(pct, color) {
  const R = 26, C = 2 * Math.PI * R;
  const off = C * (1 - Math.min(100, Math.max(0, pct || 0)) / 100);
  return `<svg viewBox="0 0 64 64" class="ring">
    <circle cx="32" cy="32" r="${R}" fill="none" stroke="var(--border)" stroke-width="6"/>
    <circle cx="32" cy="32" r="${R}" fill="none" stroke="${color}" stroke-width="6"
      stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
      transform="rotate(-90 32 32)"/>
    <text x="32" y="37" text-anchor="middle" class="ring-text">${pct === null || pct === undefined ? '—' : pct + '%'}</text>
  </svg>`;
}

function renderDashboard(data) {
  stopLogTimer(); // ушед со страницы сайта, не опрашиваем его логи (U-09)
  document.title = 'Дашборд — SitePanel';
  app.innerHTML = `
    <div id="dashRoot">
      <div class="page-head"><h1>Дашборд</h1></div>
      <div class="dash-grid">
        <div class="panel dash-card">
          <h2>Процессор</h2>
          <div class="dash-row">${ring(data.cpu.pct, '#60a5fa')}
            <div class="dash-facts">
              <div class="dash-big" id="dCpuPct">${data.cpu.pct === null ? '—' : data.cpu.pct + '%'}</div>
              <div class="hint">${data.cpu.cores} ядер${data.cpu.model ? ' · ' + esc(String(data.cpu.model).slice(0, 40)) : ''}</div>
              <div class="hint">load average: ${data.cpu.loadavg.join(' / ') || '—'}</div>
            </div>
          </div>
          <div id="dCpuSpark">${sparkline(data.history.cpu, '#60a5fa')}</div>
        </div>

        <div class="panel dash-card">
          <h2>Память</h2>
          <div class="dash-row">${ring(data.mem.pct, '#a78bfa')}
            <div class="dash-facts">
              <div class="dash-big" id="dMemPct">${data.mem.pct === null ? '—' : data.mem.pct + '%'}</div>
              <div class="hint" id="dMemDetail">${fmtBytes(data.mem.used)} из ${fmtBytes(data.mem.total)}</div>
            </div>
          </div>
          <div id="dMemSpark">${sparkline(data.history.mem, '#a78bfa', 100)}</div>
        </div>

        <div class="panel dash-card">
          <h2>Хранилище <span class="hint" id="dDiskPath"></span></h2>
          <div class="dash-row" id="dDiskRing"></div>
          <div class="hint" id="dDiskDetail" style="margin-top:6px"></div>
          <div class="disk-bar"><div class="disk-bar-fill" id="dDiskBar"></div></div>
        </div>

        <div class="panel dash-card">
          <h2>Сайты</h2>
          <div class="dash-row">
            <div class="dash-big" id="dSites">${data.sites ? data.sites.running : '—'}<span class="hint"> / ${data.sites ? data.sites.total : '—'}</span></div>
          </div>
          <div class="hint" id="dSitesHint" style="margin-top:8px">работает / всего</div>
          <div class="hint" id="dServerInfo" style="margin-top:8px"></div>
        </div>
      </div>
    </div>`;
  patchDashboard(data);
}

// Точечное обновление значений без перестроения страницы.
function patchDashboard(data) {
  if (!document.getElementById('dashRoot')) return;
  document.getElementById('dCpuPct').textContent = data.cpu.pct === null ? '—' : data.cpu.pct + '%';
  document.getElementById('dMemPct').textContent = data.mem.pct === null ? '—' : data.mem.pct + '%';
  document.getElementById('dMemDetail').textContent = `${fmtBytes(data.mem.used)} из ${fmtBytes(data.mem.total)}`;
  document.getElementById('dCpuSpark').innerHTML = sparkline(data.history.cpu, '#60a5fa');
  document.getElementById('dMemSpark').innerHTML = sparkline(data.history.mem, '#a78bfa', 100);

  // Кольца перерисовываем целиком (внутри .dash-row первый элемент).
  const rows = document.querySelectorAll('#dashRoot .dash-row');
  rows[0].querySelector('.ring').outerHTML = ring(data.cpu.pct, '#60a5fa');
  rows[1].querySelector('.ring').outerHTML = ring(data.mem.pct, '#a78bfa');

  if (data.disk) {
    document.getElementById('dDiskPath').textContent = data.disk.path || '';
    document.getElementById('dDiskRing').innerHTML = ring(data.disk.pct, data.disk.pct > 90 ? '#f87171' : data.disk.pct > 75 ? '#fbbf24' : '#34d399');
    document.getElementById('dDiskDetail').textContent = `${fmtBytes(data.disk.used)} занято из ${fmtBytes(data.disk.total)}`;
    const bar = document.getElementById('dDiskBar');
    bar.style.width = Math.min(100, data.disk.pct || 0) + '%';
    bar.style.background = data.disk.pct > 90 ? '#f87171' : data.disk.pct > 75 ? '#fbbf24' : '#34d399';
  } else {
    document.getElementById('dDiskRing').innerHTML = '<p class="hint">Размер диска определить не удалось</p>';
  }
  document.getElementById('dSites').innerHTML = `${data.sites ? data.sites.running : '—'}<span class="hint"> / ${data.sites ? data.sites.total : '—'}</span>`;
  document.getElementById('dServerInfo').innerHTML =
    `${esc(data.server.hostname)} · ${esc(data.server.platform)} · Node ${esc(data.nodeVersion)}<br>` +
    `сервер работает ${fmtUptime(data.server.osUptimeSec)} · панель ${fmtUptime(data.panelUptimeSec)}<br>` +
    `<code>${esc(data.dataDir)}</code>`;
}
