"""PDF reports (matplotlib PdfPages, A4 portrait). House style: Loan-ly Planet logo, fern accent, risk colours, synthetic-data footer.

build_pdf(kind, analysis, week, loan_id=None, ids=None) -> bytes

Kinds (CONTRACT section C): portfolio, early_warning, loan_memo (analysis documents) and the six action documents for one loan:
claim, restructure, downgrade, transfer, cover_offer, contact, insurance_application.  Every number comes from the analysis dict (plus the ifrs9 functions for
the Stage 1 vs Stage 2 comparison); nothing is invented.  IFRS 9-aligned, NOT audit-ready.
"""
from __future__ import annotations

import io
import re
import textwrap
from datetime import date, datetime, timedelta

import matplotlib

matplotlib.use("Agg")
import matplotlib.image as mpimg  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402
from matplotlib.patches import FancyBboxPatch, Rectangle  # noqa: E402

from . import alerts as alerts_mod  # noqa: E402
from . import config as C  # noqa: E402
from . import ifrs9  # noqa: E402
from . import sensors as sensors_mod  # noqa: E402

matplotlib.rcParams["pdf.fonttype"] = 42
matplotlib.rcParams["text.parse_math"] = False
matplotlib.rcParams["font.family"] = "DejaVu Sans"

PW, PH = 8.27, 11.69
MX = 0.6
CW = PW - 2 * MX
TOP, BOTTOM = 1.35, PH - 0.95
FERN, INK, MUTED, LIGHT, LINE = "#2f6f96", "#16324a", "#5b7488", "#eef5f6", "#cfe0e6"
LEVEL_COL = {"Normal": "#3f86ab", "Watch": "#eda06f", "High": "#de6f3a", "Severe": "#b8401a"}
LOGO = C.ROOT / "web" / "public" / "brand" / "logo.png"
FOOTER = "Loan-ly Planet · IFRS 9 expected credit loss"

KINDS = [
    dict(kind="portfolio", title="IFRS 9 climate provision report (portfolio)", needsLoan=False),
    dict(kind="early_warning", title="Early-warning report (alerts and ranked stressed loans)", needsLoan=False),
    dict(kind="loan_memo", title="Loan memo (one loan: evidence, credit risk, recommendation)", needsLoan=True),
    dict(kind="claim", title="Insurance claim notice (payout routed to the loan)", needsLoan=True),
    dict(kind="restructure", title="Restructuring proposal (extend to next harvest)", needsLoan=True),
    dict(kind="downgrade", title="Stage 2 transfer memo (SICR evidence)", needsLoan=True),
    dict(kind="transfer", title="Loan sale / transfer memo", needsLoan=True),
    dict(kind="cover_offer", title="Parametric cover offer for next season", needsLoan=True),
    dict(kind="contact", title="Borrower call brief", needsLoan=True),
    dict(kind="insurance_application", title="Insurance application (prefilled, lender as loss payee)", needsLoan=True),
    dict(kind="soil_sensors", title="Soil sensor report", needsLoan=True),
]
KIND_NAMES = [k["kind"] for k in KINDS]
STAGE_WORD = {"performing": "performing", "inactive": "not in the book", "pd_2x_origination": "PD at least 2x its origination level (SICR)",
              "critical_alert": "critical climate alert (level Severe)", "dpd_30": "more than 30 days past due", "dpd_90": "more than 90 days past due (default)",
              "bcra_2": "BCRA situacion 2", "bcra_3plus": "BCRA situacion 3 or worse (default)"}


# ------------------------------------------------------------------------------------------------ formatting helpers
def usd(x, short=False):
    if x is None:
        return "n/a"
    x = float(x)
    if short and abs(x) >= 1e6:
        return f"${x / 1e6:.2f}M"
    if short and abs(x) >= 1e4:
        return f"${x / 1e3:.0f}k"
    return f"-${abs(x):,.0f}" if x < 0 else f"${x:,.0f}"


def sgn_usd(x):
    return ("+" if x >= 0 else "-") + usd(abs(x))


def pct(x, d=1):
    return "n/a" if x is None else f"{x * 100:.{d}f}%"


def spct(x, d=0):
    return "n/a" if x is None else f"{x * 100:+.{d}f}%"


def dstr(d):
    return d.isoformat() if hasattr(d, "isoformat") else str(d)


def fmt_date(s):
    try:
        return datetime.fromisoformat(str(s)).strftime("%d %b %Y")
    except Exception:
        return str(s)


def mon_label(s):
    return datetime.fromisoformat(s).strftime("%b")


def chars_per_line(width_in, size, bold=False):
    return max(8, int(width_in * 72 / (size * (0.63 if bold else 0.575))))


def wrap(s, width_in, size, bold=False):
    out = []
    for para in str(s).split("\n"):
        out += textwrap.wrap(para, chars_per_line(width_in, size, bold), break_long_words=True) or [""]
    return out


# ------------------------------------------------------------------------------------------------ the page engine
class Doc:
    def __init__(self, title, a, week):
        self.a, self.week = a, week
        self.title = title
        self.asof = a["meta"]["weeks"][week]
        self.buf = io.BytesIO()
        self.pdf = PdfPages(self.buf)
        self.n = 0
        self.fig = self.ax = None
        self.y = TOP
        try:
            self.logo = mpimg.imread(str(LOGO))
        except Exception:
            self.logo = None
        self.generated = date.today().isoformat()
        self.new_page()

    # -- page furniture
    def new_page(self):
        if self.fig is not None:
            self._close_page()
        self.n += 1
        self.fig = plt.figure(figsize=(PW, PH))
        self.ax = self.fig.add_axes([0, 0, 1, 1])
        self.ax.set_xlim(0, PW); self.ax.set_ylim(PH, 0); self.ax.axis("off")
        if self.logo is not None:
            lax = self.fig.add_axes([MX / PW, 1 - (0.30 + 0.62) / PH, 0.62 / PW, 0.62 / PH]); lax.imshow(self.logo); lax.axis("off")
        self.ax.text(MX + 0.72, 0.52, "LOAN-LY PLANET", fontsize=17, fontweight="bold", color=INK, va="center", family="DejaVu Sans")
        self.ax.text(MX + 0.72, 0.78, "Climate risk for agricultural lending", fontsize=7.5, color=MUTED, va="center")
        self.ax.text(PW - MX, 0.52, self.title, fontsize=8.5, color=INK, ha="right", va="center", fontweight="bold")
        self.ax.text(PW - MX, 0.74, f"as of {self.asof} (week {self.week}) · {self.a['meta']['lender']}", fontsize=7.5, color=MUTED, ha="right", va="center")
        self.ax.plot([MX, PW - MX], [1.02, 1.02], color=FERN, lw=2.2, solid_capstyle="butt")
        self.y = TOP

    def _close_page(self):
        ax = self.ax
        ax.plot([MX, PW - MX], [PH - 0.72, PH - 0.72], color=LINE, lw=0.8)
        ax.text(MX, PH - 0.62, FOOTER, fontsize=6.3, color=MUTED, va="top")
        ax.text(MX, PH - 0.46, f"Generated {self.generated} · as of {self.asof} (week {self.week}) · {self.a['meta']['lender']}", fontsize=6.3, color=MUTED, va="top")
        ax.text(PW - MX, PH - 0.62, f"page {self.n}", fontsize=7, color=INK, ha="right", va="top", fontweight="bold")
        self.pdf.savefig(self.fig)
        plt.close(self.fig)
        self.fig = None

    def finish(self) -> bytes:
        self._close_page()
        self.pdf.close()
        return self.buf.getvalue()

    def need(self, h):
        if self.y + h > BOTTOM:
            self.new_page()

    def gap(self, h=0.12):
        self.y += h

    # -- text
    def text(self, x, y, s, size=9, weight="normal", color=INK, ha="left", va="top", style="normal"):
        return self.ax.text(x, y, s, fontsize=size, fontweight=weight, color=color, ha=ha, va=va, fontstyle=style)

    def para(self, s, size=9, weight="normal", color=INK, x=None, width=None, lead=1.38, after=0.07, style="normal", bullet=None):
        x = MX if x is None else x
        width = (PW - MX - x) if width is None else width
        if bullet:
            lines = wrap(s, width - 0.18, size, weight == "bold")
        else:
            lines = wrap(s, width, size, weight == "bold")
        lh = size * lead / 72
        for i, ln in enumerate(lines):
            self.need(lh)
            if bullet and i == 0:
                self.text(x, self.y, bullet, size, color=FERN, weight="bold")
            self.text(x + (0.18 if bullet else 0), self.y, ln, size, weight, color, style=style)
            self.y += lh
        self.y += after

    def title_block(self, title, sub=None):
        self.need(0.9)
        self.text(MX, self.y, title, min(19, 19 * 33 / max(len(title), 1)), "bold"); self.y += 0.36
        if sub:
            for ln in wrap(sub, CW, 8.5):
                self.text(MX, self.y, ln, 8.5, color=MUTED); self.y += 0.16
        self.y += 0.1

    def heading(self, s, n=None):
        self.need(0.75)
        self.y += 0.1
        self.ax.add_patch(Rectangle((MX, self.y + 0.01), 0.07, 0.2, color=FERN, lw=0))
        self.text(MX + 0.15, self.y, (f"{n}. " if n else "") + s, 11.5, "bold")
        self.y += 0.3

    def chip(self, x, y, s, color, size=7.5, w=None):
        w = w or (0.12 + len(s) * size * 0.0074)
        self.ax.add_patch(FancyBboxPatch((x, y), w, 0.19, boxstyle="round,pad=0,rounding_size=0.05", fc=color, ec="none"))
        self.text(x + w / 2, y + 0.1, s, size, "bold", "white", ha="center", va="center")
        return w

    def kpis(self, items, cols=4):
        tile_w = (CW - 0.12 * (cols - 1)) / cols
        for r in range(0, len(items), cols):
            self.need(0.82)
            for c, (lab, val, sub, *col) in enumerate(items[r:r + cols]):
                x = MX + c * (tile_w + 0.12)
                self.ax.add_patch(FancyBboxPatch((x, self.y), tile_w, 0.74, boxstyle="round,pad=0,rounding_size=0.06", fc=LIGHT, ec=LINE, lw=0.6))
                self.ax.add_patch(Rectangle((x, self.y + 0.06), 0.045, 0.62, fc=(col[0] if col else FERN), lw=0))
                self.text(x + 0.14, self.y + 0.07, lab, 6.8, color=MUTED)
                self.text(x + 0.14, self.y + 0.24, val, 14 if len(val) < 11 else 11.5, "bold", color=(col[0] if col else INK))
                if sub:
                    self.text(x + 0.14, self.y + 0.54, sub, 6.5, color=MUTED)
            self.y += 0.86

    def kv(self, pairs, cols=2, size=8.3):
        colw = CW / cols
        lw = 1.35 if cols == 2 else 1.7
        for r in range(0, len(pairs), cols):
            chunk = pairs[r:r + cols]
            hs = []
            for k, v in chunk:
                hs.append(len(wrap(v, colw - lw - 0.1, size, True)) * size * 1.35 / 72)
            h = max(hs + [size * 1.35 / 72])
            self.need(h + 0.04)
            for c, (k, v) in enumerate(chunk):
                x = MX + c * colw
                self.text(x, self.y, k, size - 0.6, color=MUTED)
                yy = self.y
                for ln in wrap(v, colw - lw - 0.1, size, True):
                    self.text(x + lw, yy, ln, size, "bold"); yy += size * 1.35 / 72
            self.y += h + 0.06
        self.y += 0.04

    def table(self, cols, rows, widths=None, size=7.6, aligns=None, zebra=True, bold_last=False, head_color=FERN):
        n = len(cols)
        widths = widths or [1] * n
        tot = float(sum(widths))
        wi = [CW * w / tot for w in widths]
        aligns = aligns or ["l"] * n
        pad, lh = 0.05, size * 1.32 / 72

        def cell(v):
            return v if isinstance(v, tuple) else (v, None)

        def row_h(r, bold=False):
            return max(len(wrap(cell(v)[0], wi[j] - 2 * pad, size, bold)) for j, v in enumerate(r)) * lh + 2 * pad

        def draw_head():
            hh = max(len(wrap(c, wi[j] - 2 * pad, size, True)) for j, c in enumerate(cols)) * lh + 2 * pad
            self.need(hh + 0.3)
            self.ax.add_patch(Rectangle((MX, self.y), CW, hh, fc=INK, lw=0))
            x = MX
            for j, c in enumerate(cols):
                for k, ln in enumerate(wrap(c, wi[j] - 2 * pad, size, True)):
                    tx = x + pad if aligns[j] == "l" else x + wi[j] - pad
                    self.text(tx, self.y + pad + k * lh, ln, size, "bold", "white", ha="left" if aligns[j] == "l" else "right")
                x += wi[j]
            self.y += hh

        draw_head()
        for i, r in enumerate(rows):
            last = bold_last and i == len(rows) - 1
            h = row_h(r, last)
            if self.y + h > BOTTOM:
                self.new_page(); draw_head()
            if zebra and i % 2 == 0:
                self.ax.add_patch(Rectangle((MX, self.y), CW, h, fc=LIGHT, lw=0))
            x = MX
            for j, v in enumerate(r):
                s, col = cell(v)
                for k, ln in enumerate(wrap(s, wi[j] - 2 * pad, size, last)):
                    tx = x + pad if aligns[j] == "l" else x + wi[j] - pad
                    self.text(tx, self.y + pad + k * lh, ln, size, "bold" if (last or col) else "normal", col or INK, ha="left" if aligns[j] == "l" else "right")
                x += wi[j]
            self.y += h
        self.ax.plot([MX, PW - MX], [self.y, self.y], color=LINE, lw=0.8)
        self.y += 0.14

    def chart(self, h, draw, x=None, w=None, advance=True):
        x = MX if x is None else x
        w = CW if w is None else w
        self.need(h + 0.05)
        ax = self.fig.add_axes([(x + 0.45) / PW, 1 - (self.y + h - 0.28) / PH, (w - 0.55) / PW, (h - 0.5) / PH])
        ax.tick_params(labelsize=6.5, length=2.5, width=0.5, colors=MUTED)
        for s in ("top", "right"):
            ax.spines[s].set_visible(False)
        for s in ("left", "bottom"):
            ax.spines[s].set_color(LINE)
        draw(ax)
        if advance:
            self.y += h + 0.05
        return ax

    def charts_row(self, h, draws, widths):
        """Several charts side by side (relative widths)."""
        self.need(h + 0.05)
        tot = float(sum(widths)); x = MX; y0 = self.y
        for d, wr in zip(draws, widths):
            w = CW * wr / tot
            self.chart(h, d, x=x, w=w, advance=False)
            x += w
        self.y = y0 + h + 0.05

    def signatures(self, labels):
        self.need(1.0)
        self.y += 0.35
        w = CW / len(labels)
        for i, lab in enumerate(labels):
            x = MX + i * w
            self.ax.plot([x, x + w - 0.25], [self.y, self.y], color=INK, lw=0.7)
            self.text(x, self.y + 0.05, lab, 7.5, color=MUTED)
            self.text(x, self.y + 0.21, "Name / date:", 7, color=MUTED)
        self.y += 0.5

    def checklist(self, items, size=8.6):
        for it in items:
            lines = wrap(it, CW - 0.3, size)
            self.need(len(lines) * size * 1.38 / 72 + 0.05)
            self.text(MX, self.y, "\u2610", size + 1.5, color=INK)
            for ln in lines:
                self.text(MX + 0.25, self.y, ln, size); self.y += size * 1.38 / 72
            self.y += 0.04

    def approval(self, roles):
        """Sign-off table: role, decision boxes, name, signature, date."""
        cols = ["Role", "Decision", "Name", "Signature", "Date"]
        wi = [CW * f for f in (0.27, 0.2, 0.18, 0.22, 0.13)]
        rh = 0.5
        self.need(0.3 + rh * len(roles) + 0.1)
        self.ax.add_patch(Rectangle((MX, self.y), CW, 0.26, fc=INK, lw=0))
        x = MX
        for c, w_ in zip(cols, wi):
            self.text(x + 0.06, self.y + 0.07, c, 7.6, "bold", "white"); x += w_
        self.y += 0.26
        for r in roles:
            self.ax.add_patch(Rectangle((MX, self.y), CW, rh, fc="white", ec=LINE, lw=0.6))
            self.text(MX + 0.06, self.y + 0.07, r, 8, "bold")
            self.text(MX + wi[0] + 0.06, self.y + 0.07, "\u2610 Approve", 7.8); self.text(MX + wi[0] + 0.06, self.y + 0.26, "\u2610 Reject", 7.8)
            x = MX
            for w_ in wi[:-1]:
                x += w_
                self.ax.plot([x, x], [self.y, self.y + rh], color=LINE, lw=0.6)
            self.y += rh
        self.y += 0.15

    def callout(self, s, color=FERN, size=9, bold=True):
        lines = wrap(s, CW - 0.35, size, bold)
        h = len(lines) * size * 1.4 / 72 + 0.18
        self.need(h + 0.05)
        self.ax.add_patch(Rectangle((MX, self.y), CW, h, fc=LIGHT, lw=0))
        self.ax.add_patch(Rectangle((MX, self.y), 0.06, h, fc=color, lw=0))
        for i, ln in enumerate(lines):
            self.text(MX + 0.2, self.y + 0.09 + i * size * 1.4 / 72, ln, size, "bold" if bold else "normal")
        self.y += h + 0.12


