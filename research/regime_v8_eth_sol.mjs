#!/usr/bin/env node
/**
 * Asymmetric Macro-Regime v8.0 5-Year Suite for SOL & ETH:
 *   - SOL_15m, SOL_1h, ETH_15m, ETH_1h
 *   - Uses 100% causal regime_engine_v8.mjs (1D/4H macro trend + 4-coin breadth + BEAR_SQUEEZE guard):
 *       * BULL_TREND: prioritize Bull Pullback / MultiTrap Longs; block counter-trend Shorts
 *       * BEAR_TREND: block knife-catching Longs; activate Bear Rally-Fade / Selling-Delta Shorts (avoid BEAR_SQUEEZE)
 *       * RANGE_CHOP: optional selective outer traps on Long side or stand aside
 *   - Separate Long vs Short purged scikit-learn Meta-Labeling (`longModel` + `shortModel`)
 *
 * Chronological 5-Year Anti-Leakage Split:
 *   - Cal:              [0 .. 50%)   (includes 2022 Bear + 2023 Bull)
 *   - Val:              [50% .. 80%) (2023-2025)
 *   - Blind Holdout Y5: [80% .. 100%) (NEVER inspected or tuned during calibration/ML fit)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTradesV7, summarizeMonthlyCashflowV7 } from './sim_engine_v7.mjs';
import { alignFundingToBarsCausal } from './fetch_okx_derivs.mjs';
import { computeOhlcFeatures1h, generateSignals1h, sliceDatasetPrefix1h } from './signals_1h.mjs';
import {
  CRYPTO_REGIMES_V8,
  precomputeCryptoBreadthV8,
  precomputeAssetRegimeV8,
} from './regime_engine_v8.mjs';
import {
  precomputeOrderflowContextV6,
  extractCandidateFeaturesV6,
} from './suite_v6_btc_bnb.mjs';
import {
  ETH_FEATURE_NAMES_V6,
  SOL_FEATURE_NAMES_V6,
  precomputeEthCrossContextV6,
  extractEthCandidateFeaturesV6,
  generateEthSignalsV6,
  generateSolSignalsV6,
} from './suite_v6_eth_sol.mjs';
import {
  sliceDatasetPrefixV7,
  precompute15mV7,
  generate15mSignalsV7,
} from './high_wr_v7_btc_bnb.mjs';
import { scoreCandidateV5 } from './ml_inference.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V8_DIR = path.join(ROOT_DIR, 'research', 'results_v8');

export const V8_ETH_SOL_STREAM_KEYS = ['SOL_15m', 'SOL_1h', 'ETH_15m', 'ETH_1h'];

export const V8_REGIME_FEATURE_NAMES = [
  'reg_trend_score',
  'reg_d1_ema50_dist_atr',
  'reg_d1_ema200_dist_atr',
  'reg_d1_slope_atr',
  'reg_breadth_bear',
  'reg_h4_rally_exh',
  'reg_is_bull',
  'reg_is_bear',
  'reg_is_chop',
];

function loadStreamDatasetV8(key) {
  const map = {
    SOL_15m: 'crypto5y_solusdt_15m.json',
    SOL_1h: 'crypto5y_solusdt_1h.json',
    ETH_15m: 'crypto5y_ethusdt_15m.json',
    ETH_1h: 'crypto5y_ethusdt_1h.json',
    BTC_15m: 'crypto5y_btcusdt_15m.json',
    BTC_1h: 'crypto5y_btcusdt_1h.json',
    BNB_1h: 'crypto5y_bnbusdt_1h.json',
  };
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, map[key]), 'utf8'));
}

function slice1hByMaxTime(ds1h, maxBarTime) {
  let endLen = ds1h.rows.length;
  while (endLen > 0 && ds1h.rows[endLen - 1].time > maxBarTime) endLen--;
  return sliceDatasetPrefix1h(ds1h, Math.max(1, endLen));
}

function loadBreadthDatasets1h(maxBarTime = null) {
  const raw = {
    BTCUSDT: loadStreamDatasetV8('BTC_1h'),
    ETHUSDT: loadStreamDatasetV8('ETH_1h'),
    SOLUSDT: loadStreamDatasetV8('SOL_1h'),
    BNBUSDT: loadStreamDatasetV8('BNB_1h'),
  };
  if (maxBarTime === null) return raw;
  return {
    BTCUSDT: slice1hByMaxTime(raw.BTCUSDT, maxBarTime),
    ETHUSDT: slice1hByMaxTime(raw.ETHUSDT, maxBarTime),
    SOLUSDT: slice1hByMaxTime(raw.SOLUSDT, maxBarTime),
    BNBUSDT: slice1hByMaxTime(raw.BNBUSDT, maxBarTime),
  };
}

function stripMonthly(m) {
  const { monthlyTable, ...rest } = m;
  return rest;
}

function summarizeSliceV8(trades, rows, lo, hi, sideFilter = null) {
  const filtered = trades.filter(t => {
    const idxStart = t.signalIndex ?? t.entryIndex;
    if (!(idxStart >= lo && t.exitIndex < hi)) return false;
    if (sideFilter !== null && t.side !== sideFilter) return false;
    return true;
  });
  return summarizeMonthlyCashflowV7(filtered, {
    startTime: rows[lo].time,
    endTime: rows[hi - 1].time,
    rows,
  });
}

function summarizeDirectionalV8(trades, rows, calEnd, valEnd, n) {
  const buildDir = sideFilter => ({
    cal: stripMonthly(summarizeSliceV8(trades, rows, 0, calEnd, sideFilter)),
    val: stripMonthly(summarizeSliceV8(trades, rows, calEnd, valEnd, sideFilter)),
    calVal: stripMonthly(summarizeSliceV8(trades, rows, 0, valEnd, sideFilter)),
    holdoutY5: stripMonthly(summarizeSliceV8(trades, rows, valEnd, n, sideFilter)),
    full5y: stripMonthly(summarizeSliceV8(trades, rows, 0, n, sideFilter)),
  });
  return {
    longSummary: buildDir(1),
    shortSummary: buildDir(-1),
  };
}

function barTakerSellRatio(rows, idx) {
  const r = rows[idx];
  const vol = Number.isFinite(r.volume) && r.volume > 0 ? r.volume : 0;
  if (vol <= 0) return 0.5;
  const tbv = Number.isFinite(r.takerBuyVol) ? Math.min(vol, Math.max(0, r.takerBuyVol)) : vol * 0.5;
  return 1 - tbv / vol;
}

function barTakerBuyRatio(rows, idx) {
  return 1 - barTakerSellRatio(rows, idx);
}

function isLongRegimeAllowed(regName, mode) {
  if (mode === 'BULL_ONLY') return regName === CRYPTO_REGIMES_V8.BULL_TREND;
  if (mode === 'BULL_CHOP') return regName === CRYPTO_REGIMES_V8.BULL_TREND || regName === CRYPTO_REGIMES_V8.RANGE_CHOP;
  return false;
}

function isShortRegimeAllowed(regName, mode) {
  if (regName === CRYPTO_REGIMES_V8.BEAR_SQUEEZE) return false;
  if (mode === 'BEAR_ONLY') return regName === CRYPTO_REGIMES_V8.BEAR_TREND;
  if (mode === 'BEAR_CHOP') return regName === CRYPTO_REGIMES_V8.BEAR_TREND || regName === CRYPTO_REGIMES_V8.RANGE_CHOP;
  return false;
}

/**
 * Generates asymmetric Long (Bull/Chop) + Short (Bear Rally-Fade / Selling-Delta, no Squeeze) signals.
 * Uses strictly causal bars <= i and precomputed causal regimeCtx.
 */
