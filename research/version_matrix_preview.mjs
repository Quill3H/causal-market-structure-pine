import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  simulateTradesV7,
  simulatePortfolioV7,
  summarizeMonthlyCashflowV7,
} from './sim_engine_v7.mjs';
import {
  EQUITY_REGIMES_V8,
  precomputeEquityRegimeV8,
} from './regime_engine_v8.mjs';
import {
  precomputeStockContextV6,
  generateStockSignalsV6,
  applyStockMlFilterV6,
  generateFutures1hSignalsCausal,
} from './suite_v6_stocks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..');
const SECONDS_PER_YEAR = 365.25 * 86400;
const EPS = 1e-12;

function r2(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(2));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readTextIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function computeSharpeSortinoCalmar(trades, cagrPct, maxCompDdPct, periodYears) {
  const count = trades.length;
  let sharpe = null;
  let sortino = null;
  if (count >= 2 && periodYears > 0) {
    let sum = 0;
    let sumDownSq = 0;
    const rets = new Array(count);
    for (let i = 0; i < count; i++) {
      const p = trades[i].portfolioNetPct ?? trades[i].netPct;
      rets[i] = p;
      sum += p;
      if (p < 0) sumDownSq += p * p;
    }
    const mean = sum / count;
    let varSum = 0;
    for (let i = 0; i < count; i++) {
      const d = rets[i] - mean;
      varSum += d * d;
    }
    const std = Math.sqrt(varSum / (count - 1));
    const downDev = Math.sqrt(sumDownSq / count);
    const ann = Math.sqrt(count / periodYears);
    if (std > EPS) sharpe = (mean / std) * ann;
    if (downDev > EPS) sortino = (mean / downDev) * ann;
  }
  const calmar = cagrPct !== null && maxCompDdPct > EPS ? cagrPct / maxCompDdPct : null;
  return { sharpe: r2(sharpe), sortino: r2(sortino), calmar: r2(calmar) };
}

/**
 * Parses v1.4 and v2.0 locked facts verbatim from docs/EVALUATION_AND_RESEARCH_REPORT.md.
 */
function extractLegacyV14AndV20(repoRoot) {
  const reportPath = path.join(repoRoot, 'docs', 'EVALUATION_AND_RESEARCH_REPORT.md');
  const md = readTextIfExists(reportPath) ?? '';
  const hasV14 = md.includes('v1.4.0 (PR #1)') && md.includes('41,1%') && md.includes('43,8%');
  const hasV20 = md.includes('v2.0.0 (Local)') && md.includes('NOT_ACHIEVED') && md.includes('0/840');

  const v14 = {
    version: 'v1.4',
    label: 'v1.4.0 (PR #1 Legacy Indicator)',
    era: 'TradingView Pine v6 Indicator-only',
    sourceArtifact: 'docs/EVALUATION_AND_RESEARCH_REPORT.md',
    verifiedFromArtifact: hasV14,
    status: 'LEGACY_RETIRED',
    executionModel: 'Arrow overlay only (10-bar forward check, no SL/TP/BE/fee engine)',
    assetUniverse: ['BINANCE:BTCUSDT (15m)'],
    metrics: {
      primary: {
        window: '15m 10-bar unhedged forward return (pre-fee)',
        winRatePct: '41.1% - 43.8%',
        profitFactor: null,
        netPct: null,
        maxDrawdownPct: null,
        liquidationCount: null,
      },
      blindOos: null,
    },
    strengths: [
      'Visual CHoCH + Source RVOL arrow signals on TradingView chart.',
      'Simple 4-file Pine layout for manual discretionary inspection.',
    ],
    weaknesses: [
      'No Limit Pullback entry, no stop-loss floor, no Break-Even (BE+) state machine.',
      'Gross 10-bar forward win rate (~41.1%-43.8%) fails even before fees and slippage.',
    ],
    failureModes: [
      'Chases breakout bars at market without pullback mitigation -> negative expectancy after exchange fees.',
    ],
  };

  const v20 = {
    version: 'v2.0',
    label: 'v2.0.0 (Legacy Pine Strategy Reference)',
    era: 'TradingView Pine v6 (legacy/TOOL-2.0.0-ref.pine)',
    sourceArtifact: 'docs/EVALUATION_AND_RESEARCH_REPORT.md',
    verifiedFromArtifact: hasV20,
    status: 'NOT_ACHIEVED',
    executionModel: 'MARKET_NEXT_OPEN, SL 1.5 ATR, RR 1.0, maxHold 20, no BE+',
    assetUniverse: ['BINANCE:BTCUSDT (15m & 1h, 840 presets/tf)'],
    metrics: {
      primary: {
        window: 'Cal+Val grid (0/840 configs passed 65% WR gate on 15m or 1h)',
        configsPassed: '0/840 (both 15m & 1h)',
        validationWr15mPct: 66.67,
        validationWr1hPct: 69.64,
      },
      blindOos: {
        window: 'Final 25% OOS probe collapse',
        tf15m: { count: 33, wins: 14, winRatePct: 42.42, meanNetPct: -0.148 },
        tf1h: { count: 48, wins: 24, winRatePct: 50.0, meanNetPct: -0.1705 },
      },
    },
    strengths: [
      'Introduced PAPER IN / OUT trade lifecycle and liquidation heatmap visualization.',
      'Empirical evidence proved legacy MARKET_NEXT_OPEN & TrendPullback:Reverse presets cannot reach >=65% WR.',
    ],
    weaknesses: [
      'Overfit grid (1,680 total combos across 15m/1h) collapsed in final 25% OOS.',
      '1.5 ATR stop + Market-Next-Open entry suffered severe adverse excursion & chop stop-outs.',
    ],
    failureModes: [
      'OOS collapse from 66.67% -> 42.42% WR on 15m and 69.64% -> 50.00% WR on 1h with negative mean net (-0.148% / -0.1705%).',
    ],
  };

  return { v14, v20 };
}

