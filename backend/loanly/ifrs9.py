"""Module 7 (METHODS 7): credit risk and IFRS 9 expected credit loss (ECL).  IFRS 9-aligned, NOT audit-ready.

PD  logit(PD_new) = logit(PD_orig) + beta x expected yield loss.  PD_orig is the bank's 12-month PD at origination. Scenarios:
      base    yield loss from the p50 prediction
      adverse yield loss from the p10 prediction (a bad draw inside the model's own range)
      severe  the worse of p10 and the worst of the 3 analog seasons (a repeat of the closest bad year); if no analogs yet,
              p10 minus half the p50-p10 gap
    Scenario weights 60 / 25 / 15 (config).
Staging (base scenario)
      Stage 3  BCRA situacion >= 3 or > 90 days past due                      -> PD = 100 %
      Stage 2  BCRA situacion 2 or > 30 days past due, or a critical alert (level Severe), or PD_now >= 2 x PD_orig (SICR)
      Stage 1  otherwise.  The climate stage is never better than the delinquency stage.
LGD  base = bank LGD, scaled by collateral coverage now vs at origination (crop-based collateral loses value with the yield loss),
      then x (1 - insurance cover share) if the policy covers the currently active peril and its trigger is met.
EAD  outstanding principal from the repayment schedule at each future month (scheduled payments assumed made; unpaid past-due
      instalments stay outstanding, and so do all later ones: cross-default).
ECL = sum over months t of marginal PD_t x LGD x EAD_t x DF_t   (monthly buckets, DF = (1+r)^-(t-0.5)/12)
      Stage 1: next 12 months (or to maturity if sooner).  Stage 2: remaining lifetime; for a short crop loan (<12 months left) we ADD
      ONE YEAR of assumed restructuring term, because a Stage 2 crop loan is expected to be rolled over, not just repaid:
      the unpaid balance at maturity then amortises linearly over those 12 months.  Stage 3: LGD x EAD (PD = 1).
Timing of PD: for a crop loan the annual PD is treated as the PD of the whole crop cycle, realised by maturity (a harvest failure shows
      at repayment), so cumulative PD reaches PD_12m at maturity (or at month 12 for longer loans) and grows at the annual rate afterwards.
Bank baseline ECL: PD and LGD at origination, Stage 1 -- except loans the bank itself already classifies as delinquent (Stage 2/3 from
      BCRA/days past due), so that the difference "climate - baseline" isolates the climate effect.
All PD sensitivities (beta, SICR multiplier, scenario weights) are assumptions to be calibrated on the lender's own data.
"""
from __future__ import annotations

import re
from datetime import date

import numpy as np

from . import config as C

W = C.W
WD = np.array([d.toordinal() for d in C.WEEK_DATES])
MD = 30.4375
SCEN = ("base", "adverse", "severe")


def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def expit(x):
    return 1 / (1 + np.exp(-x))


def pd_from_loss(pd0, loss, beta=None):
    return np.minimum(C.PD_CAP, expit(logit(pd0) + (C.BETA if beta is None else beta) * np.maximum(loss, 0)))


def _sit_from_dpd(dpd):
    return np.where(dpd > 365, 5, np.where(dpd > 180, 4, np.where(dpd > 90, 3, np.where(dpd > 31, 2, 1))))


