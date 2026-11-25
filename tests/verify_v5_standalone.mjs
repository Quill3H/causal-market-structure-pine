import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  alignFundingToBarsCausal,
  validateContiguous8hFunding,
} from '../research/fetch_okx_derivs.mjs';
import {
  FEATURE_NAMES_V5,
  precomputeFeatureContextV5,
  extractCandidateFeaturesV5,
} from '../research/features_v5.mjs';
import { scoreCandidateV5, predictProbaV5 } from '../research/ml_inference.mjs';
import { simulateTradesV5, simulatePortfolioV5 } from '../research/sim_engine_v5.mjs';
import { generateSignals1h, sliceDatasetPrefix1h } from '../research/signals_1h.mjs';
import { generateSignals15mV4, sliceDatasetPrefix15m } from '../research/signals_15m_v4.mjs';
import {
  V41_ALT_DIAGNOSIS,
  ALT_ASSETS_V5,
  generateSignalsAltV5,
} from '../research/signals_v5_alt.mjs';

import {
  assertLiveOrderSafety,
  assertLoopbackHost,
  loadConfig,
  redactConfig,
  scrubSecrets,
} from '../standalone/config.mjs';
import { loadRuntimeSpecs } from '../standalone/engine_runtime.mjs';
import { createStandaloneServer } from '../standalone/server.mjs';
import { StandaloneStore } from '../standalone/store_sqlite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT, 'data');
const RESULTS_V5_DIR = path.join(ROOT, 'research', 'results_v5');
const EPS = 1e-12;

function readJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function mutateDatasetFuture(ds, T) {
  const clone = structuredClone(ds);
  const cutoffTime = clone.rows[T - 1].time;
  for (let i = T; i < clone.rows.length; i++) {
    clone.rows[i].open *= 2.7;
    clone.rows[i].high *= 2.9;
    clone.rows[i].low *= 2.5;
    clone.rows[i].close *= 2.7;
    clone.rows[i].volume *= 11;
  }
  for (const h of Object.values(clone.htf ?? {})) {
    for (const hr of h.rows) {
      if (hr.time + h.intervalSeconds > cutoffTime) {
        hr.open *= 2.7;
        hr.high *= 2.9;
        hr.low *= 2.5;
        hr.close *= 2.7;
        hr.volume *= 11;
      }
    }
  }
  return clone;
}

function mutateFundingFuture(fundingRows, cutoffTime) {
  return fundingRows.map(f =>
    f.time > cutoffTime
      ? { ...f, fundingRate: 0.049, realizedRate: 0.049 }
      : { ...f },
  );
}

