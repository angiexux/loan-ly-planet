"""Core checks: python3 -m unittest discover backend/tests"""
import json
import sys
import unittest
from datetime import date
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from loanly import anomalies, config as C, crop_calendar, fetch_earth_engine, ifrs9, stress  # noqa: E402


class TestAnomalies(unittest.TestCase):
    def test_spi_of_gamma_sample_is_standard_normal(self):
        rng = np.random.default_rng(1)
        sample = rng.gamma(2.0, 30.0, 4000)
        z = anomalies.spi_1d(sample, sample)
        self.assertAlmostEqual(float(z.mean()), 0.0, delta=0.05)
        self.assertAlmostEqual(float(z.std()), 1.0, delta=0.05)

    def test_vectorised_spi_matches_standard_normal(self):
        rng = np.random.default_rng(2)
        tot = np.tile(rng.gamma(2.0, 30.0, (1, 22, 1)), (1, 1, 3))
        z = anomalies.spi(tot)[:, :21]
        self.assertAlmostEqual(float(z.mean()), 0.0, delta=0.15)
        self.assertAlmostEqual(float(z.std()), 1.0, delta=0.15)

    def test_spi_zero_rain_uses_mixed_distribution(self):
        sample = np.r_[np.zeros(30), np.random.default_rng(3).gamma(2, 20, 70)]
        z = anomalies.spi_1d(sample, [0.0, 500.0])
        self.assertLess(z[0], -0.4)       # zero rain is very dry
        self.assertGreater(z[1], 1.5)

    def test_z_and_percentile(self):
        x = np.zeros((1, 22, 1)); x[0, :21, 0] = np.arange(21); x[0, 21, 0] = 10
        mean, sd, p10, p90 = anomalies.climatology(x)
        self.assertAlmostEqual(float(mean[0, 0]), 10.0)
        self.assertAlmostEqual(float(anomalies.zscore(x, mean, sd)[0, 21, 0]), 0.0, places=6)
        pct = anomalies.percentile_rank(x)[0, 21, 0]
        self.assertAlmostEqual(float(pct), 50.0, delta=3)
        self.assertAlmostEqual(float(p10[0, 0]), 2.0)


class TestStress(unittest.TestCase):
    def test_hysteresis_does_not_flicker(self):
        s = np.array([20, 26, 24, 26, 23, 27, 22, 26, 21, 19, 26, 24], float)       # oscillates around the Watch threshold (25)
        lvl = stress.hysteresis(s, up=[25, 45, 70], down=[20, 38, 62])   # the helper still supports a lower exit bar
        self.assertEqual(int(lvl[1]), 1)
        self.assertTrue(np.all(lvl[1:9] == 1))        # stays Watch until the score drops below 20
        self.assertEqual(int(lvl[9]), 0)
        naive = (s >= 25).astype(int)
        self.assertGreater(np.abs(np.diff(naive)).sum(), np.abs(np.diff(lvl)).sum())

    def test_levels_are_fixed_score_bands(self):
        s = np.array([1, 24.9, 25, 44.9, 45, 69.9, 70, 99, 60, 30, 10], float)
        self.assertEqual(stress.hysteresis(s).tolist(), [0, 0, 1, 1, 2, 2, 3, 3, 2, 1, 0])   # config: Normal 1-24, Watch 25-44, High 45-69, Severe 70-99

    def test_accumulate_decays_and_freezes_after_harvest(self):
        inst = np.zeros(20); inst[2] = 100
        sc = stress.accumulate(inst)
        self.assertTrue(sc[3] > sc[10] > 0)
        hold = np.zeros(20, bool); hold[5:] = True
        self.assertAlmostEqual(float(stress.accumulate(inst, hold=hold)[5]), float(stress.accumulate(inst, hold=hold)[19]))


class TestCleaning(unittest.TestCase):
    def test_savgol_and_interpolation_fill_gaps(self):
        wk = np.arange(52)
        truth = 0.25 + 0.5 * np.exp(-((wk - 30) / 6.0) ** 2)
        day = np.arange(0, 364, 3)
        val = np.interp(day / 7, wk, truth)
        cloud = (np.arange(len(day)) % 7 < 3)
        cloud[(day >= 100) & (day < 140)] = True          # a 6-week hole
        r = fetch_earth_engine.weekly_series(day, val, cloud)
        self.assertTrue(np.isnan(r["obs"]).any())          # raw medians have gaps
        self.assertFalse(np.isnan(r["ndvi"]).any())        # smoothed series does not
        self.assertLess(float(np.abs(r["ndvi"] - truth).max()), 0.12)
        self.assertTrue(np.all((r["cloud_free"] >= 0) & (r["cloud_free"] <= 1)))


