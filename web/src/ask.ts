// "Ask in plain language": a deterministic, rule-based reader of a credit analyst's question (English, Spanish and Portuguese keywords; the answer wording follows the selected language).
// It returns what it understood (so the user can check it), a structured query and the answer, in the shapes of docs/CONTRACT.md §C
// ({ understood, query, answer }). Every number comes from the backend's analysis.json (per-week arrays); nothing is modelled here.
// When the backend reports "llm": true the page sends the text to POST /api/ask instead and renders the same shapes.
import { alertsWindow, cropText, levelLabel, loanById, pct, perilLabel, reasonText, rowsAt, sgnUsd, stageReasonText, totalsOf, usd, weekLabel } from "./data";
import { getLang } from "./i18n";
import { Ak, AkList } from "./locales/ask";
import { C, countryName } from "./locales/common";

const STRESS_NOTE_EN = "Expected loss (PD x LGD x EAD) of today's book if each history season repeated; Stage 3 loans included in every year.";   // backend text; shown translated when it matches
import type { Analysis, Crop, Level, Peril, Row } from "./data";

export type Intent = "list" | "provision" | "stress_test" | "loan" | "compare_regions" | "alerts" | "what_if" | "report";
export type AskPeril = Peril;
export interface AskFilters {
  crop?: Crop[]; regionId?: string[]; country?: string[]; level?: Level[]; peril?: AskPeril[]; stage?: number[];
  insured?: boolean | null; coverageGap?: boolean | null; minScore?: number; maxScore?: number; minEad?: number; maxEad?: number; minPd?: number; maxPd?: number;
  loanIds?: string[]; movedToStage2?: boolean; minConfidence?: number;
}
export interface AskQuery {
  intent: Intent; filters: AskFilters; week: number | null; sort: { by: "score" | "ead" | "eclDelta" | "pd"; desc: boolean }; limit: number;
  whatIf: { beta?: number; yieldShock?: number; worsePct?: number } | null; report: "portfolio" | "early_warning" | "loan_memo" | null; returnPeriod?: number; windowWeeks?: number;
}
export interface AskTable { columns: string[]; rows: (string | number)[][] }
export interface AskPdf { kind: string; loan?: string; ids?: string[] }
export interface AskAnswer { headline: string; kpis: { label: string; value: string }[]; loanIds: string[]; table: AskTable | null; notes: string[]; suggestions: string[]; pdf?: AskPdf | string | null }
export interface AskResult { understood: string[]; query: AskQuery; answer: AskAnswer; parser: "rules" | "llm" }

export const EXAMPLES = [
  "Which soy loans in Santa Fe are under severe drought and have no insurance?",
  "How much does climate add to provisions this quarter?",
  "What is our 1-in-20-year loss?",
  "Show loans that moved to Stage 2 this month",
  "Compare regions by stressed exposure",
  "What if drought gets 20% worse?",
  "Explain loan {LOAN}",
  "Alerts in the last two weeks for maize",
  "Make the early warning report for Entre Ríos",
  "Loans over $100k with PD above 10%",
];
/** the examples with a loan id that exists in the current book */
export const EXAMPLE_GROUPS = { climate: [0, 5, 7, 4], finance: [1, 2, 3, 9] } as const;
export function examplesFor(a: Analysis, w: number): string[] {
  const top = [...rowsAt(a, w)].filter(r => r.active).sort((x, y) => y.score - x.score)[0];
  void EXAMPLES; void top;
  // shown on the Ask page as two groups of four: climate questions first, then finance questions
  return [...EXAMPLE_GROUPS.climate, ...EXAMPLE_GROUPS.finance].map(i => Ak(`ex.${i as 0}`));
}

// ----------------------------------------------------------------------------------------------- reading the text
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const has = (s: string, re: RegExp) => re.test(s);
const word = (k: string) => new RegExp(`(?<![a-z])${k}(?![a-z])`);
const CROP_WORDS: [Crop, RegExp][] = [
  ["soy", /(?<![a-z])(soy|soja|soya|soybeans?)(?![a-z])/], ["maize", /(?<![a-z])(maize|maiz|corn|milho)(?![a-z])/],
  ["wheat", /(?<![a-z])(wheat|trigo)(?![a-z])/], ["sunflower", /(?<![a-z])(sunflowers?|girasol(es)?|girassol|girassois)(?![a-z])/],
];
const PERIL_WORDS: [AskPeril, RegExp][] = [
  ["drought", /(?<![a-z])(drought|sequia|dry|dryness|seco|seca)(?![a-z])/], ["frost", /(?<![a-z])(frosts?|helada|heladas|freeze|geada|geadas)(?![a-z])/],
  ["heat", /(?<![a-z])(heat|calor|heatwave|hot)(?![a-z])/], ["hail", /(?<![a-z])(hail|granizo)(?![a-z])/],
  ["excess_water", /(?<![a-z])(floods?|flooding|inundacion(es)?|excess water|excess_water|exceso de agua|waterlogg\w*|anegamiento|inundacao|inundacoes|excesso de agua|alagamento)(?![a-z])/],
];
const peril = (p: AskPeril) => perilLabel(p).toLowerCase();   // "drought", "excess water", "sequía", "seca" ...
const REGION_ALIAS: Record<string, string[]> = { "BR-RS": ["rio grande", "missoes"], "PY-IT": ["itapua"], "AR-ER": ["parana"], "AR-BS": ["sudeste"] };
const COUNTRY_WORDS: [string, string][] = [["argentina", "Argentina"], ["uruguay", "Uruguay"], ["brazil", "Brazil"], ["brasil", "Brazil"], ["paraguay", "Paraguay"]];
const MONTHS: [string, number][] = [
  ["january", 1], ["february", 2], ["march", 3], ["april", 4], ["may", 5], ["june", 6], ["july", 7], ["august", 8], ["september", 9], ["october", 10], ["november", 11], ["december", 12],
  ["janeiro", 1], ["fevereiro", 2], ["marco", 3], ["maio", 5], ["junho", 6], ["julho", 7], ["setembro", 9], ["outubro", 10], ["dezembro", 12], ["enero", 1], ["febrero", 2], ["marzo", 3], ["abril", 4], ["mayo", 5], ["junio", 6], ["julio", 7], ["agosto", 8], ["septiembre", 9], ["setiembre", 9], ["octubre", 10], ["noviembre", 11], ["diciembre", 12],
  ["sept", 9], ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["jun", 6], ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
];
const SHORT_OK = new Set(["may", "march", "sept", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]);
const MONTH_RE = new RegExp(`(?:(?<![a-z])(as of|in|by|until|during|en|hasta|from|at|end of|of|em|ate)\\s+(?:the\\s+)?)?(?:(early|beginning of|mid|middle of|late|end of|principios de|inicios de|mediados de|fines de|finales de|inicio de|meados de|fim de|final de)\\s+)?(?<![a-z])(${MONTHS.map(m => m[0]).join("|")})(?![a-z])`);
const num = (s: string) => Number(s.replace(",", "."));
const unitMul = (u?: string) => (!u ? 1 : /^(k|thousand|mil)$/.test(u) ? 1e3 : 1e6);
const WORDNUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, dos: 2, tres: 3, cuatro: 4, un: 1, una: 1, duas: 2, dois: 2, quatro: 4, um: 1, uma: 1 };

