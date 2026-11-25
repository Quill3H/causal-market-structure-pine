import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { assertLiveOrderSafety } from './config.mjs';

export const BINANCE_FAPI_URL = 'https://fapi.binance.com';
export const BINANCE_TESTNET_URL = 'https://testnet.binancefuture.com';

const INTERVAL_MAP = Object.freeze({
  '1m': { interval: '1m', intervalSeconds: 60 },
  '5m': { interval: '5m', intervalSeconds: 300 },
  '15m': { interval: '15m', intervalSeconds: 900 },
  '1h': { interval: '1h', intervalSeconds: 3600 },
  '4h': { interval: '4h', intervalSeconds: 14400 },
  '1d': { interval: '1d', intervalSeconds: 86400 },
});

export function toBinanceSymbol(symbol) {
  const s = String(symbol || 'BTCUSDT.P').trim().toUpperCase();
  if (s.endsWith('.P')) return s.slice(0, -2);
  if (s.endsWith('-SWAP')) return s.slice(0, -5).replace(/-/g, '');
  return s.replace(/-/g, '');
}

export function toBinanceIntervalSpec(timeframe) {
  const tf = String(timeframe || '1h').trim().toLowerCase();
  const spec = INTERVAL_MAP[tf];
  if (!spec) throw new Error(`Unsupported Binance interval: ${timeframe}`);
  return spec;
}

export function parseBinanceKline(entry) {
  assert.ok(Array.isArray(entry) && entry.length >= 7, 'Malformed Binance kline array');
  const openTimeMs = Number(entry[0]);
  const open = Number(entry[1]);
  const high = Number(entry[2]);
  const low = Number(entry[3]);
  const close = Number(entry[4]);
  const volume = Number(entry[5]);
  const closeTimeMs = Number(entry[6]);
  assert.ok(Number.isSafeInteger(openTimeMs) && openTimeMs > 0, 'Invalid Binance openTimeMs');
  assert.ok(Number.isSafeInteger(closeTimeMs) && closeTimeMs > openTimeMs, 'Invalid Binance closeTimeMs');
  assert.ok([open, high, low, close].every(v => Number.isFinite(v) && v > 0), 'Invalid Binance OHLC');
  assert.ok(Number.isFinite(volume) && volume >= 0, 'Invalid Binance volume');
  return {
    time: Math.floor(openTimeMs / 1000),
    open,
    high,
    low,
    close,
    volume,
    openTimeMs,
    closeTimeMs,
  };
}

/**
 * Computes exact Binance USD-M Futures HMAC-SHA256 signature:
 * queryString = serialized params including timestamp (+ optional recvWindow)
 * signature = hex(HMAC-SHA256(apiSecret, queryString))
 */
export function signBinanceRequest({
  params = {},
  timestamp = Date.now(),
  recvWindow = 5000,
  apiKey,
  apiSecret,
}) {
  assert.ok(apiKey && apiSecret, 'Binance API credentials incomplete');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  if (recvWindow !== undefined && recvWindow !== null && !qs.has('recvWindow')) {
    qs.set('recvWindow', String(recvWindow));
  }
  qs.set('timestamp', String(timestamp));
  const queryString = qs.toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  const fullQueryString = `${queryString}&signature=${signature}`;
  const headers = {
    'X-MBX-APIKEY': apiKey,
  };
  return { timestamp, queryString, signature, fullQueryString, headers };
}

export function buildBinancePostOnlyEntryOrder({
  symbol = 'BTCUSDT.P',
  side,
  quantity,
  price,
  positionSide,
  newClientOrderId,
}) {
  const sym = toBinanceSymbol(symbol);
  const sideStr = side === 1 || String(side).toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
  const payload = {
    symbol: sym,
    side: sideStr,
    type: 'LIMIT',
    timeInForce: 'GTX',
    quantity: String(quantity),
    price: String(price),
  };
  if (positionSide) payload.positionSide = positionSide;
  if (newClientOrderId) payload.newClientOrderId = newClientOrderId;
  return payload;
}

