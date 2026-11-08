// Loan-ly Planet data layer. All numbers come from the Python backend (backend/pipeline.py -> analysis.json, docs/CONTRACT.md §B).
// This file loads that JSON once, types it, memoises the per-week "rows" the pages need, and holds the formatting helpers and the
// plain-language templates that turn the backend's reason codes into sentences. No risk model lives in the browser any more.

import { getLang, withLang } from "./i18n";
import type { Lang } from "./i18n";
import { C, collateralName, cropLabel, insuranceTrigger, insuranceType, monthName, stageName, weekOfWord } from "./locales/common";
import { K } from "./locales/credit";

export type Crop = "soy" | "maize" | "wheat" | "sunflower";
export type Peril = "drought" | "excess_water" | "frost" | "heat" | "hail";
export type Level = "Normal" | "Watch" | "High" | "Severe";
export type Cascade = "none" | "early" | "active" | "confirmed";
export type Scenario = "base" | "adverse" | "severe";

export interface Reason { code: string; value: number }
export interface AnalogYear { year: number; distance: number; yieldAnom: number }
export interface Insurance { type: string; perils: Peril[]; coverShare: number; sumInsured: number; trigger: string }
export interface Recommendation { action: string; why: string }
export interface ScenarioArrays { base: number[]; adverse: number[]; severe: number[]; weighted: number[] }
export interface Loan {
  id: string; farmerId: string; borrower: string; fieldId: string; country: string; region: string; regionId: string; lat: number; lng: number; ring: [number, number][] | null;
  crop: Crop; areaHa: number; farmHa: number; irrigated: boolean; product: string; amountUsd: number; originated: string; maturity: string; ratePct: number;
  schedule: { date: string; principal: number; interest: number; paidDate: string | null; paidUsd: number | null }[];
  ratingOrig: number; pdOrig: number; lgdBank: number; collateral: string; collateralValue: number; bcraSituacion: number; daysPastDue: number;
  insurance: Insurance | null; otherBankDebt: number; uploaded: boolean; syntheticSignals?: boolean;
  sowing: { date: string | null; week: number | null; source: "given" | "phenology" };
  stage: string[]; stageWeight: number[];
  ndviObs: (number | null)[]; ndvi: number[]; cloudFree: number[]; clim: { mean: number[]; sd: number[]; p10: number[]; p90: number[] };
  ndviZ: number[]; ndviPct: number[]; spi30: number[]; spi60: number[]; spi90: number[]; smPct: number[]; tmin: number[]; hotDays: number[]; water: number[]; rainWeek: number[]; rainNormal: number[];
  score: number[]; level: Level[]; perils: Record<Peril, number[]>; cascade: Cascade[]; confidence: number[]; reasons: Reason[][];
  analogs: AnalogYear[][]; yield: { p10: number[]; p50: number[]; p90: number[] }; expectedYieldTHa: number; yieldHistory: { years: number[]; tHa: number[] };
  credit: { pd12: number[]; pdLife: number[]; stage: (1 | 2 | 3)[]; stageReason: string[]; lgd: number[]; ead: number[]; eclBank: number[]; ecl: ScenarioArrays; insuranceMet?: number[] };
  outcome: { yieldAnom: number; defaulted: boolean };
  explanationAsOf?: string; recommendationAsOf?: Recommendation;
  /** Crop Health Index (CHI v1; field names kept as fhi*), display only. fhiZ = standardized f_CHI; fhiPartial = only 2 of 3 components */
  fhi?: (number | null)[]; fhiVci?: (number | null)[]; fhiSm?: (number | null)[]; fhiWa?: (number | null)[]; fhiZ?: (number | null)[]; fhiPartial?: (boolean | null)[]; fhiSeason?: string;
  fhiByCampaign?: { campaign: string; fhi: number | null; vci: number | null; sm: number | null; wa: number | null; fhiMin: number | null; crit?: number | null }[];
}
export interface Cluster { id: number; loanIds: string[]; lat: number; lng: number; radiusKm: number; ead: number; meanScore: number }
export interface Alert { week: number; loanId: string; from: Level; to: Level; kind: "new" | "worse" | "better"; score: number; explanation: string; recommendation: Recommendation }
export interface Meta {
  lender: string; season: string; synthetic: boolean; generatedAt: string; weeks: string[]; asOfDefault: number; histYears: number[]; snapshotDate?: string; book?: string; note?: string; warnings?: string[];
  crops: Record<Crop, { label: string; color: string; price: number; stages: { name: string; weight: number }[]; criticalWindow?: [number, number] }>;
  regions: { id: string; name: string; country: string; lat: number; lng: number }[];
  scenarios: Record<Scenario, number>;
  params: { beta: number; sicrMultiplier: number; discountRate: number; hysteresis: { up: number[]; down: number[] }; scoreHalfLifeWeeks?: number; restructuringExtensionMonths?: number; [k: string]: unknown };
  methods: Record<string, string>;
}
export interface PortfolioSeries {
  exposure: number[]; ead: number[]; stressedEad: number[]; byLevel: Record<Level, number[]>; byLevelCount?: Record<Level, number[]>; eclBank: number[]; ecl: ScenarioArrays;
  fhiMean?: (number | null)[];
  stage1?: number[]; stage2: number[]; stage3: number[]; clusters: Cluster[][]; concentration: { byRegion: { id: string; ead: number; stressedEad: number }[]; byCrop: { id: string; ead: number; stressedEad: number }[] };
}
export interface StressTest { years: number[]; loss: number[]; p50: number; p95: number; p99: number; worstYear: number; currentLoss?: number; note?: string }
export interface YieldValidation { regionId: string; crop: Crop; n: number; nFields?: number; r2Loyo: number | null; maeLoyo: number | null; method: string }
export interface Backtest { week: number; flagged: number; flaggedDefaultRate: number | null; otherDefaultRate: number | null; auc: number | null }
export interface Analysis {
  meta: Meta; loans: Loan[]; portfolio: PortfolioSeries; stressTest: StressTest; alerts: Alert[];
  validation: { yieldModel: YieldValidation[]; backtest: Backtest[] };
}