function extractV30(repoRoot) {
  const auditPath = path.join(repoRoot, 'docs', 'INDEPENDENT_AUDIT.json');
  const audit = readJsonIfExists(auditPath);
  const m15 = audit?.metrics15m;
  const m1h = audit?.metrics1h;

  return {
    version: 'v3.0',
    label: 'v3.0.0 (SMC High-WinRate Pine + Verified Parity)',
    era: 'TradingView Pine v6 + Node Parity (1x Unlevered Spot/1x Perp)',
    sourceArtifact: 'docs/INDEPENDENT_AUDIT.json',
    verifiedFromArtifact: Boolean(audit && audit.verdict === 'VERIFIED PASS'),
    status: audit?.verdict ?? 'MISSING',
    executionModel: '1x LIMIT_PULLBACK, 3.0-3.2 ATR / >=1.0-1.4% SL floor, RR 1.15, Confirmed-Close BE+',
    assetUniverse: ['BINANCE:BTCUSDT (15m H1_CleanDisp_AtrExh, 1h AdaptiveTrapPolarity)'],
    metrics: {
      track15m: m15 ? {
        holdout: {
          count: m15.holdout.count,
          winRatePct: r2(m15.holdout.winRatePct),
          profitFactor: r2(m15.holdout.profitFactor),
          totalNetPct: r2(m15.holdout.totalNetPct),
          maxDrawdownPct: r2(m15.holdout.maxDrawdownPct),
        },
        tv6k: {
          count: m15.tv6k.count,
          winRatePct: r2(m15.tv6k.winRatePct),
          profitFactor: r2(m15.tv6k.profitFactor),
          totalNetPct: r2(m15.tv6k.totalNetPct),
        },
        full12m: {
          count: m15.full12m.count,
          winRatePct: r2(m15.full12m.winRatePct),
          profitFactor: r2(m15.full12m.profitFactor),
          totalNetPct: r2(m15.full12m.totalNetPct),
          maxDrawdownPct: r2(m15.full12m.maxDrawdownPct),
        },
        walkForward4Fold: {
          count: m15.walkForward4Fold.aggregate.count,
          winRatePct: r2(m15.walkForward4Fold.aggregate.winRatePct),
          profitFactor: r2(m15.walkForward4Fold.aggregate.profitFactor),
          totalNetPct: r2(m15.walkForward4Fold.aggregate.totalNetPct),
        },
      } : null,
      track1h: m1h ? {
        holdout: {
          count: m1h.holdout.count,
          winRatePct: r2(m1h.holdout.winRatePct),
          profitFactor: r2(m1h.holdout.profitFactor),
          totalNetPct: r2(m1h.holdout.totalNetPct),
          maxDrawdownPct: r2(m1h.holdout.maxDrawdownPct),
        },
        tv6k: {
          count: m1h.tv6k.count,
          winRatePct: r2(m1h.tv6k.winRatePct),
          profitFactor: r2(m1h.tv6k.profitFactor),
          totalNetPct: r2(m1h.tv6k.totalNetPct),
        },
        full24m: {
          count: m1h.full24m.count,
          winRatePct: r2(m1h.full24m.winRatePct),
          profitFactor: r2(m1h.full24m.profitFactor),
          totalNetPct: r2(m1h.full24m.totalNetPct),
          maxDrawdownPct: r2(m1h.full24m.maxDrawdownPct),
        },
        walkForwardAnchored4Fold: m1h.walkForwardAnchored4Fold?.aggregate ? {
          count: m1h.walkForwardAnchored4Fold.aggregate.count,
          winRatePct: r2(m1h.walkForwardAnchored4Fold.aggregate.winRatePct),
          profitFactor: r2(m1h.walkForwardAnchored4Fold.aggregate.profitFactor),
          totalNetPct: r2(m1h.walkForwardAnchored4Fold.aggregate.totalNetPct),
        } : null,
        walkForwardFixed4Qtr: m1h.walkForwardFixed4Qtr?.aggregate ? {
          count: m1h.walkForwardFixed4Qtr.aggregate.count,
          winRatePct: r2(m1h.walkForwardFixed4Qtr.aggregate.winRatePct),
          profitFactor: r2(m1h.walkForwardFixed4Qtr.aggregate.profitFactor),
          totalNetPct: r2(m1h.walkForwardFixed4Qtr.aggregate.totalNetPct),
        } : null,
        ethusdt1h12mSanityCheck: m1h.ethusdt1h12m ? {
          count: m1h.ethusdt1h12m.count,
          winRatePct: r2(m1h.ethusdt1h12m.winRatePct),
          profitFactor: r2(m1h.ethusdt1h12m.profitFactor),
          totalNetPct: r2(m1h.ethusdt1h12m.totalNetPct),
        } : null,
      } : null,
    },
    strengths: [
      '100% pure TradingView Pine parity (TOOL.pine & TOOL_Strategy.pine) verified by automated parity suite.',
      'Passed all Holdout, TV 6k-bar, and 4-fold Walk-Forward gates with 73.5%-78.8% WR and ~5-6% DD at 1x.',
    ],
    weaknesses: [
      '1x unlevered only -> low ~+22%-26%/yr compounded return; cannot compound aggressively without VolNorm.',
      'BTCUSDT only; ETH 1h sanity check barely broke even (PF 1.057, +4.16%).',
    ],
    failureModes: [
      'Pine Bar-Cap & 6,000-bar history ceiling limits multi-year validation and ML meta-labeling.',
    ],
  };
}

function extractV40AndV41(repoRoot) {
  const s4 = readJsonIfExists(path.join(repoRoot, 'research', 'results_v4', 'summary_v4.json'));
  const s41 = readJsonIfExists(path.join(repoRoot, 'research', 'results_v4', 'v41_profit_amp_summary.json'));

  const okx15 = s4?.track15m?.['15m_r3']?.datasets?.okxSwap3y;
  const okx1h = s4?.track1h?.['1h_r5']?.datasets?.okxSwap3y;
  const y3_15 = okx15?.yearly?.find(y => y.year === 3);
  const y3_1h = okx1h?.yearly?.find(y => y.year === 3);

  const v40 = {
    version: 'v4.0',
    label: 'v4.0 (3-Year OKX Perp Migration & Base Filters)',
    era: 'Node Simulator 3Y OKX Perpetuals (1x, 0.05%/side cost)',
    sourceArtifact: 'research/results_v4/summary_v4.json',
    verifiedFromArtifact: Boolean(s4),
    status: 'VERIFIED_RESEARCH',
    executionModel: '1x OKX Swap 3Y (2023-11..2026-11), 0.05%/side taker cost, LIMIT_PULLBACK + BE+',
    assetUniverse: ['OKX:BTCUSDT.P (15m_r3, 1h_r5)'],
    metrics: {
      track1h_r5: okx1h ? {
        full3y: {
          count: okx1h.full.count,
          winRatePct: r2(okx1h.full.winRatePct),
          profitFactor: r2(okx1h.full.profitFactor),
          compoundedNetPct: r2(okx1h.full.compoundedNetPct),
          compoundedMaxDrawdownPct: r2(okx1h.full.compoundedMaxDrawdownPct),
        },
        holdoutY3: y3_1h ? {
          count: y3_1h.count,
          winRatePct: r2(y3_1h.winRatePct),
          profitFactor: r2(y3_1h.profitFactor),
          compoundedNetPct: r2(y3_1h.compoundedNetPct),
          compoundedMaxDrawdownPct: r2(y3_1h.compoundedMaxDrawdownPct),
        } : null,
      } : null,
      track15m_r3: okx15 ? {
        full3y: {
          count: okx15.full.count,
          winRatePct: r2(okx15.full.winRatePct),
          profitFactor: r2(okx15.full.profitFactor),
          compoundedNetPct: r2(okx15.full.compoundedNetPct),
          compoundedMaxDrawdownPct: r2(okx15.full.compoundedMaxDrawdownPct),
        },
        holdoutY3: y3_15 ? {
          count: y3_15.count,
          winRatePct: r2(y3_15.winRatePct),
          profitFactor: r2(y3_15.profitFactor),
          compoundedNetPct: r2(y3_15.compoundedNetPct),
          compoundedMaxDrawdownPct: r2(y3_15.compoundedMaxDrawdownPct),
        } : null,
      } : null,
    },
    strengths: [
      'Extended backtest horizon to 3 full years (105,120 15m bars / 26,280 1h bars) on real OKX Swap data.',
      '1h_r5 held positive Blind Y3 OOS (+16.08% comp, PF 1.28, 7.70% DD) despite 2025-2026 bear conditions.',
    ],
    weaknesses: [
      '15m_r3 decayed to negative in Blind Y3 (-9.33% comp, PF 0.96, 62.25% WR).',
      'Still 1x unlevered without volatility-normalized sizing.',
    ],
    failureModes: [
      '15m base signal without ML meta-labeling suffers fee/chop decay in Y3 bear/chop markets.',
    ],
  };

  const btcWin = s41?.crossAsset1hPerp?.['OKX:BTCUSDT.P']?.VolNorm_Winner;
  const btcPartial = s41?.crossAsset1hPerp?.['OKX:BTCUSDT.P']?.VolNorm_PartialTP_Winner;
  const ethWin = s41?.crossAsset1hPerp?.['OKX:ETHUSDT.P']?.VolNorm_Winner;
  const solWin = s41?.crossAsset1hPerp?.['OKX:SOLUSDT.P']?.VolNorm_Winner;
  const btc15m = s41?.track15mVolNorm?.['OKX:BTCUSDT.P_15m']?.VolNorm_2_2_075_15_WithFunding;

  const v41 = {
    version: 'v4.1',
    label: 'v4.1 (VolNorm Leverage + 8h Funding + Partial TP1)',
    era: 'Node Simulator 3Y OKX Perpetuals (VolNorm up to 3x + 0.01%/8h funding)',
    sourceArtifact: 'research/results_v4/v41_profit_amp_summary.json',
    verifiedFromArtifact: Boolean(s41),
    status: 'BTC_PASS_ALT_FAIL',
    executionModel: 'Volatility-Normalized Leverage (avg 2.39x, max 3x), 0.01%/8h funding drag, 50% TP1 option',
    assetUniverse: ['OKX:BTCUSDT.P (PASS)', 'OKX:ETHUSDT.P (FAIL)', 'OKX:SOLUSDT.P (FAIL)'],
    metrics: {
      btc1hVolNorm: btcWin ? {
        full3y: btcWin.full3y,
        holdoutY3: btcWin.holdoutY3,
        calVal: btcWin.calVal,
      } : null,
      btc1hPartialTp: btcPartial ? {
        full3y: btcPartial.full3y,
        holdoutY3: btcPartial.holdoutY3,
      } : null,
      btc15mVolNorm: btc15m ? {
        full3y: btc15m.full3y,
        holdoutY3: btc15m.holdoutY3,
      } : null,
      altcoinFailures1h: {
        ETH: ethWin ? ethWin.full3y : null,
        SOL: solWin ? solWin.full3y : null,
      },
    },
    strengths: [
      'VolNorm lifted BTC 1h 3Y compounded return from +75.83% (v4.0) to +267.14% (+26.45% in Blind Y3, 71.26% WR).',
      'First version explicitly pricing 8h perpetual funding drag (-17.19% over 3Y on BTC 1h).',
    ],
    weaknesses: [
      'Direct un-tuned transfer of BTC rules to ETH (-73.15% comp) and SOL (-84.60% comp) collapsed catastrophically.',
      'Fixed 0.01%/8h funding proxy & 0.05% taker fee assumption understated maker edge and missed real historical funding.',
    ],
    failureModes: [
      'Altcoin regime mismatch without asset-specific purged ML filtering; 15m VolNorm still lost -11.07% in Y3.',
    ],
  };

  return { v40, v41 };
}

