// Powerllel thesis: say what you need in plain language or fill the detailed thesis, then four agents answer it in the background.
// Questions follow the packet's illustrative requests 1-7. Server side: team_app/thesis_agents.py.
import { Fragment, useEffect, useRef, useState } from "react";
import { SiteMap } from "./sitemap";
import { LandBar, monthName } from "./charts";
import { AirPermits } from "./permits";
import type { ReactNode } from "react";
import { parseStressFile } from "./api";
import type { StressRow } from "./api";
import { QUESTION_KEYS, getThesis, listTheses, rerankThesis, startRunAgents } from "./thesisApi";
import type { Agent, AgentKey, Anchor, Answer, Portfolio, QKey, RunSum, Scenario, Sensitivity, SiteRow, ThesisInput, ThesisRow, ThesisView, Weights } from "./thesisApi";

// ------------------------------------------------------------------------------------------------ shared bits
export const DEFAULT_THESIS: ThesisInput = {
  title: "", isos: ["ERCOT"], peakMw: 75, questions: ["speed", "cost", "environment"],
  fullTarget: 24, fullCompare: 30, fullLatest: 36, premiumPct: 10, co2Max: 100, slipMonths: 6, slipOpening: 24, slipDelayed: 30,
  wholesaleGrowth: 5, gasGrowth: 3, reliability: "R0", weights: { speed: 34, cost: 33, environment: 33 },
  ownership: null, appetite: "Medium", localNotes: "", stress: null, excluded: [],
};
const ISOS: [string, string][] = [["ERCOT", "ERCOT (Texas)"], ["SPP", "SPP"], ["MISO", "MISO"], ["PJM", "PJM"], ["CAISO", "CAISO (California)"], ["WECC (non-ISO)", "WECC, outside an ISO"]];
const WEIGHT_PRESETS: [string, [number, number, number], string][] = [["Balanced", [34, 33, 33], "Best overall balance"], ["Speed-first", [70, 20, 10], "Earliest possible service"],
  ["Cost-first", [10, 80, 10], "Lowest 10-year cost"], ["Carbon-first", [10, 20, 70], "Lowest operational carbon"]];
const templateOf = (w: Weights) => WEIGHT_PRESETS.find(([, [a, b, c]]) => w.speed === a && w.cost === b && w.environment === c)?.[0] ?? null;

/** Faraday's "choose a template": a customer type from GridTech_Inputs.xlsx fills the priority weights. */
function Templates({ w, pick, busy }: { w: Weights; pick: (name: string, w: Weights) => void; busy?: boolean }) {
  const on = templateOf(w);
  return <div className="preset-grid th-presets">{WEIGHT_PRESETS.map(([k, [a, b, c], blurb], i) => <button key={k} type="button" disabled={busy} className={`preset ${on === k ? "selected" : ""}`} onClick={() => pick(k, { speed: a, cost: b, environment: c })}>
    <span>0{i + 1}</span><b>{k}</b><small>{blurb} · speed {a} / cost {b} / carbon {c}</small></button>)}</div>;
}
const RELIABILITY: [string, string][] = [["R0", "R0 · packet rules: cover what the grid can't"], ["R1", "R1 · plus N-1: the largest onsite unit can fail"], ["R2", "R2 · plus grid loss: protected load"],
  ["R3", "R3 · plus grid loss: protected + relocatable"], ["R4", "R4 · plus Texas SB6"], ["R5", "R5 · full islanding"]];
export const AGENT_ORDER: AgentKey[] = ["optimisation", "financial", "sourcing", "moratorium"];
export const AGENT_ROLE: Record<AgentKey, string> = {
  optimisation: "Powerllel optimiser: sizes and dispatches every scenario",
  financial: "Faraday pool method: pre-scored portfolios ranked by your weights",
  sourcing: "Proposed sites, parcels and site facts (Atria API)",
  moratorium: "Moratoriums and local risk, including Texas state rules",
};
const RES_LABEL: Record<string, string> = { utility_solar: "Solar contract", wind: "Wind contract", nuclear: "Nuclear PPA", battery_4h: "4-h battery", gas_turbine: "Gas turbine", gas_engine: "Gas engines", fuel_cell: "Fuel cell" };
/** Faraday's "what if a resource is not available?" chips. */
export const TOGGLES: [string, string, string][] = [["gas_turbine", "Gas turbine", "#8a3b0e"], ["gas_engine", "Gas engine", "#f26b1d"], ["fuel_cell", "Fuel cell (natural gas)", "#d9822b"], ["battery_4h", "Battery (4 h)", "#8cc9a1"],
  ["wind", "Wind contract", "#2e7d4f"], ["utility_solar", "Solar contract", "#f7c08a"], ["nuclear", "Nuclear PPA", "#111111"]];
function ResourceToggles({ off, set }: { off: string[]; set: (x: string[]) => void }) {
  return <div className="th-res-toggles">{TOGGLES.map(([k, l, c]) => { const on = !off.includes(k); return <button key={k} type="button" className={`th-rt ${on ? "on" : "off"}`} aria-pressed={on}
    onClick={() => set(on ? [...off, k] : off.filter(x => x !== k))}><i style={{ background: c }} />{l}<em>{on ? "AVAILABLE" : "OFF"}</em></button>; })}</div>;
}
const RES_ORDER = ["wind", "utility_solar", "nuclear", "battery_4h", "fuel_cell", "gas_engine", "gas_turbine"];
const SERIES: [string, string, string][] = [["nuclear", "Nuclear", "#111111"], ["wind", "Wind", "#2e7d4f"], ["solar", "Solar", "#f7c08a"], ["battery", "Battery", "#8cc9a1"],
  ["fuel_cell", "Fuel cell", "#d9822b"], ["gas_engine", "Gas engines", "#f26b1d"], ["gas_turbine", "Gas turbine", "#8a3b0e"], ["merchant", "Grid power", "#9a9a96"]];

export const num = (v: number | string | null | undefined) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
export const f0 = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? "–" : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
export const usdM = (v: number | null | undefined, d = 1) => (v == null ? "–" : `$${f0(v, d)}M`);
const signM = (v: number | null | undefined) => (v == null ? "–" : `${v >= 0 ? "+" : "−"}$${f0(Math.abs(v), 1)}M`);

/** The plain-language question each part of the thesis asks (the packet's illustrative requests, with the customer's numbers). */
export function questionText(k: QKey, t: ThesisInput): string {
  switch (k) {
    case "speed": return `We want to reach full demand by month ${t.fullTarget}. What portfolio supports the commissioning ramp to that date, and how much more would it cost than reaching full demand in month ${t.fullCompare}?`;
    case "cost": return `We can reach full demand as late as month ${t.fullLatest}. Find the lowest-cost portfolio, and show its initial-service and full-demand dates, emissions, and dependence on merchant electricity.`;
    case "environment": return `We want average operational emissions below ${t.co2Max} kg CO₂/MWh. What is the earliest full-demand date that meets that limit, and what would it cost?`;
    case "continuity": return "Meet the reduced grid-import limits during stress events without interrupting any Tier 2 demand (Tier 1 may relocate; Tier 0 stays local). What additional resources or cost does that require?";
    case "slip": return `If our grid connection slips ${t.slipMonths} months, can we keep our month-${t.slipOpening} opening? Compare the cost of adapting the portfolio with delaying opening to month ${t.slipDelayed}.`;
    case "premium": return `We would pay up to ${t.premiumPct}% more to reach full demand in month ${t.fullTarget} rather than month ${t.fullCompare}. Is there a feasible portfolio within that premium, and what environmental trade-off would we make?`;
    case "staging": return "Would adding capacity in stages improve on a portfolio whose capacities are selected upfront? Show the benefits, early costs and continuing commitments.";
  }
}
export const QUESTION_TITLE: Record<QKey, string> = { speed: "Speed to power", cost: "Lowest cost", environment: "Environmental performance", continuity: "Continuity during grid stress", slip: "Connection uncertainty", premium: "Willingness to pay", staging: "Deployment in stages" };
const QUESTION_NO: Record<QKey, number> = { speed: 1, cost: 2, environment: 3, continuity: 4, slip: 5, premium: 6, staging: 7 };

/** How many optimiser runs the thesis needs (mirrors thesis_agents.plan; the emissions search may add one). */
export function runCount(q: QKey[]) {
  const s = new Set<string>();
  if (q.some(x => ["speed", "premium", "continuity", "staging"].includes(x))) s.add("target");
  if (q.some(x => ["speed", "premium"].includes(x))) s.add("compare");
  if (q.includes("cost")) s.add("latest");
  if (q.includes("environment")) { s.add("co2_a"); s.add("co2_b"); }
  if (q.includes("continuity")) s.add("no_t2");
  if (q.includes("slip")) ["b", "k", "d"].forEach(x => s.add(`slip_${x}`));
  if (q.includes("staging")) s.add("staged");
  return s.size;
}

// ------------------------------------------------------------------------------------------------ plain language
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, eighteen: 18, "twenty-four": 24 };
const n = (s: string) => (WORDS[s.toLowerCase()] ?? Number(s));

/** Read a plain-language thesis into thesis answers. Returns what it understood, so the person can check it. */
export function parsePlain(text: string, base: ThesisInput): { t: ThesisInput; understood: string[] } {
  const t: ThesisInput = { ...base, weights: { ...base.weights }, questions: [] };
  const got: string[] = [];
  const s = text.replace(/\s+/g, " ");
  const q = new Set<QKey>();
  const mw = /(\d+(?:\.\d+)?)\s*-?\s*MW\b(?! of)/i.exec(s);
  if (mw) { t.peakMw = Number(mw[1]); got.push(`${mw[1]} MW campus`); }
  const isos = new Set<string>();
  if (/\b(ERCOT|Texas|San Antonio|Dallas|Houston|Austin)\b/i.test(s)) isos.add("ERCOT");
  for (const [k] of ISOS) if (k !== "ERCOT" && new RegExp(`\\b${k.split(" ")[0]}\\b`, "i").test(s)) isos.add(k);
  if (/\bCalifornia\b/i.test(s)) isos.add("CAISO");
  if (isos.size) { t.isos = [...isos]; got.push(`Grids: ${[...isos].join(", ")}`); }
  const byMonth = /full demand (?:by|in) month (\d+)/i.exec(s);
  const than = /than (?:reaching full demand )?(?:in |by )?month (\d+)/i.exec(s);
  if (byMonth && (than || /more would it cost/i.test(s))) { t.fullTarget = Number(byMonth[1]); if (than) t.fullCompare = Number(than[1]); q.add("speed"); got.push(`Full demand by month ${t.fullTarget}, compared with month ${t.fullCompare}`); }
  else if (byMonth) { t.fullTarget = Number(byMonth[1]); got.push(`Full demand by month ${t.fullTarget}`); }
  const late = /as late as month (\d+)/i.exec(s);
  if (late || /\b(lowest[- ]cost|cheapest)\b/i.test(s)) { if (late) t.fullLatest = Number(late[1]); q.add("cost"); got.push(`Lowest cost, full demand by month ${t.fullLatest}`); }
  const kg = /(?:below|under|less than|at most|<)\s*(\d+(?:\.\d+)?)\s*kg/i.exec(s);
  if (kg) { t.co2Max = Number(kg[1]); q.add("environment"); got.push(`Emissions below ${t.co2Max} kg CO₂/MWh`); }
  if (/tier 2/i.test(s) && /(without|zero|no) (?:interrupting )?(?:any )?tier 2|tier 2 (?:interruption)? ?(?:of )?zero/i.test(s)) { q.add("continuity"); got.push("No Tier 2 interruption during grid stress"); }
  const slip = /slips? (?:by )?(\w+(?:-\w+)?) months?/i.exec(s);
  if (slip && Number.isFinite(n(slip[1]))) {
    t.slipMonths = n(slip[1]); q.add("slip");
    const keep = /keep (?:our |the )?month[- ](\d+) opening|keep (?:our |the )?opening (?:in |at )?month (\d+)/i.exec(s);
    if (keep) t.slipOpening = Number(keep[1] ?? keep[2]);
    const dl = /delay(?:ing)? (?:the )?opening (?:to|until) month (\d+)/i.exec(s);
    if (dl) t.slipDelayed = Number(dl[1]);
    got.push(`Grid slips ${t.slipMonths} months: keep opening ${t.slipOpening} or delay to ${t.slipDelayed}`);
  }
  const prem = /(?:pay )?up to (\d+(?:\.\d+)?)\s*%/i.exec(s);
  if (prem) { t.premiumPct = Number(prem[1]); q.add("premium"); got.push(`Pay up to ${t.premiumPct}% more for the earlier date`); }
  if (/\b(in stages|staged|stage by stage|year by year)\b/i.test(s)) { q.add("staging"); got.push("Compare staged with upfront capacity"); }
  if (/\bspeed[- ]first|as soon as possible|fastest\b/i.test(s)) { t.weights = { speed: 70, cost: 20, environment: 10 }; got.push("Weights: speed first"); }
  else if (/\bcarbon[- ]first|clean(?:est)?\b/i.test(s) && !kg) { t.weights = { speed: 10, cost: 20, environment: 70 }; got.push("Weights: carbon first"); }
  if (/\blow risk appetite|low[- ]risk\b/i.test(s)) { t.appetite = "Low"; got.push("Low risk appetite"); }
  if (/\bhigh risk appetite\b/i.test(s)) { t.appetite = "High"; got.push("High risk appetite"); }
  const off = new Set<string>();
  for (const [k, re] of [["wind", /\b(no|without)\s+wind\b|\bwind\s+(?:is\s+)?(?:blocked|not available|unavailable)/i], ["utility_solar", /\b(no|without)\s+solar\b|\bsolar\s+(?:is\s+)?(?:blocked|not available|unavailable)/i],
    ["nuclear", /\b(no|without)\s+(?:a\s+)?nuclear\b|\bnuclear\s+(?:is\s+)?(?:blocked|not available|unavailable)/i], ["battery_4h", /\b(no|without)\s+(?:a\s+)?batter(?:y|ies)\b/i],
    ["gas_turbine", /\b(no|without)\s+(?:gas\s+)?turbines?\b/i], ["gas_engine", /\b(no|without)\s+(?:gas\s+)?engines?\b/i], ["fuel_cell", /\b(no|without)\s+fuel\s+cells?\b/i]] as [string, RegExp][])
    if (re.test(s)) off.add(k);
  if (/\b(no|without)\s+(?:onsite\s+)?gas\b/i.test(s)) ["gas_turbine", "gas_engine", "fuel_cell"].forEach(k => off.add(k));
  if (off.size) { t.excluded = [...off]; got.push(`Not available: ${[...off].map(k => TOGGLES.find(x => x[0] === k)?.[1] ?? k).join(", ")}`); }
  t.questions = q.size ? QUESTION_KEYS.filter(k => q.has(k)) : base.questions;
  if (!q.size) got.push("No question recognised: the three required ones are kept (speed, cost, environment)");
  t.title = s.length > 70 ? `${s.slice(0, 67).trim()}…` : s;
  return { t, understood: got };
}

const EXAMPLES: [QKey | "all", string][] = [
  ["speed", "We want to reach full demand by month 24. What portfolio supports the commissioning ramp to that date, and how much more would it cost than reaching full demand in month 30?"],
  ["cost", "We can reach full demand as late as month 36. Find the lowest-cost portfolio your tool can identify, and show its initial-service and full-demand dates, emissions, and dependence on merchant electricity."],
  ["environment", "We want average operational emissions below 100 kg CO2/MWh. What is the earliest full-demand date your tool finds that meets that limit, and what would it cost?"],
  ["continuity", "Meet the reduced grid-import limits during stress events without interrupting any Tier 2 demand. What additional resources or cost does that require?"],
  ["slip", "If our grid connection slips six months, can we keep our month-24 opening? Compare the cost of adapting the portfolio with delaying opening to month 30."],
  ["premium", "We would pay up to 10% more to reach full demand by month 24 rather than month 30. Is there a feasible portfolio within that premium, and what environmental trade-off would we make?"],
  ["staging", "Would adding energy-resource capacity in stages improve on a portfolio whose capacities are selected upfront? Show the benefits, early costs, and continuing commitments."],
  ["all", "75 MW campus in ERCOT. We want full demand by month 24; how much more than month 30? We can reach full demand as late as month 36: find the lowest-cost portfolio. We want emissions below 100 kg CO2/MWh. Run it without interrupting any Tier 2 demand. If our grid connection slips six months, can we keep our month-24 opening, or delay opening to month 30? We would pay up to 10% more for month 24. Compare capacity added in stages with upfront."],
];

