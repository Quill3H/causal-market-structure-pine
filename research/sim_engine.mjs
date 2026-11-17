import assert from 'node:assert/strict';

const EPS = 1e-12;
const MIN_REWARD_RISK = 0.75;

export const DEFAULT_SIM_OPTIONS = Object.freeze({
  start: 0,
  warmup: 250,
  cooldown: 10,
  entryMode: 'MARKET_NEXT_OPEN',
  limitExpiryBars: 4,
  pendingPolicy: 'ignore',
  limitSameBarTp: 'close',
  stopAtr: 1.5,
  minStopPct: 0,
  rewardRisk: 1.0,
  maxHoldBars: 20,
  beTriggerR: 0,
  beOffsetPct: 0.2,
  costPct: 0.1,
  slippagePct: 0.025,
});

export function wilsonLowerBound(wins, total, z = 1.96) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const p = Math.max(0, Math.min(1, wins / total));
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, ((center - margin) / denom) * 100);
}

function resolveLevels(refEntry, pendingOrSignal, defaults) {
  const { side, atr, stopAtr, rewardRisk, stopDist, stopPrice, targetPrice } = pendingOrSignal;
  const effStopAtr = stopAtr ?? defaults.stopAtr;
  const effRewardRisk = rewardRisk ?? defaults.rewardRisk;
  const minStopPct = defaults.minStopPct;

  if (!Number.isFinite(refEntry) || refEntry <= 0) return null;
  if (!Number.isFinite(effRewardRisk) || effRewardRisk < MIN_REWARD_RISK) return null;

  let stop;
  let target;
  let initialStopDist;

  if (stopPrice !== undefined) {
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) return null;
    initialStopDist = side * (refEntry - stopPrice);
    if (!Number.isFinite(initialStopDist) || initialStopDist <= 0) return null;
    stop = stopPrice;
    if (targetPrice !== undefined) {
      if (!Number.isFinite(targetPrice) || targetPrice <= 0) return null;
      const targetDist = side * (targetPrice - refEntry);
      if (!Number.isFinite(targetDist) || targetDist <= 0) return null;
      if (targetDist / initialStopDist + EPS < MIN_REWARD_RISK) return null;
      target = targetPrice;
    } else {
      target = refEntry + side * initialStopDist * effRewardRisk;
    }
  } else {
    let baseDist;
    if (stopDist !== undefined) {
      if (!Number.isFinite(stopDist) || stopDist <= 0) return null;
      baseDist = stopDist;
    } else {
      if (!Number.isFinite(atr) || atr <= 0) return null;
      baseDist = atr * effStopAtr;
    }
    const minDist = minStopPct > 0 ? (refEntry * minStopPct) / 100 : 0;
    initialStopDist = Math.max(baseDist, minDist);
    if (!Number.isFinite(initialStopDist) || initialStopDist <= 0) return null;
    stop = refEntry - side * initialStopDist;
    target = refEntry + side * initialStopDist * effRewardRisk;
  }

  if (![refEntry, stop, target, initialStopDist].every(v => Number.isFinite(v) && v > 0)) {
    return null;
  }
  if (side * (refEntry - stop) <= 0 || side * (target - refEntry) <= 0) {
    return null;
  }
  const actualRR = (side * (target - refEntry)) / (side * (refEntry - stop));
  if (!Number.isFinite(actualRR) || actualRR + EPS < MIN_REWARD_RISK) {
    return null;
  }
  return {
    entry: refEntry,
    stop,
    target,
    initialStopDist,
    rewardRisk: actualRR,
  };
}

