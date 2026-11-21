import assert from 'node:assert/strict';
import { simulateTrades } from './sim_engine.mjs';
import { calcPineAtr, calcPineEma, calcPineRsi, alignHtfClosedIndices } from './signals_15m.mjs';

export const DEFAULT_WARMUP_15M = 250;

export function sliceDatasetPrefix15m(dataset, endLength) {
  assert.ok(dataset && Array.isArray(dataset.rows), 'Expected dataset with rows');
  assert.ok(Number.isSafeInteger(endLength) && endLength > 0 && endLength <= dataset.rows.length,
    `Invalid 15m slice endLength: ${endLength}`);
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

function calcRollingHighLowFast(rows, lengths) {
  const n = rows.length;
  const prevHigh = {};
  const prevLow = {};
  for (const len of lengths) {
    const hArr = new Float64Array(n).fill(NaN);
    const lArr = new Float64Array(n).fill(NaN);
    const maxDq = [];
    const minDq = [];
    let maxHead = 0;
    let minHead = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        while (maxHead < maxDq.length && maxDq[maxHead] < i - len) maxHead++;
        while (minHead < minDq.length && minDq[minHead] < i - len) minHead++;
        hArr[i] = rows[maxDq[maxHead]].high;
        lArr[i] = rows[minDq[minHead]].low;
      }
      while (maxDq.length > maxHead && rows[maxDq[maxDq.length - 1]].high <= rows[i].high) maxDq.pop();
      maxDq.push(i);
      while (minDq.length > minHead && rows[minDq[minDq.length - 1]].low >= rows[i].low) minDq.pop();
      minDq.push(i);
    }
    prevHigh[len] = hArr;
    prevLow[len] = lArr;
  }
  return { prevHigh, prevLow };
}

function calcSmaSeries(values, length) {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0;
  let validCount = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      sum += v;
      validCount++;
      if (i >= length && Number.isFinite(values[i - length])) {
        sum -= values[i - length];
        validCount--;
      }
      if (validCount === length) out[i] = sum / length;
    } else {
      sum = 0;
      validCount = 0;
    }
  }
  return out;
}

function calcPriorVolRvol(rows, len = 20) {
  const n = rows.length;
  const out = new Float64Array(n).fill(NaN);
  let volSum = 0;
  for (let i = 0; i < n; i++) {
    out[i] = i >= len && volSum > 0 ? rows[i].volume / (volSum / len) : NaN;
    volSum += rows[i].volume;
    if (i >= len) volSum -= rows[i - len].volume;
  }
  return out;
}

export function precompute15mV4(dataset) {
  assert.ok(dataset && Array.isArray(dataset.rows) && dataset.rows.length > 0, 'Expected non-empty 15m dataset');
  assert.ok(dataset.intervalSeconds <= 900, `Expected <= 900s LTF dataset, got ${dataset.intervalSeconds}`);
  const h1Obj = dataset.htf?.['1h'];
  const h4Obj = dataset.htf?.['4h'];
  assert.ok(h1Obj?.rows?.length > 0, 'Dataset missing htf["1h"]');
  assert.ok(h4Obj?.rows?.length > 0, 'Dataset missing htf["4h"]');

  const rows = dataset.rows;
  const h1Rows = h1Obj.rows;
  const h4Rows = h4Obj.rows;
  const aligned1h = alignHtfClosedIndices(rows, h1Rows, h1Obj.intervalSeconds ?? 3600);
  const aligned4h = alignHtfClosedIndices(rows, h4Rows, h4Obj.intervalSeconds ?? 14400);

  const ltfCloses = rows.map(r => r.close);
  const h1Closes = h1Rows.map(r => r.close);
  const h4Closes = h4Rows.map(r => r.close);

  const ltfAtr14 = calcPineAtr(rows, 14);
  const h1Atr14 = calcPineAtr(h1Rows, 14);
  const h4Atr14 = calcPineAtr(h4Rows, 14);

  const { prevHigh: ltfPrevHigh, prevLow: ltfPrevLow } = calcRollingHighLowFast(rows, [12, 16, 20, 24, 32, 48, 64, 80, 96]);
  const { prevHigh: h1PrevHigh, prevLow: h1PrevLow } = calcRollingHighLowFast(h1Rows, [6, 10, 12, 16, 20, 24]);
  const { prevHigh: h4PrevHigh, prevLow: h4PrevLow } = calcRollingHighLowFast(h4Rows, [4, 6, 8, 10, 14]);

  return {
    rows,
    h1Rows,
    h4Rows,
    aligned1h,
    aligned4h,
    ltfEma20: calcPineEma(ltfCloses, 20),
    ltfEma50: calcPineEma(ltfCloses, 50),
    ltfAtr14,
    ltfAtrSma50: calcSmaSeries(ltfAtr14, 50),
    ltfRsi14: calcPineRsi(ltfCloses, 14),
    ltfRvol20: calcPriorVolRvol(rows, 20),
    ltfPrevHigh,
    ltfPrevLow,
    h1Ema20: calcPineEma(h1Closes, 20),
    h1Ema50: calcPineEma(h1Closes, 50),
    h1Atr14,
    h1AtrSma50: calcSmaSeries(h1Atr14, 50),
    h1Rsi14: calcPineRsi(h1Closes, 14),
    h1Rvol20: calcPriorVolRvol(h1Rows, 20),
    h1PrevHigh,
    h1PrevLow,
    h4Ema20: calcPineEma(h4Closes, 20),
    h4Ema50: calcPineEma(h4Closes, 50),
    h4Atr14,
    h4Rsi14: calcPineRsi(h4Closes, 14),
    h4PrevHigh,
    h4PrevLow,
    rawCache: new Map(),
    virtCache: new Map(),
  };
}