export function ThesisStart({ base, onDraft, onDetailed }: { base: ThesisInput; onDraft: (t: ThesisInput, understood: string[]) => void; onDetailed: () => void }) {
  const [text, setText] = useState("");
  const [seen, setSeen] = useState<{ t: ThesisInput; understood: string[] } | null>(null);
  const read = (s = text) => { if (s.trim()) setSeen(parsePlain(s, base)); };
  return <div className="model-page th-page">
    <section className="section model-hero gt-hero">
      <span className="tag orange">NEW THESIS</span>
      <h1 className="display">TELL US YOUR <em>THESIS.</em></h1>
      <p className="lede dark">Say what you need in plain words: how big the campus is, when it has to reach full demand, what you can spend and how clean it must be. Powerllel reads it into a thesis you can check, then four agents answer it in the background.</p>
    </section>
    <section className="section th-start">
      <div className="card th-ask">
        <textarea value={text} onChange={e => { setText(e.target.value); setSeen(null); }} placeholder="e.g. 75 MW campus in ERCOT. We want full demand by month 24; how much more than month 30? Keep emissions below 100 kg CO2/MWh."
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) read(); }} aria-label="Your thesis in plain language" />
        <div className="th-ask-foot"><small>Cmd + Enter to read it · nothing is sent until you run the thesis</small>
          <div className="gt-row"><button className="outline dark-outline small" onClick={onDetailed}>Skip, fill the detailed thesis</button><button className="primary small" disabled={!text.trim()} onClick={() => read()}>Read my thesis</button></div></div>
        {seen && <div className="th-understood">
          <b>What Powerllel understood</b>
          <ul>{seen.understood.map(x => <li key={x}>{x}</li>)}</ul>
          <p className="footnote">Everything else keeps its default. Check it in the detailed thesis before you run.</p>
          <button className="primary" onClick={() => onDraft(seen.t, seen.understood)}>Check the detailed thesis <ArrowIcon /></button>
        </div>}
      </div>
      <h3 className="th-h3">Or start from one of the packet's illustrative requests</h3>
      <div className="th-examples">{EXAMPLES.map(([k, s]) => <button key={k} className="card th-example" onClick={() => { setText(s); read(s); }}>
        <span className="tag">{k === "all" ? "ALL SEVEN" : `${QUESTION_NO[k]} · ${QUESTION_TITLE[k].toUpperCase()}`}</span><p>{s}</p></button>)}</div>
    </section>
  </div>;
}

export function ArrowIcon() {
  return <svg className="arrow-r" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h17M13 5l7 7-7 7" /></svg>;
}

// ------------------------------------------------------------------------------------------------ detailed thesis
export const THESIS_SECTIONS: [string, string][] = [["th-basic", "Basic information"], ["th-cost", "Cost"], ["th-speed", "Speed to power"], ["th-environment", "Environmental performance"], ["th-additional", "Additional information"]];

function Field({ label, hint, err, children, wide }: { label: string; hint?: ReactNode; err?: string; children: ReactNode; wide?: boolean }) {
  return <label className={`gt-field th-field ${wide ? "th-wide" : ""}`}><b>{label}</b>{hint && <small className="hint">{hint}</small>}{children}{err && <small className="gt-err" role="alert">{err}</small>}</label>;
}
function NumIn({ v, set, unit, err, ...rest }: { v: number | string; set: (x: string) => void; unit?: string; err?: string; min?: number; max?: number; step?: number }) {
  return <span className="gt-input"><input className={err ? "invalid" : ""} inputMode="decimal" value={v} onChange={e => set(e.target.value)} {...rest} />{unit && <em>{unit}</em>}</span>;
}
function Ask({ k, t, toggle, children, required }: { k: QKey; t: ThesisInput; toggle: (k: QKey) => void; children: ReactNode; required?: boolean }) {
  const on = t.questions.includes(k);
  return <div className={`th-q ${on ? "on" : ""}`}>
    <label className="th-q-head"><input type="checkbox" checked={on} onChange={() => toggle(k)} />
      <span><b>{QUESTION_NO[k]} · {QUESTION_TITLE[k]}</b>{required && <em className="th-req">Required by the packet</em>}<small>“{questionText(k, t)}”</small></span></label>
    {on && <div className="th-q-body">{children}</div>}
  </div>;
}

export function ThesisForm({ t, setT, onRun, busy, errors, error, understood }: { t: ThesisInput; setT: (t: ThesisInput) => void; onRun: () => void; busy: boolean; errors: Record<string, string>; error: string | null; understood: string[] | null }) {
  const up = (p: Partial<ThesisInput>) => setT({ ...t, ...p });
  const toggle = (k: QKey) => up({ questions: t.questions.includes(k) ? t.questions.filter(x => x !== k) : QUESTION_KEYS.filter(x => x === k || t.questions.includes(x)) });
  const runs = runCount(t.questions);
  const w = t.weights, wt = w.speed + w.cost + w.environment || 1;
  const setW = (key: keyof typeof w, v: number) => {           // moving one slider rescales the other two so the three sum to 100
    const rest = (Object.keys(w) as (keyof typeof w)[]).filter(x => x !== key), restTot = rest.reduce((a, x) => a + w[x], 0);
    const nw = { ...w, [key]: v } as typeof w;
    rest.forEach(x => { nw[x] = restTot > 0 ? Math.round(w[x] / restTot * (100 - v)) : Math.round((100 - v) / 2); });
    up({ weights: nw });
  };
  const fileIn = useRef<HTMLInputElement>(null);
  const [upl, setUpl] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });
  const onFile = (file?: File) => {
    if (!file) return;
    setUpl({ busy: true, msg: null });
    parseStressFile(file).then(r => {
      const rows: StressRow[] = r.rows.map(x => ({ id: x.id, start: x.start, hours: String(x.hours), importPct: String(x.importPct), noticeMin: String(x.noticeMin), include: x.include !== false, operator: x.operator, type: x.type, confidence: x.confidence, notes: x.notes }));
      up({ stress: rows.length ? { mode: "custom", source: file.name, events: rows.filter(x => x.include), excluded: rows.filter(x => !x.include) } : null });
      setUpl({ busy: false, msg: rows.length ? `${rows.filter(x => x.include).length} stress events read from ${file.name}${r.problems.length ? ` · ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}: ${r.problems.slice(0, 2).join("; ")}` : ""}` : `No events read: ${r.problems.join("; ")}` });
    }).catch(e => setUpl({ busy: false, msg: e.message }));
  };
  const nErr = Object.keys(errors).length;
  return <div className="model-page th-page">
    <section className="section model-hero gt-hero">
      <span className="tag orange">SPECIFY YOUR THESIS</span>
      <h1 className="display">DETAILED <em>THESIS.</em></h1>
      <p className="lede dark">Every answer has a default, so change only what you know. Tick the questions you want answered: the packet requires speed to power, cost and environmental performance; the other four are optional.</p>
      {understood && <p className="th-from-words"><b>Filled from your words:</b> {understood.join(" · ")}</p>}
    </section>

    <section className="section th-form">
      <div className="th-cols">
        <div className="th-main">
          <article className="card th-sec" id="th-template"><header><span className="tag">CHOOSE A TEMPLATE</span><h2 className="display">Choose a template</h2><p>Pick the customer type that matches the goal, or set everything yourself below. A template fills the priority weights and ticks the question it cares about most.</p></header>
            <Templates w={t.weights} pick={(name, nw) => {
              const q = name === "Speed-first" ? "speed" : name === "Cost-first" ? "cost" : name === "Carbon-first" ? "environment" : null;
              up({ weights: nw, questions: q && !t.questions.includes(q) ? QUESTION_KEYS.filter(x => x === q || t.questions.includes(x)) : t.questions, co2Max: name === "Carbon-first" && !num(t.co2Max) ? 100 : t.co2Max });
            }} /></article>
          <article className="card th-sec" id="th-basic"><header><span className="tag">1 · BASIC INFORMATION</span><h2 className="display">Basic information</h2><p>Which grids, how big the campus is, and a name for the thesis.</p></header>
            <div className="gt-fields th-grid2">
              <Field wide label="States / ISOs" hint="The grid's stress events feed the optimiser; the site sourcing and policy agents look at sites in these grids.">
                <div className="th-chips">{ISOS.map(([k, l]) => <button key={k} type="button" className={`th-chip ${t.isos.includes(k) ? "on" : ""}`} aria-pressed={t.isos.includes(k)} onClick={() => up({ isos: t.isos.includes(k) ? (t.isos.length > 1 ? t.isos.filter(x => x !== k) : t.isos) : [...t.isos, k] })}>{l}</button>)}</div></Field>
              <Field label="Target campus MW" hint="Peak demand, 5–2000 MW · packet 75. Scales the packet's demand shape, land and remote site." err={errors.peakMw}><NumIn v={t.peakMw} set={x => up({ peakMw: x })} unit="MW" err={errors.peakMw} /></Field>
              <Field label="Thesis name" hint="Optional: shown on the results and the left panel."><span className="gt-input"><input value={t.title} placeholder={`${t.peakMw} MW in ${t.isos.join(", ")}`} onChange={e => up({ title: e.target.value })} /></span></Field>
            </div></article>

          <article className="card th-sec th-avail"><div><h3>What if a resource is not available?</h3><p className="hint">Switch a resource off to see the best portfolio without it, for example wind blocked by regulation or no nuclear contract. Both agents then leave it out: the optimiser cannot build it and the financial agent drops every portfolio that uses it.</p></div>
            <ResourceToggles off={t.excluded ?? []} set={x => up({ excluded: x })} /></article>
          <article className="card th-sec" id="th-cost"><header><span className="tag">2 · COST</span><h2 className="display">Cost</h2><p>The cheapest portfolio you can live with, what an earlier date is worth to you, and how prices move.</p></header>
            <Ask k="cost" t={t} toggle={toggle} required>
              <Field label="Latest acceptable full-demand month" hint="Full demand is reached ten months after opening." err={errors.fullLatest}><NumIn v={t.fullLatest} set={x => up({ fullLatest: x })} unit="month" err={errors.fullLatest} /></Field>
            </Ask>
            <Ask k="premium" t={t} toggle={toggle}>
              <Field label="Extra you would pay for the earlier date" hint={`Over the ten-year evaluation period, for full demand in month ${t.fullTarget} instead of ${t.fullCompare} (set under Speed to power).`} err={errors.premiumPct}><NumIn v={t.premiumPct} set={x => up({ premiumPct: x })} unit="%" err={errors.premiumPct} /></Field>
            </Ask>
            <div className="gt-fields th-grid2 th-plain">
              <Field label="Wholesale power price growth" hint="Real, per year · packet +5%." err={errors.wholesaleGrowth}><NumIn v={t.wholesaleGrowth} set={x => up({ wholesaleGrowth: x })} unit="%/yr" err={errors.wholesaleGrowth} /></Field>
              <Field label="Gas price growth" hint="Henry Hub, real, per year · packet +3%." err={errors.gasGrowth}><NumIn v={t.gasGrowth} set={x => up({ gasGrowth: x })} unit="%/yr" err={errors.gasGrowth} /></Field>
              <Field label="Onsite equipment cost increase" hint="e.g. 6.25% if the state sales-tax exemption ends · 0 = packet costs. Optimiser only." err={errors.capexUpliftPct}><NumIn v={t.capexUpliftPct ?? 0} set={x => up({ capexUpliftPct: x })} unit="% CAPEX" err={errors.capexUpliftPct} /></Field>
              <Field label="Extra grid cost" hint="Added to every MWh bought from the grid, e.g. new large-load charges · 0 = packet. Optimiser only." err={errors.gridAdderExtra}><NumIn v={t.gridAdderExtra ?? 0} set={x => up({ gridAdderExtra: x })} unit="$/MWh" err={errors.gridAdderExtra} /></Field>
            </div></article>

          <article className="card th-sec" id="th-speed"><header><span className="tag">3 · SPEED TO POWER</span><h2 className="display">Speed to power</h2><p>When the campus must reach full demand, and what happens if the grid connection is late.</p></header>
            <Ask k="speed" t={t} toggle={toggle} required>
              <div className="gt-fields th-grid2">
                <Field label="Reach full demand by month" hint={`Opening month ${(num(t.fullTarget) ?? 0) - 10}; earliest full demand is month 24.`} err={errors.fullTarget}><NumIn v={t.fullTarget} set={x => up({ fullTarget: x })} unit="month" err={errors.fullTarget} /></Field>
                <Field label="Compare with full demand in month" hint="A later date to price the speed against." err={errors.fullCompare}><NumIn v={t.fullCompare} set={x => up({ fullCompare: x })} unit="month" err={errors.fullCompare} /></Field>
              </div>
            </Ask>
            <Ask k="slip" t={t} toggle={toggle}>
              <div className="gt-fields th-grid3">
                <Field label="Grid connection slips by" err={errors.slipMonths}><NumIn v={t.slipMonths} set={x => up({ slipMonths: x })} unit="months" err={errors.slipMonths} /></Field>
                <Field label="Opening month to keep" err={errors.slipOpening}><NumIn v={t.slipOpening} set={x => up({ slipOpening: x })} unit="month" err={errors.slipOpening} /></Field>
                <Field label="Or delay opening to month" err={errors.slipDelayed}><NumIn v={t.slipDelayed} set={x => up({ slipDelayed: x })} unit="month" err={errors.slipDelayed} /></Field>
              </div>
            </Ask></article>

          <article className="card th-sec" id="th-environment"><header><span className="tag">4 · ENVIRONMENTAL PERFORMANCE</span><h2 className="display">Environmental performance</h2><p>An emissions limit the portfolio must meet on average over the evaluation period.</p></header>
            <Ask k="environment" t={t} toggle={toggle} required>
              <Field label="Average operational emissions below" hint="Combined grid and onsite emissions per MWh. The agents search for the earliest full-demand date that meets it." err={errors.co2Max}><NumIn v={t.co2Max} set={x => up({ co2Max: x })} unit="kg CO₂/MWh" err={errors.co2Max} /></Field>
            </Ask></article>

          <article className="card th-sec" id="th-additional"><header><span className="tag">5 · ADDITIONAL INFORMATION · OPTIONAL</span><h2 className="display">Additional information</h2><p>Scoring weights, grid-stress continuity, staging, local risks and your own files.</p></header>
            <div className="th-sub"><h3>Scoring weights</h3><p className="hint">How the financial agent ranks portfolios and how the overview picks a headline answer. Set by the template above; fine-tune here.</p>
              <div className="th-weights">{([["speed", "Speed to power"], ["cost", "Cost"], ["environment", "Environmental"]] as const).map(([k, l]) => <label key={k}><span>{l}</span>
                <input type="range" min={0} max={100} value={Math.round(w[k] / wt * 100)} onChange={e => setW(k, +e.target.value)} /><b>{f0(w[k] / wt * 100)}%</b></label>)}</div></div>
            <div className="th-sub"><h3>Grid stress and deployment</h3>
              <Ask k="continuity" t={t} toggle={toggle}><p className="hint">Runs the optimiser again with Tier 2 interruption switched off, against your full-demand target of month {t.fullTarget}.</p></Ask>
              <Ask k="staging" t={t} toggle={toggle}><p className="hint">Runs the month-{t.fullTarget} target once more with capacity added year by year, never removed.</p></Ask>
              <Field label="Reliability standard" hint="Cumulative rules. The packet's examples use R0 (the common rules)."><select value={t.reliability} onChange={e => up({ reliability: e.target.value })}>{RELIABILITY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field></div>
            <div className="th-sub"><h3>Local risks</h3><p className="hint">How much chance of the project stalling you can carry (local opposition, moratoriums, state rules).</p>
              <div className="segment gt-seg">{(["Low", "Medium", "High"] as const).map(a => <button key={a} type="button" className={t.appetite === a ? "on" : ""} onClick={() => up({ appetite: a })}>{a} risk appetite</button>)}</div>
              <span className="gt-input th-notes"><textarea value={t.localNotes} placeholder="Anything you know about local opposition, zoning or moratoriums (kept with the thesis)" onChange={e => up({ localNotes: e.target.value })} /></span></div>
            <div className="th-sub"><h3>Your files</h3><p className="hint">Your own grid-stress events (.csv or .xlsx: start, hours, import %, notice minutes). They replace the grid's events in every optimiser run.</p>
              <div className="gt-row"><input ref={fileIn} type="file" hidden accept=".csv,.xlsx" onChange={e => onFile(e.target.files?.[0])} />
                <button type="button" className="outline dark-outline small" disabled={upl.busy} onClick={() => fileIn.current?.click()}>{upl.busy ? "Reading…" : "Upload stress events"}</button>
                {t.stress && <button type="button" className="link" onClick={() => { up({ stress: null }); setUpl({ busy: false, msg: null }); }}>Remove {t.stress.mode === "custom" ? t.stress.source : "file"}</button>}</div>
              {upl.msg && <p className="footnote">{upl.msg}</p>}</div>
          </article>
        </div>

        <aside className="card th-summary">
          <span className="tag">YOUR THESIS</span>
          <h3>{t.title || `${t.peakMw} MW in ${t.isos.join(", ")}`}</h3>
          <ol className="th-sum-q">{t.questions.map(k => <li key={k}><b>{QUESTION_NO[k]}</b>{QUESTION_TITLE[k]}</li>)}</ol>
          {(t.excluded ?? []).length > 0 && <p className="th-off">Not available: {(t.excluded ?? []).map(k => TOGGLES.find(x => x[0] === k)?.[1] ?? k).join(", ")}</p>}
          {!t.questions.length && <p className="gt-err">Tick at least one question.</p>}
          <dl className="kv"><div><dt>Optimiser runs</dt><dd>up to {runs}</dd></div><div><dt>About</dt><dd>{runs ? `${runs * 2}–${runs * 4} min` : "–"}</dd></div><div><dt>Financial agent</dt><dd>seconds</dd></div></dl>
          {nErr > 0 && <div className="gt-errlist light"><b>{nErr} answer{nErr === 1 ? " needs" : "s need"} fixing</b><ul>{Object.entries(errors).map(([k, m]) => <li key={k}>{m}</li>)}</ul></div>}
          {error && <p className="notice">{error}</p>}
          <button className="primary th-run" disabled={busy || !t.questions.length} onClick={onRun}>{busy ? "Starting the agents…" : <>Run your thesis <ArrowIcon /></>}</button>
          <p className="footnote">The agents run in the background: you can leave this page. Runs whose inputs match an earlier run are reused.</p>
        </aside>
      </div>
    </section>
  </div>;
}

