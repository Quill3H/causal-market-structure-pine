import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTradesV6, summarizePerformanceV6 } from './sim_engine_v6.mjs';
import { alignFundingToBarsCausal } from './fetch_okx_derivs.mjs';
import {
  calcPineAtr,
  calcPineEma,
  computeOhlcFeatures1h,
  generateSignals1h,
  sliceDatasetPrefix1h,
} from './signals_1h.mjs';
import { calcPineRsi } from './signals_15m.mjs';
import {
  FEATURE_NAMES_V5,
  precomputeFeatureContextV5,
  extractCandidateFeaturesV5,
} from './features_v5.mjs';
import { scoreCandidateV5 } from './ml_inference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V6_DIR = path.join(HERE, 'results_v6');

export const ORDERFLOW_FEATURE_NAMES_V6 = Object.freeze([
  'tbr_1b',
  'delta_ratio_1b',
  'cvd_imb_6b',
  'cvd_imb_24b',
  'cvd_zscore_48',
  'avg_trade_size_rvol',
  'neg_funding_depth_bps',
  'launchpool_squeeze_flag',
  'launchpool_squeeze_score',
]);

export const FEATURE_NAMES_V6 = Object.freeze([
  ...FEATURE_NAMES_V5,
  ...ORDERFLOW_FEATURE_NAMES_V6,
]);

export function sliceDatasetPrefixV6(dataset, endLength) {
  const sliced = sliceDatasetPrefix1h(dataset, endLength);
  if (Array.isArray(dataset.fundingRows)) {
    const lastTime = sliced.lastTime;
    sliced.fundingRows = dataset.fundingRows.filter(f => f.time <= lastTime);
  }
  return sliced;
}

export function precomputeOrderflowContextV6(dataset, alignedFunding = null, maxBarIdx = null) {
  const limit = maxBarIdx === null ? dataset.rows.length : maxBarIdx + 1;
  const rows = dataset.rows;

  const tbr = new Float64Array(limit);
  const deltaVol = new Float64Array(limit);
  const cumVol6 = new Float64Array(limit);
  const cumDelta6 = new Float64Array(limit);
  const cumVol24 = new Float64Array(limit);
  const cumDelta24 = new Float64Array(limit);
  const cvdZ48 = new Float64Array(limit).fill(NaN);
  const tradeSizeRvol20 = new Float64Array(limit).fill(NaN);

  let v6 = 0;
  let d6 = 0;
  let v24 = 0;
  let d24 = 0;
  let tbrSum48 = 0;
  let tbrSq48 = 0;
  let avgSzSum20 = 0;
  const avgSz = new Float64Array(limit);

  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    const vol = Number.isFinite(r.volume) && r.volume > 0 ? r.volume : 0;
    const tbv = Number.isFinite(r.takerBuyVol) && r.takerBuyVol >= 0 ? Math.min(vol, r.takerBuyVol) : vol * 0.5;
    const trCnt = Number.isFinite(r.trades) && r.trades > 0 ? r.trades : 1;

    const rTbr = vol > 0 ? tbv / vol : 0.5;
    const rDelta = 2 * tbv - vol;
    tbr[i] = rTbr;
    deltaVol[i] = rDelta;

    v6 += vol;
    d6 += rDelta;
    if (i >= 6) {
      v6 -= rows[i - 6].volume > 0 ? rows[i - 6].volume : 0;
      d6 -= deltaVol[i - 6];
    }
    cumVol6[i] = v6;
    cumDelta6[i] = d6;

    v24 += vol;
    d24 += rDelta;
    if (i >= 24) {
      v24 -= rows[i - 24].volume > 0 ? rows[i - 24].volume : 0;
      d24 -= deltaVol[i - 24];
    }
    cumVol24[i] = v24;
    cumDelta24[i] = d24;

    tbrSum48 += rTbr;
    tbrSq48 += rTbr * rTbr;
    if (i >= 48) {
      const oldTbr = tbr[i - 48];
      tbrSum48 -= oldTbr;
      tbrSq48 -= oldTbr * oldTbr;
    }
    if (i >= 47) {
      const mean = tbrSum48 / 48;
      const std = Math.sqrt(Math.max(0, tbrSq48 / 48 - mean * mean));
      cvdZ48[i] = std > 1e-6 ? (rTbr - mean) / std : 0;
    }

    const sz = vol / trCnt;
    avgSz[i] = sz;
    tradeSizeRvol20[i] = i >= 20 && avgSzSum20 > 0 ? sz / (avgSzSum20 / 20) : NaN;
    avgSzSum20 += sz;
    if (i >= 20) avgSzSum20 -= avgSz[i - 20];
  }

  const v5Ctx = precomputeFeatureContextV5(dataset, alignedFunding, limit - 1);
  return {
    limit,
    v5Ctx,
    tbr,
    cumVol6,
    cumDelta6,
    cumVol24,
    cumDelta24,
    cvdZ48,
    tradeSizeRvol20,
    alignedFunding,
  };
}

