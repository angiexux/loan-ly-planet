# Loan-ly Planet backend

Climate-risk monitor for agricultural loans (MIT Energy & Climate Hack 2026, Suyana track). Python 3, stdlib + numpy / pandas /
scipy / scikit-learn / statsmodels / openpyxl. Methods: `docs/METHODS.md`. Data contract: `docs/CONTRACT.md`.

## Run

```bash
python3 backend/pipeline.py                       # demo book -> web/public/data/analysis.json (+ example report + parameters workbook), ~10 s
python3 backend/pipeline.py --book my_book.xlsx --out backend/cache/my.json   # any CONTRACT section A workbook or flat CSV
python3 backend/server.py                         # API on http://127.0.0.1:8770 (the Vite dev server proxies /api to it)
python3 -m unittest discover backend/tests        # unit tests
web/run.sh                                        # builds analysis.json if missing, starts the API in the background, then vite
```

API: `GET /api/health`, `GET /api/analysis[?book=id]`, `POST /api/upload?name=book.xlsx` (raw body or multipart; returns
`{ok, errors[], warnings[], bookId, analysisUrl}`), `GET /api/report.xlsx?week=33&book=id`, `GET /api/parameters.xlsx`,
`GET /api/explain?loan=L001&week=33[&book=id]` (template explanation + recommendation for any loan and week).

PDF reports and plain-language ask (matplotlib `PdfPages`, A4; `loanly/pdf_reports.py`, `loanly/ask.py`):

* `GET /api/pdf` -> `{kinds: [{kind, title, needsLoan}]}`.
* `GET /api/pdf/<kind>?week=33&book=id&loan=L047&ids=L001,L002[&product=multi_peril]` -> `application/pdf` attachment
  `loanly_<kind>_<loan|portfolio>_<date>.pdf`. Kinds: `portfolio`, `early_warning` (optionally `ids`), `loan_memo`, and the loan documents
  `claim` (needs an insurance policy), `restructure`, `downgrade` (Stage 2 transfer memo), `transfer`, `cover_offer`, `contact`,
  `insurance_application` (prefilled application, parametric by default). 400 `{error}` on an unknown kind, loan or week.
* `POST /api/ask` body `{text, week, book}` -> `{understood, query, answer, parser}` (CONTRACT section C). Rule-based English + Spanish, same
  intents and filters as `web/src/ask.ts` plus Stage 3; with `ANTHROPIC_API_KEY` and `LOANLY_LLM=1` Claude only maps the text to the query
  JSON (validated, falls back to the rules); all numbers are computed in Python. `answer.pdf` holds the report URL for report questions.
* `/api/health` has `llm: true|false`. Analyses are cached in memory per book.
* Limits: the cover offer / insurance application price from the field's yield history (past SPI series are not stored in the analysis;
  a season counts as triggered when yield is 15%+ below trend; the current season (2025/26) uses the measured SPI-60). What-if recomputes ECL with changed beta
  and a yield shock (stress scores and LGD are not re-simulated). The stress-test answer is for the whole book.

## Module map (`backend/loanly/`)

| module | METHODS | what it does |
|---|---|---|
| `config.py` | all | every parameter (stage tables, peril thresholds, score weights, hysteresis, beta, SICR, scenarios, PD/LGD tables, prices); `export_parameters_xlsx()` / `load_overrides()` |
| `synthetic.py` | - | SYNTHETIC raw sources (CHIRPS/ERA5-Land/SMAP/Sentinel-1/Sentinel-2-like) for 22 seasons, toy crop model, department yield history, simulated outcomes, the 240-loan demo workbook |
| `loader.py` | - | reads/validates the loan-book workbook or flat CSV, row/column errors, documented defaults |
| `fetch_earth_engine.py` | 1 | real Earth Engine extraction code (not executed here) + the cleaning that runs: cloud mask, weekly median, interpolation, Savitzky-Golay |
| `crop_calendar.py` | 2 | stage and stage weight per week; phenology detection of sowing when blank |
| `anomalies.py` | 3 | per-field climatology, z, percentile, SPI-30/60/90 (mixed gamma), soil-moisture percentile |
| `stress.py` | 4 | perils, drought cascade, hot-dry heat x drought compound, 1-99 score with decay and soft ceiling, hysteresis levels, confidence, reasons |
| `analogs.py` | 5 | 3 closest history seasons and their yield anomalies |
| `yield_impact.py` | 6 | OLS p50 + QuantReg p10/p90 per region x crop, leave-one-year-out, weekly prediction from indicators to date |
| `ifrs9.py` | 7 | PD logit shift, Stage 1/2/3, LGD (collateral, insurance), EAD schedule, monthly ECL, 3 scenarios, bank baseline |
| `portfolio.py` | 8 | weekly totals, DBSCAN clusters, concentration, historical-simulation stress test, back-test |
| `alerts.py` | 9 | level-transition alerts, template explanations (optional LLM wording), recommendation table |
| `report.py` | - | IFRS 9 provision report workbook |
| `pdf_reports.py` | - | PDF reports and action documents (portfolio, early warning, loan memo, claim, restructure, downgrade, transfer, cover offer, contact, insurance application) |
| `ask.py` | - | plain-language question to query JSON to answer (rules, optional LLM parser) |

## What is synthetic, what is real

