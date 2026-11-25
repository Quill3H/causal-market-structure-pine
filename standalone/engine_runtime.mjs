import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { alignHtfIndices, validateContiguousRows } from '../research/fetch_binance_data.mjs';
import { generateSignals15mV4 } from '../research/signals_15m_v4.mjs';
import { generateSignals1h } from '../research/signals_1h.mjs';
import { simulateTrades, wilsonLowerBound } from '../research/sim_engine.mjs';
import { OkxClient } from './exchange_okx.mjs';
import { BinanceFuturesClient } from './exchange_binance.mjs';

const EPS = 1e-12;

export function intervalSecondsFor(timeframe) {
  const tf = String(timeframe || '1h').toLowerCase();
  if (tf === '15m') return 900;
  if (tf === '1h') return 3600;
  if (tf === '4h') return 14400;
  if (tf === '1d') return 86400;
  throw new Error(`Unsupported timeframe: ${timeframe}`);
}

export function createExchangeClient(config, exchangeOverride) {
  const exchange = (exchangeOverride || config.exchange || 'OKX').toUpperCase();
  if (exchange === 'BINANCE') {
    return new BinanceFuturesClient({
      apiKey: config.binance?.apiKey,
      apiSecret: config.binance?.apiSecret,
      testnet: config.binance?.testnet,
      dryRun: config.dryRun,
      executionMode: config.executionMode,
      liveConfirmToken: config.liveConfirmToken,
      maxLeverageCap: config.maxLeverageCap,
      maxOrderUsdt: config.maxOrderUsdt,
    });
  }
  return new OkxClient({
    apiKey: config.okx?.apiKey,
    apiSecret: config.okx?.apiSecret,
    passphrase: config.okx?.passphrase,
    simulated: config.okx?.simulated,
    dryRun: config.dryRun,
    executionMode: config.executionMode,
    liveConfirmToken: config.liveConfirmToken,
    maxLeverageCap: config.maxLeverageCap,
    maxOrderUsdt: config.maxOrderUsdt,
  });
}

async function tryImportOptional(absPath) {
  if (!fs.existsSync(absPath)) return null;
  return import(pathToFileURL(absPath).href);
}