# ------------------------------------------------------------------------------------------------ data helpers
def _loan(a, lid):
    L = next((l for l in a["loans"] if l["id"] == lid), None)
    if L is None:
        raise ValueError(f"unknown loan {lid!r}")
    return L


def _in_book(a, w):
    return [l for l in a["loans"] if l["credit"]["ead"][w] > 0]


def _peril(L, w):
    k, inten = alerts_mod.dominant_peril(L, w)
    return (alerts_mod.PERIL_LABEL.get(k, "no dominant peril") if k else "no dominant peril"), k, inten


def _window(a, L):
    cw = a["meta"]["crops"][L["crop"]]["criticalWindow"]
    s = int(L["sowing"]["week"])
    return s + cw[0], s + cw[1]


def _crit_stage_names(a, crop):
    return [s["name"] for s in a["meta"]["crops"][crop]["stages"] if s["weight"] >= C.CRITICAL_MIN_WEIGHT]


def _cluster_of(a, L, w):
    for c in a["portfolio"]["clusters"][w]:
        if L["id"] in c["loanIds"]:
            return c
    return None


def _region_name(a, rid):
    return next((r["name"] for r in a["meta"]["regions"] if r["id"] == rid), rid)


def _stage_text(L, w):
    st = L["credit"]["stage"][w]
    return f"Stage {st} ({STAGE_WORD.get(L['credit']['stageReason'][w], L['credit']['stageReason'][w])})"


def _ecl_stage_compare(a, L, w):
    """Base-scenario ECL at week w if the loan were Stage 1 (12-month) vs Stage 2 (lifetime), same PD and LGD."""
    snap = date.fromisoformat(a["meta"].get("snapshotDate") or a["meta"]["weeks"][a["meta"]["asOfDefault"]])
    sch = ifrs9.Schedule(L, snap)
    pd12, lgd = L["credit"]["pd12"][w], L["credit"]["lgd"][w]
    full = lambda v: np.full(C.W, v, float)
    e1, p1 = ifrs9.ecl_paths(sch, full(pd12), full(lgd), np.full(C.W, 1))
    e2, p2 = ifrs9.ecl_paths(sch, full(pd12), full(lgd), np.full(C.W, 2))
    return float(e1[w]), float(e2[w]), float(p1[w]), float(p2[w])


def _risk_chip(doc, x, y, level):
    return doc.chip(x, y, level.upper(), LEVEL_COL[level])


def _spi_series(L, key):
    return [np.nan if v is None else v for v in L[key]]


def _yield_expect(L, w):
    base = L["expectedYieldTHa"]
    return [base * (1 + L["yield"][k][w]) if L["yield"][k][w] is not None else None for k in ("p10", "p50", "p90")]


def _revenue(a, L, w):
    price = a["meta"]["crops"][L["crop"]]["price"]
    y10, y50, y90 = _yield_expect(L, w)
    return {k: (v * L["areaHa"] * price if v is not None else None) for k, v in (("p10", y10), ("p50", y50), ("p90", y90))}, price


def _remaining_due(L, w, a):
    asof = a["meta"]["weeks"][w]
    rows = [r for r in L["schedule"] if not r.get("paidDate") and r["date"] >= asof or (not r.get("paidDate") and r["date"] < asof)]
    return rows, sum(r["principal"] + r["interest"] for r in rows)


def _month_axis(a, ax, w=None):
    weeks = a["meta"]["weeks"]
    idx = [i for i, d in enumerate(weeks) if int(d[8:10]) <= 7]
    ax.set_xticks(idx); ax.set_xticklabels([mon_label(weeks[i]) for i in idx])
    ax.set_xlim(0, C.W - 1)


# ------------------------------------------------------------------------------------------------ charts
def _chart_exposure(a, w):
    pf = a["portfolio"]; x = np.arange(C.W)

    def draw(ax):
        ys = [np.array(pf["byLevel"][lv], float) / 1e6 for lv in C.LEVELS]
        ax.stackplot(x, *ys, colors=[LEVEL_COL[l] for l in C.LEVELS], labels=C.LEVELS, alpha=0.9, lw=0)
        ax.axvline(w, color=INK, lw=1.2, ls="--")
        ax.text(w + 0.5, ax.get_ylim()[1] * 0.97, "as of", fontsize=6.5, va="top")
        ax.axvspan(w, C.W - 1, color="white", alpha=0.45, lw=0)
        ax.set_ylabel("EAD, USD million", fontsize=7, color=MUTED)
        ax.legend(fontsize=6.5, ncol=4, frameon=False, loc="upper left")
        _month_axis(a, ax)
    return draw


def _chart_stress(a):
    st = a["stressTest"]

    def draw(ax):
        years = st["years"]; loss = np.array(st["loss"]) / 1e6
        cols = [LEVEL_COL["Severe"] if y == st["worstYear"] else "#9ccfda" for y in years]
        ax.bar(range(len(years)), loss, color=cols, width=0.75)
        ax.axhline(st["p95"] / 1e6, color=INK, lw=1.1, ls="--"); ax.text(0, st["p95"] / 1e6, f" p95 {st['p95'] / 1e6:.2f}M", fontsize=6.8, va="bottom", fontweight="bold")
        if st.get("currentLoss"):
            ax.axhline(st["currentLoss"] / 1e6, color=FERN, lw=1.4); ax.text(len(years) - 1, st["currentLoss"] / 1e6, f"this season {st['currentLoss'] / 1e6:.2f}M ", fontsize=6.8, ha="right", va="bottom", color="#1f4e6e", fontweight="bold")
        ax.set_xticks(range(len(years))); ax.set_xticklabels([f"{str(y)[2:]}/{str(y + 1)[2:]}" for y in years], rotation=90)
        ax.set_ylabel("Expected loss, USD million", fontsize=7, color=MUTED)
    return draw


def _chart_region(a, w):
    book = _in_book(a, w)
    rows = []
    for r in a["meta"]["regions"]:
        ls = [l for l in book if l["regionId"] == r["id"]]
        if ls:
            rows.append((r["name"], sum(l["credit"]["ead"][w] for l in ls), sum(l["credit"]["ead"][w] for l in ls if l["level"][w] in ("High", "Severe"))))
    rows.sort(key=lambda t: t[1])

    def draw(ax):
        ax.barh([r[0] for r in rows], [r[1] / 1e6 for r in rows], color="#cfe9ec", label="Exposure")
        ax.barh([r[0] for r in rows], [r[2] / 1e6 for r in rows], color=LEVEL_COL["High"], label="of which High/Severe")
        ax.tick_params(axis="y", labelsize=6.5); ax.set_xlabel("EAD, USD million", fontsize=7, color=MUTED)
        ax.legend(fontsize=6.5, frameon=False, loc="lower right")
    return draw


