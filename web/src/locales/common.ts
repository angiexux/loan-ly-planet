// Shared vocabulary: stress levels, perils, crop stages, collateral, units of text used on every page.
// Terminology: Spanish = Argentina/Uruguay/Paraguay banking (NIIF 9), Portuguese = Brazil banking (IFRS 9 / CPC 48).
import { getLang, hookFor, pick, staticFor } from "../i18n";
import type { Dict, Lang } from "../i18n";

const D = {
  // levels
  "level.Normal": { en: "Normal", es: "Normal", pt: "Normal" },
  "level.Watch": { en: "Watch", es: "Vigilancia", pt: "Atenção" },
  "level.High": { en: "High", es: "Alto", pt: "Alto" },
  "level.Severe": { en: "Severe", es: "Severo", pt: "Severo" },
  // perils
  "peril.drought": { en: "Drought", es: "Sequía", pt: "Seca" },
  "peril.excess_water": { en: "Excess water", es: "Exceso de agua", pt: "Excesso de água" },
  "peril.frost": { en: "Frost", es: "Helada", pt: "Geada" },
  "peril.heat": { en: "Heat", es: "Calor", pt: "Calor" },
  "peril.hail": { en: "Hail", es: "Granizo", pt: "Granizo" },
  "peril.mixed": { en: "mixed signals", es: "señales mixtas", pt: "sinais mistos" },
  // drought cascade
  "casc.none": { en: "No drought signal", es: "Sin señal de sequía", pt: "Sem sinal de seca" },
  "casc.early": { en: "Early: rain deficit only", es: "Temprana: solo déficit de lluvia", pt: "Inicial: apenas déficit de chuva" },
  "casc.active": { en: "Active: rain deficit and dry soil", es: "Activa: déficit de lluvia y suelo seco", pt: "Ativa: déficit de chuva e solo seco" },
  "casc.confirmed": { en: "Confirmed: rain, soil and vegetation all agree", es: "Confirmada: lluvia, suelo y vegetación coinciden", pt: "Confirmada: chuva, solo e vegetação concordam" },
  "cascStep.none": { en: "None", es: "Ninguna", pt: "Nenhuma" },
  "cascStep.early": { en: "Early", es: "Temprana", pt: "Inicial" },
  "cascStep.active": { en: "Active", es: "Activa", pt: "Ativa" },
  "cascStep.confirmed": { en: "Confirmed", es: "Confirmada", pt: "Confirmada" },
  // IFRS 9 stage reasons
  "sr.inactive": { en: "Not active this week (not yet disbursed, or already repaid)", es: "No activo esta semana (aún sin desembolsar o ya cancelado)", pt: "Inativo nesta semana (ainda não desembolsado ou já quitado)" },
  "sr.performing": { en: "Performing, no significant increase in credit risk", es: "Al día, sin aumento significativo del riesgo crediticio", pt: "Adimplente, sem aumento significativo do risco de crédito" },
  "sr.pd_2x_origination": { en: (s: number) => `PD is at least ${s}× its level at origination`, es: (s: number) => `La PD es al menos ${s}× su nivel al otorgamiento`, pt: (s: number) => `A PD é pelo menos ${s}× o nível da originação` },
  "sr.critical_alert": { en: "Critical climate alert (Severe stress)", es: "Alerta climática crítica (estrés Severo)", pt: "Alerta climático crítico (estresse Severo)" },
  "sr.dpd_30": { en: "30+ days past due", es: "30+ días de atraso", pt: "30+ dias de atraso" },
  "sr.dpd_90": { en: "More than 90 days past due or BCRA situación 3+", es: "Más de 90 días de atraso o situación BCRA 3+", pt: "Mais de 90 dias de atraso ou situação BCRA 3+" },
  // generic words
  "stage": { en: "Stage", es: "Etapa", pt: "Estágio" },
  "none": { en: "none", es: "ninguno", pt: "nenhum" },
  "na": { en: "n/a", es: "n/d", pt: "n/d" },
  "uploaded": { en: "uploaded", es: "cargado", pt: "carregado" },
  "loading": { en: "Loading…", es: "Cargando…", pt: "Carregando…" },
  "loanWord": { en: "Loan", es: "Préstamo", pt: "Empréstimo" },
  "loans": { en: (n: number) => `${n} loans`, es: (n: number) => `${n} préstamos`, pt: (n: number) => `${n} empréstimos` },
  "yes": { en: "Yes", es: "Sí", pt: "Sim" },
  "no": { en: "No", es: "No", pt: "Não" },
  "pdfDown": { en: "PDF documents are temporarily unavailable", es: "Los documentos PDF no están disponibles por el momento", pt: "Os documentos PDF estão temporariamente indisponíveis" },
  "pdfNote": { en: "PDF documents are temporarily unavailable.", es: "Los documentos PDF no están disponibles por el momento.", pt: "Os documentos PDF estão temporariamente indisponíveis." },
  "generatePdf": { en: "Generate PDF", es: "Generar PDF", pt: "Gerar PDF" },
  "confidence": { en: "Confidence", es: "Confianza", pt: "Confiança" },
  "menu": { en: "Menu", es: "Menú", pt: "Menu" },
  "tHa": { en: "t/ha", es: "t/ha", pt: "t/ha" },
  "ha": { en: "ha", es: "ha", pt: "ha" },
  "days": { en: (n: number) => `${n} day${n === 1 ? "" : "s"}`, es: (n: number) => `${n} día${n === 1 ? "" : "s"}`, pt: (n: number) => `${n} dia${n === 1 ? "" : "s"}` },
  "weeks": { en: (n: number) => `${n} weeks`, es: (n: number) => `${n} semanas`, pt: (n: number) => `${n} semanas` },
  "months": { en: (n: number) => `${n} months`, es: (n: number) => `${n} meses`, pt: (n: number) => `${n} meses` },
} satisfies Dict;

