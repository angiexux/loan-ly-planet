"""Module 4 (METHODS 4): what kind of stress, and how bad?  Rule-based and fully explainable (no black box).

Perils (thresholds in config.PERIL_RULES, from METHODS section 4):
  drought       SPI-60 < -1 AND soil moisture < 20th percentile; "confirmed" when NDVI z < -1.5
  excess_water  SPI-30 > +1.5 AND soil > 90th percentile, or radar water fraction > 10 % (radar confirms by itself)
  frost         weekly minimum temperature < -2 C while the crop is in a stage with weight >= 0.7
  heat          >= 3 days above 35 C (this and the previous week) during flowering
  hail          sudden NDVI drop (>= 0.06 in a week and >= 0.12 in 2 weeks against the field's own normal, NDVI z < -1) that neither
                heat (<= 2 hot days), a rain deficit (SPI-60 > -0.5) nor radar flooding explains
Drought cascade (drought is slow, so we show how far the evidence chain has progressed):
  none -> early (rain deficit only) -> active (+ dry soil) -> confirmed (+ crop greenness below normal)
Score on a 1-99 scale (never exactly 0 or 100, see config.SCORE_MIN / SCORE_MAX):
  intensity_k per peril = how far inside the rule the indicators are, soft-capped below 100;
  hot-dry compound: while the drought cascade is active/confirmed, heat intensity x HOT_DRY_MULT (heat hurts a water-stressed crop more)
  instant_t   = stage_weight_t x 100 x (1 - prod_k (1 - peril_weight_k x intensity_k,t / 100))
                (perils combine like independent damage shares, so two perils are worse than one but never add past 100;
                 a stressed flowering crop counts more than a stressed seedling)
  score_t     = soft(decay x score_(t-1) + gain x instant_t)      decay = 0.5^(1/half-life): damage accumulates but fades;
                soft() = identity up to the knee (75), then bends smoothly towards 99, so the worst loans stay rankable
              (once the crop is harvested the score is frozen: the yield loss is realised and still weighs on repayment until maturity)
Published peril values (display only, the score above uses the triggered intensities): the larger of the triggered intensity and a
1-34 "pressure" = 34 x sqrt(sensitivity x (0.4 current conditions + 0.3 percentile vs the field's own past seasons in the same weeks
+ 0.3 sqrt(share of past seasons in which the rule fired before harvest))). Only >= 35 (a triggered rule) can be the main peril.
Level = Normal / Watch / High / Severe as FIXED SCORE BANDS (config HYST_UP = HYST_DOWN = [25, 45, 70]: Normal 1-24, Watch 25-44,
High 45-69, Severe 70-99), identical on the map legend, tables and reports. The hysteresis() helper still supports a lower exit bar if
HYST_DOWN is set below HYST_UP
(entering needs >= up, leaving needs < down).
Confidence = indicator agreement x location quality (polygon 1.0, point 0.7) x cloud-free share of recent images.
Reasons = the computed facts behind each week's number ({code, value}); wording is done later by templates / LLM.
"""
from __future__ import annotations

import numpy as np

from . import config as C

CASCADE_HOLD_WEEKS = 3      # the displayed cascade stage steps down only after 3 weeks below it (weekly noise must not flicker the story)
PERILS = ["drought", "excess_water", "frost", "heat", "hail"]


def hysteresis(score, up=None, down=None):
    """Level index 0..3 from a score series (last axis = time). Entering a level needs `up`, leaving it needs score < `down`."""
    up = C.HYST_UP if up is None else up
    down = C.HYST_DOWN if down is None else down
    score = np.asarray(score, float)
    lvl = np.zeros(score.shape, int)
    state = np.zeros(score.shape[:-1], int)
    for t in range(score.shape[-1]):
        s = score[..., t]
        for _ in range(3):
            state = np.where((state < 3) & (s >= np.take(up, np.minimum(state, 2))), state + 1, state)
        for _ in range(3):
            state = np.where((state > 0) & (s < np.take(down, np.maximum(state - 1, 0))), state - 1, state)
        lvl[..., t] = state
    return lvl


def soft_cap(x, knee=None, top=None):
    """Identity up to `knee`, then a smooth exponential approach to `top` (slope 1 at the knee, never reaches `top`)."""
    knee = C.SCORE_SOFT_KNEE if knee is None else knee
    top = C.SCORE_MAX if top is None else top
    x = np.asarray(x, float)
    return np.where(x <= knee, x, knee + (top - knee) * (1.0 - np.exp(-(x - knee) / (top - knee))))


def bounded(x):
    """What is published: soft-capped below 99 and floored at 1 (no exact 0 or 100)."""
    return np.maximum(C.SCORE_MIN, soft_cap(x))


