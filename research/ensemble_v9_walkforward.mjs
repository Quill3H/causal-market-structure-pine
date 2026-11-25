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
import { computeOhlcFeatures1h, generateSignals1h, sliceDatasetPrefix1h } from './signals_1h.mjs';
import { generateSignals15mV4, sliceDatasetPrefix15m } from './signals_15m_v4.mjs';
import {
  FEATURE_NAMES_V6,
  precomputeOrderflowContextV6,
  extractCandidateFeaturesV6,
  generateBtcSignalsV6,
  generateBnbSignalsV6,
} from './suite_v6_btc_bnb.mjs';
import {
  ETH_FEATURE_NAMES_V6,
  precomputeEthCrossContextV6,
  extractEthCandidateFeaturesV6,
  generateEthSignalsV6,
  generateSolSignalsV6,
} from './suite_v6_eth_sol.mjs';
import { precompute15mV7, generate15mSignalsV7 } from './high_wr_v7_btc_bnb.mjs';
import {
  CRYPTO_REGIMES_V8,
  EQUITY_REGIMES_V8,
  precomputeCryptoBreadthV8,
  precomputeAssetRegimeV8,
  precomputeEquityRegimeV8,
} from './regime_engine_v8.mjs';
import { precomputeStockContextV6, generateFutures1hSignalsCausal } from './suite_v6_stocks.mjs';
import { scoreCandidateV5 } from './ml_inference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V6_DIR = path.join(HERE, 'results_v6');
const RESULTS_V9_DIR = path.join(HERE, 'results_v9');

export const V9_STREAM_KEYS = Object.freeze([
  'BTC_1h',
  'BNB_1h',
  'SOL_1h',
  'ETH_1h',
  'BTC_15m',
  'BNB_15m',
  'SOL_15m',
  'ETH_15m',
]);

export const REGIME_FEATURE_NAMES_V9 = Object.freeze([
  'regime_trend_score',
  'd1_ema50_dist_atr',
  'd1_slope_atr',
  'breadth_bear_ratio',
  'h4_rally_exh',
]);

export const BASE_FEATURE_NAMES_V9 = Object.freeze([...FEATURE_NAMES_V6, ...REGIME_FEATURE_NAMES_V9]);
export const ETH_FEATURE_NAMES_V9 = Object.freeze([...ETH_FEATURE_NAMES_V6, ...REGIME_FEATURE_NAMES_V9]);

const DATASET_FILE_MAP = Object.freeze({
  BTC_1h: 'crypto5y_btcusdt_1h.json',
  BNB_1h: 'crypto5y_bnbusdt_1h.json',
  SOL_1h: 'crypto5y_solusdt_1h.json',
  ETH_1h: 'crypto5y_ethusdt_1h.json',
  BTC_15m: 'crypto5y_btcusdt_15m.json',
  BNB_15m: 'crypto5y_bnbusdt_15m.json',
  SOL_15m: 'crypto5y_solusdt_15m.json',
  ETH_15m: 'crypto5y_ethusdt_15m.json',
});

const BREADTH_1H_FILES = Object.freeze({
  BTCUSDT: 'crypto5y_btcusdt_1h.json',
  ETHUSDT: 'crypto5y_ethusdt_1h.json',
  SOLUSDT: 'crypto5y_solusdt_1h.json',
  BNBUSDT: 'crypto5y_bnbusdt_1h.json',
});

const rawJsonCache = new Map();

function loadRawCached(relOrDataFile, isData = true) {
  const fullPath = isData ? path.join(DATA_DIR, relOrDataFile) : relOrDataFile;
  let obj = rawJsonCache.get(fullPath);
  if (!obj) {
    obj = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    rawJsonCache.set(fullPath, obj);
  }
  return obj;
}

export function loadStreamDatasetV9(streamKey) {
  return loadRawCached(DATASET_FILE_MAP[streamKey], true);
}

export function sliceDatasetPrefixV9(dataset, endLength) {
  const sliced = dataset.intervalSeconds <= 900
    ? sliceDatasetPrefix15m(dataset, endLength)
    : sliceDatasetPrefix1h(dataset, endLength);
  if (Array.isArray(dataset.fundingRows)) {
    const lastTime = sliced.lastTime;
    sliced.fundingRows = dataset.fundingRows.filter(f => f.time <= lastTime);
  }
  return sliced;
}

export function sliceByMaxTimeV9(dataset, maxTimeSec) {
  if (maxTimeSec === null || maxTimeSec === undefined) return dataset;
  const rows = dataset.rows;
  let cutLen = 0;
  while (cutLen < rows.length && rows[cutLen].time <= maxTimeSec) cutLen++;
  cutLen = Math.max(1, cutLen);
  return cutLen === rows.length ? dataset : sliceDatasetPrefixV9(dataset, cutLen);
}

