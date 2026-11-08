"""Alert notes store: python3 -m unittest discover backend/tests"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from loanly import alert_notes as N  # noqa: E402

OK = dict(loanId="L093", week=10, author="Ana", response="Called", actionPlan="Review in 2 weeks", status="open")


class TestAlertNotes(unittest.TestCase):
    def test_add_and_load(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "sub" / "n.json"
            self.assertEqual(N.load(p), [])
            a = N.add(OK, p)
            b = N.add({**OK, "status": "done"}, p)
            self.assertNotEqual(a["id"], b["id"])
            self.assertIn("at", a)
            self.assertEqual([n["status"] for n in N.load(p)], ["open", "done"])

    def test_validation(self):
        bad = [{**OK, "loanId": "x" * 21}, {**OK, "loanId": ""}, {**OK, "response": "x" * 2001}, {**OK, "status": "late"}, {**OK, "author": "a" * 61},
               {**OK, "week": "3"}, {**OK, "response": "", "actionPlan": ""}, [1]]
        for body in bad:
            with self.assertRaises(ValueError, msg=str(body)):
                N.validate(body)


if __name__ == "__main__":
    unittest.main()
