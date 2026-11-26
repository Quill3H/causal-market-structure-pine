import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  simulateTradesV7,
  simulatePortfolioV7,
  summarizeMonthlyCashflowV7,
} from './sim_engine_v7.mjs';
import {
  CRYPTO_REGIMES_V8,
  EQUITY_REGIMES_V8,
  precomputeCryptoBreadthV8,
  precomputeAssetRegimeV8,
  precomputeEquityRegimeV8,
} from './regime_engine_v8.mjs';
import {
  precomputeStockContextV6,
  generateStockSignalsV6,
  applyStockMlFilterV6,
  generateFutures1hSignalsCausal,
} from './suite_v6_stocks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V6_DIR = path.join(HERE, 'results_v6');
const RESULTS_V7_DIR = path.join(HERE, 'results_v7');
const RESULTS_V8_DIR = path.join(HERE, 'results_v8');
const V7_SUMMARY_PATH = path.join(RESULTS_V7_DIR, 'frontier_75wr_30mo_summary.json');
const V8_SUMMARY_OUT_PATH = path.join(RESULTS_V8_DIR, 'maximized_v8_summary.json');

const EPS = 1e-12;
const SECONDS_PER_YEAR = 365.25 * 86400;

export const TIER_DEFS_V8 = Object.freeze({
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
  MAXIMIZED_30MO_75WR: Object.freeze({
    key: 'MAXIMIZED_30MO_75WR',
    label: 'TIER_3_MAXIMIZED_30MO_75WR',
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

function formatSimStats(sim, rows, startIdx, endIdx) {
  const years = endIdx - startIdx >= 2
    ? (rows[endIdx - 1].time - rows[startIdx].time) / SECONDS_PER_YEAR
    : 0;
  const ratios = computeSharpeSortinoCalmar(
    sim.trades,
    sim.cagrPct,
    sim.compoundedMaxDrawdownPct,
    years,
  );
  let buyHoldPct = null;
  let buyHoldMaxDdPct = null;
  if (endIdx - startIdx >= 1) {
    const sc = rows[startIdx].close;
    const ec = rows[endIdx - 1].close;
    buyHoldPct = ((ec - sc) / sc) * 100;
    let pk = sc;
    let mdd = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const c = rows[i].close;
      if (c > pk) pk = c;
      const dd = pk > 0 ? ((pk - c) / pk) * 100 : 0;
      if (dd > mdd) mdd = dd;
    }
    buyHoldMaxDdPct = mdd;
  }
  return {
    count: sim.count,
    wins: sim.wins,
    losses: sim.losses,
    winRatePct: r2(sim.winRatePct),
    profitFactor: r2(sim.profitFactor),
    totalNetPct: r2(sim.totalNetPct),
    compoundedNetPct: r2(sim.compoundedNetPct),
    cagrPct: r2(sim.cagrPct),
    compoundedMaxDrawdownPct: r2(sim.compoundedMaxDrawdownPct),
    ...ratios,
    buyHoldPct: r2(buyHoldPct),
    buyHoldMaxDdPct: r2(buyHoldMaxDdPct),
    liquidationCount: sim.liquidationCount ?? 0,
  };
}

/**
 * Upgrades US Stock Indices (SPY, DIA, QQQ 10Y Daily) + 2Y 1h Futures (ES=F, NQ=F)
 * with causal precomputeEquityRegimeV8 gating & Two-Stage High-WR TP1 exits.
 */
export function buildEquitiesAndFuturesV8Sleeve() {
  const models = JSON.parse(fs.readFileSync(path.join(RESULTS_V6_DIR, 'models_stocks_v6.json'), 'utf8')).models;
  const macro = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities10y_macro_1d.json'), 'utf8'));
  const sp = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities10y_sp500_1d.json'), 'utf8'));
  const dia = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities10y_dow_1d.json'), 'utf8'));
  const qqq = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'equities10y_nasdaq_1d.json'), 'utf8'));
  const dss = { SPY: sp, DIA: dia, QQQ: qqq };
  const aux = { macro, diaRows: dia.rows, qqqRows: qqq.rows };

  const perIndex = {};
  const portfolioStreams = { full10y: [], oos5y: [], holdout2y: [] };

  for (const asset of ['SPY', 'DIA', 'QQQ']) {
    const ds = dss[asset];
    const ms = models[asset];
    const n = ds.rows.length;
    const calEnd = Math.floor(n * 0.50);
    const valEnd = Math.floor(n * 0.80);

    const ctx = precomputeStockContextV6(ds, aux);
    const reg = precomputeEquityRegimeV8(ds, macro);
    const raw = generateStockSignalsV6(ds, ms.signalSpec, aux, ctx);
    const ml = applyStockMlFilterV6(ds, raw, ms, aux, ctx);

    // Causal v8 regime gating: block falling-knife Longs in BEAR_TREND, gate Shorts to BEAR_TREND
    const v8Sigs = ml.filter(s => {
      const r = reg.getRegimeAt(s.barIndex);
      if (s.side === 1 && r.regime === EQUITY_REGIMES_V8.BEAR_TREND) return false;
      if (s.side === -1 && r.regime !== EQUITY_REGIMES_V8.BEAR_TREND) return false;
      return true;
    }).map(s => {
      const r = reg.getRegimeAt(s.barIndex);
      return {
        ...s,
        meta: { ...(s.meta ?? {}), equityRegimeV8: r.regime },
      };
    });

    const execOpts = {
      ...ms.execOptions,
      tp1TriggerR: 0.65,
      tp1QtyPct: 50,
      tp1LockOffsetR: 0.30,
      rewardRisk: 1.15,
      beTriggerR: 0.38,
      beOffsetPct: 0.15,
    };

    const simCalVal = simulateTradesV7(ds.rows, v8Sigs, { ...execOpts, start: 0, end: valEnd });
    const simHoldout = simulateTradesV7(ds.rows, v8Sigs, { ...execOpts, start: valEnd, end: n });
    const simOos5y = simulateTradesV7(ds.rows, v8Sigs, { ...execOpts, start: calEnd, end: n });
    const simFull10y = simulateTradesV7(ds.rows, v8Sigs, { ...execOpts, start: 0, end: n });

    perIndex[asset] = {
      symbol: ms.symbol,
      benchmarkSymbol: ms.benchmarkSymbol,
      calVal_8y: formatSimStats(simCalVal, ds.rows, 0, valEnd),
      holdout_2y: formatSimStats(simHoldout, ds.rows, valEnd, n),
      oos_5y: formatSimStats(simOos5y, ds.rows, calEnd, n),
      full_10y: formatSimStats(simFull10y, ds.rows, 0, n),
    };

    portfolioStreams.full10y.push({ id: asset, rows: ds.rows, trades: simFull10y.trades, intervalSeconds: 86400 });
    portfolioStreams.oos5y.push({ id: asset, rows: ds.rows, trades: simOos5y.trades, intervalSeconds: 86400 });
    portfolioStreams.holdout2y.push({ id: asset, rows: ds.rows, trades: simHoldout.trades, intervalSeconds: 86400 });
  }

  const refRows = sp.rows;
  const nRef = refRows.length;
  const calEndRef = Math.floor(nRef * 0.50);
  const valEndRef = Math.floor(nRef * 0.80);

  const summarizeEqPort = (streams, sIdx, eIdx) => {
    const p = simulatePortfolioV7(streams, { maxTotalOpenLev: 3.0, levScale: 1.0, mmr: 0.005 });
    const startTime = refRows[sIdx].time;
    const endTime = refRows[eIdx - 1].time;
    const cash = summarizeMonthlyCashflowV7(p.trades, { startTime, endTime });
    const years = (endTime - startTime) / SECONDS_PER_YEAR;
    const ratios = computeSharpeSortinoCalmar(p.trades, cash.cagrPct, cash.maxCompoundedDdPct, years);
    return {
      count: cash.count,
      winRatePct: r2(cash.winRatePct),
      profitFactor: r2(cash.profitFactor),
      compoundedNetPct: r2(cash.compoundedNetPct),
      cagrPct: r2(cash.cagrPct),
      maxCompoundedDdPct: r2(cash.maxCompoundedDdPct),
      meanMonthlySweepPct: r2(cash.meanMonthlySweepPct),
      ...ratios,
      liquidationCount: p.liquidationCount ?? 0,
    };
  };

  const multiIndexPortfolio = {
    full_10y: summarizeEqPort(portfolioStreams.full10y, 0, nRef),
    oos_5y: summarizeEqPort(portfolioStreams.oos5y, calEndRef, nRef),
    holdout_2y: summarizeEqPort(portfolioStreams.holdout2y, valEndRef, nRef),
  };

  // 2Y 1h Futures (ES=F, NQ=F) with causal 1d EquityRegimeV8 gating
  const futuresPerContract = {};
  const futuresStreams = [];
  for (const [asset, futFile, sym] of [
    ['SPY', 'equities2y_es_1h.json', 'ES=F'],
    ['QQQ', 'equities2y_nq_1h.json', 'NQ=F'],
  ]) {
    const ms = models[asset];
    const futDs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, futFile), 'utf8'));
    const h1d = futDs.htf['1d'];
    const regDaily = precomputeEquityRegimeV8({ rows: h1d.rows }, macro);

    const rawFutSigs = generateFutures1hSignalsCausal(futDs, ms, aux).mlSignals;
    const v8FutSigs = rawFutSigs.filter(s => {
      const dj = s.meta?.htfDailyIndex;
      if (!Number.isSafeInteger(dj) || dj < 0) return true;
      const r = regDaily.getRegimeAt(dj);
      if (s.side === 1 && r.regime === EQUITY_REGIMES_V8.BEAR_TREND) return false;
      if (s.side === -1 && r.regime !== EQUITY_REGIMES_V8.BEAR_TREND) return false;
      return true;
    });

    const futExec = {
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

    const sim = simulateTradesV7(futDs.rows, v8FutSigs, { ...futExec, start: 0, end: futDs.rows.length });
    futuresPerContract[sym] = formatSimStats(sim, futDs.rows, 0, futDs.rows.length);
    futuresStreams.push({ id: `${sym}_1h`, rows: futDs.rows, trades: sim.trades, intervalSeconds: 3600 });
  }

  const fMinT = Math.min(...futuresStreams.map(s => s.rows[0].time));
  const fMaxT = Math.max(...futuresStreams.map(s => s.rows[s.rows.length - 1].time));
  const fPort = simulatePortfolioV7(futuresStreams, { maxTotalOpenLev: 2.0, levScale: 1.0, mmr: 0.005 });
  const fCash = summarizeMonthlyCashflowV7(fPort.trades, { startTime: fMinT, endTime: fMaxT });
  const fRatios = computeSharpeSortinoCalmar(
    fPort.trades,
    fCash.cagrPct,
    fCash.maxCompoundedDdPct,
    (fMaxT - fMinT) / SECONDS_PER_YEAR,
  );

  return {
    perIndex,
    multiIndexPortfolio,
    futures2y1h: {
      perContract: futuresPerContract,
      combined: {
        count: fCash.count,
        winRatePct: r2(fCash.winRatePct),
        profitFactor: r2(fCash.profitFactor),
        compoundedNetPct: r2(fCash.compoundedNetPct),
        cagrPct: r2(fCash.cagrPct),
        maxCompoundedDdPct: r2(fCash.maxCompoundedDdPct),
        meanMonthlySweepPct: r2(fCash.meanMonthlySweepPct),
        ...fRatios,
        liquidationCount: fPort.liquidationCount ?? 0,
      },
    },
  };
}

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

