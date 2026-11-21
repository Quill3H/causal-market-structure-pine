import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTrades } from './sim_engine.mjs';
import { DEFAULT_WARMUP_1H, sliceDatasetPrefix1h } from './signals_1h.mjs';
import { generateSignals1hV4, precompute1hV4 } from './signals_1h_v4.mjs';
import { summarizeTradesSlice } from './search_15m_v4_r3.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results_v4');

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function eval1hCandidate(calValDs, pre, sig, ex, bounds) {
  const { calEnd, valEnd } = bounds;
  const rows = calValDs.rows;
  const entryMode = (sig.limitOffsetAtr ?? 0) > 0 ? 'LIMIT_PULLBACK' : 'MARKET_NEXT_OPEN';
  const virtExec = {
    entryMode,
    limitExpiryBars: ex.limitExpiryBars ?? 6,
    pendingPolicy: ex.pendingPolicy ?? 'ignore',
    limitSameBarTp: 'close',
    warmup: DEFAULT_WARMUP_1H,
    costPct: 0.10,
    slippagePct: 0.025,
    ...ex,
  };
  const fullSpec = { ...sig, virtExec };
  const signals = generateSignals1hV4(calValDs, fullSpec, pre);
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
  if (calVal.winRatePct >= 65.0 && calVal.profitFactor >= 1.25) {
    const noBeSim = simulateTrades(rows, signals, {
      ...opts, start: 0, end: valEnd, beTriggerR: 0, lock2TriggerR: 0, trailTriggerR: 0,
    });
    noBeCalVal = summarizeTradesSlice(noBeSim.trades, rows, 0, valEnd);
  }
  const noBePf = noBeCalVal?.profitFactor ?? 0;

  const eligibleStrict =
    calVal.count >= 165 &&
    cal.count >= 100 &&
    val.count >= 40 &&
    cal.winRatePct >= 67.0 &&
    val.winRatePct >= 66.0 &&
    calVal.winRatePct >= 67.5 &&
    cal.profitFactor >= 1.35 &&
    val.profitFactor >= 1.30 &&
    calVal.profitFactor >= 1.40 &&
    minHWr >= 63.0 &&
    minHPf >= 1.05 &&
    minHNet > 0 &&
    noBePf >= 1.15 &&
    minSideWr >= 63.0 &&
    calVal.buyNetPct > 0 &&
    calVal.sellNetPct > 0;

  const eligibleMid =
    calVal.count >= 150 &&
    cal.winRatePct >= 65.5 &&
    val.winRatePct >= 65.0 &&
    calVal.winRatePct >= 66.0 &&
    cal.profitFactor >= 1.25 &&
    val.profitFactor >= 1.20 &&
    minHWr >= 60.0 &&
    minHPf >= 1.00 &&
    noBePf >= 1.08 &&
    minSideWr >= 60.0 &&
    calVal.buyNetPct > 0 &&
    calVal.sellNetPct > 0;

  const score =
    calVal.totalNetPct * 1.1 +
    (calVal.wilsonLower95Pct - 60) * 3.0 +
    (calVal.profitFactor - 1) * 55 +
    calVal.retToDd * 12 +
    (minHPf - 1) * 45 +
    (noBePf - 1) * 35;

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

export function runSearch1hV4R4() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const fullSpot = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'okx_btcusdt_1h_3y.json'), 'utf8'));
  const N = fullSpot.rows.length;
  const calEnd = Math.floor(N * 0.5);
  const valEnd = Math.floor((N * 2) / 3);
  const calValDs = sliceDatasetPrefix1h(fullSpot, valEnd);
  const preCalVal = precompute1hV4(calValDs);

  const signalTemplates = [
    { tag: 'MT_N20_P10_off0.18_w6', rawFamily: 'MultiTrap', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, htfMode: 'H4_50', limitOffsetAtr: 0.18, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'MT_N20_P10_off0.14_w6', rawFamily: 'MultiTrap', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, htfMode: 'H4_50', limitOffsetAtr: 0.14, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'MT_N20_P10_H4_20or50_off0.16_w6', rawFamily: 'MultiTrap', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, htfMode: 'H4_20_or_50', limitOffsetAtr: 0.16, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'MT_N16_P8_off0.16_w6', rawFamily: 'MultiTrap', lookback: 16, p4Lookback: 8, trapMaxBars: 4, includePdhl: true, htfMode: 'H4_50', limitOffsetAtr: 0.16, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'MT_N20_P10_ANY_off0.16_w6', rawFamily: 'MultiTrap', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, htfMode: 'ANY', limitOffsetAtr: 0.16, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'DT_10_20_off0.16_w7', rawFamily: 'DualTrap', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, fastLookback: 10, fastP4Lookback: 6, fastTrapMaxBars: 3, htfMode: 'H4_50', limitOffsetAtr: 0.16, adaptive: true, winLen: 7, slThresh: 2, requireNegNet: true },
    { tag: 'DT_12_20_H4or20_off0.16_w6', rawFamily: 'DualTrap', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, fastLookback: 12, fastP4Lookback: 8, fastTrapMaxBars: 3, htfMode: 'H4_20_or_50', limitOffsetAtr: 0.16, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'CompTrap_Sq14_off0.16_w7', rawFamily: 'CompositeTrapPlusTrend', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, h4DispEnable: false, pbEnable: false, sqEnable: true, sqLookback: 14, squeezeRatio: 0.90, sqRvol: 1.1, sqBodyAtr: 0.40, htfMode: 'H4_50', limitOffsetAtr: 0.16, adaptive: true, winLen: 7, slThresh: 2, requireNegNet: true },
    { tag: 'CompTrap_H4Close_off0.16_w6', rawFamily: 'CompositeTrapPlusTrend', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, h4DispEnable: true, h4BodyAtrMin: 0.9, h4ClosePosMin: 0.60, pbEnable: false, sqEnable: false, htfMode: 'H4_50', limitOffsetAtr: 0.16, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
  ];

  // Explore intermediate RR (1.25 .. 1.85) + higher minStop (1.6 .. 2.4) + richer BE offset & Lock2 + pendingPolicy!
  const execTemplates = [];
  for (const stopAtr of [3.2, 3.8, 4.4]) {
    for (const minStopPct of [1.5, 2.0, 2.5]) {
      for (const rewardRisk of [1.25, 1.45, 1.70]) {
        for (const cooldown of [2, 4]) {
          // BE+ richer offset
          execTemplates.push({
            etag: `s${stopAtr}_m${minStopPct}_rr${rewardRisk}_be0.45_o0.48_cd${cooldown}`,
            stopAtr, minStopPct, rewardRisk, maxHoldBars: 144,
            beTriggerR: 0.45, beOffsetPct: 0.48, lock2TriggerR: 0, lock2OffsetR: 0, trailTriggerR: 0, trailAtrMult: 0, cooldown,
          });
          // BE+ high offset + Lock2 moderate
          execTemplates.push({
            etag: `s${stopAtr}_m${minStopPct}_rr${rewardRisk}_be0.43_o0.40_l2_0.90_0.55_cd${cooldown}`,
            stopAtr, minStopPct, rewardRisk, maxHoldBars: 144,
            beTriggerR: 0.43, beOffsetPct: 0.40, lock2TriggerR: 0.90, lock2OffsetR: 0.55, trailTriggerR: 0, trailAtrMult: 0, cooldown,
          });
        }
      }
    }
  }

  console.log(`[search_1h_v4_r4] Stage A: evaluating ${signalTemplates.length * execTemplates.length} candidates on Cal+Val...`);
  const stageA = [];
  for (const sig of signalTemplates) {
    for (const ex of execTemplates) {
      stageA.push(eval1hCandidate(calValDs, preCalVal, sig, ex, { calEnd, valEnd }));
    }
  }
  stageA.sort((a, b) => {
    if (a.eligibleStrict !== b.eligibleStrict) return a.eligibleStrict ? -1 : 1;
    if (a.eligibleMid !== b.eligibleMid) return a.eligibleMid ? -1 : 1;
    return b.score - a.score;
  });

  console.log(`[search_1h_v4_r4] Stage A done: strict=${stageA.filter(x => x.eligibleStrict).length}, mid=${stageA.filter(x => x.eligibleMid).length}`);
  for (const r of stageA.slice(0, 15)) {
    const tag = r.eligibleStrict ? 'STRICT' : r.eligibleMid ? 'MID   ' : 'MISS  ';
    console.log(`  [${tag}] ${r.id} | n=${r.calVal.count} WR=${r.calVal.winRatePct}% PF=${r.calVal.profitFactor} Net=${r.calVal.totalNetPct}% DD=${r.calVal.maxDrawdownPct}% B/S=${r.calVal.buyWinRatePct}/${r.calVal.sellWinRatePct} noBePF=${r.noBePf} minH=${r.minHWr}%/${r.minHPf}`);
  }

  // Stage B: Plateau neighborhood stability check on Cal+Val
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
    const stopAtrs = [Math.max(2.8, Number((e.stopAtr - 0.3).toFixed(1))), e.stopAtr, Number((e.stopAtr + 0.3).toFixed(1))];
    const minStops = [Math.max(1.2, Number((e.minStopPct - 0.2).toFixed(1))), e.minStopPct, Number((e.minStopPct + 0.2).toFixed(1))];
    const rrs = [Math.max(1.10, Number((e.rewardRisk - 0.15).toFixed(2))), e.rewardRisk, Number((e.rewardRisk + 0.15).toFixed(2))];
    const neighbors = [];
    for (const sAtr of stopAtrs) {
      for (const mStop of minStops) {
        for (const rr of rrs) {
          const exN = { ...e, stopAtr: sAtr, minStopPct: mStop, rewardRisk: rr, etag: `s${sAtr}_m${mStop}_rr${rr}_cd${e.cooldown}` };
          neighbors.push(eval1hCandidate(calValDs, preCalVal, cand.sig, exN, { calEnd, valEnd }));
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
  console.log('\n[search_1h_v4_r4] Stage B Plateau Rankings (Cal+Val only):');
  for (const p of plateauSummaries) {
    console.log(`  seed=${p.seed.id} | plateauScore=${p.plateauScore} strictNbr=${(p.strictPassRate*100).toFixed(0)}% midNbr=${(p.midPassRate*100).toFixed(0)}% medWR=${p.medWr}% medPF=${p.medPf} medNet=${p.medNet}% medMinHPF=${p.medMinHPf}`);
  }

  const chosenPlateau = plateauSummaries[0];
  const validNeighbors = chosenPlateau.neighbors.filter(n => n.eligibleStrict || n.eligibleMid);
  validNeighbors.sort((a, b) => b.score - a.score);
  const winner = validNeighbors[0] ?? chosenPlateau.seed;

  console.log(`\n[search_1h_v4_r4] LOCKING ROUND-4 WINNER: ${winner.id}`);
  console.log(`  Cal: n=${winner.cal.count} WR=${winner.cal.winRatePct}% PF=${winner.cal.profitFactor} Net=${winner.cal.totalNetPct}%`);
  console.log(`  Val: n=${winner.val.count} WR=${winner.val.winRatePct}% PF=${winner.val.profitFactor} Net=${winner.val.totalNetPct}%`);
  console.log(`  CalVal: n=${winner.calVal.count} WR=${winner.calVal.winRatePct}% PF=${winner.calVal.profitFactor} Net=${winner.calVal.totalNetPct}% (comp=${winner.calVal.compoundedNetPct}%) DD=${winner.calVal.maxDrawdownPct}% noBePF=${winner.noBePf}`);

  const evalFull = (relPath) => {
    const ds = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8'));
    const sigs = generateSignals1hV4(ds, winner.fullSpec);
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
      yearly: ds.rows.length >= 26000 ? [0, 1, 2].map(y => {
        const st = y * Math.floor(ds.rows.length / 3);
        const en = y === 2 ? ds.rows.length : (y + 1) * Math.floor(ds.rows.length / 3);
        return { year: y + 1, ...summarizeTradesSlice(fullSim.trades, ds.rows, st, en) };
      }) : undefined,
      semiAnnual: ds.rows.length >= 26000 ? [0, 1, 2, 3, 4, 5].map(h => {
        const st = h * Math.floor(ds.rows.length / 6);
        const en = h === 5 ? ds.rows.length : (h + 1) * Math.floor(ds.rows.length / 6);
        return { half: h + 1, ...summarizeTradesSlice(fullSim.trades, ds.rows, st, en) };
      }) : undefined,
    };
  };

  const unsealed = {
    okxSpot3y: evalFull('data/okx_btcusdt_1h_3y.json'),
    okxSwap3y: evalFull('data/okx_btcusdt_swap_1h_3y.json'),
    okxSpotTv6k: evalFull('data/okx_btcusdt_tv_1h_6k.json'),
    okxSwapTv6k: evalFull('data/okx_btcusdt_swap_tv_1h_6k.json'),
    binanceBtc24m: fs.existsSync(path.join(ROOT_DIR, 'data/btcusdt_1h_24m.json')) ? evalFull('data/btcusdt_1h_24m.json') : null,
    binanceBtcTv6k: fs.existsSync(path.join(ROOT_DIR, 'data/btcusdt_tv_1h_6k.json')) ? evalFull('data/btcusdt_tv_1h_6k.json') : null,
    binanceEth12m: fs.existsSync(path.join(ROOT_DIR, 'data/ethusdt_1h_12m.json')) ? evalFull('data/ethusdt_1h_12m.json') : null,
  };

  const lockPayload = {
    schema: 'smc-v4-1h-lock-v4',
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
  fs.writeFileSync(path.join(RESULTS_DIR, 'lock_1h_r4.json'), JSON.stringify(lockPayload, null, 2) + '\n');

  console.log('\n[search_1h_v4_r4] UNSEALED RESULTS ON ROUND-4 WINNER:');
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
  runSearch1hV4R4();
}
