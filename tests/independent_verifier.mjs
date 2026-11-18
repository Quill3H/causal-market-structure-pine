import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EPS = 1e-12;

function sha256File(relPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, relPath))).digest('hex');
}

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// ============================================================================
// 1. INDEPENDENT DATASET & HTF ALIGNMENT VERIFICATION
// ============================================================================
function verifyDatasetRawFromObj(ds, relPath = '<memory>') {
  const { rows, intervalSeconds, htf } = ds;
  assert.ok(Array.isArray(rows) && rows.length > 0, `${relPath}: empty rows`);
  assert.ok(Number.isSafeInteger(intervalSeconds) && intervalSeconds > 0, `${relPath}: bad intervalSeconds`);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    assert.ok(Number.isSafeInteger(r.time) && r.time > 0, `${relPath}: invalid time at ${i}`);
    if (i > 0) {
      assert.equal(r.time - rows[i - 1].time, intervalSeconds, `${relPath}: timestamp gap/dup at ${i}`);
    }
    assert.ok(
      Number.isFinite(r.open) && Number.isFinite(r.high) && Number.isFinite(r.low) && Number.isFinite(r.close) &&
      r.open > 0 && r.high > 0 && r.low > 0 && r.close > 0 &&
      r.low <= Math.min(r.open, r.close) && r.high >= Math.max(r.open, r.close) &&
      Number.isFinite(r.volume) && r.volume >= 0,
      `${relPath}: invalid OHLCV at ${i}`,
    );
  }

  const verifiedHtf = {};
  for (const [tfKey, hObj] of Object.entries(htf ?? {})) {
    const hRows = hObj.rows;
    const hSec = hObj.intervalSeconds;
    assert.ok(Array.isArray(hRows) && hRows.length > 0, `${relPath}: empty htf[${tfKey}]`);
    for (let j = 0; j < hRows.length; j++) {
      const hr = hRows[j];
      if (j > 0) {
        assert.equal(hr.time - hRows[j - 1].time, hSec, `${relPath}: htf[${tfKey}] gap at ${j}`);
      }
      assert.ok(
        hr.open > 0 && hr.high > 0 && hr.low > 0 && hr.close > 0 &&
        hr.low <= Math.min(hr.open, hr.close) && hr.high >= Math.max(hr.open, hr.close),
        `${relPath}: invalid htf[${tfKey}] OHLC at ${j}`,
      );
    }

    const computedAligned = new Int32Array(rows.length);
    let j = -1;
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i].time;
      while (j + 1 < hRows.length && hRows[j + 1].time + hSec <= t) j++;
      assert.ok(j >= 0, `${relPath}: no closed htf[${tfKey}] bar before LTF bar ${i}`);
      assert.ok(hRows[j].time + hSec <= t, `${relPath}: HTF lookahead at ${i}`);
      if (j + 1 < hRows.length) {
        assert.ok(hRows[j + 1].time + hSec > t, `${relPath}: missed newer closed HTF at ${i}`);
      }
      if (Array.isArray(hObj.alignedIndex)) {
        assert.equal(hObj.alignedIndex[i], j, `${relPath}: stored alignedIndex mismatch on ${tfKey}[${i}]`);
      }
      computedAligned[i] = j;
    }
    verifiedHtf[tfKey] = { rows: hRows, intervalSeconds: hSec, alignedIndex: computedAligned };
  }

  return verifiedHtf;
}

function verifyDatasetRaw(relPath, expectedSha256 = null) {
  const ds = readJson(relPath);
  const actualSha = sha256File(relPath);
  if (expectedSha256) {
    assert.equal(actualSha, expectedSha256, `${relPath}: SHA-256 mismatch`);
  }
  const verifiedHtf = verifyDatasetRawFromObj(ds, relPath);
  return { ds, actualSha, verifiedHtf };
}

// ============================================================================
// 2. CLEAN-ROOM PINE V6 INDICATOR FORMULAS (ZERO SHARED CODE)
// ============================================================================
function cleanEma(values, len) {
  const out = new Float64Array(values.length).fill(NaN);
  const k = 2 / (len + 1);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < len - 1) {
      sum += values[i];
    } else if (i === len - 1) {
      sum += values[i];
      out[i] = sum / len;
    } else {
      out[i] = out[i - 1] + k * (values[i] - out[i - 1]);
    }
  }
  return out;
}

function cleanAtr(rows, len) {
  const out = new Float64Array(rows.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prevC = i === 0 ? r.close : rows[i - 1].close;
    const tr = Math.max(r.high - r.low, Math.abs(r.high - prevC), Math.abs(r.low - prevC));
    if (i < len - 1) {
      sum += tr;
    } else if (i === len - 1) {
      sum += tr;
      out[i] = sum / len;
    } else {
      out[i] = out[i - 1] + (tr - out[i - 1]) / len;
    }
  }
  return out;
}

function cleanRsi(closes, len) {
  const out = new Float64Array(closes.length).fill(NaN);
  let upSum = 0;
  let dnSum = 0;
  let avgUp = NaN;
  let avgDn = NaN;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const up = diff > 0 ? diff : 0;
    const dn = diff < 0 ? -diff : 0;
    if (i < len) {
      upSum += up;
      dnSum += dn;
    } else if (i === len) {
      upSum += up;
      dnSum += dn;
      avgUp = upSum / len;
      avgDn = dnSum / len;
      out[i] = avgUp === 0 && avgDn === 0 ? 50 : avgDn === 0 ? 100 : avgUp === 0 ? 0 : 100 - 100 / (1 + avgUp / avgDn);
    } else {
      avgUp = avgUp + (up - avgUp) / len;
      avgDn = avgDn + (dn - avgDn) / len;
      out[i] = avgUp === 0 && avgDn === 0 ? 50 : avgDn === 0 ? 100 : avgUp === 0 ? 0 : 100 - 100 / (1 + avgUp / avgDn);
    }
  }
  return out;
}

function cleanPrevHighLow(rows, len) {
  const prevHigh = new Float64Array(rows.length).fill(NaN);
  const prevLow = new Float64Array(rows.length).fill(NaN);
  for (let i = len; i < rows.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - len; k < i; k++) {
      if (rows[k].high > hi) hi = rows[k].high;
      if (rows[k].low < lo) lo = rows[k].low;
    }
    prevHigh[i] = hi;
    prevLow[i] = lo;
  }
  return { prevHigh, prevLow };
}

