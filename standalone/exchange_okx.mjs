import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { assertLiveOrderSafety } from './config.mjs';

export const OKX_BASE_URL = 'https://www.okx.com';
export const SUPPORTED_OKX_PERPS = Object.freeze([
  'BTC-USDT-SWAP',
  'ETH-USDT-SWAP',
  'SOL-USDT-SWAP',
  'BNB-USDT-SWAP',
]);

const BAR_MAP = Object.freeze({
  '1m': { okxBar: '1m', intervalSeconds: 60 },
  '5m': { okxBar: '5m', intervalSeconds: 300 },
  '15m': { okxBar: '15m', intervalSeconds: 900 },
  '1h': { okxBar: '1H', intervalSeconds: 3600 },
  '4h': { okxBar: '4H', intervalSeconds: 14400 },
  '1d': { okxBar: '1Dutc', intervalSeconds: 86400 },
});

export function toOkxInstId(symbol) {
  const s = String(symbol || 'BTCUSDT.P').trim().toUpperCase();
  if (s.includes('-')) return s;
  if (s === 'BTC') return 'BTC-USDT-SWAP';
  if (s === 'ETH') return 'ETH-USDT-SWAP';
  if (s === 'SOL') return 'SOL-USDT-SWAP';
  if (s === 'BNB') return 'BNB-USDT-SWAP';
  if (s.endsWith('.P')) {
    const base = s.slice(0, -2);
    if (base.endsWith('USDT')) return `${base.slice(0, -4)}-USDT-SWAP`;
    if (base.endsWith('USDC')) return `${base.slice(0, -4)}-USDC-SWAP`;
  }
  if (s.endsWith('USDT')) return `${s.slice(0, -4)}-USDT`;
  if (s.endsWith('USDC')) return `${s.slice(0, -4)}-USDC`;
  return s;
}

export function toOkxBarSpec(timeframe) {
  const tf = String(timeframe || '1h').trim().toLowerCase();
  const spec = BAR_MAP[tf];
  if (!spec) throw new Error(`Unsupported OKX timeframe: ${timeframe}`);
  return spec;
}

export function parseOkxCandleRow(entry, { isSwap, intervalSeconds }) {
  assert.ok(Array.isArray(entry) && entry.length >= 9, 'Malformed OKX candle entry');
  const openTimeMs = Number(entry[0]);
  const open = Number(entry[1]);
  const high = Number(entry[2]);
  const low = Number(entry[3]);
  const close = Number(entry[4]);
  const volume = Number(isSwap ? entry[6] : entry[5]);
  const confirm = String(entry[8]);
  assert.ok(Number.isSafeInteger(openTimeMs) && openTimeMs > 0, `Invalid OKX candle ts: ${entry[0]}`);
  assert.ok([open, high, low, close].every(v => Number.isFinite(v) && v > 0), 'Invalid OKX OHLC');
  assert.ok(Number.isFinite(volume) && volume >= 0, 'Invalid OKX volume');

  return {
    time: Math.floor(openTimeMs / 1000),
    open,
    high,
    low,
    close,
    volume,
    closed: confirm === '1',
    closeTimeMs: openTimeMs + intervalSeconds * 1000,
  };
}

/**
 * Computes exact OKX V5 HMAC-SHA256 request signature:
 * prehash = timestamp + method.toUpperCase() + requestPath + body
 * sign = Base64(HMAC-SHA256(apiSecret, prehash))
 */