// ------------------------------------------------------------------------------------------------ agents (left panel and results)
/** Which agent produced a card: one coloured rounded tag per agent, the same everywhere (agent rows and cards). */
const AGENT_TAG: Record<AgentKey, string> = { optimisation: "Optimisation agent", financial: "Financial agent", sourcing: "Site sourcing agent", moratorium: "Policy agent" };
export function AgentTag({ a }: { a: AgentKey }) {
  return <span className={`ag-tag ag-${a}`}>{AGENT_TAG[a]}</span>;
}
export function Tags({ a }: { a: AgentKey[] }) {
  return <span className="ag-tags">{a.map(k => <AgentTag key={k} a={k} />)}</span>;
}
export const agentBusy = (a?: Agent) => a?.status === "running" || a?.status === "queued";
export function AgentDot({ a }: { a?: Agent }) {
  const st = a?.status ?? "queued";
  return <i className={`side-dot ag-${st}`} title={`${a?.name ?? ""}: ${st}`} />;
}

function AgentIcon({ st }: { st: Agent["status"] }) {
  if (st === "running" || st === "queued") return <i className={`spin th-ag-spin ${st}`} aria-hidden="true" />;
  return <i className={`th-ag-icon ag-${st}`} aria-hidden="true">{st === "done" ? "✓" : st === "failed" || st === "not-connected" ? "!" : "–"}</i>;
}
function AgentStrip({ v }: { v: ThesisView }) {
  return <ul className="th-agent-rows" aria-label="Agents">{AGENT_ORDER.map(k => { const a = v.agents[k]; return <li key={k} className={`ag-${a.status}`}>
    <AgentIcon st={a.status} /><b><AgentTag a={k} /> <span>{STATE_WORD[a.status].toLowerCase()}</span></b><small title={AGENT_ROLE[k]}>{a.detail}</small></li>; })}</ul>;
}
const STATE_WORD: Record<Agent["status"], string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed", waiting: "Not set up", "not-connected": "Not connected", stopped: "Stopped" };

// ------------------------------------------------------------------------------------------------ results
export const RESULT_SECTIONS: [string, string][] = [["tr-overview", "Overview"], ["tr-power", "Power"], ["tr-environment", "Environment"], ["tr-additional", "Additional information"], ["tr-land", "Land"]];

function PortfolioLine({ p, label }: { p?: Portfolio | null; label?: string }) {
  if (!p) return null;
  if (p.resultStatus && p.resultStatus !== "OK") return <div className="th-pf bad">{label && <span>{label}</span>}<b>No feasible portfolio</b>{p.reason && <small>{p.reason}</small>}</div>;
  if (p.costM == null) return <div className="th-pf">{label && <span>{label}</span>}<b>{p.status === "running" ? <><i className="spin" /> running…</> : "–"}</b></div>;
  return <div className="th-pf">{label && <span>{label}</span>}<b>{p.detail}</b>
    <small>opens m{p.opening} · full demand m{p.fullDemand} · {usdM(p.costM)} · {f0(p.kgPerMwh)} kg CO₂/MWh · {f0(p.cleanSharePct)}% clean · {f0(p.merchantSharePct)}% merchant</small></div>;
}

function AnswerBlock({ who, a, q }: { who: "optimisation" | "financial"; a?: Answer; q: QKey }) {
  if (!a) return <div className="th-ans muted"><AgentTag a={who} /><p>Not asked of this agent.</p></div>;
  if (a.status === "pending") return <div className="th-ans pending"><AgentTag a={who} /><p><i className="spin" /> Working on it…</p></div>;
  const pf: [string, Portfolio | null | undefined][] = q === "speed" || q === "premium" ? [["Target date", a.target], ["Comparison date", a.compare]] : q === "continuity" ? [["No Tier 2 interruption", a.noTier2], ["Tier 2 allowed", a.withTier2]]
    : q === "slip" ? [["Grid on time", a.base], ["Grid late, keep opening", a.keep], ["Grid late, delay opening", a.delay]] : q === "staging" ? [["Upfront", a.upfront], ["In stages", a.staged]] : [["Answer", a.best]];
  return <div className={`th-ans ${a.status}`}><AgentTag a={who} /><p>{a.text}</p>
    {a.status !== "not-covered" && pf.some(([, p]) => p) && <div className="th-pfs">{pf.map(([l, p]) => <PortfolioLine key={l} p={p} label={l} />)}</div>}</div>;
}

/** The headline answer for each feasible optimiser run, ranked by the thesis weights (speed = earlier full demand, cost, emissions). */
function rankRuns(runs: RunSum[], w: ThesisInput["weights"]) {
  const ok = runs.filter(r => r.resultStatus === "OK" && r.costM != null);
  if (!ok.length) return [];
  const span = (xs: number[]) => [Math.min(...xs), Math.max(...xs)] as const;
  const [c0, c1] = span(ok.map(r => r.costM!)), [f0_, f1] = span(ok.map(r => r.fullDemand!)), [e0, e1] = span(ok.map(r => r.kgPerMwh!));
  const u = (x: number, lo: number, hi: number) => (hi - lo < 1e-9 ? 1 : 1 - (x - lo) / (hi - lo));
  const tot = w.speed + w.cost + w.environment || 1;
  return ok.map(r => ({ r, score: 100 * (w.speed * u(r.fullDemand!, f0_, f1) + w.cost * u(r.costM!, c0, c1) + w.environment * u(r.kgPerMwh!, e0, e1)) / tot })).sort((a, b) => b.score - a.score);
}

