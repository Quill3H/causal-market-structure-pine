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

test('100% bar-by-bar & trade-by-trade parity on BTCUSDT 15m (12m + TV 6k) and ETHUSDT 15m', () => {
  const r12m = verifyDatasetParity('data/btcusdt_15m_12m.json');
  assert.equal(r12m.trades, 293);
  assert.ok(r12m.winRatePct >= 74.0);

  const rTv6k = verifyDatasetParity('data/btcusdt_tv_15m_6k.json');
  assert.equal(rTv6k.trades, 45);
  assert.ok(rTv6k.winRatePct >= 65.0);
  assert.ok(rTv6k.profitFactor >= 1.20);

  const rEth = verifyDatasetParity('data/ethusdt_15m_6m.json');
  assert.equal(rEth.trades, 149);
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
