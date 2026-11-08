// Live, animated SVG / HTML charts for the run results page. Data: GET /api/job/<id>/charts (team_app/gridtech_server.py).
// Bars grow and areas/lines reveal left to right when the chart scrolls into view, and again on every click on a tab or the chart.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Tags } from "./thesis";
import type { AgentKey } from "./thesisApi";

// ------------------------------------------------------------------------------------------------ data
export interface ChartRes { id: string; label: string; color: string }
type Series = Record<string, number[]>;
export interface AnnualPoint { year: number; costPerMwh: number | null; kgPerMwh: number | null; cleanShare: number | null; requestedGwh: number }
export interface ChartData {
  resources: ChartRes[]; calendarStart: string | null; opening: number; fullDemand: number; peakMw: number; milestones: { month: number; label: string }[];
  monthly: { series: Series; demand: number[]; demandPeak: number[]; gridCap: number[] };
  yearly: { years: number[]; series: Series; demand: number[]; gridCap: number[] };
  week: { startHour: number; modelYear: number; series: Series; demand: number[]; gridCap: number[] };
  stress: { startHour: number; hours: number; hasEvents: boolean; series: Series; demand: number[]; gridCap: number[]; event: number[] };
  daily: { series: Series; demand: number[]; gridCap: number[]; event: number[] };
  annual: AnnualPoint[]; co2Cap: number | null; land: { usedAcres: number; limitAcres: number };
}
export type ChartsState = { status: "loading" | "ok" | "none"; data: ChartData | null };

/** Fetches the chart data of a run once; "none" when the run has none (404, e.g. an infeasible run) or the server fails. */
export function useCharts(jobId: string, enabled: boolean): ChartsState {
  const [st, setSt] = useState<ChartsState>({ status: "loading", data: null });
  useEffect(() => {
    if (!enabled) return;
    let stop = false, timer = 0, tries = 0;
    setSt({ status: "loading", data: null });
    const go = () => fetch(`/api/job/${jobId}/charts`).then(async r => {
      if (stop) return;
      if (r.ok) setSt({ status: "ok", data: await r.json() });
      else if (r.status === 404) setSt({ status: "none", data: null });
      else throw new Error(String(r.status));
    }).catch(() => { if (stop) return; if (++tries < 4) timer = window.setTimeout(go, 3000); else setSt({ status: "none", data: null }); });
    go();
    return () => { stop = true; clearTimeout(timer); };
  }, [jobId, enabled]);
  return st;
}

export const FALLBACK: Record<string, [string, string]> = {
  nuclear: ["Nuclear PPA", "#111111"], wind: ["Wind contract", "#2e7d4f"], utility_solar: ["Solar contract", "#f7c08a"], gas_turbine: ["Gas turbine", "#8a3b0e"], gas_engine: ["Gas engines", "#f26b1d"],
  fuel_cell: ["Fuel cell", "#d9822b"], battery_4h: ["4-h battery", "#8cc9a1"], grid: ["Grid", "#8a8a8a"], tier1_relocated: ["Tier 1 relocated", "#5a5a5a"], tier2_curtailed: ["Tier 2 curtailed", "#bdbdbd"],
};
const INK = "#111111", GREY = "#767676", ORANGE = "#f26b1d";
export const colorOf = (d: ChartData | null, id: string) => d?.resources.find(r => r.id === id)?.color ?? FALLBACK[id]?.[1] ?? GREY;

const f = (v: number | null | undefined, d = 0) => (v == null || !Number.isFinite(v) ? "–" : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const fv = (v: number) => f(v, v !== 0 && Math.abs(v) < 10 ? 1 : 0);
const nice = (v: number) => { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)), m = v / p; return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(x => m <= x + 1e-9) ?? 10) * p; };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mar 2028" for model month m, when month 0 is a known calendar month ("2027-01"). */
export function monthName(m: number, cal: string | null) {
  const x = cal && /^(\d{4})-(\d{2})/.exec(cal);
  if (!x) return `month ${m}`;
  const k = Number(x[1]) * 12 + Number(x[2]) - 1 + Math.round(m);
  return `${MON[((k % 12) + 12) % 12]} ${Math.floor(k / 12)}`;
}
const stacksOf = (d: ChartData, s: Series) => d.resources.filter(r => (s[r.id] ?? []).some(x => x > 0.05)).map(r => ({ id: r.id, label: r.label, color: r.color, values: s[r.id] }));

