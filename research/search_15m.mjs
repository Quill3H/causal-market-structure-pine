import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build15mCandidates, generate15mSignals } from './signals_15m.mjs';
import { simulateTrades, wilsonLowerBound } from './sim_engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_DIR = path.join(HERE, 'results_15m');

const EPS = 1e-12;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function summarize(simResult) {
  const buys = simResult.trades.filter(t => t.side === 1);
  const sells = simResult.trades.filter(t => t.side === -1);
  const buyWins = buys.filter(t => t.netPct > EPS).length;
  const sellWins = sells.filter(t => t.netPct > EPS).length;
  return {
    count: simResult.count,
    wins: simResult.wins,
    losses: simResult.losses,
    ties: simResult.ties,
    winRatePct: simResult.winRatePct,
    wilsonLower95Pct: simResult.wilsonLower95Pct,
    meanNetPct: simResult.meanNetPct,
    meanGrossPct: simResult.meanGrossPct,
    totalNetPct: simResult.totalNetPct,
    maxDrawdownPct: simResult.maxDrawdownPct,
    profitFactor: simResult.profitFactor,
    exitReasons: simResult.exitReasons,
    purgedTrades: simResult.purgedTrades,
    expiredOrders: simResult.expiredOrders,
    buyCount: buys.length,
    buyWins,
    buyWinRatePct: buys.length > 0 ? (buyWins / buys.length) * 100 : null,
    sellCount: sells.length,
    sellWins,
    sellWinRatePct: sells.length > 0 ? (sellWins / sells.length) * 100 : null,
  };
}

function truncateHtfForRows(dataset, endIdx) {
  const rows = dataset.rows.slice(0, endIdx);
  const lastOpen = rows[rows.length - 1].time;
  const h1 = dataset.htf['1h'];
  const h1Int = h1.intervalSeconds ?? 3600;
  return {
    ...dataset,
    rows,
    htf: {
      ...dataset.htf,
      '1h': {
        ...h1,
        rows: h1.rows.filter(r => r.time + h1Int <= lastOpen),
        alignedIndex: h1.alignedIndex.slice(0, endIdx),
      },
    },
  };
}

function minSliding6kStats(rows, signals, simOptions, maxIdx) {
  let minCount = Infinity;
  let minWinRatePct = Infinity;
  let minProfitFactor = Infinity;
  for (let start = 0; start <= maxIdx - 6000; start += 2000) {
    const subRows = rows.slice(start, start + 6000);
    const subSigs = signals
      .filter(s => s.barIndex >= start && s.barIndex < start + 6000)
      .map(s => ({ ...s, barIndex: s.barIndex - start }));
    const res = simulateTrades(subRows, subSigs, { ...simOptions, start: 0, end: 6000 });
    if (res.count < minCount) minCount = res.count;
    if ((res.winRatePct ?? 0) < minWinRatePct) minWinRatePct = res.winRatePct ?? 0;
    if ((res.profitFactor ?? 0) < minProfitFactor) minProfitFactor = res.profitFactor ?? 0;
  }
  return {
    minCount: Number.isFinite(minCount) ? minCount : 0,
    minWinRatePct: Number.isFinite(minWinRatePct) ? minWinRatePct : 0,
    minProfitFactor: Number.isFinite(minProfitFactor) ? minProfitFactor : 0,
  };
}

function scoreCandidate(q1, q2, q3, calVal, calValNoBe, sliding6k) {
  const minQPf = Math.min((q1.profitFactor ?? 0) - 1, (q2.profitFactor ?? 0) - 1, (q3.profitFactor ?? 0) - 1);
  return (
    (calVal.wilsonLower95Pct ?? 0) +
    15 * ((calVal.profitFactor ?? 0) - 1) +
    20 * (sliding6k.minProfitFactor - 1) +
    15 * minQPf +
    40 * (calVal.meanNetPct ?? 0) +
    15 * ((calValNoBe.profitFactor ?? 0) - 1)
  );
}

