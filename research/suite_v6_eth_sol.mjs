import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTradesV6, simulatePortfolioV6, summarizePerformanceV6 } from './sim_engine_v6.mjs';
import { alignFundingToBarsCausal } from './fetch_okx_derivs.mjs';
import {
  calcPineEma,
  computeOhlcFeatures1h,
  generateSignals1h,
} from './signals_1h.mjs';
import {
  FEATURE_NAMES_V6,
  sliceDatasetPrefixV6,
  precomputeOrderflowContextV6,
  extractCandidateFeaturesV6,
  getBtcBnbPortfolioStreamsV6,
} from './suite_v6_btc_bnb.mjs';
import { scoreCandidateV5 } from './ml_inference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V6_DIR = path.join(HERE, 'results_v6');

export const PROMOTION_GATE_V6 = Object.freeze({
  minHoldoutY5WinRatePct: 65.0,
  minHoldoutY5NetPct: 0.0,
  minHoldoutY5ProfitFactor: 1.15,
  minHoldoutY5Trades: 30,
});

export const ETH_CROSS_FEATURE_NAMES_V6 = Object.freeze([
  'eth_btc_ema20_dist',
  'eth_btc_ema50_dist',
  'eth_btc_ret_24h_dir',
  'eth_btc_ret_72h_dir',
  'eth_btc_zscore_48',
  'eth_btc_residual_12h_dir',
]);

export const ETH_FEATURE_NAMES_V6 = Object.freeze([
  ...FEATURE_NAMES_V6,
  ...ETH_CROSS_FEATURE_NAMES_V6,
]);

export const SOL_FEATURE_NAMES_V6 = FEATURE_NAMES_V6;

/**
 * Strictly causal ETH/BTC cross-asset feature precomputation.
 * Aligns BTC closes to ETH bar i using btcRow.time <= ethRow.time (no future BTC bars).
 */
export function precomputeEthCrossContextV6(ethDataset, btcDataset, alignedFunding = null, maxBarIdx = null) {
  assert.ok(ethDataset && Array.isArray(ethDataset.rows) && ethDataset.rows.length > 0, 'Expected ETH dataset');
  assert.ok(btcDataset && Array.isArray(btcDataset.rows) && btcDataset.rows.length > 0, 'Expected BTC dataset');

  const limit = maxBarIdx === null ? ethDataset.rows.length : maxBarIdx + 1;
  assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= ethDataset.rows.length, 'Invalid maxBarIdx');

  const ethRows = ethDataset.rows;
  const btcRows = btcDataset.rows;
  const lastEthTime = ethRows[limit - 1].time;

  // Strictly align BTC bar j with btcRows[j].time <= ethRows[i].time
  const alignedBtcClose = new Float64Array(limit).fill(NaN);
  const ratio = new Float64Array(limit).fill(NaN);
  let j = -1;
  for (let i = 0; i < limit; i++) {
    const t = ethRows[i].time;
    while (j + 1 < btcRows.length && btcRows[j + 1].time <= t && btcRows[j + 1].time <= lastEthTime) {
      j++;
    }
    if (j >= 0 && btcRows[j].close > 0) {
      alignedBtcClose[i] = btcRows[j].close;
      ratio[i] = ethRows[i].close / btcRows[j].close;
    }
  }

  const ratioArr = Array.from(ratio, v => (Number.isFinite(v) ? v : 0));
  const ema20 = calcPineEma(ratioArr, 20);
  const ema50 = calcPineEma(ratioArr, 50);

  const z48 = new Float64Array(limit).fill(NaN);
  const resid12 = new Float64Array(limit).fill(NaN);

  let sumR = 0;
  let sumR2 = 0;
  const ret1Eth = new Float64Array(limit);
  const ret1Btc = new Float64Array(limit);
  let sE = 0;
  let sB = 0;
  let sEE = 0;
  let sBB = 0;
  let sEB = 0;

  for (let i = 0; i < limit; i++) {
    const rv = ratio[i];
    if (Number.isFinite(rv)) {
      sumR += rv;
      sumR2 += rv * rv;
    }
    if (i >= 48 && Number.isFinite(ratio[i - 48])) {
      sumR -= ratio[i - 48];
      sumR2 -= ratio[i - 48] * ratio[i - 48];
    }
    if (i >= 47 && Number.isFinite(rv)) {
      const m = sumR / 48;
      const sd = Math.sqrt(Math.max(0, sumR2 / 48 - m * m));
      z48[i] = sd > 1e-8 ? (rv - m) / sd : 0;
    }

    if (i >= 1 && Number.isFinite(alignedBtcClose[i]) && Number.isFinite(alignedBtcClose[i - 1])) {
      const rE = Math.log(ethRows[i].close / ethRows[i - 1].close);
      const rB = Math.log(alignedBtcClose[i] / alignedBtcClose[i - 1]);
      ret1Eth[i] = rE;
      ret1Btc[i] = rB;
      sE += rE;
      sB += rB;
      sEE += rE * rE;
      sBB += rB * rB;
      sEB += rE * rB;
      if (i > 48) {
        const oE = ret1Eth[i - 48];
        const oB = ret1Btc[i - 48];
        sE -= oE;
        sB -= oB;
        sEE -= oE * oE;
        sBB -= oB * oB;
        sEB -= oE * oB;
      }
      if (i >= 48) {
        const mE = sE / 48;
        const mB = sB / 48;
        const varB = sBB / 48 - mB * mB;
        const covEB = sEB / 48 - mE * mB;
        const beta = varB > 1e-10 ? Math.max(0.2, Math.min(2.5, covEB / varB)) : 1.0;
        const rE12 = Math.log(ethRows[i].close / ethRows[i - 12].close);
        const rB12 = Math.log(alignedBtcClose[i] / alignedBtcClose[i - 12]);
        resid12[i] = (rE12 - beta * rB12) * 100;
      }
    }
  }

  const orderflowCtx = precomputeOrderflowContextV6(ethDataset, alignedFunding, limit - 1);
  return {
    limit,
    ethRows,
    ratio,
    ema20,
    ema50,
    z48,
    resid12,
    orderflowCtx,
  };
}