def accumulate(instant, half_life=None, gain=None, hold=None):
    half_life = C.SCORE_HALF_LIFE_WEEKS if half_life is None else half_life
    gain = C.SCORE_GAIN if gain is None else gain
    decay = 0.5 ** (1.0 / half_life)
    out = np.zeros_like(instant, dtype=float)
    prev = np.zeros(instant.shape[:-1])
    for t in range(instant.shape[-1]):
        new = soft_cap(decay * prev + gain * instant[..., t])
        prev = new if hold is None else np.where(hold[..., t], prev, new)      # after harvest the realised damage is frozen, not forgotten
        out[..., t] = prev
    return out


def _ramp(x, lo, hi):
    return np.clip((x - lo) / (hi - lo), 0, 1)


def hist_pct(cur, hist):
    """Percentile (0-100) of each (field, week) value among the same field's past seasons in weeks w-1..w+1. cur (F, W), hist (F, Y, W)."""
    F, Y, Wn = hist.shape
    ref = np.concatenate([np.roll(hist, s, axis=2) for s in (-1, 0, 1)], axis=1)          # (F, 3Y, W)
    v = cur[:, None, :]
    return 100.0 * ((ref < v).sum(1) + 0.5 * (ref == v).sum(1)) / ref.shape[1]


def _drop1(anom):
    return np.concatenate([anom[..., :1], anom[..., :-1]], axis=-1) - anom


def _hot2(hot):
    return hot + np.concatenate([np.zeros_like(hot[..., :1]), hot[..., :-1]], axis=-1)