function runSelectionPhase(fullDataset, lockPath, roundId) {
  const total = fullDataset.rows.length;
  const calEnd = Math.floor(total * 0.5);
  const q1End = Math.floor(calEnd * 0.5);
  const valEnd = Math.floor(total * 0.75);

  // Strictly slice out Holdout BEFORE generating or simulating any candidate!
  const calValDataset = truncateHtfForRows(fullDataset, valEnd);
  const candidates = build15mCandidates(calValDataset);

  const ranked = [];
  for (const cand of candidates) {
    const q1 = summarize(simulateTrades(calValDataset.rows, cand.signals, { ...cand.simOptions, start: 0, end: q1End }));
    const q2 = summarize(simulateTrades(calValDataset.rows, cand.signals, { ...cand.simOptions, start: q1End, end: calEnd }));
    const q3 = summarize(simulateTrades(calValDataset.rows, cand.signals, { ...cand.simOptions, start: calEnd, end: valEnd }));
    const q1NoBe = summarize(simulateTrades(calValDataset.rows, cand.signals, { ...cand.simOptions, beTriggerR: 0, start: 0, end: q1End }));
    const q2NoBe = summarize(simulateTrades(calValDataset.rows, cand.signals, { ...cand.simOptions, beTriggerR: 0, start: q1End, end: calEnd }));
    const q3NoBe = summarize(simulateTrades(calValDataset.rows, cand.signals, { ...cand.simOptions, beTriggerR: 0, start: calEnd, end: valEnd }));

    const cal = summarize(simulateTrades(calValDataset.rows, cand.signals, { ...cand.simOptions, start: 0, end: calEnd }));
    const val = q3;
    const calVal = summarize(simulateTrades(calValDataset.rows, cand.signals, { ...cand.simOptions, start: 0, end: valEnd }));
    const calValNoBe = summarize(simulateTrades(calValDataset.rows, cand.signals, { ...cand.simOptions, beTriggerR: 0, start: 0, end: valEnd }));
    const sliding6k = minSliding6kStats(calValDataset.rows, cand.signals, cand.simOptions, valEnd);
    const min6kCalVal = sliding6k.minCount;
    const minQNoBePf = Math.min(q1NoBe.profitFactor ?? 0, q2NoBe.profitFactor ?? 0, q3NoBe.profitFactor ?? 0);

    const eligible =
      cal.count >= 120 &&
      val.count >= 55 &&
      q1.count >= 55 &&
      q2.count >= 55 &&
      q3.count >= 55 &&
      (q1.winRatePct ?? 0) >= 66.0 &&
      (q2.winRatePct ?? 0) >= 66.0 &&
      (q3.winRatePct ?? 0) >= 66.0 &&
      (q1.profitFactor ?? 0) >= 1.30 &&
      (q2.profitFactor ?? 0) >= 1.30 &&
      (q3.profitFactor ?? 0) >= 1.30 &&
      (q1.meanNetPct ?? -1) > 0 &&
      (q2.meanNetPct ?? -1) > 0 &&
      (q3.meanNetPct ?? -1) > 0 &&
      (calVal.profitFactor ?? 0) >= 1.45 &&
      (calValNoBe.profitFactor ?? 0) >= 1.35 &&
      minQNoBePf >= 1.20 &&
      sliding6k.minCount >= 44 &&
      sliding6k.minWinRatePct >= 66.0 &&
      sliding6k.minProfitFactor >= 1.24 &&
      (calVal.buyWinRatePct ?? 0) >= 62.0 &&
      (calVal.sellWinRatePct ?? 0) >= 62.0;

    const score = scoreCandidate(q1, q2, q3, calVal, calValNoBe, sliding6k);
    ranked.push({
      id: cand.id,
      family: cand.family,
      params: cand.params,
      simOptions: cand.simOptions,
      eligible,
      score,
      min6kCalVal,
      sliding6k,
      q1,
      q2,
      q3,
      cal,
      val,
      calVal,
      calValNoBe,
    });
  }

  ranked.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (Math.abs(b.score - a.score) > 1e-12) return b.score - a.score;
    if (Math.abs((b.calVal.wilsonLower95Pct ?? 0) - (a.calVal.wilsonLower95Pct ?? 0)) > 1e-12) {
      return (b.calVal.wilsonLower95Pct ?? 0) - (a.calVal.wilsonLower95Pct ?? 0);
    }
    if (Math.abs((b.calVal.meanNetPct ?? 0) - (a.calVal.meanNetPct ?? 0)) > 1e-12) {
      return (b.calVal.meanNetPct ?? 0) - (a.calVal.meanNetPct ?? 0);
    }
    return a.id.localeCompare(b.id);
  });

  const winner = ranked[0];
  assert.ok(winner && winner.eligible, 'No eligible candidate cleared Cal+Val gates');

  const lockPayload = {
    roundId,
    lockedAt: new Date().toISOString(),
    datasetFile: 'data/btcusdt_15m_12m.json',
    datasetSha256: sha256File(path.join(DATA_DIR, 'btcusdt_15m_12m.json')),
    signalsSha256: sha256File(path.join(HERE, 'signals_15m.mjs')),
    simEngineSha256: sha256File(path.join(HERE, 'sim_engine.mjs')),
    splits: {
      totalBars: total,
      calRange: [0, calEnd],
      valRange: [calEnd, valEnd],
      holdoutRange: [valEnd, total],
    },
    rankingRule: 'eligible on Q1,Q2,Q3(count>=55,WR>=66,PF>=1.30,mean>0) & calValPF>=1.45 & noBE(calVal PF>=1.35, minQ PF>=1.20) & sliding6k(n>=44,WR>=66,PF>=1.24) & Buy/Sell>=62%; rank by wilsonLower95 + 15*(calValPF-1) + 20*(min6kPF-1) + 15*minQ(PF-1) + 40*meanNet + 15*(noBE_PF-1)',
    totalCandidatesEvaluated: ranked.length,
    eligibleCount: ranked.filter(r => r.eligible).length,
    winner: {
      id: winner.id,
      family: winner.family,
      params: winner.params,
      simOptions: winner.simOptions,
      score: winner.score,
      min6kCalVal: winner.min6kCalVal,
      sliding6k: winner.sliding6k,
      cal: winner.cal,
      val: winner.val,
      calVal: winner.calVal,
      calValNoBe: winner.calValNoBe,
    },
    top10CalVal: ranked.slice(0, 10).map(r => ({
      id: r.id,
      eligible: r.eligible,
      score: r.score,
      min6kCalVal: r.min6kCalVal,
      sliding6k: r.sliding6k,
      cal: { count: r.cal.count, winRatePct: r.cal.winRatePct, profitFactor: r.cal.profitFactor, meanNetPct: r.cal.meanNetPct },
      val: { count: r.val.count, winRatePct: r.val.winRatePct, profitFactor: r.val.profitFactor, meanNetPct: r.val.meanNetPct },
      calVal: { count: r.calVal.count, winRatePct: r.calVal.winRatePct, wilsonLower95Pct: r.calVal.wilsonLower95Pct, profitFactor: r.calVal.profitFactor, meanNetPct: r.calVal.meanNetPct },
    })),
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lockPayload, null, 2) + '\n', { flag: 'wx' });
  return lockPayload;
}