export const useC = hookFor(D);
export const C = staticFor(D);

// ---------------------------------------------------------------------------------------------- dates
const MONTHS: Record<Lang, string[]> = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  es: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
  pt: ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"],
};
export const monthName = (m: number) => pick(MONTHS)[m - 1];
export const weekOfWord = () => pick({ en: "week of", es: "semana del", pt: "semana de" });

// ---------------------------------------------------------------------------------------------- data vocabulary (fall back to the backend's own label)
const CROPS: Record<string, Record<Lang, string>> = {
  soy: { en: "Soybean", es: "Soja", pt: "Soja" }, maize: { en: "Maize", es: "Maíz", pt: "Milho" },
  wheat: { en: "Wheat", es: "Trigo", pt: "Trigo" }, sunflower: { en: "Sunflower", es: "Girasol", pt: "Girassol" },
};
export const cropLabel = (id: string, fallback: string) => (getLang() === "en" ? fallback : CROPS[id]?.[getLang()] ?? fallback);
const STAGES: Record<string, [string, string]> = {
  "Pre-sowing": ["Presiembra", "Pré-plantio"], Emergence: ["Emergencia", "Emergência"], Vegetative: ["Vegetativo", "Vegetativo"], Flowering: ["Floración", "Floração"],
  "Pod fill": ["Llenado de vainas", "Enchimento de vagens"], "Seed maturation": ["Maduración de la semilla", "Maturação da semente"], "Harvest-ready": ["Lista para cosecha", "Pronta para colheita"],
  Harvested: ["Cosechado", "Colhido"], Silking: ["Floración femenina", "Espigamento"], "Grain fill": ["Llenado de grano", "Enchimento de grãos"], "Dry-down": ["Secado", "Secagem"],
  Tillering: ["Macollaje", "Perfilhamento"], "Stem elongation": ["Elongación del tallo", "Alongamento do colmo"], "Heading & flowering": ["Espigazón y floración", "Espigamento e floração"],
  Ripening: ["Maduración", "Maturação"], "Seed fill": ["Llenado de semilla", "Enchimento de sementes"], Maturity: ["Madurez", "Maturidade"],
};
export const stageName = (n: string) => { const l = getLang(); return l === "en" ? n : STAGES[n]?.[l === "es" ? 0 : 1] ?? n; };
const COLL: Record<string, [string, string]> = {
  "crop pledge": ["prenda sobre cultivo", "penhor agrícola"], "land mortgage": ["hipoteca sobre la tierra", "hipoteca sobre a terra"], unsecured: ["sin garantía", "sem garantia"],
  "warrant on grain": ["warrant sobre granos", "warrant sobre grãos"], "machinery pledge": ["prenda sobre maquinaria", "penhor de máquinas"],
};
export const collateralName = (n: string) => { const l = getLang(); return l === "en" ? n : COLL[n]?.[l === "es" ? 0 : 1] ?? n; };
const INS: Record<string, [string, string]> = { indemnity: ["indemnizatorio", "indenizatório"], parametric: ["paramétrico", "paramétrico"], "multi-peril": ["multirriesgo", "multirrisco"] };
export const insuranceType = (n: string) => { const l = getLang(); return l === "en" ? n : INS[n]?.[l === "es" ? 0 : 1] ?? n; };
export const insuranceTrigger = (n: string) => {
  const l = getLang(); if (l === "en") return n;
  return n === "SPI-60 < -1.5 between flowering and grain fill" ? (l === "es" ? "SPI-60 < −1,5 entre floración y llenado de grano" : "SPI-60 < −1,5 entre floração e enchimento de grãos") : n;
};
export const productName = (n: string) => { const l = getLang(); if (l === "en") return n; return n === "Crop input loan" ? (l === "es" ? "Préstamo para insumos" : "Crédito de insumos") : n === "Pre-harvest loan" ? (l === "es" ? "Préstamo de precosecha" : "Crédito de pré-colheita") : n; };
export const countryName = (n: string) => { const l = getLang(); return l !== "en" && n === "Brazil" ? (l === "es" ? "Brasil" : "Brasil") : n; };
