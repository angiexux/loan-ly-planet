"""IFRS 9 provision report workbook (openpyxl): what a risk officer would attach to the provisioning file.

Sheets: Summary (ECL bank vs climate by scenario, stage counts, provision change, stress-test p95), Loans (one row per loan as of a
chosen week), Alerts, Clusters, Stress test, Methods.
"""
from __future__ import annotations

from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from . import alerts as alerts_mod
from . import config as C
from . import fhi as fhi_mod

HEAD = PatternFill("solid", fgColor="1F4E3D")
SUB = PatternFill("solid", fgColor="E8F0EC")
LEVEL_FILL = {"Normal": "DDEEDD", "Watch": "FFF3C4", "High": "FFD9B3", "Severe": "F6B7B7"}
USD = '#,##0;[Red]-#,##0'
thin = Side(style="thin", color="BBBBBB")


def _header(ws, row, labels, widths=None):
    for j, lab in enumerate(labels, 1):
        c = ws.cell(row, j, lab)
        c.font = Font(bold=True, color="FFFFFF"); c.fill = HEAD
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = 32
    if widths:
        for j, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(j)].width = w


def write_report(a: dict, path, week: int | None = None) -> Path:
    week = a["meta"]["asOfDefault"] if week is None else int(week)
    wk = a["meta"]["weeks"][week]
    loans, pf = a["loans"], a["portfolio"]
    wb = Workbook()

    # ---------------------------------------------------------------- Summary
    ws = wb.active; ws.title = "Summary"
    ws["A1"] = f"IFRS 9 climate provision report: {a['meta']['lender']}"; ws["A1"].font = Font(bold=True, size=15)
    ws["A2"] = f"As of week {week} ({wk}), season {a['meta']['season']}. Provisions follow IFRS 9."
    ws["A2"].font = Font(italic=True, color="666666")
    r = 4
    _header(ws, r, ["ECL (USD)", "Amount", "vs bank baseline"], [44, 18, 18])
    bank = pf["eclBank"][week]
    rows = [("Bank baseline (PD and LGD at origination)", bank)] + [(f"Climate-adjusted: {k} scenario ({a['meta']['scenarios'].get(k, '')})" if k != "weighted" else "Climate-adjusted: probability-weighted", pf["ecl"][k][week]) for k in ("base", "adverse", "severe", "weighted")]
    for lab, v in rows:
        r += 1
        ws.cell(r, 1, lab); ws.cell(r, 2, v).number_format = USD
        ws.cell(r, 3, (v / bank - 1) if bank else None).number_format = "+0.0%;-0.0%"
    wrow = r
    for c in range(1, 4):
        ws.cell(wrow, c).font = Font(bold=True)
    r += 2
    ws.cell(r, 1, "Provision change (weighted - baseline)").font = Font(bold=True)
    ws.cell(r, 2, pf["ecl"]["weighted"][week] - bank).number_format = USD
    ws.cell(r, 3, pf["ecl"]["weighted"][week] / bank if bank else None).number_format = '0.00"x"'
    r += 2
    _header(ws, r, ["IFRS 9 stage (loans in the book)", "Loans", "EAD (USD)"])
    for s in (1, 2, 3):
        r += 1
        ls = [l for l in loans if l["credit"]["ead"][week] > 0 and l["credit"]["stage"][week] == s]
        ws.cell(r, 1, f"Stage {s}"); ws.cell(r, 2, len(ls)); ws.cell(r, 3, sum(l["credit"]["ead"][week] for l in ls)).number_format = USD
    r += 2
    _header(ws, r, ["Climate stress level", "Loans", "EAD (USD)"])
    for lv in C.LEVELS:
        r += 1
        ls = [l for l in loans if l["credit"]["ead"][week] > 0 and l["level"][week] == lv]
        ws.cell(r, 1, lv).fill = PatternFill("solid", fgColor=LEVEL_FILL[lv]); ws.cell(r, 2, len(ls)); ws.cell(r, 3, sum(l["credit"]["ead"][week] for l in ls)).number_format = USD
    r += 2
    st = a["stressTest"]
    _header(ws, r, ["Historical stress test (today's book, 21 seasons)", "Loss (USD)", ""])
    for lab, v in (("Median year", st["p50"]), ("95th percentile (1-in-20 years)", st["p95"]), ("99th percentile", st["p99"]),
                   (f"Worst year ({st['worstYear']}/{str(st['worstYear'] + 1)[2:]})", max(st["loss"])), ("This season (base scenario)", st.get("currentLoss"))):
        r += 1
        ws.cell(r, 1, lab); ws.cell(r, 2, v).number_format = USD
    r += 2
    ws.cell(r, 1, f"Total EAD {pf['ead'][week]:,.0f} USD; {sum(1 for l in loans if l['credit']['ead'][week] > 0)} loans in the book.").font = Font(italic=True)
    ws.freeze_panes = "A4"

    # ---------------------------------------------------------------- Loans
    ws = wb.create_sheet("Loans")
    cols = ["Loan", "Borrower", "Region", "Crop", "Crop stage", "Score", "Level", "Main peril", "Explanation", "PD orig", "PD now (12m)", "IFRS 9 stage", "Stage reason",
            "LGD", "EAD (USD)", "ECL bank", "ECL base", "ECL adverse", "ECL severe", "ECL weighted", "Change vs bank"]
    _header(ws, 1, cols, [9, 30, 24, 10, 16, 7, 9, 12, 90, 8, 10, 8, 18, 7, 13, 11, 11, 11, 11, 12, 13])
    for i, l in enumerate(loans, 2):
        cr = l["credit"]
        k, _ = alerts_mod.dominant_peril(l, week)
        vals = [l["id"], l["borrower"], l["region"], l["crop"], l["stage"][week], l["score"][week], l["level"][week], alerts_mod.PERIL_LABEL.get(k, "-"),
                alerts_mod.explain(l, week), l["pdOrig"], cr["pd12"][week], cr["stage"][week], cr["stageReason"][week], cr["lgd"][week], cr["ead"][week],
                cr["eclBank"][week], cr["ecl"]["base"][week], cr["ecl"]["adverse"][week], cr["ecl"]["severe"][week], cr["ecl"]["weighted"][week],
                cr["ecl"]["weighted"][week] - cr["eclBank"][week]]
        for j, v in enumerate(vals, 1):
            ws.cell(i, j, v)
        ws.cell(i, 7).fill = PatternFill("solid", fgColor=LEVEL_FILL[l["level"][week]])
        ws.cell(i, 6).number_format = "0"
        for j in (10, 11, 14):
            ws.cell(i, j).number_format = "0.0%"
        for j in range(15, 22):
            ws.cell(i, j).number_format = USD
        ws.cell(i, 9).alignment = Alignment(wrap_text=True, vertical="top")
    ws.freeze_panes = "C2"; ws.auto_filter.ref = f"A1:{get_column_letter(len(cols))}{len(loans) + 1}"

    # ---------------------------------------------------------------- Farm health (display indicator, not used in PD / staging / ECL)
    ws = wb.create_sheet("Farm health")
    _header(ws, 1, ["Loan", "Borrower", "Crop", "Region", "FHI now", "Reading", "VCI_p (greenness)", "SMp* (soil, two-sided)", "WA_p (ET/PET)",
                    C.SEASON_LABEL + " campaign mean", "Mean of past campaigns", "Worst past campaign mean", "Worst past campaign"], [9, 30, 10, 24, 9, 13, 14, 14, 12, 14, 14, 14, 13])
    n = 1
    for l in loans:
        s_ = fhi_mod.summary(l, week)
        if "fhi" not in l:
            continue
        n += 1
        for j, v in enumerate([l["id"], l["borrower"], l["crop"], l["region"], s_["now"], fhi_mod.label(s_["now"]), s_["vci"], s_["sm"], s_["wa"],
                               s_["cur"], s_["past_mean"], s_["worst"], s_["worst_campaign"]], 1):
            ws.cell(n, j, v)
        for j in (5, 7, 8, 9, 10, 11, 12):
            ws.cell(n, j).number_format = "0.0"
    n += 2
    ws.cell(n, 1, C.FHI_NOTE + ". Empty = outside the crop season. 0-100: <30 poor, 30-50 below normal, 50-70 normal, >70 good.").font = Font(italic=True)
    ws.freeze_panes = "C2"; ws.auto_filter.ref = f"A1:M{max(n - 2, 2)}"

    # ---------------------------------------------------------------- Alerts
    ws = wb.create_sheet("Alerts")
    _header(ws, 1, ["Week", "Date", "Loan", "From", "To", "Kind", "Score", "Explanation", "Recommended action", "Why"], [7, 12, 9, 9, 9, 8, 7, 90, 40, 70])
    n = 1
    for al in a["alerts"]:
        if al["week"] > week:
            continue
        n += 1
        for j, v in enumerate([al["week"], a["meta"]["weeks"][al["week"]], al["loanId"], al["from"], al["to"], al["kind"], al["score"], al["explanation"],
                               al["recommendation"]["action"], al["recommendation"]["why"]], 1):
            ws.cell(n, j, v)
        ws.cell(n, 5).fill = PatternFill("solid", fgColor=LEVEL_FILL[al["to"]])
    ws.freeze_panes = "A2"; ws.auto_filter.ref = f"A1:J{max(n, 2)}"

    # ---------------------------------------------------------------- Clusters
    ws = wb.create_sheet("Clusters")
    _header(ws, 1, ["Cluster", "Loans", "Lat", "Lng", "Radius km", "EAD (USD)", "Mean score", "Loan ids"], [9, 8, 9, 9, 10, 14, 11, 90])
    for i, c in enumerate(pf["clusters"][week], 2):
        for j, v in enumerate([c["id"], len(c["loanIds"]), c["lat"], c["lng"], c["radiusKm"], c["ead"], c["meanScore"], ", ".join(c["loanIds"])], 1):
            ws.cell(i, j, v)
        ws.cell(i, 6).number_format = USD
    ws.freeze_panes = "A2"

    # ---------------------------------------------------------------- Stress test
    ws = wb.create_sheet("Stress test")
    _header(ws, 1, ["Season replayed", "Book loss (USD)"], [18, 18])
    for i, (y, v) in enumerate(zip(st["years"], st["loss"]), 2):
        ws.cell(i, 1, f"{y}/{str(y + 1)[2:]}"); ws.cell(i, 2, v).number_format = USD
    i = len(st["years"]) + 3
    for lab, v in (("p50", st["p50"]), ("p95", st["p95"]), ("p99", st["p99"])):
        ws.cell(i, 1, lab).font = Font(bold=True); ws.cell(i, 2, v).number_format = USD; i += 1
    ws.cell(i + 1, 1, st["note"]).font = Font(italic=True)
    ws.freeze_panes = "A2"

    # ---------------------------------------------------------------- Methods
    ws = wb.create_sheet("Methods")
    ws.column_dimensions["A"].width = 22; ws.column_dimensions["B"].width = 140
    _header(ws, 1, ["Module", "Method"])
    for i, (k, v) in enumerate(a["meta"]["methods"].items(), 2):
        ws.cell(i, 1, k).font = Font(bold=True); c = ws.cell(i, 2, v); c.alignment = Alignment(wrap_text=True, vertical="top")
    p = a["meta"]["params"]
    i = len(a["meta"]["methods"]) + 3
    ws.cell(i, 1, "Parameters").font = Font(bold=True)
    ws.cell(i, 2, f"beta {p['beta']}, SICR multiplier {p['sicrMultiplier']}, discount rate {p['discountRate']:.0%}, scenario weights {a['meta']['scenarios']}, hysteresis {p['hysteresis']}")
    ws.cell(i + 1, 1, "Basis").font = Font(bold=True)
    ws.cell(i + 1, 2, "Provisions follow IFRS 9. PD adjustments, LGD tables and scenario weights can be calibrated to your own repayment history.")
    ws.cell(i + 1, 2).alignment = Alignment(wrap_text=True)

    if hasattr(path, "write"):                       # file-like (the HTTP server streams the workbook)
        wb.save(path)
        return path
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path