export function applyRegimeAndWeightToStream(stream, weight = 1.0, regimeCtx = null, regimeRule = 'flat') {
  return {
    ...stream,
    trades: stream.trades.map(t => {
      let regMult = 1.0;
      if (regimeCtx && regimeRule !== 'flat') {
        const idx = t.signalIndex ?? t.entryIndex;
        const reg = regimeCtx.regime[idx];
        const side = t.side ?? 1;
        if (regimeRule === 'aligned_boost') {
          if ((side === 1 && reg === CRYPTO_REGIMES_V8.BULL_TREND) ||
              (side === -1 && reg === CRYPTO_REGIMES_V8.BEAR_TREND)) {
            regMult = 1.18;
          } else if (reg === CRYPTO_REGIMES_V8.RANGE_CHOP) {
            regMult = 0.70;
          } else if (reg === CRYPTO_REGIMES_V8.BEAR_SQUEEZE) {
            regMult = side === -1 ? 0.0 : 0.60;
          } else {
            regMult = 0.65;
          }
        } else if (regimeRule === 'regime_native_mult') {
          regMult = side === 1 ? regimeCtx.longSizeMult[idx] : regimeCtx.shortSizeMult[idx];
        }
      }
      const effW = weight * regMult;
      if (Math.abs(effW - 1.0) < EPS) return t;
      return {
        ...t,
        lev: (t.lev ?? 1.0) * effW,
        netPct: t.netPct * effW,
        grossPct: t.grossPct * effW,
        unleveredNetPct: t.unleveredNetPct ?? t.netPct / Math.max(1e-9, t.lev ?? 1.0),
        fundingCashflowPct: (t.fundingCashflowPct ?? 0) * effW,
        fundingDragPct: (t.fundingDragPct ?? 0) * effW,
      };
    }).filter(t => (t.lev ?? 1.0) > EPS),
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

  presets.push({
    name: 'equal_calval',
    weights: Object.fromEntries(calValInfos.map(s => [s.id, 1.0])),
  });

  const pfTilted = {};
  const maxPf = Math.max(...calValInfos.map(s => s.calValPf));
  for (const s of calValInfos) {
    const ratio = maxPf > 0 ? s.calValPf / maxPf : 1.0;
    pfTilted[s.id] = Number((0.70 + 0.60 * ratio).toFixed(2));
  }
  presets.push({ name: 'calval_pf_tilted', weights: pfTilted });

  const vel15m = {};
  for (const s of calValInfos) {
    vel15m[s.id] = s.id.includes('15m') ? 1.30 : 0.85;
  }
  presets.push({ name: 'velocity_15m', weights: vel15m });

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

  const eliteCore = {};
  let eliteCount = 0;
  for (const s of calValInfos) {
    const isElite = s.calValWr >= 77.5 && s.calValPf >= 1.55;
    if (isElite) eliteCount++;
    eliteCore[s.id] = isElite ? 1.0 : 0.0;
  }
  if (eliteCount >= 2 && eliteCount < calValInfos.length) {
    presets.push({ name: 'elite_77wr_pf155', weights: eliteCore });
  }

  return presets;
}

function loadCryptoRegimeContexts(rawStreams) {
  const ds1hByCoin = {};
  for (const coin of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']) {
    const fname = `crypto5y_${coin.toLowerCase()}_1h.json`;
    ds1hByCoin[coin] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, fname), 'utf8'));
  }
  const breadthCtx = precomputeCryptoBreadthV8(ds1hByCoin);
  const regimeByStreamId = new Map();
  for (const s of rawStreams) {
    if (s.regimeContext) {
      regimeByStreamId.set(s.id, s.regimeContext);
      continue;
    }
    const coin = String(s.coin ?? `${s.id.split('_')[0]}USDT`).toLowerCase();
    const tf = String(s.timeframe ?? s.id.split('_')[1] ?? '1h').toLowerCase();
    const ds = tf === '1h' && ds1hByCoin[coin.toUpperCase()]
      ? ds1hByCoin[coin.toUpperCase()]
      : JSON.parse(fs.readFileSync(path.join(DATA_DIR, `crypto5y_${coin}_${tf}.json`), 'utf8'));
    regimeByStreamId.set(s.id, precomputeAssetRegimeV8(ds, breadthCtx));
  }
  return { breadthCtx, regimeByStreamId };
}

