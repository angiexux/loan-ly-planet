import { LANGS, setLang, useLang, useT } from "./i18n";
import { K } from "./locales/credit";
import { useC, cropLabel, countryName, collateralName, insuranceTrigger, insuranceType, productName, stageName } from "./locales/common";
import { useL } from "./locales/landing";
import { useP } from "./locales/pages";
import { useA } from "./locales/assume";
import { useMp } from "./locales/map";
import { useAk } from "./locales/ask";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import PortfolioMap, { Pie } from "./PortfolioMap";
import { Bars, HBars, Legend, TimeChart } from "./charts";
import {
  ACT, byStress, CASCADE_STEPS, HEALTHS, HEALTH_COLOR, chiColor, healthOf, provinceOf, LEVELS, LEVEL_COLOR, PERILS, actionCards, cascadeStep, cascadeText, cascadeWord, cropText, levelLabel, perilLabel, recKindAt, activeRows, alertsWindow, kpisAt, loadAnalysis, loadHealth, loadSnapshot, snapFor, loanById, monthOf, pct, recommendAt, reasonsAt, rowOf, rowsAt,
  dayLabel, sgnPct, sgnUsd, stageReasonText, usd, weekLabel,
} from "./data";
import type { Alert, Analysis, Crop, Loan, Recommendation, Row, Snapshot } from "./data";
import { AppCtx, Arrow, Assumptions, ConfBar, fhiWord, Kpi, Lv, PageHead, PdfLink, PdfNote, ScoreBar, useApp } from "./ui";
import type { GenDoc, Page } from "./ui";
import SoilSensorCard from "./SoilSensors";
import AskPage from "./AskPage";
import AlertToasts from "./AlertToasts";
import { ActionsPage } from "./Reports";
import UploadCard from "./Upload";
import MethodPage from "./Method";
import SensorStory from "./SensorStory";

const PAGES: Page[] = ["overview", "ask", "portfolio", "loan", "actions", "upload"];
/** old links (#alerts, #reports) land on the page that now holds that content */
const LEGACY: Record<string, Page> = { alerts: "portfolio", reports: "actions", method: "overview" };   // #method = the Methodology section of the landing page
const pageOf = (h: string): Page => (LEGACY[h] ?? (PAGES.includes(h as Page) ? h : "overview")) as Page;
function Globe({ light = false }: { light?: boolean }) {
  return <img className="logo" src={light ? "/brand/logo-white.png" : "/brand/logo.png"} alt="" aria-hidden="true" />;
}
const bookFromUrl = () => { try { return new URLSearchParams(location.search).get("book"); } catch { return null; } };

