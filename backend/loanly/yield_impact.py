"""Module 6 (METHODS 6): from stress to expected yield loss, with a range.

Method (per region x crop, i.e. per "department group"):
  1. Season stress indicators of every history season, taken from the satellite/weather signals of the fields in the group:
        ndvi_zmin  lowest NDVI z-score from 2 weeks before to the end of the critical window (flowering / grain fill)
        spi60_mean mean SPI-60 from 6 weeks before the window to its end (rain adequacy around the critical period)
        hot_days   days above 35 C inside the window
        frost_deg  degrees below -2 C accumulated while the crop is frost-sensitive
  2. Regress the department yield anomaly (fraction vs trend; 21 years) on those indicators:
        p50 : ordinary least squares (statsmodels OLS)
        p10, p90 : quantile regression (statsmodels QuantReg) -> the range
  3. Leave-one-year-out validation: refit without a year, predict it, report R2 and MAE (validation.yieldModel).
  4. Prediction per loan and week uses only the indicators available up to that week (cumulative min / mean / sums):
        before sowing -> a rain-only model (SPI-60) and a wider range;  in season -> the full model, interval widened until the
        critical window is over.  Irrigated fields lose less (config.IRRIGATED_LOSS_FACTOR).
Yield anomaly = (yield - trend yield) / trend yield, e.g. -0.35 = 35 % below normal.
"""
from __future__ import annotations

import warnings

import numpy as np
import statsmodels.api as sm
from statsmodels.regression.quantile_regression import QuantReg

from . import config as C

H, W, CUR = C.N_HIST, C.W, C.CUR
FEATURES = ["ndvi_zmin", "spi60_mean", "hot_days", "frost_deg"]


def indicators(ndvi_z, spi60, hot, frost_deg, sow: np.ndarray, crops: list, stage_w: np.ndarray) -> np.ndarray:
    """Cumulative-to-date season indicators. Inputs (F,S,W); sow (F,) calendar sowing week; stage_w (F,W).
    Returns X (F,S,W,4): X[f,s,t] only uses weeks <= t."""
    F, S, _ = ndvi_z.shape
    win = np.array([C.critical_window(c) for c in crops])
    ws = np.clip(sow + win[:, 0], 0, W - 1)[:, None]; we = np.clip(sow + win[:, 1], 0, W - 1)[:, None]
    t = np.arange(W)[None, :]
    m1 = ((t >= ws - 2) & (t <= we))[:, None, :]
    x1 = np.minimum.accumulate(np.where(m1, np.clip(ndvi_z, -4, 4), np.inf), axis=2)
    x1 = np.minimum(np.where(np.isinf(x1), 0.0, x1), 0.0)
    sp = np.clip(spi60, -3, 3)
    csum = np.concatenate([np.zeros((F, S, 1)), np.cumsum(sp, axis=2)], axis=2)
    end = np.minimum(t, we); start = np.minimum(np.clip(np.minimum(ws - 6, t - 3), 0, None), end)
    num = np.take_along_axis(csum, np.broadcast_to((end + 1)[:, None, :], (F, S, W)), 2) - np.take_along_axis(csum, np.broadcast_to(start[:, None, :], (F, S, W)), 2)
    x2 = num / (end - start + 1)[:, None, :]
    mw = ((t >= ws) & (t <= we))[:, None, :]
    x3 = np.cumsum(np.where(mw, hot, 0), axis=2)
    x4 = np.cumsum(np.where((stage_w >= C.FROST_STAGE_WEIGHT)[:, None, :], frost_deg, 0), axis=2)
    return np.stack([x1, x2, x3, x4], axis=-1)


def _ols(X, y):
    return sm.OLS(y, sm.add_constant(X, has_constant="add")).fit()


def _quant(X, y, q):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return QuantReg(y, sm.add_constant(X, has_constant="add")).fit(q=q, max_iter=3000).params
    except Exception:
        return None


def _design(X):
    return np.column_stack([np.ones(len(X)), X])