export function generateEthSolStreamSignalsV8(streamKey, dataset, spec, regimeCtx, btcDataset = null, precomputed = null) {
  const is15m = streamKey.endsWith('_15m');
  const rows = dataset.rows;
  let baseLongPool = [];
  let baseShortPool = [];

  if (is15m) {
    const pre15 = precomputed?.pre15 ?? precompute15mV7(dataset);
    const lSigs = generate15mSignalsV7(dataset, spec.longSpec, pre15);
    const sSigs = spec.shortSpec.specId === spec.longSpec.specId
      ? lSigs
      : generate15mSignalsV7(dataset, spec.shortSpec, pre15);
    baseLongPool = lSigs.filter(s => s.side === 1);
    baseShortPool = sSigs.filter(s => s.side === -1);
  } else if (streamKey === 'SOL_1h') {
    const preSol = precomputed?.sol ?? {
      f1: computeOhlcFeatures1h(rows),
      f4: computeOhlcFeatures1h(dataset.htf['4h'].rows),
    };
    const preOhlc = precomputed?.ohlc ?? preSol.f1;
    const lSigs = spec.longSpec.genKind === 'sol_v6'
      ? generateSolSignalsV6(dataset, spec.longSpec, preSol)
      : generateSignals1h(dataset, spec.longSpec, preOhlc);
    const sSigs = spec.shortSpec.genKind === 'sol_v6'
      ? generateSolSignalsV6(dataset, spec.shortSpec, preSol)
      : generateSignals1h(dataset, spec.shortSpec, preOhlc);
    baseLongPool = lSigs.filter(s => s.side === 1);
    baseShortPool = sSigs.filter(s => s.side === -1);
  } else if (streamKey === 'ETH_1h') {
    const preOhlc = precomputed?.ohlc ?? computeOhlcFeatures1h(rows);
    const lSigs = generateEthSignalsV6(dataset, btcDataset, spec.longSpec, preOhlc);
    const sSigs = spec.shortSpec.specId === spec.longSpec.specId
      ? lSigs
      : generateEthSignalsV6(dataset, btcDataset, spec.shortSpec, preOhlc);
    baseLongPool = lSigs.filter(s => s.side === 1);
    baseShortPool = sSigs.filter(s => s.side === -1);
  } else {
    throw new Error(`Unknown v8 ETH/SOL streamKey: ${streamKey}`);
  }

  const out = [];
  for (const s of baseLongPool) {
    const idx = s.barIndex;
    const regName = regimeCtx.regime[idx];
    if (!isLongRegimeAllowed(regName, spec.longRegimeMode ?? 'BULL_CHOP')) continue;
    if (spec.longMinTbr && barTakerBuyRatio(rows, idx) < spec.longMinTbr) continue;
    out.push({
      ...s,
      meta: {
        ...(s.meta ?? {}),
        regime: regName,
        regimeSizeMult: regimeCtx.longSizeMult[idx],
        dirTag: 'BULL_LONG',
      },
    });
  }

  for (const s of baseShortPool) {
    const idx = s.barIndex;
    const regName = regimeCtx.regime[idx];
    if (!isShortRegimeAllowed(regName, spec.shortRegimeMode ?? 'BEAR_ONLY')) continue;
    if (spec.shortRequireExh && regimeCtx.h4RallyExh[idx] !== 1) continue;
    if (spec.shortMinSellRatio && barTakerSellRatio(rows, idx) < spec.shortMinSellRatio) continue;
    out.push({
      ...s,
      meta: {
        ...(s.meta ?? {}),
        regime: regName,
        regimeSizeMult: regimeCtx.shortSizeMult[idx],
        dirTag: 'BEAR_RALLY_FADE_SHORT',
      },
    });
  }

  out.sort((a, b) => a.barIndex - b.barIndex || b.side - a.side);
  return out;
}

