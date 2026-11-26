import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTradesV7, summarizeMonthlyCashflowV7 } from './sim_engine_v7.mjs';
import { alignFundingToBarsCausal } from './fetch_okx_derivs.mjs';
import { computeOhlcFeatures1h, generateSignals1h, sliceDatasetPrefix1h } from './signals_1h.mjs';
import { precompute15mV4, generateSignals15mV4, sliceDatasetPrefix15m } from './signals_15m_v4.mjs';
import {
  FEATURE_NAMES_V6,
  precomputeOrderflowContextV6,
  extractCandidateFeaturesV6,
  generateBtcSignalsV6,
  generateBnbSignalsV6,
} from './suite_v6_btc_bnb.mjs';
import { precompute15mV7, generate15mSignalsV7 } from './high_wr_v7_btc_bnb.mjs';
import {
  CRYPTO_REGIMES_V8,
  precomputeCryptoBreadthV8,
  precomputeAssetRegimeV8,
} from './regime_engine_v8.mjs';
import { scoreCandidateV5 } from './ml_inference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V8_DIR = path.join(HERE, 'results_v8');

export const V8_STREAM_KEYS = Object.freeze(['BTC_1h', 'BTC_15m', 'BNB_1h', 'BNB_15m']);

export const FEATURE_NAMES_V8 = Object.freeze([
  ...FEATURE_NAMES_V6,
  'regime_trend_score',
  'd1_ema50_dist_atr',
  'd1_slope_atr',
  'breadth_bear_ratio',
  'h4_rally_exh',
]);

const DATASET_FILE_MAP = Object.freeze({
  BTC_1h: 'crypto5y_btcusdt_1h.json',
  BTC_15m: 'crypto5y_btcusdt_15m.json',
  BNB_1h: 'crypto5y_bnbusdt_1h.json',
  BNB_15m: 'crypto5y_bnbusdt_15m.json',
});

const BREADTH_1H_FILES = Object.freeze({
  BTCUSDT: 'crypto5y_btcusdt_1h.json',
  ETHUSDT: 'crypto5y_ethusdt_1h.json',
  SOLUSDT: 'crypto5y_solusdt_1h.json',
  BNBUSDT: 'crypto5y_bnbusdt_1h.json',
});

const rawDatasetCache = new Map();

function loadRawJsonCached(fileName) {
  let ds = rawDatasetCache.get(fileName);
  if (!ds) {
    ds = JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8'));
    rawDatasetCache.set(fileName, ds);
  }
  return ds;
}

export function loadStreamDatasetV8(streamKey) {
  return loadRawJsonCached(DATASET_FILE_MAP[streamKey]);
}

export function sliceDatasetPrefixV8(dataset, endLength) {
  const sliced = dataset.intervalSeconds <= 900
    ? sliceDatasetPrefix15m(dataset, endLength)
    : sliceDatasetPrefix1h(dataset, endLength);
  if (Array.isArray(dataset.fundingRows)) {
    const lastTime = sliced.lastTime;
    sliced.fundingRows = dataset.fundingRows.filter(f => f.time <= lastTime);
  }
  return sliced;
}

/**
 * Strictly causal 4-coin daily breadth up to maxTimeSec (if provided) so no future coin data leaks into prefix slices.
 */
export function buildCausalBreadthV8(maxTimeSec = null) {
  const byCoin = {};
  for (const [coin, fileName] of Object.entries(BREADTH_1H_FILES)) {
    const ds = loadRawJsonCached(fileName);
    if (maxTimeSec === null) {
      byCoin[coin] = ds;
    } else {
      let cutLen = 0;
      const rows = ds.rows;
      while (cutLen < rows.length && rows[cutLen].time <= maxTimeSec) cutLen++;
      cutLen = Math.max(1, cutLen);
      byCoin[coin] = sliceDatasetPrefixV8(ds, cutLen);
    }
  }
  return precomputeCryptoBreadthV8(byCoin);
}

function summarizeDirectionalTrades(trades) {
  const count = trades.length;
  const wins = trades.filter(t => t.netPct > 0).length;
  const gp = trades.filter(t => t.netPct > 0).reduce((a, b) => a + b.netPct, 0);
  const gl = Math.abs(trades.filter(t => t.netPct <= 0).reduce((a, b) => a + b.netPct, 0));
  const netSumPct = trades.reduce((a, b) => a + b.netPct, 0);
  return {
    count,
    wins,
    winRatePct: count > 0 ? (wins / count) * 100 : 0,
    profitFactor: gl > 1e-12 ? gp / gl : (gp > 0 ? 999 : 0),
    netSumPct,
  };
}