// ============================================================================
// 1. CAUSAL PREFIX-TRUNCATION & FUTURE-MUTATION INVARIANCE
// ============================================================================
test('1. Causal prefix-truncation & future-mutation invariance: alignFundingToBarsCausal + features_v5 + ml_inference (BTC 1h & 15m)', () => {
  const btc1h = readJson(path.join(DATA_DIR, 'okx_btcusdt_swap_1h_3y.json'));
  const btc15m = readJson(path.join(DATA_DIR, 'okx_btcusdt_swap_15m_3y.json'));
  const fundingBtc = readJson(path.join(DATA_DIR, 'okx_btcusdt_swap_funding_3y.json')).rows;
  const modelsBtc = readJson(path.join(RESULTS_V5_DIR, 'ml_models_btc_v5.json')).models;
  const lock1h = readJson(path.join(ROOT, 'research', 'results_1h', 'selection-lock.json')).lockedWinner;
  const lock15m = readJson(path.join(ROOT, 'research', 'results_v4', 'lock_15m_r3.json')).winner;

  // Verify real 3y funding files are contiguous 8h UTC
  for (const fname of [
    'okx_btcusdt_swap_funding_3y.json',
    'okx_ethusdt_swap_funding_3y.json',
    'okx_solusdt_swap_funding_3y.json',
  ]) {
    const fJson = readJson(path.join(DATA_DIR, fname));
    validateContiguous8hFunding(fJson.rows, fname);
    assert.ok(fJson.rows.length >= 3285, `${fname} expected >= 3285 8h rows`);
  }

  // 1a) BTC 1h causality at T=2400
  {
    const T = 2400;
    const dsTrunc = sliceDatasetPrefix1h(btc1h, T);
    const dsMut = mutateDatasetFuture(btc1h, T);
    const cutoffTime = dsTrunc.lastTime;
    const fundingTrunc = fundingBtc.filter(f => f.time <= cutoffTime);
    const fundingMut = mutateFundingFuture(fundingBtc, cutoffTime);

    const alignedFull = alignFundingToBarsCausal(btc1h.rows, fundingBtc);
    const alignedTrunc = alignFundingToBarsCausal(dsTrunc.rows, fundingTrunc);
    const alignedMut = alignFundingToBarsCausal(dsMut.rows, fundingMut);

    for (let i = 0; i < T; i++) {
      assert.deepEqual(alignedTrunc[i], alignedFull[i], `1h funding trunc mismatch at ${i}`);
      assert.deepEqual(alignedMut[i], alignedFull[i], `1h funding future mutation at ${i}`);
      if (alignedFull[i] !== null) {
        assert.ok(alignedFull[i].time <= btc1h.rows[i].time, `1h funding lookahead at ${i}`);
      }
    }

    const sigsFull = generateSignals1h(btc1h, lock1h.signalSpec).filter(s => s.barIndex < T);
    const sigsTrunc = generateSignals1h(dsTrunc, lock1h.signalSpec);
    const sigsMut = generateSignals1h(dsMut, lock1h.signalSpec).filter(s => s.barIndex < T);
    assert.deepEqual(sigsTrunc, sigsFull);
    assert.deepEqual(sigsMut, sigsFull);
    assert.ok(sigsTrunc.length >= 10);

    const ctxFull = precomputeFeatureContextV5(btc1h, alignedFull);
    const ctxTrunc = precomputeFeatureContextV5(dsTrunc, alignedTrunc);
    const ctxMut = precomputeFeatureContextV5(dsMut, alignedMut);

    for (const sig of sigsTrunc) {
      const fFull = extractCandidateFeaturesV5(btc1h, sig, sig.barIndex, alignedFull, ctxFull);
      const fTrunc = extractCandidateFeaturesV5(dsTrunc, sig, sig.barIndex, alignedTrunc, ctxTrunc);
      const fMut = extractCandidateFeaturesV5(dsMut, sig, sig.barIndex, alignedMut, ctxMut);
      assert.deepEqual(fTrunc, fFull, `1h feature trunc mismatch at bar ${sig.barIndex}`);
      assert.deepEqual(fMut, fFull, `1h feature mutation mismatch at bar ${sig.barIndex}`);

      const sFull = scoreCandidateV5(fFull, modelsBtc['1h']);
      const sTrunc = scoreCandidateV5(fTrunc, modelsBtc['1h']);
      const sMut = scoreCandidateV5(fMut, modelsBtc['1h']);
      assert.equal(sTrunc.probWin, sFull.probWin);
      assert.equal(sMut.probWin, sFull.probWin);
      assert.equal(sTrunc.sizeMult, sFull.sizeMult);
    }
  }

  // 1b) BTC 15m causality at T=5000
  {
    const T = 5000;
    const dsTrunc = sliceDatasetPrefix15m(btc15m, T);
    const dsMut = mutateDatasetFuture(btc15m, T);
    const cutoffTime = dsTrunc.lastTime;
    const fundingTrunc = fundingBtc.filter(f => f.time <= cutoffTime);
    const fundingMut = mutateFundingFuture(fundingBtc, cutoffTime);

    const alignedFull = alignFundingToBarsCausal(btc15m.rows, fundingBtc);
    const alignedTrunc = alignFundingToBarsCausal(dsTrunc.rows, fundingTrunc);
    const alignedMut = alignFundingToBarsCausal(dsMut.rows, fundingMut);
    assert.deepEqual(alignedTrunc, alignedFull.slice(0, T));
    assert.deepEqual(alignedMut.slice(0, T), alignedFull.slice(0, T));

    const sigsFull = generateSignals15mV4(btc15m, lock15m.fullSpec).filter(s => s.barIndex < T);
    const sigsTrunc = generateSignals15mV4(dsTrunc, lock15m.fullSpec);
    const sigsMut = generateSignals15mV4(dsMut, lock15m.fullSpec).filter(s => s.barIndex < T);
    assert.deepEqual(sigsTrunc, sigsFull);
    assert.deepEqual(sigsMut, sigsFull);
    assert.ok(sigsTrunc.length >= 10);

    const ctxFull = precomputeFeatureContextV5(btc15m, alignedFull, T - 1);
    const ctxTrunc = precomputeFeatureContextV5(dsTrunc, alignedTrunc);
    const ctxMut = precomputeFeatureContextV5(dsMut, alignedMut, T - 1);

    for (const sig of sigsTrunc) {
      const fFull = extractCandidateFeaturesV5(btc15m, sig, sig.barIndex, alignedFull, ctxFull);
      const fTrunc = extractCandidateFeaturesV5(dsTrunc, sig, sig.barIndex, alignedTrunc, ctxTrunc);
      const fMut = extractCandidateFeaturesV5(dsMut, sig, sig.barIndex, alignedMut, ctxMut);
      assert.deepEqual(fTrunc, fFull, `15m feature trunc mismatch at bar ${sig.barIndex}`);
      assert.deepEqual(fMut, fFull, `15m feature mutation mismatch at bar ${sig.barIndex}`);

      const sFull = scoreCandidateV5(fFull, modelsBtc['15m']);
      const sTrunc = scoreCandidateV5(fTrunc, modelsBtc['15m']);
      assert.equal(sTrunc.probWin, sFull.probWin);
    }
  }
});

