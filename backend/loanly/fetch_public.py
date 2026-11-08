"""Real, public, no-key data for ONE DAY per field, every value carrying its own source line.

    python3 backend/loanly/fetch_public.py [--book samples/sample_farmers_10.xlsx ...] [--date 2026-01-18] [--out web/public/data/real_snapshot.json]

`snapshot(field, date)` returns {rain, tmin, tmax, soil, ndvi_s2, ndvi_modis, water}; each item is
    {value, unit, date_of_observation, source:{name, product, resolution, url, fetched_at, note}, sourceLine, ...extras}
`value` is None when the source had nothing (the `note` says why). Sources:
    rain        CHIRPS v2.0 daily-improved 0.05 deg via the IRI Data Library (fallback: ERA5-Land precipitation via Open-Meteo)
    tmin/tmax   ERA5-Land (ECMWF) via the Open-Meteo archive API, 0.1 deg
    soil        SMAP L3 (SPL3SMP_E v006) only if ~/.netrc has urs.earthdata.nasa.gov, else ERA5-Land soil_moisture_0_to_7cm (daily mean)
    ndvi_s2     Sentinel-2 L2A (Microsoft Planetary Computer STAC + titiler point), nearest clear pass within +-5 days
    ndvi_modis  MOD13Q1 v061 16-day composite covering the date (ORNL DAAC REST), 250 m
    et, pet     MOD16A2 v061 8-day composite covering the date (ORNL DAAC REST), 500 m, bands ET_500m / PET_500m, scale 0.1 kg/m2/8 day,
                fill values >= 32761 -> null;  wa = min(1, ET/PET) derived from the two (water availability, input of the Crop Health Index)
    water       Sentinel-1 RTC (Planetary Computer) nearest pass within +-6 days, VV < -18 dB = standing water
Politeness: every response is cached under data/cache/<source>/, descriptive User-Agent, retry with backoff, <= 4 concurrent
requests, fields sharing a grid cell share one request. Credentials are never asked for or stored.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import netrc
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "data" / "cache"
UA = "loanly-planet-hackathon/0.1"
_SEM = threading.Semaphore(4)
_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": UA})
STATS = {}          # source -> {"requests": n, "cached": n, "seconds": s, "errors": n}
_LOCK = threading.Lock()

OM_URL = "https://archive-api.open-meteo.com/v1/archive"
IRI_URL = ("https://iridl.ldeo.columbia.edu/SOURCES/.UCSB/.CHIRPS/.v2p0/.daily-improved/.global/.0p05/.prcp/"
           "X/{lng}/VALUE/Y/{lat}/VALUE/T/({d})/VALUE/data.ch")
ORNL = "https://modis.ornl.gov/rst/api/v1/MOD13Q1"
ORNL_ET = "https://modis.ornl.gov/rst/api/v1/MOD16A2"
PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
PC_DATA = "https://planetarycomputer.microsoft.com/api/data/v1/item/point/{lng},{lat}"
CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
S2_CLEAR = {4: "vegetation", 5: "bare soil", 6: "water", 7: "unclassified (low probability)"}
SCL_NAMES = {0: "no data", 1: "saturated/defective", 2: "dark area", 3: "cloud shadow", 4: "vegetation", 5: "bare soil", 6: "water",
             7: "unclassified", 8: "cloud (medium prob.)", 9: "cloud (high prob.)", 10: "thin cirrus", 11: "snow/ice"}


# ------------------------------------------------------------------------------------------------ http + cache
def _stat(src, key, v=1):
    with _LOCK:
        s = STATS.setdefault(src, dict(requests=0, cached=0, seconds=0.0, errors=0))
        s[key] += v


def _ckey(*parts) -> str:
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:16]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def cached_request(source: str, key: str, method: str, url: str, *, params=None, json_body=None, headers=None, as_text=False, retries=4):
    """HTTP with on-disk cache (data/cache/<source>/<key>.json = {url, fetched_at, body}), <=4 concurrent, backoff on 429/5xx.
    Returns (body, url, fetched_at, from_cache). Raises on final failure; failures are not cached."""
    path = CACHE / source / f"{key}.json"
    if path.exists():
        try:
            d = json.loads(path.read_text())
            _stat(source, "cached")
            return d["body"], d["url"], d["fetched_at"], True
        except Exception:
            pass
    last = None
    for attempt in range(retries):
        with _SEM:
            t = time.time()
            try:
                r = _SESSION.request(method, url, params=params, json=json_body, headers=headers, timeout=60)
                _stat(source, "requests"); _stat(source, "seconds", time.time() - t)
                if r.status_code in (429, 500, 502, 503, 504):
                    last = RuntimeError(f"HTTP {r.status_code} from {url[:80]}")
                elif r.status_code >= 400:
                    _stat(source, "errors")
                    raise RuntimeError(f"HTTP {r.status_code} from {r.url[:120]}: {r.text[:120]}")
                else:
                    body = r.text if as_text else r.json()
                    fetched = _now()
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps(dict(url=r.url, fetched_at=fetched, body=body)))
                    return body, r.url, fetched, False
            except requests.RequestException as e:
                _stat(source, "requests"); last = e
        time.sleep(1.5 * 2 ** attempt)
    _stat(source, "errors")
    raise RuntimeError(f"giving up on {url[:100]}: {last}")


# ------------------------------------------------------------------------------------------------ item helpers
def _fmt_day(d) -> str:
    d = date.fromisoformat(str(d)[:10])
    return f"{d.day} {d.strftime('%b %Y')}"


def _fmt_fetched(iso: str) -> str:
    t = datetime.fromisoformat(iso)
    return f"{t.day} {t.strftime('%b %Y %H:%M')} UTC"


def _item(value, unit, obs_date, name, product, resolution, url, fetched_at, note="", where="", **extra) -> dict:
    line = f"Source: {name} · {product} · {resolution}" + (f" at {where}" if where else "")
    line += f" · {_fmt_day(obs_date)}" if obs_date else " · no observation"
    line += f" · fetched {_fmt_fetched(fetched_at)}"
    if note:
        line += f" · {note}"
    d = dict(value=value, unit=unit, date_of_observation=str(obs_date)[:10] if obs_date else None,
             source=dict(name=name, product=product, resolution=resolution, url=url, fetched_at=fetched_at, note=note), sourceLine=line)
    d.update(extra)
    return d


def _ll(lat, lng) -> str:
    return f"{lat:.2f}, {lng:.2f}"


# ------------------------------------------------------------------------------------------------ parsers (pure, offline-testable)
def parse_open_meteo(j: dict) -> dict:
    """Open-Meteo archive JSON -> {tmin, tmax, precip_sum, soil_mean, cell_lat, cell_lng} (None where null / absent)."""
    daily, hourly = j.get("daily") or {}, j.get("hourly") or {}
    first = lambda k: (daily.get(k) or [None])[0]
    soil = [v for v in (hourly.get("soil_moisture_0_to_7cm") or []) if v is not None]
    hp = [v for v in (hourly.get("precipitation") or []) if v is not None]
    return dict(tmin=first("temperature_2m_min"), tmax=first("temperature_2m_max"), precip_sum=first("precipitation_sum"),
                precip_hourly_sum=(sum(hp) if hp else None), soil_mean=(sum(soil) / len(soil) if soil else None),
                cell_lat=j.get("latitude"), cell_lng=j.get("longitude"))


def parse_iri(text: str):
    """IRI data.ch single value -> float or None (missing value 'NaN' / empty)."""
    try:
        v = float(text.strip().split()[0])
    except (ValueError, IndexError):
        return None
    return None if (math.isnan(v) or v < -900) else v


def parse_ornl_dates(j: dict) -> list[tuple[str, str]]:
    return [(x["modis_date"], x["calendar_date"]) for x in j.get("dates", [])]


def parse_ornl_subset(j: dict) -> dict:
    """ORNL MOD13Q1 subset JSON (1x1 pixel) -> {ndvi, reliability, evi, modis_date, calendar_date, tile}."""
    by = {x["band"]: x for x in j.get("subset", [])}
    nd, rel = by.get("250m_16_days_NDVI"), by.get("250m_16_days_pixel_reliability")
    if not nd:
        return dict(ndvi=None, reliability=None)
    raw = nd["data"][0]
    return dict(ndvi=None if raw in (-3000, -1) else raw * 0.0001, reliability=(rel["data"][0] if rel else None),
                modis_date=nd["modis_date"], calendar_date=nd["calendar_date"], tile=nd.get("tile"))


def parse_ornl_et(j: dict) -> dict:
    """ORNL MOD16A2 subset JSON (1x1 pixel) -> {et, pet (kg/m2/8 day = mm per 8 days), modis_date, calendar_date, tile}.
    Raw values are scaled by 0.1; fill values (>= 32761, e.g. 32761 water, 32766 barren, 32767 no data) become None."""
    by = {x["band"]: x for x in j.get("subset", [])}
    out = dict(et=None, pet=None)
    ref = by.get("ET_500m") or by.get("PET_500m")
    if not ref:
        return out
    for k, band in (("et", "ET_500m"), ("pet", "PET_500m")):
        x = by.get(band)
        if x and x["data"]:
            raw = x["data"][0]
            out[k] = None if (raw is None or raw >= 32761 or raw < 0) else round(raw * 0.1, 1)
    out.update(modis_date=ref["modis_date"], calendar_date=ref["calendar_date"], tile=ref.get("tile"))
    return out


def water_availability(et, pet):
    """WA = min(1, ET/PET); None if either is missing or PET <= 0 (same rule as fhi_calc.py)."""
    if et is None or pet is None or pet <= 0:
        return None
    return round(min(1.0, et / pet), 3)


def modis_et_pet(lat: float, lng: float, d: str) -> dict:
    """MOD16A2 composite covering `d` (latest composite start <= d) from ORNL DAAC."""
    hdr = {"Accept": "application/json"}
    dj, _, _, _ = cached_request("modis", _ckey("dates16", round(lat, 1), round(lng, 1)), "GET", ORNL_ET + "/dates", params=dict(latitude=lat, longitude=lng), headers=hdr)
    dates = [x for x in parse_ornl_dates(dj) if x[1] <= d]
    if not dates:
        return dict(et=None, pet=None)
    mdate, cal = max(dates, key=lambda x: x[1])
    params = dict(latitude=round(lat, 4), longitude=round(lng, 4), startDate=mdate, endDate=mdate, kmAboveBelow=0, kmLeftRight=0)
    body, url, fetched, _ = cached_request("modis", _ckey("subset16", round(lat, 3), round(lng, 3), mdate), "GET", ORNL_ET + "/subset", params=params, headers=hdr)
    out = parse_ornl_et(body); out.update(url=url, fetched_at=fetched, calendar_date=cal, modis_date=mdate)
    return out


def parse_pc_point(j: dict, assets=("B04", "B08", "SCL")) -> dict:
    """titiler point JSON {"values":[...],"band_names":[...]} -> {asset: value}."""
    names = [b.rsplit("_b", 1)[0] for b in j.get("band_names", [])] or list(assets)
    return dict(zip(names, j.get("values", [])))


def s2_ndvi(b04, b08, baseline: str) -> float | None:
    """NDVI from L2A digital numbers; processing baseline >= 04.00 carries BOA_ADD_OFFSET -1000."""
    if b04 is None or b08 is None:
        return None
    off = 1000.0 if baseline and float(baseline) >= 4.0 else 0.0
    r, n = (b04 - off), (b08 - off)
    if (r + n) <= 0:
        return None
    return float(np_clip((n - r) / (n + r)))


def np_clip(x, lo=-1.0, hi=1.0):
    return max(lo, min(hi, x))


def parse_stac_items(j: dict) -> list[dict]:
    """STAC FeatureCollection -> [{id, datetime, cloud, baseline}] one per acquisition (the newest processing wins)."""
    best = {}
    for f in j.get("features", []):
        p = f["properties"]
        k = (p["datetime"][:19], p.get("s2:mgrs_tile") or f["id"].split("_")[-2])
        it = dict(id=f["id"], datetime=p["datetime"], cloud=p.get("eo:cloud_cover"), baseline=p.get("s2:processing_baseline"), assets=list(f.get("assets", {})))
        if k not in best or f["id"].rsplit("_", 1)[-1] > best[k]["id"].rsplit("_", 1)[-1]:
            best[k] = it
    return list(best.values())


def parse_cmr(j: dict) -> list[dict]:
    out = []
    for e in j.get("feed", {}).get("entry", []):
        links = [l["href"] for l in e.get("links", []) if l.get("rel", "").endswith("/data#") and l["href"].endswith(".h5")]
        out.append(dict(id=e.get("title"), time_start=e.get("time_start"), url=links[0] if links else None))
    return out


# ------------------------------------------------------------------------------------------------ sources
def _om_params(lat, lng, d, extra):
    return dict(latitude=lat, longitude=lng, start_date=d, end_date=d, timezone="UTC", **extra)


def era5_land(lat: float, lng: float, d: str) -> dict:
    """tmin, tmax, soil (daily mean of 0-7 cm) and a rain fallback for one day, one request per 0.1 deg cell (+1 for the rain fallback)."""
    clat, clng = round(lat, 1), round(lng, 1)
    params = _om_params(clat, clng, d, dict(daily="temperature_2m_min,temperature_2m_max,precipitation_sum", hourly="soil_moisture_0_to_7cm,precipitation", models="era5_land"))
    body, url, fetched, _ = cached_request("open-meteo", _ckey("era5", clat, clng, d), "GET", OM_URL, params=params)
    out = parse_open_meteo(body); out.update(url=url, fetched_at=fetched)
    return out


def open_meteo_rain_default(lat: float, lng: float, d: str) -> dict:
    """Rain fallback: the era5_land model returns null precipitation on Open-Meteo for many dates, so use the default reanalysis blend (labelled)."""
    clat, clng = round(lat, 1), round(lng, 1)
    b2, u2, f2, _ = cached_request("open-meteo", _ckey("era5best", clat, clng, d), "GET", OM_URL, params=_om_params(clat, clng, d, dict(daily="precipitation_sum")))
    return dict(value=parse_open_meteo(b2)["precip_sum"], url=u2, fetched_at=f2)


def chirps_rain(lat: float, lng: float, d: str) -> dict:
    """CHIRPS v2.0 daily-improved 0.05 deg value (mm) for one day via the IRI Data Library; one request per 0.05 deg cell."""
    cl = math.floor(lat / 0.05) * 0.05 + 0.025
    cg = math.floor(lng / 0.05) * 0.05 + 0.025
    dd = date.fromisoformat(d)
    tstr = f"{dd.day} {dd.strftime('%b %Y')}"
    url = IRI_URL.format(lng=f"{cg:.3f}", lat=f"{cl:.3f}", d=tstr.replace(" ", "%20"))
    text, u, fetched, _ = cached_request("chirps", _ckey("iri", f"{cl:.3f}", f"{cg:.3f}", d), "GET", url, as_text=True)
    return dict(value=parse_iri(text), url=u, fetched_at=fetched, cell=(cl, cg))


def modis_ndvi(lat: float, lng: float, d: str) -> dict:
    """MOD13Q1 composite covering `d` (latest composite start <= d) from ORNL DAAC."""
    hdr = {"Accept": "application/json"}
    dj, _, _, _ = cached_request("modis", _ckey("dates", round(lat, 1), round(lng, 1)), "GET", ORNL + "/dates", params=dict(latitude=lat, longitude=lng), headers=hdr)
    dates = [x for x in parse_ornl_dates(dj) if x[1] <= d]
    if not dates:
        return dict(ndvi=None, reliability=None)
    mdate, cal = max(dates, key=lambda x: x[1])
    params = dict(latitude=round(lat, 4), longitude=round(lng, 4), startDate=mdate, endDate=mdate, kmAboveBelow=0, kmLeftRight=0)
    body, url, fetched, _ = cached_request("modis", _ckey("subset", round(lat, 3), round(lng, 3), mdate), "GET", ORNL + "/subset", params=params, headers=hdr)
    out = parse_ornl_subset(body); out.update(url=url, fetched_at=fetched, calendar_date=cal, modis_date=mdate)
    return out


def _stac(coll: str, lat, lng, d0, d1):
    body = {"collections": [coll], "intersects": {"type": "Point", "coordinates": [round(lng, 4), round(lat, 4)]}, "datetime": f"{d0}/{d1}", "limit": 100}
    j, url, fetched, _ = cached_request("planetary-computer", _ckey("stac", coll, round(lat, 4), round(lng, 4), d0, d1), "POST", PC_STAC, json_body=body)
    return j, url, fetched


def _pc_point(coll, item_id, lat, lng, assets):
    params = [("collection", coll), ("item", item_id)] + [("assets", a) for a in assets]
    url = PC_DATA.format(lng=round(lng, 5), lat=round(lat, 5))
    j, u, fetched, _ = cached_request("planetary-computer", _ckey("pt", coll, item_id, round(lat, 5), round(lng, 5), *assets), "GET", url, params=params)
    return j, u, fetched


def sentinel2_ndvi(lat: float, lng: float, d: str, window: int = 5) -> dict:
    """Nearest clear-sky (SCL 4/5/6/7) Sentinel-2 L2A pass within +-window days; tries the next nearest if the pass is cloudy at the field."""
    dd = date.fromisoformat(d)
    j, surl, sfetched = _stac("sentinel-2-l2a", lat, lng, (dd - timedelta(days=window)).isoformat(), (dd + timedelta(days=window)).isoformat())
    items = parse_stac_items(j)
    items.sort(key=lambda it: abs((date.fromisoformat(it["datetime"][:10]) - dd).days) + (it["cloud"] or 0) / 1000)
    tried = []
    for it in items:
        pj, purl, pf = _pc_point("sentinel-2-l2a", it["id"], lat, lng, ["B04", "B08", "SCL"])
        v = parse_pc_point(pj)
        scl = int(v.get("SCL", 0))
        rec = dict(item=it["id"], date=it["datetime"][:10], scl=scl, sclName=SCL_NAMES.get(scl), sceneCloudPct=it["cloud"])
        if scl in S2_CLEAR:
            nd = s2_ndvi(v["B04"], v["B08"], it["baseline"])
            return dict(ndvi=nd, url=purl, stac_url=surl, fetched_at=pf, tried=tried, baseline=it["baseline"], **rec)
        tried.append(rec)
    return dict(ndvi=None, url=surl, fetched_at=sfetched, tried=tried, n_items=len(items))


def sentinel1_water(lat: float, lng: float, d: str, window: int = 6) -> dict:
    """Nearest Sentinel-1 RTC pass within +-window days; VV in dB, water if VV < -18 dB."""
    dd = date.fromisoformat(d)
    j, surl, sfetched = _stac("sentinel-1-rtc", lat, lng, (dd - timedelta(days=window)).isoformat(), (dd + timedelta(days=window)).isoformat())
    feats = sorted(j.get("features", []), key=lambda f: abs((date.fromisoformat(f["properties"]["datetime"][:10]) - dd).days))
    if not feats:
        return dict(vv_db=None, url=surl, fetched_at=sfetched)
    f = feats[0]
    pj, purl, pf = _pc_point("sentinel-1-rtc", f["id"], lat, lng, ["vv"])
    vv = parse_pc_point(pj, ("vv",)).get("vv")
    db = 10 * math.log10(vv) if vv and vv > 0 else None
    return dict(vv_db=db, item=f["id"], date=f["properties"]["datetime"][:10], url=purl, fetched_at=pf)


def smap_available() -> bool:
    try:
        return netrc.netrc().authenticators("urs.earthdata.nasa.gov") is not None
    except (FileNotFoundError, netrc.NetrcParseError, OSError):
        return False


def smap_soil(lat: float, lng: float, d: str) -> dict:
    """SMAP SPL3SMP_E v006 morning soil moisture at the nearest EASE-Grid 2.0 9 km cell. Only called when ~/.netrc has Earthdata creds."""
    import h5py
    import numpy as np
    params = dict(short_name="SPL3SMP_E", version="006", temporal=f"{d}T00:00:00Z,{d}T23:59:59Z", bounding_box=f"{lng},{lat},{lng},{lat}", page_size=5)
    j, curl, cf, _ = cached_request("smap", _ckey("cmr", d, round(lat, 2), round(lng, 2)), "GET", CMR, params=params)
    g = [x for x in parse_cmr(j) if x["url"]]
    if not g:
        return dict(value=None, url=curl, fetched_at=cf)
    dest = CACHE / "smap" / (g[0]["id"] + ".h5")
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        with _SEM, requests.Session() as s:                         # requests reads ~/.netrc for urs.earthdata.nasa.gov redirects
            s.headers["User-Agent"] = UA
            r = s.get(g[0]["url"], stream=True, timeout=300)
            r.raise_for_status()
            dest.write_bytes(r.content)
    with h5py.File(dest, "r") as h:
        grp = h["Soil_Moisture_Retrieval_Data_AM"]
        la, lo, sm = grp["latitude"][:], grp["longitude"][:], grp["soil_moisture"][:]
        dist = (la - lat) ** 2 + ((lo - lng) * math.cos(math.radians(lat))) ** 2
        dist = np.where(sm > -900, dist, np.inf)
        i = np.unravel_index(np.argmin(dist), dist.shape)
        val = float(sm[i]) if np.isfinite(dist[i]) and dist[i] < 0.1 else None
    return dict(value=val, url=g[0]["url"], fetched_at=cf, granule=g[0]["id"])


# ------------------------------------------------------------------------------------------------ snapshot
def _safe(fn, *a):
    try:
        return fn(*a), None
    except Exception as e:      # network / parse failure: record as "no value" with the reason, never crash the batch
        return None, f"{type(e).__name__}: {str(e)[:160]}"


def snapshot(field: dict, d: str = "2026-01-18") -> dict:
    """field: {lat, lng}. Returns {rain, tmin, tmax, soil, ndvi_s2, ndvi_modis, water} items for date `d` (YYYY-MM-DD)."""
    lat, lng = float(field["lat"]), float(field["lng"])
    items = {}
    ev, err = _safe(era5_land, lat, lng, d)
    om_name = "ERA5-Land (ECMWF) via Open-Meteo archive API"
    if ev:
        where = _ll(ev['cell_lat'], ev['cell_lng'])
        for k, unit, key in (("tmin", "°C", "tmin"), ("tmax", "°C", "tmax")):
            items[k] = _item(ev[key], unit, d, om_name, "era5_land daily 2 m temperature", "0.1° cell (~9 km)", ev["url"], ev["fetched_at"], where=where)
    else:
        for k in ("tmin", "tmax"):
            items[k] = _item(None, "°C", None, om_name, "era5_land", "0.1°", OM_URL, _now(), note=f"unavailable ({err})")
    # rain: CHIRPS, else ERA5-Land
    cv, cerr = _safe(chirps_rain, lat, lng, d)
    if cv and cv["value"] is not None:
        items["rain"] = _item(round(cv["value"], 2), "mm/day", d, "CHIRPS v2.0 (UCSB CHC) via IRI Data Library", "CHIRPS v2.0 daily-improved", "0.05° cell (~5 km)", cv["url"], cv["fetched_at"],
                              where=_ll(*cv['cell']))
    else:
        why = f"CHIRPS unavailable ({cerr or 'no value'})"
        if ev and ev.get("precip_hourly_sum") is not None:
            items["rain"] = _item(round(ev["precip_hourly_sum"], 2), "mm/day", d, om_name, "era5_land hourly precipitation", "0.1° cell (~9 km)", ev["url"], ev["fetched_at"], where=_ll(ev['cell_lat'], ev['cell_lng']), note=f"fallback: {why}")
        elif (fb := (_safe(open_meteo_rain_default, lat, lng, d)[0])) and fb["value"] is not None:
            items["rain"] = _item(fb["value"], "mm/day", d, "Open-Meteo archive API (default ERA5/ERA5-Land best-match blend)", "precipitation_sum", "~9-25 km", fb["url"], fb["fetched_at"],
                                  note=f"fallback: {why}; era5_land model returned null precipitation")
        else:
            items["rain"] = _item(None, "mm/day", None, "CHIRPS v2.0 via IRI", "CHIRPS v2.0 daily-improved", "0.05°", IRI_URL, _now(), note=why)
    # soil
    if smap_available():
        sv, serr = _safe(smap_soil, lat, lng, d)
        if sv and sv["value"] is not None:
            items["soil"] = _item(round(sv["value"], 3), "m³/m³", d, "SMAP L3 (NASA/NSIDC) enhanced 9 km", "SPL3SMP_E v006", "9 km EASE-Grid 2.0", sv["url"], sv["fetched_at"], where=_ll(lat, lng))
    if "soil" not in items:
        why = "SMAP not used: no Earthdata login in ~/.netrc (machine urs.earthdata.nasa.gov)"
        if ev and ev.get("soil_mean") is not None:
            items["soil"] = _item(round(ev["soil_mean"], 3), "m³/m³", d, om_name, "era5_land soil_moisture_0_to_7cm, daily mean of 24 h", "0.1° cell (~9 km)", ev["url"], ev["fetched_at"],
                                  where=_ll(ev['cell_lat'], ev['cell_lng']), note=f"fallback: {why}")
        else:
            items["soil"] = _item(None, "m³/m³", None, om_name, "era5_land", "0.1°", OM_URL, _now(), note=f"{why}; ERA5-Land unavailable ({err})")
    # Sentinel-2
    s2, e2 = _safe(sentinel2_ndvi, lat, lng, d)
    nm2 = "Sentinel-2 L2A (ESA Copernicus) via Microsoft Planetary Computer"
    if s2 and s2.get("ndvi") is not None:
        note = "" if not s2["tried"] else "nearer pass(es) not clear at the field: " + "; ".join(f"{t['date']} SCL {t['scl']} {t['sclName']}" for t in s2["tried"])
        items["ndvi_s2"] = _item(round(s2["ndvi"], 3), "NDVI", s2["date"], nm2, f"{s2['item']} (baseline {s2['baseline']}, B08/B04, offset -1000)", "10 m pixel",
                                 s2["url"], s2["fetched_at"], note=note, where=_ll(lat, lng), scl=s2["scl"], sclName=s2["sclName"], cloud=False, sceneCloudPct=s2["sceneCloudPct"],
                                 daysFromDate=(date.fromisoformat(s2["date"]) - date.fromisoformat(d)).days)
    else:
        why = e2 or ("no clear Sentinel-2 pass within ±5 days" + (": " + "; ".join(f"{t['date']} SCL {t['scl']} {t['sclName']}" for t in s2["tried"]) if s2 and s2.get("tried") else ""))
        items["ndvi_s2"] = _item(None, "NDVI", None, nm2, "sentinel-2-l2a", "10 m", (s2 or {}).get("url", PC_STAC), (s2 or {}).get("fetched_at", _now()), note=why, cloud=True)
    # MODIS
    mo, em = _safe(modis_ndvi, lat, lng, d)
    nmm = "MODIS Terra MOD13Q1 v061 via ORNL DAAC"
    if mo and mo.get("calendar_date"):
        rel = mo["reliability"]
        ok = mo["ndvi"] is not None and rel in (0, 1)
        note = f"composite {mo['calendar_date']} to +15 days; pixel reliability {rel} ({ {0: 'good', 1: 'marginal', 2: 'snow/ice', 3: 'cloudy'}.get(rel, '?') })"
        items["ndvi_modis"] = _item(round(mo["ndvi"], 3) if ok else None, "NDVI", mo["calendar_date"], nmm, f"MOD13Q1 v061 {mo['modis_date']}", "250 m", mo["url"], mo["fetched_at"],
                                    note=note, where=_ll(lat, lng), reliability=rel)
    else:
        items["ndvi_modis"] = _item(None, "NDVI", None, nmm, "MOD13Q1 v061", "250 m", ORNL, _now(), note=em or "no composite")
    # MODIS MOD16A2: evapotranspiration, potential ET and water availability WA = min(1, ET/PET)
    me, eme = _safe(modis_et_pet, lat, lng, d)
    nme = "MODIS Terra MOD16A2 v061 via ORNL DAAC"
    if me and me.get("calendar_date"):
        prod, note8 = f"MOD16A2 v061 {me['modis_date']}", f"8-day composite {me['calendar_date']} to +7 days"
        why = lambda v: "" if v is not None else "; fill value (water, barren or no data pixel)"
        items["et"] = _item(me["et"], "mm/8 days", me["calendar_date"], nme, prod + " ET_500m", "500 m", me["url"], me["fetched_at"], note=note8 + why(me["et"]), where=_ll(lat, lng))
        items["pet"] = _item(me["pet"], "mm/8 days", me["calendar_date"], nme, prod + " PET_500m", "500 m", me["url"], me["fetched_at"], note=note8 + why(me["pet"]), where=_ll(lat, lng))
        wa = water_availability(me["et"], me["pet"])
        items["wa"] = _item(wa, "ET/PET (0-1)", me["calendar_date"], nme, prod + " derived WA = min(1, ET/PET)", "500 m", me["url"], me["fetched_at"],
                            note=note8 + ("" if wa is not None else "; needs ET and PET > 0"), where=_ll(lat, lng))
    else:
        reason = eme or "no MOD16A2 composite"
        items["et"] = _item(None, "mm/8 days", None, nme, "MOD16A2 v061 ET_500m", "500 m", ORNL_ET, _now(), note=reason)
        items["pet"] = _item(None, "mm/8 days", None, nme, "MOD16A2 v061 PET_500m", "500 m", ORNL_ET, _now(), note=reason)
        items["wa"] = _item(None, "ET/PET (0-1)", None, nme, "MOD16A2 v061 derived WA", "500 m", ORNL_ET, _now(), note=reason)
    # Sentinel-1
    s1, e1 = _safe(sentinel1_water, lat, lng, d)
    nm1 = "Sentinel-1 RTC (ESA Copernicus) via Microsoft Planetary Computer"
    if s1 and s1.get("vv_db") is not None:
        items["water"] = _item(bool(s1["vv_db"] < -18), "standing water (VV < -18 dB)", s1["date"], nm1, s1["item"], "10 m", s1["url"], s1["fetched_at"], where=_ll(lat, lng), note=f"VV {s1['vv_db']:.1f} dB",
                               vv_db=round(s1["vv_db"], 2))
    else:
        items["water"] = _item(None, "standing water (VV < -18 dB)", None, nm1, "sentinel-1-rtc", "10 m", (s1 or {}).get("url", PC_STAC), (s1 or {}).get("fetched_at", _now()),
                               note=e1 or "no Sentinel-1 pass within ±6 days", vv_db=None)
    return items


# ------------------------------------------------------------------------------------------------ batch
def snapshot_loans(loans: list[dict], d: str, log=print, workers: int = 4) -> dict:
    """loans: dicts with id, lat, lng. Fields in the same 0.1°/0.05° cell share cached requests."""
    out = {}
    t0 = time.time()

    def one(l):
        return l["id"], dict(lat=l["lat"], lng=l["lng"], items=snapshot(l, d))
    with ThreadPoolExecutor(workers) as ex:
        for i, (k, v) in enumerate(ex.map(one, loans), 1):
            out[k] = v
            if i % 20 == 0:
                log(f"  {i}/{len(loans)} loans ({time.time() - t0:.0f}s)")
    return out


def summarize_sources(loans_out: dict) -> list[dict]:
    keys = ["rain", "tmin", "tmax", "soil", "ndvi_s2", "ndvi_modis", "et", "pet", "wa", "water"]
    out = []
    for k in keys:
        its = [v["items"][k] for v in loans_out.values()]
        ok = [i for i in its if i["value"] is not None]
        notes = {}
        for i in its:
            if i["source"]["note"]:
                n = i["source"]["note"].split(":")[0][:90] if i["value"] is None or "fallback" in i["source"]["note"] else None
                if n:
                    notes[n] = notes.get(n, 0) + 1
        names = sorted({i["source"]["name"] for i in ok})
        out.append(dict(item=k, sources=names, withValue=len(ok), total=len(its), notes=notes,
                        status="ok" if len(ok) == len(its) else ("partial" if ok else "no data")))
    out.append(dict(item="_http", stats={k: {a: round(b, 1) for a, b in v.items()} for k, v in STATS.items()}))
    return out


def main(argv=None):
    import argparse
    sys.path.insert(0, str(ROOT / "backend"))
    from loanly import loader
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default="2026-01-18")
    ap.add_argument("--book", action="append", help="loan book(s); default: samples/sample_farmers_10.xlsx and data/demo_loan_book.xlsx")
    ap.add_argument("--max-loans", type=int, default=None, help="per demo book: first N loans only")
    ap.add_argument("--out", default=str(ROOT / "web" / "public" / "data" / "real_snapshot.json"))
    a = ap.parse_args(argv)
    t0 = time.time()
    books = a.book or [str(ROOT / "samples" / "sample_farmers_10.xlsx"), str(ROOT / "data" / "demo_loan_book.xlsx")]
    # loan ids repeat across books (sample L001 is not demo L001), so each book keeps its own map:
    # doc.loans = the demo book (data/demo_loan_book.xlsx), doc.sampleLoans = samples/sample_farmers_10.xlsx
    per_book = {}
    for b in books:
        res = loader.load_book(Path(b), None)
        if res.book is None:
            raise SystemExit("\n".join(res.errors))
        ls = res.book.loans
        if a.max_loans and "sample" not in b:
            ls = ls[:a.max_loans]
        print(f"{Path(b).name}: snapshot for {a.date}, {len(ls)} loans")
        per_book["sampleLoans" if "sample" in Path(b).name else "loans"] = snapshot_loans([dict(id=l["id"], lat=l["lat"], lng=l["lng"]) for l in ls], a.date)
    gen = _now()
    allv = {f"{k}:{i}": v for k, m in per_book.items() for i, v in m.items()}
    doc = dict(date=a.date, generatedAt=gen, **per_book, sources=summarize_sources(allv))
    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1e6:.2f} MB) in {time.time() - t0:.0f}s")
    for s in doc["sources"]:
        print(s)


if __name__ == "__main__":
    main()