function summarizeSliceV8(trades, rows, lo, hi) {
  const filtered = trades.filter(t => {
    const idxStart = t.signalIndex ?? t.entryIndex;
    return idxStart >= lo && t.exitIndex < hi;
  });
  const m = summarizeMonthlyCashflowV7(filtered, {
    startTime: rows[lo].time,
    endTime: rows[hi - 1].time,
    rows,
  });
  return {
    ...m,
    long: summarizeDirectionalTrades(filtered.filter(t => t.side === 1)),
    short: summarizeDirectionalTrades(filtered.filter(t => t.side === -1)),
  };
}

function stripMonthly(m) {
  const { monthlyTable, ...rest } = m;
  return rest;
}

function dedupeAndSortByBar(signals) {
  const byBar = new Map();
  for (const s of signals) {
    if (!byBar.has(s.barIndex)) byBar.set(s.barIndex, s);
  }
  return Array.from(byBar.values()).sort((a, b) => a.barIndex - b.barIndex);
}

/**
 * Generate asymmetric LONG vs BEAR_SHORT structural candidate signals gated by regime_engine_v8.
 */
export function generateAsymmetricSignalsV8(streamKey, dataset, spec, alignedFunding, regimeCtx, precomputed = null) {
  const is15m = streamKey.endsWith('_15m');

  let rawLong = [];
  let rawShort = [];

  if (!is15m) {
    const pre1h = precomputed ?? {
      f1: computeOhlcFeatures1h(dataset.rows),
      f4: computeOhlcFeatures1h(dataset.htf['4h'].rows),
      fD: dataset.htf['1d'] ? computeOhlcFeatures1h(dataset.htf['1d'].rows) : null,
      rawSignalsByKey: new Map(),
      virtTradesByKey: new Map(),
    };

    const genSide = (sCfg) => {
      if (sCfg.kind === 'BnbCompositeV6') return generateBnbSignalsV6(dataset, sCfg, alignedFunding);
      if (sCfg.kind === 'AdaptiveTrapPolarity') return generateBtcSignalsV6(dataset, { ...sCfg, family: 'AdaptiveTrapPolarity' }, pre1h);
      return generateSignals1h(dataset, sCfg, pre1h);
    };
    rawLong = genSide(spec.longCfg).filter(s => s.side === 1);
    rawShort = genSide(spec.shortCfg).filter(s => s.side === -1);
  } else {
    const pre15 = precomputed ?? precompute15mV7(dataset);
    const genSide15 = (sCfg) => {
      if (sCfg.kind === 'H1_CleanDisp_OF') return generate15mSignalsV7(dataset, { ...sCfg, family: 'H1_CleanDisp_OF' }, pre15);
      return generateSignals15mV4(dataset, sCfg, pre15);
    };
    rawLong = genSide15(spec.longCfg).filter(s => s.side === 1);
    rawShort = genSide15(spec.shortCfg).filter(s => s.side === -1);
  }

  const rangePolicy = spec.rangePolicy ?? 'long_only_065';
  const out = [];

  for (const s of rawLong) {
    const r = regimeCtx.regime[s.barIndex];
    if (r === CRYPTO_REGIMES_V8.BEAR_TREND || r === CRYPTO_REGIMES_V8.BEAR_SQUEEZE) continue;
    if (r === CRYPTO_REGIMES_V8.RANGE_CHOP) {
      if (rangePolicy === 'block') continue;
      out.push({ ...s, regime: r, baseSizeMult: 0.65 });
    } else {
      out.push({ ...s, regime: r, baseSizeMult: 1.0 });
    }
  }

  for (const s of rawShort) {
    const r = regimeCtx.regime[s.barIndex];
    // Never short in BULL_TREND or during violent BEAR_SQUEEZE short-covering rallies!
    if (r === CRYPTO_REGIMES_V8.BULL_TREND || r === CRYPTO_REGIMES_V8.BEAR_SQUEEZE) continue;
    if (r === CRYPTO_REGIMES_V8.RANGE_CHOP) {
      if (rangePolicy !== 'both_060') continue;
      out.push({ ...s, regime: r, baseSizeMult: 0.60 });
    } else {
      // Dedicated BEAR_TREND Short — optional filter requiring 4H rally exhaustion or below 4H EMA50
      if (spec.requireH4RallyExhOnShort && regimeCtx.h4RallyExh[s.barIndex] !== 1) continue;
      out.push({ ...s, regime: r, baseSizeMult: 1.0 });
    }
  }

  return dedupeAndSortByBar(out);
}