test('2. Causal prefix-truncation & future-mutation invariance: signals_v5_alt + sim_engine_v5 (ETH & SOL + BTC)', () => {
  assert.ok(V41_ALT_DIAGNOSIS.factors.length >= 3);

  for (const [key, dataFile, fundingFile] of [
    ['ETH', 'okx_ethusdt_swap_1h_3y.json', 'okx_ethusdt_swap_funding_3y.json'],
    ['SOL', 'okx_solusdt_swap_1h_3y.json', 'okx_solusdt_swap_funding_3y.json'],
  ]) {
    const ds = readJson(path.join(DATA_DIR, dataFile));
    const funding = readJson(path.join(DATA_DIR, fundingFile)).rows;
    const cfg = ALT_ASSETS_V5[key];
    const T = 6000;

    const dsTrunc = sliceDatasetPrefix1h(ds, T);
    const dsMut = mutateDatasetFuture(ds, T);
    const cutoffTime = dsTrunc.lastTime;
    const fundingTrunc = funding.filter(f => f.time <= cutoffTime);
    const fundingMut = mutateFundingFuture(funding, cutoffTime);

    const sigsFull = generateSignalsAltV5(ds, key);
    const sigsTrunc = generateSignalsAltV5(dsTrunc, key);
    const sigsMut = generateSignalsAltV5(dsMut, key).filter(s => s.barIndex < T);

    assert.deepEqual(sigsTrunc, sigsFull.filter(s => s.barIndex < T), `${key}: alt signal prefix trunc failed`);
    assert.deepEqual(sigsMut, sigsTrunc, `${key}: alt signal future mutation failed`);
    assert.ok(sigsTrunc.length >= 20);

    for (const execProfile of ['STRICT_TAKER', 'EXCHANGE_POST_ONLY']) {
      const simOptsFull = {
        ...cfg.execOptions,
        execProfile,
        fundingRows: funding,
        intervalSeconds: 3600,
        start: 0,
        end: ds.rows.length,
      };
      const simOptsTrunc = {
        ...cfg.execOptions,
        execProfile,
        fundingRows: fundingTrunc,
        intervalSeconds: 3600,
        start: 0,
        end: T,
      };
      const simOptsMut = {
        ...cfg.execOptions,
        execProfile,
        fundingRows: fundingMut,
        intervalSeconds: 3600,
        start: 0,
        end: T,
      };

      const fullSim = simulateTradesV5(ds.rows, sigsFull, simOptsFull);
      const truncSim = simulateTradesV5(dsTrunc.rows, sigsTrunc, simOptsTrunc);
      const mutSim = simulateTradesV5(dsMut.rows, sigsMut, simOptsMut);

      assert.deepEqual(
        truncSim.trades,
        fullSim.trades.filter(t => t.exitIndex < T),
        `${key} ${execProfile}: sim_engine_v5 prefix truncation failed`,
      );
      assert.deepEqual(
        mutSim.trades,
        truncSim.trades,
        `${key} ${execProfile}: sim_engine_v5 future mutation failed`,
      );
    }
  }
});

