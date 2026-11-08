import { useEffect, useState } from "react";
import type { Loan } from "./data";
import { useLang } from "./i18n";

const TXT = {
  en: { title: "Soil sensors", pilot: "PILOT · OPTIONAL", meta: "3 depths · hourly", a: "A · TOPSOIL 0–20 cm", b: "B · SUBSOIL 20–45 cm", c: "C · DEEP 45–70 cm", sat: "SATELLITE · SURFACE", normal: "normal 22–34% VWC",
    surf: "SURFACE MOISTURE", satL: "satellite", senL: "sensor", dis: "Disagree: sensor is drier → earlier warning", agr: "Agree: sensor confirms satellite", temp: "SOIL TEMP", ec: "SALINITY EC", ph: "PH", npk: "N · P · K",
    high: "high", low: "low", ok: "ok", conf: "DATA CONFIDENCE", hi: "High · satellite + sensors", mid: "Good · satellite + sensors", noS: "Score works without sensors", below: "below range", dry: "below range · dry", inr: "in range", held: "in range · water held", above: "above range", cm: "CM" },
  es: { title: "Sensores de suelo", pilot: "PILOTO · OPCIONAL", meta: "3 profundidades · cada hora", a: "A · SUPERFICIAL 0–20 cm", b: "B · SUBSUELO 20–45 cm", c: "C · PROFUNDO 45–70 cm", sat: "SATÉLITE · SUPERFICIE", normal: "normal 22–34% VWC",
    surf: "HUMEDAD SUPERFICIAL", satL: "satélite", senL: "sensor", dis: "Difieren: el sensor está más seco → alerta temprana", agr: "Coinciden: el sensor confirma al satélite", temp: "TEMP. SUELO", ec: "SALINIDAD CE", ph: "PH", npk: "N · P · K",
    high: "alta", low: "bajo", ok: "ok", conf: "CONFIANZA DE DATOS", hi: "Alta · satélite + sensores", mid: "Buena · satélite + sensores", noS: "El puntaje funciona sin sensores", below: "bajo el rango", dry: "bajo el rango · seco", inr: "en rango", held: "en rango · agua retenida", above: "sobre el rango", cm: "CM" },
  pt: { title: "Sensores de solo", pilot: "PILOTO · OPCIONAL", meta: "3 profundidades · por hora", a: "A · SUPERFICIAL 0–20 cm", b: "B · SUBSOLO 20–45 cm", c: "C · PROFUNDO 45–70 cm", sat: "SATÉLITE · SUPERFÍCIE", normal: "normal 22–34% VWC",
    surf: "UMIDADE SUPERFICIAL", satL: "satélite", senL: "sensor", dis: "Divergem: o sensor está mais seco → alerta antecipado", agr: "Concordam: o sensor confirma o satélite", temp: "TEMP. SOLO", ec: "SALINIDADE CE", ph: "PH", npk: "N · P · K",
    high: "alta", low: "baixo", ok: "ok", conf: "CONFIANÇA DOS DADOS", hi: "Alta · satélite + sensores", mid: "Boa · satélite + sensores", noS: "A nota funciona sem sensores", below: "abaixo da faixa", dry: "abaixo da faixa · seco", inr: "na faixa", held: "na faixa · água retida", above: "acima da faixa", cm: "CM" },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const reduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** count 0 -> target over ~0.9 s; restarts when key changes */
function useCount(target: number, key: string, delay = 0) {
  const [v, setV] = useState(reduced() ? target : 0);
  useEffect(() => {
    if (reduced()) { setV(target); return; }
    let raf = 0, t0 = 0; setV(0);
    const step = (t: number) => {
      if (!t0) t0 = t;
      const k = clamp((t - t0 - delay) / 900, 0, 1);
      setV(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, key, delay]);
  return v;
}

const Y = (cm: number) => 130 + cm * 3.4;

export default function SoilSensorCard({ l, w }: { l: Loan; w: number }) {
  const t = TXT[useLang()];
  const sm = l.smPct?.[w] ?? 50;
  const sat = clamp(Math.round(8 + 0.30 * sm), 5, 45);
  const dry = sm < 25;
  const r10 = clamp(sat - (dry ? 6 : 1), 4, 45);
  const reads = [{ d: 10, v: r10 }, { d: 30, v: clamp(r10 + 6, 4, 45) }, { d: 60, v: clamp(r10 + 15, 4, 45) }];
  const disagree = r10 < sat - 4;
  const conf = disagree ? 4 : 5;
  const temp = Math.round(18 + (l.hotDays?.[w] ?? 0) * 2 + (l.tmin?.[w] ?? 12) * 0.4);
  const h = hash(l.id);
  const ec = (0.3 + (h % 91) / 100).toFixed(1), ph = (5.8 + ((h >>> 8) % 15) / 10).toFixed(1);
  const npk = [0, 1, 2].map(i => ((h >>> (16 + i)) & 1 ? t.ok : t.low)).join(" · ");
  const key = l.id + ":" + w;

  const cSat = useCount(sat, key, 1000), cSen = useCount(r10, key, 1000);
  const c0 = useCount(reads[0].v, key, 800), c1 = useCount(reads[1].v, key, 1100), c2 = useCount(reads[2].v, key, 1400);
  const counts = [c0, c1, c2];
  const caption = (i: number, v: number) => v < 22 ? (i === 0 && dry ? t.dry : t.below) : v > 34 ? t.above : i === 2 ? t.held : t.inr;
  const col = (v: number) => v < 22 ? "var(--pal-orange)" : "var(--pal-steel)";
  const bands: [number, number, string, string][] = [[0, 20, "var(--pal-peach)", t.a], [20, 45, "var(--pal-cream)", t.b], [45, 70, "var(--pal-ice)", t.c]];

  return <div className="card ss-card">
    <div className="ss-head">
      <h3 className="ss-title">{t.title}</h3>
      <span className="ss-pill">{t.pilot}</span>
      <span className="ss-meta">{t.meta}</span>
    </div>
    <div className="ss-body">
      <svg className="ss-svg" viewBox="0 0 400 400" role="img" aria-label={`${t.title}: ${l.id}`}>
        {bands.map(([a, b, f, lab], i) => <g key={i}>
          <rect x="20" y={Y(a)} width="340" height={Y(b) - Y(a)} fill={f} fillOpacity=".6" stroke="var(--pal-navy)" strokeWidth="1" />
          <text x="104" y={Y(a) + 14} className="ss-band">{lab}</text>
        </g>)}
        {[[0, 0], [20, 20], [40, 40], [70, 70]].map(([cm]) => <g key={cm}>
          <line x1="360" x2="366" y1={Y(cm)} y2={Y(cm)} stroke="var(--dim)" />
          <text x="370" y={Y(cm) + 3} className="ss-tick">{cm}{cm === 70 ? " cm" : ""}</text></g>)}
        {[130, 190, 250, 310].map(x => <g key={x} stroke="var(--pal-navy)" strokeWidth="1.4" fill="none" strokeLinecap="round"><path d={`M${x} 130 V118`} /><path d={`M${x} 124 q-8 -2 -9 -10 q8 0 9 10 M${x} 120 q8 -2 9 -10 q-8 0 -9 10`} fill="var(--pal-sky)" fillOpacity=".7" /></g>)}
        <line x1="20" x2="360" y1="130" y2="130" stroke="var(--pal-navy)" strokeWidth="1.6" />

        {/* satellite link */}
        <path id={"ss-link-" + l.id} d="M70 28 L326 24" stroke="var(--pal-steel)" strokeWidth="1.2" strokeDasharray="4 4" fill="none" />
        <rect x="326" y="18" width="12" height="12" transform="rotate(45 332 24)" fill="var(--pal-steel)" />
        <text x="392" y="48" textAnchor="end" className="ss-sat">{t.sat} {sat}%</text>
        {[0, 1, 2].map(i => <circle key={key + i} cx="-20" cy="-20" r="2.6" fill="var(--pal-steel)" className="ss-pkt">
          <animateMotion dur="2.8s" begin={`${1.2 + i * 0.93}s`} repeatCount="indefinite" path="M70 36 L70 28 L326 24" />
        </circle>)}

        {/* probe */}
        <g className="ss-probe" key={key}>
          <line x1="70" x2="70" y1="40" y2="30" stroke="var(--pal-navy)" strokeWidth="1.4" /><circle cx="70" cy="28" r="2.5" fill="var(--pal-navy)" />
          <rect x="48" y="40" width="44" height="22" rx="4" fill="#fff" stroke="var(--pal-navy)" strokeWidth="1.2" />
          <circle cx="58" cy="51" r="2.2" fill="var(--pal-steel)" />
          <text x="98" y="55" className="ss-name">PROBE {l.id}</text>
          <path d={`M66 62 H74 V${Y(70) - 8} L70 ${Y(70) + 4} L66 ${Y(70) - 8} Z`} fill="#fff" stroke="var(--pal-navy)" strokeWidth="1.2" />
          {reads.map((r, i) => {
            const y = Y(r.d);
            return <g key={r.d}>
              <circle cx="70" cy={y} r="6" className="ss-ring" style={{ animationDelay: `${0.9 + i * 0.35}s`, stroke: col(r.v) }} />
              <circle cx="70" cy={y} r="4.2" fill={col(r.v)} stroke="#fff" strokeWidth="1" className="ss-node" style={{ animationDelay: `${0.8 + i * 0.3}s` }} />
              <line x1="76" x2="108" y1={y} y2={y} stroke="var(--pal-navy)" strokeWidth=".8" strokeOpacity=".6" className="ss-leader" style={{ animationDelay: `${0.8 + i * 0.3}s` }} />
              <g className="ss-read" style={{ animationDelay: `${0.8 + i * 0.3}s` }}>
                <text x="114" y={y + 7} fill={col(r.v)} className="ss-big">{r.d} {t.cm} · {counts[i]}%</text>
                <text x="114" y={y + 21} className="ss-cap">{caption(i, r.v)}</text>
              </g>
            </g>;
          })}
        </g>
        <text x="20" y="392" className="ss-foot">{t.normal}</text>
      </svg>

      <div className="ss-panel">
        <div className="ss-lab">{t.surf}</div>
        <div className="ss-nums">
          <div><b style={{ color: "var(--pal-steel)" }}>{cSat}%</b><small>{t.satL}</small></div>
          <div><b style={{ color: "var(--pal-orange)" }}>{cSen}%</b><small>{t.senL}</small></div>
        </div>
        <div className={"ss-agree " + (disagree ? "bad" : "good")}>{disagree ? t.dis : t.agr}</div>
        <hr className="ss-hr" />
        <dl className="ss-kv">
          <dt>{t.temp}</dt><dd>{temp} °C{temp > 28 ? ` · ${t.high}` : ""}</dd>
          <dt>{t.ec}</dt><dd>{ec} dS/m</dd>
          <dt>{t.ph}</dt><dd>{ph}</dd>
          <dt>{t.npk}</dt><dd>{npk}</dd>
        </dl>
      </div>
    </div>
    <div className="ss-conf">
      <span className="ss-lab">{t.conf}</span>
      <span className="ss-segs">{[0, 1, 2, 3, 4].map(i => <i key={i} className={i < conf ? "on" : ""} />)}</span>
      <span className="ss-confv">{conf === 5 ? t.hi : t.mid}</span>
      <span className="ss-meta ss-right">{t.noS}</span>
    </div>
  </div>;
}
