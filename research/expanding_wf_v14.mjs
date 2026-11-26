#!/usr/bin/env node
/**
 * SMC v14.0 — True Expanding Walk-Forward Retraining + CV AUC >= 0.52 Abstention Gate
 *
 * Exports:
 *   V14_STREAM_KEYS, computeLockSha256V14, verifyModelsLockV14, loadModelsV14,
 *   applyV14ExpandingModelToSignals, getV14CryptoStreams, runExpandingWalkForwardV14
 *
 * Anti-leakage invariants:
 *   1) Fixed UTC epoch timestamps stored inside models_v14_expanding_wf.json (prefix-truncation invariant).
 *   2) Each expanding epoch [T_k, T_{k+1}) is trained strictly on closed trades with
 *      exitIndex < epochStartBarIndex && exitTime <= epochStartTimeSec.
 *   3) Epochs failing chronoCvAuc >= 0.52 or Inner-Val expectancy gate (abstain: true) emit 0 trades.
 *   4) Causal Closed-Trade DD Guard + intra-bar isolated liquidation check (mmr = 0.005).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  simulateTradesV7,
  simulatePortfolioV7,
  summarizeMonthlyCashflowV7,
} from './sim_engine_v7.mjs';
import { alignFundingToBarsCausal } from './fetch_okx_derivs.mjs';
import {
  EQUITY_REGIMES_V8,
  precomputeAssetRegimeV8,
  precomputeEquityRegimeV8,
} from './regime_engine_v8.mjs';
import { precomputeStockContextV6, generateFutures1hSignalsCausal } from './suite_v6_stocks.mjs';
import {
  V9_STREAM_KEYS,
  BASE_FEATURE_NAMES_V9,
  ETH_FEATURE_NAMES_V9,
  loadStreamDatasetV9,
  sliceByMaxTimeV9,
  buildCausalBreadthV9,
  precomputeFeatureContextV9,
  extractCandidateFeaturesV9,
  generateStreamSignalsV9,
  applyCausalDdGuardV9,
} from './ensemble_v9_walkforward.mjs';
import { scoreCandidateV5 } from './ml_inference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V6_DIR = path.join(HERE, 'results_v6');
const RESULTS_V9_DIR = path.join(HERE, 'results_v9');
const RESULTS_V14_DIR = path.join(HERE, 'results_v14');

export const V14_STREAM_KEYS = V9_STREAM_KEYS;

const rawCacheV14 = new Map();
function loadRawDataV14(fileName) {
  let obj = rawCacheV14.get(fileName);
  if (!obj) {
    obj = JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8'));
    rawCacheV14.set(fileName, obj);
  }
  return obj;
}

function canonicalStringify(val) {
  if (val === null || typeof val !== 'object') {
    if (typeof val === 'number' && Number.isFinite(val)) {
      if (Number.isInteger(val)) return String(val);
      return String(Math.round(val * 1e10));
    }
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) return '[' + val.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(val).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(val[k])).join(',') + '}';
}

export function computeLockSha256V14(modelsObj) {
  return crypto.createHash('sha256').update(canonicalStringify(modelsObj)).digest('hex');
}

export function verifyModelsLockV14(modelsJson) {
  assert.ok(modelsJson && modelsJson.models && modelsJson.selectionLockSha256, 'Missing v14 selectionLockSha256');
  const recomputed = computeLockSha256V14(modelsJson.models);
  assert.equal(
    recomputed,
    modelsJson.selectionLockSha256,
    `v14 model lock SHA-256 mismatch: expected ${modelsJson.selectionLockSha256}, got ${recomputed}`,
  );
  return recomputed;
}

export function loadModelsV14() {
  const filePath = path.join(RESULTS_V14_DIR, 'models_v14_expanding_wf.json');
  const modelsJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  verifyModelsLockV14(modelsJson);
  return modelsJson;
}

function r2(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(2));
}

function computeRatios(trades, cagrPct, maxDdPct, periodYears) {
  const n = trades.length;
  let sharpe = null;
  let sortino = null;
  if (n >= 2 && periodYears > 0) {
    let sum = 0;
    let downSq = 0;
    const rets = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = trades[i].portfolioNetPct ?? trades[i].netPct;
      rets[i] = p;
      sum += p;
      if (p < 0) downSq += p * p;
    }
    const mean = sum / n;
    let vSum = 0;
    for (let i = 0; i < n; i++) {
      const d = rets[i] - mean;
      vSum += d * d;
    }
    const std = Math.sqrt(vSum / (n - 1));
    const dDev = Math.sqrt(downSq / n);
    const ann = Math.sqrt(n / periodYears);
    if (std > 1e-12) sharpe = (mean / std) * ann;
    if (dDev > 1e-12) sortino = (mean / dDev) * ann;
  }
  const calmar = cagrPct !== null && maxDdPct > 1e-9 ? cagrPct / maxDdPct : null;
  return { sharpe: r2(sharpe), sortino: r2(sortino), calmar: r2(calmar) };
}

function stripMonthly(m) {
  const { monthlyTable, ...rest } = m;
  return rest;
}

function summarizeSliceByTimeV14(trades, rows, tStart, tEnd) {
  const filtered = trades.filter(t => {
    const sigIdx = t.signalIndex ?? t.entryIndex;
    const sigTime = rows[sigIdx]?.time;
    const exitTime = rows[t.exitIndex]?.time;
    return Number.isFinite(sigTime) && Number.isFinite(exitTime) && sigTime >= tStart && exitTime < tEnd;
  });
  return summarizeMonthlyCashflowV7(filtered, {
    startTime: tStart,
    endTime: tEnd - 1,
    rows,
  });
}

function buildEpochSchedule(rows, intervalSeconds) {
  const n = rows.length;
  const cuts = [0.0, 0.20, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.0];
  const barAt = p => (p >= 1.0 ? n : Math.floor(p * n));
  const timeAt = idx => (idx < n ? rows[idx].time : rows[n - 1].time + intervalSeconds);

  const labels = [
    { epochIdx: -1, label: 'PreEpoch_20_40', lo: 0.20, hi: 0.40 },
    { epochIdx: 0, label: 'Epoch0_40_50', lo: 0.40, hi: 0.50 },
    { epochIdx: 1, label: 'Epoch1_50_60', lo: 0.50, hi: 0.60 },
    { epochIdx: 2, label: 'Epoch2_60_70', lo: 0.60, hi: 0.70 },
    { epochIdx: 3, label: 'Epoch3_70_80', lo: 0.70, hi: 0.80 },
    { epochIdx: 4, label: 'Epoch4_Y5H1_80_90', lo: 0.80, hi: 0.90 },
    { epochIdx: 5, label: 'Epoch5_Y5H2_90_100', lo: 0.90, hi: 1.00 },
  ];

  return labels.map(spec => {
    const startIdx = barAt(spec.lo);
    const endIdx = barAt(spec.hi);
    return {
      epochIdx: spec.epochIdx,
      label: spec.label,
      epochStartPct: spec.lo,
      epochEndPct: spec.hi,
      epochStartBarIndex: startIdx,
      epochEndBarIndex: endIdx,
      epochStartTimeSec: timeAt(startIdx),
      epochEndTimeSec: timeAt(endIdx),
    };
  });
}

function extractExpandingPayloadV14() {
  const v9Models = JSON.parse(fs.readFileSync(path.join(RESULTS_V9_DIR, 'models_v9_crypto.json'), 'utf8')).models;
  const breadthFull = buildCausalBreadthV9(null);
  const out = {};

  for (const streamKey of V14_STREAM_KEYS) {
    const ds = loadStreamDatasetV9(streamKey);
    const n = ds.rows.length;
    const intervalSeconds = ds.intervalSeconds;
    const alignedFunding = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
    const regimeCtx = precomputeAssetRegimeV8(ds, breadthFull);
    const btcDs = streamKey.startsWith('ETH')
      ? sliceByMaxTimeV9(loadStreamDatasetV9(streamKey.endsWith('_15m') ? 'BTC_15m' : 'BTC_1h'), ds.rows[n - 1].time)
      : null;

    const structural = v9Models[streamKey].structuralSpec;
    const baseSignals = generateStreamSignalsV9(streamKey, ds, structural.sigSpec, alignedFunding, regimeCtx, btcDs);
    const execOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: ds.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      intervalSeconds,
    };

    const simFull = simulateTradesV7(ds.rows, baseSignals, { ...execOpts, start: 0, end: n });
    const tradeByBar = new Map();
    for (const t of simFull.trades) tradeByBar.set(t.signalIndex, t);

    const fCtx = precomputeFeatureContextV9(streamKey, ds, alignedFunding, regimeCtx, ds.rows[n - 1].time);
    const featureNames = streamKey.startsWith('ETH') ? ETH_FEATURE_NAMES_V9 : BASE_FEATURE_NAMES_V9;

    const candidateTrades = [];
    for (let k = 0; k < baseSignals.length; k++) {
      const s = baseSignals[k];
      const t = tradeByBar.get(s.barIndex);
      if (!t) continue;
      const fMap = extractCandidateFeaturesV9(streamKey, ds, s, s.barIndex, alignedFunding, fCtx);
      const vec = featureNames.map(fn => (Number.isFinite(fMap[fn]) ? fMap[fn] : null));
      candidateTrades.push({
        signalIdx: k,
        signalBarIndex: s.barIndex,
        signalTime: ds.rows[s.barIndex].time,
        entryIndex: t.entryIndex,
        entryTime: ds.rows[t.entryIndex].time,
        exitIndex: t.exitIndex,
        exitTime: ds.rows[t.exitIndex].time + intervalSeconds,
        side: s.side,
        baseSizeMult: s.baseSizeMult ?? 1.0,
        regime: s.regime,
        y: t.netPct > 0 ? 1 : 0,
        netPct: t.netPct,
        features: vec,
      });
    }

    const schedule = buildEpochSchedule(ds.rows, intervalSeconds);
    out[streamKey] = {
      streamKey,
      totalBarsFull: n,
      intervalSeconds,
      dataStartTimeSec: ds.rows[0].time,
      dataEndTimeSec: ds.rows[n - 1].time + intervalSeconds,
      featureNames,
      structuralSpec: structural,
      schedule,
      candidateTrades,
    };
  }
  return out;
}

export function resolveEpochForTimestampV14(streamModelV14, barTimeSec) {
  if (barTimeSec < streamModelV14.firstEpochStartTimeSec) {
    return { kind: 'warmup', abstain: true, modelSpec: null, epochIdx: -2, label: 'Warmup_0_20' };
  }
  for (const ep of streamModelV14.epochs) {
    if (barTimeSec >= ep.epochStartTimeSec && barTimeSec < ep.epochEndTimeSec) {
      return { kind: 'epoch', ...ep };
    }
  }
  const live = streamModelV14.liveActiveModel;
  return {
    kind: 'live',
    epochIdx: 99,
    label: 'LiveActiveModel',
    abstain: live?.abstain ?? true,
    qualified: live?.qualified ?? false,
    modelSpec: live?.modelSpec ?? null,
  };
}

/**
 * Strictly causal inference across an arbitrary-length dataset using fixed UTC epoch timestamps.
 * Never depends on dataset.rows.length so prefix truncation or live candle appending is invariant.
 */
