// Actions & outputs page (loan actions, IFRS 9 portfolio reports, action pipeline, output checklist).
import { hookFor } from "../i18n";
import type { Dict } from "../i18n";

const D = {
  "lede": { en: "One place for what to do and what to send. Pick a loan, review its recommended actions and the portfolio's IFRS 9 position, then choose which documents to download at the end.", es: "Un solo lugar para qué hacer y qué enviar. Elija un préstamo, revise sus acciones recomendadas y la posición NIIF 9 de la cartera, y al final elija qué documentos descargar.", pt: "Um só lugar para o que fazer e o que enviar. Escolha um empréstimo, revise as ações recomendadas e a posição IFRS 9 da carteira e, no fim, escolha quais documentos baixar." },
  "pick": { en: "Loan", es: "Préstamo", pt: "Empréstimo" },
  "prov": { en: "Province", es: "Provincia", pt: "Província" },
  "allProv": { en: "All provinces", es: "Todas las provincias", pt: "Todas as províncias" },
  "wholeBook": { en: "whole book", es: "toda la cartera", pt: "toda a carteira" },
  "pickSub": { en: "drives section 01 and the loan documents in section 04", es: "define la sección 01 y los documentos del préstamo en la sección 04", pt: "define a seção 01 e os documentos do empréstimo na seção 04" },
  "openClimate": { en: "Open its climate analysis", es: "Abrir su análisis climático", pt: "Abrir sua análise climática" },
  "s1": { en: "Loan actions", es: "Acciones del préstamo", pt: "Ações do empréstimo" },
  "s1Sub": { en: "what to do with the selected loan; recommended actions are outlined", es: "qué hacer con el préstamo elegido; las acciones recomendadas están resaltadas", pt: "o que fazer com o empréstimo escolhido; as ações recomendadas estão destacadas" },
  "s2": { en: "Portfolio IFRS 9 position", es: "Posición NIIF 9 de la cartera", pt: "Posição IFRS 9 da carteira" },
  "s2Sub": { en: "provisions (ECL), loss probability, LGD and stress test for the week shown", es: "provisiones (PCE), probabilidad de pérdida, LGD y prueba de estrés para la semana mostrada", pt: "provisões (PCE), probabilidade de perda, LGD e teste de estresse para a semana exibida" },
  "s3": { en: "Actions by loan", es: "Acciones por préstamo", pt: "Ações por empréstimo" },
  "s3Sub": { en: "which loans each action applies to; click a row to select that loan", es: "a qué préstamos aplica cada acción; haga clic en una fila para elegir ese préstamo", pt: "a quais empréstimos cada ação se aplica; clique em uma linha para escolher esse empréstimo" },
  "s4": { en: "Outputs", es: "Documentos", pt: "Documentos" },
  "s4Sub": { en: "tick the documents you need, then download them together", es: "marque los documentos que necesita y descárguelos juntos", pt: "marque os documentos de que precisa e baixe-os juntos" },
  "outLoan": { en: (id: string) => `Loan documents · ${id}`, es: (id: string) => `Documentos del préstamo · ${id}`, pt: (id: string) => `Documentos do empréstimo · ${id}` },
  "outPf": { en: "Portfolio reports", es: "Informes de cartera", pt: "Relatórios da carteira" },
  "recTag": { en: "recommended", es: "recomendado", pt: "recomendado" },
  "selRec": { en: "Select recommended", es: "Elegir recomendados", pt: "Escolher recomendados" },
  "selNone": { en: "Clear", es: "Limpiar", pt: "Limpar" },
  "dl": { en: (n: number) => n ? `Download ${n} selected` : "Select documents to download", es: (n: number) => n ? `Descargar ${n} seleccionados` : "Elija documentos para descargar", pt: (n: number) => n ? `Baixar ${n} selecionados` : "Escolha documentos para baixar" },
  "unavail": { en: "PDF service offline", es: "servicio de PDF no disponible", pt: "serviço de PDF indisponível" },
  "multi": { en: "Your browser may ask once to allow several downloads.", es: "Su navegador puede pedir una vez permiso para varias descargas.", pt: "Seu navegador pode pedir uma vez permissão para vários downloads." },
  "soil": { en: "Soil sensor report", es: "Informe de sensores de suelo", pt: "Relatório de sensores de solo" },
  "soilB": { en: "Probe readings at 10/30/60 cm, satellite vs sensor moisture, soil chemistry.", es: "Lecturas de sonda a 10/30/60 cm, humedad satélite vs sensor, química del suelo.", pt: "Leituras da sonda a 10/30/60 cm, umidade satélite vs sensor, química do solo." },
  "memo": { en: "Loan memo", es: "Memo del préstamo", pt: "Memorando do empréstimo" },
  "memoB": { en: "One page: terms, NDVI vs history, rain, perils, analogs, yield range, PD / stage / LGD / ECL.", es: "Una página: condiciones, NDVI vs historia, lluvia, riesgos, análogos, rango de rinde, PD / etapa / LGD / PCE.", pt: "Uma página: condições, NDVI vs histórico, chuva, riscos, análogos, faixa de produtividade, PD / estágio / LGD / PCE." },
  "upSub": { en: "add your own loan book", es: "agregue su propia cartera de préstamos", pt: "adicione sua própria carteira de empréstimos" },
} satisfies Dict;

export const useO = hookFor(D);
