import assert from 'node:assert/strict';

const EPS = 1e-12;
const DAY_SECONDS = 86400;

export const CRYPTO_REGIMES_V8 = Object.freeze({
  BULL_TREND: 'BULL_TREND',
  BEAR_TREND: 'BEAR_TREND',
  BEAR_SQUEEZE: 'BEAR_SQUEEZE',
  RANGE_CHOP: 'RANGE_CHOP',
});

export const EQUITY_REGIMES_V8 = Object.freeze({
  BULL_TREND: 'BULL_TREND',
  BEAR_TREND: 'BEAR_TREND',
  HIGH_VOL_CHOP: 'HIGH_VOL_CHOP',
});

function computeEmaSeries(values, period) {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const k = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < n; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function computeSmaSeries(values, period) {
  const n = values.length;
  const out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    const denom = Math.min(i + 1, period);
    out[i] = sum / denom;
  }
  return out;
}

function computeAtrSeries(rows, period = 14) {
  const n = rows.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const alpha = 1 / period;
  const tr0 = rows[0].high - rows[0].low;
  out[0] = Math.max(tr0, EPS);
  for (let i = 1; i < n; i++) {
    const r = rows[i];
    const prevClose = rows[i - 1].close;
    const tr = Math.max(
      r.high - r.low,
      Math.abs(r.high - prevClose),
      Math.abs(r.low - prevClose),
    );
    out[i] = Math.max(EPS, out[i - 1] * (1 - alpha) + tr * alpha);
  }
  return out;
}

