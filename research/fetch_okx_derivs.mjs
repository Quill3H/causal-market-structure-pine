import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OKX_FUNDING_HISTORY_ENDPOINT = 'https://www.okx.com/api/v5/public/funding-rate-history';
const BINANCE_FUNDING_RATE_ENDPOINT = 'https://fapi.binance.com/fapi/v1/fundingRate';
const OKX_BATCH_LIMIT = 100;
const BINANCE_BATCH_LIMIT = 1000;
const REQUEST_SLEEP_MS = 120;
const FUNDING_INTERVAL_SECONDS = 28800; // 8h UTC
const FUNDING_INTERVAL_MS = FUNDING_INTERVAL_SECONDS * 1000;
const DEFAULT_FIRST_TIME_SEC = 1700690400;
const DEFAULT_LAST_TIME_SEC = 1795294800;

export const FUNDING_INSTRUMENTS = Object.freeze([
  {
    instId: 'BTC-USDT-SWAP',
    binanceSymbol: 'BTCUSDT',
    symbol: 'OKX:BTCUSDT.P',
    fileName: 'okx_btcusdt_swap_funding_3y.json',
    refCandleFile: 'okx_btcusdt_swap_1h_3y.json',
  },
  {
    instId: 'ETH-USDT-SWAP',
    binanceSymbol: 'ETHUSDT',
    symbol: 'OKX:ETHUSDT.P',
    fileName: 'okx_ethusdt_swap_funding_3y.json',
    refCandleFile: 'okx_ethusdt_swap_1h_3y.json',
  },
  {
    instId: 'SOL-USDT-SWAP',
    binanceSymbol: 'SOLUSDT',
    symbol: 'OKX:SOLUSDT.P',
    fileName: 'okx_solusdt_swap_funding_3y.json',
    refCandleFile: 'okx_solusdt_swap_1h_3y.json',
  },
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseOkxFundingRow(entry) {
  assert.ok(entry && typeof entry === 'object', 'Malformed OKX funding entry');
  const fundingTimeMs = Number(entry.fundingTime);
  const fundingRate = Number(entry.fundingRate);
  const rawRealized = entry.realizedRate === undefined || entry.realizedRate === ''
    ? entry.fundingRate
    : entry.realizedRate;
  const realizedRate = Number(rawRealized);

  assert.ok(
    Number.isSafeInteger(fundingTimeMs) && fundingTimeMs > 0 && fundingTimeMs % 1000 === 0,
    `Invalid OKX fundingTime: ${entry.fundingTime}`,
  );
  assert.ok(Number.isFinite(fundingRate), `Invalid OKX fundingRate: ${entry.fundingRate}`);
  assert.ok(Number.isFinite(realizedRate), `Invalid OKX realizedRate: ${entry.realizedRate}`);

  const time = fundingTimeMs / 1000;
  return {
    time,
    fundingRate,
    realizedRate,
  };
}

export function parseBinanceFundingRow(entry) {
  assert.ok(entry && typeof entry === 'object', 'Malformed Binance funding entry');
  const fundingTimeMs = Number(entry.fundingTime);
  const fundingRate = Number(entry.fundingRate);

  assert.ok(Number.isFinite(fundingTimeMs) && fundingTimeMs > 0, `Invalid Binance fundingTime: ${entry.fundingTime}`);
  assert.ok(Number.isFinite(fundingRate), `Invalid Binance fundingRate: ${entry.fundingRate}`);

  // Snap to exact 8h UTC seconds despite +1ms/+5ms settlement jitter on Binance FAPI.
  const time = Math.round(fundingTimeMs / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_SECONDS;
  assert.equal(time % FUNDING_INTERVAL_SECONDS, 0, `Non-8h Binance funding timestamp: ${fundingTimeMs}`);

  return {
    time,
    fundingRate,
    realizedRate: fundingRate,
    rawFundingTimeMs: fundingTimeMs,
  };
}

export function validateFundingRows(rows, label = 'funding') {
  assert.ok(Array.isArray(rows) && rows.length > 0, `${label}: funding rows must be non-empty`);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    assert.ok(row && typeof row === 'object', `${label}: invalid row at ${i}`);
    assert.ok(Number.isSafeInteger(row.time) && row.time > 0, `${label}: invalid time at ${i}`);
    assert.ok(Number.isFinite(row.fundingRate), `${label}: invalid fundingRate at ${i}`);
    if (row.realizedRate !== undefined) {
      assert.ok(Number.isFinite(row.realizedRate), `${label}: invalid realizedRate at ${i}`);
    }
    if (i > 0) {
      assert.ok(
        row.time > rows[i - 1].time,
        `${label}: duplicate or out-of-order funding timestamp at ${i} (${rows[i - 1].time} -> ${row.time})`,
      );
    }
  }
}

export function validateContiguous8hFunding(rows, label = 'funding') {
  validateFundingRows(rows, label);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(
      rows[i].time % FUNDING_INTERVAL_SECONDS,
      0,
      `${label}: non-8h UTC timestamp at index ${i}: ${rows[i].time}`,
    );
    if (i > 0) {
      const delta = rows[i].time - rows[i - 1].time;
      assert.equal(
        delta,
        FUNDING_INTERVAL_SECONDS,
        `${label}: funding gap at index ${i} (${rows[i - 1].time} -> ${rows[i].time}, delta=${delta})`,
      );
    }
  }
}

/**
 * Strictly causal alignment of 8h funding rows onto OHLCV bars.
 * For each bar i, selects the latest funding settlement row with funding.time <= bar.time,
 * or null if no funding settlement has occurred on or before bar.time.
 */
export function alignFundingToBarsCausal(bars, fundingRows) {
  assert.ok(Array.isArray(bars), 'Expected bars array');
  assert.ok(Array.isArray(fundingRows), 'Expected fundingRows array');

  if (fundingRows.length > 0) {
    validateFundingRows(fundingRows, 'alignFundingToBarsCausal');
  }

  const aligned = new Array(bars.length);
  let j = -1;
  let prevBarTime = -Infinity;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    assert.ok(bar && Number.isSafeInteger(bar.time), `Invalid bar at index ${i}`);
    assert.ok(bar.time >= prevBarTime, `Bars must be non-decreasing by time at index ${i}`);
    prevBarTime = bar.time;

    while (j + 1 < fundingRows.length && fundingRows[j + 1].time <= bar.time) {
      j++;
    }
    aligned[i] = j >= 0 ? fundingRows[j] : null;
  }

  return aligned;
}

