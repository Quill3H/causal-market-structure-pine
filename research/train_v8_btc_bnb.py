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
RESULTS_V8_DIR = os.path.join(ROOT_DIR, 'research', 'results_v8')
STREAM_KEYS = ['BTC_1h', 'BTC_15m', 'BNB_1h', 'BNB_15m']

FEATURE_SUBSETS = {
    'BTC_1h': {
        'of_cvd_fund': ['delta_ratio_1b', 'cvd_zscore_48', 'close_pos_dir', 'funding_dir_align'],
        'regime_of': ['regime_trend_score', 'd1_ema50_dist_atr', 'delta_ratio_1b'],
        'htf_streak': ['h4_ema20_dist_atr', 'ret_48_dir_atr', 'recent_dir_sl_streak'],
        'wick_delta': ['wick_adv_atr', 'delta_ratio_1b', 'h4_rally_exh'],
    },
    'BTC_15m': {
        'wick_adv_only': ['wick_adv_atr'],
        'wick_delta_15m': ['wick_adv_atr', 'delta_ratio_1b'],
        'regime_micro_15m': ['regime_trend_score', 'd1_ema50_dist_atr', 'wick_adv_atr', 'delta_ratio_1b'],
        'of_micro_15m': ['wick_adv_atr', 'close_pos_dir', 'delta_ratio_1b', 'cvd_imb_6b'],
        'trend_of_15m': ['h4_ema20_dist_atr', 'h1_ema50_dist_atr', 'delta_ratio_1b', 'funding_dir_align'],
    },
    'BNB_1h': {
        'bnb_regime_of': ['regime_trend_score', 'breadth_bear_ratio', 'delta_ratio_1b', 'funding_ma3_dir'],
        'bnb_wick_fund': ['wick_adv_atr', 'funding_ma3_dir', 'delta_ratio_1b'],
        'bnb_ltf_vol': ['ltf_ema50_dist_atr', 'ltf_ema50_slope_atr', 'atr_pct'],
        'bnb_trend_vol_fund': ['ltf_ema50_slope_atr', 'atr_pct', 'ret_12_dir_atr', 'funding_ma3_dir'],
    },
    'BNB_15m': {
        'wick_adv_only': ['wick_adv_atr'],
        'wick_delta_15m': ['wick_adv_atr', 'delta_ratio_1b'],
        'bnb_regime_15m': ['regime_trend_score', 'd1_slope_atr', 'wick_adv_atr', 'delta_ratio_1b'],
        'bnb_of_micro_15m': ['wick_adv_atr', 'delta_ratio_1b', 'cvd_imb_6b', 'ltf_ema50_slope_atr'],
        'bnb_lp_15m': ['launchpool_squeeze_flag', 'funding_dir_align', 'wick_adv_atr', 'atr_ratio_50'],
    },
}


