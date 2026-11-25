#!/usr/bin/env python3
"""
Purged Anti-Leakage ML Meta-Labeling Trainer for 3 Dedicated US Stock Index Strategies (v6.0):
  - SPY (S&P 500)
  - DIA (Dow Jones)
  - QQQ (Nasdaq 100)

Strict Chronological Anti-Leakage Protocol:
  - Cal = first 50% (~5Y) -> [0 .. floor(0.5 * N))
  - Val = next 30% (~3Y incl. 2022 bear market) -> [floor(0.5 * N) .. floor(0.8 * N))
  - Blind Holdout = final 20% (~2Y) -> [floor(0.8 * N) .. N)  [NEVER accessed by trainer!]
"""

import json
import os
import subprocess
from datetime import datetime, timezone
import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT_MODELS_PATH = os.path.join(ROOT_DIR, 'research', 'results_v6', 'models_stocks_v6.json')

FEATURE_SUBSETS = {
    'SPY': {
        'ibs_rsi_vix': ['ibs_dir', 'rsi2_dir', 'vix_ratio_20', 'dist_sma200_atr'],
        'ibs_macro': ['ibs_dir', 'vix_level', 'vix_chg_5d', 'dist_sma50_atr'],
        'regime_vol': ['rsi2_dir', 'rv_ratio_10_60', 'vix_ratio_20', 'wk_ema20_dist_atr'],
        'core_mr': ['ibs_dir', 'rsi2_dir', 'ret_3d_dir_atr', 'atr_pct'],
        'full_compact': ['ibs_dir', 'rsi2_dir', 'vix_ratio_20', 'tnx_chg_5d', 'dist_sma200_atr'],
    },
    'DIA': {
        'rot_mr_macro': ['ibs_dir', 'rsi2_dir', 'dia_qqq_rot_z20', 'tnx_chg_5d'],
        'rot_vix': ['ibs_dir', 'dia_qqq_rot_z20', 'dia_qqq_rot_z60', 'vix_ratio_20'],
        'value_regime': ['rsi2_dir', 'dist_sma200_atr', 'vix_level', 'tnx_z20'],
        'core_mr': ['ibs_dir', 'rsi2_dir', 'ret_3d_dir_atr', 'atr_pct'],
        'full_compact': ['ibs_dir', 'rsi2_dir', 'dia_qqq_rot_z20', 'vix_ratio_20', 'tnx_z20'],
    },
    'QQQ': {
        'tech_macro_guard': ['ibs_dir', 'rsi2_dir', 'tnx_chg_5d', 'vix_ratio_20'],
        'tech_vol_mom': ['rsi2_dir', 'rv_ratio_10_60', 'dist_ema20_atr', 'tnx_z20'],
        'tech_regime': ['ibs_dir', 'dist_sma200_atr', 'vix_chg_5d', 'tnx_chg_5d'],
        'core_mr': ['ibs_dir', 'rsi2_dir', 'ret_3d_dir_atr', 'wk_ema20_dist_atr'],
        'full_compact': ['ibs_dir', 'rsi2_dir', 'rv_ratio_10_60', 'tnx_chg_5d', 'vix_ratio_20'],
    },
}


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
    if k < 10:
        return 0.5
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


