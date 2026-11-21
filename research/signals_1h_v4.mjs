import assert from 'node:assert/strict';
import { simulateTrades } from './sim_engine.mjs';
import {
  DEFAULT_WARMUP_1H,
  calcPineAtr,
  calcPineEma,
  computeOhlcFeatures1h,
} from './signals_1h.mjs';
import { calcPineRsi } from './signals_15m.mjs';

function calcRollingHighLowExtra(rows, lengths) {
  const n = rows.length;
  const prevHigh = {};
  const prevLow = {};
  for (const len of lengths) {
    const hArr = new Float64Array(n).fill(NaN);
    const lArr = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n; i++) {
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
    prevHigh[len] = hArr;
    prevLow[len] = lArr;
  }
  return { prevHigh, prevLow };
}

function validateDataset1h(dataset) {
  assert.ok(dataset && Array.isArray(dataset.rows) && dataset.rows.length > 0, 'Expected non-empty 1h dataset');
  assert.equal(dataset.intervalSeconds, 3600, `Expected intervalSeconds=3600, got ${dataset.intervalSeconds}`);
  assert.ok(dataset.htf?.['4h']?.rows?.length > 0, 'Expected htf["4h"]');
}

export function precompute1hV4(dataset) {
  validateDataset1h(dataset);
  const rows = dataset.rows;
  const h4Rows = dataset.htf['4h'].rows;
  const d1Rows = dataset.htf['1d']?.rows ?? null;

  const f1 = computeOhlcFeatures1h(rows);
  const f1Extra = calcRollingHighLowExtra(rows, [6, 8, 12]);
  f1.prevHigh = { ...f1.prevHigh, ...f1Extra.prevHigh };
  f1.prevLow = { ...f1.prevLow, ...f1Extra.prevLow };
  f1.rsi14 = calcPineRsi(rows.map(r => r.close), 14);

  const f4 = computeOhlcFeatures1h(h4Rows);
  const f4Extra = calcRollingHighLowExtra(h4Rows, [6, 8, 12]);
  f4.prevHigh = { ...f4.prevHigh, ...f4Extra.prevHigh };
  f4.prevLow = { ...f4.prevLow, ...f4Extra.prevLow };
  f4.rsi14 = calcPineRsi(h4Rows.map(r => r.close), 14);

  const fD = d1Rows ? computeOhlcFeatures1h(d1Rows) : null;

  return {
    f1,
    f4,
    fD,
    rawCache: new Map(),
    virtCache: new Map(),
  };
}

function getHtfBias(htfMode, h4Row, h4Ema20, h4Ema50, d1Row, d1Ema20, d1Ema50) {
  if (htfMode === 'H4_50') {
    return {
      bull: Number.isFinite(h4Ema50) && h4Row.close > h4Ema50,
      bear: Number.isFinite(h4Ema50) && h4Row.close < h4Ema50,
    };
  }
  if (htfMode === 'H4_20') {
    return {
      bull: Number.isFinite(h4Ema20) && h4Row.close > h4Ema20,
      bear: Number.isFinite(h4Ema20) && h4Row.close < h4Ema20,
    };
  }
  if (htfMode === 'H4_20_or_50') {
    return {
      bull: (Number.isFinite(h4Ema50) && h4Row.close > h4Ema50) || (Number.isFinite(h4Ema20) && h4Row.close > h4Ema20),
      bear: (Number.isFinite(h4Ema50) && h4Row.close < h4Ema50) || (Number.isFinite(h4Ema20) && h4Row.close < h4Ema20),
    };
  }
  if (htfMode === 'H4_20_and_50') {
    return {
      bull: Number.isFinite(h4Ema20) && Number.isFinite(h4Ema50) && h4Row.close > h4Ema20 && h4Ema20 > h4Ema50,
      bear: Number.isFinite(h4Ema20) && Number.isFinite(h4Ema50) && h4Row.close < h4Ema20 && h4Ema20 < h4Ema50,
    };
  }
  if (htfMode === 'H4_or_D1_20') {
    return {
      bull: (Number.isFinite(h4Ema20) && h4Row.close > h4Ema20) || (Boolean(d1Row) && d1Row.close > d1Ema20),
      bear: (Number.isFinite(h4Ema20) && h4Row.close < h4Ema20) || (Boolean(d1Row) && d1Row.close < d1Ema20),
    };
  }
  if (htfMode === 'ANY') {
    return { bull: true, bear: true };
  }
  throw new Error(`Unknown htfMode: ${htfMode}`);
}

