#!/usr/bin/env python3
"""
SMC v14.0 — True Expanding Walk-Forward ML Trainer
  - 6-Month OOS Re-Anchoring Across 5Y (PreEpoch [20..40%) + Epochs 0..5 [40..100%] + LiveActiveModel)
  - Strict Zero-Lookahead Purge: exitIndex < epochStartBarIndex AND exitTime <= epochStartTimeSec
  - Recency Exponential Weighting (half-life = 365 days)
  - Hard CV AUC >= 0.52 & Positive Inner-Val Expectancy Abstention Gate (tau >= 0.52)
  - Outputs SHA-256 locked research/results_v14/models_v14_expanding_wf.json
"""

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
RESULTS_V14_DIR = os.path.join(ROOT_DIR, 'research', 'results_v14')
STREAM_KEYS = ['BTC_1h', 'BNB_1h', 'SOL_1h', 'ETH_1h', 'BTC_15m', 'BNB_15m', 'SOL_15m', 'ETH_15m']

COMMON_SUBSETS = {
    'of_cvd_fund': ['delta_ratio_1b', 'cvd_zscore_48', 'close_pos_dir', 'funding_dir_align'],
    'regime_of': ['regime_trend_score', 'd1_ema50_dist_atr', 'delta_ratio_1b'],
    'wick_delta': ['wick_adv_atr', 'delta_ratio_1b', 'h4_rally_exh'],
    'htf_streak': ['h4_ema20_dist_atr', 'ret_48_dir_atr', 'recent_dir_sl_streak'],
    'wick_adv_only': ['wick_adv_atr'],
    'ltf_vol_fund': ['ltf_ema50_slope_atr', 'atr_pct', 'ret_12_dir_atr', 'funding_ma3_dir'],
    'reg_slope_cvd': ['regime_trend_score', 'd1_slope_atr', 'cvd_zscore_48', 'wick_adv_atr'],
    'abs_reg_delta': ['delta_ratio_1b', 'cvd_imb_24b', 'wick_adv_atr', 'regime_trend_score'],
}

ETH_EXTRA_SUBSETS = {
    **COMMON_SUBSETS,
    'eth_cross_rel': ['eth_btc_ema20_dist', 'eth_btc_ret_24h_dir', 'eth_btc_zscore_48', 'delta_ratio_1b'],
    'eth_cross_of': ['eth_btc_ema50_dist', 'eth_btc_residual_12h_dir', 'wick_adv_atr', 'cvd_zscore_48'],
}

HALF_LIFE_DAYS = 365.0
LN2 = math.log(2.0)


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


