#!/usr/bin/env python3
"""Generate samples/sample_farmers_10.xlsx and samples/loan_book_template.xlsx (all data fictional).
Usage: python3 samples/make_samples.py"""
import math
from datetime import date, datetime
from pathlib import Path
from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

OUT = Path(__file__).resolve().parent
ASOF = date(2023, 3, 31)
FERN = PatternFill("solid", fgColor="5DBB63")
HFONT = Font(bold=True, color="1B2A1C")

COLS = {
 "Farmers": ["farmer_id","name","tax_id","country","province","department","farm_ha","years_as_client","other_bank_debt_usd","notes"],
 "Fields": ["field_id","farmer_id","lat","lng","polygon_wkt","area_ha","crop","sowing_date","irrigated"],
 "Loans": ["loan_id","farmer_id","field_id","product","amount_usd","origination_date","maturity_date","rate_pct","amortization",
           "rating_origination","pd_12m_origination","lgd_bank","collateral_type","collateral_value_usd","bcra_situacion","days_past_due"],
 "Repayments": ["loan_id","due_date","principal_usd","interest_usd","paid_date","paid_usd"],
 "Insurance": ["policy_id","field_id","insurer","type","perils","sum_insured_usd","cover_share","trigger","start_date","end_date"],
 "CreditHistory": ["farmer_id","month","bcra_situacion","total_system_debt_usd","max_days_past_due"],
}
REQUIRED = {"Farmers":["farmer_id"],"Fields":["field_id","farmer_id","lat","lng"],
 "Loans":["loan_id","farmer_id","field_id"],"Repayments":["loan_id","due_date"],
 "Insurance":["policy_id","field_id"],"CreditHistory":["farmer_id","month"]}
USD = {"other_bank_debt_usd","amount_usd","collateral_value_usd","principal_usd","interest_usd","paid_usd","sum_insured_usd","total_system_debt_usd"}
PCT = {"pd_12m_origination","lgd_bank","cover_share"}
DATES = {"sowing_date","origination_date","maturity_date","due_date","paid_date","start_date","end_date"}

D = lambda s: datetime.strptime(s, "%Y-%m-%d").date()

def polygon(lat, lng, ha, ang):
    area = ha / 100.0
    w = math.sqrt(area * 1.5); h = area / w          # km
    a = math.radians(ang); pts = []
    for dx, dy in [(-w/2,-h/2),(w/2,-h/2),(w/2,h/2),(-w/2,h/2),(-w/2,-h/2)]:
        x = dx*math.cos(a) - dy*math.sin(a); y = dx*math.sin(a) + dy*math.cos(a)
        pts.append((lng + x/(111.32*math.cos(math.radians(lat))), lat + y/111.32))
    return "POLYGON((" + ", ".join(f"{p[0]:.5f} {p[1]:.5f}" for p in pts) + "))"

def schedule(amount, rate, orig, dues):
    """dues: [(date_str, principal_fraction)] -> rows (due, principal, interest)."""
    rows = []; rem = amount; prev = D(orig)
    for ds, frac in dues:
        d = D(ds); p = round(amount * frac)
        i = round(rem * rate / 100 * (d - prev).days / 365)
        rows.append([d, p, i]); rem -= p; prev = d
    return rows

# ------------------------------------------------------------------ farmers
# paid: per due row (paid_date or None, factor of (principal+interest))
F = []
def add(**k): F.append(k)

add(fid="F001", name="Ramón Eduardo Quiroga", tax="20-23456781-4", country="Argentina", prov="Santa Fe", dept="Centro (Las Colonias)",
 farm_ha=260, years=7, other=40000, lat=-31.40, lng=-61.30, ha=180, crop="soy", sow="2022-11-12", irr="no", ang=12,
 loan="L001", product="Crop input loan", amount=73800, orig="2022-10-20", mat="2024-05-15", rate=11.0, amort="bullet", rating=4,
 coll="crop pledge", cval=95000, bcra=2, dpd=0,
 rows=[("2023-01-31", 0.0, 3, None), ("2024-05-15", 1.0, None, None)], raw=True, ins=None,
 fnote="Loan restructured Feb 2023: interest-only payment, principal moved to the 2024 harvest.",
 hist=[("2021-07",1,0),("2023-02",1,28),("2023-03",2,50),("2023-04",2,0)], hist_debt_loan="2022-10",
 headline="Soy in Santa Fe, uninsured: drought from flowering, restructured to next harvest.",
 story="Ramón farms 180 ha of rented and owned land near Las Colonias and borrowed USD 73,800 in October 2022 to buy seed, glyphosate and fertiliser for soy, pledging the standing crop. Soy was sown on 12 Nov under good moisture, and through December the crop looked normal. From the first week of January the rain stopped: January brought roughly a third of normal rainfall, soil moisture fell below the 15th percentile and NDVI dropped below 1.5 standard deviations under its own history just as the plants were flowering. In late January the bank's monitor raised a confirmed drought alert, so the loan moved to Stage 2 although it was still current. Ramón had no insurance, and the field was expected to lose roughly 40 percent of yield. In February the bank met him, restructured the loan (interest paid first, principal moved to May 2024) and asked for a new pledge on the next crop. He paid the interest 50 days late, on 22 March.",
 monitor="By late Jan 2023: High to Severe stress, main peril drought, cascade confirmed. IFRS 9: Stage 2 (critical climate alert, no insurance so full LGD 45%). Action: proactive restructuring call, collect field evidence, consider crop pledge top-up.",
 outcome="Restructured to May 2024; interest paid late, performing under the new schedule. Classified situacion 2 under probation.")