def build_candidate_models(asset, track_data):
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
    fallback_candidates = []
    for sub_name, cols in FEATURE_SUBSETS[asset].items():
        col_idx = [all_features.index(c) for c in cols]
        X_sub = X_raw[:, col_idx]
        X_cal = np.array([X_sub[r['idx']] for r in cal_rows], dtype=np.float64)
        X_val = np.array([X_sub[r['idx']] for r in val_rows], dtype=np.float64)

        specs = []
        for c_val in [0.02, 0.05, 0.15, 0.40]:
            for w_name, sw in [('unw', None), ('mag', w_mag)]:
                specs.append((
                    f'{sub_name}:LR_C{c_val}_{w_name}',
                    'logistic_regression',
                    lambda c=c_val: LogisticRegression(C=c, max_iter=2000, random_state=42),
                    sw,
                ))
        for n_est in [8, 14]:
            specs.append((
                f'{sub_name}:GB_d1_n{n_est}',
                'gradient_boosting',
                lambda n=n_est: GradientBoostingClassifier(
                    max_depth=1, n_estimators=n, learning_rate=0.05,
                    min_samples_leaf=10, subsample=0.8, random_state=42,
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
            in_auc = float(roc_auc_score(y_cal, p_cal)) if len(np.unique(y_cal)) > 1 else 0.5
            val_auc = float(roc_auc_score(y_val, p_val)) if len(np.unique(y_val)) > 1 else 0.5
            val_corr = float(np.corrcoef(p_val, net_val)[0, 1]) if np.std(p_val) > 1e-12 else 0.0

            probs = pipe.predict_proba(X_sub)[:, 1].tolist()
            entry = {
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
            }
            fallback_candidates.append(entry)
            if cv_auc >= 0.51 and val_auc >= 0.53 and val_corr > 0.0:
                candidates.append(entry)

    if not candidates:
        fallback_candidates.sort(key=lambda c: (c['valAuc'], c['cvAuc']), reverse=True)
        return fallback_candidates[:6]
    candidates.sort(key=lambda c: (c['valAuc'] + 0.5 * c['cvAuc']), reverse=True)
    return candidates[:12]


def build_val_eval_grid(track_data, candidates):
    val_indices = [
        i for i, s in enumerate(track_data['signals'])
        if track_data['calEnd'] <= s['barIndex'] < track_data['valEnd']
    ]
    eval_items = []
    lookup = {}
    quantiles = [0.0, 0.05, 0.10, 0.15, 0.25]

    for m in candidates:
        val_probs = np.array([m['probs'][i] for i in val_indices], dtype=np.float64)
        p90 = float(np.round(np.quantile(val_probs, 0.90), 4))
        size_curves = [
            {'mode': 'flat'},
            {'mode': 'linear', 'minMult': 0.80, 'maxMult': 1.35, 'pMax': p90},
            {'mode': 'linear', 'minMult': 0.75, 'maxMult': 1.50, 'pMax': p90},
        ]
        qs = [0.0] + [float(q) for q in np.unique(np.round(np.quantile(val_probs, quantiles[1:]), 4))]
        for tau in qs:
            for sc in size_curves:
                if sc['mode'] == 'linear' and sc['pMax'] <= tau + 1e-4:
                    continue
                eid = f"{m['id']}|t={tau:.4f}|sc={sc['mode']}_{sc.get('minMult', 1)}_{sc.get('maxMult', 1)}"
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
        ['node', 'research/suite_v6_stocks.mjs', '--extract-cv'],
        cwd=ROOT_DIR,
        text=True,
    )
    data = json.loads(raw_json)

    eval_req = {}
    lookups = {}
    cands_by_asset = {}
    for asset in ['SPY', 'DIA', 'QQQ']:
        track_data = data[asset]
        cands = build_candidate_models(asset, track_data)
        cands_by_asset[asset] = cands
        eval_items, lookup = build_val_eval_grid(track_data, cands)
        eval_req[asset] = eval_items
        lookups[asset] = lookup
        print(
            f"[{asset}] Cal n={len(track_data['calSequential'])}, Val n={len(track_data['valSequential'])}; "
            f"Top cands={[(c['name'], c['cvAuc'], c['valAuc'], c['valCorrNet']) for c in cands[:4]]}"
        )

    eval_out_raw = subprocess.check_output(
        ['node', 'research/suite_v6_stocks.mjs', '--eval-val'],
        cwd=ROOT_DIR,
        input=json.dumps(eval_req),
        text=True,
    )
    eval_out = json.loads(eval_out_raw)

    exported_models = {}
    for asset in ['SPY', 'DIA', 'QQQ']:
        track_data = data[asset]
        base_val = track_data['baseVal']
        min_val_count = max(20, int(base_val['count'] * 0.70))
        scored = []
        for res in eval_out[asset]:
            v = res['val']
            m_obj, tau, sc = lookups[asset][res['id']]
            eligible = (
                v['count'] >= min_val_count
                and v['winRatePct'] >= max(65.0, base_val['winRatePct'] - 0.5)
                and v['profitFactor'] >= base_val['profitFactor']
                and v['compoundedNetPct'] >= base_val['compoundedNetPct'] * 0.95
            )
            score = (
                (10000.0 if eligible else 0.0)
                + (v.get('calmar', 0.0) or 0.0) * 40.0
                + (v.get('sharpe', 0.0) or 0.0) * 30.0
                + (v['winRatePct'] - 65.0) * 2.5
                + ((v['profitFactor'] or 1.0) - 1.0) * 30.0
                + v['compoundedNetPct'] * 0.5
                + (m_obj['valAuc'] - 0.5) * 100.0
            )
            scored.append((score, eligible, res))
        scored.sort(key=lambda x: x[0], reverse=True)

        best_score, best_elig, best_res = scored[0]
        m_obj, tau, sc = lookups[asset][best_res['id']]
        print(
            f"\n[{asset}] Selected Val model: {best_res['id']} (eligible={best_elig}, score={best_score:.2f}, "
            f"cvAuc={m_obj['cvAuc']}, valAuc={m_obj['valAuc']}, valCorr={m_obj['valCorrNet']})"
        )
        print(f"      Base Val : {base_val}")
        print(f"      ML   Val : {best_res['val']}")

        model_spec = export_pipeline_spec(m_obj['pipe'], m_obj['mtype'], m_obj['featureNames'], tau, sc)
        model_spec['asset'] = asset
        model_spec['symbol'] = track_data['symbol']
        model_spec['benchmarkSymbol'] = track_data['benchmarkSymbol']
        model_spec['signalSpec'] = track_data['signalSpec']
        model_spec['execOptions'] = track_data['execOptions']
        model_spec['selectionMeta'] = {
            'selectedId': best_res['id'],
            'calCvAuc': m_obj['cvAuc'],
            'calInAuc': m_obj['inAuc'],
            'valRocAuc': m_obj['valAuc'],
            'valCorrNet': m_obj['valCorrNet'],
            'calRange': [0, track_data['calEnd']],
            'valRange': [track_data['calEnd'], track_data['valEnd']],
            'holdoutRangeUntouched': [track_data['valEnd'], track_data['totalBarsFull']],
            'calTrainSamples': len(track_data['calSequential']),
            'valEvalSamples': len(track_data['valSequential']),
            'eligibleOnVal': best_elig,
            'valBaseline': base_val,
            'valSelected': best_res['val'],
        }
        exported_models[asset] = model_spec

    os.makedirs(os.path.dirname(OUT_MODELS_PATH), exist_ok=True)
    artifact = {
        'schema': 'smc-v6-stocks-ml-models-v1',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'antiLeakageProtocol': {
            'splitRule': 'Chrono 50% Cal (~5Y), 30% Val (~3Y incl. 2022 bear market), 20% Blind Holdout (~2Y)',
            'purging': 'Purged all Cal/Val boundary-overlapping trades (exitIndex < calEnd for Cal, signalIndex >= calEnd && exitIndex < valEnd for Val)',
            'fitScope': 'Structural parameters calibrated on Cal+Val only; SimpleImputer + StandardScaler + Classifier fit strictly on Cal purged sequential trades; threshold tau & sizeCurve selected strictly on Val; Blind Holdout [valEnd..N) never accessed by trainer',
        },
        'models': exported_models,
    }
    with open(OUT_MODELS_PATH, 'w', encoding='utf-8') as f:
        json.dump(artifact, f, indent=2)
    print(f"\n[train_v6_stocks] Saved {os.path.relpath(OUT_MODELS_PATH, ROOT_DIR)}")


if __name__ == '__main__':
    main()