function validateSignalEntrySpec(signal, defaults) {
  const entryMode = signal.entryMode ?? defaults.entryMode;
  assert.ok(entryMode === 'MARKET_NEXT_OPEN' || entryMode === 'LIMIT_PULLBACK',
    `Invalid signal entryMode: ${entryMode}`);

  const effStopAtr = signal.stopAtr ?? defaults.stopAtr;
  assert.ok(Number.isFinite(effStopAtr) && effStopAtr > 0, 'Invalid signal stopAtr');

  const effRewardRisk = signal.rewardRisk ?? defaults.rewardRisk;
  assert.ok(Number.isFinite(effRewardRisk) && effRewardRisk >= MIN_REWARD_RISK,
    `Invalid signal rewardRisk: must be >= ${MIN_REWARD_RISK}`);

  const effExpiry = signal.limitExpiryBars ?? defaults.limitExpiryBars;
  assert.ok(Number.isSafeInteger(effExpiry) && effExpiry >= 1, 'Invalid signal limitExpiryBars');

  const effMaxHoldBars = signal.maxHoldBars ?? defaults.maxHoldBars;
  assert.ok(Number.isSafeInteger(effMaxHoldBars) && effMaxHoldBars >= 1, 'Invalid signal maxHoldBars');

  const effBeTriggerR = signal.beTriggerR ?? defaults.beTriggerR;
  assert.ok(Number.isFinite(effBeTriggerR) && effBeTriggerR >= 0, 'Invalid signal beTriggerR');

  const effBeOffsetPct = signal.beOffsetPct ?? defaults.beOffsetPct;
  assert.ok(Number.isFinite(effBeOffsetPct) && effBeOffsetPct >= 0 && effBeOffsetPct < 100,
    'Invalid signal beOffsetPct');

  let limitPrice = null;
  if (entryMode === 'LIMIT_PULLBACK') {
    if (!Number.isFinite(signal.limitPrice) || signal.limitPrice <= 0) {
      return null;
    }
    limitPrice = signal.limitPrice;
  }

  return {
    entryMode,
    limitPrice,
    limitExpiryBars: effExpiry,
    stopAtr: effStopAtr,
    rewardRisk: effRewardRisk,
    maxHoldBars: effMaxHoldBars,
    beTriggerR: effBeTriggerR,
    beOffsetPct: effBeOffsetPct,
  };
}

function validateOptions(rowsLength, options) {
  assert.ok(options && typeof options === 'object' && !Array.isArray(options), 'Invalid options');
  const {
    start = DEFAULT_SIM_OPTIONS.start,
    end = rowsLength,
    warmup = DEFAULT_SIM_OPTIONS.warmup,
    cooldown = DEFAULT_SIM_OPTIONS.cooldown,
    entryMode = DEFAULT_SIM_OPTIONS.entryMode,
    limitExpiryBars = DEFAULT_SIM_OPTIONS.limitExpiryBars,
    pendingPolicy = DEFAULT_SIM_OPTIONS.pendingPolicy,
    limitSameBarTp = DEFAULT_SIM_OPTIONS.limitSameBarTp,
    stopAtr = DEFAULT_SIM_OPTIONS.stopAtr,
    minStopPct = DEFAULT_SIM_OPTIONS.minStopPct,
    rewardRisk = DEFAULT_SIM_OPTIONS.rewardRisk,
    maxHoldBars = DEFAULT_SIM_OPTIONS.maxHoldBars,
    beTriggerR = DEFAULT_SIM_OPTIONS.beTriggerR,
    beOffsetPct = DEFAULT_SIM_OPTIONS.beOffsetPct,
    costPct = DEFAULT_SIM_OPTIONS.costPct,
    slippagePct = DEFAULT_SIM_OPTIONS.slippagePct,
    intervalSeconds,
  } = options;

  for (const [name, value] of Object.entries({ start, end, warmup, cooldown, maxHoldBars, limitExpiryBars })) {
    assert.ok(Number.isSafeInteger(value) && value >= 0, `Invalid ${name}`);
  }
  assert.ok(start <= end && end <= rowsLength, 'Invalid start/end range');
  assert.ok(maxHoldBars >= 1, 'Invalid maxHoldBars');
  assert.ok(limitExpiryBars >= 1, 'Invalid limitExpiryBars');
  assert.ok(entryMode === 'MARKET_NEXT_OPEN' || entryMode === 'LIMIT_PULLBACK',
    `Invalid entryMode: ${entryMode}`);
  assert.ok(pendingPolicy === 'ignore' || pendingPolicy === 'cancel_replace',
    `Invalid pendingPolicy: ${pendingPolicy}`);
  assert.ok(limitSameBarTp === 'close' || limitSameBarTp === 'never' || limitSameBarTp === 'touch',
    `Invalid limitSameBarTp: ${limitSameBarTp}`);
  assert.ok(Number.isFinite(stopAtr) && stopAtr > 0, 'Invalid stopAtr');
  assert.ok(Number.isFinite(minStopPct) && minStopPct >= 0 && minStopPct < 100, 'Invalid minStopPct');
  assert.ok(Number.isFinite(rewardRisk) && rewardRisk >= MIN_REWARD_RISK,
    `Invalid rewardRisk: must be >= ${MIN_REWARD_RISK}`);
  assert.ok(Number.isFinite(beTriggerR) && beTriggerR >= 0, 'Invalid beTriggerR');
  assert.ok(Number.isFinite(beOffsetPct) && beOffsetPct >= 0 && beOffsetPct < 100, 'Invalid beOffsetPct');
  assert.ok(Number.isFinite(costPct) && costPct >= 0, 'Invalid costPct');
  assert.ok(Number.isFinite(slippagePct) && slippagePct >= 0 && slippagePct < 100, 'Invalid slippagePct');
  assert.ok(intervalSeconds === undefined ||
    (Number.isSafeInteger(intervalSeconds) && intervalSeconds > 0), 'Invalid intervalSeconds');

  return {
    start, end, warmup, cooldown, entryMode, limitExpiryBars, pendingPolicy, limitSameBarTp,
    stopAtr, minStopPct, rewardRisk, maxHoldBars, beTriggerR, beOffsetPct, costPct, slippagePct,
    intervalSeconds,
  };
}