// ----------------------------------------------------------------------------------------------- loading
const prep = (a: Analysis): Analysis => a;
/** GET /api/analysis[?book=id]; falls back to the static copy when the backend is down (demo book only). */
export async function loadAnalysis(book: string | null): Promise<{ analysis: Analysis; source: "api" | "static" }> {
  const q = book ? `?book=${encodeURIComponent(book)}` : "";
  try {
    const r = await fetch(`/api/analysis${q}`);
    if (r.ok) return { analysis: prep(await r.json()), source: "api" };
    if (book) throw new Error(`The uploaded book ${book} could not be loaded (HTTP ${r.status}).`);
  } catch (e) { if (book) throw e; }
  const r = await fetch("/data/analysis.json");
  if (!r.ok) throw new Error(`analysis.json: HTTP ${r.status}. Run python3 backend/pipeline.py, or start the API with web/run.sh.`);
  return { analysis: prep(await r.json()), source: "static" };
}
export async function loadHealth(): Promise<{ ok: boolean; llm: boolean }> {
  try { const r = await fetch("/api/health"); if (!r.ok) return { ok: false, llm: false }; const j = await r.json(); return { ok: true, llm: j.llm === true }; } catch { return { ok: false, llm: false }; }
}

// ----------------------------------------------------------------------------------------------- API urls (plain links; the app runs locally)
const bq = (book: string | null | undefined, first: boolean) => (book ? `${first ? "?" : "&"}book=${encodeURIComponent(book)}` : "");
export const api = {
  reportXlsx: (week: number, book?: string | null) => `/api/report.xlsx?week=${week}${bq(book, false)}`,
  parametersXlsx: "/api/parameters.xlsx",
  templateXlsx: "/api/template.xlsx",
  pdf: (kind: string, o: { week: number; loan?: string; ids?: string[]; book?: string | null }) =>
    `/api/pdf/${kind}?week=${o.week}${o.loan ? `&loan=${encodeURIComponent(o.loan)}` : ""}${o.ids?.length ? `&ids=${o.ids.map(encodeURIComponent).join(",")}` : ""}${bq(o.book, false)}`,
};

