import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTradesV7, summarizeMonthlyCashflowV7 } from './sim_engine_v7.mjs';
import { alignFundingToBarsCausal } from './fetch_okx_derivs.mjs';
import { computeOhlcFeatures1h, sliceDatasetPrefix1h } from './signals_1h.mjs';
import { calcPineAtr, calcPineEma, calcPineRsi, alignHtfClosedIndices } from './signals_15m.mjs';
import { precompute15mV4, generateSignals15mV4, sliceDatasetPrefix15m } from './signals_15m_v4.mjs';
import {
  FEATURE_NAMES_V6,
  precomputeOrderflowContextV6,
  extractCandidateFeaturesV6,
  generateBtcSignalsV6,
  generateBnbSignalsV6,
} from './suite_v6_btc_bnb.mjs';
import { scoreCandidateV5 } from './ml_inference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V7_DIR = path.join(HERE, 'results_v7');

export const V7_STREAM_KEYS = Object.freeze(['BTC_1h', 'BTC_15m', 'BNB_1h', 'BNB_15m']);

export function sliceDatasetPrefixV7(dataset, endLength) {
  const sliced = dataset.intervalSeconds <= 900
    ? sliceDatasetPrefix15m(dataset, endLength)
    : sliceDatasetPrefix1h(dataset, endLength);
  if (Array.isArray(dataset.fundingRows)) {
    const lastTime = sliced.lastTime;
    sliced.fundingRows = dataset.fundingRows.filter(f => f.time <= lastTime);
  }
  return sliced;
}

export function precompute15mV7(dataset) {
  const pre4 = precompute15mV4(dataset);
  const rows = dataset.rows;
  const tbr15 = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const vol = rows[i].volume > 0 ? rows[i].volume : 0;
    const tbv = Number.isFinite(rows[i].takerBuyVol) ? Math.min(vol, Math.max(0, rows[i].takerBuyVol)) : vol * 0.5;
    tbr15[i] = vol > 0 ? tbv / vol : 0.5;
  }
  const h1Rows = pre4.h1Rows;
  const tbr1h = new Float64Array(h1Rows.length);
  for (let j = 0; j < h1Rows.length; j++) {
    const vol = h1Rows[j].volume > 0 ? h1Rows[j].volume : 0;
    const tbv = Number.isFinite(h1Rows[j].takerBuyVol) ? Math.min(vol, Math.max(0, h1Rows[j].takerBuyVol)) : vol * 0.5;
    tbr1h[j] = vol > 0 ? tbv / vol : 0.5;
  }
  return { ...pre4, tbr15, tbr1h };
}

/**
 * Causal 15m High-WR signal generator:
 * - 'H1_CleanDisp_OF': 1H closed displacement + 4H trend bias + exhaustion guard + takerBuyVol confirmation + pullback limit
 * - 'M15_V4': delegates to causal generateSignals15mV4 (M15_H1SyncedMultiTrap / M15_H4Disp) + optional orderflow filter
 */