async function fetchJsonWithRetry(url, label) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'TRADING-TOOL-Research/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} from ${label}`);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} from ${label}: ${text}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`Failed fetching ${label}: ${lastError?.message ?? 'unknown error'}`);
}

async function fetchOkxFundingBatch({ instId, afterMs, limit = OKX_BATCH_LIMIT }) {
  const params = new URLSearchParams({
    instId,
    limit: String(limit),
  });
  if (afterMs !== undefined) {
    params.set('after', String(afterMs));
  }
  const url = `${OKX_FUNDING_HISTORY_ENDPOINT}?${params.toString()}`;
  const payload = await fetchJsonWithRetry(url, `OKX ${instId}`);
  if (payload?.code === '50011') {
    throw new Error(`OKX rate limit code 50011: ${payload.msg ?? ''}`);
  }
  if (payload?.code !== '0' || !Array.isArray(payload.data)) {
    throw new Error(`OKX API error code=${payload?.code} msg=${payload?.msg}`);
  }
  return payload.data;
}

async function fetchBinanceFundingBatch({ binanceSymbol, startTimeMs, endTimeMs, limit = BINANCE_BATCH_LIMIT }) {
  const params = new URLSearchParams({
    symbol: binanceSymbol,
    startTime: String(startTimeMs),
    limit: String(limit),
  });
  if (endTimeMs !== undefined) {
    params.set('endTime', String(endTimeMs));
  }
  const url = `${BINANCE_FUNDING_RATE_ENDPOINT}?${params.toString()}`;
  const data = await fetchJsonWithRetry(url, `Binance FAPI ${binanceSymbol}`);
  assert.ok(Array.isArray(data), `Binance FAPI error: expected array for ${binanceSymbol}`);
  return data;
}