function build1hAsymmetricCatalogV8(coin) {
  const isBtc = coin === 'BTCUSDT';
  const specs = [];

  const exitCombos = isBtc
    ? [
        { tp1TriggerR: 0.58, tp1QtyPct: 50, tp1LockOffsetR: 0.28, rewardRisk: 1.25, beTriggerR: 0.36, beOffsetPct: 0.25 },
        { tp1TriggerR: 0.60, tp1QtyPct: 50, tp1LockOffsetR: 0.35, rewardRisk: 1.25, beTriggerR: 0.38, beOffsetPct: 0.25 },
        { tp1TriggerR: 0.65, tp1QtyPct: 45, tp1LockOffsetR: 0.24, rewardRisk: 1.38, beTriggerR: 0.36, beOffsetPct: 0.26 },
      ]
    : [
        { tp1TriggerR: 0.55, tp1QtyPct: 50, tp1LockOffsetR: 0.20, rewardRisk: 1.35, beTriggerR: 0.34, beOffsetPct: 0.25 },
        { tp1TriggerR: 0.58, tp1QtyPct: 50, tp1LockOffsetR: 0.22, rewardRisk: 1.40, beTriggerR: 0.35, beOffsetPct: 0.26 },
        { tp1TriggerR: 0.65, tp1QtyPct: 45, tp1LockOffsetR: 0.24, rewardRisk: 1.45, beTriggerR: 0.36, beOffsetPct: 0.28 },
      ];

  const rangePolicies = ['block', 'long_only_065'];
  const longModes = isBtc ? ['RawTrap50', 'AdpTrap50'] : ['RawTrap20', 'BnbComp50'];
  const shortModes = isBtc ? ['RawTrap50', 'AdpTrap20'] : ['BnbComp20', 'BnbComp50', 'RawTrap50'];

  for (const lm of longModes) {
    for (const sm of shortModes) {
      for (const rangePolicy of rangePolicies) {
        for (const [stopAtr, minStopPct] of (isBtc ? [[3.2, 1.4]] : [[3.2, 1.35], [3.5, 1.4]])) {
          for (const ex of exitCombos) {
            const virtExec = {
              entryMode: 'LIMIT_PULLBACK',
              limitExpiryBars: 6,
              pendingPolicy: 'ignore',
              limitSameBarTp: 'close',
              cooldown: 4,
              warmup: 250,
              stopAtr,
              minStopPct,
              rewardRisk: ex.rewardRisk,
              maxHoldBars: 96,
              beTriggerR: ex.beTriggerR,
              beOffsetPct: ex.beOffsetPct,
              costPct: 0.10,
              slippagePct: 0.025,
            };
            const make1hCfg = (mode, off) => {
              if (mode === 'RawTrap50') return { kind: 'HtfSmcMultiTrap', family: 'HtfSmcMultiTrap', lookback: 20, trapMaxBars: 4, p4Lookback: 10, includePdhl: true, htfMode: 'H4_50', limitOffsetAtr: off, warmup: 250 };
              if (mode === 'RawTrap20') return { kind: 'HtfSmcMultiTrap', family: 'HtfSmcMultiTrap', lookback: 20, trapMaxBars: 4, p4Lookback: 10, includePdhl: true, htfMode: 'H4_20', limitOffsetAtr: off, warmup: 250 };
              if (mode === 'AdpTrap50') return { kind: 'AdaptiveTrapPolarity', baseFamily: 'HtfSmcMultiTrap', lookback: 20, trapMaxBars: 4, p4Lookback: 10, includePdhl: true, htfMode: 'H4_50', limitOffsetAtr: off, winLen: 6, slThresh: 2, requireNegNet: true, sharedHistory: false, virtExec };
              if (mode === 'AdpTrap20') return { kind: 'AdaptiveTrapPolarity', baseFamily: 'HtfSmcMultiTrap', lookback: 20, trapMaxBars: 4, p4Lookback: 10, includePdhl: true, htfMode: 'H4_20', limitOffsetAtr: off, winLen: 6, slThresh: 2, requireNegNet: true, sharedHistory: false, virtExec };
              if (mode === 'BnbComp20') return { kind: 'BnbCompositeV6', htfMode: 'H4_20', limitOffsetAtr: off, includeMeanRevPb: true, useLaunchpoolSqueeze: true };
              return { kind: 'BnbCompositeV6', htfMode: 'H4_50', limitOffsetAtr: off, includeMeanRevPb: true, useLaunchpoolSqueeze: true };
            };
            const off = isBtc ? 0.18 : 0.22;
            const sigSpec = {
              specId: `${coin}_1h_V8_L_${lm}_S_${sm}_${rangePolicy}_s${stopAtr}_tp1_${ex.tp1TriggerR}_lk${ex.tp1LockOffsetR}`,
              longCfg: make1hCfg(lm, off),
              shortCfg: make1hCfg(sm, off),
              rangePolicy,
              requireH4RallyExhOnShort: false,
            };
            const execOptions = {
              ...virtExec,
              tp1TriggerR: ex.tp1TriggerR,
              tp1QtyPct: ex.tp1QtyPct,
              tp1FeeMode: 'MAKER',
              tp1LockOffsetR: ex.tp1LockOffsetR,
              volNormRiskPct: isBtc ? 4.0 : 3.5,
              minLev: 1.2,
              maxLev: isBtc ? 3.0 : 2.5,
            };
            specs.push({ id: sigSpec.specId, sigSpec, execOptions });
          }
        }
      }
    }
  }
  return specs;
}

