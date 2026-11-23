import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { alignHtfIndices, validateContiguousRows } from './fetch_binance_data.mjs';
import { parseOkxCandle } from './fetch_okx_data.mjs';
import { simulateTrades, wilsonLowerBound } from './sim_engine.mjs';
import { generateSignals1h } from './signals_1h.mjs';
import { generateSignals15mV4 } from './signals_15m_v4.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_V4_DIR = path.join(HERE, 'results_v4');

const OKX_HISTORY_ENDPOINT = 'https://www.okx.com/api/v5/market/history-candles';
const BATCH_LIMIT = 300;
const REQUEST_SLEEP_MS = 115;
const HTF_WARMUP_BARS = 300;
const EPS = 1e-12;

const BAR_SPEC = {
  '1h': { okxBar: '1H', intervalSeconds: 3600 },
  '4h': { okxBar: '4H', intervalSeconds: 14400 },
  '1d': { okxBar: '1Dutc', intervalSeconds: 86400 },
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchOkxBatch({ instId, okxBar, afterMs, limit = BATCH_LIMIT }) {
  const params = new URLSearchParams({ instId, bar: okxBar, limit: String(limit) });
  if (afterMs !== undefined) params.set('after', String(afterMs));
  const url = `${OKX_HISTORY_ENDPOINT}?${params.toString()}`;
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'TRADING-TOOL-Research/4.1' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} from OKX`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from OKX: ${await res.text()}`);
      }
      const payload = await res.json();
      if (payload?.code === '50011') {
        throw new Error(`OKX rate limit 50011: ${payload.msg ?? ''}`);
      }
      if (payload?.code !== '0' || !Array.isArray(payload.data)) {
        throw new Error(`OKX API error code=${payload?.code}: ${payload?.msg}`);
      }
      return payload.data;
    } catch (err) {
      lastError = err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`Failed fetching OKX ${instId} ${okxBar}: ${lastError?.message}`);
}

async function fetchOkxRange({ instId, interval, minOpenSec, maxOpenSec, anchorEndMs }) {
  const { okxBar, intervalSeconds } = BAR_SPEC[interval];
  const byTime = new Map();
  let cursorAfterMs = anchorEndMs;
  let batchNum = 0;

  while (true) {
    batchNum++;
    const data = await fetchOkxBatch({ instId, okxBar, afterMs: cursorAfterMs });
    if (data.length === 0) break;

    let oldestOpenMs = Infinity;
    let added = 0;
    for (const raw of data) {
      const k = parseOkxCandle(raw, { isSwap: true, intervalSeconds });
      if (k.openTimeMs < oldestOpenMs) oldestOpenMs = k.openTimeMs;
      if (!k.closed || k.closeTimeMs > anchorEndMs) continue;
      if (k.time > maxOpenSec) continue;
      if (!byTime.has(k.time)) {
        byTime.set(k.time, {
          time: k.time,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume,
        });
        added++;
      }
    }

    const sortedTimes = Array.from(byTime.keys()).sort((a, b) => a - b);
    if (batchNum % 40 === 0) {
      const oldestIso = sortedTimes.length ? new Date(sortedTimes[0] * 1000).toISOString() : 'n/a';
      console.log(`  [${instId} ${interval}] batch=${batchNum} collected=${sortedTimes.length} oldest=${oldestIso}`);
    }
    if (sortedTimes.length > 0 && sortedTimes[0] <= minOpenSec) break;
    if (!Number.isFinite(oldestOpenMs) || oldestOpenMs <= 0) break;
    if (oldestOpenMs >= cursorAfterMs) break;
    if (data.length < BATCH_LIMIT && added === 0) break;

    cursorAfterMs = oldestOpenMs;
    await sleep(REQUEST_SLEEP_MS);
  }

  const rows = Array.from(byTime.values())
    .filter(r => r.time >= minOpenSec && r.time <= maxOpenSec)
    .sort((a, b) => a.time - b.time);

  validateContiguousRows(rows, intervalSeconds, `${instId} ${interval}`);
  return { rows, interval, intervalSeconds };
}

