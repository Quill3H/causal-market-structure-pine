#!/usr/bin/env python3
"""
Anti-leakage ML meta-labeling trainer for BTCUSDT.P (1h & 15m).

Strict chronological protocol:
  - Cal (Y1) = [0 .. floor(N/3))
  - Val (Y2) = [floor(N/3) .. floor(2N/3))
  - Holdout (Y3) = [floor(2N/3) .. N)  [NEVER loaded or accessed during training/selection!]

Parsimony & anti-overfitting design (motivated by Cal->Val rank-ordering audit):
  - With Cal sample sizes n~77 (1h) and n~145 (15m), high-dimensional 30+ feature models
    suffer curse-of-dimensionality and regime-drift sign flips.
  - Therefore we evaluate compact, direction-symmetric, stationary feature groups (2-6 features,
    p/n <= 0.08) with strong L2 LogisticRegression and shallow depth-1 GBDT stumps fit ONLY
    on purged Cal (Y1) sequential trades.
  - Model selection on Val (Y2) requires genuine out-of-sample rank ordering (Val ROC-AUC >= 0.56,
    Cal inner-CV AUC >= 0.52) BEFORE optimizing threshold tau and confidence sizeCurve on Val (Y2).
"""

import json
import os
import subprocess
from datetime import datetime, timezone
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import Pipeline

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT_PATH = os.path.join(ROOT_DIR, 'research', 'results_v5', 'ml_models_btc_v5.json')

FEATURE_SUBSETS = {
    '1h': {
        'core_htf_mom_fund': [
            'h4_ema20_dist_atr',
            'h4_ema20_slope_atr',
            'ret_48_dir_atr',
            'recent_dir_sl_streak',
            'funding_dir_align',
            'ltf_ema20_dist_atr',
        ],
        'micro_fund': [
            'h4_ema20_dist_atr',
            'ret_48_dir_atr',
            'recent_dir_sl_streak',
            'funding_ma3_dir',
        ],
        'htf_streak': [
            'h4_ema20_dist_atr',
            'ret_48_dir_atr',
            'recent_dir_sl_streak',
        ],
    },
    '15m': {
        'wick_adv_only': [
            'wick_adv_atr',
        ],
        'wick_adv_streak': [
            'wick_adv_atr',
            'recent_dir_sl_streak',
        ],
        'wick_vol': [
            'wick_adv_atr',
            'wick_opp_atr',
            'atr_pct',
            'rv_ratio_12_48',
        ],
        'wick_only': [
            'wick_adv_atr',
            'wick_opp_atr',
        ],
        'micro_regime': [
            'wick_adv_atr',
            'wick_opp_atr',
            'atr_ratio_50',
            'recent_dir_sl_streak',
            'funding_dir_align',
        ],
    },
}

