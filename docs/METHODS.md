# Loan-ly Planet: methods spec (from the team, 2026-11-07)

A transparent, rule- and statistics-based pipeline: anomalies against each field's own history, an indicator chain per peril,
regression for yields, standard credit-risk formulas. ML is an optional upgrade. Bank risk teams must be able to explain every number.

## 1. Data per field: `fetch_earth_engine.py`
- Cloud masking with the satellite's own quality flags (Sentinel-2 SCL classes 3,8,9,10,11 masked; MODIS QA bits).
- One value per field: zonal statistics (mean of pixels inside the field polygon).
- Weekly series: temporal compositing, **median** of each week's clear images.
- Fill gaps: linear interpolation between clear weeks, then **Savitzky–Golay** smoothing.
- NDVI = (NIR − red) / (NIR + red).
- Sources: Sentinel-2, MODIS (long baseline), CHIRPS (rain), ERA5-Land (temperature), SMAP (soil moisture), Sentinel-1 (water).

## 2. Crop stage: `crop_calendar.py`
- Planting date known: days since sowing → stages via crop-specific stage lengths (lookup table; optionally growing degree days).
- Unknown: phenology detection. Green-up = smoothed NDVI rises past 20% of its seasonal range; back-date planting by typical emergence time.
- Output: a stage weight per week (e.g. flowering = 1.0, vegetative = 0.5).

## 3. Is this week normal? `anomalies.py`
- Climatology: per field and week of year, mean and sd of the same week across 20+ past years.
- z = (this week − mean) / sd. Percentile rank among past years (robust when not bell-shaped).
- Rain: **SPI** (WMO standard). Fit a gamma distribution to past totals over 30, 60, 90 days, convert this year's total to a z-score (handle zero-rain probability).
- Soil moisture: percentile rank vs SMAP history.

## 4. What kind of stress: `stress.py` (rule-based, not a black box)
| Peril | Rule |
|---|---|
| Drought | SPI-60 < −1 and soil moisture < 20th pct; confirmed when NDVI z < −1.5 |
| Excess water | SPI-30 > +1.5 and soil > 90th pct; confirmed by radar water detection |
| Frost | Night minimum < −2 °C during a stage with weight ≥ 0.7 |
| Heat | ≥ 3 days above 35 °C during flowering |
- Cascade: early (rain only) → active (+ soil) → confirmed (+ greenness).
- Stress score 1–99 (never exactly 0 or 100): peril intensities combined as independent damage shares (1 − Π(1 − weight × intensity)) × stage weight, accumulated over the season with exponential decay (past damage counts but fades) and a soft ceiling above 75 so the worst loans stay rankable. Heat during an active/confirmed drought is the hot-dry form of that drought: heat × 1.3 and the main peril stays drought. Each published peril value is the larger of its triggered intensity and a 1–34 "pressure" (current conditions, percentile against the field's own past seasons in the same weeks, and how often the rule fired before harvest in those seasons); only a triggered peril (≥ 35) can be the main one. Display only: the score uses the triggered intensities.
- Confidence: signal agreement (how many indicators agree) combined with location quality and share of cloud-free images.

## 5. Which past year does this look like: `analogs.py`
- Nearest neighbour: Euclidean distance between this season's anomaly series to date and every past season over the same weeks. Closest 1–3 years = analogs; report their yields.

## 6. Stress → yield loss: `yield_impact.py`
- Regression of historical yield anomalies (department yields) on season stress indicators. Linear, or **quantile regression** for a p10–p90 range.
- Fit per region and crop. Validation: **leave-one-year-out**. Optional upgrade: gradient boosting with the same validation.

## 7. Credit risk and IFRS 9: `ifrs9.py`
| Piece | Method |
|---|---|
| PD | logit(PD_new) = logit(PD_base) + β × yield loss |
| Staging | Stage 2 if a critical alert or PD > ~2× its level at origination; Stage 3 if in default by BCRA debtor classification (situación ≥ 3, or > 90 days past due) |
| LGD | base × (1 − insurance cover share), with collateral adjustments |
| EAD | from the amortization schedule (outstanding balance at each future date) |
| ECL | Σ_t PD_t × LGD × EAD_t × discount factor_t, over 12 months (Stage 1) or lifetime (Stage 2/3; Stage 3 PD ≈ 100%) |
| Scenarios | probability-weighted ECL across base / adverse / severe (e.g. 60/25/15), scenarios from the historical replay |

IFRS 9 sets principles (section 5.5); the formulas are industry practice. Argentina: BCRA Com. "A" 6847 (IFRS 9 5.5 impairment from 1 Jan 2020), BCRA debtor classification situación 1–6 for default/Stage 3.
Base PD for agriculture from BCRA sector non-performing loan statistics. Caution: without the bank's repayment history the PD adjustments are assumptions — "IFRS 9-aligned, calibrated with the lender's own data", not audit-ready.

## 8. Portfolio risk
- Concentration by province, crop, stress level. Clusters of stressed loans with **DBSCAN** (haversine).
- Stress test: historical simulation — run today's portfolio through each past season; loss distribution; 95th percentile = 1-in-20-year loss.

## 9. Alerts and explanations
- Threshold rules with **hysteresis** (higher bar to escalate than to calm down).
- Explanations: an LLM with templates; Python passes only computed numbers, the model only words them. Template fallback.
- Recommendations: rule-based lookup table (situation → action).
