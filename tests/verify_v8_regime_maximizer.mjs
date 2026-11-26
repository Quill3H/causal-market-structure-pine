import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { alignFundingToBarsCausal } from '../research/fetch_okx_derivs.mjs';
import { scoreCandidateV5 } from '../research/ml_inference.mjs';
import {
  CRYPTO_REGIMES_V8,
  precomputeAssetRegimeV8,
  precomputeCryptoBreadthV8,
  precomputeEquityRegimeV8,
} from '../research/regime_engine_v8.mjs';
import {
  applyV8DirectionalModels,
  extractCandidateFeaturesV8,
  generateAsymmetricSignalsV8,
  sliceDatasetPrefixV8,
} from '../research/regime_v8_btc_bnb.mjs';
import {
  applyV8EthSolModelToSignals,
  extractFeatureMapV8,
  generateEthSolStreamSignalsV8,
} from '../research/regime_v8_eth_sol.mjs';
import {
  simulatePortfolioV7,
  simulateTradesV7,
} from '../research/sim_engine_v7.mjs';
import { precomputeOrderflowContextV6 } from '../research/suite_v6_btc_bnb.mjs';
import { precomputeEthCrossContextV6 } from '../research/suite_v6_eth_sol.mjs';
import {
  sliceEquityDatasetPrefix,
  sliceMacroPrefix,
} from '../research/suite_v6_stocks.mjs';
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
const REPO_ROOT = path.resolve(HERE, '..');
const DATA_DIR = path.join(REPO_ROOT, 'data');
const RESULTS_V8 = path.join(REPO_ROOT, 'research', 'results_v8');

const jsonCache = new Map();
function readJsonCached(filePath) {
  if (!jsonCache.has(filePath)) {
    jsonCache.set(filePath, JSON.parse(fs.readFileSync(filePath, 'utf8')));
  }
  return jsonCache.get(filePath);
}

