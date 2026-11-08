// Landing page, Methodology section: why we add in-field soil sensors (the business case) and the sensor-story animation
// (exported from Claude Design, served as a standalone page from public/anim/sensor-story.html).
import { pick, useLang } from "./i18n";

const D = {
  tag: { en: "Why soil sensors", es: "Por qué sensores de suelo", pt: "Por que sensores de solo" },
  h1: { en: "SENSORS THAT ", es: "SENSORES QUE ", pt: "SENSORES QUE " },
  h2: { en: "PAY FOR THEMSELVES.", es: "SE PAGAN SOLOS.", pt: "SE PAGAM SOZINHOS." },
  lede: {
    en: "Satellites see the field from above; a probe in the soil sees what the roots see. That closes the information gap between the farmer and whoever carries the risk, and the people carrying the risk have a reason to pay for it.",
    es: "Los satélites ven el campo desde arriba; una sonda en el suelo ve lo que ven las raíces. Eso cierra la brecha de información entre el productor y quien asume el riesgo, y quien asume el riesgo tiene motivos para pagarla.",
    pt: "Os satélites veem o talhão de cima; uma sonda no solo vê o que as raízes veem. Isso fecha a lacuna de informação entre o produtor e quem carrega o risco, e quem carrega o risco tem motivos para pagar por ela.",
  },
  pay: {
    en: "Insurers are incentivised to close the information asymmetry, because better field data lets them price the risk into the premium. Banks can do the same through the interest rate. Either way, the sensor capex is partly offset by the financial product.",
    es: "Las aseguradoras tienen incentivos para cerrar la asimetría de información, porque mejores datos de campo les permiten reflejar el riesgo en la prima. Los bancos pueden hacer lo mismo a través de la tasa de interés. En ambos casos, la inversión en sensores se compensa en parte con el producto financiero.",
    pt: "As seguradoras têm incentivo para fechar a assimetria de informação, porque dados de campo melhores permitem refletir o risco no prêmio. Os bancos podem fazer o mesmo pela taxa de juros. De qualquer forma, o capex dos sensores é compensado em parte pelo produto financeiro.",
  },
  c1h: { en: "Farmers", es: "Productores", pt: "Produtores" },
  c1b: {
    en: "Better data on their own soil, and early alerts when moisture, heat or frost put the crop at risk.",
    es: "Mejores datos sobre su propio suelo y alertas tempranas cuando la humedad, el calor o la helada ponen en riesgo el cultivo.",
    pt: "Dados melhores sobre o próprio solo e alertas antecipados quando umidade, calor ou geada colocam a lavoura em risco.",
  },
  c2h: { en: "Banks and insurers", es: "Bancos y aseguradoras", pt: "Bancos e seguradoras" },
  c2b: {
    en: "The same readings, earlier: sharper PD and staging, faster claims, and less guesswork on the field they are financing or covering.",
    es: "Las mismas lecturas, antes: PD y etapas más precisas, siniestros más rápidos y menos conjeturas sobre el campo que financian o aseguran.",
    pt: "As mesmas leituras, mais cedo: PD e estágios mais precisos, sinistros mais rápidos e menos suposições sobre o talhão que financiam ou seguram.",
  },
  c3h: { en: "The financial instrument", es: "El instrumento financiero", pt: "O instrumento financeiro" },
  c3b: {
    en: "A lower premium or a lower rate for sensor-monitored fields funds the hardware, so the data layer finances itself.",
    es: "Una prima o una tasa más baja para campos monitoreados con sensores financia el equipo, así la capa de datos se autofinancia.",
    pt: "Um prêmio ou uma taxa menor para talhões monitorados por sensores financia o equipamento, então a camada de dados se autofinancia.",
  },
  anim: { en: "One season in the soil: sensor readings, alerts and the effect on the loan", es: "Una campaña en el suelo: lecturas de sensores, alertas y el efecto en el préstamo", pt: "Uma safra no solo: leituras dos sensores, alertas e o efeito no empréstimo" },
} as const;

export default function SensorStory() {
  const lang = useLang(), t = (k: keyof typeof D) => pick(D[k], lang);
  return <div className="sstory">
    <span className="tag accent">{t("tag")}</span>
    <h2 className="display sstory-h">{t("h1")}<em>{t("h2")}</em></h2>
    <p className="lede">{t("lede")}</p>
    <p className="sstory-pay">{t("pay")}</p>
    <div className="sstory-cards">
      {([["01", "c1h", "c1b"], ["02", "c2h", "c2b"], ["03", "c3h", "c3b"]] as const).map(([n, h, b]) =>
        <article key={n} className="card sstory-card"><span className="mono">{n}</span><h3>{t(h)}</h3><p className="muted">{t(b)}</p></article>)}
    </div>
    <figure className="card sstory-anim">
      <iframe src="/anim/sensor-story.html" title={t("anim")} loading="lazy" />
      <figcaption className="muted small">{t("anim")}</figcaption>
    </figure>
  </div>;
}
