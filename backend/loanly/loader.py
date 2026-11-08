"""Loan-book loader and validator (CONTRACT section A).

Reads the workbook (sheets Farmers, Fields, Loans, Repayments, Insurance, CreditHistory) or one flat CSV of the Loans
sheet that also carries lat/lng/crop columns. Every problem is reported with sheet, row (Excel row number) and column so a
credit officer can fix the file. Missing optional values get the documented defaults below (applied silently, counted in `warnings`).

Defaults: crop soy (warning) | area_ha = farm_ha or 100 | irrigated no | sowing blank -> detected from NDVI |
amount_usd = area x typical crop input cost | origination = typical sowing - 4 weeks | maturity = harvest + 4 weeks | rate 10 % |
amortization bullet | rating 4 | pd_12m_origination from the rating table | collateral unsecured | lgd_bank from the collateral table |
bcra_situacion 1 | days_past_due 0 | no Repayments rows -> one bullet repayment at maturity.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

from . import config as C
from .synthetic import nearest_region, typical_sow_week

PERILS = {"drought", "excess_water", "frost", "heat", "hail"}
INS_TYPES = {"indemnity", "parametric", "multi-peril"}
COLLATERAL = set(C.LGD_BY_COLLATERAL)


@dataclass
class Book:
    loans: list
    snapshot: date
    source: str = ""
    warnings: list = field(default_factory=list)


@dataclass
class LoadResult:
    book: Book | None
    errors: list
    warnings: list


def _norm_cols(df):
    df = df.copy()
    df.columns = [str(c).strip().lower().replace(" ", "_") for c in df.columns]
    return df.dropna(how="all")


def _blank(v):
    return v is None or (isinstance(v, float) and math.isnan(v)) or (isinstance(v, str) and not v.strip()) or v is pd.NaT


class _Ctx:
    def __init__(self):
        self.errors, self.warnings = [], []

    def err(self, sheet, row, col, msg):
        self.errors.append(f"{sheet} row {row}, column {col}: {msg}" if row else f"{sheet}: {msg}")

    def warn(self, msg):
        if msg not in self.warnings:
            self.warnings.append(msg)

    def num(self, sheet, row, col, v, lo=None, hi=None, default=None, integer=False, required=False):
        if _blank(v):
            if required:
                self.err(sheet, row, col, "required value is missing")
            return default
        try:
            x = float(str(v).replace(",", "")) if isinstance(v, str) else float(v)
        except (TypeError, ValueError):
            self.err(sheet, row, col, f"not a number ({v!r})")
            return default
        if not math.isfinite(x) or (lo is not None and x < lo) or (hi is not None and x > hi):
            self.err(sheet, row, col, f"{x:g} is outside the allowed range {lo}..{hi}")
            return default
        return int(round(x)) if integer else x

    def dt(self, sheet, row, col, v, required=False):
        if _blank(v):
            if required:
                self.err(sheet, row, col, "required date is missing")
            return None
        if isinstance(v, datetime):
            return v.date()
        if isinstance(v, date):
            return v
        try:
            return pd.to_datetime(str(v)[:10], format="%Y-%m-%d").date()
        except (ValueError, TypeError):
            self.err(sheet, row, col, f"date must be YYYY-MM-DD ({v!r})")
            return None


def _read(path: Path):
    suf = path.suffix.lower()
    if suf == ".csv":
        return {"loans": pd.read_csv(path, dtype=object)}
    if suf in (".xlsx", ".xlsm"):
        raw = pd.read_excel(path, sheet_name=None, dtype=object)
        return {str(k).strip().lower(): v for k, v in raw.items()}
    raise ValueError(f"unsupported file type {suf!r}; upload an .xlsx workbook or a .csv")


def load_book(path, snapshot: date | None = None) -> LoadResult:
    path = Path(path)
    cx = _Ctx()
    try:
        sheets = _read(path)
    except Exception as e:  # unreadable file
        return LoadResult(None, [f"Could not read {path.name}: {e}"], [])
    snapshot = snapshot or C.WEEK_DATES[C.AS_OF_DEFAULT]
    if "loans" not in sheets:
        return LoadResult(None, ["Sheet 'Loans' not found (sheets: %s)" % ", ".join(sheets)], [])
    loans_df = _norm_cols(sheets["loans"])
    flat = "fields" not in sheets
    fields_df = _norm_cols(sheets["fields"]) if not flat else pd.DataFrame()
    farmers_df = _norm_cols(sheets["farmers"]) if "farmers" in sheets else pd.DataFrame()
    rep_df = _norm_cols(sheets["repayments"]) if "repayments" in sheets else pd.DataFrame()
    ins_df = _norm_cols(sheets["insurance"]) if "insurance" in sheets else pd.DataFrame()

    def need(df, sheet, cols):
        miss = [c for c in cols if c not in df.columns]
        if miss:
            cx.err(sheet, 0, ",".join(miss), "required column(s) missing")
        return not miss

    ok = need(loans_df, "Loans", ["loan_id"])
    if flat:
        ok &= need(loans_df, "Loans (flat file)", ["lat", "lng"])
    else:
        ok &= need(loans_df, "Loans", ["farmer_id", "field_id"]) and need(fields_df, "Fields", ["field_id", "farmer_id", "lat", "lng"])
    if not ok:
        return LoadResult(None, cx.errors, cx.warnings)

    # ---- farmers & fields
    farmers = {}
    for i, r in farmers_df.iterrows():
        farmers[str(r.get("farmer_id")).strip()] = r
    fields = {}
    if flat:
        for i, r in loans_df.iterrows():
            fields[f"P-{r['loan_id']}"] = (i + 2, r)
    else:
        for i, r in fields_df.iterrows():
            fid = str(r["field_id"]).strip()
            if fid in fields:
                cx.err("Fields", i + 2, "field_id", f"duplicate field_id {fid}")
            fields[fid] = (i + 2, r)

    def field_info(row, r):
        lat = cx.num("Fields", row, "lat", r.get("lat"), required=True)
        lng = cx.num("Fields", row, "lng", r.get("lng"), required=True)
        if lat is not None and not C.LATAM_BOX["lat"][0] <= lat <= C.LATAM_BOX["lat"][1]:
            cx.err("Fields", row, "lat", f"{lat} is outside Latin America")
            lat = None
        if lng is not None and not C.LATAM_BOX["lng"][0] <= lng <= C.LATAM_BOX["lng"][1]:
            cx.err("Fields", row, "lng", f"{lng} is outside Latin America (missing minus sign?)")
            lng = None
        crop = r.get("crop")
        if _blank(crop):
            crop = "soy"; cx.warn("crop missing on some fields: assumed soy")
        crop = str(crop).strip().lower()
        if crop not in C.CROPS:
            cx.err("Fields", row, "crop", f"unknown crop {crop!r} (use {', '.join(C.CROPS)})")
        irr = str(r.get("irrigated", "no")).strip().lower() in ("yes", "y", "true", "1", "si", "sí")
        area = cx.num("Fields", row, "area_ha", r.get("area_ha"), lo=0.1, hi=1e6)
        sow = cx.dt("Fields", row, "sowing_date", r.get("sowing_date"))
        ring = None
        wkt = r.get("polygon_wkt")
        if not _blank(wkt):
            try:
                nums = re.findall(r"(-?\d+\.?\d*)\s+(-?\d+\.?\d*)", str(wkt))
                ring = [[float(a), float(b)] for a, b in nums]
                if len(ring) < 4:
                    raise ValueError
            except ValueError:
                cx.err("Fields", row, "polygon_wkt", "could not parse POLYGON((lng lat, ...))")
                ring = None
        return lat, lng, crop, irr, area, sow, ring

    # ---- repayments & insurance grouped
    reps = {}
    if len(rep_df):
        if need(rep_df, "Repayments", ["loan_id", "due_date"]):
            for i, r in rep_df.iterrows():
                due = cx.dt("Repayments", i + 2, "due_date", r["due_date"], required=True)
                if due is None:
                    continue
                reps.setdefault(str(r["loan_id"]).strip(), []).append(dict(
                    date=due.isoformat(), principal=cx.num("Repayments", i + 2, "principal_usd", r.get("principal_usd"), lo=0, default=0.0) or 0.0,
                    interest=cx.num("Repayments", i + 2, "interest_usd", r.get("interest_usd"), lo=0, default=0.0) or 0.0,
                    paidDate=(cx.dt("Repayments", i + 2, "paid_date", r.get("paid_date")) or None) and cx.dt("Repayments", i + 2, "paid_date", r.get("paid_date")).isoformat(),
                    paidUsd=cx.num("Repayments", i + 2, "paid_usd", r.get("paid_usd"), lo=0)))
    ins = {}
    if len(ins_df) and need(ins_df, "Insurance", ["policy_id", "field_id"]):
        for i, r in ins_df.iterrows():
            t = str(r.get("type", "indemnity")).strip().lower() if not _blank(r.get("type")) else "indemnity"
            if t not in INS_TYPES:
                cx.err("Insurance", i + 2, "type", f"unknown type {t!r} (indemnity / parametric / multi-peril)")
                continue
            perils = [p.strip() for p in str(r.get("perils", "")).replace(";", ",").split(",") if p.strip()]
            bad = [p for p in perils if p not in PERILS]
            if bad:
                cx.err("Insurance", i + 2, "perils", f"unknown peril(s) {bad}")
            cover = cx.num("Insurance", i + 2, "cover_share", r.get("cover_share"), lo=0, hi=1, default=0.5)
            cur = dict(type=t, perils=[p for p in perils if p in PERILS], coverShare=cover,
                       sumInsured=cx.num("Insurance", i + 2, "sum_insured_usd", r.get("sum_insured_usd"), lo=0, default=0.0),
                       trigger="" if _blank(r.get("trigger")) else str(r.get("trigger")))
            fid = str(r["field_id"]).strip()
            if fid not in ins or cur["coverShare"] > ins[fid]["coverShare"]:
                ins[fid] = cur

    # ---- loans
    out, seen = [], set()
    for i, r in loans_df.iterrows():
        row = i + 2
        lid = str(r["loan_id"]).strip()
        if lid in seen:
            cx.err("Loans", row, "loan_id", f"duplicate loan_id {lid}")
        seen.add(lid)
        if flat:
            fkey = f"P-{r['loan_id']}"
            farmer_id = str(r.get("farmer_id") if not _blank(r.get("farmer_id")) else f"F-{lid}").strip()
            field_id = str(r.get("field_id") if not _blank(r.get("field_id")) else fkey).strip()
        else:
            farmer_id, field_id = str(r["farmer_id"]).strip(), str(r["field_id"]).strip()
            fkey = field_id
            if field_id not in fields:
                cx.err("Loans", row, "field_id", f"field {field_id} not found in sheet Fields")
                continue
            if farmers and farmer_id not in farmers:
                cx.warn(f"farmer {farmer_id} not found in sheet Farmers (name left blank)")
        frow, fr = fields[fkey]
        lat, lng, crop, irr, area, sow, ring = field_info(frow, fr)
        if lat is None or lng is None or crop not in C.CROPS:
            continue
        far = farmers.get(farmer_id)
        farm_ha = cx.num("Farmers", 0, "farm_ha", far.get("farm_ha") if far is not None else None, lo=0)
        area = area or farm_ha or 100.0
        cc = C.CROPS[crop]
        orig = cx.dt("Loans", row, "origination_date", r.get("origination_date"))
        mat = cx.dt("Loans", row, "maturity_date", r.get("maturity_date"))
        sw = (sow - C.SEASON_START).days // 7 if sow else typical_sow_week(crop, lat, lng)
        if orig is None:
            orig = C.SEASON_START + timedelta(days=7 * max(0, sw - 4)); cx.warn("origination_date missing on some loans: assumed 4 weeks before sowing")
        if mat is None:
            mat = C.SEASON_START + timedelta(days=7 * (sw + C.CROP_DURATION[crop] + 4)); cx.warn("maturity_date missing on some loans: assumed harvest + 4 weeks")
        if mat <= orig:
            cx.err("Loans", row, "maturity_date", "must be after origination_date")
        amount = cx.num("Loans", row, "amount_usd", r.get("amount_usd"), lo=1)
        if amount is None:
            amount = round(area * cc["cost_ha"], -3) or 1000.0; cx.warn("amount_usd missing on some loans: assumed area x typical input cost")
        rate = cx.num("Loans", row, "rate_pct", r.get("rate_pct"), lo=0, hi=200, default=10.0)
        rating = cx.num("Loans", row, "rating_origination", r.get("rating_origination"), lo=1, hi=8, default=C.DEFAULT_RATING, integer=True)
        pd0 = cx.num("Loans", row, "pd_12m_origination", r.get("pd_12m_origination"), lo=0, hi=1)
        pd0 = C.PD_BY_RATING[int(rating)] if pd0 is None else pd0
        coll = str(r.get("collateral_type")).strip().lower() if not _blank(r.get("collateral_type")) else "unsecured"
        if coll not in COLLATERAL:
            cx.err("Loans", row, "collateral_type", f"unknown collateral {coll!r} ({', '.join(sorted(COLLATERAL))})")
            coll = "unsecured"
        lgd = cx.num("Loans", row, "lgd_bank", r.get("lgd_bank"), lo=0, hi=1)
        lgd = C.LGD_BY_COLLATERAL[coll] if lgd is None else lgd
        cval = cx.num("Loans", row, "collateral_value_usd", r.get("collateral_value_usd"), lo=0, default=0.0)
        bcra = cx.num("Loans", row, "bcra_situacion", r.get("bcra_situacion"), lo=1, hi=6, default=1, integer=True)
        dpd = cx.num("Loans", row, "days_past_due", r.get("days_past_due"), lo=0, default=0, integer=True)
        amort = str(r.get("amortization")).strip().lower() if not _blank(r.get("amortization")) else "bullet"
        if amort not in ("bullet", "installments"):
            cx.err("Loans", row, "amortization", f"must be bullet or installments ({amort!r})")
            amort = "bullet"
        sched = reps.get(lid)
        if not sched:
            if amort == "installments":
                cx.warn("amortization=installments without Repayments rows: treated as bullet")
            sched = [dict(date=mat.isoformat(), principal=amount, interest=round(amount * rate / 100 * (mat - orig).days / 365, 0), paidDate=None, paidUsd=None)]
        sched = sorted(sched, key=lambda x: x["date"])
        reg, dist = nearest_region(lat, lng)
        if dist > 500:
            cx.warn(f"field {field_id} is {dist:.0f} km from the nearest modelled region ({reg['name']}): regional yield statistics are borrowed from there")
        name = far.get("name") if far is not None and not _blank(far.get("name")) else farmer_id
        country = far.get("country") if far is not None and not _blank(far.get("country")) else reg["country"]
        other = cx.num("Farmers", 0, "other_bank_debt_usd", far.get("other_bank_debt_usd") if far is not None else None, lo=0, default=0.0)
        out.append(dict(
            id=lid, farmerId=farmer_id, borrower=str(name), fieldId=field_id, country=str(country), region=reg["name"], regionId=reg["id"],
            lat=round(lat, 5), lng=round(lng, 5), ring=ring, crop=crop, areaHa=float(area), farmHa=float(farm_ha or area), irrigated=irr,
            product="" if _blank(r.get("product")) else str(r.get("product")), amountUsd=float(amount), originated=orig.isoformat(), maturity=mat.isoformat(),
            ratePct=float(rate), schedule=sched, ratingOrig=int(rating), pdOrig=float(pd0), lgdBank=float(lgd), collateral=coll, collateralValue=float(cval),
            bcraSituacion=int(bcra), daysPastDue=int(dpd), insurance=ins.get(field_id), otherBankDebt=float(other or 0.0), uploaded=False,
            _sowing=sow, _province=str(far.get("province")) if far is not None and not _blank(far.get("province")) else reg["name"],
        ))
    if cx.errors:
        return LoadResult(None, cx.errors, cx.warnings)
    if not out:
        return LoadResult(None, ["No loans found in the file"], cx.warnings)
    return LoadResult(Book(out, snapshot, path.name, cx.warnings), [], cx.warnings)
