import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sliceDatasetPrefix1h,
  generateSignals1h,
  buildCandidateCatalog1h,
} from './signals_1h.mjs';
import { simulateTrades, wilsonLowerBound } from './sim_engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results_1h');

const sha256Text = text => crypto.createHash('sha256').update(text).digest('hex');
const sha256File = filePath => sha256Text(fs.readFileSync(filePath));
const summarizeMetrics = sim => {
  const { trades, openPosition, pending, ...rest } = sim;
  return rest;
};

function summarizeTradeList(trades) {
  const EPS = 1e-12;
  const count = trades.length;
  let wins = 0;
  let losses = 0;
  let gains = 0;
  let lossSum = 0;
  let grossSum = 0;
  let netSum = 0;
  let cum = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  const exitReasons = { SL: 0, TP: 0, TIME: 0, BE: 0 };

  for (const t of trades) {
    if (t.netPct > EPS) {
      wins++;
      gains += t.netPct;
    } else if (t.netPct < -EPS) {
      losses++;
      lossSum -= t.netPct;
    }
    grossSum += t.grossPct;
    netSum += t.netPct;
    cum += t.netPct;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
  }

  return {
    count,
    wins,
    losses,
    ties: count - wins - losses,
    winRatePct: count ? (wins / count) * 100 : null,
    wilsonLower95Pct: count ? wilsonLowerBound(wins, count, 1.96) : null,
    meanNetPct: count ? netSum / count : null,
    meanGrossPct: count ? grossSum / count : null,
    totalNetPct: netSum,
    maxDrawdownPct,
    profitFactor: lossSum > 0 ? gains / lossSum : null,
    exitReasons,
  };
}

