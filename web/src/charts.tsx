// SVG charts in the Faraday style (TimeChart / BarChart / HBars from the GridTech repo's charts.tsx, cut down and
// generalised): lines, a p10-p90 band, stacked areas, a shaded window, a vertical "as of" marker and a hover read-out.
import { useId, useState } from "react";

export interface Series { label: string; values: (number | null)[]; color: string; dash?: string; width?: number }
export interface Stack { label: string; values: number[]; color: string }

const nice = (v: number) => { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)), m = v / p; return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(x => m <= x + 1e-9) ?? 10) * p; };
const fv = (v: number, d?: number) => v.toLocaleString(undefined, { maximumFractionDigits: d ?? (Math.abs(v) < 2 ? 2 : Math.abs(v) < 20 ? 1 : 0) });

export function TimeChart({ n, lines = [], stacks = [], band, shade, marker, xTicks, tickText, xLabel, unit = "", h = 280, yMin, yMax, fmt = fv, dots = [], hlines = [] }: {
  dots?: { label: string; values: (number | null)[]; color: string }[]; hlines?: { v: number; label: string; color?: string }[];
  n: number; lines?: Series[]; stacks?: Stack[]; band?: { lo: number[]; hi: number[]; color: string; label: string }; shade?: { from: number; to: number; label: string; fill?: string }[];
  marker?: { x: number; label: string }; xTicks: number[]; tickText: (i: number) => string; xLabel: (i: number) => string; unit?: string; h?: number; yMin?: number; yMax?: number; fmt?: (v: number) => string;
}) {
  const W = 900, L = 48, R = 14, T = 18, B = 28, H = h;
  const uid = useId().replace(/:/g, "");
  const [hv, setHv] = useState<number | null>(null);
  const cum: number[][] = []; stacks.forEach((s, k) => cum.push(Array.from({ length: n }, (_, i) => (cum[k - 1]?.[i] ?? 0) + (s.values[i] ?? 0))));
  const all = [...lines.flatMap(l => l.values.filter((v): v is number => v != null)), ...dots.flatMap(l => l.values.filter((v): v is number => v != null)), ...(band ? [...band.hi, ...band.lo] : []), ...(cum.length ? cum[cum.length - 1] : [])];
  const lo = yMin ?? Math.min(0, ...all), top = yMax ?? nice(Math.max(1e-9, ...all) * 1.05);
  const X = (i: number) => L + (n > 1 ? i / (n - 1) : 0) * (W - L - R), Y = (v: number) => T + (1 - (v - lo) / (top - lo)) * (H - T - B);
  const step = (W - L - R) / Math.max(1, n - 1);
  const path = (vals: (number | null)[]) => { let p = "", pen = false; vals.forEach((v, i) => { if (v == null) { pen = false; return; } p += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true; }); return p; };
  const area = (up: number[], down: number[]) => { let p = ""; for (let i = 0; i < n; i++) p += `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(up[i]).toFixed(1)}`; for (let i = n - 1; i >= 0; i--) p += `L${X(i).toFixed(1)} ${Y(down[i]).toFixed(1)}`; return p + "Z"; };
  const move = (e: React.MouseEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width * W; setHv(Math.max(0, Math.min(n - 1, Math.round((x - L) / step)))); };
  const right = hv != null && X(hv) / W > 0.6;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => lo + (top - lo) * f);
  return <div className="ch">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" onMouseMove={move} onMouseLeave={() => setHv(null)}>
      <defs><clipPath id={uid}><rect x={L} y={0} width={W - L - R} height={H} /></clipPath></defs>
      {ticks.map(v => <g key={v}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="rgba(31,78,110,.12)" /><text x={L - 6} y={Y(v) + 4} textAnchor="end" className="ch-ax">{fmt(v)}</text></g>)}
      {unit && <text x={L - 6} y={9} textAnchor="end" className="ch-ax">{unit}</text>}
      {xTicks.map(i => <text key={i} x={X(i)} y={H - 8} textAnchor="middle" className="ch-ax">{tickText(i)}</text>)}
      {shade?.map(s => <g key={s.label + s.from}><rect x={X(s.from) - step / 2} width={Math.max(2, X(s.to) - X(s.from) + step)} y={T} height={H - T - B} fill={s.fill ?? "#1f4e6e"} opacity={s.fill ? 0.22 : 0.06} /><text x={X(s.from) - step / 2 + 4} y={H - B - 6} className="ch-ax">{s.label}</text></g>)}
      <g clipPath={`url(#${uid})`}>
        {stacks.map((s, k) => <path key={s.label} d={area(cum[k], cum[k - 1] ?? Array(n).fill(0))} fill={s.color} opacity=".6" />)}
        {band && <path d={area(band.hi, band.lo)} fill={band.color} opacity=".2" />}
        {lines.map(l => <path key={l.label} d={path(l.values)} fill="none" stroke={l.color} strokeWidth={l.width ?? 2.2} strokeDasharray={l.dash} strokeLinejoin="round" />)}
        {dots.map(d => d.values.map((v, i) => (v == null ? null : <circle key={d.label + i} cx={X(i)} cy={Y(v)} r={2.8} fill={d.color} stroke="#fff" strokeWidth=".8" />)))}
      </g>
      {hlines.map(h2 => (h2.v >= lo && h2.v <= top ? <g key={h2.label}><line x1={L} x2={W - R} y1={Y(h2.v)} y2={Y(h2.v)} stroke={h2.color ?? "#b8401a"} strokeDasharray="5 4" opacity=".7" /><text x={W - R} y={Y(h2.v) - 4} textAnchor="end" className="ch-ax">{h2.label}</text></g> : null))}
      {marker && <g><line x1={X(marker.x)} x2={X(marker.x)} y1={T - 6} y2={H - B} stroke="#1f4e6e" strokeDasharray="3 3" /><text x={X(marker.x) + 5} y={T - 6} className="ch-mk">{marker.label}</text></g>}
      {hv != null && <line x1={X(hv)} x2={X(hv)} y1={T} y2={H - B} stroke="#1f4e6e" opacity=".4" />}
      <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" />
    </svg>
    {hv != null && <div className="ch-tip" style={{ left: `${X(hv) / W * 100}%`, transform: `translateX(${right ? "calc(-100% - 12px)" : "12px"})` }}>
      <b>{xLabel(hv)}</b>
      {lines.filter(l => l.values[hv] != null).map(l => <span key={l.label}><i style={{ background: l.color }} />{l.label}<em>{fmt(l.values[hv]!)}{unit && ` ${unit}`}</em></span>)}
      {band && <span><i style={{ background: band.color, opacity: .5 }} />{band.label}<em>{fmt(band.lo[hv])}–{fmt(band.hi[hv])}</em></span>}
      {[...stacks].reverse().map(s => <span key={s.label}><i style={{ background: s.color }} />{s.label}<em>{fmt(s.values[hv])}{unit && ` ${unit}`}</em></span>)}
    </div>}
  </div>;
}

