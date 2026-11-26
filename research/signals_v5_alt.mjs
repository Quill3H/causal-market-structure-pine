import assert from 'node:assert/strict';
import {
  DEFAULT_WARMUP_1H,
  computeOhlcFeatures1h,
  generateSignals1h,
  sliceDatasetPrefix1h,
} from './signals_1h.mjs';
import { simulateTradesV5 } from './sim_engine_v5.mjs';

export const V41_ALT_DIAGNOSIS = Object.freeze({
  summary:
    'BTC-tuned 1h v3.0 failed on ETHUSDT.P (-100.77%) and SOLUSDT.P (-131.54%) in v4.1 due to three structural mismatches:',
  factors: [
    {
      factor: 'Volatility & Stop-Distance Scaling Mismatch',
      detail:
        'Cal+Val median 1h ATR% is 0.934% on ETH (1.42x BTC 0.657%) and 1.261% on SOL (1.92x BTC). BTC stopAtr=3.2 produced 3.43% average stops on ETH and 4.69% on SOL while fixed beOffsetPct=0.34% captured only ~0.10R on ETH and ~0.07R on SOL, creating severe negative payoff skew amplified by VolNorm (riskPct=5%, maxLev=3.0).',
    },
    {
      factor: 'AdaptiveTrapPolarity Counter-Productive Flipping',
      detail:
        'The BTC-tuned slThresh=2 adaptive polarity flip inverted ETH/SOL signals during brief volatility clusters, dragging Cal+Val 1x performance from +19.27% (68.18% WR, PF 1.10) raw to -21.34% (63.19% WR, PF 0.90) on ETH and from -13.26% (61.85% WR, PF 0.96) raw to -55.93% (57.80% WR, PF 0.83) on SOL.',
    },
    {
      factor: 'HTF Trend Lag & Shallow Pullback Limit',
      detail:
        '4H EMA50 (200h) lagged altcoin momentum reversals and 0.18 ATR limit pullbacks chased intrabar spikes. Switching to faster 4H EMA20 (80h), deeper limit pullback (0.22-0.25 ATR), tighter stopAtr (2.0-2.2), and volatility-proportional BE+ offset (0.45%) restores positive Cal+Val expectancy.',
    },
  ],
});

/**
 * Cal+Val ([0..17520)) calibrated structural specifications for OKX altcoin 1h perpetuals.
 * Note: Holdout Y3 ([17520..26280)) was never inspected when calibrating these parameters.
 */