function build15mCatalogV8(coin) {
  const isSol = coin === 'SOLUSDT';
  const specs = [];
  const exitCombos = isSol
    ? [
        { tp1TriggerR: 0.58, tp1QtyPct: 55, tp1LockOffsetR: 0.36, rewardRisk: 1.25, beTriggerR: 0.38, beOffsetPct: 0.30, stopAtr: 4.5, minStopPct: 1.30 },
        { tp1TriggerR: 0.65, tp1QtyPct: 55, tp1LockOffsetR: 0.40, rewardRisk: 1.30, beTriggerR: 0.40, beOffsetPct: 0.32, stopAtr: 4.8, minStopPct: 1.35 },
      ]
    : [
        { tp1TriggerR: 0.58, tp1QtyPct: 55, tp1LockOffsetR: 0.36, rewardRisk: 1.25, beTriggerR: 0.38, beOffsetPct: 0.30, stopAtr: 5.0, minStopPct: 1.35 },
        { tp1TriggerR: 0.65, tp1QtyPct: 55, tp1LockOffsetR: 0.40, rewardRisk: 1.30, beTriggerR: 0.40, beOffsetPct: 0.32, stopAtr: 5.2, minStopPct: 1.40 },
      ];

  const pullAtr = isSol ? 0.18 : 0.25;
  for (const longHtf of ['H4_20', 'H4_20_or_50']) {
    for (const shortHtf of ['H4_20', 'H4_20_or_50']) {
      for (const longRegimeMode of ['BULL_ONLY', 'BULL_CHOP']) {
        for (const shortMinSellRatio of (isSol ? [null, 0.48] : [0.48, 0.50])) {
          for (const ex of exitCombos) {
            const specId = `${coin}_15m_V8_L${longHtf}_${longRegimeMode}_S${shortHtf}_sell${shortMinSellRatio ?? 'all'}_tp${ex.tp1TriggerR}`;
            const mk = (htfMode) => ({
              specId: `${specId}_${htfMode}`,
              rawFamily: 'M15_H1SyncedMultiTrap',
              h1Lookback: 20,
              h4Lookback: 10,
              ltfLookback: null,
              include24h: true,
              trapMaxBars: 4,
              htfMode,
              minAtrPct: 0.14,
              pullAtr,
              adaptive: false,
            });
            const execOptions = {
              entryMode: 'LIMIT_PULLBACK',
              limitExpiryBars: 8,
              pendingPolicy: 'ignore',
              limitSameBarTp: 'close',
              cooldown: 6,
              warmup: 250,
              stopAtr: ex.stopAtr,
              minStopPct: ex.minStopPct,
              rewardRisk: ex.rewardRisk,
              maxHoldBars: 160,
              beTriggerR: ex.beTriggerR,
              beOffsetPct: ex.beOffsetPct,
              tp1TriggerR: ex.tp1TriggerR,
              tp1QtyPct: ex.tp1QtyPct,
              tp1FeeMode: 'MAKER',
              tp1LockOffsetR: ex.tp1LockOffsetR,
              costPct: 0.10,
              slippagePct: 0.025,
              volNormRiskPct: 3.0,
              minLev: 1.0,
              maxLev: 2.5,
            };
            specs.push({
              id: specId,
              sigSpec: {
                specId,
                longSpec: mk(longHtf),
                shortSpec: mk(shortHtf),
                longRegimeMode,
                shortRegimeMode: 'BEAR_ONLY',
                shortMinSellRatio,
                shortRequireExh: false,
              },
              execOptions,
            });
          }
        }
      }
    }
  }
  return specs;
}

function buildSol1hCatalogV8() {
  const specs = [];
  const exitCombos = [
    { tp1TriggerR: 0.65, tp1QtyPct: 55, tp1LockOffsetR: 0.38, rewardRisk: 1.30, beTriggerR: 0.40, beOffsetPct: 0.32, stopAtr: 2.6, minStopPct: 1.25 },
    { tp1TriggerR: 0.70, tp1QtyPct: 55, tp1LockOffsetR: 0.40, rewardRisk: 1.30, beTriggerR: 0.40, beOffsetPct: 0.35, stopAtr: 2.8, minStopPct: 1.30 },
  ];

  const longCands = [
    {
      tag: 'Trap20_BullChop',
      longRegimeMode: 'BULL_CHOP',
      longSpec: { genKind: '1h_MultiTrap', family: 'HtfSmcMultiTrap', lookback: 20, p4Lookback: 10, includePdhl: true, htfMode: 'H4_20', trapMaxBars: 4, limitOffsetAtr: 0.25 },
    },
    {
      tag: 'Trap2050_BullOnly',
      longRegimeMode: 'BULL_ONLY',
      longSpec: { genKind: '1h_MultiTrap', family: 'HtfSmcMultiTrap', lookback: 20, p4Lookback: 10, includePdhl: true, htfMode: 'H4_20_or_50', trapMaxBars: 4, limitOffsetAtr: 0.25 },
    },
    {
      tag: 'PbThrust_BullOnly',
      longRegimeMode: 'BULL_ONLY',
      longSpec: { genKind: 'sol_v6', mode: 'TrendPbThrust', limitOffsetAtr: 0.35, thrustMin: 0.55, pbTouchAtr: 0.35, pbBodyAtr: 0.35 },
    },
  ];

  for (const lc of longCands) {
    for (const shortHtf of ['H4_20', 'H4_20_or_50']) {
      for (const shortMinSellRatio of [null, 0.48]) {
        for (const ex of exitCombos) {
          const specId = `SOL_1h_V8_${lc.tag}_S${shortHtf}_sell${shortMinSellRatio ?? 'all'}_tp${ex.tp1TriggerR}`;
          const execOptions = {
            entryMode: 'LIMIT_PULLBACK',
            limitExpiryBars: 6,
            pendingPolicy: 'ignore',
            limitSameBarTp: 'close',
            cooldown: 4,
            warmup: 250,
            stopAtr: ex.stopAtr,
            minStopPct: ex.minStopPct,
            rewardRisk: ex.rewardRisk,
            maxHoldBars: 96,
            beTriggerR: ex.beTriggerR,
            beOffsetPct: ex.beOffsetPct,
            tp1TriggerR: ex.tp1TriggerR,
            tp1QtyPct: ex.tp1QtyPct,
            tp1FeeMode: 'MAKER',
            tp1LockOffsetR: ex.tp1LockOffsetR,
            costPct: 0.10,
            slippagePct: 0.025,
            volNormRiskPct: 3.2,
            minLev: 1.0,
            maxLev: 2.5,
          };
          specs.push({
            id: specId,
            sigSpec: {
              specId,
              longSpec: lc.longSpec,
              shortSpec: {
                genKind: '1h_MultiTrap',
                family: 'HtfSmcMultiTrap',
                lookback: 20,
                p4Lookback: 10,
                includePdhl: true,
                htfMode: shortHtf,
                trapMaxBars: 4,
                limitOffsetAtr: 0.25,
              },
              longRegimeMode: lc.longRegimeMode,
              shortRegimeMode: 'BEAR_ONLY',
              shortMinSellRatio,
              shortRequireExh: false,
            },
            execOptions,
          });
        }
      }
    }
  }
  return specs;
}

