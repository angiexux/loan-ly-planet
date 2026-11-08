"""Soil sensor readings for one loan and week.

Mirrors web/src/SoilSensors.tsx (same formulas, same FNV-1a hash, same fallbacks) so the PDF matches the Soil Sensors card.
SAMPLE DATA for the pilot: the readings are derived deterministically from the analysis series and the loan id for demonstration;
no real probe is connected, and the climate score works without sensors.
"""
from __future__ import annotations

import math

VWC_LO, VWC_HI = 22, 34   # normal range, % VWC


def _round(x):                      # JS Math.round (half up), not Python banker's rounding
    return int(math.floor(x + 0.5))


def _clamp(v, lo, hi):
    return min(hi, max(lo, v))


def _hash(s):                       # FNV-1a 32-bit over UTF-16 code units, as in the card
    h = 2166136261
    b = s.encode("utf-16-le")
    for i in range(0, len(b), 2):
        h ^= b[i] | (b[i + 1] << 8)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def _g(series, w, default):
    try:
        v = series[w]
    except (TypeError, IndexError, KeyError):
        return default
    return default if v is None else v


def sensor_readings(L, w):
    sm = _g(L.get("smPct"), w, 50)
    sat = _clamp(_round(8 + 0.30 * sm), 5, 45)
    dry = sm < 25
    r10 = _clamp(sat - (6 if dry else 1), 4, 45)
    reads = [(10, r10), (30, _clamp(r10 + 6, 4, 45)), (60, _clamp(r10 + 15, 4, 45))]
    disagree = r10 < sat - 4
    temp = _round(18 + _g(L.get("hotDays"), w, 0) * 2 + _g(L.get("tmin"), w, 12) * 0.4)
    h = _hash(L["id"])
    return dict(sat=sat, sensor=r10, reads=reads, dry=dry, disagree=disagree, conf=4 if disagree else 5, temp=temp,
                ec="%.1f" % (0.3 + (h % 91) / 100), ph="%.1f" % (5.8 + ((h >> 8) % 15) / 10),
                npk=["ok" if (h >> (16 + i)) & 1 else "low" for i in range(3)])