// ----------------------------------------------------------------------------------------------- app
export default function App() {
  const t = useT(), l = useL(), c = useC();
  const [book, setBookState] = useState<string | null>(bookFromUrl);
  const [a, setA] = useState<Analysis | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPageState] = useState<Page>(() => { return pageOf(location.hash.slice(1).split("/")[0]); });
  const [sel, setSel] = useState<string | null>(() => location.hash.split("/")[1] ?? null);
  const [w, setW] = useState(0);
  const [menu, setMenu] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  const [askHist, setAskHist] = useState<string[]>([]);
  const [preset, setPreset] = useState<{ crop?: string; region?: string; stressed?: boolean } | undefined>(undefined);
  const [llm, setLlm] = useState(false);
  const [pdfKinds, setPdfKinds] = useState<string[] | null>(null);
  const [docs, setDocs] = useState<GenDoc[]>([]);

  useEffect(() => {
    const on = () => { const [h, id] = location.hash.slice(1).split("/"); const pg = pageOf(h); setPageState(pg); if (id) setSel(id); };
    window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => { loadHealth().then(h => setLlm(h.llm)); }, []);
  useEffect(() => {                                   // is the PDF service live, and which kinds does it offer?
    let dead = false;
    fetch("/api/pdf").then(r => (r.ok ? r.json() : null)).then(j => { if (!dead) setPdfKinds(j?.kinds ? (j.kinds as { kind: string }[]).map(k => k.kind) : j ? [] : null); }).catch(() => { if (!dead) setPdfKinds(null); });
    return () => { dead = true; };
  }, [a]);
  useEffect(() => {
    let dead = false; setErr(null);
    loadAnalysis(book).then(({ analysis }) => { if (dead) return; setA(analysis); setW(analysis.meta.asOfDefault); })   // the app operates "today" (meta.asOfDefault); no date control in the front end
      .catch(e => { if (dead) return; if (book) { setNotice(String(e.message ?? e)); setBook(null); } else setErr(String(e.message ?? e)); });
    return () => { dead = true; };
  }, [book]);

  function setBook(b: string | null) {
    setBookState(b); setSel(null); setNotice(null);
    try { const u = new URL(location.href); if (b) u.searchParams.set("book", b); else u.searchParams.delete("book"); history.replaceState(null, "", u.toString()); } catch { /* ignore */ }
  }
  const go = useCallback((pg: Page, id?: string | null) => {
    const target: Page = pg === "upload" ? "portfolio" : pg;
    setPageState(target); setMenu(false);
    if (id !== undefined) setSel(id);
    const u = new URL(location.href); u.hash = target === "overview" ? "" : `#${target}${target === "loan" && (id ?? sel) ? `/${id ?? sel}` : ""}`;
    history.replaceState(null, "", u.toString());
    document.querySelector(".dash-main")?.scrollTo({ top: 0 });
    if (pg === "upload") setTimeout(() => document.getElementById("upload")?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  }, [sel]);
  const openLoan = useCallback((id: string) => go("loan", id), [go]);
  const addDoc = useCallback((d: Omit<GenDoc, "id" | "at">) => setDocs(x => [{ ...d, id: `${Date.now()}${x.length}`, at: new Date().toLocaleTimeString() }, ...x]), []);

  const rows = useMemo(() => (a ? activeRows(a, w) : []), [a, w]);

  if (err) return <div className="section"><h1 className="display">{l("err.h1")}<em>{l("err.h2")}</em></h1><p className="notice">{err}</p></div>;
  if (!a) return <div className="section"><span className="spin" /> {l("loadingBook")}</div>;
  const ctx = { a, w, book, llm, pdfKinds, docs, addDoc, openLoan, go, setBook, sel, setSel };

  if (page === "overview") return <AppCtx.Provider value={ctx}><Overview open={() => go("portfolio")} /></AppCtx.Provider>;

  const meta = a.meta;
  const nav: [Page, string, ReactNode?][] = [["portfolio", t("nav.portfolio")], ["loan", t("nav.loan"), sel ? <i>{sel}</i> : null], ["actions", t("nav.actions"), docs.length ? <i>{docs.length}</i> : null], ["ask", t("nav.ask")]];
  return <AppCtx.Provider value={ctx}><div className={`dash ${menu ? "menu-open" : ""}`}>
    <header className="dash-top">
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <button className="menu-btn" onClick={() => setMenu(m => !m)} aria-label={c("menu")}>☰</button>
        <button className="brand" onClick={() => go("overview")}><Globe /><span>LOAN-LY PLANET</span></button>
        <span className="dash-app">{t("app.name")}</span>
      </div>
      <div className="top-right"><LangSwitch /></div>
    </header>
    <div className="dash-body">
      <aside className="dash-side">
        <div className="side-group">
          {nav.map(([pg, label, badge]) => <button key={pg} className={`side-item ${page === pg ? "active" : ""}`} onClick={() => go(pg)}><span className="side-label">{label}</span>{badge}</button>)}
        </div>
        <div className="side-group side-sep">
          <a className="side-item side-link" href="/#method"><span>{t("nav.method")}</span><Arrow /></a>
        </div>
        <button type="button" className="account" title="Banco de la República Austral" onClick={() => go("portfolio")}>
          <span className="account-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9.5 12 5l8 4.5" /><path d="M6.5 12v5M12 12v5M17.5 12v5" /><path d="M4 20h16" /></svg></span>
          <span className="account-text"><b>Banco de la República Austral</b></span>
        </button>
      </aside>
      <main className="dash-main">
        {book && <p className="notice small no-print" style={{ marginBottom: 14 }}>{l("viewingBook", a.loans.length)}<button className="link" onClick={() => setBook(null)}>{l("backDemo")}</button></p>}
        {notice && <p className="notice small no-print" style={{ marginBottom: 14 }}>{notice} <button className="link" onClick={() => setNotice(null)}>{l("dismiss")}</button></p>}
        {meta.warnings && meta.warnings.length > 0 && <p className="notice info small no-print" style={{ marginBottom: 14 }}>{meta.warnings.slice(0, 3).join(" · ")}</p>}
        {page === "portfolio" && <PortfolioPage rows={rows} sel={sel} preset={preset} />}
        {page === "ask" && <AskPage asked={asked} setAsked={setAsked} hist={askHist} setHist={setAskHist} toPortfolio={pr => { setPreset(pr); go("portfolio"); }} />}
        {page === "loan" && <LoanPage sel={sel} />}
        {page === "actions" && <ActionsPage />}
      </main>
    </div>
    <AlertToasts />
  </div></AppCtx.Provider>;
}

// ----------------------------------------------------------------------------------------------- landing
function LangSwitch() {
  const lang = useLang(), t = useT();
  return <div className="lang-switch" role="group" aria-label={t("lang")}>
    {LANGS.map(l => <button key={l.id} className={lang === l.id ? "on" : ""} aria-pressed={lang === l.id} title={l.name} lang={l.id} onClick={() => setLang(l.id)}>{l.short}</button>)}
  </div>;
}

function Overview({ open }: { open: () => void }) {
  const t = useT(), l = useL();
  const { a } = useApp(), meta = a.meta, w0 = meta.asOfDefault;
  const k = useMemo(() => kpisAt(a, w0), [a, w0]), rows = useMemo(() => activeRows(a, w0), [a, w0]);
  const steps = [0, 1, 2, 3] as const, sol = [0, 1, 2] as const;
  useEffect(() => {                                   // /#method (sidebar link) opens the landing page at the Methodology section
    const toMethod = () => { if (location.hash === "#method") setTimeout(() => document.getElementById("methodology")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60); };
    toMethod(); window.addEventListener("hashchange", toMethod); return () => window.removeEventListener("hashchange", toMethod);
  }, []);
  return <div className="app-shell">
    <header className="nav"><button className="brand" onClick={() => window.scrollTo({ top: 0 })}><Globe /><span>LOAN-LY PLANET</span></button><div className="row" style={{ flexWrap: "nowrap" }}><button className="primary btn-s" onClick={open}>{t("open")} <Arrow /></button><LangSwitch /></div></header>
    <section className="hero">
      <div className="hero-img" role="img" aria-label="Earth from orbit" />
      <div className="hero-shade" />
      <div className="hero-content">
        <p className="eyebrow">{l("eyebrow")}</p>
        <h1 className="display">{l("hero.a")}<em>{l("hero.b")}</em></h1>
        <p className="lede">{l("lede")}</p>
        <div className="hero-actions"><button className="light" onClick={open}>{t("open")} <Arrow /></button></div>
      </div>
    </section>
    <div className="ticker"><div className="ticker-track">{[0, 1].map(g => <div className="ticker-group" key={g} aria-hidden={g === 1}>{([0, 1, 2, 3, 4, 5, 6, 7] as const).map(i => <span key={i}>{l(`ticker.${i}`)}</span>)}</div>)}</div></div>

    <section className="section" id="problem">
      <div className="section-head"><span>{l("s1")}</span><span>01</span></div>
      <div className="split">
        <div><h2 className="display">{l("p.h")}<em>{l("p.h2")}</em></h2>
          <p className="lede">{l("p.lede")}</p></div>
        <div className="card"><span className="tag">{l("demo")}{weekLabel(meta.weeks[w0], true).toUpperCase()}</span>
          <div className="cards" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 16 }}>
            <div><div className="stat-big">{usd(k.exposure)}</div><span className="muted small">{l("st.lent", k.n, new Set(a.loans.map(x => x.country)).size)}</span></div>
            <div><div className="stat-big" style={{ color: "var(--accent)" }}>{pct(k.pdDoubledShare)}</div><span className="muted small">{l("st.pd2")}</span></div>
            <div><div className="stat-big">{k.stage2}</div><span className="muted small">{l("st.s2", k.stage3)}</span></div>
            <div><div className="stat-big">{sgnUsd(k.eclW - k.eclBank)}</div><span className="muted small">{l("st.ecl")}</span></div>
          </div>
          <p className="muted small" style={{ marginTop: 14 }}>{meta.lender}, {meta.synthetic ? l("portfolioNote") : l("uploadedBook")}</p></div>
      </div>
    </section>

    <section className="section" style={{ paddingTop: 0 }}>
      <div className="section-head"><span>{l("s2")}</span><span>02</span></div>
      <h2 className="display">{l("sol.h")}<em>{l("sol.h2")}</em></h2>
      <div className="cards three">
        {sol.map(i => <article className="card sol-photo" key={i} style={{ ["--img" as string]: `url("/img/sol-${i + 1}.jpg")` }}><span className="mono">0{i + 1}</span><h3 style={{ marginTop: 14 }}>{l(`sol.${i}.h`)}</h3><p className="muted">{l(`sol.${i}.b`)}</p></article>)}
      </div>
    </section>

    <section className="section" style={{ paddingTop: 0 }}>
      <div className="section-head"><span>{l("s3")}</span><span>03</span></div>
      <div className="cards four">
        {steps.map(i => <article className="card" key={i}><span className="tag">{l("step")} {i + 1}</span><h3 style={{ marginTop: 14 }}>{l(`how.${i}.h`)}</h3><p className="muted">{l(`how.${i}.b`)}</p></article>)}
      </div>
    </section>

    <section className="section" style={{ paddingTop: 0 }}>
      <div className="section-head"><span>{l("s4")}</span><span>04</span></div>
      <div className="split">
        <div><h2 className="display">{l("who.h")}<em>{l("who.h2")}</em></h2>
          </div>
        <div className="card"><h3>{l("moat.h")}</h3><p className="muted">{l("moat.b")}</p></div>
      </div>
    </section>

    <section className="section" style={{ paddingTop: 0 }} id="methodology">
      <div className="section-head"><span>{t("nav.method")}</span><span>05</span></div>
      <SensorStory />
      <MethodPage />
    </section>

    <section className="section" style={{ paddingTop: 0 }}><div className="dark-card cta-photo"><h2 className="display">{l("cta.h1")}<br />{l("cta.h2")}</h2><button className="light" onClick={open}>{t("open")} <Arrow /></button></div></section>
    <footer className="site"><div className="brand"><Globe /><span>LOAN-LY PLANET</span></div><span>{l("footer.hack")}</span></footer>
  </div>;
}