export function extractEthCandidateFeaturesV6(ethDataset, btcDataset, signal, barIdx, alignedFunding = null, context = null) {
  const ctx = context ?? precomputeEthCrossContextV6(ethDataset, btcDataset, alignedFunding, barIdx);
  const base = extractCandidateFeaturesV6(ethDataset, signal, barIdx, alignedFunding, ctx.orderflowCtx);
  const side = signal.side;
  const r = ctx.ratio[barIdx];
  const e20 = ctx.ema20[barIdx];
  const e50 = ctx.ema50[barIdx];

  const eth_btc_ema20_dist = Number.isFinite(r) && Number.isFinite(e20) && e20 > 0
    ? (side * (r - e20) / e20) * 100
    : NaN;
  const eth_btc_ema50_dist = Number.isFinite(r) && Number.isFinite(e50) && e50 > 0
    ? (side * (r - e50) / e50) * 100
    : NaN;
  const eth_btc_ret_24h_dir = barIdx >= 24 && Number.isFinite(r) && Number.isFinite(ctx.ratio[barIdx - 24]) && ctx.ratio[barIdx - 24] > 0
    ? side * Math.log(r / ctx.ratio[barIdx - 24]) * 100
    : NaN;
  const eth_btc_ret_72h_dir = barIdx >= 72 && Number.isFinite(r) && Number.isFinite(ctx.ratio[barIdx - 72]) && ctx.ratio[barIdx - 72] > 0
    ? side * Math.log(r / ctx.ratio[barIdx - 72]) * 100
    : NaN;
  const eth_btc_zscore_48 = Number.isFinite(ctx.z48[barIdx]) ? side * ctx.z48[barIdx] : NaN;
  const eth_btc_residual_12h_dir = Number.isFinite(ctx.resid12[barIdx]) ? side * ctx.resid12[barIdx] : NaN;

  return {
    ...base,
    eth_btc_ema20_dist,
    eth_btc_ema50_dist,
    eth_btc_ret_24h_dir,
    eth_btc_ret_72h_dir,
    eth_btc_zscore_48,
    eth_btc_residual_12h_dir,
  };
}

/**
 * ETH Dedicated 5Y Signal Generator:
 * Asset-calibrated HtfSmcMultiTrap (no BTC polarity flip) + optional CVD absorption filter
 * + optional ETH/BTC relative-strength alignment. Strictly causal.
 */
export function generateEthSignalsV6(ethDataset, btcDataset, spec, precomputed = null) {
  const baseSigs = generateSignals1h(ethDataset, spec, precomputed);
  const minDeltaRatio = spec.minDeltaRatio ?? null;
  const maxEbLagPct = spec.maxEbLagPct ?? null;
  if (minDeltaRatio === null && maxEbLagPct === null) {
    return baseSigs;
  }

  const rows = ethDataset.rows;
  let ethBtc = null;
  let ebEma50 = null;
  if (maxEbLagPct !== null) {
    assert.ok(btcDataset && Array.isArray(btcDataset.rows), 'Expected BTC dataset for ETH/BTC alignment');
    const btcRows = btcDataset.rows;
    ethBtc = new Float64Array(rows.length).fill(NaN);
    let j = -1;
    for (let i = 0; i < rows.length; i++) {
      while (j + 1 < btcRows.length && btcRows[j + 1].time <= rows[i].time) j++;
      if (j >= 0 && btcRows[j].close > 0) ethBtc[i] = rows[i].close / btcRows[j].close;
    }
    ebEma50 = calcPineEma(Array.from(ethBtc, v => (Number.isFinite(v) ? v : 0)), 50);
  }

  const out = [];
  for (const s of baseSigs) {
    const r = rows[s.barIndex];
    if (minDeltaRatio !== null) {
      const vol = r.volume > 0 ? r.volume : 0;
      const tbv = Number.isFinite(r.takerBuyVol) ? r.takerBuyVol : vol * 0.5;
      const dirDelta = vol > 0 ? s.side * ((2 * tbv - vol) / vol) : 0;
      if (dirDelta < minDeltaRatio) continue;
    }
    if (maxEbLagPct !== null && ethBtc && ebEma50) {
      const ratio = ethBtc[s.barIndex];
      const e50 = ebEma50[s.barIndex];
      if (Number.isFinite(ratio) && Number.isFinite(e50) && e50 > 0) {
        const dirRelPct = (s.side * (ratio - e50) / e50) * 100;
        if (dirRelPct < -maxEbLagPct) continue;
      }
    }
    out.push(s);
  }
  return out;
}

/**
 * SOL Dedicated 5Y Signal Generator:
 * High-beta Volatility-Compression Breakout / Trend-Pullback + Taker-Buy Thrust (takerBuyVol surge).
 * Strictly causal (bars <= i and aligned 4h <= rows[i].time).
 */
