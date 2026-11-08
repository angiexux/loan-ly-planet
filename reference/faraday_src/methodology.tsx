// Methodology (/info): how the two models behind the agents work, in plain language, with the formulas and the Excel files.
import type { ReactNode } from "react";

const FILES: [string, string, string][] = [
  ["/methodology/Powerllel_Financial_Model.xlsx", "Financial model workbook", "The financial agent's method with live formulas: 56,406 portfolios, your template, weights and limits, the 0–100 score and the pick. Change a weight and Excel re-ranks."],
  ["/methodology/developer_input_template.xlsx", "Developer input template", "The Faraday template a developer fills from their own project plan: schedule, land, load tiers, remote site, nuclear offer, load ramp and grid steps. Reference values are the current packet's (v6.0.1)."],
  ["/methodology/example_filled_template.xlsx", "Example filled template", "The same template filled with an example project, to show the format."],
];

function F({ children, words }: { children: ReactNode; words?: ReactNode }) {
  return <div className="mt-formula"><code>{children}</code>{words && <p>{words}</p>}</div>;
}

/** embedded: the website's Overview page shows it as one section (under "Our solution"); otherwise the full /info page. */
export function Methodology({ embedded = false }: { embedded?: boolean }) {
  const Sec = ({ id, title, n, children }: { id: string; title: string; n: string; children: ReactNode }) => embedded
    ? <div className="mt-sub" id={id}><h3 className="display mt-h">{title}</h3>{children}</div>
    : <section className="section" id={id}><div className="section-head"><span>{title}</span><span>{n}</span></div>{children}</section>;
  return <div className={embedded ? "mt-page mt-embedded" : "model-page mt-page"}>
    {!embedded && <section className="section model-hero gt-hero">
      <span className="tag orange">METHODOLOGY</span>
      <h1 className="display">HOW THE AGENTS <em>DECIDE.</em></h1>
      <p className="lede dark">Two models answer every thesis. The optimisation agent designs a portfolio from scratch for your exact inputs; the financial agent picks the best one from a large set scored in advance. Here is what each does, the formulas behind them, and the files to check them yourself.</p>
      <div className="gt-row mt-jump">{[["mt-compare", "The two models"], ["mt-optimisation", "1 · Optimisation model"], ["mt-financial", "2 · Financial model"], ["mt-files", "Excel files"], ["mt-data", "Data versions"]].map(([id, t]) => <button key={id} className="outline dark-outline small" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })}>{t}</button>)}</div>
    </section>}

    <Sec id="mt-compare" title="The two models" n="00">
      <div className="card table-card"><div className="table-scroll"><table className="year-table mt-table"><thead><tr><th /><th>Optimisation agent</th><th>Financial agent</th></tr></thead><tbody>
        {[["Idea", "Build the cheapest portfolio that meets every rule, for these inputs", "Pick the best-scoring portfolio from a pool scored in advance"],
          ["How", "Mixed-integer optimisation (sizing), then an hourly linear program (dispatch)", "Filter by your limits, score by your weights (the Excel method)"],
          ["Inputs it can change", "Everything: campus size, dates, grid schedule and slips, reliability, carbon, prices, resources, stress events, staging", "Limits (opening month, emissions, cost premium) and weights; Tier 2 on or off"],
          ["Speed", "1–5 minutes per scenario", "Under a second"],
          ["Strength", "Exact for the question asked; can answer any what-if", "Shows the whole trade-off space: cheapest, fastest, cleanest, price sensitivity"],
          ["Limit", "One scenario per run, so date searches need several runs", "Only as good as the portfolios in its pool; built on the packet case (v6.0.1)"]].map(([a, b, c]) => <tr key={a}><td><b>{a}</b></td><td className="note">{b}</td><td className="note">{c}</td></tr>)}
      </tbody></table></div></div>
    </Sec>

    <Sec id="mt-optimisation" title="1 · Optimisation model" n="01">
      <p className="section-sub">The Powerllel optimiser (the GRIDTECH notebook's model). It answers one question: <b>which resources should the campus buy or build, and how should it run them every hour for ten years, so the lights stay on at the lowest total cost?</b></p>
      <div className="mt-flow">{[["0", "Can it be done?", "A quick check of the reliability rules alone. If no mix can meet them, it stops and says which rule fails."],
        ["1", "Size it", "Choose how many blocks of each resource to build (whole numbers), on representative days: 4 per month plus every stress hour, about 10,000 hours."],
        ["2", "Run it", "With the sizes fixed, operate every one of the 87,600 hours at least cost."],
        ["3", "Score it", "Add up cost, emissions and clean share with the packet's accounting, and check every hour balances."]].map(([n, t, d]) => <div key={n} className="mt-flow-step"><span>{n}</span><b>{t}</b><p>{d}</p></div>)}</div>

      <div className="mt-two">
        <div className="card"><h3 className="chart-h">What it minimises</h3>
          <F words="Everything the campus pays over ten years, in 2023 dollars, not discounted (the packet's screening cost).">total cost = capacity charges + contract payments + grid purchases + fuel and running costs + relocation + interruption</F>
          <F words="Building onsite equipment becomes an equal yearly charge, paid only while it is in service. r = 8% real, n = the asset's life.">capacity charge per year = MW × (CAPEX × CRF + fixed O&M)<br />CRF = r(1+r)ⁿ ÷ ((1+r)ⁿ − 1)</F>
          <F words="Solar, wind and nuclear are paid on everything they could generate, used or not, so their energy is free to use once signed.">contract payment = price $/MWh × MW × availability, every hour</F>
          <F words="Gas units pay for fuel and running costs only when they run.">fuel cost = MWh × (heat rate × gas price + variable O&M)</F>
          <F words="In a stress event, Tier 1 work can move to the remote site; Tier 2 work can be paused. Both cost money.">relocation = MWh moved × $123.50 · interruption = MWh paused × $1,000</F></div>
        <div className="card"><h3 className="chart-h">The rules it must meet <small>every hour</small></h3>
          <F words="Supply meets demand, after anything relocated or paused.">grid + contracts + gas + battery out − battery in = demand − relocated − interrupted</F>
          <F words="Offsite contracts arrive over the same wire as grid power. In the 32 stress hours a year the limit drops to 60%.">grid + contracts ≤ import limit (× 60% in a stress hour)</F>
          <F words="Sun and wind set how much a contract can deliver each hour.">output ≤ MW built × availability that hour</F>
          <F words="A 4-hour battery: it stores at most four hours of its power, loses some energy in the round trip, and cycles at most 365 times a year.">stored energy ≤ 4 × battery MW · stored next hour = stored + in × efficiency − out</F>
          <F words="Gas units and batteries need room; the campus has 8 usable acres.">Σ acres per MW × MW ≤ 8 acres</F>
          <F words="Optional: your emissions limit, enforced on the full ten-year result.">10-year CO₂ ÷ MWh served ≤ your limit</F>
          <F words="Tier 0 is never relocated or paused. With “no Tier 2 interruption”, the pause limit is set to zero.">Tier 0 always served locally · relocated ≤ remote site · interrupted ≤ Tier 2 share</F></div>
      </div>

      <div className="mt-two">
        <div className="card table-card"><h3 className="chart-h">Reliability standards <small>why gas gets built: only onsite gas counts as firm</small></h3>
          <div className="table-scroll"><table className="year-table"><tbody>{[["R0", "Gas covers whatever the grid and demand flexibility can't, in every hour (the packet's common rules)"], ["R1", "R0 with the largest gas unit broken (N-1)"], ["R2", "+ if the grid connection is lost, gas alone carries Tier 0"],
            ["R3", "+ gas alone carries Tier 0 and Tier 1, minus what can be relocated"], ["R4", "+ Texas SB6: imports cut to zero in stress events, and gas at least 50% of peak"], ["R5", "+ gas alone carries the whole campus"]].map(([k, v]) => <tr key={k}><td><b>{k}</b></td><td className="note">{v}</td></tr>)}</tbody></table></div></div>
        <div className="card"><h3 className="chart-h">Worked example: the hardest stress hour <small>26 Aug, 3 pm, 75 MW campus</small></h3>
          <div className="mt-calc">{[["Demand", "73.5 MW"], ["− Tier 1 that can be relocated", "11.4 MW"], ["− Tier 2 that can be paused", "7.6 MW"], ["− grid import allowed (60% of 75 MW)", "45.0 MW"]].map(([a, b]) => <div key={a}><span>{a}</span><b>{b}</b></div>)}
            <div className="mt-calc-total"><span>= onsite gas needed</span><b>9.5 MW</b></div></div>
          <p className="footnote">Under R1 that 9.5 MW must still be there after losing the biggest gas unit, which is why a 25 MW turbine usually comes with a few 5 MW engines.</p></div>
      </div>

      <div className="card"><h3 className="chart-h">What it reports</h3>
        <div className="mt-kpis">
          <F words="The headline cost figure.">$ per requested MWh = total cost ÷ MWh the campus asked for</F>
          <F words="Grid, onsite gas and the remote site, per MWh actually served.">emissions = (grid CO₂ + gas CO₂ + remote-site CO₂) ÷ MWh served</F>
          <F words="Share of the energy from contracts and clean-charged battery output.">clean share = clean MWh ÷ MWh served</F></div>
        <p className="footnote">Keep in mind: one weather year (ERCOT 2023) repeated ten times, with perfect foresight of prices and weather; no start-up costs, ramp limits or outages for gas. Sizing on representative days is an estimate; every number shown comes from the full 87,600-hour dispatch.</p></div>
    </Sec>

    <Sec id="mt-financial" title="2 · Financial model" n="02">
      <p className="section-sub">The Faraday pool method, from the GitHub project. It works like a spreadsheet: every row is a portfolio with known results; your choices filter and rank the rows. The <a href="/methodology/Powerllel_Financial_Model.xlsx" download>financial model workbook</a> does exactly this with live formulas.</p>
      <div className="mt-steps">{[
        ["Build the pool", "56,406 portfolios for the 75 MW campus (openings month 14–26), each run through the hourly dispatch for all 87,600 hours. A second pool of 56,259 never interrupts Tier 2."],
        ["Apply your limits", "Remove portfolios that open too late, emit too much on average, or cost more than your premium above the cheapest."],
        ["Score each goal 0–1", "Speed, cost and carbon are each scaled between the best and worst value in the pool."],
        ["Weight and rank", "Your template's weights combine the three scores into one 0–100 score; the highest is the recommendation."]].map(([t, d], i) => <article className="card mt-step" key={t}><span className="mt-n">{i + 1}</span><b>{t}</b><p>{d}</p></article>)}</div>
      <div className="mt-two">
        <div className="card"><h3 className="chart-h">The formulas</h3>
          <F words="How close a portfolio is to the earliest full demand in the pool (month 24 → 1, month 36 or later → 0).">speed score = (worst month − its full-demand month) ÷ (worst month − best month)</F>
          <F words="Cost per MWh the campus asked for, so a later opening can't look cheap just by serving less.">cost score = (worst $/MWh − its $/MWh) ÷ (worst $/MWh − best $/MWh)<br />$/MWh = 10-year decision cost ÷ requested MWh</F>
          <F words="Average operational emissions over the evaluation period.">carbon score = (worst kg/MWh − its kg/MWh) ÷ (worst kg/MWh − best kg/MWh)</F>
          <F words="Each score is clipped to 0–1 first. Ties go to the cheaper portfolio.">score = 100 × (w<sub>speed</sub>·speed + w<sub>cost</sub>·cost + w<sub>carbon</sub>·carbon) ÷ (w<sub>speed</sub> + w<sub>cost</sub> + w<sub>carbon</sub>)</F>
          <p className="footnote">Best and worst ("anchors") come from the whole pool, not from what survives your limits, so adding a limit only removes portfolios; it never reshuffles the rest. Worst cost is the price of the cleanest portfolio; worst carbon is the emissions of the cheapest.</p></div>
        <div className="card"><h3 className="chart-h">Templates <small>customer types from GridTech_Inputs.xlsx</small></h3>
          <div className="table-scroll"><table className="year-table"><thead><tr><th>Template</th><th>Speed</th><th>Cost</th><th>Carbon</th><th>Goal</th></tr></thead>
            <tbody>{[["Balanced", 34, 33, 33, "Best overall balance"], ["Speed-first", 70, 20, 10, "Earliest possible service"], ["Cost-first", 10, 80, 10, "Lowest 10-year cost"], ["Carbon-first", 10, 20, 70, "Lowest operational carbon"]].map(r => <tr key={r[0]}>{r.map((x, i) => <td key={i} className={i === 4 ? "note" : ""}>{x}</td>)}</tr>)}</tbody></table></div>
          <h3 className="chart-h mt-mt">Also computed</h3>
          <ul className="mt-list"><li><b>Trade-offs:</b> the recommendation against the cheapest, fastest and cleanest portfolios in the pool.</li>
            <li><b>Price sensitivity:</b> each option re-dispatched under bear (prices flat), base (packet: power +5%/yr, gas +3%/yr) and bull (power +8%/yr, gas +5%/yr) prices. Only wholesale power and gas are re-priced.</li>
            <li><b>No Tier 2 interruption:</b> the same search on the second pool.</li></ul></div>
      </div>
    </Sec>

    <Sec id="mt-files" title="Excel files" n="03">
      <div className="mt-files">{FILES.map(([u, t, d]) => <a key={u} className="card mt-file" href={u} download><span className="tag">XLSX</span><b>{t}</b><p>{d}</p><span className="mt-dl">Download ↓</span></a>)}</div>
    </Sec>

    <Sec id="mt-data" title="Data versions" n="04">
      <div className="card table-card"><div className="table-scroll"><table className="year-table"><thead><tr><th>Packet value</th><th>Optimisation model</th><th>Financial model (Excel)</th></tr></thead><tbody>
        {[["Packet", "v6.0.1", "v6.0.1"], ["Wind contract price", "$45/MWh", "$45/MWh"], ["Battery CAPEX / maximum", "$1,220/kW · 53 MW", "$1,220/kW · 53 MW"], ["Load, grid schedule, stress events, gas, solar, nuclear, land, remote site", "Packet values", "Packet values"],
          ["Battery charging", "From any source (packet rule)", "Only from surplus clean contract energy (stricter)"]].map(([a, b, c]) => <tr key={a}><td>{a}</td><td>{b}</td><td>{c}</td></tr>)}
      </tbody></table></div>
        <p className="footnote">Both models read the same packet (v6.0.1). The financial model's pools were rebuilt on it: every earlier portfolio re-scored, plus new searches for the cheapest, cleanest and in-between portfolios at every opening month. The one remaining difference is method, not data: the financial model's battery charges only from surplus clean contract energy.</p></div>
    </Sec>
  </div>;
}
