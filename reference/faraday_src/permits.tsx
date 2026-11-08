// Air permits for the onsite gas in each optimiser portfolio, at a proposed Texas site (Texas only; other states need their own rules).
// Steps: classify each resource -> site attainment -> potential to emit -> federal overlay -> limits (hours caps) -> timeline -> fees -> obligations.
// Every rule is stored as data with its citation and the date it was last verified.
import { useState } from "react";
import type { RunSum, Scenario, SiteRow } from "./thesisApi";

const VERIFIED = "2026-11-05";
export interface Rule { id: string; citation: string; trigger: string; output: string; effective: string; verified: string; url?: string }
export const RULES: Rule[] = [
  { id: "nsr", citation: "30 TAC Ch. 116, Subchapter B (New Source Review permits)", trigger: "New onsite gas units (turbines, engines, fuel cells) or diesel backup", output: "A construction permit before building; minor NSR unless a major-source threshold is crossed", effective: "current TAC", verified: VERIFIED, url: "https://www.law.cornell.edu/regulations/texas/title-30/part-1/chapter-116/subchapter-B" },
  { id: "std", citation: "30 TAC Ch. 116, Subchapter F; TCEQ Air Quality Standard Permit for Natural Gas Electric Generating Units", trigger: "Natural gas EGUs that meet the standard permit's conditions", output: "Standard permit instead of a case-by-case NSR permit: 2-7 days of review, no public notice (Public Citizen)", effective: "30 Jan 2025 (standard permit)", verified: VERIFIED },
  { id: "pbr", citation: "30 TAC Ch. 106 (permits by rule)", trigger: "Small units and diesel backup generators", output: "Permit by rule registration; no public notice", effective: "current TAC", verified: VERIFIED },
  { id: "psd", citation: "40 CFR 52.21 (PSD), incorporated through 30 TAC Ch. 116", trigger: "Potential to emit ≥ 250 tpy of a regulated pollutant in an attainment area", output: "PSD review: BACT, air-quality modelling, public notice; fee under §116.163", effective: "federal", verified: VERIFIED },
  { id: "nnsr", citation: "Nonattainment NSR, 30 TAC Ch. 116 (Division 5) and Clean Air Act §182", trigger: "NOx or VOC potential to emit above the area's threshold: Marginal/Moderate 100, Serious 50, Severe 25, Extreme 10 tpy", output: "Lowest achievable emission rate and emission offsets (Serious 1.2:1, Severe 1.3:1, Extreme 1.5:1)", effective: "federal + SIP", verified: VERIFIED },
  { id: "titlev", citation: "30 TAC Ch. 122 (Federal Operating Permits, Title V)", trigger: "≥ 100 tpy of a criteria pollutant, or the nonattainment major-source threshold", output: "Title V operating permit; low-use turbines exempt under EPA's 2026 turbine rule", effective: "current TAC", verified: VERIFIED },
  { id: "nsps_ct", citation: "EPA NSPS for stationary combustion turbines, 91 Fed. Reg. 1910 (15 Jan 2026)", trigger: "New gas turbines", output: "Combustion controls for NOx; SCR for large, high-use turbines; temporary-turbine subcategory", effective: "2026", verified: VERIFIED },
  { id: "nsps_ice", citation: "40 CFR 60 Subpart JJJJ (spark-ignition engines) and 40 CFR 63 Subpart ZZZZ (engine MACT)", trigger: "New natural gas reciprocating engines", output: "Engine emission standards, performance testing, maintenance records", effective: "federal", verified: VERIFIED },
  { id: "sched", citation: "30 TAC §116.114 (application review schedule)", trigger: "Any NSR application", output: "Completeness notice ≤ 90 days; preliminary decision ≤ 180 days; final action on PSD/nonattainment ≤ 1 year after a complete application", effective: "current TAC", verified: VERIFIED, url: "https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-116-114" },
  { id: "notice", citation: "30 TAC Ch. 116, Subchapter B, Division 3 (public notice)", trigger: "NSR, PSD and nonattainment applications", output: "Notice of receipt and of the preliminary decision, a 30-day comment period, possible contested case hearing", effective: "current TAC", verified: VERIFIED },
  { id: "fee", citation: "30 TAC §116.141 (permit fees)", trigger: "Any NSR permit (PSD fees: §116.163)", output: "$900 under $300,000 of capital cost; otherwise 0.30% of capital cost, maximum $75,000", effective: "current TAC", verified: VERIFIED, url: "https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-116-141" },
  { id: "conditions", citation: "30 TAC §116.115 (general and special conditions)", trigger: "Every issued permit", output: "Emission caps, hours or fuel limits, monitoring, recordkeeping, operational certification; amendments if the design changes", effective: "current TAC", verified: VERIFIED },
];

