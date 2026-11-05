/**
 * run-summary.js
 * Turns a finished (or running) engine into the plain JSON the Results tiles and the
 * AI advisor use. Pure: every number comes from the simulation.
 */
import { liveResult, shiftRowsFromEngine, machineKpis } from '../simulation/summary.js';
import { computeEconomics } from '../economics/costs.js';
import { bottleneckLoss } from '../analysis/analysis.js';
import { DEFAULT_CONFIG } from '../simulation/config.js';

const CAUSE_TEXT = {
  down: 'machine breakdowns',
  starvedOutage: 'the supplier outage',
  starvedUpstream: 'waiting for parts from earlier stations',
  blocked: 'a full buffer after the machine',
  other: 'idle time',
};

export function buildRunSummary(engine, scenario, rate) {
  const cfg = engine.getConfig();
  const result = liveResult(engine);
  if (!result) return null;
  const perShift = shiftRowsFromEngine(engine);
  const shifts = perShift.length;
  const o = engine.orders.summary();
  const econ = computeEconomics(result, cfg, DEFAULT_CONFIG, rate);
  const k = result.kpis;

  const late = o.ordered - o.shippedOnTime;
  const goodParts = k.goodParts;

  // worst shift = the largest shortfall of orders shipped on time
  let worst = null;
  for (const r of perShift) {
    const short = r.orders - r.shippedOnTime;
    if (short > 0 && (!worst || short > worst.short)) worst = { shift: r.shift, orders: r.orders, shippedOnTime: r.shippedOnTime, short };
  }

  // bottleneck: the busiest station, and where its minutes went
  const loss = bottleneckLoss(engine.getHistory(), { outage: cfg.source.outage ?? null, config: cfg });
  const mk = machineKpis(engine, Math.max(1, engine.tick));
  const bnIds = loss.machines;
  const bnUtil = bnIds.length ? bnIds.reduce((a, id) => a + (mk[id]?.utilisation ?? 0), 0) / bnIds.length : 0;
  const top = Object.entries(loss.lossShare ?? {}).sort((a, b) => b[1] - a[1])[0];
  const bottleneck = {
    machine: bnIds.length ? bnIds[0].replace(/[a-z]+$/, '') : null,
    utilisation: +bnUtil.toFixed(3),
    lostMinutes: loss.lostMinutes,
    mainCause: top && loss.lostMinutes > 0 ? CAUSE_TEXT[top[0]] : 'no significant loss',
  };

  return {
    scenario: { id: scenario.id, label: scenario.label },
    shifts,
    orders: { ordered: o.ordered, shippedOnTime: o.shippedOnTime, serviceLevel: o.ordered > 0 ? o.shippedOnTime / o.ordered : 1, late, backlogEnd: o.backlog },
    production: { goodParts, goodPerShift: shifts ? goodParts / shifts : 0, scrap: k.scrap, released: k.released, lineYield: k.released ? goodParts / k.released : 0, overtimeHours: perShift.reduce((a, r) => a + (r.overtimeMin ?? 0), 0) / 60 },
    money: { profit: econ.profit, costPerGoodUnit: econ.costPerGoodUnit, revenue: econ.revenue, lostSalesPenalty: econ.lostSales },
    worstShift: worst,
    bottleneck,
    disruption: disruptionOf(scenario, engine, cfg, loss, perShift, mk),
    perShift,
  };
}

function disruptionOf(scenario, engine, cfg, loss, perShift, mk) {
  if (scenario.id === 'supplier-outage') {
    const out = cfg.source.outage;
    return {
      window: `shifts ${Math.floor(out.startTick / 480) + 1}–${Math.ceil(out.endTick / 480)}`,
      sourceHaltedMinutes: out.endTick - out.startTick,
      bottleneckStarvedByOutageMinutes: loss.total.starvedOutage,
    };
  }
  if (scenario.id === 'machinery-breakdown') {
    const ev = engine.events.filter(e => e.type === 'breakdown');
    const downMinutesByMachine = {}, availabilityByMachine = {};
    for (const e of ev) downMinutesByMachine[e.machine] = (downMinutesByMachine[e.machine] ?? 0) + (e.repair ?? 0);
    for (const [id, m] of Object.entries(mk)) availabilityByMachine[id] = m.oee.availability;
    return { count: ev.length, downMinutesByMachine, availabilityByMachine };
  }
  if (scenario.id === 'demand-swing') {
    let peak = perShift[0];
    for (const r of perShift) if (r.orders > peak.orders) peak = r;
    return { peakShift: peak.shift, peakOrders: peak.orders, minOrders: Math.min(...perShift.map(r => r.orders)) };
  }
  return null;
}
