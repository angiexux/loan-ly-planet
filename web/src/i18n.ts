// Language choice (English / Español / Português) for the app shell. Remembered per browser.
import { useSyncExternalStore } from "react";

export type Lang = "en" | "es" | "pt";
export const LANGS: { id: Lang; short: string; name: string }[] = [
  { id: "en", short: "EN", name: "English" },
  { id: "es", short: "ES", name: "Español" },
  { id: "pt", short: "PT", name: "Português" },
];

const KEY = "loanly-lang";
let current: Lang = (() => { try { const v = localStorage.getItem(KEY); return v === "es" || v === "pt" ? v : "en"; } catch { return "en"; } })();
const subs = new Set<() => void>();
if (typeof document !== "undefined") document.documentElement.lang = current;

export function setLang(l: Lang) {
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* storage blocked: keep for this visit only */ }
  document.documentElement.lang = l;
  subs.forEach(f => f());
}
/** current language for non-component helpers (components must still subscribe via useLang()/useT() so they re-render) */
export const getLang = (): Lang => current;
/** run a helper as if another language were selected (used to obtain the English text of a rule) */
export function withLang<T>(l: Lang, f: () => T): T { const prev = current; current = l; try { return f(); } finally { current = prev; } }
export function useLang(): Lang {
  return useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => current);
}

const T = {
  "app.name": { en: "Climate credit monitor", es: "Monitor de crédito climático", pt: "Monitor de crédito climático" },
  "asof": { en: "Data as of", es: "Datos al", pt: "Dados em" },
  "nav.monitor": { en: "Monitor", es: "Monitoreo", pt: "Monitoramento" },
  "nav.workflow": { en: "Workflow", es: "Flujo de trabajo", pt: "Fluxo de trabalho" },
  "nav.about": { en: "About the model", es: "Sobre el modelo", pt: "Sobre o modelo" },
  "nav.credit": { en: "Credit risk", es: "Riesgo crediticio", pt: "Risco de crédito" },
  "nav.data": { en: "Data", es: "Datos", pt: "Dados" },
  "nav.ask": { en: "Ask about your portfolio", es: "Pregunte sobre su cartera", pt: "Pergunte sobre sua carteira" },
  "nav.portfolio": { en: "Portfolio overview", es: "Resumen de la cartera", pt: "Visão geral da carteira" },
  "nav.alerts": { en: "Alerts", es: "Alertas", pt: "Alertas" },
  "nav.loan": { en: "Climate analysis", es: "Análisis climático", pt: "Análise climática" },
  "nav.reports": { en: "IFRS 9 reports", es: "Reportes NIIF 9", pt: "Relatórios IFRS 9" },
  "nav.actions": { en: "Outputs", es: "Documentos", pt: "Documentos" },
  "nav.method": { en: "Methodology", es: "Metodología", pt: "Metodologia" },
  "acct.team": { en: "Credit risk team", es: "Equipo de riesgo crediticio", pt: "Equipe de risco de crédito" },
  "acct.signed": { en: "Signed in", es: "Sesión iniciada", pt: "Conectado" },
  "open": { en: "Open the monitor", es: "Abrir el monitor", pt: "Abrir o monitor" },
  "lang": { en: "Language", es: "Idioma", pt: "Idioma" },
} satisfies Record<string, Record<Lang, string>>;
export type TKey = keyof typeof T;

/** translate a shell string; falls back to English */
export function useT() {
  const l = useLang();
  return (k: TKey) => T[k][l] ?? T[k].en;
}

// ----------------------------------------------------------------------------------------------- typed dictionaries
// Each area (src/locales/*.ts) defines `const D = { key: { en, es, pt } } satisfies Dict`. A key that lacks a language is a tsc error;
// at run time a missing language falls back to English. Strings with numbers are functions: `{ en: (n: number) => `${n} loans`, ... }`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFn = (...a: any[]) => string;
export type Entry = Record<Lang, string> | Record<Lang, AnyFn>;
export type Dict = Record<string, Entry>;
type Args<E> = E extends { en: (...a: infer A) => string } ? A : [];
export type Tr<D extends Dict> = <K extends keyof D>(k: K, ...a: Args<D[K]>) => string;

export function translator<D extends Dict>(d: D, l: Lang): Tr<D> {
  return ((k: keyof D, ...a: unknown[]) => {
    const e = d[k] as Partial<Record<Lang, string | AnyFn>> & { en: string | AnyFn };
    const v = e[l] ?? e.en;
    return typeof v === "function" ? v(...a) : v;
  }) as Tr<D>;
}
/** hook factory: `export const useX = hookFor(D)`; inside a component `const x = useX(); x("key", args)` (re-renders on language change) */
export const hookFor = <D extends Dict>(d: D) => (): Tr<D> => translator(d, useLang());
/** translator bound to the language at call time, for helpers outside components */
export const staticFor = <D extends Dict>(d: D): Tr<D> => ((k: keyof D, ...a: unknown[]) => (translator(d, current) as (k: keyof D, ...a: unknown[]) => string)(k, ...a)) as Tr<D>;
/** pick by language at call time: `pick({ en: .., es: .., pt: .. })` */
export const pick = <T,>(o: Record<Lang, T>, l: Lang = current): T => o[l] ?? o.en;
