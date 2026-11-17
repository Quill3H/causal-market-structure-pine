import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_15M_PARAMS,
  DEFAULT_15M_SIM_OPTIONS,
  alignHtfClosedIndices,
  build15mCandidates,
  calcPineAtr,
  calcPineEma,
  calcPineRsi,
  generate15mSignals,
} from './signals_15m.mjs';
import { simulateTrades } from './sim_engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, '..', 'data');

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function truncateDataset(dataset, rowEnd) {
  const rows = dataset.rows.slice(0, rowEnd);
  const lastOpen = rows[rows.length - 1].time;
  const h1 = dataset.htf['1h'];
  const h1Interval = h1.intervalSeconds ?? 3600;
  // Keep ONLY closed HTF bars where htf.time + htfInterval <= lastOpen (zero future HTF bars exist!)
  const h1Rows = h1.rows.filter(r => r.time + h1Interval <= lastOpen);
  const alignedIndex = h1.alignedIndex.slice(0, rowEnd);
  return {
    ...dataset,
    rows,
    htf: {
      ...dataset.htf,
      '1h': {
        ...h1,
        rows: h1Rows,
        alignedIndex,
      },
    },
  };
}

test('Pine EMA, ATR, and RSI match exact TradingView Pine v6 formulas', () => {
  const closes = [10, 11, 12, 13, 14];
  const ema3 = calcPineEma(closes, 3);
  assert.ok(Number.isNaN(ema3[0]) && Number.isNaN(ema3[1]));
  assert.ok(Math.abs(ema3[2] - 11) < 1e-12); // SMA(10,11,12) = 11
  assert.ok(Math.abs(ema3[3] - 12) < 1e-12); // 11 + 0.5*(13-11) = 12
  assert.ok(Math.abs(ema3[4] - 13) < 1e-12); // 12 + 0.5*(14-12) = 13

  const rows = [
    { open: 100, high: 102, low: 98, close: 101 }, // tr = 4
    { open: 101, high: 105, low: 100, close: 104 }, // tr = 5
    { open: 104, high: 106, low: 102, close: 103 }, // tr = 4
  ];
  const atr2 = calcPineAtr(rows, 2);
  assert.ok(Number.isNaN(atr2[0]));
  assert.ok(Math.abs(atr2[1] - 4.5) < 1e-12);
  assert.ok(Math.abs(atr2[2] - 4.25) < 1e-12);

  const rsi2 = calcPineRsi([100, 102, 104, 101], 2);
  assert.ok(Number.isNaN(rsi2[0]) && Number.isNaN(rsi2[1]));
  assert.ok(Math.abs(rsi2[2] - 100) < 1e-12);
  assert.ok(rsi2[3] > 0 && rsi2[3] < 100);
});

test('alignHtfClosedIndices never maps to an unclosed HTF bar', () => {
  const ds = loadJson('btcusdt_tv_15m_6k.json');
  const h1 = ds.htf['1h'];
  const aligned = alignHtfClosedIndices(ds.rows, h1.rows, h1.intervalSeconds);
  for (let i = 0; i < ds.rows.length; i++) {
    const j = aligned[i];
    assert.equal(j, h1.alignedIndex[i]);
    assert.ok(h1.rows[j].time + h1.intervalSeconds <= ds.rows[i].time);
    if (j + 1 < h1.rows.length) {
      assert.ok(h1.rows[j + 1].time + h1.intervalSeconds > ds.rows[i].time);
    }
  }
});

test('prefix-truncation causality: signals and closed trades are 100% invariant to future bars', () => {
  const full = loadJson('btcusdt_15m_12m.json');
  const fullSignals = generate15mSignals(full, DEFAULT_15M_PARAMS);
  const fullSim = simulateTrades(full.rows, fullSignals, DEFAULT_15M_SIM_OPTIONS);

  for (const T of [1200, 5432, 17520, 26280]) {
    const prefixDs = truncateDataset(full, T);
    const prefixSignals = generate15mSignals(prefixDs, DEFAULT_15M_PARAMS);

    // Every signal strictly before T must be identical bit-for-bit.
    const expectedSignals = fullSignals.filter(s => s.barIndex < T);
    assert.deepEqual(prefixSignals, expectedSignals, `Signals mutated under prefix truncation at T=${T}`);

    // Mutate future bars beyond T on a cloned full dataset and ensure signals < T stay identical.
    const corrupted = {
      ...full,
      rows: full.rows.map((r, idx) => (idx >= T ? { ...r, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 } : r)),
    };
    const corruptedSignals = generate15mSignals(corrupted, DEFAULT_15M_PARAMS).filter(s => s.barIndex < T);
    assert.deepEqual(corruptedSignals, expectedSignals, `Future bar mutation leaked into signals < ${T}`);

    // All trades closing strictly before T must match fullSim identically (entry, BE ratchet, exit).
    const prefixSim = simulateTrades(prefixDs.rows, prefixSignals, DEFAULT_15M_SIM_OPTIONS);
    const expectedTrades = fullSim.trades.filter(t => t.exitIndex < T);
    assert.deepEqual(prefixSim.trades, expectedTrades, `Closed trades mutated under prefix truncation at T=${T}`);
  }
});

