import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CRYPTO_REGIMES_V8,
  EQUITY_REGIMES_V8,
  precomputeCryptoBreadthV8,
  precomputeAssetRegimeV8,
  precomputeEquityRegimeV8,
} from './regime_engine_v8.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

function loadJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8'));
}

function truncateDataset(ds, cutBarCount) {
  const rows = ds.rows.slice(0, cutBarCount);
  const lastTime = rows[rows.length - 1].time;
  const htf = {};
  for (const [tf, h] of Object.entries(ds.htf || {})) {
    const tfRows = h.rows.filter(r => r.time + h.intervalSeconds <= lastTime);
    htf[tf] = { ...h, rows: tfRows };
  }
  const fundingRows = (ds.fundingRows || []).filter(f => f.time <= lastTime);
  return { ...ds, rows, htf, fundingRows };
}

function mutateFutureDataset(ds, cutBarCount) {
  const lastTime = ds.rows[cutBarCount - 1].time;
  const rows = ds.rows.map((r, i) => (
    i >= cutBarCount
      ? { ...r, open: r.open * 10, high: r.high * 12, low: r.low * 0.1, close: r.close * 11, volume: 0 }
      : r
  ));
  const htf = {};
  for (const [tf, h] of Object.entries(ds.htf || {})) {
    const tfRows = h.rows.map(r => (
      r.time + h.intervalSeconds > lastTime
        ? { ...r, open: r.open * 10, high: r.high * 12, low: r.low * 0.1, close: r.close * 11 }
        : r
    ));
    htf[tf] = { ...h, rows: tfRows };
  }
  const fundingRows = (ds.fundingRows || []).map(f => (
    f.time > lastTime ? { ...f, fundingRate: -0.05 } : f
  ));
  return { ...ds, rows, htf, fundingRows };
}

test('strict prefix-truncation and future-mutation causality across 1h, 15m, breadth, and 1d equities', () => {
  const btc1h = loadJson('crypto5y_btcusdt_1h.json');
  const eth1h = loadJson('crypto5y_ethusdt_1h.json');
  const sol1h = loadJson('crypto5y_solusdt_1h.json');
  const bnb1h = loadJson('crypto5y_bnbusdt_1h.json');
  const btc15m = loadJson('crypto5y_btcusdt_15m.json');
  const spy1d = loadJson('equities10y_sp500_1d.json');
  const macro1d = loadJson('equities10y_macro_1d.json');

  // 1) Crypto 1h + 4-coin breadth
  const cut1h = 22000;
  const fullBreadth = precomputeCryptoBreadthV8({ BTCUSDT: btc1h, ETHUSDT: eth1h, SOLUSDT: sol1h, BNBUSDT: bnb1h });
  const full1h = precomputeAssetRegimeV8(btc1h, fullBreadth);

  const truncBreadth = precomputeCryptoBreadthV8({
    BTCUSDT: truncateDataset(btc1h, cut1h),
    ETHUSDT: truncateDataset(eth1h, cut1h),
    SOLUSDT: truncateDataset(sol1h, cut1h),
    BNBUSDT: truncateDataset(bnb1h, cut1h),
  });
  const trunc1h = precomputeAssetRegimeV8(truncateDataset(btc1h, cut1h), truncBreadth);

  const mutBreadth = precomputeCryptoBreadthV8({
    BTCUSDT: mutateFutureDataset(btc1h, cut1h),
    ETHUSDT: mutateFutureDataset(eth1h, cut1h),
    SOLUSDT: mutateFutureDataset(sol1h, cut1h),
    BNBUSDT: mutateFutureDataset(bnb1h, cut1h),
  });
  const mut1h = precomputeAssetRegimeV8(mutateFutureDataset(btc1h, cut1h), mutBreadth);

  for (let i = 0; i < cut1h; i++) {
    assert.equal(trunc1h.regime[i], full1h.regime[i], `1h trunc regime mismatch at ${i}`);
    assert.equal(mut1h.regime[i], full1h.regime[i], `1h mut regime mismatch at ${i}`);
    assert.equal(trunc1h.h4RallyExh[i], full1h.h4RallyExh[i], `1h h4RallyExh mismatch at ${i}`);
    assert.ok(Math.abs(trunc1h.trendScore[i] - full1h.trendScore[i]) <= 1e-12);
    assert.ok(Math.abs(mut1h.breadthBearRatio[i] - full1h.breadthBearRatio[i]) <= 1e-12);
  }

  // 2) Crypto 15m causality
  const cut15m = 88000;
  const full15m = precomputeAssetRegimeV8(btc15m, fullBreadth);
  const trunc15m = precomputeAssetRegimeV8(truncateDataset(btc15m, cut15m), truncBreadth);
  const mut15m = precomputeAssetRegimeV8(mutateFutureDataset(btc15m, cut15m), mutBreadth);

  for (let i = 0; i < cut15m; i += 17) {
    assert.equal(trunc15m.regime[i], full15m.regime[i], `15m trunc regime mismatch at ${i}`);
    assert.equal(mut15m.regime[i], full15m.regime[i], `15m mut regime mismatch at ${i}`);
    assert.ok(Math.abs(trunc15m.trendScore[i] - full15m.trendScore[i]) <= 1e-12);
  }

  // 3) Equities 1d causality
  const cutEq = 1500;
  const cutEqTime = spy1d.rows[cutEq - 1].time;
  const fullEq = precomputeEquityRegimeV8(spy1d, macro1d);
  const truncSpy = { ...spy1d, rows: spy1d.rows.slice(0, cutEq) };
  const truncMacro = {
    vixRows: macro1d.vixRows.filter(r => r.time <= cutEqTime),
    tnxRows: macro1d.tnxRows.filter(r => r.time <= cutEqTime),
  };
  const truncEq = precomputeEquityRegimeV8(truncSpy, truncMacro);

  const mutSpy = {
    ...spy1d,
    rows: spy1d.rows.map((r, i) => (i >= cutEq ? { ...r, close: r.close * 10 } : r)),
  };
  const mutMacro = {
    vixRows: macro1d.vixRows.map(r => (r.time > cutEqTime ? { ...r, close: 99 } : r)),
    tnxRows: macro1d.tnxRows.map(r => (r.time > cutEqTime ? { ...r, close: 15 } : r)),
  };
  const mutEq = precomputeEquityRegimeV8(mutSpy, mutMacro);

  for (let i = 0; i < cutEq; i++) {
    assert.equal(truncEq.regime[i], fullEq.regime[i], `Eq trunc mismatch at ${i}`);
    assert.equal(mutEq.regime[i], fullEq.regime[i], `Eq mut mismatch at ${i}`);
    assert.ok(Math.abs(truncEq.trendScore[i] - fullEq.trendScore[i]) <= 1e-12);
  }
});