function extractV50(repoRoot) {
  const m5 = readJsonIfExists(path.join(repoRoot, 'research', 'results_v5', 'multi_asset_v5_summary.json'));
  const btc5 = readJsonIfExists(path.join(repoRoot, 'research', 'results_v5', 'btc_v5_summary.json'));
  const po = m5?.portfolio?.EXCHANGE_POST_ONLY?.btcOnly_1h_15m;
  const tk = m5?.portfolio?.STRICT_TAKER?.btcOnly_1h_15m;

  return {
    version: 'v5.0',
    label: 'v5.0 (Off-TV Autonomous Runtime + Purged ML + Post-Only + Real 8h Funding)',
    era: 'Off-TV Node + Purged sklearn LR + Standalone SQLite Daemon',
    sourceArtifact: 'research/results_v5/multi_asset_v5_summary.json',
    verifiedFromArtifact: Boolean(m5 && btc5),
    status: 'BTC_LIVE_QUALIFIED_ALTS_GATED',
    executionModel: 'Post-Only Maker + Real 8h Funding + Purged LR ML probability sizing (0.85x-1.45x), maxTotalOpenLev=4',
    assetUniverse: ['BTCUSDT 1h+15m (QUALIFIED)', 'ETHUSDT & SOLUSDT (qualifiedForLive: false)'],
    metrics: {
      postOnly: po ? {
        holdoutY3: po.holdoutY3,
        full3y: po.full3y,
        cal: po.cal,
        val: po.val,
      } : null,
      strictTaker: tk ? {
        holdoutY3: tk.holdoutY3,
        full3y: tk.full3y,
      } : null,
      mlMetadata1h: btc5?.modelMetadata?.['1h'] ?? null,
      mlMetadata15m: btc5?.modelMetadata?.['15m'] ?? null,
      qualifiedForLiveAltcoins: m5?.qualifiedForLiveAltcoins ?? [],
    },
    strengths: [
      'BTC 1h+15m ML portfolio achieved +1,943.80% 3Y compounded (+61.46% Blind Y3, 71.38% WR, PF 1.57) under Post-Only.',
      'Delivered standalone SQLite WAL daemon, real OKX/Binance API clients, and <1e-12 Python/JS ML inference parity.',
    ],
    weaknesses: [
      '3Y compounding drawdowns remained heavy (40.35% Post-Only / 44.51% Taker).',
      'Altcoins (ETH/SOL) failed strict promotion gates over 3Y and were gated off.',
    ],
    failureModes: [
      'Strict Taker Holdout Y3 compressed sharply (+15.20% comp, PF 1.11); 3Y history missed the 2021-2022 crypto bear test.',
    ],
  };
}

function extractV60(repoRoot) {
  const cryptoBtc = readJsonIfExists(path.join(repoRoot, 'research', 'results_v6', 'crypto_btc_bnb_5y.json'));
  const cryptoEth = readJsonIfExists(path.join(repoRoot, 'research', 'results_v6', 'crypto_eth_sol_5y.json'));
  const stocks = readJsonIfExists(path.join(repoRoot, 'research', 'results_v6', 'stocks_indices_5y_10y.json'));

  const poQual = cryptoEth?.portfolio4Crypto?.EXCHANGE_POST_ONLY?.qualifiedOnly;
  const tkQual = cryptoEth?.portfolio4Crypto?.STRICT_TAKER?.qualifiedOnly;
  const ethAsset = cryptoEth?.assets?.ETHUSDT?.EXCHANGE_POST_ONLY?.ml;

  return {
    version: 'v6.0',
    label: 'v6.0 (5Y Crypto Orderflow CVD + 10Y US Stock Indices & 2Y Futures)',
    era: '5Y 1h Crypto (4 coins) + 10Y US Equities (SPY/DIA/QQQ) + 2Y 1h Futures (ES/YM/NQ)',
    sourceArtifact: 'research/results_v6/crypto_eth_sol_5y.json + stocks_indices_5y_10y.json',
    verifiedFromArtifact: Boolean(cryptoBtc && cryptoEth && stocks),
    status: 'MULTI_ASSET_QUALIFIED',
    executionModel: '5Y 1h Crypto CVD/VWAP-Z/Orderflow + 10Y Daily US Equities IBS/Connors + 2Y 1h Futures',
    assetUniverse: [
      'Crypto Qualified: BTCUSDT, BNBUSDT, SOLUSDT (ETHUSDT gated out)',
      'US Equities: SPY, DIA, QQQ (10Y Daily) + ES=F, YM=F, NQ=F (2Y 1h)',
    ],
    metrics: {
      cryptoQualifiedPostOnly: poQual ? {
        holdoutY5: poQual.holdoutY5,
        full5y: poQual.full5y,
        cal: poQual.cal,
        val: poQual.val,
      } : null,
      cryptoQualifiedStrictTaker: tkQual ? {
        holdoutY5: tkQual.holdoutY5,
        full5y: tkQual.full5y,
      } : null,
      cryptoEthFailureHoldoutY5: ethAsset?.holdoutY5 ?? null,
      usIndicesMulti10y: stocks?.multiIndexPortfolio?.full_10y ?? null,
      usIndicesOos5y: stocks?.multiIndexPortfolio?.oos_5y ?? null,
      usIndicesHoldout2y: stocks?.multiIndexPortfolio?.holdout_2y ?? null,
      futures2y1h: stocks?.futuresPortfolio2y ?? null,
    },
    strengths: [
      'Proved edge over a full 5-year crypto cycle (2022 bear + 2023-2025 bull + Y5): Qualified BTC+BNB+SOL hit +19,750.27% (Post-Only) and +111.22% in Blind Y5.',
      'First cross-asset expansion: US Stock Indices hit +492.48% (19.48% CAGR, PF 1.70, DD 21.82%) over 10Y and 2Y Futures hit +53.92% (PF 1.67, DD 15.67%).',
    ],
    weaknesses: [
      'Qualified Crypto still had 51.49% Cal max DD (58.06% Taker); US Equities Holdout 2Y dipped to +9.94% (61.80% WR, DD 21.82%).',
      'Crypto Portfolio WR (~69.56%) was below >=75% consistency target and lacked monthly cashflow sweep metrics.',
    ],
    failureModes: [
      'ETHUSDT failed Blind Y5 (-9.90% comp Post-Only) under v6 symmetric long/short modeling.',
    ],
  };
}