export function ThesisResults({ v, onStop, onEdit, onEditWith, onOpenRun, onRefresh }: { v: ThesisView; onStop: () => void; onEdit: () => void; onEditWith: (p: Partial<ThesisInput>) => void; onOpenRun: (id: string) => void; onRefresh: () => void }) {
  const t = v.thesis, opt = v.answers.optimisation, fin = v.answers.financial;
  const runs = v.scenarios.map(s => s.run).filter((r): r is RunSum => !!r);
  const [w, setW] = useState<Weights>(v.financial?.weights ?? t.weights);
  useEffect(() => { setW(v.financial?.weights ?? t.weights); }, [v.id]);
    const ranked = rankRuns(runs, w);
  const running = agentBusy(v.agents.optimisation) || agentBusy(v.agents.financial) || agentBusy(v.agents.moratorium);
  const done = v.scenarios.filter(s => s.status === "done").length;
  const rec = v.financial?.recommendation;
  const sites = v.moratorium?.sites ?? [];
  const caps = runs.map(r => r.caps ?? {});
  const notice = policyNotice(sites, caps.some(c => ["gas_turbine", "gas_engine", "fuel_cell"].some(g => (c[g] ?? 0) > 0)), runs.some(r => (r.maxImportMw ?? 1) > 0));
  return <div className="model-page th-page th-results">
    <PolicyNotice n={notice} id="tr-notice" />
    <section className="section gt-hero th-res-head">
      <div className="gt-res-bar"><div><span className="tag orange">THESIS RESULTS</span><span className="gt-res-meta">{new Date(v.createdAt * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {done} of {v.scenarios.length} optimiser runs done</span></div>
        <div className="gt-res-actions">{running && <button className="outline dark-outline" onClick={onStop}>Stop the optimiser runs</button>}<button className="primary" onClick={onEdit}>Edit the thesis</button></div></div>
      <h1 className="display th-title">{t.title}</h1>
      <div className="th-tags">{[`${t.peakMw} MW`, t.isos.join(" · "), t.reliability, ...(t.excluded ?? []).map(k => `No ${(TOGGLES.find(x => x[0] === k)?.[1] ?? k).toLowerCase()}`), ...(Number(t.capexUpliftPct) ? [`Onsite CAPEX +${t.capexUpliftPct}%`] : []), ...(Number(t.gridAdderExtra) ? [`Grid +$${t.gridAdderExtra}/MWh`] : []), ...t.questions.map(q => `${QUESTION_NO[q]} ${QUESTION_TITLE[q]}`)].map(x => <span key={x} className="tag">{x}</span>)}</div>
      <AgentStrip v={v} />
    </section>

    <section className="section th-res-sec" id="tr-overview">
      <SectionTitle n="1" title="Overview" sub="Each question, answered by the optimisation agent and the financial agent. Where both answer, their numbers are compared below." />
      {ranked.length > 0 && <div className="dark-card th-headline"><span className="ag-row"><AgentTag a="optimisation" /><span className="tag orange">BEST RUN FOR YOUR WEIGHTS</span></span>
        <h2 className="display">Recommended portfolio</h2><p className="th-mix">{ranked[0].r.detail}</p>
        <p>{v.scenarios.find(s => s.jobId === ranked[0].r.jobId)?.label} · opens month {ranked[0].r.opening}, full demand month {ranked[0].r.fullDemand} · {templateOf(w) ?? "custom"} weights: speed {f0(w.speed)} / cost {f0(w.cost)} / environment {f0(w.environment)}</p>
        <div className="kpis">{[[usdM(ranked[0].r.costM), "10-yr decision cost"], [`$${f0(ranked[0].r.dollarsPerMwh, 1)}`, "$/requested MWh"], [f0(ranked[0].r.kgPerMwh, 1), "kg CO₂/MWh"], [`${f0(ranked[0].r.cleanSharePct)}%`, "clean share"]].map(([a, b]) => <div key={b}><strong className="display count">{a}</strong><span>{b}</span></div>)}</div></div>}
      {rec?.tradeoffs && <TradeoffCard t={rec.tradeoffs} busy={agentBusy(v.agents.financial)} />}
      {rec?.sensitivity ? <PriceSensitivity s={rec.sensitivity} backup={rec.reliability?.backup?.options} /> : v.financial && <div className="card"><Tags a={["financial"]} /><h3 className="chart-h">Price sensitivity</h3><p className="gt-note">{agentBusy(v.agents.financial) ? "Running the three price scenarios…" : "Not available for this thesis yet. Edit the thesis and run it again to compute it."}</p></div>}
      <div className="th-qs">{t.questions.map(q => <article key={q} className="card th-qcard">
        <header><span className="tag">{QUESTION_NO[q]} · {QUESTION_TITLE[q].toUpperCase()}</span><p className="th-quote">“{questionText(q, t)}”</p></header>
        <div className="th-two"><AnswerBlock who="optimisation" a={opt[q]} q={q} /><AnswerBlock who="financial" a={fin?.[q]} q={q} /></div>
      </article>)}</div>
      {(v.financial?.scopeNote || v.financial?.packetNote) && <p className="footnote">Financial agent · {[v.financial.scopeNote, v.financial.packetNote].filter(Boolean).join(" ")} <a href="/info#mt-data">Data versions</a></p>}
      <div className="card table-card"><Tags a={["optimisation", "financial"]} /><h3 className="chart-h">Where the two agents overlap <small>same question, same date: optimiser (sized and dispatched for these inputs) against the Faraday pool (pre-scored portfolios)</small></h3>
        {v.compare.length === 0 ? <p className="gt-note">{running ? "Appears as the optimiser runs finish." : "No question was answered by both agents."}</p>
          : <div className="table-scroll"><table className="year-table th-cmp"><thead><tr><th className="l">Question</th><th className="l">Agent</th><th className="l">Portfolio</th><th>Opens</th><th>Full demand</th><th>10-yr cost</th><th>kg CO₂/MWh</th><th>Clean</th><th>Merchant</th><th>Cost gap<small className="detail">optimiser vs pool</small></th></tr></thead>
            <tbody>{v.compare.map(c => <Fragment key={`${c.question}${c.item}`}>{(["optimiser", "financial"] as const).map((who, i) => { const p = c[who]; return <tr key={who} className={i ? "th-cmp-2" : "th-cmp-1"}>
              <td className="l">{i === 0 ? <b>{QUESTION_NO[c.question]} · {c.item}</b> : null}</td><td className="l"><b>{who === "optimiser" ? "Optimisation agent" : "Financial agent"}</b></td><td className="l note">{p.detail}</td>
              <td>m{p.opening}</td><td>m{p.fullDemand}</td><td>{usdM(p.costM)}</td><td>{f0(p.kgPerMwh)}</td><td>{f0(p.cleanSharePct)}%</td><td>{f0(p.merchantSharePct)}%</td>
              <td>{i === 0 ? (c.costDiffPct == null ? "–" : `${c.costDiffPct > 0 ? "+" : ""}${f0(c.costDiffPct, 1)}%`) : ""}</td></tr>; })}</Fragment>)}</tbody></table></div>}
        <p className="footnote">Why they differ: the optimiser sizes capacity freely (any block count) and solves the hourly dispatch for these exact inputs; the pool picks from portfolios scored in advance on the packet case, so it can only be as good as the closest portfolio it holds. A negative gap means the optimiser found a cheaper portfolio.</p></div>
    </section>

    <section className="section th-res-sec" id="tr-power">
      <SectionTitle n="2" title="Power" sub="The portfolio in every scenario, when it serves, and how the grid connection arrives." />
      <div className="card table-card"><Tags a={["optimisation"]} /><h3 className="chart-h">Timing <small>opening (initial service), full demand and the grid connection in each optimiser scenario</small></h3>
        <div className="table-scroll"><table className="year-table th-timing"><thead><tr><th>Scenario</th><th className="l">Result</th><th>Opens</th><th>Full demand</th><th className="l">Grid connection</th><th>Max grid import</th><th>Time</th><th /></tr></thead>
          <tbody>{v.scenarios.map(s => <tr key={s.key}><td>{s.label}{s.reused && <small className="detail">reused an identical earlier run</small>}</td><td className="l"><RunState s={s} /></td>
            <td>m{s.run?.opening ?? s.start}</td><td>m{s.run?.fullDemand ?? s.start + 10}</td>
            <td className="note">{s.run?.gridSchedule ? s.run.gridSchedule.filter(g => g.mw > 0).map(g => `${f0(g.mw)} MW m${g.month + (s.gridDelay || 0)}`).join(" · ") : "–"}{s.gridDelay ? <small className="detail">{s.gridDelay} months late</small> : null}</td>
            <td>{s.run?.maxImportMw != null ? `${f0(s.run.maxImportMw, 1)} MW` : "–"}</td><td>{s.run?.elapsed != null ? `${Math.floor(s.run.elapsed / 60)}:${String(s.run.elapsed % 60).padStart(2, "0")}` : "–"}</td>
            <td>{s.jobId && <button className="link" onClick={() => onOpenRun(s.jobId!)}>Open run</button>}</td></tr>)}</tbody></table></div></div>
      <CapacityTable v={v} />
      {rec?.powerOverTime && <PowerOverTime p={rec.powerOverTime} title="Recommended portfolio" sub={rec.recommendation?.detail ?? ""} />}
      {rec?.recommendation && <div className="th-two">
        <div className="card"><span className="ag-row"><AgentTag a="financial" /><span className="tag">FOR YOUR WEIGHTS</span></span><h3 className="chart-h th-mt">Recommended portfolio <small>{rec.recommendation.detail}</small></h3><p>{rec.recommendation.why}</p><p className="gt-note">{rec.recommendation.nextStep}</p>
          <dl className="kv">{[["Opens / full demand", `m${rec.recommendation.opening} / m${rec.recommendation.fullDemand}`], ["10-yr cost", usdM(rec.recommendation.kpis.costM)], ["kg CO₂/MWh", f0(rec.recommendation.kpis.kgPerMwh, 1)], ["Clean share", `${f0(rec.recommendation.kpis.cleanSharePct)}%`], ["Portfolios tested", f0(rec.search?.tested)]].map(([a, b]) => <div key={a}><dt>{a}</dt><dd>{b}</dd></div>)}</dl></div>
        {rec.costBreakdown && <div className="card table-card"><Tags a={["financial"]} /><h3 className="chart-h">Cost of that portfolio <small>10 years</small></h3><div className="table-scroll"><table className="year-table"><tbody>{rec.costBreakdown.rows.map(r => <tr key={r.label}><td>{r.label}<small className="detail">{r.note}</small></td><td>{usdM(r.valueM)}</td><td>{f0(r.sharePct)}%</td></tr>)}</tbody></table></div></div>}
      </div>}
      {sites.some(s => s.gridP50 != null) && <div className="card table-card"><Tags a={["sourcing"]} /><h3 className="chart-h">Grid arrival at the proposed sites <small>median months to a grid connection (P50) and to power with bridge power</small></h3>
        <div className="table-scroll"><table className="year-table"><thead><tr><th>Site</th><th>Grid P50</th><th>Power by</th></tr></thead><tbody>{sites.map(s => <tr key={s.id}><td>{s.label}</td><td>month {f0(s.gridP50)}</td><td>month {f0(s.powerBy)}</td></tr>)}</tbody></table></div></div>}
    </section>

    <section className="section th-res-sec" id="tr-environment">
      <SectionTitle n="3" title="Environment" sub="Average operational emissions and clean share of every portfolio, against your limit." />
      <EmissionsChart v={v} />
      <AirPermits scenarios={v.scenarios} sites={sites} />
      {rec?.tradeoffs && <div className="card table-card"><Tags a={["financial"]} /><h3 className="chart-h">The pool's trade-offs <small>the cheapest, fastest and cleanest portfolios it holds</small></h3>
        <div className="table-scroll"><table className="year-table"><thead><tr><th>Anchor</th><th className="l">Portfolio</th><th>Opens</th><th>Full demand</th><th>10-yr cost</th><th>kg CO₂/MWh</th><th>Clean</th></tr></thead>
          <tbody>{Object.entries(rec.tradeoffs.anchors).map(([k, a]) => <tr key={k}><td>{k[0].toUpperCase() + k.slice(1)}</td><td className="note">{a.detail}</td><td>m{a.opening}</td><td>m{a.fullDemand}</td><td>{usdM(a.costM)}</td><td>{f0(a.kgPerMwh)}</td><td>{f0(a.cleanSharePct)}%</td></tr>)}</tbody></table></div></div>}
    </section>

    <section className="section th-res-sec" id="tr-additional">
      <SectionTitle n="4" title="Additional information" sub="Moratoriums and approvals, including the Texas state picture, the local risk that each proposed site stalls, and the land: onsite land per portfolio and the proposed sites." />
      {!v.moratorium ? <div className="card th-placeholder"><Tags a={["moratorium"]} /><p>{v.agents.moratorium.detail}</p></div> : <>
        {v.moratorium.note && <p className="gt-note top">{v.moratorium.note}</p>}
        {sites.some(s => s.state === "TX") && <ThesisImpact sites={sites} t={t} />}
        {sites.some(s => s.state === "TX") && <WhatIf sites={sites} t={t} onEditWith={onEditWith} />}
        {sites.some(s => s.state === "TX") && <TexasPanel sites={sites} />}
        {sites.some(s => s.state === "TX") && <PermitsCard sites={sites} />}
        <div className="card table-card"><Tags a={["moratorium"]} /><h3 className="chart-h">Moratoriums and approvals per site <small>local moratorium history, zoning and the approvals a data center needs</small></h3>
          <div className="table-scroll"><table className="year-table th-mor"><thead><tr><th>Site</th><th className="l">Local moratorium</th><th className="l">History</th><th className="l">Zoning and approvals</th></tr></thead>
            <tbody>{sites.map(s => { const p = s.policy ?? {}; return <tr key={s.id}><td>{s.county} County, {s.state}<small className="detail">{s.label}</small></td>
              <td className="l"><Outcome o={s.moratorium.outcome} /><small className="detail">{p.moratorium_stage ? `stage: ${p.moratorium_stage.value}` : s.moratorium.headline}</small></td>
              <td className="note">{p.moratorium_history ? String(p.moratorium_history.value) : "–"}</td>
              <td className="note">{p.data_center_approval ? String(p.data_center_approval.value) : p.zoning ? String(p.zoning.value) : "–"}</td></tr>; })}</tbody></table></div>
          {t.localNotes && <p className="gt-note">Your notes: {t.localNotes}</p>}
          <p className="footnote">Sources: county and city council records and local news coverage (moratorium history); Texas Local Government Code ch. 231 (Texas counties have no general zoning authority outside cities); city ordinances where a site is inside a city.</p></div>
        <LocalRisk sites={sites} appetite={t.appetite} />
      </>}
      <div className="th-land-head-sec" id="tr-land"><h3 className="display">Land</h3><p className="section-sub">The onsite land each portfolio needs, and the proposed sites in your grids with their parcel, power, gas, fiber, water and permitting facts.</p></div>
      <div className="card table-card"><Tags a={["optimisation", "financial"]} /><h3 className="chart-h">Onsite land per portfolio <small>gas units and batteries need land; contracts do not</small></h3>
        <div className="table-scroll"><table className="year-table"><thead><tr><th>Scenario</th><th>Land used</th><th>Available</th></tr></thead>
          <tbody>{v.scenarios.filter(s => s.run?.resultStatus === "OK").map(s => <tr key={s.key}><td>{s.label}</td><td>{f0(s.run!.landAcres, 1)} ac</td><td>{f0(s.run!.landLimit, 1)} ac</td></tr>)}
            {rec?.portfolioTable && <tr><td>Financial agent's recommended portfolio</td><td>{f0(rec.portfolioTable.reduce((a, r) => a + (r.landAcres || 0), 0), 1)} ac</td><td>8.0 ac</td></tr>}</tbody></table></div>
        {!runs.some(r => r.resultStatus === "OK") && <p className="gt-note">Appears as the optimiser runs finish.</p>}</div>
      {sites.length > 0 ? <ProposedSites sites={sites} need={Math.max(0, ...runs.filter(r => r.resultStatus === "OK").map(r => r.landAcres ?? 0))} />
        : <div className="card th-placeholder"><Tags a={["sourcing"]} /><p>{v.agents.sourcing.detail}</p></div>}
    </section>
  </div>;
}

function SectionTitle({ n, title, sub }: { n: string; title: string; sub: string }) {
  return <><div className="section-head"><span>{title}</span><span>0{n}</span></div><p className="section-sub">{sub}</p></>;
}

function RunState({ s }: { s: Scenario }) {
  const r = s.run;
  if (s.status === "queued") return <span className="gt-run-state">Queued</span>;
  if (s.status === "stopped") return <span className="gt-run-state warn">Stopped</span>;
  if (s.status === "failed") return <span className="gt-run-state bad" title={s.error}>Failed</span>;
  if (!r || r.status === "running") return <span className="gt-run-state running"><i className="spin" /> {r?.phase ?? "Starting"}</span>;
  return r.resultStatus === "OK" ? <span className="gt-run-state ok">Feasible</span> : <span className="gt-run-state bad" title={r.reason ?? ""}>No feasible portfolio</span>;
}

export function Outcome({ o }: { o: string | null }) {
  const m: Record<string, [string, string]> = { pass: ["ok", "Pass"], caution: ["warn", "Caution"], fail: ["bad", "Fail"], unknown: ["", "Unknown"] };
  const [c, l] = m[o ?? "unknown"] ?? m.unknown;
  return <span className={`gt-run-state ${c}`}>{l}</span>;
}


function CapacityTable({ v }: { v: ThesisView }) {
  const ok = v.scenarios.filter(s => s.run?.resultStatus === "OK");
  if (!ok.length) return null;
  const ids = RES_ORDER.filter(r => ok.some(s => (s.run!.caps ?? {})[r]));
  return <div className="card table-card"><Tags a={["optimisation"]} /><h3 className="chart-h">Capacity in each scenario <small>MW</small></h3>
    <div className="table-scroll"><table className="year-table"><thead><tr><th>Scenario</th>{ids.map(r => <th key={r}>{RES_LABEL[r]}</th>)}<th>10-yr cost</th></tr></thead>
      <tbody>{ok.map(s => <tr key={s.key}><td>{s.label}</td>{ids.map(r => <td key={r}>{f0((s.run!.caps ?? {})[r] ?? 0)}</td>)}<td>{usdM(s.run!.costM)}</td></tr>)}</tbody></table></div></div>;
}

export function PowerOverTime({ p, title, sub }: { p: NonNullable<NonNullable<NonNullable<ThesisView["financial"]>["recommendation"]>["powerOverTime"]>; title: string; sub?: string }) {
  const keys = SERIES.filter(([k]) => (p.series[k] ?? []).some(x => x > 0.05));
  const top = Math.max(1, ...p.years.map((_, i) => Math.max(keys.reduce((a, [k]) => a + (p.series[k]?.[i] ?? 0), 0), p.series.gridCap?.[i] ?? 0, p.series.demand?.[i] ?? 0)));
  const scale = Math.ceil(top / 25) * 25;
  return <div className="card chart-card th-pot"><Tags a={["financial"]} /><div className="chart-title"><span>{title}{sub && <small className="th-sub-t">{sub}</small>}</span><span>MW, average per year</span></div>
    <div className="legend">{keys.map(([k, l, c]) => <span key={k} className="lc" style={{ ["--c" as string]: c }}>{l}</span>)}<span className="dash">Grid import cap</span></div>
    <div className="bars year-bars"><div className="ylabels">{[1, 2 / 3, 1 / 3, 0].map(fr => <span key={fr}>{f0(scale * fr)}</span>)}</div>
      {p.years.map((y, i) => <div className="bar-col" key={y}><div className="stack">{keys.map(([k, l, c]) => <i key={k} style={{ height: `${(p.series[k]?.[i] ?? 0) / scale * 100}%`, background: c }} title={`${l}: ${f0(p.series[k]?.[i], 1)} MW`} />)}
        {p.series.gridCap && <b className="cap-mark" style={{ bottom: `${p.series.gridCap[i] / scale * 100}%` }} />}</div><small className="ytick">Y{y}</small></div>)}</div>
    <p className="axis-label">Financial agent (Faraday pool method) · the hourly dispatch of its recommended portfolio, averaged per model year</p></div>;
}

export function EmissionsChart({ v }: { v: ThesisView }) {
  const lim = num(v.thesis.co2Max);
  const rows: { label: string; kg: number; clean: number; who: string }[] = [
    ...v.scenarios.filter(s => s.run?.resultStatus === "OK").map(s => ({ label: s.label, kg: s.run!.kgPerMwh ?? 0, clean: s.run!.cleanSharePct ?? 0, who: "Optimisation" })),
    ...Object.entries(v.answers.financial ?? {}).flatMap(([q, a]) => (a?.best && a.best.kgPerMwh != null ? [{ label: `${QUESTION_TITLE[q as QKey] ?? "Same opening month"} (pool)`, kg: a.best.kgPerMwh, clean: a.best.cleanSharePct ?? 0, who: "Financial" }] : [])),
  ];
  if (!rows.length) return <div className="card"><p className="gt-note">Appears as the agents answer.</p></div>;
  const top = Math.max(lim ?? 0, ...rows.map(r => r.kg)) * 1.1 || 1;
  return <div className="card th-emis"><Tags a={["optimisation", "financial"]} /><h3 className="chart-h">Average operational emissions <small>kg CO₂ per MWh over the evaluation period{lim != null && v.thesis.questions.includes("environment") ? ` · your limit ${lim}` : ""}</small></h3>
    <div className="th-emis-rows">{rows.map(r => <div key={r.label + r.who} className="th-emis-row"><span>{r.label}<small>{r.who} agent · {f0(r.clean)}% clean</small></span>
      <div className="th-emis-bar"><i className={lim != null && r.kg >= lim ? "over" : ""} style={{ width: `${r.kg / top * 100}%` }} />{lim != null && <b style={{ left: `${lim / top * 100}%` }} title={`limit ${lim}`} />}</div><em>{f0(r.kg)}</em></div>)}</div></div>;
}

// ------------------------------------------------------------------------------------------------ Faraday views: trade-offs and price sensitivity (financial agent)
export function TradeoffCard({ t, busy, mine }: { t: NonNullable<NonNullable<NonNullable<ThesisView["financial"]>["recommendation"]>["tradeoffs"]>; busy: boolean; mine?: RunSum | null }) {
  const r = t.recommended, a = t.anchors;
  const pc = (x: number, base: number) => (base ? (x / base - 1) * 100 : 0);
  const dCost = r.costM - a.cheapest.costM, dKg = r.kgPerMwh - a.cleanest.kgPerMwh, dMo = r.fullDemand - a.fastest.fullDemand;
  const costTxt = dCost < 0.5 ? "matches the cheapest portfolio" : `$${f0(dCost)}M (+${f0(pc(r.costM, a.cheapest.costM))}%) more than the cheapest`;
  const kgTxt = dKg < 0.5 ? "matches the cleanest portfolio" : `${f0(dKg)} kg CO₂/MWh (+${f0(pc(r.kgPerMwh, a.cleanest.kgPerMwh))}%) more carbon than the cleanest`;
  const moTxt = dMo <= 0 ? "as fast as the fastest" : `${dMo} month${dMo === 1 ? "" : "s"} later to full demand than the fastest`;
  const me: Anchor | null = mine && mine.costM != null && mine.fullDemand != null ? { opening: mine.opening ?? 0, fullDemand: mine.fullDemand, costM: mine.costM, kgPerMwh: mine.kgPerMwh ?? 0, cleanSharePct: mine.cleanSharePct ?? 0, detail: mine.detail ?? "" } : null;
  const rows: [string, Anchor, boolean, string?][] = [...(me ? [["Your optimiser run", me, true, "Your run"] as [string, Anchor, boolean, string]] : []), ["Pool: cheapest within your limits", r, !me, "Pool, within limits"], ["Cheapest overall", a.cheapest, false, "Cheapest"], ["Fastest overall", a.fastest, false, "Fastest"], ["Cleanest overall", a.cleanest, false, "Cleanest"]];
  const d = (v: number, unit: string) => (Math.abs(v) < 0.5 ? "best" : `${v > 0 ? "+" : "−"}${f0(Math.abs(v))}${unit}`);
  return <div className={`card table-card ${busy ? "busy" : ""}`}><Tags a={mine ? ["optimisation", "financial"] : ["financial"]} /><h3 className="chart-h">Key trade-offs <small>each portfolio against the best one on each goal</small></h3>
    <p className="th-trade-text">The pool's cheapest portfolio within your limits is {costTxt}, carries {kgTxt}, and is {moTxt}.</p>
    <TradeoffPlot rows={rows} />
    <div className="table-scroll"><table className="year-table"><thead><tr><th>Portfolio</th><th>Full demand</th><th>10-yr cost</th><th>vs cheapest</th><th>kg CO₂/MWh</th><th>vs cleanest</th><th>Clean share</th><th className="l">Mix</th></tr></thead>
      <tbody>{rows.map(([n, x, hi]) => <tr key={n} className={hi ? "total" : ""}><td>{n}</td><td>M{x.fullDemand} <small className="detail">{d(x.fullDemand - a.fastest.fullDemand, " mo")}</small></td><td>{usdM(x.costM, 0)}</td>
        <td className={x.costM - a.cheapest.costM > 0.5 ? "th-bad" : "th-good"}>{d(x.costM - a.cheapest.costM, "M")}</td><td>{f0(x.kgPerMwh)}</td><td className={x.kgPerMwh - a.cleanest.kgPerMwh > 0.5 ? "th-bad" : "th-good"}>{d(x.kgPerMwh - a.cleanest.kgPerMwh, " kg")}</td><td>{f0(x.cleanSharePct)}%</td><td className="note">{x.detail}</td></tr>)}</tbody></table></div>
    <p className="footnote">Cheapest, fastest and cleanest overall are taken over every portfolio in the pool, ignoring your limits.</p></div>;
}

/** Cost against emissions for the four anchor portfolios; the label carries the full-demand month. */
function TradeoffPlot({ rows }: { rows: [string, Anchor, boolean, string?][] }) {
  const W = 640, H = 240, L = 56, R = 16, T = 14, B = 34;
  const xs = rows.map(([, a]) => a.kgPerMwh), ys = rows.map(([, a]) => a.costM);
  const x0 = Math.min(...xs) * 0.85, x1 = Math.max(...xs) * 1.08 || 1, y0 = Math.min(...ys) * 0.92, y1 = Math.max(...ys) * 1.05 || 1;
  const X = (v: number) => L + (v - x0) / (x1 - x0 || 1) * (W - L - R), Y = (v: number) => T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - T - B);
  // points whose dots touch share one label with the lines stacked; each label then takes the first spot (right or left of
  // its dot, nudged up or down) that hits no other label and no dot, with a thin leader line when it had to move
  const LH = 13, CW = 6.6, GAP = 11, rad = (me: boolean) => (me ? 8 : 6);
  const dots = rows.map(([, a, me]) => ({ x: X(a.kgPerMwh), y: Y(a.costM), me }));
  const groups: { x: number; y: number; me: boolean; lines: { t: string; me: boolean }[] }[] = [];
  rows.forEach(([n, a, me, short], i) => {
    const { x, y } = dots[i], line = { t: `${short ?? n} · M${a.fullDemand}`, me };
    const g = groups.find(g => Math.hypot(g.x - x, g.y - y) < 14);
    if (g) { if (me) g.lines.unshift(line); else g.lines.push(line); g.me ||= me; } else groups.push({ x, y, me, lines: [line] });
  });
  type Box = { x0: number; x1: number; y0: number; y1: number };
  const hit = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  const dotBoxes: Box[] = dots.map(d => ({ x0: d.x - rad(d.me) - 2, x1: d.x + rad(d.me) + 2, y0: d.y - rad(d.me) - 2, y1: d.y + rad(d.me) + 2 }));
  const placed: Box[] = [];
  const labels = [...groups].sort((p, q) => Number(q.me) - Number(p.me) || p.y - q.y).map(g => {
    const w = Math.max(...g.lines.map(l => l.t.length * (l.me ? CW + 0.6 : CW))), h = g.lines.length * LH;
    const mid = g.y - h / 2;
    const sides = g.x + GAP + w <= W - R ? [false, true] : [true, false];       // false = right of the dot, true = left
    let best: { left: boolean; top: number } | null = null;
    for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, -4].map(k => k * LH)) {
      for (const left of sides) {
        const x0 = left ? g.x - GAP - w : g.x + GAP, top = Math.max(2, Math.min(H - B - h, mid + dy)), b = { x0, x1: x0 + w, y0: top, y1: top + h };
        if (x0 < 2 || b.x1 > W - 2) continue;
        if (!placed.some(p => hit(p, b)) && !dotBoxes.some(d => hit(d, b))) { best = { left, top }; break; }
      }
      if (best) break;
    }
    best ??= { left: sides[0], top: mid };
    const x0 = best.left ? g.x - GAP - w : g.x + GAP;
    placed.push({ x0, x1: x0 + w, y0: best.top, y1: best.top + h });
    return { g, left: best.left, top: best.top, moved: Math.abs(best.top - mid) > LH / 2 };
  });
  return <svg className="th-plot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cost against emissions of the recommended, cheapest, fastest and cleanest portfolios">
    {[0, 0.5, 1].map(f => { const v = y0 + f * (y1 - y0); return <g key={f}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="#e5e5e2" /><text x={L - 8} y={Y(v) + 4} textAnchor="end">${f0(v)}M</text></g>; })}
    {[0, 0.5, 1].map(f => { const v = x0 + f * (x1 - x0); return <text key={f} x={X(v)} y={H - 12} textAnchor="middle">{f0(v)} kg</text>; })}
    {labels.filter(l => l.moved).map(({ g, left, top }) => <line key={`l${g.x},${g.y}`} x1={g.x + (left ? -rad(g.me) : rad(g.me))} y1={g.y} x2={left ? g.x - GAP + 3 : g.x + GAP - 3} y2={top + (g.lines.length * LH) / 2} stroke="#b9b9b6" />)}
    {[...dots].sort((p, q) => Number(p.me) - Number(q.me)).map(d => <circle key={`${d.x},${d.y},${d.me}`} cx={d.x} cy={d.y} r={rad(d.me)} fill={d.me ? "#f26b1d" : "#111"} stroke="#fff" strokeWidth="1.5" />)}
    {labels.map(({ g, left, top }) => <text key={`${g.x},${g.y}`} x={left ? g.x - 11 : g.x + 11} y={top + LH - 3} textAnchor={left ? "end" : "start"}>
      {g.lines.map((l, i) => <tspan key={l.t} x={left ? g.x - 11 : g.x + 11} dy={i ? LH : 0} className={l.me ? "me" : ""}>{l.t}</tspan>)}</text>)}
  </svg>;
}

