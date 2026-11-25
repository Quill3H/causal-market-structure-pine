import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTradesV5, simulatePortfolioV5, wilsonLowerBound } from './sim_engine_v5.mjs';
import { alignFundingToBarsCausal } from './fetch_okx_derivs.mjs';
import { generateSignals1h, sliceDatasetPrefix1h } from './signals_1h.mjs';
import { generateSignals15mV4, sliceDatasetPrefix15m } from './signals_15m_v4.mjs';
import { precomputeFeatureContextV5, extractCandidateFeaturesV5 } from './features_v5.mjs';
import { scoreCandidateV5 } from './ml_inference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V5_DIR = path.join(HERE, 'results_v5');
const EPS = 1e-12;

function summarizeSlice(trades, startIdx, endIdx) {
  let count = 0;
  let wins = 0;
  let losses = 0;
  let gains = 0;
  let lossSum = 0;
  let netSum = 0;
  let cumNet = 0;
  let peakNet = 0;
  let maxDrawdownPct = 0;
  let equity = 1.0;
  let peakEq = 1.0;
  let compoundedMaxDrawdownPct = 0;
  let worstTradePct = 0;
  let fundDragSum = 0;
  let levSum = 0;

  for (const t of trades) {
    if (t.signalIndex < startIdx || t.exitIndex >= endIdx) continue;
    count++;
    const p = t.netPct;
    if (p > EPS) {
      wins++;
      gains += p;
    } else if (p < -EPS) {
      losses++;
      lossSum -= p;
    }
    if (p < worstTradePct) worstTradePct = p;
    fundDragSum += t.fundingDragPct ?? 0;
    levSum += t.lev ?? 1.0;

    netSum += p;
    cumNet += p;
    if (cumNet > peakNet) peakNet = cumNet;
    const dd = peakNet - cumNet;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;

    const factor = 1 + p / 100;
    equity = factor <= 0 ? 0 : equity * factor;
    if (equity > peakEq) peakEq = equity;
    const cdd = peakEq > 0 ? ((peakEq - equity) / peakEq) * 100 : 100;
    if (cdd > compoundedMaxDrawdownPct) compoundedMaxDrawdownPct = cdd;
  }

  const winRatePct = count ? (wins / count) * 100 : 0;
  const pf = lossSum > 0 ? gains / lossSum : (wins > 0 ? 99 : 0);
  const compoundedNetPct = (equity - 1) * 100;

  return {
    range: [startIdx, endIdx],
    count,
    wins,
    losses,
    ties: count - wins - losses,
    winRatePct: Number(winRatePct.toFixed(2)),
    wilsonLower95Pct: Number((count ? wilsonLowerBound(wins, count, 1.96) : 0).toFixed(2)),
    profitFactor: Number(pf.toFixed(2)),
    totalNetPct: Number(netSum.toFixed(2)),
    compoundedNetPct: Number(compoundedNetPct.toFixed(2)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    compoundedMaxDrawdownPct: Number(compoundedMaxDrawdownPct.toFixed(2)),
    retToDd: Number((maxDrawdownPct > 0 ? netSum / maxDrawdownPct : 0).toFixed(2)),
    compRetToDd: Number((compoundedMaxDrawdownPct > 0 ? compoundedNetPct / compoundedMaxDrawdownPct : 0).toFixed(2)),
    avgLev: Number((count ? levSum / count : 1).toFixed(2)),
    worstTradePct: Number(worstTradePct.toFixed(2)),
    fundingDragPct: Number(fundDragSum.toFixed(2)),
  };
}

function formatPortfolioSummary(p) {
  return {
    count: p.count,
    wins: p.wins,
    losses: p.losses,
    winRatePct: Number((p.winRatePct ?? 0).toFixed(2)),
    wilsonLower95Pct: Number((p.wilsonLower95Pct ?? 0).toFixed(2)),
    profitFactor: Number((p.profitFactor ?? 0).toFixed(2)),
    totalNetPct: Number((p.totalNetPct ?? 0).toFixed(2)),
    compoundedNetPct: Number((p.compoundedNetPct ?? 0).toFixed(2)),
    maxDrawdownPct: Number((p.maxDrawdownPct ?? 0).toFixed(2)),
    compoundedMaxDrawdownPct: Number((p.compoundedMaxDrawdownPct ?? 0).toFixed(2)),
    retToDd: Number((p.retToDd ?? 0).toFixed(2)),
    peakOpenLev: Number((p.peakOpenLev ?? 0).toFixed(2)),
    scaledByCapCount: p.scaledByCapCount,
    skippedByCapCount: p.skippedByCapCount,
    perStream: p.perStream,
  };
}

function applyMlFilter(ds, signals, alignedFunding, modelSpec) {
  const ctx = precomputeFeatureContextV5(ds, alignedFunding);
  const filtered = [];
  for (const s of signals) {
    const f = extractCandidateFeaturesV5(ds, s, s.barIndex, alignedFunding, ctx);
    const score = scoreCandidateV5(f, modelSpec);
    if (score.pass) {
      filtered.push({
        ...s,
        sizeMult: score.sizeMult,
        meta: { ...(s.meta ?? {}), probWin: score.probWin, sizeMult: score.sizeMult },
      });
    }
  }
  return filtered;
}

function evalSplitsTrack(ds, signals, execOpts, is1h) {
  const n = ds.rows.length;
  const calEnd = Math.floor(n / 3);
  const valEnd = Math.floor((2 * n) / 3);
  const prefixFn = is1h ? sliceDatasetPrefix1h : sliceDatasetPrefix15m;

  // Strictly truncated Cal and Cal+Val runs
  const dsCal = prefixFn(ds, calEnd);
  const calSim = simulateTradesV5(dsCal.rows, signals.filter(s => s.barIndex < calEnd), {
    ...execOpts, start: 0, end: calEnd,
  });
  const dsCV = prefixFn(ds, valEnd);
  const sigCV = signals.filter(s => s.barIndex < valEnd);
  const valSim = simulateTradesV5(dsCV.rows, sigCV, { ...execOpts, start: calEnd, end: valEnd });
  const cvSim = simulateTradesV5(dsCV.rows, sigCV, { ...execOpts, start: 0, end: valEnd });

  // Full 3y continuous run (Holdout Y3 = [valEnd..n))
  const fullSim = simulateTradesV5(ds.rows, signals, { ...execOpts, start: 0, end: n });

  return {
    cal: summarizeSlice(calSim.trades, 0, calEnd),
    val: summarizeSlice(valSim.trades, calEnd, valEnd),
    calVal: summarizeSlice(cvSim.trades, 0, valEnd),
    holdoutY3: summarizeSlice(fullSim.trades, valEnd, n),
    full3y: summarizeSlice(fullSim.trades, 0, n),
    tradesFull: fullSim.trades,
    tradesCal: calSim.trades,
    tradesVal: valSim.trades,
  };
}

function stripTrades(res) {
  const { tradesFull, tradesCal, tradesVal, ...rest } = res;
  return rest;
}

export async function runV5BtcAlpha() {
  const lock1h = JSON.parse(fs.readFileSync(path.join(HERE, 'results_1h', 'selection-lock.json'), 'utf8')).lockedWinner;
  const lock15 = JSON.parse(fs.readFileSync(path.join(RESULTS_V5_DIR, '..', 'results_v4', 'lock_15m_r3.json'), 'utf8')).winner;
  const modelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V5_DIR, 'ml_models_btc_v5.json'), 'utf8'));
  const fundingBtc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'okx_btcusdt_swap_funding_3y.json'), 'utf8')).rows;

  const ds1h = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'okx_btcusdt_swap_1h_3y.json'), 'utf8'));
  const ds15 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'okx_btcusdt_swap_15m_3y.json'), 'utf8'));

  assert.equal(ds1h.rows.length, 26280, 'Expected 26,280 1h bars');
  assert.equal(ds15.rows.length, 105120, 'Expected 105,120 15m bars');

  const alignedFunding1h = alignFundingToBarsCausal(ds1h.rows, fundingBtc);
  const alignedFunding15 = alignFundingToBarsCausal(ds15.rows, fundingBtc);

  const rawSignals1h = generateSignals1h(ds1h, lock1h.signalSpec);
  const rawSignals15 = generateSignals15mV4(ds15, lock15.fullSpec);

  const mlSignals1h = applyMlFilter(ds1h, rawSignals1h, alignedFunding1h, modelsJson.models['1h']);
  const mlSignals15 = applyMlFilter(ds15, rawSignals15, alignedFunding15, modelsJson.models['15m']);

  const baseExec1h = { ...lock1h.execOptions, volNormRiskPct: 5.0, minLev: 1.6, maxLev: 3.0, intervalSeconds: 3600 };
  const baseExec15 = { ...lock15.execOptions, volNormRiskPct: 2.2, minLev: 0.75, maxLev: 1.5, intervalSeconds: 900 };

  const tracks = {};
  for (const [profileName, profOpts] of [
    ['STRICT_TAKER', { execProfile: 'STRICT_TAKER', fundingPctPer8h: 0.01 }],
    ['EXCHANGE_POST_ONLY', { execProfile: 'EXCHANGE_POST_ONLY', fundingRows: fundingBtc, fundingPctPer8h: 0.01 }],
  ]) {
    const b1h = evalSplitsTrack(ds1h, rawSignals1h, { ...baseExec1h, ...profOpts }, true);
    const m1h = evalSplitsTrack(ds1h, mlSignals1h, { ...baseExec1h, ...profOpts }, true);
    const b15 = evalSplitsTrack(ds15, rawSignals15, { ...baseExec15, ...profOpts }, false);
    const m15 = evalSplitsTrack(ds15, mlSignals15, { ...baseExec15, ...profOpts }, false);

    const n1h = ds1h.rows.length;
    const n15 = ds15.rows.length;
    const valEnd1h = Math.floor((2 * n1h) / 3);
    const valEnd15 = Math.floor((2 * n15) / 3);

    const portfolioBaseline = {
      cal: formatPortfolioSummary(simulatePortfolioV5([
        { id: 'BTC_1H', rows: ds1h.rows, trades: b1h.tradesCal },
        { id: 'BTC_15M', rows: ds15.rows, trades: b15.tradesCal },
      ], { maxTotalOpenLev: 4.0 })),
      val: formatPortfolioSummary(simulatePortfolioV5([
        { id: 'BTC_1H', rows: ds1h.rows, trades: b1h.tradesVal },
        { id: 'BTC_15M', rows: ds15.rows, trades: b15.tradesVal },
      ], { maxTotalOpenLev: 4.0 })),
      holdoutY3: formatPortfolioSummary(simulatePortfolioV5([
        { id: 'BTC_1H', rows: ds1h.rows, trades: b1h.tradesFull.filter(t => t.signalIndex >= valEnd1h) },
        { id: 'BTC_15M', rows: ds15.rows, trades: b15.tradesFull.filter(t => t.signalIndex >= valEnd15) },
      ], { maxTotalOpenLev: 4.0 })),
      full3y: formatPortfolioSummary(simulatePortfolioV5([
        { id: 'BTC_1H', rows: ds1h.rows, trades: b1h.tradesFull },
        { id: 'BTC_15M', rows: ds15.rows, trades: b15.tradesFull },
      ], { maxTotalOpenLev: 4.0 })),
    };

    const portfolioV5Ml = {
      cal: formatPortfolioSummary(simulatePortfolioV5([
        { id: 'BTC_1H', rows: ds1h.rows, trades: m1h.tradesCal },
        { id: 'BTC_15M', rows: ds15.rows, trades: m15.tradesCal },
      ], { maxTotalOpenLev: 4.0 })),
      val: formatPortfolioSummary(simulatePortfolioV5([
        { id: 'BTC_1H', rows: ds1h.rows, trades: m1h.tradesVal },
        { id: 'BTC_15M', rows: ds15.rows, trades: m15.tradesVal },
      ], { maxTotalOpenLev: 4.0 })),
      holdoutY3: formatPortfolioSummary(simulatePortfolioV5([
        { id: 'BTC_1H', rows: ds1h.rows, trades: m1h.tradesFull.filter(t => t.signalIndex >= valEnd1h) },
        { id: 'BTC_15M', rows: ds15.rows, trades: m15.tradesFull.filter(t => t.signalIndex >= valEnd15) },
      ], { maxTotalOpenLev: 4.0 })),
      full3y: formatPortfolioSummary(simulatePortfolioV5([
        { id: 'BTC_1H', rows: ds1h.rows, trades: m1h.tradesFull },
        { id: 'BTC_15M', rows: ds15.rows, trades: m15.tradesFull },
      ], { maxTotalOpenLev: 4.0 })),
    };

    tracks[profileName] = {
      btc_1h: { v41_baseline: stripTrades(b1h), v50_ml: stripTrades(m1h) },
      btc_15m: { v41_baseline: stripTrades(b15), v50_ml: stripTrades(m15) },
      portfolio_btc_1h_15m: { v41_baseline: portfolioBaseline, v50_ml: portfolioV5Ml },
    };
  }

  for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
    console.log(`\n==================== ${prof} ====================`);
    for (const tfKey of ['btc_1h', 'btc_15m']) {
      const b = tracks[prof][tfKey].v41_baseline;
      const m = tracks[prof][tfKey].v50_ml;
      console.log(`  [${tfKey}] v4.1 Base | Cal: n=${b.cal.count} WR=${b.cal.winRatePct}% PF=${b.cal.profitFactor} Comp=${b.cal.compoundedNetPct}% | Val: n=${b.val.count} WR=${b.val.winRatePct}% PF=${b.val.profitFactor} Comp=${b.val.compoundedNetPct}% | Y3: n=${b.holdoutY3.count} WR=${b.holdoutY3.winRatePct}% PF=${b.holdoutY3.profitFactor} Add=${b.holdoutY3.totalNetPct}% Comp=${b.holdoutY3.compoundedNetPct}% | 3Y: n=${b.full3y.count} WR=${b.full3y.winRatePct}% PF=${b.full3y.profitFactor} Add=${b.full3y.totalNetPct}% Comp=${b.full3y.compoundedNetPct}% DD=${b.full3y.compoundedMaxDrawdownPct}%`);
      console.log(`  [${tfKey}] v5.0 ML   | Cal: n=${m.cal.count} WR=${m.cal.winRatePct}% PF=${m.cal.profitFactor} Comp=${m.cal.compoundedNetPct}% | Val: n=${m.val.count} WR=${m.val.winRatePct}% PF=${m.val.profitFactor} Comp=${m.val.compoundedNetPct}% | Y3: n=${m.holdoutY3.count} WR=${m.holdoutY3.winRatePct}% PF=${m.holdoutY3.profitFactor} Add=${m.holdoutY3.totalNetPct}% Comp=${m.holdoutY3.compoundedNetPct}% | 3Y: n=${m.full3y.count} WR=${m.full3y.winRatePct}% PF=${m.full3y.profitFactor} Add=${m.full3y.totalNetPct}% Comp=${m.full3y.compoundedNetPct}% DD=${m.full3y.compoundedMaxDrawdownPct}%`);
    }
    const pb = tracks[prof].portfolio_btc_1h_15m.v41_baseline;
    const pm = tracks[prof].portfolio_btc_1h_15m.v50_ml;
    console.log(`  [Portfolio] v4.1 Base | Y3: n=${pb.holdoutY3.count} WR=${pb.holdoutY3.winRatePct}% PF=${pb.holdoutY3.profitFactor} Comp=${pb.holdoutY3.compoundedNetPct}% DD=${pb.holdoutY3.compoundedMaxDrawdownPct}% | 3Y: n=${pb.full3y.count} WR=${pb.full3y.winRatePct}% PF=${pb.full3y.profitFactor} Comp=${pb.full3y.compoundedNetPct}% DD=${pb.full3y.compoundedMaxDrawdownPct}% Ret/DD=${pb.full3y.retToDd}`);
    console.log(`  [Portfolio] v5.0 ML   | Y3: n=${pm.holdoutY3.count} WR=${pm.holdoutY3.winRatePct}% PF=${pm.holdoutY3.profitFactor} Comp=${pm.holdoutY3.compoundedNetPct}% DD=${pm.holdoutY3.compoundedMaxDrawdownPct}% | 3Y: n=${pm.full3y.count} WR=${pm.full3y.winRatePct}% PF=${pm.full3y.profitFactor} Comp=${pm.full3y.compoundedNetPct}% DD=${pm.full3y.compoundedMaxDrawdownPct}% Ret/DD=${pm.full3y.retToDd}`);
  }

  const summary = {
    schema: 'smc-v5-btc-alpha-summary-v1',
    generatedAt: new Date().toISOString(),
    symbol: 'OKX:BTCUSDT.P',
    modelMetadata: {
      '1h': modelsJson.models['1h'].selectionMeta,
      '15m': modelsJson.models['15m'].selectionMeta,
    },
    signalCounts: {
      '1h': { raw: rawSignals1h.length, mlFiltered: mlSignals1h.length },
      '15m': { raw: rawSignals15.length, mlFiltered: mlSignals15.length },
    },
    tracks,
  };

  fs.mkdirSync(RESULTS_V5_DIR, { recursive: true });
  const outPath = path.join(RESULTS_V5_DIR, 'btc_v5_summary.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n[run_v5_btc_alpha] Wrote ${path.relative(ROOT_DIR, outPath)}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runV5BtcAlpha().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
