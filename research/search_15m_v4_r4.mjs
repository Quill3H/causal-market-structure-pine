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
import { summarizeTradesSlice } from './search_15m_v4_r3.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results_v4');

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function eval15mR4(calValDs, pre, sig, ex, bounds) {
  const { calEnd, valEnd } = bounds;
  const rows = calValDs.rows;
  const entryMode = (sig.pullAtr ?? 0) > 0 ? 'LIMIT_PULLBACK' : 'MARKET_NEXT_OPEN';
  const virtExec = {
    entryMode,
    limitExpiryBars: ex.limitExpiryBars ?? 24,
    pendingPolicy: ex.pendingPolicy ?? 'ignore',
    limitSameBarTp: 'close',
    warmup: DEFAULT_WARMUP_15M,
    costPct: 0.10,
    slippagePct: 0.025,
    ...ex,
  };
  const fullSpec = { ...sig, virtExec };
  const signals = generateSignals15mV4(calValDs, fullSpec, pre);
  const opts = { ...virtExec, intervalSeconds: calValDs.intervalSeconds };

  const cvSim = simulateTrades(rows, signals, { ...opts, start: 0, end: valEnd });
  const cal = summarizeTradesSlice(cvSim.trades, rows, 0, calEnd);
  const val = summarizeTradesSlice(cvSim.trades, rows, calEnd, valEnd);
  const calVal = summarizeTradesSlice(cvSim.trades, rows, 0, valEnd);

  const hStep = Math.floor(valEnd / 4);
  const hSlices = [];
  for (let s = 0; s < 4; s++) {
    const st = s * hStep;
    const en = s === 3 ? valEnd : (s + 1) * hStep;
    hSlices.push({ label: `H${s + 1}`, ...summarizeTradesSlice(cvSim.trades, rows, st, en) });
  }

  const minHWr = Math.min(...hSlices.map(h => h.winRatePct));
  const minHPf = Math.min(...hSlices.map(h => h.profitFactor));
  const minHNet = Math.min(...hSlices.map(h => h.totalNetPct));
  const minSideWr = Math.min(calVal.buyWinRatePct, calVal.sellWinRatePct);

  let noBeCalVal = null;
  if (calVal.winRatePct >= 65.0 && calVal.profitFactor >= 1.20) {
    const noBeSim = simulateTrades(rows, signals, {
      ...opts, start: 0, end: valEnd, beTriggerR: 0, lock2TriggerR: 0, trailTriggerR: 0,
    });
    noBeCalVal = summarizeTradesSlice(noBeSim.trades, rows, 0, valEnd);
  }
  const noBePf = noBeCalVal?.profitFactor ?? 0;

  const eligibleStrict =
    calVal.count >= 160 &&
    cal.count >= 100 &&
    val.count >= 40 &&
    cal.winRatePct >= 66.0 &&
    val.winRatePct >= 66.0 &&
    calVal.winRatePct >= 67.0 &&
    cal.profitFactor >= 1.25 &&
    val.profitFactor >= 1.25 &&
    calVal.profitFactor >= 1.28 &&
    minHWr >= 62.0 &&
    minHPf >= 1.05 &&
    minHNet > 0 &&
    noBePf >= 1.05 &&
    minSideWr >= 61.0 &&
    calVal.buyNetPct > 0 &&
    calVal.sellNetPct > 0;

  const eligibleMid =
    calVal.count >= 145 &&
    cal.winRatePct >= 65.0 &&
    val.winRatePct >= 65.0 &&
    calVal.winRatePct >= 66.0 &&
    cal.profitFactor >= 1.20 &&
    val.profitFactor >= 1.15 &&
    minHWr >= 60.0 &&
    minHPf >= 1.00 &&
    noBePf >= 1.02 &&
    minSideWr >= 59.0 &&
    calVal.buyNetPct > 0 &&
    calVal.sellNetPct > 0;

  const score =
    calVal.totalNetPct * 0.95 +
    (calVal.wilsonLower95Pct - 60) * 3.0 +
    (calVal.profitFactor - 1) * 65 +
    calVal.retToDd * 12 +
    (minHPf - 1) * 50 +
    (noBePf - 1) * 40;

  return {
    id: `${sig.tag}|${ex.etag}`,
    sig,
    execOptions: virtExec,
    fullSpec,
    cal,
    val,
    calVal,
    hSlices,
    noBeCalVal,
    noBePf,
    minHWr,
    minHPf,
    minSideWr,
    eligibleStrict,
    eligibleMid,
    score: Number(score.toFixed(3)),
  };
}