export async function fetchOkxFundingHistory({
  instId,
  minTimeSec = DEFAULT_FIRST_TIME_SEC,
  maxTimeSec = Infinity,
}) {
  const byTime = new Map();
  let cursorAfterMs = undefined;
  let batchNum = 0;

  while (true) {
    batchNum++;
    const data = await fetchOkxFundingBatch({
      instId,
      afterMs: cursorAfterMs,
      limit: OKX_BATCH_LIMIT,
    });
    if (data.length === 0) break;

    let oldestTimeMs = Infinity;
    let added = 0;
    for (const raw of data) {
      const parsed = parseOkxFundingRow(raw);
      const timeMs = parsed.time * 1000;
      if (timeMs < oldestTimeMs) oldestTimeMs = timeMs;
      if (parsed.time < minTimeSec || parsed.time > maxTimeSec) continue;
      if (!byTime.has(parsed.time)) {
        byTime.set(parsed.time, { ...parsed, source: 'OKX' });
        added++;
      }
    }

    const oldestSec = Number.isFinite(oldestTimeMs) ? oldestTimeMs / 1000 : Infinity;
    if (oldestSec <= minTimeSec) break;
    if (!Number.isFinite(oldestTimeMs) || oldestTimeMs <= 0) break;
    if (cursorAfterMs !== undefined && oldestTimeMs >= cursorAfterMs) break;
    if (data.length < OKX_BATCH_LIMIT && added === 0) break;

    cursorAfterMs = oldestTimeMs;
    await sleep(REQUEST_SLEEP_MS);
  }

  const rows = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  validateFundingRows(rows, instId);
  return {
    rows,
    batches: batchNum,
    historyCapped: rows[0].time > minTimeSec,
  };
}

export async function fetchBinanceFundingHistory({
  binanceSymbol,
  minTimeSec = DEFAULT_FIRST_TIME_SEC,
  maxTimeSec = 1787587199,
}) {
  const byTime = new Map();
  let cursorStartMs = minTimeSec * 1000;
  const endTimeMs = maxTimeSec * 1000 + 60000; // allow +ms jitter on final target settlement

  while (cursorStartMs <= endTimeMs) {
    const data = await fetchBinanceFundingBatch({
      binanceSymbol,
      startTimeMs: cursorStartMs,
      endTimeMs,
      limit: BINANCE_BATCH_LIMIT,
    });
    if (data.length === 0) break;

    let lastRawMs = -Infinity;
    for (const raw of data) {
      const parsed = parseBinanceFundingRow(raw);
      if (parsed.rawFundingTimeMs > lastRawMs) lastRawMs = parsed.rawFundingTimeMs;
      if (parsed.time < minTimeSec || parsed.time > maxTimeSec) continue;
      if (!byTime.has(parsed.time)) {
        byTime.set(parsed.time, {
          time: parsed.time,
          fundingRate: parsed.fundingRate,
          realizedRate: parsed.realizedRate,
          source: 'BINANCE_FAPI',
        });
      }
    }

    if (!Number.isFinite(lastRawMs) || lastRawMs < cursorStartMs) break;
    if (data.length < BINANCE_BATCH_LIMIT) break;
    cursorStartMs = lastRawMs + 1;
    await sleep(REQUEST_SLEEP_MS);
  }

  const rows = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  if (rows.length > 0) {
    validateFundingRows(rows, `Binance ${binanceSymbol}`);
  }
  return rows;
}

export function mergeFundingSources(binanceRows, okxRows) {
  const byTime = new Map();
  for (const r of binanceRows) {
    byTime.set(r.time, {
      time: r.time,
      fundingRate: r.fundingRate,
      realizedRate: r.realizedRate ?? r.fundingRate,
      source: r.source ?? 'BINANCE_FAPI',
    });
  }
  // OKX native precedence on any overlapping timestamp
  for (const r of okxRows) {
    byTime.set(r.time, {
      time: r.time,
      fundingRate: r.fundingRate,
      realizedRate: r.realizedRate ?? r.fundingRate,
      source: r.source ?? 'OKX',
    });
  }
  const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  const sources = { BINANCE_FAPI: 0, OKX: 0 };
  for (const r of merged) {
    sources[r.source] = (sources[r.source] ?? 0) + 1;
  }
  return { rows: merged, sources };
}

