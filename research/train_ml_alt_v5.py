#!/usr/bin/env python3
"""
Anti-leakage ML meta-labeling trainer for altcoins: OKX:ETHUSDT.P & OKX:SOLUSDT.P (1h).

Strict chronological protocol:
  - Cal (Y1)     = [0 .. floor(N/3))          [8,760 bars]
  - Val (Y2)     = [floor(N/3) .. floor(2N/3)) [8,760 bars]
  - Holdout (Y3) = [floor(2N/3) .. N)         [NEVER loaded or accessed during training/selection!]

All preprocessing (SimpleImputer median, StandardScaler) and classifiers
(LogisticRegression, shallow GradientBoostingClassifier) are fit ONLY on purged Cal (Y1).
Model family, regularization, probability threshold tau, and confidence sizeCurve
are selected strictly via sequential Val (Y2) simulation under EXCHANGE_POST_ONLY + real funding.
"""

import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.pipeline import Pipeline

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT_PATH = os.path.join(ROOT_DIR, 'research', 'results_v5', 'ml_models_alt_v5.json')


NODE_EXTRACT_SCRIPT = r"""
import fs from 'node:fs';
import { simulateTradesV5 } from './research/sim_engine_v5.mjs';
import { alignFundingToBarsCausal } from './research/fetch_okx_derivs.mjs';
import { sliceDatasetPrefix1h } from './research/signals_1h.mjs';
import { getAltAssetConfigV5, generateSignalsAltV5 } from './research/signals_v5_alt.mjs';
import { FEATURE_NAMES_V5, precomputeFeatureContextV5, extractCandidateFeaturesV5 } from './research/features_v5.mjs';

function buildAssetData(assetKey) {
  const cfg = getAltAssetConfigV5(assetKey);
  const full = JSON.parse(fs.readFileSync(`data/${cfg.dataFile}`, 'utf8'));
  const fundingAll = JSON.parse(fs.readFileSync(`data/${cfg.fundingFile}`, 'utf8')).rows;

  const n = full.rows.length;
  const calEnd = Math.floor(n / 3);
  const valEnd = Math.floor((2 * n) / 3);
  // Strictly truncate at valEnd so Blind Holdout Y3 is never touched during training/selection.
  const dsCV = sliceDatasetPrefix1h(full, valEnd);
  const signals = generateSignalsAltV5(dsCV, cfg.signalSpec);

  const fundingCV = fundingAll.filter(f => f.time <= dsCV.lastTime);
  const alignedFunding = alignFundingToBarsCausal(dsCV.rows, fundingCV);
  const ctx = precomputeFeatureContextV5(dsCV, alignedFunding);

  const execOpts = {
    ...cfg.execOptions,
    execProfile: 'EXCHANGE_POST_ONLY',
    fundingRows: fundingCV,
    intervalSeconds: 3600,
  };

  const sigFeatures = [];
  for (const s of signals) {
    const fmap = extractCandidateFeaturesV5(dsCV, s, s.barIndex, alignedFunding, ctx);
    sigFeatures.push({
      barIndex: s.barIndex,
      side: s.side,
      atr: s.atr,
      limitPrice: s.limitPrice ?? null,
      vec: FEATURE_NAMES_V5.map(k => (Number.isFinite(fmap[k]) ? fmap[k] : null)),
    });
  }

  // Purged Cal(Y1) sequential & standalone labels (only exitIndex < calEnd)
  const simCalSeq = simulateTradesV5(dsCV.rows, signals, { ...execOpts, start: 0, end: calEnd });
  const seqBySigBar = new Map();
  for (const t of simCalSeq.trades) {
    if (t.signalIndex >= 0 && t.exitIndex < calEnd) {
      seqBySigBar.set(t.signalIndex, t);
    }
  }

  const calStandalone = [];
  const calSequential = [];
  for (let idx = 0; idx < signals.length; idx++) {
    const s = signals[idx];
    if (s.barIndex >= calEnd) break;
    const singleSim = simulateTradesV5(dsCV.rows, [s], { ...execOpts, start: 0, end: calEnd, warmup: 0 });
    if (singleSim.trades.length === 1) {
      const tr = singleSim.trades[0];
      if (tr.signalIndex < calEnd && tr.exitIndex < calEnd) {
        calStandalone.push({
          idx,
          barIndex: s.barIndex,
          y: tr.netPct > 0 ? 1 : 0,
          netPct: tr.netPct,
          exitReason: tr.exitReason,
        });
      }
    }
    const seqTr = seqBySigBar.get(s.barIndex);
    if (seqTr) {
      calSequential.push({
        idx,
        barIndex: s.barIndex,
        y: seqTr.netPct > 0 ? 1 : 0,
        netPct: seqTr.netPct,
        exitReason: seqTr.exitReason,
      });
    }
  }

  const baseValSim = simulateTradesV5(dsCV.rows, signals, { ...execOpts, start: calEnd, end: valEnd });

  return {
    assetKey,
    symbol: cfg.symbol,
    instId: cfg.instId,
    dataFile: cfg.dataFile,
    fundingFile: cfg.fundingFile,
    signalSpec: cfg.signalSpec,
    execOptions: cfg.execOptions,
    totalBarsFull: n,
    calEnd,
    valEnd,
    featureNames: FEATURE_NAMES_V5,
    signals: sigFeatures,
    calStandalone,
    calSequential,
    baseVal: {
      count: baseValSim.count,
      winRatePct: baseValSim.winRatePct ?? 0,
      profitFactor: baseValSim.profitFactor ?? 0,
      totalNetPct: baseValSim.totalNetPct ?? 0,
      compoundedNetPct: baseValSim.compoundedNetPct ?? 0,
      compoundedMaxDrawdownPct: baseValSim.compoundedMaxDrawdownPct ?? 0,
      retToDd: baseValSim.retToDd ?? 0,
    },
    baseCalSeq: {
      count: simCalSeq.count,
      winRatePct: simCalSeq.winRatePct ?? 0,
      profitFactor: simCalSeq.profitFactor ?? 0,
      totalNetPct: simCalSeq.totalNetPct ?? 0,
      compoundedNetPct: simCalSeq.compoundedNetPct ?? 0,
    },
  };
}

const payload = {
  ETH: buildAssetData('ETH'),
  SOL: buildAssetData('SOL'),
};
process.stdout.write(JSON.stringify(payload));
"""


