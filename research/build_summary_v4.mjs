import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTrades } from './sim_engine.mjs';
import {
  DEFAULT_15M_PARAMS,
  DEFAULT_15M_SIM_OPTIONS,
  generate15mSignals,
} from './signals_15m.mjs';
import { generateSignals1h } from './signals_1h.mjs';
import { generateSignals15mV4, precompute15mV4 } from './signals_15m_v4.mjs';
import { generateSignals1hV4, precompute1hV4 } from './signals_1h_v4.mjs';
import { summarizeTradesSlice } from './search_15m_v4_r3.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const RESULTS_V4_DIR = path.join(HERE, 'results_v4');
const EPS = 1e-12;

function calcCompoundedMetrics(trades, startIdx, endIdx) {
  let eq = 1.0;
  let peak = 1.0;
  let maxDd = 0;
  for (const t of trades) {
    if (t.signalIndex < startIdx || t.exitIndex >= endIdx) continue;
    eq *= (1 + t.netPct / 100);
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    compoundedNetPct: Number(((eq - 1) * 100).toFixed(4)),
    compoundedMaxDrawdownPct: Number(maxDd.toFixed(4)),
  };
}

function summarizeSliceEnriched(trades, rows, startIdx, endIdx, extra = {}) {
  const base = summarizeTradesSlice(trades, rows, startIdx, endIdx);
  const comp = calcCompoundedMetrics(trades, startIdx, endIdx);
  return { ...extra, ...base, compoundedMaxDrawdownPct: comp.compoundedMaxDrawdownPct };
}

function computeInformationalPerp2x(trades, startIdx = 0, endIdx = Infinity) {
  let sum2x = 0;
  let peakAdd = 0;
  let maxAddDd = 0;
  let eq = 1.0;
  let peakEq = 1.0;
  let maxCompDd = 0;
  let minEq = 1.0;
  let worstTrade2xPct = Infinity;
  let count = 0;

  for (const t of trades) {
    if (t.signalIndex < startIdx || t.exitIndex >= endIdx) continue;
    count++;
    const r2 = 2 * t.netPct;
    if (r2 < worstTrade2xPct) worstTrade2xPct = r2;
    sum2x += r2;
    if (sum2x > peakAdd) peakAdd = sum2x;
    const addDd = peakAdd - sum2x;
    if (addDd > maxAddDd) maxAddDd = addDd;

    const factor = 1 + r2 / 100;
    eq = factor <= 0 ? 0 : eq * factor;
    if (eq < minEq) minEq = eq;
    if (eq > peakEq) peakEq = eq;
    const compDd = peakEq > 0 ? ((peakEq - eq) / peakEq) * 100 : 100;
    if (compDd > maxCompDd) maxCompDd = compDd;
  }

  return {
    leverageNote: 'Informational 2x Perp reference computed from strict 0.10% cost + 0.025%/fill slippage 1h trades (default_qty_value=200 equivalent).',
    tradeCount: count,
    additive2xNetPct: Number(sum2x.toFixed(4)),
    additive2xMaxDdPct: Number(maxAddDd.toFixed(4)),
    compounded2xNetPct: Number(((eq - 1) * 100).toFixed(4)),
    compounded2xMaxDdPct: Number(maxCompDd.toFixed(4)),
    worstTrade2xPct: count > 0 ? Number(worstTrade2xPct.toFixed(4)) : 0,
    minEquityMultiple2x: Number(minEq.toFixed(4)),
    liquidated2x: minEq <= EPS || worstTrade2xPct <= -100,
  };
}