function buildEth1hCatalogV8() {
  const specs = [];
  const exitCombos = [
    { tp1TriggerR: 0.65, tp1QtyPct: 60, tp1LockOffsetR: 0.38, rewardRisk: 1.30, beTriggerR: 0.40, beOffsetPct: 0.32, stopAtr: 2.8, minStopPct: 1.30 },
    { tp1TriggerR: 0.72, tp1QtyPct: 60, tp1LockOffsetR: 0.42, rewardRisk: 1.35, beTriggerR: 0.42, beOffsetPct: 0.35, stopAtr: 3.2, minStopPct: 1.40 },
  ];

  for (const longHtf of ['H4_20', 'H4_20_or_50']) {
    for (const shortHtf of ['H4_20', 'H4_20_or_50']) {
      for (const longRegimeMode of ['BULL_ONLY', 'BULL_CHOP']) {
        for (const shortMinSellRatio of [null, 0.48, 0.50]) {
          for (const ex of exitCombos) {
            const specId = `ETH_1h_V8_L${longHtf}_${longRegimeMode}_S${shortHtf}_sell${shortMinSellRatio ?? 'all'}_tp${ex.tp1TriggerR}`;
            const mk = (htfMode) => ({
              specId: `${specId}_${htfMode}`,
              family: 'HtfSmcMultiTrap',
              lookback: 20,
              p4Lookback: 10,
              includePdhl: true,
              htfMode,
              trapMaxBars: 4,
              limitOffsetAtr: 0.24,
            });
            const execOptions = {
              entryMode: 'LIMIT_PULLBACK',
              limitExpiryBars: 6,
              pendingPolicy: 'ignore',
              limitSameBarTp: 'close',
              cooldown: 4,
              warmup: 250,
              stopAtr: ex.stopAtr,
              minStopPct: ex.minStopPct,
              rewardRisk: ex.rewardRisk,
              maxHoldBars: 96,
              beTriggerR: ex.beTriggerR,
              beOffsetPct: ex.beOffsetPct,
              tp1TriggerR: ex.tp1TriggerR,
              tp1QtyPct: ex.tp1QtyPct,
              tp1FeeMode: 'MAKER',
              tp1LockOffsetR: ex.tp1LockOffsetR,
              costPct: 0.10,
              slippagePct: 0.025,
              volNormRiskPct: 3.5,
              minLev: 1.2,
              maxLev: 2.5,
            };
            specs.push({
              id: specId,
              sigSpec: {
                specId,
                longSpec: mk(longHtf),
                shortSpec: mk(shortHtf),
                longRegimeMode,
                shortRegimeMode: 'BEAR_ONLY',
                shortMinSellRatio,
                shortRequireExh: false,
              },
              execOptions,
            });
          }
        }
      }
    }
  }
  return specs;
}

function getCatalogV8(streamKey) {
  if (streamKey === 'SOL_15m') return build15mCatalogV8('SOLUSDT');
  if (streamKey === 'ETH_15m') return build15mCatalogV8('ETHUSDT');
  if (streamKey === 'SOL_1h') return buildSol1hCatalogV8();
  if (streamKey === 'ETH_1h') return buildEth1hCatalogV8();
  throw new Error(`Unknown v8 streamKey: ${streamKey}`);
}

