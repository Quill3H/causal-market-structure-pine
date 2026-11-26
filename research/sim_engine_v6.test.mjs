import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateTradesV5 } from './sim_engine_v5.mjs';
import {
  simulateTradesV6,
  simulatePortfolioV6,
  summarizePerformanceV6,
  DEFAULT_SIM_OPTIONS_V6,
} from './sim_engine_v6.mjs';
import {
  parseBinanceFuturesKline,
  cleanYahooChartSeries,
  alignHtfCausal,
} from './fetch_5y_crypto_and_stocks.mjs';

const START = Date.parse('2026-09-01T14:30:00Z') / 1000;
const DAY = 86400;

function near(actual, expected, tolerance = 1e-10) {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('EQUITY_ETF profile supports non-contiguous market hours (weekends/holidays) and 0.04% cost / 0.015% slip', () => {
  assert.equal(DEFAULT_SIM_OPTIONS_V6.equityCostPct, 0.04);
  assert.equal(DEFAULT_SIM_OPTIONS_V6.equitySlippagePct, 0.015);

  // Fri, Mon (+3d gap!), Tue, Wed (+2d holiday gap -> Fri)
  const rows = [
    { time: START,           open: 100, high: 101, low: 99,  close: 100, volume: 1000 },
    { time: START + 3 * DAY, open: 100, high: 103, low: 99.5, close: 102.5, volume: 1200 },
    { time: START + 4 * DAY, open: 102.5, high: 103, low: 101, close: 102, volume: 900 },
    { time: START + 7 * DAY, open: 102, high: 102.5, low: 100, close: 101, volume: 800 },
  ];

  // With allowTimeGaps=false (default for STRICT_TAKER), weekend gap throws
  assert.throws(() => simulateTradesV6(rows, [], { warmup: 0, allowTimeGaps: false }));

  // With EQUITY_ETF (allowTimeGaps defaults to true, fundingPctPer8h=0)
  const res = simulateTradesV6(rows, [{ barIndex: 0, side: 1, atr: 2 }], {
    execProfile: 'EQUITY_ETF',
    warmup: 0,
    cooldown: 1,
    stopAtr: 1.0,
    rewardRisk: 1.0,
    maxHoldBars: 3,
  });

  assert.equal(res.count, 1);
  const t = res.trades[0];
  assert.equal(t.execProfile, 'EQUITY_ETF');
  assert.equal(t.exitReason, 'TP');
  const entry = 100 * (1 + 0.00015);
  const target = entry + 2;
  const exit = target * (1 - 0.00015);
  const gross = ((exit - entry) / entry) * 100;
  near(t.entry, entry);
  near(t.exit, exit);
  near(t.grossPct, gross);
  near(t.netPct, gross - 0.04);
  near(t.fundingDragPct, 0);
});

test('EQUITY_ETF handles realistic overnight/weekend gapStop at row.open and conservative gapTarget at target', () => {
  const rowsGapStop = [
    { time: START,           open: 100, high: 101, low: 99,  close: 100, volume: 1000 },
    { time: START + 1 * DAY, open: 100, high: 101, low: 99.5, close: 100.2, volume: 1000 },
    // Weekend gap down far below SL=98 to open 93!
    { time: START + 4 * DAY, open: 93,  high: 99,  low: 92,   close: 96,   volume: 2000 },
  ];
  const rStop = simulateTradesV6(rowsGapStop, [{ barIndex: 0, side: 1, atr: 2 }], {
    execProfile: 'EQUITY_ETF',
    warmup: 0,
    stopAtr: 1.0,
    rewardRisk: 1.0,
  });
  assert.equal(rStop.count, 1);
  assert.equal(rStop.trades[0].exitReason, 'SL');
  near(rStop.trades[0].exit, 93 * (1 - 0.00015));

  // Overnight gap up far above TP=102 -> conservative fill capped at target (no free windfall)
  const rowsGapTp = [
    { time: START,           open: 100, high: 101, low: 99,   close: 100, volume: 1000 },
    { time: START + 1 * DAY, open: 100, high: 101, low: 99.5, close: 100.2, volume: 1000 },
    { time: START + 4 * DAY, open: 108, high: 109, low: 107,  close: 108.5, volume: 2000 },
  ];
  const rTp = simulateTradesV6(rowsGapTp, [{ barIndex: 0, side: 1, atr: 2 }], {
    execProfile: 'EQUITY_ETF',
    warmup: 0,
    stopAtr: 1.0,
    rewardRisk: 1.0,
  });
  assert.equal(rTp.count, 1);
  assert.equal(rTp.trades[0].exitReason, 'TP');
  const expectedTarget = 100 * (1 + 0.00015) + 2;
  near(rTp.trades[0].exit, expectedTarget * (1 - 0.00015));
});

test('simulateTradesV6 maintains full parity with simulateTradesV5 under EXCHANGE_POST_ONLY and STRICT_TAKER', () => {
  const base = 1788220800;
  const rows = Array.from({ length: 12 }, (_, i) => ({
    time: base + i * 3600,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
  }));
  Object.assign(rows[1], { open: 100.5, high: 101.2, low: 99.95, close: 100.8 });
  Object.assign(rows[2], { open: 100.8, high: 102.5, low: 100.7, close: 102.1 });
  const signals = [{ barIndex: 0, side: 1, atr: 2, limitPrice: 100 }];
  const fundingRows = [{ time: base, fundingRate: 0.0002 }];
  const opts = {
    execProfile: 'EXCHANGE_POST_ONLY',
    entryMode: 'LIMIT_PULLBACK',
    warmup: 0,
    stopAtr: 1.0,
    rewardRisk: 1.0,
    fundingRows,
    intervalSeconds: 3600,
  };
  const v5 = simulateTradesV5(rows, signals, opts);
  const v6 = simulateTradesV6(rows, signals, opts);
  assert.equal(v6.count, v5.count);
  near(v6.compoundedNetPct, v5.compoundedNetPct);
  near(v6.trades[0].netPct, v5.trades[0].netPct);
});

test('summarizePerformanceV6 computes CAGR, Sharpe, Sortino, Calmar, buyHoldPct, and buyHoldMaxDdPct', () => {
  // 5 rows spanning exactly 1 year (365.25 days)
  const yearSec = Math.round(365.25 * 86400);
  const rows = [
    { time: START,                         open: 100, high: 100, low: 100, close: 100, volume: 10 },
    { time: START + Math.round(yearSec * 0.25), open: 100, high: 120, low: 100, close: 120, volume: 10 },
    { time: START + Math.round(yearSec * 0.50), open: 120, high: 120, low: 90,  close: 90,  volume: 10 }, // 25% BH DD from 120 -> 90
    { time: START + yearSec,               open: 90,  high: 110, low: 90,  close: 110, volume: 10 },
  ];
  const trades = [
    { signalIndex: 0, entryIndex: 0, exitIndex: 1, grossPct: 10, netPct: 10 },
    { signalIndex: 1, entryIndex: 1, exitIndex: 2, grossPct: -5, netPct: -5 },
    { signalIndex: 2, entryIndex: 2, exitIndex: 3, grossPct: 15, netPct: 15 },
  ];

  const s = summarizePerformanceV6(trades, rows, 0, rows.length, { periodYears: 1.0 });
  assert.equal(s.count, 3);
  near(s.winRatePct, (2 / 3) * 100);
  near(s.profitFactor, 25 / 5);
  near(s.totalNetPct, 20);
  const expectedEq = 1.1 * 0.95 * 1.15; // 1.20175 -> +20.175%
  near(s.compoundedNetPct, (expectedEq - 1) * 100);
  near(s.cagrPct, (expectedEq - 1) * 100); // periodYears = 1.0
  near(s.compoundedMaxDrawdownPct, 5.0);
  near(s.calmar, ((expectedEq - 1) * 100) / 5.0);
  near(s.buyHoldPct, 10.0);
  near(s.buyHoldMaxDdPct, 25.0);
  assert.ok(s.sharpe > 0 && Number.isFinite(s.sharpe));
  assert.ok(s.sortino > s.sharpe);
});

test('simulatePortfolioV6 infers min bar interval on gapped equities and enforces maxTotalOpenLev', () => {
  // Equity stream with Friday -> Monday 3-day gap at index 0 -> 1, then 1-day steps
  const equityRows = [
    { time: START,           open: 100, high: 101, low: 99, close: 100, volume: 10 }, // Fri
    { time: START + 3 * DAY, open: 100, high: 101, low: 99, close: 100, volume: 10 }, // Mon
    { time: START + 4 * DAY, open: 100, high: 101, low: 99, close: 100, volume: 10 }, // Tue
    { time: START + 5 * DAY, open: 100, high: 101, low: 99, close: 100, volume: 10 }, // Wed
  ];
  const cryptoRows = [
    { time: START,           open: 100, high: 101, low: 99, close: 100, volume: 10 },
    { time: START + 1 * DAY, open: 100, high: 101, low: 99, close: 100, volume: 10 },
    { time: START + 2 * DAY, open: 100, high: 101, low: 99, close: 100, volume: 10 },
    { time: START + 3 * DAY, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  ];

  // Equity exits on Fri (index 0 -> exitTime = START + 1*DAY, NOT +3*DAY!), so on Mon (START+3*DAY) it is already closed.
  // Crypto enters at START+1*DAY (after Equity exited!) -> NO overlap!
  const pfNoOverlap = simulatePortfolioV6([
    { id: 'SPY', rows: equityRows, trades: [{ entryIndex: 0, exitIndex: 0, side: 1, lev: 3.0, grossPct: 4, netPct: 4 }] },
    { id: 'BTC', rows: cryptoRows, trades: [{ entryIndex: 1, exitIndex: 2, side: 1, lev: 3.0, grossPct: 4, netPct: 4 }] },
  ], { maxTotalOpenLev: 4.0 });

  assert.equal(pfNoOverlap.scaledByCapCount, 0);
  near(pfNoOverlap.peakOpenLev, 3.0);

  // Overlapping trades cap at maxTotalOpenLev = 4.0
  const pfOverlap = simulatePortfolioV6([
    { id: 'SPY', rows: equityRows, trades: [{ entryIndex: 0, exitIndex: 2, side: 1, lev: 2.5, grossPct: 4, netPct: 4 }] },
    { id: 'BTC', rows: cryptoRows, trades: [{ entryIndex: 1, exitIndex: 2, side: 1, lev: 2.5, grossPct: 10, netPct: 10 }] },
  ], { maxTotalOpenLev: 4.0 });
  assert.equal(pfOverlap.scaledByCapCount, 1);
  near(pfOverlap.peakOpenLev, 4.0);
  near(pfOverlap.trades.find(t => t.streamId === 'BTC').portfolioNetPct, 6.0);
});

test('fetch_5y_crypto_and_stocks parsers clean Yahoo null/NaN bars and align HTF causally', () => {
  const k = parseBinanceFuturesKline([
    1637366400000, '58000', '58500', '57900', '58200', '1000',
    1637369999999, '58000000', 1200, '550', '32000000', '0',
  ]);
  assert.equal(k.time, 1637366400);
  assert.equal(k.takerBuyVol, 550);
  assert.equal(k.trades, 1200);

  const yahooCleaned = cleanYahooChartSeries({
    chart: {
      result: [{
        timestamp: [1700000000, 1700086400, 1700172800],
        indicators: {
          quote: [{
            open: [100, null, 102],
            high: [101, null, 103],
            low: [99, null, 101],
            close: [100.5, null, 102.5],
            volume: [100, null, 200],
          }],
        },
      }],
    },
  });
  assert.equal(yahooCleaned.length, 2);
  assert.deepEqual(yahooCleaned.map(r => r.time), [1700000000, 1700172800]);

  const ltf = [{ time: 1637366400 }, { time: 1637370000 }, { time: 1637380800 }];
  const htf = [{ time: 1637352000 }, { time: 1637366400 }]; // 4h bars: [0] closes at 1637366400, [1] closes at 1637380800
  assert.deepEqual(alignHtfCausal(ltf, htf, 14400), [0, 0, 1]);
});
