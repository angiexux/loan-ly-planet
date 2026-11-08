"""SYNTHETIC "raw source" generator: imitates what Google Earth Engine would return, so that the real cleaning,
anomaly and risk code runs on realistic, messy data. Everything here is fake and deterministic (seeded).

What is generated, per field, for 22 seasons (2004/05 ... 2024/25 history + 2025/26 current), each 364 days = 52 weeks
starting 1 June:
  * CHIRPS-like daily rain (zero-rain days, seasonal cycle, regional drought years, the 2025/26 drought scenario)
  * ERA5-Land-like daily tmin/tmax (heat waves Dec 2025-Jan 2026, frosts Sep-Oct 2025)
  * SMAP-like soil moisture (volumetric, from a simple daily water balance, with swath gaps)
  * Sentinel-1-like weekly water fraction (a few fields in Entre Rios / Rio Grande do Sul flood after the March 2026 storms)
  * Sentinel-2-like NDVI *image observations* every ~5 days with a cloud flag (28-50 % cloudy, more in summer) plus
    occasional cloud-contaminated values that slip past the mask
A toy crop model (water stress, heat, frost, hail) turns the weather into NDVI and a yield loss, which also produces
  * a department-level yield history per region x crop (with a trend) for the stress-to-yield regression, and
  * a simulated outcome (realised yield anomaly, default) per loan, used only for the back-test.
Fields in the same region share part of the weather (regional drought severity, temperature noise, frost nights).

`build_demo_book()` also writes the 240-loan demo workbook (data/demo_loan_book.xlsx) in the CONTRACT section A format.
"""
from __future__ import annotations

import math
import zlib
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
from scipy.special import ndtr

from . import config as C

W, D, S, H = C.W, C.DAYS, C.N_SEASONS, C.N_HIST
CUR = C.CUR

# severity of each past season (fraction of rain missing at full regional sensitivity); 2008/09, 2011/12, 2017/18 are the dry ones
# keyed by calendar start year (looked up by value from C.HIST_YEARS)
HIST_SEV = {2004: -.1, 2005: .2, 2006: -.25, 2007: .1, 2008: .8, 2009: -.3, 2010: .1, 2011: .55,
            2012: -.25, 2013: .05, 2014: -.15, 2015: -.2, 2016: .1, 2017: .7, 2018: -.1, 2019: .3, 2020: .35, 2021: .45, 2022: .05, 2023: -.2, 2024: .15}
RAIN_SPATIAL_CORR = 0.85
_WK = np.arange(W)
# rain deficit through the current season at full severity (the old dekad profile re-expressed in weeks)
PROFILE_2223 = np.interp(_WK, np.array([0, 6, 9, 12, 15, 18, 21, 24, 27, 30, 35]) * 10 / 7, [0.25, 0.35, 0.55, 0.65, 0.65, 0.7, 0.8, 0.75, 0.45, 0.15, 0.05])
PROFILE_HIST = np.interp(_WK, np.array([0, 12, 21, 30, 35]) * 10 / 7, [0.6, 0.9, 1, 0.6, 0.3])
# heat waves (deg C added to tmax): mid-Dec to Jan, a short one in early March
HEAT_2223 = np.zeros(W)
HEAT_2223[27:36] = [1.5, 2.5, 3.5, 4.5, 4.0, 3.5, 3.0, 2.0, 1.0]
HEAT_2223[40] = 2.5

_DATES = [C.SEASON_START + timedelta(days=i) for i in range(D)]
_DOY = np.array([d.timetuple().tm_yday for d in _DATES])
SEASON_ANGLE = 2 * np.pi * (_DOY - 1) / 365.0          # cos(angle) = 1 on 1 January (peak summer)
WEEK_ANGLE = SEASON_ANGLE.reshape(W, 7).mean(1)


def seed_from(*parts) -> int:
    return zlib.crc32("|".join(str(p) for p in parts).encode()) & 0xFFFFFFFF


def hav_km(lat1, lng1, lat2, lng2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lng2 - lng1) / 2) ** 2
    return 2 * 6371.0 * np.arcsin(np.sqrt(a))


def nearest_region(lat: float, lng: float):
    d = [float(hav_km(lat, lng, r["lat"], r["lng"])) for r in C.REGIONS]
    i = int(np.argmin(d))
    return C.REGIONS[i], d[i]


def typical_sow_week(crop: str, lat: float, lng: float) -> int:
    """Deterministic 'true' sowing week of a field (typical week +-3), so blank sowing dates can be recovered by phenology."""
    rng = np.random.default_rng(seed_from("sow", round(lat, 4), round(lng, 4)))
    return int(np.clip(C.CROPS[crop]["sow_week"] + rng.integers(-3, 4), 0, W - C.CROP_DURATION[crop] - 1))


def field_ref_yield(crop: str, lat: float, lng: float, irrigated: bool) -> float:
    rng = np.random.default_rng(seed_from("yld", round(lat, 4), round(lng, 4)))
    return float(C.CROPS[crop]["yield_tha"] * rng.uniform(0.85, 1.15) * (1.1 if irrigated else 1.0))