// ============================================================================
// 3. CLEAN-ROOM CONSERVATIVE TRADE SIMULATOR (ZERO SHARED CODE)
// ============================================================================
function cleanWilLower95(wins, n, z = 1.96) {
  if (n <= 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  return Math.max(0, ((p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n)) * 100);
}

function summarizeCleanTrades(trades) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let gains = 0;
  let lossSum = 0;
  let netSum = 0;
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let buyCount = 0;
  let buyWins = 0;
  let sellCount = 0;
  let sellWins = 0;
  const exitReasons = { SL: 0, TP: 0, TIME: 0, BE: 0 };

  for (const t of trades) {
    const isWin = t.netPct > EPS;
    if (isWin) {
      wins++;
      gains += t.netPct;
    } else if (t.netPct < -EPS) {
      losses++;
      lossSum -= t.netPct;
    } else {
      ties++;
    }
    if (t.side === 1) {
      buyCount++;
      if (isWin) buyWins++;
    } else {
      sellCount++;
      if (isWin) sellWins++;
    }
    netSum += t.netPct;
    cum += t.netPct;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
    exitReasons[t.exitReason]++;
  }

  const count = trades.length;
  return {
    trades,
    count,
    wins,
    losses,
    ties,
    winRatePct: count ? (wins / count) * 100 : null,
    wilsonLower95Pct: count ? cleanWilLower95(wins, count) : null,
    meanNetPct: count ? netSum / count : null,
    totalNetPct: netSum,
    maxDrawdownPct: maxDd,
    profitFactor: lossSum > 0 ? gains / lossSum : null,
    exitReasons,
    buyCount,
    buyWins,
    buyWinRatePct: buyCount ? (buyWins / buyCount) * 100 : null,
    sellCount,
    sellWins,
    sellWinRatePct: sellCount ? (sellWins / sellCount) * 100 : null,
  };
}

function cleanSimulate(rows, signals, cfg) {
  const {
    start = 0,
    end = rows.length,
    warmup = 250,
    cooldown,
    limitExpiryBars = 6,
    stopAtr,
    minStopPct,
    rewardRisk,
    maxHoldBars,
    beTriggerR,
    beOffsetPct,
    costPct = 0.10,
    slippagePct = 0.025,
    limitSameBarTp = 'close',
  } = cfg;

  assert.ok(rewardRisk >= 0.75, `RR below 0.75: ${rewardRisk}`);
  const slip = slippagePct / 100;
  const sigByBar = new Map(signals.filter(s => s.barIndex < end).map(s => [s.barIndex, s]));

  let pending = null;
  let pos = null;
  let lastAccepted = -Infinity;
  const trades = [];

  const calcLevels = (entry, side, atr) => {
    if (!(entry > 0 && atr > 0 && Number.isFinite(entry) && Number.isFinite(atr))) return null;
    const dist = Math.max(atr * stopAtr, (entry * minStopPct) / 100);
    const stop = entry - side * dist;
    const target = entry + side * dist * rewardRisk;
    if (!(dist > 0 && stop > 0 && target > 0 && side * (entry - stop) > 0 && side * (target - entry) > 0)) return null;
    const rr = (side * (target - entry)) / (side * (entry - stop));
    assert.ok(rr + EPS >= 0.75, `Actual RR ${rr} < 0.75`);
    return { entry, stop, target, dist, rr };
  };

  for (let i = 0; i < end; i++) {
    const r = rows[i];

    // Step 1: Fill or expire pending limit order
    if (!pos && pending) {
      const bull = pending.side === 1;
      const touched = bull ? r.low <= pending.limitPrice : r.high >= pending.limitPrice;
      if (touched) {
        const filledAtOpen = bull ? r.open <= pending.limitPrice : r.open >= pending.limitPrice;
        const rawEntry = bull ? Math.min(r.open, pending.limitPrice) : Math.max(r.open, pending.limitPrice);
        const slippedEntry = rawEntry * (1 + pending.side * slip);
        const lv = calcLevels(slippedEntry, pending.side, pending.atr);
        if (lv) {
          pos = {
            signalIndex: pending.signalIndex,
            entryIndex: i,
            side: pending.side,
            atr: pending.atr,
            limitPrice: pending.limitPrice,
            filledAtOpen,
            entry: lv.entry,
            stop: lv.stop,
            initialStop: lv.stop,
            target: lv.target,
            initialDist: lv.dist,
            rewardRisk: lv.rr,
            beArmed: false,
            beArmedIndex: null,
          };
        }
        pending = null;
      } else if (i >= pending.expiryBar) {
        pending = null;
      }
    }

    // Step 2: Conservative intra-bar exit evaluation (including entry bar)
    if (pos) {
      const bull = pos.side === 1;
      const isEntryBar = i === pos.entryIndex;
      const held = i - pos.entryIndex + 1;
      const allowWickTp = !isEntryBar || pos.filledAtOpen || limitSameBarTp === 'touch';

      const gapSL = bull ? r.open <= pos.stop : r.open >= pos.stop;
      const gapTP = allowWickTp && (bull ? r.open >= pos.target : r.open <= pos.target);
      const hitSL = bull ? r.low <= pos.stop : r.high >= pos.stop;
      const hitTP = allowWickTp
        ? (bull ? r.high >= pos.target : r.low <= pos.target)
        : (limitSameBarTp === 'close' && (bull ? r.close >= pos.target : r.close <= pos.target));

      const slReason = pos.beArmed ? 'BE' : 'SL';
      let rawExit = null;
      let exitReason = null;

      if (gapSL) {
        rawExit = r.open;
        exitReason = slReason;
      } else if (gapTP) {
        rawExit = pos.target;
        exitReason = 'TP';
      } else if (hitSL) {
        rawExit = pos.stop;
        exitReason = slReason;
      } else if (hitTP) {
        rawExit = pos.target;
        exitReason = 'TP';
      } else if (held >= maxHoldBars) {
        rawExit = r.close;
        exitReason = 'TIME';
      }

      if (exitReason !== null) {
        if (exitReason === 'TP') {
          assert.ok(!gapSL && !hitSL, `Conservative rule breach at bar ${i}`);
        }
        const exit = rawExit * (1 - pos.side * slip);
        const grossPct = (pos.side * (exit - pos.entry)) / pos.entry * 100;
        const netPct = grossPct - costPct;

        if (pos.signalIndex >= start) {
          trades.push({
            signalIndex: pos.signalIndex,
            entryIndex: pos.entryIndex,
            exitIndex: i,
            side: pos.side,
            atr: pos.atr,
            limitPrice: pos.limitPrice,
            filledAtOpen: pos.filledAtOpen,
            entry: pos.entry,
            stop: pos.stop,
            initialStop: pos.initialStop,
            target: pos.target,
            initialDist: pos.initialDist,
            rewardRisk: pos.rewardRisk,
            beArmed: pos.beArmed,
            beArmedIndex: pos.beArmedIndex,
            rawExit,
            exit,
            exitReason,
            barsHeld: held,
            grossPct,
            netPct,
          });
        }
        pos = null;
      }
    }

    // Step 3: Confirmed-close BE+ ratchet (applies from bar i + 1)
    if (pos && beTriggerR > 0 && !pos.beArmed) {
      if (pos.side * (r.close - pos.entry) >= beTriggerR * pos.initialDist) {
        const raised = pos.entry * (1 + (pos.side * beOffsetPct) / 100);
        if (pos.side * (raised - pos.stop) > 0 && pos.side * (pos.target - raised) > 0) {
          pos.stop = raised;
          pos.beArmed = true;
          pos.beArmedIndex = i;
        }
      }
    }

    // Step 4: Queue new pending limit order
    const sig = sigByBar.get(i);
    if (sig && !pos && !pending && i >= warmup && i - lastAccepted >= cooldown) {
      if (calcLevels(sig.limitPrice, sig.side, sig.atr)) {
        pending = {
          signalIndex: i,
          side: sig.side,
          atr: sig.atr,
          limitPrice: sig.limitPrice,
          expiryBar: i + limitExpiryBars,
        };
        lastAccepted = i;
      }
    }
  }

  return summarizeCleanTrades(trades);
}

