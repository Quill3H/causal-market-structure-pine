import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sliceDatasetPrefix1h,
  generateSignals1h,
  buildSignalSpecs1h,
  buildCandidateCatalog1h,
} from './signals_1h.mjs';
import { simulateTrades } from './sim_engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BTC_24M_PATH = path.join(ROOT, 'data', 'btcusdt_1h_24m.json');
const BTC_TV6K_PATH = path.join(ROOT, 'data', 'btcusdt_tv_1h_6k.json');

const loadJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

test('buildCandidateCatalog1h enforces rewardRisk >= 0.75 across all candidates', () => {
  const ds = sliceDatasetPrefix1h(loadJson(BTC_TV6K_PATH), 600);
  const catalog = buildCandidateCatalog1h(ds);
  assert.ok(catalog.length >= 32);
  for (const cand of catalog) {
    assert.ok(cand.execOptions.rewardRisk >= 0.75, `Invalid RR in ${cand.id}`);
    assert.ok(cand.execOptions.stopAtr > 0, `Invalid stopAtr in ${cand.id}`);
    if (cand.signalSpec.family === 'AdaptiveTrapPolarity') {
      const v = cand.signalSpec.virtExec;
      assert.equal(cand.execOptions.stopAtr, v.stopAtr);
      assert.equal(cand.execOptions.minStopPct, v.minStopPct);
      assert.equal(cand.execOptions.rewardRisk, v.rewardRisk);
      assert.equal(cand.execOptions.maxHoldBars, v.maxHoldBars);
      assert.equal(cand.execOptions.beTriggerR, v.beTriggerR);
      assert.equal(cand.execOptions.beOffsetPct, v.beOffsetPct);
      assert.equal(cand.execOptions.cooldown, v.cooldown);
      assert.equal(cand.execOptions.entryMode, v.entryMode);
    }
  }
});

test('prefix-truncation causality: signals before T are invariant to truncating future 1h and HTF bars', () => {
  const full = loadJson(BTC_24M_PATH);
  const specs = buildSignalSpecs1h();
  const adaptivePs = specs.find(s => s.family === 'AdaptiveTrapPolarity' && s.sharedHistory === false);
  assert.ok(adaptivePs, 'Expected AdaptiveTrapPolarity spec');
  const adaptiveSh = { ...adaptivePs, specId: `${adaptivePs.specId}:sh_test`, sharedHistory: true };
  const sampleSpecs = [
    adaptiveSh,
    adaptivePs,
    specs.find(s => s.family === 'HtfTrapReclaim' && s.lookback === 20 && s.trapMaxBars === 4),
    specs.find(s => s.family === 'HtfSmcMultiTrap' && s.p4Lookback === 10 && s.includePdhl === true),
    specs.find(s => s.family === 'HtfTrapSqKc' && s.kcMult === 1.8 && s.maxD1Atr === 2.0),
    specs.find(s => s.family === 'HtfTrapOrSqueeze' && s.lookback === 20 && s.sqLookback === 14),
    specs.find(s => s.family === 'HtfSqueezeBreakout'),
    specs.find(s => s.family === 'HtfSweepWick'),
  ];
  for (const spec of sampleSpecs) {
    assert.ok(spec, 'Expected representative spec for each family');
  }

  const cutoffs = [1200, 4380, 8760, 13140, 16000];
  for (const spec of sampleSpecs) {
    const fullSignals = generateSignals1h(full, spec);
    for (const T of cutoffs) {
      const prefix = sliceDatasetPrefix1h(full, T);
      const prefixSignals = generateSignals1h(prefix, spec);
      assert.deepEqual(
        prefixSignals,
        fullSignals.filter(s => s.barIndex < T),
        `Causality violation for ${spec.specId} at cutoff T=${T}`,
      );
    }
  }
});

test('future-mutation causality: mutating future OHLCV after T does not alter signals or settled trades <= T-1', () => {
  const base = sliceDatasetPrefix1h(loadJson(BTC_TV6K_PATH), 3000);
  const T = 2000;
  const spec = buildSignalSpecs1h().find(
    s => s.family === 'HtfTrapReclaim' && s.lookback === 20 && s.trapMaxBars === 4 && s.limitOffsetAtr === 0.15,
  );
  assert.ok(spec);
  const mutated = structuredClone(base);
  const cutoffTime = mutated.rows[T - 1].time;
  for (let i = T; i < mutated.rows.length; i++) {
    mutated.rows[i].open *= 3.5;
    mutated.rows[i].high *= 3.6;
    mutated.rows[i].low *= 3.4;
    mutated.rows[i].close *= 3.5;
    mutated.rows[i].volume = 0;
  }
  for (const tf of ['4h', '1d']) {
    for (const hRow of mutated.htf[tf].rows) {
      if (hRow.time + mutated.htf[tf].intervalSeconds > cutoffTime) {
        hRow.open *= 3.5;
        hRow.high *= 3.6;
        hRow.low *= 3.4;
        hRow.close *= 3.5;
      }
    }
  }

  const baseSignals = generateSignals1h(base, spec);
  const mutSignals = generateSignals1h(mutated, spec);
  assert.deepEqual(
    baseSignals.filter(s => s.barIndex < T),
    mutSignals.filter(s => s.barIndex < T),
  );

  const execOpts = {
    entryMode: 'LIMIT_PULLBACK',
    limitExpiryBars: 5,
    pendingPolicy: 'ignore',
    limitSameBarTp: 'close',
    cooldown: 6,
    warmup: 250,
    stopAtr: 3.0,
    minStopPct: 1.0,
    rewardRisk: 0.85,
    maxHoldBars: 96,
    beTriggerR: 0.55,
    beOffsetPct: 0.20,
    costPct: 0.10,
    slippagePct: 0.025,
    intervalSeconds: 3600,
  };
  const baseSim = simulateTrades(base.rows, baseSignals, { ...execOpts, end: T });
  const mutSim = simulateTrades(mutated.rows, mutSignals, { ...execOpts, end: T });
  assert.deepEqual(baseSim.trades, mutSim.trades);
});

