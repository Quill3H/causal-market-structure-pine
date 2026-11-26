import assert from 'node:assert/strict';
import { DEFAULT_SIM_OPTIONS_V6, wilsonLowerBound } from './sim_engine_v6.mjs';

const EPS = 1e-12;
const MIN_REWARD_RISK = 0.75;
const SECONDS_PER_YEAR = 365.25 * 86400;

export { wilsonLowerBound };

export const DEFAULT_SIM_OPTIONS_V7 = Object.freeze({
  ...DEFAULT_SIM_OPTIONS_V6,
  tp1FeeMode: null, // defaults to 'MAKER' under EXCHANGE_POST_ONLY, 'TAKER' under STRICT_TAKER/EQUITY_ETF
  mmr: 0.005,
  isolatedLiqCheck: true,
});

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

  const effLock2TriggerR = signal.lock2TriggerR ?? defaults.lock2TriggerR;
  assert.ok(Number.isFinite(effLock2TriggerR) && effLock2TriggerR >= 0, 'Invalid signal lock2TriggerR');

  const effLock2OffsetR = signal.lock2OffsetR ?? defaults.lock2OffsetR;
  assert.ok(Number.isFinite(effLock2OffsetR) && effLock2OffsetR >= 0, 'Invalid signal lock2OffsetR');
  if (effLock2TriggerR > 0) {
    assert.ok(effLock2OffsetR < effLock2TriggerR, 'Invalid signal lock2OffsetR: must be < lock2TriggerR');
  }

  const effTrailTriggerR = signal.trailTriggerR ?? defaults.trailTriggerR;
  assert.ok(Number.isFinite(effTrailTriggerR) && effTrailTriggerR >= 0, 'Invalid signal trailTriggerR');

  const effTrailAtrMult = signal.trailAtrMult ?? defaults.trailAtrMult;
  assert.ok(Number.isFinite(effTrailAtrMult) && effTrailAtrMult >= 0, 'Invalid signal trailAtrMult');
  if (effTrailTriggerR > 0) {
    assert.ok(effTrailAtrMult > 0, 'Invalid signal trailAtrMult: must be > 0 when trailTriggerR > 0');
  }

  const effTp1TriggerR = signal.tp1TriggerR ?? defaults.tp1TriggerR;
  assert.ok(Number.isFinite(effTp1TriggerR) && effTp1TriggerR >= 0, 'Invalid signal tp1TriggerR');

  const effTp1QtyPct = signal.tp1QtyPct ?? defaults.tp1QtyPct;
  assert.ok(Number.isFinite(effTp1QtyPct) && effTp1QtyPct >= 0 && effTp1QtyPct <= 95, 'Invalid signal tp1QtyPct');

  const effTp1LockOffsetR = signal.tp1LockOffsetR ?? defaults.tp1LockOffsetR;
  assert.ok(Number.isFinite(effTp1LockOffsetR) && effTp1LockOffsetR >= 0, 'Invalid signal tp1LockOffsetR');

  const effTp1FeeMode = signal.tp1FeeMode ?? defaults.tp1FeeMode;
  assert.ok(effTp1FeeMode === 'MAKER' || effTp1FeeMode === 'TAKER', `Invalid signal tp1FeeMode: ${effTp1FeeMode}`);

  const hasExplicitSizeMult = signal.sizeMult !== undefined;
  const effSizeMult = hasExplicitSizeMult ? signal.sizeMult : 1.0;
  assert.ok(Number.isFinite(effSizeMult) && effSizeMult > 0, 'Invalid signal sizeMult: must be > 0');

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
    lock2TriggerR: effLock2TriggerR,
    lock2OffsetR: effLock2OffsetR,
    trailTriggerR: effTrailTriggerR,
    trailAtrMult: effTrailAtrMult,
    tp1TriggerR: effTp1TriggerR,
    tp1QtyPct: effTp1QtyPct,
    tp1LockOffsetR: effTp1LockOffsetR,
    tp1FeeMode: effTp1FeeMode,
    sizeMult: effSizeMult,
    hasExplicitSizeMult,
  };
}