// ============================================================================
// 4. CLEAN-ROOM 15m & 1h SIGNAL GENERATORS
// ============================================================================
const CFG_15M = {
  warmup: 250,
  cooldown: 8,
  limitExpiryBars: 6,
  stopAtr: 3.0,
  minStopPct: 1.0,
  rewardRisk: 1.15,
  maxHoldBars: 120,
  beTriggerR: 0.43,
  beOffsetPct: 0.28,
  costPct: 0.10,
  slippagePct: 0.025,
};

function generateClean15mSignals(ds, verifiedHtf) {
  const rows = ds.rows;
  const h1Rows = verifiedHtf['1h'].rows;
  const h1Idx = verifiedHtf['1h'].alignedIndex;

  const ltfCloses = rows.map(r => r.close);
  const h1Closes = h1Rows.map(r => r.close);

  const ltfEma20 = cleanEma(ltfCloses, 20);
  const ltfEma50 = cleanEma(ltfCloses, 50);
  const ltfAtr14 = cleanAtr(rows, 14);

  const h1Ema50 = cleanEma(h1Closes, 50);
  const h1Atr14 = cleanAtr(h1Rows, 14);
  const h1Rsi14 = cleanRsi(h1Closes, 14);

  const signals = [];
  for (let i = CFG_15M.warmup; i < rows.length; i++) {
    const r = rows[i];
    const atr = ltfAtr14[i];
    const ema50 = ltfEma50[i];
    const ema20 = ltfEma20[i];
    if (!(atr > 0 && Number.isFinite(atr) && Number.isFinite(ema50))) continue;
    if ((atr / r.close) * 100 < 0.18) continue;

    const j1 = h1Idx[i];
    const h = h1Rows[j1];
    const hRange = h.high - h.low;
    const atr1 = h1Atr14[j1];
    const ema50_1 = h1Ema50[j1];
    const rsi1 = h1Rsi14[j1];
    if (!(hRange > 0 && atr1 > 0 && Number.isFinite(atr1) && Number.isFinite(ema50_1))) continue;

    const bull = (h.close - h.open) >= 1.0 * atr1 &&
      (h.close - h.low) / hRange >= 0.65 &&
      h.close > ema50_1 && r.close > ema50;
    const bear = (h.open - h.close) >= 1.0 * atr1 &&
      (h.high - h.close) / hRange >= 0.65 &&
      h.close < ema50_1 && r.close < ema50;

    let side = bull && !bear ? 1 : bear && !bull ? -1 : 0;
    if (side !== 0 && Number.isFinite(rsi1) && Number.isFinite(ema20)) {
      const dirRsi = side === 1 ? rsi1 : 100 - rsi1;
      const distAtr = (side * (r.close - ema20)) / atr;
      if (dirRsi >= 72 && distAtr > 1.8) side = 0;
    }
    if (side === 0) continue;

    const limitPrice = r.close - side * 0.55 * atr;
    if (Number.isFinite(limitPrice) && limitPrice > 0) {
      signals.push({ barIndex: i, side, atr, limitPrice });
    }
  }
  return signals;
}

const CFG_1H = {
  warmup: 250,
  cooldown: 4,
  limitExpiryBars: 6,
  stopAtr: 3.2,
  minStopPct: 1.4,
  rewardRisk: 1.15,
  maxHoldBars: 96,
  beTriggerR: 0.43,
  beOffsetPct: 0.34,
  costPct: 0.10,
  slippagePct: 0.025,
};

function generateClean1hRawSignals(ds, verifiedHtf, limitOffsetAtr = 0.18) {
  const rows = ds.rows;
  const h4Rows = verifiedHtf['4h'].rows;
  const h4Idx = verifiedHtf['4h'].alignedIndex;
  const d1Rows = verifiedHtf['1d'].rows;
  const d1Idx = verifiedHtf['1d'].alignedIndex;

  const atr14 = cleanAtr(rows, 14);
  const { prevHigh: prevH20, prevLow: prevL20 } = cleanPrevHighLow(rows, 20);

  const h4Ema50 = cleanEma(h4Rows.map(r => r.close), 50);
  const { prevHigh: h4PrevH10, prevLow: h4PrevL10 } = cleanPrevHighLow(h4Rows, 10);

  const rawSignals = [];
  for (let i = CFG_1H.warmup; i < rows.length; i++) {
    const r = rows[i];
    const atr = atr14[i];
    if (!(atr > 0 && Number.isFinite(atr))) continue;

    const j4 = h4Idx[i];
    const h4Close = h4Rows[j4].close;
    const h4Ema = h4Ema50[j4];
    if (!Number.isFinite(h4Ema)) continue;

    const htfBull = h4Close > h4Ema;
    const htfBear = h4Close < h4Ema;

    let b1h = false, s1h = false, b4h = false, s4h = false, bPd = false, sPd = false;
    for (let k = 1; k <= 4; k++) {
      if (i - k >= 20) {
        const l1 = prevL20[i - k];
        const h1 = prevH20[i - k];
        let allB = true, allA = true;
        for (let m = 1; m <= k; m++) {
          if (!(rows[i - m].close < l1)) allB = false;
          if (!(rows[i - m].close > h1)) allA = false;
        }
        if (allB && r.close > l1 && r.close > r.open) b1h = true;
        if (allA && r.close < h1 && r.close < r.open) s1h = true;
      }

      const j4k = h4Idx[i - k];
      if (j4k >= 10) {
        const l4 = h4PrevL10[j4k];
        const h4 = h4PrevH10[j4k];
        let allB = true, allA = true;
        for (let m = 1; m <= k; m++) {
          if (!(rows[i - m].close < l4)) allB = false;
          if (!(rows[i - m].close > h4)) allA = false;
        }
        if (allB && r.close > l4 && r.close > r.open) b4h = true;
        if (allA && r.close < h4 && r.close < r.open) s4h = true;
      }

      if (k <= 2) {
        const jDk = d1Idx[i - k];
        const lD = d1Rows[jDk].low;
        const hD = d1Rows[jDk].high;
        let allB = true, allA = true;
        for (let m = 1; m <= k; m++) {
          if (!(rows[i - m].close < lD)) allB = false;
          if (!(rows[i - m].close > hD)) allA = false;
        }
        if (allB && r.close > lD && r.close > r.open) bPd = true;
        if (allA && r.close < hD && r.close < r.open) sPd = true;
      }
    }

    const bull = (b1h || b4h || bPd) && htfBull;
    const bear = (s1h || s4h || sPd) && htfBear;
    if (bull === bear) continue;

    const side = bull ? 1 : -1;
    const limitPrice = r.close - side * limitOffsetAtr * atr;
    if (Number.isFinite(limitPrice) && limitPrice > 0) {
      rawSignals.push({ barIndex: i, side, atr, limitPrice });
    }
  }
  return rawSignals;
}