add(fid="F002", name="Valeria Inés Montenegro", tax="27-24680135-6", country="Argentina", prov="Córdoba", dept="Marcos Juárez / Sur",
 farm_ha=150, years=10, other=0, lat=-33.05, lng=-64.00, ha=120, crop="maize", sow="2022-09-25", irr="no", ang=-20,
 loan="L002", product="Crop input loan", amount=84000, orig="2022-08-10", mat="2023-04-30", rate=9.5, amort="bullet", rating=3,
 coll="warrant on grain", cval=90000, bcra=1, dpd=0, rows=[("2023-04-30", 1.0, None, None)],
 ins=dict(pid="POL-002", insurer="Aseguradora del Litoral (fictional)", type="parametric", perils="drought", sum=84000, share=0.60,
   trigger="SPI-60 < -1.5 between silking and early grain fill (15 Dec - 31 Jan)", start="2022-09-01", end="2023-04-30"),
 fnote="Parametric drought cover with payout assigned to the loan.",
 hist=[("2021-07",1,0)], hist_debt_loan="2022-08",
 headline="Early maize in Córdoba with parametric drought cover: the trigger pays, the loan is repaid.",
 story="Valeria, a second-generation farmer, grows 120 ha of early maize south of Marcos Juárez and borrowed USD 84,000 in August 2022, secured by a grain warrant and a parametric drought policy with the payout assigned to the bank. Maize was sown on 25 Sep and silking took place in mid-December. The first drought signals appeared in early January: SPI-60 fell below -1.5 and NDVI started to lag the norm. By 20 January the index was beyond the policy trigger and the monitor flagged a High stress level; because the cover reduces the bank's effective loss, the model kept the exposure in Stage 2 with a low provision instead of a large one. The insurer paid 60 percent of the sum insured within three weeks and the payout was routed to the loan account. The yield still fell about 45 percent, but the payout plus the warrant meant the bank was never exposed.",
 monitor="By late Jan 2023: High stress, main peril drought, cascade confirmed. IFRS 9: Stage 2 on the climate alert, but LGD cut by the 60% cover so ECL stays small; back to Stage 1 after payout. Action: confirm claim paperwork and payout routing, no restructuring needed.",
 outcome="Parametric payout received Feb 2023, applied to the loan; remaining balance repaid at maturity on 30 Apr 2023.")

add(fid="F003", name="Gustavo Adrián Lombardi", tax="20-31592648-0", country="Argentina", prov="Buenos Aires", dept="Tres Arroyos",
 farm_ha=240, years=14, other=25000, lat=-37.35, lng=-59.15, ha=150, crop="wheat", sow="2022-07-05", irr="no", ang=35,
 loan="L003", product="Crop input loan", amount=58500, orig="2022-06-05", mat="2023-02-28", rate=10.0, amort="bullet", rating=2,
 coll="land mortgage", cval=150000, bcra=1, dpd=0, rows=[("2023-02-28", 1.0, "2023-02-24", 1.0)],
 ins=dict(pid="POL-003", insurer="Seguros Pampa Austral (fictional)", type="indemnity", perils="hail", sum=58500, share=0.80,
   trigger="", start="2022-06-15", end="2023-01-15"),
 fnote="Hail indemnity policy; claim paid Dec 2022.",
 hist=[("2021-07",1,0)], hist_debt_loan="2022-06",
 headline="Wheat in the Sudeste hit by hail: the indemnity claim is paid and the loan stays Stage 1.",
 story="Gustavo has worked 150 ha of wheat near Tres Arroyos for over a decade and took USD 58,500 in June 2022 against a land mortgage, with a hail indemnity policy covering 80 percent of the loss. Wheat was sown in early July and the winter was moist enough for a good tillering. On 15 November a hailstorm crossed the field during grain filling, flattening roughly 30 percent of the area. The bank's monitor picked up a sharp NDVI drop on that part of the field the following week but no drought or water signal, so stress stayed at Watch. Gustavo filed the claim, the loss adjuster confirmed the damage and the insurer paid in December. The rest of the field yielded close to average, and the loan was repaid four days before maturity.",
 monitor="By late Jan 2023: Normal to Watch (hail event in Nov, recovered), no drought. IFRS 9: Stage 1 throughout, LGD reduced by the indemnity. Action: no action, confirm the claim was paid.",
 outcome="Claim paid Dec 2022; loan repaid 24 Feb 2023 ahead of maturity.")

add(fid="F004", name="Cecilia Beatriz Aranda", tax="27-28741963-5", country="Argentina", prov="Salta", dept="Metán / Este",
 farm_ha=420, years=12, other=60000, lat=-25.05, lng=-64.00, ha=300, crop="soy", sow="2022-11-20", irr="yes", ang=5,
 loan="L004", product="Pre-harvest loan", amount=126000, orig="2022-10-15", mat="2023-05-15", rate=8.0, amort="bullet", rating=1,
 coll="land mortgage", cval=400000, bcra=1, dpd=0, rows=[("2023-05-15", 1.0, None, None)], ins=None,
 fnote="Control case: irrigated soy, top rating.",
 hist=[("2021-07",1,0)], hist_debt_loan="2022-10",
 headline="Irrigated soy in Salta, top rating: a normal season, the control case.",
 story="Cecilia manages 300 ha of irrigated soy east of Metán with a pivot system and has been a client for 12 years with a perfect record. She borrowed USD 126,000 in October 2022 with a land mortgage worth more than three times the loan. Soy was sown on 20 Nov, and while rainfall in the region was irregular, the irrigation compensated every dry spell. NDVI tracked the long-term average within half a standard deviation all season and there was no heat or frost event of consequence. The monitor stayed at Normal in January and its confidence was high because the cloud-free image share was good. The bank did nothing, which is the right answer, and the harvest in April was expected at or above the farm average.",
 monitor="By late Jan 2023: Normal, no peril, high confidence. IFRS 9: Stage 1 throughout. Action: none (control case, shows the monitor does not cry wolf).",
 outcome="Harvest at or above average; repayment expected on 15 May 2023.")

