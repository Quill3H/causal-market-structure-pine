import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRIMARY_ENDPOINT = 'https://api.binance.com/api/v3/klines';
const FALLBACK_ENDPOINT = 'https://data-api.binance.vision/api/v3/klines';
const ENDPOINTS = [PRIMARY_ENDPOINT, FALLBACK_ENDPOINT];
const BATCH_LIMIT = 1000;
const HTF_WARMUP_BARS = 300;

const INTERVAL_SECONDS = {
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseKline(entry) {
  assert.ok(Array.isArray(entry) && entry.length >= 7, 'Malformed Binance kline array');
  const openTimeMs = Number(entry[0]);
  const open = Number(entry[1]);
  const high = Number(entry[2]);
  const low = Number(entry[3]);
  const close = Number(entry[4]);
  const volume = Number(entry[5]);
  const closeTimeMs = Number(entry[6]);
  assert.ok(Number.isSafeInteger(openTimeMs) && openTimeMs > 0 && openTimeMs % 1000 === 0,
    `Invalid openTimeMs: ${entry[0]}`);
  assert.ok(Number.isSafeInteger(closeTimeMs) && closeTimeMs > openTimeMs,
    `Invalid closeTimeMs: ${entry[6]}`);
  for (const [k, v] of [['open', open], ['high', high], ['low', low], ['close', close]]) {
    assert.ok(Number.isFinite(v) && v > 0, `Invalid OHLC ${k}: ${v}`);
  }
  assert.ok(low <= Math.min(open, close) && high >= Math.max(open, close) && low <= high,
    `Inconsistent OHLC at ${openTimeMs}: O=${open} H=${high} L=${low} C=${close}`);
  assert.ok(Number.isFinite(volume) && volume >= 0, `Invalid volume: ${volume}`);
  return {
    time: openTimeMs / 1000,
    open,
    high,
    low,
    close,
    volume,
    openTimeMs,
    closeTimeMs,
  };
}

export function validateContiguousRows(rows, intervalSeconds, label = 'series') {
  assert.ok(Array.isArray(rows) && rows.length > 0, `${label}: rows must be non-empty`);
  assert.ok(Number.isSafeInteger(intervalSeconds) && intervalSeconds > 0,
    `${label}: invalid intervalSeconds`);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    assert.ok(row && typeof row === 'object', `${label}: invalid row at ${i}`);
    assert.ok(Number.isSafeInteger(row.time) && row.time > 0, `${label}: invalid time at ${i}`);
    if (i > 0) {
      const delta = row.time - rows[i - 1].time;
      assert.equal(delta, intervalSeconds,
        `${label}: timestamp gap/duplicate at index ${i} (${rows[i - 1].time} -> ${row.time}, delta=${delta}, expected=${intervalSeconds})`);
    }
    for (const key of ['open', 'high', 'low', 'close']) {
      assert.ok(Number.isFinite(row[key]) && row[key] > 0, `${label}: invalid ${key} at ${i}`);
    }
    assert.ok(row.low <= Math.min(row.open, row.close) && row.high >= Math.max(row.open, row.close),
      `${label}: inconsistent OHLC at ${i}`);
    assert.ok(Number.isFinite(row.volume) && row.volume >= 0, `${label}: invalid volume at ${i}`);
  }
}

export function alignHtfIndices(ltfRows, htfRows, htfIntervalSeconds) {
  validateContiguousRows(htfRows, htfIntervalSeconds, 'htf');
  const aligned = new Array(ltfRows.length);
  let j = -1;
  for (let i = 0; i < ltfRows.length; i++) {
    const ltfOpenTime = ltfRows[i].time;
    while (j + 1 < htfRows.length && htfRows[j + 1].time + htfIntervalSeconds <= ltfOpenTime) {
      j++;
    }
    assert.ok(j >= 0,
      `Insufficient HTF warmup: no closed HTF bar before LTF bar ${i} (${ltfOpenTime})`);
    aligned[i] = j;
  }
  return aligned;
}