NODE_EVAL_VAL_SCRIPT = r"""
import fs from 'node:fs';
import { simulateTradesV5 } from './research/sim_engine_v5.mjs';
import { sliceDatasetPrefix1h } from './research/signals_1h.mjs';
import { getAltAssetConfigV5, generateSignalsAltV5 } from './research/signals_v5_alt.mjs';

const req = JSON.parse(fs.readFileSync(0, 'utf8'));

function evalAssetVal(assetKey, items) {
  const cfg = getAltAssetConfigV5(assetKey);
  const full = JSON.parse(fs.readFileSync(`data/${cfg.dataFile}`, 'utf8'));
  const fundingAll = JSON.parse(fs.readFileSync(`data/${cfg.fundingFile}`, 'utf8')).rows;
  const n = full.rows.length;
  const calEnd = Math.floor(n / 3);
  const valEnd = Math.floor((2 * n) / 3);
  const dsCV = sliceDatasetPrefix1h(full, valEnd);
  const baseSignals = generateSignalsAltV5(dsCV, cfg.signalSpec);
  const fundingCV = fundingAll.filter(f => f.time <= dsCV.lastTime);

  const execOpts = {
    ...cfg.execOptions,
    execProfile: 'EXCHANGE_POST_ONLY',
    fundingRows: fundingCV,
    intervalSeconds: 3600,
  };

  const rowsVal = dsCV.rows.slice(calEnd, valEnd);
  const results = [];
  for (const cand of items) {
    const filteredVal = [];
    for (let k = 0; k < baseSignals.length; k++) {
      const s = baseSignals[k];
      if (s.barIndex < calEnd || s.barIndex >= valEnd) continue;
      const p = cand.probs[k];
      if (p >= cand.threshold) {
        let sizeMult = 1.0;
        if (cand.sizeCurve && cand.sizeCurve.mode === 'linear') {
          const pMax = cand.sizeCurve.pMax;
          const u = Math.max(0, Math.min(1, (p - cand.threshold) / Math.max(1e-6, pMax - cand.threshold)));
          sizeMult = cand.sizeCurve.minMult + u * (cand.sizeCurve.maxMult - cand.sizeCurve.minMult);
        }
        filteredVal.push({ ...s, barIndex: s.barIndex - calEnd, sizeMult });
      }
    }
    const simVal = simulateTradesV5(rowsVal, filteredVal, { ...execOpts, start: 0, end: rowsVal.length, warmup: 0 });
    results.push({
      id: cand.id,
      val: {
        count: simVal.count,
        winRatePct: simVal.winRatePct ?? 0,
        profitFactor: simVal.profitFactor ?? 0,
        totalNetPct: simVal.totalNetPct ?? 0,
        compoundedNetPct: simVal.compoundedNetPct ?? 0,
        compoundedMaxDrawdownPct: simVal.compoundedMaxDrawdownPct ?? 0,
        retToDd: simVal.retToDd ?? 0,
      },
    });
  }
  return results;
}

const out = {
  ETH: evalAssetVal('ETH', req.ETH),
  SOL: evalAssetVal('SOL', req.SOL),
};
process.stdout.write(JSON.stringify(out));
"""


