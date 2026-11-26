import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simulateTradesV5, simulatePortfolioV5, wilsonLowerBound } from './sim_engine_v5.mjs';
import { alignFundingToBarsCausal } from './fetch_okx_derivs.mjs';
import { generateSignals1h, sliceDatasetPrefix1h } from './signals_1h.mjs';
import { generateSignals15mV4, sliceDatasetPrefix15m } from './signals_15m_v4.mjs';
import { V41_ALT_DIAGNOSIS, getAltAssetConfigV5, generateSignalsAltV5 } from './signals_v5_alt.mjs';
import { precomputeFeatureContextV5, extractCandidateFeaturesV5 } from './features_v5.mjs';
import { scoreCandidateV5 } from './ml_inference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V5_DIR = path.join(HERE, 'results_v5');
const EPS = 1e-12;

const PROMOTION_GATE = Object.freeze({
  minHoldoutY3WinRatePct: 65.0,
  minHoldoutY3NetPct: 0.0,
  minHoldoutY3ProfitFactor: 1.15,
  minHoldoutY3Trades: 30,
});

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

  const dsCal = prefixFn(ds, calEnd);
  const calSim = simulateTradesV5(dsCal.rows, signals.filter(s => s.barIndex < calEnd), {
    ...execOpts, start: 0, end: calEnd,
  });
  const dsCV = prefixFn(ds, valEnd);
  const sigCV = signals.filter(s => s.barIndex < valEnd);
  const valSim = simulateTradesV5(dsCV.rows, sigCV, { ...execOpts, start: calEnd, end: valEnd });
  const cvSim = simulateTradesV5(dsCV.rows, sigCV, { ...execOpts, start: 0, end: valEnd });

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
    tradesCalVal: cvSim.trades,
  };
}

function stripTrades(res) {
  const { tradesFull, tradesCal, tradesVal, tradesCalVal, ...rest } = res;
  return rest;
}

function checkY3Gate(slice) {
  return (
    slice.count >= PROMOTION_GATE.minHoldoutY3Trades &&
    slice.winRatePct >= PROMOTION_GATE.minHoldoutY3WinRatePct &&
    slice.totalNetPct > PROMOTION_GATE.minHoldoutY3NetPct &&
    slice.profitFactor >= PROMOTION_GATE.minHoldoutY3ProfitFactor
  );
}

