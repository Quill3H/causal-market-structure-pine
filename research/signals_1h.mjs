import assert from 'node:assert/strict';
import { simulateTrades } from './sim_engine.mjs';

export const DEFAULT_WARMUP_1H = 250;

export function sliceDatasetPrefix1h(dataset, endLength) {
  assert.ok(dataset && Array.isArray(dataset.rows), 'Expected dataset with rows');
  assert.ok(Number.isSafeInteger(endLength) && endLength > 0 && endLength <= dataset.rows.length,
    `Invalid slice endLength: ${endLength}`);
  const rows = dataset.rows.slice(0, endLength);
  const lastTime = rows[rows.length - 1].time;
  const htf = {};
  for (const [tf, h] of Object.entries(dataset.htf ?? {})) {
    const alignedIndex = h.alignedIndex.slice(0, endLength);
    const maxAllowed = alignedIndex[alignedIndex.length - 1];
    const hRows = [];
    for (let j = 0; j < h.rows.length; j++) {
      if (j <= maxAllowed && h.rows[j].time + h.intervalSeconds <= lastTime) {
        hRows.push(h.rows[j]);
      } else {
        break;
      }
    }
    htf[tf] = {
      ...h,
      rows: hRows,
      alignedIndex,
    };
  }
  return {
    ...dataset,
    count: rows.length,
    lastTime,
    rows,
    htf,
  };
}

function validateDataset1h(dataset) {
  assert.ok(dataset && typeof dataset === 'object', 'Expected dataset object');
  const { rows, intervalSeconds, htf } = dataset;
  assert.ok(Array.isArray(rows) && rows.length > 0, 'Expected non-empty rows');
  assert.equal(intervalSeconds, 3600, `Expected 1h intervalSeconds=3600, got ${intervalSeconds}`);
  assert.ok(htf && htf['4h'], 'Expected aligned 4h HTF data in dataset.htf["4h"]');
  const h4 = htf['4h'];
  assert.ok(Array.isArray(h4.rows) && h4.rows.length > 0, 'Expected non-empty 4h rows');
  assert.ok(Array.isArray(h4.alignedIndex) && h4.alignedIndex.length >= rows.length,
    'Expected 4h alignedIndex covering rows');

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (i > 0) {
      assert.equal(r.time - rows[i - 1].time, 3600, `Non-contiguous 1h timestamp at row ${i}`);
    }
    const j4 = h4.alignedIndex[i];
    assert.ok(Number.isSafeInteger(j4) && j4 >= 0 && j4 < h4.rows.length, `Invalid 4h alignedIndex at ${i}`);
    assert.ok(h4.rows[j4].time + h4.intervalSeconds <= r.time,
      `Lookahead violation in 4h alignment at row ${i}`);
  }
  if (htf['1d']) {
    const h1d = htf['1d'];
    assert.ok(Array.isArray(h1d.rows) && h1d.rows.length > 0, 'Expected non-empty 1d rows');
    assert.ok(Array.isArray(h1d.alignedIndex) && h1d.alignedIndex.length >= rows.length,
      'Expected 1d alignedIndex covering rows');
    for (let i = 0; i < rows.length; i++) {
      const j1d = h1d.alignedIndex[i];
      assert.ok(Number.isSafeInteger(j1d) && j1d >= 0 && j1d < h1d.rows.length, `Invalid 1d alignedIndex at ${i}`);
      assert.ok(h1d.rows[j1d].time + h1d.intervalSeconds <= rows[i].time,
        `Lookahead violation in 1d alignment at row ${i}`);
    }
  }
}

export function calcPineEma(values, length) {
  assert.ok(Number.isSafeInteger(length) && length >= 1, 'Invalid EMA length');
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  const alpha = 2 / (length + 1);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (i < length - 1) {
      sum += v;
    } else if (i === length - 1) {
      sum += v;
      out[i] = sum / length;
    } else {
      out[i] = out[i - 1] + alpha * (v - out[i - 1]);
    }
  }
  return out;
}

