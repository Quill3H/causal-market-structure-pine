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
import { summarizeSlice } from './search_1h_v4.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const RESULTS_DIR = path.join(HERE, 'results_v4');

function buildRound1Specs15m() {
  const specs = [];

  const signalTemplates = [
    // Family 1: M15 MultiTrap (LTF + H1 + H4 traps) + Adaptive Polarity
    {
      tag: 'M15_Trap_N32_H1_12_H4_8_adp',
      rawFamily: 'M15_MultiTrap', ltfLookback: 32, h1Lookback: 12, h4Lookback: 8, trapMaxBars: 4,
      htfMode: 'H4_50', minAtrPct: 0.18, pullAtr: 0.35, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true,
    },
    {
      tag: 'M15_Trap_H1_16_H4_10_adp',
      rawFamily: 'M15_MultiTrap', ltfLookback: null, h1Lookback: 16, h4Lookback: 10, trapMaxBars: 4,
      htfMode: 'H4_50', minAtrPct: 0.18, pullAtr: 0.35, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true,
    },
    {
      tag: 'M15_Trap_LTF48_H1_16_mkt',
      rawFamily: 'M15_MultiTrap', ltfLookback: 48, h1Lookback: 16, h4Lookback: 8, trapMaxBars: 4,
      htfMode: 'H4_50', minAtrPct: 0.20, pullAtr: 0, adaptive: true, winLen: 7, slThresh: 2, requireNegNet: true,
    },
    {
      tag: 'M15_Trap_H1_16_H4_10_RAW',
      rawFamily: 'M15_MultiTrap', ltfLookback: null, h1Lookback: 16, h4Lookback: 10, trapMaxBars: 4,
      htfMode: 'H4_50_AND_H1_50', minAtrPct: 0.22, pullAtr: 0.35, adaptive: false,
    },
    // Family 2: M15 H1/H4 Liquidity Sweep & Reclaim
    {
      tag: 'M15_Sweep_H1_16_H4_8_adp',
      rawFamily: 'M15_H1H4_SweepReclaim', h1Lookback: 16, h4Lookback: 8, minBodyAtr: 0.3, closePosMin: 0.55,
      htfMode: 'H4_50', minAtrPct: 0.18, pullAtr: 0.35, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true,
    },
    {
      tag: 'M15_Sweep_H1_16_H4_8_RAW',
      rawFamily: 'M15_H1H4_SweepReclaim', h1Lookback: 16, h4Lookback: 8, minBodyAtr: 0.4, closePosMin: 0.60,
      htfMode: 'H4_50_AND_H1_50', minAtrPct: 0.20, pullAtr: 0.35, adaptive: false,
    },
    {
      tag: 'M15_Sweep_H4_6_RAW',
      rawFamily: 'M15_H1H4_SweepReclaim', h1Lookback: null, h4Lookback: 6, minBodyAtr: 0.3, closePosMin: 0.55,
      htfMode: 'H4_50', minAtrPct: 0.18, pullAtr: 0.25, adaptive: false,
    },
    // Family 3: M15 H4 Displacement + 15m Pullback (raw and adaptive)
    {
      tag: 'M15_H4Disp_0.8_H4Close_adp',
      rawFamily: 'M15_H4Disp', h4BodyAtrMin: 0.8, h4ClosePosMin: 0.58, onH4CloseOnly: true, requireLtfConfirm: false,
      htfMode: 'H4_50', minAtrPct: 0.15, pullAtr: 0.35, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true,
    },
    {
      tag: 'M15_H4Disp_0.9_LtfConf_adp',
      rawFamily: 'M15_H4Disp', h4BodyAtrMin: 0.9, h4ClosePosMin: 0.60, onH4CloseOnly: false, requireLtfConfirm: true,
      htfMode: 'H4_50_AND_H1_50', minAtrPct: 0.18, pullAtr: 0.40, adaptive: true, winLen: 7, slThresh: 2, requireNegNet: true,
    },
    {
      tag: 'M15_H4Disp_0.9_H4Close_mkt_adp',
      rawFamily: 'M15_H4Disp', h4BodyAtrMin: 0.9, h4ClosePosMin: 0.60, onH4CloseOnly: true, requireLtfConfirm: false,
      htfMode: 'H4_50', minAtrPct: 0.15, pullAtr: 0, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true,
    },
    {
      tag: 'M15_H4Disp_0.9_RAW',
      rawFamily: 'M15_H4Disp', h4BodyAtrMin: 0.9, h4ClosePosMin: 0.60, onH4CloseOnly: true, requireLtfConfirm: false,
      htfMode: 'H4_50', minAtrPct: 0.18, pullAtr: 0.35, adaptive: false,
    },
    // Family 4: M15 Squeeze Breakout
    {
      tag: 'M15_SqBrk_H1Sq_N24_RAW',
      rawFamily: 'M15_SqueezeBreak_HTF', sqLookback: 24, useH1Sq: true, h1SqRatio: 0.92, minRvol: 1.3, minBodyAtr: 0.5,
      htfMode: 'H4_50_AND_H1_50', minAtrPct: 0.18, pullAtr: 0.25, adaptive: false,
    },
    {
      tag: 'M15_SqBrk_LtfSq_N32_adp',
      rawFamily: 'M15_SqueezeBreak_HTF', sqLookback: 32, useH1Sq: false, ltfSqRatio: 0.88, minRvol: 1.4, minBodyAtr: 0.5,
      htfMode: 'H4_50', minAtrPct: 0.18, pullAtr: 0.25, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true,
    },
    // Family 5: Mean Reversion Band Reclaim
    {
      tag: 'M15_MeanRev_1.8_H4_adp',
      rawFamily: 'M15_MeanRev_BandReclaim', bandAtr: 1.8, rsiExt: 33,
      htfMode: 'H4_50', minAtrPct: 0.18, pullAtr: 0.25, adaptive: true, winLen: 6, slThresh: 2, requireNegNet: true,
    },
  ];

  const execTemplates = [
    { etag: 's4.5_m1.4_rr1.5_be0.48_o0.45_cd16', stopAtr: 4.5, minStopPct: 1.4, rewardRisk: 1.5, maxHoldBars: 160, beTriggerR: 0.48, beOffsetPct: 0.45, lock2TriggerR: 0, lock2OffsetR: 0, trailTriggerR: 0, trailAtrMult: 0, cooldown: 16 },
    { etag: 's5.5_m1.6_rr1.8_be0.48_o0.50_cd16', stopAtr: 5.5, minStopPct: 1.6, rewardRisk: 1.8, maxHoldBars: 192, beTriggerR: 0.48, beOffsetPct: 0.50, lock2TriggerR: 0, lock2OffsetR: 0, trailTriggerR: 0, trailAtrMult: 0, cooldown: 16 },
    { etag: 's6.0_m1.8_rr2.2_be0.50_o0.55_cd16', stopAtr: 6.0, minStopPct: 1.8, rewardRisk: 2.2, maxHoldBars: 224, beTriggerR: 0.50, beOffsetPct: 0.55, lock2TriggerR: 0, lock2OffsetR: 0, trailTriggerR: 0, trailAtrMult: 0, cooldown: 16 },
    { etag: 's5.5_m1.6_rr2.4_l2_1.1_0.65_cd12', stopAtr: 5.5, minStopPct: 1.6, rewardRisk: 2.4, maxHoldBars: 192, beTriggerR: 0.48, beOffsetPct: 0.45, lock2TriggerR: 1.1, lock2OffsetR: 0.65, trailTriggerR: 0, trailAtrMult: 0, cooldown: 12 },
    { etag: 's6.0_m1.8_rr2.6_l2_1.2_0.75_cd16', stopAtr: 6.0, minStopPct: 1.8, rewardRisk: 2.6, maxHoldBars: 240, beTriggerR: 0.50, beOffsetPct: 0.50, lock2TriggerR: 1.2, lock2OffsetR: 0.75, trailTriggerR: 0, trailAtrMult: 0, cooldown: 16 },
    { etag: 's5.5_m1.6_rr2.6_tr_1.0_3.2_cd16', stopAtr: 5.5, minStopPct: 1.6, rewardRisk: 2.6, maxHoldBars: 224, beTriggerR: 0.48, beOffsetPct: 0.45, lock2TriggerR: 0, lock2OffsetR: 0, trailTriggerR: 1.0, trailAtrMult: 3.2, cooldown: 16 },
    { etag: 's6.5_m2.0_rr2.2_be0.48_o0.55_cd12', stopAtr: 6.5, minStopPct: 2.0, rewardRisk: 2.2, maxHoldBars: 240, beTriggerR: 0.48, beOffsetPct: 0.55, lock2TriggerR: 0, lock2OffsetR: 0, trailTriggerR: 0, trailAtrMult: 0, cooldown: 12 },
  ];

  for (const sig of signalTemplates) {
    for (const ex of execTemplates) {
      const entryMode = (sig.pullAtr ?? 0) > 0 ? 'LIMIT_PULLBACK' : 'MARKET_NEXT_OPEN';
      const virtExec = {
        entryMode,
        limitExpiryBars: 12,
        pendingPolicy: 'ignore',
        limitSameBarTp: 'close',
        warmup: DEFAULT_WARMUP_15M,
        costPct: 0.10,
        slippagePct: 0.025,
        stopAtr: ex.stopAtr,
        minStopPct: ex.minStopPct,
        rewardRisk: ex.rewardRisk,
        maxHoldBars: ex.maxHoldBars,
        beTriggerR: ex.beTriggerR,
        beOffsetPct: ex.beOffsetPct,
        lock2TriggerR: ex.lock2TriggerR,
        lock2OffsetR: ex.lock2OffsetR,
        trailTriggerR: ex.trailTriggerR,
        trailAtrMult: ex.trailAtrMult,
        cooldown: ex.cooldown,
      };
      specs.push({
        id: `${sig.tag}|${ex.etag}`,
        sig,
        execOptions: virtExec,
        fullSpec: { ...sig, virtExec },
      });
    }
  }
  return specs;
}