function evaluateGates(lock) {
  const btc12m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'btcusdt_15m_12m.json'), 'utf8'));
  const btcTv6k = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'btcusdt_tv_15m_6k.json'), 'utf8'));
  const eth6m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ethusdt_15m_6m.json'), 'utf8'));

  const { params, simOptions } = lock.winner;
  const [holdoutStart, holdoutEnd] = lock.splits.holdoutRange;

  // 1. Unseen Holdout (25% of 12m)
  const btc12mSignals = generate15mSignals(btc12m, params);
  const holdoutSim = simulateTrades(btc12m.rows, btc12mSignals, {
    ...simOptions,
    start: holdoutStart,
    end: holdoutEnd,
  });
  const holdoutNoBeSim = simulateTrades(btc12m.rows, btc12mSignals, {
    ...simOptions,
    beTriggerR: 0,
    start: holdoutStart,
    end: holdoutEnd,
  });
  const holdout = summarize(holdoutSim);
  const holdoutNoBe = summarize(holdoutNoBeSim);
  const holdoutPass =
    holdout.count >= 30 &&
    (holdout.winRatePct ?? 0) >= 65.0 &&
    (holdout.meanNetPct ?? -1) > 0 &&
    (holdout.profitFactor ?? 0) >= 1.2;

  // 2. TradingView 6,000-bar window
  const tv6kSignals = generate15mSignals(btcTv6k, params);
  const tv6kSim = simulateTrades(btcTv6k.rows, tv6kSignals, { ...simOptions, start: 0, end: btcTv6k.rows.length });
  const tv6kNoBeSim = simulateTrades(btcTv6k.rows, tv6kSignals, {
    ...simOptions,
    beTriggerR: 0,
    start: 0,
    end: btcTv6k.rows.length,
  });
  const tv6k = summarize(tv6kSim);
  const tv6kNoBe = summarize(tv6kNoBeSim);
  const tv6kPass =
    tv6k.count >= 40 &&
    (tv6k.winRatePct ?? 0) >= 65.0 &&
    (tv6k.meanNetPct ?? -1) > 0 &&
    (tv6k.profitFactor ?? 0) >= 1.2;

  // 3. 4-Fold Chronological Walk-Forward on 12m (4 consecutive quarters of 8,760 bars)
  const foldSize = Math.floor(btc12m.rows.length / 4);
  const folds = [];
  let wfWins = 0;
  let wfLosses = 0;
  let wfCount = 0;
  let wfNetSum = 0;
  let wfGains = 0;
  let wfLossSum = 0;
  for (let fIdx = 0; fIdx < 4; fIdx++) {
    const start = fIdx * foldSize;
    const end = fIdx === 3 ? btc12m.rows.length : (fIdx + 1) * foldSize;
    const sim = simulateTrades(btc12m.rows, btc12mSignals, { ...simOptions, start, end });
    const summary = summarize(sim);
    folds.push({
      fold: fIdx + 1,
      range: [start, end],
      startIso: new Date(btc12m.rows[start].time * 1000).toISOString(),
      endIso: new Date(btc12m.rows[end - 1].time * 1000).toISOString(),
      ...summary,
    });
    wfCount += sim.count;
    wfWins += sim.wins;
    wfLosses += sim.losses;
    for (const t of sim.trades) {
      wfNetSum += t.netPct;
      if (t.netPct > EPS) wfGains += t.netPct;
      else if (t.netPct < -EPS) wfLossSum -= t.netPct;
    }
  }
  const walkForwardAggregate = {
    count: wfCount,
    wins: wfWins,
    losses: wfLosses,
    winRatePct: wfCount > 0 ? (wfWins / wfCount) * 100 : null,
    wilsonLower95Pct: wfCount > 0 ? wilsonLowerBound(wfWins, wfCount, 1.96) : null,
    meanNetPct: wfCount > 0 ? wfNetSum / wfCount : null,
    totalNetPct: wfNetSum,
    profitFactor: wfLossSum > 0 ? wfGains / wfLossSum : null,
    folds,
  };
  const walkForwardPass =
    (walkForwardAggregate.winRatePct ?? 0) >= 65.0 &&
    (walkForwardAggregate.meanNetPct ?? -1) > 0;

  // 4. Full 12m combined & ETHUSDT 15m cross-asset
  const full12m = summarize(simulateTrades(btc12m.rows, btc12mSignals, simOptions));
  const full12mNoBe = summarize(simulateTrades(btc12m.rows, btc12mSignals, { ...simOptions, beTriggerR: 0 }));

  const ethSignals = generate15mSignals(eth6m, params);
  const eth = summarize(simulateTrades(eth6m.rows, ethSignals, simOptions));
  const ethNoBe = summarize(simulateTrades(eth6m.rows, ethSignals, { ...simOptions, beTriggerR: 0 }));

  const allGatesPass = holdoutPass && tv6kPass && walkForwardPass;

  return {
    roundId: lock.roundId,
    evaluatedAt: new Date().toISOString(),
    lockSha256: sha256File(path.join(RESULTS_DIR, 'selection-lock.json')),
    winner: lock.winner,
    gates: {
      holdoutPass,
      tv6kPass,
      walkForwardPass,
      allGatesPass,
    },
    holdout,
    holdoutNoBe,
    tv6k,
    tv6kNoBe,
    walkForwardAggregate,
    full12m,
    full12mNoBe,
    ethusdt15m: eth,
    ethusdt15mNoBe: ethNoBe,
  };
}