function readRegions(n: string, a: Analysis) {
  const groups = new Map<string, Analysis["meta"]["regions"]>();
  for (const r of a.meta.regions) { const f = norm(r.name.split("·")[0].trim()); groups.set(f, [...(groups.get(f) ?? []), r]); }
  const ids = new Set<string>();
  for (const [first, rs] of groups) {
    if (!has(n, word(first))) continue;
    const narrowed = rs.filter(r => { const sec = norm(r.name.split("·")[1]?.trim() ?? ""); return sec && has(n, word(sec)); });
    for (const r of (rs.length > 1 && narrowed.length ? narrowed : rs)) ids.add(r.id);
  }
  for (const r of a.meta.regions) if (!ids.has(r.id) && (REGION_ALIAS[r.id] ?? []).some(al => has(n, word(al)))) ids.add(r.id);
  return a.meta.regions.filter(r => ids.has(r.id));
}
const shortRegion = (r: { name: string }) => r.name.split("·")[0].trim();

function readWeek(n: string, a: Analysis, w: number): number | null {
  const weeks = a.meta.weeks;
  const wk = n.match(/(?<![a-z])(?:week|semana)\s*(\d{1,2})(?![\d%])/);
  if (wk && Number(wk[1]) < weeks.length) return Number(wk[1]);
  const m = n.match(MONTH_RE);
  if (m) {
    const [, lead, part, name] = m;
    if (!(SHORT_OK.has(name) && !lead && !part)) {
      const mon = MONTHS.find(x => x[0] === name)![1];
      const day = !part ? 18 : /early|beginning|principios|inicio/.test(part) ? 5 : /mid|medi|meados/.test(part) ? 15 : 25;
      let best = -1, bd = 1e9;
      weeks.forEach((d, i) => { if (Number(d.slice(5, 7)) === mon) { const dd = Math.abs(Number(d.slice(8, 10)) - day); if (dd < bd) { bd = dd; best = i; } } });
      if (best >= 0) return best;
    }
  }
  return /this week|esta semana|current|today|hoy|hoje/.test(n) ? w : null;
}