// ----------------------------------------------------------------------------------------------- formatting
const dparts = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return { y, m, d }; };
/** "week of 18 Jan 2026" (long) or "18 Jan 23"; month names and the word "week" follow the selected language */
export const weekLabel = (iso: string, long = false) => { const { y, m, d } = dparts(iso); return long ? `${weekOfWord()} ${d} ${monthName(m)} ${y}` : `${d} ${monthName(m)} ${String(y).slice(2)}`; };
export const dayLabel = (iso: string) => { const { y, m, d } = dparts(iso); return `${d} ${monthName(m)} ${y}`; };
export const monthOf = (iso: string) => monthName(dparts(iso).m);
export const usd = (v: number, d = 1) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(d)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`);
export const sgnUsd = (v: number) => `${v >= 0 ? "+" : "-"}${usd(Math.abs(v))}`;
export const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
export const sgnPct = (v: number, d = 0) => `${v >= 0 ? "+" : "−"}${(Math.abs(v) * 100).toFixed(d)}%`;
/** reference palette (navy to rust); mirrors the --pal-* CSS variables */
export const PALETTE = { navy: "#1f4e6e", blue: "#2f6f96", steel: "#3f86ab", teal: "#6aa9c2", sky: "#9ccfda", ice: "#cfe9ec", cream: "#f8e4c9", peach: "#f3c6a3", apricot: "#eda06f", orange: "#de6f3a", rust: "#b8401a" } as const;
export const LEVEL_COLOR: Record<Level, string> = { Normal: "#3f86ab", Watch: "#eda06f", High: "#de6f3a", Severe: "#b8401a" };
export const LEVELS: Level[] = ["Severe", "High", "Watch", "Normal"];
const LEVEL_RANK: Record<Level, number> = { Severe: 3, High: 2, Watch: 1, Normal: 0 };
/** loan order everywhere: highest stress level first; within the same level, the largest loan amount first */
export const byStress = (x: { level: Level; loan: { amountUsd: number } }, y: { level: Level; loan: { amountUsd: number } }) =>
  LEVEL_RANK[y.level] - LEVEL_RANK[x.level] || y.loan.amountUsd - x.loan.amountUsd;
/** borrower health from the Crop Health Index (display only), coloured the same everywhere: higher = greener.
 *  rust "at risk" below 45, apricot "watch" 45-60, steel blue "healthy" above 60; grey = no CHI (outside the crop season) */
export type Health = "atrisk" | "watch" | "healthy" | "nodata";
export const HEALTHS: Health[] = ["atrisk", "watch", "healthy", "nodata"];
export const HEALTH_COLOR: Record<Health, string> = { atrisk: "#b8401a", watch: "#eda06f", healthy: "#3f86ab", nodata: "#9ab3c2" };
export const healthOf = (fhi: number | null | undefined): Health => (fhi == null ? "nodata" : fhi < 45 ? "atrisk" : fhi <= 60 ? "watch" : "healthy");
export const chiColor = (v: number | null | undefined) => HEALTH_COLOR[healthOf(v)];
/** province / state of a loan: the first part of its region name ("Santa Fe · Centro" -> "Santa Fe"), keyed with the country */
export const provinceOf = (l: { region: string; country: string }) => { const name = l.region.split(" · ")[0]; return { key: `${name}|${l.country}`, name }; };
/** ISO-8601 week number and week-year of a date, and how many ISO weeks that year has (52 or 53) */
export function isoWeek(iso: string): { week: number; year: number; of: number } {
  const wk = (d: Date) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3);
    const y = t.getUTCFullYear(), first = new Date(Date.UTC(y, 0, 4)); return { y, n: 1 + Math.round(((t.getTime() - first.getTime()) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7) }; };
  const a = wk(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
  return { week: a.n, year: a.y, of: wk(new Date(Date.UTC(a.y, 11, 28))).n };
}
export const levelOf = (s: number): Level => (s >= 70 ? "Severe" : s >= 45 ? "High" : s >= 25 ? "Watch" : "Normal");
export const PERILS: Peril[] = ["drought", "excess_water", "frost", "heat", "hail"];
export const levelLabel = (l: Level) => C(`level.${l}`);
export const perilLabel = (p: Peril) => C(`peril.${p}`);
export const CASCADE_STEPS: Cascade[] = ["none", "early", "active", "confirmed"];
export const cascadeText = (c: Cascade) => C(`casc.${c}`);
export const cascadeStep = (c: Cascade) => C(`cascStep.${c}`);
/** lower-case word for the small pill in the tables (English keeps the raw key) */
export const cascadeWord = (c: Cascade) => (getLang() === "en" ? c : C(`cascStep.${c}`).toLowerCase());
const STAGE_CODES = ["inactive", "performing", "critical_alert", "dpd_30", "dpd_90"] as const;
export const stageReasonText = (code: string, sicr = 2) =>
  code === "pd_2x_origination" ? C("sr.pd_2x_origination", sicr) : (STAGE_CODES as readonly string[]).includes(code) ? C(`sr.${code as (typeof STAGE_CODES)[number]}`) : code.replace(/_/g, " ");
/** localized crop name (falls back to the backend label for crops this app does not know) */
export const cropText = (meta: Meta, c: Crop) => cropLabel(c, meta.crops[c]?.label ?? c);
export const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const ord = (n: number) => { if (getLang() !== "en") return String(n); const s = ["th", "st", "nd", "rd"], v = n % 100; return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`; };
const m1 = (v: number, d = 1) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;

