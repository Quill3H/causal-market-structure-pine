import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTrades } from './sim_engine.mjs';
import {
  DEFAULT_WARMUP_15M,
  generateSignals15mV4,
  precompute15mV4,
  sliceDatasetPrefix15m,
} from './signals_15m_v4.mjs';
import { sliceDatasetPrefix1h } from './signals_1h.mjs';
import { generateSignals1hV4, precompute1hV4 } from './signals_1h_v4.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const RESULTS_V4_DIR = path.join(HERE, 'results_v4');

const CANDIDATE_SPECS = [
  { key: '15m_r1r2', track: '15m', lockFile: 'lock_15m.json', spotRel: 'data/okx_btcusdt_15m_3y.json', swapRel: 'data/okx_btcusdt_swap_15m_3y.json' },
  { key: '15m_r3',   track: '15m', lockFile: 'lock_15m_r3.json', spotRel: 'data/okx_btcusdt_15m_3y.json', swapRel: 'data/okx_btcusdt_swap_15m_3y.json' },
  { key: '15m_r4',   track: '15m', lockFile: 'lock_15m_r4.json', spotRel: 'data/okx_btcusdt_15m_3y.json', swapRel: 'data/okx_btcusdt_swap_15m_3y.json' },
  { key: '1h_r1r2',  track: '1h',  lockFile: 'lock_1h.json',  spotRel: 'data/okx_btcusdt_1h_3y.json',  swapRel: 'data/okx_btcusdt_swap_1h_3y.json' },
  { key: '1h_r3',    track: '1h',  lockFile: 'lock_1h_r3.json', spotRel: 'data/okx_btcusdt_1h_3y.json',  swapRel: 'data/okx_btcusdt_swap_1h_3y.json' },
  { key: '1h_r4',    track: '1h',  lockFile: 'lock_1h_r4.json', spotRel: 'data/okx_btcusdt_1h_3y.json',  swapRel: 'data/okx_btcusdt_swap_1h_3y.json' },
  { key: '1h_r5',    track: '1h',  lockFile: 'lock_1h_r5.json', spotRel: 'data/okx_btcusdt_1h_3y.json',  swapRel: 'data/okx_btcusdt_swap_1h_3y.json' },
];

const CUTOFFS_15M = [25000, 45000, 65000, 85000, 100000];
const CUTOFFS_1H = [6000, 11000, 16000, 21000, 25000];
const MUTATION_PIVOT_15M = 65000;
const MUTATION_PIVOT_1H = 16000;
const SCALES = [0.37, 3.14];

function cloneDatasetWithScale(ds, scale) {
  const htf = {};
  for (const [tf, h] of Object.entries(ds.htf ?? {})) {
    htf[tf] = {
      ...h,
      rows: h.rows.map(r => ({
        ...r,
        open: r.open * scale,
        high: r.high * scale,
        low: r.low * scale,
        close: r.close * scale,
      })),
    };
  }
  return {
    ...ds,
    rows: ds.rows.map(r => ({
      ...r,
      open: r.open * scale,
      high: r.high * scale,
      low: r.low * scale,
      close: r.close * scale,
    })),
    htf,
  };
}

function cloneDatasetMutatingFuture(ds, pivotIdx) {
  const lastObservedTime = ds.rows[pivotIdx - 1].time;
  const rows = ds.rows.map((r, idx) => {
    if (idx < pivotIdx) return { ...r };
    const mult = idx % 2 === 0 ? 0.35 : 2.4;
    const o = Math.max(1, r.open * mult);
    const c = Math.max(1, r.close * (idx % 3 === 0 ? 0.4 : 2.1));
    const hi = Math.max(o, c) * 1.15;
    const lo = Math.max(0.5, Math.min(o, c) * 0.85);
    return {
      ...r,
      open: o,
      high: hi,
      low: lo,
      close: c,
      volume: r.volume * 50 + 1000,
    };
  });

  const htf = {};
  for (const [tf, h] of Object.entries(ds.htf ?? {})) {
    const intervalSeconds = h.intervalSeconds;
    htf[tf] = {
      ...h,
      alignedIndex: [...h.alignedIndex],
      rows: h.rows.map((hr, j) => {
        if (hr.time + intervalSeconds <= lastObservedTime) {
          return { ...hr };
        }
        const mult = j % 2 === 0 ? 0.35 : 2.4;
        const o = Math.max(1, hr.open * mult);
        const c = Math.max(1, hr.close * (j % 3 === 0 ? 0.4 : 2.1));
        return {
          ...hr,
          open: o,
          high: Math.max(o, c) * 1.15,
          low: Math.max(0.5, Math.min(o, c) * 0.85),
          close: c,
          volume: hr.volume * 50 + 1000,
        };
      }),
    };
  }
  return { ...ds, rows, htf };
}