function evaluateCandidateOnPrefix15m(prefixDs, precomputed, candidate, bounds) {
  const { calEnd, valEnd } = bounds;
  const rows = prefixDs.rows;
  const signals = generateSignals15mV4(prefixDs, candidate.fullSpec, precomputed);
  const baseOpts = { ...candidate.execOptions, intervalSeconds: prefixDs.intervalSeconds };

  const calSim = simulateTrades(rows, signals, { ...baseOpts, start: 0, end: calEnd });
  const valSim = simulateTrades(rows, signals, { ...baseOpts, start: calEnd, end: valEnd });
  const cvSim = simulateTrades(rows, signals, { ...baseOpts, start: 0, end: valEnd });

  const cal = summarizeSlice(calSim, rows, 0, calEnd);
  const val = summarizeSlice(valSim, rows, calEnd, valEnd);
  const calVal = summarizeSlice(cvSim, rows, 0, valEnd);

  const hStep = Math.floor(valEnd / 4);
  const hSlices = [];
  for (let s = 0; s < 4; s++) {
    const st = s * hStep;
    const en = s === 3 ? valEnd : (s + 1) * hStep;
    const sim = simulateTrades(rows, signals, { ...baseOpts, start: st, end: en });
    hSlices.push({ label: `H${s + 1}`, ...summarizeSlice(sim, rows, st, en) });
  }

  const noBeSim = simulateTrades(rows, signals, {
    ...baseOpts, start: 0, end: valEnd, beTriggerR: 0, lock2TriggerR: 0, trailTriggerR: 0,
  });
  const noBeCalVal = summarizeSlice(noBeSim, rows, 0, valEnd);

  const minHWr = Math.min(...hSlices.map(h => h.winRatePct));
  const minHPf = Math.min(...hSlices.map(h => h.profitFactor));
  const minHNet = Math.min(...hSlices.map(h => h.totalNetPct));
  const minSideWr = Math.min(calVal.buyWinRatePct, calVal.sellWinRatePct);

  const eligibleStrict =
    calVal.count >= 160 &&
    cal.count >= 100 &&
    val.count >= 40 &&
    cal.winRatePct >= 66.0 &&
    val.winRatePct >= 66.0 &&
    calVal.winRatePct >= 66.5 &&
    cal.profitFactor >= 1.25 &&
    val.profitFactor >= 1.25 &&
    minHWr >= 62.0 &&
    minHPf >= 1.05 &&
    minHNet > 0 &&
    noBeCalVal.profitFactor >= 1.05 &&
    minSideWr >= 60.0;

  const score =
    calVal.totalNetPct * 1.0 +
    (calVal.wilsonLower95Pct - 60) * 3.0 +
    (calVal.profitFactor - 1) * 55 +
    calVal.retToDd * 12 +
    (minHPf - 1) * 35 +
    (noBeCalVal.profitFactor - 1) * 40;

  return {
    id: candidate.id,
    sig: candidate.sig,
    execOptions: candidate.execOptions,
    fullSpec: candidate.fullSpec,
    signalCountCalVal: signals.length,
    cal,
    val,
    calVal,
    hSlices,
    noBeCalVal,
    minHWr,
    minHPf,
    minSideWr,
    eligibleStrict,
    score: Number(score.toFixed(3)),
  };
}

