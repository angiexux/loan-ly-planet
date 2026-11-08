// Client for the GRIDTECH model server (Faraday.ipynb's optimiser) (team_app/gridtech_server.py). Same-origin: the dev server proxies /api to it, the built site is served by it.

export type RelKey = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";
export type Editable = "capex_usd_per_kw" | "fom_usd_per_kw_year" | "payment_usd_per_mwh" | "available_month" | "max_mw";

export interface Resource {
  id: string; label: string; short: string; location: "onsite" | "offsite"; color: string;
  capex_usd_per_kw: number; fom_usd_per_kw_year: number; payment_usd_per_mwh: number; available_month: number; max_mw: number; block_mw: number;
}
export interface Meta {
  resources: Resource[];
  reliability: { key: RelKey; text: string }[];
  packetSchedule: { month: number; mw: number }[];
  limits: { peak: [number, number]; start: [number, number]; interconnection: [number, number]; growth: [number, number] };
  defaults: { peakMw: number; start: number; reliability: RelKey; wholesaleGrowth: number; gasGrowth: number; staged: boolean };
  busy: string | null;
}

export type Interconnection = { mode: "steps"; steps: { month: number; mw: string }[] } | { mode: "month"; month: number } | { mode: "packet" };
/** The answers to the optimiser's questions Q2-Q10. */
/** A run started from a suggested alternative: the run it is an alternative to, and exactly what differs from that run's inputs. */
export interface AlternativeOf { ofJobId: string; ofTag: string; title?: string; changes: string[]; original: RunInputs | null }
/** One stress event on the model's clock (US Central, reference year 2023): start "2023-08-24T15:00", duration, import still allowed, notice.
 *  operator/type/confidence/notes describe catalog events; include = ticked on the page. */
export interface StressRow {
  id: string; start: string; hours: string; importPct: string; noticeMin: string; include: boolean;
  operator?: string; type?: string; confidence?: string; notes?: string;
}
/** packet = the packet's seven ERCOT events; custom = the included rows in `events` (`excluded` keeps the unticked ones for editing). */
export type StressInput = { mode: "packet" } | { mode: "custom"; source: string; events: StressRow[]; excluded?: StressRow[] };
/** Numbers go as typed (strings); the server validates them again with the same rules as the page. */
export interface RunInputs {
  peakMw: string; calendarStart: string | null; start: string; interconnection: Interconnection; reliability: RelKey; co2Cap: string | null;
  wholesaleGrowth: number; gasGrowth: number; resources: Record<string, Partial<Record<Editable, string>>>; minCaps: Record<string, string>; staged: boolean;
  stressEvents?: StressInput;          // missing (older runs) = the packet's events
  alternative?: AlternativeOf;
  excluded?: string[];                 // resources switched off (not available)
  gridDelay?: number;                  // the grid connection slips by this many months
  gridAdderExtra?: number;             // $/MWh added to every MWh bought from the grid
  landAcres?: string | null;           // onsite land for equipment (a proposed site's); null = 8 acres x peak/75
  agents?: { weights: { speed: number; cost: number; environment: number }; template: string | null };   // start the four agents around this run
}
type CatalogRow = Omit<StressRow, "hours" | "importPct" | "noticeMin"> & { hours: number; importPct: number; noticeMin: number };
/** The packet's events and the bundled 2023 catalog by interconnection (team_app/stress_data/), on the model's clock. */
export interface StressMeta {
  timezone: string; year: number; limits: { events: number; hours: number; totalHours: number }; relocationNoticeMin: number;
  packet: CatalogRow[]; areas: { area: string; operators: string[]; events: CatalogRow[] }[]; states: { state: string; postal: string; area: string }[]; source: string;
}
/** How the stress events bit in a run: stress hours, the stress hour needing most onsite gas, and the gas built. */
export interface StressSummary {
  label: string; custom: boolean; events: number; hoursPerYear: number; gasMw: number; largestUnitMw: number;
  worst: { modelHour: number; modelMonth: number; modelYear: number; when: string; loadMw: number; flexMw: number; importMw: number; gasNeedMw: number } | null;
}
/** A saved run with the same inputs except the stress events. */
export interface CompareRow {
  id: string; tag: string; startedAt: number | null; stressText: string; stressInputs: StressInput | null; stress: StressSummary | null;
  kpis: Kpis | null; capacities: { id: string; label: string; mw: number }[] | null; sizingStatus: string | null;
}

