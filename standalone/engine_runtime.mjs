import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { alignHtfIndices, validateContiguousRows } from '../research/fetch_binance_data.mjs';
import { generateSignals15mV4 } from '../research/signals_15m_v4.mjs';
import { generateSignals1h } from '../research/signals_1h.mjs';
import { simulateTrades, wilsonLowerBound } from '../research/sim_engine.mjs';
import { normalizeRiskTier, RISK_TIER_SPECS } from './config.mjs';
import { BinanceFuturesClient } from './exchange_binance.mjs';
import { OkxClient } from './exchange_okx.mjs';
import {
  isEquitySymbol,
  resolveEquityInstrument,
  YahooEquitiesClient,
} from './market_equities.mjs';

export function intervalSecondsFor(timeframe) {
  const tf = String(timeframe || '1h').toLowerCase();
  if (tf === '15m') return 900;
  if (tf === '1h') return 3600;
  if (tf === '4h') return 14400;
  if (tf === '1d') return 86400;
  if (tf === '1wk' || tf === '1w') return 604800;
  throw new Error(`Unsupported timeframe: ${timeframe}`);
}

export function normalizeAssetSymbol(symbol) {
  const s = String(symbol || 'BTCUSDT.P').trim().toUpperCase();
  if (s === 'BTC' || s === 'BTCUSDT' || s === 'BTC-USDT-SWAP' || s === 'BTCUSDT.P') return 'BTCUSDT.P';
  if (s === 'ETH' || s === 'ETHUSDT' || s === 'ETH-USDT-SWAP' || s === 'ETHUSDT.P') return 'ETHUSDT.P';
  if (s === 'SOL' || s === 'SOLUSDT' || s === 'SOL-USDT-SWAP' || s === 'SOLUSDT.P') return 'SOLUSDT.P';
  if (s === 'BNB' || s === 'BNBUSDT' || s === 'BNB-USDT-SWAP' || s === 'BNBUSDT.P') return 'BNBUSDT.P';
  const eq = resolveEquityInstrument(s);
  if (eq) return eq.tradeSymbol;
  return s;
}

