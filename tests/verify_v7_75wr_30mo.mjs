import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { alignFundingToBarsCausal } from '../research/fetch_okx_derivs.mjs';
import {
  applyV7ModelToSignals,
  generateStreamSignalsV7,
  sliceDatasetPrefixV7,
} from '../research/high_wr_v7_btc_bnb.mjs';
import {
  applyV7EthSolModelToSignals,
  generateEthSolStreamSignalsV7,
} from '../research/high_wr_v7_eth_sol.mjs';
import { scoreCandidateV5 } from '../research/ml_inference.mjs';
import {
  simulatePortfolioV7,
  simulateTradesV7,
  summarizeMonthlyCashflowV7,
} from '../research/sim_engine_v7.mjs';
import {
  extractCandidateFeaturesV6,
  precomputeOrderflowContextV6,
} from '../research/suite_v6_btc_bnb.mjs';
import {
  extractEthCandidateFeaturesV6,
  precomputeEthCrossContextV6,
} from '../research/suite_v6_eth_sol.mjs';
import {
  assertLiveOrderSafety,
  assertLoopbackHost,
  loadConfig,
  normalizeRiskTier,
  redactConfig,
  scrubSecrets,
} from '../standalone/config.mjs';
import {
  computeLiquidationDistance,
  loadRuntimeSpecs,
} from '../standalone/engine_runtime.mjs';
import { createStandaloneServer } from '../standalone/server.mjs';
import { StandaloneStore } from '../standalone/store_sqlite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const RESULTS_V7 = path.join(REPO_ROOT, 'research', 'results_v7');

const jsonCache = new Map();
function readJsonCached(filePath) {
  if (!jsonCache.has(filePath)) {
    jsonCache.set(filePath, JSON.parse(fs.readFileSync(filePath, 'utf8')));
  }
  return jsonCache.get(filePath);
}

function makeTmpDir(prefix = 'verify-v7-') {
  return fs.mkdtempSync(path.join(REPO_ROOT, 'data', prefix));
}

function mutateFutureCryptoFast(ds, cutoffBars) {
  const cutoffTime = ds.rows[cutoffBars - 1].time;
  const rows = ds.rows.map((r, idx) => {
    if (idx < cutoffBars) return r;
    const mult = idx % 2 === 0 ? 3.2 : 0.22;
    const vol = (r.volume || 100) * 18.0;
    return {
      ...r,
      open: r.open * mult,
      high: r.high * mult * 1.35,
      low: r.low * mult * 0.65,
      close: r.close * mult,
      volume: vol,
      takerBuyVol: Number.isFinite(r.takerBuyVol) ? (idx % 2 === 0 ? vol * 0.99 : vol * 0.01) : r.takerBuyVol,
    };
  });

  const htf = {};
  const tfSecMap = { '1h': 3600, '4h': 14400, '1d': 86400 };
  for (const tf of Object.keys(ds.htf || {})) {
    const h = ds.htf[tf];
    const tfSec = h.intervalSeconds ?? tfSecMap[tf] ?? 3600;
    htf[tf] = {
      ...h,
      rows: h.rows.map(hr => (
        hr.time + tfSec > cutoffTime
          ? {
              ...hr,
              open: hr.open * 2.9,
              high: hr.high * 3.4,
              low: hr.low * 0.3,
              close: hr.close * 2.8,
              volume: (hr.volume || 100) * 14,
              takerBuyVol: Number.isFinite(hr.takerBuyVol) ? (hr.volume || 100) * 13.5 : hr.takerBuyVol,
            }
          : hr
      )),
    };
  }

  const fundingRows = Array.isArray(ds.fundingRows)
    ? ds.fundingRows.map(f => (f.time > cutoffTime ? { ...f, fundingRate: 0.095 } : f))
    : undefined;

  return { ...ds, rows, htf, ...(fundingRows ? { fundingRows } : {}) };
}

