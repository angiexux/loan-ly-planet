# Loan-ly Planet: data contract (shared by the backend, the Excel samples and the web app)

Season of the demo: 2025/26 (the app operates "today" = 18 Jan 2026; history ends with 2024/25). Time step: **week** (52 weeks starting Sun 1 Jun 2025: `week[i] = 2025-06-01 + 7·i days`).
History: seasons 2001/02 … 2021/22 (21 seasons). Everything synthetic is labelled synthetic.

---------------------------------------------------------------------------------------------------
## A. Input: the loan book workbook (`.xlsx`, also accepted as one flat `.csv` of the Loans sheet with lat/lng/crop columns)

Sheet and column names are exact (snake_case). Dates are ISO `YYYY-MM-DD`. Money in USD. Only **bold** columns are required;
everything else improves the answer and is filled with documented defaults when missing.

### Sheet `Farmers`
| column | type | notes |
|---|---|---|
| **farmer_id** | text | e.g. `F001` |
| name | text | fictional |
| tax_id | text | fictional CUIT-like `20-12345678-9` |
| country | text | Argentina / Uruguay / Brazil / Paraguay |
| province | text | |
| department | text | |
| farm_ha | number | total farm size |
| years_as_client | int | |
| other_bank_debt_usd | number | debt with other banks (BCRA Central de Deudores) |
| notes | text | |

### Sheet `Fields`
| column | type | notes |
|---|---|---|
| **field_id** | text | e.g. `P001` |
| **farmer_id** | text | |
| **lat**, **lng** | number | field centroid (WGS84) |
| polygon_wkt | text | optional `POLYGON((lng lat, …))` |
| area_ha | number | |
| crop | text | `soy` / `maize` / `wheat` / `sunflower` |
| sowing_date | date | optional; if blank the backend detects it from NDVI (phenology) |
| irrigated | yes/no | |

### Sheet `Loans`
| column | type | notes |
|---|---|---|
| **loan_id** | text | e.g. `L001` |
| **farmer_id** | text | |
| **field_id** | text | the field financed (one field per loan in v1) |
| product | text | e.g. "Crop input loan", "Pre-harvest loan" |
| amount_usd | number | principal disbursed |
| origination_date, maturity_date | date | |
| rate_pct | number | annual nominal |
| amortization | text | `bullet` / `installments` (then see `Repayments`) |
| rating_origination | int 1–8 | bank internal rating at origination (1 best) |
| pd_12m_origination | number 0–1 | bank's 12-month PD at origination; default from rating table |
| lgd_bank | number 0–1 | bank's LGD; default from collateral table |
| collateral_type | text | `land mortgage` / `crop pledge` / `warrant on grain` / `machinery pledge` / `unsecured` |
| collateral_value_usd | number | |
| bcra_situacion | int 1–6 | current BCRA debtor classification (1 normal … 6 irrecoverable by technical disposition) |
| days_past_due | int | current |

### Sheet `Repayments` (schedule and history)
| column | type | notes |
|---|---|---|
| **loan_id** | text | |
| **due_date** | date | |
| principal_usd, interest_usd | number | scheduled |
| paid_date | date | blank if not yet paid |
| paid_usd | number | blank if not yet paid |

### Sheet `Insurance`
| column | type | notes |
|---|---|---|
| **policy_id** | text | |
| **field_id** | text | |
| insurer | text | fictional |
| type | text | `indemnity` / `parametric` / `multi-peril` |
| perils | text | comma list of `drought, excess_water, frost, heat, hail` |
| sum_insured_usd | number | |
| cover_share | number 0–1 | share of loss covered |
| trigger | text | parametric trigger in words, e.g. `SPI-60 < -1.5 between flowering and grain fill` |
| start_date, end_date | date | |

### Sheet `CreditHistory` (monthly, optional)
| column | type | notes |
|---|---|---|
| **farmer_id** | text | |
| **month** | `YYYY-MM` | |
| bcra_situacion | int 1–6 | worst classification across the system that month |
| total_system_debt_usd | number | |
| max_days_past_due | int | |

Sample-only sheets (`README`, `CreditStory`) are ignored by the loader.

---------------------------------------------------------------------------------------------------
## B. Output: `web/public/data/analysis.json` (written by `backend/pipeline.py`, served at `GET /api/analysis`)

All per-week arrays have length `W = 52`, index = week. Numbers rounded (3 decimals, money to whole dollars). `null` = not available.

