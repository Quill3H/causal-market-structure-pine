import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseBinanceFuturesKline,
  validateContiguousSeries,
  alignHtfCausal,
} from './fetch_5y_crypto_and_stocks.mjs';

const BINANCE_KLINES_ENDPOINT = 'https://fapi.binance.com/fapi/v1/klines';
const CRYPTO_5Y_START_SEC = 1637366400; // 2021-11-20T00:00:00Z
const BINANCE_KLINE_LIMIT = 1500;
const INTERVAL_15M_SEC = 900;
const HTF_1H_WARMUP_BARS = 300;
const CONCURRENT_RANGE_WORKERS = 4;
const REQUEST_SLEEP_MS = 180;

export const CRYPTO_5Y_15M_SPECS = Object.freeze([
  {
    symbol: 'BTCUSDT',
    okxSymbol: 'OKX:BTCUSDT.P',
    h1FileName: 'crypto5y_btcusdt_1h.json',
    outFileName: 'crypto5y_btcusdt_15m.json',
  },
  {
    symbol: 'ETHUSDT',
    okxSymbol: 'OKX:ETHUSDT.P',
    h1FileName: 'crypto5y_ethusdt_1h.json',
    outFileName: 'crypto5y_ethusdt_15m.json',
  },
  {
    symbol: 'SOLUSDT',
    okxSymbol: 'OKX:SOLUSDT.P',
    h1FileName: 'crypto5y_solusdt_1h.json',
    outFileName: 'crypto5y_solusdt_15m.json',
  },
  {
    symbol: 'BNBUSDT',
    okxSymbol: 'OKX:BNBUSDT.P',
    h1FileName: 'crypto5y_bnbusdt_1h.json',
    outFileName: 'crypto5y_bnbusdt_15m.json',
  },
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJsonWithRetry(url, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'TRADING-TOOL-Research/7.0' },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429 || res.status === 418 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 800 * Math.pow(1.6, attempt);
        await sleep(backoffMs);
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

async function fetchBinanceKlinesSlice({ symbol, interval, intervalSeconds, startSec, endSec, anchorEndMs }) {
  const rows = [];
  let cursorMs = startSec * 1000;
  const endMs = endSec * 1000;

  while (cursorMs <= endMs) {
    const params = new URLSearchParams({
      symbol,
      interval,
      startTime: String(cursorMs),
      endTime: String(Math.min(endMs, anchorEndMs)),
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
      if (k.closeTimeMs > anchorEndMs) continue;
      if (k.time < startSec || k.time > endSec) continue;
      rows.push({
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

    if (!Number.isFinite(lastOpenMs) || lastOpenMs < cursorMs) break;
    if (data.length < BINANCE_KLINE_LIMIT) break;
    cursorMs = lastOpenMs + intervalSeconds * 1000;
    await sleep(REQUEST_SLEEP_MS);
  }

  return rows;
}

async function fetchBinance15mParallel({ symbol, startSec, lastOpenSec, anchorEndMs }) {
  const totalBars = Math.floor((lastOpenSec - startSec) / INTERVAL_15M_SEC) + 1;
  const barsPerWorker = Math.ceil(totalBars / CONCURRENT_RANGE_WORKERS);
  const ranges = [];
  for (let w = 0; w < CONCURRENT_RANGE_WORKERS; w++) {
    const wStartSec = startSec + w * barsPerWorker * INTERVAL_15M_SEC;
    if (wStartSec > lastOpenSec) break;
    const wEndSec = Math.min(lastOpenSec, startSec + ((w + 1) * barsPerWorker - 1) * INTERVAL_15M_SEC);
    ranges.push({ startSec: wStartSec, endSec: wEndSec });
  }

  const chunks = await Promise.all(
    ranges.map(r => fetchBinanceKlinesSlice({
      symbol,
      interval: '15m',
      intervalSeconds: INTERVAL_15M_SEC,
      startSec: r.startSec,
      endSec: r.endSec,
      anchorEndMs,
    })),
  );

  const byTime = new Map();
  for (const chunk of chunks) {
    for (const row of chunk) {
      if (!byTime.has(row.time)) byTime.set(row.time, row);
    }
  }
  const rows = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  validateContiguousSeries(rows, INTERVAL_15M_SEC, `${symbol} 15m`);
  return rows;
}

export async function fetchAll5y15mCrypto({ force = false } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const summaries = [];

  for (const spec of CRYPTO_5Y_15M_SPECS) {
    const h1Path = path.join(DATA_DIR, spec.h1FileName);
    const outPath = path.join(DATA_DIR, spec.outFileName);
    assert.ok(fs.existsSync(h1Path), `Missing 1h reference dataset: ${h1Path}. Run fetch_5y_crypto_and_stocks.mjs first.`);

    let payload = null;
    if (!force && fs.existsSync(outPath)) {
      payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      validateContiguousSeries(payload.rows, INTERVAL_15M_SEC, `${spec.symbol} 15m`);
    } else {
      const h1Ds = JSON.parse(fs.readFileSync(h1Path, 'utf8'));
      const startSec = h1Ds.firstTime ?? CRYPTO_5Y_START_SEC;
      const anchorEndSec = h1Ds.lastTime + 3600;
      const anchorEndMs = anchorEndSec * 1000;
      const last15mOpenSec = anchorEndSec - INTERVAL_15M_SEC;

      console.log(`[fetch_5y_15m] Fetching ${spec.symbol} 15m (${startSec}..${last15mOpenSec}) + 1h warmup...`);
      const m15Rows = await fetchBinance15mParallel({
        symbol: spec.symbol,
        startSec,
        lastOpenSec: last15mOpenSec,
        anchorEndMs,
      });

      // Fetch 300 1h warmup bars prior to startSec so even m15Rows[0] has causal aligned 1h index >= 0
      const h1WarmupStartSec = startSec - HTF_1H_WARMUP_BARS * 3600;
      const h1Warmup = await fetchBinanceKlinesSlice({
        symbol: spec.symbol,
        interval: '1h',
        intervalSeconds: 3600,
        startSec: h1WarmupStartSec,
        endSec: startSec - 3600,
        anchorEndMs,
      });
      const h1ByTime = new Map();
      for (const r of [...h1Warmup, ...h1Ds.rows]) {
        if (!h1ByTime.has(r.time)) h1ByTime.set(r.time, r);
      }
      const h1Rows = Array.from(h1ByTime.values()).sort((a, b) => a.time - b.time);
      validateContiguousSeries(h1Rows, 3600, `${spec.symbol} 1h+warmup`);

      const h4Rows = h1Ds.htf['4h'].rows;
      const d1Rows = h1Ds.htf['1d'].rows;

      const h1Aligned = alignHtfCausal(m15Rows, h1Rows, 3600);
      const h4Aligned = alignHtfCausal(m15Rows, h4Rows, 14400);
      const d1Aligned = alignHtfCausal(m15Rows, d1Rows, 86400);

      payload = {
        symbol: spec.okxSymbol,
        instId: spec.symbol,
        interval: '15m',
        intervalSeconds: INTERVAL_15M_SEC,
        fetchedAt: new Date().toISOString(),
        source: BINANCE_KLINES_ENDPOINT,
        fundingSource: h1Ds.fundingSource,
        htfAlignmentRule: 'htfBar.time + htfIntervalSeconds <= ltfBar.time',
        firstTime: m15Rows[0].time,
        lastTime: m15Rows[m15Rows.length - 1].time,
        count: m15Rows.length,
        fundingCount: h1Ds.fundingRows.length,
        rows: m15Rows,
        fundingRows: h1Ds.fundingRows,
        htf: {
          '1h': { interval: '1h', intervalSeconds: 3600, rows: h1Rows, alignedIndex: h1Aligned },
          '4h': { interval: '4h', intervalSeconds: 14400, rows: h4Rows, alignedIndex: h4Aligned },
          '1d': { interval: '1d', intervalSeconds: 86400, rows: d1Rows, alignedIndex: d1Aligned },
        },
      };
      fs.writeFileSync(outPath, JSON.stringify(payload));
    }

    const info = {
      file: `data/${spec.outFileName}`,
      instId: payload.instId,
      count: payload.count,
      fundingCount: payload.fundingRows.length,
      firstIso: new Date(payload.firstTime * 1000).toISOString(),
      lastIso: new Date(payload.lastTime * 1000).toISOString(),
    };
    summaries.push(info);
    console.log(`[done] ${info.instId} 15m: bars=${info.count}, funding=${info.fundingCount}, ${info.firstIso} .. ${info.lastIso}`);
  }

  return summaries;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  fetchAll5y15mCrypto({ force }).catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