function validateRowsPrefix(rows, end, intervalSeconds) {
  let interval = intervalSeconds;
  for (let i = 0; i < end; i++) {
    const row = rows[i];
    assert.ok(row && typeof row === 'object', `Invalid row ${i}`);
    assert.ok(Number.isSafeInteger(row.time) && row.time > 0, `Invalid timestamp at row ${i}`);
    if (i > 0) {
      const elapsed = row.time - rows[i - 1].time;
      if (interval === undefined) interval = elapsed;
      assert.ok(interval > 0 && elapsed === interval, `Duplicate, unordered or gap timestamp at row ${i}`);
    }
    for (const key of ['open', 'high', 'low', 'close']) {
      assert.ok(Number.isFinite(row[key]) && row[key] > 0, `Invalid OHLC ${key} at row ${i}`);
    }
    assert.ok(row.low <= Math.min(row.open, row.close) && row.high >= Math.max(row.open, row.close),
      `Inconsistent OHLC at row ${i}`);
    assert.ok(Number.isFinite(row.volume) && row.volume >= 0, `Invalid volume at row ${i}`);
  }
}

export function simulateTrades(rows, signals, options = {}) {
  assert.ok(Array.isArray(rows), 'Expected rows array');
  assert.ok(Array.isArray(signals), 'Expected signals array');

  const cfg = validateOptions(rows.length, options);
  validateRowsPrefix(rows, cfg.end, cfg.intervalSeconds);

  const byIndex = new Map();
  let previous = -1;
  for (const signal of signals) {
    assert.ok(signal && typeof signal === 'object', 'Invalid signal');
    assert.ok(Number.isSafeInteger(signal.barIndex) && signal.barIndex >= 0, 'Invalid signal barIndex');
    if (signal.barIndex >= cfg.end) continue;
    assert.ok(signal.barIndex > previous, 'Signal indices must be ordered and unique; conflicting signals');
    assert.ok(signal.side === 1 || signal.side === -1, 'Invalid signal side');
    previous = signal.barIndex;
    byIndex.set(signal.barIndex, signal);
  }

  const trades = [];
  const exitReasons = { SL: 0, TP: 0, TIME: 0, BE: 0 };
  const slip = cfg.slippagePct / 100;
  let pending = null;
  let openPosition = null;
  let lastAcceptedSignal = -Infinity;
  let ignoredSignals = 0;
  let purgedTrades = 0;
  let expiredOrders = 0;
  let cancelledPendingOrders = 0;

  for (let i = 0; i < cfg.end; i++) {
    const row = rows[i];

    // 1. Fill or expire pending entry order before checking intra-bar exits.
    if (!openPosition && pending) {
      if (pending.entryMode === 'MARKET_NEXT_OPEN') {
        if (i === pending.signalIndex + 1) {
          const entry = row.open * (1 + pending.side * slip);
          const actual = resolveLevels(entry, pending, cfg);
          if (actual) {
            openPosition = {
              signalIndex: pending.signalIndex,
              entryIndex: i,
              side: pending.side,
              entryMode: pending.entryMode,
              atr: pending.atr,
              limitPrice: null,
              filledAtOpen: true,
              entry: actual.entry,
              stop: actual.stop,
              initialStop: actual.stop,
              target: actual.target,
              initialStopDist: actual.initialStopDist,
              rewardRisk: actual.rewardRisk,
              maxHoldBars: pending.maxHoldBars,
              beTriggerR: pending.beTriggerR,
              beOffsetPct: pending.beOffsetPct,
              beArmed: false,
              beArmedIndex: null,
              meta: pending.meta,
            };
          } else {
            ignoredSignals++;
          }
        } else {
          expiredOrders++;
        }
        pending = null;
      } else if (pending.entryMode === 'LIMIT_PULLBACK') {
        const bull = pending.side === 1;
        const touched = bull ? row.low <= pending.limitPrice : row.high >= pending.limitPrice;
        if (touched) {
          const filledAtOpen = bull ? row.open <= pending.limitPrice : row.open >= pending.limitPrice;
          const rawFill = bull
            ? Math.min(row.open, pending.limitPrice)
            : Math.max(row.open, pending.limitPrice);
          const entry = rawFill * (1 + pending.side * slip);
          const actual = resolveLevels(entry, pending, cfg);
          if (actual) {
            openPosition = {
              signalIndex: pending.signalIndex,
              entryIndex: i,
              side: pending.side,
              entryMode: pending.entryMode,
              atr: pending.atr,
              limitPrice: pending.limitPrice,
              filledAtOpen,
              entry: actual.entry,
              stop: actual.stop,
              initialStop: actual.stop,
              target: actual.target,
              initialStopDist: actual.initialStopDist,
              rewardRisk: actual.rewardRisk,
              maxHoldBars: pending.maxHoldBars,
              beTriggerR: pending.beTriggerR,
              beOffsetPct: pending.beOffsetPct,
              beArmed: false,
              beArmedIndex: null,
              meta: pending.meta,
            };
          } else {
            ignoredSignals++;
          }
          pending = null;
        } else if (i >= pending.expiryIndex) {
          pending = null;
          expiredOrders++;
        }
      }
    }

    // 2. Conservative intra-bar exit evaluation (including limit-fill / entry bar).
    if (openPosition) {
      const { side, entry, stop, target, entryIndex, beArmed, filledAtOpen, entryMode } = openPosition;
      const bull = side === 1;
      const isEntryBar = i === entryIndex;
      const barsHeld = i - entryIndex + 1;
      const canUseGapAndHighLowTp = entryMode === 'MARKET_NEXT_OPEN' || !isEntryBar || filledAtOpen || cfg.limitSameBarTp === 'touch';

      const gapStop = bull ? row.open <= stop : row.open >= stop;
      const gapTarget = canUseGapAndHighLowTp && (bull ? row.open >= target : row.open <= target);
      const hitStop = bull ? row.low <= stop : row.high >= stop;

      let hitTarget = false;
      if (canUseGapAndHighLowTp) {
        hitTarget = bull ? row.high >= target : row.low <= target;
      } else if (cfg.limitSameBarTp === 'close') {
        hitTarget = bull ? row.close >= target : row.close <= target;
      }

      const stopLabel = beArmed ? 'BE' : 'SL';
      let fill;
      let exitReason;

      if (gapStop) {
        fill = row.open;
        exitReason = stopLabel;
      } else if (gapTarget) {
        fill = target;
        exitReason = 'TP';
      } else if (hitStop) {
        // Conservative rule: if both stop and target touch inside [low, high], SL/BE always wins.
        fill = stop;
        exitReason = stopLabel;
      } else if (hitTarget) {
        fill = target;
        exitReason = 'TP';
      } else if (barsHeld >= openPosition.maxHoldBars) {
        fill = row.close;
        exitReason = 'TIME';
      }

      if (exitReason) {
        const exit = fill * (1 - side * slip);
        const grossPct = (side * (exit - entry)) / entry * 100;
        const netPct = grossPct - cfg.costPct;
        assert.ok(Number.isFinite(exit) && exit > 0 && Number.isFinite(grossPct) && Number.isFinite(netPct),
          `Non-finite or invalid trade return at row ${i}`);

        const trade = {
          signalIndex: openPosition.signalIndex,
          entryIndex: openPosition.entryIndex,
          exitIndex: i,
          side,
          entryMode: openPosition.entryMode,
          atr: openPosition.atr,
          limitPrice: openPosition.limitPrice,
          entry,
          stop,
          initialStop: openPosition.initialStop,
          target,
          initialStopDist: openPosition.initialStopDist,
          rewardRisk: openPosition.rewardRisk,
          beArmed,
          beArmedIndex: openPosition.beArmedIndex,
          exit,
          exitReason,
          barsHeld,
          grossPct,
          netPct,
        };
        if (openPosition.meta !== undefined) trade.meta = openPosition.meta;

        if (trade.signalIndex >= cfg.start) {
          trades.push(trade);
          exitReasons[exitReason]++;
        } else if (i >= cfg.start) {
          purgedTrades++;
        }
        openPosition = null;
      }
    }

    // 3. Confirmed-close Breakeven-Plus-Cost Ratchet (active starting bar i + 1).
    if (openPosition && openPosition.beTriggerR > 0 && !openPosition.beArmed) {
      const { side, entry, initialStopDist, stop, target, beTriggerR, beOffsetPct } = openPosition;
      if (side * (row.close - entry) >= beTriggerR * initialStopDist) {
        const raisedStop = entry * (1 + (side * beOffsetPct) / 100);
        if (side * (raisedStop - stop) > 0 && side * (target - raisedStop) > 0) {
          openPosition.stop = raisedStop;
          openPosition.beArmed = true;
          openPosition.beArmedIndex = i;
        }
      }
    }

    // 4. Signal queue / cooldown gate on closed bar i.
    const signal = byIndex.get(i);
    if (signal) {
      if (openPosition || (pending && cfg.pendingPolicy === 'ignore') ||
          i < cfg.warmup || i - lastAcceptedSignal < cfg.cooldown) {
        ignoredSignals++;
      } else {
        const entrySpec = validateSignalEntrySpec(signal, cfg);
        const refEntry = entrySpec?.entryMode === 'LIMIT_PULLBACK' ? entrySpec.limitPrice : row.close;
        const specPayload = entrySpec ? {
          side: signal.side,
          atr: signal.atr,
          stopAtr: entrySpec.stopAtr,
          rewardRisk: entrySpec.rewardRisk,
          stopDist: signal.stopDist,
          stopPrice: signal.stopPrice,
          targetPrice: signal.targetPrice,
        } : null;

        if (!entrySpec || !resolveLevels(refEntry, specPayload, cfg)) {
          ignoredSignals++;
        } else {
          if (pending && cfg.pendingPolicy === 'cancel_replace') {
            cancelledPendingOrders++;
          }
          pending = {
            signalIndex: i,
            side: signal.side,
            atr: signal.atr,
            entryMode: entrySpec.entryMode,
            limitPrice: entrySpec.limitPrice,
            expiryIndex: i + entrySpec.limitExpiryBars,
            stopAtr: entrySpec.stopAtr,
            rewardRisk: entrySpec.rewardRisk,
            maxHoldBars: entrySpec.maxHoldBars,
            beTriggerR: entrySpec.beTriggerR,
            beOffsetPct: entrySpec.beOffsetPct,
            stopDist: signal.stopDist,
            stopPrice: signal.stopPrice,
            targetPrice: signal.targetPrice,
            meta: signal.meta,
          };
          lastAcceptedSignal = i;
        }
      }
    }
  }

  const count = trades.length;
  let wins = 0;
  let losses = 0;
  let gains = 0;
  let lossSum = 0;
  let grossSum = 0;
  let netSum = 0;
  let cumNet = 0;
  let peakNet = 0;
  let maxDrawdownPct = 0;

  for (const trade of trades) {
    if (trade.netPct > EPS) {
      wins++;
      gains += trade.netPct;
    } else if (trade.netPct < -EPS) {
      losses++;
      lossSum -= trade.netPct;
    }
    grossSum += trade.grossPct;
    netSum += trade.netPct;
    cumNet += trade.netPct;
    if (cumNet > peakNet) peakNet = cumNet;
    const dd = peakNet - cumNet;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  return {
    trades,
    openPosition,
    pending,
    count,
    wins,
    losses,
    ties: count - wins - losses,
    winRatePct: count ? (wins / count) * 100 : null,
    wilsonLower95Pct: count ? wilsonLowerBound(wins, count, 1.96) : null,
    meanNetPct: count ? netSum / count : null,
    meanGrossPct: count ? grossSum / count : null,
    totalNetPct: netSum,
    maxDrawdownPct,
    profitFactor: lossSum > 0 ? gains / lossSum : null,
    exitReasons,
    ignoredSignals,
    purgedTrades,
    expiredOrders,
    cancelledPendingOrders,
  };
}