function computeRsiSeries(closes, period = 14) {
  const n = closes.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  out[0] = 50;
  let avgGain = 0;
  let avgLoss = 0;
  const alpha = 1 / period;

  for (let i = 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
    } else {
      avgGain = avgGain * (1 - alpha) + gain * alpha;
      avgLoss = avgLoss * (1 - alpha) + loss * alpha;
    }
    if (avgLoss <= EPS) {
      out[i] = avgGain <= EPS ? 50 : 100;
    } else {
      const rs = avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function alignCausalIndices(ltfRows, htfRows, htfIntervalSeconds) {
  const n = ltfRows.length;
  const out = new Int32Array(n);
  let j = -1;
  for (let i = 0; i < n; i++) {
    const t = ltfRows[i].time;
    while (j + 1 < htfRows.length && htfRows[j + 1].time + htfIntervalSeconds <= t) {
      j++;
    }
    out[i] = j;
  }
  return out;
}

function alignFundingCausalRates(ltfRows, fundingRows) {
  const n = ltfRows.length;
  const out = new Float64Array(n);
  if (!Array.isArray(fundingRows) || fundingRows.length === 0) return out;
  let j = -1;
  for (let i = 0; i < n; i++) {
    const t = ltfRows[i].time;
    while (j + 1 < fundingRows.length && fundingRows[j + 1].time <= t) {
      j++;
    }
    out[i] = j >= 0 ? fundingRows[j].fundingRate : 0;
  }
  return out;
}

function normalizeCoinMap(datasets1hByCoin) {
  assert.ok(datasets1hByCoin && typeof datasets1hByCoin === 'object', 'Expected datasets1hByCoin object');
  const entries = [];
  for (const [key, ds] of Object.entries(datasets1hByCoin)) {
    assert.ok(ds && ds.htf && ds.htf['1d'] && Array.isArray(ds.htf['1d'].rows),
      `Coin ${key}: expected dataset with htf['1d'].rows`);
    entries.push({ key: key.toUpperCase(), ds });
  }
  assert.ok(entries.length > 0, 'Expected at least 1 coin dataset');
  return entries;
}

/**
 * Strictly causal 4-coin daily macro breadth across closed 1D bars (closeTime = time + 86400 <= bar.time).
 */
export function precomputeCryptoBreadthV8(datasets1hByCoin) {
  const coins = normalizeCoinMap(datasets1hByCoin);
  const perCoin = [];
  const timeSet = new Set();

  for (const { key, ds } of coins) {
    const d1Rows = ds.htf['1d'].rows;
    const closes = d1Rows.map(r => r.close);
    const ema20 = computeEmaSeries(closes, 20);
    const ema50 = computeEmaSeries(closes, 50);
    const ema200 = computeEmaSeries(closes, 200);
    const timeToIdx = new Map();
    for (let j = 0; j < d1Rows.length; j++) {
      timeToIdx.set(d1Rows[j].time, j);
      timeSet.add(d1Rows[j].time);
    }
    perCoin.push({ key, d1Rows, ema20, ema50, ema200, timeToIdx });
  }

  const btcEntry = perCoin.find(c => c.key.startsWith('BTC')) ?? perCoin[0];
  const d1Times = Array.from(timeSet).sort((a, b) => a - b);
  const rows = [];
  const byD1Time = new Map();

  // Causal last-seen index per coin so missing early bars don't leak future
  const lastIdx = new Int32Array(perCoin.length).fill(-1);

  for (const t of d1Times) {
    let bear50 = 0;
    let bear200 = 0;
    let activeCoins = 0;

    for (let c = 0; c < perCoin.length; c++) {
      const coin = perCoin[c];
      const idx = coin.timeToIdx.get(t);
      if (idx !== undefined) lastIdx[c] = idx;
      const j = lastIdx[c];
      if (j < 0) continue;
      activeCoins++;
      const close = coin.d1Rows[j].close;
      if (close < coin.ema50[j]) bear50++;
      if (close < coin.ema200[j]) bear200++;
    }

    const breadthBearEma50 = activeCoins > 0 ? bear50 / activeCoins : 0.5;
    const breadthBearEma200 = activeCoins > 0 ? bear200 / activeCoins : 0.5;

    const btcPos = perCoin.indexOf(btcEntry);
    const bj = lastIdx[btcPos];
    let btcD1Trend = 0;
    let btcClose = null;
    let btcEma50 = null;
    let btcEma200 = null;
    let btcSlope20 = 0;

    if (bj >= 0) {
      btcClose = btcEntry.d1Rows[bj].close;
      btcEma50 = btcEntry.ema50[bj];
      btcEma200 = btcEntry.ema200[bj];
      btcSlope20 = bj >= 20 ? btcEntry.ema20[bj] - btcEntry.ema20[bj - 20] : btcEntry.ema20[bj] - btcEntry.ema20[0];
      if (btcClose > btcEma50 && (btcClose > btcEma200 || btcSlope20 > 0)) {
        btcD1Trend = 1;
      } else if (btcClose < btcEma50 && (btcClose < btcEma200 || btcSlope20 <= 0)) {
        btcD1Trend = -1;
      }
    }

    const rec = {
      time: t,
      closeTime: t + DAY_SECONDS,
      breadthBearEma50,
      breadthBearEma200,
      btcD1Trend,
      btcClose,
      btcEma50,
      btcEma200,
      btcSlope20,
      activeCoins,
    };
    rows.push(rec);
    byD1Time.set(t, rec);
  }

  function getBreadthAtTime(barTime) {
    if (rows.length === 0 || barTime < rows[0].closeTime) {
      return {
        time: null,
        closeTime: null,
        breadthBearEma50: 0.5,
        breadthBearEma200: 0.5,
        btcD1Trend: 0,
        activeCoins: 0,
      };
    }
    let lo = 0;
    let hi = rows.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].closeTime <= barTime) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0
      ? rows[best]
      : {
        time: null,
        closeTime: null,
        breadthBearEma50: 0.5,
        breadthBearEma200: 0.5,
        btcD1Trend: 0,
        activeCoins: 0,
      };
  }

  return {
    coins: perCoin.map(c => c.key),
    d1Times,
    rows,
    byD1Time,
    getBreadthAtTime,
  };
}

/**
 * Strictly causal per-bar asset regime & directional priority engine for both 1h and 15m crypto datasets.
 */