add(fid="F005", name="Hernán Pablo Sosa", tax="20-30918274-3", country="Argentina", prov="Entre Ríos", dept="Paraná",
 farm_ha=190, years=5, other=30000, lat=-31.90, lng=-60.05, ha=140, crop="soy", sow="2022-11-25", irr="no", ang=-35,
 loan="L005", product="Crop input loan", amount=56000, orig="2022-10-25", mat="2023-06-15", rate=12.0, amort="installments", rating=4,
 coll="crop pledge", cval=70000, bcra=1, dpd=0, rows=[("2023-04-30", 0.5, None, None), ("2023-06-15", 0.5, None, None)],
 ins=dict(pid="POL-005", insurer="Cooperativa Aseguradora del Paraná (fictional)", type="multi-peril", perils="drought, excess_water", sum=56000, share=0.40,
   trigger="", start="2022-11-01", end="2023-06-30"),
 fnote="Low-lying field; multi-peril policy with 40% partial cover.",
 hist=[("2021-07",1,0),("2023-05",1,20),("2023-06",2,45)], hist_debt_loan="2022-10",
 headline="Low field in Entre Ríos: a dry season, then March floods at harvest; partial cover, Stage 2.",
 story="Hernán farms 140 ha on low ground near Paraná and borrowed USD 56,000 in October 2022 with a crop pledge and a multi-peril policy that covers 40 percent of a drought or flood loss. Soy was sown on 25 Nov and the first weeks were dry. Rainfall stayed 40 percent below normal until early March, and NDVI sat 1.2 standard deviations under the norm from January, so the monitor held a High level for drought. Then storms in mid-March dropped 220 mm in ten days; radar showed water covering part of the field just before harvest and SPI-30 jumped above +2. The crop that survived the drought was now partly flooded and harvest was delayed. The bank saw drought first and excess water second, and noted that the policy only pays part of the damage. The first installment on 30 April was at risk.",
 monitor="By late Jan 2023: High stress from drought (cascade active to confirmed); excess water emerges only in March. IFRS 9: Stage 2, LGD reduced by 40% cover. Action: call the borrower, review the installment dates and verify the insurance claim process.",
 outcome="Harvest delayed and yield low; first installment paid about 20 days late, second partially covered by the policy. Ends Stage 2.")

add(fid="F006", name="Daniel Osvaldo Ferreyra", tax="20-27135946-8", country="Argentina", prov="La Pampa", dept="Realicó / Este",
 farm_ha=310, years=4, other=90000, lat=-35.55, lng=-63.85, ha=220, crop="wheat", sow="2022-07-05", irr="no", ang=18,
 loan="L006", product="Crop input loan", amount=79200, orig="2022-06-10", mat="2022-12-20", rate=13.0, amort="installments", rating=5,
 coll="warrant on grain", cval=60000, bcra=3, dpd=101,
 rows=[("2022-11-15", 0.4, "2023-01-10", 1.0), ("2022-12-20", 0.6, None, None)], ins=None,
 fnote="Frost at heading plus drought; first installment paid 56 days late, second unpaid.",
 hist=[("2021-07",1,0),("2022-11",1,15),("2022-12",2,46),("2023-01",2,42),("2023-02",2,70),("2023-03",3,101),("2023-04",3,131),("2023-05",3,162),("2023-06",4,192)], hist_debt_loan="2022-06",
 headline="Wheat in La Pampa: frost at heading and drought, already delinquent and in Stage 3.",
 story="Daniel is a four-year client who sowed 220 ha of wheat in early July 2022 with a USD 79,200 loan backed by a grain warrant and no insurance. A late frost on 28 September, with a night minimum of -4 degrees, hit the crop at heading and sterilised many florets. Spring rainfall then stayed far below normal, and by October the monitor showed both frost and drought with NDVI 2 standard deviations under the norm. The harvest in December gave about 50 percent less than expected. He paid the first installment of 15 November 56 days late and could not pay the 20 December balance. By December the BCRA already listed him as situacion 2 and he also owes other banks USD 90,000. By 31 March the unpaid installment was 101 days overdue and he was classified situacion 3.",
 monitor="By late Jan 2023: Severe stress, perils frost and drought, yield expected -50%. IFRS 9: Stage 3 (situacion 3, over 90 days past due by March; Stage 2 earlier in the season). Action: recovery team, call the warrant, restructure only with new collateral.",
 outcome="Still unpaid; reclassified to situacion 4 by June 2023. Warrant on stored grain being executed.")

