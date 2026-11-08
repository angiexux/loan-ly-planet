import { useEffect, useRef, useState } from "react";
import { compareRuns, getJob, getMeta, getStress, listRuns, parseStressFile, startRun } from "./api";
import type { AlternativeOf, CompareRow, Diagnosis, Editable, Job, Meta, RelKey, Resource, Result, RunInputs, RunRow, SizingStep, StressInput, StressMeta, StressRow, StressSummary } from "./api";
import { getThesis } from "./thesisApi";
import type { ThesisInput, ThesisView } from "./thesisApi";
import type { AgentKey } from "./thesisApi";
import { AGENT_ORDER, AgentDot, AgentTag, BackupTable, EmissionsChart, EnvConstraints, LandRequirement, LocalApprovals, LocalRisk, MoratoriumTable, PermitsCard, PolicyNotice, PoolPick, PortfolioCompare, PowerOverTime, PriceSensitivity, RegTimeline, RunAgentsHead, SiteSections, SubHead, Tags, TEMPLATES, TOGGLES, TexasPanel, ThesisImpact, TradeoffCard, WhatIf, agentBusy, policyNotice, stallRange, useRunAgents } from "./thesis";
import { AirPermits } from "./permits";
import { AnnualCarbonChart, AnnualCostBars, CleanShareBars, HBars, Loading, PowerSourcesCard, PowerTimeline, SiteTimeline, StressChart, colorOf, monthName, useCharts } from "./charts";
import type { AnnualPoint, ChartsState } from "./charts";
import type { Template } from "./thesis";
import { Methodology } from "./methodology";

const IMG = {
  hero: "/faraday-hero.png",
  wind: "/faraday-grid-map.jpg",
  solar: "/faraday-server-light.jpg",
  plant: "/faraday-transmission.jpg",
  battery: "/faraday-server-dark.jpg",
};

type Page = "overview" | "intelligence" | "runs" | "thesis-new" | "thesis" | "thesis-results" | "info";

function Bolt() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.4 1 4 13h6.7L9.6 23 20 9.2h-7.1L13.4 1Z" /></svg>;
}

/** Thick horizontal arrow for the Power Intelligence buttons. */
function Arrow() {
  return <svg className="arrow-r" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h17M13 5l7 7-7 7" /></svg>;
}

function SectionHead({ label, number }: { label: string; number: string }) {
  return <div className="section-head"><span>{label}</span><span>{number}</span></div>;
}

function Sub({ children }: { children: React.ReactNode }) {
  return <p className="section-sub">{children}</p>;
}

function Count({ children }: { children: React.ReactNode }) {
  return <strong className="display count">{children}</strong>;
}

/** What the Power Intelligence page reports to the dashboard sidebar. */
interface NavState {
  screen: "form" | "results" | "running"; step: number; stepState: string[];
  job: { id: string; tag: string; status: Job["status"]; ok: boolean; infeasible: boolean; alt: boolean; plots: boolean; staged: boolean } | null;
}
/** A sidebar click for the Power Intelligence page; n changes on every click so the same command can repeat. */
type NavBody = { kind: "step"; i: number } | { kind: "results" } | { kind: "new" } | { kind: "template"; t: Template } | { kind: "plain"; patch: Partial<Form>; t: Template | null; understood: string[] };
type NavCmd = NavBody & { n: number };

const OVERVIEW_SECTIONS: [string, string][] = [["problem", "Problem statement"], ["solution", "Our solution"], ["methodology", "Methodology"], ["data", "Data used"]];
/** The run results page's sections, listed under "Thesis results" in the sidebar (only those on the page are shown). */
const RESULT_SECTIONS: [string, string, string][] = [["res-notice", "Disclaimer", "!"], ["res-inputs", "Inputs used", "·"], ["ra-decision", "Executive decision", "01"], ["ra-cost", "Cost", "02"],
  ["ra-speed", "Speed to power", "03"], ["ra-environment", "Environment", "04"], ["ra-policy", "Policy & permitting", "05"], ["ra-land", "Land & site", "06"]];

/** Which result sections are on the page, and the one being read (the last whose top has scrolled past the top of the view). */
function useResultSections(on: boolean) {
  const [st, setSt] = useState<{ present: string[]; active: string | null }>({ present: [], active: null });
  useEffect(() => {
    if (!on) { setSt({ present: [], active: null }); return; }
    const box = document.querySelector(".dash-main");
    const update = () => {
      const present = RESULT_SECTIONS.map(([id]) => id).filter(id => document.getElementById(id));
      const top = (box?.getBoundingClientRect().top ?? 0) + 140;
      const active = present.filter(id => document.getElementById(id)!.getBoundingClientRect().top <= top).pop() ?? present[0] ?? null;
      setSt(s => (s.active === active && s.present.join() === present.join() ? s : { present, active }));
    };
    update();
    const timer = window.setInterval(update, 1000);        // sections appear as the agents answer
    box?.addEventListener("scroll", update, { passive: true }); window.addEventListener("scroll", update, { passive: true });
    return () => { clearInterval(timer); box?.removeEventListener("scroll", update); window.removeEventListener("scroll", update); };
  }, [on]);
  return st;
}

const THESIS_KEY = "powerllel.thesis";          // the thesis last opened (old thesis links)
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* fine without storage */ } } };