export function generateSolSignalsV6(solDataset, spec, precomputed = null) {
  assert.ok(solDataset && Array.isArray(solDataset.rows) && solDataset.rows.length > 0, 'Expected SOL dataset');
  const rows = solDataset.rows;
  const h4 = solDataset.htf?.['4h'];
  assert.ok(h4 && Array.isArray(h4.rows) && Array.isArray(h4.alignedIndex), 'SOL dataset missing 4h HTF');

  const f1 = precomputed?.f1 ?? computeOhlcFeatures1h(rows);
  const f4 = precomputed?.f4 ?? computeOhlcFeatures1h(h4.rows);

  const mode = spec.mode ?? 'TrendPbThrust';
  const warmup = spec.warmup ?? 250;
  const limitOffsetAtr = spec.limitOffsetAtr ?? 0.35;
  const thrustMin = spec.thrustMin ?? 0.55;
  const pbTouchAtr = spec.pbTouchAtr ?? 0.35;
  const pbBodyAtr = spec.pbBodyAtr ?? 0.35;
  const squeezeRatio = spec.squeezeRatio ?? 0.92;
  const sqLookback = spec.sqLookback ?? 14;
  const sqRvolMin = spec.sqRvolMin ?? 1.1;

  const signals = [];
  for (let i = warmup; i < rows.length; i++) {
    const r = rows[i];
    const prev = rows[i - 1];
    const c = r.close;
    const atr = f1.atr14[i];
    if (!Number.isFinite(atr) || atr <= 0) continue;

    const j4 = h4.alignedIndex[i];
    const h4C = h4.rows[j4].close;
    const h4E20 = f4.ema20[j4];
    const h4E50 = f4.ema50[j4];
    if (!Number.isFinite(h4E20) || !Number.isFinite(h4E50)) continue;

    const h4TrendBull = h4C > h4E20 && h4E20 > h4E50;
    const h4TrendBear = h4C < h4E20 && h4E20 < h4E50;

    const vol = Number.isFinite(r.volume) && r.volume > 0 ? r.volume : 0;
    const tbv = Number.isFinite(r.takerBuyVol) ? Math.min(vol, Math.max(0, r.takerBuyVol)) : vol * 0.5;
    const tbr = vol > 0 ? tbv / vol : 0.5;
    const body = c - r.open;

    // 1. Trend-Pullback + Taker-Buy Thrust
    const nearEmaBull = Number.isFinite(f1.ema20[i]) && r.low <= f1.ema20[i] + pbTouchAtr * atr && c > f1.ema20[i];
    const nearEmaBear = Number.isFinite(f1.ema20[i]) && r.high >= f1.ema20[i] - pbTouchAtr * atr && c < f1.ema20[i];
    const pbBull = h4TrendBull && nearEmaBull && body >= pbBodyAtr * atr && tbr >= thrustMin;
    const pbBear = h4TrendBear && nearEmaBear && -body >= pbBodyAtr * atr && (1 - tbr) >= thrustMin;

    // 2. Volatility-Compression Breakout + Taker-Buy Thrust
    let brkBull = false;
    let brkBear = false;
    if (mode === 'HybridSol' || mode === 'SqBrkThrust') {
      const prevAtr = f1.atr14[i - 1];
      const prevSma = f1.atrSma50[i - 1];
      const rv = f1.rvol20[i];
      const sqReady = Number.isFinite(prevAtr) && Number.isFinite(prevSma) && prevSma > 0 &&
        (prevAtr / prevSma) < squeezeRatio && Number.isFinite(rv) && rv >= sqRvolMin;
      brkBull = sqReady && h4TrendBull &&
        c > f1.prevHigh[sqLookback][i] && prev.close <= f1.prevHigh[sqLookback][i - 1] &&
        body >= pbBodyAtr * atr && tbr >= thrustMin;
      brkBear = sqReady && h4TrendBear &&
        c < f1.prevLow[sqLookback][i] && prev.close >= f1.prevLow[sqLookback][i - 1] &&
        -body >= pbBodyAtr * atr && (1 - tbr) >= thrustMin;
    }

    const bull = mode === 'SqBrkThrust' ? brkBull : (mode === 'HybridSol' ? (pbBull || brkBull) : pbBull);
    const bear = mode === 'SqBrkThrust' ? brkBear : (mode === 'HybridSol' ? (pbBear || brkBear) : pbBear);
    if (bull === bear) continue;

    const side = bull ? 1 : -1;
    const limitPrice = limitOffsetAtr > 0 ? c - side * limitOffsetAtr * atr : undefined;
    if (limitPrice !== undefined && (!Number.isFinite(limitPrice) || limitPrice <= 0)) continue;
    const sig = { barIndex: i, side, atr };
    if (limitPrice !== undefined) sig.limitPrice = limitPrice;
    signals.push(sig);
  }
  return signals;
}

export function buildEthCalValCatalogV6() {
  const specs = [];
  for (const htfMode of ['H4_20', 'H4_20_or_50']) {
    for (const trapMaxBars of [2, 3]) {
      for (const limitOffsetAtr of [0.22, 0.25]) {
        for (const minDeltaRatio of [null, -0.10]) {
          for (const stopAtr of [2.2, 2.5]) {
            for (const rewardRisk of [1.15, 1.25]) {
              const sigSpec = {
                specId: `ETH_5Y_${htfMode}_K${trapMaxBars}_off${limitOffsetAtr}_d${minDeltaRatio ?? 'all'}_s${stopAtr}_rr${rewardRisk}`,
                family: 'HtfSmcMultiTrap',
                lookback: 20,
                trapMaxBars,
                p4Lookback: 10,
                includePdhl: true,
                htfMode,
                limitOffsetAtr,
                minDeltaRatio,
                maxEbLagPct: null,
                warmup: 250,
              };
              const execOptions = {
                entryMode: 'LIMIT_PULLBACK',
                limitExpiryBars: 6,
                pendingPolicy: 'ignore',
                limitSameBarTp: 'close',
                cooldown: 4,
                warmup: 250,
                stopAtr,
                minStopPct: 1.6,
                rewardRisk,
                maxHoldBars: 96,
                beTriggerR: 0.43,
                beOffsetPct: 0.45,
                costPct: 0.10,
                slippagePct: 0.025,
                volNormRiskPct: 4.0,
                minLev: 1.0,
                maxLev: 2.5,
              };
              specs.push({ id: sigSpec.specId, sigSpec, execOptions });
            }
          }
        }
      }
    }
  }
  return specs;
}