class Schedule:
    """Repayment schedule of one loan: outstanding principal at any date and delinquency status reconstructed from the snapshot."""

    def __init__(self, loan: dict, snapshot: date):
        self.snap = snapshot.toordinal()
        self.orig = date.fromisoformat(loan["originated"]).toordinal()
        rows = sorted(loan["schedule"], key=lambda r: r["date"])
        self.due = np.array([date.fromisoformat(r["date"]).toordinal() for r in rows])
        self.prin = np.array([r["principal"] for r in rows], float)
        if self.prin.sum() <= 0:
            self.prin = np.zeros(len(rows)); self.prin[-1] = loan["amountUsd"]
        self.total = float(self.prin.sum())
        self.dpd0 = int(loan["daysPastDue"]); self.bcra0 = int(loan["bcraSituacion"])
        settle, stuck = [], False
        for r, due in zip(rows, self.due):
            if r.get("paidDate"):
                settle.append(date.fromisoformat(r["paidDate"]).toordinal())
            elif (due <= self.snap and self.dpd0 > 0) or stuck:
                settle.append(10 ** 9); stuck = True            # unpaid past-due instalment: still outstanding, later ones too
            else:
                settle.append(int(due))                         # scheduled payment assumed made on its due date
        self.settle = np.array(settle)
        self.last_due = int(self.due.max())
        self.since = self.snap - self.dpd0 if self.dpd0 > 0 else self.snap

    def outstanding(self, d: np.ndarray) -> np.ndarray:
        d = np.asarray(d)
        paid = sum(p * (self.settle[k] <= d) for k, p in enumerate(self.prin))
        return np.where(d >= self.orig, self.total - paid, 0.0)

    def dpd(self, d):
        return np.maximum(0, np.asarray(d) - self.since) if self.dpd0 > 0 else np.zeros(np.shape(d), int)

    def bcra(self, d):
        dp = self.dpd(d)
        if self.dpd0 > 0:
            return np.minimum(self.bcra0, _sit_from_dpd(dp))
        return np.where(np.asarray(d) >= self.snap, self.bcra0, 1)

    def delinquency_stage(self, d):
        dp = self.dpd(d); b = self.bcra(d)
        st = np.vectorize(lambda x: C.BCRA_STAGE.get(int(x), 3))(b)
        return np.maximum(st, np.where(dp > C.DPD_STAGE3, 3, np.where(dp > C.DPD_STAGE2, 2, 1)))


def lgd_factor(loan: dict, ead_now, loss):
    """Collateral coverage now vs at origination (>1 means a worse recovery now). Crop-based collateral loses value with the yield loss."""
    if loan["collateral"] == "unsecured" or loan["collateralValue"] <= 0:
        return np.ones_like(loss)
    val = loan["collateralValue"] * (1 - loss if loan["collateral"] in C.CROP_BASED_COLLATERAL else 1.0)
    adj = lambda c: np.clip(1 + 0.5 * (1 - np.minimum(c, 2.0)), 0.75, 1.5)
    cov0 = loan["collateralValue"] / max(loan["amountUsd"], 1.0)
    return adj(val / np.maximum(ead_now, 1.0)) / adj(cov0)


def insurance_trigger(loan: dict, perils: dict, spi: dict, win_start: int) -> np.ndarray:
    """(W,) bool: does the policy cover a peril that is active this week AND is its trigger met?"""
    ins = loan.get("insurance")
    met = np.zeros(W, bool)
    if not ins:
        return met
    covered = [p for p in ins["perils"] if p in perils]
    if ins["type"] == "parametric":
        m = re.search(r"SPI-?(\d+)\s*<\s*(-?\d+\.?\d*)", ins.get("trigger") or "")
        if m and f"spi{m.group(1)}" in spi and "drought" in covered:
            s = spi[f"spi{m.group(1)}"]
            run_min = np.minimum.accumulate(np.where(np.arange(W) >= win_start, s, np.inf))
            return run_min < float(m.group(2))
    for p in covered:
        met |= perils[p] >= 40
    return met


def ecl_paths(sch: Schedule, pd12, lgd, stage, bank_stage_override=None):
    """Monthly-bucket ECL for every week. pd12, lgd, stage are (W,). Returns ecl (W,), pd_life (W,)."""
    M = C.MAX_MONTHS
    t = np.arange(1, M + 1)[None, :]
    D = WD[:, None] + np.round(MD * (t - 1)).astype(int)
    out_M = sch.outstanding(D)                                            # balance at the start of each future month
    out_now = sch.outstanding(WD)
    T = (sch.last_due - WD) / MD
    ceilT = np.ceil(np.maximum(T, 0))[:, None]
    ext = np.where((T <= 12), C.RESTRUCTURING_EXTENSION_MONTHS, 0)[:, None]      # Stage 2 on a short crop loan: +1 year
    bal_mat = sch.outstanding(np.full(W, sch.last_due - 1))[:, None]
    T0 = np.clip(T, 1, 12)[:, None]
    tau = np.where(t <= T0, t / T0, 1 + (t - T0) / 12.0)
    tau_prev = np.where(t - 1 <= T0, (t - 1) / T0, 1 + (t - 1 - T0) / 12.0)
    surv = (1 - np.clip(pd12, 0, 0.999999))[:, None]
    F = 1 - surv ** tau; F_prev = 1 - surv ** tau_prev
    mpd = F - F_prev
    df = (1 + C.DISCOUNT_RATE) ** (-(t - 0.5) / 12.0)
    st = np.asarray(stage)[:, None]
    n1 = np.clip(ceilT, 1, 12)
    ead1 = np.where(t <= n1, out_M, 0.0)
    E = np.maximum(ext, 1)
    ead2 = np.where(t <= ceilT, out_M, np.where(t <= ceilT + ext, bal_mat * (1 - (t - ceilT - 1) / E), 0.0))
    ead = np.where(st == 1, ead1, ead2)
    ecl = (mpd * ead * df).sum(1) * lgd
    hor = np.where(st[:, 0] == 1, n1[:, 0], np.maximum(ceilT[:, 0] + ext[:, 0], 1)).astype(int)
    hor = np.clip(hor, 1, M)
    pd_life = F[np.arange(W), hor - 1]
    # Stage 3: PD = 1, loss = LGD x EAD (discounted half a month)
    s3 = np.asarray(stage) == 3
    ecl = np.where(s3, lgd * out_now * df[0, 0], ecl)
    pd_life = np.where(s3, 1.0, pd_life)
    return ecl, pd_life