// ----------------------------------------------------------------------------------------------- shared tick helpers
export function useTicks() {
  const { a } = useApp(), n = a.meta.weeks.length, lang = useLang();
  return useMemo(() => ({ n, ticks: Array.from({ length: Math.ceil(n / 8) }, (_, i) => i * 8), tick: (i: number) => `${monthOf(a.meta.weeks[i])} ${a.meta.weeks[i].slice(2, 4)}`, xl: (i: number) => weekLabel(a.meta.weeks[i], true) }), [a, n, lang]);   // eslint-disable-line react-hooks/exhaustive-deps
}

// ----------------------------------------------------------------------------------------------- portfolio
function PortfolioPage({ rows, sel, preset }: { rows: Row[]; sel: string | null; preset?: { crop?: string; region?: string; stressed?: boolean } }) {
  const { a, w, openLoan } = useApp(), meta = a.meta, k = kpisAt(a, w), { n, ticks, tick, xl } = useTicks(), p = useP(), c = useC(), lang = useLang(), A = useA(), AK = useAk();
  const fhiNow = a.portfolio.fhiMean?.[w], MP = useMp();
  const [lv, setLv] = useState<"all" | "watch" | "high" | "severe" | "stressed">(preset?.stressed ? "stressed" : "all");   // "stressed" = High and Severe together (set from an Ask answer)
  const [stg, setStg] = useState<0 | 1 | 2 | 3>(0);
  const [crop, setCrop] = useState(preset?.crop ?? "all");
  const [region, setRegion] = useState(preset?.region ?? "all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"score" | "ead" | "pd" | "ecl">("score");
  const [prov, setProv] = useState<string | null>(null);       // selected province / state, shared by the map and the concentration panel
  const season = useMemo(() => LEVELS.slice().reverse().map(L => ({ label: levelLabel(L), color: LEVEL_COLOR[L], values: a.portfolio.byLevel[L].map(v => v / 1e6) })), [a, lang]);   // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => rows.filter(r => (lv === "all" || (lv === "watch" ? r.level === "Watch" : lv === "high" ? r.level === "High" : lv === "stressed" ? r.level === "High" || r.level === "Severe" : r.level === "Severe")) && (stg === 0 || r.stage === stg) && (crop === "all" || r.loan.crop === crop) && (region === "all" || r.loan.regionId === region) && (!q || `${r.loan.id} ${r.loan.borrower}`.toLowerCase().includes(q.toLowerCase())))
    .sort((x, y) => sort === "score" ? byStress(x, y) : sort === "ead" ? y.ead - x.ead : sort === "pd" ? y.pd12 - x.pd12 : y.eclDelta - x.eclDelta), [rows, lv, stg, crop, region, q, sort]);
  // concentration by province / state (a region is "Province · zone"): outstanding split by stress level
  const provinces = useMemo(() => {
    const m = new Map<string, { key: string; name: string; country: string; rows: Row[] }>();
    for (const r of rows) { const pv = provinceOf(r.loan); const e = m.get(pv.key) ?? { key: pv.key, name: pv.name, country: r.loan.country, rows: [] }; e.rows.push(r); m.set(pv.key, e); }
    return [...m.values()].map(e => ({ key: e.key, label: e.name, note: p("regionNote", countryName(e.country), e.rows.length), parts: LEVELS.map(L => ({ label: levelLabel(L), color: LEVEL_COLOR[L], v: e.rows.filter(r => r.level === L).reduce((s, r) => s + r.ead, 0) })) }))
      .filter(x => x.parts.some(q => q.v > 0)).sort((x, y) => (y.parts[0].v + y.parts[1].v) - (x.parts[0].v + x.parts[1].v));
  }, [rows, lang]);   // eslint-disable-line react-hooks/exhaustive-deps
  const clusters = a.portfolio.clusters[w] ?? [];
  return <>
    <PageHead tag={p("pf.tag")} title={<>{p("pf.h1")}<em>{p("pf.h2")}</em></>}>{p("pf.lede")}</PageHead>
    <div className="pf-upload"><UploadCard /></div>
    <div className="kpis">
      <Kpi label={p("k.portfolio")} value={usd(k.exposure)} sub={p("k.portfolioSub", k.n, usd(k.ead))} />
      <Kpi label={p("k.pd2")} value={pct(k.pdDoubledShare)} sub={p("k.pd2Sub", usd(k.pdDoubledEad))} cls="hot" />
      <Kpi label={p("k.severe")} value={k.severe} sub={p("k.severeSub")} />
      <Kpi label={p("k.unins")} value={usd(k.uninsuredStressedEad)} sub={p("k.uninsSub")} />
      {a.portfolio.fhiMean && <Kpi label={A("fhi.kpi")} value={fhiNow == null ? "–" : <span style={{ color: chiColor(fhiNow) }}>{Math.round(fhiNow)}</span>} sub={`${fhiWord(fhiNow, A)} · ${A("fhi.kpiSub")}`} />}
    </div>
    <div className="grid-map">
      <PortfolioMap rows={rows} selected={sel} onSelect={openLoan} clusters={clusters} w={w} province={prov} onProvince={setProv} />
      <div className="stack">
        <div className="card"><h3 className="chart-h">{p("ch.exposure")}<small>{p("ch.exposureSub")}</small></h3>
          <TimeChart n={n} unit="$M" stacks={season} marker={{ x: w, label: weekLabel(meta.weeks[w]) }} xTicks={ticks} tickText={tick} xLabel={xl} h={230} fmt={v => v.toFixed(v < 10 ? 1 : 0)} />
          <Legend items={LEVELS.map(L => ({ label: levelLabel(L), color: LEVEL_COLOR[L] }))} /></div>
        {prov ? <ProvinceOverview pkey={prov} rows={rows} total={k.ead} onClose={() => setProv(null)} />
          : <div className="card"><h3 className="chart-h">{MP("conc.h")}<small>{MP("conc.sub")}</small></h3><HBars rows={provinces} fmt={v => usd(v)} onPick={setProv} active={prov} /></div>}
      </div>
    </div>
    <div className="card mt">
      <div className="row between"><h3 className="chart-h">{p("ch.ranked")}<small>{p("ch.rankedSub")} · {p("f.count", list.length)}</small></h3>
        <div className="row">
          <div className="row" style={{ gap: 6 }} role="group" aria-label={p("f.stressGrp")}><span className="muted small">{p("f.stressGrp")}</span><div className="segment" style={{ flexWrap: "wrap" }}>{([["all", p("f.all")], ["watch", p("f.watchPlus")], ["high", p("f.highPlus")], ["severe", p("f.severeOnly")]] as const).map(([k, lb]) => { const on = lv === k || (lv === "stressed" && (k === "high" || k === "severe")); return <button key={k} className={on ? "on" : ""} aria-pressed={on} onClick={() => setLv(k)}>{lb}</button>; })}</div></div>
          <div className="row" style={{ gap: 6 }} role="group" aria-label={p("f.stageGrp")}><span className="muted small">{p("f.stageGrp")}</span><div className="segment" style={{ flexWrap: "wrap" }}>{([0, 1, 2, 3] as const).map(k => <button key={k} className={stg === k ? "on" : ""} aria-pressed={stg === k} onClick={() => setStg(k)}>{k === 0 ? p("f.allStages") : p("f.stageN", k)}</button>)}</div></div>
          <select value={crop} onChange={e => setCrop(e.target.value)} aria-label={p("f.crop")}><option value="all">{p("f.allCrops")}</option>{Object.keys(meta.crops).map(key => <option key={key} value={key}>{cropText(meta, key as Crop)}</option>)}</select>
          <select value={region} onChange={e => setRegion(e.target.value)} aria-label={p("f.region")}><option value="all">{p("f.allRegions")}</option>{meta.regions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          <input placeholder={p("f.search")} value={q} onChange={e => setQ(e.target.value)} />
        </div></div>
      <div className="tbl-box mt"><table className="tbl">
        <thead><tr><th className="l">{p("th.loan")}</th><th className="l">{p("th.regionCrop")}</th><th className="l">{p("th.cropStage")}</th><th className="sort" onClick={() => setSort("score")}>{p("th.stress")} {sort === "score" && "↓"}</th><th>{p("th.conf")}</th><th title={A("fhi.card")}>{A("fhi.th")}</th><th className="l">{p("th.why")}</th><th className="sort" onClick={() => setSort("ead")}>{p("th.outstanding")} {sort === "ead" && "↓"}</th><th className="sort" onClick={() => setSort("pd")}>{p("th.pd")} {sort === "pd" && "↓"}</th><th>{p("th.ifrs")}</th><th className="sort" onClick={() => setSort("ecl")}>{p("th.dEcl")} {sort === "ecl" && "↓"}</th><th className="l">{p("th.ins")}</th></tr></thead>
        <tbody>{list.slice(0, 150).map(r => <tr key={r.loan.id} className={r.loan.id === sel ? "sel" : ""} onClick={() => openLoan(r.loan.id)}>
          <td><b>{r.loan.id}</b>{r.loan.uploaded && <span className="flag-pill" style={{ marginLeft: 6 }}>{c("uploaded")}</span>}<small>{r.loan.borrower}</small></td>
          <td className="l">{r.loan.region}<small>{cropText(meta, r.loan.crop)} · {r.loan.areaHa.toLocaleString()} ha</small></td>
          <td className="l">{stageName(r.stageName)}</td>
          <td><ScoreBar s={r.score} l={r.level} /></td>
          <td><ConfBar c={r.conf} /></td>
          <td>{r.loan.fhi?.[w] == null ? <span className="muted">–</span> : <b style={{ color: chiColor(r.loan.fhi[w]) }}>{Math.round(r.loan.fhi[w]!)}</b>}</td>
          <td className="l wrap">{r.main && <b>{perilLabel(r.main)}: </b>}{r.main === "drought" && r.cascade !== "none" && <span className={`casc ${r.cascade}`}>{cascadeWord(r.cascade)}</span>} <span className="muted">{r.why || K("r.normal")}</span></td>
          <td>{usd(r.ead)}</td><td>{pct(r.loan.pdOrig, 1)} → <b>{pct(r.pd12, 1)}</b></td><td><span className={r.stage === 3 ? "stg3" : ""}>{c("stage")} {r.stage}</span></td><td>{sgnUsd(r.eclDelta)}</td>
          <td className="l">{r.loan.insurance ? insuranceType(r.loan.insurance.type) : <span className="muted">{c("none")}</span>}</td></tr>)}</tbody></table></div>
      {list.length > 150 && <p className="muted small">{p("showing", 150, list.length)}</p>}
    </div>
    <Assumptions items={[[p("as.score.h"), p("as.score.b", meta.histYears.length)], [p("as.lv.h"), p("as.lv.b", meta.params.hysteresis.up.join("/"), meta.params.hysteresis.down.join("/"))], [p("as.diff.h"), p("as.diff.b")],
      [p("as.pd2.h"), p("as.pd2.b", meta.params.sicrMultiplier)], [p("as.exp.h"), p("as.exp.b")]]} />
  </>;
}

// ----------------------------------------------------------------------------------------------- province overview (Portfolio, right panel)
function ProvinceOverview({ pkey, rows, total, onClose }: { pkey: string; rows: Row[]; total: number; onClose: () => void }) {
  const { a, w, openLoan } = useApp(), MP = useMp(), p = useP();
  const [sortBy, setSortBy] = useState<"risk" | "fhi" | "amount">("risk");
  const list = rows.filter(r => provinceOf(r.loan).key === pkey);
  const [name, country] = pkey.split("|");
  const ead = list.reduce((s, r) => s + r.ead, 0);
  const fhis = list.map(r => r.loan.fhi?.[w]).filter((x): x is number => x != null);
  const parts = HEALTHS.map(h => ({ h, color: HEALTH_COLOR[h], v: list.filter(r => healthOf(r.loan.fhi?.[w]) === h).length }));
  const fv = (r: Row) => r.loan.fhi?.[w] ?? 101;
  const sorted = [...list].sort((x, y) => sortBy === "risk" ? byStress(x, y) : sortBy === "fhi" ? fv(x) - fv(y) : y.loan.amountUsd - x.loan.amountUsd);
  return <div className="card prov">
    <div className="row between"><h3 className="chart-h">{name}<small>{countryName(country)}</small></h3><button className="link" onClick={onClose}>{MP("pv.back")}</button></div>
    <div className="prov-kpis">
      <div><span>{MP("pv.borrowers")}</span><b>{list.length}</b></div>
      <div><span>{MP("pv.exposure")}</span><b>{usd(ead)}</b><small>{MP("pv.share", pct(ead / Math.max(1, total)))}</small></div>
      <div><span>{MP("pv.avgFhi")}</span><b>{fhis.length ? Math.round(fhis.reduce((s, x) => s + x, 0) / fhis.length) : "–"}</b></div>
    </div>
    <h4 className="prov-h">{MP("pv.byHealth")}</h4>
    <div className="prov-pie"><Pie parts={parts} size={96} />
      <ul>{parts.map(x => <li key={x.h}><i className="dot" style={{ ["--c" as string]: x.color }} />{MP(`h.${x.h}`)}<b>{x.v}</b><span className="muted">{list.length ? `${Math.round(100 * x.v / list.length)}%` : "–"}</span></li>)}</ul></div>
    <div className="row between prov-h"><h4 style={{ margin: 0 }}>{MP("pv.loans")}</h4>
      <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)} aria-label={MP("pv.sort")}>{(["risk", "fhi", "amount"] as const).map(k => <option key={k} value={k}>{MP(`pv.s.${k}`)}</option>)}</select></div>
    <div className="tbl-box prov-list"><table className="tbl"><thead><tr><th className="l">{p("th.loan")}</th><th className="l">{MP("pop.crop")}</th><th>{MP("pop.loan")}</th><th className="l">{MP("pop.health")}</th><th>{p("th.stress")}</th></tr></thead>
      <tbody>{sorted.map(r => { const h = healthOf(r.loan.fhi?.[w]); return <tr key={r.loan.id} onClick={() => openLoan(r.loan.id)}>
        <td><b>{r.loan.id}</b><small>{r.loan.borrower}</small></td><td className="l">{cropText(a.meta, r.loan.crop)}</td><td>{usd(r.loan.amountUsd)}</td>
        <td className="l"><span style={{ color: HEALTH_COLOR[h], fontWeight: 700 }}>{MP(`h.${h}`)}</span>{r.loan.fhi?.[w] != null && <small>CHI {Math.round(r.loan.fhi[w]!)}</small>}</td>
        <td><ScoreBar s={r.score} l={r.level} /></td></tr>; })}</tbody></table></div>
  </div>;
}