export function buildCausalBreadthV9(maxTimeSec = null) {
  const byCoin = {};
  for (const [coin, fileName] of Object.entries(BREADTH_1H_FILES)) {
    byCoin[coin] = sliceByMaxTimeV9(loadRawCached(fileName, true), maxTimeSec);
  }
  return precomputeCryptoBreadthV8(byCoin);
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

export function computeLockSha256V9(modelsObj) {
  return crypto.createHash('sha256').update(canonicalStringify(modelsObj)).digest('hex');
}

export function verifyModelsLockV9(modelsJson) {
  assert.ok(modelsJson && modelsJson.models && modelsJson.selectionLockSha256, 'Missing v9 selectionLockSha256');
  const recomputed = computeLockSha256V9(modelsJson.models);
  assert.equal(
    recomputed,
    modelsJson.selectionLockSha256,
    `v9 model lock SHA-256 mismatch: expected ${modelsJson.selectionLockSha256}, got ${recomputed}`,
  );
  return recomputed;
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

function summarizeSliceV9(trades, rows, lo, hi, sideFilter = null) {
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

function stripMonthly(m) {
  const { monthlyTable, ...rest } = m;
  return rest;
}

function buildFeatureNamesForStream(streamKey) {
  return streamKey.startsWith('ETH') ? ETH_FEATURE_NAMES_V9 : BASE_FEATURE_NAMES_V9;
}

export function precomputeFeatureContextV9(streamKey, ds, alignedFunding, regimeCtx, maxTimeSec = null) {
  const ofCtx = precomputeOrderflowContextV6(ds, alignedFunding);
  let ethCrossCtx = null;
  let btcDs = null;
  if (streamKey.startsWith('ETH')) {
    const btcRaw = loadStreamDatasetV9(streamKey.endsWith('_15m') ? 'BTC_15m' : 'BTC_1h');
    btcDs = sliceByMaxTimeV9(btcRaw, maxTimeSec ?? ds.rows[ds.rows.length - 1].time);
    ethCrossCtx = precomputeEthCrossContextV6(ds, btcDs, alignedFunding);
  }
  return { ofCtx, ethCrossCtx, btcDs, regimeCtx };
}

export function extractCandidateFeaturesV9(streamKey, ds, signal, barIdx, alignedFunding, ctx) {
  const base = streamKey.startsWith('ETH')
    ? extractEthCandidateFeaturesV6(ds, ctx.btcDs, signal, barIdx, alignedFunding, ctx.ethCrossCtx)
    : extractCandidateFeaturesV6(ds, signal, barIdx, alignedFunding, ctx.ofCtx);
  const reg = ctx.regimeCtx.getRegimeAt(barIdx);
  return {
    ...base,
    regime_trend_score: reg.trendScore,
    d1_ema50_dist_atr: reg.d1Ema50DistAtr,
    d1_slope_atr: reg.d1SlopeAtr,
    breadth_bear_ratio: reg.breadthBearRatio,
    h4_rally_exh: reg.h4RallyExh,
  };
}

export function generateStreamSignalsV9(streamKey, ds, sigSpec, alignedFunding, regimeCtx, btcDs = null, pre = null) {
  const is15m = streamKey.endsWith('_15m');
  let raw = [];

  if (!is15m) {
    const pre1h = pre ?? {
      f1: computeOhlcFeatures1h(ds.rows),
      f4: computeOhlcFeatures1h(ds.htf['4h'].rows),
      fD: ds.htf['1d'] ? computeOhlcFeatures1h(ds.htf['1d'].rows) : null,
      rawSignalsByKey: new Map(),
      virtTradesByKey: new Map(),
    };
    if (streamKey === 'BTC_1h') {
      raw = generateBtcSignalsV6(ds, sigSpec.genSpec, pre1h);
    } else if (streamKey === 'BNB_1h') {
      raw = generateBnbSignalsV6(ds, sigSpec.genSpec, alignedFunding);
    } else if (streamKey === 'ETH_1h') {
      raw = generateEthSignalsV6(ds, btcDs, sigSpec.genSpec, pre1h.f1);
    } else if (streamKey === 'SOL_1h') {
      raw = sigSpec.genSpec.genKind === '1h_MultiTrap'
        ? generateSignals1h(ds, sigSpec.genSpec, pre1h)
        : generateSolSignalsV6(ds, sigSpec.genSpec, { f1: pre1h.f1, f4: pre1h.f4 });
    }
  } else {
    const pre15 = pre ?? precompute15mV7(ds);
    if (sigSpec.genSpec.kind === 'H1_CleanDisp_OF') {
      raw = generate15mSignalsV7(ds, { ...sigSpec.genSpec, family: 'H1_CleanDisp_OF' }, pre15);
    } else {
      raw = generateSignals15mV4(ds, sigSpec.genSpec, pre15);
    }
  }

  const dirMode = sigSpec.dirMode ?? 'NO_SQUEEZE';
  const shortEnabled = sigSpec.shortEnabled ?? true;
  const chopMult = sigSpec.chopSizeMult ?? 0.70;

  const out = [];
  for (const s of raw) {
    const r = regimeCtx.regime[s.barIndex];
    if (s.side === -1 && !shortEnabled) continue;
    // Always block chasing Shorts during violent BEAR_SQUEEZE rallies
    if (s.side === -1 && r === CRYPTO_REGIMES_V8.BEAR_SQUEEZE) continue;

    if (dirMode === 'BULL_BEAR_GATE') {
      if (r === CRYPTO_REGIMES_V8.BEAR_TREND && s.side === 1) continue;
      if (r === CRYPTO_REGIMES_V8.BEAR_SQUEEZE && s.side === 1) continue;
      if (r === CRYPTO_REGIMES_V8.BULL_TREND && s.side === -1) continue;
      if (r === CRYPTO_REGIMES_V8.RANGE_CHOP) {
        if (s.side === -1) continue;
        out.push({ ...s, baseSizeMult: chopMult, regime: r });
      } else {
        out.push({ ...s, baseSizeMult: 1.0, regime: r });
      }
    } else {
      // NO_SQUEEZE (Regime-Protected Adaptive / Asset Mode): throttle RANGE_CHOP, keep BEAR_SQUEEZE 0x Shorts
      const mult = r === CRYPTO_REGIMES_V8.RANGE_CHOP ? chopMult : 1.0;
      out.push({ ...s, baseSizeMult: mult, regime: r });
    }
  }
  return out;
}

function buildBarbellCatalogV9(streamKey, dsCV, pre1hOr15, btcDsCV) {
  const is15m = streamKey.endsWith('_15m');
  const coin = streamKey.slice(0, 3);
  const specs = [];

  if (!is15m) {
    // Barbell payoffs strictly avoiding the 0.48R-0.58R early TP1 asymmetry trap
    const exits = [
      { tag: 'V6_RR1.25_BE', rewardRisk: 1.25, beTriggerR: 0.43, beOffsetPct: 0.40, tp1TriggerR: 0, tp1QtyPct: 0, tp1LockOffsetR: 0 },
      { tag: 'V6_RR1.35_BE', rewardRisk: 1.35, beTriggerR: 0.44, beOffsetPct: 0.40, tp1TriggerR: 0, tp1QtyPct: 0, tp1LockOffsetR: 0 },
      { tag: 'LateTP0.88_RR1.60', rewardRisk: 1.60, beTriggerR: 0.43, beOffsetPct: 0.36, tp1TriggerR: 0.88, tp1QtyPct: 45, tp1LockOffsetR: 0.45 },
    ];
    const stopAtr = coin === 'BTC' ? 3.2 : (coin === 'BNB' ? 3.4 : (coin === 'ETH' ? 2.2 : 2.4));
    const minStopPct = (coin === 'BTC' || coin === 'BNB') ? 1.4 : 1.6;
    const riskPct = coin === 'BTC' ? 4.5 : (coin === 'BNB' ? 3.5 : 4.0);
    const maxLev = coin === 'BTC' ? 2.8 : 2.5;
    const minLev = coin === 'BTC' ? 1.4 : 1.0;

    for (const dirMode of ['NO_SQUEEZE', 'BULL_BEAR_GATE']) {
      for (const ex of exits) {
        const baseExec = {
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
          volNormRiskPct: riskPct,
          minLev,
          maxLev,
        };

        let genList = [];
        if (coin === 'BTC') {
          genList = [
            ['Adp_H4_50', { family: 'AdaptiveTrapPolarity', baseFamily: 'HtfSmcMultiTrap', lookback: 20, trapMaxBars: 4, p4Lookback: 10, includePdhl: true, htfMode: 'H4_50', limitOffsetAtr: 0.18, winLen: 6, slThresh: 2, requireNegNet: true, virtExec: baseExec }],
            ['Raw_H4_50', { family: 'AdaptiveTrapPolarity', baseFamily: 'HtfSmcMultiTrap', lookback: 20, trapMaxBars: 4, p4Lookback: 10, includePdhl: true, htfMode: 'H4_50', limitOffsetAtr: 0.18, winLen: 99, slThresh: 99, requireNegNet: true, virtExec: baseExec }],
          ];
        } else if (coin === 'BNB') {
          genList = [
            ['Adp_H4_20', { family: 'AdaptiveTrapPolarity', baseFamily: 'HtfSmcMultiTrap', lookback: 20, trapMaxBars: 4, p4Lookback: 10, includePdhl: true, htfMode: 'H4_20', limitOffsetAtr: 0.22, winLen: 6, slThresh: 2, requireNegNet: true, useLaunchpoolSqueeze: false, virtExec: baseExec }],
            ['Adp_H4_50_lp1', { family: 'AdaptiveTrapPolarity', baseFamily: 'HtfSmcMultiTrap', lookback: 20, trapMaxBars: 4, p4Lookback: 10, includePdhl: true, htfMode: 'H4_50', limitOffsetAtr: 0.22, winLen: 6, slThresh: 2, requireNegNet: true, useLaunchpoolSqueeze: true, launchpoolFundingThresh: -0.0001, virtExec: baseExec }],
          ];
        } else if (coin === 'ETH') {
          genList = [
            ['H4_20_K3', { family: 'HtfSmcMultiTrap', lookback: 20, trapMaxBars: 3, p4Lookback: 10, includePdhl: true, htfMode: 'H4_20', limitOffsetAtr: 0.22, warmup: 250 }],
            ['H4_2050_K3', { family: 'HtfSmcMultiTrap', lookback: 20, trapMaxBars: 3, p4Lookback: 10, includePdhl: true, htfMode: 'H4_20_or_50', limitOffsetAtr: 0.22, warmup: 250 }],
          ];
        } else {
          genList = [
            ['TrendPbThrust', { mode: 'TrendPbThrust', limitOffsetAtr: 0.35, thrustMin: 0.55, pbTouchAtr: 0.35, pbBodyAtr: 0.35, warmup: 250 }],
            ['HybridSol', { mode: 'HybridSol', limitOffsetAtr: 0.30, thrustMin: 0.55, pbTouchAtr: 0.35, pbBodyAtr: 0.35, squeezeRatio: 0.92, sqLookback: 14, sqRvolMin: 1.1, warmup: 250 }],
          ];
        }

        for (const [gTag, genSpec] of genList) {
          const specId = `${streamKey}_V9_${gTag}_${dirMode}_${ex.tag}`;
          specs.push({
            id: specId,
            sigSpec: { specId, genSpec, dirMode, chopSizeMult: 0.70, shortEnabled: true },
            execOptions: baseExec,
          });
        }
      }
    }
  } else {
    const exits15 = [
      { tag: 'V6_RR1.35_BE', rewardRisk: 1.35, beTriggerR: 0.43, beOffsetPct: 0.35, tp1TriggerR: 0, tp1QtyPct: 0, tp1LockOffsetR: 0 },
      { tag: 'LateTP0.88_RR1.65', rewardRisk: 1.65, beTriggerR: 0.43, beOffsetPct: 0.35, tp1TriggerR: 0.88, tp1QtyPct: 45, tp1LockOffsetR: 0.45 },
    ];
    for (const dirMode of ['BULL_BEAR_GATE', 'NO_SQUEEZE']) {
      for (const [stopAtr, minStopPct] of [[4.5, 1.35], [5.0, 1.45]]) {
        for (const ex of exits15) {
          const baseExec = {
            entryMode: 'LIMIT_PULLBACK',
            limitExpiryBars: 10,
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
          const gens15 = [
            ['Sync2050', { rawFamily: 'M15_H1SyncedMultiTrap', h1Lookback: 20, h4Lookback: 10, include24h: true, trapMaxBars: 4, htfMode: 'H4_20_or_50', minAtrPct: 0.14, pullAtr: 0.22, adaptive: false }],
            ['H4Disp_Adp', { rawFamily: 'M15_H4Disp', h4BodyAtrMin: 0.85, h4ClosePosMin: 0.58, onH4CloseOnly: true, htfMode: 'H4_50', minAtrPct: 0.14, pullAtr: 0.35, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true, virtExec: baseExec }],
          ];
          for (const [gTag, genSpec] of gens15) {
            const specId = `${streamKey}_V9_${gTag}_${dirMode}_s${stopAtr}_${ex.tag}`;
            specs.push({
              id: specId,
              sigSpec: { specId, genSpec, dirMode, chopSizeMult: 0.70, shortEnabled: true },
              execOptions: baseExec,
            });
          }
        }
      }
    }
  }
  return specs;
}

function calibrateStructuralV9(streamKey, dsCV, alignedFundingCV, regimeCV, btcDsCV) {
  const is15m = streamKey.endsWith('_15m');
  const n = dsCV.rows.length;
  const nFullEst = Math.round(n / 0.80);
  const f1End = Math.floor(0.20 * nFullEst);
  const f2End = Math.floor(0.50 * nFullEst);
  const f3End = n;

  const pre = is15m
    ? precompute15mV7(dsCV)
    : {
        f1: computeOhlcFeatures1h(dsCV.rows),
        f4: computeOhlcFeatures1h(dsCV.htf['4h'].rows),
        fD: dsCV.htf['1d'] ? computeOhlcFeatures1h(dsCV.htf['1d'].rows) : null,
        rawSignalsByKey: new Map(),
        virtTradesByKey: new Map(),
      };

  const catalog = buildBarbellCatalogV9(streamKey, dsCV, pre, btcDsCV);
  let best = null;

  for (const cand of catalog) {
    // Generate full bidirectional signals first, then evaluate Bear-Fold Short gate strictly inside [0..80%)
    const sigsBidirectional = generateStreamSignalsV9(streamKey, dsCV, cand.sigSpec, alignedFundingCV, regimeCV, btcDsCV, pre);
    const simBi = simulateTradesV7(dsCV.rows, sigsBidirectional, {
      ...cand.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      start: 0,
      end: n,
      intervalSeconds: dsCV.intervalSeconds,
    });
    const sF1 = summarizeSliceV9(simBi.trades, dsCV.rows, 0, f1End, -1);
    const sCV = summarizeSliceV9(simBi.trades, dsCV.rows, 0, f3End, -1);
    const shortPassesBearGate = (sF1.count >= 8 ? sF1.profitFactor >= 1.10 : true) && (sCV.profitFactor ?? 0) >= 1.05;

    const finalCand = shortPassesBearGate
      ? cand
      : {
          ...cand,
          id: cand.id + '_LongOnly',
          sigSpec: { ...cand.sigSpec, specId: cand.sigSpec.specId + '_LongOnly', shortEnabled: false },
        };

    const sim = shortPassesBearGate
      ? simBi
      : simulateTradesV7(
          dsCV.rows,
          generateStreamSignalsV9(streamKey, dsCV, finalCand.sigSpec, alignedFundingCV, regimeCV, btcDsCV, pre),
          {
            ...finalCand.execOptions,
            execProfile: 'EXCHANGE_POST_ONLY',
            fundingRows: dsCV.fundingRows,
            fundingPctPer8h: 0.01,
            isolatedLiqCheck: true,
            start: 0,
            end: n,
            intervalSeconds: dsCV.intervalSeconds,
          },
        );

    const mF1 = summarizeSliceV9(sim.trades, dsCV.rows, 0, f1End);
    const mF2 = summarizeSliceV9(sim.trades, dsCV.rows, f1End, f2End);
    const mF3 = summarizeSliceV9(sim.trades, dsCV.rows, f2End, f3End);
    const mCV = summarizeSliceV9(sim.trades, dsCV.rows, 0, f3End);

    const minTotal = is15m ? 140 : 110;
    const minFoldPF = Math.min(mF1.profitFactor ?? 0, mF2.profitFactor ?? 0, mF3.profitFactor ?? 0);
    const all3FoldsOk = (mCV.count ?? 0) >= minTotal
      && (mF1.profitFactor ?? 0) >= 1.05
      && (mF2.profitFactor ?? 0) >= 1.15
      && (mF3.profitFactor ?? 0) >= 1.25
      && (mCV.winRatePct ?? 0) >= 70.0
      && (mCV.liquidationCount ?? 0) === 0;
    const positiveCV = (mCV.count ?? 0) >= minTotal && (mCV.profitFactor ?? 0) >= 1.15 && (mCV.liquidationCount ?? 0) === 0;
    const calmar = (mCV.maxCompoundedDdPct ?? 100) > 1e-6 ? (mCV.compoundedNetPct ?? 0) / mCV.maxCompoundedDdPct : 0;

    const score = (all3FoldsOk ? 10000 : 0)
      + (positiveCV ? 2000 : 0)
      + minFoldPF * 120
      + calmar * 25
      + (mCV.profitFactor ?? 0) * 60
      + (mCV.winRatePct ?? 0) * 1.5;

    if (!best || score > best.score) {
      best = { score, all3FoldsOk, shortPassesBearGate, cand: finalCand };
    }
  }
  return best.cand;
}

export function applyV9ModelToSignals(streamKey, ds, signals, alignedFunding, regimeCtx, modelSpec, maxTimeSec = null) {
  const fCtx = precomputeFeatureContextV9(streamKey, ds, alignedFunding, regimeCtx, maxTimeSec);
  const filtered = [];
  for (const s of signals) {
    const f = extractCandidateFeaturesV9(streamKey, ds, s, s.barIndex, alignedFunding, fCtx);
    const sc = scoreCandidateV5(f, modelSpec);
    if (!sc.pass) continue;
    const baseMult = s.baseSizeMult ?? 1.0;
    const sizeMult = Math.max(0.45, Math.min(1.45, sc.sizeMult * baseMult));
    filtered.push({
      ...s,
      sizeMult,
      meta: { ...(s.meta ?? {}), probWin: sc.probWin, sizeMult, regime: s.regime },
    });
  }
  return filtered;
}

function extractCalValPayloadV9() {
  const btc1h = loadStreamDatasetV9('BTC_1h');
  const valEnd1h = Math.floor(0.80 * btc1h.rows.length);
  const maxTimeSecCV = btc1h.rows[valEnd1h - 1].time;
  const breadthCV = buildCausalBreadthV9(maxTimeSecCV);

  const out = {};
  for (const streamKey of V9_STREAM_KEYS) {
    const full = loadStreamDatasetV9(streamKey);
    const n = full.rows.length;
    const f1End = Math.floor(0.20 * n);
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);

    const dsCV = sliceDatasetPrefixV9(full, valEnd);
    const alignedFundingCV = alignFundingToBarsCausal(dsCV.rows, dsCV.fundingRows ?? []);
    const regimeCV = precomputeAssetRegimeV8(dsCV, breadthCV);
    const btcDsCV = streamKey.startsWith('ETH')
      ? sliceByMaxTimeV9(loadStreamDatasetV9(streamKey.endsWith('_15m') ? 'BTC_15m' : 'BTC_1h'), dsCV.rows[dsCV.rows.length - 1].time)
      : null;

    const structural = calibrateStructuralV9(streamKey, dsCV, alignedFundingCV, regimeCV, btcDsCV);
    const baseSignals = generateStreamSignalsV9(streamKey, dsCV, structural.sigSpec, alignedFundingCV, regimeCV, btcDsCV);

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

    const fCtxCV = precomputeFeatureContextV9(streamKey, dsCV, alignedFundingCV, regimeCV, dsCV.rows[dsCV.rows.length - 1].time);
    const featureNames = buildFeatureNamesForStream(streamKey);

    const sigFeatures = [];
    const calSequential = [];
    const valSequential = [];

    for (let k = 0; k < baseSignals.length; k++) {
      const s = baseSignals[k];
      const fMap = extractCandidateFeaturesV9(streamKey, dsCV, s, s.barIndex, alignedFundingCV, fCtxCV);
      const vec = featureNames.map(fn => (Number.isFinite(fMap[fn]) ? fMap[fn] : null));
      sigFeatures.push({ barIndex: s.barIndex, side: s.side, features: vec });

      const t = tradeByBar.get(s.barIndex);
      if (!t) continue;
      const rec = { idx: k, barIndex: s.barIndex, side: s.side, y: t.netPct > 0 ? 1 : 0, netPct: t.netPct };
      if (s.barIndex < calEnd && t.exitIndex < calEnd) calSequential.push(rec);
      else if (s.barIndex >= calEnd && s.barIndex < valEnd && t.exitIndex < valEnd) valSequential.push(rec);
    }

    out[streamKey] = {
      streamKey,
      totalBarsFull: n,
      f1End,
      calEnd,
      valEnd,
      intervalSeconds: full.intervalSeconds,
      featureNames,
      structuralSpec: structural,
      signals: sigFeatures,
      calSequential,
      valSequential,
      baseF1: stripMonthly(summarizeSliceV9(simCV.trades, dsCV.rows, 0, f1End)),
      baseF2: stripMonthly(summarizeSliceV9(simCV.trades, dsCV.rows, f1End, calEnd)),
      baseF3: stripMonthly(summarizeSliceV9(simCV.trades, dsCV.rows, calEnd, valEnd)),
      baseCV: stripMonthly(summarizeSliceV9(simCV.trades, dsCV.rows, 0, valEnd)),
    };
  }
  return out;
}

function evalFoldsBatchV9(req) {
  const btc1h = loadStreamDatasetV9('BTC_1h');
  const valEnd1h = Math.floor(0.80 * btc1h.rows.length);
  const breadthCV = buildCausalBreadthV9(btc1h.rows[valEnd1h - 1].time);

  const out = {};
  for (const streamKey of V9_STREAM_KEYS) {
    const full = loadStreamDatasetV9(streamKey);
    const n = full.rows.length;
    const f1End = Math.floor(0.20 * n);
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV9(full, valEnd);
    const alignedFundingCV = alignFundingToBarsCausal(dsCV.rows, dsCV.fundingRows ?? []);
    const regimeCV = precomputeAssetRegimeV8(dsCV, breadthCV);
    const btcDsCV = streamKey.startsWith('ETH')
      ? sliceByMaxTimeV9(loadStreamDatasetV9(streamKey.endsWith('_15m') ? 'BTC_15m' : 'BTC_1h'), dsCV.rows[dsCV.rows.length - 1].time)
      : null;

    const payload = req[streamKey];
    const structural = payload.structuralSpec;
    const baseSignals = generateStreamSignalsV9(streamKey, dsCV, structural.sigSpec, alignedFundingCV, regimeCV, btcDsCV);
    const execOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      intervalSeconds: dsCV.intervalSeconds,
    };

    const cache = new Map();
    const results = [];
    for (const cand of payload.items) {
      const filtered = [];
      const keyParts = [];
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
          filtered.push({ ...s, sizeMult: Math.max(0.45, Math.min(1.45, sizeMult * (s.baseSizeMult ?? 1.0))) });
          if (isFlat) keyParts.push(k);
        }
      }

      let foldMetrics;
      const cKey = isFlat ? keyParts.join(',') : null;
      if (cKey && cache.has(cKey)) {
        foldMetrics = cache.get(cKey);
      } else {
        const sim = simulateTradesV7(dsCV.rows, filtered, { ...execOpts, start: 0, end: valEnd });
        foldMetrics = {
          f1: stripMonthly(summarizeSliceV9(sim.trades, dsCV.rows, 0, f1End)),
          f2: stripMonthly(summarizeSliceV9(sim.trades, dsCV.rows, f1End, calEnd)),
          f3: stripMonthly(summarizeSliceV9(sim.trades, dsCV.rows, calEnd, valEnd)),
          cv: stripMonthly(summarizeSliceV9(sim.trades, dsCV.rows, 0, valEnd)),
        };
        if (cKey) cache.set(cKey, foldMetrics);
      }
      results.push({ id: cand.id, ...foldMetrics });
    }
    out[streamKey] = results;
  }
  return out;
}

