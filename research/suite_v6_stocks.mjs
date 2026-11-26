import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTradesV6, simulatePortfolioV6, summarizePerformanceV6 } from './sim_engine_v6.mjs';
import { scoreCandidateV5 } from './ml_inference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V6_DIR = path.join(HERE, 'results_v6');
const MODELS_PATH = path.join(RESULTS_V6_DIR, 'models_stocks_v6.json');
const REPORT_JSON_PATH = path.join(RESULTS_V6_DIR, 'stocks_indices_5y_10y.json');

const EPS = 1e-12;
const SECONDS_PER_YEAR = 365.25 * 86400;

export const DEFAULT_STOCK_WARMUP = 210;

export const STOCK_FEATURE_NAMES_V6 = Object.freeze([
  'side',
  'ibs',
  'ibs_dir',
  'rsi2',
  'rsi2_dir',
  'rsi14_dir',
  'atr_pct',
  'body_atr',
  'dist_ema20_atr',
  'dist_sma50_atr',
  'dist_sma200_atr',
  'sma50_slope_atr',
  'ret_3d_dir_atr',
  'ret_20d_dir_atr',
  'rv_ratio_10_60',
  'rvol_20',
  'vix_level',
  'vix_ratio_20',
  'vix_chg_5d',
  'tnx_level',
  'tnx_chg_5d',
  'tnx_z20',
  'dia_qqq_rot_z20',
  'dia_qqq_rot_z60',
  'wk_ema20_dist_atr',
]);

// Locked Cal+Val ([0..2010)) calibrated structural configurations (Blind Holdout [2010..2513) untouched)
export const STOCK_ASSET_CONFIGS_V6 = {
  SPY: {
    asset: 'SPY',
    symbol: 'SPY',
    benchmarkSymbol: '^GSPC',
    dataFile: 'equities10y_sp500_1d.json',
    futuresFile: 'equities2y_es_1h.json',
    futuresSymbol: 'ES=F',
    signalSpec: {
      asset: 'SPY',
      specId: 'V6Stock:SPY:IBS_RSI2_Regime',
      entryMode: 'MARKET_NEXT_OPEN',
      limitOffsetAtr: 0.0,
      warmup: DEFAULT_STOCK_WARMUP,
      bullSmaBuf: 1.0,
      bullVixMax: 35,
      bullIbsMax: 0.30,
      bullRsi2Max: 35,
      bearEnabled: true,
      bearVixMin: 20,
      bearRsi2Min: 78,
      bearIbsMin: 0.65,
    },
    execOptions: {
      execProfile: 'EQUITY_ETF',
      allowTimeGaps: true,
      costPct: 0.04,
      slippagePct: 0.015,
      fundingPctPer8h: 0,
      entryMode: 'MARKET_NEXT_OPEN',
      limitExpiryBars: 3,
      pendingPolicy: 'ignore',
      cooldown: 1,
      warmup: DEFAULT_STOCK_WARMUP,
      stopAtr: 2.5,
      minStopPct: 0.8,
      rewardRisk: 0.88,
      maxHoldBars: 14,
      beTriggerR: 0.40,
      beOffsetPct: 0.15,
      volNormRiskPct: 2.2,
      minLev: 0.75,
      maxLev: 2.0,
      fixedLev: 1.0,
    },
  },
  DIA: {
    asset: 'DIA',
    symbol: 'DIA',
    benchmarkSymbol: '^DJI',
    dataFile: 'equities10y_dow_1d.json',
    futuresFile: 'equities2y_ym_1h.json',
    futuresSymbol: 'YM=F',
    signalSpec: {
      asset: 'DIA',
      specId: 'V6Stock:DIA:ValueMR_RotZ_Macro',
      entryMode: 'MARKET_NEXT_OPEN',
      limitOffsetAtr: 0.0,
      warmup: DEFAULT_STOCK_WARMUP,
      bullSmaBuf: 1.0,
      bullVixMax: 26,
      bullIbsMax: 0.32,
      bullRsi2Max: 20,
      minRotZ: -3.0,
      tnxMaxShock: 0.45,
      bearEnabled: false,
      bearRsi2Min: 78,
      bearIbsMin: 0.65,
    },
    execOptions: {
      execProfile: 'EQUITY_ETF',
      allowTimeGaps: true,
      costPct: 0.04,
      slippagePct: 0.015,
      fundingPctPer8h: 0,
      entryMode: 'MARKET_NEXT_OPEN',
      limitExpiryBars: 3,
      pendingPolicy: 'ignore',
      cooldown: 1,
      warmup: DEFAULT_STOCK_WARMUP,
      stopAtr: 2.8,
      minStopPct: 0.8,
      rewardRisk: 0.84,
      maxHoldBars: 14,
      beTriggerR: 0.45,
      beOffsetPct: 0.12,
      volNormRiskPct: 2.2,
      minLev: 0.75,
      maxLev: 2.0,
      fixedLev: 1.0,
    },
  },
  QQQ: {
    asset: 'QQQ',
    symbol: 'QQQ',
    benchmarkSymbol: '^NDX',
    dataFile: 'equities10y_nasdaq_1d.json',
    futuresFile: 'equities2y_nq_1h.json',
    futuresSymbol: 'NQ=F',
    signalSpec: {
      asset: 'QQQ',
      specId: 'V6Stock:QQQ:TechMomPB_VolBrk_TnxVixGuard',
      entryMode: 'LIMIT_PULLBACK',
      limitOffsetAtr: 0.35,
      warmup: DEFAULT_STOCK_WARMUP,
      bullSmaBuf: 0.99,
      bullVixMax: 34,
      vixSpikeCap: 1.35,
      tnxShockMax: 0.30,
      pbIbsMax: 0.38,
      pbRsi2Max: 32,
      useBreakout: true,
      compRatioMax: 0.85,
      bearEnabled: true,
      bearRsi2Min: 78,
      bearIbsMin: 0.65,
    },
    execOptions: {
      execProfile: 'EQUITY_ETF',
      allowTimeGaps: true,
      costPct: 0.04,
      slippagePct: 0.015,
      fundingPctPer8h: 0,
      entryMode: 'LIMIT_PULLBACK',
      limitExpiryBars: 2,
      pendingPolicy: 'ignore',
      cooldown: 2,
      warmup: DEFAULT_STOCK_WARMUP,
      stopAtr: 2.8,
      minStopPct: 1.0,
      rewardRisk: 0.88,
      maxHoldBars: 8,
      beTriggerR: 0.42,
      beOffsetPct: 0.15,
      volNormRiskPct: 2.2,
      minLev: 0.75,
      maxLev: 2.0,
      fixedLev: 1.0,
    },
  },
};

// ============================================================================
// Causal Technical Indicators & Cross-Series Alignment (Zero Lookahead)
// ============================================================================

export function calcSmaPrefix(values, length, limit = values.length) {
  const out = new Float64Array(limit).fill(NaN);
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < limit; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      sum += v;
      valid++;
      if (i >= length && Number.isFinite(values[i - length])) {
        sum -= values[i - length];
        valid--;
      }
      if (valid === length) out[i] = sum / length;
    } else {
      sum = 0;
      valid = 0;
    }
  }
  return out;
}

export function calcEmaPrefix(values, length, limit = values.length) {
  const out = new Float64Array(limit).fill(NaN);
  const alpha = 2 / (length + 1);
  let sum = 0;
  let valid = 0;
  let started = false;
  for (let i = 0; i < limit; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      if (started) out[i] = out[i - 1];
      continue;
    }
    if (!started) {
      sum += v;
      valid++;
      if (valid === length) {
        out[i] = sum / length;
        started = true;
      }
    } else {
      out[i] = out[i - 1] + alpha * (v - out[i - 1]);
    }
  }
  return out;
}

