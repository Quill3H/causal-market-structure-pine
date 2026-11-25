import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  simulateTradesV7,
  simulatePortfolioV7,
  summarizeMonthlyCashflowV7,
} from './sim_engine_v7.mjs';
import { generateFutures1hSignalsCausal } from './suite_v6_stocks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V6_DIR = path.join(HERE, 'results_v6');
const RESULTS_V7_DIR = path.join(HERE, 'results_v7');
const SUMMARY_OUT_PATH = path.join(RESULTS_V7_DIR, 'frontier_75wr_30mo_summary.json');

const EPS = 1e-12;
const SECONDS_PER_YEAR = 365.25 * 86400;

export const TIER_DEFS_V7 = Object.freeze({
  SAFE_75WR: Object.freeze({
    key: 'SAFE_75WR',
    label: 'TIER_1_SAFE_75WR',
    minCalValWrPct: 75.0,
    maxCalValDdPct: 25.0,
    targetMonthlyPct: null,
  }),
  BALANCED_75WR: Object.freeze({
    key: 'BALANCED_75WR',
    label: 'TIER_2_BALANCED_75WR',
    minCalValWrPct: 75.0,
    maxCalValDdPct: 35.0,
    targetMonthlyPct: null,
  }),
  TARGET_30MO_75WR: Object.freeze({
    key: 'TARGET_30MO_75WR',
    label: 'TIER_3_TARGET_30MO_75WR',
    minCalValWrPct: 75.0,
    maxCalValDdPct: 95.0,
    targetMonthlyPct: 30.0,
  }),
});

function r2(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(2));
}

function computeSharpeSortinoCalmar(trades, cagrPct, maxCompDdPct, periodYears) {
  const count = trades.length;
  let sharpe = null;
  let sortino = null;
  if (count >= 2 && periodYears > 0) {
    let sum = 0;
    let sumDownSq = 0;
    const rets = new Array(count);
    for (let i = 0; i < count; i++) {
      const p = trades[i].portfolioNetPct ?? trades[i].netPct;
      rets[i] = p;
      sum += p;
      if (p < 0) sumDownSq += p * p;
    }
    const mean = sum / count;
    let varSum = 0;
    for (let i = 0; i < count; i++) {
      const d = rets[i] - mean;
      varSum += d * d;
    }
    const std = Math.sqrt(varSum / (count - 1));
    const downDev = Math.sqrt(sumDownSq / count);
    const ann = Math.sqrt(count / periodYears);
    if (std > EPS) sharpe = (mean / std) * ann;
    if (downDev > EPS) sortino = (mean / downDev) * ann;
  }
  const calmar = cagrPct !== null && maxCompDdPct > EPS ? cagrPct / maxCompDdPct : null;
  return { sharpe: r2(sharpe), sortino: r2(sortino), calmar: r2(calmar) };
}

/**
 * Builds the strictly causal 2-Year 1h US Equity Index Futures (ES=F, NQ=F)
 * high-WR helper sleeve using Cal+Val-calibrated daily HTF signals & Two-Stage TP1 exits.
 */