```jsonc
{
  "meta": {
    "lender": "Banco Demo (fictional)", "season": "2025/26", "synthetic": true, "generatedAt": "ISO datetime",
    "weeks": ["2022-06-01", …],            // W week-start dates
    "asOfDefault": 33,                     // index of the week shown first (18 Jan 2026 = today; the front end has no date control)
    "histYears": [2001, …, 2021],          // season start years of the history
    "crops": { "soy": {"label":"Soybean","color":"#…","price":520,"stages":[{"name":"Emergence","weight":0.3},…]}, … },
    "regions": [{"id":"AR-SF","name":"Santa Fe · Centro","country":"Argentina","lat":…,"lng":…}, …],
    "scenarios": {"base":0.6,"adverse":0.25,"severe":0.15},
    "params": { "beta": …, "sicrMultiplier": 2.0, "discountRate": …, "hysteresis": {"up":[25,45,70],"down":[20,38,62]} },
    "methods": { "<module>": "one-line description" }   // shown on the Methodology page
  },
  "loans": [{
    // static (from the workbook)
    "id","farmerId","borrower","fieldId","country","region","regionId","lat","lng","ring":[[lng,lat],…]|null,
    "crop","areaHa","farmHa","irrigated","product","amountUsd","originated","maturity","ratePct",
    "schedule":[{"date","principal","interest","paidDate","paidUsd"}],
    "ratingOrig","pdOrig","lgdBank","collateral","collateralValue","bcraSituacion","daysPastDue",
    "insurance": {"type","perils":[…],"coverShare","sumInsured","trigger"} | null,
    "otherBankDebt", "uploaded": false,
    "sowing": {"date","week","source":"given"|"phenology"},
    "stage":  [W strings],  "stageWeight": [W numbers 0..1],

    // signals (module 1 + 3)
    "ndviObs": [W numbers|null],          // weekly median of cloud-free images (null = no clear image)
    "ndvi":    [W],                       // gap-filled + Savitzky–Golay smoothed
    "cloudFree": [W 0..1],                // share of cloud-free images that week
    "clim": {"mean":[W],"sd":[W],"p10":[W],"p90":[W]},
    "ndviZ":[W], "ndviPct":[W],
    "spi30":[W], "spi60":[W], "spi90":[W],
    "smPct":[W], "tmin":[W] (weekly minimum °C), "hotDays":[W] (days > 35 °C that week), "water":[W] (flooded share, radar),
    "rainWeek":[W] mm, "rainNormal":[W] mm,

    // stress (module 4)
    "score":[W 0..100], "level":[W "Normal"|"Watch"|"High"|"Severe"],   // level uses hysteresis
    "perils": {"drought":[W],"excess_water":[W],"frost":[W],"heat":[W],"hail":[W]},
    "cascade": [W "none"|"early"|"active"|"confirmed"],   // drought indicator chain
    "confidence": [W 0..1],
    "reasons": [W [{"code":"ndvi_z","value":-2.3}, …]],   // computed facts only; wording is done by templates/LLM

    // analogs + yield (modules 5, 6)
    "analogs": [W [{"year":2008,"distance":0.7,"yieldAnom":-0.42}, …up to 3]],
    "yield": {"p10":[W],"p50":[W],"p90":[W]},              // expected yield anomaly (fraction, e.g. -0.35)
    "expectedYieldTHa": number, "yieldHistory": {"years":[…],"tHa":[…]},

    // credit (module 7), per week
    "credit": {
      "pd12":[W], "pdLife":[W], "stage":[W 1|2|3], "stageReason":[W text code],
      "lgd":[W], "ead":[W], "eclBank":[W],                       // bank baseline: PD/LGD at origination, Stage 1
      "ecl": {"base":[W],"adverse":[W],"severe":[W],"weighted":[W]}
    },
    "outcome": {"yieldAnom":…, "defaulted":bool}   // synthetic, back-test only
  }],

  "portfolio": {                               // per week (module 8)
    "exposure":[W], "ead":[W], "stressedEad":[W], "byLevel":{"Normal":[W],"Watch":[W],"High":[W],"Severe":[W]},
    "eclBank":[W], "ecl":{"base":[W],"adverse":[W],"severe":[W],"weighted":[W]}, "stage2":[W], "stage3":[W],
    "clusters":[W [{"id":0,"loanIds":[…],"lat","lng","radiusKm","ead","meanScore"}]],
    "concentration": {"byRegion":[{"id","ead","stressedEad"}], "byCrop":[…]}   // at asOfDefault
  },
  "stressTest": { "years":[2001,…], "loss":[…], "p50", "p95", "p99", "worstYear" },   // historical simulation of today's book
  "alerts": [{"week","loanId","from","to","kind":"new"|"worse"|"better","score","explanation","recommendation":{"action","why"}}],
  "validation": {
    "yieldModel": [{"regionId","crop","n","r2Loyo","maeLoyo","method"}],
    "backtest": [{"week","flagged","flaggedDefaultRate","otherDefaultRate","auc"}]
  }
}
```

Stage names per crop come from `meta.crops[crop].stages`. Peril keys: `drought, excess_water, frost, heat, hail`.
Reason codes (extendable): `ndvi_z, ndvi_pct, spi30, spi60, spi90, sm_pct, frost_min, hot_days, water_frac, hail_drop, stage, harvested, not_sown, irrigated, low_confidence`.