def cal_chrono_cv_auc(X_cal, y_cal, make_clf, sample_weight=None, n_splits=3):
    n = len(y_cal)
    if n < 30 or len(np.unique(y_cal)) < 2:
        return 0.5
    fold_size = max(10, n // (n_splits + 1))
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
        fit_kw = {}
        if sample_weight is not None:
            fit_kw['clf__sample_weight'] = sample_weight[:tr_end]
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


def train_direction(stream_key, side_label, track_data, cal_rows, val_rows, pooled_cal_X, pooled_cal_y):
    all_features = track_data['featureNames']
    X_raw = np.array(
        [[np.nan if v is None else float(v) for v in s['features']] for s in track_data['signals']],
        dtype=np.float64,
    )

    used_pooled_fallback = len(cal_rows) < 20 or len(np.unique([r['y'] for r in cal_rows])) < 2
    if not used_pooled_fallback:
        y_cal = np.array([r['y'] for r in cal_rows], dtype=np.int64)
        w_mag = np.clip(np.array([abs(r['netPct']) for r in cal_rows], dtype=np.float64), 0.25, 4.0)
    else:
        y_cal = pooled_cal_y
        w_mag = None

    y_val = np.array([r['y'] for r in val_rows], dtype=np.int64)
    net_val = np.array([r['netPct'] for r in val_rows], dtype=np.float64)

    candidates = []
    all_evaluated = []
    for sub_name, cols in FEATURE_SUBSETS[stream_key].items():
        col_idx = [all_features.index(c) for c in cols]
        X_sub = X_raw[:, col_idx]
        if not used_pooled_fallback:
            X_cal = np.array([X_sub[r['idx']] for r in cal_rows], dtype=np.float64)
        else:
            X_cal = pooled_cal_X[:, col_idx]
        X_val = np.array([X_sub[r['idx']] for r in val_rows], dtype=np.float64) if len(val_rows) > 0 else np.empty((0, len(cols)))

        specs = []
        for c_val in [0.02, 0.05, 0.15]:
            weight_list = [('unw', None)] if used_pooled_fallback else [('unw', None), ('mag', w_mag)]
            for w_name, sw in weight_list:
                specs.append((
                    f'{side_label}:{sub_name}:LR_C{c_val}_{w_name}',
                    'logistic_regression',
                    lambda c=c_val: LogisticRegression(C=c, max_iter=2000, random_state=42),
                    sw,
                ))
        if not used_pooled_fallback and len(y_cal) >= 40:
            for n_est in [8, 12]:
                specs.append((
                    f'{side_label}:{sub_name}:GB_d1_n{n_est}',
                    'gradient_boosting',
                    lambda n=n_est: GradientBoostingClassifier(
                        max_depth=1, n_estimators=n, learning_rate=0.04,
                        min_samples_leaf=12, subsample=0.8, random_state=42,
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
            in_auc = float(roc_auc_score(y_cal, p_cal)) if len(np.unique(y_cal)) == 2 else 0.5
            if len(X_val) > 0 and len(np.unique(y_val)) == 2:
                p_val = pipe.predict_proba(X_val)[:, 1]
                val_auc = float(roc_auc_score(y_val, p_val))
                val_corr = float(np.corrcoef(p_val, net_val)[0, 1]) if np.std(p_val) > 1e-12 else 0.0
            else:
                val_auc = cv_auc
                val_corr = 0.0
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
                'usedPooledFallback': used_pooled_fallback,
            }
            all_evaluated.append(rec)
            if cv_auc < 0.505 or val_auc < 0.520 or (in_auc - cv_auc) > 0.22:
                continue
            candidates.append(rec)

    if not candidates:
        all_evaluated.sort(key=lambda r: (r['valAuc'] + 0.5 * r['cvAuc']), reverse=True)
        candidates.extend(all_evaluated[:3])

    target_side = 1 if side_label == 'LONG' else -1
    val_indices = [
        i for i, s in enumerate(track_data['signals'])
        if s['side'] == target_side and track_data['calEnd'] <= s['barIndex'] < track_data['valEnd']
    ]
    eval_items = []
    lookup = {}
    for m in candidates:
        val_probs = np.array([m['probs'][i] for i in val_indices], dtype=np.float64) if val_indices else np.array([0.5])
        p90 = float(np.round(np.quantile(val_probs, 0.90), 4))
        size_curves = [
            {'mode': 'flat'},
            {'mode': 'linear', 'minMult': 0.85, 'maxMult': 1.35, 'pMax': p90},
        ]
        qs = np.unique(np.round(np.quantile(val_probs, [0.0, 0.10, 0.20, 0.30, 0.45]), 4))
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


def select_best_on_val(eval_list, lookup, min_val_count):
    scored = []
    for res in eval_list:
        v = res['val']
        m_obj, tau, sc = lookup[res['id']]
        wr = v['winRatePct'] or 0.0
        pf = v['profitFactor'] or 0.0
        mo = v['meanMonthlySweepPct'] or 0.0
        eligible = (
            v['count'] >= min_val_count
            and wr >= 74.0
            and pf >= 1.25
            and v['compoundedNetPct'] > 0
            and v['liquidationCount'] == 0
        )
        high_target = eligible and wr >= 76.0 and pf >= 1.40
        score = (
            (10000.0 if eligible else 0.0)
            + (1500.0 if high_target else 0.0)
            + mo * 30.0
            + pf * 50.0
            + (wr - 74.0) * 3.0
            + (m_obj['valAuc'] - 0.5) * 120.0
        )
        scored.append((score, eligible, res))
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[0]


def main():
    raw_json = subprocess.check_output(
        ['node', 'research/regime_v8_btc_bnb.mjs', '--extract-cal-val'],
        cwd=ROOT_DIR,
        text=True,
    )
    data = json.loads(raw_json)

    # Build cross-asset directional pooled Cal matrices for rare-side fallback (< 20 Cal samples)
    pooled_X = {'LONG': [], 'SHORT': []}
    pooled_y = {'LONG': [], 'SHORT': []}
    for sk in STREAM_KEYS:
        sigs = data[sk]['signals']
        for r in data[sk]['calLong']:
            pooled_X['LONG'].append([np.nan if v is None else float(v) for v in sigs[r['idx']]['features']])
            pooled_y['LONG'].append(int(r['y']))
        for r in data[sk]['calShort']:
            pooled_X['SHORT'].append([np.nan if v is None else float(v) for v in sigs[r['idx']]['features']])
            pooled_y['SHORT'].append(int(r['y']))
    pooled_X_arr = {k: np.array(v, dtype=np.float64) if v else np.empty((0, len(data['BTC_1h']['featureNames']))) for k, v in pooled_X.items()}
    pooled_y_arr = {k: np.array(v, dtype=np.int64) for k, v in pooled_y.items()}

    eval_req = {}
    lookups = {}
    for sk in STREAM_KEYS:
        d = data[sk]
        _, long_items, long_lookup = train_direction(
            sk, 'LONG', d, d['calLong'], d['valLong'], pooled_X_arr['LONG'], pooled_y_arr['LONG'],
        )
        _, short_items, short_lookup = train_direction(
            sk, 'SHORT', d, d['calShort'], d['valShort'], pooled_X_arr['SHORT'], pooled_y_arr['SHORT'],
        )
        eval_req[sk] = {
            'structuralSpec': d['structuralSpec'],
            'longItems': long_items,
            'shortItems': short_items,
        }
        lookups[sk] = {'long': long_lookup, 'short': short_lookup}
        print(f"[{sk}] Structural={d['structuralSpec']['id']}")
        print(f"       CalLong={len(d['calLong'])} ValLong={len(d['valLong'])} | CalShort={len(d['calShort'])} ValShort={len(d['valShort'])}")
        print(f"       BaseVal: count={d['baseVal']['count']} WR={d['baseVal']['winRatePct']:.2f}% PF={d['baseVal']['profitFactor']:.2f} Mo={d['baseVal']['meanMonthlySweepPct']:.2f}% (L:{d['baseVal']['long']['count']}/{d['baseVal']['long']['winRatePct']:.1f}% S:{d['baseVal']['short']['count']}/{d['baseVal']['short']['winRatePct']:.1f}%)")

    eval_out_raw = subprocess.check_output(
        ['node', 'research/regime_v8_btc_bnb.mjs', '--eval-val'],
        cwd=ROOT_DIR,
        input=json.dumps(eval_req),
        text=True,
    )
    eval_out = json.loads(eval_out_raw)

    exported = {}
    for sk in STREAM_KEYS:
        d = data[sk]
        min_l = max(12, int(0.45 * max(1, len(d['valLong']))))
        min_s = max(12, int(0.45 * max(1, len(d['valShort']))))

        _, elig_l, best_l = select_best_on_val(eval_out[sk]['long'], lookups[sk]['long'], min_l)
        _, elig_s, best_s = select_best_on_val(eval_out[sk]['short'], lookups[sk]['short'], min_s)

        m_l, tau_l, sc_l = lookups[sk]['long'][best_l['id']]
        m_s, tau_s, sc_s = lookups[sk]['short'][best_s['id']]
        vl, vs = best_l['val'], best_s['val']

        print(f"\n[{sk}] Selected LONG : {best_l['id']} (elig={elig_l}, cvAuc={m_l['cvAuc']}, valAuc={m_l['valAuc']}, pooled={m_l['usedPooledFallback']})")
        print(f"       Val LONG : n={vl['count']} WR={vl['winRatePct']:.2f}% PF={vl['profitFactor']:.2f} Comp={vl['compoundedNetPct']:.2f}% Mo={vl['meanMonthlySweepPct']:.2f}%")
        print(f"[{sk}] Selected SHORT: {best_s['id']} (elig={elig_s}, cvAuc={m_s['cvAuc']}, valAuc={m_s['valAuc']}, pooled={m_s['usedPooledFallback']})")
        print(f"       Val SHORT: n={vs['count']} WR={vs['winRatePct']:.2f}% PF={vs['profitFactor']:.2f} Comp={vs['compoundedNetPct']:.2f}% Mo={vs['meanMonthlySweepPct']:.2f}%")

        exported[sk] = {
            'structuralSpec': d['structuralSpec'],
            'longModel': export_pipeline_spec(m_l['pipe'], m_l['mtype'], m_l['featureNames'], tau_l, sc_l),
            'shortModel': export_pipeline_spec(m_s['pipe'], m_s['mtype'], m_s['featureNames'], tau_s, sc_s),
            'selectionMeta': {
                'calRange': [0, d['calEnd']],
                'valRange': [d['calEnd'], d['valEnd']],
                'holdoutRangeUntouched': [d['valEnd'], d['totalBarsFull']],
                'long': {
                    'selectedId': best_l['id'],
                    'calCvAuc': m_l['cvAuc'],
                    'calInAuc': m_l['inAuc'],
                    'valRocAuc': m_l['valAuc'],
                    'valCorrNet': m_l['valCorrNet'],
                    'calTrainSamples': len(d['calLong']),
                    'usedPooledFallback': m_l['usedPooledFallback'],
                    'eligibleOnVal': elig_l,
                    'valSelected': vl,
                },
                'short': {
                    'selectedId': best_s['id'],
                    'calCvAuc': m_s['cvAuc'],
                    'calInAuc': m_s['inAuc'],
                    'valRocAuc': m_s['valAuc'],
                    'valCorrNet': m_s['valCorrNet'],
                    'calTrainSamples': len(d['calShort']),
                    'usedPooledFallback': m_s['usedPooledFallback'],
                    'eligibleOnVal': elig_s,
                    'valSelected': vs,
                },
                'valBaseline': d['baseVal'],
            },
        }

    os.makedirs(RESULTS_V8_DIR, exist_ok=True)
    out_path = os.path.join(RESULTS_V8_DIR, 'models_v8_btc_bnb.json')
    with open(out_path, 'w') as f:
        json.dump({
            'schema': 'smc-v8-btc-bnb-5y-models-v1',
            'generatedAt': datetime.now(timezone.utc).isoformat(),
            'antiLeakageProtocol': {
                'splitRule': 'Chrono 50% Cal, 30% Val, 20% Blind Holdout Y5',
                'purging': 'Purged boundary-overlapping trades at calEnd and valEnd',
                'fitScope': 'Separate LONG & SHORT models fitted strictly on Cal/Val; Y5 Holdout untouched by trainer',
            },
            'models': exported,
        }, f, indent=2)
    print(f"\n[train_v8_btc_bnb] Saved {os.path.relpath(out_path, ROOT_DIR)}")


if __name__ == '__main__':
    main()