export function buildHighWrFuturesOverlayV7() {
  const modelsPath = path.join(RESULTS_V6_DIR, 'models_stocks_v6.json');
  const models = JSON.parse(fs.readFileSync(modelsPath, 'utf8')).models;
  const macro = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities10y_macro_1d.json'), 'utf8'));
  const dia = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities10y_dow_1d.json'), 'utf8'));
  const qqq = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities10y_nasdaq_1d.json'), 'utf8'));
  const aux = { macro, diaRows: dia.rows, qqqRows: qqq.rows };

  const perContract = {};
  const streams = [];

  for (const [asset, file, sym] of [
    ['SPY', 'equities2y_es_1h.json', 'ES=F'],
    ['QQQ', 'equities2y_nq_1h.json', 'NQ=F'],
  ]) {
    const ms = models[asset];
    const futDs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    const sigs = generateFutures1hSignalsCausal(futDs, ms, aux).mlSignals;
    const execOpts = {
      ...ms.execOptions,
      warmup: 0,
      cooldown: 18,
      limitExpiryBars: (ms.execOptions.limitExpiryBars ?? 2) * 23,
      maxHoldBars: (ms.execOptions.maxHoldBars ?? 10) * 23,
      tp1TriggerR: 0.65,
      tp1QtyPct: 50,
      tp1LockOffsetR: 0.30,
      rewardRisk: 1.15,
      beTriggerR: 0.38,
      beOffsetPct: 0.15,
      costPct: 0.04,
      slippagePct: 0.015,
      fundingPctPer8h: 0,
      allowTimeGaps: true,
    };
    const sim = simulateTradesV7(futDs.rows, sigs, { ...execOpts, start: 0, end: futDs.rows.length });
    const years = (futDs.rows[futDs.rows.length - 1].time - futDs.rows[0].time) / SECONDS_PER_YEAR;
    const ratios = computeSharpeSortinoCalmar(sim.trades, sim.cagrPct, sim.compoundedMaxDrawdownPct, years);
    perContract[sym] = {
      symbol: sym,
      proxyAsset: asset,
      bars: futDs.rows.length,
      firstDate: futDs.rows[0].date,
      lastDate: futDs.rows[futDs.rows.length - 1].date,
      count: sim.count,
      wins: sim.wins,
      losses: sim.losses,
      winRatePct: r2(sim.winRatePct),
      profitFactor: r2(sim.profitFactor),
      compoundedNetPct: r2(sim.compoundedNetPct),
      cagrPct: r2(sim.cagrPct),
      compoundedMaxDrawdownPct: r2(sim.compoundedMaxDrawdownPct),
      ...ratios,
      liquidationCount: sim.liquidationCount ?? 0,
    };
    streams.push({
      id: `${sym}_1h`,
      rows: futDs.rows,
      trades: sim.trades,
      intervalSeconds: 3600,
    });
  }

  const combined = simulatePortfolioV7(streams, { maxTotalOpenLev: 2.0, levScale: 1.0, mmr: 0.005 });
  const minT = Math.min(...streams.map(s => s.rows[0].time));
  const maxT = Math.max(...streams.map(s => s.rows[s.rows.length - 1].time));
  const combinedYears = (maxT - minT) / SECONDS_PER_YEAR;
  const cRatios = computeSharpeSortinoCalmar(
    combined.trades,
    combined.cagrPct,
    combined.compoundedMaxDrawdownPct,
    combinedYears,
  );
  const combinedCashflow = summarizeMonthlyCashflowV7(combined.trades, { startTime: minT, endTime: maxT });

  return {
    perContract,
    combined: {
      count: combined.count,
      wins: combined.wins,
      losses: combined.losses,
      winRatePct: r2(combined.winRatePct),
      profitFactor: r2(combined.profitFactor),
      compoundedNetPct: r2(combined.compoundedNetPct),
      cagrPct: r2(combined.cagrPct),
      compoundedMaxDrawdownPct: r2(combined.compoundedMaxDrawdownPct),
      meanMonthlySweepPct: r2(combinedCashflow.meanMonthlySweepPct),
      ...cRatios,
      liquidationCount: combined.liquidationCount ?? 0,
    },
    streams,
  };
}

/**
 * Splits a stream strictly by UTC cutoff timestamp valEndTime so 15m and 1h streams
 * share the exact same chronological boundary between Cal+Val (48m) and Blind Holdout Y5 (12m).
 */
export function splitStreamTradesByCutoffTime(stream, valEndTime) {
  let calValEndIdx = stream.rows.findIndex(r => r.time > valEndTime);
  if (calValEndIdx === -1) calValEndIdx = stream.rows.length;
  const calValTrades = stream.trades.filter(t => {
    const exitT = stream.rows[t.exitIndex]?.time ?? Infinity;
    return exitT <= valEndTime;
  });
  const holdoutY5Trades = stream.trades.filter(t => {
    const sigT = stream.rows[t.signalIndex]?.time ?? 0;
    return sigT > valEndTime;
  });
  return {
    calValEndIdx,
    calValStream: { ...stream, rows: stream.rows.slice(0, calValEndIdx), trades: calValTrades },
    holdoutY5Stream: { ...stream, trades: holdoutY5Trades },
    fullStream: stream,
  };
}