add(fid="F007", name="Estancia Los Alamos S.A. (Martín Etcheverry)", tax="30-71234567-9", country="Argentina", prov="Buenos Aires", dept="Pergamino / Norte",
 farm_ha=900, years=18, other=1800000, lat=-33.80, lng=-60.45, ha=260, crop="soy", sow="2022-11-10", irr="no", ang=8,
 loan="L007A", product="Crop input loan", amount=109200, orig="2022-10-10", mat="2023-06-30", rate=9.0, amort="installments", rating=2,
 coll="land mortgage", cval=500000, bcra=1, dpd=0,
 rows=[("2023-03-31", 0.5, "2023-03-30", 1.0), ("2023-06-30", 0.5, None, None)], ins=None, fid_field="P007A",
 fnote="Diversified 900 ha farm, soy and maize on two fields and two loans; high debt with other banks.",
 second=dict(loan="L007B", field="P007B", crop="maize", ha=200, lat=-33.90, lng=-60.55, sow="2022-09-20", amount=136000, orig="2022-08-20",
   mat="2023-05-31", rate=9.0, rating=2, cval=500000, product="Crop input loan",
   rows=[("2023-03-15", 0.5, "2023-03-14", 1.0), ("2023-05-31", 0.5, None, None)], ang=-12),
 hist=[("2021-07",1,0)], hist_debt_loan="2022-08",
 headline="Large diversified farm in Buenos Aires Norte: drought hits the soy loan only (Stage 2), maize holds.",
 story="Estancia Los Alamos is an 18-year client farming 900 ha in the north of Buenos Aires province, and carries two loans: USD 136,000 for 200 ha of early maize (August 2022) and USD 109,200 for 260 ha of late soy (October 2022), both on installments and mortgage-backed. Its debt with other banks is high at USD 1.8 million, which is why the bank watches it closely. The maize was sown on 20 Sep and flowered in early December, before the worst of the dry weather, so it lost only about 15 percent of yield. The soy, sown 10 Nov, reached flowering in the second half of January exactly when SPI-60 turned to -1.7 and soil moisture fell under the 15th percentile. The monitor therefore flagged High stress on the soy field and Watch on the maize one. The farm paid both March installments on time, using the maize income to cover the soy loan.",
 monitor="By late Jan 2023: soy loan High (drought, cascade active); maize loan Watch. IFRS 9: soy loan Stage 2, maize loan Stage 1; both with small LGD thanks to land mortgage. Action: portfolio view, check combined exposure to the group (USD 1.8M elsewhere) and concentration in Buenos Aires Norte.",
 outcome="Both March installments paid on time; soy yield about -30%, maize about -15%. Remains performing; Stage 2 on the soy loan.")

add(fid="F008", name="Lucas Nicolás Pereira", tax="20-39854127-2", country="Uruguay", prov="Soriano", dept="Dolores",
 farm_ha=45, years=1, other=0, lat=-33.40, lng=-57.70, ha=45, crop="soy", sow=None, irr="no", ang=25,
 loan="L008", product="First-season input loan", amount=17100, orig="2022-11-05", mat="2023-06-15", rate=14.0, amort="bullet", rating=6,
 coll="unsecured", cval=0, bcra=1, dpd=0, rows=[("2023-06-15", 1.0, None, None)], ins=None,
 fnote="First-time borrower; sowing date not reported (detect from NDVI).",
 hist=[("2021-07",1,0),("2023-06",1,12)], hist_debt_loan="2022-11",
 headline="Young first-time borrower in Soriano, no sowing date: stress High, early contact, short extension.",
 story="Lucas, 27, rents a 45 ha plot near Dolores and took his first loan of USD 17,100 in November 2022, unsecured, with an internal rating of 6 because he has no credit history. He did not report a sowing date, so the platform estimated it from the NDVI green-up (about 3 December). With no irrigation, the soy was exposed to the same dry January as the rest of the region: rainfall stopped in the first week of the year and soil moisture was in the bottom decile within three weeks. The monitor reached High stress by late January, and a high pd at origination (9 percent) meant the loan crossed the Stage 2 threshold quickly. The bank's agent called Lucas in early February, helped him document the plot and agreed in principle to a short extension. The harvest was poor, but he was able to pay.",
 monitor="By late Jan 2023: High stress, peril drought; sowing date detected from NDVI (about 3 Dec, source phenology). IFRS 9: Stage 2 (PD at least double origination level, unsecured so LGD 62%). Action: contact the borrower early, offer a short extension rather than waiting for default.",
 outcome="Paid on 27 June 2023, 12 days after maturity under an agreed extension; no default.")