def fit_group(Xd: np.ndarray, y: np.ndarray, cols: list):
    """Fit p50/p10/p90 on department-level indicators Xd (H,k) for the chosen columns. Returns coefficient dict + LOYO scores."""
    Xk = Xd[:, cols]
    p50 = _ols(Xk, y).params
    resid_sd = float(np.std(y - _design(Xk) @ p50, ddof=min(len(cols) + 1, len(y) - 1)))
    p10, p90 = _quant(Xk, y, 0.1), _quant(Xk, y, 0.9)
    if p10 is None or p90 is None or not np.all(np.isfinite(p10)) or not np.all(np.isfinite(p90)):    # fallback: normal band around OLS
        p10 = p50 + np.r_[-1.2816 * resid_sd, np.zeros(len(cols))]
        p90 = p50 + np.r_[1.2816 * resid_sd, np.zeros(len(cols))]
    return dict(cols=cols, p50=p50, p10=p10, p90=p90, sd=resid_sd)


def loyo(Xd, y, cols):
    pred = np.zeros(len(y))
    for i in range(len(y)):
        m = np.arange(len(y)) != i
        beta = _ols(Xd[m][:, cols], y[m]).params
        pred[i] = (_design(Xd[i:i + 1][:, cols]) @ beta)[0]
    sse, sst = float(((y - pred) ** 2).sum()), float(((y - y.mean()) ** 2).sum())
    return 1 - sse / max(sst, 1e-12), float(np.abs(y - pred).mean())


def _apply(model, X):
    """X (...,4) -> p10, p50, p90 (...) ordered."""
    D = _design(X[..., model["cols"]].reshape(-1, len(model["cols"]))) if model["cols"] else np.ones((int(np.prod(X.shape[:-1])), 1))
    shp = X.shape[:-1]
    p50, p10, p90 = (D @ model[k] for k in ("p50", "p10", "p90"))
    p10, p90 = np.minimum(p10, p50), np.maximum(p90, p50)
    return p10.reshape(shp), p50.reshape(shp), p90.reshape(shp)


def _bounds(Xd):
    lo, hi = Xd.min(0), Xd.max(0)
    pad = 0.25 * (hi - lo)
    return lo - pad, hi + pad


def loyo_pooled(Xs: list, ys: list, cols: list, gi: int):
    """Leave-one-YEAR-out for a pooled crop model (all regions refit without that year); scored on group `gi` only."""
    Xp, yp = np.vstack(Xs), np.concatenate(ys)
    yr = np.tile(np.arange(H), len(Xs))
    pred = np.zeros(H)
    for i in range(H):
        beta = _ols(Xp[yr != i][:, cols], yp[yr != i]).params
        pred[i] = (_design(Xs[gi][i:i + 1][:, cols]) @ beta)[0]
    y = ys[gi]
    return 1 - float(((y - pred) ** 2).sum()) / max(float(((y - y.mean()) ** 2).sum()), 1e-12), float(np.abs(y - pred).mean())