export function parseAsk(text: string, a: Analysis, w: number): AskResult {
  const meta = a.meta, raw = text.trim();
  let n = norm(raw);
  const f: AskFilters = {}, understood: string[] = [];
  const q: AskQuery = { intent: "list", filters: f, week: null, sort: { by: "score", desc: true }, limit: 50, whatIf: null, report: null };

  // loan ids: any token that is a loan id of this book
  const known = new Map(a.loans.map(l => [l.id.toUpperCase(), l.id]));
  const toks = [...raw.matchAll(/[A-Za-z0-9][A-Za-z0-9-]{1,}/g)].map(m => m[0].toUpperCase());
  const found = toks.filter(t => known.has(t)).map(t => known.get(t)!);
  const idLike = [...raw.matchAll(/\b([A-Za-z]{1,3}-?[A-Za-z]{0,2}-?\d{2,4})\b/g)].map(m => m[1].toUpperCase()).filter(t => /\d/.test(t) && !/^\d/.test(t));
  if (found.length) f.loanIds = [...new Set(found)];
  else if (idLike.length && has(n, /loan|prestamo|emprestimo|explain|explica|explique|credito/)) f.loanIds = [...new Set(idLike)];

  const pdM = n.match(/(?<![a-z])(?:pd|probability of default|probabilidad de incumplimiento|probabilidade de inadimplencia)(?![a-z])[^\d%]{0,30}?(above|over|exceeds?|exceeding|more than|greater than|>|at least|below|under|less than|<|sobre|mas de|menos de|mais de|acima de|abaixo de|superior (?:a|al)|inferior (?:a|al))?\s*(\d+(?:[.,]\d+)?)\s*%/);
  if (pdM) { const v = num(pdM[2]) / 100, lo = /below|under|less|<|menos|abaixo|inferior/.test(pdM[1] ?? ""); if (lo) f.maxPd = v; else f.minPd = v; n = n.replace(pdM[0], " "); }
  const moneyM = n.match(/(over|above|more than|greater than|larger than|bigger than|at least|exceeding|sobre|mas de|mayores? (?:a|de)|under|below|less than|smaller than|menos de|menores? (?:a|de)|mais de|acima de|abaixo de|superior(?:es)? a|inferior(?:es)? a|<|>)\s*(?:usd|us\$|\$)?\s*(\d+(?:[.,]\d+)?)\s*(k|mm|m|million|millions|thousand|milhao|milhoes|mil|millon|millones)?(?![a-z%])/);
  if (moneyM && (/\$|usd/.test(moneyM[0]) || moneyM[3])) {
    const v = num(moneyM[2]) * unitMul(moneyM[3]), lo = /under|below|less|smaller|menos|menor|abaixo|inferior|</.test(moneyM[1]);
    if (lo) f.maxEad = v; else f.minEad = v; n = n.replace(moneyM[0], " ");
  }
  const scoreM = n.match(/(?<![a-z])(?:score|puntaje|pontuacao)[^\d]{0,15}?(above|over|>|below|under|<|at least)?\s*(\d{1,3})(?![\d%])/);
  if (scoreM) { if (/below|under|</.test(scoreM[1] ?? "")) f.maxScore = Number(scoreM[2]); else f.minScore = Number(scoreM[2]); n = n.replace(scoreM[0], " "); }
  const confM = n.match(/(?:confidence|confianza|confianca)[^\d]{0,15}?(above|over|>|at least)?\s*(\d{1,3})\s*%/);
  if (confM) { f.minConfidence = Number(confM[2]) / 100; n = n.replace(confM[0], " "); }
  const topM = n.match(/(?<![a-z])(?:top|first|primeros|principales|primeiros|principais)\s+(\d+)/); if (topM) q.limit = Math.min(200, Number(topM[1]));

  const stM = n.match(/(?:stage|etapa|fase|estagio)\s*([123])/);
  if (stM) { f.stage = [Number(stM[1])]; if (has(n, /moved|migrat|became|turned|downgrad|pasaron|paso a|pasan|entered|passaram|passou|migraram/)) f.movedToStage2 = true; }

  const dropPct = n.match(/(\d+(?:[.,]\d+)?)\s*%/);
  const reportWord = has(n, /(?<![a-z])(report|pdf|memo|informe|reporte|relatorio|print)(?![a-z])/);
  const whatIf = has(n, /what if|what happens if|suppose|scenario|escenario|y si |e se |(?<![a-z])si (la|el|los|las|llueve|hay|se)(?![a-z])|\d+\s*%\s*(worse|peor|pior|more severe|lower|menos|drop|decline|harsher)|(worse|peor|more severe) by/);
  const stress = has(n, /1\s*[- ]?\s*(?:in|en|em)\s*[- ]?\s*\d+|stress test|worst year|worst case|tail|p9[59]|return period|peor ano|pior ano|perdida (extrema|en un ano)|perda extrema|value at risk|\bvar\b|prueba de estres|teste de estresse/);
  const compare = has(n, /compar|by region|per region|por region|por regiao|por regioes|regional|concentration|concentracion|concentracao|which regions?|what regions?|cual(es)? region|quais regioes/);
  const alerts = has(n, /(?<![a-z])(alerts?|alertas?)(?![a-z])|what changed|got worse|gotten worse|worsen|deteriorat|empeor|pioraram|piorou|last (two|2|three|3|four|4) weeks|new this week|ultimas? (dos |duas )?semanas/);
  const prov = has(n, /provis|(?<![a-z])ecl(?![a-z])|(?<![a-z])pce(?![a-z])|expected credit loss|ifrs|niif|climate add|perdida esperada|perda (de credito )?esperada|cuanto (agrega|suma)|acrescenta/);
  if (f.loanIds?.length && !has(n, /compare|alerts?/) && !reportWord) q.intent = "loan";
  else if (reportWord) q.intent = "report";
  else if (whatIf) q.intent = "what_if";
  else if (stress) q.intent = "stress_test";
  else if (compare) q.intent = "compare_regions";
  else if (alerts) q.intent = "alerts";
  else if (prov) q.intent = "provision";

  const crops = CROP_WORDS.filter(([, re]) => re.test(n)).map(c => c[0]); if (crops.length) f.crop = crops;
  const perils = PERIL_WORDS.filter(([, re]) => re.test(n)).map(c => c[0]); if (perils.length) f.peril = perils;
  const regs = q.intent === "loan" ? [] : readRegions(n, a);
  if (regs.length) f.regionId = regs.map(r => r.id);
  const ctry = COUNTRY_WORDS.filter(([k]) => has(n, word(k))).map(c => c[1]).filter((c, i, arr) => arr.indexOf(c) === i && meta.regions.some(r => r.country === c));
  if (ctry.length && q.intent !== "loan") f.country = ctry;

  const lv = new Set<Level>();
  if (has(n, /(?<![a-z])(severe|critical|critico|critica|severo|severa|grave)(?![a-z])/)) lv.add("Severe");
  if (has(n, /(?<![a-z])(high|alto|alta)(?![a-z])/)) lv.add("High");
  if (has(n, /(?<![a-z])(watch|vigilancia|atencao)(?![a-z])/)) lv.add("Watch");
  if (has(n, /(?<![a-z])(normal|healthy|sano|sanos)(?![a-z])/) && q.intent !== "what_if") lv.add("Normal");
  if (has(n, /under stress|at risk|risky|en riesgo|en estres|estresad|stressed(?! (exposure|ead|amount|share))/)) { lv.add("High"); lv.add("Severe"); }
  if (q.intent !== "compare_regions" && has(n, /bajo estres|sob estresse|em estresse|em risco|estressad/)) { lv.add("High"); lv.add("Severe"); }
  if (lv.size && f.minScore == null && f.maxScore == null) f.level = (["Severe", "High", "Watch", "Normal"] as Level[]).filter(l => lv.has(l));

  if (has(n, /coverage gap|not covered|uncovered|without cover|no cover|sin cobertura|sem cobertura|brecha de cobertura|lacuna de cobertura|unprotected|no (drought|hail|frost|heat|flood) (cover|insurance)/)) f.coverageGap = true;
  if (has(n, /no insurance|uninsured|without insurance|not insured|sin seguro|no tienen seguro|sem seguro|nao tem seguro/)) f.insured = false;
  else if (!f.coverageGap && has(n, /(?<![a-z])(insured|con seguro|with insurance|asegurad[oa]s?|com seguro|segurad[oa]s?)(?![a-z])/)) f.insured = true;

  if (has(n, /largest|biggest|most exposed|mayor exposicion|maior exposicao|by exposure|by size/)) q.sort = { by: "ead", desc: true };
  else if (has(n, /highest pd|riskiest pd|by pd|mayor pd/)) q.sort = { by: "pd", desc: true };
  else if (has(n, /by provision|biggest provision|most provision|ecldelta/) || q.intent === "provision") q.sort = { by: "eclDelta", desc: true };

  const asOf = readWeek(n, a, w);
  if (asOf != null) q.week = asOf;
  const week = q.week ?? w;
  if (q.intent === "what_if" && f.peril && !f.level) delete f.peril;

  // alert window
  const wn = n.match(/last\s+(\w+)\s+weeks?|ultimas?\s+(\w+)\s+semanas?/);
  q.windowWeeks = wn ? (WORDNUM[wn[1] ?? wn[2]] ?? Number(wn[1] ?? wn[2]) ?? 3) || 3 : has(n, /last month|this month|ultimo mes|este mes|neste mes/) ? 4 : 3;

  if (q.intent === "what_if") {
    const yM = n.match(/yields?\s*(?:fall|fell|drop|down|lower|decline\w*|decrease\w*|reduc\w*)\s*(?:by)?\s*(\d+(?:[.,]\d+)?)\s*%/) ?? n.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:lower|less|drop in|decline in)\s*yields?/);
    const pw = dropPct ? num(dropPct[1]) : 20;
    q.whatIf = yM ? { yieldShock: -num(yM[1]) / 100, beta: meta.params.beta } : { worsePct: pw, beta: meta.params.beta };
  }
  const rp = n.match(/1\s*[- ]?\s*(?:in|en|em)\s*[- ]?\s*(\d+)/); if (q.intent === "stress_test") q.returnPeriod = rp ? Math.max(2, Number(rp[1])) : has(n, /p99/) ? 100 : 20;
  if (q.intent === "report") {
    q.report = f.loanIds?.length ? "loan_memo" : has(n, /early|warning|alerta|temprana|antecipad/) ? "early_warning" : has(n, /ifrs|niif|provis|portfolio|portafolio|cartera|carteira/) ? "portfolio" : "early_warning";
    if (q.report === "early_warning" && !f.level && f.minScore == null) f.minScore = 25;
    if (f.loanIds?.length) q.intent = "loan"; else if (q.report === "portfolio") q.sort = { by: "eclDelta", desc: true };
  }

  const why: Record<Intent, string> = { list: Ak("w.list"), provision: Ak("w.provision"), stress_test: Ak("w.stress", q.returnPeriod ?? 20, meta.histYears.length),
    loan: Ak("w.loan"), compare_regions: Ak("w.compare"), alerts: Ak("w.alerts", q.windowWeeks ?? 3), what_if: Ak("w.what_if"), report: Ak("w.report") };
  understood.push(why[q.intent] + (q.report === "early_warning" ? Ak("w.rEw") : q.report === "portfolio" ? Ak("w.rPf") : q.report === "loan_memo" ? Ak("w.rLm") : ""));
  if (f.loanIds?.length) understood.push(Ak("u.loan", f.loanIds.join(", ")));
  if (f.crop) understood.push(Ak("u.crop", f.crop.map(c => cropText(meta, c).toLowerCase()).join(", ")));
  if (f.regionId) understood.push(Ak("u.region", meta.regions.filter(r => f.regionId!.includes(r.id)).map(r => r.name).join("; ")));
  if (f.country) understood.push(Ak("u.country", f.country.map(countryName).join(", ")));
  if (f.level) understood.push(Ak("u.stress", f.level.map(levelLabel).join(Ak("or"))));
  if (f.peril) understood.push(Ak("u.peril", f.peril.map(peril).join(Ak("or"))));
  if (f.stage) understood.push(f.movedToStage2 ? Ak("u.moved", f.stage[0]) : Ak("u.stage", f.stage.join(Ak("or"))));
  if (f.insured === false) understood.push(Ak("u.noIns"));
  if (f.insured === true) understood.push(Ak("u.ins"));
  if (f.coverageGap) understood.push(Ak("u.gap"));
  if (f.minEad != null) understood.push(Ak("u.eadOver", usd(f.minEad)));
  if (f.maxEad != null) understood.push(Ak("u.eadUnder", usd(f.maxEad)));
  if (f.minPd != null) understood.push(Ak("u.pdAbove", pct(f.minPd, 1)));
  if (f.maxPd != null) understood.push(Ak("u.pdBelow", pct(f.maxPd, 1)));
  if (f.minScore != null) understood.push(Ak("u.score", f.minScore, q.report === "early_warning" ? Ak("u.scoreWatch") : ""));
  if (f.maxScore != null) understood.push(Ak("u.scoreUnder", f.maxScore));
  if (f.minConfidence != null) understood.push(Ak("u.conf", pct(f.minConfidence)));
  if (q.whatIf) understood.push(q.whatIf.worsePct != null ? Ak("u.sceWorse", q.whatIf.worsePct) : Ak("u.sceYield", ((q.whatIf.yieldShock ?? 0) * 100).toFixed(0), meta.params.beta));
  if (q.week != null) understood.push(Ak("u.asOf", weekLabel(meta.weeks[q.week], true)));
  else if (has(n, /this week|now|today|current|esta semana|ahora|hoy|hoje|agora|this quarter|this month|este trimestre|neste trimestre|este mes|neste mes/)) understood.push(Ak("u.asOfSlider", weekLabel(meta.weeks[week], true)));
  if (q.limit !== 50) understood.push(Ak("u.top", q.limit));

  return { understood, query: q, answer: runQuery(q, a, w), parser: "rules" };
}