add(fid="F009", name="Adriana Beatriz Schneider", tax="27-26417935-1", country="Brazil", prov="Rio Grande do Sul", dept="Santo Ângelo (Missões)",
 farm_ha=210, years=3, other=55000, lat=-28.25, lng=-54.20, ha=160, crop="soy", sow="2022-11-15", irr="no", ang=-8,
 loan="L009", product="Crop input loan", amount=62400, orig="2022-10-18", mat="2023-05-15", rate=12.5, amort="installments", rating=5,
 coll="crop pledge", cval=78000, bcra=2, dpd=59,
 rows=[("2022-12-30", 0.0, "2023-01-25", 1.0), ("2023-01-31", 0.0, None, None), ("2023-05-15", 1.0, None, None)],
 ins=dict(pid="POL-009", insurer="Mutual Sul Missões (fictional)", type="indemnity", perils="hail", sum=62400, share=0.70,
   trigger="", start="2022-10-25", end="2023-05-15"),
 fnote="Hail-only policy: does not cover drought (coverage gap).",
 hist=[("2021-07",1,0),("2023-01",1,26),("2023-02",1,28),("2023-03",2,59),("2023-04",2,89),("2023-05",4,120),("2023-06",4,151)], hist_debt_loan="2022-10",
 headline="Soy in Rio Grande do Sul with hail-only cover: severe drought is a coverage gap, ends in default.",
 story="Adriana farms 160 ha of soy in the Missões region and borrowed USD 62,400 in October 2022 against a crop pledge, taking a hail indemnity policy at 70 percent because that was what the local broker sold. She sowed on 15 Nov. From mid-December rainfall collapsed, and by January the monitor showed the strongest drought signal in the whole sample, with NDVI 2.4 standard deviations under normal during flowering. There was no hail, so the policy would never pay: the bank flagged this as a coverage gap. She paid the 30 Dec interest installment 26 days late and did not pay the 31 Jan one. The bank asked for a visit, but the yield collapsed by about 55 percent. On 31 March the loan was 59 days past due; in May a second lender reported her, and she was reclassified situacion 4.",
 monitor="By late Jan 2023: Severe stress, peril drought, insurance does not cover the peril (gap). IFRS 9: Stage 2 by March, Stage 3 by May (situacion 4); no LGD benefit from insurance. Action: offer parametric drought cover next season, early restructuring call in January.",
 outcome="Defaulted: situacion 4 by May 2023. Crop pledge executed, partial recovery expected.")

add(fid="F010", name="Rubén Darío Villalba", tax="20-33786591-7", country="Paraguay", prov="Itapúa", dept="Capitán Meza",
 farm_ha=130, years=6, other=20000, lat=-26.85, lng=-55.95, ha=90, crop="maize", sow="2022-10-01", irr="no", ang=-15,
 loan="L010", product="Crop input loan", amount=58500, orig="2022-09-01", mat="2023-05-31", rate=10.5, amort="installments", rating=3,
 coll="machinery pledge", cval=70000, bcra=1, dpd=0, rows=[("2023-02-28", 0.5, "2023-02-27", 1.0), ("2023-05-31", 0.5, None, None)], ins=None,
 fnote="Machinery pledge (tractor and planter).",
 hist=[("2021-07",1,0)], hist_debt_loan="2022-09",
 headline="Maize in Itapúa: heat days in January, Watch only; paid on time.",
 story="Rubén grows 90 ha of maize in Itapúa and took USD 58,500 in September 2022, repayable in two installments and secured by a tractor and planter. He sowed on 1 Oct. Rainfall in the department was close to normal through the season, so there was no drought signal. In the second week of January the monitor counted four days above 35 degrees at flowering, which raised a heat alert and moved the stress score into Watch, but soil moisture held and NDVI stayed within one standard deviation. The bank noted the event and lowered confidence in the yield forecast, with an expected loss of roughly 10 percent. Rubén paid the first installment on 27 February, one day early. No contact beyond a routine call was needed.",
 monitor="By late Jan 2023: Watch (heat days at flowering, mild), no drought. IFRS 9: Stage 1. Action: monitor only, routine call.",
 outcome="First installment paid on time; yield about -10%; second installment paid at maturity.")

# ------------------------------------------------------------------ build rows
def months(a="2021-07", b="2023-06"):
    y, m = map(int, a.split("-")); out = []
    while f"{y}-{m:02d}" <= b:
        out.append(f"{y}-{m:02d}"); m += 1
        if m == 13: y += 1; m = 1
    return out

def build():
    T = {k: [] for k in COLS}; story_rows = []
    for f in F:
        fid = f["fid"]
        T["Farmers"].append([fid, f["name"], f["tax"], f["country"], f["prov"], f["dept"], f["farm_ha"], f["years"], f["other"], f["fnote"]])
        units = [dict(loan=f["loan"], field=f.get("fid_field", "P" + fid[1:]), crop=f["crop"], ha=f["ha"], lat=f["lat"], lng=f["lng"], sow=f["sow"],
                      amount=f["amount"], orig=f["orig"], mat=f["mat"], rate=f["rate"], rating=f["rating"], cval=f["cval"], product=f["product"],
                      rows=f["rows"], ang=f["ang"], coll=f["coll"], bcra=f["bcra"], dpd=f["dpd"], amort=f["amort"], ins=f.get("ins"))]
        if f.get("second"):
            s = f["second"]
            units.append(dict(loan=s["loan"], field=s["field"], crop=s["crop"], ha=s["ha"], lat=s["lat"], lng=s["lng"], sow=s["sow"], amount=s["amount"],
                              orig=s["orig"], mat=s["mat"], rate=s["rate"], rating=s["rating"], cval=s["cval"], product=s["product"], rows=s["rows"], ang=s["ang"],
                              coll=f["coll"], bcra=1, dpd=0, amort="installments", ins=None))
        PD = {1:.005,2:.008,3:.015,4:.028,5:.05,6:.09,7:.15,8:.25}
        LGD = {"land mortgage":.28,"warrant on grain":.38,"machinery pledge":.42,"crop pledge":.45,"unsecured":.62}
        for u in units:
            T["Fields"].append([u["field"], fid, u["lat"], u["lng"], polygon(u["lat"], u["lng"], u["ha"], u["ang"]), u["ha"], u["crop"],
                                D(u["sow"]) if u["sow"] else None, f["irr"]])
            T["Loans"].append([u["loan"], fid, u["field"], u["product"], u["amount"], D(u["orig"]), D(u["mat"]), u["rate"], u["amort"],
                               u["rating"], PD[u["rating"]], LGD[u["coll"]], u["coll"], u["cval"], u["bcra"], u["dpd"]])
            if f.get("raw"):                       # restructured loan: interest-only row, then principal + interest to new maturity
                prev = D(u["orig"])
                for due, pfrac, _i, _x in u["rows"]:
                    p = round(u["amount"] * pfrac)
                    intr = round(u["amount"] * u["rate"]/100 * (D(due) - prev).days / 365); prev = D(due)
                    paid_d = D("2023-03-22") if due == "2023-01-31" else None
                    T["Repayments"].append([u["loan"], D(due), p, intr, paid_d, (p + intr) if paid_d else None])
            else:
                sch = schedule(u["amount"], u["rate"], u["orig"], [(r[0], r[1]) for r in u["rows"]])
                for (d, p, i), r in zip(sch, u["rows"]):
                    pd_, fac = r[2], r[3]
                    T["Repayments"].append([u["loan"], d, p, i, D(pd_) if pd_ else None, round((p + i) * fac) if pd_ else None])
            if f["fid"] == "F009" and u["loan"] == "L009":   # interest-only installments: fix amounts
                pass
            if u["ins"]:
                i = u["ins"]
                T["Insurance"].append([i["pid"], u["field"], i["insurer"], i["type"], i["perils"], i["sum"], i["share"], i["trigger"] or None, D(i["start"]), D(i["end"])])
        # credit history
        ch = months(); h = f["hist"]; tot_loans = sum(u["amount"] for u in units)
        for n, m in enumerate(ch):
            sit, dpd = 1, 0
            for hm, hs, hd in h:
                if m >= hm: sit, dpd = hs, hd
            debt = f["other"] * (0.8 + 0.2 * n / (len(ch) - 1)) + (tot_loans if m >= f["hist_debt_loan"] else 0)
            T["CreditHistory"].append([fid, m, sit, round(debt, -2), dpd])
        story_rows.append([fid, f["name"], f["headline"], f["story"], f["monitor"], f["outcome"]])
    return T, story_rows