export interface EffectiveResource {
  id: string; label: string; location: string; available_month: number; block_mw: number; max_mw: number; capex_usd_per_kw: number; fom_usd_per_kw_year: number;
  life_years: number; payment_usd_per_mwh: number; heat_rate_mmbtu_per_mwh_hhv: number; co2_t_per_mwh: number; land_acres_per_mw: number; fixed_usd_per_mw_year: number;
}
export interface Kpis {
  total_decision_cost_usd: number; local_energy_cost_usd: number; relocation_cost_usd: number; interruption_consequence_usd: number;
  decision_cost_usd_per_requested_mwh: number; local_energy_cost_usd_per_mwh: number; combined_electricity_co2_kg_per_mwh: number;
  combined_operational_co2_t: number; clean_energy_share: number; merchant_mwh: number; interrupted_mwh: number;
  relocated_local_equivalent_mwh: number; requested_mwh: number; land_acres: number; max_grid_import_mw: number;
}
export interface AnnualRow { model_year: number; requested_mwh: number; total_decision_cost_usd: number; combined_electricity_co2_kg_per_mwh: number | null; clean_energy_share: number | null; merchant_mwh: number }
/** Why no portfolio was found, and nearby inputs that pass every capacity rule (team_app/gridtech_diagnose.py). */
export interface Diagnosis {
  reasons: { key: string; rule: string; title: string; detail: string; fixes: string[] }[];
  alternatives: { key: string; title: string; changes: string[]; inputs: RunInputs; verified: boolean; note: string }[];
  method: string;
}
export interface Result {
  status: string; message?: string; sizingStatus?: string; sizingSteps?: SizingStep[] | null; sizingSeconds?: number; checker?: string; seconds?: number; skippedSizing?: boolean; diagnosis?: Diagnosis;
  reliability?: RelKey; reliabilityText?: string; reliabilityLabel?: string; staged?: boolean; peakMw?: number;
  opening?: number; openingLabel?: string; fullDemand?: number; fullDemandLabel?: string; co2Cap?: number | null; co2CapMet?: boolean | null; co2Price?: number | null; minCaps?: Record<string, number>;
  kpis?: Kpis;
  capacities?: { id: string; label: string; mw: number; from: number; fromLabel: string }[];
  capacitiesByYear?: { year: number; label: string; caps: Record<string, number> }[];
  annual?: AnnualRow[];
  stress?: StressSummary;
  effective?: { peakMw: number; annualEnergyGwh: number; landAcres: number; remoteMw: number; gridSchedule: { month: number; label: string; mw: number }[]; resources: EffectiveResource[] };
  plots?: { key: string; title: string; url: string }[];
  files?: Record<string, string>;
  outputDir?: string;
}
/** One of the three sizing solves (gridtech_model.size): relax = lower bound, restrict = whole blocks near it, polish = full search from there. */
export interface SizingStep { step: "relax" | "restrict" | "polish" | "full"; status: string; seconds: number; objective: number | null }
/** Live solver progress: the sizing MIP (best portfolio cost found, lower bound, gap; history = [seconds, best, bound]) and the yearly dispatch. */
export interface Progress {
  step: "prepare" | "size" | "dispatch" | "score" | "plots" | "diagnose" | "done"; timeLimit: number;
  mip: { variables: number | null; constraints: number | null; best: number | null; bound: number | null; gap: number | null; nodes: number; solutions: number; seconds: number; history: [number, number | null, number | null][]; status: string | null; startedAt: number | null; updatedAt: number | null;
    stage?: SizingStep["step"] | null; steps?: SizingStep[] };
  dispatch: { done: number; total: number };
}
export interface Job {
  id: string; status: "running" | "done" | "failed"; phase: string | null; log: string[]; tag: string; startedAt?: number; elapsed: number | null;
  error: string | null; inputs?: RunInputs; alternative?: AlternativeOf | null; progress?: Progress; result: Result | null;
  thesisId?: string | null;            // the agents around this run
  thesis?: { id: string; title: string; scenario: string } | null;   // set for runs made by a multi-question thesis
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("The model server is not reachable. Start it with faraday_web/run.sh (or python team_app/gridtech_server.py).");
  }
  const data = await res.json().catch(() => ({ error: `The server answered ${res.status} without JSON.` }));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { jobId: data.jobId as string | undefined, errors: data.errors as Record<string, string> | undefined });
  return data as T;
}

export const getMeta = () => call<Meta>("/api/meta");
export const startRun = (inputs: RunInputs) => call<{ jobId: string }>("/api/run", inputs);
export const getJob = (id: string) => call<Job>(`/api/job/${id}`);
/** One saved run, as listed on the Previous runs page. */
export interface RunRow {
  name?: string | null; id: string; tag: string; status: Job["status"]; startedAt: number | null; elapsed: number | null; resultStatus: string | null; sizingStatus: string | null;
  error: string | null; alternative: boolean; peakMw: string | null; start: string | null; reliability: RelKey | null; staged: boolean | null; co2Cap: string | null;
  stress: string; customStress: boolean; cost: number | null; costPerMwh: number | null; co2: number | null; clean: number | null; capacities: { id: string; label: string; mw: number }[];
}
export const listRuns = () => call<RunRow[]>("/api/runs");
export const getStress = () => call<StressMeta>("/api/stress");
export const compareRuns = (id: string) => call<CompareRow[]>(`/api/job/${id}/compare`);
/** Events read from an uploaded .csv / .xlsx (the server parses it). */
export async function parseStressFile(file: File) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return call<{ rows: (StressRow | CatalogRow)[]; problems: string[] }>("/api/stress/parse", { name: file.name, data: btoa(bin) });
}
