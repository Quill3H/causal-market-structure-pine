import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BINANCE_KLINES_ENDPOINT = 'https://fapi.binance.com/fapi/v1/klines';
const BINANCE_FUNDING_ENDPOINT = 'https://fapi.binance.com/fapi/v1/fundingRate';
const YAHOO_CHART_ENDPOINT = 'https://query1.finance.yahoo.com/v8/finance/chart';

const CRYPTO_5Y_START_SEC = 1637366400; // 2021-11-20T00:00:00Z
const HTF_WARMUP_BARS = 300;
const BINANCE_KLINE_LIMIT = 1500;
const BINANCE_FUNDING_LIMIT = 1000;
const REQUEST_SLEEP_MS = 120;
const FUNDING_INTERVAL_SEC = 28800;
const FUNDING_INTERVAL_MS = FUNDING_INTERVAL_SEC * 1000;

export const CRYPTO_5Y_SPECS = Object.freeze([
  { symbol: 'BTCUSDT', okxSymbol: 'OKX:BTCUSDT.P', fileName: 'crypto5y_btcusdt_1h.json' },
  { symbol: 'ETHUSDT', okxSymbol: 'OKX:ETHUSDT.P', fileName: 'crypto5y_ethusdt_1h.json' },
  { symbol: 'SOLUSDT', okxSymbol: 'OKX:SOLUSDT.P', fileName: 'crypto5y_solusdt_1h.json' },
  { symbol: 'BNBUSDT', okxSymbol: 'OKX:BNBUSDT.P', fileName: 'crypto5y_bnbusdt_1h.json' },
]);

export const EQUITY_10Y_SPECS = Object.freeze([
  {
    key: 'sp500',
    fileName: 'equities10y_sp500_1d.json',
    tradeableSymbol: 'SPY',
    indexSymbol: '^GSPC',
    extraBenchmarks: [],
  },
  {
    key: 'dow',
    fileName: 'equities10y_dow_1d.json',
    tradeableSymbol: 'DIA',
    indexSymbol: '^DJI',
    extraBenchmarks: [],
  },
  {
    key: 'nasdaq',
    fileName: 'equities10y_nasdaq_1d.json',
    tradeableSymbol: 'QQQ',
    indexSymbol: '^IXIC',
    extraBenchmarks: ['^NDX'],
  },
]);