def export_pipeline_spec(pipe, mtype, feature_names, threshold, size_curve):
    imp = pipe.named_steps['imp']
    sc = pipe.named_steps['sc']
    clf = pipe.named_steps['clf']
    medians = [0.0 if np.isnan(v) else float(v) for v in imp.statistics_]
    spec = {
        'modelType': mtype,
        'featureNames': list(feature_names),
        'threshold': float(threshold),
        'sizeCurve': size_curve,
        'imputer': {'medians': medians},
        'scaler': {
            'mean': [float(v) for v in sc.mean_],
            'scale': [float(v) for v in sc.scale_],
        },
    }
    if mtype == 'logistic_regression':
        spec['classifier'] = {
            'coef': [float(v) for v in clf.coef_[0]],
            'intercept': float(clf.intercept_[0]),
        }
    elif mtype == 'gradient_boosting':
        trees = []
        for est in clf.estimators_[:, 0]:
            tr = est.tree_
            trees.append({
                'childrenLeft': tr.children_left.tolist(),
                'childrenRight': tr.children_right.tolist(),
                'feature': tr.feature.tolist(),
                'threshold': tr.threshold.tolist(),
                'value': tr.value[:, 0, 0].tolist(),
            })
        spec['classifier'] = {
            'initScore': float(np.log(clf.init_.class_prior_[1] / clf.init_.class_prior_[0])),
            'learningRate': float(clf.learning_rate),
            'trees': trees,
        }
    else:
        raise ValueError(f'Unknown mtype {mtype}')
    return spec


def build_candidate_models(X_full, cal_rows):
    candidates = []
    X_cal_raw = np.array([X_full[r['idx']] for r in cal_rows], dtype=np.float64)
    y_cal = np.array([r['y'] for r in cal_rows], dtype=np.int64)
    abs_net = np.array([abs(r['netPct']) for r in cal_rows], dtype=np.float64)
    weights_mag = np.clip(abs_net, 0.25, 4.0)

    for c_val in [0.01, 0.025, 0.05, 0.1, 0.25, 0.5]:
        for weight_name, sw in [('unweighted', None), ('mag', weights_mag)]:
            pipe = Pipeline([
                ('imp', SimpleImputer(strategy='median', keep_empty_features=True)),
                ('sc', StandardScaler()),
                ('clf', LogisticRegression(C=c_val, max_iter=2000, random_state=42)),
            ])
            fit_kwargs = {'clf__sample_weight': sw} if sw is not None else {}
            pipe.fit(X_cal_raw, y_cal, **fit_kwargs)
            probs = pipe.predict_proba(X_full)[:, 1].tolist()
            candidates.append({
                'name': f'LR_C{c_val}_{weight_name}',
                'mtype': 'logistic_regression',
                'pipe': pipe,
                'probs': probs,
            })

    for max_depth in [1, 2]:
        for n_est in [15, 25, 40]:
            for lr in [0.03, 0.05]:
                for min_leaf in [8, 12]:
                    pipe = Pipeline([
                        ('imp', SimpleImputer(strategy='median', keep_empty_features=True)),
                        ('sc', StandardScaler()),
                        ('clf', GradientBoostingClassifier(
                            n_estimators=n_est,
                            max_depth=max_depth,
                            learning_rate=lr,
                            min_samples_leaf=min_leaf,
                            subsample=0.8,
                            random_state=42,
                        )),
                    ])
                    pipe.fit(X_cal_raw, y_cal)
                    probs = pipe.predict_proba(X_full)[:, 1].tolist()
                    candidates.append({
                        'name': f'GB_d{max_depth}_n{n_est}_lr{lr}_lf{min_leaf}',
                        'mtype': 'gradient_boosting',
                        'pipe': pipe,
                        'probs': probs,
                    })

    return candidates


