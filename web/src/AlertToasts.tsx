// Bottom-right alert pop-ups (max 8): shows the most stressed new/worse alerts of the week with a shared banker comment space.
import { useCallback, useEffect, useMemo, useState } from "react";
import { alertsWindow, byStress, cropText, LEVEL_COLOR, perilLabel, rowsAt } from "./data";
import type { Row } from "./data";
import { useAl } from "./locales/alerts";
import { Lv, useApp } from "./ui";

interface Note { id: string; loanId: string; week: number; author: string; response: string; actionPlan: string; status: "open" | "in_progress" | "done"; at: string }
const MAX = 8, DISMISS_KEY = "loanly.alerts.dismissed", LOCAL_KEY = "loanly.alerts.notes", NAME_KEY = "loanly.alerts.name";
const read = (st: Storage | undefined, k: string): string | null => { try { return st?.getItem(k) ?? null; } catch { return null; } };
const write = (st: Storage | undefined, k: string, v: string) => { try { st?.setItem(k, v); } catch { /* storage blocked */ } };
const store = (which: "local" | "session") => { try { return which === "local" ? localStorage : sessionStorage; } catch { return undefined; } };
const jsonArr = <T,>(s: string | null): T[] => { try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
const cut = (s: string, n = 110) => s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;

export default function AlertToasts() {
  const { a, w, openLoan } = useApp(), t = useAl();
  const [dismissed, setDismissed] = useState<string[]>(() => jsonArr<string>(read(store("session"), DISMISS_KEY)));
  const [folded, setFolded] = useState(false), [openId, setOpenId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]), [offline, setOffline] = useState(false);

  useEffect(() => {
    const local = jsonArr<Note>(read(store("local"), LOCAL_KEY));
    fetch("/api/alert-notes").then(r => r.ok ? r.json() : Promise.reject()).then(j => setNotes([...(j.notes as Note[]), ...local])).catch(() => { setNotes(local); setOffline(true); });
  }, []);

  const items = useMemo(() => {
    const rows = new Map(rowsAt(a, w).map(r => [r.loan.id, r])), seen = new Set<string>(), out: { al: (typeof a.alerts)[number]; r: Row }[] = [];
    for (const al of alertsWindow(a, w)) {
      const r = rows.get(al.loanId);
      if (al.kind === "better" || !r || seen.has(al.loanId)) continue;
      seen.add(al.loanId); out.push({ al, r });
    }
    return out.sort((x, y) => byStress(x.r, y.r)).slice(0, MAX);
  }, [a, w]);
  const shown = items.filter(x => !dismissed.includes(x.al.loanId));

  const dismiss = useCallback((id: string) => setDismissed(d => { const n = [...d, id]; write(store("session"), DISMISS_KEY, JSON.stringify(n)); return n; }), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenId(null); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, []);

  if (!shown.length) return null;
  if (folded) return <div className="toasts no-print"><button className="toast-pill" onClick={() => setFolded(false)}>{t("pill", shown.length)}</button></div>;
  return <div className="toasts no-print" role="region" aria-label={t("chip", shown.length)}>
    <button className="toast-chip" onClick={() => setFolded(true)}>{t("chip", shown.length)} · {t("collapse")}</button>
    {shown.map(({ al, r }) => {
      const id = al.loanId, open = openId === id, mine = notes.filter(n => n.loanId === id).sort((x, y) => y.at.localeCompare(x.at));
      return <div key={id} className="toast" style={{ ["--c" as string]: LEVEL_COLOR[r.level] }} data-level={r.level}>
        <div className="row between" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <b>{id} · {r.loan.borrower}</b>
          <button className="toast-x" onClick={() => dismiss(id)} aria-label={`${t("dismiss")} ${id}`}>×</button>
        </div>
        <div className="toast-meta"><Lv l={al.from} /> → <Lv l={al.to} s={al.score} /><span className="muted small">{r.main ? perilLabel(r.main) : ""} · {cropText(a.meta, r.loan.crop)}</span></div>
        <p className="small muted" style={{ margin: "4px 0 6px" }}>{cut(al.explanation)}</p>
        <div className="row" style={{ gap: 6 }}>
          <button className="outline btn-s" onClick={() => openLoan(id)}>{t("open")}</button>
          <button className="outline btn-s" aria-expanded={open} onClick={() => setOpenId(open ? null : id)}>{t("respond")}{mine.length ? ` (${mine.length})` : ""}</button>
        </div>
        {open && <Respond loanId={id} week={w} notes={mine} offline={offline} onSaved={(n, off) => { setNotes(x => [...x, n]); if (off) setOffline(true); }} />}
      </div>;
    })}
  </div>;
}