function resolveTargetWindow() {
  const refPath = path.join(DATA_DIR, 'okx_btcusdt_swap_1h_3y.json');
  if (!fs.existsSync(refPath)) {
    return { firstTime: DEFAULT_FIRST_TIME_SEC, lastTime: DEFAULT_LAST_TIME_SEC };
  }
  const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
  return {
    firstTime: Number.isSafeInteger(ref.firstTime) ? ref.firstTime : DEFAULT_FIRST_TIME_SEC,
    lastTime: Number.isSafeInteger(ref.lastTime) ? ref.lastTime : DEFAULT_LAST_TIME_SEC,
  };
}

export async function fetchAllOkxFunding({ force = false } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const targetWindow = resolveTargetWindow();
  const fetchedAt = new Date().toISOString();
  const summaries = [];

  for (const inst of FUNDING_INSTRUMENTS) {
    const outPath = path.join(DATA_DIR, inst.fileName);
    let payload = null;

    const canReuseExisting = !force && fs.existsSync(outPath);
    if (canReuseExisting) {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      const coversFullWindow = existing.firstTime <= targetWindow.firstTime + FUNDING_INTERVAL_SECONDS &&
        existing.sources && typeof existing.sources === 'object';
      if (coversFullWindow) {
        validateContiguous8hFunding(existing.rows, inst.instId);
        payload = existing;
      }
    }

    if (!payload) {
      console.log(`[fetch_okx_derivs] Fetching native OKX + Binance FAPI 3y 8h funding for ${inst.instId}...`);
      const okx = await fetchOkxFundingHistory({
        instId: inst.instId,
        minTimeSec: targetWindow.firstTime,
      });
      const okxEarliestSec = okx.rows[0].time;
      const backfillEndSec = okxEarliestSec > targetWindow.firstTime
        ? okxEarliestSec - 1
        : targetWindow.firstTime - 1;

      const binanceRows = backfillEndSec >= targetWindow.firstTime
        ? await fetchBinanceFundingHistory({
          binanceSymbol: inst.binanceSymbol,
          minTimeSec: targetWindow.firstTime,
          maxTimeSec: Math.max(backfillEndSec, okxEarliestSec),
        })
        : [];

      const { rows, sources } = mergeFundingSources(binanceRows, okx.rows);
      validateContiguous8hFunding(rows, `${inst.instId} merged`);

      payload = {
        instId: inst.instId,
        symbol: inst.symbol,
        source: `${OKX_FUNDING_HISTORY_ENDPOINT} + ${BINANCE_FUNDING_RATE_ENDPOINT}`,
        sources,
        fetchedAt,
        requestedFirstTime: targetWindow.firstTime,
        requestedLastTime: targetWindow.lastTime,
        okxFirstTime: okxEarliestSec,
        firstTime: rows[0].time,
        lastTime: rows[rows.length - 1].time,
        count: rows.length,
        rows,
      };
      fs.writeFileSync(outPath, JSON.stringify(payload));
    }

    const coveredIn3yWindow = payload.rows.filter(
      r => r.time >= targetWindow.firstTime && r.time <= targetWindow.lastTime,
    ).length;

    const summary = {
      instId: payload.instId,
      symbol: payload.symbol,
      file: `data/${inst.fileName}`,
      count: payload.count,
      coveredIn3yWindow,
      sources: payload.sources,
      firstTime: payload.firstTime,
      lastTime: payload.lastTime,
      firstIso: new Date(payload.firstTime * 1000).toISOString(),
      lastIso: new Date(payload.lastTime * 1000).toISOString(),
    };
    summaries.push(summary);
    console.log(
      `[done] ${summary.instId}: count=${summary.count} (${summary.coveredIn3yWindow} in 3y window), ` +
      `sources=${JSON.stringify(summary.sources)}, span=${summary.firstIso} .. ${summary.lastIso}`,
    );
  }

  return summaries;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  fetchAllOkxFunding({ force }).catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