export function calibrateEthSolV8CalVal(streamKey, dsCV, regimeCV, btcCV = null) {
  const is15m = streamKey.endsWith('_15m');
  const n = dsCV.rows.length;
  const calEnd = Math.floor((0.50 / 0.80) * n);
  const catalog = getCatalogV8(streamKey);

  let pre = null;
  if (is15m) {
    pre = { pre15: precompute15mV7(dsCV) };
  } else if (streamKey === 'SOL_1h') {
    const f1 = computeOhlcFeatures1h(dsCV.rows);
    pre = {
      ohlc: f1,
      sol: { f1, f4: computeOhlcFeatures1h(dsCV.htf['4h'].rows) },
    };
  } else {
    pre = { ohlc: computeOhlcFeatures1h(dsCV.rows) };
  }

  let best = null;
  for (const cand of catalog) {
    const signals = generateEthSolStreamSignalsV8(streamKey, dsCV, cand.sigSpec, regimeCV, btcCV, pre);
    const simCV = simulateTradesV7(dsCV.rows, signals, {
      ...cand.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      mmr: 0.005,
      start: 0,
      end: n,
      intervalSeconds: dsCV.intervalSeconds,
    });
    const mCV = stripMonthly(summarizeSliceV8(simCV.trades, dsCV.rows, 0, n));
    const mCal = stripMonthly(summarizeSliceV8(simCV.trades, dsCV.rows, 0, calEnd));
    const mVal = stripMonthly(summarizeSliceV8(simCV.trades, dsCV.rows, calEnd, n));
    const calL = simCV.trades.filter(t => t.exitIndex < calEnd && t.side === 1);
    const calS = simCV.trades.filter(t => t.exitIndex < calEnd && t.side === -1);
    const valL = simCV.trades.filter(t => (t.signalIndex ?? t.entryIndex) >= calEnd && t.side === 1);
    const valS = simCV.trades.filter(t => (t.signalIndex ?? t.entryIndex) >= calEnd && t.side === -1);

    const eligible = (mCV.count ?? 0) >= 165
      && (mVal.count ?? 0) >= 65
      && calL.length >= 30 && calS.length >= 30
      && valL.length >= 22 && valS.length >= 22
      && (mCal.winRatePct ?? 0) >= 71.0
      && (mVal.winRatePct ?? 0) >= 70.0
      && (mCal.profitFactor ?? 0) >= 1.25
      && (mVal.profitFactor ?? 0) >= 1.18
      && (mCal.compoundedNetPct ?? -100) > 0
      && (mVal.compoundedNetPct ?? -100) > 0
      && (mCV.liquidationCount ?? 0) === 0;

    const dirPfBalance = (() => {
      const pf = arr => {
        const gp = arr.filter(x => x.netPct > 0).reduce((a, x) => a + x.netPct, 0);
        const gl = Math.abs(arr.filter(x => x.netPct <= 0).reduce((a, x) => a + x.netPct, 0));
        return gl > 0 ? gp / gl : (gp > 0 ? 3.0 : 0.5);
      };
      return Math.min(pf(valL), pf(valS), 2.5);
    })();

    const score = (eligible ? 10000 : 0)
      + dirPfBalance * 90
      + (mCV.meanMonthlySweepPct ?? 0) * 35
      + (mVal.profitFactor ?? 0) * 60
      + (mCal.profitFactor ?? 0) * 35
      + (mVal.winRatePct ?? 0) * 3.0
      - (mCV.maxCompoundedDdPct ?? 0) * 1.5;

    if (!best || score > best.score) {
      best = { score, eligible, cand };
    }
  }
  return best.cand;
}

export function getFeatureNamesForStreamV8(streamKey) {
  const base = streamKey.startsWith('ETH') ? ETH_FEATURE_NAMES_V6 : SOL_FEATURE_NAMES_V6;
  return [...base, ...V8_REGIME_FEATURE_NAMES];
}

function buildFeatureContextV8(streamKey, ds, alignedFunding, regimeCtx, btcDs = null) {
  if (streamKey.startsWith('ETH')) {
    return {
      isEth: true,
      ethCtx: precomputeEthCrossContextV6(ds, btcDs, alignedFunding),
      regimeCtx,
    };
  }
  return {
    isEth: false,
    ofCtx: precomputeOrderflowContextV6(ds, alignedFunding),
    regimeCtx,
  };
}

export function extractFeatureMapV8(streamKey, ds, signal, barIdx, alignedFunding, ctx, btcDs = null) {
  const base = ctx.isEth
    ? extractEthCandidateFeaturesV6(ds, btcDs, signal, barIdx, alignedFunding, ctx.ethCtx)
    : extractCandidateFeaturesV6(ds, signal, barIdx, alignedFunding, ctx.ofCtx);
  const rc = ctx.regimeCtx;
  const regName = rc.regime[barIdx];
  return {
    ...base,
    reg_trend_score: rc.trendScore[barIdx],
    reg_d1_ema50_dist_atr: rc.d1Ema50DistAtr[barIdx],
    reg_d1_ema200_dist_atr: rc.d1Ema200DistAtr[barIdx],
    reg_d1_slope_atr: rc.d1SlopeAtr[barIdx],
    reg_breadth_bear: rc.breadthBearRatio[barIdx],
    reg_h4_rally_exh: rc.h4RallyExh[barIdx],
    reg_is_bull: regName === CRYPTO_REGIMES_V8.BULL_TREND ? 1 : 0,
    reg_is_bear: regName === CRYPTO_REGIMES_V8.BEAR_TREND ? 1 : 0,
    reg_is_chop: regName === CRYPTO_REGIMES_V8.RANGE_CHOP ? 1 : 0,
  };
}

export function applyV8EthSolModelToSignals(streamKey, ds, signals, alignedFunding, modelSpec, regimeCtx, btcDs = null) {
  const ctx = buildFeatureContextV8(streamKey, ds, alignedFunding, regimeCtx, btcDs);
  const filtered = [];
  for (const s of signals) {
    const dirModel = s.side === 1 ? modelSpec.longModel : modelSpec.shortModel;
    const f = extractFeatureMapV8(streamKey, ds, s, s.barIndex, alignedFunding, ctx, btcDs);
    const sc = scoreCandidateV5(f, dirModel);
    if (sc.pass) {
      filtered.push({
        ...s,
        sizeMult: sc.sizeMult,
        meta: {
          ...(s.meta ?? {}),
          probWin: sc.probWin,
          sizeMult: sc.sizeMult,
          dirModel: s.side === 1 ? 'longModel' : 'shortModel',
        },
      });
    }
  }
  return filtered;
}

function loadBtcForEthStream(streamKey) {
  return streamKey === 'ETH_15m'
    ? loadStreamDatasetV8('BTC_15m')
    : (streamKey === 'ETH_1h' ? loadStreamDatasetV8('BTC_1h') : null);
}

