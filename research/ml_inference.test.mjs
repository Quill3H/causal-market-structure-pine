import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_NAMES_V5, extractCandidateFeaturesV5, precomputeFeatureContextV5 } from './features_v5.mjs';
import { scoreCandidateV5, predictProbaV5, evaluateEnsemble } from './ml_inference.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('Pure-JS ml_inference matches Python sklearn Pipeline predict_proba < 1e-12 for LogisticRegression and GradientBoostingClassifier', () => {
  const pyScript = `
import json, numpy as np
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.pipeline import Pipeline

rng = np.random.RandomState(2026)
n_train, n_test, d = 240, 60, 12
X_train = rng.randn(n_train, d) * 1.7 + 0.3
X_test = rng.randn(n_test, d) * 1.7 + 0.3
# Inject NaNs in both train and test
for i in range(0, n_train, 9):
    X_train[i, i % d] = np.nan
for i in range(0, n_test, 5):
    X_test[i, (i * 3) % d] = np.nan

signal = 0.9 * np.nan_to_num(X_train[:, 0]) - 0.7 * np.nan_to_num(X_train[:, 1]) + 0.5 * np.nan_to_num(X_train[:, 2] * X_train[:, 3])
y_train = (signal + 0.4 * rng.randn(n_train) > 0).astype(int)

fnames = [f"f_{j}" for j in range(d)]

def export_pipeline(pipe, mtype):
    imp = pipe.named_steps["imp"]
    sc = pipe.named_steps["sc"]
    clf = pipe.named_steps["clf"]
    spec = {
        "modelType": mtype,
        "featureNames": fnames,
        "threshold": 0.55,
        "sizeCurve": {"mode": "linear", "minMult": 0.8, "maxMult": 1.4, "pMax": 0.85},
        "imputer": {"medians": imp.statistics_.tolist()},
        "scaler": {"mean": sc.mean_.tolist(), "scale": sc.scale_.tolist()},
    }
    if mtype == "logistic_regression":
        spec["classifier"] = {
            "coef": clf.coef_[0].tolist(),
            "intercept": float(clf.intercept_[0]),
        }
    else:
        trees = []
        for est in clf.estimators_[:, 0]:
            tr = est.tree_
            trees.append({
                "childrenLeft": tr.children_left.tolist(),
                "childrenRight": tr.children_right.tolist(),
                "feature": tr.feature.tolist(),
                "threshold": tr.threshold.tolist(),
                "value": tr.value[:, 0, 0].tolist(),
            })
        spec["classifier"] = {
            "initScore": float(np.log(clf.init_.class_prior_[1] / clf.init_.class_prior_[0])),
            "learningRate": float(clf.learning_rate),
            "trees": trees,
        }
    return spec

pipe_lr = Pipeline([("imp", SimpleImputer(strategy="median")), ("sc", StandardScaler()), ("clf", LogisticRegression(C=0.25, max_iter=1000))])
pipe_lr.fit(X_train, y_train)

pipe_gb = Pipeline([("imp", SimpleImputer(strategy="median")), ("sc", StandardScaler()), ("clf", GradientBoostingClassifier(n_estimators=25, max_depth=2, learning_rate=0.08, random_state=42))])
pipe_gb.fit(X_train, y_train)

p_lr = pipe_lr.predict_proba(X_test)[:, 1].tolist()
p_gb = pipe_gb.predict_proba(X_test)[:, 1].tolist()
rows = [[None if np.isnan(v) else float(v) for v in row] for row in X_test]

print(json.dumps({
    "lrSpec": export_pipeline(pipe_lr, "logistic_regression"),
    "gbSpec": export_pipeline(pipe_gb, "gradient_boosting"),
    "X_test": rows,
    "p_lr": p_lr,
    "p_gb": p_gb,
}))
`;

  const out = execFileSync('python3', ['-c', pyScript], { encoding: 'utf8' });
  const payload = JSON.parse(out);

  let maxDiffLr = 0;
  let maxDiffGb = 0;
  for (let i = 0; i < payload.X_test.length; i++) {
    const row = payload.X_test[i];
    const fmap = {};
    for (let j = 0; j < payload.lrSpec.featureNames.length; j++) {
      fmap[payload.lrSpec.featureNames[j]] = row[j];
    }
    const jsLr = scoreCandidateV5(fmap, payload.lrSpec);
    const jsGb = scoreCandidateV5(fmap, payload.gbSpec);
    maxDiffLr = Math.max(maxDiffLr, Math.abs(jsLr.probWin - payload.p_lr[i]));
    maxDiffGb = Math.max(maxDiffGb, Math.abs(jsGb.probWin - payload.p_gb[i]));

    const ens = evaluateEnsemble(fmap, [
      { weight: 0.4, model: payload.lrSpec },
      { weight: 0.6, model: payload.gbSpec },
    ], { threshold: 0.55 });
    const expectedEns = 0.4 * payload.p_lr[i] + 0.6 * payload.p_gb[i];
    assert.ok(Math.abs(ens.probWin - expectedEns) < 1e-12, `Ensemble mismatch at row ${i}`);
  }

  assert.ok(maxDiffLr < 1e-12, `LR max abs diff ${maxDiffLr} >= 1e-12`);
  assert.ok(maxDiffGb < 1e-12, `GBDT max abs diff ${maxDiffGb} >= 1e-12`);
});