// ============================================================================
// 2. ZERO HOLDOUT Y3 LEAKAGE & PYTHON VS JS PARITY (< 1e-12)
// ============================================================================
test('3. Zero Holdout Y3 leakage metadata audit + Python vs JS predict_proba parity (< 1e-12 across >= 50 real rows per model)', () => {
  const btcModelsPath = path.join(RESULTS_V5_DIR, 'ml_models_btc_v5.json');
  const altModelsPath = path.join(RESULTS_V5_DIR, 'ml_models_alt_v5.json');
  const btcSummary = readJson(path.join(RESULTS_V5_DIR, 'btc_v5_summary.json'));
  const altSummary = readJson(path.join(RESULTS_V5_DIR, 'multi_asset_v5_summary.json'));

  const btcModels = readJson(btcModelsPath);
  const altModels = readJson(altModelsPath);

  // Verify BTC chrono split & zero Holdout Y3 fit scope
  assert.deepEqual(btcModels.models['1h'].selectionMeta.calRange, [0, 8760]);
  assert.deepEqual(btcModels.models['1h'].selectionMeta.valRange, [8760, 17520]);
  assert.deepEqual(btcModels.models['1h'].selectionMeta.holdoutRangeUntouched, [17520, 26280]);
  assert.deepEqual(btcModels.models['15m'].selectionMeta.calRange, [0, 35040]);
  assert.deepEqual(btcModels.models['15m'].selectionMeta.valRange, [35040, 70080]);
  assert.deepEqual(btcModels.models['15m'].selectionMeta.holdoutRangeUntouched, [70080, 105120]);
  assert.ok(btcSummary.tracks.EXCHANGE_POST_ONLY.btc_15m.v50_ml.holdoutY3.totalNetPct > 0);
  assert.ok(btcSummary.tracks.EXCHANGE_POST_ONLY.btc_15m.v50_ml.holdoutY3.compoundedNetPct > 0);

  // Verify Altcoin honest promotion gate audit
  assert.deepEqual(altModels.qualifiedSymbols, []);
  assert.deepEqual(altSummary.qualifiedForLiveAltcoins, []);
  for (const sym of ['OKX:ETHUSDT.P', 'OKX:SOLUSDT.P']) {
    const m = altModels.models[sym];
    assert.deepEqual(m.selectionMeta.calRange, [0, 8760]);
    assert.deepEqual(m.selectionMeta.valRange, [8760, 17520]);
    assert.deepEqual(m.selectionMeta.holdoutRangeUntouched, [17520, 26280]);
    assert.equal(m.qualifiedForLive, false);
    assert.equal(m.holdoutY3Gate.qualifiedForLive, false);

    // Confirm gate arithmetic matches Y3 metrics honestly
    const crit = altModels.promotionGateCriteria;
    for (const y3 of [m.holdoutY3Gate.strictTakerY3, m.holdoutY3Gate.exchangePostOnlyY3]) {
      const passes = y3.count >= crit.minHoldoutY3Trades &&
        y3.winRatePct >= crit.minHoldoutY3WinRatePct &&
        y3.totalNetPct > crit.minHoldoutY3NetPct &&
        y3.profitFactor >= crit.minHoldoutY3ProfitFactor;
      assert.equal(passes, false, `${sym} unexpectedly met gate criteria while marked false`);
    }
  }

  // Extract >= 50 real candidate signal rows per stream and compare JS vs Python predict_proba
  const btc1h = readJson(path.join(DATA_DIR, 'okx_btcusdt_swap_1h_3y.json'));
  const btc15m = readJson(path.join(DATA_DIR, 'okx_btcusdt_swap_15m_3y.json'));
  const eth1h = readJson(path.join(DATA_DIR, 'okx_ethusdt_swap_1h_3y.json'));
  const sol1h = readJson(path.join(DATA_DIR, 'okx_solusdt_swap_1h_3y.json'));

  const fundBtc = readJson(path.join(DATA_DIR, 'okx_btcusdt_swap_funding_3y.json')).rows;
  const fundEth = readJson(path.join(DATA_DIR, 'okx_ethusdt_swap_funding_3y.json')).rows;
  const fundSol = readJson(path.join(DATA_DIR, 'okx_solusdt_swap_funding_3y.json')).rows;

  const lock1h = readJson(path.join(ROOT, 'research', 'results_1h', 'selection-lock.json')).lockedWinner;
  const lock15m = readJson(path.join(ROOT, 'research', 'results_v4', 'lock_15m_r3.json')).winner;

  const extractSamples = (ds, funding, signals, modelSpec, limitCount = 80) => {
    const aligned = alignFundingToBarsCausal(ds.rows, funding);
    const ctx = precomputeFeatureContextV5(ds, aligned);
    const rows = [];
    const jsProbs = [];
    for (const sig of signals.slice(0, limitCount)) {
      const fmap = extractCandidateFeaturesV5(ds, sig, sig.barIndex, aligned, ctx);
      const clean = {};
      for (const k of FEATURE_NAMES_V5) {
        clean[k] = Number.isFinite(fmap[k]) ? fmap[k] : null;
      }
      rows.push(clean);
      jsProbs.push(predictProbaV5(fmap, modelSpec));
    }
    assert.ok(rows.length >= 50, `Expected >= 50 real candidate rows, got ${rows.length}`);
    return { rows, jsProbs };
  };

  const sBtc1h = extractSamples(btc1h, fundBtc, generateSignals1h(btc1h, lock1h.signalSpec), btcModels.models['1h']);
  const sBtc15 = extractSamples(btc15m, fundBtc, generateSignals15mV4(btc15m, lock15m.fullSpec), btcModels.models['15m']);
  const sEth1h = extractSamples(eth1h, fundEth, generateSignalsAltV5(eth1h, 'ETH'), altModels.models['OKX:ETHUSDT.P']);
  const sSol1h = extractSamples(sol1h, fundSol, generateSignalsAltV5(sol1h, 'SOL'), altModels.models['OKX:SOLUSDT.P']);

  const pyScript = `
import json, sys, numpy as np
req = json.loads(sys.stdin.read())
btc_models = json.load(open(${JSON.stringify(btcModelsPath)}))["models"]
alt_models = json.load(open(${JSON.stringify(altModelsPath)}))["models"]

def expit(x):
    return 1.0 / (1.0 + np.exp(-x)) if x >= 0 else np.exp(x) / (1.0 + np.exp(x))

def eval_tree(tree, x):
    idx = 0
    while tree["feature"][idx] >= 0:
        f = tree["feature"][idx]
        if np.float32(x[f]) <= tree["threshold"][idx]:
            idx = tree["childrenLeft"][idx]
        else:
            idx = tree["childrenRight"][idx]
    return tree["value"][idx]

def predict_one(fmap, spec):
    x = np.array([np.nan if fmap.get(k) is None else float(fmap[k]) for k in spec["featureNames"]], dtype=np.float64)
    meds = np.array(spec["imputer"]["medians"], dtype=np.float64)
    nan_mask = np.isnan(x)
    x[nan_mask] = meds[nan_mask]
    means = np.array(spec["scaler"]["mean"], dtype=np.float64)
    scales = np.array(spec["scaler"]["scale"], dtype=np.float64)
    scales = np.where(scales == 0, 1.0, scales)
    z = (x - means) / scales
    if spec["modelType"] == "logistic_regression":
        coef = np.array(spec["classifier"]["coef"], dtype=np.float64)
        logit = float(spec["classifier"]["intercept"]) + float(np.dot(coef, z))
        return float(expit(logit))
    raw = float(spec["classifier"]["initScore"])
    lr = float(spec["classifier"]["learningRate"])
    for tr in spec["classifier"]["trees"]:
        raw += lr * eval_tree(tr, z)
    return float(expit(raw))

print(json.dumps({
    "btc1h": [predict_one(m, btc_models["1h"]) for m in req["btc1h"]],
    "btc15": [predict_one(m, btc_models["15m"]) for m in req["btc15"]],
    "eth1h": [predict_one(m, alt_models["OKX:ETHUSDT.P"]) for m in req["eth1h"]],
    "sol1h": [predict_one(m, alt_models["OKX:SOLUSDT.P"]) for m in req["sol1h"]],
}))
`;

  const pyOut = JSON.parse(execFileSync('python3', ['-c', pyScript], {
    input: JSON.stringify({
      btc1h: sBtc1h.rows,
      btc15: sBtc15.rows,
      eth1h: sEth1h.rows,
      sol1h: sSol1h.rows,
    }),
    encoding: 'utf8',
  }));

  for (const [label, jsArr, pyArr] of [
    ['BTC 1h', sBtc1h.jsProbs, pyOut.btc1h],
    ['BTC 15m', sBtc15.jsProbs, pyOut.btc15],
    ['ETH 1h', sEth1h.jsProbs, pyOut.eth1h],
    ['SOL 1h', sSol1h.jsProbs, pyOut.sol1h],
  ]) {
    let maxDiff = 0;
    for (let i = 0; i < jsArr.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(jsArr[i] - pyArr[i]));
    }
    assert.ok(maxDiff < EPS, `${label} Python vs JS maxDiff=${maxDiff} >= 1e-12`);
  }
});