export function calcAtrPrefix(rows, length = 14, limit = rows.length) {
  const out = new Float64Array(limit).fill(NaN);
  let sum = 0;
  for (let i = 0; i < limit; i++) {
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

export function calcRsiPrefix(closes, length = 14, limit = closes.length) {
  const out = new Float64Array(limit).fill(NaN);
  let upSum = 0;
  let dnSum = 0;
  let avgUp = NaN;
  let avgDn = NaN;
  for (let i = 1; i < limit; i++) {
    const ch = closes[i] - closes[i - 1];
    const up = Math.max(ch, 0);
    const dn = Math.max(-ch, 0);
    if (i < length) {
      upSum += up;
      dnSum += dn;
    } else if (i === length) {
      upSum += up;
      dnSum += dn;
      avgUp = upSum / length;
      avgDn = dnSum / length;
      out[i] = avgUp === 0 && avgDn === 0 ? 50 : avgDn === 0 ? 100 : avgUp === 0 ? 0 : 100 - 100 / (1 + avgUp / avgDn);
    } else {
      avgUp += (up - avgUp) / length;
      avgDn += (dn - avgDn) / length;
      out[i] = avgUp === 0 && avgDn === 0 ? 50 : avgDn === 0 ? 100 : avgUp === 0 ? 0 : 100 - 100 / (1 + avgUp / avgDn);
    }
  }
  return out;
}

export function calcRollingStdLogRetPrefix(closes, length, limit = closes.length) {
  const out = new Float64Array(limit).fill(NaN);
  const rets = new Float64Array(limit);
  let sum = 0;
  let sumSq = 0;
  for (let i = 1; i < limit; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    rets[i] = r;
    sum += r;
    sumSq += r * r;
    if (i > length) {
      const old = rets[i - length];
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= length) {
      const mean = sum / length;
      const variance = Math.max(0, sumSq / length - mean * mean);
      out[i] = Math.sqrt(variance);
    }
  }
  return out;
}

export function calcZScorePrefix(values, length, limit = values.length) {
  const out = new Float64Array(limit).fill(NaN);
  for (let i = length - 1; i < limit; i++) {
    let sum = 0;
    let count = 0;
    for (let k = i - length + 1; k <= i; k++) {
      const v = values[k];
      if (Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    if (count < Math.max(5, Math.floor(length * 0.7))) continue;
    const mean = sum / count;
    let varSum = 0;
    for (let k = i - length + 1; k <= i; k++) {
      const v = values[k];
      if (Number.isFinite(v)) varSum += (v - mean) * (v - mean);
    }
    const std = Math.sqrt(varSum / count);
    const cur = values[i];
    if (Number.isFinite(cur)) {
      out[i] = std > 1e-12 ? (cur - mean) / std : 0;
    }
  }
  return out;
}

export function calcRvolPrefix(rows, length = 20, limit = rows.length) {
  const out = new Float64Array(limit).fill(NaN);
  let volSum = 0;
  for (let i = 0; i < limit; i++) {
    const vol = Number.isFinite(rows[i].volume) ? rows[i].volume : 0;
    out[i] = i >= length && volSum > 0 ? vol / (volSum / length) : NaN;
    volSum += vol;
    if (i >= length) {
      const oldVol = Number.isFinite(rows[i - length].volume) ? rows[i - length].volume : 0;
      volSum -= oldVol;
    }
  }
  return out;
}

export function calcPrevHighLowPrefix(rows, length, limit = rows.length) {
  const prevHigh = new Float64Array(limit).fill(NaN);
  const prevLow = new Float64Array(limit).fill(NaN);
  for (let i = length; i < limit; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - length; k < i; k++) {
      if (rows[k].high > hi) hi = rows[k].high;
      if (rows[k].low < lo) lo = rows[k].low;
    }
    prevHigh[i] = hi;
    prevLow[i] = lo;
  }
  return { prevHigh, prevLow };
}

/**
 * Causally aligns an auxiliary series (e.g. ^VIX, ^TNX, QQQ, DIA) to targetRows
 * so bar i only ever observes sourceRows with time <= targetRows[i].time.
 */
export function alignSeriesToBarsCausal(targetRows, sourceRows, limit = targetRows.length) {
  const alignedIndex = new Int32Array(limit).fill(-1);
  const alignedClose = new Float64Array(limit).fill(NaN);
  if (!Array.isArray(sourceRows) || sourceRows.length === 0) {
    return { alignedIndex, alignedClose };
  }
  let j = -1;
  for (let i = 0; i < limit; i++) {
    const t = targetRows[i].time;
    while (j + 1 < sourceRows.length && sourceRows[j + 1].time <= t) {
      j++;
    }
    if (j >= 0) {
      assert.ok(sourceRows[j].time <= t, `Cross-series lookahead at bar ${i}`);
      alignedIndex[i] = j;
      alignedClose[i] = sourceRows[j].close;
    }
  }
  return { alignedIndex, alignedClose };
}

export function extractMacroSeries(macroJson) {
  if (!macroJson || typeof macroJson !== 'object') return { vixRows: [], tnxRows: [] };
  const findSeries = (candidates) => {
    for (const key of candidates) {
      if (Array.isArray(macroJson[key]?.rows)) return macroJson[key].rows;
      if (Array.isArray(macroJson[key])) return macroJson[key];
      if (macroJson.series && Array.isArray(macroJson.series[key]?.rows)) return macroJson.series[key].rows;
      if (macroJson.series && Array.isArray(macroJson.series[key])) return macroJson.series[key];
    }
    return [];
  };
  return {
    vixRows: findSeries(['vixRows', 'vix', '^VIX', 'VIX']),
    tnxRows: findSeries(['tnxRows', 'tnx', '^TNX', 'TNX']),
  };
}

/**
 * Causally slices an equity/futures dataset to [0..endLength) without exposing
 * any future bars or future HTF candles.
 */
export function sliceEquityDatasetPrefix(dataset, endLength) {
  assert.ok(dataset && Array.isArray(dataset.rows), 'Expected dataset with rows');
  assert.ok(Number.isSafeInteger(endLength) && endLength > 0 && endLength <= dataset.rows.length,
    `Invalid slice endLength: ${endLength}`);
  const rows = dataset.rows.slice(0, endLength);
  const lastTime = rows[rows.length - 1].time;
  const htf = {};
  for (const [tf, h] of Object.entries(dataset.htf ?? {})) {
    const hRows = [];
    const interval = h.intervalSeconds ?? (tf === '1wk' ? 604800 : tf === '1d' ? 86400 : 0);
    const getCloseTime = (r) => r.closeTime ?? (r.time + interval);
    if (Array.isArray(h.alignedIndex)) {
      const alignedIndex = h.alignedIndex.slice(0, endLength);
      const maxAllowed = alignedIndex[alignedIndex.length - 1];
      for (let j = 0; j < h.rows.length; j++) {
        if (j <= maxAllowed && getCloseTime(h.rows[j]) <= lastTime) {
          hRows.push(h.rows[j]);
        } else if (j > maxAllowed) {
          break;
        }
      }
      htf[tf] = { ...h, rows: hRows, alignedIndex };
    } else {
      for (let j = 0; j < h.rows.length; j++) {
        if (getCloseTime(h.rows[j]) <= lastTime) hRows.push(h.rows[j]);
        else break;
      }
      htf[tf] = { ...h, rows: hRows };
    }
  }
  return {
    ...dataset,
    count: rows.length,
    lastTime,
    rows,
    htf,
  };
}

export function sliceMacroPrefix(macroJson, lastTime) {
  const { vixRows, tnxRows } = extractMacroSeries(macroJson);
  return {
    vixRows: vixRows.filter(r => r.time <= lastTime),
    tnxRows: tnxRows.filter(r => r.time <= lastTime),
  };
}

function buildHtfDailyOrWeeklyContext(dataset, limit, lastTime) {
  const htfMap = dataset.htf ?? {};
  const targetTf = htfMap['1wk'] ? '1wk' : (htfMap['1d'] ? '1d' : null);
  if (!targetTf) return null;
  const h = htfMap[targetTf];
  if (!Array.isArray(h.rows) || h.rows.length === 0) return null;

  const interval = h.intervalSeconds ?? (targetTf === '1wk' ? 604800 : 86400);
  const getCloseTime = (r) => r.closeTime ?? (r.time + interval);
  const alignedIndex = new Int32Array(limit).fill(-1);
  let maxJ = -1;

  if (Array.isArray(h.alignedIndex) && h.alignedIndex.length >= limit) {
    for (let i = 0; i < limit; i++) {
      const j = h.alignedIndex[i];
      if (Number.isSafeInteger(j) && j >= 0 && j < h.rows.length) {
        assert.ok(getCloseTime(h.rows[j]) <= dataset.rows[i].time,
          `HTF ${targetTf} lookahead violation at bar ${i}`);
        alignedIndex[i] = j;
        if (j > maxJ) maxJ = j;
      }
    }
  } else {
    let j = -1;
    for (let i = 0; i < limit; i++) {
      const barTime = dataset.rows[i].time;
      while (j + 1 < h.rows.length && getCloseTime(h.rows[j + 1]) <= barTime) {
        j++;
      }
      alignedIndex[i] = j;
      if (j > maxJ) maxJ = j;
    }
  }

  const hLimit = Math.min(h.rows.length, Math.max(0, maxJ + 1));
  const hCloses = new Float64Array(hLimit);
  for (let j = 0; j < hLimit; j++) {
    assert.ok(getCloseTime(h.rows[j]) <= lastTime, `HTF ${targetTf} slice exceeds lastTime`);
    hCloses[j] = h.rows[j].close;
  }
  return {
    tf: targetTf,
    rows: h.rows,
    limit: hLimit,
    alignedIndex,
    ema20: calcEmaPrefix(hCloses, 20, hLimit),
    sma50: calcSmaPrefix(hCloses, 50, hLimit),
    sma200: calcSmaPrefix(hCloses, 200, hLimit),
    atr14: calcAtrPrefix(h.rows, 14, hLimit),
  };
}

/**
 * Precomputes strictly causal indicator, macro (^VIX, ^TNX), cross-asset (DIA/QQQ),
 * and HTF arrays for bars [0 .. limit).
 */
export function precomputeStockContextV6(dataset, aux = {}, maxBarIdx = null) {
  assert.ok(dataset && Array.isArray(dataset.rows) && dataset.rows.length > 0, 'Expected dataset with rows');
  const rows = dataset.rows;
  const limit = maxBarIdx === null ? rows.length : maxBarIdx + 1;
  assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= rows.length, 'Invalid maxBarIdx');

  const lastTime = rows[limit - 1].time;
  const closes = new Float64Array(limit);
  const ibs = new Float64Array(limit);
  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    closes[i] = r.close;
    const rng = r.high - r.low;
    ibs[i] = rng > 0 ? (r.close - r.low) / rng : 0.5;
  }

  const ema10 = calcEmaPrefix(closes, 10, limit);
  const ema20 = calcEmaPrefix(closes, 20, limit);
  const ema50 = calcEmaPrefix(closes, 50, limit);
  const sma20 = calcSmaPrefix(closes, 20, limit);
  const sma50 = calcSmaPrefix(closes, 50, limit);
  const sma100 = calcSmaPrefix(closes, 100, limit);
  const sma200 = calcSmaPrefix(closes, 200, limit);
  const atr14 = calcAtrPrefix(rows, 14, limit);
  const rsi2 = calcRsiPrefix(closes, 2, limit);
  const rsi14 = calcRsiPrefix(closes, 14, limit);
  const rv10 = calcRollingStdLogRetPrefix(closes, 10, limit);
  const rv60 = calcRollingStdLogRetPrefix(closes, 60, limit);
  const rvol20 = calcRvolPrefix(rows, 20, limit);
  const { prevHigh: prevHigh10, prevLow: prevLow10 } = calcPrevHighLowPrefix(rows, 10, limit);

  const { vixRows, tnxRows } = extractMacroSeries(aux.macro);
  const vixAligned = alignSeriesToBarsCausal(rows, vixRows, limit);
  const tnxAligned = alignSeriesToBarsCausal(rows, tnxRows, limit);

  const vixSma20 = calcSmaPrefix(vixAligned.alignedClose, 20, limit);
  const tnxZ20 = calcZScorePrefix(tnxAligned.alignedClose, 20, limit);

  const diaRows = aux.diaRows ?? [];
  const qqqRows = aux.qqqRows ?? [];
  const diaAligned = alignSeriesToBarsCausal(rows, diaRows, limit);
  const qqqAligned = alignSeriesToBarsCausal(rows, qqqRows, limit);
  const logDiaQqq = new Float64Array(limit).fill(NaN);
  for (let i = 0; i < limit; i++) {
    const d = diaAligned.alignedClose[i];
    const q = qqqAligned.alignedClose[i];
    if (Number.isFinite(d) && d > 0 && Number.isFinite(q) && q > 0) {
      logDiaQqq[i] = Math.log(d / q);
    }
  }
  const diaQqqRotZ20 = calcZScorePrefix(logDiaQqq, 20, limit);
  const diaQqqRotZ60 = calcZScorePrefix(logDiaQqq, 60, limit);

  const htf = buildHtfDailyOrWeeklyContext(dataset, limit, lastTime);

  return {
    limit,
    intervalSeconds: dataset.intervalSeconds,
    rows,
    closes,
    ibs,
    ema10,
    ema20,
    ema50,
    sma20,
    sma50,
    sma100,
    sma200,
    atr14,
    rsi2,
    rsi14,
    rv10,
    rv60,
    rvol20,
    prevHigh10,
    prevLow10,
    vix: vixAligned.alignedClose,
    vixSma20,
    tnx: tnxAligned.alignedClose,
    tnxZ20,
    diaQqqRotZ20,
    diaQqqRotZ60,
    htf,
  };
}

export function extractStockFeaturesV6(dataset, signal, barIdx, aux = {}, context = null) {
  const ctx = context ?? precomputeStockContextV6(dataset, aux, barIdx);
  assert.ok(barIdx >= 0 && barIdx < ctx.limit, `barIdx ${barIdx} out of precomputed bounds`);

  const r = ctx.rows[barIdx];
  const side = signal.side;
  const close = r.close;
  const open = r.open;
  const atr = Number.isFinite(signal.atr) && signal.atr > 0 ? signal.atr : ctx.atr14[barIdx];
  const validAtr = Number.isFinite(atr) && atr > 0;

  const ibs = ctx.ibs[barIdx];
  const ibs_dir = side === 1 ? (0.5 - ibs) : (ibs - 0.5);
  const rsi2 = ctx.rsi2[barIdx];
  const rsi2_dir = Number.isFinite(rsi2) ? (side === 1 ? (50 - rsi2) / 50 : (rsi2 - 50) / 50) : NaN;
  const rsi14 = ctx.rsi14[barIdx];
  const rsi14_dir = Number.isFinite(rsi14) ? (side === 1 ? (rsi14 - 50) / 50 : (50 - rsi14) / 50) : NaN;

  const atr_pct = validAtr ? (atr / close) * 100 : NaN;
  const body_atr = validAtr ? (side * (close - open)) / atr : NaN;
  const ema20 = ctx.ema20[barIdx];
  const sma50 = ctx.sma50[barIdx];
  const sma200 = ctx.sma200[barIdx];

  const dist_ema20_atr = validAtr && Number.isFinite(ema20) ? (side * (close - ema20)) / atr : NaN;
  const dist_sma50_atr = validAtr && Number.isFinite(sma50) ? (side * (close - sma50)) / atr : NaN;
  const dist_sma200_atr = validAtr && Number.isFinite(sma200) ? (side * (close - sma200)) / atr : NaN;
  const sma50_slope_atr = validAtr && barIdx >= 10 && Number.isFinite(sma50) && Number.isFinite(ctx.sma50[barIdx - 10])
    ? (side * (sma50 - ctx.sma50[barIdx - 10])) / atr
    : NaN;

  const ret_3d_dir_atr = validAtr && barIdx >= 3 ? (side * (close - ctx.closes[barIdx - 3])) / atr : NaN;
  const ret_20d_dir_atr = validAtr && barIdx >= 20 ? (side * (close - ctx.closes[barIdx - 20])) / atr : NaN;

  const rv10 = ctx.rv10[barIdx];
  const rv60 = ctx.rv60[barIdx];
  const rv_ratio_10_60 = Number.isFinite(rv10) && Number.isFinite(rv60) && rv60 > 0 ? rv10 / rv60 : NaN;
  const rvol_20 = ctx.rvol20[barIdx];

  const vix_level = ctx.vix[barIdx];
  const vixSma20 = ctx.vixSma20[barIdx];
  const vix_ratio_20 = Number.isFinite(vix_level) && Number.isFinite(vixSma20) && vixSma20 > 0 ? vix_level / vixSma20 : NaN;
  const vix_chg_5d = barIdx >= 5 && Number.isFinite(vix_level) && Number.isFinite(ctx.vix[barIdx - 5])
    ? vix_level - ctx.vix[barIdx - 5]
    : NaN;

  const tnx_level = ctx.tnx[barIdx];
  const tnx_chg_5d = barIdx >= 5 && Number.isFinite(tnx_level) && Number.isFinite(ctx.tnx[barIdx - 5])
    ? tnx_level - ctx.tnx[barIdx - 5]
    : NaN;
  const tnx_z20 = ctx.tnxZ20[barIdx];

  const dia_qqq_rot_z20 = ctx.diaQqqRotZ20[barIdx];
  const dia_qqq_rot_z60 = ctx.diaQqqRotZ60[barIdx];

  let wk_ema20_dist_atr = NaN;
  if (ctx.htf) {
    const j = ctx.htf.alignedIndex[barIdx];
    if (j >= 0 && j < ctx.htf.limit) {
      const hRow = ctx.htf.rows[j];
      const hEma = ctx.htf.ema20[j];
      const hAtr = ctx.htf.atr14[j];
      if (hRow && Number.isFinite(hEma) && Number.isFinite(hAtr) && hAtr > 0) {
        wk_ema20_dist_atr = (side * (hRow.close - hEma)) / hAtr;
      }
    }
  }

  return {
    side,
    ibs,
    ibs_dir,
    rsi2,
    rsi2_dir,
    rsi14_dir,
    atr_pct,
    body_atr,
    dist_ema20_atr,
    dist_sma50_atr,
    dist_sma200_atr,
    sma50_slope_atr,
    ret_3d_dir_atr,
    ret_20d_dir_atr,
    rv_ratio_10_60,
    rvol_20,
    vix_level,
    vix_ratio_20,
    vix_chg_5d,
    tnx_level,
    tnx_chg_5d,
    tnx_z20,
    dia_qqq_rot_z20,
    dia_qqq_rot_z60,
    wk_ema20_dist_atr,
  };
}

// ============================================================================
// 3 Dedicated Institutional Index Signal Generators
// ============================================================================

function makeSignal(barIndex, side, atr, close, spec, setupTag) {
  const entryMode = spec.entryMode ?? 'MARKET_NEXT_OPEN';
  const limitOffsetAtr = spec.limitOffsetAtr ?? 0;
  const limitPrice = entryMode === 'LIMIT_PULLBACK'
    ? close - side * limitOffsetAtr * atr
    : undefined;
  return {
    barIndex,
    side,
    atr,
    entryMode,
    limitPrice,
    meta: { setupTag, asset: spec.asset },
  };
}

function getCausalDailyTrendClose(ctx, i) {
  if (ctx.intervalSeconds === 3600 && ctx.htf?.tf === '1d') {
    const j = ctx.htf.alignedIndex[i];
    if (j >= 0 && j < ctx.htf.limit) {
      return {
        trendClose: ctx.htf.rows[j].close,
        trendSma200: ctx.htf.sma200[j],
        trendEma50: ctx.htf.sma50[j],
      };
    }
  }
  return {
    trendClose: ctx.closes[i],
    trendSma200: ctx.sma200[i],
    trendEma50: ctx.ema50[i],
  };
}

export function generateSp500SignalsV6(ctx, spec) {
  const signals = [];
  const warmup = spec.warmup ?? DEFAULT_STOCK_WARMUP;
  const bullSmaBuf = spec.bullSmaBuf ?? 0.99;
  const bullVixMax = spec.bullVixMax ?? 36;
  const bullIbsMax = spec.bullIbsMax ?? 0.35;
  const bullRsi2Max = spec.bullRsi2Max ?? 25;
  const bearEnabled = spec.bearEnabled ?? true;
  const bearVixMin = spec.bearVixMin ?? 20;
  const bearRsi2Min = spec.bearRsi2Min ?? 75;
  const bearIbsMin = spec.bearIbsMin ?? 0.65;

  for (let i = warmup; i < ctx.limit; i++) {
    const close = ctx.closes[i];
    const atr = ctx.atr14[i];
    const { trendClose, trendSma200, trendEma50 } = getCausalDailyTrendClose(ctx, i);
    const ibs = ctx.ibs[i];
    const rsi2 = ctx.rsi2[i];
    const vix = ctx.vix[i];
    const vixSma = ctx.vixSma20[i];

    if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(trendSma200) || !Number.isFinite(rsi2)) continue;

    const vixOk = !Number.isFinite(vix) || vix <= bullVixMax;
    const isBullRegime = trendClose >= trendSma200 * bullSmaBuf && vixOk;
    if (isBullRegime) {
      const pullbackHit = (ibs <= bullIbsMax && rsi2 <= bullRsi2Max) || (rsi2 <= Math.min(10, bullRsi2Max * 0.45));
      if (pullbackHit) {
        signals.push(makeSignal(i, 1, atr, close, spec, 'SPY_BULL_IBS_RSI2'));
        continue;
      }
    }

    if (bearEnabled && trendClose < trendSma200 && Number.isFinite(trendEma50) && trendClose < trendEma50) {
      const vixElevated = Number.isFinite(vix) && Number.isFinite(vixSma)
        ? (vix >= bearVixMin && vix >= vixSma * 0.98)
        : true;
      if (vixElevated && rsi2 >= bearRsi2Min && ibs >= bearIbsMin) {
        signals.push(makeSignal(i, -1, atr, close, spec, 'SPY_BEAR_SHORT_HEDGE'));
      }
    }
  }
  return signals;
}

