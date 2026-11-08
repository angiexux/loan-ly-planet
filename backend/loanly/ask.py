"""Ask in plain language (CONTRACT section C, POST /api/ask).

ask(text, analysis, week=None) -> {understood, query, answer, parser}

* Rules (default, deterministic, English + Spanish) mirror web/src/ask.ts: same intents, same filters (crop, regionId, country, level,
  peril, stage 1/2/3, insured, coverageGap, minScore/maxScore, minEad/maxEad, minPd/maxPd, loanIds, movedToStage2), same keyword lists.
* Optional LLM (env ANTHROPIC_API_KEY and LOANLY_LLM=1): Claude maps the text to the same query JSON (JSON only, validated against the
  schema and the region/crop vocabulary); on any failure the rules are used.  THE LLM NEVER PRODUCES NUMBERS: every figure in the answer
  is computed here from the analysis dict.
* What-if: ECL is recomputed with the ifrs9 functions (PD logit shift with a changed beta and an additive yield shock on the p10/p50/severe
  yield anomalies, same LGD, same schedule).  Approximation: stress scores and LGD are not re-simulated; the change is added to the stored ECL.
* Stress test: analysis.stressTest (whole book; filters do not apply to it).
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
import urllib.request
from datetime import date

import numpy as np

from . import alerts as alerts_mod
from . import config as C
from . import ifrs9

INTENTS = ("list", "provision", "stress_test", "loan", "compare_regions", "alerts", "what_if", "report")
# Crop Health Index CHI (display indicator): English, Spanish and Portuguese wording, accents already stripped by _norm()
FHI_NAME = r"crop health(?: index)?|(?<![a-z])chi(?![a-z])|farm health(?: index)?|(?<![a-z])fhi(?![a-z])|salud (?:del|de la|de los|de) (?:campo|lote|lotes|cultivo|cultivos|chacra)(?: index)?|indice de salud(?: del campo| agricola)?|saude da lavoura|saude do campo|indice de saude(?: da lavoura)?"
FHI_RE = re.compile(r"(?:" + FHI_NAME + r")")
PERILS = ("drought", "excess_water", "frost", "heat", "hail")
PERIL_NAME = dict(drought="drought", frost="frost", heat="heat", hail="hail", excess_water="flood / excess water")
CROP_WORDS = [("soy", r"(?<![a-z])(soy|soja|soya|soybeans?)(?![a-z])"), ("maize", r"(?<![a-z])(maize|maiz|corn)(?![a-z])"),
              ("wheat", r"(?<![a-z])(wheat|trigo)(?![a-z])"), ("sunflower", r"(?<![a-z])(sunflowers?|girasol(es)?)(?![a-z])")]
PERIL_WORDS = [("drought", r"(?<![a-z])(drought|sequia|dry|dryness|seco)(?![a-z])"), ("frost", r"(?<![a-z])(frosts?|helada|heladas|freeze)(?![a-z])"),
               ("heat", r"(?<![a-z])(heat|calor|heatwave|hot)(?![a-z])"), ("hail", r"(?<![a-z])(hail|granizo)(?![a-z])"),
               ("excess_water", r"(?<![a-z])(floods?|flooding|inundacion(es)?|excess water|exceso de agua|waterlogg\w*|anegamiento)(?![a-z])")]
REGION_ALIAS = {"BR-RS": ["rio grande", "missoes"], "PY-IT": ["itapua"], "AR-ER": ["parana"], "AR-BS": ["sudeste"]}
COUNTRY_WORDS = [("argentina", "Argentina"), ("uruguay", "Uruguay"), ("brazil", "Brazil"), ("brasil", "Brazil"), ("paraguay", "Paraguay")]
MONTHS = [("january", 1), ("february", 2), ("march", 3), ("april", 4), ("may", 5), ("june", 6), ("july", 7), ("august", 8), ("september", 9), ("october", 10),
          ("november", 11), ("december", 12), ("enero", 1), ("febrero", 2), ("marzo", 3), ("abril", 4), ("mayo", 5), ("junio", 6), ("julio", 7), ("agosto", 8),
          ("septiembre", 9), ("setiembre", 9), ("octubre", 10), ("noviembre", 11), ("diciembre", 12), ("sept", 9), ("jan", 1), ("feb", 2), ("mar", 3), ("apr", 4),
          ("jun", 6), ("jul", 7), ("aug", 8), ("sep", 9), ("oct", 10), ("nov", 11), ("dec", 12)]
SHORT_OK = {"may", "march", "sept", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}
MONTH_RE = re.compile(r"(?:(?<![a-z])(as of|in|by|until|during|en|hasta|from|at|end of|of)\s+(?:the\s+)?)?(?:(early|beginning of|mid|middle of|late|end of|principios de|inicios de|mediados de|fines de|finales de)\s+)?(?<![a-z])("
                      + "|".join(m for m, _ in MONTHS) + r")(?![a-z])")
PD_NOTE = "PD sensitivities can be calibrated to your own default history."
KIND_TITLE = dict(portfolio="IFRS 9 portfolio report", early_warning="early-warning report", loan_memo="loan memo")


# ------------------------------------------------------------------------------------------------ formatting
def _usd(x):
    x = float(x); a = abs(x); s = "-" if x < 0 else ""
    if a >= 1e6:
        return f"{s}${a / 1e6:.2f}M" if a < 1e7 else f"{s}${a / 1e6:.1f}M"
    if a >= 1e4:
        return f"{s}${a / 1e3:.0f}k"
    return f"{s}${a:,.0f}"


def _sgn(x):
    return ("+" if x >= 0 else "-") + _usd(abs(x))


def _pct(x, d=0):
    return f"{x * 100:.{d}f}%"


def _norm(s):
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def _word(k):
    return re.compile(rf"(?<![a-z]){re.escape(k)}(?![a-z])")


def _has(n, pat):
    return re.search(pat, n) is not None


def _num(s):
    return float(s.replace(",", "."))


def week_label(a, w):
    d = date.fromisoformat(a["meta"]["weeks"][w])
    part = "early" if d.day <= 10 else "mid" if d.day <= 20 else "late"
    return f"{part} {d.strftime('%b %Y')}"


def enabled_llm():
    return bool(os.environ.get("ANTHROPIC_API_KEY")) and os.environ.get("LOANLY_LLM") == "1"


# ------------------------------------------------------------------------------------------------ per-loan view at a week
class V:
    """One loan seen at week w (everything read from the analysis dict)."""

    def __init__(self, L, w):
        cr = L["credit"]
        self.L, self.id = L, L["id"]
        self.level, self.score = L["level"][w], L["score"][w]
        k, inten = alerts_mod.dominant_peril(L, w)
        self.main = k
        self.stage, self.pd = cr["stage"][w], cr["pd12"][w]
        self.ead = cr["ead"][w]
        self.bank, self.base, self.adv, self.sev, self.wtd = cr["eclBank"][w], cr["ecl"]["base"][w], cr["ecl"]["adverse"][w], cr["ecl"]["severe"][w], cr["ecl"]["weighted"][w]
        self.delta = self.wtd - self.bank
        fh = L.get("fhi")
        self.fhi = fh[w] if fh else None            # Crop Health Index (CHI): DISPLAY only, never used in PD / staging / ECL
        ins = L.get("insurance")
        self.insured = bool(ins)
        self.gap = (not ins) or ((k or "drought") not in ins["perils"])

    def stage_back(self, w0):
        return self.L["credit"]["stage"][w0], self.L["credit"]["ead"][w0]


def _views(a, w):
    return [V(L, w) for L in a["loans"]]


def _apply(vs, f, a, w):
    prev = None
    if f.get("movedToStage2"):
        w0 = max(0, w - 4)
        prev = {v.id for v in _views(a, w0) if v.stage == 1 and v.ead > 0}
    out = []
    for v in vs:
        if v.ead <= 0 and not f.get("loanIds"):
            continue
        if f.get("loanIds") and v.id.upper() not in {i.upper() for i in f["loanIds"]}:
            continue
        L = v.L
        if f.get("farmerIds") and L["farmerId"] not in f["farmerIds"]:
            continue
        if f.get("crop") and L["crop"] not in f["crop"]:
            continue
        if f.get("regionId") and L["regionId"] not in f["regionId"]:
            continue
        if f.get("country") and L["country"] not in f["country"]:
            continue
        if f.get("level") and v.level not in f["level"]:
            continue
        if f.get("peril") and v.main not in f["peril"]:
            continue
        if f.get("stage") and v.stage not in f["stage"]:
            continue
        if prev is not None and not (v.stage == 2 and v.id in prev):
            continue
        if f.get("insured") is False and v.insured:
            continue
        if f.get("insured") is True and not v.insured:
            continue
        if f.get("coverageGap") and not v.gap:
            continue
        if f.get("farmHealth") and v.fhi is None:
            continue
        if f.get("maxFhi") is not None and not v.fhi < f["maxFhi"]:
            continue
        if f.get("minFhi") is not None and not v.fhi >= f["minFhi"]:
            continue
        if f.get("minScore") is not None and v.score < f["minScore"]:
            continue
        if f.get("maxScore") is not None and v.score >= f["maxScore"]:
            continue
        if f.get("minEad") is not None and v.ead <= f["minEad"]:
            continue
        if f.get("maxEad") is not None and v.ead >= f["maxEad"]:
            continue
        if f.get("minPd") is not None and v.pd <= f["minPd"]:
            continue
        if f.get("maxPd") is not None and v.pd >= f["maxPd"]:
            continue
        out.append(v)
    return out


def _sort(vs, s):
    if s.get("by") == "fhi":
        return sorted(vs, key=lambda v: (v.fhi is None, v.fhi if v.fhi is not None else 0), reverse=False) if not s.get("desc") else sorted(vs, key=lambda v: -(v.fhi if v.fhi is not None else -1))
    key = {"ead": lambda v: v.ead, "pd": lambda v: v.pd, "eclDelta": lambda v: v.delta}.get(s.get("by"), lambda v: v.score)
    return sorted(vs, key=key, reverse=bool(s.get("desc", True)))


# ------------------------------------------------------------------------------------------------ rule-based parser
def _read_regions(n, meta):
    groups = {}
    for r in meta["regions"]:
        groups.setdefault(_norm(r["name"].split("·")[0].strip()), []).append(r)
    ids = set()
    for first, rs in groups.items():
        if not _has(n, _word(first).pattern):
            continue
        narrowed = [r for r in rs if (lambda sec: sec and _has(n, _word(sec).pattern))(_norm(r["name"].split("·")[1].strip() if "·" in r["name"] else ""))]
        for r in (narrowed if len(rs) > 1 and narrowed else rs):
            ids.add(r["id"])
    for r in meta["regions"]:
        if r["id"] not in ids and any(_has(n, _word(al).pattern) for al in REGION_ALIAS.get(r["id"], [])):
            ids.add(r["id"])
    return [r["id"] for r in meta["regions"] if r["id"] in ids]


def _read_week(n, a):
    weeks = a["meta"]["weeks"]
    m = re.search(r"(?<![a-z])(?:week|dekad|semana)\s*(\d{1,2})(?![\d%])", n)
    if m and int(m.group(1)) < len(weeks):
        return int(m.group(1))
    m = MONTH_RE.search(n)
    if m:
        lead, part, name = m.groups()
        if not (name in SHORT_OK and not lead and not part):
            mon = dict(MONTHS)[name]
            want = 1 if part and re.search(r"early|beginning|principios|inicios", part) else 11 if part and re.search(r"mid|medi", part) else 21
            cands = [(abs(int(d[8:10]) - want), i) for i, d in enumerate(weeks) if int(d[5:7]) == mon]
            if cands:
                return min(cands)[1]
    return None


def rules_parse(text, a, week=None):
    meta = a["meta"]
    raw = text.strip()
    n = _norm(raw)
    f = {}
    q = dict(intent="list", filters=f, week=None, sort={"by": "score", "desc": True}, limit=50, whatIf=None, report=None)
    ids = [m.upper() for m in re.findall(r"\b([A-Za-z]{2}-[A-Za-z]{2}-\d{2,4})\b", raw)]
    if not ids:
        ids = [m.upper() for m in re.findall(r"\b(L\d{2,4})\b", raw, re.I)]
    if not ids:
        ids = [m.upper() for m in re.findall(r"\b((?:UP|MY)-\d+)\b", raw, re.I)]
    if ids:
        f["loanIds"] = ids
    # PD thresholds and amounts first, then strip them so "10%" and "$100k" are not read twice
    m = re.search(r"(?<![a-z])(?:pd|probability of default|probabilidad de incumplimiento)(?![a-z])[^\d%]{0,30}?(above|over|exceeds?|exceeding|more than|greater than|>|at least|below|under|less than|<|sobre|mas de|menos de)?\s*(\d+(?:[.,]\d+)?)\s*%", n)
    if m:
        v = _num(m.group(2)) / 100
        if re.search(r"below|under|less|<|menos", m.group(1) or ""):
            f["maxPd"] = v
        else:
            f["minPd"] = v
        n = n.replace(m.group(0), " ")
    m = re.search(r"(over|above|more than|greater than|larger than|bigger than|at least|exceeding|sobre|mas de|mayores? (?:a|de)|under|below|less than|smaller than|menos de|menores? (?:a|de)|<|>)\s*(?:usd|us\$|\$)?\s*(\d+(?:[.,]\d+)?)\s*(k|mm|m|million|millions|thousand|mil|millon|millones)?(?![a-z%])", n)
    if m and (re.search(r"\$|usd", m.group(0)) or m.group(3)):
        u = m.group(3)
        mul = 1 if not u else 1e3 if re.fullmatch(r"k|thousand|mil", u) else 1e6
        v = _num(m.group(2)) * mul
        if re.search(r"under|below|less|smaller|menos|menor|<", m.group(1)):
            f["maxEad"] = v
        else:
            f["minEad"] = v
        n = n.replace(m.group(0), " ")
    m = re.search(FHI_RE, n)
    if m:
        f["farmHealth"] = True
        q["sort"] = dict(by="fhi", desc=False)             # worst farm health first
        t = re.search(r"(?:" + FHI_NAME + r")[^\d]{0,25}?(above|over|>|at least|more than|below|under|less than|<|menos de|por debajo de|abaixo de|menor(?:es)? (?:a|de|que)|bajo|sobre|mas de|acima de|maior(?:es)? (?:a|de|que))?\s*(\d{1,3})(?![\d.,]*\s*(?:k|m|mm|usd|\$))", n) or \
            re.search(r"(below|under|less than|<|above|over|>|at least|more than|menos de|por debajo de|abaixo de|sobre|mas de|acima de)\s*(\d{1,3})(?![\d]*\s*(?:%|k|m\b|usd))[^a-z]{0,10}(?:" + FHI_NAME + r")", n)
        if t:
            v = float(t.group(2))
            if re.search(r"above|over|>|at least|more than|sobre|mas de|acima", t.group(1) or ""):
                f["minFhi"] = v
            else:
                f["maxFhi"] = v
            n = n.replace(t.group(0), " ")
        else:
            n = n.replace(m.group(0), " ")
        if _has(n, r"highest|best|top|mejor|maior|melhor"):
            q["sort"] = dict(by="fhi", desc=True)
    m = re.search(r"(?<![a-z])score[^\d]{0,15}?(above|over|>|below|under|<|at least)?\s*(\d{1,3})(?![\d%])", n)
    if m:
        if re.search(r"below|under|<", m.group(1) or ""):
            f["maxScore"] = int(m.group(2))
        else:
            f["minScore"] = int(m.group(2))
        n = n.replace(m.group(0), " ")
    m = re.search(r"(?<![a-z])(?:top|first|primeros|principales)\s+(\d+)", n)
    if m:
        q["limit"] = min(200, int(m.group(1)))
    # stage
    m = re.search(r"(?:stage|etapa|fase)\s*([123])", n)
    if m:
        f["stage"] = [int(m.group(1))]
        if m.group(1) == "2" and _has(n, r"moved|migrat|became|turned|downgrad|pasaron|paso a|pasan|entered"):
            f["movedToStage2"] = True
    # intent
    drop = re.search(r"(\d+(?:[.,]\d+)?)\s*%", n)
    report_word = _has(n, r"(?<![a-z])(report|pdf|memo|informe|reporte|print)(?![a-z])")
    what_if = _has(n, r"what if|what happens if|suppose|scenario|escenario|y si |(?<![a-z])si (la|el|los|las|llueve|hay|se)(?![a-z])|\d+\s*%\s*(worse|peor|more severe|lower|menos|drop|decline|harsher)|(worse|peor|more severe) by")
    stress = _has(n, r"1\s*[- ]?\s*(?:in|en)\s*[- ]?\s*\d+|stress test|worst year|worst case|tail|p9[59]|return period|peor ano|perdida (extrema|en un ano)|value at risk|\bvar\b|prueba de estres")
    compare = _has(n, r"compare|comparison|by region|per region|por region|regional|concentration|concentracion|which regions?|what regions?|cual(es)? region")
    alerts = _has(n, r"(?<![a-z])(alerts?|alertas?)(?![a-z])|what changed|got worse|gotten worse|worsen|deteriorat|empeor|last (two|2) weeks|new this week|ultimas? (dos )?semanas")
    prov = _has(n, r"provision|(?<![a-z])ecl(?![a-z])|expected credit loss|ifrs|climate add|perdida esperada|cuanto (agrega|suma)")
    if f.get("loanIds") and not _has(n, r"compare|alerts?"):
        q["intent"] = "loan"
    elif report_word:
        q["intent"] = "report"
    elif what_if:
        q["intent"] = "what_if"
    elif stress:
        q["intent"] = "stress_test"
    elif compare:
        q["intent"] = "compare_regions"
    elif alerts:
        q["intent"] = "alerts"
    elif prov:
        q["intent"] = "provision"
    intent = q["intent"]
    crops = [c for c, p in CROP_WORDS if re.search(p, n)]
    if crops:
        f["crop"] = crops
    perils = [c for c, p in PERIL_WORDS if re.search(p, n)]
    if perils:
        f["peril"] = perils
    if intent != "loan":
        regs = _read_regions(n, meta)
        if regs:
            f["regionId"] = regs
        ctry = []
        for k, v in COUNTRY_WORDS:
            if _has(n, _word(k).pattern) and v not in ctry and any(r["country"] == v for r in meta["regions"]):
                ctry.append(v)
        if ctry:
            f["country"] = ctry
    # level
    lv = set()
    if _has(n, r"(?<![a-z])(severe|critical|critico|critica|severo|severa|grave)(?![a-z])"):
        lv.add("Severe")
    if _has(n, r"(?<![a-z])(high|alto|alta)(?![a-z])"):
        lv.add("High")
    if _has(n, r"(?<![a-z])(watch|vigilancia)(?![a-z])"):
        lv.add("Watch")
    if _has(n, r"(?<![a-z])(normal|healthy|sano|sanos)(?![a-z])") and intent != "what_if":
        lv.add("Normal")
    if _has(n, r"under stress|at risk|risky|en riesgo|en estres|estresad|stressed(?! (exposure|ead|amount|share))"):
        lv |= {"High", "Severe"}
    if lv and f.get("minScore") is None and f.get("maxScore") is None:
        f["level"] = [x for x in ("Severe", "High", "Watch", "Normal") if x in lv]
    # insurance
    if _has(n, r"coverage gap|not covered|uncovered|without cover|no cover|sin cobertura|brecha de cobertura|unprotected|no (drought|hail|frost|heat|flood) (cover|insurance)"):
        f["coverageGap"] = True
    if _has(n, r"no insurance|uninsured|without insurance|not insured|sin seguro|no tienen seguro"):
        f["insured"] = False
    elif not f.get("coverageGap") and _has(n, r"(?<![a-z])(insured|con seguro|with insurance|asegurad[oa]s?)(?![a-z])"):
        f["insured"] = True
    # sort
    if _has(n, r"largest|biggest|most exposed|mayor exposicion|by exposure|by size"):
        q["sort"] = dict(by="ead", desc=True)
    elif _has(n, r"highest pd|riskiest pd|by pd|mayor pd"):
        q["sort"] = dict(by="pd", desc=True)
    elif _has(n, r"by provision|biggest provision|most provision|ecldelta") or intent == "provision":
        q["sort"] = dict(by="eclDelta", desc=True)
    # date
    wk = _read_week(n, a)
    q["week"] = wk if wk is not None else (int(week) if week is not None else a["meta"]["asOfDefault"])
    if intent == "what_if" and f.get("peril") and not f.get("level"):
        del f["peril"]                      # "if drought gets worse" names the scenario, not a filter
    beta0 = meta["params"]["beta"]
    if intent == "what_if":
        ym = re.search(r"yields?\s*(?:fall|fell|drop|down|lower|decline\w*|decrease\w*|reduc\w*)\s*(?:by)?\s*(\d+(?:[.,]\d+)?)\s*%", n) or re.search(r"(\d+(?:[.,]\d+)?)\s*%\s*(?:lower|less|drop in|decline in)\s*yields?", n)
        bm = re.search(r"(?<![a-z])beta\s*(?:=|to|of|at)?\s*(\d+(?:[.,]\d+)?)", n)
        wts = {k: _num(mm.group(1)) / 100 for k in ("base", "adverse", "severe") for mm in [re.search(rf"(?<![a-z]){k}\s*(?:weight|probability|prob)\w*\s*(?:of|to|=|at)?\s*(\d+(?:[.,]\d+)?)\s*%", n)] if mm}
        w_ = _num(drop.group(1)) if drop else 20.0
        if ym:
            q["whatIf"] = dict(yieldShock=-_num(ym.group(1)) / 100)
        elif bm:
            q["whatIf"] = dict(beta=_num(bm.group(1)))
        elif wts:
            q["whatIf"] = {}
        else:
            q["whatIf"] = dict(worsePct=w_, beta=round(beta0 * (1 + w_ / 100), 3), yieldShock=round(-w_ / 200, 4))
        if bm and ym:
            q["whatIf"]["beta"] = _num(bm.group(1))
        if wts:
            q["whatIf"]["scenarioWeights"] = _norm_weights(wts, meta["scenarios"])
    if intent == "stress_test":
        rp = re.search(r"1\s*[- ]?\s*(?:in|en)\s*[- ]?\s*(\d+)", n)
        q["returnPeriod"] = max(2, int(rp.group(1))) if rp else 100 if _has(n, r"p99") else 20
    if intent == "report":
        q["report"] = "loan_memo" if f.get("loanIds") else "early_warning" if _has(n, r"early|warning|alerta|temprana") else "portfolio" if _has(n, r"ifrs|provision|portfolio|portafolio|cartera") else "early_warning"
        if q["report"] == "early_warning" and not f.get("level") and f.get("minScore") is None:
            f["minScore"] = 25
        if f.get("loanIds"):
            q["intent"] = "loan"
        elif q["report"] == "portfolio":
            q["sort"] = dict(by="eclDelta", desc=True)
    return q


def _norm_weights(partial, base):
    w = dict(base)
    w.update({k: v for k, v in partial.items() if k in w})
    s = sum(w.values()) or 1.0
    return {k: round(v / s, 4) for k, v in w.items()}


# ------------------------------------------------------------------------------------------------ optional LLM parser
def _system_prompt(a):
    meta = a["meta"]
    return ("You convert a credit analyst's question about an agricultural loan book into JSON. Answer with ONE JSON object only, no prose, no markdown. You never compute numbers or answer the question.\n"
            "Schema: {\"intent\": one of " + json.dumps(list(INTENTS)) + ", \"filters\": {\"crop\": [..], \"regionId\": [..], \"country\": [..], \"level\": [..], \"peril\": [..], \"stage\": [1|2|3], \"insured\": true|false|null, "
            "\"coverageGap\": true|false|null, \"minScore\": number, \"maxScore\": number, \"minEad\": number, \"maxEad\": number, \"minPd\": number 0-1, \"maxPd\": number 0-1, \"loanIds\": [..], \"farmerIds\": [..], \"movedToStage2\": bool, \"farmHealth\": bool (Crop Health Index questions), \"minFhi\": number 0-100, \"maxFhi\": number 0-100}, "
            "\"week\": integer 0-51 or null, \"sort\": {\"by\": \"score\"|\"ead\"|\"eclDelta\"|\"pd\", \"desc\": bool}, \"limit\": integer, \"whatIf\": {\"beta\": number, \"scenarioWeights\": {\"base\":n,\"adverse\":n,\"severe\":n}, \"yieldShock\": number such as -0.1} or null, "
            "\"report\": \"portfolio\"|\"early_warning\"|\"loan_memo\"|null, \"returnPeriod\": integer (stress_test only)}. Omit filters that the question does not state.\n"
            "Vocabulary: crops " + json.dumps(list(meta["crops"])) + "; regions " + json.dumps([[r["id"], r["name"]] for r in meta["regions"]], ensure_ascii=False) + "; countries "
            + json.dumps(sorted({r["country"] for r in meta["regions"]})) + "; levels " + json.dumps(C.LEVELS) + "; perils " + json.dumps(list(PERILS)) + ". Loan ids look like L001. "
            "Weeks start on " + meta["weeks"][0] + " (week 0), one per 7 days. Spanish input is possible (soja=soy, maiz=maize, trigo=wheat, girasol=sunflower, sequia=drought, helada=frost, granizo=hail, inundacion=excess_water, sin seguro=insured false).")


def _clean_query(raw, a, week):
    meta = a["meta"]
    if not isinstance(raw, dict) or raw.get("intent") not in INTENTS:
        raise ValueError("bad intent")
    rf = raw.get("filters") or {}
    f = {}
    lists = dict(crop=set(meta["crops"]), regionId={r["id"] for r in meta["regions"]}, country={r["country"] for r in meta["regions"]}, level=set(C.LEVELS), peril=set(PERILS), stage={1, 2, 3})
    for k, ok in lists.items():
        if rf.get(k):
            v = [x for x in rf[k] if x in ok]
            if len(v) != len(rf[k]):
                raise ValueError(f"bad {k}")
            f[k] = v
    for k in ("insured", "coverageGap", "movedToStage2", "farmHealth"):
        if rf.get(k) is not None:
            f[k] = bool(rf[k])
    for k in ("minScore", "maxScore", "minEad", "maxEad", "minPd", "maxPd", "minFhi", "maxFhi"):
        if rf.get(k) is not None:
            f[k] = float(rf[k])
    for k in ("loanIds", "farmerIds"):
        if rf.get(k):
            f[k] = [str(x) for x in rf[k]][:200]
    wk = raw.get("week")
    wk = int(wk) if isinstance(wk, (int, float)) and 0 <= wk < len(meta["weeks"]) else (week if week is not None else meta["asOfDefault"])
    s = raw.get("sort") or {}
    sort = dict(by=s.get("by") if s.get("by") in ("score", "ead", "eclDelta", "pd", "fhi") else "score", desc=bool(s.get("desc", True)))
    q = dict(intent=raw["intent"], filters=f, week=wk, sort=sort, limit=max(1, min(200, int(raw.get("limit") or 50))), whatIf=None, report=None)
    wi = raw.get("whatIf")
    if q["intent"] == "what_if":
        wi = wi or {}
        q["whatIf"] = {}
        if wi.get("beta") is not None:
            q["whatIf"]["beta"] = max(0.0, min(20.0, float(wi["beta"])))
        if wi.get("yieldShock") is not None:
            q["whatIf"]["yieldShock"] = max(-0.9, min(0.5, float(wi["yieldShock"])))
        if isinstance(wi.get("scenarioWeights"), dict):
            q["whatIf"]["scenarioWeights"] = _norm_weights({k: float(v) for k, v in wi["scenarioWeights"].items() if k in meta["scenarios"]}, meta["scenarios"])
        if not q["whatIf"]:
            q["whatIf"] = dict(yieldShock=-0.1, beta=round(meta["params"]["beta"] * 1.2, 3))
    if raw.get("report") in ("portfolio", "early_warning", "loan_memo"):
        q["report"] = raw["report"]
    if q["intent"] == "report" and not q["report"]:
        q["report"] = "early_warning"
    if q["intent"] == "stress_test":
        q["returnPeriod"] = max(2, int(raw.get("returnPeriod") or 20))
    return q


def llm_parse(text, a, week=None):
    body = json.dumps(dict(model=C.LLM_MODEL, max_tokens=700, system=_system_prompt(a), messages=[dict(role="user", content=text)])).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, method="POST", headers={
        "content-type": "application/json", "x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=20) as r:
        out = json.loads(r.read())["content"][0]["text"].strip()
    out = re.sub(r"^```(?:json)?|```$", "", out.strip(), flags=re.M).strip()
    return _clean_query(json.loads(out), a, week)


# ------------------------------------------------------------------------------------------------ what we understood
def understood_of(q, a):
    meta, f = a["meta"], q["filters"]
    w = q["week"]
    why = dict(list="Show the matching loans", provision="How much climate adds to provisions (IFRS 9 ECL)", stress_test=f"Stress test: {q.get('returnPeriod', 20)}-year loss from the historical seasons",
               loan="Explain one loan", compare_regions="Compare regions", alerts="What got worse in the last 2 weeks", what_if="What-if scenario against today", report="Prepare a report")
    u = [why[q["intent"]] + (" (early warning)" if q.get("report") == "early_warning" else " (IFRS 9 portfolio)" if q.get("report") == "portfolio" else " (loan memo)" if q.get("report") == "loan_memo" else "")]
    if f.get("loanIds"):
        u.append("Loan: " + ", ".join(f["loanIds"]))
    if f.get("crop"):
        u.append("Crop: " + ", ".join(meta["crops"][c]["label"].lower() for c in f["crop"]))
    if f.get("regionId"):
        u.append("Region: " + "; ".join(r["name"] for r in meta["regions"] if r["id"] in f["regionId"]))
    if f.get("country"):
        u.append("Country: " + ", ".join(f["country"]))
    if f.get("level"):
        u.append("Stress: " + " or ".join(f["level"]))
    if f.get("peril"):
        u.append("Main peril: " + " or ".join(PERIL_NAME[p] for p in f["peril"]))
    if f.get("stage"):
        u.append("Moved to IFRS 9 Stage 2 in the last month" if f.get("movedToStage2") else f"IFRS 9 Stage {' or '.join(str(s) for s in f['stage'])}")
    if f.get("insured") is False:
        u.append("No insurance at all")
    if f.get("insured") is True:
        u.append("Insured")
    if f.get("coverageGap"):
        u.append("No cover for the main peril")
    if f.get("minEad") is not None:
        u.append(f"Outstanding over {_usd(f['minEad'])}")
    if f.get("maxEad") is not None:
        u.append(f"Outstanding under {_usd(f['maxEad'])}")
    if f.get("minPd") is not None:
        u.append(f"PD above {_pct(f['minPd'], 1)}")
    if f.get("maxPd") is not None:
        u.append(f"PD below {_pct(f['maxPd'], 1)}")
    if f.get("farmHealth"):
        u.append("Crop Health Index CHI (display indicator, not used in PD)" + (f" below {f['maxFhi']:.0f}" if f.get("maxFhi") is not None else "") + (f" at or above {f['minFhi']:.0f}" if f.get("minFhi") is not None else "")
                 + (", highest first" if q["sort"].get("by") == "fhi" and q["sort"].get("desc") else ", lowest first"))
    if f.get("minScore") is not None:
        u.append(f"Stress score {f['minScore']:.0f}+" + (" (Watch or above)" if q.get("report") == "early_warning" else ""))
    if f.get("maxScore") is not None:
        u.append(f"Stress score under {f['maxScore']:.0f}")
    wi = q.get("whatIf")
    if wi:
        bits = []
        if wi.get("worsePct") is not None:
            bits.append(f"drought {wi['worsePct']:g}% worse")
        if wi.get("beta") is not None:
            bits.append(f"climate sensitivity beta {wi['beta']:g}")
        if wi.get("yieldShock") is not None:
            bits.append(f"yields {wi['yieldShock'] * 100:+.0f}%")
        if wi.get("scenarioWeights"):
            bits.append("scenario weights " + "/".join(f"{k} {v:.0%}" for k, v in wi["scenarioWeights"].items()))
        u.append("Scenario: " + ", ".join(bits))
    u.append(f"As of: {week_label(a, w)} (week {w})")
    if q["limit"] != 50:
        u.append(f"Top {q['limit']}")
    return u


# ------------------------------------------------------------------------------------------------ what-if recomputation
def _loss_anoms(L, w):
    y = L["yield"]
    p10, p50 = y["p10"][w] or 0.0, y["p50"][w] or 0.0
    an = L["analogs"][w]
    worst = min([x["yieldAnom"] for x in an], default=None)
    sev = min(p10, worst) if worst is not None else p10 - 0.5 * (p50 - p10)
    return dict(base=p50, adverse=p10, severe=sev)


def _ecl_scenarios(a, L, w, beta, shock, snap):
    """(ecl by scenario, base PD, stage) with the given beta and an additive yield shock (all scenarios)."""
    cr = L["credit"]
    sch = ifrs9.Schedule(L, snap)
    an = _loss_anoms(L, w)
    pd0 = L["pdOrig"]
    pds = {s: float(ifrs9.pd_from_loss(pd0, max(0.0, -(v + shock)), beta)) for s, v in an.items()}
    stage = cr["stage"][w]
    if stage == 1 and pds["base"] >= a["meta"]["params"]["sicrMultiplier"] * pd0:
        stage = 2
    full = lambda v: np.full(C.W, v, float)
    out = {}
    for s in ("base", "adverse", "severe"):
        pd_s = 1.0 if stage == 3 else pds[s]
        e, _ = ifrs9.ecl_paths(sch, full(pd_s), full(cr["lgd"][w]), np.full(C.W, stage))
        out[s] = float(e[w])
    return out, pds["base"], stage


def what_if(a, vs, w, wi):
    meta = a["meta"]
    beta0 = meta["params"]["beta"]
    beta = wi.get("beta", beta0)
    shock = wi.get("yieldShock", 0.0) or 0.0
    wts = wi.get("scenarioWeights") or meta["scenarios"]
    snap = date.fromisoformat(meta.get("snapshotDate") or meta["weeks"][meta["asOfDefault"]])
    cur_w = sum(v.wtd for v in vs)
    new_w, s2_new, s2_ead_new, newly, pd_now, pd_new = 0.0, 0, 0.0, [], 0.0, 0.0
    cur_s2 = sum(1 for v in vs if v.stage == 2); cur_s2_ead = sum(v.ead for v in vs if v.stage == 2)
    for v in vs:
        ref, _, _ = _ecl_scenarios(a, v.L, w, beta0, 0.0, snap)
        sc, pdb, st = _ecl_scenarios(a, v.L, w, beta, shock, snap)
        ref_w = sum(meta["scenarios"][k] * ref[k] for k in ref)
        new_w += v.wtd + sum(wts[k] * sc[k] for k in sc) - ref_w
        if st == 2:
            s2_new += 1; s2_ead_new += v.ead
        if st == 2 and v.stage == 1:
            newly.append(v)
        pd_now += v.pd * v.ead; pd_new += (1.0 if st == 3 else pdb) * v.ead
    ead = sum(v.ead for v in vs) or 1.0
    return dict(cur=cur_w, new=new_w, cur_s2=cur_s2, new_s2=s2_new, cur_s2_ead=cur_s2_ead, new_s2_ead=s2_ead_new, newly=newly, pd_cur=pd_now / ead, pd_new=pd_new / ead, ead=ead)


# ------------------------------------------------------------------------------------------------ answers
def _scope(f, meta):
    crop = " and ".join(f["crop"]) if f.get("crop") else None
    regs = [r["name"].split("·")[0].strip() for r in meta["regions"] if r["id"] in (f.get("regionId") or [])]
    reg = " and ".join(dict.fromkeys(regs)) if regs else (" and ".join(f["country"]) if f.get("country") else None)
    return dict(crop=crop, reg=reg, text=f"{crop + ' ' if crop else ''}loans{' in ' + reg if reg else ''}", any=bool(crop or reg),
                for_=f" for {crop + ' ' if crop else ''}loans{' in ' + reg if reg else ''}" if (crop or reg) else "")


def _conditions(f, meta):
    c = []
    if f.get("level"):
        c.append("are " + " or ".join(f["level"]))
    if f.get("peril"):
        c.append("have " + " or ".join(PERIL_NAME[p] for p in f["peril"]) + " as the main peril")
    if f.get("movedToStage2"):
        c.append("moved to Stage 2 in the last month")
    elif f.get("stage"):
        c.append("are in Stage " + " or ".join(str(s) for s in f["stage"]))
    if f.get("insured") is False:
        c.append("have no insurance")
    elif f.get("insured") is True:
        c.append("are insured")
    if f.get("coverageGap"):
        c.append("have no cover for their main peril")
    if f.get("minEad") is not None:
        c.append(f"are over {_usd(f['minEad'])}")
    if f.get("maxEad") is not None:
        c.append(f"are under {_usd(f['maxEad'])}")
    if f.get("minPd") is not None:
        c.append(f"have climate-adjusted PD above {_pct(f['minPd'], 1)}")
    if f.get("maxPd") is not None:
        c.append(f"have climate-adjusted PD below {_pct(f['maxPd'], 1)}")
    if f.get("maxFhi") is not None:
        c.append(f"have a Crop Health Index (CHI) below {f['maxFhi']:.0f}")
    if f.get("minFhi") is not None:
        c.append(f"have a Crop Health Index (CHI) of {f['minFhi']:.0f} or more")
    if f.get("minScore") is not None:
        c.append(f"score {f['minScore']:.0f}+ on climate stress")
    if f.get("maxScore") is not None:
        c.append(f"score under {f['maxScore']:.0f}")
    return c


def _join(x):
    return "".join(x) if len(x) < 2 else ", ".join(x[:-1]) + " and " + x[-1]


def _region_table(vs, meta, by):
    rows = []
    for r in meta["regions"]:
        rr = [v for v in vs if v.L["regionId"] == r["id"]]
        if not rr:
            continue
        st = [v for v in rr if v.level in ("High", "Severe")]
        ead, sead = sum(v.ead for v in rr), sum(v.ead for v in st)
        rows.append((r["name"], len(rr), ead, sead, sum(v.bank for v in rr), sum(v.wtd for v in rr), sum(1 for v in rr if v.stage == 2)))
    rows.sort(key=lambda t: -(t[3] if by == "stressed" else t[5] - t[4]))
    return dict(columns=["Region", "Loans", "Outstanding", "Under stress", "Share stressed", "ECL bank", "ECL with climate", "Change", "Stage 2"],
                rows=[[n, c, _usd(e), _usd(s), _pct(s / e if e else 0), _usd(b), _usd(x), _sgn(x - b), s2] for n, c, e, s, b, x, s2 in rows])


def _pdf_url(q, vs, w):
    kind = q.get("report")
    if not kind:
        return None
    url = f"/api/pdf/{kind}?week={w}"
    if kind == "loan_memo" and vs:
        url += f"&loan={vs[0].id}"
    elif kind == "early_warning" and vs and any(q["filters"].get(k) is not None for k in q["filters"] if k != "minScore" or len(q["filters"]) > 1):
        url += "&ids=" + ",".join(v.id for v in _sort(vs, q["sort"])[: q["limit"]])
    return url


def run_query(q, a):
    meta, f, w = a["meta"], q["filters"], q["week"]
    notes = []
    vs_all = _views(a, w)
    sc = _scope(f, meta)
    asof = f"{week_label(a, w)} (week {w})"
    matched = _apply(vs_all, f, a, w)
    ids = [v.id for v in _sort(matched, q["sort"])[: q["limit"]]]
    n = len(matched)
    ead = sum(v.ead for v in matched)
    bank, wtd = sum(v.bank for v in matched), sum(v.wtd for v in matched)
    s2 = sum(1 for v in matched if v.stage == 2)
    kpi_base = [dict(label="Loans", value=str(n)), dict(label="Outstanding", value=_usd(ead))]
    ans = dict(headline="", kpis=[], loanIds=[], table=None, notes=notes, suggestions=[])
    pdf = _pdf_url(q, matched, w)
    intent = q["intent"]

    def finish(**kw):
        ans.update(kw)
        if pdf:
            ans["pdf"] = pdf
        return ans

    if intent == "loan":
        v = matched[0] if matched else None
        if v is None:
            return finish(headline=f"No loan {', '.join(f.get('loanIds') or [])} in the book.", notes=[f"Loan ids look like L001."], suggestions=["Which loans are under severe stress?", "Show loans over $100k with PD above 10%"])
        L = v.L; pdo = L["pdOrig"]
        notes.extend([alerts_mod.explain(L, w), f"IFRS 9: Stage {v.stage} ({L['credit']['stageReason'][w]}).",
                      (f"Insurance: {L['insurance']['type']}" + (", which does not cover the main peril." if v.gap else ".")) if L["insurance"] else "No insurance on this loan.", PD_NOTE])
        rec = alerts_mod.recommend(L, w)
        notes.append(f"Recommended action: {rec['action']}. {rec['why']}")
        pk = alerts_mod.PERIL_LABEL.get(v.main, "")
        pdf = pdf or f"/api/pdf/loan_memo?week={w}&loan={v.id}"
        return finish(headline=f"{v.id} ({L['borrower']}, {L['crop']}, {L['region']}): {v.level} stress ({v.score:.0f})" + (f", mainly {pk}" if pk else "") + f"; PD {_pct(pdo, 1)} to {_pct(v.pd, 1)}, Stage {v.stage}, ECL {_sgn(v.delta)}.",
                      kpis=[dict(label="Stress", value=f"{v.level} · {v.score:.0f}"), dict(label="Outstanding", value=_usd(v.ead)), dict(label="PD bank to climate", value=f"{_pct(pdo, 1)} to {_pct(v.pd, 1)}"),
                            dict(label="IFRS 9", value=f"Stage {v.stage}"), dict(label="ECL change", value=_sgn(v.delta))],
                      loanIds=[v.id], suggestions=[f"Make the loan memo report for {v.id}", f"Which {L['crop']} loans in {L['region'].split('·')[0].strip()} are under stress?", "How much does climate add to provisions?"])

    if not n and intent in ("list", "provision", "compare_regions", "report"):
        what = "your question (" + ", ".join([x for x in [sc["text"] if sc["any"] else "", *_conditions(f, meta)] if x]) + ")" if (sc["any"] or _conditions(f, meta)) else "that"
        return finish(headline=f"No loans match {what} as of {asof}.", notes=["Nothing in the book fits every condition together. Try dropping one of the filters."],
                      suggestions=[f"Which {sc['text']} are under stress?" if sc["any"] else "Which loans are under severe stress?", "Compare regions by stressed exposure", "Alerts in the last two weeks"])

    if intent == "provision" or (intent == "report" and q.get("report") == "portfolio"):
        d = wtd - bank
        sce = {k: sum(getattr(v, k) for v in matched) for k in ("base", "adv", "sev")}
        notes.extend(["Bank ECL uses the bank's own PD and LGD at origination; the climate overlay moves PD with the expected yield, raises LGD in bad years and moves loans to Stage 2 on a critical alert or when PD reaches the SICR multiple.", PD_NOTE])
        return finish(headline=f"Climate adds {_sgn(d)} to provisions{(' on ' + sc['text']) if sc['any'] else ''} as of {asof}: ECL goes from {_usd(bank)} to {_usd(wtd)} ({'+' if d >= 0 else ''}{_pct(d / bank) if bank else 'n/a'}) on {n} loans, {s2} in Stage 2.",
                      kpis=kpi_base + [dict(label="ECL, bank", value=_usd(bank)), dict(label="ECL with climate", value=_usd(wtd)), dict(label="Change", value=_sgn(d)),
                                       dict(label="Base / adverse / severe", value=f"{_usd(sce['base'])} / {_usd(sce['adv'])} / {_usd(sce['sev'])}"), dict(label="Stage 2", value=f"{s2} · {_usd(sum(v.ead for v in matched if v.stage == 2))}")],
                      loanIds=ids, table=_region_table(matched, meta, "ecl"),
                      suggestions=[f"What if drought gets 20% worse{sc['for_']}?", f"Show Stage 2 {sc['text']}", "What is our 1-in-20-year loss?", f"Make the IFRS 9 report{sc['for_']}"])

    if intent == "stress_test":
        st = a["stressTest"]
        N = q.get("returnPeriod", 20)
        loss = np.array(st["loss"], float)
        p = 1 - 1 / N
        pn = float(np.quantile(loss, p)); p50 = float(np.median(loss)); wi = int(np.argmax(loss)); worst = float(loss[wi])
        tot = sum(v.ead for v in vs_all) or 1.0
        yr = lambda y: f"{y}/{str(y + 1)[2:]}"
        notes.extend([st.get("note", ""), f"A 1-in-{N} loss is read as the {p * 100:.0f}th percentile of only {len(loss)} historical seasons, so it is rough" + ("; the sample is shorter than the return period, so it is close to the worst season seen." if len(loss) < N else "."),
                      "The stress test covers the whole book; filters do not apply to it.", PD_NOTE])
        cur = st.get("currentLoss")
        return finish(headline=f"Approximate 1-in-{N}-year loss: {_usd(pn)} ({_pct(pn / tot, 1)} of {_usd(tot)} outstanding); median season {_usd(p50)}, worst past season {yr(st['years'][wi])} at {_usd(worst)}.",
                      kpis=[dict(label=f"1-in-{N}", value=_usd(pn)), dict(label="Median season", value=_usd(p50)), dict(label="Worst season", value=f"{_usd(worst)} · {yr(st['years'][wi])}"), dict(label="This season (base)", value=_usd(cur) if cur else "n/a")],
                      table=dict(columns=["Measure", "Expected loss", "% of outstanding"], rows=[["Median season (p50)", _usd(p50), _pct(p50 / tot, 1)], [f"1-in-{N} (p{p * 100:.0f})", _usd(pn), _pct(pn / tot, 1)],
                                                                                              ["99th percentile", _usd(st["p99"]), _pct(st["p99"] / tot, 1)], [f"Worst season ({yr(st['years'][wi])})", _usd(worst), _pct(worst / tot, 1)]]),
                      suggestions=["Compare regions by stressed exposure", "What if drought gets 20% worse?", "How much does climate add to provisions?"])

    if intent == "compare_regions":
        tb = _region_table(matched, meta, "stressed")
        stressed = [v for v in matched if v.level in ("High", "Severe")]
        share = (sum(v.ead for v in stressed) / ead) if ead else 0
        top = tb["rows"][0] if tb["rows"] else None
        notes.append("Stressed means level High or Severe. Regions are ranked by outstanding balance under stress, because shocks hit neighbouring borrowers together.")
        return finish(headline=(f"{top[0]} carries the most stressed exposure ({top[3]}, {top[4]} of its book); " if top else "") + f"across {sc['text'] if sc['any'] else 'the book'}, {_pct(share)} of {_usd(ead)} outstanding is under High or Severe stress as of {asof}.",
                      kpis=kpi_base + [dict(label="Under stress", value=_usd(sum(v.ead for v in stressed))), dict(label="Share stressed", value=_pct(share)), dict(label="Regions", value=str(len(tb["rows"])))],
                      table=tb, suggestions=[f"Which loans in {top[0].split('·')[0].strip()} are under stress?" if top else "Which loans are under stress?", "How much does climate add to provisions?", "What is our 1-in-20-year loss?"])

    if intent == "alerts":
        keep = {v.id: v for v in matched}
        if not f:
            keep = {v.id: v for v in vs_all if v.ead > 0}
        al = [x for x in a["alerts"] if w - 2 < x["week"] <= w and x["loanId"] in keep]
        worse = {}
        better = set()
        for x in sorted(al, key=lambda x: (x["week"], x["score"])):
            if x["kind"] == "better":
                better.add(x["loanId"])
            else:
                worse[x["loanId"]] = x
        better -= set(worse)
        wl = sorted(worse.values(), key=lambda x: -x["score"])
        wids = [x["loanId"] for x in wl] + sorted(better)
        wead = sum(keep[x["loanId"]].ead for x in wl)
        notes.append("An alert is a change of stress level (fixed score bands) in the last 2 weeks; loans that improved are listed after the ones that got worse." if better else "An alert is a change of stress level (fixed score bands) in the last 2 weeks.")
        return finish(headline=(f"{len(wl)} {sc['text'] if sc['any'] else 'loans'} got worse in the last 2 weeks to {asof}; {_usd(wead)} outstanding, {sum(1 for x in wl if x['to'] == 'Severe')} now Severe." if wl else f"No {sc['text'] if sc['any'] else 'loans'} got worse in the last 2 weeks to {asof}."),
                      kpis=[dict(label="Got worse", value=str(len(wl))), dict(label="New", value=str(sum(1 for x in wl if x['kind'] == 'new'))), dict(label="Now Severe", value=str(sum(1 for x in wl if x['to'] == 'Severe'))),
                            dict(label="Improved", value=str(len(better))), dict(label="Outstanding", value=_usd(wead))],
                      loanIds=wids[: q["limit"]], suggestions=[f"How much does climate add to provisions{sc['for_']}?", f"Make the early warning report{sc['for_']}", "Compare regions by stressed exposure"])

    if intent == "what_if":
        wi = q.get("whatIf") or dict(yieldShock=-0.1, beta=meta["params"]["beta"] * 1.2)
        r = what_if(a, matched, w, wi)
        parts = []
        if wi.get("worsePct") is not None:
            parts.append(f"drought gets {wi['worsePct']:g}% worse")
        elif wi.get("yieldShock") is not None:
            parts.append(f"yields fall {abs(wi['yieldShock']) * 100:.0f}%")
        if wi.get("beta") is not None and wi.get("worsePct") is None:
            parts.append(f"climate sensitivity beta is {wi['beta']:g}")
        if wi.get("scenarioWeights"):
            parts.append("scenario weights become " + "/".join(f"{k} {v:.0%}" for k, v in wi["scenarioWeights"].items()))
        label = " and ".join(parts) or "the scenario applies"
        notes.append("Method: PD = logit shift of the origination PD by beta x yield loss, recomputed for the base, adverse and severe yield outcomes with an additive yield shock; ECL via the same schedule and LGD, "
                     "added to the stored ECL as a difference. Stress scores and LGD are not re-simulated." + (f" 'Drought {wi['worsePct']:g}% worse' is modelled as beta x{1 + wi['worsePct'] / 100:.2f} and yields {wi['yieldShock'] * 100:+.1f}%." if wi.get("worsePct") is not None else ""))
        if r["newly"]:
            notes.append(f"The loans listed would newly move to Stage 2 ({len(r['newly'])}).")
        d = r["new"] - r["cur"]
        return finish(headline=f"If {label}{(' for ' + sc['text']) if sc['any'] else ''}, ECL rises from {_usd(r['cur'])} to {_usd(r['new'])} ({_sgn(d)}) and Stage 2 goes from {r['cur_s2']} to {r['new_s2']} loans, as of {asof}.",
                      kpis=[dict(label="ECL now", value=_usd(r["cur"])), dict(label="ECL in scenario", value=_usd(r["new"])), dict(label="Change", value=_sgn(d)), dict(label="Stage 2 now to scenario", value=f"{r['cur_s2']} to {r['new_s2']}"), dict(label="Outstanding", value=_usd(r["ead"]))],
                      loanIds=[v.id for v in sorted(r["newly"], key=lambda v: -v.ead)[: q["limit"]]],
                      table=dict(columns=["Measure", "Now", "Scenario", "Change"], rows=[["ECL with climate", _usd(r["cur"]), _usd(r["new"]), _sgn(d)], ["Loans in Stage 2", r["cur_s2"], r["new_s2"], f"{r['new_s2'] - r['cur_s2']:+d}"],
                                                                                          ["Outstanding in Stage 2", _usd(r["cur_s2_ead"]), _usd(r["new_s2_ead"]), _sgn(r["new_s2_ead"] - r["cur_s2_ead"])],
                                                                                          ["Average climate PD (by balance)", _pct(r["pd_cur"], 1), _pct(r["pd_new"], 1), f"{(r['pd_new'] - r['pd_cur']) * 100:+.1f} pts"]]),
                      suggestions=[f"What if drought gets 40% worse{sc['for_']}?", f"How much does climate add to provisions{sc['for_']}?", "What is our 1-in-20-year loss?"])

    if f.get("farmHealth") and intent == "list":
        sv = [v for v in _sort(matched, q["sort"])]
        mean = (sum(v.fhi * v.ead for v in matched) / ead) if ead else 0.0
        poor = [v for v in matched if v.fhi < 25]           # CHI v1: severely stressed or extreme
        notes.append("Crop Health Index (CHI v1, Sviana technical note): mean of the percentiles of vegetation (MODIS NDVI), soil moisture (SMAP; falls to 0 when waterlogged above the 85th percentile) and water adequacy (ET/PET) against this field's own past record for the same time of year, only while the crop is in the ground; 0-100, 50 = typical. Bands: 60+ above normal, 40-60 normal, 25-40 stressed, 10-25 severely stressed, under 10 extreme stress. "
                     "Shown for context; it does not change PD, staging or ECL. Only loans inside their crop season have a value.")
        if len(ids) < n:
            notes.append(f"Showing the first {len(ids)} of {n}.")
        ftxt = (f" below {f['maxFhi']:.0f}" if f.get("maxFhi") is not None else "") + (f" of {f['minFhi']:.0f} or more" if f.get("minFhi") is not None else "")
        what = f"{n} {sc['crop'] + ' ' if sc['crop'] else ''}loan{'' if n == 1 else 's'}{' in ' + sc['reg'] if sc['reg'] else ''} with a Crop Health Index (CHI){ftxt}"
        rows = [[v.id, v.L["borrower"], v.L["crop"], v.L["region"], f"{v.fhi:.0f}", _usd(v.ead)] for v in sv[: min(q["limit"], 15)]]
        low = sv[0] if sv and not q["sort"].get("desc") else None
        return finish(headline=f"{what}; average {mean:.0f} (balance-weighted), {len(poor)} severely stressed or worse (below 25), {_usd(ead)} outstanding, as of {asof}." + (f" Lowest: {low.id} at {low.fhi:.0f}." if low else ""),
                      kpis=kpi_base + [dict(label="Avg crop health (CHI)", value=f"{mean:.0f}"), dict(label="Below 25", value=str(len(poor)))],
                      loanIds=ids, table=dict(columns=["Loan", "Borrower", "Crop", "Region", "CHI", "Outstanding"], rows=rows) if rows else None,
                      suggestions=[f"Which loans are under stress{sc['for_']}?", "Show crop health below 25", "Show the lowest farm health in Córdoba"])

    # list (and early-warning / loan-memo reports)
    parts = _conditions(f, meta)
    gap = [v for v in matched if v.gap]
    head = f"{n} {sc['crop'] + ' ' if sc['crop'] else ''}loan{'' if n == 1 else 's'}{' in ' + sc['reg'] if sc['reg'] else ''}{' ' + _join(parts) if parts else ('' if sc['reg'] else ' in the book')}"
    notes.append(PD_NOTE)
    if len(ids) < n:
        notes.append(f"Showing the first {len(ids)} of {n}, ranked by {dict(eclDelta='provision change', ead='outstanding', pd='climate PD', fhi='Crop Health Index').get(q['sort']['by'], 'stress score')}.")
    if intent == "report":
        notes.append("Download the PDF with the link in this answer.")
    return finish(headline=f"{head}{' are in the early-warning list' if intent == 'report' else ''}; {_usd(ead)} outstanding, {len(gap)} without cover for their main peril ({_usd(sum(v.ead for v in gap))}).",
                  kpis=kpi_base + [dict(label="Stage 2", value=str(s2)), dict(label="Provision change", value=_sgn(wtd - bank)), dict(label="No cover, main peril", value=_usd(sum(v.ead for v in gap))),
                                   dict(label="Avg stress", value=f"{sum(v.score for v in matched) / n:.0f}")],
                  loanIds=ids, suggestions=[f"How much does climate add to provisions{sc['for_']}?", f"What if drought gets 20% worse{sc['for_']}?", f"Make the early warning report{sc['for_']}", "Compare regions by stressed exposure"])


# ------------------------------------------------------------------------------------------------ entry point
def ask(text: str, analysis: dict, week: int | None = None) -> dict:
    if not isinstance(text, str) or not text.strip():
        raise ValueError("text is required")
    if week is not None:
        week = int(week)
        if not 0 <= week < len(analysis["meta"]["weeks"]):
            raise ValueError(f"week must be 0..{len(analysis['meta']['weeks']) - 1}")
    parser, q = "rules", None
    if enabled_llm():
        try:
            q = llm_parse(text, analysis, week)
            parser = "llm"
        except Exception:
            q = None
    if q is None:
        q = rules_parse(text, analysis, week)
    q.setdefault("returnPeriod", 20) if q["intent"] == "stress_test" else None
    return dict(understood=understood_of(q, analysis), query=q, answer=run_query(q, analysis), parser=parser)