function rankCandidatesOnCalVal(datasetPrefix, calEnd, valEnd) {
  const catalog = buildCandidateCatalog1h(datasetPrefix);
  const q1End = Math.floor(calEnd / 2); // 4380 (3 equal 6-month regimes inside Cal+Val)
  const rankings = [];

  for (let order = 0; order < catalog.length; order++) {
    const cand = catalog[order];
    const q1 = summarizeMetrics(simulateTrades(datasetPrefix.rows, cand.signals, {
      ...cand.execOptions,
      start: 0,
      end: q1End,
      intervalSeconds: datasetPrefix.intervalSeconds,
    }));
    const q2 = summarizeMetrics(simulateTrades(datasetPrefix.rows, cand.signals, {
      ...cand.execOptions,
      start: q1End,
      end: calEnd,
      intervalSeconds: datasetPrefix.intervalSeconds,
    }));
    const cal = summarizeMetrics(simulateTrades(datasetPrefix.rows, cand.signals, {
      ...cand.execOptions,
      start: 0,
      end: calEnd,
      intervalSeconds: datasetPrefix.intervalSeconds,
    }));
    const val = summarizeMetrics(simulateTrades(datasetPrefix.rows, cand.signals, {
      ...cand.execOptions,
      start: calEnd,
      end: valEnd,
      intervalSeconds: datasetPrefix.intervalSeconds,
    }));
    const calVal = summarizeMetrics(simulateTrades(datasetPrefix.rows, cand.signals, {
      ...cand.execOptions,
      start: 0,
      end: valEnd,
      intervalSeconds: datasetPrefix.intervalSeconds,
    }));

    const sub6 = [];
    const subLen = Math.floor(valEnd / 6);
    for (let k = 0; k < 6; k++) {
      const sStart = k * subLen;
      const sEnd = k === 5 ? valEnd : (k + 1) * subLen;
      sub6.push(summarizeMetrics(simulateTrades(datasetPrefix.rows, cand.signals, {
        ...cand.execOptions,
        start: sStart,
        end: sEnd,
        intervalSeconds: datasetPrefix.intervalSeconds,
      })));
    }
    const minSub6Count = Math.min(...sub6.map(s => s.count));
    const minSub6Wr = Math.min(...sub6.map(s => s.winRatePct ?? 0));
    const minSub6Pf = Math.min(...sub6.map(s => s.profitFactor ?? 0));

    const pooledCount = cal.count + val.count;
    const pooledWins = cal.wins + val.wins;
    const pooledNetSum = cal.totalNetPct + val.totalNetPct;
    const pooledMeanNetPct = pooledCount > 0 ? pooledNetSum / pooledCount : -Infinity;
    const pooledWinRatePct = pooledCount > 0 ? (pooledWins / pooledCount) * 100 : 0;
    const pooledWilson95Pct = pooledCount > 0 ? wilsonLowerBound(pooledWins, pooledCount, 1.96) : 0;
    const minSubPf = Math.min(q1.profitFactor ?? 0, q2.profitFactor ?? 0, val.profitFactor ?? 0);
    const minSubWr = Math.min(q1.winRatePct ?? 0, q2.winRatePct ?? 0, val.winRatePct ?? 0);
    const minSubCount = Math.min(q1.count, q2.count, val.count);

    const failureReasons = [];
    if (minSubCount < 24) failureReasons.push('SUBPERIOD_COUNT_BELOW_24');
    if (minSub6Count < 9) failureReasons.push('SUB3M_COUNT_BELOW_9');
    if (cal.count < 50 || val.count < 28) failureReasons.push('CAL_VAL_COUNT_INSUFFICIENT');
    if (minSubWr < 65.0 || minSub6Wr < 60.0 || (cal.winRatePct ?? 0) < 65.0 || (val.winRatePct ?? 0) < 65.0) {
      failureReasons.push('WR_BELOW_TARGET');
    }
    if (minSubPf < 1.20 || minSub6Pf < 1.00 || (cal.profitFactor ?? 0) < 1.20 || (val.profitFactor ?? 0) < 1.20) {
      failureReasons.push('PF_BELOW_TARGET');
    }
    if ((cal.meanNetPct ?? -Infinity) <= 0 || (val.meanNetPct ?? -Infinity) <= 0) {
      failureReasons.push('NET_NONPOSITIVE');
    }

    const eligible = failureReasons.length === 0;
    // Rank strictly on Cal+Val using Wilson 95% lower bound + balanced Profit Factor & Expectancy + worst-subperiod PF stability across 6m and 3m windows.
    const rankScore = pooledWilson95Pct +
      15 * ((calVal.profitFactor ?? 0) - 1) +
      40 * pooledMeanNetPct +
      10 * Math.min(minSubPf, 2.0) +
      10 * Math.min(minSub6Pf, 2.0);

    rankings.push({
      id: cand.id,
      order,
      signalSpec: cand.signalSpec,
      execOptions: cand.execOptions,
      eligible,
      failureReasons,
      pooledCount,
      pooledWins,
      pooledWinRatePct,
      pooledWilson95Pct,
      pooledMeanNetPct,
      minSubPf,
      minSubWr,
      minSubCount,
      minSub6Pf,
      minSub6Wr,
      minSub6Count,
      rankScore,
      q1,
      q2,
      cal,
      val,
    });
  }

  rankings.sort((a, b) =>
    Number(b.eligible) - Number(a.eligible) ||
    b.rankScore - a.rankScore ||
    b.pooledWilson95Pct - a.pooledWilson95Pct ||
    b.pooledMeanNetPct - a.pooledMeanNetPct ||
    a.order - b.order,
  );

  return rankings;
}