export function extractCandidateFeaturesV6(dataset, signal, barIdx, alignedFunding = null, context = null) {
  const ctx = context ?? precomputeOrderflowContextV6(dataset, alignedFunding, barIdx);
  const base = extractCandidateFeaturesV5(dataset, signal, barIdx, alignedFunding ?? ctx.alignedFunding, ctx.v5Ctx);
  const side = signal.side;

  const tbr_1b = ctx.tbr[barIdx];
  const delta_ratio_1b = side * (2 * tbr_1b - 1);
  const cvd_imb_6b = ctx.cumVol6[barIdx] > 0 ? side * (ctx.cumDelta6[barIdx] / ctx.cumVol6[barIdx]) : 0;
  const cvd_imb_24b = ctx.cumVol24[barIdx] > 0 ? side * (ctx.cumDelta24[barIdx] / ctx.cumVol24[barIdx]) : 0;
  const cvd_zscore_48 = Number.isFinite(ctx.cvdZ48[barIdx]) ? side * ctx.cvdZ48[barIdx] : NaN;
  const avg_trade_size_rvol = ctx.tradeSizeRvol20[barIdx];

  const fSrc = alignedFunding ?? ctx.alignedFunding;
  const fItem = Array.isArray(fSrc) ? fSrc[barIdx] : null;
  const fRate = fItem && Number.isFinite(fItem.fundingRate) ? fItem.fundingRate : NaN;
  const neg_funding_depth_bps = Number.isFinite(fRate) ? Math.max(0, -fRate * 10000) : NaN;
  const launchpool_squeeze_flag = Number.isFinite(fRate)
    ? (fRate <= -0.0001 ? (side === 1 ? 1.0 : -1.0) : 0.0)
    : 0.0;
  const launchpool_squeeze_score = Number.isFinite(fRate)
    ? side * Math.max(0, -fRate * 10000 - 1.0)
    : 0.0;

  return {
    ...base,
    tbr_1b,
    delta_ratio_1b,
    cvd_imb_6b,
    cvd_imb_24b,
    cvd_zscore_48,
    avg_trade_size_rvol,
    neg_funding_depth_bps,
    launchpool_squeeze_flag,
    launchpool_squeeze_score,
  };
}

/**
 * Dedicated BTC 5Y Signal Generator:
 * Supports HtfSmcMultiTrap and AdaptiveTrapPolarity (matching BTC's 1h liquidity trap DNA).
 */
export function generateBtcSignalsV6(dataset, spec, precomputed = null) {
  return generateSignals1h(dataset, spec, precomputed);
}

/**
 * Dedicated BNB 5Y Signal Generator:
 * Exchange-token Mean-Reversion Liquidity Sweep / Range Pullback + Launchpool Negative-Funding Squeeze factor.
 * Strictly causal (closed bars <= i and aligned 4h/1d/funding <= rows[i].time).
 */