export function buildBinanceReduceOnlySlTpOrders({
  symbol = 'BTCUSDT.P',
  entrySide,
  quantity,
  stopPrice,
  takeProfitPrice,
  workingType = 'MARK_PRICE',
}) {
  const sym = toBinanceSymbol(symbol);
  const closeSide = entrySide === 1 || String(entrySide).toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
  const orders = [];
  if (stopPrice !== undefined && stopPrice !== null) {
    orders.push({
      symbol: sym,
      side: closeSide,
      type: 'STOP_MARKET',
      stopPrice: String(stopPrice),
      quantity: String(quantity),
      reduceOnly: 'true',
      workingType,
    });
  }
  if (takeProfitPrice !== undefined && takeProfitPrice !== null) {
    orders.push({
      symbol: sym,
      side: closeSide,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: String(takeProfitPrice),
      quantity: String(quantity),
      reduceOnly: 'true',
      workingType: 'CONTRACT_PRICE',
    });
  }
  return orders;
}

export class BinanceFuturesClient {
  constructor(options = {}) {
    this.testnet = Boolean(options.testnet ?? true);
    this.baseUrl = options.baseUrl || (this.testnet ? BINANCE_TESTNET_URL : BINANCE_FAPI_URL);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.apiKey = options.apiKey || '';
    this.apiSecret = options.apiSecret || '';
    this.dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : true;
    this.executionMode = options.executionMode || 'PAPER';
    this.liveConfirmToken = options.liveConfirmToken || '';
    this.maxLeverageCap = Number(options.maxLeverageCap ?? 3.0);
    this.maxOrderUsdt = Number(options.maxOrderUsdt ?? 500);
  }

  hasCredentials() {
    return Boolean(this.apiKey && this.apiSecret);
  }

  async _requestPublic(requestPath) {
    const res = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
      headers: { 'User-Agent': 'TRADING-TOOL-Standalone/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Binance HTTP ${res.status} on ${requestPath}`);
    }
    return res.json();
  }