function pageFromHash(): Page {
  const h = window.location.hash;
  if (window.location.pathname.replace(/\/$/, "") === "/info") return "info";
  if (h.startsWith("#intelligence")) return "intelligence";
  if (h === "#runs") return "runs";
  if (h === "#thesis/new" || h === "#thesis") return "thesis-new";      // the detailed thesis page is gone: templates fill the Optimizer
  if (/^#thesis\/[0-9a-f]{10}$/.test(h)) return "thesis-results";
  return "overview";
}

function App() {
  const [page, setPageState] = useState<Page>(pageFromHash);
  const [nav, setNav] = useState<NavState | null>(null);
  const [cmd, setCmd] = useState<NavCmd | null>(null);
  const [menu, setMenu] = useState(false);                       // the sidebar on narrow screens
  const [thesisId, setThesisId] = useState<string | null>(() => /^#thesis\/([0-9a-f]{10})$/.exec(window.location.hash)?.[1] ?? store.get(THESIS_KEY));
  const [view, setView] = useState<ThesisView | null>(null);
  const hashOf = (p: Page) => (p === "info" ? "/info" : p === "overview" ? "/" : p === "thesis-new" ? "#thesis/new" : p === "thesis" ? "#thesis" : p === "thesis-results" ? `#thesis/${thesisId ?? ""}` : `#${p}`);
  const setPage = (p: Page) => { setPageState(p); setMenu(false); const h = hashOf(p); history.replaceState(null, "", h.startsWith("#") ? `/${h}` : h); };
  useEffect(() => {                                    // links to #runs (e.g. from a run's results)
    const on = () => { if (window.location.hash === "#runs") setPageState("runs"); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // follow the current thesis: poll while an agent is working
  useEffect(() => {
    if (!thesisId) { setView(null); return; }
    let stop = false, timer = 0;
    const tick = () => getThesis(thesisId).then(v => {
      if (stop) return;
      setView(v);
      const busy = AGENT_ORDER.some(k => agentBusy(v.agents[k])) || v.scenarios.some(s => s.status === "running" || s.status === "queued");
      timer = window.setTimeout(tick, busy ? 3000 : 20000);
    }).catch(() => { if (!stop) timer = window.setTimeout(tick, 8000); });
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [thesisId]);
  const openRun = (id: string) => { history.replaceState(null, "", `/#intelligence/run/${id}`); setPageState("intelligence"); setCmd(null); };   // Intelligence opens the linked run when it mounts
  const toOverview = (section?: string) => {
    setPage("overview");
    requestAnimationFrame(() => section ? document.getElementById(section)?.scrollIntoView({ behavior: "smooth" }) : document.querySelector(".app-shell")?.scrollTo({ top: 0 }));
  };
  const secs = useResultSections(page === "intelligence" && nav?.screen === "results");
  const goSection = (p: Page, id: string) => { setPage(p); setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60); };

  if (page === "overview") return (
    <div className="app-shell">
      <header className="nav site-nav">
        <button className="brand" onClick={() => toOverview()} aria-label="Powerllel home"><Bolt /><span>POWERLLEL</span></button>
        <button className="pi-link" onClick={() => setPage("thesis-new")}>Power Intelligence <Arrow /></button>
      </header>
      <main><Overview openModel={() => setPage("thesis-new")} /></main>
      <footer><div className="brand"><Bolt /><span>POWERLLEL</span></div><span>Power decisions for the grid-constrained era.</span><span>© 2025</span></footer>
    </div>
  );

  const send = (c: NavBody) => { setPageState("intelligence"); setMenu(false); if (page !== "intelligence") history.replaceState(null, "", "/#intelligence"); setCmd({ ...c, n: Date.now() }); };
  const onIntel = page === "intelligence";
  const j = nav?.job;
  const running = j?.status === "running";
  const resultsOn = onIntel && nav?.screen === "results";
  const jump = (id: string) => { setMenu(false); document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const agentsBusy = !!view && AGENT_ORDER.some(k => agentBusy(view.agents[k]));
  const currentJob = j?.id ?? store.get(JOB_KEY);
  const canResults = !!(currentJob || thesisId);
  const openCurrent = () => {                          // the results of the current run (live progress while it runs)
    setMenu(false);
    if (onIntel && j) send({ kind: "results" });
    else if (currentJob) openRun(currentJob);
    else if (thesisId) { history.replaceState(null, "", `/#thesis/${thesisId}`); setPageState("thesis-results"); }
  };
  return (
    <div className={`pi-dash ${menu ? "menu-open" : ""}`}>
      <header className="dash-top">
        <div className="dash-brand">
          <button className="menu-btn" onClick={() => setMenu(m => !m)} aria-expanded={menu} aria-controls="dash-side" aria-label="Menu"><span /><span /><span /></button>
          <button className="brand" onClick={() => toOverview()} aria-label="Powerllel website"><Bolt /><span>POWERLLEL</span></button>
          <span className="dash-app">Power Intelligence</span>
        </div>
        <div className="dash-actions">
          {agentsBusy && !(onIntel && j) && page !== "thesis-results" && <button className="dash-live" onClick={openCurrent}><i className="spin" />Agents running in background</button>}
          {running && !agentsBusy && <button className="dash-live" onClick={() => send({ kind: "results" })}><i className="spin" />Run {j!.tag} in progress</button>}
        </div>
      </header>
      <div className="dash-body">
        <aside className="dash-side" id="dash-side" aria-label="Power Intelligence navigation">
          <div className="side-group">
            <button className={`side-item top ${page === "thesis-new" || (onIntel && !resultsOn && nav?.screen !== "running") ? "active" : ""}`} disabled={running} title={running ? "A run is in progress" : undefined} onClick={() => setPage("thesis-new")}><span>New thesis</span></button>
            {STEPS.map((st, i) => {                         // the Optimizer's checklist, always under New thesis
              const state = nav?.stepState[i] ?? "";
              const here = onIntel && nav?.screen === "form" && nav.step === i;
              return <button key={st.title} className={`side-item sub chk ${here ? "active" : ""} ${state}`} disabled={running} title={running ? "A run is in progress" : undefined} onClick={() => send({ kind: "step", i })}>
                <span>{st.title}</span><i className="side-mark">{state === "done" ? "✓" : state === "error" ? "!" : i + 1}</i></button>;
            })}
            <button className={`side-item top ${page === "thesis-results" || (onIntel && (nav?.screen === "results" || nav?.screen === "running")) ? "active" : ""}`} disabled={!canResults} title={canResults ? undefined : "Run a thesis first"} onClick={openCurrent}>
              <span>Thesis results</span>{j ? <i className={`side-dot ${running ? "run" : j.ok ? "ok" : "bad"}`} title={running ? "Running" : j.ok ? "Feasible" : j.status === "failed" ? "Failed" : "No feasible portfolio"} /> : null}</button>
            {resultsOn && RESULT_SECTIONS.filter(([id]) => secs.present.includes(id)).map(([id, t, mark]) =>   // the results' sections, like the checklist under New thesis
              <button key={id} className={`side-item sub chk ${secs.active === id ? "active" : ""} ${id === "res-notice" ? "warn" : ""}`} aria-current={secs.active === id ? "true" : undefined} onClick={() => jump(id)}>
                <span>{t}</span><i className="side-mark">{mark}</i></button>)}
            <button className={`side-item top ${page === "runs" ? "active" : ""}`} onClick={() => setPage("runs")}><span>Previous runs</span></button>
          </div>
          <div className="side-group">
            <h4>About the model</h4>
            {OVERVIEW_SECTIONS.map(([id, t]) => <button key={id} className="side-item muted" onClick={() => toOverview(id)}><span>{t}</span><i className="side-mark">↗</i></button>)}
          </div>
        </aside>
        <button className="dash-scrim" aria-label="Close menu" tabIndex={-1} onClick={() => setMenu(false)} />
        <main className="dash-main">
          {page === "runs" ? <PreviousRuns onOpen={openRun} onNew={() => send({ kind: "new" })} />
            : page === "info" ? <Methodology />
            : page === "thesis-new" ? <PlainStart onPick={t => { send({ kind: "template", t }); document.querySelector(".dash-main")?.scrollTo({ top: 0 }); }} onSkip={() => { send({ kind: "new" }); document.querySelector(".dash-main")?.scrollTo({ top: 0 }); }} onRead={(patch, t, understood) => { send({ kind: "plain", patch, t, understood }); document.querySelector(".dash-main")?.scrollTo({ top: 0 }); }} />
            : page === "thesis-results" ? (thesisId ? <ThesisOpen id={thesisId} onOpen={openRun} /> : <section className="section model-hero"><span className="tag">THESIS</span><h1 className="display">NO THESIS <em>YET.</em></h1><button className="primary" onClick={() => setPage("thesis-new")}>New thesis <Arrow /></button></section>)
            : <Intelligence cmd={cmd} onNav={setNav} />}
        </main>
      </div>
    </div>
  );
}

/** #thesis/<id>: opens the run page of that thesis (a single-run thesis: its run; a multi-question one: its first feasible scenario). */
function ThesisOpen({ id, onOpen }: { id: string; onOpen: (jobId: string) => void }) {
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    getThesis(id).then(v => {
      if (stop) return;
      const withJob = v.scenarios.filter(s => s.jobId);
      const jobId = (v.mode === "run" && v.runJobId) || (withJob.find(s => s.run?.resultStatus === "OK") ?? withJob[0])?.jobId;
      if (jobId) onOpen(jobId); else setErr("This thesis has no optimiser run yet.");
    }).catch(e => !stop && setErr(e.message));
    return () => { stop = true; };
  }, [id]);
  return <section className="section model-hero"><span className="tag">THESIS</span><h1 className="display">{err ? <>NO RUN <em>TO OPEN.</em></> : <>OPENING THE <em>RUN…</em></>}</h1>{err && <p className="notice">{err}</p>}</section>;
}

/** A readable name from a run's inputs, when it has no thesis title. */
const nameFromInputs = (peak: unknown, start: unknown, rel: unknown) => [peak != null && peak !== "" ? `${peak} MW` : null, start != null && start !== "" ? `opening month ${start}` : null, rel].filter(Boolean).join(" · ") || "Optimiser run";

// ------------------------------------------------------------------------------------------------ Overview: problem, solution, methodology, data

const DATA_ROWS: [string, string, string, string][] = [
  ["Hourly wholesale power prices", "Public", "ERCOT LZ_SOUTH 2023, escalated +5%/yr real", "Grid purchases"],
  ["Wind and solar output profiles", "Public", "ERCOT 2023 generation and capacity", "Contract energy"],
  ["Grid-stress windows (7 events)", "Public", "ERCOT 2023 conservation notices (the 60% cap is assumed)", "Stress response"],
  ["Natural gas price", "Public", "EIA Henry Hub 2023, +3%/yr real, plus a $1 adder", "Gas cost"],
  ["Grid CO₂ factor", "Public", "EPA eGRID 2023, falling 3%/yr", "Carbon"],
  ["Turbine and battery cost, engine heat rate, battery efficiency", "Public", "EIA AEO2025, EPA CHP catalog, NREL ATB", "Equipment charges, fuel"],
  ["Campus demand, protected / relocatable / interruptible split, ramp", "Private (case)", "Customer packet: a fictional 75 MW campus", "Load"],
  ["Grid import schedule (0, 25, 50, 75 MW)", "Private (case)", "Utility schedule in the packet (fictional)", "Import cap"],
  ["Contract offers: solar $40, wind $35, nuclear $95 per MWh; sizes and dates", "Private (case)", "Commercial offers in the packet (fictional)", "Contract payments"],
  ["Engine and fuel-cell costs, equipment footprints, 8 usable acres", "Private (case)", "Packet assumptions (fictional)", "Equipment charges, land limit"],
  ["Remote-site terms, interruption consequence", "Private (case)", "Packet assumptions: $123.50/MWh to relocate, $1,000/MWh to interrupt", "Stress response"],
  ["Campus peak, opening month, calendar date, grid interconnection timeline", "User input", "Set on the Power Intelligence page", "Load, ramp, import cap"],
  ["Reliability standard (R0 to R5), carbon ceiling", "User input", "Chosen per customer", "Portfolio constraints"],
  ["Price growth, resource costs and dates, minimum commitments, upfront or year-by-year build", "User input", "Optional overrides of the packet values", "Costs and capacity choices"],
];

function Overview({ openModel }: { openModel: () => void }) {
  const kinds = ["Public", "Private (case)", "User input"];
  return <>
    <section className="hero">
      <div className="hero-photo" style={{ backgroundImage: `url(${IMG.hero})` }} />
      <div className="hero-shade" />
      <div className="hero-content reveal">
        <p className="eyebrow">Powerllel · power intelligence for data centers</p>
        <h1 className="display">POWERLLEL TURNS A POWER PROBLEM <em>INTO A</em> DECISION.</h1>
        <p className="lede">Helping data center developers with their energy portfolio decisions.</p>
        <div className="actions hero-actions"><button className="primary" onClick={openModel}>Open Power Intelligence <Arrow /></button><button className="outline" onClick={() => document.querySelector("#problem")?.scrollIntoView({ behavior: "smooth" })}>How it works</button></div>
      </div>
    </section>
    <div className="ticker">
      <div className="ticker-track">
        {[0, 1].map(group => (
          <div className="ticker-group" key={group} aria-hidden={group === 1}>
            {["EIA", "ERCOT", "EPA eGRID", "NREL ATB", "EPA CHP CATALOG"].map(source => <span key={source}>{source}</span>)}
          </div>
        ))}
      </div>
    </div>

    <section className="section" id="problem">
      <SectionHead label="Problem statement" number="01" />
      <div className="split intro-grid">
        <div><h2 className="display">WHICH PORTFOLIO <em>MEETS THE DEMAND?</em></h2>
          <p className="lede dark">How can data center developers decide which energy portfolio will meet their demand requirements?</p>
          <p className="lede dark">The developer has to choose a mix of grid power, onsite generation, a battery and clean energy sources, while considering price, reliability and accounting for potential stress events.</p>
          <p className="lede dark">Developers face many constraints and market events. To decide well they need sensitivity analysis on prices, the response to stress events when the grid connection is cut, carbon information, and the cost and timing of every option side by side.</p>
</div>
        <SampleMix />
      </div>
    </section>

    <section className="section" id="solution">
      <SectionHead label="Our solution" number="02" />
      <Sub>The solution is an optimization product. It finds the lowest-cost portfolio that opens when the developer needs it, meets their reliability standard and stays under their carbon ceiling, and reports speed to power, cost and environmental impact (carbon emissions) for it.</Sub>
      <div className="cards three priorities">
        {[["Speed to power", "How soon the campus can switch on and reach full demand.", IMG.hero], ["Cost", "The ten-year cost of equipment, contracts, fuel and grid power.", IMG.plant], ["Environmental", "Carbon emissions per MWh and the share of clean energy.", IMG.wind]].map(([x, y, im], i) => <article className="card process" key={x}><img src={im} alt="" /><span className="mono">0{i + 1}</span><h3>{x}</h3><p>{y}</p></article>)}
      </div>
      <div className="card extra-card"><span className="tag">SHARPER, MORE COMPREHENSIVE DECISIONS</span><p>To make the decision sharper and more comprehensive we have added <b>stress events</b>, the seven short periods a year when the grid connection is cut and every portfolio must keep protected load on, and <b>reliability standards</b>, from losing the largest onsite unit up to running the whole campus without the grid, including the Texas SB6 rules.</p></div>
    </section>

    <section className="section" id="methodology">
      <SectionHead label="Methodology" number="03" />
      <Sub>How the two models behind Power Intelligence decide: the financial model (the Excel method) and the optimisation model, with their formulas in plain language and the Excel files to check them yourself.</Sub>
      <Methodology embedded />
    </section>

    <section className="section" id="data">
      <SectionHead label="Data used" number="04" />
      <Sub>Three kinds of data feed the model. Public data is real and cited. Private (case) data is the commercial and campus information of this exercise, fictional but fixed. User input is what the person making the decision can change.</Sub>
      <div className="cards four data-kinds">
        {[["Public", "Real, published data prepared in the packet: prices, weather-driven output, emissions and technology costs."], ["Private (case)", "The campus and its commercial terms: load, utility schedule, contract offers, site and remote-site terms. Fictional in this exercise."], ["User input", "Campus size, timeline, grid interconnection, reliability standard, carbon ceiling, price growth, resource costs and minimum commitments."]].map(([k, v]) => <article className="card" key={k}><span className={`tag kind-${k.split(" ")[0].toLowerCase()}`}>{k.toUpperCase()}</span><p>{v}</p></article>)}
      </div>
      <div className="card table-card"><div className="table-scroll"><table className="year-table data-table"><thead><tr><th>Data</th><th>Type</th><th>Source</th><th>Where it enters</th></tr></thead>
        <tbody>{DATA_ROWS.map(([a, b, c, d]) => <tr key={a}><td>{a}</td><td><span className={`tag kind-${b.split(" ")[0].toLowerCase()}`}>{kinds.includes(b) ? b.toUpperCase() : b}</span></td><td>{c}</td><td>{d}</td></tr>)}</tbody></table></div></div>
      <p className="footnote">The campus is a fictional benchmark case. Public sources are cited; every assumption is listed on the Power Intelligence page.</p>
    </section>

    <section className="section"><div className="dark-card"><span className="tag">TRY THE TOOL</span><h2 className="display">READY TO PLAN<br/>THE CAMPUS?</h2><button className="light" onClick={openModel}>Open Power Intelligence <Arrow /></button></div></section>
  </>;
}

const SAMPLE_YEARS = ["Y2", "Y3", "Y4", "Y5", "Y6", "Y7"];
const SAMPLE_MIX: [string, string, number[]][] = [
  ["wind", "Wind contract", [8, 20, 34, 38, 38, 38]],
  ["solar", "Solar contract", [0, 6, 14, 20, 20, 20]],
  ["gas_turbine", "Onsite gas", [14, 22, 18, 12, 10, 10]],
  ["merchant", "Grid power", [0, 4, 9, 5, 7, 7]],
];

function SampleMix() {
  const scale = 75;
  return <div className="card chart-card"><div className="chart-title"><span>Sample energy sources</span><span>MW, average per year</span></div>
    <div className="legend sample-legend">{SAMPLE_MIX.map(([k, n]) => <span key={k} className="lc" style={{ ["--c" as string]: RES_COLOR[k] }}>{n}</span>)}<span className="dash">Grid import cap</span></div>
    <div className="bars year-bars sample-bars"><div className="ylabels">{[1, 2 / 3, 1 / 3, 0].map(f => <span key={f}>{(scale * f).toFixed(0)}</span>)}</div>
      {SAMPLE_YEARS.map((y, j) => <div className="bar-col" key={y}><div className="stack">{SAMPLE_MIX.map(([k, n, v]) => <i key={k} style={{ height: `${v[j] / scale * 100}%`, background: RES_COLOR[k] }} title={`${n}: ${v[j]} MW`} />)}
        <b className="cap-mark" style={{ bottom: `${[0, 25, 50, 75, 75, 75][j] / scale * 100}%` }} /></div><small className="ytick">{y}</small></div>)}</div>
    <p className="axis-label">Illustrative sample, not model output · the engine builds this chart for the portfolio it recommends</p></div>;
}

// ------------------------------------------------------------------------------------------------ Power Intelligence: the GRIDTECH optimiser
// The form asks the optimiser's questions Q2-Q10 (GRIDTECH_interactive_cell); team_app/gridtech_server.py runs it and returns its numbers and plots.
const RES_COLOR: Record<string, string> = { nuclear: "#111111", wind: "#2e7d4f", solar: "#f7c08a", battery: "#8cc9a1", fuel_cell: "#d9822b", gas_engine: "#f26b1d", gas_turbine: "#8a3b0e", merchant: "#9a9a96" };   // orange, black, grey, green
const FIELDS: [Editable, string, boolean][] = [["capex_usd_per_kw", "CAPEX $/kW", true], ["fom_usd_per_kw_year", "Fixed O&M $/kW-yr", true], ["payment_usd_per_mwh", "Contract price or variable O&M $/MWh", false], ["available_month", "Available from month", false], ["max_mw", "Maximum MW", false]];
const JOB_KEY = "gridtech.job";
const TPL_KEY = "powerllel.template";
const HORIZON_LAST_MONTH = 119;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

const fmt = (v: number | null | undefined, d = 0) => (v == null ? "–" : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const usdM = (v: number | null | undefined, d = 1) => (v == null ? "–" : `$${fmt(v / 1e6, d)}M`);
const pct = (v: number | null | undefined) => (v == null ? "–" : `${fmt(v * 100)}%`);

function monthLabel(m: number, cal: string) {
  if (!DATE_RE.test(cal)) return `month ${m}`;
  const [y, mo] = cal.split("-").map(Number);
  const t = mo - 1 + m;
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][t % 12]} ${y + Math.floor(t / 12)}`;
}

/** Resource maximum after the catalogue is scaled to the campus peak, as the optimiser shows it in Q8. */
function scaledMax(r: Resource, peak: number) {
  return Math.max(r.block_mw, Math.floor(r.max_mw * peak / 75 / r.block_mw + 1e-9) * r.block_mw);
}

interface Form {
  peak: string; cal: string; start: string; icMode: "steps" | "month" | "packet"; steps: { month: number; mw: string }[] | null; icMonth: number;
  rel: RelKey; co2: string; wg: string; gg: string; ov: Record<string, Partial<Record<Editable, string>>>; mins: Record<string, string>; staged: boolean;
  stress: StressForm;
  excluded: string[]; gridDelay: string; gridAdder: string; land: string;   // resources switched off; grid slip (months); extra grid $/MWh; onsite land (acres, empty = packet)
}
/** Stress events: the packet's, or the customer's own rows (ticked rows are used; source says where they came from). */
interface StressForm { mode: "packet" | "custom"; source: string; rows: StressRow[] }
const DEFAULT_FORM: Form = { peak: "75", cal: "", start: "20", icMode: "steps", steps: null, icMonth: 21, rel: "R1", co2: "", wg: "5", gg: "3", ov: {}, mins: {}, staged: true,
  stress: { mode: "packet", source: "", rows: [] }, excluded: [], gridDelay: "", gridAdder: "", land: "" };
const STRESS_LIMITS = { events: 60, hours: 168, totalHours: 336 };            // the server's limits (gridtech_server.STRESS_LIMITS)
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Minutes since 2023-01-01 00:00 on the model's clock, or null if not a real date and time (daylight saving is left to the server). */
function clockMinutes(s: string): number | null {
  const m = LOCAL_RE.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return (t - Date.UTC(2023, 0, 1)) / 60000;
}
const whenLabel = (s: string) => { const m = LOCAL_RE.exec(s); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[4]}:${m[5]}` : s; };
const fromCatalog = (r: { id: string; start: string; hours: number | string; importPct: number | string; noticeMin: number | string; include?: boolean; operator?: string; type?: string; confidence?: string; notes?: string }): StressRow =>
  ({ id: r.id, start: r.start, hours: String(r.hours), importPct: String(r.importPct), noticeMin: String(r.noticeMin), include: r.include !== false, operator: r.operator, type: r.type, confidence: r.confidence, notes: r.notes });

/** Clock hours touched by the ticked events, counted once (as the model counts them), and the lowest import allowed. */
function stressStats(rows: StressRow[]) {
  const hours = new Set<number>();
  let minImp: number | null = null;
  for (const r of rows) {
    if (!r.include) continue;
    const s = clockMinutes(r.start), h = Number(r.hours);
    if (s == null || !(h > 0)) continue;
    const e = s + Math.round(h * 60);
    for (let t = Math.floor(s / 60); t * 60 < e; t++) hours.add(t);
    const imp = Number(r.importPct);
    if (r.importPct.trim() !== "" && Number.isFinite(imp)) minImp = minImp == null ? imp : Math.min(minImp, imp);
  }
  return { hours: hours.size, events: rows.filter(r => r.include).length, minImp };
}

function stressInputOf(s: StressForm): StressInput {
  if (s.mode === "packet") return { mode: "packet" };
  const clean = (r: StressRow): StressRow => ({ ...r, id: r.id.trim(), start: r.start.trim(), hours: r.hours.trim(), importPct: r.importPct.trim(), noticeMin: r.noticeMin.trim() });
  return { mode: "custom", source: s.source || "your events", events: s.rows.filter(r => r.include).map(clean), excluded: s.rows.filter(r => !r.include).map(clean) };
}

/** Interconnection steps; null = follow the peak: half at month 18, full at 24 (the notebook's default answer). */
const stepRowsOf = (f: Form) => f.steps ?? [{ month: 18, mw: String((Number(f.peak) || 0) / 2) }, { month: 24, mw: String(Number(f.peak) || 0) }];

function toInputs(f: Form): RunInputs {
  const resources: RunInputs["resources"] = {};
  for (const [rid, o] of Object.entries(f.ov)) {
    const x: Partial<Record<Editable, string>> = {};
    for (const [k, v] of Object.entries(o)) if (v != null && v.trim() !== "") x[k as Editable] = v.trim();
    if (Object.keys(x).length) resources[rid] = x;
  }
  const minCaps: Record<string, string> = {};
  for (const [rid, v] of Object.entries(f.mins)) if (v.trim() !== "" && !f.excluded.includes(rid)) minCaps[rid] = v.trim();
  return {
    peakMw: f.peak.trim(), calendarStart: f.cal.trim() || null, start: f.start.trim(),
    interconnection: f.icMode === "packet" ? { mode: "packet" } : f.icMode === "month" ? { mode: "month", month: f.icMonth } : { mode: "steps", steps: stepRowsOf(f).map(s => ({ month: s.month, mw: s.mw.trim() })) },
    reliability: f.rel, co2Cap: f.co2.trim() === "" ? null : f.co2.trim(),
    wholesaleGrowth: Number(f.wg) / 100, gasGrowth: Number(f.gg) / 100, resources, minCaps, staged: f.staged, stressEvents: stressInputOf(f.stress),
    ...(f.excluded.length ? { excluded: [...f.excluded] } : {}), ...(Number(f.gridDelay) > 0 ? { gridDelay: Number(f.gridDelay) } : {}),
    ...(Number(f.gridAdder) > 0 ? { gridAdderExtra: Number(f.gridAdder) } : {}), ...(f.land.trim() !== "" ? { landAcres: f.land.trim() } : {}),
  };
}

/** Back from a run's stored inputs to the form, for "Edit these inputs". */
function fromInputs(i: RunInputs): Form {
  const ic = i.interconnection;
  const pct = (v: number) => String(Math.round(v * 100 * 1e6) / 1e6);
  return {
    peak: String(i.peakMw), cal: i.calendarStart ?? "", start: String(i.start),
    icMode: ic.mode, steps: ic.mode === "steps" ? ic.steps.map(s => ({ month: s.month, mw: String(s.mw) })) : null, icMonth: ic.mode === "month" ? ic.month : 21,
    rel: i.reliability, co2: i.co2Cap == null ? "" : String(i.co2Cap), wg: pct(i.wholesaleGrowth), gg: pct(i.gasGrowth),
    ov: Object.fromEntries(Object.entries(i.resources ?? {}).map(([rid, o]) => [rid, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]))])),
    mins: Object.fromEntries(Object.entries(i.minCaps ?? {}).map(([k, v]) => [k, String(v)])), staged: i.staged,
    stress: i.stressEvents?.mode === "custom"
      ? { mode: "custom", source: i.stressEvents.source, rows: [...i.stressEvents.events.map(r => fromCatalog({ ...r, include: true })), ...(i.stressEvents.excluded ?? []).map(r => fromCatalog({ ...r, include: false }))].sort((a, b) => a.start.localeCompare(b.start)) }
      : { mode: "packet", source: "", rows: [] },
    excluded: [...(i.excluded ?? [])], gridDelay: i.gridDelay ? String(i.gridDelay) : "", gridAdder: i.gridAdderExtra ? String(i.gridAdderExtra) : "", land: i.landAcres != null && String(i.landAcres) !== "" ? String(i.landAcres) : "",
  };
}

/** The same rules as team_app/gridtech_server.py _parse: the notebook's question checks, plus a few for inputs it leaves unchecked. */
function validate(f: Form, resources: Resource[]): Record<string, string> {
  const e: Record<string, string> = {};
  const num = (key: string, raw: string | undefined, label: string, o: { lo?: number; hi?: number; integer?: boolean; loOpen?: boolean; required?: boolean } = {}) => {
    const s = (raw ?? "").trim();
    if (s === "") { if (o.required !== false) e[key] = `${label}: enter a value`; return null; }
    if (!NUM_RE.test(s)) { e[key] = `${label}: could not read "${s}", enter a number`; return null; }
    const x = Number(s);
    if (o.integer && !Number.isInteger(x)) { e[key] = `${label}: must be a whole number`; return null; }
    const low = o.lo != null && (o.loOpen ? x <= o.lo : x < o.lo), high = o.hi != null && x > o.hi;
    if (low || high) { e[key] = `${label}: enter ${o.lo != null && o.hi != null ? `${o.lo} – ${o.hi}` : o.lo != null ? `${o.loOpen ? ">" : "≥"} ${o.lo}` : `≤ ${o.hi}`}`; return null; }
    return x;
  };
  const peak = num("peakMw", f.peak, "Peak load (MW)", { lo: 5, hi: 2000 });
  if (f.cal.trim() !== "" && !DATE_RE.test(f.cal.trim())) e.calendarStart = "Calendar date of month 0: use the format YYYY-MM with a month 01–12, e.g. 2027-01";
  num("start", f.start, "Opening month", { lo: 14, hi: 109, integer: true });
  num("landAcres", f.land, "Onsite land for equipment (acres)", { lo: 0.5, hi: 100000, required: false });
  num("gridDelay", f.gridDelay, "Grid connection slip (months)", { lo: 0, hi: 36, integer: true, required: false });
  num("gridAdderExtra", f.gridAdder, "Extra grid cost ($/MWh)", { lo: 0, hi: 500, required: false });
  if (f.icMode === "packet" && peak != null && peak !== 75) e.interconnection = "The packet schedule is only for a 75 MW campus: set the peak to 75 MW or enter steps";
  if (f.icMode === "steps") {
    const rows = stepRowsOf(f);
    if (!rows.length) e.interconnection = "Add at least one interconnection step";
    const seen = new Set<number>();
    rows.forEach((s, i) => {
      num(`step.${i}.mw`, s.mw, `Step ${i + 1} import (MW)`, { lo: 0, hi: 2000 });
      if (seen.has(s.month)) e[`step.${i}.month`] = `Step ${i + 1}: month ${s.month} is already used by an earlier step`;
      seen.add(s.month);
    });
  }
  num("co2Cap", f.co2, "Carbon ceiling (kg CO₂/MWh)", { lo: 0, loOpen: true, required: false });
  for (const [key, raw, label] of [["wholesaleGrowth", f.wg, "Wholesale price growth (%/yr)"], ["gasGrowth", f.gg, "Henry Hub gas price growth (%/yr)"]] as const) num(key, raw, label, { lo: -20, hi: 30 });
  for (const r of resources) {
    let max = peak != null ? scaledMax(r, peak) : null;
    for (const [k, label, onsiteOnly] of FIELDS) {
      if (onsiteOnly && r.location === "offsite") continue;
      const key = `res.${r.id}.${k}`, lab = `${r.label}, ${label}`;
      const x = k === "available_month" ? num(key, f.ov[r.id]?.[k], lab, { lo: 0, hi: HORIZON_LAST_MONTH, integer: true, required: false })
        : num(key, f.ov[r.id]?.[k], lab, { lo: 0, required: false });
      if (k === "max_mw" && x != null) {
        if (x < r.block_mw) e[key] = `${lab}: must be at least one block (${r.block_mw} MW)`;
        else max = Math.max(r.block_mw, Math.floor(x / r.block_mw) * r.block_mw);
      }
    }
    if (f.excluded.includes(r.id)) continue;
    const m = num(`min.${r.id}`, f.mins[r.id], `${r.label}, minimum MW`, { lo: 0, required: false });
    if (m != null && max != null && m > max + 1e-9) e[`min.${r.id}`] = `${r.label}, minimum MW: ${m} is above its maximum of ${max} MW`;
  }
  if (f.stress.mode === "custom") {
    // keys follow the ticked rows in order, as the server numbers them
    const used = f.stress.rows.filter(r => r.include);
    if (used.length > STRESS_LIMITS.events) e.stressEvents = `Stress events: at most ${STRESS_LIMITS.events} events (you have ${used.length})`;
    const yearEnd = clockMinutes("2024-01-01T00:00")!;
    used.forEach((r, i) => {
      const n = `Event ${i + 1}${r.id ? ` (${r.id.slice(0, 40)})` : ""}`;
      const s = clockMinutes(r.start);
      if (s == null) e[`stress.${i}.start`] = `${n}, start: use a date and time like 2023-08-24T15:00`;
      else if (s < 0 || s >= yearEnd) e[`stress.${i}.start`] = `${n}, start: must be in 2023, the model's reference year (events repeat every model year)`;
      const h = num(`stress.${i}.hours`, r.hours, `${n}, duration (hours)`, { lo: 0, hi: STRESS_LIMITS.hours, loOpen: true });
      num(`stress.${i}.importPct`, r.importPct, `${n}, import allowed (%)`, { lo: 0, hi: 100 });
      num(`stress.${i}.noticeMin`, r.noticeMin, `${n}, notice (minutes)`, { lo: 0, hi: 10080 });
      if (s != null && s >= 0 && s < yearEnd && h != null && s + Math.round(h * 60) > yearEnd) e[`stress.${i}.hours`] = `${n}: ends after 31 Dec 2023 24:00; shorten it or split it into two events`;
    });
    const total = stressStats(f.stress.rows).hours;
    if (!e.stressEvents && total > STRESS_LIMITS.totalHours) e.stressEvents = `Stress events cover ${total} hours a year; the limit is ${STRESS_LIMITS.totalHours} (sizing keeps every stress period at full detail, so more hours make the solve much slower)`;
  }
  return e;
}