// ----------------------------------------------------------------------------------------------- climate analysis (loan)
const explainCache = new Map<string, { explanation: string; recommendation: Recommendation } | null>();
function useExplain(id: string, w: number, book: string | null) {
  const key = `${book ?? ""}|${id}|${w}`;
  const [v, setV] = useState(() => explainCache.get(key) ?? null);
  useEffect(() => {
    if (explainCache.has(key)) { setV(explainCache.get(key) ?? null); return; }
    let dead = false; setV(null);
    fetch(`/api/explain?loan=${encodeURIComponent(id)}&week=${w}${book ? `&book=${encodeURIComponent(book)}` : ""}`).then(r => (r.ok ? r.json() : null))
      .then(j => { const x = j?.ok ? { explanation: j.explanation as string, recommendation: j.recommendation as Recommendation } : null; explainCache.set(key, x); if (!dead) setV(x); }).catch(() => { if (!dead) setV(null); });
    return () => { dead = true; };
  }, [key, id, w, book]);
  return v;
}

function agreement(l: Loan, w: number, main: string | null, p: ReturnType<typeof useP>) {
  if (main === "drought") { const f = [[p("ag.rain"), l.spi60[w] < -1], [p("ag.dry"), l.smPct[w] < 20], [p("ag.veg"), l.ndviZ[w] < -1.5]] as const; return { k: f.filter(x => x[1]).length, of: 3, names: f.filter(x => x[1]).map(x => x[0]) }; }
  if (main === "excess_water") { const f = [[p("ag.wet"), l.spi30[w] > 1.5], [p("ag.sat"), l.smPct[w] > 90], [p("ag.water"), l.water[w] > 0.1]] as const; return { k: f.filter(x => x[1]).length, of: 3, names: f.filter(x => x[1]).map(x => x[0]) }; }
  return null;
}


