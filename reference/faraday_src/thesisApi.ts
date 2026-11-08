// Client for the thesis endpoints of team_app/gridtech_server.py (team_app/thesis_agents.py).
import type { StressInput } from "./api";

export type QKey = "speed" | "cost" | "environment" | "continuity" | "slip" | "premium" | "staging";
export const QUESTION_KEYS: QKey[] = ["speed", "cost", "environment", "continuity", "slip", "premium", "staging"];

export interface ThesisInput {
  title: string; isos: string[]; peakMw: number | string; questions: QKey[];
  fullTarget: number | string; fullCompare: number | string; fullLatest: number | string; premiumPct: number | string; co2Max: number | string;
  slipMonths: number | string; slipOpening: number | string; slipDelayed: number | string; wholesaleGrowth: number | string; gasGrowth: number | string;
  reliability: string; weights: { speed: number; cost: number; environment: number };
  ownership: "domestic" | "foreign" | "designated" | null; appetite: "Low" | "Medium" | "High"; localNotes: string; stress: StressInput | null; excluded?: string[]; capexUpliftPct?: number | string; gridAdderExtra?: number | string;
}

export type AgentKey = "optimisation" | "financial" | "sourcing" | "moratorium";
export interface Agent { name: string; status: "queued" | "running" | "done" | "failed" | "waiting" | "not-connected" | "stopped"; detail: string }

/** One optimiser run, summarised (team_app/thesis_agents._run_summary). */
export interface RunSum {
  jobId: string; tag: string; status: string; resultStatus: string | null; phase: string | null; elapsed: number | null; reason: string | null;
  opening?: number; fullDemand?: number; costM?: number; dollarsPerMwh?: number; kgPerMwh?: number; cleanSharePct?: number; merchantGwh?: number; merchantSharePct?: number;
  interruptedMwh?: number; relocatedMwh?: number; landAcres?: number; landLimit?: number; maxImportMw?: number; caps?: Record<string, number>; detail?: string;
  capacities?: { id: string; label: string; mw: number; from: number; fromLabel: string }[];
  annual?: { model_year: number; requested_mwh: number; total_decision_cost_usd: number; combined_electricity_co2_kg_per_mwh: number | null; clean_energy_share: number | null; merchant_mwh: number }[];
  gridSchedule?: { month: number; label: string; mw: number }[]; checker?: string; sizingStatus?: string; staged?: boolean;
  gasMwhByYear?: Record<string, number[]> | null;
  stress?: { events: number; hoursPerYear: number; worst: { when: string; gasNeedMw: number } | null } | null;
}
/** A portfolio from the financial agent's pools. */
export interface PoolRow { opening: number; fullDemand: number; costM: number; kgPerMwh: number; cleanSharePct: number; merchantSharePct: number; merchantGwh: number; interruptedMwh: number; relocatedMwh: number; dollarsPerMwh: number; caps: Record<string, number>; detail: string }
export type Portfolio = Partial<RunSum> & Partial<PoolRow>;

export interface Answer {
  status: "ok" | "none" | "pending" | "not-covered" | "error"; text?: string;
  target?: Portfolio; compare?: Portfolio; best?: Portfolio; noTier2?: Portfolio; withTier2?: Portfolio; base?: Portfolio; keep?: Portfolio; delay?: Portfolio;
  upfront?: Portfolio; staged?: Portfolio; cleanestInside?: Portfolio | null; tried?: Portfolio[]; tested?: number[];
  extraM?: number; extraPct?: number; premiumPct?: number; feasible?: boolean; changes?: Record<string, number>; earlyUpfrontM?: number; earlyStagedM?: number;
}
export interface Scenario { key: string; label: string; jobId: string | null; status: string; reused?: boolean; error?: string; run: RunSum | null; start: number; gridDelay: number; noTier2: boolean; staged: boolean; co2Cap: number | null }
export interface CompareRow { question: QKey; item: string; optimiser: Portfolio; financial: Portfolio; costDiffPct: number | null }
export interface SiteRow {
  id: string; label: string; county: string; state: string; iso: string | null; score: number; verdict: string; thesisFails: string[]; acres: number | null;
  stall: number | null; stallMax: number | null; gridP50: number | null; powerBy: number | null; risks: string[];
  lat?: number; lng?: number; acresBasis?: "parcel"; stallLayers?: { local: number | null; state: number | null; commercial: number | null }; stallInputs?: string[];
  parcel?: { ring: [number, number][] | null; apn: string | null; address: string | null; acres: number | null; legalAcres: number | null } | null;
  policy?: Record<string, { value: unknown; note: string; source: string; date: string | null }>;
  land?: { lat: number; lng: number; error?: string; facts: { key: string; label: string; group: string; value: unknown; unit: string; source: string; placeholder: boolean }[] };
  moratorium: Cat; local: Cat; environment: Cat;
}
interface Cat { headline: string | null; outcome: string | null; s: number | null; reason: string | null }