const spiClass = (v: number) => K(v <= -2 ? "spi.ext_dry" : v <= -1.5 ? "spi.sev_dry" : v <= -1 ? "spi.mod_dry" : v >= 2 ? "spi.ext_wet" : v >= 1.5 ? "spi.very_wet" : v >= 1 ? "spi.mod_wet" : "spi.normal");
const RAINDAYS: Record<string, number> = { spi30: 30, spi60: 60, spi90: 90 };

/** Plain-language sentence for one reason code (the backend only sends computed facts). */
export function reasonText(r: Reason, loan: Loan, w: number): string {
  const v = r.value, n = loan.ndviZ.length ? loan.clim.mean.length : 0; void n;
  switch (r.code) {
    case "ndvi_z": return v < 0 ? K("r.ndvi_below", Math.abs(v).toFixed(1), loan.yieldHistory.years.length) : K("r.ndvi_above", v.toFixed(1), loan.yieldHistory.years.length);
    case "ndvi_pct": return K("r.ndvi_pct", ord(Math.round(v)));
    case "spi30": case "spi60": case "spi90": return K("r.spi", RAINDAYS[r.code], m1(v), spiClass(v));
    case "sm_pct": return K("r.sm", ord(Math.round(v)), v < 20 ? K("r.sm_dry") : v > 90 ? K("r.sm_sat") : "");
    case "frost_min": return K("r.frost", m1(v));
    case "hot_days": return K("r.hot", Math.round(v));
    case "water_frac": return K("r.water", pct(v));
    case "hail_drop": return K("r.hail", Math.abs(v * 100).toFixed(0));
    case "stage": return K("r.stage", stageName(loan.stage[w]), v);
    case "harvested": return K("r.harvested");
    case "not_sown": return K("r.not_sown");
    case "irrigated": return K("r.irrigated");
    case "low_confidence": return K("r.low_conf", pct(v));
    default: return `${r.code.replace(/_/g, " ")}: ${v}`;
  }
}
export const reasonsAt = (loan: Loan, w: number) => loan.reasons[w].map(r => reasonText(r, loan, w));