# ------------------------------------------------------------------------------------------------ regional shared weather
@lru_cache(maxsize=None)
def region_climate(rid: str):
    reg = C.REGION_BY_ID[rid]
    rng = np.random.default_rng(seed_from("region", rid))
    hs = np.array([HIST_SEV[y] * reg["hist"] for y in C.HIST_YEARS] + [reg["sev"]]) + np.r_[rng.normal(0, 0.12, H), 0.0]
    shared_prof = rng.normal(0, 0.10, (S, W))
    storm_z = rng.normal(0, 1, (S, D))          # regional 'storm field': neighbouring fields rain on the same days
    storm_amt = rng.gamma(0.8, 1.25, (S, D))    # and get similar amounts (mean 1)
    # AR(1) daily temperature noise shared by the fields of a region
    e = rng.normal(0, 1, (S, D))
    tn = np.zeros((S, D))
    for i in range(1, D):
        tn[:, i] = 0.7 * tn[:, i - 1] + e[:, i]
    tn *= 2.2 / tn.std()
    # frost nights Sep-Oct (weeks 14-22): history ~Poisson(0.7), the current season a cold spell of 3-4 nights
    frost = []
    for s in range(S):
        n = int(rng.integers(3, 5)) if s == CUR else int(rng.poisson(0.7))
        frost.append(sorted(int(x) for x in rng.integers(14 * 7 + 4, 22 * 7, n)))
    cur_frost_lat_factor = 1.0 if reg["lat"] < -32 else 0.4
    return dict(hs=hs, shared_prof=shared_prof, storm_z=storm_z, storm_amt=storm_amt, tn=tn, frost=frost, cur_frost_p=cur_frost_lat_factor)


def rain_normal_week(lat: float) -> np.ndarray:
    """Normal weekly rain (mm): wet summer, dry winter, drier to the south-west."""
    m = WEEK_ANGLE
    base = 6 + 34 * (0.5 + 0.5 * np.cos(m)) + 6 * np.sin(m - np.pi / 2 + np.pi / 4)
    return np.clip(base * (1 + (lat + 33) * -0.03), 4, 70) * 0.7


def tmax_normal_day(lat: float) -> np.ndarray:
    return 22 + 7 * np.cos(SEASON_ANGLE) + (lat + 33) * 0.3


# ------------------------------------------------------------------------------------------------ container
@dataclass
class Sources:
    field_ids: list
    lat: np.ndarray
    lng: np.ndarray
    crop: list
    region_id: list
    irrigated: np.ndarray
    sow_true: np.ndarray               # (F,) true sowing week of the current season
    rain: np.ndarray                   # (F, S, 364) mm/day
    tmin: np.ndarray                   # (F, S, 364) deg C
    tmax: np.ndarray
    soil: np.ndarray                   # (F, S, 364) m3/m3, NaN where SMAP has no swath
    water: np.ndarray                  # (F, S, 52) Sentinel-1 water fraction, NaN where no pass
    ndvi_day: np.ndarray               # (F, S, K) day of season of each image
    ndvi_val: np.ndarray               # (F, S, K)
    ndvi_cloud: np.ndarray             # (F, S, K) bool, True = flagged cloudy (SCL classes)
    loss: np.ndarray                   # (F, S) yield loss vs the field's own average season (toy crop model; positive = below trend)
    hail_week: np.ndarray              # (F,) week of the current-season hail event or -1
    flood_week: np.ndarray             # (F,) week of the current-season flood or -1
    notes: dict = field(default_factory=dict)


