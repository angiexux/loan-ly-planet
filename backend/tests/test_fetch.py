"""Offline parser tests for loanly.fetch_public (tiny recorded fixtures, no network): python3 -m unittest discover backend/tests"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from loanly import fetch_public as FP  # noqa: E402

FX = Path(__file__).parent / "fixtures"
load = lambda n: json.loads((FX / n).read_text())


class TestParsers(unittest.TestCase):
    def test_open_meteo(self):
        p = FP.parse_open_meteo(load("open_meteo_era5land.json"))
        self.assertEqual((p["tmin"], p["tmax"]), (22.3, 32.7))
        self.assertIsNone(p["precip_sum"])                       # era5_land daily precipitation is null on Open-Meteo
        self.assertAlmostEqual(p["soil_mean"], 0.268, delta=0.002)
        self.assertAlmostEqual(p["cell_lat"], -31.4, delta=0.01)

    def test_iri(self):
        self.assertAlmostEqual(FP.parse_iri("    4.231818    \n"), 4.231818)
        self.assertEqual(FP.parse_iri("   0.0000000E+00\n"), 0.0)
        self.assertIsNone(FP.parse_iri(""))
        self.assertIsNone(FP.parse_iri("NaN"))

    def test_modis(self):
        p = FP.parse_ornl_subset(load("ornl_mod13q1_subset.json"))
        self.assertAlmostEqual(p["ndvi"], 0.4007)
        self.assertEqual((p["reliability"], p["calendar_date"]), (0, "2023-01-17"))
        self.assertIsNone(FP.parse_ornl_subset({"subset": [{"band": "250m_16_days_NDVI", "data": [-3000], "modis_date": "A1", "calendar_date": "x"}]})["ndvi"])
        self.assertEqual(FP.parse_ornl_dates(load("ornl_dates.json"))[0], ("A2026241", "2026-08-29"))

    def test_modis_et_pet(self):
        p = FP.parse_ornl_et(load("ornl_mod16a2_subset.json"))
        self.assertAlmostEqual(p["et"], 4.8); self.assertAlmostEqual(p["pet"], 66.4)
        self.assertEqual((p["modis_date"], p["calendar_date"]), ("A2023017", "2023-01-17"))
        self.assertAlmostEqual(FP.water_availability(p["et"], p["pet"]), 0.072, places=3)
        fill = FP.parse_ornl_et({"subset": [{"band": "ET_500m", "data": [32766], "modis_date": "A1", "calendar_date": "x"}, {"band": "PET_500m", "data": [500], "modis_date": "A1", "calendar_date": "x"}]})
        self.assertIsNone(fill["et"]); self.assertEqual(fill["pet"], 50.0)
        self.assertIsNone(FP.water_availability(None, 50.0)); self.assertIsNone(FP.water_availability(5.0, 0.0))
        self.assertEqual(FP.water_availability(80.0, 60.0), 1.0)                         # capped at 1

    def test_planetary_computer_point_and_ndvi(self):
        v = FP.parse_pc_point(load("pc_point_s2.json"))
        self.assertEqual(v, {"B04": 2240.0, "B08": 3302.0, "SCL": 5.0})
        # baseline >= 04.00: subtract the 1000 DN offset -> (2302 - 1240) / (2302 + 1240)
        self.assertAlmostEqual(FP.s2_ndvi(2240, 3302, "04.00"), (2302 - 1240) / (2302 + 1240), places=6)
        self.assertAlmostEqual(FP.s2_ndvi(2240, 3302, "03.00"), (3302 - 2240) / (3302 + 2240), places=6)
        self.assertIsNone(FP.s2_ndvi(None, 100, "04.00"))
        # the verified example from the brief (-61.25,-31.45, 2023-01-26)
        self.assertAlmostEqual(FP.s2_ndvi(1448, 4604, "04.00"), 0.779, delta=0.001)

    def test_stac_dedupes_reprocessed_items(self):
        its = FP.parse_stac_items(load("stac_s2.json"))
        self.assertEqual(len(its), 2)
        newest = [i for i in its if i["datetime"].startswith("2023-01-21")][0]
        self.assertTrue(newest["id"].endswith("20240812T190359"))

    def test_cmr(self):
        g = FP.parse_cmr(load("cmr_smap.json"))
        self.assertEqual(len(g), 1)
        self.assertTrue(g[0]["url"].endswith(".h5") and "nsidc" in g[0]["url"])

    def test_source_line(self):
        it = FP._item(1.0, "mm/day", "2023-01-18", "CHIRPS", "v2", "0.05°", "http://x", "2026-11-07T16:58:00+00:00", where="-31.40, -61.20")
        self.assertEqual(it["sourceLine"], "Source: CHIRPS · v2 · 0.05° at -31.40, -61.20 · 18 Jan 2023 · fetched 7 Nov 2026 16:58 UTC")

    def test_smap_needs_netrc(self):
        import netrc
        orig = netrc.netrc
        netrc.netrc = lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError())
        try:
            self.assertFalse(FP.smap_available())
        finally:
            netrc.netrc = orig


if __name__ == "__main__":
    unittest.main()