export function calcPineAtr(rows, length = 14) {
  assert.ok(Number.isSafeInteger(length) && length >= 1, 'Invalid ATR length');
  const n = rows.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const prevClose = i === 0 ? r.close : rows[i - 1].close;
    const tr = Math.max(
      r.high - r.low,
      Math.abs(r.high - prevClose),
      Math.abs(r.low - prevClose),
    );
    if (i < length - 1) {
      sum += tr;
    } else if (i === length - 1) {
      sum += tr;
      out[i] = sum / length;
    } else {
      out[i] = out[i - 1] + (tr - out[i - 1]) / length;
    }
  }
  return out;
}

export function computeOhlcFeatures1h(rows) {
  const n = rows.length;
  const closes = rows.map(r => r.close);
  const ema20 = calcPineEma(closes, 20);
  const ema50 = calcPineEma(closes, 50);
  const atr14 = calcPineAtr(rows, 14);
  const atrSma50 = new Float64Array(n).fill(NaN);
  const rvol20 = new Float64Array(n).fill(NaN);
  const adx14 = new Float64Array(n).fill(NaN);
  const er10 = new Float64Array(n).fill(NaN);
  const prevHigh5 = new Float64Array(n);
  const prevLow5 = new Float64Array(n);
  const prevHigh10 = new Float64Array(n);
  const prevLow10 = new Float64Array(n);
  const prevHigh14 = new Float64Array(n);
  const prevLow14 = new Float64Array(n);
  const prevHigh16 = new Float64Array(n);
  const prevLow16 = new Float64Array(n);
  const prevHigh18 = new Float64Array(n);
  const prevLow18 = new Float64Array(n);
  const prevHigh20 = new Float64Array(n);
  const prevLow20 = new Float64Array(n);

  let atrWindowSum = 0;
  let volSum20 = 0;
  let absDiffSum10 = 0;
  let plusDm = 0;
  let minusDm = 0;
  let trDm = 0;
  let dxSum = 0;
  let curAdx = 0;

  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const prev = rows[i - 1];

    const tr = i === 0
      ? r.high - r.low
      : Math.max(r.high - r.low, Math.abs(r.high - prev.close), Math.abs(r.low - prev.close));

    if (i > 0) {
      absDiffSum10 += Math.abs(r.close - prev.close);
      if (i > 10) absDiffSum10 -= Math.abs(rows[i - 10].close - rows[i - 11].close);
      if (i >= 10) {
        er10[i] = absDiffSum10 > 0 ? Math.abs(r.close - rows[i - 10].close) / absDiffSum10 : 0;
      }
    }

    if (i >= 13) {
      atrWindowSum += atr14[i];
      if (i >= 63) atrWindowSum -= atr14[i - 50];
      atrSma50[i] = i >= 62 ? atrWindowSum / 50 : NaN;
    }

    rvol20[i] = i >= 20 && volSum20 > 0 ? r.volume / (volSum20 / 20) : NaN;
    volSum20 += r.volume;
    if (i >= 20) volSum20 -= rows[i - 20].volume;

    if (i > 0) {
      const hm = r.high - prev.high;
      const lm = prev.low - r.low;
      const pos = hm > lm && hm > 0 ? hm : 0;
      const neg = lm > hm && lm > 0 ? lm : 0;
      if (i <= 14) {
        plusDm += pos / 14;
        minusDm += neg / 14;
        trDm += tr / 14;
      } else {
        plusDm += (pos - plusDm) / 14;
        minusDm += (neg - minusDm) / 14;
        trDm += (tr - trDm) / 14;
      }
      if (i >= 14) {
        const pdi = trDm === 0 ? 0 : (100 * plusDm) / trDm;
        const mdi = trDm === 0 ? 0 : (100 * minusDm) / trDm;
        const dx = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
        if (i <= 27) dxSum += dx / 14;
        if (i === 27) curAdx = dxSum;
        else if (i > 27) curAdx += (dx - curAdx) / 14;
      }
    }
    adx14[i] = i >= 27 ? curAdx : NaN;

    for (const [len, hArr, lArr] of [
      [5, prevHigh5, prevLow5],
      [10, prevHigh10, prevLow10],
      [14, prevHigh14, prevLow14],
      [16, prevHigh16, prevLow16],
      [18, prevHigh18, prevLow18],
      [20, prevHigh20, prevLow20],
    ]) {
      if (i === 0) {
        hArr[i] = NaN;
        lArr[i] = NaN;
      } else {
        let hi = -Infinity;
        let lo = Infinity;
        const start = Math.max(0, i - len);
        for (let j = start; j < i; j++) {
          if (rows[j].high > hi) hi = rows[j].high;
          if (rows[j].low < lo) lo = rows[j].low;
        }
        hArr[i] = hi;
        lArr[i] = lo;
      }
    }
  }

  return {
    ema20,
    ema50,
    atr14,
    atrSma50,
    rvol20,
    adx14,
    er10,
    prevHigh: { 5: prevHigh5, 10: prevHigh10, 14: prevHigh14, 16: prevHigh16, 18: prevHigh18, 20: prevHigh20 },
    prevLow: { 5: prevLow5, 10: prevLow10, 14: prevLow14, 16: prevLow16, 18: prevLow18, 20: prevLow20 },
  };
}