def prepare_val_grid(asset_data):
    X_full = np.array(
        [[np.nan if v is None else float(v) for v in s['vec']] for s in asset_data['signals']],
        dtype=np.float64,
    )
    label_sets = {
        'seq': asset_data['calSequential'],
        'standalone': asset_data['calStandalone'],
    }
    trained_models = []
    for lbl_name, rows in label_sets.items():
        if len(rows) < 25:
            continue
        cands = build_candidate_models(X_full, rows)
        for c in cands:
            c['labelSet'] = lbl_name
            c['id'] = f"{lbl_name}:{c['name']}"
            trained_models.append(c)

    for lbl_name in label_sets:
        lrs = [m for m in trained_models if m['labelSet'] == lbl_name and m['mtype'] == 'logistic_regression']
        gbs = [m for m in trained_models if m['labelSet'] == lbl_name and m['mtype'] == 'gradient_boosting']
        for lr_m in [m for m in lrs if 'C0.05_' in m['name'] or 'C0.1_' in m['name']]:
            for gb_m in [m for m in gbs if 'n25_lr0.05_lf8' in m['name'] or 'n40_lr0.03_lf12' in m['name']]:
                probs = (0.5 * np.array(lr_m['probs']) + 0.5 * np.array(gb_m['probs'])).tolist()
                trained_models.append({
                    'id': f"{lbl_name}:ENS({lr_m['name']}+{gb_m['name']})",
                    'labelSet': lbl_name,
                    'mtype': 'ensemble',
                    'members': [(0.5, lr_m), (0.5, gb_m)],
                    'probs': probs,
                })

    val_indices = [
        i for i, s in enumerate(asset_data['signals'])
        if asset_data['calEnd'] <= s['barIndex'] < asset_data['valEnd']
    ]
    size_curves = [
        {'mode': 'flat'},
        {'mode': 'linear', 'minMult': 0.85, 'maxMult': 1.35, 'pMax': 0.88},
        {'mode': 'linear', 'minMult': 0.90, 'maxMult': 1.40, 'pMax': 0.85},
    ]

    eval_items = []
    lookup = {}
    for m in trained_models:
        val_probs = np.array([m['probs'][i] for i in val_indices], dtype=np.float64)
        # Keep >= 65% of Val candidates so Holdout Y3 stays safely >= 30 trades
        qs = np.unique(np.round(np.quantile(val_probs, [0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35]), 4))
        for tau in qs:
            for sc in size_curves:
                eid = f"{m['id']}|t={tau:.4f}|sc={sc['mode']}_{sc.get('minMult',1)}_{sc.get('maxMult',1)}"
                eval_items.append({
                    'id': eid,
                    'probs': m['probs'],
                    'threshold': float(tau),
                    'sizeCurve': sc,
                })
                lookup[eid] = (m, float(tau), sc)

    return eval_items, lookup