function buildV7VsV8Comparison(tiersReport) {
  if (!fs.existsSync(V7_SUMMARY_PATH)) return null;
  const v7 = JSON.parse(fs.readFileSync(V7_SUMMARY_PATH, 'utf8'));
  const pairs = [
    ['TIER_1_SAFE_75WR', 'TIER_1_SAFE_75WR'],
    ['TIER_2_BALANCED_75WR', 'TIER_2_BALANCED_75WR'],
    ['TIER_3_TARGET_30MO_75WR', 'TIER_3_MAXIMIZED_30MO_75WR'],
  ];
  const matrix = {};
  for (const [v7Key, v8Key] of pairs) {
    const t7 = v7.tiers?.[v7Key];
    const t8 = tiersReport?.[v8Key];
    if (!t7 || !t8) continue;
    matrix[v8Key] = {};
    for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
      matrix[v8Key][prof] = {};
      for (const win of ['calVal_48m', 'blindHoldoutY5_12m', 'full5y_60m']) {
        const a = t7.profiles?.[prof]?.[win];
        const b = t8.profiles?.[prof]?.[win];
        if (!a || !b) continue;
        matrix[v8Key][prof][win] = {
          v7: {
            count: a.count,
            winRatePct: a.winRatePct,
            profitFactor: a.profitFactor,
            meanMonthlySweepPct: a.meanMonthlySweepPct,
            pctMonthsGe30: a.pctMonthsGe30,
            worstMonthPct: a.worstMonthPct,
            maxMonthlySweepDdPct: a.maxMonthlySweepDdPct,
            maxCompoundedDdPct: a.maxCompoundedDdPct,
            compoundedNetPct: a.compoundedNetPct,
            liquidationCount: a.liquidationCount,
          },
          v8: {
            count: b.count,
            winRatePct: b.winRatePct,
            profitFactor: b.profitFactor,
            meanMonthlySweepPct: b.meanMonthlySweepPct,
            pctMonthsGe30: b.pctMonthsGe30,
            worstMonthPct: b.worstMonthPct,
            maxMonthlySweepDdPct: b.maxMonthlySweepDdPct,
            maxCompoundedDdPct: b.maxCompoundedDdPct,
            compoundedNetPct: b.compoundedNetPct,
            liquidationCount: b.liquidationCount,
          },
          delta: {
            winRatePct: r2((b.winRatePct ?? 0) - (a.winRatePct ?? 0)),
            profitFactor: r2((b.profitFactor ?? 0) - (a.profitFactor ?? 0)),
            meanMonthlySweepPct: r2((b.meanMonthlySweepPct ?? 0) - (a.meanMonthlySweepPct ?? 0)),
            worstMonthPct: r2((b.worstMonthPct ?? 0) - (a.worstMonthPct ?? 0)),
            maxCompoundedDdPct: r2((b.maxCompoundedDdPct ?? 0) - (a.maxCompoundedDdPct ?? 0)),
          },
        };
      }
    }
  }
  return matrix;
}