function build15mAsymmetricCatalogV8(coin) {
  const isBtc = coin === 'BTCUSDT';
  const specs = [];

  const exitCombos = [
    { tp1TriggerR: 0.48, tp1QtyPct: 50, tp1LockOffsetR: 0.15, rewardRisk: 1.55, beTriggerR: 0.28, beOffsetPct: 0.22 },
    { tp1TriggerR: 0.54, tp1QtyPct: 50, tp1LockOffsetR: 0.18, rewardRisk: 1.75, beTriggerR: 0.34, beOffsetPct: 0.24 },
  ];

  const longModes = isBtc
    ? ['H4Disp_Adp_50', 'H1Pullback_20', 'H1SyncTrap_Raw_20']
    : ['H4Disp_Adp_50', 'MultiTrap_20', 'H1SyncTrap_Raw_20'];
  const shortModes = isBtc
    ? ['H4Disp_Adp_50', 'H1Pullback_50']
    : ['H1Pullback_50', 'H1CleanDisp_50'];

  for (const lm of longModes) {
    for (const sm of shortModes) {
      for (const rangePolicy of ['block', 'long_only_065']) {
        for (const [stopAtr, minStopPct] of [[4.5, 1.45], [5.0, 1.55]]) {
          for (const ex of exitCombos) {
            const virtExec = {
              entryMode: 'LIMIT_PULLBACK',
              limitExpiryBars: 10,
              pendingPolicy: 'ignore',
              limitSameBarTp: 'close',
              cooldown: 8,
              warmup: 250,
              stopAtr,
              minStopPct,
              rewardRisk: ex.rewardRisk,
              maxHoldBars: 180,
              beTriggerR: ex.beTriggerR,
              beOffsetPct: ex.beOffsetPct,
              costPct: 0.10,
              slippagePct: 0.025,
            };
            const make15Cfg = (mode) => {
              if (mode === 'H4Disp_Adp_50') return { rawFamily: 'M15_H4Disp', h4BodyAtrMin: 0.85, h4ClosePosMin: 0.58, onH4CloseOnly: true, requireLtfConfirm: false, htfMode: 'H4_50', minAtrPct: 0.14, pullAtr: 0.35, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true, virtExec };
              if (mode === 'H1Pullback_20') return { rawFamily: 'M15_H1Pullback_Trend', htfMode: 'H4_20', pbTouchAtr: 0.30, minAtrPct: 0.14, pullAtr: 0.30, adaptive: false };
              if (mode === 'H1Pullback_50') return { rawFamily: 'M15_H1Pullback_Trend', htfMode: 'H4_50', pbTouchAtr: 0.30, minAtrPct: 0.14, pullAtr: 0.35, adaptive: false };
              if (mode === 'H1SyncTrap_Raw_20') return { rawFamily: 'M15_H1SyncedMultiTrap', h1Lookback: 20, h4Lookback: 10, include24h: true, trapMaxBars: 4, htfMode: 'H4_20_or_50', minAtrPct: 0.14, pullAtr: 0.30, adaptive: false };
              if (mode === 'MultiTrap_20') return { rawFamily: 'M15_MultiTrap', ltfLookback: 20, h1Lookback: 20, trapMaxBars: 4, htfMode: 'H4_20', minAtrPct: 0.14, pullAtr: 0.35, adaptive: false };
              return { kind: 'H1_CleanDisp_OF', h1BodyAtrMin: 0.85, h1ClosePosMin: 0.60, minAtrPct: 0.14, h1RsiExh: 74, emaExhAtr: 2.0, tbrMin: 0.48, pullAtr: 0.35, htfMode: 'H4_50' };
            };
            const sigSpec = {
              specId: `${coin}_15m_V8_L_${lm}_S_${sm}_${rangePolicy}_s${stopAtr}_tp1_${ex.tp1TriggerR}`,
              longCfg: make15Cfg(lm),
              shortCfg: make15Cfg(sm),
              rangePolicy,
              requireH4RallyExhOnShort: false,
            };
            const execOptions = {
              ...virtExec,
              tp1TriggerR: ex.tp1TriggerR,
              tp1QtyPct: ex.tp1QtyPct,
              tp1FeeMode: 'MAKER',
              tp1LockOffsetR: ex.tp1LockOffsetR,
              volNormRiskPct: 3.0,
              minLev: 1.0,
              maxLev: 2.5,
            };
            specs.push({ id: sigSpec.specId, sigSpec, execOptions });
          }
        }
      }
    }
  }
  return specs;
}