export function buildSolCalValCatalogV6() {
  const specs = [];
  for (const mode of ['TrendPbThrust', 'HybridSol']) {
    for (const limitOffsetAtr of [0.28, 0.35]) {
      for (const thrustMin of [0.54, 0.55]) {
        for (const stopAtr of [2.0, 2.5]) {
          for (const [exitTag, exitOpts] of [
            ['BE', { rewardRisk: 1.25, beTriggerR: 0.43, beOffsetPct: 0.45, tp1TriggerR: 0, tp1QtyPct: 0, tp1LockOffsetR: 0, trailTriggerR: 0, trailAtrMult: 0 }],
            ['TP1_Trail', { rewardRisk: 2.0, beTriggerR: 0.43, beOffsetPct: 0.45, tp1TriggerR: 0.90, tp1QtyPct: 50, tp1LockOffsetR: 0.50, trailTriggerR: 1.10, trailAtrMult: 1.5 }],
          ]) {
            const sigSpec = {
              specId: `SOL_5Y_${mode}_off${limitOffsetAtr}_th${thrustMin}_s${stopAtr}_${exitTag}`,
              mode,
              limitOffsetAtr,
              thrustMin,
              pbTouchAtr: 0.35,
              pbBodyAtr: 0.35,
              squeezeRatio: 0.92,
              sqLookback: 14,
              sqRvolMin: 1.1,
              warmup: 250,
            };
            const execOptions = {
              entryMode: 'LIMIT_PULLBACK',
              limitExpiryBars: 6,
              pendingPolicy: 'ignore',
              limitSameBarTp: 'close',
              cooldown: 4,
              warmup: 250,
              stopAtr,
              minStopPct: 1.6,
              maxHoldBars: 96,
              costPct: 0.10,
              slippagePct: 0.025,
              volNormRiskPct: 4.0,
              minLev: 1.0,
              maxLev: 2.5,
              ...exitOpts,
            };
            specs.push({ id: sigSpec.specId, sigSpec, execOptions });
          }
        }
      }
    }
  }
  return specs;
}

export function calibrateAltStructuralCalValV6(sym, dsCV, btcCV = null) {
  const n = dsCV.rows.length;
  const calEnd = Math.floor((0.50 / 0.80) * n);
  const isEth = sym === 'ETHUSDT';
  const catalog = isEth ? buildEthCalValCatalogV6() : buildSolCalValCatalogV6();
  const pre = {
    f1: computeOhlcFeatures1h(dsCV.rows),
    f4: computeOhlcFeatures1h(dsCV.htf['4h'].rows),
    fD: dsCV.htf['1d'] ? computeOhlcFeatures1h(dsCV.htf['1d'].rows) : null,
    rawSignalsByKey: new Map(),
    virtTradesByKey: new Map(),
  };

  let best = null;
  for (const cand of catalog) {
    const signals = isEth
      ? generateEthSignalsV6(dsCV, btcCV, cand.sigSpec, pre)
      : generateSolSignalsV6(dsCV, cand.sigSpec, pre);

    const simCV = simulateTradesV6(dsCV.rows, signals, {
      ...cand.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      start: 0,
      end: n,
      intervalSeconds: 3600,
    });
    const simCal = summarizePerformanceV6(simCV.trades, dsCV.rows, 0, calEnd);
    const simVal = summarizePerformanceV6(simCV.trades, dsCV.rows, calEnd, n);

    const wrCV = simCV.winRatePct ?? 0;
    const pfCV = simCV.profitFactor ?? 0;
    const calmarCV = (simCV.compoundedMaxDrawdownPct ?? 100) > 0
      ? (simCV.compoundedNetPct ?? 0) / simCV.compoundedMaxDrawdownPct
      : 0;
    const eligible = (simCV.count ?? 0) >= 160
      && (simCal.count ?? 0) >= 90
      && (simVal.count ?? 0) >= 60
      && wrCV >= 65.0
      && pfCV >= 1.25
      && (simCal.profitFactor ?? 0) >= 1.15
      && (simVal.profitFactor ?? 0) >= 1.15;

    const score = (eligible ? 10000 : 0)
      + (simCV.compoundedNetPct ?? 0)
      + 30 * calmarCV
      + 80 * (pfCV - 1)
      + 2 * (wrCV - 65);
    if (!best || score > best.score) {
      best = { score, eligible, cand };
    }
  }
  return best.cand;
}

function loadCrypto5y(sym) {
  const map = {
    BTCUSDT: 'crypto5y_btcusdt_1h.json',
    ETHUSDT: 'crypto5y_ethusdt_1h.json',
    SOLUSDT: 'crypto5y_solusdt_1h.json',
    BNBUSDT: 'crypto5y_bnbusdt_1h.json',
  };
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, map[sym]), 'utf8'));
}