test('extractCandidateFeaturesV5 is strictly causal under prefix truncation and future mutation', () => {
  const ds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'okx_btcusdt_swap_1h_3y.json'), 'utf8'));
  const T = 800;
  const rowsPrefix = ds.rows.slice(0, T);
  const lastTime = rowsPrefix[rowsPrefix.length - 1].time;
  const htfPrefix = {};
  for (const [tf, h] of Object.entries(ds.htf)) {
    const alignedIndex = h.alignedIndex.slice(0, T);
    const maxJ = alignedIndex[alignedIndex.length - 1];
    htfPrefix[tf] = {
      ...h,
      rows: h.rows.slice(0, maxJ + 1).filter(r => r.time + h.intervalSeconds <= lastTime),
      alignedIndex,
    };
  }
  const dsPrefix = { ...ds, rows: rowsPrefix, count: T, lastTime, htf: htfPrefix };

  const dsMutated = structuredClone(dsPrefix);
  const subT = 650;
  const subTime = dsMutated.rows[subT - 1].time;
  for (let i = subT; i < dsMutated.rows.length; i++) {
    dsMutated.rows[i].open *= 2.1;
    dsMutated.rows[i].high *= 2.2;
    dsMutated.rows[i].low *= 2.0;
    dsMutated.rows[i].close *= 2.1;
    dsMutated.rows[i].volume *= 5;
  }
  for (const h of Object.values(dsMutated.htf)) {
    for (const r of h.rows) {
      if (r.time + h.intervalSeconds > subTime) {
        r.open *= 2.1;
        r.high *= 2.2;
        r.low *= 2.0;
        r.close *= 2.1;
      }
    }
  }

  const fakeFunding = dsPrefix.rows.map((r, idx) => ({
    time: r.time - (r.time % 28800),
    fundingRate: 0.0001 * Math.sin(idx / 17),
  }));
  const fakeFundingMutated = fakeFunding.map((f, idx) =>
    idx >= subT ? { ...f, fundingRate: 0.05 } : f,
  );

  const testBars = [300, 450, 649];
  const ctxFull = precomputeFeatureContextV5(ds, fakeFunding, T - 1);
  for (const barIdx of testBars) {
    const sig = { barIndex: barIdx, side: barIdx % 2 === 0 ? 1 : -1, atr: 500, limitPrice: ds.rows[barIdx].close - 50 };
    const fNoCtx = extractCandidateFeaturesV5(dsPrefix, sig, barIdx, fakeFunding);
    const fMut = extractCandidateFeaturesV5(dsMutated, sig, barIdx, fakeFundingMutated);
    const fWithCtx = extractCandidateFeaturesV5(ds, sig, barIdx, fakeFunding, ctxFull);

    for (const name of FEATURE_NAMES_V5) {
      assert.ok(Object.hasOwn(fNoCtx, name), `Missing feature ${name}`);
      if (Number.isNaN(fNoCtx[name])) {
        assert.ok(Number.isNaN(fMut[name]), `NaN mismatch on ${name} at ${barIdx}`);
        assert.ok(Number.isNaN(fWithCtx[name]), `NaN mismatch with ctx on ${name} at ${barIdx}`);
      } else {
        assert.equal(fNoCtx[name], fMut[name], `Future mutation altered ${name} at ${barIdx}`);
        assert.equal(fNoCtx[name], fWithCtx[name], `Precomputed ctx altered ${name} at ${barIdx}`);
      }
    }
  }
});

test('scoreCandidateV5 handles threshold filtering and linear confidence sizeMult', () => {
  const spec = {
    modelType: 'logistic_regression',
    featureNames: ['a', 'b'],
    threshold: 0.6,
    sizeCurve: { mode: 'linear', minMult: 0.8, maxMult: 1.4, pMax: 0.8 },
    imputer: { medians: [0, 0] },
    scaler: { mean: [0, 0], scale: [1, 1] },
    classifier: { coef: [1, 0], intercept: 0 },
  };
  const low = scoreCandidateV5({ a: 0, b: 0 }, spec);
  assert.equal(low.pass, false);
  assert.equal(low.sizeMult, 0);
  assert.ok(Math.abs(predictProbaV5({ a: 0, b: 0 }, spec) - 0.5) < 1e-12);

  const high = scoreCandidateV5({ a: 3, b: 0 }, spec);
  assert.equal(high.pass, true);
  assert.ok(Math.abs(high.sizeMult - 1.4) < 1e-12);
});