# ================================================================================================ PORTFOLIO
def _portfolio(a, w):
    doc = Doc("IFRS 9 climate provision report", a, w)
    pf, meta = a["portfolio"], a["meta"]
    book = _in_book(a, w)
    ead = sum(l["credit"]["ead"][w] for l in book)
    sev_ead = pf["byLevel"]["High"][w] + pf["byLevel"]["Severe"][w]
    bank, wtd = pf["eclBank"][w], pf["ecl"]["weighted"][w]
    st = a["stressTest"]
    n2 = sum(1 for l in book if l["credit"]["stage"][w] == 2); n3 = sum(1 for l in book if l["credit"]["stage"][w] == 3)
    doc.title_block("IFRS 9 climate provision report", f"{meta['lender']} · season {meta['season']} · as of {fmt_date(doc.asof)} (week {w}). "
                    "Expected credit loss with a climate overlay, compared with the bank's own baseline (PD and LGD at origination).")
    doc.kpis([
        ("Loans in the book", f"{len(book)}", f"of {len(a['loans'])} in the file"),
        ("Outstanding (EAD)", usd(ead, True), usd(ead)),
        ("Exposure High/Severe", usd(sev_ead, True), f"{pct(sev_ead / ead if ead else 0)} of EAD", LEVEL_COL["High"]),
        ("Stage 2 / Stage 3 loans", f"{n2} / {n3}", "IFRS 9 staging", LEVEL_COL["Watch"]),
        ("ECL, bank baseline", usd(bank, True), usd(bank)),
        ("ECL, climate-weighted", usd(wtd, True), usd(wtd), FERN),
        ("Provision change", sgn_usd(wtd - bank), f"{spct(wtd / bank - 1 if bank else None)} vs bank", LEVEL_COL["Severe"]),
        ("1-in-20 loss (p95)", usd(st["p95"], True), "historical replay"),
    ])
    doc.heading("ECL by scenario")
    sc = meta["scenarios"]
    rows = [["Bank baseline (PD, LGD at origination)", "-", usd(bank), "-"]]
    for k in ("base", "adverse", "severe"):
        v = pf["ecl"][k][w]
        rows.append([f"Climate: {k}", pct(sc[k], 0), usd(v), spct(v / bank - 1 if bank else None)])
    rows.append(["Climate: probability-weighted", "100%", usd(wtd), spct(wtd / bank - 1 if bank else None)])
    doc.table(["Scenario", "Weight", "ECL (USD)", "vs bank"], rows, [4, 1, 1.6, 1.2], aligns=["l", "r", "r", "r"], bold_last=True)
    doc.heading("ECL by IFRS 9 stage")
    rows = []
    for s in (1, 2, 3):
        ls = [l for l in book if l["credit"]["stage"][w] == s]
        e = lambda k: sum(l["credit"]["ecl"][k][w] for l in ls)
        rows.append([f"Stage {s} " + {1: "(12-month ECL)", 2: "(lifetime ECL)", 3: "(credit-impaired)"}[s], len(ls), usd(sum(l["credit"]["ead"][w] for l in ls)),
                     usd(sum(l["credit"]["eclBank"][w] for l in ls)), usd(e("base")), usd(e("adverse")), usd(e("severe")), usd(e("weighted"))])
    doc.table(["Stage", "Loans", "EAD", "ECL bank", "Base", "Adverse", "Severe", "Weighted"], rows, [2.3, 0.8, 1.4, 1.2, 1.2, 1.2, 1.2, 1.3], aligns=["l"] + ["r"] * 7)
    doc.heading("Exposure by stress level over the season")
    doc.chart(2.5, _chart_exposure(a, w))
    # page 2
    doc.new_page()
    doc.heading("Concentration by region")
    doc.chart(2.9, _chart_region(a, w))
    rows = []
    for c in meta["crops"]:
        ls = [l for l in book if l["crop"] == c]
        if ls:
            e = sum(l["credit"]["ead"][w] for l in ls); s = sum(l["credit"]["ead"][w] for l in ls if l["level"][w] in ("High", "Severe"))
            rows.append([meta["crops"][c]["label"], len(ls), usd(e), usd(s), pct(s / e if e else 0), usd(sum(l["credit"]["ecl"]["weighted"][w] - l["credit"]["eclBank"][w] for l in ls))])
    doc.heading("Concentration by crop")
    doc.table(["Crop", "Loans", "EAD", "High/Severe EAD", "Share stressed", "Provision change"], rows, [1.6, 0.8, 1.4, 1.5, 1.2, 1.5], aligns=["l"] + ["r"] * 5)
    doc.heading("Clusters of stressed loans (DBSCAN, 60 km)")
    cl = sorted(pf["clusters"][w], key=lambda c: -c["ead"])[:10]
    rows = []
    for c in cl:
        regs = {}
        for lid in c["loanIds"]:
            r = _loan(a, lid)["regionId"]; regs[r] = regs.get(r, 0) + 1
        top = max(regs, key=regs.get)
        rows.append([f"#{c['id']}", len(c["loanIds"]), _region_name(a, top) + (" +" if len(regs) > 1 else ""), usd(c["ead"]), f"{c['meanScore']:.0f}", f"{c['radiusKm']:.0f} km"])
    doc.table(["Cluster", "Loans", "Main region", "EAD", "Mean score", "Radius"], rows or [["-", "-", "no clusters at this date", "-", "-", "-"]], [0.8, 0.7, 3, 1.4, 1, 0.9], aligns=["l", "r", "l", "r", "r", "r"])
    doc.heading("Loans with the largest provision change")
    top = sorted(book, key=lambda l: -(l["credit"]["ecl"]["weighted"][w] - l["credit"]["eclBank"][w]))[:10]
    rows = [[l["id"], l["borrower"], l["crop"], (l["level"][w], LEVEL_COL[l["level"][w]]), f"Stage {l['credit']['stage'][w]}", usd(l["credit"]["ead"][w]),
             sgn_usd(l["credit"]["ecl"]["weighted"][w] - l["credit"]["eclBank"][w])] for l in top]
    doc.table(["Loan", "Borrower", "Crop", "Level", "Stage", "EAD", "Change"], rows, [0.8, 2.6, 0.9, 0.9, 0.8, 1.2, 1.2], aligns=["l", "l", "l", "l", "l", "r", "r"])
    # page 3
    doc.new_page()
    doc.heading("Stress test: today's book replayed through past seasons")
    doc.chart(2.6, _chart_stress(a))
    doc.table(["Measure", "Expected loss (USD)", "% of EAD"], [
        ["Median season (p50)", usd(st["p50"]), pct(st["p50"] / ead if ead else 0)],
        ["1-in-20 years (p95)", usd(st["p95"]), pct(st["p95"] / ead if ead else 0)],
        ["99th percentile", usd(st["p99"]), pct(st["p99"] / ead if ead else 0)],
        [f"Worst season ({st['worstYear']}/{str(st['worstYear'] + 1)[2:]})", usd(max(st["loss"])), pct(max(st["loss"]) / ead if ead else 0)],
        ["This season (base scenario)", usd(st.get("currentLoss")), pct((st.get("currentLoss") or 0) / ead if ead else 0)]], [3, 1.8, 1.2], aligns=["l", "r", "r"])
    doc.para(st["note"], 7.5, color=MUTED, style="italic")
    doc.heading("Methods and caveats")
    p = meta["params"]
    for k, v in meta["methods"].items():
        if k in ("ifrs9", "stress", "portfolio", "yield_impact", "anomalies", "alerts"):
            doc.para(f"{k.replace('_', ' ')}: {v}", 8, bullet="•", after=0.04)
    doc.para(f"Parameters: beta {p['beta']} (logit PD per unit of yield loss), SICR multiplier {p['sicrMultiplier']}x, discount rate {p['discountRate']:.0%}, scenario weights "
             f"{', '.join(f'{k} {v:.0%}' for k, v in sc.items())}, hysteresis up {p['hysteresis']['up']} down {p['hysteresis']['down']}.", 8, after=0.08)
    doc.callout("Basis: provisions follow IFRS 9. The beta, the SICR multiplier, the scenario weights and the PD-by-rating and LGD-by-collateral tables "
                "can be calibrated to your own repayment history.", LEVEL_COL["Watch"], 8.5)
    return doc.finish()


# ================================================================================================ EARLY WARNING
def _early_warning(a, w, ids):
    doc = Doc("Early-warning report", a, w)
    loans = {l["id"]: l for l in a["loans"]}
    rows = []
    if ids:
        bad = [i for i in ids if i not in loans]
        if bad:
            raise ValueError(f"unknown loan id(s): {', '.join(bad)}")
        for i in ids:
            L = loans[i]
            al = [x for x in a["alerts"] if x["loanId"] == i and x["week"] <= w]
            al = max(al, key=lambda x: x["week"]) if al else None
            rows.append((L, al))
        scope = f"{len(ids)} loans selected"
    else:
        best = {}
        for x in a["alerts"]:
            if w - 3 <= x["week"] <= w and x["kind"] != "better":
                cur = best.get(x["loanId"])
                if cur is None or (x["week"], x["score"]) > (cur["week"], cur["score"]):
                    best[x["loanId"]] = x
        rows = [(loans[i], x) for i, x in best.items()]
        scope = f"alerts raised in the last 4 weeks (weeks {max(0, w - 3)} to {w})"
    rows.sort(key=lambda t: -t[0]["score"][w])
    improved = len({x["loanId"] for x in a["alerts"] if w - 3 <= x["week"] <= w and x["kind"] == "better"}) if not ids else 0
    doc.title_block("Early-warning report", f"{a['meta']['lender']} · as of {fmt_date(doc.asof)} (week {w}) · {scope}. Ranked by stress score.")
    ead = sum(L["credit"]["ead"][w] for L, _ in rows)
    sev = sum(1 for L, _ in rows if L["level"][w] == "Severe")
    nocover = sum(1 for L, _ in rows if not (L["insurance"] and _peril(L, w)[1] in L["insurance"]["perils"]))
    acts = {}
    for L, _ in rows:
        r = alerts_mod.recommend(L, w)["action"]; acts[r] = acts.get(r, 0) + 1
    doc.kpis([("Loans listed", str(len(rows)), "", FERN), ("Now Severe", str(sev), "", LEVEL_COL["Severe"]), ("Outstanding", usd(ead, True), usd(ead)),
              ("No cover for main peril", str(nocover), "uninsured or other peril", LEVEL_COL["High"])])
    doc.para("Recommended actions: " + "; ".join(f"{k} ({v})" for k, v in sorted(acts.items(), key=lambda t: -t[1])) + (f". {improved} other loan(s) improved in the period." if improved else "."), 8.3, color=MUTED)
    doc.para("Crop Health Index (CHI v1); display indicator, not used in PD. Shown per loan as CHI (0-100, 50 = typical for the field and date; under 25 severely stressed, under 10 extreme); blank outside the crop season.", 7.3, color=MUTED, style="italic")
    MAXN = 45
    if len(rows) > MAXN:
        doc.para(f"Showing the {MAXN} highest-scoring of {len(rows)} loans.", 8, color=MUTED, style="italic")
    if not rows:
        doc.callout("No alerts in this period.", FERN)
    for L, al in rows[:MAXN]:
        lv = L["level"][w]
        expl = al["explanation"] if al else alerts_mod.explain(L, w)
        rec = al["recommendation"] if al else alerts_mod.recommend(L, w)
        pl, pk, _ = _peril(L, w)
        ex_lines = wrap(expl, CW - 0.3, 7.6)
        rc_lines = wrap(f"Recommended action: {rec['action']}. {rec['why']}", CW - 0.3, 7.6, False)
        h = 0.42 + (len(ex_lines) + len(rc_lines)) * 7.6 * 1.35 / 72 + 0.12
        doc.need(h + 0.1)
        y0 = doc.y
        doc.ax.add_patch(Rectangle((MX, y0), CW, h, fc="white", ec=LINE, lw=0.6))
        doc.ax.add_patch(Rectangle((MX, y0), 0.07, h, fc=LEVEL_COL[lv], lw=0))
        doc.text(MX + 0.17, y0 + 0.07, f"{L['id']} · {L['borrower']}", 9, "bold")
        doc.text(MX + 0.17, y0 + 0.24, f"{L['region']} · {L['crop']} · {usd(L['credit']['ead'][w])} outstanding · main peril {pl} · "
                 f"{'insured (' + L['insurance']['type'] + ')' if L['insurance'] else 'no insurance'}"
                 + (f" · CHI {L['fhi'][w]:.0f}" if L.get("fhi") and L["fhi"][w] is not None else ""), 7.3, color=MUTED)
        chg = f"{al['from']} → {al['to']} ({al['kind']}, wk {al['week']})" if al else f"{lv} (no change in the period)"
        doc.text(PW - MX - 0.1, y0 + 0.07, f"score {L['score'][w]:.0f}", 9, "bold", LEVEL_COL[lv], ha="right")
        doc.text(PW - MX - 0.1, y0 + 0.24, chg, 7.3, color=INK, ha="right")
        yy = y0 + 0.44
        for ln in ex_lines:
            doc.text(MX + 0.17, yy, ln, 7.6); yy += 7.6 * 1.35 / 72
        for i, ln in enumerate(rc_lines):
            doc.text(MX + 0.17, yy, ln, 7.6, "bold" if i == 0 else "normal", "#1f4e6e" if i == 0 else INK); yy += 7.6 * 1.35 / 72
        doc.y = y0 + h + 0.1
    return doc.finish()