def fit_and_predict(X: np.ndarray, dept: dict, region_ids: list, crops: list, sow: np.ndarray, irrigated: np.ndarray):
    """X: (F,S,W,4) indicators. dept: {(region, crop): {anom (H,)...}}.
    Per region x crop model; if its leave-one-year-out R2 is below MIN_R2 (small groups, noisy history) the pooled crop model
    (all regions, same crop) is used instead and the validation row says so. Indicators are clipped to the training range
    (+25 %) so a very extreme field cannot extrapolate the regression.
    Returns dict(p10,p50,p90 (F,W) for the current season, hist_p50 (F,H) full-season predictions, dept_anom (F,H), validation list)."""
    MIN_R2 = 0.25
    F = X.shape[0]
    p10 = np.zeros((F, W)); p50 = np.zeros((F, W)); p90 = np.zeros((F, W)); hist = np.zeros((F, H)); danom = np.zeros((F, H))
    groups = {}
    for f in range(F):
        groups.setdefault((region_ids[f], crops[f]), []).append(f)
    keys = list(groups)
    G = {}
    for key in keys:
        idx = groups[key]
        y = dept[key]["anom"]
        Xd = X[idx, :H, W - 1, :].mean(0)                                   # department indicators at end of season
        cols = [j for j in range(4) if Xd[:, j].std() > 1e-9]
        full = fit_group(Xd, y, cols) if cols else dict(cols=[], p50=np.array([y.mean()]), p10=np.array([np.quantile(y, .1)]), p90=np.array([np.quantile(y, .9)]), sd=float(y.std()))
        rain = fit_group(Xd, y, [1]) if Xd[:, 1].std() > 1e-9 else full
        r2, mae = loyo(Xd, y, cols) if cols else (0.0, float(np.abs(y - y.mean()).mean()))
        G[key] = dict(idx=idx, y=y, Xd=Xd, cols=cols, full=full, rain=rain, r2=r2, mae=mae, bounds=_bounds(Xd), pooled=False)
    pooled = {}
    for crop in set(k[1] for k in keys):
        ks = [k for k in keys if k[1] == crop]
        Xs, ys = [G[k]["Xd"] for k in ks], [G[k]["y"] for k in ks]
        Xp, yp = np.vstack(Xs), np.concatenate(ys)
        cols = [j for j in range(4) if Xp[:, j].std() > 1e-9]
        pooled[crop] = dict(full=fit_group(Xp, yp, cols), rain=fit_group(Xp, yp, [1]) if Xp[:, 1].std() > 1e-9 else None, bounds=_bounds(Xp), cols=cols, ks=ks, Xs=Xs, ys=ys)
    valid = []
    for key in keys:
        g = G[key]; pl = pooled[key[1]]
        r2_used, mae_used = g["r2"], g["mae"]
        method = "OLS p50 + QuantReg p10/p90 on " + ", ".join(FEATURES[j] for j in g["cols"]) + "; leave-one-year-out"
        if g["r2"] < MIN_R2 and len(pl["ks"]) > 1:
            r2p, maep = loyo_pooled(pl["Xs"], pl["ys"], pl["cols"], pl["ks"].index(key))
            if r2p > g["r2"]:
                g.update(full=pl["full"], rain=pl["rain"] or pl["full"], bounds=pl["bounds"], pooled=True)
                r2_used, mae_used = r2p, maep
                method = f"pooled {key[1]} model (all regions; own-region LOYO R2 {g['r2']:.2f} too low): OLS p50 + QuantReg p10/p90; leave-one-year-out"
        valid.append(dict(regionId=key[0], crop=key[1], n=int(len(g["y"])), nFields=len(g["idx"]), r2Loyo=round(float(r2_used), 3), maeLoyo=round(float(mae_used), 3), method=method))
        win = C.critical_window(key[1])
        lo_b, hi_b = g["bounds"]
        for f in g["idx"]:
            danom[f] = g["y"]
            Xf = np.clip(X[f, CUR], lo_b, hi_b)
            a10, a50, a90 = _apply(g["full"], Xf); b10, b50, b90 = _apply(g["rain"], Xf)
            t = np.arange(W); s0 = int(sow[f]); ws, we = s0 + win[0], s0 + win[1]
            pre = t < s0
            a10, a50, a90 = np.where(pre, b10, a10), np.where(pre, b50, a50), np.where(pre, b90, a90)
            frac = np.clip((t - s0) / max(we - s0, 1), 0, 1)
            widen = np.where(pre, C.INTERVAL_WIDEN_BEFORE_SOWING, 1 + C.INTERVAL_WIDEN_IN_SEASON * (1 - frac))
            lo = np.maximum(a50 - a10, 0.04) * widen; hi = np.maximum(a90 - a50, 0.04) * widen
            k = C.IRRIGATED_LOSS_FACTOR if irrigated[f] else 1.0
            sc = lambda v: np.where(v < 0, v * k, v)
            lo_, mid, hi_ = (np.clip(sc(v), *C.YIELD_ANOM_CLIP) for v in (a50 - lo, a50, a50 + hi))
            p10[f], p50[f], p90[f] = lo_, mid, hi_
            h10, h50, h90 = _apply(g["full"], np.clip(X[f, :H, W - 1, :], lo_b, hi_b))
            hist[f] = np.clip(sc(h50), *C.YIELD_ANOM_CLIP)
    return dict(p10=p10, p50=p50, p90=p90, hist_p50=hist, dept_anom=danom, validation=valid)