export function createExchangeClient(config, exchangeOverride, symbolHint) {
  if ((symbolHint && isEquitySymbol(symbolHint)) || exchangeOverride === 'YAHOO') {
    return new YahooEquitiesClient();
  }
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
 * Loads v6.0, v5.0 ML, and locked v4.1 specs/models when present on disk.
 */
export async function loadRuntimeSpecs(repoRoot) {
  const researchDir = path.join(repoRoot, 'research');
  const lock1h = readJsonIfExists(path.join(researchDir, 'results_1h', 'selection-lock.json'));
  const lock15m = readJsonIfExists(path.join(researchDir, 'results_v4', 'lock_15m_r3.json'));
  const v41Summary = readJsonIfExists(path.join(researchDir, 'results_v4', 'v41_profit_amp_summary.json'));

  const mlModelsBtc = readJsonIfExists(path.join(researchDir, 'results_v5', 'ml_models_btc_v5.json'));
  const mlModelsAlt = readJsonIfExists(path.join(researchDir, 'results_v5', 'ml_models_alt_v5.json'));

  const modelsBtcBnb5y = readJsonIfExists(path.join(researchDir, 'results_v6', 'models_btc_bnb_5y.json'));
  const modelsEthSol5y = readJsonIfExists(path.join(researchDir, 'results_v6', 'models_eth_sol_5y.json'));
  const modelsStocksV6 = readJsonIfExists(path.join(researchDir, 'results_v6', 'models_stocks_v6.json'));
  const summaryBtcBnb5y = readJsonIfExists(path.join(researchDir, 'results_v6', 'crypto_btc_bnb_5y.json'));
  const summaryEthSol5y = readJsonIfExists(path.join(researchDir, 'results_v6', 'crypto_eth_sol_5y.json'));
  const summaryStocksV6 = readJsonIfExists(path.join(researchDir, 'results_v6', 'stocks_indices_5y_10y.json'));

  const modelsV7BtcBnb = readJsonIfExists(path.join(researchDir, 'results_v7', 'models_v7_btc_bnb.json'));
  const modelsV7EthSol = readJsonIfExists(path.join(researchDir, 'results_v7', 'models_v7_eth_sol.json'));
  const summaryV7BtcBnb = readJsonIfExists(path.join(researchDir, 'results_v7', 'btc_bnb_v7_5y.json'));
  const summaryV7EthSol = readJsonIfExists(path.join(researchDir, 'results_v7', 'eth_sol_v7_5y.json'));
  const frontierV7Summary = readJsonIfExists(path.join(researchDir, 'results_v7', 'frontier_75wr_30mo_summary.json'));

  const [
    simV5Mod,
    simV6Mod,
    simV7Mod,
    fetchDerivsMod,
    featuresV5Mod,
    mlInfMod,
    altSignalsMod,
    suiteV6BtcBnbMod,
    suiteV6EthSolMod,
    suiteV6StocksMod,
    highWrV7BtcBnbMod,
    highWrV7EthSolMod,
    frontierV7Mod,
  ] = await Promise.all([
    tryImportOptional(path.join(researchDir, 'sim_engine_v5.mjs')),
    tryImportOptional(path.join(researchDir, 'sim_engine_v6.mjs')),
    tryImportOptional(path.join(researchDir, 'sim_engine_v7.mjs')),
    tryImportOptional(path.join(researchDir, 'fetch_okx_derivs.mjs')),
    tryImportOptional(path.join(researchDir, 'features_v5.mjs')),
    tryImportOptional(path.join(researchDir, 'ml_inference.mjs')),
    tryImportOptional(path.join(researchDir, 'signals_v5_alt.mjs')),
    tryImportOptional(path.join(researchDir, 'suite_v6_btc_bnb.mjs')),
    tryImportOptional(path.join(researchDir, 'suite_v6_eth_sol.mjs')),
    tryImportOptional(path.join(researchDir, 'suite_v6_stocks.mjs')),
    tryImportOptional(path.join(researchDir, 'high_wr_v7_btc_bnb.mjs')),
    tryImportOptional(path.join(researchDir, 'high_wr_v7_eth_sol.mjs')),
    tryImportOptional(path.join(researchDir, 'portfolio_v7_30pct_frontier.mjs')),
  ]);

  return {
    lock1h,
    lock15m,
    v41Summary,
    mlModelsBtc,
    mlModelsAlt,
    modelsBtcBnb5y,
    modelsEthSol5y,
    modelsStocksV6,
    summaryBtcBnb5y,
    summaryEthSol5y,
    summaryStocksV6,
    modelsV7BtcBnb,
    modelsV7EthSol,
    summaryV7BtcBnb,
    summaryV7EthSol,
    frontierV7Summary,
    simV5Mod,
    simV6Mod,
    simV7Mod,
    fetchDerivsMod,
    featuresV5Mod,
    mlInfMod,
    altSignalsMod,
    suiteV6BtcBnbMod,
    suiteV6EthSolMod,
    suiteV6StocksMod,
    highWrV7BtcBnbMod,
    highWrV7EthSolMod,
    frontierV7Mod,
    hasV5Engine: Boolean(simV5Mod?.simulateTradesV5),
    hasV5Ml: Boolean(featuresV5Mod && mlInfMod && mlModelsBtc),
    hasV6Engine: Boolean(simV6Mod?.simulateTradesV6),
    hasV6CryptoModels: Boolean(modelsBtcBnb5y || modelsEthSol5y),
    hasV6StockModels: Boolean(modelsStocksV6),
    hasV7Engine: Boolean(simV7Mod?.simulateTradesV7),
    hasV7Models: Boolean(modelsV7BtcBnb || modelsV7EthSol),
    hasV7Frontier: Boolean(frontierV7Summary),
  };
}

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

function buildWeeklyFromDaily(dailyRows) {
  const buckets = new Map();
  for (const r of dailyRows) {
    // Align UTC week starting Monday (epoch 1970-01-05 is Monday = 4*86400)
    const offset = 3 * 86400;
    const weekStart = Math.floor((r.time + offset) / 604800) * 604800 - offset;
    let b = buckets.get(weekStart);
    if (!b) {
      b = { time: weekStart, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 };
      buckets.set(weekStart, b);
    } else {
      if (r.high > b.high) b.high = r.high;
      if (r.low < b.low) b.low = r.low;
      b.close = r.close;
      b.volume += r.volume ?? 0;
    }
  }
  const rows = Array.from(buckets.values()).sort((a, b) => a.time - b.time);
  return rows.length > 1 ? rows.slice(0, -1) : rows;
}

function alignMonotonicHtf(ltfRows, htfRows, htfSec) {
  const aligned = new Array(ltfRows.length);
  let j = -1;
  for (let i = 0; i < ltfRows.length; i++) {
    while (j + 1 < htfRows.length && htfRows[j + 1].time + htfSec <= ltfRows[i].time) {
      j++;
    }
    aligned[i] = j;
  }
  return aligned;
}

/**
 * Builds causal dataset from closed candles. Supports both contiguous crypto bars
 * and market-hour equities bars (non-contiguous weekends/holidays).
 */
export function buildDatasetFromCandles({ symbol, timeframe, rows, htfOverrides = {} }) {
  const intervalSeconds = intervalSecondsFor(timeframe);
  const isEq = isEquitySymbol(symbol);
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
        ...(r.takerBuyVol !== undefined ? { takerBuyVol: r.takerBuyVol } : {}),
        ...(r.trades !== undefined ? { trades: r.trades } : {}),
      });
    }
  }
  const sorted = Array.from(dedup.values()).sort((a, b) => a.time - b.time);
  if (sorted.length < 2) {
    throw new Error(`Insufficient closed candles (${sorted.length}) for ${symbol} ${timeframe}`);
  }

  let workingRows = sorted;
  if (!isEq) {
    let startIdx = sorted.length - 1;
    while (startIdx > 0 && sorted[startIdx].time - sorted[startIdx - 1].time === intervalSeconds) {
      startIdx--;
    }
    workingRows = sorted.slice(startIdx);
    validateContiguousRows(workingRows, intervalSeconds, `${symbol} ${timeframe}`);
  }

  const htf = {};
  if (isEq) {
    if (timeframe === '1d') {
      const wk = htfOverrides['1wk'] || buildWeeklyFromDaily(workingRows);
      if (wk.length > 0) {
        htf['1wk'] = {
          interval: '1wk',
          intervalSeconds: 604800,
          rows: wk,
          alignedIndex: alignMonotonicHtf(workingRows, wk, 604800),
        };
      }
    }
  } else {
    const neededHtfs = timeframe === '15m'
      ? [['1h', 3600], ['4h', 14400]]
      : [['4h', 14400], ['1d', 86400]];

    for (const [htfName, htfSec] of neededHtfs) {
      const rawHtf = Array.isArray(htfOverrides[htfName]) && htfOverrides[htfName].length > 0
        ? htfOverrides[htfName]
        : buildClosedHtfFromLtf(workingRows, intervalSeconds, htfSec);
      if (rawHtf.length === 0) continue;
      const firstValidHtfClose = rawHtf[0].time + htfSec;
      if (workingRows[0].time < firstValidHtfClose) {
        const trimIdx = workingRows.findIndex(r => r.time >= firstValidHtfClose);
        if (trimIdx > 0) workingRows.splice(0, trimIdx);
      }
      const alignedIndex = alignHtfIndices(workingRows, rawHtf, htfSec);
      htf[htfName] = {
        interval: htfName,
        intervalSeconds: htfSec,
        rows: rawHtf,
        alignedIndex,
      };
    }
  }

  return {
    symbol,
    interval: timeframe,
    intervalSeconds,
    allowTimeGaps: isEq,
    count: workingRows.length,
    firstTime: workingRows[0].time,
    lastTime: workingRows[workingRows.length - 1].time,
    rows: workingRows,
    htf,
  };
}