export const ALT_ASSETS_V5 = Object.freeze({
  ETH: Object.freeze({
    key: 'ETH',
    symbol: 'OKX:ETHUSDT.P',
    instId: 'ETH-USDT-SWAP',
    dataFile: 'okx_ethusdt_swap_1h_3y.json',
    fundingFile: 'okx_ethusdt_swap_funding_3y.json',
    signalSpec: Object.freeze({
      specId: 'V5Alt:ETH:HtfSmcMultiTrap:P4_10:N20:K2:pd1:H4_20:off0.22',
      family: 'HtfSmcMultiTrap',
      lookback: 20,
      trapMaxBars: 2,
      p4Lookback: 10,
      includePdhl: true,
      htfMode: 'H4_20',
      maxD1Atr: null,
      maxH4Cross30: null,
      requireH4Slope20: false,
      d1Er10Min: null,
      limitOffsetAtr: 0.22,
      warmup: DEFAULT_WARMUP_1H,
    }),
    execOptions: Object.freeze({
      entryMode: 'LIMIT_PULLBACK',
      limitExpiryBars: 6,
      pendingPolicy: 'ignore',
      limitSameBarTp: 'close',
      cooldown: 4,
      warmup: DEFAULT_WARMUP_1H,
      stopAtr: 2.2,
      minStopPct: 1.6,
      rewardRisk: 1.25,
      maxHoldBars: 96,
      beTriggerR: 0.43,
      beOffsetPct: 0.45,
      volNormRiskPct: 4.0,
      minLev: 1.0,
      maxLev: 2.5,
      costPct: 0.1,
      slippagePct: 0.025,
      fundingPctPer8h: 0.01,
    }),
  }),
  SOL: Object.freeze({
    key: 'SOL',
    symbol: 'OKX:SOLUSDT.P',
    instId: 'SOL-USDT-SWAP',
    dataFile: 'okx_solusdt_swap_1h_3y.json',
    fundingFile: 'okx_solusdt_swap_funding_3y.json',
    signalSpec: Object.freeze({
      specId: 'V5Alt:SOL:HtfSmcMultiTrap:P4_10:N20:K3:pd1:H4_20:off0.25',
      family: 'HtfSmcMultiTrap',
      lookback: 20,
      trapMaxBars: 3,
      p4Lookback: 10,
      includePdhl: true,
      htfMode: 'H4_20',
      maxD1Atr: null,
      maxH4Cross30: null,
      requireH4Slope20: false,
      d1Er10Min: null,
      limitOffsetAtr: 0.25,
      warmup: DEFAULT_WARMUP_1H,
    }),
    execOptions: Object.freeze({
      entryMode: 'LIMIT_PULLBACK',
      limitExpiryBars: 6,
      pendingPolicy: 'ignore',
      limitSameBarTp: 'close',
      cooldown: 4,
      warmup: DEFAULT_WARMUP_1H,
      stopAtr: 2.0,
      minStopPct: 1.6,
      rewardRisk: 1.15,
      maxHoldBars: 96,
      beTriggerR: 0.43,
      beOffsetPct: 0.45,
      volNormRiskPct: 4.0,
      minLev: 1.0,
      maxLev: 2.5,
      costPct: 0.1,
      slippagePct: 0.025,
      fundingPctPer8h: 0.01,
    }),
  }),
});

export function getAltAssetConfigV5(assetKeyOrSymbol) {
  const norm = String(assetKeyOrSymbol ?? '').toUpperCase();
  if (norm === 'ETH' || norm === 'OKX:ETHUSDT.P' || norm === 'ETH-USDT-SWAP' || norm === 'ETHUSDT.P') {
    return ALT_ASSETS_V5.ETH;
  }
  if (norm === 'SOL' || norm === 'OKX:SOLUSDT.P' || norm === 'SOL-USDT-SWAP' || norm === 'SOLUSDT.P') {
    return ALT_ASSETS_V5.SOL;
  }
  throw new Error(`Unknown v5 altcoin asset: ${assetKeyOrSymbol}`);
}

/**
 * Generates causal 1h signals for an altcoin dataset using its Cal+Val-calibrated spec
 * (or an explicit signalSpec override). Strictly causal: bar i depends only on bars <= i
 * and closed HTF bars with htf.time + htf.intervalSeconds <= bar.time.
 */
export function generateSignalsAltV5(dataset, assetOrSpec = null, precomputed = null) {
  assert.ok(dataset && Array.isArray(dataset.rows), 'Expected dataset with rows');
  let spec;
  if (assetOrSpec && typeof assetOrSpec === 'object' && assetOrSpec.family) {
    spec = assetOrSpec;
  } else if (typeof assetOrSpec === 'string') {
    spec = getAltAssetConfigV5(assetOrSpec).signalSpec;
  } else {
    spec = getAltAssetConfigV5(dataset.symbol).signalSpec;
  }
  return generateSignals1h(dataset, spec, precomputed);
}

/**
 * Reproducible Cal+Val ([0..17520)) structural parameter selector for ETH/SOL 1h.
 * Strictly truncates dataset at calValEnd before generating signals or running simulations.
 */