function selectFoldCandidate(datasetPrefix, foldEnd) {
  const catalog = buildCandidateCatalog1h(datasetPrefix);
  const minCount = Math.max(18, Math.floor(foldEnd / 280));
  const numSlices = Math.max(2, Math.floor(foldEnd / 2190));
  const sliceLen = Math.floor(foldEnd / numSlices);
  const minSliceCount = Math.max(8, Math.floor(sliceLen / 260));
  const rankings = [];

  for (let order = 0; order < catalog.length; order++) {
    const cand = catalog[order];
    const sim = summarizeMetrics(simulateTrades(datasetPrefix.rows, cand.signals, {
      ...cand.execOptions,
      start: 0,
      end: foldEnd,
      intervalSeconds: datasetPrefix.intervalSeconds,
    }));
    const slices = [];
    for (let k = 0; k < numSlices; k++) {
      const sStart = k * sliceLen;
      const sEnd = k === numSlices - 1 ? foldEnd : (k + 1) * sliceLen;
      slices.push(summarizeMetrics(simulateTrades(datasetPrefix.rows, cand.signals, {
        ...cand.execOptions,
        start: sStart,
        end: sEnd,
        intervalSeconds: datasetPrefix.intervalSeconds,
      })));
    }

    const minSlicePf = Math.min(...slices.map(s => s.profitFactor ?? 0));
    const minSliceWr = Math.min(...slices.map(s => s.winRatePct ?? 0));
    const minSliceCnt = Math.min(...slices.map(s => s.count));
    const eligible = sim.count >= minCount &&
      minSliceCnt >= minSliceCount &&
      (sim.winRatePct ?? 0) >= 65.0 &&
      minSliceWr >= 62.0 &&
      (sim.meanNetPct ?? -Infinity) > 0 &&
      (sim.profitFactor ?? 0) >= 1.20 &&
      minSlicePf >= 1.00;
    const rankScore = (sim.wilsonLower95Pct ?? 0) +
      15 * ((sim.profitFactor ?? 0) - 1) +
      40 * (sim.meanNetPct ?? -10) +
      10 * Math.min(minSlicePf, 2.0);

    rankings.push({ cand, sim, eligible, rankScore, order });
  }

  rankings.sort((a, b) =>
    Number(b.eligible) - Number(a.eligible) ||
    b.rankScore - a.rankScore ||
    a.order - b.order,
  );
  return rankings[0];
}

function runAnchoredWalkForward(dataset24m) {
  // 4 chronological OOS folds covering bars 4380..17520 (18 months, 3285 bars per fold)
  const foldsDef = [
    { fold: 1, trainEnd: 4380, testStart: 4380, testEnd: 7665 },
    { fold: 2, trainEnd: 7665, testStart: 7665, testEnd: 10950 },
    { fold: 3, trainEnd: 10950, testStart: 10950, testEnd: 14235 },
    { fold: 4, trainEnd: 14235, testStart: 14235, testEnd: 17520 },
  ];

  const foldResults = [];
  const oosTrades = [];

  for (const def of foldsDef) {
    const prefix = sliceDatasetPrefix1h(dataset24m, def.trainEnd);
    const winner = selectFoldCandidate(prefix, def.trainEnd);
    const fullSignals = generateSignals1h(dataset24m, winner.cand.signalSpec);
    const testSim = simulateTrades(dataset24m.rows, fullSignals, {
      ...winner.cand.execOptions,
      start: def.testStart,
      end: def.testEnd,
      intervalSeconds: dataset24m.intervalSeconds,
    });
    oosTrades.push(...testSim.trades);
    foldResults.push({
      fold: def.fold,
      trainRange: [0, def.trainEnd],
      testRange: [def.testStart, def.testEnd],
      selectedId: winner.cand.id,
      trainEligible: winner.eligible,
      trainMetrics: winner.sim,
      testMetrics: summarizeMetrics(testSim),
    });
  }

  return {
    folds: foldResults,
    aggregate: summarizeTradeList(oosTrades),
  };
}

function runFixedQuarterSlices(dataset24m, chosenSpec, execOptions) {
  const fullSignals = generateSignals1h(dataset24m, chosenSpec);
  const slices = [
    { quarter: 'Q1', start: 0, end: 4380 },
    { quarter: 'Q2', start: 4380, end: 8760 },
    { quarter: 'Q3', start: 8760, end: 13140 },
    { quarter: 'Q4_Holdout', start: 13140, end: 17520 },
  ];
  const quarterResults = [];
  const allTrades = [];
  for (const s of slices) {
    const sim = simulateTrades(dataset24m.rows, fullSignals, {
      ...execOptions,
      start: s.start,
      end: s.end,
      intervalSeconds: dataset24m.intervalSeconds,
    });
    allTrades.push(...sim.trades);
    quarterResults.push({
      quarter: s.quarter,
      range: [s.start, s.end],
      metrics: summarizeMetrics(sim),
    });
  }
  return {
    quarters: quarterResults,
    aggregate: summarizeTradeList(allTrades),
  };
}