function Err({ e }: { e?: string }) {
  return e ? <small className="gt-err" role="alert">{e}</small> : null;
}

// The stepper: each error key belongs to the step that holds its field.
const STEPS: { title: string; blurb: string; owns: (k: string) => boolean }[] = [
  { title: "Campus & timeline", blurb: "How big the campus is and when it opens.", owns: k => ["peakMw", "calendarStart", "start", "landAcres"].includes(k) },
  { title: "Grid interconnection", blurb: "When the utility connection arrives and how much it imports.", owns: k => k === "interconnection" || k === "gridDelay" || k.startsWith("step.") },
  { title: "Reliability & carbon", blurb: "The reliability standard and an optional carbon ceiling.", owns: k => k === "reliability" || k === "co2Cap" },
  { title: "Stress events", blurb: "When the grid limits imports, for how long, and by how much.", owns: k => k === "stressEvents" || k.startsWith("stress.") },
  { title: "Market & build", blurb: "Price growth and how capacity is committed.", owns: k => ["wholesaleGrowth", "gasGrowth", "staged", "gridAdderExtra"].includes(k) },
  { title: "Energy resources", blurb: "Switch a resource off if it is not available, change the packet's numbers, and set minimum commitments.", owns: k => k === "excluded" || k.startsWith("res.") || k.startsWith("min.") },
  { title: "Review & run", blurb: "Check everything, then run the optimiser.", owns: () => false },
];

const scrollTop = () => document.querySelectorAll(".app-shell, .dash-main").forEach(el => el.scrollTo({ top: 0, behavior: "smooth" }));

function Intelligence({ cmd, onNav }: { cmd: NavCmd | null; onNav: (s: NavState) => void }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const [step, setStep] = useState(0);
  const [visited, setVisited] = useState<Set<number>>(new Set([0]));
  const [screen, setScreen] = useState<"form" | "results">("form");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [basis, setBasis] = useState<Omit<AlternativeOf, "changes"> | null>(null);   // set while the form holds an alternative to an earlier run
  const [priced, setPriced] = useState<{ from: RunInputs; title?: string } | null>(null);   // "Price it in the optimiser": the run's inputs before the change (the review highlights what changed)
  const [stressMeta, setStressMeta] = useState<StressMeta | null>(null);
  const [stressError, setStressError] = useState<string | null>(null);
  const [fromWords, setFromWords] = useState<string[] | null>(null);   // what the plain-language page read into the form
  const [tpl, setTpl] = useState<Template | null>(() => { const k = localStorage.getItem(TPL_KEY); return TEMPLATES.find(t => t.key === k) ?? null; });   // the template that filled the form: its weights go to the agents
  const loaded = useRef(false);
  const mountCmd = useRef(cmd?.kind === "step" || cmd?.kind === "new" || cmd?.kind === "template" || cmd?.kind === "plain");   // opened from the sidebar on a step: do not jump to the last run's results
  useEffect(() => { getStress().then(setStressMeta).catch(e => setStressError(e.message)); }, []);
  const running = job?.status === "running";

  useEffect(() => {
    getMeta().then(m => {
      setMeta(m); setMetaError(null);
      if (loaded.current) return;
      loaded.current = true;
      const linked = /^#intelligence\/run\/([0-9a-f]{10})$/.exec(window.location.hash)?.[1];
      const id = linked ?? m.busy ?? localStorage.getItem(JOB_KEY);
      if (id) getJob(id).then(j => { setJob(j); if (j.status !== "running" && (linked || !mountCmd.current)) setScreen("results"); }).catch(() => localStorage.removeItem(JOB_KEY));   // reopen the last run after a reload
    }).catch(e => setMetaError(e.message));
  }, []);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(() => {
      getJob(job.id).then(j => { setJob(j); if (j.status !== "running") { setScreen("results"); scrollTop(); } }).catch(e => setError(e.message));
    }, 1500);
    return () => clearInterval(t);
  }, [job?.id, job?.status]);

  useEffect(() => { setServerErrors({}); }, [form]);

  // sidebar commands
  const lastCmd = useRef<number | null>(null);
  useEffect(() => {
    if (!cmd || cmd.n === lastCmd.current) return;
    lastCmd.current = cmd.n;
    if (cmd.kind === "results") { if (job) setScreen("results"); }
    else if (cmd.kind === "new") { setForm(DEFAULT_FORM); setFromWords(null); setTpl(null); localStorage.removeItem(TPL_KEY); setBasis(null); setScreen("form"); setStep(0); setVisited(new Set([0])); }
    else if (cmd.kind === "template") {      // a template fills the Optimizer; start at step 1 so every number can be checked
      const t = cmd.t;
      setTpl(t); localStorage.setItem(TPL_KEY, t.key); setFromWords(null);
      setForm({ ...DEFAULT_FORM, start: t.form.start, co2: t.form.co2, rel: t.form.rel, staged: t.form.staged }); setBasis(null); setScreen("form");
      setStep(0); setVisited(new Set([0]));
    }
    else if (cmd.kind === "plain") {         // plain language read into the Optimizer: open the review so every answer can be checked
      setTpl(cmd.t); if (cmd.t) localStorage.setItem(TPL_KEY, cmd.t.key); else localStorage.removeItem(TPL_KEY);
      setFromWords(cmd.understood);
      setForm({ ...DEFAULT_FORM, ...cmd.patch }); setBasis(null); setScreen("form");
      setStep(STEPS.length - 1); setVisited(new Set(STEPS.map((_, i) => i)));
    }
    else { setScreen("form"); setStep(cmd.i); setVisited(v => new Set(v).add(cmd.i)); }
    scrollTop();
  }, [cmd?.n]);
  // what the sidebar shows: each step's state and the current run
  useEffect(() => {
    if (!meta) return;
    const errs = { ...serverErrors, ...validate(form, meta.resources) };
    const stepState = STEPS.map((s, i) => i === step && screen === "form" ? "current" : Object.keys(errs).some(k => s.owns(k)) && visited.has(i) ? "error" : visited.has(i) ? "done" : "");
    const r = job?.result;
    onNav({ screen: job?.status === "running" ? "running" : screen === "results" && job ? "results" : "form", step, stepState,
      job: job ? { id: job.id, tag: job.tag, status: job.status, ok: r?.status === "OK", infeasible: !!r && r.status !== "OK", alt: !!job.alternative, plots: (r?.plots ?? []).length > 0, staged: !!r?.staged } : null });
  }, [meta, form, step, visited, screen, job?.id, job?.status, serverErrors]);
  useEffect(() => {
    if (!loaded.current) return;
    history.replaceState(null, "", screen === "results" && job && job.status !== "running" ? `/#intelligence/run/${job.id}` : "/#intelligence");
  }, [screen, job?.id, job?.status]);

  if (metaError) {
    return <section className="section model-hero"><span className="tag orange">MODEL SERVER NOT CONNECTED</span>
      <h1 className="display">THE MODEL IS <em>NOT RUNNING.</em></h1>
      <p className="lede dark">{metaError}</p>
      <p className="footnote">This page shows no numbers of its own: every figure on it comes from the optimiser. Start the server and reload.</p></section>;
  }
  if (!meta) return <section className="section model-hero"><span className="tag">LOADING THE MODEL</span><h1 className="display">STARTING <em>UP…</em></h1></section>;

  const errs = { ...serverErrors, ...validate(form, meta.resources) };
  const stepErrs = STEPS.map(s => Object.entries(errs).filter(([k]) => s.owns(k)));
  const nErr = Object.keys(errs).length;
  const upd = (patch: Partial<Form>) => setForm(f => ({ ...f, ...patch }));
  const go = (i: number) => { setStep(i); setVisited(v => new Set(v).add(i)); scrollTop(); };

  const altOf = (inputs: RunInputs, b: Omit<AlternativeOf, "changes"> | null): AlternativeOf | undefined => {
    if (!b?.original) return undefined;
    const changes = diffInputs(b.original, inputs, meta);
    return changes.length ? { ...b, changes } : undefined;                       // identical to the original: it is the original problem
  };
  // the run an alternative is based on: the original run, also when starting from an alternative's own results
  const originOf = (j: Job, title?: string): Omit<AlternativeOf, "changes"> | null =>
    j.alternative?.original ? { ofJobId: j.alternative.ofJobId, ofTag: j.alternative.ofTag, title: title ?? j.alternative.title, original: j.alternative.original }
      : j.inputs ? { ofJobId: j.id, ofTag: j.tag, title, original: j.inputs } : null;
  /** plain: a run of exactly these inputs, not an alternative to an infeasible run (e.g. the same inputs with other stress events) */
  const run = (inputs?: RunInputs, title?: string, plain = false) => {
    if (!inputs && nErr) return;
    const body = inputs ?? toInputs(form);
    const b = plain ? null : inputs && job ? originOf(job, title) : basis;
    const alternative = altOf(body, b);
    setError(null); setSubmitting(true);
    const agents = { weights: tpl?.weights ?? { speed: 34, cost: 33, environment: 33 }, template: tpl?.title ?? null };
    startRun({ ...(alternative ? { ...body, alternative } : body), agents })
      .then(({ jobId }) => { localStorage.setItem(JOB_KEY, jobId); return getJob(jobId).then(j => { setJob(j); scrollTop(); }); })
      .catch((e: Error & { jobId?: string; errors?: Record<string, string> }) => {
        setError(e.message);
        if (e.errors) setServerErrors(e.errors);
        if (e.jobId) getJob(e.jobId).then(setJob).catch(() => {});
        if (inputs) { setForm(fromInputs(inputs)); setBasis(b); setScreen("form"); go(STEPS.length - 1); }   // an alternative that fails validation: show why on the review step
      })
      .finally(() => setSubmitting(false));
  };
  const useAlternative = (inputs: RunInputs, title?: string) => { setPriced(null); setBasis(job ? originOf(job, title) : null); setForm(fromInputs(inputs)); setScreen("form"); setVisited(new Set(STEPS.map((_, i) => i))); go(STEPS.length - 1); };
  const editInputs = () => { setPriced(null); if (job?.inputs) setForm(fromInputs(job.inputs)); setBasis(job?.alternative ? originOf(job) : null); setScreen("form"); setVisited(new Set(STEPS.map((_, i) => i))); go(STEPS.length - 1); };
  const newRun = () => { setPriced(null); setForm(DEFAULT_FORM); setBasis(null); setScreen("form"); setVisited(new Set([0])); go(0); };
  const openRun = (id: string) => { getJob(id).then(j => { setJob(j); setScreen("results"); scrollTop(); }).catch(e => setError(e.message)); };
  /** "Price it in the optimiser" from the agents' sections: the run's inputs with the change, on the review step. */
  const prefill = (p: Partial<ThesisInput> & { gridDelay?: number; landAcres?: number; resources?: Record<string, Partial<Record<"max_mw" | "available_month", number>>>; excluded?: string[] }) => {
    const base = job?.inputs ? fromInputs(job.inputs) : form;
    const next: Form = { ...base };
    if (p.fullTarget != null && Number(p.fullTarget) > 10) next.start = String(Number(p.fullTarget) - 10);
    if (p.gridDelay != null) next.gridDelay = String(p.gridDelay);
    if (p.gridAdderExtra != null) next.gridAdder = String(p.gridAdderExtra);
    if (p.landAcres != null) next.land = String(p.landAcres);
    if (p.resources) {
      const ov = { ...next.ov };
      for (const [rid, o] of Object.entries(p.resources)) ov[rid] = { ...ov[rid], ...Object.fromEntries(Object.entries(o).map(([k, x]) => [k, String(x)])) };
      next.ov = ov;
      const mins = { ...next.mins };                      // a minimum above the new maximum would fail validation: lower it to the cap
      for (const [rid, o] of Object.entries(p.resources)) if (o.max_mw != null && Number(mins[rid]) > o.max_mw) mins[rid] = String(o.max_mw);
      next.mins = mins;
    }
    if (p.excluded?.length) next.excluded = [...new Set([...next.excluded, ...p.excluded])];
    if (Number(p.capexUpliftPct) > 0) {                  // onsite equipment costs more: raise each onsite CAPEX
      const ov = { ...next.ov };
      for (const r of meta.resources) if (r.location !== "offsite") {
        const cur = Number(ov[r.id]?.capex_usd_per_kw ?? "") || r.capex_usd_per_kw;
        ov[r.id] = { ...ov[r.id], capex_usd_per_kw: String(Math.round(cur * (1 + Number(p.capexUpliftPct) / 100))) };
      }
      next.ov = ov;
    }
    setPriced({ from: toInputs(base), title: p.title });
    setForm(next); setBasis(null); setScreen("form"); setVisited(new Set(STEPS.map((_, i) => i))); go(STEPS.length - 1);
  };
  const pricedN = priced ? diffInputs(priced.from, toInputs(form), meta).length : 0;
  const restoreOriginal = () => { if (basis?.original) setForm(fromInputs(basis.original)); setBasis(null); };
  const editingAlt = basis?.original ? diffInputs(basis.original, toInputs(form), meta) : [];

  if (running && job) return <RunProgress job={job} meta={meta} />;
  if (screen === "results" && job) return <ResultsPage job={job} meta={meta} onEdit={editInputs} onNew={newRun} onUse={useAlternative} onRun={(inputs, title) => run(inputs, title)}
    onRunPlain={inputs => run(inputs, undefined, true)} onEditStress={() => { editInputs(); go(STEPS.findIndex(s => s.title === "Stress events")); }} onOpenRun={openRun} busy={submitting} onPrefill={prefill} tpl={tpl} />;

  const last = step === STEPS.length - 1;
  const here = stepErrs[step];
  return <div className="model-page">
    <div className={`progress ${submitting ? "on" : ""}`} />
    <section className="model-hero section gt-hero">
      <span className="tag orange">{tpl ? `TEMPLATE · ${tpl.title.toUpperCase()}` : "POWERLLEL OPTIMISER"}</span>
      <h1 className="display">MAKE POWER DECISIONS BASED ON <em>YOUR INPUTS.</em></h1>
      {fromWords && <p className="th-from-words"><b>Filled from your words:</b> {fromWords.join(" · ")}</p>}
      {tpl && !fromWords && <p className="gt-note top">Filled from the <b>{tpl.title}</b> template: {tpl.detail} Priority weights for the agents: speed {tpl.weights.speed} / cost {tpl.weights.cost} / carbon {tpl.weights.environment}. Change any number below.</p>}
      <p className="lede dark">Answer seven short steps. The optimiser sizes the cheapest portfolio that meets them, dispatches all 87,600 hours of the ten-year horizon, scores it with the packet's checker and draws the dashboards.</p>
      {job && job.status !== "running" && <button className="link gt-back-results" onClick={() => setScreen("results")}>← Back to the results of the last run</button>}
    </section>

    <section className="section gt-wizard">
      {basis && editingAlt.length > 0 && <AltBanner alt={{ ...basis, changes: editingAlt }} kind="editing" onOriginal={() => openRun(basis.ofJobId)} onRestore={restoreOriginal} />}
      <ol className="gt-stepper" aria-label="Steps">
        {STEPS.map((s, i) => {
          const state = i === step ? "current" : stepErrs[i].length && visited.has(i) ? "error" : visited.has(i) ? "done" : "";
          return <li key={s.title} className={state}><button onClick={() => go(i)} aria-current={i === step ? "step" : undefined}>
            <span className="n">{state === "done" ? "✓" : state === "error" ? "!" : i + 1}</span><span className="t">{s.title}</span></button></li>;
        })}
      </ol>

      <div className="card gt-panel">
        <div className="gt-panel-head"><span className="tag">STEP {step + 1} OF {STEPS.length}</span><h2 className="display">{STEPS[step].title}</h2><p>{STEPS[step].blurb}</p></div>
        {step === 0 && <StepCampus f={form} upd={upd} errs={errs} meta={meta} />}
        {step === 1 && <StepGrid f={form} upd={upd} errs={errs} meta={meta} />}
        {step === 2 && <StepReliability f={form} upd={upd} errs={errs} meta={meta} />}
        {step === 3 && <StepStress f={form} upd={upd} errs={errs} sm={stressMeta} smError={stressError} />}
        {step === 4 && <StepMarket f={form} upd={upd} errs={errs} />}
        {step === 5 && <StepResources f={form} upd={upd} errs={errs} meta={meta} />}
        {step === 6 && <>
          {priced && <p className="gt-chg-note"><span className="gt-chg-tag">changed</span> {pricedN ? <>Filled from <b>{priced.title ?? "Price it in the optimiser"}</b>: {pricedN} input{pricedN === 1 ? "" : "s"} differ from the run you came from, highlighted below with the value it had.</> : <>Filled from <b>{priced.title ?? "Price it in the optimiser"}</b>: no input differs from the run you came from.</>}
            <button className="link" onClick={() => { setForm(fromInputs(priced.from)); setPriced(null); }}>Undo the change</button></p>}
          <InputsSummary inputs={toInputs(form)} meta={meta} onEdit={go} errorSteps={stepErrs.map(x => x.length)} base={priced?.from} />
          {basis && editingAlt.length > 0 && <p className="gt-alt-note"><span className="gt-alttag">ALTERNATIVE</span> These inputs differ from your original run in {editingAlt.length} place{editingAlt.length === 1 ? "" : "s"} (listed at the top). The run will be saved and shown as an alternative.</p>}
          {nErr > 0 && <div className="gt-errlist light"><b>{nErr} input{nErr === 1 ? " needs" : "s need"} fixing before the run:</b><ul>{STEPS.map((s, i) => stepErrs[i].map(([k, m]) => <li key={k}>{m} <button className="link" onClick={() => go(i)}>Fix in “{s.title}”</button></li>))}</ul></div>}
          <p className="footnote">A run takes several minutes{form.staged ? ", longer year by year" : ""} (usually 1 to 5 minutes on this Mac). You will see its progress live; you can leave the page and come back.</p>
          {error && <p className="notice">{error}</p>}
        </>}
        {!last && here.length > 0 && <div className="gt-errs">{here.map(([k, m]) => <Err key={k} e={m} />)}</div>}

        <div className="gt-nav">
          <button className="outline dark-outline" disabled={step === 0} onClick={() => go(step - 1)}>← Back</button>
          {last
            ? <button className="primary gt-run-btn" disabled={submitting || nErr > 0} onClick={() => run()}>{submitting ? "Starting…" : basis && editingAlt.length ? "Run this alternative ↗" : "Run the optimiser ↗"}</button>
            : <button className="primary" disabled={here.length > 0} title={here.length ? "Fix the inputs on this step first" : undefined} onClick={() => go(step + 1)}>Next: {STEPS[step + 1].title} →</button>}
        </div>
      </div>
    </section>
  </div>;
}