function evaluateCandidateOnDatasets(candidate, datasets, datasetOrder, is1hTrack) {
  const out = {};
  for (const dsKey of datasetOrder) {
    const ds = datasets.get(dsKey);
    const rows = ds.rows;
    const n = rows.length;
    const signals = candidate.generateSignals(ds);
    const simOpts = { ...candidate.execOptions, intervalSeconds: ds.intervalSeconds };

    const fullSim = simulateTrades(rows, signals, simOpts);
    const noBeSim = simulateTrades(rows, signals, {
      ...simOpts,
      beTriggerR: 0,
      lock2TriggerR: 0,
      trailTriggerR: 0,
    });

    const is3y = (is1hTrack && n >= 26000) || (!is1hTrack && n >= 100000);
    const entry = {
      dataset: ds.relPath,
      symbol: ds.symbol,
      interval: ds.interval,
      bars: n,
      signals: signals.length,
      full: summarizeSliceEnriched(fullSim.trades, rows, 0, n),
      noBe: summarizeSliceEnriched(noBeSim.trades, rows, 0, n),
    };

    if (dsKey === 'okxSpot3y' || dsKey === 'okxSwap3y') {
      const blendSim = simulateTrades(rows, signals, { ...simOpts, costPct: 0.05 });
      entry.okxBlendFee005 = summarizeSliceEnriched(blendSim.trades, rows, 0, n);
    }

    if (is1hTrack && (dsKey === 'okxSwap3y' || dsKey === 'okxSwapTv6k')) {
      entry.informationalPerp2x = computeInformationalPerp2x(fullSim.trades, 0, n);
      if (is3y) {
        entry.informationalPerp2x.yearly = [0, 1, 2].map(y => {
          const st = y * Math.floor(n / 3);
          const en = y === 2 ? n : (y + 1) * Math.floor(n / 3);
          return { year: y + 1, ...computeInformationalPerp2x(fullSim.trades, st, en) };
        });
      }
    }

    if (is3y) {
      entry.yearly = [0, 1, 2].map(y => {
        const st = y * Math.floor(n / 3);
        const en = y === 2 ? n : (y + 1) * Math.floor(n / 3);
        const splitRole = y === 2 ? 'Holdout_Blind' : (y === 0 ? 'Cal_Y1' : 'CalVal_Y2');
        return summarizeSliceEnriched(fullSim.trades, rows, st, en, { year: y + 1, splitRole });
      });
      entry.semiAnnual = [0, 1, 2, 3, 4, 5].map(h => {
        const st = h * Math.floor(n / 6);
        const en = h === 5 ? n : (h + 1) * Math.floor(n / 6);
        return summarizeSliceEnriched(fullSim.trades, rows, st, en, { half: h + 1 });
      });
      const calEnd = Math.floor(n * 0.5);
      const valEnd = Math.floor(n * (2 / 3));
      entry.chronologicalSplits = {
        cal: summarizeSliceEnriched(fullSim.trades, rows, 0, calEnd, { split: 'Cal_18m' }),
        val: summarizeSliceEnriched(fullSim.trades, rows, calEnd, valEnd, { split: 'Val_6m' }),
        calVal: summarizeSliceEnriched(fullSim.trades, rows, 0, valEnd, { split: 'CalVal_24m' }),
        holdout: summarizeSliceEnriched(fullSim.trades, rows, valEnd, n, { split: 'Holdout_Y3_12m' }),
      };
    }

    out[dsKey] = entry;
  }
  return out;
}

