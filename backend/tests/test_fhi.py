"""Crop Health Index (CHI v1): python3 -m unittest discover backend/tests

Checks loanly/fhi.py against the worked examples (Table 4), the rules (Eqs. 2, 5, 7, 8, Table 3) and the note's event test (Sec. 7).
CHI deliberately differs from the team's original script (loanly/fhi_calc.py, kept unmodified): waterlogging penalty, past-only
reference sets and the winter season, so the old script-equivalence test was replaced."""
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from loanly import config as C, fetch_earth_engine, fhi, synthetic  # noqa: E402

SCRIPT = ROOT / "backend" / "loanly" / "fhi_calc.py"


def _frames():
    specs = [dict(field_id="T1", lat=-33.1, lng=-64.3, crop="soy", sow_week=24, irrigated=False),
             dict(field_id="T2", lat=-35.6, lng=-63.7, crop="wheat", sow_week=4, irrigated=False)]
    src = synthetic.generate_sources(specs)
    wk = fetch_earth_engine.aggregate_weekly(src)
    et, pet = synthetic.et_pet_weekly(src, wk)
    return [fhi.series_frame(wk["ndvi"][f], wk["ndvi_obs"][f], wk["soil"][f], et[f], pet[f]) for f in range(2)], src, wk, et, pet


def _ref(below: int, ties: int, n: int, x: float = 50.0):
    """a reference set with `below` values under x, `ties` equal to x and the rest above (Table 4 lists these counts)"""
    return [x - 1.0] * below + [x] * ties + [x + 1.0] * (n - below - ties)


class TestWorkedExamples(unittest.TestCase):
    """CHI note, Table 4: three hypothetical fields in slot 2 (mid-January, soybean flowering)."""
    def _case(self, nd, sm, wa):
        V = fhi.pr(50.0, _ref(*nd)); SMp = fhi.pr(50.0, _ref(*sm)); W = fhi.pr(50.0, _ref(*wa))
        S = float(fhi.soil_two_sided([SMp])[0])
        return V, SMp, S, W, float(fhi.combine([V], [S], [W], np.array([True]))[0])

    def test_a_drought(self):
        V, SMp, S, W, chi = self._case((6, 0, 75), (3, 0, 33), (5, 0, 72))
        self.assertAlmostEqual(V, 8.0, 1); self.assertAlmostEqual(S, 9.1, 1); self.assertAlmostEqual(W, 6.9, 1)
        self.assertAlmostEqual(chi, 8.0, 1); self.assertEqual(fhi.label(chi), "extreme stress")

    def test_b_waterlogging(self):
        V, SMp, S, W, chi = self._case((30, 0, 75), (32, 0, 33), (50, 0, 72))
        self.assertAlmostEqual(SMp, 97.0, 1); self.assertAlmostEqual(S, 17.2, 1); self.assertAlmostEqual(W, 69.4, 1)
        self.assertAlmostEqual(chi, 42.2, 1); self.assertEqual(fhi.label(chi), "normal")
        self.assertAlmostEqual((V + SMp + W) / 3, 68.8, 1)          # the original index (no waterlogging rule) scored it above normal

    def test_c_normal(self):
        V, SMp, S, W, chi = self._case((41, 1, 75), (20, 0, 33), (34, 1, 72))
        self.assertAlmostEqual(V, 55.3, 1); self.assertAlmostEqual(S, 60.6, 1); self.assertAlmostEqual(W, 47.9, 1)
        self.assertAlmostEqual(chi, 54.6, 1)