function readJsonIfExists(absPath) {
  if (!fs.existsSync(absPath)) return null;
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

/**
 * Loads v5 ML modules/models if present, with clean fallback to locked v4.1 specs.
 */
export async function loadRuntimeSpecs(repoRoot) {
  const researchDir = path.join(repoRoot, 'research');
  const lock1h = readJsonIfExists(path.join(researchDir, 'results_1h', 'selection-lock.json'));
  const lock15m = readJsonIfExists(path.join(researchDir, 'results_v4', 'lock_15m_r3.json'));
  const v41Summary = readJsonIfExists(path.join(researchDir, 'results_v4', 'v41_profit_amp_summary.json'));

  const mlModelsBtc = readJsonIfExists(path.join(researchDir, 'results_v5', 'ml_models_btc_v5.json'));
  const mlModelsAlt = readJsonIfExists(path.join(researchDir, 'results_v5', 'ml_models_alt_v5.json'));

  const [simV5Mod, fetchDerivsMod, featuresV5Mod, mlInfMod, altSignalsMod] = await Promise.all([
    tryImportOptional(path.join(researchDir, 'sim_engine_v5.mjs')),
    tryImportOptional(path.join(researchDir, 'fetch_okx_derivs.mjs')),
    tryImportOptional(path.join(researchDir, 'features_v5.mjs')),
    tryImportOptional(path.join(researchDir, 'ml_inference.mjs')),
    tryImportOptional(path.join(researchDir, 'signals_v5_alt.mjs')),
  ]);

  return {
    lock1h,
    lock15m,
    v41Summary,
    mlModelsBtc,
    mlModelsAlt,
    simV5Mod,
    fetchDerivsMod,
    featuresV5Mod,
    mlInfMod,
    altSignalsMod,
    hasV5Engine: Boolean(simV5Mod?.simulateTradesV5),
    hasV5Ml: Boolean(featuresV5Mod && mlInfMod && mlModelsBtc),
  };
}

/**
 * Resamples contiguous closed LTF bars into strictly closed HTF bars.
 */
export function buildClosedHtfFromLtf(ltfRows, ltfSec, htfSec) {
  if (!Array.isArray(ltfRows) || ltfRows.length === 0) return [];
  const expectedSubBars = Math.round(htfSec / ltfSec);
  const buckets = new Map();
  for (const r of ltfRows) {
    const bucketStart = Math.floor(r.time / htfSec) * htfSec;
    let b = buckets.get(bucketStart);
    if (!b) {
      b = {
        time: bucketStart,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume ?? 0,
        count: 1,
      };
      buckets.set(bucketStart, b);
    } else {
      if (r.high > b.high) b.high = r.high;
      if (r.low < b.low) b.low = r.low;
      b.close = r.close;
      b.volume += r.volume ?? 0;
      b.count += 1;
    }
  }
  const lastLtfClose = ltfRows[ltfRows.length - 1].time + ltfSec;
  const closed = [];
  for (const b of Array.from(buckets.values()).sort((a, b2) => a.time - b2.time)) {
    if (b.count === expectedSubBars && b.time + htfSec <= lastLtfClose) {
      closed.push({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      });
    }
  }
  return closed;
}

/**
 * Keeps only contiguous tail rows if minor gaps exist, and builds causal HTF alignment.
 */
export function buildDatasetFromCandles({ symbol, timeframe, rows, htfOverrides = {} }) {
  const intervalSeconds = intervalSecondsFor(timeframe);
  const dedup = new Map();
  for (const r of rows) {
    if (r && Number.isSafeInteger(r.time) && r.close > 0) {
      dedup.set(r.time, {
        time: r.time,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume ?? 0,
      });
    }
  }
  const sorted = Array.from(dedup.values()).sort((a, b) => a.time - b.time);
  if (sorted.length < 2) {
    throw new Error(`Insufficient closed candles (${sorted.length}) for ${symbol} ${timeframe}`);
  }
  // Keep longest contiguous suffix so strict simulation invariants hold
  let startIdx = sorted.length - 1;
  while (startIdx > 0 && sorted[startIdx].time - sorted[startIdx - 1].time === intervalSeconds) {
    startIdx--;
  }
  const contiguousRows = sorted.slice(startIdx);
  validateContiguousRows(contiguousRows, intervalSeconds, `${symbol} ${timeframe}`);

  const neededHtfs = timeframe === '15m'
    ? [['1h', 3600], ['4h', 14400]]
    : [['4h', 14400], ['1d', 86400]];

  const htf = {};
  for (const [htfName, htfSec] of neededHtfs) {
    const rawHtf = Array.isArray(htfOverrides[htfName]) && htfOverrides[htfName].length > 0
      ? htfOverrides[htfName]
      : buildClosedHtfFromLtf(contiguousRows, intervalSeconds, htfSec);
    if (rawHtf.length === 0) continue;
    // Align only if there is a closed HTF bar before first LTF bar; otherwise slice LTF start
    const firstValidHtfClose = rawHtf[0].time + htfSec;
    if (contiguousRows[0].time < firstValidHtfClose) {
      const trimIdx = contiguousRows.findIndex(r => r.time >= firstValidHtfClose);
      if (trimIdx > 0) {
        contiguousRows.splice(0, trimIdx);
      }
    }
    const alignedIndex = alignHtfIndices(contiguousRows, rawHtf, htfSec);
    htf[htfName] = {
      interval: htfName,
      intervalSeconds: htfSec,
      rows: rawHtf,
      alignedIndex,
    };
  }

  return {
    symbol,
    interval: timeframe,
    intervalSeconds,
    count: contiguousRows.length,
    firstTime: contiguousRows[0].time,
    lastTime: contiguousRows[contiguousRows.length - 1].time,
    rows: contiguousRows,
    htf,
  };
}

export function resolveLocalDatasetPath(repoRoot, { exchange = 'OKX', symbol = 'BTCUSDT.P', timeframe = '1h' }) {
  const sym = String(symbol).toUpperCase();
  const dataDir = path.join(repoRoot, 'data');
  const candidates = [];
  if (sym.startsWith('BTC')) {
    if (timeframe === '1h') {
      candidates.push('okx_btcusdt_swap_1h_3y.json', 'okx_btcusdt_1h_3y.json', 'btcusdt_1h_24m.json');
    } else if (timeframe === '15m') {
      candidates.push('okx_btcusdt_swap_15m_3y.json', 'okx_btcusdt_15m_3y.json', 'btcusdt_15m_12m.json');
    }
  } else if (sym.startsWith('ETH')) {
    if (timeframe === '1h') candidates.push('okx_ethusdt_swap_1h_3y.json', 'ethusdt_1h_12m.json');
    if (timeframe === '15m') candidates.push('ethusdt_15m_6m.json');
  } else if (sym.startsWith('SOL')) {
    if (timeframe === '1h') candidates.push('okx_solusdt_swap_1h_3y.json');
  }
  for (const name of candidates) {
    const p = path.join(dataDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveMlModelEntry(mlBundle, timeframe, symbol) {
  if (!mlBundle || typeof mlBundle !== 'object') return null;
  const tf = String(timeframe).toLowerCase();
  const sym = String(symbol || '').toUpperCase();
  const candidates = [
    mlBundle.models?.[tf],
    mlBundle.models?.[`${sym}_${tf}`],
    mlBundle.byTimeframe?.[tf],
    mlBundle.streams?.[tf],
    mlBundle[tf],
    mlBundle.btc?.[tf],
  ].filter(Boolean);

  for (const entry of candidates) {
    if (entry && typeof entry === 'object') return entry;
  }
  // Alt models map
  if (mlBundle.assets) {
    for (const [key, val] of Object.entries(mlBundle.assets)) {
      if (sym.includes(key.toUpperCase()) || key.toUpperCase().includes(sym.replace('.P', ''))) {
        return val?.[tf] || val;
      }
    }
  }
  return null;
}

function computeSizeMultFromProb(probWin, mlEntry, baseThreshold) {
  if (!Number.isFinite(probWin)) return 1.0;
  const curve = mlEntry?.sizeCurve || mlEntry?.sizeMultCurve;
  if (curve && Number.isFinite(curve.minMult) && Number.isFinite(curve.maxMult)) {
    const span = Math.max(0.05, 1.0 - baseThreshold);
    const t = Math.max(0, Math.min(1, (probWin - baseThreshold) / span));
    return Number((curve.minMult + t * (curve.maxMult - curve.minMult)).toFixed(3));
  }
  // Smooth confidence scaling [0.85 .. 1.35] above threshold
  const span = Math.max(0.05, 1.0 - baseThreshold);
  const t = Math.max(0, Math.min(1, (probWin - baseThreshold) / span));
  return Number((0.85 + t * 0.5).toFixed(3));
}

function buildExecOptions({ timeframe, execProfile, config, runtimeSpecs, mlEntry }) {
  const maxLevCap = Number(config?.maxLeverageCap ?? 3.0);
  if (timeframe === '1h') {
    const base = runtimeSpecs.lock1h?.lockedWinner?.execOptions || {
      entryMode: 'LIMIT_PULLBACK',
      limitExpiryBars: 6,
      pendingPolicy: 'ignore',
      limitSameBarTp: 'close',
      cooldown: 4,
      warmup: 250,
      stopAtr: 3.2,
      minStopPct: 1.4,
      rewardRisk: 1.15,
      maxHoldBars: 96,
      beTriggerR: 0.43,
      beOffsetPct: 0.34,
      costPct: 0.1,
      slippagePct: 0.025,
    };
    const v41Amp = runtimeSpecs.v41Summary?.selectedOnBtcCalVal?.topPartial?.opts ||
      runtimeSpecs.v41Summary?.selectedOnBtcCalVal?.topVolNorm?.opts || {
        volNormRiskPct: 4.5,
        minLev: 1.5,
        maxLev: 2.8,
        tp1QtyPct: 50,
        tp1TriggerR: 0.95,
        rewardRisk: 2.0,
        tp1LockOffsetR: 0.65,
      };
    const mlExec = mlEntry?.execOptions || {};
    const merged = {
      ...base,
      ...v41Amp,
      ...mlExec,
      execProfile: execProfile || 'EXCHANGE_POST_ONLY',
      fundingPctPer8h: 0.01,
    };
    merged.maxLev = Math.min(maxLevCap, Number(merged.maxLev ?? maxLevCap));
    merged.minLev = Math.min(merged.maxLev, Number(merged.minLev ?? 1.0));
    return merged;
  }

  // 15m
  const base15 = runtimeSpecs.lock15m?.winner?.execOptions || {
    entryMode: 'LIMIT_PULLBACK',
    limitExpiryBars: 16,
    pendingPolicy: 'ignore',
    limitSameBarTp: 'close',
    warmup: 250,
    stopAtr: 5.5,
    minStopPct: 1.6,
    rewardRisk: 2.0,
    maxHoldBars: 240,
    beTriggerR: 0.44,
    beOffsetPct: 0.38,
    cooldown: 12,
    costPct: 0.1,
    slippagePct: 0.025,
  };
  const mlExec15 = mlEntry?.execOptions || {};
  const merged15 = {
    ...base15,
    volNormRiskPct: 2.2,
    minLev: 0.75,
    maxLev: Math.min(maxLevCap, 1.5),
    ...mlExec15,
    execProfile: execProfile || 'EXCHANGE_POST_ONLY',
    fundingPctPer8h: 0.01,
  };
  merged15.maxLev = Math.min(maxLevCap, Number(merged15.maxLev ?? maxLevCap));
  merged15.minLev = Math.min(merged15.maxLev, Number(merged15.minLev ?? 0.75));
  return merged15;
}

/**
 * Evaluates causal signals, optional v5 ML probability filtering, and simulation on a dataset.
 */
export function evaluateStrategy({
  dataset,
  fundingRates = [],
  timeframe = '1h',
  symbol = 'BTCUSDT.P',
  exchange = 'OKX',
  execProfile = 'EXCHANGE_POST_ONLY',
  mlEnabled = true,
  config,
  runtimeSpecs,
}) {
  const tf = String(timeframe).toLowerCase();
  const isBtc = String(symbol).toUpperCase().startsWith('BTC');

  let rawSignals = [];
  if (tf === '1h') {
    const spec1h = runtimeSpecs.lock1h?.lockedWinner?.signalSpec;
    if (!spec1h) throw new Error('Missing locked 1h signalSpec in research/results_1h/selection-lock.json');
    rawSignals = generateSignals1h(dataset, spec1h);
  } else if (tf === '15m') {
    const spec15 = runtimeSpecs.lock15m?.winner?.fullSpec;
    if (!spec15) throw new Error('Missing locked 15m signalSpec in research/results_v4/lock_15m_r3.json');
    rawSignals = generateSignals15mV4(dataset, spec15);
  } else {
    throw new Error(`Unsupported strategy timeframe: ${timeframe}`);
  }

  const mlBundle = isBtc ? runtimeSpecs.mlModelsBtc : runtimeSpecs.mlModelsAlt;
  const mlEntry = mlEnabled ? resolveMlModelEntry(mlBundle, tf, symbol) : null;
  const canScoreMl = Boolean(
    mlEnabled &&
      mlEntry &&
      runtimeSpecs.featuresV5Mod?.extractCandidateFeaturesV5 &&
      (runtimeSpecs.mlInfMod?.scoreCandidateV5 || runtimeSpecs.mlInfMod?.predictProbaV5),
  );

  const alignFn = runtimeSpecs.fetchDerivsMod?.alignFundingToBarsCausal || runtimeSpecs.simV5Mod?.alignFundingToBarsCausal;
  const alignedFunding = alignFn && fundingRates.length > 0
    ? alignFn(dataset.rows, fundingRates)
    : null;

  const featureCtx = canScoreMl && runtimeSpecs.featuresV5Mod?.precomputeFeatureContextV5
    ? runtimeSpecs.featuresV5Mod.precomputeFeatureContextV5(dataset, alignedFunding)
    : null;

  const modelSpec = mlEntry ? (mlEntry.model || mlEntry) : null;
  const tau = Number(modelSpec?.threshold ?? mlEntry?.threshold ?? mlEntry?.tau ?? mlEntry?.probThreshold ?? 0.55);
  const modelVersion = canScoreMl ? (mlEntry.version || modelSpec?.modelType || mlBundle?.version || 'v5.0-ML') : 'v4.1-fallback';

  const signalsAudit = [];
  const filteredSignals = [];

  for (const sig of rawSignals) {
    let probWin = null;
    let features = null;
    let decision = 'ACCEPTED';
    let sizeMult = 1.0;

    if (canScoreMl) {
      features = runtimeSpecs.featuresV5Mod.extractCandidateFeaturesV5(
        dataset,
        sig,
        sig.barIndex,
        alignedFunding,
        featureCtx,
      );
      if (typeof runtimeSpecs.mlInfMod.scoreCandidateV5 === 'function') {
        const res = runtimeSpecs.mlInfMod.scoreCandidateV5(features, modelSpec);
        probWin = typeof res === 'number' ? res : Number(res?.probWin ?? res?.prob ?? res?.probability);
        if (Number.isFinite(probWin)) {
          const passed = res && typeof res.pass === 'boolean' && modelSpec?.threshold !== undefined
            ? res.pass
            : probWin >= tau;
          if (!passed) {
            decision = 'ML_FILTERED';
          } else if (res && Number.isFinite(res.sizeMult) && res.sizeMult > 0) {
            sizeMult = res.sizeMult;
          } else {
            sizeMult = computeSizeMultFromProb(probWin, mlEntry, tau);
          }
        }
      } else {
        probWin = Number(runtimeSpecs.mlInfMod.predictProbaV5(features, modelSpec));
        if (Number.isFinite(probWin)) {
          if (probWin < tau) {
            decision = 'ML_FILTERED';
          } else {
            sizeMult = computeSizeMultFromProb(probWin, mlEntry, tau);
          }
        }
      }
    }

    const bar = dataset.rows[sig.barIndex];
    signalsAudit.push({
      exchange,
      symbol,
      timeframe: tf,
      barTime: bar.time,
      barIndex: sig.barIndex,
      side: sig.side,
      limitPrice: sig.limitPrice ?? null,
      atr: sig.atr ?? null,
      probWin,
      modelVersion,
      decision,
      sizeMult,
      features,
      meta: sig.meta ?? null,
    });

    if (decision === 'ACCEPTED') {
      filteredSignals.push({
        ...sig,
        sizeMult,
        meta: { ...(sig.meta || {}), probWin, modelVersion, sizeMult },
      });
    }
  }

  const execOptions = buildExecOptions({ timeframe: tf, execProfile, config, runtimeSpecs, mlEntry });
  const simOpts = {
    ...execOptions,
    start: 0,
    end: dataset.rows.length,
    intervalSeconds: dataset.intervalSeconds,
    fundingRows: fundingRates.length > 0 ? fundingRates : undefined,
  };

  const simResult = runtimeSpecs.simV5Mod?.simulateTradesV5
    ? runtimeSpecs.simV5Mod.simulateTradesV5(dataset.rows, filteredSignals, simOpts)
    : simulateTrades(dataset.rows, filteredSignals, simOpts);

  let equity = 1.0;
  let peakEq = 1.0;
  let fundingDragSum = 0;
  const equityCurve = [];
  const enrichedTrades = simResult.trades.map(t => {
    const entryRow = dataset.rows[t.entryIndex];
    const exitRow = dataset.rows[t.exitIndex];
    const factor = 1 + t.netPct / 100;
    equity = factor <= 0 ? 0 : equity * factor;
    if (equity > peakEq) peakEq = equity;
    const ddPct = peakEq > 0 ? ((peakEq - equity) / peakEq) * 100 : 100;
    fundingDragSum += t.fundingDragPct ?? 0;
    equityCurve.push({
      time: exitRow.time,
      equity: Number(equity.toFixed(6)),
      drawdownPct: Number(ddPct.toFixed(4)),
      openLev: t.lev ?? 1.0,
    });
    return {
      ...t,
      entryTime: entryRow.time,
      exitTime: exitRow.time,
      probWin: t.meta?.probWin ?? null,
    };
  });

  const activeOverlay = buildActiveOverlay(simResult, dataset.rows, signalsAudit);
  const summary = {
    exchange,
    symbol,
    timeframe: tf,
    execProfile: runtimeSpecs.simV5Mod?.simulateTradesV5 ? execProfile : 'STRICT_TAKER_V41',
    modelVersion,
    mlThreshold: canScoreMl ? tau : null,
    bars: dataset.rows.length,
    rawSignalsCount: rawSignals.length,
    acceptedSignalsCount: filteredSignals.length,
    count: simResult.count,
    wins: simResult.wins,
    losses: simResult.losses,
    winRatePct: simResult.winRatePct !== null ? Number(simResult.winRatePct.toFixed(2)) : 0,
    wilsonLower95Pct: simResult.count ? Number(wilsonLowerBound(simResult.wins, simResult.count, 1.96).toFixed(2)) : 0,
    profitFactor: simResult.profitFactor !== null ? Number(simResult.profitFactor.toFixed(2)) : 0,
    totalNetPct: Number((simResult.totalNetPct ?? 0).toFixed(2)),
    compoundedNetPct: Number((simResult.compoundedNetPct ?? 0).toFixed(2)),
    maxDrawdownPct: Number((simResult.maxDrawdownPct ?? 0).toFixed(2)),
    compoundedMaxDrawdownPct: Number((simResult.compoundedMaxDrawdownPct ?? 0).toFixed(2)),
    fundingDragPct: Number(fundingDragSum.toFixed(2)),
    exitReasons: simResult.exitReasons,
  };

  return {
    summary,
    execOptions,
    signalsAudit,
    trades: enrichedTrades,
    equityCurve,
    activeOverlay,
    openPosition: simResult.openPosition || null,
    pending: simResult.pending || null,
  };
}

function buildActiveOverlay(simResult, rows, signalsAudit) {
  const lastSig = signalsAudit.length > 0 ? signalsAudit[signalsAudit.length - 1] : null;
  const openPos = simResult.openPosition;
  const pending = simResult.pending;
  if (openPos) {
    const entryBar = rows[openPos.entryIndex];
    return {
      status: 'OPEN_POSITION',
      side: openPos.side,
      entryTime: entryBar?.time ?? null,
      entry: openPos.entry,
      limitPrice: openPos.limitPrice,
      stop: openPos.stop,
      initialStop: openPos.initialStop,
      tp1Price: openPos.tp1Price ?? null,
      target: openPos.target,
      beArmed: Boolean(openPos.beArmed),
      lock2Armed: Boolean(openPos.lock2Armed),
      lev: openPos.lev,
      probWin: openPos.meta?.probWin ?? lastSig?.probWin ?? null,
    };
  }
  if (pending) {
    const sigBar = rows[pending.signalIndex];
    const sigPrice = sigBar?.close ?? pending.limitPrice;
    const estStopDist = Math.max((pending.atr ?? 0) * (pending.stopAtr ?? 3.2), sigPrice * 0.014);
    const estStop = pending.limitPrice - pending.side * estStopDist;
    const estTarget = pending.limitPrice + pending.side * estStopDist * (pending.rewardRisk ?? 1.15);
    return {
      status: 'PENDING_LIMIT',
      side: pending.side,
      signalTime: sigBar?.time ?? null,
      limitPrice: pending.limitPrice,
      stop: estStop,
      target: estTarget,
      beArmed: false,
      probWin: pending.meta?.probWin ?? lastSig?.probWin ?? null,
    };
  }
  return {
    status: 'FLAT',
    lastSignal: lastSig
      ? {
          barTime: lastSig.barTime,
          side: lastSig.side,
          limitPrice: lastSig.limitPrice,
          probWin: lastSig.probWin,
          decision: lastSig.decision,
          modelVersion: lastSig.modelVersion,
        }
      : null,
  };
}

/**
 * Loads candles & funding either from SQLite store (if >= minBars) or from local data/*.json.
 */
export function loadOfflineOrDbDataset({ store, config, symbol, timeframe, minBars = 320 }) {
  const exchange = config.exchange || 'OKX';
  const dbCandles = store ? store.getCandles({ exchange, symbol, timeframe, limit: 5000 }) : [];
  const dbFunding = store ? store.getFundingRates({ exchange, symbol, limit: 3000 }) : [];

  if (dbCandles.length >= minBars) {
    return {
      source: 'sqlite',
      dataset: buildDatasetFromCandles({ symbol, timeframe, rows: dbCandles }),
      fundingRates: dbFunding,
    };
  }

  const localPath = resolveLocalDatasetPath(config.repoRoot, { exchange, symbol, timeframe });
  if (localPath) {
    const dataset = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    const fundingFile = path.join(
      config.repoRoot,
      'data',
      `okx_${symbol.toLowerCase().replace('usdt.p', 'usdt').replace('usdt', 'usdt')}_swap_funding_3y.json`,
    );
    const fundingJson = readJsonIfExists(fundingFile);
    return {
      source: path.relative(config.repoRoot, localPath),
      dataset,
      fundingRates: fundingJson?.rows || dbFunding,
    };
  }

  if (dbCandles.length > 0) {
    return {
      source: 'sqlite-partial',
      dataset: buildDatasetFromCandles({ symbol, timeframe, rows: dbCandles }),
      fundingRates: dbFunding,
    };
  }

  throw new Error(`No candles found in SQLite or data/ for ${exchange} ${symbol} ${timeframe}`);
}

/**
 * Live runtime daemon: syncs closed candles + funding, evaluates ML signals, persists state.
 */
export class StandaloneTradingDaemon {
  constructor({ config, store, runtimeSpecs, exchangeClient } = {}) {
    this.config = config;
    this.store = store;
    this.runtimeSpecs = runtimeSpecs;
    this.client = exchangeClient || createExchangeClient(config);
    this._timer = null;
    this._running = false;
    this.lastSyncAt = null;
    this.lastEvalAt = null;
    this.lastError = null;
    this.latestSnapshots = new Map();
  }

  async syncMarketData({ symbol, timeframe, bars = 1000 } = {}) {
    const tf = timeframe || this.config.timeframes[0] || '1h';
    const sym = symbol || this.config.symbols[0] || 'BTCUSDT.P';
    const exchange = this.config.exchange;

    const allCandles = new Map();
    let cursor = undefined;
    const batches = Math.ceil(bars / 300);
    for (let b = 0; b < batches; b++) {
      const chunk = await this.client.getClosedCandles({
        symbol: sym,
        timeframe: tf,
        limit: Math.min(300, bars - allCandles.size),
        afterMs: exchange === 'OKX' ? cursor : undefined,
        endTimeMs: exchange === 'BINANCE' ? cursor : undefined,
        history: b > 0,
      });
      if (!chunk || chunk.length === 0) break;
      for (const c of chunk) allCandles.set(c.time, c);
      cursor = chunk[0].time * 1000 - (exchange === 'BINANCE' ? 1 : 0);
      if (allCandles.size >= bars || chunk.length < 50) break;
    }

    const candleRows = Array.from(allCandles.values()).sort((a, b) => a.time - b.time);
    const savedCandles = this.store.upsertCandles({ exchange, symbol: sym, timeframe: tf, rows: candleRows });

    const fundingRows = await this.client.getFundingRates({ symbol: sym, limit: 100 });
    const savedFunding = this.store.upsertFundingRates({ exchange, symbol: sym, rows: fundingRows });

    this.lastSyncAt = new Date().toISOString();
    return {
      exchange,
      symbol: sym,
      timeframe: tf,
      candlesFetched: candleRows.length,
      candlesSaved: savedCandles,
      fundingFetched: fundingRows.length,
      fundingSaved: savedFunding,
      latestTime: candleRows.length ? candleRows[candleRows.length - 1].time : null,
    };
  }

  evaluateAndPersist({ symbol, timeframe, execProfile = 'EXCHANGE_POST_ONLY', mlEnabled = true } = {}) {
    const tf = timeframe || this.config.timeframes[0] || '1h';
    const sym = symbol || this.config.symbols[0] || 'BTCUSDT.P';
    const exchange = this.config.exchange;

    const { source, dataset, fundingRates } = loadOfflineOrDbDataset({
      store: this.store,
      config: this.config,
      symbol: sym,
      timeframe: tf,
    });

    const evalRes = evaluateStrategy({
      dataset,
      fundingRates,
      timeframe: tf,
      symbol: sym,
      exchange,
      execProfile,
      mlEnabled,
      config: this.config,
      runtimeSpecs: this.runtimeSpecs,
    });

    const runId = `live_${exchange}_${sym}_${tf}`;
    this.store.upsertSignalsAudit(evalRes.signalsAudit.slice(-100));
    this.store.upsertTrades({
      runId,
      exchange,
      symbol: sym,
      timeframe: tf,
      trades: evalRes.trades.slice(-200),
    });
    this.store.upsertEquityCurve({
      runId,
      exchange,
      symbol: sym,
      timeframe: tf,
      points: evalRes.equityCurve.slice(-300),
    });
    this.store.savePaperState(`${exchange}:${sym}:${tf}`, {
      summary: evalRes.summary,
      activeOverlay: evalRes.activeOverlay,
      openPosition: evalRes.openPosition,
      pending: evalRes.pending,
      executionMode: this.config.executionMode,
      dryRun: this.config.dryRun,
      source,
    });

    this.lastEvalAt = new Date().toISOString();
    const key = `${sym}:${tf}`;
    this.latestSnapshots.set(key, { ...evalRes, source, lastEvalAt: this.lastEvalAt });
    return { ...evalRes, source };
  }

  async runCycle() {
    for (const sym of this.config.symbols) {
      for (const tf of this.config.timeframes) {
        try {
          await this.syncMarketData({ symbol: sym, timeframe: tf, bars: 600 });
        } catch (err) {
          this.lastError = `Sync warning (${sym} ${tf}): ${err.message}`;
        }
        try {
          this.evaluateAndPersist({ symbol: sym, timeframe: tf });
        } catch (err) {
          this.lastError = `Eval warning (${sym} ${tf}): ${err.message}`;
        }
      }
    }
  }

  start(intervalMs = 60000) {
    if (this._running) return;
    this._running = true;
    const interrupted = this.store.recoverInterruptedOrders();
    if (interrupted > 0) {
      console.warn(`[standalone] Crash recovery: marked ${interrupted} interrupted order(s)`);
    }
    this.runCycle().catch(err => {
      this.lastError = err.message;
    });
    this._timer = setInterval(() => {
      this.runCycle().catch(err => {
        this.lastError = err.message;
      });
    }, intervalMs);
    this._timer.unref?.();
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