const ITEM_KEYS = { rain: "rd.rain", tmin: "rd.tmin", tmax: "rd.tmax", soil: "rd.soil", ndvi_s2: "rd.ndvi_s2", ndvi_modis: "rd.ndvi_modis", water: "rd.water" } as const;
function RealCard({ loanId, lat, lng }: { loanId: string; lat: number; lng: number }) {
  const p = useP(), c = useC();
  const [snap, setSnap] = useState<Snapshot | null | undefined>(undefined);
  useEffect(() => { let dead = false; loadSnapshot().then(s => { if (!dead) setSnap(s); }); return () => { dead = true; }; }, []);
  const e = snapFor(snap, loanId, lat, lng);
  return <div className="card">
    <div className="row between"><span className="tag accent">{p("rd.tag")}{snap ? ` · ${snap.date}` : ""}</span></div>
    {snap === undefined ? <p className="muted"><span className="spin" /> {c("loading")}</p> : !e ? <p className="muted">{p("rd.none")}</p> :
      <div className="facts real-facts">{Object.entries(e.items).map(([k, it]) => <div key={k}><span>{k in ITEM_KEYS ? p(ITEM_KEYS[k as keyof typeof ITEM_KEYS]) : k} <span className="flag-pill" style={{ marginLeft: 4 }}>{p("rd.real")}</span></span>
        <b>{it.value == null ? c("na") : typeof it.value === "number" ? it.value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : it.value}{it.unit ? ` ${it.unit}` : ""}{it.date_of_observation ? <small className="muted"> · {p("rd.observed")} {it.date_of_observation}</small> : null}</b>
        <small className="muted">{it.sourceLine ?? it.source?.name ?? ""}{it.source?.url ? <> · <a href={it.source.url} target="_blank" rel="noreferrer" className="link">{p("rd.source")}</a></> : null}</small></div>)}</div>}
  </div>;
}