test('symmetric mirror invariance: inverting prices swaps Long and Short signals identically', () => {
  const ds = loadJson('btcusdt_tv_15m_6k.json');
  const sub = truncateDataset(ds, 1500);
  // Invert price smoothly via reciprocal * C^2? Wait: affine reflection M - price preserves EMA, ATR, and bar ranges!
  const M = 200000;
  const mirrorRow = r => ({
    time: r.time,
    open: M - r.open,
    high: M - r.low,
    low: M - r.high,
    close: M - r.close,
    volume: r.volume,
  });
  const mirrored = {
    ...sub,
    rows: sub.rows.map(mirrorRow),
    htf: {
      ...sub.htf,
      '1h': {
        ...sub.htf['1h'],
        rows: sub.htf['1h'].rows.map(mirrorRow),
      },
    },
  };

  const testParams = { ...DEFAULT_15M_PARAMS, minAtrPct: 0 };
  const sOrig = generate15mSignals(sub, testParams);
  const sMirr = generate15mSignals(mirrored, testParams);
  assert.equal(sOrig.length, sMirr.length);
  for (let k = 0; k < sOrig.length; k++) {
    assert.equal(sOrig[k].barIndex, sMirr[k].barIndex);
    assert.equal(sOrig[k].side, -sMirr[k].side);
    assert.ok(Math.abs(sOrig[k].atr - sMirr[k].atr) < 1e-8);
    assert.ok(Math.abs((M - sOrig[k].limitPrice) - sMirr[k].limitPrice) < 1e-8);
  }
});

test('scale invariance: multiplying all prices by constant preserves signals with minAtrPct gate', () => {
  const ds = loadJson('btcusdt_tv_15m_6k.json');
  const sub = truncateDataset(ds, 1500);
  const K = 2.5;
  const scaleRow = r => ({
    time: r.time,
    open: r.open * K,
    high: r.high * K,
    low: r.low * K,
    close: r.close * K,
    volume: r.volume,
  });
  const scaled = {
    ...sub,
    rows: sub.rows.map(scaleRow),
    htf: {
      ...sub.htf,
      '1h': {
        ...sub.htf['1h'],
        rows: sub.htf['1h'].rows.map(scaleRow),
      },
    },
  };
  const sOrig = generate15mSignals(sub, DEFAULT_15M_PARAMS);
  const sScaled = generate15mSignals(scaled, DEFAULT_15M_PARAMS);
  assert.equal(sOrig.length, sScaled.length);
  for (let k = 0; k < sOrig.length; k++) {
    assert.equal(sOrig[k].barIndex, sScaled[k].barIndex);
    assert.equal(sOrig[k].side, sScaled[k].side);
    assert.ok(Math.abs(sOrig[k].atr * K - sScaled[k].atr) < 1e-6);
    assert.ok(Math.abs(sOrig[k].limitPrice * K - sScaled[k].limitPrice) < 1e-6);
  }
});

test('build15mCandidates builds well-formed ordered signals across all families', () => {
  const ds = truncateDataset(loadJson('btcusdt_tv_15m_6k.json'), 1000);
  const cands = build15mCandidates(ds);
  assert.ok(cands.length >= 30);
  for (const c of cands) {
    assert.ok(typeof c.id === 'string' && c.id.length > 0);
    assert.ok(c.simOptions.rewardRisk >= 0.75);
    let prev = -1;
    for (const s of c.signals) {
      assert.ok(s.barIndex > prev && s.barIndex >= 250 && s.barIndex < 1000);
      assert.ok(s.side === 1 || s.side === -1);
      assert.ok(Number.isFinite(s.atr) && s.atr > 0);
      assert.ok(Number.isFinite(s.limitPrice) && s.limitPrice > 0);
      prev = s.barIndex;
    }
  }
});