function get15mHtfBias(htfMode, j1, j4, pre) {
  const h1Ok = Number.isFinite(pre.h1Ema50[j1]);
  const h4Ok = Number.isFinite(pre.h4Ema50[j4]);
  const h1C = pre.h1Rows[j1].close;
  const h4C = pre.h4Rows[j4].close;

  if (htfMode === 'H4_50') {
    return { bull: h4Ok && h4C > pre.h4Ema50[j4], bear: h4Ok && h4C < pre.h4Ema50[j4] };
  }
  if (htfMode === 'H1_50') {
    return { bull: h1Ok && h1C > pre.h1Ema50[j1], bear: h1Ok && h1C < pre.h1Ema50[j1] };
  }
  if (htfMode === 'H4_50_AND_H1_50') {
    return {
      bull: h4Ok && h1Ok && h4C > pre.h4Ema50[j4] && h1C > pre.h1Ema50[j1],
      bear: h4Ok && h1Ok && h4C < pre.h4Ema50[j4] && h1C < pre.h1Ema50[j1],
    };
  }
  if (htfMode === 'H4_20_or_50') {
    return {
      bull: (h4Ok && h4C > pre.h4Ema50[j4]) || (Number.isFinite(pre.h4Ema20[j4]) && h4C > pre.h4Ema20[j4]),
      bear: (h4Ok && h4C < pre.h4Ema50[j4]) || (Number.isFinite(pre.h4Ema20[j4]) && h4C < pre.h4Ema20[j4]),
    };
  }
  if (htfMode === 'H4_20') {
    return {
      bull: Number.isFinite(pre.h4Ema20[j4]) && h4C > pre.h4Ema20[j4],
      bear: Number.isFinite(pre.h4Ema20[j4]) && h4C < pre.h4Ema20[j4],
    };
  }
  if (htfMode === 'ANY') {
    return { bull: true, bear: true };
  }
  throw new Error(`Unknown 15m htfMode: ${htfMode}`);
}