export function resolveLocalDatasetPath(repoRoot, { symbol = 'BTCUSDT.P', timeframe = '1h', prefer5y = true } = {}) {
  const sym = normalizeAssetSymbol(symbol);
  const tf = String(timeframe || '1h').toLowerCase();
  const dataDir = path.join(repoRoot, 'data');

  const eq = resolveEquityInstrument(sym);
  if (eq) {
    const p10 = path.join(dataDir, eq.dataset10y);
    const p1h = path.join(dataDir, eq.dataset2y1h);
    if (tf === '1h' && fs.existsSync(p1h)) return p1h;
    if (fs.existsSync(p10)) return p10;
    return null;
  }

  const candidates = [];
  if (sym.startsWith('BTC')) {
    if (tf === '1h') {
      if (prefer5y) candidates.push('crypto5y_btcusdt_1h.json');
      candidates.push('okx_btcusdt_swap_1h_3y.json', 'okx_btcusdt_1h_3y.json', 'btcusdt_1h_24m.json');
    } else if (tf === '15m') {
      if (prefer5y) candidates.push('crypto5y_btcusdt_15m.json');
      candidates.push('okx_btcusdt_swap_15m_3y.json', 'okx_btcusdt_15m_3y.json', 'btcusdt_15m_12m.json');
    }
  } else if (sym.startsWith('ETH')) {
    if (tf === '1h') {
      if (prefer5y) candidates.push('crypto5y_ethusdt_1h.json');
      candidates.push('okx_ethusdt_swap_1h_3y.json', 'ethusdt_1h_12m.json');
    } else if (tf === '15m') {
      if (prefer5y) candidates.push('crypto5y_ethusdt_15m.json');
      candidates.push('ethusdt_15m_6m.json');
    }
  } else if (sym.startsWith('SOL')) {
    if (tf === '1h') {
      if (prefer5y) candidates.push('crypto5y_solusdt_1h.json');
      candidates.push('okx_solusdt_swap_1h_3y.json');
    } else if (tf === '15m') {
      if (prefer5y) candidates.push('crypto5y_solusdt_15m.json');
    }
  } else if (sym.startsWith('BNB')) {
    if (tf === '1h') {
      candidates.push('crypto5y_bnbusdt_1h.json', 'okx_bnbusdt_swap_1h_3y.json');
    } else if (tf === '15m') {
      if (prefer5y) candidates.push('crypto5y_bnbusdt_15m.json');
    }
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
  const sym = normalizeAssetSymbol(symbol);
  const baseCoin = sym.replace('USDT.P', '').replace('USDT', '');
  const pairCoin = `${baseCoin}USDT`;
  const candidates = [
    mlBundle.models?.[pairCoin],
    mlBundle.models?.[sym],
    mlBundle.models?.[baseCoin],
    mlBundle.models?.[`OKX:${sym}`],
    mlBundle.models?.[tf],
    mlBundle.models?.[`${sym}_${tf}`],
    mlBundle.byTimeframe?.[tf],
    mlBundle.streams?.[tf],
    mlBundle[tf],
    mlBundle[baseCoin],
  ].filter(Boolean);

  for (const entry of candidates) {
    if (entry && typeof entry === 'object') return entry;
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
  const span = Math.max(0.05, 1.0 - baseThreshold);
  const t = Math.max(0, Math.min(1, (probWin - baseThreshold) / span));
  return Number((0.85 + t * 0.5).toFixed(3));
}

function generateEquityFallbackSignals(dataset) {
  const rows = dataset.rows;
  const n = rows.length;
  const closes = rows.map(r => r.close);

  // SMA200
  const sma200 = new Float64Array(n).fill(NaN);
  let sum200 = 0;
  for (let i = 0; i < n; i++) {
    sum200 += closes[i];
    if (i >= 200) sum200 -= closes[i - 200];
    if (i >= 199) sma200[i] = sum200 / 200;
  }

  // ATR14
  const atr14 = new Float64Array(n).fill(NaN);
  let atrSum = 0;
  for (let i = 0; i < n; i++) {
    const prevC = i === 0 ? closes[0] : closes[i - 1];
    const tr = Math.max(rows[i].high - rows[i].low, Math.abs(rows[i].high - prevC), Math.abs(rows[i].low - prevC));
    if (i < 13) atrSum += tr;
    else if (i === 13) { atrSum += tr; atr14[i] = atrSum / 14; }
    else atr14[i] = atr14[i - 1] + (tr - atr14[i - 1]) / 14;
  }

  // RSI(2)
  const rsi2 = new Float64Array(n).fill(NaN);
  let up = 0;
  let dn = 0;
  for (let i = 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    const u = Math.max(ch, 0);
    const d = Math.max(-ch, 0);
    if (i < 2) { up += u; dn += d; }
    else if (i === 2) {
      up = (up + u) / 2;
      dn = (dn + d) / 2;
      rsi2[i] = dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
    } else {
      up += (u - up) / 2;
      dn += (d - dn) / 2;
      rsi2[i] = dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
    }
  }

  const signals = [];
  for (let i = 200; i < n; i++) {
    const r = rows[i];
    const rng = r.high - r.low;
    const atr = atr14[i];
    if (!Number.isFinite(atr) || atr <= 0 || rng <= 0 || !Number.isFinite(rsi2[i]) || !Number.isFinite(sma200[i])) {
      continue;
    }
    const ibs = (r.close - r.low) / rng;
    if (r.close > sma200[i] && ibs <= 0.25 && rsi2[i] <= 20) {
      signals.push({
        barIndex: i,
        side: 1,
        atr,
        entryMode: 'MARKET_NEXT_OPEN',
        meta: { ibs: Number(ibs.toFixed(3)), rsi2: Number(rsi2[i].toFixed(1)), regime: 'BULL_PULLBACK' },
      });
    } else if (r.close < sma200[i] && ibs >= 0.80 && rsi2[i] >= 85) {
      signals.push({
        barIndex: i,
        side: -1,
        atr,
        entryMode: 'MARKET_NEXT_OPEN',
        meta: { ibs: Number(ibs.toFixed(3)), rsi2: Number(rsi2[i].toFixed(1)), regime: 'BEAR_RALLY' },
      });
    }
  }
  return signals;
}

function buildExecOptions({ symbol, timeframe, execProfile, config, runtimeSpecs, mlEntry }) {
  const maxLevCap = Number(config?.maxLeverageCap ?? 3.0);
  const sym = normalizeAssetSymbol(symbol);
  const structuralExec = mlEntry?.structuralSpec?.execOptions || mlEntry?.execOptions || {};
  if (isEquitySymbol(sym)) {
    return {
      entryMode: 'MARKET_NEXT_OPEN',
      warmup: 200,
      cooldown: 2,
      stopAtr: 2.2,
      minStopPct: 1.0,
      rewardRisk: 1.25,
      maxHoldBars: timeframe === '1h' ? 48 : 12,
      beTriggerR: 0.45,
      beOffsetPct: 0.15,
      costPct: 0.04,
      slippagePct: 0.015,
      fixedLev: 1.0,
      fundingPctPer8h: 0,
      allowTimeGaps: true,
      execProfile: 'EQUITY_ETF',
      ...structuralExec,
    };
  }

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
    const v41Amp = runtimeSpecs.v41Summary?.selectedOnBtcCalVal?.topPartial?.opts || {
      volNormRiskPct: 4.5,
      minLev: 1.5,
      maxLev: 2.8,
      tp1QtyPct: 50,
      tp1TriggerR: 0.95,
      rewardRisk: 2.0,
      tp1LockOffsetR: 0.65,
    };
    const merged = {
      ...base,
      ...(Object.keys(structuralExec).length > 0 ? {} : v41Amp),
      ...structuralExec,
      execProfile: execProfile || 'EXCHANGE_POST_ONLY',
      fundingPctPer8h: 0.01,
    };
    merged.maxLev = Math.min(maxLevCap, Number(merged.maxLev ?? maxLevCap));
    merged.minLev = Math.min(merged.maxLev, Number(merged.minLev ?? 1.0));
    return merged;
  }

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
  const merged15 = {
    ...base15,
    volNormRiskPct: 2.2,
    minLev: 0.75,
    maxLev: Math.min(maxLevCap, 1.5),
    ...structuralExec,
    execProfile: execProfile || 'EXCHANGE_POST_ONLY',
    fundingPctPer8h: 0.01,
  };
  merged15.maxLev = Math.min(maxLevCap, Number(merged15.maxLev ?? maxLevCap));
  merged15.minLev = Math.min(merged15.maxLev, Number(merged15.minLev ?? 0.75));
  return merged15;
}

/**
 * Computes live/historical macro & orderflow regime telemetry for the Command Center UI.
 */
export function computeRegimeTelemetry({ repoRoot, dataset, fundingRates = [], macroData = null, symbol }) {
  const sym = normalizeAssetSymbol(symbol);
  const rows = dataset?.rows || [];
  let takerBuyRatio = null;
  let cvd24hPct = null;
  if (rows.length > 0) {
    const tail = rows.slice(-24);
    let volSum = 0;
    let buySum = 0;
    for (const r of tail) {
      if (Number.isFinite(r.takerBuyVol) && Number.isFinite(r.volume) && r.volume > 0) {
        volSum += r.volume;
        buySum += r.takerBuyVol;
      }
    }
    if (volSum > 0) {
      takerBuyRatio = Number((buySum / volSum).toFixed(4));
      cvd24hPct = Number((((2 * buySum - volSum) / volSum) * 100).toFixed(2));
    }
  }

  let fundingRateBps = null;
  if (Array.isArray(fundingRates) && fundingRates.length > 0) {
    const lastF = fundingRates[fundingRates.length - 1];
    if (Number.isFinite(lastF?.fundingRate)) {
      fundingRateBps = Number((lastF.fundingRate * 10000).toFixed(2));
    }
  }

  let vix = null;
  let tnx = null;
  let macroTime = null;
  const loadedMacro = macroData || readJsonIfExists(path.join(repoRoot, 'data', 'equities10y_macro_1d.json'));
  if (loadedMacro) {
    const vixRows = loadedMacro.vixRows || loadedMacro['^VIX'] || loadedMacro.vix || [];
    const tnxRows = loadedMacro.tnxRows || loadedMacro['^TNX'] || loadedMacro.tnx || [];
    if (Array.isArray(vixRows) && vixRows.length > 0) {
      const last = vixRows[vixRows.length - 1];
      vix = Number((last.close ?? last.value ?? loadedMacro.vix)?.toFixed?.(2) ?? last.close);
      macroTime = last.time ?? macroTime;
    } else if (Number.isFinite(loadedMacro.vix)) {
      vix = Number(loadedMacro.vix.toFixed(2));
    }
    if (Array.isArray(tnxRows) && tnxRows.length > 0) {
      const last = tnxRows[tnxRows.length - 1];
      tnx = Number((last.close ?? last.value ?? loadedMacro.tnx)?.toFixed?.(2) ?? last.close);
    } else if (Number.isFinite(loadedMacro.tnx)) {
      tnx = Number(loadedMacro.tnx.toFixed(2));
    }
  }

  let vixRegime = 'UNKNOWN';
  if (Number.isFinite(vix)) {
    vixRegime = vix < 15 ? 'CALM' : vix < 22 ? 'NORMAL' : vix < 30 ? 'ELEVATED' : 'STRESS';
  }

  return {
    assetClass: isEquitySymbol(sym) ? 'EQUITY_ETF' : 'CRYPTO_PERP',
    vix,
    vixRegime,
    tnx,
    macroTime,
    fundingRateBps,
    takerBuyRatio,
    cvd24hPct,
  };
}

export function computeLiquidationDistance(overlay, currentPrice, { mmr = 0.005, fallbackLev = 1.5 } = {}) {
  const px = Number(currentPrice);
  if (!Number.isFinite(px) || px <= 0) {
    return { hasPosition: false, status: 'UNKNOWN', bufferPct: null, liqPrice: null, lev: fallbackLev, mmr };
  }
  const hasPos = overlay?.status === 'OPEN_POSITION' || overlay?.status === 'PENDING_LIMIT';
  const side = overlay?.side === -1 ? -1 : 1;
  const entryPrice = Number(overlay?.entry ?? overlay?.limitPrice ?? px);
  const lev = Math.max(1.0, Number(overlay?.lev ?? fallbackLev));
  const distFrac = Math.max(0.01, 1 / lev - mmr);
  const liqPrice = side === 1 ? entryPrice * (1 - distFrac) : entryPrice * (1 + distFrac);
  const bufferPct = side === 1
    ? ((px - liqPrice) / px) * 100
    : ((liqPrice - px) / px) * 100;
  const roundedBuf = Number(bufferPct.toFixed(2));
  const status = !hasPos
    ? 'FLAT_EST'
    : roundedBuf >= 20
      ? 'SAFE'
      : roundedBuf >= 10
        ? 'MODERATE'
        : 'TIGHT';
  return {
    hasPosition: overlay?.status === 'OPEN_POSITION',
    pending: overlay?.status === 'PENDING_LIMIT',
    side,
    entryPrice: Number(entryPrice.toFixed(2)),
    currentPrice: Number(px.toFixed(2)),
    liqPrice: Number(Math.max(0, liqPrice).toFixed(2)),
    lev: Number(lev.toFixed(2)),
    mmr,
    bufferPct: roundedBuf,
    status,
  };
}

function normalizeFrontierTierNode(node, prof) {
  if (!node || typeof node !== 'object') return null;
  const profData = node.profiles?.[prof] || null;
  const fullRaw = profData?.full5y_60m || profData?.full5y || node.full5y_60m || node.full5y || null;
  const holdoutRaw = profData?.blindHoldoutY5_12m || profData?.holdoutY5 || node.blindHoldoutY5_12m || node.holdoutY5 || null;
  const calValRaw = profData?.calVal_48m || node.calVal_48m || null;
  const stripTable = (block) => {
    if (!block || typeof block !== 'object') return null;
    const { monthlyTable: _omit, ...rest } = block;
    return rest;
  };
  return {
    tierKey: node.tierKey || node.constraints?.key || null,
    constraints: node.constraints || null,
    weightPreset: node.weightPreset || null,
    weights: node.weights || null,
    activeStreams: node.activeStreams || null,
    levScale: node.levScale ?? null,
    maxTotalOpenLev: node.maxTotalOpenLev ?? null,
    full5y: stripTable(fullRaw),
    holdoutY5: stripTable(holdoutRaw),
    calVal_48m: stripTable(calValRaw),
  };
}

export function runV7FrontierPortfolio({ runtimeSpecs, config, riskTier, execProfile = 'EXCHANGE_POST_ONLY' } = {}) {
  const tierId = normalizeRiskTier(riskTier || config?.riskTier || 'SAFE_75WR');
  const tierSpec = RISK_TIER_SPECS[tierId];
  const prof = String(execProfile || 'EXCHANGE_POST_ONLY').toUpperCase();
  const frontier = runtimeSpecs?.frontierV7Summary;

  if (frontier && typeof frontier === 'object') {
    const profBlock = frontier.profiles?.[prof] || frontier.tracks?.[prof] || frontier[prof] || frontier.tiers || frontier;
    const tiersMap = profBlock?.tiers || frontier.tiers || profBlock;
    const rawSelected = tiersMap?.[tierSpec.frontierKey] || tiersMap?.[tierId] || null;
    const allTiers = {};
    for (const [k, spec] of Object.entries(RISK_TIER_SPECS)) {
      const node = tiersMap?.[spec.frontierKey] || tiersMap?.[k] || null;
      if (node) allTiers[k] = normalizeFrontierTierNode(node, prof);
    }
    if (rawSelected) {
      const selected = normalizeFrontierTierNode(rawSelected, prof);
      const profData = rawSelected.profiles?.[prof] || null;
      const fullRaw = profData?.full5y_60m || profData?.full5y || rawSelected.full5y_60m || rawSelected.full5y || null;
      return {
        ready: true,
        source: 'research/results_v7/frontier_75wr_30mo_summary.json',
        execProfile: prof,
        riskTier: tierId,
        tierSpec,
        selectedTier: selected,
        tiers: allTiers,
        target30MoQuestion: frontier.target30MoQuestion || null,
        streams: fullRaw?.perStream || frontier.streams || frontier.streamSummaries || frontier.calValStreamScreening || null,
        monthlyTable: fullRaw?.monthlyTable || rawSelected.monthlyTable || null,
      };
    }
  }

  return {
    ready: false,
    source: 'pending-v7-frontier',
    execProfile: prof,
    riskTier: tierId,
    tierSpec,
    selectedTier: null,
    tiers: {},
    streams: {
      btcBnb: Boolean(runtimeSpecs?.summaryV7BtcBnb),
      ethSol: Boolean(runtimeSpecs?.summaryV7EthSol),
    },
    monthlyTable: null,
  };
}

/**
 * Evaluates causal signals, ML probability filtering, and simulation on any of the v6.0 / v7.0 assets.
 */
export function evaluateStrategy({
  dataset,
  fundingRates = [],
  macroData = null,
  timeframe = '1h',
  symbol = 'BTCUSDT.P',
  exchange = 'OKX',
  execProfile,
  mlEnabled = true,
  version = 'auto',
  riskTier,
  config,
  runtimeSpecs,
}) {
  const sym = normalizeAssetSymbol(symbol);
  const tf = String(timeframe).toLowerCase();
  const isEq = isEquitySymbol(sym);
  const effectiveProfile = execProfile || (isEq ? 'EQUITY_ETF' : 'EXCHANGE_POST_ONLY');
  const effTier = normalizeRiskTier(riskTier || config?.riskTier || 'SAFE_75WR');
  const ver = String(version || 'auto').toLowerCase();
  const regime = computeRegimeTelemetry({
    repoRoot: config.repoRoot,
    dataset,
    fundingRates,
    macroData,
    symbol: sym,
  });

  const alignFn = runtimeSpecs.fetchDerivsMod?.alignFundingToBarsCausal || runtimeSpecs.simV5Mod?.alignFundingToBarsCausal;
  const alignedFunding = alignFn && fundingRates.length > 0
    ? alignFn(dataset.rows, fundingRates)
    : null;

  // v7.0 High-WR path (when v7 modules + models are present and requested/auto for crypto)
  const v7Runner = (!isEq && (ver === 'v7' || ver === 'auto'))
    ? ((sym === 'BTCUSDT.P' || sym === 'BNBUSDT.P')
        ? runtimeSpecs.highWrV7BtcBnbMod?.evaluateSingleStreamV7
        : runtimeSpecs.highWrV7EthSolMod?.evaluateSingleStreamV7)
    : null;

  if (typeof v7Runner === 'function') {
    const v7Res = v7Runner({
      symbol: sym,
      timeframe: tf,
      dataset,
      fundingRates,
      alignedFunding,
      execProfile: effectiveProfile,
      mlEnabled,
      riskTier: effTier,
      maxLeverageCap: config.maxLeverageCap,
    });
    if (v7Res && v7Res.summary) {
      const lastClose = dataset.rows[dataset.rows.length - 1]?.close;
      const liqDist = computeLiquidationDistance(v7Res.activeOverlay, lastClose, {
        fallbackLev: v7Res.execOptions?.minLev ?? 1.5,
      });
      return {
        ...v7Res,
        regime: v7Res.regime || regime,
        liquidationDistance: v7Res.liquidationDistance || liqDist,
      };
    }
  }

  // Check if dedicated v6.0 suite module exposes a clean runtime runner for this asset
  const v6SuiteRunner = isEq
    ? runtimeSpecs.suiteV6StocksMod?.evaluateStockStrategyV6
    : (sym === 'BTCUSDT.P' || sym === 'BNBUSDT.P')
      ? runtimeSpecs.suiteV6BtcBnbMod?.evaluateCryptoV6
      : runtimeSpecs.suiteV6EthSolMod?.evaluateCryptoV6;

  if (typeof v6SuiteRunner === 'function') {
    const suiteRes = v6SuiteRunner({
      symbol: sym,
      timeframe: tf,
      dataset,
      fundingRates,
      macroData,
      execProfile: effectiveProfile,
      mlEnabled,
      maxLeverageCap: config.maxLeverageCap,
    });
    if (suiteRes && suiteRes.summary) {
      const lastClose = dataset.rows[dataset.rows.length - 1]?.close;
      const liqDist = computeLiquidationDistance(suiteRes.activeOverlay, lastClose, {
        fallbackLev: suiteRes.execOptions?.minLev ?? 1.5,
      });
      return {
        ...suiteRes,
        regime: suiteRes.regime || regime,
        liquidationDistance: suiteRes.liquidationDistance || liqDist,
      };
    }
  }

  const isBtc = sym === 'BTCUSDT.P';
  const coinPrefix = sym.replace('USDT.P', '').replace('USDT', '');
  const v7StreamKey = `${coinPrefix}_${tf}`;

  const useV7BtcBnb = Boolean(
    !isEq &&
      (ver === 'v7' || ver === 'auto') &&
      (sym === 'BTCUSDT.P' || sym === 'BNBUSDT.P') &&
      runtimeSpecs.highWrV7BtcBnbMod?.generateStreamSignalsV7 &&
      runtimeSpecs.modelsV7BtcBnb?.models?.[v7StreamKey],
  );
  const useV7EthSol = Boolean(
    !isEq &&
      (ver === 'v7' || ver === 'auto') &&
      (sym === 'ETHUSDT.P' || sym === 'SOLUSDT.P') &&
      runtimeSpecs.highWrV7EthSolMod?.generateEthSolStreamSignalsV7 &&
      runtimeSpecs.modelsV7EthSol?.models?.[v7StreamKey],
  );

  const useV6BtcBnb = Boolean(
    !isEq &&
      !useV7BtcBnb &&
      tf === '1h' &&
      (sym === 'BTCUSDT.P' || sym === 'BNBUSDT.P') &&
      runtimeSpecs.suiteV6BtcBnbMod &&
      runtimeSpecs.modelsBtcBnb5y,
  );
  const useV6EthSol = Boolean(
    !isEq &&
      !useV7EthSol &&
      tf === '1h' &&
      (sym === 'ETHUSDT.P' || sym === 'SOLUSDT.P') &&
      runtimeSpecs.suiteV6EthSolMod &&
      runtimeSpecs.modelsEthSol5y,
  );
  const useV6Stocks = Boolean(
    isEq &&
      tf === '1d' &&
      runtimeSpecs.suiteV6StocksMod &&
      runtimeSpecs.modelsStocksV6,
  );

  const mlBundle = isEq
    ? runtimeSpecs.modelsStocksV6
    : (useV7BtcBnb
        ? runtimeSpecs.modelsV7BtcBnb
        : useV7EthSol
          ? runtimeSpecs.modelsV7EthSol
          : useV6BtcBnb
            ? runtimeSpecs.modelsBtcBnb5y
            : useV6EthSol
              ? runtimeSpecs.modelsEthSol5y
              : (isBtc ? runtimeSpecs.mlModelsBtc : runtimeSpecs.mlModelsAlt));

  const mlEntry = isEq || useV6BtcBnb || useV6EthSol || (!useV7BtcBnb && !useV7EthSol)
    ? resolveMlModelEntry(mlBundle, tf, sym)
    : mlBundle.models[v7StreamKey];

  let rawSignals = [];
  let featureExtractor = null;
  let stockAux = null;
  let stockCtx = null;
  let btcRefDs = null;
  let ofCtx = null;
  let ethCtx = null;

  if (useV7BtcBnb && mlEntry?.structuralSpec?.sigSpec) {
    rawSignals = runtimeSpecs.highWrV7BtcBnbMod.generateStreamSignalsV7(
      v7StreamKey,
      dataset,
      mlEntry.structuralSpec.sigSpec,
      alignedFunding,
    );
    ofCtx = runtimeSpecs.suiteV6BtcBnbMod?.precomputeOrderflowContextV6?.(dataset, alignedFunding) || null;
    if (ofCtx && runtimeSpecs.suiteV6BtcBnbMod?.extractCandidateFeaturesV6) {
      featureExtractor = sig => runtimeSpecs.suiteV6BtcBnbMod.extractCandidateFeaturesV6(dataset, sig, sig.barIndex, alignedFunding, ofCtx);
    }
  } else if (useV7EthSol && mlEntry?.structuralSpec?.sigSpec) {
    const isEth = sym === 'ETHUSDT.P';
    if (isEth) {
      const btcFile = tf === '15m' ? 'crypto5y_btcusdt_15m.json' : 'crypto5y_btcusdt_1h.json';
      btcRefDs = readJsonIfExists(path.join(config.repoRoot, 'data', btcFile)) || dataset;
      rawSignals = runtimeSpecs.highWrV7EthSolMod.generateEthSolStreamSignalsV7(
        v7StreamKey,
        dataset,
        mlEntry.structuralSpec.sigSpec,
        btcRefDs,
      );
      ethCtx = runtimeSpecs.suiteV6EthSolMod?.precomputeEthCrossContextV6?.(dataset, btcRefDs, alignedFunding) || null;
      if (ethCtx && runtimeSpecs.suiteV6EthSolMod?.extractEthCandidateFeaturesV6) {
        featureExtractor = sig => runtimeSpecs.suiteV6EthSolMod.extractEthCandidateFeaturesV6(dataset, btcRefDs, sig, sig.barIndex, alignedFunding, ethCtx);
      }
    } else {
      rawSignals = runtimeSpecs.highWrV7EthSolMod.generateEthSolStreamSignalsV7(
        v7StreamKey,
        dataset,
        mlEntry.structuralSpec.sigSpec,
      );
      ofCtx = runtimeSpecs.suiteV6BtcBnbMod?.precomputeOrderflowContextV6?.(dataset, alignedFunding) || null;
      if (ofCtx && runtimeSpecs.suiteV6BtcBnbMod?.extractCandidateFeaturesV6) {
        featureExtractor = sig => runtimeSpecs.suiteV6BtcBnbMod.extractCandidateFeaturesV6(dataset, sig, sig.barIndex, alignedFunding, ofCtx);
      }
    }
  } else if (useV6Stocks && mlEntry?.signalSpec) {
    const macroObj = macroData || readJsonIfExists(path.join(config.repoRoot, 'data', 'equities10y_macro_1d.json'));
    const dowJson = readJsonIfExists(path.join(config.repoRoot, 'data', 'equities10y_dow_1d.json'));
    const qqqJson = readJsonIfExists(path.join(config.repoRoot, 'data', 'equities10y_nasdaq_1d.json'));
    stockAux = {
      macro: macroObj,
      diaRows: dowJson?.rows || [],
      qqqRows: qqqJson?.rows || [],
    };
    stockCtx = runtimeSpecs.suiteV6StocksMod.precomputeStockContextV6(dataset, stockAux);
    rawSignals = runtimeSpecs.suiteV6StocksMod.generateStockSignalsV6(dataset, mlEntry.signalSpec, stockAux, stockCtx);
    featureExtractor = sig => runtimeSpecs.suiteV6StocksMod.extractStockFeaturesV6(dataset, sig, sig.barIndex, stockAux, stockCtx);
  } else if (isEq) {
    rawSignals = generateEquityFallbackSignals(dataset);
  } else if (useV6BtcBnb && mlEntry?.structuralSpec?.sigSpec) {
    const sigSpec = mlEntry.structuralSpec.sigSpec;
    rawSignals = isBtc
      ? runtimeSpecs.suiteV6BtcBnbMod.generateBtcSignalsV6(dataset, sigSpec)
      : runtimeSpecs.suiteV6BtcBnbMod.generateBnbSignalsV6(dataset, sigSpec, alignedFunding);
    ofCtx = runtimeSpecs.suiteV6BtcBnbMod.precomputeOrderflowContextV6(dataset, alignedFunding);
    featureExtractor = sig => runtimeSpecs.suiteV6BtcBnbMod.extractCandidateFeaturesV6(dataset, sig, sig.barIndex, alignedFunding, ofCtx);
  } else if (useV6EthSol && mlEntry?.structuralSpec?.sigSpec) {
    const sigSpec = mlEntry.structuralSpec.sigSpec;
    if (sym === 'ETHUSDT.P') {
      btcRefDs = readJsonIfExists(path.join(config.repoRoot, 'data', 'crypto5y_btcusdt_1h.json')) || dataset;
      rawSignals = runtimeSpecs.suiteV6EthSolMod.generateEthSignalsV6(dataset, btcRefDs, sigSpec);
      ethCtx = runtimeSpecs.suiteV6EthSolMod.precomputeEthCrossContextV6(dataset, btcRefDs, alignedFunding);
      featureExtractor = sig => runtimeSpecs.suiteV6EthSolMod.extractEthCandidateFeaturesV6(dataset, btcRefDs, sig, sig.barIndex, alignedFunding, ethCtx);
    } else {
      rawSignals = runtimeSpecs.suiteV6EthSolMod.generateSolSignalsV6(dataset, sigSpec);
      ofCtx = runtimeSpecs.suiteV6BtcBnbMod?.precomputeOrderflowContextV6?.(dataset, alignedFunding) || null;
      if (ofCtx && runtimeSpecs.suiteV6BtcBnbMod?.extractCandidateFeaturesV6) {
        featureExtractor = sig => runtimeSpecs.suiteV6BtcBnbMod.extractCandidateFeaturesV6(dataset, sig, sig.barIndex, alignedFunding, ofCtx);
      }
    }
  } else if (tf === '1h') {
    const spec1h = runtimeSpecs.lock1h?.lockedWinner?.signalSpec;
    if (!spec1h) throw new Error('Missing locked 1h signalSpec in research/results_1h/selection-lock.json');
    if ((sym === 'ETHUSDT.P' || sym === 'SOLUSDT.P') && runtimeSpecs.altSignalsMod?.generateSignalsAltV5) {
      const altSpec = runtimeSpecs.altSignalsMod.getAltAssetConfigV5?.(sym) || spec1h;
      rawSignals = runtimeSpecs.altSignalsMod.generateSignalsAltV5(dataset, altSpec);
    } else {
      rawSignals = generateSignals1h(dataset, spec1h);
    }
  } else if (tf === '15m') {
    const spec15 = runtimeSpecs.lock15m?.winner?.fullSpec;
    if (!spec15) throw new Error('Missing locked 15m signalSpec in research/results_v4/lock_15m_r3.json');
    rawSignals = generateSignals15mV4(dataset, spec15);
  } else {
    throw new Error(`Unsupported strategy timeframe "${timeframe}" for ${sym}`);
  }

  const featureCtxV5 = (!featureExtractor && !isEq && mlEntry && runtimeSpecs.featuresV5Mod?.precomputeFeatureContextV5 &&
    mlEntry.featureNames?.every(fn => runtimeSpecs.featuresV5Mod?.FEATURE_NAMES_V5?.includes(fn)))
    ? runtimeSpecs.featuresV5Mod.precomputeFeatureContextV5(dataset, alignedFunding)
    : null;

  if (!featureExtractor && featureCtxV5) {
    featureExtractor = sig => runtimeSpecs.featuresV5Mod.extractCandidateFeaturesV5(
      dataset,
      sig,
      sig.barIndex,
      alignedFunding,
      featureCtxV5,
    );
  }

  const canScoreMl = Boolean(
    mlEnabled &&
      mlEntry &&
      featureExtractor &&
      (runtimeSpecs.mlInfMod?.scoreCandidateV5 || runtimeSpecs.mlInfMod?.predictProbaV5),
  );

  const modelSpec = mlEntry ? (mlEntry.model || mlEntry) : null;
  const tau = Number(modelSpec?.threshold ?? mlEntry?.threshold ?? mlEntry?.tau ?? 0.55);
  const modelVersion = canScoreMl
    ? (mlEntry.version || ((useV7BtcBnb || useV7EthSol) ? `v7.0-${modelSpec?.modelType || 'ML'}` : (useV6BtcBnb || useV6EthSol || useV6Stocks ? `v6.0-${modelSpec?.modelType || 'ML'}` : modelSpec?.modelType)) || 'v5.0-ML')
    : (isEq ? 'v6.0-equity-fallback' : 'v4.1-fallback');

  const signalsAudit = [];
  const filteredSignals = [];

  for (const sig of rawSignals) {
    let probWin = null;
    let features = null;
    let decision = 'ACCEPTED';
    let sizeMult = 1.0;

    if (canScoreMl) {
      features = featureExtractor(sig);
      const res = typeof runtimeSpecs.mlInfMod.scoreCandidateV5 === 'function'
        ? runtimeSpecs.mlInfMod.scoreCandidateV5(features, modelSpec)
        : runtimeSpecs.mlInfMod.predictProbaV5(features, modelSpec);
      probWin = typeof res === 'number' ? res : Number(res?.probWin ?? res?.prob);
      if (Number.isFinite(probWin)) {
        const passed = res && typeof res.pass === 'boolean' && modelSpec?.threshold !== undefined
          ? res.pass
          : probWin >= tau;
        if (!passed) {
          decision = 'ML_FILTERED';
        } else {
          sizeMult = res && Number.isFinite(res.sizeMult) && res.sizeMult > 0
            ? res.sizeMult
            : computeSizeMultFromProb(probWin, mlEntry, tau);
        }
      }
    }

    const bar = dataset.rows[sig.barIndex];
    signalsAudit.push({
      exchange: isEq ? 'YAHOO' : exchange,
      symbol: sym,
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

  const execOptions = buildExecOptions({
    symbol: sym,
    timeframe: tf,
    execProfile: effectiveProfile,
    config,
    runtimeSpecs,
    mlEntry,
  });
  const simOpts = {
    ...execOptions,
    start: 0,
    end: dataset.rows.length,
    intervalSeconds: dataset.intervalSeconds,
    fundingRows: !isEq && fundingRates.length > 0 ? fundingRates : undefined,
  };

  let simResult;
  if (!isEq && runtimeSpecs.simV7Mod?.simulateTradesV7) {
    simResult = runtimeSpecs.simV7Mod.simulateTradesV7(dataset.rows, filteredSignals, {
      ...simOpts,
      isolatedLiqCheck: true,
      mmr: 0.005,
    });
  } else if (runtimeSpecs.simV6Mod?.simulateTradesV6) {
    simResult = runtimeSpecs.simV6Mod.simulateTradesV6(dataset.rows, filteredSignals, simOpts);
  } else if (!isEq && runtimeSpecs.simV5Mod?.simulateTradesV5) {
    simResult = runtimeSpecs.simV5Mod.simulateTradesV5(dataset.rows, filteredSignals, simOpts);
  } else {
    simResult = simulateTradesNonContiguousSafe(dataset.rows, filteredSignals, simOpts);
  }

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
  const lastClose = dataset.rows[dataset.rows.length - 1]?.close;
  const liquidationDistance = isEq
    ? { hasPosition: false, status: 'CASH_ETF', bufferPct: 100, liqPrice: 0, lev: 1.0, mmr: 0 }
    : computeLiquidationDistance(activeOverlay, lastClose, {
        fallbackLev: execOptions.minLev ?? 1.5,
      });

  const monthlySummary = (!isEq && runtimeSpecs.simV7Mod?.summarizeMonthlyCashflowV7)
    ? runtimeSpecs.simV7Mod.summarizeMonthlyCashflowV7(simResult.trades, dataset.rows)
    : null;

  const summary = {
    exchange: isEq ? 'YAHOO' : exchange,
    symbol: sym,
    timeframe: tf,
    execProfile: effectiveProfile,
    riskTier: effTier,
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
    liquidationCount: simResult.liquidationCount ?? 0,
    meanMonthlySweepPct: monthlySummary ? Number((monthlySummary.meanMonthlySweepPct ?? 0).toFixed(2)) : null,
    exitReasons: simResult.exitReasons,
  };

  return {
    summary,
    regime,
    liquidationDistance,
    monthlySummary,
    execOptions,
    signalsAudit,
    trades: enrichedTrades,
    equityCurve,
    activeOverlay,
    openPosition: simResult.openPosition || null,
    pending: simResult.pending || null,
  };
}

/**
 * Fallback wrapper when sim_engine_v6.mjs is absent and dataset has non-contiguous daily equity timestamps.
 */
function simulateTradesNonContiguousSafe(rows, signals, simOpts) {
  if (!simOpts.allowTimeGaps) {
    return simulateTrades(rows, signals, simOpts);
  }
  const origTimes = rows.map(r => r.time);
  const baseT = rows[0].time;
  const syntheticRows = rows.map((r, idx) => ({ ...r, time: baseT + idx * simOpts.intervalSeconds }));
  const res = simulateTrades(syntheticRows, signals, simOpts);
  for (let i = 0; i < rows.length; i++) rows[i].time = origTimes[i];
  return res;
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
    const sigPrice = sigBar?.close ?? pending.limitPrice ?? sigBar?.close;
    const estStopDist = Math.max((pending.atr ?? 0) * (pending.stopAtr ?? 3.2), sigPrice * 0.014);
    const estStop = (pending.limitPrice ?? sigPrice) - pending.side * estStopDist;
    const estTarget = (pending.limitPrice ?? sigPrice) + pending.side * estStopDist * (pending.rewardRisk ?? 1.15);
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
 * Loads candles, funding, and macro data from SQLite (if sufficient bars) or local data/*.json.
 */
export function loadOfflineOrDbDataset({ store, config, symbol, timeframe, minBars = 220, prefer5y = true }) {
  const sym = normalizeAssetSymbol(symbol);
  const isEq = isEquitySymbol(sym);
  const exchange = isEq ? 'YAHOO' : (config.exchange || 'OKX');
  const dbCandles = store ? store.getCandles({ exchange, symbol: sym, timeframe, limit: 5000 }) : [];
  const dbFunding = (!isEq && store) ? store.getFundingRates({ exchange, symbol: sym, limit: 3000 }) : [];

  if (dbCandles.length >= minBars) {
    return {
      source: 'sqlite',
      dataset: buildDatasetFromCandles({ symbol: sym, timeframe, rows: dbCandles }),
      fundingRates: dbFunding,
      macroData: readJsonIfExists(path.join(config.repoRoot, 'data', 'equities10y_macro_1d.json')),
    };
  }

  const localPath = resolveLocalDatasetPath(config.repoRoot, { symbol: sym, timeframe, prefer5y });
  if (localPath) {
    const dataset = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    let fundingRates = dataset.fundingRows || dbFunding;
    if ((!fundingRates || fundingRates.length === 0) && !isEq) {
      const coin = sym.toLowerCase().replace(/usdt\.p$|usdt$/, '');
      const fundingFile = path.join(config.repoRoot, 'data', `okx_${coin}usdt_swap_funding_3y.json`);
      const fundingJson = readJsonIfExists(fundingFile);
      fundingRates = fundingJson?.rows || [];
    }
    const macroData = readJsonIfExists(path.join(config.repoRoot, 'data', 'equities10y_macro_1d.json'));
    return {
      source: path.relative(config.repoRoot, localPath),
      dataset,
      fundingRates,
      macroData,
    };
  }

  if (dbCandles.length > 0) {
    return {
      source: 'sqlite-partial',
      dataset: buildDatasetFromCandles({ symbol: sym, timeframe, rows: dbCandles }),
      fundingRates: dbFunding,
      macroData: readJsonIfExists(path.join(config.repoRoot, 'data', 'equities10y_macro_1d.json')),
    };
  }

  throw new Error(`No candles found in SQLite or data/ for ${exchange} ${sym} ${timeframe}`);
}

export class StandaloneTradingDaemon {
  constructor({ config, store, runtimeSpecs, exchangeClient } = {}) {
    this.config = config;
    this.store = store;
    this.runtimeSpecs = runtimeSpecs;
    this.cryptoClient = exchangeClient || createExchangeClient(config);
    this.equitiesClient = new YahooEquitiesClient();
    this._timer = null;
    this._running = false;
    this.lastSyncAt = null;
    this.lastEvalAt = null;
    this.lastError = null;
    this.latestMacro = null;
    this.latestSnapshots = new Map();
  }

  async syncMarketData({ symbol, timeframe, bars = 1000 } = {}) {
    const sym = normalizeAssetSymbol(symbol || this.config.symbols[0] || 'BTCUSDT.P');
    const isEq = isEquitySymbol(sym);
    const tf = timeframe || (isEq ? '1d' : (this.config.timeframes[0] || '1h'));

    if (isEq) {
      const candleRows = await this.equitiesClient.getClosedCandles({ symbol: sym, timeframe: tf });
      const savedCandles = this.store.upsertCandles({ exchange: 'YAHOO', symbol: sym, timeframe: tf, rows: candleRows });
      try {
        this.latestMacro = await this.equitiesClient.getMacroSnapshot();
      } catch {
        // non-fatal macro warning
      }
      this.lastSyncAt = new Date().toISOString();
      return {
        exchange: 'YAHOO',
        symbol: sym,
        timeframe: tf,
        candlesFetched: candleRows.length,
        candlesSaved: savedCandles,
        fundingFetched: 0,
        fundingSaved: 0,
        latestTime: candleRows.length ? candleRows[candleRows.length - 1].time : null,
      };
    }

    const exchange = this.config.exchange;
    const allCandles = new Map();
    let cursor = undefined;
    const batches = Math.ceil(bars / 300);
    for (let b = 0; b < batches; b++) {
      const chunk = await this.cryptoClient.getClosedCandles({
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

    const fundingRows = await this.cryptoClient.getFundingRates({ symbol: sym, limit: 100 });
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

  evaluateAndPersist({ symbol, timeframe, execProfile, mlEnabled = true } = {}) {
    const sym = normalizeAssetSymbol(symbol || this.config.symbols[0] || 'BTCUSDT.P');
    const isEq = isEquitySymbol(sym);
    const tf = timeframe || (isEq ? '1d' : (this.config.timeframes[0] || '1h'));
    const exchange = isEq ? 'YAHOO' : this.config.exchange;

    const { source, dataset, fundingRates, macroData } = loadOfflineOrDbDataset({
      store: this.store,
      config: this.config,
      symbol: sym,
      timeframe: tf,
    });

    const evalRes = evaluateStrategy({
      dataset,
      fundingRates,
      macroData: this.latestMacro || macroData,
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
      regime: evalRes.regime,
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
    for (const rawSym of this.config.symbols) {
      const sym = normalizeAssetSymbol(rawSym);
      const tfs = isEquitySymbol(sym) ? ['1d'] : (sym === 'BTCUSDT.P' ? ['1h', '15m'] : ['1h']);
      for (const tf of tfs) {
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