export function scaleStreamTrades(stream, weight = 1.0) {
  if (Math.abs(weight - 1.0) < EPS) return stream;
  return {
    ...stream,
    trades: stream.trades.map(t => ({
      ...t,
      lev: (t.lev ?? 1.0) * weight,
      netPct: t.netPct * weight,
      grossPct: t.grossPct * weight,
      unleveredNetPct: t.unleveredNetPct ?? t.netPct / Math.max(1e-9, t.lev ?? 1.0),
      fundingCashflowPct: (t.fundingCashflowPct ?? 0) * weight,
      fundingDragPct: (t.fundingDragPct ?? 0) * weight,
    })),
  };
}

function normalizeStreamList(res) {
  if (Array.isArray(res)) return res;
  if (res && typeof res === 'object') {
    if (Array.isArray(res.streams)) return res.streams;
    return Object.values(res);
  }
  throw new Error('Expected array or map of streams');
}

function evaluatePortfolioWindowFast(streams, { maxTotalOpenLev, levScale, startTime, endTime }) {
  const compSim = simulatePortfolioV7(streams, {
    maxTotalOpenLev,
    levScale,
    mmr: 0.005,
    monthlyReset: false,
  });
  if ((compSim.liquidationCount ?? 0) > 0) {
    return { liquidationCount: compSim.liquidationCount, zeroLiquidationBothModes: false };
  }
  const compCash = summarizeMonthlyCashflowV7(compSim.trades, { startTime, endTime });
  return {
    count: compCash.count,
    winRatePct: r2(compCash.winRatePct),
    profitFactor: r2(compCash.profitFactor),
    meanMonthlySweepPct: r2(compCash.meanMonthlySweepPct),
    maxCompoundedDdPct: r2(compCash.maxCompoundedDdPct),
    cagrPct: r2(compCash.cagrPct),
    calmar: r2(compCash.cagrPct !== null && compCash.maxCompoundedDdPct > EPS ? compCash.cagrPct / compCash.maxCompoundedDdPct : null),
    liquidationCount: 0,
    zeroLiquidationBothModes: true,
  };
}

function evaluatePortfolioWindowFull(streams, { maxTotalOpenLev, levScale, startTime, endTime }) {
  const compSim = simulatePortfolioV7(streams, {
    maxTotalOpenLev,
    levScale,
    mmr: 0.005,
    monthlyReset: false,
  });
  const sweepSim = simulatePortfolioV7(streams, {
    maxTotalOpenLev,
    levScale,
    mmr: 0.005,
    monthlyReset: true,
  });
  const compCash = summarizeMonthlyCashflowV7(compSim.trades, { startTime, endTime });
  const sweepCash = summarizeMonthlyCashflowV7(sweepSim.trades, { startTime, endTime });
  const years = (endTime - startTime) / SECONDS_PER_YEAR;
  const ratios = computeSharpeSortinoCalmar(
    compSim.trades,
    compCash.cagrPct,
    compCash.maxCompoundedDdPct,
    years,
  );
  const totalLiqs = (compSim.liquidationCount ?? 0) + (sweepSim.liquidationCount ?? 0);

  return {
    count: compCash.count,
    winRatePct: r2(compCash.winRatePct),
    profitFactor: r2(compCash.profitFactor),
    totalMonths: sweepCash.totalMonths,
    meanMonthlySweepPct: r2(sweepCash.meanMonthlySweepPct),
    medianMonthlySweepPct: r2(sweepCash.medianMonthlySweepPct),
    pctPositiveMonths: r2(sweepCash.pctPositiveMonths),
    pctMonthsGe30: r2(sweepCash.pctMonthsGe30),
    worstMonthPct: r2(sweepCash.worstMonthPct),
    maxMonthlySweepDdPct: r2(sweepCash.maxMonthlySweepDdPct),
    totalSweptNetPct: r2(sweepCash.totalSweptNetPct),
    compoundedNetPct: r2(compCash.compoundedNetPct),
    cagrPct: r2(compCash.cagrPct),
    geomMonthlyPct: r2(compCash.geomMonthlyPct),
    maxCompoundedDdPct: r2(compCash.maxCompoundedDdPct),
    ...ratios,
    peakOpenLev: r2(compSim.peakOpenLev),
    peakConcurrentPositions: compSim.peakConcurrentPositions,
    scaledByCapCount: compSim.scaledByCapCount,
    skippedByCapCount: compSim.skippedByCapCount,
    liquidationCount: compSim.liquidationCount ?? 0,
    sweepLiquidationCount: sweepSim.liquidationCount ?? 0,
    zeroLiquidationBothModes: totalLiqs === 0,
    monthlyTable: sweepCash.monthlyTable.map(m => ({
      month: m.month,
      count: m.count,
      wins: m.wins,
      sweepNetPct: r2(m.sweepNetPct),
      additiveNetPct: r2(m.additiveNetPct),
      intraMonthMaxDdPct: r2(m.intraMonthMaxDdPct),
      liquidations: m.liquidations,
    })),
    perStream: compSim.perStream,
  };
}

