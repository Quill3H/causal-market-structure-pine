import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alignHtfIndices, validateContiguousRows } from './fetch_binance_data.mjs';

const OKX_HISTORY_ENDPOINT = 'https://www.okx.com/api/v5/market/history-candles';
const BATCH_LIMIT = 300;
const HTF_WARMUP_BARS = 300;
const REQUEST_SLEEP_MS = 115;
const TARGET_15M_BARS = 105120; // 3 * 365 * 96
const TARGET_1H_BARS = 26280;   // 3 * 365 * 24

const BAR_SPEC = Object.freeze({
  '15m': { okxBar: '15m', intervalSeconds: 900 },
  '1h': { okxBar: '1H', intervalSeconds: 3600 },
  '4h': { okxBar: '4H', intervalSeconds: 14400 },
  '1d': { okxBar: '1Dutc', intervalSeconds: 86400 },
});

const INSTRUMENTS = Object.freeze([
  { instId: 'BTC-USDT', symbol: 'OKX:BTCUSDT', prefix: 'okx_btcusdt', isSwap: false },
  { instId: 'BTC-USDT-SWAP', symbol: 'OKX:BTCUSDT.P', prefix: 'okx_btcusdt_swap', isSwap: true },
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_DIR = path.join(HERE, 'results_okx');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseOkxCandle(entry, { isSwap, intervalSeconds }) {
  assert.ok(Array.isArray(entry) && entry.length >= 9, 'Malformed OKX candle array');
  const openTimeMs = Number(entry[0]);
  const open = Number(entry[1]);
  const high = Number(entry[2]);
  const low = Number(entry[3]);
  const close = Number(entry[4]);
  // Spot: entry[5] is base BTC volume; SWAP: entry[6] is volCcy (base BTC volume).
  const volume = Number(isSwap ? entry[6] : entry[5]);
  const confirm = String(entry[8]);

  assert.ok(Number.isSafeInteger(openTimeMs) && openTimeMs > 0 && openTimeMs % 1000 === 0,
    `Invalid OKX openTimeMs: ${entry[0]}`);
  for (const [k, v] of [['open', open], ['high', high], ['low', low], ['close', close]]) {
    assert.ok(Number.isFinite(v) && v > 0, `Invalid OKX OHLC ${k}: ${v}`);
  }
  assert.ok(low <= Math.min(open, close) && high >= Math.max(open, close) && low <= high,
    `Inconsistent OKX OHLC at ${openTimeMs}: O=${open} H=${high} L=${low} C=${close}`);
  assert.ok(Number.isFinite(volume) && volume >= 0, `Invalid OKX volume: ${volume}`);

  return {
    time: openTimeMs / 1000,
    open,
    high,
    low,
    close,
    volume,
    openTimeMs,
    closeTimeMs: openTimeMs + intervalSeconds * 1000,
    closed: confirm === '1',
  };
}

async function fetchOkxBatch({ instId, okxBar, afterMs, limit = BATCH_LIMIT }) {
  const params = new URLSearchParams({
    instId,
    bar: okxBar,
    limit: String(limit),
  });
  if (afterMs !== undefined) {
    params.set('after', String(afterMs));
  }
  const url = `${OKX_HISTORY_ENDPOINT}?${params.toString()}`;

  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'TRADING-TOOL-Research/3.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} from OKX`);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} from OKX: ${text}`);
      }
      const payload = await res.json();
      if (payload?.code === '50011') {
        throw new Error(`OKX rate limit code 50011: ${payload.msg ?? ''}`);
      }
      if (payload?.code !== '0' || !Array.isArray(payload.data)) {
        throw new Error(`OKX API error code=${payload?.code} msg=${payload?.msg}: ${JSON.stringify(payload).slice(0, 200)}`);
      }
      return payload.data;
    } catch (err) {
      lastError = err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`Failed fetching OKX ${instId} ${okxBar}: ${lastError?.message ?? 'unknown error'}`);
}

function reportAnyTimestampGaps(rows, intervalSeconds, label) {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    const delta = rows[i].time - rows[i - 1].time;
    if (delta !== intervalSeconds) {
      gaps.push({
        index: i,
        prevTime: rows[i - 1].time,
        currTime: rows[i].time,
        prevIso: new Date(rows[i - 1].time * 1000).toISOString(),
        currIso: new Date(rows[i].time * 1000).toISOString(),
        deltaSeconds: delta,
        expectedSeconds: intervalSeconds,
        missingBars: Math.round(delta / intervalSeconds) - 1,
      });
    }
  }
  if (gaps.length > 0) {
    console.error(`[GAP ERROR] ${label}: found ${gaps.length} timestamp gap(s)/anomaly(ies):`,
      JSON.stringify(gaps.slice(0, 20), null, 2));
  }
  return gaps;
}

