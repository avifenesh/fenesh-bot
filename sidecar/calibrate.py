# Fit the LAYA calibration in src/laya-calibration.json from the census evals
# (data/laya/census_binary.jsonl and data/laya/census_other.jsonl) and report 5-fold
# cross-validated log loss against the base rate, so the file says how much LAYA adds.
#   sidecar/.venv/bin/python sidecar/calibrate.py
import datetime, json, math, os
import numpy as np

RNG = np.random.default_rng(7)


def logit(p):
    p = np.clip(np.asarray(p, dtype=float), 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def fit_logistic(X, y, l2=1e-2, iters=200):
    # Newton's method on the L2-penalised log loss; the last column of X is the intercept.
    w = np.zeros(X.shape[1])
    reg = np.full(X.shape[1], l2)
    reg[-1] = 0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (p - y) + reg * w
        H = (X * (p * (1 - p))[:, None]).T @ X + np.diag(reg) + 1e-9 * np.eye(X.shape[1])
        step = np.linalg.solve(H, g)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return w


def logloss(p, y):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def auc(x, y):
    x, y = np.asarray(x), np.asarray(y).astype(bool)
    pos, neg = x[y], x[~y]
    if not len(pos) or not len(neg):
        return float('nan')
    return float(((pos[:, None] > neg[None, :]).sum() + 0.5 * (pos[:, None] == neg[None, :]).sum()) / (len(pos) * len(neg)))


def folds(groups, k=5):
    # Split by question so the thresholds of one numeric question never straddle train and test.
    ids = np.unique(groups)
    RNG.shuffle(ids)
    for i in range(k):
        test = set(ids[i::k])
        mask = np.array([g in test for g in groups])
        yield ~mask, mask


def cv_logistic(X, y, groups):
    cal, base = [], []
    for tr, te in folds(groups):
        w = fit_logistic(X[tr], y[tr])
        cal.append(logloss(1 / (1 + np.exp(-X[te] @ w)), y[te]) * te.sum())
        base.append(logloss(np.full(te.sum(), y[tr].mean()), y[te]) * te.sum())
    return sum(cal) / len(y), sum(base) / len(y)


def binary(rows):
    y = np.array([r['y'] for r in rows], dtype=float)
    p = np.array([r['noul'] for r in rows])
    X = np.column_stack([logit(p), np.ones(len(y))])
    w = fit_logistic(X, y)
    cv_cal, cv_base = cv_logistic(X, y, np.array([r['qid'] for r in rows]))
    return {'a': round(float(w[0]), 4), 'b': round(float(w[1]), 4)}, {
        'n': len(y), 'yes_rate': round(float(y.mean()), 3),
        'auc_noul': round(auc(p, y), 3),
        'auc_choice_yes_first': round(auc([r['yn'] for r in rows], y), 3),
        'auc_choice_no_first': round(auc([r['ny'] for r in rows], y), 3),
        'logloss_raw': round(logloss(p, y), 4), 'cv_logloss_calibrated': round(cv_cal, 4), 'cv_logloss_base_rate': round(cv_base, 4)}


def threshold(rows):
    if not rows:
        return {'a': 0, 'b': 0, 'c': 1}, {'n': 0, 'note': 'no data yet: a uniform CDF over the range'}
    X, y, g, raw = [], [], [], []
    for r in rows:
        for x, p in zip(r['locs'], r['p']):
            X.append([logit(p), logit(x), 1.0]); y.append(float(r['pos'] <= x)); g.append(r['qid']); raw.append(p)
    X, y, g = np.array(X), np.array(y), np.array(g)
    w = fit_logistic(X, y)
    cv_cal, _ = cv_logistic(X, y, g)
    # The no-LAYA reference: the same fit with the LAYA feature removed (location only).
    Xl = X[:, 1:]
    cv_loc, _ = cv_logistic(Xl, y, g)
    return {'a': round(float(w[0]), 4), 'b': round(float(w[2]), 4), 'c': round(float(w[1]), 4)}, {
        'questions': len(rows), 'n': len(y), 'auc_raw': round(auc(raw, y), 3),
        'logloss_raw': round(logloss(np.array(raw), y), 4),
        'cv_logloss_calibrated': round(cv_cal, 4), 'cv_logloss_location_only': round(cv_loc, 4)}


def choice_nll(rows, t, mix):
    tot = 0.0
    for r in rows:
        p = (np.array(r['fwd']) + np.array(r['rev'])) / 2
        q = np.maximum(p, 1e-6) ** (1 / t)
        q = (1 - mix) * q / q.sum() + mix / len(q)
        tot -= math.log(q[r['y']])
    return tot / len(rows)


def choice(rows):
    if not rows:
        return {'t': 1, 'mix': 1.0}, {'n': 0, 'note': 'no data yet: uniform over the options'}
    grid = [(t, m) for t in (0.5, 0.75, 1, 1.5, 2, 3, 5, 8, 13, 20) for m in np.linspace(0, 1, 21)]
    best = min(grid, key=lambda tm: choice_nll(rows, *tm))
    cv = []
    for tr, te in folds(np.array([r['qid'] for r in rows])):
        trr = [r for r, k in zip(rows, tr) if k]
        ter = [r for r, k in zip(rows, te) if k]
        tm = min(grid, key=lambda tm: choice_nll(trr, *tm))
        cv.append(choice_nll(ter, *tm) * len(ter))
    uniform = float(np.mean([math.log(r['k']) for r in rows]))
    top1 = float(np.mean([int(np.argmax(np.array(r['fwd']) + np.array(r['rev'])) == r['y']) for r in rows]))
    return {'t': best[0], 'mix': round(float(best[1]), 2)}, {
        'n': len(rows), 'top1_accuracy': round(top1, 3), 'chance_top1': round(float(np.mean([1 / r['k'] for r in rows])), 3),
        'nll_raw': round(choice_nll(rows, 1, 0), 4), 'cv_nll_calibrated': round(sum(cv) / len(rows), 4), 'nll_uniform': round(uniform, 4)}


def main():
    load = lambda p: [json.loads(l) for l in open(p)] if os.path.exists(p) else []
    bin_rows = load('data/laya/census_binary.jsonl')
    other = load('data/laya/census_other.jsonl')
    mc = [r for r in other if r['type'] == 'mc']
    num = [r for r in other if r['type'] in ('numeric', 'discrete')]
    b, bm = binary(bin_rows)
    t, tm = threshold(num)
    c, cm = choice(mc)
    out = {
        'fitted': f"{datetime.date.today()} by sidecar/calibrate.py on zero-shot LAYA answers to resolved Metaculus "
                  "bot-tournament questions (spring and summer 2026, data/census), question and background only, no research brief",
        'model': 'convaiinnovations/laya, multilingual checkpoint, revision 7b928d828b7b0e022f929d9bd2e44165aa270148 (laya 0.3.26)',
        'binary': b, 'threshold': t, 'choice': c,
        'metrics': {'binary': bm, 'threshold': tm, 'choice': cm},
    }
    with open('src/laya-calibration.json', 'w') as f:
        json.dump(out, f, indent=2)
        f.write('\n')
    print(json.dumps(out, indent=2))


if __name__ == '__main__':
    main()