function buildWeightPresets(calValInfos) {
  const presets = [];

  // 1) Equal weight across all Cal+Val passing streams
  presets.push({
    name: 'equal_calval',
    weights: Object.fromEntries(calValInfos.map(s => [s.id, 1.0])),
  });

  // 2) Cal+Val PF & WR tilted
  const pfTilted = {};
  const maxPf = Math.max(...calValInfos.map(s => s.calValPf));
  for (const s of calValInfos) {
    const ratio = maxPf > 0 ? s.calValPf / maxPf : 1.0;
    pfTilted[s.id] = Number((0.70 + 0.60 * ratio).toFixed(2));
  }
  presets.push({ name: 'calval_pf_tilted', weights: pfTilted });

  // 3) High-Velocity 15m boost (targeting monthly sweep throughput)
  const vel15m = {};
  for (const s of calValInfos) {
    vel15m[s.id] = s.id.includes('15m') ? 1.35 : 0.85;
  }
  presets.push({ name: 'velocity_15m', weights: vel15m });

  // 4) Strict WR >= 75% & PF >= 1.25 core streams only (zero weight for borderline streams)
  const coreOnly = {};
  let coreCount = 0;
  for (const s of calValInfos) {
    const isCore = s.calValWr >= 75.0 && s.calValPf >= 1.25;
    if (isCore) coreCount++;
    coreOnly[s.id] = isCore ? 1.0 : 0.0;
  }
  if (coreCount >= 2 && coreCount < calValInfos.length) {
    presets.push({ name: 'core_75wr_pf125', weights: coreOnly });
  }

  return presets;
}

