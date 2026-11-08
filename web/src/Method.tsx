import { Legend, TimeChart } from "./charts";
import { pct, weekLabel, monthOf, cropText } from "./data";
import { useLang } from "./i18n";
import { methodDesc, useM } from "./locales/method";
import { PageHead, useApp } from "./ui";

const MODULES = ["fetch_earth_engine", "crop_calendar", "anomalies", "stress", "analogs", "yield_impact", "ifrs9", "portfolio", "alerts"] as const;
const SRC_ROWS = [0, 1, 2, 3, 4, 5, 6] as const;

/** the backend's yield-model description is a fixed English pattern; ES/PT re-word it, anything unrecognised is shown as sent */
function yieldMethod(m: string, lang: string, t: ReturnType<typeof useM>) {
  if (lang === "en") return m;
  const pooled = m.match(/^pooled (\w+) model \(all regions; own-region LOYO R2 ([\d.]+) too low\): (.*)$/);
  const core = (x: string) => x.replace(/^OLS p50 \+ QuantReg p10\/p90/, lang === "es" ? "MCO p50 + QuantReg p10/p90" : "MQO p50 + QuantReg p10/p90").replace(" on ", ` ${t("val.on")} `).replace("leave-one-year-out", t("val.loyo"));
  return pooled ? t("val.pooled", pooled[1], pooled[2], core(pooled[3])) : core(m);
}

export default function MethodPage() {
  const { a } = useApp(), meta = a.meta, n = meta.weeks.length, t = useM(), lang = useLang();
  const bt = a.validation.backtest, ym = a.validation.yieldModel, p = meta.params;
  const shown = bt.filter(b => b.flagged > 0 && (b.week % 3 === 0 || b.week === meta.asOfDefault));
  const ticks = Array.from({ length: Math.ceil(n / 8) }, (_, i) => i * 8);
  const byW = (f: (b: typeof bt[number]) => number | null) => Array.from({ length: n }, (_, i) => f(bt.find(b => b.week === i) ?? { week: i, flagged: 0, flaggedDefaultRate: null, otherDefaultRate: null, auc: null }));
  const scen = Object.values(meta.scenarios).map(v => pct(v));
  const scenTxt = lang === "en" ? Object.entries(meta.scenarios).map(([k, v]) => `${pct(v)} ${k}`).join(" + ") : t("formulaScen", scen[0], scen[1], scen[2]);
  return <>
    <PageHead tag={t("tag")} title={<>{t("h1")}<em>{t("h2")}</em></>}>{t("lede2")}</PageHead>
    <div className="notice"><b>{t("cav.b")}</b>{t("cav.1")}</div>
    <details className="card mt assume">                {/* "How the score is made": modules + IFRS 9 formulas, folded */}
      <summary>{t("fold")}</summary>
      <div className="grid2">
      {MODULES.map(k => <div className="card prose" key={k}><span className="tag">{t(`m.${k}`)}</span><p>{lang === "en" ? meta.methods[k] ?? "–" : methodDesc(k, meta.methods[k] ?? "–", t)}</p></div>)}
      <div className="card prose"><span className="tag">{t("formula.tag")}</span>
        <div className="formula">{t("formula", p.beta, p.sicrMultiplier, pct(p.discountRate, 0), p.restructuringExtensionMonths ?? 12, scenTxt, p.hysteresis.up, p.hysteresis.down.join("/"))}</div>
        <p>{t("formula.note")}</p></div>
      </div>
    </details>

    <details className="card mt assume"><summary>{t("val.tag")}</summary>
      <p className="muted">{t("val.p")}</p>
      <div className="tbl-box"><table className="tbl"><thead><tr><th className="l">{t("val.region")}</th><th className="l">{t("val.crop")}</th><th>{t("val.n")}</th><th>{t("val.r2")}</th><th>{t("val.mae")}</th><th className="l">{t("val.method")}</th></tr></thead>
        <tbody>{ym.map(y => <tr key={y.regionId + y.crop} style={{ cursor: "default" }}><td>{meta.regions.find(r => r.id === y.regionId)?.name ?? y.regionId}</td><td className="l">{meta.crops[y.crop] ? cropText(meta, y.crop) : y.crop}</td><td>{y.n}</td><td>{y.r2Loyo == null ? "–" : y.r2Loyo.toFixed(2)}</td><td>{y.maeLoyo == null ? "–" : pct(y.maeLoyo, 1)}</td><td className="l wrap muted">{yieldMethod(y.method, lang, t)}</td></tr>)}</tbody></table></div></details>

    <details className="card mt assume"><summary>{t("bt.tag")}</summary>
      <p className="muted">{t("bt.p")}</p>
      <TimeChart n={n} yMin={0} yMax={1} lines={[{ label: "AUC", values: byW(b => b.auc), color: "#111", width: 3 }, { label: t("bt.flaggedRate"), values: byW(b => b.flaggedDefaultRate), color: "#b8401a" }, { label: t("bt.otherRate"), values: byW(b => b.otherDefaultRate), color: "#3f86ab" }]}
        marker={{ x: meta.asOfDefault, label: t("bt.marker") }} xTicks={ticks} tickText={i => `${monthOf(meta.weeks[i])} ${meta.weeks[i].slice(2, 4)}`} xLabel={i => weekLabel(meta.weeks[i], true)} h={230} fmt={v => v.toFixed(2)} />
      <Legend items={[{ label: "AUC", color: "#111" }, { label: t("bt.flaggedRate"), color: "#b8401a" }, { label: t("bt.otherRate"), color: "#3f86ab" }]} />
      <div className="tbl-box mt" style={{ maxHeight: 360 }}><table className="tbl"><thead><tr><th className="l">{t("bt.asOf")}</th><th>{t("bt.flagged")}</th><th>{t("bt.flaggedRate")}</th><th>{t("bt.otherRate")}</th><th>AUC</th></tr></thead>
        <tbody>{shown.map(b => <tr key={b.week} className={b.week === meta.asOfDefault ? "sel" : ""} style={{ cursor: "default" }}><td>{weekLabel(meta.weeks[b.week], true)}</td><td>{b.flagged}</td><td>{b.flaggedDefaultRate == null ? "–" : pct(b.flaggedDefaultRate, 1)}</td><td>{b.otherDefaultRate == null ? "–" : pct(b.otherDefaultRate, 1)}</td><td>{b.auc == null ? "–" : b.auc.toFixed(2)}</td></tr>)}</tbody></table></div></details>

    <details className="card mt assume"><summary>{t("src.tag")}</summary>
      <div className="table-scroll mt"><table className="tbl"><thead><tr><th className="l">{t("src.signal")}</th><th className="l">{t("src.source")}</th><th className="l">{t("src.access")}</th><th className="l">{t("src.used")}</th></tr></thead><tbody>{SRC_ROWS.map(i => <tr key={i} style={{ cursor: "default" }}><td>{t(`src.${i}`)}</td><td className="l wrap">{t(`src.${i}s`)}</td><td className="l">{t(`src.${i}a`)}</td><td className="l">{t(`src.${i}u`)}</td></tr>)}</tbody></table></div></details>
  </>;
}