export function generate15mSignalsV7(dataset, spec, precomputed = null) {
  if (spec.family === 'H1_CleanDisp_OF') {
    const pre = precomputed ?? precompute15mV7(dataset);
    const { rows, h1Rows, h4Rows, aligned1h, aligned4h } = pre;
    const warmup = spec.warmup ?? 250;
    const h1BodyAtrMin = spec.h1BodyAtrMin ?? 0.90;
    const h1ClosePosMin = spec.h1ClosePosMin ?? 0.62;
    const minAtrPct = spec.minAtrPct ?? 0.14;
    const h1RsiExh = spec.h1RsiExh ?? 72;
    const emaExhAtr = spec.emaExhAtr ?? 1.9;
    const tbrMin = spec.tbrMin ?? 0.48;
    const pullAtr = spec.pullAtr ?? 0.45;
    const htfMode = spec.htfMode ?? 'H4_50';

    const signals = [];
    for (let i = warmup; i < rows.length; i++) {
      const j1 = aligned1h[i];
      const prevJ1 = aligned1h[i - 1];
      if (j1 === prevJ1 || j1 < 50) continue; // fire strictly on newly closed 1h bar

      const j4 = aligned4h[i];
      if (j4 < 50) continue;
      const h1 = h1Rows[j1];
      const h4 = h4Rows[j4];
      const h1Atr = pre.h1Atr14[j1];
      const h1Ema = htfMode === 'H4_20' ? pre.h1Ema20[j1] : pre.h1Ema50[j1];
      const h1Rsi = pre.h1Rsi14[j1];
      const h4Ema = htfMode === 'H4_20' ? pre.h4Ema20[j4] : pre.h4Ema50[j4];
      const ltfAtr = pre.ltfAtr14[i];
      if (!Number.isFinite(h1Atr) || h1Atr <= 0 || !Number.isFinite(h1Ema) || !Number.isFinite(h1Rsi) || !Number.isFinite(h4Ema) || !Number.isFinite(ltfAtr) || ltfAtr <= 0) {
        continue;
      }

      const atrPct = (ltfAtr / rows[i].close) * 100;
      if (atrPct < minAtrPct) continue;

      const rng1h = h1.high - h1.low;
      if (rng1h <= 0) continue;
      const body1h = h1.close - h1.open;
      const posB = (h1.close - h1.low) / rng1h;
      const posS = (h1.high - h1.close) / rng1h;
      const tbr1h = pre.tbr1h[j1];

      const bullTrend = h4.close > h4Ema && h1.close > h1Ema;
      const bearTrend = h4.close < h4Ema && h1.close < h1Ema;
      const notExhB = h1Rsi < h1RsiExh && (h1.close - h1Ema) / h1Atr < emaExhAtr;
      const notExhS = h1Rsi > (100 - h1RsiExh) && (h1Ema - h1.close) / h1Atr < emaExhAtr;

      const bull = bullTrend && notExhB && body1h >= h1BodyAtrMin * h1Atr && posB >= h1ClosePosMin && tbr1h >= tbrMin;
      const bear = bearTrend && notExhS && -body1h >= h1BodyAtrMin * h1Atr && posS >= h1ClosePosMin && (1 - tbr1h) >= tbrMin;

      if (bull === bear) continue;
      const side = bull ? 1 : -1;
      const sig = { barIndex: i, side, atr: ltfAtr };
      if (pullAtr > 0) {
        const limitPrice = rows[i].close - side * pullAtr * ltfAtr;
        if (!Number.isFinite(limitPrice) || limitPrice <= 0) continue;
        sig.limitPrice = limitPrice;
      }
      signals.push(sig);
    }
    return signals;
  }

  const pre = precomputed ?? precompute15mV7(dataset);
  const sigs = generateSignals15mV4(dataset, spec, pre);
  if (spec.tbrMin && spec.tbrMin > 0) {
    return sigs.filter(s => {
      const tbr = pre.tbr15[s.barIndex];
      return s.side === 1 ? tbr >= spec.tbrMin : (1 - tbr) >= spec.tbrMin;
    });
  }
  return sigs;
}

export function generateStreamSignalsV7(streamKey, dataset, spec, alignedFunding = null, precomputed = null) {
  if (streamKey === 'BTC_1h') return generateBtcSignalsV6(dataset, spec, precomputed);
  if (streamKey === 'BNB_1h') return generateBnbSignalsV6(dataset, spec, alignedFunding);
  return generate15mSignalsV7(dataset, spec, precomputed);
}