function compareSignalArraysPrefix(fullSigs, prefSigs, cutoff, scale = 1, relTol = 1e-12) {
  const expected = fullSigs.filter(s => s.barIndex < cutoff);
  assert.equal(prefSigs.length, expected.length, `signal count mismatch at cutoff=${cutoff}: got ${prefSigs.length}, expected ${expected.length}`);
  let maxRelDiff = 0;
  for (let i = 0; i < expected.length; i++) {
    const a = expected[i];
    const b = prefSigs[i];
    assert.equal(b.barIndex, a.barIndex, `sig[${i}].barIndex mismatch: ${b.barIndex} vs ${a.barIndex}`);
    assert.equal(b.side, a.side, `sig[${i}]@${b.barIndex}.side mismatch: ${b.side} vs ${a.side}`);
    const atrDenom = Math.max(1e-12, Math.abs(a.atr));
    const atrRel = Math.abs(b.atr / scale - a.atr) / atrDenom;
    if (atrRel > maxRelDiff) maxRelDiff = atrRel;
    assert.ok(atrRel <= relTol, `sig[${i}]@${b.barIndex}.atr relDiff=${atrRel} > ${relTol}`);
    assert.equal(b.limitPrice !== undefined, a.limitPrice !== undefined, `sig[${i}].limitPrice presence mismatch`);
    if (a.limitPrice !== undefined) {
      const limDenom = Math.max(1e-12, Math.abs(a.limitPrice));
      const limRel = Math.abs(b.limitPrice / scale - a.limitPrice) / limDenom;
      if (limRel > maxRelDiff) maxRelDiff = limRel;
      assert.ok(limRel <= relTol, `sig[${i}]@${b.barIndex}.limitPrice relDiff=${limRel} > ${relTol}`);
    }
  }
  return { checkedSignals: expected.length, maxRelDiff };
}

function compareClosedTradesPrefix(fullTrades, prefTrades, cutoff) {
  const expected = fullTrades.filter(t => t.exitIndex < cutoff);
  assert.equal(prefTrades.length, expected.length, `closed trades mismatch at cutoff=${cutoff}: got ${prefTrades.length}, expected ${expected.length}`);
  for (let i = 0; i < expected.length; i++) {
    const a = expected[i];
    const b = prefTrades[i];
    assert.equal(b.signalIndex, a.signalIndex, `trade[${i}].signalIndex mismatch`);
    assert.equal(b.entryIndex, a.entryIndex, `trade[${i}].entryIndex mismatch`);
    assert.equal(b.exitIndex, a.exitIndex, `trade[${i}].exitIndex mismatch`);
    assert.equal(b.side, a.side, `trade[${i}].side mismatch`);
    assert.equal(b.exitReason, a.exitReason, `trade[${i}].exitReason mismatch`);
    assert.ok(Math.abs(b.entry - a.entry) <= 1e-12, `trade[${i}].entry mismatch: ${b.entry} vs ${a.entry}`);
    assert.ok(Math.abs(b.exit - a.exit) <= 1e-12, `trade[${i}].exit mismatch: ${b.exit} vs ${a.exit}`);
    assert.ok(Math.abs(b.netPct - a.netPct) <= 1e-12, `trade[${i}].netPct mismatch: ${b.netPct} vs ${a.netPct}`);
  }
  return expected.length;
}