function buildRound2RefinementSpecs15m(topRound1) {
  const specs = [];
  const seen = new Set();
  const distinctTags = [];
  for (const r of topRound1) {
    if (!distinctTags.some(x => x.sig.tag === r.sig.tag)) {
      distinctTags.push(r);
    }
    if (distinctTags.length >= 3) break;
  }

  for (const seed of distinctTags) {
    const s = seed.sig;
    const e = seed.execOptions;
    const stopAtrs = [Math.max(4.0, Number((e.stopAtr - 0.5).toFixed(1))), e.stopAtr, Number((e.stopAtr + 0.5).toFixed(1))];
    const minStops = [Math.max(1.2, Number((e.minStopPct - 0.2).toFixed(1))), e.minStopPct, Number((e.minStopPct + 0.2).toFixed(1))];
    const rrs = [Math.max(1.3, Number((e.rewardRisk - 0.3).toFixed(1))), e.rewardRisk, Number((e.rewardRisk + 0.4).toFixed(1))];
    const bePairs = [
      [Number((e.beTriggerR - 0.03).toFixed(2)), e.beOffsetPct],
      [e.beTriggerR, e.beOffsetPct],
      [Number((e.beTriggerR + 0.04).toFixed(2)), Number((e.beOffsetPct + 0.1).toFixed(2))],
    ];
    const cooldowns = [e.cooldown, Math.min(28, e.cooldown + 4)];
    const winLens = s.adaptive ? [Math.max(5, s.winLen - 1), s.winLen, s.winLen + 1] : [6];

    for (const stopAtr of stopAtrs) {
      for (const minStopPct of minStops) {
        for (const rewardRisk of rrs) {
          for (const [beTriggerR, beOffsetPct] of bePairs) {
            for (const cooldown of cooldowns) {
              for (const winLen of winLens) {
                const sigMod = { ...s, winLen };
                const id = `R2:${s.tag}:w${winLen}|s${stopAtr}_m${minStopPct}_rr${rewardRisk}_be${beTriggerR}/${beOffsetPct}_l2${e.lock2TriggerR}/${e.lock2OffsetR}_tr${e.trailTriggerR}/${e.trailAtrMult}_cd${cooldown}`;
                if (seen.has(id)) continue;
                seen.add(id);
                const virtExec = {
                  ...e,
                  stopAtr,
                  minStopPct,
                  rewardRisk,
                  beTriggerR,
                  beOffsetPct,
                  cooldown,
                };
                specs.push({
                  id,
                  sig: sigMod,
                  execOptions: virtExec,
                  fullSpec: { ...sigMod, virtExec },
                });
              }
            }
          }
        }
      }
    }
  }
  return specs;
}