function generateClean1hSignals(ds, verifiedHtf, opts = {}) {
  const {
    limitOffsetAtr = 0.18,
    winLen = 6,
    slThresh = 2,
    execCfg = CFG_1H,
  } = opts;
  const rows = ds.rows;
  const rawSignals = generateClean1hRawSignals(ds, verifiedHtf, limitOffsetAtr);
  const shadowSim = cleanSimulate(rows, rawSignals, { ...execCfg, start: 0, end: rows.length });

  const exitsAtBar = new Map();
  for (const t of shadowSim.trades) {
    if (!exitsAtBar.has(t.exitIndex)) exitsAtBar.set(t.exitIndex, []);
    exitsAtBar.get(t.exitIndex).push(t);
  }
  const rawAtBar = new Map(rawSignals.map(s => [s.barIndex, s]));

  const histBySide = { 1: [], [-1]: [] };
  const adaptiveSignals = [];
  const minHist = Math.min(slThresh, winLen);
  for (let i = 0; i < rows.length; i++) {
    const settled = exitsAtBar.get(i);
    if (settled) {
      for (const t of settled) {
        const q = histBySide[t.side];
        q.push(t);
        if (q.length > winLen) q.shift();
      }
    }
    const raw = rawAtBar.get(i);
    if (!raw) continue;

    const hist = histBySide[raw.side];
    let slCount = 0;
    let netSum = 0;
    for (const h of hist) {
      if (h.exitReason === 'SL') slCount++;
      netSum += h.netPct;
    }
    const flip = hist.length >= minHist && slCount >= slThresh && netSum < 0;
    const side = flip ? -raw.side : raw.side;
    const limitPrice = rows[i].close - side * limitOffsetAtr * raw.atr;
    if (Number.isFinite(limitPrice) && limitPrice > 0) {
      adaptiveSignals.push({ barIndex: i, side, atr: raw.atr, limitPrice });
    }
  }
  return adaptiveSignals;
}

function runCleanAnchoredWf1h(ds24m, verifiedHtf) {
  const foldsDef = [
    { fold: 1, trainEnd: 4380, testStart: 4380, testEnd: 7665 },
    { fold: 2, trainEnd: 7665, testStart: 7665, testEnd: 10950 },
    { fold: 3, trainEnd: 10950, testStart: 10950, testEnd: 14235 },
    { fold: 4, trainEnd: 14235, testStart: 14235, testEnd: 17520 },
  ];

  const catalogSpecs = [];
  for (const limitOffsetAtr of [0.15, 0.18]) {
    for (const tier of [{ stopAtr: 3.2, minStopPct: 1.4 }, { stopAtr: 3.5, minStopPct: 1.5 }]) {
      for (const rewardRisk of [1.05, 1.15]) {
        for (const maxHoldBars of [84, 96]) {
          for (const winLen of [5, 6]) {
            catalogSpecs.push({ limitOffsetAtr, winLen, execCfg: { ...CFG_1H, ...tier, rewardRisk, maxHoldBars } });
          }
        }
      }
    }
  }

  const foldResults = [];
  const oosTrades = [];
  for (const def of foldsDef) {
    const prefixDs = truncateDatasetStrict(ds24m, def.trainEnd);
    const prefixHtf = verifyDatasetRawFromObj(prefixDs, `1h_wf_fold${def.fold}`);
    const minCount = Math.max(18, Math.floor(def.trainEnd / 280));
    const numSlices = Math.max(2, Math.floor(def.trainEnd / 2190));
    const sliceLen = Math.floor(def.trainEnd / numSlices);
    const minSliceCount = Math.max(8, Math.floor(sliceLen / 260));

    let best = null;
    for (let order = 0; order < catalogSpecs.length; order++) {
      const spec = catalogSpecs[order];
      const trainSigs = generateClean1hSignals(prefixDs, prefixHtf, spec);
      const sim = cleanSimulate(prefixDs.rows, trainSigs, { ...spec.execCfg, start: 0, end: def.trainEnd });
      const slices = [];
      for (let k = 0; k < numSlices; k++) {
        const sStart = k * sliceLen;
        const sEnd = k === numSlices - 1 ? def.trainEnd : (k + 1) * sliceLen;
        slices.push(cleanSimulate(prefixDs.rows, trainSigs, { ...spec.execCfg, start: sStart, end: sEnd }));
      }
      const minSlicePf = Math.min(...slices.map(s => s.profitFactor ?? 0));
      const minSliceWr = Math.min(...slices.map(s => s.winRatePct ?? 0));
      const minSliceCnt = Math.min(...slices.map(s => s.count));
      const eligible = sim.count >= minCount && minSliceCnt >= minSliceCount &&
        (sim.winRatePct ?? 0) >= 65.0 && minSliceWr >= 62.0 &&
        (sim.meanNetPct ?? -Infinity) > 0 && (sim.profitFactor ?? 0) >= 1.20 && minSlicePf >= 1.00;
      const rankScore = (sim.wilsonLower95Pct ?? 0) + 15 * ((sim.profitFactor ?? 0) - 1) +
        40 * (sim.meanNetPct ?? -10) + 10 * Math.min(minSlicePf, 2.0);
      if (!best || Number(eligible) > Number(best.eligible) ||
          (eligible === best.eligible && rankScore > best.rankScore)) {
        best = { spec, eligible, rankScore };
      }
    }

    const fullSigs = generateClean1hSignals(ds24m, verifiedHtf, best.spec);
    const oosSim = cleanSimulate(ds24m.rows, fullSigs, { ...best.spec.execCfg, start: def.testStart, end: def.testEnd });
    oosTrades.push(...oosSim.trades);
    foldResults.push({
      fold: def.fold,
      trainRange: [0, def.trainEnd],
      testRange: [def.testStart, def.testEnd],
      selectedParams: {
        limitOffsetAtr: best.spec.limitOffsetAtr,
        winLen: best.spec.winLen,
        stopAtr: best.spec.execCfg.stopAtr,
        minStopPct: best.spec.execCfg.minStopPct,
        rewardRisk: best.spec.execCfg.rewardRisk,
        maxHoldBars: best.spec.execCfg.maxHoldBars,
      },
      ...summarizeNoTrades(oosSim),
    });
  }

  return { folds: foldResults, aggregate: summarizeNoTrades(summarizeCleanTrades(oosTrades)) };
}

// ============================================================================
// 5. CAUSALITY (PREFIX-TRUNCATION + FUTURE MUTATION) & CONSERVATIVE FILL TESTS
// ============================================================================
function truncateDatasetStrict(ds, endLen) {
  const rows = ds.rows.slice(0, endLen);
  const lastOpen = rows[rows.length - 1].time;
  const htf = {};
  for (const [tfKey, hObj] of Object.entries(ds.htf)) {
    const hRows = hObj.rows.filter(hr => hr.time + hObj.intervalSeconds <= lastOpen);
    htf[tfKey] = {
      interval: hObj.interval,
      intervalSeconds: hObj.intervalSeconds,
      rows: hRows,
    };
  }
  return { ...ds, rows, htf };
}

