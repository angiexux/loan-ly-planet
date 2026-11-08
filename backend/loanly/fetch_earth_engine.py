"""Module 1 (METHODS 1): data per field.

Two paths:
  (a) `fetch_from_ee()`  the real Google Earth Engine extraction (Sentinel-2 SR with SCL cloud mask, CHIRPS, ERA5-Land, SMAP,
      Sentinel-1). Needs `earthengine-api` and an authenticated project; it is NOT executed in the demo.
  (b) `weekly_series()` / `aggregate_weekly()`  the cleaning that DOES run, on synthetic observations that imitate what (a) returns:
        1. drop images flagged as cloud / shadow / cirrus / snow by the satellite's own quality band,
        2. one value per week = MEDIAN of that week's clear images (robust to a contaminated pixel),
        3. fill the weeks without a clear image by linear interpolation between clear weeks,
        4. smooth with a Savitzky-Golay filter (keeps the shape of the green-up peak better than a moving average).
      NDVI = (NIR - red) / (NIR + red).  The "cloud-free share" of a week (clear images / images) feeds the confidence score.
"""
from __future__ import annotations

import warnings

import numpy as np
from scipy.signal import savgol_filter

from . import config as C

try:  # pragma: no cover - not installed in the demo environment
    import ee
except ImportError:  # pragma: no cover
    ee = None