export function generateBnbSignalsV6(dataset, spec, alignedFunding = null) {
  assert.ok(dataset && Array.isArray(dataset.rows) && dataset.rows.length > 0, 'Expected BNB dataset');
  if (spec.family === 'AdaptiveTrapPolarity' || spec.family === 'HtfSmcMultiTrap') {
    const baseSigs = generateSignals1h(dataset, spec);
    if (!spec.useLaunchpoolSqueeze || !Array.isArray(alignedFunding)) {
      return baseSigs;
    }
    // Launchpool Negative-Funding Squeeze filter: when 8h funding <= -0.01%, suppress shorts fighting squeeze
    const thresh = spec.launchpoolFundingThresh ?? -0.0001;
    return baseSigs.filter(s => {
      const fRate = alignedFunding[s.barIndex]?.fundingRate ?? 0;
      if (fRate <= thresh && s.side === -1) return false;
      return true;
    });
  }
  const rows = dataset.rows;
  const h4 = dataset.htf?.['4h'];
  const d1 = dataset.htf?.['1d'];
  assert.ok(h4 && d1, 'BNB dataset requires 4h and 1d HTF');

  const f1 = computeOhlcFeatures1h(rows);
  const f4 = computeOhlcFeatures1h(h4.rows);
  const rsi14 = calcPineRsi(rows.map(r => r.close), 14);

  const warmup = spec.warmup ?? 250;
  const N = spec.lookback ?? 18;
  const K = spec.trapMaxBars ?? 3;
  const p4N = spec.p4Lookback ?? 8;
  const limitOffsetAtr = spec.limitOffsetAtr ?? 0.22;
  const htfMode = spec.htfMode ?? 'H4_20';
  const useLaunchpoolSqueeze = spec.useLaunchpoolSqueeze ?? true;
  const launchpoolFundingThresh = spec.launchpoolFundingThresh ?? -0.0001;
  const includeMeanRevPb = spec.includeMeanRevPb ?? true;
  const rsiExh = spec.rsiExh ?? 36;
  const pullAtrBand = spec.pullAtrBand ?? 1.4;

  const signals = [];
  for (let i = warmup; i < rows.length; i++) {
    const r = rows[i];
    const prev = rows[i - 1];
    const c = r.close;
    const atr = f1.atr14[i];
    if (!Number.isFinite(atr) || atr <= 0) continue;

    const j4 = h4.alignedIndex[i];
    const h4Row = h4.rows[j4];
    const h4Ema20 = f4.ema20[j4];
    const h4Ema50 = f4.ema50[j4];
    const jD = d1.alignedIndex[i];

    let bullBias = true;
    let bearBias = true;
    if (htfMode === 'H4_20') {
      bullBias = Number.isFinite(h4Ema20) && h4Row.close > h4Ema20;
      bearBias = Number.isFinite(h4Ema20) && h4Row.close < h4Ema20;
    } else if (htfMode === 'H4_50') {
      bullBias = Number.isFinite(h4Ema50) && h4Row.close > h4Ema50;
      bearBias = Number.isFinite(h4Ema50) && h4Row.close < h4Ema50;
    } else if (htfMode === 'H4_20_or_50') {
      bullBias = (Number.isFinite(h4Ema20) && h4Row.close > h4Ema20) || (Number.isFinite(h4Ema50) && h4Row.close > h4Ema50);
      bearBias = (Number.isFinite(h4Ema20) && h4Row.close < h4Ema20) || (Number.isFinite(h4Ema50) && h4Row.close < h4Ema50);
    }

    // 1. 1H + 4H + PDHL MultiTrap
    let bTrap = false;
    let sTrap = false;
    const pHigh = f1.prevHigh[N];
    const pLow = f1.prevLow[N];
    for (let k = 1; k <= K; k++) {
      if (i - k < N) continue;
      const lL = pLow[i - k];
      const lH = pHigh[i - k];
      let allB = true;
      let allA = true;
      for (let m = 1; m <= k; m++) {
        if (!(rows[i - m].close < lL)) allB = false;
        if (!(rows[i - m].close > lH)) allA = false;
      }
      if (allB && c > lL && c > r.open) bTrap = true;
      if (allA && c < lH && c < r.open) sTrap = true;
    }

    if (p4N && f4.prevHigh[p4N]) {
      const p4H = f4.prevHigh[p4N];
      const p4L = f4.prevLow[p4N];
      for (let k = 1; k <= K; k++) {
        const j4k = h4.alignedIndex[i - k];
        if (j4k < p4N) continue;
        const lL = p4L[j4k];
        const lH = p4H[j4k];
        let allB = true;
        let allA = true;
        for (let m = 1; m <= k; m++) {
          if (!(rows[i - m].close < lL)) allB = false;
          if (!(rows[i - m].close > lH)) allA = false;
        }
        if (allB && c > lL && c > r.open) bTrap = true;
        if (allA && c < lH && c < r.open) sTrap = true;
      }
    }

    if (spec.includePdhl ?? true) {
      const pdK = Math.min(2, K);
      for (let k = 1; k <= pdK; k++) {
        const jDk = d1.alignedIndex[i - k];
        const lL = d1.rows[jDk].low;
        const lH = d1.rows[jDk].high;
        let allB = true;
        let allA = true;
        for (let m = 1; m <= k; m++) {
          if (!(rows[i - m].close < lL)) allB = false;
          if (!(rows[i - m].close > lH)) allA = false;
        }
        if (allB && c > lL && c > r.open) bTrap = true;
        if (allA && c < lH && c < r.open) sTrap = true;
      }
    }

    // 2. Mean-reversion range pullback (tighter range bounce inside 4H regime)
    let bMeanRev = false;
    let sMeanRev = false;
    if (includeMeanRevPb && Number.isFinite(f1.ema50[i]) && Number.isFinite(rsi14[i - 1])) {
      const prevEma50 = f1.ema50[i - 1];
      const bandDn = prevEma50 - pullAtrBand * atr;
      const bandUp = prevEma50 + pullAtrBand * atr;
      bMeanRev = (prev.low <= bandDn || rsi14[i - 1] <= rsiExh) && c > r.open && (c - r.open) >= 0.35 * atr && c > prev.close;
      sMeanRev = (prev.high >= bandUp || rsi14[i - 1] >= (100 - rsiExh)) && c < r.open && (r.open - c) >= 0.35 * atr && c < prev.close;
    }

    // 3. BNB Launchpool Negative-Funding Squeeze anomaly (funding <= -0.01% => crowded shorts -> bullish bias override)
    const fRow = Array.isArray(alignedFunding) ? alignedFunding[i] : null;
    const fRate = fRow && Number.isFinite(fRow.fundingRate) ? fRow.fundingRate : 0;
    const isNegFundingSqueeze = useLaunchpoolSqueeze && fRate <= launchpoolFundingThresh;

    const bull = (bTrap || bMeanRev) && (bullBias || isNegFundingSqueeze);
    // Suppress marginal shorts during Launchpool negative-funding short-squeeze regime
    const bear = (sTrap || sMeanRev) && bearBias && !isNegFundingSqueeze;

    if (bull === bear) continue;
    const side = bull ? 1 : -1;
    const sig = { barIndex: i, side, atr };
    if (limitOffsetAtr > 0) {
      const limitPrice = c - side * limitOffsetAtr * atr;
      if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
      sig.limitPrice = limitPrice;
    }
    signals.push(sig);
  }
  return signals;
}