export function extractCandidateFeaturesV8(dataset, signal, barIdx, alignedFunding, ofCtx, regimeCtx) {
  const f6 = extractCandidateFeaturesV6(dataset, signal, barIdx, alignedFunding, ofCtx);
  const r = regimeCtx.getRegimeAt(barIdx);
  return {
    ...f6,
    regime_trend_score: r.trendScore,
    d1_ema50_dist_atr: r.d1Ema50DistAtr,
    d1_slope_atr: r.d1SlopeAtr,
    breadth_bear_ratio: r.breadthBearRatio,
    h4_rally_exh: r.h4RallyExh,
  };
}

export function calibrateStructuralV8CalVal(streamKey, dsCV, alignedFundingCV, regimeCV) {
  const is15m = streamKey.endsWith('_15m');
  const coin = streamKey.startsWith('BTC') ? 'BTCUSDT' : 'BNBUSDT';
  const catalog = is15m ? build15mAsymmetricCatalogV8(coin) : build1hAsymmetricCatalogV8(coin);
  const n = dsCV.rows.length;
  const calEnd = Math.floor((0.50 / 0.80) * n);

  const pre = is15m
    ? precompute15mV7(dsCV)
    : {
        f1: computeOhlcFeatures1h(dsCV.rows),
        f4: computeOhlcFeatures1h(dsCV.htf['4h'].rows),
        fD: dsCV.htf['1d'] ? computeOhlcFeatures1h(dsCV.htf['1d'].rows) : null,
        rawSignalsByKey: new Map(),
        virtTradesByKey: new Map(),
      };

  let best = null;
  for (const cand of catalog) {
    const signals = generateAsymmetricSignalsV8(streamKey, dsCV, cand.sigSpec, alignedFundingCV, regimeCV, pre);
    const simCV = simulateTradesV7(dsCV.rows, signals, {
      ...cand.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      start: 0,
      end: n,
      intervalSeconds: dsCV.intervalSeconds,
    });
    const mCV = summarizeSliceV8(simCV.trades, dsCV.rows, 0, n);
    const mCal = summarizeSliceV8(simCV.trades, dsCV.rows, 0, calEnd);
    const mVal = summarizeSliceV8(simCV.trades, dsCV.rows, calEnd, n);

    const minCount = is15m ? 160 : 120;
    const minDirCount = is15m ? 45 : 35;
    const bothDirActive = mCV.long.count >= minDirCount && mCV.short.count >= minDirCount;
    const eligible = (simCV.count ?? 0) >= minCount
      && bothDirActive
      && (mCV.winRatePct ?? 0) >= 72.0
      && (mCV.profitFactor ?? 0) >= 1.15
      && (mCal.profitFactor ?? 0) >= 1.05
      && (mVal.profitFactor ?? 0) >= 1.05
      && (mCV.liquidationCount ?? 0) === 0;
    const bothDirPositive = mCV.long.profitFactor >= 1.10 && mCV.short.profitFactor >= 1.10;
    const strongWrPf = eligible && (mCV.winRatePct ?? 0) >= 75.0 && (mCV.profitFactor ?? 0) >= 1.25;

    const score = (eligible ? 10000 : 0)
      + (bothDirActive ? 2500 : 0)
      + (bothDirPositive ? 1500 : 0)
      + (strongWrPf ? 2000 : 0)
      + (mCV.meanMonthlySweepPct ?? 0) * 40
      + (mCV.profitFactor ?? 0) * 60
      + (mCV.winRatePct ?? 0) * 2.5
      - (mCV.maxCompoundedDdPct ?? 0) * 1.5;

    if (!best || score > best.score) {
      best = { score, eligible, cand };
    }
  }
  return best.cand;
}

export function applyV8DirectionalModels(ds, signals, alignedFunding, regimeCtx, streamModelSpec) {
  const ofCtx = precomputeOrderflowContextV6(ds, alignedFunding);
  const filtered = [];
  for (const s of signals) {
    const f = extractCandidateFeaturesV8(ds, s, s.barIndex, alignedFunding, ofCtx, regimeCtx);
    const dirModel = s.side === 1 ? streamModelSpec.longModel : streamModelSpec.shortModel;
    const sc = scoreCandidateV5(f, dirModel);
    if (!sc.pass) continue;

    const rMult = s.side === 1 ? regimeCtx.longSizeMult[s.barIndex] : regimeCtx.shortSizeMult[s.barIndex];
    if (!Number.isFinite(rMult) || rMult <= 0) continue;

    const baseMult = s.baseSizeMult ?? 1.0;
    const combinedMult = Math.max(0.45, Math.min(1.50, sc.sizeMult * baseMult * (rMult > 1.0 ? 1.08 : 1.0)));

    filtered.push({
      ...s,
      sizeMult: combinedMult,
      meta: { ...(s.meta ?? {}), probWin: sc.probWin, sizeMult: combinedMult, regime: regimeCtx.regime[s.barIndex] },
    });
  }
  return filtered;
}

