"""Crop Health Index (CHI) v1, per the Sviana technical note "Crop Health Index (CHI): a season-aware, farm-relative satellite index
for agricultural credit monitoring" (Nov 2026). It revises the team's earlier Farm Health Index (fhi_calc.py, kept unmodified next to
this file as the reference for the original). analysis.json keeps the field names fhi* so the dashboard contract does not change.

  slot      j = floor((DOY - 1) / 8)                                        46 calendar slots (Eq. 1)
  PR_j(x)   = 100 * (#{r < x} + 0.5 #{r = x}) / n over the reference set R_j (Eq. 2): this field's PAST values in slots j-1, j, j+1
              (wrapping at 46) from the other years -- a value is never ranked against itself or its own season's neighbours; n >= 5
  V         = PR_j(NDVI)                                                      vegetation (Eq. 3; MODIS NDVI, 2001- baseline)
  SMp       = PR_j(SM);  S = SMp if SMp <= 85 else 85 (100 - SMp) / 15       soil, two-sided: waterlogging falls linearly to 0 (Eqs. 4-5)
  WA        = min(1, ET / PET);  W = PR_j(WA)                                water adequacy, farm-relative (Eq. 6); ET/PET >= 3270 = fill
  m(p)      = 1 between sowing and harvest (the field's own dates when known, else Oct-Apr summer crops / Jun-Dec winter crops) (Eq. 7)
  CHI       = m * mean(V, S, W), needs >= 2 of the 3; "partial" when only 2 (Eq. 8)
  bands     >= 60 above normal, 40-60 normal, 25-40 stressed, 10-25 severely stressed, < 10 extreme stress (Table 3)
  season    per campaign: mean, minimum and critical-period mean (soy Jan-Feb, maize Dec-Jan, wheat/barley Sep-Oct; sunflower Dec-Jan
            is our assumption, the note does not list it)
  f_CHI     = (CHI - mu_j) / sigma_j over this field's in-season history in the same slot (Eq. 9): the standardized factor for the
            credit model. Published, but NOT yet wired into PD here: the PD model still uses the yield-loss link.

IMPORTANT: CHI is a DISPLAY indicator in this build. It does NOT feed the PD, IFRS 9 staging, ECL or the alerts.
Inputs here are weekly (not 8-day) and ET / PET are synthetic; the maths does not depend on the step.
"""
from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd

from . import config as C

COLUMNS = ["date", "ndvi_modis", "ndvi_s2", "sm", "et", "pet"]      # input CSV format of fhi_calc.py (-9999 = missing)
SM_PENALTY_START = 85.0


def slot_of(dates: pd.Series) -> pd.Series:
    return (dates.dt.dayofyear - 1) // 8


def pr(x: float, ref) -> float:
    """Eq. 2: percentile rank of x in a reference set (ties count half)."""
    ref = np.asarray(ref, float); ref = ref[~np.isnan(ref)]
    return float(100 * ((ref < x).sum() + 0.5 * (ref == x).sum()) / len(ref)) if len(ref) else float("nan")


def _slot_percentile(df: pd.DataFrame, col: str, min_ref: int = 5) -> pd.Series:
    """PR_j for every row: reference = this field's values in slots j-1..j+1 (wrapping) from OTHER calendar years (the past record,
    never the value itself or its own neighbours). Fewer than `min_ref` reference values -> NaN."""
    out = np.full(len(df), np.nan)
    slots, vals, years = df["slot"].values, df[col].values.astype(float), df["date"].dt.year.values
    for s_ in np.unique(slots):
        near = np.isin(slots, [(s_ - 1) % 46, s_, (s_ + 1) % 46]) & ~np.isnan(vals)
        cv, cy = vals[near], years[near]
        rows = np.where((slots == s_) & ~np.isnan(vals))[0]
        if not len(rows) or not len(cv):
            continue
        v, ry = vals[rows][:, None], years[rows][:, None]
        other = cy[None, :] != ry
        n = other.sum(1)
        res = 100 * (((cv[None, :] < v) & other).sum(1) + 0.5 * ((cv[None, :] == v) & other).sum(1)) / np.maximum(n, 1)
        out[rows] = np.where(n >= min_ref, res, np.nan)
    return pd.Series(out, index=df.index)


def soil_two_sided(smp):
    """Eq. 5: S = SMp up to the 85th percentile, then 85 (100 - SMp) / 15, falling linearly to 0 at the 100th (waterlogging). NaN stays NaN."""
    smp = np.asarray(smp, float)
    star = np.where(smp <= SM_PENALTY_START, smp, np.maximum(0, SM_PENALTY_START * (100 - smp) / (100 - SM_PENALTY_START)))
    return np.where(np.isnan(smp), np.nan, star)