// ----------------------------------------------------------------------------------------------- per-week rows (memoised)
export interface Row {
  loan: Loan; w: number; active: boolean; score: number; level: Level; main: Peril | null; conf: number; cascade: Cascade; stage: 1 | 2 | 3; stageReason: string;
  stageName: string; pd12: number; pdLife: number; lgd: number; ead: number; eclBank: number; ecl: Record<Scenario | "weighted", number>; eclDelta: number;
  p10: number; p50: number; p90: number; met: boolean; gap: boolean; why: string;
}
const rowCache = new WeakMap<Analysis, Map<string, Row[]>>();   // keyed by language + week: Row.why is text
/** main peril; a peril counts only above 15 (below it is a quiet "how close" value). Heat during an active/confirmed drought is the hot-dry form of that
 * drought, so it is attributed to the drought (same rule as the backend's alerts.dominant_peril) */
export function mainPeril(l: Loan, w: number): Peril | null {
  let best = 34.5, k: Peril | null = null;    // quiet perils publish a 1-34 pressure; triggered ones are >= 35 (backend config.PERIL_MAIN_MIN)
  for (const p of PERILS) { const v = l.perils[p]?.[w] ?? 0; if (v > best) { best = v; k = p; } }
  if (k === "heat" && (l.cascade[w] === "active" || l.cascade[w] === "confirmed")) k = "drought";
  return k;
}
export const isGap = (l: Loan, main: Peril | null) => !l.insurance || !l.insurance.perils.includes(main ?? "drought");
export function rowsAt(a: Analysis, w: number): Row[] {
  let m = rowCache.get(a); if (!m) { m = new Map(); rowCache.set(a, m); }
  const ck = `${getLang()}:${w}`, hit = m.get(ck); if (hit) return hit;
  const rows = a.loans.map<Row>(l => {
    const c = l.credit, main = mainPeril(l, w), score = l.score[w];
    return {
      loan: l, w, active: c.stageReason[w] !== "inactive" && (c.ead[w] > 0 || c.stage[w] === 3), score, level: l.level[w], main, conf: l.confidence[w], cascade: l.cascade[w], stage: c.stage[w], stageReason: c.stageReason[w],
      stageName: l.stage[w], pd12: c.pd12[w], pdLife: c.pdLife[w], lgd: c.lgd[w], ead: c.ead[w], eclBank: c.eclBank[w],
      ecl: { base: c.ecl.base[w], adverse: c.ecl.adverse[w], severe: c.ecl.severe[w], weighted: c.ecl.weighted[w] }, eclDelta: c.ecl.weighted[w] - c.eclBank[w],
      p10: l.yield.p10[w] ?? 0, p50: l.yield.p50[w] ?? 0, p90: l.yield.p90[w] ?? 0, met: !!c.insuranceMet?.[w], gap: isGap(l, main),
      why: l.reasons[w].length ? reasonText(l.reasons[w].find(r => !["stage", "irrigated"].includes(r.code)) ?? l.reasons[w][0], l, w) : "",
    };
  });
  m.set(ck, rows); return rows;
}
export const activeRows = (a: Analysis, w: number) => rowsAt(a, w).filter(r => r.active);
export const rowOf = (a: Analysis, w: number, id: string | null) => (id ? rowsAt(a, w).find(r => r.loan.id === id) : undefined);

const idxCache = new WeakMap<Analysis, Map<string, Loan>>();
export function loanById(a: Analysis, id: string): Loan | undefined {
  let m = idxCache.get(a); if (!m) { m = new Map(a.loans.map(l => [l.id, l])); idxCache.set(a, m); }
  return m.get(id);
}