type StepProps = { f: Form; upd: (p: Partial<Form>) => void; errs: Record<string, string>; meta: Meta };

function StepCampus({ f, upd, errs, meta }: StepProps) {
  const startN = Number(f.start), ok = !errs.start && !errs.calendarStart;
  return <div className="gt-fields gt-grid3">
    <label className="gt-field"><b>Peak load of the campus</b><small className="hint">MW, {meta.limits.peak[0]}–{meta.limits.peak[1]} · packet 75. Scales the packet's demand shape, tier shares, land and remote site.</small>
      <span className="gt-input"><input className={errs.peakMw ? "invalid" : ""} inputMode="decimal" value={f.peak} onChange={e => upd({ peak: e.target.value })} /><em>MW</em></span><Err e={errs.peakMw} /></label>
    <label className="gt-field"><b>Calendar date of development month 0</b><small className="hint">Format <b>YYYY-MM</b>: 4-digit year, dash, 2-digit month 01–12, e.g. <b>2027-01</b> for January 2027. Optional, only used to label months with dates.</small>
      <span className="gt-input"><input className={errs.calendarStart ? "invalid" : ""} placeholder="YYYY-MM, e.g. 2027-01" maxLength={7} value={f.cal} onChange={e => upd({ cal: e.target.value })} />{f.cal && <button className="link" onClick={e => { e.preventDefault(); upd({ cal: "" }); }}>Clear</button>}</span><Err e={errs.calendarStart} /></label>
    <label className="gt-field"><b>Opening month (initial service)</b><small className="hint">Whole number, {meta.limits.start[0]}–{meta.limits.start[1]}. Full demand is reached ten months later{ok ? `: ${monthLabel(startN + 10, f.cal)}${f.cal ? `, opening ${monthLabel(startN, f.cal)}` : ""}` : ""}.</small>
      <span className="gt-input"><input className={errs.start ? "invalid" : ""} inputMode="numeric" value={f.start} onChange={e => upd({ start: e.target.value })} /><em>month</em></span><Err e={errs.start} /></label>
    <label className="gt-field"><b>Onsite land for equipment</b><small className="hint">Acres for gas units and batteries · optional · empty = packet, 8 acres × peak / 75 ({fmt(8 * (Number(f.peak) || 75) / 75, 1)} acres). A proposed site's land can be priced from the results.</small>
      <span className="gt-input"><input className={errs.landAcres ? "invalid" : ""} inputMode="decimal" placeholder={fmt(8 * (Number(f.peak) || 75) / 75, 1)} value={f.land} onChange={e => upd({ land: e.target.value })} /><em>acres</em></span><Err e={errs.landAcres} /></label>
  </div>;
}

function StepGrid({ f, upd, errs, meta }: StepProps) {
  const rows = stepRowsOf(f), peakN = Number(f.peak) || 0;
  const months = Array.from({ length: 7 }, (_, j) => 18 + j);
  const opt = (m: number) => <option key={m} value={m}>{m}{DATE_RE.test(f.cal) ? ` · ${monthLabel(m, f.cal)}` : ""}</option>;
  const setRows = (r: { month: number; mw: string }[]) => upd({ steps: r });
  return <div className="gt-card">
    <p className="gt-note top">Every step must fall between month {meta.limits.interconnection[0]} and {meta.limits.interconnection[1]}, one step per month, 0–2000 MW. If the final import is below the peak, onsite generation covers the gap.</p>
    <div className="segment gt-seg">{([["steps", "Steps (month : MW)"], ["month", "One month, full import"], ["packet", "Packet schedule"]] as const).map(([k, t]) => <button key={k} className={f.icMode === k ? "on" : ""} onClick={() => upd({ icMode: k })}>{t}</button>)}</div>
    {f.icMode === "steps" && <div className="gt-steps">
      {rows.map((s, i) => <div className="gt-step" key={i}>
        <label>From month<select className={errs[`step.${i}.month`] ? "invalid" : ""} value={s.month} onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, month: +e.target.value } : x)))}>{months.map(opt)}</select><Err e={errs[`step.${i}.month`]} /></label>
        <label>Import<span className="gt-input"><input className={errs[`step.${i}.mw`] ? "invalid" : ""} inputMode="decimal" value={s.mw} onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, mw: e.target.value } : x)))} /><em>MW</em></span><Err e={errs[`step.${i}.mw`]} /></label>
        {rows.length > 1 && <button className="link" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>}
      </div>)}
      <div className="gt-row">{rows.length < 7 && <button className="outline small" onClick={() => { const used = new Set(rows.map(s => s.month)); setRows([...rows, { month: months.find(m => !used.has(m)) ?? 24, mw: String(peakN) }]); }}>Add a step</button>}
        {f.steps && <button className="link" onClick={() => upd({ steps: null })}>Reset to half the peak at 18, full at 24</button>}</div>
    </div>}
    {f.icMode === "month" && <div className="gt-steps"><label>Full import ({fmt(peakN)} MW) from month<select value={f.icMonth} onChange={e => upd({ icMonth: +e.target.value })}>{months.map(opt)}</select></label></div>}
    {f.icMode === "packet" && !errs.interconnection && <p className="gt-note">The packet's utility schedule: {meta.packetSchedule.map(s => `${s.mw} MW from month ${s.month}`).join(", ")}.</p>}
    <Err e={errs.interconnection} />
    <div className="gt-fields gt-grid3 gt-after"><label className="gt-field"><b>What if the grid connection is late?</b><small className="hint">Months every step above slips · optional, 0–36 · empty = on time. Onsite generation covers the gap.</small>
      <span className="gt-input"><input className={errs.gridDelay ? "invalid" : ""} inputMode="numeric" placeholder="0" value={f.gridDelay} onChange={e => upd({ gridDelay: e.target.value })} /><em>months</em></span><Err e={errs.gridDelay} /></label></div>
  </div>;
}

function StepReliability({ f, upd, errs, meta }: StepProps) {
  return <>
    <p className="gt-note top">Reliability standards are cumulative: each adds a rule on top of the one before.</p>
    <div className="gt-rel">{meta.reliability.map(r => <button key={r.key} className={`preset ${f.rel === r.key ? "selected" : ""}`} onClick={() => upd({ rel: r.key })}><span>{r.key}</span><small>{r.text}</small></button>)}</div>
    <Err e={errs.reliability} />
    <div className="gt-fields gt-grid3 gt-after">
      <label className="gt-field"><b>Carbon ceiling</b><small className="hint">Optional · a hard limit on combined kg CO₂ per MWh over the horizon, greater than 0 · empty = no ceiling</small>
        <span className="gt-input"><input className={errs.co2Cap ? "invalid" : ""} inputMode="decimal" placeholder="no ceiling" value={f.co2} onChange={e => upd({ co2: e.target.value })} /><em>kg/MWh</em></span><Err e={errs.co2Cap} /></label>
    </div>
  </>;
}