def run(sig: dict, stage_w: np.ndarray, has_polygon: np.ndarray, irrigated: np.ndarray, present: np.ndarray) -> dict:
    """sig: (F, W) arrays of the current season: ndvi, ndvi_z, clim_mean, spi30/60/90, sm_pct, tmin, hot, water, cloud_free.
    stage_w: (F, W) stage weights; present: (F, W) bool, a crop is in the field (between sowing and harvest). Returns dict of (F, W) arrays plus the per-week reasons."""
    R = C.PERIL_RULES
    z, spi30, spi60, sm, tmin, hot, water = (sig[k] for k in ("ndvi_z", "spi30", "spi60", "sm_pct", "tmin", "hot", "water"))
    F, Wn = z.shape
    crop_on = present & (stage_w >= 0.3)
    irr = irrigated[:, None]

    # ---- drought and its cascade
    early = spi60 < R["drought"]["spi60"]
    active = early & (sm < R["drought"]["sm_pct"])
    confirmed = active & (z < R["drought"]["ndvi_z"]) & crop_on
    cidx = confirmed * 3 + (active & ~confirmed) * 2 + (early & ~active) * 1
    hold = np.stack([np.roll(cidx, k, axis=1) * (np.arange(Wn) >= k) for k in range(CASCADE_HOLD_WEEKS)]).max(0)     # a drought stage is kept 3 weeks
    cascade = np.array(["none", "early", "active", "confirmed"])[hold]
    d = C.DROUGHT_INTENSITY
    i_drought = 100 * (d["rain_w"] * _ramp(-spi60, 0.5, 2.5) + d["soil_w"] * _ramp(30 - sm, 0, 30) + d["veg_w"] * _ramp(-z, 0.5, 3.0) * crop_on)
    i_drought = np.clip(i_drought * np.vectorize(C.CASCADE_MULT.get)(cascade), 0, 100) * np.where(irr, 0.4, 1.0)

    # ---- excess water
    ex_rule = (spi30 > R["excess_water"]["spi30"]) & (sm > R["excess_water"]["sm_pct"])
    ex_radar = water > R["excess_water"]["water_frac"]
    i_excess = np.where(ex_rule | ex_radar, 100 * (0.3 * _ramp(spi30, 1, 3) + 0.2 * _ramp(sm, 80, 100) + 0.5 * _ramp(water, 0, 0.3)), 0.0)
    i_excess = np.where(ex_radar, np.maximum(i_excess, 40), i_excess)

    # ---- frost, heat
    fr = (tmin < R["frost"]["tmin"]) & (stage_w >= R["frost"]["min_stage_weight"])
    i_frost = np.where(fr, 30 + 70 * _ramp(R["frost"]["tmin"] - tmin, 0, 5), 0.0)
    hot2 = hot + np.concatenate([np.zeros((F, 1)), hot[:, :-1]], axis=1)
    he = (hot2 >= R["heat"]["hot_days"]) & (stage_w >= R["heat"]["min_stage_weight"])
    i_heat = np.where(he, np.clip(25 + 75 * (hot2 - R["heat"]["hot_days"]) / 5, 25, 100), 0.0) * np.where(irr, 0.6, 1.0)

    # ---- hail: sudden drop of the NDVI anomaly
    anom = sig["ndvi"] - sig["clim_mean"]
    prev1 = np.concatenate([anom[:, :1], anom[:, :-1]], axis=1)
    prev2 = np.concatenate([np.repeat(anom[:, :1], 2, axis=1), anom[:, :-2]], axis=1)
    drop1, drop = prev1 - anom, prev2 - anom
    h = R["hail"]
    # sudden (1 week) and sustained (2 weeks) fall of the NDVI anomaly that heat or a rain deficit does NOT explain
    ha = ((drop1 >= h["ndvi_anom_drop_1w"]) & (drop >= h["ndvi_anom_drop"]) & (z < h["ndvi_z"]) & (stage_w >= h["min_stage_weight"]) & present
          & (water < 0.1) & (hot2 <= h["max_hot_days"]) & (spi60 > h["spi60_min"]))
    i_hail = np.where(ha, 100 * np.clip(drop / 0.3, 0.3, 1.0), 0.0)

    # ---- heat x drought: heat on a crop already in an active/confirmed drought compounds it (and is attributed to the drought)
    hot_dry = he & ((cascade == "active") | (cascade == "confirmed"))
    i_heat = np.where(hot_dry, i_heat * C.HOT_DRY_MULT, i_heat)

    raw = dict(drought=i_drought, excess_water=i_excess, frost=i_frost, heat=i_heat, hail=i_hail)
    raw = {k: soft_cap(v) for k, v in raw.items()}
    # combine as independent damage shares: 1 - prod(1 - w x I / 100); two perils are worse than one but cannot double-count past 100
    keep = np.ones_like(z)
    for k, v in raw.items():
        keep = keep * (1.0 - C.PERIL_WEIGHTS[k] * v / 100.0)
    instant = stage_w * 100.0 * (1.0 - keep)
    score_raw = accumulate(instant, hold=stage_w <= 0.0)
    score = bounded(score_raw)
    level = hysteresis(np.round(score, 1))      # from the published (1-decimal) score, so level and score always agree
    # published intensities: the larger of the triggered intensity and a graded 1-34 "pressure" from the peril's
    # own indicators (0-1 blend x PERIL_QUIET_MAX), weighted by how sensitive the crop is now. Display only -- the score uses `raw`.
    sens = np.where(present, 0.6 + 0.4 * stage_w, 0.4)
    pressure = dict(
        drought=0.40 * _ramp(-spi60, -0.5, -R["drought"]["spi60"]) + 0.35 * _ramp(45 - sm, 0, 45 - R["drought"]["sm_pct"]) + 0.25 * _ramp(-z, 0, 1.5) * crop_on,
        excess_water=0.45 * _ramp(spi30, -3.0, R["excess_water"]["spi30"]) + 0.35 * _ramp(sm, 0, R["excess_water"]["sm_pct"]) + 0.20 * _ramp(water, 0, R["excess_water"]["water_frac"]),
        frost=_ramp(18.0 - tmin, 0, 18.0 - R["frost"]["tmin"]),                                        # nights closer to frost
        heat=0.55 * _ramp(hot2, 0, R["heat"]["hot_days"]) + 0.30 * _ramp(tmin, 10, 22) + 0.15 * _ramp(40 - sm, 0, 40),   # hot days, warm nights, dry soil
        hail=present * (0.15 + 0.35 * _ramp(tmin, 12, 20) + 0.50 * _ramp(drop1, 0, h["ndvi_anom_drop_1w"])),            # convective season + canopy drops
    )
    # ... blended 50/50 with how unusual this week is for that peril on this field: percentile against its own past seasons
    hs = sig.get("hist")
    if hs is not None:
        hhot = _hot2(hs["hot"])
        unusual = dict(
            drought=hist_pct(-spi60, -hs["spi60"]), excess_water=hist_pct(spi30, hs["spi30"]), frost=hist_pct(-tmin, -hs["tmin"]),
            heat=hist_pct(hot2 + tmin / 10.0, hhot + hs["tmin"] / 10.0), hail=hist_pct(drop1, _drop1(hs["anom"])) * present,
        )
        # how often the peril's own rule fired on this field between this week and harvest, in its past seasons (21 years)
        hd = hs["anom"]
        hdrop1 = _drop1(hd)
        hdrop2 = np.concatenate([np.repeat(hd[..., :1], 2, axis=-1), hd[..., :-2]], axis=-1) - hd
        trig = dict(
            drought=(hs["spi60"] < R["drought"]["spi60"]) & (hs["sm_pct"] < R["drought"]["sm_pct"]),
            excess_water=((hs["spi30"] > R["excess_water"]["spi30"]) & (hs["sm_pct"] > R["excess_water"]["sm_pct"])) | (hs["water"] > R["excess_water"]["water_frac"]),
            frost=hs["tmin"] < R["frost"]["tmin"],
            heat=hhot >= R["heat"]["hot_days"],
            hail=(hdrop1 >= h["ndvi_anom_drop_1w"]) & (hdrop2 >= h["ndvi_anom_drop"]) & (hs["ndvi_z"] < h["ndvi_z"]) & (hs["spi60"] > h["spi60_min"]),
        )
        season = present[:, None, :]
        chance = {}
        for k, tr in trig.items():
            rem = np.flip(np.maximum.accumulate(np.flip(tr & season, -1), axis=-1), -1)      # fires at least once from week t to harvest
            chance[k] = rem.mean(1) * present                                                  # share of past seasons
        pressure = {k: 0.40 * np.clip(v, 0, 1) + 0.30 * unusual[k] / 100.0 + 0.30 * np.sqrt(chance[k]) for k, v in pressure.items()}
    perils = {}
    for k, v in raw.items():
        quiet = np.maximum(C.SCORE_MIN, C.PERIL_QUIET_MAX * np.sqrt(np.clip(pressure[k], 0, 1) * sens) * np.where(irr & (k in ("drought", "heat")), 0.6, 1.0))
        perils[k] = np.maximum(bounded(v), quiet)

    # ---- confidence: agreement x location quality x cloud-free share
    votes_stress = (spi60 < -0.75).astype(int) + (sm < 30) + ((z < -1.0) & crop_on)
    votes_ok = (spi60 > -0.5).astype(int) + (sm > 35) + ((z > -0.7) | ~crop_on)
    agree = np.maximum(votes_stress, votes_ok) / 3.0
    cf = sig["cloud_free"]
    cf3 = (cf + np.concatenate([cf[:, :1], cf[:, :-1]], 1) + np.concatenate([cf[:, :2], cf[:, :-2]], 1)) / 3.0
    loc = np.where(has_polygon, C.LOCATION_QUALITY["polygon"], C.LOCATION_QUALITY["point"])[:, None]
    conf = (0.5 + 0.5 * agree) * loc * (0.5 + 0.5 * cf3)

    flags = dict(drought_conf=confirmed, hail=ha, frost=fr, heat=he, excess=ex_rule | ex_radar, hot_dry=hot_dry)
    return dict(score=score, level=level, perils=perils, cascade=cascade, confidence=np.clip(conf, 0, 1), instant=instant, flags=flags, hot2=hot2)