export function runSearch15mV4R4() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const fullSpot = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'okx_btcusdt_15m_3y.json'), 'utf8'));
  const N = fullSpot.rows.length;
  const calEnd = Math.floor(N * 0.5);
  const valEnd = Math.floor((N * 2) / 3);
  const calValDs = sliceDatasetPrefix15m(fullSpot, valEnd);
  const preCalVal = precompute15mV4(calValDs);

  const signalTemplates = [
    // Exact 1h MultiTrap physics scaled onto 15m execution (N=20 on 1h, P4=10 on 4h, 24h)
    { tag: 'H1Sync_N20P10_p0.35_w6', rawFamily: 'M15_H1SyncedMultiTrap', h1Lookback: 20, h4Lookback: 10, trapMaxBars: 4, include24h: true, ltfLookback: null, htfMode: 'H4_50', minAtrPct: 0.14, pullAtr: 0.35, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'H1Sync_N20P10_p0.50_w6', rawFamily: 'M15_H1SyncedMultiTrap', h1Lookback: 20, h4Lookback: 10, trapMaxBars: 4, include24h: true, ltfLookback: null, htfMode: 'H4_50', minAtrPct: 0.14, pullAtr: 0.50, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'H1Sync_N20P10_mkt_w6', rawFamily: 'M15_H1SyncedMultiTrap', h1Lookback: 20, h4Lookback: 10, trapMaxBars: 4, include24h: true, ltfLookback: null, htfMode: 'H4_50', minAtrPct: 0.14, pullAtr: 0, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    // Composite: H1SyncTrap + 15m N80 Trap
    { tag: 'H1Sync_Ltf80_p0.35_w6', rawFamily: 'M15_H1SyncedMultiTrap', h1Lookback: 20, h4Lookback: 10, trapMaxBars: 4, include24h: true, ltfLookback: 80, ltfTrapK: 4, htfMode: 'H4_50', minAtrPct: 0.15, pullAtr: 0.35, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    // Orthogonal Composite: H1SyncTrap + H4 Close Displacement (combines chop alpha + trend alpha!)
    { tag: 'Comp_H1Sync_H4Disp1.0_p0.35_w6', rawFamily: 'M15_H1SyncedMultiTrap', h1Lookback: 20, h4Lookback: 10, trapMaxBars: 4, include24h: true, ltfLookback: null, h4DispEnable: true, h4BodyAtrMin: 1.0, h4ClosePosMin: 0.60, htfMode: 'H4_50', minAtrPct: 0.15, pullAtr: 0.35, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'Comp_H1Sync_H4Disp0.85_p0.35_w7', rawFamily: 'M15_H1SyncedMultiTrap', h1Lookback: 20, h4Lookback: 10, trapMaxBars: 4, include24h: true, ltfLookback: null, h4DispEnable: true, h4BodyAtrMin: 0.85, h4ClosePosMin: 0.60, htfMode: 'H4_50', minAtrPct: 0.15, pullAtr: 0.35, adaptive: true, winLen: 7, slThresh: 2, requireNegNet: true },
    // Stricter H4Disp only (tighter displacement 1.0 ATR & H4_50_AND_H1_50)
    { tag: 'H4Disp1.0_H1_50_p0.35_w6', rawFamily: 'M15_H4Disp', h4BodyAtrMin: 1.0, h4ClosePosMin: 0.62, onH4CloseOnly: true, requireLtfConfirm: false, htfMode: 'H4_50_AND_H1_50', minAtrPct: 0.16, pullAtr: 0.35, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'H4Disp0.9_LtfConf_p0.35_w6', rawFamily: 'M15_H4Disp', h4BodyAtrMin: 0.90, h4ClosePosMin: 0.60, onH4CloseOnly: true, requireLtfConfirm: true, htfMode: 'H4_50', minAtrPct: 0.15, pullAtr: 0.35, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
  ];

  const execTemplates = [];
  for (const stopAtr of [5.0, 6.0, 7.0]) {
    for (const minStopPct of [1.4, 1.7]) {
      for (const rewardRisk of [1.15, 1.35, 1.65]) {
        for (const cooldown of [12, 20]) {
          execTemplates.push({
            etag: `s${stopAtr}_m${minStopPct}_rr${rewardRisk}_be0.43_o0.36_cd${cooldown}`,
            stopAtr, minStopPct, rewardRisk, maxHoldBars: 384, limitExpiryBars: 24,
            beTriggerR: 0.43, beOffsetPct: 0.36, lock2TriggerR: 0, lock2OffsetR: 0, trailTriggerR: 0, trailAtrMult: 0, cooldown,
          });
          execTemplates.push({
            etag: `s${stopAtr}_m${minStopPct}_rr${rewardRisk}_be0.46_o0.44_l2_0.95_0.55_cd${cooldown}`,
            stopAtr, minStopPct, rewardRisk, maxHoldBars: 384, limitExpiryBars: 24,
            beTriggerR: 0.46, beOffsetPct: 0.44, lock2TriggerR: 0.95, lock2OffsetR: 0.55, trailTriggerR: 0, trailAtrMult: 0, cooldown,
          });
        }
      }
    }
  }

  console.log(`[search_15m_v4_r4] Stage A: evaluating ${signalTemplates.length * execTemplates.length} candidates on Cal+Val...`);
  const stageA = [];
  for (const sig of signalTemplates) {
    for (const ex of execTemplates) {
      stageA.push(eval15mR4(calValDs, preCalVal, sig, ex, { calEnd, valEnd }));
    }
  }
  stageA.sort((a, b) => {
    if (a.eligibleStrict !== b.eligibleStrict) return a.eligibleStrict ? -1 : 1;
    if (a.eligibleMid !== b.eligibleMid) return a.eligibleMid ? -1 : 1;
    return b.score - a.score;
  });

  console.log(`[search_15m_v4_r4] Stage A done: strict=${stageA.filter(x => x.eligibleStrict).length}, mid=${stageA.filter(x => x.eligibleMid).length}`);
  for (const r of stageA.slice(0, 15)) {
    const tag = r.eligibleStrict ? 'STRICT' : r.eligibleMid ? 'MID   ' : 'MISS  ';
    console.log(`  [${tag}] ${r.id} | n=${r.calVal.count} WR=${r.calVal.winRatePct}% PF=${r.calVal.profitFactor} Net=${r.calVal.totalNetPct}% DD=${r.calVal.maxDrawdownPct}% B/S=${r.calVal.buyWinRatePct}/${r.calVal.sellWinRatePct} noBePF=${r.noBePf} minH=${r.minHWr}%/${r.minHPf}`);
  }

  // Stage B: Plateau neighborhood stability check on top distinct archetypes
  const seedPool = stageA.filter(x => x.eligibleStrict || x.eligibleMid);
  const finalPool = seedPool.length > 0 ? seedPool : stageA;
  const distinctArchetypes = [];
  for (const cand of finalPool) {
    const archKey = `${cand.sig.tag}|l2=${cand.execOptions.lock2TriggerR}`;
    if (!distinctArchetypes.some(x => x.archKey === archKey)) {
      distinctArchetypes.push({ archKey, cand });
    }
    if (distinctArchetypes.length >= 8) break;
  }

  const plateauSummaries = [];
  for (const { cand } of distinctArchetypes) {
    const e = cand.execOptions;
    const stopAtrs = [Math.max(3.5, Number((e.stopAtr - 0.6).toFixed(1))), e.stopAtr, Number((e.stopAtr + 0.6).toFixed(1))];
    const minStops = [Math.max(1.2, Number((e.minStopPct - 0.2).toFixed(1))), e.minStopPct, Number((e.minStopPct + 0.2).toFixed(1))];
    const rrs = [Math.max(1.05, Number((e.rewardRisk - 0.15).toFixed(2))), e.rewardRisk, Number((e.rewardRisk + 0.15).toFixed(2))];
    const neighbors = [];
    for (const sAtr of stopAtrs) {
      for (const mStop of minStops) {
        for (const rr of rrs) {
          const exN = { ...e, stopAtr: sAtr, minStopPct: mStop, rewardRisk: rr, etag: `s${sAtr}_m${mStop}_rr${rr}_cd${e.cooldown}` };
          neighbors.push(eval15mR4(calValDs, preCalVal, cand.sig, exN, { calEnd, valEnd }));
        }
      }
    }
    const strictPassRate = neighbors.filter(n => n.eligibleStrict).length / neighbors.length;
    const midPassRate = neighbors.filter(n => n.eligibleMid).length / neighbors.length;
    const medNet = median(neighbors.map(n => n.calVal.totalNetPct));
    const medPf = median(neighbors.map(n => n.calVal.profitFactor));
    const medWr = median(neighbors.map(n => n.calVal.winRatePct));
    const medMinHPf = median(neighbors.map(n => n.minHPf));
    const medScore = median(neighbors.map(n => n.score));
    const plateauScore = 0.5 * cand.score + 0.5 * medScore + strictPassRate * 75 + midPassRate * 35;
    plateauSummaries.push({
      seed: cand,
      neighborsCount: neighbors.length,
      strictPassRate: Number(strictPassRate.toFixed(3)),
      midPassRate: Number(midPassRate.toFixed(3)),
      medNet: Number(medNet.toFixed(2)),
      medPf: Number(medPf.toFixed(3)),
      medWr: Number(medWr.toFixed(2)),
      medMinHPf: Number(medMinHPf.toFixed(3)),
      plateauScore: Number(plateauScore.toFixed(2)),
      neighbors,
    });
  }

  plateauSummaries.sort((a, b) => b.plateauScore - a.plateauScore);
  console.log('\n[search_15m_v4_r4] Stage B Plateau Rankings (Cal+Val only):');
  for (const p of plateauSummaries) {
    console.log(`  seed=${p.seed.id} | plateauScore=${p.plateauScore} strictNbr=${(p.strictPassRate*100).toFixed(0)}% midNbr=${(p.midPassRate*100).toFixed(0)}% medWR=${p.medWr}% medPF=${p.medPf} medNet=${p.medNet}% medMinHPF=${p.medMinHPf}`);
  }

  const chosenPlateau = plateauSummaries[0];
  const validNeighbors = chosenPlateau.neighbors.filter(n => n.eligibleStrict || n.eligibleMid);
  validNeighbors.sort((a, b) => b.score - a.score);
  const winner = validNeighbors[0] ?? chosenPlateau.seed;

  console.log(`\n[search_15m_v4_r4] LOCKING ROUND-4 WINNER: ${winner.id}`);
  console.log(`  Cal: n=${winner.cal.count} WR=${winner.cal.winRatePct}% PF=${winner.cal.profitFactor} Net=${winner.cal.totalNetPct}%`);
  console.log(`  Val: n=${winner.val.count} WR=${winner.val.winRatePct}% PF=${winner.val.profitFactor} Net=${winner.val.totalNetPct}%`);
  console.log(`  CalVal: n=${winner.calVal.count} WR=${winner.calVal.winRatePct}% PF=${winner.calVal.profitFactor} Net=${winner.calVal.totalNetPct}% (comp=${winner.calVal.compoundedNetPct}%) DD=${winner.calVal.maxDrawdownPct}% noBePF=${winner.noBePf}`);

  const evalFull = (relPath) => {
    const ds = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8'));
    const sigs = generateSignals15mV4(ds, winner.fullSpec);
    const opts = { ...winner.execOptions, intervalSeconds: ds.intervalSeconds };
    const fullSim = simulateTrades(ds.rows, sigs, opts);
    const noBeSim = simulateTrades(ds.rows, sigs, { ...opts, beTriggerR: 0, lock2TriggerR: 0, trailTriggerR: 0 });
    return {
      dataset: relPath,
      symbol: ds.symbol,
      bars: ds.rows.length,
      signals: sigs.length,
      full: summarizeTradesSlice(fullSim.trades, ds.rows, 0, ds.rows.length),
      noBe: summarizeTradesSlice(noBeSim.trades, ds.rows, 0, ds.rows.length),
      yearly: ds.rows.length >= 100000 ? [0, 1, 2].map(y => {
        const st = y * Math.floor(ds.rows.length / 3);
        const en = y === 2 ? ds.rows.length : (y + 1) * Math.floor(ds.rows.length / 3);
        return { year: y + 1, ...summarizeTradesSlice(fullSim.trades, ds.rows, st, en) };
      }) : undefined,
      semiAnnual: ds.rows.length >= 100000 ? [0, 1, 2, 3, 4, 5].map(h => {
        const st = h * Math.floor(ds.rows.length / 6);
        const en = h === 5 ? ds.rows.length : (h + 1) * Math.floor(ds.rows.length / 6);
        return { half: h + 1, ...summarizeTradesSlice(fullSim.trades, ds.rows, st, en) };
      }) : undefined,
    };
  };

  const unsealed = {
    okxSpot3y: evalFull('data/okx_btcusdt_15m_3y.json'),
    okxSwap3y: evalFull('data/okx_btcusdt_swap_15m_3y.json'),
    okxSpotTv6k: evalFull('data/okx_btcusdt_tv_15m_6k.json'),
    okxSwapTv6k: evalFull('data/okx_btcusdt_swap_tv_15m_6k.json'),
    binanceBtc12m: fs.existsSync(path.join(ROOT_DIR, 'data/btcusdt_15m_12m.json')) ? evalFull('data/btcusdt_15m_12m.json') : null,
    binanceBtcTv6k: fs.existsSync(path.join(ROOT_DIR, 'data/btcusdt_tv_15m_6k.json')) ? evalFull('data/btcusdt_tv_15m_6k.json') : null,
    binanceEth6m: fs.existsSync(path.join(ROOT_DIR, 'data/ethusdt_15m_6m.json')) ? evalFull('data/ethusdt_15m_6m.json') : null,
  };

  const lockPayload = {
    schema: 'smc-v4-15m-lock-v4',
    lockedAt: new Date().toISOString(),
    winner: {
      id: winner.id,
      sig: winner.sig,
      execOptions: winner.execOptions,
      fullSpec: winner.fullSpec,
      plateauStats: {
        strictPassRate: chosenPlateau.strictPassRate,
        midPassRate: chosenPlateau.midPassRate,
        medNet: chosenPlateau.medNet,
        medPf: chosenPlateau.medPf,
        medWr: chosenPlateau.medWr,
        medMinHPf: chosenPlateau.medMinHPf,
      },
      calValMetrics: { cal: winner.cal, val: winner.val, calVal: winner.calVal, h1ToH4: winner.hSlices, noBeCalVal: winner.noBeCalVal },
    },
    plateauRankings: plateauSummaries.map(p => ({
      seedId: p.seed.id,
      plateauScore: p.plateauScore,
      strictPassRate: p.strictPassRate,
      midPassRate: p.midPassRate,
      medWr: p.medWr,
      medPf: p.medPf,
      medNet: p.medNet,
      medMinHPf: p.medMinHPf,
    })),
    unsealedEvaluation: unsealed,
  };
  fs.writeFileSync(path.join(RESULTS_DIR, 'lock_15m_r4.json'), JSON.stringify(lockPayload, null, 2) + '\n');

  console.log('\n[search_15m_v4_r4] UNSEALED RESULTS ON ROUND-4 WINNER:');
  for (const [k, v] of Object.entries(unsealed)) {
    if (!v) continue;
    const f = v.full;
    console.log(`  ${k}: n=${f.count} WR=${f.winRatePct}% PF=${f.profitFactor} Net=${f.totalNetPct}% (comp=${f.compoundedNetPct}%) DD=${f.maxDrawdownPct}% B/S=${f.buyWinRatePct}/${f.sellWinRatePct} noBePF=${v.noBe.profitFactor}`);
    if (v.yearly) {
      for (const y of v.yearly) {
        console.log(`    Year ${y.year}: n=${y.count} WR=${y.winRatePct}% PF=${y.profitFactor} Net=${y.totalNetPct}% DD=${y.maxDrawdownPct}%`);
      }
    }
  }
  return lockPayload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSearch15mV4R4();
}
