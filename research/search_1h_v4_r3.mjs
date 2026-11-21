import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTrades } from './sim_engine.mjs';
import { DEFAULT_WARMUP_1H, sliceDatasetPrefix1h } from './signals_1h.mjs';
import { generateSignals1hV4, precompute1hV4 } from './signals_1h_v4.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results_v4');
const EPS = 1e-12;

function summarize(sim, rows, startIdx, endIdx) {
  let buyCount = 0;
  let buyWins = 0;
  let buyNet = 0;
  let sellCount = 0;
  let sellWins = 0;
  let sellNet = 0;
  let equity = 1.0;
  for (const t of sim.trades) {
    equity *= (1 + t.netPct / 100);
    if (t.side === 1) {
      buyCount++;
      buyNet += t.netPct;
      if (t.netPct > EPS) buyWins++;
    } else if (t.side === -1) {
      sellCount++;
      sellNet += t.netPct;
      if (t.netPct > EPS) sellWins++;
    }
  }
  const count = sim.count;
  const winRatePct = count ? (sim.wins / count) * 100 : 0;
  const pf = sim.profitFactor ?? (sim.wins > 0 ? 99 : 0);
  const dd = sim.maxDrawdownPct;
  return {
    range: [startIdx, endIdx],
    firstIso: new Date(rows[startIdx].time * 1000).toISOString(),
    lastIso: new Date(rows[endIdx - 1].time * 1000).toISOString(),
    count,
    wins: sim.wins,
    losses: sim.losses,
    ties: sim.ties,
    winRatePct: Number(winRatePct.toFixed(4)),
    wilsonLower95Pct: Number((sim.wilsonLower95Pct ?? 0).toFixed(4)),
    profitFactor: Number(pf.toFixed(4)),
    totalNetPct: Number(sim.totalNetPct.toFixed(4)),
    compoundedNetPct: Number(((equity - 1) * 100).toFixed(4)),
    meanNetPct: Number((sim.meanNetPct ?? 0).toFixed(4)),
    meanGrossPct: Number((sim.meanGrossPct ?? 0).toFixed(4)),
    maxDrawdownPct: Number(dd.toFixed(4)),
    retToDd: Number((dd > 0 ? sim.totalNetPct / dd : 0).toFixed(3)),
    exitReasons: sim.exitReasons,
    buyCount,
    buyWins,
    buyWinRatePct: buyCount ? Number(((buyWins / buyCount) * 100).toFixed(2)) : 0,
    buyNetPct: Number(buyNet.toFixed(4)),
    sellCount,
    sellWins,
    sellWinRatePct: sellCount ? Number(((sellWins / sellCount) * 100).toFixed(2)) : 0,
    sellNetPct: Number(sellNet.toFixed(4)),
  };
}

