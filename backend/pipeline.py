"""Loan-ly Planet pipeline: loan book -> analysis.json (docs/CONTRACT.md section B).

    python3 backend/pipeline.py [--book path.xlsx] [--out web/public/data/analysis.json] [--report samples/ifrs9_provision_report_example.xlsx]

Runs modules 1 -> 9 (see backend/README.md). Signals are SYNTHETIC (backend/loanly/synthetic.py imitates Earth Engine output) but go
through the real cleaning, anomaly, stress, yield-regression and IFRS 9 code.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from loanly import alerts as alerts_mod
from loanly import analogs, anomalies, config as C, crop_calendar, fetch_earth_engine, fhi as fhi_mod, ifrs9, loader, portfolio, stress, synthetic, yield_impact

ROOT = C.ROOT
W, H, CUR = C.W, C.N_HIST, C.CUR

METHODS = {
    "fetch_earth_engine": "Sentinel-2 NDVI masked with the satellite's own cloud flags, zonal mean per field, weekly median of clear images, linear gap filling, Savitzky-Golay smoothing; CHIRPS rain, ERA5-Land temperature, SMAP soil moisture, Sentinel-1 water.",
    "crop_calendar": "Stage from days since sowing with crop-specific stage lengths; if sowing is unknown, phenology: green-up at 20% of the seasonal NDVI range, back-dated by the typical emergence time. Each stage has a weight (flowering = 1.0).",
    "anomalies": "Per-field weekly climatology over 21 seasons (mean, sd, p10, p90); z-score and percentile rank; SPI-30/60/90 from a gamma fit with a zero-rain probability; soil moisture percentile.",
    "stress": "Rule-based perils (drought cascade, excess water, frost, heat, hail); heat during an active drought is the hot-dry form of that drought (heat x 1.3, attributed to drought); perils combine as independent damage shares (1 - product of (1 - weight x intensity)), so they never add past the scale; intensity x stage weight accumulated with exponential decay (half-life 4 weeks) into a 1-99 score (soft ceiling above 75, never exactly 0 or 100); levels are fixed score bands (Normal 1-24, Watch 25-44, High 45-69, Severe 70-99); confidence = indicator agreement x location quality x cloud-free share.",
    "analogs": "Euclidean distance between this season's anomaly series to date (NDVI z, SPI-60, soil percentile) and each history season over the same weeks; the 3 closest seasons and their yield anomalies.",
    "yield_impact": "Per region x crop: OLS (p50) and quantile regression (p10, p90) of department yield anomaly on season stress indicators; leave-one-year-out validation; weekly prediction from indicators available to date, wider before sowing.",
    "ifrs9": "logit(PD) = logit(PD_orig) + beta x yield loss; Stage 2 on a critical alert or PD >= 2x origination, Stage 3 on BCRA situacion >= 3 or > 90 days past due; LGD x (1 - insurance cover share) with collateral adjustment; EAD from the amortization schedule; ECL = sum of marginal PD x LGD x EAD x DF monthly (12 months for Stage 1, lifetime for Stage 2/3; Stage 2 on short crop loans adds one year of assumed restructuring term); scenarios base/adverse/severe 60/25/15.",
    "portfolio": "Weekly totals by level and stage; DBSCAN (haversine, 60 km, min 3) clusters of High/Severe loans; concentration by region and crop; historical-simulation stress test of today's book through the 21 history seasons (p95 = 1-in-20-year loss).",
    "fhi": "Crop Health Index (CHI v1, Sviana technical note): per field and 8-day calendar slot, percentiles against this field's own past record in slots j-1..j+1 of the other years for vegetation V (MODIS NDVI), soil S (SMAP soil moisture, two-sided: above the 85th percentile it falls linearly to 0 at the 100th, for waterlogging) and water adequacy W (min(1, ET/PET)); CHI = mean of the available components (>= 2; partial with 2) while the crop is in the ground (field sowing to harvest, else Oct-Apr summer / Jun-Dec winter crops). Bands: >= 60 above normal, 40-60 normal, 25-40 stressed, 10-25 severely stressed, < 10 extreme. Season summary with the critical-period mean; standardized factor f_CHI = (CHI - mu_slot) / sigma_slot is published. Shown for context; it does not change PD, staging, ECL or alerts.",
    "alerts": "Alerts from level changes between fixed score bands (Watch 25, High 45, Severe 70); template explanations from computed numbers; rule-table recommendations.",
}


def _lst(a, d=3):
    a = np.asarray(a, float)
    return [None if not np.isfinite(x) else round(float(x), d) for x in a]


def _ints(a):
    return [int(round(float(x))) for x in a]


def _money(a):
    return [int(round(float(x))) for x in a]


def _fhi_mean(loans_out, ead, active):
    """Exposure-weighted (EAD) mean FHI per week over active loans that have an FHI that week (null if none). Display only."""
    out = []
    for w in range(W):
        num = den = 0.0
        for f, o in enumerate(loans_out):
            v = o["fhi"][w]
            if v is not None and active[f, w]:
                num += v * ead[f, w]; den += ead[f, w]
        out.append(round(num / den, 1) if den > 0 else None)
    return out


def export_fhi(loan_id, path, book_path=None):
    """Write one loan's FHI inputs in the exact CSV format of fhi_calc.py (date,ndvi_modis,ndvi_s2,sm,et,pet; -9999 = missing)."""
    book_path = Path(book_path or ROOT / "data" / "demo_loan_book.xlsx")
    res = loader.load_book(book_path, None)
    if res.book is None:
        raise ValueError("\n".join(res.errors))
    loans = res.book.loans
    ids = [l["id"] for l in loans]
    if loan_id not in ids:
        raise SystemExit(f"unknown loan {loan_id}")
    specs = []
    for l in loans:
        sw = (int(np.clip(crop_calendar.sowing_week(l["_sowing"]), 0, W - C.CROP_DURATION[l["crop"]] - 1)) if l["_sowing"]
              else synthetic.typical_sow_week(l["crop"], l["lat"], l["lng"]))
        specs.append(dict(field_id=l["fieldId"], lat=l["lat"], lng=l["lng"], crop=l["crop"], sow_week=sw, irrigated=l["irrigated"]))
    src = synthetic.generate_sources(specs)      # whole book: the generator's shared draws depend on the batch shape
    wk = fetch_earth_engine.aggregate_weekly(src)
    et_w, pet_w = synthetic.et_pet_weekly(src, wk)
    f = ids.index(loan_id)
    fhi_mod.write_script_csv(fhi_mod.series_frame(wk["ndvi"][f], wk["ndvi_obs"][f], wk["soil"][f], et_w[f], pet_w[f]), path)
    print(f"wrote {path}  (crop {loans[f]['crop']}, season {C.fhi_season(loans[f]['crop'])})")