class TestOnSyntheticFields(unittest.TestCase):
    def test_reference_excludes_own_year_and_event_test(self):
        frames, *_ = _frames()
        res = fhi.compute_fhi(frames[0], "10-04", critical="01-02")
        self.assertGreater(int(res["CHI"].notna().sum()), 100)
        self.assertTrue(((res["CHI"].dropna() >= 0) & (res["CHI"].dropna() <= 100)).all())
        # a constant series ranks every value at 50 against the other years (never against itself)
        d = frames[0].copy(); d["ndvi_modis"] = 0.5
        self.assertTrue(np.allclose(fhi.compute_fhi(d, "10-04")["VCI_p"].dropna(), 50.0))
        # event test (note, Sec. 7): the current (drought-scenario) season's critical-period CHI is clearly low -- in the worst five of the 22 seasons
        # (2008/09, 2017/18 and 2021/22 were Pampas droughts too) and in the severely-stressed band, far below a normal season
        bc = fhi.by_campaign(res)
        crit = bc["CHI_crit"].dropna().sort_values()
        self.assertIn(C.SEASON_LABEL, list(crit.index[:5]))
        self.assertLess(crit[C.SEASON_LABEL], 25)
        self.assertGreater(crit.median() - crit[C.SEASON_LABEL], 25)

    def test_partial_and_fill(self):
        frames, *_ = _frames()
        d = frames[0].copy(); d["sm"] = np.nan; d.loc[d.index[:10], "pet"] = 3300.0
        res = fhi.compute_fhi(d, "10-04")
        ok = res["CHI"].notna()
        self.assertTrue(res.loc[ok, "partial"].all())                  # only V and W left -> partial
        filled = res.sort_values("date")["pet"].isna()
        self.assertGreaterEqual(int(filled.sum()), 10)                 # PET >= 3270 mm is a fill code and is dropped

    def test_season_mask_uses_field_dates(self):
        frames, *_ = _frames()
        n = len(frames[0]); present = [None] * (n - C.W) + [False] * C.W
        res = fhi.compute_fhi(frames[0], "10-04", present=present)
        self.assertTrue(res["CHI"].iloc[-C.W:].isna().all())          # not in the ground this season -> no CHI


class TestRules(unittest.TestCase):
    def test_two_sided_soil(self):
        got = fhi.soil_two_sided([0, 50, 85, 90, 100, 97, np.nan])
        np.testing.assert_allclose(got[:6], [0, 50, 85, 85 * 10 / 15, 0, 85 * 3 / 15])   # Eq. 5: linear to 0 at the 100th percentile
        self.assertTrue(np.isnan(got[6]))

    def test_bands(self):
        self.assertEqual([fhi.label(v) for v in (75, 60, 50, 40, 30, 25, 15, 10, 5, None)],
                         ["above normal", "above normal", "normal", "normal", "stressed", "stressed", "severely stressed", "severely stressed", "extreme stress", "n/a"])

    def test_needs_two_components(self):
        inseas = np.array([True] * 5)
        v = fhi.combine([60, 60, np.nan, np.nan, 60], [40, np.nan, 40, np.nan, np.nan], [np.nan, np.nan, np.nan, np.nan, 90], inseas)
        np.testing.assert_allclose(v[[0, 4]], [50, 75])
        self.assertTrue(np.isnan(v[1]) and np.isnan(v[2]) and np.isnan(v[3]))
        out = fhi.combine([60], [40], [50], np.array([False]))      # outside the crop season
        self.assertTrue(np.isnan(out[0]))

    def test_campaign_and_season(self):
        d = pd.Series(pd.to_datetime(["2023-01-18", "2022-06-01", "2022-07-01"]))
        self.assertEqual(list(fhi.campaign_label(d)), ["2022/23", "2021/22", "2022/23"])
        np.testing.assert_array_equal(fhi.in_season([10, 12, 1, 4, 5, 9], "10-04"), [1, 1, 1, 1, 0, 0])
        np.testing.assert_array_equal(fhi.in_season([5, 6, 11, 12, 1], "06-12"), [0, 1, 1, 1, 0])

    def test_percentile_ties_half_and_min_refs(self):
        dates = pd.to_datetime([f"{2000 + i}-01-18" for i in range(6)])
        df = pd.DataFrame({"date": dates, "ndvi_modis": [1, 2, 3, 3, 4, 5.0], "sm": np.nan, "et": np.nan, "pet": np.nan})
        r = fhi.compute_fhi(df)
        self.assertAlmostEqual(r.loc[2, "VCI_p"], 100 * (2 + 0.5 * 2) / 6)
        self.assertTrue(r["SMp"].isna().all() and r["FHI"].isna().all())
        self.assertTrue(fhi.compute_fhi(df.iloc[:4])["VCI_p"].isna().all())      # < 5 references


class TestSyntheticEtPet(unittest.TestCase):
    def test_physical_consistency(self):
        frames, src, wk, et, pet = _frames()
        self.assertTrue(np.all(et <= pet + 1e-9) and np.all(pet > 0))
        summer = (np.arange(C.W) >= 24) & (np.arange(C.W) <= 36)
        winter = (np.arange(C.W) <= 6)
        self.assertGreater(pet[0][:, summer].mean(), 2 * pet[0][:, winter].mean())
        wa = et / pet
        self.assertLess(wa[0, C.CUR, summer].mean(), wa[0, :C.N_HIST, :][:, summer].mean())    # current-season drought hits the Cordoba field


if __name__ == "__main__":
    unittest.main()
