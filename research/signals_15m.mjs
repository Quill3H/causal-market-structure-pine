import assert from 'node:assert/strict';

export const DEFAULT_15M_PARAMS = Object.freeze({
  family: 'H1_CleanDisp_AtrExh',
  h1BodyAtrMin: 1.0,
  h1ClosePosMin: 0.65,
  minAtrPct: 0.18,
  h1RsiExh: 72,
  emaExhAtr: 1.8,
  h1RvolMin: null,
  h1Disp3hMin: null,
  pullAtr: 0.55,
  emaLen: 50,
  atrLen: 14,
  warmup: 250,
  h1RsiMax: null,
  emaCapAtr: null,
});

export const DEFAULT_15M_SIM_OPTIONS = Object.freeze({
  warmup: 250,
  cooldown: 8,
  entryMode: 'LIMIT_PULLBACK',
  limitExpiryBars: 6,
  pendingPolicy: 'ignore',
  limitSameBarTp: 'close',
  stopAtr: 3.0,
  minStopPct: 1.0,
  rewardRisk: 1.15,
  maxHoldBars: 120,
  beTriggerR: 0.43,
  beOffsetPct: 0.28,
  costPct: 0.1,
  slippagePct: 0.025,
});

/**
 * Exact TradingView Pine Script v6 ta.ema(source, length):
 * Seeds with SMA of first `length` values at index `length - 1`, NaN before.
 */
export function calcPineEma(values, length) {
  assert.ok(Number.isSafeInteger(length) && length >= 1, 'Invalid EMA length');
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  const alpha = 2 / (length + 1);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (i < length - 1) {
      sum += v;
    } else if (i === length - 1) {
      sum += v;
      out[i] = sum / length;
    } else {
      out[i] = out[i - 1] + alpha * (v - out[i - 1]);
    }
  }
  return out;
}

/**
 * Exact TradingView Pine Script v6 ta.atr(length) = ta.rma(ta.tr(true), length):
 * At bar 0, ta.tr(true) = high - low. Wilder RMA seeds with SMA of bars 0..length-1.
 */
export function calcPineAtr(rows, length = 14) {
  assert.ok(Number.isSafeInteger(length) && length >= 1, 'Invalid ATR length');
  const n = rows.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const prevClose = i === 0 ? r.close : rows[i - 1].close;
    const tr = Math.max(
      r.high - r.low,
      Math.abs(r.high - prevClose),
      Math.abs(r.low - prevClose),
    );
    if (i < length - 1) {
      sum += tr;
    } else if (i === length - 1) {
      sum += tr;
      out[i] = sum / length;
    } else {
      out[i] = out[i - 1] + (tr - out[i - 1]) / length;
    }
  }
  return out;
}

/**
 * Exact TradingView Pine Script v6 ta.rsi(close, length) using Wilder RMA on gains/losses.
 */
export function calcPineRsi(closes, length = 14) {
  assert.ok(Number.isSafeInteger(length) && length >= 1, 'Invalid RSI length');
  const n = closes.length;
  const out = new Float64Array(n).fill(NaN);
  let upSum = 0;
  let dnSum = 0;
  let avgUp = NaN;
  let avgDn = NaN;
  for (let i = 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    const up = Math.max(ch, 0);
    const dn = Math.max(-ch, 0);
    if (i < length) {
      upSum += up;
      dnSum += dn;
    } else if (i === length) {
      upSum += up;
      dnSum += dn;
      avgUp = upSum / length;
      avgDn = dnSum / length;
      out[i] = avgUp === 0 && avgDn === 0 ? 50 : avgDn === 0 ? 100 : avgUp === 0 ? 0 : 100 - 100 / (1 + avgUp / avgDn);
    } else {
      avgUp = avgUp + (up - avgUp) / length;
      avgDn = avgDn + (dn - avgDn) / length;
      out[i] = avgUp === 0 && avgDn === 0 ? 50 : avgDn === 0 ? 100 : avgUp === 0 ? 0 : 100 - 100 / (1 + avgUp / avgDn);
    }
  }
  return out;
}

/**
 * Causal HTF alignment matching request.security(..., lookahead=barmerge.lookahead_off):
 * Returns the latest closed HTF bar index j where htfRows[j].time + htfIntervalSeconds <= ltfRows[i].time.
 */
export function alignHtfClosedIndices(ltfRows, htfRows, htfIntervalSeconds = 3600) {
  assert.ok(Array.isArray(ltfRows) && Array.isArray(htfRows), 'Expected LTF and HTF row arrays');
  assert.ok(Number.isSafeInteger(htfIntervalSeconds) && htfIntervalSeconds > 0, 'Invalid htfIntervalSeconds');
  const aligned = new Int32Array(ltfRows.length);
  let j = -1;
  for (let i = 0; i < ltfRows.length; i++) {
    const ltfOpen = ltfRows[i].time;
    while (j + 1 < htfRows.length && htfRows[j + 1].time + htfIntervalSeconds <= ltfOpen) {
      j++;
    }
    assert.ok(j >= 0, `Insufficient closed HTF history before LTF bar ${i} (${ltfOpen})`);
    aligned[i] = j;
  }
  return aligned;
}