function extractCalValPayloadV8() {
  const btc15Full = loadStreamDatasetV8('BTC_15m');
  const btc1hFull = loadStreamDatasetV8('BTC_1h');
  const out = {};

  for (const streamKey of V8_ETH_SOL_STREAM_KEYS) {
    const full = loadStreamDatasetV8(streamKey);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV7(full, valEnd);
    const valMaxTime = dsCV.rows[dsCV.rows.length - 1].time;
    const breadthCV = precomputeCryptoBreadthV8(loadBreadthDatasets1h(valMaxTime));
    const regimeCV = precomputeAssetRegimeV8(dsCV, breadthCV);
    const btcCV = streamKey === 'ETH_15m'
      ? sliceDatasetPrefixV7(btc15Full, valEnd)
      : (streamKey === 'ETH_1h' ? sliceDatasetPrefix1h(btc1hFull, valEnd) : null);

    const alignedFundingCV = alignFundingToBarsCausal(dsCV.rows, dsCV.fundingRows ?? []);
    const structural = calibrateEthSolV8CalVal(streamKey, dsCV, regimeCV, btcCV);
    const signals = generateEthSolStreamSignalsV8(streamKey, dsCV, structural.sigSpec, regimeCV, btcCV);

    const featNames = getFeatureNamesForStreamV8(streamKey);
    const ctx = buildFeatureContextV8(streamKey, dsCV, alignedFundingCV, regimeCV, btcCV);
    const sigFeatures = signals.map(s => {
      const fmap = extractFeatureMapV8(streamKey, dsCV, s, s.barIndex, alignedFundingCV, ctx, btcCV);
      return {
        barIndex: s.barIndex,
        side: s.side,
        atr: s.atr,
        limitPrice: s.limitPrice ?? null,
        regime: regimeCV.regime[s.barIndex],
        vec: featNames.map(k => (Number.isFinite(fmap[k]) ? fmap[k] : null)),
      };
    });

    const baseOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      mmr: 0.005,
      intervalSeconds: dsCV.intervalSeconds,
    };
    const simCal = simulateTradesV7(dsCV.rows, signals, { ...baseOpts, start: 0, end: calEnd });
    const simVal = simulateTradesV7(dsCV.rows, signals, { ...baseOpts, start: calEnd, end: valEnd });
    const sigIdxByBarSide = new Map(signals.map((s, idx) => [`${s.barIndex}:${s.side}`, idx]));

    const calSequential = simCal.trades
      .filter(t => t.signalIndex >= 0 && t.exitIndex < calEnd)
      .map(t => ({
        idx: sigIdxByBarSide.get(`${t.signalIndex}:${t.side}`),
        barIndex: t.signalIndex,
        side: t.side,
        y: t.netPct > 0 ? 1 : 0,
        netPct: t.netPct,
      }));
    const valSequential = simVal.trades
      .filter(t => t.signalIndex >= calEnd && t.exitIndex < valEnd)
      .map(t => ({
        idx: sigIdxByBarSide.get(`${t.signalIndex}:${t.side}`),
        barIndex: t.signalIndex,
        side: t.side,
        y: t.netPct > 0 ? 1 : 0,
        netPct: t.netPct,
      }));

    out[streamKey] = {
      streamKey,
      totalBarsFull: n,
      calEnd,
      valEnd,
      intervalSeconds: full.intervalSeconds,
      featureNames: featNames,
      structuralSpec: structural,
      signals: sigFeatures,
      calSequential,
      valSequential,
      baseCal: stripMonthly(summarizeSliceV8(simCal.trades, dsCV.rows, 0, calEnd)),
      baseVal: stripMonthly(summarizeSliceV8(simVal.trades, dsCV.rows, calEnd, valEnd)),
      baseCalLong: stripMonthly(summarizeSliceV8(simCal.trades, dsCV.rows, 0, calEnd, 1)),
      baseCalShort: stripMonthly(summarizeSliceV8(simCal.trades, dsCV.rows, 0, calEnd, -1)),
      baseValLong: stripMonthly(summarizeSliceV8(simVal.trades, dsCV.rows, calEnd, valEnd, 1)),
      baseValShort: stripMonthly(summarizeSliceV8(simVal.trades, dsCV.rows, calEnd, valEnd, -1)),
    };
  }
  return out;
}