export async function runPortfolioV7Frontier() {
  const { getV7BtcBnbStreams } = await import('./high_wr_v7_btc_bnb.mjs');
  const { getV7EthSolStreams } = await import('./high_wr_v7_eth_sol.mjs');

  const futuresOverlay = buildHighWrFuturesOverlayV7();

  const rawPostStreams = [
    ...normalizeStreamList(getV7BtcBnbStreams('EXCHANGE_POST_ONLY')),
    ...normalizeStreamList(getV7EthSolStreams('EXCHANGE_POST_ONLY')),
  ];
  const rawTakerStreams = [
    ...normalizeStreamList(getV7BtcBnbStreams('STRICT_TAKER')),
    ...normalizeStreamList(getV7EthSolStreams('STRICT_TAKER')),
  ];

  const postById = new Map(rawPostStreams.map(s => [s.id, s]));
  const takerById = new Map(rawTakerStreams.map(s => [s.id, s]));

  // Determine exact shared UTC 80% boundary from BTC_1h (43,952 bars)
  const btc1hRows = postById.get('BTC_1h').rows;
  const valEnd1h = Math.floor(btc1hRows.length * 0.80);
  const startTimeAll = btc1hRows[0].time;
  const calValEndTime = btc1hRows[valEnd1h - 1].time;
  const y5StartTime = btc1hRows[valEnd1h].time;
  const endTimeAll = btc1hRows[btc1hRows.length - 1].time;

  // 1) Screen streams STRICTLY on Cal+Val [0..80%) (48 months, zero Y5 peeking)
  const calValScreen = [];
  const selectedIds = [];
  for (const s of rawPostStreams) {
    const split = splitStreamTradesByCutoffTime(s, calValEndTime);
    const cvSim = simulatePortfolioV7([split.calValStream], { maxTotalOpenLev: 10.0, levScale: 1.0, mmr: 0.005 });
    const calValWr = cvSim.winRatePct ?? 0;
    const calValPf = cvSim.profitFactor ?? 0;
    const calValNet = cvSim.compoundedNetPct ?? 0;
    const keepOnCalVal = cvSim.count >= 40 && calValWr >= 73.5 && calValPf >= 1.20 && calValNet > 0;
    calValScreen.push({
      id: s.id,
      calValCount: cvSim.count,
      calValWr: r2(calValWr),
      calValPf: r2(calValPf),
      calValCompNetPct: r2(calValNet),
      keepOnCalVal,
    });
    if (keepOnCalVal) selectedIds.push(s.id);
  }
  assert.ok(selectedIds.length >= 2, `Insufficient Cal+Val-qualified v7 streams: ${selectedIds.join(', ')}`);

  const activeInfos = calValScreen.filter(x => selectedIds.includes(x.id));
  const weightPresets = buildWeightPresets(activeInfos);
  const levScales = [0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 7.5, 9.0, 11.0, 13.0];
  const maxLevCaps = [6.0, 10.0, 14.0, 20.0, 28.0, 40.0];

  // 2) Sweep weights, levScale, maxTotalOpenLev STRICTLY on Cal+Val [0..80%)
  const calValCandidates = [];
  for (const wp of weightPresets) {
    const activeWpIds = selectedIds.filter(id => (wp.weights[id] ?? 0) > 0);
    const weightedCalValStreams = activeWpIds.map(id =>
      scaleStreamTrades(splitStreamTradesByCutoffTime(postById.get(id), calValEndTime).calValStream, wp.weights[id]),
    );

    for (const maxTotalOpenLev of maxLevCaps) {
      for (const levScale of levScales) {
        if (maxTotalOpenLev < levScale * 1.5) continue;
        const fast = evaluatePortfolioWindowFast(weightedCalValStreams, {
          maxTotalOpenLev,
          levScale,
          startTime: startTimeAll,
          endTime: calValEndTime,
        });
        if (!fast.zeroLiquidationBothModes) break; // Higher levScale at same cap will also liquidate
        if ((fast.winRatePct ?? 0) < 75.0) continue;

        // Verify zero-liquidation under BOTH monthlyReset: false and monthlyReset: true on Cal+Val
        const sweepCheck = simulatePortfolioV7(weightedCalValStreams, {
          maxTotalOpenLev,
          levScale,
          mmr: 0.005,
          monthlyReset: true,
        });
        if ((sweepCheck.liquidationCount ?? 0) > 0) continue;

        const sweepCash = summarizeMonthlyCashflowV7(sweepCheck.trades, {
          startTime: startTimeAll,
          endTime: calValEndTime,
        });
        calValCandidates.push({
          weightPreset: wp.name,
          weights: wp.weights,
          activeWpIds,
          levScale,
          maxTotalOpenLev,
          calVal: {
            ...fast,
            meanMonthlySweepPct: r2(sweepCash.meanMonthlySweepPct),
          },
        });
      }
    }
  }

  assert.ok(calValCandidates.length > 0, 'No zero-liquidation >=75% WR candidates found on Cal+Val!');

  const safePool = calValCandidates.filter(c => (c.calVal.maxCompoundedDdPct ?? 100) <= 25.0);
  safePool.sort((a, b) =>
    ((b.calVal.calmar ?? 0) * 15 + (b.calVal.meanMonthlySweepPct ?? 0)) -
    ((a.calVal.calmar ?? 0) * 15 + (a.calVal.meanMonthlySweepPct ?? 0)),
  );
  const tier1 = safePool[0] ?? [...calValCandidates].sort((a, b) => a.calVal.maxCompoundedDdPct - b.calVal.maxCompoundedDdPct)[0];

  const balancedPool = calValCandidates.filter(c => (c.calVal.maxCompoundedDdPct ?? 100) <= 35.0);
  balancedPool.sort((a, b) =>
    ((b.calVal.meanMonthlySweepPct ?? 0) + (b.calVal.calmar ?? 0) * 10) -
    ((a.calVal.meanMonthlySweepPct ?? 0) + (a.calVal.calmar ?? 0) * 10),
  );
  const tier2 = balancedPool[0] ?? [...calValCandidates].sort((a, b) => a.calVal.maxCompoundedDdPct - b.calVal.maxCompoundedDdPct)[0];

  const ge30Pool = calValCandidates.filter(c => (c.calVal.meanMonthlySweepPct ?? 0) >= 30.0);
  let tier3;
  let target30AchievableZeroLiqOnCalVal = false;
  if (ge30Pool.length > 0) {
    target30AchievableZeroLiqOnCalVal = true;
    ge30Pool.sort((a, b) =>
      (a.calVal.maxCompoundedDdPct - b.calVal.maxCompoundedDdPct) ||
      (b.calVal.calmar - a.calVal.calmar),
    );
    tier3 = ge30Pool[0];
  } else {
    const maxPool = [...calValCandidates].sort((a, b) =>
      (b.calVal.meanMonthlySweepPct - a.calVal.meanMonthlySweepPct) ||
      (a.calVal.maxCompoundedDdPct - b.calVal.maxCompoundedDdPct),
    );
    tier3 = maxPool[0];
  }

  // 3) Unseal Blind Holdout Y5 (12 unseen months) + Full 5Y (60 months) ONCE for each locked tier
  const selectedTiers = [
    { tierKey: 'TIER_1_SAFE_75WR', def: TIER_DEFS_V7.SAFE_75WR, picked: tier1 },
    { tierKey: 'TIER_2_BALANCED_75WR', def: TIER_DEFS_V7.BALANCED_75WR, picked: tier2 },
    { tierKey: 'TIER_3_TARGET_30MO_75WR', def: TIER_DEFS_V7.TARGET_30MO_75WR, picked: tier3 },
  ];

  const tiersReport = {};
  for (const { tierKey, def, picked } of selectedTiers) {
    const profilesOut = {};
    for (const [profName, byId] of [
      ['EXCHANGE_POST_ONLY', postById],
      ['STRICT_TAKER', takerById],
    ]) {
      const calValStreams = picked.activeWpIds.map(id =>
        scaleStreamTrades(splitStreamTradesByCutoffTime(byId.get(id), calValEndTime).calValStream, picked.weights[id]),
      );
      const y5Streams = picked.activeWpIds.map(id =>
        scaleStreamTrades(splitStreamTradesByCutoffTime(byId.get(id), calValEndTime).holdoutY5Stream, picked.weights[id]),
      );
      const fullStreams = picked.activeWpIds.map(id =>
        scaleStreamTrades(byId.get(id), picked.weights[id]),
      );

      profilesOut[profName] = {
        calVal_48m: evaluatePortfolioWindowFull(calValStreams, {
          maxTotalOpenLev: picked.maxTotalOpenLev,
          levScale: picked.levScale,
          startTime: startTimeAll,
          endTime: calValEndTime,
        }),
        blindHoldoutY5_12m: evaluatePortfolioWindowFull(y5Streams, {
          maxTotalOpenLev: picked.maxTotalOpenLev,
          levScale: picked.levScale,
          startTime: y5StartTime,
          endTime: endTimeAll,
        }),
        full5y_60m: evaluatePortfolioWindowFull(fullStreams, {
          maxTotalOpenLev: picked.maxTotalOpenLev,
          levScale: picked.levScale,
          startTime: startTimeAll,
          endTime: endTimeAll,
        }),
      };
    }

    tiersReport[tierKey] = {
      tierKey,
      constraints: def,
      weightPreset: picked.weightPreset,
      weights: picked.weights,
      activeStreams: picked.activeWpIds,
      levScale: picked.levScale,
      maxTotalOpenLev: picked.maxTotalOpenLev,
      profiles: profilesOut,
    };
  }

  const maxCalValMonthlyZeroLiq = Math.max(...calValCandidates.map(c => c.calVal.meanMonthlySweepPct ?? 0));

  const summary = {
    schema: 'smc-v7-frontier-75wr-30mo-v1',
    generatedAt: new Date().toISOString(),
    antiLeakageProtocol: {
      splitRule: 'Cal+Val = [0..80%) (48 months), Blind Holdout Y5 = [80%..100%) (12 months)',
      selectionScope: 'Streams, weights, levScale, and maxTotalOpenLev selected strictly on Cal+Val [0..80%) with liquidationCount === 0 and WR >= 75%',
    },
    calValStreamScreening: calValScreen,
    selectedCryptoStreams: selectedIds,
    target30MoQuestion: {
      target30AchievableZeroLiqOnCalVal,
      maxZeroLiqCalValMeanMonthlySweepPct: r2(maxCalValMonthlyZeroLiq),
      postOnlyFull5yTier3MeanMonthlyPct: tiersReport.TIER_3_TARGET_30MO_75WR.profiles.EXCHANGE_POST_ONLY.full5y_60m.meanMonthlySweepPct,
      postOnlyHoldoutY5Tier3MeanMonthlyPct: tiersReport.TIER_3_TARGET_30MO_75WR.profiles.EXCHANGE_POST_ONLY.blindHoldoutY5_12m.meanMonthlySweepPct,
      strictTakerFull5yTier3MeanMonthlyPct: tiersReport.TIER_3_TARGET_30MO_75WR.profiles.STRICT_TAKER.full5y_60m.meanMonthlySweepPct,
      strictTakerHoldoutY5Tier3MeanMonthlyPct: tiersReport.TIER_3_TARGET_30MO_75WR.profiles.STRICT_TAKER.blindHoldoutY5_12m.meanMonthlySweepPct,
    },
    tiers: tiersReport,
    futures2y1hHighWrHelper: {
      perContract: futuresOverlay.perContract,
      combined: futuresOverlay.combined,
    },
  };

  fs.mkdirSync(RESULTS_V7_DIR, { recursive: true });
  fs.writeFileSync(SUMMARY_OUT_PATH, JSON.stringify(summary, null, 2));
  return summary;
}