/** Portfolio KPIs at week w, straight from portfolio.* (computed by the backend); stressed-and-uninsured from the rows. */
export function kpisAt(a: Analysis, w: number) {
  const p = a.portfolio, rows = activeRows(a, w);
  const stressed = rows.filter(r => r.level === "High" || r.level === "Severe");
  const pdDoubledEad = rows.filter(r => r.pd12 >= 2 * r.loan.pdOrig).reduce((t, r) => t + r.ead, 0);   // IFRS 9 Stage 2 trigger: PD at least 2x origination
  return {
    n: rows.length, exposure: p.exposure[w], ead: p.ead[w], stressedEad: p.stressedEad[w], stressedShare: p.stressedEad[w] / Math.max(1, p.ead[w]),
    severe: p.byLevelCount?.Severe[w] ?? rows.filter(r => r.level === "Severe").length, high: p.byLevelCount?.High[w] ?? rows.filter(r => r.level === "High").length,
    stage1: p.stage1?.[w] ?? rows.filter(r => r.stage === 1).length, stage2: p.stage2[w], stage3: p.stage3[w],
    eclBank: p.eclBank[w], eclW: p.ecl.weighted[w], eclBase: p.ecl.base[w], eclAdverse: p.ecl.adverse[w], eclSevere: p.ecl.severe[w],
    pdDoubledEad, pdDoubledShare: pdDoubledEad / Math.max(1, p.ead[w]),
    uninsuredStressedEad: stressed.filter(r => r.gap).reduce((s, r) => s + r.ead, 0), stressedN: stressed.length,
  };
}
/** The same totals for any subset of rows (Ask page filters). */
export function totalsOf(rows: Row[]) {
  const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  return {
    n: rows.length, ead: sum(r => r.ead), bank: sum(r => r.eclBank), w: sum(r => r.ecl.weighted), stage2: rows.filter(r => r.stage === 2).length, stage3: rows.filter(r => r.stage === 3).length,
    stressed: rows.filter(r => r.level === "High" || r.level === "Severe"), gap: rows.filter(r => r.gap),
  };
}

export function alertsWindow(a: Analysis, w: number, span = 3) {
  return a.alerts.filter(x => x.week > w - span && x.week <= w).sort((x, y) => y.week - x.week || y.score - x.score);
}

// ----------------------------------------------------------------------------------------------- actions
export type ActKind = "contact" | "downgrade" | "restructure" | "transfer" | "claim" | "cover" | "insure";
/** every action is an output: the document the analyst downloads (backend /api/pdf/<pdf>); title/doc follow the selected language */
const ACT_PDF: Record<ActKind, string> = { downgrade: "downgrade", transfer: "transfer", insure: "insurance_application", claim: "claim", restructure: "restructure", cover: "cover_offer", contact: "contact" };
export const ACT: Record<ActKind, { readonly title: string; readonly doc: string; pdf: string }> = Object.fromEntries((Object.keys(ACT_PDF) as ActKind[]).map(k => [k, {
  get title() { return K(`t.${k}`); }, get doc() { return K(`d.${k}`); }, pdf: ACT_PDF[k],
}])) as never;
/** display name of a generated document by backend PDF kind */
export const pdfKindLabel = (kind: string) => { const k = (Object.entries(ACT_PDF).find(([, v]) => v === kind)?.[0] ?? kind) as string; return ["portfolio", "early_warning", "loan_memo", "soil_sensors"].includes(k) ? K(`d.${k as "portfolio"}`) : (k in ACT_PDF ? K(`d.${k as ActKind}`) : kind.replace(/_/g, " ")); };
export const ACT_ORDER: ActKind[] = ["downgrade", "transfer", "insure", "claim", "restructure", "cover", "contact"];
const REC_KIND: [RegExp, ActKind | null][] = [[/^contact/i, "contact"], [/stage 2/i, "downgrade"], [/claim/i, "claim"], [/parametric/i, "cover"], [/restructure/i, "restructure"], [/transfer/i, "transfer"], [/^no action/i, null]];
export const kindOfRecommendation = (action: string): ActKind | null => REC_KIND.find(([re]) => re.test(action))?.[1] ?? null;

