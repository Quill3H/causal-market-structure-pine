import hashlib
import json
import math
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
RESULTS_V9_DIR = os.path.join(ROOT_DIR, 'research', 'results_v9')
STREAM_KEYS = ['BTC_1h', 'BNB_1h', 'SOL_1h', 'ETH_1h', 'BTC_15m', 'BNB_15m', 'SOL_15m', 'ETH_15m']

COMMON_SUBSETS = {
    'of_cvd_fund': ['delta_ratio_1b', 'cvd_zscore_48', 'close_pos_dir', 'funding_dir_align'],
    'regime_of': ['regime_trend_score', 'd1_ema50_dist_atr', 'delta_ratio_1b'],
    'wick_delta': ['wick_adv_atr', 'delta_ratio_1b', 'h4_rally_exh'],
    'htf_streak': ['h4_ema20_dist_atr', 'ret_48_dir_atr', 'recent_dir_sl_streak'],
    'wick_adv_only': ['wick_adv_atr'],
    'ltf_vol_fund': ['ltf_ema50_slope_atr', 'atr_pct', 'ret_12_dir_atr', 'funding_ma3_dir'],
}

ETH_EXTRA_SUBSETS = {
    **COMMON_SUBSETS,
    'eth_cross_rel': ['eth_btc_ema20_dist', 'eth_btc_ret_24h_dir', 'eth_btc_zscore_48', 'delta_ratio_1b'],
    'eth_cross_of': ['eth_btc_ema50_dist', 'eth_btc_residual_12h_dir', 'wick_adv_atr', 'cvd_zscore_48'],
}


def normalize_for_canon(val):
    if isinstance(val, dict):
        return {k: normalize_for_canon(v) for k, v in val.items()}
    if isinstance(val, list):
        return [normalize_for_canon(v) for v in val]
    if isinstance(val, float) and math.isfinite(val):
        if val.is_integer():
            return int(val)
        return int(round(val * 1e10))
    return val


def canonical_dumps(obj):
    return json.dumps(normalize_for_canon(obj), sort_keys=True, separators=(',', ':'))