function makeTmpDir(prefix = 'verify-v8-') {
  return fs.mkdtempSync(path.join(REPO_ROOT, 'data', prefix));
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

function sliceByMaxTime(ds, maxTimeSec) {
  let endLen = 0;
  while (endLen < ds.rows.length && ds.rows[endLen].time <= maxTimeSec) endLen++;
  return sliceDatasetPrefixV8(ds, Math.max(1, endLen));
}

function mutateFutureCryptoAtTime(ds, cutoffTimeSec) {
  const rows = ds.rows.map(r => {
    if (r.time <= cutoffTimeSec) return r;
    const mult = r.time % 7200 === 0 ? 3.1 : 0.25;
    const vol = (r.volume || 100) * 16;
    return {
      ...r,
      open: r.open * mult,
      high: r.high * mult * 1.35,
      low: r.low * mult * 0.65,
      close: r.close * mult,
      volume: vol,
      takerBuyVol: Number.isFinite(r.takerBuyVol) ? (r.time % 7200 === 0 ? vol * 0.99 : vol * 0.01) : r.takerBuyVol,
    };
  });

  const tfSecMap = { '1h': 3600, '4h': 14400, '1d': 86400 };
  const htf = {};
  for (const tf of Object.keys(ds.htf || {})) {
    const h = ds.htf[tf];
    const tfSec = h.intervalSeconds ?? tfSecMap[tf] ?? 3600;
    htf[tf] = {
      ...h,
      rows: h.rows.map(hr => (
        hr.time + tfSec > cutoffTimeSec
          ? {
              ...hr,
              open: hr.open * 2.8,
              high: hr.high * 3.3,
              low: hr.low * 0.3,
              close: hr.close * 2.7,
              volume: (hr.volume || 100) * 12,
            }
          : hr
      )),
    };
  }

  const fundingRows = Array.isArray(ds.fundingRows)
    ? ds.fundingRows.map(f => (f.time > cutoffTimeSec ? { ...f, fundingRate: -0.08 } : f))
    : undefined;

  return { ...ds, rows, htf, ...(fundingRows ? { fundingRows } : {}) };
}

function mutateFutureEquity(ds, cutoffBars) {
  const cutoffTime = ds.rows[cutoffBars - 1].time;
  const rows = ds.rows.map((r, i) => (
    i < cutoffBars
      ? r
      : { ...r, open: r.open * 2.5, high: r.high * 3.0, low: r.low * 0.4, close: r.close * 2.4 }
  ));
  const htf = {};
  for (const tf of Object.keys(ds.htf || {})) {
    const h = ds.htf[tf];
    const tfSec = tf === '1wk' ? 604800 : 86400;
    htf[tf] = {
      ...h,
      rows: h.rows.map(hr => (
        hr.time + tfSec > cutoffTime
          ? { ...hr, open: hr.open * 2.5, high: hr.high * 3.0, low: hr.low * 0.4, close: hr.close * 2.4 }
          : hr
      )),
    };
  }
  return { ...ds, rows, htf };
}

function mutateFutureMacro(macro, cutoffTime) {
  return {
    ...macro,
    vixRows: (macro.vixRows || []).map(r => (r.time > cutoffTime ? { ...r, close: 95, high: 99, low: 88, open: 92 } : r)),
    tnxRows: (macro.tnxRows || []).map(r => (r.time > cutoffTime ? { ...r, close: 22, high: 25, low: 19, open: 21 } : r)),
  };
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

describe('1. v8.0 Causal Regime Engine & All 8 Asymmetric Crypto Streams Causality', () => {
  const btc1h = readJsonCached(path.join(DATA_DIR, STREAM_FILES.BTC_1h));
  const bnb1h = readJsonCached(path.join(DATA_DIR, STREAM_FILES.BNB_1h));
  const sol1h = readJsonCached(path.join(DATA_DIR, STREAM_FILES.SOL_1h));
  const eth1h = readJsonCached(path.join(DATA_DIR, STREAM_FILES.ETH_1h));

  const cutoff1h = 28000;
  const cutoffTime = btc1h.rows[cutoff1h - 1].time;

  const breadthFull = precomputeCryptoBreadthV8({
    BTCUSDT: btc1h,
    ETHUSDT: eth1h,
    SOLUSDT: sol1h,
    BNBUSDT: bnb1h,
  });
  const breadthPrefix = precomputeCryptoBreadthV8({
    BTCUSDT: sliceByMaxTime(btc1h, cutoffTime),
    ETHUSDT: sliceByMaxTime(eth1h, cutoffTime),
    SOLUSDT: sliceByMaxTime(sol1h, cutoffTime),
    BNBUSDT: sliceByMaxTime(bnb1h, cutoffTime),
  });
  const breadthMut = precomputeCryptoBreadthV8({
    BTCUSDT: mutateFutureCryptoAtTime(btc1h, cutoffTime),
    ETHUSDT: mutateFutureCryptoAtTime(eth1h, cutoffTime),
    SOLUSDT: mutateFutureCryptoAtTime(sol1h, cutoffTime),
    BNBUSDT: mutateFutureCryptoAtTime(bnb1h, cutoffTime),
  });

  it('regime_engine_v8 breadth, 1h/15m crypto regime & 1d equity regime are 100% invariant to future truncation & mutation', () => {
    for (const [label, ds] of [
      ['BTC_1h', btc1h],
      ['SOL_15m', readJsonCached(path.join(DATA_DIR, STREAM_FILES.SOL_15m))],
    ]) {
      const dsPrefix = sliceByMaxTime(ds, cutoffTime);
      const dsMut = mutateFutureCryptoAtTime(ds, cutoffTime);
      const regF = precomputeAssetRegimeV8(ds, breadthFull);
      const regP = precomputeAssetRegimeV8(dsPrefix, breadthPrefix);
      const regM = precomputeAssetRegimeV8(dsMut, breadthMut);

      const nCheck = dsPrefix.rows.length;
      for (let i = 0; i < nCheck; i++) {
        assert.equal(regP.regime[i], regF.regime[i], `${label} prefix regime mismatch @${i}`);
        assert.equal(regM.regime[i], regF.regime[i], `${label} mut regime mismatch @${i}`);
        assert.ok(Math.abs(regP.trendScore[i] - regF.trendScore[i]) < 1e-12);
        assert.ok(Math.abs(regM.trendScore[i] - regF.trendScore[i]) < 1e-12);
        assert.ok(Math.abs(regP.breadthBearRatio[i] - regF.breadthBearRatio[i]) < 1e-12);
        assert.equal(regP.h4RallyExh[i], regF.h4RallyExh[i]);
        assert.ok(Math.abs(regP.longSizeMult[i] - regF.longSizeMult[i]) < 1e-12);
        assert.ok(Math.abs(regP.shortSizeMult[i] - regF.shortSizeMult[i]) < 1e-12);
        if (regF.regime[i] === CRYPTO_REGIMES_V8.BEAR_SQUEEZE) {
          assert.equal(regF.shortSizeMult[i], 0, 'BEAR_SQUEEZE must zero shortSizeMult');
        }
      }
    }

    // US Equity 1d regime causality
    const spyFull = readJsonCached(path.join(DATA_DIR, 'equities10y_sp500_1d.json'));
    const macroFull = readJsonCached(path.join(DATA_DIR, 'equities10y_macro_1d.json'));
    const eqCutoff = 1800;
    const eqCutTime = spyFull.rows[eqCutoff - 1].time;

    const eqRegF = precomputeEquityRegimeV8(spyFull, macroFull);
    const eqRegP = precomputeEquityRegimeV8(
      sliceEquityDatasetPrefix(spyFull, eqCutoff),
      sliceMacroPrefix(macroFull, eqCutTime),
    );
    const eqRegM = precomputeEquityRegimeV8(
      mutateFutureEquity(spyFull, eqCutoff),
      mutateFutureMacro(macroFull, eqCutTime),
    );

    for (let i = 0; i < eqCutoff; i++) {
      assert.equal(eqRegP.regime[i], eqRegF.regime[i], `SPY prefix regime @${i}`);
      assert.equal(eqRegM.regime[i], eqRegF.regime[i], `SPY mut regime @${i}`);
      assert.ok(Math.abs(eqRegP.trendScore[i] - eqRegF.trendScore[i]) < 1e-12);
      assert.ok(Math.abs(eqRegM.trendScore[i] - eqRegF.trendScore[i]) < 1e-12);
    }
  });

  it('all 8 v8 asymmetric streams (BTC/BNB/SOL/ETH x 1h/15m) enforce Bear-Squeeze blocking & 100% causal signals/ML/trades', () => {
    const btcBnbModels = readJsonCached(path.join(RESULTS_V8, 'models_v8_btc_bnb.json')).models;
    const ethSolModels = readJsonCached(path.join(RESULTS_V8, 'models_v8_eth_sol.json')).models;
    const btc15Full = readJsonCached(path.join(DATA_DIR, STREAM_FILES.BTC_15m));
    const btc15Prefix = sliceByMaxTime(btc15Full, cutoffTime);
    const btc15Mut = mutateFutureCryptoAtTime(btc15Full, cutoffTime);
    const btc1hPrefix = sliceByMaxTime(btc1h, cutoffTime);
    const btc1hMut = mutateFutureCryptoAtTime(btc1h, cutoffTime);

    for (const streamKey of Object.keys(STREAM_FILES)) {
      const isBtcBnb = streamKey.startsWith('BTC') || streamKey.startsWith('BNB');
      const isEth = streamKey.startsWith('ETH');
      const mSpec = isBtcBnb ? btcBnbModels[streamKey] : ethSolModels[streamKey];
      const dsFull = readJsonCached(path.join(DATA_DIR, STREAM_FILES[streamKey]));
      const dsPrefix = sliceByMaxTime(dsFull, cutoffTime);
      const dsMut = mutateFutureCryptoAtTime(dsFull, cutoffTime);
      const cutLen = dsPrefix.rows.length;

      const regFull = precomputeAssetRegimeV8(dsFull, breadthFull);
      const regPrefix = precomputeAssetRegimeV8(dsPrefix, breadthPrefix);
      const regMut = precomputeAssetRegimeV8(dsMut, breadthMut);

      const fundFull = alignFundingToBarsCausal(dsFull.rows, dsFull.fundingRows ?? []);
      const fundPrefix = alignFundingToBarsCausal(dsPrefix.rows, dsPrefix.fundingRows ?? []);
      const fundMut = alignFundingToBarsCausal(dsMut.rows, dsMut.fundingRows ?? []);

      const btcFull = isEth ? (dsFull.intervalSeconds <= 900 ? btc15Full : btc1h) : null;
      const btcPrefix = isEth ? (dsFull.intervalSeconds <= 900 ? btc15Prefix : btc1hPrefix) : null;
      const btcMut = isEth ? (dsFull.intervalSeconds <= 900 ? btc15Mut : btc1hMut) : null;

      const sigFull = (isBtcBnb
        ? generateAsymmetricSignalsV8(streamKey, dsFull, mSpec.structuralSpec.sigSpec, fundFull, regFull)
        : generateEthSolStreamSignalsV8(streamKey, dsFull, mSpec.structuralSpec.sigSpec, regFull, btcFull)
      ).filter(s => s.barIndex < cutLen);
      const sigPrefix = isBtcBnb
        ? generateAsymmetricSignalsV8(streamKey, dsPrefix, mSpec.structuralSpec.sigSpec, fundPrefix, regPrefix)
        : generateEthSolStreamSignalsV8(streamKey, dsPrefix, mSpec.structuralSpec.sigSpec, regPrefix, btcPrefix);
      const sigMut = (isBtcBnb
        ? generateAsymmetricSignalsV8(streamKey, dsMut, mSpec.structuralSpec.sigSpec, fundMut, regMut)
        : generateEthSolStreamSignalsV8(streamKey, dsMut, mSpec.structuralSpec.sigSpec, regMut, btcMut)
      ).filter(s => s.barIndex < cutLen);

      assert.ok(sigFull.length >= 40, `${streamKey} expected >= 40 asymmetric signals before cutoff`);
      assertSignalArraysMatch(sigPrefix, sigFull, `${streamKey} prefix signals`);
      assertSignalArraysMatch(sigMut, sigFull, `${streamKey} mut signals`);

      // Structural regime guard: zero Shorts during BULL_TREND/BEAR_SQUEEZE, zero Longs during BEAR_TREND/BEAR_SQUEEZE
      for (const s of sigFull) {
        const reg = regFull.regime[s.barIndex];
        assert.notEqual(reg, CRYPTO_REGIMES_V8.BEAR_SQUEEZE, `${streamKey} leaked signal inside BEAR_SQUEEZE`);
        if (s.side === 1) assert.notEqual(reg, CRYPTO_REGIMES_V8.BEAR_TREND, `${streamKey} leaked Long inside BEAR_TREND`);
        if (s.side === -1) assert.notEqual(reg, CRYPTO_REGIMES_V8.BULL_TREND, `${streamKey} leaked Short inside BULL_TREND`);
      }

      const mlFull = isBtcBnb
        ? applyV8DirectionalModels(dsFull, sigFull, fundFull, regFull, mSpec)
        : applyV8EthSolModelToSignals(streamKey, dsFull, sigFull, fundFull, mSpec, regFull, btcFull);
      const mlPrefix = isBtcBnb
        ? applyV8DirectionalModels(dsPrefix, sigPrefix, fundPrefix, regPrefix, mSpec)
        : applyV8EthSolModelToSignals(streamKey, dsPrefix, sigPrefix, fundPrefix, mSpec, regPrefix, btcPrefix);
      const mlMut = isBtcBnb
        ? applyV8DirectionalModels(dsMut, sigMut, fundMut, regMut, mSpec)
        : applyV8EthSolModelToSignals(streamKey, dsMut, sigMut, fundMut, mSpec, regMut, btcMut);

      assert.ok(mlFull.length >= 20, `${streamKey} expected >= 20 ML signals before cutoff`);
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
        .trades.filter(t => t.exitIndex < cutLen - 1);
      const trPrefix = simulateTradesV7(dsPrefix.rows, mlPrefix, { ...simOpts, fundingRows: dsPrefix.fundingRows })
        .trades.filter(t => t.exitIndex < cutLen - 1);
      const trMut = simulateTradesV7(dsMut.rows, mlMut, { ...simOpts, fundingRows: dsMut.fundingRows })
        .trades.filter(t => t.exitIndex < cutLen - 1);

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

describe('2. Zero Y5 Leakage & < 1e-12 Python sklearn vs JS Parity (All 16 Directional v8 Models)', () => {
  it('verifies strict Cal/Val/Holdout index isolation across all 8 stream model specs & screening', () => {
    const btcBnb = readJsonCached(path.join(RESULTS_V8, 'models_v8_btc_bnb.json')).models;
    const ethSol = readJsonCached(path.join(RESULTS_V8, 'models_v8_eth_sol.json')).models;

    for (const [key, m] of Object.entries({ ...btcBnb, ...ethSol })) {
      assert.ok(m.longModel && m.shortModel, `${key} missing separate longModel/shortModel`);
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
  });

  it('achieves < 1e-12 predict_proba & pass parity between Python sklearn and JS across ALL 16 directional models', () => {
    const btcBnb = readJsonCached(path.join(RESULTS_V8, 'models_v8_btc_bnb.json')).models;
    const ethSol = readJsonCached(path.join(RESULTS_V8, 'models_v8_eth_sol.json')).models;
    const allModels = { ...btcBnb, ...ethSol };

    const btc1h = readJsonCached(path.join(DATA_DIR, STREAM_FILES.BTC_1h));
    const btc15 = readJsonCached(path.join(DATA_DIR, STREAM_FILES.BTC_15m));
    const breadth = precomputeCryptoBreadthV8({
      BTCUSDT: btc1h,
      ETHUSDT: readJsonCached(path.join(DATA_DIR, STREAM_FILES.ETH_1h)),
      SOLUSDT: readJsonCached(path.join(DATA_DIR, STREAM_FILES.SOL_1h)),
      BNBUSDT: readJsonCached(path.join(DATA_DIR, STREAM_FILES.BNB_1h)),
    });

    const tasks = [];
    for (const streamKey of Object.keys(STREAM_FILES)) {
      const mEntry = allModels[streamKey];
      const ds = readJsonCached(path.join(DATA_DIR, STREAM_FILES[streamKey]));
      const alignedFunding = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
      const regCtx = precomputeAssetRegimeV8(ds, breadth);
      const isBtcBnb = streamKey.startsWith('BTC') || streamKey.startsWith('BNB');
      const isEth = streamKey.startsWith('ETH');
      const btcDs = isEth ? (ds.intervalSeconds <= 900 ? btc15 : btc1h) : null;

      const sigs = isBtcBnb
        ? generateAsymmetricSignalsV8(streamKey, ds, mEntry.structuralSpec.sigSpec, alignedFunding, regCtx)
        : generateEthSolStreamSignalsV8(streamKey, ds, mEntry.structuralSpec.sigSpec, regCtx, btcDs);

      const ofCtx = isBtcBnb ? precomputeOrderflowContextV6(ds, alignedFunding) : null;
      const altCtx = isBtcBnb
        ? null
        : {
            isEth,
            ethCtx: isEth ? precomputeEthCrossContextV6(ds, btcDs, alignedFunding) : null,
            ofCtx: isEth ? null : precomputeOrderflowContextV6(ds, alignedFunding),
            regimeCtx: regCtx,
          };

      for (const [side, dirKey] of [[1, 'longModel'], [-1, 'shortModel']]) {
        const dirModel = mEntry[dirKey];
        const sideSigs = sigs.filter(s => s.side === side).slice(0, 60);
        assert.ok(sideSigs.length >= 25, `${streamKey} ${dirKey} expected >= 25 real candidates (got ${sideSigs.length})`);
        const rows = sideSigs.map(s => {
          const fMap = isBtcBnb
            ? extractCandidateFeaturesV8(ds, s, s.barIndex, alignedFunding, ofCtx, regCtx)
            : extractFeatureMapV8(streamKey, ds, s, s.barIndex, alignedFunding, altCtx, btcDs);
          const sc = scoreCandidateV5(fMap, dirModel);
          const vec = dirModel.featureNames.map(k => (Number.isFinite(fMap[k]) ? fMap[k] : null));
          return { vec, jsProb: sc.probWin, jsPass: sc.pass };
        });
        tasks.push({ key: `${streamKey}:${dirKey}`, modelSpec: dirModel, rows });
      }
    }

    assert.equal(tasks.length, 16, 'Expected 16 directional v8 models (8 streams x Long/Short)');

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
    key = task['key']
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
    out[key] = {
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

    for (const t of tasks) {
      const r = res[t.key];
      assert.ok(r && r.count >= 25, `Expected >= 25 verified rows for ${t.key}`);
      assert.equal(r.passMismatch, 0, `${t.key} pass mismatch`);
      assert.ok(r.maxAbsDiff < 1e-12, `${t.key} Py vs JS maxAbsDiff=${r.maxAbsDiff}`);
    }
  });
});

describe('3. Intra-Bar Zero-Liquidation Physics Across All 61 UTC Months & v8 Tiers', () => {
  it('verifies all 3 v8 tiers & US Futures v8 have liquidationCount === 0 across 61 months + adversarial cross-margin liq works', () => {
    const maxV8 = readJsonCached(path.join(RESULTS_V8, 'maximized_v8_summary.json'));
    for (const tierKey of ['TIER_1_SAFE_75WR', 'TIER_2_BALANCED_75WR', 'TIER_3_MAXIMIZED_30MO_75WR']) {
      const tier = maxV8.tiers[tierKey];
      assert.ok(tier, `Missing tier ${tierKey}`);
      for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
        const p = tier.profiles[prof];
        assert.ok(p, `Missing profile ${prof} for ${tierKey}`);
        for (const winKey of ['calVal_48m', 'blindHoldoutY5_12m', 'full5y_60m']) {
          const w = p[winKey];
          assert.equal(w.liquidationCount, 0, `${tierKey}.${prof}.${winKey} liquidationCount !== 0`);
          assert.equal(w.sweepLiquidationCount, 0, `${tierKey}.${prof}.${winKey} sweepLiquidationCount !== 0`);
          assert.equal(w.zeroLiquidationBothModes, true);
        }
        assert.equal(p.full5y_60m.totalMonths, 61);
        assert.ok(p.full5y_60m.winRatePct >= 75.0, `${tierKey}.${prof} full5y WR ${p.full5y_60m.winRatePct}% < 75%`);
        assert.ok(Array.isArray(p.full5y_60m.monthlyTable) && p.full5y_60m.monthlyTable.length === 61);
      }
    }

    assert.equal(maxV8.equitiesAndFuturesV8.futures2y1h.combined.liquidationCount, 0);

    // Adversarial cross-margin portfolio liquidation probe confirms the guard catches real wipeouts
    const base = 1700000000;
    const rows = [
      { time: base, open: 100, high: 101, low: 99, close: 100 },
      { time: base + 900, open: 100, high: 101, low: 89.5, close: 100 },
      { time: base + 1800, open: 100, high: 102, low: 99, close: 101 },
    ];
    const sim = simulatePortfolioV7(
      [
        { id: 'A', rows, intervalSeconds: 900, trades: [{ entryIndex: 0, exitIndex: 2, side: 1, entry: 100, lev: 5, grossPct: 4, netPct: 3.5 }] },
        { id: 'B', rows, intervalSeconds: 900, trades: [{ entryIndex: 0, exitIndex: 2, side: 1, entry: 100, lev: 5, grossPct: 4, netPct: 3.5 }] },
      ],
      { maxTotalOpenLev: 10.0, levScale: 1.0, mmr: 0.005 },
    );
    assert.equal(sim.liquidationCount, 1);
    assert.equal(sim.finalEquity, 0);
  });
});

describe('4. Standalone v8.0 Regime Radar, Zero-XSS, Loopback & Safety Interlocks Audit', () => {
  it('passes Zero-XSS static audit, loopback lock & PAPER/SAFE_75WR safety defaults', () => {
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

    assert.throws(() => assertLoopbackHost('0.0.0.0'), /Security policy violation/);
    const cfg = loadConfig({ cwd: REPO_ROOT, useProcessEnv: false, envOverrides: { LIVE_CONFIRM_TOKEN: 'v8-sec-tok' } });
    assert.equal(cfg.executionMode, 'PAPER');
    assert.equal(cfg.dryRun, true);
    assert.equal(cfg.riskTier, 'SAFE_75WR');
    assert.throws(() => assertLiveOrderSafety(cfg, 'v8-sec-tok'), /EXECUTION_MODE must be LIVE_ARMED/);
    assert.equal(JSON.stringify(redactConfig(cfg)).includes('v8-sec-tok'), false);
    assert.equal(scrubSecrets('secret=v8-sec-tok', cfg).includes('v8-sec-tok'), false);
  });

  it('serves /api/status (v8Radar), /api/regime, /api/frontier?version=v8, /api/backtest?version=v8 on 127.0.0.1', async () => {
    const tmp = makeTmpDir('verify-v8-srv-');
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: { HOST: '127.0.0.1', PORT: '0', LIVE_CONFIRM_TOKEN: 'v8-srv-tok' },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'v8.sqlite'), allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs });

    try {
      const bound = await srv.start();
      assert.equal(bound.host, '127.0.0.1');
      const base = `http://${bound.host}:${bound.port}`;

      const status = await (await fetch(`${base}/api/status`)).json();
      assert.equal(status.ok, true);
      assert.equal(status.models.v8RegimeEngineReady, true);
      assert.equal(status.models.v8ModelsReady, true);
      assert.equal(status.models.v8FrontierReady, true);
      assert.ok(status.v8Radar && Object.values(CRYPTO_REGIMES_V8).includes(status.v8Radar.regime));
      assert.equal(status.config.executionMode, 'PAPER');

      const reg = await (await fetch(`${base}/api/regime?symbol=BTCUSDT.P&timeframe=1h`)).json();
      assert.equal(reg.ok, true);
      assert.ok(Object.values(CRYPTO_REGIMES_V8).includes(reg.radar.regime));

      const frontier = await (await fetch(`${base}/api/frontier?version=v8&tier=SAFE_75WR&profile=EXCHANGE_POST_ONLY`)).json();
      assert.equal(frontier.ok, true);
      assert.equal(frontier.ready, true);
      assert.equal(frontier.selectedTier.full5y.liquidationCount, 0);
      assert.ok(frontier.selectedTier.full5y.winRatePct >= 75);

      const bt = await (await fetch(`${base}/api/backtest?symbol=BTCUSDT.P&timeframe=1h&version=v8`)).json();
      assert.equal(bt.ok, true);
      assert.ok(bt.summary.count > 0);

      const badMode = await fetch(`${base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionMode: 'LIVE_ARMED', dryRun: false, confirmToken: 'bad' }),
      });
      assert.equal(badMode.status, 403);
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