function build1hHighWrCatalogV7(coin) {
  const isBtc = coin === 'BTCUSDT';
  const specs = [];
  const htfModes = isBtc ? ['H4_50'] : ['H4_20', 'H4_50'];
  const offs = isBtc ? [0.18, 0.22] : [0.22, 0.28];
  const stops = isBtc ? [[3.2, 1.4]] : [[3.0, 1.3], [3.4, 1.4]];
  const exitCombos = isBtc
    ? [
        { tp1TriggerR: 0.55, tp1QtyPct: 50, tp1LockOffsetR: 0.20, rewardRisk: 1.30, beTriggerR: 0.34, beOffsetPct: 0.24 },
        { tp1TriggerR: 0.60, tp1QtyPct: 50, tp1LockOffsetR: 0.35, rewardRisk: 1.25, beTriggerR: 0.38, beOffsetPct: 0.25 },
        { tp1TriggerR: 0.70, tp1QtyPct: 45, tp1LockOffsetR: 0.25, rewardRisk: 1.40, beTriggerR: 0.38, beOffsetPct: 0.28 },
      ]
    : [
        { tp1TriggerR: 0.52, tp1QtyPct: 50, tp1LockOffsetR: 0.18, rewardRisk: 1.35, beTriggerR: 0.32, beOffsetPct: 0.24 },
        { tp1TriggerR: 0.58, tp1QtyPct: 50, tp1LockOffsetR: 0.22, rewardRisk: 1.40, beTriggerR: 0.35, beOffsetPct: 0.26 },
        { tp1TriggerR: 0.65, tp1QtyPct: 45, tp1LockOffsetR: 0.20, rewardRisk: 1.50, beTriggerR: 0.36, beOffsetPct: 0.28 },
      ];

  for (const htfMode of htfModes) {
    for (const limitOffsetAtr of offs) {
      for (const [stopAtr, minStopPct] of stops) {
        for (const ex of exitCombos) {
          const virtExec = {
            entryMode: 'LIMIT_PULLBACK',
            limitExpiryBars: 6,
            pendingPolicy: 'ignore',
            limitSameBarTp: 'close',
            cooldown: 4,
            warmup: 250,
            stopAtr,
            minStopPct,
            rewardRisk: ex.rewardRisk,
            maxHoldBars: 96,
            beTriggerR: ex.beTriggerR,
            beOffsetPct: ex.beOffsetPct,
            costPct: 0.10,
            slippagePct: 0.025,
          };
          const sigSpec = {
            specId: `${coin}_1h_V7_${htfMode}_off${limitOffsetAtr}_s${stopAtr}_tp1_${ex.tp1TriggerR}_rr${ex.rewardRisk}`,
            family: 'AdaptiveTrapPolarity',
            baseFamily: 'HtfSmcMultiTrap',
            lookback: 20,
            trapMaxBars: 4,
            p4Lookback: 10,
            includePdhl: true,
            htfMode,
            limitOffsetAtr,
            winLen: 6,
            slThresh: 2,
            requireNegNet: true,
            sharedHistory: false,
            virtExec,
          };
          const execOptions = {
            ...virtExec,
            tp1TriggerR: ex.tp1TriggerR,
            tp1QtyPct: ex.tp1QtyPct,
            tp1FeeMode: 'MAKER',
            tp1LockOffsetR: ex.tp1LockOffsetR,
            volNormRiskPct: isBtc ? 4.0 : 3.5,
            minLev: 1.2,
            maxLev: isBtc ? 3.0 : 2.5,
          };
          specs.push({ id: sigSpec.specId, sigSpec, execOptions });
        }
      }
    }
  }
  return specs;
}

