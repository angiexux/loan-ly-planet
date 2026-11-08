"""Module 8 (METHODS 8): from single loans to portfolio risk.

* Weekly totals: exposure, EAD, EAD at each stress level, ECL (bank baseline and by scenario), Stage 2 / Stage 3 counts.
* Clusters: DBSCAN with the haversine metric (eps ~ 60 km, min 3 loans) on the loans at level High/Severe each week. A cluster is
  a geographic pocket of correlated climate stress -- exactly what a diversified-looking book hides. Reported with centroid,
  radius, EAD and mean score.
* Concentration by region and crop at the default as-of week.
* Stress test = historical simulation: today's book is run through every one of the 21 history seasons. For each season, each
  field's full-season stress indicators -> the yield model -> expected yield loss -> PD (logit shift) -> loss = PD x LGD x EAD.
  The distribution over years gives p50 / p95 ("1-in-20-year") / p99 and the worst year. Delinquent (Stage 3) loans are in every year.
"""
from __future__ import annotations

import numpy as np
from sklearn.cluster import DBSCAN
from sklearn.metrics import roc_auc_score

from . import config as C
from . import ifrs9

W = C.W
EARTH_KM = 6371.0088


def weekly(arr: dict, meta: dict) -> dict:
    """arr: (N,W) arrays: ead, amount_active, level, ecl_bank, ecl_{base,adverse,severe,weighted}, stage. meta: lat/lng/ids/regions/crops."""
    lvl = arr["level"]; ead = arr["ead"]; act = arr["active"]
    out = dict(exposure=(arr["amount"] * act).sum(0), ead=ead.sum(0), stressedEad=(ead * (lvl >= 2)).sum(0),
               byLevel={n: (ead * (lvl == i)).sum(0) for i, n in enumerate(C.LEVELS)},
               byLevelCount={n: ((lvl == i) & act).sum(0) for i, n in enumerate(C.LEVELS)},
               eclBank=arr["ecl_bank"].sum(0), ecl={k: arr["ecl"][k].sum(0) for k in ("base", "adverse", "severe", "weighted")},
               stage2=((arr["stage"] == 2) & act).sum(0), stage3=((arr["stage"] == 3) & act).sum(0),
               stage1=((arr["stage"] == 1) & act).sum(0))
    lat, lng = np.radians(meta["lat"]), np.radians(meta["lng"])
    clusters = []
    eps = C.DBSCAN_EPS_KM / EARTH_KM
    for w in range(W):
        idx = np.where((lvl[:, w] >= 2) & act[:, w])[0]
        wk = []
        if len(idx) >= C.DBSCAN_MIN_SAMPLES:
            X = np.column_stack([lat[idx], lng[idx]])
            lab = DBSCAN(eps=eps, min_samples=C.DBSCAN_MIN_SAMPLES, metric="haversine").fit_predict(X)
            for c in sorted(set(lab) - {-1}):
                m = idx[lab == c]
                clat, clng = float(np.mean(meta["lat"][m])), float(np.mean(meta["lng"][m]))
                d = _hav(meta["lat"][m], meta["lng"][m], clat, clng)
                wk.append(dict(id=len(wk), loanIds=[meta["ids"][i] for i in m], lat=round(clat, 3), lng=round(clng, 3), radiusKm=round(float(max(d.max(), 5.0)), 1),
                               ead=round(float(ead[m, w].sum())), meanScore=round(float(arr["score"][m, w].mean()), 1)))
        clusters.append(wk)
    out["clusters"] = clusters
    a = meta["as_of"]
    conc = {}
    for key, vals in (("byRegion", meta["regions"]), ("byCrop", meta["crops"])):
        rows = []
        for v in sorted(set(vals)):
            m = np.array([x == v for x in vals])
            rows.append(dict(id=v, ead=round(float(ead[m, a].sum())), stressedEad=round(float((ead[m, a] * (lvl[m, a] >= 2)).sum()))))
        conc[key] = rows
    out["concentration"] = conc
    return out


def _hav(lat, lng, lat0, lng0):
    p1, p2 = np.radians(lat), np.radians(lat0)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lng0 - lng) / 2) ** 2
    return 2 * EARTH_KM * np.arcsin(np.sqrt(a))


def stress_test(loans: list, credit: list, hist_p50: np.ndarray, current_loss_anom: np.ndarray, as_of: int) -> dict:
    """Run today's book through each history season. hist_p50 (N,H): predicted yield anomaly per field and season."""
    years = C.HIST_YEARS
    N = len(loans)
    ead = np.array([c["ead"][as_of] for c in credit]); stage3 = np.array([c["stage"][as_of] == 3 for c in credit])
    ins_drought = np.array([bool(l["insurance"]) and any(p in l["insurance"]["perils"] for p in ("drought",)) for l in loans])
    cover = np.array([(l["insurance"] or {}).get("coverShare", 0.0) for l in loans])
    pd0 = np.array([l["pdOrig"] for l in loans]); lgd0 = np.array([l["lgdBank"] for l in loans])

    def book_loss(anom):                       # anom (N,)
        loss = np.maximum(0, -anom)
        pd = np.where(stage3, 1.0, ifrs9.pd_from_loss(pd0, loss))
        lgd = np.array([np.clip(lgd0[i] * float(ifrs9.lgd_factor(loans[i], ead[i], loss[i])), C.LGD_FLOOR, C.LGD_CAP) for i in range(N)])
        lgd = lgd * np.where(ins_drought & (loss >= 0.25), 1 - cover, 1.0)
        return float((pd * lgd * ead).sum())

    L = np.array([book_loss(hist_p50[:, j]) for j in range(len(years))])
    cur = book_loss(current_loss_anom)
    return dict(years=years, loss=[round(float(x)) for x in L], p50=round(float(np.percentile(L, 50))), p95=round(float(np.percentile(L, 95))),
                p99=round(float(np.percentile(L, 99))), worstYear=int(years[int(np.argmax(L))]), currentLoss=round(cur),
                note="Expected loss (PD x LGD x EAD) of today's book if each history season repeated; Stage 3 loans included in every year.")


def backtest(score: np.ndarray, level: np.ndarray, defaulted: np.ndarray, in_book: np.ndarray) -> list:
    """Per week, among the loans still in the book (originated, not yet repaid): does the score rank who will default?"""
    out = []
    for w in range(W):
        m = in_book[:, w]
        y = defaulted[m]
        flagged = level[m, w] >= 2
        row = dict(week=w, flagged=int(flagged.sum()),
                   flaggedDefaultRate=round(float(y[flagged].mean()), 3) if flagged.any() else None,
                   otherDefaultRate=round(float(y[~flagged].mean()), 3) if (~flagged).any() else None, auc=None)
        if m.sum() >= 20 and 0 < y.sum() < len(y) and np.ptp(score[m, w]) > 0:
            row["auc"] = round(float(roc_auc_score(y, score[m, w])), 3)
        out.append(row)
    return out