NODE_EXTRACT_SCRIPT = r"""
import fs from 'node:fs';
import { simulateTradesV5 } from './research/sim_engine_v5.mjs';
import { alignFundingToBarsCausal } from './research/fetch_okx_derivs.mjs';
import { generateSignals1h, sliceDatasetPrefix1h } from './research/signals_1h.mjs';
import { generateSignals15mV4, sliceDatasetPrefix15m } from './research/signals_15m_v4.mjs';
import { FEATURE_NAMES_V5, precomputeFeatureContextV5, extractCandidateFeaturesV5 } from './research/features_v5.mjs';

const lock1h = JSON.parse(fs.readFileSync('research/results_1h/selection-lock.json', 'utf8')).lockedWinner;
const lock15 = JSON.parse(fs.readFileSync('research/results_v4/lock_15m_r3.json', 'utf8')).winner;
const fundingBtc = JSON.parse(fs.readFileSync('data/okx_btcusdt_swap_funding_3y.json', 'utf8')).rows;

function buildTrackData(tf) {
  const is1h = tf === '1h';
  const full = JSON.parse(fs.readFileSync(is1h ? 'data/okx_btcusdt_swap_1h_3y.json' : 'data/okx_btcusdt_swap_15m_3y.json', 'utf8'));
  const n = full.rows.length;
  const calEnd = Math.floor(n / 3);
  const valEnd = Math.floor((2 * n) / 3);
  // Strictly truncate at valEnd so Holdout Y3 is never touched during training/selection.
  const dsCV = is1h ? sliceDatasetPrefix1h(full, valEnd) : sliceDatasetPrefix15m(full, valEnd);
  const signals = is1h
    ? generateSignals1h(dsCV, lock1h.signalSpec)
    : generateSignals15mV4(dsCV, lock15.fullSpec);

  const execOpts = is1h
    ? { ...lock1h.execOptions, volNormRiskPct: 5.0, minLev: 1.6, maxLev: 3.0, execProfile: 'EXCHANGE_POST_ONLY', fundingRows: fundingBtc, fundingPctPer8h: 0.01, intervalSeconds: 3600 }
    : { ...lock15.execOptions, volNormRiskPct: 2.2, minLev: 0.75, maxLev: 1.5, execProfile: 'EXCHANGE_POST_ONLY', fundingRows: fundingBtc, fundingPctPer8h: 0.01, intervalSeconds: 900 };

  const fundingRowsCV = fundingBtc.filter(f => f.time <= dsCV.lastTime);
  const alignedFunding = alignFundingToBarsCausal(dsCV.rows, fundingRowsCV);
  const ctx = precomputeFeatureContextV5(dsCV, alignedFunding);

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

  // Strictly purged Cal(Y1) and Val(Y2) sequential trades
  const simCalSeq = simulateTradesV5(dsCV.rows, signals, { ...execOpts, start: 0, end: calEnd });
  const simValSeq = simulateTradesV5(dsCV.rows, signals, { ...execOpts, start: calEnd, end: valEnd });

  const sigIdxByBar = new Map(signals.map((s, i) => [s.barIndex, i]));
  const calSequential = simCalSeq.trades
    .filter(t => t.signalIndex >= 0 && t.exitIndex < calEnd)
    .map(t => ({
      idx: sigIdxByBar.get(t.signalIndex),
      barIndex: t.signalIndex,
      y: t.netPct > 0 ? 1 : 0,
      netPct: t.netPct,
    }));

  const valSequential = simValSeq.trades
    .filter(t => t.signalIndex >= calEnd && t.exitIndex < valEnd)
    .map(t => ({
      idx: sigIdxByBar.get(t.signalIndex),
      barIndex: t.signalIndex,
      y: t.netPct > 0 ? 1 : 0,
      netPct: t.netPct,
    }));

  return {
    tf,
    totalBarsFull: n,
    calEnd,
    valEnd,
    featureNames: FEATURE_NAMES_V5,
    signals: sigFeatures,
    calSequential,
    valSequential,
    baseVal: {
      count: simValSeq.count,
      winRatePct: simValSeq.winRatePct,
      profitFactor: simValSeq.profitFactor,
      totalNetPct: simValSeq.totalNetPct,
      compoundedNetPct: simValSeq.compoundedNetPct,
      compoundedMaxDrawdownPct: simValSeq.compoundedMaxDrawdownPct,
      retToDd: simValSeq.retToDd,
    },
  };
}

process.stdout.write(JSON.stringify({
  '1h': buildTrackData('1h'),
  '15m': buildTrackData('15m'),
}));
"""