export function precomputeAssetRegimeV8(dataset, breadthCtx = null) {
  assert.ok(dataset && Array.isArray(dataset.rows) && dataset.rows.length > 0, 'Expected dataset with rows');
  assert.ok(dataset.htf && dataset.htf['1d'] && dataset.htf['4h'], 'Expected dataset.htf with 1d and 4h');

  const rows = dataset.rows;
  const n = rows.length;
  const d1Rows = dataset.htf['1d'].rows;
  const h4Rows = dataset.htf['4h'].rows;

  const d1Aligned = alignCausalIndices(rows, d1Rows, 86400);
  const h4Aligned = alignCausalIndices(rows, h4Rows, 14400);
  const fundingRates = alignFundingCausalRates(rows, dataset.fundingRows ?? []);

  // Precompute causal 1D indicators
  const d1Closes = d1Rows.map(r => r.close);
  const d1Ema20 = computeEmaSeries(d1Closes, 20);
  const d1Ema50 = computeEmaSeries(d1Closes, 50);
  const d1Ema200 = computeEmaSeries(d1Closes, 200);
  const d1Atr = computeAtrSeries(d1Rows, 14);

  // Precompute causal 4H indicators
  const h4Closes = h4Rows.map(r => r.close);
  const h4Ema20 = computeEmaSeries(h4Closes, 20);
  const h4Ema50 = computeEmaSeries(h4Closes, 50);
  const h4Atr = computeAtrSeries(h4Rows, 14);
  const h4Rsi = computeRsiSeries(h4Closes, 14);

  // Align breadth onto rows causally via monotonic pointer
  const breadthRows = breadthCtx?.rows ?? null;
  let bPtr = -1;

  const regime = new Array(n);
  const trendScore = new Float64Array(n);
  const d1Ema50DistAtr = new Float64Array(n);
  const d1Ema200DistAtr = new Float64Array(n);
  const d1SlopeAtr = new Float64Array(n);
  const breadthBearRatio = new Float64Array(n);
  const h4RallyExh = new Uint8Array(n);
  const longPriority = new Float64Array(n);
  const shortPriority = new Float64Array(n);
  const longSizeMult = new Float64Array(n);
  const shortSizeMult = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const t = rows[i].time;
    const dj = d1Aligned[i];
    const hj = h4Aligned[i];
    const fr = fundingRates[i];

    let bearRatio = 0.5;
    if (breadthRows) {
      while (bPtr + 1 < breadthRows.length && breadthRows[bPtr + 1].closeTime <= t) {
        bPtr++;
      }
      bearRatio = bPtr >= 0 ? breadthRows[bPtr].breadthBearEma50 : 0.5;
    } else if (dj >= 0) {
      bearRatio = d1Rows[dj].close < d1Ema50[dj] ? 1.0 : 0.0;
    }

    if (dj < 0 || hj < 0) {
      regime[i] = CRYPTO_REGIMES_V8.RANGE_CHOP;
      trendScore[i] = 0;
      d1Ema50DistAtr[i] = 0;
      d1Ema200DistAtr[i] = 0;
      d1SlopeAtr[i] = 0;
      breadthBearRatio[i] = bearRatio;
      h4RallyExh[i] = 0;
      longPriority[i] = 0.5;
      shortPriority[i] = 0.5;
      longSizeMult[i] = 0.65;
      shortSizeMult[i] = 0.65;
      continue;
    }

    const d1Close = d1Rows[dj].close;
    const d1E50 = d1Ema50[dj];
    const d1E200 = d1Ema200[dj];
    const d1A = d1Atr[dj];
    const d1Slope20 = dj >= 20 ? d1Ema20[dj] - d1Ema20[dj - 20] : d1Ema20[dj] - d1Ema20[0];

    const dist50 = (d1Close - d1E50) / d1A;
    const dist200 = (d1Close - d1E200) / d1A;
    const slopeA = d1Slope20 / d1A;

    const h4Bar = h4Rows[hj];
    const h4Close = h4Bar.close;
    const h4E20 = h4Ema20[hj];
    const h4A = h4Atr[hj];
    const h4R = h4Rsi[hj];
    const h4Body = h4Close - h4Bar.open;
    const h4Z = (h4Close - h4E20) / h4A;

    const isD1Bear = d1Close < d1E50;
    const isSqueeze = isD1Bear && (
      (h4Z > 0.7 && h4Body > 0) ||
      (h4Close > h4E20 && h4R > 58 && fr <= -0.0001)
    );

    let reg;
    if (isSqueeze) {
      reg = CRYPTO_REGIMES_V8.BEAR_SQUEEZE;
    } else if (isD1Bear && (d1Slope20 <= 0 || bearRatio >= 0.5)) {
      reg = CRYPTO_REGIMES_V8.BEAR_TREND;
    } else if (d1Close > d1E50 && (d1Slope20 >= 0 || bearRatio <= 0.25)) {
      reg = CRYPTO_REGIMES_V8.BULL_TREND;
    } else {
      reg = CRYPTO_REGIMES_V8.RANGE_CHOP;
    }

    const rallyBounceTouched = hj >= 1
      ? (h4Bar.high >= h4E20 * 0.995 || h4Rows[hj - 1].high >= h4Ema20[hj - 1] * 0.995)
      : h4Bar.high >= h4E20 * 0.995;
    const rallyStalling = hj >= 1
      ? (h4Close < h4Bar.open || h4Close < h4Rows[hj - 1].close)
      : (h4Close < h4Bar.open);
    const exh = (isD1Bear && !isSqueeze && rallyBounceTouched && rallyStalling) ? 1 : 0;

    const rawScore = 0.45 * Math.tanh(dist50 * 0.6) + 0.30 * Math.tanh(slopeA * 0.8) + 0.25 * (1 - 2 * bearRatio);
    const clampedScore = Math.max(-1, Math.min(1, rawScore));

    regime[i] = reg;
    trendScore[i] = clampedScore;
    d1Ema50DistAtr[i] = dist50;
    d1Ema200DistAtr[i] = dist200;
    d1SlopeAtr[i] = slopeA;
    breadthBearRatio[i] = bearRatio;
    h4RallyExh[i] = exh;

    if (reg === CRYPTO_REGIMES_V8.BULL_TREND) {
      longPriority[i] = 1.0;
      shortPriority[i] = 0.0;
      longSizeMult[i] = 1.15;
      shortSizeMult[i] = 0.4;
    } else if (reg === CRYPTO_REGIMES_V8.BEAR_TREND) {
      longPriority[i] = 0.0;
      shortPriority[i] = 1.0;
      longSizeMult[i] = 0.35;
      shortSizeMult[i] = 1.15;
    } else if (reg === CRYPTO_REGIMES_V8.BEAR_SQUEEZE) {
      longPriority[i] = 0.0;
      shortPriority[i] = 0.0;
      longSizeMult[i] = 0.4;
      shortSizeMult[i] = 0.0;
    } else {
      longPriority[i] = 0.5;
      shortPriority[i] = 0.5;
      longSizeMult[i] = 0.65;
      shortSizeMult[i] = 0.65;
    }
  }

  function getRegimeAt(i) {
    assert.ok(Number.isSafeInteger(i) && i >= 0 && i < n, `Index out of range: ${i}`);
    const dj = d1Aligned[i];
    const hj = h4Aligned[i];
    return {
      index: i,
      time: rows[i].time,
      regime: regime[i],
      trendScore: trendScore[i],
      d1Ema50DistAtr: d1Ema50DistAtr[i],
      d1Ema200DistAtr: d1Ema200DistAtr[i],
      d1SlopeAtr: d1SlopeAtr[i],
      breadthBearRatio: breadthBearRatio[i],
      h4RallyExh: h4RallyExh[i],
      longPriority: longPriority[i],
      shortPriority: shortPriority[i],
      longSizeMult: longSizeMult[i],
      shortSizeMult: shortSizeMult[i],
      d1Close: dj >= 0 ? d1Rows[dj].close : null,
      d1Ema50: dj >= 0 ? d1Ema50[dj] : null,
      d1Ema200: dj >= 0 ? d1Ema200[dj] : null,
      h4Close: hj >= 0 ? h4Rows[hj].close : null,
      h4Ema20: hj >= 0 ? h4Ema20[hj] : null,
      h4Ema50: hj >= 0 ? h4Ema50[hj] : null,
      h4Rsi: hj >= 0 ? h4Rsi[hj] : null,
      fundingRate: fundingRates[i],
    };
  }

  return {
    length: n,
    regime,
    trendScore,
    d1Ema50DistAtr,
    d1Ema200DistAtr,
    d1SlopeAtr,
    breadthBearRatio,
    h4RallyExh,
    longPriority,
    shortPriority,
    longSizeMult,
    shortSizeMult,
    getRegimeAt,
  };
}