function htfBiasAllowed(htfMode, h4Row, h4Ema20, h4Ema50, d1Row, d1Ema20, d1Ema50) {
  if (htfMode === 'D1_20_D50_H4_50') {
    return {
      bull: Boolean(d1Row) && d1Row.close > d1Ema20 && d1Row.close > d1Ema50 && h4Row.close > h4Ema50,
      bear: Boolean(d1Row) && d1Row.close < d1Ema20 && d1Row.close < d1Ema50 && h4Row.close < h4Ema50,
    };
  }
  if (htfMode === 'D1_20_and_H4_50') {
    return {
      bull: Boolean(d1Row) && d1Row.close > d1Ema20 && h4Row.close > h4Ema50,
      bear: Boolean(d1Row) && d1Row.close < d1Ema20 && h4Row.close < h4Ema50,
    };
  }
  if (htfMode === 'H4_20_or_50') {
    return {
      bull: h4Row.close > h4Ema50 || h4Row.close > h4Ema20,
      bear: h4Row.close < h4Ema50 || h4Row.close < h4Ema20,
    };
  }
  if (htfMode === 'H4_20') {
    return {
      bull: h4Row.close > h4Ema20,
      bear: h4Row.close < h4Ema20,
    };
  }
  if (htfMode === 'H4_50') {
    return {
      bull: h4Row.close > h4Ema50,
      bear: h4Row.close < h4Ema50,
    };
  }
  if (htfMode === 'H4_or_D1_20') {
    return {
      bull: h4Row.close > h4Ema20 || (Boolean(d1Row) && d1Row.close > d1Ema20),
      bear: h4Row.close < h4Ema20 || (Boolean(d1Row) && d1Row.close < d1Ema20),
    };
  }
  throw new Error(`Unknown htfMode: ${htfMode}`);
}

function countH4Cross30(h4Rows, h4Ema50, j4) {
  let cr = 0;
  const start = Math.max(1, j4 - 29);
  for (let k = start; k <= j4; k++) {
    if ((h4Rows[k].close > h4Ema50[k]) !== (h4Rows[k - 1].close > h4Ema50[k - 1])) cr++;
  }
  return cr;
}

