import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  V9_STREAM_KEYS,
  applyCausalDdGuardV9,
  applyV9ModelToSignals,
  buildCausalBreadthV9,
  generateStreamSignalsV9,
  loadStreamDatasetV9,
  sliceByMaxTimeV9,
  verifyModelsLockV9,
} from '../research/ensemble_v9_walkforward.mjs';
import { alignFundingToBarsCausal } from '../research/fetch_okx_derivs.mjs';
import { scoreCandidateV5 } from '../research/ml_inference.mjs';
import { precomputeAssetRegimeV8, precomputeCryptoBreadthV8 } from '../research/regime_engine_v8.mjs';
import { simulateTradesV7 } from '../research/sim_engine_v7.mjs';
import { buildAllVersionsMatrix } from '../research/version_matrix_preview.mjs';
import { assertLoopbackHost, loadConfig } from '../standalone/config.mjs';
import { loadRuntimeSpecs } from '../standalone/engine_runtime.mjs';
import { OkxClient } from '../standalone/exchange_okx.mjs';
import {
  OKX_CLORDID_REGEX,
  ROUTER_MODES,
  StandaloneOrderRouter,
  isValidOkxClOrdId,
} from '../standalone/order_router.mjs';
import { createStandaloneServer } from '../standalone/server.mjs';
import { StandaloneStore } from '../standalone/store_sqlite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const RESULTS_V6 = path.join(REPO_ROOT, 'research', 'results_v6');
const RESULTS_V7 = path.join(REPO_ROOT, 'research', 'results_v7');
const RESULTS_V8 = path.join(REPO_ROOT, 'research', 'results_v8');
const RESULTS_V9 = path.join(REPO_ROOT, 'research', 'results_v9');

const jsonCache = new Map();
function readJsonCached(filePath) {
  if (!jsonCache.has(filePath)) {
    jsonCache.set(filePath, JSON.parse(fs.readFileSync(filePath, 'utf8')));
  }
  return jsonCache.get(filePath);
}

function makeTmpDir(prefix = 'verify-v9-') {
  return fs.mkdtempSync(path.join(REPO_ROOT, 'data', prefix));
}

function mutateFutureCryptoAtTime(ds, cutoffTimeSec) {
  const rows = ds.rows.map(r => {
    if (r.time <= cutoffTimeSec) return r;
    const mult = r.time % 7200 === 0 ? 3.1 : 0.25;
    const vol = (r.volume || 100) * 16;
    return {
      ...r,
      open: r.open * mult,
      high: r.high * mult * 1.35,
      low: r.low * mult * 0.65,
      close: r.close * mult,
      volume: vol,
      takerBuyVol: Number.isFinite(r.takerBuyVol) ? (r.time % 7200 === 0 ? vol * 0.99 : vol * 0.01) : r.takerBuyVol,
    };
  });
  const tfSecMap = { '1h': 3600, '4h': 14400, '1d': 86400 };
  const htf = {};
  for (const tf of Object.keys(ds.htf || {})) {
    const h = ds.htf[tf];
    const tfSec = h.intervalSeconds ?? tfSecMap[tf] ?? 3600;
    htf[tf] = {
      ...h,
      rows: h.rows.map(hr => (
        hr.time + tfSec > cutoffTimeSec
          ? { ...hr, open: hr.open * 2.8, high: hr.high * 3.3, low: hr.low * 0.3, close: hr.close * 2.7 }
          : hr
      )),
    };
  }
  const fundingRows = Array.isArray(ds.fundingRows)
    ? ds.fundingRows.map(f => (f.time > cutoffTimeSec ? { ...f, fundingRate: -0.08 } : f))
    : undefined;
  return { ...ds, rows, htf, ...(fundingRows ? { fundingRows } : {}) };
}