function checkConservativeFillInvariants(ds, sim, execOptions, label) {
  assert.equal(execOptions.costPct, 0.10, `${label}: costPct must be 0.10, got ${execOptions.costPct}`);
  assert.equal(execOptions.slippagePct, 0.025, `${label}: slippagePct must be 0.025, got ${execOptions.slippagePct}`);
  assert.ok(execOptions.rewardRisk >= 0.75, `${label}: rewardRisk must be >= 0.75, got ${execOptions.rewardRisk}`);

  const slippageFrac = execOptions.slippagePct / 100;
  for (let i = 0; i < sim.trades.length; i++) {
    const t = sim.trades[i];
    assert.ok(t.entryIndex >= t.signalIndex + 1, `${label} trade[${i}]: entryIndex ${t.entryIndex} < signalIndex+1 ${t.signalIndex + 1}`);
    assert.ok(t.exitIndex >= t.entryIndex, `${label} trade[${i}]: exitIndex ${t.exitIndex} < entryIndex ${t.entryIndex}`);

    const drag = t.grossPct - t.netPct;
    assert.ok(Math.abs(drag - execOptions.costPct) < 1e-6, `${label} trade[${i}]: grossPct-netPct=${drag} != costPct=${execOptions.costPct}`);

    if (t.exitReason === 'BE') {
      assert.ok(t.beArmedIndex !== null && t.beArmedIndex !== undefined, `${label} trade[${i}]: BE exit missing beArmedIndex`);
      assert.ok(t.beArmedIndex < t.exitIndex, `${label} trade[${i}]: BE triggered on arming bar (${t.beArmedIndex} == ${t.exitIndex})`);
    }
    if (t.beArmedIndex !== null && t.beArmedIndex !== undefined) {
      assert.ok(t.beArmedIndex >= t.entryIndex, `${label} trade[${i}]: beArmedIndex before entryIndex`);
    }

    if (execOptions.entryMode === 'LIMIT_PULLBACK' && t.exitIndex === t.entryIndex && t.exitReason === 'TP') {
      const closePx = ds.rows[t.exitIndex].close;
      if (t.side === 1) {
        assert.ok(closePx >= t.target, `${label} trade[${i}]: same-bar LONG limit TP without close >= target (${closePx} < ${t.target})`);
      } else {
        assert.ok(closePx <= t.target, `${label} trade[${i}]: same-bar SHORT limit TP without close <= target (${closePx} > ${t.target})`);
      }
    }

    // Verify adverse slippage orientation on entry vs raw entry anchor
    const entryAnchor = t.side === 1
      ? t.entry / (1 + slippageFrac)
      : t.entry / (1 - slippageFrac);
    const bar = ds.rows[t.entryIndex];
    if (execOptions.entryMode === 'MARKET_NEXT_OPEN') {
      assert.ok(Math.abs(entryAnchor - bar.open) <= 1e-6, `${label} trade[${i}]: MARKET_NEXT_OPEN anchor ${entryAnchor} != open ${bar.open}`);
    } else if (execOptions.entryMode === 'LIMIT_PULLBACK') {
      assert.ok(entryAnchor >= bar.low - 1e-6 && entryAnchor <= bar.high + 1e-6, `${label} trade[${i}]: limit anchor outside entry bar [${bar.low}, ${bar.high}]`);
    }
  }
  return sim.trades.length;
}

