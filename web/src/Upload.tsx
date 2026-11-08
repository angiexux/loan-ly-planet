// "Upload or update your portfolio" card (shown on the Portfolio page): xlsx/csv upload to the backend, CSV template download.
import { useEffect, useRef, useState } from "react";
import { TEMPLATE_COLUMNS, api, download, toCsv } from "./data";
import { useAk } from "./locales/ask";
import { useL } from "./locales/landing";
import { FileLink, useApp } from "./ui";

const errText = (e: unknown) => (typeof e === "string" ? e : e && typeof e === "object" ? Object.values(e as Record<string, unknown>).map(String).join(" · ") : String(e));

export default function UploadCard() {
  const { a, book, setBook } = useApp(), t = useAk(), lg = useL();
  const [over, setOver] = useState(false), [errors, setErrors] = useState<string[]>([]), [msg, setMsg] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [xlsxTemplate, setXlsxTemplate] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { fetch(api.templateXlsx).then(r => setXlsxTemplate(r.ok && !/json|html/.test(r.headers.get("content-type") ?? ""))).catch(() => setXlsxTemplate(false)); }, []);
  const upload = (f: File) => {
    if (!/\.(xlsx|xlsm|csv)$/i.test(f.name)) { setErrors([t("up.badType")]); setMsg(null); return; }
    setBusy(true); setErrors([]); setMsg(t("up.uploading", f.name));
    const fd = new FormData(); fd.append("file", f, f.name);
    fetch("/api/upload", { method: "POST", body: fd }).then(async r => {
      const j = await r.json().catch(() => ({ ok: false, errors: [t("up.http", r.status)] }));
      if (j.ok && j.bookId) { setMsg(`${t("up.loaded", j.loans, f.name)}${j.warnings?.length ? " " + j.warnings.slice(0, 2).map(errText).join(" ") : ""}`); setBook(j.bookId); }
      else { setMsg(null); setErrors(((j.errors?.length ? j.errors : [j.error ?? t("up.failed")]) as unknown[]).map(errText)); }
    }).catch(() => { setMsg(null); setErrors([t("up.noBackend")]); }).finally(() => setBusy(false));
  };
  const template = () => download("loanly_loan_template.csv", toCsv([TEMPLATE_COLUMNS, ["L900", "F900", "P900", -32.95, -60.65, "soy", "2025-11-20", 450, 190000, "2025-10-15", "2026-05-30", 9.5, 0.03, 0.4, "crop pledge", 1, 0]]));

  return <>
      <div className="card ask-upload no-print" id="upload">
        <h3 className="chart-h">{t("up.h")}<small>{t("up.sub")}</small></h3>
        <label className={`drop ${over ? "on" : ""}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) upload(f); }}>
          <p style={{ margin: 0, fontWeight: 600 }}>{busy ? <><span className="spin" /> {t("up.running")}</> : t("up.drop")}</p>
          <input ref={fileRef} type="file" accept=".csv,text/csv,.xlsx,.xlsm" hidden onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
        </label>
        <div className="row up-tpl"><button className="outline btn-s" onClick={template}>{t("up.tpl")}</button>
          {xlsxTemplate ? <FileLink href={api.templateXlsx} label={t("up.xlsxTpl")} /> : null}</div>
        {msg && <p className="notice info small" >{msg}</p>}
        {errors.length > 0 && <div className="notice small" >{errors.slice(0, 12).map((e, i) => <div key={i}>{e}</div>)}{errors.length > 12 && <div>{t("up.more", errors.length - 12)}</div>}</div>}
        {book && <p className="notice small" >{lg("viewingBook", a.loans.length)}<button className="link" onClick={() => setBook(null)}>{lg("backDemo")}</button></p>}
      </div>
  </>;
}