# ------------------------------------------------------------------------------------------------ generator
def generate_sources(specs: list[dict]) -> Sources:
    """specs: [{field_id, lat, lng, crop, sow_week, irrigated}]. Deterministic per field (seeded from lat/lng)."""
    F = len(specs)
    K = 73
    rain = np.zeros((F, S, D), np.float32); tmax = np.zeros_like(rain); tmin = np.zeros_like(rain)
    water = np.full((F, S, W), np.nan, np.float32)
    nd_day = np.zeros((F, S, K), np.int16); nd_cloud_u = np.zeros((F, S, K), np.float32); nd_noise = np.zeros((F, S, K), np.float32)
    nd_slip = np.zeros((F, S, K), np.float32); nd_cvalue = np.zeros((F, S, K), np.float32)
    sm_noise = np.zeros((F, S, D), np.float32); sm_gap = np.zeros((F, S, D), bool)
    sow = np.zeros((F, S), int); loss_noise = np.zeros((F, S)); ndvi_noise = np.zeros((F, S, W), np.float32)
    hail_w = np.full((F, S), -1); flood_w = np.full(F, -1)
    rid_list, rnorm = [], np.zeros((F, W))
    irr = np.array([bool(s.get("irrigated")) for s in specs])
    crops = [s["crop"] for s in specs]
    sevs = np.zeros(F)
    for f, sp in enumerate(specs):
        lat, lng = float(sp["lat"]), float(sp["lng"])
        reg, _ = nearest_region(lat, lng)
        rid_list.append(reg["id"])
        rc = region_climate(reg["id"])
        rng = np.random.default_rng(seed_from("field", round(lat, 4), round(lng, 4)))
        hs = rc["hs"] + np.r_[rng.normal(0, 0.06, H), 0.0]
        sev = float(np.clip(reg["sev"] + rng.normal(0, 0.12), 0, 1.1)); hs[CUR] = sev; sevs[f] = sev
        shape = np.tile(PROFILE_HIST, (S, 1)); shape[CUR] = PROFILE_2223
        prof = np.clip(hs[:, None] * shape + rc["shared_prof"] + rng.normal(0, 0.09, (S, W)), -1.2, 0.95)
        rn = rain_normal_week(lat); rnorm[f] = rn
        mu = 5 + 0.12 * rn
        p_wet = np.clip(rn / (7 * mu), 0.05, 0.7)
        prof_d = np.repeat(prof, 7, axis=1)
        p_eff = np.clip(np.repeat(p_wet, 7)[None] * (1 - prof_d), 0.01, 0.85)
        rho = RAIN_SPATIAL_CORR                   # Gaussian copula: same storm days as the neighbours, with local differences
        u = ndtr(rho * rc["storm_z"] + math.sqrt(1 - rho ** 2) * rng.normal(0, 1, (S, D)))
        amt = rc["storm_amt"] * np.exp(rng.normal(0, 0.3, (S, D)) - 0.045) * (np.repeat(mu, 7)[None] * np.clip(1 - 0.3 * prof_d, 0.5, 1.4))
        rain[f] = np.where(u < p_eff, amt, 0.0)
        # temperature
        hshock = np.clip(rng.normal(np.clip(hs, 0, None)[:, None] * 1.2, 0.8, (S, W)), 0, None) * ((_WK >= 24) & (_WK <= 37))[None]
        hshock[CUR] = HEAT_2223 * (0.8 + 0.6 * sev) + rng.normal(0, 0.5, W) * (HEAT_2223 > 0)
        tn = tmax_normal_day(lat)[None] + np.repeat(hshock, 7, axis=1) + rc["tn"] + rng.normal(0, 1.2, (S, D))
        tmax[f] = tn
        tmin[f] = (tmax_normal_day(lat) - 11)[None] + np.repeat(hshock, 7, axis=1) * 0.5 + rc["tn"] * 0.8 + rng.normal(0, 1.5, (S, D))
        for s in range(S):
            if s == CUR and rng.random() > rc["cur_frost_p"]:
                continue
            for d in rc["frost"][s]:
                tmin[f, s, d] = min(tmin[f, s, d], rng.uniform(-5, -2.5) + rng.normal(0, 0.8))
        # sowing, noise draws for the crop model
        sw = int(sp["sow_week"]); dur = C.CROP_DURATION[sp["crop"]]
        sow[f] = np.clip(sw + rng.integers(-1, 2, S), 0, W - dur - 1); sow[f, CUR] = sw
        loss_noise[f] = rng.normal(0, 0.05, S); ndvi_noise[f] = rng.normal(0, 0.012, (S, W))
        for s in range(S):
            if rng.random() < (0.06 if s == CUR else 0.04):
                hail_w[f, s] = int(sow[f, s] + rng.integers(4, dur - 3))
        if reg["id"] in ("AR-ER", "BR-RS") and rng.random() < 0.12:
            flood_w[f] = int(rng.integers(40, 44))
        # radar water fraction: small baseline, passes every ~10 days
        wf = np.abs(rng.normal(0.01, 0.01, (S, W))); wf[rng.random((S, W)) < 0.35] = np.nan
        water[f] = wf
        if flood_w[f] >= 0:
            water[f, CUR, flood_w[f]:flood_w[f] + 2] = rng.uniform(0.2, 0.6)
        # image acquisition times and randomness
        nd_day[f] = np.clip(5 * np.arange(K)[None] + rng.integers(-1, 2, (S, K)), 0, D - 1)
        nd_cloud_u[f] = rng.random((S, K)); nd_noise[f] = rng.normal(0, 0.02, (S, K)); nd_slip[f] = rng.random((S, K))
        nd_cvalue[f] = rng.uniform(0.15, 0.6, (S, K))
        sm_noise[f] = rng.normal(0, 0.012, (S, D)); sm_gap[f] = rng.random((S, D)) < 0.25

    # --- soil water balance (vectorised over fields), continuous across seasons
    rain_c = rain.reshape(F, S * D); tmax_c = tmax.reshape(F, S * D)
    store = np.full(F, 70.0); soil_mm = np.zeros((F, S * D), np.float32)
    for i in range(S * D):
        et = (1.0 + 0.11 * np.maximum(tmax_c[:, i] - 8, 0)) * np.minimum(1.0, store / 50.0)
        store = np.clip(store + rain_c[:, i] - et, 0, 120)
        store = np.where(irr, np.maximum(store, 60.0), store)
        soil_mm[:, i] = store
    soil = (0.06 + 0.34 * soil_mm.reshape(F, S, D) / 120.0 + sm_noise).astype(np.float32)
    soil[sm_gap] = np.nan

    # --- toy crop model, weekly, vectorised over (field, season)
    rain_w = rain.reshape(F, S, W, 7).sum(-1); hot_w = (tmax > C.SM_HOT_C).reshape(F, S, W, 7).sum(-1)
    fr_w = np.clip(C.FROST_C - tmin, 0, None).reshape(F, S, W, 7).sum(-1)
    dur = np.array([C.CROP_DURATION[c] for c in crops]); win = np.array([C.critical_window(c) for c in crops])
    is_wheat = np.array([c == "wheat" for c in crops])
    t = _WK[None, None, :] - sow[:, :, None]
    wstate = np.zeros((F, S)); sstate = np.zeros((F, S)); s_all = np.zeros((F, S, W))
    irr_f = np.where(irr, 0.3, 1.0)[:, None]
    for i in range(W):
        deficit = np.clip(1 - rain_w[:, :, i] / rnorm[:, i][:, None], -1, 1) * irr_f
        wstate = 0.86 * wstate + 0.14 * deficit
        ti = t[:, :, i]
        on = (ti >= 0) & (ti <= dur[:, None])
        near = (ti >= win[:, 0:1] - 2) & (ti <= win[:, 1:2] + 2)
        heat_x = 0.05 * np.maximum(hot_w[:, :, i] - 1, 0) * np.where(near, 1.0, 0.4) * np.where(irr, 0.0, 1.0)[:, None]
        frost_x = 0.04 * fr_w[:, :, i] * (is_wheat[:, None] & (ti >= win[:, 0:1] - 3) & (ti <= win[:, 1:2]))
        x = np.maximum(wstate, 0) * 0.9 + heat_x + frost_x
        sstate = np.where(on, np.maximum(0.89 * sstate, x), 0.0)
        s_all[:, :, i] = sstate
    wmask = (t >= win[:, 0, None, None]) & (t <= win[:, 1, None, None]); onmask = (t >= 0) & (t <= dur[:, None, None])
    sw_ = (s_all * wmask).sum(2) / np.maximum(wmask.sum(2), 1); ms_ = (s_all * onmask).sum(2) / np.maximum(onmask.sum(2), 1)
    loss = np.clip(0.75 * np.clip(sw_, 0, None) ** 1.3 + 0.12 * ms_ - 0.04 + loss_noise, -0.15, 0.95)
    hailed = (hail_w >= 0) & (hail_w - sow >= 0) & (hail_w - sow <= dur[:, None])
    loss = np.where(hailed, np.minimum(0.95, loss + 0.25), loss)

    loss = loss - loss[:, :H].mean(1, keepdims=True)       # anomaly vs the field's average season (= trend yield)

    # --- true weekly NDVI
    amp = np.array([dict(soy=.62, maize=.66, wheat=.55, sunflower=.5)[c] for c in crops])[:, None, None]
    up = 1 / (1 + np.exp(-(t - dur[:, None, None] * 0.28) / 1.6)); down = 1 / (1 + np.exp((t - dur[:, None, None] * 0.82) / 1.4))
    ndvi_t = 0.22 + amp * up * down
    ndvi_t = np.where(t < 0, 0.24 + 0.03 * np.sin(_WK)[None, None, :], ndvi_t)
    ndvi_t = ndvi_t * (1 - 0.6 * np.clip(s_all, 0, 1)) + ndvi_noise
    for f in range(F):
        for s in range(S):
            h = hail_w[f, s]
            if h >= 0:
                dip = np.array([0.22, 0.16, 0.10, 0.05])[: max(0, min(4, W - h))]
                ndvi_t[f, s, h:h + len(dip)] -= dip
        if flood_w[f] >= 0:
            ndvi_t[f, CUR, flood_w[f]:flood_w[f] + 3] -= 0.12
    ndvi_t = np.clip(ndvi_t, 0.05, 0.95)

    # --- image observations: sample the weekly truth at the acquisition day, add noise, clouds, slipped contamination
    pos = np.clip(nd_day / 7.0 - 0.5, 0, W - 1.0001); i0 = np.floor(pos).astype(int); fr = pos - i0
    v = np.take_along_axis(ndvi_t, i0, 2) * (1 - fr) + np.take_along_axis(ndvi_t, i0 + 1, 2) * fr + nd_noise
    p_cloud = 0.28 + 0.22 * (0.5 + 0.5 * np.cos(SEASON_ANGLE[nd_day]))
    cloud = nd_cloud_u < p_cloud
    slip = (~cloud) & (nd_slip < 0.04)
    v = np.where(slip, v - np.random.default_rng(1).uniform(0.12, 0.35, v.shape), v)
    v = np.where(cloud, v * nd_cvalue, v)
    ndvi_val = np.clip(v, 0.0, 0.95).astype(np.float32)

    return Sources(field_ids=[s["field_id"] for s in specs], lat=np.array([s["lat"] for s in specs], float), lng=np.array([s["lng"] for s in specs], float),
                   crop=crops, region_id=rid_list, irrigated=irr, sow_true=np.array([int(s["sow_week"]) for s in specs]),
                   rain=rain, tmin=tmin.astype(np.float32), tmax=tmax.astype(np.float32), soil=soil, water=water,
                   ndvi_day=nd_day, ndvi_val=ndvi_val, ndvi_cloud=cloud, loss=loss, hail_week=hail_w[:, CUR], flood_week=flood_w,
                   notes=dict(sev=sevs))


