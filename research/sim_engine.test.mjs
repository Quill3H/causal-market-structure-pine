import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateTrades, wilsonLowerBound, DEFAULT_SIM_OPTIONS } from './sim_engine.mjs';
import { alignHtfIndices, validateContiguousRows } from './fetch_binance_data.mjs';

const START = Date.parse('2026-09-01T00:00:00Z') / 1000;
const INTERVAL = 900;
const OPTIONS = {
  warmup: 0,
  cooldown: 10,
  stopAtr: 1.5,
  rewardRisk: 1,
  maxHoldBars: 20,
  costPct: 0,
  slippagePct: 0,
  intervalSeconds: INTERVAL,
};

function fixture(length = 25) {
  return Array.from({ length }, (_, i) => ({
    time: START + i * INTERVAL,
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

test('a confirmed MARKET_NEXT_OPEN signal enters at next open with frozen ATR', () => {
  const rows = fixture(2);
  Object.assign(rows[0], { high: 120, low: 80, close: 105 });
  Object.assign(rows[1], { open: 110, high: 112, low: 108, close: 111 });
  const result = simulateTrades(rows, [{ barIndex: 0, side: 1, atr: 4 }], {
    ...OPTIONS, maxHoldBars: 1,
  });
  assert.equal(result.count, 1);
  const trade = result.trades[0];
  assert.deepEqual([
    trade.signalIndex, trade.entryIndex, trade.exitIndex, trade.side,
    trade.entry, trade.stop, trade.target, trade.exit, trade.exitReason, trade.atr,
  ], [0, 1, 1, 1, 110, 104, 116, 111, 'TIME', 4]);
  near(trade.grossPct, 100 / 110);
  near(trade.netPct, 100 / 110);
});

for (const side of [1, -1]) {
  test(`side ${side}: configured stop ATR and reward/risk set levels from slipped entry`, () => {
    const rows = fixture(2);
    Object.assign(rows[1], { high: side === 1 ? 102 : 101, low: side === 1 ? 99 : 98 });
    const result = simulateTrades(rows, [{ barIndex: 0, side, atr: 2 }], {
      ...OPTIONS, stopAtr: 1, rewardRisk: 0.75, slippagePct: 0.025, maxHoldBars: 1,
    });
    assert.equal(result.count, 1);
    const trade = result.trades[0];
    const entry = 100 * (1 + side * 0.00025);
    const target = entry + side * 1.5;
    near(trade.entry, entry);
    near(trade.stop, entry - side * 2);
    near(trade.target, target);
    near(trade.exit, target * (1 - side * 0.00025));
    assert.equal(trade.exitReason, 'TP');
  });

  test(`side ${side}: adverse slippage in gross and 0.10% fee in net`, () => {
    const rows = fixture(2);
    rows[1].close = 100 + side;
    const result = simulateTrades(rows, [{ barIndex: 0, side, atr: 10 }], {
      ...OPTIONS, maxHoldBars: 1, slippagePct: 0.025, costPct: 0.1,
    });
    assert.equal(result.count, 1);
    const trade = result.trades[0];
    const entry = 100 * (1 + side * 0.00025);
    const exit = (100 + side) * (1 - side * 0.00025);
    const gross = (side * (exit - entry)) / entry * 100;
    near(trade.entry, entry);
    near(trade.exit, exit);
    near(trade.grossPct, gross);
    near(trade.netPct, gross - 0.1);
    assert.equal(trade.exitReason, 'TIME');
    assert.deepEqual([result.wins, result.losses, result.ties], [1, 0, 0]);
  });

  test(`side ${side}: both barriers on entry bar resolve to SL before TP or TIME`, () => {
    const rows = fixture(2);
    Object.assign(rows[1], { high: 105, low: 95 });
    const result = simulateTrades(rows, [{ barIndex: 0, side, atr: 2 }], {
      ...OPTIONS, maxHoldBars: 1,
    });
    assert.equal(result.count, 1);
    const trade = result.trades[0];
    assert.deepEqual([trade.entryIndex, trade.exitIndex, trade.exitReason, trade.exit],
      [1, 1, 'SL', 100 - side * 3]);
    assert.deepEqual([result.wins, result.losses, result.ties], [0, 1, 0]);
  });

  test(`side ${side}: stop gap fills at worse open, target gap caps at target without favorable improvement`, () => {
    const rowsGapStop = fixture(3);
    const gapStopOpen = 100 - side * 10;
    Object.assign(rowsGapStop[2], { open: gapStopOpen, high: 111, low: 89, close: 100 });
    const rStop = simulateTrades(rowsGapStop, [{ barIndex: 0, side, atr: 2 }], {
      ...OPTIONS, maxHoldBars: 2, slippagePct: 0.025, costPct: 0.1,
    });
    assert.equal(rStop.trades[0].exitReason, 'SL');
    near(rStop.trades[0].exit, gapStopOpen * (1 - side * 0.00025));

    const rowsGapTp = fixture(3);
    Object.assign(rowsGapTp[2], { open: 100 + side * 10, high: 111, low: 89, close: 100 });
    const rTp = simulateTrades(rowsGapTp, [{ barIndex: 0, side, atr: 2 }], {
      ...OPTIONS, maxHoldBars: 2, slippagePct: 0.025,
    });
    const target = 100 * (1 + side * 0.00025) + side * 3;
    assert.equal(rTp.trades[0].exitReason, 'TP');
    near(rTp.trades[0].exit, target * (1 - side * 0.00025));
  });

  test(`side ${side}: LIMIT_PULLBACK fills on touch with min/max(open, limitPrice) + adverse slippage`, () => {
    const rows = fixture(5);
    const limitPrice = 100 - side * 2; // 98 for long, 102 for short
    // Bar 1 doesn't touch limit
    Object.assign(rows[1], { open: 100, high: 101, low: 99, close: 100 });
    // Bar 2 touches limit intra-bar
    if (side === 1) {
      Object.assign(rows[2], { open: 100, high: 100.5, low: 97.5, close: 99 });
    } else {
      Object.assign(rows[2], { open: 100, high: 102.5, low: 99.5, close: 101 });
    }
    // Bar 3 hits TP
    if (side === 1) {
      Object.assign(rows[3], { open: 99, high: 102, low: 98.5, close: 101.5 });
    } else {
      Object.assign(rows[3], { open: 101, high: 101.5, low: 98, close: 98.5 });
    }
    const result = simulateTrades(rows, [{ barIndex: 0, side, atr: 2, limitPrice }], {
      ...OPTIONS,
      entryMode: 'LIMIT_PULLBACK',
      limitExpiryBars: 3,
      stopAtr: 1.5,
      rewardRisk: 1.0,
      slippagePct: 0.025,
      costPct: 0.1,
    });
    assert.equal(result.count, 1);
    const t = result.trades[0];
    const expectedEntry = limitPrice * (1 + side * 0.00025);
    const expectedTarget = expectedEntry + side * 3;
    assert.equal(t.entryIndex, 2);
    assert.equal(t.exitIndex, 3);
    assert.equal(t.exitReason, 'TP');
    near(t.entry, expectedEntry);
    near(t.target, expectedTarget);
    near(t.exit, expectedTarget * (1 - side * 0.00025));
  });

  test(`side ${side}: LIMIT_PULLBACK favorable open gap improves raw fill to open`, () => {
    const rows = fixture(4);
    const limitPrice = 100 - side * 2; // 98 long, 102 short
    const gapOpen = 100 - side * 4;    // 96 long, 104 short (gapped past limit)
    Object.assign(rows[1], { open: gapOpen, high: gapOpen + 1, low: gapOpen - 1, close: gapOpen });
    const result = simulateTrades(rows, [{ barIndex: 0, side, atr: 5, limitPrice }], {
      ...OPTIONS,
      entryMode: 'LIMIT_PULLBACK',
      limitExpiryBars: 3,
      maxHoldBars: 1,
      slippagePct: 0.025,
    });
    assert.equal(result.count, 1);
    near(result.trades[0].entry, gapOpen * (1 + side * 0.00025));
    assert.equal(result.trades[0].exitReason, 'TIME');
  });

  test(`side ${side}: LIMIT_PULLBACK touching SL on fill bar exits SL immediately (and beats TP)`, () => {
    const rows = fixture(3);
    const limitPrice = 100 - side * 2; // 98 long, 102 short
    // Both limit, SL (95 or 105), and TP (101 or 99) touched on bar 1
    Object.assign(rows[1], { open: 100, high: 106, low: 94, close: 100 });
    const result = simulateTrades(rows, [{ barIndex: 0, side, atr: 2, limitPrice }], {
      ...OPTIONS,
      entryMode: 'LIMIT_PULLBACK',
      limitExpiryBars: 2,
      stopAtr: 1.5,
      rewardRisk: 1.0,
    });
    assert.equal(result.count, 1);
    const t = result.trades[0];
    assert.deepEqual([t.entryIndex, t.exitIndex, t.exitReason], [1, 1, 'SL']);
    near(t.exit, limitPrice - side * 3);
  });

  test(`side ${side}: confirmed-close BE+ ratchet arms at close k and activates at k+1`, () => {
    const rows = fixture(5);
    // Entry on bar 1 at 100, initialStopDist = 2 (stop=98/102), target=102/98 (RR=1.0)
    // On bar 1, close advances +0.7R (+1.4 -> 101.4/98.6), low/high stay safe -> arms BE for bar 2+
    if (side === 1) {
      Object.assign(rows[1], { open: 100, high: 101.5, low: 99.5, close: 101.4 });
      // Bar 2 reverses down, touches raised BE stop (100.22505) AND also touches target (102) -> BE wins!
      Object.assign(rows[2], { open: 101.4, high: 102.5, low: 100.0, close: 100.1 });
    } else {
      Object.assign(rows[1], { open: 100, high: 100.5, low: 98.5, close: 98.6 });
      Object.assign(rows[2], { open: 98.6, high: 100.0, low: 97.5, close: 99.9 });
    }
    const result = simulateTrades(rows, [{ barIndex: 0, side, atr: 2 }], {
      ...OPTIONS,
      stopAtr: 1.0,
      rewardRisk: 1.0,
      beTriggerR: 0.65,
      beOffsetPct: 0.2,
      costPct: 0.1,
      slippagePct: 0.025,
    });
    assert.equal(result.count, 1);
    const t = result.trades[0];
    assert.equal(t.exitReason, 'BE');
    assert.equal(t.beArmed, true);
    assert.equal(t.beArmedIndex, 1);
    assert.equal(t.exitIndex, 2);
    assert.ok(t.netPct > 0, `BE+ exit should be net positive, got ${t.netPct}`);
    assert.equal(result.wins, 1);
    assert.equal(result.exitReasons.BE, 1);
  });
}

test('LIMIT_PULLBACK expires strictly after limitExpiryBars', () => {
  const rows = fixture(7);
  // Signal at bar 0 with expiry 3 -> valid bars 1, 2, 3. Touch on bar 4 must NOT fill.
  Object.assign(rows[4], { open: 100, high: 101, low: 95, close: 99 });
  const expired = simulateTrades(rows, [{ barIndex: 0, side: 1, atr: 2, limitPrice: 97 }], {
    ...OPTIONS, entryMode: 'LIMIT_PULLBACK', limitExpiryBars: 3,
  });
  assert.equal(expired.count, 0);
  assert.equal(expired.openPosition, null);
  assert.equal(expired.pending, null);
  assert.equal(expired.expiredOrders, 1);

  // Touch on bar 3 MUST fill
  Object.assign(rows[3], { open: 100, high: 101, low: 97, close: 99 });
  const filled = simulateTrades(rows, [{ barIndex: 0, side: 1, atr: 2, limitPrice: 97 }], {
    ...OPTIONS, entryMode: 'LIMIT_PULLBACK', limitExpiryBars: 3, maxHoldBars: 1,
  });
  assert.equal(filled.count, 1);
  assert.equal(filled.trades[0].entryIndex, 3);
});

test('LIMIT_PULLBACK same-bar TP default ("close") blocks phantom pre-fill wick TP but allows post-fill close TP', () => {
  const rows = fixture(4);
  // Long limit at 98, stop=96 (atr=2, stopAtr=1), target=100 (RR=1)
  // Bar 1 opens at 101 (>= target!), high=101, low=98 (fills limit), close=98.5 (never hit target AFTER fill!)
  Object.assign(rows[1], { open: 101, high: 101, low: 98, close: 98.5 });
  // Bar 2 hits SL at 96
  Object.assign(rows[2], { open: 98.5, high: 99, low: 95.5, close: 96 });
  const blocked = simulateTrades(rows, [{ barIndex: 0, side: 1, atr: 2, limitPrice: 98 }], {
    ...OPTIONS, entryMode: 'LIMIT_PULLBACK', limitExpiryBars: 2, stopAtr: 1, rewardRisk: 1,
  });
  assert.equal(blocked.count, 1);
  assert.equal(blocked.trades[0].exitIndex, 2);
  assert.equal(blocked.trades[0].exitReason, 'SL');

  // If bar 1 closes >= target (and never hit SL), TP is provably reached after fill
  const rowsCloseTp = fixture(4);
  Object.assign(rowsCloseTp[1], { open: 99, high: 100.5, low: 98, close: 100.2 });
  const allowed = simulateTrades(rowsCloseTp, [{ barIndex: 0, side: 1, atr: 2, limitPrice: 98 }], {
    ...OPTIONS, entryMode: 'LIMIT_PULLBACK', limitExpiryBars: 2, stopAtr: 1, rewardRisk: 1,
  });
  assert.equal(allowed.count, 1);
  assert.equal(allowed.trades[0].exitIndex, 1);
  assert.equal(allowed.trades[0].exitReason, 'TP');
});

test('LIMIT_PULLBACK pendingPolicy: ignore vs cancel_replace', () => {
  const rows = fixture(6);
  // Signal 0 at limit 95 (unfilled), Signal 1 at limit 98 (filled on bar 2)
  Object.assign(rows[2], { open: 100, high: 101, low: 98, close: 99 });
  const signals = [
    { barIndex: 0, side: 1, atr: 2, limitPrice: 95 },
    { barIndex: 1, side: 1, atr: 2, limitPrice: 98 },
  ];
  const ignored = simulateTrades(rows, signals, {
    ...OPTIONS, entryMode: 'LIMIT_PULLBACK', limitExpiryBars: 4, cooldown: 1, pendingPolicy: 'ignore',
  });
  assert.equal(ignored.count, 0);
  assert.equal(ignored.ignoredSignals, 1);

  const replaced = simulateTrades(rows, signals, {
    ...OPTIONS, entryMode: 'LIMIT_PULLBACK', limitExpiryBars: 4, cooldown: 1, maxHoldBars: 1, pendingPolicy: 'cancel_replace',
  });
  assert.equal(replaced.count, 1);
  assert.equal(replaced.cancelledPendingOrders, 1);
  assert.equal(replaced.trades[0].signalIndex, 1);
  assert.equal(replaced.trades[0].entryIndex, 2);
});

test('BE+ ratchet does NOT trigger on the arming candle itself', () => {
  const rows = fixture(4);
  // Entry bar 1 at 100, stop=98, target=102. Bar 1 dips to 99.5, closes at 101.5 (arms BE=100.2)
  // Crucially, bar 1 low (99.5) was <= 100.2! It MUST NOT exit BE on bar 1.
  Object.assign(rows[1], { open: 100, high: 101.8, low: 99.5, close: 101.5 });
  // Bar 2 hits target 102 without touching 100.2
  Object.assign(rows[2], { open: 101.5, high: 102.2, low: 101.0, close: 102.0 });
  const result = simulateTrades(rows, [{ barIndex: 0, side: 1, atr: 2 }], {
    ...OPTIONS, stopAtr: 1, rewardRisk: 1, beTriggerR: 0.6, beOffsetPct: 0.2,
  });
  assert.equal(result.count, 1);
  assert.equal(result.trades[0].exitIndex, 2);
  assert.equal(result.trades[0].exitReason, 'TP');
});

test('enforces initial rewardRisk >= 0.75 across options, signal overrides, and explicit stop/target prices', () => {
  const rows = fixture(4);
  assert.throws(() => simulateTrades(rows, [], { ...OPTIONS, rewardRisk: 0.74 }));
  assert.throws(() => simulateTrades(rows, [{ barIndex: 0, side: 1, atr: 2, rewardRisk: 0.5 }], OPTIONS));

  // Explicit stopPrice/targetPrice with RR < 0.75 is rejected without opening trade
  const badRR = simulateTrades(rows, [
    { barIndex: 0, side: 1, stopPrice: 96, targetPrice: 102 }, // stop=4, tp=2 => RR=0.5 < 0.75
  ], { ...OPTIONS, maxHoldBars: 1 });
  assert.equal(badRR.count, 0);
  assert.equal(badRR.ignoredSignals, 1);

  // Explicit stopPrice/targetPrice with RR >= 0.75 executes cleanly
  Object.assign(rows[1], { open: 100, high: 103.5, low: 99, close: 103 });
  const goodRR = simulateTrades(rows, [
    { barIndex: 0, side: 1, stopPrice: 96, targetPrice: 103 }, // stop=4, tp=3 => RR=0.75
  ], { ...OPTIONS, maxHoldBars: 2 });
  assert.equal(goodRR.count, 1);
  assert.equal(goodRR.trades[0].exitReason, 'TP');
  near(goodRR.trades[0].rewardRisk, 0.75);
});

test('defaults match shared cost benchmark (warmup=250, cooldown=10, costPct=0.10, slippagePct=0.025)', () => {
  assert.equal(DEFAULT_SIM_OPTIONS.warmup, 250);
  assert.equal(DEFAULT_SIM_OPTIONS.cooldown, 10);
  assert.equal(DEFAULT_SIM_OPTIONS.costPct, 0.1);
  assert.equal(DEFAULT_SIM_OPTIONS.slippagePct, 0.025);
  const rows = fixture(293);
  const signals = [0, 249, 250, 251, 259, 260, 269, 270, 289, 290, 292]
    .map(barIndex => ({ barIndex, side: 1, atr: 2 }));
  const result = simulateTrades(rows, signals);
  assert.deepEqual(result.trades.map(t => [t.signalIndex, t.entryIndex, t.exitIndex]),
    [[250, 251, 270], [270, 271, 290]]);
  near(result.trades[0].entry, 100.025);
  near(result.trades[0].exit, 99.975);
  near(result.trades[0].grossPct - result.trades[0].netPct, 0.1);
});

test('split reports purge crossing trades while preserving prefix state & cooldown', () => {
  const rows = fixture(24);
  const signals = [8, 10, 12, 17, 18].map(barIndex => ({ barIndex, side: 1, atr: 2 }));
  const options = { ...OPTIONS, maxHoldBars: 4 };
  const full = simulateTrades(rows, signals, options);
  const left = simulateTrades(rows, signals, { ...options, end: 10 });
  const right = simulateTrades(rows, signals, { ...options, start: 10, end: 24 });
  assert.deepEqual(full.trades.map(t => [t.signalIndex, t.entryIndex, t.exitIndex]),
    [[8, 9, 12], [18, 19, 22]]);
  assert.equal(left.count, 0);
  assert.equal(left.openPosition.signalIndex, 8);
  assert.deepEqual(right.trades, full.trades.filter(t => t.signalIndex >= 10 && t.exitIndex < 24));
  assert.equal(right.count, 1);
  assert.equal(right.purgedTrades, 1);
});

test('prefix truncation and future mutation invariance', () => {
  const rows = fixture(25);
  const signals = [0, 10, 14, 24].map(barIndex => ({ barIndex, side: 1, atr: 2 }));
  const options = { ...OPTIONS, end: 12, maxHoldBars: 3 };
  const expected = simulateTrades(rows, signals, options);
  assert.deepEqual(expected, simulateTrades(rows.slice(0, 12), signals.slice(0, 2), { ...OPTIONS, maxHoldBars: 3 }));
  for (let i = 12; i < rows.length; i++) rows[i] = null;
  signals[2] = { barIndex: 14, side: 0, atr: NaN };
  signals[3] = { barIndex: 24, side: 'future', atr: null };
  assert.deepEqual(simulateTrades(rows, signals, options), expected);
});

test('rejects gaps, duplicate timestamps, invalid OHLCV, and malformed signals', () => {
  const gapRows = fixture(4);
  gapRows[2].time += INTERVAL;
  gapRows[3].time += INTERVAL;
  assert.throws(() => simulateTrades(gapRows, [], OPTIONS));

  const dupRows = fixture(4);
  dupRows[1].time = dupRows[0].time;
  assert.throws(() => simulateTrades(dupRows, [], OPTIONS));

  const badOhlc = fixture(4);
  badOhlc[1].high = 99;
  assert.throws(() => simulateTrades(badOhlc, [], OPTIONS));

  assert.throws(() => simulateTrades(fixture(4), [{ barIndex: 1, side: 1, atr: 2 }, { barIndex: 0, side: 1, atr: 2 }], OPTIONS));
  assert.throws(() => simulateTrades(fixture(4), [{ barIndex: 0, side: 1, atr: 2 }, { barIndex: 0, side: -1, atr: 2 }], OPTIONS));
});

test('win/loss/tie epsilon and wilsonLowerBound calculation', () => {
  const rows = fixture(32);
  const signals = [2, -1, 0.05, 0.1].map((grossPct, i) => {
    const barIndex = i * 10;
    Object.assign(rows[barIndex + 1], { close: 100 + grossPct, high: 103, low: 98 });
    return { barIndex, side: 1, atr: 10 };
  });
  const result = simulateTrades(rows, signals, { ...OPTIONS, maxHoldBars: 1, costPct: 0.1 });
  assert.deepEqual([result.count, result.wins, result.losses, result.ties], [4, 1, 2, 1]);
  near(result.winRatePct, 25);
  near(result.profitFactor, 1.9 / 1.15);
  const lb = wilsonLowerBound(65, 100, 1.96);
  assert.ok(lb > 55 && lb < 65);
  assert.equal(wilsonLowerBound(0, 0), 0);
});

test('minStopPct floor enforces minimum stop distance and scales TP >= rewardRisk', () => {
  const rows = fixture(4);
  // atr=0.1, stopAtr=1 => 0.1%, but minStopPct=0.5 => stop distance becomes 0.5 (0.5%)
  Object.assign(rows[1], { open: 100, high: 100.3, low: 99.7, close: 100.1 });
  Object.assign(rows[2], { open: 100.1, high: 100.6, low: 99.9, close: 100.5 });
  const result = simulateTrades(rows, [{ barIndex: 0, side: 1, atr: 0.1 }], {
    ...OPTIONS, stopAtr: 1, rewardRisk: 1, minStopPct: 0.5,
  });
  assert.equal(result.count, 1);
  const t = result.trades[0];
  near(t.stop, 99.5);
  near(t.target, 100.5);
  assert.equal(t.exitIndex, 2);
  assert.equal(t.exitReason, 'TP');
});

test('gap through raised BE stop fills at worse open with exitReason BE', () => {
  const rows = fixture(4);
  Object.assign(rows[1], { open: 100, high: 101.6, low: 99.5, close: 101.5 });
  // Bar 2 gaps down below raised BE stop (100.2) to 99.0
  Object.assign(rows[2], { open: 99.0, high: 100.5, low: 98.8, close: 99.2 });
  const result = simulateTrades(rows, [{ barIndex: 0, side: 1, atr: 2 }], {
    ...OPTIONS, stopAtr: 1, rewardRisk: 1, beTriggerR: 0.6, beOffsetPct: 0.2, slippagePct: 0.025, costPct: 0.1,
  });
  assert.equal(result.count, 1);
  const t = result.trades[0];
  assert.equal(t.exitReason, 'BE');
  near(t.exit, 99.0 * (1 - 0.00025));
  assert.ok(t.netPct < 0);
});

test('limitSameBarTp modes ("never", "close", "touch") and per-signal overrides', () => {
  const rows = fixture(4);
  // Bar 1 opens at 99, dips to 98 (limit fill), highs to 100.5 (touches target=100), closes at 99.5 (< target)
  Object.assign(rows[1], { open: 99, high: 100.5, low: 98, close: 99.5 });
  Object.assign(rows[2], { open: 99.5, high: 100.2, low: 99.0, close: 100.1 });

  const touch = simulateTrades(rows, [{ barIndex: 0, side: 1, stopDist: 2, limitPrice: 98 }], {
    ...OPTIONS, entryMode: 'LIMIT_PULLBACK', rewardRisk: 1, limitSameBarTp: 'touch',
  });
  assert.equal(touch.trades[0].exitIndex, 1);
  assert.equal(touch.trades[0].exitReason, 'TP');

  const closeOnly = simulateTrades(rows, [{ barIndex: 0, side: 1, stopDist: 2, limitPrice: 98 }], {
    ...OPTIONS, entryMode: 'LIMIT_PULLBACK', rewardRisk: 1, limitSameBarTp: 'close',
  });
  assert.equal(closeOnly.trades[0].exitIndex, 2);
  assert.equal(closeOnly.trades[0].exitReason, 'TP');

  // If bar 1 closes >= target, 'close' exits on bar 1 while 'never' waits until bar 2
  const rowsStrongClose = fixture(4);
  Object.assign(rowsStrongClose[1], { open: 99, high: 100.5, low: 98, close: 100.2 });
  Object.assign(rowsStrongClose[2], { open: 100.2, high: 100.3, low: 99.9, close: 100.1 });
  const neverMode = simulateTrades(rowsStrongClose, [{ barIndex: 0, side: 1, stopDist: 2, limitPrice: 98 }], {
    ...OPTIONS, entryMode: 'LIMIT_PULLBACK', rewardRisk: 1, limitSameBarTp: 'never',
  });
  assert.equal(neverMode.trades[0].exitIndex, 2);
  assert.equal(neverMode.trades[0].exitReason, 'TP');
});

test('alignHtfIndices strictly aligns only closed HTF bars (htfCloseTime <= ltfOpenTime)', () => {
  const htfRows = Array.from({ length: 4 }, (_, j) => ({
    time: START - 3600 + j * 3600,
    open: 100, high: 101, low: 99, close: 100, volume: 10,
  }));
  const ltfRows = Array.from({ length: 8 }, (_, i) => ({
    time: START + i * 900,
    open: 100, high: 101, low: 99, close: 100, volume: 5,
  }));
  validateContiguousRows(htfRows, 3600, 'htf-test');
  validateContiguousRows(ltfRows, 900, 'ltf-test');
  const aligned = alignHtfIndices(ltfRows, htfRows, 3600);
  // First 4 LTF bars (START + 0..2700) map to htf[0] (closed at START); next 4 map to htf[1] (closed at START+3600)
  assert.deepEqual(aligned, [0, 0, 0, 0, 1, 1, 1, 1]);
  for (let i = 0; i < ltfRows.length; i++) {
    assert.ok(htfRows[aligned[i]].time + 3600 <= ltfRows[i].time);
  }
});