class TestPhenology(unittest.TestCase):
    def test_detects_sowing_within_two_weeks(self):
        wk = np.arange(52)
        for crop in C.CROPS:
            dur = C.CROP_DURATION[crop]
            for sow in (3, 10, 20):
                if sow + dur >= 52:
                    continue
                t = wk - sow
                up = 1 / (1 + np.exp(-(t - dur * 0.28) / 1.6)); down = 1 / (1 + np.exp((t - dur * 0.82) / 1.4))
                y = 0.22 + 0.6 * up * down + np.random.default_rng(sow).normal(0, 0.01, 52)
                d = crop_calendar.detect_sowing(y, crop)
                self.assertIsNotNone(d)
                self.assertLessEqual(abs(d - sow), 2, f"{crop} sown {sow}, detected {d}")

    def test_stage_weights(self):
        names, w = crop_calendar.stage_series("soy", 20)
        self.assertEqual(names[0], "Pre-sowing")
        self.assertEqual(names[20], "Emergence")
        self.assertEqual(max(w), 1.0)
        self.assertEqual(names[51], "Harvested")


class TestIfrs9(unittest.TestCase):
    def _loan(self, dpd=0, bcra=1):
        return dict(originated="2025-10-01", amountUsd=100000.0, ratePct=10.0, pdOrig=0.03, lgdBank=0.4, collateral="unsecured", collateralValue=0.0,
                    bcraSituacion=bcra, daysPastDue=dpd, insurance=None,
                    schedule=[dict(date="2026-05-15", principal=100000.0, interest=5000.0, paidDate=None, paidUsd=None)])

    def test_stage3_uses_pd_one(self):
        loan = self._loan(dpd=120, bcra=3)
        snap = C.WEEK_DATES[33]
        z = np.zeros(C.W)
        out = ifrs9.loan_credit(loan, snap, np.zeros(C.W, int), {k: z for k in stress.PERILS}, {"spi30": z, "spi60": z, "spi90": z},
                                z - 0.05, z - 0.02, z + 0.02, np.full(C.W, np.nan), 1.0, 30)
        self.assertEqual(int(out["stage"][40]), 3)
        self.assertEqual(float(out["pd12"][40]), 1.0)
        self.assertEqual(float(out["pdLife"][40]), 1.0)
        self.assertAlmostEqual(float(out["ecl"]["base"][40]), float(out["lgd"][40] * out["ead"][40] / (1 + C.DISCOUNT_RATE) ** (0.5 / 12)), delta=2.0)

    def test_stage1_ecl_below_stage2_and_pd_logit_shift(self):
        self.assertGreater(float(ifrs9.pd_from_loss(0.03, 0.4)), 0.03)
        self.assertAlmostEqual(float(ifrs9.pd_from_loss(0.03, 0.0)), 0.03, places=6)
        loan = self._loan()
        snap = C.WEEK_DATES[33]
        z = np.zeros(C.W)
        calm = ifrs9.loan_credit(loan, snap, np.zeros(C.W, int), {k: z for k in stress.PERILS}, {"spi30": z, "spi60": z, "spi90": z}, z, z, z, np.full(C.W, np.nan), 1.0, 30)
        sick = ifrs9.loan_credit(loan, snap, np.full(C.W, 3), {k: z for k in stress.PERILS}, {"spi30": z, "spi60": z, "spi90": z}, z - 0.6, z - 0.5, z - 0.3, np.full(C.W, np.nan), 1.0, 30)
        self.assertEqual(int(calm["stage"][33]), 1)
        self.assertEqual(int(sick["stage"][33]), 2)
        self.assertGreater(sick["ecl"]["weighted"][33], calm["ecl"]["weighted"][33])

    def test_scenario_weights_sum_to_one(self):
        self.assertAlmostEqual(sum(C.SCENARIO_WEIGHTS.values()), 1.0)
        self.assertEqual(set(C.SCENARIO_WEIGHTS), {"base", "adverse", "severe"})


