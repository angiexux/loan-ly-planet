import { useEffect, useMemo, useState } from "react";
import { Bars, HBars, Legend } from "./charts";
import {
  ACT, ACT_ORDER, actionCards, byStress, LEVEL_COLOR, api, cropText, insurancePreview, kpisAt, levelLabel, pdfKindLabel, pct, perilLabel, recKindAt, recommendAt, sgnPct, sgnUsd, stageReasonText, totalsOf, transferPreview, usd, weekLabel, activeRows, dayLabel, provinceOf,
} from "./data";
import type { ActKind, Row } from "./data";
import type { GenDoc } from "./ui";
import { useLang } from "./i18n";
import { collateralName, countryName, insuranceType, useC } from "./locales/common";
import { useR } from "./locales/reports";
import { useP } from "./locales/pages";
import { useA } from "./locales/assume";
import { useO } from "./locales/outputs";
import { Assumptions, ConfBar, FileLink, Kpi, PageHead, PdfLink, PdfNote, ScoreBar, useApp } from "./ui";

/** P(yield anomaly < thr) by linear interpolation through the backend's p10/p50/p90 (an approximation, labelled as such). */
export function pLoss(p10: number, p50: number, p90: number, thr = -0.3) {
  const pts: [number, number][] = [[p10, 0.1], [p50, 0.5], [p90, 0.9]];
  if (thr <= pts[0][0]) return Math.max(0.01, 0.1 - (pts[0][0] - thr) * 0.4);
  if (thr >= pts[2][0]) return Math.min(0.99, 0.9 + (thr - pts[2][0]) * 0.4);
  for (let i = 0; i < 2; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[i + 1]; if (thr >= x0 && thr <= x1) return x1 === x0 ? y0 : y0 + ((thr - x0) / (x1 - x0)) * (y1 - y0); }
  return 0.5;
}