function StepStress({ f, upd, errs, sm, smError }: Omit<StepProps, "meta"> & { sm: StressMeta | null; smError: string | null }) {
  const s = f.stress;
  const [pick, setPick] = useState("");
  const [scale, setScale] = useState("2");
  const [allImp, setAllImp] = useState("0");
  const [upload, setUpload] = useState<{ busy: boolean; problems: string[] }>({ busy: false, problems: [] });
  const setS = (patch: Partial<StressForm>) => upd({ stress: { ...s, ...patch } });
  const edited = (src: string) => (!src || src.endsWith("(edited)") ? src || "your events" : `${src} (edited)`);
  const setRows = (rows: StressRow[], source = edited(s.source)) => setS({ rows, source });
  const setRow = (i: number, patch: Partial<StressRow>) => setRows(s.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const load = (rows: StressRow[], source: string) => {
    if (s.rows.length && !window.confirm(`Replace your ${s.rows.length} event${s.rows.length === 1 ? "" : "s"} with ${source}?`)) return;
    setS({ mode: "custom", rows, source });
  };
  const loadPick = (v: string) => {
    setPick("");
    if (!sm || !v) return;
    if (v === "packet") return load(sm.packet.map(fromCatalog), "Packet events");
    const [kind, name] = v.split(":", 2);
    const area = kind === "state" ? sm.states.find(x => x.state === name)?.area : name;
    const a = sm.areas.find(x => x.area === area);
    if (a) load(a.events.map(fromCatalog), kind === "state" ? `${name} (${a.area})` : a.area);
  };
  const onFile = (file?: File) => {
    if (!file) return;
    setUpload({ busy: true, problems: [] });
    parseStressFile(file).then(r => {
      setUpload({ busy: false, problems: r.problems });
      if (r.rows.length) load(r.rows.map(fromCatalog), file.name);
    }).catch(e => setUpload({ busy: false, problems: [e.message] }));
  };
  const download = () => {
    const lines = ["id,start,hours,import_pct,notice_min,included", ...s.rows.map(r => [r.id.replace(/,/g, " "), r.start.replace("T", " "), r.hours, r.importPct, r.noticeMin, r.include ? "yes" : "no"].join(","))];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
    a.download = "stress_events.csv"; a.click(); URL.revokeObjectURL(a.href);
  };
  const st = stressStats(s.rows);
  const incIndex = (() => { let k = -1; return s.rows.map(r => (r.include ? ++k : -1)); })();     // row -> index among ticked rows (the error keys)
  const rowErr = (i: number, field: string) => (incIndex[i] >= 0 ? errs[`stress.${incIndex[i]}.${field}`] : undefined);
  const cls = (i: number, field: string) => (rowErr(i, field) ? "invalid" : "");
  const notice = sm?.relocationNoticeMin ?? 30;

  return <div className="gt-card">
    <p className="gt-note top">During a stress event the grid lets the campus import only part of its connection. Tier 1 load can move to the remote site if the event comes with at least {notice} minutes' notice; Tier 2 load can be interrupted. Onsite gas has to cover the rest, so longer, deeper or more frequent events change the portfolio.</p>
    <div className="segment gt-seg">
      <button className={s.mode === "packet" ? "on" : ""} onClick={() => setS({ mode: "packet" })}>Packet events</button>
      <button className={s.mode === "custom" ? "on" : ""} onClick={() => { if (!s.rows.length && sm) setS({ mode: "custom", rows: sm.packet.map(fromCatalog), source: "Packet events" }); else setS({ mode: "custom" }); }}>Your own events</button>
    </div>
    {smError && <p className="notice">Could not load the stress-event catalog: {smError}</p>}

    {s.mode === "packet" && sm && <>
      <p className="gt-note">The packet's seven ERCOT conservation windows of August–September 2023: 32 hours a year with imports cut to 60% and 30 minutes' notice. They repeat in every model year.</p>
      <StressTable rows={sm.packet.map(fromCatalog)} readOnly />
    </>}

    {s.mode === "custom" && <>
      <div className="gt-stress-tools">
        <label>Start from<select value={pick} onChange={e => loadPick(e.target.value)} disabled={!sm}>
          <option value="">choose…</option>
          <option value="packet">The packet's 7 ERCOT events</option>
          <optgroup label="2023 events by interconnection">{sm?.areas.map(a => <option key={a.area} value={`area:${a.area}`}>{a.area} · {a.events.length} events ({a.operators.join(", ")})</option>)}</optgroup>
          <optgroup label="2023 events by state">{sm?.states.map(x => <option key={x.state} value={`state:${x.state}`}>{x.state} → {x.area}</option>)}</optgroup>
        </select></label>
        <label className="outline small gt-upload">{upload.busy ? "Reading…" : "Upload CSV"}<input type="file" accept=".csv,.xlsx,text/csv" onChange={e => { onFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
        {s.rows.length > 0 && <button className="outline small" onClick={download}>Download CSV</button>}
        <button className="outline small" onClick={() => setRows([...s.rows, { id: `event_${s.rows.length + 1}`, start: "2023-08-15T15:00", hours: "4", importPct: "60", noticeMin: "30", include: true }])}>Add an event</button>
        {s.rows.length > 0 && <button className="link" onClick={() => { if (window.confirm("Remove every event? The run will then have no stress events.")) setRows([], "no events"); }}>Clear all</button>}
      </div>
      {upload.problems.length > 0 && <div className="gt-errlist light"><b>From the file:</b><ul>{upload.problems.map(p => <li key={p}>{p}</li>)}</ul></div>}
      {s.rows.length > 0 && <div className="gt-stress-tools gt-what-if">
        <span>What if, for the ticked events:</span>
        <label>durations ×<input inputMode="decimal" value={scale} onChange={e => setScale(e.target.value)} /></label>
        <button className="outline small" disabled={!(Number(scale) > 0)} onClick={() => setRows(s.rows.map(r => (r.include && Number(r.hours) > 0 ? { ...r, hours: String(Math.round(Number(r.hours) * Number(scale) * 100) / 100) } : r)))}>Apply</button>
        <label>import allowed<input inputMode="decimal" value={allImp} onChange={e => setAllImp(e.target.value)} />%</label>
        <button className="outline small" disabled={allImp.trim() === "" || !(Number(allImp) >= 0 && Number(allImp) <= 100)} onClick={() => setRows(s.rows.map(r => (r.include ? { ...r, importPct: allImp.trim() } : r)))}>Apply</button>
        <button className="outline small" onClick={() => setRows(s.rows.map(r => (r.include ? { ...r, noticeMin: "0" } : r)))}>No notice</button>
      </div>}
      {s.rows.length === 0
        ? <p className="gt-note">No events: the grid connection is never limited. Use “Start from”, upload a CSV, or add events one by one.</p>
        : <StressTable rows={s.rows} setRow={setRow} remove={i => setRows(s.rows.filter((_, j) => j !== i))} cls={cls} rowErr={rowErr} />}
      <p className={`gt-stress-sum ${errs.stressEvents ? "bad" : ""}`}><b>{st.events}</b> event{st.events === 1 ? "" : "s"} ticked · <b>{st.hours}</b> stress hours a year (limit {STRESS_LIMITS.totalHours}){st.minImp != null ? <> · imports down to <b>{st.minImp}%</b></> : null} · source: {s.source || "your events"}</p>
      <Err e={errs.stressEvents} />
      <p className="footnote">Times are {sm?.timezone ?? "US Central time"}, in 2023, the model's reference year; every event repeats in each of the ten model years. An hour counts as a stress hour if an event covers any part of it; where events overlap, the lower import and the shorter notice apply. Upload a CSV with columns <b>start, hours, import_pct, notice_min</b> (start like 2023-08-24 15:00) or the catalog's <b>start_utc, end_utc, import_fraction</b>. Catalog events start from their source: {sm?.source ?? "team_app/stress_data/"}. Their dates come from grid-operator notices, but the import cut (60%) is the packet's assumption, not observed. Low-confidence timings and CAISO Restricted Maintenance notices start unticked.</p>
    </>}
  </div>;
}

function StressTable({ rows, readOnly, setRow, remove, cls, rowErr }: { rows: StressRow[]; readOnly?: boolean; setRow?: (i: number, p: Partial<StressRow>) => void; remove?: (i: number) => void; cls?: (i: number, f: string) => string; rowErr?: (i: number, f: string) => string | undefined }) {
  const fields: [keyof StressRow, string, string][] = [["hours", "Hours", "decimal"], ["importPct", "Import allowed %", "decimal"], ["noticeMin", "Notice min", "numeric"]];
  return <div className="table-scroll"><table className="year-table gt-res gt-stress">
    <thead><tr>{!readOnly && <th>Use</th>}<th>Event</th><th>Start (2023)</th>{fields.map(([, t]) => <th key={t}>{t}</th>)}<th>Source</th>{!readOnly && <th />}</tr></thead>
    <tbody>{rows.map((r, i) => {
      const errsHere = rowErr ? ["start", "hours", "importPct", "noticeMin"].map(k => rowErr(i, k)).filter(Boolean) : [];
      return <tr key={i} className={r.include ? "" : "off"}>
        {!readOnly && <td><input type="checkbox" checked={r.include} onChange={e => setRow!(i, { include: e.target.checked })} aria-label={`Use ${r.id}`} /></td>}
        <td>{readOnly ? r.id : <input className="gt-id" value={r.id} onChange={e => setRow!(i, { id: e.target.value })} />}{errsHere.map(m => <small key={m} className="gt-err">{m}</small>)}</td>
        <td>{readOnly ? whenLabel(r.start) : <input type="datetime-local" className={cls!(i, "start")} title={rowErr!(i, "start")} min="2023-01-01T00:00" max="2023-12-31T23:59" value={r.start} onChange={e => setRow!(i, { start: e.target.value })} />}</td>
        {fields.map(([k, , mode]) => <td key={k}>{readOnly ? String(r[k]) : <input className={cls!(i, k)} title={rowErr!(i, k)} inputMode={mode as "decimal" | "numeric"} value={String(r[k] ?? "")} onChange={e => setRow!(i, { [k]: e.target.value })} />}</td>)}
        <td className="note" title={r.notes}>{[r.operator, r.type, r.confidence ? `${r.confidence} confidence` : ""].filter(Boolean).join(" · ") || "–"}</td>
        {!readOnly && <td><button className="link" onClick={() => remove!(i)}>Remove</button></td>}
      </tr>;
    })}</tbody></table></div>;
}

function StepMarket({ f, upd, errs }: Omit<StepProps, "meta">) {
  return <div className="gt-fields gt-grid3">
    <label className="gt-field"><b>Merchant wholesale price growth</b><small className="hint">% a year, real, −20 to 30 · packet +5%</small><span className="gt-input"><input className={errs.wholesaleGrowth ? "invalid" : ""} inputMode="decimal" value={f.wg} onChange={e => upd({ wg: e.target.value })} /><em>%/yr</em></span><Err e={errs.wholesaleGrowth} /></label>
    <label className="gt-field"><b>Henry Hub gas price growth</b><small className="hint">% a year, real, −20 to 30 · packet +3%</small><span className="gt-input"><input className={errs.gasGrowth ? "invalid" : ""} inputMode="decimal" value={f.gg} onChange={e => upd({ gg: e.target.value })} /><em>%/yr</em></span><Err e={errs.gasGrowth} /></label>
    <div className="gt-field"><b>Investment approach</b><small className="hint">Upfront: all capacity chosen at once (packet rule). Year by year: capacity can be added each year, never removed, paid from the year it is added.</small>
      <div className="segment gt-seg"><button className={!f.staged ? "on" : ""} onClick={() => upd({ staged: false })}>Upfront</button><button className={f.staged ? "on" : ""} onClick={() => upd({ staged: true })}>Year by year</button></div><Err e={errs.staged} /></div>
    <label className="gt-field"><b>Extra grid cost</b><small className="hint">$/MWh added to every MWh bought from the grid, e.g. new large-load charges · optional · empty = packet</small><span className="gt-input"><input className={errs.gridAdderExtra ? "invalid" : ""} inputMode="decimal" placeholder="0" value={f.gridAdder} onChange={e => upd({ gridAdder: e.target.value })} /><em>$/MWh</em></span><Err e={errs.gridAdderExtra} /></label>
  </div>;
}

function StepResources({ f, upd, errs, meta }: StepProps) {
  const peakN = Number(f.peak) || 0;
  const def = (r: Resource, k: Editable) => (k === "max_mw" ? scaledMax(r, peakN) : r[k]);
  const setField = (rid: string, k: Editable, v: string) => upd({ ov: { ...f.ov, [rid]: { ...f.ov[rid], [k]: v } } });
  const off = f.excluded;
  const toggle = (rid: string) => upd({ excluded: off.includes(rid) ? off.filter(x => x !== rid) : [...off, rid] });
  return <div className="gt-res-table">
    <div className="gt-head"><p className="gt-note top">Blank cells keep the packet value (shown in grey); maxima scale with the peak. Contracts (offsite) have a price only. A minimum forces a resource into the portfolio. Everything here is optional.</p>
      {(Object.keys(f.ov).length > 0 || Object.keys(f.mins).length > 0) && <button className="link" onClick={() => upd({ ov: {}, mins: {} })}>Reset all to the packet</button>}</div>
    <div className="table-scroll"><table className="year-table gt-res"><thead><tr><th>Resource</th>{FIELDS.map(([, t]) => <th key={t}>{t}</th>)}<th>Minimum MW</th></tr></thead>
      <tbody>{meta.resources.map(r => { const isOff = off.includes(r.id); return <tr key={r.id} className={isOff ? "off gt-res-off" : ""}><td><button type="button" className={`gt-rt ${isOff ? "off" : "on"}`} aria-pressed={!isOff} title={isOff ? "Click to make it available again" : "Click to switch it off"} onClick={() => toggle(r.id)}>{isOff ? "OFF" : "AVAILABLE"}</button><span className="gt-res-name"><span className="swatch" style={{ background: r.color }} />{r.label}</span><small className="detail">{isOff ? "not available · the optimiser cannot build it" : `${r.location} · blocks of ${fmt(r.block_mw)} MW`}</small></td>
        {FIELDS.map(([k, , onsiteOnly]) => {
          if (onsiteOnly && r.location === "offsite") return <td key={k} className="note">–</td>;
          if (isOff) return <td key={k} className="note">{k === "max_mw" ? "0" : "–"}</td>;
          const v = f.ov[r.id]?.[k], key = `res.${r.id}.${k}`;
          const edited = v != null && v.trim() !== "" && Number(v) !== def(r, k);
          return <td key={k}><input className={errs[key] ? "invalid" : edited ? "edited" : ""} title={errs[key]} inputMode={k === "available_month" ? "numeric" : "decimal"} placeholder={String(def(r, k))} value={v ?? ""} onChange={e => setField(r.id, k, e.target.value)} /></td>;
        })}
        <td>{isOff ? <span className="note">0</span> : <input className={errs[`min.${r.id}`] ? "invalid" : Number(f.mins[r.id]) > 0 ? "edited" : ""} title={errs[`min.${r.id}`]} inputMode="decimal" placeholder="0" value={f.mins[r.id] ?? ""} onChange={e => upd({ mins: { ...f.mins, [r.id]: e.target.value } })} />}</td></tr>; })}</tbody></table></div>
    <p className="footnote">Every value must be a number ≥ 0. Available month: whole number 0–{HORIZON_LAST_MONTH}; the resource serves from the later of this month and the opening month. Maximum MW: at least one block, rounded down to whole blocks. Minimum MW: not above the resource's maximum.</p>
    </div>;
}

/** The inputs of a run in plain words: on the review step (with Edit links) and next to the results. */
/** The inputs of a run in plain words; with `base`, every row whose words differ from base is highlighted with the old value. */
function InputsSummary({ inputs, meta, onEdit, errorSteps, base }: { inputs: RunInputs; meta: Meta; onEdit?: (step: number) => void; errorSteps?: number[]; base?: RunInputs | null }) {
  const groups = summaryGroups(inputs, meta);
  const was = base ? new Map(summaryGroups(base, meta).flatMap(([t, rows]) => rows.map(([k, v]) => [`${t}|${k}`, v] as [string, string]))) : null;
  return <div className={`gt-summary ${onEdit ? "" : "compact"}`}>{groups.map(([title, rows], gi) => {
    const changed = was ? rows.filter(([k, v]) => was.has(`${title}|${k}`) ? was.get(`${title}|${k}`) !== v : true).map(([k]) => k) : [];
    return <div className={`gt-sum-group ${errorSteps?.[gi] ? "has-err" : ""} ${changed.length ? "has-chg" : ""}`} key={title}>
      <div className="gt-sum-head"><b>{title}</b>{changed.length > 0 && <span className="gt-chg-tag">changed</span>}{onEdit && <button className="link" onClick={() => onEdit(gi)}>{errorSteps?.[gi] ? `Fix (${errorSteps[gi]})` : "Edit"}</button>}</div>
      <dl>{rows.map(([k, v]) => { const c = changed.includes(k), old = was?.get(`${title}|${k}`);
        return <div key={k} className={c ? "chg" : ""}><dt>{k}</dt><dd>{v}{c && old != null && <small className="gt-was">was: {old}</small>}</dd></div>; })}</dl></div>;
  })}</div>;
}

function summaryGroups(i: RunInputs, meta: Meta): [string, [string, string][]][] {
  const cal = i.calendarStart ?? "";
  const start = Number(i.start), peak = Number(i.peakMw);
  const ic = i.interconnection;
  const rel = meta.reliability.find(r => r.key === i.reliability);
  const changes = meta.resources.flatMap(r => FIELDS.filter(([k]) => i.resources?.[r.id]?.[k] != null).map(([k, label]) => {
    const def = k === "max_mw" ? scaledMax(r, peak) : r[k];
    return `${r.short}: ${label} ${i.resources[r.id][k]} (packet ${fmt(def, k === "available_month" ? 0 : 2).replace(/\.00$/, "")})`;
  }));
  const mins = Object.entries(i.minCaps ?? {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${meta.resources.find(r => r.id === k)?.short ?? k} ≥ ${v} MW`);
  const groups: [string, [string, string][]][] = [
    [STEPS[0].title, [["Peak load", `${i.peakMw} MW`], ["Onsite land", i.landAcres ? `${i.landAcres} acres (your input)` : `${fmt(8 * peak / 75, 1)} acres (packet)`], ["Month 0", cal || "not set (months shown as numbers)"], ["Opening", `month ${i.start}${cal ? ` · ${monthLabel(start, cal)}` : ""}`], ["Full demand", `month ${start + 10}${cal ? ` · ${monthLabel(start + 10, cal)}` : ""}`]]],
    [STEPS[1].title, [["Schedule", ic.mode === "packet" ? `Packet: ${meta.packetSchedule.map(s => `${s.mw} MW from m${s.month}`).join(", ")}` : ic.mode === "month" ? `Full ${i.peakMw} MW from month ${ic.month}` : ic.steps.map(s => `${s.mw} MW from m${s.month}`).join(", ")], ["Grid slip", i.gridDelay ? `${i.gridDelay} months late` : "on time"]]],
    [STEPS[2].title, [["Reliability", `${i.reliability}: ${rel?.text ?? ""}`], ["Carbon ceiling", i.co2Cap == null ? "none" : `${i.co2Cap} kg CO₂/MWh`]]],
    [STEPS[3].title, stressSummaryRows(i.stressEvents)],
    [STEPS[4].title, [["Wholesale growth", `${fmt(i.wholesaleGrowth * 100, 1).replace(/\.0$/, "")}% a year`], ["Gas growth", `${fmt(i.gasGrowth * 100, 1).replace(/\.0$/, "")}% a year`], ["Build", i.staged ? "Year by year" : "Upfront"], ["Extra grid cost", i.gridAdderExtra ? `+$${i.gridAdderExtra}/MWh` : "none"]]],
    [STEPS[5].title, [["Not available", (i.excluded ?? []).length ? (i.excluded ?? []).map(k => meta.resources.find(r => r.id === k)?.label ?? k).join(", ") : "none: every resource can be built"], ["Catalogue", changes.length ? changes.join(" · ") : "packet values, no changes"], ["Minimums", mins.length ? mins.join(", ") : "none"]]],
  ];
  return groups;
}

const stressText = (s?: StressInput) => !s || s.mode === "packet" ? "packet events (7 ERCOT, 2023)" : s.events.length ? `${s.source}: ${s.events.length} event${s.events.length === 1 ? "" : "s"}` : "no stress events";

function stressSummaryRows(s?: StressInput): [string, string][] {
  if (!s || s.mode === "packet") return [["Events", "Packet: 7 ERCOT events of 2023, 32 hours a year, imports cut to 60%"]];
  const st = stressStats(s.events);
  const list = s.events.slice(0, 6).map(r => `${whenLabel(r.start)}, ${r.hours} h at ${r.importPct}%`).join(" · ") + (s.events.length > 6 ? ` · and ${s.events.length - 6} more` : "");
  return [["Events", stressText(s)], ["Stress hours", s.events.length ? `about ${st.hours} a year${st.minImp != null ? `, imports down to ${st.minImp}%` : ""}` : "none: the grid is never limited"], ...(s.events.length ? [["When", list] as [string, string]] : [])];
}

/** What differs between the original inputs and an alternative, in plain words ("Opening month: 14 → 15"). */
function diffInputs(a: RunInputs, b: RunInputs, meta: Meta): string[] {
  const out: string[] = [];
  const same = (x: unknown, y: unknown) => {
    const nx = Number(x), ny = Number(y);
    return x === y || (String(x ?? "").trim() === String(y ?? "").trim()) || (String(x ?? "").trim() !== "" && String(y ?? "").trim() !== "" && Number.isFinite(nx) && nx === ny);
  };
  const ic = (i: RunInputs) => i.interconnection.mode === "packet" ? "packet schedule" : i.interconnection.mode === "month" ? `full import from month ${i.interconnection.month}` : i.interconnection.steps.map(s => `${s.mw} MW from month ${s.month}`).join(", ");
  const pctTxt = (v: number) => `${fmt(v * 100, 1).replace(/\.0$/, "")}%`;
  if (!same(a.peakMw, b.peakMw)) out.push(`Peak load: ${a.peakMw} → ${b.peakMw} MW`);
  if (!same(a.calendarStart ?? "", b.calendarStart ?? "")) out.push(`Calendar month 0: ${a.calendarStart || "not set"} → ${b.calendarStart || "not set"}`);
  if (!same(a.start, b.start)) out.push(`Opening month: ${a.start} → ${b.start}`);
  if (ic(a) !== ic(b)) out.push(`Interconnection: ${ic(a)} → ${ic(b)}`);
  if (a.reliability !== b.reliability) out.push(`Reliability: ${a.reliability} → ${b.reliability}`);
  if (!same(a.co2Cap ?? "", b.co2Cap ?? "")) out.push(`Carbon ceiling: ${a.co2Cap ?? "none"} → ${b.co2Cap ?? "none"}${b.co2Cap != null ? " kg/MWh" : ""}`);
  if (!same(a.wholesaleGrowth, b.wholesaleGrowth)) out.push(`Wholesale price growth: ${pctTxt(a.wholesaleGrowth)} → ${pctTxt(b.wholesaleGrowth)} a year`);
  if (!same(a.gasGrowth, b.gasGrowth)) out.push(`Gas price growth: ${pctTxt(a.gasGrowth)} → ${pctTxt(b.gasGrowth)} a year`);
  if (a.staged !== b.staged) out.push(`Build: ${a.staged ? "year by year" : "upfront"} → ${b.staged ? "year by year" : "upfront"}`);
  const evKey = (s?: StressInput) => JSON.stringify(!s || s.mode === "packet" ? "packet" : s.events.map(r => [r.start, Number(r.hours), Number(r.importPct), Number(r.noticeMin)]));
  if (evKey(a.stressEvents) !== evKey(b.stressEvents)) out.push(`Stress events: ${stressText(a.stressEvents)} → ${stressText(b.stressEvents)}`);
  const exTxt = (x?: string[]) => (x ?? []).length ? [...(x ?? [])].sort().map(k => meta.resources.find(r => r.id === k)?.short ?? k).join(", ") : "none";
  if (exTxt(a.excluded) !== exTxt(b.excluded)) out.push(`Not available: ${exTxt(a.excluded)} → ${exTxt(b.excluded)}`);
  if ((a.gridDelay ?? 0) !== (b.gridDelay ?? 0)) out.push(`Grid slip: ${a.gridDelay ?? 0} → ${b.gridDelay ?? 0} months`);
  if ((a.gridAdderExtra ?? 0) !== (b.gridAdderExtra ?? 0)) out.push(`Extra grid cost: $${a.gridAdderExtra ?? 0} → $${b.gridAdderExtra ?? 0}/MWh`);
  if (!same(a.landAcres ?? "", b.landAcres ?? "")) out.push(`Onsite land: ${a.landAcres || "packet"} → ${b.landAcres || "packet"}${b.landAcres ? " acres" : ""}`);
  for (const r of meta.resources) for (const [k, label] of FIELDS) {
    const x = a.resources?.[r.id]?.[k], y = b.resources?.[r.id]?.[k];
    if (!same(x ?? "", y ?? "")) out.push(`${r.short}, ${label}: ${x ?? "packet"} → ${y ?? "packet"}`);
  }
  for (const r of meta.resources) {
    const x = Number(a.minCaps?.[r.id] ?? 0) || 0, y = Number(b.minCaps?.[r.id] ?? 0) || 0;
    if (x !== y) out.push(`${r.short}, minimum MW: ${x || "none"} → ${y || "none"}`);
  }
  return out;
}

/** The banner on every page that shows an alternative: it is not the problem the user asked to solve. */
function AltBanner({ alt, kind, onOriginal, onRestore }: { alt: { ofTag: string; ofJobId: string; title?: string; changes: string[] }; kind: "results" | "running" | "editing"; onOriginal?: () => void; onRestore?: () => void }) {
  const head = kind === "results" ? "These are the results of an ALTERNATIVE, not of your inputs." : kind === "running" ? "You are optimising an ALTERNATIVE, not your inputs." : "You are editing an ALTERNATIVE, not your original inputs.";
  return <div className="gt-altbanner" role="note"><span className="gt-alttag">ALTERNATIVE</span>
    <div><b>{head}</b>
      <p>Your original inputs (run {alt.ofTag || alt.ofJobId}) have no feasible portfolio; that does not change. {kind === "editing" ? "Running from here solves this changed problem." : "This run solves a different, nearby problem"}{alt.title ? `: “${alt.title}”` : ""}. Changed from your original inputs:</p>
      <ul>{alt.changes.length ? alt.changes.map(c => <li key={c}>{c}</li>) : <li>nothing: these are your original inputs</li>}</ul>
      <div className="gt-alt-actions">{onOriginal && <button className="outline dark-outline small" onClick={onOriginal}>← Back to my original run</button>}{onRestore && <button className="outline dark-outline small" onClick={onRestore}>Restore my original inputs</button>}</div></div></div>;
}

// ------------------------------------------------------------------------------------------------ live progress while the optimiser runs
const PHASES: { key: string; title: string; detail: string }[] = [
  { key: "prepare", title: "Prepare the inputs", detail: "hourly profiles for your campus, and representative days for every month" },
  { key: "size", title: "Size the portfolio", detail: "mixed-integer optimisation on the representative days, in three steps: how many MW of each resource" },
  { key: "dispatch", title: "Dispatch every hour", detail: "all 87,600 hours with the chosen capacity, one model year at a time" },
  { key: "score", title: "Score and save", detail: "cost, carbon and the physical checks; portfolio.json and dispatch.csv" },
  { key: "plots", title: "Draw the dashboards", detail: "the optimiser's two figures" },
];

const SIZING_STEPS: { key: SizingStep["step"]; title: string; detail: string }[] = [
  { key: "relax", title: "Relaxed problem", detail: "blocks allowed to be fractional: its cost is a lower bound for every portfolio" },
  { key: "restrict", title: "Whole blocks nearby", detail: "an integer search within 2 blocks of the relaxed solution" },
  { key: "polish", title: "Full search", detail: "every portfolio, starting from the best one so far (up to 2 minutes)" },
];
const TWO_STEP = "Two-step: best found, not proven optimal";
const sizingNote = (st?: string | null) => st === "Optimal" ? "proven within 0.5% of the cheapest" : st === TWO_STEP ? "best found; not proven within 0.5%" : st === "Time limit reached" ? "solver time limit: may not be optimal" : st ?? "";

/** The three sizing solves: which are done, which is running, and what each found. */
function SizingSteps({ steps, stage, running }: { steps: SizingStep[]; stage?: string | null; running: boolean }) {
  return <ol className="gt-sizing-steps">{SIZING_STEPS.map((s, i) => {
    const done = steps.find(x => x.step === s.key);
    const active = running && !done && stage === s.key;
    return <li key={s.key} className={done ? "done" : active ? "active" : ""}><span className="gt-dot">{done ? "✓" : active ? <i className="spin" /> : i + 1}</span>
      <div><b>{s.title}</b><small>{s.detail}</small>
        {done && <small className="gt-step-out">{done.objective == null ? done.status : `${usdM(done.objective, 2)} · ${done.status}`} · {clock(done.seconds)}</small>}</div></li>;
  })}</ol>;
}

const DIAGNOSE_PHASE = { key: "diagnose", title: "Find the reasons and alternatives", detail: "no portfolio meets these inputs: checking which rule fails and which nearby inputs work" };

function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!on) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [on]);
  return now;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function RunProgress({ job, meta }: { job: Job; meta: Meta }) {
  const now = useNow(true);
  const pr = job.progress;
  const elapsed = job.startedAt ? Math.max(0, now / 1000 - job.startedAt) : job.elapsed ?? 0;
  const phases = pr?.step === "diagnose" ? [...PHASES.slice(0, pr.mip.variables == null ? 1 : 2), DIAGNOSE_PHASE] : PHASES;
  const cur = phases.findIndex(p => p.key === pr?.step);
  const m = pr?.mip;
  const inputs = job.inputs;
  const sizing = pr?.step === "size";
  const solverSec = m?.startedAt ? (sizing ? now / 1000 - m.startedAt : Math.max(m.seconds, 0)) : m?.seconds ?? 0;
  const quiet = sizing && m ? now / 1000 - (m.updatedAt ?? m.startedAt ?? now / 1000) : 0;
  return <div className="model-page">
    <div className="progress on" />
    <section className="section gt-loader">
      <div className="dark-card gt-run">
        <span className="tag orange">{job.alternative ? "OPTIMISING AN ALTERNATIVE" : "OPTIMISING"} · {clock(elapsed)} ELAPSED</span>
        <h2 className="display one-line">{job.alternative ? <>OPTIMISING AN <em>ALTERNATIVE.</em></> : <>THE OPTIMISER IS <em>WORKING.</em></>}</h2>
        <p>{inputs ? `${inputs.peakMw} MW campus · opening month ${inputs.start} · ${inputs.reliability} · ${inputs.staged ? "year by year" : "upfront"}. ` : ""}This usually takes several minutes. You can leave this page: the run continues on the server and this page picks it up again.</p>
        {job.alternative && <AltBanner alt={job.alternative} kind="running" />}
        <ol className="gt-phases">{phases.map((p, i) => {
          const state = cur > i || pr?.step === "done" ? "done" : cur === i ? "active" : "";
          return <li key={p.key} className={state}><span className="gt-dot">{state === "done" ? "✓" : state === "active" ? <i className="spin" /> : i + 1}</span>
            <div><b>{p.title}</b><small>{p.detail}</small>
              {state === "active" && p.key === "dispatch" && pr && pr.dispatch.total > 0 && <div className="gt-bar"><i style={{ width: `${pr.dispatch.done / pr.dispatch.total * 100}%` }} /><span>model year {Math.min(pr.dispatch.done + 1, pr.dispatch.total)} of {pr.dispatch.total} with demand</span></div>}
            </div></li>;
        })}</ol>
      </div>

      {m && (pr?.step === "size" || m.best != null) && <div className="card gt-mip gt-after">
        <h3 className="chart-h">Sizing, live <small>the solver's own progress · objective = cost on the representative days ($), not yet the final hourly result</small></h3>
        <div className="gt-tiles">
          <div><Count>{m.best == null ? "searching" : usdM(m.best)}</Count><span>best portfolio found so far</span></div>
          <div><Count>{m.bound == null ? "–" : usdM(m.bound)}</Count><span>lower bound: nothing can be cheaper</span></div>
          <div><Count>{m.gap == null ? "–" : `${fmt(m.gap * 100, m.gap < 0.1 ? 2 : 1)}%`}</Count><span>gap to the lower bound · 0.5% = proven</span></div>
          <div><Count>{fmt(m.solutions)}</Count><span>better portfolios found</span></div>
          <div><Count>{fmt(m.nodes)}</Count><span>branch-and-bound nodes</span></div>
          <div><Count>{clock(solverSec)}</Count><span>sizing time · solver limit {clock(pr?.timeLimit ?? 600)}</span></div>
        </div>
        {quiet > 8 && <p className="gt-quiet"><i className="spin" />The solver is working through a large linear relaxation and reports no new numbers until it finishes that part (last report {clock(quiet)} ago). It is still running.</p>}
        <SizingSteps steps={m.steps ?? []} stage={m.stage} running={sizing} />
        <Convergence h={m.history} />
        {m.variables != null && <p className="footnote">A mixed-integer problem with {fmt(m.variables)} variables and {fmt(m.constraints)} constraints. The grey line is the lower bound (from the relaxed problem, raised by the full search); the orange line is the cheapest portfolio found. Sizing stops when they are within 0.5%, or when the full search has used its time.</p>}
      </div>}

      <details className="card fold gt-after"><summary><b>Model log</b><span>what the optimiser has printed so far</span></summary>
        <pre className="gt-log light">{job.log.length ? job.log.join("\n") : "Nothing printed yet."}</pre></details>
      {inputs && <div className="card gt-after"><h3 className="chart-h">{job.alternative ? "Inputs of this alternative" : "Inputs for this run"}</h3><InputsSummary inputs={inputs} meta={meta} /></div>}
    </section>
  </div>;
}

/** Best solution (orange) and lower bound (grey) of the sizing MIP over solver time. */
function Convergence({ h }: { h: [number, number | null, number | null][] }) {
  const pts = h.filter(p => p[1] != null || p[2] != null);
  if (pts.length < 2) return <p className="footnote">The chart appears once the solver reports its first bounds.</p>;
  const W = 1100, H = 260, L = 70, R = 12, T = 12, B = 28;
  const t1 = Math.max(...pts.map(p => p[0]), 1);
  const vals = pts.flatMap(p => [p[1], p[2]]).filter((v): v is number => v != null);
  const bestVals = pts.map(p => p[1]).filter((v): v is number => v != null);
  // the first feasible portfolio can be far above the rest; cap the axis so the convergence stays readable
  let hi = Math.max(...vals), lo = Math.min(...vals);
  if (bestVals.length > 2) hi = Math.min(hi, Math.min(...bestVals) + 3 * (Math.min(...bestVals) - lo + 1));
  const pad = (hi - lo) * 0.08 || 1; hi += pad; lo -= pad;
  const x = (t: number) => L + (t / t1) * (W - L - R);
  const y = (v: number) => T + (1 - (Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * (H - T - B);
  // the best portfolio only changes when a better one is found: draw it as steps; the bound rises continuously
  const path = (i: 1 | 2) => pts.filter(p => p[i] != null).map((p, j, arr) => {
    const X = x(p[0]).toFixed(1), Y = y(p[i] as number).toFixed(1);
    return j === 0 ? `M${X},${Y}` : i === 1 ? `H${X} V${Y}` : `L${X},${Y}`;
  }).join(" ") + (i === 1 ? ` H${x(t1).toFixed(1)}` : "");
  const ticks = [0, 0.5, 1].map(f => lo + f * (hi - lo));
  return <><div className="legend gt-conv-legend"><span className="lc" style={{ ["--c" as string]: "#f26b1d" }}>best portfolio found</span><span className="lc" style={{ ["--c" as string]: "#8a8a8a" }}>lower bound</span></div><svg className="gt-conv" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sizing convergence: best portfolio cost and lower bound over time">
    {ticks.map(v => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#e5e5e2" /><text x={L - 8} y={y(v) + 4} textAnchor="end">{usdM(v, 0)}</text></g>)}
    <text x={L} y={H - 6}>0 s</text><text x={W - R} y={H - 6} textAnchor="end">{Math.round(t1)} s</text>
    <path d={path(2)} fill="none" stroke="#8a8a8a" strokeWidth="2" />
    <path d={path(1)} fill="none" stroke="#f26b1d" strokeWidth="2.5" />
  </svg></>;
}

// ------------------------------------------------------------------------------------------------ previous runs: every saved run, newest first
const when = (t: number | null) => (t == null ? "–" : new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));

function runState(r: RunRow): [string, string] {
  if (r.status === "running") return ["running", "Running"];
  if (r.status === "failed") return ["bad", "Failed"];
  if (r.resultStatus === "INFEASIBLE") return ["bad", "No feasible portfolio"];
  if (r.sizingStatus === "Time limit reached") return ["warn", "Time limit: may not be optimal"];
  if (r.sizingStatus === TWO_STEP) return ["ok", "Best found (two-step)"];
  return r.resultStatus === "OK" ? ["ok", "Optimal"] : ["warn", r.resultStatus ?? "Unknown"];
}

function PreviousRuns({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { listRuns().then(setRuns).catch(e => setError(e.message)); }, []);
  return <div className="model-page">
    <section className="model-hero section gt-hero">
      <span className="tag orange">POWERLLEL OPTIMISER</span>
      <h1 className="display">PREVIOUS <em>RUNS.</em></h1>
      <p className="lede dark">Every run saved by the optimiser, newest first. Click a run to open its results, plots and inputs.</p>
    </section>
    <section className="section">
      {error && <p className="notice">{error}</p>}
      {!runs && !error && <p className="footnote">Loading…</p>}
      {runs && runs.length === 0 && <div className="card gt-panel"><p>No runs yet.</p><button className="primary" onClick={onNew}>Run the optimiser ↗</button></div>}
      {runs && runs.length > 0 && <div className="card table-card"><div className="table-scroll"><table className="year-table gt-runs">
        <thead><tr><th>Started</th><th className="l">Name</th><th>Result</th><th>10-yr cost</th><th>$/MWh</th><th>kg CO₂/MWh</th><th>Clean</th><th>Portfolio</th><th>Time</th></tr></thead>
        <tbody>{runs.map(r => { const [cls, label] = runState(r); return <tr key={r.id} className="pick" tabIndex={0} onClick={() => onOpen(r.id)} onKeyDown={e => { if (e.key === "Enter") onOpen(r.id); }}>
          <td>{when(r.startedAt)}</td>
          <td>{r.alternative && <span className="gt-alttag">ALT</span>}<b>{r.name ?? nameFromInputs(r.peakMw, r.start, r.reliability)}</b><small className="detail">{r.peakMw} MW · opens m{r.start} · {r.reliability} · {r.staged ? "year by year" : "upfront"}{r.co2Cap ? ` · ≤${r.co2Cap} kg` : ""} · {r.tag}</small>{r.customStress ? <small className="detail gt-stress-tag">{r.stress}</small> : null}</td>
          <td><span className={`gt-run-state ${cls}`}>{label}</span></td>
          <td>{usdM(r.cost)}</td><td>{r.costPerMwh == null ? "–" : `$${fmt(r.costPerMwh, 1)}`}</td><td>{fmt(r.co2)}</td><td>{pct(r.clean)}</td>
          <td className="note">{r.capacities.map(c => `${c.label} ${fmt(c.mw)}`).join(", ") || "–"}</td>
          <td>{r.elapsed == null ? "–" : clock(r.elapsed)}</td></tr>; })}</tbody>
      </table></div></div>}
    </section>
  </div>;
}

// ------------------------------------------------------------------------------------------------ results, with the inputs that produced them
function ResultsPage({ job, meta, onEdit, onNew, onUse, onRun, onRunPlain, onEditStress, onOpenRun, busy, onPrefill, tpl }: { job: Job; meta: Meta; onEdit: () => void; onNew: () => void; onUse: (i: RunInputs, title?: string) => void; onRun: (i: RunInputs, title?: string) => void; onRunPlain: (i: RunInputs) => void; onEditStress: () => void; onOpenRun: (id: string) => void; busy: boolean; onPrefill: (p: Partial<ThesisInput> & { gridDelay?: number; landAcres?: number; resources?: Record<string, Partial<Record<"max_mw" | "available_month", number>>> }) => void; tpl: Template | null }) {
  const r = job.result;
  const ok = r?.status === "OK";
  const alt = job.alternative;
  const agents = useRunAgents(job.id, job.thesisId, job.status !== "running", tpl?.weights, tpl?.title ?? null);   // the four agents around this run
  const charts = useCharts(job.id, ok);
  const scen = agents?.scenarios.find(x => x.jobId === job.id);
  const multi = !!agents && agents.mode !== "run";
  const runName = agents && multi ? (scen ? `${agents.thesis.title} · ${scen.label}` : agents.thesis.title) : agents?.mode === "run" ? agents.thesis.title
    : job.thesis?.title ? (job.thesis.scenario ? `${job.thesis.title} · ${job.thesis.scenario}` : job.thesis.title) : nameFromInputs(job.inputs?.peakMw, job.inputs?.start, job.inputs?.reliability);
  const chips = multi ? agents!.scenarios.filter(x => x.jobId).map(x => {
    const st = x.run?.resultStatus, [cls, state] = x.status === "running" || x.status === "queued" ? ["running", "Running"] : x.status === "failed" || x.status === "stopped" ? ["bad", x.status === "failed" ? "Failed" : "Stopped"] : st === "OK" ? ["ok", "Feasible"] : st ? ["bad", "No feasible portfolio"] : ["warn", "Pending"];
    return { key: x.key, label: x.label, jobId: x.jobId, cls, state };
  }) : [];
  const gasMw = (r?.capacities ?? []).filter(c => ["gas_turbine", "gas_engine", "fuel_cell"].includes(c.id)).reduce((a, c) => a + c.mw, 0);
  const notice = policyNotice(agents?.moratorium?.sites ?? [], gasMw > 0, (r?.kpis?.max_grid_import_mw ?? 1) > 0);
  return <div className={`model-page ${alt ? "gt-is-alt" : ""}`}>
    <section className="section gt-res-top">
      <PolicyNotice n={notice} id="res-notice" />
      {alt && <AltBanner alt={alt} kind="results" onOriginal={alt.ofJobId ? () => onOpenRun(alt.ofJobId) : undefined} />}
      <h1 className="display gt-run-name">{runName}</h1>
      {chips.length > 1 && <div className="gt-chips" role="tablist" aria-label="Runs of this thesis">{chips.map(c => <button key={c.key} role="tab" aria-selected={c.jobId === job.id} className={`gt-chip ${c.jobId === job.id ? "on" : ""}`} onClick={() => c.jobId && c.jobId !== job.id && onOpenRun(c.jobId)}>
        <span>{c.label}</span><small className={`gt-run-state ${c.cls}`}>{c.state}</small></button>)}</div>}
      <div className="gt-res-bar"><div>{alt && <span className="gt-alttag">ALTERNATIVE</span>}<span className="tag orange">{ok ? (alt ? "ALTERNATIVE RESULTS" : "RESULTS") : job.status === "failed" ? "RUN FAILED" : "NO FEASIBLE PORTFOLIO"}</span><span className="gt-res-meta">run {job.tag}{job.elapsed != null ? ` · ${clock(job.elapsed)}` : ""} · <a href={`/#intelligence/run/${job.id}`}>link to this run</a> · <a href="/#runs">all previous runs</a></span></div>
        <div className="gt-res-actions">{job.inputs && <button className="outline dark-outline" onClick={onEdit}>{alt ? "Edit this alternative" : "Edit these inputs"}</button>}<button className="primary" onClick={onNew}>New run</button></div></div>
      <RunAgentsHead v={agents} />
      {ok ? <>
        <details className="card fold gt-after" id="res-inputs"><summary><Tags a={["optimisation"]} /><b>{alt ? "Inputs of this alternative" : "Inputs used"}</b><span>what produced these results</span></summary>
          {alt && <div className="gt-alt-changed"><b>Changed from your original inputs</b><ul>{alt.changes.map(c => <li key={c}>{c}</li>)}</ul></div>}
          {job.inputs ? <InputsSummary inputs={job.inputs} meta={meta} /> : <p className="footnote">Not recorded for this run.</p>}</details>
        {r!.effective && <details className="card fold gt-after"><summary><Tags a={["optimisation"]} /><b>Inputs as the model used them</b><span>after your overrides: peak, schedule, land, remote site and the full resource catalogue</span></summary>
          <p className="gt-note">Peak {fmt(r!.effective.peakMw)} MW · annual energy at full demand {fmt(r!.effective.annualEnergyGwh)} GWh · land {fmt(r!.effective.landAcres, 1)} acres · remote relocation site {fmt(r!.effective.remoteMw, 1)} MW · interconnection {r!.effective.gridSchedule.map(s => `${s.label}: ${fmt(s.mw)} MW`).join(", ")}</p>
          <div className="table-scroll"><table className="year-table"><thead><tr><th>Resource</th><th>Available month</th><th>Block MW</th><th>Max MW</th><th>CAPEX $/kW</th><th>O&amp;M $/kW-yr</th><th>Life yr</th><th>$/MWh</th><th>Heat rate</th><th>t CO₂/MWh</th><th>Acres/MW</th><th>Fixed $/MW-yr</th></tr></thead>
            <tbody>{r!.effective.resources.map(x => <tr key={x.id}><td>{x.label}</td><td>{x.available_month}</td><td>{fmt(x.block_mw)}</td><td>{fmt(x.max_mw)}</td><td>{fmt(x.capex_usd_per_kw)}</td><td>{fmt(x.fom_usd_per_kw_year)}</td><td>{fmt(x.life_years)}</td><td>{fmt(x.payment_usd_per_mwh, 1)}</td><td>{fmt(x.heat_rate_mmbtu_per_mwh_hhv, 2)}</td><td>{fmt(x.co2_t_per_mwh, 3)}</td><td>{fmt(x.land_acres_per_mw, 2)}</td><td>{fmt(x.fixed_usd_per_mw_year)}</td></tr>)}</tbody></table></div></details>}
        <OkResults job={job} r={r!} alt={!!alt} v={agents} charts={charts} onPrefill={onPrefill} onRunPlain={onRunPlain} onEditStress={onEditStress} onOpenRun={onOpenRun} busy={busy} />
      </> : <div className="gt-res-layout">
        <aside className="card gt-res-aside" id="res-inputs"><h3 className="chart-h">{alt ? "Inputs of this alternative" : "Inputs used"}</h3>
          {alt && <div className="gt-alt-changed"><b>Changed from your original inputs</b><ul>{alt.changes.map(c => <li key={c}>{c}</li>)}</ul></div>}
          {job.inputs ? <InputsSummary inputs={job.inputs} meta={meta} /> : <p className="footnote">Not recorded for this run.</p>}</aside>
        <div className="gt-res-main">
          {job.status === "failed" && <div className="dark-card"><span className="tag orange">THE RUN FAILED</span><h2 className="display">SOMETHING <em>WENT WRONG.</em></h2><p>{job.error}</p></div>}
          {r && !ok && <Infeasible r={r} onUse={onUse} onRun={onRun} onEdit={onEdit} busy={busy} />}
        </div>
      </div>}
    </section>
  </div>;
}

/** The run's stress events, the hour they bite hardest, and how the portfolio differs from the same inputs with other events. */
function StressResults({ job, onRunPlain, onEditStress, onOpenRun, busy }: { job: Job; onRunPlain: (i: RunInputs) => void; onEditStress: () => void; onOpenRun: (id: string) => void; busy: boolean }) {
  const r = job.result!;
  const s = r.stress;
  const [others, setOthers] = useState<CompareRow[] | null>(null);
  const [pick, setPick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setOthers(null); setPick(0); compareRuns(job.id).then(setOthers).catch(e => setErr(e.message)); }, [job.id]);
  const custom = job.inputs?.stressEvents?.mode === "custom";
  const o = others?.[pick];
  const n1 = r.reliability && r.reliability !== "R0";
  return <div className="card table-card gt-after gt-stress-res" id="res-stress"><Tags a={["optimisation"]} />
    <h3 className="chart-h">Stress events <small>{stressText(job.inputs?.stressEvents)}</small></h3>
    {s && <>
      <p className="gt-note top">{s.events} event{s.events === 1 ? "" : "s"}, <b>{s.hoursPerYear} stress hours a year</b>, repeated every model year.{" "}
        {s.worst ? <>The hardest stress hour for onsite gas is <b>{s.worst.when}</b> in model year {s.worst.modelYear}: demand {fmt(s.worst.loadMw, 1)} MW − Tier 1/2 flexibility {fmt(s.worst.flexMw, 1)} MW − grid import allowed {fmt(s.worst.importMw, 1)} MW = <b>{fmt(s.worst.gasNeedMw, 1)} MW</b> that onsite gas must cover.
          {" "}The portfolio has {fmt(s.gasMw)} MW of gas{n1 && s.gasMw > 0 ? <>, {fmt(s.gasMw - s.largestUnitMw)} MW with its largest unit ({fmt(s.largestUnitMw)} MW) out</> : null}.</> : "No stress hour falls after the campus opens."}</p>
      {job.inputs?.stressEvents?.mode === "custom" && job.inputs.stressEvents.events.length > 0 && <details className="fold"><summary><b>Events used</b><span>{job.inputs.stressEvents.events.length} · times on the model's clock (US Central)</span></summary><StressTable rows={job.inputs.stressEvents.events} readOnly /></details>}
    </>}
    {err && <p className="notice">{err}</p>}
    {others && others.length === 0 && <div className="gt-compare-empty">
      <p>To see how the portfolio changes with the stress events, compare this run with the same inputs under different events.</p>
      <div className="gt-row">{custom && job.inputs && <button className="primary small" disabled={busy} onClick={() => onRunPlain({ ...job.inputs!, stressEvents: { mode: "packet" } })}>Run the same inputs with the packet events ↗</button>}
        <button className="outline dark-outline small" onClick={onEditStress}>{custom ? "Try other stress events" : "Try your own stress events"}</button></div></div>}
    {o && <>
      <div className="gt-head gt-compare-head"><b>Compared with the same inputs and {o.stressText}</b>
        {others!.length > 1 ? <select value={pick} onChange={e => setPick(+e.target.value)}>{others!.map((x, i) => <option key={x.id} value={i}>{x.stressText} · {when(x.startedAt)}</option>)}</select> : null}
        <button className="link" onClick={() => onOpenRun(o.id)}>Open that run</button><button className="link" onClick={onEditStress}>Try other stress events</button></div>
      <CompareTable r={r} job={job} o={o} />
    </>}
  </div>;
}

function CompareTable({ r, job, o }: { r: Result; job: Job; o: CompareRow }) {
  const k = r.kpis!, ok = o.kpis;
  const mw = (rows: { id: string; mw: number }[] | null | undefined, id: string) => rows?.find(c => c.id === id)?.mw ?? 0;
  const ids = (r.capacities ?? []).filter(c => c.mw > 0 || mw(o.capacities, c.id) > 0);
  const d = (a: number | null | undefined, b: number | null | undefined, f: (v: number) => string, rel = false) => {
    if (a == null || b == null) return "–";
    const x = a - b;
    if (Math.abs(x) < 1e-9) return "same";
    return `${x > 0 ? "+" : "−"}${f(Math.abs(x))}${rel && b ? ` (${x > 0 ? "+" : "−"}${fmt(Math.abs(x / b) * 100, 1)}%)` : ""}`;
  };
  const rows: [string, string, string, string][] = [
    ["Stress events", stressText(job.inputs?.stressEvents), o.stressText, ""],
    ["Stress hours a year", fmt(r.stress?.hoursPerYear), fmt(o.stress?.hoursPerYear), d(r.stress?.hoursPerYear, o.stress?.hoursPerYear, v => fmt(v))],
    ["Gas needed in the hardest stress hour", r.stress?.worst ? `${fmt(r.stress.worst.gasNeedMw, 1)} MW` : "–", o.stress?.worst ? `${fmt(o.stress.worst.gasNeedMw, 1)} MW` : "–", d(r.stress?.worst?.gasNeedMw, o.stress?.worst?.gasNeedMw, v => `${fmt(v, 1)} MW`)],
    ...ids.map(c => [`${c.label} MW`, fmt(c.mw), fmt(mw(o.capacities, c.id)), d(c.mw, mw(o.capacities, c.id), v => `${fmt(v)} MW`)] as [string, string, string, string]),
    ["10-yr decision cost", usdM(k.total_decision_cost_usd), usdM(ok?.total_decision_cost_usd), d(k.total_decision_cost_usd, ok?.total_decision_cost_usd, v => usdM(v), true)],
    ["$/requested MWh", `$${fmt(k.decision_cost_usd_per_requested_mwh, 2)}`, ok ? `$${fmt(ok.decision_cost_usd_per_requested_mwh, 2)}` : "–", d(k.decision_cost_usd_per_requested_mwh, ok?.decision_cost_usd_per_requested_mwh, v => `$${fmt(v, 2)}`)],
    ["kg CO₂/MWh", fmt(k.combined_electricity_co2_kg_per_mwh, 1), fmt(ok?.combined_electricity_co2_kg_per_mwh, 1), d(k.combined_electricity_co2_kg_per_mwh, ok?.combined_electricity_co2_kg_per_mwh, v => fmt(v, 1))],
    ["Clean share", pct(k.clean_energy_share), pct(ok?.clean_energy_share), d(k.clean_energy_share, ok?.clean_energy_share, v => `${fmt(v * 100, 1)} pts`)],
    ["Tier 1 relocated MWh", fmt(k.relocated_local_equivalent_mwh), fmt(ok?.relocated_local_equivalent_mwh), d(k.relocated_local_equivalent_mwh, ok?.relocated_local_equivalent_mwh, v => fmt(v))],
    ["Tier 2 interrupted MWh", fmt(k.interrupted_mwh), fmt(ok?.interrupted_mwh), d(k.interrupted_mwh, ok?.interrupted_mwh, v => fmt(v))],
  ];
  return <div className="table-scroll"><table className="year-table gt-compare"><thead><tr><th /><th>This run</th><th>Other run</th><th>Change</th></tr></thead>
    <tbody>{rows.map(([a, b, c, x]) => <tr key={a} className={x && x !== "same" && x !== "–" ? "changed" : ""}><td>{a}</td><td>{b}</td><td>{c}</td><td>{x}</td></tr>)}</tbody></table></div>;
}

function Infeasible({ r, onUse, onRun, onEdit, busy }: { r: Result; onUse: (i: RunInputs, title?: string) => void; onRun: (i: RunInputs, title?: string) => void; onEdit: () => void; busy: boolean }) {
  const d: Diagnosis | undefined = r.diagnosis;
  return <>
    <div className="dark-card gt-infeasible"><span className="tag orange">NO FEASIBLE PORTFOLIO</span>
      <h2 className="display">{d?.reasons[0]?.key === "solver" ? <>NO PORTFOLIO <em>FOUND IN TIME.</em></> : <>NO PORTFOLIO MEETS <em>THESE INPUTS.</em></>}</h2>
      <p>{r.skippedSizing ? "The capacity check showed before the optimisation that no portfolio can meet every rule, so the solve was skipped (it could only have ended infeasible). " : r.sizingStatus ? `The optimiser ended with status "${r.sizingStatus}". ` : ""}{d ? "Below: why, and inputs close to yours that do work." : r.message}</p></div>
    {d && <>
      <div className="card gt-after" id="res-why"><h3 className="chart-h">Why no portfolio was found <small>{d.reasons.length === 1 ? "one reason" : `${d.reasons.length} reasons`}, from the model's own rules</small></h3>
        <ol className="gt-reasons">{d.reasons.map((x, i) => <li key={x.key}><span className="gt-rnum">{i + 1}</span><div><span className="tag">{x.rule.toUpperCase()}</span><b>{x.title}</b><p>{x.detail}</p>
          {x.fixes.length > 0 && <small>What would help: {x.fixes.join(" · ")}</small>}</div></li>)}</ol></div>
      <div className="card gt-after gt-alt-section" id="res-alts"><span className="gt-alttag">ALTERNATIVES</span><h3 className="chart-h">Alternatives to your inputs <small>not your problem: each one is a different, nearby problem with one kind of input changed</small></h3>
        <p className="gt-alt-intro"><b>Your inputs above have no feasible portfolio, and nothing here changes that.</b> Each card below changes your inputs as listed. Running a card optimises <i>that alternative</i>, and its results are labelled as an alternative to this run.</p>
        {d.alternatives.length === 0 ? <p className="gt-note">No single change to the inputs fixes this. <button className="link" onClick={onEdit}>Edit the inputs</button> and change several at once.</p>
          : <div className="gt-alts">{d.alternatives.map((a, i) => { const letter = String.fromCharCode(65 + i); return <article key={a.key} className="gt-alt"><div className="gt-alt-head"><div><span className="gt-alt-letter">ALTERNATIVE {letter}</span><b>{a.title}</b></div><span className={`gt-badge ${a.verified ? "ok" : "maybe"}`}>{a.verified ? "feasible" : "needs a run"}</span></div>
            <div className="gt-alt-what">What changes from your inputs</div><ul>{a.changes.map(c => <li key={c}>{c}</li>)}</ul><p>{a.note}</p>
            <div className="gt-alt-actions"><button className="primary small" disabled={busy} onClick={() => onRun(a.inputs, `Alternative ${letter}: ${a.title}`)}>Run alternative {letter} ↗</button><button className="outline dark-outline small" onClick={() => onUse(a.inputs, `Alternative ${letter}: ${a.title}`)}>Review &amp; edit alternative {letter}</button></div></article>; })}</div>}
        <p className="footnote">{d.method} “Feasible” means a portfolio exists for that alternative; running it finds the cheapest one.</p></div>
    </>}
  </>;
}

const WAIT_BY = (w: string): AgentKey[] => [...(w.includes("optimisation") ? ["optimisation" as const] : []), ...(w.includes("financial") ? ["financial" as const] : []), ...(w.includes("site sourcing") ? ["sourcing" as const] : []), ...(w.includes("policy") ? ["moratorium" as const] : [])];
const Wait = ({ who }: { who: string }) => <div className="card th-placeholder"><Tags a={WAIT_BY(who)} /><p className="gt-note">Waiting for the {who} agent…</p></div>;
const Tile = ({ k, big, sub, by }: { k: string; big: string; sub: string; by?: AgentKey }) => <div className="ch-tile">{by && <Tags a={[by]} />}<span className="k">{k}</span><b>{big}</b><small>{sub}</small></div>;

/** The recommended portfolio card: headline, KPIs and the download links. */
function RecommendedCard({ r, alternative }: { r: Result; alternative?: boolean }) {
  const k = r.kpis!;
  const used = r.capacities!.filter(c => c.mw > 0);
  const kpis: [string, string][] = [
    [usdM(k.total_decision_cost_usd), "10-yr decision cost"], [`$${fmt(k.decision_cost_usd_per_requested_mwh, 1)}`, "$/requested MWh"],
    [fmt(k.combined_electricity_co2_kg_per_mwh, 1), r.co2Cap != null ? `kg CO₂/MWh · ceiling ${fmt(r.co2Cap)} ${r.co2CapMet === false ? "NOT met" : "met"}` : "kg CO₂/MWh"], [pct(k.clean_energy_share), "clean share"],
    [`${fmt(k.merchant_mwh / 1e3)} GWh`, "merchant grid energy"], [`${fmt(k.relocated_local_equivalent_mwh)} / ${fmt(k.interrupted_mwh)}`, "MWh relocated / interrupted"],
    [`${fmt(k.land_acres, 1)} ac`, `land used of ${fmt(r.effective?.landAcres, 1)}`], [`${fmt(k.max_grid_import_mw, 1)} MW`, "max grid import"],
  ];
  return <div className="dark-card recommendation gt-rec" id="res-portfolio"><span className="ag-row"><AgentTag a="optimisation" /><span className="tag orange">{alternative ? "RECOMMENDED PORTFOLIO FOR THE ALTERNATIVE" : "RECOMMENDED PORTFOLIO"}</span></span>
    <h2 className="display">{used.map(c => `${fmt(c.mw)} MW ${c.label}`).join(" + ") || "GRID ONLY"}</h2>
    <p>Opening {r.openingLabel}, full {fmt(r.peakMw)} MW {r.fullDemandLabel} · {r.reliability}: {r.reliabilityText} · checker <b>{r.checker}</b>{r.checker === "PASS" ? " (official packet checker)" : ` (same accounting on ${alternative ? "this alternative's" : "your"} inputs)`}{r.sizingStatus ? <> · sizing: {sizingNote(r.sizingStatus)}{r.sizingSeconds != null ? ` in ${clock(r.sizingSeconds)}` : ""}</> : null}</p>
    <div className="kpis">{kpis.map(([a, b]) => <div key={b}><Count>{a}</Count><span>{b}</span></div>)}</div>
    <div className="export-row gt-files">{Object.entries(r.files ?? {}).map(([n, u]) => <a key={n} className="export-link light-link" href={u}>{n} ↓</a>)}</div>
  </div>;
}

const YearsTable = ({ r }: { r: Result }) => <div className="card table-card gt-after" id="res-years"><Tags a={["optimisation"]} /><h3 className="chart-h">Results per model year</h3>
  <div className="table-scroll"><table className="year-table"><thead><tr><th>Year</th><th>Requested GWh</th><th>Decision cost</th><th>$/requested MWh</th><th>kg CO₂/MWh</th><th>Clean share</th><th>Merchant GWh</th></tr></thead>
    <tbody>{(r.annual ?? []).filter(a => a.requested_mwh > 0).map(a => <tr key={a.model_year}><td>Year {a.model_year}</td><td>{fmt(a.requested_mwh / 1e3)}</td><td>{usdM(a.total_decision_cost_usd)}</td><td>${fmt(a.total_decision_cost_usd / a.requested_mwh, 1)}</td><td>{fmt(a.combined_electricity_co2_kg_per_mwh)}</td><td>{pct(a.clean_energy_share)}</td><td>{fmt(a.merchant_mwh / 1e3)}</td></tr>)}</tbody></table></div></div>;

function OkResults({ job, r, alt, v, charts, onPrefill, onRunPlain, onEditStress, onOpenRun, busy }: { job: Job; r: Result; alt: boolean; v: ThesisView | null; charts: ChartsState; onPrefill: (p: Partial<ThesisInput> & { gridDelay?: number; landAcres?: number; resources?: Record<string, Partial<Record<"max_mw" | "available_month", number>>> }) => void; onRunPlain: (i: RunInputs) => void; onEditStress: () => void; onOpenRun: (id: string) => void; busy: boolean }) {
  const k = r.kpis!, cd = charts.data, cal = job.inputs?.calendarStart ?? cd?.calendarStart ?? null;
  const rec = v?.financial?.recommendation, sites = v?.moratorium?.sites ?? [], tx = sites.some(x => x.state === "TX");
  const mine = v?.scenarios.find(s => s.jobId === job.id) ?? v?.scenarios[0];
  const run = mine?.run, sched = r.effective?.gridSchedule ?? [], byYear = r.capacitiesByYear ?? [];
  const annual: AnnualPoint[] = cd?.annual ?? (r.annual ?? []).filter(a => a.requested_mwh > 0).map(a => ({ year: a.model_year, costPerMwh: a.total_decision_cost_usd / a.requested_mwh, kgPerMwh: a.combined_electricity_co2_kg_per_mwh, cleanShare: a.clean_energy_share, requestedGwh: a.requested_mwh / 1e3 }));
  const used = r.capacities!.filter(c => c.mw > 0);
  const landUsed = cd?.land.usedAcres ?? k.land_acres, landLim = cd?.land.limitAcres ?? r.effective?.landAcres;
  const equip = (r.effective?.resources ?? []).filter(x => x.location === "onsite" && (r.capacities!.find(c => c.id === x.id)?.mw ?? 0) > 0).map(x => ({ label: x.label, mw: r.capacities!.find(c => c.id === x.id)!.mw, acresPerMw: x.land_acres_per_mw }));
  const hasGas = used.some(c => ["gas_turbine", "gas_engine", "fuel_cell"].includes(c.id));
  const events = [...(hasGas && tx ? [{ month: 2, label: "State air permit in hand for the onsite gas (assumption: application plus review)" }, { month: 14, label: "Onsite gas available (packet fuel-cell date)" }] : []),
    ...sched.filter(x => x.mw > 0).map(x => ({ month: x.month, label: `Grid step: ${x.label} (${fmt(x.mw)} MW)` })), ...(r.opening != null ? [{ month: r.opening, label: "Opening: first power" }] : []), ...(r.fullDemand != null ? [{ month: r.fullDemand, label: "Full demand" }] : [])];
  const slip = job.inputs?.gridDelay ?? 0;
  const siteRows = sites.map(x => ({ id: x.id, label: x.label, grid: x.gridP50, power: x.powerBy }));
  const capRows = used.map(c => ({ key: c.id, label: c.label, value: c.mw, color: colorOf(cd, c.id), note: `serves from ${c.fromLabel}` }));
  return <div className="th-results th-run-sections">
    <section className="th-res-sec run-sec" id="ra-decision"><div className="section-head"><span>Executive decision</span><span>01</span></div>
      <SubHead n="01.1" title="Recommended answer" />
      <RecommendedCard r={r} alternative={alt} />
      <SubHead n="01.2" title="Cost | Speed | Environment | Risk" />
      <div className="ch-tiles">
        <Tile k="Cost" by="optimisation" big={usdM(k.total_decision_cost_usd)} sub={`10-yr decision cost · $${fmt(k.decision_cost_usd_per_requested_mwh, 1)}/MWh`} />
        <Tile k="Speed" by="optimisation" big={`${r.openingLabel ?? "–"}`} sub={`opening · full demand ${r.fullDemandLabel ?? "–"}`} />
        <Tile k="Environment" by="optimisation" big={`${fmt(k.combined_electricity_co2_kg_per_mwh, 1)} kg`} sub={`CO₂/MWh · ${pct(k.clean_energy_share)} clean share`} />
        <Tile k="Risk" by="moratorium" big={v?.moratorium ? stallRange(sites) : "–"} sub={v?.moratorium ? `stall chance of the proposed sites · ${fmt(k.interrupted_mwh)} MWh interrupted` : `${fmt(k.interrupted_mwh)} MWh interrupted · waiting for the policy agent`} />
      </div>
      <SubHead n="01.3" title="Recommended portfolio" />
      <div className="th-two-col gt-after" id="res-capacity">
        <div className="card table-card"><Tags a={["optimisation"]} /><h3 className="chart-h">Capacity by resource <small>all seven options</small></h3>
          <div className="table-scroll"><table className="year-table"><thead><tr><th>Resource</th><th>MW</th><th>Serves from</th></tr></thead>
            <tbody>{r.capacities!.map(c => <tr key={c.id} className={c.mw > 0 ? "" : "off"}><td>{c.label}</td><td>{c.mw > 0 ? fmt(c.mw) : "not selected"}</td><td>{c.mw > 0 ? c.fromLabel : "–"}</td></tr>)}</tbody></table></div></div>
        <div className="card table-card"><Tags a={["optimisation"]} /><h3 className="chart-h">Capacity bars <small>MW of each resource in the portfolio</small></h3>{capRows.length ? <HBars rows={capRows} /> : <p className="gt-note">Grid only: no capacity is built.</p>}</div>
      </div>
      <SubHead n="01.4" title="Key trade-offs" />
      {rec?.tradeoffs ? <TradeoffCard t={rec.tradeoffs} busy={agentBusy(v!.agents.financial)} mine={mine?.run} /> : <Wait who="financial" />}
    </section>

    <section className="th-res-sec run-sec" id="ra-cost"><div className="section-head"><span>Cost</span><span>02</span></div>
      <SubHead n="02.1" title="10-year economics" />
      <div className="card table-card"><Tags a={["optimisation"]} /><h3 className="chart-h">Cost of the decision <small>10 years, 2023 USD</small></h3>
        <div className="table-scroll"><table className="year-table"><tbody>
          <tr><td>Local energy cost</td><td>{usdM(k.local_energy_cost_usd)}</td></tr><tr><td>Tier 1 relocation</td><td>{usdM(k.relocation_cost_usd, 2)}</td></tr>
          <tr><td>Tier 2 interruption</td><td>{usdM(k.interruption_consequence_usd, 2)}</td></tr><tr className="total"><td>Total decision cost</td><td>{usdM(k.total_decision_cost_usd)}</td></tr>
          <tr><td>Local energy $/MWh served</td><td>${fmt(k.local_energy_cost_usd_per_mwh, 1)}</td></tr><tr><td>Combined CO₂, horizon</td><td>{fmt(k.combined_operational_co2_t / 1e3)} kt</td></tr>
          <tr><td>Requested energy</td><td>{fmt(k.requested_mwh / 1e3)} GWh</td></tr></tbody></table></div></div>
      {annual.length > 0 && <AnnualCostBars rows={annual} />}
      <YearsTable r={r} />
      <SubHead n="02.2" title="Portfolio comparison" />
      {v ? <PortfolioCompare v={v} /> : <Wait who="optimisation and financial" />}
      <SubHead n="02.3" title="Cost breakdown" />
      {v ? <PoolPick v={v} /> : <Wait who="financial" />}
      <SubHead n="02.4" title="Price sensitivity" />
      {rec?.sensitivity ? <PriceSensitivity s={rec.sensitivity} backup={rec.reliability?.backup?.options} /> : <div className="card"><Tags a={["financial"]} /><h3 className="chart-h">Price sensitivity</h3><p className="gt-note">{v && !agentBusy(v.agents.financial) ? "Not available." : "Waiting for the financial agent…"}</p></div>}
      <SubHead n="02.5" title="Reliability / backup costs" />
      {v ? <BackupTable v={v} /> : <Wait who="financial" />}
      <StressResults job={job} onRunPlain={onRunPlain} onEditStress={onEditStress} onOpenRun={onOpenRun} busy={busy} />
      <Loading st={charts}>{d => <StressChart d={d} />}</Loading>
    </section>

    <section className="th-res-sec run-sec" id="ra-speed"><div className="section-head"><span>Speed to power</span><span>03</span></div>
      <SubHead n="03.1" title="Opening power" />
      <div className="ch-tiles two">
        <Tile k="Opening power" by="optimisation" big={r.openingLabel ?? "–"} sub={`month ${r.opening ?? "–"}${cal && r.opening != null ? ` · ${monthName(r.opening, cal)}` : ""}: onsite gas and the first grid step serve the first load`} />
        <Tile k="Full demand" by="optimisation" big={r.fullDemandLabel ?? "–"} sub={`month ${r.fullDemand ?? "–"}${cal && r.fullDemand != null ? ` · ${monthName(r.fullDemand, cal)}` : ""}: the whole ${fmt(r.peakMw)} MW is served`} />
      </div>
      <SubHead n="03.2" title="Full demand" />
      <Loading st={charts}>{d => <PowerTimeline d={d} />}</Loading>
      <SubHead n="03.3" title="Grid arrival" />
      <div className="card table-card"><Tags a={["optimisation"]} /><h3 className="chart-h">Interconnection schedule <small>grid import allowed by month{slip ? ` · the grid connection slips ${slip} month${slip === 1 ? "" : "s"}` : " · no slip assumed"}</small></h3>
        {sched.length ? <div className="table-scroll"><table className="year-table"><thead><tr><th>Step</th><th>Model month</th><th>Date</th><th>Import allowed (MW)</th></tr></thead>
          <tbody>{sched.map((x, i) => <tr key={i}><td>{x.label}</td><td>{x.month}</td><td>{cal ? monthName(x.month, cal) : "–"}</td><td>{fmt(x.mw)}</td></tr>)}</tbody></table></div> : <p className="gt-note">No schedule recorded.</p>}</div>
      {r.staged && <div className="card table-card gt-after" id="res-staged"><Tags a={["optimisation"]} /><h3 className="chart-h">Capacity in service by model year <small>MW · added year by year, never removed</small></h3>
        <div className="table-scroll"><table className="year-table"><thead><tr><th>Year</th>{r.capacities!.map(c => <th key={c.id}>{c.label}</th>)}</tr></thead>
          <tbody>{byYear.map(y => <tr key={y.year}><td>Y{y.year} · {y.label}</td>{r.capacities!.map(c => <td key={c.id}>{fmt(y.caps[c.id])}</td>)}</tr>)}</tbody></table></div></div>}
      <SubHead n="03.4" title="Site-by-site power timeline" />
      {v?.moratorium ? <div className="card"><Tags a={["sourcing"]} /><h3 className="chart-h">When each proposed site can have power <small>grid connection estimate and the month power is available</small></h3><SiteTimeline sites={siteRows} opening={r.opening} fullDemand={r.fullDemand} /></div> : <Wait who="site sourcing" />}
      <SubHead n="03.5" title="Grid / bridge-power comparison" />
      <Loading st={charts}>{d => <PowerSourcesCard d={d} />}</Loading>
      {rec?.powerOverTime ? <PowerOverTime p={rec.powerOverTime} title="Pool's cheapest within your limits" sub={rec.recommendation?.detail ?? ""} /> : <Wait who="financial" />}
    </section>

    <section className="th-res-sec run-sec" id="ra-environment"><div className="section-head"><span>Environment</span><span>04</span></div>
      <SubHead n="04.1" title="Carbon" />
      {v ? <EmissionsChart v={v} /> : <Wait who="optimisation" />}
      {annual.length > 0 && <AnnualCarbonChart rows={annual} cap={cd?.co2Cap ?? r.co2Cap ?? null} />}
      <SubHead n="04.2" title="Clean energy share" />
      {annual.length > 0 ? <CleanShareBars rows={annual} /> : <p className="gt-note">No yearly results.</p>}
      <SubHead n="04.3" title="Water / land environmental constraints" />
      {v?.moratorium ? <EnvConstraints sites={sites} used={landUsed} limit={landLim} /> : <Wait who="site sourcing" />}
      <SubHead n="04.4" title="Air emissions" />
      {v ? <AirPermits scenarios={v.scenarios} sites={sites} onPrefill={onPrefill} availMonths={Object.fromEntries((r.effective?.resources ?? []).map(x => [x.id, x.available_month]))} /> : <Wait who="optimisation" />}
      <SubHead n="04.5" title="Environmental permitting" />
      {v?.moratorium ? (tx ? <PermitsCard sites={sites} /> : <p className="gt-note">Permitting rules are written for Texas sites; none of the proposed sites is in Texas.</p>) : <Wait who="policy" />}
    </section>

    <section className="th-res-sec run-sec" id="ra-policy"><div className="section-head"><span>Policy &amp; permitting</span><span>05</span></div>
      {!v?.moratorium ? <><SubHead n="05.1" title="State policy" /><Wait who="policy" /></> : <>
        <SubHead n="05.1" title="State policy" />
        {tx ? <><ThesisImpact sites={sites} t={v.thesis} /><TexasPanel sites={sites} /></> : <p className="gt-note">No Texas site in this run, so no state picture is shown.</p>}
        <SubHead n="05.2" title="Local approvals" />
        <LocalApprovals sites={sites} />
        <SubHead n="05.3" title="Moratoriums" />
        <MoratoriumTable sites={sites} />
        <SubHead n="05.4" title="Scenario analysis" />
        {tx ? <WhatIf sites={sites} t={v.thesis} onEditWith={p => onPrefill(p)} /> : <p className="gt-note">Scenario analysis covers Texas sites.</p>}
        <SubHead n="05.5" title="Stall probability" />
        <LocalRisk sites={sites} appetite={v.thesis.appetite} />
        <SubHead n="05.6" title="Regulatory timeline" />
        <RegTimeline sites={sites} events={events} cal={cal} /></>}
    </section>

    <section className="th-res-sec run-sec" id="ra-land"><div className="section-head"><span>Land &amp; site</span><span>06</span></div>
      <SubHead n="06.1" title="Land requirement" />
      <LandRequirement used={landUsed} limit={landLim} rows={equip} />
      {!v ? <Wait who="site sourcing" /> : sites.length > 0 ? <SiteSections sites={sites} need={run?.landAcres ?? 0} limit={run?.landLimit} onPrefill={onPrefill} /> : <><SubHead n="06.2" title="Site map" /><div className="card th-placeholder"><Tags a={["sourcing"]} /><p>{agentBusy(v.agents.sourcing) ? "Waiting for the site sourcing agent…" : v.agents.sourcing.detail}</p></div></>}
    </section>
  </div>;
}

// ------------------------------------------------------------------------------------------------ New thesis: plain language read into the Optimizer, or a template
const PLAIN_EXAMPLE = "75 MW campus, month 0 = 2027-01, opening in month 20. Grid: 37.5 MW from month 18 and 75 MW from month 24, and it could slip 6 months. Reliability R1, carbon ceiling 100 kg CO2/MWh. Wholesale prices grow 5% a year, gas prices 3% a year. No nuclear. At least 25 MW of wind. 8 acres of land. Build year by year. Cost first.";
const RES_WORDS: [string, RegExp][] = [["wind", /wind/], ["utility_solar", /solar/], ["nuclear", /nuclear/], ["battery_4h", /batter(?:y|ies)/], ["gas_turbine", /(?:gas )?turbines?/], ["gas_engine", /(?:gas )?(?:reciprocating )?engines?/], ["fuel_cell", /fuel cells?/]];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Read a plain-language thesis into the Optimizer's answers (the same fields as its seven steps). Returns what it understood. */
function parsePlainForm(text: string): { patch: Partial<Form>; t: Template | null; understood: string[] } {
  const s = text.replace(/\s+/g, " ").trim(), low = s.toLowerCase();
  const p: Partial<Form> = {}, got: string[] = [];
  const nm = "(\\d+(?:\\.\\d+)?)";
  const peak = new RegExp(`${nm}\\s*-?\\s*MW\\s+(?:data[- ]?cent(?:er|re)\\s+)?(?:campus|site|data|load|peak|facility)|peak(?: load| demand)?(?: of)?\\s*${nm}\\s*MW`, "i").exec(s);
  if (peak) { p.peak = peak[1] ?? peak[2]; got.push(`${p.peak} MW peak`); }
  const cal = /(\d{4})-(0[1-9]|1[0-2])\b/.exec(s) ?? (() => { const m = /month 0[^.]*?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})/i.exec(s); return m ? [m[0], m[2], String(MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")] : null; })();
  if (cal) { p.cal = `${cal[1]}-${cal[2]}`; got.push(`Month 0 = ${p.cal}`); }
  const open = /open(?:ing|s)?(?: the campus)?\s*(?:in|at|by|from)?\s*month\s*(\d+)/i.exec(s);
  const full = /full demand (?:by|in|at) month\s*(\d+)/i.exec(s);
  if (open) { p.start = open[1]; got.push(`Opening month ${p.start}`); }
  else if (full) { p.start = String(Number(full[1]) - 10); got.push(`Full demand by month ${full[1]}, so opening month ${p.start}`); }
  // grid: "37.5 MW from month 18", "full import from month 21", "packet schedule"
  if (/packet(?:'s)? (?:grid |utility )?schedule/i.test(s)) { p.icMode = "packet"; got.push("Grid: the packet's schedule"); }
  else {
    const steps: { month: number; mw: string }[] = [];
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*MW\s*(?:of grid |of import )?(?:from|at|in|by)\s*month\s*(\d+)/gi)) if (!steps.some(x => x.month === Number(m[2]))) steps.push({ month: Number(m[2]), mw: m[1] });
    const one = /(?:full (?:grid )?(?:import|connection)|grid (?:arrives|connects|connection)) (?:from|at|in|by) month\s*(\d+)/i.exec(s);
    if (steps.length) { p.icMode = "steps"; p.steps = steps.sort((a, b) => a.month - b.month); got.push(`Grid: ${p.steps.map(x => `${x.mw} MW from month ${x.month}`).join(", ")}`); }
    else if (one) { p.icMode = "month"; p.icMonth = Number(one[1]); got.push(`Grid: full import from month ${p.icMonth}`); }
  }
  const slip = /(?:slips?|delayed|late)\s*(?:by\s*)?(\d+)\s*months?|(\d+)\s*months?\s*late/i.exec(s);
  if (slip) { p.gridDelay = slip[1] ?? slip[2]; got.push(`Grid slips ${p.gridDelay} months`); }
  const rel = /\bR([0-5])\b/.exec(s);
  if (rel) p.rel = `R${rel[1]}` as RelKey; else if (/island/i.test(s)) p.rel = "R5"; else if (/\bSB ?6\b/i.test(s)) p.rel = "R4"; else if (/\bN-1\b/i.test(s)) p.rel = "R1";
  if (p.rel) got.push(`Reliability ${p.rel}`);
  const co2 = /(?:below|under|at most|ceiling(?: of)?|limit(?: of)?|max(?:imum)?(?: of)?|≤|<)\s*(\d+(?:\.\d+)?)\s*kg/i.exec(s);
  if (co2) { p.co2 = co2[1]; got.push(`Carbon ceiling ${p.co2} kg CO₂/MWh`); }
  const wg = /(?:wholesale|power|electricity|merchant) prices?[^.%]*?([+-−]?\d+(?:\.\d+)?)\s*%/i.exec(s);
  if (wg) { p.wg = wg[1].replace("−", "-").replace("+", ""); got.push(`Wholesale prices ${p.wg}% a year`); }
  const gg = /(?:gas|henry hub) prices?[^.%]*?([+-−]?\d+(?:\.\d+)?)\s*%/i.exec(s);
  if (gg) { p.gg = gg[1].replace("−", "-").replace("+", ""); got.push(`Gas prices ${p.gg}% a year`); }
  if (/year[- ]by[- ]year|in stages|staged/i.test(s)) { p.staged = true; got.push("Build year by year"); }
  else if (/upfront|all at once/i.test(s)) { p.staged = false; got.push("Build upfront"); }
  const off = new Set<string>();
  for (const [k, re] of RES_WORDS) if (new RegExp(`\\b(?:no|without)\\s+(?:a\\s+|any\\s+)?(?:onsite\\s+)?${re.source}|${re.source}\\s+(?:is\\s+)?(?:blocked|not available|unavailable)`, "i").test(s)) off.add(k);
  if (/\b(?:no|without)\s+(?:onsite\s+)?gas\b(?! prices?)/i.test(s)) ["gas_turbine", "gas_engine", "fuel_cell"].forEach(k => off.add(k));
  if (off.size) { p.excluded = [...off]; got.push(`Not available: ${p.excluded.map(k => TOGGLES.find(x => x[0] === k)?.[1] ?? k).join(", ")}`); }
  const mins: Record<string, string> = {};
  for (const m of s.matchAll(/at least\s*(\d+(?:\.\d+)?)\s*MW\s*(?:of\s*)?([a-z ]+?)(?=[.,;]|$| and )/gi)) {
    const hit = RES_WORDS.find(([, re]) => re.test(m[2].toLowerCase()));
    if (hit && !off.has(hit[0])) { mins[hit[0]] = m[1]; got.push(`At least ${m[1]} MW of ${TOGGLES.find(x => x[0] === hit[0])?.[1] ?? hit[0]}`); }
  }
  if (Object.keys(mins).length) p.mins = mins;
  const land = /(\d+(?:\.\d+)?)\s*acres?/i.exec(s);
  if (land) { p.land = land[1]; got.push(`${p.land} acres of onsite land`); }
  const adder = /(?:extra|additional|more)\s*grid (?:cost|charges?)[^.]*?\$?\s*(\d+(?:\.\d+)?)|\$\s*(\d+(?:\.\d+)?)\s*\/\s*MWh (?:more|extra) (?:for|on) (?:the )?grid/i.exec(s);
  if (adder) { p.gridAdder = adder[1] ?? adder[2]; got.push(`Extra grid cost $${p.gridAdder}/MWh`); }
  const t = /speed[- ]first|as soon as possible|fastest|speed to power first/.test(low) ? TEMPLATES[0] : /cost[- ]first|cheapest|lowest[- ]cost/.test(low) ? TEMPLATES[1] : /carbon[- ]first|clean(?:est)?|environment(?:al)?[- ]first/.test(low) ? TEMPLATES[2] : null;
  if (t) got.push(`Priorities: ${t.title} (speed ${t.weights.speed} / cost ${t.weights.cost} / carbon ${t.weights.environment})`);
  if (!got.length) got.push("Nothing recognised: the Optimizer keeps its defaults");
  return { patch: p, t, understood: got };
}

function PlainStart({ onRead, onPick, onSkip }: { onRead: (patch: Partial<Form>, t: Template | null, understood: string[]) => void; onPick: (t: Template) => void; onSkip: () => void }) {
  const [text, setText] = useState("");
  const [seen, setSeen] = useState<ReturnType<typeof parsePlainForm> | null>(null);
  const read = (x = text) => { if (x.trim()) setSeen(parsePlainForm(x)); };
  return <div className="model-page th-page">
    <section className="section model-hero gt-hero">
      <span className="tag orange">NEW THESIS</span>
      <h1 className="display">TELL US YOUR <em>THESIS.</em></h1>
      <p className="lede dark">Say what you need in plain words, answering the Optimizer's questions: campus size, opening month, grid connection, reliability, carbon ceiling, prices, and which resources are not available. Powerllel reads it into the Optimizer for you to check, then you run it.</p>
    </section>
    <section className="section th-start">
      <div className="card th-ask">
        <textarea value={text} onChange={e => { setText(e.target.value); setSeen(null); }} placeholder={`e.g. ${PLAIN_EXAMPLE}`}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) read(); }} aria-label="Your thesis in plain language" />
        <div className="th-ask-foot"><small>Cmd + Enter to read it · nothing runs until you press Run on the Optimizer</small>
          <div className="gt-row"><button className="outline dark-outline small" onClick={onSkip}>Skip, fill the detailed thesis</button><button className="outline dark-outline small" onClick={() => { setText(PLAIN_EXAMPLE); read(PLAIN_EXAMPLE); }}>Use the example</button><button className="primary small" disabled={!text.trim()} onClick={() => read()}>Read my thesis</button></div></div>
        {seen && <div className="th-understood">
          <b>What Powerllel understood</b>
          <ul>{seen.understood.map(x => <li key={x}>{x}</li>)}</ul>
          <p className="footnote">Everything else keeps the Optimizer's default. You can check and change every answer before running.</p>
          <button className="primary" onClick={() => onRead(seen.patch, seen.t, seen.understood)}>Fill in the Optimizer <Arrow /></button>
        </div>}
      </div>
      <article className="card th-sec th-tpl-card" id="th-template"><header><span className="tag">CHOOSE A TEMPLATE</span><h2 className="display">Choose a template</h2><p>Pick the customer type that matches the goal, or describe everything yourself above. A template fills in the Optimizer and the priority weights.</p></header>
        <div className="preset-grid th-presets th-presets-3">{TEMPLATES.map((t, i) => <button key={t.key} type="button" className="preset" onClick={() => onPick(t)}>
          <span>0{i + 1}</span><b>{t.title}</b><small>{t.blurb}</small></button>)}</div></article>
    </section>
  </div>;
}

export default App;