export function applyV14ExpandingModelToSignals(
  streamKey,
  dataset,
  signals,
  fundingRates,
  assetRegime,
  streamModelV14,
  maxTimeSec = null,
) {
  const rows = dataset.rows;
  const effMaxTime = maxTimeSec ?? rows[rows.length - 1].time;
  const fCtx = precomputeFeatureContextV9(streamKey, dataset, fundingRates, assetRegime, effMaxTime);

  const filtered = [];
  for (const s of signals) {
    const barTime = rows[s.barIndex].time;
    if (barTime > effMaxTime) continue;

    const ep = resolveEpochForTimestampV14(streamModelV14, barTime);
    if (ep.abstain || !ep.modelSpec) continue;

    const f = extractCandidateFeaturesV9(streamKey, dataset, s, s.barIndex, fundingRates, fCtx);
    const sc = scoreCandidateV5(f, ep.modelSpec);
    if (!sc.pass) continue;

    const baseMult = s.baseSizeMult ?? 1.0;
    const sizeMult = Math.max(0.45, Math.min(1.45, sc.sizeMult * baseMult));
    filtered.push({
      ...s,
      sizeMult,
      meta: {
        ...(s.meta ?? {}),
        epochIdx: ep.epochIdx,
        epochLabel: ep.label,
        probWin: sc.probWin,
        sizeMult,
        regime: s.regime,
      },
    });
  }
  return filtered;
}