export const EQUITY_2Y_FUTURES_SPECS = Object.freeze([
  { symbol: 'ES=F', name: 'E-Mini S&P 500 Futures', fileName: 'equities2y_es_1h.json' },
  { symbol: 'YM=F', name: 'E-Mini Dow Futures', fileName: 'equities2y_ym_1h.json' },
  { symbol: 'NQ=F', name: 'E-Mini Nasdaq-100 Futures', fileName: 'equities2y_nq_1h.json' },
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const NY_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toNyDateStr(epochSec) {
  return NY_DATE_FMT.format(new Date(epochSec * 1000));
}

function isoWeekKeyNy(epochSec) {
  const dateStr = toNyDateStr(epochSec);
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

async function fetchJsonWithRetry(url, label, headers = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', ...headers },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} from ${label}`);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} from ${label}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`Failed fetching ${label}: ${lastError?.message ?? 'unknown error'}`);
}

export function parseBinanceFuturesKline(entry) {
  assert.ok(Array.isArray(entry) && entry.length >= 10, 'Malformed Binance futures kline');
  const openTimeMs = Number(entry[0]);
  const open = Number(entry[1]);
  const high = Number(entry[2]);
  const low = Number(entry[3]);
  const close = Number(entry[4]);
  const volume = Number(entry[5]);
  const closeTimeMs = Number(entry[6]);
  const trades = Number(entry[8]);
  const takerBuyVol = Number(entry[9]);

  assert.ok(Number.isSafeInteger(openTimeMs) && openTimeMs > 0 && openTimeMs % 1000 === 0,
    `Invalid openTimeMs: ${entry[0]}`);
  assert.ok(Number.isSafeInteger(closeTimeMs) && closeTimeMs > openTimeMs,
    `Invalid closeTimeMs: ${entry[6]}`);
  for (const [k, v] of [['open', open], ['high', high], ['low', low], ['close', close]]) {
    assert.ok(Number.isFinite(v) && v > 0, `Invalid OHLC ${k}: ${v}`);
  }
  assert.ok(low <= Math.min(open, close) && high >= Math.max(open, close) && low <= high,
    `Inconsistent OHLC at ${openTimeMs}`);
  assert.ok(Number.isFinite(volume) && volume >= 0, `Invalid volume: ${volume}`);
  assert.ok(Number.isFinite(trades) && trades >= 0, `Invalid trades: ${trades}`);
  assert.ok(Number.isFinite(takerBuyVol) && takerBuyVol >= 0, `Invalid takerBuyVol: ${takerBuyVol}`);

  return {
    time: openTimeMs / 1000,
    open,
    high,
    low,
    close,
    volume,
    takerBuyVol,
    trades,
    openTimeMs,
    closeTimeMs,
  };
}

export function validateContiguousSeries(rows, intervalSeconds, label) {
  assert.ok(Array.isArray(rows) && rows.length > 0, `${label}: empty rows`);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    assert.ok(Number.isSafeInteger(r.time) && r.time > 0, `${label}: bad time at ${i}`);
    if (i > 0) {
      assert.equal(r.time - rows[i - 1].time, intervalSeconds,
        `${label}: gap/dup at ${i} (${rows[i - 1].time} -> ${r.time})`);
    }
    assert.ok(r.low <= Math.min(r.open, r.close) && r.high >= Math.max(r.open, r.close),
      `${label}: bad OHLC at ${i}`);
  }
}

export function alignHtfCausal(ltfRows, htfRows, htfIntervalSeconds, { allowNegativeFirst = false } = {}) {
  assert.ok(Array.isArray(ltfRows) && Array.isArray(htfRows) && htfRows.length > 0);
  const aligned = new Array(ltfRows.length);
  let j = -1;
  for (let i = 0; i < ltfRows.length; i++) {
    const t = ltfRows[i].time;
    while (j + 1 < htfRows.length) {
      const closeTime = htfRows[j + 1].closeTime ?? (htfRows[j + 1].time + htfIntervalSeconds);
      if (closeTime <= t) j++;
      else break;
    }
    if (!allowNegativeFirst) {
      assert.ok(j >= 0, `Insufficient HTF warmup before bar ${i} (${t})`);
    }
    aligned[i] = j;
  }
  return aligned;
}

export function alignSeriesCausalByTime(targetBars, sourceBars, { sourceCloseOffsetSec = 0 } = {}) {
  assert.ok(Array.isArray(targetBars) && Array.isArray(sourceBars));
  const aligned = new Array(targetBars.length);
  let j = -1;
  for (let i = 0; i < targetBars.length; i++) {
    const t = targetBars[i].time;
    while (j + 1 < sourceBars.length && (sourceBars[j + 1].time + sourceCloseOffsetSec) <= t) {
      j++;
    }
    aligned[i] = j >= 0 ? sourceBars[j] : null;
  }
  return aligned;
}

async function fetchBinanceKlinesRange({ symbol, interval, intervalSeconds, startSec, anchorEndMs }) {
  const byTime = new Map();
  let cursorMs = startSec * 1000;

  while (cursorMs < anchorEndMs) {
    const params = new URLSearchParams({
      symbol,
      interval,
      startTime: String(cursorMs),
      endTime: String(anchorEndMs),
      limit: String(BINANCE_KLINE_LIMIT),
    });
    const url = `${BINANCE_KLINES_ENDPOINT}?${params.toString()}`;
    const data = await fetchJsonWithRetry(url, `Binance FAPI ${symbol} ${interval}`);
    assert.ok(Array.isArray(data), `Expected kline array for ${symbol} ${interval}`);
    if (data.length === 0) break;

    let lastOpenMs = -Infinity;
    for (const raw of data) {
      const k = parseBinanceFuturesKline(raw);
      if (k.openTimeMs > lastOpenMs) lastOpenMs = k.openTimeMs;
      if (k.closeTimeMs > anchorEndMs) continue; // strictly closed bars only
      if (!byTime.has(k.time)) {
        byTime.set(k.time, {
          time: k.time,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume,
          takerBuyVol: k.takerBuyVol,
          trades: k.trades,
        });
      }
    }

    if (!Number.isFinite(lastOpenMs) || lastOpenMs < cursorMs) break;
    if (data.length < BINANCE_KLINE_LIMIT) break;
    cursorMs = lastOpenMs + intervalSeconds * 1000;
    await sleep(REQUEST_SLEEP_MS);
  }

  const rows = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  validateContiguousSeries(rows, intervalSeconds, `${symbol} ${interval}`);
  return rows;
}

async function fetchBinanceFundingRange({ symbol, startSec, anchorEndMs }) {
  const byTime = new Map();
  let cursorMs = startSec * 1000;

  while (cursorMs <= anchorEndMs) {
    const params = new URLSearchParams({
      symbol,
      startTime: String(cursorMs),
      endTime: String(anchorEndMs),
      limit: String(BINANCE_FUNDING_LIMIT),
    });
    const url = `${BINANCE_FUNDING_ENDPOINT}?${params.toString()}`;
    const data = await fetchJsonWithRetry(url, `Binance Funding ${symbol}`);
    assert.ok(Array.isArray(data), `Expected funding array for ${symbol}`);
    if (data.length === 0) break;

    let lastRawMs = -Infinity;
    for (const entry of data) {
      const fundingTimeMs = Number(entry.fundingTime);
      const fundingRate = Number(entry.fundingRate);
      if (fundingTimeMs > lastRawMs) lastRawMs = fundingTimeMs;
      if (!Number.isFinite(fundingTimeMs) || !Number.isFinite(fundingRate)) continue;
      if (fundingTimeMs > anchorEndMs) continue;
      const time = Math.round(fundingTimeMs / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_SEC;
      assert.equal(time % FUNDING_INTERVAL_SEC, 0, `Non-8h funding timestamp ${fundingTimeMs}`);
      if (time < startSec) continue;
      if (!byTime.has(time)) {
        byTime.set(time, { time, fundingRate, realizedRate: fundingRate });
      }
    }

    if (!Number.isFinite(lastRawMs) || lastRawMs < cursorMs) break;
    if (data.length < BINANCE_FUNDING_LIMIT) break;
    cursorMs = lastRawMs + 1;
    await sleep(REQUEST_SLEEP_MS);
  }

  const rows = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].time - rows[i - 1].time, FUNDING_INTERVAL_SEC,
      `${symbol} funding gap at ${i} (${rows[i - 1].time} -> ${rows[i].time})`);
  }
  return rows;
}