export function buildBtcCalValCatalogV6() {
  const specs = [];
  for (const adaptive of [true, false]) {
    for (const htfMode of ['H4_50', 'H4_20_or_50']) {
      for (const limitOffsetAtr of [0.15, 0.18, 0.22]) {
        for (const [stopAtr, minStopPct] of [[3.0, 1.3], [3.2, 1.4]]) {
          for (const rewardRisk of [1.15, 1.25]) {
            for (const [beTriggerR, beOffsetPct] of [[0.43, 0.34], [0.45, 0.40]]) {
              const virtExec = {
                entryMode: 'LIMIT_PULLBACK',
                limitExpiryBars: 6,
                pendingPolicy: 'ignore',
                limitSameBarTp: 'close',
                cooldown: 4,
                warmup: 250,
                stopAtr,
                minStopPct,
                rewardRisk,
                maxHoldBars: 96,
                beTriggerR,
                beOffsetPct,
                costPct: 0.10,
                slippagePct: 0.025,
              };
              const sigSpec = adaptive
                ? {
                    specId: `BTC_5Y_Adapt_${htfMode}_off${limitOffsetAtr}_s${stopAtr}_rr${rewardRisk}_be${beTriggerR}_${beOffsetPct}`,
                    family: 'AdaptiveTrapPolarity',
                    baseFamily: 'HtfSmcMultiTrap',
                    lookback: 20,
                    trapMaxBars: 4,
                    p4Lookback: 10,
                    includePdhl: true,
                    htfMode,
                    limitOffsetAtr,
                    winLen: 6,
                    slThresh: 2,
                    requireNegNet: true,
                    sharedHistory: false,
                    virtExec,
                  }
                : {
                    specId: `BTC_5Y_Multi_${htfMode}_off${limitOffsetAtr}_s${stopAtr}_rr${rewardRisk}_be${beTriggerR}_${beOffsetPct}`,
                    family: 'HtfSmcMultiTrap',
                    lookback: 20,
                    trapMaxBars: 4,
                    p4Lookback: 10,
                    includePdhl: true,
                    htfMode,
                    limitOffsetAtr,
                    virtExec,
                  };
              specs.push({
                id: sigSpec.specId,
                sigSpec,
                execOptions: { ...virtExec, volNormRiskPct: 4.5, minLev: 1.4, maxLev: 2.8 },
              });
            }
          }
        }
      }
    }
  }
  return specs;
}

export function buildBnbCalValCatalogV6() {
  const specs = [];
  for (const htfMode of ['H4_20', 'H4_50']) {
    for (const limitOffsetAtr of [0.22, 0.28]) {
      for (const [stopAtr, minStopPct] of [[3.0, 1.3], [3.4, 1.4]]) {
        for (const rewardRisk of [1.15, 1.25]) {
          for (const useLaunchpoolSqueeze of [true, false]) {
            const virtExec = {
              entryMode: 'LIMIT_PULLBACK',
              limitExpiryBars: 6,
              pendingPolicy: 'ignore',
              limitSameBarTp: 'close',
              cooldown: 4,
              warmup: 250,
              stopAtr,
              minStopPct,
              rewardRisk,
              maxHoldBars: 96,
              beTriggerR: 0.43,
              beOffsetPct: 0.36,
              costPct: 0.10,
              slippagePct: 0.025,
            };
            const sigSpec = {
              specId: `BNB_5Y_Ad_${htfMode}_lp${useLaunchpoolSqueeze ? 1 : 0}_off${limitOffsetAtr}_s${stopAtr}_rr${rewardRisk}`,
              family: 'AdaptiveTrapPolarity',
              baseFamily: 'HtfSmcMultiTrap',
              lookback: 20,
              trapMaxBars: 4,
              p4Lookback: 10,
              includePdhl: true,
              htfMode,
              limitOffsetAtr,
              winLen: 6,
              slThresh: 2,
              requireNegNet: true,
              sharedHistory: false,
              useLaunchpoolSqueeze,
              launchpoolFundingThresh: -0.0001,
              virtExec,
            };
            specs.push({
              id: sigSpec.specId,
              sigSpec,
              execOptions: { ...virtExec, volNormRiskPct: 3.5, minLev: 1.0, maxLev: 2.5 },
            });
          }
        }
      }
    }
  }
  return specs;
}