def run(book_path=None, out_path=None, report_path=None, uploaded=False, log=print, snapshot=None) -> dict:
    t0 = time.time()
    marks = {}

    def tick(name):
        marks[name] = round(time.time() - t0, 1)
        log(f"  [{marks[name]:6.1f}s] {name}")

    out_path = Path(out_path or ROOT / "web" / "public" / "data" / "analysis.json")
    book_path = Path(book_path or ROOT / "data" / "demo_loan_book.xlsx")
    params_path = ROOT / "samples" / "ifrs9_parameters.xlsx"
    if book_path.name == "demo_loan_book.xlsx" and not book_path.exists():
        log("generating demo loan book ...")
        synthetic.build_demo_book(book_path)
    if params_path.exists():
        C.load_overrides(params_path)
    res = loader.load_book(book_path, snapshot)
    if res.book is None:
        raise ValueError("\n".join(res.errors))
    loans = res.book.loans
    snap = res.book.snapshot
    N = len(loans)
    for l in loans:
        l["uploaded"] = bool(uploaded)
    tick(f"loaded {N} loans from {book_path.name}")

    # ------------------------------------------------------------------ module 1: sources + cleaning
    specs = []
    for l in loans:
        if l["_sowing"]:
            sw = int(np.clip(crop_calendar.sowing_week(l["_sowing"]), 0, W - C.CROP_DURATION[l["crop"]] - 1))
        else:
            sw = synthetic.typical_sow_week(l["crop"], l["lat"], l["lng"])
        specs.append(dict(field_id=l["fieldId"], lat=l["lat"], lng=l["lng"], crop=l["crop"], sow_week=sw, irrigated=l["irrigated"]))
    src = synthetic.generate_sources(specs)
    tick("synthetic raw sources generated (22 seasons x fields)")
    wk = fetch_earth_engine.aggregate_weekly(src)
    tick("module 1  cleaning: cloud mask, weekly median, interpolation, Savitzky-Golay")
    et_w, pet_w = synthetic.et_pet_weekly(src, wk)       # SYNTHETIC mm/week, FHI display inputs only

    # ------------------------------------------------------------------ module 3: anomalies
    sig = anomalies.compute(wk, src.rain)
    tick("module 3  anomalies: climatology, z, percentile, SPI-30/60/90")

    # ------------------------------------------------------------------ module 2: crop calendar
    crops = [l["crop"] for l in loans]
    sow_cal = np.zeros(N, int); sow_src = []
    stage_names, stage_w = [], np.zeros((N, W))
    for f, l in enumerate(loans):
        if l["_sowing"]:
            sw, s_src = crop_calendar.sowing_week(l["_sowing"]), "given"
        else:
            d = crop_calendar.detect_sowing(wk["ndvi"][f, CUR], l["crop"])
            sw, s_src = (d, "phenology") if d is not None else (synthetic.typical_sow_week(l["crop"], l["lat"], l["lng"]), "phenology")
        sw = int(np.clip(sw, -8, W - 2))
        sow_cal[f] = sw; sow_src.append(s_src)
        nm, wt = crop_calendar.stage_series(l["crop"], sw)
        stage_names.append(nm); stage_w[f] = wt
    tick("module 2  crop calendar and phenology")

    # ------------------------------------------------------------------ module 4: stress
    cur = lambda a: a[:, CUR]
    sigc = dict(ndvi=cur(wk["ndvi"]), ndvi_z=cur(sig["ndvi_z"]), ndvi_pct=cur(sig["ndvi_pct"]), clim_mean=sig["clim_mean"], spi30=cur(sig["spi30"]),
                spi60=cur(sig["spi60"]), spi90=cur(sig["spi90"]), sm_pct=cur(sig["sm_pct"]), tmin=cur(wk["tmin"]), hot=cur(wk["hot"]),
                water=cur(wk["water"]), cloud_free=cur(wk["cloud_free"]))
    past = lambda a: a[:, :CUR]          # the field's own past seasons (for the peril pressure percentiles)
    sigc["hist"] = dict(spi30=past(sig["spi30"]), spi60=past(sig["spi60"]), tmin=past(wk["tmin"]), hot=past(wk["hot"]),
                        anom=past(wk["ndvi"]) - sig["clim_mean"][:, None, :], sm_pct=past(sig["sm_pct"]), ndvi_z=past(sig["ndvi_z"]),
                        water=past(wk["water"]))
    irr = np.array([l["irrigated"] for l in loans])
    has_poly = np.array([l["ring"] is not None for l in loans])
    present = np.array([[n not in (C.PRE_SOWING[0], C.HARVESTED[0]) for n in names] for names in stage_names])
    st = stress.run(sigc, stage_w, has_poly, irr, present)
    tick("module 4  stress: perils, cascade, score, level bands, confidence")

    # ------------------------------------------------------------------ modules 6 + 5: yield model, analogs
    dept = synthetic.department_yields(src)
    X = yield_impact.indicators(sig["ndvi_z"], sig["spi60"], wk["hot"], wk["frost_deg"], sow_cal, crops, stage_w)
    yres = yield_impact.fit_and_predict(X, dept, [l["regionId"] for l in loans], crops, sow_cal, irr)
    tick("module 6  yield model: OLS + QuantReg + leave-one-year-out")
    an = analogs.compute(sig["ndvi_z"], sig["spi60"], sig["sm_pct"], yres["dept_anom"])
    tick("module 5  analog seasons")

    # ------------------------------------------------------------------ module 7: credit
    credit = []
    for f, l in enumerate(loans):
        perils_f = {k: v[f] for k, v in st["perils"].items()}
        spi_f = {k: sigc[k][f] for k in ("spi30", "spi60", "spi90")}
        worst = an["yanom"][f].min(0).astype(float)
        worst[:3] = np.nan
        win0 = C.critical_window(l["crop"])[0]
        credit.append(ifrs9.loan_credit(l, snap, st["level"][f], perils_f, spi_f, yres["p10"][f], yres["p50"][f], yres["p90"][f], worst,
                                        C.IRRIGATED_LOSS_FACTOR if l["irrigated"] else 1.0, int(sow_cal[f] + win0)))
    tick("module 7  IFRS 9: PD, staging, LGD, EAD, ECL x 3 scenarios")

    # ------------------------------------------------------------------ module 8: portfolio
    arr = dict(
        ead=np.array([c["ead"] for c in credit]), active=np.array([c["active"] for c in credit]), amount=np.array([[l["amountUsd"]] * W for l in loans]),
        level=st["level"], score=st["score"], stage=np.array([c["stage"] for c in credit]), ecl_bank=np.array([c["eclBank"] for c in credit]),
        ecl={k: np.array([c["ecl"][k] for c in credit]) for k in ("base", "adverse", "severe", "weighted")})
    meta_p = dict(lat=np.array([l["lat"] for l in loans]), lng=np.array([l["lng"] for l in loans]), ids=[l["id"] for l in loans],
                  regions=[l["regionId"] for l in loans], crops=crops, as_of=C.AS_OF_DEFAULT)
    pf = portfolio.weekly(arr, meta_p)
    stt = portfolio.stress_test(loans, credit, yres["hist_p50"], yres["p50"][:, C.AS_OF_DEFAULT], C.AS_OF_DEFAULT)
    tick("module 8  portfolio: totals, DBSCAN clusters, concentration, historical stress test")

    # ------------------------------------------------------------------ outcomes (back-test only) and loans output
    ref_y = [synthetic.field_ref_yield(l["crop"], l["lat"], l["lng"], l["irrigated"]) for l in loans]
    outcomes = [synthetic.simulate_outcome(l, float(src.loss[f, CUR]), ref_y[f]) for f, l in enumerate(loans)]
    orig_week = np.array([max(0, (date.fromisoformat(l["originated"]) - C.SEASON_START).days // 7) for l in loans])
    bt = portfolio.backtest(st["score"], st["level"], np.array([o["defaulted"] for o in outcomes]), arr["active"])

    wd = C.WEEK_DATES
    loans_out = []
    for f, l in enumerate(loans):
        c = credit[f]
        sd = (C.SEASON_START + timedelta(days=7 * int(sow_cal[f]))) if sow_src[f] == "phenology" else l["_sowing"]
        grp = dept[(l["regionId"], l["crop"])]
        scale = ref_y[f] / C.CROPS[l["crop"]]["yield_tha"]
        an_list = []
        for w in range(W):
            if w < 3:
                an_list.append([])
            else:
                an_list.append([dict(year=int(C.HIST_YEARS[an["idx"][f, k, w]]), distance=round(float(an["dist"][f, k, w]), 2),
                                     yieldAnom=round(float(an["yanom"][f, k, w]), 2)) for k in range(3)])
        o = dict(
            id=l["id"], farmerId=l["farmerId"], borrower=l["borrower"], fieldId=l["fieldId"], country=l["country"], region=l["region"], regionId=l["regionId"],
            lat=l["lat"], lng=l["lng"], ring=l["ring"], crop=l["crop"], areaHa=l["areaHa"], farmHa=l["farmHa"], irrigated=l["irrigated"], product=l["product"],
            amountUsd=round(l["amountUsd"]), originated=l["originated"], maturity=l["maturity"], ratePct=l["ratePct"], schedule=l["schedule"],
            ratingOrig=l["ratingOrig"], pdOrig=round(l["pdOrig"], 4), lgdBank=round(l["lgdBank"], 3), collateral=l["collateral"],
            collateralValue=round(l["collateralValue"]), bcraSituacion=l["bcraSituacion"], daysPastDue=l["daysPastDue"], insurance=l["insurance"],
            otherBankDebt=round(l["otherBankDebt"]), uploaded=bool(uploaded), syntheticSignals=True,
            sowing=dict(date=sd.isoformat() if sd else None, week=int(sow_cal[f]), source=sow_src[f]),
            stage=stage_names[f], stageWeight=_lst(stage_w[f], 2),
            ndviObs=_lst(wk["ndvi_obs"][f, CUR], 2), ndvi=_lst(wk["ndvi"][f, CUR], 3), cloudFree=_lst(wk["cloud_free"][f, CUR], 2),
            clim=dict(mean=_lst(sig["clim_mean"][f], 3), sd=_lst(sig["clim_sd"][f], 3), p10=_lst(sig["clim_p10"][f], 3), p90=_lst(sig["clim_p90"][f], 3)),
            ndviZ=_lst(sigc["ndvi_z"][f], 2), ndviPct=_ints(sigc["ndvi_pct"][f]), spi30=_lst(sigc["spi30"][f], 2), spi60=_lst(sigc["spi60"][f], 2),
            spi90=_lst(sigc["spi90"][f], 2), smPct=_ints(sigc["sm_pct"][f]), tmin=_lst(sigc["tmin"][f], 1), hotDays=_ints(sigc["hot"][f]),
            water=_lst(sigc["water"][f], 2), rainWeek=_lst(wk["rain"][f, CUR], 1), rainNormal=_lst(sig["rain_normal"][f], 1),
            score=_lst(st["score"][f], 1), level=[C.LEVELS[i] for i in st["level"][f]],
            perils={k: _ints(v[f]) for k, v in st["perils"].items()}, cascade=[str(x) for x in st["cascade"][f]], confidence=_lst(st["confidence"][f], 2),
            reasons=stress.build_reasons(f, sigc, st, stage_names[f], stage_w[f], l["irrigated"]), analogs=an_list,
            **{"yield": dict(p10=_lst(yres["p10"][f], 3), p50=_lst(yres["p50"][f], 3), p90=_lst(yres["p90"][f], 3))},
            expectedYieldTHa=round(ref_y[f], 2),
            yieldHistory=dict(years=list(C.HIST_YEARS), tHa=[round(float(x) * scale, 2) for x in grp["tha"]]),
            credit=dict(pd12=_lst(c["pd12"], 4), pdLife=_lst(c["pdLife"], 4), stage=[int(x) for x in c["stage"]], stageReason=c["stageReason"],
                        lgd=_lst(c["lgd"], 3), ead=_money(c["ead"]), eclBank=_money(c["eclBank"]),
                        ecl={k: _money(v) for k, v in c["ecl"].items()}, insuranceMet=[int(x) for x in c["insuranceMet"]]),
            outcome=outcomes[f])
        loans_out.append(o)
    tick("loans assembled")

    # ------------------------------------------------------------------ module 9: alerts
    al = alerts_mod.generate(loans_out, arr["active"])
    for o in loans_out:
        o["explanationAsOf"] = alerts_mod.explain(o, C.AS_OF_DEFAULT)
        o["recommendationAsOf"] = alerts_mod.recommend(o, C.AS_OF_DEFAULT)
    # Crop Health Index (CHI): DISPLAY ONLY, computed after (and independent of) PD / staging / ECL / alerts
    for f, o in enumerate(loans_out):
        df_f = fhi_mod.series_frame(wk["ndvi"][f], wk["ndvi_obs"][f], wk["soil"][f], et_w[f], pet_w[f])
        o.update(fhi_mod.loan_outputs(df_f, C.fhi_season(o["crop"]), present_cur=present[f], critical=C.fhi_critical(o["crop"])))
        o["fhiSeason"] = C.fhi_season(o["crop"])
    tick("Crop Health Index CHI (display only)")
    tick(f"module 9  alerts ({len(al)}) and explanations")

    meta = dict(
        lender=C.LENDER, season=C.SEASON_LABEL, synthetic=True, generatedAt=datetime.now().isoformat(timespec="seconds"),
        weeks=[d.isoformat() for d in wd], asOfDefault=C.AS_OF_DEFAULT, histYears=list(C.HIST_YEARS), snapshotDate=snap.isoformat(), book=res.book.source,
        crops={k: dict(label=v["label"], color=v["color"], price=v["price"], criticalWindow=list(C.critical_window(k)),
                       stages=[dict(name=C.PRE_SOWING[0], weight=C.PRE_SOWING[1])] + [dict(name=n, weight=wt) for n, _, wt in v["stages"]] + [dict(name=C.HARVESTED[0], weight=C.HARVESTED[1])])
               for k, v in C.CROPS.items()},
        regions=[dict(id=r["id"], name=r["name"], country=r["country"], lat=r["lat"], lng=r["lng"]) for r in C.REGIONS],
        scenarios=dict(C.SCENARIO_WEIGHTS),
        params=dict(beta=C.BETA, sicrMultiplier=C.SICR_MULTIPLIER, discountRate=C.DISCOUNT_RATE, hysteresis=dict(up=C.HYST_UP, down=C.HYST_DOWN),
                    scoreHalfLifeWeeks=C.SCORE_HALF_LIFE_WEEKS, restructuringExtensionMonths=C.RESTRUCTURING_EXTENSION_MONTHS),
        methods=METHODS, warnings=res.warnings,
        note="Provisions follow IFRS 9 (expected credit loss, stages 1-3). PD sensitivities can be calibrated to your own repayment history.")

    pf_out = dict(
        exposure=_money(pf["exposure"]), ead=_money(pf["ead"]), stressedEad=_money(pf["stressedEad"]),
        byLevel={k: _money(v) for k, v in pf["byLevel"].items()}, byLevelCount={k: _ints(v) for k, v in pf["byLevelCount"].items()},
        eclBank=_money(pf["eclBank"]), ecl={k: _money(v) for k, v in pf["ecl"].items()}, stage1=_ints(pf["stage1"]), stage2=_ints(pf["stage2"]), stage3=_ints(pf["stage3"]),
        clusters=pf["clusters"], concentration=pf["concentration"], fhiMean=_fhi_mean(loans_out, arr["ead"], arr["active"]))
    analysis = dict(meta=meta, loans=loans_out, portfolio=pf_out, stressTest=stt, alerts=al,
                    validation=dict(yieldModel=yres["validation"], backtest=bt))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(analysis, separators=(",", ":"), ensure_ascii=False, allow_nan=False))
    tick(f"wrote {out_path.relative_to(ROOT) if out_path.is_relative_to(ROOT) else out_path} ({out_path.stat().st_size / 1e6:.2f} MB)")

    if report_path:
        from loanly import report
        report.write_report(analysis, report_path, week=C.AS_OF_DEFAULT)
        tick(f"wrote report {report_path}")
    analysis["_timing"] = marks
    return analysis


def summarize(a: dict, log=print):
    w = a["meta"]["asOfDefault"]; loans = a["loans"]; pf = a["portfolio"]
    n = len(loans)
    lv = {k: sum(1 for l in loans if l["level"][w] == k) for k in C.LEVELS}
    act = [l for l in loans if l["credit"]["ead"][w] > 0]
    st = {s: sum(1 for l in act if l["credit"]["stage"][w] == s) for s in (1, 2, 3)}
    log("\n=== SUMMARY (week %d, %s) ===" % (w, a["meta"]["weeks"][w]))
    log(f"loans: {n} (active at as-of: {len(act)})")
    log("levels (all loans): " + ", ".join(f"{k} {v} ({v / n:.0%})" for k, v in lv.items()))
    alv = {k: sum(1 for l in act if l["level"][w] == k) for k in C.LEVELS}
    log("levels (active loans): " + ", ".join(f"{k} {v} ({v / max(len(act), 1):.0%})" for k, v in alv.items()))
    eb, ew = pf["eclBank"][w], pf["ecl"]["weighted"][w]
    log(f"EAD ${pf['ead'][w]:,.0f} | ECL bank ${eb:,.0f} -> climate-weighted ${ew:,.0f} (x{ew / max(eb, 1):.2f}); base ${pf['ecl']['base'][w]:,.0f} adverse ${pf['ecl']['adverse'][w]:,.0f} severe ${pf['ecl']['severe'][w]:,.0f}")
    log(f"stages (active): {st}  = Stage 2 {st[2] / max(len(act), 1):.0%}, Stage 3 {st[3]}")
    s = a["stressTest"]
    log(f"stress test: p50 ${s['p50']:,} p95 ${s['p95']:,} p99 ${s['p99']:,}, worst year {s['worstYear']}, current-season loss ${s['currentLoss']:,}")
    ym = a["validation"]["yieldModel"]
    log(f"yield model: {len(ym)} groups, mean LOYO R2 {np.mean([m['r2Loyo'] for m in ym]):.2f}, median {np.median([m['r2Loyo'] for m in ym]):.2f}, mean MAE {np.mean([m['maeLoyo'] for m in ym]):.3f}")
    aucs = {b['week']: b['auc'] for b in a["validation"]["backtest"] if b["auc"] is not None}
    log("back-test AUC by week: " + ", ".join(f"{a['meta']['weeks'][k][5:]}:{aucs[k]:.2f}" for k in sorted(aucs) if k % 4 == 3))
    for k in (14, 18, 22, 26, 30, 33):
        ls = [l for l in loans if l["regionId"] in ("AR-SF", "AR-BN", "AR-CS", "AR-ER") and l["stageWeight"][k] > 0.05]
        if ls:
            log(f"cascade wk{k} {a['meta']['weeks'][k]} (hard-hit, n={len(ls)}): " + ", ".join(f"{c} {np.mean([l['cascade'][k] == c for l in ls]):.0%}" for c in ("none", "early", "active", "confirmed")))
    byreg = {}
    for l in loans:
        byreg.setdefault(l["regionId"], []).append(l["level"][w])
    log("level by region: " + " | ".join(f"{r}: " + "/".join(str(sum(1 for x in v if x == k)) for k in C.LEVELS) for r, v in byreg.items()))
    log(f"alerts: {len(a['alerts'])}; clusters at as-of: {len(pf['clusters'][w])}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--book"); ap.add_argument("--out"); ap.add_argument("--report")
    ap.add_argument("--export-fhi", nargs=2, metavar=("LOAN_ID", "CSV"), help="write one loan's FHI inputs in the fhi_calc.py CSV format and exit")
    ap.add_argument("--uploaded", action="store_true", help="mark loans as uploaded")
    ap.add_argument("--no-params", action="store_true", help="do not (re)write samples/ifrs9_parameters.xlsx")
    args = ap.parse_args(argv)
    if args.export_fhi:
        export_fhi(args.export_fhi[0], args.export_fhi[1], args.book)
        return
    t = time.time()
    custom = bool(args.book)
    out = Path(args.out) if args.out else (ROOT / "web" / "public" / "data" / "analysis.json")
    default_report = ROOT / "samples" / "ifrs9_provision_report_example.xlsx"
    report_path = Path(args.report) if args.report else (default_report if not custom else None)
    a = run(args.book, out, report_path, uploaded=args.uploaded or custom)
    if not args.no_params and not custom:
        C.export_parameters_xlsx(ROOT / "samples" / "ifrs9_parameters.xlsx")
    summarize(a)
    print(f"\ntotal {time.time() - t:.1f}s")


if __name__ == "__main__":
    main()