def in_season(months, season: str):
    m0, m1 = [int(x) for x in season.split("-")]
    mon = np.asarray(months)
    return ((mon >= m0) | (mon <= m1)) if m0 > m1 else ((mon >= m0) & (mon <= m1))


def combine(vci_p, smp_star, wa_p, in_seas):
    """Eq. 8: CHI = mean of the available components if >= 2 are present and in season, else NaN."""
    comp = pd.DataFrame({"a": vci_p, "b": smp_star, "c": wa_p})
    return np.where(np.asarray(in_seas) & (comp.notna().sum(axis=1) >= 2), comp.mean(axis=1), np.nan)


def campaign_label(dates: pd.Series) -> pd.Series:
    y, mon = dates.dt.year, dates.dt.month
    return pd.Series(np.where(mon >= 7, y.astype(str) + "/" + (y + 1).astype(str).str[-2:], (y - 1).astype(str) + "/" + y.astype(str).str[-2:]), index=dates.index)


FILL_MM = 3270.0     # MOD16A2 ET / PET at or above this (after the 0.1 scale) are fill codes (Table 2)


def compute_fhi(df: pd.DataFrame, season: str = "10-04", present=None, critical: str | None = None) -> pd.DataFrame:
    """df: columns date, ndvi_modis, sm, et, pet (NaN = missing). `present`: optional bool array (len(df)) = the crop is in the ground
    (field sowing / harvest known); NaN entries fall back to the month window `season`. Returns a sorted copy with slot, WA, VCI_p (= V),
    SMp, SMp_star (= S), WA_p (= W), in_season, n_comp, partial, CHI (also as FHI), CHI_z, critical, campaign."""
    df = df.copy()
    df["date"] = pd.to_datetime(df["date"])
    if present is not None:
        df["_present"] = np.asarray(present, dtype=object)
    df = df.sort_values("date").reset_index(drop=True)
    df["slot"] = slot_of(df["date"])
    for c in ("et", "pet"):
        df.loc[df[c] >= FILL_MM, c] = np.nan
    df["WA"] = np.minimum(1.0, df["et"] / df["pet"])
    df.loc[(df["pet"] <= 0) | df["pet"].isna(), "WA"] = np.nan
    df["VCI_p"] = _slot_percentile(df, "ndvi_modis")
    df["SMp"] = _slot_percentile(df, "sm")
    df["SMp_star"] = soil_two_sided(df["SMp"].values)
    df["WA_p"] = _slot_percentile(df, "WA")
    seas = in_season(df["date"].dt.month, season)
    if present is not None:
        known = df["_present"].map(lambda x: x is not None and not (isinstance(x, float) and np.isnan(x)))
        seas = np.where(known, df["_present"].map(lambda x: bool(x) if x is not None and not (isinstance(x, float) and np.isnan(x)) else False), seas)
        df = df.drop(columns="_present")
    df["in_season"] = np.asarray(seas, bool)
    df["n_comp"] = df[["VCI_p", "SMp_star", "WA_p"]].notna().sum(axis=1)
    df["CHI"] = combine(df["VCI_p"], df["SMp_star"], df["WA_p"], df["in_season"])
    df["FHI"] = df["CHI"]
    df["partial"] = df["CHI"].notna() & (df["n_comp"] == 2)
    # Eq. 9: standardized against this field's in-season CHI in the same slot in other years
    z = np.full(len(df), np.nan)
    yrs = df["date"].dt.year.values
    for s_ in np.unique(df["slot"].values):
        rows = np.where((df["slot"].values == s_) & df["CHI"].notna().values)[0]
        if len(rows) < 6:
            continue
        v = df["CHI"].values[rows]
        for k, r in enumerate(rows):
            ref = v[yrs[rows] != yrs[r]]
            if len(ref) >= 5 and ref.std() > 0:
                z[r] = (v[k] - ref.mean()) / ref.std()
    df["CHI_z"] = z
    df["critical"] = in_season(df["date"].dt.month, critical) if critical else False
    df["campaign"] = campaign_label(df["date"])
    return df


compute_chi = compute_fhi


def by_campaign(res: pd.DataFrame, analysis_start=None) -> pd.DataFrame:
    """Season summary by campaign (in-season rows only): mean, minimum and critical-period mean CHI, mean components."""
    an = res if analysis_start is None else res[res["date"] >= analysis_start]
    an = an[an["in_season"]]
    out = (an.groupby("campaign").agg(n=("CHI", "count"), FHI=("CHI", "mean"), VCI_p=("VCI_p", "mean"), SMp_star=("SMp_star", "mean"),
                                       WA_p=("WA_p", "mean"), FHI_min=("CHI", "min")))
    crit = an[an["critical"].astype(bool)].groupby("campaign")["CHI"].mean() if "critical" in an else pd.Series(dtype=float)
    out["CHI_crit"] = crit.reindex(out.index)
    return out.round(1)