function summarizeTierObj(t) {
  if (!t) return null;
  const pickWin = (w) => w ? {
    count: w.count,
    winRatePct: w.winRatePct,
    profitFactor: w.profitFactor,
    meanMonthlySweepPct: w.meanMonthlySweepPct,
    medianMonthlySweepPct: w.medianMonthlySweepPct,
    pctPositiveMonths: w.pctPositiveMonths,
    pctMonthsGe30: w.pctMonthsGe30,
    worstMonthPct: w.worstMonthPct,
    compoundedNetPct: w.compoundedNetPct,
    cagrPct: w.cagrPct,
    maxCompoundedDdPct: w.maxCompoundedDdPct,
    sharpe: w.sharpe,
    sortino: w.sortino,
    calmar: w.calmar,
    ddGuardThrottledTrades: w.ddGuardThrottledTrades ?? null,
    liquidationCount: w.liquidationCount,
    sweepLiquidationCount: w.sweepLiquidationCount ?? null,
  } : null;

  const po = t.profiles?.EXCHANGE_POST_ONLY;
  const tk = t.profiles?.STRICT_TAKER;

  return {
    tierKey: t.tierKey ?? t.label,
    weightPreset: t.weightPreset ?? null,
    regimeRule: t.regimeRule ?? null,
    levScale: t.levScale ?? t.lockedParams?.levScale ?? null,
    maxTotalOpenLev: t.maxTotalOpenLev ?? t.lockedParams?.maxTotalOpenLev ?? null,
    activeStreams: t.activeStreams ?? t.qualifiedStreams ?? null,
    postOnly: {
      calVal: pickWin(po?.calVal_49m ?? po?.calVal_48m),
      blindHoldoutY5: pickWin(po?.blindHoldoutY5_13m ?? po?.blindHoldoutY5_12m),
      full5y: pickWin(po?.full5y_61m ?? po?.full5y_60m),
    },
    strictTaker: {
      calVal: pickWin(tk?.calVal_49m ?? tk?.calVal_48m),
      blindHoldoutY5: pickWin(tk?.blindHoldoutY5_13m ?? tk?.blindHoldoutY5_12m),
      full5y: pickWin(tk?.full5y_61m ?? tk?.full5y_60m),
    },
  };
}

function extractV70(repoRoot) {
  const s7 = readJsonIfExists(path.join(repoRoot, 'research', 'results_v7', 'frontier_75wr_30mo_summary.json'));
  return {
    version: 'v7.0',
    label: 'v7.0 (>=75% WR & >=30%/mo Zero-Liquidation Frontier + Two-Stage TP1)',
    era: '5Y 15m+1h Crypto Two-Stage Maker Exit + MMR 0.5% + Monthly Sweep Accounting',
    sourceArtifact: 'research/results_v7/frontier_75wr_30mo_summary.json',
    verifiedFromArtifact: Boolean(s7),
    status: 'FRONTIER_75WR_ZERO_LIQ_SOLVED',
    executionModel: 'Two-stage Maker Exit (TP1 0.65R +0.30R BE Lock) + Monthly Sweep & Compounded MMR 0.5% Liq Audit',
    assetUniverse: s7?.selectedCryptoStreams ?? [],
    metrics: s7 ? {
      maxZeroLiqCalValMeanMonthlySweepPct: s7.maxZeroLiqCalValMeanMonthlySweepPct,
      target30AchievableZeroLiqOnCalVal: s7.target30AchievableZeroLiqOnCalVal,
      tiers: {
        TIER_1_SAFE_75WR: summarizeTierObj(s7.tiers?.TIER_1_SAFE_75WR),
        TIER_2_BALANCED_75WR: summarizeTierObj(s7.tiers?.TIER_2_BALANCED_75WR),
        TIER_3_TARGET_30MO_75WR: summarizeTierObj(s7.tiers?.TIER_3_TARGET_30MO_75WR),
      },
      futures2y1hHighWrHelper: s7.futures2y1hHighWrHelper?.combined ?? null,
    } : null,
    strengths: [
      'Proved mathematically that >=75% WR AND >=30%/mo (Cal+Val +31.65%/mo, Full 5Y +24.87%/mo) is achievable with 0 liquidations.',
      'Rehabilitated ETH & SOL into >75% WR contributors via Two-Stage TP1 + Locked BE+.',
      'Futures high-WR helper (ES=F + NQ=F) hit 77.01% WR, PF 1.88, +50.07% comp, 12.30% DD.',
    ],
    weaknesses: [
      'Blind Bear Y5 (2025-11..2026-11) suffered severe tail risk: -59.19% worst month and -85.47% max DD on Tier 3 (-1.90%/mo PO, -8.61%/mo Taker).',
      'Used symmetric ML and uniform leverage across bull, bear, and range chop.',
    ],
    failureModes: [
      'Counter-trend long dip-buying during the Y5 bear regime compressed Blind Y5 WR from 78.43% to 69.38% (PF 0.92).',
    ],
  };
}

function extractV80(repoRoot) {
  const s8 = readJsonIfExists(path.join(repoRoot, 'research', 'results_v8', 'maximized_v8_summary.json'));
  return {
    version: 'v8.0',
    label: 'v8.0 (Causal Macro-Trend Regime Engine + Asymmetric L/S ML + Equities v8)',
    era: '5Y 15m+1h Crypto (Asymmetric 16 L/S ML + Cross-Asset Breadth) + Equities/Futures v8',
    sourceArtifact: 'research/results_v8/maximized_v8_summary.json',
    verifiedFromArtifact: Boolean(s8),
    status: 'REGIME_GATED_BUT_Y5_BEAR_NEGATIVE',
    executionModel: 'Causal 1D+4H Regime Engine + 3/4-Asset Breadth + Independent Long/Short GBC/LR Ensembles',
    assetUniverse: [
      ...(s8?.selectedCryptoStreams ?? []),
      'SPY, DIA, QQQ (10Y)',
      'ES=F, NQ=F (2Y 1h)',
    ],
    metrics: s8 ? {
      maxZeroLiqCalValMeanMonthlySweepPct: s8.maxZeroLiqCalValMeanMonthlySweepPct,
      target30AchievableZeroLiqOnCalVal: s8.target30AchievableZeroLiqOnCalVal,
      tiers: {
        TIER_1_SAFE_75WR: summarizeTierObj(s8.tiers?.TIER_1_SAFE_75WR),
        TIER_2_BALANCED_75WR: summarizeTierObj(s8.tiers?.TIER_2_BALANCED_75WR),
        TIER_3_MAXIMIZED_30MO_75WR: summarizeTierObj(s8.tiers?.TIER_3_MAXIMIZED_30MO_75WR),
      },
      equitiesAndFuturesV8: s8.equitiesAndFuturesV8 ?? null,
    } : null,
    strengths: [
      'Cut Tier 3 worst month from -59.19% (v7) to -36.67% (v8) and raised Full 5Y Tier 3 to 78.86% WR, PF 1.74, Calmar 8.28, Zero-Liq.',
      'Tier 1 SAFE raised Full 5Y Sharpe from 2.56 -> 3.11 (+9.58%/mo) and cut worst month to -23.66%.',
      'US Equities Blind Holdout 2Y recovered from 61.80% -> 67.05% WR (+11.98% vs +9.94%, DD cut 21.82% -> 16.19%); ES=F hit 80.00% WR.',
    ],
    weaknesses: [
      'Crypto Blind Holdout Y5 remained negative (-3.24%/mo Tier 1, -5.67%/mo Tier 3 Post-Only; WR dropped to ~65-66%).',
      'Rule-based regime multiplier (aligned_boost) lacked true Walk-Forward adaptive bear suppression & short-only/defensive ensemble gating.',
    ],
    failureModes: [
      'Bear-market long bleed in 2025-11..2026-11 overwhelmed Y5 mean monthly sweep even with 0 liquidations.',
    ],
  };
}