function assertSignalArraysMatch(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: signal count mismatch (${actual.length} vs ${expected.length})`);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i];
    const e = expected[i];
    assert.equal(a.barIndex, e.barIndex, `${label}[${i}] barIndex`);
    assert.equal(a.side, e.side, `${label}[${i}] side`);
    assert.ok(Math.abs(a.atr - e.atr) < 1e-12, `${label}[${i}] atr diff`);
    if (e.limitPrice !== undefined) {
      assert.ok(Math.abs(a.limitPrice - e.limitPrice) < 1e-12, `${label}[${i}] limitPrice diff`);
    }
    if (e.meta?.probWin !== undefined && a.meta?.probWin !== undefined) {
      assert.ok(Math.abs(a.meta.probWin - e.meta.probWin) < 1e-12, `${label}[${i}] probWin diff`);
    }
    if (e.sizeMult !== undefined && a.sizeMult !== undefined) {
      assert.ok(Math.abs(a.sizeMult - e.sizeMult) < 1e-12, `${label}[${i}] sizeMult diff`);
    }
  }
}

describe('1. v9.0 Prefix-Truncation, Future-Mutation Causality & Causal DD Guard', () => {
  it('all 8 v9 streams are 100% causal under prefix truncation & future mutation', () => {
    const modelsJson = readJsonCached(path.join(RESULTS_V9, 'models_v9_crypto.json'));
    const btc1h = loadStreamDatasetV9('BTC_1h');
    const eth1h = loadStreamDatasetV9('ETH_1h');
    const sol1h = loadStreamDatasetV9('SOL_1h');
    const bnb1h = loadStreamDatasetV9('BNB_1h');
    const btc15 = loadStreamDatasetV9('BTC_15m');

    const cutoffTime = btc1h.rows[28000 - 1].time;

    const breadthFull = buildCausalBreadthV9(null);
    const breadthPrefix = buildCausalBreadthV9(cutoffTime);
    const breadthMut = precomputeCryptoBreadthV8({
      BTCUSDT: mutateFutureCryptoAtTime(btc1h, cutoffTime),
      ETHUSDT: mutateFutureCryptoAtTime(eth1h, cutoffTime),
      SOLUSDT: mutateFutureCryptoAtTime(sol1h, cutoffTime),
      BNBUSDT: mutateFutureCryptoAtTime(bnb1h, cutoffTime),
    });

    const btc1hPrefix = sliceByMaxTimeV9(btc1h, cutoffTime);
    const btc1hMut = mutateFutureCryptoAtTime(btc1h, cutoffTime);
    const btc15Prefix = sliceByMaxTimeV9(btc15, cutoffTime);
    const btc15Mut = mutateFutureCryptoAtTime(btc15, cutoffTime);

    for (const sk of V9_STREAM_KEYS) {
      const mSpec = modelsJson.models[sk];
      const dsFull = loadStreamDatasetV9(sk);
      const dsPrefix = sliceByMaxTimeV9(dsFull, cutoffTime);
      const dsMut = mutateFutureCryptoAtTime(dsFull, cutoffTime);
      const cutLen = dsPrefix.rows.length;

      const regF = precomputeAssetRegimeV8(dsFull, breadthFull);
      const regP = precomputeAssetRegimeV8(dsPrefix, breadthPrefix);
      const regM = precomputeAssetRegimeV8(dsMut, breadthMut);

      const fundF = alignFundingToBarsCausal(dsFull.rows, dsFull.fundingRows ?? []);
      const fundP = alignFundingToBarsCausal(dsPrefix.rows, dsPrefix.fundingRows ?? []);
      const fundM = alignFundingToBarsCausal(dsMut.rows, dsMut.fundingRows ?? []);

      const isEth = sk.startsWith('ETH');
      const is15m = sk.endsWith('_15m');
      const btcF = isEth ? (is15m ? btc15 : btc1h) : null;
      const btcP = isEth ? (is15m ? btc15Prefix : btc1hPrefix) : null;
      const btcM = isEth ? (is15m ? btc15Mut : btc1hMut) : null;

      const sigF = generateStreamSignalsV9(sk, dsFull, mSpec.structuralSpec.sigSpec, fundF, regF, btcF)
        .filter(s => s.barIndex < cutLen);
      const sigP = generateStreamSignalsV9(sk, dsPrefix, mSpec.structuralSpec.sigSpec, fundP, regP, btcP);
      const sigM = generateStreamSignalsV9(sk, dsMut, mSpec.structuralSpec.sigSpec, fundM, regM, btcM)
        .filter(s => s.barIndex < cutLen);

      assert.ok(sigF.length >= 40, `${sk} expected >= 40 signals before cutoff`);
      assertSignalArraysMatch(sigP, sigF, `${sk} prefix signals`);
      assertSignalArraysMatch(sigM, sigF, `${sk} mut signals`);

      const mlF = applyV9ModelToSignals(sk, dsFull, sigF, fundF, regF, mSpec, dsFull.rows[dsFull.rows.length - 1].time);
      const mlP = applyV9ModelToSignals(sk, dsPrefix, sigP, fundP, regP, mSpec, cutoffTime);
      const mlM = applyV9ModelToSignals(sk, dsMut, sigM, fundM, regM, mSpec, dsMut.rows[dsMut.rows.length - 1].time);

      assert.ok(mlF.length >= 25, `${sk} expected >= 25 ML signals before cutoff`);
      assertSignalArraysMatch(mlP, mlF, `${sk} ML prefix`);
      assertSignalArraysMatch(mlM, mlF, `${sk} ML mut`);

      const simOpts = {
        ...mSpec.structuralSpec.execOptions,
        execProfile: 'EXCHANGE_POST_ONLY',
        fundingPctPer8h: 0.01,
        isolatedLiqCheck: true,
        intervalSeconds: dsFull.intervalSeconds,
      };
      const trF = simulateTradesV7(dsFull.rows, mlF, { ...simOpts, fundingRows: dsFull.fundingRows })
        .trades.filter(t => t.exitIndex < cutLen - 1);
      const trP = simulateTradesV7(dsPrefix.rows, mlP, { ...simOpts, fundingRows: dsPrefix.fundingRows })
        .trades.filter(t => t.exitIndex < cutLen - 1);
      const trM = simulateTradesV7(dsMut.rows, mlM, { ...simOpts, fundingRows: dsMut.fundingRows })
        .trades.filter(t => t.exitIndex < cutLen - 1);

      assert.equal(trP.length, trF.length, `${sk} closed trades prefix len`);
      assert.equal(trM.length, trF.length, `${sk} closed trades mut len`);
      for (let i = 0; i < trF.length; i++) {
        assert.equal(trP[i].exitReason, trF[i].exitReason);
        assert.ok(Math.abs(trP[i].netPct - trF[i].netPct) < 1e-12);
        assert.ok(Math.abs(trM[i].netPct - trF[i].netPct) < 1e-12);
      }
    }
  });

  it('applyCausalDdGuardV9 triggers 0.70x throttle only from closed DD > 15% until < 8% and never leaks future trades', () => {
    const base = 1700000000;
    const rows = Array.from({ length: 10 }, (_, idx) => ({ time: base + idx * 3600 }));
    const tradesBase = [
      // Trade 0: loses -18% (exits at bar 2 = base + 10800 -> closed DD = 18% > 15%)
      { entryIndex: 0, exitIndex: 1, lev: 2.0, netPct: -18.0, grossPct: -17.8, fundingDragPct: 0.2 },
      // Trade 1: enters at bar 3 (after trade 0 closed!) -> MUST be throttled 0.70x! Wins +14% unscaled (+9.8% scaled -> recovers eq from 0.82 to 0.90036 -> DD 9.96% > 8%)
      { entryIndex: 3, exitIndex: 4, lev: 2.0, netPct: 14.0, grossPct: 14.2, fundingDragPct: 0.2 },
      // Trade 2: enters at bar 5 -> DD is 9.96% (still >= 8%) -> MUST stay throttled 0.70x! Wins +10% -> recovers above 0.92 (DD < 8%)
      { entryIndex: 5, exitIndex: 6, lev: 2.0, netPct: 10.0, grossPct: 10.2, fundingDragPct: 0.2 },
      // Trade 3: enters at bar 7 -> DD < 8% -> guard MUST release back to 1.0x
      { entryIndex: 7, exitIndex: 8, lev: 2.0, netPct: 5.0, grossPct: 5.2, fundingDragPct: 0.2 },
    ];
    const futureBadTrade = { entryIndex: 8, exitIndex: 9, lev: 2.0, netPct: -40.0, grossPct: -39.8, fundingDragPct: 0.2 };

    const resPrefix = applyCausalDdGuardV9([{ id: 'S1', rows, intervalSeconds: 3600, trades: tradesBase }], { levScale: 1.0, maxTotalOpenLev: 8.0 });
    const resWithFuture = applyCausalDdGuardV9([{ id: 'S1', rows, intervalSeconds: 3600, trades: [...tradesBase, futureBadTrade] }], { levScale: 1.0, maxTotalOpenLev: 8.0 });

    const tP = resPrefix.streams[0].trades;
    const tF = resWithFuture.streams[0].trades;
    assert.equal(tP[0].ddGuardMult, 1.0);
    assert.equal(tP[1].ddGuardMult, 0.7);
    assert.equal(tP[2].ddGuardMult, 0.7);
    assert.equal(tP[3].ddGuardMult, 1.0);
    for (let i = 0; i < 4; i++) {
      assert.equal(tF[i].ddGuardMult, tP[i].ddGuardMult);
      assert.ok(Math.abs(tF[i].netPct - tP[i].netPct) < 1e-12);
    }
  });
});

describe('2. Zero Y5 Holdout Leakage, SHA-256 Lock & < 1e-12 Python sklearn vs JS Parity (All 8 v9 Models)', () => {
  it('verifies SHA-256 selection lock and strict Walk-Forward Cal/Val/Holdout index isolation', () => {
    const modelsJson = readJsonCached(path.join(RESULTS_V9, 'models_v9_crypto.json'));
    const sha = verifyModelsLockV9(modelsJson);
    assert.equal(sha, modelsJson.selectionLockSha256);

    for (const sk of V9_STREAM_KEYS) {
      const m = modelsJson.models[sk].selectionMeta;
      if (sk.endsWith('_15m')) {
        assert.deepEqual(m.f1Range, [0, 35161], `${sk} f1Range`);
        assert.deepEqual(m.f2Range, [35161, 87904], `${sk} f2Range`);
        assert.deepEqual(m.f3Range, [87904, 140646], `${sk} f3Range`);
        assert.deepEqual(m.holdoutRangeUntouched, [140646, 175808], `${sk} holdoutRangeUntouched`);
      } else {
        assert.deepEqual(m.f1Range, [0, 8790], `${sk} f1Range`);
        assert.deepEqual(m.f2Range, [8790, 21976], `${sk} f2Range`);
        assert.deepEqual(m.f3Range, [21976, 35161], `${sk} f3Range`);
        assert.deepEqual(m.holdoutRangeUntouched, [35161, 43952], `${sk} holdoutRangeUntouched`);
      }
      assert.ok(m.f3Range[1] <= m.holdoutRangeUntouched[0]);
    }
  });

  it('achieves < 1e-12 predict_proba & pass parity between Python sklearn and JS across ALL 8 v9 models', async () => {
    const modelsJson = readJsonCached(path.join(RESULTS_V9, 'models_v9_crypto.json'));
    const breadth = buildCausalBreadthV9(null);
    const btc1h = loadStreamDatasetV9('BTC_1h');
    const btc15 = loadStreamDatasetV9('BTC_15m');

    const { precomputeFeatureContextV9, extractCandidateFeaturesV9 } = await import('../research/ensemble_v9_walkforward.mjs');
    const tasks = [];

    for (const sk of V9_STREAM_KEYS) {
      const mSpec = modelsJson.models[sk];
      const ds = loadStreamDatasetV9(sk);
      const reg = precomputeAssetRegimeV8(ds, breadth);
      const fund = alignFundingToBarsCausal(ds.rows, ds.fundingRows ?? []);
      const btcDs = sk.startsWith('ETH') ? (sk.endsWith('_15m') ? btc15 : btc1h) : null;
      const sigs = generateStreamSignalsV9(sk, ds, mSpec.structuralSpec.sigSpec, fund, reg, btcDs);
      assert.ok(sigs.length >= 50, `${sk} expected >= 50 real candidates (got ${sigs.length})`);

      const fCtx = precomputeFeatureContextV9(sk, ds, fund, reg, ds.rows[ds.rows.length - 1].time);
      const rows = sigs.slice(0, 100).map(s => {
        const fMap = extractCandidateFeaturesV9(sk, ds, s, s.barIndex, fund, fCtx);
        const sc = scoreCandidateV5(fMap, mSpec);
        const vec = mSpec.featureNames.map(fn => (Number.isFinite(fMap[fn]) ? fMap[fn] : null));
        return { vec, jsProb: sc.probWin, jsPass: sc.pass };
      });
      tasks.push({ sk, modelSpec: mSpec, rows });
    }

    const pyCode = `
import json, sys
import numpy as np
from scipy.special import expit
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

payload = json.loads(sys.stdin.read())
out = {}

def eval_tree(tree, x_f32):
    node = 0
    cl = tree['childrenLeft']
    cr = tree['childrenRight']
    feat = tree['feature']
    thresh = tree['threshold']
    val = tree['value']
    while True:
        f = feat[node]
        if f < 0:
            return float(val[node])
        if x_f32[f] <= thresh[node]:
            node = cl[node]
        else:
            node = cr[node]

for task in payload:
    sk = task['sk']
    ms = task['modelSpec']
    rows = task['rows']
    medians = np.array(ms['imputer']['medians'], dtype=np.float64)
    X_raw = np.array([[np.nan if v is None else float(v) for v in r['vec']] for r in rows], dtype=np.float64)
    for j in range(X_raw.shape[1]):
        mask = ~np.isfinite(X_raw[:, j])
        X_raw[mask, j] = medians[j]

    scaler = StandardScaler()
    scaler.mean_ = np.array(ms['scaler']['mean'], dtype=np.float64)
    scaler.scale_ = np.array(ms['scaler']['scale'], dtype=np.float64)
    scaler.var_ = scaler.scale_ ** 2
    scaler.n_features_in_ = len(medians)
    X_sc = scaler.transform(X_raw)

    if ms['modelType'] == 'logistic_regression':
        clf = LogisticRegression()
        clf.coef_ = np.array([ms['classifier']['coef']], dtype=np.float64)
        clf.intercept_ = np.array([ms['classifier']['intercept']], dtype=np.float64)
        clf.classes_ = np.array([0, 1])
        py_probs = clf.predict_proba(X_sc)[:, 1]
    elif ms['modelType'] == 'gradient_boosting':
        init_s = float(ms['classifier']['initScore'])
        lr = float(ms['classifier']['learningRate'])
        trees = ms['classifier']['trees']
        X_f32 = X_sc.astype(np.float32)
        py_probs = np.empty(len(X_f32), dtype=np.float64)
        for i in range(len(X_f32)):
            raw = init_s
            for tr in trees:
                raw += lr * eval_tree(tr, X_f32[i])
            py_probs[i] = float(expit(raw))
    else:
        raise ValueError(ms['modelType'])

    thresh = float(ms['threshold'])
    diffs = [abs(float(py_probs[i]) - float(rows[i]['jsProb'])) for i in range(len(rows))]
    pass_mismatch = sum(1 for i in range(len(rows)) if (float(py_probs[i]) >= thresh) != bool(rows[i]['jsPass']))
    out[sk] = {'count': len(rows), 'maxAbsDiff': max(diffs), 'passMismatch': pass_mismatch}

print(json.dumps(out))
`;
    const stdout = execFileSync('python3', ['-c', pyCode], {
      input: JSON.stringify(tasks),
      encoding: 'utf8',
    });
    const res = JSON.parse(stdout);
    for (const t of tasks) {
      const r = res[t.sk];
      assert.ok(r && r.count >= 50);
      assert.equal(r.passMismatch, 0, `${t.sk} pass mismatch`);
      assert.ok(r.maxAbsDiff < 1e-12, `${t.sk} maxAbsDiff=${r.maxAbsDiff}`);
    }
  });
});

describe('3. Zero Liquidation Across All v9 Tiers & Cross-Version Matrix Integrity', () => {
  it('enforces liquidationCount === 0 across all 61 UTC months on SAFE_V9, BALANCED_V9, MAXIMIZED_V9 & Cross-Asset All-Weather', () => {
    const ens = readJsonCached(path.join(RESULTS_V9, 'ensemble_v9_crypto_5y.json'));
    for (const tk of ['SAFE_V9', 'BALANCED_V9', 'MAXIMIZED_V9']) {
      const tier = ens.tiers[tk];
      assert.ok(tier, `Missing tier ${tk}`);
      for (const prof of ['EXCHANGE_POST_ONLY', 'STRICT_TAKER']) {
        const p = tier.profiles[prof];
        assert.ok(p, `Missing profile ${prof} in ${tk}`);
        for (const wk of ['calVal_49m', 'blindHoldoutY5_13m', 'full5y_61m']) {
          assert.equal(p[wk].liquidationCount, 0, `${tk}.${prof}.${wk} liquidationCount !== 0`);
        }
        assert.equal(p.full5y_61m.monthlyTable.length, 61);
      }
    }
    for (const ck of ['overlap2y', 'overlapY5Bear', 'futuresOnly2y']) {
      assert.equal(ens.crossAssetAllWeather[ck].liquidationCount, 0, `crossAssetAllWeather.${ck} liq !== 0`);
    }
  });

  it('verifies all_versions_comparison_matrix.json has zero NaN/Infinity and matches locked v6/v7/v8/v9 JSON artifacts', async () => {
    const mat = readJsonCached(path.join(RESULTS_V9, 'all_versions_comparison_matrix.json'));
    const rawStr = fs.readFileSync(path.join(RESULTS_V9, 'all_versions_comparison_matrix.json'), 'utf8');
    assert.equal(/\bNaN\b/.test(rawStr), false, 'Found NaN in all_versions_comparison_matrix.json');
    assert.equal(/\bInfinity\b/.test(rawStr), false, 'Found Infinity in all_versions_comparison_matrix.json');
    assert.equal(mat.versions.length, 10);
    for (const v of mat.versions) {
      assert.equal(v.verifiedFromArtifact, true, `${v.version} not verifiedFromArtifact`);
    }

    // Re-run async builder in-memory and ensure key locked figures match disk artifacts
    const built = await buildAllVersionsMatrix(REPO_ROOT);
    assert.equal(built.versions.length, 10);

    const v6 = readJsonCached(path.join(RESULTS_V6, 'crypto_eth_sol_5y.json'));
    const v7 = readJsonCached(path.join(RESULTS_V7, 'frontier_75wr_30mo_summary.json'));
    const v8 = readJsonCached(path.join(RESULTS_V8, 'maximized_v8_summary.json'));
    const v9 = readJsonCached(path.join(RESULTS_V9, 'ensemble_v9_crypto_5y.json'));

    assert.equal(
      mat.versionsById['v6.0'].metrics.cryptoQualifiedPostOnly.holdoutY5.compoundedNetPct,
      v6.portfolio4Crypto.EXCHANGE_POST_ONLY.qualifiedOnly.holdoutY5.compoundedNetPct,
    );
    assert.equal(
      mat.versionsById['v7.0'].metrics.tiers.TIER_3_TARGET_30MO_75WR.postOnly.full5y.meanMonthlySweepPct,
      v7.tiers.TIER_3_TARGET_30MO_75WR.profiles.EXCHANGE_POST_ONLY.full5y_60m.meanMonthlySweepPct,
    );
    assert.equal(
      mat.versionsById['v8.0'].metrics.tiers.TIER_3_MAXIMIZED_30MO_75WR.postOnly.full5y.winRatePct,
      v8.tiers.TIER_3_MAXIMIZED_30MO_75WR.profiles.EXCHANGE_POST_ONLY.full5y_60m.winRatePct,
    );
    assert.equal(
      mat.versionsById['v9.0'].metrics.tiers.SAFE_V9.postOnly.full5y.maxCompoundedDdPct,
      v9.tiers.SAFE_V9.profiles.EXCHANGE_POST_ONLY.full5y_61m.maxCompoundedDdPct,
    );
    for (const sleeve of Object.values(mat.crossAssetAllWeather.combinedCrossAssetAllWeather)) {
      assert.equal(sleeve.liquidationCount, 0);
      assert.equal(sleeve.sweepLiquidationCount, 0);
    }
  });
});

describe('4. StandaloneOrderRouter Hermetic Security, Idempotency & Crash Recovery', () => {
  it('PAPER_ZERO_KEY never hits private HTTP endpoints and logs PAPER_SIMULATED idempotently', async () => {
    const tmp = makeTmpDir('v9-r-paper-');
    let fetchCalls = 0;
    const cfg = loadConfig({ cwd: tmp, useProcessEnv: false });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'r.sqlite'), allowedBaseDir: tmp });
    const client = new OkxClient({
      dryRun: true,
      executionMode: 'PAPER',
      fetchImpl: async () => { fetchCalls++; throw new Error('Must not call network'); },
    });
    const router = new StandaloneOrderRouter({ config: cfg, store, exchangeClient: client });
    try {
      assert.equal(router.getStatus().mode, ROUTER_MODES.PAPER_ZERO_KEY);
      const overlay = { status: 'PENDING_LIMIT', side: 1, limitPrice: 60000, signalTime: 1795590000, lev: 2.0 };
      const r1 = await router.routeTransition({ symbol: 'BTCUSDT.P', timeframe: '1h', activeOverlay: overlay });
      assert.equal(r1.action, 'PAPER_SIMULATED');
      assert.equal(fetchCalls, 0);

      const r2 = await router.routeTransition({ symbol: 'BTCUSDT.P', timeframe: '1h', activeOverlay: overlay });
      assert.equal(r2.action, 'IDEMPOTENT_SKIP');
      assert.equal(fetchCalls, 0);
    } finally {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks missing/wrong LIVE_CONFIRM_TOKEN or oversized notional, and routes alphanumeric OKX Demo post_only + OCO once', async () => {
    const tmp = makeTmpDir('v9-r-demo-');
    const calls = [];
    const cfg = loadConfig({
      cwd: tmp,
      useProcessEnv: false,
      envOverrides: {
        EXCHANGE: 'OKX',
        EXECUTION_MODE: 'LIVE_ARMED',
        DRY_RUN: 'false',
        OKX_SIMULATED: '1',
        OKX_API_KEY: 'demo-key',
        OKX_API_SECRET: 'demo-secret',
        OKX_PASSPHRASE: 'demo-pass',
        LIVE_CONFIRM_TOKEN: 'good-tok-99',
        MAX_ORDER_USDT: '500',
      },
    });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'r2.sqlite'), allowedBaseDir: tmp });
    const client = new OkxClient({
      apiKey: cfg.okx.apiKey,
      apiSecret: cfg.okx.apiSecret,
      passphrase: cfg.okx.passphrase,
      simulated: true,
      dryRun: false,
      executionMode: 'LIVE_ARMED',
      liveConfirmToken: cfg.liveConfirmToken,
      maxOrderUsdt: 500,
      fetchImpl: async (url, init) => {
        const body = init.body ? JSON.parse(init.body) : {};
        calls.push({ url, headers: init.headers, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: '0', msg: '', data: [{ ordId: `ord${calls.length}`, algoId: `alg${calls.length}`, sCode: '0' }] }),
        };
      },
    });

    try {
      const badTokRouter = new StandaloneOrderRouter({ config: cfg, store, exchangeClient: client, confirmToken: 'wrong-tok' });
      const pending = { status: 'PENDING_LIMIT', side: 1, limitPrice: 60000, signalTime: 1795590000, lev: 2.0 };
      await assert.rejects(
        () => badTokRouter.routeTransition({ symbol: 'BTCUSDT.P', timeframe: '1h', activeOverlay: pending }),
        /LIVE_CONFIRM_TOKEN mismatch/,
      );
      assert.equal(calls.length, 0);

      // Oversized notional interlock
      await assert.rejects(
        () => badTokRouter.routeTransition({
          symbol: 'BTCUSDT.P',
          timeframe: '1h',
          activeOverlay: pending,
          confirmToken: 'good-tok-99',
          notionalUsdt: 9999,
        }),
        /MAX_ORDER_USDT/,
      );
      assert.equal(calls.length, 0);

      // Valid Demo submission -> post_only + strictly alphanumeric clOrdId ONCE, then idempotent skip
      const goodRouter = new StandaloneOrderRouter({ config: cfg, store, exchangeClient: client, confirmToken: 'good-tok-99' });
      assert.equal(goodRouter.getStatus().mode, ROUTER_MODES.OKX_DEMO_SIMULATED);

      const pending2 = { status: 'PENDING_LIMIT', side: 1, limitPrice: 60100, signalTime: 1795593600, lev: 2.0 };
      const rOk = await goodRouter.routeTransition({ symbol: 'BTCUSDT.P', timeframe: '1h', activeOverlay: pending2 });
      assert.equal(rOk.action, 'SUBMITTED');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].headers['x-simulated-trading'], '1');
      assert.equal(calls[0].body.ordType, 'post_only');
      assert.ok(OKX_CLORDID_REGEX.test(calls[0].body.clOrdId), `Invalid clOrdId: ${calls[0].body.clOrdId}`);
      assert.ok(isValidOkxClOrdId(calls[0].body.clOrdId));

      const rDup = await goodRouter.routeTransition({ symbol: 'BTCUSDT.P', timeframe: '1h', activeOverlay: pending2 });
      assert.equal(rDup.action, 'IDEMPOTENT_SKIP');
      assert.equal(calls.length, 1);

      // Open position -> protective OCO reduceOnly SL/TP ONCE (entry already filled, no cancel)
      const openPos = { status: 'OPEN_POSITION', side: 1, entry: 60100, stop: 58500, target: 62000, entryTime: 1795597200, lev: 2.0 };
      const rSlTp = await goodRouter.routeTransition({ symbol: 'BTCUSDT.P', timeframe: '1h', activeOverlay: openPos, previousOverlay: pending2 });
      assert.equal(rSlTp.action, 'SUBMITTED');
      assert.equal(calls.length, 2); // entry post_only + order-algo OCO
      assert.equal(calls[1].body.ordType, 'oco');
      assert.equal(calls[1].body.reduceOnly, true);

      // Idempotent duplicate OPEN_POSITION -> skipped cleanly
      const rSlTpDup = await goodRouter.routeTransition({ symbol: 'BTCUSDT.P', timeframe: '1h', activeOverlay: openPos, previousOverlay: pending2 });
      assert.equal(rSlTpDup.action, 'IDEMPOTENT_SKIP');
      assert.equal(calls.length, 2);

      // Stale PENDING_LIMIT -> FLAT cancels pending order
      const pending3 = { status: 'PENDING_LIMIT', side: -1, limitPrice: 61500, signalTime: 1795600800, lev: 2.0 };
      await goodRouter.routeTransition({ symbol: 'BTCUSDT.P', timeframe: '1h', activeOverlay: pending3 });
      assert.equal(calls.length, 3);
      await goodRouter.routeTransition({ symbol: 'BTCUSDT.P', timeframe: '1h', activeOverlay: { status: 'FLAT' }, previousOverlay: pending3 });
      assert.equal(calls.length, 4);
      assert.ok(calls[3].url.includes('/cancel-order'));
    } finally {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('crash recovery transitions SUBMITTING orders to INTERRUPTED on store reopen', () => {
    const tmp = makeTmpDir('v9-r-crash-');
    const dbPath = path.join(tmp, 'crash.sqlite');
    try {
      const s1 = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
      s1.upsertOrderLog({
        clientOrderId: 'tt9OKXBTC1hLEabc123def456',
        exchange: 'OKX',
        symbol: 'BTCUSDT.P',
        mode: 'OKX_DEMO_SIMULATED',
        orderType: 'post_only',
        side: 'buy',
        price: 60000,
        qty: 0.01,
        reduceOnly: false,
        status: 'SUBMITTING',
      });
      s1.close();

      const s2 = new StandaloneStore({ dbPath, allowedBaseDir: tmp });
      const recovered = s2.recoverInterruptedOrders();
      assert.equal(recovered, 1);
      const rows = s2.getOrdersLog({ symbol: 'BTCUSDT.P' });
      assert.equal(rows[0].status, 'INTERRUPTED');
      s2.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('5. Zero-XSS, Loopback, .env Gitignore & Live HTTP Endpoints (/api/versions, /api/orders, v9)', () => {
  it('passes static Zero-XSS scan, loopback host enforcement & .gitignore .env checks', () => {
    const pub = path.join(REPO_ROOT, 'standalone', 'public');
    const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    const stylesCss = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');

    for (const pat of [/\.innerHTML\b/i, /\.outerHTML\b/i, /insertAdjacentHTML\b/i, /document\.write\b/i, /\beval\s*\(/i, /new\s+Function\b/i]) {
      assert.equal(pat.test(appJs), false, `Forbidden DOM sink ${pat} in app.js`);
      assert.equal(pat.test(indexHtml), false, `Forbidden DOM sink ${pat} in index.html`);
    }
    assert.equal(/\son[a-z]+\s*=/i.test(indexHtml), false);
    assert.equal(indexHtml.match(/<script(?![^>]*\bsrc=)[^>]*>/gi), null);
    assert.equal(/expression\s*\(/i.test(stylesCss), false);

    assert.throws(() => assertLoopbackHost('0.0.0.0'), /Security policy violation/);
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.env$/m);
  });

  it('serves /api/versions, /api/orders, /api/backtest?version=v9, /api/frontier?version=v9 on 127.0.0.1', async () => {
    const tmp = makeTmpDir('v9-srv-');
    const cfg = loadConfig({ cwd: REPO_ROOT, useProcessEnv: false, envOverrides: { HOST: '127.0.0.1', PORT: '0' } });
    const store = new StandaloneStore({ dbPath: path.join(tmp, 'srv.sqlite'), allowedBaseDir: tmp });
    const runtimeSpecs = await loadRuntimeSpecs(REPO_ROOT);
    const srv = createStandaloneServer({ config: cfg, store, runtimeSpecs });

    try {
      const bound = await srv.start();
      assert.equal(bound.host, '127.0.0.1');
      const base = `http://${bound.host}:${bound.port}`;

      const vers = await (await fetch(`${base}/api/versions`)).json();
      assert.equal(vers.ok, true);
      assert.equal(vers.ready, true);
      assert.equal(vers.versions.length, 10);

      const ords = await (await fetch(`${base}/api/orders`)).json();
      assert.equal(ords.ok, true);
      assert.equal(ords.router.mode, ROUTER_MODES.PAPER_ZERO_KEY);

      const btV9 = await (await fetch(`${base}/api/backtest?symbol=BTCUSDT.P&timeframe=1h&version=v9`)).json();
      assert.equal(btV9.ok, true);
      assert.ok(btV9.summary.count > 0);
      assert.equal(btV9.summary.liquidationCount, 0);

      const frV9 = await (await fetch(`${base}/api/frontier?version=v9&tier=SAFE_75WR`)).json();
      assert.equal(frV9.ok, true);
      assert.equal(frV9.ready, true);
      assert.equal(frV9.selectedTier.full5y.liquidationCount, 0);
    } finally {
      await srv.stop();
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