export function generateSignals1h(dataset, config, precomputed = null) {
  validateDataset1h(dataset);

  if (config.family === 'AdaptiveTrapPolarity') {
    const warmup = config.warmup ?? DEFAULT_WARMUP_1H;
    const rawSpec = {
      specId: config.baseSpecId ?? config.baseFamily,
      family: config.baseFamily,
      lookback: config.lookback,
      trapMaxBars: config.trapMaxBars,
      p4Lookback: config.p4Lookback ?? 10,
      includePdhl: config.includePdhl ?? false,
      maxD1Atr: config.maxD1Atr ?? null,
      maxH4Cross30: config.maxH4Cross30 ?? null,
      requireH4Slope20: config.requireH4Slope20 ?? false,
      htfMode: config.htfMode,
      d1Er10Min: config.d1Er10Min ?? null,
      limitOffsetAtr: config.limitOffsetAtr ?? 0,
      warmup,
    };
    const rawKey = `${rawSpec.family}:${rawSpec.lookback}:${rawSpec.trapMaxBars}:${rawSpec.p4Lookback}:${rawSpec.includePdhl ? 1 : 0}:${rawSpec.htfMode}:${rawSpec.limitOffsetAtr}:${warmup}`;
    const rawSignals = precomputed?.rawSignalsByKey?.get(rawKey) ?? generateSignals1h(dataset, rawSpec, precomputed);
    if (precomputed?.rawSignalsByKey && !precomputed.rawSignalsByKey.has(rawKey)) {
      precomputed.rawSignalsByKey.set(rawKey, rawSignals);
    }

    const v = config.virtExec;
    const virtKey = `${rawKey}|${v.entryMode}|${v.stopAtr}|${v.minStopPct}|${v.rewardRisk}|${v.maxHoldBars}|${v.beTriggerR}|${v.beOffsetPct}|${v.cooldown}|${v.limitExpiryBars}|${v.costPct}|${v.slippagePct}`;
    let virtTrades = precomputed?.virtTradesByKey?.get(virtKey);
    if (!virtTrades) {
      virtTrades = simulateTrades(dataset.rows, rawSignals, {
        ...v,
        start: 0,
        end: dataset.rows.length,
        intervalSeconds: dataset.intervalSeconds,
      }).trades;
      if (precomputed?.virtTradesByKey) {
        precomputed.virtTradesByKey.set(virtKey, virtTrades);
      }
    }

    const exitsByBar = new Map();
    for (let tIdx = 0; tIdx < virtTrades.length; tIdx++) {
      const t = virtTrades[tIdx];
      let list = exitsByBar.get(t.exitIndex);
      if (!list) {
        list = [];
        exitsByBar.set(t.exitIndex, list);
      }
      list.push(t);
    }
    const rawByBar = new Map();
    for (let rIdx = 0; rIdx < rawSignals.length; rIdx++) {
      rawByBar.set(rawSignals[rIdx].barIndex, rawSignals[rIdx]);
    }

    const sharedHist = [];
    const histBySide = { 1: [], [-1]: [] };
    const signals = [];
    const minHistLen = Math.min(config.slThresh, config.winLen);

    for (let i = 0; i < dataset.rows.length; i++) {
      const settled = exitsByBar.get(i);
      if (settled) {
        for (let k = 0; k < settled.length; k++) {
          const t = settled[k];
          if (config.sharedHistory) {
            sharedHist.push(t);
            if (sharedHist.length > config.winLen) sharedHist.shift();
          } else {
            const arr = histBySide[t.side];
            arr.push(t);
            if (arr.length > config.winLen) arr.shift();
          }
        }
      }
      const rawSig = rawByBar.get(i);
      if (!rawSig) continue;

      const hist = config.sharedHistory ? sharedHist : histBySide[rawSig.side];
      let slCount = 0;
      let netSum = 0;
      for (let k = 0; k < hist.length; k++) {
        if (hist[k].exitReason === 'SL') slCount++;
        netSum += hist[k].netPct;
      }
      const shouldFlip = hist.length >= minHistLen &&
        slCount >= config.slThresh &&
        (!config.requireNegNet || netSum < 0);
      const side = shouldFlip ? -rawSig.side : rawSig.side;
      const sig = { barIndex: i, side, atr: rawSig.atr };
      if ((config.limitOffsetAtr ?? 0) > 0) {
        const limitPrice = dataset.rows[i].close - side * config.limitOffsetAtr * rawSig.atr;
        if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
        sig.limitPrice = limitPrice;
      }
      signals.push(sig);
    }
    return signals;
  }

  const { rows, htf } = dataset;
  const h4Rows = htf['4h'].rows;
  const h4Idx = htf['4h'].alignedIndex;
  const d1Rows = htf['1d']?.rows ?? null;
  const d1Idx = htf['1d']?.alignedIndex ?? null;

  const f1 = precomputed?.f1 ?? computeOhlcFeatures1h(rows);
  const f4 = precomputed?.f4 ?? computeOhlcFeatures1h(h4Rows);
  const fD = precomputed?.fD ?? (d1Rows ? computeOhlcFeatures1h(d1Rows) : null);

  const warmup = config.warmup ?? DEFAULT_WARMUP_1H;
  const signals = [];

  for (let i = warmup; i < rows.length; i++) {
    const r = rows[i];
    const prev = rows[i - 1];
    const c = r.close;
    const atr = f1.atr14[i];
    if (!Number.isFinite(atr) || atr <= 0) continue;

    const j4 = h4Idx[i];
    const h4Row = h4Rows[j4];
    const h4Ema20 = f4.ema20[j4];
    const h4Ema50 = f4.ema50[j4];
    const jD = d1Idx ? d1Idx[i] : null;
    const d1Row = jD !== null ? d1Rows[jD] : null;
    const d1Ema20 = jD !== null ? fD.ema20[jD] : NaN;
    const d1Ema50 = jD !== null ? fD.ema50[jD] : NaN;
    const htfBias = htfBiasAllowed(config.htfMode, h4Row, h4Ema20, h4Ema50, d1Row, d1Ema20, d1Ema50);

    let bull = false;
    let bear = false;

    const detectTrap = (N, K) => {
      const pHigh = f1.prevHigh[N];
      const pLow = f1.prevLow[N];
      let bullTrap = false;
      let bearTrap = false;
      for (let k = 1; k <= K; k++) {
        if (i - k < N) continue;
        const levelL = pLow[i - k];
        const levelH = pHigh[i - k];
        let allBelow = true;
        let allAbove = true;
        for (let m = 1; m <= k; m++) {
          if (!(rows[i - m].close < levelL)) allBelow = false;
          if (!(rows[i - m].close > levelH)) allAbove = false;
        }
        if (allBelow && c > levelL && c > r.open) bullTrap = true;
        if (allAbove && c < levelH && c < r.open) bearTrap = true;
      }
      return { bullTrap, bearTrap };
    };

    const detectSqueeze = (sqN, sqRatio, minRvol, minBodyAtr) => {
      const prevAtr = f1.atr14[i - 1];
      const prevAtrSma = f1.atrSma50[i - 1];
      const rv = f1.rvol20[i];
      const sqReady = Number.isFinite(prevAtr) && Number.isFinite(prevAtrSma) && prevAtrSma > 0 &&
        prevAtr / prevAtrSma < sqRatio && Number.isFinite(rv) && rv >= minRvol;
      const brkB = sqReady && c > f1.prevHigh[sqN][i] && prev.close <= f1.prevHigh[sqN][i - 1] &&
        (c - r.open) >= minBodyAtr * atr;
      const brkS = sqReady && c < f1.prevLow[sqN][i] && prev.close >= f1.prevLow[sqN][i - 1] &&
        (r.open - c) >= minBodyAtr * atr;
      return { brkB, brkS };
    };

    const d1ErOk = config.d1Er10Min == null ||
      (jD !== null && Number.isFinite(fD.er10[jD]) && fD.er10[jD] >= config.d1Er10Min);

    if (config.family === 'HtfTrapReclaim') {
      const { bullTrap, bearTrap } = detectTrap(config.lookback, config.trapMaxBars);
      bull = bullTrap && htfBias.bull && d1ErOk;
      bear = bearTrap && htfBias.bear && d1ErOk;
    } else if (config.family === 'HtfTrapOrSqueeze') {
      const { bullTrap, bearTrap } = detectTrap(config.lookback, config.trapMaxBars);
      const { brkB, brkS } = detectSqueeze(config.sqLookback, config.squeezeRatio, config.minRvol, config.minBodyAtr);
      bull = (bullTrap || brkB) && htfBias.bull;
      bear = (bearTrap || brkS) && htfBias.bear;
    } else if (config.family === 'HtfSqueezeBreakout') {
      const { brkB, brkS } = detectSqueeze(config.lookback, config.squeezeRatio, config.minRvol ?? 0, config.minBodyAtr ?? 0);
      bull = brkB && htfBias.bull;
      bear = brkS && htfBias.bear;
    } else if (config.family === 'HtfTrapSqKc') {
      const h4Cross = countH4Cross30(h4Rows, f4.ema50, j4);
      const h4SlopeOkBull = !config.requireH4Slope20 || (j4 >= 3 && h4Ema20 > f4.ema20[j4 - 3]);
      const h4SlopeOkBear = !config.requireH4Slope20 || (j4 >= 3 && h4Ema20 < f4.ema20[j4 - 3]);
      const d1Atr = jD !== null ? fD.atr14[jD] : NaN;
      const d1DistOkBull = config.maxD1Atr == null ||
        (Number.isFinite(d1Atr) && d1Atr > 0 && (d1Row.close - d1Ema20) / d1Atr <= config.maxD1Atr);
      const d1DistOkBear = config.maxD1Atr == null ||
        (Number.isFinite(d1Atr) && d1Atr > 0 && (d1Ema20 - d1Row.close) / d1Atr <= config.maxD1Atr);
      const chopOk = config.maxH4Cross30 == null || h4Cross <= config.maxH4Cross30;

      const { bullTrap, bearTrap } = detectTrap(config.lookback, config.trapMaxBars);
      const { brkB, brkS } = detectSqueeze(config.sqLookback, config.squeezeRatio, config.sqRvol, config.minBodyAtr);

      const prevAtr = f1.atr14[i - 1];
      const prevEma20 = f1.ema20[i - 1];
      const kcReady = Number.isFinite(prevAtr) && Number.isFinite(f1.rvol20[i]) && f1.rvol20[i] >= config.kcRvol;
      const kcUp = f1.ema20[i] + config.kcMult * atr;
      const kcDn = f1.ema20[i] - config.kcMult * atr;
      const kcUpPrev = prevEma20 + config.kcMult * prevAtr;
      const kcDnPrev = prevEma20 - config.kcMult * prevAtr;
      const kcBull = kcReady && prev.close < kcDnPrev && c > kcDn && c > r.open;
      const kcBear = kcReady && prev.close > kcUpPrev && c < kcUp && c < r.open;

      bull = (bullTrap || brkB || kcBull) && htfBias.bull && h4SlopeOkBull && d1DistOkBull && chopOk;
      bear = (bearTrap || brkS || kcBear) && htfBias.bear && h4SlopeOkBear && d1DistOkBear && chopOk;
    } else if (config.family === 'HtfSmcMultiTrap') {
      const h4Cross = countH4Cross30(h4Rows, f4.ema50, j4);
      const h4SlopeOkBull = !config.requireH4Slope20 || (j4 >= 3 && h4Ema20 > f4.ema20[j4 - 3]);
      const h4SlopeOkBear = !config.requireH4Slope20 || (j4 >= 3 && h4Ema20 < f4.ema20[j4 - 3]);
      const d1Atr = jD !== null ? fD.atr14[jD] : NaN;
      const d1DistOkBull = config.maxD1Atr == null ||
        (Number.isFinite(d1Atr) && d1Atr > 0 && (d1Row.close - d1Ema20) / d1Atr <= config.maxD1Atr);
      const d1DistOkBear = config.maxD1Atr == null ||
        (Number.isFinite(d1Atr) && d1Atr > 0 && (d1Ema20 - d1Row.close) / d1Atr <= config.maxD1Atr);
      const chopOk = config.maxH4Cross30 == null || h4Cross <= config.maxH4Cross30;

      const { bullTrap: b1h, bearTrap: s1h } = detectTrap(config.lookback, config.trapMaxBars);
      let b4h = false;
      let s4h = false;
      if (config.p4Lookback) {
        const p4H = f4.prevHigh[config.p4Lookback];
        const p4L = f4.prevLow[config.p4Lookback];
        for (let k = 1; k <= config.trapMaxBars; k++) {
          const j4k = h4Idx[i - k];
          if (j4k < config.p4Lookback) continue;
          const levelL = p4L[j4k];
          const levelH = p4H[j4k];
          let allBelow = true;
          let allAbove = true;
          for (let m = 1; m <= k; m++) {
            if (!(rows[i - m].close < levelL)) allBelow = false;
            if (!(rows[i - m].close > levelH)) allAbove = false;
          }
          if (allBelow && c > levelL && c > r.open) b4h = true;
          if (allAbove && c < levelH && c < r.open) s4h = true;
        }
      }

      let bPd = false;
      let sPd = false;
      if (config.includePdhl && d1Rows && d1Idx) {
        const pdK = Math.min(2, config.trapMaxBars);
        for (let k = 1; k <= pdK; k++) {
          const jDk = d1Idx[i - k];
          const levelL = d1Rows[jDk].low;
          const levelH = d1Rows[jDk].high;
          let allBelow = true;
          let allAbove = true;
          for (let m = 1; m <= k; m++) {
            if (!(rows[i - m].close < levelL)) allBelow = false;
            if (!(rows[i - m].close > levelH)) allAbove = false;
          }
          if (allBelow && c > levelL && c > r.open) bPd = true;
          if (allAbove && c < levelH && c < r.open) sPd = true;
        }
      }

      bull = (b1h || b4h || bPd) && htfBias.bull && h4SlopeOkBull && d1DistOkBull && chopOk && d1ErOk;
      bear = (s1h || s4h || sPd) && htfBias.bear && h4SlopeOkBear && d1DistOkBear && chopOk && d1ErOk;
    } else if (config.family === 'HtfSweepWick') {
      const N = config.lookback;
      const levelL = f1.prevLow[N][i];
      const levelH = f1.prevHigh[N][i];
      const range = r.high - r.low;
      const lw = Math.min(r.open, c) - r.low;
      const uw = r.high - Math.max(r.open, c);
      const swBull = range > 0 && r.low < levelL && c > levelL && c > r.open && lw >= 0.40 * range;
      const swBear = range > 0 && r.high > levelH && c < levelH && c < r.open && uw >= 0.40 * range;
      bull = swBull && htfBias.bull;
      bear = swBear && htfBias.bear;
    } else {
      throw new Error(`Unknown signal family: ${config.family}`);
    }

    if (bull === bear) continue;
    const side = bull ? 1 : -1;
    const sig = { barIndex: i, side, atr };
    if (config.limitOffsetAtr > 0) {
      const limitPrice = c - side * config.limitOffsetAtr * atr;
      if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
      sig.limitPrice = limitPrice;
    }
    signals.push(sig);
  }

  return signals;
}

