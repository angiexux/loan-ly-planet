// Methodology & back-test page.
import { hookFor } from "../i18n";
import type { Dict } from "../i18n";

const D = {
  "tag": { en: "Methodology & back-test", es: "Metodología y back-test", pt: "Metodologia e back-test" },
  "h1": { en: "HOW THE SCORE ", es: "CÓMO SE CALCULA ", pt: "COMO O SCORE ", },
  "h2": { en: "IS MADE.", es: "EL PUNTAJE.", pt: "É CALCULADO." },
  "lede2": { en: "Satellite and weather data become a stress score, a yield outlook and IFRS 9 figures. Each field is compared with its own history for the same week, so what matters is the anomaly, not the raw index.", es: "Los datos satelitales y meteorológicos se convierten en un puntaje de estrés, una perspectiva de rendimiento y cifras NIIF 9. Cada campo se compara con su propia historia para la misma semana: importa la anomalía, no el índice crudo.", pt: "Dados de satélite e meteorológicos viram um score de estresse, uma perspectiva de produtividade e números IFRS 9. Cada talhão é comparado com o próprio histórico da mesma semana: importa a anomalia, não o índice bruto." },
  "cav.b": { en: "Basis.", es: "Base.", pt: "Base." },
  "cav.1": { en: " Provisions follow IFRS 9 (expected credit loss, stages 1–3). PD sensitivities can be calibrated to your own repayment history.", es: " Las provisiones siguen la NIIF 9 (pérdida crediticia esperada, etapas 1–3). Las sensibilidades de PD pueden calibrarse con su propio historial de pagos.", pt: " As provisões seguem a IFRS 9 (perda de crédito esperada, estágios 1–3). As sensibilidades de PD podem ser calibradas com o seu próprio histórico de pagamentos." },
  "m.fetch_earth_engine": { en: "1 · Data per field", es: "1 · Datos por campo", pt: "1 · Dados por talhão" },
  "m.crop_calendar": { en: "2 · Crop stage", es: "2 · Etapa del cultivo", pt: "2 · Estágio da cultura" },
  "m.anomalies": { en: "3 · Is this week normal?", es: "3 · ¿Es normal esta semana?", pt: "3 · Esta semana é normal?" },
  "m.stress": { en: "4 · What kind of stress", es: "4 · Qué tipo de estrés", pt: "4 · Que tipo de estresse" },
  "m.analogs": { en: "5 · Which past year does this look like", es: "5 · A qué campaña pasada se parece", pt: "5 · A que safra passada se parece" },
  "m.yield_impact": { en: "6 · Stress to yield loss", es: "6 · De estrés a pérdida de rendimiento", pt: "6 · Do estresse à perda de produtividade" },
  "m.ifrs9": { en: "7 · Credit risk and IFRS 9", es: "7 · Riesgo de crédito y NIIF 9", pt: "7 · Risco de crédito e IFRS 9" },
  "m.portfolio": { en: "8 · Portfolio risk", es: "8 · Riesgo de la cartera", pt: "8 · Risco da carteira" },
  "m.alerts": { en: "9 · Alerts, explanations, recommendations", es: "9 · Alertas, explicaciones, recomendaciones", pt: "9 · Alertas, explicações, recomendações" },
  "d.fetch_earth_engine": { en: "", es: "NDVI de Sentinel-2 enmascarado con las propias banderas de nubes del satélite, media zonal por campo, mediana semanal de las imágenes despejadas, relleno lineal de vacíos, suavizado de Savitzky-Golay; lluvia de CHIRPS, temperatura de ERA5-Land, humedad del suelo de SMAP, agua de Sentinel-1.", pt: "NDVI do Sentinel-2 mascarado com as próprias flags de nuvem do satélite, média zonal por talhão, mediana semanal das imagens limpas, preenchimento linear de lacunas, suavização de Savitzky-Golay; chuva do CHIRPS, temperatura do ERA5-Land, umidade do solo do SMAP, água do Sentinel-1." },
  "d.crop_calendar": { en: "", es: "Etapa según los días desde la siembra con duraciones de etapa propias de cada cultivo; si no se conoce la siembra, fenología: reverdecimiento al 20% del rango estacional de NDVI, retrotraído por el tiempo típico de emergencia. Cada etapa tiene un peso (floración = 1,0).", pt: "Estágio a partir dos dias desde o plantio, com durações de estágio próprias de cada cultura; se o plantio é desconhecido, fenologia: reverdecimento a 20% da amplitude sazonal do NDVI, retroagido pelo tempo típico de emergência. Cada estágio tem um peso (floração = 1,0)." },
  "d.anomalies": { en: "", es: "Climatología semanal por campo sobre 21 campañas (media, desvío, p10, p90); puntaje z y rango percentil; SPI-30/60/90 con ajuste gamma y probabilidad de lluvia cero; percentil de humedad del suelo.", pt: "Climatologia semanal por talhão em 21 safras (média, desvio, p10, p90); escore z e posição percentil; SPI-30/60/90 com ajuste gama e probabilidade de chuva zero; percentil de umidade do solo." },
  "d.stress": { en: "", es: "Peligros basados en reglas (cascada de sequía, exceso de agua, helada, calor, granizo); el calor durante una sequía activa es la forma cálida y seca de esa sequía (calor × 1,3, atribuido a la sequía); los peligros se combinan como fracciones de daño independientes (1 − producto de (1 − peso × intensidad)), sin sumar más allá de la escala; intensidad × peso de la etapa acumulada con decaimiento exponencial (semivida de 4 semanas) en un puntaje de 1 a 99 (techo suave por encima de 75, nunca exactamente 0 ni 100); niveles por bandas fijas de puntaje (Vigilancia 25–44, Alto 45–69, Severo 70–99); confianza = coincidencia de indicadores × calidad de ubicación × proporción de imágenes sin nubes.", pt: "Perigos baseados em regras (cascata da seca, excesso de água, geada, calor, granizo); o calor durante uma seca ativa é a forma quente e seca dessa seca (calor × 1,3, atribuído à seca); os perigos se combinam como frações de dano independentes (1 − produto de (1 − peso × intensidade)), sem somar além da escala; intensidade × peso do estágio acumulada com decaimento exponencial (meia-vida de 4 semanas) em um score de 1 a 99 (teto suave acima de 75, nunca exatamente 0 nem 100); níveis por faixas fixas de score (Atenção 25–44, Alto 45–69, Severo 70–99); confiança = concordância dos indicadores × qualidade da localização × proporção de imagens sem nuvens." },
  "d.analogs": { en: "", es: "Distancia euclidiana entre la serie de anomalías de esta campaña a la fecha (z de NDVI, SPI-60, percentil de suelo) y cada campaña histórica en las mismas semanas; las 3 campañas más cercanas y sus anomalías de rendimiento.", pt: "Distância euclidiana entre a série de anomalias desta safra até hoje (z do NDVI, SPI-60, percentil do solo) e cada safra histórica nas mesmas semanas; as 3 safras mais próximas e suas anomalias de produtividade." },
  "d.yield_impact": { en: "", es: "Por región × cultivo: MCO (p50) y regresión cuantílica (p10, p90) de la anomalía de rendimiento departamental sobre indicadores de estrés de la campaña; validación dejando un año afuera; predicción semanal con los indicadores disponibles a la fecha, más amplia antes de la siembra.", pt: "Por região × cultura: MQO (p50) e regressão quantílica (p10, p90) da anomalia de produtividade departamental sobre indicadores de estresse da safra; validação deixando um ano de fora; previsão semanal com os indicadores disponíveis até a data, mais ampla antes do plantio." },
  "d.ifrs9": { en: "", es: "logit(PD) = logit(PD_otorg.) + beta × pérdida de rendimiento; Etapa 2 ante una alerta crítica o PD ≥ 2× la del otorgamiento, Etapa 3 con situación BCRA ≥ 3 o más de 90 días de atraso; LGD × (1 − proporción cubierta por el seguro) con ajuste por garantía; EAD según el cronograma de amortización; PCE = suma de PD marginal × LGD × EAD × FD mensual (12 meses en Etapa 1, toda la vida en Etapas 2/3; en préstamos agrícolas cortos de Etapa 2 se suma un año de plazo supuesto de reestructuración); escenarios base/adverso/severo 60/25/15.", pt: "logit(PD) = logit(PD_orig.) + beta × perda de produtividade; Estágio 2 diante de alerta crítico ou PD ≥ 2× a da originação, Estágio 3 com situação BCRA ≥ 3 ou mais de 90 dias de atraso; LGD × (1 − parcela coberta pelo seguro) com ajuste de garantia; EAD a partir do cronograma de amortização; PCE = soma de PD marginal × LGD × EAD × FD mensal (12 meses no Estágio 1, ao longo da vida nos Estágios 2/3; em créditos rurais curtos do Estágio 2 soma-se um ano de prazo suposto de reestruturação); cenários base/adverso/severo 60/25/15." },
  "d.portfolio": { en: "", es: "Totales semanales por nivel y etapa; conglomerados DBSCAN (haversine, 60 km, mín. 3) de préstamos Alto/Severo; concentración por región y cultivo; prueba de estrés por simulación histórica de la cartera de hoy a través de las 21 campañas (p95 = pérdida de 1 en 20 años).", pt: "Totais semanais por nível e estágio; agrupamentos DBSCAN (haversine, 60 km, mín. 3) de empréstimos Alto/Severo; concentração por região e cultura; teste de estresse por simulação histórica da carteira de hoje nas 21 safras (p95 = perda de 1 em 20 anos)." },
  "d.alerts": { en: "", es: "Alertas a partir de los cambios de nivel (bandas fijas de puntaje); explicaciones por plantilla con números calculados; recomendaciones según una tabla de reglas.", pt: "Alertas a partir das mudanças de nível (faixas fixas de score); explicações por modelo com números calculados; recomendações segundo uma tabela de regras." },
  "fold": { en: "How the score is made: the 9 modules and the IFRS 9 formulas", es: "Cómo se calcula el puntaje: los 9 módulos y las fórmulas NIIF 9", pt: "Como o score é calculado: os 9 módulos e as fórmulas IFRS 9" },
  "formula.tag": { en: "IFRS 9 formulas", es: "Fórmulas NIIF 9", pt: "Fórmulas IFRS 9" },
  "formula": {
    en: (beta: number, sicr: number, dr: string, ext: number, sc: string, hu: number[], _hd: string) => `logit(PD) = logit(PD_origination) + β × yield loss          β = ${beta}
Stage 2   if critical alert (Severe) or PD ≥ ${sicr}× its origination level
Stage 3   if BCRA situación ≥ 3 or > 90 days past due   (PD ≈ 100%)
LGD       = LGD_bank × (1 − insurance cover share), collateral-adjusted
EAD       = outstanding balance from the amortization schedule
ECL       = Σ_t marginal PD_t × LGD × EAD_t × DF_t      discount rate ${dr}
            12 months (Stage 1) · lifetime (Stage 2/3), +${ext} months on short crop loans in Stage 2
ECL_w     = ${sc}
Levels    Normal < ${hu[0]} ≤ Watch < ${hu[1]} ≤ High < ${hu[2]} ≤ Severe   (score bands 1–24 / 25–44 / 45–69 / 70–99)`,
    es: (beta: number, sicr: number, dr: string, ext: number, sc: string, hu: number[], _hd: string) => `logit(PD) = logit(PD_otorgamiento) + β × pérdida de rendimiento          β = ${beta}
Etapa 2   si alerta crítica (Severo) o PD ≥ ${sicr}× su nivel al otorgamiento
Etapa 3   si situación BCRA ≥ 3 o > 90 días de atraso   (PD ≈ 100%)
LGD       = LGD_banco × (1 − proporción cubierta por el seguro), ajustada por garantía
EAD       = saldo según el cronograma de amortización
PCE       = Σ_t PD marginal_t × LGD × EAD_t × FD_t      tasa de descuento ${dr}
            12 meses (Etapa 1) · toda la vida (Etapas 2/3), +${ext} meses en préstamos agrícolas cortos en Etapa 2
PCE_p     = ${sc}
Niveles   Normal < ${hu[0]} ≤ Vigilancia < ${hu[1]} ≤ Alto < ${hu[2]} ≤ Severo   (bandas 1–24 / 25–44 / 45–69 / 70–99)`,
    pt: (beta: number, sicr: number, dr: string, ext: number, sc: string, hu: number[], _hd: string) => `logit(PD) = logit(PD_originação) + β × perda de produtividade          β = ${beta}
Estágio 2 se alerta crítico (Severo) ou PD ≥ ${sicr}× o nível da originação
Estágio 3 se situação BCRA ≥ 3 ou > 90 dias de atraso   (PD ≈ 100%)
LGD       = LGD_banco × (1 − parcela coberta pelo seguro), ajustada por garantia
EAD       = saldo conforme o cronograma de amortização
PCE       = Σ_t PD marginal_t × LGD × EAD_t × FD_t      taxa de desconto ${dr}
            12 meses (Estágio 1) · ao longo da vida (Estágios 2/3), +${ext} meses em créditos rurais curtos no Estágio 2
PCE_p     = ${sc}
Níveis    Normal < ${hu[0]} ≤ Atenção < ${hu[1]} ≤ Alto < ${hu[2]} ≤ Severo   (faixas 1–24 / 25–44 / 45–69 / 70–99)` },
  "formulaScen": { en: (a: string, b: string, c: string) => `${a} base + ${b} adverse + ${c} severe`, es: (a: string, b: string, c: string) => `${a} base + ${b} adverso + ${c} severo`, pt: (a: string, b: string, c: string) => `${a} base + ${b} adverso + ${c} severo` },
  "formula.note": { en: "Base PD for agriculture comes from BCRA sector statistics. Argentina: BCRA Com. \"A\" 6847 (IFRS 9 impairment from 2020); debtor classification situación 1–6 sets Stage 3.", es: "La PD base del sector agropecuario proviene de las estadísticas sectoriales del BCRA. Argentina: Com. \"A\" 6847 del BCRA (deterioro NIIF 9 desde 2020); la clasificación de deudores en situación 1–6 determina la Etapa 3.", pt: "A PD base para a agropecuária vem das estatísticas setoriais do BCRA. Argentina: Com. \"A\" 6847 do BCRA (impairment IFRS 9 desde 2020); a classificação de devedores em situação 1–6 define o Estágio 3." },
  "val.tag": { en: "Validation · yield model", es: "Validación · modelo de rendimiento", pt: "Validação · modelo de produtividade" },
  "val.p": { en: "Per region and crop: OLS (p50) with quantile regression (p10, p90) of department yield anomaly on season stress indicators; scored leave-one-year-out (LOYO).", es: "Por región y cultivo: MCO (p50) con regresión cuantílica (p10, p90) de la anomalía de rendimiento departamental sobre indicadores de estrés de la campaña; evaluado dejando un año afuera (LOYO).", pt: "Por região e cultura: MQO (p50) com regressão quantílica (p10, p90) da anomalia de produtividade departamental sobre indicadores de estresse da safra; avaliado deixando um ano de fora (LOYO)." },
  "val.region": { en: "Region", es: "Región", pt: "Região" },
  "val.crop": { en: "Crop", es: "Cultivo", pt: "Cultura" },
  "val.n": { en: "Seasons n", es: "Campañas n", pt: "Safras n" },
  "val.r2": { en: "LOYO R²", es: "R² LOYO", pt: "R² LOYO" },
  "val.mae": { en: "LOYO MAE", es: "MAE LOYO", pt: "MAE LOYO" },
  "val.method": { en: "Method", es: "Método", pt: "Método" },
  "val.on": { en: "on", es: "sobre", pt: "sobre" },
  "val.pooled": { en: (c: string, r2: string, rest: string) => `pooled ${c} model (all regions; own-region LOYO R2 ${r2} too low): ${rest}`, es: (c: string, r2: string, rest: string) => `modelo agrupado de ${c} (todas las regiones; R² LOYO propio de la región ${r2}, demasiado bajo): ${rest}`, pt: (c: string, r2: string, rest: string) => `modelo agrupado de ${c} (todas as regiões; R² LOYO da própria região ${r2}, baixo demais): ${rest}` },
  "val.loyo": { en: "leave-one-year-out", es: "dejando un año afuera", pt: "deixando um ano de fora" },
  "bt.tag": { en: "Back-test", es: "Back-test", pt: "Back-test" },
  "bt.p": { en: "Would the monitor have flagged the loans that later defaulted? Loans scored High or Severe at each week vs the rest; AUC of the score against realised default.", es: "¿Habría marcado el monitor los préstamos que luego cayeron en incumplimiento? Préstamos con puntaje Alto o Severo en cada semana vs el resto; AUC del puntaje frente al incumplimiento realizado.", pt: "O monitor teria sinalizado os empréstimos que depois entraram em inadimplência? Empréstimos com score Alto ou Severo em cada semana vs os demais; AUC do score frente à inadimplência realizada." },
  "bt.flaggedRate": { en: "Default rate, flagged", es: "Tasa de incumplimiento, marcados", pt: "Taxa de inadimplência, sinalizados" },
  "bt.otherRate": { en: "Default rate, others", es: "Tasa de incumplimiento, resto", pt: "Taxa de inadimplência, demais" },
  "bt.marker": { en: "default week", es: "semana de incumplimiento", pt: "semana de inadimplência" },
  "bt.asOf": { en: "As of", es: "Al", pt: "Em" },
  "bt.flagged": { en: "Flagged", es: "Marcados", pt: "Sinalizados" },
  "src.tag": { en: "Data sources", es: "Fuentes de datos", pt: "Fontes de dados" },
  "src.signal": { en: "Signal", es: "Señal", pt: "Sinal" },
  "src.source": { en: "Source", es: "Fuente", pt: "Fonte" },
  "src.access": { en: "Access", es: "Acceso", pt: "Acesso" },
  "src.used": { en: "Used for", es: "Se usa para", pt: "Usado para" },
  "src.0": { en: "Vegetation (NDVI)", es: "Vegetación (NDVI)", pt: "Vegetação (NDVI)" },
  "src.0s": { en: "Sentinel-2 L2A (10 m, cloud-masked with the SCL flags); MODIS MOD13Q1 for the long baseline", es: "Sentinel-2 L2A (10 m, enmascarado de nubes con las banderas SCL); MODIS MOD13Q1 para la línea de base larga", pt: "Sentinel-2 L2A (10 m, máscara de nuvens com as flags SCL); MODIS MOD13Q1 para a linha de base longa" },
  "src.0a": { en: "Google Earth Engine", es: "Google Earth Engine", pt: "Google Earth Engine" },
  "src.0u": { en: "Crop condition vs the field's own history", es: "Estado del cultivo vs la historia propia del campo", pt: "Condição da cultura vs o histórico do próprio talhão" },
  "src.1": { en: "Rainfall", es: "Lluvia", pt: "Chuva" },
  "src.1s": { en: "CHIRPS daily, 5 km, 1981–", es: "CHIRPS diario, 5 km, 1981–", pt: "CHIRPS diário, 5 km, 1981–" },
  "src.1a": { en: "Earth Engine", es: "Earth Engine", pt: "Earth Engine" },
  "src.1u": { en: "SPI-30/60/90 (gamma fit)", es: "SPI-30/60/90 (ajuste gamma)", pt: "SPI-30/60/90 (ajuste gama)" },
  "src.2": { en: "Temperature, frost", es: "Temperatura, heladas", pt: "Temperatura, geada" },
  "src.2s": { en: "ERA5-Land hourly, 9 km, 1950–", es: "ERA5-Land horario, 9 km, 1950–", pt: "ERA5-Land horário, 9 km, 1950–" },
  "src.2a": { en: "Earth Engine / Copernicus CDS", es: "Earth Engine / Copernicus CDS", pt: "Earth Engine / Copernicus CDS" },
  "src.2u": { en: "Weekly minimum, days above 35 °C", es: "Mínima semanal, días por encima de 35 °C", pt: "Mínima semanal, dias acima de 35 °C" },
  "src.3": { en: "Soil moisture", es: "Humedad del suelo", pt: "Umidade do solo" },
  "src.3s": { en: "SMAP L3/L4, 9 km; ERA5-Land as fallback", es: "SMAP L3/L4, 9 km; ERA5-Land como respaldo", pt: "SMAP L3/L4, 9 km; ERA5-Land como alternativa" },
  "src.3a": { en: "Earth Engine", es: "Earth Engine", pt: "Earth Engine" },
  "src.3u": { en: "Percentile vs history", es: "Percentil vs historia", pt: "Percentil vs histórico" },
  "src.4": { en: "Flooding", es: "Inundación", pt: "Inundação" },
  "src.4s": { en: "Sentinel-1 GRD (radar sees through cloud)", es: "Sentinel-1 GRD (el radar atraviesa las nubes)", pt: "Sentinel-1 GRD (o radar enxerga através das nuvens)" },
  "src.4a": { en: "Earth Engine", es: "Earth Engine", pt: "Earth Engine" },
  "src.4u": { en: "Flooded share of the field", es: "Proporción inundada del campo", pt: "Fração inundada do talhão" },
  "src.5": { en: "Yields", es: "Rendimientos", pt: "Produtividades" },
  "src.5s": { en: "National statistics (MAGyP, CONAB/IBGE, MGAP) at department level", es: "Estadísticas nacionales (MAGyP, CONAB/IBGE, MGAP) a nivel de departamento", pt: "Estatísticas nacionais (MAGyP, CONAB/IBGE, MGAP) em nível de departamento" },
  "src.5a": { en: "Public downloads", es: "Descargas públicas", pt: "Downloads públicos" },
  "src.5u": { en: "Fitting stress to yield loss", es: "Ajustar el estrés a la pérdida de rendimiento", pt: "Ajustar o estresse à perda de produtividade" },
  "src.6": { en: "Loan book", es: "Cartera de préstamos", pt: "Carteira de empréstimos" },
  "src.6s": { en: "Bank's own workbook: fields, loans, repayments, insurance, credit history", es: "Libro propio del banco: campos, préstamos, pagos, seguros, historial crediticio", pt: "Planilha do próprio banco: talhões, empréstimos, pagamentos, seguros, histórico de crédito" },
  "src.6a": { en: "Excel / CSV upload", es: "Carga de Excel / CSV", pt: "Upload de Excel / CSV" },
  "src.6u": { en: "Exposure, IFRS 9 baseline, BCRA situación", es: "Exposición, base NIIF 9, situación BCRA", pt: "Exposição, base IFRS 9, situação BCRA" },
} satisfies Dict;

export const useM = hookFor(D);
export const methodDesc = (k: string, backendText: string, t: ReturnType<typeof useM>) => (`d.${k}` in D && t(`d.${k}` as "d.stress") ? t(`d.${k}` as "d.stress") : backendText);