NODE_EVAL_VAL_SCRIPT = r"""
import fs from 'node:fs';
import { simulateTradesV5 } from './research/sim_engine_v5.mjs';
import { generateSignals1h, sliceDatasetPrefix1h } from './research/signals_1h.mjs';
import { generateSignals15mV4, sliceDatasetPrefix15m } from './research/signals_15m_v4.mjs';

const req = JSON.parse(fs.readFileSync(0, 'utf8'));
const lock1h = JSON.parse(fs.readFileSync('research/results_1h/selection-lock.json', 'utf8')).lockedWinner;
const lock15 = JSON.parse(fs.readFileSync('research/results_v4/lock_15m_r3.json', 'utf8')).winner;
const fundingBtc = JSON.parse(fs.readFileSync('data/okx_btcusdt_swap_funding_3y.json', 'utf8')).rows;

function evalTrack(tf, items) {
  const is1h = tf === '1h';
  const full = JSON.parse(fs.readFileSync(is1h ? 'data/okx_btcusdt_swap_1h_3y.json' : 'data/okx_btcusdt_swap_15m_3y.json', 'utf8'));
  const n = full.rows.length;
  const calEnd = Math.floor(n / 3);
  const valEnd = Math.floor((2 * n) / 3);
  const dsCV = is1h ? sliceDatasetPrefix1h(full, valEnd) : sliceDatasetPrefix15m(full, valEnd);
  const baseSignals = is1h
    ? generateSignals1h(dsCV, lock1h.signalSpec)
    : generateSignals15mV4(dsCV, lock15.fullSpec);
  const execOpts = is1h
    ? { ...lock1h.execOptions, volNormRiskPct: 5.0, minLev: 1.6, maxLev: 3.0, execProfile: 'EXCHANGE_POST_ONLY', fundingRows: fundingBtc, fundingPctPer8h: 0.01, intervalSeconds: 3600 }
    : { ...lock15.execOptions, volNormRiskPct: 2.2, minLev: 0.75, maxLev: 1.5, execProfile: 'EXCHANGE_POST_ONLY', fundingRows: fundingBtc, fundingPctPer8h: 0.01, intervalSeconds: 900 };

  const rowsVal = dsCV.rows.slice(calEnd, valEnd);
  const cache = new Map();
  const results = [];
  for (const cand of items) {
    const filteredVal = [];
    const keyParts = [];
    const isFlat = !cand.sizeCurve || cand.sizeCurve.mode === 'flat';
    for (let k = 0; k < baseSignals.length; k++) {
      const s = baseSignals[k];
      if (s.barIndex < calEnd || s.barIndex >= valEnd) continue;
      const p = cand.probs[k];
      if (p >= cand.threshold) {
        let sizeMult = 1.0;
        if (!isFlat && cand.sizeCurve.mode === 'linear') {
          const pMax = cand.sizeCurve.pMax;
          const u = Math.max(0, Math.min(1, (p - cand.threshold) / Math.max(1e-6, pMax - cand.threshold)));
          sizeMult = cand.sizeCurve.minMult + u * (cand.sizeCurve.maxMult - cand.sizeCurve.minMult);
        }
        filteredVal.push({ ...s, barIndex: s.barIndex - calEnd, sizeMult });
        if (isFlat) keyParts.push(k);
      }
    }
    let metrics;
    if (isFlat) {
      const cacheKey = keyParts.join(',');
      metrics = cache.get(cacheKey);
      if (!metrics) {
        const simVal = simulateTradesV5(rowsVal, filteredVal, { ...execOpts, start: 0, end: rowsVal.length, warmup: 0 });
        metrics = {
          count: simVal.count,
          winRatePct: simVal.winRatePct ?? 0,
          profitFactor: simVal.profitFactor ?? 0,
          totalNetPct: simVal.totalNetPct ?? 0,
          compoundedNetPct: simVal.compoundedNetPct ?? 0,
          compoundedMaxDrawdownPct: simVal.compoundedMaxDrawdownPct ?? 0,
          retToDd: simVal.retToDd ?? 0,
        };
        cache.set(cacheKey, metrics);
      }
    } else {
      const simVal = simulateTradesV5(rowsVal, filteredVal, { ...execOpts, start: 0, end: rowsVal.length, warmup: 0 });
      metrics = {
        count: simVal.count,
        winRatePct: simVal.winRatePct ?? 0,
        profitFactor: simVal.profitFactor ?? 0,
        totalNetPct: simVal.totalNetPct ?? 0,
        compoundedNetPct: simVal.compoundedNetPct ?? 0,
        compoundedMaxDrawdownPct: simVal.compoundedMaxDrawdownPct ?? 0,
        retToDd: simVal.retToDd ?? 0,
      };
    }
    results.push({ id: cand.id, val: metrics });
  }
  return results;
}

process.stdout.write(JSON.stringify({
  '1h': evalTrack('1h', req['1h']),
  '15m': evalTrack('15m', req['15m']),
}));
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


def cal_chrono_cv_auc(X_cal, y_cal, make_clf, sample_weight=None, n_folds=3):
    k = len(y_cal) // n_folds
    aucs = []
    for f in range(n_folds):
        va_slice = slice(f * k, (f + 1) * k if f < n_folds - 1 else len(y_cal))
        tr_mask = np.ones(len(y_cal), dtype=bool)
        tr_mask[va_slice] = False
        if len(np.unique(y_cal[tr_mask])) < 2 or len(np.unique(y_cal[va_slice])) < 2:
            continue
        pipe = Pipeline([
            ('imp', SimpleImputer(strategy='median', keep_empty_features=True)),
            ('sc', StandardScaler()),
            ('clf', make_clf()),
        ])
        fit_kw = {'clf__sample_weight': sample_weight[tr_mask]} if sample_weight is not None else {}
        pipe.fit(X_cal[tr_mask], y_cal[tr_mask], **fit_kw)
        p = pipe.predict_proba(X_cal[va_slice])[:, 1]
        aucs.append(float(roc_auc_score(y_cal[va_slice], p)))
    return float(np.mean(aucs)) if aucs else 0.5


def build_candidate_models(tf, track_data):
    all_features = track_data['featureNames']
    X_raw = np.array(
        [[np.nan if v is None else float(v) for v in s['vec']] for s in track_data['signals']],
        dtype=np.float64,
    )
    cal_rows = track_data['calSequential']
    val_rows = track_data['valSequential']
    y_cal = np.array([r['y'] for r in cal_rows], dtype=np.int64)
    w_mag = np.clip(np.array([abs(r['netPct']) for r in cal_rows], dtype=np.float64), 0.25, 4.0)
    y_val = np.array([r['y'] for r in val_rows], dtype=np.int64)
    net_val = np.array([r['netPct'] for r in val_rows], dtype=np.float64)

    candidates = []
    for sub_name, cols in FEATURE_SUBSETS[tf].items():
        col_idx = [all_features.index(c) for c in cols]
        X_sub = X_raw[:, col_idx]
        X_cal = np.array([X_sub[r['idx']] for r in cal_rows], dtype=np.float64)
        X_val = np.array([X_sub[r['idx']] for r in val_rows], dtype=np.float64)

        specs = []
        for c_val in [0.02, 0.05, 0.10, 0.25]:
            for w_name, sw in [('unw', None), ('mag', w_mag)]:
                specs.append((
                    f'{sub_name}:LR_C{c_val}_{w_name}',
                    'logistic_regression',
                    lambda c=c_val: LogisticRegression(C=c, max_iter=2000, random_state=42),
                    sw,
                ))
        for n_est in [8, 12]:
            specs.append((
                f'{sub_name}:GB_d1_n{n_est}',
                'gradient_boosting',
                lambda n=n_est: GradientBoostingClassifier(
                    max_depth=1, n_estimators=n, learning_rate=0.04,
                    min_samples_leaf=14, subsample=0.8, random_state=42,
                ),
                None,
            ))

        for name, mtype, make_clf, sw in specs:
            cv_auc = cal_chrono_cv_auc(X_cal, y_cal, make_clf, sample_weight=sw)
            pipe = Pipeline([
                ('imp', SimpleImputer(strategy='median', keep_empty_features=True)),
                ('sc', StandardScaler()),
                ('clf', make_clf()),
            ])
            fit_kw = {'clf__sample_weight': sw} if sw is not None else {}
            pipe.fit(X_cal, y_cal, **fit_kw)
            p_cal = pipe.predict_proba(X_cal)[:, 1]
            p_val = pipe.predict_proba(X_val)[:, 1]
            in_auc = float(roc_auc_score(y_cal, p_cal))
            val_auc = float(roc_auc_score(y_val, p_val))
            val_corr = float(np.corrcoef(p_val, net_val)[0, 1]) if np.std(p_val) > 1e-12 else 0.0

            # Strict anti-overfitting & genuine Val rank-ordering gate
            if cv_auc < 0.52 or val_auc < 0.57 or val_corr <= 0.05:
                continue

            probs = pipe.predict_proba(X_sub)[:, 1].tolist()
            candidates.append({
                'id': f'seq:{name}',
                'name': name,
                'mtype': mtype,
                'featureNames': cols,
                'pipe': pipe,
                'probs': probs,
                'cvAuc': round(cv_auc, 4),
                'inAuc': round(in_auc, 4),
                'valAuc': round(val_auc, 4),
                'valCorrNet': round(val_corr, 4),
            })

    return candidates


def select_best_on_val(tf, track_data):
    candidates = build_candidate_models(tf, track_data)
    val_indices = [i for i, s in enumerate(track_data['signals']) if track_data['calEnd'] <= s['barIndex'] < track_data['valEnd']]

    eval_items = []
    lookup = {}
    quantiles = [0.05, 0.10, 0.15, 0.20] if tf == '1h' else [0.10, 0.15, 0.20, 0.25, 0.30]

    for m in candidates:
        val_probs = np.array([m['probs'][i] for i in val_indices], dtype=np.float64)
        p90 = float(np.round(np.quantile(val_probs, 0.90), 4))
        size_curves = [
            {'mode': 'flat'},
            {'mode': 'linear', 'minMult': 0.80, 'maxMult': 1.35, 'pMax': p90},
            {'mode': 'linear', 'minMult': 0.85, 'maxMult': 1.45, 'pMax': p90},
        ]
        qs = np.unique(np.round(np.quantile(val_probs, quantiles), 4))
        for tau in qs:
            for sc in size_curves:
                if sc['mode'] == 'linear' and sc['pMax'] <= tau + 1e-4:
                    continue
                eid = f"{m['id']}|t={tau:.4f}|sc={sc['mode']}_{sc.get('minMult',1)}_{sc.get('maxMult',1)}"
                eval_items.append({
                    'id': eid,
                    'probs': m['probs'],
                    'threshold': float(tau),
                    'sizeCurve': sc,
                })
                lookup[eid] = (m, float(tau), sc)

    return candidates, eval_items, lookup


def main():
    raw_json = subprocess.check_output(
        ['node', '--input-type=module', '-e', NODE_EXTRACT_SCRIPT],
        cwd=ROOT_DIR,
        text=True,
    )
    data = json.loads(raw_json)

    eval_req = {}
    lookups = {}
    for tf in ['1h', '15m']:
        cands, eval_items, lookup = select_best_on_val(tf, data[tf])
        eval_req[tf] = eval_items
        lookups[tf] = lookup
        print(f"[{tf}] Cal seq n={len(data[tf]['calSequential'])}; Val-AUC-gated models={len(cands)}: {[(c['name'], c['cvAuc'], c['valAuc'], c['valCorrNet']) for c in cands[:6]]}")
        print(f"[{tf}] Val baseline={data[tf]['baseVal']}; eval grid={len(eval_items)}")

    eval_out_raw = subprocess.check_output(
        ['node', '--input-type=module', '-e', NODE_EVAL_VAL_SCRIPT],
        cwd=ROOT_DIR,
        input=json.dumps(eval_req),
        text=True,
    )
    eval_out = json.loads(eval_out_raw)

    exported_models = {}
    for tf in ['1h', '15m']:
        base_val = data[tf]['baseVal']
        min_val_count = 60 if tf == '1h' else 100
        scored = []
        for res in eval_out[tf]:
            v = res['val']
            m_obj, tau, sc = lookups[tf][res['id']]
            eligible = (
                v['count'] >= min_val_count
                and v['winRatePct'] > base_val['winRatePct']
                and v['profitFactor'] > base_val['profitFactor']
                and v['compoundedNetPct'] >= base_val['compoundedNetPct']
                and v['retToDd'] > base_val['retToDd']
            )
            score = (
                (10000.0 if eligible else 0.0)
                + v['compoundedNetPct']
                + 25.0 * v['retToDd']
                + 50.0 * (v['profitFactor'] - 1.0)
                + 3.0 * (v['winRatePct'] - base_val['winRatePct'])
                + 150.0 * (m_obj['valAuc'] - 0.5)
            )
            scored.append((score, eligible, res))
        scored.sort(key=lambda x: x[0], reverse=True)

        best_score, best_elig, best_res = scored[0]
        m_obj, tau, sc = lookups[tf][best_res['id']]
        print(f"\n[{tf}] Best Val(Y2) selected: {best_res['id']} (eligible={best_elig}, score={best_score:.2f}, cvAuc={m_obj['cvAuc']}, valAuc={m_obj['valAuc']}, valCorr={m_obj['valCorrNet']})")
        print(f"      Base Val : {base_val}")
        print(f"      ML   Val : {best_res['val']}")

        model_spec = export_pipeline_spec(m_obj['pipe'], m_obj['mtype'], m_obj['featureNames'], tau, sc)
        model_spec['selectionMeta'] = {
            'selectedId': best_res['id'],
            'labelSet': 'seq',
            'calCvAuc': m_obj['cvAuc'],
            'calInAuc': m_obj['inAuc'],
            'valRocAuc': m_obj['valAuc'],
            'valCorrNet': m_obj['valCorrNet'],
            'calRange': [0, data[tf]['calEnd']],
            'valRange': [data[tf]['calEnd'], data[tf]['valEnd']],
            'holdoutRangeUntouched': [data[tf]['valEnd'], data[tf]['totalBarsFull']],
            'calTrainSamples': len(data[tf]['calSequential']),
            'eligibleOnVal': best_elig,
            'valBaseline': base_val,
            'valSelected': best_res['val'],
        }
        exported_models[tf] = model_spec

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    artifact = {
        'schema': 'smc-v5-btc-ml-models-v1',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'antiLeakageProtocol': {
            'splitRule': 'Chrono 1/3 Cal (Y1), 1/3 Val (Y2), 1/3 Blind Holdout (Y3)',
            'purging': 'Purged all Cal/Val boundary-overlapping trades',
            'fitScope': 'Imputer + StandardScaler + parsimonious Classifier (2-6 stationary features) fit strictly on Cal (Y1) sequential trades; gated by Cal inner-CV AUC >= 0.52 and Val ROC-AUC >= 0.57; threshold tau & sizeCurve selected strictly on Val (Y2); Holdout Y3 never accessed by trainer',
        },
        'models': exported_models,
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(artifact, f, indent=2)
    print(f"\n[train_ml_v5] Saved {os.path.relpath(OUT_PATH, ROOT_DIR)}")


if __name__ == '__main__':
    main()