const SCEN_COLOR: Record<string, string> = { bear: "#2e9d5b", base: "#8a8a8a", bull: "#f26b1d" };
type Backup = { name: string; addedMw: number; totalM: number; note: string };
export function PriceSensitivity({ s, backup }: { s: Sensitivity; backup?: Backup[] }) {
  const y = s.yearly;
  const me = s.rows.find(r => r.role === "Recommended");
  const pool = (backup ?? []).filter(b => b.totalM > 0.05);
  const [on, setOn] = useState<string | null>(null);       // one at a time: the options are alternative ways to cover the same shortfall
  const pick = pool.find(b => b.name === on), add = pick?.totalM ?? 0;
  const per = y && y.years.length ? add / y.years.length : 0;
  const maxV = y ? Math.max(...(["bear", "base", "bull"] as const).flatMap(k => y.series[k].map(v => v + per))) * 1.15 : 1;
  return <div className="card th-sens"><Tags a={["financial"]} /><h3 className="chart-h">Price sensitivity <small>variable costs only · each scenario re-runs the dispatch</small></h3>
    <div className="th-scen">{s.scenarios.map(x => <div key={x.key}><i style={{ background: SCEN_COLOR[x.key] }} /><b>{x.label}</b><span>{x.text}</span></div>)}</div>
    <div className="th-backup"><span className="th-wi-label">Add reliability and backup generation to the price <small>pick one option to add its cost to every scenario; click it again to remove it</small></span>
      <div className="th-chips">{pool.length === 0 && <small className="hint">No backup is needed for this portfolio.</small>}{pool.map(b => { const sel = on === b.name; return <button key={b.name} type="button" className={`th-bk ${sel ? "on" : ""}`} aria-pressed={sel} title={b.note}
        onClick={() => setOn(sel ? null : b.name)}><u>{sel ? "✓" : ""}</u>{b.name}<em>+{usdM(b.totalM)}</em></button>; })}</div>
      {pick && <p className="th-bk-note">Included: <b>{pick.name}</b>, +{usdM(pick.totalM)} over the period, spread evenly as +${f0(per, 1)}M a year on top of each bar (hatched) and added to the totals in the table.</p>}</div>
    {y && <><div className="bars year-bars th-grouped"><div className="ylabels">{[1, 2 / 3, 1 / 3, 0].map(fr => <span key={fr}>{f0(maxV * fr)}</span>)}</div>
      {y.years.map((yr, i) => <div className="bar-col" key={yr}><div className="th-group">{(["bear", "base", "bull"] as const).map(k => <span key={k} className="th-gb" title={`${k}: $${f0(y.series[k][i] + per, 1)}M${per > 0 ? ` (incl. $${f0(per, 1)}M backup)` : ""}`}>
        <i style={{ height: `${y.series[k][i] / maxV * 100}%`, background: SCEN_COLOR[k] }} />{per > 0 && <i className="add" style={{ height: `${per / maxV * 100}%` }} />}</span>)}</div><small className="ytick">Y{yr}</small></div>)}</div>
      <p className="axis-label">Total cost per model year of the recommended portfolio, $M · bear / base / bull{per > 0 ? " · hatched = added backup" : ""}</p></>}
    <div className="table-scroll"><table className="year-table"><thead><tr><th>Portfolio</th><th>Full demand</th><th>Bear</th><th>Base</th><th>Bull</th></tr></thead>
      <tbody>{s.rows.map(r => <tr key={r.label} className={r.role === "Recommended" ? "total" : ""}><td>{r.role === "Recommended" ? "Pool: cheapest within your limits" : r.label}<small className="detail">{r.detail}</small></td><td>M{r.fullDemand}</td>
        {(["bear", "base", "bull"] as const).map(k => { const x = r.perScenario[k]?.totalM, plus = r.role === "Recommended" && add > 0 && x != null;
          return <td key={k}>{usdM(plus ? x + add : x)}{k !== "base" && <> <small className="detail">{k === "bull" ? "+" : ""}{f0(r.deltaPct[k], 1)}%</small></>}{plus && <small className="detail">incl. +{usdM(add)} backup</small>}</td>; })}</tr>)}</tbody></table></div>
    <p className="footnote">{me && `The recommended portfolio moves ${f0(me.deltaPct.bear, 1)}% in the bear case and +${f0(me.deltaPct.bull, 1)}% in the bull case. `}{s.note}{add > 0 ? ` Added backup: ${usdM(add)} over the years with demand, spread evenly (extension; diesel costs are team assumptions).` : ""}</p></div>;
}

// ------------------------------------------------------------------------------------------------ previous theses (Previous runs page)
export function ThesesList({ onOpen, current }: { onOpen: (id: string) => void; current: string | null }) {
  const [rows, setRows] = useState<ThesisRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { listTheses().then(setRows).catch(e => setErr(e.message)); }, []);
  return <section className="section th-prev">
    <h3 className="chart-h">Excel files <small>from the Faraday model · reference values are the current packet's (v6.0.1)</small></h3>
    <div className="mt-files th-files">{([["/methodology/developer_input_template.xlsx", "Developer input template", "Fill it from your own project plan: schedule, land, load tiers, remote site, nuclear offer, load ramp and grid steps."],
      ["/methodology/example_filled_template.xlsx", "Example filled template", "The template filled with an example project."],
      ["/methodology/Powerllel_Financial_Model.xlsx", "Financial model workbook", "The financial agent's method with live formulas: change a weight and Excel re-ranks 56,406 portfolios."]] as const).map(([u, t, d]) =>
      <a key={u} className="card mt-file" href={u} download><span className="tag">XLSX</span><b>{t}</b><p>{d}</p><span className="mt-dl">Download ↓</span></a>)}</div>
    <h3 className="chart-h th-mt2">Theses <small>every thesis you ran, newest first · click one to open its results</small></h3>
    {err && <p className="notice">{err}</p>}{!rows && !err && <p className="footnote">Loading…</p>}
    {rows && rows.length === 0 && <p className="gt-note">No thesis yet.</p>}
    {rows && rows.length > 0 && <div className="card table-card"><div className="table-scroll"><table className="year-table gt-runs"><thead><tr><th>Started</th><th className="l">Thesis</th><th className="l">Questions</th><th className="l">Agents</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id} className={`pick ${r.id === current ? "total" : ""}`} tabIndex={0} onClick={() => onOpen(r.id)} onKeyDown={e => { if (e.key === "Enter") onOpen(r.id); }}>
        <td>{new Date(r.createdAt * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td>{r.title}</td>
        <td className="note">{r.questions.map(q => QUESTION_NO[q]).join(", ")}</td>
        <td className="note">{AGENT_ORDER.map(k => `${k === "optimisation" ? "Optimisation" : k === "financial" ? "Financial" : k === "sourcing" ? "Site sourcing" : "Policy"} ${STATE_WORD[r.agents[k]]?.toLowerCase() ?? r.agents[k]}`).join(" · ")}</td></tr>)}</tbody></table></div></div>}
  </section>;
}

// ------------------------------------------------------------------------------------------------ Land: proposed sites (site sourcing agent, Atria API)
const LAND_GROUPS = ["Parcel", "Power and gas", "Fiber", "Water and environment", "Rules and hazards"];
const fact = (s: SiteRow, k: string) => s.land?.facts?.find(f => f.key === k);
function factText(f?: { value: unknown; unit: string }) {
  if (!f) return "–";
  const v = f.value;
  const scale = /^0[-–](\d+)$/.exec(f.unit);
  if (typeof v === "number" && scale) return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} of ${scale[1]}`;
  if (typeof v === "number" && f.unit === "share") return `${(v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  if (typeof v === "number") return `${f.unit === "$/acre" ? "$" : ""}${v.toLocaleString(undefined, { maximumFractionDigits: v < 1 ? 3 : v < 10 ? 2 : 1 })}${f.unit && f.unit !== "$/acre" ? ` ${f.unit === "share" ? "" : f.unit}` : f.unit === "$/acre" ? " per acre" : ""}`;
  return String(v);
}

export const SubHead = ({ n, title }: { n: string; title: string }) => (n.startsWith(".") ? null : <h3 className="sub-head"><em>{n}</em>{title}</h3>);
/** The site parts without numbered sub-headings (the thesis page). */
function ProposedSites(p: { sites: SiteRow[]; need: number; limit?: number; onPrefill?: (p: Partial<ThesisInput> & { gridDelay?: number; landAcres?: number }) => void }) { return <SiteSections {...p} no="" />; }

/** Land used against the land available, and the onsite equipment that takes it. */
export function LandRequirement({ used, limit, rows }: { used?: number | null; limit?: number | null; rows: { label: string; mw: number; acresPerMw: number }[] }) {
  return <div className="card table-card"><Tags a={["optimisation"]} /><h3 className="chart-h">Land used and available <small>acres for onsite equipment (gas units and batteries)</small></h3>
    <LandBar used={used} limit={limit} />
    {rows.length > 0 && <div className="table-scroll"><table className="year-table"><thead><tr><th>Onsite equipment</th><th>MW</th><th>Acres per MW</th><th>Acres</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.label}><td>{r.label}</td><td>{f0(r.mw)}</td><td>{f0(r.acresPerMw, 2)}</td><td>{f0(r.mw * r.acresPerMw, 1)}</td></tr>)}</tbody></table></div>}</div>;
}

