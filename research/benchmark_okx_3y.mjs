import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTrades, wilsonLowerBound } from './sim_engine.mjs';
import {
  DEFAULT_15M_PARAMS,
  DEFAULT_15M_SIM_OPTIONS,
  generate15mSignals,
} from './signals_15m.mjs';
import { generateSignals1h } from './signals_1h.mjs';
import { verifyDatasetParity } from '../tests/pine_parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results_okx');
const EPS = 1e-12;

function load1hLockedConfig() {
  const lockPath = path.join(HERE, 'results_1h', 'selection-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const signalSpec = lock.lockedWinner?.signalSpec;
  const execOptions = lock.lockedWinner?.execOptions;
  assert.ok(signalSpec && execOptions, 'Missing lockedWinner spec/execOptions in results_1h/selection-lock.json');
  return { lockRoundId: lock.roundId, specId: lock.lockedWinner.id, signalSpec, execOptions };
}

function summarizeSim(sim, rows, startIdx = 0, endIdx = rows.length) {
  let buyCount = 0;
  let buyWins = 0;
  let sellCount = 0;
  let sellWins = 0;
  let buyNetPct = 0;
  let sellNetPct = 0;
  for (const t of sim.trades) {
    if (t.side === 1) {
      buyCount++;
      buyNetPct += t.netPct;
      if (t.netPct > EPS) buyWins++;
    } else if (t.side === -1) {
      sellCount++;
      sellNetPct += t.netPct;
      if (t.netPct > EPS) sellWins++;
    }
  }
  const winRatePct = sim.winRatePct ?? 0;
  const profitFactor = sim.profitFactor;
  const meanNetPct = sim.meanNetPct ?? 0;
  const gatePass = sim.count > 0 && winRatePct >= 65 && profitFactor !== null && profitFactor > 1 && meanNetPct > 0;

  return {
    range: [startIdx, endIdx],
    bars: endIdx - startIdx,
    firstIso: new Date(rows[startIdx].time * 1000).toISOString(),
    lastIso: new Date(rows[endIdx - 1].time * 1000).toISOString(),
    count: sim.count,
    wins: sim.wins,
    losses: sim.losses,
    ties: sim.ties,
    winRatePct: Number(winRatePct.toFixed(4)),
    wilsonLower95Pct: Number((sim.wilsonLower95Pct ?? 0).toFixed(4)),
    profitFactor: profitFactor !== null ? Number(profitFactor.toFixed(4)) : null,
    totalNetPct: Number(sim.totalNetPct.toFixed(4)),
    meanNetPct: Number(meanNetPct.toFixed(4)),
    meanGrossPct: Number((sim.meanGrossPct ?? 0).toFixed(4)),
    maxDrawdownPct: Number(sim.maxDrawdownPct.toFixed(4)),
    exitReasons: sim.exitReasons,
    ignoredSignals: sim.ignoredSignals,
    expiredOrders: sim.expiredOrders,
    purgedTrades: sim.purgedTrades,
    buy: {
      count: buyCount,
      wins: buyWins,
      winRatePct: buyCount ? Number(((buyWins / buyCount) * 100).toFixed(4)) : null,
      wilsonLower95Pct: buyCount ? Number(wilsonLowerBound(buyWins, buyCount, 1.96).toFixed(4)) : null,
      totalNetPct: Number(buyNetPct.toFixed(4)),
    },
    sell: {
      count: sellCount,
      wins: sellWins,
      winRatePct: sellCount ? Number(((sellWins / sellCount) * 100).toFixed(4)) : null,
      wilsonLower95Pct: sellCount ? Number(wilsonLowerBound(sellWins, sellCount, 1.96).toFixed(4)) : null,
      totalNetPct: Number(sellNetPct.toFixed(4)),
    },
    gatePass65: gatePass,
  };
}

function evaluatePartitionSlices(rows, signals, simOpts, numSlices, labelPrefix) {
  const n = rows.length;
  const step = Math.floor(n / numSlices);
  const slices = [];
  for (let s = 0; s < numSlices; s++) {
    const start = s * step;
    const end = s === numSlices - 1 ? n : (s + 1) * step;
    const sim = simulateTrades(rows, signals, { ...simOpts, start, end });
    slices.push({
      label: `${labelPrefix} ${s + 1}`,
      ...summarizeSim(sim, rows, start, end),
    });
  }
  return slices;
}

function benchmarkDataset(relPath, locked1h, { checkParity = false, isFull3y = false } = {}) {
  const fullPath = path.join(ROOT_DIR, relPath);
  const dataset = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const rows = dataset.rows;
  const is15m = dataset.intervalSeconds <= 900;

  const signals = is15m
    ? generate15mSignals(dataset, DEFAULT_15M_PARAMS)
    : generateSignals1h(dataset, locked1h.signalSpec);

  const baseSimOpts = is15m
    ? { ...DEFAULT_15M_SIM_OPTIONS, intervalSeconds: dataset.intervalSeconds }
    : { ...locked1h.execOptions, intervalSeconds: dataset.intervalSeconds };

  // Primary benchmark: strict cost benchmark (0.10% fee + 0.025% slippage per fill)
  const primarySim = simulateTrades(rows, signals, baseSimOpts);
  const primary = summarizeSim(primarySim, rows, 0, rows.length);

  // Informational OKX blend fee sensitivity (0.05% fee + 0.025% slippage per fill)
  const okxFeeSim = simulateTrades(rows, signals, { ...baseSimOpts, costPct: 0.05 });
  const okxBlendFee005 = summarizeSim(okxFeeSim, rows, 0, rows.length);

  // No-BE ablation (raw directional payoff without BE+ ratchet)
  const noBeSim = simulateTrades(rows, signals, { ...baseSimOpts, beTriggerR: 0 });
  const noBeAblation = summarizeSim(noBeSim, rows, 0, rows.length);

  let pineParity = { checked: false, status: 'SKIPPED_FULL_15M_RUNTIME_GUARD' };
  if (checkParity) {
    const parityReport = verifyDatasetParity(relPath);
    assert.equal(parityReport.trades, primary.count, `${relPath}: parity trade count mismatch`);
    assert.equal(parityReport.wins, primary.wins, `${relPath}: parity wins mismatch`);
    assert.equal(parityReport.losses, primary.losses, `${relPath}: parity losses mismatch`);
    assert.equal(parityReport.ties, primary.ties, `${relPath}: parity ties mismatch`);
    pineParity = {
      checked: true,
      status: parityReport.parity,
      signals: parityReport.signals,
      trades: parityReport.trades,
      wins: parityReport.wins,
      losses: parityReport.losses,
    };
  }

  const out = {
    dataset: relPath,
    symbol: dataset.symbol,
    interval: dataset.interval,
    bars: rows.length,
    signals: signals.length,
    firstIso: primary.firstIso,
    lastIso: primary.lastIso,
    simOptions: baseSimOpts,
    primary,
    okxBlendFee005Informational: okxBlendFee005,
    noBeAblation,
    pineParity,
  };

  if (isFull3y) {
    out.yearlyBreakdown = evaluatePartitionSlices(rows, signals, baseSimOpts, 3, 'Year');
    out.semiAnnualBreakdown = evaluatePartitionSlices(rows, signals, baseSimOpts, 6, 'H');
  }

  return out;
}

export function runOkx3yBenchmark() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const locked1h = load1hLockedConfig();

  const specs = [
    { relPath: 'data/okx_btcusdt_15m_3y.json', checkParity: false, isFull3y: true },
    { relPath: 'data/okx_btcusdt_1h_3y.json', checkParity: true, isFull3y: true },
    { relPath: 'data/okx_btcusdt_swap_15m_3y.json', checkParity: false, isFull3y: true },
    { relPath: 'data/okx_btcusdt_swap_1h_3y.json', checkParity: true, isFull3y: true },
    { relPath: 'data/okx_btcusdt_tv_15m_6k.json', checkParity: true, isFull3y: false },
    { relPath: 'data/okx_btcusdt_tv_1h_6k.json', checkParity: true, isFull3y: false },
    { relPath: 'data/okx_btcusdt_swap_tv_15m_6k.json', checkParity: true, isFull3y: false },
    { relPath: 'data/okx_btcusdt_swap_tv_1h_6k.json', checkParity: true, isFull3y: false },
  ];

  const results = [];
  for (const s of specs) {
    console.log(`[benchmark] Running ${s.relPath} (parityCheck=${s.checkParity})...`);
    const res = benchmarkDataset(s.relPath, locked1h, s);
    results.push(res);
    const p = res.primary;
    console.log(
      `  -> trades=${p.count} W/L/T=${p.wins}/${p.losses}/${p.ties} WR=${p.winRatePct}% ` +
      `Wilson95=${p.wilsonLower95Pct}% PF=${p.profitFactor} Net=${p.totalNetPct}% ` +
      `MaxDD=${p.maxDrawdownPct}% gate65=${p.gatePass65} parity=${res.pineParity.status}`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    strategyVersion: 'SMC Confirmed [3.0.0]',
    goal: 'Net closed-trade Win Rate >= 65% over 3 years on OKX (15m & 1h), 0.10% fee + 0.025% slippage per fill',
    configs: {
      '15m': { params: DEFAULT_15M_PARAMS, simOptions: DEFAULT_15M_SIM_OPTIONS },
      '1h': { roundId: locked1h.lockRoundId, specId: locked1h.specId, execOptions: locked1h.execOptions },
    },
    results,
  };

  const outPath = path.join(RESULTS_DIR, 'benchmark_3y.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`[benchmark_okx_3y] Saved full report to ${outPath}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOkx3yBenchmark();
}