export function generateDowSignalsV6(ctx, spec) {
  const signals = [];
  const warmup = spec.warmup ?? DEFAULT_STOCK_WARMUP;
  const bullSmaBuf = spec.bullSmaBuf ?? 0.99;
  const bullVixMax = spec.bullVixMax ?? 36;
  const bullIbsMax = spec.bullIbsMax ?? 0.35;
  const bullRsi2Max = spec.bullRsi2Max ?? 25;
  const minRotZ = spec.minRotZ ?? -1.6;
  const tnxMaxShock = spec.tnxMaxShock ?? 0.45;
  const bearEnabled = spec.bearEnabled ?? true;
  const bearRsi2Min = spec.bearRsi2Min ?? 75;
  const bearIbsMin = spec.bearIbsMin ?? 0.65;

  for (let i = warmup; i < ctx.limit; i++) {
    const close = ctx.closes[i];
    const atr = ctx.atr14[i];
    const { trendClose, trendSma200, trendEma50 } = getCausalDailyTrendClose(ctx, i);
    const ibs = ctx.ibs[i];
    const rsi2 = ctx.rsi2[i];
    const vix = ctx.vix[i];
    const vixSma = ctx.vixSma20[i];
    const tnx = ctx.tnx[i];
    const tnxPrev5 = i >= 5 ? ctx.tnx[i - 5] : NaN;
    const tnxChg5 = Number.isFinite(tnx) && Number.isFinite(tnxPrev5) ? tnx - tnxPrev5 : 0;
    const rotZ = ctx.diaQqqRotZ20[i];

    if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(trendSma200) || !Number.isFinite(rsi2)) continue;

    const vixOk = !Number.isFinite(vix) || vix <= bullVixMax;
    const rotOk = !Number.isFinite(rotZ) || rotZ >= minRotZ;
    const tnxOk = tnxChg5 <= tnxMaxShock;

    if (trendClose >= trendSma200 * bullSmaBuf && vixOk && rotOk && tnxOk) {
      const mrHit = (ibs <= bullIbsMax && rsi2 <= bullRsi2Max) || (rsi2 <= Math.min(12, bullRsi2Max * 0.5));
      if (mrHit) {
        signals.push(makeSignal(i, 1, atr, close, spec, 'DIA_VALUE_MR_ROT'));
        continue;
      }
    }

    if (bearEnabled && trendClose < trendSma200 && Number.isFinite(trendEma50) && trendClose < trendEma50) {
      const vixElevated = Number.isFinite(vix) && Number.isFinite(vixSma) ? vix >= vixSma : true;
      if (vixElevated && rsi2 >= bearRsi2Min && ibs >= bearIbsMin) {
        signals.push(makeSignal(i, -1, atr, close, spec, 'DIA_BEAR_SHORT_HEDGE'));
      }
    }
  }
  return signals;
}