// Screening emission factors, lb per MMBtu of fuel (HHV), with typical BACT controls. AP-42 typical values; confirm against vendor guarantees.
const EF: Record<string, { label: string; controls: string; nox: number; co: number; voc: number; pm: number; so2: number; hr: number; capex: number }> = {
  gas_turbine: { label: "Gas turbine", controls: "dry low-NOx + SCR, oxidation catalyst", nox: 0.009, co: 0.0045, voc: 0.0021, pm: 0.0066, so2: 0.0034, hr: 9.447, capex: 1606 },
  gas_engine: { label: "Gas engines", controls: "lean-burn + SCR (≈90% NOx), oxidation catalyst (≈90% CO)", nox: 0.41, co: 0.032, voc: 0.059, pm: 0.0099, so2: 0.000588, hr: 8.454, capex: 2400 },
  fuel_cell: { label: "Fuel cell (natural gas)", controls: "none needed (no combustion)", nox: 0.0015, co: 0.008, voc: 0.001, pm: 0.0005, so2: 0.0006, hr: 6.5, capex: 4000 },
};
const POLL: [keyof typeof EF["gas_turbine"] & string, string][] = [["nox", "NOx"], ["co", "CO"], ["voc", "VOC"], ["pm", "PM"], ["so2", "SO₂"]];
const NA: [string, string][] = [["utility_solar", "Solar contract"], ["wind", "Wind contract"], ["nuclear", "Nuclear PPA"], ["battery_4h", "Battery (4 h)"]];