# ------------------------------------------------------------------------------------------------ SYNTHETIC ET / PET (Crop Health Index inputs)
def et_pet_weekly(src: Sources, wk: dict):
    """SYNTHETIC weekly potential and actual evapotranspiration, mm per WEEK, shape (F, S, W) each. Does not touch the random
    streams of `generate_sources` (own seeded generator), so every other output is unchanged. DISPLAY inputs of the FHI only.

    PET: Hargreaves-Samani, PET_day = 0.0023 * Ra * (Tmean + 17.8) * sqrt(Tmax - Tmin), with Ra (extraterrestrial radiation, mm/day
    of evaporation equivalent) following the seasonal cycle (12 + 6 cos(angle): ~18 at the summer solstice, ~6 in winter), summed over the week.
    ET = PET x kc x f(soil):  kc = crop cover factor 0.35 -> 1.0 with the (smoothed) NDVI;  f = water-stress factor, 1 above ~30 %
    volumetric soil moisture, falling linearly to 0.05 at 12 %.  So ET falls below PET in the current-season drought and recovers with rain.
    """
    F = len(src.field_ids)
    t = lambda a: a.astype(np.float64).reshape(F, S, W, 7)
    tmax, tmin = t(src.tmax), t(src.tmin)
    tmean = 0.5 * (tmax + tmin)
    ra = 12.0 + 6.0 * np.cos(SEASON_ANGLE).reshape(1, 1, W, 7)
    pet_day = 0.0023 * ra * (tmean + 17.8) * np.sqrt(np.clip(tmax - tmin, 1.0, None))
    pet = np.clip(pet_day, 0.2, None).sum(-1)
    soil = np.asarray(wk["soil"], float)
    f_stress = np.clip((soil - 0.12) / (0.30 - 0.12), 0.05, 1.0)
    kc = 0.35 + 0.65 * np.clip((np.asarray(wk["ndvi"], float) - 0.2) / 0.6, 0, 1)
    noise = np.stack([np.random.default_rng(seed_from("etpet", round(float(src.lat[f]), 4), round(float(src.lng[f]), 4))).normal(0, 0.03, (S, W)) for f in range(F)])
    et = np.minimum(pet * kc * f_stress * (1 + noise), pet * 1.0)
    return np.round(et, 2), np.round(pet, 2)