export function generateNasdaqSignalsV6(ctx, spec) {
  const signals = [];
  const warmup = spec.warmup ?? DEFAULT_STOCK_WARMUP;
  const bullSmaBuf = spec.bullSmaBuf ?? 0.99;
  const bullVixMax = spec.bullVixMax ?? 34;
  const vixSpikeCap = spec.vixSpikeCap ?? 1.35;
  const tnxShockMax = spec.tnxShockMax ?? 0.30;
  const pbIbsMax = spec.pbIbsMax ?? 0.38;
  const pbRsi2Max = spec.pbRsi2Max ?? 28;
  const useBreakout = spec.useBreakout ?? true;
  const compRatioMax = spec.compRatioMax ?? 0.85;
  const bearEnabled = spec.bearEnabled ?? true;
  const bearRsi2Min = spec.bearRsi2Min ?? 75;
  const bearIbsMin = spec.bearIbsMin ?? 0.65;

  for (let i = warmup; i < ctx.limit; i++) {
    const close = ctx.closes[i];
    const atr = ctx.atr14[i];
    const { trendClose, trendSma200, trendEma50 } = getCausalDailyTrendClose(ctx, i);
    const ibs = ctx.ibs[i];
    const rsi2 = ctx.rsi2[i];
    const rv10 = ctx.rv10[i];
    const rv60 = ctx.rv60[i];
    const prevHi10 = ctx.prevHigh10[i];
    const vix = ctx.vix[i];
    const vixSma = ctx.vixSma20[i];
    const tnx = ctx.tnx[i];
    const tnxPrev5 = i >= 5 ? ctx.tnx[i - 5] : NaN;
    const tnxChg5 = Number.isFinite(tnx) && Number.isFinite(tnxPrev5) ? tnx - tnxPrev5 : 0;

    if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(trendSma200) || !Number.isFinite(rsi2)) continue;

    const vixLevelOk = !Number.isFinite(vix) || vix <= bullVixMax;
    const vixSpikeOk = !Number.isFinite(vix) || !Number.isFinite(vixSma) || vixSma <= 0 || (vix / vixSma <= vixSpikeCap);
    const tnxOk = tnxChg5 <= tnxShockMax;

    if (trendClose >= trendSma200 * bullSmaBuf && vixLevelOk && vixSpikeOk && tnxOk) {
      const pbHit = (ibs <= pbIbsMax && rsi2 <= pbRsi2Max) || (rsi2 <= Math.min(12, pbRsi2Max * 0.45));
      const volBreakoutHit = useBreakout &&
        Number.isFinite(rv10) && Number.isFinite(rv60) && rv60 > 0 && (rv10 / rv60 <= compRatioMax) &&
        Number.isFinite(prevHi10) && close > prevHi10 && ibs >= 0.65;

      if (pbHit) {
        signals.push(makeSignal(i, 1, atr, close, spec, 'QQQ_TECH_PULLBACK'));
        continue;
      }
      if (volBreakoutHit) {
        signals.push(makeSignal(i, 1, atr, close, spec, 'QQQ_VOL_BREAKOUT'));
        continue;
      }
    }

    if (bearEnabled && trendClose < trendSma200 && Number.isFinite(trendEma50) && trendClose < trendEma50) {
      const macroStress = !tnxOk || (Number.isFinite(vix) && Number.isFinite(vixSma) && vix >= vixSma);
      if (macroStress && rsi2 >= bearRsi2Min && ibs >= bearIbsMin) {
        signals.push(makeSignal(i, -1, atr, close, spec, 'QQQ_BEAR_SHORT_HEDGE'));
      }
    }
  }
  return signals;
}

