#!/usr/bin/env python3
"""
Strict anti-leakage v8.0 Asymmetric Long vs Bear-Short ML meta-labeling trainer
for SOL_15m, SOL_1h, ETH_15m, and ETH_1h.

Trains TWO separate purged scikit-learn models per stream strictly on Cal [0..50%):
  - longModel  (Bull / Range Long setups)
  - shortModel (Bear Rally-Fade / Selling-Delta Short setups)
Selects directional thresholds (tauLong, tauShort) and sizeCurves strictly on Val [50%..80%),
with fallback to pooled directional LR if either side has < 20 Cal training samples.
Blind Holdout Y5 [80%..100%) is NEVER loaded or accessed by this trainer.
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
OUT_PATH = os.path.join(ROOT_DIR, 'research', 'results_v8', 'models_v8_eth_sol.json')

STREAM_KEYS = ['SOL_15m', 'SOL_1h', 'ETH_15m', 'ETH_1h']

FEATURE_SUBSETS = {
    'SOL': {
        'long': {
            'of_core': ['delta_ratio_1b', 'cvd_imb_6b', 'cvd_zscore_48', 'close_pos_dir'],
            'wick_reg': ['wick_adv_atr', 'reg_d1_ema50_dist_atr', 'reg_trend_score', 'delta_ratio_1b'],
            'trend_of': ['h4_ema20_dist_atr', 'ltf_ema50_slope_atr', 'reg_d1_slope_atr', 'funding_dir_align'],
            'micro_mix': ['wick_adv_atr', 'close_pos_dir', 'ret_12_dir_atr', 'cvd_imb_24b'],
        },
        'short': {
            'bear_of_core': ['delta_ratio_1b', 'cvd_imb_6b', 'cvd_zscore_48', 'close_pos_dir'],
            'bear_exh_wick': ['wick_adv_atr', 'reg_h4_rally_exh', 'reg_d1_ema50_dist_atr', 'delta_ratio_1b'],
            'bear_breadth_of': ['reg_breadth_bear', 'reg_d1_slope_atr', 'cvd_imb_24b', 'funding_dir_align'],
            'bear_micro_mix': ['wick_adv_atr', 'wick_opp_atr', 'ret_12_dir_atr', 'atr_ratio_50'],
        },
    },
    'ETH': {
        'long': {
            'cross_rel': ['eth_btc_ema20_dist', 'eth_btc_ema50_dist', 'eth_btc_zscore_48', 'eth_btc_residual_12h_dir'],
            'cross_of': ['eth_btc_ema20_dist', 'delta_ratio_1b', 'cvd_imb_6b', 'reg_d1_ema50_dist_atr'],
            'abs_of': ['delta_ratio_1b', 'cvd_zscore_48', 'wick_adv_atr', 'close_pos_dir'],
            'cross_reg': ['eth_btc_ret_24h_dir', 'reg_trend_score', 'funding_dir_align', 'h4_ema20_dist_atr'],
        },
        'short': {
            'bear_cross_rel': ['eth_btc_ema20_dist', 'eth_btc_ema50_dist', 'eth_btc_zscore_48', 'eth_btc_residual_12h_dir'],
            'bear_cross_exh': ['eth_btc_ema20_dist', 'reg_h4_rally_exh', 'delta_ratio_1b', 'wick_adv_atr'],
            'bear_abs_of': ['delta_ratio_1b', 'cvd_imb_24b', 'wick_adv_atr', 'close_pos_dir'],
            'bear_breadth_cross': ['reg_breadth_bear', 'reg_d1_ema50_dist_atr', 'eth_btc_ret_24h_dir', 'funding_dir_align'],
        },
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
    if k < 6:
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


def build_pooled_fallback_samples(all_data, side, cols):
    X_list, y_list, w_list = [], [], []
    for sk in STREAM_KEYS:
        td = all_data[sk]
        fnames = td['featureNames']
        if not all(c in fnames for c in cols):
            continue
        col_idx = [fnames.index(c) for c in cols]
        X_raw = np.array(
            [[np.nan if v is None else float(v) for v in s['vec']] for s in td['signals']],
            dtype=np.float64,
        )
        X_sub = X_raw[:, col_idx]
        for r in td['calSequential']:
            if r['side'] == side:
                X_list.append(X_sub[r['idx']])
                y_list.append(r['y'])
                w_list.append(min(4.0, max(0.25, abs(r['netPct']))))
    return np.array(X_list, dtype=np.float64), np.array(y_list, dtype=np.int64), np.array(w_list, dtype=np.float64)


def train_direction(stream_key, track_data, all_data, side):
    coin_grp = 'ETH' if stream_key.startswith('ETH') else 'SOL'
    dir_key = 'long' if side == 1 else 'short'
    all_features = track_data['featureNames']
    X_raw = np.array(
        [[np.nan if v is None else float(v) for v in s['vec']] for s in track_data['signals']],
        dtype=np.float64,
    )
    cal_rows = [r for r in track_data['calSequential'] if r['side'] == side]
    val_rows = [r for r in track_data['valSequential'] if r['side'] == side]

    y_cal = np.array([r['y'] for r in cal_rows], dtype=np.int64)
    w_mag = np.clip(np.array([abs(r['netPct']) for r in cal_rows], dtype=np.float64), 0.25, 4.0)
    y_val = np.array([r['y'] for r in val_rows], dtype=np.int64)
    net_val = np.array([r['netPct'] for r in val_rows], dtype=np.float64)
    used_pooled_fallback = False

    candidates = []
    all_evaluated = []

    for sub_name, cols in FEATURE_SUBSETS[coin_grp][dir_key].items():
        col_idx = [all_features.index(c) for c in cols]
        X_sub = X_raw[:, col_idx]
        X_cal = np.array([X_sub[r['idx']] for r in cal_rows], dtype=np.float64)
        X_val = np.array([X_sub[r['idx']] for r in val_rows], dtype=np.float64)

        if len(y_cal) < 20 or len(np.unique(y_cal)) < 2:
            used_pooled_fallback = True
            X_fit, y_fit, w_fit = build_pooled_fallback_samples(all_data, side, cols)
            specs = [(
                f'{dir_key}:{sub_name}:POOLED_LR_C0.02',
                'logistic_regression',
                lambda: LogisticRegression(C=0.02, max_iter=2000, random_state=42),
                None,
                X_fit, y_fit,
            )]
        else:
            specs = []
            for c_val in [0.02, 0.06, 0.15]:
                for w_name, sw in [('unw', None), ('mag', w_mag)]:
                    specs.append((
                        f'{dir_key}:{sub_name}:LR_C{c_val}_{w_name}',
                        'logistic_regression',
                        lambda c=c_val: LogisticRegression(C=c, max_iter=2000, random_state=42),
                        sw,
                        X_cal, y_cal,
                    ))
            for n_est in [6, 10]:
                specs.append((
                    f'{dir_key}:{sub_name}:GB_d1_n{n_est}',
                    'gradient_boosting',
                    lambda n=n_est: GradientBoostingClassifier(
                        max_depth=1, n_estimators=n, learning_rate=0.04,
                        min_samples_leaf=8, subsample=0.8, random_state=42,
                    ),
                    None,
                    X_cal, y_cal,
                ))

        for name, mtype, make_clf, sw, X_fit, y_fit in specs:
            cv_auc = cal_chrono_cv_auc(X_fit, y_fit, make_clf, sample_weight=sw)
            pipe = Pipeline([
                ('imp', SimpleImputer(strategy='median', keep_empty_features=True)),
                ('sc', StandardScaler()),
                ('clf', make_clf()),
            ])
            fit_kw = {'clf__sample_weight': sw} if sw is not None else {}
            pipe.fit(X_fit, y_fit, **fit_kw)
            p_fit = pipe.predict_proba(X_fit)[:, 1]
            p_val = pipe.predict_proba(X_val)[:, 1] if len(X_val) > 0 else np.array([])
            in_auc = float(roc_auc_score(y_fit, p_fit)) if len(np.unique(y_fit)) == 2 else 0.5
            val_auc = float(roc_auc_score(y_val, p_val)) if len(y_val) > 0 and len(np.unique(y_val)) == 2 else 0.5
            val_corr = float(np.corrcoef(p_val, net_val)[0, 1]) if len(p_val) > 1 and np.std(p_val) > 1e-12 else 0.0
            rec = {
                'id': f'seq:{name}',
                'name': name,
                'side': side,
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
            if cv_auc < 0.50 or val_auc < 0.51 or (in_auc - cv_auc) > 0.25:
                continue
            candidates.append(rec)

    if not candidates:
        all_evaluated.sort(key=lambda r: (r['valAuc'] + 0.5 * r['cvAuc']), reverse=True)
        candidates.extend(all_evaluated[:4])

    val_dir_indices = [
        i for i, s in enumerate(track_data['signals'])
        if s['side'] == side and track_data['calEnd'] <= s['barIndex'] < track_data['valEnd']
    ]
    eval_items = []
    lookup = {}
    for m in candidates:
        val_probs = np.array([m['probs'][i] for i in val_dir_indices], dtype=np.float64)
        p90 = float(np.round(np.quantile(val_probs, 0.90), 4)) if len(val_probs) > 0 else 0.75
        size_curves = [
            {'mode': 'flat'},
            {'mode': 'linear', 'minMult': 0.85, 'maxMult': 1.40, 'pMax': p90},
        ]
        qs = np.unique(np.round(np.quantile(val_probs, [0.0, 0.08, 0.16, 0.24, 0.32]), 4)) if len(val_probs) > 0 else np.array([0.0])
        for tau in qs:
            for sc in size_curves:
                if sc['mode'] == 'linear' and sc['pMax'] <= tau + 1e-4:
                    continue
                eid = f"{m['id']}|t={tau:.4f}|sc={sc['mode']}_{sc.get('minMult',1)}_{sc.get('maxMult',1)}"
                eval_items.append({
                    'id': eid,
                    'side': side,
                    'probs': m['probs'],
                    'threshold': float(tau),
                    'sizeCurve': sc,
                })
                lookup[eid] = (m, float(tau), sc)

    return candidates, eval_items, lookup


def select_best_dir_candidate(eval_list, lookup, base_cal_count, base_val_count):
    min_val = max(18, int(0.50 * base_val_count))
    min_cal = max(22, int(0.50 * base_cal_count))
    scored = []
    for res in eval_list:
        c = res['cal']
        v = res['val']
        m_obj, tau, sc = lookup[res['id']]
        wr_v = v['winRatePct'] or 0.0
        pf_v = v['profitFactor'] or 0.0
        mo_v = v['meanMonthlySweepPct'] or 0.0
        wr_c = c['winRatePct'] or 0.0
        pf_c = c['profitFactor'] or 0.0

        elig_soft = (
            v['count'] >= min_val and c['count'] >= min_cal
            and wr_v >= 72.0 and pf_v >= 1.20
            and wr_c >= 72.0 and pf_c >= 1.20
            and v['compoundedNetPct'] > 0 and c['compoundedNetPct'] > 0
            and v['liquidationCount'] == 0 and c['liquidationCount'] == 0
        )
        elig_strict = elig_soft and wr_v >= 75.0 and pf_v >= 1.30 and wr_c >= 75.0 and pf_c >= 1.28
        score = (
            (10000.0 if elig_soft else 0.0)
            + (4000.0 if elig_strict else 0.0)
            + mo_v * 30.0
            + pf_v * 55.0
            + pf_c * 25.0
            + (wr_v - 74.0) * 3.0
            + (m_obj['valAuc'] - 0.5) * 120.0
        )
        scored.append((score, elig_strict, elig_soft, res))
    scored.sort(key=lambda x: x[0], reverse=True)
    _, best_strict, best_soft, best_res = scored[0]
    m_obj, tau, sc = lookup[best_res['id']]
    return m_obj, tau, sc, best_res, best_strict, best_soft


def main():
    raw_json = subprocess.check_output(
        ['node', 'research/regime_v8_eth_sol.mjs', '--extract-cal-val'],
        cwd=ROOT_DIR,
        text=True,
    )
    data = json.loads(raw_json)

    eval_req = {}
    lookups = {}
    for sk in STREAM_KEYS:
        td = data[sk]
        cL, itemsL, lkL = train_direction(sk, td, data, 1)
        cS, itemsS, lkS = train_direction(sk, td, data, -1)
        eval_req[sk] = {'structuralSpec': td['structuralSpec'], 'items': itemsL + itemsS}
        lookups[sk] = {1: lkL, -1: lkS}
        print(f"[{sk}] Structural={td['structuralSpec']['id']}")
        print(f"      Base Cal: n={td['baseCal']['count']} (L={td['baseCalLong']['count']}:{td['baseCalLong']['winRatePct']}% / S={td['baseCalShort']['count']}:{td['baseCalShort']['winRatePct']}%) WR={td['baseCal']['winRatePct']}% PF={td['baseCal']['profitFactor']}")
        print(f"      Base Val: n={td['baseVal']['count']} (L={td['baseValLong']['count']}:{td['baseValLong']['winRatePct']}% / S={td['baseValShort']['count']}:{td['baseValShort']['winRatePct']}%) WR={td['baseVal']['winRatePct']}% PF={td['baseVal']['profitFactor']}")

    eval_out_raw = subprocess.check_output(
        ['node', 'research/regime_v8_eth_sol.mjs', '--eval-val-dir'],
        cwd=ROOT_DIR,
        input=json.dumps(eval_req),
        text=True,
    )
    eval_out = json.loads(eval_out_raw)

    # Evaluate combined (long + short) Cal+Val for selection verification
    combo_req = {}
    selected_dirs = {}
    for sk in STREAM_KEYS:
        td = data[sk]
        long_res_list = [r for r in eval_out[sk] if r['id'].startswith('seq:long:')]
        short_res_list = [r for r in eval_out[sk] if r['id'].startswith('seq:short:')]

        mL, tauL, scL, resL, strictL, softL = select_best_dir_candidate(
            long_res_list, lookups[sk][1], td['baseCalLong']['count'], td['baseValLong']['count']
        )
        mS, tauS, scS, resS, strictS, softS = select_best_dir_candidate(
            short_res_list, lookups[sk][-1], td['baseCalShort']['count'], td['baseValShort']['count']
        )
        selected_dirs[sk] = {
            'long': (mL, tauL, scL, resL, strictL, softL),
            'short': (mS, tauS, scS, resS, strictS, softS),
        }
        combo_req[sk] = {
            'structuralSpec': td['structuralSpec'],
            'items': [{
                'id': 'combined',
                'side': 0,
                'probsLong': mL['probs'],
                'thresholdLong': float(tauL),
                'sizeCurveLong': scL,
                'probsShort': mS['probs'],
                'thresholdShort': float(tauS),
                'sizeCurveShort': scS,
            }],
        }

    combo_out_raw = subprocess.check_output(
        ['node', 'research/regime_v8_eth_sol.mjs', '--eval-val-dir'],
        cwd=ROOT_DIR,
        input=json.dumps(combo_req),
        text=True,
    )
    combo_out = json.loads(combo_out_raw)

    exported = {}
    for sk in STREAM_KEYS:
        td = data[sk]
        mL, tauL, scL, resL, strictL, softL = selected_dirs[sk]['long']
        mS, tauS, scS, resS, strictS, softS = selected_dirs[sk]['short']
        comb = combo_out[sk][0]

        print(f"\n[{sk}] Selected LONG : {resL['id']} (strict={strictL}, soft={softL}, cvAuc={mL['cvAuc']}, valAuc={mL['valAuc']})")
        print(f"      LONG  Cal(n={resL['cal']['count']} WR={resL['cal']['winRatePct']}% PF={resL['cal']['profitFactor']}) | Val(n={resL['val']['count']} WR={resL['val']['winRatePct']}% PF={resL['val']['profitFactor']} Comp={resL['val']['compoundedNetPct']}%)")
        print(f"[{sk}] Selected SHORT: {resS['id']} (strict={strictS}, soft={softS}, cvAuc={mS['cvAuc']}, valAuc={mS['valAuc']})")
        print(f"      SHORT Cal(n={resS['cal']['count']} WR={resS['cal']['winRatePct']}% PF={resS['cal']['profitFactor']}) | Val(n={resS['val']['count']} WR={resS['val']['winRatePct']}% PF={resS['val']['profitFactor']} Comp={resS['val']['compoundedNetPct']}%)")
        print(f"      COMBO Cal(n={comb['cal']['count']} WR={comb['cal']['winRatePct']}% PF={comb['cal']['profitFactor']} Comp={comb['cal']['compoundedNetPct']}%) | Val(n={comb['val']['count']} WR={comb['val']['winRatePct']}% PF={comb['val']['profitFactor']} Comp={comb['val']['compoundedNetPct']}% Mo={comb['val']['meanMonthlySweepPct']}% DD={comb['val']['maxCompoundedDdPct']}%)")

        exported[sk] = {
            'structuralSpec': td['structuralSpec'],
            'longModel': export_pipeline_spec(mL['pipe'], mL['mtype'], mL['featureNames'], tauL, scL),
            'shortModel': export_pipeline_spec(mS['pipe'], mS['mtype'], mS['featureNames'], tauS, scS),
            'selectionMeta': {
                'calRange': [0, td['calEnd']],
                'valRange': [td['calEnd'], td['valEnd']],
                'holdoutRangeUntouched': [td['valEnd'], td['totalBarsFull']],
                'longSelection': {
                    'selectedId': resL['id'],
                    'calCvAuc': mL['cvAuc'],
                    'valRocAuc': mL['valAuc'],
                    'valCorrNet': mL['valCorrNet'],
                    'usedPooledFallback': mL['usedPooledFallback'],
                    'eligibleStrict': strictL,
                    'eligibleSoft': softL,
                    'calSelected': resL['cal'],
                    'valSelected': resL['val'],
                },
                'shortSelection': {
                    'selectedId': resS['id'],
                    'calCvAuc': mS['cvAuc'],
                    'valRocAuc': mS['valAuc'],
                    'valCorrNet': mS['valCorrNet'],
                    'usedPooledFallback': mS['usedPooledFallback'],
                    'eligibleStrict': strictS,
                    'eligibleSoft': softS,
                    'calSelected': resS['cal'],
                    'valSelected': resS['val'],
                },
                'comboCalSelected': comb['cal'],
                'comboValSelected': comb['val'],
            },
        }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    artifact = {
        'schema': 'smc-v8-eth-sol-5y-models-v1',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'antiLeakageProtocol': {
            'splitRule': 'Chrono 50% Cal, 30% Val, 20% Blind Holdout Y5',
            'purging': 'Purged boundary-overlapping trades at calEnd and valEnd; causal breadth & regime up to valMaxTime',
            'fitScope': 'Separate longModel & shortModel fit strictly on Cal; tauLong/tauShort selected on Val; Y5 Holdout untouched by trainer',
        },
        'models': exported,
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(artifact, f, indent=2)
    print(f"\n[train_v8_eth_sol] Saved {os.path.relpath(OUT_PATH, ROOT_DIR)}")


if __name__ == '__main__':
    main()