function formatPerf(p) {
  return {
    count: p.count,
    wins: p.wins,
    losses: p.losses,
    winRatePct: Number((p.winRatePct ?? 0).toFixed(2)),
    profitFactor: Number((p.profitFactor ?? 0).toFixed(2)),
    totalNetPct: Number((p.totalNetPct ?? 0).toFixed(2)),
    compoundedNetPct: Number((p.compoundedNetPct ?? 0).toFixed(2)),
    cagrPct: Number((p.cagrPct ?? 0).toFixed(2)),
    maxDrawdownPct: Number((p.maxDrawdownPct ?? 0).toFixed(2)),
    compoundedMaxDrawdownPct: Number((p.compoundedMaxDrawdownPct ?? 0).toFixed(2)),
    sharpe: Number((p.sharpe ?? 0).toFixed(2)),
    sortino: Number((p.sortino ?? 0).toFixed(2)),
    calmar: Number((p.calmar ?? 0).toFixed(2)),
    retToDd: Number((p.retToDd ?? 0).toFixed(2)),
    buyHoldPct: Number((p.buyHoldPct ?? 0).toFixed(2)),
    buyHoldMaxDdPct: Number((p.buyHoldMaxDdPct ?? 0).toFixed(2)),
  };
}

export function applyAltModelToSignalsV6(sym, ds, btcDs, signals, alignedFunding, modelSpec) {
  const isEth = sym === 'ETHUSDT';
  const ctx = isEth
    ? precomputeEthCrossContextV6(ds, btcDs, alignedFunding)
    : precomputeOrderflowContextV6(ds, alignedFunding);

  const filtered = [];
  for (const s of signals) {
    const f = isEth
      ? extractEthCandidateFeaturesV6(ds, btcDs, s, s.barIndex, alignedFunding, ctx)
      : extractCandidateFeaturesV6(ds, s, s.barIndex, alignedFunding, ctx);
    const sc = scoreCandidateV5(f, modelSpec);
    if (sc.pass) {
      filtered.push({
        ...s,
        sizeMult: sc.sizeMult,
        meta: { ...(s.meta ?? {}), probWin: sc.probWin, sizeMult: sc.sizeMult },
      });
    }
  }
  return filtered;
}

function extractCalValPayload() {
  const btcFull = loadCrypto5y('BTCUSDT');
  const nBtc = btcFull.rows.length;
  const btcValEnd = Math.floor(0.80 * nBtc);
  const btcCV = sliceDatasetPrefixV6(btcFull, btcValEnd);

  const out = {};
  for (const sym of ['ETHUSDT', 'SOLUSDT']) {
    const full = loadCrypto5y(sym);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV6(full, valEnd);
    const alignedFundingCV = alignFundingToBarsCausal(dsCV.rows, dsCV.fundingRows ?? []);
    const structural = calibrateAltStructuralCalValV6(sym, dsCV, sym === 'ETHUSDT' ? btcCV : null);

    const signals = sym === 'ETHUSDT'
      ? generateEthSignalsV6(dsCV, btcCV, structural.sigSpec)
      : generateSolSignalsV6(dsCV, structural.sigSpec);

    const isEth = sym === 'ETHUSDT';
    const featureNames = isEth ? ETH_FEATURE_NAMES_V6 : SOL_FEATURE_NAMES_V6;
    const ctx = isEth
      ? precomputeEthCrossContextV6(dsCV, btcCV, alignedFundingCV)
      : precomputeOrderflowContextV6(dsCV, alignedFundingCV);

    const sigFeatures = signals.map(s => {
      const fmap = isEth
        ? extractEthCandidateFeaturesV6(dsCV, btcCV, s, s.barIndex, alignedFundingCV, ctx)
        : extractCandidateFeaturesV6(dsCV, s, s.barIndex, alignedFundingCV, ctx);
      return {
        barIndex: s.barIndex,
        side: s.side,
        atr: s.atr,
        limitPrice: s.limitPrice ?? null,
        vec: featureNames.map(k => (Number.isFinite(fmap[k]) ? fmap[k] : null)),
      };
    });

    const baseOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      intervalSeconds: 3600,
    };
    const simCal = simulateTradesV6(dsCV.rows, signals, { ...baseOpts, start: 0, end: calEnd });
    const simVal = simulateTradesV6(dsCV.rows, signals, { ...baseOpts, start: calEnd, end: valEnd });
    const sigIdxByBar = new Map(signals.map((s, idx) => [s.barIndex, idx]));

    const calSequential = simCal.trades
      .filter(t => t.signalIndex >= 0 && t.exitIndex < calEnd)
      .map(t => ({ idx: sigIdxByBar.get(t.signalIndex), barIndex: t.signalIndex, y: t.netPct > 0 ? 1 : 0, netPct: t.netPct }));
    const valSequential = simVal.trades
      .filter(t => t.signalIndex >= calEnd && t.exitIndex < valEnd)
      .map(t => ({ idx: sigIdxByBar.get(t.signalIndex), barIndex: t.signalIndex, y: t.netPct > 0 ? 1 : 0, netPct: t.netPct }));

    const baseValPerf = summarizePerformanceV6(simVal.trades, dsCV.rows, calEnd, valEnd, { periodYears: (valEnd - calEnd) / 8760 });
    out[sym] = {
      symbol: sym,
      totalBarsFull: n,
      calEnd,
      valEnd,
      featureNames,
      structuralSpec: structural,
      signals: sigFeatures,
      calSequential,
      valSequential,
      baseVal: formatPerf(baseValPerf),
    };
  }
  return out;
}