/**
 * Precompute all causal LTF (15m) and closed HTF (1h) indicator series once per dataset.
 */
export function compute15mFeatures(dataset) {
  assert.ok(dataset && Array.isArray(dataset.rows) && dataset.rows.length > 0, 'Invalid 15m dataset');
  const h1 = dataset.htf?.['1h'];
  assert.ok(h1 && Array.isArray(h1.rows) && h1.rows.length > 0, 'Dataset missing htf["1h"] rows');

  const rows = dataset.rows;
  const h1Rows = h1.rows;
  const h1Interval = h1.intervalSeconds ?? 3600;
  const aligned1h = alignHtfClosedIndices(rows, h1Rows, h1Interval);

  if (Array.isArray(h1.alignedIndex) && h1.alignedIndex.length === rows.length) {
    for (let i = 0; i < rows.length; i++) {
      assert.equal(aligned1h[i], h1.alignedIndex[i], `HTF 1h alignment mismatch at bar ${i}`);
    }
  }

  const ltfCloses = rows.map(r => r.close);
  const h1Closes = h1Rows.map(r => r.close);
  const h1VolSma20 = new Float64Array(h1Rows.length).fill(NaN);
  let volSum = 0;
  for (let i = 0; i < h1Rows.length; i++) {
    volSum += h1Rows[i].volume;
    if (i >= 20) volSum -= h1Rows[i - 20].volume;
    if (i >= 19) h1VolSma20[i] = volSum / 20;
  }

  return {
    rows,
    h1Rows,
    aligned1h,
    ltfEma20: calcPineEma(ltfCloses, 20),
    ltfEma50: calcPineEma(ltfCloses, 50),
    ltfAtr14: calcPineAtr(rows, 14),
    ltfRsi14: calcPineRsi(ltfCloses, 14),
    h1Ema20: calcPineEma(h1Closes, 20),
    h1Ema50: calcPineEma(h1Closes, 50),
    h1Atr14: calcPineAtr(h1Rows, 14),
    h1Rsi14: calcPineRsi(h1Closes, 14),
    h1VolSma20,
  };
}

/**
 * Generate strictly causal 15m trade signals compatible with sim_engine.mjs and Pine v6.
 */