async function fetchClosedOkxBackwards({ instId, isSwap, interval, minOpenTimeSec, count, anchorEndMs }) {
  const spec = BAR_SPEC[interval];
  assert.ok(spec, `Unsupported interval: ${interval}`);
  const { okxBar, intervalSeconds } = spec;

  const byTime = new Map();
  let cursorAfterMs = undefined;
  let batchNum = 0;

  while (true) {
    batchNum++;
    const data = await fetchOkxBatch({
      instId,
      okxBar,
      afterMs: cursorAfterMs,
      limit: BATCH_LIMIT,
    });
    if (data.length === 0) break;

    let oldestOpenMs = Infinity;
    let added = 0;
    for (const raw of data) {
      const k = parseOkxCandle(raw, { isSwap, intervalSeconds });
      if (k.openTimeMs < oldestOpenMs) oldestOpenMs = k.openTimeMs;
      if (!k.closed) continue;
      if (k.closeTimeMs > anchorEndMs) continue;
      if (interval === '4h') {
        assert.equal(k.time % 14400, 0, `4h non-UTC timestamp at ${k.time}`);
      } else if (interval === '1d') {
        assert.equal(k.time % 86400, 0, `1d non-UTC timestamp at ${k.time}`);
      }
      if (!byTime.has(k.time)) {
        byTime.set(k.time, {
          time: k.time,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume,
        });
        added++;
      }
    }

    const sortedTimes = Array.from(byTime.keys()).sort((a, b) => a - b);
    if (batchNum % 50 === 0) {
      const oldestIso = sortedTimes.length ? new Date(sortedTimes[0] * 1000).toISOString() : 'n/a';
      console.log(`  [${instId} ${interval}] batch=${batchNum} collected=${sortedTimes.length} oldest=${oldestIso}`);
    }

    const haveEnoughCount = count === undefined || sortedTimes.length >= count;
    const haveEnoughStart = minOpenTimeSec === undefined ||
      (sortedTimes.length > 0 && sortedTimes[0] <= minOpenTimeSec);
    if (haveEnoughCount && haveEnoughStart) break;
    if (!Number.isFinite(oldestOpenMs) || oldestOpenMs <= 0) break;
    if (cursorAfterMs !== undefined && oldestOpenMs >= cursorAfterMs) break;
    if (data.length < BATCH_LIMIT && added === 0) break;

    cursorAfterMs = oldestOpenMs;
    await sleep(REQUEST_SLEEP_MS);
  }

  let rows = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  if (count !== undefined && minOpenTimeSec === undefined) {
    assert.ok(rows.length >= count,
      `${instId} ${interval}: fetched ${rows.length} closed rows, expected at least ${count}`);
    rows = rows.slice(-count);
  } else if (minOpenTimeSec !== undefined) {
    rows = rows.filter(r => r.time >= minOpenTimeSec);
  }

  reportAnyTimestampGaps(rows, intervalSeconds, `${instId} ${interval}`);
  validateContiguousRows(rows, intervalSeconds, `${instId} ${interval}`);
  return { rows, intervalSeconds, source: OKX_HISTORY_ENDPOINT };
}

function sliceHtfForLtf(htfFull, ltfRows, htfLabel) {
  const minOpenSec = ltfRows[0].time - HTF_WARMUP_BARS * htfFull.intervalSeconds;
  const maxOpenSec = ltfRows[ltfRows.length - 1].time;
  const rows = htfFull.rows.filter(r => r.time >= minOpenSec && r.time <= maxOpenSec);
  reportAnyTimestampGaps(rows, htfFull.intervalSeconds, htfLabel);
  validateContiguousRows(rows, htfFull.intervalSeconds, htfLabel);
  const alignedIndex = alignHtfIndices(ltfRows, rows, htfFull.intervalSeconds);
  return {
    interval: htfFull.interval,
    intervalSeconds: htfFull.intervalSeconds,
    rows,
    alignedIndex,
  };
}

function buildDatasetPayload({ symbol, interval, intervalSeconds, rows, htfSpecs, fetchedAt, source }) {
  const htf = {};
  for (const htfSpec of htfSpecs) {
    htf[htfSpec.interval] = sliceHtfForLtf(htfSpec, rows, `${symbol} ${interval} -> HTF ${htfSpec.interval}`);
  }
  return {
    symbol,
    interval,
    intervalSeconds,
    fetchedAt,
    source,
    htfAlignmentRule: 'htfBar.time + htfIntervalSeconds <= ltfBar.time',
    count: rows.length,
    firstTime: rows[0].time,
    lastTime: rows[rows.length - 1].time,
    rows,
    htf,
  };
}