/** The four site parts (map, shortlist, comparison, individual facts) as sub-sections sharing the selected site. */
export function SiteSections({ sites, need, limit, onPrefill, no = "06", first = 2 }: { sites: SiteRow[]; need: number; limit?: number; onPrefill?: (p: Partial<ThesisInput> & { gridDelay?: number; landAcres?: number }) => void; no?: string; first?: number }) {
  const withFacts = sites.filter(s => s.land?.facts?.length);
  const [pick, setPick] = useState(() => (withFacts.find(s => (s.acres ?? 0) > 0) ?? withFacts[0] ?? sites[0]).id);
  const s = sites.find(x => x.id === pick) ?? sites[0];
  const fit = (x: SiteRow) => x.acres == null ? ["", "size not known"] : need > 0 && x.acres < need ? ["bad", "too small for the onsite equipment"] : ["ok", `${f0(x.acres)} ${x.acresBasis === "parcel" ? "parcel" : "usable"} acres`];
  const ranked = [...sites].sort((a, b) => b.score - a.score);
  return <>
    <SubHead n={`${no}.${first}`} title="Site map" />
    <div className="card th-land"><span className="ag-row"><AgentTag a="sourcing" /><span className="tag">PROPOSED SITES</span></span><div className="th-land-head"><div><h3 className="chart-h th-mt">Proposed sites <small>county, parcel and site facts from the Atria API</small></h3></div>
      <label className="th-pick">Site<select value={pick} onChange={e => setPick(e.target.value)}>{sites.map(x => <option key={x.id} value={x.id}>{x.county} County, {x.state} · {x.label.split(",").slice(1).join(",").trim() || x.label}</option>)}</select></label></div>
      <SiteMap sites={sites} selected={pick} onSelect={setPick} />
      <p className="footnote">Click a pin to select a site; its facts are under “Individual site facts” below.</p></div>
    <SubHead n={`${no}.${first + 1}`} title="Site shortlist" />
    <div className="card table-card"><Tags a={["sourcing"]} /><h3 className="chart-h">Sites ranked by score <small>best first · click a row to select the site</small></h3>
      <div className="table-scroll"><table className="year-table"><thead><tr><th>Rank</th><th className="l">Site</th><th>Score</th><th className="l">Verdict</th><th className="l">Size fit</th></tr></thead>
        <tbody>{ranked.map((x, i) => { const [c, t] = fit(x); return <tr key={x.id} className={`pick ${x.id === pick ? "total" : ""}`} onClick={() => setPick(x.id)}><td>{i + 1}</td><td className="l">{x.county} County, {x.state}<small className="detail">{x.label}</small></td><td>{f0(x.score)}</td>
          <td className="l note">{x.verdict}{x.thesisFails.length > 0 && <small className="detail">{x.thesisFails.join(" · ")}</small>}</td><td className="l"><span className={`gt-run-state ${c}`}>{t}</span></td></tr>; })}</tbody></table></div></div>
    <SubHead n={`${no}.${first + 2}`} title="Site comparison" />
    <div className="card table-card"><Tags a={["sourcing"]} /><h3 className="chart-h">Proposed sites compared <small>size check against the {need > 0 ? `${f0(need, 1)} acres` : "onsite land"} the largest optimiser portfolio needs for equipment (the data-center buildings need more)</small></h3>
      <div className="table-scroll"><table className="year-table"><thead><tr><th>Site</th><th className="l">Grid</th><th className="l">Size check</th><th>345 kV substation</th><th>Gas pipeline</th><th>Internet exchange</th><th className="l">Flood zone</th><th>Water stress</th><th>Grid estimate</th></tr></thead>
        <tbody>{sites.map(x => { const [c, t] = fit(x); return <tr key={x.id} className={`pick ${x.id === pick ? "total" : ""}`} onClick={() => setPick(x.id)}><td>{x.county} County, {x.state}<small className="detail">{x.label}</small></td><td className="l">{x.iso ?? "–"}</td>
          <td className="l"><span className={`gt-run-state ${c}`}>{t}</span></td><td>{factText(fact(x, "dist_345kv_mi"))}</td><td>{factText(fact(x, "gas_dist_mi"))}</td><td>{factText(fact(x, "fiber_ix_dist_mi"))}</td>
          <td className="note">{factText(fact(x, "flood_zone"))}</td><td>{factText(fact(x, "water_stress_0_5"))}</td><td>{x.gridP50 != null ? `month ${f0(x.gridP50)}` : "–"}</td></tr>; })}</tbody></table></div>
      <p className="footnote">Grid estimate: the Atria model's median months to a grid connection.</p></div>
    <SubHead n={`${no}.${first + 3}`} title="Individual site facts" />
    <div className="card th-land"><Tags a={["sourcing"]} /><div className="th-land-head"><div><h3 className="chart-h th-mt">{s.county} County, {s.state} <small>{s.label}</small></h3></div>
      <label className="th-pick">Site<select value={pick} onChange={e => setPick(e.target.value)}>{sites.map(x => <option key={x.id} value={x.id}>{x.county} County, {x.state} · {x.label.split(",").slice(1).join(",").trim() || x.label}</option>)}</select></label></div>
      <div className="th-land-sum"><div><b>{s.county} County, {s.state}</b><span>{s.label}</span></div><div><b>{s.iso ?? "–"}</b><span>grid</span></div>
        <div><b>{s.acres != null ? f0(s.acres) : "–"}</b><span>{s.acresBasis === "parcel" ? "parcel acres" : "usable acres"}</span></div><div><b>{factText(fact(s, "dist_345kv_mi"))}</b><span>to a 345 kV substation</span></div>
        <div><b>{factText(fact(s, "gas_dist_mi"))}</b><span>to a gas pipeline</span></div><div><b>{factText(fact(s, "fiber_ix_dist_mi"))}</b><span>to an internet exchange</span></div></div>
      {s.land?.error ? <p className="gt-note">The Atria model did not return this site's facts ({s.land.error}).</p>
        : !s.land?.facts?.length ? <p className="gt-note">No land facts for this site yet. Run the thesis again to read them.</p>
        : <div className="th-facts">{LAND_GROUPS.map(g => { const fs = s.land!.facts.filter(f => f.group === g); return fs.length ? <div key={g} className="th-fact-group"><h4>{g}</h4>
          <dl>{fs.map(f => <div key={f.key}><dt>{f.label}</dt><dd>{factText(f)}{f.placeholder && <em> placeholder</em>}<small>{f.source}</small></dd></div>)}</dl></div> : null; })}</div>}
      {onPrefill && s.gridP50 != null && <div className="th-wi-run"><p>{s.gridP50 > 30 ? `This site's grid estimate is month ${f0(s.gridP50)}, ${f0(Math.min(36, s.gridP50 - 30))} months after the packet's full grid connection (month 30). The optimiser has not priced that.` : `This site's grid estimate (month ${f0(s.gridP50)}) is no later than the packet's full grid connection (month 30).`}</p>
        {s.gridP50 > 30 && <button className="primary small" onClick={() => onPrefill({ gridDelay: Math.min(36, Math.round(s.gridP50! - 30)), title: `${s.county} County grid date` })}>Price it in the optimiser <ArrowIcon /></button>}</div>}
      {onPrefill && s.acres != null && s.acres > 0 && <div className="th-wi-run"><p>{`The optimiser assumed ${limit != null ? f0(limit, 1) : "8"} acres of onsite land for gas units and batteries (packet: 8 acres × peak / 75). This site has ${f0(s.acres)} ${s.acresBasis === "parcel" ? "parcel" : "usable"} acres${need > 0 ? `; this portfolio uses ${f0(need, 1)}` : ""}. The optimiser has not priced this site's land: run it with the site's acres as the land limit (reduce it on the review step for the space the data-center buildings need).`}</p>
        <button className="primary small" onClick={() => onPrefill({ landAcres: Math.round(s.acres!), title: `${s.county} County land` })}>Price it in the optimiser <ArrowIcon /></button></div>}
      <p className="footnote">Proposed sites, parcels and site facts: Atria API.</p></div>
  </>;
}

// ------------------------------------------------------------------------------------------------ Texas: the state picture for moratoriums (as of 5 Nov 2026)
const TX_NEWS: [string, string][] = [
  ["Election, 3 Nov 2026", "Democrat Gina Hinojosa won the governor's race, the first Democratic win for Texas governor in more than three decades. She campaigned on an immediate moratorium on data-center development, halting approvals until a legislative session that \"puts Texans first\"."],
  ["Capacity exposed", "GLJ Research estimates about 13 GW of Texas data-center capacity is immediately exposed, roughly enough to power 10 million homes. SemiAnalysis puts Texas at nearly 30% of US data-center capacity due online in 2028, the largest share of any state."],
  ["Who is affected", "Projects with power, permits and steel are expected to continue. Projects with power but no state environmental permit face delays of 12 to 18 months; projects with neither may move to Louisiana, Oklahoma or elsewhere (GLJ Research)."],
  ["What comes next", "Jefferies moves Texas from Tier 3 to Tier 4 on its 1 (welcoming) to 5 (least welcoming) scale. The 2027 legislative session could tighten rules on grid costs, water use and tax incentives, which Jefferies sees as more likely to raise costs than to stop the Texas pipeline."],
];
/** The notice at the top of the results: does any state or local rule stop this development right now, or only add risk?
 *  Read from the policy agent's rules at each proposed site; "block" when no proposed site can go ahead today. */