export function evaluateStreamV14(streamKey, streamModelV14, execProfile = 'EXCHANGE_POST_ONLY', breadthCtx = null) {
  const ds = loadStreamDatasetV9(streamKey);
  const n = ds.rows.length;
  const intervalSeconds = ds.intervalSeconds;
  const alignedFunding = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
  const breadth = breadthCtx ?? buildCausalBreadthV9(ds.rows[n - 1].time);
  const regimeCtx = precomputeAssetRegimeV8(ds, breadth);
  const btcDs = streamKey.startsWith('ETH')
    ? sliceByMaxTimeV9(loadStreamDatasetV9(streamKey.endsWith('_15m') ? 'BTC_15m' : 'BTC_1h'), ds.rows[n - 1].time)
    : null;

  const structural = streamModelV14.structuralSpec;
  const rawSignals = generateStreamSignalsV9(streamKey, ds, structural.sigSpec, alignedFunding, regimeCtx, btcDs);
  const mlSignals = applyV14ExpandingModelToSignals(
    streamKey,
    ds,
    rawSignals,
    alignedFunding,
    regimeCtx,
    streamModelV14,
    ds.rows[n - 1].time,
  );

  const opts = {
    ...structural.execOptions,
    execProfile,
    fundingRows: ds.fundingRows,
    fundingPctPer8h: 0.01,
    isolatedLiqCheck: true,
    mmr: 0.005,
    intervalSeconds,
    start: 0,
    end: n,
  };

  const simBase = simulateTradesV7(ds.rows, rawSignals, opts);
  const simMl = simulateTradesV7(ds.rows, mlSignals, opts);

  const t0 = ds.rows[0].time;
  const tEnd = ds.rows[n - 1].time + intervalSeconds;
  const ep0 = streamModelV14.epochs.find(e => e.epochIdx === 0);
  const ep3 = streamModelV14.epochs.find(e => e.epochIdx === 3);
  const ep4 = streamModelV14.epochs.find(e => e.epochIdx === 4);
  const tOosStart = ep0.epochStartTimeSec;
  const tValEnd = ep3.epochEndTimeSec;
  const tY5Start = ep4.epochStartTimeSec;

  const epochStats = {};
  for (const ep of streamModelV14.epochs) {
    const st = stripMonthly(summarizeSliceByTimeV14(simMl.trades, ds.rows, ep.epochStartTimeSec, ep.epochEndTimeSec));
    epochStats[ep.label] = {
      epochIdx: ep.epochIdx,
      abstain: ep.abstain,
      qualified: ep.qualified,
      chronoCvAuc: ep.chronoCvAuc ?? null,
      innerValPf: ep.innerValPf ?? null,
      innerValNetPct: ep.innerValNetPct ?? null,
      threshold: ep.modelSpec?.threshold ?? null,
      ...st,
    };
  }

  const mlOos60 = stripMonthly(summarizeSliceByTimeV14(simMl.trades, ds.rows, tOosStart, tEnd));
  const mlCalVal = stripMonthly(summarizeSliceByTimeV14(simMl.trades, ds.rows, t0, tValEnd));
  const mlY5 = stripMonthly(summarizeSliceByTimeV14(simMl.trades, ds.rows, tY5Start, tEnd));
  const mlFull = stripMonthly(summarizeSliceByTimeV14(simMl.trades, ds.rows, t0, tEnd));

  const baseOos60 = stripMonthly(summarizeSliceByTimeV14(simBase.trades, ds.rows, tOosStart, tEnd));
  const baseCalVal = stripMonthly(summarizeSliceByTimeV14(simBase.trades, ds.rows, t0, tValEnd));
  const baseY5 = stripMonthly(summarizeSliceByTimeV14(simBase.trades, ds.rows, tY5Start, tEnd));
  const baseFull = stripMonthly(summarizeSliceByTimeV14(simBase.trades, ds.rows, t0, tEnd));

  const mainEpochs = streamModelV14.epochs.filter(e => e.epochIdx >= 0);
  const activeEpochsCount = mainEpochs.filter(e => !e.abstain).length;
  const abstainedEpochsCount = mainEpochs.length - activeEpochsCount;

  return {
    id: streamKey,
    coin: `${streamKey.slice(0, 3)}USDT`,
    timeframe: streamKey.endsWith('_15m') ? '15m' : '1h',
    intervalSeconds,
    execProfile,
    bars: n,
    shortEnabled: structural.sigSpec.shortEnabled ?? true,
    activeEpochsCount,
    abstainedEpochsCount,
    liveActiveQualified: !(streamModelV14.liveActiveModel?.abstain ?? true),
    qualifiedForLive: activeEpochsCount >= 1 && (mlOos60.profitFactor ?? 0) >= 1.05,
    rows: ds.rows,
    trades: simMl.trades,
    baselineTrades: simBase.trades,
    epochBreakdown: epochStats,
    summary: {
      baseline: { calVal: baseCalVal, oosExpanding60pct: baseOos60, holdoutY5: baseY5, full5y: baseFull },
      ml: { calVal: mlCalVal, oosExpanding60pct: mlOos60, holdoutY5: mlY5, full5y: mlFull },
    },
  };
}