export function evaluateStreamV9(streamKey, modelSpec, execProfile = 'EXCHANGE_POST_ONLY', breadthCtx = null) {
  const ds = loadStreamDatasetV9(streamKey);
  const n = ds.rows.length;
  const f1End = Math.floor(0.20 * n);
  const calEnd = Math.floor(0.50 * n);
  const valEnd = Math.floor(0.80 * n);

  const alignedFunding = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
  const breadth = breadthCtx ?? buildCausalBreadthV9(ds.rows[n - 1].time);
  const regimeCtx = precomputeAssetRegimeV8(ds, breadth);
  const btcDs = streamKey.startsWith('ETH')
    ? sliceByMaxTimeV9(loadStreamDatasetV9(streamKey.endsWith('_15m') ? 'BTC_15m' : 'BTC_1h'), ds.rows[n - 1].time)
    : null;

  const structural = modelSpec.structuralSpec;
  const rawSignals = generateStreamSignalsV9(streamKey, ds, structural.sigSpec, alignedFunding, regimeCtx, btcDs);
  const mlSignals = applyV9ModelToSignals(streamKey, ds, rawSignals, alignedFunding, regimeCtx, modelSpec, ds.rows[n - 1].time);

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

  const f1 = stripMonthly(summarizeSliceV9(simMl.trades, ds.rows, 0, f1End));
  const f2 = stripMonthly(summarizeSliceV9(simMl.trades, ds.rows, f1End, calEnd));
  const f3 = stripMonthly(summarizeSliceV9(simMl.trades, ds.rows, calEnd, valEnd));
  const calVal = stripMonthly(summarizeSliceV9(simMl.trades, ds.rows, 0, valEnd));
  const holdoutY5 = stripMonthly(summarizeSliceV9(simMl.trades, ds.rows, valEnd, n));
  const full5y = stripMonthly(summarizeSliceV9(simMl.trades, ds.rows, 0, n));

  const qualifiedForLive = (f1.profitFactor ?? 0) >= 1.05
    && (f2.profitFactor ?? 0) >= 1.15
    && (f3.profitFactor ?? 0) >= 1.25
    && (calVal.winRatePct ?? 0) >= 70.0
    && (calVal.liquidationCount ?? 0) === 0;

  return {
    id: streamKey,
    coin: `${streamKey.slice(0, 3)}USDT`,
    timeframe: streamKey.endsWith('_15m') ? '15m' : '1h',
    execProfile,
    bars: n,
    splits: { f1Bear: [0, f1End], f2Recov: [f1End, calEnd], f3Val: [calEnd, valEnd], holdoutY5: [valEnd, n] },
    shortEnabled: structural.sigSpec.shortEnabled ?? true,
    rows: ds.rows,
    trades: simMl.trades,
    baselineTrades: simBase.trades,
    qualifiedForLive,
    foldSummary: { f1Bear2022: f1, f2Recov2023: f2, f3Val: f3 },
    summary: {
      baseline: {
        calVal: stripMonthly(summarizeSliceV9(simBase.trades, ds.rows, 0, valEnd)),
        holdoutY5: stripMonthly(summarizeSliceV9(simBase.trades, ds.rows, valEnd, n)),
        full5y: stripMonthly(summarizeSliceV9(simBase.trades, ds.rows, 0, n)),
      },
      ml: { calVal, holdoutY5, full5y, ...({ f1Bear2022: f1, f2Recov2023: f2, f3Val: f3 }) },
    },
  };
}