function build15mHighWrCatalogV7(coin) {
  const specs = [];
  const exitCombos = [
    { tp1TriggerR: 0.45, tp1QtyPct: 50, tp1LockOffsetR: 0.14, rewardRisk: 1.50, beTriggerR: 0.26, beOffsetPct: 0.20 },
    { tp1TriggerR: 0.52, tp1QtyPct: 50, tp1LockOffsetR: 0.18, rewardRisk: 1.65, beTriggerR: 0.32, beOffsetPct: 0.24 },
    { tp1TriggerR: 0.58, tp1QtyPct: 45, tp1LockOffsetR: 0.20, rewardRisk: 1.80, beTriggerR: 0.36, beOffsetPct: 0.28 },
  ];

  // Family 1: M15_H4Disp (H4 displacement pullback with runner-friendly TP1 lock)
  for (const htfMode of ['H4_20', 'H4_50']) {
    for (const adaptive of [false, true]) {
      for (const [stopAtr, minStopPct] of [[4.6, 1.45], [5.4, 1.60]]) {
        for (const ex of exitCombos) {
          const pullAtr = 0.35;
          const virtExec = {
            entryMode: 'LIMIT_PULLBACK',
            limitExpiryBars: 10,
            pendingPolicy: 'ignore',
            limitSameBarTp: 'close',
            cooldown: 6,
            warmup: 250,
            stopAtr,
            minStopPct,
            rewardRisk: ex.rewardRisk,
            maxHoldBars: 180,
            beTriggerR: ex.beTriggerR,
            beOffsetPct: ex.beOffsetPct,
            costPct: 0.10,
            slippagePct: 0.025,
          };
          const execOptions = {
            ...virtExec,
            tp1TriggerR: ex.tp1TriggerR,
            tp1QtyPct: ex.tp1QtyPct,
            tp1FeeMode: 'MAKER',
            tp1LockOffsetR: ex.tp1LockOffsetR,
            volNormRiskPct: 3.0,
            minLev: 1.0,
            maxLev: 2.5,
          };
          const sigSpec = {
            specId: `${coin}_15m_H4Disp_${htfMode}_${adaptive ? 'Adp' : 'Raw'}_s${stopAtr}_tp1_${ex.tp1TriggerR}_lk${ex.tp1LockOffsetR}`,
            rawFamily: 'M15_H4Disp',
            h4BodyAtrMin: 0.85,
            h4ClosePosMin: 0.58,
            onH4CloseOnly: true,
            requireLtfConfirm: false,
            htfMode,
            minAtrPct: 0.14,
            pullAtr,
            adaptive,
            winLen: 6,
            slThresh: 2,
            requireNegNet: true,
            virtExec,
          };
          specs.push({ id: sigSpec.specId, sigSpec, execOptions });
        }
      }
    }
  }

  // Family 2: M15_H1SyncedMultiTrap (1h/4h synced trap on 15m bars)
  for (const pullAtr of [0.25, 0.35]) {
    for (const [stopAtr, minStopPct] of [[3.6, 1.3], [4.4, 1.5]]) {
      for (const ex of exitCombos.slice(0, 2)) {
        const virtExec = {
          entryMode: 'LIMIT_PULLBACK',
          limitExpiryBars: 8,
          pendingPolicy: 'ignore',
          limitSameBarTp: 'close',
          cooldown: 8,
          warmup: 250,
          stopAtr,
          minStopPct,
          rewardRisk: ex.rewardRisk,
          maxHoldBars: 160,
          beTriggerR: ex.beTriggerR,
          beOffsetPct: ex.beOffsetPct,
          costPct: 0.10,
          slippagePct: 0.025,
        };
        const sigSpec = {
          specId: `${coin}_15m_H1Trap_p${pullAtr}_s${stopAtr}_tp1_${ex.tp1TriggerR}_lk${ex.tp1LockOffsetR}`,
          rawFamily: 'M15_H1SyncedMultiTrap',
          h1Lookback: 20,
          h4Lookback: 10,
          include24h: true,
          trapMaxBars: 4,
          htfMode: coin === 'BTCUSDT' ? 'H4_50' : 'H4_20',
          minAtrPct: 0.14,
          pullAtr,
          adaptive: true,
          winLen: 6,
          slThresh: 2,
          requireNegNet: true,
          virtExec,
        };
        const execOptions = {
          ...virtExec,
          tp1TriggerR: ex.tp1TriggerR,
          tp1QtyPct: ex.tp1QtyPct,
          tp1FeeMode: 'MAKER',
          tp1LockOffsetR: ex.tp1LockOffsetR,
          volNormRiskPct: 3.0,
          minLev: 1.0,
          maxLev: 2.5,
        };
        specs.push({ id: sigSpec.specId, sigSpec, execOptions });
      }
    }
  }

  // Family 3: H1_CleanDisp_OF (high-WR 1h displacement + 15m pullback + orderflow)
  for (const pullAtr of [0.35, 0.45]) {
    for (const ex of exitCombos.slice(0, 2)) {
      const execOptions = {
        entryMode: 'LIMIT_PULLBACK',
        limitExpiryBars: 8,
        pendingPolicy: 'ignore',
        limitSameBarTp: 'close',
        cooldown: 6,
        warmup: 250,
        stopAtr: 3.6,
        minStopPct: 1.3,
        rewardRisk: ex.rewardRisk,
        maxHoldBars: 140,
        beTriggerR: ex.beTriggerR,
        beOffsetPct: ex.beOffsetPct,
        tp1TriggerR: ex.tp1TriggerR,
        tp1QtyPct: ex.tp1QtyPct,
        tp1FeeMode: 'MAKER',
        tp1LockOffsetR: ex.tp1LockOffsetR,
        costPct: 0.10,
        slippagePct: 0.025,
        volNormRiskPct: 3.0,
        minLev: 1.0,
        maxLev: 2.5,
      };
      const sigSpec = {
        specId: `${coin}_15m_H1DispOF_p${pullAtr}_s3.6_tp1_${ex.tp1TriggerR}_lk${ex.tp1LockOffsetR}`,
        family: 'H1_CleanDisp_OF',
        h1BodyAtrMin: 0.90,
        h1ClosePosMin: 0.62,
        minAtrPct: 0.14,
        h1RsiExh: 72,
        emaExhAtr: 1.9,
        tbrMin: 0.48,
        pullAtr,
        htfMode: coin === 'BTCUSDT' ? 'H4_50' : 'H4_20',
      };
      specs.push({ id: sigSpec.specId, sigSpec, execOptions });
    }
  }

  return specs;
}