# ------------------------------------------------------------------ formatting
def style_sheet(ws, headers, widths=None, wrap=()):
    for c, h in enumerate(headers, 1):
        cell = ws.cell(1, c); cell.fill = FERN; cell.font = HFONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.freeze_panes = "A2"
    for c, h in enumerate(headers, 1):
        vals = [len(str(ws.cell(r, c).value or "")) for r in range(1, min(ws.max_row, 60) + 1)]
        w = min(max(max(vals) + 2, len(h) + 3, 10), 60)
        if widths and h in widths: w = widths[h]
        ws.column_dimensions[get_column_letter(c)].width = w
        fmt = "#,##0" if h in USD else "0.0%" if h in PCT else "yyyy-mm-dd" if h in DATES else None
        for r in range(2, ws.max_row + 1):
            cell = ws.cell(r, c)
            if fmt: cell.number_format = fmt
            if h in wrap: cell.alignment = Alignment(wrap_text=True, vertical="top")
    ws.auto_filter.ref = ws.dimensions

def write_sheet(wb, name, headers, rows):
    ws = wb.create_sheet(name); ws.append(headers)
    for r in rows: ws.append(r)
    return ws

def make_sample():
    T, stories = build()
    wb = Workbook(); wb.remove(wb.active)
    ws = wb.create_sheet("README")
    lines = [
     ("Loan-ly Planet: sample loan book, 10 fictional farmers (season 2022/23)", True),
     ("", False),
     ("ALL DATA IS FICTIONAL. Names, tax IDs, insurers, the bank and the amounts are invented for the MIT hackathon demo (Suyana track). Any resemblance to real people or companies is a coincidence. The weather and satellite series the platform uses are synthetic too.", False),
     ("The scenario: the 2022/23 La Niña drought in the Argentine Pampas. Each farmer has a distinct credit story (see the CreditStory sheet). Reference date for current status (bcra_situacion, days_past_due in Loans): 2023-03-31. CreditHistory runs 2021-07 to 2023-06 (months after March show how each story ended).", False),
     ("", False),
     ("Sheet map (format defined in docs/CONTRACT.md section A)", True),
     ("CreditStory: ignored by the loader. A narrative for each farmer, and what the monitor is expected to show.", False),
     ("Farmers: one row per borrower (farmer_id, name, tax_id, location, farm size, other-bank debt, notes).", False),
     ("Fields: one row per financed field (lat, lng, polygon_wkt, area_ha, crop, sowing_date, irrigated). F008 has a blank sowing_date on purpose: the platform detects it from NDVI.", False),
     ("Loans: one row per loan, linked to farmer_id and field_id (amount, dates, rate, amortization, rating, PD, LGD, collateral, BCRA situacion, days past due).", False),
     ("Repayments: scheduled principal and interest per due date, with paid_date and paid_usd where payment happened (blank when still in the future or unpaid). Restructured loans list only the new schedule.", False),
     ("Insurance: policies per field (indemnity, parametric or multi-peril). Farmers F001, F004, F006, F007, F008 and F010 are uninsured.", False),
     ("CreditHistory: monthly worst BCRA classification, system debt and max days past due per farmer.", False),
     ("", False),
     ("How to load it", True),
     ("Web app: open the Load loans page and upload this file.", False),
     ("Command line: python3 backend/pipeline.py --book samples/sample_farmers_10.xlsx", False),
     ("Regenerate: python3 samples/make_samples.py", False),
    ]
    for i, (t, b) in enumerate(lines, 1):
        c = ws.cell(i, 1, t); c.alignment = Alignment(wrap_text=True, vertical="top")
        if b: c.font = Font(bold=True, size=13 if i == 1 else 11)
    ws.column_dimensions["A"].width = 120
    hdr = ["farmer_id","name","headline","story","what_the_monitor_should_show","outcome"]
    cs = write_sheet(wb, "CreditStory", hdr, stories)
    style_sheet(cs, hdr, widths={"farmer_id":10,"name":26,"headline":38,"story":90,"what_the_monitor_should_show":55,"outcome":42}, wrap=set(hdr))
    for r in range(2, cs.max_row + 1): cs.row_dimensions[r].height = 190
    for name in COLS:
        ws = write_sheet(wb, name, COLS[name], T[name])
        style_sheet(ws, COLS[name], widths={"polygon_wkt":40,"notes":50,"trigger":50}, wrap={"notes","trigger"})
    wb.save(OUT / "sample_farmers_10.xlsx")