function detectLtfTrap(rows, f1, i, N, K) {
  const pHigh = f1.prevHigh[N];
  const pLow = f1.prevLow[N];
  const c = rows[i].close;
  const o = rows[i].open;
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
    if (allBelow && c > levelL && c > o) bullTrap = true;
    if (allAbove && c < levelH && c < o) bearTrap = true;
  }
  return { bullTrap, bearTrap };
}

function detectH4Trap(rows, h4Idx, f4, i, p4Lookback, K) {
  let b4h = false;
  let s4h = false;
  if (!p4Lookback) return { b4h, s4h };
  const p4H = f4.prevHigh[p4Lookback];
  const p4L = f4.prevLow[p4Lookback];
  const c = rows[i].close;
  const o = rows[i].open;
  for (let k = 1; k <= K; k++) {
    if (i - k < 0) continue;
    const j4k = h4Idx[i - k];
    if (j4k < p4Lookback) continue;
    const levelL = p4L[j4k];
    const levelH = p4H[j4k];
    let allBelow = true;
    let allAbove = true;
    for (let m = 1; m <= k; m++) {
      if (!(rows[i - m].close < levelL)) allBelow = false;
      if (!(rows[i - m].close > levelH)) allAbove = false;
    }
    if (allBelow && c > levelL && c > o) b4h = true;
    if (allAbove && c < levelH && c < o) s4h = true;
  }
  return { b4h, s4h };
}

function detectPdhlTrap(rows, d1Rows, d1Idx, i, maxK) {
  let bPd = false;
  let sPd = false;
  if (!d1Rows || !d1Idx) return { bPd, sPd };
  const c = rows[i].close;
  const o = rows[i].open;
  const pdK = Math.min(2, maxK);
  for (let k = 1; k <= pdK; k++) {
    if (i - k < 0) continue;
    const jDk = d1Idx[i - k];
    const levelL = d1Rows[jDk].low;
    const levelH = d1Rows[jDk].high;
    let allBelow = true;
    let allAbove = true;
    for (let m = 1; m <= k; m++) {
      if (!(rows[i - m].close < levelL)) allBelow = false;
      if (!(rows[i - m].close > levelH)) allAbove = false;
    }
    if (allBelow && c > levelL && c > o) bPd = true;
    if (allAbove && c < levelH && c < o) sPd = true;
  }
  return { bPd, sPd };
}

function applyAdaptivePolarity(dataset, rawSignals, config, precomputed) {
  const { winLen, slThresh, requireNegNet = true, sharedHistory = false, virtExec, limitOffsetAtr = 0 } = config;
  const rawKey = config.rawKey ?? JSON.stringify(rawSignals.map(s => [s.barIndex, s.side]));
  const vKey = `${rawKey}|${virtExec.entryMode}|${virtExec.limitExpiryBars}|${virtExec.stopAtr}|${virtExec.minStopPct}|${virtExec.rewardRisk}|${virtExec.maxHoldBars}|${virtExec.beTriggerR}|${virtExec.beOffsetPct}|${virtExec.lock2TriggerR ?? 0}|${virtExec.lock2OffsetR ?? 0}|${virtExec.trailTriggerR ?? 0}|${virtExec.trailAtrMult ?? 0}|${virtExec.cooldown}|${virtExec.costPct}|${virtExec.slippagePct}`;

  let virtTrades = precomputed?.virtCache?.get(vKey);
  if (!virtTrades) {
    virtTrades = simulateTrades(dataset.rows, rawSignals, {
      ...virtExec,
      start: 0,
      end: dataset.rows.length,
      intervalSeconds: dataset.intervalSeconds,
    }).trades;
    precomputed?.virtCache?.set(vKey, virtTrades);
  }

  const exitsByBar = new Map();
  for (const t of virtTrades) {
    let arr = exitsByBar.get(t.exitIndex);
    if (!arr) {
      arr = [];
      exitsByBar.set(t.exitIndex, arr);
    }
    arr.push(t);
  }
  const rawByBar = new Map(rawSignals.map(s => [s.barIndex, s]));

  const sharedHist = [];
  const histBySide = { 1: [], [-1]: [] };
  const signals = [];
  const minHistLen = Math.min(slThresh, winLen);

  for (let i = 0; i < dataset.rows.length; i++) {
    const settled = exitsByBar.get(i);
    if (settled) {
      for (const t of settled) {
        if (sharedHistory) {
          sharedHist.push(t);
          if (sharedHist.length > winLen) sharedHist.shift();
        } else {
          const arr = histBySide[t.side];
          arr.push(t);
          if (arr.length > winLen) arr.shift();
        }
      }
    }
    const rawSig = rawByBar.get(i);
    if (!rawSig) continue;

    const hist = sharedHistory ? sharedHist : histBySide[rawSig.side];
    let slCount = 0;
    let netSum = 0;
    for (const h of hist) {
      if (h.exitReason === 'SL') slCount++;
      netSum += h.netPct;
    }
    const shouldFlip = hist.length >= minHistLen &&
      slCount >= slThresh &&
      (!requireNegNet || netSum < 0);
    const side = shouldFlip ? -rawSig.side : rawSig.side;
    const sig = { barIndex: i, side, atr: rawSig.atr };
    if (limitOffsetAtr > 0) {
      const limitPrice = dataset.rows[i].close - side * limitOffsetAtr * rawSig.atr;
      if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
      sig.limitPrice = limitPrice;
    }
    signals.push(sig);
  }
  return signals;
}