function extractCalValPayloadV8() {
  const fullBtc1h = loadStreamDatasetV8('BTC_1h');
  const valEnd1h = Math.floor(0.80 * fullBtc1h.rows.length);
  const maxTimeSecCV = fullBtc1h.rows[valEnd1h - 1].time;
  const breadthCV = buildCausalBreadthV8(maxTimeSecCV);

  const out = {};
  for (const streamKey of V8_STREAM_KEYS) {
    const full = loadStreamDatasetV8(streamKey);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);

    const dsCV = sliceDatasetPrefixV8(full, valEnd);
    const alignedFundingCV = alignFundingToBarsCausal(dsCV.rows, dsCV.fundingRows ?? []);
    const regimeCV = precomputeAssetRegimeV8(dsCV, breadthCV);
    const structural = calibrateStructuralV8CalVal(streamKey, dsCV, alignedFundingCV, regimeCV);

    const baseSignals = generateAsymmetricSignalsV8(streamKey, dsCV, structural.sigSpec, alignedFundingCV, regimeCV);
    const execOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      intervalSeconds: dsCV.intervalSeconds,
    };

    const simCV = simulateTradesV7(dsCV.rows, baseSignals, { ...execOpts, start: 0, end: valEnd });
    const tradeByBar = new Map();
    for (const t of simCV.trades) tradeByBar.set(t.signalIndex, t);

    const ofCtxCV = precomputeOrderflowContextV6(dsCV, alignedFundingCV);
    const sigFeatures = [];
    const calLong = [];
    const calShort = [];
    const valLong = [];
    const valShort = [];

    for (let k = 0; k < baseSignals.length; k++) {
      const s = baseSignals[k];
      const fMap = extractCandidateFeaturesV8(dsCV, s, s.barIndex, alignedFundingCV, ofCtxCV, regimeCV);
      const vec = FEATURE_NAMES_V8.map(name => (Number.isFinite(fMap[name]) ? fMap[name] : null));
      sigFeatures.push({ barIndex: s.barIndex, side: s.side, features: vec });

      const t = tradeByBar.get(s.barIndex);
      if (!t) continue;

      const rowRec = {
        idx: k,
        barIndex: s.barIndex,
        side: s.side,
        y: t.netPct > 0 ? 1 : 0,
        netPct: t.netPct,
      };
      if (s.barIndex < calEnd && t.exitIndex < calEnd) {
        if (s.side === 1) calLong.push(rowRec);
        else calShort.push(rowRec);
      } else if (s.barIndex >= calEnd && s.barIndex < valEnd && t.exitIndex < valEnd) {
        if (s.side === 1) valLong.push(rowRec);
        else valShort.push(rowRec);
      }
    }

    const baseValAll = summarizeSliceV8(simCV.trades, dsCV.rows, calEnd, valEnd);
    out[streamKey] = {
      streamKey,
      totalBarsFull: n,
      calEnd,
      valEnd,
      intervalSeconds: full.intervalSeconds,
      featureNames: FEATURE_NAMES_V8,
      structuralSpec: structural,
      signals: sigFeatures,
      calLong,
      calShort,
      valLong,
      valShort,
      baseVal: stripMonthly(baseValAll),
    };
  }
  return out;
}

