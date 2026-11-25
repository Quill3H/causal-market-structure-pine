/* Zero-XSS Dashboard Controller (v7.0): uses ONLY textContent and document.createElement */
(function () {
  'use strict';

  const EQUITY_SYMBOLS = new Set(['SPY', 'DIA', 'QQQ']);

  const state = {
    symbol: 'BTCUSDT.P',
    timeframe: '1h',
    profile: 'EXCHANGE_POST_ONLY',
    riskTier: 'SAFE_75WR',
    version: 'auto',
    frontierVersion: 'auto',
    candles: [],
    overlay: null,
    summary: null,
    regime: null,
    radar: null,
    liquidationDistance: null,
    frontier: null,
    versionsData: null,
    ordersData: null,
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
    if (EQUITY_SYMBOLS.has(state.symbol)) {
      apiBadge.textContent = 'YAHOO PUBLIC • EQUITIES';
      apiBadge.className = 'badge badge-safe';
    } else if (acct.connected) {
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

    if (cfg.riskTier) {
      state.riskTier = cfg.riskTier;
      el('tier-select').value = cfg.riskTier;
    }

    const subtitle = el('model-subtitle');
    subtitle.textContent = `v9.0 Off-TV Router (${state.riskTier}) • ${status.models?.activeModelVersion || 'v9/v8/v7'}`;
  }

  function renderRegimeRadar() {
    const rad = state.radar || state.regime?.v8Radar || state.status?.v8Radar || null;
    const badge = el('radar-regime-badge');
    const actionEl = el('radar-action-text');
    const breadthText = el('radar-breadth-text');
    const breadthBar = el('radar-breadth-bar');
    const coinsRow = el('radar-coins-row');
    const longEl = el('radar-long-mult');
    const shortEl = el('radar-short-mult');
    const dl = el('radar-stats-list');

    clearNode(coinsRow);
    clearNode(dl);

    if (!rad || !rad.ready) {
      badge.textContent = rad?.regime || 'PENDING';
      badge.className = 'badge badge-neutral';
      actionEl.textContent = rad?.regimeActionLabel || 'Waiting for regime_engine_v8 data...';
      breadthText.textContent = '--%';
      breadthBar.style.width = '0%';
      longEl.textContent = '--x';
      shortEl.textContent = '--x';
      return;
    }

    const reg = String(rad.regime || 'UNKNOWN');
    badge.textContent = reg;
    badge.className = `badge ${
      reg === 'BULL_TREND'
        ? 'badge-safe'
        : reg === 'BEAR_TREND'
          ? 'badge-danger'
          : 'badge-warn'
    }`;
    actionEl.textContent = rad.regimeActionLabel || reg;

    const bearPct = rad.breadthBearPct !== null && rad.breadthBearPct !== undefined
      ? Number(rad.breadthBearPct)
      : null;
    if (bearPct !== null && Number.isFinite(bearPct)) {
      breadthText.textContent = `${fmtNum(bearPct, 0)}% < 1D EMA50`;
      breadthBar.style.width = `${Math.max(0, Math.min(100, bearPct))}%`;
    } else {
      breadthText.textContent = rad.assetClass === 'EQUITY_ETF' ? 'Macro ETF Regime' : '--%';
      breadthBar.style.width = '0%';
    }

    for (const c of rad.coinsSummary || []) {
      const pill = document.createElement('span');
      pill.className = `coin-pill ${c.bearEma50 ? 'coin-pill-bear' : 'coin-pill-bull'}`;
      pill.textContent = `${c.coin}: ${c.bearEma50 ? '<EMA50' : '>EMA50'}`;
      coinsRow.appendChild(pill);
    }

    longEl.textContent = `${fmtNum(rad.longSizeMult, 2)}x`;
    shortEl.textContent = `${fmtNum(rad.shortSizeMult, 2)}x`;

    const pairs = [
      ['Trend Score', fmtNum(rad.trendScore, 3)],
    ];
    if (rad.assetClass === 'EQUITY_ETF') {
      pairs.push(['VIX Level', fmtNum(rad.vixLevel, 2)]);
      pairs.push(['VIX 5d Spike', fmtPct(rad.vixSpike5d, 1)]);
      pairs.push(['TNX 20d Shock', fmtPct(rad.tnxShock20d, 1)]);
    } else {
      pairs.push(['D1 Dist EMA50', `${fmtNum(rad.d1Ema50DistAtr, 2)} ATR`]);
      pairs.push(['D1 Slope', `${fmtNum(rad.d1SlopeAtr, 2)} ATR`]);
      pairs.push(['4H Rally Exhaustion', rad.h4RallyExh ? 'EXHAUSTED (1)' : 'NONE (0)']);
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

  function renderScoreboard(sourceLabel) {
    const s = state.summary;
    const r = state.regime;
    const liq = state.liquidationDistance;

    if (s) {
      const wrEl = el('kpi-winrate');
      wrEl.textContent = `${fmtNum(s.winRatePct, 2)}% (${s.wins}W/${s.losses}L)`;
      wrEl.className = `kpi-value ${Number(s.winRatePct) >= 75 ? 'pos' : ''}`;
      el('kpi-wilson').textContent = `Wilson95: ${fmtNum(s.wilsonLower95Pct, 2)}%`;

      const pfEl = el('kpi-pf');
      pfEl.textContent = fmtNum(s.profitFactor, 2);
      pfEl.className = `kpi-value ${Number(s.profitFactor) >= 1.25 ? 'pos' : 'neg'}`;
      el('kpi-trades').textContent = `Trades: ${s.count} (Raw ${s.rawSignalsCount ?? s.count})`;

      const compEl = el('kpi-comp-net-main');
      compEl.textContent = fmtPct(s.compoundedNetPct, 2);
      compEl.className = `kpi-value ${Number(s.compoundedNetPct) >= 0 ? 'pos' : 'neg'}`;
      el('kpi-total-net-sub').textContent = `Additive: ${fmtPct(s.totalNetPct, 2)}`;

      el('kpi-dd').textContent = `${fmtNum(s.compoundedMaxDrawdownPct ?? s.maxDrawdownPct, 2)}%`;
      el('kpi-funding').textContent = EQUITY_SYMBOLS.has(state.symbol)
        ? 'Funding: 0.00% (ETF)'
        : `Funding Drag: ${fmtPct(-Math.abs(Number(s.fundingDragPct || 0)), 2)}`;

      el('kpi-model').textContent = s.modelVersion || 'v4.1-fallback';
      el('kpi-source').textContent = `Profile: ${s.execProfile || state.profile} (${sourceLabel || 'local'})`;
    }

    const liqEl = el('kpi-liq-buffer');
    const liqSub = el('kpi-liq-sub');
    if (liq && liq.bufferPct !== null && liq.bufferPct !== undefined) {
      liqEl.textContent = `${fmtNum(liq.bufferPct, 2)}% (${liq.status})`;
      liqEl.className = `kpi-value ${liq.bufferPct >= 20 ? 'pos' : liq.bufferPct < 10 ? 'neg' : ''}`;
      liqSub.textContent = liq.status === 'CASH_ETF'
        ? 'Unlevered ETF (No Liquidation)'
        : `Liq Px: ${fmtNum(liq.liqPrice, 2)} • Lev ${fmtNum(liq.lev, 2)}x`;
    } else {
      liqEl.textContent = '--';
      liqSub.textContent = 'Liq Px: -- • MMR 0.5%';
    }

    const regEl = el('kpi-regime');
    const regSub = el('kpi-regime-sub');
    if (r) {
      const rad = state.radar || r.v8Radar;
      const v8Part = rad?.ready ? rad.regime : null;
      const vixPart = r.vix !== null && r.vix !== undefined ? `VIX ${fmtNum(r.vix, 1)} (${r.vixRegime})` : 'VIX --';
      const tnxPart = r.tnx !== null && r.tnx !== undefined ? `TNX ${fmtNum(r.tnx, 2)}%` : 'TNX --';
      regEl.textContent = v8Part ? `${v8Part} • ${vixPart}` : `${vixPart} • ${tnxPart}`;
      const fundPart = r.fundingRateBps !== null && r.fundingRateBps !== undefined ? `Fund ${fmtNum(r.fundingRateBps, 2)}bps` : 'Fund --';
      const cvdPart = r.cvd24hPct !== null && r.cvd24hPct !== undefined ? `CVD24h ${fmtPct(r.cvd24hPct, 1)}` : 'CVD --';
      regSub.textContent = `${tnxPart} | ${fundPart} | ${cvdPart}`;
    }
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

  function drawArcGauge(canvasId, valueRatio, thresholdRatio, color) {
    const canvas = el(canvasId);
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = 240;
    const cssH = 130;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const cx = cssW / 2;
    const cy = 112;
    const radius = 84;

    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI, 2 * Math.PI);
    ctx.stroke();

    if (Number.isFinite(thresholdRatio)) {
      const tauAngle = Math.PI + Math.max(0, Math.min(1, thresholdRatio)) * Math.PI;
      ctx.save();
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(tauAngle) * (radius - 12), cy + Math.sin(tauAngle) * (radius - 12));
      ctx.lineTo(cx + Math.cos(tauAngle) * (radius + 12), cy + Math.sin(tauAngle) * (radius + 12));
      ctx.stroke();
      ctx.restore();
    }

    if (Number.isFinite(valueRatio)) {
      const clamped = Math.max(0, Math.min(1, valueRatio));
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, Math.PI, Math.PI + clamped * Math.PI);
      ctx.stroke();
    }
  }

  function drawMlGauge() {
    const latestSig = state.signals[0] || state.overlay?.lastSignal || null;
    const prob = Number.isFinite(Number(latestSig?.probWin)) ? Number(latestSig.probWin) : null;
    const tau = Number.isFinite(Number(state.summary?.mlThreshold)) ? Number(state.summary.mlThreshold) : 0.55;

    const pctText = el('ml-prob-text');
    const decBadge = el('ml-decision-badge');
    el('ml-threshold-text').textContent = `Threshold tau: ${(tau * 100).toFixed(1)}%`;

    if (prob === null) {
      drawArcGauge('ml-gauge-canvas', NaN, tau, '#38bdf8');
      pctText.textContent = 'Rules/Fallback';
      decBadge.textContent = state.summary?.modelVersion || 'FALLBACK';
      decBadge.className = 'badge badge-neutral';
      return;
    }

    drawArcGauge('ml-gauge-canvas', prob, tau, prob >= tau ? '#22c55e' : '#ef4444');
    pctText.textContent = `${(prob * 100).toFixed(1)}%`;
    decBadge.textContent = latestSig?.decision || (prob >= tau ? 'ACCEPTED' : 'FILTERED');
    decBadge.className = `badge ${prob >= tau ? 'badge-safe' : 'badge-warn'}`;
  }

  function drawSweepGauge() {
    const f = state.frontier;
    const tierBadge = el('frontier-tier-badge');
    const moText = el('sweep-mo-text');
    const metaText = el('sweep-meta-text');
    const dl = el('frontier-stats-list');
    clearNode(dl);

    tierBadge.textContent = state.riskTier;
    const sel = f?.selectedTier;
    const full = sel?.full5y || sel;
    const y5 = sel?.holdoutY5;

    if (!f?.ready || !full) {
      const fallbackMo = state.summary?.meanMonthlySweepPct;
      const ratio = Number.isFinite(fallbackMo) ? Math.max(0, Math.min(1, fallbackMo / 40)) : NaN;
      drawArcGauge('sweep-gauge-canvas', ratio, 30 / 40, '#38bdf8');
      moText.textContent = Number.isFinite(fallbackMo) ? `${fmtPct(fallbackMo, 2)}/mo` : 'Pending v7';
      metaText.textContent = `Frontier summary loading • Liq: ${state.summary?.liquidationCount ?? 0}`;
      return;
    }

    const meanMo = Number(full.meanMonthlySweepPct ?? full.geomMonthlyPct ?? 0);
    const maxDd = Number(full.maxMonthlySweepDdPct ?? full.maxCompoundedDdPct ?? full.compoundedMaxDrawdownPct ?? 0);
    const liqCount = Number(full.liquidationCount ?? 0);
    const wr = Number(full.winRatePct ?? 0);

    drawArcGauge('sweep-gauge-canvas', meanMo / 40, 30 / 40, meanMo >= 30 ? '#22c55e' : '#38bdf8');
    moText.textContent = `${fmtPct(meanMo, 2)}/mo`;
    metaText.textContent = `SweepDD: ${fmtNum(maxDd, 2)}% • Liq: ${liqCount}`;
    tierBadge.className = `badge ${liqCount === 0 && wr >= 75 ? 'badge-safe' : 'badge-warn'}`;

    const pairs = [
      ['Full 5Y WR / PF', `${fmtNum(wr, 2)}% / ${fmtNum(full.profitFactor, 2)}`],
      ['Positive Months', `${fmtNum(full.pctPositiveMonths, 1)}%`],
      ['Months >= +30%', `${fmtNum(full.pctMonthsGe30, 1)}%`],
      ['Worst Month', fmtPct(full.worstMonthPct, 2)],
    ];
    if (y5) {
      pairs.push(['Holdout Y5 Sweep', `${fmtPct(y5.meanMonthlySweepPct, 2)}/mo (${fmtNum(y5.winRatePct, 1)}% WR)`]);
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
      ctx.fillText('No closed candles available yet. Run sync or select a loaded dataset.', 24, 40);
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
        `${fmtUtc(r.time)} UTC  O:${fmtNum(r.open, 2)}  H:${fmtNum(r.high, 2)}  L:${fmtNum(r.low, 2)}  C:${fmtNum(r.close, 2)}`;
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

  function renderOrderRouterPanel() {
    const data = state.ordersData || {};
    const router = data.router || state.status?.routerStatus || {};
    const guideList = data.okxKeyGuide || router.okxKeyGuide || [];
    const orders = data.orders || [];

    const modeBadge = el('router-mode-badge');
    const modeStr = router.mode || 'PAPER_ZERO_KEY';
    modeBadge.textContent = modeStr;
    modeBadge.className = `badge ${
      modeStr === 'LIVE_EXCHANGE_ARMED'
        ? 'badge-danger'
        : modeStr === 'OKX_DEMO_SIMULATED'
          ? 'badge-warn'
          : 'badge-safe'
    }`;
    el('router-reason-text').textContent = router.reason || 'Default PAPER mode (zero external API keys required)';

    const guideGrid = el('okx-key-guide-grid');
    clearNode(guideGrid);
    for (const item of guideList) {
      const card = document.createElement('div');
      card.className = `guide-card ${item.mode === modeStr ? 'guide-card-active' : ''}`;
      const title = document.createElement('strong');
      title.textContent = `${item.label || item.mode}`;
      const keys = document.createElement('span');
      keys.textContent = `Keys: ${item.keysNeeded || '--'}`;
      const perms = document.createElement('span');
      perms.textContent = `Perms: ${item.permissions || '--'}`;
      const flags = document.createElement('code');
      flags.className = 'mono-code';
      flags.textContent = item.envFlags || '';
      card.appendChild(title);
      card.appendChild(keys);
      card.appendChild(perms);
      card.appendChild(flags);
      guideGrid.appendChild(card);
    }

    const tbody = el('orders-tbody');
    clearNode(tbody);
    if (orders.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.textContent = 'No orders routed yet in orders_log (run daemon serve / router transition to inspect clOrdId audit).';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const o of orders.slice(0, 40)) {
      const tr = document.createElement('tr');
      const cells = [
        o.clientOrderId || '--',
        o.exchange || '--',
        o.symbol || '--',
        o.mode || '--',
        `${o.orderType || '--'}${o.reduceOnly ? ' (RO)' : ''}`,
        String(o.side || '--').toUpperCase(),
        fmtNum(o.price, 2),
        fmtNum(o.qty, 4),
        o.status || '--',
      ];
      cells.forEach((txt, idx) => {
        const td = document.createElement('td');
        td.textContent = txt;
        if (idx === 0) td.className = 'mono-code';
        if (idx === 8) {
          td.className = o.status === 'REJECTED' || o.status === 'INTERRUPTED' ? 'neg' : 'pos';
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function extractVersionDisplaySummary(r) {
    const m = r?.metrics || {};
    let block = null;
    if (m.tiers) {
      const tierNode = m.tiers.TIER_1_SAFE_75WR || m.tiers.SAFE_V9 || Object.values(m.tiers)[0];
      const profNode = tierNode?.postOnly || tierNode?.EXCHANGE_POST_ONLY || tierNode?.profiles?.EXCHANGE_POST_ONLY || tierNode;
      block = profNode?.full5y_61m || profNode?.full5y_60m || profNode?.full5y || profNode?.holdoutY5 || profNode;
    } else if (m.cryptoQualifiedPostOnly) {
      block = m.cryptoQualifiedPostOnly.full5y || m.cryptoQualifiedPostOnly.holdoutY5;
    } else if (m.postOnly) {
      block = m.postOnly.full3y || m.postOnly.holdoutY3;
    } else if (m.btc1hVolNorm) {
      block = m.btc1hVolNorm.full3y || m.btc1hVolNorm.holdoutY3;
    } else if (m.track1h_r5) {
      block = m.track1h_r5.full3y || m.track1h_r5.holdoutY3;
    } else if (m.track1h) {
      block = m.track1h.holdout || m.track1h.full12m;
    } else if (m.blindOos?.tf1h) {
      block = m.blindOos.tf1h;
    } else if (m.primary) {
      block = m.primary;
    }

    const wrVal = r.wrPct ?? block?.winRatePct ?? block?.validationWr1hPct ?? null;
    const moVal = r.monthlySweepPct ?? block?.meanMonthlySweepPct ?? null;
    const retVal = r.fullNetPct ?? block?.compoundedNetPct ?? block?.totalNetPct ?? block?.netPct ?? null;
    const ddVal = r.maxDdPct ?? block?.maxCompoundedDdPct ?? block?.compoundedMaxDrawdownPct ?? block?.maxDrawdownPct ?? null;
    const note = r.oosNote
      || (Array.isArray(r.strengths) && r.strengths[0])
      || (Array.isArray(r.weaknesses) && r.weaknesses[0])
      || r.status
      || '--';
    return { wrVal, moVal, retVal, ddVal, note };
  }

  function renderVersionsMatrixPanel() {
    const vData = state.versionsData || {};
    const rows = vData.versions || vData.comparisonRows || vData.matrix || [];
    const recs = vData.recommendationsByGoal || vData.recommendations || [];

    const badge = el('versions-status-badge');
    badge.textContent = vData.ready ? `${rows.length} VERSIONS READY` : 'PREVIEW FALLBACK';
    badge.className = `badge ${vData.ready ? 'badge-safe' : 'badge-warn'}`;
    el('versions-source-text').textContent = `Source: ${vData.source || 'local'}`;

    const tbody = el('versions-tbody');
    clearNode(tbody);
    for (const r of rows) {
      const tr = document.createElement('tr');
      const { wrVal, moVal, retVal, ddVal, note } = extractVersionDisplaySummary(r);
      const cells = [
        r.version || r.id || '--',
        r.era || r.label || r.architecture || '--',
        typeof wrVal === 'number' ? `${fmtNum(wrVal, 2)}%` : (wrVal || '--'),
        typeof moVal === 'number' ? `${fmtPct(moVal, 2)}/mo` : (moVal || '--'),
        typeof retVal === 'number' ? fmtPct(retVal, 2) : (retVal || '--'),
        typeof ddVal === 'number' ? `${fmtNum(ddVal, 2)}%` : (ddVal || '--'),
        note,
      ];
      for (const txt of cells) {
        const td = document.createElement('td');
        td.textContent = String(txt);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    const recsGrid = el('versions-recs-grid');
    clearNode(recsGrid);
    for (const rec of recs) {
      const card = document.createElement('div');
      card.className = 'rec-card';
      const title = document.createElement('strong');
      title.textContent = `${rec.goal || rec.useCase || 'Goal'}: ${rec.recommendedVersion || rec.recommended || rec.version || '--'}`;
      const why = document.createElement('span');
      why.textContent = rec.rationale || rec.reason || rec.why || rec.notes || '';
      card.appendChild(title);
      card.appendChild(why);
      recsGrid.appendChild(card);
    }
  }

  async function refreshAll() {
    const q = `symbol=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}`;
    const fq = `tier=${encodeURIComponent(state.riskTier)}&profile=${encodeURIComponent(state.profile === 'EQUITY_ETF' ? 'EXCHANGE_POST_ONLY' : state.profile)}&version=${encodeURIComponent(state.frontierVersion)}`;
    el('chart-title').textContent = `${state.symbol} • ${state.timeframe} Closed Candles & Order Levels`;

    const [statusData, candleData, tradeData, sigData, frontierData, regimeData, versionsData, ordersData] = await Promise.all([
      apiGet(`/api/status?${q}`),
      apiGet(`/api/candles?${q}&limit=160`),
      apiGet(`/api/trades?${q}&limit=60`),
      apiGet(`/api/signals?${q}&limit=40`),
      apiGet(`/api/frontier?${fq}`),
      apiGet(`/api/regime?${q}`),
      apiGet('/api/versions'),
      apiGet('/api/orders?limit=40'),
    ]);

    state.status = statusData;
    state.candles = candleData.candles || [];
    state.overlay = candleData.overlay || statusData.activeOverlay || null;
    state.regime = regimeData.telemetry || candleData.regime || statusData.regime || null;
    state.radar = regimeData.radar || statusData.v8Radar || null;
    state.liquidationDistance = statusData.liquidationDistance || null;
    state.frontier = frontierData;
    if (frontierData.version) {
      el('frontier-version-select').value = frontierData.version;
    }
    state.versionsData = versionsData;
    state.ordersData = ordersData;
    state.trades = tradeData.trades || [];
    state.summary = tradeData.summary || statusData.summary || null;
    state.signals = sigData.signals || [];

    renderBadges();
    renderRegimeRadar();
    renderScoreboard(candleData.source);
    renderOverlayDetails();
    drawMlGauge();
    drawSweepGauge();
    drawCandleChart();
    renderTables();
    renderOrderRouterPanel();
    renderVersionsMatrixPanel();
  }

  async function runOfflineReplay() {
    const q = `symbol=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}&profile=${encodeURIComponent(state.profile)}&tier=${encodeURIComponent(state.riskTier)}&version=${encodeURIComponent(state.version)}`;
    const msg = el('mode-status-msg');
    msg.textContent = `Running offline replay (${state.version})...`;
    const data = await apiGet(`/api/backtest?${q}`);
    state.summary = data.summary;
    state.regime = data.regime || state.regime;
    state.liquidationDistance = data.liquidationDistance || state.liquidationDistance;
    state.trades = data.recentTrades || [];
    renderScoreboard(data.source);
    drawSweepGauge();
    renderTables();
    msg.textContent = `Replay (${state.version}) complete: ${data.summary.count} trades, WR ${fmtNum(data.summary.winRatePct, 2)}%, PF ${fmtNum(data.summary.profitFactor, 2)}, Comp ${fmtPct(data.summary.compoundedNetPct, 2)}`;
  }

  function wireEvents() {
    el('symbol-select').addEventListener('change', e => {
      state.symbol = e.target.value;
      if (EQUITY_SYMBOLS.has(state.symbol)) {
        state.timeframe = '1d';
        state.profile = 'EQUITY_ETF';
      } else {
        if (state.timeframe === '1d') state.timeframe = '1h';
        if (state.profile === 'EQUITY_ETF') state.profile = 'EXCHANGE_POST_ONLY';
      }
      el('timeframe-select').value = state.timeframe;
      el('profile-select').value = state.profile;
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
    el('version-select').addEventListener('change', e => {
      state.version = e.target.value;
      runOfflineReplay().catch(err => { el('mode-status-msg').textContent = err.message; });
    });
    el('tier-select').addEventListener('change', async e => {
      state.riskTier = e.target.value;
      try {
        await fetch('/api/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ riskTier: state.riskTier }),
        });
        await refreshAll();
      } catch (err) {
        el('mode-status-msg').textContent = err.message;
      }
    });
    el('frontier-version-select').addEventListener('change', async e => {
      state.frontierVersion = e.target.value;
      try {
        const fq = `tier=${encodeURIComponent(state.riskTier)}&profile=${encodeURIComponent(state.profile === 'EQUITY_ETF' ? 'EXCHANGE_POST_ONLY' : state.profile)}&version=${encodeURIComponent(state.frontierVersion)}`;
        state.frontier = await apiGet(`/api/frontier?${fq}`);
        drawSweepGauge();
      } catch (err) {
        el('mode-status-msg').textContent = err.message;
      }
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
            riskTier: state.riskTier,
            confirmToken,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          msg.textContent = `Blocked: ${data.error || res.status}`;
          return;
        }
        el('confirm-token-input').value = '';
        msg.textContent = `Updated mode to ${data.config.executionMode} (DRY_RUN=${data.config.dryRun}, TIER=${data.config.riskTier})`;
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