// ----------------------------------------------------------------------------------------------- running a query
function applyFilters(rows: Row[], f: AskFilters, before?: Map<string, Row>): Row[] {
  return rows.filter(r => {
    if (f.loanIds?.length && !f.loanIds.some(i => i.toUpperCase() === r.loan.id.toUpperCase())) return false;
    if (f.crop && !f.crop.includes(r.loan.crop)) return false;
    if (f.regionId && !f.regionId.includes(r.loan.regionId)) return false;
    if (f.country && !f.country.includes(r.loan.country)) return false;
    if (f.level && !f.level.includes(r.level)) return false;
    if (f.peril && !f.peril.some(p => r.main === p)) return false;
    if (f.stage && !f.movedToStage2 && !f.stage.includes(r.stage)) return false;
    if (f.movedToStage2) { const b = before?.get(r.loan.id); if (!(f.stage?.includes(r.stage) && b && b.stage < r.stage)) return false; }
    if (f.insured === false && r.loan.insurance) return false;
    if (f.insured === true && !r.loan.insurance) return false;
    if (f.coverageGap && !r.gap) return false;
    if (f.minScore != null && r.score < f.minScore) return false;
    if (f.maxScore != null && r.score >= f.maxScore) return false;
    if (f.minEad != null && r.ead <= f.minEad) return false;
    if (f.maxEad != null && r.ead >= f.maxEad) return false;
    if (f.minPd != null && r.pd12 <= f.minPd) return false;
    if (f.maxPd != null && r.pd12 >= f.maxPd) return false;
    if (f.minConfidence != null && r.conf < f.minConfidence) return false;
    return true;
  });
}
const sortRows = (rows: Row[], s: AskQuery["sort"]) => [...rows].sort((x, y) => {
  const v = (r: Row) => s.by === "ead" ? r.ead : s.by === "pd" ? r.pd12 : s.by === "eclDelta" ? r.eclDelta : r.score;
  return (s.desc ? 1 : -1) * (v(y) - v(x));
});
const quant = (sorted: number[], p: number) => { if (!sorted.length) return 0; const x = (sorted.length - 1) * p, i = Math.floor(x); return sorted[i] + (sorted[Math.min(sorted.length - 1, i + 1)] - sorted[i]) * (x - i); };
const logit = (p: number) => Math.log(Math.min(0.999, Math.max(1e-4, p)) / (1 - Math.min(0.999, Math.max(1e-4, p))));
const sig = (x: number) => 1 / (1 + Math.exp(-x));