// ============================================================================
// 3. CONSERVATIVE EXCHANGE_POST_ONLY & 8H FUNDING ACCOUNTING
// ============================================================================
test('4. Conservative EXCHANGE_POST_ONLY maker penetration, taker SL accounting, and 8h funding settlement', () => {
  const t0 = 1788220800; // exact 8h UTC boundary (t0 % 28800 === 0)
  assert.equal(t0 % 28800, 0);

  // Case A: Pure maker entry + SL/TP intra-bar conflict -> SL wins with taker fee & slippage
  const slConflict = [];
  for (let t = t0 - 3600; t <= t0 + 14400; t += 3600) {
    slConflict.push({ time: t, open: 100.5, high: 100.8, low: 100.2, close: 100.5, volume: 10 });
  }
  Object.assign(slConflict[0], { open: 100, high: 100.5, low: 99.5, close: 100 });
  Object.assign(slConflict[1], { open: 100.4, high: 100.6, low: 99.995, close: 100.3 }); // <0.01% buf -> NO FILL
  Object.assign(slConflict[2], { open: 100.3, high: 100.5, low: 99.985, close: 100.2 }); // <=99.99 -> FILLS @ 100
  Object.assign(slConflict[3], { open: 100.2, high: 104.5, low: 97.5, close: 103.5 });  // BOTH SL(98) and TP(104) touched -> SL MUST WIN

  const simA = simulateTradesV5(slConflict, [{ barIndex: 0, side: 1, atr: 2, limitPrice: 100 }], {
    warmup: 0,
    cooldown: 4,
    entryMode: 'LIMIT_PULLBACK',
    limitExpiryBars: 4,
    execProfile: 'EXCHANGE_POST_ONLY',
    makerFeePct: 0.02,
    takerFeePct: 0.05,
    slippagePct: 0.025,
    makerBufferPct: 0.01,
    stopAtr: 1.0,
    rewardRisk: 2.0,
    maxHoldBars: 30,
    fixedLev: 1.0,
    intervalSeconds: 3600,
  });
  assert.equal(simA.count, 1);
  assert.equal(simA.trades[0].entryIndex, 2);
  assert.equal(simA.trades[0].exitReason, 'SL');
  assert.ok(Math.abs(simA.trades[0].entry - 100) < EPS);
  assert.ok(Math.abs(simA.trades[0].exit - 98 * (1 - 0.00025)) < EPS);
  const expectedGrossA = ((98 * (1 - 0.00025) - 100) / 100) * 100;
  assert.ok(Math.abs(simA.trades[0].netPct - (expectedGrossA - 0.07)) < EPS);

  // Case B: Partial TP1 (50% @ +1R) + 8h funding settlement on remaining 0.5x + BE runner exit
  const contiguous = [];
  for (let t = t0 - 3600; t <= t0 + 32400; t += 3600) {
    contiguous.push({ time: t, open: 101.5, high: 101.8, low: 101.2, close: 101.5, volume: 10 });
  }
  Object.assign(contiguous[0], { open: 100, high: 100.5, low: 99.5, close: 100 });
  Object.assign(contiguous[1], { open: 100.4, high: 100.6, low: 99.995, close: 100.3 });
  Object.assign(contiguous[2], { open: 100.3, high: 100.5, low: 99.985, close: 100.2 }); // FILLS @ 100
  Object.assign(contiguous[3], { open: 100.2, high: 102.5, low: 100.1, close: 101.5 }); // TP1 @ 102, closes 101.5 >= 101
  Object.assign(contiguous[contiguous.length - 1], { open: 101.4, high: 104.5, low: 97.5, close: 98.0 });

  const fundingRows = [
    { time: t0, fundingRate: 0.001 }, // before entry -> must NOT apply
    { time: t0 + 28800, fundingRate: 0.0006 }, // +0.06% while remFrac=0.5 -> long pays -0.03% (1x)
  ];

  const sim = simulateTradesV5(contiguous, [{ barIndex: 0, side: 1, atr: 2, limitPrice: 100 }], {
    warmup: 0,
    cooldown: 4,
    entryMode: 'LIMIT_PULLBACK',
    limitExpiryBars: 4,
    execProfile: 'EXCHANGE_POST_ONLY',
    makerFeePct: 0.02,
    takerFeePct: 0.05,
    slippagePct: 0.025,
    makerBufferPct: 0.01,
    stopAtr: 1.0,
    rewardRisk: 2.0,
    tp1TriggerR: 1.0,
    tp1QtyPct: 50,
    tp1LockOffsetR: 0.5,
    maxHoldBars: 30,
    fixedLev: 2.0,
    fundingRows,
    intervalSeconds: 3600,
  });

  assert.equal(sim.count, 1);
  const tr = sim.trades[0];
  assert.equal(tr.entryIndex, 2); // skipped bar 1 insufficient penetration
  assert.equal(tr.tp1Hit, true);
  assert.equal(tr.exitReason, 'BE'); // runner locked at +0.5R exits BE (beating TP)
  assert.ok(Math.abs(tr.entry - 100) < EPS);
  assert.ok(Math.abs(tr.exit - 101 * (1 - 0.00025)) < EPS); // taker slippage on BE stop
  // Funding: 0.5 * (-0.06%) * 2x = -0.06%
  assert.ok(Math.abs(tr.fundingCashflowPct - (-0.06)) < EPS);
  assert.ok(Math.abs(tr.fundingDragPct - 0.06) < EPS);

  // Portfolio leverage cap check
  const p = simulatePortfolioV5([
    { id: 'A', rows: contiguous, trades: [{ entryIndex: 2, exitIndex: 6, lev: 3.0, grossPct: 3.0, netPct: 2.7 }] },
    { id: 'B', rows: contiguous, trades: [{ entryIndex: 3, exitIndex: 7, lev: 2.0, grossPct: 2.0, netPct: 1.8 }] },
  ], { maxTotalOpenLev: 4.0 });
  assert.equal(p.peakOpenLev, 4.0);
  assert.equal(p.scaledByCapCount, 1); // B scaled from 2.0 -> 1.0 (factor 0.5)
  assert.ok(Math.abs(p.totalNetPct - (2.7 + 0.9)) < 1e-10);
});

