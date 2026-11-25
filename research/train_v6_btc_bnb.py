#!/usr/bin/env python3
"""
Strict anti-leakage 5-Year ML meta-labeling trainer for BTCUSDT and BNBUSDT (v6.0).

Chronological 5Y split:
  - Cal (Y1..2.5) = [0 .. floor(0.50 * N))   [includes 2022 bear market]
  - Val (Y2.5..4) = [floor(0.50 * N) .. floor(0.80 * N))
  - Blind Holdout Y5 = [floor(0.80 * N) .. N) [NEVER loaded or touched by trainer!]

Workflow:
  1. Structural signal & execution config calibrated strictly on Cal+Val [0..valEnd)
     via Node helper in research/suite_v6_btc_bnb.mjs.
  2. Parsimonious stationary feature subsets (MTF EMAs/slopes, 5Y Orderflow CVD /
     Taker Buy Ratio, 8h Funding Crowding, BNB Launchpool Negative-Funding Squeeze,
     microstructure & causal SL momentum) extracted strictly up to valEnd.
  3. Models fit ONLY on purged Cal [0..calEnd); gated by 3-fold Cal inner CV AUC and
     Val ROC-AUC; threshold tau & Val-p90 linear sizeCurve locked strictly on Val.
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
OUT_PATH = os.path.join(ROOT_DIR, 'research', 'results_v6', 'models_btc_bnb_5y.json')

FEATURE_SUBSETS = {
    'BTCUSDT': {
        'of_cvd_fund': [
            'delta_ratio_1b',
            'cvd_zscore_48',
            'close_pos_dir',
            'funding_dir_align',
        ],
        'of_cvd_3': [
            'delta_ratio_1b',
            'cvd_zscore_48',
            'close_pos_dir',
        ],
        'of_cvd_2': [
            'delta_ratio_1b',
            'close_pos_dir',
        ],
        'of_htf_fund': [
            'h4_ema20_dist_atr',
            'ret_48_dir_atr',
            'recent_dir_sl_streak',
            'cvd_imb_24b',
            'funding_dir_align',
        ],
    },
    'BNBUSDT': {
        'bnb_trend_vol_fund': [
            'ltf_ema50_slope_atr',
            'atr_pct',
            'ret_12_dir_atr',
            'funding_ma3_dir',
        ],
        'bnb_launchpool_trend': [
            'ltf_ema50_slope_atr',
            'atr_pct',
            'ret_12_dir_atr',
            'funding_ma3_dir',
            'launchpool_squeeze_flag',
        ],
        'bnb_trend_of': [
            'ltf_ema50_slope_atr',
            'ltf_ema50_dist_atr',
            'atr_pct',
            'delta_ratio_1b',
            'funding_ma3_dir',
        ],
        'launchpool_of_sweep': [
            'launchpool_squeeze_score',
            'neg_funding_depth_bps',
            'cvd_imb_6b',
            'cvd_imb_24b',
            'wick_adv_atr',
            'h4_ema20_dist_atr',
        ],
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


def train_symbol(sym, track_data):
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
    for sub_name, cols in FEATURE_SUBSETS[sym].items():
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
        for max_depth in [1]:
            for n_est in [10, 16]:
                specs.append((
                    f'{sub_name}:GB_d{max_depth}_n{n_est}',
                    'gradient_boosting',
                    lambda md=max_depth, n=n_est: GradientBoostingClassifier(
                        max_depth=md, n_estimators=n, learning_rate=0.04,
                        min_samples_leaf=16, subsample=0.8, random_state=42,
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
            overfit_gap = in_auc - cv_auc

            if cv_auc < 0.52 or val_auc < 0.54 or overfit_gap > 0.25:
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

    # Fallback to most regularized LR if gate yields empty
    if not candidates:
        cols = list(FEATURE_SUBSETS[sym].values())[0]
        col_idx = [all_features.index(c) for c in cols]
        X_sub = X_raw[:, col_idx]
        X_cal = np.array([X_sub[r['idx']] for r in cal_rows], dtype=np.float64)
        X_val = np.array([X_sub[r['idx']] for r in val_rows], dtype=np.float64)
        make_clf = lambda: LogisticRegression(C=0.05, max_iter=2000, random_state=42)
        pipe = Pipeline([('imp', SimpleImputer(strategy='median', keep_empty_features=True)), ('sc', StandardScaler()), ('clf', make_clf())])
        pipe.fit(X_cal, y_cal)
        p_val = pipe.predict_proba(X_val)[:, 1]
        candidates.append({
            'id': 'seq:fallback_LR_C0.05',
            'name': 'fallback_LR_C0.05',
            'mtype': 'logistic_regression',
            'featureNames': cols,
            'pipe': pipe,
            'probs': pipe.predict_proba(X_sub)[:, 1].tolist(),
            'cvAuc': round(cal_chrono_cv_auc(X_cal, y_cal, make_clf), 4),
            'inAuc': round(float(roc_auc_score(y_cal, pipe.predict_proba(X_cal)[:, 1])), 4),
            'valAuc': round(float(roc_auc_score(y_val, p_val)), 4),
            'valCorrNet': round(float(np.corrcoef(p_val, net_val)[0, 1]) if np.std(p_val) > 1e-12 else 0.0, 4),
        })

    val_indices = [i for i, s in enumerate(track_data['signals']) if track_data['calEnd'] <= s['barIndex'] < track_data['valEnd']]
    eval_items = []
    lookup = {}
    for m in candidates:
        val_probs = np.array([m['probs'][i] for i in val_indices], dtype=np.float64)
        p90 = float(np.round(np.quantile(val_probs, 0.90), 4))
        size_curves = [
            {'mode': 'flat'},
            {'mode': 'linear', 'minMult': 0.85, 'maxMult': 1.40, 'pMax': p90},
        ]
        qs = np.unique(np.round(np.quantile(val_probs, [0.0, 0.08, 0.15, 0.22, 0.30]), 4))
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
        ['node', 'research/suite_v6_btc_bnb.mjs', '--extract-cal-val'],
        cwd=ROOT_DIR,
        text=True,
    )
    data = json.loads(raw_json)

    eval_req = {}
    lookups = {}
    for sym in ['BTCUSDT', 'BNBUSDT']:
        cands, eval_items, lookup = train_symbol(sym, data[sym])
        eval_req[sym] = {
            'structuralSpec': data[sym]['structuralSpec'],
            'items': eval_items,
        }
        lookups[sym] = lookup
        print(f"[{sym}] Structural: {data[sym]['structuralSpec']['id']}")
        print(f"[{sym}] Cal seq n={len(data[sym]['calSequential'])}; Val seq n={len(data[sym]['valSequential'])}; gated models={len(cands)}; eval grid={len(eval_items)}")
        print(f"[{sym}] Base Val: {data[sym]['baseVal']}")

    eval_out_raw = subprocess.check_output(
        ['node', 'research/suite_v6_btc_bnb.mjs', '--eval-val'],
        cwd=ROOT_DIR,
        input=json.dumps(eval_req),
        text=True,
    )
    eval_out = json.loads(eval_out_raw)

    exported = {}
    for sym in ['BTCUSDT', 'BNBUSDT']:
        base_val = data[sym]['baseVal']
        min_val_count = max(45, int(0.55 * base_val['count']))
        scored = []
        for res in eval_out[sym]:
            v = res['val']
            m_obj, tau, sc = lookups[sym][res['id']]
            eligible = (
                v['count'] >= min_val_count
                and v['winRatePct'] >= base_val['winRatePct']
                and v['profitFactor'] >= base_val['profitFactor']
                and v['compoundedNetPct'] >= base_val['compoundedNetPct'] * 0.95
            )
            score = (
                (10000.0 if eligible else 0.0)
                + v['compoundedNetPct']
                + 20.0 * v['calmar']
                + 50.0 * (v['profitFactor'] - 1.0)
                + 2.5 * (v['winRatePct'] - base_val['winRatePct'])
                + 120.0 * (m_obj['valAuc'] - 0.5)
            )
            scored.append((score, eligible, res))
        scored.sort(key=lambda x: x[0], reverse=True)

        best_score, best_elig, best_res = scored[0]
        m_obj, tau, sc = lookups[sym][best_res['id']]
        print(f"\n[{sym}] Selected on Val: {best_res['id']} (eligible={best_elig}, cvAuc={m_obj['cvAuc']}, valAuc={m_obj['valAuc']}, valCorr={m_obj['valCorrNet']})")
        print(f"      ML Val: {best_res['val']}")

        model_spec = export_pipeline_spec(m_obj['pipe'], m_obj['mtype'], m_obj['featureNames'], tau, sc)
        model_spec['structuralSpec'] = data[sym]['structuralSpec']
        model_spec['selectionMeta'] = {
            'selectedId': best_res['id'],
            'calCvAuc': m_obj['cvAuc'],
            'calInAuc': m_obj['inAuc'],
            'valRocAuc': m_obj['valAuc'],
            'valCorrNet': m_obj['valCorrNet'],
            'calRange': [0, data[sym]['calEnd']],
            'valRange': [data[sym]['calEnd'], data[sym]['valEnd']],
            'holdoutRangeUntouched': [data[sym]['valEnd'], data[sym]['totalBarsFull']],
            'calTrainSamples': len(data[sym]['calSequential']),
            'eligibleOnVal': best_elig,
            'valBaseline': base_val,
            'valSelected': best_res['val'],
        }
        exported[sym] = model_spec

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    artifact = {
        'schema': 'smc-v6-btc-bnb-5y-models-v1',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'antiLeakageProtocol': {
            'splitRule': 'Chrono 50% Cal (Y1..2.5 incl 2022 bear), 30% Val (Y2.5..4), 20% Blind Holdout Y5',
            'purging': 'Purged all boundary-overlapping trades at calEnd and valEnd',
            'fitScope': 'Structural selection on Cal+Val only; ML imputer+scaler+classifier fit strictly on Cal; model+threshold+sizeCurve selected strictly on Val; Blind Holdout Y5 never accessed by trainer',
        },
        'models': exported,
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(artifact, f, indent=2)
    print(f"\n[train_v6_btc_bnb] Saved {os.path.relpath(OUT_PATH, ROOT_DIR)}")


if __name__ == '__main__':
    main()