function loadStreamDatasetV7(streamKey) {
  const map = {
    BTC_1h: 'crypto5y_btcusdt_1h.json',
    BTC_15m: 'crypto5y_btcusdt_15m.json',
    BNB_1h: 'crypto5y_bnbusdt_1h.json',
    BNB_15m: 'crypto5y_bnbusdt_15m.json',
  };
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, map[streamKey]), 'utf8'));
}

function summarizeSliceV7(trades, rows, lo, hi) {
  const filtered = trades.filter(t => {
    const idxStart = t.signalIndex ?? t.entryIndex;
    return idxStart >= lo && t.exitIndex < hi;
  });
  return summarizeMonthlyCashflowV7(filtered, {
    startTime: rows[lo].time,
    endTime: rows[hi - 1].time,
    rows,
  });
}

export function calibrateStructuralV7CalVal(streamKey, dsCV, alignedFundingCV) {
  const is15m = streamKey.endsWith('_15m');
  const coin = streamKey.startsWith('BTC') ? 'BTCUSDT' : 'BNBUSDT';
  const catalog = is15m ? build15mHighWrCatalogV7(coin) : build1hHighWrCatalogV7(coin);
  const n = dsCV.rows.length;
  const calEnd = Math.floor((0.50 / 0.80) * n);
  const pre = is15m
    ? precompute15mV7(dsCV)
    : (coin === 'BTCUSDT'
        ? {
            f1: computeOhlcFeatures1h(dsCV.rows),
            f4: computeOhlcFeatures1h(dsCV.htf['4h'].rows),
            fD: dsCV.htf['1d'] ? computeOhlcFeatures1h(dsCV.htf['1d'].rows) : null,
            rawSignalsByKey: new Map(),
            virtTradesByKey: new Map(),
          }
        : null);

  let best = null;
  for (const cand of catalog) {
    const signals = generateStreamSignalsV7(streamKey, dsCV, cand.sigSpec, alignedFundingCV, pre);
    const simCV = simulateTradesV7(dsCV.rows, signals, {
      ...cand.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      start: 0,
      end: n,
      intervalSeconds: dsCV.intervalSeconds,
    });
    const mCV = summarizeSliceV7(simCV.trades, dsCV.rows, 0, n);
    const mCal = summarizeSliceV7(simCV.trades, dsCV.rows, 0, calEnd);
    const mVal = summarizeSliceV7(simCV.trades, dsCV.rows, calEnd, n);

    const minCount = is15m ? 200 : 140;
    const eligible = (simCV.count ?? 0) >= minCount
      && (mCV.winRatePct ?? 0) >= 72.0
      && (mCV.profitFactor ?? 0) >= 1.15
      && (mCal.profitFactor ?? 0) >= 1.04
      && (mVal.profitFactor ?? 0) >= 1.05
      && (mCV.liquidationCount ?? 0) === 0;
    const strongHighWr = eligible && (mCV.winRatePct ?? 0) >= 75.0 && (mCV.profitFactor ?? 0) >= 1.25;

    const score = (eligible ? 10000 : 0)
      + (strongHighWr ? 2500 : 0)
      + (mCV.meanMonthlySweepPct ?? 0) * 40
      + (mCV.profitFactor ?? 0) * 60
      + (mCV.winRatePct ?? 0) * 3
      - (mCV.maxCompoundedDdPct ?? 0) * 1.5;

    if (!best || score > best.score) {
      best = { score, eligible, cand };
    }
  }
  return best.cand;
}