const STRESS_NOTE_EN = "Expected loss (PD x LGD x EAD) of today's book if each history season repeated; Stage 3 loans included in every year.";   // backend text; shown translated when it matches
// ----------------------------------------------------------------------------------------------- IFRS 9 reports
/** section 02 of Actions & outputs: the former IFRS 9 reports page */
function Ifrs9Section({ rows, whole }: { rows: Row[]; whole: boolean }) {
  const { a, w, openLoan } = useApp(), meta = a.meta, t = useR(), c = useC(), p = useP(), lang = useLang(), o = useO();
  const [tab, setTab] = useState<"prob" | "lgd" | "ecl">("ecl");
  const k = useMemo(() => {
    if (whole) return kpisAt(a, w);
    const s = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
    return { ead: s(r => r.ead), eclBank: s(r => r.eclBank), eclW: s(r => r.ecl.weighted), eclBase: s(r => r.ecl.base), eclAdverse: s(r => r.ecl.adverse), eclSevere: s(r => r.ecl.severe),
      stage1: rows.filter(r => r.stage === 1).length, stage2: rows.filter(r => r.stage === 2).length, stage3: rows.filter(r => r.stage === 3).length };
  }, [a, w, rows, whole]);
  const byRegion = useMemo(() => meta.regions.map(rg => {
    const x = rows.filter(r => r.loan.regionId === rg.id), ead = x.reduce((s, r) => s + r.ead, 0), wt = (f: (r: Row) => number) => x.reduce((s, r) => s + f(r) * r.ead, 0) / Math.max(1, ead);
    return { rg, n: x.length, ead, bank: x.reduce((s, r) => s + r.eclBank, 0), adj: x.reduce((s, r) => s + r.ecl.weighted, 0), p30: wt(r => pLoss(r.p10, r.p50, r.p90)), lgdB: wt(r => r.loan.lgdBank), lgdA: wt(r => r.lgd), pd: wt(r => r.pd12) };
  }).filter(x => x.n).sort((x, y) => y.adj - y.bank - (x.adj - x.bank)), [rows, meta]);
  const top = useMemo(() => [...rows].sort(byStress), [rows]);
  const byStage = [1, 2, 3].map(sg => { const x = rows.filter(r => r.stage === sg), ead = x.reduce((s, r) => s + r.ead, 0); return { sg, n: x.length, ead, pd: x.reduce((s, r) => s + r.pd12 * r.ead, 0) / Math.max(1, ead), life: x.reduce((s, r) => s + r.pdLife * r.ead, 0) / Math.max(1, ead), bank: x.reduce((s, r) => s + r.eclBank, 0), adj: x.reduce((s, r) => s + r.ecl.weighted, 0) }; });
  const sc = [["base", k.eclBase], ["adverse", k.eclAdverse], ["severe", k.eclSevere]] as const;
  const st = a.stressTest;
  return <>
    <div className="kpis"><Kpi label={t("rp.k.bank")} value={usd(k.eclBank)} /><Kpi label={t("rp.k.clim")} value={usd(k.eclW)} cls="dark" /><Kpi label={t("rp.k.chg")} value={sgnPct((k.eclW - k.eclBank) / Math.max(1, k.eclBank))} sub={sgnUsd(k.eclW - k.eclBank)} cls="hot" /><Kpi label={t("rp.k.s23")} value={`${k.stage2} / ${k.stage3}`} sub={t("rp.k.s1", k.stage1)} /></div>
    <div className="card">
      <div className="segment" style={{ flexWrap: "wrap" }}>{([["ecl", t("rp.t.ecl")], ["prob", t("rp.t.prob")], ["lgd", t("rp.t.lgd")]] as const).map(([key, lb]) => <button key={key} className={tab === key ? "on" : ""} onClick={() => setTab(key)}>{lb}</button>)}</div>
      {tab === "prob" && <><p className="muted">{t("rp.prob.p")}</p>
        <HBars rows={byRegion.map(x => ({ key: x.rg.id, label: x.rg.name, note: countryName(x.rg.country), parts: [{ v: x.p30 * 100, color: "#3f86ab", label: t("rp.prob.leg") }] }))} fmt={v => `${v.toFixed(0)}%`} />
        <div className="tbl-box mt"><table className="tbl"><thead><tr><th className="l">{c("loanWord")}</th><th>{t("rp.prob.th")}</th><th>{t("rp.prob.p10")}</th><th>{t("rp.prob.p50")}</th><th className="l">{t("rp.prob.an")}</th><th className="l">{t("rp.prob.main")}</th></tr></thead>
          <tbody>{[...rows].sort((x, y) => pLoss(y.p10, y.p50, y.p90) - pLoss(x.p10, x.p50, x.p90)).slice(0, 60).map(r => <tr key={r.loan.id} onClick={() => openLoan(r.loan.id)}><td><b>{r.loan.id}</b><small>{r.loan.region} · {cropText(meta, r.loan.crop)}</small></td><td>{pct(pLoss(r.p10, r.p50, r.p90))}</td><td>{sgnPct(r.p10)}</td><td>{sgnPct(r.p50)}</td>
            <td className="l">{r.loan.analogs[w].slice(0, 3).map(x => `${x.year} (${sgnPct(x.yieldAnom)})`).join(", ") || "–"}</td><td className="l">{r.main ? perilLabel(r.main) : "–"}</td></tr>)}</tbody></table></div></>}
      {tab === "lgd" && <><p className="muted">{t("rp.lgd.p")}</p>
        <div className="tbl-box"><table className="tbl"><thead><tr><th className="l">{t("rp.lgd.region")}</th><th>{t("rp.ecl.out")}</th><th>{t("rp.lgd.bank")}</th><th>{t("rp.lgd.now")}</th><th>{t("rp.lgd.chg")}</th></tr></thead>
          <tbody>{byRegion.map(x => <tr key={x.rg.id}><td>{x.rg.name}<small>{countryName(x.rg.country)}</small></td><td>{usd(x.ead)}</td><td>{pct(x.lgdB, 1)}</td><td>{pct(x.lgdA, 1)}</td><td>{x.lgdA > x.lgdB ? "+" : ""}{((x.lgdA - x.lgdB) * 100).toFixed(1)} {t("rp.pts")}</td></tr>)}</tbody></table></div></>}
      {tab === "ecl" && <><p className="muted">{t("rp.ecl.p")}</p>
        <div className="table-scroll"><table className="tbl"><thead><tr><th className="l">{t("rp.ecl.stage")}</th><th>{t("rp.ecl.loans")}</th><th>{t("rp.ecl.out")}</th><th>{t("rp.ecl.pd12")}</th><th>{t("rp.ecl.pdLife")}</th><th>{t("rp.ecl.bank")}</th><th>{t("rp.ecl.w")}</th><th>{t("rp.ecl.chg")}</th></tr></thead>
          <tbody>{byStage.map(x => <tr key={x.sg} style={{ cursor: "default" }}><td>{c("stage")} {x.sg}</td><td>{x.n}</td><td>{usd(x.ead)}</td><td>{pct(x.pd, 1)}</td><td>{pct(x.life, 1)}</td><td>{usd(x.bank)}</td><td>{usd(x.adj)}</td><td>{sgnUsd(x.adj - x.bank)}</td></tr>)}
            <tr className="total"><td>{t("rp.total")}</td><td>{rows.length}</td><td>{usd(k.ead)}</td><td /><td /><td>{usd(k.eclBank)}</td><td>{usd(k.eclW)}</td><td>{sgnUsd(k.eclW - k.eclBank)}</td></tr></tbody></table></div>
        <h3 className="chart-h mt">{t("rp.byScen")}<small>{t("rp.byScenSub")}</small></h3>
        <div className="table-scroll"><table className="tbl"><thead><tr><th className="l">{t("rp.sc.scenario")}</th><th>{t("rp.sc.weight")}</th><th>{t("rp.sc.ecl")}</th><th>{t("rp.sc.contrib")}</th></tr></thead>
          <tbody>{sc.map(([s, v]) => <tr key={s} style={{ cursor: "default" }}><td style={{ textTransform: "capitalize" }}>{t(`rp.sc.${s}`)}</td><td>{pct(meta.scenarios[s])}</td><td>{usd(v)}</td><td>{usd(v * meta.scenarios[s])}</td></tr>)}
            <tr className="total"><td>{t("rp.sc.pw")}</td><td>{pct(sc.reduce((s, [n]) => s + meta.scenarios[n], 0))}</td><td /><td>{usd(k.eclW)}</td></tr></tbody></table></div>
        <h3 className="chart-h mt">{t("rp.provReg")}</h3>
        <HBars rows={byRegion.map(x => ({ key: x.rg.id, label: x.rg.name, parts: [{ v: x.bank, color: "#9ccfda", label: t("rp.ecl.bank") }, { v: Math.max(0, x.adj - x.bank), color: "#3f86ab", label: t("rp.addon") }] }))} fmt={v => usd(v)} />
        <Legend items={[{ label: t("rp.leg.bank"), color: "#9ccfda" }, { label: t("rp.leg.addon"), color: "#3f86ab" }]} /></>}
    </div>
    <div className="mt">
      <div className="card"><h3 className="chart-h">{t("rp.stress")}<small>{t("rp.stressSub")}{whole ? "" : ` · ${o("wholeBook")}`}</small></h3>
        <Bars cats={st.years.map(y => String(y).slice(2))} values={st.loss} colors={st.years.map(y => (y === st.worstYear ? LEVEL_COLOR.Severe : "#9ccfda"))} fmt={v => usd(v)} h={240}
          refLines={[{ v: st.p95, label: `p95 ${usd(st.p95)}`, color: "#de6f3a" }, { v: st.p99, label: `p99 ${usd(st.p99)}`, color: "#b8401a" }, ...(st.currentLoss != null ? [{ v: st.currentLoss, label: t("rp.thisSeason", usd(st.currentLoss)), color: "#3f86ab" }] : [])]} unit="" />
        <p className="muted small" style={{ marginTop: 8 }}>{t("rp.median", usd(st.p50), st.worstYear, usd(Math.max(...st.loss)))}{st.note ? ` ${lang !== "en" && st.note === STRESS_NOTE_EN ? t("rp.stressNote") : st.note}` : ""}</p></div>
    </div>
  </>;
}