export function generate15mSignals(datasetOrFeatures, params = DEFAULT_15M_PARAMS) {
  const f = datasetOrFeatures.aligned1h ? datasetOrFeatures : compute15mFeatures(datasetOrFeatures);
  const cfg = { ...DEFAULT_15M_PARAMS, ...params };
  const {
    rows, h1Rows, aligned1h,
    ltfEma20, ltfEma50, ltfAtr14,
    h1Ema50, h1Atr14, h1Rsi14, h1VolSma20,
  } = f;

  const signals = [];
  const startBar = Math.max(2, cfg.warmup);

  for (let i = startBar; i < rows.length; i++) {
    const r = rows[i];
    const atr = ltfAtr14[i];
    const ema50 = ltfEma50[i];
    const ema20 = ltfEma20[i];
    if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(ema50)) continue;

    const atrPct = (atr / r.close) * 100;
    if (cfg.minAtrPct > 0 && atrPct < cfg.minAtrPct) continue;

    const j1 = aligned1h[i];
    const h = h1Rows[j1];
    const atr1 = h1Atr14[j1];
    const ema50_1 = h1Ema50[j1];
    const rsi1 = h1Rsi14[j1];
    if (!Number.isFinite(atr1) || atr1 <= 0 || !Number.isFinite(ema50_1)) continue;

    let side = 0;
    let limitPrice = null;

    if (
      cfg.family === 'H1_CleanDisp_AtrExh' ||
      cfg.family === 'H1_CleanDisp' ||
      cfg.family === 'H1_CleanDisp_RsiGuard' ||
      cfg.family === 'H1_CleanDisp_EmaCap'
    ) {
      const hRange = h.high - h.low;
      if (hRange <= 0) continue;
      const body = h.close - h.open;
      const bullClosePos = (h.close - h.low) / hRange;
      const bearClosePos = (h.high - h.close) / hRange;

      if (
        body >= cfg.h1BodyAtrMin * atr1 &&
        bullClosePos >= cfg.h1ClosePosMin &&
        h.close > ema50_1 &&
        r.close > ema50
      ) {
        side = 1;
      } else if (
        -body >= cfg.h1BodyAtrMin * atr1 &&
        bearClosePos >= cfg.h1ClosePosMin &&
        h.close < ema50_1 &&
        r.close < ema50
      ) {
        side = -1;
      }

      if (side !== 0 && cfg.family === 'H1_CleanDisp_AtrExh') {
        if (Number.isFinite(rsi1) && Number.isFinite(ema20)) {
          const dirH1Rsi = side === 1 ? rsi1 : 100 - rsi1;
          const ltfEmaDistAtr = (side * (r.close - ema20)) / atr;
          if (dirH1Rsi >= cfg.h1RsiExh && ltfEmaDistAtr > cfg.emaExhAtr) {
            side = 0;
          }
        }
      }

      if (side !== 0 && cfg.h1RvolMin !== null && Number.isFinite(h1VolSma20[j1]) && h1VolSma20[j1] > 0) {
        if (h.volume < cfg.h1RvolMin * h1VolSma20[j1]) {
          side = 0;
        }
      }

      if (side !== 0 && cfg.h1Disp3hMin !== null && j1 >= 3) {
        const net3hAtr = (side * (h1Rows[j1 - 1].close - h1Rows[j1 - 3].open)) / atr1;
        if (net3hAtr < cfg.h1Disp3hMin) {
          side = 0;
        }
      }

      if (side !== 0 && cfg.h1RsiMax !== null && Number.isFinite(rsi1)) {
        if ((side === 1 && rsi1 >= cfg.h1RsiMax) || (side === -1 && rsi1 <= 100 - cfg.h1RsiMax)) {
          side = 0;
        }
      }
      if (side !== 0 && cfg.emaCapAtr !== null && Number.isFinite(ema20)) {
        if (side * (r.close - ema20) > cfg.emaCapAtr * atr) {
          side = 0;
        }
      }
      if (side !== 0) {
        limitPrice = r.close - side * cfg.pullAtr * atr;
      }
    } else if (cfg.family === 'M15_EngulfOB_H1') {
      const p = rows[i - 1];
      const bull = h.close > ema50_1 && r.close > ema50;
      const bear = h.close < ema50_1 && r.close < ema50;
      if (bull && p.close < p.open && r.close > p.high && (r.close - r.open) >= 0.7 * atr) {
        side = 1;
        limitPrice = r.open;
      } else if (bear && p.close > p.open && r.close < p.low && (r.open - r.close) >= 0.7 * atr) {
        side = -1;
        limitPrice = r.open;
      }
    } else if (cfg.family === 'M15_FVG_H1') {
      const r2 = rows[i - 2];
      const bull = h.close > ema50_1 && r.close > ema50;
      const bear = h.close < ema50_1 && r.close < ema50;
      if (bull && r.low > r2.high && (r.low - r2.high) >= 0.25 * atr && r.close > r.open) {
        side = 1;
        limitPrice = (r.low + r2.high) / 2;
      } else if (bear && r.high < r2.low && (r2.low - r.high) >= 0.25 * atr && r.close < r.open) {
        side = -1;
        limitPrice = (r.high + r2.low) / 2;
      }
    } else if (cfg.family === 'M15_Sweep20_H1') {
      if (i >= 20) {
        let hi = -Infinity;
        let lo = Infinity;
        for (let k = i - 20; k < i; k++) {
          if (rows[k].high > hi) hi = rows[k].high;
          if (rows[k].low < lo) lo = rows[k].low;
        }
        if (h.close > ema50_1 && r.low < lo && r.close > lo) {
          side = 1;
          limitPrice = r.close - cfg.pullAtr * atr;
        } else if (h.close < ema50_1 && r.high > hi && r.close < hi) {
          side = -1;
          limitPrice = r.close + cfg.pullAtr * atr;
        }
      }
    } else {
      throw new Error(`Unknown 15m strategy family: ${cfg.family}`);
    }

    if (side !== 0 && Number.isFinite(limitPrice) && limitPrice > 0) {
      signals.push({
        barIndex: i,
        side,
        atr,
        limitPrice,
      });
    }
  }

  return signals;
}

/**
 * Round-2 lean multi-hypothesis grid across volatility-gated displacement,
 * double-exhaustion guard, RSI guard, and SMC control families.
 */