export function signOkxRequest({
  method = 'GET',
  requestPath,
  body = '',
  timestamp = new Date().toISOString(),
  apiKey,
  apiSecret,
  passphrase,
  simulated = false,
}) {
  assert.ok(apiKey && apiSecret && passphrase, 'OKX API credentials incomplete');
  const upperMethod = String(method).toUpperCase();
  const bodyStr = typeof body === 'string' ? body : body ? JSON.stringify(body) : '';
  const prehash = `${timestamp}${upperMethod}${requestPath}${bodyStr}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(prehash).digest('base64');

  const headers = {
    'OK-ACCESS-KEY': apiKey,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': passphrase,
    'Content-Type': 'application/json',
  };
  if (simulated) {
    headers['x-simulated-trading'] = '1';
  }
  return { timestamp, prehash, signature, headers };
}

export function buildPostOnlyEntryOrder({
  symbol = 'BTCUSDT.P',
  side,
  sz,
  px,
  tdMode = 'isolated',
  posSide,
  clOrdId,
  attachAlgoOrds,
  slTriggerPx,
  tpTriggerPx,
  attachAlgoClOrdId,
}) {
  const instId = toOkxInstId(symbol);
  const sideStr = side === 1 || String(side).toLowerCase() === 'buy' ? 'buy' : 'sell';
  const payload = {
    instId,
    tdMode,
    side: sideStr,
    ordType: 'post_only',
    px: String(px),
    sz: String(sz),
  };
  if (posSide) payload.posSide = posSide;
  if (clOrdId) payload.clOrdId = clOrdId;

  if (Array.isArray(attachAlgoOrds) && attachAlgoOrds.length > 0) {
    payload.attachAlgoOrds = attachAlgoOrds;
  } else {
    const hasSl = slTriggerPx !== undefined && slTriggerPx !== null && Number.isFinite(Number(slTriggerPx)) && Number(slTriggerPx) > 0;
    const hasTp = tpTriggerPx !== undefined && tpTriggerPx !== null && Number.isFinite(Number(tpTriggerPx)) && Number(tpTriggerPx) > 0;
    if (hasSl || hasTp) {
      const algoObj = {};
      if (typeof attachAlgoClOrdId === 'string' && attachAlgoClOrdId.length > 0) {
        algoObj.attachAlgoClOrdId = attachAlgoClOrdId;
      }
      if (hasSl) {
        algoObj.slTriggerPx = String(slTriggerPx);
        algoObj.slTriggerPxType = 'mark';
        algoObj.slOrdPx = '-1';
      }
      if (hasTp) {
        algoObj.tpTriggerPx = String(tpTriggerPx);
        algoObj.tpTriggerPxType = 'last';
        algoObj.tpOrdPx = '-1';
      }
      payload.attachAlgoOrds = [algoObj];
    }
  }
  return payload;
}

export function buildReduceOnlySlTpOrders({
  symbol = 'BTCUSDT.P',
  entrySide,
  sz,
  slTriggerPx,
  tpTriggerPx,
  tdMode = 'isolated',
  posSide,
  algoClOrdId,
}) {
  const instId = toOkxInstId(symbol);
  const closeSide = entrySide === 1 || String(entrySide).toLowerCase() === 'buy' ? 'sell' : 'buy';
  const base = {
    instId,
    tdMode,
    side: closeSide,
    ordType: 'oco',
    sz: String(sz),
    reduceOnly: true,
  };
  if (posSide) base.posSide = posSide;
  if (typeof algoClOrdId === 'string' && algoClOrdId.length > 0) base.algoClOrdId = algoClOrdId;
  if (slTriggerPx !== undefined && slTriggerPx !== null) {
    base.slTriggerPx = String(slTriggerPx);
    base.slTriggerPxType = 'mark';
    base.slOrdPx = '-1';
  }
  if (tpTriggerPx !== undefined && tpTriggerPx !== null) {
    base.tpTriggerPx = String(tpTriggerPx);
    base.tpTriggerPxType = 'last';
    base.tpOrdPx = '-1';
  }
  if (base.slTriggerPx && !base.tpTriggerPx) {
    base.ordType = 'conditional';
  } else if (!base.slTriggerPx && base.tpTriggerPx) {
    base.ordType = 'conditional';
  }
  return base;
}

export class OkxClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || OKX_BASE_URL;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.apiKey = options.apiKey || '';
    this.apiSecret = options.apiSecret || '';
    this.passphrase = options.passphrase || '';
    this.simulated = Boolean(options.simulated ?? true);
    this.dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : true;
    this.executionMode = options.executionMode || 'PAPER';
    this.liveConfirmToken = options.liveConfirmToken || '';
    this.maxLeverageCap = Number(options.maxLeverageCap ?? 3.0);
    this.maxOrderUsdt = Number(options.maxOrderUsdt ?? 500);
    this.supportsAttachAlgoOrds = true;
  }

  hasCredentials() {
    return Boolean(this.apiKey && this.apiSecret && this.passphrase);
  }

  async _requestPublic(requestPath) {
    const res = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
      headers: { 'User-Agent': 'TRADING-TOOL-Standalone/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`OKX HTTP ${res.status} on ${requestPath}`);
    }
    const payload = await res.json();
    if (payload?.code !== '0') {
      throw new Error(`OKX API error ${payload?.code}: ${payload?.msg || 'unknown'}`);
    }
    return payload.data;
  }

  async _requestPrivate(method, requestPath, body = '') {
    if (!this.hasCredentials()) {
      throw new Error('OKX API credentials are not configured');
    }
    const bodyStr = typeof body === 'string' ? body : body ? JSON.stringify(body) : '';
    const { headers } = signOkxRequest({
      method,
      requestPath,
      body: bodyStr,
      apiKey: this.apiKey,
      apiSecret: this.apiSecret,
      passphrase: this.passphrase,
      simulated: this.simulated,
    });
    const res = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
      method: method.toUpperCase(),
      headers,
      body: bodyStr || undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`OKX private HTTP ${res.status} on ${requestPath}`);
    }
    const payload = await res.json();
    if (payload?.code !== '0') {
      throw new Error(`OKX private error ${payload?.code}: ${payload?.msg || 'unknown'}`);
    }
    return payload.data;
  }

  async getClosedCandles({ symbol = 'BTCUSDT.P', timeframe = '1h', limit = 300, afterMs, history = false } = {}) {
    const instId = toOkxInstId(symbol);
    const isSwap = instId.endsWith('-SWAP');
    const { okxBar, intervalSeconds } = toOkxBarSpec(timeframe);
    const params = new URLSearchParams({
      instId,
      bar: okxBar,
      limit: String(Math.min(300, Math.max(1, limit))),
    });
    if (afterMs !== undefined) params.set('after', String(afterMs));
    const endpoint = history ? '/api/v5/market/history-candles' : '/api/v5/market/candles';
    const data = await this._requestPublic(`${endpoint}?${params.toString()}`);
    const nowMs = Date.now();
    const rows = [];
    for (const raw of data) {
      const parsed = parseOkxCandleRow(raw, { isSwap, intervalSeconds });
      if (!parsed.closed || parsed.closeTimeMs > nowMs) continue;
      rows.push({
        time: parsed.time,
        open: parsed.open,
        high: parsed.high,
        low: parsed.low,
        close: parsed.close,
        volume: parsed.volume,
      });
    }
    rows.sort((a, b) => a.time - b.time);
    return rows;
  }

  async getFundingRates({ symbol = 'BTCUSDT.P', limit = 100, afterMs } = {}) {
    const instId = toOkxInstId(symbol);
    const params = new URLSearchParams({ instId, limit: String(Math.min(100, Math.max(1, limit))) });
    if (afterMs !== undefined) params.set('after', String(afterMs));
    const data = await this._requestPublic(`/api/v5/public/funding-rate-history?${params.toString()}`);
    return data
      .map(d => ({
        time: Math.floor(Number(d.fundingTime) / 1000),
        fundingRate: Number(d.fundingRate),
        realizedRate: Number(d.realizedRate ?? d.fundingRate),
      }))
      .filter(d => Number.isSafeInteger(d.time) && Number.isFinite(d.fundingRate))
      .sort((a, b) => a.time - b.time);
  }

  async getCurrentFundingRate(symbol = 'BTCUSDT.P') {
    const instId = toOkxInstId(symbol);
    const data = await this._requestPublic(`/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`);
    const row = data[0] || {};
    return {
      instId,
      fundingRate: Number(row.fundingRate ?? 0),
      nextFundingRate: Number(row.nextFundingRate ?? 0),
      fundingTimeMs: Number(row.fundingTime ?? 0),
      nextFundingTimeMs: Number(row.nextFundingTime ?? 0),
    };
  }

  async getMarkPrice(symbol = 'BTCUSDT.P') {
    const instId = toOkxInstId(symbol);
    const instType = instId.endsWith('-SWAP') ? 'SWAP' : 'SPOT';
    const data = await this._requestPublic(
      `/api/v5/public/mark-price?instType=${instType}&instId=${encodeURIComponent(instId)}`,
    );
    const row = data[0] || {};
    return { instId, markPx: Number(row.markPx), ts: Number(row.ts) };
  }

  async getOpenInterest(symbol = 'BTCUSDT.P') {
    const instId = toOkxInstId(symbol);
    const instType = instId.endsWith('-SWAP') ? 'SWAP' : 'SPOT';
    const data = await this._requestPublic(
      `/api/v5/public/open-interest?instType=${instType}&instId=${encodeURIComponent(instId)}`,
    );
    const row = data[0] || {};
    return { instId, oi: Number(row.oi), oiCcy: Number(row.oiCcy), ts: Number(row.ts) };
  }

  async getOrderbookTicker(symbol = 'BTCUSDT.P') {
    const instId = toOkxInstId(symbol);
    const data = await this._requestPublic(`/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
    const row = data[0] || {};
    return {
      instId,
      bidPx: Number(row.bidPx),
      bidSz: Number(row.bidSz),
      askPx: Number(row.askPx),
      askSz: Number(row.askSz),
      last: Number(row.last),
      ts: Number(row.ts),
    };
  }

  async getAccountHealth() {
    if (!this.hasCredentials()) {
      return {
        exchange: 'OKX',
        configured: false,
        connected: false,
        simulated: this.simulated,
        reason: 'No OKX API keys configured (public-market + PAPER mode active)',
      };
    }
    const [balData, posData] = await Promise.all([
      this._requestPrivate('GET', '/api/v5/account/balance'),
      this._requestPrivate('GET', '/api/v5/account/positions?instType=SWAP'),
    ]);
    const bal = balData[0] || {};
    const usdtDetail = (bal.details || []).find(d => d.ccy === 'USDT') || {};
    return {
      exchange: 'OKX',
      configured: true,
      connected: true,
      simulated: this.simulated,
      totalEqUsdt: Number(bal.totalEq ?? 0),
      availEqUsdt: Number(usdtDetail.availEq ?? bal.availEq ?? 0),
      openPositions: (posData || [])
        .filter(p => Number(p.pos) !== 0)
        .map(p => ({
          instId: p.instId,
          posSide: p.posSide,
          pos: Number(p.pos),
          avgPx: Number(p.avgPx),
          markPx: Number(p.markPx),
          upl: Number(p.upl),
          lever: Number(p.lever),
        })),
    };
  }

  async getApiKeyPermissions() {
    const data = await this._requestPrivate('GET', '/api/v5/account/config');
    const row = Array.isArray(data) ? (data[0] || {}) : (data || {});
    return {
      perm: String(row.perm || ''),
      acctLv: row.acctLv ?? null,
      label: row.label ?? null,
    };
  }

  async getPendingAlgoOrders({ instType = 'SWAP', ordType = 'oco,conditional', symbol } = {}) {
    const params = new URLSearchParams({
      instType: String(instType || 'SWAP'),
      ordType: String(ordType || 'oco,conditional'),
    });
    if (symbol) params.set('instId', toOkxInstId(symbol));
    const data = await this._requestPrivate('GET', `/api/v5/trade/orders-algo-pending?${params.toString()}`);
    return Array.isArray(data) ? data : [];
  }

  _safetyConfigSnapshot() {
    return {
      exchange: 'OKX',
      executionMode: this.executionMode,
      dryRun: this.dryRun,
      maxLeverageCap: this.maxLeverageCap,
      maxOrderUsdt: this.maxOrderUsdt,
      liveConfirmToken: this.liveConfirmToken,
      okx: {
        apiKey: this.apiKey,
        apiSecret: this.apiSecret,
        passphrase: this.passphrase,
      },
    };
  }

  async placePostOnlyEntry(params, { confirmToken, notionalUsdt } = {}) {
    const body = buildPostOnlyEntryOrder(params);
    const requestPath = '/api/v5/trade/order';
    if (this.dryRun || this.executionMode !== 'LIVE_ARMED') {
      return { dryRun: true, exchange: 'OKX', method: 'POST', requestPath, body };
    }
    assertLiveOrderSafety(this._safetyConfigSnapshot(), confirmToken, { orderNotionalUsdt: notionalUsdt });
    const data = await this._requestPrivate('POST', requestPath, body);
    return { dryRun: false, exchange: 'OKX', data };
  }

  async placeReduceOnlySlTp(params, { confirmToken } = {}) {
    const body = buildReduceOnlySlTpOrders(params);
    const requestPath = '/api/v5/trade/order-algo';
    if (this.dryRun || this.executionMode !== 'LIVE_ARMED') {
      return { dryRun: true, exchange: 'OKX', method: 'POST', requestPath, body };
    }
    assertLiveOrderSafety(this._safetyConfigSnapshot(), confirmToken);
    const data = await this._requestPrivate('POST', requestPath, body);
    return { dryRun: false, exchange: 'OKX', data };
  }

  async cancelOrder({ symbol = 'BTCUSDT.P', ordId, clOrdId } = {}, { confirmToken } = {}) {
    const body = { instId: toOkxInstId(symbol) };
    if (ordId) body.ordId = ordId;
    if (clOrdId) body.clOrdId = clOrdId;
    const requestPath = '/api/v5/trade/cancel-order';
    if (this.dryRun || this.executionMode !== 'LIVE_ARMED') {
      return { dryRun: true, exchange: 'OKX', method: 'POST', requestPath, body };
    }
    assertLiveOrderSafety(this._safetyConfigSnapshot(), confirmToken);
    const data = await this._requestPrivate('POST', requestPath, body);
    return { dryRun: false, exchange: 'OKX', data };
  }
}