test('2022 Bear and Y5 Bear classify predominantly as Bear regimes while 2023-24 Bull classifies predominantly Bull', () => {
  const btc1h = loadJson('crypto5y_btcusdt_1h.json');
  const eth1h = loadJson('crypto5y_ethusdt_1h.json');
  const sol1h = loadJson('crypto5y_solusdt_1h.json');
  const bnb1h = loadJson('crypto5y_bnbusdt_1h.json');
  const breadth = precomputeCryptoBreadthV8({ BTCUSDT: btc1h, ETHUSDT: eth1h, SOLUSDT: sol1h, BNBUSDT: bnb1h });
  const reg = precomputeAssetRegimeV8(btc1h, breadth);

  function statsInRange(startIso, endIso) {
    const t0 = Date.parse(startIso) / 1000;
    const t1 = Date.parse(endIso) / 1000;
    const counts = { BULL_TREND: 0, BEAR_TREND: 0, BEAR_SQUEEZE: 0, RANGE_CHOP: 0, total: 0 };
    for (let i = 0; i < btc1h.rows.length; i++) {
      const t = btc1h.rows[i].time;
      if (t >= t0 && t < t1) {
        counts[reg.regime[i]]++;
        counts.total++;
      }
    }
    return counts;
  }

  const bear2022 = statsInRange('2022-05-01T00:00:00Z', '2022-12-31T23:59:59Z');
  const bull2024 = statsInRange('2023-10-15T00:00:00Z', '2024-04-15T00:00:00Z');
  const bearY5 = statsInRange('2025-11-25T00:00:00Z', '2026-11-25T00:00:00Z');

  const bear2022Share = (bear2022.BEAR_TREND + bear2022.BEAR_SQUEEZE) / bear2022.total;
  const bull2024Share = bull2024.BULL_TREND / bull2024.total;
  const bearY5Share = (bearY5.BEAR_TREND + bearY5.BEAR_SQUEEZE) / bearY5.total;

  assert.ok(bear2022Share > 0.70, `Expected 2022 bear share > 70%, got ${(bear2022Share * 100).toFixed(2)}%`);
  assert.ok(bull2024Share > 0.65, `Expected 2023-24 bull share > 65%, got ${(bull2024Share * 100).toFixed(2)}%`);
  assert.ok(bearY5Share > 0.55, `Expected Y5 bear share > 55%, got ${(bearY5Share * 100).toFixed(2)}%`);

  // Verify getRegimeAt schema & BEAR_SQUEEZE blocks chasing shorts
  let foundSqueeze = false;
  for (let i = 0; i < reg.length; i++) {
    if (reg.regime[i] === CRYPTO_REGIMES_V8.BEAR_SQUEEZE) {
      const snap = reg.getRegimeAt(i);
      assert.equal(snap.shortSizeMult, 0);
      assert.equal(snap.shortPriority, 0);
      foundSqueeze = true;
      break;
    }
  }
  assert.ok(foundSqueeze, 'Expected at least one BEAR_SQUEEZE bar in 5Y BTC history');

  // Verify equity regime recognizes 2020 COVID crash or 2022 bear market as BEAR_TREND / HIGH_VOL_CHOP
  const spy1d = loadJson('equities10y_sp500_1d.json');
  const macro1d = loadJson('equities10y_macro_1d.json');
  const eqReg = precomputeEquityRegimeV8(spy1d, macro1d);
  const eq2022 = [];
  for (let i = 0; i < spy1d.rows.length; i++) {
    const d = spy1d.rows[i].date;
    if (d >= '2022-05-01' && d <= '2022-10-31') eq2022.push(eqReg.regime[i]);
  }
  const eqBearOrChop = eq2022.filter(r => r === EQUITY_REGIMES_V8.BEAR_TREND || r === EQUITY_REGIMES_V8.HIGH_VOL_CHOP).length;
  assert.ok(eqBearOrChop / eq2022.length > 0.70, 'Expected SPY 2022 bear window predominantly BEAR_TREND/HIGH_VOL_CHOP');
});
