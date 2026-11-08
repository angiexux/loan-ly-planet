// Proposed sites on a map inside the app: country -> county -> parcel, with each parcel's outline (from the Atria API).
// Tiles: Esri World Imagery / World Street Map with place and county labels (public tile services, attributed on the map).
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { SiteRow } from "./thesisApi";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const TILES = {
  satellite: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, "Imagery: Esri, Maxar, Earthstar Geographics"],
  streets: [`${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, "Esri, HERE, Garmin, USGS"],
} as const;
const LABELS = `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`;
const US = L.latLngBounds([24.5, -125], [49.5, -66.5]);
type Level = "country" | "county" | "parcel";

export function SiteMap({ sites, selected, onSelect }: { sites: SiteRow[]; selected: string; onSelect: (id: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const base = useRef<L.TileLayer | null>(null);
  const labels = useRef<L.TileLayer | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const shapes = useRef<Record<string, L.Polygon | L.CircleMarker>>({});
  const timers = useRef<number[]>([]);
  const [mode, setMode] = useState<"satellite" | "streets">("satellite");
  const [level, setLevel] = useState<Level>("country");
  const pick = useRef(onSelect); pick.current = onSelect;
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: false, attributionControl: true, minZoom: 3, scrollWheelZoom: false }).fitBounds(US);
    L.control.zoom({ position: "bottomright" }).addTo(m);
    m.attributionControl.setPrefix("");
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize()); ro.observe(el.current!);
    return () => { ro.disconnect(); timers.current.forEach(clearTimeout); m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current!; base.current?.remove(); labels.current?.remove();
    const [url, attr] = TILES[mode];
    base.current = L.tileLayer(url, { maxZoom: 19, attribution: attr }).addTo(m);
    if (mode === "satellite") labels.current = L.tileLayer(LABELS, { maxZoom: 19, opacity: 0.9 }).addTo(m);
  }, [mode]);

  // parcel outlines (a dot where no outline is known)
  useEffect(() => {
    const g = layer.current!; g.clearLayers(); shapes.current = {};
    for (const s of sites) {
      const on = s.id === selected, ring = s.parcel?.ring;
      const color = on ? "#f26b1d" : "#ffffff";
      const shape = ring?.length
        ? L.polygon(ring.map(([x, y]) => [y, x] as [number, number]), { color, weight: on ? 3 : 2, fillColor: on ? "#f26b1d" : "#ffffff", fillOpacity: on ? 0.3 : 0.12 })
        : L.circleMarker([s.lat ?? 0, s.lng ?? 0], { radius: 9, color, weight: 2, fillColor: color, fillOpacity: 0.5 });
      shape.on("click", () => pick.current(s.id)).bindTooltip(`${s.county} County · ${s.label}`, { direction: "top", className: "th-map-tip" }).addTo(g);
      const at = ring?.length ? (shape as L.Polygon).getBounds().getCenter() : L.latLng(s.lat ?? 0, s.lng ?? 0);
      L.marker(at, { icon: L.divIcon({ className: "", html: `<span class="th-pin ${on ? "on" : ""}"></span>`, iconSize: [0, 0] }), keyboard: false }).on("click", () => pick.current(s.id)).addTo(g);
      shapes.current[s.id] = shape;
    }
  }, [sites, selected]);

  const target = (lv: Level) => {
    const s = sites.find(x => x.id === selected);
    if (!s || lv === "country") return { b: US, z: 5 };
    const shape = shapes.current[s.id];
    const center = shape && "getBounds" in shape ? shape.getBounds().getCenter() : L.latLng(s.lat ?? 0, s.lng ?? 0);
    if (lv === "county") return { c: center, z: 9 };
    return shape && "getBounds" in shape ? { b: shape.getBounds(), z: 16 } : { c: center, z: 15 };
  };
  const go = (lv: Level, fly = true) => {
    const m = map.current; if (!m) return;
    setLevel(lv);
    const t = target(lv);
    if (reduce || !fly) { t.b ? m.fitBounds(t.b, { padding: [30, 30], maxZoom: t.z }) : m.setView(t.c!, t.z); return; }
    t.b ? m.flyToBounds(t.b, { padding: [30, 30], maxZoom: t.z, duration: 1.4 }) : m.flyTo(t.c!, t.z, { duration: 1.4 });
  };
  // a new site: zoom in step by step, country -> county -> parcel
  useEffect(() => {
    timers.current.forEach(clearTimeout); timers.current = [];
    if (!map.current || !selected) return;
    if (reduce) { go("parcel", false); return; }
    go("country");
    timers.current.push(window.setTimeout(() => go("county"), 1500), window.setTimeout(() => go("parcel"), 3200));
  }, [selected]);

  const s = sites.find(x => x.id === selected);
  return <div className="th-map">
    <div ref={el} className="th-map-el" aria-label="Map of the proposed sites" />
    <div className="th-map-levels" role="group" aria-label="Zoom level">
      {(["country", "county", "parcel"] as const).map(lv => <button key={lv} className={level === lv ? "on" : ""} onClick={() => go(lv)}>{lv === "country" ? "Country" : lv === "county" ? `${s?.county ?? ""} County` : "Parcel"}</button>)}
    </div>
    <div className="th-map-tools"><button className={mode === "satellite" ? "on" : ""} onClick={() => setMode("satellite")}>Satellite</button><button className={mode === "streets" ? "on" : ""} onClick={() => setMode("streets")}>Streets</button></div>
    {s?.parcel && <div className="th-map-card"><b>{s.county} County, {s.state}</b><span>{s.parcel.address || s.label}</span>
      <span>Parcel {s.parcel.apn ?? "–"} · {s.parcel.acres != null ? `${s.parcel.acres.toLocaleString(undefined, { maximumFractionDigits: 1 })} acres` : "size not known"}</span></div>}
  </div>;
}