class TestAnalysisJson(unittest.TestCase):
    PATH = ROOT / "web" / "public" / "data" / "analysis.json"

    @classmethod
    def setUpClass(cls):
        if not cls.PATH.exists():
            raise unittest.SkipTest("run python3 backend/pipeline.py first")
        cls.a = json.loads(cls.PATH.read_text())

    def test_top_level_and_meta(self):
        a = self.a
        self.assertEqual(set(["meta", "loans", "portfolio", "stressTest", "alerts", "validation"]), set(a) & {"meta", "loans", "portfolio", "stressTest", "alerts", "validation"})
        for k in ("lender", "season", "synthetic", "generatedAt", "weeks", "asOfDefault", "histYears", "crops", "regions", "scenarios", "params", "methods"):
            self.assertIn(k, a["meta"])
        self.assertEqual(len(a["meta"]["weeks"]), 52)
        self.assertAlmostEqual(sum(a["meta"]["scenarios"].values()), 1.0)
        self.assertEqual(a["meta"]["params"]["hysteresis"], {"up": [25, 45, 70], "down": [25, 45, 70]})   # fixed score bands

    def test_loan_keys_and_lengths(self):
        l = self.a["loans"][0]
        static = "id farmerId borrower fieldId country region regionId lat lng ring crop areaHa farmHa irrigated product amountUsd originated maturity ratePct schedule ratingOrig pdOrig lgdBank collateral collateralValue bcraSituacion daysPastDue insurance otherBankDebt uploaded sowing".split()
        weekly = "stage stageWeight ndviObs ndvi cloudFree ndviZ ndviPct spi30 spi60 spi90 smPct tmin hotDays water rainWeek rainNormal score level cascade confidence reasons analogs".split()
        for k in static + weekly + ["clim", "perils", "yield", "expectedYieldTHa", "yieldHistory", "credit", "outcome"]:
            self.assertIn(k, l, k)
        for k in weekly:
            self.assertEqual(len(l[k]), 52, k)
        for k in ("mean", "sd", "p10", "p90"):
            self.assertEqual(len(l["clim"][k]), 52)
        self.assertEqual(set(l["perils"]), {"drought", "excess_water", "frost", "heat", "hail"})
        for k in ("p10", "p50", "p90"):
            self.assertEqual(len(l["yield"][k]), 52)
        for k in ("pd12", "pdLife", "stage", "stageReason", "lgd", "ead", "eclBank"):
            self.assertEqual(len(l["credit"][k]), 52, k)
        for k in ("base", "adverse", "severe", "weighted"):
            self.assertEqual(len(l["credit"]["ecl"][k]), 52)
        self.assertEqual(set(l["outcome"]), {"yieldAnom", "defaulted"})
        self.assertTrue(all(v in ("Normal", "Watch", "High", "Severe") for v in l["level"]))
        self.assertTrue(all(v in ("none", "early", "active", "confirmed") for v in l["cascade"]))
        self.assertTrue(all(0 <= v <= 100 for v in l["score"]))

    def test_portfolio_and_validation(self):
        p = self.a["portfolio"]
        for k in ("exposure", "ead", "stressedEad", "eclBank", "stage2", "stage3", "clusters"):
            self.assertEqual(len(p[k]), 52, k)
        for k in ("Normal", "Watch", "High", "Severe"):
            self.assertEqual(len(p["byLevel"][k]), 52)
        for k in ("base", "adverse", "severe", "weighted"):
            self.assertEqual(len(p["ecl"][k]), 52)
        self.assertIn("byRegion", p["concentration"]); self.assertIn("byCrop", p["concentration"])
        st = self.a["stressTest"]
        self.assertEqual(len(st["years"]), 21); self.assertEqual(len(st["loss"]), 21)
        for k in ("p50", "p95", "p99", "worstYear"):
            self.assertIn(k, st)
        self.assertEqual(len(self.a["validation"]["backtest"]), 52)
        self.assertTrue(all(set(m) >= {"regionId", "crop", "n", "r2Loyo", "maeLoyo", "method"} for m in self.a["validation"]["yieldModel"]))
        for al in self.a["alerts"][:20]:
            self.assertTrue(set(al) >= {"week", "loanId", "from", "to", "kind", "score", "explanation", "recommendation"})
            self.assertIn(al["kind"], ("new", "worse", "better"))


if __name__ == "__main__":
    unittest.main()