export async function runPortfolioV8RegimeMaximizer() {
  const equitiesAndFuturesV8 = buildEquitiesAndFuturesV8Sleeve();

  const { getV8BtcBnbStreams } = await import('./regime_v8_btc_bnb.mjs');
  const { getV8EthSolStreams } = await import('./regime_v8_eth_sol.mjs');

  const rawPostStreams = [
    ...normalizeStreamList(getV8BtcBnbStreams('EXCHANGE_POST_ONLY')),
    ...normalizeStreamList(getV8EthSolStreams('EXCHANGE_POST_ONLY')),
  ];
  const rawTakerStreams = [
    ...normalizeStreamList(getV8BtcBnbStreams('STRICT_TAKER')),
    ...normalizeStreamList(getV8EthSolStreams('STRICT_TAKER')),
  ];

  const postById = new Map(rawPostStreams.map(s => [s.id, s]));
  const takerById = new Map(rawTakerStreams.map(s => [s.id, s]));
  const { regimeByStreamId } = loadCryptoRegimeContexts(rawPostStreams);

  const btc1hRows = postById.get('BTC_1h').rows;
  const valEnd1h = Math.floor(btc1hRows.length * 0.80);
  const startTimeAll = btc1hRows[0].time;
  const calValEndTime = btc1hRows[valEnd1h - 1].time;
  const y5StartTime = btc1hRows[valEnd1h].time;
  const endTimeAll = btc1hRows[btc1hRows.length - 1].time;

  // 1) Screen v8 crypto streams STRICTLY on Cal+Val [0..80%) (49m)
  const calValScreen = [];
  const selectedIds = [];
  for (const s of rawPostStreams) {
    const split = splitStreamTradesByCutoffTime(s, calValEndTime);
    const cvSim = simulatePortfolioV7([split.calValStream], { maxTotalOpenLev: 10.0, levScale: 1.0, mmr: 0.005 });
    const calValWr = cvSim.winRatePct ?? 0;
    const calValPf = cvSim.profitFactor ?? 0;
    const calValNet = cvSim.compoundedNetPct ?? 0;
    const keepOnCalVal = cvSim.count >= 40 && calValWr >= 72.0 && calValPf >= 1.20 && calValNet > 0;
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
  assert.ok(selectedIds.length >= 2, `Insufficient Cal+Val-qualified v8 streams: ${selectedIds.join(', ')}`);

  const activeInfos = calValScreen.filter(x => selectedIds.includes(x.id));
  const weightPresets = buildWeightPresets(activeInfos);
  const regimeRules = ['flat', 'aligned_boost', 'regime_native_mult'];
  const levScales = [0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.5, 7.5];
  const maxLevCaps = [8.0, 14.0, 22.0, 32.0];

  // 2) Tune weights, regime-dynamic allocation, levScale, maxTotalOpenLev STRICTLY on Cal+Val [0..80%)
  const calValCandidates = [];
  for (const wp of weightPresets) {
    const activeWpIds = selectedIds.filter(id => (wp.weights[id] ?? 0) > 0);
    for (const regimeRule of regimeRules) {
      const weightedCalValStreams = activeWpIds.map(id =>
        applyRegimeAndWeightToStream(
          splitStreamTradesByCutoffTime(postById.get(id), calValEndTime).calValStream,
          wp.weights[id],
          regimeByStreamId.get(id),
          regimeRule,
        ),
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
          if (!fast.zeroLiquidationBothModes) break;
          if ((fast.winRatePct ?? 0) < 75.0) continue;

          calValCandidates.push({
            weightPreset: wp.name,
            weights: wp.weights,
            regimeRule,
            activeWpIds,
            weightedCalValStreams,
            levScale,
            maxTotalOpenLev,
            calVal: fast,
          });
        }
      }
    }
  }

  assert.ok(calValCandidates.length > 0, 'No zero-liquidation >=75% WR candidates found on Cal+Val v8!');

  const verifySweepZeroLiq = (cand) => {
    const sweepCheck = simulatePortfolioV7(cand.weightedCalValStreams, {
      maxTotalOpenLev: cand.maxTotalOpenLev,
      levScale: cand.levScale,
      mmr: 0.005,
      monthlyReset: true,
    });
    if ((sweepCheck.liquidationCount ?? 0) > 0) return false;
    const sweepCash = summarizeMonthlyCashflowV7(sweepCheck.trades, {
      startTime: startTimeAll,
      endTime: calValEndTime,
    });
    cand.calVal.meanMonthlySweepPct = r2(sweepCash.meanMonthlySweepPct);
    return true;
  };

  const pickFirstZeroLiq = (pool) => {
    for (const c of pool) {
      if (verifySweepZeroLiq(c)) return c;
    }
    return null;
  };

  const safePool = calValCandidates.filter(c => (c.calVal.maxCompoundedDdPct ?? 100) <= 25.0);
  safePool.sort((a, b) =>
    ((b.calVal.calmar ?? 0) * 15 + (b.calVal.meanMonthlySweepPct ?? 0)) -
    ((a.calVal.calmar ?? 0) * 15 + (a.calVal.meanMonthlySweepPct ?? 0)),
  );
  const tier1 = pickFirstZeroLiq(safePool) ?? pickFirstZeroLiq([...calValCandidates].sort((a, b) => a.calVal.maxCompoundedDdPct - b.calVal.maxCompoundedDdPct));

  const balancedPool = calValCandidates.filter(c => (c.calVal.maxCompoundedDdPct ?? 100) <= 35.0);
  balancedPool.sort((a, b) =>
    ((b.calVal.meanMonthlySweepPct ?? 0) + (b.calVal.calmar ?? 0) * 10) -
    ((a.calVal.meanMonthlySweepPct ?? 0) + (a.calVal.calmar ?? 0) * 10),
  );
  const tier2 = pickFirstZeroLiq(balancedPool) ?? tier1;

  const ge30Pool = calValCandidates.filter(c => (c.calVal.meanMonthlySweepPct ?? 0) >= 30.0);
  ge30Pool.sort((a, b) =>
    (a.calVal.maxCompoundedDdPct - b.calVal.maxCompoundedDdPct) ||
    (b.calVal.calmar - a.calVal.calmar),
  );
  let tier3 = pickFirstZeroLiq(ge30Pool);
  let target30AchievableZeroLiqOnCalVal = false;
  if (tier3) {
    target30AchievableZeroLiqOnCalVal = true;
  } else {
    const maxPool = [...calValCandidates].sort((a, b) =>
      (b.calVal.meanMonthlySweepPct - a.calVal.meanMonthlySweepPct) ||
      (a.calVal.maxCompoundedDdPct - b.calVal.maxCompoundedDdPct),
    );
    tier3 = pickFirstZeroLiq(maxPool);
  }

  // 3) Unseal Blind Holdout Y5 (13m Bear Market) + Full 5Y (61m) ONCE
  const selectedTiers = [
    { tierKey: 'TIER_1_SAFE_75WR', def: TIER_DEFS_V8.SAFE_75WR, picked: tier1 },
    { tierKey: 'TIER_2_BALANCED_75WR', def: TIER_DEFS_V8.BALANCED_75WR, picked: tier2 },
    { tierKey: 'TIER_3_MAXIMIZED_30MO_75WR', def: TIER_DEFS_V8.MAXIMIZED_30MO_75WR, picked: tier3 },
  ];

  const tiersReport = {};
  for (const { tierKey, def, picked } of selectedTiers) {
    const profilesOut = {};
    for (const [profName, byId] of [
      ['EXCHANGE_POST_ONLY', postById],
      ['STRICT_TAKER', takerById],
    ]) {
      const calValStreams = picked.activeWpIds.map(id =>
        applyRegimeAndWeightToStream(
          splitStreamTradesByCutoffTime(byId.get(id), calValEndTime).calValStream,
          picked.weights[id],
          regimeByStreamId.get(id),
          picked.regimeRule,
        ),
      );
      const y5Streams = picked.activeWpIds.map(id =>
        applyRegimeAndWeightToStream(
          splitStreamTradesByCutoffTime(byId.get(id), calValEndTime).holdoutY5Stream,
          picked.weights[id],
          regimeByStreamId.get(id),
          picked.regimeRule,
        ),
      );
      const fullStreams = picked.activeWpIds.map(id =>
        applyRegimeAndWeightToStream(
          byId.get(id),
          picked.weights[id],
          regimeByStreamId.get(id),
          picked.regimeRule,
        ),
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
      regimeRule: picked.regimeRule,
      weights: picked.weights,
      activeStreams: picked.activeWpIds,
      levScale: picked.levScale,
      maxTotalOpenLev: picked.maxTotalOpenLev,
      profiles: profilesOut,
    };
  }

  const maxCalValMonthlyZeroLiq = Math.max(...calValCandidates.map(c => c.calVal.meanMonthlySweepPct ?? 0));
  const v7VsV8Comparison = buildV7VsV8Comparison(tiersReport);

  const summary = {
    schema: 'smc-v8-regime-maximized-v1',
    generatedAt: new Date().toISOString(),
    antiLeakageProtocol: {
      splitRule: 'Cal+Val = [0..80%) (49 UTC months), Blind Holdout Y5 = [80%..100%) (13 UTC months)',
      selectionScope: 'Streams, weights, regimeRule, levScale, and maxTotalOpenLev selected strictly on Cal+Val [0..80%) with liquidationCount === 0 and WR >= 75%',
    },
    calValStreamScreening: calValScreen,
    selectedCryptoStreams: selectedIds,
    maxZeroLiqCalValMeanMonthlySweepPct: r2(maxCalValMonthlyZeroLiq),
    target30AchievableZeroLiqOnCalVal,
    tiers: tiersReport,
    v7VsV8Comparison,
    equitiesAndFuturesV8,
  };

  fs.mkdirSync(RESULTS_V8_DIR, { recursive: true });
  fs.writeFileSync(V8_SUMMARY_OUT_PATH, JSON.stringify(summary, null, 2));
  return summary;
}

function stripMonthly(m) {
  const { monthlyTable, perStream, ...rest } = m;
  return rest;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const arg = process.argv[2] ?? '--run-all';
  if (arg === '--equities-only') {
    console.log(JSON.stringify(buildEquitiesAndFuturesV8Sleeve(), null, 2));
  } else {
    const summary = await runPortfolioV8RegimeMaximizer();
    console.log(JSON.stringify({
      calValStreamScreening: summary.calValStreamScreening,
      selectedCryptoStreams: summary.selectedCryptoStreams,
      maxZeroLiqCalValMeanMonthlySweepPct: summary.maxZeroLiqCalValMeanMonthlySweepPct,
      tiers: Object.fromEntries(
        Object.entries(summary.tiers).map(([k, t]) => [
          k,
          {
            weightPreset: t.weightPreset,
            regimeRule: t.regimeRule,
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
      v7VsV8Comparison: summary.v7VsV8Comparison,
      equitiesAndFuturesV8: summary.equitiesAndFuturesV8,
    }, null, 2));
  }
}
