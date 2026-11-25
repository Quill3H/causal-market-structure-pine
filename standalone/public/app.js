/* Zero-XSS Dashboard Controller (v12.5): uses ONLY textContent, document.createElement, createElementNS, and replaceChildren */
(function () {
  'use strict';

  const EQUITY_SYMBOLS = new Set(['SPY', 'DIA', 'QQQ']);
  const STORAGE_TOKEN_KEY = 'tt11_session_token';
  const STORAGE_SUB_ID_KEY = 'tt11_subscriber_id';
  const STORAGE_THEME_KEY = 'tt12_theme';
  const STORAGE_PRO_MODE_KEY = 'tt12_pro_mode';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const COIN_NAMES = {
    'BTCUSDT.P': 'BTC',
    'ETHUSDT.P': 'ETH',
    'SOLUSDT.P': 'SOL',
    'BNBUSDT.P': 'BNB',
    'BTC-USDT-SWAP': 'BTC',
    'ETH-USDT-SWAP': 'ETH',
    'SOL-USDT-SWAP': 'SOL',
    'BNB-USDT-SWAP': 'BNB',
  };

  const FLOW_STAGES = [
    {
      id: 'stage-1',
      num: '01',
      title: 'Két sắt AES-256-GCM',
      short: 'Mã hóa API Key, chặn quyền Withdraw',
      desc: 'Khóa API, Secret và Passphrase được mã hóa ngay khi gửi lên máy chủ bằng AES-256-GCM. Hệ thống kiểm tra quyền API và từ chối ngay nếu phát hiện quyền rút tiền.',
    },
    {
      id: 'stage-2',
      num: '02',
      title: 'Đồng bộ Nến & Funding',
      short: 'Nến đóng 15m/1h/1d và Funding Rate',
      desc: 'Mỗi chu kỳ Autopilot đồng bộ dữ liệu nến đã đóng cửa, Funding Rate trên OKX/Binance và dữ liệu vĩ mô VIX/TNX, bảo đảm không đọc nến tương lai.',
    },
    {
      id: 'stage-3',
      num: '03',
      title: 'Radar v8 + AI v9',
      short: 'Nhận diện Regime và xác suất ML',
      desc: 'Radar v8 đo độ rộng xu hướng 4 đồng coin so với EMA50 khung 1D, kết hợp mô hình ML Ensemble v9 để lọc tín hiệu đạt chuẩn xác suất thắng cao.',
    },
    {
      id: 'stage-4',
      num: '04',
      title: 'Quét Vốn & Chia lô',
      short: 'Phân tầng vốn và làm tròn hợp đồng',
      desc: 'Tự động phân tầng MICRO, STANDARD hoặc PRO_WHALE dựa trên số dư, quy đổi khối lượng theo OKX ctVal hoặc Binance stepSize và khóa trần ký quỹ 85%.',
    },
    {
      id: 'stage-5',
      num: '05',
      title: '7 Chốt Chặn An Toàn',
      short: 'Bản quyền, PIN RAM, lỗ ngày, MaxDD',
      desc: 'Kiểm định đồng thời 7 chốt chặn trước khi đặt lệnh: bản quyền còn hạn, không có Withdraw, PIN khớp trong RAM, lỗ ngày chưa chạm trần, MaxDD an toàn, đòn bẩy hợp lệ và chống gửi trùng.',
    },
    {
      id: 'stage-6',
      num: '06',
      title: 'Post-Only + OCO 24/7',
      short: 'Đặt Maker kèm bảo vệ SL/TP reduceOnly',
      desc: 'Tự động gửi lệnh giới hạn Post-Only kèm lệnh cắt lỗ/chốt lời reduceOnly với mã clOrdId riêng cho từng tài khoản, chạy liên tục 24/7 và tự khóa REARM_REQUIRED khi khởi động lại.',
    },
  ];

  const EVOLUTION_ROWS = [
    ['v1.4', 'SMC Core Engine', 'Khung nhận diện Order Block, FVG, Sweep và cấu trúc nhân quả.', 'Backtest thủ công, không dùng khóa API.'],
    ['v3.0', 'Pine Script Parity', 'Khớp logic TradingView Pine Script với dữ liệu nến đóng cửa.', 'Kiểm tra từng nến tránh look-ahead.'],
    ['v5.0', 'ML Probability Filter', 'Chấm điểm xác suất thắng ProbWin bằng mô hình phân loại.', 'Chặn tín hiệu dưới ngưỡng tau.'],
    ['v6.0', 'Multi-Asset Expansion', 'Mở rộng BTC, ETH, SOL, BNB cùng danh mục ETF SPY, DIA, QQQ.', 'Quản lý thanh khoản và khoảng cách thanh lý.'],
    ['v7.0', 'High-WR Frontier', 'Tối ưu 3 tầng rủi ro SAFE, BALANCED và TARGET_30MO.', 'Bảng kiểm định Walk-Forward và Profit Sweep.'],
    ['v8.0', 'Macro Regime Radar', 'Đo độ rộng 4 đồng coin và điều chỉnh SizeMult theo xu hướng.', 'Tự động hạ rủi ro khi thị trường đi ngang.'],
    ['v9.0', 'Ensemble & DD Guard', 'Kết hợp mô hình v8/v9 cùng bộ chặn sụt giảm Walk-Forward.', 'Giữ ổn định hiệu suất qua nhiều chu kỳ.'],
    ['v10.0', 'Multi-Tenant Vault', 'Két sắt AES-256-GCM đa người dùng, tách mã clOrdId.', 'Phân tầng vốn MICRO, STANDARD, PRO_WHALE.'],
    ['v11.0', 'E2E Autopilot', 'Thiết lập 3 bước, Quickstart cục bộ và Autopilot chạy nền 24/7.', 'PIN chỉ giữ trong RAM, phục hồi REARM_REQUIRED.'],
    ['v12.0', 'Human Studio & Sandbox', 'Thử nghiệm Paper Sandbox $1,000, giao diện Sáng/Tối và cài đặt tại chỗ.', 'Cập nhật hoặc xóa hồ sơ không tạo trùng lặp.'],
    ['v12.5', 'Consumer UX', 'Ẩn thuật ngữ kỹ thuật mặc định, giữ tùy chọn Chế độ chuyên gia.', 'Đón khách bằng 2 nút chính và bảng Giao dịch gần đây dễ hiểu.'],
  ];

  const state = {
    activeTab: 'autopilot',
    proMode: false,
    connectFormOpen: false,
    theme: 'light dark',
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
    commercialPlans: null,
    commercialSim: null,
    subSessionToken: '',
    subDashboard: null,
    signals: [],
    trades: [],
    status: null,
    hoverIdx: -1,
    autopilotSessionToken: '',
    autopilotSubscriberId: '',
    autopilotStatus: null,
    preflightData: null,
    wizardCollapsed: false,
    wizardUserExpanded: false,
    selectedFlowStageId: 'stage-1',
    pollTimerId: null,
    countdownTimerId: null,
    countdownSec: 0,
    deleteConfirmArmed: false,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function clearNode(node) {
    if (!node) return;
    node.replaceChildren();
  }

  function readStorage(storage, key) {
    try {
      return storage ? (storage.getItem(key) || '') : '';
    } catch {
      return '';
    }
  }

  function writeStorage(storage, key, val) {
    try {
      if (!storage) return;
      if (val !== '' && val !== null && val !== undefined) {
        storage.setItem(key, val);
      } else {
        storage.removeItem(key);
      }
    } catch {
      // Ignore storage access errors in restricted contexts
    }
  }

  function getEffectiveThemeMode() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    const content = meta ? meta.getAttribute('content') : 'light dark';
    if (content === 'light' || content === 'dark') return content;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(mode, persist = true) {
    const normalized = mode === 'dark' || mode === 'light' ? mode : getEffectiveThemeMode();
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) {
      meta.setAttribute('content', normalized);
    }
    state.theme = normalized;
    if (persist) {
      writeStorage(window.localStorage, STORAGE_THEME_KEY, normalized);
    }
    const btn = el('theme-toggle-btn');
    if (btn) {
      btn.textContent = normalized === 'dark' ? 'Giao diện: Tối' : 'Giao diện: Sáng';
      btn.setAttribute('aria-pressed', normalized === 'dark' ? 'true' : 'false');
    }
    if (state.activeTab === 'quant') {
      drawCandleChart();
      drawMlGauge();
      drawSweepGauge();
    }
  }

  function initTheme() {
    const saved = readStorage(window.localStorage, STORAGE_THEME_KEY);
    if (saved === 'light' || saved === 'dark') {
      applyTheme(saved, false);
    } else {
      const osDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      applyTheme(osDark ? 'dark' : 'light', false);
    }
  }

  function applyProMode(enabled, persist = true) {
    state.proMode = Boolean(enabled);
    if (persist) {
      writeStorage(window.localStorage, STORAGE_PRO_MODE_KEY, state.proMode ? '1' : '0');
    }
    document.body.classList.toggle('pro-mode', state.proMode);
    const proBtn = el('pro-mode-toggle-btn');
    if (proBtn) {
      proBtn.setAttribute('aria-pressed', state.proMode ? 'true' : 'false');
    }
    const tabsNav = el('workspace-tabs-nav');
    if (tabsNav) {
      tabsNav.classList.toggle('is-hidden', !state.proMode);
    }
    if (!state.proMode && state.activeTab !== 'autopilot') {
      switchWorkspaceTab('autopilot');
    }
    renderSubtitleCopy();
    renderAutopilotView();
  }

  function initProMode() {
    const saved = readStorage(window.localStorage, STORAGE_PRO_MODE_KEY);
    state.proMode = saved === '1';
    applyProMode(state.proMode, false);
  }

  function renderSubtitleCopy() {
    const subtitle = el('model-subtitle');
    if (!subtitle) return;
    if (!state.proMode) {
      subtitle.textContent = 'Tự động giao dịch an toàn · Không bao giờ có quyền rút tiền';
      return;
    }
    const modelVer = state.status?.models?.activeModelVersion || 'v9/v8/v7';
    subtitle.textContent = `Két sắt AES-256-GCM · ${state.riskTier} · ${modelVer}`;
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function setAutopilotSession(token, subscriberId) {
    state.autopilotSessionToken = token || '';
    state.autopilotSubscriberId = subscriberId || '';
    state.subSessionToken = token || '';
    writeStorage(window.sessionStorage, STORAGE_TOKEN_KEY, state.autopilotSessionToken);
    writeStorage(window.sessionStorage, STORAGE_SUB_ID_KEY, state.autopilotSubscriberId);
  }

  function fmtNum(val, digits = 2) {
    if (val === null || val === undefined || !Number.isFinite(Number(val))) return '-';
    return Number(val).toFixed(digits);
  }

  function fmtPct(val, digits = 2) {
    if (val === null || val === undefined || !Number.isFinite(Number(val))) return '-';
    const n = Number(val);
    return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
  }

  function fmtUtc(sec) {
    if (!Number.isFinite(Number(sec))) return '-';
    const n = Number(sec);
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toISOString().slice(5, 16).replace('T', ' ');
  }

  function fmtIsoShort(val) {
    if (val === null || val === undefined || val === '') return 'Chưa có';
    const d = typeof val === 'number' || /^\d+$/.test(String(val))
      ? new Date(Number(val))
      : new Date(val);
    if (Number.isNaN(d.getTime())) return String(val);
    return d.toISOString().slice(5, 19).replace('T', ' ');
  }

  function formatCoinName(symbol) {
    const raw = String(symbol || '').toUpperCase();
    if (COIN_NAMES[raw]) return COIN_NAMES[raw];
    return raw.replace(/USDT\.P$|USDT$|-USDT-SWAP$/, '') || raw;
  }

  function formatPlainMode(executionMode, sub) {
    const m = String(executionMode || '').toUpperCase();
    if (m === 'PAPER_AUTO_TRADE' || sub?.isPaperSandbox) return 'Dùng thử tiền ảo ($1,000)';
    if (m === 'DEMO_AUTO_TRADE') return 'Tài khoản thử nghiệm (Demo)';
    if (m === 'LIVE_AUTO_TRADE') return 'Giao dịch tiền thật';
    if (m === 'SCAN_AND_SIGNAL_ONLY') return 'Chỉ theo dõi tín hiệu';
    return sub?.simulated ? 'Tài khoản thử nghiệm (Demo)' : 'Giao dịch tiền thật';
  }

  function formatApiError(data, status) {
    if (data && data.userMessage) {
      return data.recoveryHint ? `${data.userMessage} Gợi ý: ${data.recoveryHint}` : data.userMessage;
    }
    return (data && data.error) || `HTTP ${status}`;
  }

  async function apiGet(path, extraHeaders = {}) {
    const res = await fetch(path, {
      headers: { Accept: 'application/json', ...extraHeaders },
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const err = new Error(formatApiError(data, res.status));
      err.status = res.status;
      err.rawError = data?.error || '';
      throw err;
    }
    return data;
  }

  async function apiPost(path, payload = {}, extraHeaders = {}) {
    const res = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const err = new Error(formatApiError(data, res.status));
      err.status = res.status;
      err.rawError = data?.error || '';
      throw err;
    }
    return data;
  }

  function switchWorkspaceTab(tabName) {
    state.activeTab = tabName;
    const tabs = [
      { key: 'autopilot', btnId: 'view-tab-autopilot', panelId: 'e2e-autopilot-view' },
      { key: 'flow', btnId: 'view-tab-flow', panelId: 'e2e-flow-view' },
      { key: 'quant', btnId: 'view-tab-quant', panelId: 'quant-pro-view' },
    ];
    for (const t of tabs) {
      const btn = el(t.btnId);
      const panel = el(t.panelId);
      const active = t.key === tabName;
      if (btn) {
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      if (panel) {
        panel.classList.toggle('is-hidden', !active);
      }
    }
    if (tabName === 'quant') {
      window.requestAnimationFrame(() => {
        drawCandleChart();
        drawMlGauge();
        drawSweepGauge();
      });
    }
    if (tabName === 'flow') {
      renderFlowView();
    }
  }

  function renderBadges() {
    const status = state.status;
    if (!status) return;
    const cfg = status.config || {};
    const acct = status.accountHealth || {};

    const apiBadge = el('api-badge');
    if (EQUITY_SYMBOLS.has(state.symbol)) {
      apiBadge.textContent = 'YAHOO PUBLIC · EQUITIES';
      apiBadge.className = 'status-dot-label status-safe';
    } else if (acct.connected) {
      apiBadge.textContent = `${cfg.exchange} ${acct.simulated || acct.testnet ? 'DEMO' : 'LIVE'} CONNECTED`;
      apiBadge.className = 'status-dot-label status-safe';
    } else if (acct.configured) {
      apiBadge.textContent = `${cfg.exchange} KEYS SET (OFFLINE)`;
      apiBadge.className = 'status-dot-label status-warn';
    } else {
      apiBadge.textContent = `${cfg.exchange} PUBLIC · NO KEYS`;
      apiBadge.className = 'status-dot-label';
    }

    const modeBadge = el('mode-badge');
    if (cfg.executionMode === 'LIVE_ARMED' && cfg.dryRun === false) {
      modeBadge.textContent = `MODE: LIVE_ARMED (${cfg.maxLeverageCap}x)`;
      modeBadge.className = 'status-dot-label status-danger';
    } else {
      modeBadge.textContent = `MODE: ${cfg.executionMode} (DRY_RUN=${cfg.dryRun ? 'ON' : 'OFF'})`;
      modeBadge.className = 'status-dot-label status-safe';
    }

    if (cfg.riskTier) {
      state.riskTier = cfg.riskTier;
      el('tier-select').value = cfg.riskTier;
    }

    renderSubtitleCopy();
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
      badge.className = 'status-dot-label';
      actionEl.textContent = rad?.regimeActionLabel || 'Waiting for regime_engine_v8 data...';
      breadthText.textContent = '-%';
      breadthBar.style.width = '0%';
      longEl.textContent = '-x';
      shortEl.textContent = '-x';
      return;
    }

    const reg = String(rad.regime || 'UNKNOWN');
    badge.textContent = reg;
    badge.className = `status-dot-label ${
      reg === 'BULL_TREND'
        ? 'status-safe'
        : reg === 'BEAR_TREND'
          ? 'status-danger'
          : 'status-warn'
    }`;
    actionEl.textContent = rad.regimeActionLabel || reg;

    const bearPct = rad.breadthBearPct !== null && rad.breadthBearPct !== undefined
      ? Number(rad.breadthBearPct)
      : null;
    if (bearPct !== null && Number.isFinite(bearPct)) {
      breadthText.textContent = `${fmtNum(bearPct, 0)}% < 1D EMA50`;
      breadthBar.style.width = `${Math.max(0, Math.min(100, bearPct))}%`;
    } else {
      breadthText.textContent = rad.assetClass === 'EQUITY_ETF' ? 'Macro ETF Regime' : '-%';
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
        : `Liq Px: ${fmtNum(liq.liqPrice, 2)} · Lev ${fmtNum(liq.lev, 2)}x`;
    } else {
      liqEl.textContent = '-';
      liqSub.textContent = 'Liq Px: - · MMR 0.5%';
    }

    const regEl = el('kpi-regime');
    const regSub = el('kpi-regime-sub');
    if (r) {
      const rad = state.radar || r.v8Radar;
      const v8Part = rad?.ready ? rad.regime : null;
      const vixPart = r.vix !== null && r.vix !== undefined ? `VIX ${fmtNum(r.vix, 1)} (${r.vixRegime})` : 'VIX -';
      const tnxPart = r.tnx !== null && r.tnx !== undefined ? `TNX ${fmtNum(r.tnx, 2)}%` : 'TNX -';
      regEl.textContent = v8Part ? `${v8Part} · ${vixPart}` : `${vixPart} · ${tnxPart}`;
      const fundPart = r.fundingRateBps !== null && r.fundingRateBps !== undefined ? `Fund ${fmtNum(r.fundingRateBps, 2)}bps` : 'Fund -';
      const cvdPart = r.cvd24hPct !== null && r.cvd24hPct !== undefined ? `CVD24h ${fmtPct(r.cvd24hPct, 1)}` : 'CVD -';
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
      pairs.push(['Decision', ov.lastSignal.decision || '-']);
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
    if (!canvas) return;
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
    ctx.strokeStyle = cssVar('--surface-subtle', '#1e293b');
    ctx.beginPath();
    ctx.arc(cx, cy, radius, Math.PI, 2 * Math.PI);
    ctx.stroke();

    if (Number.isFinite(thresholdRatio)) {
      const tauAngle = Math.PI + Math.max(0, Math.min(1, thresholdRatio)) * Math.PI;
      ctx.save();
      ctx.strokeStyle = cssVar('--amber', '#fbbf24');
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
      drawArcGauge('ml-gauge-canvas', NaN, tau, cssVar('--accent', '#0d665f'));
      pctText.textContent = 'Rules/Fallback';
      decBadge.textContent = state.summary?.modelVersion || 'FALLBACK';
      decBadge.className = 'status-dot-label';
      return;
    }

    const okColor = cssVar('--green', '#166534');
    const badColor = cssVar('--red', '#b91c1c');
    drawArcGauge('ml-gauge-canvas', prob, tau, prob >= tau ? okColor : badColor);
    pctText.textContent = `${(prob * 100).toFixed(1)}%`;
    decBadge.textContent = latestSig?.decision || (prob >= tau ? 'ACCEPTED' : 'FILTERED');
    decBadge.className = `status-dot-label ${prob >= tau ? 'status-safe' : 'status-warn'}`;
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
      drawArcGauge('sweep-gauge-canvas', ratio, 30 / 40, cssVar('--accent', '#0d665f'));
      moText.textContent = Number.isFinite(fallbackMo) ? `${fmtPct(fallbackMo, 2)}/mo` : 'Pending v7';
      metaText.textContent = `Frontier summary loading · Liq: ${state.summary?.liquidationCount ?? 0}`;
      return;
    }

    const meanMo = Number(full.meanMonthlySweepPct ?? full.geomMonthlyPct ?? 0);
    const maxDd = Number(full.maxMonthlySweepDdPct ?? full.maxCompoundedDdPct ?? full.compoundedMaxDrawdownPct ?? 0);
    const liqCount = Number(full.liquidationCount ?? 0);
    const wr = Number(full.winRatePct ?? 0);

    drawArcGauge('sweep-gauge-canvas', meanMo / 40, 30 / 40, meanMo >= 30 ? cssVar('--green', '#166534') : cssVar('--accent', '#0d665f'));
    moText.textContent = `${fmtPct(meanMo, 2)}/mo`;
    metaText.textContent = `SweepDD: ${fmtNum(maxDd, 2)}% · Liq: ${liqCount}`;
    tierBadge.className = `status-dot-label ${liqCount === 0 && wr >= 75 ? 'status-safe' : 'status-warn'}`;

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
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const width = wrap.clientWidth || 720;
    const height = wrap.clientHeight || 400;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const mutedColor = cssVar('--text-muted', '#4b5d54');
    const gridColor = cssVar('--chart-grid', 'rgba(24,41,35,0.12)');
    const bullColor = cssVar('--green', '#166534');
    const bearColor = cssVar('--red', '#b91c1c');
    const accentColor = cssVar('--accent', '#0d665f');
    const amberColor = cssVar('--amber', '#854d0e');
    const textColor = cssVar('--text', '#182923');
    const chartBg = cssVar('--chart-bg', '#f8faf8');

    const rows = state.candles.slice(-140);
    if (rows.length === 0) {
      ctx.fillStyle = mutedColor;
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
      if (Number.isFinite(ov.limitPrice)) levelLines.push({ label: 'LMT', price: ov.limitPrice, color: accentColor });
      if (Number.isFinite(ov.entry)) levelLines.push({ label: 'ENTRY', price: ov.entry, color: textColor });
      if (Number.isFinite(ov.stop)) levelLines.push({ label: ov.beArmed ? 'BE+' : 'SL', price: ov.stop, color: ov.beArmed ? amberColor : bearColor });
      if (Number.isFinite(ov.tp1Price)) levelLines.push({ label: 'TP1', price: ov.tp1Price, color: accentColor });
      if (Number.isFinite(ov.target)) levelLines.push({ label: 'TP', price: ov.target, color: bullColor });
    }
    for (const l of levelLines) {
      if (l.price < minP) minP = l.price;
      if (l.price > maxP) maxP = l.price;
    }

    const span = Math.max(1e-9, maxP - minP);
    minP -= span * 0.06;
    maxP += span * 0.06;
    const yOf = p => padT + ((maxP - p) / (maxP - minP)) * plotH;

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = mutedColor;
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
      const color = up ? bullColor : bearColor;
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
      ctx.fillStyle = chartBg;
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.fillText(`${l.label} ${l.price.toFixed(0)}`, padL + plotW + 5, y + 3);
      ctx.restore();
    }

    if (state.hoverIdx >= 0 && state.hoverIdx < rows.length) {
      const r = rows[state.hoverIdx];
      const cx = padL + state.hoverIdx * step + step * 0.5;
      ctx.strokeStyle = mutedColor;
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
        s.decision || '-',
        s.probWin !== null && s.probWin !== undefined ? `${(Number(s.probWin) * 100).toFixed(1)}%` : '-',
        fmtNum(s.sizeMult ?? 1, 2),
        fmtNum(s.limitPrice, 2),
        s.modelVersion || '-',
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
        t.exitReason || '-',
        `${fmtNum(t.lev, 2)}x`,
        t.probWin !== null && t.probWin !== undefined ? `${(Number(t.probWin) * 100).toFixed(1)}%` : '-',
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
    modeBadge.className = `status-dot-label ${
      modeStr === 'LIVE_EXCHANGE_ARMED'
        ? 'status-danger'
        : modeStr === 'OKX_DEMO_SIMULATED'
          ? 'status-warn'
          : 'status-safe'
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
      keys.textContent = `Keys: ${item.keysNeeded || '-'}`;
      const perms = document.createElement('span');
      perms.textContent = `Perms: ${item.permissions || '-'}`;
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
      td.textContent = 'No orders routed yet in orders_log.';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    for (const o of orders.slice(0, 40)) {
      const tr = document.createElement('tr');
      const cells = [
        o.clientOrderId || '-',
        o.exchange || '-',
        o.symbol || '-',
        o.mode || '-',
        `${o.orderType || '-'}${o.reduceOnly ? ' (RO)' : ''}`,
        String(o.side || '-').toUpperCase(),
        fmtNum(o.price, 2),
        fmtNum(o.qty, 4),
        o.status || '-',
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
      || '-';
    return { wrVal, moVal, retVal, ddVal, note };
  }

  function renderVersionsMatrixPanel() {
    const vData = state.versionsData || {};
    const rows = vData.versions || vData.comparisonRows || vData.matrix || [];
    const recs = vData.recommendationsByGoal || vData.recommendations || [];

    const badge = el('versions-status-badge');
    badge.textContent = vData.ready ? `${rows.length} VERSIONS READY` : 'PREVIEW FALLBACK';
    badge.className = `status-dot-label ${vData.ready ? 'status-safe' : 'status-warn'}`;
    el('versions-source-text').textContent = `Source: ${vData.source || 'local'}`;

    const tbody = el('versions-tbody');
    clearNode(tbody);
    for (const r of rows) {
      const tr = document.createElement('tr');
      const { wrVal, moVal, retVal, ddVal, note } = extractVersionDisplaySummary(r);
      const cells = [
        r.version || r.id || '-',
        r.era || r.label || r.architecture || '-',
        typeof wrVal === 'number' ? `${fmtNum(wrVal, 2)}%` : (wrVal || '-'),
        typeof moVal === 'number' ? `${fmtPct(moVal, 2)}/mo` : (moVal || '-'),
        typeof retVal === 'number' ? fmtPct(retVal, 2) : (retVal || '-'),
        typeof ddVal === 'number' ? `${fmtNum(ddVal, 2)}%` : (ddVal || '-'),
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
      title.textContent = `${rec.goal || rec.useCase || 'Goal'}: ${rec.recommendedVersion || rec.recommended || rec.version || '-'}`;
      const why = document.createElement('span');
      why.textContent = rec.rationale || rec.reason || rec.why || rec.notes || '';
      card.appendChild(title);
      card.appendChild(why);
      recsGrid.appendChild(card);
    }
  }

  function renderCommercialPlansBadge() {
    const pData = state.commercialPlans;
    const plansObj = pData?.plans || {};
    const count = Object.keys(plansObj).length || 3;
    const gCount = (pData?.guardrails || []).length || 7;
    el('comm-plans-badge').textContent = `${count} Plans · ${gCount} Guardrails`;
  }

  function renderCommercialSimResult() {
    const sim = state.commercialSim;
    const badge = el('comm-sim-bracket-badge');
    const tbody = el('comm-sim-tbody');
    clearNode(tbody);

    if (!sim) {
      badge.textContent = 'BRACKET: -';
      badge.className = 'status-dot-label';
      return;
    }

    const br = sim.bracket?.bracket || '-';
    badge.textContent = `BRACKET: ${br} (MaxPos ${sim.bracket?.maxConcurrentPositions ?? '-'})`;
    badge.className = `status-dot-label ${br === 'MICRO' ? 'status-warn' : 'status-safe'}`;

    for (const r of sim.rows || []) {
      const tr = document.createElement('tr');
      const cells = [
        r.symbol || '-',
        r.status || '-',
        r.regime || '-',
        r.side === 1 ? 'LONG' : 'SHORT',
        r.szOrQtyString || '-',
        `$${fmtNum(r.notionalUsdt, 2)}`,
        `$${fmtNum(r.estimatedRiskUsdt, 2)}`,
        `$${fmtNum(r.estimatedProfitUsdt, 2)}`,
        fmtNum(r.estimatedLiqPx, 2),
        r.feasible ? 'YES' : (r.skipReason || 'NO'),
      ];
      cells.forEach((txt, idx) => {
        const td = document.createElement('td');
        td.textContent = txt;
        if (idx === 3) td.className = r.side === 1 ? 'pos' : 'neg';
        if (idx === 9) td.className = r.feasible ? 'pos' : 'neg';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function renderCommercialDashboard() {
    const dash = state.subDashboard;
    const subBadge = el('comm-sub-badge');
    const cbBadge = el('comm-cb-badge');
    const ksBadge = el('comm-ks-badge');
    const ticketsTbody = el('comm-tickets-tbody');
    const ordersTbody = el('comm-orders-tbody');
    clearNode(ticketsTbody);
    clearNode(ordersTbody);

    if (!dash || !dash.subscriber) {
      subBadge.textContent = 'Not Connected';
      subBadge.className = 'status-dot-label';
      cbBadge.textContent = 'CB: OK';
      cbBadge.className = 'status-dot-label status-safe';
      ksBadge.textContent = 'KS: OK';
      ksBadge.className = 'status-dot-label status-safe';
      return;
    }

    const sub = dash.subscriber;
    const risk = dash.riskState || sub.riskState || {};
    subBadge.textContent = `${sub.planId} · ${sub.executionMode}${sub.keyMask ? ` (${sub.keyMask})` : ''}`;
    subBadge.className = 'status-dot-label status-safe';
    el('comm-mode-select').value = sub.executionMode || 'SCAN_AND_SIGNAL_ONLY';

    cbBadge.textContent = risk.circuitBreakerTripped
      ? `CB: TRIPPED (${fmtNum(risk.dailyLossPct ?? risk.daily_loss_pct, 2)}%)`
      : `CB: OK (${fmtNum(risk.dailyLossPct ?? risk.daily_loss_pct ?? 0, 2)}%)`;
    cbBadge.className = `status-dot-label ${risk.circuitBreakerTripped ? 'status-danger' : 'status-safe'}`;

    ksBadge.textContent = risk.killSwitchTripped
      ? `KS: TRIPPED (${fmtNum(risk.drawdownPct ?? risk.drawdown_pct, 2)}%)`
      : `KS: OK (DD ${fmtNum(risk.drawdownPct ?? risk.drawdown_pct ?? 0, 2)}%)`;
    ksBadge.className = `status-dot-label ${risk.killSwitchTripped ? 'status-danger' : 'status-safe'}`;

    for (const tk of dash.tickets || []) {
      const tr = document.createElement('tr');
      const cells = [
        tk.symbol || '-',
        tk.status || '-',
        tk.regime || '-',
        tk.side === 1 ? 'LONG' : 'SHORT',
        tk.sz_or_qty || '-',
        `$${fmtNum(tk.notional_usdt, 2)}`,
        `$${fmtNum(tk.est_risk_usdt, 2)} / $${fmtNum(tk.est_profit_usdt, 2)}`,
        tk.feasible ? 'YES' : (tk.skip_reason || 'NO'),
      ];
      cells.forEach((txt, idx) => {
        const td = document.createElement('td');
        td.textContent = txt;
        if (idx === 3) td.className = tk.side === 1 ? 'pos' : 'neg';
        if (idx === 7) td.className = tk.feasible ? 'pos' : 'neg';
        tr.appendChild(td);
      });
      ticketsTbody.appendChild(tr);
    }

    for (const o of dash.orders || []) {
      const tr = document.createElement('tr');
      const cells = [
        o.client_order_id || '-',
        o.exchange || '-',
        o.symbol || '-',
        o.mode || '-',
        `${o.order_type || '-'}${o.reduce_only ? ' (RO)' : ''}`,
        String(o.side || '-').toUpperCase(),
        String(o.qty ?? '-'),
        o.status || '-',
      ];
      cells.forEach((txt, idx) => {
        const td = document.createElement('td');
        td.textContent = txt;
        if (idx === 0) td.className = 'mono-code';
        if (idx === 7) td.className = o.status === 'REJECTED' || o.status === 'INTERRUPTED' ? 'neg' : 'pos';
        tr.appendChild(td);
      });
      ordersTbody.appendChild(tr);
    }
  }

  /* ================= v12.5 CONSUMER UX + EXPERT TELEMETRY ================= */

  function computeCountdownSeconds(ap) {
    if (!ap || !ap.armed) return 0;
    if (Number.isFinite(Number(ap.countdownSec))) {
      return Math.max(0, Number(ap.countdownSec));
    }
    const nextRaw = ap.nextTickAt || ap.session?.next_tick_at || null;
    if (nextRaw) {
      const targetMs = typeof nextRaw === 'number' ? nextRaw : new Date(nextRaw).getTime();
      const diff = Math.ceil((targetMs - Date.now()) / 1000);
      if (Number.isFinite(diff)) return Math.max(0, diff);
    }
    return Number(ap.intervalSec || ap.session?.interval_sec || ap.autopilotIntervalSec || 60);
  }

  function renderEquitySparkline(ap) {
    const host = el('e2e-equity-sparkline');
    if (!host) return;
    const sparkPoints = Array.isArray(ap?.portfolioSummary?.equitySparkline)
      ? ap.portfolioSummary.equitySparkline
        .map(item => Number(typeof item === 'object' && item !== null ? (item.eq ?? item.totalEquityUsdt ?? item.equityUsdt) : item))
        .filter(v => Number.isFinite(v))
      : [];
    const history = Array.isArray(ap?.scanHistory) ? ap.scanHistory : [];
    const historyPoints = history
      .map(item => Number(item.totalEquityUsdt ?? item.total_equity_usdt ?? item.equityUsdt))
      .filter(v => Number.isFinite(v));
    const points = sparkPoints.length > 0 ? sparkPoints : historyPoints;

    const currentEq = Number(
      ap?.portfolioSummary?.totalEquityUsdt
      ?? ap?.portfolioSummary?.equityUsdt
      ?? ap?.latestScan?.total_equity_usdt
      ?? ap?.latestScan?.totalEquityUsdt
    );
    if (points.length === 0 && Number.isFinite(currentEq)) {
      points.push(currentEq, currentEq);
    } else if (points.length === 1) {
      points.unshift(points[0]);
    }

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 240 52');
    svg.setAttribute('class', 'sparkline-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Đồ thị biến động tài sản');

    if (points.length < 2) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', '4');
      line.setAttribute('y1', '26');
      line.setAttribute('x2', '236');
      line.setAttribute('y2', '26');
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-opacity', '0.25');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('stroke-dasharray', '4 4');
      svg.appendChild(line);
      host.replaceChildren(svg);
      return;
    }

    const minV = Math.min(...points);
    const maxV = Math.max(...points);
    const span = Math.max(1e-6, maxV - minV);
    const w = 240;
    const h = 52;
    const padX = 6;
    const padY = 8;
    const coords = points.map((val, idx) => {
      const x = padX + (idx / (points.length - 1)) * (w - padX * 2);
      const y = minV === maxV
        ? h / 2
        : padY + (1 - (val - minV) / span) * (h - padY * 2);
      return [Number(x.toFixed(1)), Number(y.toFixed(1))];
    });

    const d = coords.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    const isUp = points[points.length - 1] >= points[0];
    path.setAttribute('stroke', isUp ? cssVar('--green', '#166534') : cssVar('--red', '#b91c1c'));
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);

    const last = coords[coords.length - 1];
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(last[0]));
    dot.setAttribute('cy', String(last[1]));
    dot.setAttribute('r', '3.2');
    dot.setAttribute('fill', isUp ? cssVar('--green', '#166534') : cssVar('--red', '#b91c1c'));
    svg.appendChild(dot);

    host.replaceChildren(svg);
  }

  function renderSimpleActivity(ap) {
    const list = el('e2e-simple-activity-list');
    const badge = el('e2e-simple-activity-badge');
    if (!list || !badge) return;
    clearNode(list);

    const positions = Array.isArray(ap?.activePositions) ? ap.activePositions : [];
    const orders = Array.isArray(ap?.orders) ? ap.orders : [];
    const items = [];

    // Group protective reduceOnly orders by symbol so entries mention protection cleanly
    const protectedSymbols = new Set();
    for (const o of orders) {
      const ro = Boolean(o.reduce_only ?? o.reduceOnly);
      const oType = String(o.order_type || o.orderType || '').toLowerCase();
      if (ro || oType.includes('oco') || oType.includes('sl_tp')) {
        if (o.status !== 'CANCELLED' && o.status !== 'REJECTED') {
          protectedSymbols.add(formatCoinName(o.symbol));
        }
      }
    }

    for (const p of positions) {
      const coin = formatCoinName(p.symbol);
      const sideRaw = String(p.side || '').toUpperCase();
      const sideLabel = (sideRaw.includes('LONG') || sideRaw === 'BUY' || p.side === 1) ? 'Mua' : 'Bán';
      const qtyStr = String(p.qty ?? p.sz ?? '-');
      const pnl = Number(p.unrealizedPnlUsdt ?? p.upl ?? 0);
      const pnlText = `${pnl >= 0 ? '+' : ''}$${fmtNum(pnl, 2)}`;
      items.push({
        text: `${sideLabel} ${coin} · Khối lượng ${qtyStr} · Lãi/lỗ tạm tính ${pnlText}`,
        statusText: 'Đang giữ lệnh',
        statusCls: 'status-safe',
      });
    }

    for (const o of orders.slice(0, 12)) {
      const ro = Boolean(o.reduce_only ?? o.reduceOnly);
      const oType = String(o.order_type || o.orderType || '').toLowerCase();
      if (ro || oType.includes('oco') || oType.includes('sl_tp') || oType === 'cancel') {
        continue;
      }
      const coin = formatCoinName(o.symbol);
      const sideRaw = String(o.side || '').toUpperCase();
      const sideLabel = (sideRaw === 'BUY' || sideRaw === 'LONG' || o.side === 1) ? 'Mua' : 'Bán';
      const qtyStr = String(o.qty ?? '-');
      const hasProtect = protectedSymbols.has(coin);
      const rawStatus = String(o.status || '').toUpperCase();

      let statusText = 'Đang chờ khớp';
      let statusCls = 'status-safe';
      if (rawStatus === 'FILLED') {
        statusText = 'Đang giữ lệnh';
      } else if (rawStatus === 'CANCELLED') {
        statusText = 'Đã hủy';
        statusCls = '';
      } else if (rawStatus === 'REJECTED' || rawStatus === 'INTERRUPTED') {
        statusText = 'Không khớp';
        statusCls = 'status-danger';
      }

      const protectSuffix = hasProtect ? ' · Đã đặt sẵn chốt lời & cắt lỗ' : '';
      items.push({
        text: `${sideLabel} ${coin} · Khối lượng ${qtyStr}${protectSuffix}`,
        statusText,
        statusCls,
      });
    }

    if (items.length === 0) {
      badge.textContent = 'Đang theo dõi';
      badge.className = 'status-dot-label status-safe';
      const empty = document.createElement('p');
      empty.className = 'simple-activity-empty';
      empty.textContent = 'Hệ thống đang theo dõi thị trường (BTC, ETH, SOL, BNB) và chỉ vào lệnh khi có tín hiệu thật sự an toàn.';
      list.appendChild(empty);
      return;
    }

    badge.textContent = `${items.length} hoạt động`;
    badge.className = 'status-dot-label';
    for (const it of items.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'simple-activity-row';
      const textEl = document.createElement('span');
      textEl.className = 'simple-activity-text';
      textEl.textContent = it.text;
      const stEl = document.createElement('span');
      stEl.className = `status-dot-label ${it.statusCls}`;
      stEl.textContent = it.statusText;
      row.appendChild(textEl);
      row.appendChild(stEl);
      list.appendChild(row);
    }
  }

  function renderPreflightResult() {
    const box = el('e2e-preflight-result');
    const tbody = el('e2e-preflight-tbody');
    clearNode(tbody);
    const data = state.preflightData;
    if (!data) {
      box.classList.add('is-hidden');
      return;
    }
    box.classList.remove('is-hidden');
    el('e2e-pf-equity').textContent = `$${fmtNum(data.availMarginUsdt, 2)} / $${fmtNum(data.totalEquityUsdt, 2)}`;
    el('e2e-pf-bracket').textContent = `${data.bracket?.bracket || '-'} (Tối đa ${data.bracket?.maxConcurrentPositions ?? '-'} lệnh)`;
    const wdEl = el('e2e-pf-withdraw');
    wdEl.textContent = data.withdrawBlocked !== false ? 'ĐÃ KHÓA AN TOÀN' : 'CẢNH BÁO RÚT TIỀN';
    wdEl.className = `metric-value ${data.withdrawBlocked !== false ? 'pos' : 'neg'}`;
    el('e2e-pf-keymask').textContent = data.keyMask || 'Mô phỏng';

    const rows = data.previewRows || data.rows || [];
    for (const r of rows) {
      const tr = document.createElement('tr');
      const cells = [
        r.symbol || '-',
        r.status || '-',
        r.regime || '-',
        r.side === 1 ? 'LONG' : 'SHORT',
        r.szOrQtyString || '-',
        `$${fmtNum(r.notionalUsdt, 2)}`,
        `$${fmtNum(r.estimatedRiskUsdt, 2)} / $${fmtNum(r.estimatedProfitUsdt, 2)}`,
        r.feasible ? 'ĐẠT' : (r.skipReason || 'KHÔNG'),
      ];
      cells.forEach((txt, idx) => {
        const td = document.createElement('td');
        td.textContent = txt;
        if (idx === 3) td.className = r.side === 1 ? 'pos' : 'neg';
        if (idx === 7) td.className = r.feasible ? 'pos' : 'neg';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function renderGuardrailsChecklist(ap) {
    const details = el('e2e-guardrails-details');
    const techDetails = el('e2e-tech-details');
    const summaryText = el('e2e-guardrails-summary');
    const list = el('e2e-guardrails-list');
    const badge = el('e2e-guardrails-summary-badge');
    clearNode(list);

    const rawItems = Array.isArray(ap?.guardrailChecklist) ? ap.guardrailChecklist : [];
    if (rawItems.length === 0) {
      summaryText.textContent = '7 chốt chặn an toàn sẽ hiển thị sau khi kết nối';
      badge.textContent = 'Chờ kích hoạt';
      badge.className = 'status-dot-label';
      details.open = false;
      if (techDetails) techDetails.open = Boolean(state.proMode);
      return;
    }

    const items = [...rawItems].sort((a, b) => Number(Boolean(a.ok)) - Number(Boolean(b.ok)));
    const failedCount = items.filter(g => !g.ok).length;
    const passCount = items.length - failedCount;

    badge.textContent = `${passCount}/${items.length} Đạt chuẩn`;
    badge.className = `status-dot-label ${failedCount === 0 ? 'status-safe' : 'status-danger'}`;
    summaryText.textContent = failedCount === 0
      ? `${passCount}/${items.length} Chốt chặn an toàn đang hoạt động bình thường`
      : `Cảnh báo: ${failedCount} chốt chặn cần chú ý`;
    details.open = failedCount > 0;
    if (techDetails) {
      techDetails.open = Boolean(state.proMode || failedCount > 0);
    }

    for (const g of items) {
      const row = document.createElement('div');
      row.className = 'guardrail-row';

      const main = document.createElement('div');
      main.className = 'guardrail-main';
      const code = document.createElement('span');
      code.className = 'guardrail-code';
      code.textContent = g.id || 'G';
      const label = document.createElement('span');
      label.className = 'guardrail-name';
      label.textContent = g.label || '-';
      const detail = document.createElement('span');
      detail.className = 'guardrail-detail';
      detail.textContent = g.detail || '-';
      main.appendChild(code);
      main.appendChild(label);
      main.appendChild(detail);

      const st = document.createElement('span');
      st.className = `status-dot-label ${g.ok ? 'status-safe' : 'status-danger'}`;
      st.textContent = g.ok ? 'Đạt' : 'Cần xử lý';

      row.appendChild(main);
      row.appendChild(st);
      list.appendChild(row);
    }
  }

  function renderAutopilotEvents(events) {
    const container = el('e2e-events-list');
    const badge = el('e2e-events-badge');
    clearNode(container);

    const list = Array.isArray(events) ? events : [];
    badge.textContent = `${list.length} sự kiện`;

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'event-row';
      empty.textContent = 'Chưa có sự kiện nào được ghi nhận.';
      container.appendChild(empty);
      return;
    }

    for (const ev of list.slice(0, 30)) {
      const row = document.createElement('div');
      row.className = 'event-row';

      const left = document.createElement('div');
      left.className = 'event-left';

      const evType = ev.eventType || ev.event_type || 'EVENT';
      const pill = document.createElement('span');
      const isDanger = evType.includes('TRIP') || evType.includes('ERROR') || evType.includes('BLOCK') || evType.includes('REARM');
      const isSafe = evType.includes('ARM') || evType.includes('SUBMIT') || evType.includes('TICK') || evType.includes('START');
      pill.className = `status-dot-label ${isDanger ? 'status-danger' : isSafe ? 'status-safe' : ''}`;
      pill.textContent = evType;

      const msg = document.createElement('span');
      msg.textContent = ev.message || ev.detail || ev.reason || '-';

      left.appendChild(pill);
      left.appendChild(msg);

      const timeEl = document.createElement('span');
      timeEl.className = 'event-time';
      timeEl.textContent = fmtIsoShort(ev.createdAt ?? ev.created_at);

      row.appendChild(left);
      row.appendChild(timeEl);
      container.appendChild(row);
    }
  }

  function renderActivePositions(ap) {
    const sec = el('e2e-positions-section');
    const tbody = el('e2e-positions-tbody');
    const badge = el('e2e-positions-badge');
    const positions = Array.isArray(ap?.activePositions) ? ap.activePositions : [];
    clearNode(tbody);

    if (positions.length === 0) {
      sec.classList.add('is-hidden');
      return;
    }

    sec.classList.remove('is-hidden');
    badge.textContent = `${positions.length} vị thế`;
    for (const p of positions) {
      const tr = document.createElement('tr');
      const pnl = Number(p.unrealizedPnlUsdt ?? p.upl ?? 0);
      const cells = [
        p.symbol || '-',
        String(p.side || '-').toUpperCase(),
        String(p.qty ?? p.sz ?? '-'),
        fmtNum(p.entryPrice ?? p.avgPx, 2),
        fmtNum(p.markPrice ?? p.lastPx, 2),
        `${fmtNum(p.leverage ?? p.lever, 1)}x`,
        `$${fmtNum(pnl, 2)}`,
      ];
      cells.forEach((txt, idx) => {
        const td = document.createElement('td');
        td.textContent = txt;
        if (idx === 1) td.className = String(p.side).toLowerCase().includes('long') || p.side === 1 ? 'pos' : 'neg';
        if (idx === 6) td.className = pnl >= 0 ? 'pos' : 'neg';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function renderAutopilotTicketsAndOrders(ap) {
    const tickets = ap?.tickets || [];
    const orders = ap?.orders || [];

    el('e2e-tickets-badge').textContent = `${tickets.length} phiếu`;
    const tkBody = el('e2e-tickets-tbody');
    clearNode(tkBody);
    if (tickets.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.textContent = 'Chưa có phiếu tín hiệu mới. Nhấn Quét thị trường ngay để kiểm tra.';
      tr.appendChild(td);
      tkBody.appendChild(tr);
    } else {
      for (const tk of tickets.slice(0, 20)) {
        const tr = document.createElement('tr');
        const cells = [
          tk.symbol || '-',
          tk.status || '-',
          tk.regime || '-',
          tk.side === 1 ? 'LONG' : 'SHORT',
          tk.sz_or_qty || tk.szOrQtyString || '-',
          `$${fmtNum(tk.notional_usdt ?? tk.notionalUsdt, 2)}`,
          `$${fmtNum(tk.est_risk_usdt ?? tk.estimatedRiskUsdt, 2)} / $${fmtNum(tk.est_profit_usdt ?? tk.estimatedProfitUsdt, 2)}`,
          tk.feasible ? 'ĐẠT' : (tk.skip_reason || tk.skipReason || 'KHÔNG'),
        ];
        cells.forEach((txt, idx) => {
          const td = document.createElement('td');
          td.textContent = txt;
          if (idx === 3) td.className = tk.side === 1 ? 'pos' : 'neg';
          if (idx === 7) td.className = tk.feasible ? 'pos' : 'neg';
          tr.appendChild(td);
        });
        tkBody.appendChild(tr);
      }
    }

    el('e2e-orders-badge').textContent = `${orders.length} lệnh`;
    const ordBody = el('e2e-orders-tbody');
    clearNode(ordBody);
    if (orders.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.textContent = 'Chưa có lệnh tự động nào trong phiên này.';
      tr.appendChild(td);
      ordBody.appendChild(tr);
    } else {
      for (const o of orders.slice(0, 30)) {
        const tr = document.createElement('tr');
        const ro = Boolean(o.reduce_only ?? o.reduceOnly);
        const cells = [
          o.client_order_id || o.clientOrderId || '-',
          o.exchange || '-',
          o.symbol || '-',
          o.mode || '-',
          `${o.order_type || o.orderType || '-'}${ro ? ' (RO)' : ''}`,
          String(o.side || '-').toUpperCase(),
          String(o.qty ?? '-'),
          o.status || '-',
        ];
        cells.forEach((txt, idx) => {
          const td = document.createElement('td');
          td.textContent = txt;
          if (idx === 0) td.className = 'mono-code';
          if (idx === 7) {
            const st = o.status || '';
            td.className = st === 'REJECTED' || st === 'INTERRUPTED' || st === 'CANCELLED' ? 'neg' : 'pos';
          }
          tr.appendChild(td);
        });
        ordBody.appendChild(tr);
      }
    }
  }

  function syncUnlockPinVisibility(savedProfiles) {
    const profileSelect = el('e2e-saved-profile-select');
    const pinRow = el('e2e-unlock-pin-row');
    if (!profileSelect || !pinRow) return;
    const selectedId = profileSelect.value;
    const selectedProfile = (savedProfiles || []).find(p => p.subscriberId === selectedId);
    const hidePin = Boolean(selectedProfile?.isPaperSandbox && !selectedProfile?.hasArmingPin);
    pinRow.classList.toggle('is-hidden', hidePin);
  }

  function formatSavedProfileOption(p) {
    if (p.isPaperSandbox) {
      return `Paper Sandbox ($1,000) · ${p.exchange} (Tiền ảo)`;
    }
    const label = p.name || 'Tài khoản của tôi';
    const envLabel = p.simulated ? 'Thử nghiệm' : 'Tiền thật';
    return `${label} · ${p.exchange} (${envLabel})`;
  }

  function renderAutopilotView() {
    const ap = state.autopilotStatus || {};
    const sess = ap.session || null;
    const apState = sess?.state || ap.state || 'DISARMED';
    const savedProfiles = Array.isArray(ap.savedProfiles) ? ap.savedProfiles : [];
    const sub = ap.subscriber || null;
    const isArmed = Boolean(ap.armed || apState === 'ARMED_RUNNING');
    const needsRearm = apState === 'REARM_REQUIRED' || savedProfiles.some(p => (p.autopilotState || p.state) === 'REARM_REQUIRED');
    const hasSession = Boolean(state.autopilotSessionToken && sub);
    const cycleCount = Number(sess?.cycle_count ?? ap.tickCount ?? ap.cycleCount ?? 0);
    const intervalSec = Number(sess?.interval_sec ?? ap.intervalSec ?? ap.autopilotIntervalSec ?? 60);
    const lastTickAt = sess?.last_tick_at ?? ap.lastTickAt ?? null;

    if (ap.localQuickstartEnabled === false) {
      const qCheck = el('e2e-local-quickstart');
      if (qCheck && qCheck.checked) {
        qCheck.checked = false;
        qCheck.disabled = true;
        syncLicenseFields();
      }
    }

    // Topbar short human copy: Chưa bật / Đang chạy / Tạm dừng / Cần mở khóa
    const pill = el('topbar-autopilot-pill');
    const topStop = el('topbar-emergency-stop-btn');
    if (isArmed) {
      pill.textContent = 'Đang chạy';
      pill.className = 'status-dot-label status-safe';
      topStop.classList.remove('is-hidden');
    } else if (needsRearm || (savedProfiles.length > 0 && !hasSession)) {
      pill.textContent = 'Cần mở khóa';
      pill.className = 'status-dot-label status-warn';
      topStop.classList.add('is-hidden');
    } else if (hasSession) {
      pill.textContent = 'Tạm dừng';
      pill.className = `status-dot-label ${apState === 'TRIPPED' ? 'status-danger' : ''}`;
      topStop.classList.add('is-hidden');
    } else {
      pill.textContent = 'Chưa bật';
      pill.className = 'status-dot-label';
      topStop.classList.add('is-hidden');
    }

    // Status Banner: hidden in Consumer Mode unless TRIPPED; always visible in proMode or when TRIPPED
    const statusBanner = el('e2e-status-banner');
    const stBadge = el('e2e-status-badge');
    const headline = el('e2e-status-headline');
    const detail = el('e2e-status-detail');
    const stopBtn = el('e2e-emergency-stop-btn');
    const lockBtn = el('e2e-lock-session-btn');
    const reconfigBtn = el('e2e-toggle-wizard-btn');
    const countdown = isArmed ? state.countdownSec : 0;

    statusBanner.classList.toggle('is-hidden', !state.proMode && apState !== 'TRIPPED');

    if (isArmed) {
      stBadge.className = 'status-dot-label status-safe';
      stBadge.textContent = 'Đang chạy';
      headline.textContent = `${sub?.name || 'Tài khoản'} · ${sub?.exchange || 'OKX'} ${sub?.simulated ? 'Thử nghiệm' : 'Tiền thật'}${sub?.keyMask ? ` (${sub.keyMask})` : ''}`;
      detail.textContent = `Chu kỳ: ${cycleCount} · Quét tiếp sau: ${countdown}s (${intervalSec}s) · ${sub?.riskTier || 'SAFE_75WR'}/${sub?.preferredVersion || 'v9'}`;
      stopBtn.classList.remove('is-hidden');
      lockBtn.classList.toggle('is-hidden', !hasSession);
      reconfigBtn.classList.add('is-hidden');
    } else if (needsRearm || (savedProfiles.length > 0 && !hasSession)) {
      stBadge.className = 'status-dot-label status-warn';
      stBadge.textContent = 'Cần mở khóa';
      headline.textContent = needsRearm
        ? 'Máy chủ vừa khởi động lại. Cần mở khóa để tiếp tục.'
        : 'Đã tìm thấy hồ sơ cục bộ. Mở khóa để tiếp tục.';
      detail.textContent = `${savedProfiles.length} hồ sơ đã lưu`;
      stopBtn.classList.add('is-hidden');
      lockBtn.classList.add('is-hidden');
      reconfigBtn.classList.add('is-hidden');
    } else if (hasSession) {
      stBadge.className = `status-dot-label ${apState === 'TRIPPED' ? 'status-danger' : ''}`;
      stBadge.textContent = apState === 'TRIPPED' ? 'Đã tự ngắt bảo vệ' : 'Tạm dừng';
      headline.textContent = `${sub.name} · ${sub.exchange}`;
      detail.textContent = apState === 'TRIPPED'
        ? 'Hệ thống đã tự ngắt để bảo vệ vốn theo giới hạn bạn cài đặt.'
        : `Chu kỳ đã chạy: ${cycleCount}`;
      stopBtn.classList.add('is-hidden');
      lockBtn.classList.remove('is-hidden');
      reconfigBtn.classList.add('is-hidden');
    } else {
      stBadge.className = 'status-dot-label';
      stBadge.textContent = 'Chưa bật';
      headline.textContent = 'Bắt đầu giao dịch tự động';
      detail.textContent = 'Chu kỳ: 0 · Không bao giờ có quyền rút tiền';
      stopBtn.classList.add('is-hidden');
      lockBtn.classList.add('is-hidden');
      reconfigBtn.classList.add('is-hidden');
    }

    // Screen Visibility State Machine
    const unlockCard = el('e2e-saved-profiles-card');
    const profileSelect = el('e2e-saved-profile-select');
    const onboardingHero = el('e2e-onboarding-hero');
    const wizardPanel = el('e2e-wizard-panel');
    const cockpitPanel = el('e2e-cockpit-panel');

    if (hasSession) {
      unlockCard.classList.add('is-hidden');
      onboardingHero.classList.add('is-hidden');
      wizardPanel.classList.add('is-hidden');
      cockpitPanel.classList.remove('is-hidden');
    } else {
      cockpitPanel.classList.add('is-hidden');
      if (savedProfiles.length > 0) {
        unlockCard.classList.remove('is-hidden');
        const prevVal = profileSelect.value;
        clearNode(profileSelect);
        for (const p of savedProfiles) {
          const opt = document.createElement('option');
          opt.value = p.subscriberId;
          opt.textContent = formatSavedProfileOption(p);
          profileSelect.appendChild(opt);
        }
        if (prevVal && savedProfiles.some(p => p.subscriberId === prevVal)) {
          profileSelect.value = prevVal;
        }
        el('e2e-saved-count-badge').textContent = `${savedProfiles.length} hồ sơ`;
        syncUnlockPinVisibility(savedProfiles);
      } else {
        unlockCard.classList.add('is-hidden');
      }

      if (state.connectFormOpen) {
        onboardingHero.classList.add('is-hidden');
        wizardPanel.classList.remove('is-hidden');
      } else {
        onboardingHero.classList.remove('is-hidden');
        wizardPanel.classList.add('is-hidden');
      }
    }

    if (!hasSession) return;

    // Populate Screen 3: Calm Personal Wealth Cockpit
    const pSum = ap.portfolioSummary || {};
    const scan = ap.latestScan || state.subDashboard?.latestScan || null;
    const bracket = ap.bracket || state.subDashboard?.bracket || null;
    const risk = ap.riskState || sub?.riskState || {};

    const liveBadge = el('e2e-cockpit-live-badge');
    if (isArmed) {
      liveBadge.textContent = 'Đang tự động giao dịch';
      liveBadge.className = 'status-dot-label status-safe';
    } else if (apState === 'TRIPPED') {
      liveBadge.textContent = 'Đã tự ngắt bảo vệ';
      liveBadge.className = 'status-dot-label status-danger';
    } else {
      liveBadge.textContent = 'Đang tạm dừng';
      liveBadge.className = 'status-dot-label';
    }

    const acctLabel = el('e2e-cockpit-account-label');
    if (sub?.isPaperSandbox) {
      acctLabel.textContent = `Tài khoản dùng thử · ${sub.exchange || 'OKX'}`;
    } else {
      acctLabel.textContent = `${sub?.name || 'Tài khoản của tôi'} · ${sub?.exchange || 'OKX'}`;
    }

    const eqVal = pSum.totalEquityUsdt ?? pSum.equityUsdt ?? scan?.total_equity_usdt ?? scan?.totalEquityUsdt ?? 0;
    const availVal = pSum.availMarginUsdt ?? scan?.avail_margin_usdt ?? scan?.availMarginUsdt ?? eqVal;
    const pnlPctVal = pSum.dailyPnlPct ?? pSum.returnPct ?? pSum.pnlPct ?? 0;
    const pnlUsdVal = pSum.dailyPnlUsdt ?? 0;

    el('e2e-kpi-equity').textContent = `$${fmtNum(eqVal, 2)}`;
    const pnlEl = el('e2e-hero-pnl');
    const usdStr = `${Number(pnlUsdVal) >= 0 ? '+' : ''}$${fmtNum(pnlUsdVal, 2)}`;
    pnlEl.textContent = `Hôm nay: ${usdStr} (${fmtPct(pnlPctVal, 2)}) · Khả dụng $${fmtNum(availVal, 2)}`;
    pnlEl.className = `hero-pnl ${Number(pnlPctVal) >= 0 ? 'pos' : 'neg'}`;

    el('e2e-hero-mode').textContent = formatPlainMode(sub?.executionMode, sub);

    const cbTripped = Boolean(risk.circuitBreakerTripped ?? risk.circuit_breaker_tripped);
    const ksTripped = Boolean(risk.killSwitchTripped ?? risk.kill_switch_tripped);
    const safetyEl = el('e2e-kpi-safety');
    if (ksTripped || cbTripped) {
      safetyEl.textContent = 'Đã ngắt bảo vệ';
      safetyEl.className = 'metric-value neg';
    } else {
      safetyEl.textContent = 'Đang bật an toàn';
      safetyEl.className = 'metric-value pos';
    }
    const capLoss = sub?.maxDailyLossPct ?? 5;
    el('e2e-kpi-safety-sub').textContent = `Tự nghỉ hôm nay nếu lỗ tới ${capLoss}%`;

    el('e2e-pause-btn').classList.toggle('is-hidden', !isArmed);
    el('e2e-resume-btn').classList.toggle('is-hidden', isArmed);

    // Populate Technical Accordion internals
    el('e2e-kpi-bracket').textContent = `Phân tầng: ${bracket?.bracket || scan?.capital_bracket || 'STANDARD'} · Tối đa ${bracket?.maxConcurrentPositions ?? 3} vị thế`;
    el('e2e-kpi-heartbeat').textContent = isArmed ? `${countdown}s` : 'Tạm dừng';
    el('e2e-kpi-cycles').textContent = `Chu kỳ: ${cycleCount} · Lần cuối: ${fmtIsoShort(lastTickAt)}`;
    el('e2e-scan-now-btn').disabled = !hasSession;

    const rad = state.radar || state.status?.v8Radar || null;
    if (rad && rad.ready) {
      el('e2e-kpi-regime').textContent = rad.regime || 'UNKNOWN';
      el('e2e-kpi-regime-sub').textContent = `LONG ${fmtNum(rad.longSizeMult, 2)}x · SHORT ${fmtNum(rad.shortSizeMult, 2)}x`;
    } else {
      el('e2e-kpi-regime').textContent = 'Đang đồng bộ';
      el('e2e-kpi-regime-sub').textContent = 'Radar v8 + ML v9';
    }

    renderEquitySparkline(ap);
    renderSimpleActivity(ap);
    renderGuardrailsChecklist(ap);
    renderActivePositions(ap);
    renderAutopilotTicketsAndOrders(ap);
    renderAutopilotEvents(ap.events || []);
  }

  function renderFlowView() {
    const ap = state.autopilotStatus || {};
    const sess = ap.session || null;
    const apState = sess?.state || ap.state || (ap.armed ? 'ARMED_RUNNING' : 'IDLE');
    const cycleCount = Number(sess?.cycle_count ?? ap.tickCount ?? 0);
    const isArmed = Boolean(ap.armed || apState === 'ARMED_RUNNING');
    const hasSub = Boolean(ap.subscriber || state.autopilotSessionToken);
    const liveBadge = el('e2e-flow-live-badge');
    liveBadge.textContent = isArmed
      ? `Đang chạy (${cycleCount} chu kỳ)`
      : hasSub
        ? 'Tạm dừng'
        : 'Chưa bật';
    liveBadge.className = `status-dot-label ${isArmed ? 'status-safe' : hasSub ? 'status-warn' : ''}`;

    const stageStatusMap = {
      'stage-1': hasSub ? { text: 'Đã mã hóa', cls: 'status-safe' } : { text: 'Sẵn sàng', cls: '' },
      'stage-2': state.candles.length > 0 ? { text: `${state.candles.length} nến`, cls: 'status-safe' } : { text: 'Đang đồng bộ', cls: 'status-warn' },
      'stage-3': state.radar?.ready ? { text: state.radar.regime, cls: 'status-safe' } : { text: 'Chờ dữ liệu', cls: '' },
      'stage-4': ap.bracket ? { text: ap.bracket.bracket, cls: 'status-safe' } : { text: 'Chờ quét vốn', cls: '' },
      'stage-5': isArmed ? { text: '7/7 Đang giám sát', cls: 'status-safe' } : { text: 'Sẵn sàng khóa', cls: '' },
      'stage-6': isArmed ? { text: 'Đang chạy 24/7', cls: 'status-safe' } : { text: 'Chờ kích hoạt', cls: '' },
    };

    const grid = el('e2e-flow-stages');
    clearNode(grid);
    for (const st of FLOW_STAGES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `flow-stage-btn ${state.selectedFlowStageId === st.id ? 'is-selected' : ''}`;
      btn.addEventListener('click', () => {
        state.selectedFlowStageId = st.id;
        renderFlowView();
      });

      const top = document.createElement('div');
      top.className = 'flow-stage-top';
      const num = document.createElement('span');
      num.className = 'flow-stage-num';
      num.textContent = `GĐ ${st.num}`;
      const badge = document.createElement('span');
      const stInfo = stageStatusMap[st.id] || { text: 'Sẵn sàng', cls: '' };
      badge.className = `status-dot-label ${stInfo.cls}`;
      badge.textContent = stInfo.text;
      top.appendChild(num);
      top.appendChild(badge);

      const title = document.createElement('strong');
      title.className = 'flow-stage-title';
      title.textContent = st.title;

      const sub = document.createElement('span');
      sub.className = 'flow-stage-sub';
      sub.textContent = st.short;

      btn.appendChild(top);
      btn.appendChild(title);
      btn.appendChild(sub);
      grid.appendChild(btn);
    }

    const activeStage = FLOW_STAGES.find(s => s.id === state.selectedFlowStageId) || FLOW_STAGES[0];
    const activeInfo = stageStatusMap[activeStage.id] || { text: 'Sẵn sàng', cls: '' };
    el('e2e-flow-inspector-title').textContent = `${activeStage.num}. ${activeStage.title}`;
    const insBadge = el('e2e-flow-inspector-status');
    insBadge.textContent = activeInfo.text;
    insBadge.className = `status-dot-label ${activeInfo.cls}`;
    el('e2e-flow-inspector-desc').textContent = activeStage.desc;

    const dl = el('e2e-flow-inspector-meta');
    clearNode(dl);
    const metaPairs = [
      ['Sàn đang chọn', ap.subscriber?.exchange || el('e2e-ex-select')?.value || 'OKX'],
      ['Regime hiện tại', state.radar?.regime || 'Đang tải'],
      ['Trạng thái Autopilot', apState],
      ['Số chu kỳ đã chạy', String(cycleCount)],
    ];
    for (const [k, v] of metaPairs) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }

    const evoTbody = el('e2e-evolution-tbody');
    clearNode(evoTbody);
    for (const row of EVOLUTION_ROWS) {
      const tr = document.createElement('tr');
      row.forEach((txt, idx) => {
        const td = document.createElement('td');
        td.textContent = txt;
        if (idx === 0) td.className = 'mono-code';
        tr.appendChild(td);
      });
      evoTbody.appendChild(tr);
    }
  }

  function openSettingsDialog() {
    const dlg = el('e2e-settings-dialog');
    const ap = state.autopilotStatus || {};
    const sub = ap.subscriber || {};
    const sess = ap.session || {};
    el('e2e-set-name').value = sub.name || 'Tài khoản của tôi';
    el('e2e-set-email').value = sub.email || '';
    el('e2e-set-exchange').value = sub.exchange || 'OKX';
    el('e2e-set-simulated').value = sub.simulated === false ? '0' : '1';
    const stratVal = `${sub.riskTier || 'SAFE_75WR'}|${sub.preferredVersion || 'v9'}`;
    const stratSel = el('e2e-set-strategy');
    if ([...stratSel.options].some(o => o.value === stratVal)) {
      stratSel.value = stratVal;
    }
    el('e2e-set-daily-loss').value = String(sub.maxDailyLossPct ?? 5);
    el('e2e-set-max-dd').value = String(sub.maxDdKillPct ?? 20);
    el('e2e-set-interval').value = String(sess.interval_sec ?? ap.autopilotIntervalSec ?? 60);
    el('e2e-set-apikey').value = '';
    el('e2e-set-apisecret').value = '';
    el('e2e-set-passphrase').value = '';
    el('e2e-set-pin').value = '';
    el('e2e-settings-status').textContent = '';
    el('e2e-settings-keys-details').open = false;
    el('e2e-settings-adv-details').open = false;
    state.deleteConfirmArmed = false;
    el('e2e-delete-confirm-btn').classList.add('is-hidden');
    el('e2e-delete-profile-btn').textContent = 'Xóa hồ sơ này';
    syncSettingsPassphraseField();
    if (typeof dlg.showModal === 'function') {
      dlg.showModal();
    }
  }

  function syncSettingsPassphraseField() {
    const ex = el('e2e-set-exchange').value;
    el('e2e-set-passphrase-wrap').classList.toggle('is-hidden', ex === 'BINANCE');
  }

  async function refreshAutopilotStatus() {
    const headers = state.autopilotSessionToken
      ? { 'x-subscriber-token': state.autopilotSessionToken }
      : {};
    const q = state.autopilotSubscriberId
      ? `?subscriberId=${encodeURIComponent(state.autopilotSubscriberId)}`
      : '';
    try {
      const data = await apiGet(`/api/autopilot/status${q}`, headers);
      state.autopilotStatus = data;
      state.countdownSec = computeCountdownSeconds(data);
      renderAutopilotView();
      if (state.activeTab === 'flow') {
        renderFlowView();
      }
    } catch (err) {
      if (err.status === 401 && state.autopilotSessionToken) {
        setAutopilotSession('', state.autopilotSubscriberId);
        const fallback = await apiGet('/api/autopilot/status');
        state.autopilotStatus = fallback;
        state.countdownSec = 0;
        renderAutopilotView();
      }
    }
  }

  function syncPollingTimers() {
    if (!state.pollTimerId) {
      state.pollTimerId = window.setInterval(() => {
        const isArmed = Boolean(state.autopilotStatus?.armed || state.autopilotStatus?.session?.state === 'ARMED_RUNNING');
        if (isArmed) {
          refreshAutopilotStatus().catch(() => {});
        }
      }, 5000);
    }
    if (!state.countdownTimerId) {
      state.countdownTimerId = window.setInterval(() => {
        const isArmed = Boolean(state.autopilotStatus?.armed || state.autopilotStatus?.session?.state === 'ARMED_RUNNING');
        if (isArmed && state.countdownSec > 0) {
          state.countdownSec -= 1;
          const hb = el('e2e-kpi-heartbeat');
          if (hb) hb.textContent = `${state.countdownSec}s`;
          const detail = el('e2e-status-detail');
          const ap = state.autopilotStatus || {};
          const sess = ap.session || {};
          const sub = ap.subscriber;
          const cycleCount = Number(sess.cycle_count ?? ap.tickCount ?? 0);
          const intervalSec = Number(sess.interval_sec ?? ap.intervalSec ?? ap.autopilotIntervalSec ?? 60);
          if (detail && sub) {
            detail.textContent = `Chu kỳ: ${cycleCount} · Quét tiếp sau: ${state.countdownSec}s (${intervalSec}s) · ${sub.riskTier || 'SAFE_75WR'}/${sub.preferredVersion || 'v9'}`;
          }
        }
      }, 1000);
    }
  }

  async function refreshCommercialDashboard() {
    if (!state.subSessionToken) return;
    const res = await fetch('/api/commercial/subscribers/dashboard', {
      headers: {
        Accept: 'application/json',
        'x-subscriber-token': state.subSessionToken,
      },
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      state.subDashboard = data;
      renderCommercialDashboard();
    }
  }

  async function refreshAll() {
    const q = `symbol=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}`;
    const fq = `tier=${encodeURIComponent(state.riskTier)}&profile=${encodeURIComponent(state.profile === 'EQUITY_ETF' ? 'EXCHANGE_POST_ONLY' : state.profile)}&version=${encodeURIComponent(state.frontierVersion)}`;
    el('chart-title').textContent = `${state.symbol} · ${state.timeframe} Closed Candles & Order Levels`;

    const [statusData, candleData, tradeData, sigData, frontierData, regimeData, versionsData, ordersData, plansData] = await Promise.all([
      apiGet(`/api/status?${q}`),
      apiGet(`/api/candles?${q}&limit=160`),
      apiGet(`/api/trades?${q}&limit=60`),
      apiGet(`/api/signals?${q}&limit=40`),
      apiGet(`/api/frontier?${fq}`),
      apiGet(`/api/regime?${q}`),
      apiGet('/api/versions'),
      apiGet('/api/orders?limit=40'),
      apiGet('/api/commercial/plans'),
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
    state.commercialPlans = plansData;
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
    renderCommercialPlansBadge();
    renderCommercialSimResult();
    await refreshCommercialDashboard();
    await refreshAutopilotStatus();
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

  async function handleEmergencyStop() {
    const msg = el('e2e-cockpit-action-status');
    const headers = state.autopilotSessionToken
      ? { 'x-subscriber-token': state.autopilotSessionToken }
      : {};
    try {
      await apiPost('/api/autopilot/stop', {
        subscriberId: state.autopilotSubscriberId || undefined,
        cancelPendingEntries: true,
      }, headers);
      msg.textContent = 'Đã tạm dừng giao dịch tự động. Các mức chốt lời và cắt lỗ vẫn được giữ nguyên.';
      await refreshAutopilotStatus();
    } catch (err) {
      msg.textContent = `Lỗi tạm dừng: ${err.message}`;
    }
  }

  function syncExchangeFields() {
    const ex = el('e2e-ex-select').value;
    const passWrap = el('e2e-passphrase-wrap');
    if (passWrap) {
      passWrap.classList.toggle('is-hidden', ex === 'BINANCE');
    }
  }

  function syncLicenseFields() {
    const quick = el('e2e-local-quickstart').checked;
    const licWrap = el('e2e-license-wrap');
    if (licWrap) {
      licWrap.classList.toggle('is-hidden', quick);
    }
  }

  function wireEyeToggles() {
    const buttons = document.querySelectorAll('.eye-toggle-btn[data-toggle-password]');
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-toggle-password');
        const input = el(targetId);
        if (!input) return;
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        btn.textContent = showing ? 'Hiện' : 'Ẩn';
      });
    }
  }

  function lockCurrentBrowserSession() {
    setAutopilotSession('', '');
    state.connectFormOpen = false;
    state.resumeAfterSettingsPin = false;
    el('e2e-apikey-input').value = '';
    el('e2e-apisecret-input').value = '';
    el('e2e-passphrase-input').value = '';
    el('e2e-pin-input').value = '';
    el('e2e-unlock-pin-input').value = '';
    refreshAutopilotStatus().catch(() => {});
  }

  function wireEvents() {
    wireEyeToggles();

    // Theme toggle & Pro Mode toggle
    el('theme-toggle-btn').addEventListener('click', () => {
      const next = getEffectiveThemeMode() === 'dark' ? 'light' : 'dark';
      applyTheme(next, true);
    });
    el('pro-mode-toggle-btn').addEventListener('click', () => {
      applyProMode(!state.proMode, true);
    });

    // Workspace Tabs
    el('view-tab-autopilot').addEventListener('click', () => switchWorkspaceTab('autopilot'));
    el('view-tab-flow').addEventListener('click', () => switchWorkspaceTab('flow'));
    el('view-tab-quant').addEventListener('click', () => switchWorkspaceTab('quant'));

    // Progressive Welcome <-> Connect Card toggles
    el('e2e-show-connect-btn').addEventListener('click', () => {
      state.connectFormOpen = true;
      renderAutopilotView();
    });
    el('e2e-hide-connect-btn').addEventListener('click', () => {
      state.connectFormOpen = false;
      renderAutopilotView();
    });
    el('e2e-saved-profile-select').addEventListener('change', () => {
      syncUnlockPinVisibility(state.autopilotStatus?.savedProfiles || []);
    });

    // 1-Click $1,000 Paper Sandbox
    el('e2e-paper-sandbox-btn').addEventListener('click', async () => {
      const msg = el('e2e-sandbox-status');
      const btn = el('e2e-paper-sandbox-btn');
      btn.disabled = true;
      msg.textContent = 'Đang khởi tạo tài khoản dùng thử $1,000...';
      try {
        const res = await apiPost('/api/autopilot/demo-sandbox', {
          intervalSec: Number(el('e2e-interval-input').value || 60),
          preferredVersion: 'v9',
          riskTier: 'SAFE_75WR',
        });
        const tok = res.sessionToken || '';
        const subId = res.subscriber?.subscriberId || '';
        setAutopilotSession(tok, subId);
        state.connectFormOpen = false;
        if (res.status) {
          state.autopilotStatus = res.status;
          state.countdownSec = computeCountdownSeconds(res.status);
          renderAutopilotView();
        } else {
          await refreshAutopilotStatus();
        }
        msg.textContent = '';
      } catch (err) {
        msg.textContent = `Không thể tạo tài khoản dùng thử: ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    });

    // E2E Wizard field toggles
    el('e2e-ex-select').addEventListener('change', syncExchangeFields);
    el('e2e-local-quickstart').addEventListener('change', syncLicenseFields);
    el('e2e-set-exchange').addEventListener('change', syncSettingsPassphraseField);

    // Settings Dialog
    el('e2e-open-settings-btn').addEventListener('click', () => {
      state.resumeAfterSettingsPin = false;
      openSettingsDialog();
    });
    el('e2e-settings-cancel-btn').addEventListener('click', () => {
      state.resumeAfterSettingsPin = false;
      el('e2e-settings-dialog').close();
    });

    el('e2e-settings-form').addEventListener('submit', async e => {
      e.preventDefault();
      const msg = el('e2e-settings-status');
      msg.textContent = 'Đang lưu cài đặt...';
      const [riskTier, preferredVersion] = String(el('e2e-set-strategy').value || 'SAFE_75WR|v9').split('|');
      const payload = {
        subscriberId: state.autopilotSubscriberId || undefined,
        name: el('e2e-set-name').value.trim(),
        email: el('e2e-set-email').value.trim() || null,
        exchange: el('e2e-set-exchange').value,
        simulated: el('e2e-set-simulated').value === '1',
        preferredVersion,
        riskTier,
        maxDailyLossPct: Number(el('e2e-set-daily-loss').value || 5),
        maxDdKillPct: Number(el('e2e-set-max-dd').value || 20),
        intervalSec: Number(el('e2e-set-interval').value || 60),
      };
      const newKey = el('e2e-set-apikey').value.trim();
      const newSec = el('e2e-set-apisecret').value.trim();
      const newPass = el('e2e-set-passphrase').value.trim();
      const pin = el('e2e-set-pin').value.trim();
      if (newKey) payload.apiKey = newKey;
      if (newSec) payload.apiSecret = newSec;
      if (newPass) payload.passphrase = newPass;
      if (pin) payload.armingPin = pin;

      const wasPaused = !state.autopilotStatus?.armed && state.autopilotStatus?.session?.state !== 'ARMED_RUNNING';
      const shouldResumeAfterSave = Boolean((state.resumeAfterSettingsPin || wasPaused) && pin && state.autopilotSessionToken);

      try {
        const res = await apiPost('/api/autopilot/settings', payload, {
          'x-subscriber-token': state.autopilotSessionToken,
        });
        let finalStatus = res.status || null;
        let resumedOk = false;
        if (shouldResumeAfterSave) {
          const armedRes = await apiPost('/api/autopilot/start', {
            subscriberId: state.autopilotSubscriberId || undefined,
            armingPin: pin,
            intervalSec: payload.intervalSec,
          }, { 'x-subscriber-token': state.autopilotSessionToken });
          if (armedRes.status) finalStatus = armedRes.status;
          resumedOk = true;
        }
        state.resumeAfterSettingsPin = false;
        el('e2e-set-apikey').value = '';
        el('e2e-set-apisecret').value = '';
        el('e2e-set-passphrase').value = '';
        el('e2e-set-pin').value = '';
        if (finalStatus) {
          state.autopilotStatus = finalStatus;
          if (resumedOk) state.countdownSec = computeCountdownSeconds(finalStatus);
          renderAutopilotView();
        } else {
          await refreshAutopilotStatus();
        }
        el('e2e-cockpit-action-status').textContent = resumedOk
          ? 'Đã cập nhật cài đặt và tiếp tục giao dịch tự động 24/7.'
          : 'Đã cập nhật cài đặt tài khoản thành công.';
        el('e2e-settings-dialog').close();
      } catch (err) {
        msg.textContent = `Lỗi cập nhật: ${err.message}`;
      }
    });

    el('e2e-delete-profile-btn').addEventListener('click', () => {
      state.deleteConfirmArmed = !state.deleteConfirmArmed;
      el('e2e-delete-confirm-btn').classList.toggle('is-hidden', !state.deleteConfirmArmed);
      el('e2e-delete-profile-btn').textContent = state.deleteConfirmArmed ? 'Hủy xóa' : 'Xóa hồ sơ này';
    });

    el('e2e-delete-confirm-btn').addEventListener('click', async () => {
      const msg = el('e2e-settings-status');
      msg.textContent = 'Đang xóa hồ sơ...';
      try {
        await apiPost('/api/autopilot/delete-profile', {
          subscriberId: state.autopilotSubscriberId || undefined,
        }, { 'x-subscriber-token': state.autopilotSessionToken });
        setAutopilotSession('', '');
        state.connectFormOpen = false;
        el('e2e-settings-dialog').close();
        await refreshAutopilotStatus();
      } catch (err) {
        msg.textContent = `Không thể xóa hồ sơ: ${err.message}`;
      }
    });

    // Quick Delete Profile from Saved Profiles card
    el('e2e-quick-delete-profile-btn').addEventListener('click', async () => {
      const msg = el('e2e-unlock-status');
      const subscriberId = el('e2e-saved-profile-select').value;
      const armingPin = el('e2e-unlock-pin-input').value.trim();
      if (!subscriberId) return;
      msg.textContent = 'Đang xóa hồ sơ đã chọn...';
      try {
        await apiPost('/api/autopilot/delete-profile', {
          subscriberId,
          armingPin: armingPin || undefined,
        });
        el('e2e-unlock-pin-input').value = '';
        if (state.autopilotSubscriberId === subscriberId) {
          setAutopilotSession('', '');
        }
        msg.textContent = 'Đã xóa hồ sơ khỏi thiết bị.';
        await refreshAutopilotStatus();
      } catch (err) {
        msg.textContent = `Xóa hồ sơ cần xác thực: ${err.message}`;
      }
    });

    // Emergency Stop, Pause, Resume, Switch Account / Lock Session
    el('topbar-emergency-stop-btn').addEventListener('click', handleEmergencyStop);
    el('e2e-emergency-stop-btn').addEventListener('click', handleEmergencyStop);
    el('e2e-pause-btn').addEventListener('click', handleEmergencyStop);
    el('e2e-lock-session-btn').addEventListener('click', lockCurrentBrowserSession);
    el('e2e-switch-account-btn').addEventListener('click', lockCurrentBrowserSession);

    el('e2e-resume-btn').addEventListener('click', async () => {
      const sub = state.autopilotStatus?.subscriber;
      if (sub?.isPaperSandbox && !sub?.hasArmingPin && state.autopilotSessionToken) {
        const msg = el('e2e-cockpit-action-status');
        msg.textContent = 'Đang tiếp tục chạy tự động...';
        try {
          const res = await apiPost('/api/autopilot/start', {
            intervalSec: Number(state.autopilotStatus?.session?.interval_sec || 60),
          }, { 'x-subscriber-token': state.autopilotSessionToken });
          if (res.status) {
            state.autopilotStatus = res.status;
            state.countdownSec = computeCountdownSeconds(res.status);
            renderAutopilotView();
          } else {
            await refreshAutopilotStatus();
          }
          msg.textContent = 'Đã tiếp tục giao dịch tự động 24/7.';
        } catch (err) {
          msg.textContent = `Không thể tiếp tục: ${err.message}`;
        }
        return;
      }
      const existingPin = el('e2e-unlock-pin-input').value.trim() || el('e2e-set-pin').value.trim();
      if (existingPin && state.autopilotSessionToken) {
        const msg = el('e2e-cockpit-action-status');
        msg.textContent = 'Đang xác thực mã PIN để tiếp tục chạy tự động...';
        try {
          const res = await apiPost('/api/autopilot/start', {
            subscriberId: state.autopilotSubscriberId || undefined,
            armingPin: existingPin,
            intervalSec: Number(state.autopilotStatus?.session?.interval_sec || 60),
          }, { 'x-subscriber-token': state.autopilotSessionToken });
          el('e2e-unlock-pin-input').value = '';
          el('e2e-set-pin').value = '';
          if (res.status) {
            state.autopilotStatus = res.status;
            state.countdownSec = computeCountdownSeconds(res.status);
            renderAutopilotView();
          } else {
            await refreshAutopilotStatus();
          }
          msg.textContent = 'Đã tiếp tục giao dịch tự động 24/7.';
        } catch (err) {
          msg.textContent = `Không thể tiếp tục: ${err.message}`;
        }
        return;
      }
      state.resumeAfterSettingsPin = true;
      openSettingsDialog();
      el('e2e-settings-keys-details').open = true;
      el('e2e-settings-status').textContent = 'Nhập mã PIN hiện tại rồi nhấn Lưu cài đặt để tiếp tục chạy tự động.';
    });

    el('e2e-scan-now-btn').addEventListener('click', async () => {
      if (!state.autopilotSessionToken) return;
      const msg = el('e2e-cockpit-action-status');
      const isArmed = Boolean(state.autopilotStatus?.armed || state.autopilotStatus?.session?.state === 'ARMED_RUNNING');
      msg.textContent = isArmed ? 'Đang quét thị trường ngay...' : 'Đang cập nhật số dư và tín hiệu...';
      try {
        if (isArmed) {
          const tickRes = await apiPost('/api/autopilot/tick', {}, {
            'x-subscriber-token': state.autopilotSessionToken,
          });
          if (tickRes.status) {
            state.autopilotStatus = tickRes.status;
            state.countdownSec = computeCountdownSeconds(tickRes.status);
            renderAutopilotView();
          } else {
            await refreshAutopilotStatus();
          }
          msg.textContent = 'Đã hoàn thành quét thị trường.';
        } else {
          await apiPost('/api/commercial/subscribers/scan', {
            timeframe: state.timeframe || '1h',
          }, { 'x-subscriber-token': state.autopilotSessionToken });
          await refreshAutopilotStatus();
          msg.textContent = 'Đã cập nhật số dư và phiếu tín hiệu mới nhất.';
        }
      } catch (err) {
        msg.textContent = `Lỗi quét thị trường: ${err.message}`;
      }
    });

    // Quick Unlock Saved Profile Form
    el('e2e-unlock-form').addEventListener('submit', async e => {
      e.preventDefault();
      const msg = el('e2e-unlock-status');
      const subscriberId = el('e2e-saved-profile-select').value;
      const armingPin = el('e2e-unlock-pin-input').value.trim();
      const autoStart = el('e2e-unlock-autostart').checked;
      const selectedProfile = (state.autopilotStatus?.savedProfiles || []).find(p => p.subscriberId === subscriberId);
      if (selectedProfile?.isPaperSandbox && !selectedProfile?.hasArmingPin) {
        msg.textContent = 'Đang mở lại tài khoản dùng thử $1,000...';
        try {
          const sb = await apiPost('/api/autopilot/demo-sandbox', {});
          setAutopilotSession(sb.sessionToken || '', sb.subscriber?.subscriberId || subscriberId);
          state.connectFormOpen = false;
          msg.textContent = '';
          if (sb.status) {
            state.autopilotStatus = sb.status;
            state.countdownSec = computeCountdownSeconds(sb.status);
            renderAutopilotView();
          } else {
            await refreshAutopilotStatus();
          }
        } catch (err) {
          msg.textContent = `Không thể mở lại tài khoản dùng thử: ${err.message}`;
        }
        return;
      }
      if (!subscriberId || !armingPin) {
        msg.textContent = 'Vui lòng chọn tài khoản và nhập mã PIN.';
        return;
      }
      msg.textContent = 'Đang xác thực mã PIN...';
      try {
        const unlocked = await apiPost('/api/commercial/subscribers/unlock', {
          subscriberId,
          armingPin,
        });
        const tok = unlocked.sessionToken || '';
        setAutopilotSession(tok, subscriberId);
        state.connectFormOpen = false;
        if (autoStart) {
          const savedIntervalSec = selectedProfile?.intervalSec
            || state.autopilotStatus?.session?.interval_sec
            || Number(el('e2e-interval-input').value || 60);
          await apiPost('/api/autopilot/start', {
            subscriberId,
            armingPin,
            intervalSec: savedIntervalSec,
          }, { 'x-subscriber-token': tok });
        }
        el('e2e-unlock-pin-input').value = '';
        msg.textContent = '';
        await refreshAutopilotStatus();
      } catch (err) {
        msg.textContent = `Mở khóa thất bại: ${err.message}`;
      }
    });

    // Step 2 Advanced: Verify Connection & Preview Contract Sizing
    el('e2e-verify-btn').addEventListener('click', async () => {
      const msg = el('e2e-verify-status');
      msg.textContent = 'Đang kiểm tra kết nối và quy đổi cỡ lệnh...';
      const simEqRaw = el('e2e-sim-equity-input').value.trim();
      const [riskTier, preferredVersion] = String(el('e2e-strategy-select').value || 'SAFE_75WR|v9').split('|');
      try {
        const res = await apiPost('/api/autopilot/verify-connection', {
          exchange: el('e2e-ex-select').value,
          simulated: el('e2e-env-select').value === '1',
          apiKey: el('e2e-apikey-input').value.trim(),
          apiSecret: el('e2e-apisecret-input').value.trim(),
          passphrase: el('e2e-passphrase-input').value.trim(),
          simulatedEquityUsdt: simEqRaw ? Number(simEqRaw) : null,
          timeframe: '1h',
          version: preferredVersion || 'v9',
          riskTier: riskTier || 'SAFE_75WR',
        });
        state.preflightData = res;
        renderPreflightResult();
        msg.textContent = `Kết nối hợp lệ (${res.keyMask || 'Mô phỏng'}) · Chặn rút tiền: ĐẠT · Vốn: $${fmtNum(res.totalEquityUsdt, 2)}`;
      } catch (err) {
        state.preflightData = null;
        renderPreflightResult();
        msg.textContent = `Kiểm tra thất bại: ${err.message}`;
      }
    });

    // 1-Click Connect, Encrypt API & Arm 24/7
    el('e2e-connect-start-btn').addEventListener('click', async () => {
      const msg = el('e2e-wizard-status');
      const name = el('e2e-account-name').value.trim() || 'Tài khoản của tôi';
      const armingPin = el('e2e-pin-input').value.trim();
      const useLocalQuickstart = el('e2e-local-quickstart').checked;
      const licenseKey = useLocalQuickstart ? '' : el('e2e-license-input').value.trim();
      const [riskTier, preferredVersion] = String(el('e2e-strategy-select').value || 'SAFE_75WR|v9').split('|');
      const simEqRaw = el('e2e-sim-equity-input').value.trim();

      if (!armingPin || armingPin.length < 4) {
        msg.textContent = 'Vui lòng tạo mã PIN từ 4 đến 16 ký tự để bảo vệ tài khoản.';
        return;
      }

      msg.textContent = 'Đang mã hóa khóa giao dịch và khởi chạy tự động 24/7...';
      try {
        const res = await apiPost('/api/autopilot/connect-and-start', {
          subscriberId: state.autopilotSubscriberId || undefined,
          name,
          exchange: el('e2e-ex-select').value,
          simulated: el('e2e-env-select').value === '1',
          apiKey: el('e2e-apikey-input').value.trim(),
          apiSecret: el('e2e-apisecret-input').value.trim(),
          passphrase: el('e2e-passphrase-input').value.trim(),
          armingPin,
          useLocalQuickstart,
          licenseKey,
          preferredVersion: preferredVersion || 'v9',
          riskTier: riskTier || 'SAFE_75WR',
          maxDailyLossPct: Number(el('e2e-daily-loss-input').value || 5),
          maxDdKillPct: Number(el('e2e-max-dd-input').value || 20),
          intervalSec: Number(el('e2e-interval-input').value || 60),
          simulatedEquityUsdt: simEqRaw ? Number(simEqRaw) : null,
          autoStart: true,
        });

        el('e2e-apikey-input').value = '';
        el('e2e-apisecret-input').value = '';
        el('e2e-passphrase-input').value = '';
        el('e2e-pin-input').value = '';

        const tok = res.sessionToken || '';
        const subId = res.subscriber?.subscriberId || '';
        setAutopilotSession(tok, subId);
        state.connectFormOpen = false;
        msg.textContent = '';
        if (res.status) {
          state.autopilotStatus = res.status;
          state.countdownSec = computeCountdownSeconds(res.status);
          renderAutopilotView();
        } else {
          await refreshAutopilotStatus();
        }
      } catch (err) {
        msg.textContent = `Không thể kết nối: ${err.message}`;
      }
    });

    // Legacy Quant Pro Terminal Event Listeners
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

    el('commercial-sim-form').addEventListener('submit', async e => {
      e.preventDefault();
      const msg = el('comm-sim-status');
      msg.textContent = 'Simulating account sizing...';
      try {
        const res = await apiPost('/api/commercial/simulate-scan', {
          equityUsdt: Number(el('comm-sim-equity').value || 1500),
          exchange: el('comm-sim-exchange').value,
          version: el('comm-sim-version').value,
          riskTier: state.riskTier,
          riskPct: Number(el('comm-sim-risk').value || 1.0),
        });
        state.commercialSim = res;
        renderCommercialSimResult();
        msg.textContent = `Simulated ${res.rows?.length ?? 0} streams at $${fmtNum(res.equityUsdt, 2)} (${res.bracket?.bracket || '-'}).`;
      } catch (err) {
        msg.textContent = `Sim error: ${err.message}`;
      }
    });

    el('commercial-onboard-form').addEventListener('submit', async e => {
      e.preventDefault();
      const msg = el('comm-vault-status');
      msg.textContent = 'Verifying license & encrypting credentials...';
      try {
        const res = await apiPost('/api/commercial/subscribers/onboard', {
          name: el('comm-name-input').value.trim(),
          email: el('comm-email-input').value.trim() || null,
          licenseKey: el('comm-license-input').value.trim(),
          exchange: el('comm-ex-select').value,
          simulated: el('comm-sim-toggle').value === '1',
          apiKey: el('comm-apikey-input').value.trim(),
          apiSecret: el('comm-apisecret-input').value.trim(),
          passphrase: el('comm-passphrase-input').value.trim(),
          armingPin: el('comm-pin-input').value.trim(),
          executionMode: el('comm-mode-select').value,
          riskTier: state.riskTier,
        });
        el('comm-apikey-input').value = '';
        el('comm-apisecret-input').value = '';
        el('comm-passphrase-input').value = '';
        state.subSessionToken = res.sessionToken || '';
        setAutopilotSession(state.subSessionToken, res.subscriber?.subscriberId || '');
        msg.textContent = `Onboarded ${res.subscriber?.subscriberId} (${res.subscriber?.planId}) · KeyMask: ${res.keyMask || 'Zero-Key'}`;
        await refreshCommercialDashboard();
        await refreshAutopilotStatus();
      } catch (err) {
        msg.textContent = `Onboard blocked: ${err.message}`;
      }
    });

    el('comm-scan-btn').addEventListener('click', async () => {
      const msg = el('comm-vault-status');
      if (!state.subSessionToken) {
        msg.textContent = 'Onboard a subscriber vault session first.';
        return;
      }
      try {
        const res = await apiPost('/api/commercial/subscribers/scan', {
          simulatedEquityUsdt: Number(el('comm-sim-equity').value || 1500),
        }, { 'x-subscriber-token': state.subSessionToken });
        msg.textContent = `Scanned $${fmtNum(res.scan?.total_equity_usdt, 2)} (${res.bracket?.bracket || '-'}) · Tickets: ${res.tickets?.length ?? 0}`;
        await refreshCommercialDashboard();
      } catch (err) {
        msg.textContent = `Scan error: ${err.message}`;
      }
    });

    el('comm-mode-btn').addEventListener('click', async () => {
      const msg = el('comm-vault-status');
      if (!state.subSessionToken) {
        msg.textContent = 'Onboard a subscriber vault session first.';
        return;
      }
      try {
        const res = await apiPost('/api/commercial/subscribers/mode', {
          executionMode: el('comm-mode-select').value,
          armingPin: el('comm-pin-input').value.trim(),
        }, { 'x-subscriber-token': state.subSessionToken });
        msg.textContent = `Subscriber mode updated to ${res.subscriber?.executionMode}`;
        await refreshCommercialDashboard();
      } catch (err) {
        msg.textContent = `Mode error: ${err.message}`;
      }
    });

    el('comm-runcycle-btn').addEventListener('click', async () => {
      const msg = el('comm-vault-status');
      if (!state.subSessionToken) {
        msg.textContent = 'Onboard a subscriber vault session first.';
        return;
      }
      try {
        const res = await apiPost('/api/commercial/subscribers/run-cycle', {
          armingPin: el('comm-pin-input').value.trim(),
        }, { 'x-subscriber-token': state.subSessionToken });
        msg.textContent = res.executed
          ? `Auto-trade cycle executed (${res.actions?.length ?? 0} actions)`
          : `Cycle blocked/scan-only: ${res.blockedReason || res.action || 'OK'}`;
        await refreshCommercialDashboard();
      } catch (err) {
        msg.textContent = `Cycle error: ${err.message}`;
      }
    });
  }

  // Init
  initTheme();
  initProMode();
  state.autopilotSessionToken = readStorage(window.sessionStorage, STORAGE_TOKEN_KEY);
  state.autopilotSubscriberId = readStorage(window.sessionStorage, STORAGE_SUB_ID_KEY);
  if (state.autopilotSessionToken) {
    state.subSessionToken = state.autopilotSessionToken;
  }

  wireEvents();
  syncExchangeFields();
  syncLicenseFields();
  renderAutopilotView();
  renderFlowView();
  syncPollingTimers();

  refreshAll().catch(err => {
    el('mode-status-msg').textContent = `Init error: ${err.message}`;
  });
})();