export function Legend({ items }: { items: { label: string; color: string; kind?: "line" | "band" | "dash" }[] }) {
  return <div className="legend">{items.map(i => <span key={i.label}><i className={i.kind === "band" ? "band" : i.kind === "dash" ? "dash" : ""} style={{ ["--c" as string]: i.color }} />{i.label}</span>)}</div>;
}

/** Vertical bars with value labels (e.g. yield by season), optional reference line. */
export function Bars({ cats, values, colors, h = 220, fmt = fv, refLine, refLines = [], unit = "" }: { cats: string[]; values: number[]; colors: string[]; h?: number; fmt?: (v: number) => string; refLine?: { v: number; label: string }; refLines?: { v: number; label: string; color?: string }[]; unit?: string }) {
  const refs = [...(refLine ? [refLine] : []), ...refLines];
  const W = 900, L = 40, R = 10, T = 18, B = 26, H = h;
  const top = nice(Math.max(1e-9, ...values, ...refs.map(x => x.v)) * 1.12);
  const bw = (W - L - R) / cats.length;
  const Y = (v: number) => T + (1 - v / top) * (H - T - B);
  const [hv, setHv] = useState<number | null>(null);
  return <div className="ch"><svg viewBox={`0 0 ${W} ${H}`} role="img" onMouseLeave={() => setHv(null)}>
    {[0, 0.5, 1].map(f => <g key={f}><line x1={L} x2={W - R} y1={Y(top * f)} y2={Y(top * f)} stroke="rgba(31,78,110,.12)" /><text x={L - 6} y={Y(top * f) + 4} textAnchor="end" className="ch-ax">{fmt(top * f)}</text></g>)}
    {cats.map((c, i) => <g key={c} onMouseEnter={() => setHv(i)}>
      <rect x={L + i * bw + bw * 0.18} width={bw * 0.64} y={Y(values[i])} height={Math.max(0, H - B - Y(values[i]))} rx="3" fill={colors[i]} fillOpacity=".8" opacity={hv == null || hv === i ? 1 : 0.6} />
      <text x={L + i * bw + bw / 2} y={Y(values[i]) - 5} textAnchor="middle" className="ch-mk">{fmt(values[i])}</text>
      <text x={L + i * bw + bw / 2} y={H - 8} textAnchor="middle" className="ch-ax">{c}</text></g>)}
    {refs.map(rl => <line key={rl.label} x1={L} x2={W - R} y1={Y(rl.v)} y2={Y(rl.v)} stroke={(rl as { color?: string }).color ?? "#1f4e6e"} strokeDasharray="5 4" />)}
    {refLabelYs(refs.map(rl => Y(rl.v)), T).map((y, i) => <text key={refs[i].label} x={W - R} y={y} textAnchor="end" className="ch-mk ch-halo">{refs[i].label}</text>)}
  </svg>{hv != null && unit && <div className="ch-tip" style={{ left: `${(L + (hv + 0.5) * bw) / W * 100}%`, transform: "translateX(12px)" }}><b>{cats[hv]}</b><span>{fmt(values[hv])} {unit}</span></div>}</div>;
}