function summarizeWrittenDataset(fileName, serialized) {
  const payload = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
  const rawStr = typeof serialized === 'string' ? serialized : JSON.stringify(serialized);
  const filePath = path.join(DATA_DIR, fileName);
  const bytes = fs.statSync(filePath).size;
  const sha256 = crypto.createHash('sha256').update(rawStr).digest('hex');
  const htfSummary = Object.fromEntries(
    Object.entries(payload.htf).map(([tf, h]) => [tf, {
      intervalSeconds: h.intervalSeconds,
      count: h.rows.length,
      firstTime: h.rows[0].time,
      lastTime: h.rows[h.rows.length - 1].time,
      alignedMinIndex: h.alignedIndex[0],
      alignedMaxIndex: h.alignedIndex[h.alignedIndex.length - 1],
    }]),
  );
  return {
    file: `data/${fileName}`,
    symbol: payload.symbol,
    interval: payload.interval,
    intervalSeconds: payload.intervalSeconds,
    count: payload.count,
    firstTime: payload.firstTime,
    lastTime: payload.lastTime,
    firstIso: new Date(payload.firstTime * 1000).toISOString(),
    lastIso: new Date(payload.lastTime * 1000).toISOString(),
    contiguousVerified: true,
    closedOnlyVerified: true,
    bytes,
    sha256,
    htf: htfSummary,
  };
}

function writeDataset(fileName, payload) {
  const filePath = path.join(DATA_DIR, fileName);
  const serialized = JSON.stringify(payload);
  fs.writeFileSync(filePath, serialized);
  return summarizeWrittenDataset(fileName, payload);
}

function expectedFileNames() {
  const names = [];
  for (const inst of INSTRUMENTS) {
    names.push(
      `${inst.prefix}_15m_3y.json`,
      `${inst.prefix}_tv_15m_6k.json`,
      `${inst.prefix}_1h_3y.json`,
      `${inst.prefix}_tv_1h_6k.json`,
    );
  }
  return names;
}

function validateExistingDataset(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  const raw = fs.readFileSync(filePath, 'utf8');
  const ds = JSON.parse(raw);
  reportAnyTimestampGaps(ds.rows, ds.intervalSeconds, fileName);
  validateContiguousRows(ds.rows, ds.intervalSeconds, fileName);
  for (const [tf, h] of Object.entries(ds.htf || {})) {
    reportAnyTimestampGaps(h.rows, h.intervalSeconds, `${fileName} HTF ${tf}`);
    validateContiguousRows(h.rows, h.intervalSeconds, `${fileName} HTF ${tf}`);
    const recomputed = alignHtfIndices(ds.rows, h.rows, h.intervalSeconds);
    assert.deepEqual(h.alignedIndex, recomputed, `${fileName} HTF ${tf}: alignedIndex mismatch`);
  }
  return summarizeWrittenDataset(fileName, raw);
}