def main():
    raw_json = subprocess.check_output(
        ['node', '--input-type=module', '-e', NODE_EXTRACT_SCRIPT],
        cwd=ROOT_DIR,
        text=True,
    )
    data = json.loads(raw_json)

    eval_req = {}
    selections = {}
    for asset_key in ['ETH', 'SOL']:
        eval_items, lookup = prepare_val_grid(data[asset_key])
        eval_req[asset_key] = eval_items
        selections[asset_key] = lookup
        print(
            f"[{asset_key}] Cal rows: seq={len(data[asset_key]['calSequential'])}, "
            f"standalone={len(data[asset_key]['calStandalone'])}; "
            f"Val baseline={data[asset_key]['baseVal']}; eval grid={len(eval_items)}"
        )

    eval_out_raw = subprocess.check_output(
        ['node', '--input-type=module', '-e', NODE_EVAL_VAL_SCRIPT],
        cwd=ROOT_DIR,
        input=json.dumps(eval_req),
        text=True,
    )
    eval_out = json.loads(eval_out_raw)

    exported_assets = {}
    for asset_key in ['ETH', 'SOL']:
        asset_data = data[asset_key]
        base_val = asset_data['baseVal']
        # Require >= 42 Val trades so Y3 after ML filtering remains >= 30 trades
        min_val_count = 42
        scored = []
        for res in eval_out[asset_key]:
            v = res['val']
            eligible = (
                v['count'] >= min_val_count
                and v['winRatePct'] >= max(65.0, base_val['winRatePct'] - 0.5)
                and v['profitFactor'] >= max(1.20, base_val['profitFactor'])
                and v['compoundedNetPct'] >= base_val['compoundedNetPct']
                and v['retToDd'] >= base_val['retToDd']
            )
            score = (
                (10000.0 if eligible else 0.0)
                + (500.0 if v['count'] >= min_val_count else 0.0)
                + v['compoundedNetPct']
                + 25.0 * v['retToDd']
                + 40.0 * (v['profitFactor'] - 1.0)
                + 2.0 * (v['winRatePct'] - base_val['winRatePct'])
            )
            scored.append((score, eligible, res))
        scored.sort(key=lambda x: x[0], reverse=True)

        best_score, best_elig, best_res = scored[0]
        m_obj, tau, sc = selections[asset_key][best_res['id']]
        print(f"\n[{asset_key}] Best Val(Y2) selected: {best_res['id']} (eligible={best_elig}, score={best_score:.2f})")
        print(f"      Base Val : {base_val}")
        print(f"      ML   Val : {best_res['val']}")

        feature_names = asset_data['featureNames']
        if m_obj['mtype'] == 'ensemble':
            model_spec = {
                'modelType': 'ensemble',
                'featureNames': feature_names,
                'threshold': tau,
                'sizeCurve': sc,
                'models': [
                    {
                        'weight': float(w),
                        'model': export_pipeline_spec(mem['pipe'], mem['mtype'], feature_names, tau, {'mode': 'flat'}),
                    }
                    for w, mem in m_obj['members']
                ],
            }
        else:
            model_spec = export_pipeline_spec(m_obj['pipe'], m_obj['mtype'], feature_names, tau, sc)

        lock_payload = {
            'symbol': asset_data['symbol'],
            'signalSpec': asset_data['signalSpec'],
            'execOptions': asset_data['execOptions'],
            'modelSpec': model_spec,
        }
        selection_lock_sha256 = hashlib.sha256(
            json.dumps(lock_payload, sort_keys=True).encode('utf-8')
        ).hexdigest()

        model_spec['assetKey'] = asset_key
        model_spec['symbol'] = asset_data['symbol']
        model_spec['instId'] = asset_data['instId']
        model_spec['signalSpec'] = asset_data['signalSpec']
        model_spec['execOptions'] = asset_data['execOptions']
        model_spec['qualifiedForLive'] = False
        model_spec['selectionLockSha256'] = selection_lock_sha256
        model_spec['selectionMeta'] = {
            'selectedId': best_res['id'],
            'labelSet': m_obj['labelSet'],
            'calRange': [0, asset_data['calEnd']],
            'valRange': [asset_data['calEnd'], asset_data['valEnd']],
            'holdoutRangeUntouched': [asset_data['valEnd'], asset_data['totalBarsFull']],
            'calTrainSamples': len(
                asset_data['calSequential'] if m_obj['labelSet'] == 'seq' else asset_data['calStandalone']
            ),
            'eligibleOnVal': best_elig,
            'valBaseline': base_val,
            'valSelected': best_res['val'],
        }
        exported_assets[asset_data['symbol']] = model_spec

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    artifact = {
        'schema': 'smc-v5-alt-ml-models-v1',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'antiLeakageProtocol': {
            'splitRule': 'Chrono 1/3 Cal (Y1: [0..8760)), 1/3 Val (Y2: [8760..17520)), 1/3 Blind Holdout (Y3: [17520..26280))',
            'purging': 'Purged all Cal/Val boundary-overlapping trades (exitIndex < calEnd)',
            'fitScope': 'Structural parameters calibrated on Y1+Y2; Imputer + StandardScaler + Classifier fit strictly on Cal (Y1); model family + threshold tau + sizeCurve selected strictly on Val (Y2); Holdout Y3 never accessed by trainer',
        },
        'promotionGateCriteria': {
            'minHoldoutY3WinRatePct': 65.0,
            'minHoldoutY3NetPct': 0.0,
            'minHoldoutY3ProfitFactor': 1.15,
            'minHoldoutY3Trades': 30,
            'requiredProfiles': ['STRICT_TAKER', 'EXCHANGE_POST_ONLY'],
        },
        'models': exported_assets,
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(artifact, f, indent=2)
    print(f"\n[train_ml_alt_v5] Saved locked Cal+Val models to {os.path.relpath(OUT_PATH, ROOT_DIR)}")


if __name__ == '__main__':
    main()
