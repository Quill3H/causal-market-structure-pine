import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  assertLiveOrderSafety,
  hasExchangeCredentials,
  scrubSecrets,
} from './config.mjs';
import {
  buildBinancePostOnlyEntryOrder,
  buildBinanceReduceOnlySlTpOrders,
  hasBinanceProtectiveSlTp,
  toBinanceSymbol,
} from './exchange_binance.mjs';
import {
  buildPostOnlyEntryOrder,
  buildReduceOnlySlTpOrders,
  toOkxInstId,
} from './exchange_okx.mjs';
import { getInstrumentSpec, roundToStep } from './instrument_specs.mjs';
import { isEquitySymbol } from './market_equities.mjs';

export const OKX_CLORDID_REGEX = /^[A-Za-z0-9]{1,32}$/;

export const ROUTER_MODES = Object.freeze({
  PAPER_ZERO_KEY: 'PAPER_ZERO_KEY',
  OKX_DEMO_SIMULATED: 'OKX_DEMO_SIMULATED',
  LIVE_EXCHANGE_ARMED: 'LIVE_EXCHANGE_ARMED',
});

export const OKX_KEY_REQUIREMENTS_GUIDE = Object.freeze([
  {
    mode: ROUTER_MODES.PAPER_ZERO_KEY,
    label: 'Zero-Key Public Market + Paper (Default)',
    keysNeeded: 'None (0 API keys required)',
    permissions: 'Public REST market candles, 8h funding, mark price, Yahoo macro',
    envFlags: 'EXECUTION_MODE=PAPER, DRY_RUN=true, RISK_TIER=SAFE_75WR',
    networkOrders: false,
  },
  {
    mode: ROUTER_MODES.OKX_DEMO_SIMULATED,
    label: 'OKX Demo Trading (x-simulated-trading: 1)',
    keysNeeded: 'OKX_API_KEY + OKX_API_SECRET + OKX_PASSPHRASE (Demo account)',
    permissions: 'Read + Trade (Paper / Demo environment only; no real funds)',
    envFlags: 'EXCHANGE=OKX, OKX_SIMULATED=1, EXECUTION_MODE=LIVE_ARMED, DRY_RUN=false, LIVE_CONFIRM_TOKEN=<token>',
    networkOrders: true,
  },
  {
    mode: ROUTER_MODES.LIVE_EXCHANGE_ARMED,
    label: 'Live Exchange Armed (Real Capital, Capped)',
    keysNeeded: 'OKX_API_KEY + OKX_API_SECRET + OKX_PASSPHRASE (IP whitelist recommended)',
    permissions: 'Read + Trade ONLY (Withdrawals MUST stay DISABLED)',
    envFlags: 'OKX_SIMULATED=0, EXECUTION_MODE=LIVE_ARMED, DRY_RUN=false, LIVE_CONFIRM_TOKEN=<token>, MAX_LEVERAGE_CAP<=3.0, MAX_ORDER_USDT<=500',
    networkOrders: true,
  },
]);

export function isValidOkxClOrdId(clOrdId) {
  return typeof clOrdId === 'string' && OKX_CLORDID_REGEX.test(clOrdId);
}

/**
 * Generates a deterministic, idempotent, strictly alphanumeric client order ID
 * complying with OKX V5's `^[A-Za-z0-9]{1,32}$` rule (NO hyphens or underscores).
 */
export function makeClientOrderId({
  exchange = 'OKX',
  symbol = 'BTCUSDT.P',
  timeframe = '1h',
  barTime = 0,
  side = 1,
  leg = 'E',
} = {}) {
  const compactEx = String(exchange || 'OKX').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'OK';
  const compactCoin = String(symbol || 'BTC')
    .toUpperCase()
    .replace(/USDT\.P$|USDT$|-USDT-SWAP$/, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 4) || 'BTC';
  const compactTf = String(timeframe || '1h').replace(/[^A-Za-z0-9]/g, '').slice(0, 3) || '1h';
  const sideCode = (side === 1 || String(side).toLowerCase() === 'buy' || String(side).toLowerCase() === 'long') ? 'L' : 'S';
  const legCode = String(leg || 'E').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'E';

  const canonical = `${String(exchange).toUpperCase()}|${String(symbol).toUpperCase()}|${String(timeframe).toLowerCase()}|${Number(barTime) || 0}|${sideCode}|${legCode}`;
  const digest = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 14);
  const id = `tt9${compactEx}${compactCoin}${compactTf}${sideCode}${legCode}${digest}`.slice(0, 32);
  assert.ok(isValidOkxClOrdId(id), `Generated invalid alphanumeric clOrdId "${id}"`);
  return id;
}