export function generateStockSignalsV6(dataset, spec, aux = {}, context = null) {
  const ctx = context ?? precomputeStockContextV6(dataset, aux);
  const asset = String(spec.asset ?? '').toUpperCase();
  if (asset === 'SPY' || asset === 'SP500' || asset === 'ES=F') {
    return generateSp500SignalsV6(ctx, spec);
  }
  if (asset === 'DIA' || asset === 'DOW' || asset === 'YM=F') {
    return generateDowSignalsV6(ctx, spec);
  }
  if (asset === 'QQQ' || asset === 'NASDAQ' || asset === 'NQ=F') {
    return generateNasdaqSignalsV6(ctx, spec);
  }
  throw new Error(`Unknown stock index asset: ${spec.asset}`);
}

export function applyStockMlFilterV6(dataset, signals, modelSpec, aux = {}, context = null) {
  const ctx = context ?? precomputeStockContextV6(dataset, aux);
  const filtered = [];
  for (const s of signals) {
    const f = extractStockFeaturesV6(dataset, s, s.barIndex, aux, ctx);
    const score = scoreCandidateV5(f, modelSpec);
    if (score.pass) {
      filtered.push({
        ...s,
        sizeMult: score.sizeMult,
        meta: { ...(s.meta ?? {}), probWin: score.probWin, sizeMult: score.sizeMult },
      });
    }
  }
  return filtered;
}

// ============================================================================
// Data Loading, Calibration (Cal+Val ONLY), Trainer I/O & Full Reporting
// ============================================================================

function loadEquitiesUniverse() {
  const macro = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities10y_macro_1d.json'), 'utf8'));
  const sp500 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities10y_sp500_1d.json'), 'utf8'));
  const dow = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities10y_dow_1d.json'), 'utf8'));
  const nasdaq = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities10y_nasdaq_1d.json'), 'utf8'));
  return {
    macro,
    datasets: { SPY: sp500, DIA: dow, QQQ: nasdaq },
    aux: { macro, diaRows: dow.rows, qqqRows: nasdaq.rows },
  };
}

function getSplitIndices(n) {
  const calEnd = Math.floor(n * 0.50);
  const valEnd = Math.floor(n * 0.80);
  return { calEnd, valEnd, n };
}

function roundMetrics(m) {
  const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(2)));
  return {
    count: m.count,
    wins: m.wins,
    losses: m.losses,
    ties: m.ties,
    winRatePct: r2(m.winRatePct),
    wilsonLower95Pct: r2(m.wilsonLower95Pct),
    profitFactor: r2(m.profitFactor),
    totalNetPct: r2(m.totalNetPct),
    compoundedNetPct: r2(m.compoundedNetPct),
    cagrPct: r2(m.cagrPct),
    maxDrawdownPct: r2(m.maxDrawdownPct),
    compoundedMaxDrawdownPct: r2(m.compoundedMaxDrawdownPct),
    sharpe: r2(m.sharpe),
    sortino: r2(m.sortino),
    calmar: r2(m.calmar),
    buyHoldPct: r2(m.buyHoldPct),
    buyHoldMaxDdPct: r2(m.buyHoldMaxDdPct),
    retToDd: r2(m.retToDd),
  };
}

function calibrateCalVal() {
  const { macro, datasets } = loadEquitiesUniverse();
  const out = {};
  for (const asset of ['SPY', 'DIA', 'QQQ']) {
    const cfg = STOCK_ASSET_CONFIGS_V6[asset];
    const full = datasets[asset];
    const { calEnd, valEnd } = getSplitIndices(full.rows.length);
    // Strict anti-leakage: truncate at valEnd (never touch Blind Holdout)
    const dsCV = sliceEquityDatasetPrefix(full, valEnd);
    const macroCV = sliceMacroPrefix(macro, dsCV.lastTime);
    const auxCV = {
      macro: macroCV,
      diaRows: datasets.DIA.rows.slice(0, valEnd),
      qqqRows: datasets.QQQ.rows.slice(0, valEnd),
    };
    const ctxCV = precomputeStockContextV6(dsCV, auxCV);

    const cands = [];
    const ibsOpts = asset === 'QQQ' ? [0.32, 0.38, 0.44] : [0.30, 0.36, 0.42];
    const rsiOpts = asset === 'QQQ' ? [22, 30, 38] : [20, 28, 35];
    const bearOpts = [true, false];
    const stopOpts = [1.8, 2.2];
    const rrOpts = [0.85, 1.0, 1.15];
    const holdOpts = [5, 8];
    const beOpts = [
      { beTriggerR: 0.45, beOffsetPct: 0.15 },
      { beTriggerR: 0.65, beOffsetPct: 0.25 },
    ];

    for (const ibsMax of ibsOpts) {
      for (const rsiMax of rsiOpts) {
        for (const bearEnabled of bearOpts) {
          const signalSpec = {
            ...cfg.signalSpec,
            bullIbsMax: ibsMax,
            pbIbsMax: ibsMax,
            bullRsi2Max: rsiMax,
            pbRsi2Max: rsiMax,
            bearEnabled,
          };
          const sigs = generateStockSignalsV6(dsCV, signalSpec, auxCV, ctxCV);
          for (const stopAtr of stopOpts) {
            for (const rewardRisk of rrOpts) {
              for (const maxHoldBars of holdOpts) {
                for (const be of beOpts) {
                  const execOptions = {
                    ...cfg.execOptions,
                    stopAtr,
                    rewardRisk,
                    maxHoldBars,
                    beTriggerR: be.beTriggerR,
                    beOffsetPct: be.beOffsetPct,
                  };
                  const simCal = simulateTradesV6(dsCV.rows, sigs, { ...execOptions, start: 0, end: calEnd });
                  const simVal = simulateTradesV6(dsCV.rows, sigs, { ...execOptions, start: calEnd, end: valEnd });
                  const simCV = simulateTradesV6(dsCV.rows, sigs, { ...execOptions, start: 0, end: valEnd });
                  const eligible = simCal.count >= 45 && simVal.count >= 30 &&
                    (simCal.winRatePct ?? 0) >= 65 && (simVal.winRatePct ?? 0) >= 65 &&
                    (simCal.profitFactor ?? 0) >= 1.25 && (simVal.profitFactor ?? 0) >= 1.15;
                  const score = (eligible ? 10000 : 0) +
                    (simCV.calmar ?? 0) * 50 +
                    (simCV.sharpe ?? 0) * 35 +
                    Math.min(simCal.winRatePct ?? 0, simVal.winRatePct ?? 0) * 2.0 +
                    Math.min(simCal.profitFactor ?? 0, simVal.profitFactor ?? 0) * 30 +
                    (simCV.compoundedNetPct ?? 0) * 0.4;
                  cands.push({
                    score: Number(score.toFixed(2)),
                    eligible,
                    ibsMax,
                    rsiMax,
                    bearEnabled,
                    stopAtr,
                    rewardRisk,
                    maxHoldBars,
                    beTriggerR: be.beTriggerR,
                    beOffsetPct: be.beOffsetPct,
                    cal: { n: simCal.count, wr: Number((simCal.winRatePct ?? 0).toFixed(2)), pf: Number((simCal.profitFactor ?? 0).toFixed(2)), net: Number((simCal.compoundedNetPct ?? 0).toFixed(2)), dd: Number((simCal.compoundedMaxDrawdownPct ?? 0).toFixed(2)) },
                    val: { n: simVal.count, wr: Number((simVal.winRatePct ?? 0).toFixed(2)), pf: Number((simVal.profitFactor ?? 0).toFixed(2)), net: Number((simVal.compoundedNetPct ?? 0).toFixed(2)), dd: Number((simVal.compoundedMaxDrawdownPct ?? 0).toFixed(2)), bh: Number((simVal.buyHoldPct ?? 0).toFixed(2)), bhDd: Number((simVal.buyHoldMaxDdPct ?? 0).toFixed(2)) },
                    cv: { n: simCV.count, wr: Number((simCV.winRatePct ?? 0).toFixed(2)), pf: Number((simCV.profitFactor ?? 0).toFixed(2)), net: Number((simCV.compoundedNetPct ?? 0).toFixed(2)), dd: Number((simCV.compoundedMaxDrawdownPct ?? 0).toFixed(2)), sharpe: Number((simCV.sharpe ?? 0).toFixed(2)), calmar: Number((simCV.calmar ?? 0).toFixed(2)) },
                  });
                }
              }
            }
          }
        }
      }
    }
    cands.sort((a, b) => b.score - a.score);
    out[asset] = cands.slice(0, 5);
  }
  console.log(JSON.stringify(out, null, 2));
}

