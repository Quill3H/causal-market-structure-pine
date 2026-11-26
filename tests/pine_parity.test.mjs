import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPineSource, checkPineFiles } from './pine_static_check.mjs';
import {
  simulatePineV6Engine,
  verifyPineSourcesMatchSpec,
  verifyDatasetParity,
  runAllPineParityChecks,
} from './pine_parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('pine_static_check passes on TOOL.pine and TOOL_Strategy.pine', () => {
  const res = checkPineFiles([
    path.join(ROOT, 'TOOL.pine'),
    path.join(ROOT, 'TOOL_Strategy.pine'),
  ]);
  assert.equal(res.pass, true, JSON.stringify(res, null, 2));
  for (const r of res.reports) {
    assert.ok(r.corePlotCalls <= 55, `${r.file} plot count ${r.corePlotCalls} > 55`);
    assert.equal(r.historyLimit, 4500);
  }
});

test('pine_static_check rejects legacy v2.0.0 symbol lock and non-top-level ta.* calls', () => {
  const legacyCheck = checkPineFiles([path.join(ROOT, 'legacy', 'TOOL-2.0.0-ref.pine')]);
  assert.equal(legacyCheck.pass, false);
  const joined = legacyCheck.reports[0].errors.join('\n');
  assert.match(joined, /ticker\.standard|BINANCE:BTCUSDT/);
  assert.match(joined, /top-level scope/);
});

test('pine_static_check enforces lookahead_off, plot budget, and unconditional ta.* scope', () => {
  const badLookahead = `
//@version=6
indicator("Bad", overlay=true, max_boxes_count=500, max_lines_count=500, max_labels_count=500)
const int HISTORY_LIMIT = 4500
x = request.security(syminfo.tickerid, "60", close, lookahead=barmerge.lookahead_on)
if barstate.isconfirmed
    y = ta.atr(14)
plot(x)
`;
  const report = checkPineSource(badLookahead, 'bad.pine');
  assert.equal(report.pass, false);
  const msg = report.errors.join('\n');
  assert.match(msg, /lookahead_on/);
  assert.match(msg, /missing explicit lookahead = barmerge\.lookahead_off/);
  assert.match(msg, /ta\.atr\(\) inside if block/);
});

test('TOOL.pine and TOOL_Strategy.pine share exact constants and helper equations', () => {
  const staticCheck = verifyPineSourcesMatchSpec();
  assert.equal(staticCheck.pass, true);
});

test('100% bar-by-bar & trade-by-trade parity on BTCUSDT 15m (12m + TV 6k) and ETHUSDT 15m (v4.0 Option 1)', () => {
  const r12m = verifyDatasetParity('data/btcusdt_15m_12m.json');
  assert.equal(r12m.trades, 150);
  assert.ok(r12m.profitFactor >= 1.0);

  const rTv6k = verifyDatasetParity('data/btcusdt_tv_15m_6k.json');
  assert.equal(rTv6k.trades, 21);
  assert.ok(rTv6k.winRatePct >= 80.0);
  assert.ok(rTv6k.profitFactor >= 2.50);

  const rEth = verifyDatasetParity('data/ethusdt_15m_6m.json');
  assert.equal(rEth.trades, 71);
  assert.ok(rEth.winRatePct >= 67.0);
  assert.ok(rEth.profitFactor >= 1.19);
});

test('100% bar-by-bar & trade-by-trade parity on BTCUSDT 1h (24m + TV 6k) and ETHUSDT 1h', () => {
  const r24m = verifyDatasetParity('data/btcusdt_1h_24m.json');
  assert.equal(r24m.trades, 179);
  assert.ok(r24m.winRatePct >= 78.0);

  const rTv6k = verifyDatasetParity('data/btcusdt_tv_1h_6k.json');
  assert.equal(rTv6k.trades, 68);
  assert.ok(rTv6k.winRatePct >= 75.0);
  assert.ok(rTv6k.profitFactor >= 1.20);

  const rEth = verifyDatasetParity('data/ethusdt_1h_12m.json');
  assert.equal(rEth.trades, 81);
  assert.ok(rEth.winRatePct >= 69.0);
});

test('100% parity on local OKX TV-6k and Swap 3y datasets when present', () => {
  if (fs.existsSync(path.join(ROOT, 'data/okx_btcusdt_tv_15m_6k.json'))) {
    const okxSp15 = verifyDatasetParity('data/okx_btcusdt_tv_15m_6k.json');
    assert.equal(okxSp15.trades, 23);
    assert.ok(okxSp15.winRatePct >= 73.0);
  }
  if (fs.existsSync(path.join(ROOT, 'data/okx_btcusdt_swap_tv_15m_6k.json'))) {
    const okxSw15 = verifyDatasetParity('data/okx_btcusdt_swap_tv_15m_6k.json');
    assert.equal(okxSw15.trades, 21);
    assert.ok(okxSw15.winRatePct >= 76.0);
  }
  if (fs.existsSync(path.join(ROOT, 'data/okx_btcusdt_swap_1h_3y.json'))) {
    const okxSw1h = verifyDatasetParity('data/okx_btcusdt_swap_1h_3y.json');
    assert.equal(okxSw1h.trades, 252);
    assert.ok(okxSw1h.winRatePct >= 74.0);
  }
});