# ------------------------------------------------------------------------------------------------ department yields & outcomes
def department_yields(src: Sources) -> dict:
    """Synthetic department-level yield history per (region, crop): the mean toy-model loss of the book's fields in the
    group plus sampling noise, on top of a technology trend of ~1.2 %/yr. Real use: official department statistics."""
    out = {}
    groups = {}
    for f, (rid, crop) in enumerate(zip(src.region_id, src.crop)):
        groups.setdefault((rid, crop), []).append(f)
    for (rid, crop), idx in groups.items():
        rng = np.random.default_rng(seed_from("dept", rid, crop))
        n = len(idx)
        anom = -src.loss[idx, :H].mean(0) + rng.normal(0, 0.03 + 0.08 / math.sqrt(n), H)
        base = C.CROPS[crop]["yield_tha"] * rng.uniform(0.9, 1.1)
        trend = 1 + 0.012 * np.arange(H)
        out[(rid, crop)] = dict(years=list(C.HIST_YEARS), anom=np.clip(anom, -0.95, 0.5), tha=base * trend * (1 + np.clip(anom, -0.95, 0.5)),
                                n_fields=n, base_tha=float(base))
    return out


def simulate_outcome(loan: dict, loss: float, ref_yield: float) -> dict:
    """Back-test only: realised yield anomaly and whether the loan defaulted. Default is more likely when the season
    failed and margins were thin (revenue / debt service), and less likely when insurance pays."""
    rng = np.random.default_rng(seed_from("outcome", round(loan["lat"], 4), round(loan["lng"], 4)))
    pd12 = min(max(loan["pdOrig"], 1e-4), 0.9)
    rev = loan["areaHa"] * ref_yield * (1 - max(0.0, loss)) * C.CROPS[loan["crop"]]["price"]
    cover = rev / max(1.0, loan["amountUsd"] * 1.12)
    z = 0.5 * math.log(pd12 / (1 - pd12)) - 2.5 + 12.0 * max(0.0, loss - 0.05) + 1.0 * max(0.0, 1 - cover)
    p = 1 / (1 + math.exp(-z))
    ins = loan.get("insurance")
    if ins and "drought" in ins["perils"] and loss > 0.3:
        p *= 0.45
    return dict(yieldAnom=round(-float(loss), 3), defaulted=bool(rng.random() < p))