export function applyModelToSignalsV6(dataset, signals, alignedFunding, modelSpec) {
  const ctx = precomputeOrderflowContextV6(dataset, alignedFunding);
  const filtered = [];
  for (const s of signals) {
    const f = extractCandidateFeaturesV6(dataset, s, s.barIndex, alignedFunding, ctx);
    const sc = scoreCandidateV5(f, modelSpec);
    if (sc.pass) {
      filtered.push({
        ...s,
        sizeMult: sc.sizeMult,
        meta: { ...(s.meta ?? {}), probWin: sc.probWin, sizeMult: sc.sizeMult },
      });
    }
  }
  return filtered;
}

const DEFAULT_LOCKED_BTC_SPEC_V6 = Object.freeze({
  id: 'BTC_5Y_Adapt_H4_50_off0.18_s3.2_rr1.15_be0.43_0.34',
  sigSpec: {
    specId: 'BTC_5Y_Adapt_H4_50_off0.18_s3.2_rr1.15_be0.43_0.34',
    family: 'AdaptiveTrapPolarity',
    baseFamily: 'HtfSmcMultiTrap',
    lookback: 20,
    trapMaxBars: 4,
    p4Lookback: 10,
    includePdhl: true,
    htfMode: 'H4_50',
    limitOffsetAtr: 0.18,
    winLen: 6,
    slThresh: 2,
    requireNegNet: true,
    sharedHistory: false,
    virtExec: {
      entryMode: 'LIMIT_PULLBACK',
      limitExpiryBars: 6,
      pendingPolicy: 'ignore',
      limitSameBarTp: 'close',
      cooldown: 4,
      warmup: 250,
      stopAtr: 3.2,
      minStopPct: 1.4,
      rewardRisk: 1.15,
      maxHoldBars: 96,
      beTriggerR: 0.43,
      beOffsetPct: 0.34,
      costPct: 0.10,
      slippagePct: 0.025,
    },
  },
  execOptions: {
    entryMode: 'LIMIT_PULLBACK',
    limitExpiryBars: 6,
    pendingPolicy: 'ignore',
    limitSameBarTp: 'close',
    cooldown: 4,
    warmup: 250,
    stopAtr: 3.2,
    minStopPct: 1.4,
    rewardRisk: 1.15,
    maxHoldBars: 96,
    beTriggerR: 0.43,
    beOffsetPct: 0.34,
    costPct: 0.10,
    slippagePct: 0.025,
    volNormRiskPct: 4.5,
    minLev: 1.4,
    maxLev: 2.8,
  },
});

export function calibrateStructuralCalValV6(sym, dsCV, alignedFundingCV) {
  const n = dsCV.rows.length;
  const calEnd = Math.floor((0.50 / 0.80) * n); // proportional Cal inside [0..valEnd)
  const catalog = sym === 'BTCUSDT' ? buildBtcCalValCatalogV6() : buildBnbCalValCatalogV6();
  const pre1h = sym === 'BTCUSDT'
    ? {
        f1: computeOhlcFeatures1h(dsCV.rows),
        f4: computeOhlcFeatures1h(dsCV.htf['4h'].rows),
        fD: dsCV.htf['1d'] ? computeOhlcFeatures1h(dsCV.htf['1d'].rows) : null,
        rawSignalsByKey: new Map(),
        virtTradesByKey: new Map(),
      }
    : null;

  let best = null;
  for (const cand of catalog) {
    const signals = sym === 'BTCUSDT'
      ? generateBtcSignalsV6(dsCV, cand.sigSpec, pre1h)
      : generateBnbSignalsV6(dsCV, cand.sigSpec, alignedFundingCV);

    const simCV = simulateTradesV6(dsCV.rows, signals, {
      ...cand.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      start: 0,
      end: n,
      intervalSeconds: 3600,
    });
    const simCal = summarizePerformanceV6(simCV.trades, dsCV.rows, 0, calEnd);
    const simVal = summarizePerformanceV6(simCV.trades, dsCV.rows, calEnd, n);

    const wrCV = simCV.winRatePct ?? 0;
    const pfCV = simCV.profitFactor ?? 0;
    const calmarCV = (simCV.compoundedMaxDrawdownPct ?? 100) > 0
      ? (simCV.compoundedNetPct ?? 0) / simCV.compoundedMaxDrawdownPct
      : 0;
    const eligible = (simCV.count ?? 0) >= 180
      && wrCV >= 65.0
      && pfCV >= 1.25
      && (simCal.profitFactor ?? 0) >= 1.10
      && (simVal.profitFactor ?? 0) >= 1.10;
    const score = (eligible ? 10000 : 0)
      + (simCV.compoundedNetPct ?? 0)
      + 30 * calmarCV
      + 80 * (pfCV - 1)
      + 2 * (wrCV - 65);
    if (!best || score > best.score) {
      best = { score, eligible, cand, simCV };
    }
  }
  return best.cand;
}

