import assert from 'node:assert/strict';

export const OKX_INSTRUMENTS_URL = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';

export const OKX_SWAP_DEFAULT_SPECS = Object.freeze({
  'BTC-USDT-SWAP': Object.freeze({
    exchange: 'OKX',
    instId: 'BTC-USDT-SWAP',
    symbol: 'BTCUSDT.P',
    ctVal: 0.01,
    lotSz: 0.01,
    minSz: 0.01,
    tickSz: 0.1,
  }),
  'ETH-USDT-SWAP': Object.freeze({
    exchange: 'OKX',
    instId: 'ETH-USDT-SWAP',
    symbol: 'ETHUSDT.P',
    ctVal: 0.1,
    lotSz: 0.01,
    minSz: 0.01,
    tickSz: 0.01,
  }),
  'SOL-USDT-SWAP': Object.freeze({
    exchange: 'OKX',
    instId: 'SOL-USDT-SWAP',
    symbol: 'SOLUSDT.P',
    ctVal: 1,
    lotSz: 0.01,
    minSz: 0.01,
    tickSz: 0.01,
  }),
  'BNB-USDT-SWAP': Object.freeze({
    exchange: 'OKX',
    instId: 'BNB-USDT-SWAP',
    symbol: 'BNBUSDT.P',
    ctVal: 0.01,
    lotSz: 1,
    minSz: 1,
    tickSz: 0.1,
  }),
});

export const BINANCE_USDM_DEFAULT_SPECS = Object.freeze({
  BTCUSDT: Object.freeze({
    exchange: 'BINANCE',
    instId: 'BTCUSDT',
    symbol: 'BTCUSDT.P',
    stepSize: 0.001,
    minQty: 0.001,
    minNotionalUsdt: 100,
    tickSize: 0.1,
  }),
  ETHUSDT: Object.freeze({
    exchange: 'BINANCE',
    instId: 'ETHUSDT',
    symbol: 'ETHUSDT.P',
    stepSize: 0.001,
    minQty: 0.001,
    minNotionalUsdt: 20,
    tickSize: 0.01,
  }),
  SOLUSDT: Object.freeze({
    exchange: 'BINANCE',
    instId: 'SOLUSDT',
    symbol: 'SOLUSDT.P',
    stepSize: 0.1,
    minQty: 0.1,
    minNotionalUsdt: 5,
    tickSize: 0.01,
  }),
  BNBUSDT: Object.freeze({
    exchange: 'BINANCE',
    instId: 'BNBUSDT',
    symbol: 'BNBUSDT.P',
    stepSize: 0.01,
    minQty: 0.01,
    minNotionalUsdt: 5,
    tickSize: 0.01,
  }),
});