export function getV9CryptoStreams(execProfile = 'EXCHANGE_POST_ONLY') {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V9_DIR, 'models_v9_crypto.json'), 'utf8'));
  verifyModelsLockV9(modelsJson);
  const breadth = buildCausalBreadthV9(null);
  const out = {};
  for (const sk of V9_STREAM_KEYS) {
    out[sk] = evaluateStreamV9(sk, modelsJson.models[sk], execProfile, breadth);
  }
  return out;
}

/**
 * Strictly causal Closed-Trade Equity-Curve DD Guard:
 * Only reads trades whose exitTime <= newTrade.entryTime.
 * If closed-trade compounded DD > ddTriggerPct (15%), scales new trade lev/net by ddScale (0.70x)
 * until closed-trade compounded DD recovers < ddRecoverPct (8%).
 */
export function applyCausalDdGuardV9(streamEntries, {
  levScale = 1.0,
  maxTotalOpenLev = 10.0,
  ddTriggerPct = 15.0,
  ddRecoverPct = 8.0,
  ddScale = 0.70,
} = {}) {
  const indexed = [];
  for (let sIdx = 0; sIdx < streamEntries.length; sIdx++) {
    const st = streamEntries[sIdx];
    const intervalSeconds = st.intervalSeconds ?? 3600;
    for (let tIdx = 0; tIdx < st.trades.length; tIdx++) {
      const tr = st.trades[tIdx];
      indexed.push({
        sIdx,
        tIdx,
        entryTime: st.rows[tr.entryIndex].time,
        exitTime: st.rows[tr.exitIndex].time + intervalSeconds,
        tr,
      });
    }
  }
  indexed.sort((a, b) => a.entryTime - b.entryTime || a.sIdx - b.sIdx || a.tIdx - b.tIdx);

  const clonedTradesByStream = streamEntries.map(s => new Array(s.trades.length));
  const openQueue = [];
  let closedEq = 1.0;
  let peakEq = 1.0;
  let guardActive = false;
  let throttledTrades = 0;

  const settleUpTo = (tNow) => {
    for (let i = openQueue.length - 1; i >= 0; i--) {
      if (openQueue[i].exitTime <= tNow) {
        const done = openQueue.splice(i, 1)[0];
        closedEq = Math.max(0, closedEq * (1 + done.scaledNetPct / 100));
        if (closedEq > peakEq) peakEq = closedEq;
      }
    }
    const ddPct = peakEq > 0 ? ((peakEq - closedEq) / peakEq) * 100 : 0;
    if (!guardActive && ddPct > ddTriggerPct) guardActive = true;
    else if (guardActive && ddPct < ddRecoverPct) guardActive = false;
  };

  for (const item of indexed) {
    settleUpTo(item.entryTime);
    const mult = guardActive ? ddScale : 1.0;
    if (guardActive) throttledTrades++;

    const t = item.tr;
    const baseLev = t.lev ?? 1.0;
    const requestedLev = baseLev * mult * levScale;
    const cappedScale = requestedLev > maxTotalOpenLev && requestedLev > 0
      ? (maxTotalOpenLev / requestedLev) * levScale
      : levScale;
    const scaledNetPct = t.netPct * mult * cappedScale;

    clonedTradesByStream[item.sIdx][item.tIdx] = {
      ...t,
      lev: baseLev * mult,
      netPct: t.netPct * mult,
      grossPct: t.grossPct * mult,
      fundingDragPct: (t.fundingDragPct ?? 0) * mult,
      ddGuardMult: mult,
    };
    openQueue.push({ exitTime: item.exitTime, scaledNetPct });
  }

  return {
    throttledTrades,
    streams: streamEntries.map((s, idx) => ({ ...s, trades: clonedTradesByStream[idx] })),
  };
}

