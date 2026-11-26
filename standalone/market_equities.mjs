import assert from 'node:assert/strict';

export const YAHOO_CHART_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

export const EQUITY_INSTRUMENTS = Object.freeze({
  SPY: {
    key: 'SPY',
    label: 'S&P 500 (SPY)',
    tradeSymbol: 'SPY',
    indexSymbol: '^GSPC',
    futuresSymbol: 'ES=F',
    dataset10y: 'equities10y_sp500_1d.json',
    dataset2y1h: 'equities2y_es_1h.json',
    defaultTimeframe: '1d',
    assetClass: 'EQUITY_ETF',
  },
  DIA: {
    key: 'DIA',
    label: 'Dow Jones (DIA)',
    tradeSymbol: 'DIA',
    indexSymbol: '^DJI',
    futuresSymbol: 'YM=F',
    dataset10y: 'equities10y_dow_1d.json',
    dataset2y1h: 'equities2y_ym_1h.json',
    defaultTimeframe: '1d',
    assetClass: 'EQUITY_ETF',
  },
  QQQ: {
    key: 'QQQ',
    label: 'Nasdaq 100 (QQQ)',
    tradeSymbol: 'QQQ',
    indexSymbol: '^NDX',
    futuresSymbol: 'NQ=F',
    dataset10y: 'equities10y_nasdaq_1d.json',
    dataset2y1h: 'equities2y_nq_1h.json',
    defaultTimeframe: '1d',
    assetClass: 'EQUITY_ETF',
  },
});

export const MACRO_SYMBOLS = Object.freeze({
  VIX: '^VIX',
  TNX: '^TNX',
});

const ALIAS_MAP = Object.freeze({
  SPY: 'SPY',
  SP500: 'SPY',
  'S&P 500': 'SPY',
  '^GSPC': 'SPY',
  'ES=F': 'SPY',
  DIA: 'DIA',
  DOW: 'DIA',
  'DOW JONES': 'DIA',
  '^DJI': 'DIA',
  'YM=F': 'DIA',
  QQQ: 'QQQ',
  NASDAQ: 'QQQ',
  '^NDX': 'QQQ',
  '^IXIC': 'QQQ',
  'NQ=F': 'QQQ',
});

export function isEquitySymbol(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  return Boolean(ALIAS_MAP[s]);
}

export function resolveEquityInstrument(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  const key = ALIAS_MAP[s];
  if (!key) return null;
  return EQUITY_INSTRUMENTS[key];
}

export function resolveYahooTicker(symbol, { preferFutures = false } = {}) {
  const s = String(symbol || '').trim();
  const upper = s.toUpperCase();
  if (upper === '^VIX' || upper === 'VIX') return '^VIX';
  if (upper === '^TNX' || upper === 'TNX') return '^TNX';
  if (upper === '^GSPC' || upper === '^DJI' || upper === '^NDX' || upper === '^IXIC') return upper;
  if (upper.endsWith('=F')) return upper;
  const inst = resolveEquityInstrument(upper);
  if (inst) return preferFutures ? inst.futuresSymbol : inst.tradeSymbol;
  return upper;
}

export function intervalSecondsForYahoo(interval) {
  const tf = String(interval || '1d').toLowerCase();
  if (tf === '1d') return 86400;
  if (tf === '1wk' || tf === '1w') return 604800;
  if (tf === '1h') return 3600;
  if (tf === '15m') return 900;
  throw new Error(`Unsupported Yahoo Finance interval: ${interval}`);
}

/**
 * Parses Yahoo Finance v8 chart JSON into clean, deduplicated, monotonic OHLCV rows.
 */
export function parseYahooChartResponse(payload, { interval = '1d', closedOnly = true, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const result = payload?.chart?.result?.[0];
  assert.ok(result && Array.isArray(result.timestamp), 'Malformed Yahoo Finance chart payload');
  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0] || {};
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];
  const adjCloses = result.indicators?.adjclose?.[0]?.adjclose || null;
  const intervalSec = intervalSecondsForYahoo(interval);

  const byTime = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const rawTs = Number(timestamps[i]);
    if (!Number.isFinite(rawTs) || rawTs <= 0) continue;
    const t = interval === '1d' ? Math.floor(rawTs / 86400) * 86400 : Math.floor(rawTs);
    if (closedOnly && interval === '1h' && t + intervalSec > nowSec) continue;

    const o = Number(opens[i]);
    const h = Number(highs[i]);
    const l = Number(lows[i]);
    const c = Number(closes[i]);
    const v = Number(volumes[i] ?? 0);

    if (![o, h, l, c].every(x => Number.isFinite(x) && x > 0)) continue;

    const fixedHigh = Math.max(h, o, c);
    const fixedLow = Math.min(l, o, c);
    const row = {
      time: t,
      open: o,
      high: fixedHigh,
      low: fixedLow,
      close: c,
      volume: Number.isFinite(v) && v >= 0 ? v : 0,
    };
    if (adjCloses && Number.isFinite(Number(adjCloses[i]))) {
      row.adjClose = Number(adjCloses[i]);
    }
    byTime.set(t, row);
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export class YahooEquitiesClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || YAHOO_CHART_BASE_URL;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.maxRetries = Number(options.maxRetries ?? 3);
  }

  async _fetchChart(ticker, { interval = '1d', range = '2y' } = {}) {
    const yahooInterval = interval === '1w' ? '1wk' : interval;
    const url = `${this.baseUrl}/${encodeURIComponent(ticker)}?interval=${encodeURIComponent(yahooInterval)}&range=${encodeURIComponent(range)}`;
    let lastError = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TRADING-TOOL-Standalone/6.0)',
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`Yahoo HTTP ${res.status} for ${ticker}`);
        }
        if (!res.ok) {
          throw new Error(`Yahoo HTTP ${res.status} for ${ticker}`);
        }
        const payload = await res.json();
        if (payload?.chart?.error) {
          throw new Error(`Yahoo error for ${ticker}: ${payload.chart.error.description || payload.chart.error.code}`);
        }
        return payload;
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries - 1) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }
    throw new Error(`Failed fetching Yahoo chart ${ticker}: ${lastError?.message || 'unknown'}`);
  }

  async getClosedCandles({ symbol = 'SPY', timeframe = '1d', range } = {}) {
    const tf = String(timeframe || '1d').toLowerCase();
    const ticker = resolveYahooTicker(symbol, { preferFutures: tf === '1h' });
    const effRange = range || (tf === '1h' ? '90d' : '2y');
    const payload = await this._fetchChart(ticker, { interval: tf, range: effRange });
    const rows = parseYahooChartResponse(payload, { interval: tf, closedOnly: true });
    return rows;
  }

  async getMacroSnapshot({ range = '3mo' } = {}) {
    const [vixPayload, tnxPayload] = await Promise.all([
      this._fetchChart('^VIX', { interval: '1d', range }),
      this._fetchChart('^TNX', { interval: '1d', range }),
    ]);
    const vixRows = parseYahooChartResponse(vixPayload, { interval: '1d', closedOnly: false });
    const tnxRows = parseYahooChartResponse(tnxPayload, { interval: '1d', closedOnly: false });
    const latestVix = vixRows.length ? vixRows[vixRows.length - 1] : null;
    const latestTnx = tnxRows.length ? tnxRows[tnxRows.length - 1] : null;
    return {
      vix: latestVix ? latestVix.close : null,
      vixTime: latestVix ? latestVix.time : null,
      tnx: latestTnx ? latestTnx.close : null,
      tnxTime: latestTnx ? latestTnx.time : null,
      vixRows,
      tnxRows,
    };
  }
}