export function applyV7ModelToSignals(ds, signals, alignedFunding, modelSpec) {
  const ctx = precomputeOrderflowContextV6(ds, alignedFunding);
  const filtered = [];
  for (const s of signals) {
    const f = extractCandidateFeaturesV6(ds, s, s.barIndex, alignedFunding, ctx);
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

function extractCalValPayloadV7() {
  const out = {};
  for (const streamKey of V7_STREAM_KEYS) {
    const full = loadStreamDatasetV7(streamKey);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV7(full, valEnd);
    const alignedFundingCV = alignFundingToBarsCausal(dsCV.rows, dsCV.fundingRows ?? []);
    const structural = calibrateStructuralV7CalVal(streamKey, dsCV, alignedFundingCV);
    const signals = generateStreamSignalsV7(streamKey, dsCV, structural.sigSpec, alignedFundingCV);

    const ctx = precomputeOrderflowContextV6(dsCV, alignedFundingCV);
    const sigFeatures = signals.map(s => {
      const fmap = extractCandidateFeaturesV6(dsCV, s, s.barIndex, alignedFundingCV, ctx);
      return {
        barIndex: s.barIndex,
        side: s.side,
        atr: s.atr,
        limitPrice: s.limitPrice ?? null,
        vec: FEATURE_NAMES_V6.map(k => (Number.isFinite(fmap[k]) ? fmap[k] : null)),
      };
    });

    const baseOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      intervalSeconds: dsCV.intervalSeconds,
    };
    const simCal = simulateTradesV7(dsCV.rows, signals, { ...baseOpts, start: 0, end: calEnd });
    const simVal = simulateTradesV7(dsCV.rows, signals, { ...baseOpts, start: calEnd, end: valEnd });
    const sigIdxByBar = new Map(signals.map((s, idx) => [s.barIndex, idx]));

    const calSequential = simCal.trades
      .filter(t => t.signalIndex >= 0 && t.exitIndex < calEnd)
      .map(t => ({ idx: sigIdxByBar.get(t.signalIndex), barIndex: t.signalIndex, y: t.netPct > 0 ? 1 : 0, netPct: t.netPct }));
    const valSequential = simVal.trades
      .filter(t => t.signalIndex >= calEnd && t.exitIndex < valEnd)
      .map(t => ({ idx: sigIdxByBar.get(t.signalIndex), barIndex: t.signalIndex, y: t.netPct > 0 ? 1 : 0, netPct: t.netPct }));

    const baseVal = summarizeSliceV7(simVal.trades, dsCV.rows, calEnd, valEnd);
    out[streamKey] = {
      streamKey,
      totalBarsFull: n,
      calEnd,
      valEnd,
      intervalSeconds: full.intervalSeconds,
      featureNames: FEATURE_NAMES_V6,
      structuralSpec: structural,
      signals: sigFeatures,
      calSequential,
      valSequential,
      baseVal: (({ monthlyTable, ...rest }) => rest)(baseVal),
    };
  }
  return out;
}

function evalValBatchV7(req) {
  const out = {};
  for (const streamKey of V7_STREAM_KEYS) {
    const full = loadStreamDatasetV7(streamKey);
    const n = full.rows.length;
    const calEnd = Math.floor(0.50 * n);
    const valEnd = Math.floor(0.80 * n);
    const dsCV = sliceDatasetPrefixV7(full, valEnd);
    const alignedFundingCV = alignFundingToBarsCausal(dsCV.rows, dsCV.fundingRows ?? []);
    const payload = req[streamKey];
    const structural = payload.structuralSpec;
    const baseSignals = generateStreamSignalsV7(streamKey, dsCV, structural.sigSpec, alignedFundingCV);
    const execOpts = {
      ...structural.execOptions,
      execProfile: 'EXCHANGE_POST_ONLY',
      fundingRows: dsCV.fundingRows,
      fundingPctPer8h: 0.01,
      isolatedLiqCheck: true,
      intervalSeconds: dsCV.intervalSeconds,
    };

    const rowsVal = dsCV.rows.slice(calEnd, valEnd);
    const cache = new Map();
    const results = [];
    for (const cand of payload.items) {
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
          const simV = simulateTradesV7(rowsVal, filteredVal, { ...execOpts, start: 0, end: rowsVal.length, warmup: 0 });
          metrics = (({ monthlyTable, ...rest }) => rest)(summarizeMonthlyCashflowV7(simV.trades, rowsVal));
          cache.set(cKey, metrics);
        }
      } else {
        const simV = simulateTradesV7(rowsVal, filteredVal, { ...execOpts, start: 0, end: rowsVal.length, warmup: 0 });
        metrics = (({ monthlyTable, ...rest }) => rest)(summarizeMonthlyCashflowV7(simV.trades, rowsVal));
      }
      results.push({ id: cand.id, val: metrics });
    }
    out[streamKey] = results;
  }
  return out;
}

