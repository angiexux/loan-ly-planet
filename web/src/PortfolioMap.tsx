// Portfolio map, adapted from Faraday's site map (src/sitemap.tsx in the GridTech repo): Esri satellite tiles, a layer control
// (overlays: province / state boundaries, province pies, borrower fields, stress clusters; coloured by climate stress level; crop health (CHI) is not shown on the map),
// full screen, a polygon per field (a dot when zoomed out). Everything follows the selected week (rows + w).
import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { LEVELS, LEVEL_COLOR, PALETTE, levelLabel, perilLabel, provinceOf, usd } from "./data";
import type { Cluster, Level, Row } from "./data";
import { useLang } from "./i18n";
import { cropLabel, countryName } from "./locales/common";
import { useP } from "./locales/pages";
import { useMp } from "./locales/map";

const cropName = (c: string) => cropLabel(c, c);
type Part = { v: number; color: string };
/** SVG pie from coloured parts */
/** modern donut: thin ring of rounded, translucent arcs with small gaps over a faint track, glass centre with the total */
export function pieSvg(parts: Part[], size: number) {
  const live = parts.filter(x => x.v > 0), total = live.reduce((t, x) => t + x.v, 0), r = size / 2, ro = r - 1, ri = r * 0.64;
  if (!total) return "";
  const rm = (ro + ri) / 2, sw = ro - ri, C = 2 * Math.PI * rm, gap = live.length > 1 ? sw * 0.35 + 1.2 : 0;
  let off = 0, out = "";
  for (const x of live) {
    const seg = (x.v / total) * C;
    if (live.length === 1) out += `<circle cx="${r}" cy="${r}" r="${rm.toFixed(2)}" fill="none" stroke="${x.color}" stroke-opacity=".85" stroke-width="${sw.toFixed(2)}"/>`;
    else {
      const len = Math.max(0.01, seg - gap - sw), start = off + (gap + sw) / 2;
      out += `<circle cx="${r}" cy="${r}" r="${rm.toFixed(2)}" fill="none" stroke="${x.color}" stroke-opacity=".85" stroke-width="${sw.toFixed(2)}" stroke-linecap="round" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-start).toFixed(2)}" transform="rotate(-90 ${r} ${r})"/>`;
    }
    off += seg;
  }
  const fs = Math.max(9, Math.round(size * 0.26));
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${r}" cy="${r}" r="${rm.toFixed(2)}" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="${sw.toFixed(2)}"/>${out}<circle cx="${r}" cy="${r}" r="${(ri - 1.5).toFixed(2)}" fill="rgba(255,255,255,.72)" stroke="rgba(255,255,255,.9)" stroke-width="1"/><text x="${r}" y="${r}" text-anchor="middle" dominant-baseline="central" font-family="Inter, system-ui, sans-serif" font-size="${fs}" font-weight="700" fill="#1f4e6e">${total}</text></svg>`;
}
export function Pie({ parts, size }: { parts: Part[]; size: number }) { return <span style={{ display: "inline-flex" }} dangerouslySetInnerHTML={{ __html: pieSvg(parts, size) }} />; }
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const SATELLITE = ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", "Imagery: Esri, Maxar, Earthstar Geographics · boundaries: Natural Earth"] as const;
const LABELS = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
// state / province outlines: Natural Earth 1:10m admin-1 (public domain), simplified, in public/data/states.geojson
let statesGeo: Promise<GeoJSON.FeatureCollection | null> | null = null;
const loadStatesGeo = () => (statesGeo ??= fetch("/data/states.geojson").then(r => (r.ok ? r.json() : null)).catch(() => null));
const FIELD_ZOOM = 10;      // level of detail: dots below, field polygons from here
const PIE_MAX_ZOOM = 8;     // province pies hide once you are inside a province