# ------------------------------------------------------------------ template
HELP = {
 "farmer_id":"REQUIRED. Unique borrower code, e.g. F001. Same value used in every sheet.",
 "name":"Optional. Borrower name.", "tax_id":"Optional. CUIT/CUIL or national tax ID, e.g. 20-12345678-9.",
 "country":"Optional. Argentina, Uruguay, Brazil or Paraguay.", "province":"Optional. Province / state.", "department":"Optional. Department / municipality.",
 "farm_ha":"Optional. Total farm size in hectares.", "years_as_client":"Optional. Whole years as a client of the bank.",
 "other_bank_debt_usd":"Optional. Debt with other banks in USD (BCRA Central de Deudores).", "notes":"Optional. Free text.",
 "field_id":"REQUIRED. Unique field code, e.g. P001.", "lat":"REQUIRED. Field centroid latitude, WGS84 decimal degrees (a point is enough).",
 "lng":"REQUIRED. Field centroid longitude, WGS84 decimal degrees.", "polygon_wkt":"Optional. POLYGON((lng lat, lng lat, ...)). If blank the platform uses the point.",
 "area_ha":"Optional. Field area in hectares. Default 100.", "crop":"Optional. soy / maize / wheat / sunflower. Default soy.",
 "sowing_date":"Optional. YYYY-MM-DD. If blank, the platform detects it from NDVI (phenology).", "irrigated":"Optional. yes / no. Default no.",
 "loan_id":"REQUIRED. Unique loan code, e.g. L001.", "product":"Optional. e.g. Crop input loan, Pre-harvest loan.",
 "amount_usd":"Optional but needed for provisions. Principal disbursed in USD.", "origination_date":"Optional. YYYY-MM-DD.", "maturity_date":"Optional. YYYY-MM-DD.",
 "rate_pct":"Optional. Annual nominal rate in percent, e.g. 11. Default 10.", "amortization":"Optional. bullet or installments (then fill Repayments). Default bullet.",
 "rating_origination":"Optional. Bank internal rating 1 (best) to 8 at origination. Default 4.",
 "pd_12m_origination":"Optional. 12-month PD at origination as a fraction 0-1. Default from the rating table (1: 0.5% ... 8: 25%).",
 "lgd_bank":"Optional. Loss given default 0-1. Default from the collateral table (land mortgage 28%, warrant 38%, machinery 42%, crop pledge 45%, unsecured 62%).",
 "collateral_type":"Optional. land mortgage / crop pledge / warrant on grain / machinery pledge / unsecured.", "collateral_value_usd":"Optional. Collateral value in USD.",
 "bcra_situacion":"Optional. Current BCRA debtor classification 1-6. 3 or more means default (Stage 3). Default 1.", "days_past_due":"Optional. Current days past due. Over 90 means Stage 3. Default 0.",
 "due_date":"REQUIRED. Scheduled due date YYYY-MM-DD.", "principal_usd":"Optional. Scheduled principal for that date.", "interest_usd":"Optional. Scheduled interest for that date.",
 "paid_date":"Leave blank if not yet paid.", "paid_usd":"Leave blank if not yet paid.",
 "policy_id":"REQUIRED. Unique policy code.", "insurer":"Optional. Insurance company.", "type":"Optional. indemnity / parametric / multi-peril.",
 "perils":"Optional. Comma list of: drought, excess_water, frost, heat, hail. Used to detect coverage gaps.",
 "sum_insured_usd":"Optional. Sum insured in USD.", "cover_share":"Optional. Share of loss covered, 0-1 (e.g. 0.6). Lowers LGD.",
 "trigger":"Optional. Parametric trigger in words, e.g. SPI-60 < -1.5 between flowering and grain fill.", "start_date":"Optional. Policy start YYYY-MM-DD.", "end_date":"Optional. Policy end YYYY-MM-DD.",
 "month":"REQUIRED. YYYY-MM.", "total_system_debt_usd":"Optional. Debt with the whole financial system in USD that month.",
 "max_days_past_due":"Optional. Maximum days past due across the system that month.",
}
EX = {
 "Farmers": ["EXAMPLE-F000","Example Farmer (fictional)","20-00000000-0","Argentina","Santa Fe","Las Colonias",200,3,25000,"EXAMPLE - delete this row"],
 "Fields": ["EXAMPLE-P000","EXAMPLE-F000",-31.45,-61.25,None,150,"soy",D("2022-11-15"),"no"],
 "Loans": ["EXAMPLE-L000","EXAMPLE-F000","EXAMPLE-P000","Crop input loan",60000,D("2022-10-20"),D("2023-05-31"),11.0,"bullet",4,0.028,0.45,"crop pledge",80000,1,0],
 "Repayments": ["EXAMPLE-L000",D("2023-05-31"),60000,3000,None,None],
 "Insurance": ["EXAMPLE-POL000","EXAMPLE-P000","Example Insurer (fictional)","parametric","drought",60000,0.6,"SPI-60 < -1.5 between flowering and grain fill",D("2022-11-01"),D("2023-05-31")],
 "CreditHistory": ["EXAMPLE-F000","2023-01",1,85000,0],
}
LISTS = {("Fields","crop"):"soy,maize,wheat,sunflower", ("Fields","irrigated"):"yes,no",
 ("Loans","amortization"):"bullet,installments", ("Loans","collateral_type"):"land mortgage,crop pledge,warrant on grain,machinery pledge,unsecured",
 ("Loans","bcra_situacion"):"1,2,3,4,5,6", ("Loans","rating_origination"):"1,2,3,4,5,6,7,8",
 ("Insurance","type"):"indemnity,parametric,multi-peril", ("CreditHistory","bcra_situacion"):"1,2,3,4,5,6"}