// ----------------------------------------------------------------------------------------------- Actions = outputs
const recKindOf = recKindAt;
/** loans for whom each document is recommended */
export function candidates(kind: ActKind, rows: Row[], a: Parameters<typeof recommendAt>[1], clustered: Set<string>): Row[] {
  const f: Record<ActKind, (r: Row) => boolean> = {
    downgrade: r => r.stage === 2 || (r.stage === 1 && (r.level === "High" || r.level === "Severe")),
    transfer: r => r.stage === 3 || (r.level === "Severe" && r.p50 <= -0.25),
    insure: r => r.gap && r.level !== "Normal",
    claim: r => !!r.loan.insurance && r.met && (r.level === "High" || r.level === "Severe"),
    restructure: r => recKindOf(r, a) === "restructure",
    cover: r => recKindOf(r, a) === "cover",
    contact: r => recKindOf(r, a) === "contact",
  };
  const rank = (r: Row) => kind === "transfer" ? r.ead * (clustered.has(r.loan.id) ? 1.5 : 1) : kind === "downgrade" ? (r.stage === 2 ? 1e9 : 0) + r.eclDelta : kind === "insure" ? r.score * 1e3 + r.ead / 1e3 : r.score;
  return rows.filter(f[kind]).sort((x, y) => rank(y) - rank(x));
}