function Respond({ loanId, week, notes, offline, onSaved }: { loanId: string; week: number; notes: Note[]; offline: boolean; onSaved: (n: Note, offline: boolean) => void }) {
  const t = useAl();
  const [author, setAuthor] = useState(() => read(store("local"), NAME_KEY) ?? ""), [response, setResponse] = useState(""), [plan, setPlan] = useState("");
  const [status, setStatus] = useState<Note["status"]>("open"), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const uid = `n-${loanId}`;
  const save = async () => {
    if (!response.trim() && !plan.trim()) { setErr(t("empty")); return; }
    setErr(""); setBusy(true); write(store("local"), NAME_KEY, author);
    const body = { loanId, week, author, response, actionPlan: plan, status };
    try {
      const r = await fetch("/api/alert-notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), j = await r.json();
      if (!r.ok) { setErr(j.error ?? "error"); return; }
      onSaved(j.note, false);
    } catch {
      const n: Note = { ...body, id: `local-${Date.now()}`, at: new Date().toISOString() };
      write(store("local"), LOCAL_KEY, JSON.stringify([...jsonArr<Note>(read(store("local"), LOCAL_KEY)), n])); onSaved(n, true);
    } finally { setBusy(false); }
    setResponse(""); setPlan("");
  };
  return <div className="toast-form">
    <div className="toast-notes" aria-label={t("notes")}>{notes.length ? notes.map(n => <div key={n.id} className="toast-note">
      <small className="muted">{n.author || "–"} · {new Date(n.at).toLocaleString()} · {t(n.status === "open" ? "open_" : n.status)}</small>
      {n.response && <p>{n.response}</p>}{n.actionPlan && <p><b>{t("plan")}:</b> {n.actionPlan}</p>}</div>) : <p className="muted small">{t("none")}</p>}</div>
    <label htmlFor={`${uid}-a`}>{t("name")}</label><input id={`${uid}-a`} value={author} maxLength={60} onChange={e => setAuthor(e.target.value)} />
    <label htmlFor={`${uid}-r`}>{t("response")}</label><textarea id={`${uid}-r`} rows={2} maxLength={2000} value={response} onChange={e => setResponse(e.target.value)} />
    <label htmlFor={`${uid}-p`}>{t("plan")}</label><textarea id={`${uid}-p`} rows={2} maxLength={2000} placeholder={t("planPh")} value={plan} onChange={e => setPlan(e.target.value)} />
    <div className="row" style={{ gap: 8 }}>
      <label htmlFor={`${uid}-s`} className="sr-only">{t("status")}</label>
      <select id={`${uid}-s`} value={status} onChange={e => setStatus(e.target.value as Note["status"])}><option value="open">{t("open_")}</option><option value="in_progress">{t("in_progress")}</option><option value="done">{t("done")}</option></select>
      <button className="primary btn-s" disabled={busy} onClick={save}>{t("save")}</button></div>
    {err && <p className="small" role="alert" style={{ color: "#b8401a", margin: 0 }}>{err}</p>}
    {(offline || notes.some(n => n.id.startsWith("local-"))) && <p className="muted small" style={{ margin: 0 }}>{t("local")}</p>}
  </div>;
}