function writeCsv(filePath, trades, rows) {
  const cols = [
    'signalIndex', 'entryIndex', 'exitIndex', 'signalIso', 'entryIso', 'exitIso',
    'side', 'entry', 'stop', 'target', 'exit', 'exitReason', 'barsHeld', 'grossPct', 'netPct',
  ];
  const lines = [cols.join(',')];
  for (const t of trades) {
    const row = {
      ...t,
      signalIso: new Date(rows[t.signalIndex].time * 1000).toISOString(),
      entryIso: new Date(rows[t.entryIndex].time * 1000).toISOString(),
      exitIso: new Date(rows[t.exitIndex].time * 1000).toISOString(),
    };
    lines.push(cols.map(k => row[k]).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

function main() {
  const roundId = process.argv[2] ?? 'r1';
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const path24m = path.join(ROOT, 'data', 'btcusdt_1h_24m.json');
  const pathTv6k = path.join(ROOT, 'data', 'btcusdt_tv_1h_6k.json');
  const pathEth = path.join(ROOT, 'data', 'ethusdt_1h_12m.json');

  const dataset24m = JSON.parse(fs.readFileSync(path24m, 'utf8'));
  const datasetTv6k = JSON.parse(fs.readFileSync(pathTv6k, 'utf8'));
  const datasetEth = JSON.parse(fs.readFileSync(pathEth, 'utf8'));

  const n = dataset24m.rows.length;
  const calEnd = Math.floor(n * 0.5);
  const valEnd = Math.floor(n * 0.75);

  // STEP 1: Strictly truncate to prefix [0..valEnd) BEFORE any ranking or selection.
  const prefix24m = sliceDatasetPrefix1h(dataset24m, valEnd);
  const calValRankings = rankCandidatesOnCalVal(prefix24m, calEnd, valEnd);
  const winner = calValRankings[0];
  assert.ok(winner && winner.eligible, 'No eligible candidate found on Cal+Val!');

  const lockedAt = new Date().toISOString();
  const selectionLock = {
    schema: 'smc-v3-1h-selection-lock-v1',
    roundId,
    lockedAt,
    dataset: {
      file: 'data/btcusdt_1h_24m.json',
      sha256: sha256File(path24m),
      rows: n,
      calEnd,
      valEnd,
      holdoutRange: [valEnd, n],
    },
    sources: {
      'research/signals_1h.mjs': sha256File(path.join(HERE, 'signals_1h.mjs')),
      'research/search_1h.mjs': sha256File(path.join(HERE, 'search_1h.mjs')),
      'research/sim_engine.mjs': sha256File(path.join(HERE, 'sim_engine.mjs')),
    },
    rankingRule: 'Filter cal.count>=50, val.count>=28, minSub6mCount>=24, minSub3mCount>=9, cal/val/6m WR>=65%, 3m WR>=60%, cal/val/6m PF>=1.20, 3m PF>=1.00, meanNet>0; rank by pooledWilson95 + 15*(calVal.profitFactor-1) + 40*pooledMeanNetPct + 10*min(minSubPf,2) + 10*min(minSub6Pf,2)',
    totalCandidates: calValRankings.length,
    eligibleCount: calValRankings.filter(r => r.eligible).length,
    lockedWinner: {
      id: winner.id,
      signalSpec: winner.signalSpec,
      execOptions: winner.execOptions,
      cal: winner.cal,
      val: winner.val,
      pooledWinRatePct: winner.pooledWinRatePct,
      pooledWilson95Pct: winner.pooledWilson95Pct,
      pooledMeanNetPct: winner.pooledMeanNetPct,
      rankScore: winner.rankScore,
    },
    top15CalVal: calValRankings.slice(0, 15).map(r => ({
      id: r.id,
      eligible: r.eligible,
      pooledCount: r.pooledCount,
      pooledWinRatePct: r.pooledWinRatePct,
      pooledWilson95Pct: r.pooledWilson95Pct,
      pooledMeanNetPct: r.pooledMeanNetPct,
      cal: { count: r.cal.count, wr: r.cal.winRatePct, pf: r.cal.profitFactor, net: r.cal.meanNetPct },
      val: { count: r.val.count, wr: r.val.winRatePct, pf: r.val.profitFactor, net: r.val.meanNetPct },
    })),
  };

  // STEP 2: Persist selection-lock.json BEFORE evaluating Holdout!
  const lockPath = path.join(RESULTS_DIR, 'selection-lock.json');
  const lockText = JSON.stringify(selectionLock, null, 2) + '\n';
  fs.writeFileSync(lockPath, lockText);
  const selectionLockSha256 = sha256Text(lockText);

  // STEP 3: Now score Untouched Holdout, TV 6k, 4-Fold Walk-Forward, and ETHUSDT 1h!
  const holdoutScoringStartedAt = new Date().toISOString();
  const { signalSpec, execOptions } = selectionLock.lockedWinner;

  const prefixSignals = generateSignals1h(prefix24m, signalSpec);
  const full24mSignals = generateSignals1h(dataset24m, signalSpec);
  assert.deepEqual(
    full24mSignals.filter(s => s.barIndex < valEnd),
    prefixSignals,
    'Causality breach: appending holdout rows changed Cal+Val signals',
  );

  const holdoutSim = simulateTrades(dataset24m.rows, full24mSignals, {
    ...execOptions,
    start: valEnd,
    end: n,
    intervalSeconds: dataset24m.intervalSeconds,
  });
  const holdoutMetrics = summarizeMetrics(holdoutSim);

  const full24mSim = simulateTrades(dataset24m.rows, full24mSignals, {
    ...execOptions,
    start: 0,
    end: n,
    intervalSeconds: dataset24m.intervalSeconds,
  });

  const tv6kSignals = generateSignals1h(datasetTv6k, signalSpec);
  const tv6kSim = simulateTrades(datasetTv6k.rows, tv6kSignals, {
    ...execOptions,
    start: 0,
    end: datasetTv6k.rows.length,
    intervalSeconds: datasetTv6k.intervalSeconds,
  });
  const tv6kMetrics = summarizeMetrics(tv6kSim);

  const anchoredWf = runAnchoredWalkForward(dataset24m);
  const fixedQuarterWf = runFixedQuarterSlices(dataset24m, signalSpec, execOptions);

  const ethSignals = generateSignals1h(datasetEth, signalSpec);
  const ethSim = simulateTrades(datasetEth.rows, ethSignals, {
    ...execOptions,
    start: 0,
    end: datasetEth.rows.length,
    intervalSeconds: datasetEth.intervalSeconds,
  });
  const ethMetrics = summarizeMetrics(ethSim);

  // Sensitivity checks on Holdout & TV6k (for diagnostics only: beTriggerR=0.65, double cost, limitSameBarTp='never')
  const holdoutNoSameBarTp = summarizeMetrics(simulateTrades(dataset24m.rows, full24mSignals, {
    ...execOptions,
    limitSameBarTp: 'never',
    start: valEnd,
    end: n,
    intervalSeconds: dataset24m.intervalSeconds,
  }));
  const holdoutWithBe = summarizeMetrics(simulateTrades(dataset24m.rows, full24mSignals, {
    ...execOptions,
    beTriggerR: 0.65,
    beOffsetPct: 0.20,
    start: valEnd,
    end: n,
    intervalSeconds: dataset24m.intervalSeconds,
  }));

  const gates = {
    holdoutPass:
      (holdoutMetrics.winRatePct ?? 0) >= 65.0 &&
      holdoutMetrics.count >= 30 &&
      (holdoutMetrics.meanNetPct ?? -Infinity) > 0 &&
      (holdoutMetrics.profitFactor ?? 0) >= 1.20,
    tv6kPass:
      (tv6kMetrics.winRatePct ?? 0) >= 65.0 &&
      tv6kMetrics.count >= 40 &&
      (tv6kMetrics.meanNetPct ?? -Infinity) > 0 &&
      (tv6kMetrics.profitFactor ?? 0) >= 1.20,
    walkForwardAnchoredPass:
      (anchoredWf.aggregate.winRatePct ?? 0) >= 65.0 &&
      (anchoredWf.aggregate.meanNetPct ?? -Infinity) > 0,
    walkForwardFixedQuarterPass:
      (fixedQuarterWf.aggregate.winRatePct ?? 0) >= 65.0 &&
      (fixedQuarterWf.aggregate.meanNetPct ?? -Infinity) > 0,
  };
  const allGatesPassed = Object.values(gates).every(Boolean);

  const report = {
    schema: 'smc-v3-1h-results-v1',
    roundId,
    lockedAt,
    holdoutScoringStartedAt,
    selectionLockSha256,
    allGatesPassed,
    gates,
    lockedWinner: selectionLock.lockedWinner,
    splits24m: {
      calibration: winner.cal,
      validation: winner.val,
      holdout: holdoutMetrics,
      full24m: summarizeMetrics(full24mSim),
    },
    tv6k: {
      file: 'data/btcusdt_tv_1h_6k.json',
      sha256: sha256File(pathTv6k),
      metrics: tv6kMetrics,
    },
    walkForwardAnchored4Fold: anchoredWf,
    walkForwardFixed4Quarter: fixedQuarterWf,
    ethusdt1h12m: {
      file: 'data/ethusdt_1h_12m.json',
      sha256: sha256File(pathEth),
      metrics: ethMetrics,
    },
    diagnostics: {
      holdoutNoSameBarTp,
      holdoutWithBe065: holdoutWithBe,
    },
  };

  fs.writeFileSync(path.join(RESULTS_DIR, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  writeCsv(path.join(RESULTS_DIR, 'holdout_trades.csv'), holdoutSim.trades, dataset24m.rows);
  writeCsv(path.join(RESULTS_DIR, 'tv6k_trades.csv'), tv6kSim.trades, datasetTv6k.rows);

  const logPath = path.join(RESULTS_DIR, 'experiment_log.json');
  const existingLog = fs.existsSync(logPath)
    ? JSON.parse(fs.readFileSync(logPath, 'utf8'))
    : { rounds: [] };
  existingLog.rounds.push({
    roundId,
    lockedAt,
    holdoutScoringStartedAt,
    selectionLockSha256,
    winnerId: winner.id,
    allGatesPassed,
    gates,
    holdout: holdoutMetrics,
    tv6k: tv6kMetrics,
    walkForwardAnchoredAggregate: anchoredWf.aggregate,
    walkForwardFixedQuarterAggregate: fixedQuarterWf.aggregate,
    ethusdt1h12m: ethMetrics,
  });
  fs.writeFileSync(logPath, JSON.stringify(existingLog, null, 2) + '\n');

  console.log(JSON.stringify({
    roundId,
    winnerId: winner.id,
    selectionLockSha256,
    allGatesPassed,
    gates,
    cal: { n: winner.cal.count, wr: winner.cal.winRatePct, pf: winner.cal.profitFactor, net: winner.cal.meanNetPct },
    val: { n: winner.val.count, wr: winner.val.winRatePct, pf: winner.val.profitFactor, net: winner.val.meanNetPct },
    holdout: holdoutMetrics,
    tv6k: tv6kMetrics,
    wfAnchoredAgg: anchoredWf.aggregate,
    wfFixedQuarterAgg: fixedQuarterWf.aggregate,
    eth1h: ethMetrics,
  }, null, 2));
}

main();