function countStepDecimals(step) {
  const s = String(step);
  if (s.includes('e-') || s.includes('E-')) {
    const [, exp] = s.toLowerCase().split('e-');
    return Math.max(0, Number(exp) || 0);
  }
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

export function roundToStep(value, step, mode = 'floor') {
  assert.ok(Number.isFinite(value), `Invalid value for roundToStep: ${value}`);
  assert.ok(Number.isFinite(step) && step > 0, `Invalid step for roundToStep: ${step}`);

  const decimals = countStepDecimals(step);
  const scale = 10 ** decimals;
  const stepUnits = Math.round(step * scale);
  const rawUnits = (value * scale) / stepUnits;

  let steppedUnits;
  if (mode === 'floor') {
    steppedUnits = Math.floor(rawUnits + 1e-12);
  } else if (mode === 'ceil') {
    steppedUnits = Math.ceil(rawUnits - 1e-12);
  } else if (mode === 'round') {
    steppedUnits = Math.round(rawUnits);
  } else {
    throw new Error(`Unsupported roundToStep mode: ${mode}`);
  }

  return Number(((steppedUnits * stepUnits) / scale).toFixed(decimals));
}

function normalizeBaseSymbol(symbol) {
  let s = String(symbol || 'BTCUSDT.P').trim().toUpperCase();
  if (s.startsWith('OKX:')) s = s.slice(4);
  if (s.endsWith('.P')) s = s.slice(0, -2);
  if (s.endsWith('-USDT-SWAP')) s = s.slice(0, -10);
  else if (s.endsWith('-USDT')) s = s.slice(0, -5);
  else if (s.endsWith('USDT')) s = s.slice(0, -4);
  return s;
}

function lookupLiveSpec(liveSpecsMap, key) {
  if (!liveSpecsMap) return null;
  if (liveSpecsMap instanceof Map) return liveSpecsMap.get(key) ?? null;
  if (typeof liveSpecsMap === 'object') return liveSpecsMap[key] ?? null;
  return null;
}

export async function fetchLiveOkxSwapSpecs(fetchImpl = globalThis.fetch) {
  assert.equal(typeof fetchImpl, 'function', 'fetchImpl must be a function');
  const res = await fetchImpl(OKX_INSTRUMENTS_URL, {
    headers: { 'User-Agent': 'TRADING-TOOL-Standalone/10.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching OKX SWAP instruments`);
  }
  const payload = await res.json();
  if (payload?.code !== '0' || !Array.isArray(payload.data)) {
    throw new Error(`OKX instruments API error: code=${payload?.code} msg=${payload?.msg ?? ''}`);
  }

  const map = new Map();
  for (const item of payload.data) {
    if (!item?.instId) continue;
    const ctVal = Number(item.ctVal);
    const lotSz = Number(item.lotSz);
    const minSz = Number(item.minSz);
    const tickSz = Number(item.tickSz);
    if (![ctVal, lotSz, minSz, tickSz].every(v => Number.isFinite(v) && v > 0)) continue;
    map.set(item.instId, {
      exchange: 'OKX',
      instId: item.instId,
      symbol: item.instId.endsWith('-USDT-SWAP') ? `${item.instId.slice(0, -10)}USDT.P` : item.instId,
      ctVal,
      lotSz,
      minSz,
      tickSz,
      state: item.state ?? 'live',
    });
  }
  return map;
}

export function getInstrumentSpec(exchange, symbol, liveSpecsMap = null) {
  const ex = String(exchange || 'OKX').trim().toUpperCase();
  const base = normalizeBaseSymbol(symbol);

  if (ex === 'OKX') {
    const instId = `${base}-USDT-SWAP`;
    const live = lookupLiveSpec(liveSpecsMap, instId) || lookupLiveSpec(liveSpecsMap, symbol);
    if (live) return { ...live, exchange: 'OKX', instId };
    const def = OKX_SWAP_DEFAULT_SPECS[instId];
    if (def) return { ...def };
    throw new Error(`Unsupported OKX SWAP symbol: ${symbol}`);
  }

  if (ex === 'BINANCE') {
    const instId = `${base}USDT`;
    const live = lookupLiveSpec(liveSpecsMap, instId) || lookupLiveSpec(liveSpecsMap, symbol);
    if (live) return { ...live, exchange: 'BINANCE', instId };
    const def = BINANCE_USDM_DEFAULT_SPECS[instId];
    if (def) return { ...def };
    throw new Error(`Unsupported Binance USD-M symbol: ${symbol}`);
  }

  throw new Error(`Unsupported exchange for instrument specs: ${exchange}`);
}

/**
 * Computes exact exchange-compliant order sizing (OKX SWAP contracts vs Binance USD-M coin qty),
 * rounded entry/SL/TP ticks, required margin, estimated fees, and estimated liquidation price.
 */
export function computeExchangeOrderSizing({
  exchange = 'OKX',
  symbol = 'BTCUSDT.P',
  side = 1,
  entryPrice,
  stopPrice,
  targetPrice,
  equityUsdt,
  availableMarginUsdt,
  riskPct = 1.0,
  strategyLev = 1.5,
  maxLeverageCap = 3.0,
  maxOrderUsdt = 5000,
  sizeMult = 1.0,
  mmr = 0.005,
  spec = null,
} = {}) {
  const ex = String(exchange || 'OKX').trim().toUpperCase();
  const resolvedSpec = spec ? { ...spec } : getInstrumentSpec(ex, symbol);
  const tickStep = resolvedSpec.tickSz ?? resolvedSpec.tickSize ?? 0.01;

  const entryPx = Number(entryPrice);
  const stopPx = Number(stopPrice);
  const eqUsdt = Number(equityUsdt);
  const dir = side === -1 || String(side).toLowerCase() === 'sell' ? -1 : 1;

  const tickEntryPx = Number.isFinite(entryPx) && entryPx > 0 ? roundToStep(entryPx, tickStep, 'round') : 0;
  const tickSlPx = Number.isFinite(stopPx) && stopPx > 0 ? roundToStep(stopPx, tickStep, 'round') : 0;
  const rawTp = Number(targetPrice);
  const tickTpPx = Number.isFinite(rawTp) && rawTp > 0 ? roundToStep(rawTp, tickStep, 'round') : null;

  const invalidBase = {
    feasible: false,
    szOrQtyString: '0',
    baseCoinQty: 0,
    contractsSz: 0,
    notionalUsdt: 0,
    marginRequiredUsdt: 0,
    tickEntryPx,
    tickSlPx,
    tickTpPx,
    estimatedRiskUsdt: 0,
    estimatedProfitUsdt: 0,
    estimatedFeeUsdt: 0,
    estimatedLiqPx: 0,
    spec: resolvedSpec,
  };

  if (!Number.isFinite(entryPx) || entryPx <= 0 || !Number.isFinite(stopPx) || stopPx <= 0) {
    return { ...invalidBase, skipReason: 'INVALID_ENTRY_OR_STOP_PRICE' };
  }
  if (!Number.isFinite(eqUsdt) || eqUsdt <= 0) {
    return { ...invalidBase, skipReason: 'INVALID_EQUITY_USDT' };
  }
  const stopDistRatio = Math.abs(entryPx - stopPx) / entryPx;
  if (!Number.isFinite(stopDistRatio) || stopDistRatio <= 0) {
    return { ...invalidBase, skipReason: 'ZERO_STOP_DISTANCE' };
  }

  const availMargin = Number.isFinite(Number(availableMarginUsdt)) ? Math.max(0, Number(availableMarginUsdt)) : eqUsdt;
  const effRiskPct = Number.isFinite(Number(riskPct)) && Number(riskPct) > 0 ? Number(riskPct) : 0;
  const effSizeMult = Number.isFinite(Number(sizeMult)) && Number(sizeMult) > 0 ? Number(sizeMult) : 0;
  const effMaxLev = Number.isFinite(Number(maxLeverageCap)) && Number(maxLeverageCap) > 0 ? Number(maxLeverageCap) : 1;
  const effStratLev = Number.isFinite(Number(strategyLev)) && Number(strategyLev) > 0 ? Number(strategyLev) : 1;
  const effMaxOrderUsdt = Number.isFinite(Number(maxOrderUsdt)) && Number(maxOrderUsdt) > 0 ? Number(maxOrderUsdt) : 0;

  const riskBudgetUsdt = eqUsdt * (effRiskPct / 100) * effSizeMult;
  const targetNotionalUsdt = Math.max(
    0,
    Math.min(
      riskBudgetUsdt / stopDistRatio,
      eqUsdt * effMaxLev,
      availMargin * 0.85 * effMaxLev,
      effMaxOrderUsdt,
    ),
  );

  let contractsSz = 0;
  let baseCoinQty = 0;
  let notionalUsdt = 0;
  let szOrQtyString = '0';
  let feasible = false;
  let skipReason = null;

  if (ex === 'OKX') {
    const rawContracts = (targetNotionalUsdt / entryPx) / resolvedSpec.ctVal;
    contractsSz = roundToStep(rawContracts, resolvedSpec.lotSz, 'floor');
    const dec = countStepDecimals(resolvedSpec.lotSz);
    szOrQtyString = contractsSz.toFixed(dec);
    baseCoinQty = Number((contractsSz * resolvedSpec.ctVal).toFixed(12));
    notionalUsdt = baseCoinQty * entryPx;
    feasible = contractsSz >= resolvedSpec.minSz && notionalUsdt > 0;
    if (!feasible) {
      skipReason = targetNotionalUsdt <= 0 ? 'ZERO_TARGET_NOTIONAL' : 'BELOW_OKX_MIN_SZ';
    }
  } else if (ex === 'BINANCE') {
    const coinQty = roundToStep(targetNotionalUsdt / entryPx, resolvedSpec.stepSize, 'floor');
    const dec = countStepDecimals(resolvedSpec.stepSize);
    szOrQtyString = coinQty.toFixed(dec);
    baseCoinQty = coinQty;
    contractsSz = coinQty;
    notionalUsdt = baseCoinQty * entryPx;
    feasible = coinQty >= resolvedSpec.minQty && notionalUsdt >= resolvedSpec.minNotionalUsdt;
    if (!feasible) {
      if (targetNotionalUsdt <= 0) skipReason = 'ZERO_TARGET_NOTIONAL';
      else if (coinQty < resolvedSpec.minQty) skipReason = 'BELOW_BINANCE_MIN_QTY';
      else skipReason = 'BELOW_BINANCE_MIN_NOTIONAL';
    }
  } else {
    return { ...invalidBase, skipReason: `UNSUPPORTED_EXCHANGE_${ex}` };
  }

  const effLev = Math.min(effStratLev, effMaxLev);
  const marginRequiredUsdt = notionalUsdt / Math.max(1, effLev);
  const estimatedRiskUsdt = baseCoinQty * Math.abs(tickEntryPx - tickSlPx);
  const estimatedProfitUsdt = tickTpPx !== null && Number.isFinite(tickTpPx)
    ? baseCoinQty * Math.abs(tickTpPx - tickEntryPx)
    : 0;
  const estimatedFeeUsdt = notionalUsdt * 0.0004;
  const liqDistanceRatio = (1 / Math.max(1e-9, effLev)) - mmr;
  const estimatedLiqPx = Math.max(0, tickEntryPx * (1 - dir * liqDistanceRatio));

  return {
    feasible,
    skipReason,
    szOrQtyString,
    baseCoinQty,
    contractsSz,
    notionalUsdt,
    marginRequiredUsdt,
    tickEntryPx,
    tickSlPx,
    tickTpPx,
    estimatedRiskUsdt,
    estimatedProfitUsdt,
    estimatedFeeUsdt,
    estimatedLiqPx,
    spec: resolvedSpec,
  };
}

/**
 * Inspects OKX / Binance API key permission payloads and enforces strict safety:
 * any key with withdrawal permission enabled is hard-blocked (`safeForAutoTrade: false`).
 */
export function inspectApiKeyPermissions({ exchange = 'OKX', rawPermissionPayload } = {}) {
  const ex = String(exchange || 'OKX').trim().toUpperCase();
  if (!rawPermissionPayload || typeof rawPermissionPayload !== 'object') {
    return {
      safeForAutoTrade: false,
      hasWithdrawPermission: false,
      canTrade: false,
      canRead: false,
      reason: 'EMPTY_PERMISSION_PAYLOAD',
    };
  }

  let hasWithdrawPermission = false;
  let canTrade = false;
  let canRead = false;

  if (ex === 'OKX') {
    const records = Array.isArray(rawPermissionPayload)
      ? rawPermissionPayload
      : (Array.isArray(rawPermissionPayload.data) ? rawPermissionPayload.data : [rawPermissionPayload]);

    for (const rec of records) {
      if (!rec || typeof rec !== 'object') continue;
      if (typeof rec.perm === 'string') {
        const tokens = rec.perm.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (tokens.includes('withdraw')) hasWithdrawPermission = true;
        if (tokens.includes('trade')) canTrade = true;
        if (tokens.includes('read_only') || tokens.includes('read')) canRead = true;
      }
      if (rec.canWithdraw === true || rec.withdraw === true) hasWithdrawPermission = true;
      if (rec.canTrade === true || rec.trade === true) canTrade = true;
      if (rec.canRead === true || rec.readOnly === true || rec.read === true) canRead = true;
    }
  } else if (ex === 'BINANCE') {
    const rec = Array.isArray(rawPermissionPayload) ? (rawPermissionPayload[0] ?? {}) : rawPermissionPayload;
    if (typeof rec.perm === 'string') {
      const tokens = rec.perm.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (tokens.includes('withdraw')) hasWithdrawPermission = true;
      if (tokens.includes('trade') || tokens.includes('futures')) canTrade = true;
      if (tokens.includes('read_only') || tokens.includes('read')) canRead = true;
    }
    if (rec.enableWithdrawals === true) hasWithdrawPermission = true;
    if (rec.enableFutures === true || rec.enableSpotAndMarginTrading === true) canTrade = true;
    if (rec.enableReading === true) canRead = true;
  } else {
    return {
      safeForAutoTrade: false,
      hasWithdrawPermission: false,
      canTrade: false,
      canRead: false,
      reason: `UNSUPPORTED_EXCHANGE_${ex}`,
    };
  }

  if (hasWithdrawPermission) {
    return {
      safeForAutoTrade: false,
      hasWithdrawPermission: true,
      canTrade,
      canRead,
      reason: 'WITHDRAW_PERMISSION_BLOCKED',
    };
  }

  if (!canTrade) {
    return {
      safeForAutoTrade: false,
      hasWithdrawPermission: false,
      canTrade: false,
      canRead,
      reason: 'TRADE_PERMISSION_MISSING',
    };
  }

  return {
    safeForAutoTrade: true,
    hasWithdrawPermission: false,
    canTrade: true,
    canRead,
    reason: 'SAFE_TRADE_NO_WITHDRAW',
  };
}
