"""PDF reports and the ask endpoint logic: python3 -m unittest discover backend/tests"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from loanly import ask as ask_mod, pdf_reports  # noqa: E402

A = json.loads((ROOT / "web" / "public" / "data" / "analysis.json").read_text())
W = A["meta"]["asOfDefault"]
LOANS = {l["id"]: l for l in A["loans"]}


def pick(pred):
    return next(l["id"] for l in A["loans"] if l["credit"]["ead"][W] > 0 and pred(l))


STRESSED_INSURED = pick(lambda l: l["level"][W] == "Severe" and l["insurance"] and l["credit"]["insuranceMet"][W])
UNINSURED_SEVERE = pick(lambda l: l["level"][W] == "Severe" and not l["insurance"])


def pages(b):
    return b.count(b"/Type /Page\n") + b.count(b"/Type /Page ") if False else sum(1 for _ in __import__("re").finditer(rb"/Type\s*/Page[^s]", b))


class TestPdf(unittest.TestCase):
    def check(self, kind, loan=None, ids=None, **kw):
        b = pdf_reports.build_pdf(kind, A, W, loan, ids, **kw)
        self.assertTrue(b.startswith(b"%PDF"), kind)
        self.assertGreater(len(b), 5000, kind)
        self.assertGreaterEqual(pages(b), 1)
        return b

    def test_portfolio_and_early_warning(self):
        self.check("portfolio")
        self.check("early_warning")
        self.check("early_warning", ids=[STRESSED_INSURED, UNINSURED_SEVERE])

    def test_loan_level_kinds_for_stressed_insured_and_uninsured(self):
        for kind in ("loan_memo", "claim", "restructure", "downgrade", "transfer", "cover_offer", "contact", "insurance_application"):
            self.check(kind, STRESSED_INSURED)
        for kind in ("loan_memo", "restructure", "downgrade", "transfer", "cover_offer", "contact", "insurance_application"):
            self.check(kind, UNINSURED_SEVERE)
        self.check("insurance_application", UNINSURED_SEVERE, product="multi_peril")

    def test_validation(self):
        with self.assertRaises(ValueError):
            pdf_reports.build_pdf("nope", A, W)
        with self.assertRaises(ValueError):
            pdf_reports.build_pdf("loan_memo", A, W)          # needs a loan
        with self.assertRaises(ValueError):
            pdf_reports.build_pdf("claim", A, W, "L999")      # unknown loan
        with self.assertRaises(ValueError):
            pdf_reports.build_pdf("claim", A, W, UNINSURED_SEVERE)   # nothing to claim on
        with self.assertRaises(ValueError):
            pdf_reports.build_pdf("portfolio", A, 999)

    def test_kinds_list(self):
        ks = {k["kind"]: k["needsLoan"] for k in pdf_reports.list_kinds()}
        self.assertFalse(ks["portfolio"]); self.assertTrue(ks["insurance_application"]); self.assertEqual(len(ks), 10)


EXAMPLES = {
    "Which soy loans in Santa Fe are under severe drought and have no insurance?": "list",
    "How much does climate add to provisions this quarter?": "provision",
    "What is our 1-in-20-year loss?": "stress_test",
    "Show loans that moved to Stage 2 this month": "list",
    "Compare regions by stressed exposure": "compare_regions",
    "What if drought gets 20% worse?": "what_if",
    "Explain loan L047": "loan",
    "Explain loan AR-CS-004": "loan",
    "Alerts in the last two weeks for maize": "alerts",
    "Make the early warning report for Entre Ríos": "report",
    "Loans over $100k with PD above 10%": "list",
    "préstamos de soja sin seguro con sequía severa": "list",
    "¿Cuál es la pérdida 1 en 20 años?": "stress_test",
}


class TestAsk(unittest.TestCase):
    def test_examples(self):
        for text, intent in EXAMPLES.items():
            r = ask_mod.ask(text, A)
            self.assertTrue(r["understood"], text)
            self.assertEqual(r["query"]["intent"], intent, text)
            self.assertEqual(r["parser"], "rules")
            self.assertTrue(r["answer"]["headline"], text)
            self.assertIn("kpis", r["answer"]); self.assertIn("suggestions", r["answer"])

    def test_filters(self):
        f = ask_mod.ask("Which soy loans in Santa Fe are severe with no insurance?", A)
        self.assertEqual(f["query"]["filters"], dict(crop=["soy"], regionId=["AR-SF"], level=["Severe"], insured=False))
        for lid in f["answer"]["loanIds"]:
            L = LOANS[lid]
            self.assertEqual((L["crop"], L["regionId"], L["level"][W], L["insurance"]), ("soy", "AR-SF", "Severe", None))
        r = ask_mod.ask("Loans over $100k with PD above 10%", A)
        self.assertEqual(r["query"]["filters"], dict(minEad=100000.0, minPd=0.1))
        for lid in r["answer"]["loanIds"]:
            self.assertGreater(LOANS[lid]["credit"]["ead"][W], 100000); self.assertGreater(LOANS[lid]["credit"]["pd12"][W], 0.1)

    def test_stage3_returns_delinquent_loans(self):
        want = sorted(l["id"] for l in A["loans"] if l["credit"]["ead"][W] > 0 and l["credit"]["stage"][W] == 3)
        self.assertTrue(want)
        r = ask_mod.ask("Show stage 3 loans", A)
        self.assertEqual(r["query"]["filters"]["stage"], [3])
        self.assertEqual(sorted(r["answer"]["loanIds"]), want)

    def test_report_has_pdf(self):
        r = ask_mod.ask("Make the early warning report for Entre Ríos", A)
        self.assertEqual(r["query"]["report"], "early_warning")
        self.assertTrue(r["answer"]["pdf"].startswith("/api/pdf/early_warning?week="))
        self.assertEqual(ask_mod.ask("report for loan " + STRESSED_INSURED, A)["query"]["intent"], "loan")

    def test_stress_test_uses_analysis(self):
        r = ask_mod.ask("What is our 1-in-20-year loss?", A)
        self.assertEqual(r["query"]["returnPeriod"], 20)
        self.assertIn("$1.31M", r["answer"]["headline"])     # p95 of the stress-test loss distribution in analysis.json

    def test_what_if_zero_shock_is_neutral_and_shock_raises_ecl(self):
        vs = [v for v in ask_mod._views(A, W) if v.ead > 0][:40]
        same = ask_mod.what_if(A, vs, W, dict(yieldShock=0.0, beta=A["meta"]["params"]["beta"]))
        self.assertAlmostEqual(same["new"], same["cur"], delta=1.0)
        worse = ask_mod.what_if(A, vs, W, dict(yieldShock=-0.1, beta=A["meta"]["params"]["beta"] * 1.2))
        self.assertGreater(worse["new"], worse["cur"])

    def test_llm_off_without_key(self):
        self.assertFalse(ask_mod.enabled_llm())

    def test_bad_input(self):
        with self.assertRaises(ValueError):
            ask_mod.ask("  ", A)
        with self.assertRaises(ValueError):
            ask_mod.ask("hi", A, 99)


if __name__ == "__main__":
    unittest.main()
