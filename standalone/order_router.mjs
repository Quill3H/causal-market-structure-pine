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
  toBinanceSymbol,
} from './exchange_binance.mjs';
import {
  buildPostOnlyEntryOrder,
  buildReduceOnlySlTpOrders,
  toOkxInstId,
} from './exchange_okx.mjs';
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

function formatQty(notionalUsdt, price) {
  const px = Number(price);
  if (!Number.isFinite(px) || px <= 0) return '0.001';
  const raw = Number(notionalUsdt) / px;
  const clamped = Math.max(0.001, raw);
  return clamped.toFixed(4);
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
    const rows = this.store.getOrdersLog({ symbol, limit: 250 });
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
      const qtyStr = formatQty(effNotional, px);
      const barTime = activeOverlay.signalTime || 0;
      const clOrdId = makeClientOrderId({
        exchange,
        symbol,
        timeframe,
        barTime,
        side: activeOverlay.side,
        leg: 'E',
      });
      const payload = exchange === 'OKX'
        ? buildPostOnlyEntryOrder({ symbol, side: activeOverlay.side, sz: qtyStr, px: px.toFixed(2), clOrdId })
        : buildBinancePostOnlyEntryOrder({ symbol, side: activeOverlay.side, quantity: qtyStr, price: px.toFixed(2), newClientOrderId: clOrdId });

      const entryRes = await this._dispatchOrder({
        clientOrderId: clOrdId,
        symbol,
        exchange,
        mode: modeInfo.mode,
        orderType: exchange === 'OKX' ? 'post_only' : 'LIMIT_GTX',
        side: activeOverlay.side === 1 ? 'buy' : 'sell',
        price: px,
        qty: Number(qtyStr),
        reduceOnly: false,
        payload,
        notionalUsdt: effNotional,
        requestedLeverage: effLev,
        confirmToken: effToken,
        executeLiveFn: () => (
          exchange === 'OKX'
            ? this.exchangeClient.placePostOnlyEntry(
                { symbol, side: activeOverlay.side, sz: qtyStr, px: px.toFixed(2), clOrdId },
                { confirmToken: effToken, notionalUsdt: effNotional },
              )
            : this.exchangeClient.placePostOnlyEntry(
                { symbol, side: activeOverlay.side, quantity: qtyStr, price: px.toFixed(2), newClientOrderId: clOrdId },
                { confirmToken: effToken, notionalUsdt: effNotional },
              )
        ),
      });
      actions.push(entryRes);
    }

    // 3) Active OPEN_POSITION -> ensure protective reduceOnly OCO / SL+TP is in place
    if (activeOverlay.status === 'OPEN_POSITION' && Number.isFinite(Number(activeOverlay.entry))) {
      const entryPx = Number(activeOverlay.entry);
      const qtyStr = formatQty(effNotional, entryPx);
      const barTime = activeOverlay.entryTime || activeOverlay.signalTime || 0;
      const slTpClOrdId = makeClientOrderId({
        exchange,
        symbol,
        timeframe,
        barTime,
        side: activeOverlay.side,
        leg: 'S',
      });
      const slPx = Number.isFinite(Number(activeOverlay.stop)) ? Number(activeOverlay.stop).toFixed(2) : null;
      const tpPx = Number.isFinite(Number(activeOverlay.target)) ? Number(activeOverlay.target).toFixed(2) : null;
      const payload = exchange === 'OKX'
        ? buildReduceOnlySlTpOrders({ symbol, entrySide: activeOverlay.side, sz: qtyStr, slTriggerPx: slPx, tpTriggerPx: tpPx })
        : buildBinanceReduceOnlySlTpOrders({ symbol, entrySide: activeOverlay.side, quantity: qtyStr, stopPrice: slPx, takeProfitPrice: tpPx });

      const slTpRes = await this._dispatchOrder({
        clientOrderId: slTpClOrdId,
        symbol,
        exchange,
        mode: modeInfo.mode,
        orderType: exchange === 'OKX' ? 'oco_reduceOnly' : 'SLTP_REDUCE_ONLY',
        side: activeOverlay.side === 1 ? 'sell' : 'buy',
        price: activeOverlay.stop ?? activeOverlay.target ?? entryPx,
        qty: Number(qtyStr),
        reduceOnly: true,
        payload,
        notionalUsdt: effNotional,
        requestedLeverage: effLev,
        confirmToken: effToken,
        executeLiveFn: () => (
          exchange === 'OKX'
            ? this.exchangeClient.placeReduceOnlySlTp(
                { symbol, entrySide: activeOverlay.side, sz: qtyStr, slTriggerPx: slPx, tpTriggerPx: tpPx },
                { confirmToken: effToken },
              )
            : this.exchangeClient.placeReduceOnlySlTp(
                { symbol, entrySide: activeOverlay.side, quantity: qtyStr, stopPrice: slPx, takeProfitPrice: tpPx },
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
}