def purged_chrono_cv_auc(rows, X, y, sample_weight, make_clf, n_splits=3):
    n = len(y)
    if n < 24 or len(np.unique(y)) < 2:
        return 0.5
    fold_size = max(8, n // (n_splits + 1))
    aucs = []
    for k in range(1, n_splits + 1):
        va_start = min(n - 6, fold_size * k)
        va_end = min(n, va_start + fold_size)
        if va_start < 12 or va_end - va_start < 5:
            continue
        va_start_bar = rows[va_start]['signalBarIndex']
        va_start_time = rows[va_start]['signalTime']
        tr_idx = [
            j for j in range(va_start)
            if rows[j]['exitIndex'] < va_start_bar and rows[j]['exitTime'] <= va_start_time
        ]
        if len(tr_idx) < 10:
            continue
        y_tr = y[tr_idx]
        y_va = y[va_start:va_end]
        if len(np.unique(y_tr)) < 2 or len(np.unique(y_va)) < 2:
            continue
        pipe = Pipeline([
            ('imp', SimpleImputer(strategy='median', keep_empty_features=True)),
            ('sc', StandardScaler()),
            ('clf', make_clf()),
        ])
        fit_kw = {'clf__sample_weight': sample_weight[tr_idx]} if sample_weight is not None else {}
        pipe.fit(X[tr_idx], y_tr, **fit_kw)
        p = pipe.predict_proba(X[va_start:va_end])[:, 1]
        aucs.append(float(roc_auc_score(y_va, p)))
    return float(np.mean(aucs)) if aucs else 0.5


def compute_recency_weights(rows, ref_time_sec):
    ages_days = np.array([max(0.0, (ref_time_sec - r['exitTime']) / 86400.0) for r in rows], dtype=np.float64)
    w_rec = np.exp(-LN2 * ages_days / HALF_LIFE_DAYS)
    w_mag = np.clip(np.array([abs(r['netPct']) for r in rows], dtype=np.float64), 0.35, 3.0)
    return w_rec, w_rec * w_mag


def eval_inner_val_metrics(val_rows, probs_val, tau, size_curve):
    sel_rets = []
    for r, p in zip(val_rows, probs_val):
        if p < tau:
            continue
        if size_curve['mode'] == 'linear':
            p_max = size_curve['pMax']
            u = max(0.0, min(1.0, (p - tau) / max(1e-6, p_max - tau)))
            mult = size_curve['minMult'] + u * (size_curve['maxMult'] - size_curve['minMult'])
        else:
            mult = 1.0
        eff_mult = max(0.45, min(1.45, mult * r.get('baseSizeMult', 1.0)))
        sel_rets.append(r['netPct'] * eff_mult)

    n_sel = len(sel_rets)
    if n_sel == 0:
        return {'count': 0, 'winRatePct': 0.0, 'profitFactor': 0.0, 'netPct': 0.0}
    gp = sum(x for x in sel_rets if x > 0)
    gl = abs(sum(x for x in sel_rets if x <= 0))
    pf = (gp / gl) if gl > 1e-9 else (5.0 if gp > 0 else 0.0)
    wr = 100.0 * sum(1 for x in sel_rets if x > 0) / n_sel
    return {
        'count': n_sel,
        'winRatePct': round(wr, 2),
        'profitFactor': round(pf, 3),
        'netPct': round(sum(sel_rets), 3),
    }


def fit_expanding_epoch(stream_key, feature_names, train_rows, ref_time_sec, cut_bar_idx, label, epoch_start_time, epoch_end_time, epoch_idx):
    # Strictly enforce zero-lookahead purge invariant before touching any labels
    if train_rows:
        max_exit_time = max(r['exitTime'] for r in train_rows)
        max_exit_idx = max(r['exitIndex'] for r in train_rows)
        assert max_exit_time <= ref_time_sec, f"{stream_key} {label} leak: maxTrainExitTime {max_exit_time} > {ref_time_sec}"
        if cut_bar_idx is not None:
            assert max_exit_idx < cut_bar_idx, f"{stream_key} {label} leak: maxTrainExitIdx {max_exit_idx} >= {cut_bar_idx}"
    else:
        max_exit_time = None
        max_exit_idx = None

    base_meta = {
        'epochIdx': epoch_idx,
        'label': label,
        'epochStartTimeSec': int(epoch_start_time),
        'epochEndTimeSec': int(epoch_end_time),
        'epochStartBarIndex': cut_bar_idx,
        'trainSamplesCount': len(train_rows),
        'maxTrainExitTime': max_exit_time,
        'maxTrainExitIndex': max_exit_idx,
    }

    if len(train_rows) < 28:
        return {**base_meta, 'abstain': True, 'qualified': False, 'abstainReason': 'insufficient_train_samples', 'modelSpec': None}

    y_all = np.array([r['y'] for r in train_rows], dtype=np.int64)
    if len(np.unique(y_all)) < 2:
        return {**base_meta, 'abstain': True, 'qualified': False, 'abstainReason': 'single_class', 'modelSpec': None}

    split_idx = min(len(train_rows) - 6, max(16, int(0.75 * len(train_rows))))
    ival_rows = train_rows[split_idx:]
    ival_start_bar = ival_rows[0]['signalBarIndex']
    ival_start_time = ival_rows[0]['signalTime']
    ical_rows = [
        r for r in train_rows[:split_idx]
        if r['exitIndex'] < ival_start_bar and r['exitTime'] <= ival_start_time
    ]
    if len(ical_rows) < 12 or len(ival_rows) < 6:
        return {**base_meta, 'abstain': True, 'qualified': False, 'abstainReason': 'insufficient_inner_split', 'modelSpec': None}

    y_ical = np.array([r['y'] for r in ical_rows], dtype=np.int64)
    y_ival = np.array([r['y'] for r in ival_rows], dtype=np.int64)
    if len(np.unique(y_ical)) < 2:
        return {**base_meta, 'abstain': True, 'qualified': False, 'abstainReason': 'single_class_inner_cal', 'modelSpec': None}

    X_all = np.array([[np.nan if v is None else float(v) for v in r['features']] for r in train_rows], dtype=np.float64)
    X_ical = np.array([[np.nan if v is None else float(v) for v in r['features']] for r in ical_rows], dtype=np.float64)
    X_ival = np.array([[np.nan if v is None else float(v) for v in r['features']] for r in ival_rows], dtype=np.float64)

    w_rec_all, w_mag_all = compute_recency_weights(train_rows, ref_time_sec)
    w_rec_ical, w_mag_ical = compute_recency_weights(ical_rows, ival_start_time)

    subsets = ETH_EXTRA_SUBSETS if stream_key.startswith('ETH') else COMMON_SUBSETS

    qualified_candidates = []
    best_seen_cv_auc = 0.0
    best_seen_ival_pf = 0.0
    best_seen_ival_net = -999.0

    for sub_name, cols in subsets.items():
        col_idx = [feature_names.index(c) for c in cols]
        Xs_all = X_all[:, col_idx]
        Xs_ical = X_ical[:, col_idx]
        Xs_ival = X_ival[:, col_idx]

        specs = []
        for c_val in [0.02, 0.05, 0.15]:
            specs.append((
                f'{sub_name}:LR_C{c_val}_rec',
                'logistic_regression',
                lambda c=c_val: LogisticRegression(C=c, max_iter=2000, random_state=42),
                w_rec_all, w_rec_ical,
            ))
            specs.append((
                f'{sub_name}:LR_C{c_val}_recmag',
                'logistic_regression',
                lambda c=c_val: LogisticRegression(C=c, max_iter=2000, random_state=42),
                w_mag_all, w_mag_ical,
            ))
        for n_est in [6, 10]:
            specs.append((
                f'{sub_name}:GB_d1_n{n_est}_rec',
                'gradient_boosting',
                lambda n=n_est: GradientBoostingClassifier(
                    max_depth=1, n_estimators=n, learning_rate=0.04,
                    min_samples_leaf=14, subsample=0.8, random_state=42,
                ),
                w_rec_all, w_rec_ical,
            ))

        for name, mtype, make_clf, sw_all, sw_ical in specs:
            cv_auc = purged_chrono_cv_auc(train_rows, Xs_all, y_all, sw_all, make_clf, n_splits=3)
            best_seen_cv_auc = max(best_seen_cv_auc, cv_auc)
            if cv_auc < 0.52:
                continue

            pipe_inner = Pipeline([
                ('imp', SimpleImputer(strategy='median', keep_empty_features=True)),
                ('sc', StandardScaler()),
                ('clf', make_clf()),
            ])
            pipe_inner.fit(Xs_ical, y_ical, clf__sample_weight=sw_ical)
            p_ival = pipe_inner.predict_proba(Xs_ival)[:, 1]
            ival_auc = float(roc_auc_score(y_ival, p_ival)) if len(np.unique(y_ival)) == 2 else 0.5

            p90 = float(np.round(max(0.55, np.quantile(p_ival, 0.90)), 4))
            taus = sorted(set([round(max(0.52, float(q)), 4) for q in np.quantile(p_ival, [0.0, 0.15, 0.30, 0.45, 0.60])] + [0.52, 0.55, 0.58, 0.62]))
            size_curves = [{'mode': 'flat'}]
            for tau in taus:
                if p90 > tau + 1e-4:
                    size_curves_tau = [{'mode': 'flat'}, {'mode': 'linear', 'minMult': 0.85, 'maxMult': 1.40, 'pMax': p90}]
                else:
                    size_curves_tau = [{'mode': 'flat'}]
                for sc in size_curves_tau:
                    iv = eval_inner_val_metrics(ival_rows, p_ival, tau, sc)
                    if iv['count'] >= 4:
                        best_seen_ival_pf = max(best_seen_ival_pf, iv['profitFactor'])
                        best_seen_ival_net = max(best_seen_ival_net, iv['netPct'])
                    if iv['count'] >= 4 and iv['netPct'] > 0.0 and iv['profitFactor'] >= 1.05:
                        score = (
                            min(iv['profitFactor'], 3.5) * 45.0
                            + iv['netPct'] * 2.0
                            + (cv_auc - 0.52) * 220.0
                            + (iv['winRatePct'] - 65.0) * 0.5
                            + (0.0 if sc['mode'] == 'flat' else 2.0)
                        )
                        qualified_candidates.append({
                            'score': score,
                            'name': name,
                            'mtype': mtype,
                            'cols': cols,
                            'col_idx': col_idx,
                            'make_clf': make_clf,
                            'sw_all': sw_all,
                            'tau': tau,
                            'sc': sc,
                            'cvAuc': round(cv_auc, 4),
                            'ivalAuc': round(ival_auc, 4),
                            'ival': iv,
                        })

    if not qualified_candidates:
        return {
            **base_meta,
            'abstain': True,
            'qualified': False,
            'abstainReason': 'failed_cv_auc_or_inner_val_expectancy',
            'bestChronoCvAuc': round(best_seen_cv_auc, 4),
            'bestInnerValPf': round(best_seen_ival_pf, 3),
            'bestInnerValNetPct': round(best_seen_ival_net, 3) if best_seen_ival_net > -900 else None,
            'modelSpec': None,
        }

    qualified_candidates.sort(key=lambda c: c['score'], reverse=True)
    win = qualified_candidates[0]

    # Refit winning configuration on full expanding train window (still strictly exitTime <= ref_time_sec)
    final_pipe = Pipeline([
        ('imp', SimpleImputer(strategy='median', keep_empty_features=True)),
        ('sc', StandardScaler()),
        ('clf', win['make_clf']()),
    ])
    final_pipe.fit(X_all[:, win['col_idx']], y_all, clf__sample_weight=win['sw_all'])
    model_spec = export_pipeline_spec(final_pipe, win['mtype'], win['cols'], win['tau'], win['sc'])

    return {
        **base_meta,
        'abstain': False,
        'qualified': True,
        'selectedId': win['name'],
        'chronoCvAuc': win['cvAuc'],
        'innerValAuc': win['ivalAuc'],
        'innerValTrades': win['ival']['count'],
        'innerValWinRate': win['ival']['winRatePct'],
        'innerValPf': win['ival']['profitFactor'],
        'innerValNetPct': win['ival']['netPct'],
        'modelSpec': model_spec,
    }


def main():
    raw_json = subprocess.check_output(
        ['node', 'research/expanding_wf_v14.mjs', '--extract-expanding'],
        cwd=ROOT_DIR,
        text=True,
    )
    data = json.loads(raw_json)

    exported = {}
    for sk in STREAM_KEYS:
        td = data[sk]
        all_trades = td['candidateTrades']
        fnames = td['featureNames']
        schedule = td['schedule']

        epochs_out = []
        for ep in schedule:
            cut_bar = ep['epochStartBarIndex']
            cut_time = ep['epochStartTimeSec']
            train_rows = [
                r for r in all_trades
                if r['exitIndex'] < cut_bar and r['exitTime'] <= cut_time
            ]
            res = fit_expanding_epoch(
                sk, fnames, train_rows,
                cut_time, cut_bar,
                ep['label'], ep['epochStartTimeSec'], ep['epochEndTimeSec'], ep['epochIdx'],
            )
            epochs_out.append(res)

        # LiveActiveModel trained on full 5Y closed trades [0..100%] for bars t >= lastEpochEndTimeSec
        end_time = td['dataEndTimeSec']
        total_bars = td['totalBarsFull']
        live_rows = [r for r in all_trades if r['exitIndex'] < total_bars and r['exitTime'] <= end_time]
        live_res = fit_expanding_epoch(
            sk, fnames, live_rows,
            end_time, total_bars,
            'LiveActiveModel', end_time, end_time + 365 * 86400, 99,
        )

        exported[sk] = {
            'structuralSpec': td['structuralSpec'],
            'intervalSeconds': td['intervalSeconds'],
            'totalBarsFull': total_bars,
            'firstEpochStartTimeSec': epochs_out[0]['epochStartTimeSec'],
            'lastEpochEndTimeSec': epochs_out[-1]['epochEndTimeSec'],
            'epochs': epochs_out,
            'liveActiveModel': live_res,
        }

        ep_parts = []
        for e in epochs_out:
            if e['abstain']:
                ep_parts.append(f"E{e['epochIdx']}:ABST")
            else:
                ep_parts.append(f"E{e['epochIdx']}:tau={e['modelSpec']['threshold']:.2f}(auc={e['chronoCvAuc']:.2f})")
        ep_str = ' '.join(ep_parts)
        live_str = 'ABST' if live_res['abstain'] else f"tau={live_res['modelSpec']['threshold']:.2f}(auc={live_res['chronoCvAuc']:.2f})"
        print(f"[{sk:7s}] {ep_str} | Live:{live_str}")

    os.makedirs(RESULTS_V14_DIR, exist_ok=True)
    lock_sha = hashlib.sha256(canonical_dumps(exported).encode('utf-8')).hexdigest()
    out_path = os.path.join(RESULTS_V14_DIR, 'models_v14_expanding_wf.json')
    artifact = {
        'schema': 'smc-v14-expanding-wf-models-v1',
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'selectionLockSha256': lock_sha,
        'antiLeakageProtocol': {
            'splitRule': 'Expanding 10% (~6-month) epochs: PreEpoch [20..40%) + Epochs 0..5 [40..100%] + LiveActiveModel',
            'purging': 'Strict zero-lookahead purge: exitIndex < epochStartBarIndex AND exitTime <= epochStartTimeSec',
            'recencyWeighting': f'Exponential sample weights half-life={HALF_LIFE_DAYS} days',
            'abstentionGate': 'chronoCvAuc >= 0.52 AND innerValTrades >= 4 AND innerValNetPct > 0 AND innerValPf >= 1.05 AND tau >= 0.52',
        },
        'models': exported,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(artifact, f, indent=2)
    print(f"\n[train_v14_expanding_wf] Saved {os.path.relpath(out_path, ROOT_DIR)} (SHA-256 lock: {lock_sha[:16]}...)")


if __name__ == '__main__':
    main()