/**
 * Resolves which of the 3 operating modes applies given current config.
 */
export function resolveRouterMode(config = {}) {
  const exchange = String(config.exchange || 'OKX').toUpperCase();
  const executionMode = String(config.executionMode || 'PAPER').toUpperCase();
  const dryRun = config.dryRun !== undefined ? Boolean(config.dryRun) : true;
  const hasKeys = hasExchangeCredentials(config, exchange);
  const simulated = exchange === 'OKX'
    ? Boolean(config.okx?.simulated ?? true)
    : Boolean(config.binance?.testnet ?? true);
  const hasToken = Boolean(config.liveConfirmToken);

  if (executionMode !== 'LIVE_ARMED' || dryRun || !hasKeys || !hasToken) {
    let reason = 'Default PAPER + DRY_RUN=true mode (zero real exchange calls)';
    if (executionMode === 'LIVE_ARMED' && dryRun) {
      reason = 'DRY_RUN=true blocks live exchange submission (safe dry-run)';
    } else if (executionMode === 'LIVE_ARMED' && !hasKeys) {
      reason = `${exchange} API credentials missing — falling back safely to PAPER_ZERO_KEY`;
    } else if (executionMode === 'LIVE_ARMED' && !hasToken) {
      reason = 'LIVE_CONFIRM_TOKEN missing — falling back safely to PAPER_ZERO_KEY';
    }
    return {
      mode: ROUTER_MODES.PAPER_ZERO_KEY,
      exchange,
      simulated,
      hasKeys,
      hasToken,
      liveArmed: false,
      dryRun: true,
      reason,
    };
  }

  if (simulated) {
    return {
      mode: ROUTER_MODES.OKX_DEMO_SIMULATED,
      exchange,
      simulated: true,
      hasKeys: true,
      hasToken: true,
      liveArmed: true,
      dryRun: false,
      reason: exchange === 'OKX'
        ? 'OKX Demo Trading active (x-simulated-trading: 1)'
        : 'Binance Futures Testnet active',
    };
  }

  return {
    mode: ROUTER_MODES.LIVE_EXCHANGE_ARMED,
    exchange,
    simulated: false,
    hasKeys: true,
    hasToken: true,
    liveArmed: true,
    dryRun: false,
    reason: `Live ${exchange} exchange order routing ARMED (capped at ${config.maxOrderUsdt} USDT / ${config.maxLeverageCap}x)`,
  };
}

function extractExchangeOrderId(exchange, responseData) {
  if (!responseData) return null;
  if (exchange === 'OKX') {
    const first = Array.isArray(responseData) ? responseData[0] : responseData;
    return first?.ordId || first?.algoId || null;
  }
  if (Array.isArray(responseData)) {
    const first = responseData[0];
    return first?.orderId !== undefined ? String(first.orderId) : null;
  }
  return responseData?.orderId !== undefined ? String(responseData.orderId) : null;
}