function sliceTradesWindowByTime(streamEntries, tMin, tMax) {
  return streamEntries.map(s => ({
    ...s,
    trades: s.trades.filter(t => {
      const startTime = s.rows[t.signalIndex ?? t.entryIndex].time;
      const exitTime = s.rows[t.exitIndex].time;
      return startTime >= tMin && exitTime <= tMax;
    }),
  }));
}

function summarizePortfolioWindow(streamEntries, startTime, endTime, { levScale, maxTotalOpenLev, mmr = 0.005 }) {
  const guarded = applyCausalDdGuardV9(streamEntries, { levScale, maxTotalOpenLev });
  const simComp = simulatePortfolioV7(guarded.streams, { levScale, maxTotalOpenLev, mmr, monthlyReset: false });
  const simSweep = simulatePortfolioV7(guarded.streams, { levScale, maxTotalOpenLev, mmr, monthlyReset: true });

  const compCash = summarizeMonthlyCashflowV7(simComp.trades, { startTime, endTime });
  const sweepCash = summarizeMonthlyCashflowV7(simSweep.trades, { startTime, endTime });
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
    monthlyTable: sweepCash.monthlyTable,
  };
}

function buildCrossAssetFuturesOverlay(qualifiedStreams, btc1hRows) {
  const modelsStocks = JSON.parse(fs.readFileSync(path.join(RESULTS_V6_DIR, 'models_stocks_v6.json'), 'utf8')).models;
  const macro = loadRawCached('equities10y_macro_1d.json', true);
  const dia = loadRawCached('equities10y_dow_1d.json', true);
  const qqq = loadRawCached('equities10y_nasdaq_1d.json', true);
  const aux = { macro, diaRows: dia.rows, qqqRows: qqq.rows };

  const futuresEntries = [];
  for (const [asset, futFile, sym] of [['SPY', 'equities2y_es_1h.json', 'ES=F'], ['QQQ', 'equities2y_nq_1h.json', 'NQ=F']]) {
    const ms = modelsStocks[asset];
    const futDs = loadRawCached(futFile, true);
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
  const futMaxT = Math.max(...futuresEntries.map(s => s.rows[s.rows.length - 1].time));
  const y5StartTime = btc1hRows[Math.floor(0.80 * btc1hRows.length)].time;

  const filterTime = (entries, tMin, tMax) => entries.map(s => ({
    ...s,
    trades: s.trades.filter(t => {
      const et = s.rows[t.entryIndex].time;
      const xt = s.rows[t.exitIndex].time;
      return et >= tMin && xt <= tMax;
    }),
  }));

  const combined2yEntries = [...filterTime(qualifiedStreams, futMinT, futMaxT), ...filterTime(futuresEntries, futMinT, futMaxT)];
  const combinedY5Entries = [...filterTime(qualifiedStreams, y5StartTime, futMaxT), ...filterTime(futuresEntries, y5StartTime, futMaxT)];

  return {
    overlap2y: summarizePortfolioWindow(combined2yEntries, futMinT, futMaxT, { levScale: 0.85, maxTotalOpenLev: 8.0, mmr: 0.005 }),
    overlapY5Bear: summarizePortfolioWindow(combinedY5Entries, y5StartTime, futMaxT, { levScale: 0.85, maxTotalOpenLev: 8.0, mmr: 0.005 }),
    futuresOnly2y: summarizePortfolioWindow(futuresEntries, futMinT, futMaxT, { levScale: 1.0, maxTotalOpenLev: 2.0, mmr: 0.005 }),
  };
}

export async function runV9WalkForwardEnsemble() {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V9_DIR, 'models_v9_crypto.json'), 'utf8'));
  const verifiedLockSha = verifyModelsLockV9(modelsJson);
  const breadthFull = buildCausalBreadthV9(null);

  const streamResults = {};
  const streamObjsByProf = { EXCHANGE_POST_ONLY: [], STRICT_TAKER: [] };

  for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
    for (const sk of V9_STREAM_KEYS) {
      const res = evaluateStreamV9(sk, modelsJson.models[sk], prof, breadthFull);
      if (prof === 'EXCHANGE_POST_ONLY') {
        const { rows, trades, baselineTrades, ...clean } = res;
        streamResults[sk] = { EXCHANGE_POST_ONLY: clean };
      } else {
        const { rows, trades, baselineTrades, ...clean } = res;
        streamResults[sk].STRICT_TAKER = clean;
      }
      streamObjsByProf[prof].push({ ...res, refFullLen: res.bars });
    }
  }

  // Strictly lock Qualified Sleeve from Cal+Val folds [0..80%) computed on EXCHANGE_POST_ONLY (zero Y5 peeking!)
  let qualifiedKeys = V9_STREAM_KEYS.filter(sk => streamResults[sk].EXCHANGE_POST_ONLY.qualifiedForLive);
  if (qualifiedKeys.length === 0) {
    qualifiedKeys = V9_STREAM_KEYS
      .filter(sk => (streamResults[sk].EXCHANGE_POST_ONLY.summary.ml.calVal.profitFactor ?? 0) >= 1.15)
      .slice(0, 4);
  }

  const btcRows = streamObjsByProf.EXCHANGE_POST_ONLY[0].rows;
  const n1h = btcRows.length;
  const valEnd1h = Math.floor(0.80 * n1h);
  const tStart = btcRows[0].time;
  const tValEnd = btcRows[valEnd1h - 1].time;
  const tY5Start = btcRows[valEnd1h].time;
  const tEnd = btcRows[n1h - 1].time;

  const TIERS = {
    SAFE_V9: { label: 'TIER_1_SAFE_V9', maxCalValDd: 22.0, levGrid: [0.55, 0.70, 0.85, 1.00], capGrid: [6.0, 8.0, 10.0] },
    BALANCED_V9: { label: 'TIER_2_BALANCED_V9', maxCalValDd: 35.0, levGrid: [0.90, 1.10, 1.30, 1.50], capGrid: [8.0, 10.0, 12.0] },
    MAXIMIZED_V9: { label: 'TIER_3_MAXIMIZED_V9', maxCalValDd: 60.0, levGrid: [1.40, 1.75, 2.10, 2.40], capGrid: [10.0, 12.0, 14.0] },
  };

  const qualPostOnly = streamObjsByProf.EXCHANGE_POST_ONLY.filter(s => qualifiedKeys.includes(s.id));
  const qualCV = sliceTradesWindowByTime(qualPostOnly, tStart, tValEnd);

  const tierOut = {};
  for (const [tKey, tCfg] of Object.entries(TIERS)) {
    let bestParams = null;
    let bestScore = -Infinity;
    for (const levScale of tCfg.levGrid) {
      for (const maxTotalOpenLev of tCfg.capGrid) {
        const cv = summarizePortfolioWindow(qualCV, tStart, tValEnd, { levScale, maxTotalOpenLev, mmr: 0.005 });
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
    for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
      const qualEntries = streamObjsByProf[prof].filter(s => qualifiedKeys.includes(s.id));
      const winCV = sliceTradesWindowByTime(qualEntries, tStart, tValEnd);
      const winY5 = sliceTradesWindowByTime(qualEntries, tY5Start, tEnd);
      profiles[prof] = {
        calVal_49m: summarizePortfolioWindow(winCV, tStart, tValEnd, bestParams),
        blindHoldoutY5_13m: summarizePortfolioWindow(winY5, tY5Start, tEnd, bestParams),
        full5y_61m: summarizePortfolioWindow(qualEntries, tStart, tEnd, bestParams),
      };
    }

    tierOut[tKey] = {
      label: tCfg.label,
      qualifiedStreams: qualifiedKeys,
      lockedParams: bestParams,
      profiles,
    };
  }

  const crossAssetAllWeather = buildCrossAssetFuturesOverlay(qualPostOnly, btcRows);

  fs.mkdirSync(RESULTS_V9_DIR, { recursive: true });
  const summary = {
    schema: 'smc-v9-walkforward-ensemble-v1',
    generatedAt: new Date().toISOString(),
    selectionLockSha256: verifiedLockSha,
    qualifiedStreams: qualifiedKeys,
    allStreamsCount: V9_STREAM_KEYS.length,
    streams: streamResults,
    tiers: tierOut,
    crossAssetAllWeather,
  };

  const outPath = path.join(RESULTS_V9_DIR, 'ensemble_v9_crypto_5y.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');

  console.log(`\n[v9] Lock SHA-256 verified: ${verifiedLockSha.slice(0, 16)}...`);
  console.log(`[v9] Qualified Sleeve (${qualifiedKeys.length}/${V9_STREAM_KEYS.length} passed F1>=1.05, F2>=1.15, F3>=1.25, CV_WR>=70%): ${qualifiedKeys.join(', ')}`);
  for (const sk of V9_STREAM_KEYS) {
    const r = streamResults[sk].EXCHANGE_POST_ONLY;
    const m = r.summary.ml;
    console.log(`  ${sk.padEnd(8)} [qual=${String(r.qualifiedForLive).padEnd(5)} short=${r.shortEnabled}] F1=${m.f1Bear2022.profitFactor.toFixed(2)} F2=${m.f2Recov2023.profitFactor.toFixed(2)} F3=${m.f3Val.profitFactor.toFixed(2)} CV=${m.calVal.winRatePct.toFixed(1)}% | Y5: n=${m.holdoutY5.count} WR=${m.holdoutY5.winRatePct.toFixed(1)}% PF=${m.holdoutY5.profitFactor.toFixed(2)} Comp=${m.holdoutY5.compoundedNetPct.toFixed(2)}% | 5Y: WR=${m.full5y.winRatePct.toFixed(1)}% PF=${m.full5y.profitFactor.toFixed(2)} Comp=${m.full5y.compoundedNetPct.toFixed(2)}% DD=${m.full5y.maxCompoundedDdPct.toFixed(2)}%`);
  }
  for (const [tk, tv] of Object.entries(tierOut)) {
    const p = tv.profiles.EXCHANGE_POST_ONLY;
    const t = tv.profiles.STRICT_TAKER;
    console.log(`\n[${tv.label}] lev=${tv.lockedParams.levScale} maxLev=${tv.lockedParams.maxTotalOpenLev}`);
    console.log(`  POST_ONLY | CV: WR=${p.calVal_49m.winRatePct}% PF=${p.calVal_49m.profitFactor} Mo=${p.calVal_49m.meanMonthlySweepPct}% DD=${p.calVal_49m.maxCompoundedDdPct}% | Y5: WR=${p.blindHoldoutY5_13m.winRatePct}% PF=${p.blindHoldoutY5_13m.profitFactor} Mo=${p.blindHoldoutY5_13m.meanMonthlySweepPct}% Comp=${p.blindHoldoutY5_13m.compoundedNetPct}% Worst=${p.blindHoldoutY5_13m.worstMonthPct}% Liq=${p.blindHoldoutY5_13m.liquidationCount} | 5Y: WR=${p.full5y_61m.winRatePct}% PF=${p.full5y_61m.profitFactor} Mo=${p.full5y_61m.meanMonthlySweepPct}% Comp=${p.full5y_61m.compoundedNetPct}% DD=${p.full5y_61m.maxCompoundedDdPct}% Guard=${p.full5y_61m.ddGuardThrottledTrades} Liq=${p.full5y_61m.liquidationCount}`);
    console.log(`  TAKER     | CV: WR=${t.calVal_49m.winRatePct}% Mo=${t.calVal_49m.meanMonthlySweepPct}% | Y5: WR=${t.blindHoldoutY5_13m.winRatePct}% PF=${t.blindHoldoutY5_13m.profitFactor} Mo=${t.blindHoldoutY5_13m.meanMonthlySweepPct}% Comp=${t.blindHoldoutY5_13m.compoundedNetPct}% | 5Y: WR=${t.full5y_61m.winRatePct}% PF=${t.full5y_61m.profitFactor} Mo=${t.full5y_61m.meanMonthlySweepPct}% Comp=${t.full5y_61m.compoundedNetPct}% DD=${t.full5y_61m.maxCompoundedDdPct}% Liq=${t.full5y_61m.liquidationCount}`);
  }
  console.log(`\n[Cross-Asset All-Weather (v9 Crypto Qualified + ES=F/NQ=F Futures)]`);
  console.log(`  2Y Overlap: WR=${crossAssetAllWeather.overlap2y.winRatePct}% PF=${crossAssetAllWeather.overlap2y.profitFactor} Mo=${crossAssetAllWeather.overlap2y.meanMonthlySweepPct}% Comp=${crossAssetAllWeather.overlap2y.compoundedNetPct}% DD=${crossAssetAllWeather.overlap2y.maxCompoundedDdPct}% Liq=${crossAssetAllWeather.overlap2y.liquidationCount}`);
  console.log(`  Y5 Bear Overlap: WR=${crossAssetAllWeather.overlapY5Bear.winRatePct}% PF=${crossAssetAllWeather.overlapY5Bear.profitFactor} Mo=${crossAssetAllWeather.overlapY5Bear.meanMonthlySweepPct}% Comp=${crossAssetAllWeather.overlapY5Bear.compoundedNetPct}% DD=${crossAssetAllWeather.overlapY5Bear.maxCompoundedDdPct}% Liq=${crossAssetAllWeather.overlapY5Bear.liquidationCount}`);
  console.log(`[v9] Wrote ${path.relative(ROOT_DIR, outPath)}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--extract-cal-val')) {
    process.stdout.write(JSON.stringify(extractCalValPayloadV9()));
  } else if (process.argv.includes('--eval-folds')) {
    const req = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(evalFoldsBatchV9(req)));
  } else {
    runV9WalkForwardEnsemble().catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}
