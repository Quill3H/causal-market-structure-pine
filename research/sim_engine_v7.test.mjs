import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateTradesV7,
  simulatePortfolioV7,
  summarizeMonthlyCashflowV7,
} from './sim_engine_v7.mjs';

const START = Date.parse('2026-01-01T00:00:00Z') / 1000;
const HOUR = 3600;

function fixture(length = 12, interval = HOUR, start = START) {
  return Array.from({ length }, (_, i) => ({
    time: start + i * interval,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }));
}

function near(actual, expected, tolerance = 1e-10) {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('single-stream isolated LIQUIDATION triggers on worst wick BEFORE TP/BE and zeroes equity', () => {
  const rows = fixture(6);
  // 10x leverage -> liq threshold = -((1/10) - 0.005) = -9.5% (price <= 90.5 for long)
  // Bar 1 enters long at 100 (stop=95? No, suppose wide stop=85, target=115, RR=1.0),
  // AND bar 1 wicks down to 90.0 (-10% <= -9.5%) while ALSO spiking high to 120 (above TP)!
  // Must trigger LIQUIDATION (not TP!), netPct = -100, equity drops to 0.
  Object.assign(rows[1], { open: 100, high: 120, low: 90.0, close: 118 });
  // Bar 4 has a second signal, which must be ignored after equity drops to 0
  Object.assign(rows[4], { open: 100, high: 105, low: 99, close: 104 });

  const res = simulateTradesV7(rows, [
    { barIndex: 0, side: 1, atr: 15 },
    { barIndex: 3, side: 1, atr: 2 },
  ], {
    warmup: 0,
    cooldown: 1,
    stopAtr: 1.0,
    rewardRisk: 1.0,
    fixedLev: 10.0,
    mmr: 0.005,
    isolatedLiqCheck: true,
    intervalSeconds: HOUR,
  });

  assert.equal(res.count, 1);
  assert.equal(res.liquidationCount, 1);
  assert.equal(res.exitReasons.LIQUIDATION, 1);
  assert.equal(res.trades[0].exitReason, 'LIQUIDATION');
  near(res.trades[0].netPct, -100);
  near(res.finalEquity, 0);
  near(res.compoundedNetPct, -100);
  assert.equal(res.ignoredSignals, 1); // signal after wipeout ignored
});

test('multi-stream cross-margin LIQUIDATION triggers when simultaneous wicks breach mmr * notional', () => {
  const rowsA = fixture(5, HOUR, START);
  const rowsB = fixture(5, HOUR, START);

  // Trade A (lev=8): enters bar 1 at 100, exits bar 3 at 102 (+16% if not liquidated)
  // Trade B (lev=8): enters bar 1 at 100, exits bar 3 at 102 (+16% if not liquidated)
  // Combined concurrent notional = 16x equity, mmr = 0.005 -> maintMargin = 8% of equity.
  // On bar 2, BOTH A and B drop -6.0% simultaneously (low = 94.0):
  //   Worst unrealized PnL = 8 * (-6%) + 8 * (-6%) = -96% -> mtmEquity = 4% <= 8% -> CROSS-MARGIN LIQUIDATION!
  // Note: individually at 8x, each -6% drop is only -48% (would NOT trigger isolated liq at -12%!).
  Object.assign(rowsA[1], { open: 100, high: 101, low: 99, close: 100 });
  Object.assign(rowsB[1], { open: 100, high: 101, low: 99, close: 100 });
  Object.assign(rowsA[2], { open: 100, high: 100.5, low: 94.0, close: 99 });
  Object.assign(rowsB[2], { open: 100, high: 100.5, low: 94.0, close: 99 });
  Object.assign(rowsA[3], { open: 99, high: 103, low: 98.5, close: 102 });
  Object.assign(rowsB[3], { open: 99, high: 103, low: 98.5, close: 102 });

  const simA = simulateTradesV7(rowsA, [{ barIndex: 0, side: 1, atr: 10 }], {
    warmup: 0, stopAtr: 1.0, rewardRisk: 1.0, fixedLev: 2.0, maxHoldBars: 3, costPct: 0, slippagePct: 0, intervalSeconds: HOUR,
  });
  const simB = simulateTradesV7(rowsB, [{ barIndex: 0, side: 1, atr: 10 }], {
    warmup: 0, stopAtr: 1.0, rewardRisk: 1.0, fixedLev: 2.0, maxHoldBars: 3, costPct: 0, slippagePct: 0, intervalSeconds: HOUR,
  });
  // At 2x (total 4x), neither liquidates
  assert.equal(simA.liquidationCount, 0);
  assert.equal(simB.liquidationCount, 0);

  // Scale levScale=4 -> each is 8x (total 16x), concurrent -6% wicks breach 8% maint margin!
  const pfLiq = simulatePortfolioV7([
    { id: 'A', rows: rowsA, trades: simA.trades },
    { id: 'B', rows: rowsB, trades: simB.trades },
  ], { maxTotalOpenLev: 20.0, levScale: 4.0, mmr: 0.005 });

  assert.equal(pfLiq.liquidationCount, 1);
  assert.equal(pfLiq.trades.some(t => t.exitReason === 'LIQUIDATION'), true);
  near(pfLiq.finalEquity, 0);
  near(pfLiq.compoundedNetPct, -100);
});

test('High-WR Two-Stage Maker TP1 + Micro-BE+ works under EXCHANGE_POST_ONLY and supports tp1FeeMode MAKER vs TAKER', () => {
  const rows = fixture(6);
  // Limit pullback long at 100 (stop=98, target=103 -> RR=1.5), TP1=0.6R (101.2), qty=50%, tp1LockOffsetR=0.3 (100.6)
  // Bar 1 penetrates 99.98 (<= 99.99) -> fills at 100 (0% slip, 0.02% maker)
  Object.assign(rows[1], { open: 100.5, high: 100.8, low: 99.98, close: 100.5 });
  // Bar 2 wicks to 101.5 (hits TP1=101.2), closes at 100.9 -> arms TP1 lock at 100.6
  Object.assign(rows[2], { open: 100.5, high: 101.5, low: 100.3, close: 100.9 });
  // Bar 3 hits raised runner stop 100.6 -> exits BE
  Object.assign(rows[3], { open: 100.9, high: 101.0, low: 100.5, close: 100.7 });

  const baseCfg = {
    execProfile: 'EXCHANGE_POST_ONLY',
    entryMode: 'LIMIT_PULLBACK',
    warmup: 0,
    stopAtr: 1.0,
    rewardRisk: 1.5,
    tp1TriggerR: 0.6,
    tp1QtyPct: 50,
    tp1LockOffsetR: 0.3,
    makerFeePct: 0.02,
    takerFeePct: 0.05,
    slippagePct: 0.025,
    makerBufferPct: 0.01,
    intervalSeconds: HOUR,
  };

  const makerTp1 = simulateTradesV7(rows, [{ barIndex: 0, side: 1, atr: 2, limitPrice: 100 }], {
    ...baseCfg, tp1FeeMode: 'MAKER',
  });
  const takerTp1 = simulateTradesV7(rows, [{ barIndex: 0, side: 1, atr: 2, limitPrice: 100 }], {
    ...baseCfg, tp1FeeMode: 'TAKER',
  });

  assert.equal(makerTp1.count, 1);
  assert.equal(makerTp1.trades[0].tp1Hit, true);
  assert.equal(makerTp1.trades[0].exitReason, 'BE');
  assert.equal(makerTp1.winRatePct, 100);
  // MAKER TP1 avoids 0.025% slip and pays 0.02% vs 0.05% fee on leg 1
  const leg1Maker = 1.2 - 0.04;
  const leg1Taker = (((101.2 * (1 - 0.00025) - 100) / 100) * 100) - 0.07;
  const leg2Be = (((100.6 * (1 - 0.00025) - 100) / 100) * 100) - 0.07;
  near(makerTp1.trades[0].netPct, 0.5 * leg1Maker + 0.5 * leg2Be);
  near(takerTp1.trades[0].netPct, 0.5 * leg1Taker + 0.5 * leg2Be);
  assert.ok(makerTp1.trades[0].netPct > takerTp1.trades[0].netPct);
});

test('summarizeMonthlyCashflowV7 computes Monthly Profit-Sweep vs Compounded Growth across all UTC months (including 0-trade months)', () => {
  // Span 4 months: 2026-01, 2026-02 (0 trades!), 2026-03, 2026-04
  const jan1 = Date.parse('2026-01-10T00:00:00Z') / 1000;
  const mar1 = Date.parse('2026-03-10T00:00:00Z') / 1000;
  const apr1 = Date.parse('2026-04-10T00:00:00Z') / 1000;
  const startSec = Date.parse('2026-01-01T00:00:00Z') / 1000;
  const endSec = Date.parse('2026-04-30T23:00:00Z') / 1000;

  const trades = [
    { entryTime: jan1, exitTime: jan1 + 3600, grossPct: 30, netPct: 30, exitReason: 'TP' },     // 2026-01: +30%
    { entryTime: mar1, exitTime: mar1 + 3600, grossPct: -10, netPct: -10, exitReason: 'SL' },   // 2026-03: -10%
    { entryTime: apr1, exitTime: apr1 + 3600, grossPct: 20, netPct: 20, exitReason: 'TP' },     // 2026-04 (1): +20%
    { entryTime: apr1 + 7200, exitTime: apr1 + 10800, grossPct: 10, netPct: 10, exitReason: 'TP' }, // 2026-04 (2): intra-month comp = 1.2*1.1-1 = +32%
  ];

  const m = summarizeMonthlyCashflowV7(trades, { startSec, endSec });
  assert.equal(m.totalMonths, 4);
  assert.equal(m.monthlyTable.length, 4);
  assert.equal(m.monthlyTable[1].month, '2026-02');
  assert.equal(m.monthlyTable[1].count, 0);
  near(m.monthlyTable[0].sweepNetPct, 30);
  near(m.monthlyTable[1].sweepNetPct, 0);
  near(m.monthlyTable[2].sweepNetPct, -10);
  near(m.monthlyTable[3].sweepNetPct, 32);

  // Mean = (30 + 0 - 10 + 32) / 4 = 13.0%
  near(m.meanMonthlySweepPct, 13.0);
  // Sorted: [-10, 0, 30, 32] -> median = 15.0%
  near(m.medianMonthlySweepPct, 15.0);
  near(m.pctPositiveMonths, 50.0); // Jan (+30) & Apr (+32)
  near(m.pctMonthsGe30, 50.0);     // Jan (+30) & Apr (+32)
  near(m.worstMonthPct, -10.0);
  near(m.maxMonthlySweepDdPct, 10.0);
  const expectedCompEq = 1.3 * 0.9 * 1.2 * 1.1; // 1.5444 -> +54.44%
  near(m.compoundedNetPct, (expectedCompEq - 1) * 100);
  near(m.geomMonthlyPct, (Math.pow(expectedCompEq, 1 / 4) - 1) * 100);
  assert.equal(m.liquidationCount, 0);
});

test('simulateTradesV7 causality: prefix truncation and future mutation invariance', () => {
  const rows = fixture(20);
  Object.assign(rows[1], { open: 100, high: 102.5, low: 99.5, close: 102.0 });
  Object.assign(rows[6], { open: 100, high: 102.5, low: 99.5, close: 102.0 });
  const signals = [
    { barIndex: 0, side: 1, atr: 2, sizeMult: 1.2 },
    { barIndex: 5, side: 1, atr: 2, sizeMult: 0.9 },
    { barIndex: 14, side: -1, atr: 2 },
  ];
  const opts = {
    execProfile: 'EXCHANGE_POST_ONLY',
    warmup: 0,
    cooldown: 3,
    stopAtr: 1.0,
    rewardRisk: 1.0,
    end: 10,
    intervalSeconds: HOUR,
  };
  const expected = simulateTradesV7(rows, signals, opts);
  const prefix = simulateTradesV7(rows.slice(0, 10), signals.slice(0, 2), { ...opts, end: 10 });
  assert.deepEqual(expected, prefix);
});