function evalValDirectionalBatchV8(req) {
  const btc15Full = loadStreamDatasetV8('BTC_15m');
  const btc1hFull = loadStreamDatasetV8('BTC_1h');
  const out = {};

  for (const streamKey of V8_ETH_SOL_STREAM_KEYS) {
    const full = loadStreamDatasetV8(streamKey);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV7(full, valEnd);
    const valMaxTime = dsCV.rows[dsCV.rows.length - 1].time;
    const breadthCV = precomputeCryptoBreadthV8(loadBreadthDatasets1h(valMaxTime));
    const regimeCV = precomputeAssetRegimeV8(dsCV, breadthCV);
    const btcCV = streamKey === 'ETH_15m'
      ? sliceDatasetPrefixV7(btc15Full, valEnd)
      : (streamKey === 'ETH_1h' ? sliceDatasetPrefix1h(btc1hFull, valEnd) : null);

    const payload = req[streamKey];
    const structural = payload.structuralSpec;
    const baseSignals = generateEthSolStreamSignalsV8(streamKey, dsCV, structural.sigSpec, regimeCV, btcCV);
    const execOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      mmr: 0.005,
      intervalSeconds: dsCV.intervalSeconds,
    };

    const rowsCal = dsCV.rows.slice(0, calEnd);
    const rowsVal = dsCV.rows.slice(calEnd, valEnd);
    const cache = new Map();
    const results = [];

    for (const cand of payload.items) {
      const targetSide = cand.side; // 1 for long-only eval, -1 for short-only eval, 0 for combined
      const filteredCal = [];
      const filteredVal = [];
      const keyCalParts = [];
      const keyValParts = [];
      const isFlat = !cand.sizeCurve || cand.sizeCurve.mode === 'flat';

      for (let k = 0; k < baseSignals.length; k++) {
        const s = baseSignals[k];
        if (s.barIndex >= valEnd) continue;
        if (targetSide !== 0 && s.side !== targetSide) continue;
        const p = targetSide === 0
          ? (s.side === 1 ? cand.probsLong[k] : cand.probsShort[k])
          : cand.probs[k];
        const tau = targetSide === 0
          ? (s.side === 1 ? cand.thresholdLong : cand.thresholdShort)
          : cand.threshold;
        const sc = targetSide === 0
          ? (s.side === 1 ? cand.sizeCurveLong : cand.sizeCurveShort)
          : cand.sizeCurve;

        if (p >= tau) {
          let sizeMult = 1.0;
          if (sc && sc.mode === 'linear') {
            const pMax = sc.pMax;
            const u = Math.max(0, Math.min(1, (p - tau) / Math.max(1e-6, pMax - tau)));
            sizeMult = sc.minMult + u * (sc.maxMult - sc.minMult);
          }
          if (s.barIndex < calEnd) {
            filteredCal.push({ ...s, sizeMult });
            if (isFlat) keyCalParts.push(k);
          } else {
            filteredVal.push({ ...s, barIndex: s.barIndex - calEnd, sizeMult });
            if (isFlat) keyValParts.push(k);
          }
        }
      }

      const evalSlice = (rowsSlice, sigSlice, warmupBars, prefix, keyParts) => {
        const cKey = isFlat && targetSide !== 0 ? `${targetSide}:${prefix}:${keyParts.join(',')}` : null;
        if (cKey && cache.has(cKey)) return cache.get(cKey);
        const sim = simulateTradesV7(rowsSlice, sigSlice, {
          ...execOpts,
          start: 0,
          end: rowsSlice.length,
          warmup: warmupBars,
        });
        const metrics = stripMonthly(summarizeMonthlyCashflowV7(sim.trades, {
          startTime: rowsSlice[0].time,
          endTime: rowsSlice[rowsSlice.length - 1].time,
          rows: rowsSlice,
        }));
        if (cKey) cache.set(cKey, metrics);
        return metrics;
      };

      const calMetrics = evalSlice(rowsCal, filteredCal, structural.execOptions.warmup ?? 250, 'cal', keyCalParts);
      const valMetrics = evalSlice(rowsVal, filteredVal, 0, 'val', keyValParts);
      results.push({ id: cand.id, cal: calMetrics, val: valMetrics });
    }
    out[streamKey] = results;
  }
  return out;
}

function passesY5Gate(y5Stats) {
  return (y5Stats.count ?? 0) >= 25
    && (y5Stats.winRatePct ?? 0) >= 72.0
    && (y5Stats.profitFactor ?? 0) >= 1.15
    && (y5Stats.compoundedNetPct ?? -100) > 0
    && (y5Stats.totalNetPct ?? -100) > 0
    && (y5Stats.liquidationCount ?? 0) === 0;
}

export function evaluateEthSolStreamV8(streamKey, modelSpec, execProfile = 'EXCHANGE_POST_ONLY', sharedBreadth = null) {
  const ds = loadStreamDatasetV8(streamKey);
  const btcDs = loadBtcForEthStream(streamKey);
  const breadth = sharedBreadth ?? precomputeCryptoBreadthV8(loadBreadthDatasets1h());
  const regimeCtx = precomputeAssetRegimeV8(ds, breadth);

  const n = ds.rows.length;
  const calEnd = Math.floor(0.50 * n);
  const valEnd = Math.floor(0.80 * n);
  const alignedFunding = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
  const structural = modelSpec.structuralSpec;

  const rawSignals = generateEthSolStreamSignalsV8(streamKey, ds, structural.sigSpec, regimeCtx, btcDs);
  const mlSignals = applyV8EthSolModelToSignals(streamKey, ds, rawSignals, alignedFunding, modelSpec, regimeCtx, btcDs);

  const opts = {
    ...structural.execOptions,
    execProfile,
    fundingRows: ds.fundingRows,
    fundingPctPer8h: 0.01,
    isolatedLiqCheck: true,
    mmr: 0.005,
    intervalSeconds: ds.intervalSeconds,
    start: 0,
    end: n,
  };

  const simBase = simulateTradesV7(ds.rows, rawSignals, opts);
  const simMl = simulateTradesV7(ds.rows, mlSignals, opts);

  const mlCal = stripMonthly(summarizeSliceV8(simMl.trades, ds.rows, 0, calEnd));
  const mlVal = stripMonthly(summarizeSliceV8(simMl.trades, ds.rows, calEnd, valEnd));
  const mlCalVal = stripMonthly(summarizeSliceV8(simMl.trades, ds.rows, 0, valEnd));
  const mlY5 = stripMonthly(summarizeSliceV8(simMl.trades, ds.rows, valEnd, n));
  const mlFull = stripMonthly(summarizeSliceV8(simMl.trades, ds.rows, 0, n));

  const baseCalVal = stripMonthly(summarizeSliceV8(simBase.trades, ds.rows, 0, valEnd));
  const baseY5 = stripMonthly(summarizeSliceV8(simBase.trades, ds.rows, valEnd, n));
  const baseFull = stripMonthly(summarizeSliceV8(simBase.trades, ds.rows, 0, n));

  const baseDir = summarizeDirectionalV8(simBase.trades, ds.rows, calEnd, valEnd, n);
  const mlDir = summarizeDirectionalV8(simMl.trades, ds.rows, calEnd, valEnd, n);

  const otherProfile = execProfile === 'EXCHANGE_POST_ONLY' ? 'STRICT_TAKER' : 'EXCHANGE_POST_ONLY';
  const simOtherY5 = simulateTradesV7(ds.rows, mlSignals, {
    ...opts,
    execProfile: otherProfile,
    start: valEnd,
    end: n,
    warmup: 0,
  });
  const mlOtherY5 = stripMonthly(summarizeSliceV8(simOtherY5.trades, ds.rows, valEnd, n));
  const qualifiedForLive = passesY5Gate(mlY5) && passesY5Gate(mlOtherY5);

  return {
    id: streamKey,
    coin: streamKey.startsWith('SOL') ? 'SOLUSDT' : 'ETHUSDT',
    timeframe: streamKey.endsWith('_15m') ? '15m' : '1h',
    execProfile,
    bars: n,
    splits: { cal: [0, calEnd], val: [calEnd, valEnd], holdoutY5: [valEnd, n] },
    rows: ds.rows,
    regimeContext: regimeCtx,
    trades: simMl.trades,
    baselineTrades: simBase.trades,
    qualifiedForLive,
    summary: {
      baseline: { calVal: baseCalVal, holdoutY5: baseY5, full5y: baseFull, ...baseDir },
      ml: { cal: mlCal, val: mlVal, calVal: mlCalVal, holdoutY5: mlY5, full5y: mlFull, ...mlDir },
    },
  };
}