test('Real trained ml_models_btc_v5.json matches Python sklearn reconstruction < 1e-12 across 60 real BTC 1h/15m candidates', () => {
  const modelPath = path.join(ROOT, 'research', 'results_v5', 'ml_models_btc_v5.json');
  assert.ok(fs.existsSync(modelPath), 'Expected ml_models_btc_v5.json');
  const modelsJson = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
  const ds1h = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'okx_btcusdt_swap_1h_3y.json'), 'utf8'));
  const funding = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'okx_btcusdt_swap_funding_3y.json'), 'utf8')).rows;
  const ctx = precomputeFeatureContextV5(ds1h, null, 2500);

  const sampleMaps = [];
  const jsProbs1h = [];
  const jsProbs15 = [];
  for (let i = 300; i < 2500; i += 35) {
    const fRow = funding.findLast(r => r.time <= ds1h.rows[i].time) ?? null;
    const fakeAligned = new Array(i + 1).fill(fRow);
    const sig = { barIndex: i, side: i % 2 === 0 ? 1 : -1, atr: ctx.ltf.atr14[i], limitPrice: ds1h.rows[i].close - 50 };
    const fmap = extractCandidateFeaturesV5(ds1h, sig, i, fakeAligned, ctx);
    const cleanMap = {};
    for (const k of FEATURE_NAMES_V5) {
      cleanMap[k] = Number.isFinite(fmap[k]) ? fmap[k] : null;
    }
    sampleMaps.push(cleanMap);
    jsProbs1h.push(scoreCandidateV5(fmap, modelsJson.models['1h']).probWin);
    jsProbs15.push(scoreCandidateV5(fmap, modelsJson.models['15m']).probWin);
  }

  const pyVerify = `
import json, sys, numpy as np
req = json.loads(sys.stdin.read())
models = json.load(open(${JSON.stringify(modelPath)}))["models"]

def expit(x):
    return 1.0 / (1.0 + np.exp(-x)) if x >= 0 else np.exp(x) / (1.0 + np.exp(x))

def eval_tree(tree, x):
    idx = 0
    while tree["feature"][idx] >= 0:
        f = tree["feature"][idx]
        if np.float32(x[f]) <= tree["threshold"][idx]:
            idx = tree["childrenLeft"][idx]
        else:
            idx = tree["childrenRight"][idx]
    return tree["value"][idx]

def eval_model(fmap, spec):
    if spec["modelType"] == "ensemble":
        w_sum = sum(m["weight"] for m in spec["models"])
        return sum(m["weight"] * eval_model(fmap, m["model"]) for m in spec["models"]) / w_sum
    x = np.array([np.nan if fmap.get(k) is None else float(fmap[k]) for k in spec["featureNames"]], dtype=np.float64)
    meds = np.array(spec["imputer"]["medians"], dtype=np.float64)
    nan_mask = np.isnan(x)
    x[nan_mask] = meds[nan_mask]
    means = np.array(spec["scaler"]["mean"], dtype=np.float64)
    scales = np.array(spec["scaler"]["scale"], dtype=np.float64)
    scales = np.where(scales == 0, 1.0, scales)
    z = (x - means) / scales
    if spec["modelType"] == "logistic_regression":
        coef = np.array(spec["classifier"]["coef"], dtype=np.float64)
        logit = float(spec["classifier"]["intercept"]) + float(np.dot(coef, z))
        return float(expit(logit))
    raw = float(spec["classifier"]["initScore"])
    lr = float(spec["classifier"]["learningRate"])
    for tr in spec["classifier"]["trees"]:
        raw += lr * eval_tree(tr, z)
    return float(expit(raw))

p1h = [eval_model(m, models["1h"]) for m in req]
p15 = [eval_model(m, models["15m"]) for m in req]
print(json.dumps({"p1h": p1h, "p15": p15}))
`;
  const pyOut = JSON.parse(execFileSync('python3', ['-c', pyVerify], {
    input: JSON.stringify(sampleMaps),
    encoding: 'utf8',
  }));
  let maxDiff1h = 0;
  let maxDiff15 = 0;
  for (let i = 0; i < sampleMaps.length; i++) {
    maxDiff1h = Math.max(maxDiff1h, Math.abs(jsProbs1h[i] - pyOut.p1h[i]));
    maxDiff15 = Math.max(maxDiff15, Math.abs(jsProbs15[i] - pyOut.p15[i]));
  }
  assert.ok(sampleMaps.length >= 50);
  assert.ok(maxDiff1h < 1e-12, `1h real model diff ${maxDiff1h}`);
  assert.ok(maxDiff15 < 1e-12, `15m real model diff ${maxDiff15}`);
});