export function cleanYahooChartSeries(payload, { intervalSeconds = 86400, requireOnHourGrid = false, cutoffSec = Infinity } = {}) {
  const result = payload?.chart?.result?.[0];
  assert.ok(result && Array.isArray(result.timestamp), 'Invalid Yahoo chart payload');
  const ts = result.timestamp;
  const quote = result.indicators?.quote?.[0] ?? {};
  const byTime = new Map();

  for (let i = 0; i < ts.length; i++) {
    const time = Number(ts[i]);
    if (!Number.isSafeInteger(time) || time <= 0) continue;
    if (requireOnHourGrid && time % 3600 !== 0) continue;
    if (time + intervalSeconds > cutoffSec) continue;

    const open = Number(quote.open?.[i]);
    const high = Number(quote.high?.[i]);
    const low = Number(quote.low?.[i]);
    const close = Number(quote.close?.[i]);
    const rawVol = quote.volume?.[i];
    const volume = rawVol == null ? 0 : Number(rawVol);

    if (![open, high, low, close].every(v => Number.isFinite(v) && v > 0)) continue;
    if (!Number.isFinite(volume) || volume < 0) continue;

    // Guard against minor Yahoo quote rounding anomalies where high < max(O,C) or low > min(O,C)
    const cleanHigh = Math.max(high, open, close);
    const cleanLow = Math.min(low, open, close);
    if (cleanLow <= 0 || cleanHigh < cleanLow) continue;

    byTime.set(time, {
      time,
      date: toNyDateStr(time),
      open,
      high: cleanHigh,
      low: cleanLow,
      close,
      volume,
    });
  }

  const rows = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  assert.ok(rows.length > 0, 'Cleaned Yahoo series is empty');
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].time > rows[i - 1].time, `Non-monotonic Yahoo timestamp at ${i}`);
  }
  return rows;
}