export function evaluateStreamV7(streamKey, modelSpec, execProfile = 'EXCHANGE_POST_ONLY') {
  const ds = loadStreamDatasetV7(streamKey);
  const n = ds.rows.length;
  const calEnd = Math.floor(0.50 * n);
  const valEnd = Math.floor(0.80 * n);
  const alignedFunding = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
  const structural = modelSpec.structuralSpec;

  const rawSignals = generateStreamSignalsV7(streamKey, ds, structural.sigSpec, alignedFunding);
  const mlSignals = applyV7ModelToSignals(ds, rawSignals, alignedFunding, modelSpec);

  const opts = {
    ...structural.execOptions,
    execProfile,
    fundingRows: ds.fundingRows,
    fundingPctPer8h: 0.01,
    isolatedLiqCheck: true,
    intervalSeconds: ds.intervalSeconds,
    start: 0,
    end: n,
  };

  const simBase = simulateTradesV7(ds.rows, rawSignals, opts);
  const simMl = simulateTradesV7(ds.rows, mlSignals, opts);

  const stripMonthly = m => {
    const { monthlyTable, ...rest } = m;
    return rest;
  };

  const mlCal = stripMonthly(summarizeSliceV7(simMl.trades, ds.rows, 0, calEnd));
  const mlVal = stripMonthly(summarizeSliceV7(simMl.trades, ds.rows, calEnd, valEnd));
  const mlCalVal = stripMonthly(summarizeSliceV7(simMl.trades, ds.rows, 0, valEnd));
  const mlY5 = stripMonthly(summarizeSliceV7(simMl.trades, ds.rows, valEnd, n));
  const mlFull = stripMonthly(summarizeSliceV7(simMl.trades, ds.rows, 0, n));

  const baseCalVal = stripMonthly(summarizeSliceV7(simBase.trades, ds.rows, 0, valEnd));
  const baseY5 = stripMonthly(summarizeSliceV7(simBase.trades, ds.rows, valEnd, n));
  const baseFull = stripMonthly(summarizeSliceV7(simBase.trades, ds.rows, 0, n));

  const qualifiedForLive = (mlY5.count ?? 0) >= 30
    && (mlY5.winRatePct ?? 0) >= 70.0
    && (mlY5.profitFactor ?? 0) >= 1.10
    && (mlY5.compoundedNetPct ?? -100) > 0
    && (mlY5.liquidationCount ?? 0) === 0;

  return {
    id: streamKey,
    coin: streamKey.startsWith('BTC') ? 'BTCUSDT' : 'BNBUSDT',
    timeframe: streamKey.endsWith('_15m') ? '15m' : '1h',
    execProfile,
    bars: n,
    splits: { cal: [0, calEnd], val: [calEnd, valEnd], holdoutY5: [valEnd, n] },
    rows: ds.rows,
    trades: simMl.trades,
    baselineTrades: simBase.trades,
    qualifiedForLive,
    summary: {
      baseline: { calVal: baseCalVal, holdoutY5: baseY5, full5y: baseFull },
      ml: { cal: mlCal, val: mlVal, calVal: mlCalVal, holdoutY5: mlY5, full5y: mlFull },
    },
  };
}