// ------------------------------------------------------------------------------------------------ reveal on scroll, replay on click
function useReveal() {
  const [seen, setSeen] = useState(false), [rk, setRk] = useState(0), el = useRef<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    el.current = node;
    if (!node || seen) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { threshold: 0.12 });
    io.observe(node);
  }, [seen]);
  return { ref, seen, rk, bump: () => setRk(x => x + 1) };
}

/** A block that plays its chart when it scrolls into view and again when clicked. */
export function InView({ children, className = "" }: { children: (rk: number) => ReactNode; className?: string }) {
  const { ref, seen, rk, bump } = useReveal();
  return <div ref={ref} className={`ch-inview ${className}`} onClick={bump}>{seen ? children(rk) : <div className="ch-ph" />}</div>;
}

function ChartCard({ by, title, sub, tabs, children, foot }: { by: AgentKey[]; title: ReactNode; sub?: string; tabs?: [string, string][]; children: (tab: string, rk: number) => ReactNode; foot?: ReactNode }) {
  const [tab, setTab] = useState(tabs?.[0][0] ?? "");
  const { ref, seen, rk, bump } = useReveal();
  return <div className="card chart-card ch-card" ref={ref}>
    <Tags a={by} />
    <div className="ch-top"><h3 className="chart-h">{title}{sub && <small>{sub}</small>}</h3>
      <div className="ch-ctrl">{tabs && <div className="segment view-tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => { setTab(k); bump(); }}>{l}</button>)}</div>}
        <button className="ch-replay" onClick={bump} title="Replay" aria-label="Replay the animation">↻</button></div></div>
    <div className="ch-body" onClick={e => { if (!(e.target as HTMLElement).closest("button")) bump(); }}>{seen ? children(tab, rk) : <div className="ch-ph" />}</div>
    {foot}</div>;
}

function Legend({ items }: { items: { label: string; color: string; dash?: boolean; hatch?: boolean }[] }) {
  return <div className="legend ch-legend">{items.map(i => <span key={i.label} className={`lc ${i.dash ? "dash" : ""} ${i.hatch ? "btm" : ""}`} style={{ ["--c" as string]: i.color }}>{i.label}</span>)}</div>;
}
/** Onsite, behind-the-meter resources in the model (the catalogue's location "onsite"); contracts and the grid are offsite. */
const ONSITE = new Set(["gas_turbine", "gas_engine", "fuel_cell", "battery_4h"]);
export const Loading = ({ st, children }: { st: ChartsState; children: (d: ChartData) => ReactNode }) =>
  st.status === "loading" ? <div className="card"><p className="gt-note">Loading charts…</p></div>
    : st.data ? <>{children(st.data)}</> : <div className="card"><p className="gt-note">Charts are not available for this run.</p></div>;

// ------------------------------------------------------------------------------------------------ time chart: stacked areas, lines, markers, event bands
interface Line { label: string; values: number[]; color: string; dash?: string }
function TimeChart({ n, stacks, lines, markers = [], bands, xLabel, xTicks, tickText, unit = "MW", rk, h = 300, hatch }: {
  n: number; stacks: { id: string; label: string; color: string; values: number[] }[]; lines: Line[]; markers?: { x: number; label: string }[]; bands?: number[];
  xLabel: (i: number) => string; xTicks: number[]; tickText: (i: number) => string; unit?: string; rk: number; h?: number; hatch?: Set<string>;
}) {
  const W = 900, L = 46, R = 14, T = 22, B = 28, H = h;
  const uid = useId().replace(/:/g, "");
  const [hv, setHv] = useState<number | null>(null);
  const tot = Array.from({ length: n }, (_, i) => stacks.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const top = nice(Math.max(1, ...tot, ...lines.flatMap(l => l.values)) * 1.04);
  const X = (i: number) => L + (n > 1 ? i / (n - 1) : 0) * (W - L - R), Y = (v: number) => T + (1 - v / top) * (H - T - B);
  const cum: number[][] = []; stacks.forEach((s, k) => cum.push(Array.from({ length: n }, (_, i) => (cum[k - 1]?.[i] ?? 0) + (s.values[i] ?? 0))));
  const area = (k: number) => { const up = cum[k], lo = cum[k - 1]; let p = ""; for (let i = 0; i < n; i++) p += `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(up[i]).toFixed(1)}`; for (let i = n - 1; i >= 0; i--) p += `L${X(i).toFixed(1)} ${Y(lo?.[i] ?? 0).toFixed(1)}`; return p + "Z"; };
  const runs: [number, number][] = []; if (bands) { let a = -1; bands.forEach((e, i) => { if (e && a < 0) a = i; if ((!e || i === n - 1) && a >= 0) { runs.push([a, e ? i : i - 1]); a = -1; } }); }
  const move = (e: React.MouseEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width * W; setHv(Math.max(0, Math.min(n - 1, Math.round((x - L) / (W - L - R) * (n - 1))))); };
  const right = hv != null && X(hv) / W > 0.62;
  return <div className="ch-time" key={rk}>
    <svg viewBox={`0 0 ${W} ${H}`} role="img" onMouseMove={move} onMouseLeave={() => setHv(null)}>
      <defs><clipPath id={uid}><rect className="ch-clip" x="0" y="0" width={W} height={H} /></clipPath>
        <pattern id={`${uid}-btm`} width="7" height="7" patternUnits="userSpaceOnUse"><path d="M7 0H0V7" fill="none" stroke="#fff" strokeOpacity=".8" strokeWidth="1" /></pattern></defs>
      {[0, 0.25, 0.5, 0.75, 1].map(fr => <g key={fr}><line x1={L} x2={W - R} y1={Y(top * fr)} y2={Y(top * fr)} stroke="#e5e5e2" /><text x={L - 6} y={Y(top * fr) + 4} textAnchor="end" className="ch-ax">{fv(top * fr)}</text></g>)}
      <text x={L - 6} y={11} textAnchor="end" className="ch-ax">{unit}</text>
      {xTicks.map(i => <text key={i} x={X(i)} y={H - 8} textAnchor="middle" className="ch-ax">{tickText(i)}</text>)}
      {runs.map(([a, b], i) => <rect key={i} x={X(a) - (W - L - R) / Math.max(1, n - 1) / 2} width={Math.max(2, X(b) - X(a) + (W - L - R) / Math.max(1, n - 1))} y={T} height={H - T - B} fill={ORANGE} opacity=".16" />)}
      <g clipPath={`url(#${uid})`}>
        {stacks.map((s, k) => <path key={s.id} d={area(k)} fill={s.color} opacity=".92"><title>{s.label}</title></path>)}
        {hatch && stacks.map((s, k) => hatch.has(s.id) ? <path key={`${s.id}-btm`} d={area(k)} fill={`url(#${uid}-btm)`} pointerEvents="none" /> : null)}
        {lines.map(l => <polyline key={l.label} fill="none" stroke={l.color} strokeWidth="2" strokeDasharray={l.dash} points={l.values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")} />)}
      </g>
      {markers.map((m, i) => <g key={m.label + i}><line x1={X(m.x)} x2={X(m.x)} y1={T} y2={H - B} stroke={INK} strokeDasharray="3 3" opacity=".7" /><text x={X(m.x) + 4} y={T + 8 + (i % 3) * 11} className="ch-mk">{m.label}</text></g>)}
      {hv != null && <line x1={X(hv)} x2={X(hv)} y1={T} y2={H - B} stroke={INK} />}
      <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" />
    </svg>
    {hv != null && <div className="ch-tip" style={{ left: `${X(hv) / W * 100}%`, transform: `translateX(${right ? "calc(-100% - 12px)" : "12px"})` }}>
      <b>{xLabel(hv)}</b>{[...stacks].reverse().filter(s => (s.values[hv] ?? 0) > 0.005).map(s => <span key={s.id}><i style={{ background: s.color }} />{s.label}<em>{fv(s.values[hv])} {unit}</em></span>)}
      {lines.map(l => <span key={l.label}><u style={{ borderColor: l.color }} />{l.label}<em>{fv(l.values[hv] ?? 0)} {unit}</em></span>)}
      {bands && bands[hv] ? <span className="ev">Stress event</span> : null}</div>}
  </div>;
}

const lineItems = (d: ChartData, demand: number[], gridCap: number[], dl = "Demand"): Line[] => [{ label: dl, values: demand, color: INK }, ...(gridCap.some(x => x > 0) ? [{ label: "Grid import limit", values: gridCap, color: GREY, dash: "6 4" }] : [])];

// ------------------------------------------------------------------------------------------------ the chart cards
/** Monthly power sources over the 10 years, with the milestones and the demand and grid-limit lines. */
export function PowerTimeline({ d }: { d: ChartData }) {
  const st = stacksOf(d, d.monthly.series), n = d.monthly.demand.length;
  const ms = [{ x: d.opening, label: `Opening m${d.opening}` }, { x: d.fullDemand, label: `Full demand m${d.fullDemand}` }, ...d.milestones.filter(m => m.month !== d.opening && m.month !== d.fullDemand).map(m => ({ x: m.month, label: m.label }))].filter(m => m.x >= 0 && m.x < n);
  const [btm, setBtm] = useState(true);
  const hasOnsite = st.some(s => ONSITE.has(s.id)), mark = btm && hasOnsite;
  return <ChartCard by={["optimisation"]} title="Power sources month by month" sub={`average MW by resource · month 0 = ${d.calendarStart ?? "project start"}`}>
    {(_, rk) => <>{hasOnsite && <button type="button" className={`ch-btm-toggle ${mark ? "on" : ""}`} aria-pressed={mark} onClick={() => setBtm(x => !x)}><i />Mark onsite (behind the meter)</button>}
      <Legend items={[...st.map(s => ({ label: s.label, color: s.color, hatch: mark && ONSITE.has(s.id) })), { label: "Demand", color: INK }, { label: "Grid import limit", color: GREY, dash: true },
        ...(mark ? [{ label: "Grid pattern = onsite, behind the meter", color: GREY, hatch: true }] : [])]} />
      <TimeChart n={n} rk={rk} stacks={st} hatch={mark ? ONSITE : undefined} lines={lineItems(d, d.monthly.demand, d.monthly.gridCap)} markers={ms} xTicks={Array.from({ length: Math.ceil(n / 12) }, (_, i) => i * 12)} tickText={i => `Y${i / 12 + 1}`} xLabel={i => `Month ${i} · ${monthName(i, d.calendarStart)}`} />
      <p className="axis-label">Vertical lines are the run's milestones. Hover to read the values at a month.{mark ? " Gridded areas are onsite generation and storage behind the meter (gas, fuel cell, battery); plain areas are the grid and offsite contracts." : ""}</p></>}
  </ChartCard>;
}

/** Grid vs onsite gas (bridge power) vs contracts: yearly stacked bars, the typical week, and the day-by-day view of one model year. */
export function PowerSourcesCard({ d, extra }: { d: ChartData; extra?: ReactNode }) {
  const [yr, setYr] = useState(() => Math.max(1, Math.min(10, Math.floor(d.opening / 12) + 1)));
  const yrs = d.yearly.years;
  return <ChartCard by={["optimisation"]} title="Grid, bridge power and contracts" sub="where the energy comes from" tabs={[["year", "1 · Power sources by year"], ["week", "2 · Typical week"], ["days", "3 · Year by year"]]} foot={extra}>
    {(tab, rk) => {
      if (tab === "year") { const st = stacksOf(d, d.yearly.series); return <><Legend items={[...st.map(s => ({ label: s.label, color: s.color })), { label: "Demand", color: INK, dash: true }, { label: "Grid import limit", color: GREY, dash: true }]} />
        <BarChart rk={rk} cats={yrs.map(y => ({ key: String(y), label: `Y${y}` }))} stacks={st} marks={[{ label: "Demand", values: d.yearly.demand, color: INK }, ...(d.yearly.gridCap.some(x => x > 0) ? [{ label: "Grid import limit", values: d.yearly.gridCap, color: GREY }] : [])]} unit="MW" />
        <p className="axis-label">Average MW per model year. Onsite gas bridges the gap until the grid connection grows; contracts (wind, solar, nuclear) fill the rest.</p></>; }
      if (tab === "week") { const st = stacksOf(d, d.week.series), n = d.week.demand.length; return <><Legend items={[...st.map(s => ({ label: s.label, color: s.color })), { label: "Demand", color: INK }, { label: "Grid import limit", color: GREY, dash: true }]} />
        <TimeChart n={n} rk={rk} stacks={st} lines={lineItems(d, d.week.demand, d.week.gridCap)} xTicks={Array.from({ length: 7 }, (_, i) => i * 24)} tickText={i => `Day ${i / 24 + 1}`} xLabel={i => `Day ${Math.floor(i / 24) + 1}, ${String(i % 24).padStart(2, "0")}:00`} />
        <p className="axis-label">A typical week of hourly dispatch in model year {d.week.modelYear}.</p></>; }
      const y = Math.min(yr, 10) - 1, sl = (a: number[]) => a.slice(y * 365, (y + 1) * 365), series: Series = {}; Object.keys(d.daily.series).forEach(k => { series[k] = sl(d.daily.series[k]); });
      const st = stacksOf(d, series), n = 365, ev = sl(d.daily.event);
      return <><div className="segment ch-years" role="tablist">{Array.from({ length: 10 }, (_, i) => i + 1).map(i => <button key={i} role="tab" aria-selected={yr === i} className={yr === i ? "on" : ""} onClick={() => { setYr(i); }}>Y{i}</button>)}</div>
        <Legend items={[...st.map(s => ({ label: s.label, color: s.color })), { label: "Demand", color: INK }, { label: "Grid import limit", color: GREY, dash: true }, ...(ev.some(Boolean) ? [{ label: "Stress event", color: "#f9c9a6" }] : [])]} />
        <TimeChart n={n} rk={rk * 100 + yr} stacks={st} lines={lineItems(d, sl(d.daily.demand), sl(d.daily.gridCap))} bands={ev} xTicks={[0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]} tickText={i => MON[[0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334].indexOf(i)]} xLabel={i => `Year ${yr}, day ${i + 1}`} />
        <p className="axis-label">Daily average MW across model year {yr}; shaded bands are stress-event days.</p></>;
    }}
  </ChartCard>;
}

/** The stress period (the events that bite hardest): stacked dispatch with the event hours shaded. */
export function StressChart({ d }: { d: ChartData }) {
  const s = d.stress;
  if (!s.hasEvents || !s.demand.length) return <div className="card"><Tags a={["optimisation"]} /><p className="gt-note">No stress events fall in this run's period, so there is no stress chart.</p></div>;
  const st = stacksOf(d, s.series), n = s.demand.length, step = Math.max(1, Math.round(n / 6 / 6) * 6);
  return <ChartCard by={["optimisation"]} title="Stress period" sub={`${n} hours from model hour ${f(s.startHour)} · shaded = stress event`}>
    {(_, rk) => <><Legend items={[...st.map(x => ({ label: x.label, color: x.color })), { label: "Demand", color: INK }, { label: "Grid import limit", color: GREY, dash: true }, { label: "Stress event", color: "#f9c9a6" }]} />
      <TimeChart n={n} rk={rk} stacks={st} lines={lineItems(d, s.demand, s.gridCap)} bands={s.event} xTicks={Array.from({ length: Math.floor((n - 1) / step) + 1 }, (_, i) => i * step)} tickText={i => `+${i}h`} xLabel={i => `Hour ${i} of the window (model hour ${f(s.startHour + i)})`} />
      <p className="axis-label">Orange bands are the hours the grid import is cut; onsite gas and batteries cover the gap.</p></>}
  </ChartCard>;
}

// ------------------------------------------------------------------------------------------------ bars
function BarChart({ cats, stacks, marks = [], hline, unit, rk, h = 300, colors, topLabels, fmtV = fv }: {
  cats: { key: string; label: string }[]; stacks: { id: string; label: string; color: string; values: (number | null)[] }[]; marks?: { label: string; values: number[]; color: string }[];
  hline?: { label: string; value: number }; unit: string; rk: number; h?: number; colors?: string[]; topLabels?: boolean; fmtV?: (v: number) => string;
}) {
  const [hv, setHv] = useState<number | null>(null), n = cats.length;
  const tot = cats.map((_, i) => stacks.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const scale = nice(Math.max(1e-9, ...tot, ...marks.flatMap(m => m.values), hline?.value ?? 0) * 1.04);
  const pc = (v: number) => `${Math.min(100, v / scale * 100)}%`;
  return <div className="ch-bars" style={{ height: h }} onMouseLeave={() => setHv(null)}>
    <div className="ch-y">{[1, 0.75, 0.5, 0.25, 0].map(fr => <span key={fr} style={{ bottom: `${fr * 100}%` }}>{fmtV(scale * fr)}</span>)}</div>
    <div className="ch-plot" key={rk}>
      {[0.25, 0.5, 0.75, 1].map(fr => <i key={fr} className="ch-grid" style={{ bottom: `${fr * 100}%` }} />)}
      <div className="ch-cols">{cats.map((c, i) => <div key={c.key} className={`ch-col ${hv === i ? "hv" : ""}`} onMouseEnter={() => setHv(i)}>
        <div className="ch-stack">{stacks.map(s => (s.values[i] ?? 0) > 0 ? <i key={s.id} className="ch-seg" style={{ height: pc(s.values[i] ?? 0), background: colors?.[i] ?? s.color }} /> : null)}</div>
        {marks.map(m => <b key={m.label} className="ch-mark" style={{ bottom: pc(m.values[i] ?? 0), borderColor: m.color }} />)}
        {topLabels && (tot[i] > 0) && <span className="ch-top-v" style={{ bottom: pc(tot[i]) }}>{fmtV(tot[i])}</span>}
        <small className="ch-x">{c.label}</small></div>)}</div>
      {hline && <b className="ch-hline" style={{ bottom: pc(hline.value) }}><em>{hline.label}</em></b>}
      {hv != null && <div className="ch-tip" style={{ left: `${(hv + 0.5) / n * 100}%`, top: 0, transform: `translateX(${(hv + 0.5) / n > 0.62 ? "calc(-100% - 12px)" : "12px"})` }}>
        <b>{cats[hv].label}</b>{[...stacks].reverse().filter(s => (s.values[hv] ?? 0) > 0.005).map(s => <span key={s.id}><i style={{ background: colors?.[hv] ?? s.color }} />{s.label}<em>{fmtV(s.values[hv] ?? 0)} {unit}</em></span>)}
        {marks.map(m => <span key={m.label}><u style={{ borderColor: m.color }} />{m.label}<em>{fmtV(m.values[hv] ?? 0)} {unit}</em></span>)}</div>}
    </div></div>;
}

/** One bar per model year of a single value (cost, carbon, clean share), with an optional ceiling line. */
function YearBars({ rows, get, label, unit, color, ceiling, rk, fmtV, over }: { rows: AnnualPoint[]; get: (a: AnnualPoint) => number | null; label: string; unit: string; color: string; ceiling?: number | null; rk: number; fmtV?: (v: number) => string; over?: boolean }) {
  const vals = rows.map(a => get(a));
  return <BarChart rk={rk} h={260} cats={rows.map(a => ({ key: String(a.year), label: `Y${a.year}` }))} stacks={[{ id: "v", label, color, values: vals }]} unit={unit} topLabels fmtV={fmtV}
    colors={over && ceiling != null ? vals.map(v => (v != null && v > ceiling ? ORANGE : color)) : undefined} hline={ceiling != null ? { label: `Ceiling ${f(ceiling)}`, value: ceiling } : undefined} />;
}

export function AnnualCostBars({ rows }: { rows: AnnualPoint[] }) {
  return <ChartCard by={["optimisation"]} title="Cost per MWh by model year" sub="decision cost per requested MWh, 2023 USD">{(_, rk) => <YearBars rows={rows} rk={rk} get={a => a.costPerMwh} label="Cost" unit="$/MWh" color={ORANGE} fmtV={v => `$${f(v, v < 10 ? 1 : 0)}`} />}</ChartCard>;
}
export function AnnualCarbonChart({ rows, cap }: { rows: AnnualPoint[]; cap: number | null }) {
  return <ChartCard by={["optimisation"]} title="Carbon intensity by model year" sub={`kg CO₂ per MWh${cap != null ? ` · ceiling ${f(cap)} (bars over it turn orange)` : ""}`}>{(_, rk) => <YearBars rows={rows} rk={rk} get={a => a.kgPerMwh} label="Carbon" unit="kg/MWh" color="#2e7d4f" ceiling={cap} over fmtV={v => f(v)} />}</ChartCard>;
}
export function CleanShareBars({ rows }: { rows: AnnualPoint[] }) {
  return <ChartCard by={["optimisation"]} title="Clean energy share by model year" sub="share of the energy served that is carbon-free">{(_, rk) => <YearBars rows={rows} rk={rk} get={a => (a.cleanShare == null ? null : a.cleanShare * 100)} label="Clean share" unit="%" color="#2e9d5b" fmtV={v => `${f(v)}%`} />}</ChartCard>;
}

// ------------------------------------------------------------------------------------------------ horizontal bars
export function HBars({ rows, unit = "MW", max, line }: { rows: { key: string; label: string; value: number; color: string; note?: string }[]; unit?: string; max?: number; line?: { value: number; label: string } }) {
  const top = max ?? Math.max(1e-9, ...rows.map(r => r.value), line?.value ?? 0) * 1.08;
  return <InView className="ch-h">{rk => <div className="ch-hbars" key={rk}>{rows.map((r, i) => <div key={r.key} className="ch-hrow" title={`${r.label}: ${f(r.value, 1)} ${unit}${r.note ? ` · ${r.note}` : ""}`}>
    <span>{r.label}{r.note && <small>{r.note}</small>}</span><div className="ch-htrack"><i style={{ width: `${r.value / top * 100}%`, background: r.color, animationDelay: `${i * 70}ms` }} />{line && <b style={{ left: `${line.value / top * 100}%` }} title={line.label} />}</div><em>{f(r.value, r.value < 10 ? 1 : 0)} {unit}</em></div>)}</div>}</InView>;
}

/** Land used against the land available (acres). */
export function LandBar({ used, limit }: { used: number | null | undefined; limit: number | null | undefined }) {
  if (used == null) return <p className="gt-note">Land use is not available for this run.</p>;
  const top = Math.max(used, limit ?? 0, 1) * 1.1, over = limit != null && used > limit + 1e-6;
  return <InView className="ch-h">{rk => <div className="ch-land" key={rk}><div className="ch-htrack tall"><i style={{ width: `${used / top * 100}%`, background: over ? ORANGE : "#2e9d5b" }} title={`${f(used, 1)} acres used`} />{limit != null && <b style={{ left: `${limit / top * 100}%` }} title={`limit ${f(limit, 1)} acres`}><em>limit {f(limit, 1)}</em></b>}</div>
    <p className="axis-label">{f(used, 1)} acres used{limit != null ? ` of ${f(limit, 1)} available (${f(used / (limit || 1) * 100)}%)` : ""}</p></div>}</InView>;
}

/** One row per proposed site: the grid connection estimate (median) and the month power can be on, on a month axis. */
export function SiteTimeline({ sites, opening, fullDemand }: { sites: { id: string; label: string; grid: number | null; power: number | null }[]; opening?: number; fullDemand?: number }) {
  const top = Math.ceil(Math.max(36, opening ?? 0, fullDemand ?? 0, ...sites.flatMap(s => [s.grid ?? 0, s.power ?? 0])) * 1.08 / 6) * 6;
  const pc = (m: number) => `${m / top * 100}%`, ticks = Array.from({ length: top / 6 + 1 }, (_, i) => i * 6);
  return <InView className="ch-h">{rk => <div className="ch-sites" key={rk}>
    <div className="ch-site-axis">{ticks.map(t => <span key={t} style={{ left: pc(t) }}>{t}</span>)}</div>
    {sites.map((s, i) => <div key={s.id} className="ch-hrow site" title={`${s.label}: grid ${s.grid != null ? `month ${f(s.grid)}` : "unknown"}, power by ${s.power != null ? `month ${f(s.power)}` : "unknown"}`}>
      <span>{s.label}</span><div className="ch-htrack stack2">
        {ticks.map(t => <u key={t} style={{ left: pc(t) }} />)}
        {opening != null && <b className="open" style={{ left: pc(opening) }} title={`Opening m${opening}`} />}
        {s.grid != null && <i className="g" style={{ width: pc(s.grid), animationDelay: `${i * 80}ms` }}><em>grid m{f(s.grid)}</em></i>}
        {s.power != null && <i className="p" style={{ width: pc(s.power), animationDelay: `${i * 80 + 40}ms` }}><em>power by m{f(s.power)}</em></i>}</div></div>)}
    <div className="legend ch-legend"><span className="lc" style={{ ["--c" as string]: "#b9b9b6" }}>Grid connection (median estimate)</span><span className="lc" style={{ ["--c" as string]: ORANGE }}>Power available (onsite gas or grid)</span><span className="lc dash" style={{ ["--c" as string]: INK }}>Run opening month</span></div>
    <p className="axis-label">Model months from project start.</p></div>}</InView>;
}