function buildWeeklyHtfFromDaily(dailyRows) {
  const weeks = [];
  let curWeek = null;
  for (const d of dailyRows) {
    const wk = isoWeekKeyNy(d.time);
    if (!curWeek || curWeek.weekKey !== wk) {
      if (curWeek) weeks.push(curWeek);
      curWeek = {
        weekKey: wk,
        time: d.time,
        date: d.date,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
        closeTime: d.time + 28800, // strictly closed after last daily session of that week
        barCount: 1,
      };
    } else {
      curWeek.high = Math.max(curWeek.high, d.high);
      curWeek.low = Math.min(curWeek.low, d.low);
      curWeek.close = d.close;
      curWeek.volume += d.volume;
      curWeek.closeTime = d.time + 28800;
      curWeek.barCount++;
    }
  }
  if (curWeek) weeks.push(curWeek);

  const alignedIndex = new Array(dailyRows.length);
  let j = -1;
  for (let i = 0; i < dailyRows.length; i++) {
    const t = dailyRows[i].time;
    while (j + 1 < weeks.length && weeks[j + 1].closeTime <= t) {
      j++;
    }
    alignedIndex[i] = j;
  }

  return {
    interval: '1wk',
    intervalSeconds: 604800,
    alignmentRule: 'htfWeek.closeTime <= dailyBar.time (-1 on first week)',
    rows: weeks,
    alignedIndex,
  };
}