def loan_credit(loan: dict, snapshot: date, level: np.ndarray, perils: dict, spi: dict, p10, p50, p90, analog_worst, irrigated_factor: float, win_start: int) -> dict:
    """Full credit block of one loan: arrays of length W."""
    sch = Schedule(loan, snapshot)
    ead_now = sch.outstanding(WD)
    active = (WD >= sch.orig) & (ead_now > 0)
    k = irrigated_factor
    loss = {"base": np.maximum(0, -p50)}
    loss["adverse"] = np.maximum(0, -p10)
    sev_anom = np.where(np.isnan(analog_worst), p10 - 0.5 * (p50 - p10), np.minimum(p10, analog_worst * np.where(analog_worst < 0, k, 1.0)))
    loss["severe"] = np.maximum(0, -sev_anom)
    pd0 = loan["pdOrig"]
    pds = {s: pd_from_loss(pd0, loss[s]) for s in SCEN}
    # --- staging on the base scenario
    st_del = sch.delinquency_stage(WD)
    sicr = pds["base"] >= C.SICR_MULTIPLIER * pd0
    sev = level == 3
    stage = np.maximum(st_del, np.where(sicr | sev, 2, 1))
    stage = np.where(active, stage, 1)
    dp = sch.dpd(WD)
    reason = np.where(~active, "inactive", np.where(st_del == 3, np.where(dp > C.DPD_STAGE3, "dpd_90", "bcra_3plus"),
                      np.where(st_del == 2, np.where(dp > C.DPD_STAGE2, "dpd_30", "bcra_2"),
                      np.where(sev, "critical_alert", np.where(sicr, "pd_2x_origination", "performing")))))
    # --- LGD with collateral and insurance
    met = insurance_trigger(loan, perils, spi, win_start)
    cover = (loan["insurance"] or {}).get("coverShare", 0.0)
    lgd = {s: np.clip(loan["lgdBank"] * lgd_factor(loan, ead_now, loss[s]), C.LGD_FLOOR, C.LGD_CAP) * np.where(met, 1 - cover, 1.0) for s in SCEN}
    # --- ECL per scenario, weighted, and the bank baseline
    ecl, life = {}, {}
    for s in SCEN:
        ecl[s], life[s] = ecl_paths(sch, pds[s], lgd[s], stage)
    weighted = sum(C.SCENARIO_WEIGHTS[s] * ecl[s] for s in SCEN)
    bank_stage = np.where(active, st_del, 1)
    ecl_bank, _ = ecl_paths(sch, np.full(W, pd0), np.full(W, loan["lgdBank"]), bank_stage)
    a = active.astype(float)
    pd12 = np.where(stage == 3, 1.0, pds["base"])
    return dict(pd12=pd12, pdLife=life["base"], stage=stage.astype(int), stageReason=list(reason), lgd=lgd["base"], ead=ead_now * a,
                eclBank=ecl_bank * a, ecl=dict(base=ecl["base"] * a, adverse=ecl["adverse"] * a, severe=ecl["severe"] * a, weighted=weighted * a),
                active=active, insuranceMet=met, loss=loss, schedule=sch)
