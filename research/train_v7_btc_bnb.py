#!/usr/bin/env python3
"""
Strict anti-leakage v7.0 High-WR (>= 75%) 5-Year ML meta-labeling trainer
for BTC_1h, BTC_15m, BNB_1h, and BNB_15m.

Chronological split:
  - Cal = [0 .. 50%)
  - Val = [50% .. 80%)
  - Blind Holdout Y5 = [80% .. 100%) [NEVER loaded or accessed by trainer!]
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
OUT_PATH = os.path.join(ROOT_DIR, 'research', 'results_v7', 'models_v7_btc_bnb.json')

STREAM_KEYS = ['BTC_1h', 'BTC_15m', 'BNB_1h', 'BNB_15m']

FEATURE_SUBSETS = {
    'BTC_1h': {
        'of_cvd_fund': ['delta_ratio_1b', 'cvd_zscore_48', 'close_pos_dir', 'funding_dir_align'],
        'htf_streak': ['h4_ema20_dist_atr', 'ret_48_dir_atr', 'recent_dir_sl_streak'],
        'of_htf_core': ['delta_ratio_1b', 'cvd_imb_24b', 'h4_ema20_dist_atr', 'funding_dir_align'],
    },
    'BTC_15m': {
        'wick_adv_only': ['wick_adv_atr'],
        'wick_delta_15m': ['wick_adv_atr', 'delta_ratio_1b'],
        'of_micro_15m': ['wick_adv_atr', 'close_pos_dir', 'delta_ratio_1b', 'cvd_imb_6b'],
        'wick_vol_15m': ['wick_adv_atr', 'wick_opp_atr', 'atr_ratio_50', 'cvd_zscore_48'],
        'trend_of_15m': ['h4_ema20_dist_atr', 'h1_ema50_dist_atr', 'delta_ratio_1b', 'funding_dir_align'],
    },
    'BNB_1h': {
        'bnb_ltf_vol': ['ltf_ema50_dist_atr', 'ltf_ema50_slope_atr', 'atr_pct'],
        'bnb_wick_fund': ['wick_adv_atr', 'funding_ma3_dir', 'delta_ratio_1b'],
        'bnb_trend_vol_fund': ['ltf_ema50_slope_atr', 'atr_pct', 'ret_12_dir_atr', 'funding_ma3_dir'],
        'bnb_launchpool_of': ['launchpool_squeeze_flag', 'cvd_imb_24b', 'ltf_ema50_slope_atr', 'funding_ma3_dir'],
        'bnb_of_micro': ['delta_ratio_1b', 'cvd_zscore_48', 'wick_adv_atr', 'ret_12_dir_atr'],
    },
    'BNB_15m': {
        'wick_adv_only': ['wick_adv_atr'],
        'wick_delta_15m': ['wick_adv_atr', 'delta_ratio_1b'],
        'bnb_of_micro_15m': ['wick_adv_atr', 'delta_ratio_1b', 'cvd_imb_6b', 'ltf_ema50_slope_atr'],
        'bnb_lp_15m': ['launchpool_squeeze_flag', 'funding_dir_align', 'wick_adv_atr', 'atr_ratio_50'],
        'bnb_trend_15m': ['h4_ema20_dist_atr', 'ret_12_dir_atr', 'delta_ratio_1b', 'cvd_zscore_48'],
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


def train_stream(stream_key, track_data):
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
    for sub_name, cols in FEATURE_SUBSETS[stream_key].items():
        col_idx = [all_features.index(c) for c in cols]
        X_sub = X_raw[:, col_idx]
        X_cal = np.array([X_sub[r['idx']] for r in cal_rows], dtype=np.float64)
        X_val = np.array([X_sub[r['idx']] for r in val_rows], dtype=np.float64)

        specs = []
        for c_val in [0.02, 0.05, 0.15]:
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
                    max_depth=1, n_estimators=n, learning_rate=0.04,
                    min_samples_leaf=16, subsample=0.8, random_state=42,
                ),
                None,
            ))

        all_evaluated = []
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
            in_auc = float(roc_auc_score(y_cal, p_cal)) if len(np.unique(y_cal)) == 2 else 0.5
            val_auc = float(roc_auc_score(y_val, p_val)) if len(np.unique(y_val)) == 2 else 0.5
            val_corr = float(np.corrcoef(p_val, net_val)[0, 1]) if np.std(p_val) > 1e-12 else 0.0
            rec = {
                'id': f'seq:{name}',
                'name': name,
                'mtype': mtype,
                'featureNames': cols,
                'pipe': pipe,
                'probs': pipe.predict_proba(X_sub)[:, 1].tolist(),
                'cvAuc': round(cv_auc, 4),
                'inAuc': round(in_auc, 4),
                'valAuc': round(val_auc, 4),
                'valCorrNet': round(val_corr, 4),
            }
            all_evaluated.append(rec)
            if cv_auc < 0.505 or val_auc < 0.520 or (in_auc - cv_auc) > 0.22:
                continue
            candidates.append(rec)

    if not candidates:
        all_evaluated.sort(key=lambda r: (r['valAuc'] + 0.5 * r['cvAuc']), reverse=True)
        candidates.extend(all_evaluated[:3])

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
        qs = np.unique(np.round(np.quantile(val_probs, [0.0, 0.10, 0.20, 0.30]), 4))
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
        ['node', 'research/high_wr_v7_btc_bnb.mjs', '--extract-cal-val'],
        cwd=ROOT_DIR,
        text=True,
    )
    data = json.loads(raw_json)

    eval_req = {}
    lookups = {}
    for sk in STREAM_KEYS:
        cands, eval_items, lookup = train_stream(sk, data[sk])
        eval_req[sk] = {'structuralSpec': data[sk]['structuralSpec'], 'items': eval_items}
        lookups[sk] = lookup
        print(f"[{sk}] Structural={data[sk]['structuralSpec']['id']} | Cal n={len(data[sk]['calSequential'])}, Val n={len(data[sk]['valSequential'])}, gated={len(cands)}, grid={len(eval_items)}")
        print(f"[{sk}] Base Val: count={data[sk]['baseVal']['count']} WR={data[sk]['baseVal']['winRatePct']}% PF={data[sk]['baseVal']['profitFactor']} Mo={data[sk]['baseVal']['meanMonthlySweepPct']}%")

    eval_out_raw = subprocess.check_output(
        ['node', 'research/high_wr_v7_btc_bnb.mjs', '--eval-val'],
        cwd=ROOT_DIR,
        input=json.dumps(eval_req),
        text=True,
    )
    eval_out = json.loads(eval_out_raw)

    exported = {}
    for sk in STREAM_KEYS:
        bv = data[sk]['baseVal']
        min_val_count = max(45, int(0.55 * bv['count']))
        scored = []
        for res in eval_out[sk]:
            v = res['val']
            m_obj, tau, sc = lookups[sk][res['id']]
            wr = v['winRatePct'] or 0.0
            pf = v['profitFactor'] or 0.0
            mo = v['meanMonthlySweepPct'] or 0.0
            eligible = (
                v['count'] >= min_val_count
                and wr >= 75.0
                and pf >= 1.25
                and v['compoundedNetPct'] > 0
                and v['liquidationCount'] == 0
            )
            high_target = eligible and wr >= 76.0 and pf >= 1.35
            score = (
                (10000.0 if eligible else 0.0)
                + (1500.0 if high_target else 0.0)
                + mo * 30.0
                + pf * 50.0
                + (wr - 75.0) * 3.0
                + (m_obj['valAuc'] - 0.5) * 120.0
            )
            scored.append((score, eligible, res))
        scored.sort(key=lambda x: x[0], reverse=True)

        best_score, best_elig, best_res = scored[0]
        m_obj, tau, sc = lookups[sk][best_res['id']]
        v = best_res['val']
        print(f"\n[{sk}] Selected on Val: {best_res['id']} (eligible={best_elig}, cvAuc={m_obj['cvAuc']}, valAuc={m_obj['valAuc']})")
        print(f"      ML Val: n={v['count']} WR={v['winRatePct']}% PF={v['profitFactor']} Comp={v['compoundedNetPct']}% Mo={v['meanMonthlySweepPct']}% DD={v['maxCompoundedDdPct']}%")

        model_spec = export_pipeline_spec(m_obj['pipe'], m_obj['mtype'], m_obj['featureNames'], tau, sc)
        model_spec['structuralSpec'] = data[sk]['structuralSpec']
        model_spec['selectionMeta'] = {
            'selectedId': best_res['id'],
            'calCvAuc': m_obj['cvAuc'],
            'calInAuc': m_obj['inAuc'],
            'valRocAuc': m_obj['valAuc'],
            'valCorrNet': m_obj['valCorrNet'],
            'calRange': [0, data[sk]['calEnd']],
            'valRange': [data[sk]['calEnd'], data[sk]['valEnd']],
            'holdoutRangeUntouched': [data[sk]['valEnd'], data[sk]['totalBarsFull']],
            'calTrainSamples': len(data[sk]['calSequential']),
            'eligibleOnVal': best_elig,
            'valBaseline': bv,
            'valSelected': {k: val for k, val in v.items() if k != 'monthlyTable'},
        }
        exported[sk] = model_spec

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    artifact = {
        'schema': 'smc-v7-btc-bnb-5y-models-v1',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'antiLeakageProtocol': {
            'splitRule': 'Chrono 50% Cal, 30% Val, 20% Blind Holdout Y5',
            'purging': 'Purged boundary-overlapping trades at calEnd and valEnd',
            'fitScope': 'Structural & ML fit strictly on Cal/Val; Y5 Holdout untouched by trainer',
        },
        'models': exported,
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(artifact, f, indent=2)
    print(f"\n[train_v7_btc_bnb] Saved {os.path.relpath(OUT_PATH, ROOT_DIR)}")


if __name__ == '__main__':
    main()