function extractCvForTrainer() {
  const { macro, datasets } = loadEquitiesUniverse();
  const payload = {};
  for (const asset of ['SPY', 'DIA', 'QQQ']) {
    const cfg = STOCK_ASSET_CONFIGS_V6[asset];
    const full = datasets[asset];
    const { calEnd, valEnd, n } = getSplitIndices(full.rows.length);
    const dsCV = sliceEquityDatasetPrefix(full, valEnd);
    const macroCV = sliceMacroPrefix(macro, dsCV.lastTime);
    const auxCV = {
      macro: macroCV,
      diaRows: datasets.DIA.rows.slice(0, valEnd),
      qqqRows: datasets.QQQ.rows.slice(0, valEnd),
    };
    const ctxCV = precomputeStockContextV6(dsCV, auxCV);
    const signals = generateStockSignalsV6(dsCV, cfg.signalSpec, auxCV, ctxCV);

    const sigFeatures = signals.map((s) => {
      const fmap = extractStockFeaturesV6(dsCV, s, s.barIndex, auxCV, ctxCV);
      return {
        barIndex: s.barIndex,
        side: s.side,
        atr: s.atr,
        vec: STOCK_FEATURE_NAMES_V6.map(k => (Number.isFinite(fmap[k]) ? fmap[k] : null)),
      };
    });

    const simCal = simulateTradesV6(dsCV.rows, signals, { ...cfg.execOptions, start: 0, end: calEnd });
    const simVal = simulateTradesV6(dsCV.rows, signals, { ...cfg.execOptions, start: calEnd, end: valEnd });
    const sigIdxByBar = new Map(signals.map((s, idx) => [s.barIndex, idx]));

    const calSequential = simCal.trades
      .filter(t => t.signalIndex >= 0 && t.exitIndex < calEnd)
      .map(t => ({
        idx: sigIdxByBar.get(t.signalIndex),
        barIndex: t.signalIndex,
        y: t.netPct > 0 ? 1 : 0,
        netPct: t.netPct,
      }));

    const valSequential = simVal.trades
      .filter(t => t.signalIndex >= calEnd && t.exitIndex < valEnd)
      .map(t => ({
        idx: sigIdxByBar.get(t.signalIndex),
        barIndex: t.signalIndex,
        y: t.netPct > 0 ? 1 : 0,
        netPct: t.netPct,
      }));

    payload[asset] = {
      asset,
      symbol: cfg.symbol,
      benchmarkSymbol: cfg.benchmarkSymbol,
      signalSpec: cfg.signalSpec,
      execOptions: cfg.execOptions,
      totalBarsFull: n,
      calEnd,
      valEnd,
      featureNames: STOCK_FEATURE_NAMES_V6,
      signals: sigFeatures,
      calSequential,
      valSequential,
      baseVal: roundMetrics(simVal),
    };
  }
  process.stdout.write(JSON.stringify(payload));
}

function evalValForTrainer() {
  const req = JSON.parse(fs.readFileSync(0, 'utf8'));
  const { macro, datasets } = loadEquitiesUniverse();
  const out = {};

  for (const asset of ['SPY', 'DIA', 'QQQ']) {
    const cfg = STOCK_ASSET_CONFIGS_V6[asset];
    const full = datasets[asset];
    const { calEnd, valEnd } = getSplitIndices(full.rows.length);
    const dsCV = sliceEquityDatasetPrefix(full, valEnd);
    const macroCV = sliceMacroPrefix(macro, dsCV.lastTime);
    const auxCV = {
      macro: macroCV,
      diaRows: datasets.DIA.rows.slice(0, valEnd),
      qqqRows: datasets.QQQ.rows.slice(0, valEnd),
    };
    const ctxCV = precomputeStockContextV6(dsCV, auxCV);
    const baseSignals = generateStockSignalsV6(dsCV, cfg.signalSpec, auxCV, ctxCV);

    const results = [];
    for (const cand of req[asset]) {
      const filtered = [];
      for (let k = 0; k < baseSignals.length; k++) {
        const s = baseSignals[k];
        if (s.barIndex < calEnd || s.barIndex >= valEnd) continue;
        const p = cand.probs[k];
        if (p >= cand.threshold) {
          let sizeMult = 1.0;
          if (cand.sizeCurve && cand.sizeCurve.mode === 'linear') {
            const u = Math.max(0, Math.min(1, (p - cand.threshold) / Math.max(1e-6, cand.sizeCurve.pMax - cand.threshold)));
            sizeMult = cand.sizeCurve.minMult + u * (cand.sizeCurve.maxMult - cand.sizeCurve.minMult);
          }
          filtered.push({ ...s, sizeMult });
        }
      }
      const simVal = simulateTradesV6(dsCV.rows, filtered, {
        ...cfg.execOptions,
        start: calEnd,
        end: valEnd,
        warmup: 0,
      });
      results.push({ id: cand.id, val: roundMetrics(simVal) });
    }
    out[asset] = results;
  }
  process.stdout.write(JSON.stringify(out));
}

// ============================================================================
// Verification: Python sklearn vs JS ml_inference Parity + Causality Tests
// ============================================================================

