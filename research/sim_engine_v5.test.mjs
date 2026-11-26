import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateTrades } from './sim_engine.mjs';
import {
  simulateTradesV5,
  simulatePortfolioV5,
  DEFAULT_SIM_OPTIONS_V5,
  wilsonLowerBound,
} from './sim_engine_v5.mjs';
import {
  alignFundingToBarsCausal,
  parseOkxFundingRow,
  parseBinanceFundingRow,
  mergeFundingSources,
  validateContiguous8hFunding,
} from './fetch_okx_derivs.mjs';

const START = Date.parse('2026-09-01T00:00:00Z') / 1000;
const INTERVAL = 900;
const BASE_OPTS = {
  warmup: 0,
  cooldown: 5,
  stopAtr: 1.5,
  rewardRisk: 1.0,
  maxHoldBars: 20,
  costPct: 0,
  slippagePct: 0,
  intervalSeconds: INTERVAL,
};

function fixture(length = 30, interval = INTERVAL, start = START) {
  return Array.from({ length }, (_, i) => ({
    time: start + i * interval,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  }));
}

function near(actual, expected, tolerance = 1e-10) {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('STRICT_TAKER parity with sim_engine.mjs across MARKET_NEXT_OPEN and LIMIT_PULLBACK', () => {
  const rows = fixture(40, 3600, 1788220800); // exact 8h-aligned start
  // Trade 0: MARKET_NEXT_OPEN long, bar 1 enters, bar 2 hits TP1, bar 3 exits BE
  Object.assign(rows[1], { open: 100, high: 102.5, low: 99.5, close: 101.8 });
  Object.assign(rows[2], { open: 101.8, high: 103.5, low: 101.6, close: 102.5 });
  Object.assign(rows[3], { open: 102.5, high: 102.6, low: 100.1, close: 101.0 });

  // Trade 1: LIMIT_PULLBACK short at bar 10, limit 102, fills on bar 11, exits TP on bar 13
  Object.assign(rows[11], { open: 100, high: 102.5, low: 99.5, close: 101 });
  Object.assign(rows[12], { open: 101, high: 101.5, low: 100.0, close: 100.5 });
  Object.assign(rows[13], { open: 100.5, high: 100.8, low: 97.5, close: 98.0 });

  // Trade 2: MARKET_NEXT_OPEN long at bar 20, hits SL on bar 21
  Object.assign(rows[21], { open: 100, high: 100.5, low: 96.0, close: 97.0 });

  // Trade 3: MARKET_NEXT_OPEN short at bar 30, exits TIME across 8h funding boundary (bar 32 is 08:00 UTC)
  Object.assign(rows[31], { open: 100, high: 100.5, low: 99.0, close: 99.5 });
  Object.assign(rows[32], { open: 99.5, high: 100.0, low: 98.5, close: 99.0 });

  const signals = [
    { barIndex: 0, side: 1, atr: 2, entryMode: 'MARKET_NEXT_OPEN' },
    { barIndex: 10, side: -1, atr: 2, entryMode: 'LIMIT_PULLBACK', limitPrice: 102 },
    { barIndex: 20, side: 1, atr: 2, entryMode: 'MARKET_NEXT_OPEN' },
    { barIndex: 30, side: -1, atr: 3, entryMode: 'MARKET_NEXT_OPEN', maxHoldBars: 2 },
  ];

  const opts = {
    warmup: 0,
    cooldown: 5,
    stopAtr: 1.5,
    rewardRisk: 1.2,
    maxHoldBars: 10,
    beTriggerR: 0.5,
    beOffsetPct: 0.25,
    tp1TriggerR: 0.8,
    tp1QtyPct: 40,
    tp1LockOffsetR: 0.4,
    volNormRiskPct: 3.0,
    minLev: 1.0,
    maxLev: 2.5,
    costPct: 0.1,
    slippagePct: 0.025,
    fundingPctPer8h: 0.015,
    intervalSeconds: 3600,
  };

  const ref = simulateTrades(rows, signals, opts);
  const v5 = simulateTradesV5(rows, signals, { ...opts, execProfile: 'STRICT_TAKER' });

  assert.equal(v5.count, ref.count);
  assert.equal(v5.wins, ref.wins);
  assert.equal(v5.losses, ref.losses);
  assert.equal(v5.ties, ref.ties);
  assert.deepEqual(v5.exitReasons, ref.exitReasons);
  near(v5.winRatePct, ref.winRatePct);
  near(v5.totalNetPct, ref.totalNetPct);
  near(v5.compoundedNetPct, ref.compoundedNetPct);
  near(v5.maxDrawdownPct, ref.maxDrawdownPct);
  near(v5.compoundedMaxDrawdownPct, ref.compoundedMaxDrawdownPct);
  near(v5.profitFactor, ref.profitFactor);

  for (let i = 0; i < ref.trades.length; i++) {
    const a = v5.trades[i];
    const b = ref.trades[i];
    for (const k of [
      'signalIndex', 'entryIndex', 'exitIndex', 'side', 'entry', 'stop', 'target',
      'lev', 'exit', 'exitReason', 'grossPct', 'netPct', 'fundingDragPct', 'tp1Hit',
    ]) {
      assert.deepEqual(a[k], b[k], `Mismatch at trade ${i}.${k}`);
    }
  }
});

for (const side of [1, -1]) {
  test(`side ${side}: EXCHANGE_POST_ONLY requires makerBufferPct penetration past limit`, () => {
    const rows = fixture(6);
    const limitPrice = 100;
    // Bar 1 touches limitPrice exactly (and even 0.005% past) -> < 0.01% buffer -> MUST NOT FILL
    if (side === 1) {
      Object.assign(rows[1], { open: 101, high: 101.2, low: 99.995, close: 100.5 });
      // Bar 2 penetrates past 100 * (1 - 0.0001) = 99.99 -> fills at 100 with 0% slip
      Object.assign(rows[2], { open: 100.5, high: 100.8, low: 99.98, close: 100.2 });
      // Bar 3 hits limit TP at 102
      Object.assign(rows[3], { open: 100.2, high: 102.5, low: 100.1, close: 102.1 });
    } else {
      Object.assign(rows[1], { open: 99, high: 100.005, low: 98.8, close: 99.5 });
      // Bar 2 penetrates past 100 * (1 + 0.0001) = 100.01 -> fills at 100 with 0% slip
      Object.assign(rows[2], { open: 99.5, high: 100.02, low: 99.2, close: 99.8 });
      // Bar 3 hits limit TP at 98
      Object.assign(rows[3], { open: 99.8, high: 99.9, low: 97.5, close: 97.9 });
    }

    const res = simulateTradesV5(rows, [{ barIndex: 0, side, atr: 2, limitPrice }], {
      ...BASE_OPTS,
      execProfile: 'EXCHANGE_POST_ONLY',
      entryMode: 'LIMIT_PULLBACK',
      limitExpiryBars: 4,
      stopAtr: 1.0,
      rewardRisk: 1.0,
      makerFeePct: 0.02,
      takerFeePct: 0.05,
      slippagePct: 0.025,
      makerBufferPct: 0.01,
    });

    assert.equal(res.count, 1);
    const t = res.trades[0];
    assert.equal(t.entryIndex, 2); // skipped bar 1 insufficient penetration
    assert.equal(t.exitIndex, 3);
    assert.equal(t.exitReason, 'TP');
    near(t.entry, 100); // 0% slip
    near(t.exit, 100 + side * 2); // 0% slip on limit TP
    // Gross = +2.0%, Fee = 0.02% maker entry + 0.02% maker TP = 0.04%
    near(t.grossPct, 2.0);
    near(t.netPct, 2.0 - 0.04);
  });

  test(`side ${side}: EXCHANGE_POST_ONLY taker SL pays takerFeePct (0.05%) + slippagePct (0.025%)`, () => {
    const rows = fixture(5);
    const limitPrice = 100;
    if (side === 1) {
      Object.assign(rows[1], { open: 100.5, high: 100.8, low: 99.95, close: 100.1 });
      Object.assign(rows[2], { open: 100.1, high: 100.2, low: 97.5, close: 98.0 });
    } else {
      Object.assign(rows[1], { open: 99.5, high: 100.05, low: 99.2, close: 99.9 });
      Object.assign(rows[2], { open: 99.9, high: 102.5, low: 99.8, close: 102.0 });
    }

    const res = simulateTradesV5(rows, [{ barIndex: 0, side, atr: 2, limitPrice }], {
      ...BASE_OPTS,
      execProfile: 'EXCHANGE_POST_ONLY',
      entryMode: 'LIMIT_PULLBACK',
      limitExpiryBars: 3,
      stopAtr: 1.0,
      rewardRisk: 1.0,
      makerFeePct: 0.02,
      takerFeePct: 0.05,
      slippagePct: 0.025,
      makerBufferPct: 0.01,
    });

    assert.equal(res.count, 1);
    const t = res.trades[0];
    assert.equal(t.exitReason, 'SL');
    near(t.entry, 100);
    const expectedStop = 100 - side * 2;
    const expectedExit = expectedStop * (1 - side * 0.00025);
    near(t.exit, expectedExit);
    const expectedGross = (side * (expectedExit - 100)) / 100 * 100;
    near(t.grossPct, expectedGross);
    // Fee = 0.02% maker entry + 0.05% taker SL = 0.07%
    near(t.netPct, expectedGross - 0.07);
  });
}

test('EXCHANGE_POST_ONLY gap through limit fills at limitPrice (no windfall gap improvement, no adverse slip)', () => {
  const rows = fixture(4);
  // Long limit at 98, bar 1 gaps down to open 96 (high 97, low 95.5, close 97.5)
  Object.assign(rows[1], { open: 96, high: 97.5, low: 95.5, close: 97.2 });
  // Bar 2 hits TP at 100 (entry=98, stopAtr=1, atr=2 => stop=96? Wait: use stopAtr=2 => stop=94, target=102)
  Object.assign(rows[2], { open: 97.2, high: 102.5, low: 97.0, close: 102.0 });

  const res = simulateTradesV5(rows, [{ barIndex: 0, side: 1, atr: 2, limitPrice: 98 }], {
    ...BASE_OPTS,
    execProfile: 'EXCHANGE_POST_ONLY',
    entryMode: 'LIMIT_PULLBACK',
    stopAtr: 2.0,
    rewardRisk: 1.0,
  });
  assert.equal(res.count, 1);
  const t = res.trades[0];
  near(t.entry, 98); // fills cleanly at limitPrice, NOT 96 windfall
  near(t.exit, 102);
  near(t.netPct, (4 / 98) * 100 - 0.04);
});

test('EXCHANGE_POST_ONLY partial TP1 (maker) + BE runner (taker) splits fees and slippage accurately', () => {
  const rows = fixture(5);
  Object.assign(rows[1], { open: 100.5, high: 102.2, low: 99.98, close: 101.5 });
  // Wait: bar 1 filled limit at 100 (low 99.98 <= 99.99), limitSameBarTp='close' -> close 101.5 < TP1(102), so TP1 doesn't hit on bar 1.
  // Bar 2 hits TP1 at 102 by wick (and closes at 101.5) -> locks runner at 101 (+0.5R)
  Object.assign(rows[2], { open: 101.5, high: 102.5, low: 101.2, close: 101.5 });
  // Bar 3 hits BE runner stop at 101
  Object.assign(rows[3], { open: 101.5, high: 101.6, low: 100.8, close: 101.0 });

  const res = simulateTradesV5(rows, [{ barIndex: 0, side: 1, atr: 2, limitPrice: 100 }], {
    ...BASE_OPTS,
    execProfile: 'EXCHANGE_POST_ONLY',
    entryMode: 'LIMIT_PULLBACK',
    stopAtr: 1.0,
    rewardRisk: 2.0,
    tp1TriggerR: 1.0,
    tp1QtyPct: 50,
    tp1LockOffsetR: 0.5,
    makerFeePct: 0.02,
    takerFeePct: 0.05,
    slippagePct: 0.025,
    makerBufferPct: 0.01,
  });

  assert.equal(res.count, 1);
  const t = res.trades[0];
  assert.equal(t.tp1Hit, true);
  assert.equal(t.exitReason, 'BE');
  const leg1Net = 2.0 - 0.04; // 0% slip, 0.02+0.02 fee
  const beExit = 101 * (1 - 0.00025);
  const leg2Gross = ((beExit - 100) / 100) * 100;
  const leg2Net = leg2Gross - 0.07; // 0.025% slip, 0.02+0.05 fee
  near(t.netPct, 0.5 * leg1Net + 0.5 * leg2Net);
});

test('real fundingRows cashflows apply -side * ratePct * remFrac * lev for +/- rates', () => {
  const base8h = 1788220800; // multiple of 28800
  assert.equal(base8h % 28800, 0);
  const rows = [
    { time: base8h - 7200, open: 100, high: 101, low: 99, close: 100, volume: 10 },
    { time: base8h - 3600, open: 100, high: 102.5, low: 99.5, close: 101.5, volume: 10 }, // bar 1 entry + wick TP1 (50% @ 102)
    { time: base8h,        open: 101.5, high: 101.8, low: 101.2, close: 101.5, volume: 10 }, // bar 2 8h funding #1 (remFrac=0.5)
    { time: base8h + 28800, open: 101.5, high: 104.5, low: 101.2, close: 104.0, volume: 10 }, // bar 3 8h funding #2 + TP2 (remFrac=0.5)
  ];
  // Use contiguous 1h rows across 0..9? Let's make exact 1h contiguous rows from base8h-7200 to base8h+28800!
  const fullRows = [];
  for (let t = base8h - 7200; t <= base8h + 28800; t += 3600) {
    fullRows.push({ time: t, open: 101.5, high: 101.8, low: 101.2, close: 101.5, volume: 10 });
  }
  Object.assign(fullRows[0], { open: 100, high: 101, low: 99, close: 100 });
  Object.assign(fullRows[1], { open: 100, high: 102.5, low: 99.5, close: 101.5 }); // entry + TP1
  const lastIdx = fullRows.length - 1; // base8h + 28800
  Object.assign(fullRows[lastIdx], { open: 101.5, high: 104.5, low: 101.2, close: 104.0 }); // TP2

  const fundingRows = [
    { time: base8h, fundingRate: 0.0004 },         // +0.04% -> long pays -0.04% * 0.5 = -0.02% (1x)
    { time: base8h + 28800, fundingRate: -0.0001 }, // -0.01% -> long receives +0.01% * 0.5 = +0.005% (1x)
  ];
  // Net 1x funding cashflow = (-0.02 + 0.005) = -0.015%; at 2x lev = -0.03%
  const longRes = simulateTradesV5(fullRows, [{ barIndex: 0, side: 1, atr: 2 }], {
    ...BASE_OPTS,
    intervalSeconds: 3600,
    stopAtr: 1.0,
    rewardRisk: 2.0,
    maxHoldBars: 20,
    tp1TriggerR: 1.0,
    tp1QtyPct: 50,
    fixedLev: 2.0,
    fundingRows,
  });

  assert.equal(longRes.count, 1);
  const lt = longRes.trades[0];
  near(lt.fundingCashflowPct, -0.03);
  near(lt.fundingDragPct, 0.03);
  // 1x trade PnL = 0.5*2% + 0.5*4% - 0.015% = 2.985%; 2x = 5.97%
  near(lt.unleveredNetPct, 2.985);
  near(lt.netPct, 5.97);

  // For SHORT (-1) with same fundingRows at 2x: positive rate = receives, negative rate = pays -> +0.03%
  const shortRows = fullRows.map(r => ({ ...r }));
  Object.assign(shortRows[1], { open: 100, high: 100.5, low: 97.5, close: 98.5 });
  for (let k = 2; k < shortRows.length - 1; k++) {
    Object.assign(shortRows[k], { open: 98.5, high: 98.8, low: 98.2, close: 98.5 });
  }
  Object.assign(shortRows[lastIdx], { open: 98.5, high: 98.8, low: 95.5, close: 96.0 });

  const shortRes = simulateTradesV5(shortRows, [{ barIndex: 0, side: -1, atr: 2 }], {
    ...BASE_OPTS,
    intervalSeconds: 3600,
    stopAtr: 1.0,
    rewardRisk: 2.0,
    maxHoldBars: 20,
    tp1TriggerR: 1.0,
    tp1QtyPct: 50,
    fixedLev: 2.0,
    fundingRows,
  });
  near(shortRes.trades[0].fundingCashflowPct, 0.03);
  near(shortRes.trades[0].fundingDragPct, -0.03);
  near(shortRes.trades[0].netPct, 6.03);
});

test('signal.sizeMult scales volNormRiskPct clamped to [minLev, maxLev]', () => {
  const rows = fixture(12);
  // stopDistPct = 2% (atr=2, stopAtr=1, entry=100). volNormRiskPct = 3.0 -> base lev = 1.5
  Object.assign(rows[1], { open: 100, high: 102.5, low: 99.5, close: 102.2 }); // TP
  Object.assign(rows[7], { open: 100, high: 102.5, low: 99.5, close: 102.2 }); // TP

  const res = simulateTradesV5(rows, [
    { barIndex: 0, side: 1, atr: 2, sizeMult: 1.6 }, // 3.0 * 1.6 / 2 = 2.4 (in [1.0, 3.0])
    { barIndex: 6, side: 1, atr: 2, sizeMult: 3.0 }, // 3.0 * 3.0 / 2 = 4.5 -> clamped to maxLev=3.0
  ], {
    ...BASE_OPTS,
    stopAtr: 1.0,
    rewardRisk: 1.0,
    volNormRiskPct: 3.0,
    minLev: 1.0,
    maxLev: 3.0,
    costPct: 0.1,
  });

  assert.equal(res.count, 2);
  near(res.trades[0].lev, 2.4);
  near(res.trades[0].netPct, 1.9 * 2.4);
  near(res.trades[1].lev, 3.0);
  near(res.trades[1].netPct, 1.9 * 3.0);
});

test('alignFundingToBarsCausal and parseOkxFundingRow enforce strict zero lookahead', () => {
  const f1 = parseOkxFundingRow({
    fundingTime: '1788220800000',
    fundingRate: '0.0001',
    realizedRate: '0.00009',
  });
  const f2 = parseOkxFundingRow({
    fundingTime: '1788249600000', // +28800s (8h later)
    fundingRate: '-0.0002',
  });
  assert.deepEqual(f1, { time: 1788220800, fundingRate: 0.0001, realizedRate: 0.00009 });
  assert.deepEqual(f2, { time: 1788249600, fundingRate: -0.0002, realizedRate: -0.0002 });

  const bars = [
    { time: 1788217200 }, // 1h before f1 -> null
    { time: 1788220800 }, // exact f1 -> f1
    { time: 1788246000 }, // 1h before f2 -> still f1 (zero lookahead!)
    { time: 1788249600 }, // exact f2 -> f2
  ];

  const aligned = alignFundingToBarsCausal(bars, [f1, f2]);
  assert.deepEqual(aligned, [null, f1, f1, f2]);

  // Mutating/appending future funding after bar 2 must not change prefix [0..2]
  const alignedPrefix = alignFundingToBarsCausal(bars.slice(0, 3), [f1]);
  assert.deepEqual(aligned.slice(0, 3), alignedPrefix);
});

test('simulatePortfolioV5 enforces maxTotalOpenLev, chronological compounding, and causality', () => {
  // Stream A (1h): bar 0..3
  const rowsA = fixture(5, 3600, START);
  // Stream B (15m): bar 0..19 (same span)
  const rowsB = fixture(20, 900, START);

  // Trade A1: enters bar 0 (t=START), exits bar 1 (t=START+3600 -> closes at START+7200), lev=2.5, netPct=+10%
  // Trade B1: enters bar 1 (t=START+900, overlapping A1!), exits bar 3 (closes at START+3600), lev=2.5, netPct=+10%
  //   -> openLev=2.5, cap=4.0 -> avail=1.5 -> B1 scales by 1.5/2.5 = 0.6 -> portfolioNetPct = +6%
  // Trade B2: enters bar 4 (t=START+3600), while A1 is STILL open (closes START+7200) and B1 ALREADY closed (at START+3600)!
  //   -> openLev=2.5 (only A1), avail=1.5 -> B2 (lev=3.0) scales by 0.5 -> portfolioNetPct = -5% (from -10%)
  // Trade B3: enters bar 8 (t=START+7200), A1 has closed at START+7200 -> openLev=0 -> full lev=2.0, netPct=+5%
  const tradesA = [
    { entryIndex: 0, exitIndex: 1, side: 1, lev: 2.5, grossPct: 10.2, netPct: 10.0 },
  ];
  const tradesB = [
    { entryIndex: 1, exitIndex: 3, side: 1, lev: 2.5, grossPct: 10.2, netPct: 10.0 },
    { entryIndex: 4, exitIndex: 5, side: -1, lev: 3.0, grossPct: -9.8, netPct: -10.0 },
    { entryIndex: 8, exitIndex: 9, side: 1, lev: 2.0, grossPct: 5.1, netPct: 5.0 },
  ];

  const pf = simulatePortfolioV5([
    { id: 'BTC:1h', rows: rowsA, trades: tradesA },
    { id: 'BTC:15m', rows: rowsB, trades: tradesB },
  ], { maxTotalOpenLev: 4.0 });

  assert.equal(pf.count, 4);
  assert.ok(pf.peakOpenLev <= 4.0 + 1e-12);
  near(pf.peakOpenLev, 4.0);
  assert.equal(pf.scaledByCapCount, 2);
  assert.equal(pf.skippedByCapCount, 0);

  // Chronological exit order:
  // 1) B1 exits at START+3600: +6% -> eq = 1.06
  // 2) B2 exits at START+5400: -5% -> eq = 1.06 * 0.95 = 1.007
  // 3) A1 exits at START+7200: +10% -> eq = 1.007 * 1.10 = 1.1077
  // 4) B3 exits at START+9000: +5% -> eq = 1.1077 * 1.05 = 1.163085
  near(pf.trades[0].portfolioNetPct, 6.0);
  near(pf.trades[1].portfolioNetPct, -5.0);
  near(pf.trades[2].portfolioNetPct, 10.0);
  near(pf.trades[3].portfolioNetPct, 5.0);
  near(pf.compoundedNetPct, 16.3085);
  near(pf.maxDrawdownPct, 5.0);
  near(pf.compoundedMaxDrawdownPct, 5.0);
  near(pf.retToDd, 16.3085 / 5.0);
  near(pf.WR, 75.0);
  near(pf.PF, (6 + 10 + 5) / 5);
  near(wilsonLowerBound(pf.wins, pf.count), pf.wilsonLower95Pct);

  // When cap is saturated (stream 1 uses full 4.0 lev), overlapping stream 2 trade is skipped!
  const saturated = simulatePortfolioV5([
    { id: 'S1', rows: rowsA, trades: [{ entryIndex: 0, exitIndex: 2, side: 1, lev: 4.0, grossPct: 4, netPct: 4 }] },
    { id: 'S2', rows: rowsB, trades: [{ entryIndex: 1, exitIndex: 2, side: 1, lev: 2.0, grossPct: 2, netPct: 2 }] },
  ], { maxTotalOpenLev: 4.0 });
  assert.equal(saturated.count, 1);
  assert.equal(saturated.skippedByCapCount, 1);
  assert.equal(saturated.trades[0].streamId, 'S1');

  // Causality check: truncating future trades past START+7200 must leave prefix identical
  const prefixPf = simulatePortfolioV5([
    { id: 'BTC:1h', rows: rowsA.slice(0, 3), trades: tradesA },
    { id: 'BTC:15m', rows: rowsB.slice(0, 8), trades: tradesB.slice(0, 2) },
  ], { maxTotalOpenLev: 4.0 });
  assert.equal(prefixPf.count, 3);
  assert.deepEqual(
    prefixPf.trades.map(t => [t.streamId, t.effectiveLev, t.portfolioNetPct]),
    pf.trades.slice(0, 3).map(t => [t.streamId, t.effectiveLev, t.portfolioNetPct]),
  );
});

test('parseBinanceFundingRow snaps +ms jitter to 8h UTC and mergeFundingSources gives OKX precedence', () => {
  const b1 = parseBinanceFundingRow({ fundingTime: 1700697600004, fundingRate: '0.00015' });
  const b2 = parseBinanceFundingRow({ fundingTime: 1700726400001, fundingRate: '-0.00005' });
  assert.equal(b1.time, 1700697600);
  assert.equal(b1.time % 28800, 0);
  assert.equal(b2.time, 1700726400);
  assert.equal(b2.time % 28800, 0);

  const merged = mergeFundingSources(
    [
      { time: b1.time, fundingRate: b1.fundingRate, realizedRate: b1.realizedRate, source: 'BINANCE_FAPI' },
      { time: b2.time, fundingRate: b2.fundingRate, realizedRate: b2.realizedRate, source: 'BINANCE_FAPI' },
    ],
    [
      { time: b2.time, fundingRate: 0.0002, realizedRate: 0.0002, source: 'OKX' },
    ],
  );
  validateContiguous8hFunding(merged.rows, 'merged-test');
  assert.equal(merged.rows.length, 2);
  assert.deepEqual(merged.sources, { BINANCE_FAPI: 1, OKX: 1 });
  assert.equal(merged.rows[1].source, 'OKX');
  assert.equal(merged.rows[1].fundingRate, 0.0002);
});