async function ensurePerp1hDataset({ instId, symbol, fileName, refFirstTime, refLastTime, refCount }) {
  const filePath = path.join(DATA_DIR, fileName);
  if (fs.existsSync(filePath)) {
    const ds = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    validateContiguousRows(ds.rows, 3600, fileName);
    for (const [tf, h] of Object.entries(ds.htf ?? {})) {
      validateContiguousRows(h.rows, h.intervalSeconds, `${fileName} ${tf}`);
      const recomputed = alignHtfIndices(ds.rows, h.rows, h.intervalSeconds);
      assert.deepEqual(h.alignedIndex, recomputed, `${fileName} ${tf} alignedIndex mismatch`);
    }
    if (ds.rows.length === refCount && ds.firstTime === refFirstTime && ds.lastTime === refLastTime) {
      console.log(`[dataset] Using verified local ${fileName} (${ds.rows.length} bars)`);
      return ds;
    }
  }

  console.log(`[fetch] Fetching 3y closed 1h+4h+1d candles for ${instId} (${symbol}) anchored to [${refFirstTime}..${refLastTime}]...`);
  const anchorEndMs = (refLastTime + 3600) * 1000;
  const ltf = await fetchOkxRange({
    instId, interval: '1h', minOpenSec: refFirstTime, maxOpenSec: refLastTime, anchorEndMs,
  });
  assert.equal(ltf.rows.length, refCount, `${instId}: expected ${refCount} bars, got ${ltf.rows.length}`);

  const h4 = await fetchOkxRange({
    instId,
    interval: '4h',
    minOpenSec: refFirstTime - HTF_WARMUP_BARS * 14400,
    maxOpenSec: refLastTime,
    anchorEndMs,
  });
  const d1 = await fetchOkxRange({
    instId,
    interval: '1d',
    minOpenSec: refFirstTime - HTF_WARMUP_BARS * 86400,
    maxOpenSec: refLastTime,
    anchorEndMs,
  });

  const aligned4h = alignHtfIndices(ltf.rows, h4.rows, 14400);
  const aligned1d = alignHtfIndices(ltf.rows, d1.rows, 86400);

  const payload = {
    symbol,
    interval: '1h',
    intervalSeconds: 3600,
    fetchedAt: new Date().toISOString(),
    source: OKX_HISTORY_ENDPOINT,
    htfAlignmentRule: 'htfBar.time + htfIntervalSeconds <= ltfBar.time',
    count: ltf.rows.length,
    firstTime: ltf.rows[0].time,
    lastTime: ltf.rows[ltf.rows.length - 1].time,
    rows: ltf.rows,
    htf: {
      '4h': { interval: '4h', intervalSeconds: 14400, rows: h4.rows, alignedIndex: aligned4h },
      '1d': { interval: '1d', intervalSeconds: 86400, rows: d1.rows, alignedIndex: aligned1d },
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(payload));
  console.log(`[saved] ${fileName}: ${payload.count} 1h bars, ${h4.rows.length} 4h, ${d1.rows.length} 1d`);
  return payload;
}

function summarizeSliceFromSim(trades, rows, startIdx, endIdx) {
  let count = 0;
  let wins = 0;
  let losses = 0;
  let ties = 0;
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
    } else {
      ties++;
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
    ties,
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

function evalSplitsOnDataset(ds, signals, baseExec, candidateOpts) {
  const n = ds.rows.length;
  const calValEnd = Math.floor((2 * n) / 3);
  const fullOpts = { ...baseExec, ...candidateOpts, intervalSeconds: ds.intervalSeconds };

  // Strict Cal+Val truncated run (zero future contamination)
  const cvSim = simulateTrades(ds.rows, signals, { ...fullOpts, start: 0, end: calValEnd });
  const calVal = summarizeSliceFromSim(cvSim.trades, ds.rows, 0, calValEnd);

  // Full 3y continuous run for Holdout (Y3) and Full 3y audit
  const fullSim = simulateTrades(ds.rows, signals, { ...fullOpts, start: 0, end: n });
  const holdoutY3 = summarizeSliceFromSim(fullSim.trades, ds.rows, calValEnd, n);
  const full3y = summarizeSliceFromSim(fullSim.trades, ds.rows, 0, n);

  return { calVal, holdoutY3, full3y };
}

export async function runV41ProfitAmp() {
  const lock1hV3 = JSON.parse(fs.readFileSync(path.join(HERE, 'results_1h', 'selection-lock.json'), 'utf8')).lockedWinner;
  const lock15V4 = JSON.parse(fs.readFileSync(path.join(RESULTS_V4_DIR, 'lock_15m_r3.json'), 'utf8')).winner;

  const btcSwap1h = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'okx_btcusdt_swap_1h_3y.json'), 'utf8'));
  const ethSwap1h = await ensurePerp1hDataset({
    instId: 'ETH-USDT-SWAP',
    symbol: 'OKX:ETHUSDT.P',
    fileName: 'okx_ethusdt_swap_1h_3y.json',
    refFirstTime: btcSwap1h.firstTime,
    refLastTime: btcSwap1h.lastTime,
    refCount: btcSwap1h.count,
  });
  const solSwap1h = await ensurePerp1hDataset({
    instId: 'SOL-USDT-SWAP',
    symbol: 'OKX:SOLUSDT.P',
    fileName: 'okx_solusdt_swap_1h_3y.json',
    refFirstTime: btcSwap1h.firstTime,
    refLastTime: btcSwap1h.lastTime,
    refCount: btcSwap1h.count,
  });

  const btcSignals = generateSignals1h(btcSwap1h, lock1hV3.signalSpec);
  const ethSignals = generateSignals1h(ethSwap1h, lock1hV3.signalSpec);
  const solSignals = generateSignals1h(solSwap1h, lock1hV3.signalSpec);

  const baseExec1h = lock1hV3.execOptions;
  const calValEnd1h = Math.floor((2 * btcSwap1h.rows.length) / 3);

  // Baselines on BTCUSDT.P
  const baselinesBtc = {
    Baseline_1x_NoFunding: { fixedLev: 1.0, fundingPctPer8h: 0 },
    Baseline_1x_WithFunding: { fixedLev: 1.0, fundingPctPer8h: 0.01 },
    Fixed_2x_WithFunding: { fixedLev: 2.0, fundingPctPer8h: 0.01 },
  };

  // Grid 1: VolNorm-Only (16 configs evaluated strictly on BTCUSDT.P Cal+Val [0..17520])
  const volNormCandidates = [];
  for (const volNormRiskPct of [3.5, 4.2, 4.5, 5.0]) {
    for (const [minLev, maxLev] of [[1.2, 2.5], [1.4, 2.8], [1.5, 2.8], [1.6, 3.0]]) {
      const opts = { volNormRiskPct, minLev, maxLev, fundingPctPer8h: 0.01 };
      const cvSim = simulateTrades(btcSwap1h.rows, btcSignals, {
        ...baseExec1h, ...opts, start: 0, end: calValEnd1h, intervalSeconds: btcSwap1h.intervalSeconds,
      });
      const calVal = summarizeSliceFromSim(cvSim.trades, btcSwap1h.rows, 0, calValEnd1h);
      const eligible = calVal.winRatePct >= 65.0 && calVal.maxDrawdownPct <= 35.0;
      const score = (eligible ? 1000 : 0) + calVal.compoundedNetPct + 40 * calVal.compRetToDd;
      volNormCandidates.push({
        id: `VolNorm_${volNormRiskPct}_L${minLev}-${maxLev}`,
        opts,
        calVal,
        eligible,
        score: Number(score.toFixed(2)),
      });
    }
  }
  volNormCandidates.sort((a, b) => b.score - a.score);
  const topVolNorm = volNormCandidates[0];

  // Grid 2: VolNorm + Partial TP (36 configs evaluated strictly on BTCUSDT.P Cal+Val [0..17520])
  const partialCandidates = [];
  for (const [volNormRiskPct, minLev, maxLev] of [[4.2, 1.4, 2.8], [4.5, 1.5, 2.8]]) {
    for (const tp1TriggerR of [0.95, 1.10]) {
      for (const rewardRisk of [1.65, 1.85, 2.00]) {
        for (const tp1LockOffsetR of [0.65, 0.85, 0.90]) {
          const opts = {
            volNormRiskPct, minLev, maxLev,
            tp1QtyPct: 50, tp1TriggerR, rewardRisk, tp1LockOffsetR, fundingPctPer8h: 0.01,
          };
          const cvSim = simulateTrades(btcSwap1h.rows, btcSignals, {
            ...baseExec1h, ...opts, start: 0, end: calValEnd1h, intervalSeconds: btcSwap1h.intervalSeconds,
          });
          const calVal = summarizeSliceFromSim(cvSim.trades, btcSwap1h.rows, 0, calValEnd1h);
          const eligible = calVal.winRatePct >= 65.0 && calVal.maxDrawdownPct <= 35.0;
          const score = (eligible ? 1000 : 0) + calVal.compoundedNetPct + 40 * calVal.compRetToDd;
          partialCandidates.push({
            id: `VolNorm_${volNormRiskPct}_L${minLev}-${maxLev}_TP1_${tp1TriggerR}_RR${rewardRisk}_Lck${tp1LockOffsetR}`,
            opts,
            calVal,
            eligible,
            score: Number(score.toFixed(2)),
          });
        }
      }
    }
  }
  partialCandidates.sort((a, b) => b.score - a.score);
  const topPartial = partialCandidates[0];

  console.log(`\n[run_v41_profit_amp] Selected on BTCUSDT.P Cal+Val (Y1+Y2 <= ${calValEnd1h} bars, WR>=65% & AddDD<=35%):`);
  console.log(`  Top VolNorm-Only    : ${topVolNorm.id} | eligible=${topVolNorm.eligible} | CalVal=${JSON.stringify(topVolNorm.calVal)}`);
  console.log(`  Top VolNorm+Partial : ${topPartial.id} | eligible=${topPartial.eligible} | CalVal=${JSON.stringify(topPartial.calVal)}`);

  // Evaluate locked profiles across BTC, ETH, SOL (unsealing Blind Holdout Y3)
  const profiles1h = {
    Baseline_1x_NoFunding: baselinesBtc.Baseline_1x_NoFunding,
    Baseline_1x_WithFunding: baselinesBtc.Baseline_1x_WithFunding,
    Fixed_2x_WithFunding: baselinesBtc.Fixed_2x_WithFunding,
    VolNorm_Winner: topVolNorm.opts,
    VolNorm_PartialTP_Winner: topPartial.opts,
  };

  const assets1h = [
    ['OKX:BTCUSDT.P', btcSwap1h, btcSignals],
    ['OKX:ETHUSDT.P', ethSwap1h, ethSignals],
    ['OKX:SOLUSDT.P', solSwap1h, solSignals],
  ];

  const crossAsset1h = {};
  for (const [sym, ds, sigs] of assets1h) {
    crossAsset1h[sym] = {};
    console.log(`\n=== 1H CROSS-ASSET PERP: ${sym} (${ds.rows.length} bars) ===`);
    for (const [pName, pOpts] of Object.entries(profiles1h)) {
      const r = evalSplitsOnDataset(ds, sigs, baseExec1h, pOpts);
      crossAsset1h[sym][pName] = r;
      console.log(`  ${pName.padEnd(25)} | CV: WR=${r.calVal.winRatePct}% Add=${r.calVal.totalNetPct}% Comp=${r.calVal.compoundedNetPct}% DD=${r.calVal.maxDrawdownPct}% | Y3: WR=${r.holdoutY3.winRatePct}% Add=${r.holdoutY3.totalNetPct}% Comp=${r.holdoutY3.compoundedNetPct}% | 3Y: n=${r.full3y.count} WR=${r.full3y.winRatePct}% PF=${r.full3y.profitFactor} Add=${r.full3y.totalNetPct}% Comp=${r.full3y.compoundedNetPct}% AddDD=${r.full3y.maxDrawdownPct}% CompDD=${r.full3y.compoundedMaxDrawdownPct}% Ret/DD=${r.full3y.retToDd} Wst=${r.full3y.worstTradePct}% Fund=${r.full3y.fundingDragPct}%`);
    }
  }

  // Evaluate 15m v4.0 (15m_r3) Fixed 1x vs VolNorm 2.2% [0.75..1.5x] on OKX Spot & Swap
  const btcSpot15 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'okx_btcusdt_15m_3y.json'), 'utf8'));
  const btcSwap15 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'okx_btcusdt_swap_15m_3y.json'), 'utf8'));
  const sigSpot15 = generateSignals15mV4(btcSpot15, lock15V4.fullSpec);
  const sigSwap15 = generateSignals15mV4(btcSwap15, lock15V4.fullSpec);
  const baseExec15 = lock15V4.execOptions;

  const track15mVolNorm = {
    'OKX:BTCUSDT_15m': {
      Fixed_1x: evalSplitsOnDataset(btcSpot15, sigSpot15, baseExec15, { fixedLev: 1.0, fundingPctPer8h: 0 }),
      VolNorm_2_2_075_15: evalSplitsOnDataset(btcSpot15, sigSpot15, baseExec15, { volNormRiskPct: 2.2, minLev: 0.75, maxLev: 1.5, fundingPctPer8h: 0 }),
    },
    'OKX:BTCUSDT.P_15m': {
      Fixed_1x_WithFunding: evalSplitsOnDataset(btcSwap15, sigSwap15, baseExec15, { fixedLev: 1.0, fundingPctPer8h: 0.01 }),
      VolNorm_2_2_075_15_WithFunding: evalSplitsOnDataset(btcSwap15, sigSwap15, baseExec15, { volNormRiskPct: 2.2, minLev: 0.75, maxLev: 1.5, fundingPctPer8h: 0.01 }),
    },
  };

  console.log('\n=== 15M V4 (15m_r3) SPOT & PERP VOLNORM CHECK ===');
  for (const [label, group] of Object.entries(track15mVolNorm)) {
    console.log(`  ${label}:`);
    for (const [k, r] of Object.entries(group)) {
      console.log(`    ${k.padEnd(32)} | Full3Y: n=${r.full3y.count} WR=${r.full3y.winRatePct}% PF=${r.full3y.profitFactor} Add=${r.full3y.totalNetPct}% Comp=${r.full3y.compoundedNetPct}% AddDD=${r.full3y.maxDrawdownPct}% Wst=${r.full3y.worstTradePct}% | Y3: Add=${r.holdoutY3.totalNetPct}%`);
    }
  }

  fs.mkdirSync(RESULTS_V4_DIR, { recursive: true });
  const summary = {
    schema: 'smc-v4.1-profit-amp-v1',
    generatedAt: new Date().toISOString(),
    methodology: {
      selectionScope: 'Cal+Val (Years 1-2: [0..17520] bars on OKX:BTCUSDT.P 1h) strict selection before unsealing Year 3 Holdout and ETH/SOL Perp.',
      executionAssumptions: 'costPct=0.10% round-trip + slippagePct=0.025% per fill + OKX Perp fundingPctPer8h=0.01% per 8h UTC boundary (weighted by remFrac); SL/BE beats TP1/TP2; VolNorm lev = clamp(riskPct/stopDistPct, minLev, maxLev).',
    },
    selectedOnBtcCalVal: {
      topVolNorm,
      topPartial,
      top5VolNormCalVal: volNormCandidates.slice(0, 5),
      top5PartialCalVal: partialCandidates.slice(0, 5),
    },
    crossAsset1hPerp: crossAsset1h,
    track15mVolNorm,
  };

  const outPath = path.join(RESULTS_V4_DIR, 'v41_profit_amp_summary.json');
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(`\n[run_v41_profit_amp] Wrote ${path.relative(ROOT_DIR, outPath)}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runV41ProfitAmp().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