export function verifyV4Candidates() {
  const dsCache = new Map();
  const loadDs = (rel) => {
    if (!dsCache.has(rel)) {
      dsCache.set(rel, JSON.parse(fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8')));
    }
    return dsCache.get(rel);
  };

  const results = [];
  for (const spec of CANDIDATE_SPECS) {
    const lock = JSON.parse(fs.readFileSync(path.join(RESULTS_V4_DIR, spec.lockFile), 'utf8'));
    const winner = lock.winner;
    const is15m = spec.track === '15m';
    const sliceFn = is15m ? sliceDatasetPrefix15m : sliceDatasetPrefix1h;
    const preFn = is15m ? precompute15mV4 : precompute1hV4;
    const genFn = is15m ? generateSignals15mV4 : generateSignals1hV4;
    const cutoffs = is15m ? CUTOFFS_15M : CUTOFFS_1H;
    const pivot = is15m ? MUTATION_PIVOT_15M : MUTATION_PIVOT_1H;

    const spotDs = loadDs(spec.spotRel);
    const swapDs = loadDs(spec.swapRel);
    const simOpts = { ...winner.execOptions, intervalSeconds: spotDs.intervalSeconds };

    const spotPre = preFn(spotDs);
    const fullSpotSigs = genFn(spotDs, winner.fullSpec, spotPre);
    const fullSpotSim = simulateTrades(spotDs.rows, fullSpotSigs, simOpts);

    // 1. Prefix-truncation causality (5 cutoffs)
    const prefixChecks = [];
    for (const cutoff of cutoffs) {
      const prefDs = sliceFn(spotDs, cutoff);
      const prefPre = preFn(prefDs);
      const prefSigs = genFn(prefDs, winner.fullSpec, prefPre);
      const sigCmp = compareSignalArraysPrefix(fullSpotSigs, prefSigs, cutoff, 1, 1e-12);
      const prefSim = simulateTrades(prefDs.rows, prefSigs, { ...simOpts, intervalSeconds: prefDs.intervalSeconds });
      const checkedTrades = compareClosedTradesPrefix(fullSpotSim.trades, prefSim.trades, cutoff);
      prefixChecks.push({ cutoff, checkedSignals: sigCmp.checkedSignals, checkedTrades, status: 'PASS' });
    }

    // 2. Future-mutation causality
    const mutDs = cloneDatasetMutatingFuture(spotDs, pivot);
    const mutPre = preFn(mutDs);
    const mutSigs = genFn(mutDs, winner.fullSpec, mutPre);
    const mutPrefSigs = mutSigs.filter(s => s.barIndex < pivot);
    const mutSigCmp = compareSignalArraysPrefix(fullSpotSigs, mutPrefSigs, pivot, 1, 1e-12);
    const mutSim = simulateTrades(mutDs.rows, mutSigs, simOpts);
    const mutCheckedTrades = compareClosedTradesPrefix(fullSpotSim.trades, mutSim.trades.filter(t => t.exitIndex < pivot), pivot);

    // 3. Price-scale invariance (x 0.37 and x 3.14)
    const scaleChecks = [];
    for (const scale of SCALES) {
      const scaledDs = cloneDatasetWithScale(spotDs, scale);
      const scaledPre = preFn(scaledDs);
      const scaledSigs = genFn(scaledDs, winner.fullSpec, scaledPre);
      const sigCmp = compareSignalArraysPrefix(fullSpotSigs, scaledSigs, spotDs.rows.length, scale, 1e-7);
      const scaledSim = simulateTrades(scaledDs.rows, scaledSigs, simOpts);
      assert.equal(scaledSim.count, fullSpotSim.count, `${spec.key} scale=${scale}: trade count mismatch ${scaledSim.count} vs ${fullSpotSim.count}`);
      assert.equal(scaledSim.wins, fullSpotSim.wins, `${spec.key} scale=${scale}: wins mismatch ${scaledSim.wins} vs ${fullSpotSim.wins}`);
      assert.equal(scaledSim.losses, fullSpotSim.losses, `${spec.key} scale=${scale}: losses mismatch ${scaledSim.losses} vs ${fullSpotSim.losses}`);
      assert.deepEqual(scaledSim.exitReasons, fullSpotSim.exitReasons, `${spec.key} scale=${scale}: exitReasons mismatch`);
      const netDiff = Math.abs(scaledSim.totalNetPct - fullSpotSim.totalNetPct);
      assert.ok(netDiff < 1e-5, `${spec.key} scale=${scale}: totalNetPct diff=${netDiff} >= 1e-5`);
      scaleChecks.push({
        scale,
        signals: scaledSigs.length,
        trades: scaledSim.count,
        maxSignalRelDiff: Number(sigCmp.maxRelDiff.toExponential(3)),
        netPctDiff: Number(netDiff.toExponential(3)),
        status: 'PASS',
      });
    }

    // 4. Conservative fill invariants on OKX Spot 3y and OKX Swap 3y
    const swapPre = preFn(swapDs);
    const swapSigs = genFn(swapDs, winner.fullSpec, swapPre);
    const swapSim = simulateTrades(swapDs.rows, swapSigs, { ...winner.execOptions, intervalSeconds: swapDs.intervalSeconds });

    const spotTradesVerified = checkConservativeFillInvariants(spotDs, fullSpotSim, winner.execOptions, `${spec.key}:Spot3y`);
    const swapTradesVerified = checkConservativeFillInvariants(swapDs, swapSim, winner.execOptions, `${spec.key}:Swap3y`);

    const rowSummary = {
      key: spec.key,
      track: spec.track,
      lockFile: spec.lockFile,
      id: winner.id,
      prefixCausality: prefixChecks,
      futureMutationCausality: {
        pivot,
        checkedSignals: mutSigCmp.checkedSignals,
        checkedTrades: mutCheckedTrades,
        status: 'PASS',
      },
      priceScaleInvariance: scaleChecks,
      conservativeFillInvariants: {
        costPct: winner.execOptions.costPct,
        slippagePct: winner.execOptions.slippagePct,
        totalRoundTripDragPct: Number((winner.execOptions.costPct + 2 * winner.execOptions.slippagePct).toFixed(4)),
        rewardRisk: winner.execOptions.rewardRisk,
        spotTradesVerified,
        swapTradesVerified,
        status: 'PASS',
      },
      overallStatus: 'PASS',
    };
    results.push(rowSummary);
    console.log(`[PASS] ${spec.key.padEnd(9)} | prefix(5)=PASS mut(p=${pivot})=PASS scale(0.37,3.14)=PASS fillInv(spot=${spotTradesVerified},swap=${swapTradesVerified})=PASS | ${winner.id}`);
  }

  const report = {
    schema: 'smc-v4-verification-report-v1',
    verifiedAt: new Date().toISOString(),
    overallStatus: 'ALL_PASSED',
    totalCandidatesVerified: results.length,
    checksRunPerCandidate: [
      'prefixTruncationCausality(5 cutoffs: signals + closedTrades)',
      'futureMutationCausality(OHLCV + non-closed HTF bars)',
      'priceScaleInvariance(0.37x, 3.14x)',
      'conservativeFillInvariants(costPct=0.10, slippagePct=0.025, RR>=0.75, no-arming-bar BE, entry/close invariants)',
    ],
    results,
  };
  const outPath = path.join(RESULTS_V4_DIR, 'verification_report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n[verify_v4_candidates] ALL_PASSED (${results.length}/${results.length} candidates). Report -> ${path.relative(ROOT_DIR, outPath)}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyV4Candidates();
}