function evalValBatch(req) {
  const btcFull = loadCrypto5y('BTCUSDT');
  const btcCV = sliceDatasetPrefixV6(btcFull, Math.floor(0.80 * btcFull.rows.length));

  const out = {};
  for (const sym of ['ETHUSDT', 'SOLUSDT']) {
    const full = loadCrypto5y(sym);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV6(full, valEnd);
    const payload = req[sym];
    const structural = payload.structuralSpec;
    const items = payload.items;
    const baseSignals = sym === 'ETHUSDT'
      ? generateEthSignalsV6(dsCV, btcCV, structural.sigSpec)
      : generateSolSignalsV6(dsCV, structural.sigSpec);

    const execOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      intervalSeconds: 3600,
    };

    const rowsVal = dsCV.rows.slice(calEnd, valEnd);
    const valYears = rowsVal.length / 8760;
    const cache = new Map();
    const results = [];
    for (const cand of items) {
      const filteredVal = [];
      const keyParts = [];
      const isFlat = !cand.sizeCurve || cand.sizeCurve.mode === 'flat';
      for (let k = 0; k < baseSignals.length; k++) {
        const s = baseSignals[k];
        if (s.barIndex < calEnd || s.barIndex >= valEnd) continue;
        const p = cand.probs[k];
        if (p >= cand.threshold) {
          let sizeMult = 1.0;
          if (!isFlat && cand.sizeCurve.mode === 'linear') {
            const pMax = cand.sizeCurve.pMax;
            const u = Math.max(0, Math.min(1, (p - cand.threshold) / Math.max(1e-6, pMax - cand.threshold)));
            sizeMult = cand.sizeCurve.minMult + u * (cand.sizeCurve.maxMult - cand.sizeCurve.minMult);
          }
          filteredVal.push({ ...s, barIndex: s.barIndex - calEnd, sizeMult });
          if (isFlat) keyParts.push(k);
        }
      }
      let metrics;
      if (isFlat) {
        const cKey = keyParts.join(',');
        metrics = cache.get(cKey);
        if (!metrics) {
          const simV = simulateTradesV6(rowsVal, filteredVal, { ...execOpts, start: 0, end: rowsVal.length, warmup: 0 });
          metrics = formatPerf(summarizePerformanceV6(simV.trades, rowsVal, 0, rowsVal.length, { periodYears: valYears }));
          cache.set(cKey, metrics);
        }
      } else {
        const simV = simulateTradesV6(rowsVal, filteredVal, { ...execOpts, start: 0, end: rowsVal.length, warmup: 0 });
        metrics = formatPerf(summarizePerformanceV6(simV.trades, rowsVal, 0, rowsVal.length, { periodYears: valYears }));
      }
      results.push({ id: cand.id, val: metrics });
    }
    out[sym] = results;
  }
  return out;
}

export function evaluateAltAssetV6(sym, modelSpec, execProfile = 'EXCHANGE_POST_ONLY') {
  const ds = loadCrypto5y(sym);
  const btcDs = sym === 'ETHUSDT' ? loadCrypto5y('BTCUSDT') : null;
  const n = ds.rows.length;
  const calEnd = Math.floor(0.50 * n);
  const valEnd = Math.floor(0.80 * n);
  const alignedFunding = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
  const structural = modelSpec.structuralSpec;

  const rawSignals = sym === 'ETHUSDT'
    ? generateEthSignalsV6(ds, btcDs, structural.sigSpec)
    : generateSolSignalsV6(ds, structural.sigSpec);
  const mlSignals = applyAltModelToSignalsV6(sym, ds, btcDs, rawSignals, alignedFunding, modelSpec);

  const opts = {
    ...structural.execOptions,
    execProfile,
    fundingRows: ds.fundingRows,
    fundingPctPer8h: 0.01,
    intervalSeconds: 3600,
    start: 0,
    end: n,
  };

  const simBase = simulateTradesV6(ds.rows, rawSignals, opts);
  const simMl = simulateTradesV6(ds.rows, mlSignals, opts);

  const summarize = (trades, lo, hi) => formatPerf(
    summarizePerformanceV6(trades, ds.rows, lo, hi, { periodYears: (hi - lo) / 8760 }),
  );

  const yearSize = Math.floor(n / 5);
  const yearlyBase = [];
  const yearlyMl = [];
  for (let y = 0; y < 5; y++) {
    const lo = y * yearSize;
    const hi = y === 4 ? n : (y + 1) * yearSize;
    yearlyBase.push({ year: `Y${y + 1}`, range: [lo, hi], ...summarize(simBase.trades, lo, hi) });
    yearlyMl.push({ year: `Y${y + 1}`, range: [lo, hi], ...summarize(simMl.trades, lo, hi) });
  }

  return {
    symbol: sym,
    execProfile,
    bars: n,
    splits: { cal: [0, calEnd], val: [calEnd, valEnd], holdoutY5: [valEnd, n] },
    rows: ds.rows,
    signalCounts: { raw: rawSignals.length, mlFiltered: mlSignals.length },
    baselineTrades: simBase.trades,
    mlTrades: simMl.trades,
    baseline: {
      cal: summarize(simBase.trades, 0, calEnd),
      val: summarize(simBase.trades, calEnd, valEnd),
      holdoutY5: summarize(simBase.trades, valEnd, n),
      full5y: summarize(simBase.trades, 0, n),
      yearly: yearlyBase,
    },
    ml: {
      cal: summarize(simMl.trades, 0, calEnd),
      val: summarize(simMl.trades, calEnd, valEnd),
      holdoutY5: summarize(simMl.trades, valEnd, n),
      full5y: summarize(simMl.trades, 0, n),
      yearly: yearlyMl,
    },
  };
}