test('price-scale invariance: signals are independent of absolute dollar price level', () => {
  const base = sliceDatasetPrefix1h(loadJson(BTC_TV6K_PATH), 1500);
  const scaled = structuredClone(base);
  const factor = 0.03;
  for (const row of scaled.rows) {
    row.open *= factor;
    row.high *= factor;
    row.low *= factor;
    row.close *= factor;
  }
  for (const tf of ['4h', '1d']) {
    for (const hRow of scaled.htf[tf].rows) {
      hRow.open *= factor;
      hRow.high *= factor;
      hRow.low *= factor;
      hRow.close *= factor;
    }
  }

  const allSpecs = buildSignalSpecs1h();
  const adaptiveSpec = allSpecs.find(s => s.family === 'AdaptiveTrapPolarity' && (s.limitOffsetAtr ?? 0) > 0)
    ?? allSpecs.find(s => s.family === 'AdaptiveTrapPolarity');
  assert.ok(adaptiveSpec);
  const checkSpecs = [
    adaptiveSpec,
    { ...adaptiveSpec, specId: `${adaptiveSpec.specId}:sh_test`, sharedHistory: true },
    allSpecs.find(s => s.family === 'HtfTrapReclaim' && s.lookback === 20 && s.trapMaxBars === 4 && s.limitOffsetAtr > 0)
      ?? allSpecs.find(s => s.family === 'HtfTrapReclaim' && s.lookback === 20 && s.trapMaxBars === 4),
  ];
  for (const spec of checkSpecs) {
    assert.ok(spec);
    const s1 = generateSignals1h(base, spec);
    const s2 = generateSignals1h(scaled, spec);
    assert.equal(s1.length, s2.length);
    for (let i = 0; i < s1.length; i++) {
      assert.equal(s1[i].barIndex, s2[i].barIndex);
      assert.equal(s1[i].side, s2[i].side);
      assert.ok(Math.abs(s1[i].atr * factor - s2[i].atr) < 1e-8);
      if (s1[i].limitPrice !== undefined) {
        assert.ok(Math.abs(s1[i].limitPrice * factor - s2[i].limitPrice) < 1e-8);
      }
    }
  }
});

test('AdaptiveTrapPolarity future-mutation causality: mutating future bars leaves past virtual exits & flipped signals invariant', () => {
  const base = sliceDatasetPrefix1h(loadJson(BTC_24M_PATH), 4500);
  const T = 3500;
  const spec = buildSignalSpecs1h().find(s => s.family === 'AdaptiveTrapPolarity' && s.sharedHistory === false);
  assert.ok(spec);
  const mutated = structuredClone(base);
  const cutoffTime = mutated.rows[T - 1].time;
  for (let i = T; i < mutated.rows.length; i++) {
    mutated.rows[i].open *= 2.5;
    mutated.rows[i].high *= 2.6;
    mutated.rows[i].low *= 2.4;
    mutated.rows[i].close *= 2.5;
    mutated.rows[i].volume = 0;
  }
  for (const tf of ['4h', '1d']) {
    for (const hRow of mutated.htf[tf].rows) {
      if (hRow.time + mutated.htf[tf].intervalSeconds > cutoffTime) {
        hRow.open *= 2.5;
        hRow.high *= 2.6;
        hRow.low *= 2.4;
        hRow.close *= 2.5;
      }
    }
  }
  const baseSignals = generateSignals1h(base, spec);
  const mutSignals = generateSignals1h(mutated, spec);
  assert.deepEqual(
    baseSignals.filter(s => s.barIndex < T),
    mutSignals.filter(s => s.barIndex < T),
  );
  const baseSim = simulateTrades(base.rows, baseSignals, { ...spec.virtExec, end: T, intervalSeconds: 3600 });
  const mutSim = simulateTrades(mutated.rows, mutSignals, { ...spec.virtExec, end: T, intervalSeconds: 3600 });
  assert.deepEqual(baseSim.trades, mutSim.trades);
});

test('validation rejects future HTF alignment lookahead', () => {
  const ds = sliceDatasetPrefix1h(loadJson(BTC_TV6K_PATH), 400);
  const bad = structuredClone(ds);
  bad.htf['4h'].alignedIndex[300] = Math.min(bad.htf['4h'].rows.length - 1, bad.htf['4h'].alignedIndex[300] + 1);
  const spec = buildSignalSpecs1h()[0];
  assert.throws(() => generateSignals1h(bad, spec), /Lookahead violation/);
});