export function buildSignalSpecs1h() {
  const specs = [];

  const baseRawSpecs = [];
  for (const limitOffsetAtr of [0.15, 0.18]) {
    baseRawSpecs.push({
      baseFamily: 'HtfSmcMultiTrap',
      lookback: 20,
      trapMaxBars: 4,
      p4Lookback: 10,
      includePdhl: true,
      htfMode: 'H4_50',
      limitOffsetAtr,
    });
  }

  const stopTiers = [
    { stopAtr: 3.2, minStopPct: 1.4 },
    { stopAtr: 3.5, minStopPct: 1.5 },
  ];
  const bePairs = [
    [0.43, 0.34],
  ];
  const adaptConfigs = [
    { winLen: 5, slThresh: 2, requireNegNet: true, sharedHistory: false },
    { winLen: 6, slThresh: 2, requireNegNet: true, sharedHistory: false },
  ];

  for (const base of baseRawSpecs) {
    const baseTag = `Multi:P4_${base.p4Lookback}:N${base.lookback}:K${base.trapMaxBars}:pd${base.includePdhl ? 1 : 0}`;
    const entryMode = 'LIMIT_PULLBACK';

    for (const tier of stopTiers) {
      for (const rewardRisk of [1.05, 1.15]) {
        for (const maxHoldBars of [84, 96]) {
          for (const [beTriggerR, beOffsetPct] of bePairs) {
            const cooldown = 4;
            const virtExec = {
              entryMode,
              limitExpiryBars: 6,
              pendingPolicy: 'ignore',
              limitSameBarTp: 'close',
              cooldown,
              warmup: DEFAULT_WARMUP_1H,
              stopAtr: tier.stopAtr,
              minStopPct: tier.minStopPct,
              rewardRisk,
              maxHoldBars,
              beTriggerR,
              beOffsetPct,
              costPct: 0.10,
              slippagePct: 0.025,
            };
            for (const ad of adaptConfigs) {
              const adTag = `w${ad.winLen}_sl${ad.slThresh}_${ad.requireNegNet ? 'neg' : 'all'}_${ad.sharedHistory ? 'sh' : 'ps'}`;
              const specId = `AdaptiveTrapPolarity:${baseTag}:${base.htfMode}:off${base.limitOffsetAtr}:${adTag}|s${tier.stopAtr}|m${tier.minStopPct}|rr${rewardRisk}|h${maxHoldBars}|be${beTriggerR}_${beOffsetPct}|cd${cooldown}`;
              specs.push({
                specId,
                family: 'AdaptiveTrapPolarity',
                ...base,
                maxD1Atr: null,
                maxH4Cross30: null,
                requireH4Slope20: false,
                d1Er10Min: null,
                virtExec,
                ...ad,
              });
            }
          }
        }
      }
    }
  }

  // Minimal representative specs for non-adaptive families (causality test coverage)
  specs.push({
    specId: 'HtfTrapReclaim:N20:K4:H4_50:off0.15',
    family: 'HtfTrapReclaim',
    lookback: 20,
    trapMaxBars: 4,
    htfMode: 'H4_50',
    d1Er10Min: null,
    limitOffsetAtr: 0.15,
  });
  specs.push({
    specId: 'HtfSmcMultiTrap:P4_10:N20:K4:pd1:H4_50:off0.15',
    family: 'HtfSmcMultiTrap',
    lookback: 20,
    p4Lookback: 10,
    trapMaxBars: 4,
    includePdhl: true,
    maxD1Atr: null,
    maxH4Cross30: null,
    requireH4Slope20: false,
    htfMode: 'H4_50',
    d1Er10Min: null,
    limitOffsetAtr: 0.15,
  });
  specs.push({
    specId: 'HtfTrapSqKc:N20:K3:Sq14:rv1.2:KC1.8:d1Max2:cr5:off0',
    family: 'HtfTrapSqKc',
    lookback: 20,
    trapMaxBars: 3,
    sqLookback: 14,
    squeezeRatio: 0.85,
    sqRvol: 1.2,
    minBodyAtr: 0.25,
    kcMult: 1.8,
    kcRvol: 1.0,
    requireH4Slope20: true,
    maxD1Atr: 2.0,
    maxH4Cross30: 5,
    htfMode: 'D1_20_and_H4_50',
    limitOffsetAtr: 0,
  });
  specs.push({
    specId: 'HtfTrapOrSqueeze:N20:K3:Sq14:rv1:D1_20_and_H4_50:off0',
    family: 'HtfTrapOrSqueeze',
    lookback: 20,
    trapMaxBars: 3,
    sqLookback: 14,
    squeezeRatio: 0.85,
    minRvol: 1.0,
    minBodyAtr: 0.25,
    htfMode: 'D1_20_and_H4_50',
    limitOffsetAtr: 0,
  });
  specs.push({
    specId: 'HtfSqueezeBreakout:N14:sq0.85:D1_20_and_H4_50:off0',
    family: 'HtfSqueezeBreakout',
    lookback: 14,
    squeezeRatio: 0.85,
    minRvol: 1.0,
    minBodyAtr: 0.25,
    htfMode: 'D1_20_and_H4_50',
    limitOffsetAtr: 0,
  });
  specs.push({
    specId: 'HtfSweepWick:N20:D1_20_and_H4_50:off0',
    family: 'HtfSweepWick',
    lookback: 20,
    htfMode: 'D1_20_and_H4_50',
    limitOffsetAtr: 0,
  });

  return specs;
}

export function buildCandidateCatalog1h(dataset) {
  validateDataset1h(dataset);
  const precomputed = {
    f1: computeOhlcFeatures1h(dataset.rows),
    f4: computeOhlcFeatures1h(dataset.htf['4h'].rows),
    fD: dataset.htf['1d'] ? computeOhlcFeatures1h(dataset.htf['1d'].rows) : null,
    rawSignalsByKey: new Map(),
    virtTradesByKey: new Map(),
  };

  const specs = buildSignalSpecs1h();
  const candidates = [];
  for (const spec of specs) {
    if (spec.family !== 'AdaptiveTrapPolarity') continue;
    const signals = generateSignals1h(dataset, spec, precomputed);
    candidates.push({
      id: spec.specId,
      signalSpec: spec,
      execOptions: { ...spec.virtExec },
      signals,
    });
  }
  return candidates;
}