export function getV8EthSolStreams(execProfile = 'EXCHANGE_POST_ONLY') {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V8_DIR, 'models_v8_eth_sol.json'), 'utf8'));
  const sharedBreadth = precomputeCryptoBreadthV8(loadBreadthDatasets1h());
  const streams = {};
  for (const streamKey of V8_ETH_SOL_STREAM_KEYS) {
    streams[streamKey] = evaluateEthSolStreamV8(streamKey, modelsJson.models[streamKey], execProfile, sharedBreadth);
  }
  return streams;
}

export async function runRegimeV8EthSol() {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V8_DIR, 'models_v8_eth_sol.json'), 'utf8'));
  const sharedBreadth = precomputeCryptoBreadthV8(loadBreadthDatasets1h());
  const out = {};
  for (const streamKey of V8_ETH_SOL_STREAM_KEYS) {
    out[streamKey] = {};
    for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
      const res = evaluateEthSolStreamV8(streamKey, modelsJson.models[streamKey], prof, sharedBreadth);
      const { rows, trades, baselineTrades, regimeContext, ...clean } = res;
      out[streamKey][prof] = clean;
      const m = clean.summary.ml;
      const b = clean.summary.baseline;
      const ls = m.longSummary;
      const ss = m.shortSummary;
      console.log(`\n[${streamKey} ${prof}] qualifiedForLive=${clean.qualifiedForLive}`);
      console.log(`  Base | CV: n=${b.calVal.count} WR=${b.calVal.winRatePct}% PF=${b.calVal.profitFactor} | Y5: n=${b.holdoutY5.count} WR=${b.holdoutY5.winRatePct}% PF=${b.holdoutY5.profitFactor} Comp=${b.holdoutY5.compoundedNetPct}% | 5Y: n=${b.full5y.count} WR=${b.full5y.winRatePct}% PF=${b.full5y.profitFactor} Comp=${b.full5y.compoundedNetPct}% DD=${b.full5y.maxCompoundedDdPct}%`);
      console.log(`  ML   | Cal: n=${m.cal.count} WR=${m.cal.winRatePct}% PF=${m.cal.profitFactor} | Val: n=${m.val.count} WR=${m.val.winRatePct}% PF=${m.val.profitFactor} | Y5: n=${m.holdoutY5.count} WR=${m.holdoutY5.winRatePct}% PF=${m.holdoutY5.profitFactor} Comp=${m.holdoutY5.compoundedNetPct}% Mo=${m.holdoutY5.meanMonthlySweepPct}% | 5Y: n=${m.full5y.count} WR=${m.full5y.winRatePct}% PF=${m.full5y.profitFactor} Comp=${m.full5y.compoundedNetPct}% Mo=${m.full5y.meanMonthlySweepPct}% DD=${m.full5y.maxCompoundedDdPct}% Liq=${m.full5y.liquidationCount}`);
      console.log(`  Dir  | LONG Y5(n=${ls.holdoutY5.count} WR=${ls.holdoutY5.winRatePct}% PF=${ls.holdoutY5.profitFactor} Comp=${ls.holdoutY5.compoundedNetPct}%) 5Y(n=${ls.full5y.count} WR=${ls.full5y.winRatePct}% PF=${ls.full5y.profitFactor}) | SHORT Y5(n=${ss.holdoutY5.count} WR=${ss.holdoutY5.winRatePct}% PF=${ss.holdoutY5.profitFactor} Comp=${ss.holdoutY5.compoundedNetPct}%) 5Y(n=${ss.full5y.count} WR=${ss.full5y.winRatePct}% PF=${ss.full5y.profitFactor})`);
    }
  }

  fs.mkdirSync(RESULTS_V8_DIR, { recursive: true });
  const summary = {
    schema: 'smc-v8-eth-sol-5y-summary-v1',
    generatedAt: new Date().toISOString(),
    promotionGate: 'Y5 WR >= 72% && PF >= 1.15 && CompNet > 0% && TotalNet > 0% && Liq == 0 && count >= 25 under BOTH EXCHANGE_POST_ONLY and STRICT_TAKER',
    modelMetadata: Object.fromEntries(V8_ETH_SOL_STREAM_KEYS.map(k => [k, modelsJson.models[k].selectionMeta])),
    streams: out,
  };
  const outPath = path.join(RESULTS_V8_DIR, 'eth_sol_v8_5y.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n[regime_v8_eth_sol] Wrote ${path.relative(ROOT_DIR, outPath)}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--extract-cal-val')) {
    process.stdout.write(JSON.stringify(extractCalValPayloadV8()));
  } else if (process.argv.includes('--eval-val-dir')) {
    const req = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(evalValDirectionalBatchV8(req)));
  } else {
    runRegimeV8EthSol().catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}