function loadCrypto5y(sym) {
  const fileName = sym === 'BTCUSDT' ? 'crypto5y_btcusdt_1h.json' : 'crypto5y_bnbusdt_1h.json';
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8'));
}

function formatPerf(p) {
  return {
    count: p.count,
    wins: p.wins,
    losses: p.losses,
    winRatePct: Number((p.winRatePct ?? 0).toFixed(2)),
    profitFactor: Number((p.profitFactor ?? 0).toFixed(2)),
    totalNetPct: Number((p.totalNetPct ?? 0).toFixed(2)),
    compoundedNetPct: Number((p.compoundedNetPct ?? 0).toFixed(2)),
    cagrPct: Number((p.cagrPct ?? 0).toFixed(2)),
    maxDrawdownPct: Number((p.maxDrawdownPct ?? 0).toFixed(2)),
    compoundedMaxDrawdownPct: Number((p.compoundedMaxDrawdownPct ?? 0).toFixed(2)),
    sharpe: Number((p.sharpe ?? 0).toFixed(2)),
    sortino: Number((p.sortino ?? 0).toFixed(2)),
    calmar: Number((p.calmar ?? 0).toFixed(2)),
    buyHoldPct: Number((p.buyHoldPct ?? 0).toFixed(2)),
    buyHoldMaxDdPct: Number((p.buyHoldMaxDdPct ?? 0).toFixed(2)),
  };
}

function extractCalValPayload() {
  const out = {};
  for (const sym of ['BTCUSDT', 'BNBUSDT']) {
    const full = loadCrypto5y(sym);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV6(full, valEnd);
    const alignedFundingCV = alignFundingToBarsCausal(dsCV.rows, dsCV.fundingRows ?? []);
    const structural = calibrateStructuralCalValV6(sym, dsCV, alignedFundingCV);

    const signals = sym === 'BTCUSDT'
      ? generateBtcSignalsV6(dsCV, structural.sigSpec)
      : generateBnbSignalsV6(dsCV, structural.sigSpec, alignedFundingCV);

    const ctx = precomputeOrderflowContextV6(dsCV, alignedFundingCV);
    const sigFeatures = signals.map(s => {
      const fmap = extractCandidateFeaturesV6(dsCV, s, s.barIndex, alignedFundingCV, ctx);
      return {
        barIndex: s.barIndex,
        side: s.side,
        atr: s.atr,
        limitPrice: s.limitPrice ?? null,
        vec: FEATURE_NAMES_V6.map(k => (Number.isFinite(fmap[k]) ? fmap[k] : null)),
      };
    });

    const baseOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      intervalSeconds: 3600,
    };
    const simCal = simulateTradesV6(dsCV.rows, signals, { ...baseOpts, start: 0, end: calEnd });
    const simVal = simulateTradesV6(dsCV.rows, signals, { ...baseOpts, start: calEnd, end: valEnd });
    const sigIdxByBar = new Map(signals.map((s, idx) => [s.barIndex, idx]));

    const calSequential = simCal.trades
      .filter(t => t.signalIndex >= 0 && t.exitIndex < calEnd)
      .map(t => ({ idx: sigIdxByBar.get(t.signalIndex), barIndex: t.signalIndex, y: t.netPct > 0 ? 1 : 0, netPct: t.netPct }));
    const valSequential = simVal.trades
      .filter(t => t.signalIndex >= calEnd && t.exitIndex < valEnd)
      .map(t => ({ idx: sigIdxByBar.get(t.signalIndex), barIndex: t.signalIndex, y: t.netPct > 0 ? 1 : 0, netPct: t.netPct }));

    const baseValPerf = summarizePerformanceV6(simVal.trades, dsCV.rows, calEnd, valEnd, { periodYears: (valEnd - calEnd) / 8760 });
    out[sym] = {
      symbol: sym,
      totalBarsFull: n,
      calEnd,
      valEnd,
      featureNames: FEATURE_NAMES_V6,
      structuralSpec: structural,
      signals: sigFeatures,
      calSequential,
      valSequential,
      baseVal: formatPerf(baseValPerf),
    };
  }
  return out;
}