/** Mirror of backend/loanly/alerts.py recommend(): the rule table (situation -> action), used for the queue so no request per loan is needed.
 *  The loan page asks GET /api/explain for the authoritative text and shows that when the backend answers (English only).
 *  `lang` defaults to the selected language; pass "en" to get the English text that kindOfRecommendation() understands. */
export function recommendAt(r: Row, a: Analysis, lang?: Lang): Recommendation {
  const run = () => recommendRule(r, a);
  if (!lang || lang === getLang()) return run();
  return withLang(lang, run);
}
export const recKindAt = (r: Row, a: Analysis) => kindOfRecommendation(recommendAt(r, a, "en").action);
function recommendRule(r: Row, a: Analysis): Recommendation {
  const l = r.loan, w = r.w, ins = l.insurance, p50 = r.p50;
  const matWeeks = Math.max(0, Math.floor((Date.parse(l.maturity) - Date.parse(a.meta.weeks[w])) / 6048e5));
  const mainLbl = r.main ? perilLabel(r.main).toLowerCase() : C("peril.mixed");
  if ((r.level === "High" || r.level === "Severe") && r.met && ins) return { action: K("a.claim"), why: K("w.claim", insuranceType(ins.type), mainLbl, l.id, pct(ins.coverShare)) };
  if (r.stage === 3) { const sec = l.collateral === "land mortgage" || l.collateral === "machinery pledge"; return sec ? { action: K("a.restructure"), why: K("w.s3secured", stageReasonText(r.stageReason), collateralName(l.collateral)) } : { action: K("a.transfer"), why: K("w.s3weak", stageReasonText(r.stageReason)) }; }
  if (r.level === "Severe") return matWeeks <= 12 && p50 <= -0.25 ? { action: K("a.restructure"), why: K("w.severeMat", matWeeks, sgnPct(p50)) }
    : { action: K("a.stage2"), why: K("w.severeCrit", Math.round(r.score), (r.pd12 / Math.max(l.pdOrig, 1e-6)).toFixed(1)) };
  if (r.level === "High") return l.stage[w] === "Harvested" || l.stageWeight[w] <= 0.1 ? { action: K("a.cover"), why: K("w.highSeason", sgnPct(p50)) }
    : { action: K("a.contact"), why: K("w.highContact", mainLbl, sgnPct(p50), ins?.perils.includes("drought") ? "" : K("w.noDrought")) };
  if (r.level === "Watch") return { action: K("a.none"), why: K("w.watch") };
  return { action: K("a.none"), why: K("w.normal") };
}