function alignMacroSeriesToDaily(stockRows, macroRows) {
  const n = stockRows.length;
  const out = new Array(n);
  if (!Array.isArray(macroRows) || macroRows.length === 0) {
    out.fill(null);
    return out;
  }
  let j = -1;
  for (let i = 0; i < n; i++) {
    const t = stockRows[i].time;
    while (j + 1 < macroRows.length && macroRows[j + 1].time <= t) {
      j++;
    }
    out[i] = j >= 0 ? macroRows[j] : null;
  }
  return out;
}

/**
 * Strictly causal US Equity regime engine using SMA200, SMA50, 20d slope, ^VIX level & 5d spike, and ^TNX 20d shock.
 */
export function precomputeEquityRegimeV8(stockDataset, macroDataset = null) {
  assert.ok(stockDataset && Array.isArray(stockDataset.rows) && stockDataset.rows.length > 0,
    'Expected stockDataset with rows');
  const rows = stockDataset.rows;
  const n = rows.length;
  const closes = rows.map(r => r.close);

  const sma50 = computeSmaSeries(closes, 50);
  const sma200 = computeSmaSeries(closes, 200);
  const atr14 = computeAtrSeries(rows, 14);

  let vixAligned;
  let tnxAligned;
  if (macroDataset && (macroDataset.vixRows || macroDataset.tnxRows)) {
    vixAligned = alignMacroSeriesToDaily(rows, macroDataset.vixRows ?? []);
    tnxAligned = alignMacroSeriesToDaily(rows, macroDataset.tnxRows ?? []);
  } else if (stockDataset.macroAligned) {
    vixAligned = stockDataset.macroAligned.vix ?? new Array(n).fill(null);
    tnxAligned = stockDataset.macroAligned.tnx ?? new Array(n).fill(null);
  } else {
    vixAligned = new Array(n).fill(null);
    tnxAligned = new Array(n).fill(null);
  }

  const regime = new Array(n);
  const trendScore = new Float64Array(n);
  const vixLevel = new Float64Array(n);
  const vixSpike5d = new Float64Array(n);
  const tnxLevel = new Float64Array(n);
  const tnxShock20d = new Float64Array(n);
  const slope20Arr = new Float64Array(n);
  const longSizeMult = new Float64Array(n);
  const shortSizeMult = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const close = closes[i];
    const s50 = sma50[i];
    const s200 = sma200[i];
    const refSma200 = i >= 199 ? s200 : s50;
    const slope20 = i >= 20 ? s50 - sma50[i - 20] : s50 - sma50[0];
    slope20Arr[i] = slope20;

    const vCur = vixAligned[i]?.close ?? 18;
    const vPrev5 = i >= 5 && vixAligned[i - 5] ? vixAligned[i - 5].close : vCur;
    const vSpike = vCur - vPrev5;

    const tCur = tnxAligned[i]?.close ?? 3.5;
    const tPrev20 = i >= 20 && tnxAligned[i - 20] ? tnxAligned[i - 20].close : tCur;
    const tShock = tCur - tPrev20;

    vixLevel[i] = vCur;
    vixSpike5d[i] = vSpike;
    tnxLevel[i] = tCur;
    tnxShock20d[i] = tShock;

    const isBear = (close < refSma200 && (slope20 <= 0 || close < s50)) || (close < s50 && vCur >= 26);
    const isHighVolChop = !isBear && (vCur >= 28 || vSpike >= 6 || Math.abs(tShock) >= 0.45);

    let reg;
    if (isBear) {
      reg = EQUITY_REGIMES_V8.BEAR_TREND;
      longSizeMult[i] = 0.35;
      shortSizeMult[i] = 1.05;
    } else if (isHighVolChop) {
      reg = EQUITY_REGIMES_V8.HIGH_VOL_CHOP;
      longSizeMult[i] = 0.6;
      shortSizeMult[i] = 0.6;
    } else {
      reg = EQUITY_REGIMES_V8.BULL_TREND;
      longSizeMult[i] = 1.1;
      shortSizeMult[i] = 0.35;
    }
    regime[i] = reg;

    const dist200Atr = (close - refSma200) / atr14[i];
    const vixPenalty = Math.max(0, (vCur - 20) / 15);
    trendScore[i] = Math.max(-1, Math.min(1, Math.tanh(dist200Atr * 0.4) - 0.35 * vixPenalty));
  }

  function getRegimeAt(i) {
    assert.ok(Number.isSafeInteger(i) && i >= 0 && i < n, `Index out of range: ${i}`);
    return {
      index: i,
      time: rows[i].time,
      date: rows[i].date ?? null,
      regime: regime[i],
      trendScore: trendScore[i],
      sma50: sma50[i],
      sma200: sma200[i],
      slope20: slope20Arr[i],
      vixLevel: vixLevel[i],
      vixSpike5d: vixSpike5d[i],
      tnxLevel: tnxLevel[i],
      tnxShock20d: tnxShock20d[i],
      longSizeMult: longSizeMult[i],
      shortSizeMult: shortSizeMult[i],
    };
  }

  return {
    length: n,
    regime,
    trendScore,
    vixLevel,
    vixSpike5d,
    tnxLevel,
    tnxShock20d,
    longSizeMult,
    shortSizeMult,
    getRegimeAt,
  };
}