function countStepDecimals(step) {
  const s = String(step);
  if (s.includes('e-') || s.includes('E-')) {
    return Math.max(0, Number(s.toLowerCase().split('e-')[1]) || 0);
  }
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

function formatOrderSizeAndPrices({ exchange, symbol, notionalUsdt, entryPx, slPx = null, tpPx = null }) {
  let spec = null;
  try {
    spec = getInstrumentSpec(exchange, symbol);
  } catch {
    spec = null;
  }
  const tickStep = spec ? (spec.tickSz ?? spec.tickSize ?? 0.01) : 0.01;
  const tickDec = countStepDecimals(tickStep);
  const formatPx = (v) => {
    if (v === null || v === undefined || !Number.isFinite(Number(v)) || Number(v) <= 0) return null;
    return roundToStep(Number(v), tickStep, 'round').toFixed(tickDec);
  };

  let qtyStr;
  let qtyNum;
  const px = Number(entryPx);
  if (spec && exchange === 'OKX') {
    const rawContracts = Number.isFinite(px) && px > 0
      ? (Number(notionalUsdt) / px) / spec.ctVal
      : spec.minSz;
    const contracts = Math.max(spec.minSz, roundToStep(rawContracts, spec.lotSz, 'floor'));
    qtyStr = contracts.toFixed(countStepDecimals(spec.lotSz));
    qtyNum = Number(qtyStr);
  } else if (spec && exchange === 'BINANCE') {
    const rawQty = Number.isFinite(px) && px > 0
      ? Number(notionalUsdt) / px
      : spec.minQty;
    const coinQty = Math.max(spec.minQty, roundToStep(rawQty, spec.stepSize, 'floor'));
    qtyStr = coinQty.toFixed(countStepDecimals(spec.stepSize));
    qtyNum = Number(qtyStr);
  } else {
    const raw = Number.isFinite(px) && px > 0 ? Math.max(0.001, Number(notionalUsdt) / px) : 0.001;
    qtyStr = raw.toFixed(4);
    qtyNum = Number(qtyStr);
  }

  return {
    qtyStr,
    qtyNum,
    entryPxStr: formatPx(entryPx),
    slPxStr: formatPx(slPx),
    tpPxStr: formatPx(tpPx),
  };
}

export function buildOkxAttachedEntryPayload({
  symbol = 'BTCUSDT.P',
  side,
  notionalUsdt,
  entryPx,
  stop = null,
  target = null,
  timeframe = '1h',
  barTime = 0,
  clOrdId = null,
  attachAlgoClOrdId = null,
  tdMode = 'isolated',
} = {}) {
  const formatted = formatOrderSizeAndPrices({
    exchange: 'OKX',
    symbol,
    notionalUsdt,
    entryPx,
    slPx: stop,
    tpPx: target,
  });
  const effClOrdId = clOrdId || makeClientOrderId({
    exchange: 'OKX',
    symbol,
    timeframe,
    barTime,
    side,
    leg: 'E',
  });
  const hasSlTp = Boolean(formatted.slPxStr || formatted.tpPxStr);
  const effAlgoClId = hasSlTp
    ? (attachAlgoClOrdId || makeClientOrderId({
      exchange: 'OKX',
      symbol,
      timeframe,
      barTime,
      side,
      leg: 'A',
    }))
    : null;
  const payload = buildPostOnlyEntryOrder({
    symbol,
    side,
    sz: formatted.qtyStr,
    px: formatted.entryPxStr,
    tdMode,
    clOrdId: effClOrdId,
    slTriggerPx: formatted.slPxStr,
    tpTriggerPx: formatted.tpPxStr,
    attachAlgoClOrdId: effAlgoClId,
  });
  return {
    payload,
    clOrdId: effClOrdId,
    attachAlgoClOrdId: effAlgoClId,
    qtyStr: formatted.qtyStr,
    qtyNum: formatted.qtyNum,
    pxStr: formatted.entryPxStr,
    slPxStr: formatted.slPxStr,
    tpPxStr: formatted.tpPxStr,
  };
}

export class StandaloneOrderRouter {
  constructor({
    config,
    store,
    exchangeClient = null,
    defaultNotionalUsdt = 100,
    confirmToken = '',
  } = {}) {
    assert.ok(config, 'StandaloneOrderRouter requires config');
    assert.ok(store, 'StandaloneOrderRouter requires store');
    this.config = config;
    this.store = store;
    this.exchangeClient = exchangeClient;
    this.defaultNotionalUsdt = Math.min(Number(config.maxOrderUsdt ?? 500), Math.max(10, Number(defaultNotionalUsdt || 100)));
    this.confirmToken = confirmToken;
  }

  getStatus() {
    const resolved = resolveRouterMode(this.config);
    return {
      ...resolved,
      maxLeverageCap: Number(this.config.maxLeverageCap ?? 3.0),
      maxOrderUsdt: Number(this.config.maxOrderUsdt ?? 500),
      defaultNotionalUsdt: this.defaultNotionalUsdt,
      okxKeyGuide: OKX_KEY_REQUIREMENTS_GUIDE,
    };
  }

  _findExistingOrder(clientOrderId, symbol) {
    if (typeof this.store.getOrderByClientId === 'function') {
      return this.store.getOrderByClientId(clientOrderId);
    }
    const rows = this.store.getOrdersLog({ symbol, limit: 5000 });
    return rows.find(r => r.clientOrderId === clientOrderId) || null;
  }

  async _dispatchOrder({
    clientOrderId,
    symbol,
    exchange,
    mode,
    orderType,
    side,
    price,
    qty,
    reduceOnly,
    payload,
    notionalUsdt,
    requestedLeverage,
    confirmToken,
    executeLiveFn,
  }) {
    assert.ok(isValidOkxClOrdId(clientOrderId), `Invalid clOrdId "${clientOrderId}"`);
    const existing = this._findExistingOrder(clientOrderId, symbol);
    if (existing && ['PAPER_SIMULATED', 'PAPER_CANCEL_SIMULATED', 'SUBMITTED', 'SUBMITTING', 'CANCELLED'].includes(existing.status)) {
      return {
        action: 'IDEMPOTENT_SKIP',
        clientOrderId,
        status: existing.status,
        mode,
      };
    }

    if (mode === ROUTER_MODES.PAPER_ZERO_KEY || !this.exchangeClient) {
      const simStatus = orderType === 'CANCEL' ? 'PAPER_CANCEL_SIMULATED' : 'PAPER_SIMULATED';
      this.store.upsertOrderLog({
        clientOrderId,
        exchange,
        symbol,
        mode: ROUTER_MODES.PAPER_ZERO_KEY,
        orderType,
        side,
        price,
        qty,
        reduceOnly,
        status: simStatus,
        exchangeOrderId: null,
        payload,
        response: { dryRun: true, simulatedPaper: true },
      });
      return {
        action: simStatus,
        clientOrderId,
        status: simStatus,
        mode: ROUTER_MODES.PAPER_ZERO_KEY,
        payload,
      };
    }

    // Strict live safety check before touching orders_log as SUBMITTING or hitting REST API
    assertLiveOrderSafety(this.config, confirmToken, {
      orderNotionalUsdt: orderType === 'CANCEL' ? undefined : notionalUsdt,
      requestedLeverage,
    });

    // Crash-safety WAL transition: record SUBMITTING before network call
    this.store.upsertOrderLog({
      clientOrderId,
      exchange,
      symbol,
      mode,
      orderType,
      side,
      price,
      qty,
      reduceOnly,
      status: 'SUBMITTING',
      exchangeOrderId: null,
      payload,
      response: null,
    });

    try {
      const res = await executeLiveFn();
      const exOrdId = extractExchangeOrderId(exchange, res?.data);
      const doneStatus = orderType === 'CANCEL' ? 'CANCELLED' : 'SUBMITTED';
      this.store.upsertOrderLog({
        clientOrderId,
        exchange,
        symbol,
        mode,
        orderType,
        side,
        price,
        qty,
        reduceOnly,
        status: doneStatus,
        exchangeOrderId: exOrdId,
        payload,
        response: res,
      });
      return {
        action: doneStatus,
        clientOrderId,
        exchangeOrderId: exOrdId,
        status: doneStatus,
        mode,
        response: res,
      };
    } catch (err) {
      const safeMsg = scrubSecrets(err.message, this.config);
      this.store.upsertOrderLog({
        clientOrderId,
        exchange,
        symbol,
        mode,
        orderType,
        side,
        price,
        qty,
        reduceOnly,
        status: 'REJECTED',
        exchangeOrderId: null,
        payload,
        response: { error: safeMsg },
      });
      return {
        action: 'REJECTED',
        clientOrderId,
        status: 'REJECTED',
        mode,
        error: safeMsg,
      };
    }
  }

  /**
   * Routes a strategy state transition (`FLAT` / `PENDING_LIMIT` / `OPEN_POSITION`)
   * deterministically with idempotent alphanumeric `clOrdId` and safety interlocks.
   */
  async routeTransition({
    symbol = 'BTCUSDT.P',
    timeframe = '1h',
    activeOverlay,
    previousOverlay = null,
    confirmToken,
    notionalUsdt,
    attachSlTpOnEntry = false,
  } = {}) {
    if (isEquitySymbol(symbol)) {
      return { action: 'SKIPPED_EQUITY', mode: ROUTER_MODES.PAPER_ZERO_KEY, actions: [] };
    }

    const modeInfo = resolveRouterMode(this.config);
    const exchange = modeInfo.exchange;
    const effToken = confirmToken ?? this.confirmToken ?? '';
    const effNotional = Number(notionalUsdt ?? this.defaultNotionalUsdt);
    const actions = [];

    // 1) Stale PENDING_LIMIT expiry or side/signal flip -> cancel prior maker limit order
    const prevWasPending = previousOverlay?.status === 'PENDING_LIMIT';
    const stalePending = prevWasPending && (
      !activeOverlay ||
      activeOverlay.status === 'FLAT' ||
      (activeOverlay.status === 'PENDING_LIMIT' &&
        (activeOverlay.signalTime !== previousOverlay.signalTime || activeOverlay.side !== previousOverlay.side))
    );

    if (stalePending) {
      const prevBarTime = previousOverlay.signalTime || 0;
      const origClOrdId = makeClientOrderId({
        exchange,
        symbol,
        timeframe,
        barTime: prevBarTime,
        side: previousOverlay.side,
        leg: 'E',
      });
      const cancelClOrdId = makeClientOrderId({
        exchange,
        symbol,
        timeframe,
        barTime: prevBarTime,
        side: previousOverlay.side,
        leg: 'C',
      });
      const cancelPayload = exchange === 'OKX'
        ? { instId: toOkxInstId(symbol), clOrdId: origClOrdId }
        : { symbol: toBinanceSymbol(symbol), origClientOrderId: origClOrdId };

      const cancelRes = await this._dispatchOrder({
        clientOrderId: cancelClOrdId,
        symbol,
        exchange,
        mode: modeInfo.mode,
        orderType: 'CANCEL',
        side: previousOverlay.side === 1 ? 'sell' : 'buy',
        price: previousOverlay.limitPrice ?? null,
        qty: 0,
        reduceOnly: false,
        payload: cancelPayload,
        notionalUsdt: 0,
        requestedLeverage: 1,
        confirmToken: effToken,
        executeLiveFn: () => (
          exchange === 'OKX'
            ? this.exchangeClient.cancelOrder({ symbol, clOrdId: origClOrdId }, { confirmToken: effToken })
            : this.exchangeClient.cancelOrder({ symbol, origClientOrderId: origClOrdId }, { confirmToken: effToken })
        ),
      });
      actions.push(cancelRes);
    }

    if (!activeOverlay || activeOverlay.status === 'FLAT') {
      return { action: actions.length ? actions[0].action : 'NOOP_FLAT', mode: modeInfo.mode, actions };
    }

    const effLev = Number(activeOverlay.lev ?? 1.5);

    // 2) Active PENDING_LIMIT -> place Post-Only maker entry
    if (activeOverlay.status === 'PENDING_LIMIT' && Number.isFinite(Number(activeOverlay.limitPrice))) {
      const px = Number(activeOverlay.limitPrice);
      const barTime = activeOverlay.signalTime || 0;
      const shouldAttach = Boolean(attachSlTpOnEntry && exchange === 'OKX' && (
        (Number.isFinite(Number(activeOverlay.stop)) && Number(activeOverlay.stop) > 0) ||
        (Number.isFinite(Number(activeOverlay.target)) && Number(activeOverlay.target) > 0)
      ));

      let qtyStr;
      let qtyNum;
      let pxStr;
      let clOrdId;
      let payload;
      let attached = null;

      if (shouldAttach) {
        attached = buildOkxAttachedEntryPayload({
          symbol,
          side: activeOverlay.side,
          notionalUsdt: effNotional,
          entryPx: px,
          stop: activeOverlay.stop,
          target: activeOverlay.target,
          timeframe,
          barTime,
        });
        qtyStr = attached.qtyStr;
        qtyNum = attached.qtyNum;
        pxStr = attached.pxStr;
        clOrdId = attached.clOrdId;
        payload = attached.payload;
      } else {
        const formatted = formatOrderSizeAndPrices({ exchange, symbol, notionalUsdt: effNotional, entryPx: px });
        qtyStr = formatted.qtyStr;
        qtyNum = formatted.qtyNum;
        pxStr = formatted.entryPxStr;
        clOrdId = makeClientOrderId({
          exchange,
          symbol,
          timeframe,
          barTime,
          side: activeOverlay.side,
          leg: 'E',
        });
        payload = exchange === 'OKX'
          ? buildPostOnlyEntryOrder({ symbol, side: activeOverlay.side, sz: qtyStr, px: pxStr, clOrdId })
          : buildBinancePostOnlyEntryOrder({ symbol, side: activeOverlay.side, quantity: qtyStr, price: pxStr, newClientOrderId: clOrdId });
      }

      const entryRes = await this._dispatchOrder({
        clientOrderId: clOrdId,
        symbol,
        exchange,
        mode: modeInfo.mode,
        orderType: exchange === 'OKX' ? 'post_only' : 'LIMIT_GTX',
        side: activeOverlay.side === 1 ? 'buy' : 'sell',
        price: Number(pxStr),
        qty: qtyNum,
        reduceOnly: false,
        payload,
        notionalUsdt: effNotional,
        requestedLeverage: effLev,
        confirmToken: effToken,
        executeLiveFn: () => (
          exchange === 'OKX'
            ? this.exchangeClient.placePostOnlyEntry(
                {
                  symbol,
                  side: activeOverlay.side,
                  sz: qtyStr,
                  px: pxStr,
                  clOrdId,
                  ...(attached ? {
                    slTriggerPx: attached.slPxStr,
                    tpTriggerPx: attached.tpPxStr,
                    attachAlgoClOrdId: attached.attachAlgoClOrdId,
                  } : {}),
                },
                { confirmToken: effToken, notionalUsdt: effNotional },
              )
            : this.exchangeClient.placePostOnlyEntry(
                { symbol, side: activeOverlay.side, quantity: qtyStr, price: pxStr, newClientOrderId: clOrdId },
                { confirmToken: effToken, notionalUsdt: effNotional },
              )
        ),
      });
      actions.push(entryRes);
    }

    // 3) Active OPEN_POSITION -> ensure protective reduceOnly OCO / SL+TP is in place
    if (activeOverlay.status === 'OPEN_POSITION' && Number.isFinite(Number(activeOverlay.entry))) {
      const entryPx = Number(activeOverlay.entry);
      const formatted = formatOrderSizeAndPrices({
        exchange,
        symbol,
        notionalUsdt: effNotional,
        entryPx,
        slPx: activeOverlay.stop,
        tpPx: activeOverlay.target,
      });
      const qtyStr = formatted.qtyStr;
      const barTime = activeOverlay.entryTime || activeOverlay.signalTime || 0;
      const slTpClOrdId = makeClientOrderId({
        exchange,
        symbol,
        timeframe,
        barTime,
        side: activeOverlay.side,
        leg: 'S',
      });
      const slPx = formatted.slPxStr;
      const tpPx = formatted.tpPxStr;
      const payload = exchange === 'OKX'
        ? buildReduceOnlySlTpOrders({ symbol, entrySide: activeOverlay.side, sz: qtyStr, slTriggerPx: slPx, tpTriggerPx: tpPx, algoClOrdId: slTpClOrdId })
        : buildBinanceReduceOnlySlTpOrders({ symbol, entrySide: activeOverlay.side, quantity: qtyStr, stopPrice: slPx, takeProfitPrice: tpPx, slClientOrderId: slTpClOrdId });

      const slTpRes = await this._dispatchOrder({
        clientOrderId: slTpClOrdId,
        symbol,
        exchange,
        mode: modeInfo.mode,
        orderType: exchange === 'OKX' ? 'oco_reduceOnly' : 'SLTP_REDUCE_ONLY',
        side: activeOverlay.side === 1 ? 'sell' : 'buy',
        price: activeOverlay.stop ?? activeOverlay.target ?? entryPx,
        qty: formatted.qtyNum,
        reduceOnly: true,
        payload,
        notionalUsdt: effNotional,
        requestedLeverage: effLev,
        confirmToken: effToken,
        executeLiveFn: () => (
          exchange === 'OKX'
            ? this.exchangeClient.placeReduceOnlySlTp(
                { symbol, entrySide: activeOverlay.side, sz: qtyStr, slTriggerPx: slPx, tpTriggerPx: tpPx, algoClOrdId: slTpClOrdId },
                { confirmToken: effToken },
              )
            : this.exchangeClient.placeReduceOnlySlTp(
                { symbol, entrySide: activeOverlay.side, quantity: qtyStr, stopPrice: slPx, takeProfitPrice: tpPx, slClientOrderId: slTpClOrdId },
                { confirmToken: effToken },
              )
        ),
      });
      actions.push(slTpRes);
    }

    return {
      action: actions.length ? actions[actions.length - 1].action : 'NOOP',
      mode: modeInfo.mode,
      actions,
    };
  }

  /**
   * Reconciles a filled open position against exchange open protective orders and
   * dispatches idempotent reduceOnly SL/TP sized to the actual filled position quantity.
   */
  async syncFilledPositionProtection({
    symbol = 'BTCUSDT.P',
    timeframe = '1h',
    openPositions = [],
    openOrders = [],
    plannedStop = null,
    plannedTarget = null,
    barTime = 0,
    confirmToken,
  } = {}) {
    if (isEquitySymbol(symbol)) {
      return { action: 'SKIPPED_EQUITY', symbol };
    }

    const modeInfo = resolveRouterMode(this.config);
    const exchange = modeInfo.exchange;
    const targetInstId = exchange === 'OKX' ? toOkxInstId(symbol) : toBinanceSymbol(symbol);

    let matchedPos = null;
    let signedQty = 0;
    for (const p of Array.isArray(openPositions) ? openPositions : []) {
      if (!p || typeof p !== 'object') continue;
      const pSym = String(p.instId || p.symbol || '').toUpperCase();
      if (pSym !== targetInstId && pSym !== String(symbol).toUpperCase()) continue;
      let q = Number(p.positionAmt ?? p.pos ?? p.sz ?? 0);
      if (!Number.isFinite(q) || q === 0) continue;
      if (String(p.posSide || '').toLowerCase() === 'short') q = -Math.abs(q);
      else if (String(p.posSide || '').toLowerCase() === 'long') q = Math.abs(q);
      matchedPos = p;
      signedQty = q;
      break;
    }

    if (!matchedPos || signedQty === 0) {
      return { action: 'NO_OPEN_POSITION', symbol, mode: modeInfo.mode };
    }

    const entrySide = signedQty > 0 ? 1 : -1;
    const absQty = Math.abs(signedQty);
    const needSl = Number.isFinite(Number(plannedStop)) && Number(plannedStop) > 0;
    const needTp = Number.isFinite(Number(plannedTarget)) && Number(plannedTarget) > 0;
    if (!needSl && !needTp) {
      return { action: 'NO_PLANNED_PROTECTION', symbol, mode: modeInfo.mode };
    }

    if (exchange === 'BINANCE') {
      const prot = hasBinanceProtectiveSlTp({ openOrders, symbol, entrySide });
      if ((!needSl || prot.hasSl) && (!needTp || prot.hasTp)) {
        return { action: 'ALREADY_PROTECTED', symbol, mode: modeInfo.mode, protection: prot };
      }
    } else {
      const closeSide = entrySide === 1 ? 'sell' : 'buy';
      let hasSl = false;
      let hasTp = false;
      for (const ord of Array.isArray(openOrders) ? openOrders : []) {
        if (!ord || typeof ord !== 'object') continue;
        if (String(ord.instId || '').toUpperCase() !== targetInstId) continue;
        if (ord.side && String(ord.side).toLowerCase() !== closeSide) continue;
        if (Number(ord.slTriggerPx) > 0) hasSl = true;
        if (Number(ord.tpTriggerPx) > 0) hasTp = true;
      }
      if ((!needSl || hasSl) && (!needTp || hasTp)) {
        return { action: 'ALREADY_PROTECTED', symbol, mode: modeInfo.mode, protection: { hasSl, hasTp } };
      }
    }

    let spec = null;
    try {
      spec = getInstrumentSpec(exchange, symbol);
    } catch {
      spec = null;
    }
    const tickStep = spec ? (spec.tickSz ?? spec.tickSize ?? 0.01) : 0.01;
    const tickDec = countStepDecimals(tickStep);
    const slPxStr = needSl ? roundToStep(Number(plannedStop), tickStep, 'round').toFixed(tickDec) : null;
    const tpPxStr = needTp ? roundToStep(Number(plannedTarget), tickStep, 'round').toFixed(tickDec) : null;

    let qtyStr;
    let qtyNum;
    if (spec && exchange === 'OKX') {
      const stepped = Math.max(spec.minSz, roundToStep(absQty, spec.lotSz, 'floor'));
      qtyStr = stepped.toFixed(countStepDecimals(spec.lotSz));
      qtyNum = Number(qtyStr);
    } else if (spec && exchange === 'BINANCE') {
      const stepped = Math.max(spec.minQty, roundToStep(absQty, spec.stepSize, 'floor'));
      qtyStr = stepped.toFixed(countStepDecimals(spec.stepSize));
      qtyNum = Number(qtyStr);
    } else {
      qtyStr = absQty.toFixed(4);
      qtyNum = Number(qtyStr);
    }

    const slTpClOrdId = makeClientOrderId({
      exchange,
      symbol,
      timeframe,
      barTime,
      side: entrySide,
      leg: 'F',
    });
    const effToken = confirmToken ?? this.confirmToken ?? '';
    const refPx = Number(matchedPos.markPx ?? matchedPos.avgPx ?? matchedPos.entryPrice ?? plannedStop ?? plannedTarget ?? 0);
    const estNotional = refPx > 0 ? qtyNum * (spec?.ctVal ?? 1) * refPx : this.defaultNotionalUsdt;

    const payload = exchange === 'OKX'
      ? buildReduceOnlySlTpOrders({ symbol, entrySide, sz: qtyStr, slTriggerPx: slPxStr, tpTriggerPx: tpPxStr, algoClOrdId: slTpClOrdId })
      : buildBinanceReduceOnlySlTpOrders({ symbol, entrySide, quantity: qtyStr, stopPrice: slPxStr, takeProfitPrice: tpPxStr, slClientOrderId: slTpClOrdId });

    const res = await this._dispatchOrder({
      clientOrderId: slTpClOrdId,
      symbol,
      exchange,
      mode: modeInfo.mode,
      orderType: exchange === 'OKX' ? 'oco_reduceOnly' : 'SLTP_REDUCE_ONLY',
      side: entrySide === 1 ? 'sell' : 'buy',
      price: Number(slPxStr ?? tpPxStr ?? refPx),
      qty: qtyNum,
      reduceOnly: true,
      payload,
      notionalUsdt: estNotional,
      requestedLeverage: Number(matchedPos.lever ?? matchedPos.leverage ?? 1.5),
      confirmToken: effToken,
      executeLiveFn: () => (
        exchange === 'OKX'
          ? this.exchangeClient.placeReduceOnlySlTp(
              { symbol, entrySide, sz: qtyStr, slTriggerPx: slPxStr, tpTriggerPx: tpPxStr, algoClOrdId: slTpClOrdId },
              { confirmToken: effToken },
            )
          : this.exchangeClient.placeReduceOnlySlTp(
              { symbol, entrySide, quantity: qtyStr, stopPrice: slPxStr, takeProfitPrice: tpPxStr, slClientOrderId: slTpClOrdId },
              { confirmToken: effToken },
            )
      ),
    });

    if (res.action === 'SUBMITTED' || res.action === 'PAPER_SIMULATED') {
      return {
        ...res,
        action: 'PROTECTIVE_SL_TP_SYNCED',
        dispatchAction: res.action,
        symbol,
        qty: qtyStr,
      };
    }
    return { ...res, symbol, qty: qtyStr };
  }
}