function main() {
  const roundId = 'round9-h1-cleandisp-be-scale';
  const lockPath = path.join(RESULTS_DIR, 'selection-lock.json');
  const btc12m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'btcusdt_15m_12m.json'), 'utf8'));

  let lock;
  if (fs.existsSync(lockPath)) {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.datasetSha256, sha256File(path.join(DATA_DIR, 'btcusdt_15m_12m.json')), 'Dataset hash changed after lock');
    console.log(`[search_15m] Loaded existing selection-lock.json (winner=${lock.winner.id})`);
  } else {
    lock = runSelectionPhase(btc12m, lockPath, roundId);
    console.log(`[search_15m] Locked winner on Cal+Val BEFORE Holdout: ${lock.winner.id}`);
  }

  const report = evaluateGates(lock);
  const reportPath = path.join(RESULTS_DIR, `${roundId}-results.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  const logPath = path.join(RESULTS_DIR, 'experiment_log.json');
  const log = fs.existsSync(logPath)
    ? JSON.parse(fs.readFileSync(logPath, 'utf8'))
    : { market: 'BINANCE:BTCUSDT', timeframe: '15m', rounds: [] };
  log.rounds = log.rounds.filter(r => r.roundId !== roundId);
  log.rounds.push({
    roundId,
    evaluatedAt: report.evaluatedAt,
    lockSha256: report.lockSha256,
    winnerId: report.winner.id,
    gates: report.gates,
    holdout: {
      count: report.holdout.count,
      winRatePct: report.holdout.winRatePct,
      meanNetPct: report.holdout.meanNetPct,
      profitFactor: report.holdout.profitFactor,
    },
    tv6k: {
      count: report.tv6k.count,
      winRatePct: report.tv6k.winRatePct,
      meanNetPct: report.tv6k.meanNetPct,
      profitFactor: report.tv6k.profitFactor,
    },
    walkForwardAggregate: {
      count: report.walkForwardAggregate.count,
      winRatePct: report.walkForwardAggregate.winRatePct,
      meanNetPct: report.walkForwardAggregate.meanNetPct,
      profitFactor: report.walkForwardAggregate.profitFactor,
    },
    ethusdt15m: {
      count: report.ethusdt15m.count,
      winRatePct: report.ethusdt15m.winRatePct,
      meanNetPct: report.ethusdt15m.meanNetPct,
      profitFactor: report.ethusdt15m.profitFactor,
    },
  });
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2) + '\n');

  console.log(JSON.stringify({
    winner: report.winner.id,
    lockSha256: report.lockSha256,
    gates: report.gates,
    cal: { n: report.winner.cal.count, wr: report.winner.cal.winRatePct, pf: report.winner.cal.profitFactor, mean: report.winner.cal.meanNetPct },
    val: { n: report.winner.val.count, wr: report.winner.val.winRatePct, pf: report.winner.val.profitFactor, mean: report.winner.val.meanNetPct },
    holdout: { n: report.holdout.count, wr: report.holdout.winRatePct, pf: report.holdout.profitFactor, mean: report.holdout.meanNetPct, exits: report.holdout.exitReasons, buy: `${report.holdout.buyWins}/${report.holdout.buyCount}`, sell: `${report.holdout.sellWins}/${report.holdout.sellCount}` },
    holdoutNoBe: { n: report.holdoutNoBe.count, wr: report.holdoutNoBe.winRatePct, pf: report.holdoutNoBe.profitFactor, mean: report.holdoutNoBe.meanNetPct },
    tv6k: { n: report.tv6k.count, wr: report.tv6k.winRatePct, pf: report.tv6k.profitFactor, mean: report.tv6k.meanNetPct, exits: report.tv6k.exitReasons },
    wf: {
      n: report.walkForwardAggregate.count,
      wr: report.walkForwardAggregate.winRatePct,
      pf: report.walkForwardAggregate.profitFactor,
      mean: report.walkForwardAggregate.meanNetPct,
      folds: report.walkForwardAggregate.folds.map(f => ({ fold: f.fold, n: f.count, wr: f.winRatePct, pf: f.profitFactor, mean: f.meanNetPct })),
    },
    eth: { n: report.ethusdt15m.count, wr: report.ethusdt15m.winRatePct, pf: report.ethusdt15m.profitFactor, mean: report.ethusdt15m.meanNetPct, exits: report.ethusdt15m.exitReasons },
    ethNoBe: { n: report.ethusdt15mNoBe.count, wr: report.ethusdt15mNoBe.winRatePct, pf: report.ethusdt15mNoBe.profitFactor, mean: report.ethusdt15mNoBe.meanNetPct },
  }, null, 2));
}

main();