* **Synthetic**: all satellite and weather series (generated to look like what Earth Engine returns, with clouds, gaps and
  contaminated pixels), the department yield history, the simulated outcomes (yield, default) used for the back-test, the
  borrowers and loan book. A 2025/26 drought scenario (we operate in 2026, as of 18 Jan 2026) is replayed on top of history seasons 2004/05-2024/25.
* **Real code on that data**: cleaning, climatology, SPI, stress rules, phenology, analogs, regressions, IFRS 9 maths, DBSCAN, report.
* **Stubbed**: `fetch_from_ee()` is written against the real GEE API but is not run (no `earthengine-api` here). Optional LLM wording
  runs only with `ANTHROPIC_API_KEY` + `LOANLY_LLM=1`; otherwise templates are used. Loans in an uploaded book get synthetic signals
  generated deterministically from their lat/lng (`syntheticSignals: true` on each loan).
* Everything is weekly (52 weeks from 1 Jun 2022); seasons are aligned to 364 days (leap day ignored).

## Caution

PD adjustments (beta, SICR multiplier, scenario weights), the PD-by-rating and LGD-by-collateral tables and the yield-to-PD link are
**assumptions**. The framework is IFRS 9-aligned (staging, SICR, forward-looking scenarios, lifetime ECL, BCRA situacion), but it is
**not audit-ready**: calibrate PD/LGD and the climate sensitivity on the lender's own repayment history before accounting use.
Edit `samples/ifrs9_parameters.xlsx` and re-run the pipeline: it is read back if present.

## Interpretations worth knowing (for the front end and for reviewers)

* `portfolio.byLevel` is EAD (USD) per stress level; `portfolio.byLevelCount` (extra) is the number of loans in the book.
* `portfolio.stage1/stage2/stage3` count loans in the book (originated and not yet repaid, or delinquent).
* Bank baseline ECL = PD and LGD at origination, Stage 1, except loans the bank already classifies as delinquent (Stage 2/3 from
  BCRA situacion / days past due): they are Stage 2/3 in both columns so the difference isolates the climate effect.
* After harvest the stress score is frozen (realised yield loss still weighs on repayment until maturity); during the season it decays
  with a 4-week half-life.
* `expectedYieldTHa` is the field's normal-season (trend) yield; the expected 2025/26 yield is `expectedYieldTHa * (1 + yield.p50[w])`.
* Extra fields beyond CONTRACT B (nothing renamed or dropped): `loans[].syntheticSignals`, `explanationAsOf`, `recommendationAsOf`,
  `credit.insuranceMet`, `meta.snapshotDate/book/warnings/note`, `meta.crops[].criticalWindow`, `portfolio.byLevelCount/stage1`,
  `stressTest.currentLoss/note`, `validation.yieldModel[].nFields`. `meta.crops[].stages` also lists "Pre-sowing" and "Harvested".

## Real public data snapshot (one day, with source lines)

`backend/loanly/fetch_public.py` fetches REAL public data for a single date (default 2026-01-18, the demo as-of date) per loan and
writes `web/public/data/real_snapshot.json`. It does not touch the synthetic analysis. Every value carries `source`
(name, product, resolution, exact request URL, fetched_at, note) and a ready-to-print `sourceLine`.

```bash
python3 backend/loanly/fetch_public.py                                   # sample book + demo book, date 2026-01-18
python3 backend/loanly/fetch_public.py --date 2026-01-18 --book samples/sample_farmers_10.xlsx --out backend/cache/snap.json
python3 backend/loanly/fetch_public.py --max-loans 60                    # first 60 loans of the demo book
```

| item | source | fallback |
|---|---|---|
| rain | CHIRPS v2.0 daily-improved 0.05 deg via IRI Data Library (one point request per cell) | ERA5-Land / Open-Meteo precipitation |
| tmin, tmax | ERA5-Land via Open-Meteo archive API (0.1 deg) | none |
| soil | SMAP SPL3SMP_E v006 (only if `~/.netrc` has `urs.earthdata.nasa.gov`) | ERA5-Land soil_moisture_0_to_7cm daily mean, labelled |
| ndvi_s2 | Sentinel-2 L2A, Planetary Computer STAC + titiler point; nearest pass within +-5 days with SCL 4/5/6/7 (next nearest if cloudy at the field); NDVI = (B08-B04)/(B08+B04) after the -1000 DN offset (processing baseline >= 04.00) | value null + reason |
| ndvi_modis | MOD13Q1 v061 16-day composite covering the date (ORNL DAAC), pixel reliability 0/1 kept | value null + reason |
| water | Sentinel-1 RTC (Planetary Computer), nearest pass within +-6 days, water if VV < -18 dB | value null: "no Sentinel-1 pass within +-6 days" |

Politeness: all responses are cached under `data/cache/<source>/` (delete a file to refetch), User-Agent
`loanly-planet-hackathon/0.1`, retry with backoff, at most 4 concurrent requests, fields in the same grid cell share requests.
Point values are taken at the field centroid (lat/lng), not averaged over the polygon.

SMAP needs a free NASA Earthdata account (never entered or stored by this code): register at https://urs.earthdata.nasa.gov, approve
the "NASA GESDISC DATA ARCHIVE" / NSIDC applications, then create `~/.netrc` (chmod 600) with
`machine urs.earthdata.nasa.gov login <user> password <password>`. The code detects it and uses SMAP; otherwise it falls back and says so.

Tests (offline, recorded fixtures in `backend/tests/fixtures/`): `python3 -m unittest backend.tests.test_fetch`.
