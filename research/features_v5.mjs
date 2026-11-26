import assert from 'node:assert/strict';

export const FEATURE_NAMES_V5 = Object.freeze([
  'side',
  'atr_pct',
  'limit_offset_atr',
  'body_atr',
  'wick_adv_atr',
  'wick_opp_atr',
  'close_pos_dir',
  'rvol_20',
  'ltf_ema20_dist_atr',
  'ltf_ema50_dist_atr',
  'ltf_ema20_slope_atr',
  'ltf_ema50_slope_atr',
  'ltf_rsi14_dir',
  'h1_ema20_dist_atr',
  'h1_ema50_dist_atr',
  'h4_ema20_dist_atr',
  'h4_ema50_dist_atr',
  'h4_ema20_slope_atr',
  'h4_er10',
  'atr_ratio_50',
  'atr_pct_rank_200',
  'rv_ratio_12_48',
  'ret_12_dir_atr',
  'ret_48_dir_atr',
  'recent_dir_wr_60',
  'recent_dir_sl_streak',
  'recent_chop_cross_20',
  'funding_rate_bps',
  'funding_dir_align',
  'funding_zscore_21',
  'funding_ma3_dir',
  'utc_hour_sin',
  'utc_hour_cos',
]);

function calcEmaPrefix(closes, length, limit) {
  const out = new Float64Array(limit).fill(NaN);
  const alpha = 2 / (length + 1);
  let sum = 0;
  for (let i = 0; i < limit; i++) {
    const v = closes[i];
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

function calcAtrPrefix(rows, length, limit) {
  const out = new Float64Array(limit).fill(NaN);
  let sum = 0;
  for (let i = 0; i < limit; i++) {
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

function calcRsiPrefix(closes, length, limit) {
  const out = new Float64Array(limit).fill(NaN);
  let upSum = 0;
  let dnSum = 0;
  let avgUp = NaN;
  let avgDn = NaN;
  for (let i = 1; i < limit; i++) {
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
      avgUp += (up - avgUp) / length;
      avgDn += (dn - avgDn) / length;
      out[i] = avgUp === 0 && avgDn === 0 ? 50 : avgDn === 0 ? 100 : avgUp === 0 ? 0 : 100 - 100 / (1 + avgUp / avgDn);
    }
  }
  return out;
}

function calcSmaPrefix(values, length, limit) {
  const out = new Float64Array(limit).fill(NaN);
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < limit; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      sum += v;
      valid++;
      if (i >= length && Number.isFinite(values[i - length])) {
        sum -= values[i - length];
        valid--;
      }
      if (valid === length) out[i] = sum / length;
    } else {
      sum = 0;
      valid = 0;
    }
  }
  return out;
}

function calcRvolPrefix(rows, length, limit) {
  const out = new Float64Array(limit).fill(NaN);
  let volSum = 0;
  for (let i = 0; i < limit; i++) {
    out[i] = i >= length && volSum > 0 ? rows[i].volume / (volSum / length) : NaN;
    volSum += rows[i].volume;
    if (i >= length) volSum -= rows[i - length].volume;
  }
  return out;
}

function calcEr10Prefix(closes, limit) {
  const out = new Float64Array(limit).fill(NaN);
  let absDiffSum = 0;
  for (let i = 1; i < limit; i++) {
    absDiffSum += Math.abs(closes[i] - closes[i - 1]);
    if (i > 10) absDiffSum -= Math.abs(closes[i - 10] - closes[i - 11]);
    if (i >= 10) {
      out[i] = absDiffSum > 0 ? Math.abs(closes[i] - closes[i - 10]) / absDiffSum : 0;
    }
  }
  return out;
}

function calcRollingStdLogRetPrefix(closes, length, limit) {
  const out = new Float64Array(limit).fill(NaN);
  const rets = new Float64Array(limit);
  let sum = 0;
  let sumSq = 0;
  for (let i = 1; i < limit; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    rets[i] = r;
    sum += r;
    sumSq += r * r;
    if (i > length) {
      const old = rets[i - length];
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= length) {
      const mean = sum / length;
      const variance = Math.max(0, sumSq / length - mean * mean);
      out[i] = Math.sqrt(variance);
    }
  }
  return out;
}

function resolveHtfLimit(htfObj, maxLtfIdx, lastLtfTime) {
  if (!htfObj || !Array.isArray(htfObj.rows) || !Array.isArray(htfObj.alignedIndex)) return null;
  const maxAligned = htfObj.alignedIndex[maxLtfIdx];
  assert.ok(
    Number.isSafeInteger(maxAligned) && maxAligned >= 0 && maxAligned < htfObj.rows.length,
    `Invalid HTF alignedIndex at bar ${maxLtfIdx}`,
  );
  assert.ok(
    htfObj.rows[maxAligned].time + htfObj.intervalSeconds <= lastLtfTime,
    `HTF lookahead violation at bar ${maxLtfIdx}`,
  );
  return maxAligned + 1;
}

function buildSingleTfFeatures(rows, limit) {
  const closes = new Float64Array(limit);
  for (let i = 0; i < limit; i++) closes[i] = rows[i].close;
  const atr14 = calcAtrPrefix(rows, 14, limit);
  return {
    rows,
    closes,
    ema20: calcEmaPrefix(closes, 20, limit),
    ema50: calcEmaPrefix(closes, 50, limit),
    atr14,
    atrSma50: calcSmaPrefix(atr14, 50, limit),
    rsi14: calcRsiPrefix(closes, 14, limit),
    rvol20: calcRvolPrefix(rows, 20, limit),
    er10: calcEr10Prefix(closes, limit),
    rv12: calcRollingStdLogRetPrefix(closes, 12, limit),
    rv48: calcRollingStdLogRetPrefix(closes, 48, limit),
  };
}

function resolveFundingSeriesAtBar(alignedFunding, barIdx, barTime) {
  if (!alignedFunding) return [];
  if (!Array.isArray(alignedFunding) && Array.isArray(alignedFunding.rows) && Array.isArray(alignedFunding.alignedIndex)) {
    const j = alignedFunding.alignedIndex[barIdx];
    if (!Number.isSafeInteger(j) || j < 0 || j >= alignedFunding.rows.length) return [];
    const entry = alignedFunding.rows[j];
    assert.ok(entry.time <= barTime, `Funding lookahead violation at bar ${barIdx}`);
    const out = [];
    const start = Math.max(0, j - 20);
    for (let k = start; k <= j; k++) {
      const r = alignedFunding.rows[k]?.fundingRate;
      if (Number.isFinite(r)) out.push(r);
    }
    return out;
  }

  if (Array.isArray(alignedFunding)) {
    if (barIdx >= alignedFunding.length) return [];
    const outRev = [];
    let lastTime = Infinity;
    for (let k = barIdx; k >= 0 && outRev.length < 21; k--) {
      const item = alignedFunding[k];
      if (item === null || item === undefined) continue;
      if (typeof item === 'number') {
        if (Number.isFinite(item) && (outRev.length === 0 || k % 8 === 0)) {
          outRev.push(item);
        }
      } else if (typeof item === 'object') {
        if (Number.isFinite(item.time)) {
          if (item.time > barTime) {
            throw new Error(`Funding lookahead violation at bar ${barIdx}: funding time ${item.time} > barTime ${barTime}`);
          }
          if (item.time < lastTime && Number.isFinite(item.fundingRate)) {
            outRev.push(item.fundingRate);
            lastTime = item.time;
          }
        } else if (Number.isFinite(item.fundingRate) && outRev.length === 0) {
          outRev.push(item.fundingRate);
        }
      }
    }
    return outRev.reverse();
  }

  return [];
}

function calcCausalDirMomentum(rows, atr14, barIdx, side, lookback = 60, horizon = 8) {
  const startK = Math.max(15, barIdx - lookback);
  const endK = barIdx - horizon;
  if (endK < startK) return { wr: NaN, slStreak: 0 };

  const outcomes = [];
  for (let k = startK; k <= endK; k++) {
    const a = atr14[k];
    if (!Number.isFinite(a) || a <= 0) continue;
    const rk = rows[k];
    if (side * (rk.close - rk.open) < 0.25 * a) continue;
    const entry = rk.close;
    const tp = entry + side * a;
    const sl = entry - side * a;
    let res = null;
    for (let m = 1; m <= horizon; m++) {
      const rm = rows[k + m];
      const hitSl = side === 1 ? rm.low <= sl : rm.high >= sl;
      const hitTp = side === 1 ? rm.high >= tp : rm.low <= tp;
      if (hitSl) {
        res = 0;
        break;
      }
      if (hitTp) {
        res = 1;
        break;
      }
    }
    if (res === null) {
      res = side * (rows[k + horizon].close - entry) > 0 ? 1 : 0;
    }
    outcomes.push(res);
  }

  if (outcomes.length === 0) return { wr: NaN, slStreak: 0 };
  let wins = 0;
  for (let i = 0; i < outcomes.length; i++) wins += outcomes[i];
  let slStreak = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i] === 0) slStreak++;
    else break;
  }
  return { wr: wins / outcomes.length, slStreak };
}