# ================================================================================================ LOAN MEMO
def _chart_ndvi(a, L, w):
    ws, we = _window(a, L)

    def draw(ax):
        x = np.arange(C.W); c = L["clim"]
        ax.fill_between(x, c["p10"], c["p90"], color=FERN, alpha=0.22, lw=0, label="field p10-p90 (21 seasons)")
        ax.plot(x, c["mean"], color=MUTED, ls="--", lw=1, label="field mean")
        ax.axvspan(max(ws, 0), min(we, C.W - 1), color="#888888", alpha=0.22, lw=0, label="critical window")
        xs = x[:w + 1]
        ax.plot(xs, L["ndvi"][:w + 1], color=INK, lw=1.6, label="NDVI this season")
        ob = [(i, v) for i, v in enumerate(L["ndviObs"][:w + 1]) if v is not None]
        ax.scatter([o[0] for o in ob], [o[1] for o in ob], s=5, color=INK, zorder=3)
        ax.axvline(w, color=LEVEL_COL[L["level"][w]], lw=1.4)
        ax.text(w + 0.4, ax.get_ylim()[1], "as of", fontsize=6.5, va="top", color=LEVEL_COL[L["level"][w]], fontweight="bold")
        ax.set_ylabel("NDVI", fontsize=7, color=MUTED)
        ax.legend(fontsize=6, ncol=4, frameon=False, loc="upper left", bbox_to_anchor=(0, 1.16))
        _month_axis(a, ax)
    return draw


def _chart_rain(a, L, w):
    def draw(ax):
        x = np.arange(w + 1)
        ax.bar(x, L["rainWeek"][:w + 1], color="#5b9bd5", width=0.8, label="rain, mm/week")
        ax.plot(x, L["rainNormal"][:w + 1], color=INK, lw=1, label="normal")
        ax.set_ylabel("mm per week", fontsize=7, color=MUTED); ax.legend(fontsize=6, frameon=False, ncol=2, loc="upper center", bbox_to_anchor=(0.5, 1.14))
        _month_axis(a, ax); ax.set_xlim(0, C.W - 1)
    return draw


def _chart_spi(a, L, w):
    def draw(ax):
        x = np.arange(w + 1)
        for k, col in (("spi30", "#5b9bd5"), ("spi60", "#b8401a"), ("spi90", "#7a5ea8")):
            ax.plot(x, L[k][:w + 1], color=col, lw=1.3 if k == "spi60" else 0.9, label=k.upper().replace("SPI", "SPI-"))
        ax.axhline(-1.5, color=LEVEL_COL["High"], ls="--", lw=0.8); ax.axhline(-1, color=LEVEL_COL["Watch"], ls=":", lw=0.8); ax.axhline(0, color=LINE, lw=0.6)
        ax.set_ylabel("SPI (SD)", fontsize=7, color=MUTED); ax.legend(fontsize=6, frameon=False, ncol=3, loc="upper center", bbox_to_anchor=(0.5, 1.14))
        _month_axis(a, ax)
    return draw


def _chart_perils(L, w):
    def draw(ax):
        names = ["drought", "excess_water", "frost", "heat", "hail"]
        vals = [L["perils"][n][w] or 0 for n in names]
        ax.barh([n.replace("_", " ") for n in names][::-1], vals[::-1], color=[LEVEL_COL["Severe"] if v >= 70 else LEVEL_COL["High"] if v >= 45 else LEVEL_COL["Watch"] if v >= 25 else "#9ccfda" for v in vals][::-1])
        ax.set_xlim(0, 100); ax.set_xlabel("peril intensity 0-100", fontsize=7, color=MUTED); ax.tick_params(axis="y", labelsize=7)
    return draw


def _chart_yield(L, w):
    def draw(ax):
        yrs, t = L["yieldHistory"]["years"], L["yieldHistory"]["tHa"]
        an = {s["year"] for s in L["analogs"][w]}
        ax.bar(range(len(yrs)), t, color=["#de6f3a" if y in an else "#cfe9ec" for y in yrs], width=0.75)
        y10, y50, y90 = _yield_expect(L, w)
        n = len(yrs)
        ax.axhspan(y10, y90, xmin=0, xmax=1, color=FERN, alpha=0.18, lw=0)
        ax.axhline(y50, color="#1f4e6e", lw=1.4)
        ax.text(n - 0.5, y90, f"{C.SEASON_LABEL} expected p10-p90 {y10:.1f} to {y90:.1f}; p50 {y50:.1f}", fontsize=6.3, ha="right", va="bottom", color="#1f4e6e", fontweight="bold")
        ax.set_xticks(range(n)); ax.set_xticklabels([f"{str(y)[2:]}" for y in yrs], fontsize=6)
        ax.set_ylabel("yield, t/ha", fontsize=7, color=MUTED)
    return draw


def _credit_rows(L, w):
    cr = L["credit"]
    pd_now = cr["pd12"][w]
    return [
        ["PD 12-month", pct(L["pdOrig"], 2) + " (origination)", f"{pct(pd_now, 2)} ({pd_now / max(L['pdOrig'], 1e-9):.1f}x)"],
        ["IFRS 9 stage", "performing, Stage 1" if cr["stage"][w] != 3 or True else "", _stage_text(L, w)],
        ["LGD", pct(L["lgdBank"], 1), pct(cr["lgd"][w], 1) + (" (insurance trigger met)" if cr.get("insuranceMet") and cr["insuranceMet"][w] else "")],
        ["EAD", usd(cr["ead"][w]), usd(cr["ead"][w])],
        ["ECL base scenario", usd(cr["eclBank"][w]), usd(cr["ecl"]["base"][w])],
        ["ECL adverse scenario (yield p10)", "-", usd(cr["ecl"]["adverse"][w])],
        ["ECL severe scenario (worst analog)", "-", usd(cr["ecl"]["severe"][w])],
        ["ECL probability-weighted", usd(cr["eclBank"][w]), usd(cr["ecl"]["weighted"][w]) + f" ({sgn_usd(cr['ecl']['weighted'][w] - cr['eclBank'][w])})"],
    ]


def _loan_header(doc, L, w, title):
    lv = L["level"][w]
    doc.title_block(title, f"{L['id']} · {L['borrower']} · {L['region']}, {L['country']} · as of {fmt_date(doc.asof)} (week {w})")
    doc.y -= 0.12


def _loan_facts(doc, a, L, w):
    ins = L["insurance"]
    doc.kv([
        ("Loan / farmer", f"{L['id']} / {L['farmerId']}"), ("Borrower", L["borrower"]),
        ("Product", L["product"]), ("Amount and rate", f"{usd(L['amountUsd'])} at {L['ratePct']:.2f}% p.a."),
        ("Originated / maturity", f"{fmt_date(L['originated'])} / {fmt_date(L['maturity'])}"), ("Outstanding (EAD)", usd(L["credit"]["ead"][w])),
        ("Field", f"{L['crop']}, {L['areaHa']:.0f} ha{' (irrigated)' if L['irrigated'] else ''}; sown {fmt_date(L['sowing']['date'])}"), ("Crop stage now", f"{L['stage'][w]} (weight {L['stageWeight'][w]:.2f})"),
        ("Collateral", f"{L['collateral']}, {usd(L['collateralValue'])}"), ("BCRA / past due", f"{L['bcraSituacion']} / {L['daysPastDue']}"),
        ("Insurance", (f"{ins['type']}, perils: {', '.join(ins['perils'])}; sum insured {usd(ins['sumInsured'])}; cover {pct(ins['coverShare'], 0)}" + (f"; trigger: {ins['trigger']}" if ins['trigger'] else "")) if ins else "none on file"),
        ("Other-bank debt", usd(L["otherBankDebt"])),
    ])


def _fhi_block(doc, L, w):
    """Crop Health Index (CHI v1) table for a loan memo. Display indicator only; never used in PD / staging / ECL."""
    from . import fhi as fhi_mod
    doc.heading("Crop Health Index (CHI)")
    s_ = fhi_mod.summary(L, w)
    f1 = lambda v: "n/a (outside crop season)" if v is None else f"{v:.0f}"
    g = lambda v: "n/a" if v is None else f"{v:.1f}"
    now = f"{f1(s_['now'])} ({fhi_mod.label(s_['now'])}{', partial' if s_.get('partial') else ''})"
    doc.table(["CHI now", "Vegetation V", "Soil S", "Water adequacy W", C.SEASON_LABEL + " season / critical period", "Mean of past seasons"],
              [[now, f1(s_["vci"]), f1(s_["sm"]), f1(s_["wa"]), f"{g(s_['cur'])} / {g(s_.get('cur_crit'))}",
                f"{g(s_['past_mean'])} (worst {g(s_['worst'])}, {s_['worst_campaign'] or 'n/a'})"]], [1.6, 1.0, 1.0, 1.3, 1.7, 1.7], aligns=["l", "r", "r", "r", "r", "r"])
    doc.para("Crop Health Index (CHI v1, Sviana technical note): percentiles against this field's own past record for the same time of year; "
             "50 = typical. Bands: 60+ above normal, 40-60 normal, 25-40 stressed, 10-25 severely stressed, under 10 extreme. "
             "Shown for context; it does not change PD.", 7.3, color=MUTED, style="italic")


def _loan_memo(a, w, lid):
    L = _loan(a, lid)
    doc = Doc(f"Loan memo {lid}", a, w)
    lv = L["level"][w]
    doc.title_block(f"Loan memo: {L['borrower']}", f"{L['id']} · {L['region']}, {L['country']} · {L['crop']} · as of {fmt_date(doc.asof)} (week {w})")
    doc.y -= 0.1
    wd = _risk_chip(doc, MX, doc.y, lv)
    doc.text(MX + wd + 0.1, doc.y + 0.03, f"score {L['score'][w]:.0f}/100 · confidence {pct(L['confidence'][w], 0)} · {_stage_text(L, w)}", 8.5, color=INK)
    doc.y += 0.32
    _loan_facts(doc, a, L, w)
    doc.heading("Greenness (NDVI) against this field's own history")
    doc.chart(2.15, _chart_ndvi(a, L, w))
    doc.heading("Rainfall and standardised precipitation index")
    doc.charts_row(1.9, [_chart_rain(a, L, w), _chart_spi(a, L, w)], [1, 1])
    doc.need(2.6)
    doc.heading("Stress perils, drought cascade and confidence")
    pl, pk, pint = _peril(L, w)
    doc.charts_row(1.55, [_chart_perils(L, w)], [1])
    doc.para(f"Dominant peril: {pl} (intensity {pint:.0f}/100). Drought indicator chain: {L['cascade'][w]} (none, early = rain only, active = plus soil moisture, confirmed = plus greenness). "
             f"Confidence {pct(L['confidence'][w], 0)}: agreement of signals, location quality and share of cloud-free images ({pct(L['cloudFree'][w], 0)} this week).", 8.3)
    # page 2
    doc.new_page()
    doc.heading("Analog seasons and expected yield")
    an = L["analogs"][w]
    if an:
        rows = []
        for s in an:
            i = L["yieldHistory"]["years"].index(s["year"]) if s["year"] in L["yieldHistory"]["years"] else None
            rows.append([f"{s['year']}/{str(s['year'] + 1)[2:]}", f"{s['distance']:.2f}", spct(s["yieldAnom"]), f"{L['yieldHistory']['tHa'][i]:.2f} t/ha" if i is not None else "n/a"])
        doc.table(["Past season", "Distance", "Yield vs trend", "Yield"], rows, [2, 1, 1.4, 1.4], aligns=["l", "r", "r", "r"])
    else:
        doc.para("No analog seasons yet at this date (the season is too young to compare).", 8.5, color=MUTED)
    y10, y50, y90 = _yield_expect(L, w)
    doc.para(f"Expected {C.SEASON_LABEL} yield: p50 {y50:.2f} t/ha ({spct(L['yield']['p50'][w])} vs normal {L['expectedYieldTHa']:.2f}), p10 {y10:.2f} ({spct(L['yield']['p10'][w])}), p90 {y90:.2f} ({spct(L['yield']['p90'][w])}).", 8.5)
    doc.chart(1.9, _chart_yield(L, w))
    doc.para("Orange bars are the analog seasons; the blue band is the p10-p90 range of the regression for this season.", 7.3, color=MUTED, style="italic")
    doc.heading("Credit risk: bank baseline against climate-adjusted")
    doc.table(["Measure", "Bank baseline", "Climate-adjusted"], _credit_rows(L, w), [2.6, 1.8, 2.8], aligns=["l", "r", "r"], bold_last=True)
    if "fhi" in L:
        _fhi_block(doc, L, w)
    doc.heading("Explanation")
    doc.para(alerts_mod.explain(L, w), 9)
    rec = alerts_mod.recommend(L, w)
    doc.heading("Recommendation")
    doc.callout(rec["action"] + ".", LEVEL_COL[lv], 10.5)
    doc.para(rec["why"], 9)
    doc.para("Numbers are model output for a credit officer to review; no action is taken automatically.", 7.5, color=MUTED, style="italic")
    return doc.finish()