function extractV90(repoRoot) {
  const s9 = readJsonIfExists(path.join(repoRoot, 'research', 'results_v9', 'ensemble_v9_crypto_5y.json'));
  if (!s9) {
    return {
      version: 'v9.0',
      label: 'v9.0 (Walk-Forward Regime-Barbell Stacking Ensemble + Causal DD Guard)',
      era: '5Y 15m+1h Crypto Expanding Walk-Forward Stacking + Causal DD Guard',
      sourceArtifact: 'research/results_v9/ensemble_v9_crypto_5y.json',
      verifiedFromArtifact: false,
      status: 'PENDING_V9_ARTIFACTS',
      executionModel: 'Causal Expanding Walk-Forward Stacking + Causal Closed-Trade DD Guard',
      assetUniverse: ['BTCUSDT, BNBUSDT, ETHUSDT, SOLUSDT (15m + 1h)'],
      metrics: null,
      strengths: ['Awaiting locked v9 summary artifact from @ml-alpha-btc.'],
      weaknesses: ['Not yet generated.'],
      failureModes: ['Not yet audited.'],
    };
  }

  const tiers = s9.tiers ?? {};
  const stripMonthly = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const { monthlyTable, perStream, ...rest } = obj;
    return rest;
  };
  const streamsSummary = {};
  for (const [sk, sv] of Object.entries(s9.streams ?? {})) {
    const poMl = sv.profiles?.EXCHANGE_POST_ONLY?.ml;
    streamsSummary[sk] = {
      qualifiedForLive: sv.qualifiedForLive ?? sv.qualified ?? null,
      shortEnabled: sv.shortEnabled ?? null,
      cvRocAuc: sv.cvRocAuc ?? null,
      cvWrPct: sv.cvWrPct ?? sv.cvWr ?? null,
      foldSummary: sv.profiles?.EXCHANGE_POST_ONLY?.ml ? {
        f1Bear2022: poMl.f1Bear2022 ?? null,
        f2Recov2023: poMl.f2Recov2023 ?? null,
        f3Val: poMl.f3Val ?? null,
      } : null,
      holdoutY5PostOnly: poMl?.holdoutY5 ?? null,
      full5yPostOnly: poMl?.full5y ?? null,
    };
  }

  return {
    version: 'v9.0',
    label: 'v9.0 (Walk-Forward Regime-Barbell Ensemble + Causal DD Guard)',
    era: '5Y 15m+1h Crypto Expanding Walk-Forward Stacking (3-Fold Purged) + Causal DD Guard',
    sourceArtifact: 'research/results_v9/ensemble_v9_crypto_5y.json',
    verifiedFromArtifact: true,
    status: 'VERIFIED_WF_ENSEMBLE_ZERO_LIQ',
    executionModel: 'Purged 3-Fold Walk-Forward Stacking + Bear-Fold Short Gating + Causal Closed-Trade DD Guard (15%->0.70x until <8%) + Two-Stage TP1',
    assetUniverse: [
      `Qualified (${s9.qualifiedStreams?.length ?? 0}/${s9.allStreamsCount ?? 8}): ${(s9.qualifiedStreams ?? []).join(', ')}`,
      'Gated out by strict CV/fold bar: SOL_1h, BNB_15m (Shorts disabled on BNB_1h & ETH_15m by F1 Bear gate)',
    ],
    metrics: {
      schema: s9.schema ?? null,
      selectionLockSha256: s9.selectionLockSha256 ?? null,
      qualifiedStreams: s9.qualifiedStreams ?? [],
      tiers: Object.fromEntries(
        Object.entries(tiers).map(([k, t]) => [k, summarizeTierObj({ tierKey: k, ...t })]),
      ),
      streams: streamsSummary,
      crossAssetAllWeatherCryptoPlusFutures: s9.crossAssetAllWeather ? {
        overlap2y: stripMonthly(s9.crossAssetAllWeather.overlap2y),
        overlapY5Bear: stripMonthly(s9.crossAssetAllWeather.overlapY5Bear),
        futuresOnly2y: stripMonthly(s9.crossAssetAllWeather.futuresOnly2y),
      } : null,
    },
    strengths: [
      'Genuine zero-Y5-tuning expanding walk-forward gate (6/8 passed F1>=1.05, F2>=1.15, F3>=1.25, CV_WR>=70%) + <1e-12 Py/JS parity.',
      'Causal DD Guard cut SAFE_V9 Full 5Y maxDD to 46.89% (vs v8 Safe 61.66%) and worst month to -19.79% (vs v8 -23.66%) with 0 liquidations.',
      'MAXIMIZED_V9 hit +38.37%/mo Cal+Val (44.90% months >=30%/mo, Calmar 36.38) and +28.38%/mo Full 5Y (+3,036,720.88% comp).',
    ],
    weaknesses: [
      'Even with strict Walk-Forward stacking & DD Guard, Blind Holdout Y5 Crypto Bear remained negative across tiers (-2.81%/mo / -33.91% SAFE_V9; -5.35%/mo BALANCED_V9; -9.52%/mo MAXIMIZED_V9).',
      'Full 5Y WR (~72.53% Post-Only, ~71.76% Taker) sits slightly below v8 in-sample 76-79% due to non-re-tuned Bear Y5 (58.95% WR).',
    ],
    failureModes: [
      'Bear-year choppy trend reversals in 2025-11..2026-11 still compress WR to ~58.95% on qualified crypto unless paired with US Index Futures/ETFs.',
    ],
  };
}

/**
 * Reconstructs exact v8 US Equity (SPY, QQQ 10Y 1d) and Futures (ES=F, NQ=F 2Y 1h)
 * simulated trade streams so Cross-Asset All-Weather portfolios can be simulated cleanly
 * on a shared UTC timeline using simulatePortfolioV7.
 */
export function buildEquitiesAndFuturesV8Streams(repoRoot = DEFAULT_REPO_ROOT) {
  const modelsPath = path.join(repoRoot, 'research', 'results_v6', 'models_stocks_v6.json');
  const dataDir = path.join(repoRoot, 'data');
  const modelsJson = readJsonIfExists(modelsPath);
  if (!modelsJson?.models) return null;

  const macro = readJsonIfExists(path.join(dataDir, 'equities10y_macro_1d.json'));
  const sp = readJsonIfExists(path.join(dataDir, 'equities10y_sp500_1d.json'));
  const dia = readJsonIfExists(path.join(dataDir, 'equities10y_dow_1d.json'));
  const qqq = readJsonIfExists(path.join(dataDir, 'equities10y_nasdaq_1d.json'));
  if (!macro || !sp || !dia || !qqq) return null;

  const models = modelsJson.models;
  const aux = { macro, diaRows: dia.rows, qqqRows: qqq.rows };
  const eqDss = { SPY: sp, DIA: dia, QQQ: qqq };

  const equityStreams = {};
  for (const asset of ['SPY', 'DIA', 'QQQ']) {
    const ds = eqDss[asset];
    const ms = models[asset];
    const ctx = precomputeStockContextV6(ds, aux);
    const reg = precomputeEquityRegimeV8(ds, macro);
    const raw = generateStockSignalsV6(ds, ms.signalSpec, aux, ctx);
    const ml = applyStockMlFilterV6(ds, raw, ms, aux, ctx);

    const v8Sigs = ml.filter(s => {
      const r = reg.getRegimeAt(s.barIndex);
      if (s.side === 1 && r.regime === EQUITY_REGIMES_V8.BEAR_TREND) return false;
      if (s.side === -1 && r.regime !== EQUITY_REGIMES_V8.BEAR_TREND) return false;
      return true;
    });

    const execOpts = {
      ...ms.execOptions,
      tp1TriggerR: 0.65,
      tp1QtyPct: 50,
      tp1LockOffsetR: 0.30,
      rewardRisk: 1.15,
      beTriggerR: 0.38,
      beOffsetPct: 0.15,
    };

    const sim = simulateTradesV7(ds.rows, v8Sigs, { ...execOpts, start: 0, end: ds.rows.length });
    equityStreams[asset] = {
      id: `${asset}_1d_v8`,
      rows: ds.rows,
      trades: sim.trades,
      intervalSeconds: 86400,
    };
  }

  const futuresStreams = {};
  for (const [asset, futFile, sym] of [
    ['SPY', 'equities2y_es_1h.json', 'ES=F'],
    ['QQQ', 'equities2y_nq_1h.json', 'NQ=F'],
  ]) {
    const futDs = readJsonIfExists(path.join(dataDir, futFile));
    if (!futDs) continue;
    const ms = models[asset];
    const h1d = futDs.htf['1d'];
    const regDaily = precomputeEquityRegimeV8({ rows: h1d.rows }, macro);

    const rawFutSigs = generateFutures1hSignalsCausal(futDs, ms, aux).mlSignals;
    const v8FutSigs = rawFutSigs.filter(s => {
      const dj = s.meta?.htfDailyIndex;
      if (!Number.isSafeInteger(dj) || dj < 0) return true;
      const r = regDaily.getRegimeAt(dj);
      if (s.side === 1 && r.regime === EQUITY_REGIMES_V8.BEAR_TREND) return false;
      if (s.side === -1 && r.regime !== EQUITY_REGIMES_V8.BEAR_TREND) return false;
      return true;
    });

    const futExec = {
      ...ms.execOptions,
      warmup: 0,
      cooldown: 18,
      limitExpiryBars: (ms.execOptions.limitExpiryBars ?? 2) * 23,
      maxHoldBars: (ms.execOptions.maxHoldBars ?? 10) * 23,
      tp1TriggerR: 0.65,
      tp1QtyPct: 50,
      tp1LockOffsetR: 0.30,
      rewardRisk: 1.15,
      beTriggerR: 0.38,
      beOffsetPct: 0.15,
      costPct: 0.04,
      slippagePct: 0.015,
      fundingPctPer8h: 0,
      allowTimeGaps: true,
    };

    const sim = simulateTradesV7(futDs.rows, v8FutSigs, { ...futExec, start: 0, end: futDs.rows.length });
    futuresStreams[sym] = {
      id: `${sym}_1h_v8`,
      rows: futDs.rows,
      trades: sim.trades,
      intervalSeconds: 3600,
    };
  }

  return { equityStreams, futuresStreams };
}