/** Ozone class from the EPA Green Book text for the site, and the NOx/VOC major-source threshold that follows. */
function ozone(att: string) {
  const a = att.toLowerCase();
  const cls = a.includes("extreme") ? "Extreme" : a.includes("severe") ? "Severe" : a.includes("serious") ? "Serious" : a.includes("moderate") ? "Moderate" : a.includes("marginal") ? "Marginal" : null;
  const tpy = cls === "Extreme" ? 10 : cls === "Severe" ? 25 : cls === "Serious" ? 50 : cls ? 100 : null;
  const offset = cls === "Extreme" ? 1.5 : cls === "Severe" ? 1.3 : cls === "Serious" ? 1.2 : cls === "Moderate" ? 1.15 : cls === "Marginal" ? 1.1 : null;
  return { cls, tpy, offset };
}
const tons = (mw: number, hr: number, ef: number, hours: number) => (mw * hr * ef * hours) / 2000;
const f = (v: number, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

export function permitFor(run: RunSum, site: SiteRow | undefined) {
  const att = String(site?.land?.facts?.find(x => x.key === "attainment")?.value ?? "");
  const oz = ozone(att);
  const rows = (Object.keys(EF) as (keyof typeof EF)[]).filter(r => (run.caps ?? {})[r] > 0).map(r => {
    const mw = run.caps![r], e = EF[r];
    const pte = Object.fromEntries(POLL.map(([k]) => [k, tons(mw, e.hr, e[k] as number, 8760)])) as Record<string, number>;
    const byYear = run.gasMwhByYear?.[r] ?? [];
    const maxMwh = byYear.length ? Math.max(...byYear) : null;
    const actual = maxMwh == null ? null : Object.fromEntries(POLL.map(([k]) => [k, (maxMwh * e.hr * (e[k] as number)) / 2000])) as Record<string, number>;
    const hoursRun = maxMwh == null ? null : maxMwh / mw;
    return { r, label: e.label, controls: e.controls, mw, pte, actual, hoursRun, capexM: (mw * 1000 * e.capex) / 1e6 };
  });
  const sum = (k: string, w: "pte" | "actual") => rows.reduce((a, x) => a + ((x[w] as Record<string, number> | null)?.[k] ?? 0), 0);
  const pteT = Object.fromEntries(POLL.map(([k]) => [k, sum(k, "pte")])) as Record<string, number>;
  const actT = rows.every(x => x.actual) ? Object.fromEntries(POLL.map(([k]) => [k, sum(k, "actual")])) as Record<string, number> : null;
  // which thresholds the portfolio's potential to emit crosses
  const nnsr = oz.tpy != null && (pteT.nox >= oz.tpy || pteT.voc >= oz.tpy);
  const psd = Math.max(pteT.nox, pteT.co, pteT.pm, pteT.so2, oz.cls ? 0 : pteT.voc) >= 250;
  const titleV = Math.max(pteT.nox, pteT.co, pteT.voc, pteT.pm, pteT.so2) >= 100 || nnsr;
  // to stay minor, the permit can cap hours: the binding pollutant sets the cap
  const limits: [string, number][] = [["nox", oz.tpy ?? 250], ["voc", oz.tpy ?? 250], ["co", 250]];
  const perHour = (k: string) => rows.reduce((a, x) => a + tons(x.mw, EF[x.r].hr, EF[x.r][k as "nox"] as number, 1), 0);
  const capHours = Math.min(8760, ...limits.map(([k, t]) => (perHour(k) > 0 ? t / perHour(k) : 8760)));
  const runHours = rows.length && actT ? Math.max(...rows.map(x => x.hoursRun ?? 0)) : null;
  const major = nnsr || psd;
  const synthetic = major && runHours != null && runHours <= capHours;
  const pathway = !rows.length ? "No air permit for onsite generation" : !major ? "Minor source: standard permit (Subchapter F) if the units qualify, otherwise minor NSR (Subchapter B)"
    : synthetic ? `Synthetic minor: accept a cap of ${f(capHours)} hours a year in the permit (the portfolio ran at most ${f(runHours!)} h)`
    : [nnsr && `Nonattainment NSR (${oz.cls}, ${oz.tpy} tpy NOx/VOC, offsets ${oz.offset}:1)`, psd && "PSD (≥ 250 tpy)"].filter(Boolean).join(" + ");
  const route = !rows.length ? "none" : !major ? "minor" : synthetic ? "synthetic" : "major";
  const months: Record<string, [number, number, string]> = {
    none: [0, 0, ""], minor: [1, 3, "Standard permit: 2-7 days of review after application prep; minor NSR: up to 90 days for completeness and 180 days for a preliminary decision (§116.114)."],
    synthetic: [6, 9, "Minor NSR with enforceable hours limits: completeness ≤ 90 days, preliminary decision ≤ 180 days (§116.114), then public notice and 30-day comment."],
    major: [12, 18, "PSD / nonattainment: final action within 1 year of a complete application (§116.114), plus preparation, modelling and public notice. Example: Nexus Hubbard paid its fee on 13 Feb 2026 and was technically complete on 17 Sep 2026."],
  };
  const capex = rows.reduce((a, x) => a + x.capexM, 0);
  const fee = !rows.length ? 0 : route === "major" ? null : capex * 1e6 < 300000 ? 900 : Math.min(75000, 0.003 * capex * 1e6);
  return { att, oz, rows, pteT, actT, nnsr, psd, titleV, capHours, runHours, route, pathway, months: months[route], fee, capex };
}

const BLOCK: Record<string, number> = { gas_turbine: 25, gas_engine: 5, fuel_cell: 5 };
type ResPatch = Record<string, Partial<Record<"max_mw" | "available_month", number>>>;

export function AirPermits({ scenarios, sites, onPrefill, availMonths }: { scenarios: Scenario[]; sites: SiteRow[]; onPrefill?: (p: { resources: ResPatch; excluded?: string[]; title?: string }) => void; availMonths?: Record<string, number> }) {
  const runs = scenarios.filter(s => s.run?.resultStatus === "OK");
  const tx = sites.filter(s => s.state === "TX");
  const [sk, setSk] = useState(runs[0]?.key ?? "");
  const [siteId, setSiteId] = useState(tx[0]?.id ?? "");
  if (!runs.length || !tx.length) return null;
  const sc = runs.find(s => s.key === sk) ?? runs[0];
  const site = tx.find(s => s.id === siteId) ?? tx[0];
  const p = permitFor(sc.run!, site);
  return <div className="card th-air"><span className="ag-row"><span className="ag-tag ag-optimisation">Optimisation agent</span><span className="ag-tag ag-moratorium">Policy agent</span><span className="tag">AIR PERMITS · TEXAS</span></span>
    <h3 className="chart-h th-mt">Air permits for the onsite gas <small>from the optimiser's portfolio and its hourly dispatch to the permit pathway, schedule, fee and limits at a proposed site</small></h3>
    <div className="th-air-pick"><label>Portfolio<select value={sc.key} onChange={e => setSk(e.target.value)}>{runs.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
      <label>Site<select value={site.id} onChange={e => setSiteId(e.target.value)}>{tx.map(s => <option key={s.id} value={s.id}>{s.county} County · {s.label.split(",").slice(1).join(",").trim() || s.label}</option>)}</select></label></div>
    <div className="th-air-sum">
      <div className={`th-air-path ${p.route}`}><span>Permit pathway</span><b>{p.pathway}</b></div>
      <div><span>Schedule</span><b>{p.route === "none" ? "–" : `${p.months[0]}–${p.months[1]} months`}</b><small>{p.route === "major" ? "+6–12 months if a contested case hearing is granted" : p.route === "synthetic" ? "+ hearing risk if requested" : ""}</small></div>
      <div><span>Permit fee</span><b>{p.fee == null ? "PSD fee schedule (§116.163)" : `$${f(p.fee)}`}</b><small>{p.fee != null && p.route !== "none" ? `0.30% of ${f(p.capex, 1)} $M onsite gas CAPEX, max $75,000` : ""}</small></div>
      <div><span>Ozone area</span><b>{p.oz.cls ? `${p.oz.cls} · ${p.oz.tpy} tpy` : "Attainment · 250 tpy"}</b><small>{p.att || "–"}</small></div>
    </div>
    <div className="table-scroll"><table className="year-table th-air-t"><thead><tr><th>Resource</th><th>MW</th><th className="l">Controls (typical BACT)</th>{POLL.map(([, l]) => <th key={l}>{l} tpy<small className="detail">potential · actual</small></th>)}<th>Hours run</th></tr></thead>
      <tbody>{p.rows.map(x => <tr key={x.r}><td>{x.label}</td><td>{f(x.mw)}</td><td className="note">{x.controls}</td>
        {POLL.map(([k]) => <td key={k}>{f(x.pte[k], 1)}<small className="detail">{x.actual ? f(x.actual[k], 1) : "–"}</small></td>)}<td>{x.hoursRun == null ? "–" : f(x.hoursRun)}</td></tr>)}
        {p.rows.length > 0 && <tr className="total"><td>Portfolio</td><td>{f(p.rows.reduce((a, x) => a + x.mw, 0))}</td><td />{POLL.map(([k]) => <td key={k}>{f(p.pteT[k], 1)}<small className="detail">{p.actT ? f(p.actT[k], 1) : "–"}</small></td>)}<td>{p.runHours == null ? "–" : f(p.runHours)}</td></tr>}
        {NA.map(([k, l]) => <tr key={k} className="off"><td>{l}</td><td colSpan={8} className="note">No air permit (no combustion). Check ERCOT and local requirements.</td></tr>)}</tbody></table></div>
    <div className="th-air-flags">{[["Nonattainment NSR", p.nnsr], ["PSD", p.psd], ["Title V", p.titleV && !(p.route === "synthetic")], ["Turbine NSPS (2026)", p.rows.some(x => x.r === "gas_turbine")], ["Engine NSPS JJJJ + MACT ZZZZ", p.rows.some(x => x.r === "gas_engine")]].map(([l, on]) => <span key={l as string} className={`th-flag ${on ? "on" : ""}`}>{on ? "✓" : "–"} {l as string}</span>)}</div>
    <div className="th-air-notes">
      <p><b>Limits that feed back into the portfolio.</b> To stay below the major-source thresholds the permit can cap operation at {f(p.capHours)} hours a year for this gas fleet. {p.runHours != null ? (p.runHours <= p.capHours ? `The optimiser ran it at most ${f(p.runHours)} hours in a year, inside that cap.` : `The optimiser ran it ${f(p.runHours)} hours in its busiest year, above the cap: a minor permit would need a smaller or cleaner fleet, or the portfolio must take the major-source route.`) : ""}</p>
      <p><b>Schedule basis.</b> {p.months[2]}</p>
      <p><b>After the permit.</b> General and special conditions (§116.115): emission caps, hours or fuel limits, monitoring and recordkeeping, operational certification. Capacity added in stages may trigger an amendment each time the design changes.</p>
      {onPrefill && (p.route === "major" || p.route === "synthetic") && (() => {
        // the largest gas fleet whose potential to emit (8,760 h) stays below the binding threshold, split in proportion to the current MW
        const f1 = Math.min(1, ...[["nox", p.oz.tpy ?? 250], ["voc", p.oz.tpy ?? 250], ["co", 250]].map(([k, t]) => (p.pteT[k as string] > 0 ? (t as number) * 0.999 / p.pteT[k as string] : 1)));
        // a resource that rounds down to zero blocks is switched off (the form's maximum must be at least one block)
        const minor: ResPatch = {}, drop: string[] = [];
        for (const x of p.rows) { const blocks = Math.floor((x.mw * f1) / BLOCK[x.r] + 1e-9); if (blocks > 0) minor[x.r] = { max_mw: blocks * BLOCK[x.r] }; else drop.push(x.r); }
        const text = p.rows.map(x => `${x.label} ${f(minor[x.r]?.max_mw ?? 0)} MW`).join(", ");
        const noGas = !Object.keys(minor).length;
        const wait = Math.round(2 + p.months[1]);
        const late: ResPatch = {};
        for (const x of p.rows) if (wait > (availMonths?.[x.r] ?? 0)) late[x.r] = { available_month: wait };   // only resources the wait actually delays
        return <>
          <div className="th-wi-run"><p><b>Stay a minor source.</b> This portfolio's potential to emit crosses the major-source threshold ({p.oz.cls ? `${p.oz.tpy} tpy NOx/VOC` : "250 tpy"}). Capping the onsite gas at {noGas ? "less than one block" : text} (potential to emit at 8,760 hours, rounded down to whole blocks) keeps it below the threshold{noGas ? ", so a minor source means no onsite gas at all" : ""}. The optimiser has not priced that limit: run it {noGas ? `with ${p.rows.map(x => x.label).join(", ")} switched off` : `with these maximums${drop.length ? ` (${p.rows.filter(x => drop.includes(x.r)).map(x => x.label).join(", ")} switched off)` : ""}`} to see what replaces the gas.</p>
            <button className="primary small" onClick={() => onPrefill({ resources: minor, excluded: drop, title: "Minor-source gas cap" })}>Price it in the optimiser ↗</button></div>
          {Object.keys(late).length > 0 && <div className="th-wi-run"><p><b>Price the permit wait.</b> The {p.route === "major" ? "major-source" : "synthetic-minor"} route takes {p.months[0]}–{p.months[1]} months, plus 2 months of application preparation: onsite gas cannot run before month {wait}. The optimiser assumed it is available at {p.rows.filter(x => late[x.r]).map(x => `${x.label} month ${availMonths?.[x.r] ?? "?"}`).join(", ")}. Run it with the later date{Object.keys(late).length > 1 ? "s" : ""} ({p.rows.filter(x => late[x.r]).map(x => `${x.label} month ${late[x.r].available_month}`).join(", ")}).</p>
            <button className="primary small" onClick={() => onPrefill({ resources: late })}>Price it in the optimiser ↗</button></div>}</>;
      })()}
      <p><b>Texas only.</b> Other states have their own permit programs; with more time the same steps can be built for each.</p></div>
    <details className="fold"><summary><b>Rules used</b><span>each with its citation, trigger, effect and the date it was last verified</span></summary>
      <div className="table-scroll"><table className="year-table"><thead><tr><th>Rule</th><th className="l">Trigger</th><th className="l">Effect</th><th className="l">Effective</th><th>Verified</th></tr></thead>
        <tbody>{RULES.map(r => <tr key={r.id}><td className="note">{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.citation}</a> : r.citation}</td><td className="note">{r.trigger}</td><td className="note">{r.output}</td><td>{r.effective}</td><td>{r.verified}</td></tr>)}</tbody></table></div>
      <p className="footnote">Emission factors: EPA AP-42 typical values for natural gas turbines (Ch. 3.1) and lean-burn engines (Ch. 3.2) with typical controls; fuel-cell values are vendor-typical. Screening only: a permit uses vendor guarantees. Potential to emit assumes 8,760 hours a year; actual emissions use the optimiser's busiest dispatch year. Ozone classifications can change: Texas's 2026 attainment demonstration could move areas to a stricter class with a lower threshold. Federal SIP-approved text and current state text can differ; rules should be re-checked on a schedule.</p></details>
  </div>;
}