function evalValBatch(req) {
  const out = {};
  for (const sym of ['BTCUSDT', 'BNBUSDT']) {
    const full = loadCrypto5y(sym);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV6(full, valEnd);
    const alignedFundingCV = alignFundingToBarsCausal(dsCV.rows, dsCV.fundingRows ?? []);
    const payload = req[sym];
    const structural = payload.structuralSpec;
    const items = payload.items;
    const baseSignals = sym === 'BTCUSDT'
      ? generateBtcSignalsV6(dsCV, structural.sigSpec)
      : generateBnbSignalsV6(dsCV, structural.sigSpec, alignedFundingCV);
    const execOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      intervalSeconds: 3600,
    };

    const rowsVal = dsCV.rows.slice(calEnd, valEnd);
    const valYears = rowsVal.length / 8760;
    const cache = new Map();
    const results = [];
    for (const cand of items) {
      const filteredVal = [];
      const keyParts = [];
      const isFlat = !cand.sizeCurve || cand.sizeCurve.mode === 'flat';
      for (let k = 0; k < baseSignals.length; k++) {
        const s = baseSignals[k];
        if (s.barIndex < calEnd || s.barIndex >= valEnd) continue;
        const p = cand.probs[k];
        if (p >= cand.threshold) {
          let sizeMult = 1.0;
          if (!isFlat && cand.sizeCurve.mode === 'linear') {
            const pMax = cand.sizeCurve.pMax;
            const u = Math.max(0, Math.min(1, (p - cand.threshold) / Math.max(1e-6, pMax - cand.threshold)));
            sizeMult = cand.sizeCurve.minMult + u * (cand.sizeCurve.maxMult - cand.sizeCurve.minMult);
          }
          filteredVal.push({ ...s, barIndex: s.barIndex - calEnd, sizeMult });
          if (isFlat) keyParts.push(k);
        }
      }
      let metrics;
      if (isFlat) {
        const cKey = keyParts.join(',');
        metrics = cache.get(cKey);
        if (!metrics) {
          const simV = simulateTradesV6(rowsVal, filteredVal, { ...execOpts, start: 0, end: rowsVal.length, warmup: 0 });
          metrics = formatPerf(summarizePerformanceV6(simV.trades, rowsVal, 0, rowsVal.length, { periodYears: valYears }));
          cache.set(cKey, metrics);
        }
      } else {
        const simV = simulateTradesV6(rowsVal, filteredVal, { ...execOpts, start: 0, end: rowsVal.length, warmup: 0 });
        metrics = formatPerf(summarizePerformanceV6(simV.trades, rowsVal, 0, rowsVal.length, { periodYears: valYears }));
      }
      results.push({ id: cand.id, val: metrics });
    }
    out[sym] = results;
  }
  return out;
}

export function evaluateAssetV6(sym, modelSpec, execProfile = 'EXCHANGE_POST_ONLY') {
  const ds = loadCrypto5y(sym);
  const n = ds.rows.length;
  const calEnd = Math.floor(0.50 * n);
  const valEnd = Math.floor(0.80 * n);
  const alignedFunding = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
  const structural = modelSpec.structuralSpec ?? (sym === 'BTCUSDT' ? DEFAULT_LOCKED_BTC_SPEC_V6 : calibrateStructuralCalValV6(sym, sliceDatasetPrefixV6(ds, valEnd), alignedFunding.slice(0, valEnd)));

  const rawSignals = sym === 'BTCUSDT'
    ? generateBtcSignalsV6(ds, structural.sigSpec)
    : generateBnbSignalsV6(ds, structural.sigSpec, alignedFunding);
  const mlSignals = applyModelToSignalsV6(ds, rawSignals, alignedFunding, modelSpec);

  const opts = {
    ...structural.execOptions,
    execProfile,
    fundingRows: ds.fundingRows,
    fundingPctPer8h: 0.01,
    intervalSeconds: 3600,
    start: 0,
    end: n,
  };

  const simBase = simulateTradesV6(ds.rows, rawSignals, opts);
  const simMl = simulateTradesV6(ds.rows, mlSignals, opts);

  const summarize = (trades, lo, hi) => formatPerf(
    summarizePerformanceV6(trades, ds.rows, lo, hi, { periodYears: (hi - lo) / 8760 }),
  );

  // Year-by-year breakdown (5 equal chronological segments)
  const yearSize = Math.floor(n / 5);
  const yearlyBase = [];
  const yearlyMl = [];
  for (let y = 0; y < 5; y++) {
    const lo = y * yearSize;
    const hi = y === 4 ? n : (y + 1) * yearSize;
    yearlyBase.push({ year: `Y${y + 1}`, range: [lo, hi], ...summarize(simBase.trades, lo, hi) });
    yearlyMl.push({ year: `Y${y + 1}`, range: [lo, hi], ...summarize(simMl.trades, lo, hi) });
  }

  return {
    symbol: sym,
    execProfile,
    bars: n,
    splits: { cal: [0, calEnd], val: [calEnd, valEnd], holdoutY5: [valEnd, n] },
    rows: ds.rows,
    baselineTrades: simBase.trades,
    mlTrades: simMl.trades,
    baseline: {
      cal: summarize(simBase.trades, 0, calEnd),
      val: summarize(simBase.trades, calEnd, valEnd),
      holdoutY5: summarize(simBase.trades, valEnd, n),
      full5y: summarize(simBase.trades, 0, n),
      yearly: yearlyBase,
    },
    ml: {
      cal: summarize(simMl.trades, 0, calEnd),
      val: summarize(simMl.trades, calEnd, valEnd),
      holdoutY5: summarize(simMl.trades, valEnd, n),
      full5y: summarize(simMl.trades, 0, n),
      yearly: yearlyMl,
    },
  };
}