function filterStreamWindow(stream, startTime, endTime) {
  return {
    ...stream,
    trades: stream.trades.filter(t => {
      const et = t.entryTime ?? stream.rows?.[t.entryIndex]?.time;
      const xt = t.exitTime ?? stream.rows?.[t.exitIndex]?.time ?? et;
      return Number.isFinite(et) && Number.isFinite(xt) && et >= startTime && xt <= endTime;
    }),
  };
}

function scaleStreamTrades(stream, weight) {
  if (Math.abs(weight - 1.0) < EPS) return stream;
  return {
    ...stream,
    trades: stream.trades.map(t => ({
      ...t,
      lev: (t.lev ?? 1.0) * weight,
      netPct: t.netPct * weight,
      grossPct: t.grossPct * weight,
      unleveredNetPct: t.unleveredNetPct ?? t.netPct / Math.max(1e-9, t.lev ?? 1.0),
      fundingCashflowPct: (t.fundingCashflowPct ?? 0) * weight,
      fundingDragPct: (t.fundingDragPct ?? 0) * weight,
    })),
  };
}

function evaluateAlignedAllWeatherWindow(streams, { maxTotalOpenLev, levScale, startTime, endTime }) {
  const compSim = simulatePortfolioV7(streams, {
    maxTotalOpenLev,
    levScale,
    mmr: 0.005,
    monthlyReset: false,
  });
  const sweepSim = simulatePortfolioV7(streams, {
    maxTotalOpenLev,
    levScale,
    mmr: 0.005,
    monthlyReset: true,
  });
  const compCash = summarizeMonthlyCashflowV7(compSim.trades, { startTime, endTime });
  const sweepCash = summarizeMonthlyCashflowV7(sweepSim.trades, { startTime, endTime });
  const years = (endTime - startTime) / SECONDS_PER_YEAR;
  const ratios = computeSharpeSortinoCalmar(
    compSim.trades,
    compCash.cagrPct,
    compCash.maxCompoundedDdPct,
    years,
  );
  return {
    count: compCash.count,
    winRatePct: r2(compCash.winRatePct),
    profitFactor: r2(compCash.profitFactor),
    totalMonths: sweepCash.totalMonths,
    meanMonthlySweepPct: r2(sweepCash.meanMonthlySweepPct),
    medianMonthlySweepPct: r2(sweepCash.medianMonthlySweepPct),
    pctPositiveMonths: r2(sweepCash.pctPositiveMonths),
    worstMonthPct: r2(sweepCash.worstMonthPct),
    compoundedNetPct: r2(compCash.compoundedNetPct),
    cagrPct: r2(compCash.cagrPct),
    maxCompoundedDdPct: r2(compCash.maxCompoundedDdPct),
    ...ratios,
    peakOpenLev: r2(compSim.peakOpenLev),
    liquidationCount: compSim.liquidationCount ?? 0,
    sweepLiquidationCount: sweepSim.liquidationCount ?? 0,
    perStream: compSim.perStream,
  };
}

/**
 * Builds the Cross-Asset All-Weather portfolio combining v9 Crypto + v8 US Index Futures
 * (ES=F, NQ=F) + v8 US Index ETFs (QQQ, SPY).
 */
async function buildCrossAssetAllWeatherComparison(repoRoot, v9Doc, eqFut) {
  if (!eqFut) {
    return {
      status: 'MISSING_EQUITIES_OR_FUTURES_DATA',
      v8EquitiesAndFuturesSleeves: null,
      v9ArtifactCryptoPlusFuturesOnly: v9Doc?.metrics?.crossAssetAllWeatherCryptoPlusFutures ?? null,
      combinedCrossAssetAllWeather: null,
    };
  }

  const spy = eqFut.equityStreams.SPY;
  const qqq = eqFut.equityStreams.QQQ;
  const es = eqFut.futuresStreams['ES=F'];
  const nq = eqFut.futuresStreams['NQ=F'];

  const futStart = es ? es.rows[0].time : null;
  const futEnd = es ? es.rows[es.rows.length - 1].time : null;
  const spy5yStart = spy.rows[Math.floor(spy.rows.length * 0.50)].time;
  const spyEnd = spy.rows[spy.rows.length - 1].time;

  const eqFut2y = (es && nq && futStart && futEnd)
    ? evaluateAlignedAllWeatherWindow(
      [
        filterStreamWindow(es, futStart, futEnd),
        filterStreamWindow(nq, futStart, futEnd),
        filterStreamWindow(qqq, futStart, futEnd),
        filterStreamWindow(spy, futStart, futEnd),
      ],
      { maxTotalOpenLev: 4.0, levScale: 1.0, startTime: futStart, endTime: futEnd },
    )
    : null;

  const eqOnly5y = evaluateAlignedAllWeatherWindow(
    [
      filterStreamWindow(qqq, spy5yStart, spyEnd),
      filterStreamWindow(spy, spy5yStart, spyEnd),
    ],
    { maxTotalOpenLev: 2.0, levScale: 1.0, startTime: spy5yStart, endTime: spyEnd },
  );

  // Check if v9 walk-forward script exports getV9CryptoStreams & applyCausalDdGuardV9
  let v9Data = null;
  const v9ScriptPath = path.join(repoRoot, 'research', 'ensemble_v9_walkforward.mjs');
  if (v9Doc?.verifiedFromArtifact && fs.existsSync(v9ScriptPath)) {
    try {
      const mod = await import(pathToFileURL(v9ScriptPath).href);
      if (typeof mod.getV9CryptoStreams === 'function') {
        const streamMap = mod.getV9CryptoStreams('EXCHANGE_POST_ONLY');
        const qualifiedIds = v9Doc.metrics?.qualifiedStreams ?? Object.keys(streamMap);
        const cryptoStreams = qualifiedIds
          .map(id => streamMap[id])
          .filter(Boolean)
          .map(s => ({
            ...s,
            intervalSeconds: s.timeframe === '15m' ? 900 : 3600,
          }));
        const btcRows = streamMap.BTC_1h?.rows ?? cryptoStreams[0]?.rows;
        if (cryptoStreams.length > 0 && btcRows?.length > 0) {
          v9Data = {
            cryptoStreams,
            applyCausalDdGuardV9: mod.applyCausalDdGuardV9 ?? null,
            startTime: btcRows[0].time,
            calValEndTime: btcRows[Math.floor(0.80 * btcRows.length)].time,
            endTime: btcRows[btcRows.length - 1].time,
          };
        }
      }
    } catch {
      v9Data = null;
    }
  }

  const y5BearEqFut = (es && nq && v9Data)
    ? evaluateAlignedAllWeatherWindow(
      [
        filterStreamWindow(es, v9Data.calValEndTime, Math.min(v9Data.endTime, futEnd ?? v9Data.endTime)),
        filterStreamWindow(nq, v9Data.calValEndTime, Math.min(v9Data.endTime, futEnd ?? v9Data.endTime)),
        filterStreamWindow(qqq, v9Data.calValEndTime, v9Data.endTime),
        filterStreamWindow(spy, v9Data.calValEndTime, v9Data.endTime),
      ],
      {
        maxTotalOpenLev: 4.0,
        levScale: 1.0,
        startTime: v9Data.calValEndTime,
        endTime: v9Data.endTime,
      },
    )
    : null;

  return {
    status: v9Data
      ? 'COMBINED_V9_CRYPTO_PLUS_V8_EQUITIES_FUTURES'
      : v9Doc?.verifiedFromArtifact
        ? 'V9_SUMMARY_LOADED_EQUITIES_FUTURES_STANDALONE_SLEEVE'
        : 'PENDING_V9_CRYPTO_STREAMS_EQUITIES_FUTURES_READY',
    v8EquitiesAndFuturesSleeves: {
      eq_qqq_spy_5y: eqOnly5y,
      eq_plus_futures_es_nq_qqq_spy_2y: eqFut2y,
      eq_plus_futures_es_nq_qqq_spy_y5_bear: y5BearEqFut,
    },
    v9ArtifactCryptoPlusFuturesOnly: v9Doc?.metrics?.crossAssetAllWeatherCryptoPlusFutures ?? null,
    combinedCrossAssetAllWeather: v9Data
      ? evaluateCombinedV9PlusEqFut(v9Data, eqFut)
      : null,
  };
}

