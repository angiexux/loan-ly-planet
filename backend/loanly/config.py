"""All tunable parameters in one place.

Everything a risk team may want to challenge lives here (stage tables, peril thresholds, score weights, PD/LGD tables,
scenario weights, discount rate...). `export_parameters_xlsx()` writes them to an Excel workbook and `load_overrides()`
reads edited values back, so the bank can recalibrate without touching code.

IMPORTANT: the PD/LGD numbers and the climate-to-PD sensitivity (BETA) are ASSUMPTIONS for the demo. They must be
calibrated on the lender's own repayment history before any accounting use.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# ---------------------------------------------------------------------------------------------- time axis
W = 52                       # weeks in a season
DAYS = 364                   # 52 weeks; every season is aligned to this (leap day ignored)
SEASON_START = date(2025, 6, 1)   # week[i] = SEASON_START + 7*i days
HIST_YEARS = list(range(2004, 2025))   # season start years 2004/05 ... 2024/25 (21 past seasons; history ends in 2025)
N_HIST = len(HIST_YEARS)
N_SEASONS = N_HIST + 1       # + the current season 2025/26 (we operate in 2026) (index N_HIST)
CUR = N_HIST
AS_OF_DEFAULT = 33           # 2026-01-18, "late January 2026" = today for the app (no date control in the front end)

# ---------------------------------------------------------------------------------------------- crops
# stages: (name, weeks, weight). Weight = sensitivity of the crop to stress in that stage (flowering = 1.0).
# sow_week: typical sowing week index (0 = 1 Jun).  win = critical window = stages with weight >= CRITICAL_MIN_WEIGHT.
CRITICAL_MIN_WEIGHT = 0.8
HEAT_STAGE_WEIGHT = 0.95     # heat rule applies in the flowering stage only
FROST_STAGE_WEIGHT = 0.7
PRE_SOWING = ("Pre-sowing", 0.35)
HARVESTED = ("Harvested", 0.0)

CROPS = {
    "soy": dict(label="Soybean", color="#2e9d5b", price=520.0, cost_ha=430.0, yield_tha=3.1, sow_week=24, greenup_lag=4.8, gdd_total=2300.0,
                stages=[("Emergence", 3, 0.5), ("Vegetative", 7, 0.65), ("Flowering", 3, 1.0), ("Pod fill", 4, 0.9), ("Seed maturation", 2, 0.4), ("Harvest-ready", 2, 0.1)]),
    "maize": dict(label="Maize", color="#e0a21b", price=240.0, cost_ha=690.0, yield_tha=8.2, sow_week=17, greenup_lag=5.4, gdd_total=1900.0,
                  stages=[("Emergence", 3, 0.5), ("Vegetative", 8, 0.65), ("Silking", 3, 1.0), ("Grain fill", 6, 0.8), ("Dry-down", 3, 0.2)]),
    "wheat": dict(label="Wheat", color="#b5793a", price=300.0, cost_ha=380.0, yield_tha=3.2, sow_week=4, greenup_lag=5.9, gdd_total=1800.0,
                  stages=[("Tillering", 7, 0.55), ("Stem elongation", 7, 0.7), ("Heading & flowering", 4, 1.0), ("Grain fill", 4, 0.8), ("Ripening", 2, 0.2)]),
    "sunflower": dict(label="Sunflower", color="#f26b1d", price=480.0, cost_ha=360.0, yield_tha=2.2, sow_week=16, greenup_lag=4.4, gdd_total=1700.0,
                      stages=[("Emergence", 2, 0.5), ("Vegetative", 6, 0.65), ("Flowering", 3, 1.0), ("Seed fill", 5, 0.8), ("Maturity", 3, 0.2)]),
}
CROP_DURATION = {k: sum(s[1] for s in v["stages"]) for k, v in CROPS.items()}   # weeks sowing -> harvest

# ---------------------------------------------------------------------------------------------- regions (synthetic generator + nearest-region lookup)
# sev: hit of the 2025/26 drought scenario (0..1); hist: sensitivity to past dry years; crops: mix; n: loans in the demo book
REGIONS = [
    dict(id="AR-SF", country="Argentina", province="Santa Fe", name="Santa Fe · Centro", lat=-31.45, lng=-61.25, sev=0.95, hist=1.0, crops=dict(soy=.5, maize=.25, wheat=.2, sunflower=.05), n=34),
    dict(id="AR-BN", country="Argentina", province="Buenos Aires", name="Buenos Aires · Norte", lat=-33.85, lng=-60.55, sev=0.90, hist=0.9, crops=dict(soy=.5, maize=.3, wheat=.2), n=36),
    dict(id="AR-ER", country="Argentina", province="Entre Ríos", name="Entre Ríos · Paraná", lat=-31.95, lng=-59.95, sev=0.85, hist=0.9, crops=dict(soy=.5, maize=.2, wheat=.3), n=22),
    dict(id="AR-CS", country="Argentina", province="Córdoba", name="Córdoba · Sur", lat=-33.15, lng=-64.10, sev=0.80, hist=1.0, crops=dict(soy=.45, maize=.35, wheat=.15, sunflower=.05), n=30),
    dict(id="AR-LP", country="Argentina", province="La Pampa", name="La Pampa · Este", lat=-35.65, lng=-63.75, sev=0.65, hist=1.1, crops=dict(sunflower=.3, maize=.3, wheat=.3, soy=.1), n=18),
    dict(id="AR-BS", country="Argentina", province="Buenos Aires", name="Buenos Aires · Sudeste", lat=-37.30, lng=-59.10, sev=0.40, hist=0.8, crops=dict(wheat=.4, sunflower=.3, soy=.2, maize=.1), n=24),
    dict(id="AR-SA", country="Argentina", province="Salta", name="Salta · Este", lat=-24.90, lng=-64.10, sev=0.25, hist=0.8, crops=dict(soy=.6, maize=.4), n=12),
    dict(id="UY-SO", country="Uruguay", province="Soriano", name="Soriano", lat=-33.45, lng=-57.75, sev=0.70, hist=0.8, crops=dict(soy=.6, wheat=.3, maize=.1), n=22),
    dict(id="BR-RS", country="Brazil", province="Rio Grande do Sul", name="Rio Grande do Sul · Missões", lat=-28.30, lng=-54.30, sev=0.75, hist=0.9, crops=dict(soy=.7, maize=.2, wheat=.1), n=26),
    dict(id="PY-IT", country="Paraguay", province="Itapúa", name="Itapúa", lat=-26.90, lng=-55.90, sev=0.35, hist=0.7, crops=dict(soy=.7, maize=.2, wheat=.1), n=16),
]
REGION_BY_ID = {r["id"]: r for r in REGIONS}
# plausible bounding box of Latin America used by the loader
LATAM_BOX = dict(lat=(-56.0, 13.0), lng=(-93.0, -34.0))

# ---------------------------------------------------------------------------------------------- data cleaning (METHODS 1)
SG_WINDOW = 5                # Savitzky-Golay window (weeks) and polynomial order
SG_POLY = 2
# Sentinel-2 SCL classes masked: 3 cloud shadow, 8/9 cloud medium/high prob, 10 thin cirrus, 11 snow
S2_SCL_MASK = [3, 8, 9, 10, 11]
SM_HOT_C = 35.0              # a "hot day" has tmax above this
FROST_C = -2.0

# ---------------------------------------------------------------------------------------------- anomalies (METHODS 3)
NDVI_SD_FLOOR = 0.025
SPI_WINDOWS = (30, 60, 90)   # days

# ---------------------------------------------------------------------------------------------- stress (METHODS 4)
PERIL_RULES = dict(
    drought=dict(spi60=-1.0, sm_pct=20.0, ndvi_z=-1.5),
    excess_water=dict(spi30=1.5, sm_pct=90.0, water_frac=0.10),
    frost=dict(tmin=FROST_C, min_stage_weight=FROST_STAGE_WEIGHT),
    heat=dict(hot_days=3, window_weeks=2, tmax=SM_HOT_C, min_stage_weight=HEAT_STAGE_WEIGHT),
    hail=dict(ndvi_anom_drop_1w=0.06, ndvi_anom_drop=0.12, weeks=2, min_stage_weight=0.5, ndvi_z=-1.0, spi60_min=-0.5, max_hot_days=2),
)
# intensity 0-100 per peril: how far inside the rule the indicators are (ramps)
DROUGHT_INTENSITY = dict(rain_w=0.30, soil_w=0.25, veg_w=0.45)      # weights of SPI-60, soil moisture, NDVI z
CASCADE_MULT = dict(none=0.55, early=0.8, active=1.0, confirmed=1.15)
PERIL_WEIGHTS = dict(drought=1.0, excess_water=0.9, frost=1.0, heat=0.8, hail=1.0)   # weight in the weighted sum
SCORE_HALF_LIFE_WEEKS = 4.0  # past damage fades with this half-life
SCORE_GAIN = 0.32            # share of this week's weighted stress added to the accumulated score
# Bounds: no score or peril intensity is ever exactly 0 or 100. 0 would claim "no risk at all" and 100 "certain loss", and a hard cap
# made many loans tie at 100 so they could not be ranked. Values pass through a soft ceiling (identity up to the knee, then bending
# smoothly towards SCORE_MAX) and are floored at SCORE_MIN.
SCORE_MIN = 1.0
SCORE_MAX = 99.0
SCORE_SOFT_KNEE = 75.0
# Heat and drought: heat at flowering on a crop that is already water-stressed does more damage than heat alone (stomata close,
# the canopy cannot cool by transpiring, pollen fails). While the drought cascade is "active" or "confirmed", heat intensity is
# multiplied by HOT_DRY_MULT before perils are combined, and the heat is attributed to the drought (main peril = drought).
HOT_DRY_MULT = 1.3
# Peril "pressure": a peril that is NOT triggered is published with a graded 1-34 value from its own indicators (how warm, how wet,
# how close to frost, how unsettled the canopy), how unusual they are for this field and week, and how often the rule fired before
# harvest in the field's past seasons (see stress.py), so the five perils read like real, different conditions instead of one big number
# and four 1s. A triggered peril shows its rule intensity when that is larger. Display only: the score is built from the triggered
# intensities, and only a value at or above PERIL_MAIN_MIN can be the main peril.
PERIL_QUIET_MAX = 34.0
PERIL_MAIN_MIN = 35.0
LEVELS = ["Normal", "Watch", "High", "Severe"]
HYST_UP = [25, 45, 70]       # enter Watch / High / Severe at or above
HYST_DOWN = [25, 45, 70]     # leave them below the same values: levels are fixed score bands (Normal 1-24, Watch 25-44, High 45-69,
                             # Severe 70-99) so a level always matches its score everywhere; the season-smoothed score keeps levels steady
LOCATION_QUALITY = dict(polygon=1.0, point=0.7)

# ---------------------------------------------------------------------------------------------- yield model (METHODS 6)
IRRIGATED_LOSS_FACTOR = 0.4  # irrigated fields lose less than the rain-fed department average
YIELD_ANOM_CLIP = (-0.95, 0.40)
INTERVAL_WIDEN_BEFORE_SOWING = 1.25
INTERVAL_WIDEN_IN_SEASON = 0.40   # extra half-width at sowing, fading to 0 at the end of the critical window

# ---------------------------------------------------------------------------------------------- IFRS 9 (METHODS 7)
BETA = 3.0                   # logit(PD_new) = logit(PD_orig) + BETA * expected yield loss (fraction)
SICR_MULTIPLIER = 2.0        # Stage 2 if PD >= 2x PD at origination
DISCOUNT_RATE = 0.08         # annual, proxy for the effective interest rate
SCENARIO_WEIGHTS = dict(base=0.60, adverse=0.25, severe=0.15)
RESTRUCTURING_EXTENSION_MONTHS = 12   # Stage 2 on a short crop loan: assume one more year of exposure
MAX_MONTHS = 36
PD_BY_RATING = {1: 0.004, 2: 0.008, 3: 0.015, 4: 0.028, 5: 0.050, 6: 0.090, 7: 0.160, 8: 0.300}
LGD_BY_COLLATERAL = {"land mortgage": 0.28, "warrant on grain": 0.38, "machinery pledge": 0.40, "crop pledge": 0.45, "unsecured": 0.62}
CROP_BASED_COLLATERAL = ("crop pledge", "warrant on grain")   # value falls with the yield loss
LGD_FLOOR, LGD_CAP = 0.10, 0.90
# BCRA debtor classification (situacion) -> IFRS 9 stage. Com. "A" 6847 (IFRS 9 impairment).
BCRA_STAGE = {1: 1, 2: 2, 3: 3, 4: 3, 5: 3, 6: 3}
DPD_STAGE2, DPD_STAGE3 = 30, 90
PD_CAP = 0.99
DEFAULT_RATING = 4

# ---------------------------------------------------------------------------------------------- alerts / LLM (METHODS 9)
LLM_MODEL = "claude-sonnet-5-5"
LLM_MAX_CALLS = 40

# ---------------------------------------------------------------------------------------------- portfolio (METHODS 8)
DBSCAN_EPS_KM = 60.0
DBSCAN_MIN_SAMPLES = 3

LENDER = "Banco de la República Austral"
SEASON_LABEL = f"{SEASON_START.year}/{str(SEASON_START.year + 1)[2:]}"

# names of the editable tables, used by export / load_overrides
SCALARS = ["BETA", "SICR_MULTIPLIER", "DISCOUNT_RATE", "SCORE_HALF_LIFE_WEEKS", "SCORE_GAIN", "SCORE_MIN", "SCORE_MAX", "SCORE_SOFT_KNEE", "HOT_DRY_MULT", "RESTRUCTURING_EXTENSION_MONTHS",
           "LGD_FLOOR", "LGD_CAP", "DPD_STAGE2", "DPD_STAGE3", "IRRIGATED_LOSS_FACTOR", "DBSCAN_EPS_KM", "DBSCAN_MIN_SAMPLES"]


def week_date(i: int) -> date:
    from datetime import timedelta
    return SEASON_START + timedelta(days=7 * int(i))


WEEK_DATES = [week_date(i) for i in range(W)]


def stage_bounds(crop: str):
    """Cumulative stage boundaries (in weeks after sowing) for a crop."""
    out, t = [], 0
    for name, wk, wt in CROPS[crop]["stages"]:
        out.append((name, t, t + wk, wt))
        t += wk
    return out


def critical_window(crop: str):
    """(first, last) week offset after sowing of the stages with weight >= CRITICAL_MIN_WEIGHT."""
    b = [x for x in stage_bounds(crop) if x[3] >= CRITICAL_MIN_WEIGHT]
    return b[0][1], b[-1][2] - 1


# ---------------------------------------------------------------------------------------------- parameter workbook
def _tables():
    return {
        "General": [("name", "value", "meaning")] + [(k, globals()[k], "") for k in SCALARS],
        "Scenarios": [("scenario", "weight")] + list(SCENARIO_WEIGHTS.items()),
        "PD_by_rating": [("rating", "pd_12m")] + list(PD_BY_RATING.items()),
        "LGD_by_collateral": [("collateral_type", "lgd")] + list(LGD_BY_COLLATERAL.items()),
        "Crop_prices": [("crop", "price_usd_per_t", "cost_usd_per_ha", "ref_yield_t_ha")] + [(k, v["price"], v["cost_ha"], v["yield_tha"]) for k, v in CROPS.items()],
        "Stage_tables": [("crop", "stage", "weeks", "weight")] + [(c, n, wk, wt) for c, v in CROPS.items() for n, wk, wt in v["stages"]],
        "Peril_thresholds": [("peril", "parameter", "value")] + [(p, k, v) for p, d in PERIL_RULES.items() for k, v in d.items()],
        "Score_weights": [("item", "value")] + [(f"peril_weight:{k}", v) for k, v in PERIL_WEIGHTS.items()]
                         + [(f"drought_intensity:{k}", v) for k, v in DROUGHT_INTENSITY.items()] + [(f"cascade_mult:{k}", v) for k, v in CASCADE_MULT.items()],
        "Hysteresis": [("level", "up", "down")] + [(LEVELS[i + 1], HYST_UP[i], HYST_DOWN[i]) for i in range(3)],
        "BCRA_to_stage": [("bcra_situacion", "ifrs9_stage")] + list(BCRA_STAGE.items()),
    }


README_ROWS = [
    "Loan-ly Planet: editable parameters for the climate-risk and IFRS 9 module.",
    "Edit the values in the other sheets and save; the analysis reads this workbook back.",
    "Sheets: General, Scenarios, PD_by_rating, LGD_by_collateral, Crop_prices, Stage_tables, Peril_thresholds, Score_weights, Hysteresis, BCRA_to_stage.",
    "Base PDs follow the order of magnitude of BCRA agricultural non-performing statistics; PD by rating, LGD by collateral and the climate sensitivity (beta) can be calibrated to your own repayment history.",
]


def export_parameters_xlsx(path) -> Path:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    wb = Workbook()
    ws = wb.active
    ws.title = "README"
    for i, line in enumerate(README_ROWS, 1):
        ws.cell(i, 1, line)
    ws["A1"].font = Font(bold=True, size=13)
    ws.column_dimensions["A"].width = 150
    for name, rows in _tables().items():
        s = wb.create_sheet(name)
        for r in rows:
            s.append(list(r))
        for c in s[1]:
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = PatternFill("solid", fgColor="1F4E3D")
            c.alignment = Alignment(horizontal="center")
        s.freeze_panes = "A2"
        for col in s.columns:
            s.column_dimensions[col[0].column_letter].width = max(14, min(40, max(len(str(c.value or "")) for c in col) + 2))
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path


def load_overrides(path=None) -> list[str]:
    """Read edited parameters back from the workbook (if present). Returns the list of sheets applied."""
    path = Path(path) if path else ROOT / "samples" / "ifrs9_parameters.xlsx"
    if not path.exists():
        return []
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True)
    g = globals()
    applied = []

    def rows(name):
        if name not in wb.sheetnames:
            return []
        return [r for r in list(wb[name].iter_rows(values_only=True))[1:] if r and r[0] is not None]

    for r in rows("General"):
        if r[0] in SCALARS and isinstance(r[1], (int, float)):
            g[r[0]] = type(g[r[0]])(r[1])
            applied.append("General")
    for sheet, target, cast in (("Scenarios", SCENARIO_WEIGHTS, str), ("PD_by_rating", PD_BY_RATING, int),
                                ("LGD_by_collateral", LGD_BY_COLLATERAL, str), ("BCRA_to_stage", BCRA_STAGE, int)):
        for r in rows(sheet):
            if isinstance(r[1], (int, float)):
                target[cast(r[0])] = float(r[1]) if sheet != "BCRA_to_stage" else int(r[1])
        if rows(sheet):
            applied.append(sheet)
    for r in rows("Crop_prices"):
        if r[0] in CROPS and len(r) >= 4:
            CROPS[r[0]].update(price=float(r[1]), cost_ha=float(r[2]), yield_tha=float(r[3]))
    stg = {}
    for r in rows("Stage_tables"):
        if r[0] in CROPS:
            stg.setdefault(r[0], []).append((str(r[1]), int(r[2]), float(r[3])))
    for c, lst in stg.items():
        CROPS[c]["stages"] = lst
        CROP_DURATION[c] = sum(s[1] for s in lst)
    for r in rows("Peril_thresholds"):
        if r[0] in PERIL_RULES and r[1] in PERIL_RULES[r[0]] and isinstance(r[2], (int, float)):
            PERIL_RULES[r[0]][r[1]] = r[2]
    for r in rows("Score_weights"):
        kind, _, key = str(r[0]).partition(":")
        tgt = dict(peril_weight=PERIL_WEIGHTS, drought_intensity=DROUGHT_INTENSITY, cascade_mult=CASCADE_MULT).get(kind)
        if tgt is not None and key in tgt and isinstance(r[1], (int, float)):
            tgt[key] = float(r[1])
    for r in rows("Hysteresis"):
        if r[0] in LEVELS[1:]:
            i = LEVELS.index(r[0]) - 1
            HYST_UP[i], HYST_DOWN[i] = float(r[1]), float(r[2])
    if wb.sheetnames:
        applied.append("workbook")
    return sorted(set(applied))

# ---------------------------------------------------------------------------------------------- Crop Health Index CHI v1 (METHODS 10)
# Crop Health Index (CHI v1, Sviana technical note; backend/loanly/fhi.py). DISPLAY indicator here: it must NOT feed PD, staging, ECL or alerts.
# Default crop season as "first-last month" when the field's sowing / harvest are unknown (Eq. 7): summer crops 1 Oct - 30 Apr,
# winter crops 1 Jun - 31 Dec. Critical period for the season summary: soy Jan-Feb, maize Dec-Jan, wheat / barley Sep-Oct (note);
# sunflower Dec-Jan is our assumption (flowering in the Pampas), the note does not list it.
FHI_SEASON = {"soy": "10-04", "maize": "10-04", "sunflower": "10-04", "wheat": "06-12", "barley": "06-12"}
FHI_SEASON_DEFAULT = "10-04"
FHI_CRITICAL = {"soy": "01-02", "maize": "12-01", "sunflower": "12-01", "wheat": "09-10", "barley": "09-10"}
FHI_NOTE = "Crop Health Index (CHI v1); shown for context, does not change PD"


def fhi_critical(crop: str) -> str | None:
    return FHI_CRITICAL.get(crop)


def fhi_season(crop: str) -> str:
    return FHI_SEASON.get(crop, FHI_SEASON_DEFAULT)