/** crop name in the selected language; English keeps the id ("soy"), as before */
const cropName = (c: Crop, meta: Analysis["meta"]) => (getLang() === "en" ? c : cropText(meta, c).toLowerCase());
function scope(f: AskFilters, a: Analysis) {
  const crop = f.crop?.map(c => cropName(c, a.meta)).join(Ak("and"));
  const reg = f.regionId ? a.meta.regions.filter(r => f.regionId!.includes(r.id)).map(shortRegion).filter((x, i, arr) => arr.indexOf(x) === i).join(Ak("and")) : f.country?.map(countryName).join(Ak("and"));
  const text = Ak("scope", crop ?? "", reg ?? "");
  return { crop, reg, text, any: !!(crop || reg), forText: crop || reg ? Ak("for", text) : "" };
}
function conditions(f: AskFilters): string[] {
  const c: string[] = [];
  if (f.level) c.push(Ak("c.level", f.level.map(levelLabel).join(Ak("or"))));
  if (f.peril) c.push(Ak("c.peril", f.peril.map(peril).join(Ak("or"))));
  if (f.movedToStage2) c.push(Ak("c.moved", f.stage?.[0] ?? 2)); else if (f.stage) c.push(Ak("c.stage", f.stage.join(Ak("or"))));
  if (f.insured === false) c.push(Ak("c.noIns")); else if (f.insured === true) c.push(Ak("c.ins"));
  if (f.coverageGap) c.push(Ak("c.gap"));
  if (f.minEad != null) c.push(Ak("c.over", usd(f.minEad)));
  if (f.maxEad != null) c.push(Ak("c.under", usd(f.maxEad)));
  if (f.minPd != null) c.push(Ak("c.pdAbove", pct(f.minPd, 1)));
  if (f.maxPd != null) c.push(Ak("c.pdBelow", pct(f.maxPd, 1)));
  if (f.minScore != null) c.push(Ak("c.score", f.minScore));
  if (f.maxScore != null) c.push(Ak("c.scoreUnder", f.maxScore));
  if (f.minConfidence != null) c.push(Ak("c.conf", pct(f.minConfidence)));
  return c;
}
const join = (arr: string[]) => (arr.length < 2 ? arr.join("") : `${arr.slice(0, -1).join(", ")}${Ak("and")}${arr[arr.length - 1]}`);