# ------------------------------------------------------------------------------------------------ (a) Earth Engine
def fetch_from_ee(field: dict, start: str, end: str, project: str | None = None) -> dict:
    """Pull every raw series for one field from Earth Engine.

    field: {"lat", "lng", optional "ring": [[lng, lat], ...]}  (polygon preferred; a 30 m buffer around the point otherwise)
    start/end: ISO dates. Returns dict of lists: s2 (date, ndvi, clear_fraction), rain, tmin, tmax, soil, water.
    """
    if ee is None:
        raise RuntimeError("earthengine-api is not installed: run `pip install earthengine-api` and `earthengine authenticate`, "
                           "or use the synthetic sources (loanly.synthetic).")
    ee.Initialize(project=project)
    geom = (ee.Geometry.Polygon([field["ring"]]) if field.get("ring") else ee.Geometry.Point([field["lng"], field["lat"]]).buffer(30))

    # ---- Sentinel-2 surface reflectance: mask with the Scene Classification Layer, NDVI = (B8 - B4) / (B8 + B4)
    def s2_ndvi(img):
        scl = img.select("SCL")
        bad = ee.Image(0)
        for k in C.S2_SCL_MASK:                          # 3 shadow, 8/9 cloud, 10 cirrus, 11 snow
            bad = bad.Or(scl.eq(k))
        ndvi = img.normalizedDifference(["B8", "B4"]).rename("ndvi")
        clear = bad.Not().rename("clear")
        stats = ndvi.updateMask(clear).addBands(clear.toFloat()).reduceRegion(
            reducer=ee.Reducer.mean(), geometry=geom, scale=10, bestEffort=True, maxPixels=1e9)    # zonal mean inside the polygon
        return ee.Feature(None, {"t": img.date().format("YYYY-MM-dd"), "ndvi": stats.get("ndvi"), "clear": stats.get("clear")})

    s2 = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(geom).filterDate(start, end)
          .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 80)))
    s2_feats = ee.FeatureCollection(s2.map(s2_ndvi)).getInfo()["features"]

    def daily(collection, band, scale, reducer=ee.Reducer.mean()):
        def f(img):
            v = img.select(band).reduceRegion(reducer, geom, scale, bestEffort=True).get(band)
            return ee.Feature(None, {"t": img.date().format("YYYY-MM-dd"), "v": v})
        return [(x["properties"]["t"], x["properties"]["v"]) for x in ee.FeatureCollection(
            collection.filterBounds(geom).filterDate(start, end).map(f)).getInfo()["features"]]

    # ---- CHIRPS daily rain (mm), 5 km
    rain = daily(ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY"), "precipitation", 5566)
    # ---- ERA5-Land daily min/max 2 m temperature (Kelvin -> Celsius), ~11 km
    era = ee.ImageCollection("ECMWF/ERA5_LAND/DAILY_AGGR")
    tmin = [(t, None if v is None else v - 273.15) for t, v in daily(era, "temperature_2m_min", 11132)]
    tmax = [(t, None if v is None else v - 273.15) for t, v in daily(era, "temperature_2m_max", 11132)]
    # ---- SMAP L4 surface soil moisture (m3/m3), 11 km
    soil = daily(ee.ImageCollection("NASA/SMAP/SPL4SMGP/007"), "sm_surface", 11000)
    # ---- Sentinel-1 radar: open water has very low VV backscatter (< -18 dB); water fraction = share of pixels below it
    def water_frac(img):
        vv = img.select("VV")
        w = vv.lt(-18).rename("w")
        v = w.reduceRegion(ee.Reducer.mean(), geom, 10, bestEffort=True).get("w")
        return ee.Feature(None, {"t": img.date().format("YYYY-MM-dd"), "v": v})
    s1 = (ee.ImageCollection("COPERNICUS/S1_GRD").filterBounds(geom).filterDate(start, end)
          .filter(ee.Filter.eq("instrumentMode", "IW")).filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV")))
    water = [(x["properties"]["t"], x["properties"]["v"]) for x in ee.FeatureCollection(s1.map(water_frac)).getInfo()["features"]]
    return dict(s2=[(x["properties"]["t"], x["properties"]["ndvi"], x["properties"]["clear"]) for x in s2_feats], rain=rain, tmin=tmin, tmax=tmax, soil=soil, water=water)


def weekly_composite_ee(geom, start, end):  # pragma: no cover - illustration of server-side weekly median compositing
    """Server-side alternative: one median NDVI image per week, reduced over the field polygon."""
    weeks = ee.List.sequence(0, ee.Date(end).difference(ee.Date(start), "week").subtract(1))

    def one(i):
        a = ee.Date(start).advance(ee.Number(i), "week")
        img = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(geom).filterDate(a, a.advance(1, "week"))
               .map(lambda im: im.updateMask(im.select("SCL").remap(C.S2_SCL_MASK, [0] * len(C.S2_SCL_MASK), 1))
                    .normalizedDifference(["B8", "B4"])).median())
        return ee.Feature(None, {"week": a.format("YYYY-MM-dd"), "ndvi": img.reduceRegion(ee.Reducer.mean(), geom, 10, bestEffort=True).get("nd")})
    return ee.FeatureCollection(weeks.map(one))


# ------------------------------------------------------------------------------------------------ (b) cleaning that runs
def weekly_series(day, value, cloud, n_weeks: int = C.W, sg_window: int = C.SG_WINDOW, sg_poly: int = C.SG_POLY):
    """Clean one field-season of NDVI image observations.

    day: day-of-season of each image (0..363); value: NDVI; cloud: True where the quality band flags cloud/shadow/cirrus/snow.
    Returns dict(obs=[n_weeks] weekly median of clear images (NaN = no clear image), ndvi=[n_weeks] gap-filled and smoothed,
    cloud_free=[n_weeks] share of that week's images that were clear (NaN-free; 0 when no image)).
    """
    day = np.asarray(day); value = np.asarray(value, float); cloud = np.asarray(cloud, bool)
    wk = day // 7
    obs = np.full(n_weeks, np.nan); n_all = np.zeros(n_weeks); n_clear = np.zeros(n_weeks)
    for w in range(n_weeks):
        m = wk == w
        n_all[w] = m.sum()
        v = value[m & ~cloud]                                   # 1. drop flagged images
        n_clear[w] = len(v)
        if len(v):
            obs[w] = np.median(v)                               # 2. weekly median composite
    cf = np.divide(n_clear, n_all, out=np.zeros(n_weeks), where=n_all > 0)
    ok = ~np.isnan(obs)
    if ok.sum() == 0:
        filled = np.full(n_weeks, 0.3)
    elif ok.sum() == 1:
        filled = np.full(n_weeks, obs[ok][0])
    else:
        idx = np.arange(n_weeks)
        filled = np.interp(idx, idx[ok], obs[ok])               # 3. linear interpolation over gaps (edges held constant)
    win = min(sg_window, n_weeks - (1 - n_weeks % 2))
    smooth = savgol_filter(filled, win, min(sg_poly, win - 1)) if win >= 3 else filled   # 4. Savitzky-Golay
    return dict(obs=obs, ndvi=np.clip(smooth, 0.0, 1.0), cloud_free=cf)


def aggregate_weekly(src) -> dict:
    """Clean every field-season of a `Sources` object and aggregate the daily weather to weekly values.

    Returns arrays of shape (F, S, 52): ndvi_obs, ndvi, cloud_free, rain, tmin (weekly minimum), tmax (weekly maximum),
    hot (days above 35 C), frost_deg (sum of degrees below -2 C), soil (weekly mean of the SMAP passes), water (weekly max).
    """
    F, S, _ = src.ndvi_day.shape
    W = C.W
    obs = np.zeros((F, S, W)); sm = np.zeros((F, S, W)); cf = np.zeros((F, S, W))
    for f in range(F):
        for s in range(S):
            r = weekly_series(src.ndvi_day[f, s], src.ndvi_val[f, s], src.ndvi_cloud[f, s])
            obs[f, s], sm[f, s], cf[f, s] = r["obs"], r["ndvi"], r["cloud_free"]
    wk = lambda a: a.reshape(F, S, W, 7)
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore")
        soil = np.nanmean(wk(src.soil), axis=-1)
        water = np.nanmax(wk(src.water.repeat(7, axis=2)), axis=-1)
    # a week with no SMAP pass / radar pass: carry the previous value forward (then the first valid one backwards)
    soil = _ffill(soil); water = np.nan_to_num(_ffill(water), nan=0.0)
    return dict(ndvi_obs=obs, ndvi=sm, cloud_free=cf, rain=wk(src.rain).sum(-1), tmin=wk(src.tmin).min(-1), tmax=wk(src.tmax).max(-1),
                hot=(wk(src.tmax) > C.SM_HOT_C).sum(-1), frost_deg=np.clip(C.FROST_C - wk(src.tmin), 0, None).sum(-1), soil=soil, water=water)


def _ffill(a):
    a = a.copy()
    for w in range(1, a.shape[-1]):
        m = np.isnan(a[..., w]); a[..., w][m] = a[..., w - 1][m]
    for w in range(a.shape[-1] - 2, -1, -1):
        m = np.isnan(a[..., w]); a[..., w][m] = a[..., w + 1][m]
    return a