# ------------------------------------------------------------------------------------------------ glue with the pipeline
def season_dates(s: int) -> list:
    """Weekly dates of season index s (0 = first history season ... CUR = current season (config.SEASON_LABEL)): 1 June of the start year + 7 i days."""
    start = date(C.HIST_YEARS[s], 6, 1) if s < C.N_HIST else C.SEASON_START
    return [start + timedelta(days=7 * i) for i in range(C.W)]


def series_frame(ndvi, ndvi_obs, sm, et, pet) -> pd.DataFrame:
    """Long weekly series for one field: all arrays (S, W) -> DataFrame in the input format of fhi_calc.py."""
    S = ndvi.shape[0]
    dates = [d for s in range(S) for d in season_dates(s)]
    f = lambda a: np.asarray(a, float).reshape(-1)
    return pd.DataFrame({"date": pd.to_datetime(dates), "ndvi_modis": f(ndvi), "ndvi_s2": f(ndvi_obs), "sm": f(sm), "et": f(et), "pet": f(pet)})


def write_script_csv(df: pd.DataFrame, path) -> None:
    out = df.copy()
    out["date"] = pd.to_datetime(out["date"]).dt.strftime("%Y-%m-%d")
    out[COLUMNS[1:]] = out[COLUMNS[1:]].astype(float).round(6).fillna(-9999)
    out[COLUMNS].to_csv(path, index=False)


def _r1(x):
    return None if x is None or not np.isfinite(x) else round(float(x), 1)


def loan_outputs(df: pd.DataFrame, season: str, present_cur=None, critical: str | None = None) -> dict:
    """Per-loan analysis.json fields from the long frame (the last C.W rows are the current season). `present_cur` (C.W bools): the crop
    is in the ground this season (from sowing / harvest); history seasons use the default month window."""
    present = None
    if present_cur is not None:
        present = [None] * (len(df) - C.W) + [bool(x) for x in present_cur]
    res = compute_fhi(df, season, present=present, critical=critical)
    cur = res.iloc[-C.W:]
    ins = cur["in_season"].values
    arr = lambda c, nd=1: [(_r1(v) if nd == 1 else (None if not np.isfinite(v) else round(float(v), nd))) if m else None for v, m in zip(cur[c].values, ins)]
    bc = by_campaign(res)
    bc = bc[bc["n"] >= 8]
    camp = [dict(campaign=k, fhi=_r1(r.FHI), vci=_r1(r.VCI_p), sm=_r1(r.SMp_star), wa=_r1(r.WA_p), fhiMin=_r1(r.FHI_min), crit=_r1(r.CHI_crit)) for k, r in bc.iterrows()]
    return dict(fhi=arr("FHI"), fhiVci=arr("VCI_p"), fhiSm=arr("SMp_star"), fhiWa=arr("WA_p"), fhiZ=arr("CHI_z", 2),
                fhiPartial=[bool(p) if m and v is not None and np.isfinite(v) else None for p, m, v in zip(cur["partial"].values, ins, cur["CHI"].values)],
                fhiByCampaign=camp)


CUR_CAMPAIGN = C.SEASON_LABEL


def summary(L: dict, w: int) -> dict:
    """Farm Health numbers of one analysis.json loan at week w (for reports and answers). Display only. Missing -> None."""
    if "fhi" not in L:
        return dict(now=None, vci=None, sm=None, wa=None, cur=None, cur_crit=None, partial=False, z=None, past_mean=None, worst=None, worst_campaign=None, n_past=0)
    camp = L.get("fhiByCampaign") or []
    cur = next((c["fhi"] for c in camp if c["campaign"] == CUR_CAMPAIGN), None)
    past = [c for c in camp if c["campaign"] != CUR_CAMPAIGN and c["fhi"] is not None]
    worst = min(past, key=lambda c: c["fhi"]) if past else None
    cur_crit = next((c.get("crit") for c in camp if c["campaign"] == CUR_CAMPAIGN), None)
    return dict(now=L["fhi"][w], vci=L["fhiVci"][w], sm=L["fhiSm"][w], wa=L["fhiWa"][w], cur=cur, cur_crit=cur_crit,
                partial=bool((L.get("fhiPartial") or [None] * (w + 1))[w]), z=(L.get("fhiZ") or [None] * (w + 1))[w],
                past_mean=round(sum(c["fhi"] for c in past) / len(past), 1) if past else None,
                worst=worst["fhi"] if worst else None, worst_campaign=worst["campaign"] if worst else None, n_past=len(past))


BANDS = [(60, "above normal"), (40, "normal"), (25, "stressed"), (10, "severely stressed"), (-1, "extreme stress")]   # Table 3


def label(v) -> str:
    """Table 3: >= 60 above normal, 40-60 normal, 25-40 stressed, 10-25 severely stressed, < 10 extreme stress."""
    return "n/a" if v is None else next(name for lo, name in BANDS if v >= lo)