function evalValBatchV8(req) {
  const fullBtc1h = loadStreamDatasetV8('BTC_1h');
  const valEnd1h = Math.floor(0.80 * fullBtc1h.rows.length);
  const breadthCV = buildCausalBreadthV8(fullBtc1h.rows[valEnd1h - 1].time);

  const out = {};
  for (const streamKey of V8_STREAM_KEYS) {
    const full = loadStreamDatasetV8(streamKey);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV8(full, valEnd);
    const alignedFundingCV = alignFundingToBarsCausal(dsCV.rows, dsCV.fundingRows ?? []);
    const regimeCV = precomputeAssetRegimeV8(dsCV, breadthCV);

    const payload = req[streamKey];
    const structural = payload.structuralSpec;
    const baseSignals = generateAsymmetricSignalsV8(streamKey, dsCV, structural.sigSpec, alignedFundingCV, regimeCV);
    const execOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      intervalSeconds: dsCV.intervalSeconds,
    };

    const rowsVal = dsCV.rows.slice(calEnd, valEnd);
    const evalDirection = (items, targetSide) => {
      const cache = new Map();
      const results = [];
      for (const cand of items) {
        const filteredVal = [];
        const keyParts = [];
        const isFlat = !cand.sizeCurve || cand.sizeCurve.mode === 'flat';
        for (let k = 0; k < baseSignals.length; k++) {
          const s = baseSignals[k];
          if (s.side !== targetSide || s.barIndex < calEnd || s.barIndex >= valEnd) continue;
          const p = cand.probs[k];
          if (p >= cand.threshold) {
            let sizeMult = 1.0;
            if (!isFlat && cand.sizeCurve.mode === 'linear') {
              const pMax = cand.sizeCurve.pMax;
              const u = Math.max(0, Math.min(1, (p - cand.threshold) / Math.max(1e-6, pMax - cand.threshold)));
              sizeMult = cand.sizeCurve.minMult + u * (cand.sizeCurve.maxMult - cand.sizeCurve.minMult);
            }
            const rMult = targetSide === 1 ? regimeCV.longSizeMult[s.barIndex] : regimeCV.shortSizeMult[s.barIndex];
            const finalMult = Math.max(0.45, Math.min(1.50, sizeMult * (s.baseSizeMult ?? 1.0) * (rMult > 1.0 ? 1.08 : 1.0)));
            filteredVal.push({ ...s, barIndex: s.barIndex - calEnd, sizeMult: finalMult });
            if (isFlat) keyParts.push(k);
          }
        }
        let metrics;
        if (isFlat) {
          const cKey = keyParts.join(',');
          metrics = cache.get(cKey);
          if (!metrics) {
            const simV = simulateTradesV7(rowsVal, filteredVal, { ...execOpts, start: 0, end: rowsVal.length, warmup: 0 });
            metrics = stripMonthly(summarizeMonthlyCashflowV7(simV.trades, rowsVal));
            cache.set(cKey, metrics);
          }
        } else {
          const simV = simulateTradesV7(rowsVal, filteredVal, { ...execOpts, start: 0, end: rowsVal.length, warmup: 0 });
          metrics = stripMonthly(summarizeMonthlyCashflowV7(simV.trades, rowsVal));
        }
        results.push({ id: cand.id, val: metrics });
      }
      return results;
    };

    out[streamKey] = {
      long: evalDirection(payload.longItems, 1),
      short: evalDirection(payload.shortItems, -1),
    };
  }
  return out;
}

export function evaluateStreamV8(streamKey, streamModelSpec, execProfile = 'EXCHANGE_POST_ONLY', breadthCtx = null) {
  const ds = loadStreamDatasetV8(streamKey);
  const n = ds.rows.length;
  const calEnd = Math.floor(0.50 * n);
  const valEnd = Math.floor(0.80 * n);
  const alignedFunding = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
  const breadth = breadthCtx ?? buildCausalBreadthV8(ds.rows[n - 1].time);
  const regimeCtx = precomputeAssetRegimeV8(ds, breadth);
  const structural = streamModelSpec.structuralSpec;

  const rawSignals = generateAsymmetricSignalsV8(streamKey, ds, structural.sigSpec, alignedFunding, regimeCtx);
  const mlSignals = applyV8DirectionalModels(ds, rawSignals, alignedFunding, regimeCtx, streamModelSpec);

  const opts = {
    ...structural.execOptions,
    execProfile,
    fundingRows: ds.fundingRows,
    fundingPctPer8h: 0.01,
    isolatedLiqCheck: true,
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

  const qualifiedForLive = (mlY5.count ?? 0) >= 25
    && (mlY5.winRatePct ?? 0) >= 72.0
    && (mlY5.profitFactor ?? 0) >= 1.15
    && (mlY5.compoundedNetPct ?? -100) > 0
    && (mlY5.totalSweptNetPct ?? -100) > 0
    && (mlY5.liquidationCount ?? 0) === 0;

  return {
    id: streamKey,
    coin: streamKey.startsWith('BTC') ? 'BTCUSDT' : 'BNBUSDT',
    timeframe: streamKey.endsWith('_15m') ? '15m' : '1h',
    execProfile,
    bars: n,
    splits: { cal: [0, calEnd], val: [calEnd, valEnd], holdoutY5: [valEnd, n] },
    rows: ds.rows,
    trades: simMl.trades,
    baselineTrades: simBase.trades,
    qualifiedForLive,
    summary: {
      baseline: { calVal: baseCalVal, holdoutY5: baseY5, full5y: baseFull },
      ml: { cal: mlCal, val: mlVal, calVal: mlCalVal, holdoutY5: mlY5, full5y: mlFull },
    },
    longSummary: {
      cal: mlCal.long,
      val: mlVal.long,
      calVal: mlCalVal.long,
      holdoutY5: mlY5.long,
      full5y: mlFull.long,
    },
    shortSummary: {
      cal: mlCal.short,
      val: mlVal.short,
      calVal: mlCalVal.short,
      holdoutY5: mlY5.short,
      full5y: mlFull.short,
    },
  };
}

export function getV8BtcBnbStreams(execProfile = 'EXCHANGE_POST_ONLY') {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V8_DIR, 'models_v8_btc_bnb.json'), 'utf8'));
  const breadth = buildCausalBreadthV8(null);
  const streams = {};
  for (const streamKey of V8_STREAM_KEYS) {
    streams[streamKey] = evaluateStreamV8(streamKey, modelsJson.models[streamKey], execProfile, breadth);
  }
  return streams;
}