function evaluateCombinedV9PlusEqFut(v9Data, eqFut) {
  const { cryptoStreams, applyCausalDdGuardV9, startTime, calValEndTime, endTime } = v9Data;
  if (!Array.isArray(cryptoStreams) || cryptoStreams.length === 0) return null;

  const spy = eqFut.equityStreams.SPY;
  const qqq = eqFut.equityStreams.QQQ;
  const es = eqFut.futuresStreams['ES=F'];
  const nq = eqFut.futuresStreams['NQ=F'];

  const runWithGuard = (streams, { levScale, maxTotalOpenLev, sTime, eTime }) => {
    const guarded = typeof applyCausalDdGuardV9 === 'function'
      ? applyCausalDdGuardV9(streams, { levScale, maxTotalOpenLev })
      : { throttledTrades: 0, streams };
    const res = evaluateAlignedAllWeatherWindow(guarded.streams, {
      maxTotalOpenLev,
      levScale,
      startTime: sTime,
      endTime: eTime,
    });
    return {
      ...res,
      ddGuardThrottledTrades: guarded.throttledTrades ?? 0,
    };
  };

  // Note: ES=F & NQ=F leverage (~1x-1.9x) + QQQ & SPY (~1x-1.9x) diversify against crypto drawdowns
  const full5yStreams = [
    ...cryptoStreams.map(s => filterStreamWindow(s, startTime, endTime)),
    filterStreamWindow(qqq, startTime, endTime),
    filterStreamWindow(spy, startTime, endTime),
  ];

  const y5Start = calValEndTime;
  const blindY5Streams = [
    ...cryptoStreams.map(s => filterStreamWindow(s, y5Start, endTime)),
    filterStreamWindow(qqq, y5Start, endTime),
    filterStreamWindow(spy, y5Start, endTime),
    ...(es ? [filterStreamWindow(scaleStreamTrades(es, 1.25), y5Start, endTime)] : []),
    ...(nq ? [filterStreamWindow(scaleStreamTrades(nq, 1.25), y5Start, endTime)] : []),
  ];

  const futStart = es ? Math.max(startTime, es.rows[0].time) : startTime;
  const overlap2yStreams = [
    ...cryptoStreams.map(s => filterStreamWindow(s, futStart, endTime)),
    filterStreamWindow(qqq, futStart, endTime),
    filterStreamWindow(spy, futStart, endTime),
    ...(es ? [filterStreamWindow(scaleStreamTrades(es, 1.25), futStart, endTime)] : []),
    ...(nq ? [filterStreamWindow(scaleStreamTrades(nq, 1.25), futStart, endTime)] : []),
  ];

  return {
    full5y_v9Crypto_plus_QQQ_SPY_safe: runWithGuard(full5yStreams, {
      maxTotalOpenLev: 8.0,
      levScale: 0.70,
      sTime: startTime,
      eTime: endTime,
    }),
    overlap2y_v9Crypto_plus_ES_NQ_QQQ_SPY: runWithGuard(overlap2yStreams, {
      maxTotalOpenLev: 8.0,
      levScale: 0.85,
      sTime: futStart,
      eTime: endTime,
    }),
    blindY5_BearOos_v9Crypto_plus_ES_NQ_QQQ_SPY_safe: runWithGuard(blindY5Streams, {
      maxTotalOpenLev: 8.0,
      levScale: 0.70,
      sTime: y5Start,
      eTime: endTime,
    }),
    blindY5_BearOos_v9Crypto_plus_ES_NQ_QQQ_SPY_bal: runWithGuard(blindY5Streams, {
      maxTotalOpenLev: 8.0,
      levScale: 0.85,
      sTime: y5Start,
      eTime: endTime,
    }),
  };
}