export function build15mCandidates(dataset) {
  const f = compute15mFeatures(dataset);
  const candidates = [];

  const pushCand = (id, params, simOverrides) => {
    const fullParams = { ...DEFAULT_15M_PARAMS, ...params };
    const simOptions = { ...DEFAULT_15M_SIM_OPTIONS, ...simOverrides };
    candidates.push({
      id,
      family: fullParams.family,
      params: fullParams,
      simOptions,
      signals: generate15mSignals(f, fullParams),
    });
  };

  // 1. Round-9 Hypothesis: Proportional BE+Cost Offset (0.28..0.30%) on MinStop 0.95..1.00% Plateau
  for (const pullAtr of [0.52, 0.55]) {
    for (const limitExpiryBars of [6, 7]) {
      for (const minStopPct of [0.95, 1.0]) {
        for (const rewardRisk of [1.05, 1.15]) {
          for (const beTriggerR of [0.43, 0.45]) {
            for (const beOffsetPct of [0.28, 0.3]) {
              pushCand(
                `H1_CleanDisp_AtrExh:CP0.65:R72:P${pullAtr}:E${limitExpiryBars}:M${minStopPct}:RR${rewardRisk}:BE${beTriggerR}/O${beOffsetPct}`,
                {
                  family: 'H1_CleanDisp_AtrExh',
                  minAtrPct: 0.18,
                  h1BodyAtrMin: 1.0,
                  h1ClosePosMin: 0.65,
                  h1RsiExh: 72,
                  emaExhAtr: 1.8,
                  h1RvolMin: null,
                  h1Disp3hMin: null,
                  pullAtr,
                },
                { stopAtr: 3.0, limitExpiryBars, minStopPct, rewardRisk, beTriggerR, beOffsetPct },
              );
            }
          }
        }
      }
    }
  }

  for (const pullAtr of [0.52, 0.55]) {
    for (const minStopPct of [0.95, 1.0]) {
      for (const beTriggerR of [0.43, 0.45]) {
        for (const beOffsetPct of [0.28, 0.3]) {
          pushCand(
            `H1_CleanDisp_AtrExh:CP0.6:R75:P${pullAtr}:E6:M${minStopPct}:RR1.15:BE${beTriggerR}/O${beOffsetPct}`,
            {
              family: 'H1_CleanDisp_AtrExh',
              minAtrPct: 0.18,
              h1BodyAtrMin: 1.0,
              h1ClosePosMin: 0.6,
              h1RsiExh: 75,
              emaExhAtr: 1.8,
              h1RvolMin: null,
              h1Disp3hMin: null,
              pullAtr,
            },
            { stopAtr: 3.0, limitExpiryBars: 6, minStopPct, rewardRisk: 1.15, beTriggerR, beOffsetPct },
          );
        }
      }
    }
  }

  // 2. Round-4 Control & Ablation / SMC Controls
  pushCand(
    'H1_CleanDisp_AtrExh:R4_M0.75:CP0.65:R72:P0.52:RR1.05:BE0.42',
    { family: 'H1_CleanDisp_AtrExh', minAtrPct: 0.18, h1RsiExh: 72, emaExhAtr: 1.8, h1BodyAtrMin: 1.0, h1ClosePosMin: 0.65, h1RvolMin: null, h1Disp3hMin: null, pullAtr: 0.52 },
    { stopAtr: 3.0, minStopPct: 0.75, rewardRisk: 1.05, beTriggerR: 0.42, beOffsetPct: 0.22 },
  );
  pushCand(
    'H1_CleanDisp:NoExh:P0.55:M0.95:RR1.15:BE0.43',
    { family: 'H1_CleanDisp', minAtrPct: 0.18, h1BodyAtrMin: 1.0, h1ClosePosMin: 0.6, h1RvolMin: null, h1Disp3hMin: null, pullAtr: 0.55 },
    { stopAtr: 3.0, minStopPct: 0.95, rewardRisk: 1.15, beTriggerR: 0.43, beOffsetPct: 0.25 },
  );
  pushCand(
    'H1_CleanDisp_RsiGuard:R75:P0.52:M0.95:RR1.15',
    { family: 'H1_CleanDisp_RsiGuard', minAtrPct: 0.18, h1BodyAtrMin: 1.0, h1ClosePosMin: 0.65, h1RvolMin: null, h1Disp3hMin: null, pullAtr: 0.52, h1RsiMax: 75 },
    { stopAtr: 3.0, minStopPct: 0.95, rewardRisk: 1.15, beTriggerR: 0.43, beOffsetPct: 0.25 },
  );
  pushCand(
    'M15_EngulfOB_H1:RR0.95',
    { family: 'M15_EngulfOB_H1', minAtrPct: 0.18, h1RvolMin: null, h1Disp3hMin: null, pullAtr: 0 },
    { rewardRisk: 0.95 },
  );
  pushCand(
    'M15_FVG_H1:RR0.95',
    { family: 'M15_FVG_H1', minAtrPct: 0.18, h1RvolMin: null, h1Disp3hMin: null, pullAtr: 0 },
    { rewardRisk: 0.95 },
  );
  pushCand(
    'M15_Sweep20_H1:RR0.95',
    { family: 'M15_Sweep20_H1', minAtrPct: 0.18, h1RvolMin: null, h1Disp3hMin: null, pullAtr: 0.3 },
    { rewardRisk: 0.95 },
  );

  return candidates;
}