test('100% parity on selectable alternative engine profiles (15m v3.0 legacy & 1h v4.0 trend)', () => {
  const r15Legacy = verifyDatasetParity('data/btcusdt_tv_15m_6k.json', {
    engine15mProfile: 'v3.0 H1-Clean-Disp [Legacy]',
  });
  assert.equal(r15Legacy.trades, 45);
  assert.ok(r15Legacy.winRatePct >= 65.0);
  assert.ok(r15Legacy.profitFactor >= 1.20);

  const r1hTrend = verifyDatasetParity('data/btcusdt_tv_1h_6k.json', {
    engine1hProfile: 'v4.0 H4-Disp Trend [High-Return 1x]',
  });
  assert.equal(r1hTrend.parity, '100%_BAR_AND_TRADE_MATCH');
  assert.equal(r1hTrend.trades, 73);
});

test('100% parity on v4.1 VolNorm Auto sizing (1h 4.5% [1.5..2.8x] & 15m 2.2% [0.75..1.5x])', () => {
  const r15Auto = verifyDatasetParity('data/btcusdt_tv_15m_6k.json', {
    paperSizingMode: 'VolNorm [v4.1 Auto]',
  });
  assert.equal(r15Auto.parity, '100%_BAR_AND_TRADE_MATCH');
  assert.equal(r15Auto.trades, 21);

  const r1hAuto = verifyDatasetParity('data/btcusdt_tv_1h_6k.json', {
    paperSizingMode: 'VolNorm [v4.1 Auto]',
  });
  assert.equal(r1hAuto.parity, '100%_BAR_AND_TRADE_MATCH');
  assert.equal(r1hAuto.trades, 68);
  assert.ok(r1hAuto.compoundedNetLevPct > r1hAuto.totalNetPct);

  const r1hFixed = verifyDatasetParity('data/btcusdt_tv_1h_6k.json', {
    paperSizingMode: 'Fixed Leverage',
    paperLeverageRef: 2.0,
  });
  assert.equal(r1hFixed.parity, '100%_BAR_AND_TRADE_MATCH');
  assert.ok(Math.abs(r1hFixed.totalNetLevPct - 2.0 * r1hFixed.totalNetPct) < 2e-4);
});

test('100% parity on v4.1 VolNorm + Partial TP1 (50% @ 0.95R, Lock 0.65R) on 1h & 15m', () => {
  const r1hPartial = verifyDatasetParity('data/btcusdt_tv_1h_6k.json', {
    paperUseAutoPreset: false,
    customRewardRisk: 2.0,
    paperSizingMode: 'VolNorm [v4.1 Auto]',
    paperTp1QtyPct: 50,
    paperTp1TriggerR: 0.95,
    paperTp1LockR: 0.65,
  });
  assert.equal(r1hPartial.parity, '100%_BAR_AND_TRADE_MATCH');
  assert.ok(r1hPartial.trades >= 60);

  const r15Partial = verifyDatasetParity('data/btcusdt_tv_15m_6k.json', {
    paperSizingMode: 'VolNorm [v4.1 Auto]',
    paperTp1QtyPct: 50,
    paperTp1TriggerR: 0.95,
    paperTp1LockR: 0.65,
  });
  assert.equal(r15Partial.parity, '100%_BAR_AND_TRADE_MATCH');
  assert.equal(r15Partial.trades, 21);

  // Confirm TP1 events actively trigger under Partial TP1 simulation
  const ds1h = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/btcusdt_tv_1h_6k.json'), 'utf8'));
  const sim1h = simulatePineV6Engine(ds1h, {
    paperUseAutoPreset: false,
    customRewardRisk: 2.0,
    paperSizingMode: 'VolNorm [v4.1 Auto]',
    paperTp1QtyPct: 50,
    paperTp1TriggerR: 0.95,
    paperTp1LockR: 0.65,
  });
  assert.ok(sim1h.trades.some(t => t.tp1Hit === true));
});

test('Pine v6 prefix-truncation causality matches sim_engine on TV-6k windows', () => {
  for (const rel of ['data/btcusdt_tv_15m_6k.json', 'data/btcusdt_tv_1h_6k.json']) {
    const full = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const fullRun = simulatePineV6Engine(full);
    const T = 3500;
    const lastOpen = full.rows[T - 1].time;
    const truncHtf = {};
    for (const [k, h] of Object.entries(full.htf)) {
      truncHtf[k] = {
        ...h,
        rows: h.rows.filter(r => r.time + h.intervalSeconds <= lastOpen),
        alignedIndex: h.alignedIndex.slice(0, T),
      };
    }
    const prefix = { ...full, rows: full.rows.slice(0, T), htf: truncHtf };
    const preRun = simulatePineV6Engine(prefix);
    assert.deepEqual(preRun.signals, fullRun.signals.filter(s => s.barIndex < T));
    assert.deepEqual(preRun.trades, fullRun.trades.filter(t => t.exitIndex < T));
  }
});

test('runAllPineParityChecks returns full PASS summary', () => {
  const all = runAllPineParityChecks();
  assert.equal(all.status, 'PASS');
  assert.equal(all.results.length, 6);
});
