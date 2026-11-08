// Alert pop-ups with banker responses.
import { hookFor } from "../i18n";
import type { Dict } from "../i18n";

const D = {
  "chip": { en: (n: number) => `${n} alert${n === 1 ? "" : "s"}`, es: (n: number) => `${n} alerta${n === 1 ? "" : "s"}`, pt: (n: number) => `${n} alerta${n === 1 ? "" : "s"}` },
  "collapse": { en: "collapse", es: "ocultar", pt: "ocultar" },
  "pill": { en: (n: number) => `Alerts (${n})`, es: (n: number) => `Alertas (${n})`, pt: (n: number) => `Alertas (${n})` },
  "open": { en: "Open loan", es: "Abrir préstamo", pt: "Abrir empréstimo" },
  "respond": { en: "Respond", es: "Responder", pt: "Responder" },
  "dismiss": { en: "Dismiss", es: "Cerrar", pt: "Fechar" },
  "notes": { en: "Notes", es: "Notas", pt: "Notas" },
  "none": { en: "No notes yet.", es: "Aún no hay notas.", pt: "Ainda não há notas." },
  "name": { en: "Your name", es: "Su nombre", pt: "Seu nome" },
  "response": { en: "Response", es: "Respuesta", pt: "Resposta" },
  "plan": { en: "Action plan", es: "Plan de acción", pt: "Plano de ação" },
  "planPh": { en: "Call borrower by Friday; request insurance certificate; review in 2 weeks", es: "Llamar al prestatario el viernes; pedir certificado de seguro; revisar en 2 semanas", pt: "Ligar ao tomador até sexta; pedir certificado de seguro; revisar em 2 semanas" },
  "status": { en: "Status", es: "Estado", pt: "Status" },
  "open_": { en: "Open", es: "Abierto", pt: "Aberto" },
  "in_progress": { en: "In progress", es: "En curso", pt: "Em andamento" },
  "done": { en: "Done", es: "Hecho", pt: "Concluído" },
  "save": { en: "Save", es: "Guardar", pt: "Salvar" },
  "empty": { en: "Write a response or an action plan.", es: "Escriba una respuesta o un plan de acción.", pt: "Escreva uma resposta ou um plano de ação." },
  "local": { en: "Saved in this browser only (server offline).", es: "Guardado solo en este navegador (servidor sin conexión).", pt: "Salvo apenas neste navegador (servidor offline)." },
  "wk": { en: "week", es: "semana", pt: "semana" },
} satisfies Dict;
export const useAl = hookFor(D);