export function verifyStocksParityAndCausality(modelsArtifact, datasets, aux) {
  // 1) Strict Prefix-Truncation & Future-Mutation Causality across SPY, DIA, QQQ
  const causalityResults = {};
  for (const asset of ['SPY', 'DIA', 'QQQ']) {
    const cfg = STOCK_ASSET_CONFIGS_V6[asset];
    const full = datasets[asset];
    const T = 1600;
    const subT = 1350;
    const dsPrefix = sliceEquityDatasetPrefix(full, T);
    const macroPrefix = sliceMacroPrefix(aux.macro, dsPrefix.lastTime);
    const auxPrefix = {
      macro: macroPrefix,
      diaRows: datasets.DIA.rows.slice(0, T),
      qqqRows: datasets.QQQ.rows.slice(0, T),
    };

    const dsMut = structuredClone(dsPrefix);
    const subTime = dsMut.rows[subT - 1].time;
    for (let i = subT; i < dsMut.rows.length; i++) {
      dsMut.rows[i].open *= 1.85;
      dsMut.rows[i].high *= 1.95;
      dsMut.rows[i].low *= 1.75;
      dsMut.rows[i].close *= 1.85;
      dsMut.rows[i].volume *= 4;
    }
    for (const h of Object.values(dsMut.htf ?? {})) {
      const interval = h.intervalSeconds ?? 604800;
      for (const r of h.rows) {
        if ((r.closeTime ?? (r.time + interval)) > subTime) {
          r.open *= 1.85;
          r.high *= 1.95;
          r.low *= 1.75;
          r.close *= 1.85;
        }
      }
    }
    const macroMut = {
      vixRows: macroPrefix.vixRows.map(r => r.time > subTime ? { ...r, close: r.close * 2.5 } : r),
      tnxRows: macroPrefix.tnxRows.map(r => r.time > subTime ? { ...r, close: r.close * 2.0 } : r),
    };
    const auxMut = {
      macro: macroMut,
      diaRows: auxPrefix.diaRows.map(r => r.time > subTime ? { ...r, close: r.close * 1.9 } : r),
      qqqRows: auxPrefix.qqqRows.map(r => r.time > subTime ? { ...r, close: r.close * 0.5 } : r),
    };

    const sigFull = generateStockSignalsV6(full, cfg.signalSpec, aux).filter(s => s.barIndex < subT);
    const sigPrefix = generateStockSignalsV6(dsPrefix, cfg.signalSpec, auxPrefix).filter(s => s.barIndex < subT);
    const sigMut = generateStockSignalsV6(dsMut, cfg.signalSpec, auxMut).filter(s => s.barIndex < subT);

    assert.equal(sigPrefix.length, sigFull.length, `${asset}: prefix signal count mismatch`);
    assert.equal(sigMut.length, sigFull.length, `${asset}: future-mutated signal count mismatch`);

    const ctxFull = precomputeStockContextV6(full, aux, subT - 1);
    const ctxPrefix = precomputeStockContextV6(dsPrefix, auxPrefix);
    const ctxMut = precomputeStockContextV6(dsMut, auxMut);

    for (let k = 0; k < sigFull.length; k++) {
      assert.equal(sigPrefix[k].barIndex, sigFull[k].barIndex);
      assert.equal(sigPrefix[k].side, sigFull[k].side);
      assert.equal(sigMut[k].barIndex, sigFull[k].barIndex);
      const fFull = extractStockFeaturesV6(full, sigFull[k], sigFull[k].barIndex, aux, ctxFull);
      const fPref = extractStockFeaturesV6(dsPrefix, sigPrefix[k], sigPrefix[k].barIndex, auxPrefix, ctxPrefix);
      const fMut = extractStockFeaturesV6(dsMut, sigMut[k], sigMut[k].barIndex, auxMut, ctxMut);
      for (const fname of STOCK_FEATURE_NAMES_V6) {
        if (Number.isNaN(fFull[fname])) {
          assert.ok(Number.isNaN(fPref[fname]) && Number.isNaN(fMut[fname]), `${asset} NaN mismatch on ${fname}`);
        } else {
          assert.equal(fPref[fname], fFull[fname], `${asset} prefix mismatch on ${fname} @ ${sigFull[k].barIndex}`);
          assert.equal(fMut[fname], fFull[fname], `${asset} future mutation altered ${fname} @ ${sigFull[k].barIndex}`);
        }
      }
    }

    const simFullSub = simulateTradesV6(full.rows, sigFull, { ...cfg.execOptions, start: 0, end: subT });
    const simMutSub = simulateTradesV6(dsMut.rows, sigMut, { ...cfg.execOptions, start: 0, end: subT });
    assert.equal(simMutSub.count, simFullSub.count, `${asset} sim trade count changed on future mutation`);
    assert.ok(Math.abs((simMutSub.totalNetPct ?? 0) - (simFullSub.totalNetPct ?? 0)) < 1e-12, `${asset} sim PnL changed`);
    causalityResults[asset] = { pass: true, checkedSignals: sigFull.length, checkedTrades: simFullSub.count };
  }

  // Also verify 1h Futures causal 1d HTF alignment (ES=F)
  const esFut = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities2y_es_1h.json'), 'utf8'));
  const futT = 8000;
  const futSubT = 6500;
  const esPrefix = sliceEquityDatasetPrefix(esFut, futT);
  const esMut = structuredClone(esPrefix);
  const esSubTime = esMut.rows[futSubT - 1].time;
  for (let i = futSubT; i < esMut.rows.length; i++) {
    esMut.rows[i].open *= 1.5;
    esMut.rows[i].high *= 1.6;
    esMut.rows[i].low *= 1.4;
    esMut.rows[i].close *= 1.5;
  }
  for (const r of esMut.htf['1d'].rows) {
    if ((r.closeTime ?? (r.time + 86400)) > esSubTime) {
      r.open *= 1.5;
      r.high *= 1.6;
      r.low *= 1.4;
      r.close *= 1.5;
    }
  }
  const macroFutPref = sliceMacroPrefix(aux.macro, esPrefix.lastTime);
  const macroFutMut = {
    vixRows: macroFutPref.vixRows.map(r => r.time > esSubTime ? { ...r, close: r.close * 2.0 } : r),
    tnxRows: macroFutPref.tnxRows.map(r => r.time > esSubTime ? { ...r, close: r.close * 2.0 } : r),
  };
  const futSigFull = generateFutures1hSignalsCausal(esFut, modelsArtifact.models.SPY, aux).filter(s => s.barIndex < futSubT);
  const futSigPref = generateFutures1hSignalsCausal(esPrefix, modelsArtifact.models.SPY, { ...aux, macro: macroFutPref }).filter(s => s.barIndex < futSubT);
  const futSigMut = generateFutures1hSignalsCausal(esMut, modelsArtifact.models.SPY, { ...aux, macro: macroFutMut }).filter(s => s.barIndex < futSubT);
  assert.equal(futSigPref.length, futSigFull.length, 'ES=F 1h prefix signal count mismatch');
  assert.equal(futSigMut.length, futSigFull.length, 'ES=F 1h future-mutated signal count mismatch');
  for (let k = 0; k < futSigFull.length; k++) {
    assert.equal(futSigPref[k].barIndex, futSigFull[k].barIndex);
    assert.equal(futSigMut[k].barIndex, futSigFull[k].barIndex);
    assert.equal(futSigMut[k].atr, futSigFull[k].atr);
  }
  causalityResults['ES=F_1h'] = { pass: true, checkedSignals: futSigFull.length };

  // 2) < 1e-12 Python sklearn.predict_proba vs JS ml_inference Parity across all 3 locked models
  const parityInputs = {};
  for (const asset of ['SPY', 'DIA', 'QQQ']) {
    const modelSpec = modelsArtifact.models[asset];
    const full = datasets[asset];
    const { calEnd, valEnd } = getSplitIndices(full.rows.length);
    assert.deepEqual(modelSpec.selectionMeta?.calRange, [0, calEnd], `${asset} calRange mismatch`);
    assert.deepEqual(modelSpec.selectionMeta?.valRange, [calEnd, valEnd], `${asset} valRange mismatch`);
    assert.deepEqual(modelSpec.selectionMeta?.holdoutRangeUntouched, [valEnd, full.rows.length], `${asset} holdoutRange mismatch`);

    const ctx = precomputeStockContextV6(full, aux);
    const sigs = generateStockSignalsV6(full, modelSpec.signalSpec, aux, ctx);
    const sampleSigs = sigs.slice(-Math.min(90, sigs.length));
    const rows = sampleSigs.map((s) => {
      const f = extractStockFeaturesV6(full, s, s.barIndex, aux, ctx);
      return {
        fmap: f,
        vec: modelSpec.featureNames.map(k => (Number.isFinite(f[k]) ? f[k] : null)),
      };
    });
    parityInputs[asset] = { modelSpec, rows };
  }

  const pyFullParity = `
import json, sys, numpy as np
from scipy.special import expit
from sklearn.linear_model import LogisticRegression

req = json.loads(sys.stdin.read())
out = {}
for asset, item in req.items():
    spec = item['modelSpec']
    X = np.array([[np.nan if v is None else float(v) for v in r['vec']] for r in item['rows']], dtype=np.float64)
    medians = np.array(spec['imputer']['medians'], dtype=np.float64)
    means = np.array(spec['scaler']['mean'], dtype=np.float64)
    scales = np.array(spec['scaler']['scale'], dtype=np.float64)
    X_imp = np.where(np.isnan(X), medians, X)
    X_sc = (X_imp - means) / np.where(scales == 0, 1.0, scales)
    if spec['modelType'] == 'logistic_regression':
        clf = LogisticRegression()
        clf.coef_ = np.array([spec['classifier']['coef']], dtype=np.float64)
        clf.intercept_ = np.array([spec['classifier']['intercept']], dtype=np.float64)
        clf.classes_ = np.array([0, 1])
        probs = clf.predict_proba(X_sc)[:, 1].tolist()
    elif spec['modelType'] == 'gradient_boosting':
        init_score = float(spec['classifier']['initScore'])
        lr = float(spec['classifier']['learningRate'])
        trees = spec['classifier']['trees']
        probs = []
        for row in X_sc:
            raw = init_score
            for tr in trees:
                idx = 0
                while tr['feature'][idx] >= 0:
                    f = tr['feature'][idx]
                    xf32 = np.float32(row[f])
                    idx = tr['childrenLeft'][idx] if xf32 <= tr['threshold'][idx] else tr['childrenRight'][idx]
                raw += lr * tr['value'][idx]
            probs.append(float(expit(raw)))
    out[asset] = probs
print(json.dumps(out))
`;
  const pyOut = JSON.parse(execFileSync('python3', ['-c', pyFullParity], {
    input: JSON.stringify(parityInputs),
    encoding: 'utf8',
  }));

  const parityResults = {};
  for (const asset of ['SPY', 'DIA', 'QQQ']) {
    const { modelSpec, rows } = parityInputs[asset];
    const pyProbs = pyOut[asset];
    let maxDiff = 0;
    for (let i = 0; i < rows.length; i++) {
      const jsScore = scoreCandidateV5(rows[i].fmap, modelSpec);
      const diff = Math.abs(jsScore.probWin - pyProbs[i]);
      if (diff > maxDiff) maxDiff = diff;
    }
    assert.ok(maxDiff < 1e-12, `${asset} Python vs JS parity failed: maxDiff=${maxDiff}`);
    parityResults[asset] = { pass: true, rowsChecked: rows.length, modelType: modelSpec.modelType, maxAbsDiff: maxDiff };
  }

  return { causalityResults, parityResults };
}

export function generateFutures1hSignalsCausal(futDs, modelSpec, aux) {
  const h1d = futDs.htf?.['1d'];
  assert.ok(h1d && Array.isArray(h1d.rows) && Array.isArray(h1d.alignedIndex),
    `Expected causal htf["1d"] on ${futDs.symbol}`);
  const dailyDs = {
    symbol: futDs.symbol,
    intervalSeconds: 86400,
    rows: h1d.rows,
  };
  const dailyCtx = precomputeStockContextV6(dailyDs, aux);
  const dailySpec = { ...modelSpec.signalSpec, warmup: 205 };
  const dailySigs = generateStockSignalsV6(dailyDs, dailySpec, aux, dailyCtx);
  const byDailyIdx = new Map();
  for (const ds of dailySigs) {
    const f = extractStockFeaturesV6(dailyDs, ds, ds.barIndex, aux, dailyCtx);
    const sc = scoreCandidateV5(f, modelSpec);
    byDailyIdx.set(ds.barIndex, { ds, sc });
  }

  const rawSignals = [];
  const mlSignals = [];
  let prevJ = -1;
  for (let i = 0; i < futDs.rows.length; i++) {
    const j = h1d.alignedIndex[i];
    if (j > prevJ && j >= 0) {
      assert.ok((h1d.rows[j].closeTime ?? (h1d.rows[j].time + 86400)) <= futDs.rows[i].time,
        `1d HTF lookahead on ${futDs.symbol} at 1h bar ${i}`);
      const hit = byDailyIdx.get(j);
      if (hit) {
        const baseSig = {
          barIndex: i,
          side: hit.ds.side,
          atr: hit.ds.atr,
          entryMode: hit.ds.entryMode,
          limitPrice: hit.ds.limitPrice,
          meta: { ...hit.ds.meta, htfDailyIndex: j, probWin: hit.sc.probWin },
        };
        rawSignals.push(baseSig);
        if (hit.sc.pass) {
          mlSignals.push({
            ...baseSig,
            sizeMult: hit.sc.sizeMult,
            meta: { ...baseSig.meta, sizeMult: hit.sc.sizeMult },
          });
        }
      }
      prevJ = j;
    }
  }
  return Object.assign(rawSignals, { mlSignals });
}