type Notice = { level: "block" | "caution"; title: string; items: { h: string; x: string }[]; asOf: string | null };
const IN_FORCE = /enact|adopt|in effect|effective|active|approved|passed/i;
export function policyNotice(sites: SiteRow[], needsAirPermit: boolean, needsGrid: boolean): Notice | null {
  if (!sites.length) return null;
  const blockedAt = (s: SiteRow) => {
    const rules = String(s.policy?.state_rules?.value ?? ""), stage = String(s.policy?.moratorium_stage?.value ?? "none");
    const why: string[] = [];
    if (/halt all permits sought by data centers/i.test(rules)) why.push("permits");
    if (needsGrid && /pauses Batch Zero/i.test(rules)) why.push("grid");
    if (stage !== "none" && stage !== "" && IN_FORCE.test(stage)) why.push("local");
    return why;
  };
  const per = sites.map(s => ({ s, why: blockedAt(s) })), blocked = per.filter(p => p.why.length), all = blocked.length === sites.length;
  const has = (k: string) => blocked.some(p => p.why.includes(k));
  const states = [...new Set(blocked.map(p => (p.s.state === "TX" ? "Texas" : p.s.state)))].join(", ");
  const items: Notice["items"] = [];
  if (has("permits")) items.push({ h: "State permits halted", x: `On 21 Sep 2026 the Governor directed TCEQ to "halt all permits sought by data centers until ERCOT completes its audit". No end date is set.${needsAirPermit ? " This portfolio's onsite gas needs a TCEQ air permit before it can run, so it cannot be built today." : " Every TCEQ permit a data center needs (air, water, stormwater) is on hold."}` });
  if (has("grid")) items.push({ h: "Large-load grid connections paused", x: "ERCOT paused Batch Zero, the study batch for new large loads, during the audit (3 Aug 2026). The grid steps this run assumes cannot be studied or granted until it resumes." });
  if (has("local")) items.push({ h: "Local moratorium in force", x: `A county data-center moratorium is in force at ${blocked.filter(p => p.why.includes("local")).map(p => `${p.s.county} County`).join(", ")}.` });
  const caution: Notice["items"] = [];
  if (sites.some(s => s.state === "TX")) caution.push({ h: "After the 3 Nov 2026 election", x: "The governor-elect campaigned on an immediate moratorium on data-center development until the 2027 legislative session, and plans to end data-center tax incentives. Projects with power but no state permit face 12–18 month delays (GLJ Research)." });
  const over = sites.filter(s => s.stall != null && s.stallMax != null && s.stall > s.stallMax);
  if (over.length) caution.push({ h: "Stall risk above your limit", x: `${over.length} of ${sites.length} proposed sites have a stall chance above your risk appetite.` });
  const asOf = sites.map(s => s.policy?.state_rules?.date).filter(Boolean).sort().pop() ?? null;
  if (blocked.length) return { level: all ? "block" : "caution", asOf, items: [...items, ...caution],
    title: all ? `Data-center development is not possible right now${states ? ` in ${states}` : ""}` : `Development is not possible right now at ${blocked.length} of ${sites.length} proposed sites` };
  return caution.length ? { level: "caution", asOf, items: caution, title: "Policy risks to this development" } : null;
}
export function PolicyNotice({ n, id }: { n: Notice | null; id?: string }) {
  if (!n) return null;
  return <div className={`th-notice ${n.level}`} id={id} role={n.level === "block" ? "alert" : "note"}>
    <div className="th-notice-head"><span className="th-notice-ic" aria-hidden="true">{n.level === "block" ? "!" : "i"}</span><div><span className="th-notice-k">{n.level === "block" ? "Disclaimer · regulatory block" : "Disclaimer · policy risk"}</span><b>{n.title}</b></div></div>
    <ul>{n.items.map(i => <li key={i.h}><b>{i.h}.</b> {i.x}</li>)}</ul>
    <p className="th-notice-foot">{n.level === "block" ? "The results below are what the model finds if the permits and grid connection are granted on its schedule. Read every date as the earliest after the block is lifted, not as a plan that can start today. " : ""}From the policy agent{n.asOf ? `, rules as of ${new Date(n.asOf + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : ""}; see Policy &amp; permitting. Not legal advice.</p></div>;
}

export function TexasPanel({ sites }: { sites: SiteRow[] }) {
  const tx = sites.find(s => s.state === "TX" && s.policy?.state_rules);
  const rules = String(tx?.policy?.state_rules?.value ?? "").split(" · ").filter(Boolean).map(x => { const m = /^(\d{4}-\d{2}-\d{2}):\s*(.*)$/.exec(x); return m ? [new Date(m[1] + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }), m[2]] : ["", x]; });
  const inc = tx?.policy?.dc_incentive;
  const state = sites.find(s => s.state === "TX")?.stallLayers?.state;
  return <div className="card th-tx"><span className="ag-row"><AgentTag a="moratorium" /><span className="tag orange">TEXAS · STATE PICTURE</span></span><h3 className="chart-h th-mt">Moratoriums in Texas <small>state actions, the 2026 election and what they mean for a campus with onsite gas</small></h3>
    <div className="th-two">
      <div><h4 className="th-h4">State actions so far</h4>
        <ol className="th-timeline">{rules.map(([d, x], i) => <li key={i}><b>{d}</b><span>{x}</span></li>)}</ol>
        {inc && <p className="th-tx-note"><b>Incentive at stake:</b> {String(inc.value)}. The incoming governor's plan would end data-center tax incentives.</p>}
        <p className="footnote">Sources: Office of the Texas Governor, <a href="https://gov.texas.gov/news/post/governor-abbott-directs-tceq-to-halt-data-center-permits" target="_blank" rel="noreferrer">“Governor Abbott Directs TCEQ To Halt Data Center Permits”</a>; PUCT and ERCOT notices on the data-center audit and Batch Zero; Texas Comptroller, <a href="https://comptroller.texas.gov/taxes/data-centers/" target="_blank" rel="noreferrer">data center sales tax exemption</a> (Tax Code §151.359).</p></div>
      <div><h4 className="th-h4">After the election</h4>
        <dl className="th-news">{TX_NEWS.map(([k, x]) => <div key={k}><dt>{k}</dt><dd>{x}</dd></div>)}</dl>
        <p className="footnote">Sources: Bloomberg, <a href="https://www.insurancejournal.com/news/southcentral/2026/11/05/891726.htm" target="_blank" rel="noreferrer">“AI Data Center Boom Is Set for Upheaval After US Election Rout”</a>, 4 Nov 2026 (republished by Insurance Journal, 5 Nov 2026), citing GLJ Research, SemiAnalysis and Jefferies; see also <a href="https://www.technologyreview.com/2026/11/04/1148043/texas-was-the-new-epicenter-of-the-ai-data-center-buildout-that-might-be-kaput/" target="_blank" rel="noreferrer">MIT Technology Review</a> and <a href="https://www.cnn.com/2026/11/05/economy/data-center-texas-election" target="_blank" rel="noreferrer">CNN</a>, 4–5 Nov 2026.</p></div>
    </div>
  </div>;
}

// ------------------------------------------------------------------------------------------------ local risk: what the % means
const APPETITE_MAX: Record<string, string> = { Low: "10%", Medium: "20%", High: "35%" };
export function LocalRisk({ sites, appetite }: { sites: SiteRow[]; appetite: string }) {
  const pc = (x: number | null | undefined, d = 0) => (x == null ? "–" : `${f0(x * 100, d)}%`);
  return <div className="card table-card"><Tags a={["moratorium"]} /><h3 className="chart-h">Local risks <small>the chance each proposed site stalls · your appetite: {appetite}{APPETITE_MAX[appetite] ? ` (limit ${sites[0]?.stallMax != null ? pc(sites[0].stallMax) : APPETITE_MAX[appetite]})` : ""}</small></h3>
    <div className="table-scroll"><table className="year-table"><thead><tr><th>Site</th><th>Local</th><th>State</th><th>Commercial</th><th>Stall chance</th><th className="l">Local opposition</th><th className="l">Nearest home noise</th></tr></thead>
      <tbody>{sites.map(s => { const L_ = s.stallLayers ?? { local: null, state: null, commercial: null }; const p = s.policy ?? {}; const over = s.stall != null && s.stallMax != null && s.stall > s.stallMax;
        return <tr key={s.id}><td>{s.county} County, {s.state}<small className="detail">{s.label}</small></td><td>{pc(L_.local, 1)}</td><td>{pc(L_.state)}</td><td>{pc(L_.commercial)}</td>
          <td><span className={`gt-run-state ${over ? "bad" : "ok"}`}>{pc(s.stall, 1)}</span><small className="detail">{over ? "above your limit" : "within your limit"}</small></td>
          <td className="note">{p.share_oppose ? `${f0(Number(p.share_oppose.value) * 100)}% of statements opposed` : "–"}<small className="detail">{p.share_oppose?.note || s.local.headline || ""}</small></td>
          <td className="note">{p.noise_dba_home ? `${p.noise_dba_home.value} dBA` : "–"}<small className="detail">{p.noise_dba_home ? String(p.noise_dba_home.note).split(".")[0] : ""}</small></td></tr>; })}</tbody></table></div>
    <details className="fold th-assume"><summary><b>Assumptions</b><span>what the stall % means, the three layers and your limit</span></summary>
      <div className="th-risk-explain">
      <p><b>What the % means.</b> The chance the project stalls outright, from three independent layers. The project goes ahead only if none of them stops it:</p>
      <div className="mt-formula"><code>stall chance = 1 − (1 − local) × (1 − state) × (1 − commercial)</code>
        <p>Example: local 7%, state 20%, commercial 3% → 1 − 0.93 × 0.80 × 0.97 = 27.8%.</p></div>
      <ul><li><b>Local:</b> starts from a base chance and moves with how much local news and council coverage opposes data centers, and with any moratorium stage in the county.</li>
        <li><b>State:</b> the chance a statewide pause or rule stops the project (an assumption; in Texas it reflects the current permit halt and audit).</li>
        <li><b>Commercial:</b> the chance the tenant or financing falls through (a fixed base).</li></ul>
      <p>A site whose stall chance is above your limit is flagged. Your limit comes from your risk appetite in the thesis (Additional information).</p></div>
      <p className="footnote">Sources: local opposition and moratorium stage from local news and council coverage ({[...new Set(sites.map(s => String(s.policy?.share_oppose?.source ?? "").replace(/^Local news and council coverage, read by AI:\s*/, "")).filter(Boolean))].join("; ") || "local outlets"}), statements read and classified by AI; nearest home and noise from FEMA USA Structures (simplified sound spreading, screening only). State and commercial layers are assumptions.</p></details></div>;
}

// ------------------------------------------------------------------------------------------------ policy: what it means, what if, permits
export function ThesisImpact({ sites, t }: { sites: SiteRow[]; t: ThesisView["thesis"] }) {
  const state = sites.find(s => s.state === "TX")?.stallLayers?.state;
  const open = (num(t.fullTarget) ?? 24) - 10;
  return <div className="th-impact"><span className="ag-row"><AgentTag a="moratorium" /><span className="tag orange">WHAT IT MEANS FOR THIS THESIS</span></span>
    <h3 className="display">Texas rules decide when this campus can open.</h3>
    <div className="th-impact-grid">
      <div><b>1 · Onsite gas needs a state air permit</b><p>Every portfolio here opens on onsite gas before the grid arrives (opening month {open}). On 21 Sep the Governor told TCEQ to halt data-center permits until the ERCOT audit ends, and the governor-elect plans to keep approvals halted. If the permit slips, the opening slips with it.</p></div>
      <div><b>2 · The grid connection waits on the ERCOT audit</b><p>Batch Zero has been paused since 3 Aug. The packet's grid steps (25 MW at month 18, 50 at 24, 75 at 30) assume no delay. Use the connection-uncertainty question to price a slip.</p></div>
      <div><b>3 · A {state != null ? f0(state * 100) : "20"}% chance the state stops it outright</b><p>That is the state layer in every Texas site's stall chance below, the main reason all proposed sites sit above a Medium risk limit. Scenario analysis below shows how it moves.</p></div>
    </div></div>;
}

type Path = "today" | "lifted" | "moratorium";
const PATHS: [Path, string, string, number, number, string][] = [   // key, label, detail, permit delay (months), state layer, basis
  ["today", "Today: halt in place", "The 21 Sep directive stands, but TCEQ has kept processing permits (Public Citizen). Minor permits take 2-7 days to review.", 0, -1, "State layer 20%: assumption for the current Texas permit halt and ERCOT audit. Delay: none assumed, since TCEQ kept processing permits (Public Citizen)."],
  ["lifted", "Halt lifted after the ERCOT audit", "The audit ends and TCEQ resumes normal processing.", 0, 0.10, "State layer 10%: assumption (half of today's)."],
  ["moratorium", "Statewide moratorium enacted", "The governor-elect halts approvals until the 2027 legislative session acts.", 15, 0.35, "Delay 15 months: midpoint of the 12-18 months GLJ Research expects for projects without a state environmental permit. State layer 35%: assumption."],
];
const BAAJA_SAVED: [string, number, number][] = [["Transmission", 2.5, 96], ["Solar", 5.5, 35], ["Gas pipeline", 4, 21], ["Onshore wind", 4.5, 20]];   // months saved: deadlines met, delays and challenges (CGEP)

export function WhatIf({ sites, t, onEditWith }: { sites: SiteRow[]; t: ThesisView["thesis"]; onEditWith: (p: Partial<ThesisInput>) => void }) {
  const [path, setPath] = useState<Path>("today");
  const [baaja, setBaaja] = useState(false);
  const [rules2027, setRules2027] = useState(false);
  const [capexUp, setCapexUp] = useState("6.25");      // Texas state sales tax rate: the exemption at stake applies to state tax only
  const [gridUp, setGridUp] = useState("5");
  const p = PATHS.find(x => x[0] === path)!;
  const today = sites.find(s => s.state === "TX")?.stallLayers?.state ?? 0.2;
  const stateL = p[4] < 0 ? today : p[4];
  const delay = p[3];
  const open0 = (num(t.fullTarget) ?? 24) - 10;
  const permit0 = 2, permit1 = permit0 + delay;                       // months from project start to an air permit in hand (2 = application + review, assumption)
  const gas0 = Math.max(14, permit0), gas1 = Math.max(14, permit1);   // earliest onsite gas: packet availability (fuel cell, month 14) or the permit
  const open1 = Math.min(Math.max(open0, gas1), 30);                  // the grid alone reaches 75 MW at month 30
  const stall = (s: SiteRow, st: number) => { const L_ = s.stallLayers; return L_?.local == null ? null : 1 - (1 - L_.local) * (1 - st) * (1 - (L_.commercial ?? 0.03)); };
  const tx = sites.filter(s => s.state === "TX");
  const range = (st: number) => { const xs = tx.map(s => stall(s, st)).filter((x): x is number => x != null); return xs.length ? `${f0(Math.min(...xs) * 100, 1)}–${f0(Math.max(...xs) * 100, 1)}%` : "–"; };
  const rows: [string, [number, number][], [number, number][], string][] = [
    ["State air permit (onsite gas)", [[0, permit0]], [[0, permit1]], delay ? `+${delay} mo` : ""],
    ["Onsite gas available", [[gas0, 40]], [[gas1, 40]], gas1 > gas0 ? `+${gas1 - gas0} mo` : ""],
    ["Grid connection (packet steps)", [[18, 24], [24, 30], [30, 40]], [[18, 24], [24, 30], [30, 40]], ""],
    ["Opening → full demand", [[open0, open0 + 10]], [[open1, open1 + 10]], open1 > open0 ? `+${open1 - open0} mo` : ""],
  ];
  const X = (m: number) => `${(m / 40) * 100}%`;
  return <div className="card th-whatif"><span className="ag-row"><AgentTag a="moratorium" /><span className="tag">SCENARIO ANALYSIS</span></span>
    <h3 className="chart-h th-mt">Scenario analysis <small>what if the rules change? Pick what happens next; the timeline, stall chances and costs update</small></h3>
    <div className="th-wi-controls">
      <div><span className="th-wi-label">Texas permits</span><div className="segment gt-seg">{PATHS.map(([k, l]) => <button key={k} className={path === k ? "on" : ""} onClick={() => setPath(k)}>{l}</button>)}</div><small>{p[2]}</small></div>
      <div className="th-wi-checks">
        <label><input type="checkbox" checked={baaja} onChange={e => setBaaja(e.target.checked)} /> <span><b>BAAJA passes</b> (federal permitting reform, introduced 30 Sep 2026)</span></label>
        <label><input type="checkbox" checked={rules2027} onChange={e => setRules2027(e.target.checked)} /> <span><b>2027 session tightens rules</b> on grid costs, water use and tax incentives</span></label></div>
    </div>
    <div className="th-wi-kpis">
      <div><b>{open1 === open0 ? `month ${open0}` : `month ${open0} → ${open1}`}</b><span>opening</span></div>
      <div><b>{open1 === open0 ? `month ${open0 + 10}` : `month ${open0 + 10} → ${open1 + 10}`}</b><span>full demand</span></div>
      <div><b>{f0(today * 100)}% → {f0(stateL * 100)}%</b><span>state layer</span></div>
      <div><b>{range(stateL)}</b><span>stall chance, Texas sites (today {range(today)})</span></div>
    </div>
    <div className="th-gantt"><div className="th-g-axis">{[0, 6, 12, 18, 24, 30, 36].map(m => <span key={m} style={{ left: X(m) }}>{m}</span>)}</div>
      {rows.map(([lab, cur, nw, d]) => <div key={lab} className="th-g-row"><div className="th-g-lab">{lab}{d && <em>{d}</em>}</div>
        <div className="th-g-track">{cur.map(([a, b], i) => <i key={`c${i}`} className="cur" style={{ left: X(a), width: X(b - a) }} />)}
          {nw.map(([a, b], i) => <i key={`n${i}`} className={`new ${path}`} style={{ left: X(a), width: X(b - a) }} />)}
          {lab.startsWith("Opening") && <><u style={{ left: X(open0) }} title={`today: month ${open0}`} />{open1 !== open0 && <u className="new" style={{ left: X(open1) }} title={`scenario: month ${open1}`} />}</>}</div></div>)}
      <div className="th-g-legend"><span><i className="cur" /> Today</span><span><i className={`new ${path}`} /> {p[1]}</span><span>Months from project start (model month 0)</span></div></div>
    {open1 !== open0 && <div className="th-wi-run"><p>The optimiser has not priced an opening at month {open1}. Run the thesis with full demand by month {open1 + 10} to see the portfolio and cost.</p>
      <button className="primary small" onClick={() => onEditWith({ fullTarget: open1 + 10, fullCompare: Math.max(open1 + 16, (num(t.fullCompare) ?? 30)), title: `${t.title} · ${p[1].toLowerCase()}` })}>Price it in the optimiser <ArrowIcon /></button></div>}
    {baaja && <div className="th-wi-note"><b>BAAJA (federal):</b> it speeds up federal reviews only. Months saved, per <a href="https://www.energypolicy.columbia.edu/how-the-senate-permitting-reform-bill-could-impact-energy-project-timelines/" target="_blank" rel="noreferrer">Columbia CGEP's timeline tool</a> (if agencies meet deadlines / with delays and challenges): {BAAJA_SAVED.map(([k, a, b]) => `${k} ${a} / ${b}`).join(" · ")}.
      For this campus: the state air permit and county approvals do not change; ERCOT transmission is mostly state-regulated, so the grid steps rarely have a federal permit to speed up. It helps the wind and solar projects behind the contracts and any interstate gas pipeline.</div>}
    {rules2027 && <div className="th-wi-note"><b>2027 legislative session:</b> Jefferies expects tighter rules on grid costs, water use and tax incentives to raise development costs more than stop projects. Price the two that reach the portfolio:
      <div className="th-wi-adders">
        <label>Onsite equipment cost<span className="gt-input"><input value={capexUp} inputMode="decimal" onChange={e => setCapexUp(e.target.value)} /><em>% more CAPEX</em></span><small>losing the state sales-tax exemption on gas units and batteries (Texas state sales tax 6.25%)</small></label>
        <label>Grid electricity<span className="gt-input"><input value={gridUp} inputMode="decimal" onChange={e => setGridUp(e.target.value)} /><em>$/MWh more</em></span><small>new large-load grid charges (assumption; replace when the bill sets it)</small></label>
        <button className="primary small" onClick={() => onEditWith({ capexUpliftPct: Number(capexUp) || 0, gridAdderExtra: Number(gridUp) || 0, title: `${t.title} · 2027 rules` })}>Price it in the optimiser <ArrowIcon /></button></div>
      <small>Water-use rules are not priced: the packet campus has no water cost. The financial agent's pools keep packet costs; the optimiser includes the adders.</small></div>}
    <p className="footnote">{p[5]} Permit in hand by month 2 (application plus review) and onsite gas from month 14 (packet fuel-cell date) are assumptions; the opening can never be later than month 30, when the grid alone reaches 75 MW.</p></div>;
}

export function PermitsCard({ sites }: { sites: SiteRow[] }) {
  const paths = sites.map(s => [s, s.land?.facts?.find(f => f.key === "air_path")?.value, s.land?.facts?.find(f => f.key === "attainment")?.value] as const);
  return <div className="card table-card th-permits"><Tags a={["moratorium"]} /><h3 className="chart-h">Permits, emissions and reporting <small>what the onsite gas needs, and what changed in 2026</small></h3>
    <div className="th-two">
      <dl className="th-news">
        <div><dt>State air permit: 30 TAC Ch. 116, Subchapter B (New Source Review)</dt><dd>Onsite gas needs a TCEQ construction permit: minor NSR, or the lighter Standard Permit for natural gas generating units (Subchapter F) or a permit by rule (Ch. 106) for small units and diesel backup, with 2-7 days of review and no public notice. Above major-source thresholds it becomes PSD or nonattainment NSR, with public notice, a comment period and possible contested hearings. Permits can cap emissions and hours of operation. The Environment section works out the pathway for each portfolio.</dd></div>
        <div><dt>Federal turbine standard (EPA, 15 Jan 2026)</dt><dd>Combustion controls for NOx; selective catalytic reduction for large, high-use turbines. Low-use turbines are exempt from Title V permitting, and temporary turbines (under 24 months) have their own category.</dd></div>
        <div><dt>Permits granted during the halt</dt><dd>TCEQ kept advancing data-center permits after 21 Sep: notices for three major-source permits on 22 Sep, and construction stormwater permits issued the day they were filed. In Milam County it issued a stormwater permit for Stargate Milam (2 Oct) and an industrial wastewater permit for Sandow Lakes Ranch near Rockdale (1 Oct).</dd></div>
      </dl>
      <div className="table-scroll"><table className="year-table"><thead><tr><th>Site</th><th className="l">Air permit path for onsite gas</th><th className="l">Air quality area</th></tr></thead>
        <tbody>{paths.map(([s, a, q]) => <tr key={s.id}><td>{s.county} County<small className="detail">{s.label}</small></td><td className="l">{a ? String(a) : "–"}</td><td className="note">{q ? String(q) : "–"}</td></tr>)}</tbody></table></div>
    </div>
    <p className="footnote">Sources: <a href="https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-116-910" target="_blank" rel="noreferrer">30 TAC §116.910</a> (Texas Administrative Code, via Cornell LII); <a href="https://www.tceq.texas.gov/permitting/air/guidance/newsourcereview/turbines/nsrgenguid_turb.html" target="_blank" rel="noreferrer">TCEQ guidance for turbines</a>; EPA, 91 Fed. Reg. 1910 (15 Jan 2026), summarised by <a href="https://clarkhill.com/news-events/news/epa-turbine-rules-air-permitting-data-centers/" target="_blank" rel="noreferrer">Clark Hill</a>; Public Citizen, <a href="https://www.citizen.org/wp-content/uploads/Summary_-Data-Center-Permits-Issued-by-TCEQ-After-9_21_2026.pdf" target="_blank" rel="noreferrer">“Data Center Permits Issued by TCEQ After 9/21/2026”</a>. Air permit path per site: Clean Air Act major-source thresholds and nonattainment areas from the <a href="https://www.epa.gov/green-book" target="_blank" rel="noreferrer">EPA Green Book</a>.</p></div>;
}

// ------------------------------------------------------------------------------------------------ New thesis: three templates that fill the Optimizer
export interface Template { key: "speed" | "cost" | "environment"; title: string; blurb: string; weights: Weights; detail: string; form: { start: string; co2: string; rel: "R0"; staged: boolean } }
export const TEMPLATES: Template[] = [
  { key: "speed", title: "Speed to power", blurb: "Earliest possible service", weights: { speed: 70, cost: 20, environment: 10 }, detail: "Opens in month 14, full demand by month 24: the earliest the packet allows.", form: { start: "14", co2: "", rel: "R0", staged: false } },
  { key: "cost", title: "Cost", blurb: "Lowest 10-year cost", weights: { speed: 10, cost: 80, environment: 10 }, detail: "Opens in month 26, full demand by month 36: waiting for the grid is cheapest.", form: { start: "26", co2: "", rel: "R0", staged: false } },
  { key: "environment", title: "Environmental", blurb: "Lowest operational carbon", weights: { speed: 10, cost: 20, environment: 70 }, detail: "Average emissions at most 100 kg CO₂/MWh, opening in month 14 (the earliest date that meets it).", form: { start: "14", co2: "100", rel: "R0", staged: false } },
];
export function TemplateStart({ onPick }: { onPick: (t: Template) => void }) {
  return <div className="model-page th-page">
    <section className="section model-hero gt-hero">
      <span className="tag orange">NEW THESIS</span>
      <h1 className="display">CHOOSE A <em>TEMPLATE.</em></h1>
      <p className="lede dark">Pick the goal that matters most. The template fills in the Optimizer for you; check or change any number, switch resources on or off, then run. The four agents start with the run.</p>
    </section>
    <section className="section th-start"><div className="preset-grid th-presets th-templates">{TEMPLATES.map((t, i) => <button key={t.key} className="preset" onClick={() => onPick(t)}>
      <span>Template {i + 1}</span><b>{t.title}</b><small>{t.blurb} · speed {t.weights.speed} / cost {t.weights.cost} / carbon {t.weights.environment}</small><p>{t.detail}</p><em className="th-tpl-go">Fill in the Optimizer <ArrowIcon /></em></button>)}</div></section>
  </div>;
}

// ------------------------------------------------------------------------------------------------ the four agents around one optimiser run (results page)
export function RunAgentsHead({ v }: { v: ThesisView | null }) {
  if (!v) return null;
  return <div className="th-agents-quiet"><AgentStrip v={v} /></div>;
}

/** Polls the agents of a run; starts them for an earlier run that has none. */
export function useRunAgents(jobId: string, thesisId: string | null | undefined, done: boolean, weights?: Weights, template?: string | null) {
  const [id, setId] = useState<string | null>(thesisId ?? null);
  const [v, setV] = useState<ThesisView | null>(null);
  useEffect(() => { setId(thesisId ?? null); setV(null); }, [jobId, thesisId]);
  useEffect(() => { if (!id && done) startRunAgents(jobId, { weights, template }).then(r => setId(r.id)).catch(() => {}); }, [id, done, jobId]);
  useEffect(() => {
    if (!id) return;
    let stop = false, timer = 0;
    const tick = () => getThesis(id).then(x => { if (stop) return; setV(x); const busy = AGENT_ORDER.some(k => agentBusy(x.agents[k])); timer = window.setTimeout(tick, busy ? 3000 : 30000); })
      .catch(() => { if (!stop) timer = window.setTimeout(tick, 8000); });
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [id]);
  return v;
}

const isoDate = (x: string) => new Date(x + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
/** The optimiser run against the financial agent's pool, same opening month and limit. */
export function PortfolioCompare({ v }: { v: ThesisView }) {
  const t = v.thesis;
  return <div className="card table-card"><Tags a={["optimisation", "financial"]} /><h3 className="chart-h">Optimiser and financial agent <small>same opening month{t.co2Max ? ` and emissions limit (${t.co2Max} kg)` : ""}: your run against the pool's cheapest portfolio</small></h3>
    {v.compare.length === 0 ? <p className="gt-note">{agentBusy(v.agents.financial) || agentBusy(v.agents.optimisation) ? "Waiting for the optimisation and financial agents." : (v.answers.financial?.match?.text ?? "No comparison for this run.")}</p>
      : <div className="table-scroll"><table className="year-table th-cmp"><thead><tr><th className="l">Agent</th><th className="l">Portfolio</th><th>Opens</th><th>Full demand</th><th>10-yr cost</th><th>kg CO₂/MWh</th><th>Clean</th><th>Merchant</th><th>Cost gap<small className="detail">optimiser vs pool</small></th></tr></thead>
        <tbody>{(["optimiser", "financial"] as const).map((who, i) => { const c = v.compare[0], p = c[who]; return <tr key={who} className={i ? "th-cmp-2" : "th-cmp-1"}><td className="l"><b>{who === "optimiser" ? "Optimisation agent" : "Financial agent"}</b></td><td className="l note">{p.detail}</td>
          <td>m{p.opening}</td><td>m{p.fullDemand}</td><td>{usdM(p.costM)}</td><td>{f0(p.kgPerMwh)}</td><td>{f0(p.cleanSharePct)}%</td><td>{f0(p.merchantSharePct)}%</td><td>{i === 0 && c.costDiffPct != null ? `${c.costDiffPct > 0 ? "+" : ""}${f0(c.costDiffPct, 1)}%` : ""}</td></tr>; })}</tbody></table></div>}</div>;
}

/** The financial agent's pick (the pool's cheapest portfolio within the limits) and its cost breakdown. */
export function PoolPick({ v }: { v: ThesisView }) {
  const rec = v.financial?.recommendation;
  if (!rec?.recommendation) return <div className="card"><Tags a={["financial"]} /><p className="gt-note">{agentBusy(v.agents.financial) ? "Waiting for the financial agent." : v.agents.financial.detail}</p></div>;
  const r = rec.recommendation;
  return <div className="th-two">
    <div className="card"><span className="ag-row"><AgentTag a="financial" /><span className="tag">POOL'S CHEAPEST WITHIN YOUR LIMITS</span></span><h3 className="chart-h th-mt">Pool's cheapest within your limits <small>{r.detail}</small></h3><p>{r.why}</p><p className="gt-note">{r.nextStep}</p>
      <dl className="kv">{[["Opens / full demand", `m${r.opening} / m${r.fullDemand}`], ["10-yr cost", usdM(r.kpis.costM)], ["kg CO₂/MWh", f0(r.kpis.kgPerMwh, 1)], ["Clean share", `${f0(r.kpis.cleanSharePct)}%`], ["Portfolios tested", f0(rec.search?.tested)]].map(([a, b]) => <div key={a}><dt>{a}</dt><dd>{b}</dd></div>)}</dl></div>
    {rec.costBreakdown && <div className="card table-card"><Tags a={["financial"]} /><h3 className="chart-h">Cost of the pool's cheapest portfolio within your limits <small>10 years</small></h3><div className="table-scroll"><table className="year-table"><tbody>{rec.costBreakdown.rows.map(x => <tr key={x.label}><td>{x.label}<small className="detail">{x.note}</small></td><td>{usdM(x.valueM)}</td><td>{f0(x.sharePct)}%</td></tr>)}</tbody></table></div></div>}
  </div>;
}

/** Backup options the reliability rule adds. */
export function BackupTable({ v }: { v: ThesisView }) {
  const b = v.financial?.recommendation?.reliability?.backup;
  return <div className="card table-card"><Tags a={["financial"]} /><h3 className="chart-h">Backup options <small>what the reliability rule asks for beyond the portfolio</small></h3>
    {!b ? <p className="gt-note">{agentBusy(v.agents.financial) ? "Waiting for the financial agent." : "No backup analysis for this run."}</p> : <>
      <p className="gt-note top">Critical load {f0(b.criticalMw, 1)} MW · firm capacity with the largest unit out {f0(b.firmN1Mw, 1)} MW · shortfall {f0(b.shortfallMw, 1)} MW.</p>
      {b.options.length === 0 ? <p className="gt-note">No backup is needed for this portfolio.</p> : <div className="table-scroll"><table className="year-table"><thead><tr><th>Option</th><th>Added MW</th><th>Total $M</th><th className="l">Note</th></tr></thead>
        <tbody>{b.options.map(o => <tr key={o.name}><td>{o.name}</td><td>{f0(o.addedMw, 1)}</td><td>{usdM(o.totalM)}</td><td className="l note">{o.note}</td></tr>)}</tbody></table></div>}</>}</div>;
}

/** Zoning and data-center approval per site. */
export function LocalApprovals({ sites }: { sites: SiteRow[] }) {
  return <div className="card table-card"><Tags a={["moratorium"]} /><h3 className="chart-h">Zoning and approvals per site <small>what a data center needs from the county or city</small></h3>
    <div className="table-scroll"><table className="year-table th-mor"><thead><tr><th>Site</th><th className="l">Zoning</th><th className="l">Data-center approval</th></tr></thead>
      <tbody>{sites.map(s => { const p = s.policy ?? {}; return <tr key={s.id}><td>{s.county} County, {s.state}<small className="detail">{s.label}</small></td><td className="l note">{p.zoning ? String(p.zoning.value) : "–"}</td><td className="l note">{p.data_center_approval ? String(p.data_center_approval.value) : "–"}</td></tr>; })}</tbody></table></div>
    <p className="footnote">Texas Local Government Code ch. 231 (Texas counties have no general zoning authority outside cities); city ordinances where a site is inside a city.</p></div>;
}

/** Local moratorium stage and history per site. */
export function MoratoriumTable({ sites }: { sites: SiteRow[] }) {
  return <div className="card table-card"><Tags a={["moratorium"]} /><h3 className="chart-h">Local moratoriums per site <small>current stage and history</small></h3>
    <div className="table-scroll"><table className="year-table th-mor"><thead><tr><th>Site</th><th className="l">Local moratorium</th><th className="l">History</th></tr></thead>
      <tbody>{sites.map(s => { const p = s.policy ?? {}; return <tr key={s.id}><td>{s.county} County, {s.state}<small className="detail">{s.label}</small></td>
        <td className="l"><Outcome o={s.moratorium.outcome} /><small className="detail">{p.moratorium_stage ? `stage: ${p.moratorium_stage.value}` : s.moratorium.headline}</small></td>
        <td className="note">{p.moratorium_history ? String(p.moratorium_history.value) : "–"}</td></tr>; })}</tbody></table></div>
    <p className="footnote">Sources: county and city council records and local news coverage.</p></div>;
}

/** Dated state actions (from the policy agent) beside the run's own milestones. */
export function RegTimeline({ sites, events, cal }: { sites: SiteRow[]; events: { month: number; label: string }[]; cal: string | null }) {
  const tx = sites.find(s => s.state === "TX" && s.policy?.state_rules);
  const rules = String(tx?.policy?.state_rules?.value ?? "").split(" · ").filter(Boolean).map(x => { const m = /^(\d{4}-\d{2}-\d{2}):\s*(.*)$/.exec(x); return m ? [isoDate(m[1]), m[2]] : ["", x]; });
  const ev = [...events].sort((a, b) => a.month - b.month);
  return <div className="card"><Tags a={["moratorium", "optimisation"]} /><div className="th-two-col"><div><h4 className="th-h4">State actions (Texas)</h4>
      {rules.length ? <ol className="th-timeline">{rules.map(([d, x], i) => <li key={i}><b>{d}</b><span>{x}</span></li>)}</ol> : <p className="gt-note">No dated state actions for these sites.</p>}</div>
    <div><h4 className="th-h4">This run's milestones</h4>
      <ol className="th-timeline">{ev.map((e, i) => <li key={i}><b>{cal ? monthName(e.month, cal) : `Month ${e.month}`}{cal ? ` · month ${e.month}` : ""}</b><span>{e.label}</span></li>)}</ol></div></div></div>;
}

/** Water, flood and wetland facts per proposed site, and land used against the limit. */
export function EnvConstraints({ sites, used, limit }: { sites: SiteRow[]; used?: number | null; limit?: number | null }) {
  return <div className="card table-card"><Tags a={["sourcing", "optimisation"]} /><h3 className="chart-h">Water and land constraints <small>land the onsite equipment takes, and what the proposed sites sit on</small></h3>
    <LandBar used={used} limit={limit} />
    {sites.length > 0 && <div className="table-scroll"><table className="year-table"><thead><tr><th>Site</th><th>Water stress<small className="detail">0 low to 5 high</small></th><th className="l">Flood zone</th><th>Wetland share</th></tr></thead>
      <tbody>{sites.map(x => <tr key={x.id}><td>{x.county} County, {x.state}<small className="detail">{x.label}</small></td><td>{factText(fact(x, "water_stress_0_5"))}</td><td className="l note">{factText(fact(x, "flood_zone"))}</td><td>{factText(fact(x, "wetland_share"))}</td></tr>)}</tbody></table></div>}</div>;
}

/** Stall-chance range of the proposed sites, as text ("–" while the policy agent is pending). */
export function stallRange(sites: SiteRow[]) {
  const xs = sites.map(s => s.stall).filter((x): x is number => x != null);
  return xs.length ? (Math.min(...xs) === Math.max(...xs) ? `${f0(xs[0] * 100, 1)}%` : `${f0(Math.min(...xs) * 100, 1)}–${f0(Math.max(...xs) * 100, 1)}%`) : "–";
}