async function fetchKlineBatch({ symbol, interval, endTimeMs, startTimeMs, limit = BATCH_LIMIT }) {
  const params = new URLSearchParams({
    symbol,
    interval,
    limit: String(limit),
  });
  if (endTimeMs !== undefined) params.set('endTime', String(endTimeMs));
  if (startTimeMs !== undefined) params.set('startTime', String(startTimeMs));

  let lastError = null;
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const url = `${endpoint}?${params.toString()}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'TRADING-TOOL-Research/3.0' },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`HTTP ${res.status} from ${endpoint}`);
        }
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`HTTP ${res.status} from ${endpoint}: ${body}`);
        }
        const payload = await res.json();
        if (!Array.isArray(payload)) {
          throw new Error(`Unexpected response from ${endpoint}: ${JSON.stringify(payload)}`);
        }
        return { endpoint, payload };
      } catch (err) {
        lastError = err;
        await sleep(300 * (attempt + 1));
      }
    }
  }
  throw new Error(`Failed fetching ${symbol} ${interval}: ${lastError?.message ?? 'unknown error'}`);
}

async function fetchClosedKlinesBackwards({ symbol, interval, minOpenTimeSec, count, anchorEndMs }) {
  const intervalSeconds = INTERVAL_SECONDS[interval];
  assert.ok(intervalSeconds, `Unsupported interval: ${interval}`);
  const byTime = new Map();
  let cursorEndMs = anchorEndMs;
  let usedEndpoint = PRIMARY_ENDPOINT;

  while (true) {
    const requestTimeMs = Date.now();
    const { endpoint, payload } = await fetchKlineBatch({
      symbol,
      interval,
      endTimeMs: cursorEndMs,
      limit: BATCH_LIMIT,
    });
    usedEndpoint = endpoint;
    if (payload.length === 0) break;

    const cutoffNowMs = Math.min(anchorEndMs ?? requestTimeMs, requestTimeMs, Date.now());
    let earliestOpenMs = Infinity;
    let added = 0;
    for (const raw of payload) {
      const k = parseKline(raw);
      if (k.openTimeMs < earliestOpenMs) earliestOpenMs = k.openTimeMs;
      // Exclude any currently open candle where closeTime > now.
      if (k.closeTimeMs > cutoffNowMs) continue;
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
    const haveEnoughCount = count === undefined || sortedTimes.length >= count;
    const haveEnoughStart = minOpenTimeSec === undefined ||
      (sortedTimes.length > 0 && sortedTimes[0] <= minOpenTimeSec);
    if (haveEnoughCount && haveEnoughStart) break;
    if (!Number.isFinite(earliestOpenMs) || earliestOpenMs <= 0) break;
    if (payload.length < BATCH_LIMIT && added === 0) break;

    cursorEndMs = earliestOpenMs - 1;
    await sleep(60);
  }

  let rows = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  if (count !== undefined && minOpenTimeSec === undefined) {
    assert.ok(rows.length >= count,
      `${symbol} ${interval}: fetched ${rows.length} closed rows, expected at least ${count}`);
    rows = rows.slice(-count);
  } else if (minOpenTimeSec !== undefined) {
    rows = rows.filter(r => r.time >= minOpenTimeSec);
  }

  validateContiguousRows(rows, intervalSeconds, `${symbol} ${interval}`);
  return { rows, intervalSeconds, source: usedEndpoint };
}

function sliceHtfForLtf(htfFull, ltfRows) {
  const minOpenSec = ltfRows[0].time - HTF_WARMUP_BARS * htfFull.intervalSeconds;
  const maxOpenSec = ltfRows[ltfRows.length - 1].time;
  const rows = htfFull.rows.filter(r => r.time >= minOpenSec && r.time <= maxOpenSec);
  validateContiguousRows(rows, htfFull.intervalSeconds, `HTF ${htfFull.interval}`);
  const alignedIndex = alignHtfIndices(ltfRows, rows, htfFull.intervalSeconds);
  return {
    interval: htfFull.interval,
    intervalSeconds: htfFull.intervalSeconds,
    rows,
    alignedIndex,
  };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildDatasetPayload({ symbol, interval, intervalSeconds, rows, htfSpecs, fetchedAt, source }) {
  const htf = {};
  for (const htfSpec of htfSpecs) {
    htf[htfSpec.interval] = sliceHtfForLtf(htfSpec, rows);
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

function writeDataset(fileName, payload) {
  const filePath = path.join(DATA_DIR, fileName);
  const serialized = JSON.stringify(payload);
  fs.writeFileSync(filePath, serialized);
  const bytes = fs.statSync(filePath).size;
  const sha256 = crypto.createHash('sha256').update(serialized).digest('hex');
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

export async function fetchAllDatasets() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const anchorEndMs = Date.now();
  const fetchedAt = new Date(anchorEndMs).toISOString();

  console.log(`[fetch_binance_data] Anchor UTC: ${fetchedAt} (${anchorEndMs})`);

  // 1. BTCUSDT 15m (12 months = 35,040 bars) + 1h & 4h
  console.log('[fetch] BTCUSDT 15m (35,040 closed bars)...');
  const btc15m = await fetchClosedKlinesBackwards({
    symbol: 'BTCUSDT', interval: '15m', count: 35040, anchorEndMs,
  });
  const btc15mStart = btc15m.rows[0].time;
  const btc1hFor15m = await fetchClosedKlinesBackwards({
    symbol: 'BTCUSDT', interval: '1h',
    minOpenTimeSec: btc15mStart - HTF_WARMUP_BARS * INTERVAL_SECONDS['1h'],
    anchorEndMs,
  });

  // 2. BTCUSDT 1h (24 months = 17,520 bars) + 4h & 1d
  console.log('[fetch] BTCUSDT 1h (17,520 closed bars)...');
  const btc1h = await fetchClosedKlinesBackwards({
    symbol: 'BTCUSDT', interval: '1h', count: 17520, anchorEndMs,
  });
  const btc1hStart = btc1h.rows[0].time;
  const btc4hFull = await fetchClosedKlinesBackwards({
    symbol: 'BTCUSDT', interval: '4h',
    minOpenTimeSec: Math.min(btc15mStart, btc1hStart) - HTF_WARMUP_BARS * INTERVAL_SECONDS['4h'],
    anchorEndMs,
  });
  const btc1dFull = await fetchClosedKlinesBackwards({
    symbol: 'BTCUSDT', interval: '1d',
    minOpenTimeSec: btc1hStart - HTF_WARMUP_BARS * INTERVAL_SECONDS['1d'],
    anchorEndMs,
  });

  // 3. ETHUSDT 15m (6 months = 17,520 bars) + 1h & 4h
  console.log('[fetch] ETHUSDT 15m (17,520 closed bars)...');
  const eth15m = await fetchClosedKlinesBackwards({
    symbol: 'ETHUSDT', interval: '15m', count: 17520, anchorEndMs,
  });
  const eth15mStart = eth15m.rows[0].time;
  const eth1hFor15m = await fetchClosedKlinesBackwards({
    symbol: 'ETHUSDT', interval: '1h',
    minOpenTimeSec: eth15mStart - HTF_WARMUP_BARS * INTERVAL_SECONDS['1h'],
    anchorEndMs,
  });

  // 4. ETHUSDT 1h (12 months = 8,760 bars) + 4h & 1d
  console.log('[fetch] ETHUSDT 1h (8,760 closed bars)...');
  const eth1h = await fetchClosedKlinesBackwards({
    symbol: 'ETHUSDT', interval: '1h', count: 8760, anchorEndMs,
  });
  const eth1hStart = eth1h.rows[0].time;
  const eth4hFull = await fetchClosedKlinesBackwards({
    symbol: 'ETHUSDT', interval: '4h',
    minOpenTimeSec: Math.min(eth15mStart, eth1hStart) - HTF_WARMUP_BARS * INTERVAL_SECONDS['4h'],
    anchorEndMs,
  });
  const eth1dFull = await fetchClosedKlinesBackwards({
    symbol: 'ETHUSDT', interval: '1d',
    minOpenTimeSec: eth1hStart - HTF_WARMUP_BARS * INTERVAL_SECONDS['1d'],
    anchorEndMs,
  });

  const manifestDatasets = [];

  manifestDatasets.push(writeDataset('btcusdt_15m_12m.json', buildDatasetPayload({
    symbol: 'BTCUSDT', interval: '15m', intervalSeconds: 900,
    rows: btc15m.rows,
    htfSpecs: [
      { interval: '1h', ...btc1hFor15m },
      { interval: '4h', ...btc4hFull },
    ],
    fetchedAt, source: btc15m.source,
  })));

  manifestDatasets.push(writeDataset('btcusdt_tv_15m_6k.json', buildDatasetPayload({
    symbol: 'BTCUSDT', interval: '15m', intervalSeconds: 900,
    rows: btc15m.rows.slice(-6000),
    htfSpecs: [
      { interval: '1h', ...btc1hFor15m },
      { interval: '4h', ...btc4hFull },
    ],
    fetchedAt, source: btc15m.source,
  })));

  manifestDatasets.push(writeDataset('btcusdt_1h_24m.json', buildDatasetPayload({
    symbol: 'BTCUSDT', interval: '1h', intervalSeconds: 3600,
    rows: btc1h.rows,
    htfSpecs: [
      { interval: '4h', ...btc4hFull },
      { interval: '1d', ...btc1dFull },
    ],
    fetchedAt, source: btc1h.source,
  })));

  manifestDatasets.push(writeDataset('btcusdt_tv_1h_6k.json', buildDatasetPayload({
    symbol: 'BTCUSDT', interval: '1h', intervalSeconds: 3600,
    rows: btc1h.rows.slice(-6000),
    htfSpecs: [
      { interval: '4h', ...btc4hFull },
      { interval: '1d', ...btc1dFull },
    ],
    fetchedAt, source: btc1h.source,
  })));

  manifestDatasets.push(writeDataset('ethusdt_15m_6m.json', buildDatasetPayload({
    symbol: 'ETHUSDT', interval: '15m', intervalSeconds: 900,
    rows: eth15m.rows,
    htfSpecs: [
      { interval: '1h', ...eth1hFor15m },
      { interval: '4h', ...eth4hFull },
    ],
    fetchedAt, source: eth15m.source,
  })));

  manifestDatasets.push(writeDataset('ethusdt_1h_12m.json', buildDatasetPayload({
    symbol: 'ETHUSDT', interval: '1h', intervalSeconds: 3600,
    rows: eth1h.rows,
    htfSpecs: [
      { interval: '4h', ...eth4hFull },
      { interval: '1d', ...eth1dFull },
    ],
    fetchedAt, source: eth1h.source,
  })));

  const tvRefs = [];
  for (const refName of ['data-15.json', 'data-60.json']) {
    const refPath = path.join(DATA_DIR, 'tv-ref', refName);
    if (fs.existsSync(refPath)) {
      const parsed = JSON.parse(fs.readFileSync(refPath, 'utf8'));
      tvRefs.push({
        file: `data/tv-ref/${refName}`,
        symbol: parsed.symbol,
        resolution: parsed.resolution,
        intervalSeconds: parsed.intervalSeconds,
        count: parsed.rows.length,
        firstTime: parsed.rows[0].time,
        lastTime: parsed.rows[parsed.rows.length - 1].time,
        bytes: fs.statSync(refPath).size,
        sha256: sha256File(refPath),
      });
    }
  }

  const legacyRefPath = path.join(ROOT_DIR, 'legacy', 'TOOL-2.0.0-ref.pine');
  const manifest = {
    generatedAt: new Date().toISOString(),
    anchorEndMs,
    htfWarmupBars: HTF_WARMUP_BARS,
    htfAlignmentRule: 'htfBar.time + htfIntervalSeconds <= ltfBar.time',
    datasets: manifestDatasets,
    tvReferences: tvRefs,
    legacyPineRef: fs.existsSync(legacyRefPath)
      ? { file: 'legacy/TOOL-2.0.0-ref.pine', sha256: sha256File(legacyRefPath) }
      : null,
  };

  const manifestPath = path.join(DATA_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[fetch_binance_data] Done. Wrote ${manifestPath}`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchAllDatasets().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