export function precomputeFeatureContextV5(dataset, alignedFunding = null, maxBarIdx = null) {
  assert.ok(dataset && Array.isArray(dataset.rows) && dataset.rows.length > 0, 'Expected dataset with rows');
  const limit = maxBarIdx === null ? dataset.rows.length : maxBarIdx + 1;
  assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= dataset.rows.length, 'Invalid maxBarIdx');

  const lastTime = dataset.rows[limit - 1].time;
  const ltf = buildSingleTfFeatures(dataset.rows, limit);

  const htf4 = dataset.htf?.['4h'];
  assert.ok(htf4, 'Dataset missing htf["4h"]');
  const limit4h = resolveHtfLimit(htf4, limit - 1, lastTime);
  const f4 = buildSingleTfFeatures(htf4.rows, limit4h);

  let f1h = null;
  let aligned1h = null;
  if (dataset.intervalSeconds === 3600) {
    f1h = ltf;
  } else if (dataset.htf?.['1h']) {
    const htf1 = dataset.htf['1h'];
    const limit1h = resolveHtfLimit(htf1, limit - 1, lastTime);
    f1h = buildSingleTfFeatures(htf1.rows, limit1h);
    aligned1h = htf1.alignedIndex;
  }

  return {
    limit,
    intervalSeconds: dataset.intervalSeconds,
    ltf,
    f1h,
    aligned1h,
    f4,
    aligned4h: htf4.alignedIndex,
    alignedFunding,
  };
}