def build_reasons(f: int, sig: dict, st: dict, stage_name: list, stage_w: np.ndarray, irrigated: bool, max_n: int = 5) -> list:
    """Per week: the computed facts behind the number, most important first. Returns W lists of {code, value}."""
    out = []
    z, spi30, spi60, spi90, sm, pct = (sig[k][f] for k in ("ndvi_z", "spi30", "spi60", "spi90", "sm_pct", "ndvi_pct"))
    conf = st["confidence"][f]
    for w in range(len(z)):
        r = []
        nm = stage_name[w]
        if nm == C.PRE_SOWING[0]:
            r.append(("not_sown", 1))
        elif nm == C.HARVESTED[0]:
            r.append(("harvested", 1))
        else:
            r.append(("stage", round(float(stage_w[w]), 2)))
        if st["flags"]["hail"][f, w]:
            r.append(("hail_drop", round(float(sig["ndvi"][f, w] - sig["clim_mean"][f, w]), 2)))
        if z[w] <= -1.0 and nm not in (C.PRE_SOWING[0], C.HARVESTED[0]):
            r.append(("ndvi_z", round(float(z[w]), 1)))
            r.append(("ndvi_pct", round(float(pct[w]), 0)))
        if spi60[w] <= -1.0:
            r.append(("spi60", round(float(spi60[w]), 1)))
        if spi90[w] <= -1.2 and spi60[w] > -1.0:
            r.append(("spi90", round(float(spi90[w]), 1)))
        if spi30[w] >= 1.5:
            r.append(("spi30", round(float(spi30[w]), 1)))
        if sm[w] < 20 or sm[w] > 90:
            r.append(("sm_pct", round(float(sm[w]), 0)))
        if st["flags"]["frost"][f, w]:
            r.append(("frost_min", round(float(sig["tmin"][f, w]), 1)))
        if st["flags"]["heat"][f, w]:
            r.append(("hot_days", int(st["hot2"][f, w])))
        if sig["water"][f, w] > 0.05:
            r.append(("water_frac", round(float(sig["water"][f, w]), 2)))
        if irrigated and st["cascade"][f, w] != "none":
            r.append(("irrigated", 1))
        if conf[w] < 0.5:
            r.append(("low_confidence", round(float(conf[w]), 2)))
        out.append([dict(code=c, value=v) for c, v in r[:max_n]])
    return out