function validateOptionsV7(rowsLength, options) {
  assert.ok(options && typeof options === 'object' && !Array.isArray(options), 'Invalid options');
  const execProfile = options.execProfile ?? DEFAULT_SIM_OPTIONS_V7.execProfile;
  assert.ok(
    execProfile === 'STRICT_TAKER' || execProfile === 'EXCHANGE_POST_ONLY' || execProfile === 'EQUITY_ETF',
    `Invalid execProfile: ${execProfile}`,
  );
  const isEquity = execProfile === 'EQUITY_ETF';
  const defaultTp1FeeMode = execProfile === 'EXCHANGE_POST_ONLY' ? 'MAKER' : 'TAKER';

  const {
    start = DEFAULT_SIM_OPTIONS_V7.start,
    end = rowsLength,
    warmup = DEFAULT_SIM_OPTIONS_V7.warmup,
    cooldown = DEFAULT_SIM_OPTIONS_V7.cooldown,
    entryMode = DEFAULT_SIM_OPTIONS_V7.entryMode,
    limitExpiryBars = DEFAULT_SIM_OPTIONS_V7.limitExpiryBars,
    pendingPolicy = DEFAULT_SIM_OPTIONS_V7.pendingPolicy,
    limitSameBarTp = DEFAULT_SIM_OPTIONS_V7.limitSameBarTp,
    stopAtr = DEFAULT_SIM_OPTIONS_V7.stopAtr,
    minStopPct = DEFAULT_SIM_OPTIONS_V7.minStopPct,
    rewardRisk = DEFAULT_SIM_OPTIONS_V7.rewardRisk,
    maxHoldBars = DEFAULT_SIM_OPTIONS_V7.maxHoldBars,
    beTriggerR = DEFAULT_SIM_OPTIONS_V7.beTriggerR,
    beOffsetPct = DEFAULT_SIM_OPTIONS_V7.beOffsetPct,
    lock2TriggerR = DEFAULT_SIM_OPTIONS_V7.lock2TriggerR,
    lock2OffsetR = DEFAULT_SIM_OPTIONS_V7.lock2OffsetR,
    trailTriggerR = DEFAULT_SIM_OPTIONS_V7.trailTriggerR,
    trailAtrMult = DEFAULT_SIM_OPTIONS_V7.trailAtrMult,
    costPct = isEquity ? DEFAULT_SIM_OPTIONS_V7.equityCostPct : DEFAULT_SIM_OPTIONS_V7.costPct,
    slippagePct = isEquity ? DEFAULT_SIM_OPTIONS_V7.equitySlippagePct : DEFAULT_SIM_OPTIONS_V7.slippagePct,
    fixedLev = DEFAULT_SIM_OPTIONS_V7.fixedLev,
    volNormRiskPct = DEFAULT_SIM_OPTIONS_V7.volNormRiskPct,
    minLev = DEFAULT_SIM_OPTIONS_V7.minLev,
    maxLev = DEFAULT_SIM_OPTIONS_V7.maxLev,
    tp1TriggerR = DEFAULT_SIM_OPTIONS_V7.tp1TriggerR,
    tp1QtyPct = DEFAULT_SIM_OPTIONS_V7.tp1QtyPct,
    tp1LockOffsetR = DEFAULT_SIM_OPTIONS_V7.tp1LockOffsetR,
    tp1FeeMode = defaultTp1FeeMode,
    fundingPctPer8h = isEquity ? 0 : DEFAULT_SIM_OPTIONS_V7.fundingPctPer8h,
    makerFeePct = DEFAULT_SIM_OPTIONS_V7.makerFeePct,
    takerFeePct = DEFAULT_SIM_OPTIONS_V7.takerFeePct,
    makerBufferPct = DEFAULT_SIM_OPTIONS_V7.makerBufferPct,
    fundingRows = isEquity ? null : DEFAULT_SIM_OPTIONS_V7.fundingRows,
    allowTimeGaps = isEquity ? true : DEFAULT_SIM_OPTIONS_V7.allowTimeGaps,
    mmr = DEFAULT_SIM_OPTIONS_V7.mmr,
    isolatedLiqCheck = DEFAULT_SIM_OPTIONS_V7.isolatedLiqCheck,
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
  assert.ok(tp1FeeMode === 'MAKER' || tp1FeeMode === 'TAKER', `Invalid tp1FeeMode: ${tp1FeeMode}`);
  assert.equal(typeof allowTimeGaps, 'boolean', 'Invalid allowTimeGaps');
  assert.equal(typeof isolatedLiqCheck, 'boolean', 'Invalid isolatedLiqCheck');
  assert.ok(Number.isFinite(mmr) && mmr >= 0 && mmr < 0.5, 'Invalid mmr');
  assert.ok(Number.isFinite(stopAtr) && stopAtr > 0, 'Invalid stopAtr');
  assert.ok(Number.isFinite(minStopPct) && minStopPct >= 0 && minStopPct < 100, 'Invalid minStopPct');
  assert.ok(Number.isFinite(rewardRisk) && rewardRisk >= MIN_REWARD_RISK,
    `Invalid rewardRisk: must be >= ${MIN_REWARD_RISK}`);
  assert.ok(Number.isFinite(beTriggerR) && beTriggerR >= 0, 'Invalid beTriggerR');
  assert.ok(Number.isFinite(beOffsetPct) && beOffsetPct >= 0 && beOffsetPct < 100, 'Invalid beOffsetPct');
  assert.ok(Number.isFinite(lock2TriggerR) && lock2TriggerR >= 0, 'Invalid lock2TriggerR');
  assert.ok(Number.isFinite(lock2OffsetR) && lock2OffsetR >= 0, 'Invalid lock2OffsetR');
  if (lock2TriggerR > 0) {
    assert.ok(lock2OffsetR < lock2TriggerR, 'Invalid lock2OffsetR: must be < lock2TriggerR');
  }
  assert.ok(Number.isFinite(trailTriggerR) && trailTriggerR >= 0, 'Invalid trailTriggerR');
  assert.ok(Number.isFinite(trailAtrMult) && trailAtrMult >= 0, 'Invalid trailAtrMult');
  if (trailTriggerR > 0) {
    assert.ok(trailAtrMult > 0, 'Invalid trailAtrMult: must be > 0 when trailTriggerR > 0');
  }
  assert.ok(Number.isFinite(costPct) && costPct >= 0, 'Invalid costPct');
  assert.ok(Number.isFinite(slippagePct) && slippagePct >= 0 && slippagePct < 100, 'Invalid slippagePct');
  assert.ok(Number.isFinite(makerFeePct) && makerFeePct >= 0, 'Invalid makerFeePct');
  assert.ok(Number.isFinite(takerFeePct) && takerFeePct >= 0, 'Invalid takerFeePct');
  assert.ok(Number.isFinite(makerBufferPct) && makerBufferPct >= 0 && makerBufferPct < 100, 'Invalid makerBufferPct');
  assert.ok(Number.isFinite(fixedLev) && fixedLev > 0, 'Invalid fixedLev');
  assert.ok(Number.isFinite(volNormRiskPct) && volNormRiskPct >= 0, 'Invalid volNormRiskPct');
  assert.ok(Number.isFinite(minLev) && minLev > 0 && Number.isFinite(maxLev) && maxLev >= minLev, 'Invalid minLev/maxLev');
  assert.ok(Number.isFinite(tp1TriggerR) && tp1TriggerR >= 0, 'Invalid tp1TriggerR');
  assert.ok(Number.isFinite(tp1QtyPct) && tp1QtyPct >= 0 && tp1QtyPct <= 95, 'Invalid tp1QtyPct');
  assert.ok(Number.isFinite(tp1LockOffsetR) && tp1LockOffsetR >= 0, 'Invalid tp1LockOffsetR');
  assert.ok(Number.isFinite(fundingPctPer8h) && fundingPctPer8h >= 0, 'Invalid fundingPctPer8h');
  assert.ok(intervalSeconds === undefined ||
    (Number.isSafeInteger(intervalSeconds) && intervalSeconds > 0), 'Invalid intervalSeconds');

  let fundingMap = null;
  if (!isEquity && fundingRows !== null && fundingRows !== undefined) {
    assert.ok(Array.isArray(fundingRows), 'Invalid fundingRows: expected array');
    fundingMap = new Map();
    for (let idx = 0; idx < fundingRows.length; idx++) {
      const fr = fundingRows[idx];
      assert.ok(fr && typeof fr === 'object', `Invalid fundingRow at ${idx}`);
      assert.ok(Number.isSafeInteger(fr.time) && fr.time > 0, `Invalid fundingRow.time at ${idx}`);
      assert.ok(Number.isFinite(fr.fundingRate), `Invalid fundingRow.fundingRate at ${idx}`);
      fundingMap.set(fr.time, fr.fundingRate);
    }
  }

  return {
    start, end, warmup, cooldown, entryMode, limitExpiryBars, pendingPolicy, limitSameBarTp,
    stopAtr, minStopPct, rewardRisk, maxHoldBars, beTriggerR, beOffsetPct,
    lock2TriggerR, lock2OffsetR, trailTriggerR, trailAtrMult, costPct, slippagePct,
    fixedLev, volNormRiskPct, minLev, maxLev, tp1TriggerR, tp1QtyPct, tp1LockOffsetR, tp1FeeMode, fundingPctPer8h,
    execProfile, makerFeePct, takerFeePct, makerBufferPct, fundingMap, allowTimeGaps,
    mmr, isolatedLiqCheck,
    intervalSeconds,
  };
}

function validateRowsPrefixV7(rows, end, intervalSeconds, allowTimeGaps) {
  let interval = intervalSeconds;
  for (let i = 0; i < end; i++) {
    const row = rows[i];
    assert.ok(row && typeof row === 'object', `Invalid row ${i}`);
    assert.ok(Number.isSafeInteger(row.time) && row.time > 0, `Invalid timestamp at row ${i}`);
    if (i > 0) {
      const elapsed = row.time - rows[i - 1].time;
      if (allowTimeGaps) {
        assert.ok(elapsed > 0, `Duplicate or non-monotonic timestamp at row ${i}`);
      } else {
        if (interval === undefined) interval = elapsed;
        assert.ok(interval > 0 && elapsed === interval, `Duplicate, unordered or gap timestamp at row ${i}`);
      }
    }
    for (const key of ['open', 'high', 'low', 'close']) {
      assert.ok(Number.isFinite(row[key]) && row[key] > 0, `Invalid OHLC ${key} at row ${i}`);
    }
    assert.ok(row.low <= Math.min(row.open, row.close) && row.high >= Math.max(row.open, row.close),
      `Inconsistent OHLC at row ${i}`);
    assert.ok(Number.isFinite(row.volume) && row.volume >= 0, `Invalid volume at row ${i}`);
  }
}

function createOpenPosition(pending, entryIndex, limitPrice, filledAtOpen, entryFeePct, actual, cfg) {
  const stopDistPct = (actual.initialStopDist / actual.entry) * 100;
  let lev;
  if (cfg.volNormRiskPct > 0) {
    lev = Math.max(cfg.minLev, Math.min(cfg.maxLev, (cfg.volNormRiskPct * pending.sizeMult) / stopDistPct));
  } else if (pending.hasExplicitSizeMult) {
    lev = Math.max(cfg.minLev, Math.min(cfg.maxLev, cfg.fixedLev * pending.sizeMult));
  } else {
    lev = cfg.fixedLev;
  }

  const tp1QtyFrac = pending.tp1TriggerR > 0 && pending.tp1QtyPct > 0 ? pending.tp1QtyPct / 100 : 0;
  const tp1Price = tp1QtyFrac > 0
    ? actual.entry + pending.side * pending.tp1TriggerR * actual.initialStopDist
    : null;

  return {
    signalIndex: pending.signalIndex,
    entryIndex,
    side: pending.side,
    entryMode: pending.entryMode,
    entryFeePct,
    sizeMult: pending.sizeMult,
    atr: pending.atr,
    limitPrice,
    filledAtOpen,
    entry: actual.entry,
    stop: actual.stop,
    initialStop: actual.stop,
    target: actual.target,
    initialStopDist: actual.initialStopDist,
    stopDistPct,
    lev,
    rewardRisk: actual.rewardRisk,
    maxHoldBars: pending.maxHoldBars,
    beTriggerR: pending.beTriggerR,
    beOffsetPct: pending.beOffsetPct,
    lock2TriggerR: pending.lock2TriggerR,
    lock2OffsetR: pending.lock2OffsetR,
    trailTriggerR: pending.trailTriggerR,
    trailAtrMult: pending.trailAtrMult,
    tp1TriggerR: pending.tp1TriggerR,
    tp1QtyFrac,
    tp1LockOffsetR: pending.tp1LockOffsetR,
    tp1FeeMode: pending.tp1FeeMode,
    tp1Price,
    tp1Hit: false,
    tp1BarIndex: null,
    remFrac: 1.0,
    realizedLeg1GrossPct: 0,
    realizedLeg1NetPct: 0,
    fundingIntervalsCrossed: 0,
    fundingCashflow1xPct: 0,
    beArmed: false,
    beArmedIndex: null,
    lock2Armed: false,
    lock2ArmedIndex: null,
    trailArmed: false,
    trailArmedIndex: null,
    meta: pending.meta,
  };
}

function computeSummaryStats(trades, periodYears = 0) {
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
  let equity = 1.0;
  let peakEq = 1.0;
  let compoundedMaxDrawdownPct = 0;
  let liquidationCount = 0;

  for (const trade of trades) {
    const net = trade.portfolioNetPct ?? trade.netPct;
    const gross = trade.portfolioGrossPct ?? trade.grossPct;
    if (trade.exitReason === 'LIQUIDATION') liquidationCount++;
    if (net > EPS) {
      wins++;
      gains += net;
    } else if (net < -EPS) {
      losses++;
      lossSum -= net;
    }
    grossSum += gross;
    netSum += net;
    cumNet += net;
    if (cumNet > peakNet) peakNet = cumNet;
    const dd = peakNet - cumNet;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;

    const factor = 1 + net / 100;
    equity = factor <= 0 ? 0 : equity * factor;
    if (equity > peakEq) peakEq = equity;
    const cdd = peakEq > 0 ? ((peakEq - equity) / peakEq) * 100 : 100;
    if (cdd > compoundedMaxDrawdownPct) compoundedMaxDrawdownPct = cdd;
  }

  const compoundedNetPct = (equity - 1) * 100;
  const cagrPct = periodYears > 0
    ? (equity > 0 ? (Math.pow(equity, 1 / periodYears) - 1) * 100 : -100)
    : null;

  return {
    count,
    wins,
    losses,
    ties: count - wins - losses,
    winRatePct: count ? (wins / count) * 100 : null,
    wilsonLower95Pct: count ? wilsonLowerBound(wins, count, 1.96) : null,
    profitFactor: lossSum > 0 ? gains / lossSum : null,
    meanNetPct: count ? netSum / count : null,
    meanGrossPct: count ? grossSum / count : null,
    totalNetPct: netSum,
    compoundedNetPct,
    finalEquity: equity,
    cagrPct,
    maxDrawdownPct,
    compoundedMaxDrawdownPct,
    liquidationCount,
    retToDd: compoundedMaxDrawdownPct > EPS ? compoundedNetPct / compoundedMaxDrawdownPct : null,
  };
}

export function simulateTradesV7(rows, signals, options = {}) {
  assert.ok(Array.isArray(rows), 'Expected rows array');
  assert.ok(Array.isArray(signals), 'Expected signals array');

  const cfg = validateOptionsV7(rows.length, options);
  validateRowsPrefixV7(rows, cfg.end, cfg.intervalSeconds, cfg.allowTimeGaps);

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

  const isPostOnly = cfg.execProfile === 'EXCHANGE_POST_ONLY';
  const isEquity = cfg.execProfile === 'EQUITY_ETF';
  const trades = [];
  const exitReasons = { SL: 0, TP: 0, TIME: 0, BE: 0, LIQUIDATION: 0 };
  const slip = cfg.slippagePct / 100;
  const makerBuf = cfg.makerBufferPct / 100;
  let pending = null;
  let openPosition = null;
  let lastAcceptedSignal = -Infinity;
  let ignoredSignals = 0;
  let purgedTrades = 0;
  let expiredOrders = 0;
  let cancelledPendingOrders = 0;
  let liquidated = false;

  for (let i = 0; i < cfg.end; i++) {
    const row = rows[i];

    // 1. Fill or expire pending entry order (stop accepting new orders if account liquidated to 0).
    if (!liquidated && !openPosition && pending) {
      if (pending.entryMode === 'MARKET_NEXT_OPEN') {
        if (i === pending.signalIndex + 1) {
          const entry = row.open * (1 + pending.side * slip);
          const actual = resolveLevels(entry, pending, cfg);
          if (actual) {
            const entryFeePct = isPostOnly ? cfg.takerFeePct : cfg.costPct / 2;
            openPosition = createOpenPosition(pending, i, null, true, entryFeePct, actual, cfg);
          } else {
            ignoredSignals++;
          }
        } else {
          expiredOrders++;
        }
        pending = null;
      } else if (pending.entryMode === 'LIMIT_PULLBACK') {
        const bull = pending.side === 1;
        let touched;
        let filledAtOpen;
        let entry;
        let entryFeePct;

        if (isPostOnly) {
          const triggerPrice = bull
            ? pending.limitPrice * (1 - makerBuf)
            : pending.limitPrice * (1 + makerBuf);
          touched = bull ? row.low <= triggerPrice : row.high >= triggerPrice;
          filledAtOpen = bull ? row.open <= pending.limitPrice : row.open >= pending.limitPrice;
          entry = pending.limitPrice;
          entryFeePct = cfg.makerFeePct;
        } else if (isEquity) {
          touched = bull ? row.low <= pending.limitPrice : row.high >= pending.limitPrice;
          filledAtOpen = bull ? row.open <= pending.limitPrice : row.open >= pending.limitPrice;
          entry = pending.limitPrice * (1 + pending.side * slip);
          entryFeePct = cfg.costPct / 2;
        } else {
          touched = bull ? row.low <= pending.limitPrice : row.high >= pending.limitPrice;
          filledAtOpen = bull ? row.open <= pending.limitPrice : row.open >= pending.limitPrice;
          const rawFill = bull
            ? Math.min(row.open, pending.limitPrice)
            : Math.max(row.open, pending.limitPrice);
          entry = rawFill * (1 + pending.side * slip);
          entryFeePct = cfg.costPct / 2;
        }

        if (touched) {
          const actual = resolveLevels(entry, pending, cfg);
          if (actual) {
            openPosition = createOpenPosition(pending, i, pending.limitPrice, filledAtOpen, entryFeePct, actual, cfg);
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

    // 2. Hard Intra-Bar Liquidation check BEFORE TP/BE/SL, followed by conservative intra-bar exits.
    if (openPosition) {
      const { side, entry, stop, target, entryIndex, beArmed, filledAtOpen, entryMode, entryFeePct } = openPosition;
      const bull = side === 1;
      const isEntryBar = i === entryIndex;
      const barsHeld = i - entryIndex + 1;
      const canUseGapAndHighLowTp = entryMode === 'MARKET_NEXT_OPEN' || !isEntryBar || filledAtOpen || cfg.limitSameBarTp === 'touch';

      if (!isEquity) {
        if (cfg.fundingMap && cfg.fundingMap.has(row.time)) {
          const ratePct = cfg.fundingMap.get(row.time) * 100;
          openPosition.fundingCashflow1xPct += -side * ratePct * openPosition.remFrac;
        } else if (cfg.fundingPctPer8h > 0 && row.time % 28800 === 0) {
          openPosition.fundingIntervalsCrossed += openPosition.remFrac;
          openPosition.fundingCashflow1xPct -= cfg.fundingPctPer8h * openPosition.remFrac;
        }
      }

      let fill;
      let exitReason;

      if (cfg.isolatedLiqCheck) {
        const worstPrice = bull ? row.low : row.high;
        const worstAdverseMove = (side * (worstPrice - entry)) / entry;
        const liqThreshold = -((1 / openPosition.lev) - cfg.mmr);
        if (worstAdverseMove <= liqThreshold + EPS) {
          fill = Math.max(EPS, entry * (1 + side * liqThreshold));
          exitReason = 'LIQUIDATION';
        }
      }

      if (!exitReason) {
        const gapStop = bull ? row.open <= stop : row.open >= stop;
        const gapTarget = canUseGapAndHighLowTp && (bull ? row.open >= target : row.open <= target);
        const hitStop = bull ? row.low <= stop : row.high >= stop;

        const isRaisedStopAboveEntry = beArmed || openPosition.tp1Hit ||
          ((openPosition.lock2Armed || openPosition.trailArmed) && side * (stop - entry) >= -EPS);
        const stopLabel = isRaisedStopAboveEntry ? 'BE' : 'SL';

        const tp1IsMaker = openPosition.tp1FeeMode === 'MAKER';
        const tp1Slip = tp1IsMaker ? 0 : slip;
        const tp1ExitFee = tp1IsMaker ? cfg.makerFeePct : (isPostOnly ? cfg.takerFeePct : cfg.costPct / 2);
        const tp1LegCost = isPostOnly || tp1IsMaker ? (entryFeePct + tp1ExitFee) : cfg.costPct;

        if (gapStop) {
          fill = row.open;
          exitReason = stopLabel;
        } else if (gapTarget) {
          if (openPosition.tp1QtyFrac > 0 && !openPosition.tp1Hit && Number.isFinite(openPosition.tp1Price)) {
            const tp1Exit = openPosition.tp1Price * (1 - side * tp1Slip);
            const leg1Gross = (side * (tp1Exit - entry)) / entry * 100;
            const leg1Net = leg1Gross - tp1LegCost;
            openPosition.realizedLeg1GrossPct += openPosition.tp1QtyFrac * leg1Gross;
            openPosition.realizedLeg1NetPct += openPosition.tp1QtyFrac * leg1Net;
            openPosition.remFrac = 1.0 - openPosition.tp1QtyFrac;
            openPosition.tp1Hit = true;
            openPosition.tp1BarIndex = i;
          }
          fill = target;
          exitReason = 'TP';
        } else if (hitStop) {
          fill = stop;
          exitReason = stopLabel;
        } else {
          let tp1JustHitByWick = false;
          if (openPosition.tp1QtyFrac > 0 && !openPosition.tp1Hit && Number.isFinite(openPosition.tp1Price)) {
            const gapTp1 = canUseGapAndHighLowTp && (bull ? row.open >= openPosition.tp1Price : row.open <= openPosition.tp1Price);
            const hitTp1 = canUseGapAndHighLowTp
              ? (bull ? row.high >= openPosition.tp1Price : row.low <= openPosition.tp1Price)
              : (cfg.limitSameBarTp === 'close' && (bull ? row.close >= openPosition.tp1Price : row.close <= openPosition.tp1Price));
            if (gapTp1 || hitTp1) {
              const tp1RawFill = (gapTp1 && !tp1IsMaker && !isEquity) ? row.open : openPosition.tp1Price;
              const tp1Exit = tp1RawFill * (1 - side * tp1Slip);
              const leg1Gross = (side * (tp1Exit - entry)) / entry * 100;
              const leg1Net = leg1Gross - tp1LegCost;
              openPosition.realizedLeg1GrossPct += openPosition.tp1QtyFrac * leg1Gross;
              openPosition.realizedLeg1NetPct += openPosition.tp1QtyFrac * leg1Net;
              openPosition.remFrac = 1.0 - openPosition.tp1QtyFrac;
              openPosition.tp1Hit = true;
              openPosition.tp1BarIndex = i;
              tp1JustHitByWick = !gapTp1;
            }
          }

          let hitTarget = false;
          if (canUseGapAndHighLowTp) {
            hitTarget = bull ? row.high >= target : row.low <= target;
          } else if (cfg.limitSameBarTp === 'close') {
            hitTarget = bull ? row.close >= target : row.close <= target;
          }
          const allowTp2SameBar = !tp1JustHitByWick || (bull ? row.close >= target : row.close <= target);

          if (hitTarget && allowTp2SameBar) {
            fill = target;
            exitReason = 'TP';
          } else if (barsHeld >= openPosition.maxHoldBars) {
            fill = row.close;
            exitReason = 'TIME';
          }
        }
      }

      if (exitReason) {
        let exit;
        let grossPct;
        let netPct;
        let unleveredNetPct;
        let fundingCashflowPct;
        let fundingDragPct;

        if (exitReason === 'LIQUIDATION') {
          exit = fill;
          unleveredNetPct = -100 / openPosition.lev;
          grossPct = -100;
          netPct = -100;
          fundingCashflowPct = openPosition.fundingCashflow1xPct === 0
            ? 0
            : openPosition.fundingCashflow1xPct * openPosition.lev;
          fundingDragPct = fundingCashflowPct === 0 ? 0 : -fundingCashflowPct;
        } else {
          const isMakerExit = isPostOnly && exitReason === 'TP';
          const exitSlip = isMakerExit ? 0 : slip;
          exit = fill * (1 - side * exitSlip);
          const remGross = (side * (exit - entry)) / entry * 100;
          const remCost = isPostOnly
            ? entryFeePct + (isMakerExit ? cfg.makerFeePct : cfg.takerFeePct)
            : cfg.costPct;
          const remNet = remGross - remCost;

          const unleveredGrossPct = openPosition.realizedLeg1GrossPct + openPosition.remFrac * remGross;
          unleveredNetPct = openPosition.realizedLeg1NetPct + openPosition.remFrac * remNet + openPosition.fundingCashflow1xPct;
          grossPct = unleveredGrossPct * openPosition.lev;
          netPct = unleveredNetPct * openPosition.lev;
          fundingCashflowPct = openPosition.fundingCashflow1xPct === 0
            ? 0
            : openPosition.fundingCashflow1xPct * openPosition.lev;
          fundingDragPct = fundingCashflowPct === 0 ? 0 : -fundingCashflowPct;
        }

        assert.ok(Number.isFinite(exit) && exit > 0 && Number.isFinite(grossPct) && Number.isFinite(netPct),
          `Non-finite or invalid trade return at row ${i}`);

        const trade = {
          signalIndex: openPosition.signalIndex,
          entryIndex: openPosition.entryIndex,
          exitIndex: i,
          side,
          entryMode: openPosition.entryMode,
          execProfile: cfg.execProfile,
          atr: openPosition.atr,
          limitPrice: openPosition.limitPrice,
          filledAtOpen,
          entry,
          stop,
          initialStop: openPosition.initialStop,
          target,
          initialStopDist: openPosition.initialStopDist,
          rewardRisk: openPosition.rewardRisk,
          lev: openPosition.lev,
          sizeMult: openPosition.sizeMult,
          tp1Hit: openPosition.tp1Hit,
          tp1BarIndex: openPosition.tp1BarIndex,
          tp1QtyFrac: openPosition.tp1QtyFrac,
          fundingDragPct,
          fundingCashflowPct,
          unleveredNetPct,
          beArmed,
          beArmedIndex: openPosition.beArmedIndex,
          lock2Armed: openPosition.lock2Armed,
          trailArmed: openPosition.trailArmed,
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
          if (exitReason === 'LIQUIDATION') {
            liquidated = true;
          }
        } else if (i >= cfg.start) {
          purgedTrades++;
        }
        openPosition = null;
      }
    }

    // 3. Confirmed-close ratchets (active starting bar i + 1).
    if (openPosition && openPosition.tp1Hit && openPosition.tp1LockOffsetR > 0) {
      const { side, entry, initialStopDist, stop, target, tp1LockOffsetR } = openPosition;
      const raisedTp1Stop = entry + side * tp1LockOffsetR * initialStopDist;
      if (side * (raisedTp1Stop - stop) > 0 && side * (target - raisedTp1Stop) > 0) {
        openPosition.stop = raisedTp1Stop;
        openPosition.beArmed = true;
        if (openPosition.beArmedIndex === null) openPosition.beArmedIndex = i;
      }
    }

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

    if (openPosition && openPosition.lock2TriggerR > 0 && !openPosition.lock2Armed) {
      const { side, entry, initialStopDist, stop, target, lock2TriggerR, lock2OffsetR } = openPosition;
      if (side * (row.close - entry) >= lock2TriggerR * initialStopDist) {
        const raisedStop = entry + side * lock2OffsetR * initialStopDist;
        if (side * (raisedStop - stop) > 0 && side * (target - raisedStop) > 0) {
          openPosition.stop = raisedStop;
          openPosition.lock2Armed = true;
          openPosition.lock2ArmedIndex = i;
        }
      }
    }

    if (openPosition && openPosition.trailTriggerR > 0 && openPosition.trailAtrMult > 0) {
      const { side, entry, initialStopDist, target, trailTriggerR, trailAtrMult, atr } = openPosition;
      if (!openPosition.trailArmed && side * (row.close - entry) >= trailTriggerR * initialStopDist) {
        openPosition.trailArmed = true;
        openPosition.trailArmedIndex = i;
      }
      if (openPosition.trailArmed && Number.isFinite(atr) && atr > 0) {
        const trailCandidate = row.close - side * trailAtrMult * atr;
        if (side * (trailCandidate - openPosition.stop) > 0 && side * (target - trailCandidate) > 0) {
          openPosition.stop = trailCandidate;
        }
      }
    }

    // 4. Signal queue / cooldown gate on closed bar i.
    const signal = byIndex.get(i);
    if (signal) {
      if (liquidated || openPosition || (pending && cfg.pendingPolicy === 'ignore') ||
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
            lock2TriggerR: entrySpec.lock2TriggerR,
            lock2OffsetR: entrySpec.lock2OffsetR,
            trailTriggerR: entrySpec.trailTriggerR,
            trailAtrMult: entrySpec.trailAtrMult,
            tp1TriggerR: entrySpec.tp1TriggerR,
            tp1QtyPct: entrySpec.tp1QtyPct,
            tp1LockOffsetR: entrySpec.tp1LockOffsetR,
            tp1FeeMode: entrySpec.tp1FeeMode,
            sizeMult: entrySpec.sizeMult,
            hasExplicitSizeMult: entrySpec.hasExplicitSizeMult,
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

  const periodYears = cfg.end - cfg.start >= 2
    ? (rows[cfg.end - 1].time - rows[cfg.start].time) / SECONDS_PER_YEAR
    : 0;
  const stats = computeSummaryStats(trades, periodYears);

  return {
    trades,
    openPosition,
    pending,
    execProfile: cfg.execProfile,
    ...stats,
    exitReasons,
    ignoredSignals,
    purgedTrades,
    expiredOrders,
    cancelledPendingOrders,
  };
}

function utcMonthKey(epochSec) {
  const d = new Date(epochSec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function enumerateUtcMonths(startSec, endSec) {
  const dStart = new Date(startSec * 1000);
  const dEnd = new Date(endSec * 1000);
  let y = dStart.getUTCFullYear();
  let m = dStart.getUTCMonth();
  const endY = dEnd.getUTCFullYear();
  const endM = dEnd.getUTCMonth();
  const months = [];
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m++;
    if (m >= 12) {
      m = 0;
      y++;
    }
  }
  return months;
}

function inferMinBarIntervalSeconds(rows) {
  if (rows.length < 2) return 0;
  let minDelta = Infinity;
  const limit = Math.min(rows.length, 100);
  for (let i = 1; i < limit; i++) {
    const delta = rows[i].time - rows[i - 1].time;
    if (delta > 0 && delta < minDelta) minDelta = delta;
  }
  return Number.isFinite(minDelta) ? minDelta : 0;
}

/**
 * Simulates a multi-stream cross-margin portfolio chronologically with hard intra-bar
 * mark-to-market liquidation physics and concurrent gross leverage capping.
 */
export function simulatePortfolioV7(
  streams,
  { maxTotalOpenLev = 10.0, levScale = 1.0, mmr = 0.005, monthlyReset = false } = {},
) {
  assert.ok(Array.isArray(streams), 'Expected streams array');
  assert.ok(Number.isFinite(maxTotalOpenLev) && maxTotalOpenLev > 0, 'Invalid maxTotalOpenLev');
  assert.ok(Number.isFinite(levScale) && levScale > 0, 'Invalid levScale');
  assert.ok(Number.isFinite(mmr) && mmr >= 0 && mmr < 0.5, 'Invalid mmr');

  const events = [];
  const streamMeta = [];
  const perStreamStats = new Map();
  let minTime = Infinity;
  let maxTime = -Infinity;

  for (let sIdx = 0; sIdx < streams.length; sIdx++) {
    const stream = streams[sIdx];
    assert.ok(stream && typeof stream === 'object', `Invalid stream at ${sIdx}`);
    const id = String(stream.id ?? `stream_${sIdx}`);
    const rows = stream.rows;
    const trades = stream.trades ?? [];
    assert.ok(Array.isArray(rows), `Stream ${id}: expected rows array`);
    assert.ok(Array.isArray(trades), `Stream ${id}: expected trades array`);

    if (rows.length > 0) {
      if (rows[0].time < minTime) minTime = rows[0].time;
      if (rows[rows.length - 1].time > maxTime) maxTime = rows[rows.length - 1].time;
    }

    const intervalSeconds = stream.intervalSeconds !== undefined
      ? stream.intervalSeconds
      : inferMinBarIntervalSeconds(rows);
    assert.ok(Number.isSafeInteger(intervalSeconds) && intervalSeconds >= 0, `Stream ${id}: invalid intervalSeconds`);

    const timeToIdx = new Map();
    for (let r = 0; r < rows.length; r++) {
      timeToIdx.set(rows[r].time, r);
    }
    streamMeta.push({ id, rows, intervalSeconds, timeToIdx });

    perStreamStats.set(id, {
      id,
      inputCount: trades.length,
      executedCount: 0,
      wins: 0,
      losses: 0,
      liquidations: 0,
      totalNetPct: 0,
      scaledByCapCount: 0,
      skippedByCapCount: 0,
    });

    for (let tIdx = 0; tIdx < trades.length; tIdx++) {
      const trade = trades[tIdx];
      assert.ok(trade && typeof trade === 'object', `Stream ${id}: invalid trade at ${tIdx}`);
      assert.ok(
        Number.isSafeInteger(trade.entryIndex) && trade.entryIndex >= 0 && trade.entryIndex < rows.length,
        `Stream ${id}: invalid entryIndex at trade ${tIdx}`,
      );
      assert.ok(
        Number.isSafeInteger(trade.exitIndex) && trade.exitIndex >= trade.entryIndex && trade.exitIndex < rows.length,
        `Stream ${id}: invalid exitIndex at trade ${tIdx}`,
      );
      const baseLev = trade.lev ?? 1.0;
      const requestedLev = baseLev * levScale;
      assert.ok(Number.isFinite(requestedLev) && requestedLev >= 0, `Stream ${id}: invalid trade.lev at ${tIdx}`);
      assert.ok(Number.isFinite(trade.netPct) && Number.isFinite(trade.grossPct),
        `Stream ${id}: non-finite PnL at trade ${tIdx}`);

      const entryTime = rows[trade.entryIndex].time;
      const exitTime = rows[trade.exitIndex].time + intervalSeconds;
      const tradeKey = `${sIdx}:${tIdx}`;

      events.push({
        type: 'ENTRY',
        typePriority: intervalSeconds === 0 && entryTime === exitTime ? 0 : 1,
        time: entryTime,
        sIdx,
        tIdx,
        id,
        tradeKey,
        trade,
        baseLev,
        requestedLev,
        entryTime,
        exitTime,
      });
      events.push({
        type: 'EXIT',
        typePriority: intervalSeconds === 0 && entryTime === exitTime ? 1 : 0,
        time: exitTime,
        sIdx,
        tIdx,
        id,
        tradeKey,
      });
    }
  }

  events.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    if (a.typePriority !== b.typePriority) return a.typePriority - b.typePriority;
    if (a.sIdx !== b.sIdx) return a.sIdx - b.sIdx;
    return a.tIdx - b.tIdx;
  });

  // Collect all unique bar timestamps where any stream can experience intra-bar wicks
  const allBarTimesSet = new Set();
  for (const meta of streamMeta) {
    for (const r of meta.rows) allBarTimesSet.add(r.time);
  }
  const allBarTimes = Array.from(allBarTimesSet).sort((a, b) => a - b);

  // Merge bar-MTM check timestamps with chronological ENTRY/EXIT events
  const activePositions = new Map();
  const executedTrades = [];
  let currentOpenLev = 0;
  let peakOpenLev = 0;
  let peakConcurrentPositions = 0;
  let scaledByCapCount = 0;
  let skippedByCapCount = 0;
  let equity = 1.0;
  let currentMonth = null;
  let liquidatedTotal = false;
  let liquidationCount = 0;

  // Track latest bar index per stream up to current timestamp
  const streamCursor = new Array(streamMeta.length).fill(-1);

  function advanceStreamCursorsTo(t) {
    for (let s = 0; s < streamMeta.length; s++) {
      const rows = streamMeta[s].rows;
      let idx = streamCursor[s];
      while (idx + 1 < rows.length && rows[idx + 1].time <= t) {
        idx++;
      }
      streamCursor[s] = idx;
    }
  }

  function checkCrossMarginLiquidation(t) {
    if (activePositions.size === 0 || equity <= 0) return false;
    advanceStreamCursorsTo(t);

    let worstUnrealizedDollars = 0;
    let totalNotional = 0;

    for (const pos of activePositions.values()) {
      const meta = streamMeta[pos.sIdx];
      const barIdx = streamCursor[pos.sIdx];
      if (barIdx < 0 || barIdx < pos.trade.entryIndex || barIdx > pos.trade.exitIndex) continue;
      const row = meta.rows[barIdx];
      const entryPrice = pos.trade.entry ?? row.open;
      const side = pos.trade.side ?? 1;
      const worstPrice = side === 1 ? row.low : row.high;
      const worstUnlevMove = (side * (worstPrice - entryPrice)) / entryPrice;
      const remFrac = (pos.trade.tp1Hit && Number.isFinite(pos.trade.tp1BarIndex) && barIdx > pos.trade.tp1BarIndex)
        ? (1 - (pos.trade.tp1QtyFrac ?? 0))
        : 1.0;
      const notional = pos.entryEquity * pos.effectiveLev * remFrac;
      totalNotional += notional;
      worstUnrealizedDollars += notional * worstUnlevMove;
    }

    if (totalNotional <= EPS) return false;
    const mtmEquity = equity + worstUnrealizedDollars;
    const maintMargin = mmr * totalNotional;
    if (mtmEquity <= maintMargin + EPS) {
      // Trigger portfolio liquidation across all open positions
      liquidationCount++;
      const liqMonth = utcMonthKey(t);
      const posList = Array.from(activePositions.entries());
      for (let k = 0; k < posList.length; k++) {
        const [tradeKey, pos] = posList[k];
        activePositions.delete(tradeKey);
        const stats = perStreamStats.get(pos.streamId);
        stats.executedCount++;
        stats.liquidations++;
        stats.losses++;
        // First liquidated position carries -100% (wiping equity to 0); remaining close at 0% so additive net isn't double-counted below -100% equity
        const pNet = k === 0 ? -100 : 0;
        stats.totalNetPct += pNet;
        executedTrades.push({
          ...pos.trade,
          streamId: pos.streamId,
          entryTime: pos.entryTime,
          exitTime: t,
          exitMonth: liqMonth,
          exitReason: 'LIQUIDATION',
          requestedLev: pos.requestedLev,
          effectiveLev: pos.effectiveLev,
          levScale: pos.levScale,
          portfolioGrossPct: pNet,
          portfolioNetPct: pNet,
          portfolioFundingDragPct: 0,
        });
      }
      currentOpenLev = 0;
      equity = 0;
      if (!monthlyReset) liquidatedTotal = true;
      return true;
    }
    return false;
  }

  let evIdx = 0;
  let barIdx = 0;

  while (evIdx < events.length) {
    const nextEvTime = events[evIdx].time;
    // Before processing events at nextEvTime, check any intra-bar timestamps strictly < nextEvTime while positions are open
    while (barIdx < allBarTimes.length && allBarTimes[barIdx] < nextEvTime) {
      const bt = allBarTimes[barIdx];
      barIdx++;
      if (activePositions.size > 0) {
        checkCrossMarginLiquidation(bt);
      }
    }

    // Group all events at exact timestamp nextEvTime
    const t = nextEvTime;
    const tMonth = utcMonthKey(t);
    if (monthlyReset && currentMonth !== null && tMonth !== currentMonth) {
      equity = 1.0;
      liquidatedTotal = false;
    }
    currentMonth = tMonth;

    // 1) Process EXIT events at timestamp t first (free leverage & settle realized PnL)
    while (evIdx < events.length && events[evIdx].time === t && events[evIdx].type === 'EXIT') {
      const ev = events[evIdx++];
      const pos = activePositions.get(ev.tradeKey);
      if (!pos) continue;
      activePositions.delete(ev.tradeKey);
      currentOpenLev = Math.max(0, currentOpenLev - pos.effectiveLev);

      let portfolioNetPct = pos.trade.netPct * pos.levScale;
      let portfolioGrossPct = pos.trade.grossPct * pos.levScale;
      if (pos.trade.exitReason === 'LIQUIDATION' || portfolioNetPct <= -100) {
        portfolioNetPct = -100;
        portfolioGrossPct = -100;
      }
      const portfolioFundingDragPct = (pos.trade.fundingDragPct ?? 0) * pos.levScale;

      // Scale PnL by entryEquity / current equity if monthlyReset or compounded
      const dollarPnL = pos.entryEquity * (portfolioNetPct / 100);
      equity = Math.max(0, equity + dollarPnL);
      const realizedPctOfPrevEq = pos.entryEquity > EPS ? (dollarPnL / pos.entryEquity) * 100 : portfolioNetPct;

      const stats = perStreamStats.get(pos.streamId);
      stats.executedCount++;
      stats.totalNetPct += realizedPctOfPrevEq;
      if (pos.trade.exitReason === 'LIQUIDATION') {
        stats.liquidations++;
        liquidationCount++;
        if (!monthlyReset) liquidatedTotal = true;
      }
      if (realizedPctOfPrevEq > EPS) stats.wins++;
      else if (realizedPctOfPrevEq < -EPS) stats.losses++;

      executedTrades.push({
        ...pos.trade,
        streamId: pos.streamId,
        entryTime: pos.entryTime,
        exitTime: pos.exitTime,
        requestedLev: pos.requestedLev,
        effectiveLev: pos.effectiveLev,
        levScale: pos.levScale,
        portfolioGrossPct,
        portfolioNetPct,
        portfolioFundingDragPct,
      });
    }

    // 2) Process ENTRY events at timestamp t
    while (evIdx < events.length && events[evIdx].time === t && events[evIdx].type === 'ENTRY') {
      const ev = events[evIdx++];
      const stats = perStreamStats.get(ev.id);
      if (liquidatedTotal || equity <= EPS) {
        skippedByCapCount++;
        stats.skippedByCapCount++;
        continue;
      }

      const availLev = Math.max(0, maxTotalOpenLev - currentOpenLev);
      const effectiveLev = Math.min(ev.requestedLev, availLev);
      const scale = ev.baseLev > EPS ? effectiveLev / ev.baseLev : 0;

      if (ev.requestedLev > EPS && effectiveLev <= EPS) {
        skippedByCapCount++;
        stats.skippedByCapCount++;
        continue;
      }

      if (effectiveLev < ev.requestedLev - 1e-9) {
        scaledByCapCount++;
        stats.scaledByCapCount++;
      }

      currentOpenLev += effectiveLev;
      if (currentOpenLev > peakOpenLev) peakOpenLev = currentOpenLev;

      activePositions.set(ev.tradeKey, {
        sIdx: ev.sIdx,
        streamId: ev.id,
        trade: ev.trade,
        entryTime: ev.entryTime,
        exitTime: ev.exitTime,
        entryEquity: equity,
        requestedLev: ev.requestedLev,
        effectiveLev,
        levScale: scale,
      });
      if (activePositions.size > peakConcurrentPositions) {
        peakConcurrentPositions = activePositions.size;
      }
    }

    // 3) Check intra-bar liquidation at timestamp t (catches entry-bar wicks and zero-interval same-bar checks)
    while (barIdx < allBarTimes.length && allBarTimes[barIdx] <= t) {
      barIdx++;
    }
    if (activePositions.size > 0) {
      checkCrossMarginLiquidation(t);
    }
  }

  const periodYears = (Number.isFinite(minTime) && Number.isFinite(maxTime) && maxTime > minTime)
    ? (maxTime - minTime) / SECONDS_PER_YEAR
    : 0;
  const stats = computeSummaryStats(executedTrades, periodYears);

  return {
    trades: executedTrades,
    maxTotalOpenLev,
    levScale,
    mmr,
    monthlyReset,
    peakOpenLev,
    peakConcurrentPositions,
    scaledByCapCount,
    skippedByCapCount,
    WR: stats.winRatePct,
    PF: stats.profitFactor,
    ...stats,
    liquidationCount,
    perStream: Object.fromEntries(perStreamStats),
  };
}

/**
 * Summarizes trades by UTC calendar month (including 0-trade months) into both:
 * 1) Monthly Profit-Sweep metrics (resetting capital to 1.0 each month)
 * 2) Compounded Growth metrics across the entire window.
 */
export function summarizeMonthlyCashflowV7(trades, rowsOrStartEnd) {
  assert.ok(Array.isArray(trades), 'Expected trades array');

  let startSec;
  let endSec;
  let refRows = null;

  if (Array.isArray(rowsOrStartEnd)) {
    assert.ok(rowsOrStartEnd.length > 0, 'Expected non-empty rows array');
    refRows = rowsOrStartEnd;
    startSec = rowsOrStartEnd[0].time;
    endSec = rowsOrStartEnd[rowsOrStartEnd.length - 1].time;
  } else if (rowsOrStartEnd && typeof rowsOrStartEnd === 'object') {
    startSec = rowsOrStartEnd.startSec ?? rowsOrStartEnd.startTime ?? rowsOrStartEnd.firstTime;
    endSec = rowsOrStartEnd.endSec ?? rowsOrStartEnd.endTime ?? rowsOrStartEnd.lastTime;
    if (Array.isArray(rowsOrStartEnd.rows) && rowsOrStartEnd.rows.length > 0) {
      refRows = rowsOrStartEnd.rows;
      if (startSec === undefined) startSec = refRows[0].time;
      if (endSec === undefined) endSec = refRows[refRows.length - 1].time;
    }
  }

  if (startSec === undefined || endSec === undefined) {
    assert.ok(trades.length > 0, 'Provide rows or {startTime, endTime} when trades is empty');
    startSec = Math.min(...trades.map(t => t.entryTime ?? t.exitTime));
    endSec = Math.max(...trades.map(t => t.exitTime ?? t.entryTime));
  }

  assert.ok(Number.isFinite(startSec) && Number.isFinite(endSec) && endSec >= startSec,
    'Invalid start/end timestamps for summarizeMonthlyCashflowV7');

  const months = enumerateUtcMonths(startSec, endSec);
  const byMonth = new Map(months.map(m => [m, []]));

  for (const t of trades) {
    const exitTime = t.exitTime ?? (refRows && Number.isSafeInteger(t.exitIndex) ? refRows[t.exitIndex]?.time : undefined);
    assert.ok(Number.isFinite(exitTime), 'Trade missing exitTime (or rows[exitIndex].time)');
    const mKey = utcMonthKey(exitTime);
    if (!byMonth.has(mKey)) continue;
    byMonth.get(mKey).push(t);
  }

  const monthlyTable = [];
  const monthlySweepReturns = [];
  let cumSweep = 0;
  let peakSweep = 0;
  let maxMonthlySweepDdPct = 0;
  let positiveMonths = 0;
  let monthsGe30 = 0;
  let worstMonthPct = Infinity;

  for (const mKey of months) {
    const mTrades = byMonth.get(mKey);
    let mEq = 1.0;
    let mPeakEq = 1.0;
    let intraMonthMaxDdPct = 0;
    let mAdditive = 0;
    let mWins = 0;
    let mLiqs = 0;

    for (const t of mTrades) {
      const r = t.portfolioNetPct ?? t.netPct;
      if (t.exitReason === 'LIQUIDATION') mLiqs++;
      if (r > EPS) mWins++;
      mAdditive += r;
      const factor = 1 + r / 100;
      mEq = factor <= 0 ? 0 : mEq * factor;
      if (mEq > mPeakEq) mPeakEq = mEq;
      const dd = mPeakEq > 0 ? ((mPeakEq - mEq) / mPeakEq) * 100 : 100;
      if (dd > intraMonthMaxDdPct) intraMonthMaxDdPct = dd;
    }

    const sweepNetPct = (mEq - 1.0) * 100;
    monthlySweepReturns.push(sweepNetPct);
    if (sweepNetPct > EPS) positiveMonths++;
    if (sweepNetPct >= 30 - EPS) monthsGe30++;
    if (sweepNetPct < worstMonthPct) worstMonthPct = sweepNetPct;

    cumSweep += sweepNetPct;
    if (cumSweep > peakSweep) peakSweep = cumSweep;
    const sweepDd = peakSweep - cumSweep;
    if (sweepDd > maxMonthlySweepDdPct) maxMonthlySweepDdPct = sweepDd;

    monthlyTable.push({
      month: mKey,
      count: mTrades.length,
      wins: mWins,
      sweepNetPct,
      additiveNetPct: mAdditive,
      intraMonthMaxDdPct,
      liquidations: mLiqs,
    });
  }

  const totalMonths = months.length;
  const meanMonthlySweepPct = totalMonths > 0
    ? monthlySweepReturns.reduce((a, b) => a + b, 0) / totalMonths
    : 0;
  const sortedSweep = [...monthlySweepReturns].sort((a, b) => a - b);
  const medianMonthlySweepPct = totalMonths === 0
    ? 0
    : totalMonths % 2 === 1
      ? sortedSweep[(totalMonths - 1) / 2]
      : (sortedSweep[totalMonths / 2 - 1] + sortedSweep[totalMonths / 2]) / 2;

  const periodYears = (endSec - startSec) / SECONDS_PER_YEAR;
  const compStats = computeSummaryStats(trades, periodYears);
  const geomMonthlyPct = totalMonths > 0
    ? (compStats.finalEquity > 0 ? (Math.pow(compStats.finalEquity, 1 / totalMonths) - 1) * 100 : -100)
    : null;

  return {
    totalMonths,
    meanMonthlySweepPct,
    medianMonthlySweepPct,
    pctPositiveMonths: totalMonths > 0 ? (positiveMonths / totalMonths) * 100 : 0,
    pctMonthsGe30: totalMonths > 0 ? (monthsGe30 / totalMonths) * 100 : 0,
    worstMonthPct: totalMonths > 0 ? worstMonthPct : 0,
    maxMonthlySweepDdPct,
    totalSweptNetPct: cumSweep,
    compoundedNetPct: compStats.compoundedNetPct,
    cagrPct: compStats.cagrPct,
    geomMonthlyPct,
    maxCompoundedDdPct: compStats.compoundedMaxDrawdownPct,
    winRatePct: compStats.winRatePct,
    profitFactor: compStats.profitFactor,
    liquidationCount: compStats.liquidationCount,
    count: compStats.count,
    monthlyTable,
  };
}