function assertSignalArraysMatch(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: signal count mismatch (${actual.length} vs ${expected.length})`);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    assert.equal(a.barIndex, e.barIndex, `${label}[${i}] barIndex`);
    assert.equal(a.side, e.side, `${label}[${i}] side`);
    assert.ok(Math.abs(a.atr - e.atr) < 1e-12, `${label}[${i}] atr diff`);
    if (e.limitPrice !== undefined) {
      assert.ok(Math.abs(a.limitPrice - e.limitPrice) < 1e-12, `${label}[${i}] limitPrice diff`);
    }
    if (e.meta?.probWin !== undefined && a.meta?.probWin !== undefined) {
      assert.ok(Math.abs(a.meta.probWin - e.meta.probWin) < 1e-12, `${label}[${i}] probWin diff`);
    }
    if (e.sizeMult !== undefined && a.sizeMult !== undefined) {
      assert.ok(Math.abs(a.sizeMult - e.sizeMult) < 1e-12, `${label}[${i}] sizeMult diff`);
    }
  }
}

function assertFeatureMapsMatch(fA, fB, keys, label) {
  for (const k of keys) {
    const a = fA[k];
    const b = fB[k];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      assert.equal(Number.isFinite(a), Number.isFinite(b), `${label} feature ${k} finiteness mismatch`);
    } else {
      assert.ok(Math.abs(a - b) < 1e-12, `${label} feature ${k} diff: ${a} vs ${b}`);
    }
  }
}

const STREAM_FILES = Object.freeze({
  BTC_1h: 'crypto5y_btcusdt_1h.json',
  BTC_15m: 'crypto5y_btcusdt_15m.json',
  BNB_1h: 'crypto5y_bnbusdt_1h.json',
  BNB_15m: 'crypto5y_bnbusdt_15m.json',
  SOL_15m: 'crypto5y_solusdt_15m.json',
  SOL_1h: 'crypto5y_solusdt_1h.json',
  ETH_15m: 'crypto5y_ethusdt_15m.json',
  ETH_1h: 'crypto5y_ethusdt_1h.json',
});

describe('1. v7.0 Strict Causal Prefix-Truncation & Future-Mutation: 5Y 15m + 1h Streams (BTC/BNB/SOL/ETH)', () => {
  const btcBnbModels = readJsonCached(path.join(RESULTS_V7, 'models_v7_btc_bnb.json')).models;
  const ethSolModels = readJsonCached(path.join(RESULTS_V7, 'models_v7_eth_sol.json')).models;

  it('BTC_1h, BTC_15m, BNB_1h, BNB_15m signals, orderflow features, ML scores & closed trades are 100% causal', () => {
    for (const streamKey of ['BTC_1h', 'BTC_15m', 'BNB_1h', 'BNB_15m']) {
      const mSpec = btcBnbModels[streamKey];
      const dsFull = readJsonCached(path.join(DATA_DIR, STREAM_FILES[streamKey]));
      const cutoffT = dsFull.intervalSeconds <= 900 ? 112000 : 28000;

      const dsPrefix = sliceDatasetPrefixV7(dsFull, cutoffT);
      const dsMut = mutateFutureCryptoFast(dsFull, cutoffT);

      const fundFull = alignFundingToBarsCausal(dsFull.rows, dsFull.fundingRows ?? []);
      const fundPrefix = alignFundingToBarsCausal(dsPrefix.rows, dsPrefix.fundingRows ?? []);
      const fundMut = alignFundingToBarsCausal(dsMut.rows, dsMut.fundingRows ?? []);

      const sigFull = generateStreamSignalsV7(streamKey, dsFull, mSpec.structuralSpec.sigSpec, fundFull)
        .filter(s => s.barIndex < cutoffT);
      const sigPrefix = generateStreamSignalsV7(streamKey, dsPrefix, mSpec.structuralSpec.sigSpec, fundPrefix);
      const sigMut = generateStreamSignalsV7(streamKey, dsMut, mSpec.structuralSpec.sigSpec, fundMut)
        .filter(s => s.barIndex < cutoffT);

      assert.ok(sigFull.length >= 60, `${streamKey} expected >= 60 signals before T=${cutoffT}`);
      assertSignalArraysMatch(sigPrefix, sigFull, `${streamKey} prefix signals`);
      assertSignalArraysMatch(sigMut, sigFull, `${streamKey} future-mutated signals`);

      const ctxFull = precomputeOrderflowContextV6(dsFull, fundFull);
      const ctxPrefix = precomputeOrderflowContextV6(dsPrefix, fundPrefix);
      const ctxMut = precomputeOrderflowContextV6(dsMut, fundMut);

      for (const s of sigFull.slice(-15)) {
        const fF = extractCandidateFeaturesV6(dsFull, s, s.barIndex, fundFull, ctxFull);
        const fP = extractCandidateFeaturesV6(dsPrefix, s, s.barIndex, fundPrefix, ctxPrefix);
        const fM = extractCandidateFeaturesV6(dsMut, s, s.barIndex, fundMut, ctxMut);
        assertFeatureMapsMatch(fP, fF, mSpec.featureNames, `${streamKey}@${s.barIndex} prefix`);
        assertFeatureMapsMatch(fM, fF, mSpec.featureNames, `${streamKey}@${s.barIndex} mut`);
      }

      const mlFull = applyV7ModelToSignals(dsFull, sigFull, fundFull, mSpec);
      const mlPrefix = applyV7ModelToSignals(dsPrefix, sigPrefix, fundPrefix, mSpec);
      const mlMut = applyV7ModelToSignals(dsMut, sigMut, fundMut, mSpec);
      assert.ok(mlFull.length >= 30, `${streamKey} expected >= 30 ML signals before T=${cutoffT}`);
      assertSignalArraysMatch(mlPrefix, mlFull, `${streamKey} ML prefix`);
      assertSignalArraysMatch(mlMut, mlFull, `${streamKey} ML future-mut`);

      const simOpts = {
        ...mSpec.structuralSpec.execOptions,
        execProfile: 'EXCHANGE_POST_ONLY',
        fundingPctPer8h: 0.01,
        isolatedLiqCheck: true,
        mmr: 0.005,
        intervalSeconds: dsFull.intervalSeconds,
      };
      const trFull = simulateTradesV7(dsFull.rows, mlFull, { ...simOpts, fundingRows: dsFull.fundingRows })
        .trades.filter(t => t.exitIndex < cutoffT - 1);
      const trPrefix = simulateTradesV7(dsPrefix.rows, mlPrefix, { ...simOpts, fundingRows: dsPrefix.fundingRows })
        .trades.filter(t => t.exitIndex < cutoffT - 1);
      const trMut = simulateTradesV7(dsMut.rows, mlMut, { ...simOpts, fundingRows: dsMut.fundingRows })
        .trades.filter(t => t.exitIndex < cutoffT - 1);

      assert.equal(trPrefix.length, trFull.length, `${streamKey} closed trades prefix len`);
      assert.equal(trMut.length, trFull.length, `${streamKey} closed trades mut len`);
      for (let k = 0; k < trFull.length; k++) {
        assert.equal(trPrefix[k].exitReason, trFull[k].exitReason);
        assert.ok(Math.abs(trPrefix[k].netPct - trFull[k].netPct) < 1e-12);
        assert.ok(Math.abs(trMut[k].netPct - trFull[k].netPct) < 1e-12);
      }
    }
  });

  it('SOL_15m, SOL_1h, ETH_15m, ETH_1h signals, ETH/BTC cross features, ML scores & closed trades are 100% causal', () => {
    const btc1hFull = readJsonCached(path.join(DATA_DIR, STREAM_FILES.BTC_1h));
    const btc15Full = readJsonCached(path.join(DATA_DIR, STREAM_FILES.BTC_15m));
    const btc1hPrefix = sliceDatasetPrefixV7(btc1hFull, 28000);
    const btc1hMut = mutateFutureCryptoFast(btc1hFull, 28000);
    const btc15Prefix = sliceDatasetPrefixV7(btc15Full, 112000);
    const btc15Mut = mutateFutureCryptoFast(btc15Full, 112000);

    for (const streamKey of ['SOL_15m', 'SOL_1h', 'ETH_15m', 'ETH_1h']) {
      const mSpec = ethSolModels[streamKey];
      const dsFull = readJsonCached(path.join(DATA_DIR, STREAM_FILES[streamKey]));
      const is15m = dsFull.intervalSeconds <= 900;
      const cutoffT = is15m ? 112000 : 28000;
      const isEth = streamKey.startsWith('ETH');

      const btcFull = isEth ? (is15m ? btc15Full : btc1hFull) : null;
      const btcPrefix = isEth ? (is15m ? btc15Prefix : btc1hPrefix) : null;
      const btcMut = isEth ? (is15m ? btc15Mut : btc1hMut) : null;

      const dsPrefix = sliceDatasetPrefixV7(dsFull, cutoffT);
      const dsMut = mutateFutureCryptoFast(dsFull, cutoffT);

      const fundFull = alignFundingToBarsCausal(dsFull.rows, dsFull.fundingRows ?? []);
      const fundPrefix = alignFundingToBarsCausal(dsPrefix.rows, dsPrefix.fundingRows ?? []);
      const fundMut = alignFundingToBarsCausal(dsMut.rows, dsMut.fundingRows ?? []);

      const sigFull = generateEthSolStreamSignalsV7(streamKey, dsFull, mSpec.structuralSpec.sigSpec, btcFull)
        .filter(s => s.barIndex < cutoffT);
      const sigPrefix = generateEthSolStreamSignalsV7(streamKey, dsPrefix, mSpec.structuralSpec.sigSpec, btcPrefix);
      const sigMut = generateEthSolStreamSignalsV7(streamKey, dsMut, mSpec.structuralSpec.sigSpec, btcMut)
        .filter(s => s.barIndex < cutoffT);

      assert.ok(sigFull.length >= 60, `${streamKey} expected >= 60 signals before T=${cutoffT}`);
      assertSignalArraysMatch(sigPrefix, sigFull, `${streamKey} prefix signals`);
      assertSignalArraysMatch(sigMut, sigFull, `${streamKey} future-mutated signals`);

      const ctxFull = isEth
        ? precomputeEthCrossContextV6(dsFull, btcFull, fundFull)
        : precomputeOrderflowContextV6(dsFull, fundFull);
      const ctxPrefix = isEth
        ? precomputeEthCrossContextV6(dsPrefix, btcPrefix, fundPrefix)
        : precomputeOrderflowContextV6(dsPrefix, fundPrefix);
      const ctxMut = isEth
        ? precomputeEthCrossContextV6(dsMut, btcMut, fundMut)
        : precomputeOrderflowContextV6(dsMut, fundMut);

      for (const s of sigFull.slice(-15)) {
        const fF = isEth
          ? extractEthCandidateFeaturesV6(dsFull, btcFull, s, s.barIndex, fundFull, ctxFull)
          : extractCandidateFeaturesV6(dsFull, s, s.barIndex, fundFull, ctxFull);
        const fP = isEth
          ? extractEthCandidateFeaturesV6(dsPrefix, btcPrefix, s, s.barIndex, fundPrefix, ctxPrefix)
          : extractCandidateFeaturesV6(dsPrefix, s, s.barIndex, fundPrefix, ctxPrefix);
        const fM = isEth
          ? extractEthCandidateFeaturesV6(dsMut, btcMut, s, s.barIndex, fundMut, ctxMut)
          : extractCandidateFeaturesV6(dsMut, s, s.barIndex, fundMut, ctxMut);
        assertFeatureMapsMatch(fP, fF, mSpec.featureNames, `${streamKey}@${s.barIndex} prefix`);
        assertFeatureMapsMatch(fM, fF, mSpec.featureNames, `${streamKey}@${s.barIndex} mut`);
      }

      const mlFull = applyV7EthSolModelToSignals(streamKey, dsFull, sigFull, fundFull, mSpec, btcFull);
      const mlPrefix = applyV7EthSolModelToSignals(streamKey, dsPrefix, sigPrefix, fundPrefix, mSpec, btcPrefix);
      const mlMut = applyV7EthSolModelToSignals(streamKey, dsMut, sigMut, fundMut, mSpec, btcMut);
      assert.ok(mlFull.length >= 30, `${streamKey} expected >= 30 ML signals before T=${cutoffT}`);
      assertSignalArraysMatch(mlPrefix, mlFull, `${streamKey} ML prefix`);
      assertSignalArraysMatch(mlMut, mlFull, `${streamKey} ML future-mut`);

      const simOpts = {
        ...mSpec.structuralSpec.execOptions,
        execProfile: 'EXCHANGE_POST_ONLY',
        fundingPctPer8h: 0.01,
        isolatedLiqCheck: true,
        mmr: 0.005,
        intervalSeconds: dsFull.intervalSeconds,
      };
      const trFull = simulateTradesV7(dsFull.rows, mlFull, { ...simOpts, fundingRows: dsFull.fundingRows })
        .trades.filter(t => t.exitIndex < cutoffT - 1);
      const trPrefix = simulateTradesV7(dsPrefix.rows, mlPrefix, { ...simOpts, fundingRows: dsPrefix.fundingRows })
        .trades.filter(t => t.exitIndex < cutoffT - 1);
      const trMut = simulateTradesV7(dsMut.rows, mlMut, { ...simOpts, fundingRows: dsMut.fundingRows })
        .trades.filter(t => t.exitIndex < cutoffT - 1);

      assert.equal(trPrefix.length, trFull.length, `${streamKey} closed trades prefix len`);
      assert.equal(trMut.length, trFull.length, `${streamKey} closed trades mut len`);
      for (let k = 0; k < trFull.length; k++) {
        assert.equal(trPrefix[k].exitReason, trFull[k].exitReason);
        assert.ok(Math.abs(trPrefix[k].netPct - trFull[k].netPct) < 1e-12);
        assert.ok(Math.abs(trMut[k].netPct - trFull[k].netPct) < 1e-12);
      }
    }
  });
});

describe('2. Exact Intra-Bar Liquidation Physics & Zero-Liquidation v7 Frontier Checks', () => {
  it('triggers single-stream isolated LIQUIDATION (-100% equity=0) BEFORE TP/BE on worst adverse wick', () => {
    const base = 1700000000;
    const rows = [
      { time: base, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
      { time: base + 900, open: 100, high: 101, low: 99.5, close: 100, volume: 1000 },
      // Adversarial wick: low=90.0 (-10% move -> breaches 10x liq threshold -9.5%) even though high=120.0 & close=115.0!
      { time: base + 1800, open: 100, high: 120, low: 90.0, close: 115, volume: 5000 },
      { time: base + 2700, open: 115, high: 116, low: 114, close: 115, volume: 1000 },
    ];
    const sim = simulateTradesV7(
      rows,
      [{ barIndex: 0, side: 1, atr: 10.0 }],
      {
        execProfile: 'STRICT_TAKER',
        entryMode: 'MARKET_NEXT_OPEN',
        warmup: 0,
        cooldown: 0,
        stopAtr: 2.0,
        minStopPct: 1.0,
        rewardRisk: 1.0,
        maxHoldBars: 10,
        slippagePct: 0,
        costPct: 0.10,
        fixedLev: 10.0,
        minLev: 10.0,
        maxLev: 10.0,
        mmr: 0.005,
        isolatedLiqCheck: true,
        intervalSeconds: 900,
      },
    );

    assert.equal(sim.liquidationCount, 1);
    assert.equal(sim.trades.length, 1);
    assert.equal(sim.trades[0].exitReason, 'LIQUIDATION');
    assert.equal(sim.trades[0].netPct, -100);
    assert.equal(sim.finalEquity, 0);
  });

  it('triggers cross-margin portfolio LIQUIDATION in simulatePortfolioV7 when concurrent wicks breach mmr', () => {
    const base = 1700000000;
    const rows = [
      { time: base, open: 100, high: 101, low: 99, close: 100 },
      { time: base + 900, open: 100, high: 101, low: 90.2, close: 100 },
      { time: base + 1800, open: 100, high: 102, low: 99, close: 101 },
    ];
    const sA = {
      id: 'BTC_15m',
      rows,
      intervalSeconds: 900,
      trades: [{ entryIndex: 0, exitIndex: 2, side: 1, entry: 100, lev: 5.0, grossPct: 5, netPct: 4.5 }],
    };
    const sB = {
      id: 'SOL_15m',
      rows,
      intervalSeconds: 900,
      trades: [{ entryIndex: 0, exitIndex: 2, side: 1, entry: 100, lev: 5.0, grossPct: 5, netPct: 4.5 }],
    };

    const res = simulatePortfolioV7([sA, sB], { maxTotalOpenLev: 10.0, levScale: 1.0, mmr: 0.005 });
    assert.equal(res.liquidationCount, 1);
    assert.ok(res.trades.some(t => t.exitReason === 'LIQUIDATION' && t.portfolioNetPct === -100));
    assert.equal(res.finalEquity, 0);
  });

  it('verifies all 3 published v7 tiers have liquidationCount === 0 across 60+ UTC months and consistent summarizeMonthlyCashflowV7', () => {
    const frontier = readJsonCached(path.join(RESULTS_V7, 'frontier_75wr_30mo_summary.json'));
    const expectedTiers = ['TIER_1_SAFE_75WR', 'TIER_2_BALANCED_75WR', 'TIER_3_TARGET_30MO_75WR'];

    for (const tierKey of expectedTiers) {
      const tier = frontier.tiers[tierKey];
      assert.ok(tier, `Missing tier ${tierKey}`);
      for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
        const p = tier.profiles[prof];
        assert.ok(p, `Missing profile ${prof} for ${tierKey}`);
        for (const winKey of ['calVal_48m', 'blindHoldoutY5_12m', 'full5y_60m']) {
          const w = p[winKey];
          assert.equal(w.liquidationCount, 0, `${tierKey}.${prof}.${winKey} must have 0 liquidations`);
          assert.equal(w.sweepLiquidationCount, 0, `${tierKey}.${prof}.${winKey} must have 0 sweep liquidations`);
          assert.equal(w.zeroLiquidationBothModes, true);
        }
        assert.equal(p.full5y_60m.totalMonths, 61);
        assert.ok(p.full5y_60m.winRatePct >= 75.0, `${tierKey}.${prof} full5y WR ${p.full5y_60m.winRatePct}% < 75%`);
        assert.ok(Array.isArray(p.full5y_60m.monthlyTable) && p.full5y_60m.monthlyTable.length === 61);
      }
    }

    // Tier 3 achieves >= +30%/mo on Cal+Val under EXCHANGE_POST_ONLY without liquidations
    const t3CalVal = frontier.tiers.TIER_3_TARGET_30MO_75WR.profiles.EXCHANGE_POST_ONLY.calVal_48m;
    assert.ok(t3CalVal.meanMonthlySweepPct >= 30.0, `Expected Tier 3 Cal+Val >= 30%/mo, got ${t3CalVal.meanMonthlySweepPct}`);
    assert.ok(t3CalVal.winRatePct >= 75.0);

    // Sanity check summarizeMonthlyCashflowV7 zero-trade month enumeration
    const emptyMonthSummary = summarizeMonthlyCashflowV7(
      [{ exitIndex: 0, exitTime: 1704067200, netPct: 5.0 }], // 2024-01-01
      { startTime: 1704067200, endTime: 1709251200 }, // 2024-01 .. 2024-03 (3 UTC months)
    );
    assert.equal(emptyMonthSummary.totalMonths, 3);
    assert.equal(emptyMonthSummary.monthlyTable[1].count, 0);
    assert.equal(emptyMonthSummary.monthlyTable[1].sweepNetPct, 0);
  });
});

describe('3. Zero Y5 Holdout Leakage & < 1e-12 Python sklearn vs JS Parity (All 8 v7 Models)', () => {
  it('enforces exact Cal/Val/Holdout index boundaries and zero Y5 peeking in calValStreamScreening', () => {
    const btcBnb = readJsonCached(path.join(RESULTS_V7, 'models_v7_btc_bnb.json')).models;
    const ethSol = readJsonCached(path.join(RESULTS_V7, 'models_v7_eth_sol.json')).models;
    const frontier = readJsonCached(path.join(RESULTS_V7, 'frontier_75wr_30mo_summary.json'));

    for (const [key, m] of Object.entries({ ...btcBnb, ...ethSol })) {
      const meta = m.selectionMeta;
      if (key.endsWith('_15m')) {
        assert.deepEqual(meta.calRange, [0, 87904], `${key} calRange`);
        assert.deepEqual(meta.valRange, [87904, 140646], `${key} valRange`);
        assert.deepEqual(meta.holdoutRangeUntouched, [140646, 175808], `${key} holdoutRangeUntouched`);
      } else {
        assert.deepEqual(meta.calRange, [0, 21976], `${key} calRange`);
        assert.deepEqual(meta.valRange, [21976, 35161], `${key} valRange`);
        assert.deepEqual(meta.holdoutRangeUntouched, [35161, 43952], `${key} holdoutRangeUntouched`);
      }
      assert.ok(meta.valRange[1] <= meta.holdoutRangeUntouched[0]);
    }

    const screenMap = Object.fromEntries(frontier.calValStreamScreening.map(s => [s.id, s]));
    assert.equal(screenMap.BNB_1h.keepOnCalVal, false, 'BNB_1h WR<75% on Cal+Val must be excluded strictly on Cal+Val');
    assert.equal(screenMap.BNB_15m.keepOnCalVal, false, 'BNB_15m PF<1.25 on Cal+Val must be excluded strictly on Cal+Val');
  });

  it('achieves < 1e-12 predict_proba & pass parity between Python sklearn and JS across >= 60 real candidates for ALL 8 v7 models', () => {
    const btcBnb = readJsonCached(path.join(RESULTS_V7, 'models_v7_btc_bnb.json')).models;
    const ethSol = readJsonCached(path.join(RESULTS_V7, 'models_v7_eth_sol.json')).models;
    const allModels = { ...btcBnb, ...ethSol };

    const btc1hDs = readJsonCached(path.join(DATA_DIR, STREAM_FILES.BTC_1h));
    const btc15Ds = readJsonCached(path.join(DATA_DIR, STREAM_FILES.BTC_15m));

    const tasks = [];
    for (const streamKey of Object.keys(STREAM_FILES)) {
      const mSpec = allModels[streamKey];
      const ds = readJsonCached(path.join(DATA_DIR, STREAM_FILES[streamKey]));
      const alignedFunding = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
      const isBtcBnb = streamKey.startsWith('BTC') || streamKey.startsWith('BNB');
      const isEth = streamKey.startsWith('ETH');
      const btcDs = isEth ? (ds.intervalSeconds <= 900 ? btc15Ds : btc1hDs) : null;

      const sigs = isBtcBnb
        ? generateStreamSignalsV7(streamKey, ds, mSpec.structuralSpec.sigSpec, alignedFunding)
        : generateEthSolStreamSignalsV7(streamKey, ds, mSpec.structuralSpec.sigSpec, btcDs);

      assert.ok(sigs.length >= 60, `${streamKey} expected >= 60 real candidates (got ${sigs.length})`);
      const ctx = isEth
        ? precomputeEthCrossContextV6(ds, btcDs, alignedFunding)
        : precomputeOrderflowContextV6(ds, alignedFunding);

      const sample = sigs.slice(0, 120);
      const rows = sample.map(s => {
        const fMap = isEth
          ? extractEthCandidateFeaturesV6(ds, btcDs, s, s.barIndex, alignedFunding, ctx)
          : extractCandidateFeaturesV6(ds, s, s.barIndex, alignedFunding, ctx);
        const sc = scoreCandidateV5(fMap, mSpec);
        const vec = mSpec.featureNames.map(k => (Number.isFinite(fMap[k]) ? fMap[k] : null));
        return { vec, jsProb: sc.probWin, jsPass: sc.pass };
      });
      tasks.push({ streamKey, modelSpec: mSpec, rows });
    }

    const pyCode = `
import json, sys
import numpy as np
from scipy.special import expit
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

payload = json.loads(sys.stdin.read())
out = {}

def eval_tree(tree, x_f32):
    node = 0
    cl = tree['childrenLeft']
    cr = tree['childrenRight']
    feat = tree['feature']
    thresh = tree['threshold']
    val = tree['value']
    while True:
        f = feat[node]
        if f < 0:
            return float(val[node])
        if x_f32[f] <= thresh[node]:
            node = cl[node]
        else:
            node = cr[node]

for task in payload:
    sk = task['streamKey']
    ms = task['modelSpec']
    rows = task['rows']
    medians = np.array(ms['imputer']['medians'], dtype=np.float64)
    X_raw = np.array([[np.nan if v is None else float(v) for v in r['vec']] for r in rows], dtype=np.float64)
    for j in range(X_raw.shape[1]):
        mask = ~np.isfinite(X_raw[:, j])
        X_raw[mask, j] = medians[j]

    scaler = StandardScaler()
    scaler.mean_ = np.array(ms['scaler']['mean'], dtype=np.float64)
    scaler.scale_ = np.array(ms['scaler']['scale'], dtype=np.float64)
    scaler.var_ = scaler.scale_ ** 2
    scaler.n_features_in_ = len(medians)
    X_sc = scaler.transform(X_raw)

    if ms['modelType'] == 'logistic_regression':
        clf = LogisticRegression()
        clf.coef_ = np.array([ms['classifier']['coef']], dtype=np.float64)
        clf.intercept_ = np.array([ms['classifier']['intercept']], dtype=np.float64)
        clf.classes_ = np.array([0, 1])
        py_probs = clf.predict_proba(X_sc)[:, 1]
    elif ms['modelType'] == 'gradient_boosting':
        init_s = float(ms['classifier']['initScore'])
        lr = float(ms['classifier']['learningRate'])
        trees = ms['classifier']['trees']
        X_f32 = X_sc.astype(np.float32)
        py_probs = np.empty(len(X_f32), dtype=np.float64)
        for i in range(len(X_f32)):
            raw = init_s
            for tr in trees:
                raw += lr * eval_tree(tr, X_f32[i])
            py_probs[i] = float(expit(raw))
    else:
        raise ValueError(ms['modelType'])

    thresh = float(ms['threshold'])
    diffs = [abs(float(py_probs[i]) - float(rows[i]['jsProb'])) for i in range(len(rows))]
    pass_mismatch = sum(1 for i in range(len(rows)) if (float(py_probs[i]) >= thresh) != bool(rows[i]['jsPass']))
    out[sk] = {
        'count': len(rows),
        'maxAbsDiff': max(diffs),
        'passMismatch': pass_mismatch,
    }

print(json.dumps(out))
`;

    const stdout = execFileSync('python3', ['-c', pyCode], {
      input: JSON.stringify(tasks),
      encoding: 'utf8',
    });
    const res = JSON.parse(stdout);

    for (const task of tasks) {
      const r = res[task.streamKey];
      assert.ok(r && r.count >= 60, `Expected >= 60 rows verified for ${task.streamKey}`);
      assert.equal(r.passMismatch, 0, `${task.streamKey} pass mismatch`);
      assert.ok(r.maxAbsDiff < 1e-12, `${task.streamKey} Py vs JS maxAbsDiff=${r.maxAbsDiff}`);
    }
  });
});

describe('4. Standalone v7 Risk-Tier, Liquidation-Guard, Zero-XSS & Loopback Security Audit', () => {
  it('verifies Zero-XSS static audit, .env.example SAFE_75WR + PAPER defaults, risk tier validation & liquidation distance', () => {
    const publicDir = path.join(REPO_ROOT, 'standalone', 'public');
    const appJs = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const stylesCss = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

    for (const pat of [/\.innerHTML\b/i, /\.outerHTML\b/i, /insertAdjacentHTML\b/i, /document\.write\b/i, /\beval\s*\(/i, /new\s+Function\b/i]) {
      assert.equal(pat.test(appJs), false, `Forbidden DOM sink ${pat} in app.js`);
      assert.equal(pat.test(indexHtml), false, `Forbidden DOM sink ${pat} in index.html`);
    }
    assert.equal(/\son[a-z]+\s*=/i.test(indexHtml), false);
    assert.equal(indexHtml.match(/<script(?![^>]*\bsrc=)[^>]*>/gi), null);
    assert.equal(/expression\s*\(/i.test(stylesCss), false);

    const envEx = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    assert.match(envEx, /^EXECUTION_MODE=PAPER$/m);
    assert.match(envEx, /^DRY_RUN=true$/m);
    assert.match(envEx, /^RISK_TIER=SAFE_75WR$/m);

    assert.equal(normalizeRiskTier('SAFE_75WR'), 'SAFE_75WR');
    assert.equal(normalizeRiskTier('BALANCED_75WR'), 'BALANCED_75WR');
    assert.equal(normalizeRiskTier('TARGET_30MO_75WR'), 'TARGET_30MO_75WR');
    assert.throws(() => normalizeRiskTier('INVALID_TIER'), /Invalid RISK_TIER/);

    assert.throws(() => assertLoopbackHost('0.0.0.0'), /Security policy violation/);

    const liq = computeLiquidationDistance(
      { status: 'OPEN_POSITION', side: 1, entry: 50000, lev: 2.0 },
      50000,
      { mmr: 0.005 },
    );
    assert.equal(liq.status, 'SAFE');
    assert.equal(liq.bufferPct, 49.5);

    const cfg = loadConfig({ cwd: REPO_ROOT, useProcessEnv: false, envOverrides: { LIVE_CONFIRM_TOKEN: 'v7-sec-99' } });
    assert.equal(cfg.executionMode, 'PAPER');
    assert.equal(cfg.dryRun, true);
    assert.equal(cfg.riskTier, 'SAFE_75WR');
    assert.throws(() => assertLiveOrderSafety(cfg, 'v7-sec-99'), /EXECUTION_MODE must be LIVE_ARMED/);
    assert.equal(JSON.stringify(redactConfig(cfg)).includes('v7-sec-99'), false);
    assert.equal(scrubSecrets('token=v7-sec-99', cfg).includes('v7-sec-99'), false);
  });

  it('serves /api/status, /api/frontier, /api/backtest?version=v7 on 127.0.0.1 and enforces LIVE_ARMED token lock', async () => {
    const tmp = makeTmpDir('verify-v7-srv-');
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        LIVE_CONFIRM_TOKEN: 'v7-srv-tok',
      },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'v7.sqlite'), allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs });

    try {
      const bound = await srv.start();
      assert.equal(bound.host, '127.0.0.1');
      const base = `http://${bound.host}:${bound.port}`;

      const status = await (await fetch(`${base}/api/status`)).json();
      assert.equal(status.ok, true);
      assert.equal(status.models.v7EngineReady, true);
      assert.equal(status.models.v7ModelsReady, true);
      assert.equal(status.models.v7FrontierReady, true);
      assert.equal(status.config.executionMode, 'PAPER');

      const frontier = await (await fetch(`${base}/api/frontier?tier=TARGET_30MO_75WR&profile=EXCHANGE_POST_ONLY`)).json();
      assert.equal(frontier.ok, true);
      assert.equal(frontier.ready, true);
      assert.equal(frontier.selectedTier.full5y.liquidationCount, 0);
      assert.ok(frontier.selectedTier.calVal_48m.meanMonthlySweepPct >= 30);
      assert.ok(frontier.selectedTier.full5y.winRatePct >= 75);
      assert.ok(Array.isArray(frontier.monthlyTable) && frontier.monthlyTable.length >= 60);

      const bt = await (await fetch(`${base}/api/backtest?symbol=BTCUSDT.P&timeframe=1h&version=v7`)).json();
      assert.equal(bt.ok, true);
      assert.ok(bt.summary.count > 0);
      assert.ok(bt.liquidationDistance);
      assert.ok(bt.monthlySummary);

      const badMode = await fetch(`${base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionMode: 'LIVE_ARMED', dryRun: false, confirmToken: 'wrong' }),
      });
      assert.equal(badMode.status, 403);
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