# ------------------------------------------------------------------------------------------------ demo loan book
NAMES = ["La Esperanza", "El Ombú", "Los Talas", "San José", "La Carolina", "Las Acacias", "El Trébol", "Santa Rita", "La Aurora", "Los Cardos",
         "La Celina", "El Mirador", "Las Lomas", "San Martín", "La Querencia", "El Recreo", "Los Paraísos", "Santa Elena", "La Margarita", "El Porvenir",
         "Don Bosco", "La Blanqueada", "Los Molles", "El Chañar", "La Rinconada", "San Pedro", "Las Rosas", "El Sauce", "La Victoria", "Tres Lagunas"]
PREFIX = ["Estancia", "Agropecuaria", "Establecimiento", "Campo", "Granja", "Cooperativa"]
SUFFIX = {"Argentina": ["S.A.", "S.R.L.", "S.A.S.", ""], "Uruguay": ["S.A.", "Ltda.", ""], "Brazil": ["Ltda.", "S.A.", ""], "Paraguay": ["S.A.", "S.R.L.", ""]}
DEPT = {"AR-SF": ["Castellanos", "San Martín", "Las Colonias"], "AR-BN": ["Pergamino", "Junín", "Colón"], "AR-ER": ["Paraná", "Victoria", "Diamante"],
        "AR-CS": ["Río Cuarto", "General Roca", "Juárez Celman"], "AR-LP": ["Realicó", "Chapaleufú", "Quemú Quemú"], "AR-BS": ["Tres Arroyos", "Necochea", "Balcarce"],
        "AR-SA": ["Anta", "Metán", "Rosario de la Frontera"], "UY-SO": ["Dolores", "Cardona", "Mercedes"], "BR-RS": ["Santo Ângelo", "Cruz Alta", "Ijuí"],
        "PY-IT": ["Capitán Miranda", "Hohenau", "Obligado"]}


def _rect_wkt(lat, lng, ha, rng):
    a = math.sqrt(ha * 1e4 * rng.uniform(1.3, 2.6)); b = ha * 1e4 / a; th = rng.uniform(0, math.pi)
    pts = []
    for dx, dy in ((-a / 2, -b / 2), (a / 2, -b / 2), (a / 2, b / 2), (-a / 2, b / 2), (-a / 2, -b / 2)):
        x = dx * math.cos(th) - dy * math.sin(th); y = dx * math.sin(th) + dy * math.cos(th)
        pts.append(f"{lng + x / (111320 * math.cos(math.radians(lat))):.5f} {lat + y / 110540:.5f}")
    return "POLYGON((" + ", ".join(pts) + "))"