export async function fetchAllOkxDatasets({ force = false } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const fileNames = expectedFileNames();
  const allExist = fileNames.every(f => fs.existsSync(path.join(DATA_DIR, f)));
  if (!force && allExist) {
    console.log('[fetch_okx_data] All 8 OKX dataset files already exist; validating without re-fetching...');
    const existingSummaries = fileNames.map(validateExistingDataset);
    const existingManifest = {
      generatedAt: new Date().toISOString(),
      source: OKX_HISTORY_ENDPOINT,
      htfWarmupBars: HTF_WARMUP_BARS,
      htfAlignmentRule: 'htfBar.time + htfIntervalSeconds <= ltfBar.time',
      datasets: existingSummaries,
    };
    const manifestPath = path.join(RESULTS_DIR, 'okx_manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(existingManifest, null, 2) + '\n');
    console.log(`[fetch_okx_data] Validation passed. Updated ${manifestPath}`);
    return existingManifest;
  }

  const anchorEndMs = Date.now();
  const fetchedAt = new Date(anchorEndMs).toISOString();
  console.log(`[fetch_okx_data] Anchor UTC: ${fetchedAt} (${anchorEndMs})`);

  const manifestDatasets = [];

  for (const inst of INSTRUMENTS) {
    const { instId, symbol, prefix, isSwap } = inst;

    console.log(`[fetch] ${instId} 15m (${TARGET_15M_BARS} closed bars = 3y)...`);
    const ltf15m = await fetchClosedOkxBackwards({
      instId, isSwap, interval: '15m', count: TARGET_15M_BARS, anchorEndMs,
    });
    const start15m = ltf15m.rows[0].time;
    console.log(`[done] ${instId} 15m: ${ltf15m.rows.length} bars (${new Date(start15m * 1000).toISOString()} .. ${new Date(ltf15m.rows[ltf15m.rows.length - 1].time * 1000).toISOString()})`);

    console.log(`[fetch] ${instId} 1h (${TARGET_1H_BARS} bars + ${HTF_WARMUP_BARS} warmup)...`);
    const h1Full = await fetchClosedOkxBackwards({
      instId, isSwap, interval: '1h',
      minOpenTimeSec: start15m - HTF_WARMUP_BARS * BAR_SPEC['1h'].intervalSeconds,
      anchorEndMs,
    });
    assert.ok(h1Full.rows.length >= TARGET_1H_BARS,
      `${instId} 1h: expected at least ${TARGET_1H_BARS} bars, got ${h1Full.rows.length}`);
    const ltf1hRows = h1Full.rows.slice(-TARGET_1H_BARS);
    const start1h = ltf1hRows[0].time;
    console.log(`[done] ${instId} 1h: ${ltf1hRows.length} LTF bars / ${h1Full.rows.length} total (${new Date(start1h * 1000).toISOString()} .. ${new Date(ltf1hRows[ltf1hRows.length - 1].time * 1000).toISOString()})`);

    const minStart = Math.min(start15m, start1h);
    console.log(`[fetch] ${instId} 4h (minStart=${new Date(minStart * 1000).toISOString()} - ${HTF_WARMUP_BARS} bars)...`);
    const h4Full = await fetchClosedOkxBackwards({
      instId, isSwap, interval: '4h',
      minOpenTimeSec: minStart - HTF_WARMUP_BARS * BAR_SPEC['4h'].intervalSeconds,
      anchorEndMs,
    });
    console.log(`[done] ${instId} 4h: ${h4Full.rows.length} bars`);

    console.log(`[fetch] ${instId} 1Dutc (${HTF_WARMUP_BARS} warmup before 1h)...`);
    const d1Full = await fetchClosedOkxBackwards({
      instId, isSwap, interval: '1d',
      minOpenTimeSec: start1h - HTF_WARMUP_BARS * BAR_SPEC['1d'].intervalSeconds,
      anchorEndMs,
    });
    console.log(`[done] ${instId} 1Dutc: ${d1Full.rows.length} bars`);

    manifestDatasets.push(writeDataset(`${prefix}_15m_3y.json`, buildDatasetPayload({
      symbol, interval: '15m', intervalSeconds: 900,
      rows: ltf15m.rows,
      htfSpecs: [
        { interval: '1h', ...h1Full },
        { interval: '4h', ...h4Full },
      ],
      fetchedAt, source: OKX_HISTORY_ENDPOINT,
    })));

    manifestDatasets.push(writeDataset(`${prefix}_tv_15m_6k.json`, buildDatasetPayload({
      symbol, interval: '15m', intervalSeconds: 900,
      rows: ltf15m.rows.slice(-6000),
      htfSpecs: [
        { interval: '1h', ...h1Full },
        { interval: '4h', ...h4Full },
      ],
      fetchedAt, source: OKX_HISTORY_ENDPOINT,
    })));

    manifestDatasets.push(writeDataset(`${prefix}_1h_3y.json`, buildDatasetPayload({
      symbol, interval: '1h', intervalSeconds: 3600,
      rows: ltf1hRows,
      htfSpecs: [
        { interval: '4h', ...h4Full },
        { interval: '1d', ...d1Full },
      ],
      fetchedAt, source: OKX_HISTORY_ENDPOINT,
    })));

    manifestDatasets.push(writeDataset(`${prefix}_tv_1h_6k.json`, buildDatasetPayload({
      symbol, interval: '1h', intervalSeconds: 3600,
      rows: ltf1hRows.slice(-6000),
      htfSpecs: [
        { interval: '4h', ...h4Full },
        { interval: '1d', ...d1Full },
      ],
      fetchedAt, source: OKX_HISTORY_ENDPOINT,
    })));
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    anchorEndMs,
    source: OKX_HISTORY_ENDPOINT,
    htfWarmupBars: HTF_WARMUP_BARS,
    htfAlignmentRule: 'htfBar.time + htfIntervalSeconds <= ltfBar.time',
    datasets: manifestDatasets,
  };
  const manifestPath = path.join(RESULTS_DIR, 'okx_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[fetch_okx_data] Done. Wrote ${manifestPath}`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const force = process.argv.includes('--force');
  fetchAllOkxDatasets({ force }).catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