def cal_chrono_cv_auc(X_cal, y_cal, make_clf, sample_weight=None, n_splits=3):
    n = len(y_cal)
    if n < 30 or len(np.unique(y_cal)) < 2:
        return 0.5
    fold_size = max(12, n // (n_splits + 1))
    aucs = []
    for k in range(1, n_splits + 1):
        tr_end = min(n - 10, fold_size * k)
        va_end = min(n, tr_end + fold_size)
        if tr_end < 15 or va_end - tr_end < 8:
            continue
        y_tr, y_va = y_cal[:tr_end], y_cal[tr_end:va_end]
        if len(np.unique(y_tr)) < 2 or len(np.unique(y_va)) < 2:
            continue
        pipe = Pipeline([
            ('imp', SimpleImputer(strategy='median', keep_empty_features=True)),
            ('sc', StandardScaler()),
            ('clf', make_clf()),
        ])
        fit_kw = {'clf__sample_weight': sample_weight[:tr_end]} if sample_weight is not None else {}
        pipe.fit(X_cal[:tr_end], y_tr, **fit_kw)
        p = pipe.predict_proba(X_cal[tr_end:va_end])[:, 1]
        aucs.append(float(roc_auc_score(y_va, p)))
    return float(np.mean(aucs)) if aucs else 0.5


def export_pipeline_spec(pipe, mtype, feature_names, threshold, size_curve):
    imp = pipe.named_steps['imp']
    sc = pipe.named_steps['sc']
    clf = pipe.named_steps['clf']

    spec = {
        'modelType': mtype,
        'featureNames': list(feature_names),
        'threshold': float(threshold),
        'sizeCurve': size_curve,
        'imputer': {
            'medians': [0.0 if (v is None or math.isnan(float(v))) else float(v) for v in imp.statistics_],
        },
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
        for est_row in clf.estimators_:
            tr = est_row[0].tree_
            trees.append({
                'childrenLeft': [int(v) for v in tr.children_left],
                'childrenRight': [int(v) for v in tr.children_right],
                'feature': [int(v) for v in tr.feature],
                'threshold': [float(v) for v in tr.threshold],
                'value': [float(v[0][0]) for v in tr.value],
            })
        prior = float(clf.init_.class_prior_[1])
        init_score = math.log(max(1e-12, prior) / max(1e-12, 1.0 - prior))
        spec['classifier'] = {
            'initScore': float(init_score),
            'learningRate': float(clf.learning_rate),
            'trees': trees,
        }
    else:
        raise ValueError(f'Unsupported mtype: {mtype}')
    return spec


def train_stream_v9(stream_key, track_data):
    all_features = track_data['featureNames']
    X_raw = np.array(
        [[np.nan if v is None else float(v) for v in s['features']] for s in track_data['signals']],
        dtype=np.float64,
    )
    cal_rows = track_data['calSequential']
    val_rows = track_data['valSequential']
    y_cal = np.array([r['y'] for r in cal_rows], dtype=np.int64)
    w_mag = np.clip(np.array([abs(r['netPct']) for r in cal_rows], dtype=np.float64), 0.25, 4.0)
    y_val = np.array([r['y'] for r in val_rows], dtype=np.int64)
    net_val = np.array([r['netPct'] for r in val_rows], dtype=np.float64)

    subsets = ETH_EXTRA_SUBSETS if stream_key.startswith('ETH') else COMMON_SUBSETS
    candidates = []
    all_evaluated = []

    for sub_name, cols in subsets.items():
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
        for n_est in [8, 12]:
            specs.append((
                f'{sub_name}:GB_d1_n{n_est}',
                'gradient_boosting',
                lambda n=n_est: GradientBoostingClassifier(
                    max_depth=1, n_estimators=n, learning_rate=0.04,
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
            in_auc = float(roc_auc_score(y_cal, p_cal)) if len(np.unique(y_cal)) == 2 else 0.5
            val_auc = float(roc_auc_score(y_val, p_val)) if len(np.unique(y_val)) == 2 else 0.5
            val_corr = float(np.corrcoef(p_val, net_val)[0, 1]) if np.std(p_val) > 1e-12 else 0.0
            rec = {
                'id': name,
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
        qs = np.unique(np.round(np.quantile(val_probs, [0.0, 0.10, 0.20, 0.30, 0.40]), 4))
        for tau in qs:
            for sc in size_curves:
                if sc['mode'] == 'linear' and sc['pMax'] <= tau + 1e-4:
                    continue
                eid = f"{m['id']}|t={tau:.4f}|sc={sc['mode']}_{sc.get('minMult',1)}_{sc.get('maxMult',1)}"
                eval_items.append({'id': eid, 'probs': m['probs'], 'threshold': float(tau), 'sizeCurve': sc})
                lookup[eid] = (m, float(tau), sc)

    return candidates, eval_items, lookup


def main():
    raw_json = subprocess.check_output(
        ['node', 'research/ensemble_v9_walkforward.mjs', '--extract-cal-val'],
        cwd=ROOT_DIR,
        text=True,
    )
    data = json.loads(raw_json)

    eval_req = {}
    lookups = {}
    for sk in STREAM_KEYS:
        cands, eval_items, lookup = train_stream_v9(sk, data[sk])
        eval_req[sk] = {'structuralSpec': data[sk]['structuralSpec'], 'items': eval_items}
        lookups[sk] = lookup
        d = data[sk]
        print(f"[{sk}] Struct={d['structuralSpec']['id']} | Cal={len(d['calSequential'])} Val={len(d['valSequential'])} | Base F1={d['baseF1']['profitFactor']:.2f} F2={d['baseF2']['profitFactor']:.2f} F3={d['baseF3']['profitFactor']:.2f} CV_WR={d['baseCV']['winRatePct']:.1f}%")

    eval_out_raw = subprocess.check_output(
        ['node', 'research/ensemble_v9_walkforward.mjs', '--eval-folds'],
        cwd=ROOT_DIR,
        input=json.dumps(eval_req),
        text=True,
    )
    eval_out = json.loads(eval_out_raw)

    exported = {}
    for sk in STREAM_KEYS:
        d = data[sk]
        min_cv_count = max(80, int(0.55 * d['baseCV']['count']))
        min_f3_count = max(25, int(0.50 * d['baseF3']['count']))
        scored = []
        for res in eval_out[sk]:
            f1, f2, f3, cv = res['f1'], res['f2'], res['f3'], res['cv']
            m_obj, tau, sc = lookups[sk][res['id']]
            f1_pf = f1['profitFactor'] or 0.0
            f2_pf = f2['profitFactor'] or 0.0
            f3_pf = f3['profitFactor'] or 0.0
            cv_wr = cv['winRatePct'] or 0.0
            cv_dd = max(1.0, cv['maxCompoundedDdPct'] or 100.0)
            calmar = (cv['compoundedNetPct'] or 0.0) / cv_dd

            passes_all_folds = (
                cv['count'] >= min_cv_count
                and f3['count'] >= min_f3_count
                and f1_pf >= 1.05
                and f2_pf >= 1.15
                and f3_pf >= 1.25
                and cv_wr >= 70.0
                and cv['liquidationCount'] == 0
            )
            worst_pf = min(f1_pf, f3_pf)
            # Maximize worst-fold risk-adjusted return (min(F1_PF, F3_PF) + Calmar) inside [0..80%)
            score = (
                (10000.0 if passes_all_folds else 0.0)
                + worst_pf * 120.0
                + calmar * 20.0
                + (f2_pf - 1.0) * 40.0
                + (m_obj['valAuc'] - 0.5) * 80.0
            )
            scored.append((score, passes_all_folds, res))

        scored.sort(key=lambda x: x[0], reverse=True)
        _, best_pass, best_res = scored[0]
        m_obj, tau, sc = lookups[sk][best_res['id']]
        f1, f2, f3, cv = best_res['f1'], best_res['f2'], best_res['f3'], best_res['cv']
        print(f"\n[{sk}] Selected={best_res['id']} (qualifiedCalVal={best_pass}, cvAuc={m_obj['cvAuc']}, valAuc={m_obj['valAuc']})")
        print(f"       F1={f1['profitFactor']:.2f}({f1['count']}) F2={f2['profitFactor']:.2f}({f2['count']}) F3={f3['profitFactor']:.2f}({f3['count']}) CV: n={cv['count']} WR={cv['winRatePct']:.1f}% PF={cv['profitFactor']:.2f} Comp={cv['compoundedNetPct']:.1f}% DD={cv['maxCompoundedDdPct']:.1f}%")

        spec = export_pipeline_spec(m_obj['pipe'], m_obj['mtype'], m_obj['featureNames'], tau, sc)
        spec['structuralSpec'] = d['structuralSpec']
        spec['selectionMeta'] = {
            'selectedId': best_res['id'],
            'calCvAuc': m_obj['cvAuc'],
            'calInAuc': m_obj['inAuc'],
            'valRocAuc': m_obj['valAuc'],
            'valCorrNet': m_obj['valCorrNet'],
            'f1Range': [0, d['f1End']],
            'f2Range': [d['f1End'], d['calEnd']],
            'f3Range': [d['calEnd'], d['valEnd']],
            'holdoutRangeUntouched': [d['valEnd'], d['totalBarsFull']],
            'calTrainSamples': len(d['calSequential']),
            'qualifiedOnCalValFolds': best_pass,
            'shortEnabled': d['structuralSpec']['sigSpec'].get('shortEnabled', True),
            'foldSelected': {'f1': f1, 'f2': f2, 'f3': f3, 'cv': cv},
        }
        exported[sk] = spec

    os.makedirs(RESULTS_V9_DIR, exist_ok=True)
    lock_sha = hashlib.sha256(canonical_dumps(exported).encode('utf-8')).hexdigest()
    out_path = os.path.join(RESULTS_V9_DIR, 'models_v9_crypto.json')
    with open(out_path, 'w') as f:
        json.dump({
            'schema': 'smc-v9-crypto-5y-models-v1',
            'generatedAt': datetime.now(timezone.utc).isoformat(),
            'selectionLockSha256': lock_sha,
            'antiLeakageProtocol': {
                'splitRule': 'Walk-Forward inside [0..80%): F1_Bear2022 [0..20%), F2_Recov2023 [20..50%), F3_Val [50..80%); Blind Y5 [80..100%) untouched',
                'purging': 'Purged boundary-overlapping trades at calEnd and valEnd',
                'fitScope': 'Fitted on Cal [0..50%), threshold/sizeCurve selected on F1..F3 inside [0..80%) maximizing min(F1_PF, F3_PF)+Calmar; SHA-256 locked before Y5 evaluation',
            },
            'models': exported,
        }, f, indent=2)
    print(f"\n[train_v9_ensemble] Saved {os.path.relpath(out_path, ROOT_DIR)} (SHA-256 lock: {lock_sha[:16]}...)")


if __name__ == '__main__':
    main()
