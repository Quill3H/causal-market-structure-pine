import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { alignFundingToBarsCausal } from '../research/fetch_okx_derivs.mjs';
import { predictProbaV5, scoreCandidateV5 } from '../research/ml_inference.mjs';
import { simulatePortfolioV6, simulateTradesV6 } from '../research/sim_engine_v6.mjs';
import {
  applyModelToSignalsV6,
  extractCandidateFeaturesV6,
  generateBnbSignalsV6,
  generateBtcSignalsV6,
  precomputeOrderflowContextV6,
  sliceDatasetPrefixV6,
} from '../research/suite_v6_btc_bnb.mjs';
import {
  applyAltModelToSignalsV6,
  extractEthCandidateFeaturesV6,
  generateEthSignalsV6,
  generateSolSignalsV6,
  precomputeEthCrossContextV6,
} from '../research/suite_v6_eth_sol.mjs';
import {
  applyStockMlFilterV6,
  extractStockFeaturesV6,
  generateFutures1hSignalsCausal,
  generateStockSignalsV6,
  precomputeStockContextV6,
  sliceEquityDatasetPrefix,
  sliceMacroPrefix,
} from '../research/suite_v6_stocks.mjs';
import {
  ALL_V6_ASSETS,
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
const RESULTS_V6 = path.join(REPO_ROOT, 'research', 'results_v6');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function makeTmpDir(prefix = 'verify-v6-') {
  return fs.mkdtempSync(path.join(REPO_ROOT, 'data', prefix));
}

function cloneDatasetMutateFutureCrypto(ds, cutoffBars) {
  const copy = structuredClone(ds);
  const cutoffTime = copy.rows[cutoffBars - 1].time;
  for (let i = cutoffBars; i < copy.rows.length; i++) {
    const r = copy.rows[i];
    const mult = i % 2 === 0 ? 3.1 : 0.25;
    r.open *= mult;
    r.high *= mult * 1.4;
    r.low *= mult * 0.6;
    r.close *= mult;
    r.volume = (r.volume || 100) * 19.5;
    if (Number.isFinite(r.takerBuyVol)) {
      r.takerBuyVol = i % 2 === 0 ? r.volume * 0.99 : r.volume * 0.01;
    }
  }
  for (const tf of Object.keys(copy.htf || {})) {
    const h = copy.htf[tf];
    for (let j = 0; j < h.rows.length; j++) {
      if (h.rows[j].time > cutoffTime) {
        h.rows[j].open *= 2.7;
        h.rows[j].high *= 3.5;
        h.rows[j].low *= 0.3;
        h.rows[j].close *= 2.9;
        h.rows[j].volume = (h.rows[j].volume || 100) * 12;
      }
    }
  }
  if (Array.isArray(copy.fundingRows)) {
    for (const f of copy.fundingRows) {
      if (f.time > cutoffTime) {
        f.fundingRate = 0.095;
      }
    }
  }
  return copy;
}

function cloneDatasetMutateFutureEquity(ds, cutoffBars, htfSec = 604800) {
  const copy = structuredClone(ds);
  const cutoffTime = copy.rows[cutoffBars - 1].time;
  for (let i = cutoffBars; i < copy.rows.length; i++) {
    const r = copy.rows[i];
    const mult = i % 2 === 0 ? 2.8 : 0.3;
    r.open *= mult;
    r.high *= mult * 1.3;
    r.low *= mult * 0.7;
    r.close *= mult;
    r.volume = (r.volume || 1e6) * 8;
  }
  for (const tf of Object.keys(copy.htf || {})) {
    const h = copy.htf[tf];
    const tfSec = tf === '1d' ? 86400 : htfSec;
    for (let j = 0; j < h.rows.length; j++) {
      if (h.rows[j].time + tfSec > cutoffTime) {
        h.rows[j].open *= 2.4;
        h.rows[j].high *= 3.0;
        h.rows[j].low *= 0.35;
        h.rows[j].close *= 2.5;
        h.rows[j].volume = (h.rows[j].volume || 1e6) * 5;
      }
    }
  }
  return copy;
}

function cloneMacroMutateFuture(macro, cutoffTime) {
  const copy = structuredClone(macro);
  for (const r of copy.vixRows || []) {
    if (r.time > cutoffTime) {
      r.open = 92;
      r.high = 99;
      r.low = 85;
      r.close = 95;
    }
  }
  for (const r of copy.tnxRows || []) {
    if (r.time > cutoffTime) {
      r.open = 22;
      r.high = 25;
      r.low = 19;
      r.close = 24;
    }
  }
  return copy;
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

describe('1. v6.0 Strict Causal Prefix-Truncation & Future-Mutation: 5Y Crypto (BTC/BNB/ETH/SOL)', () => {
  const btcModels = readJson(path.join(RESULTS_V6, 'models_btc_bnb_5y.json')).models;
  const altModels = readJson(path.join(RESULTS_V6, 'models_eth_sol_5y.json')).models;

  const btcFull = readJson(path.join(DATA_DIR, 'crypto5y_btcusdt_1h.json'));
  const bnbFull = readJson(path.join(DATA_DIR, 'crypto5y_bnbusdt_1h.json'));
  const ethFull = readJson(path.join(DATA_DIR, 'crypto5y_ethusdt_1h.json'));
  const solFull = readJson(path.join(DATA_DIR, 'crypto5y_solusdt_1h.json'));

  const cutoffT = 28000;

  it('BTCUSDT & BNBUSDT signals, takerBuyVol/CVD/funding features, ML filter & closed trades are 100% causal', () => {
    for (const [sym, dsFull, genFn] of [
      ['BTCUSDT', btcFull, generateBtcSignalsV6],
      ['BNBUSDT', bnbFull, generateBnbSignalsV6],
    ]) {
      const mSpec = btcModels[sym];
      const dsPrefix = sliceDatasetPrefixV6(dsFull, cutoffT);
      const dsMut = cloneDatasetMutateFutureCrypto(dsFull, cutoffT);

      const fundFull = alignFundingToBarsCausal(dsFull.rows, dsFull.fundingRows ?? []);
      const fundPrefix = alignFundingToBarsCausal(dsPrefix.rows, dsPrefix.fundingRows ?? []);
      const fundMut = alignFundingToBarsCausal(dsMut.rows, dsMut.fundingRows ?? []);

      const sigFull = genFn(dsFull, mSpec.structuralSpec.sigSpec, sym === 'BNBUSDT' ? fundFull : null)
        .filter(s => s.barIndex < cutoffT);
      const sigPrefix = genFn(dsPrefix, mSpec.structuralSpec.sigSpec, sym === 'BNBUSDT' ? fundPrefix : null);
      const sigMut = genFn(dsMut, mSpec.structuralSpec.sigSpec, sym === 'BNBUSDT' ? fundMut : null)
        .filter(s => s.barIndex < cutoffT);

      assert.ok(sigFull.length >= 100, `${sym} expected >= 100 signals before T=${cutoffT}`);
      assertSignalArraysMatch(sigPrefix, sigFull, `${sym} prefix signals`);
      assertSignalArraysMatch(sigMut, sigFull, `${sym} future-mutated signals`);

      // Feature causality across candidate bars < cutoffT
      const ctxFull = precomputeOrderflowContextV6(dsFull, fundFull);
      const ctxPrefix = precomputeOrderflowContextV6(dsPrefix, fundPrefix);
      const ctxMut = precomputeOrderflowContextV6(dsMut, fundMut);

      const sampleSigs = sigFull.slice(-20);
      for (const s of sampleSigs) {
        const fF = extractCandidateFeaturesV6(dsFull, s, s.barIndex, fundFull, ctxFull);
        const fP = extractCandidateFeaturesV6(dsPrefix, s, s.barIndex, fundPrefix, ctxPrefix);
        const fM = extractCandidateFeaturesV6(dsMut, s, s.barIndex, fundMut, ctxMut);
        assertFeatureMapsMatch(fP, fF, mSpec.featureNames, `${sym}@${s.barIndex} prefix`);
        assertFeatureMapsMatch(fM, fF, mSpec.featureNames, `${sym}@${s.barIndex} mut`);
      }

      const mlFull = applyModelToSignalsV6(dsFull, sigFull, fundFull, mSpec);
      const mlPrefix = applyModelToSignalsV6(dsPrefix, sigPrefix, fundPrefix, mSpec);
      const mlMut = applyModelToSignalsV6(dsMut, sigMut, fundMut, mSpec);
      assert.ok(mlFull.length >= 50, `${sym} expected >= 50 ML-filtered signals before T=${cutoffT}`);
      assertSignalArraysMatch(mlPrefix, mlFull, `${sym} ML prefix`);
      assertSignalArraysMatch(mlMut, mlFull, `${sym} ML future-mut`);

      // Closed trades strictly before cutoffT must match identically
      const simOpts = {
        ...mSpec.structuralSpec.execOptions,
        execProfile: 'EXCHANGE_POST_ONLY',
        fundingPctPer8h: 0.01,
        intervalSeconds: 3600,
      };
      const trFull = simulateTradesV6(dsFull.rows, mlFull, { ...simOpts, fundingRows: dsFull.fundingRows })
        .trades.filter(t => t.exitIndex < cutoffT - 1);
      const trPrefix = simulateTradesV6(dsPrefix.rows, mlPrefix, { ...simOpts, fundingRows: dsPrefix.fundingRows })
        .trades.filter(t => t.exitIndex < cutoffT - 1);
      const trMut = simulateTradesV6(dsMut.rows, mlMut, { ...simOpts, fundingRows: dsMut.fundingRows })
        .trades.filter(t => t.exitIndex < cutoffT - 1);

      assert.equal(trPrefix.length, trFull.length, `${sym} closed trades prefix len`);
      assert.equal(trMut.length, trFull.length, `${sym} closed trades mut len`);
      for (let k = 0; k < trFull.length; k++) {
        assert.equal(trPrefix[k].exitReason, trFull[k].exitReason);
        assert.ok(Math.abs(trPrefix[k].netPct - trFull[k].netPct) < 1e-12);
        assert.ok(Math.abs(trMut[k].netPct - trFull[k].netPct) < 1e-12);
      }
    }
  });

  it('ETHUSDT (with ETH/BTC cross features) & SOLUSDT (with takerBuyVol thrust & 4h HTF) are 100% causal', () => {
    const btcPrefix = sliceDatasetPrefixV6(btcFull, cutoffT);
    const btcMut = cloneDatasetMutateFutureCrypto(btcFull, cutoffT);

    for (const [sym, dsFull] of [['ETHUSDT', ethFull], ['SOLUSDT', solFull]]) {
      const mSpec = altModels[sym];
      const dsPrefix = sliceDatasetPrefixV6(dsFull, cutoffT);
      const dsMut = cloneDatasetMutateFutureCrypto(dsFull, cutoffT);

      const fundFull = alignFundingToBarsCausal(dsFull.rows, dsFull.fundingRows ?? []);
      const fundPrefix = alignFundingToBarsCausal(dsPrefix.rows, dsPrefix.fundingRows ?? []);
      const fundMut = alignFundingToBarsCausal(dsMut.rows, dsMut.fundingRows ?? []);

      const sigFull = (sym === 'ETHUSDT'
        ? generateEthSignalsV6(dsFull, btcFull, mSpec.structuralSpec.sigSpec)
        : generateSolSignalsV6(dsFull, mSpec.structuralSpec.sigSpec)
      ).filter(s => s.barIndex < cutoffT);
      const sigPrefix = sym === 'ETHUSDT'
        ? generateEthSignalsV6(dsPrefix, btcPrefix, mSpec.structuralSpec.sigSpec)
        : generateSolSignalsV6(dsPrefix, mSpec.structuralSpec.sigSpec);
      const sigMut = (sym === 'ETHUSDT'
        ? generateEthSignalsV6(dsMut, btcMut, mSpec.structuralSpec.sigSpec)
        : generateSolSignalsV6(dsMut, mSpec.structuralSpec.sigSpec)
      ).filter(s => s.barIndex < cutoffT);

      assert.ok(sigFull.length >= 100, `${sym} expected >= 100 signals before T=${cutoffT}`);
      assertSignalArraysMatch(sigPrefix, sigFull, `${sym} prefix signals`);
      assertSignalArraysMatch(sigMut, sigFull, `${sym} future-mutated signals`);

      const ctxFull = sym === 'ETHUSDT'
        ? precomputeEthCrossContextV6(dsFull, btcFull, fundFull)
        : precomputeOrderflowContextV6(dsFull, fundFull);
      const ctxPrefix = sym === 'ETHUSDT'
        ? precomputeEthCrossContextV6(dsPrefix, btcPrefix, fundPrefix)
        : precomputeOrderflowContextV6(dsPrefix, fundPrefix);
      const ctxMut = sym === 'ETHUSDT'
        ? precomputeEthCrossContextV6(dsMut, btcMut, fundMut)
        : precomputeOrderflowContextV6(dsMut, fundMut);

      for (const s of sigFull.slice(-20)) {
        const fF = sym === 'ETHUSDT'
          ? extractEthCandidateFeaturesV6(dsFull, btcFull, s, s.barIndex, fundFull, ctxFull)
          : extractCandidateFeaturesV6(dsFull, s, s.barIndex, fundFull, ctxFull);
        const fP = sym === 'ETHUSDT'
          ? extractEthCandidateFeaturesV6(dsPrefix, btcPrefix, s, s.barIndex, fundPrefix, ctxPrefix)
          : extractCandidateFeaturesV6(dsPrefix, s, s.barIndex, fundPrefix, ctxPrefix);
        const fM = sym === 'ETHUSDT'
          ? extractEthCandidateFeaturesV6(dsMut, btcMut, s, s.barIndex, fundMut, ctxMut)
          : extractCandidateFeaturesV6(dsMut, s, s.barIndex, fundMut, ctxMut);
        assertFeatureMapsMatch(fP, fF, mSpec.featureNames, `${sym}@${s.barIndex} prefix`);
        assertFeatureMapsMatch(fM, fF, mSpec.featureNames, `${sym}@${s.barIndex} mut`);
      }

      const mlFull = applyAltModelToSignalsV6(sym, dsFull, btcFull, sigFull, fundFull, mSpec);
      const mlPrefix = applyAltModelToSignalsV6(sym, dsPrefix, btcPrefix, sigPrefix, fundPrefix, mSpec);
      const mlMut = applyAltModelToSignalsV6(sym, dsMut, btcMut, sigMut, fundMut, mSpec);
      assert.ok(mlFull.length >= 50, `${sym} expected >= 50 ML signals before T=${cutoffT}`);
      assertSignalArraysMatch(mlPrefix, mlFull, `${sym} ML prefix`);
      assertSignalArraysMatch(mlMut, mlFull, `${sym} ML future-mut`);
    }
  });
});

describe('2. v6.0 Strict Causal Prefix-Truncation & Future-Mutation: 10Y Indices & 2Y 1h Futures', () => {
  const stockModels = readJson(path.join(RESULTS_V6, 'models_stocks_v6.json')).models;
  const macroFull = readJson(path.join(DATA_DIR, 'equities10y_macro_1d.json'));
  const spyFull = readJson(path.join(DATA_DIR, 'equities10y_sp500_1d.json'));
  const diaFull = readJson(path.join(DATA_DIR, 'equities10y_dow_1d.json'));
  const qqqFull = readJson(path.join(DATA_DIR, 'equities10y_nasdaq_1d.json'));

  const stockMap = { SPY: spyFull, DIA: diaFull, QQQ: qqqFull };
  const dailyCutoff = 1800;

  it('SPY, DIA, QQQ daily signals, VIX/TNX/rotation features, ML filter & closed trades are 100% causal', () => {
    const cutoffTime = spyFull.rows[dailyCutoff - 1].time;
    assert.equal(diaFull.rows[dailyCutoff - 1].time, cutoffTime);
    assert.equal(qqqFull.rows[dailyCutoff - 1].time, cutoffTime);

    const macroPrefix = sliceMacroPrefix(macroFull, cutoffTime);
    const macroMut = cloneMacroMutateFuture(macroFull, cutoffTime);
    const diaPrefix = sliceEquityDatasetPrefix(diaFull, dailyCutoff);
    const qqqPrefix = sliceEquityDatasetPrefix(qqqFull, dailyCutoff);
    const diaMut = cloneDatasetMutateFutureEquity(diaFull, dailyCutoff);
    const qqqMut = cloneDatasetMutateFutureEquity(qqqFull, dailyCutoff);

    const auxFull = { macro: macroFull, diaRows: diaFull.rows, qqqRows: qqqFull.rows };
    const auxPrefix = { macro: macroPrefix, diaRows: diaPrefix.rows, qqqRows: qqqPrefix.rows };
    const auxMut = { macro: macroMut, diaRows: diaMut.rows, qqqRows: qqqMut.rows };

    for (const sym of ['SPY', 'DIA', 'QQQ']) {
      const mSpec = stockModels[sym];
      const dsFull = stockMap[sym];
      const dsPrefix = sliceEquityDatasetPrefix(dsFull, dailyCutoff);
      const dsMut = cloneDatasetMutateFutureEquity(dsFull, dailyCutoff);

      const sigFull = generateStockSignalsV6(dsFull, mSpec.signalSpec, auxFull)
        .filter(s => s.barIndex < dailyCutoff);
      const sigPrefix = generateStockSignalsV6(dsPrefix, mSpec.signalSpec, auxPrefix);
      const sigMut = generateStockSignalsV6(dsMut, mSpec.signalSpec, auxMut)
        .filter(s => s.barIndex < dailyCutoff);

      assert.ok(sigFull.length >= 60, `${sym} expected >= 60 signals before T=${dailyCutoff}`);
      assertSignalArraysMatch(sigPrefix, sigFull, `${sym} prefix signals`);
      assertSignalArraysMatch(sigMut, sigFull, `${sym} future-mutated signals`);

      const ctxFull = precomputeStockContextV6(dsFull, auxFull);
      const ctxPrefix = precomputeStockContextV6(dsPrefix, auxPrefix);
      const ctxMut = precomputeStockContextV6(dsMut, auxMut);

      for (const s of sigFull.slice(-20)) {
        const fF = extractStockFeaturesV6(dsFull, s, s.barIndex, auxFull, ctxFull);
        const fP = extractStockFeaturesV6(dsPrefix, s, s.barIndex, auxPrefix, ctxPrefix);
        const fM = extractStockFeaturesV6(dsMut, s, s.barIndex, auxMut, ctxMut);
        assertFeatureMapsMatch(fP, fF, mSpec.featureNames, `${sym}@${s.barIndex} prefix`);
        assertFeatureMapsMatch(fM, fF, mSpec.featureNames, `${sym}@${s.barIndex} mut`);
      }

      const mlFull = applyStockMlFilterV6(dsFull, sigFull, mSpec, auxFull);
      const mlPrefix = applyStockMlFilterV6(dsPrefix, sigPrefix, mSpec, auxPrefix);
      const mlMut = applyStockMlFilterV6(dsMut, sigMut, mSpec, auxMut);
      assert.ok(mlFull.length >= 50, `${sym} expected >= 50 ML signals before T=${dailyCutoff}`);
      assertSignalArraysMatch(mlPrefix, mlFull, `${sym} ML prefix`);
      assertSignalArraysMatch(mlMut, mlFull, `${sym} ML mut`);

      const simOpts = { ...mSpec.execOptions, execProfile: 'EQUITY_ETF', allowTimeGaps: true };
      const trFull = simulateTradesV6(dsFull.rows, mlFull, simOpts).trades.filter(t => t.exitIndex < dailyCutoff - 1);
      const trPrefix = simulateTradesV6(dsPrefix.rows, mlPrefix, simOpts).trades.filter(t => t.exitIndex < dailyCutoff - 1);
      const trMut = simulateTradesV6(dsMut.rows, mlMut, simOpts).trades.filter(t => t.exitIndex < dailyCutoff - 1);

      assert.equal(trPrefix.length, trFull.length, `${sym} closed trades prefix`);
      assert.equal(trMut.length, trFull.length, `${sym} closed trades mut`);
      for (let k = 0; k < trFull.length; k++) {
        assert.equal(trPrefix[k].exitReason, trFull[k].exitReason);
        assert.ok(Math.abs(trPrefix[k].netPct - trFull[k].netPct) < 1e-12);
        assert.ok(Math.abs(trMut[k].netPct - trFull[k].netPct) < 1e-12);
      }
    }
  });

  it('ES=F, YM=F, NQ=F 2Y 1h Intraday Futures with causal 1d HTF alignment are 100% causal', () => {
    const futSpecs = [
      ['equities2y_es_1h.json', 'SPY'],
      ['equities2y_ym_1h.json', 'DIA'],
      ['equities2y_nq_1h.json', 'QQQ'],
    ];
    const futCutoff = 9500;
    const auxFull = { macro: macroFull, diaRows: diaFull.rows, qqqRows: qqqFull.rows };

    for (const [fileName, modelKey] of futSpecs) {
      const futFull = readJson(path.join(DATA_DIR, fileName));
      const mSpec = stockModels[modelKey];
      const futPrefix = sliceEquityDatasetPrefix(futFull, futCutoff);
      const cutoffTime = futPrefix.rows[futPrefix.rows.length - 1].time;
      const futMut = cloneDatasetMutateFutureEquity(futFull, futCutoff, 86400);

      const auxPrefix = {
        macro: sliceMacroPrefix(macroFull, cutoffTime),
        diaRows: diaFull.rows.filter(r => r.time <= cutoffTime),
        qqqRows: qqqFull.rows.filter(r => r.time <= cutoffTime),
      };
      const auxMut = {
        macro: cloneMacroMutateFuture(macroFull, cutoffTime),
        diaRows: diaFull.rows.map(r => (r.time > cutoffTime ? { ...r, close: r.close * 3 } : r)),
        qqqRows: qqqFull.rows.map(r => (r.time > cutoffTime ? { ...r, close: r.close * 0.3 } : r)),
      };

      const sigFull = generateFutures1hSignalsCausal(futFull, mSpec, auxFull)
        .filter(s => s.barIndex < futCutoff);
      const sigPrefix = generateFutures1hSignalsCausal(futPrefix, mSpec, auxPrefix);
      const sigMut = generateFutures1hSignalsCausal(futMut, mSpec, auxMut)
        .filter(s => s.barIndex < futCutoff);

      assert.ok(sigFull.length >= 10, `${futFull.symbol} expected >= 10 1h signals before T=${futCutoff}`);
      assertSignalArraysMatch(sigPrefix, sigFull, `${futFull.symbol} 1h prefix`);
      assertSignalArraysMatch(sigMut, sigFull, `${futFull.symbol} 1h future-mut`);
    }
  });
});

describe('3. Zero Blind Holdout Leakage & < 1e-12 Python sklearn vs JS Parity (All 7 Models)', () => {
  it('enforces exact Cal/Val/Holdout index isolation & honest ETH gate failure in saved model metadata', () => {
    const btcBnb = readJson(path.join(RESULTS_V6, 'models_btc_bnb_5y.json'));
    const ethSol = readJson(path.join(RESULTS_V6, 'models_eth_sol_5y.json'));
    const stocks = readJson(path.join(RESULTS_V6, 'models_stocks_v6.json'));

    for (const sym of ['BTCUSDT', 'BNBUSDT']) {
      const meta = btcBnb.models[sym].selectionMeta;
      assert.deepEqual(meta.calRange, [0, 21976]);
      assert.deepEqual(meta.valRange, [21976, 35161]);
      assert.deepEqual(meta.holdoutRangeUntouched, [35161, 43952]);
      assert.ok(meta.valRange[1] <= meta.holdoutRangeUntouched[0]);
    }

    for (const sym of ['ETHUSDT', 'SOLUSDT']) {
      const m = ethSol.models[sym];
      const meta = m.selectionMeta;
      assert.deepEqual(meta.calRange, [0, 21976]);
      assert.deepEqual(meta.valRange, [21976, 35161]);
      assert.deepEqual(meta.holdoutRangeUntouched, [35161, 43952]);
      assert.ok(meta.valRange[1] <= meta.holdoutRangeUntouched[0]);
      if (sym === 'ETHUSDT') {
        assert.equal(m.qualifiedForLive, false, 'ETHUSDT must fail Y5 live gate honestly');
        assert.equal(m.holdoutY5Gate.postOnlyPassY5, false);
        assert.equal(m.holdoutY5Gate.strictTakerPassY5, false);
      } else {
        assert.equal(m.qualifiedForLive, true, 'SOLUSDT must pass Y5 live gate');
        assert.equal(m.holdoutY5Gate.postOnlyPassY5, true);
        assert.equal(m.holdoutY5Gate.strictTakerPassY5, true);
      }
    }

    for (const sym of ['SPY', 'DIA', 'QQQ']) {
      const meta = stocks.models[sym].selectionMeta;
      assert.deepEqual(meta.calRange, [0, 1256]);
      assert.deepEqual(meta.valRange, [1256, 2010]);
      assert.deepEqual(meta.holdoutRangeUntouched, [2010, 2513]);
      assert.ok(meta.valRange[1] <= meta.holdoutRangeUntouched[0]);
    }
  });

  it('achieves < 1e-12 predict_proba & pass parity between Python sklearn and JS across >= 50 real candidates for ALL 7 models', () => {
    const btcBnb = readJson(path.join(RESULTS_V6, 'models_btc_bnb_5y.json')).models;
    const ethSol = readJson(path.join(RESULTS_V6, 'models_eth_sol_5y.json')).models;
    const stocks = readJson(path.join(RESULTS_V6, 'models_stocks_v6.json')).models;

    const btcDs = readJson(path.join(DATA_DIR, 'crypto5y_btcusdt_1h.json'));
    const bnbDs = readJson(path.join(DATA_DIR, 'crypto5y_bnbusdt_1h.json'));
    const ethDs = readJson(path.join(DATA_DIR, 'crypto5y_ethusdt_1h.json'));
    const solDs = readJson(path.join(DATA_DIR, 'crypto5y_solusdt_1h.json'));

    const macro = readJson(path.join(DATA_DIR, 'equities10y_macro_1d.json'));
    const spyDs = readJson(path.join(DATA_DIR, 'equities10y_sp500_1d.json'));
    const diaDs = readJson(path.join(DATA_DIR, 'equities10y_dow_1d.json'));
    const qqqDs = readJson(path.join(DATA_DIR, 'equities10y_nasdaq_1d.json'));
    const stockAux = { macro, diaRows: diaDs.rows, qqqRows: qqqDs.rows };

    const parityTasks = [];

    // Helper for crypto candidate extraction
    const addCryptoParity = (sym, ds, mSpec, sigs, extractor, ctx, alignedFunding) => {
      assert.ok(sigs.length >= 50, `${sym} expected >= 50 real candidates (got ${sigs.length})`);
      const sample = sigs.slice(0, 150);
      const rows = sample.map(s => {
        const fMap = sym === 'ETHUSDT'
          ? extractor(ds, btcDs, s, s.barIndex, alignedFunding, ctx)
          : extractor(ds, s, s.barIndex, alignedFunding, ctx);
        const sc = scoreCandidateV5(fMap, mSpec);
        const vec = mSpec.featureNames.map(k => (Number.isFinite(fMap[k]) ? fMap[k] : null));
        return { vec, jsProb: sc.probWin, jsPass: sc.pass };
      });
      parityTasks.push({ sym, modelSpec: mSpec, rows });
    };

    const btcFund = alignFundingToBarsCausal(btcDs.rows, btcDs.fundingRows ?? []);
    const bnbFund = alignFundingToBarsCausal(bnbDs.rows, bnbDs.fundingRows ?? []);
    const ethFund = alignFundingToBarsCausal(ethDs.rows, ethDs.fundingRows ?? []);
    const solFund = alignFundingToBarsCausal(solDs.rows, solDs.fundingRows ?? []);

    addCryptoParity(
      'BTCUSDT',
      btcDs,
      btcBnb.BTCUSDT,
      generateBtcSignalsV6(btcDs, btcBnb.BTCUSDT.structuralSpec.sigSpec),
      extractCandidateFeaturesV6,
      precomputeOrderflowContextV6(btcDs, btcFund),
      btcFund,
    );
    addCryptoParity(
      'BNBUSDT',
      bnbDs,
      btcBnb.BNBUSDT,
      generateBnbSignalsV6(bnbDs, btcBnb.BNBUSDT.structuralSpec.sigSpec, bnbFund),
      extractCandidateFeaturesV6,
      precomputeOrderflowContextV6(bnbDs, bnbFund),
      bnbFund,
    );
    addCryptoParity(
      'ETHUSDT',
      ethDs,
      ethSol.ETHUSDT,
      generateEthSignalsV6(ethDs, btcDs, ethSol.ETHUSDT.structuralSpec.sigSpec),
      extractEthCandidateFeaturesV6,
      precomputeEthCrossContextV6(ethDs, btcDs, ethFund),
      ethFund,
    );
    addCryptoParity(
      'SOLUSDT',
      solDs,
      ethSol.SOLUSDT,
      generateSolSignalsV6(solDs, ethSol.SOLUSDT.structuralSpec.sigSpec),
      extractCandidateFeaturesV6,
      precomputeOrderflowContextV6(solDs, solFund),
      solFund,
    );

    for (const [sym, ds] of [['SPY', spyDs], ['DIA', diaDs], ['QQQ', qqqDs]]) {
      const mSpec = stocks[sym];
      const sigs = generateStockSignalsV6(ds, mSpec.signalSpec, stockAux);
      assert.ok(sigs.length >= 50, `${sym} expected >= 50 real candidates (got ${sigs.length})`);
      const ctx = precomputeStockContextV6(ds, stockAux);
      const rows = sigs.slice(0, 150).map(s => {
        const fMap = extractStockFeaturesV6(ds, s, s.barIndex, stockAux, ctx);
        const sc = scoreCandidateV5(fMap, mSpec);
        const vec = mSpec.featureNames.map(k => (Number.isFinite(fMap[k]) ? fMap[k] : null));
        return { vec, jsProb: sc.probWin, jsPass: sc.pass };
      });
      parityTasks.push({ sym, modelSpec: mSpec, rows });
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
    sym = task['sym']
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
    out[sym] = {
        'count': len(rows),
        'maxAbsDiff': max(diffs),
        'passMismatch': pass_mismatch,
    }

print(json.dumps(out))
`;

    const stdout = execFileSync('python3', ['-c', pyCode], {
      input: JSON.stringify(parityTasks),
      encoding: 'utf8',
    });
    const parsed = JSON.parse(stdout);

    for (const task of parityTasks) {
      const r = parsed[task.sym];
      assert.ok(r, `Missing Python parity result for ${task.sym}`);
      assert.ok(r.count >= 50, `${task.sym} checked ${r.count} rows (< 50)`);
      assert.equal(r.passMismatch, 0, `${task.sym} threshold pass mismatch with Python`);
      assert.ok(
        r.maxAbsDiff < 1e-12,
        `${task.sym} Python sklearn vs JS maxAbsDiff ${r.maxAbsDiff} >= 1e-12`,
      );
    }
  });
});

describe('4. Realistic Execution: Market-Hour Gaps, Overnight gapStop/gapTarget & Portfolio Cap', () => {
  it('simulates EQUITY_ETF overnight/weekend gaps conservatively (gapStop at worse open, zero funding)', () => {
    // 5 daily bars including a 3-day weekend jump between bar 2 and bar 3
    const rows = [
      { time: 1700000000, open: 100, high: 101, low: 99, close: 100, volume: 1e6 },
      { time: 1700086400, open: 100, high: 101, low: 99.5, close: 100, volume: 1e6 },
      { time: 1700172800, open: 100, high: 100.5, low: 99, close: 100, volume: 1e6 },
      // Weekend gap (+3 days) directly below Long stop (~97.5): opens at 91.0!
      { time: 1700432000, open: 91.0, high: 93.0, low: 90.0, close: 92.5, volume: 2e6 },
      { time: 1700518400, open: 92.5, high: 94.0, low: 92.0, close: 93.0, volume: 1e6 },
    ];
    const signals = [{ barIndex: 0, side: 1, atr: 1.0 }];
    const sim = simulateTradesV6(rows, signals, {
      execProfile: 'EQUITY_ETF',
      allowTimeGaps: true,
      entryMode: 'MARKET_NEXT_OPEN',
      warmup: 0,
      cooldown: 0,
      stopAtr: 2.5,
      minStopPct: 0.8,
      rewardRisk: 1.5,
      maxHoldBars: 10,
      costPct: 0.04,
      slippagePct: 0.015,
      fixedLev: 1.0,
      minLev: 1.0,
      maxLev: 1.0,
    });

    assert.equal(sim.trades.length, 1);
    const t = sim.trades[0];
    assert.equal(t.entryIndex, 1);
    assert.equal(t.exitIndex, 3);
    assert.equal(t.exitReason, 'SL');
    assert.equal(t.fundingDragPct, 0, 'EQUITY_ETF must charge 0 perpetual funding');
    // Stop was 97.5, but gap open was 91.0 -> must fill at worse gap open 91.0 - slippage, not 97.5
    assert.ok(t.exit < 91.0, `Expected gap-stop fill with slippage below 91.0, got ${t.exit}`);
    assert.ok(t.netPct < -8.0, `Expected full overnight gap loss (~-9%), got ${t.netPct}`);
  });

  it('caps simultaneous portfolio exposure across gapped & 24/7 streams under simulatePortfolioV6', () => {
    const rowsA = [
      { time: 1000, open: 100, high: 101, low: 99, close: 100 },
      { time: 5000, open: 102, high: 103, low: 101, close: 102 },
    ];
    const rowsB = [
      { time: 1500, open: 100, high: 101, low: 99, close: 100 },
      { time: 4500, open: 101, high: 102, low: 100, close: 101 },
    ];
    const streamA = {
      id: 'SPY',
      rows: rowsA,
      intervalSeconds: 86400,
      trades: [
        { entryIndex: 0, exitIndex: 1, lev: 2.0, grossPct: 4.1, netPct: 4.0 },
      ],
    };
    const streamB = {
      id: 'QQQ',
      rows: rowsB,
      intervalSeconds: 86400,
      trades: [
        { entryIndex: 0, exitIndex: 1, lev: 2.0, grossPct: 2.1, netPct: 2.0 },
      ],
    };
    const res = simulatePortfolioV6([streamA, streamB], { maxTotalOpenLev: 3.0, periodYears: 1 });
    assert.equal(res.trades.length, 2);
    // Second overlapping trade must be scaled from 2.0x to 1.0x (available headroom = 3.0 - 2.0)
    const second = res.trades.find(t => t.streamId === 'QQQ');
    assert.equal(second.effectiveLev, 1.0);
    assert.ok(Math.abs(second.portfolioNetPct - 1.0) < 1e-9);
    assert.ok(res.peakOpenLev <= 3.0 + 1e-9);
  });
});

describe('5. v6.0 Security, Safety Interlocks & Loopback Standalone Audit', () => {
  it('passes Zero-XSS DOM sink check across standalone/public/ and secret protection checks', () => {
    const publicDir = path.join(REPO_ROOT, 'standalone', 'public');
    const appJs = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    const stylesCss = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');

    const forbidden = [
      /\.innerHTML\b/i,
      /\.outerHTML\b/i,
      /insertAdjacentHTML\b/i,
      /document\.write\b/i,
      /\beval\s*\(/i,
      /new\s+Function\b/i,
      /setHTMLUnsafe\b/i,
    ];
    for (const pat of forbidden) {
      assert.equal(pat.test(appJs), false, `Forbidden sink ${pat} in app.js`);
      assert.equal(pat.test(indexHtml), false, `Forbidden sink ${pat} in index.html`);
    }
    assert.equal(/\son[a-z]+\s*=/i.test(indexHtml), false, 'No inline event handlers');
    assert.equal(indexHtml.match(/<script(?![^>]*\bsrc=)[^>]*>/gi), null, 'No inline script blocks');
    assert.equal(/expression\s*\(/i.test(stylesCss), false, 'No CSS expression()');

    // .gitignore must ignore .env and data/
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.env$/m);
    assert.match(gitignore, /^\.env\.\*$/m);
    assert.match(gitignore, /^data\/\*$/m);

    // Loopback enforcement
    assert.equal(assertLoopbackHost('127.0.0.1'), '127.0.0.1');
    assert.throws(() => assertLoopbackHost('0.0.0.0'), /Security policy violation/);
    assert.throws(() => assertLoopbackHost('192.168.1.50'), /Security policy violation/);

    // Hard PAPER + DRY_RUN default & full secret scrubbing (v5 + v6 Alpaca/TwelveData keys)
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        OKX_API_KEY: 'okx-secret-k',
        BINANCE_API_KEY: 'bin-secret-k',
        ALPACA_API_KEY: 'alpaca-secret-k',
        ALPACA_API_SECRET: 'alpaca-secret-s',
        TWELVEDATA_API_KEY: 'twelve-secret-k',
        LIVE_CONFIRM_TOKEN: 'live-tok-99',
      },
    });
    assert.equal(cfg.executionMode, 'PAPER');
    assert.equal(cfg.dryRun, true);
    assert.equal(cfg.host, '127.0.0.1');
    assert.ok(cfg.maxLeverageCap <= 3.0);
    assert.throws(() => assertLiveOrderSafety(cfg, 'live-tok-99'), /EXECUTION_MODE must be LIVE_ARMED/);

    const redacted = JSON.stringify(redactConfig(cfg));
    for (const s of ['okx-secret-k', 'bin-secret-k', 'alpaca-secret-k', 'alpaca-secret-s', 'twelve-secret-k', 'live-tok-99']) {
      assert.equal(redacted.includes(s), false, `Redacted config leaked ${s}`);
      const scrubbed = scrubSecrets(`leak test ${s}`, cfg);
      assert.equal(scrubbed.includes(s), false, `scrubSecrets failed to scrub ${s}`);
    }
  });

  it('serves all 7 v6 assets (BNB + SPY/DIA/QQQ) on 127.0.0.1 offline with PAPER lock & zero secret leakage', async () => {
    const tmp = makeTmpDir('verify-v6-srv-');
    const cfg = loadConfig({
      cwd: REPO_ROOT,
      useProcessEnv: false,
      envOverrides: {
        HOST: '127.0.0.1',
        PORT: '0',
        ALPACA_API_KEY: 'alp-srv-key',
        ALPACA_API_SECRET: 'alp-srv-sec',
        TWELVEDATA_API_KEY: 'td-srv-key',
        LIVE_CONFIRM_TOKEN: 'srv-token-77',
      },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'v6.sqlite'), allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs });

    try {
      const bound = await srv.start();
      assert.equal(bound.host, '127.0.0.1');
      const base = `http://${bound.host}:${bound.port}`;

      const statusRes = await fetch(`${base}/api/status`);
      assert.equal(statusRes.status, 200);
      const statusText = await statusRes.text();
      assert.equal(statusText.includes('alp-srv-key'), false);
      assert.equal(statusText.includes('td-srv-key'), false);
      assert.equal(statusText.includes('srv-token-77'), false);

      const status = JSON.parse(statusText);
      assert.equal(status.ok, true);
      assert.equal(status.config.executionMode, 'PAPER');
      assert.equal(status.models.v6EngineReady, true);
      assert.equal(status.models.v6CryptoModelsReady, true);
      assert.equal(status.models.v6StockModelsReady, true);
      assert.equal(status.assets.length, ALL_V6_ASSETS.length);
      for (const sym of ['BTCUSDT.P', 'ETHUSDT.P', 'SOLUSDT.P', 'BNBUSDT.P', 'SPY', 'DIA', 'QQQ']) {
        assert.ok(status.assets.some(a => a.symbol === sym), `Missing asset ${sym} in /api/status`);
      }

      // Verify offline backtests work for new v6 BNB and US Equity ETFs
      for (const [sym, tf] of [['BNBUSDT.P', '1h'], ['SPY', '1d'], ['DIA', '1d'], ['QQQ', '1d']]) {
        const res = await fetch(`${base}/api/backtest?symbol=${encodeURIComponent(sym)}&timeframe=${tf}`);
        assert.equal(res.status, 200);
        const bt = await res.json();
        assert.equal(bt.ok, true, `${sym} offline backtest failed`);
        assert.ok(bt.summary.count > 0, `${sym} expected trades > 0`);
      }

      // Mode switch blocked with wrong token
      const badMode = await fetch(`${base}/api/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionMode: 'LIVE_ARMED', dryRun: false, confirmToken: 'nope' }),
      });
      assert.equal(badMode.status, 403);
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