export interface ActionRec { kind: ActKind; why: string; rec: boolean }
/** Indicative numbers that go into the documents (assumptions, shown as such in the UI). */
export function insurancePreview(r: Row, a: Analysis) {
  const l = r.loan, sum = l.amountUsd;   // same as the PDF: sum insured = loan amount
  const cw = a.meta.crops[l.crop].criticalWindow;
  const trig = l.crop === "soy" || l.crop === "maize" ? K("p.trigger1") : K("p.trigger2");
  return { sum, trigger: trig, window: cw ? `${a.meta.weeks[cw[0]]} ${K("p.to")} ${a.meta.weeks[Math.min(cw[1], a.meta.weeks.length - 1)]}` : "" };
}
export function transferPreview(r: Row) { return { lo: Math.max(0, r.ead - r.ecl.severe), hi: Math.max(0, r.ead - r.ecl.base) }; }
/** The action cards for a loan at week w; `rec` is the (English) recommendation that marks the recommended card. */
export function actionCards(r: Row, a: Analysis, rec: Recommendation): ActionRec[] {
  const l = r.loan, ins = l.insurance, mainLbl = (r.main ? perilLabel(r.main) : perilLabel("drought")).toLowerCase();
  const recKind = kindOfRecommendation(rec.action);
  const covered = !!ins && !isGap(l, r.main);
  const ex = Math.max(0, 1 + r.p50) * l.expectedYieldTHa, tp = transferPreview(r), it = ins ? insuranceType(ins.type) : "";
  return [
    { kind: "downgrade", why: r.stage >= 2 ? K("c.downgrade2", r.stage, stageReasonText(r.stageReason, a.meta.params.sicrMultiplier), pct(l.pdOrig, 1), pct(r.pd12, 1)) : K("c.downgrade1", pct(l.pdOrig, 1), pct(r.pd12, 1)), rec: recKind === "downgrade" },
    { kind: "transfer", why: K("c.transfer", usd(r.ead), usd(tp.lo), usd(tp.hi)), rec: recKind === "transfer" },
    { kind: "insure", why: covered ? K("c.insCovered", mainLbl, it) : `${ins ? K("c.insNot", it, mainLbl) : K("c.insNone")}${K("c.insPrefilled")}`, rec: !covered && r.level !== "Normal" && recKind !== "claim" },
    { kind: "claim", why: covered ? (r.met ? K("c.claimMet", it, insuranceTrigger(ins!.trigger) || K("c.indemnity")) : K("c.claimNotMet", it, mainLbl)) : K("c.claimNone"), rec: recKind === "claim" },
    { kind: "restructure", why: K("c.restructure", ex.toFixed(1), sgnPct(r.p50), l.expectedYieldTHa.toFixed(1), l.maturity), rec: recKind === "restructure" },
    { kind: "cover", why: covered ? K("c.coverCovered") : K("c.coverOffer"), rec: recKind === "cover" },
    { kind: "contact", why: K("c.contact"), rec: recKind === "contact" },
  ];
}

// ----------------------------------------------------------------------------------------------- csv helpers
export const TEMPLATE_COLUMNS = ["loan_id", "farmer_id", "field_id", "lat", "lng", "crop", "sowing_date", "area_ha", "amount_usd", "origination_date", "maturity_date", "rate_pct", "pd_12m_origination", "lgd_bank", "collateral_type", "bcra_situacion", "days_past_due"];
export function toCsv(rows: (string | number)[][]) { return rows.map(r => r.map(x => (typeof x === "string" && /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(",")).join("\n"); }
export function download(name: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ----------------------------------------------------------------------------------------------- real-data snapshot (one day, real APIs)
export interface SnapItem { value: number | string | null; unit?: string; date_of_observation?: string; source?: { name?: string; dataset?: string; resolution?: string; url?: string; fetched_at?: string; note?: string }; sourceLine?: string }
export interface Snapshot { date: string; generatedAt?: string; loans: Record<string, SnapLoan>; sampleLoans?: Record<string, SnapLoan>; sources?: unknown[] }
export interface SnapLoan { lat: number; lng: number; items: Record<string, SnapItem> }
/** demo and sample books reuse ids (L001…), so match on id AND location */
export function snapFor(s: Snapshot | null | undefined, id: string, lat: number, lng: number): SnapLoan | undefined {
  const near = (e?: SnapLoan) => e && Math.abs(e.lat - lat) < 1e-3 && Math.abs(e.lng - lng) < 1e-3 ? e : undefined;
  return near(s?.loans?.[id]) ?? near(s?.sampleLoans?.[id]);
}
let snapP: Promise<Snapshot | null> | null = null;
/** fetched once, lazily; a missing file (404 or the SPA fallback page) is simply null */
export function loadSnapshot(): Promise<Snapshot | null> {
  snapP ??= fetch("/data/real_snapshot.json").then(r => (r.ok && /json/.test(r.headers.get("content-type") ?? "") ? r.json() : null)).catch(() => null);
  return snapP;
}