def make_template():
    wb = Workbook(); wb.remove(wb.active)
    ws = wb.create_sheet("README")
    lines = [
     ("Loan-ly Planet: loan book template", True), ("", False),
     ("Fill in the six data sheets (Farmers, Fields, Loans, Repayments, Insurance, CreditHistory), then upload the file on the Load loans page or run: python3 backend/pipeline.py --book your_file.xlsx", False),
     ("Delete the grey italic EXAMPLE row on each sheet before loading (its IDs start with EXAMPLE-).", False), ("", False),
     ("Required columns (the minimum)", True),
     ("Farmers: farmer_id. Fields: field_id, farmer_id, lat, lng. Loans: loan_id, farmer_id, field_id. Repayments: loan_id, due_date. Insurance: policy_id, field_id. CreditHistory: farmer_id, month.", False),
     ("A point is enough: give lat and lng of the field centre. A polygon (polygon_wkt) and area_ha are optional and improve the satellite statistics.", False), ("", False),
     ("Optional columns and the defaults applied when blank", True),
     ("crop = soy; irrigated = no; area_ha = 100; sowing_date blank = detected from NDVI; amortization = bullet; rate_pct = 10; rating_origination = 4;", False),
     ("pd_12m_origination from the rating table: 1: 0.5%, 2: 0.8%, 3: 1.5%, 4: 2.8%, 5: 5%, 6: 9%, 7: 15%, 8: 25%.", False),
     ("lgd_bank from the collateral table: land mortgage 28%, warrant on grain 38%, machinery pledge 42%, crop pledge 45%, unsecured 62%.", False),
     ("bcra_situacion = 1; days_past_due = 0; no Insurance row = uninsured. Insurance lowers LGD by cover_share.", False), ("", False),
     ("Value lists (drop-downs in the sheets)", True),
     ("crop: soy, maize, wheat, sunflower. irrigated: yes / no. amortization: bullet / installments. collateral_type: land mortgage, crop pledge, warrant on grain, machinery pledge, unsecured.", False),
     ("insurance type: indemnity, parametric, multi-peril. perils (comma list): drought, excess_water, frost, heat, hail. bcra_situacion: 1-6. rating_origination: 1-8 (1 best).", False), ("", False),
     ("Formats: dates are YYYY-MM-DD, month is YYYY-MM, money is USD, pd/lgd/cover_share are fractions between 0 and 1. Hover over each header for a note on the column.", False),
    ]
    for i, (t, b) in enumerate(lines, 1):
        c = ws.cell(i, 1, t); c.alignment = Alignment(wrap_text=True, vertical="top")
        if b: c.font = Font(bold=True, size=13 if i == 1 else 11)
    ws.column_dimensions["A"].width = 120
    for name, headers in COLS.items():
        ws = write_sheet(wb, name, headers, [EX[name]])
        style_sheet(ws, headers, widths={"polygon_wkt":30,"notes":30,"trigger":40})
        for c, h in enumerate(headers, 1):
            cm = Comment(HELP[h], "Loan-ly Planet"); cm.width = 320; cm.height = 90
            ws.cell(1, c).comment = cm
            if h in REQUIRED[name]: ws.cell(1, c).value = h   # name stays exact; required marked in the note
        for c in range(1, len(headers) + 1):
            cell = ws.cell(2, c); cell.font = Font(italic=True, color="808080")
            cell.fill = PatternFill("solid", fgColor="EEEEEE")
        ws.cell(2, 1).comment = Comment("EXAMPLE - delete this row before loading.", "Loan-ly Planet")
        for (sn, col), lst in LISTS.items():
            if sn == name:
                letter = get_column_letter(headers.index(col) + 1)
                dv = DataValidation(type="list", formula1=f'"{lst}"', allow_blank=True)
                dv.error = f"Choose one of: {lst}"; dv.showErrorMessage = True
                ws.add_data_validation(dv); dv.add(f"{letter}2:{letter}2000")
        ws.auto_filter.ref = None
    wb.save(OUT / "loan_book_template.xlsx")

if __name__ == "__main__":
    make_sample(); make_template(); print("wrote", OUT / "sample_farmers_10.xlsx", OUT / "loan_book_template.xlsx")