export async function runRegimeV8BtcBnb() {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V8_DIR, 'models_v8_btc_bnb.json'), 'utf8'));
  const breadth = buildCausalBreadthV8(null);
  const out = {};

  for (const streamKey of V8_STREAM_KEYS) {
    out[streamKey] = {};
    const resByProf = {};
    for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
      resByProf[prof] = evaluateStreamV8(streamKey, modelsJson.models[streamKey], prof, breadth);
    }
    const strictDualPass = Boolean(resByProf.EXCHANGE_POST_ONLY.qualifiedForLive && resByProf.STRICT_TAKER.qualifiedForLive);

    for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
      const res = { ...resByProf[prof], qualifiedForBothProfiles: strictDualPass };
      const { rows, trades, baselineTrades, ...clean } = res;
      out[streamKey][prof] = clean;
      const m = clean.summary.ml;
      const b = clean.summary.baseline;
      console.log(`\n[${streamKey} ${prof}] qualifiedForLive=${clean.qualifiedForLive} (bothProfiles=${strictDualPass})`);
      console.log(`  Base | CV: n=${b.calVal.count} WR=${b.calVal.winRatePct.toFixed(2)}% PF=${b.calVal.profitFactor.toFixed(2)} Mo=${b.calVal.meanMonthlySweepPct.toFixed(2)}% | Y5: n=${b.holdoutY5.count} WR=${b.holdoutY5.winRatePct.toFixed(2)}% PF=${b.holdoutY5.profitFactor.toFixed(2)} Comp=${b.holdoutY5.compoundedNetPct.toFixed(2)}% | 5Y: WR=${b.full5y.winRatePct.toFixed(2)}% PF=${b.full5y.profitFactor.toFixed(2)} Comp=${b.full5y.compoundedNetPct.toFixed(2)}% DD=${b.full5y.maxCompoundedDdPct.toFixed(2)}%`);
      console.log(`  ML   | Cal: WR=${m.cal.winRatePct.toFixed(2)}% PF=${m.cal.profitFactor.toFixed(2)} | Val: WR=${m.val.winRatePct.toFixed(2)}% PF=${m.val.profitFactor.toFixed(2)} | Y5: n=${m.holdoutY5.count} WR=${m.holdoutY5.winRatePct.toFixed(2)}% PF=${m.holdoutY5.profitFactor.toFixed(2)} Comp=${m.holdoutY5.compoundedNetPct.toFixed(2)}% Mo=${m.holdoutY5.meanMonthlySweepPct.toFixed(2)}% (L:${m.holdoutY5.long.count}/${m.holdoutY5.long.winRatePct.toFixed(1)}%/${m.holdoutY5.long.netSumPct.toFixed(1)}% S:${m.holdoutY5.short.count}/${m.holdoutY5.short.winRatePct.toFixed(1)}%/${m.holdoutY5.short.netSumPct.toFixed(1)}%) | 5Y: n=${m.full5y.count} WR=${m.full5y.winRatePct.toFixed(2)}% PF=${m.full5y.profitFactor.toFixed(2)} Comp=${m.full5y.compoundedNetPct.toFixed(2)}% Mo=${m.full5y.meanMonthlySweepPct.toFixed(2)}% DD=${m.full5y.maxCompoundedDdPct.toFixed(2)}% Liq=${m.full5y.liquidationCount}`);
    }
  }

  fs.mkdirSync(RESULTS_V8_DIR, { recursive: true });
  const summary = {
    schema: 'smc-v8-btc-bnb-5y-summary-v1',
    generatedAt: new Date().toISOString(),
    modelMetadata: Object.fromEntries(V8_STREAM_KEYS.map(k => [k, modelsJson.models[k].selectionMeta])),
    streams: out,
  };
  const outPath = path.join(RESULTS_V8_DIR, 'btc_bnb_v8_5y.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n[regime_v8_btc_bnb] Wrote ${path.relative(ROOT_DIR, outPath)}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--extract-cal-val')) {
    process.stdout.write(JSON.stringify(extractCalValPayloadV8()));
  } else if (process.argv.includes('--eval-val')) {
    const req = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(evalValBatchV8(req)));
  } else {
    runRegimeV8BtcBnb().catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}