export function buildSummaryV4() {
  const verifPath = path.join(RESULTS_V4_DIR, 'verification_report.json');
  assert.ok(fs.existsSync(verifPath), 'Run research/verify_v4_candidates.mjs first');
  const verifReport = JSON.parse(fs.readFileSync(verifPath, 'utf8'));
  assert.equal(verifReport.overallStatus, 'ALL_PASSED', 'Verification report must be ALL_PASSED');

  const dsSpecs15m = [
    ['okxSpot3y', 'data/okx_btcusdt_15m_3y.json'],
    ['okxSwap3y', 'data/okx_btcusdt_swap_15m_3y.json'],
    ['okxSpotTv6k', 'data/okx_btcusdt_tv_15m_6k.json'],
    ['okxSwapTv6k', 'data/okx_btcusdt_swap_tv_15m_6k.json'],
    ['binanceBtc12m', 'data/btcusdt_15m_12m.json'],
    ['binanceBtcTv6k', 'data/btcusdt_tv_15m_6k.json'],
    ['binanceEth6m', 'data/ethusdt_15m_6m.json'],
  ];
  const dsSpecs1h = [
    ['okxSpot3y', 'data/okx_btcusdt_1h_3y.json'],
    ['okxSwap3y', 'data/okx_btcusdt_swap_1h_3y.json'],
    ['okxSpotTv6k', 'data/okx_btcusdt_tv_1h_6k.json'],
    ['okxSwapTv6k', 'data/okx_btcusdt_swap_tv_1h_6k.json'],
    ['binanceBtc24m', 'data/btcusdt_1h_24m.json'],
    ['binanceBtcTv6k', 'data/btcusdt_tv_1h_6k.json'],
    ['binanceEth12m', 'data/ethusdt_1h_12m.json'],
  ];

  const loadMap = (specs) => {
    const map = new Map();
    for (const [k, relPath] of specs) {
      const fullPath = path.join(ROOT_DIR, relPath);
      const ds = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      ds.relPath = relPath;
      map.set(k, ds);
    }
    return map;
  };

  const ds15m = loadMap(dsSpecs15m);
  const ds1h = loadMap(dsSpecs1h);

  const pre15mCache = new Map();
  const getPre15m = (ds) => {
    if (!pre15mCache.has(ds.relPath)) pre15mCache.set(ds.relPath, precompute15mV4(ds));
    return pre15mCache.get(ds.relPath);
  };
  const pre1hCache = new Map();
  const getPre1h = (ds) => {
    if (!pre1hCache.has(ds.relPath)) pre1hCache.set(ds.relPath, precompute1hV4(ds));
    return pre1hCache.get(ds.relPath);
  };

  const lock1hV3 = JSON.parse(fs.readFileSync(path.join(HERE, 'results_1h', 'selection-lock.json'), 'utf8'));
  const lock15mV3 = JSON.parse(fs.readFileSync(path.join(HERE, 'results_15m', 'selection-lock.json'), 'utf8'));

  const loadV4Lock = (filename) => JSON.parse(fs.readFileSync(path.join(RESULTS_V4_DIR, filename), 'utf8'));
  const l15_r1r2 = loadV4Lock('lock_15m.json');
  const l15_r3 = loadV4Lock('lock_15m_r3.json');
  const l15_r4 = loadV4Lock('lock_15m_r4.json');
  const l1h_r1r2 = loadV4Lock('lock_1h.json');
  const l1h_r3 = loadV4Lock('lock_1h_r3.json');
  const l1h_r4 = loadV4Lock('lock_1h_r4.json');
  const l1h_r5 = loadV4Lock('lock_1h_r5.json');

  const track15mCandidates = [
    {
      key: 'v3_baseline',
      role: 'Baseline v3.0.0',
      id: lock15mV3.lockedWinner?.id ?? 'v3_15m_locked',
      execOptions: DEFAULT_15M_SIM_OPTIONS,
      signalSpec: DEFAULT_15M_PARAMS,
      generateSignals: (ds) => generate15mSignals(ds, DEFAULT_15M_PARAMS),
    },
    {
      key: '15m_r1r2',
      role: 'v4 High-Total-Return (Trend H4Disp RR3+Trail, Y1-Y2 strong / Y3 negative)',
      id: l15_r1r2.winner.id,
      execOptions: l15_r1r2.winner.execOptions,
      signalSpec: l15_r1r2.winner.sig,
      plateauStats: l15_r1r2.winner.plateauStats ?? null,
      generateSignals: (ds) => generateSignals15mV4(ds, l15_r1r2.winner.fullSpec, getPre15m(ds)),
    },
    {
      key: '15m_r3',
      role: 'v4 Best All-Weather / Spot Finalist (H4Disp 0.85 H4Close RR2, TV-6k & ETH positive)',
      id: l15_r3.winner.id,
      execOptions: l15_r3.winner.execOptions,
      signalSpec: l15_r3.winner.sig,
      plateauStats: l15_r3.winner.plateauStats ?? null,
      generateSignals: (ds) => generateSignals15mV4(ds, l15_r3.winner.fullSpec, getPre15m(ds)),
    },
    {
      key: '15m_r4',
      role: 'v4 Archived LtfConf Candidate (weaker in Holdout Y3 & TV-6k)',
      id: l15_r4.winner.id,
      execOptions: l15_r4.winner.execOptions,
      signalSpec: l15_r4.winner.sig,
      plateauStats: l15_r4.winner.plateauStats ?? null,
      generateSignals: (ds) => generateSignals15mV4(ds, l15_r4.winner.fullSpec, getPre15m(ds)),
    },
  ];

  const track1hCandidates = [
    {
      key: 'v3_baseline',
      role: 'Baseline v3.0.0 (Most balanced Perp/Spot all-3y WR=71.7%-74.2%)',
      id: lock1hV3.lockedWinner.id,
      execOptions: lock1hV3.lockedWinner.execOptions,
      signalSpec: lock1hV3.lockedWinner.signalSpec,
      generateSignals: (ds) => generateSignals1h(ds, lock1hV3.lockedWinner.signalSpec),
    },
    {
      key: '1h_r1r2',
      role: 'v4 High-Profit Trend Finalist (H4Disp RR2.5+L2: +149% Spot 3y / +260% Comp)',
      id: l1h_r1r2.winner.id,
      execOptions: l1h_r1r2.winner.execOptions,
      signalSpec: l1h_r1r2.winner.sig,
      plateauStats: l1h_r1r2.winner.plateauStats ?? null,
      generateSignals: (ds) => generateSignals1hV4(ds, l1h_r1r2.winner.fullSpec, getPre1h(ds)),
    },
    {
      key: '1h_r3',
      role: 'v4 MultiTrap Higher-RR Test (weaker Holdout Y3 & low No-BE PF on Spot)',
      id: l1h_r3.winner.id,
      execOptions: l1h_r3.winner.execOptions,
      signalSpec: l1h_r3.winner.sig,
      plateauStats: l1h_r3.winner.plateauStats ?? null,
      generateSignals: (ds) => generateSignals1hV4(ds, l1h_r3.winner.fullSpec, getPre1h(ds)),
    },
    {
      key: '1h_r4',
      role: 'v4 Tight-BE MultiTrap Spot Winner (+63% Spot 3y, DD 13.4%, Y3 +0.64%, TV-6k +14.6%)',
      id: l1h_r4.winner.id,
      execOptions: l1h_r4.winner.execOptions,
      signalSpec: l1h_r4.winner.sig,
      plateauStats: l1h_r4.winner.plateauStats ?? null,
      generateSignals: (ds) => generateSignals1hV4(ds, l1h_r4.winner.fullSpec, getPre1h(ds)),
    },
    {
      key: '1h_r5',
      role: 'v4 All-Weather Balanced Finalist (+52.5% Spot / +61.6% Perp, all Y1-Y3 & Binance BTC positive)',
      id: l1h_r5.winner.id,
      execOptions: l1h_r5.winner.execOptions,
      signalSpec: l1h_r5.winner.sig,
      plateauStats: l1h_r5.winner.plateauStats ?? null,
      generateSignals: (ds) => generateSignals1hV4(ds, l1h_r5.winner.fullSpec, getPre1h(ds)),
    },
  ];

  const order15m = dsSpecs15m.map(([k]) => k);
  const order1h = dsSpecs1h.map(([k]) => k);

  const track15mResults = {};
  for (const c of track15mCandidates) {
    track15mResults[c.key] = {
      key: c.key,
      role: c.role,
      id: c.id,
      execOptions: c.execOptions,
      signalSpec: c.signalSpec,
      plateauStats: c.plateauStats ?? null,
      datasets: evaluateCandidateOnDatasets(c, ds15m, order15m, false),
    };
  }

  const track1hResults = {};
  for (const c of track1hCandidates) {
    track1hResults[c.key] = {
      key: c.key,
      role: c.role,
      id: c.id,
      execOptions: c.execOptions,
      signalSpec: c.signalSpec,
      plateauStats: c.plateauStats ?? null,
      datasets: evaluateCandidateOnDatasets(c, ds1h, order1h, true),
    };
  }

  const verifByKey = Object.fromEntries(verifReport.results.map(r => [r.key, r]));

  const summary = {
    schema: 'smc-v4-summary-v1',
    generatedAt: new Date().toISOString(),
    methodology: {
      chronologicalSplit: 'Cal = first 50% (18m: 2023-11-22..2025-05-23), Val = next 16.7% (6m: 2025-05-23..2025-11-21), Blind Holdout = Year 3 (12m: 2025-11-21..2026-11-21)',
      strictExecution: 'costPct=0.10% round-trip + slippagePct=0.025% per fill (0.15% total friction), SL beats TP on same bar, limitSameBarTp=close, no-arming-bar BE exit, initial RR>=0.75',
      sliceEvaluationNote: 'Yearly (Y1/Y2/Y3) and Semi-Annual (H1..H6) use continuous 3-year trade attribution (signalIndex >= start && exitIndex < end) without resetting positions/warmup at boundaries.',
    },
    verificationSummary: {
      reportFile: 'research/results_v4/verification_report.json',
      verifiedAt: verifReport.verifiedAt,
      overallStatus: verifReport.overallStatus,
      totalCandidatesVerified: verifReport.totalCandidatesVerified,
      checksRunPerCandidate: verifReport.checksRunPerCandidate,
      byCandidateKey: Object.fromEntries(
        Object.entries(verifByKey).map(([k, v]) => [k, {
          overallStatus: v.overallStatus,
          cutoffsPassed: v.prefixCausality.length,
          futureMutationPivot: v.futureMutationCausality.pivot,
          scalesPassed: v.priceScaleInvariance.map(s => s.scale),
          spotTradesVerified: v.conservativeFillInvariants.spotTradesVerified,
          swapTradesVerified: v.conservativeFillInvariants.swapTradesVerified,
        }]),
      ),
    },
    track15m: track15mResults,
    track1h: track1hResults,
  };

  const outPath = path.join(RESULTS_V4_DIR, 'summary_v4.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');

  const fmtLine = (label, res, has2x = false) => {
    const sp = res.datasets.okxSpot3y;
    const sw = res.datasets.okxSwap3y;
    const tvSp = res.datasets.okxSpotTv6k.full;
    const tvSw = res.datasets.okxSwapTv6k.full;
    const y1 = sp.yearly[0];
    const y2 = sp.yearly[1];
    const y3 = sp.yearly[2];
    const swY3 = sw.yearly[2];
    const extra2x = has2x
      ? ` | Swap2x: Add=${sw.informationalPerp2x.additive2xNetPct}% Comp=${sw.informationalPerp2x.compounded2xNetPct}% DD2x=${sw.informationalPerp2x.additive2xMaxDdPct}%`
      : '';
    return `${label.padEnd(11)} | Spot3y: n=${String(sp.full.count).padEnd(3)} WR=${sp.full.winRatePct.toFixed(2)}% PF=${sp.full.profitFactor.toFixed(2)} Add=${sp.full.totalNetPct.toFixed(2)}% Comp=${sp.full.compoundedNetPct.toFixed(2)}% DD=${sp.full.maxDrawdownPct.toFixed(2)}% noBePF=${sp.noBe.profitFactor.toFixed(2)} [Y1:${y1.totalNetPct.toFixed(1)}% Y2:${y2.totalNetPct.toFixed(1)}% Y3:${y3.totalNetPct.toFixed(1)}%(${y3.winRatePct.toFixed(1)}%)] | Swap3y: n=${String(sw.full.count).padEnd(3)} WR=${sw.full.winRatePct.toFixed(2)}% PF=${sw.full.profitFactor.toFixed(2)} Add=${sw.full.totalNetPct.toFixed(2)}% Comp=${sw.full.compoundedNetPct.toFixed(2)}% Y3=${swY3.totalNetPct.toFixed(1)}% | TV6k: Sp=${tvSp.totalNetPct.toFixed(1)}%(${tvSp.winRatePct.toFixed(1)}%) Sw=${tvSw.totalNetPct.toFixed(1)}%(${tvSw.winRatePct.toFixed(1)}%)${extra2x}`;
  };

  console.log('\n=== TRACK A (15m) SIDE-BY-SIDE ===');
  for (const k of ['v3_baseline', '15m_r1r2', '15m_r3', '15m_r4']) {
    console.log(fmtLine(k, track15mResults[k], false));
  }
  console.log('\n=== TRACK B (1h) SIDE-BY-SIDE ===');
  for (const k of ['v3_baseline', '1h_r1r2', '1h_r3', '1h_r4', '1h_r5']) {
    console.log(fmtLine(k, track1hResults[k], true));
  }
  console.log(`\n[build_summary_v4] Wrote ${path.relative(ROOT_DIR, outPath)}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSummaryV4();
}