# ================================================================================================ ACTION DOCUMENTS
def _doc_head(doc, title, ref, L, to, subject):
    doc.title_block(title, None)
    doc.kv([("Reference", ref), ("Date", f"{doc.generated} (data as of {doc.asof}, week {doc.week})"), ("To", to), ("From", f"Credit Risk, {doc.a['meta']['lender']}"),
            ("Borrower", f"{L['borrower']} ({L['farmerId']})"), ("Loan", f"{L['id']} · {L['product']} · {usd(L['amountUsd'])}")], 2)
    doc.callout(subject, FERN, 9)


def _claim(a, w, lid):
    L = _loan(a, lid); ins = L["insurance"]
    if not ins:
        raise ValueError(f"loan {lid} has no insurance policy: a claim notice needs one (try cover_offer instead)")
    doc = Doc("Insurance claim notice", a, w)
    cr = L["credit"]; ead = cr["ead"][w]
    pl, pk, pint = _peril(L, w)
    ws, we = _window(a, L)
    met = bool(cr.get("insuranceMet") and cr["insuranceMet"][w])
    _doc_head(doc, "Insurance claim notice", f"LP-CLM-{L['id']}-W{w}", L, "The insurer (claims department)",
              f"Notice of loss under the {ins['type']} policy on field {L['fieldId']} ({L['crop']}, {L['areaHa']:.0f} ha). Trigger status: {'MET' if met else 'not yet met on the data available; notice filed to preserve the claim'}.")
    doc.heading("Policy and insured interest", 1)
    doc.kv([("Policy type", ins["type"]), ("Policy number", "______________ (insurer to confirm)"), ("Perils covered", ", ".join(ins["perils"])), ("Sum insured", usd(ins["sumInsured"])),
            ("Cover share", pct(ins["coverShare"], 0)), ("Trigger", ins["trigger"] or "damage-based (loss assessment)")])
    doc.heading("Event and measured evidence", 2)
    cw_names = " to ".join([_crit_stage_names(a, L["crop"])[0], _crit_stage_names(a, L["crop"])[-1]]) if _crit_stage_names(a, L["crop"]) else "critical window"
    doc.para(f"Main peril in the period: {pl} (intensity {pint:.0f}/100, drought chain '{cr and L['cascade'][w]}'). Critical window for {L['crop']} in this field: weeks {max(ws, 0)} to {min(we, C.W - 1)} "
             f"({fmt_date(a['meta']['weeks'][max(ws, 0)])} to {fmt_date(a['meta']['weeks'][min(we, C.W - 1)])}), {cw_names.lower()}.", 8.8)
    m = re.search(r"SPI-?(\d+)\s*<\s*(-?\d+\.?\d*)", ins.get("trigger") or "")
    rows = []
    if ins["type"] == "parametric" and m:
        key, thr = f"spi{m.group(1)}", float(m.group(2))
        seg = [(i, L[key][i]) for i in range(max(ws, 0), min(we, w) + 1)]
        below = [(i, v) for i, v in seg if v < thr]
        mn = min(seg, key=lambda t: t[1]) if seg else None
        first = below[0][0] if below else None
        rows = [[f"Trigger index SPI-{m.group(1)}", f"below {thr:g} in the window", ""],
                [f"Lowest SPI-{m.group(1)} in window to date", f"{mn[1]:.2f}" if mn else "n/a", f"week {mn[0]} ({a['meta']['weeks'][mn[0]]})" if mn else ""],
                ["Weeks below the threshold", str(len(below)), f"first crossing week {first} ({a['meta']['weeks'][first]})" if first is not None else "none"],
                ["SPI-30 / SPI-60 / SPI-90 at the as-of week", f"{L['spi30'][w]:.2f} / {L['spi60'][w]:.2f} / {L['spi90'][w]:.2f}", ""],
                ["Soil moisture percentile", f"{L['smPct'][w]:.0f}", ""], ["NDVI z-score vs field history", f"{L['ndviZ'][w]:.1f}", ""],
                ["Trigger met per the model", "YES" if met else "NO", ""]]
    else:
        pw = [i for i in range(0, w + 1) if any((L["perils"][p][i] or 0) >= 40 for p in ins["perils"] if p in L["perils"])]
        rows = [["Weeks with a covered peril at intensity 40+", str(len(pw)), f"first week {pw[0]} ({a['meta']['weeks'][pw[0]]})" if pw else "none"],
                ["Peak intensity of covered perils to date", f"{max([(L['perils'][p][i] or 0) for p in ins['perils'] if p in L['perils'] for i in range(w + 1)] + [0]):.0f}/100", ""],
                ["Expected yield vs normal (p50 / p10)", f"{spct(L['yield']['p50'][w])} / {spct(L['yield']['p10'][w])}", ""],
                ["SPI-60 / NDVI z-score", f"{L['spi60'][w]:.2f} / {L['ndviZ'][w]:.1f}", ""], ["Cover active per the model", "YES" if met else "NO", ""]]
    doc.table(["Evidence", "Value", "Detail"], rows, [3.2, 1.6, 2.6], aligns=["l", "r", "l"])
    doc.heading("Estimated payout", 3)
    if ins["type"] == "parametric":
        pay = ins["coverShare"] * ins["sumInsured"]
        doc.para(f"Parametric contract: once the trigger is met the payout is the cover share times the sum insured = {pct(ins['coverShare'], 0)} x {usd(ins['sumInsured'])} = {usd(pay)}. No loss adjustment is required.", 8.8)
        lo = hi = pay
    else:
        p10l, p50l, p90l = [max(0, -L["yield"][k][w]) for k in ("p10", "p50", "p90")]
        pay = ins["coverShare"] * ins["sumInsured"] * p50l
        lo, hi = ins["coverShare"] * ins["sumInsured"] * p90l, ins["coverShare"] * ins["sumInsured"] * p10l
        doc.para(f"Loss-based contract: estimated payout = cover share x sum insured x expected yield loss = {pct(ins['coverShare'], 0)} x {usd(ins['sumInsured'])} x {pct(p50l, 0)} (p50) = {usd(pay)} "
                 f"(range {usd(lo)} to {usd(hi)} for yield loss {pct(p90l, 0)} to {pct(p10l, 0)}). The insurer's loss adjustment prevails.", 8.8)
    doc.heading("Assignment of proceeds to the loan", 4)
    doc.para(f"The policyholder assigns the proceeds of this claim to {a['meta']['lender']} for the repayment of loan {L['id']}. The insurer is asked to pay the indemnity directly to the bank's loan account.", 8.8)
    doc.table(["Loan balance", "USD"], [["Outstanding balance now (EAD)", usd(ead)], ["Estimated payout routed to the loan", f"- {usd(pay)}"],
                                         ["Remaining balance after payout (estimate)", usd(max(0, ead - pay))]], [4, 2], aligns=["l", "r"], bold_last=True)
    doc.heading("Documents attached / to follow", 5)
    for s in ("Policy certificate and the latest premium receipt.", "Satellite and rainfall evidence extract (this notice, section 2).", "Field boundary and sowing declaration.", "Borrower's written authorisation and assignment of proceeds."):
        doc.para(s, 8.6, bullet="•", after=0.02)
    doc.heading("Signatures", 6)
    doc.signatures(["Credit officer", "Borrower (policyholder)", "Insurer (receipt)"])
    return doc.finish()


def _next_harvest(a, L):
    st = L["stage"]
    idx = next((i for i, s in enumerate(st) if s in ("Harvest-ready", "Dry-down", "Harvested")), None)
    d0 = date.fromisoformat(a["meta"]["weeks"][idx]) if idx is not None else date.fromisoformat(L["maturity"])
    return d0 + timedelta(days=364)


def _restructure(a, w, lid):
    L = _loan(a, lid)
    doc = Doc("Restructuring proposal", a, w)
    cr = L["credit"]; ead = cr["ead"][w]; rate = L["ratePct"] / 100
    rows, due = _remaining_due(L, w, a)
    rev, price = _revenue(a, L, w)
    y10, y50, y90 = _yield_expect(L, w)
    new_mat = max(_next_harvest(a, L), date.fromisoformat(L["maturity"]) + timedelta(days=90))
    _doc_head(doc, "Restructuring proposal", f"LP-RST-{L['id']}-W{w}", L, "Credit Committee",
              f"Proposal to extend the maturity of loan {L['id']} to {fmt_date(new_mat.isoformat())} (next harvest), with interest-only payments until then.")
    doc.heading("Current position", 1)
    doc.kv([("Outstanding principal", usd(ead)), ("Stress level / score", f"{L['level'][w]} / {L['score'][w]:.0f}"), ("IFRS 9 stage", _stage_text(L, w)), ("Current maturity", fmt_date(L["maturity"])),
            ("Days past due", str(L["daysPastDue"])), ("Remaining scheduled debt service", usd(due))])
    cur = [[fmt_date(r["date"]), usd(r["principal"]), usd(r["interest"]), usd(r["principal"] + r["interest"]), "paid" if r.get("paidDate") else "unpaid"] for r in sorted(L["schedule"], key=lambda r: r["date"])]
    doc.table(["Due date", "Principal", "Interest", "Total", "Status"], cur[:12], [1.6, 1.4, 1.4, 1.4, 1], aligns=["l", "r", "r", "r", "l"])
    doc.heading("Rationale: repayment capacity at the expected yield", 2)
    cov = lambda r: (r / due) if due and r is not None else None
    doc.table(["Yield case", "t/ha", f"Revenue at {usd(price)}/t", "Remaining debt service", "Coverage"], [
        ["p50 (expected)", f"{y50:.2f}", usd(rev["p50"]), usd(due), (f"{cov(rev['p50']):.2f}x", LEVEL_COL["Severe"] if cov(rev["p50"]) < 1 else LEVEL_COL["Normal"])],
        ["p10 (bad draw)", f"{y10:.2f}", usd(rev["p10"]), usd(due), (f"{cov(rev['p10']):.2f}x", LEVEL_COL["Severe"] if cov(rev["p10"]) < 1 else LEVEL_COL["Normal"])],
        ["normal season", f"{L['expectedYieldTHa']:.2f}", usd(L["expectedYieldTHa"] * L["areaHa"] * price), usd(due), f"{L['expectedYieldTHa'] * L['areaHa'] * price / due:.2f}x" if due else "n/a"]],
        [1.6, 0.8, 1.7, 1.8, 1.0], aligns=["l", "r", "r", "r", "r"])
    doc.para(f"Revenue = area {L['areaHa']:.0f} ha x expected yield x price. Coverage is revenue divided by the remaining debt service of the loan, before the borrower's other costs"
             f"{'; other-bank debt ' + usd(L['otherBankDebt']) + ' reduces it further' if L['otherBankDebt'] else ''}. Expected yield {spct(L['yield']['p50'][w])} vs normal (analog seasons: "
             f"{', '.join(str(s['year']) for s in L['analogs'][w]) or 'n/a'}).", 8.3, color=MUTED)
    doc.heading("Proposed schedule", 3)
    qs, d, prop = [], date.fromisoformat(a["meta"]["weeks"][w]), []
    t = d
    while True:
        t = t + timedelta(days=91)
        if t >= new_mat:
            break
        prop.append((t, 0.0, ead * rate * 91 / 365))
    last_int = ead * rate * max(1, (new_mat - (prop[-1][0] if prop else d)).days) / 365
    prop.append((new_mat, ead, last_int))
    rowsp = [[fmt_date(x.isoformat()), usd(p), usd(i), usd(p + i)] for x, p, i in prop]
    rowsp.append(["Total", usd(sum(p for _, p, _ in prop)), usd(sum(i for _, _, i in prop)), usd(sum(p + i for _, p, i in prop))])
    doc.table(["Due date", "Principal", "Interest (quarterly, on outstanding)", "Total"], rowsp, [1.6, 1.4, 2.6, 1.4], aligns=["l", "r", "r", "r"], bold_last=True)
    doc.para(f"New maturity {fmt_date(new_mat.isoformat())} (about {(new_mat - date.fromisoformat(L['maturity'])).days // 30} months after the current one); interest-only until then, principal repaid from the next harvest. "
             f"Rate unchanged at {L['ratePct']:.2f}%. Collateral ({L['collateral']}, {usd(L['collateralValue'])}) to be confirmed or extended; insurance to be renewed for the next season.", 8.8)
    doc.heading("Conditions and approvals", 4)
    for s in ("Renewal of agricultural cover for the next season (parametric offer available).", "Updated field declaration and sowing plan.", "Collateral extension registered before the first disbursement date.", "Stage review at each quarter: a restructuring keeps the loan in Stage 2 until performance is demonstrated (IFRS 9)."):
        doc.para(s, 8.6, bullet="•", after=0.02)
    doc.signatures(["Credit officer", "Credit Committee", "Borrower"])
    return doc.finish()