export function ActionsPage() {
  const { a, w, book, docs, pdfKinds, sel, setSel, openLoan, addDoc } = useApp(), meta = a.meta, t = useR(), c = useC(), p = useP(), lang = useLang(), A = useA(), o = useO();
  const allRows = useMemo(() => activeRows(a, w), [a, w]);
  const [prov, setProv] = useState("");
  const provs = useMemo(() => { const m = new Map<string, { name: string; n: number }>(); allRows.forEach(r => { const q = provinceOf(r.loan), x = m.get(q.key); if (x) x.n++; else m.set(q.key, { name: q.name, n: 1 }); }); return [...m].sort((x, y) => x[1].name.localeCompare(y[1].name)); }, [allRows]);
  const provName = provs.find(([k]) => k === prov)?.[1].name;
  const rows = useMemo(() => prov && provName ? allRows.filter(r => provinceOf(r.loan).key === prov) : allRows, [allRows, prov, provName]);
  const whole = rows === allRows;
  const scope = provName ? ` · ${provName}` : "";
  const ranked = useMemo(() => [...rows].sort(byStress), [rows]);
  const clustered = useMemo(() => new Set((a.portfolio.clusters[w] ?? []).flatMap(c => c.loanIds)), [a, w]);
  const cand = useMemo(() => Object.fromEntries(ACT_ORDER.map(k => [k, candidates(k, rows, a, clustered)])) as Record<ActKind, Row[]>, [rows, a, clustered]);
  const [type, setType] = useState<ActKind>("downgrade");
  const r = rows.find(x => x.loan.id === sel) ?? ranked[0];
  const ids = whole ? undefined : rows.map(x => x.loan.id);
  const recEn = r ? (w === meta.asOfDefault && r.loan.recommendationAsOf ? r.loan.recommendationAsOf : recommendAt(r, a, "en")) : null;
  const cards = r && recEn ? actionCards(r, a, recEn) : [];
  const st = a.stressTest;
  const pdfDown = (kind: string) => pdfKinds === null || (pdfKinds.length > 0 && !pdfKinds.includes(kind));

  // ---- section 04: the output checklist
  type Out = { key: string; label: string; note: string; href: string; kind: string; loan: string | null; pdf: boolean; rec: boolean };
  const loanOuts: Out[] = r ? [...cards.map(cd => ({ key: `L:${cd.kind}`, label: ACT[cd.kind].doc, note: cd.why, href: api.pdf(ACT[cd.kind].pdf, { week: w, loan: r.loan.id, book }), kind: ACT[cd.kind].pdf, loan: r.loan.id, pdf: true, rec: cd.rec })),
    { key: "L:memo", label: o("memo"), note: o("memoB"), href: api.pdf("loan_memo", { week: w, loan: r.loan.id, book }), kind: "loan_memo", loan: r.loan.id, pdf: true, rec: false },
    { key: "L:soil", label: o("soil"), note: o("soilB"), href: api.pdf("soil_sensors", { week: w, loan: r.loan.id, book }), kind: "soil_sensors", loan: r.loan.id, pdf: true, rec: false }] : [];
  const pfOuts: Out[] = [
    { key: "P:prov", label: t("ac.r.prov") + (whole ? "" : ` (${o("wholeBook")})`), note: t("ac.r.provB"), href: api.pdf("portfolio", { week: w, book }), kind: "portfolio", loan: null, pdf: true, rec: false },
    { key: "P:ew", label: t("ac.r.ew") + (whole ? "" : ` · ${provName}`), note: t("ac.r.ewB"), href: api.pdf("early_warning", { week: w, ids, book }), kind: "early_warning", loan: null, pdf: true, rec: false },
    { key: "P:xl", label: t("ac.r.xl") + (whole ? "" : ` (${o("wholeBook")})`), note: t("ac.r.xlB"), href: api.reportXlsx(w, book), kind: "report_xlsx", loan: null, pdf: false, rec: false },
    { key: "P:par", label: t("ac.r.par") + (whole ? "" : ` (${o("wholeBook")})`), note: t("ac.r.parB"), href: api.parametersXlsx, kind: "parameters_xlsx", loan: null, pdf: false, rec: false },
  ];
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const recKeys = useMemo(() => new Set(loanOuts.filter(x => x.rec).map(x => x.key)), [r?.loan.id, w, lang]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPicked(s => new Set([...[...s].filter(k => !k.startsWith("L:")), ...recKeys])); }, [recKeys]);                                                     // a new loan starts with its recommended documents ticked
  const usable = (x: Out) => !x.pdf || !pdfDown(x.kind);
  const toggle = (k: string) => setPicked(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const chosen = [...loanOuts, ...pfOuts].filter(x => picked.has(x.key) && usable(x));
  const downloadAll = () => chosen.forEach((x, i) => setTimeout(() => {
    const el = document.createElement("a"); el.href = x.href; el.download = ""; document.body.appendChild(el); el.click(); el.remove();
    if (x.pdf) addDoc({ name: x.loan ? `${x.label} ${x.loan}` : x.label, loanId: x.loan, kind: x.kind, week: w, href: x.href });
  }, i * 400));
  const outList = (items: Out[]) => <div className="out-list">{items.map(x => <label key={x.key} className={`out-item ${picked.has(x.key) ? "on" : ""} ${usable(x) ? "" : "off"}`}>
    <input type="checkbox" checked={picked.has(x.key)} disabled={!usable(x)} onChange={() => toggle(x.key)} />
    <span><b>{x.label}</b>{x.rec && <span className="tag accent" style={{ marginLeft: 8 }}>{o("recTag")}</span>}{!usable(x) && <span className="muted small"> · {o("unavail")}</span>}<small>{x.note}</small></span>
    <span className="out-fmt">{x.pdf ? "PDF" : "XLSX"}</span></label>)}</div>;
  const docLabel = (d: GenDoc) => lang === "en" ? d.name : `${pdfKindLabel(d.kind)}${d.loanId ? " " + d.loanId : ""}`;
  const rowsT = cand[type].slice(0, 60);
  const sec = (n: string, h: string, sub: string) => <div className="section-head out-sec"><span>{h}<small>{sub}</small></span><span>{n}</span></div>;

  return <>
    <PageHead tag={t("ac.tag")} title={<>{t("ac.h1")}<em>{t("ac.h2")}</em></>}>{o("lede")}</PageHead>
    <div className="card out-pick">
      <label htmlFor="out-prov"><b>{o("prov")}</b></label>
      <select id="out-prov" value={prov} onChange={e => setProv(e.target.value)} style={{ flex: "0 1 200px" }}><option value="">{o("allProv")}</option>{provs.map(([k, x]) => <option key={k} value={k}>{x.name} ({x.n})</option>)}</select>
      <label htmlFor="out-loan"><b>{o("pick")}</b><small className="muted">{o("pickSub")}</small></label>
      <select id="out-loan" value={r?.loan.id ?? ""} onChange={e => setSel(e.target.value)}>{ranked.map(x => <option key={x.loan.id} value={x.loan.id}>{x.loan.id} · {x.loan.borrower} · {levelLabel(x.level)} {Math.round(x.score)} · {c("stage")} {x.stage} · {usd(x.ead)}</option>)}</select>
      {r && <button className="link" onClick={() => openLoan(r.loan.id)}>{o("openClimate")} →</button>}
    </div>

    {sec("01", o("s1"), o("s1Sub"))}
    {r ? <>
      <div className="act-grid">{cards.map(cd => <div key={cd.kind} className={`act ${cd.rec ? "rec" : ""}`}>
        <div className="row between"><h4>{ACT[cd.kind].title}</h4>{cd.rec && <span className="tag accent">{p("lc.recommended")}</span>}</div><p>{cd.why}</p></div>)}</div>
    </> : <div className="card"><p className="muted">{t("ac.noActive")}</p></div>}

    {sec("02", o("s2"), o("s2Sub") + scope)}
    <Ifrs9Section rows={rows} whole={whole} />

    {sec("03", o("s3"), o("s3Sub") + scope)}
    <div className="card">
      <div className="row between"><h3 className="chart-h">{ACT[type].title}<small>{t("ac.nLoans", ACT[type].doc, cand[type].length)}</small></h3>
        <div className="segment" style={{ flexWrap: "wrap" }}>{ACT_ORDER.map(k => <button key={k} className={type === k ? "on" : ""} onClick={() => setType(k)}>{lang === "en" ? ACT[k].doc.replace(" memo", "").replace(" notice", "").replace("Insurance ", "Ins. ") : t(`ac.short.${k}`)}</button>)}</div></div>
      {!rowsT.length ? <p className="muted">{t("ac.noNeed")}</p> : <div className="tbl-box mt"><table className="tbl"><thead><tr><th className="l">{c("loanWord")}</th><th>{p("th.stress")}</th><th>{t("rp.th.stage")}</th><th>{t("rp.ecl.out")}</th><th className="l">{p("th.why")}</th></tr></thead>
        <tbody>{rowsT.map(x => <tr key={x.loan.id} className={x.loan.id === r?.loan.id ? "sel" : ""} onClick={() => { setSel(x.loan.id); document.querySelector(".dash-main")?.scrollTo({ top: 0, behavior: "smooth" }); }}><td><b>{x.loan.id}</b><small>{x.loan.borrower}</small></td><td><ScoreBar s={x.score} l={x.level} /></td><td>{x.stage}</td><td>{usd(x.ead)}</td>
          <td className="l wrap muted">{type === "claim" ? t("ac.trigMet", insuranceType(x.loan.insurance!.type)) : type === "insure" ? (x.loan.insurance ? t("ac.notCovMain") : t("ac.noIns")) : recommendAt(x, a).why}</td></tr>)}</tbody></table></div>}
    </div>

    {sec("04", o("s4"), o("s4Sub") + scope)}
    <PdfNote />
    <div className="grid2">
      <div className="card"><div className="row between"><h3 className="chart-h">{r ? o("outLoan", r.loan.id) : o("outLoan", "–")}</h3>
        <div className="row" style={{ gap: 4 }}><button className="link" onClick={() => setPicked(s => new Set([...s, ...recKeys]))}>{o("selRec")}</button><span className="muted">·</span><button className="link" onClick={() => setPicked(s => new Set([...s].filter(k => !k.startsWith("L:"))))}>{o("selNone")}</button></div></div>
        {outList(loanOuts)}</div>
      <div className="card"><h3 className="chart-h">{o("outPf")}</h3>{outList(pfOuts)}</div>
    </div>
    <div className="card mt out-go">
      <button className="primary" disabled={!chosen.length} onClick={downloadAll}>{o("dl", chosen.length)}</button>
      <span className="muted small">{o("multi")}</span>
    </div>
    <div className="card mt"><h3 className="chart-h">{t("ac.docs")}<small>{t("ac.docsSub")}</small></h3>
      {!docs.length ? <p className="muted">{t("ac.nothing")}</p> : <div className="log">{docs.map(d => <div key={d.id}>
        <span className="muted">{d.at}</span>{d.loanId ? <button className="link" style={{ textAlign: "left" }} onClick={() => openLoan(d.loanId!)}>{d.loanId}</button> : <span className="muted">{t("ac.portfolioWord")}</span>}
        <span><b>{docLabel(d)}</b> <span className="muted small">{dayLabel(meta.weeks[d.week])}</span></span><a className="outline btn-s" href={d.href} download>{t("ac.again")}</a></div>)}</div>}
    </div>
    <Assumptions items={[[A("ac.who.h"), A("ac.who.b")], [A("ac.price.h"), A("ac.price.b")], [ACT.insure.doc, t("ac.premNote")], [A("ac.docs.h"), A("ac.docs.b")],
      [A("rp.ecl.h"), A("rp.ecl.b", pct(meta.params.discountRate, 1))], [A("rp.sc.h"), A("rp.sc.b", Object.values(meta.scenarios).map(v => pct(v)).join(" / "))], [p("as.st.h"), p("as.st.b", meta.params.sicrMultiplier)],
      [A("rp.ew.h"), A("rp.ew.b")], [A("rp.pl.h"), A("rp.pl.b")], [A("rp.st.h"), A("rp.st.b", st.years.length)], [A("rp.cal.h"), A("rp.cal.b")]]} />
  </>;
}