function LoanPage({ sel }: { sel: string | null }) {
  const { a, w, book, openLoan, go } = useApp(), meta = a.meta, { n, ticks, tick, xl } = useTicks(), p = useP(), c = useC(), lang = useLang(), A = useA();
  const rows = rowsAt(a, w);
  const act = useMemo(() => rows.filter(r => r.active), [rows]);
  const r = rowOf(a, w, sel) ?? [...act].sort(byStress)[0] ?? rows[0];
  const l = r.loan, crop = cropText(meta, l.crop);
  const ex = useExplain(l.id, w, book);
  // English recommendation (backend, or the rule table) drives which card is outlined; ES/PT show the rule table's wording
  const recEn = ex?.recommendation ?? (w === meta.asOfDefault && l.recommendationAsOf ? l.recommendationAsOf : recommendAt(r, a, "en"));
  const rec = lang === "en" ? recEn : recommendAt(r, a);
  const explanation = lang === "en" ? (ex?.explanation ?? (w === meta.asOfDefault ? l.explanationAsOf : undefined)) : undefined;   // backend prose is English only; the "Why" list above carries the same facts
  const peers = useMemo(() => act.filter(x => x.loan.regionId === l.regionId && x.loan.crop === l.crop).sort(byStress), [act, l]);
  const rank = peers.findIndex(x => x.loan.id === l.id) + 1;
  const upTo = <T,>(v: (T | null)[]) => v.map((x, i) => (i <= w ? x : null));
  const shades = useMemo(() => {                       // crop-stage bands with weight >= 0.7, in neutral grey
    const out: { from: number; to: number; label: string; fill: string }[] = [];
    for (let i = 0; i < n; i++) { if (l.stageWeight[i] < 0.7) continue; const last = out[out.length - 1]; if (last && last.to === i - 1 && last.label === stageName(l.stage[i])) last.to = i; else out.push({ from: i, to: i, label: stageName(l.stage[i]), fill: "#8a8a86" }); }
    return out;
  }, [l, n, lang]);   // eslint-disable-line react-hooks/exhaustive-deps
  const ag = agreement(l, w, r.main, p);
  const cr = l.credit, cw = w - 3 >= 0 ? w - 3 : 0;
  const fan = (arr: number[]) => arr.map(v => Math.max(0, (1 + (v ?? 0)) * l.expectedYieldTHa));
  const expNow = Math.max(0, (1 + r.p50) * l.expectedYieldTHa);
  const reasons = reasonsAt(l, w);
  const cascCur = CASCADE_STEPS.indexOf(r.cascade);
  const sowTxt = l.sowing.week != null ? p("ln.sown", xl(l.sowing.week).replace(/^[^\d]*/, ""), l.sowing.source === "given" ? p("ln.given") : p("ln.detected")) : p("ln.sowUnknown");
  return <>
    <div className="loan-head">
      <div><span className="tag accent">{p("ln.tag", l.region, countryName(l.country))}</span><h1 className="display" style={{ fontSize: "clamp(40px,5vw,64px)", marginTop: 12 }}>{l.id} <em>{l.borrower}</em></h1>
        <p className="muted" style={{ margin: "8px 0 0" }}>{p("ln.sub", crop, l.areaHa.toLocaleString(), l.farmHa.toLocaleString(), l.irrigated ? p("ln.irrigated") : "", sowTxt, l.ring ? p("ln.polygon") : p("ln.point"), stageName(r.stageName))}</p></div>
      <select value={l.id} onChange={e => openLoan(e.target.value)} aria-label={p("ln.choose")}>{[...act].sort(byStress).map(x => <option key={x.loan.id} value={x.loan.id}>{x.loan.id} · {levelLabel(x.level)} {Math.round(x.score)}</option>)}</select>
    </div>
    {!r.active && <p className="notice info small mt">{p("ln.inactive", weekLabel(meta.weeks[w], true))}</p>}
    <div className="grid2 mt">
      <div className="card">
        <div className="row between"><span className="tag">{p("ln.stressTag", weekLabel(meta.weeks[w], true))}</span><span className="muted small">{stageName(r.stageName)}</span></div>
        <div className="gauge" style={{ ["--c" as string]: LEVEL_COLOR[r.level], marginTop: 10 }}><b>{Math.round(r.score)}</b><Lv l={r.level} /><span className="muted small">{p("ln.was", Math.round(l.score[cw]))}</span></div>
        <div className="perils">{PERILS.map(k => <div key={k}><span>{perilLabel(k)}</span><b>{Math.round(l.perils[k][w])}</b><span className="bar"><i style={{ width: `${l.perils[k][w]}%`, ["--c" as string]: LEVEL_COLOR[l.perils[k][w] >= 70 ? "Severe" : l.perils[k][w] >= 45 ? "High" : l.perils[k][w] >= 25 ? "Watch" : "Normal"] }} /></span></div>)}</div>
        <h3 className="mt">{p("ln.chain")}</h3>
        <div className="stepper" role="img" aria-label={cascadeText(r.cascade)}>{CASCADE_STEPS.map((st, i) => <div key={st} className={`step ${i <= cascCur ? "on" : ""} ${st === r.cascade ? "cur" : ""}`}><i>{i + 1}</i><span>{cascadeStep(st)}</span></div>)}</div>
        <p className="muted small" style={{ margin: "6px 0 0" }}>{cascadeText(r.cascade)}</p>
        <h3 className="mt">{c("confidence")} {pct(r.conf)}</h3>
        <div className="meter"><i style={{ width: `${r.conf * 100}%`, background: r.conf < 0.5 ? "#9ccfda" : "var(--accent)" }} /></div>
        <ul className="reason-list small" style={{ marginTop: 8 }}>
          <li>{p("ln.cloud", pct(l.cloudFree[w]), l.ndviObs[w] == null ? p("ln.gap") : "")}</li>
          <li>{l.ring ? p("ln.locPoly") : p("ln.locPoint")}</li>
          <li>{ag ? p("ln.agree", perilLabel(r.main!).toLowerCase(), ag.k, ag.of, ag.names.length ? ` (${ag.names.join("; ")})` : "") : p("ln.agreeNA")}</li></ul>
        <h3 className="mt">{p("ln.why")}</h3><ul className="reason-list">{reasons.length ? reasons.map(x => <li key={x}>{x}</li>) : <li>{K("r.normalFull")}</li>}</ul>
        {explanation && <p className="muted small" style={{ marginTop: 10 }}>{explanation}</p>}
      </div>
      <div className="card">
        <span className="tag">{p("ln.credit")}</span>
        <div className="facts">
          <div><span>{p("ln.pd12")}</span><b>{pct(l.pdOrig, 1)} → <span style={{ color: "var(--accent-ink)" }}>{pct(cr.pd12[w], 1)}</span></b></div><div><span>{p("ln.pdLife")}</span><b>{pct(cr.pdLife[w], 1)}</b></div>
          <div><span>{p("ln.stage")}</span><b className={r.stage === 3 ? "stg3" : ""}>{c("stage")} {r.stage}</b><small className="muted">{stageReasonText(r.stageReason, meta.params.sicrMultiplier)}</small></div><div><span>{p("ln.lgd")}</span><b>{pct(l.lgdBank)} → {pct(cr.lgd[w])}</b></div>
          <div><span>{p("ln.ead")}</span><b>{usd(cr.ead[w])}</b></div><div><span>{p("ln.eclBank")}</span><b>{usd(cr.eclBank[w])}</b></div>
          <div><span>{p("ln.eclScen")}</span><b>{usd(cr.ecl.base[w])} / {usd(cr.ecl.adverse[w])} / {usd(cr.ecl.severe[w])}</b></div><div><span>{p("ln.eclW", Object.values(meta.scenarios).map(v => pct(v)).join("/"))}</span><b style={{ color: "var(--accent-ink)" }}>{usd(cr.ecl.weighted[w])} <small>{p("ln.vsBank", sgnUsd(r.eclDelta))}</small></b></div>
          <div><span>{p("ln.expYield")}</span><b>{expNow.toFixed(1)} t/ha <small>{p("ln.expYieldSub", sgnPct(r.p50), l.expectedYieldTHa.toFixed(1), sgnPct(r.p10), sgnPct(r.p90))}</small></b></div>
          <div><span>{p("ln.insurance")}</span><b>{l.insurance ? p("ln.insVal", insuranceType(l.insurance.type), pct(l.insurance.coverShare), usd(l.insurance.sumInsured)) : c("none")}</b>{l.insurance && <small className="muted">{l.insurance.perils.map(q => perilLabel(q)).join(", ")}{l.insurance.trigger ? p("ln.trigger", insuranceTrigger(l.insurance.trigger)) : ""}</small>}</div>
          <div><span>{p("ln.insMet")}</span><b style={{ color: r.met ? "var(--accent-ink)" : undefined }}>{!l.insurance ? c("na") : r.met ? p("ln.yesPayout") : p("ln.notMet")}</b></div>
          <div><span>{p("ln.collateral")}</span><b>{collateralName(l.collateral)} · {usd(l.collateralValue)}</b></div><div><span>{p("ln.terms")}</span><b>{usd(l.amountUsd)} · {l.ratePct}% · {p("ln.matures", l.maturity)}</b></div>
          <div><span>{p("ln.bank")}</span><b>{p("ln.bankVal", l.bcraSituacion, l.daysPastDue)}</b></div><div><span>{p("ln.rating")}</span><b>{p("ln.ratingVal", l.ratingOrig)}</b></div>
        </div>
        <button className="rec-box rec-link" onClick={() => go("actions")}><span><b>{p("ln.recommended")}</b> {rec.action}. <span className="muted">{A("toOutputs")}</span></span><Arrow /></button>
      </div>
    </div>
    <div className="mt"><RealCard loanId={l.id} lat={l.lat} lng={l.lng} /></div>
    {l.fhi && <FhiCard l={l} w={w} />}
    <div className="card mt">
      <h3 className="chart-h">{p("lc.veg")}<small>{p("lc.vegSub", meta.histYears.length)}</small></h3>
      <TimeChart n={n} yMin={0} yMax={1} lines={[{ label: p("lc.histMean"), values: l.clim.mean, color: "#6aa9c2", dash: "6 4", width: 1.6 }, { label: p("lc.smooth"), values: upTo(l.ndvi), color: LEVEL_COLOR[r.level], width: 3 }]}
        dots={[{ label: p("lc.cfMedian"), values: upTo(l.ndviObs), color: "#1f4e6e" }]} band={{ lo: l.clim.p10, hi: l.clim.p90, color: "#3f86ab", label: p("lc.normal") }} shade={shades} marker={{ x: w, label: p("lc.asOf") }}
        xTicks={ticks} tickText={tick} xLabel={xl} unit="NDVI" />
      <Legend items={[{ label: p("lc.smooth"), color: LEVEL_COLOR[r.level] }, { label: p("lc.cfWeekly"), color: "#1f4e6e" }, { label: p("lc.histMean"), color: "#6aa9c2", kind: "dash" }, { label: p("lc.normal"), color: "#3f86ab", kind: "band" }, { label: p("lc.stageW"), color: "#8a8a86", kind: "band" }]} />
    </div>
    <div className="card mt"><h3 className="chart-h">{p("lc.spi")}<small>{p("lc.spiSub")}</small></h3>
        <TimeChart n={n} yMin={-3} yMax={3} lines={[{ label: "SPI-30", values: upTo(l.spi30), color: "#6aa9c2", width: 2 }, { label: "SPI-60", values: upTo(l.spi60), color: "#2f6f96", width: 3 }, { label: "SPI-90", values: upTo(l.spi90), color: "#1f4e6e", width: 2, dash: "5 3" }]}
          hlines={[{ v: -1, label: p("lc.dry"), color: "#eda06f" }, { v: -1.5, label: p("lc.sevdry"), color: "#b8401a" }]} marker={{ x: w, label: p("lc.asOf") }} xTicks={ticks} tickText={tick} xLabel={xl} h={250} fmt={v => v.toFixed(1)} />
        <Legend items={[{ label: "SPI-30", color: "#6aa9c2" }, { label: "SPI-60", color: "#2f6f96" }, { label: "SPI-90", color: "#1f4e6e", kind: "dash" }]} /></div>
    <div className="grid2 mt ss-row">
      <SoilSensorCard l={l} w={w} />
      <div className="card soil-card"><h3 className="chart-h">{p("lc.soil")}<small>{p("lc.soilSub")}</small></h3>
        <TimeChart n={n} yMin={-10} yMax={100} lines={[{ label: p("lc.smPct"), values: upTo(l.smPct), color: "#de6f3a", width: 2.6 }, { label: p("lc.hotDays"), values: upTo(l.hotDays).map(v => (v == null ? null : v * 10)), color: "#b8401a", dash: "4 3" }, { label: p("lc.minC"), values: upTo(l.tmin), color: "#2f6f96", width: 1.6 }]}
          hlines={[{ v: 20, label: p("lc.dryLine"), color: "#de6f3a" }]} marker={{ x: w, label: p("lc.asOf") }} xTicks={ticks} tickText={tick} xLabel={xl} h={250} fmt={v => v.toFixed(0)} />
        <Legend items={[{ label: p("lc.smPct"), color: "#de6f3a" }, { label: p("lc.hotLeg"), color: "#b8401a", kind: "dash" }, { label: p("lc.minLeg"), color: "#2f6f96" }]} />
        <div className="soil-now">
          <span className="soil-now-h">{p("lc.asOf")} {weekLabel(meta.weeks[w])}</span>
          {([[p("lc.smPct"), l.smPct, "#de6f3a", "", 0], [p("lc.hotDays"), l.hotDays, "#b8401a", "", 0], [p("lc.minC"), l.tmin, "#2f6f96", "°C", 1]] as [string, (number | null)[], string, string, number][]).map(([lab, s, col, unit, dp]) => {
            const now = s[w], prev = s[Math.max(0, w - 4)], d = now != null && prev != null ? now - prev : null;
            return <div key={lab} className="soil-stat" style={{ ["--c" as string]: col }}><span>{lab}</span><b>{now != null ? now.toFixed(dp) : "–"}<small>{unit}</small></b>
              <em>{d == null ? "" : `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d).toFixed(dp)} ${p("lc.vs4")}`}</em></div>;
          })}
        </div></div>
    </div>
    <div className="grid2 mt">
      <div className="card"><h3 className="chart-h">{p("lc.analogs")}<small>{p("lc.analogsSub")}</small></h3>
        {l.analogs[w].length ? <div className="analogs">{l.analogs[w].slice(0, 3).map(x => <div key={x.year} className="analog"><b>{x.year}/{String(x.year + 1).slice(2)}</b><span className="muted small">{p("lc.distance", x.distance.toFixed(2))}</span>
          <strong style={{ color: x.yieldAnom < -0.15 ? "var(--red)" : undefined }}>{sgnPct(x.yieldAnom)}</strong><span className="muted small">{p("lc.yieldVsNormal")}</span></div>)}</div>
          : <p className="muted">{p("lc.noAnalogs")}</p>}
        <p className="muted small" style={{ marginTop: 10 }}>{p("lc.yieldModel", l.region, crop.toLowerCase(), sgnPct(r.p10), sgnPct(r.p50), sgnPct(r.p90), l.expectedYieldTHa.toFixed(1))}</p></div>
      <div className="card"><h3 className="chart-h">{p("lc.fan")}<small>{p("lc.fanSub")}</small></h3>
        <TimeChart n={n} yMin={0} lines={[{ label: p("lc.normalSeason"), values: Array(n).fill(l.expectedYieldTHa), color: "#6aa9c2", dash: "6 4", width: 1.4 }, { label: p("lc.expected"), values: fan(l.yield.p50), color: LEVEL_COLOR[r.level], width: 3 }]}
          band={{ lo: fan(l.yield.p10), hi: fan(l.yield.p90), color: LEVEL_COLOR[r.level], label: "p10–p90" }} marker={{ x: w, label: p("lc.asOf") }} xTicks={ticks} tickText={tick} xLabel={xl} h={230} unit="t/ha" fmt={v => v.toFixed(1)} /></div>
    </div>
    <div className="grid2 mt">
      <div className="card"><h3 className="chart-h">{p("lc.yh")}<small>{p("lc.yhSub")}</small></h3>
        <Bars cats={[...l.yieldHistory.years.map(y => `${String(y).slice(2)}/${String(y + 1).slice(2)}`), `${a.meta.season.slice(2)}e`]} values={[...l.yieldHistory.tHa, expNow]} colors={[...l.yieldHistory.tHa.map(() => "#9ccfda"), LEVEL_COLOR[r.level]]} fmt={v => v.toFixed(1)} refLine={{ v: l.expectedYieldTHa, label: p("lc.normalRef", l.expectedYieldTHa.toFixed(1)) }} unit="t/ha" /></div>
      <div className="card"><h3 className="chart-h">{p("lc.peers", crop.toLowerCase(), l.region)}<small>{rank ? p("lc.peersRank", l.id, rank, peers.length) : p("lc.peersN", peers.length)}</small></h3>
        <div className="tbl-box" style={{ maxHeight: 260 }}><table className="tbl"><thead><tr><th className="l">{p("th.loan")}</th><th>{p("th.stress")}</th><th>{p("lc.vegZ")}</th><th>SPI-90</th><th>{p("lc.pdNow")}</th></tr></thead>
          <tbody>{peers.map(x => <tr key={x.loan.id} className={x.loan.id === l.id ? "sel" : ""} onClick={() => openLoan(x.loan.id)}><td>{x.loan.id}<small>{x.loan.borrower}</small></td><td><ScoreBar s={x.score} l={x.level} /></td><td>{x.loan.ndviZ[w].toFixed(1)}</td><td>{x.loan.spi90[w].toFixed(1)}</td><td>{pct(x.pd12, 1)}</td></tr>)}</tbody></table></div></div>
    </div>
    <Assumptions items={[[A("ln.per.h"), A("ln.per.b", meta.params.scoreHalfLifeWeeks ?? 4)], [A("ln.chain.h"), A("ln.chain.b")], [A("ln.conf.h"), A("ln.conf.b")], [A("ln.yield.h"), A("ln.yield.b")],
      [A("ln.pd.h"), A("ln.pd.b", meta.params.beta, meta.params.sicrMultiplier)], [A("ln.ins.h"), A("ln.ins.b")], [A("fhi.h"), A("fhi.b")], [A("ln.real.h"), A("ln.real.b")]]} />
  </>;
}