export function extractCandidateFeaturesV5(dataset, signal, barIdx, alignedFunding = null, context = null) {
  assert.ok(dataset && Array.isArray(dataset.rows), 'Expected dataset with rows');
  assert.ok(signal && (signal.side === 1 || signal.side === -1), 'Expected signal with side 1 or -1');
  assert.ok(Number.isSafeInteger(barIdx) && barIdx >= 0 && barIdx < dataset.rows.length, `Invalid barIdx: ${barIdx}`);

  const ctx = context ?? precomputeFeatureContextV5(dataset, alignedFunding, barIdx);
  assert.ok(barIdx < ctx.limit, `barIdx ${barIdx} exceeds precomputed limit ${ctx.limit}`);

  const fundingSource = alignedFunding ?? ctx.alignedFunding;
  const rows = ctx.ltf.rows;
  const r = rows[barIdx];
  const side = signal.side;
  const close = r.close;
  const open = r.open;
  const high = r.high;
  const low = r.low;
  const range = high - low;

  const ltfAtrArr = ctx.ltf.atr14;
  const atr = Number.isFinite(signal.atr) && signal.atr > 0 ? signal.atr : ltfAtrArr[barIdx];
  const validAtr = Number.isFinite(atr) && atr > 0;

  const atr_pct = validAtr ? (atr / close) * 100 : NaN;
  const rawLimitOffset = validAtr && Number.isFinite(signal.limitPrice) && signal.limitPrice > 0
    ? side * (close - signal.limitPrice) / atr
    : 0;
  const limit_offset_atr = Math.round(rawLimitOffset * 1e6) / 1e6;
  const body_atr = validAtr ? (side * (close - open)) / atr : NaN;
  const lowerWick = Math.min(open, close) - low;
  const upperWick = high - Math.max(open, close);
  const wick_adv_atr = validAtr ? (side === 1 ? lowerWick : upperWick) / atr : NaN;
  const wick_opp_atr = validAtr ? (side === 1 ? upperWick : lowerWick) / atr : NaN;
  const close_pos_dir = range > 0 ? (side === 1 ? (close - low) / range : (high - close) / range) : 0.5;
  const rvol_20 = ctx.ltf.rvol20[barIdx];

  const ema20 = ctx.ltf.ema20[barIdx];
  const ema50 = ctx.ltf.ema50[barIdx];
  const ltf_ema20_dist_atr = validAtr && Number.isFinite(ema20) ? (side * (close - ema20)) / atr : NaN;
  const ltf_ema50_dist_atr = validAtr && Number.isFinite(ema50) ? (side * (close - ema50)) / atr : NaN;
  const ltf_ema20_slope_atr = validAtr && barIdx >= 5 && Number.isFinite(ema20) && Number.isFinite(ctx.ltf.ema20[barIdx - 5])
    ? (side * (ema20 - ctx.ltf.ema20[barIdx - 5])) / atr
    : NaN;
  const ltf_ema50_slope_atr = validAtr && barIdx >= 10 && Number.isFinite(ema50) && Number.isFinite(ctx.ltf.ema50[barIdx - 10])
    ? (side * (ema50 - ctx.ltf.ema50[barIdx - 10])) / atr
    : NaN;
  const rsi = ctx.ltf.rsi14[barIdx];
  const ltf_rsi14_dir = Number.isFinite(rsi) ? (side === 1 ? (rsi - 50) / 50 : (50 - rsi) / 50) : NaN;

  let h1_ema20_dist_atr = ltf_ema20_dist_atr;
  let h1_ema50_dist_atr = ltf_ema50_dist_atr;
  if (ctx.f1h && ctx.aligned1h) {
    const j1 = ctx.aligned1h[barIdx];
    const h1Row = ctx.f1h.rows[j1];
    const h1Atr = ctx.f1h.atr14[j1];
    if (h1Row && Number.isFinite(h1Atr) && h1Atr > 0) {
      h1_ema20_dist_atr = Number.isFinite(ctx.f1h.ema20[j1]) ? (side * (h1Row.close - ctx.f1h.ema20[j1])) / h1Atr : NaN;
      h1_ema50_dist_atr = Number.isFinite(ctx.f1h.ema50[j1]) ? (side * (h1Row.close - ctx.f1h.ema50[j1])) / h1Atr : NaN;
    } else {
      h1_ema20_dist_atr = NaN;
      h1_ema50_dist_atr = NaN;
    }
  }

  const j4 = ctx.aligned4h[barIdx];
  const h4Row = ctx.f4.rows[j4];
  const h4Atr = ctx.f4.atr14[j4];
  let h4_ema20_dist_atr = NaN;
  let h4_ema50_dist_atr = NaN;
  let h4_ema20_slope_atr = NaN;
  const h4_er10 = ctx.f4.er10[j4];
  if (h4Row && Number.isFinite(h4Atr) && h4Atr > 0) {
    h4_ema20_dist_atr = Number.isFinite(ctx.f4.ema20[j4]) ? (side * (h4Row.close - ctx.f4.ema20[j4])) / h4Atr : NaN;
    h4_ema50_dist_atr = Number.isFinite(ctx.f4.ema50[j4]) ? (side * (h4Row.close - ctx.f4.ema50[j4])) / h4Atr : NaN;
    if (j4 >= 3 && Number.isFinite(ctx.f4.ema20[j4]) && Number.isFinite(ctx.f4.ema20[j4 - 3])) {
      h4_ema20_slope_atr = (side * (ctx.f4.ema20[j4] - ctx.f4.ema20[j4 - 3])) / h4Atr;
    }
  }

  const atrSma50 = ctx.ltf.atrSma50[barIdx];
  const atr_ratio_50 = Number.isFinite(ltfAtrArr[barIdx]) && Number.isFinite(atrSma50) && atrSma50 > 0
    ? ltfAtrArr[barIdx] / atrSma50
    : NaN;

  let atr_pct_rank_200 = NaN;
  if (Number.isFinite(ltfAtrArr[barIdx])) {
    const curPct = ltfAtrArr[barIdx] / close;
    let total = 0;
    let leCount = 0;
    const startRank = Math.max(13, barIdx - 199);
    for (let k = startRank; k <= barIdx; k++) {
      const a = ltfAtrArr[k];
      if (!Number.isFinite(a)) continue;
      total++;
      if (a / rows[k].close <= curPct) leCount++;
    }
    if (total >= 20) atr_pct_rank_200 = leCount / total;
  }

  const rv12 = ctx.ltf.rv12[barIdx];
  const rv48 = ctx.ltf.rv48[barIdx];
  const rv_ratio_12_48 = Number.isFinite(rv12) && Number.isFinite(rv48) && rv48 > 0 ? rv12 / rv48 : NaN;

  const ret_12_dir_atr = validAtr && barIdx >= 12 ? (side * (close - rows[barIdx - 12].close)) / atr : NaN;
  const ret_48_dir_atr = validAtr && barIdx >= 48 ? (side * (close - rows[barIdx - 48].close)) / atr : NaN;

  const { wr: recent_dir_wr_60, slStreak: recent_dir_sl_streak } = calcCausalDirMomentum(rows, ltfAtrArr, barIdx, side, 60, 8);

  let recent_chop_cross_20 = NaN;
  if (barIdx >= 40) {
    let crosses = 0;
    let validPairs = 0;
    for (let k = barIdx - 19; k <= barIdx; k++) {
      const eCur = ctx.ltf.ema20[k];
      const ePrev = ctx.ltf.ema20[k - 1];
      if (!Number.isFinite(eCur) || !Number.isFinite(ePrev)) continue;
      validPairs++;
      if ((rows[k].close > eCur) !== (rows[k - 1].close > ePrev)) crosses++;
    }
    if (validPairs > 0) recent_chop_cross_20 = crosses / validPairs;
  }

  const fHist = resolveFundingSeriesAtBar(fundingSource, barIdx, r.time);
  let funding_rate_bps = NaN;
  let funding_dir_align = NaN;
  let funding_zscore_21 = NaN;
  let funding_ma3_dir = NaN;
  if (fHist.length > 0) {
    const curF = fHist[fHist.length - 1];
    funding_rate_bps = curF * 10000;
    funding_dir_align = side * funding_rate_bps;
    const tail3 = fHist.slice(-3);
    const ma3 = tail3.reduce((acc, v) => acc + v, 0) / tail3.length;
    funding_ma3_dir = side * ma3 * 10000;
    if (fHist.length >= 3) {
      const mean = fHist.reduce((acc, v) => acc + v, 0) / fHist.length;
      let varSum = 0;
      for (const v of fHist) varSum += (v - mean) * (v - mean);
      const std = Math.sqrt(varSum / fHist.length);
      funding_zscore_21 = std > 1e-7 ? (curF - mean) / std : 0;
    }
  }

  const dt = new Date(r.time * 1000);
  const utcHour = dt.getUTCHours() + dt.getUTCMinutes() / 60;
  const angle = (2 * Math.PI * utcHour) / 24;
  const utc_hour_sin = Math.sin(angle);
  const utc_hour_cos = Math.cos(angle);

  return {
    side,
    atr_pct,
    limit_offset_atr,
    body_atr,
    wick_adv_atr,
    wick_opp_atr,
    close_pos_dir,
    rvol_20,
    ltf_ema20_dist_atr,
    ltf_ema50_dist_atr,
    ltf_ema20_slope_atr,
    ltf_ema50_slope_atr,
    ltf_rsi14_dir,
    h1_ema20_dist_atr,
    h1_ema50_dist_atr,
    h4_ema20_dist_atr,
    h4_ema50_dist_atr,
    h4_ema20_slope_atr,
    h4_er10,
    atr_ratio_50,
    atr_pct_rank_200,
    rv_ratio_12_48,
    ret_12_dir_atr,
    ret_48_dir_atr,
    recent_dir_wr_60,
    recent_dir_sl_streak,
    recent_chop_cross_20,
    funding_rate_bps,
    funding_dir_align,
    funding_zscore_21,
    funding_ma3_dir,
    utc_hour_sin,
    utc_hour_cos,
  };
}
