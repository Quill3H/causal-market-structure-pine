import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { simulateTrades } from '../research/sim_engine.mjs';
import {
  DEFAULT_15M_PARAMS,
  DEFAULT_15M_SIM_OPTIONS,
  calcPineAtr,
  calcPineEma,
  calcPineRsi,
  generate15mSignals,
} from '../research/signals_15m.mjs';
import { generateSignals1h } from '../research/signals_1h.mjs';
import { checkPineFiles } from './pine_static_check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const EPS_ZERO = 1e-12;

function near(a, b, relTol = 1e-10, label = 'value') {
  if (Number.isNaN(a) && Number.isNaN(b)) return;
  assert.ok(Number.isFinite(a) && Number.isFinite(b), `${label}: non-finite (${a} vs ${b})`);
  const tol = relTol * Math.max(1, Math.abs(a), Math.abs(b));
  assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} != ${b} (diff=${Math.abs(a - b)})`);
}

function calcRollingPrevHighLow(rows, length) {
  const prevHigh = new Float64Array(rows.length).fill(NaN);
  const prevLow = new Float64Array(rows.length).fill(NaN);
  for (let i = 0; i < rows.length; i++) {
    if (i < length) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - length; k < i; k++) {
      if (rows[k].high > hi) hi = rows[k].high;
      if (rows[k].low < lo) lo = rows[k].low;
    }
    prevHigh[i] = hi;
    prevLow[i] = lo;
  }
  return { prevHigh, prevLow };
}

function adverseFillPine(price, side, isEntry, slipPct) {
  return price * (1.0 + (isEntry ? side : -side) * slipPct / 100.0);
}

function resolvePaperLevelsPine(side, refEntry, atrVal, stopAtrVal, minStopPctVal, rrVal) {
  if (!(Math.abs(side) === 1 && Number.isFinite(refEntry) && refEntry > 0 &&
        Number.isFinite(atrVal) && atrVal > 0 && stopAtrVal > 0 && rrVal >= 0.75)) {
    return { ok: false, stop: NaN, target: NaN, dist: NaN };
  }
  const baseDist = atrVal * stopAtrVal;
  const minDist = minStopPctVal > 0 ? (refEntry * minStopPctVal) / 100.0 : 0.0;
  const dist = Math.max(baseDist, minDist);
  const stop = refEntry - side * dist;
  const target = refEntry + side * dist * rrVal;
  const ok = Number.isFinite(dist) && dist > 0 && Number.isFinite(stop) && stop > 0 &&
    Number.isFinite(target) && target > 0 && side * (refEntry - stop) > 0 && side * (target - refEntry) > 0;
  return { ok, stop, target, dist };
}

function paperExitConservativePine(side, entryMode, isEntryBar, filledAtOpen, beArmed, o, h, l, c, stop, target, age, maximum) {
  let price = NaN;
  let reason = 0;
  const bull = side === 1;
  if (Math.abs(side) === 1) {
    const canUseGapAndHighLowTp = entryMode === 'MARKET_NEXT_OPEN' || !isEntryBar || filledAtOpen;
    const gapStop = bull ? o <= stop : o >= stop;
    const gapTarget = canUseGapAndHighLowTp && (bull ? o >= target : o <= target);
    const hitStop = bull ? l <= stop : h >= stop;
    const hitTarget = canUseGapAndHighLowTp ? (bull ? h >= target : l <= target) : (bull ? c >= target : c <= target);
    const stopCode = beArmed ? 4 : 1;
    if (gapStop) {
      price = o;
      reason = stopCode;
    } else if (gapTarget) {
      price = target;
      reason = 2;
    } else if (hitStop) {
      price = stop;
      reason = stopCode;
    } else if (hitTarget) {
      price = target;
      reason = 2;
    } else if (age >= maximum) {
      price = c;
      reason = 3;
    }
  }
  return { price, reason };
}

/**
 * Mirrors TradingView Pine v6 execution order (unconditional top-level indicators,
 * request.security(..., lookahead_off) + timeframe.change boundary [1] latching,
 * shadow virtual ledger for 1h AdaptiveTrapPolarity, and live Paper IN/OUT state machine).
 */
export function simulatePineV6Engine(dataset, options = {}) {
  const { feePct = 0.10, slippagePct = 0.025 } = options;
  const rows = dataset.rows;
  const intervalSeconds = dataset.intervalSeconds;
  const is15mProfile = intervalSeconds <= 900;

  // Top-level LTF indicators (exact Pine v6 formulas)
  const closes = rows.map(r => r.close);
  const qualityAtr = calcPineAtr(rows, 14);
  const ltfEma20 = calcPineEma(closes, 20);
  const ltfEma50 = calcPineEma(closes, 50);
  const { prevHigh: ltfPrevHigh20, prevLow: ltfPrevLow20 } = calcRollingPrevHighLow(rows, 20);

  // HTF series computed on HTF bars (matching request.security expression evaluation)
  const v3HtfKey = is15mProfile ? '1h' : '4h';
  const htfObj = dataset.htf[v3HtfKey];
  assert.ok(htfObj && Array.isArray(htfObj.rows) && htfObj.rows.length > 0, `Missing htf["${v3HtfKey}"]`);
  const htfRows = htfObj.rows;
  const htfCloses = htfRows.map(r => r.close);
  const htfEma50 = calcPineEma(htfCloses, 50);
  const htfAtr14 = calcPineAtr(htfRows, 14);
  const htfRsi14 = calcPineRsi(htfCloses, 14);
  const { prevHigh: htfPrevHigh10, prevLow: htfPrevLow10 } = calcRollingPrevHighLow(htfRows, 10);

  const d1Obj = dataset.htf['1d'] ?? null;
  const d1Rows = d1Obj?.rows ?? null;

  // Causal request.security(lookahead_off) stream on each LTF bar:
  // At bar i, find the latest HTF bar whose open <= bar.time (or whose closeTime == next boundary)
  // and latch [1] when timeframe.change(tf) fires!
  // Note: On bar i, request.security(..., lookahead=barmerge.lookahead_off) exposes the HTF bar
  // that closed on or before bar i's close time; on the last LTF bar inside an HTF bar, raw[1]
  // at the NEXT bar (when timeframe.change fires) equals the just-completed HTF bar.
  const findClosedHtfBeforeOrAtClose = (hRows, hSec, ltfOpen, ltfClose) => {
    let idx = -1;
    // Closed HTF bar as of bar close time (ltfClose) matches TV historical bar behavior where
    // the closing sub-bar sees the completing HTF bar and timeframe.change latches [1] at next open.
    for (let j = 0; j < hRows.length; j++) {
      if (hRows[j].time + hSec <= ltfClose) idx = j;
      else if (hRows[j].time > ltfOpen) break;
    }
    return idx;
  };

  let latchedH1 = null;
  let latchedH4 = null;
  let latchedD1 = null;
  const h4PrevLowSeries = new Float64Array(rows.length).fill(NaN);
  const h4PrevHighSeries = new Float64Array(rows.length).fill(NaN);
  const d1LowSeries = new Float64Array(rows.length).fill(NaN);
  const d1HighSeries = new Float64Array(rows.length).fill(NaN);

  // Track raw security snapshots across bars to mirror [1] latching at timeframe.change()
  let prevRawHtfIdx = -1;
  let prevRawD1Idx = -1;

  // Shadow virtual ledger state (1h)
  let vSide = 0;
  let vPendingSide = 0;
  let vPendingAtr = NaN;
  let vPendingLimit = NaN;
  let vPendingExpiryBar = NaN;
  let vLastAccepted = -Infinity;
  let vEntryBar = NaN;
  let vFilledAtOpen = false;
  let vEntry = NaN;
  let vStop = NaN;
  let vTarget = NaN;
  let vInitialDist = NaN;
  let vBeArmed = false;
  const vLongSlHist = [];
  const vLongNetHist = [];
  const vShortSlHist = [];
  const vShortNetHist = [];

  // Live Paper IN/OUT state
  const effEntryMode = 'LIMIT_PULLBACK';
  const effExpiryBars = 6;
  const effStopAtr = is15mProfile ? 3.0 : 3.2;
  const effMinStopPct = is15mProfile ? 1.0 : 1.4;
  const effRewardRisk = 1.15;
  const effMaxHoldBars = is15mProfile ? 120 : 96;
  const effCooldown = is15mProfile ? 8 : 4;
  const effBeTriggerR = 0.43;
  const effBeOffsetPct = is15mProfile ? 0.28 : 0.34;

  let paperSide = 0;
  let paperPendingSide = 0;
  let paperPendingAtr = NaN;
  let paperPendingLimit = NaN;
  let paperPendingExpiryBar = NaN;
  let paperSignalBar = NaN;
  let paperEntryBar = NaN;
  let paperFilledAtOpen = false;
  let lastPaperSignal = -Infinity;
  let paperEntry = NaN;
  let paperStop = NaN;
  let paperInitialStop = NaN;
  let paperTarget = NaN;
  let paperInitialDist = NaN;
  let paperBeArmed = false;

  let paperWins = 0;
  let paperLosses = 0;
  let paperTies = 0;
  let paperGains = 0;
  let paperLossSum = 0;
  let paperTotalNet = 0;

  const barStates = [];
  const signals = [];
  const trades = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const hSec = htfObj.intervalSeconds;

    // Mirror request.security + timeframe.change boundary [1] latching
    const htfBoundary = i > 0 && Math.floor(r.time / hSec) !== Math.floor(rows[i - 1].time / hSec);
    if (htfBoundary && prevRawHtfIdx >= 0 && htfRows[prevRawHtfIdx].time + hSec <= r.time) {
      const j = prevRawHtfIdx;
      latchedH1 = {
        open: htfRows[j].open,
        high: htfRows[j].high,
        low: htfRows[j].low,
        close: htfRows[j].close,
        ema50: htfEma50[j],
        atr14: htfAtr14[j],
        rsi14: htfRsi14[j],
      };
      latchedH4 = {
        close: htfRows[j].close,
        ema50: htfEma50[j],
        prevHigh10: htfPrevHigh10[j],
        prevLow10: htfPrevLow10[j],
      };
      assert.equal(j, htfObj.alignedIndex[i], `Pine HTF latch mismatch vs alignedIndex at bar ${i}`);
    }
    if (latchedH4) {
      h4PrevLowSeries[i] = latchedH4.prevLow10;
      h4PrevHighSeries[i] = latchedH4.prevHigh10;
    }

    if (d1Rows) {
      const dSec = d1Obj.intervalSeconds;
      const d1Boundary = i > 0 && Math.floor(r.time / dSec) !== Math.floor(rows[i - 1].time / dSec);
      if (d1Boundary && prevRawD1Idx >= 0 && d1Rows[prevRawD1Idx].time + dSec <= r.time) {
        const jD = prevRawD1Idx;
        latchedD1 = { high: d1Rows[jD].high, low: d1Rows[jD].low };
        assert.equal(jD, d1Obj.alignedIndex[i], `Pine 1D latch mismatch vs alignedIndex at bar ${i}`);
      }
      if (latchedD1) {
        d1LowSeries[i] = latchedD1.low;
        d1HighSeries[i] = latchedD1.high;
      }
    }

    // Update raw security snapshot at close of bar i (available as [1] on bar i+1)
    prevRawHtfIdx = findClosedHtfBeforeOrAtClose(htfRows, hSec, r.time, r.time + intervalSeconds);
    if (d1Rows) {
      prevRawD1Idx = findClosedHtfBeforeOrAtClose(d1Rows, d1Obj.intervalSeconds, r.time, r.time + intervalSeconds);
    }

    // 15m Engine: H1_CleanDisp_AtrExh
    let v3_15m_side = 0;
    let v3_15m_limit = NaN;
    const atr = qualityAtr[i];
    const ema50 = ltfEma50[i];
    const ema20 = ltfEma20[i];
    if (is15mProfile && i >= 250 && Number.isFinite(atr) && atr > 0 && Number.isFinite(ema50) &&
        latchedH1 && Number.isFinite(latchedH1.atr14) && latchedH1.atr14 > 0 && Number.isFinite(latchedH1.ema50)) {
      const atrPct = (atr / r.close) * 100.0;
      const h1Range = latchedH1.high - latchedH1.low;
      if (atrPct >= 0.18 && h1Range > 0) {
        const h1Bull = (latchedH1.close - latchedH1.open) >= 1.0 * latchedH1.atr14 &&
          (latchedH1.close - latchedH1.low) / h1Range >= 0.65 &&
          latchedH1.close > latchedH1.ema50 && r.close > ema50;
        const h1Bear = (latchedH1.open - latchedH1.close) >= 1.0 * latchedH1.atr14 &&
          (latchedH1.high - latchedH1.close) / h1Range >= 0.65 &&
          latchedH1.close < latchedH1.ema50 && r.close < ema50;
        let cand15 = h1Bull && !h1Bear ? 1 : h1Bear && !h1Bull ? -1 : 0;
        if (cand15 !== 0 && Number.isFinite(latchedH1.rsi14) && Number.isFinite(ema20)) {
          const dirH1Rsi = cand15 === 1 ? latchedH1.rsi14 : 100.0 - latchedH1.rsi14;
          const ltfEmaDistAtr = (cand15 * (r.close - ema20)) / atr;
          if (dirH1Rsi >= 72.0 && ltfEmaDistAtr > 1.8) {
            cand15 = 0;
          }
        }
        if (cand15 !== 0) {
          const lim15 = r.close - cand15 * 0.55 * atr;
          if (lim15 > 0) {
            v3_15m_side = cand15;
            v3_15m_limit = lim15;
          }
        }
      }
    }

    // 1h Engine: HtfSmcMultiTrap + Virtual Shadow Ledger (AdaptiveTrapPolarity)
    let v3_1h_rawSide = 0;
    let v3_1h_rawLimit = NaN;
    if (!is15mProfile && i >= 250 && Number.isFinite(atr) && atr > 0 && latchedH4 && Number.isFinite(latchedH4.ema50)) {
      const htfBull = latchedH4.close > latchedH4.ema50;
      const htfBear = latchedH4.close < latchedH4.ema50;
      let b1h = false;
      let s1h = false;
      let b4h = false;
      let s4h = false;
      let bPd = false;
      let sPd = false;

      for (let k = 1; k <= 4; k++) {
        const lvL1 = ltfPrevLow20[i - k];
        const lvH1 = ltfPrevHigh20[i - k];
        if (Number.isFinite(lvL1) && Number.isFinite(lvH1)) {
          let allB1 = true;
          let allA1 = true;
          for (let m = 1; m <= k; m++) {
            if (!(rows[i - m].close < lvL1)) allB1 = false;
            if (!(rows[i - m].close > lvH1)) allA1 = false;
          }
          if (allB1 && r.close > lvL1 && r.close > r.open) b1h = true;
          if (allA1 && r.close < lvH1 && r.close < r.open) s1h = true;
        }

        const lvL4 = h4PrevLowSeries[i - k];
        const lvH4 = h4PrevHighSeries[i - k];
        if (Number.isFinite(lvL4) && Number.isFinite(lvH4)) {
          let allB4 = true;
          let allA4 = true;
          for (let m = 1; m <= k; m++) {
            if (!(rows[i - m].close < lvL4)) allB4 = false;
            if (!(rows[i - m].close > lvH4)) allA4 = false;
          }
          if (allB4 && r.close > lvL4 && r.close > r.open) b4h = true;
          if (allA4 && r.close < lvH4 && r.close < r.open) s4h = true;
        }

        if (k <= 2 && d1Rows) {
          const lvLD = d1LowSeries[i - k];
          const lvHD = d1HighSeries[i - k];
          if (Number.isFinite(lvLD) && Number.isFinite(lvHD)) {
            let allBD = true;
            let allAD = true;
            for (let m = 1; m <= k; m++) {
              if (!(rows[i - m].close < lvLD)) allBD = false;
              if (!(rows[i - m].close > lvHD)) allAD = false;
            }
            if (allBD && r.close > lvLD && r.close > r.open) bPd = true;
            if (allAD && r.close < lvHD && r.close < r.open) sPd = true;
          }
        }
      }

      const rawBull = (b1h || b4h || bPd) && htfBull;
      const rawBear = (s1h || s4h || sPd) && htfBear;
      if (rawBull !== rawBear) {
        const rSide = rawBull ? 1 : -1;
        const rLim = r.close - rSide * 0.18 * atr;
        if (rLim > 0) {
          v3_1h_rawSide = rSide;
          v3_1h_rawLimit = rLim;
        }
      }
    }

    // Shadow virtual ledger (1h)
    let v3_1h_side = 0;
    let v3_1h_limit = NaN;
    if (!is15mProfile) {
      if (vSide === 0 && vPendingSide !== 0) {
        const vBullPend = vPendingSide === 1;
        const vTouched = vBullPend ? r.low <= vPendingLimit : r.high >= vPendingLimit;
        if (vTouched) {
          const vFillAtOpen = vBullPend ? r.open <= vPendingLimit : r.open >= vPendingLimit;
          const vRawFill = vBullPend ? Math.min(r.open, vPendingLimit) : Math.max(r.open, vPendingLimit);
          const vFill = adverseFillPine(vRawFill, vPendingSide, true, 0.025);
          const lvl = resolvePaperLevelsPine(vPendingSide, vFill, vPendingAtr, 3.2, 1.4, 1.15);
          if (lvl.ok) {
            vSide = vPendingSide;
            vEntry = vFill;
            vStop = lvl.stop;
            vTarget = lvl.target;
            vInitialDist = lvl.dist;
            vEntryBar = i;
            vFilledAtOpen = vFillAtOpen;
            vBeArmed = false;
          }
          vPendingSide = 0;
          vPendingAtr = NaN;
          vPendingLimit = NaN;
          vPendingExpiryBar = NaN;
        } else if (i >= vPendingExpiryBar) {
          vPendingSide = 0;
          vPendingAtr = NaN;
          vPendingLimit = NaN;
          vPendingExpiryBar = NaN;
        }
      }

      if (vSide !== 0) {
        const ex = paperExitConservativePine(
          vSide, 'LIMIT_PULLBACK', i === vEntryBar, vFilledAtOpen, vBeArmed,
          r.open, r.high, r.low, r.close, vStop, vTarget, i - vEntryBar + 1, 96,
        );
        if (ex.reason !== 0) {
          const vOutPrice = adverseFillPine(ex.price, vSide, false, 0.025);
          let vNet = (vSide * (vOutPrice - vEntry)) / vEntry * 100.0 - 0.10;
          if (Math.abs(vNet) < EPS_ZERO) vNet = 0.0;
          const isPureSl = ex.reason === 1 && !vBeArmed;
          const slArr = vSide === 1 ? vLongSlHist : vShortSlHist;
          const netArr = vSide === 1 ? vLongNetHist : vShortNetHist;
          slArr.push(isPureSl ? 1 : 0);
          netArr.push(vNet);
          if (slArr.length > 6) slArr.shift();
          if (netArr.length > 6) netArr.shift();
          vSide = 0;
        }
      }

      if (vSide !== 0 && !vBeArmed) {
        if (vSide * (r.close - vEntry) >= 0.43 * vInitialDist) {
          const vRaisedStop = vEntry * (1.0 + (vSide * 0.34) / 100.0);
          if (vSide * (vRaisedStop - vStop) > 0 && vSide * (vTarget - vRaisedStop) > 0) {
            vStop = vRaisedStop;
            vBeArmed = true;
          }
        }
      }

      if (v3_1h_rawSide !== 0) {
        const slArr = v3_1h_rawSide === 1 ? vLongSlHist : vShortSlHist;
        const netArr = v3_1h_rawSide === 1 ? vLongNetHist : vShortNetHist;
        let slCount = 0;
        let netSum = 0;
        for (let q = 0; q < slArr.length; q++) {
          slCount += slArr[q];
          netSum += netArr[q];
        }
        const shouldFlip = slArr.length >= 2 && slCount >= 2 && netSum < 0.0;
        const adaptSide = shouldFlip ? -v3_1h_rawSide : v3_1h_rawSide;
        const adaptLimit = r.close - adaptSide * 0.18 * atr;
        if (adaptLimit > 0) {
          v3_1h_side = adaptSide;
          v3_1h_limit = adaptLimit;
        }
      }

      if (vSide === 0 && vPendingSide === 0 && v3_1h_rawSide !== 0 && i >= 250 && i - vLastAccepted >= 4) {
        const pre = resolvePaperLevelsPine(v3_1h_rawSide, v3_1h_rawLimit, atr, 3.2, 1.4, 1.15);
        if (pre.ok) {
          vPendingSide = v3_1h_rawSide;
          vPendingAtr = atr;
          vPendingLimit = v3_1h_rawLimit;
          vPendingExpiryBar = i + 6;
          vLastAccepted = i;
        }
      }
    }

    const candSide = is15mProfile ? v3_15m_side : v3_1h_side;
    const candLimit = is15mProfile ? v3_15m_limit : v3_1h_limit;
    if (candSide !== 0) {
      signals.push({
        barIndex: i,
        side: candSide,
        atr,
        limitPrice: candLimit,
      });
    }

    // Live Paper IN / OUT state machine (matching TOOL.pine lines 1605-1719)
    let paperInLong = false;
    let paperInShort = false;
    let paperOutReason = 0;
    let paperInPrice = NaN;
    let paperOutPrice = NaN;
    let paperClosedNet = NaN;
    let paperClosedSide = 0;
    let paperClosedEntry = NaN;

    if (paperSide === 0 && paperPendingSide !== 0) {
      const bullPend = paperPendingSide === 1;
      const touched = bullPend ? r.low <= paperPendingLimit : r.high >= paperPendingLimit;
      if (touched) {
        const fillAtOpen = bullPend ? r.open <= paperPendingLimit : r.open >= paperPendingLimit;
        const rawFill = bullPend ? Math.min(r.open, paperPendingLimit) : Math.max(r.open, paperPendingLimit);
        const fill = adverseFillPine(rawFill, paperPendingSide, true, slippagePct);
        const lvl = resolvePaperLevelsPine(paperPendingSide, fill, paperPendingAtr, effStopAtr, effMinStopPct, effRewardRisk);
        if (lvl.ok) {
          paperSide = paperPendingSide;
          paperEntry = fill;
          paperStop = lvl.stop;
          paperInitialStop = lvl.stop;
          paperTarget = lvl.target;
          paperInitialDist = lvl.dist;
          paperEntryBar = i;
          paperFilledAtOpen = fillAtOpen;
          paperBeArmed = false;
          paperInLong = paperSide === 1;
          paperInShort = paperSide === -1;
          paperInPrice = fill;
        }
        paperPendingSide = 0;
        paperPendingAtr = NaN;
        paperPendingLimit = NaN;
        paperPendingExpiryBar = NaN;
      } else if (i >= paperPendingExpiryBar) {
        paperPendingSide = 0;
        paperPendingAtr = NaN;
        paperPendingLimit = NaN;
        paperPendingExpiryBar = NaN;
      }
    }

    if (paperSide !== 0) {
      const ex = paperExitConservativePine(
        paperSide, effEntryMode, i === paperEntryBar, paperFilledAtOpen, paperBeArmed,
        r.open, r.high, r.low, r.close, paperStop, paperTarget, i - paperEntryBar + 1, effMaxHoldBars,
      );
      if (ex.reason !== 0) {
        paperOutPrice = adverseFillPine(ex.price, paperSide, false, slippagePct);
        const grossPct = (paperSide * (paperOutPrice - paperEntry)) / paperEntry * 100.0;
        paperClosedNet = grossPct - feePct;
        paperClosedNet = Math.abs(paperClosedNet) < EPS_ZERO ? 0.0 : paperClosedNet;
        paperOutReason = ex.reason;
        paperClosedSide = paperSide;
        paperClosedEntry = paperEntry;
        if (paperClosedNet > EPS_ZERO) {
          paperWins++;
          paperGains += paperClosedNet;
        } else if (paperClosedNet < -EPS_ZERO) {
          paperLosses++;
          paperLossSum -= paperClosedNet;
        } else {
          paperTies++;
        }
        paperTotalNet += paperClosedNet;
        const reasonStr = ['', 'SL', 'TP', 'TIME', 'BE'][paperOutReason];
        trades.push({
          signalIndex: paperSignalBar,
          entryIndex: paperEntryBar,
          exitIndex: i,
          side: paperSide,
          entry: paperEntry,
          stop: paperStop,
          initialStop: paperInitialStop,
          target: paperTarget,
          beArmed: paperBeArmed,
          exit: paperOutPrice,
          exitReason: reasonStr,
          grossPct,
          netPct: paperClosedNet,
        });
        paperSide = 0;
      }
    }

    if (paperSide !== 0 && effBeTriggerR > 0 && !paperBeArmed) {
      if (paperSide * (r.close - paperEntry) >= effBeTriggerR * paperInitialDist) {
        const raisedStop = paperEntry * (1.0 + (paperSide * effBeOffsetPct) / 100.0);
        if (paperSide * (raisedStop - paperStop) > 0 && paperSide * (paperTarget - raisedStop) > 0) {
          paperStop = raisedStop;
          paperBeArmed = true;
        }
      }
    }

    if (paperSide === 0 && paperPendingSide === 0 && candSide !== 0 && i >= 250 && i - lastPaperSignal >= effCooldown) {
      const pre = resolvePaperLevelsPine(candSide, candLimit, atr, effStopAtr, effMinStopPct, effRewardRisk);
      if (pre.ok) {
        paperPendingSide = candSide;
        paperPendingAtr = atr;
        paperPendingLimit = candLimit;
        paperSignalBar = i;
        paperPendingExpiryBar = i + effExpiryBars;
        lastPaperSignal = i;
      }
    }

    barStates.push({
      barIndex: i,
      time: r.time,
      rawSide: is15mProfile ? v3_15m_side : v3_1h_rawSide,
      candSide,
      candLimit,
      paperPendingSide,
      paperSide,
      paperStop,
      paperTarget,
      paperBeArmed,
      paperInLong,
      paperInShort,
      paperInPrice,
      paperOutReason,
      paperOutPrice,
      paperClosedNet,
      paperClosedSide,
      paperClosedEntry,
      paperWins,
      paperLosses,
      paperTies,
      paperPF: paperLossSum > 0 ? paperGains / paperLossSum : NaN,
      paperTotalNet,
    });
  }

  return {
    signals,
    trades,
    barStates,
    wins: paperWins,
    losses: paperLosses,
    ties: paperTies,
    count: trades.length,
    winRatePct: trades.length ? (paperWins / trades.length) * 100 : null,
    totalNetPct: paperTotalNet,
    profitFactor: paperLossSum > 0 ? paperGains / paperLossSum : null,
  };
}

export function verifyPineSourcesMatchSpec() {
  const toolPine = fs.readFileSync(path.join(ROOT, 'TOOL.pine'), 'utf8');
  const stratPine = fs.readFileSync(path.join(ROOT, 'TOOL_Strategy.pine'), 'utf8');

  const staticCheck = checkPineFiles([
    path.join(ROOT, 'TOOL.pine'),
    path.join(ROOT, 'TOOL_Strategy.pine'),
  ]);
  assert.equal(staticCheck.pass, true, `Static check failed: ${JSON.stringify(staticCheck, null, 2)}`);

  const requiredLiterals = [
    'SMC High-WinRate [v3.0]',
    'timeframe.in_seconds()',
    'chartSeconds <= 900',
    'atrPct >= 0.18',
    '1.0 * h1Atr14',
    '>= 0.65',
    'dirH1Rsi >= 72.0 and ltfEmaDistAtr > 1.8',
    '0.55 * qualityAtr',
    '0.18 * qualityAtr',
    'is15mProfile ? 3.0 : 3.2',
    'is15mProfile ? 1.0 : 1.4',
    'is15mProfile ? 120 : 96',
    'is15mProfile ? 8 : 4',
    'is15mProfile ? 0.28 : 0.34',
    'effBeTriggerR  = applyV3Auto ? 0.43',
    'effRewardRisk  = applyV3Auto ? 1.15',
    'effExpiryBars  = applyV3Auto ? 6',
    'paperExitConservative(',
    'resolvePaperLevels(',
    'adaptivePolarityFlip(',
    'recordShadowOutcome(',
    'V3_SHADOW_FEE_PCT = 0.10',
    'V3_SHADOW_SLIP_PCT = 0.025',
  ];

  for (const snippet of requiredLiterals) {
    assert.ok(toolPine.includes(snippet), `TOOL.pine missing required v3 spec snippet: ${snippet}`);
    assert.ok(stratPine.includes(snippet), `TOOL_Strategy.pine missing required v3 spec snippet: ${snippet}`);
  }

  // Verify shared pure execution/signal helper functions are byte-identical between TOOL.pine and TOOL_Strategy.pine
  const extractFn = (src, sig) => {
    const start = src.indexOf(sig);
    assert.ok(start >= 0, `Missing ${sig}`);
    const rest = src.slice(start);
    const endMatch = rest.match(/\n(?=[A-Za-z_])/);
    return endMatch ? rest.slice(0, endMatch.index) : rest;
  };
  for (const fnSig of [
    'adverseFill(',
    'resolvePaperLevels(',
    'paperExitConservative(',
    'recordShadowOutcome(',
    'adaptivePolarityFlip(',
  ]) {
    assert.equal(
      extractFn(toolPine, fnSig),
      extractFn(stratPine, fnSig),
      `Helper ${fnSig} differs between TOOL.pine and TOOL_Strategy.pine`,
    );
  }

  // Verify Strategy Tester order-sync invariants in TOOL_Strategy.pine:
  // 1) LIMIT_PULLBACK signal-bar exit attaches stop=preStop only (no premature limit=preTarget on fill bar).
  assert.ok(stratPine.includes('strategy.exit("Exit L", from_entry = "L", stop = preStop)'));
  assert.ok(stratPine.includes('strategy.exit("Exit S", from_entry = "S", stop = preStop)'));
  // 2) Expired order cancellation never cancels a same-bar replacement entry on the same ID.
  assert.ok(stratPine.includes('if expiredSide == 1 and queuedSide != 1\n        strategy.cancel("L")'));
  assert.ok(stratPine.includes('if expiredSide == -1 and queuedSide != -1\n        strategy.cancel("S")'));
  // 3) No blanket strategy.close_all() that could wipe a same-bar pending order.
  assert.ok(!stratPine.includes('strategy.close_all('));

  return staticCheck;
}

export function verifyDatasetParity(relDataPath) {
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, relDataPath), 'utf8'));
  const pineSim = simulatePineV6Engine(dataset);
  const is15m = dataset.intervalSeconds <= 900;

  let refSignals;
  let refSimOptions;

  if (is15m) {
    refSignals = generate15mSignals(dataset, DEFAULT_15M_PARAMS);
    refSimOptions = { ...DEFAULT_15M_SIM_OPTIONS, intervalSeconds: dataset.intervalSeconds };
  } else {
    const refSpec = {
      specId: 'AdaptiveTrapPolarity:Multi:P4_10:N20:K4:pd1:H4_50:off0.18:w6_sl2_neg_ps|s3.2|m1.4|rr1.15|h96|be0.43_0.34|cd4',
      family: 'AdaptiveTrapPolarity',
      baseFamily: 'HtfSmcMultiTrap',
      lookback: 20,
      trapMaxBars: 4,
      p4Lookback: 10,
      includePdhl: true,
      htfMode: 'H4_50',
      limitOffsetAtr: 0.18,
      maxD1Atr: null,
      maxH4Cross30: null,
      requireH4Slope20: false,
      d1Er10Min: null,
      winLen: 6,
      slThresh: 2,
      requireNegNet: true,
      sharedHistory: false,
      virtExec: {
        entryMode: 'LIMIT_PULLBACK',
        limitExpiryBars: 6,
        pendingPolicy: 'ignore',
        limitSameBarTp: 'close',
        cooldown: 4,
        warmup: 250,
        stopAtr: 3.2,
        minStopPct: 1.4,
        rewardRisk: 1.15,
        maxHoldBars: 96,
        beTriggerR: 0.43,
        beOffsetPct: 0.34,
        costPct: 0.1,
        slippagePct: 0.025,
      },
    };
    refSignals = generateSignals1h(dataset, refSpec);
    refSimOptions = { ...refSpec.virtExec, intervalSeconds: dataset.intervalSeconds };
  }

  // 1. Signal-by-signal parity
  assert.equal(pineSim.signals.length, refSignals.length, `${relDataPath}: signal count mismatch`);
  for (let i = 0; i < refSignals.length; i++) {
    const a = pineSim.signals[i];
    const b = refSignals[i];
    assert.equal(a.barIndex, b.barIndex, `${relDataPath}: signal[${i}].barIndex`);
    assert.equal(a.side, b.side, `${relDataPath}: signal[${i}].side`);
    near(a.atr, b.atr, 1e-12, `${relDataPath}: signal[${i}].atr`);
    near(a.limitPrice, b.limitPrice, 1e-12, `${relDataPath}: signal[${i}].limitPrice`);
  }

  // 2. Trade-by-trade parity against sim_engine.mjs
  const refSim = simulateTrades(dataset.rows, refSignals, refSimOptions);
  assert.equal(pineSim.trades.length, refSim.trades.length, `${relDataPath}: trade count mismatch`);
  assert.equal(pineSim.wins, refSim.wins, `${relDataPath}: wins mismatch`);
  assert.equal(pineSim.losses, refSim.losses, `${relDataPath}: losses mismatch`);
  assert.equal(pineSim.ties, refSim.ties, `${relDataPath}: ties mismatch`);
  near(pineSim.totalNetPct, refSim.totalNetPct, 1e-10, `${relDataPath}: totalNetPct`);
  if (refSim.profitFactor !== null) {
    near(pineSim.profitFactor, refSim.profitFactor, 1e-10, `${relDataPath}: profitFactor`);
  }

  for (let i = 0; i < refSim.trades.length; i++) {
    const a = pineSim.trades[i];
    const b = refSim.trades[i];
    for (const k of ['signalIndex', 'entryIndex', 'exitIndex', 'side', 'exitReason', 'beArmed']) {
      assert.equal(a[k], b[k], `${relDataPath}: trade[${i}].${k}`);
    }
    for (const k of ['entry', 'stop', 'initialStop', 'target', 'exit', 'grossPct', 'netPct']) {
      near(a[k], b[k], 1e-12, `${relDataPath}: trade[${i}].${k}`);
    }
  }

  // 3. Bar-by-bar ledger consistency check across all bars
  const entryMap = new Map(refSim.trades.map(t => [t.entryIndex, t]));
  const exitMap = new Map(refSim.trades.map(t => [t.exitIndex, t]));
  const sigMap = new Map(refSignals.map(s => [s.barIndex, s]));
  for (let i = 0; i < dataset.rows.length; i++) {
    const st = pineSim.barStates[i];
    const s = sigMap.get(i);
    assert.equal(st.candSide, s ? s.side : 0, `${relDataPath}: bar[${i}].candSide`);
    const ent = entryMap.get(i);
    if (ent) {
      assert.equal(st.paperInLong, ent.side === 1, `${relDataPath}: bar[${i}].paperInLong`);
      assert.equal(st.paperInShort, ent.side === -1, `${relDataPath}: bar[${i}].paperInShort`);
      near(st.paperInPrice, ent.entry, 1e-12, `${relDataPath}: bar[${i}].paperInPrice`);
    }
    const ex = exitMap.get(i);
    if (ex) {
      const code = { SL: 1, TP: 2, TIME: 3, BE: 4 }[ex.exitReason];
      assert.equal(st.paperOutReason, code, `${relDataPath}: bar[${i}].paperOutReason`);
      near(st.paperOutPrice, ex.exit, 1e-12, `${relDataPath}: bar[${i}].paperOutPrice`);
      near(st.paperClosedNet, ex.netPct, 1e-12, `${relDataPath}: bar[${i}].paperClosedNet`);
    } else {
      assert.equal(st.paperOutReason, 0, `${relDataPath}: bar[${i}].paperOutReason expected 0`);
    }
  }

  return {
    dataset: relDataPath,
    intervalSeconds: dataset.intervalSeconds,
    rows: dataset.rows.length,
    signals: refSignals.length,
    trades: refSim.count,
    wins: refSim.wins,
    losses: refSim.losses,
    ties: refSim.ties,
    winRatePct: Number((refSim.winRatePct ?? 0).toFixed(4)),
    profitFactor: refSim.profitFactor !== null ? Number(refSim.profitFactor.toFixed(4)) : null,
    totalNetPct: Number(refSim.totalNetPct.toFixed(4)),
    meanNetPct: Number((refSim.meanNetPct ?? 0).toFixed(4)),
    parity: '100%_BAR_AND_TRADE_MATCH',
  };
}

export function runAllPineParityChecks() {
  const staticCheck = verifyPineSourcesMatchSpec();
  const datasets = [
    'data/btcusdt_15m_12m.json',
    'data/btcusdt_tv_15m_6k.json',
    'data/ethusdt_15m_6m.json',
    'data/btcusdt_1h_24m.json',
    'data/btcusdt_tv_1h_6k.json',
    'data/ethusdt_1h_12m.json',
  ];
  const results = datasets.map(verifyDatasetParity);
  return {
    status: 'PASS',
    staticCheck: staticCheck.reports.map(r => ({
      file: r.file,
      declaration: r.declaration,
      corePlotCalls: r.corePlotCalls,
      requestSecurityCalls: r.requestSecurityCalls,
      pass: r.pass,
    })),
    results,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const summary = runAllPineParityChecks();
  console.log(JSON.stringify(summary, null, 2));
}