export function runSearch15mV4() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const fullSpotPath = path.join(ROOT_DIR, 'data', 'okx_btcusdt_15m_3y.json');
  const fullSpot = JSON.parse(fs.readFileSync(fullSpotPath, 'utf8'));
  const N = fullSpot.rows.length;
  const calEnd = Math.floor(N * 0.5);       // 52560 (18m)
  const valEnd = Math.floor((N * 2) / 3); // 70080 (24m)

  // Physical truncation: Holdout Year 3 rows are excluded from Cal+Val selection.
  const calValDs = sliceDatasetPrefix15m(fullSpot, valEnd);
  const preCalVal = precompute15mV4(calValDs);

  console.log(`[search_15m_v4] Screening Round 1 on strictly truncated Cal+Val (${calValDs.rows.length} bars, Cal=0..${calEnd}, Val=${calEnd}..${valEnd})...`);
  const r1Specs = buildRound1Specs15m();
  const r1Evaluated = r1Specs.map(c => evaluateCandidateOnPrefix15m(calValDs, preCalVal, c, { calEnd, valEnd }));
  r1Evaluated.sort((a, b) => {
    if (a.eligibleStrict !== b.eligibleStrict) return a.eligibleStrict ? -1 : 1;
    return b.score - a.score;
  });

  console.log(`[search_15m_v4] Round 1 complete: ${r1Evaluated.length} candidates, strict eligible = ${r1Evaluated.filter(x => x.eligibleStrict).length}`);
  for (const r of r1Evaluated.slice(0, 12)) {
    console.log(`  [${r.eligibleStrict ? 'ELIG' : 'MISS'}] ${r.id} | CalVal: n=${r.calVal.count} WR=${r.calVal.winRatePct}% PF=${r.calVal.profitFactor} Net=${r.calVal.totalNetPct}% DD=${r.calVal.maxDrawdownPct}% noBePF=${r.noBeCalVal.profitFactor} minH_WR=${r.minHWr}% minH_PF=${r.minHPf}`);
  }

  const r1EligibleOrTop = r1Evaluated.filter(x => x.eligibleStrict);
  const r1Seeds = r1EligibleOrTop.length >= 3 ? r1EligibleOrTop : r1Evaluated.slice(0, 8);
  const r2Specs = buildRound2RefinementSpecs15m(r1Seeds);
  console.log(`[search_15m_v4] Screening Round 2 plateau search (${r2Specs.length} configs on Cal+Val)...`);
  const r2Evaluated = r2Specs.map(c => evaluateCandidateOnPrefix15m(calValDs, preCalVal, c, { calEnd, valEnd }));
  r2Evaluated.sort((a, b) => {
    if (a.eligibleStrict !== b.eligibleStrict) return a.eligibleStrict ? -1 : 1;
    return b.score - a.score;
  });

  const combined = [...r1Evaluated, ...r2Evaluated].sort((a, b) => {
    if (a.eligibleStrict !== b.eligibleStrict) return a.eligibleStrict ? -1 : 1;
    return b.score - a.score;
  });

  const winner = combined[0];
  console.log(`\n[search_15m_v4] LOCKING WINNER (before unsealing Holdout Year 3): ${winner.id}`);
  console.log(`  Cal: n=${winner.cal.count} WR=${winner.cal.winRatePct}% PF=${winner.cal.profitFactor} Net=${winner.cal.totalNetPct}%`);
  console.log(`  Val: n=${winner.val.count} WR=${winner.val.winRatePct}% PF=${winner.val.profitFactor} Net=${winner.val.totalNetPct}%`);
  console.log(`  CalVal: n=${winner.calVal.count} WR=${winner.calVal.winRatePct}% PF=${winner.calVal.profitFactor} Net=${winner.calVal.totalNetPct}% (comp=${winner.calVal.compoundedNetPct}%) DD=${winner.calVal.maxDrawdownPct}% noBePF=${winner.noBeCalVal.profitFactor}`);

  const lockPayload = {
    schema: 'smc-v4-15m-lock-v1',
    lockedAt: new Date().toISOString(),
    selectionScope: `Cal[0..${calEnd}] + Val[${calEnd}..${valEnd}] strictly truncated`,
    totalEvaluatedCalVal: combined.length,
    strictEligibleCount: combined.filter(x => x.eligibleStrict).length,
    winner: {
      id: winner.id,
      sig: winner.sig,
      execOptions: winner.execOptions,
      fullSpec: winner.fullSpec,
      calValMetrics: {
        cal: winner.cal,
        val: winner.val,
        calVal: winner.calVal,
        h1ToH4: winner.hSlices,
        noBeCalVal: winner.noBeCalVal,
      },
    },
    top10CalVal: combined.slice(0, 10).map(x => ({
      id: x.id,
      eligibleStrict: x.eligibleStrict,
      score: x.score,
      cal: { count: x.cal.count, wr: x.cal.winRatePct, pf: x.cal.profitFactor, net: x.cal.totalNetPct },
      val: { count: x.val.count, wr: x.val.winRatePct, pf: x.val.profitFactor, net: x.val.totalNetPct },
      calVal: { count: x.calVal.count, wr: x.calVal.winRatePct, pf: x.calVal.profitFactor, net: x.calVal.totalNetPct, dd: x.calVal.maxDrawdownPct },
      noBePF: x.noBeCalVal.profitFactor,
      minHWr: x.minHWr,
      minHPf: x.minHPf,
    })),
  };

  const evalFullDataset = (relPath) => {
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
      full: summarizeSlice(fullSim, ds.rows, 0, ds.rows.length),
      noBe: summarizeSlice(noBeSim, ds.rows, 0, ds.rows.length),
      yearly: ds.rows.length >= 100000 ? [0, 1, 2].map(y => {
        const st = y * Math.floor(ds.rows.length / 3);
        const en = y === 2 ? ds.rows.length : (y + 1) * Math.floor(ds.rows.length / 3);
        return { year: y + 1, ...summarizeSlice(simulateTrades(ds.rows, sigs, { ...opts, start: st, end: en }), ds.rows, st, en) };
      }) : undefined,
    };
  };

  const unsealed = {
    okxSpot3y: evalFullDataset('data/okx_btcusdt_15m_3y.json'),
    okxSwap3y: evalFullDataset('data/okx_btcusdt_swap_15m_3y.json'),
    okxSpotTv6k: evalFullDataset('data/okx_btcusdt_tv_15m_6k.json'),
    okxSwapTv6k: evalFullDataset('data/okx_btcusdt_swap_tv_15m_6k.json'),
    binanceBtc12m: fs.existsSync(path.join(ROOT_DIR, 'data/btcusdt_15m_12m.json')) ? evalFullDataset('data/btcusdt_15m_12m.json') : null,
    binanceBtcTv6k: fs.existsSync(path.join(ROOT_DIR, 'data/btcusdt_tv_15m_6k.json')) ? evalFullDataset('data/btcusdt_tv_15m_6k.json') : null,
    binanceEth6m: fs.existsSync(path.join(ROOT_DIR, 'data/ethusdt_15m_6m.json')) ? evalFullDataset('data/ethusdt_15m_6m.json') : null,
  };

  lockPayload.unsealedEvaluation = unsealed;
  const outPath = path.join(RESULTS_DIR, 'lock_15m.json');
  fs.writeFileSync(outPath, JSON.stringify(lockPayload, null, 2) + '\n');

  console.log('\n[search_15m_v4] UNSEALED RESULTS ON LOCKED WINNER:');
  for (const [k, v] of Object.entries(unsealed)) {
    if (!v) continue;
    const f = v.full;
    console.log(`  ${k}: n=${f.count} WR=${f.winRatePct}% PF=${f.profitFactor} Net=${f.totalNetPct}% (comp=${f.compoundedNetPct}%) DD=${f.maxDrawdownPct}% noBePF=${v.noBe.profitFactor}`);
    if (v.yearly) {
      for (const y of v.yearly) {
        console.log(`    Year ${y.year}: n=${y.count} WR=${y.winRatePct}% PF=${y.profitFactor} Net=${y.totalNetPct}% DD=${y.maxDrawdownPct}%`);
      }
    }
  }
  return lockPayload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSearch15mV4();
}