function generateRaw1hV4Signals(dataset, cfg, precomputed) {
  const rows = dataset.rows;
  const h4Rows = dataset.htf['4h'].rows;
  const h4Idx = dataset.htf['4h'].alignedIndex;
  const d1Rows = dataset.htf['1d']?.rows ?? null;
  const d1Idx = dataset.htf['1d']?.alignedIndex ?? null;

  const f1 = precomputed.f1;
  const f4 = precomputed.f4;
  const fD = precomputed.fD;
  const warmup = cfg.warmup ?? DEFAULT_WARMUP_1H;
  const minAtrPct = cfg.minAtrPct ?? 0;
  const signals = [];

  for (let i = warmup; i < rows.length; i++) {
    const r = rows[i];
    const prev = rows[i - 1];
    const c = r.close;
    const atr = f1.atr14[i];
    if (!Number.isFinite(atr) || atr <= 0) continue;
    if (minAtrPct > 0 && (atr / c) * 100 < minAtrPct) continue;

    const j4 = h4Idx[i];
    const h4Row = h4Rows[j4];
    const h4Ema20 = f4.ema20[j4];
    const h4Ema50 = f4.ema50[j4];
    const jD = d1Idx ? d1Idx[i] : null;
    const d1Row = jD !== null ? d1Rows[jD] : null;
    const d1Ema20 = jD !== null ? fD.ema20[jD] : NaN;
    const d1Ema50 = jD !== null ? fD.ema50[jD] : NaN;

    const htfBias = getHtfBias(cfg.htfMode ?? 'H4_50', h4Row, h4Ema20, h4Ema50, d1Row, d1Ema20, d1Ema50);

    let bull = false;
    let bear = false;

    if (cfg.rawFamily === 'MultiTrap') {
      const { bullTrap: b1, bearTrap: s1 } = detectLtfTrap(rows, f1, i, cfg.lookback, cfg.trapMaxBars);
      const { b4h, s4h } = detectH4Trap(rows, h4Idx, f4, i, cfg.p4Lookback, cfg.trapMaxBars);
      const { bPd, sPd } = cfg.includePdhl ? detectPdhlTrap(rows, d1Rows, d1Idx, i, cfg.trapMaxBars) : { bPd: false, sPd: false };
      bull = (b1 || b4h || bPd) && htfBias.bull;
      bear = (s1 || s4h || sPd) && htfBias.bear;
    } else if (cfg.rawFamily === 'DualTrap') {
      const { bullTrap: bStd, bearTrap: sStd } = detectLtfTrap(rows, f1, i, cfg.lookback, cfg.trapMaxBars);
      const { b4h: b4Std, s4h: s4Std } = detectH4Trap(rows, h4Idx, f4, i, cfg.p4Lookback, cfg.trapMaxBars);
      const { bullTrap: bFast, bearTrap: sFast } = detectLtfTrap(rows, f1, i, cfg.fastLookback, cfg.fastTrapMaxBars);
      const { b4h: b4Fast, s4h: s4Fast } = cfg.fastP4Lookback
        ? detectH4Trap(rows, h4Idx, f4, i, cfg.fastP4Lookback, cfg.fastTrapMaxBars)
        : { b4h: false, s4h: false };
      const { bPd, sPd } = cfg.includePdhl ? detectPdhlTrap(rows, d1Rows, d1Idx, i, cfg.trapMaxBars) : { bPd: false, sPd: false };
      bull = (bStd || b4Std || bFast || b4Fast || bPd) && htfBias.bull;
      bear = (sStd || s4Std || sFast || s4Fast || sPd) && htfBias.bear;
    } else if (cfg.rawFamily === 'CompositeTrapPlusTrend') {
      const { bullTrap: b1, bearTrap: s1 } = detectLtfTrap(rows, f1, i, cfg.lookback, cfg.trapMaxBars);
      const { b4h, s4h } = detectH4Trap(rows, h4Idx, f4, i, cfg.p4Lookback, cfg.trapMaxBars);
      const { bPd, sPd } = cfg.includePdhl ? detectPdhlTrap(rows, d1Rows, d1Idx, i, cfg.trapMaxBars) : { bPd: false, sPd: false };
      const trapBull = (b1 || b4h || bPd) && htfBias.bull;
      const trapBear = (s1 || s4h || sPd) && htfBias.bear;

      let pbBull = false;
      let pbBear = false;
      if (cfg.pbEnable && Number.isFinite(f1.ema20[i]) && Number.isFinite(f1.rsi14[i])) {
        const range = r.high - r.low;
        const closePosB = range > 0 ? (c - r.low) / range : 0;
        const closePosS = range > 0 ? (r.high - c) / range : 0;
        const h4StrongBull = Number.isFinite(h4Ema20) && Number.isFinite(h4Ema50) && h4Row.close > h4Ema20 && h4Ema20 > h4Ema50;
        const h4StrongBear = Number.isFinite(h4Ema20) && Number.isFinite(h4Ema50) && h4Row.close < h4Ema20 && h4Ema20 < h4Ema50;
        const touchTol = (cfg.pbTouchAtr ?? 0.25) * atr;
        const bodyReq = (cfg.pbBodyAtr ?? 0.5) * atr;
        const rsiMax = cfg.pbRsiMax ?? 70;
        const dippedB = r.low <= f1.ema20[i] + touchTol || prev.low <= f1.ema20[i - 1] + touchTol;
        const dippedS = r.high >= f1.ema20[i] - touchTol || prev.high >= f1.ema20[i - 1] - touchTol;
        pbBull = h4StrongBull && dippedB && c > f1.ema20[i] && (c - r.open) >= bodyReq && closePosB >= 0.55 && f1.rsi14[i] <= rsiMax;
        pbBear = h4StrongBear && dippedS && c < f1.ema20[i] && (r.open - c) >= bodyReq && closePosS >= 0.55 && f1.rsi14[i] >= (100 - rsiMax);
      }

      let sqBull = false;
      let sqBear = false;
      if (cfg.sqEnable && Number.isFinite(f1.atr14[i - 1]) && Number.isFinite(f1.atrSma50[i - 1]) && f1.atrSma50[i - 1] > 0) {
        const sqReady = (f1.atr14[i - 1] / f1.atrSma50[i - 1]) < (cfg.squeezeRatio ?? 0.90) &&
          Number.isFinite(f1.rvol20[i]) && f1.rvol20[i] >= (cfg.sqRvol ?? 1.1);
        const sqN = cfg.sqLookback ?? 14;
        const minBody = (cfg.sqBodyAtr ?? 0.4) * atr;
        const h4AlignedB = h4Row.close > h4Ema50;
        const h4AlignedS = h4Row.close < h4Ema50;
        sqBull = sqReady && h4AlignedB && c > f1.prevHigh[sqN][i] && prev.close <= f1.prevHigh[sqN][i - 1] && (c - r.open) >= minBody;
        sqBear = sqReady && h4AlignedS && c < f1.prevLow[sqN][i] && prev.close >= f1.prevLow[sqN][i - 1] && (r.open - c) >= minBody;
      }

      let h4DispBull = false;
      let h4DispBear = false;
      if (cfg.h4DispEnable && j4 !== h4Idx[i - 1]) {
        const h4Atr = f4.atr14[j4];
        const h4Range = h4Row.high - h4Row.low;
        if (Number.isFinite(h4Atr) && h4Atr > 0 && h4Range > 0 && Number.isFinite(f1.ema50[i])) {
          const body = h4Row.close - h4Row.open;
          const posB = (h4Row.close - h4Row.low) / h4Range;
          const posS = (h4Row.high - h4Row.close) / h4Range;
          h4DispBull = body >= (cfg.h4BodyAtrMin ?? 0.9) * h4Atr && posB >= (cfg.h4ClosePosMin ?? 0.6) &&
            htfBias.bull && c > f1.ema50[i];
          h4DispBear = -body >= (cfg.h4BodyAtrMin ?? 0.9) * h4Atr && posS >= (cfg.h4ClosePosMin ?? 0.6) &&
            htfBias.bear && c < f1.ema50[i];
        }
      }

      bull = trapBull || pbBull || sqBull || h4DispBull;
      bear = trapBear || pbBear || sqBear || h4DispBear;
    } else if (cfg.rawFamily === 'H4Disp') {
      const h4Atr = f4.atr14[j4];
      const h4Range = h4Row.high - h4Row.low;
      const isNewH4 = j4 !== h4Idx[i - 1];
      const gateBar = !cfg.onH4CloseOnly || isNewH4;
      if (gateBar && Number.isFinite(h4Atr) && h4Atr > 0 && h4Range > 0 && Number.isFinite(f1.ema50[i])) {
        const body = h4Row.close - h4Row.open;
        const posB = (h4Row.close - h4Row.low) / h4Range;
        const posS = (h4Row.high - h4Row.close) / h4Range;
        bull = body >= (cfg.h4BodyAtrMin ?? 0.9) * h4Atr && posB >= (cfg.h4ClosePosMin ?? 0.6) &&
          htfBias.bull && c > f1.ema50[i];
        bear = -body >= (cfg.h4BodyAtrMin ?? 0.9) * h4Atr && posS >= (cfg.h4ClosePosMin ?? 0.6) &&
          htfBias.bear && c < f1.ema50[i];
      }
    } else {
      throw new Error(`Unknown rawFamily: ${cfg.rawFamily}`);
    }

    if (bull === bear) continue;
    const side = bull ? 1 : -1;

    if ((cfg.minBodyRatio ?? 0) > 0) {
      const rng = r.high - r.low;
      if (rng <= 0 || (side * (c - r.open)) / rng < cfg.minBodyRatio) continue;
    }

    const sig = { barIndex: i, side, atr };
    if ((cfg.limitOffsetAtr ?? 0) > 0) {
      const limitPrice = c - side * cfg.limitOffsetAtr * atr;
      if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
      sig.limitPrice = limitPrice;
    }
    signals.push(sig);
  }
  return signals;
}

