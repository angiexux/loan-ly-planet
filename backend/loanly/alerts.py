"""Module 9 (METHODS 9): alerts, explanations and recommendations.

* Alerts = level transitions of the score. Levels are fixed score bands (Watch 25, High 45, Severe 70) of the
  season-smoothed score, so an alert is a real change, not weekly noise. kind: new (Normal -> anything), worse (up between non-normal levels), better (down).
* Explanations: a deterministic TEMPLATE built only from computed numbers. Optionally an LLM rewords the template into one or two
  plain sentences (env ANTHROPIC_API_KEY set and LOANLY_LLM=1; Anthropic Messages API over urllib; only numbers + template are sent;
  results cached in backend/cache/explanations.json). Any failure falls back to the template.
* Recommendations: a rule table (situation -> action). No model involved.
"""
from __future__ import annotations

import hashlib
import json
import os
import urllib.request

import numpy as np

from . import config as C

LEVEL_NAME = C.LEVELS
A_CONTACT, A_STAGE2 = "Contact the borrower", "Confirm Stage 2 classification"
A_CLAIM, A_PARAM = "File insurance claim and route payout to the loan", "Offer parametric cover next season"
A_RESTRUCT, A_TRANSFER, A_NONE = "Restructure / extend maturity", "Transfer / sell the loan", "No action"
CACHE = C.ROOT / "backend" / "cache" / "explanations.json"
PERIL_LABEL = dict(drought="drought", excess_water="excess water", frost="frost", heat="heat", hail="hail")


def _pct(x):
    return f"{x * 100:+.0f}%"


PERIL_FLOOR = C.PERIL_MAIN_MIN - 0.5   # quiet perils publish a 1-34 pressure; a triggered peril (>= PERIL_MAIN_MIN) can be the main one


def dominant_peril(L: dict, w: int):
    """Main peril of a loan in week w. Heat during an active/confirmed drought is the hot-dry form of that drought, so it is
    attributed to the drought (insurance, wording and recommendations then follow the drought)."""
    best, k = PERIL_FLOOR, None
    for p, arr in L["perils"].items():
        if arr[w] is not None and arr[w] > best:
            best, k = arr[w], p
    if k == "heat" and (L.get("cascade") or ["none"] * (w + 1))[w] in ("active", "confirmed"):
        k, best = "drought", max(best, L["perils"]["drought"][w] or 0)
    return k, best


def explain(L: dict, w: int) -> str:
    """Template explanation of one loan in one week, from the numbers in its analysis record."""
    lvl, score = L["level"][w], L["score"][w]
    k, inten = dominant_peril(L, w)
    crop = L["crop"]; st = L["stage"][w]
    parts = []
    if st == "Pre-sowing":
        parts.append(f"{crop.capitalize()} field not sown yet.")
    elif st == "Harvested":
        parts.append(f"{crop.capitalize()} already harvested.")
    else:
        parts.append(f"{crop.capitalize()} is in {st.lower()} (stage weight {L['stageWeight'][w]:.1f}).")
    spi60, sm, z = L["spi60"][w], L["smPct"][w], L["ndviZ"][w]
    if k == "drought":
        parts.append(f"Drought {L['cascade'][w]}: 60-day rain is {spi60:.1f} SD from normal (SPI-60), soil moisture is at the {sm:.0f}th percentile"
                     + (f" and NDVI is {abs(z):.1f} SD below this field's own history." if z < -1 and L["stageWeight"][w] >= 0.3 else "."))
    elif k == "excess_water":
        parts.append(f"Excess water: SPI-30 {L['spi30'][w]:.1f}, soil at the {sm:.0f}th percentile, radar flooded share {L['water'][w]:.0%}.")
    elif k == "frost":
        parts.append(f"Frost: weekly minimum {L['tmin'][w]:.1f} C while the crop is frost-sensitive.")
    elif k == "heat":
        parts.append(f"Heat: {L['hotDays'][w]:.0f} days above 35 C this week during flowering.")
    elif k == "hail":
        parts.append(f"Sudden NDVI drop (z {z:.1f}) without a rain deficit, a pattern typical of hail damage.")
    else:
        parts.append(f"No significant stress signal (SPI-60 {spi60:.1f}, NDVI z {z:.1f}).")
    y = L["yield"]
    if y["p50"][w] is not None:
        parts.append(f"Expected yield {_pct(y['p50'][w])} vs normal (range {_pct(y['p10'][w])} to {_pct(y['p90'][w])}).")
    an = L["analogs"][w]
    if an:
        parts.append(f"Closest past season: {an[0]['year']}/{str(an[0]['year'] + 1)[2:]} (yield {_pct(an[0]['yieldAnom'])}).")
    parts.append(f"Risk level {lvl} (score {score:.0f}, confidence {L['confidence'][w]:.0%}).")
    return " ".join(parts)