function stripMonthly(m) {
  const { monthlyTable, perStream, ...rest } = m;
  return rest;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const summary = await runPortfolioV7Frontier();
  const compact = {
    calValStreamScreening: summary.calValStreamScreening,
    selectedCryptoStreams: summary.selectedCryptoStreams,
    target30MoQuestion: summary.target30MoQuestion,
    tiers: Object.fromEntries(
      Object.entries(summary.tiers).map(([k, t]) => [
        k,
        {
          weightPreset: t.weightPreset,
          activeStreams: t.activeStreams,
          levScale: t.levScale,
          maxTotalOpenLev: t.maxTotalOpenLev,
          postOnly: {
            calVal_48m: stripMonthly(t.profiles.EXCHANGE_POST_ONLY.calVal_48m),
            holdoutY5_12m: stripMonthly(t.profiles.EXCHANGE_POST_ONLY.blindHoldoutY5_12m),
            full5y_60m: stripMonthly(t.profiles.EXCHANGE_POST_ONLY.full5y_60m),
          },
          strictTaker: {
            calVal_48m: stripMonthly(t.profiles.STRICT_TAKER.calVal_48m),
            holdoutY5_12m: stripMonthly(t.profiles.STRICT_TAKER.blindHoldoutY5_12m),
            full5y_60m: stripMonthly(t.profiles.STRICT_TAKER.full5y_60m),
          },
        },
      ]),
    ),
    futures2y1hHighWrHelper: summary.futures2y1hHighWrHelper,
  };
  console.log(JSON.stringify(compact, null, 2));
}