export function generateSignals1hV4(dataset, config, precomputed = null) {
  const pre = precomputed ?? precompute1hV4(dataset);
  const rawSpec = {
    rawFamily: config.rawFamily,
    lookback: config.lookback ?? 20,
    p4Lookback: config.p4Lookback ?? 10,
    trapMaxBars: config.trapMaxBars ?? 4,
    includePdhl: config.includePdhl ?? true,
    fastLookback: config.fastLookback ?? 10,
    fastP4Lookback: config.fastP4Lookback ?? 6,
    fastTrapMaxBars: config.fastTrapMaxBars ?? 3,
    pbEnable: config.pbEnable ?? false,
    pbTouchAtr: config.pbTouchAtr ?? 0.25,
    pbBodyAtr: config.pbBodyAtr ?? 0.5,
    pbRsiMax: config.pbRsiMax ?? 70,
    sqEnable: config.sqEnable ?? false,
    sqLookback: config.sqLookback ?? 14,
    squeezeRatio: config.squeezeRatio ?? 0.9,
    sqRvol: config.sqRvol ?? 1.1,
    sqBodyAtr: config.sqBodyAtr ?? 0.4,
    h4DispEnable: config.h4DispEnable ?? false,
    onH4CloseOnly: config.onH4CloseOnly ?? false,
    h4BodyAtrMin: config.h4BodyAtrMin ?? 0.9,
    h4ClosePosMin: config.h4ClosePosMin ?? 0.6,
    htfMode: config.htfMode ?? 'H4_50',
    minBodyRatio: config.minBodyRatio ?? 0,
    minAtrPct: config.minAtrPct ?? 0,
    limitOffsetAtr: config.limitOffsetAtr ?? 0,
    warmup: config.warmup ?? DEFAULT_WARMUP_1H,
  };
  const rawKey = JSON.stringify(rawSpec);
  let rawSignals = pre.rawCache.get(rawKey);
  if (!rawSignals) {
    rawSignals = generateRaw1hV4Signals(dataset, rawSpec, pre);
    pre.rawCache.set(rawKey, rawSignals);
  }

  if (!config.adaptive) {
    return rawSignals;
  }

  return applyAdaptivePolarity(dataset, rawSignals, {
    rawKey,
    winLen: config.winLen ?? 6,
    slThresh: config.slThresh ?? 2,
    requireNegNet: config.requireNegNet ?? true,
    sharedHistory: config.sharedHistory ?? false,
    limitOffsetAtr: config.limitOffsetAtr ?? 0,
    virtExec: config.virtExec,
  }, pre);
}