function checkHoldoutY5Gate(perf) {
  return (
    perf.count >= PROMOTION_GATE_V6.minHoldoutY5Trades &&
    perf.winRatePct >= PROMOTION_GATE_V6.minHoldoutY5WinRatePct &&
    perf.totalNetPct > PROMOTION_GATE_V6.minHoldoutY5NetPct &&
    perf.profitFactor >= PROMOTION_GATE_V6.minHoldoutY5ProfitFactor
  );
}

function formatPortfolioSummaryV6(p) {
  return {
    count: p.count,
    wins: p.wins,
    losses: p.losses,
    winRatePct: Number((p.winRatePct ?? 0).toFixed(2)),
    profitFactor: Number((p.profitFactor ?? 0).toFixed(2)),
    totalNetPct: Number((p.totalNetPct ?? 0).toFixed(2)),
    compoundedNetPct: Number((p.compoundedNetPct ?? 0).toFixed(2)),
    cagrPct: Number((p.cagrPct ?? 0).toFixed(2)),
    maxDrawdownPct: Number((p.maxDrawdownPct ?? 0).toFixed(2)),
    compoundedMaxDrawdownPct: Number((p.compoundedMaxDrawdownPct ?? 0).toFixed(2)),
    sharpe: Number((p.sharpe ?? 0).toFixed(2)),
    sortino: Number((p.sortino ?? 0).toFixed(2)),
    calmar: Number((p.calmar ?? 0).toFixed(2)),
    retToDd: Number((p.retToDd ?? 0).toFixed(2)),
    peakOpenLev: Number((p.peakOpenLev ?? 0).toFixed(2)),
    scaledByCapCount: p.scaledByCapCount,
    skippedByCapCount: p.skippedByCapCount,
    perStream: p.perStream,
  };
}

function buildPortfolioSplitsV6(streams, calEnd, valEnd, n) {
  const filterRange = (tr, lo, hi) => tr.filter(t => t.signalIndex >= lo && t.exitIndex < hi);
  const runSlice = (lo, hi) => {
    const years = (hi - lo) / 8760;
    const sliced = streams.map(st => ({
      id: st.id,
      rows: st.rows,
      trades: filterRange(st.trades, lo, hi),
      intervalSeconds: 3600,
    }));
    return formatPortfolioSummaryV6(simulatePortfolioV6(sliced, { maxTotalOpenLev: 4.0, periodYears: years }));
  };
  return {
    cal: runSlice(0, calEnd),
    val: runSlice(calEnd, valEnd),
    holdoutY5: runSlice(valEnd, n),
    full5y: runSlice(0, n),
  };
}