export function getV14CryptoStreams(execProfile = 'EXCHANGE_POST_ONLY') {
  const modelsJson = loadModelsV14();
  const breadth = buildCausalBreadthV9(null);
  const out = {};
  for (const sk of V14_STREAM_KEYS) {
    out[sk] = evaluateStreamV14(sk, modelsJson.models[sk], execProfile, breadth);
  }
  return out;
}

function sliceTradesWindowByTime(streamEntries, tMin, tMax) {
  return streamEntries.map(s => ({
    ...s,
    trades: s.trades.filter(t => {
      const startTime = s.rows[t.signalIndex ?? t.entryIndex].time;
      const exitTime = s.rows[t.exitIndex].time;
      return startTime >= tMin && exitTime < tMax;
    }),
  }));
}

function summarizePortfolioWindowV14(streamEntries, startTime, endTime, { levScale, maxTotalOpenLev, mmr = 0.005 }) {
  const guarded = applyCausalDdGuardV9(streamEntries, { levScale, maxTotalOpenLev });
  const simComp = simulatePortfolioV7(guarded.streams, { levScale, maxTotalOpenLev, mmr, monthlyReset: false });
  const simSweep = simulatePortfolioV7(guarded.streams, { levScale, maxTotalOpenLev, mmr, monthlyReset: true });

  const compCash = summarizeMonthlyCashflowV7(simComp.trades, { startTime, endTime: endTime - 1 });
  const sweepCash = summarizeMonthlyCashflowV7(simSweep.trades, { startTime, endTime: endTime - 1 });
  const years = (endTime - startTime) / (365.25 * 86400);
  const ratios = computeRatios(simComp.trades, compCash.cagrPct, compCash.maxCompoundedDdPct, years);

  return {
    count: compCash.count,
    winRatePct: r2(compCash.winRatePct),
    profitFactor: r2(compCash.profitFactor),
    meanMonthlySweepPct: r2(sweepCash.meanMonthlySweepPct),
    medianMonthlySweepPct: r2(sweepCash.medianMonthlySweepPct),
    pctPositiveMonths: r2(sweepCash.pctPositiveMonths),
    pctMonthsGe30: r2(sweepCash.pctMonthsGe30),
    worstMonthPct: r2(sweepCash.worstMonthPct),
    maxMonthlySweepDdPct: r2(sweepCash.maxMonthlySweepDdPct),
    compoundedNetPct: r2(compCash.compoundedNetPct),
    cagrPct: r2(compCash.cagrPct),
    geomMonthlyPct: r2(compCash.geomMonthlyPct),
    maxCompoundedDdPct: r2(compCash.maxCompoundedDdPct),
    ...ratios,
    ddGuardThrottledTrades: guarded.throttledTrades,
    liquidationCount: (simComp.liquidationCount ?? 0) + (simSweep.liquidationCount ?? 0),
  };
}