function FhiCard({ l, w }: { l: Loan; w: number }) {
  const A = useA(), { n, ticks, tick, xl } = useTicks(), { a } = useApp();
  const v = l.fhi?.[w] ?? null, camp = l.fhiByCampaign ?? [];
  const season = a.meta.season, cur = camp.find(x => x.campaign === season)?.fhi ?? null, curCrit = camp.find(x => x.campaign === season)?.crit ?? null, past = camp.filter(x => x.campaign !== season && x.fhi != null);
  const pastMean = past.length ? past.reduce((s, x) => s + x.fhi!, 0) / past.length : null, worst = past.length ? past.reduce((m, x) => (x.fhi! < m.fhi! ? x : m)) : null;
  const f = (x: number | null | undefined) => (x == null ? "–" : String(Math.round(x)));
  return <div className="card mt">
    <h3 className="chart-h">{A("fhi.card")}<small>{A("fhi.cardSub")}</small></h3>
    <div className="facts">
      <div><span>{A("fhi.now")}</span><b><span style={{ color: chiColor(v) }}>{f(v)}</span> <small>{fhiWord(v, A)}{l.fhiPartial?.[w] ? ` · ${A("fhi.partial")}` : ""}</small></b></div>
      <div><span>{A("fhi.vci")}</span><b>{f(l.fhiVci?.[w])}</b></div><div><span>{A("fhi.sm")}</span><b>{f(l.fhiSm?.[w])}</b></div><div><span>{A("fhi.wa")}</span><b>{f(l.fhiWa?.[w])}</b></div>
      <div><span>{A("fhi.season")}</span><b>{f(cur)} <small>{cur != null ? fhiWord(cur, A) : ""}</small></b></div>
      <div><span>{A("fhi.crit")}</span><b>{f(curCrit)} <small>{curCrit != null ? fhiWord(curCrit, A) : ""}</small></b></div>
      <div><span>{A("fhi.z")}</span><b>{l.fhiZ?.[w] == null ? "–" : `${l.fhiZ[w]! > 0 ? "+" : ""}${l.fhiZ[w]!.toFixed(1)} σ`}</b></div>
      <div><span>{A("fhi.past", past.length)}</span><b>{f(pastMean)}</b></div>
      <div><span>{A("fhi.worst")}</span><b>{worst ? `${f(worst.fhi)} · ${worst.campaign}` : "–"}</b></div>
    </div>
    <div className="mt"><TimeChart n={n} yMin={0} yMax={100} lines={[{ label: A("fhi.line"), values: (l.fhi ?? []).map((x, i) => (i <= w ? x : null)), color: chiColor(v ?? [...(l.fhi ?? [])].slice(0, w + 1).reverse().find(x => x != null)), width: 2.6 }]}
      hlines={[{ v: 45, label: "45", color: HEALTH_COLOR.atrisk }, { v: 60, label: "60", color: HEALTH_COLOR.healthy }]} marker={{ x: w, label: weekLabel(a.meta.weeks[w]) }} xTicks={ticks} tickText={tick} xLabel={xl} h={220} fmt={x => x.toFixed(0)} /></div>
  </div>;
}
