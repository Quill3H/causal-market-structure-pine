#!/usr/bin/env node
/**
 * Multi-Timeframe High-WR (>= 75%) 5-Year Suite v7.0 for SOL & ETH:
 *   - SOL_15m, SOL_1h: High-WR structural triggers + Two-Stage Maker Partial TP1 + Micro-BE+ + Purged ML Meta-Labeling
 *   - ETH_15m, ETH_1h: ETH/BTC causal cross-asset + takerBuyVol absorption + Two-Stage Maker Partial TP1 + Micro-BE+ + Purged ML Meta-Labeling
 *
 * Chronological 5-Year Anti-Leakage Split:
 *   - Cal:              [0 .. 50%)
 *   - Val:              [50% .. 80%)
 *   - Blind Holdout Y5: [80% .. 100%)  (NEVER read or tuned during calibration/ML fit)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTradesV7, summarizeMonthlyCashflowV7 } from './sim_engine_v7.mjs';
import { alignFundingToBarsCausal } from './fetch_okx_derivs.mjs';
import { computeOhlcFeatures1h, generateSignals1h, sliceDatasetPrefix1h } from './signals_1h.mjs';
import {
  FEATURE_NAMES_V6,
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
const RESULTS_V7_DIR = path.join(ROOT_DIR, 'research', 'results_v7');

export const V7_ETH_SOL_STREAM_KEYS = ['SOL_15m', 'SOL_1h', 'ETH_15m', 'ETH_1h'];

function loadStreamDatasetV7(streamKey) {
  const map = {
    SOL_15m: 'crypto5y_solusdt_15m.json',
    SOL_1h: 'crypto5y_solusdt_1h.json',
    ETH_15m: 'crypto5y_ethusdt_15m.json',
    ETH_1h: 'crypto5y_ethusdt_1h.json',
    BTC_15m: 'crypto5y_btcusdt_15m.json',
    BTC_1h: 'crypto5y_btcusdt_1h.json',
  };
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, map[streamKey]), 'utf8'));
}

function summarizeSliceV7(trades, rows, lo, hi) {
  const filtered = trades.filter(t => {
    const idxStart = t.signalIndex ?? t.entryIndex;
    return idxStart >= lo && t.exitIndex < hi;
  });
  return summarizeMonthlyCashflowV7(filtered, {
    startTime: rows[lo].time,
    endTime: rows[hi - 1].time,
    rows,
  });
}

function stripMonthly(m) {
  const { monthlyTable, ...rest } = m;
  return rest;
}

export function generateEthSolStreamSignalsV7(streamKey, dataset, spec, btcDataset = null, precomputed = null) {
  if (streamKey === 'SOL_15m' || streamKey === 'ETH_15m') {
    return generate15mSignalsV7(dataset, spec, precomputed);
  }
  if (streamKey === 'SOL_1h') {
    if (spec.genKind === '1h_MultiTrap') {
      return generateSignals1h(dataset, spec, precomputed?.ohlc ?? null);
    }
    return generateSolSignalsV6(dataset, spec, precomputed?.sol ?? null);
  }
  if (streamKey === 'ETH_1h') {
    return generateEthSignalsV6(dataset, btcDataset, spec, precomputed?.ohlc ?? null);
  }
  throw new Error(`Unknown v7 ETH/SOL streamKey: ${streamKey}`);
}

function buildSol15mCatalogV7() {
  const specs = [];
  const exitCombos = [
    { tp1TriggerR: 0.58, tp1QtyPct: 55, tp1LockOffsetR: 0.36, rewardRisk: 1.25, beTriggerR: 0.38, beOffsetPct: 0.30 },
    { tp1TriggerR: 0.65, tp1QtyPct: 55, tp1LockOffsetR: 0.40, rewardRisk: 1.30, beTriggerR: 0.40, beOffsetPct: 0.32 },
  ];
  for (const htfMode of ['H4_20', 'H4_20_or_50']) {
    for (const pullAtr of [0.18, 0.25]) {
      for (const [stopAtr, minStopPct] of [[4.2, 1.25], [4.5, 1.30], [5.0, 1.35]]) {
        for (const tbrMin of [null, 0.50]) {
          for (const ex of exitCombos) {
            const execOptions = {
              entryMode: 'LIMIT_PULLBACK',
              limitExpiryBars: 8,
              pendingPolicy: 'ignore',
              limitSameBarTp: 'close',
              cooldown: 6,
              warmup: 250,
              stopAtr,
              minStopPct,
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
            const sigSpec = {
              specId: `SOL_15m_Sync_${htfMode}_p${pullAtr}_s${stopAtr}_tbr${tbrMin ?? 'all'}_tp1_${ex.tp1TriggerR}`,
              rawFamily: 'M15_H1SyncedMultiTrap',
              h1Lookback: 20,
              h4Lookback: 10,
              ltfLookback: null,
              include24h: true,
              trapMaxBars: 4,
              htfMode,
              minAtrPct: 0.14,
              pullAtr,
              tbrMin,
              adaptive: false,
            };
            specs.push({ id: sigSpec.specId, sigSpec, execOptions });
          }
        }
      }
    }
  }
  return specs;
}

function buildEth15mCatalogV7() {
  const specs = [];
  const exitCombos = [
    { tp1TriggerR: 0.58, tp1QtyPct: 55, tp1LockOffsetR: 0.36, rewardRisk: 1.25, beTriggerR: 0.38, beOffsetPct: 0.30 },
    { tp1TriggerR: 0.65, tp1QtyPct: 55, tp1LockOffsetR: 0.40, rewardRisk: 1.30, beTriggerR: 0.40, beOffsetPct: 0.32 },
  ];
  for (const htfMode of ['H4_20', 'H4_20_or_50']) {
    for (const pullAtr of [0.25, 0.35]) {
      for (const [stopAtr, minStopPct] of [[4.5, 1.3], [5.2, 1.4]]) {
        for (const tbrMin of [null, 0.49]) {
          for (const ex of exitCombos) {
            const execOptions = {
              entryMode: 'LIMIT_PULLBACK',
              limitExpiryBars: 8,
              pendingPolicy: 'ignore',
              limitSameBarTp: 'close',
              cooldown: 6,
              warmup: 250,
              stopAtr,
              minStopPct,
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
            const sigSpec = {
              specId: `ETH_15m_Sync_${htfMode}_p${pullAtr}_s${stopAtr}_tbr${tbrMin ?? 'all'}_tp1_${ex.tp1TriggerR}`,
              rawFamily: 'M15_H1SyncedMultiTrap',
              h1Lookback: 20,
              h4Lookback: 10,
              ltfLookback: null,
              include24h: true,
              trapMaxBars: 4,
              htfMode,
              minAtrPct: 0.14,
              pullAtr,
              tbrMin,
              adaptive: false,
            };
            specs.push({ id: sigSpec.specId, sigSpec, execOptions });
          }
        }
      }
    }
  }
  return specs;
}

function buildSol1hCatalogV7() {
  const specs = [];
  const exitCombos = [
    { tp1TriggerR: 0.65, tp1QtyPct: 55, tp1LockOffsetR: 0.38, rewardRisk: 1.30, beTriggerR: 0.40, beOffsetPct: 0.32 },
    { tp1TriggerR: 0.70, tp1QtyPct: 55, tp1LockOffsetR: 0.40, rewardRisk: 1.30, beTriggerR: 0.40, beOffsetPct: 0.35 },
  ];

  // Candidate Group A: SOL Taker-Buy Thrust + Trend-Pullback / Hybrid Squeeze
  for (const mode of ['TrendPbThrust', 'HybridSol']) {
    for (const pbBodyAtr of [0.35, 0.45]) {
      for (const [stopAtr, minStopPct] of [[2.5, 1.2], [2.8, 1.3]]) {
        for (const ex of exitCombos) {
          const execOptions = {
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
          const sigSpec = {
            specId: `SOL_1h_${mode}_b${pbBodyAtr}_s${stopAtr}_tp1_${ex.tp1TriggerR}`,
            genKind: 'sol_v6',
            mode,
            limitOffsetAtr: 0.35,
            thrustMin: 0.55,
            pbTouchAtr: 0.35,
            pbBodyAtr,
            squeezeRatio: 0.92,
            sqLookback: 14,
            sqRvolMin: 1.1,
          };
          specs.push({ id: sigSpec.specId, sigSpec, execOptions });
        }
      }
    }
  }

  // Candidate Group B: HtfSmcMultiTrap calibrated for SOL 1h
  for (const htfMode of ['H4_20', 'H4_20_or_50']) {
    for (const trapMaxBars of [3, 4]) {
      for (const [stopAtr, minStopPct] of [[2.5, 1.2], [2.8, 1.3]]) {
        for (const ex of exitCombos) {
          const execOptions = {
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
          const sigSpec = {
            specId: `SOL_1h_Trap_${htfMode}_k${trapMaxBars}_s${stopAtr}_tp1_${ex.tp1TriggerR}`,
            genKind: '1h_MultiTrap',
            family: 'HtfSmcMultiTrap',
            lookback: 20,
            p4Lookback: 10,
            includePdhl: true,
            htfMode,
            trapMaxBars,
            limitOffsetAtr: 0.25,
          };
          specs.push({ id: sigSpec.specId, sigSpec, execOptions });
        }
      }
    }
  }

  return specs;
}

function buildEth1hCatalogV7() {
  const specs = [];
  const exitCombos = [
    { tp1TriggerR: 0.65, tp1QtyPct: 60, tp1LockOffsetR: 0.38, rewardRisk: 1.30, beTriggerR: 0.40, beOffsetPct: 0.32 },
    { tp1TriggerR: 0.72, tp1QtyPct: 60, tp1LockOffsetR: 0.42, rewardRisk: 1.35, beTriggerR: 0.42, beOffsetPct: 0.35 },
  ];
  for (const htfMode of ['H4_20', 'H4_20_or_50']) {
    for (const trapMaxBars of [3, 4]) {
      for (const minDeltaRatio of [null, -0.05, 0.0]) {
        for (const [stopAtr, minStopPct] of [[2.8, 1.3], [3.2, 1.4]]) {
          for (const ex of exitCombos) {
            const execOptions = {
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
            const sigSpec = {
              specId: `ETH_1h_${htfMode}_k${trapMaxBars}_d${minDeltaRatio ?? 'all'}_s${stopAtr}_tp1_${ex.tp1TriggerR}`,
              family: 'HtfSmcMultiTrap',
              lookback: 20,
              p4Lookback: 10,
              includePdhl: true,
              htfMode,
              trapMaxBars,
              limitOffsetAtr: 0.24,
              minDeltaRatio,
            };
            specs.push({ id: sigSpec.specId, sigSpec, execOptions });
          }
        }
      }
    }
  }
  return specs;
}

function getCatalogForStream(streamKey) {
  if (streamKey === 'SOL_15m') return buildSol15mCatalogV7();
  if (streamKey === 'ETH_15m') return buildEth15mCatalogV7();
  if (streamKey === 'SOL_1h') return buildSol1hCatalogV7();
  if (streamKey === 'ETH_1h') return buildEth1hCatalogV7();
  throw new Error(`No catalog for stream: ${streamKey}`);
}

export function calibrateEthSolV7CalVal(streamKey, dsCV, btcCV = null) {
  const is15m = streamKey.endsWith('_15m');
  const n = dsCV.rows.length;
  const calEnd = Math.floor((0.50 / 0.80) * n);
  const catalog = getCatalogForStream(streamKey);

  let pre = null;
  if (is15m) {
    pre = precompute15mV7(dsCV);
  } else if (streamKey === 'SOL_1h') {
    pre = {
      ohlc: computeOhlcFeatures1h(dsCV.rows),
      sol: {
        f1: computeOhlcFeatures1h(dsCV.rows),
        f4: computeOhlcFeatures1h(dsCV.htf['4h'].rows),
      },
    };
  } else {
    pre = { ohlc: computeOhlcFeatures1h(dsCV.rows) };
  }

  let best = null;
  for (const cand of catalog) {
    const signals = generateEthSolStreamSignalsV7(streamKey, dsCV, cand.sigSpec, btcCV, pre);
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
    const mCV = summarizeSliceV7(simCV.trades, dsCV.rows, 0, n);
    const mCal = summarizeSliceV7(simCV.trades, dsCV.rows, 0, calEnd);
    const mVal = summarizeSliceV7(simCV.trades, dsCV.rows, calEnd, n);

    const minCount = is15m ? 180 : 180;
    const minValCount = is15m ? 72 : 72;
    const eligible = (simCV.count ?? 0) >= minCount
      && (mVal.count ?? 0) >= minValCount
      && (mCV.winRatePct ?? 0) >= 70.0
      && (mCal.profitFactor ?? 0) >= 1.20
      && (mVal.profitFactor ?? 0) >= 1.18
      && (mCal.compoundedNetPct ?? -100) > 0
      && (mVal.compoundedNetPct ?? -100) > 0
      && (mCV.liquidationCount ?? 0) === 0;

    // Prefer higher turnover headroom when WR/PF are strong so ML meta-labeling retains >= 75 Val trades
    const highTurnoverBonus = ((mVal.count ?? 0) >= 120 && (mVal.profitFactor ?? 0) >= 1.25 && (mCal.profitFactor ?? 0) >= 1.25) ? 450 : 0;
    const score = (eligible ? 10000 : 0)
      + highTurnoverBonus
      + (mCV.meanMonthlySweepPct ?? 0) * 35
      + (mVal.profitFactor ?? 0) * 60
      + (mCal.profitFactor ?? 0) * 35
      + (mCV.winRatePct ?? 0) * 2.5
      - (mCV.maxCompoundedDdPct ?? 0) * 1.5;

    if (!best || score > best.score) {
      best = { score, eligible, cand };
    }
  }
  return best.cand;
}

function getFeatureNamesForStream(streamKey) {
  if (streamKey.startsWith('ETH')) return ETH_FEATURE_NAMES_V6;
  return SOL_FEATURE_NAMES_V6;
}

function buildFeatureExtractorContext(streamKey, ds, alignedFunding, btcDs = null) {
  if (streamKey.startsWith('ETH')) {
    return {
      isEth: true,
      ethCtx: precomputeEthCrossContextV6(ds, btcDs, alignedFunding),
    };
  }
  return {
    isEth: false,
    ofCtx: precomputeOrderflowContextV6(ds, alignedFunding),
  };
}

function extractFeatureMap(streamKey, ds, signal, barIdx, alignedFunding, ctx, btcDs = null) {
  if (ctx.isEth) {
    return extractEthCandidateFeaturesV6(ds, btcDs, signal, barIdx, alignedFunding, ctx.ethCtx);
  }
  return extractCandidateFeaturesV6(ds, signal, barIdx, alignedFunding, ctx.ofCtx);
}

export function applyV7EthSolModelToSignals(streamKey, ds, signals, alignedFunding, modelSpec, btcDs = null) {
  const ctx = buildFeatureExtractorContext(streamKey, ds, alignedFunding, btcDs);
  const filtered = [];
  for (const s of signals) {
    const f = extractFeatureMap(streamKey, ds, s, s.barIndex, alignedFunding, ctx, btcDs);
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

function loadBtcForEthStream(streamKey) {
  return streamKey === 'ETH_15m'
    ? loadStreamDatasetV7('BTC_15m')
    : (streamKey === 'ETH_1h' ? loadStreamDatasetV7('BTC_1h') : null);
}

function extractCalValPayloadV7() {
  const btc15Full = loadStreamDatasetV7('BTC_15m');
  const btc1hFull = loadStreamDatasetV7('BTC_1h');
  const out = {};

  for (const streamKey of V7_ETH_SOL_STREAM_KEYS) {
    const full = loadStreamDatasetV7(streamKey);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV7(full, valEnd);
    const btcCV = streamKey === 'ETH_15m'
      ? sliceDatasetPrefixV7(btc15Full, valEnd)
      : (streamKey === 'ETH_1h' ? sliceDatasetPrefix1h(btc1hFull, valEnd) : null);

    const alignedFundingCV = alignFundingToBarsCausal(dsCV.rows, dsCV.fundingRows ?? []);
    const structural = calibrateEthSolV7CalVal(streamKey, dsCV, btcCV);
    const signals = generateEthSolStreamSignalsV7(streamKey, dsCV, structural.sigSpec, btcCV);

    const featNames = getFeatureNamesForStream(streamKey);
    const ctx = buildFeatureExtractorContext(streamKey, dsCV, alignedFundingCV, btcCV);
    const sigFeatures = signals.map(s => {
      const fmap = extractFeatureMap(streamKey, dsCV, s, s.barIndex, alignedFundingCV, ctx, btcCV);
      return {
        barIndex: s.barIndex,
        side: s.side,
        atr: s.atr,
        limitPrice: s.limitPrice ?? null,
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
    const sigIdxByBar = new Map(signals.map((s, idx) => [s.barIndex, idx]));

    const calSequential = simCal.trades
      .filter(t => t.signalIndex >= 0 && t.exitIndex < calEnd)
      .map(t => ({ idx: sigIdxByBar.get(t.signalIndex), barIndex: t.signalIndex, y: t.netPct > 0 ? 1 : 0, netPct: t.netPct }));
    const valSequential = simVal.trades
      .filter(t => t.signalIndex >= calEnd && t.exitIndex < valEnd)
      .map(t => ({ idx: sigIdxByBar.get(t.signalIndex), barIndex: t.signalIndex, y: t.netPct > 0 ? 1 : 0, netPct: t.netPct }));

    const baseCal = stripMonthly(summarizeSliceV7(simCal.trades, dsCV.rows, 0, calEnd));
    const baseVal = stripMonthly(summarizeSliceV7(simVal.trades, dsCV.rows, calEnd, valEnd));

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
      baseCal,
      baseVal,
    };
  }
  return out;
}

function evalCalValBatchV7(req) {
  const btc15Full = loadStreamDatasetV7('BTC_15m');
  const btc1hFull = loadStreamDatasetV7('BTC_1h');
  const out = {};

  for (const streamKey of V7_ETH_SOL_STREAM_KEYS) {
    const full = loadStreamDatasetV7(streamKey);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV7(full, valEnd);
    const btcCV = streamKey === 'ETH_15m'
      ? sliceDatasetPrefixV7(btc15Full, valEnd)
      : (streamKey === 'ETH_1h' ? sliceDatasetPrefix1h(btc1hFull, valEnd) : null);

    const payload = req[streamKey];
    const structural = payload.structuralSpec;
    const baseSignals = generateEthSolStreamSignalsV7(streamKey, dsCV, structural.sigSpec, btcCV);
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
      const filteredCal = [];
      const filteredVal = [];
      const keyCalParts = [];
      const keyValParts = [];
      const isFlat = !cand.sizeCurve || cand.sizeCurve.mode === 'flat';

      for (let k = 0; k < baseSignals.length; k++) {
        const s = baseSignals[k];
        if (s.barIndex >= valEnd) continue;
        const p = cand.probs[k];
        if (p >= cand.threshold) {
          let sizeMult = 1.0;
          if (!isFlat && cand.sizeCurve.mode === 'linear') {
            const pMax = cand.sizeCurve.pMax;
            const u = Math.max(0, Math.min(1, (p - cand.threshold) / Math.max(1e-6, pMax - cand.threshold)));
            sizeMult = cand.sizeCurve.minMult + u * (cand.sizeCurve.maxMult - cand.sizeCurve.minMult);
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

      const evalSlice = (rowsSlice, sigSlice, warmupBars, cachePrefix, keyParts) => {
        const cKey = isFlat ? `${cachePrefix}:${keyParts.join(',')}` : null;
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

export function evaluateEthSolStreamV7(streamKey, modelSpec, execProfile = 'EXCHANGE_POST_ONLY') {
  const ds = loadStreamDatasetV7(streamKey);
  const btcDs = loadBtcForEthStream(streamKey);
  const n = ds.rows.length;
  const calEnd = Math.floor(0.50 * n);
  const valEnd = Math.floor(0.80 * n);
  const alignedFunding = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
  const structural = modelSpec.structuralSpec;

  const rawSignals = generateEthSolStreamSignalsV7(streamKey, ds, structural.sigSpec, btcDs);
  const mlSignals = applyV7EthSolModelToSignals(streamKey, ds, rawSignals, alignedFunding, modelSpec, btcDs);

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

  const mlCal = stripMonthly(summarizeSliceV7(simMl.trades, ds.rows, 0, calEnd));
  const mlVal = stripMonthly(summarizeSliceV7(simMl.trades, ds.rows, calEnd, valEnd));
  const mlCalVal = stripMonthly(summarizeSliceV7(simMl.trades, ds.rows, 0, valEnd));
  const mlY5 = stripMonthly(summarizeSliceV7(simMl.trades, ds.rows, valEnd, n));
  const mlFull = stripMonthly(summarizeSliceV7(simMl.trades, ds.rows, 0, n));

  const baseCalVal = stripMonthly(summarizeSliceV7(simBase.trades, ds.rows, 0, valEnd));
  const baseY5 = stripMonthly(summarizeSliceV7(simBase.trades, ds.rows, valEnd, n));
  const baseFull = stripMonthly(summarizeSliceV7(simBase.trades, ds.rows, 0, n));

  // Verify Blind Holdout Y5 under BOTH EXCHANGE_POST_ONLY and STRICT_TAKER
  const otherProfile = execProfile === 'EXCHANGE_POST_ONLY' ? 'STRICT_TAKER' : 'EXCHANGE_POST_ONLY';
  const simOtherY5 = simulateTradesV7(ds.rows, mlSignals, {
    ...opts,
    execProfile: otherProfile,
    start: valEnd,
    end: n,
    warmup: 0,
  });
  const mlOtherY5 = stripMonthly(summarizeSliceV7(simOtherY5.trades, ds.rows, valEnd, n));
  const qualifiedForLive = passesY5Gate(mlY5) && passesY5Gate(mlOtherY5);

  return {
    id: streamKey,
    coin: streamKey.startsWith('SOL') ? 'SOLUSDT' : 'ETHUSDT',
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
  };
}

export function getV7EthSolStreams(execProfile = 'EXCHANGE_POST_ONLY') {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V7_DIR, 'models_v7_eth_sol.json'), 'utf8'));
  const streams = {};
  for (const streamKey of V7_ETH_SOL_STREAM_KEYS) {
    streams[streamKey] = evaluateEthSolStreamV7(streamKey, modelsJson.models[streamKey], execProfile);
  }
  return streams;
}

export async function runHighWrV7EthSol() {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V7_DIR, 'models_v7_eth_sol.json'), 'utf8'));
  const out = {};
  for (const streamKey of V7_ETH_SOL_STREAM_KEYS) {
    out[streamKey] = {};
    for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
      const res = evaluateEthSolStreamV7(streamKey, modelsJson.models[streamKey], prof);
      const { rows, trades, baselineTrades, ...clean } = res;
      out[streamKey][prof] = clean;
      const m = clean.summary.ml;
      const b = clean.summary.baseline;
      console.log(`\n[${streamKey} ${prof}] qualifiedForLive=${clean.qualifiedForLive}`);
      console.log(`  Base | CV: n=${b.calVal.count} WR=${b.calVal.winRatePct}% PF=${b.calVal.profitFactor} Mo=${b.calVal.meanMonthlySweepPct}% | Y5: n=${b.holdoutY5.count} WR=${b.holdoutY5.winRatePct}% PF=${b.holdoutY5.profitFactor} Comp=${b.holdoutY5.compoundedNetPct}% | 5Y: n=${b.full5y.count} WR=${b.full5y.winRatePct}% PF=${b.full5y.profitFactor} Comp=${b.full5y.compoundedNetPct}% DD=${b.full5y.maxCompoundedDdPct}%`);
      console.log(`  ML   | Cal: n=${m.cal.count} WR=${m.cal.winRatePct}% PF=${m.cal.profitFactor} | Val: n=${m.val.count} WR=${m.val.winRatePct}% PF=${m.val.profitFactor} | Y5: n=${m.holdoutY5.count} WR=${m.holdoutY5.winRatePct}% PF=${m.holdoutY5.profitFactor} Comp=${m.holdoutY5.compoundedNetPct}% Mo=${m.holdoutY5.meanMonthlySweepPct}% | 5Y: n=${m.full5y.count} WR=${m.full5y.winRatePct}% PF=${m.full5y.profitFactor} Comp=${m.full5y.compoundedNetPct}% Mo=${m.full5y.meanMonthlySweepPct}% DD=${m.full5y.maxCompoundedDdPct}% Liq=${m.full5y.liquidationCount}`);
    }
  }

  fs.mkdirSync(RESULTS_V7_DIR, { recursive: true });
  const summary = {
    schema: 'smc-v7-eth-sol-5y-summary-v1',
    generatedAt: new Date().toISOString(),
    promotionGate: 'Y5 WR >= 72% && PF >= 1.15 && CompNet > 0% && TotalNet > 0% && Liq == 0 && count >= 25 under BOTH EXCHANGE_POST_ONLY and STRICT_TAKER',
    modelMetadata: Object.fromEntries(V7_ETH_SOL_STREAM_KEYS.map(k => [k, modelsJson.models[k].selectionMeta])),
    streams: out,
  };
  const outPath = path.join(RESULTS_V7_DIR, 'eth_sol_v7_5y.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n[high_wr_v7_eth_sol] Wrote ${path.relative(ROOT_DIR, outPath)}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--extract-cal-val')) {
    process.stdout.write(JSON.stringify(extractCalValPayloadV7()));
  } else if (process.argv.includes('--eval-val')) {
    const req = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(evalCalValBatchV7(req)));
  } else {
    runHighWrV7EthSol().catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}