function buildCrossAssetFuturesOverlayV14(cryptoEntries, btc1hRows) {
  const modelsStocks = JSON.parse(fs.readFileSync(path.join(RESULTS_V6_DIR, 'models_stocks_v6.json'), 'utf8')).models;
  const macro = loadRawDataV14('equities10y_macro_1d.json');
  const dia = loadRawDataV14('equities10y_dow_1d.json');
  const qqq = loadRawDataV14('equities10y_nasdaq_1d.json');
  const aux = { macro, diaRows: dia.rows, qqqRows: qqq.rows };

  const futuresEntries = [];
  for (const [asset, futFile, sym] of [['SPY', 'equities2y_es_1h.json', 'ES=F'], ['QQQ', 'equities2y_nq_1h.json', 'NQ=F']]) {
    const ms = modelsStocks[asset];
    const futDs = loadRawDataV14(futFile);
    const regDaily = precomputeEquityRegimeV8({ rows: futDs.htf['1d'].rows }, macro);
    const rawFutSigs = generateFutures1hSignalsCausal(futDs, ms, aux).mlSignals.filter(s => {
      const dj = s.meta?.htfDailyIndex;
      if (!Number.isSafeInteger(dj) || dj < 0) return true;
      const r = regDaily.getRegimeAt(dj);
      if (s.side === 1 && r.regime === EQUITY_REGIMES_V8.BEAR_TREND) return false;
      if (s.side === -1 && r.regime !== EQUITY_REGIMES_V8.BEAR_TREND) return false;
      return true;
    });
    const futExec = {
      ...ms.execOptions,
      warmup: 0,
      cooldown: 18,
      limitExpiryBars: (ms.execOptions.limitExpiryBars ?? 2) * 23,
      maxHoldBars: (ms.execOptions.maxHoldBars ?? 10) * 23,
      tp1TriggerR: 0.65,
      tp1QtyPct: 50,
      tp1LockOffsetR: 0.30,
      rewardRisk: 1.15,
      beTriggerR: 0.38,
      beOffsetPct: 0.15,
      costPct: 0.04,
      slippagePct: 0.015,
      fundingPctPer8h: 0,
      allowTimeGaps: true,
    };
    const sim = simulateTradesV7(futDs.rows, rawFutSigs, { ...futExec, start: 0, end: futDs.rows.length });
    futuresEntries.push({ id: `${sym}_1h`, rows: futDs.rows, trades: sim.trades, intervalSeconds: 3600 });
  }

  const futMinT = Math.min(...futuresEntries.map(s => s.rows[0].time));
  const futMaxT = Math.max(...futuresEntries.map(s => s.rows[s.rows.length - 1].time)) + 3600;
  const y5StartTime = btc1hRows[Math.floor(0.80 * btc1hRows.length)].time;

  const combined2yEntries = [
    ...sliceTradesWindowByTime(cryptoEntries, futMinT, futMaxT),
    ...sliceTradesWindowByTime(futuresEntries, futMinT, futMaxT),
  ];
  const combinedY5Entries = [
    ...sliceTradesWindowByTime(cryptoEntries, y5StartTime, futMaxT),
    ...sliceTradesWindowByTime(futuresEntries, y5StartTime, futMaxT),
  ];

  return {
    overlap2y: summarizePortfolioWindowV14(combined2yEntries, futMinT, futMaxT, { levScale: 0.85, maxTotalOpenLev: 8.0, mmr: 0.005 }),
    overlapY5Bear: summarizePortfolioWindowV14(combinedY5Entries, y5StartTime, futMaxT, { levScale: 0.85, maxTotalOpenLev: 8.0, mmr: 0.005 }),
    futuresOnly2y: summarizePortfolioWindowV14(futuresEntries, futMinT, futMaxT, { levScale: 1.0, maxTotalOpenLev: 2.0, mmr: 0.005 }),
  };
}