def _downgrade(a, w, lid):
    L = _loan(a, lid)
    doc = Doc("Stage 2 transfer memo", a, w)
    cr = L["credit"]; pd_now, pd0 = cr["pd12"][w], L["pdOrig"]
    first_sev = next((i for i in range(w + 1) if L["level"][i] == "Severe"), None)
    al = [x for x in a["alerts"] if x["loanId"] == L["id"] and x["week"] <= w and x["to"] in ("Severe", "High")]
    last_al = max(al, key=lambda x: x["week"]) if al else None
    e1, e2, p1, p2 = _ecl_stage_compare(a, L, w)
    stage = cr["stage"][w]
    _doc_head(doc, "Stage 2 transfer memo (significant increase in credit risk)", f"LP-S2-{L['id']}-W{w}", L, "Provisioning Committee",
              f"Transfer of loan {L['id']} from Stage 1 to Stage 2 (lifetime ECL). Current model stage: {stage} ({STAGE_WORD.get(cr['stageReason'][w], cr['stageReason'][w])}).")
    doc.heading("SICR evidence", 1)
    ratio = pd_now / max(pd0, 1e-9)
    doc.table(["Test", "Threshold", "Observed", "Result"], [
        ["PD 12-month now vs origination", f"at least {a['meta']['params']['sicrMultiplier']:.1f}x", f"{pct(pd0, 2)} to {pct(pd_now, 2)} ({ratio:.1f}x)", ("MET" if ratio >= a["meta"]["params"]["sicrMultiplier"] else "not met", LEVEL_COL["Severe"] if ratio >= a["meta"]["params"]["sicrMultiplier"] else LEVEL_COL["Normal"])],
        ["Critical climate alert (level Severe)", "level Severe", f"{L['level'][w]} (score {L['score'][w]:.0f})", ("MET" if L["level"][w] == "Severe" else "not met", LEVEL_COL["Severe"] if L["level"][w] == "Severe" else LEVEL_COL["Normal"])],
        ["Days past due / BCRA situacion", "30+ days or situacion 2+", f"{L['daysPastDue']} days / situacion {L['bcraSituacion']}", "MET" if L["daysPastDue"] > 30 or L["bcraSituacion"] >= 2 else "not met"],
    ], [2.6, 1.6, 2.3, 0.9], aligns=["l", "l", "l", "l"])
    doc.para(f"First week at level Severe: {('week %d (%s)' % (first_sev, a['meta']['weeks'][first_sev])) if first_sev is not None else 'never in this season'}. "
             + (f"Latest alert: {last_al['from']} to {last_al['to']} in week {last_al['week']} ({a['meta']['weeks'][last_al['week']]}), score {last_al['score']:.0f}. " if last_al else "")
             + f"Expected yield {spct(L['yield']['p50'][w])} vs normal (p10 {spct(L['yield']['p10'][w])}). Main signals: SPI-60 {L['spi60'][w]:.1f}, soil moisture percentile {L['smPct'][w]:.0f}, NDVI z {L['ndviZ'][w]:.1f}.", 8.8)
    doc.para(alerts_mod.explain(L, w), 8.4, color=MUTED)
    doc.heading("Effect on expected credit loss", 2)
    doc.table(["Basis (base scenario, same PD and LGD)", "Horizon", "PD", "ECL (USD)"], [
        ["Stage 1: 12-month ECL", "12 months", pct(p1, 2), usd(e1)], ["Stage 2: lifetime ECL (incl. assumed 1-year restructuring)", "to maturity + 12 months", pct(p2, 2), usd(e2)],
        ["Increase from the transfer", "", "", sgn_usd(e2 - e1)]], [3.6, 1.8, 0.9, 1.3], aligns=["l", "l", "r", "r"], bold_last=True)
    doc.para(f"Model ECL now: bank baseline {usd(cr['eclBank'][w])}; climate-weighted {usd(cr['ecl']['weighted'][w])} (base {usd(cr['ecl']['base'][w])}, adverse {usd(cr['ecl']['adverse'][w])}, severe {usd(cr['ecl']['severe'][w])}). "
             f"EAD {usd(cr['ead'][w])}, LGD {pct(cr['lgd'][w], 1)}.", 8.6)
    doc.heading("Proposed accounting treatment", 3)
    doc.table(["Item", "Amount (USD)"], [["ECL as Stage 1 (12-month, base scenario)", usd(e1)], ["ECL as Stage 2 (lifetime, base scenario)", usd(e2)],
                                          ["Additional provision from the transfer (base)", sgn_usd(e2 - e1)],
                                          ["Climate-weighted ECL after transfer (3 scenarios)", usd(cr["ecl"]["weighted"][w])]], [4.5, 2], aligns=["l", "r"], bold_last=False)
    doc.heading("Decision requested", 4)
    doc.para(("Approve the transfer to Stage 2 effective " + fmt_date(doc.asof) + " and book the additional provision above.") if stage != 1 else
             "The model currently keeps the loan in Stage 1; this memo documents the evidence for a judgemental (overlay) transfer to Stage 2 if the committee agrees.", 8.8)
    doc.para("Return to Stage 1: only after the SICR conditions have cleared (level below Severe, PD under 2x origination, no arrears) and a probation period without new alerts. "
             "Stage 3 is not proposed" + ("" if stage != 3 else " (the loan is already credit-impaired; this memo records the climate evidence)") + ": Stage 3 requires default (more than 90 days past due or BCRA situacion 3+).", 8.4, color=MUTED)
    doc.heading("Approval and sign-off", 5)
    doc.approval(["Credit risk officer (preparer)", "Provisioning Committee", "Chief Risk Officer"])
    return doc.finish()


def _transfer(a, w, lid):
    L = _loan(a, lid)
    doc = Doc("Loan transfer memo", a, w)
    cr = L["credit"]; ead = cr["ead"][w]
    cl = _cluster_of(a, L, w)
    book = _in_book(a, w); tot = sum(l["credit"]["ead"][w] for l in book)
    reg = [l for l in book if l["regionId"] == L["regionId"]]
    reg_ead = sum(l["credit"]["ead"][w] for l in reg); reg_st = sum(l["credit"]["ead"][w] for l in reg if l["level"][w] in ("High", "Severe"))
    crop_ead = sum(l["credit"]["ead"][w] for l in book if l["crop"] == L["crop"])
    rate = {k: cr["ecl"][k][w] / ead if ead else 0 for k in ("base", "adverse", "severe", "weighted")}
    _doc_head(doc, "Loan sale / transfer memo", f"LP-TRF-{L['id']}-W{w}", L, "Credit Committee and Treasury",
              f"Proposal to sell or transfer loan {L['id']} ({usd(ead)} outstanding) to a third party at an indicative price of {usd(ead * (1 - rate['base']))} to {usd(ead * (1 - rate['adverse']))} (base to adverse expected loss).")
    doc.heading("Why transfer", 1)
    pts = [f"Climate stress: level {L['level'][w]} (score {L['score'][w]:.0f}), expected yield {spct(L['yield']['p50'][w])} vs normal; {_stage_text(L, w)}.",
           f"Region concentration: {L['region']} holds {usd(reg_ead)} ({pct(reg_ead / tot if tot else 0)} of the book), of which {usd(reg_st)} ({pct(reg_st / reg_ead if reg_ead else 0, 0)}) is High/Severe."
           f" Crop concentration: {L['crop']} is {pct(crop_ead / tot if tot else 0)} of the book."]
    if cl:
        pts.append(f"The loan sits in a spatial cluster of {len(cl['loanIds'])} stressed loans ({usd(cl['ead'])}, mean score {cl['meanScore']:.0f}, radius {cl['radiusKm']:.0f} km): a regional shock hits them together.")
    pts.append(f"Weak recovery: collateral {L['collateral']} {usd(L['collateralValue'])} against EAD {usd(ead)}; insurance: " + (f"{L['insurance']['type']} covering {', '.join(L['insurance']['perils'])}." if L["insurance"] else "none."))
    for p in pts:
        doc.para(p, 8.8, bullet="•", after=0.03)
    doc.heading("Provisions and indicative price", 2)
    doc.table(["Basis", "ECL (USD)", "Expected loss rate", "Indicative price = EAD x (1 - rate)"], [
        ["Bank baseline", usd(cr["eclBank"][w]), pct(cr["eclBank"][w] / ead if ead else 0), usd(ead * (1 - (cr["eclBank"][w] / ead if ead else 0)))],
        ["Climate: base", usd(cr["ecl"]["base"][w]), pct(rate["base"]), usd(ead * (1 - rate["base"]))],
        ["Climate: adverse", usd(cr["ecl"]["adverse"][w]), pct(rate["adverse"]), usd(ead * (1 - rate["adverse"]))],
        ["Climate: severe", usd(cr["ecl"]["severe"][w]), pct(rate["severe"]), usd(ead * (1 - rate["severe"]))],
        ["Climate: weighted", usd(cr["ecl"]["weighted"][w]), pct(rate["weighted"]), usd(ead * (1 - rate["weighted"]))]], [1.8, 1.3, 1.5, 2.8], aligns=["l", "r", "r", "r"], bold_last=True)
    doc.para(f"Price range for negotiation: {usd(ead * (1 - rate['adverse']))} (adverse) to {usd(ead * (1 - rate['base']))} (base), i.e. {pct(1 - rate['adverse'], 1)} to {pct(1 - rate['base'], 1)} of outstanding. "
             "A buyer will also require a return on capital and servicing costs, so offers below this range should be expected; the model gives the expected-loss floor, not a market price.", 8.6)
    doc.heading("Transfer terms", 3)
    doc.kv([("Outstanding principal", usd(ead)), ("Rate / maturity", f"{L['ratePct']:.2f}% / {fmt_date(L['maturity'])}"), ("Collateral", f"{L['collateral']}, {usd(L['collateralValue'])}"),
            ("Insurance assignment", "policy proceeds to be assigned to the buyer" if L["insurance"] else "none"), ("Borrower notification", "required before transfer"),
            ("Effect on book", f"EAD -{usd(ead)}; climate-weighted ECL -{usd(cr['ecl']['weighted'][w])}"), ("Loss on sale", f"{usd(ead * rate['weighted'])} at the weighted rate (price {usd(ead * (1 - rate['weighted']))})")])
    doc.heading("Transfer checklist", 4)
    doc.checklist(["Credit Committee approval of the sale and of the minimum acceptable price.", "Legal review: assignability clause, borrower notification, data-protection consent for sharing borrower data.",
                   f"Collateral ({L['collateral']}) assignment registered in the name of the buyer.",
                   "Assignment of insurance proceeds to the buyer." if L["insurance"] else "Buyer informed that no insurance is in force.",
                   "Data room: payment history, schedule, climate evidence extract (loan memo), latest field declaration.", "Derecognition test (IFRS 9 3.2) and accounting entry agreed with Finance.",
                   "Regulatory notification (central bank debtor classification update) if required."])
    doc.heading("Alternatives considered", 5)
    doc.para("Restructuring (extend to next harvest) and offering parametric cover next season keep the client but leave the exposure in the book; they are preferred when the collateral is land-based and the borrower is cooperative.", 8.6)
    doc.heading("Approval and sign-off", 6)
    doc.approval(["Credit officer (preparer)", "Credit Committee", "Treasury"])
    return doc.finish()