// ============================================================================
// 4. SECURITY & SAFETY AUDIT ON standalone/ + .gitignore
// ============================================================================
test('5. Security & safety audit: zero innerHTML/eval in standalone/public/, 127.0.0.1 bind, .env gitignored, PAPER default lock', async () => {
  // a) Static Zero-XSS check on ALL files in standalone/public/
  const publicDir = path.join(ROOT, 'standalone', 'public');
  const publicFiles = fs.readdirSync(publicDir);
  assert.ok(publicFiles.includes('index.html') && publicFiles.includes('app.js'));
  const dangerousSinks = [
    /\.innerHTML\b/i,
    /\.outerHTML\b/i,
    /insertAdjacentHTML\b/i,
    /document\.write\b/i,
    /\beval\s*\(/i,
    /new\s+Function\b/i,
    /setHTMLUnsafe\b/i,
  ];
  for (const fname of publicFiles) {
    const content = fs.readFileSync(path.join(publicDir, fname), 'utf8');
    for (const pat of dangerousSinks) {
      assert.equal(pat.test(content), false, `Dangerous sink ${pat} found in standalone/public/${fname}`);
    }
    if (fname.endsWith('.html')) {
      assert.equal(/\son[a-z]+\s*=/i.test(content), false, `Inline handler in ${fname}`);
      assert.equal(content.match(/<script(?![^>]*\bsrc=)[^>]*>/gi), null, `Inline script in ${fname}`);
    }
  }

  // b) .gitignore ignores .env and .env.* while keeping .env.example
  const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env$/m);
  assert.match(gitignore, /^\.env\.\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
  try {
    execFileSync('git', ['check-ignore', '-q', '.env'], { cwd: ROOT });
  } catch {
    assert.fail('git check-ignore failed for .env');
  }

  // c) Loopback-only HTTP host enforcement & PAPER safety defaults
  assert.throws(() => assertLoopbackHost('0.0.0.0'), /Security policy violation/);
  assert.throws(() => assertLoopbackHost('::'), /Security policy violation/);
  assert.throws(() => assertLoopbackHost('192.168.1.50'), /Security policy violation/);
  assert.equal(assertLoopbackHost('127.0.0.1'), '127.0.0.1');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt5-audit-'));
  try {
    const emptyEnvCfg = loadConfig({ cwd: tmpDir, useProcessEnv: false });
    assert.equal(emptyEnvCfg.executionMode, 'PAPER');
    assert.equal(emptyEnvCfg.dryRun, true);
    assert.equal(emptyEnvCfg.host, '127.0.0.1');
    assert.equal(emptyEnvCfg.port, 4180);
    assert.ok(emptyEnvCfg.maxLeverageCap <= 3.0);
    assert.throws(() => assertLiveOrderSafety(emptyEnvCfg, 'token'), /EXECUTION_MODE/);

    const secretCfg = loadConfig({
      cwd: ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        OKX_API_KEY: 'audit-okx-key-123',
        OKX_API_SECRET: 'audit-okx-sec-456',
        OKX_PASSPHRASE: 'audit-okx-pass-789',
        LIVE_CONFIRM_TOKEN: 'audit-live-tok-000',
      },
    });
    assert.ok(!JSON.stringify(secretCfg).includes('audit-okx-sec-456'));
    assert.ok(!JSON.stringify(redactConfig(secretCfg)).includes('audit-okx-key-123'));
    assert.ok(!scrubSecrets('Leak OKX_API_SECRET=audit-okx-sec-456', secretCfg).includes('audit-okx-sec-456'));

    const store = new StandaloneStore({ dbPath: path.join(tmpDir, 'audit.sqlite'), allowedBaseDir: tmpDir });
    const runtimeSpecs = await loadRuntimeSpecs(ROOT);
    assert.equal(runtimeSpecs.hasV5Engine, true);
    assert.equal(runtimeSpecs.hasV5Ml, true);

    const srv = createStandaloneServer({ config: secretCfg, store, runtimeSpecs });
    try {
      const bound = await srv.start();
      assert.equal(bound.host, '127.0.0.1');
      const base = `http://${bound.host}:${bound.port}`;
      const res = await fetch(`${base}/api/status`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(!body.includes('audit-okx-key-123'));
      assert.ok(!body.includes('audit-okx-sec-456'));
      assert.ok(!body.includes('audit-okx-pass-789'));
      assert.ok(!body.includes('audit-live-tok-000'));
      const json = JSON.parse(body);
      assert.equal(json.config.executionMode, 'PAPER');
      assert.equal(json.config.dryRun, true);
      assert.equal(json.models.v5MlReady, true);

      // Verify /api/mode rejects LIVE_ARMED without valid LIVE_CONFIRM_TOKEN
      const modeRes = await fetch(`${base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionMode: 'LIVE_ARMED', dryRun: false, confirmToken: 'bad' }),
      });
      assert.equal(modeRes.status, 403);
    } finally {
      await srv.stop();
      store.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