export async function runExpandingWalkForwardV14({ profile = null, tier = null } = {}) {
  const modelsJson = loadModelsV14();
  const verifiedLockSha = verifyModelsLockV14(modelsJson);
  const breadthFull = buildCausalBreadthV9(null);

  const profilesToEval = profile ? [profile] : ['EXCHANGE_POST_ONLY', 'STRICT_TAKER'];
  const streamResults = {};
  const streamObjsByProf = {};
  for (const p of profilesToEval) streamObjsByProf[p] = [];

  for (const prof of profilesToEval) {
    for (const sk of V14_STREAM_KEYS) {
      const res = evaluateStreamV14(sk, modelsJson.models[sk], prof, breadthFull);
      const { rows, trades, baselineTrades, ...clean } = res;
      if (!streamResults[sk]) streamResults[sk] = {};
      streamResults[sk][prof] = clean;
      streamObjsByProf[prof].push(res);
    }
  }

  const btcRows = streamObjsByProf[profilesToEval[0]][0].rows;
  const n1h = btcRows.length;
  const tStart = btcRows[0].time;
  const tOosStart = btcRows[Math.floor(0.40 * n1h)].time;
  const tValEnd = btcRows[Math.floor(0.80 * n1h)].time;
  const tY5Start = tValEnd;
  const tEnd = btcRows[n1h - 1].time + 3600;

  const TIERS = {
    SAFE_V14: { label: 'TIER_1_SAFE_V14', maxCalValDd: 22.0, levGrid: [0.55, 0.70, 0.85, 1.00], capGrid: [6.0, 8.0, 10.0] },
    BALANCED_V14: { label: 'TIER_2_BALANCED_V14', maxCalValDd: 35.0, levGrid: [0.90, 1.10, 1.30, 1.50], capGrid: [8.0, 10.0, 12.0] },
    MAXIMIZED_V14: { label: 'TIER_3_MAXIMIZED_V14', maxCalValDd: 60.0, levGrid: [1.40, 1.75, 2.10, 2.40], capGrid: [10.0, 12.0, 14.0] },
  };
  const tierAliases = { SAFE_75WR: 'SAFE_V14', BALANCED_75WR: 'BALANCED_V14', MAXIMIZED_30MO_75WR: 'MAXIMIZED_V14' };
  const resolvedTier = tier ? (tierAliases[tier] ?? tier) : null;

  const primaryProf = profilesToEval.includes('EXCHANGE_POST_ONLY') ? 'EXCHANGE_POST_ONLY' : profilesToEval[0];
  const primaryEntries = streamObjsByProf[primaryProf];
  const entriesCV = sliceTradesWindowByTime(primaryEntries, tStart, tValEnd);

  const tierOut = {};
  for (const [tKey, tCfg] of Object.entries(TIERS)) {
    if (resolvedTier && resolvedTier !== tKey) continue;
    let bestParams = null;
    let bestScore = -Infinity;
    for (const levScale of tCfg.levGrid) {
      for (const maxTotalOpenLev of tCfg.capGrid) {
        const cv = summarizePortfolioWindowV14(entriesCV, tStart, tValEnd, { levScale, maxTotalOpenLev, mmr: 0.005 });
        if (cv.liquidationCount > 0 || (cv.maxCompoundedDdPct ?? 100) > tCfg.maxCalValDd) continue;
        const sc = (cv.meanMonthlySweepPct ?? 0) * 10 + (cv.calmar ?? 0) * 20;
        if (sc > bestScore) {
          bestScore = sc;
          bestParams = { levScale, maxTotalOpenLev };
        }
      }
    }
    if (!bestParams) bestParams = { levScale: tCfg.levGrid[0], maxTotalOpenLev: tCfg.capGrid[0] };

    const profiles = {};
    for (const prof of profilesToEval) {
      const entries = streamObjsByProf[prof];
      const winCV = sliceTradesWindowByTime(entries, tStart, tValEnd);
      const winOos60 = sliceTradesWindowByTime(entries, tOosStart, tEnd);
      const winY5 = sliceTradesWindowByTime(entries, tY5Start, tEnd);
      profiles[prof] = {
        calVal_49m: summarizePortfolioWindowV14(winCV, tStart, tValEnd, bestParams),
        oosExpanding60pct: summarizePortfolioWindowV14(winOos60, tOosStart, tEnd, bestParams),
        blindHoldoutY5_13m: summarizePortfolioWindowV14(winY5, tY5Start, tEnd, bestParams),
        full5y_61m: summarizePortfolioWindowV14(entries, tStart, tEnd, bestParams),
      };
    }

    tierOut[tKey] = {
      label: tCfg.label,
      activeStreams: V14_STREAM_KEYS.filter(sk => streamResults[sk][primaryProf].activeEpochsCount > 0),
      lockedParams: bestParams,
      profiles,
    };
  }

  const crossAssetAllWeather = buildCrossAssetFuturesOverlayV14(primaryEntries, btcRows);

  // Abstention summary across all 8 streams x 6 main epochs (48 stream-epochs)
  let totalMainEpochs = 0;
  let totalAbstainedEpochs = 0;
  for (const sk of V14_STREAM_KEYS) {
    const eps = modelsJson.models[sk].epochs.filter(e => e.epochIdx >= 0);
    totalMainEpochs += eps.length;
    totalAbstainedEpochs += eps.filter(e => e.abstain).length;
  }

  const summary = {
    schema: 'smc-v14-expanding-wf-v1',
    generatedAt: new Date().toISOString(),
    selectionLockSha256: verifiedLockSha,
    allStreamsCount: V14_STREAM_KEYS.length,
    abstentionSummary: {
      mainEpochsEvaluated: totalMainEpochs,
      abstainedEpochs: totalAbstainedEpochs,
      activeEpochs: totalMainEpochs - totalAbstainedEpochs,
      abstentionRatePct: r2((100 * totalAbstainedEpochs) / Math.max(1, totalMainEpochs)),
    },
    streams: streamResults,
    tiers: tierOut,
    crossAssetAllWeather,
  };

  if (!profile && !tier) {
    fs.mkdirSync(RESULTS_V14_DIR, { recursive: true });
    const outPath = path.join(RESULTS_V14_DIR, 'expanding_wf_v14_crypto_5y.json');
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');

    console.log(`\n[v14] Lock SHA-256 verified: ${verifiedLockSha.slice(0, 16)}...`);
    console.log(`[v14] Main Epochs Abstention: ${totalAbstainedEpochs}/${totalMainEpochs} (${summary.abstentionSummary.abstentionRatePct}% sat in cash)`);
    for (const sk of V14_STREAM_KEYS) {
      const r = streamResults[sk][primaryProf];
      const m = r.summary.ml;
      const b = r.summary.baseline;
      console.log(`  ${sk.padEnd(8)} [actEp=${r.activeEpochsCount}/6 live=${r.liveActiveQualified}] OOS60: n=${m.oosExpanding60pct.count} WR=${m.oosExpanding60pct.winRatePct}% PF=${m.oosExpanding60pct.profitFactor} Comp=${m.oosExpanding60pct.compoundedNetPct}% | Y5: n=${m.holdoutY5.count} WR=${m.holdoutY5.winRatePct}% PF=${m.holdoutY5.profitFactor} Comp=${m.holdoutY5.compoundedNetPct}% (Base Y5=${b.holdoutY5.compoundedNetPct}%) | 5Y: n=${m.full5y.count} WR=${m.full5y.winRatePct}% PF=${m.full5y.profitFactor} Comp=${m.full5y.compoundedNetPct}% DD=${m.full5y.maxCompoundedDdPct}%`);
    }
    for (const tv of Object.values(tierOut)) {
      const p = tv.profiles.EXCHANGE_POST_ONLY;
      const t = tv.profiles.STRICT_TAKER;
      console.log(`\n[${tv.label}] lev=${tv.lockedParams.levScale} maxLev=${tv.lockedParams.maxTotalOpenLev}`);
      console.log(`  POST_ONLY | CV: WR=${p.calVal_49m.winRatePct}% Mo=${p.calVal_49m.meanMonthlySweepPct}% DD=${p.calVal_49m.maxCompoundedDdPct}% | OOS60: WR=${p.oosExpanding60pct.winRatePct}% PF=${p.oosExpanding60pct.profitFactor} Comp=${p.oosExpanding60pct.compoundedNetPct}% | Y5: n=${p.blindHoldoutY5_13m.count} WR=${p.blindHoldoutY5_13m.winRatePct}% PF=${p.blindHoldoutY5_13m.profitFactor} Mo=${p.blindHoldoutY5_13m.meanMonthlySweepPct}% Comp=${p.blindHoldoutY5_13m.compoundedNetPct}% DD=${p.blindHoldoutY5_13m.maxCompoundedDdPct}% Liq=${p.blindHoldoutY5_13m.liquidationCount} | 5Y: WR=${p.full5y_61m.winRatePct}% PF=${p.full5y_61m.profitFactor} Mo=${p.full5y_61m.meanMonthlySweepPct}% Comp=${p.full5y_61m.compoundedNetPct}% DD=${p.full5y_61m.maxCompoundedDdPct}% Liq=${p.full5y_61m.liquidationCount}`);
      if (t) {
        console.log(`  TAKER     | Y5: n=${t.blindHoldoutY5_13m.count} WR=${t.blindHoldoutY5_13m.winRatePct}% PF=${t.blindHoldoutY5_13m.profitFactor} Mo=${t.blindHoldoutY5_13m.meanMonthlySweepPct}% Comp=${t.blindHoldoutY5_13m.compoundedNetPct}% | 5Y: WR=${t.full5y_61m.winRatePct}% PF=${t.full5y_61m.profitFactor} Mo=${t.full5y_61m.meanMonthlySweepPct}% Comp=${t.full5y_61m.compoundedNetPct}% DD=${t.full5y_61m.maxCompoundedDdPct}% Liq=${t.full5y_61m.liquidationCount}`);
      }
    }
    console.log(`\n[Cross-Asset All-Weather (v14 Expanding WF Crypto + ES=F/NQ=F Futures)]`);
    console.log(`  2Y Overlap: WR=${crossAssetAllWeather.overlap2y.winRatePct}% PF=${crossAssetAllWeather.overlap2y.profitFactor} Mo=${crossAssetAllWeather.overlap2y.meanMonthlySweepPct}% Comp=${crossAssetAllWeather.overlap2y.compoundedNetPct}% DD=${crossAssetAllWeather.overlap2y.maxCompoundedDdPct}% Liq=${crossAssetAllWeather.overlap2y.liquidationCount}`);
    console.log(`  Y5 Bear Overlap: WR=${crossAssetAllWeather.overlapY5Bear.winRatePct}% PF=${crossAssetAllWeather.overlapY5Bear.profitFactor} Mo=${crossAssetAllWeather.overlapY5Bear.meanMonthlySweepPct}% Comp=${crossAssetAllWeather.overlapY5Bear.compoundedNetPct}% DD=${crossAssetAllWeather.overlapY5Bear.maxCompoundedDdPct}% Liq=${crossAssetAllWeather.overlapY5Bear.liquidationCount}`);
    console.log(`[v14] Wrote ${path.relative(ROOT_DIR, outPath)}`);
  }

  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--extract-expanding')) {
    process.stdout.write(JSON.stringify(extractExpandingPayloadV14()));
  } else {
    runExpandingWalkForwardV14().catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}