export interface FinancialRec {
  status: string; error?: string;
  recommendation?: { name: string; detail: string; opening: number; fullDemand: number; score: number; capacityText: string; why: string; nextStep: string; kpis: Record<string, number> };
  options?: { role: string; label: string; detail: string; opening: number; fullDemand: number; costM: number; kgPerMwh: number; tag: string }[];
  tradeoffs?: { top: "cost" | "speed" | "carbon" | "balanced"; weights: number[]; recommended: Anchor; anchors: Record<"cheapest" | "fastest" | "cleanest", Anchor> };
  sensitivity?: Sensitivity | null;
  costBreakdown?: { rows: { label: string; valueM: number; sharePct: number; note: string }[] };
  powerOverTime?: { years: number[]; span: string[]; series: Record<string, number[]> };
  portfolioTable?: { id: string; label: string; selected: boolean; mw: number; landAcres: number; location: string }[];
  search?: { tested: number; passing: number };
  reliability?: { backup?: { criticalMw: number; firmN1Mw: number; shortfallMw: number; options: { name: string; addedMw: number; totalM: number; note: string }[] } };
}

export interface Anchor { opening: number; fullDemand: number; costM: number; kgPerMwh: number; cleanSharePct: number; detail: string }
export interface Sensitivity {
  scenarios: { key: "bear" | "base" | "bull"; label: string; text: string; wholesalePct: number; gasPct: number }[];
  rows: { label: string; role: string; detail: string; opening: number; fullDemand: number; kgPerMwh: number; tag: string; deltaPct: { bear: number; bull: number }; perScenario: Record<string, { totalM: number }> }[];
  yearly: { years: number[]; series: Record<"bear" | "base" | "bull", number[]> } | null; note: string;
}
export type Weights = { speed: number; cost: number; environment: number };

export interface ThesisView {
  mode?: "thesis" | "run"; runJobId?: string | null;
  id: string; createdAt: number; thesis: ThesisInput & { _stressLabel?: string; peakMw: number; questions: QKey[] };
  agents: Record<AgentKey, Agent>; scenarios: Scenario[];
  answers: { optimisation: Partial<Record<QKey, Answer>>; financial: (Partial<Record<QKey, Answer>> & { match?: Answer }) | null };
  compare: CompareRow[];
  financial: { method: string; poolSize: number; poolNoTier2: number; openings: [number, number]; scopeNote: string | null; packetNote?: string; weights?: Weights; recommendation?: FinancialRec } | null;
  moratorium: { source: string; url?: string; sites: SiteRow[]; allSites: number; note: string | null } | null;
}
export interface ThesisRow { id: string; createdAt: number; title: string; questions: QKey[]; agents: Record<AgentKey, Agent["status"]> }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try { res = await fetch(path, init); } catch { throw new Error("The model server is not reachable."); }
  const data = await res.json().catch(() => ({ error: `The server answered ${res.status} without JSON.` }));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { errors: data.errors as Record<string, string> | undefined });
  return data as T;
}
export const startThesis = (t: ThesisInput) => call<{ id: string }>("/api/thesis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t) });
export const getThesis = (id: string) => call<ThesisView>(`/api/thesis/${id}`);
export const listTheses = () => call<ThesisRow[]>("/api/theses");
export const stopThesis = (id: string) => call<{ ok: boolean }>(`/api/thesis/${id}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
export const rerankThesis = (id: string, weights: Weights) => call<{ ok: boolean }>(`/api/thesis/${id}/rerank`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weights }) });
export const startRunAgents = (jobId: string, body: { weights?: Weights; template?: string | null }) => call<{ id: string }>(`/api/job/${jobId}/agents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