export async function runV5MultiPortfolio() {
  // 1. Load BTC v5.0 streams (1h + 15m from @ml-alpha-btc)
  const lock1h = JSON.parse(fs.readFileSync(path.join(HERE, 'results_1h', 'selection-lock.json'), 'utf8')).lockedWinner;
  const lock15 = JSON.parse(fs.readFileSync(path.join(HERE, 'results_v4', 'lock_15m_r3.json'), 'utf8')).winner;
  const btcModelsJson = JSON.parse(fs.readFileSync(path.join(RESULTS_V5_DIR, 'ml_models_btc_v5.json'), 'utf8'));
  const fundingBtc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'okx_btcusdt_swap_funding_3y.json'), 'utf8')).rows;
  const dsBtc1h = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'okx_btcusdt_swap_1h_3y.json'), 'utf8'));
  const dsBtc15 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'okx_btcusdt_swap_15m_3y.json'), 'utf8'));

  const alignedBtc1h = alignFundingToBarsCausal(dsBtc1h.rows, fundingBtc);
  const alignedBtc15 = alignFundingToBarsCausal(dsBtc15.rows, fundingBtc);
  const btcRaw1h = generateSignals1h(dsBtc1h, lock1h.signalSpec);
  const btcRaw15 = generateSignals15mV4(dsBtc15, lock15.fullSpec);
  const btcMl1h = applyMlFilter(dsBtc1h, btcRaw1h, alignedBtc1h, btcModelsJson.models['1h']);
  const btcMl15 = applyMlFilter(dsBtc15, btcRaw15, alignedBtc15, btcModelsJson.models['15m']);

  const btcExec1h = { ...lock1h.execOptions, volNormRiskPct: 5.0, minLev: 1.6, maxLev: 3.0, intervalSeconds: 3600 };
  const btcExec15 = { ...lock15.execOptions, volNormRiskPct: 2.2, minLev: 0.75, maxLev: 1.5, intervalSeconds: 900 };

  // 2. Load locked Altcoin v5.0 models (ETH, SOL) and evaluate strictly on untouched Blind Holdout Y3
  const altModelsPath = path.join(RESULTS_V5_DIR, 'ml_models_alt_v5.json');
  const altModelsJson = JSON.parse(fs.readFileSync(altModelsPath, 'utf8'));

  const altData = {};
  const altResults = {};
  const qualifiedAltSymbols = [];

  for (const key of ['ETH', 'SOL']) {
    const cfg = getAltAssetConfigV5(key);
    const sym = cfg.symbol;
    const modelSpec = altModelsJson.models[sym];
    assert.ok(modelSpec, `Missing locked altcoin model for ${sym}`);

    const ds = JSON.parse(fs.readFileSync(path.join(DATA_DIR, cfg.dataFile), 'utf8'));
    const fundingRows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, cfg.fundingFile), 'utf8')).rows;
    assert.equal(ds.rows.length, 26280, `Expected 26,280 1h bars for ${sym}`);

    const alignedFunding = alignFundingToBarsCausal(ds.rows, fundingRows);
    const rawSignals = generateSignalsAltV5(ds, modelSpec.signalSpec);
    const mlSignals = applyMlFilter(ds, rawSignals, alignedFunding, modelSpec);

    const baseExec = { ...modelSpec.execOptions, intervalSeconds: 3600 };

    const perProfile = {};
    for (const [profileName, profOpts] of [
      ['STRICT_TAKER', { execProfile: 'STRICT_TAKER', fundingRows, fundingPctPer8h: 0.01 }],
      ['EXCHANGE_POST_ONLY', { execProfile: 'EXCHANGE_POST_ONLY', fundingRows, fundingPctPer8h: 0.01 }],
    ]) {
      const baseRes = evalSplitsTrack(ds, rawSignals, { ...baseExec, ...profOpts }, true);
      const mlRes = evalSplitsTrack(ds, mlSignals, { ...baseExec, ...profOpts }, true);
      perProfile[profileName] = {
        calibrated_base: stripTrades(baseRes),
        v50_ml: stripTrades(mlRes),
        _tradesMl: mlRes,
      };
    }

    const takerPassY3 = checkY3Gate(perProfile.STRICT_TAKER.v50_ml.holdoutY3);
    const postOnlyPassY3 = checkY3Gate(perProfile.EXCHANGE_POST_ONLY.v50_ml.holdoutY3);
    const qualifiedForLive = takerPassY3 && postOnlyPassY3;

    modelSpec.qualifiedForLive = qualifiedForLive;
    modelSpec.holdoutY3Gate = {
      evaluatedAt: new Date().toISOString(),
      qualifiedForLive,
      strictTakerPassY3: takerPassY3,
      exchangePostOnlyPassY3: postOnlyPassY3,
      strictTakerY3: perProfile.STRICT_TAKER.v50_ml.holdoutY3,
      exchangePostOnlyY3: perProfile.EXCHANGE_POST_ONLY.v50_ml.holdoutY3,
    };

    if (qualifiedForLive) {
      qualifiedAltSymbols.push(sym);
    }

    altData[sym] = { ds, fundingRows, perProfile };
    altResults[sym] = {
      symbol: sym,
      instId: cfg.instId,
      signalCount: { raw: rawSignals.length, mlFiltered: mlSignals.length },
      qualifiedForLive,
      gateCheck: {
        strictTakerPassY3: takerPassY3,
        exchangePostOnlyPassY3: postOnlyPassY3,
      },
      STRICT_TAKER: {
        calibrated_base: perProfile.STRICT_TAKER.calibrated_base,
        v50_ml: perProfile.STRICT_TAKER.v50_ml,
      },
      EXCHANGE_POST_ONLY: {
        calibrated_base: perProfile.EXCHANGE_POST_ONLY.calibrated_base,
        v50_ml: perProfile.EXCHANGE_POST_ONLY.v50_ml,
      },
    };
  }

  // Persist updated qualifiedForLive & honest holdoutY3Gate back into ml_models_alt_v5.json
  // without altering any model weights, threshold, sizeCurve, or selectionLockSha256.
  altModelsJson.holdoutEvaluatedAt = new Date().toISOString();
  altModelsJson.qualifiedSymbols = qualifiedAltSymbols;
  fs.writeFileSync(altModelsPath, JSON.stringify(altModelsJson, null, 2) + '\n');

  // 3. Simulate combined portfolio via simulatePortfolioV5(maxTotalOpenLev = 4.0)
  //    uniting BTC (1h + 15m) + any qualifiedForLive altcoins across both profiles.
  const portfolioComparison = {};
  for (const [profileName, profOpts] of [
    ['EXCHANGE_POST_ONLY', { execProfile: 'EXCHANGE_POST_ONLY', fundingPctPer8h: 0.01 }],
    ['STRICT_TAKER', { execProfile: 'STRICT_TAKER', fundingPctPer8h: 0.01 }],
  ]) {
    const btc1hRes = evalSplitsTrack(dsBtc1h, btcMl1h, { ...btcExec1h, ...profOpts, fundingRows: fundingBtc }, true);
    const btc15Res = evalSplitsTrack(dsBtc15, btcMl15, { ...btcExec15, ...profOpts, fundingRows: fundingBtc }, false);

    const buildPortfolioForSlice = (streamsSpec, splitName) => {
      const valEnd1h = Math.floor((2 * 26280) / 3);
      const valEnd15 = Math.floor((2 * 105120) / 3);
      const inputs = streamsSpec.map(st => {
        let trades;
        if (splitName === 'cal') trades = st.res.tradesCal;
        else if (splitName === 'val') trades = st.res.tradesVal;
        else if (splitName === 'calVal') trades = st.res.tradesCalVal;
        else if (splitName === 'holdoutY3') {
          const cutoff = st.is1h ? valEnd1h : valEnd15;
          trades = st.res.tradesFull.filter(t => t.signalIndex >= cutoff);
        } else {
          trades = st.res.tradesFull;
        }
        return { id: st.id, rows: st.rows, trades };
      });
      return formatPortfolioSummary(simulatePortfolioV5(inputs, { maxTotalOpenLev: 4.0 }));
    };

    const btcOnlyStreams = [
      { id: 'BTC_1H_ML', rows: dsBtc1h.rows, res: btc1hRes, is1h: true },
      { id: 'BTC_15M_ML', rows: dsBtc15.rows, res: btc15Res, is1h: false },
    ];
    const qualifiedStreams = [...btcOnlyStreams];
    for (const sym of qualifiedAltSymbols) {
      const a = altData[sym];
      qualifiedStreams.push({
        id: `${sym.replace('OKX:', '').replace('.P', '')}_1H_ML`,
        rows: a.ds.rows,
        res: a.perProfile[profileName]._tradesMl,
        is1h: true,
      });
    }

    const btcOnly = {};
    const combinedQualified = {};
    for (const splitName of ['cal', 'val', 'calVal', 'holdoutY3', 'full3y']) {
      btcOnly[splitName] = buildPortfolioForSlice(btcOnlyStreams, splitName);
      combinedQualified[splitName] = buildPortfolioForSlice(qualifiedStreams, splitName);
    }

    portfolioComparison[profileName] = {
      includedStreams: qualifiedStreams.map(s => s.id),
      btcOnly_1h_15m: btcOnly,
      combinedQualifiedPortfolio: combinedQualified,
    };
  }

  console.log('\n=== ALTCOIN BLIND HOLDOUT Y3 PROMOTION GATE (WR>=65%, Net>0%, PF>=1.15, N>=30 in BOTH profiles) ===');
  for (const sym of ['OKX:ETHUSDT.P', 'OKX:SOLUSDT.P']) {
    const ar = altResults[sym];
    console.log(`\n[${sym}] qualifiedForLive=${ar.qualifiedForLive}`);
    for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
      const b = ar[prof].calibrated_base;
      const m = ar[prof].v50_ml;
      console.log(`  ${prof.padEnd(18)} | Base CalVal: n=${b.calVal.count} WR=${b.calVal.winRatePct}% PF=${b.calVal.profitFactor} Net=${b.calVal.totalNetPct}% Comp=${b.calVal.compoundedNetPct}% | Base Y3: n=${b.holdoutY3.count} WR=${b.holdoutY3.winRatePct}% PF=${b.holdoutY3.profitFactor} Net=${b.holdoutY3.totalNetPct}%`);
      console.log(`  ${''.padEnd(18)} | ML   CalVal: n=${m.calVal.count} WR=${m.calVal.winRatePct}% PF=${m.calVal.profitFactor} Net=${m.calVal.totalNetPct}% Comp=${m.calVal.compoundedNetPct}% | ML   Y3: n=${m.holdoutY3.count} WR=${m.holdoutY3.winRatePct}% PF=${m.holdoutY3.profitFactor} Net=${m.holdoutY3.totalNetPct}% Comp=${m.holdoutY3.compoundedNetPct}% | 3Y: n=${m.full3y.count} WR=${m.full3y.winRatePct}% PF=${m.full3y.profitFactor} Comp=${m.full3y.compoundedNetPct}% DD=${m.full3y.compoundedMaxDrawdownPct}%`);
    }
  }

  console.log('\n=== COMBINED PORTFOLIO (simulatePortfolioV5, maxTotalOpenLev=4.0) ===');
  for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
    const p = portfolioComparison[prof];
    console.log(`  [${prof}] streams=${p.includedStreams.join(', ')}`);
    for (const sp of ['calVal', 'holdoutY3', 'full3y']) {
      const c = p.combinedQualifiedPortfolio[sp];
      console.log(`    ${sp.padEnd(10)}: n=${c.count} WR=${c.winRatePct}% PF=${c.profitFactor} Add=${c.totalNetPct}% Comp=${c.compoundedNetPct}% CompDD=${c.compoundedMaxDrawdownPct}% Ret/DD=${c.retToDd} PeakLev=${c.peakOpenLev} Scaled=${c.scaledByCapCount} Skipped=${c.skippedByCapCount}`);
    }
  }

  const summary = {
    schema: 'smc-v5-multi-asset-summary-v1',
    generatedAt: new Date().toISOString(),
    v41AltFailureDiagnosis: V41_ALT_DIAGNOSIS,
    promotionGateCriteria: PROMOTION_GATE,
    qualifiedForLiveAltcoins: qualifiedAltSymbols,
    altcoins: altResults,
    portfolio: {
      maxTotalOpenLev: 4.0,
      ...portfolioComparison,
    },
  };

  const outPath = path.join(RESULTS_V5_DIR, 'multi_asset_v5_summary.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n[run_v5_multi_portfolio] Wrote ${path.relative(ROOT_DIR, outPath)} & updated ml_models_alt_v5.json`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runV5MultiPortfolio().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
