// Small shared pieces and the app context (analysis, week, book, PDF service state, generated documents).
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { LEVEL_COLOR, api, levelLabel, levelOf } from "./data";
import { useC } from "./locales/common";
import { useA } from "./locales/assume";
import type { Analysis, Level } from "./data";

export type Page = "overview" | "ask" | "portfolio" | "loan" | "actions" | "upload" | "method";
export interface GenDoc { id: string; name: string; loanId: string | null; kind: string; week: number; href: string; at: string }
export interface Ctx {
  a: Analysis; w: number; book: string | null; llm: boolean; pdfKinds: string[] | null; docs: GenDoc[]; addDoc: (d: Omit<GenDoc, "id" | "at">) => void;
  sel: string | null; setSel: (id: string | null) => void;
  openLoan: (id: string) => void; go: (p: Page, id?: string | null) => void; setBook: (b: string | null) => void;
}
export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export const Arrow = () => <svg className="arrow-r" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h17M13 5l7 7-7 7" /></svg>;
export const Lv = ({ l, s }: { l: Level; s?: number }) => { useC(); return <span className="lv" style={{ ["--c" as string]: LEVEL_COLOR[l] }}>{levelLabel(l)}{s != null && ` · ${Math.round(s)}`}</span>; };
export const ScoreBar = ({ s, l }: { s: number; l?: Level }) => <span className="score"><span className="bar"><i style={{ width: `${Math.min(100, s)}%`, ["--c" as string]: LEVEL_COLOR[l ?? levelOf(s)] }} /></span><b>{Math.round(s)}</b></span>;
export const ConfBar = ({ c }: { c: number }) => { const t = useC(); return <span className="score" title={`${t("confidence")} ${(c * 100).toFixed(0)}%`}><span className="bar conf"><i style={{ width: `${c * 100}%`, ["--c" as string]: c < 0.5 ? "#9ccfda" : "#2f6f96" }} /></span><b style={{ width: 30 }}>{(c * 100).toFixed(0)}</b></span>; };
export const Kpi = ({ label, value, sub, cls = "" }: { label: string; value: ReactNode; sub?: ReactNode; cls?: string }) => <div className={`kpi ${cls}`}><span>{label}</span><b>{value}</b>{sub && <small>{sub}</small>}</div>;
export const PageHead = ({ tag, title, children, right }: { tag: string; title: ReactNode; children?: ReactNode; right?: ReactNode }) =>
  <div className="page-head"><div><span className="tag accent">{tag}</span><h1 className="display" style={{ marginTop: 12 }}>{title}</h1>{children && <p>{children}</p>}</div>{right}</div>;

/** A download link to a backend PDF. If the PDF service (or this document kind) is not live yet it shows the note instead of failing. */
export function PdfLink({ kind, loan, ids, label, name, cls = "outline btn-s", week }: { kind: string; loan?: string; ids?: string[]; label?: ReactNode; name?: string; cls?: string; week?: number }) {
  const { w, book, pdfKinds, addDoc } = useApp(), t = useC();
  const wk = week ?? w, href = api.pdf(kind, { week: wk, loan, ids, book });
  const down = pdfKinds === null || (pdfKinds.length > 0 && !pdfKinds.includes(kind));
  return <a className={cls} href={href} download title={down ? t("pdfDown") : undefined} aria-disabled={down}
    style={down ? { opacity: 0.55 } : undefined}
    onClick={e => { if (down) { e.preventDefault(); return; } addDoc({ name: name ?? kind, loanId: loan ?? null, kind, week: wk, href }); }}>{label ?? t("generatePdf")}</a>;
}
export function PdfNote({ kind }: { kind?: string }) {
  const { pdfKinds } = useApp(), t = useC();
  if (pdfKinds !== null && (!kind || pdfKinds.includes(kind) || pdfKinds.length === 0)) return null;
  return <p className="notice small no-print" style={{ margin: "10px 0 0" }}>{t("pdfNote")}</p>;
}
/** plain download link (Excel) */
export const FileLink = ({ href, label, cls = "outline btn-s" }: { href: string; label: ReactNode; cls?: string }) => <a className={cls} href={href} download>{label}</a>;

/** foldable "Assumptions & definitions" card at the bottom of a page: one arrow on the card, the items inside are plain text */
export function Assumptions({ items }: { items: [string, ReactNode][] }) {
  const t = useA();
  return <details className="card mt assume assume-quiet">
    <summary>{t("h")}</summary>
    <div className="assume-list">{items.map(([h, b]) => <div key={h} className="assume-item"><h4>{h}</h4><p>{b}</p></div>)}</div>
    <a className="link assume-more" href="/#method">{t("more")} <Arrow /></a>
  </details>;
}
/** CHI 0-100 -> band (CHI v1, Table 3) */
export const fhiWord = (v: number | null | undefined, t: ReturnType<typeof useA>) => v == null ? t("fhi.off") : v < 10 ? t("fhi.poor") : v < 25 ? t("fhi.below") : v < 40 ? t("fhi.stressed") : v < 60 ? t("fhi.normal") : t("fhi.good");