export function calibrateAltOnCalVal(dataset, fundingRows = null, calValEnd = 17520) {
  assert.ok(dataset && Array.isArray(dataset.rows) && dataset.rows.length >= calValEnd,
    `Expected dataset with >= ${calValEnd} rows`);
  const dsCV = sliceDatasetPrefix1h(dataset, calValEnd);
  const calEnd = Math.floor(calValEnd / 2);
  const f1 = computeOhlcFeatures1h(dsCV.rows);
  const f4 = computeOhlcFeatures1h(dsCV.htf['4h'].rows);
  const fD = dsCV.htf['1d'] ? computeOhlcFeatures1h(dsCV.htf['1d'].rows) : null;
  const pre = { f1, f4, fD, rawSignalsByKey: new Map(), virtTradesByKey: new Map() };

  const fundingCV = Array.isArray(fundingRows)
    ? fundingRows.filter(f => f.time <= dsCV.lastTime)
    : null;

  const candidates = [];
  for (const trapMaxBars of [2, 3, 4]) {
    for (const limitOffsetAtr of [0.22, 0.25, 0.30]) {
      const signalSpec = {
        specId: `HtfSmcMultiTrap:P4_10:N20:K${trapMaxBars}:pd1:H4_20:off${limitOffsetAtr}`,
        family: 'HtfSmcMultiTrap',
        lookback: 20,
        trapMaxBars,
        p4Lookback: 10,
        includePdhl: true,
        htfMode: 'H4_20',
        maxD1Atr: null,
        maxH4Cross30: null,
        requireH4Slope20: false,
        d1Er10Min: null,
        limitOffsetAtr,
        warmup: DEFAULT_WARMUP_1H,
      };
      const sigs = generateSignals1h(dsCV, signalSpec, pre);
      for (const stopAtr of [2.0, 2.2, 2.5]) {
        for (const rewardRisk of [1.15, 1.25]) {
          const execOptions = {
            entryMode: 'LIMIT_PULLBACK',
            limitExpiryBars: 6,
            pendingPolicy: 'ignore',
            limitSameBarTp: 'close',
            cooldown: 4,
            warmup: DEFAULT_WARMUP_1H,
            stopAtr,
            minStopPct: 1.6,
            rewardRisk,
            maxHoldBars: 96,
            beTriggerR: 0.43,
            beOffsetPct: 0.45,
            volNormRiskPct: 4.0,
            minLev: 1.0,
            maxLev: 2.5,
            costPct: 0.1,
            slippagePct: 0.025,
            fundingPctPer8h: 0.01,
          };
          const simOpts = {
            ...execOptions,
            execProfile: 'EXCHANGE_POST_ONLY',
            fundingRows: fundingCV,
            intervalSeconds: 3600,
          };
          const cal = simulateTradesV5(dsCV.rows, sigs, { ...simOpts, start: 0, end: calEnd });
          const val = simulateTradesV5(dsCV.rows, sigs, { ...simOpts, start: calEnd, end: calValEnd });
          const cv = simulateTradesV5(dsCV.rows, sigs, { ...simOpts, start: 0, end: calValEnd });
          const eligible = cal.count >= 50 && val.count >= 50 &&
            (cal.winRatePct ?? 0) >= 65 && (val.winRatePct ?? 0) >= 64 &&
            (cal.profitFactor ?? 0) >= 1.25 && (val.profitFactor ?? 0) >= 1.20;
          const score = (eligible ? 1000 : 0) +
            (cv.retToDd ?? 0) +
            2.0 * Math.min(cal.profitFactor ?? 0, val.profitFactor ?? 0) +
            0.2 * ((cv.winRatePct ?? 0) - 65);
          candidates.push({
            id: `${signalSpec.specId}|s${stopAtr}|rr${rewardRisk}`,
            signalSpec,
            execOptions,
            eligible,
            score: Number(score.toFixed(4)),
            cal: { count: cal.count, winRatePct: cal.winRatePct, profitFactor: cal.profitFactor, totalNetPct: cal.totalNetPct },
            val: { count: val.count, winRatePct: val.winRatePct, profitFactor: val.profitFactor, totalNetPct: val.totalNetPct },
            calVal: { count: cv.count, winRatePct: cv.winRatePct, profitFactor: cv.profitFactor, compoundedNetPct: cv.compoundedNetPct, retToDd: cv.retToDd },
          });
        }
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return {
    selected: candidates[0],
    top5: candidates.slice(0, 5),
  };
}