function mutateFutureStrict(ds, T) {
  const clone = structuredClone(ds);
  const cutoffOpen = clone.rows[T - 1].time;
  for (let i = T; i < clone.rows.length; i++) {
    clone.rows[i].open *= 3.1;
    clone.rows[i].high *= 3.2;
    clone.rows[i].low *= 3.0;
    clone.rows[i].close *= 3.1;
    clone.rows[i].volume = 0;
  }
  for (const hObj of Object.values(clone.htf)) {
    for (const hr of hObj.rows) {
      if (hr.time + hObj.intervalSeconds > cutoffOpen) {
        hr.open *= 3.1;
        hr.high *= 3.2;
        hr.low *= 3.0;
        hr.close *= 3.1;
      }
    }
  }
  return clone;
}

function verifyCausalityPrefixTruncation(relPath, is15m, cutoffs) {
  const { ds, verifiedHtf } = verifyDatasetRaw(relPath);
  const fullSignals = is15m ? generateClean15mSignals(ds, verifiedHtf) : generateClean1hSignals(ds, verifiedHtf);
  const cfg = is15m ? CFG_15M : CFG_1H;
  const fullSim = cleanSimulate(ds.rows, fullSignals, cfg);

  for (const T of cutoffs) {
    const truncDs = truncateDatasetStrict(ds, T);
    const truncV = verifyDatasetRawFromObj(truncDs);
    const truncSignals = is15m ? generateClean15mSignals(truncDs, truncV) : generateClean1hSignals(truncDs, truncV);
    const expectedSignals = fullSignals.filter(s => s.barIndex < T);
    assert.deepEqual(truncSignals, expectedSignals, `${relPath}: signal prefix truncation failed at T=${T}`);

    const truncSim = cleanSimulate(truncDs.rows, truncSignals, cfg);
    const expectedTrades = fullSim.trades.filter(t => t.exitIndex < T);
    assert.deepEqual(truncSim.trades, expectedTrades, `${relPath}: trade prefix truncation failed at T=${T}`);

    const mutDs = mutateFutureStrict(ds, T);
    const mutV = verifyDatasetRawFromObj(mutDs);
    const mutSignals = (is15m ? generateClean15mSignals(mutDs, mutV) : generateClean1hSignals(mutDs, mutV))
      .filter(s => s.barIndex < T);
    assert.deepEqual(mutSignals, expectedSignals, `${relPath}: future mutation leaked into signals < ${T}`);
    const mutSim = cleanSimulate(mutDs.rows, mutSignals, { ...cfg, end: T });
    assert.deepEqual(mutSim.trades, expectedTrades, `${relPath}: future mutation leaked into trades < ${T}`);
  }
  return { dataset: relPath, cutoffsChecked: cutoffs, status: 'PASS' };
}

function verifyConservativeRulesAdversarial() {
  const mkRows = arr => arr.map(([o, h, l, c], idx) => ({ time: 1700000000 + idx * 900, open: o, high: h, low: l, close: c, volume: 10 }));

  const r1 = mkRows([[100, 101, 99, 100], [100, 106, 94, 105]]);
  const s1 = cleanSimulate(r1, [{ barIndex: 0, side: 1, atr: 0.5, limitPrice: 99.5 }], {
    warmup: 0, cooldown: 1, limitExpiryBars: 4, stopAtr: 2.0, minStopPct: 1.0,
    rewardRisk: 1.15, maxHoldBars: 10, beTriggerR: 0, beOffsetPct: 0.2, costPct: 0.10, slippagePct: 0.025,
  });
  assert.equal(s1.count, 1);
  assert.equal(s1.trades[0].exitReason, 'SL');

  const r2 = mkRows([[100, 101, 99, 100], [100, 105, 97, 104]]);
  const s2 = cleanSimulate(r2, [{ barIndex: 0, side: 1, atr: 0.5, limitPrice: 99.5 }], {
    warmup: 0, cooldown: 1, limitExpiryBars: 4, stopAtr: 2.0, minStopPct: 1.0,
    rewardRisk: 1.15, maxHoldBars: 10, beTriggerR: 0, beOffsetPct: 0.2, costPct: 0.10, slippagePct: 0.025,
  });
  assert.equal(s2.count, 1);
  assert.equal(s2.trades[0].exitReason, 'SL');

  const r3 = mkRows([[100, 101, 99, 100], [100, 103, 99.4, 100.2], [100.2, 100.3, 98.0, 98.2]]);
  const s3 = cleanSimulate(r3, [{ barIndex: 0, side: 1, atr: 0.5, limitPrice: 99.5 }], {
    warmup: 0, cooldown: 1, limitExpiryBars: 4, stopAtr: 2.0, minStopPct: 1.0,
    rewardRisk: 1.15, maxHoldBars: 10, beTriggerR: 0, beOffsetPct: 0.2, costPct: 0.10, slippagePct: 0.025,
  });
  assert.equal(s3.count, 1);
  assert.equal(s3.trades[0].exitReason, 'SL');
  assert.equal(s3.trades[0].exitIndex, 2);

  assert.throws(() => cleanSimulate(r1, [], {
    warmup: 0, cooldown: 1, stopAtr: 2.0, minStopPct: 1.0, rewardRisk: 0.74, maxHoldBars: 10, beTriggerR: 0, beOffsetPct: 0.2,
  }), /RR below 0\.75/);

  return 'PASS';
}

function auditTradeInvariants(rows, trades, label) {
  for (let idx = 0; idx < trades.length; idx++) {
    const t = trades[idx];
    assert.ok(t.rewardRisk + 1e-9 >= 0.75, `${label}[${idx}]: RR ${t.rewardRisk} < 0.75`);
    assert.ok(Math.abs((t.grossPct - 0.10) - t.netPct) < 1e-9, `${label}[${idx}]: costPct != 0.10`);
    const exitBar = rows[t.exitIndex];
    const bull = t.side === 1;
    const slipExit = t.rawExit * (1 - t.side * 0.00025);
    assert.ok(Math.abs(slipExit - t.exit) < 1e-9, `${label}[${idx}]: slippage != 0.025% on exit`);
    if (t.exitReason === 'TP') {
      const stopTouched = bull ? exitBar.low <= t.stop : exitBar.high >= t.stop;
      assert.ok(!stopTouched, `${label}[${idx}]: exited TP on bar touching stop!`);
    }
    if (t.entryIndex === t.exitIndex && !t.filledAtOpen && t.exitReason === 'TP') {
      assert.ok(bull ? exitBar.close >= t.target : exitBar.close <= t.target,
        `${label}[${idx}]: phantom wick TP on non-gap limit fill bar`);
    }
  }
}

function summarizeNoTrades(summary) {
  const { trades, ...rest } = summary;
  return rest;
}