export function getV7BtcBnbStreams(execProfile = 'EXCHANGE_POST_ONLY') {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V7_DIR, 'models_v7_btc_bnb.json'), 'utf8'));
  const streams = {};
  for (const streamKey of V7_STREAM_KEYS) {
    streams[streamKey] = evaluateStreamV7(streamKey, modelsJson.models[streamKey], execProfile);
  }
  return streams;
}

export async function runHighWrV7BtcBnb() {
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V7_DIR, 'models_v7_btc_bnb.json'), 'utf8'));
  const out = {};
  for (const streamKey of V7_STREAM_KEYS) {
    out[streamKey] = {};
    for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
      const res = evaluateStreamV7(streamKey, modelsJson.models[streamKey], prof);
      const { rows, trades, baselineTrades, ...clean } = res;
      out[streamKey][prof] = clean;
      const m = clean.summary.ml;
      const b = clean.summary.baseline;
      console.log(`\n[${streamKey} ${prof}] qualifiedForLive=${clean.qualifiedForLive}`);
      console.log(`  Base | CV: n=${b.calVal.count} WR=${b.calVal.winRatePct}% PF=${b.calVal.profitFactor} Mo=${b.calVal.meanMonthlySweepPct}% | Y5: n=${b.holdoutY5.count} WR=${b.holdoutY5.winRatePct}% PF=${b.holdoutY5.profitFactor} Comp=${b.holdoutY5.compoundedNetPct}% | 5Y: n=${b.full5y.count} WR=${b.full5y.winRatePct}% PF=${b.full5y.profitFactor} Comp=${b.full5y.compoundedNetPct}% DD=${b.full5y.maxCompoundedDdPct}%`);
      console.log(`  ML   | Cal: WR=${m.cal.winRatePct}% PF=${m.cal.profitFactor} | Val: WR=${m.val.winRatePct}% PF=${m.val.profitFactor} | Y5: n=${m.holdoutY5.count} WR=${m.holdoutY5.winRatePct}% PF=${m.holdoutY5.profitFactor} Comp=${m.holdoutY5.compoundedNetPct}% Mo=${m.holdoutY5.meanMonthlySweepPct}% | 5Y: n=${m.full5y.count} WR=${m.full5y.winRatePct}% PF=${m.full5y.profitFactor} Comp=${m.full5y.compoundedNetPct}% Mo=${m.full5y.meanMonthlySweepPct}% DD=${m.full5y.maxCompoundedDdPct}% Liq=${m.full5y.liquidationCount}`);
    }
  }

  fs.mkdirSync(RESULTS_V7_DIR, { recursive: true });
  const summary = {
    schema: 'smc-v7-btc-bnb-5y-summary-v1',
    generatedAt: new Date().toISOString(),
    modelMetadata: Object.fromEntries(V7_STREAM_KEYS.map(k => [k, modelsJson.models[k].selectionMeta])),
    streams: out,
  };
  const outPath = path.join(RESULTS_V7_DIR, 'btc_bnb_v7_5y.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n[high_wr_v7_btc_bnb] Wrote ${path.relative(ROOT_DIR, outPath)}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--extract-cal-val')) {
    process.stdout.write(JSON.stringify(extractCalValPayloadV7()));
  } else if (process.argv.includes('--eval-val')) {
    const req = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(evalValBatchV7(req)));
  } else {
    runHighWrV7BtcBnb().catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}