  async _requestPrivate(method, requestPath, params = {}) {
    if (!this.hasCredentials()) {
      throw new Error('Binance API credentials are not configured');
    }
    const { fullQueryString, headers } = signBinanceRequest({
      params,
      apiKey: this.apiKey,
      apiSecret: this.apiSecret,
    });
    const upperMethod = String(method).toUpperCase();
    const url = `${this.baseUrl}${requestPath}?${fullQueryString}`;
    const res = await this.fetchImpl(url, {
      method: upperMethod,
      headers,
      signal: AbortSignal.timeout(15000),
    });
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(`Binance private HTTP ${res.status}: ${payload?.msg || 'unknown'}`);
    }
    return payload;
  }

  async getClosedCandles({ symbol = 'BTCUSDT.P', timeframe = '1h', limit = 500, endTimeMs } = {}) {
    const sym = toBinanceSymbol(symbol);
    const { interval } = toBinanceIntervalSpec(timeframe);
    const params = new URLSearchParams({
      symbol: sym,
      interval,
      limit: String(Math.min(1500, Math.max(1, limit))),
    });
    if (endTimeMs !== undefined) params.set('endTime', String(endTimeMs));
    const data = await this._requestPublic(`/fapi/v1/klines?${params.toString()}`);
    const nowMs = Date.now();
    const rows = [];
    for (const raw of data) {
      const k = parseBinanceKline(raw);
      if (k.closeTimeMs > nowMs) continue;
      rows.push({
        time: k.time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
      });
    }
    rows.sort((a, b) => a.time - b.time);
    return rows;
  }

  async getFundingRates({ symbol = 'BTCUSDT.P', limit = 100, endTimeMs } = {}) {
    const sym = toBinanceSymbol(symbol);
    const params = new URLSearchParams({
      symbol: sym,
      limit: String(Math.min(1000, Math.max(1, limit))),
    });
    if (endTimeMs !== undefined) params.set('endTime', String(endTimeMs));
    const data = await this._requestPublic(`/fapi/v1/fundingRate?${params.toString()}`);
    return data
      .map(d => ({
        time: Math.floor(Number(d.fundingTime) / 1000),
        fundingRate: Number(d.fundingRate),
        realizedRate: Number(d.fundingRate),
      }))
      .filter(d => Number.isSafeInteger(d.time) && Number.isFinite(d.fundingRate))
      .sort((a, b) => a.time - b.time);
  }

  async getPremiumIndex(symbol = 'BTCUSDT.P') {
    const sym = toBinanceSymbol(symbol);
    const d = await this._requestPublic(`/fapi/v1/premiumIndex?symbol=${encodeURIComponent(sym)}`);
    return {
      symbol: sym,
      markPrice: Number(d.markPrice),
      indexPrice: Number(d.indexPrice),
      lastFundingRate: Number(d.lastFundingRate),
      nextFundingTimeMs: Number(d.nextFundingTime),
    };
  }

  async getOpenInterest(symbol = 'BTCUSDT.P') {
    const sym = toBinanceSymbol(symbol);
    const d = await this._requestPublic(`/fapi/v1/openInterest?symbol=${encodeURIComponent(sym)}`);
    return { symbol: sym, openInterest: Number(d.openInterest), time: Number(d.time) };
  }

  async getOrderbookTicker(symbol = 'BTCUSDT.P') {
    const sym = toBinanceSymbol(symbol);
    const d = await this._requestPublic(`/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(sym)}`);
    return {
      symbol: sym,
      bidPrice: Number(d.bidPrice),
      bidQty: Number(d.bidQty),
      askPrice: Number(d.askPrice),
      askQty: Number(d.askQty),
      time: Number(d.time),
    };
  }

  async getAccountHealth() {
    if (!this.hasCredentials()) {
      return {
        exchange: 'BINANCE',
        configured: false,
        connected: false,
        testnet: this.testnet,
        reason: 'No Binance API keys configured (public-market + PAPER mode active)',
      };
    }
    const acct = await this._requestPrivate('GET', '/fapi/v2/account');
    return {
      exchange: 'BINANCE',
      configured: true,
      connected: true,
      testnet: this.testnet,
      totalWalletBalance: Number(acct.totalWalletBalance ?? 0),
      availableBalance: Number(acct.availableBalance ?? 0),
      openPositions: (acct.positions || [])
        .filter(p => Number(p.positionAmt) !== 0)
        .map(p => ({
          symbol: p.symbol,
          positionAmt: Number(p.positionAmt),
          entryPrice: Number(p.entryPrice),
          unrealizedProfit: Number(p.unrealizedProfit),
          leverage: Number(p.leverage),
        })),
    };
  }

  _safetyConfigSnapshot() {
    return {
      exchange: 'BINANCE',
      executionMode: this.executionMode,
      dryRun: this.dryRun,
      maxLeverageCap: this.maxLeverageCap,
      maxOrderUsdt: this.maxOrderUsdt,
      liveConfirmToken: this.liveConfirmToken,
      binance: {
        apiKey: this.apiKey,
        apiSecret: this.apiSecret,
      },
    };
  }

  async placePostOnlyEntry(params, { confirmToken, notionalUsdt } = {}) {
    const orderParams = buildBinancePostOnlyEntryOrder(params);
    const requestPath = '/fapi/v1/order';
    if (this.dryRun || this.executionMode !== 'LIVE_ARMED') {
      return { dryRun: true, exchange: 'BINANCE', method: 'POST', requestPath, params: orderParams };
    }
    assertLiveOrderSafety(this._safetyConfigSnapshot(), confirmToken, { orderNotionalUsdt: notionalUsdt });
    const data = await this._requestPrivate('POST', requestPath, orderParams);
    return { dryRun: false, exchange: 'BINANCE', data };
  }

  async placeReduceOnlySlTp(params, { confirmToken } = {}) {
    const orders = buildBinanceReduceOnlySlTpOrders(params);
    const requestPath = '/fapi/v1/order';
    if (this.dryRun || this.executionMode !== 'LIVE_ARMED') {
      return { dryRun: true, exchange: 'BINANCE', method: 'POST', requestPath, orders };
    }
    assertLiveOrderSafety(this._safetyConfigSnapshot(), confirmToken);
    const results = [];
    for (const orderParams of orders) {
      results.push(await this._requestPrivate('POST', requestPath, orderParams));
    }
    return { dryRun: false, exchange: 'BINANCE', data: results };
  }

  async cancelOrder({ symbol = 'BTCUSDT.P', orderId, origClientOrderId } = {}, { confirmToken } = {}) {
    const orderParams = { symbol: toBinanceSymbol(symbol) };
    if (orderId !== undefined) orderParams.orderId = orderId;
    if (origClientOrderId !== undefined) orderParams.origClientOrderId = origClientOrderId;
    const requestPath = '/fapi/v1/order';
    if (this.dryRun || this.executionMode !== 'LIVE_ARMED') {
      return { dryRun: true, exchange: 'BINANCE', method: 'DELETE', requestPath, params: orderParams };
    }
    assertLiveOrderSafety(this._safetyConfigSnapshot(), confirmToken);
    const data = await this._requestPrivate('DELETE', requestPath, orderParams);
    return { dryRun: false, exchange: 'BINANCE', data };
  }
}