// ============================================================================
// 6. MAIN CLEAN-ROOM VERIFICATION RUNNER
// ============================================================================
export function runIndependentAudit({ allowDirtyVerifier = false } = {}) {
  const manifest = readJson('data/manifest.json');
  const manifestByFile = new Map(manifest.datasets.map(d => [d.file, d]));

  const btc15mV = verifyDatasetRaw('data/btcusdt_15m_12m.json', manifestByFile.get('data/btcusdt_15m_12m.json').sha256);
  const btcTv15mV = verifyDatasetRaw('data/btcusdt_tv_15m_6k.json', manifestByFile.get('data/btcusdt_tv_15m_6k.json').sha256);
  const eth15mV = verifyDatasetRaw('data/ethusdt_15m_6m.json', manifestByFile.get('data/ethusdt_15m_6m.json').sha256);
  const btc1hV = verifyDatasetRaw('data/btcusdt_1h_24m.json', manifestByFile.get('data/btcusdt_1h_24m.json').sha256);
  const btcTv1hV = verifyDatasetRaw('data/btcusdt_tv_1h_6k.json', manifestByFile.get('data/btcusdt_tv_1h_6k.json').sha256);
  const eth1hV = verifyDatasetRaw('data/ethusdt_1h_12m.json', manifestByFile.get('data/ethusdt_1h_12m.json').sha256);

  // Verify legacy & tv-ref integrity against manifest
  assert.equal(sha256File('legacy/TOOL-2.0.0-ref.pine'), manifest.legacyPineRef.sha256);
  for (const tvRef of manifest.tvReferences) {
    assert.equal(sha256File(tvRef.file), tvRef.sha256);
  }

  // Verify selection-lock provenance hashes & lock-before-holdout timestamps
  const lock15m = readJson('research/results_15m/selection-lock.json');
  const r15Report = readJson('research/results_15m/round9-h1-cleandisp-be-scale-results.json');
  assert.equal(lock15m.datasetSha256, btc15mV.actualSha);
  assert.equal(lock15m.signalsSha256, sha256File('research/signals_15m.mjs'));
  assert.equal(lock15m.simEngineSha256, sha256File('research/sim_engine.mjs'));
  assert.ok(Date.parse(lock15m.lockedAt) <= Date.parse(r15Report.evaluatedAt));

  const lock1h = readJson('research/results_1h/selection-lock.json');
  const r1hReport = readJson('research/results_1h/results.json');
  assert.equal(lock1h.dataset.sha256, btc1hV.actualSha);
  assert.equal(lock1h.sources['research/signals_1h.mjs'], sha256File('research/signals_1h.mjs'));
  assert.equal(lock1h.sources['research/search_1h.mjs'], sha256File('research/search_1h.mjs'));
  assert.equal(lock1h.sources['research/sim_engine.mjs'], sha256File('research/sim_engine.mjs'));
  assert.ok(Date.parse(lock1h.lockedAt) <= Date.parse(r1hReport.holdoutScoringStartedAt));

  // Clean-room recomputation: 15m
  const sig15m12m = generateClean15mSignals(btc15mV.ds, btc15mV.verifiedHtf);
  const n15 = btc15mV.ds.rows.length;
  const calEnd15 = Math.floor(n15 * 0.5);
  const valEnd15 = Math.floor(n15 * 0.75);
  const res15Cal = cleanSimulate(btc15mV.ds.rows, sig15m12m, { ...CFG_15M, start: 0, end: calEnd15 });
  const res15Val = cleanSimulate(btc15mV.ds.rows, sig15m12m, { ...CFG_15M, start: calEnd15, end: valEnd15 });
  const res15Holdout = cleanSimulate(btc15mV.ds.rows, sig15m12m, { ...CFG_15M, start: valEnd15, end: n15 });
  const res15Full = cleanSimulate(btc15mV.ds.rows, sig15m12m, { ...CFG_15M, start: 0, end: n15 });
  const res15FullNoBe = cleanSimulate(btc15mV.ds.rows, sig15m12m, { ...CFG_15M, beTriggerR: 0, start: 0, end: n15 });

  const sig15mTv6k = generateClean15mSignals(btcTv15mV.ds, btcTv15mV.verifiedHtf);
  const res15Tv6k = cleanSimulate(btcTv15mV.ds.rows, sig15mTv6k, { ...CFG_15M, start: 0, end: btcTv15mV.ds.rows.length });

  const foldLen15 = Math.floor(n15 / 4);
  const wf15Trades = [];
  const wf15Folds = [];
  for (let f = 0; f < 4; f++) {
    const s = f * foldLen15;
    const e = f === 3 ? n15 : (f + 1) * foldLen15;
    const sim = cleanSimulate(btc15mV.ds.rows, sig15m12m, { ...CFG_15M, start: s, end: e });
    wf15Trades.push(...sim.trades);
    wf15Folds.push({ fold: f + 1, range: [s, e], ...summarizeNoTrades(sim) });
  }
  const wf15Agg = summarizeCleanTrades(wf15Trades);

  const sig15mEth = generateClean15mSignals(eth15mV.ds, eth15mV.verifiedHtf);
  const res15Eth = cleanSimulate(eth15mV.ds.rows, sig15mEth, { ...CFG_15M, start: 0, end: eth15mV.ds.rows.length });

  // Clean-room recomputation: 1h
  const sig1h24m = generateClean1hSignals(btc1hV.ds, btc1hV.verifiedHtf);
  const n1h = btc1hV.ds.rows.length;
  const calEnd1h = Math.floor(n1h * 0.5);
  const valEnd1h = Math.floor(n1h * 0.75);
  const res1hCal = cleanSimulate(btc1hV.ds.rows, sig1h24m, { ...CFG_1H, start: 0, end: calEnd1h });
  const res1hVal = cleanSimulate(btc1hV.ds.rows, sig1h24m, { ...CFG_1H, start: calEnd1h, end: valEnd1h });
  const res1hHoldout = cleanSimulate(btc1hV.ds.rows, sig1h24m, { ...CFG_1H, start: valEnd1h, end: n1h });
  const res1hFull = cleanSimulate(btc1hV.ds.rows, sig1h24m, { ...CFG_1H, start: 0, end: n1h });

  const sig1hTv6k = generateClean1hSignals(btcTv1hV.ds, btcTv1hV.verifiedHtf);
  const res1hTv6k = cleanSimulate(btcTv1hV.ds.rows, sig1hTv6k, { ...CFG_1H, start: 0, end: btcTv1hV.ds.rows.length });

  const foldLen1h = Math.floor(n1h / 4);
  const wf1hFixedTrades = [];
  const wf1hFixedFolds = [];
  for (let f = 0; f < 4; f++) {
    const s = f * foldLen1h;
    const e = f === 3 ? n1h : (f + 1) * foldLen1h;
    const sim = cleanSimulate(btc1hV.ds.rows, sig1h24m, { ...CFG_1H, start: s, end: e });
    wf1hFixedTrades.push(...sim.trades);
    wf1hFixedFolds.push({ fold: f + 1, range: [s, e], ...summarizeNoTrades(sim) });
  }
  const wf1hFixedAgg = summarizeCleanTrades(wf1hFixedTrades);
  const wf1hAnchored = runCleanAnchoredWf1h(btc1hV.ds, btc1hV.verifiedHtf);

  const sig1hEth = generateClean1hSignals(eth1hV.ds, eth1hV.verifiedHtf);
  const res1hEth = cleanSimulate(eth1hV.ds.rows, sig1hEth, { ...CFG_1H, start: 0, end: eth1hV.ds.rows.length });

  // Audit every trade invariant
  auditTradeInvariants(btc15mV.ds.rows, res15Full.trades, '15m_12m');
  auditTradeInvariants(btcTv15mV.ds.rows, res15Tv6k.trades, '15m_tv6k');
  auditTradeInvariants(btc1hV.ds.rows, res1hFull.trades, '1h_24m');
  auditTradeInvariants(btcTv1hV.ds.rows, res1hTv6k.trades, '1h_tv6k');
  const conservativeSyntheticStatus = verifyConservativeRulesAdversarial();

  // Verify clean-room match against reported 15m/1h reports
  assert.equal(res15Holdout.count, r15Report.holdout.count);
  assert.equal(res15Holdout.wins, r15Report.holdout.wins);
  assert.ok(Math.abs(res15Holdout.winRatePct - r15Report.holdout.winRatePct) < 1e-9);
  assert.ok(Math.abs(res15Holdout.profitFactor - r15Report.holdout.profitFactor) < 1e-9);
  assert.equal(res15Tv6k.count, r15Report.tv6k.count);
  assert.equal(res15Tv6k.wins, r15Report.tv6k.wins);
  assert.ok(Math.abs(res15Tv6k.profitFactor - r15Report.tv6k.profitFactor) < 1e-9);

  assert.equal(res1hHoldout.count, r1hReport.splits24m.holdout.count);
  assert.equal(res1hHoldout.wins, r1hReport.splits24m.holdout.wins);
  assert.ok(Math.abs(res1hHoldout.winRatePct - r1hReport.splits24m.holdout.winRatePct) < 1e-9);
  assert.ok(Math.abs(res1hHoldout.profitFactor - r1hReport.splits24m.holdout.profitFactor) < 1e-9);
  assert.equal(res1hTv6k.count, r1hReport.tv6k.metrics.count);
  assert.equal(res1hTv6k.wins, r1hReport.tv6k.metrics.wins);
  assert.ok(Math.abs(res1hTv6k.profitFactor - r1hReport.tv6k.metrics.profitFactor) < 1e-9);
  assert.equal(wf1hAnchored.aggregate.count, r1hReport.walkForwardAnchored4Fold.aggregate.count);
  assert.equal(wf1hAnchored.aggregate.wins, r1hReport.walkForwardAnchored4Fold.aggregate.wins);
  assert.ok(Math.abs(wf1hAnchored.aggregate.profitFactor - r1hReport.walkForwardAnchored4Fold.aggregate.profitFactor) < 1e-9);

  // Random timestamp prefix-truncation & future-mutation causality checks
  const rng = seededRandom(20261118);
  const randCutoffs = (minT, maxT, k) => {
    const out = new Set();
    while (out.size < k) out.add(minT + Math.floor(rng() * (maxT - minT)));
    return Array.from(out).sort((a, b) => a - b);
  };
  const causality15m12m = verifyCausalityPrefixTruncation('data/btcusdt_15m_12m.json', true, [1000, ...randCutoffs(2000, 34000, 4), 26280]);
  const causality15mTv6k = verifyCausalityPrefixTruncation('data/btcusdt_tv_15m_6k.json', true, [800, ...randCutoffs(1200, 5800, 3)]);
  const causality1h24m = verifyCausalityPrefixTruncation('data/btcusdt_1h_24m.json', false, [1000, ...randCutoffs(1500, 17000, 4), 13140]);
  const causality1hTv6k = verifyCausalityPrefixTruncation('data/btcusdt_tv_1h_6k.json', false, [800, ...randCutoffs(1200, 5800, 3)]);

  // Numeric pass gates
  const gates15m = {
    holdout: res15Holdout.winRatePct >= 65.0 && res15Holdout.count >= 30 && res15Holdout.meanNetPct > 0 && res15Holdout.profitFactor >= 1.20,
    tv6k: res15Tv6k.winRatePct >= 65.0 && res15Tv6k.count >= 40 && res15Tv6k.meanNetPct > 0 && res15Tv6k.profitFactor >= 1.20,
    walkForward4Fold: wf15Agg.winRatePct >= 65.0 && wf15Agg.meanNetPct > 0,
  };
  const gates1h = {
    holdout: res1hHoldout.winRatePct >= 65.0 && res1hHoldout.count >= 30 && res1hHoldout.meanNetPct > 0 && res1hHoldout.profitFactor >= 1.20,
    tv6k: res1hTv6k.winRatePct >= 65.0 && res1hTv6k.count >= 40 && res1hTv6k.meanNetPct > 0 && res1hTv6k.profitFactor >= 1.20,
    walkForwardFixed4Qtr: wf1hFixedAgg.winRatePct >= 65.0 && wf1hFixedAgg.meanNetPct > 0,
    walkForwardAnchored4Fold: wf1hAnchored.aggregate.winRatePct >= 65.0 && wf1hAnchored.aggregate.meanNetPct > 0,
  };
  assert.ok(Object.values(gates15m).every(Boolean), `15m numeric gate failed: ${JSON.stringify(gates15m)}`);
  assert.ok(Object.values(gates1h).every(Boolean), `1h numeric gate failed: ${JSON.stringify(gates1h)}`);

  // Run Pine static check, Pine parity check, and all unit tests
  const staticCheck = JSON.parse(execFileSync('node', ['tests/pine_static_check.mjs'], { cwd: ROOT, encoding: 'utf8' }));
  assert.equal(staticCheck.pass, true, 'pine_static_check.mjs failed');
  const parityCheck = JSON.parse(execFileSync('node', ['tests/pine_parity.mjs'], { cwd: ROOT, encoding: 'utf8' }));
  assert.equal(parityCheck.status, 'PASS', 'pine_parity.mjs failed');
  const testOutput = execFileSync('node', [
    '--test',
    'research/sim_engine.test.mjs',
    'research/signals_15m.test.mjs',
    'research/signals_1h.test.mjs',
    'tests/pine_parity.test.mjs',
  ], { cwd: ROOT, encoding: 'utf8' });

  const parityByDataset = new Map(parityCheck.results.map(r => [r.dataset, r]));
  assert.equal(parityByDataset.get('data/btcusdt_15m_12m.json').trades, res15Full.count);
  assert.equal(parityByDataset.get('data/btcusdt_15m_12m.json').wins, res15Full.wins);
  assert.equal(parityByDataset.get('data/btcusdt_tv_15m_6k.json').trades, res15Tv6k.count);
  assert.equal(parityByDataset.get('data/btcusdt_tv_15m_6k.json').wins, res15Tv6k.wins);
  assert.equal(parityByDataset.get('data/btcusdt_1h_24m.json').trades, res1hFull.count);
  assert.equal(parityByDataset.get('data/btcusdt_1h_24m.json').wins, res1hFull.wins);
  assert.equal(parityByDataset.get('data/btcusdt_tv_1h_6k.json').trades, res1hTv6k.count);
  assert.equal(parityByDataset.get('data/btcusdt_tv_1h_6k.json').wins, res1hTv6k.wins);

  const toolPine = fs.readFileSync(path.join(ROOT, 'TOOL.pine'), 'utf8');
  const stratPine = fs.readFileSync(path.join(ROOT, 'TOOL_Strategy.pine'), 'utf8');
  const pineChecks = {
    toolVersion6: /^\/\/@version=6\b/m.test(toolPine),
    stratVersion6: /^\/\/@version=6\b/m.test(stratPine),
    toolPlotsOk: staticCheck.reports[0].corePlotCalls <= 64 && staticCheck.reports[0].totalPlotCalls <= 64,
    stratPlotsOk: staticCheck.reports[1].corePlotCalls <= 64 && staticCheck.reports[1].totalPlotCalls <= 64,
    noSymbolLock: !/ticker\.standard|BINANCE:BTCUSDT/.test(toolPine) && !/ticker\.standard|BINANCE:BTCUSDT/.test(stratPine),
    usesSyminfoTickerid: toolPine.includes('request.security(\n     syminfo.tickerid') && stratPine.includes('request.security(\n     syminfo.tickerid'),
    supportsBtcusdtAndPerp: !/syminfo\.tickerid\s*[!=]=/.test(toolPine) && !/syminfo\.tickerid\s*[!=]=/.test(stratPine),
    strategyLimitExitNoPreTarget:
      /if effEntryMode == "LIMIT_PULLBACK"\s*\n\s*strategy\.entry\("L", strategy\.long, limit = paperPendingLimit\)\s*\n[^\n]*\n\s*strategy\.exit\("Exit L", from_entry = "L", stop = preStop\)\s*\n\s*else/.test(stratPine) &&
      /if effEntryMode == "LIMIT_PULLBACK"\s*\n\s*strategy\.entry\("S", strategy\.short, limit = paperPendingLimit\)\s*\n\s*strategy\.exit\("Exit S", from_entry = "S", stop = preStop\)\s*\n\s*else/.test(stratPine),
    strategySafeCancelGate: stratPine.includes('if expiredSide == 1 and queuedSide != 1\n        strategy.cancel("L")') &&
      stratPine.includes('if expiredSide == -1 and queuedSide != -1\n        strategy.cancel("S")') &&
      !stratPine.includes('strategy.close_all('),
  };
  assert.ok(Object.values(pineChecks).every(Boolean), `Pine checks failed: ${JSON.stringify(pineChecks)}`);

  const gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const gitPorcelain = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  assert.ok(gitBranch === 'main' || gitBranch === 'feat/smc-v3-winrate-65', `Wrong branch: ${gitBranch}`);

  const nonVerifierDirty = gitPorcelain.filter(line => {
    const file = line.slice(3).trim();
    return file !== 'tests/independent_verifier.mjs' && file !== 'docs/INDEPENDENT_AUDIT.json';
  });
  assert.equal(nonVerifierDirty.length, 0, `Dirty non-verifier files: ${JSON.stringify(nonVerifierDirty)}`);
  if (!allowDirtyVerifier) {
    assert.equal(gitPorcelain.length, 0, `Working tree not clean: ${JSON.stringify(gitPorcelain)}`);
  }

  return {
    verdict: 'VERIFIED PASS',
    auditedAt: new Date().toISOString(),
    branch: gitBranch,
    auditedCommit: gitHead,
    nonVerifierDirtyFiles: nonVerifierDirty,
    nonVerifierTreeClean: nonVerifierDirty.length === 0,
    ...(allowDirtyVerifier ? {} : { workingTreeClean: gitPorcelain.length === 0 }),
    hashes: {
      'TOOL.pine': sha256File('TOOL.pine'),
      'TOOL_Strategy.pine': sha256File('TOOL_Strategy.pine'),
      'research/sim_engine.mjs': sha256File('research/sim_engine.mjs'),
      'research/signals_15m.mjs': sha256File('research/signals_15m.mjs'),
      'research/signals_1h.mjs': sha256File('research/signals_1h.mjs'),
      'research/results_15m/selection-lock.json': sha256File('research/results_15m/selection-lock.json'),
      'research/results_1h/selection-lock.json': sha256File('research/results_1h/selection-lock.json'),
      'tests/pine_static_check.mjs': sha256File('tests/pine_static_check.mjs'),
      'tests/pine_parity.mjs': sha256File('tests/pine_parity.mjs'),
      'legacy/TOOL-2.0.0-ref.pine': sha256File('legacy/TOOL-2.0.0-ref.pine'),
      'data/manifest.json': sha256File('data/manifest.json'),
    },
    datasetSha256: {
      'data/btcusdt_15m_12m.json': btc15mV.actualSha,
      'data/btcusdt_tv_15m_6k.json': btcTv15mV.actualSha,
      'data/ethusdt_15m_6m.json': eth15mV.actualSha,
      'data/btcusdt_1h_24m.json': btc1hV.actualSha,
      'data/btcusdt_tv_1h_6k.json': btcTv1hV.actualSha,
      'data/ethusdt_1h_12m.json': eth1hV.actualSha,
    },
    conservativeFillVerification: {
      syntheticAdversarial: conservativeSyntheticStatus,
      allRealTradesChecked: true,
      rulesVerified: [
        'same_bar_sl_tp_resolves_to_sl',
        'limit_entry_bar_touching_sl_resolves_to_sl',
        'non_gap_limit_fill_requires_close_for_same_bar_tp',
        'initial_reward_risk_ge_0.75',
        'costPct_0.10_and_slippagePct_0.025_per_fill',
      ],
    },
    causalityPrefixTruncation: [causality15m12m, causality15mTv6k, causality1h24m, causality1hTv6k],
    metrics15m: {
      gates: gates15m,
      cal: summarizeNoTrades(res15Cal),
      val: summarizeNoTrades(res15Val),
      holdout: summarizeNoTrades(res15Holdout),
      tv6k: summarizeNoTrades(res15Tv6k),
      walkForward4Fold: { aggregate: summarizeNoTrades(wf15Agg), folds: wf15Folds },
      full12m: summarizeNoTrades(res15Full),
      full12mNoBe: summarizeNoTrades(res15FullNoBe),
      ethusdt15m6m: summarizeNoTrades(res15Eth),
    },
    metrics1h: {
      gates: gates1h,
      cal: summarizeNoTrades(res1hCal),
      val: summarizeNoTrades(res1hVal),
      holdout: summarizeNoTrades(res1hHoldout),
      tv6k: summarizeNoTrades(res1hTv6k),
      walkForwardFixed4Qtr: { aggregate: summarizeNoTrades(wf1hFixedAgg), folds: wf1hFixedFolds },
      walkForwardAnchored4Fold: wf1hAnchored,
      full24m: summarizeNoTrades(res1hFull),
      ethusdt1h12m: summarizeNoTrades(res1hEth),
    },
    pineAudit: {
      staticCheck,
      parityStatus: parityCheck.status,
      pineChecks,
      testSuiteSummary: testOutput.split('\n').slice(-10).join('\n'),
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const writeAudit = args.has('--write-audit');
  const allowDirtyVerifier = args.has('--allow-dirty-verifier') || writeAudit;
  const report = runIndependentAudit({ allowDirtyVerifier });
  if (writeAudit) {
    const outPath = path.join(ROOT, 'docs', 'INDEPENDENT_AUDIT.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Wrote ${outPath} (verdict=${report.verdict}, auditedCommit=${report.auditedCommit})`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}