export function getBtcBnbPortfolioStreamsV6(execProfile = 'EXCHANGE_POST_ONLY') {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V6_DIR, 'models_btc_bnb_5y.json'), 'utf8'));
  const btcRes = evaluateAssetV6('BTCUSDT', modelsJson.models.BTCUSDT, execProfile);
  const bnbRes = evaluateAssetV6('BNBUSDT', modelsJson.models.BNBUSDT, execProfile);
  return {
    BTCUSDT: { id: 'BTC_5Y', rows: btcRes.rows, trades: btcRes.mlTrades, summary: btcRes },
    BNBUSDT: { id: 'BNB_5Y', rows: bnbRes.rows, trades: bnbRes.mlTrades, summary: bnbRes },
  };
}

export async function runSuiteV6BtcBnb() {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V6_DIR, 'models_btc_bnb_5y.json'), 'utf8'));
  const results = {};
  for (const sym of ['BTCUSDT', 'BNBUSDT']) {
    results[sym] = {};
    for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
      const r = evaluateAssetV6(sym, modelsJson.models[sym], prof);
      const { rows, baselineTrades, mlTrades, ...clean } = r;
      results[sym][prof] = clean;
      console.log(`\n[${sym} ${prof}]`);
      console.log(`  Base | Cal: WR=${clean.baseline.cal.winRatePct}% PF=${clean.baseline.cal.profitFactor} Comp=${clean.baseline.cal.compoundedNetPct}% | Val: WR=${clean.baseline.val.winRatePct}% PF=${clean.baseline.val.profitFactor} Comp=${clean.baseline.val.compoundedNetPct}% | Y5: n=${clean.baseline.holdoutY5.count} WR=${clean.baseline.holdoutY5.winRatePct}% PF=${clean.baseline.holdoutY5.profitFactor} Comp=${clean.baseline.holdoutY5.compoundedNetPct}% | 5Y: n=${clean.baseline.full5y.count} WR=${clean.baseline.full5y.winRatePct}% PF=${clean.baseline.full5y.profitFactor} Comp=${clean.baseline.full5y.compoundedNetPct}% DD=${clean.baseline.full5y.compoundedMaxDrawdownPct}%`);
      console.log(`  ML   | Cal: WR=${clean.ml.cal.winRatePct}% PF=${clean.ml.cal.profitFactor} Comp=${clean.ml.cal.compoundedNetPct}% | Val: WR=${clean.ml.val.winRatePct}% PF=${clean.ml.val.profitFactor} Comp=${clean.ml.val.compoundedNetPct}% | Y5: n=${clean.ml.holdoutY5.count} WR=${clean.ml.holdoutY5.winRatePct}% PF=${clean.ml.holdoutY5.profitFactor} Comp=${clean.ml.holdoutY5.compoundedNetPct}% | 5Y: n=${clean.ml.full5y.count} WR=${clean.ml.full5y.winRatePct}% PF=${clean.ml.full5y.profitFactor} Comp=${clean.ml.full5y.compoundedNetPct}% DD=${clean.ml.full5y.compoundedMaxDrawdownPct}%`);
    }
  }

  fs.mkdirSync(RESULTS_V6_DIR, { recursive: true });
  const summary = {
    schema: 'smc-v6-btc-bnb-5y-summary-v1',
    generatedAt: new Date().toISOString(),
    modelMetadata: {
      BTCUSDT: modelsJson.models.BTCUSDT.selectionMeta,
      BNBUSDT: modelsJson.models.BNBUSDT.selectionMeta,
    },
    assets: results,
  };
  const outPath = path.join(RESULTS_V6_DIR, 'crypto_btc_bnb_5y.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n[suite_v6_btc_bnb] Wrote ${path.relative(ROOT_DIR, outPath)}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--extract-cal-val')) {
    process.stdout.write(JSON.stringify(extractCalValPayload()));
  } else if (process.argv.includes('--eval-val')) {
    const req = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(evalValBatch(req)));
  } else {
    runSuiteV6BtcBnb().catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}