def _cover_calc(a, L, w, product="parametric"):
    """Indicative index cover for next season: burn rate over the history seasons, premium = burn x 1.3, and this season's measured outcome.

    Past SPI records are not stored in the analysis, so a past season counts as triggered when the field yield fell more than 15% below
    its linear trend (parametric: full payout at -35%, linear between; multi-peril: indemnity on the loss beyond a 15% deductible,
    capped at 100%).  The current season uses the measured SPI-60 (parametric) or the expected yield loss at the as-of week (multi-peril)."""
    crop = L["crop"]
    strike, exit_ = -1.5, -2.5
    si = float(L["amountUsd"])
    yrs, tha = L["yieldHistory"]["years"], np.array(L["yieldHistory"]["tHa"], float)
    slope, icpt = np.polyfit(yrs, tha, 1)
    anom = tha / (slope * np.array(yrs) + icpt) - 1
    if product == "multi_peril":
        rate = lambda an: float(np.clip(-an - 0.15, 0, 1))
    else:
        rate = lambda an: float(np.clip((-an - 0.15) / 0.20, 0, 1))
    hist_pay = [si * rate(x) for x in anom]
    burn = float(np.mean(hist_pay)); prem = burn * 1.3
    s0, s1 = _window(a, L)
    seg = [L["spi60"][i] for i in range(max(s0, 0), min(s1, w) + 1)]
    mn = min(seg) if seg else None
    if product == "multi_peril":
        p50 = L["yield"]["p50"][w]
        cur_pay = si * rate(p50) if p50 is not None else None
    else:
        cur_pay = si * float(np.clip((strike - mn) / (strike - exit_), 0, 1)) if mn is not None else None
    pm = []
    for l in a["loans"]:
        if l["crop"] == crop and l["regionId"] == L["regionId"]:
            a0, a1 = _window(a, l); sg = [l["spi60"][i] for i in range(max(a0, 0), min(a1, w) + 1)]
            if sg:
                pm.append(min(sg))
    return dict(strike=strike, exit=exit_, si=si, yrs=yrs, tha=tha, anom=anom, hist_pay=hist_pay, burn=burn, prem=prem, mn=mn, cur_pay=cur_pay, pm=pm,
                trend=slope * np.array(yrs) + icpt)


def _cover_offer(a, w, lid):
    L = _loan(a, lid)
    doc = Doc("Parametric cover offer", a, w)
    meta = a["meta"]; crop = L["crop"]
    ws, we = meta["crops"][crop]["criticalWindow"]
    stages = _crit_stage_names(a, crop)
    cc = _cover_calc(a, L, w)
    strike, exit_, si, yrs, anom, hist_pay, burn, prem, mn, cur_pay, pm = (cc[k] for k in ("strike", "exit", "si", "yrs", "anom", "hist_pay", "burn", "prem", "mn", "cur_pay", "pm"))
    exist = L["insurance"]
    _doc_head(doc, "Parametric cover offer for next season", f"LP-COV-{L['id']}-W{w}", L, f"{L['borrower']} (borrower)",
              f"Offer of parametric drought cover on {L['crop']} for the next season, sum insured {usd(si)}, indicative premium {usd(prem)} ({pct(prem / si, 1)} of the sum insured).")
    doc.heading("Proposed cover", 1)
    doc.kv([("Index", "SPI-60 (60-day standardised precipitation index) at the field"), ("Window", f"{', '.join(stages[:1] + stages[-1:]) if stages else 'critical stages'}: weeks {ws} to {we} after sowing"),
            ("Strike (payout starts)", f"SPI-60 below {strike:g}"), ("Exit (full payout)", f"SPI-60 at or below {exit_:g}; linear in between"),
            ("Sum insured", f"{usd(si)} (= loan amount)"), ("Payout routed to", f"loan {L['id']} (assigned to the bank)"),
            ("Existing cover", (f"{exist['type']} for {', '.join(exist['perils'])}, {usd(exist['sumInsured'])}" if exist else "none")), ("Region / crop", f"{L['region']} / {crop}")])
    doc.para(f"Trigger in words: SPI-60 < {strike:g} between {stages[0].lower() if stages else 'the start of the critical window'} and {stages[-1].lower() if stages else 'its end'} for {crop} in {L['region']}."
             + (f" In {C.SEASON_LABEL} the {len(pm)} monitored {crop} fields in this region had a median window minimum SPI-60 of {np.median(pm):.2f} (worst {min(pm):.2f})." if pm else ""), 8.6)
    doc.heading("What it would have paid", 2)
    rows = []
    for y, an, p in zip(yrs, anom, hist_pay):
        rows.append([f"{y}/{str(y + 1)[2:]}", spct(an), usd(p) if p > 0 else "-"])
    show = [r for r in rows if r[2] != "-"]
    rows_tab = []
    cur_txt = (f"{usd(cur_pay)}  (measured: lowest SPI-60 in window {mn:.2f})" if cur_pay is not None else "n/a")
    rows_tab.append([(C.SEASON_LABEL + " (this season, to date)", FERN), spct(L["yield"]["p50"][w]) + " expected", (cur_txt, FERN)])
    for r in sorted(rows, key=lambda r: -float(r[2].replace("$", "").replace(",", "")) if r[2] != "-" else 0)[:8]:
        rows_tab.append(r)
    doc.table(["Season", "Field yield vs trend", "Payout on a " + usd(si) + " cover"], rows_tab, [2.6, 2, 2.8], aligns=["l", "r", "r"])
    doc.para(f"Seasons {C.HIST_YEARS[0]}/{str(C.HIST_YEARS[0] + 1)[2:]} to {C.HIST_YEARS[-1]}/{str(C.HIST_YEARS[-1] + 1)[2:]}: {len(show)} of {len(rows)} would have paid (the 8 largest are listed); average yearly payout (burn rate) {usd(burn)} = {pct(burn / si, 1)} of the sum insured. "
             "Method note: the SPI record of past seasons is not stored in the analysis, so a past season counts as triggered when the field's yield fell more than 15% below its trend (full payout at -35%), "
             "a proxy for the SPI trigger; the current season uses the measured SPI-60.", 7.8, color=MUTED)
    doc.heading("Premium indication", 3)
    incl = float(np.mean(hist_pay + ([cur_pay] if cur_pay is not None else [])))
    doc.table(["Item", "USD", "% of sum insured"], [["Expected payout (21 history seasons)", usd(burn), pct(burn / si, 2)], ["Loading", "x 1.3", ""],
                                                   ["Indicative premium", usd(prem), pct(prem / si, 2)], ["Memo: burn rate including " + C.SEASON_LABEL, usd(incl), pct(incl / si, 2)]], [3.6, 1.8, 1.8], aligns=["l", "r", "r"])
    doc.para("Indicative only: an insurer prices with its own models and reinsurance cost. The premium is not committed until a policy is issued; the offer would be financed within the next loan.", 8.2, color=MUTED)
    doc.heading("Acceptance", 4)
    doc.signatures(["Borrower", "Bank officer", "Insurer"])
    return doc.finish()


def _contact(a, w, lid):
    L = _loan(a, lid)
    doc = Doc("Borrower call brief", a, w)
    cr = L["credit"]; ead = cr["ead"][w]; pl, pk, pint = _peril(L, w)
    rec = alerts_mod.recommend(L, w)
    rev, price = _revenue(a, L, w)
    _, due = _remaining_due(L, w, a)
    doc.title_block(f"Call brief: {L['borrower']}", f"{L['id']} · {L['region']} · {L['crop']} · prepared {doc.generated}, data as of {fmt_date(doc.asof)} (week {w})")
    doc.y -= 0.1
    wd = _risk_chip(doc, MX, doc.y, L["level"][w])
    doc.text(MX + wd + 0.1, doc.y + 0.03, f"score {L['score'][w]:.0f}/100 · {_stage_text(L, w)} · suggested action: {rec['action']}", 8.5)
    doc.y += 0.32
    doc.heading("What we see", 1)
    doc.para(alerts_mod.explain(L, w), 9)
    doc.kv([("Outstanding", usd(ead)), ("Maturity", fmt_date(L["maturity"])), ("Revenue / debt (p50)", f"{usd(rev['p50'])} vs {usd(due)} ({rev['p50'] / due:.2f}x)" if due else "n/a"),
            ("Insurance", (L["insurance"]["type"] + ", " + ", ".join(L["insurance"]["perils"]) + (" (trigger met)" if cr.get("insuranceMet") and cr["insuranceMet"][w] else "")) if L["insurance"] else "none"),
            ("Past due", f"{L['daysPastDue']} days, BCRA situacion {L['bcraSituacion']}"), ("Other-bank debt", usd(L["otherBankDebt"]))])
    doc.heading("Questions to ask", 2)
    qs = [f"How is the {L['crop']} crop looking on the ground right now? What do you see compared with a normal year ({pl} is the main signal, intensity {pint:.0f}/100)?",
          "When do you expect to harvest, and what yield per hectare are you counting on? (Our model expects " + f"{_yield_expect(L, w)[1]:.1f} t/ha, {spct(L['yield']['p50'][w])} vs normal.)",
          "Have you sold forward any of the crop? At what price, and to whom? Any storage or warrant on grain?",
          "Which expenses are still pending before harvest, and how much cash do you have for them?",
          "Do you have other debts or payments due before our maturity? (File shows other-bank debt " + usd(L["otherBankDebt"]) + ".)"]
    if L["insurance"]:
        qs.append(f"Has the {L['insurance']['type']} insurer visited the field or been notified? Do you have the policy number and the loss-notice deadline?")
    else:
        qs.append("Do you have any crop insurance or would you consider parametric drought cover next season?")
    if L["daysPastDue"] > 0:
        qs.append(f"The loan is {L['daysPastDue']} days past due: what happened, and what payment can be made and when?")
    for q in qs:
        doc.para(q, 8.8, bullet="•", after=0.03)
    doc.heading("Documents to request", 3)
    for q in ("Updated crop and sowing declaration (area, date, variety).", "Field photos with date stamp, or an agronomist visit report.", "Insurance policy and any loss notice already filed.", "Forward sales contracts, warrants and storage receipts.", "Statement of other debts and upcoming obligations (last 3 months)."):
        doc.para(q, 8.8, bullet="•", after=0.02)
    doc.heading("Options to discuss", 4)
    doc.para(f"{rec['action']}: {rec['why']} Alternatives: extend maturity to next harvest with interest-only payments; route insurance proceeds to the loan; parametric cover for next season.", 8.8)
    doc.heading("Call record", 5)
    doc.table(["Item", "Notes"], [["Date / time / who", " "], ["Borrower's view of the crop", " \n "], ["Commitments made", " \n "], ["Follow-up date", " "]], [1.8, 5.6])
    doc.signatures(["Credit officer"])
    return doc.finish()


def _chart_application(cc):
    def draw(ax):
        yrs, tha, trend = cc["yrs"], cc["tha"], cc["trend"]
        low = cc["anom"] <= -0.15
        ax.bar(range(len(yrs)), tha, color=[LEVEL_COL["Severe"] if x else "#cfe9ec" for x in low], width=0.75)
        ax.plot(range(len(yrs)), trend, color=INK, lw=1, ls="--", label="linear trend")
        ax.plot(range(len(yrs)), trend * 0.85, color=LEVEL_COL["High"], lw=1, ls=":", label="trend -15% (trigger proxy)")
        ax.set_xticks(range(len(yrs))); ax.set_xticklabels([f"{str(y)[2:]}" for y in yrs], fontsize=6)
        ax.set_ylabel("field yield, t/ha", fontsize=7, color=MUTED); ax.legend(fontsize=6, frameon=False, ncol=2, loc="upper center", bbox_to_anchor=(0.5, 1.14))
    return draw


