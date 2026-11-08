"""Module 2 (METHODS 2): which crop stage is each field in, week by week.

* Sowing date known: weeks since sowing -> stage through crop-specific stage lengths (lookup table in config).
  Optional refinement: growing degree days (`stage_series_gdd`) stretch or shrink the calendar with temperature.
* Sowing date blank: phenology detection. Smoothed NDVI is mostly flat (fallow) and then rises as the crop emerges. We take the
  first week where it crosses 20 % of the season's range (pre-peak minimum to peak), then back-date by the typical time between
  sowing and that green-up (`greenup_lag` in config).
* Output per week: stage name and a stage weight (flowering = 1.0, vegetative = 0.5, ...) used to scale stress in module 4.
"""
from __future__ import annotations

from datetime import date

import numpy as np

from . import config as C


def sowing_week(d: date) -> int:
    return (d - C.SEASON_START).days // 7


def stage_series(crop: str, sow_week: int, n: int = C.W):
    """Stage name and weight for each week of the season given the sowing week (calendar-based)."""
    bounds = C.stage_bounds(crop)
    names, weights = [], np.zeros(n)
    for w in range(n):
        t = w - sow_week
        if t < 0:
            nm, wt = C.PRE_SOWING
        elif t >= bounds[-1][2]:
            nm, wt = C.HARVESTED
        else:
            nm, wt = next((b[0], b[3]) for b in bounds if b[1] <= t < b[2])
        names.append(nm); weights[w] = wt
    return names, weights


def stage_series_gdd(crop: str, sow_week: int, tmean_week: np.ndarray, base_c: float = 8.0):
    """GDD variant: progress through the crop cycle follows accumulated degree days (base 8 C) instead of calendar weeks."""
    total = C.CROPS[crop]["gdd_total"]; dur = C.CROP_DURATION[crop]
    gdd = np.clip(np.asarray(tmean_week, float) - base_c, 0, None) * 7
    names, weights = [], np.zeros(len(gdd)); acc = 0.0
    bounds = C.stage_bounds(crop)
    for w in range(len(gdd)):
        if w < sow_week:
            nm, wt = C.PRE_SOWING
        else:
            acc += gdd[w]
            t = acc / total * dur
            nm, wt = C.HARVESTED if t >= dur else next((b[0], b[3]) for b in bounds if b[1] <= t < b[2])
        names.append(nm); weights[w] = wt
    return names, weights


def detect_sowing(ndvi_smooth, crop: str, upto: int | None = None, frac: float = 0.2):
    """Phenology: estimated sowing week from a (smoothed) weekly NDVI series, or None if no green-up is visible.

    The seasonal range is measured from the fallow level (30th percentile of the pre-peak weeks) to the peak, so a field already green at the start of the record
    still works. `upto` restricts the series to the weeks available so far (real-time use).
    """
    y = np.asarray(ndvi_smooth, float)[: upto + 1 if upto is not None else None]
    if len(y) < 6:
        return None
    pk = int(np.argmax(y))
    lo = float(np.percentile(y[: pk + 1], 30))        # robust fallow level (a cloud-contaminated dip must not set the baseline)
    rng = y[pk] - lo
    if rng < 0.15:                                    # no real crop signal
        return None
    thr = lo + frac * rng
    below = np.where(y[: pk + 1] <= thr)[0]
    green = int(below[-1] + 1) if len(below) else 0   # last week at/below the threshold before the peak, +1 = first week above
    # linear interpolation between the two weeks around the crossing for sub-week accuracy
    if len(below) and green <= pk:
        a, b = y[green - 1], y[green]
        green_f = (green - 1) + (thr - a) / max(b - a, 1e-6)
    else:
        green_f = float(green)
    return int(round(green_f + 0.5 - C.CROPS[crop]["greenup_lag"]))
