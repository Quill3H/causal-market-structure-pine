/* Zero-XSS Dashboard Controller: uses ONLY textContent and document.createElement */
(function () {
  'use strict';

  const state = {
    symbol: 'BTCUSDT.P',
    timeframe: '1h',
    profile: 'EXCHANGE_POST_ONLY',
    candles: [],
    overlay: null,
    summary: null,
    signals: [],
    trades: [],
    status: null,
    hoverIdx: -1,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function clearNode(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function fmtNum(val, digits = 2) {
    if (val === null || val === undefined || !Number.isFinite(Number(val))) return '--';
    return Number(val).toFixed(digits);
  }

  function fmtPct(val, digits = 2) {
    if (val === null || val === undefined || !Number.isFinite(Number(val))) return '--';
    const n = Number(val);
    return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
  }

  function fmtUtc(sec) {
    if (!Number.isFinite(Number(sec))) return '--';
    const d = new Date(Number(sec) * 1000);
    return d.toISOString().slice(5, 16).replace('T', ' ');
  }

  async function apiGet(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function renderBadges() {
    const status = state.status;
    if (!status) return;
    const cfg = status.config || {};
    const acct = status.accountHealth || {};

    const apiBadge = el('api-badge');
    if (acct.connected) {
      apiBadge.textContent = `${cfg.exchange} ${acct.simulated || acct.testnet ? 'DEMO/TESTNET' : 'LIVE'} CONNECTED`;
      apiBadge.className = 'badge badge-safe';
    } else if (acct.configured) {
      apiBadge.textContent = `${cfg.exchange} KEYS SET (OFFLINE/ERR)`;
      apiBadge.className = 'badge badge-warn';
    } else {
      apiBadge.textContent = `${cfg.exchange} PUBLIC • NO KEYS`;
      apiBadge.className = 'badge badge-neutral';
    }

    const modeBadge = el('mode-badge');
    if (cfg.executionMode === 'LIVE_ARMED' && cfg.dryRun === false) {
      modeBadge.textContent = `MODE: LIVE_ARMED (CAP ${cfg.maxLeverageCap}x)`;
      modeBadge.className = 'badge badge-danger';
    } else {
      modeBadge.textContent = `MODE: ${cfg.executionMode} (DRY_RUN=${cfg.dryRun ? 'ON' : 'OFF'})`;
      modeBadge.className = 'badge badge-safe';
    }

    const subtitle = el('model-subtitle');
    subtitle.textContent = `Off-TradingView ML & Execution Engine • ${status.models?.activeModelVersion || 'v4.1-fallback'}`;
  }

  function renderScoreboard(sourceLabel) {
    const s = state.summary;
    if (!s) return;

    const wrEl = el('kpi-winrate');
    wrEl.textContent = `${fmtNum(s.winRatePct, 2)}% (${s.wins}W/${s.losses}L)`;
    wrEl.className = `kpi-value ${Number(s.winRatePct) >= 65 ? 'pos' : ''}`;
    el('kpi-wilson').textContent = `Wilson95: ${fmtNum(s.wilsonLower95Pct, 2)}%`;

    const pfEl = el('kpi-pf');
    pfEl.textContent = fmtNum(s.profitFactor, 2);
    pfEl.className = `kpi-value ${Number(s.profitFactor) >= 1.2 ? 'pos' : 'neg'}`;
    el('kpi-trades').textContent = `Trades: ${s.count} (Raw ${s.rawSignalsCount ?? s.count})`;

    const netEl = el('kpi-total-net');
    netEl.textContent = fmtPct(s.totalNetPct, 2);
    netEl.className = `kpi-value ${Number(s.totalNetPct) >= 0 ? 'pos' : 'neg'}`;
    el('kpi-comp-net').textContent = `Compounded: ${fmtPct(s.compoundedNetPct, 2)}`;

    el('kpi-dd').textContent = `${fmtNum(s.maxDrawdownPct, 2)}%`;
    el('kpi-funding').textContent = `Funding Drag: ${fmtPct(-Math.abs(Number(s.fundingDragPct || 0)), 2)}`;

    el('kpi-model').textContent = s.modelVersion || 'v4.1-fallback';
    el('kpi-source').textContent = `Profile: ${s.execProfile || state.profile} (${sourceLabel || 'local'})`;
  }

  function renderOverlayDetails() {
    const dl = el('active-levels-list');
    clearNode(dl);
    const ov = state.overlay || { status: 'FLAT' };
    const pairs = [['Status', ov.status || 'FLAT']];

    if (ov.status === 'OPEN_POSITION' || ov.status === 'PENDING_LIMIT') {
      pairs.push(['Side', ov.side === 1 ? 'LONG (+1)' : 'SHORT (-1)']);
      if (ov.limitPrice) pairs.push(['Limit (LMT)', fmtNum(ov.limitPrice, 2)]);
      if (ov.entry) pairs.push(['Entry', fmtNum(ov.entry, 2)]);
      if (ov.stop) pairs.push([ov.beArmed ? 'Stop (BE+)' : 'Stop (SL)', fmtNum(ov.stop, 2)]);
      if (ov.tp1Price) pairs.push(['Partial TP1', fmtNum(ov.tp1Price, 2)]);
      if (ov.target) pairs.push(['Target (TP)', fmtNum(ov.target, 2)]);
      if (ov.lev) pairs.push(['Leverage', `${fmtNum(ov.lev, 2)}x`]);
    } else if (ov.lastSignal) {
      pairs.push(['Last Signal', `${fmtUtc(ov.lastSignal.barTime)} (${ov.lastSignal.side === 1 ? 'LONG' : 'SHORT'})`]);
      pairs.push(['Decision', ov.lastSignal.decision || '--']);
      if (ov.lastSignal.limitPrice) pairs.push(['Last Limit', fmtNum(ov.lastSignal.limitPrice, 2)]);
    }

    for (const [k, v] of pairs) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
  }

  function drawMlGauge() {
    const canvas = el('ml-gauge-canvas');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = 240;
    const cssH = 130;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const latestSig = state.signals[0] || state.overlay?.lastSignal || null;
    const prob = Number.isFinite(Number(latestSig?.probWin)) ? Number(latestSig.probWin) : null;
    const tau = Number.isFinite(Number(state.summary?.mlThreshold)) ? Number(state.summary.mlThreshold) : 0.55;

    const cx = cssW / 2;
    const cy = 112;
    const radius = 84;

    // Background arc
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI, 2 * Math.PI);
    ctx.stroke();

    // Threshold marker
    const tauAngle = Math.PI + Math.max(0, Math.min(1, tau)) * Math.PI;
    ctx.save();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(tauAngle) * (radius - 12), cy + Math.sin(tauAngle) * (radius - 12));
    ctx.lineTo(cx + Math.cos(tauAngle) * (radius + 12), cy + Math.sin(tauAngle) * (radius + 12));
    ctx.stroke();
    ctx.restore();

    const pctText = el('ml-prob-text');
    const decBadge = el('ml-decision-badge');
    const tauText = el('ml-threshold-text');
    tauText.textContent = `Threshold tau: ${(tau * 100).toFixed(1)}%`;

    if (prob === null) {
      pctText.textContent = 'v4.1 Rules';
      decBadge.textContent = state.summary?.modelVersion || 'FALLBACK';
      decBadge.className = 'badge badge-neutral';
      return;
    }

    const clamped = Math.max(0, Math.min(1, prob));
    const endAngle = Math.PI + clamped * Math.PI;
    ctx.strokeStyle = clamped >= tau ? '#22c55e' : '#ef4444';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI, endAngle);
    ctx.stroke();

    pctText.textContent = `${(clamped * 100).toFixed(1)}%`;
    decBadge.textContent = latestSig?.decision || (clamped >= tau ? 'ACCEPTED' : 'FILTERED');
    decBadge.className = `badge ${clamped >= tau ? 'badge-safe' : 'badge-warn'}`;
  }

  function drawCandleChart() {
    const canvas = el('candle-canvas');
    const wrap = canvas.parentElement;
    const width = wrap.clientWidth || 720;
    const height = wrap.clientHeight || 410;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const rows = state.candles.slice(-140);
    if (rows.length === 0) {
      ctx.fillStyle = '#93a4bf';
      ctx.font = '13px sans-serif';
      ctx.fillText('No closed candles available yet. Run sync or select BTCUSDT.P.', 24, 40);
      return;
    }

    const padL = 12;
    const padR = 72;
    const padT = 18;
    const padB = 28;
    const plotW = Math.max(80, width - padL - padR);
    const plotH = Math.max(80, height - padT - padB);

    let minP = Infinity;
    let maxP = -Infinity;
    for (const r of rows) {
      if (r.low < minP) minP = r.low;
      if (r.high > maxP) maxP = r.high;
    }

    const ov = state.overlay;
    const levelLines = [];
    if (ov && (ov.status === 'OPEN_POSITION' || ov.status === 'PENDING_LIMIT')) {
      if (Number.isFinite(ov.limitPrice)) levelLines.push({ label: 'LMT', price: ov.limitPrice, color: '#38bdf8' });
      if (Number.isFinite(ov.entry)) levelLines.push({ label: 'ENTRY', price: ov.entry, color: '#e2e8f0' });
      if (Number.isFinite(ov.stop)) levelLines.push({ label: ov.beArmed ? 'BE+' : 'SL', price: ov.stop, color: ov.beArmed ? '#fbbf24' : '#f87171' });
      if (Number.isFinite(ov.tp1Price)) levelLines.push({ label: 'TP1', price: ov.tp1Price, color: '#a78bfa' });
      if (Number.isFinite(ov.target)) levelLines.push({ label: 'TP', price: ov.target, color: '#4ade80' });
    }
    for (const l of levelLines) {
      if (l.price < minP) minP = l.price;
      if (l.price > maxP) maxP = l.price;
    }

    const span = Math.max(1e-9, maxP - minP);
    minP -= span * 0.06;
    maxP += span * 0.06;
    const yOf = p => padT + ((maxP - p) / (maxP - minP)) * plotH;

    // Horizontal grid & price labels
    ctx.strokeStyle = 'rgba(37, 48, 71, 0.6)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#93a4bf';
    ctx.font = '11px ui-monospace, monospace';
    for (let g = 0; g <= 4; g++) {
      const p = minP + ((maxP - minP) * g) / 4;
      const y = Math.round(yOf(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(p.toFixed(1), padL + plotW + 6, y + 4);
    }

    const step = plotW / rows.length;
    const bodyW = Math.max(2, Math.min(9, step * 0.65));

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cx = padL + i * step + step * 0.5;
      const up = r.close >= r.open;
      const color = up ? '#22c55e' : '#ef4444';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      const yH = yOf(r.high);
      const yL = yOf(r.low);
      const yO = yOf(r.open);
      const yC = yOf(r.close);

      ctx.beginPath();
      ctx.moveTo(cx, yH);
      ctx.lineTo(cx, yL);
      ctx.stroke();

      const top = Math.min(yO, yC);
      const h = Math.max(1.5, Math.abs(yC - yO));
      ctx.fillRect(cx - bodyW / 2, top, bodyW, h);
    }

    // Active LMT / SL / BE+ / TP lines
    for (const l of levelLines) {
      const y = Math.round(yOf(l.price)) + 0.5;
      ctx.save();
      ctx.strokeStyle = l.color;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = l.color;
      ctx.fillRect(padL + plotW + 2, y - 9, 66, 17);
      ctx.fillStyle = '#090d14';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.fillText(`${l.label} ${l.price.toFixed(0)}`, padL + plotW + 5, y + 3);
      ctx.restore();
    }

    // Crosshair hover
    if (state.hoverIdx >= 0 && state.hoverIdx < rows.length) {
      const r = rows[state.hoverIdx];
      const cx = padL + state.hoverIdx * step + step * 0.5;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, padT);
      ctx.lineTo(cx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      el('chart-hover-info').textContent =
        `${fmtUtc(r.time)} UTC  O:${fmtNum(r.open, 1)}  H:${fmtNum(r.high, 1)}  L:${fmtNum(r.low, 1)}  C:${fmtNum(r.close, 1)}`;
    }
  }

  function renderTables() {
    const sigTbody = el('signals-tbody');
    clearNode(sigTbody);
    for (const s of state.signals.slice(0, 30)) {
      const tr = document.createElement('tr');
      const cells = [
        fmtUtc(s.barTime),
        s.side === 1 ? 'LONG' : 'SHORT',
        s.decision || '--',
        s.probWin !== null && s.probWin !== undefined ? `${(Number(s.probWin) * 100).toFixed(1)}%` : '--',
        fmtNum(s.sizeMult ?? 1, 2),
        fmtNum(s.limitPrice, 2),
        s.modelVersion || '--',
      ];
      cells.forEach((txt, idx) => {
        const td = document.createElement('td');
        td.textContent = txt;
        if (idx === 1) td.className = s.side === 1 ? 'pos' : 'neg';
        if (idx === 2) td.className = s.decision === 'ACCEPTED' ? 'pos' : '';
        tr.appendChild(td);
      });
      sigTbody.appendChild(tr);
    }

    const trTbody = el('trades-tbody');
    clearNode(trTbody);
    for (const t of state.trades.slice(0, 40)) {
      const tr = document.createElement('tr');
      const cells = [
        fmtUtc(t.entryTime),
        t.side === 1 ? 'LONG' : 'SHORT',
        fmtNum(t.entry, 2),
        fmtNum(t.exit, 2),
        t.exitReason || '--',
        `${fmtNum(t.lev, 2)}x`,
        t.probWin !== null && t.probWin !== undefined ? `${(Number(t.probWin) * 100).toFixed(1)}%` : '--',
        fmtPct(t.netPct, 2),
      ];
      cells.forEach((txt, idx) => {
        const td = document.createElement('td');
        td.textContent = txt;
        if (idx === 1) td.className = t.side === 1 ? 'pos' : 'neg';
        if (idx === 7) td.className = Number(t.netPct) >= 0 ? 'pos' : 'neg';
        tr.appendChild(td);
      });
      trTbody.appendChild(tr);
    }
  }

  async function refreshAll() {
    const q = `symbol=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}`;
    el('chart-title').textContent = `${state.symbol} • ${state.timeframe} Closed Candles & Order Levels`;

    const [statusData, candleData, tradeData, sigData] = await Promise.all([
      apiGet(`/api/status?${q}`),
      apiGet(`/api/candles?${q}&limit=160`),
      apiGet(`/api/trades?${q}&limit=60`),
      apiGet(`/api/signals?${q}&limit=40`),
    ]);

    state.status = statusData;
    state.candles = candleData.candles || [];
    state.overlay = candleData.overlay || statusData.activeOverlay || null;
    state.trades = tradeData.trades || [];
    state.summary = tradeData.summary || statusData.summary || null;
    state.signals = sigData.signals || [];

    renderBadges();
    renderScoreboard(candleData.source);
    renderOverlayDetails();
    drawMlGauge();
    drawCandleChart();
    renderTables();
  }

  async function runOfflineReplay() {
    const q = `symbol=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}&profile=${encodeURIComponent(state.profile)}`;
    const msg = el('mode-status-msg');
    msg.textContent = 'Running offline replay...';
    const data = await apiGet(`/api/backtest?${q}`);
    state.summary = data.summary;
    state.trades = data.recentTrades || [];
    renderScoreboard(data.source);
    renderTables();
    msg.textContent = `Replay complete: ${data.summary.count} trades, WR ${fmtNum(data.summary.winRatePct, 2)}%, PF ${fmtNum(data.summary.profitFactor, 2)}`;
  }

  function wireEvents() {
    el('symbol-select').addEventListener('change', e => {
      state.symbol = e.target.value;
      refreshAll().catch(err => { el('mode-status-msg').textContent = err.message; });
    });
    el('timeframe-select').addEventListener('change', e => {
      state.timeframe = e.target.value;
      refreshAll().catch(err => { el('mode-status-msg').textContent = err.message; });
    });
    el('profile-select').addEventListener('change', e => {
      state.profile = e.target.value;
      runOfflineReplay().catch(err => { el('mode-status-msg').textContent = err.message; });
    });
    el('refresh-btn').addEventListener('click', () => {
      refreshAll().catch(err => { el('mode-status-msg').textContent = err.message; });
    });
    el('run-backtest-btn').addEventListener('click', () => {
      runOfflineReplay().catch(err => { el('mode-status-msg').textContent = err.message; });
    });

    el('mode-form').addEventListener('submit', async e => {
      e.preventDefault();
      const executionMode = el('mode-select').value;
      const confirmToken = el('confirm-token-input').value;
      const msg = el('mode-status-msg');
      try {
        const res = await fetch('/api/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            executionMode,
            dryRun: executionMode === 'PAPER',
            confirmToken,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          msg.textContent = `Blocked: ${data.error || res.status}`;
          return;
        }
        el('confirm-token-input').value = '';
        msg.textContent = `Updated mode to ${data.config.executionMode} (DRY_RUN=${data.config.dryRun})`;
        await refreshAll();
      } catch (err) {
        msg.textContent = err.message;
      }
    });

    const canvas = el('candle-canvas');
    canvas.addEventListener('mousemove', ev => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const rows = state.candles.slice(-140);
      const plotW = Math.max(80, rect.width - 12 - 72);
      const idx = Math.floor(((x - 12) / plotW) * rows.length);
      state.hoverIdx = idx >= 0 && idx < rows.length ? idx : -1;
      drawCandleChart();
    });
    canvas.addEventListener('mouseleave', () => {
      state.hoverIdx = -1;
      drawCandleChart();
    });
    window.addEventListener('resize', drawCandleChart);
  }

  wireEvents();
  refreshAll().catch(err => {
    el('mode-status-msg').textContent = `Init error: ${err.message}`;
  });
})();