function detectArrayTrap(rows, prevHighMap, prevLowMap, alignedIdx, i, N, K) {
  let bullTrap = false;
  let bearTrap = false;
  if (!N) return { bullTrap, bearTrap };
  const pH = prevHighMap[N];
  const pL = prevLowMap[N];
  const c = rows[i].close;
  const o = rows[i].open;
  for (let k = 1; k <= K; k++) {
    if (i - k < 0) continue;
    const refIdx = alignedIdx ? alignedIdx[i - k] : i - k;
    if (refIdx < N) continue;
    const levelL = pL[refIdx];
    const levelH = pH[refIdx];
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

function applyAdaptivePolarity15m(dataset, rawSignals, config, pre) {
  const { winLen, slThresh, requireNegNet = true, sharedHistory = false, virtExec, pullAtr = 0 } = config;
  const rawKey = config.rawKey;
  const vKey = `${rawKey}|${virtExec.entryMode}|${virtExec.limitExpiryBars}|${virtExec.stopAtr}|${virtExec.minStopPct}|${virtExec.rewardRisk}|${virtExec.maxHoldBars}|${virtExec.beTriggerR}|${virtExec.beOffsetPct}|${virtExec.lock2TriggerR ?? 0}|${virtExec.lock2OffsetR ?? 0}|${virtExec.trailTriggerR ?? 0}|${virtExec.trailAtrMult ?? 0}|${virtExec.cooldown}|${virtExec.costPct}|${virtExec.slippagePct}`;

  let virtTrades = pre.virtCache.get(vKey);
  if (!virtTrades) {
    virtTrades = simulateTrades(dataset.rows, rawSignals, {
      ...virtExec,
      start: 0,
      end: dataset.rows.length,
      intervalSeconds: dataset.intervalSeconds,
    }).trades;
    pre.virtCache.set(vKey, virtTrades);
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
    if (pullAtr > 0) {
      const limitPrice = dataset.rows[i].close - side * pullAtr * rawSig.atr;
      if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
      sig.limitPrice = limitPrice;
    }
    signals.push(sig);
  }
  return signals;
}

function generateRaw15mV4Signals(cfg, pre) {
  const { rows, aligned1h, aligned4h, h1Rows, h4Rows } = pre;
  const warmup = cfg.warmup ?? DEFAULT_WARMUP_15M;
  const minAtrPct = cfg.minAtrPct ?? 0;
  const signals = [];

  for (let i = warmup; i < rows.length; i++) {
    const r = rows[i];
    const prev = rows[i - 1];
    const c = r.close;
    const atr = pre.ltfAtr14[i];
    if (!Number.isFinite(atr) || atr <= 0) continue;
    const atrPct = (atr / c) * 100;
    if (minAtrPct > 0 && atrPct < minAtrPct) continue;

    const j1 = aligned1h[i];
    const j4 = aligned4h[i];
    const htfBias = get15mHtfBias(cfg.htfMode ?? 'H4_50', j1, j4, pre);

    let bull = false;
    let bear = false;

    if (cfg.rawFamily === 'M15_MultiTrap') {
      const kLtf = cfg.trapMaxBars ?? 4;
      const ltfT = cfg.ltfLookback
        ? detectArrayTrap(rows, pre.ltfPrevHigh, pre.ltfPrevLow, null, i, cfg.ltfLookback, kLtf)
        : { bullTrap: false, bearTrap: false };
      const h1T = cfg.h1Lookback
        ? detectArrayTrap(rows, pre.h1PrevHigh, pre.h1PrevLow, aligned1h, i, cfg.h1Lookback, kLtf)
        : { bullTrap: false, bearTrap: false };
      const h4T = cfg.h4Lookback
        ? detectArrayTrap(rows, pre.h4PrevHigh, pre.h4PrevLow, aligned4h, i, cfg.h4Lookback, kLtf)
        : { bullTrap: false, bearTrap: false };
      bull = (ltfT.bullTrap || h1T.bullTrap || h4T.bullTrap) && htfBias.bull;
      bear = (ltfT.bearTrap || h1T.bearTrap || h4T.bearTrap) && htfBias.bear;
    } else if (cfg.rawFamily === 'M15_H1H4_SweepReclaim') {
      const rng = r.high - r.low;
      const bodyMin = (cfg.minBodyAtr ?? 0.25) * atr;
      const closePosB = rng > 0 ? (c - r.low) / rng : 0;
      const closePosS = rng > 0 ? (r.high - c) / rng : 0;
      const cPosReq = cfg.closePosMin ?? 0.55;
      const ltfStrongB = c > r.open && (c - r.open) >= bodyMin && closePosB >= cPosReq;
      const ltfStrongS = c < r.open && (r.open - c) >= bodyMin && closePosS >= cPosReq;

      const minLow2 = Math.min(r.low, prev.low);
      const maxHigh2 = Math.max(r.high, prev.high);

      let swBull1h = false;
      let swBear1h = false;
      if (cfg.h1Lookback && j1 >= cfg.h1Lookback) {
        const lL = pre.h1PrevLow[cfg.h1Lookback][j1];
        const lH = pre.h1PrevHigh[cfg.h1Lookback][j1];
        swBull1h = minLow2 < lL && c > lL && ltfStrongB;
        swBear1h = maxHigh2 > lH && c < lH && ltfStrongS;
      }
      let swBull4h = false;
      let swBear4h = false;
      if (cfg.h4Lookback && j4 >= cfg.h4Lookback) {
        const lL = pre.h4PrevLow[cfg.h4Lookback][j4];
        const lH = pre.h4PrevHigh[cfg.h4Lookback][j4];
        swBull4h = minLow2 < lL && c > lL && ltfStrongB;
        swBear4h = maxHigh2 > lH && c < lH && ltfStrongS;
      }
      bull = (swBull1h || swBull4h) && htfBias.bull;
      bear = (swBear1h || swBear4h) && htfBias.bear;
    } else if (cfg.rawFamily === 'M15_H4Disp') {
      const h4 = h4Rows[j4];
      const h4Atr = pre.h4Atr14[j4];
      const h4Rng = h4.high - h4.low;
      const isNewH4 = j4 !== aligned4h[i - 1];
      const gateBar = !cfg.onH4CloseOnly || isNewH4;
      if (gateBar && Number.isFinite(h4Atr) && h4Atr > 0 && h4Rng > 0 && Number.isFinite(pre.ltfEma50[i])) {
        const h4Body = h4.close - h4.open;
        const h4PosB = (h4.close - h4.low) / h4Rng;
        const h4PosS = (h4.high - h4.close) / h4Rng;
        const ltfConfB = !cfg.requireLtfConfirm || (c > r.open && c > pre.ltfEma20[i]);
        const ltfConfS = !cfg.requireLtfConfirm || (c < r.open && c < pre.ltfEma20[i]);
        bull = h4Body >= (cfg.h4BodyAtrMin ?? 0.9) * h4Atr && h4PosB >= (cfg.h4ClosePosMin ?? 0.60) &&
          htfBias.bull && c > pre.ltfEma50[i] && ltfConfB;
        bear = -h4Body >= (cfg.h4BodyAtrMin ?? 0.9) * h4Atr && h4PosS >= (cfg.h4ClosePosMin ?? 0.60) &&
          htfBias.bear && c < pre.ltfEma50[i] && ltfConfS;
      }
    } else if (cfg.rawFamily === 'M15_SqueezeBreak_HTF') {
      const sqN = cfg.sqLookback ?? 20;
      const h1Ready = Number.isFinite(pre.h1Atr14[j1]) && Number.isFinite(pre.h1AtrSma50[j1]) && pre.h1AtrSma50[j1] > 0 &&
        (pre.h1Atr14[j1] / pre.h1AtrSma50[j1]) < (cfg.h1SqRatio ?? 0.92);
      const ltfReady = Number.isFinite(pre.ltfAtr14[i - 1]) && Number.isFinite(pre.ltfAtrSma50[i - 1]) && pre.ltfAtrSma50[i - 1] > 0 &&
        (pre.ltfAtr14[i - 1] / pre.ltfAtrSma50[i - 1]) < (cfg.ltfSqRatio ?? 0.92);
      const sqGate = cfg.useH1Sq ? h1Ready : ltfReady;
      const rvOk = Number.isFinite(pre.ltfRvol20[i]) && pre.ltfRvol20[i] >= (cfg.minRvol ?? 1.2);
      const minBody = (cfg.minBodyAtr ?? 0.5) * atr;
      if (sqGate && rvOk && Number.isFinite(pre.ltfPrevHigh[sqN][i]) && Number.isFinite(pre.ltfPrevHigh[sqN][i - 1])) {
        const brkB = c > pre.ltfPrevHigh[sqN][i] && prev.close <= pre.ltfPrevHigh[sqN][i - 1] && (c - r.open) >= minBody;
        const brkS = c < pre.ltfPrevLow[sqN][i] && prev.close >= pre.ltfPrevLow[sqN][i - 1] && (r.open - c) >= minBody;
        bull = brkB && htfBias.bull;
        bear = brkS && htfBias.bear;
      }
    } else if (cfg.rawFamily === 'M15_MeanRev_BandReclaim') {
      const ema50 = pre.ltfEma50[i];
      const ema20 = pre.ltfEma20[i];
      const prevEma50 = pre.ltfEma50[i - 1];
      const rsi = pre.ltfRsi14[i];
      const prevRsi = pre.ltfRsi14[i - 1];
      if (Number.isFinite(ema50) && Number.isFinite(ema20) && Number.isFinite(prevEma50) && Number.isFinite(rsi) && Number.isFinite(prevRsi)) {
        const bandMult = cfg.bandAtr ?? 1.8;
        const prevBandL = prevEma50 - bandMult * atr;
        const prevBandH = prevEma50 + bandMult * atr;
        const rsiTrig = cfg.rsiExt ?? 34;
        const revB = (prev.low <= prevBandL || prevRsi <= rsiTrig) && c > r.open && (c - r.open) >= 0.35 * atr && c > prev.close;
        const revS = (prev.high >= prevBandH || prevRsi >= (100 - rsiTrig)) && c < r.open && (r.open - c) >= 0.35 * atr && c < prev.close;
        bull = revB && htfBias.bull;
        bear = revS && htfBias.bear;
      }
    } else if (cfg.rawFamily === 'M15_H1SyncedMultiTrap') {
      // Detect MultiTrap on newly completed 1h closed bar (strictly causal: j1 !== aligned1h[i - 1])
      // PLUS optional 15m rolling sweep/trap on intra-hour bars.
      const isNewH1 = j1 !== aligned1h[i - 1];
      let h1BullTrap = false;
      let h1BearTrap = false;
      if (isNewH1 && j1 >= 24) {
        const kH1 = cfg.trapMaxBars ?? 4;
        const h1N = cfg.h1Lookback ?? 20;
        const h1Row = h1Rows[j1];
        // 1h N-bar trap evaluated strictly on h1Rows (matching 1h MultiTrap physics!)
        const t1 = detectArrayTrap(h1Rows, pre.h1PrevHigh, pre.h1PrevLow, null, j1, h1N, kH1);
        // 4h P4-bar trap evaluated on h1Rows via closed h4 aligned to h1Row
        let t4B = false;
        let t4S = false;
        if (cfg.h4Lookback) {
          const p4H = pre.h4PrevHigh[cfg.h4Lookback];
          const p4L = pre.h4PrevLow[cfg.h4Lookback];
          for (let k = 1; k <= kH1; k++) {
            if (j1 - k < 0) continue;
            // Find latest closed 4h bar <= h1Rows[j1 - k].time
            const refTime = h1Rows[j1 - k].time;
            let j4k = j4;
            while (j4k > 0 && h4Rows[j4k].time + 14400 > refTime) j4k--;
            if (j4k < cfg.h4Lookback || h4Rows[j4k].time + 14400 > refTime) continue;
            const levelL = p4L[j4k];
            const levelH = p4H[j4k];
            let allB = true;
            let allA = true;
            for (let m = 1; m <= k; m++) {
              if (!(h1Rows[j1 - m].close < levelL)) allB = false;
              if (!(h1Rows[j1 - m].close > levelH)) allA = false;
            }
            if (allB && h1Row.close > levelL && h1Row.close > h1Row.open) t4B = true;
            if (allA && h1Row.close < levelH && h1Row.close < h1Row.open) t4S = true;
          }
        }
        // Rolling 24h (h1Lookback = 24) proxy for PDHL on 1h bars
        const t24 = cfg.include24h ? detectArrayTrap(h1Rows, pre.h1PrevHigh, pre.h1PrevLow, null, j1, 24, 2) : { bullTrap: false, bearTrap: false };
        h1BullTrap = (t1.bullTrap || t4B || t24.bullTrap) && htfBias.bull;
        h1BearTrap = (t1.bearTrap || t4S || t24.bearTrap) && htfBias.bear;
      }
      let ltfBull = false;
      let ltfBear = false;
      if (cfg.ltfLookback) {
        const ltfT = detectArrayTrap(rows, pre.ltfPrevHigh, pre.ltfPrevLow, null, i, cfg.ltfLookback, cfg.ltfTrapK ?? 4);
        ltfBull = ltfT.bullTrap && htfBias.bull;
        ltfBear = ltfT.bearTrap && htfBias.bear;
      }
      let h4DispB = false;
      let h4DispS = false;
      if (cfg.h4DispEnable && j4 !== aligned4h[i - 1]) {
        const h4 = h4Rows[j4];
        const h4Atr = pre.h4Atr14[j4];
        const h4Rng = h4.high - h4.low;
        if (Number.isFinite(h4Atr) && h4Atr > 0 && h4Rng > 0 && Number.isFinite(pre.ltfEma50[i])) {
          const h4Body = h4.close - h4.open;
          const h4PosB = (h4.close - h4.low) / h4Rng;
          const h4PosS = (h4.high - h4.close) / h4Rng;
          h4DispB = h4Body >= (cfg.h4BodyAtrMin ?? 0.9) * h4Atr && h4PosB >= (cfg.h4ClosePosMin ?? 0.60) &&
            htfBias.bull && c > pre.ltfEma50[i];
          h4DispS = -h4Body >= (cfg.h4BodyAtrMin ?? 0.9) * h4Atr && h4PosS >= (cfg.h4ClosePosMin ?? 0.60) &&
            htfBias.bear && c < pre.ltfEma50[i];
        }
      }
      bull = h1BullTrap || ltfBull || h4DispB;
      bear = h1BearTrap || ltfBear || h4DispS;
    } else if (cfg.rawFamily === 'M15_H1Pullback_Trend') {
      if (Number.isFinite(pre.ltfEma20[i]) && Number.isFinite(pre.ltfEma50[i]) &&
          Number.isFinite(pre.h1Ema20[j1]) && Number.isFinite(pre.h1Ema50[j1])) {
        const rng = r.high - r.low;
        const strongBull = htfBias.bull && pre.h1Rows[j1].close > pre.h1Ema20[j1] && pre.h1Ema20[j1] > pre.h1Ema50[j1];
        const strongBear = htfBias.bear && pre.h1Rows[j1].close < pre.h1Ema20[j1] && pre.h1Ema20[j1] < pre.h1Ema50[j1];
        const tol = (cfg.pbTouchAtr ?? 0.3) * atr;
        const dippedB = r.low <= pre.ltfEma50[i] + tol || prev.low <= pre.ltfEma50[i - 1] + tol;
        const dippedS = r.high >= pre.ltfEma50[i] - tol || prev.high >= pre.ltfEma50[i - 1] - tol;
        const posB = rng > 0 ? (c - r.low) / rng : 0;
        const posS = rng > 0 ? (r.high - c) / rng : 0;
        bull = strongBull && dippedB && c > pre.ltfEma20[i] && (c - r.open) >= 0.4 * atr && posB >= 0.6;
        bear = strongBear && dippedS && c < pre.ltfEma20[i] && (r.open - c) >= 0.4 * atr && posS >= 0.6;
      }
    } else {
      throw new Error(`Unknown 15m rawFamily: ${cfg.rawFamily}`);
    }

    if (bull === bear) continue;
    const side = bull ? 1 : -1;
    const sig = { barIndex: i, side, atr };
    if ((cfg.pullAtr ?? 0) > 0) {
      const limitPrice = c - side * cfg.pullAtr * atr;
      if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
      sig.limitPrice = limitPrice;
    }
    signals.push(sig);
  }
  return signals;
}

export function generateSignals15mV4(dataset, config, precomputed = null) {
  const pre = precomputed ?? precompute15mV4(dataset);
  const rawSpec = {
    rawFamily: config.rawFamily,
    ltfLookback: config.ltfLookback ?? null,
    ltfTrapK: config.ltfTrapK ?? 4,
    h1Lookback: config.h1Lookback ?? null,
    h4Lookback: config.h4Lookback ?? null,
    include24h: config.include24h ?? false,
    h4DispEnable: config.h4DispEnable ?? false,
    pbTouchAtr: config.pbTouchAtr ?? 0.3,
    trapMaxBars: config.trapMaxBars ?? 4,
    minBodyAtr: config.minBodyAtr ?? 0.25,
    closePosMin: config.closePosMin ?? 0.55,
    h4BodyAtrMin: config.h4BodyAtrMin ?? 0.9,
    h4ClosePosMin: config.h4ClosePosMin ?? 0.6,
    onH4CloseOnly: config.onH4CloseOnly ?? true,
    requireLtfConfirm: config.requireLtfConfirm ?? false,
    sqLookback: config.sqLookback ?? 20,
    useH1Sq: config.useH1Sq ?? true,
    h1SqRatio: config.h1SqRatio ?? 0.92,
    ltfSqRatio: config.ltfSqRatio ?? 0.92,
    minRvol: config.minRvol ?? 1.2,
    bandAtr: config.bandAtr ?? 1.8,
    rsiExt: config.rsiExt ?? 34,
    htfMode: config.htfMode ?? 'H4_50',
    minAtrPct: config.minAtrPct ?? 0,
    pullAtr: config.pullAtr ?? 0,
    warmup: config.warmup ?? DEFAULT_WARMUP_15M,
  };
  const rawKey = JSON.stringify(rawSpec);
  let rawSignals = pre.rawCache.get(rawKey);
  if (!rawSignals) {
    rawSignals = generateRaw15mV4Signals(rawSpec, pre);
    pre.rawCache.set(rawKey, rawSignals);
  }

  if (!config.adaptive) {
    return rawSignals;
  }

  return applyAdaptivePolarity15m(dataset, rawSignals, {
    rawKey,
    winLen: config.winLen ?? 6,
    slThresh: config.slThresh ?? 2,
    requireNegNet: config.requireNegNet ?? true,
    sharedHistory: config.sharedHistory ?? false,
    pullAtr: config.pullAtr ?? 0,
    virtExec: config.virtExec,
  }, pre);
}