export default function PortfolioMap({ rows, selected, onSelect, hero = false, clusters = [], w = 0, province = null, onProvince }: {
  rows: Row[]; selected: string | null; onSelect?: (id: string) => void; hero?: boolean; clusters?: Cluster[]; w?: number; province?: string | null; onProvince?: (key: string | null) => void;
}) {
  const p = useP(), m_ = useMp(), lang = useLang();
  const box = useRef<HTMLDivElement>(null);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const bounds = useRef<L.LatLngBounds | null>(null);
  const fieldsG = useRef<L.LayerGroup | null>(null), piesG = useRef<L.LayerGroup | null>(null), bordersG = useRef<L.LayerGroup | null>(null);
  const provBounds = useRef<Map<string, L.LatLngBounds>>(new Map());
  const pick = useRef(onSelect); pick.current = onSelect;
  const pickProv = useRef(onProvince); pickProv.current = onProvince;
  const [zoom, setZoom] = useState(5);
  const [moved, setMoved] = useState(0);          // bumps on every pan, so field outlines near the new view get drawn
  const [geo, setGeo] = useState<GeoJSON.FeatureCollection | null>(null);
  const [full, setFull] = useState(false);
  const [panel, setPanel] = useState(false);
  const [show, setShow] = useState({ bounds: true, pies: true, fields: true, clusters: true });
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const cat = (r: Row) => r.level;                                   // the map is coloured by climate stress level only
  const colorOf = (r: Row) => LEVEL_COLOR[r.level];
  const RANGE: Record<Level, string> = { Severe: "70–99", High: "45–69", Watch: "25–44", Normal: "1–24" };   // entry thresholds (hysteresis: leaving needs a lower score)
  const cats: { k: string; label: string; color: string }[] = LEVELS.map(L_ => ({ k: L_, label: `${levelLabel(L_ as Level)} (${RANGE[L_ as Level]})`, color: LEVEL_COLOR[L_ as Level] }));

  // borrowers per province in the selected week (for the pies)
  const provs = useMemo(() => {
    const m = new Map<string, { name: string; country: string; rows: Row[] }>();
    for (const r of rows) { const pv = provinceOf(r.loan); const e = m.get(pv.key) ?? { name: pv.name, country: r.loan.country, rows: [] }; e.rows.push(r); m.set(pv.key, e); }
    return m;
  }, [rows]);

  // ---- map, once
  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: false, attributionControl: !hero, minZoom: 3, scrollWheelZoom: !hero, dragging: !hero, doubleClickZoom: !hero, keyboard: !hero, preferCanvas: true });
    if (!hero) L.control.zoom({ position: "bottomright" }).addTo(m);
    m.attributionControl?.setPrefix("");
    L.tileLayer(SATELLITE[0], { maxZoom: 19, attribution: SATELLITE[1] }).addTo(m);
    if (!hero) L.tileLayer(LABELS, { maxZoom: 19, opacity: 0.85 }).addTo(m);     // landing page: imagery only, no names or borders
    bordersG.current = L.layerGroup().addTo(m);
    fieldsG.current = L.layerGroup().addTo(m);
    piesG.current = L.layerGroup().addTo(m);
    map.current = m;
    m.setView([-31.5, -60], 5);
    m.on("zoomend", () => setZoom(m.getZoom()));
    const ro = new ResizeObserver(() => m.invalidateSize()); ro.observe(el.current!);
    // a zoom still animating would fire _onZoomTransitionEnd on the removed map; clear the flag so it returns early
    return () => { ro.disconnect(); m.stop(); (m as unknown as { _animatingZoom: boolean })._animatingZoom = false; m.remove(); map.current = null; };
  }, [hero]);
  useEffect(() => { if (!hero) loadStatesGeo().then(setGeo); }, [hero]);

  // fit the whole portfolio once
  useEffect(() => {
    if (!rows.length || bounds.current) return;
    bounds.current = L.latLngBounds(rows.map(r => [r.loan.lat, r.loan.lng] as [number, number])).pad(0.08);
    const fit = () => { const m = map.current; if (!m || !bounds.current) return; m.invalidateSize(); m.fitBounds(bounds.current, hero ? { paddingTopLeft: [Math.round(m.getSize().x * 0.5), 60] } : { padding: [20, 20] }); };
    fit(); window.setTimeout(fit, 250);
  }, [rows, hero]);

  // ---- full screen: a fixed overlay (works on every browser); Esc leaves it
  useEffect(() => {
    if (!full) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", key); document.body.classList.add("map-full-open");
    return () => { window.removeEventListener("keydown", key); document.body.classList.remove("map-full-open"); };
  }, [full]);
  useEffect(() => { const m = map.current; if (m) window.setTimeout(() => m.invalidateSize(), 60); }, [full]);

  // ---- province / state boundaries: hover highlights and names it, click selects and zooms
  useEffect(() => {
    const g = bordersG.current; if (!g) return; g.clearLayers(); provBounds.current.clear();
    if (hero || !geo) return;
    const keyOf = (f?: GeoJSON.Feature) => `${f?.properties?.name}|${f?.properties?.country}`;
    const style = (f?: GeoJSON.Feature): L.PathOptions => {
      const k = keyOf(f), on = k === province, has = provs.has(k);
      return show.bounds ? { color: on ? "#ffffff" : has ? "rgba(207,233,236,.7)" : "rgba(207,233,236,.32)", weight: on ? 2.5 : has ? 1.2 : 0.6, fillColor: PALETTE.sky, fillOpacity: on ? 0.2 : 0 }
        : { stroke: false, fillOpacity: 0, fill: on, ...(on ? { fillColor: PALETTE.sky, fillOpacity: 0.2 } : {}) };
    };
    const lyr = L.geoJSON(geo, {
      style, interactive: true,
      onEachFeature: (f, layer) => {
        const k = keyOf(f), pv = provs.get(k);
        provBounds.current.set(k, (layer as L.Polygon).getBounds());
        if (!show.bounds) return;
        layer.bindTooltip(`<b>${esc(String(f.properties?.name))}</b>, ${esc(countryName(String(f.properties?.country)))}${pv ? ` · ${p("mp.stateTip", pv.rows.length)}` : ""}`, { sticky: true, className: "map-tip" });
        layer.on("mouseover", () => (layer as L.Path).setStyle({ weight: 2, color: "#ffffff", fillColor: PALETTE.sky, fillOpacity: 0.14 }));
        layer.on("mouseout", () => lyr.resetStyle(layer as L.Path));
        layer.on("click", () => { if (pv) pickProv.current?.(k); });
      },
    }).addTo(g);
    lyr.bringToBack();
  }, [geo, province, provs, show.bounds, hero, lang]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- a selected province: zoom to it; closing it goes back to the whole book
  const lastProv = useRef<string | null>(null);
  useEffect(() => {
    const m = map.current; if (!m || hero) return;
    const opt = { duration: reduce ? 0 : 1.1 };
    if (province) { const b = provBounds.current.get(province) ?? (provs.get(province) ? L.latLngBounds(provs.get(province)!.rows.map(r => [r.loan.lat, r.loan.lng] as [number, number])).pad(0.2) : null); if (b) m.flyToBounds(b, { ...opt, padding: [30, 30] }); }
    else if (lastProv.current && bounds.current) m.flyToBounds(bounds.current, opt);
    lastProv.current = province;
  }, [province, geo]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- province pies (counts by the colour-by categories), hidden once zoomed into a province
  useEffect(() => {
    const g = piesG.current; if (!g) return; g.clearLayers();
    if (hero || !show.pies || zoom >= PIE_MAX_ZOOM) return;
    for (const [k, pv] of provs) {
      const counts = cats.map(c => ({ ...c, v: pv.rows.filter(r => cat(r) === c.k).length }));
      const size = 30 + Math.min(22, pv.rows.length * 0.45);
      const ctr = provBounds.current.get(k)?.getCenter() ?? L.latLng(pv.rows.reduce((s, r) => s + r.loan.lat, 0) / pv.rows.length, pv.rows.reduce((s, r) => s + r.loan.lng, 0) / pv.rows.length);
      L.marker(ctr, { icon: L.divIcon({ html: `<div class="state-pie${k === province ? " on" : ""}">${pieSvg(counts.map(c => ({ v: c.v, color: c.color })), size)}<b>${esc(pv.name)}</b></div>`, className: "", iconSize: [size, size + 18], iconAnchor: [size / 2, size / 2] }), zIndexOffset: 1000 })
        .bindTooltip(`<b>${esc(pv.name)}, ${esc(countryName(pv.country))}</b> · ${p("mp.stateTip", pv.rows.length)}<br/>${counts.filter(c => c.v).map(c => `<span style="color:${c.color}">●</span> ${esc(c.label)}: ${c.v} (${Math.round(100 * c.v / pv.rows.length)}%)`).join("<br/>")}`, { direction: "top", className: "map-tip" })
        .on("click", () => pickProv.current?.(k)).addTo(g);
    }
  }, [provs, show.pies, zoom, w, province, geo, hero, lang]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- borrowers: a dot when zoomed out, the field outline from FIELD_ZOOM; click opens the borrower popup
  const popupHtml = (r: Row) => {
    const l = r.loan;
    const rowsH: [string, string][] = [[m_("pop.crop"), cropName(l.crop)], [m_("pop.area"), `${l.areaHa.toLocaleString()} ha`], [m_("pop.loan"), usd(l.amountUsd)],
      [m_("pop.stress"), `<span style="color:${LEVEL_COLOR[r.level]};font-weight:700">${esc(levelLabel(r.level))} ${Math.round(r.score)}</span>${r.main ? ` · ${esc(perilLabel(r.main))}` : ""}`]];
    return `<div class="pop"><b>${esc(l.id)} · ${esc(l.borrower)}</b><small>${esc(l.region)}, ${esc(countryName(l.country))}</small>
      <table>${rowsH.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("")}</table>
      ${pick.current ? `<button class="pop-open" data-loan="${esc(l.id)}">${esc(m_("pop.open"))}</button>` : ""}</div>`;
  };
  useEffect(() => {
    const m = map.current, g = fieldsG.current; if (!m || !g) return; g.clearLayers();
    if (hero) return;
    if (show.clusters) for (const c of clusters) {
      L.circle([c.lat, c.lng], { radius: c.radiusKm * 1000, color: PALETTE.cream, weight: 1.6, opacity: 0.9, dashArray: "6 6", fill: true, fillColor: PALETTE.peach, fillOpacity: 0.10, interactive: true })
        .bindTooltip(p("mp.clusterTip", c.loanIds.length, usd(c.ead), c.meanScore.toFixed(0)), { sticky: true, className: "map-tip" }).addTo(g);
    }
    if (!show.fields) return;
    const maxE = Math.max(1, ...rows.map(r => r.loan.amountUsd));
    const view = m.getBounds().pad(0.3), detail = zoom >= FIELD_ZOOM;
    const sorted = [...rows].sort((a, b) => a.score - b.score);       // stressed on top
    for (const r of sorted) {
      const l = r.loan, on = l.id === selected, col = colorOf(r), dim = !!province && provinceOf(l).key !== province;
      const tip = `<b>${esc(l.id)}</b> · ${esc(l.borrower)}<br/>${p("mp.stressTip", levelLabel(r.level), Math.round(r.score), usd(r.ead))}`;
      if (detail && l.ring) {
        if (!view.contains([l.lat, l.lng])) continue;                 // level of detail: only outlines near the view
        const ring = l.ring.map(([x, y]) => [y, x] as [number, number]);
        L.polygon(ring, { color: "#fff", weight: on ? 3 : 1, fillColor: col, fillOpacity: dim ? 0.1 : 0.28, opacity: dim ? 0.35 : 0.8 })
          .bindTooltip(tip, { direction: "top", className: "map-tip" }).bindPopup(popupHtml(r), { className: "map-pop", maxWidth: 300 }).addTo(g);
        continue;
      }
      const rad = 4 + 9 * Math.sqrt(l.amountUsd / maxE);
      L.circleMarker([l.lat, l.lng], { radius: on ? rad + 3 : rad, color: "#ffffff", weight: on ? 3.5 : 1, fillColor: col, fillOpacity: dim ? 0.2 : 0.6, opacity: dim ? 0.35 : 0.8 })
        .bindTooltip(tip, { direction: "top", className: "map-tip" }).bindPopup(popupHtml(r), { className: "map-pop", maxWidth: 300 }).addTo(g);
    }
  }, [rows, selected, zoom, moved, hero, clusters, show.fields, show.clusters, w, province, lang]);   // eslint-disable-line react-hooks/exhaustive-deps
  // the popup's button opens the loan's climate analysis
  useEffect(() => {
    const m = map.current; if (!m) return;
    const on = (e: L.PopupEvent) => { e.popup.getElement()?.querySelector<HTMLButtonElement>(".pop-open")?.addEventListener("click", ev => { pick.current?.((ev.currentTarget as HTMLButtonElement).dataset.loan!); }); };
    m.on("popupopen", on); return () => { m.off("popupopen", on); };
  }, []);
  useEffect(() => { const m = map.current; if (!m || hero) return; const h = () => setMoved(x => x + 1); m.on("moveend", h); return () => { m.off("moveend", h); }; }, [hero]);

  const home = () => { pickProv.current?.(null); const m = map.current; if (m && bounds.current) m.flyToBounds(bounds.current, { duration: reduce ? 0 : 1.1 }); };
  // a newly selected loan (from the table or another page): fly to its field
  useEffect(() => {
    const m = map.current; if (hero || !selected || !m) return;
    const r = rows.find(x => x.loan.id === selected); if (!r) return;
    if (r.loan.ring) m.flyToBounds(L.latLngBounds(r.loan.ring.map(([x, y]) => [y, x] as [number, number])), { duration: reduce ? 0 : 1.6, padding: [60, 60], maxZoom: 14 });
    else m.flyTo([r.loan.lat, r.loan.lng], 14, { duration: reduce ? 0 : 1.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const s = rows.find(x => x.loan.id === selected);
  const set = (k: keyof typeof show) => setShow(x => ({ ...x, [k]: !x[k] }));
  return <div ref={box} className={`${hero ? "hero-map" : "map"} ${full ? "map-full" : ""}`}>
    <div ref={el} className="map-el" aria-label={p("mp.label")} />
    {!hero && <>
      <div className="map-levels" role="group" aria-label={p("mp.zoom")}>
        <button className={!province && zoom < FIELD_ZOOM ? "on" : ""} onClick={home}>{p("mp.portfolio")}</button>
      </div>
      <div className="map-tools">
        <button className={panel ? "on" : ""} onClick={() => setPanel(o => !o)} aria-expanded={panel}>{m_("layers")}</button>
        <button onClick={() => setFull(f => !f)} aria-pressed={full} title={full ? m_("exitFull") : m_("full")} aria-label={full ? m_("exitFull") : m_("full")}>{full ? "✕" : "⤢"}</button>
      </div>
      {panel && <div className="map-layers" role="group" aria-label={m_("layers")}>
        <h5>{m_("base")}</h5>
        <label><input type="radio" checked readOnly /> {m_("satellite")}</label>
        <h5>{m_("overlays")}</h5>
        {([["bounds", "lyr.bounds"], ["pies", "lyr.pies"], ["fields", "lyr.fields"], ["clusters", "lyr.clusters"]] as const).map(([k, lb]) => <label key={k}><input type="checkbox" checked={show[k]} onChange={() => set(k)} /> {m_(lb)}</label>)}
        <h5>{m_("colourBy")}</h5>
        <label><input type="radio" name="colour-by" checked readOnly /> {m_("by.stress")}</label>
      </div>}
      <div className="map-legend">
        <b className="leg-title">{m_("leg.stress")}</b>
        <i className="leg-bar" aria-hidden />
        {cats.map(c => <span key={c.k}><i className="dot" style={{ ["--c" as string]: c.color }} />{c.label}</span>)}
        <span style={{ color: "var(--pal-blue)" }}>{zoom < PIE_MAX_ZOOM && show.pies ? m_("leg.pie") : m_("leg.dot")}</span>
        {clusters.length > 0 && show.clusters && <span><i className="dot" style={{ border: "1.5px dashed var(--pal-cream)", boxShadow: "0 0 0 1px rgba(31,78,110,.25)", background: "color-mix(in srgb, var(--pal-peach) 45%, transparent)", width: 12, height: 12 }} />{p("mp.cluster")}</span>}
      </div>
      {s && <div className="map-card"><b>{s.loan.id} · {s.loan.borrower}</b><span>{s.loan.region}, {countryName(s.loan.country)}</span><span>{s.loan.areaHa.toLocaleString()} ha · {cropName(s.loan.crop)} · {usd(s.loan.amountUsd)}</span><span style={{ color: LEVEL_COLOR[s.level], fontWeight: 700 }}>{p("mp.card", levelLabel(s.level), Math.round(s.score))}{s.main ? ` · ${perilLabel(s.main)}` : ""}</span></div>}
    </>}
  </div>;
}