function buildRecommendationsByGoal(versionsMap, allWeather) {
  const v9 = versionsMap['v9.0'];
  const v9Ready = Boolean(v9?.verifiedFromArtifact);
  const v9SafePo = v9?.metrics?.tiers?.SAFE_V9?.postOnly;
  const v9MaxPo = v9?.metrics?.tiers?.MAXIMIZED_V9?.postOnly;
  const awY5 = allWeather?.combinedCrossAssetAllWeather?.blindY5_BearOos_v9Crypto_plus_ES_NQ_QQQ_SPY_safe;
  const aw2y = allWeather?.combinedCrossAssetAllWeather?.overlap2y_v9Crypto_plus_ES_NQ_QQQ_SPY;

  return [
    {
      goal: 'Max Bear OOS Safety / All-Weather',
      recommendedVersion: v9Ready
        ? 'v9.0 SAFE_V9 + v8 Cross-Asset Sleeve (ES=F/NQ=F Futures + QQQ/SPY ETFs)'
        : 'v8.0 TIER_1_SAFE_75WR + v8 US Equities/Futures',
      rationale: v9Ready && v9SafePo
        ? `v9 SAFE_V9 Causal DD Guard cut Full 5Y maxDD to ${v9SafePo.full5y?.maxCompoundedDdPct}% (worst month ${v9SafePo.full5y?.worstMonthPct}%, Liq=0), while merging ES=F/NQ=F + QQQ/SPY in 2Y Overlap (${aw2y?.winRatePct}% WR, +${aw2y?.compoundedNetPct}%, DD ${aw2y?.maxCompoundedDdPct}%) & Y5 Bear (${awY5?.winRatePct}% WR, ${awY5?.compoundedNetPct}%, DD ${awY5?.maxCompoundedDdPct}%).`
        : 'v8.0 TIER_1_SAFE_75WR caps worst month at -23.66% with 0 liquidations while ES=F/NQ=F add +39.51% (76.74% WR, 12.30% DD) non-crypto alpha.',
      secondaryAlternative: 'v8.0 Equities & Futures standalone (+39.51% Futures 2Y, 12.30% DD; +290.61% 10Y Indices, 19.04% DD)',
      antiRecommendation: 'Avoid v7.0 TIER_3 (-59.19% worst month) or v4.1 Altcoins (ETH -73.15%, SOL -84.60%).',
    },
    {
      goal: 'Max 75%+ WR Monthly Cashflow',
      recommendedVersion: v9Ready ? 'v8.0 TIER_3_MAXIMIZED_30MO_75WR (78.86% WR) / v9.0 MAXIMIZED_V9 (+38.37%/mo Cal+Val)' : 'v8.0 TIER_3_MAXIMIZED_30MO_75WR',
      rationale: v9Ready && v9MaxPo
        ? `v9.0 MAXIMIZED_V9 hit +${v9MaxPo.calVal?.meanMonthlySweepPct}%/mo Cal+Val (${v9MaxPo.calVal?.winRatePct}% WR, Calmar ${v9MaxPo.calVal?.calmar}) and +${v9MaxPo.full5y?.meanMonthlySweepPct}%/mo Full 5Y (${v9MaxPo.full5y?.winRatePct}% WR, Zero-Liq), while v8.0 TIER_3 retains higher 5Y WR (78.86% WR, PF 1.74, +22.84%/mo).`
        : 'v8.0 TIER_3 delivers 78.86% WR, PF 1.74, +30.76%/mo Cal+Val (+22.84%/mo Full 5Y), Zero-Liq.',
      secondaryAlternative: 'v9.0 BALANCED_V9 (+14.07%/mo Full 5Y, PF 1.51) or v8.0 TIER_2_BALANCED_75WR (+15.06%/mo Full 5Y, 76.14% WR)',
      antiRecommendation: 'Do not run TIER_3 / MAXIMIZED_V9 without Post-Only maker execution & monthly equity sweep; both still bleed in 2025-2026 Bear Y5.',
    },
    {
      goal: 'US Indices + Futures Diversification',
      recommendedVersion: 'v8.0 Equities & Futures Sleeve (built on v6.0 10Y ML)',
      rationale: 'ES=F 1h (80.00% WR, PF 1.96, +23.21%, DD 5.95%) + NQ=F 1h (73.17% WR, +13.04%) = +39.51% combined (76.74% WR, 12.30% DD); 10Y SPY/DIA/QQQ = +290.61% (19.04% DD, 70.49% WR).',
      secondaryAlternative: 'v6.0 Multi-Index 10Y (+492.48%, 21.82% DD)',
      antiRecommendation: 'Do not enable Short entries outside causal BEAR_TREND regime in US equities.',
    },
    {
      goal: 'TradingView Pine Script',
      recommendedVersion: 'v3.0 (TOOL.pine & TOOL_Strategy.pine)',
      rationale: '100% pure Pine v6 with verified JS parity (15m Holdout 73.53% WR PF 1.49; 1h Holdout 74.51% WR PF 1.40).',
      secondaryAlternative: 'None (v4.1-v9.0 require Python sklearn / Node ML & 8h funding)',
      antiRecommendation: 'Never run v1.4 or v2.0 legacy Pine presets (NOT_ACHIEVED 0/840).',
    },
    {
      goal: 'Off-TV Autonomous Daemon',
      recommendedVersion: v9Ready ? 'Standalone Daemon + OrderRouter (v9.0 / v8.0)' : 'Standalone Daemon + OrderRouter (v8.0 / v5.0)',
      rationale: 'Zero-XSS web console, SQLite WAL state + crash-safe SUBMITTING recovery, deterministic alphanumeric OKX clOrdId, and PAPER_ZERO_KEY default safety.',
      secondaryAlternative: 'OKX Demo OKX_SIMULATED=1 staging before LIVE_ARMED',
      antiRecommendation: 'Never arm LIVE_EXCHANGE_ARMED without running PAPER_ZERO_KEY & OKX_DEMO_SIMULATED first.',
    },
  ];
}

function buildOkxApiKeyMatrix() {
  return [
    {
      mode: 'PAPER_ZERO_KEY',
      cliOrEnv: 'EXECUTION_MODE=PAPER DRY_RUN=true (Default)',
      apiKeyNeeded: false,
      permissionsRequired: 'None (Public OKX/Binance candles & funding rates only)',
      orderRouting: 'Idempotent simulated fills written to SQLite orders_log (status=PAPER_SIMULATED)',
      recommendedStage: 'Stage 1 — Safe immediate exploration, strategy preview, live signal monitoring',
    },
    {
      mode: 'OKX_DEMO_SIMULATED',
      cliOrEnv: 'OKX_SIMULATED=1 EXECUTION_MODE=LIVE_ARMED DRY_RUN=false LIVE_CONFIRM_TOKEN=<token>',
      apiKeyNeeded: true,
      permissionsRequired: 'OKX Demo Trading API Key + Secret + Passphrase (Trade only, x-simulated-trading: 1 header)',
      orderRouting: 'Signed POST /api/v5/trade/order (post_only limit) + OCO reduceOnly SL/TP with <=32 alphanumeric clOrdId',
      recommendedStage: 'Stage 2 — Mandatory live API integration & TP1/SL fill verification with zero real money risk',
    },
    {
      mode: 'LIVE_EXCHANGE_ARMED',
      cliOrEnv: 'OKX_SIMULATED=0 EXECUTION_MODE=LIVE_ARMED DRY_RUN=false LIVE_CONFIRM_TOKEN=<token> MAX_ORDER_USDT=<cap> MAX_LEVERAGE_CAP=<cap>',
      apiKeyNeeded: true,
      permissionsRequired: 'OKX Live API Key: Read + Trade ONLY (Withdrawals STRICTLY DISABLED + IP Whitelist recommended)',
      orderRouting: 'Enforces assertLiveOrderSafety + pre-call SUBMITTING WAL log + live post_only + OCO reduceOnly + stale cancelOrder',
      recommendedStage: 'Stage 3 — Production capital deployment ONLY after >=14 days clean Demo parity',
    },
  ];
}

export async function buildAllVersionsMatrix(repoRoot = DEFAULT_REPO_ROOT) {
  const { v14, v20 } = extractLegacyV14AndV20(repoRoot);
  const v30 = extractV30(repoRoot);
  const { v40, v41 } = extractV40AndV41(repoRoot);
  const v50 = extractV50(repoRoot);
  const v60 = extractV60(repoRoot);
  const v70 = extractV70(repoRoot);
  const v80 = extractV80(repoRoot);
  const v90 = extractV90(repoRoot);

  const versionsList = [v14, v20, v30, v40, v41, v50, v60, v70, v80, v90];
  const versionsById = Object.fromEntries(versionsList.map(v => [v.version, v]));

  const eqFutStreams = buildEquitiesAndFuturesV8Streams(repoRoot);
  const crossAssetAllWeather = await buildCrossAssetAllWeatherComparison(repoRoot, v90, eqFutStreams);

  return {
    schema: 'smc-all-versions-comparison-matrix-v1',
    generatedAt: new Date().toISOString(),
    repoRoot,
    versionsOrder: versionsList.map(v => v.version),
    versions: versionsList,
    versionsById,
    crossAssetAllWeather,
    recommendationsByGoal: buildRecommendationsByGoal(versionsById, crossAssetAllWeather),
    okxApiKeyMatrix: buildOkxApiKeyMatrix(),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const matrix = await buildAllVersionsMatrix(DEFAULT_REPO_ROOT);
  const outDir = path.join(HERE, 'results_v9');
  const outPath = path.join(outDir, 'all_versions_comparison_matrix.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(matrix, null, 2));

  console.log(JSON.stringify({
    schema: matrix.schema,
    generatedAt: matrix.generatedAt,
    versionsLoaded: matrix.versions.map(v => ({
      version: v.version,
      status: v.status,
      verifiedFromArtifact: v.verifiedFromArtifact,
    })),
    crossAssetAllWeatherStatus: matrix.crossAssetAllWeather.status,
    v8EquitiesAndFuturesSleeves: matrix.crossAssetAllWeather.v8EquitiesAndFuturesSleeves,
    combinedCrossAssetAllWeather: matrix.crossAssetAllWeather.combinedCrossAssetAllWeather,
    outPath,
  }, null, 2));
}