export async function runSuiteV6EthSol() {
  const modelsPath = path.join(RESULTS_V6_DIR, 'models_eth_sol_5y.json');
  const modelsJson = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));

  const results = {};
  const qualifiedAltSymbols = [];
  const altStreamsByProfile = { EXCHANGE_POST_ONLY: {}, STRICT_TAKER: {} };

  for (const sym of ['ETHUSDT', 'SOLUSDT']) {
    results[sym] = {};
    for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
      const r = evaluateAltAssetV6(sym, modelsJson.models[sym], prof);
      altStreamsByProfile[prof][sym] = { id: `${sym.replace('USDT', '')}_5Y`, rows: r.rows, trades: r.mlTrades };
      const { rows, baselineTrades, mlTrades, ...clean } = r;
      results[sym][prof] = clean;
    }

    const postPass = checkHoldoutY5Gate(results[sym].EXCHANGE_POST_ONLY.ml.holdoutY5);
    const takerPass = checkHoldoutY5Gate(results[sym].STRICT_TAKER.ml.holdoutY5);
    const qualifiedForLive = postPass && takerPass;

    modelsJson.models[sym].qualifiedForLive = qualifiedForLive;
    modelsJson.models[sym].holdoutY5Gate = {
      evaluatedAt: new Date().toISOString(),
      qualifiedForLive,
      postOnlyPassY5: postPass,
      strictTakerPassY5: takerPass,
      postOnlyY5: results[sym].EXCHANGE_POST_ONLY.ml.holdoutY5,
      strictTakerY5: results[sym].STRICT_TAKER.ml.holdoutY5,
    };
    results[sym].qualifiedForLive = qualifiedForLive;
    results[sym].gateCheck = { postOnlyPassY5: postPass, strictTakerPassY5: takerPass };
    if (qualifiedForLive) qualifiedAltSymbols.push(sym);

    console.log(`\n=== [${sym} 5Y] qualifiedForLive=${qualifiedForLive} (PostOnlyY5=${postPass}, StrictTakerY5=${takerPass}) ===`);
    for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
      const b = results[sym][prof].baseline;
      const m = results[sym][prof].ml;
      console.log(`  ${prof} Base | Cal: WR=${b.cal.winRatePct}% PF=${b.cal.profitFactor} Comp=${b.cal.compoundedNetPct}% | Val: WR=${b.val.winRatePct}% PF=${b.val.profitFactor} Comp=${b.val.compoundedNetPct}% | Y5: n=${b.holdoutY5.count} WR=${b.holdoutY5.winRatePct}% PF=${b.holdoutY5.profitFactor} Net=${b.holdoutY5.totalNetPct}% Comp=${b.holdoutY5.compoundedNetPct}% | 5Y: WR=${b.full5y.winRatePct}% PF=${b.full5y.profitFactor} Comp=${b.full5y.compoundedNetPct}% DD=${b.full5y.compoundedMaxDrawdownPct}%`);
      console.log(`  ${prof} ML   | Cal: WR=${m.cal.winRatePct}% PF=${m.cal.profitFactor} Comp=${m.cal.compoundedNetPct}% | Val: WR=${m.val.winRatePct}% PF=${m.val.profitFactor} Comp=${m.val.compoundedNetPct}% | Y5: n=${m.holdoutY5.count} WR=${m.holdoutY5.winRatePct}% PF=${m.holdoutY5.profitFactor} Net=${m.holdoutY5.totalNetPct}% Comp=${m.holdoutY5.compoundedNetPct}% | 5Y: WR=${m.full5y.winRatePct}% PF=${m.full5y.profitFactor} Comp=${m.full5y.compoundedNetPct}% DD=${m.full5y.compoundedMaxDrawdownPct}%`);
    }
  }

  modelsJson.holdoutEvaluatedAt = new Date().toISOString();
  modelsJson.qualifiedSymbols = qualifiedAltSymbols;
  fs.writeFileSync(modelsPath, JSON.stringify(modelsJson, null, 2) + '\n');

  // 4-Crypto (BTC + ETH + SOL + BNB) 5-Year Portfolio via simulatePortfolioV6
  const portfolio4Crypto = {};
  const ethMeta = results.ETHUSDT.EXCHANGE_POST_ONLY;
  const nBars = ethMeta.bars;
  const [calEnd, valEnd] = [ethMeta.splits.cal[1], ethMeta.splits.val[1]];
  for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
    const btcBnb = getBtcBnbPortfolioStreamsV6(prof);
    const qualifiedStreams = [
      { id: btcBnb.BTCUSDT.id, rows: btcBnb.BTCUSDT.rows, trades: btcBnb.BTCUSDT.trades },
      { id: btcBnb.BNBUSDT.id, rows: btcBnb.BNBUSDT.rows, trades: btcBnb.BNBUSDT.trades },
      ...qualifiedAltSymbols.map(s => altStreamsByProfile[prof][s]),
    ];
    const all4Streams = [
      { id: btcBnb.BTCUSDT.id, rows: btcBnb.BTCUSDT.rows, trades: btcBnb.BTCUSDT.trades },
      altStreamsByProfile[prof].ETHUSDT,
      altStreamsByProfile[prof].SOLUSDT,
      { id: btcBnb.BNBUSDT.id, rows: btcBnb.BNBUSDT.rows, trades: btcBnb.BNBUSDT.trades },
    ];
    portfolio4Crypto[prof] = {
      qualifiedStreams: qualifiedStreams.map(s => s.id),
      qualifiedOnly: buildPortfolioSplitsV6(qualifiedStreams, calEnd, valEnd, nBars),
      full4CryptoAllCoins: buildPortfolioSplitsV6(all4Streams, calEnd, valEnd, nBars),
    };
  }

  console.log('\n=== 4-CRYPTO 5Y PORTFOLIO (simulatePortfolioV6, maxTotalOpenLev=4.0) ===');
  for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
    const p = portfolio4Crypto[prof];
    console.log(`  [${prof}] Qualified (${p.qualifiedStreams.join(', ')}) | Y5: WR=${p.qualifiedOnly.holdoutY5.winRatePct}% PF=${p.qualifiedOnly.holdoutY5.profitFactor} Comp=${p.qualifiedOnly.holdoutY5.compoundedNetPct}% | 5Y: n=${p.qualifiedOnly.full5y.count} WR=${p.qualifiedOnly.full5y.winRatePct}% PF=${p.qualifiedOnly.full5y.profitFactor} Comp=${p.qualifiedOnly.full5y.compoundedNetPct}% CAGR=${p.qualifiedOnly.full5y.cagrPct}% DD=${p.qualifiedOnly.full5y.compoundedMaxDrawdownPct}% Calmar=${p.qualifiedOnly.full5y.calmar}`);
    console.log(`  [${prof}] Full 4-Crypto (BTC+ETH+SOL+BNB)     | Y5: WR=${p.full4CryptoAllCoins.holdoutY5.winRatePct}% PF=${p.full4CryptoAllCoins.holdoutY5.profitFactor} Comp=${p.full4CryptoAllCoins.holdoutY5.compoundedNetPct}% | 5Y: n=${p.full4CryptoAllCoins.full5y.count} WR=${p.full4CryptoAllCoins.full5y.winRatePct}% PF=${p.full4CryptoAllCoins.full5y.profitFactor} Comp=${p.full4CryptoAllCoins.full5y.compoundedNetPct}% CAGR=${p.full4CryptoAllCoins.full5y.cagrPct}% DD=${p.full4CryptoAllCoins.full5y.compoundedMaxDrawdownPct}% Calmar=${p.full4CryptoAllCoins.full5y.calmar}`);
  }

  const summary = {
    schema: 'smc-v6-eth-sol-5y-summary-v1',
    generatedAt: new Date().toISOString(),
    promotionGateCriteria: PROMOTION_GATE_V6,
    qualifiedForLiveAltcoins: qualifiedAltSymbols,
    modelMetadata: {
      ETHUSDT: modelsJson.models.ETHUSDT.selectionMeta,
      SOLUSDT: modelsJson.models.SOLUSDT.selectionMeta,
    },
    assets: results,
    portfolio4Crypto,
  };

  fs.mkdirSync(RESULTS_V6_DIR, { recursive: true });
  const outPath = path.join(RESULTS_V6_DIR, 'crypto_eth_sol_5y.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n[suite_v6_eth_sol] Wrote ${path.relative(ROOT_DIR, outPath)} & updated models_eth_sol_5y.json`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--extract-cal-val')) {
    process.stdout.write(JSON.stringify(extractCalValPayload()));
  } else if (process.argv.includes('--eval-val')) {
    const req = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(evalValBatch(req)));
  } else {
    runSuiteV6EthSol().catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}