function regionTable(rows: Row[], a: Analysis): AskTable {
  const g = a.meta.regions.map(rg => {
    const rr = rows.filter(r => r.loan.regionId === rg.id), st = rr.filter(r => r.score >= 45), sum = (x: Row[], fn: (r: Row) => number) => x.reduce((s, r) => s + fn(r), 0);
    const ead = sum(rr, r => r.ead), sEad = sum(st, r => r.ead);
    return { rg, n: rr.length, ead, sEad, share: ead ? sEad / ead : 0, base: sum(rr, r => r.eclBank), adj: sum(rr, r => r.ecl.weighted), s2: rr.filter(r => r.stage === 2).length, s3: rr.filter(r => r.stage === 3).length };
  }).filter(x => x.n).sort((x, y) => y.sEad - x.sEad);
  return { columns: AkList("rt.cols"),
    rows: g.map(x => [x.rg.name, x.n, usd(x.ead), usd(x.sEad), pct(x.share), usd(x.base), usd(x.adj), sgnUsd(x.adj - x.base), x.s2, x.s3]) };
}

export function runQuery(query: AskQuery, a: Analysis, wNow: number): AskAnswer {
  const f = query.filters, meta = a.meta, week = query.week ?? wNow, en = getLang() === "en";
  const rows = rowsAt(a, week).filter(r => r.active || f.loanIds?.length);
  const sc = scope(f, a), asOfTxt = weekLabel(meta.weeks[week], true), notes: string[] = [];
  const PD_NOTE = Ak("pdNote");
  let before: Map<string, Row> | undefined;
  if (f.movedToStage2) before = new Map(rowsAt(a, Math.max(0, week - 4)).map(r => [r.loan.id, r]));
  const matched = applyFilters(rows, f, before), sorted = sortRows(matched, query.sort), T = totalsOf(matched);
  const ids = sorted.slice(0, query.limit).map(r => r.loan.id);
  const kpiBase = [{ label: Ak("k.loans"), value: String(T.n) }, { label: Ak("k.out"), value: usd(T.ead) }];
  const end = () => notes;
  const none = (what: string): AskAnswer => ({ headline: Ak("none.h", what, asOfTxt), kpis: [], loanIds: [], table: null,
    notes: [Ak("none.note")], suggestions: [sc.any ? Ak("s.stressed", sc.text) : Ak("s.severe"), Ak("s.compare"), Ak("s.alerts2")] });
  const scenTxt = Object.entries(meta.scenarios).map(([k, v]) => `${en ? k : Ak(`sc.${k as "base"}`)} ${pct(v)}`).join(", ");

  if (query.intent === "loan") {
    const r = matched[0];
    if (!r) return { headline: Ak("l.none", f.loanIds?.join(", ") ?? ""), kpis: [], loanIds: [], table: null, notes: [Ak("l.noneNote", a.loans[0]?.id)], suggestions: [Ak("s.severe"), Ak("s.loans100")] };
    const l = r.loan;
    notes.push(...(l.reasons[week].length ? [Ak("l.why", l.reasons[week].map(x => x.code).join(", "))] : []));
    if (en && week === meta.asOfDefault && l.explanationAsOf) notes.unshift(l.explanationAsOf);   // backend prose is English only
    notes.push(Ak("l.ifrs", r.stage, en ? r.stageReason.replace(/_/g, " ") : stageReasonText(r.stageReason, meta.params.sicrMultiplier), pct(r.conf)), l.insurance ? Ak("l.ins", l.insurance.type, r.gap ? Ak("l.insGap") : r.met ? Ak("l.insMet") : "") : Ak("l.noIns"), PD_NOTE);
    const cropL = cropText(meta, l.crop).toLowerCase();
    return { headline: Ak("l.head", l.id, l.borrower, cropL, l.region, levelLabel(r.level), Math.round(r.score), r.main ? Ak("l.mainly", peril(r.main)) : "", pct(l.pdOrig, 1), pct(r.pd12, 1), r.stage, sgnUsd(r.eclDelta)),
      kpis: [{ label: Ak("l.kStress"), value: `${levelLabel(r.level)} · ${Math.round(r.score)}` }, { label: Ak("k.out"), value: usd(r.ead) }, { label: Ak("l.kPd"), value: `${pct(l.pdOrig, 1)} → ${pct(r.pd12, 1)}` }, { label: Ak("l.kIfrs"), value: `${C("stage")} ${r.stage}` }, { label: Ak("l.kEcl"), value: sgnUsd(r.eclDelta) }, { label: Ak("l.kConf"), value: pct(r.conf) }],
      loanIds: [l.id], table: null, notes: end(), pdf: query.report === "loan_memo" ? { kind: "loan_memo", loan: l.id } : undefined,
      suggestions: [Ak("s.memo", l.id), Ak("s.stressed", Ak("scope", cropL, shortRegion(meta.regions.find(g => g.id === l.regionId)!))), Ak("s.provNone")] };
  }
  if (!T.n && !["stress_test", "what_if", "alerts"].includes(query.intent)) return none(sc.any || conditions(f).length ? Ak("none.q", [sc.any ? sc.text : "", ...conditions(f)].filter(Boolean).join(", ")) : Ak("none.that"));

  if (query.intent === "provision" || (query.intent === "report" && query.report === "portfolio")) {
    const d = T.w - T.bank, s2e = matched.filter(r => r.stage === 2).reduce((s, r) => s + r.ead, 0);
    notes.push(Ak("pv.note", scenTxt, meta.params.sicrMultiplier), PD_NOTE);
    return { headline: Ak("pv.head", sgnUsd(d), sc.any ? Ak("pv.on", sc.text) : "", asOfTxt, usd(T.bank), usd(T.w), T.bank ? `${d >= 0 ? "+" : ""}${pct(d / T.bank)}` : C("na"), T.n, T.stage2, T.stage3),
      kpis: [...kpiBase, { label: Ak("pv.kBank"), value: usd(T.bank) }, { label: Ak("pv.kClim"), value: usd(T.w) }, { label: Ak("pv.kChg"), value: sgnUsd(d) }, { label: Ak("pv.kS2"), value: `${T.stage2} · ${usd(s2e)}` }, { label: Ak("pv.kS3"), value: String(T.stage3) }],
      loanIds: ids, table: regionTable(matched, a), notes: end(), pdf: query.intent === "report" ? { kind: "portfolio" } : undefined,
      suggestions: [Ak("s.whatif", 20, sc.forText), Ak("s.stage2", sc.text), Ak("s.loss20"), Ak("s.ifrsReport", sc.forText)] };
  }

  if (query.intent === "stress_test") {
    const st = a.stressTest, N = query.returnPeriod ?? 20, p = 1 - 1 / N, srt = [...st.loss].sort((x, y) => x - y);
    const pN = N === 20 ? st.p95 : N >= 100 ? st.p99 : N === 2 ? st.p50 : quant(srt, p), worst = srt[srt.length - 1];
    const cur = st.currentLoss ?? 0, ead = a.portfolio.ead[week];
    if (sc.any || conditions(f).length) notes.push(Ak("st.n1"));
    notes.push(`${Ak("st.n2", st.years.length)}${st.note ? " " + (!en && st.note === STRESS_NOTE_EN ? Ak("st.note") : st.note) : ""}`, Ak("st.n3", N, st.years.length, st.years.length < N), PD_NOTE);
    const tb: AskTable = { columns: AkList("st.cols"), rows: [
      [Ak("st.r1"), usd(cur), pct(cur / Math.max(1, ead), 1), "1.0×"], [Ak("st.r2"), usd(st.p50), pct(st.p50 / Math.max(1, ead), 1), `${(st.p50 / Math.max(1, cur)).toFixed(1)}×`],
      [Ak("st.r3", N, (p * 100).toFixed(0)), usd(pN), pct(pN / Math.max(1, ead), 1), `${(pN / Math.max(1, cur)).toFixed(1)}×`], [Ak("st.r4", st.worstYear), usd(worst), pct(worst / Math.max(1, ead), 1), `${(worst / Math.max(1, cur)).toFixed(1)}×`]] };
    return { headline: Ak("st.head", N, usd(pN), pct(pN / Math.max(1, ead), 1), usd(ead), usd(cur), st.worstYear, usd(worst)),
      kpis: [{ label: Ak("k.out"), value: usd(ead) }, { label: Ak("st.kN", N), value: usd(pN) }, { label: "p99", value: usd(st.p99) }, { label: Ak("st.kMedian"), value: usd(st.p50) }, { label: Ak("st.kWorst"), value: `${usd(worst)} · ${st.worstYear}` }],
      loanIds: [], table: tb, notes: end(), suggestions: [Ak("s.compare"), Ak("s.whatif", 20, sc.forText), Ak("s.provNone")] };
  }

  if (query.intent === "compare_regions") {
    const tb = regionTable(matched, a), top = tb.rows[0], share = T.ead ? T.stressed.reduce((s, r) => s + r.ead, 0) / T.ead : 0;
    notes.push(Ak("cp.n1"));
    const cl = a.portfolio.clusters[week] ?? [];
    if (cl.length) notes.push(Ak("cp.cl", cl.length, cl.slice(0, 3).map(c => Ak("cp.clItem", c.loanIds.length, usd(c.ead), c.meanScore.toFixed(0))).join("; ")));
    return { headline: top ? Ak("cp.head", String(top[0]), String(top[3]), String(top[4]), sc.any ? sc.text : Ak("theBook"), pct(share), usd(T.ead), asOfTxt) : Ak("cp.none"),
      kpis: [...kpiBase, { label: Ak("cp.kStress"), value: usd(T.stressed.reduce((s, r) => s + r.ead, 0)) }, { label: Ak("cp.kShare"), value: pct(share) }, { label: Ak("cp.kRegions"), value: String(tb.rows.length) }],
      loanIds: [], table: tb, notes: end(), suggestions: [top ? Ak("s.inRegion", String(top[0]).split("·")[0].trim()) : Ak("s.climateLoans"), Ak("s.provNone"), Ak("s.loss20")] };
  }

  if (query.intent === "alerts") {
    const set = new Set(matched.map(r => r.loan.id)), span = query.windowWeeks ?? 3;
    const al = alertsWindow(a, week, span).filter(x => set.has(x.loanId)), worse = al.filter(x => x.kind !== "better"), better = al.length - worse.length;
    const uniq = [...new Set(worse.map(x => x.loanId))], eadOf = (id: string) => rows.find(r => r.loan.id === id)?.ead ?? 0;
    const nSev = worse.filter(x => x.to === "Severe").length;
    notes.push(Ak("al.n1", span, asOfTxt));
    if (better) notes.push(Ak("al.n2", better));
    if (worse[0]) {
      const wr = en ? undefined : rowsAt(a, worse[0].week).find(r => r.loan.id === worse[0].loanId);
      notes.push(Ak("al.n3", wr ? wr.loan.reasons[worse[0].week].map(c => reasonText(c, wr.loan, worse[0].week)).join(". ") + "." : worse[0].explanation));
    }
    return { headline: worse.length ? Ak("al.head", uniq.length, sc.any ? sc.text : Ak("loansWord"), span, asOfTxt, usd(uniq.reduce((s, id) => s + eadOf(id), 0)), nSev) : Ak("al.none", sc.any ? sc.text : Ak("loansWord"), span, asOfTxt),
      kpis: [{ label: Ak("al.kWorse"), value: String(uniq.length) }, { label: Ak("al.kNew"), value: String(worse.filter(x => x.kind === "new").length) }, { label: Ak("al.kSev"), value: String(nSev) }, { label: Ak("al.kImp"), value: String(better) }, { label: Ak("k.out"), value: usd(uniq.reduce((s, id) => s + eadOf(id), 0)) }],
      loanIds: uniq.slice(0, query.limit), table: null, notes: end(), suggestions: [Ak("s.prov", sc.forText), Ak("s.ewReport", sc.forText), Ak("s.compare")] };
  }

  if (query.intent === "what_if") {
    const w0 = query.whatIf ?? { worsePct: 20, beta: meta.params.beta }, sw = meta.scenarios, beta = w0.beta ?? meta.params.beta;
    let newW = sw;
    if (w0.worsePct != null) { const m = (w0.worsePct / 100) * sw.base; newW = { base: sw.base - m, adverse: sw.adverse + m / 2, severe: sw.severe + m / 2 }; }
    let ecl2 = 0, s2New: Row[] = [];
    for (const r of matched) {
      let e = r.ecl.base * newW.base + r.ecl.adverse * newW.adverse + r.ecl.severe * newW.severe;
      if (w0.yieldShock != null) {
        const pd2 = sig(logit(r.pd12) + beta * -w0.yieldShock); e *= Math.min(5, pd2 / Math.max(1e-4, r.pd12));
        if (r.stage === 1 && pd2 >= meta.params.sicrMultiplier * r.loan.pdOrig) s2New.push(r);
      }
      ecl2 += e;
    }
    const label = w0.worsePct != null ? Ak("wi.labelWorse", w0.worsePct) : Ak("wi.labelYield", Math.abs((w0.yieldShock ?? 0) * 100).toFixed(0));
    notes.push(w0.worsePct != null ? Ak("wi.n1", w0.worsePct, pct(sw.base)) : Ak("wi.n1b", beta, meta.params.sicrMultiplier), PD_NOTE);
    const rowsT: (string | number)[][] = [[Ak("wi.r1"), usd(T.w), usd(ecl2), sgnUsd(ecl2 - T.w)], [Ak("wi.r2"), Object.values(sw).map(v => pct(v)).join(" / "), Object.values(newW).map(v => pct(v)).join(" / "), ""]];
    if (w0.yieldShock != null) rowsT.push([Ak("wi.r3"), "", s2New.length, `+${s2New.length}`]);
    return { headline: Ak("wi.head", label, sc.any ? Ak("for", sc.text) : "", usd(T.w), usd(ecl2), sgnUsd(ecl2 - T.w), asOfTxt, w0.yieldShock != null ? Ak("wi.extra", s2New.length) : ""),
      kpis: [{ label: Ak("wi.kNow"), value: usd(T.w) }, { label: Ak("wi.kScen"), value: usd(ecl2) }, { label: Ak("pv.kChg"), value: sgnUsd(ecl2 - T.w) }, { label: Ak("k.out"), value: usd(T.ead) }],
      loanIds: s2New.sort((x, y) => y.ead - x.ead).slice(0, query.limit).map(r => r.loan.id), table: { columns: AkList("wi.cols"), rows: rowsT }, notes: end(),
      suggestions: [Ak("s.whatif", 40, sc.forText), Ak("s.prov", sc.forText), Ak("s.loss20")] };
  }

  // list (and report)
  const parts = conditions(f), gapEad = T.gap.reduce((s, r) => s + r.ead, 0);
  const head = Ak("li.head", T.n, sc.crop ?? "", sc.reg ?? "", parts.length ? " " + join(parts) : sc.reg ? "" : Ak("inBook"));
  notes.push(PD_NOTE);
  if (ids.length < T.n) notes.push(Ak("li.first", ids.length, T.n, query.sort.by === "eclDelta" ? Ak("li.byEcl") : query.sort.by === "ead" ? Ak("li.byEad") : query.sort.by === "pd" ? Ak("li.byPd") : Ak("li.byScore")));
  if (f.movedToStage2) notes.push(Ak("li.moved"));
  const pdf: AskPdf | undefined = query.intent === "report" ? { kind: query.report ?? "early_warning", ids } : undefined;
  return { headline: `${head}${query.intent === "report" ? Ak("li.rep") : ""}${Ak("li.tail", usd(T.ead), T.gap.length, usd(gapEad))}`,
    kpis: [...kpiBase, { label: Ak("li.kS23"), value: `${T.stage2} / ${T.stage3}` }, { label: Ak("li.kProv"), value: sgnUsd(T.w - T.bank) }, { label: Ak("li.kGap"), value: usd(gapEad) }, { label: Ak("li.kAvg"), value: String(Math.round(matched.reduce((s, r) => s + r.score, 0) / T.n)) }],
    loanIds: ids, table: null, notes: end(), pdf,
    suggestions: [Ak("s.prov", sc.forText), Ak("s.whatif", 20, sc.forText), Ak("s.ewReport", sc.forText), Ak("s.compare")] };
}

/** the filters a portfolio page can apply: one crop, one region, and "stressed" if the question was about High/Severe */
export function portfolioPreset(q: AskQuery): { crop?: Crop; region?: string; stressed?: boolean; loan?: string } {
  const f = q.filters;
  return { crop: f.crop?.length === 1 ? f.crop[0] : undefined, region: f.regionId?.length === 1 ? f.regionId[0] : undefined,
    stressed: (!!f.level && f.level.every(l => l === "High" || l === "Severe")) || (f.minScore ?? 0) >= 45, loan: f.loanIds?.[0] };
}
export { loanById };