def _insurance_application(a, w, lid, product=None):
    L = _loan(a, lid)
    product = (product or "parametric").lower().replace("-", "_")
    if product not in ("parametric", "multi_peril"):
        raise ValueError("product must be parametric or multi_peril")
    para_ = product == "parametric"
    doc = Doc("Insurance application", a, w)
    meta = a["meta"]; crop = L["crop"]
    cc = _cover_calc(a, L, w, product)
    si, burn, prem, strike, exit_ = cc["si"], cc["burn"], cc["prem"], cc["strike"], cc["exit"]
    stages = _crit_stage_names(a, crop)
    cwk = meta["crops"][crop]["criticalWindow"]
    sow = date.fromisoformat(L["sowing"]["date"]) + timedelta(days=364)
    w0, w1 = sow + timedelta(days=7 * cwk[0]), sow + timedelta(days=7 * cwk[1])
    hv = _next_harvest(a, L)
    prod_name = "Parametric index cover (drought, SPI-60)" if para_ else "Multi-peril crop insurance (yield-loss indemnity)"
    exist = L["insurance"]
    _doc_head(doc, "Insurance application", f"LP-APP-{L['id']}-W{w}", L, "Insurer (underwriting department)",
              f"Application for {'parametric index cover (drought, SPI-60)' if para_ else 'multi-peril crop insurance'} on field {L['fieldId']} ({crop}, {L['areaHa']:.0f} ha) for the {sow.year}/{str(sow.year + 1)[2:]} season; sum insured {usd(si)}, indicative premium {usd(prem)} ({pct(prem / si, 2)}). "
              "Submitted by the lender together with the applicant.")
    doc.heading("Applicant", 1)
    doc.kv([("Applicant (farmer)", L["borrower"]), ("Farmer id", L["farmerId"]), ("Tax id (CUIT)", "____________________"), ("Country / region", f"{L['country']} / {L['region']}"),
            ("Farm size", f"{L['farmHa']:.0f} ha ({L['areaHa']:.0f} ha financed)"), ("Contact", "____________________")])
    doc.heading("Loss payee and beneficiary", 2)
    doc.para(f"{meta['lender']} (the lender) is named irrevocably as loss payee: any payout under this policy is assigned and paid directly to the lender to repay loan {L['id']} "
             f"({L['product']}, {usd(L['amountUsd'])}, outstanding {usd(L['credit']['ead'][w])}, maturity {fmt_date(L['maturity'])}); any balance is paid to the applicant.", 8.8)
    doc.heading("Insured field", 3)
    ring = L.get("ring")
    geo = (f"polygon of {len(ring)} vertices; first vertex lng {ring[0][0]:.5f}, lat {ring[0][1]:.5f}" if ring else "")
    doc.kv([("Field id", L["fieldId"]), ("Centroid (WGS84)", f"lat {L['lat']:.5f}, lng {L['lng']:.5f}"), ("Boundary", geo or "centroid only: attach the field polygon (KML / WKT)"),
            ("Area", f"{L['areaHa']:.0f} ha"), ("Crop", crop), ("Irrigated", "yes" if L["irrigated"] else "no"),
            ("Sowing date", f"{fmt_date(L['sowing']['date'])} (source: {'declared' if L['sowing']['source'] == 'given' else 'detected from satellite phenology'})"),
            ("Normal yield", f"{L['expectedYieldTHa']:.2f} t/ha")])
    doc.heading("Product requested", 4)
    if para_:
        doc.kv([("Product", prod_name), ("Index", "SPI-60: 60-day standardised precipitation index at the field (CHIRPS-type rainfall record, gamma fit over 20+ years)"),
                ("Trigger window", f"{stages[0] if stages else 'critical stages'} to {stages[-1] if stages else ''} ({cwk[0]} to {cwk[1]} weeks after sowing)"),
                ("Strike", f"SPI-60 below {strike:g}: payout starts"), ("Exit", f"SPI-60 at or below {exit_:g}: full payout; linear between strike and exit"), ("Basis", "index only: no loss adjustment")], 1)
        doc.para(f"Trigger in words: SPI-60 < {strike:g} between {stages[0].lower() if stages else 'start'} and {stages[-1].lower() if stages else 'end'}.", 8.4, color=MUTED)
    else:
        doc.kv([("Product", prod_name), ("Perils", "drought, excess water, frost, heat, hail"), ("Deductible", "15% of expected yield"), ("Indemnity", "sum insured x (yield loss - 15%), capped at 100%, on the insurer's loss adjustment"),
                ("Insured window", f"whole cycle, with focus on {stages[0] if stages else 'flowering'} to {stages[-1] if stages else 'grain fill'}")], 1)
    doc.heading("Coverage period", 5)
    doc.kv([("Policy period", f"{fmt_date(sow.isoformat())} (expected sowing) to {fmt_date(hv.isoformat())} (expected harvest)"), ("Critical window", f"{fmt_date(w0.isoformat())} to {fmt_date(w1.isoformat())}"),
            ("Existing cover", (f"{exist['type']} ({', '.join(exist['perils'])}), sum insured {usd(exist['sumInsured'])}: this application complements or replaces it" if exist else "none: this is the first cover for the field"))], 1)
    doc.heading("Sum insured and premium", 6)
    doc.table(["Item", "Amount", "Note"], [["Sum insured", usd(si), "= loan amount (default)"], ["Expected annual payout (burn rate, 21 seasons)", usd(burn), pct(burn / si, 2) + " of the sum insured"],
                                           ["Loading", "x 1.3", "expenses, risk margin, reinsurance"], ["Indicative premium", usd(prem), pct(prem / si, 2) + " of the sum insured"]], [3.2, 1.4, 2.8], aligns=["l", "r", "l"], bold_last=True)
    doc.para("Indicative only: the insurer prices with its own models; the premium is not binding until the policy is issued. The lender may finance the premium within the next loan.", 8, color=MUTED, style="italic")
    doc.heading("What this cover would have paid, season by season", 7)
    mn, cur = cc["mn"], cc["cur_pay"]
    rows = [[("{C.SEASON_LABEL} (this season, to date)", FERN), spct(L["yield"]["p50"][w]) + " expected", (f"{mn:.2f}" if (mn is not None and para_) else "-", FERN), (usd(cur) if cur is not None else "n/a", FERN)]]
    for y, an, pay in sorted(zip(cc["yrs"], cc["anom"], cc["hist_pay"]), key=lambda t: -t[0]):
        rows.append([f"{y}/{str(y + 1)[2:]}", spct(an), "n/a", usd(pay) if pay > 0 else "-"])
    doc.table(["Season", "Field yield vs trend", "Window min SPI-60", "Payout"], rows, [2.4, 1.8, 1.6, 1.6], size=7.2, aligns=["l", "r", "r", "r"])
    n_paid = sum(1 for x in cc["hist_pay"] if x > 0)
    doc.para(f"{n_paid} of {len(cc['yrs'])} history seasons would have paid; burn rate {pct(burn / si, 2)} of the sum insured. Method note: the SPI record of past seasons is not stored in the analysis, so a past season counts as triggered "
             "when the field's yield fell more than 15% below its linear trend (" + ("full payout at -35%, linear between" if para_ else "indemnity beyond a 15% deductible") + "), a proxy for the index; the current season uses "
             + ("the measured SPI-60 of this field." if para_ else "the expected yield loss at the as-of date."), 7.6, color=MUTED)
    doc.heading("Supporting evidence", 8)
    frac = float(np.mean(cc["anom"] <= -0.15)); worst = int(np.argmin(cc["anom"]))
    doc.para(f"Stress frequency: {int(np.sum(cc['anom'] <= -0.15))} of {len(cc['yrs'])} history seasons ({pct(frac, 0)}) had yield more than 15% below trend; worst {cc['yrs'][worst]}/{str(cc['yrs'][worst] + 1)[2:]} at {spct(cc['anom'][worst])}. "
             f"This season: {L['level'][w]} stress (score {L['score'][w]:.0f}), expected yield {spct(L['yield']['p50'][w])} vs normal" + (f"; lowest SPI-60 in the critical window {mn:.2f}" if mn is not None else "")
             + (f". Median of the {len(cc['pm'])} monitored {crop} fields in {L['region']}: window minimum SPI-60 {np.median(cc['pm']):.2f}." if cc["pm"] else "."), 8.6)
    doc.chart(1.9, _chart_application(cc))
    doc.heading("Declarations", 9)
    for t in ("The applicant confirms that the information on the field, crop, area and sowing date is true and complete, and authorises the lender and the insurer to verify it with satellite data.",
              "The applicant has not concealed any loss, claim or refusal of insurance on this field in the last five years.",
              f"The applicant irrevocably assigns the proceeds of the policy to {meta['lender']} up to the outstanding balance of loan {L['id']}.",
              "The applicant understands that index cover pays on the measured index, not on the actual loss on the farm (basis risk).",
              "The lender submits this application on the basis of data supplied by the applicant and of its own monitoring."):
        doc.para(t, 8.4, bullet="•", after=0.03)
    doc.heading("Signatures", 10)
    doc.signatures(["Applicant (farmer)", "Lender (loss payee)", "Insurer (received)"])
    return doc.finish()


# ================================================================================================ SOIL SENSOR REPORT
def _soil_sensors(a, w, lid):
    """One page. Sensor readings are SAMPLE DATA (see sensors.py, mirrors web/src/SoilSensors.tsx)."""
    L = _loan(a, lid)
    S = sensors_mod.sensor_readings(L, w)
    doc = Doc(f"Soil sensor report {lid}", a, w)
    _loan_header(doc, L, w, "Soil sensor report")
    _loan_facts(doc, a, L, w)
    lo, hi = sensors_mod.VWC_LO, sensors_mod.VWC_HI
    ORANGE, STEEL, RUST = "#de6f3a", "#3f86ab", "#b8401a"
    col = lambda v: ORANGE if v < lo else STEEL

    def status(v, d):
        if v < lo:
            return "below range" + (" (dry)" if d == 10 and S["dry"] else "")
        return "above range" if v > hi else ("in range (water held)" if d == 60 else "in range")
    doc.heading("Probe readings by depth")
    doc.table(["Depth", "VWC %", "Normal range", "Status"],
              [[f"{d} cm", (f"{v}", col(v)), f"{lo}-{hi}% VWC", (status(v, d), col(v))] for d, v in S["reads"]],
              [1, 1, 1.4, 2.2], aligns=["l", "r", "r", "l"])
    doc.heading("Satellite against sensor, surface moisture")
    doc.kpis([("SATELLITE SURFACE", f"{S['sat']}%", "satellite estimate", STEEL), ("SENSOR (10 cm)", f"{S['sensor']}%", "probe reading", ORANGE if S["sensor"] < lo else STEEL),
              ("SOIL TEMPERATURE", f"{S['temp']} °C", "high" if S["temp"] > 28 else "", FERN), ("DATA CONFIDENCE", f"{S['conf']}/5", "satellite + sensors", FERN)])
    doc.callout("Disagree: the sensor is drier than the satellite, so it gives an earlier warning." if S["disagree"] else "Agree: the sensor confirms the satellite.",
                RUST if S["disagree"] else STEEL, 9)
    doc.heading("Soil chemistry")
    doc.table(["Salinity EC", "pH", "Nitrogen (N)", "Phosphorus (P)", "Potassium (K)"], [[f"{S['ec']} dS/m", S["ph"], *S["npk"]]], aligns=["r", "r", "r", "r", "r"])
    doc.heading("Soil-moisture percentile, season to date")

    def draw(ax):
        x = np.arange(w + 1)
        ax.plot(x, L["smPct"][:w + 1], color=STEEL, lw=1.6)
        ax.axvline(w, color=ORANGE, lw=1.4)
        ax.text(w + 0.4, 98, "as of", fontsize=6.5, va="top", color=ORANGE, fontweight="bold")
        ax.set_ylim(0, 100); ax.set_ylabel("soil moisture percentile", fontsize=7, color=MUTED)
        _month_axis(a, ax)
    doc.chart(2.0, draw)
    doc.para("Pilot: sensor readings are sample data derived for demonstration; the climate score works without sensors.", 8, color=MUTED, style="italic")
    return doc.finish()


# ================================================================================================ entry point
def list_kinds():
    return [dict(k) for k in KINDS]


def build_pdf(kind: str, analysis: dict, week: int | None = None, loan_id: str | None = None, ids: list | None = None, product: str | None = None) -> bytes:
    if kind not in KIND_NAMES:
        raise ValueError(f"unknown report kind {kind!r}; choose one of {', '.join(KIND_NAMES)}")
    w = analysis["meta"]["asOfDefault"] if week is None else int(week)
    if not 0 <= w < len(analysis["meta"]["weeks"]):
        raise ValueError(f"week must be 0..{len(analysis['meta']['weeks']) - 1}")
    needs = next(k["needsLoan"] for k in KINDS if k["kind"] == kind)
    if needs:
        lid = loan_id or (ids[0] if ids and len(ids) == 1 else None)
        if not lid:
            raise ValueError(f"report {kind!r} needs a loan: pass loan=<loan id>")
        _loan(analysis, lid)
        if kind == "insurance_application":
            return _insurance_application(analysis, w, lid, product)
        return {"loan_memo": _loan_memo, "claim": _claim, "restructure": _restructure, "downgrade": _downgrade, "transfer": _transfer,
                "cover_offer": _cover_offer, "contact": _contact, "soil_sensors": _soil_sensors}[kind](analysis, w, lid)
    if kind == "portfolio":
        return _portfolio(analysis, w)
    return _early_warning(analysis, w, ids)
