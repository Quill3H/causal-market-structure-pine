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
import { generateSignals15mV4 } from '../research/signals_15m_v4.mjs';
import { generateSignals1hV4 } from '../research/signals_1h_v4.mjs';
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

function calcPosLevPine(useVolNorm, riskPct, minLev, maxLev, fixedLev, entryPrice, dist) {
  const stopDistPct = Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(dist) && dist > 0
    ? (dist / entryPrice) * 100.0
    : NaN;
  return useVolNorm && Number.isFinite(stopDistPct) && stopDistPct > 0
    ? Math.max(minLev, Math.min(maxLev, riskPct / stopDistPct))
    : fixedLev;
}

/**
 * Mirrors TradingView Pine v6 execution order (unconditional top-level indicators,
 * request.security(..., lookahead_off) + timeframe.change boundary [1] latching,
 * shadow virtual ledger for 1h AdaptiveTrapPolarity, and live Paper IN/OUT state machine).
 */
export function simulatePineV6Engine(dataset, options = {}) {
  const {
    feePct = 0.10,
    slippagePct = 0.025,
    engine15mProfile = 'v4.0 H4-Close-Disp [3Y OKX]',
    engine1hProfile = 'v3.0 Adaptive-MultiTrap [All-Weather]',
    paperUseAutoPreset = true,
    customRewardRisk = null,
    paperSizingMode = 'VolNorm [v4.1 Auto]',
    paperRiskPct = 4.5,
    paperMinLev = 1.5,
    paperMaxLev = 2.8,
    paperLeverageRef = 2.0,
    paperTp1QtyPct = 0.0,
    paperTp1TriggerR = 0.95,
    paperTp1LockR = 0.65,
  } = options;
  const rows = dataset.rows;
  const intervalSeconds = dataset.intervalSeconds;
  const is15mProfile = intervalSeconds <= 900;
  const useV4_15m = engine15mProfile === 'v4.0 H4-Close-Disp [3Y OKX]';
  const useV4_1h = engine1hProfile === 'v4.0 H4-Disp Trend [High-Return 1x]';

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

  // Auxiliary HTF feed ("240" for <=15m v4.0, "1D" for 1h v3.0 MultiTrap)
  const auxKey = is15mProfile ? '4h' : '1d';
  const auxObj = dataset.htf[auxKey] ?? null;
  if (is15mProfile && useV4_15m) {
    assert.ok(auxObj && Array.isArray(auxObj.rows) && auxObj.rows.length > 0, 'Missing htf["4h"] for 15m v4.0');
  }
  const auxRows = auxObj?.rows ?? null;
  const auxCloses = auxRows ? auxRows.map(r => r.close) : null;
  const auxEma50 = auxRows ? calcPineEma(auxCloses, 50) : null;
  const auxAtr14 = auxRows ? calcPineAtr(auxRows, 14) : null;

  const findClosedHtfBeforeOrAtClose = (hRows, hSec, ltfOpen, ltfClose) => {
    let idx = -1;
    for (let j = 0; j < hRows.length; j++) {
      if (hRows[j].time + hSec <= ltfClose) idx = j;
      else if (hRows[j].time > ltfOpen) break;
    }
    return idx;
  };

  let latchedH1 = null;
  let latchedH4 = null;
  let latchedM15H4 = null;
  let latchedD1 = null;
  const h4PrevLowSeries = new Float64Array(rows.length).fill(NaN);
  const h4PrevHighSeries = new Float64Array(rows.length).fill(NaN);
  const d1LowSeries = new Float64Array(rows.length).fill(NaN);
  const d1HighSeries = new Float64Array(rows.length).fill(NaN);

  let prevRawHtfIdx = -1;
  let prevRawAuxIdx = -1;

  // Unified profile execution config matching TOOL.pine v4.0.0
  const vPullAtrCfg = is15mProfile ? 0.35 : (useV4_1h ? 0.15 : 0.18);
  const vStopAtrCfg = is15mProfile ? (useV4_15m ? 5.5 : 3.0) : (useV4_1h ? 4.0 : 3.2);
  const vMinStopCfg = is15mProfile ? (useV4_15m ? 1.6 : 1.0) : (useV4_1h ? 1.8 : 1.4);
  const vRrCfg = is15mProfile ? (useV4_15m ? 2.0 : 1.15) : (useV4_1h ? 2.5 : 1.15);
  const vMaxHoldCfg = is15mProfile ? (useV4_15m ? 240 : 120) : (useV4_1h ? 192 : 96);
  const vBeTrigCfg = is15mProfile ? (useV4_15m ? 0.44 : 0.43) : (useV4_1h ? 0.46 : 0.43);
  const vBeOffCfg = is15mProfile ? (useV4_15m ? 0.38 : 0.28) : (useV4_1h ? 0.40 : 0.34);
  const vLock2TrigCfg = is15mProfile ? 0.0 : (useV4_1h ? 1.20 : 0.0);
  const vLock2OffCfg = is15mProfile ? 0.0 : (useV4_1h ? 0.75 : 0.0);
  const vExpiryCfg = is15mProfile ? (useV4_15m ? 16 : 6) : 6;
  const vCooldownCfg = is15mProfile ? (useV4_15m ? 12 : 8) : (useV4_1h ? 1 : 4);
  const useShadowLedger = is15mProfile ? useV4_15m : true;

  // Shadow virtual ledger state
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
  let vLock2Armed = false;
  const vLongSlHist = [];
  const vLongNetHist = [];
  const vShortSlHist = [];
  const vShortNetHist = [];

  // Live Paper IN/OUT state
  const effEntryMode = 'LIMIT_PULLBACK';
  const effExpiryBars = vExpiryCfg;
  const effStopAtr = vStopAtrCfg;
  const effMinStopPct = vMinStopCfg;
  const effRewardRisk = paperUseAutoPreset || customRewardRisk === null ? vRrCfg : customRewardRisk;
  const effMaxHoldBars = vMaxHoldCfg;
  const effCooldown = vCooldownCfg;
  const effBeTriggerR = vBeTrigCfg;
  const effBeOffsetPct = vBeOffCfg;
  const effLock2TriggerR = vLock2TrigCfg;
  const effLock2OffsetR = vLock2OffCfg;
  const effUseVolNorm = paperSizingMode !== 'Fixed Leverage';
  const effAutoVolNorm = paperSizingMode === 'VolNorm [v4.1 Auto]';
  const effRiskPct = effAutoVolNorm ? (is15mProfile ? 2.2 : 4.5) : paperRiskPct;
  const effMinLev = effAutoVolNorm ? (is15mProfile ? 0.75 : 1.5) : paperMinLev;
  const effMaxLev = Math.max(effMinLev, effAutoVolNorm ? (is15mProfile ? 1.5 : 2.8) : paperMaxLev);
  const effTp1QtyFrac = paperTp1TriggerR > 0 && paperTp1QtyPct > 0 ? paperTp1QtyPct / 100.0 : 0.0;

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
  let paperLock2Armed = false;
  let paperActiveLev = 1.0;
  let paperTp1QtyFrac = 0.0;
  let paperTp1Price = NaN;
  let paperTp1Hit = false;
  let paperRemFrac = 1.0;
  let paperLeg1Net = 0.0;
  let paperLeg1Gross = 0.0;

  let paperWins = 0;
  let paperLosses = 0;
  let paperTies = 0;
  let paperGains = 0;
  let paperLossSum = 0;
  let paperTotalNet = 0;
  let paperGainsLev = 0;
  let paperLossSumLev = 0;
  let paperTotalNetLev = 0;
  let paperEquityLev = 1.0;

  const barStates = [];
  const signals = [];
  const trades = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const hSec = htfObj.intervalSeconds;
    let isNewH4_15m = false;

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
        open: htfRows[j].open,
        high: htfRows[j].high,
        low: htfRows[j].low,
        close: htfRows[j].close,
        ema50: htfEma50[j],
        atr14: htfAtr14[j],
        prevHigh10: htfPrevHigh10[j],
        prevLow10: htfPrevLow10[j],
      };
      assert.equal(j, htfObj.alignedIndex[i], `Pine HTF latch mismatch vs alignedIndex at bar ${i}`);
    }
    if (latchedH4) {
      h4PrevLowSeries[i] = latchedH4.prevLow10;
      h4PrevHighSeries[i] = latchedH4.prevHigh10;
    }

    if (auxRows) {
      const auxSec = auxObj.intervalSeconds;
      const auxBoundary = i > 0 && Math.floor(r.time / auxSec) !== Math.floor(rows[i - 1].time / auxSec);
      if (auxBoundary && prevRawAuxIdx >= 0 && auxRows[prevRawAuxIdx].time + auxSec <= r.time) {
        const jAux = prevRawAuxIdx;
        latchedM15H4 = {
          open: auxRows[jAux].open,
          high: auxRows[jAux].high,
          low: auxRows[jAux].low,
          close: auxRows[jAux].close,
          ema50: auxEma50[jAux],
          atr14: auxAtr14[jAux],
        };
        isNewH4_15m = true;
        latchedD1 = { high: auxRows[jAux].high, low: auxRows[jAux].low };
        assert.equal(jAux, auxObj.alignedIndex[i], `Pine aux HTF (${auxKey}) latch mismatch vs alignedIndex at bar ${i}`);
      }
      if (latchedD1) {
        d1LowSeries[i] = latchedD1.low;
        d1HighSeries[i] = latchedD1.high;
      }
    }

    prevRawHtfIdx = findClosedHtfBeforeOrAtClose(htfRows, hSec, r.time, r.time + intervalSeconds);
    if (auxRows) {
      prevRawAuxIdx = findClosedHtfBeforeOrAtClose(auxRows, auxObj.intervalSeconds, r.time, r.time + intervalSeconds);
    }

    const atr = qualityAtr[i];
    const ema50 = ltfEma50[i];
    const ema20 = ltfEma20[i];

    // --- 15m Legacy v3.0 Engine: H1_CleanDisp_AtrExh ---
    let v3_15m_side = 0;
    let v3_15m_limit = NaN;
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

    // --- 15m v4.0 Engine (15m_r3): H4 Close Displacement + LTF EMA50 ---
    let v4_15m_rawSide = 0;
    let v4_15m_rawLimit = NaN;
    if (is15mProfile && i >= 250 && isNewH4_15m && Number.isFinite(atr) && atr > 0 && Number.isFinite(ema50) &&
        latchedM15H4 && Number.isFinite(latchedM15H4.atr14) && latchedM15H4.atr14 > 0 && Number.isFinite(latchedM15H4.ema50)) {
      const atrPct15 = (atr / r.close) * 100.0;
      const h4Range15 = latchedM15H4.high - latchedM15H4.low;
      if (atrPct15 >= 0.15 && h4Range15 > 0) {
        const h4Body15 = latchedM15H4.close - latchedM15H4.open;
        const h4Bull15 = h4Body15 >= 0.85 * latchedM15H4.atr14 && (latchedM15H4.close - latchedM15H4.low) / h4Range15 >= 0.60 && latchedM15H4.close > latchedM15H4.ema50 && r.close > ema50;
        const h4Bear15 = -h4Body15 >= 0.85 * latchedM15H4.atr14 && (latchedM15H4.high - latchedM15H4.close) / h4Range15 >= 0.60 && latchedM15H4.close < latchedM15H4.ema50 && r.close < ema50;
        if (h4Bull15 !== h4Bear15) {
          const rSide15 = h4Bull15 ? 1 : -1;
          const rLim15 = r.close - rSide15 * 0.35 * atr;
          if (rLim15 > 0) {
            v4_15m_rawSide = rSide15;
            v4_15m_rawLimit = rLim15;
          }
        }
      }
    }

    // --- 1h Default v3.0 Engine: HtfSmcMultiTrap ---
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

        if (k <= 2 && auxRows) {
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

    // --- 1h Optional v4.0 High-Return Trend Engine (1h_r1r2): H4Disp_0.9_off0.15 ---
    let v4_1h_rawSide = 0;
    let v4_1h_rawLimit = NaN;
    if (!is15mProfile && i >= 250 && Number.isFinite(atr) && atr > 0 && Number.isFinite(ema50) &&
        latchedH4 && Number.isFinite(latchedH4.atr14) && latchedH4.atr14 > 0 && Number.isFinite(latchedH4.ema50)) {
      const h4Range1h = latchedH4.high - latchedH4.low;
      if (h4Range1h > 0) {
        const h4Body1h = latchedH4.close - latchedH4.open;
        const h4Bull1h = h4Body1h >= 0.90 * latchedH4.atr14 && (latchedH4.close - latchedH4.low) / h4Range1h >= 0.60 && latchedH4.close > latchedH4.ema50 && r.close > ema50;
        const h4Bear1h = -h4Body1h >= 0.90 * latchedH4.atr14 && (latchedH4.high - latchedH4.close) / h4Range1h >= 0.60 && latchedH4.close < latchedH4.ema50 && r.close < ema50;
        if (h4Bull1h !== h4Bear1h) {
          const rSide1hV4 = h4Bull1h ? 1 : -1;
          const rLim1hV4 = r.close - rSide1hV4 * 0.15 * atr;
          if (rLim1hV4 > 0) {
            v4_1h_rawSide = rSide1hV4;
            v4_1h_rawLimit = rLim1hV4;
          }
        }
      }
    }

    const activeRawSide = is15mProfile ? (useV4_15m ? v4_15m_rawSide : v3_15m_side) : (useV4_1h ? v4_1h_rawSide : v3_1h_rawSide);
    const activeRawLimit = is15mProfile ? (useV4_15m ? v4_15m_rawLimit : v3_15m_limit) : (useV4_1h ? v4_1h_rawLimit : v3_1h_rawLimit);

    // Shadow virtual ledger for AdaptivePolarity
    let shadowAdaptedSide = 0;
    let shadowAdaptedLimit = NaN;
    if (useShadowLedger) {
      if (vSide === 0 && vPendingSide !== 0) {
        const vBullPend = vPendingSide === 1;
        const vTouched = vBullPend ? r.low <= vPendingLimit : r.high >= vPendingLimit;
        if (vTouched) {
          const vFillAtOpen = vBullPend ? r.open <= vPendingLimit : r.open >= vPendingLimit;
          const vRawFill = vBullPend ? Math.min(r.open, vPendingLimit) : Math.max(r.open, vPendingLimit);
          const vFill = adverseFillPine(vRawFill, vPendingSide, true, 0.025);
          const lvl = resolvePaperLevelsPine(vPendingSide, vFill, vPendingAtr, vStopAtrCfg, vMinStopCfg, vRrCfg);
          if (lvl.ok) {
            vSide = vPendingSide;
            vEntry = vFill;
            vStop = lvl.stop;
            vTarget = lvl.target;
            vInitialDist = lvl.dist;
            vEntryBar = i;
            vFilledAtOpen = vFillAtOpen;
            vBeArmed = false;
            vLock2Armed = false;
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
        const vIsBeRaised = vBeArmed || (vLock2Armed && vSide * (vStop - vEntry) >= -EPS_ZERO);
        const ex = paperExitConservativePine(
          vSide, 'LIMIT_PULLBACK', i === vEntryBar, vFilledAtOpen, vIsBeRaised,
          r.open, r.high, r.low, r.close, vStop, vTarget, i - vEntryBar + 1, vMaxHoldCfg,
        );
        if (ex.reason !== 0) {
          const vOutPrice = adverseFillPine(ex.price, vSide, false, 0.025);
          let vNet = (vSide * (vOutPrice - vEntry)) / vEntry * 100.0 - 0.10;
          if (Math.abs(vNet) < EPS_ZERO) vNet = 0.0;
          const isPureSl = ex.reason === 1 && !vIsBeRaised;
          const slArr = vSide === 1 ? vLongSlHist : vShortSlHist;
          const netArr = vSide === 1 ? vLongNetHist : vShortNetHist;
          slArr.push(isPureSl ? 1 : 0);
          netArr.push(vNet);
          if (slArr.length > 6) slArr.shift();
          if (netArr.length > 6) netArr.shift();
          vSide = 0;
        }
      }

      if (vSide !== 0 && vBeTrigCfg > 0 && !vBeArmed) {
        if (vSide * (r.close - vEntry) >= vBeTrigCfg * vInitialDist) {
          const vRaisedStop = vEntry * (1.0 + (vSide * vBeOffCfg) / 100.0);
          if (vSide * (vRaisedStop - vStop) > 0 && vSide * (vTarget - vRaisedStop) > 0) {
            vStop = vRaisedStop;
            vBeArmed = true;
          }
        }
      }

      if (vSide !== 0 && vLock2TrigCfg > 0 && !vLock2Armed) {
        if (vSide * (r.close - vEntry) >= vLock2TrigCfg * vInitialDist) {
          const vRaisedLock2 = vEntry + vSide * vLock2OffCfg * vInitialDist;
          if (vSide * (vRaisedLock2 - vStop) > 0 && vSide * (vTarget - vRaisedLock2) > 0) {
            vStop = vRaisedLock2;
            vLock2Armed = true;
          }
        }
      }

      if (activeRawSide !== 0) {
        const slArr = activeRawSide === 1 ? vLongSlHist : vShortSlHist;
        const netArr = activeRawSide === 1 ? vLongNetHist : vShortNetHist;
        let slCount = 0;
        let netSum = 0;
        for (let q = 0; q < slArr.length; q++) {
          slCount += slArr[q];
          netSum += netArr[q];
        }
        const shouldFlip = slArr.length >= 2 && slCount >= 2 && netSum < 0.0;
        const adaptSide = shouldFlip ? -activeRawSide : activeRawSide;
        const adaptLimit = r.close - adaptSide * vPullAtrCfg * atr;
        if (adaptLimit > 0) {
          shadowAdaptedSide = adaptSide;
          shadowAdaptedLimit = adaptLimit;
        }
      }

      if (vSide === 0 && vPendingSide === 0 && activeRawSide !== 0 && i >= 250 && i - vLastAccepted >= vCooldownCfg) {
        const pre = resolvePaperLevelsPine(activeRawSide, activeRawLimit, atr, vStopAtrCfg, vMinStopCfg, vRrCfg);
        if (pre.ok) {
          vPendingSide = activeRawSide;
          vPendingAtr = atr;
          vPendingLimit = activeRawLimit;
          vPendingExpiryBar = i + vExpiryCfg;
          vLastAccepted = i;
        }
      }
    }

    const candSide = useShadowLedger ? shadowAdaptedSide : activeRawSide;
    const candLimit = useShadowLedger ? shadowAdaptedLimit : activeRawLimit;
    if (candSide !== 0) {
      signals.push({
        barIndex: i,
        side: candSide,
        atr,
        limitPrice: candLimit,
      });
    }

    // Live Paper IN / OUT state machine
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
          paperLock2Armed = false;
          paperActiveLev = calcPosLevPine(effUseVolNorm, effRiskPct, effMinLev, effMaxLev, paperLeverageRef, fill, lvl.dist);
          paperTp1QtyFrac = effTp1QtyFrac;
          paperTp1Price = effTp1QtyFrac > 0.0 ? fill + paperSide * paperTp1TriggerR * lvl.dist : NaN;
          paperTp1Hit = false;
          paperRemFrac = 1.0;
          paperLeg1Net = 0.0;
          paperLeg1Gross = 0.0;
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
      const paperIsBeRaised = paperBeArmed || paperTp1Hit || (paperLock2Armed && paperSide * (paperStop - paperEntry) >= -EPS_ZERO);
      const bullOpen = paperSide === 1;
      const isEntryBarNow = i === paperEntryBar;
      const canGapAndHL = effEntryMode === 'MARKET_NEXT_OPEN' || !isEntryBarNow || paperFilledAtOpen;
      const gapStopNow = bullOpen ? r.open <= paperStop : r.open >= paperStop;
      const gapTargetNow = canGapAndHL && (bullOpen ? r.open >= paperTarget : r.open <= paperTarget);
      const hitStopNow = bullOpen ? r.low <= paperStop : r.high >= paperStop;
      let tp1JustHitByWick = false;

      if (paperTp1QtyFrac > 0.0 && !paperTp1Hit && Number.isFinite(paperTp1Price) && !gapStopNow) {
        let hitTp1Bar = false;
        let tp1Raw = NaN;
        if (gapTargetNow) {
          hitTp1Bar = true;
          tp1Raw = paperTp1Price;
        } else if (!hitStopNow) {
          const gapTp1 = canGapAndHL && (bullOpen ? r.open >= paperTp1Price : r.open <= paperTp1Price);
          const hitTp1 = canGapAndHL
            ? (bullOpen ? r.high >= paperTp1Price : r.low <= paperTp1Price)
            : (bullOpen ? r.close >= paperTp1Price : r.close <= paperTp1Price);
          if (gapTp1 || hitTp1) {
            hitTp1Bar = true;
            tp1Raw = gapTp1 ? r.open : paperTp1Price;
            tp1JustHitByWick = !gapTp1;
          }
        }
        if (hitTp1Bar) {
          const tp1Exit = adverseFillPine(tp1Raw, paperSide, false, slippagePct);
          const leg1Gross = (paperSide * (tp1Exit - paperEntry)) / paperEntry * 100.0;
          const leg1Net = leg1Gross - feePct;
          paperLeg1Gross += paperTp1QtyFrac * leg1Gross;
          paperLeg1Net += paperTp1QtyFrac * leg1Net;
          paperRemFrac = 1.0 - paperTp1QtyFrac;
          paperTp1Hit = true;
        }
      }

      let ex = paperExitConservativePine(
        paperSide, effEntryMode, isEntryBarNow, paperFilledAtOpen, paperIsBeRaised,
        r.open, r.high, r.low, r.close, paperStop, paperTarget, i - paperEntryBar + 1, effMaxHoldBars,
      );
      if (tp1JustHitByWick && ex.reason === 2 && !(bullOpen ? r.close >= paperTarget : r.close <= paperTarget)) {
        if (i - paperEntryBar + 1 >= effMaxHoldBars) {
          ex = { price: r.close, reason: 3 };
        } else {
          ex = { price: NaN, reason: 0 };
        }
      }

      if (ex.reason !== 0) {
        paperOutPrice = adverseFillPine(ex.price, paperSide, false, slippagePct);
        const remGross = (paperSide * (paperOutPrice - paperEntry)) / paperEntry * 100.0;
        const remNet = remGross - feePct;
        const unleveredGrossPct = paperLeg1Gross + paperRemFrac * remGross;
        paperClosedNet = paperLeg1Net + paperRemFrac * remNet;
        paperClosedNet = Math.abs(paperClosedNet) < EPS_ZERO ? 0.0 : paperClosedNet;
        const grossPctLev = unleveredGrossPct * paperActiveLev;
        const netPctLev = paperClosedNet * paperActiveLev;
        paperOutReason = ex.reason;
        paperClosedSide = paperSide;
        paperClosedEntry = paperEntry;
        if (paperClosedNet > EPS_ZERO) {
          paperWins++;
          paperGains += paperClosedNet;
          paperGainsLev += netPctLev;
        } else if (paperClosedNet < -EPS_ZERO) {
          paperLosses++;
          paperLossSum -= paperClosedNet;
          paperLossSumLev -= netPctLev;
        } else {
          paperTies++;
        }
        paperTotalNet += paperClosedNet;
        paperTotalNetLev += netPctLev;
        const levFactor = 1.0 + netPctLev / 100.0;
        paperEquityLev = levFactor <= 0.0 ? 0.0 : paperEquityLev * levFactor;
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
          lock2Armed: paperLock2Armed,
          tp1Hit: paperTp1Hit,
          lev: paperActiveLev,
          exit: paperOutPrice,
          exitReason: reasonStr,
          unleveredGrossPct,
          unleveredNetPct: paperClosedNet,
          grossPct: grossPctLev,
          netPct: paperClosedNet,
          netPctLev,
        });
        paperSide = 0;
      }
    }

    if (paperSide !== 0 && paperTp1Hit && paperTp1LockR > 0) {
      const raisedTp1Stop = paperEntry + paperSide * paperTp1LockR * paperInitialDist;
      if (paperSide * (raisedTp1Stop - paperStop) > 0 && paperSide * (paperTarget - raisedTp1Stop) > 0) {
        paperStop = raisedTp1Stop;
        paperBeArmed = true;
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

    if (paperSide !== 0 && effLock2TriggerR > 0 && !paperLock2Armed) {
      if (paperSide * (r.close - paperEntry) >= effLock2TriggerR * paperInitialDist) {
        const raisedLock2 = paperEntry + paperSide * effLock2OffsetR * paperInitialDist;
        if (paperSide * (raisedLock2 - paperStop) > 0 && paperSide * (paperTarget - raisedLock2) > 0) {
          paperStop = raisedLock2;
          paperLock2Armed = true;
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
      rawSide: activeRawSide,
      candSide,
      candLimit,
      paperPendingSide,
      paperSide,
      paperStop,
      paperTarget,
      paperBeArmed,
      paperTp1Hit,
      paperActiveLev,
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
      paperTotalNetLev,
      paperEquityLev,
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
    totalNetLevPct: paperTotalNetLev,
    compoundedNetLevPct: (paperEquityLev - 1.0) * 100.0,
    profitFactorLev: paperLossSumLev > 0 ? paperGainsLev / paperLossSumLev : null,
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
    'v4.0 H4-Close-Disp [3Y OKX]',
    'v3.0 H1-Clean-Disp [Legacy]',
    'v3.0 Adaptive-MultiTrap [All-Weather]',
    'v4.0 H4-Disp Trend [High-Return 1x]',
    'timeframe.in_seconds()',
    'chartSeconds <= 900',
    'chartSeconds <= 900 ? "240" : chartSeconds < 86400 ? "1D" : timeframe.period',
    'atrPct15 >= 0.15',
    '0.85 * m15H4Atr14',
    '0.35 * qualityAtr',
    '0.90 * h4Atr14',
    '0.15 * qualityAtr',
    '0.18 * qualityAtr',
    'useV4_15m ? 5.5  : 3.0',
    'useV4_15m ? 1.6  : 1.0',
    'useV4_15m ? 2.0  : 1.15',
    'useV4_15m ? 240  : 120',
    'useV4_15m ? 16   : 6',
    'useV4_15m ? 12   : 8',
    'useV4_1h ? 1.20 : 0.0',
    'useV4_1h ? 0.75 : 0.0',
    'effLock2TriggerR = applyV3Auto ? vLock2TrigCfg : paperLock2TriggerRInput',
    'paperExitConservative(',
    'resolvePaperLevels(',
    'adaptivePolarityFlip(',
    'recordShadowOutcome(',
    'calcPosLev(',
    'V3_SHADOW_FEE_PCT = 0.10',
    'V3_SHADOW_SLIP_PCT = 0.025',
    'VolNorm [v4.1 Auto]',
    'paperSizingMode',
    'paperRiskPct',
    'paperTp1QtyPct',
  ];

  for (const snippet of requiredLiterals) {
    assert.ok(toolPine.includes(snippet), `TOOL.pine missing required v4/v3 spec snippet: ${snippet}`);
    assert.ok(stratPine.includes(snippet), `TOOL_Strategy.pine missing required v4/v3 spec snippet: ${snippet}`);
  }
  assert.ok(toolPine.includes('SMC Confirmed [4.1.0]'), 'TOOL.pine missing 4.1.0 title');
  assert.ok(stratPine.includes('SMC High-WinRate Strategy [4.1.0]'), 'TOOL_Strategy.pine missing 4.1.0 title');
  assert.ok(stratPine.includes('default_qty_value = 200'), 'TOOL_Strategy.pine missing default 2x Futures sizing (default_qty_value = 200)');
  assert.ok(stratPine.includes('margin_long = 20') && stratPine.includes('margin_short = 20'), 'TOOL_Strategy.pine missing 20% margin bounds for VolNorm <= 5x');
  assert.ok(stratPine.includes('qty = stratOrderQty'), 'TOOL_Strategy.pine missing dynamic stratOrderQty entry sizing');
  assert.ok(stratPine.includes('qty_percent = paperTp1QtyPct'), 'TOOL_Strategy.pine missing Partial TP1 strategy.exit');

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
    'calcPosLev(',
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

export function verifyDatasetParity(relDataPath, options = {}) {
  const {
    engine15mProfile = 'v4.0 H4-Close-Disp [3Y OKX]',
    engine1hProfile = 'v3.0 Adaptive-MultiTrap [All-Weather]',
    paperUseAutoPreset = true,
    customRewardRisk = null,
    paperSizingMode = 'VolNorm [v4.1 Auto]',
    paperRiskPct = 4.5,
    paperMinLev = 1.5,
    paperMaxLev = 2.8,
    paperLeverageRef = 2.0,
    paperTp1QtyPct = 0.0,
    paperTp1TriggerR = 0.95,
    paperTp1LockR = 0.65,
  } = options;
  const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, relDataPath), 'utf8'));
  const pineSim = simulatePineV6Engine(dataset, {
    engine15mProfile,
    engine1hProfile,
    paperUseAutoPreset,
    customRewardRisk,
    paperSizingMode,
    paperRiskPct,
    paperMinLev,
    paperMaxLev,
    paperLeverageRef,
    paperTp1QtyPct,
    paperTp1TriggerR,
    paperTp1LockR,
  });
  const is15m = dataset.intervalSeconds <= 900;

  let refSignals;
  let refSimOptions;

  if (is15m) {
    if (engine15mProfile === 'v4.0 H4-Close-Disp [3Y OKX]') {
      const virtExec15 = {
        entryMode: 'LIMIT_PULLBACK',
        limitExpiryBars: 16,
        pendingPolicy: 'ignore',
        limitSameBarTp: 'close',
        warmup: 250,
        costPct: 0.1,
        slippagePct: 0.025,
        stopAtr: 5.5,
        minStopPct: 1.6,
        rewardRisk: 2,
        maxHoldBars: 240,
        beTriggerR: 0.44,
        beOffsetPct: 0.38,
        lock2TriggerR: 0,
        lock2OffsetR: 0,
        trailTriggerR: 0,
        trailAtrMult: 0,
        cooldown: 12,
      };
      const spec15V4 = {
        tag: 'M15_H4Disp_0.85_H4Close_p0.35_w6',
        rawFamily: 'M15_H4Disp',
        h4BodyAtrMin: 0.85,
        h4ClosePosMin: 0.6,
        onH4CloseOnly: true,
        requireLtfConfirm: false,
        htfMode: 'H4_50',
        minAtrPct: 0.15,
        pullAtr: 0.35,
        adaptive: true,
        winLen: 6,
        slThresh: 2,
        requireNegNet: true,
        virtExec: virtExec15,
      };
      refSignals = generateSignals15mV4(dataset, spec15V4);
      refSimOptions = { ...virtExec15, intervalSeconds: dataset.intervalSeconds };
    } else {
      refSignals = generate15mSignals(dataset, DEFAULT_15M_PARAMS);
      refSimOptions = { ...DEFAULT_15M_SIM_OPTIONS, intervalSeconds: dataset.intervalSeconds };
    }
  } else if (engine1hProfile === 'v4.0 H4-Disp Trend [High-Return 1x]') {
    const virtExec1hV4 = {
      entryMode: 'LIMIT_PULLBACK',
      limitExpiryBars: 6,
      pendingPolicy: 'ignore',
      limitSameBarTp: 'close',
      warmup: 250,
      costPct: 0.1,
      slippagePct: 0.025,
      stopAtr: 4,
      minStopPct: 1.8,
      rewardRisk: 2.5,
      maxHoldBars: 192,
      beTriggerR: 0.46,
      beOffsetPct: 0.4,
      lock2TriggerR: 1.2,
      lock2OffsetR: 0.75,
      trailTriggerR: 0,
      trailAtrMult: 0,
      cooldown: 1,
    };
    const spec1hV4 = {
      tag: 'H4Disp_0.9_off0.15_adp',
      rawFamily: 'H4Disp',
      h4BodyAtrMin: 0.9,
      h4ClosePosMin: 0.6,
      htfMode: 'H4_50',
      limitOffsetAtr: 0.15,
      adaptive: true,
      winLen: 6,
      slThresh: 2,
      requireNegNet: true,
      virtExec: virtExec1hV4,
    };
    refSignals = generateSignals1hV4(dataset, spec1hV4);
    refSimOptions = { ...virtExec1hV4, intervalSeconds: dataset.intervalSeconds };
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

  // 2. Trade-by-trade parity against sim_engine.mjs (both 1x unlevered & v4.1 VolNorm/Fixed levered)
  const effRiskPct = paperSizingMode === 'VolNorm [v4.1 Auto]' ? (is15m ? 2.2 : 4.5) : paperRiskPct;
  const effMinLev = paperSizingMode === 'VolNorm [v4.1 Auto]' ? (is15m ? 0.75 : 1.5) : paperMinLev;
  const effMaxLev = Math.max(effMinLev, paperSizingMode === 'VolNorm [v4.1 Auto]' ? (is15m ? 1.5 : 2.8) : paperMaxLev);
  const sizingSimOpts = paperSizingMode === 'Fixed Leverage'
    ? { volNormRiskPct: 0, fixedLev: paperLeverageRef }
    : { volNormRiskPct: effRiskPct, minLev: effMinLev, maxLev: effMaxLev };
  const tp1SimOpts = {
    tp1QtyPct: paperTp1QtyPct,
    tp1TriggerR: paperTp1TriggerR,
    tp1LockOffsetR: paperTp1LockR,
  };
  const rrOverrideOpts = !paperUseAutoPreset && customRewardRisk !== null
    ? { rewardRisk: customRewardRisk }
    : {};
  const refSim = simulateTrades(dataset.rows, refSignals, {
    ...refSimOptions,
    ...sizingSimOpts,
    ...tp1SimOpts,
    ...rrOverrideOpts,
  });
  assert.equal(pineSim.trades.length, refSim.trades.length, `${relDataPath}: trade count mismatch`);
  assert.equal(pineSim.wins, refSim.wins, `${relDataPath}: wins mismatch`);
  assert.equal(pineSim.losses, refSim.losses, `${relDataPath}: losses mismatch`);
  assert.equal(pineSim.ties, refSim.ties, `${relDataPath}: ties mismatch`);
  near(pineSim.totalNetLevPct, refSim.totalNetPct, 1e-10, `${relDataPath}: totalNetLevPct`);
  near(pineSim.compoundedNetLevPct, refSim.compoundedNetPct, 1e-10, `${relDataPath}: compoundedNetLevPct`);
  if (refSim.profitFactor !== null) {
    near(pineSim.profitFactorLev, refSim.profitFactor, 1e-10, `${relDataPath}: profitFactorLev`);
  }

  for (let i = 0; i < refSim.trades.length; i++) {
    const a = pineSim.trades[i];
    const b = refSim.trades[i];
    for (const k of ['signalIndex', 'entryIndex', 'exitIndex', 'side', 'exitReason', 'beArmed', 'lock2Armed', 'tp1Hit']) {
      assert.equal(a[k], b[k], `${relDataPath}: trade[${i}].${k}`);
    }
    for (const k of ['entry', 'stop', 'initialStop', 'target', 'exit', 'lev', 'grossPct', 'unleveredNetPct']) {
      near(a[k], b[k], 1e-12, `${relDataPath}: trade[${i}].${k}`);
    }
    near(a.netPctLev, b.netPct, 1e-12, `${relDataPath}: trade[${i}].netPctLev`);
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
      near(st.paperActiveLev, ent.lev, 1e-12, `${relDataPath}: bar[${i}].paperActiveLev`);
    }
    const ex = exitMap.get(i);
    if (ex) {
      const code = { SL: 1, TP: 2, TIME: 3, BE: 4 }[ex.exitReason];
      assert.equal(st.paperOutReason, code, `${relDataPath}: bar[${i}].paperOutReason`);
      near(st.paperOutPrice, ex.exit, 1e-12, `${relDataPath}: bar[${i}].paperOutPrice`);
      near(st.paperClosedNet, ex.unleveredNetPct, 1e-12, `${relDataPath}: bar[${i}].paperClosedNet`);
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
    profitFactor: pineSim.profitFactor !== null ? Number(pineSim.profitFactor.toFixed(4)) : null,
    profitFactorLev: refSim.profitFactor !== null ? Number(refSim.profitFactor.toFixed(4)) : null,
    totalNetPct: Number(pineSim.totalNetPct.toFixed(4)),
    totalNetLevPct: Number(refSim.totalNetPct.toFixed(4)),
    compoundedNetLevPct: Number(refSim.compoundedNetPct.toFixed(4)),
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
  const results = datasets.map(rel => verifyDatasetParity(rel));
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