async function fetchYahooSeries(symbol, range, interval, opts = {}) {
  const url = `${YAHOO_CHART_ENDPOINT}/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const payload = await fetchJsonWithRetry(url, `Yahoo ${symbol} ${interval} ${range}`);
  return cleanYahooChartSeries(payload, opts);
}

export async function fetchAll5yCryptoAndStocks({ force = false } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const anchorEndMs = Date.now();
  const anchorEndSec = Math.floor(anchorEndMs / 1000);
  const fetchedAt = new Date(anchorEndMs).toISOString();
  const todayNy = toNyDateStr(anchorEndSec);
  // For daily Yahoo equity/index bars: any bar whose NY date is strictly before todayNy is closed,
  // or if today's NY session already closed (>= 21:15 UTC).
  const nowUtcHour = new Date(anchorEndMs).getUTCHours() + new Date(anchorEndMs).getUTCMinutes() / 60;
  const dailyExcludeDates = nowUtcHour >= 21.25 ? new Set() : new Set([todayNy]);

  const summary = { crypto: [], equities10y: [], macro: null, equities2yFutures: [] };

  // 1. 4 Crypto Perps (5+ Years from 2021-11-20)
  for (const spec of CRYPTO_5Y_SPECS) {
    const outPath = path.join(DATA_DIR, spec.fileName);
    let payload = null;
    if (!force && fs.existsSync(outPath)) {
      payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } else {
      console.log(`[fetch_5y] Fetching ${spec.symbol} 1h/4h/1d + 8h funding from 2021-11-20...`);
      const h1Rows = await fetchBinanceKlinesRange({
        symbol: spec.symbol,
        interval: '1h',
        intervalSeconds: 3600,
        startSec: CRYPTO_5Y_START_SEC,
        anchorEndMs,
      });
      const h4Rows = await fetchBinanceKlinesRange({
        symbol: spec.symbol,
        interval: '4h',
        intervalSeconds: 14400,
        startSec: CRYPTO_5Y_START_SEC - HTF_WARMUP_BARS * 14400,
        anchorEndMs,
      });
      const d1Rows = await fetchBinanceKlinesRange({
        symbol: spec.symbol,
        interval: '1d',
        intervalSeconds: 86400,
        startSec: CRYPTO_5Y_START_SEC - HTF_WARMUP_BARS * 86400,
        anchorEndMs,
      });
      const fundingRows = await fetchBinanceFundingRange({
        symbol: spec.symbol,
        startSec: CRYPTO_5Y_START_SEC,
        anchorEndMs,
      });

      const h4Aligned = alignHtfCausal(h1Rows, h4Rows, 14400);
      const d1Aligned = alignHtfCausal(h1Rows, d1Rows, 86400);

      payload = {
        symbol: spec.okxSymbol,
        instId: spec.symbol,
        interval: '1h',
        intervalSeconds: 3600,
        fetchedAt,
        source: BINANCE_KLINES_ENDPOINT,
        fundingSource: BINANCE_FUNDING_ENDPOINT,
        htfAlignmentRule: 'htfBar.time + htfIntervalSeconds <= ltfBar.time',
        firstTime: h1Rows[0].time,
        lastTime: h1Rows[h1Rows.length - 1].time,
        count: h1Rows.length,
        fundingCount: fundingRows.length,
        rows: h1Rows,
        fundingRows,
        htf: {
          '4h': { interval: '4h', intervalSeconds: 14400, rows: h4Rows, alignedIndex: h4Aligned },
          '1d': { interval: '1d', intervalSeconds: 86400, rows: d1Rows, alignedIndex: d1Aligned },
        },
      };
      fs.writeFileSync(outPath, JSON.stringify(payload));
    }

    const item = {
      file: `data/${spec.fileName}`,
      instId: payload.instId,
      count: payload.count,
      fundingCount: payload.fundingRows.length,
      firstIso: new Date(payload.firstTime * 1000).toISOString(),
      lastIso: new Date(payload.lastTime * 1000).toISOString(),
    };
    summary.crypto.push(item);
    console.log(`[done] ${item.instId}: bars=${item.count}, funding=${item.fundingCount}, ${item.firstIso} .. ${item.lastIso}`);
  }

  // 2. Macro (^VIX, ^TNX 10Y)
  const macroPath = path.join(DATA_DIR, 'equities10y_macro_1d.json');
  let macroPayload = null;
  if (!force && fs.existsSync(macroPath)) {
    macroPayload = JSON.parse(fs.readFileSync(macroPath, 'utf8'));
  } else {
    console.log('[fetch_5y] Fetching 10y daily macro (^VIX, ^TNX)...');
    const vixRaw = await fetchYahooSeries('^VIX', '10y', '1d', { intervalSeconds: 0 });
    const tnxRaw = await fetchYahooSeries('^TNX', '10y', '1d', { intervalSeconds: 0 });
    const vixRows = vixRaw.filter(r => !dailyExcludeDates.has(r.date));
    const tnxRows = tnxRaw.filter(r => !dailyExcludeDates.has(r.date));
    macroPayload = {
      symbol: 'MACRO:VIX_TNX',
      interval: '1d',
      intervalSeconds: 86400,
      allowTimeGaps: true,
      fetchedAt,
      source: YAHOO_CHART_ENDPOINT,
      vixCount: vixRows.length,
      tnxCount: tnxRows.length,
      firstTime: Math.min(vixRows[0].time, tnxRows[0].time),
      lastTime: Math.max(vixRows[vixRows.length - 1].time, tnxRows[tnxRows.length - 1].time),
      vixRows,
      tnxRows,
      series: { '^VIX': vixRows, '^TNX': tnxRows },
    };
    fs.writeFileSync(macroPath, JSON.stringify(macroPayload));
  }
  summary.macro = {
    file: 'data/equities10y_macro_1d.json',
    vixCount: macroPayload.vixRows.length,
    tnxCount: macroPayload.tnxRows.length,
    vixSpan: `${macroPayload.vixRows[0].date} .. ${macroPayload.vixRows[macroPayload.vixRows.length - 1].date}`,
    tnxSpan: `${macroPayload.tnxRows[0].date} .. ${macroPayload.tnxRows[macroPayload.tnxRows.length - 1].date}`,
  };
  console.log(`[done] MACRO: VIX=${summary.macro.vixCount} (${summary.macro.vixSpan}), TNX=${summary.macro.tnxCount} (${summary.macro.tnxSpan})`);

  // 3. 3 US Stock Indices (10Y daily + 1wk HTF + causal macro alignment)
  for (const spec of EQUITY_10Y_SPECS) {
    const outPath = path.join(DATA_DIR, spec.fileName);
    let payload = null;
    if (!force && fs.existsSync(outPath)) {
      payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } else {
      console.log(`[fetch_5y] Fetching 10y daily ${spec.tradeableSymbol} + ${spec.indexSymbol}...`);
      const rows = (await fetchYahooSeries(spec.tradeableSymbol, '10y', '1d', { intervalSeconds: 0 }))
        .filter(r => !dailyExcludeDates.has(r.date));
      const indexRows = (await fetchYahooSeries(spec.indexSymbol, '10y', '1d', { intervalSeconds: 0 }))
        .filter(r => !dailyExcludeDates.has(r.date));

      const benchmarks = { [spec.indexSymbol]: indexRows };
      for (const extraSym of spec.extraBenchmarks) {
        benchmarks[extraSym] = (await fetchYahooSeries(extraSym, '10y', '1d', { intervalSeconds: 0 }))
          .filter(r => !dailyExcludeDates.has(r.date));
      }

      const htf1wk = buildWeeklyHtfFromDaily(rows);
      const vixAligned = alignSeriesCausalByTime(rows, macroPayload.vixRows);
      const tnxAligned = alignSeriesCausalByTime(rows, macroPayload.tnxRows);

      payload = {
        key: spec.key,
        symbol: spec.tradeableSymbol,
        indexSymbol: spec.indexSymbol,
        interval: '1d',
        intervalSeconds: 86400,
        allowTimeGaps: true,
        fetchedAt,
        source: YAHOO_CHART_ENDPOINT,
        firstTime: rows[0].time,
        lastTime: rows[rows.length - 1].time,
        firstDate: rows[0].date,
        lastDate: rows[rows.length - 1].date,
        count: rows.length,
        indexCount: indexRows.length,
        rows,
        indexRows,
        benchmarks,
        htf: { '1wk': htf1wk },
        macroAligned: {
          alignmentRule: 'macroBar.time <= dailyBar.time',
          vix: vixAligned,
          tnx: tnxAligned,
        },
      };
      fs.writeFileSync(outPath, JSON.stringify(payload));
    }

    const item = {
      file: `data/${spec.fileName}`,
      symbol: payload.symbol,
      indexSymbol: payload.indexSymbol,
      count: payload.count,
      indexCount: payload.indexRows.length,
      wkCount: payload.htf['1wk'].rows.length,
      span: `${payload.firstDate} .. ${payload.lastDate}`,
    };
    summary.equities10y.push(item);
    console.log(`[done] ${item.symbol}/${item.indexSymbol}: bars=${item.count}, 1wk=${item.wkCount}, span=${item.span}`);
  }

  // 4. 2Y Intraday US Index Futures (1h + causal 1d HTF)
  for (const spec of EQUITY_2Y_FUTURES_SPECS) {
    const outPath = path.join(DATA_DIR, spec.fileName);
    let payload = null;
    if (!force && fs.existsSync(outPath)) {
      payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } else {
      console.log(`[fetch_5y] Fetching 2y 1h + 3y 1d for ${spec.symbol}...`);
      const h1Rows = await fetchYahooSeries(spec.symbol, '730d', '1h', {
        intervalSeconds: 3600,
        requireOnHourGrid: true,
        cutoffSec: anchorEndSec,
      });
      const d1Rows = (await fetchYahooSeries(spec.symbol, '3y', '1d', { intervalSeconds: 0 }))
        .filter(r => !dailyExcludeDates.has(r.date))
        .map(r => ({ ...r, closeTime: r.time + 86400 }));
      const d1Aligned = alignHtfCausal(h1Rows, d1Rows, 86400, { allowNegativeFirst: true });

      payload = {
        symbol: spec.symbol,
        name: spec.name,
        interval: '1h',
        intervalSeconds: 3600,
        allowTimeGaps: true,
        fetchedAt,
        source: YAHOO_CHART_ENDPOINT,
        htfAlignmentRule: 'd1Bar.time + 86400 <= h1Bar.time',
        firstTime: h1Rows[0].time,
        lastTime: h1Rows[h1Rows.length - 1].time,
        count: h1Rows.length,
        rows: h1Rows,
        htf: {
          '1d': { interval: '1d', intervalSeconds: 86400, rows: d1Rows, alignedIndex: d1Aligned },
        },
      };
      fs.writeFileSync(outPath, JSON.stringify(payload));
    }

    const item = {
      file: `data/${spec.fileName}`,
      symbol: payload.symbol,
      count: payload.count,
      d1Count: payload.htf['1d'].rows.length,
      firstIso: new Date(payload.firstTime * 1000).toISOString(),
      lastIso: new Date(payload.lastTime * 1000).toISOString(),
    };
    summary.equities2yFutures.push(item);
    console.log(`[done] ${item.symbol}: 1h=${item.count}, 1d=${item.d1Count}, ${item.firstIso} .. ${item.lastIso}`);
  }

  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  fetchAll5yCryptoAndStocks({ force }).catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
