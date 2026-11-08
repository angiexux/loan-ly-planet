"""Module 3 (METHODS 3): "is this week normal for THIS field?"  The heart of the system.

Every signal is compared with the field's own past, never with a regional average, so a naturally dry field is not flagged for
being dry, only for being drier than it usually is.

* NDVI / any weekly series: per field and week of the season, climatology = mean, sd, p10, p90 across the 21 history seasons.
      z = (value - mean) / sd            standardised anomaly
      percentile = share of past years below the value   (robust when the distribution is not bell-shaped)
* Rain: SPI, the WMO-standard Standardised Precipitation Index.  For a window of 30/60/90 days ending on the week's last day:
      1. total rain over the window, for every history season (same calendar window)
      2. fit a gamma distribution to those totals (zeros handled separately: P(total=0) = q)
      3. probability of this season's total:  p = q + (1 - q) * Gamma_cdf(total)   (the "mixed distribution")
      4. SPI = Normal_ppf(p)  -> 0 is normal, -1 is "moderately dry", -2 is "extremely dry"
  For speed the gamma shape/scale are fitted with the closed-form maximum-likelihood approximation (Thom/Greenwood),
  vectorised over all fields; `spi_1d()` uses scipy.stats.gamma.fit directly and is used in the tests to validate it.
* Soil moisture: percentile of the weekly SMAP mean among the same week in the history.
History seasons are scored against the same 21-season climatology (they are in-sample), the current season out-of-sample.
"""
from __future__ import annotations

import numpy as np
from scipy import stats
from scipy.special import gammainc

from . import config as C

H = C.N_HIST


def climatology(x: np.ndarray, n_hist: int = H, floor: float = 0.0):
    """x: (F, S, W). Mean, sd, p10, p90 of the first n_hist seasons -> four (F, W) arrays."""
    h = x[:, :n_hist]
    sd = np.maximum(np.nanstd(h, axis=1, ddof=1), floor)
    return np.nanmean(h, axis=1), sd, np.nanpercentile(h, 10, axis=1), np.nanpercentile(h, 90, axis=1)


def zscore(x, mean, sd):
    return (x - mean[:, None, :]) / sd[:, None, :]


def percentile_rank(x: np.ndarray, n_hist: int = H) -> np.ndarray:
    """Percentile (0-100) of x among the n_hist history values of the same field and week (ties count half)."""
    h = x[:, None, :n_hist, :]                       # (F,1,H,W)
    v = x[:, :, None, :]                             # (F,S,1,W)
    below = (h < v).sum(2) + 0.5 * (h == v).sum(2)
    return 100.0 * below / n_hist


def rolling_totals(rain_daily: np.ndarray, window: int) -> np.ndarray:
    """Rain over the `window` days ending on the last day of each week. rain_daily (F,S,364) -> (F,S,52); NaN before the record starts."""
    F, S, D = rain_daily.shape
    flat = rain_daily.reshape(F, S * D).astype(np.float64)
    csum = np.concatenate([np.zeros((F, 1)), np.cumsum(flat, axis=1)], axis=1)
    end = (np.arange(S)[:, None] * D + 7 * np.arange(C.W)[None, :] + 7)      # exclusive end index in the flat record
    start = end - window
    out = csum[:, end] - csum[:, np.clip(start, 0, None)]
    out[:, start < 0] = np.nan
    return out


def _gamma_params(pos_mean, pos_meanlog):
    """Closed-form ML approximation of the gamma shape (alpha) and scale from mean(x) and mean(log x)."""
    A = np.maximum(np.log(pos_mean) - pos_meanlog, 1e-6)
    alpha = (1 + np.sqrt(1 + 4 * A / 3)) / (4 * A)
    return alpha, pos_mean / alpha


def spi(totals: np.ndarray, n_hist: int = H) -> np.ndarray:
    """totals (F,S,W) window rain totals -> SPI (F,S,W) fitted on the first n_hist seasons of each field and week."""
    h = totals[:, :n_hist]
    valid = ~np.isnan(h)
    n = np.maximum(valid.sum(1), 1)
    q = ((h == 0) & valid).sum(1) / n
    pos = np.where(valid & (h > 0), h, np.nan)
    with np.errstate(all="ignore"):
        m = np.nanmean(pos, axis=1)
        ml = np.nanmean(np.log(pos), axis=1)
    bad = ~np.isfinite(m) | ~np.isfinite(ml)
    alpha, scale = _gamma_params(np.where(bad, 1.0, m), np.where(bad, 0.0, ml))
    alpha = np.where(bad, 1.0, alpha)
    G = gammainc(alpha[:, None, :], np.maximum(totals, 0) / scale[:, None, :])
    p = q[:, None, :] + (1 - q[:, None, :]) * G                    # mixed distribution: zero-rain probability + gamma
    out = stats.norm.ppf(np.clip(p, 1e-3, 1 - 1e-3))
    return np.where(np.isnan(totals), 0.0, out)


def spi_1d(sample, x):
    """Reference implementation with scipy.stats.gamma.fit (MLE, location fixed at 0) for one calendar window."""
    sample = np.asarray(sample, float)
    q = np.mean(sample == 0)
    a, loc, scale = stats.gamma.fit(sample[sample > 0], floc=0)
    p = q + (1 - q) * stats.gamma.cdf(np.asarray(x, float), a, loc=0, scale=scale)
    return stats.norm.ppf(np.clip(p, 1e-3, 1 - 1e-3))


def compute(wk: dict, rain_daily: np.ndarray) -> dict:
    """Everything module 3 outputs, as arrays (F,S,W) unless noted ((F,W) for climatologies)."""
    out = {}
    mean, sd, p10, p90 = climatology(wk["ndvi"], floor=C.NDVI_SD_FLOOR)
    out.update(clim_mean=mean, clim_sd=sd, clim_p10=p10, clim_p90=p90,
               ndvi_z=zscore(wk["ndvi"], mean, sd), ndvi_pct=percentile_rank(wk["ndvi"]))
    for w in C.SPI_WINDOWS:
        out[f"spi{w}"] = spi(rolling_totals(rain_daily, w))
    out["sm_pct"] = percentile_rank(wk["soil"])
    out["rain_normal"] = np.nanmean(wk["rain"][:, :H], axis=1)
    return out