export function evalFullSuite() {
  assert.ok(fs.existsSync(MODELS_PATH), `Missing locked models at ${MODELS_PATH}; run train_v6_stocks.py first`);
  const modelsArtifact = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
  const { macro, datasets, aux } = loadEquitiesUniverse();

  const perIndex = {};
  const portfolioStreams = {
    full10y: [],
    oos5y: [],
    val3y: [],
    holdout2y: [],
  };

  for (const asset of ['SPY', 'DIA', 'QQQ']) {
    const modelSpec = modelsArtifact.models[asset];
    const full = datasets[asset];
    const { calEnd, valEnd, n } = getSplitIndices(full.rows.length);
    const ctx = precomputeStockContextV6(full, aux);

    const rawSignals = generateStockSignalsV6(full, modelSpec.signalSpec, aux, ctx);
    const mlSignals = applyStockMlFilterV6(full, rawSignals, modelSpec, aux, ctx);

    const runWindow = (sigs, startIdx, endIdx) => {
      const sim = simulateTradesV6(full.rows, sigs, {
        ...modelSpec.execOptions,
        start: startIdx,
        end: endIdx,
        warmup: 0,
      });
      return { sim, metrics: roundMetrics(sim) };
    };

    // Unsealed ONCE across all horizons: Cal, Val, Blind Holdout 2Y, Out-of-Sample 5Y, Full 10Y
    const windows = [
      ['cal_5y', 0, calEnd],
      ['val_3y', calEnd, valEnd],
      ['holdout_2y', valEnd, n],
      ['oos_5y', calEnd, n],
      ['full_10y', 0, n],
    ];

    const base = {};
    const ml = {};
    for (const [label, sIdx, eIdx] of windows) {
      const bRes = runWindow(rawSignals, sIdx, eIdx);
      const mRes = runWindow(mlSignals, sIdx, eIdx);
      base[label] = bRes.metrics;
      ml[label] = mRes.metrics;
      if (label === 'full_10y') {
        portfolioStreams.full10y.push({ id: asset, rows: full.rows, trades: mRes.sim.trades, intervalSeconds: 86400 });
      } else if (label === 'oos_5y') {
        portfolioStreams.oos5y.push({ id: asset, rows: full.rows, trades: mRes.sim.trades, intervalSeconds: 86400 });
      } else if (label === 'val_3y') {
        portfolioStreams.val3y.push({ id: asset, rows: full.rows, trades: mRes.sim.trades, intervalSeconds: 86400 });
      } else if (label === 'holdout_2y') {
        portfolioStreams.holdout2y.push({ id: asset, rows: full.rows, trades: mRes.sim.trades, intervalSeconds: 86400 });
      }
    }

    perIndex[asset] = {
      symbol: modelSpec.symbol,
      benchmarkSymbol: modelSpec.benchmarkSymbol,
      dates: {
        start: full.rows[0].date,
        calEnd: full.rows[calEnd - 1].date,
        valStart: full.rows[calEnd].date,
        valEnd: full.rows[valEnd - 1].date,
        holdoutStart: full.rows[valEnd].date,
        end: full.rows[n - 1].date,
      },
      modelType: modelSpec.modelType,
      features: modelSpec.featureNames,
      threshold: modelSpec.threshold,
      sizeCurve: modelSpec.sizeCurve,
      base,
      v60_ml: ml,
    };
  }

  // Multi-Index US Equity Sleeve via simulatePortfolioV6 (with exact per-window periodYears)
  const refRows = datasets.SPY.rows;
  const { calEnd: refCalEnd, valEnd: refValEnd, n: refN } = getSplitIndices(refRows.length);
  const spanYears = (a, b) => (refRows[b - 1].time - refRows[a].time) / SECONDS_PER_YEAR;
  const multiIndexPortfolio = {
    full_10y: roundPortfolio(simulatePortfolioV6(portfolioStreams.full10y, { maxTotalOpenLev: 3.0, periodYears: spanYears(0, refN) })),
    oos_5y: roundPortfolio(simulatePortfolioV6(portfolioStreams.oos5y, { maxTotalOpenLev: 3.0, periodYears: spanYears(refCalEnd, refN) })),
    val_3y: roundPortfolio(simulatePortfolioV6(portfolioStreams.val3y, { maxTotalOpenLev: 3.0, periodYears: spanYears(refCalEnd, refValEnd) })),
    holdout_2y: roundPortfolio(simulatePortfolioV6(portfolioStreams.holdout2y, { maxTotalOpenLev: 3.0, periodYears: spanYears(refValEnd, refN) })),
  };

  // 2-Year 1h Intraday Futures Out-of-Sample Check (ES=F, YM=F, NQ=F) using causal 1d HTF alignment
  const futures1hOos = {};
  const futuresStreams = [];
  for (const [asset, futFile, futSym] of [
    ['SPY', 'equities2y_es_1h.json', 'ES=F'],
    ['DIA', 'equities2y_ym_1h.json', 'YM=F'],
    ['QQQ', 'equities2y_nq_1h.json', 'NQ=F'],
  ]) {
    const modelSpec = modelsArtifact.models[asset];
    const futDs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, futFile), 'utf8'));
    const futAux = {
      macro,
      diaRows: datasets.DIA.rows,
      qqqRows: datasets.QQQ.rows,
    };
    const rawFutSigs = generateFutures1hSignalsCausal(futDs, modelSpec, futAux);
    const mlFutSigs = rawFutSigs.mlSignals;
    const futExec = {
      ...modelSpec.execOptions,
      warmup: 0,
      cooldown: 18,
      limitExpiryBars: (modelSpec.execOptions.limitExpiryBars ?? 2) * 23,
      maxHoldBars: (modelSpec.execOptions.maxHoldBars ?? 10) * 23,
      costPct: 0.04,
      slippagePct: 0.015,
      fundingPctPer8h: 0,
      allowTimeGaps: true,
    };
    const simFutBase = simulateTradesV6(futDs.rows, rawFutSigs, { ...futExec, start: 0, end: futDs.rows.length });
    const simFutMl = simulateTradesV6(futDs.rows, mlFutSigs, { ...futExec, start: 0, end: futDs.rows.length });
    futures1hOos[futSym] = {
      proxyAsset: asset,
      bars: futDs.rows.length,
      firstDate: futDs.rows[0].date,
      lastDate: futDs.rows[futDs.rows.length - 1].date,
      base: roundMetrics(simFutBase),
      v60_ml: roundMetrics(simFutMl),
    };
    futuresStreams.push({ id: futSym, rows: futDs.rows, trades: simFutMl.trades, intervalSeconds: 3600 });
  }
  const futuresPortfolio2y = roundPortfolio(simulatePortfolioV6(futuresStreams, { maxTotalOpenLev: 3.0 }));

  const verification = verifyStocksParityAndCausality(modelsArtifact, datasets, aux);

  const report = {
    schema: 'smc-v6-stocks-indices-report-v1',
    generatedAt: new Date().toISOString(),
    execProfile: 'EQUITY_ETF (costPct=0.04%, slippagePct=0.015%, gapStop at open, allowTimeGaps=true)',
    splitRule: 'Cal=[0..50%) (~5Y), Val=[50%..80%) (~3Y incl. 2022 bear), BlindHoldout=[80%..100%) (~2Y), OOS_5Y=[50%..100%) (~5Y)',
    perIndex,
    multiIndexPortfolio,
    futures1hOos,
    futuresPortfolio2y,
    verification,
  };

  fs.mkdirSync(RESULTS_V6_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function roundPortfolio(p) {
  const m = roundMetrics(p);
  return {
    ...m,
    peakOpenLev: Number((p.peakOpenLev ?? 0).toFixed(2)),
    scaledByCapCount: p.scaledByCapCount,
    skippedByCapCount: p.skippedByCapCount,
    perStream: p.perStream,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const arg = process.argv[2] ?? '--run-all';
  if (arg === '--calibrate-cv') {
    calibrateCalVal();
  } else if (arg === '--extract-cv') {
    extractCvForTrainer();
  } else if (arg === '--eval-val') {
    evalValForTrainer();
  } else if (arg === '--run-all') {
    evalFullSuite();
  } else {
    throw new Error(`Unknown CLI flag: ${arg}`);
  }
}