function evalConfigCalVal(calValDs, pre, sig, ex, bounds) {
  const { calEnd, valEnd } = bounds;
  const rows = calValDs.rows;
  const entryMode = (sig.limitOffsetAtr ?? 0) > 0 ? 'LIMIT_PULLBACK' : 'MARKET_NEXT_OPEN';
  const virtExec = {
    entryMode,
    limitExpiryBars: 6,
    pendingPolicy: 'ignore',
    limitSameBarTp: 'close',
    warmup: DEFAULT_WARMUP_1H,
    costPct: 0.10,
    slippagePct: 0.025,
    ...ex,
  };
  const fullSpec = { ...sig, virtExec };
  const signals = generateSignals1hV4(calValDs, fullSpec, pre);
  const opts = { ...virtExec, intervalSeconds: calValDs.intervalSeconds };

  const cal = summarize(simulateTrades(rows, signals, { ...opts, start: 0, end: calEnd }), rows, 0, calEnd);
  const val = summarize(simulateTrades(rows, signals, { ...opts, start: calEnd, end: valEnd }), rows, calEnd, valEnd);
  const calVal = summarize(simulateTrades(rows, signals, { ...opts, start: 0, end: valEnd }), rows, 0, valEnd);

  const hStep = Math.floor(valEnd / 4);
  const hSlices = [];
  for (let s = 0; s < 4; s++) {
    const st = s * hStep;
    const en = s === 3 ? valEnd : (s + 1) * hStep;
    hSlices.push({ label: `H${s + 1}`, ...summarize(simulateTrades(rows, signals, { ...opts, start: st, end: en }), rows, st, en) });
  }
  const noBeCalVal = summarize(
    simulateTrades(rows, signals, { ...opts, start: 0, end: valEnd, beTriggerR: 0, lock2TriggerR: 0, trailTriggerR: 0 }),
    rows, 0, valEnd,
  );

  const minHWr = Math.min(...hSlices.map(h => h.winRatePct));
  const minHPf = Math.min(...hSlices.map(h => h.profitFactor));
  const minHNet = Math.min(...hSlices.map(h => h.totalNetPct));
  const minSideWr = Math.min(calVal.buyWinRatePct, calVal.sellWinRatePct);

  const eligibleStrict =
    calVal.count >= 160 &&
    cal.count >= 100 &&
    val.count >= 40 &&
    cal.winRatePct >= 66.0 &&
    val.winRatePct >= 65.0 &&
    calVal.winRatePct >= 66.5 &&
    cal.profitFactor >= 1.35 &&
    val.profitFactor >= 1.30 &&
    calVal.profitFactor >= 1.40 &&
    minHWr >= 62.0 &&
    minHPf >= 1.05 &&
    minHNet > 0 &&
    noBeCalVal.profitFactor >= 1.18 &&
    minSideWr >= 62.0 &&
    calVal.buyNetPct > 0 &&
    calVal.sellNetPct > 0;

  const eligibleRelaxed =
    calVal.count >= 145 &&
    cal.winRatePct >= 65.0 &&
    val.winRatePct >= 65.0 &&
    cal.profitFactor >= 1.25 &&
    val.profitFactor >= 1.25 &&
    minHWr >= 60.0 &&
    minHPf >= 1.0 &&
    noBeCalVal.profitFactor >= 1.12 &&
    minSideWr >= 58.0;

  const score =
    calVal.totalNetPct * 1.1 +
    (calVal.wilsonLower95Pct - 60) * 3.0 +
    (calVal.profitFactor - 1) * 55 +
    calVal.retToDd * 10 +
    (minHPf - 1) * 45 +
    (noBeCalVal.profitFactor - 1) * 35;

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
    minHWr,
    minHPf,
    minSideWr,
    eligibleStrict,
    eligibleRelaxed,
    score: Number(score.toFixed(3)),
  };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function runSearch1hV4R3() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const fullSpot = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'okx_btcusdt_1h_3y.json'), 'utf8'));
  const N = fullSpot.rows.length;
  const calEnd = Math.floor(N * 0.5);
  const valEnd = Math.floor((N * 2) / 3);
  const calValDs = sliceDatasetPrefix1h(fullSpot, valEnd);
  const preCalVal = precompute1hV4(calValDs);

  const signalTemplates = [
    { tag: 'MultiTrap_N20_P10_off0.16_w6', rawFamily: 'MultiTrap', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, htfMode: 'H4_50', limitOffsetAtr: 0.16, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'MultiTrap_N20_P10_off0.10_w6', rawFamily: 'MultiTrap', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, htfMode: 'H4_50', limitOffsetAtr: 0.10, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'MultiTrap_N16_P8_off0.14_w6', rawFamily: 'MultiTrap', lookback: 16, p4Lookback: 8, trapMaxBars: 4, includePdhl: true, htfMode: 'H4_50', limitOffsetAtr: 0.14, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'DualTrap_10_20_off0.14_w7', rawFamily: 'DualTrap', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, fastLookback: 10, fastP4Lookback: 6, fastTrapMaxBars: 3, htfMode: 'H4_50', limitOffsetAtr: 0.14, adaptive: true, winLen: 7, slThresh: 2, requireNegNet: true },
    { tag: 'DualTrap_12_20_off0.12_w6', rawFamily: 'DualTrap', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, fastLookback: 12, fastP4Lookback: 8, fastTrapMaxBars: 3, htfMode: 'H4_20_or_50', limitOffsetAtr: 0.12, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'H4DispCloseOnly_0.85_off0.15_w6', rawFamily: 'H4Disp', h4BodyAtrMin: 0.85, h4ClosePosMin: 0.58, onH4CloseOnly: true, htfMode: 'H4_50', limitOffsetAtr: 0.15, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true },
    { tag: 'CompTrap_H4Close_off0.15_w7', rawFamily: 'CompositeTrapPlusTrend', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, h4DispEnable: true, h4BodyAtrMin: 0.9, h4ClosePosMin: 0.60, pbEnable: false, sqEnable: false, htfMode: 'H4_50', limitOffsetAtr: 0.15, adaptive: true, winLen: 7, slThresh: 2, requireNegNet: true },
    { tag: 'CompTrap_Sq14_off0.15_w7', rawFamily: 'CompositeTrapPlusTrend', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, h4DispEnable: false, pbEnable: false, sqEnable: true, sqLookback: 14, squeezeRatio: 0.90, sqRvol: 1.1, sqBodyAtr: 0.40, htfMode: 'H4_50', limitOffsetAtr: 0.15, adaptive: true, winLen: 7, slThresh: 2, requireNegNet: true },
    { tag: 'CompTrap_Pb_H4Close_off0.15_w8', rawFamily: 'CompositeTrapPlusTrend', lookback: 20, p4Lookback: 10, trapMaxBars: 4, includePdhl: true, h4DispEnable: true, h4BodyAtrMin: 0.95, h4ClosePosMin: 0.60, pbEnable: true, pbTouchAtr: 0.20, pbBodyAtr: 0.55, pbRsiMax: 68, sqEnable: false, htfMode: 'H4_50', limitOffsetAtr: 0.15, adaptive: true, winLen: 8, slThresh: 3, requireNegNet: true },
  ];

  const execTemplates = [];
  for (const stopAtr of [3.2, 3.6, 4.0]) {
    for (const minStopPct of [1.4, 1.7]) {
      for (const rewardRisk of [1.8, 2.2, 2.8]) {
        for (const cooldown of [2, 4]) {
          execTemplates.push({
            etag: `s${stopAtr}_m${minStopPct}_rr${rewardRisk}_be0.50_o0.55_cd${cooldown}`,
            stopAtr, minStopPct, rewardRisk, maxHoldBars: 192,
            beTriggerR: 0.50, beOffsetPct: 0.55,
            lock2TriggerR: 0, lock2OffsetR: 0, trailTriggerR: 0, trailAtrMult: 0, cooldown,
          });
          execTemplates.push({
            etag: `s${stopAtr}_m${minStopPct}_rr${rewardRisk}_l2_1.1_0.65_cd${cooldown}`,
            stopAtr, minStopPct, rewardRisk, maxHoldBars: 192,
            beTriggerR: 0.48, beOffsetPct: 0.45,
            lock2TriggerR: 1.1, lock2OffsetR: 0.65, trailTriggerR: 0, trailAtrMult: 0, cooldown,
          });
          execTemplates.push({
            etag: `s${stopAtr}_m${minStopPct}_rr${rewardRisk}_tr1.0_2.5_cd${cooldown}`,
            stopAtr, minStopPct, rewardRisk, maxHoldBars: 192,
            beTriggerR: 0.48, beOffsetPct: 0.45,
            lock2TriggerR: 0, lock2OffsetR: 0, trailTriggerR: 1.0, trailAtrMult: 2.5, cooldown,
          });
        }
      }
    }
  }

  console.log(`[search_1h_v4_r3] Stage A: evaluating ${signalTemplates.length * execTemplates.length} candidates on truncated Cal+Val...`);
  const stageA = [];
  for (const sig of signalTemplates) {
    for (const ex of execTemplates) {
      stageA.push(evalConfigCalVal(calValDs, preCalVal, sig, ex, { calEnd, valEnd }));
    }
  }
  stageA.sort((a, b) => {
    if (a.eligibleStrict !== b.eligibleStrict) return a.eligibleStrict ? -1 : 1;
    if (a.eligibleRelaxed !== b.eligibleRelaxed) return a.eligibleRelaxed ? -1 : 1;
    return b.score - a.score;
  });

  console.log(`[search_1h_v4_r3] Stage A done: strict=${stageA.filter(x => x.eligibleStrict).length}, relaxed=${stageA.filter(x => x.eligibleRelaxed).length}`);
  for (const r of stageA.slice(0, 15)) {
    const tag = r.eligibleStrict ? 'STRICT' : r.eligibleRelaxed ? 'RELAX ' : 'MISS  ';
    console.log(`  [${tag}] ${r.id} | n=${r.calVal.count} WR=${r.calVal.winRatePct}% PF=${r.calVal.profitFactor} Net=${r.calVal.totalNetPct}% DD=${r.calVal.maxDrawdownPct}% B/S=${r.calVal.buyWinRatePct}/${r.calVal.sellWinRatePct} noBePF=${r.noBeCalVal.profitFactor} minH=${r.minHWr}%/${r.minHPf}`);
  }

  // Stage B: Plateau verification around top 8 distinct signal+lock archetypes (Cal+Val only!)
  const seedPool = stageA.filter(x => x.eligibleStrict || x.eligibleRelaxed);
  const finalPool = seedPool.length > 0 ? seedPool : stageA;
  const distinctArchetypes = [];
  for (const cand of finalPool) {
    const archKey = `${cand.sig.tag}|l2=${cand.execOptions.lock2TriggerR}|tr=${cand.execOptions.trailTriggerR}`;
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
    const rrs = [Math.max(1.4, Number((e.rewardRisk - 0.3).toFixed(1))), e.rewardRisk, Number((e.rewardRisk + 0.3).toFixed(1))];
    const neighbors = [];
    for (const sAtr of stopAtrs) {
      for (const mStop of minStops) {
        for (const rr of rrs) {
          const exN = { ...e, stopAtr: sAtr, minStopPct: mStop, rewardRisk: rr, etag: `s${sAtr}_m${mStop}_rr${rr}_cd${e.cooldown}` };
          neighbors.push(evalConfigCalVal(calValDs, preCalVal, cand.sig, exN, { calEnd, valEnd }));
        }
      }
    }
    const strictPassRate = neighbors.filter(n => n.eligibleStrict).length / neighbors.length;
    const relaxPassRate = neighbors.filter(n => n.eligibleRelaxed).length / neighbors.length;
    const medNet = median(neighbors.map(n => n.calVal.totalNetPct));
    const medPf = median(neighbors.map(n => n.calVal.profitFactor));
    const medWr = median(neighbors.map(n => n.calVal.winRatePct));
    const medMinHPf = median(neighbors.map(n => n.minHPf));
    const medScore = median(neighbors.map(n => n.score));
    const plateauScore = 0.5 * cand.score + 0.5 * medScore + strictPassRate * 60 + relaxPassRate * 25;
    plateauSummaries.push({
      seed: cand,
      neighborsCount: neighbors.length,
      strictPassRate: Number(strictPassRate.toFixed(3)),
      relaxPassRate: Number(relaxPassRate.toFixed(3)),
      medNet: Number(medNet.toFixed(2)),
      medPf: Number(medPf.toFixed(3)),
      medWr: Number(medWr.toFixed(2)),
      medMinHPf: Number(medMinHPf.toFixed(3)),
      plateauScore: Number(plateauScore.toFixed(2)),
      neighbors,
    });
  }

  plateauSummaries.sort((a, b) => b.plateauScore - a.plateauScore);
  console.log('\n[search_1h_v4_r3] Stage B Plateau Rankings (Cal+Val only):');
  for (const p of plateauSummaries) {
    console.log(`  seed=${p.seed.id} | plateauScore=${p.plateauScore} strictNbr=${(p.strictPassRate*100).toFixed(0)}% relaxNbr=${(p.relaxPassRate*100).toFixed(0)}% medWR=${p.medWr}% medPF=${p.medPf} medNet=${p.medNet}% medMinHPF=${p.medMinHPf}`);
  }

  const chosenPlateau = plateauSummaries[0];
  // Choose center or best-plateau-consistent neighbor within eligible set of chosenPlateau
  const validNeighbors = chosenPlateau.neighbors.filter(n => n.eligibleStrict || n.eligibleRelaxed);
  validNeighbors.sort((a, b) => b.score - a.score);
  const winner = validNeighbors[0] ?? chosenPlateau.seed;

  console.log(`\n[search_1h_v4_r3] LOCKING ROUND-3 WINNER: ${winner.id}`);
  console.log(`  Cal: n=${winner.cal.count} WR=${winner.cal.winRatePct}% PF=${winner.cal.profitFactor} Net=${winner.cal.totalNetPct}%`);
  console.log(`  Val: n=${winner.val.count} WR=${winner.val.winRatePct}% PF=${winner.val.profitFactor} Net=${winner.val.totalNetPct}%`);
  console.log(`  CalVal: n=${winner.calVal.count} WR=${winner.calVal.winRatePct}% PF=${winner.calVal.profitFactor} Net=${winner.calVal.totalNetPct}% (comp=${winner.calVal.compoundedNetPct}%) DD=${winner.calVal.maxDrawdownPct}% noBePF=${winner.noBeCalVal.profitFactor}`);

  // Unseal Holdout + Cross-Exchange + Cross-Market
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
      full: summarize(fullSim, ds.rows, 0, ds.rows.length),
      noBe: summarize(noBeSim, ds.rows, 0, ds.rows.length),
      yearly: ds.rows.length >= 26000 ? [0, 1, 2].map(y => {
        const st = y * Math.floor(ds.rows.length / 3);
        const en = y === 2 ? ds.rows.length : (y + 1) * Math.floor(ds.rows.length / 3);
        return { year: y + 1, ...summarize(simulateTrades(ds.rows, sigs, { ...opts, start: st, end: en }), ds.rows, st, en) };
      }) : undefined,
      semiAnnual: ds.rows.length >= 26000 ? [0, 1, 2, 3, 4, 5].map(h => {
        const st = h * Math.floor(ds.rows.length / 6);
        const en = h === 5 ? ds.rows.length : (h + 1) * Math.floor(ds.rows.length / 6);
        return { half: h + 1, ...summarize(simulateTrades(ds.rows, sigs, { ...opts, start: st, end: en }), ds.rows, st, en) };
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
    schema: 'smc-v4-1h-lock-v2',
    lockedAt: new Date().toISOString(),
    winner: {
      id: winner.id,
      sig: winner.sig,
      execOptions: winner.execOptions,
      fullSpec: winner.fullSpec,
      plateauStats: {
        strictPassRate: chosenPlateau.strictPassRate,
        relaxPassRate: chosenPlateau.relaxPassRate,
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
      relaxPassRate: p.relaxPassRate,
      medWr: p.medWr,
      medPf: p.medPf,
      medNet: p.medNet,
      medMinHPf: p.medMinHPf,
    })),
    unsealedEvaluation: unsealed,
  };
  fs.writeFileSync(path.join(RESULTS_DIR, 'lock_1h_r3.json'), JSON.stringify(lockPayload, null, 2) + '\n');

  console.log('\n[search_1h_v4_r3] UNSEALED RESULTS ON ROUND-3 WINNER:');
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
  runSearch1hV4R3();
}