---------------------------------------------------------------------------------------------------
## C. Ask in plain language, PDF reports, upload (backend `backend/server.py`, port 8770, proxied by Vite at `/api`)

Inspired by Faraday's "Tell us your thesis" page (reference/faraday_src/thesis.tsx `parsePlain`, `ThesisStart`): the analyst types
what they want, the platform shows **what it understood** (so they can check it), then runs it.

### `POST /api/ask`  body `{ "text": "...", "week": 33 | null, "book": "<bookId>" | null }`
Parsing is rule-based by default (regex/keyword, deterministic, no key needed), in `backend/loanly/ask.py`. If env `ANTHROPIC_API_KEY`
is set and `LOANLY_LLM=1`, the text may first be mapped to the same `query` JSON by Claude (model `claude-sonnet-5-5`, JSON only, validated
against the schema; on any failure fall back to the rules). The LLM never computes numbers.
Response:
```jsonc
{
  "understood": ["Crop: soybean", "Region: Santa Fe · Centro", "Stress: High or Severe", "No insurance for the main peril", "As of: 18 Jan 2026"],
  "query": {
    "intent": "list" | "provision" | "stress_test" | "loan" | "compare_regions" | "alerts" | "what_if" | "report",
    "filters": { "crop": [..], "regionId": [..], "country": [..], "level": [..], "peril": [..], "stage": [1|2|3],
                 "insured": true|false|null, "coverageGap": true|false|null, "minScore": n, "maxScore": n, "minEad": n, "loanIds": [..], "farmerIds": [..] },
    "week": 33, "sort": {"by": "score"|"ead"|"eclDelta"|"pd", "desc": true}, "limit": 50,
    "whatIf": { "beta": n, "scenarioWeights": {"base":..,"adverse":..,"severe":..}, "yieldShock": -0.1 } | null,
    "report": "portfolio" | "early_warning" | "loan_memo" | null
  },
  "answer": {
    "headline": "23 soybean loans in Santa Fe are High or Severe; $1.4M outstanding, 17 without drought cover.",
    "kpis": [{"label":"Loans","value":"23"}, {"label":"Outstanding","value":"$1.4M"}, …],
    "loanIds": ["AR-SF-003", …],              // rows to show (front end looks them up in analysis.json)
    "table": {"columns":[…],"rows":[[…]]} | null,   // for aggregate intents (by region, stress test, what-if)
    "notes": ["…"],                            // caveats, e.g. "PD adjustments are assumptions until calibrated"
    "suggestions": ["Show their provisions", "Generate the early-warning PDF for these loans"]
  },
  "parser": "rules" | "llm"
}
```
Examples the parser must handle: "Which soy loans in Santa Fe are under severe drought and have no insurance?", "How much does climate add
to provisions this quarter?", "What is our 1-in-20-year loss?", "Show loans that moved to Stage 2 this month", "Compare regions by stressed
exposure", "What if drought gets 20% worse?" (yieldShock / severe weight up), "Explain loan AR-CS-004", "Alerts in the last two weeks for maize",
"Make the early warning report for Entre Ríos", "Loans over $100k with PD above 10%", Spanish keywords too (soja, maíz, trigo, girasol, sequía, helada, granizo, inundación, sin seguro).

### PDF reports (matplotlib `PdfPages`, A4, Loan-ly Planet logo `web/public/brand/logo.png`, fern accent #5dbb63, "Synthetic demo data" footer)
`GET /api/pdf/<kind>?week=<i>&book=<id>&loan=<loanId>&ids=<comma list>` → `application/pdf` (attachment). Kinds:
- `portfolio` — IFRS 9 provision report: KPIs, ECL bank vs climate by scenario and stage, exposure by level over the season, concentration, clusters, stress-test distribution with p95, methods and caveats.
- `early_warning` — alerts and ranked stressed loans (optionally filtered by `ids`), each with reason and recommended action.
- `loan_memo` — one loan: borrower, terms, NDVI vs history chart, rain/SPI, stress perils + cascade + confidence, analog years, yield p10–p90, PD/stage/LGD/EAD/ECL by scenario, recommendation.
- Action documents (one loan): `claim` (insurance claim notice with trigger evidence and payout routed to the loan), `restructure` (restructuring proposal with new schedule), `downgrade` (Stage 2 transfer memo with SICR evidence), `transfer` (loan sale/transfer memo), `cover_offer` (parametric cover offer for next season), `contact` (borrower call brief).
`GET /api/pdf` (no kind) → `{ "kinds": [{"kind","title","needsLoan"}] }`.

### Upload
`POST /api/upload` (as in the backend) accepts the CONTRACT §A workbook or a flat CSV; returns `{ok, bookId, errors[], loans, analysisUrl}`.
The Ask page has an upload area; after upload the whole app switches to that book (`?book=<id>`), with a "Back to demo portfolio" control.