def recommend(L: dict, w: int) -> dict:
    lvl, stage = L["level"][w], L["credit"]["stage"][w]
    k, _ = dominant_peril(L, w)
    ins = L.get("insurance")
    met = L["credit"].get("insuranceMet", [False] * C.W)[w] if "insuranceMet" in L["credit"] else False
    p50 = L["yield"]["p50"][w] or 0.0
    reason = L["credit"]["stageReason"][w]
    mat_weeks = max(0, (np.datetime64(L["maturity"]) - np.datetime64(C.WEEK_DATES[w].isoformat())).astype(int) // 7)
    if lvl in ("High", "Severe") and met and ins:
        return dict(action=A_CLAIM, why=f"The {ins['type']} policy covers {PERIL_LABEL.get(k, k)} and its trigger is met; route the payout to loan {L['id']} ({ins['coverShare']:.0%} cover).")
    if stage == 3:
        sec = L["collateral"] in ("land mortgage", "machinery pledge")
        return dict(action=A_RESTRUCT if sec else A_TRANSFER, why=f"Stage 3 ({reason}); " + ("secured by " + L["collateral"] + ": restructure or extend." if sec else "weak collateral: consider selling or transferring."))
    if lvl == "Severe":
        if mat_weeks <= 12 and p50 <= -0.25:
            return dict(action=A_RESTRUCT, why=f"Maturity in {mat_weeks} weeks but expected yield is {_pct(p50)}; repayment capacity will not recover in time.")
        return dict(action=A_STAGE2, why=f"Critical alert (score {L['score'][w]:.0f}); PD is {L['credit']['pd12'][w] / max(L['pdOrig'], 1e-6):.1f}x its origination level.")
    if lvl == "High":
        if L["stage"][w] in ("Harvested",) or L["stageWeight"][w] <= 0.1:
            return dict(action=A_PARAM, why=f"Season damage ({_pct(p50)} expected yield) without drought cover; offer parametric cover next season.")
        return dict(action=A_CONTACT, why=f"High climate stress ({PERIL_LABEL.get(k, 'mixed signals')}); expected yield {_pct(p50)}. Discuss cash-flow and insurance." + ("" if (ins and 'drought' in ins['perils']) else " No drought cover on file."))
    if lvl == "Watch":
        return dict(action=A_NONE, why="Early stress signal; keep monitoring. Escalates if the score passes 45.")
    return dict(action=A_NONE, why="No significant climate stress.")


# ------------------------------------------------------------------------------------------------ optional LLM wording
_cache = None


def _load_cache():
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(CACHE.read_text())
        except Exception:
            _cache = {}
    return _cache


def llm_enabled() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY")) and os.environ.get("LOANLY_LLM") == "1"


def reword(template: str, calls: list) -> str:
    """Reword the template with the LLM (cached). Falls back to the template on any problem."""
    if not llm_enabled():
        return template
    cache = _load_cache()
    key = hashlib.sha1(template.encode()).hexdigest()
    if key in cache:
        return cache[key]
    if len(calls) >= C.LLM_MAX_CALLS:
        return template
    calls.append(1)
    try:
        body = json.dumps(dict(model=C.LLM_MODEL, max_tokens=200, system=(
            "You rewrite a credit-risk note for a bank officer. Reword the text in one or two plain sentences. "
            "Use ONLY the facts and numbers in the text; do not add, infer or round anything."),
            messages=[dict(role="user", content=template)])).encode()
        req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, method="POST", headers={
            "content-type": "application/json", "x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"})
        with urllib.request.urlopen(req, timeout=15) as r:
            txt = json.loads(r.read())["content"][0]["text"].strip()
        if not txt:
            return template
        cache[key] = txt
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(cache, ensure_ascii=False))
        return txt
    except Exception:
        return template


def generate(loans_out: list, active: np.ndarray) -> list:
    """Alerts from level transitions. loans_out: finished loan dicts; active (N,W) bool."""
    alerts, calls = [], []
    for i, L in enumerate(loans_out):
        lv = L["level"]
        for w in range(1, C.W):
            if lv[w] == lv[w - 1] or not active[i, w]:
                continue
            a, b = LEVEL_NAME.index(lv[w - 1]), LEVEL_NAME.index(lv[w])
            kind = "better" if b < a else ("new" if a == 0 else "worse")
            alerts.append(dict(week=w, loanId=L["id"], **{"from": lv[w - 1]}, to=lv[w], kind=kind, score=round(L["score"][w], 1),
                               explanation=explain(L, w), recommendation=recommend(L, w)))
    alerts.sort(key=lambda a: (-a["week"], -a["score"]))
    if llm_enabled():
        for a in alerts[: C.LLM_MAX_CALLS * 2]:
            a["explanation"] = reword(a["explanation"], calls)
    return alerts