def build_demo_book(path) -> Path:
    """Write the demo loan book (240 loans, 10 regions) as an .xlsx in the CONTRACT section A format."""
    import pandas as pd
    snapshot = C.WEEK_DATES[C.AS_OF_DEFAULT]
    farmers, fields, loans, reps, ins_rows = [], [], [], [], []
    k = 0
    pairs = {}
    for reg in C.REGIONS:
        crops, wts = zip(*reg["crops"].items()); wts = np.array(wts) / sum(wts)
        for j in range(reg["n"]):
            k += 1
            rng = np.random.default_rng(1000 + k)
            crop = str(rng.choice(crops, p=wts)); cc = C.CROPS[crop]; dur = C.CROP_DURATION[crop]
            lat = round(reg["lat"] + rng.normal(0, 0.45), 4); lng = round(reg["lng"] + rng.normal(0, 0.55), 4)
            area = float(np.clip(np.round(rng.lognormal(math.log(320), 0.6)), 40, 2500))
            irrigated = bool(rng.random() < 0.05)
            sw = typical_sow_week(crop, lat, lng)
            sow_date = C.WEEK_DATES[0] + timedelta(days=7 * sw + int(rng.integers(0, 7)))
            orig = C.WEEK_DATES[0] + timedelta(days=7 * max(0, sw - 4 - int(rng.integers(0, 3))) + int(rng.integers(0, 7)))
            mat = C.WEEK_DATES[0] + timedelta(days=7 * min(W + 2, sw + dur + int(rng.integers(3, 7))) + int(rng.integers(0, 7)))
            amount = float(max(5000, np.round(area * cc["cost_ha"] * rng.uniform(0.6, 1.1), -3)))
            rate = float(np.round(np.clip(rng.normal(10.5, 1.5), 7, 15), 2))
            coll = str(rng.choice(["land mortgage", "crop pledge", "warrant on grain", "machinery pledge", "unsecured"], p=[.28, .36, .14, .07, .15]))
            cval = {"land mortgage": rng.uniform(1.5, 3.0), "crop pledge": rng.uniform(0.9, 1.4), "warrant on grain": rng.uniform(1.0, 1.3),
                    "machinery pledge": rng.uniform(0.6, 1.2), "unsecured": 0.0}[coll] * amount
            rating = int(rng.choice([2, 3, 4, 5, 6], p=[.12, .3, .32, .18, .08]))
            pd12 = float(np.round(C.PD_BY_RATING[rating] * rng.uniform(0.8, 1.25), 4))
            lgd = float(np.round(np.clip(C.LGD_BY_COLLATERAL[coll] + rng.normal(0, 0.03), 0.15, 0.8), 3))
            inst = bool(rng.random() < 0.35)
            r_ins = rng.random()
            farm = float(np.round(area * rng.uniform(1, 3.5)))
            other = float(np.round(amount * rng.uniform(0, 1.2), -3)) if rng.random() < 0.7 else 0.0
            name = f"{rng.choice(PREFIX)} {rng.choice(NAMES)} {rng.choice(SUFFIX[reg['country']])}".strip()
            blank = bool(rng.random() < 0.035)
            poly = _rect_wkt(lat, lng, area, rng) if rng.random() < 0.8 else ""
            d = dict(k=k, reg=reg, crop=crop, lat=lat, lng=lng, area=area, irrigated=irrigated, sow_date=None if blank else sow_date, orig=orig, mat=mat,
                     amount=amount, rate=rate, coll=coll, cval=cval, rating=rating, pd12=pd12, lgd=lgd, inst=inst, r_ins=r_ins, farm=farm, other=other,
                     name=name, poly=poly, bcra=1, dpd=0, rng=rng)
            loans.append(d)
    # farmers with two loans in the same region
    rng0 = np.random.default_rng(77)
    share = set()
    for i in rng0.permutation(len(loans) - 1):
        if len(share) >= 12:
            break
        if loans[i]["reg"]["id"] == loans[i + 1]["reg"]["id"] and i not in share and (i - 1) not in share and (i + 1) not in share:
            share.add(i)
    fid = 0
    for i, d in enumerate(loans):
        if i - 1 in share:
            d["farmer"] = loans[i - 1]["farmer"]; d["name"] = loans[i - 1]["name"]; d["farm"] = loans[i - 1]["farm"]
            continue
        fid += 1; d["farmer"] = f"F{fid:03d}"
    # delinquent loans: (situacion, days past due)
    perm = rng0.permutation(len(loans))
    plan = [(2, 38), (2, 55), (2, 78), (3, 105), (3, 140), (3, 170), (4, 215), (4, 260)]
    for n, (sit, dpd) in enumerate(plan):
        d = loans[int(perm[n])]
        d["bcra"], d["dpd"] = sit, dpd
        due1 = snapshot - timedelta(days=dpd)
        d["orig"] = due1 - timedelta(days=int(d["rng"].integers(70, 130)))
        if n % 2 == 0:
            d["inst"] = False; d["mat"] = due1
        else:
            d["inst"] = True; d["due1"] = due1; d["mat"] = due1 + timedelta(days=90)
    # build sheets
    seen = set()
    for i, d in enumerate(loans):
        reg = d["reg"]; rng = d["rng"]
        fno = d["k"]
        if d["farmer"] not in seen:
            seen.add(d["farmer"])
            tax = f"20-{int(rng.integers(10_000_000, 40_000_000))}-{int(rng.integers(0, 10))}"
            farmers.append(dict(farmer_id=d["farmer"], name=d["name"], tax_id=tax, country=reg["country"], province=reg["province"],
                                department=str(rng.choice(DEPT[reg["id"]])), farm_ha=d["farm"], years_as_client=int(rng.integers(1, 16)),
                                other_bank_debt_usd=d["other"], notes="synthetic"))
        fields.append(dict(field_id=f"P{fno:03d}", farmer_id=d["farmer"], lat=d["lat"], lng=d["lng"], polygon_wkt=d["poly"], area_ha=d["area"],
                           crop=d["crop"], sowing_date=d["sow_date"].isoformat() if d["sow_date"] else "", irrigated="yes" if d["irrigated"] else "no"))
        lid = f"L{fno:03d}"
        loans_row = dict(loan_id=lid, farmer_id=d["farmer"], field_id=f"P{fno:03d}",
                         product="Pre-harvest loan" if d["crop"] in ("wheat", "sunflower") else "Crop input loan", amount_usd=d["amount"],
                         origination_date=d["orig"].isoformat(), maturity_date=d["mat"].isoformat(), rate_pct=d["rate"],
                         amortization="installments" if d["inst"] else "bullet", rating_origination=d["rating"], pd_12m_origination=d["pd12"],
                         lgd_bank=d["lgd"], collateral_type=d["coll"], collateral_value_usd=float(np.round(d["cval"], -2)),
                         bcra_situacion=d["bcra"], days_past_due=d["dpd"])
        d["loan_row"] = loans_row
        # schedule
        o, m = d["orig"], d["mat"]
        if d["inst"]:
            if "due1" in d:
                dues = [d["due1"], d["due1"] + timedelta(days=45), d["mat"]]
            else:
                span = (m - o).days
                dues = [o + timedelta(days=int(span * 0.55)), o + timedelta(days=int(span * 0.8)), m]
            shares = [0.3, 0.3, 0.4]
        else:
            dues, shares = [m], [1.0]
        out, prev, stuck = d["amount"], o, False
        for due, sh in zip(dues, shares):
            prin = float(np.round(d["amount"] * sh, 0)); inte = float(np.round(out * d["rate"] / 100 * (due - prev).days / 365, 0))
            paid_date = paid_usd = ""
            if due <= snapshot and d["dpd"] == 0 and not stuck:
                pdte = due + timedelta(days=int(d["rng"].integers(0, 5)))
                if pdte <= snapshot:
                    paid_date, paid_usd = pdte.isoformat(), prin + inte
            elif due <= snapshot:
                stuck = True
            reps.append(dict(loan_id=lid, due_date=due.isoformat(), principal_usd=prin, interest_usd=inte, paid_date=paid_date, paid_usd=paid_usd))
            out -= prin; prev = due
        # insurance
        r = d["r_ins"]
        if r < 0.35:
            t, perils, cover = "indemnity", "hail", float(np.round(d["rng"].uniform(0.6, 0.9), 2)); trig = ""
        elif r < 0.43:
            t, perils, cover = "parametric", "drought", float(np.round(d["rng"].uniform(0.4, 0.7), 2)); trig = "SPI-60 < -1.5 between flowering and grain fill"
        elif r < 0.47:
            t, perils, cover = "multi-peril", "drought, excess_water, frost, heat, hail", float(np.round(d["rng"].uniform(0.5, 0.8), 2)); trig = ""
        else:
            t = None
        if t:
            ins_rows.append(dict(policy_id=f"POL{fno:04d}", field_id=f"P{fno:03d}", insurer=str(d["rng"].choice(["Aseguradora Pampa", "La Cumbre Seguros", "Rio de la Plata Re"])),
                                 type=t, perils=perils, sum_insured_usd=float(np.round(d["amount"] * d["rng"].uniform(0.8, 1.2), -3)), cover_share=cover,
                                 trigger=trig, start_date=o.isoformat(), end_date=m.isoformat()))
    # credit history
    ch = []
    months = pd.period_range(f"{C.SEASON_START.year - 1}-06", f"{C.SEASON_START.year + 1}-01", freq="M")
    by_farmer = {}
    for d in loans:
        by_farmer.setdefault(d["farmer"], []).append(d)
    for fr, ds in by_farmer.items():
        debt = sum(x["amount"] for x in ds) + ds[0]["other"]
        worst = max(ds, key=lambda x: x["dpd"])
        for mth in months:
            end = mth.to_timestamp(how="end").date()
            dpd_m = max(0, worst["dpd"] - (snapshot - end).days) if worst["dpd"] else 0
            sit = 1 if dpd_m <= 31 else 2 if dpd_m <= 90 else 3 if dpd_m <= 180 else 4
            ch.append(dict(farmer_id=fr, month=str(mth), bcra_situacion=sit, total_system_debt_usd=float(np.round(debt, -3)), max_days_past_due=int(dpd_m)))
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    readme = pd.DataFrame({"README": ["Loan-ly Planet demo loan book (240 loans, 10 regions). ALL DATA IS SYNTHETIC AND FICTIONAL.",
                                      f"Snapshot date for repayment status and days past due: {snapshot.isoformat()}.",
                                      "Format: docs/CONTRACT.md section A. A few sowing dates are left blank on purpose (phenology detection)."]})
    with pd.ExcelWriter(path, engine="openpyxl") as xw:
        for name, rows in (("Farmers", farmers), ("Fields", fields), ("Loans", [d["loan_row"] for d in loans]), ("Repayments", reps), ("Insurance", ins_rows), ("CreditHistory", ch)):
            pd.DataFrame(rows).to_excel(xw, sheet_name=name, index=False)
        readme.to_excel(xw, sheet_name="README", index=False)
        from openpyxl.styles import Font, PatternFill
        for ws in xw.book.worksheets:
            for c in ws[1]:
                c.font = Font(bold=True, color="FFFFFF"); c.fill = PatternFill("solid", fgColor="1F4E3D")
            ws.freeze_panes = "A2"
            for col in ws.columns:
                ws.column_dimensions[col[0].column_letter].width = min(48, max(11, max(len(str(c.value or "")) for c in list(col)[:60]) + 2))
    return path