/** label baselines for reference lines: just above each line, pushed apart so close lines (e.g. p99 and "this season") don't overlap */
function refLabelYs(lineYs: number[], top: number, gap = 17): number[] {
  const order = lineYs.map((y, i) => i).sort((a, b) => lineYs[a] - lineYs[b]);
  const out = new Array<number>(lineYs.length);
  let prev = -Infinity;
  for (const i of order) { const y = Math.max(lineYs[i] - 5, top + 8, prev + gap); out[i] = y; prev = y; }
  return out;
}

/** Horizontal bars, each split into coloured parts (e.g. exposure by stress level per region). */
export function HBars({ rows, fmt = fv, onPick, active }: { rows: { key: string; label: string; note?: string; parts: { v: number; color: string; label: string }[]; total?: number }[]; fmt?: (v: number) => string; onPick?: (key: string) => void; active?: string | null }) {
  const top = Math.max(1e-9, ...rows.map(r => r.parts.reduce((a, p) => a + p.v, 0)));
  return <div className={`hbars ${onPick ? "pick" : ""}`}>{rows.map((r, i) => { const t = r.total ?? r.parts.reduce((a, p) => a + p.v, 0); return <div key={r.key} className={`hrow ${active === r.key ? "on" : ""}`} title={r.parts.map(p => `${p.label}: ${fmt(p.v)}`).join(" · ")}
    role={onPick ? "button" : undefined} tabIndex={onPick ? 0 : undefined} onClick={onPick ? () => onPick(r.key) : undefined} onKeyDown={onPick ? e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(r.key); } } : undefined}>
    <span>{r.label}{r.note && <small>{r.note}</small>}</span>
    <div className="htrack">{r.parts.map(p => <i key={p.label} style={{ width: `${p.v / top * 100}%`, background: p.color, animationDelay: `${i * 50}ms` }} />)}</div>
    <em>{fmt(t)}</em></div>; })}</div>;
}
