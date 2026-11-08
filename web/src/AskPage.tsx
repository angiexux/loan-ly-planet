import { useEffect, useMemo, useRef, useState } from "react";
import { TEMPLATE_COLUMNS, api, cropText, download, loanById, pct, perilLabel, rowsAt, sgnUsd, toCsv, usd } from "./data";
import type { Row } from "./data";
import { EXAMPLES, examplesFor, parseAsk, portfolioPreset } from "./ask";
import type { AskAnswer, AskPdf, AskResult } from "./ask";
import { useLang } from "./i18n";
import { useAk } from "./locales/ask";
import { insuranceType, useC } from "./locales/common";
import { K } from "./locales/credit";
import { useL } from "./locales/landing";
import { useP } from "./locales/pages";
import { useA } from "./locales/assume";
import { Arrow, Assumptions, ConfBar, FileLink, Kpi, PageHead, PdfLink, PdfNote, ScoreBar, useApp } from "./ui";

const errText = (e: unknown) => (typeof e === "string" ? e : e && typeof e === "object" ? Object.values(e as Record<string, unknown>).map(String).join(" · ") : String(e));

export default function AskPage({ asked, setAsked, hist, setHist, toPortfolio }: {
  asked: string | null; setAsked: (s: string | null) => void; hist: string[]; setHist: (h: string[]) => void; toPortfolio: (pr: { crop?: string; region?: string; stressed?: boolean }) => void;
}) {
  const { a, w, book, llm, setBook, openLoan } = useApp(), t = useAk(), c = useC(), p = useP(), lg = useL(), lang = useLang(), A = useA();
  const [text, setText] = useState(asked ?? "");
  const [remote, setRemote] = useState<{ q: string; res: AskResult } | null>(null), [asking, setAsking] = useState(false);

  const local = useMemo<AskResult | null>(() => (asked ? parseAsk(asked, a, w) : null), [asked, a, w, lang]);
  const res = remote && remote.q === asked ? remote.res : local;
  const examples = useMemo(() => examplesFor(a, w), [a, w, lang]);

  const run = (q: string) => {
    const s = q.trim(); if (!s) return;
    setText(s); setAsked(s); setHist([s, ...hist.filter(h => h !== s)].slice(0, 5)); setRemote(null);
    if (llm) {
      setAsking(true);
      fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: s, week: w, book }) })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((j: AskResult) => { if (j?.answer?.headline) setRemote({ q: s, res: j }); })
        .catch(() => { /* local parser answer stays */ }).finally(() => setAsking(false));
    }
    setTimeout(() => document.getElementById("ask-answer")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const example = () => setText(examples[Math.floor(Math.random() * examples.length)]);


  const ans: AskAnswer | undefined = res?.answer;
  const byId = useMemo(() => new Map(rowsAt(a, res?.query.week ?? w).map(r => [r.loan.id, r])), [a, w, res]);
  const list = (ans?.loanIds ?? []).map(i => byId.get(i)).filter((r): r is Row => !!r);
  const pdf = useMemo(() => {                                     // a PDF button when the answer carries one, or the question was a report
    if (!res || !ans) return null;
    const p = ans.pdf as AskPdf | string | null | undefined, rk = res.query.report;
    if (typeof p === "string") return { href: p };
    if (p && typeof p === "object" && "url" in (p as object)) return { href: String((p as unknown as { url: string }).url) };
    if (p && typeof p === "object") return { pdf: p };
    if (res.query.intent === "report" || rk) return { pdf: { kind: rk ?? "early_warning", loan: res.query.filters.loanIds?.[0], ids: ans.loanIds } as AskPdf };
    return null;
  }, [res, ans]);

  return <>
    <PageHead tag={t("tag")} title={<>{t("h1")}<em>{t("h2")}</em></>}>{t("lede")}</PageHead>
    <div className="ask-single">
      <div className="stack">
        <div className="card ask-card no-print">
          <h3 className="chart-h">{t("q.h")}<small>{t("q.sub")}</small></h3>
          <textarea className="ask-box" value={text} onChange={e => setText(e.target.value)} rows={4} aria-label={t("q.aria")}
            placeholder={t("q.ph")}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(text); } }} />
          <div className="row between ask-foot"><span className="muted small">{t("q.hint")}</span>
            <div className="row"><button className="outline btn-s" onClick={example}>{t("q.example")}</button><button className="primary btn-s" disabled={!text.trim() || asking} onClick={() => run(text)}>{asking ? t("q.asking") : <>{t("q.ask")} <Arrow /></>}</button></div></div>
          {hist.length > 0 && <div className="ask-hist"><span className="muted small">{t("q.recent")}</span>{hist.map(h => <button key={h} className="chip" onClick={() => run(h)} title={h}>{h}</button>)}</div>}
        </div>
      </div>
    </div>

    {res && ans && <div id="ask-answer" className="ask-answer">
      <div className="card ask-understood"><h3 className="chart-h">{t("an.h")}<small>{t("an.sub")}</small></h3>
        <div className="chips">{res.understood.map(u => <span className="chip static" key={u}>{u}</span>)}</div></div>
      <div className="card mt">
        <h2 className="ask-headline">{ans.headline}</h2>
        {ans.kpis.length > 0 && <div className="kpis mt">{ans.kpis.map((k, i) => <Kpi key={k.label} label={k.label} value={k.value} cls={i === Math.min(2, ans.kpis.length - 1) ? "hot" : ""} />)}</div>}
        {ans.table && <div className="table-scroll"><table className="tbl"><thead><tr>{ans.table.columns.map((c, i) => <th key={c} className={i === 0 ? "l" : ""}>{c}</th>)}</tr></thead>
          <tbody>{ans.table.rows.map((r, i) => <tr key={i} style={{ cursor: "default" }}>{r.map((c, j) => <td key={j} className={j === 0 ? "l" : ""}>{c}</td>)}</tr>)}</tbody></table></div>}
        {list.length > 0 && <div className="tbl-box mt"><table className="tbl">
          <thead><tr><th className="l">{p("th.loan")}</th><th className="l">{p("th.regionCrop")}</th><th>{p("th.stress")}</th><th>{p("th.conf")}</th><th className="l">{p("th.why")}</th><th>{p("th.outstanding")}</th><th>{p("th.pd")}</th><th>{p("th.ifrs")}</th><th>{p("th.dEcl")}</th><th className="l">{p("th.ins")}</th></tr></thead>
          <tbody>{list.map(r => <tr key={r.loan.id} onClick={() => openLoan(r.loan.id)}>
            <td><b>{r.loan.id}</b>{r.loan.uploaded && <span className="flag-pill" style={{ marginLeft: 6 }}>{c("uploaded")}</span>}<small>{r.loan.borrower}</small></td>
            <td className="l">{r.loan.region}<small>{cropText(a.meta, r.loan.crop)} · {r.loan.areaHa.toLocaleString()} ha</small></td>
            <td><ScoreBar s={r.score} l={r.level} /></td><td><ConfBar c={r.conf} /></td>
            <td className="l wrap">{r.main && <b>{perilLabel(r.main)}: </b>}<span className="muted">{r.why || K("r.normal")}</span></td>
            <td>{usd(r.ead)}</td><td>{pct(r.loan.pdOrig, 1)} → <b>{pct(r.pd12, 1)}</b></td><td>{c("stage")} {r.stage}</td><td>{sgnUsd(r.eclDelta)}</td>
            <td className="l">{r.loan.insurance ? insuranceType(r.loan.insurance.type) : <span className="muted">{c("none")}</span>}</td></tr>)}</tbody></table></div>}
        {ans.notes.length > 0 && <ul className="reason-list ask-notes">{ans.notes.map(n => <li key={n} className="muted small">{n}</li>)}</ul>}
        {ans.suggestions.length > 0 && <div className="ask-hist no-print"><span className="muted small">{t("an.next")}</span>{ans.suggestions.map(s => <button key={s} className="chip" onClick={() => run(s)}>{s}</button>)}</div>}
        <div className="row mt no-print"><button className="primary btn-s" onClick={() => toPortfolio(portfolioPreset(res.query))}>{t("an.map")}</button>
          {pdf && ("href" in pdf && pdf.href ? <a className="outline btn-s" href={pdf.href} download>{t("an.pdf")}</a> : pdf.pdf && <PdfLink kind={pdf.pdf.kind} loan={pdf.pdf.loan} ids={pdf.pdf.ids} label={t("an.pdf")} name={`${pdf.pdf.kind.replace(/_/g, " ")}${pdf.pdf.loan ? " " + pdf.pdf.loan : ""}`} />)}
          <button className="outline btn-s" onClick={() => window.print()}>{t("an.print")}</button></div>
        {pdf && "pdf" in pdf && pdf.pdf && <PdfNote kind={pdf.pdf.kind} />}
      </div>
    </div>}

    <h3 className="chart-h mt no-print" style={{ margin: "28px 0 4px" }}>{t("an.try")}</h3>
    {([["an.exClimate", examples.slice(0, 4)], ["an.exFinance", examples.slice(4, 8)]] as const).map(([h, list]) => <div key={h} className="no-print">
      <h4 className="ex-group">{t(h)}</h4>
      <div className="ask-examples">{list.map(e => <button key={e} className="card ask-ex" onClick={() => run(e)}>{e}</button>)}</div></div>)}
    <Assumptions items={[[A("ask.how.h"), A("ask.how.b")]]} />
  </>;
}
void EXAMPLES; void loanById;
