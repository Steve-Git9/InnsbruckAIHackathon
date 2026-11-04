// runHeadless: run the machine_sim engine without the UI or wall-clock timers and apply the Track B order rules.
//
// It finds the engine in ../simulation (src/simulation of the starter repo), else in $MACHINE_SIM/src/simulation if set.
//
//   const result = await runHeadless({
//     config,                 // simulation config; default DEFAULT_CONFIG. The helper always runs with infinite material (materialStock -1)
//     seed,                   // stored as config.seed; has an effect once you implement seeding (seeded reject gate)
//     shifts: 20,
//     demand,                 // array: orders per shift (the `orders` column of demand_profile.csv), at least `shifts` long
//     outage: { startTick: 4800, endTick: 5760 },   // optional: the source stops in this window
//     initialFinishedGoods: 0,
//     native: false,          // true: the engine itself applies the outage (cfg.source.outage) and the order rules (OrderBook)
//   });
//   // result = { perShift: [...], kpis: {...}, events: [...] }
//
// Order rules (same as the Track B README): orders of shift s are due at the end of shift s, served from finished-goods
// stock, oldest orders first; what cannot be shipped stays in the backlog. Service level = units shipped on or before
// their due tick / units ordered.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { machineKpis, kpisFromEngine, shiftRowsFromEngine } from '../simulation/summary.js';

export const TICKS_PER_SHIFT = 480;          // 1 tick = 1 minute, 1 shift = 8 hours
const NEVER = 1e9;                           // source interval used to halt the source
const MIN_EPISODE = 10;                      // starved/blocked episodes shorter than this many ticks are not reported

async function loadEngine() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../simulation')];                     // inside the starter repo (src/headless)
  if (process.env.MACHINE_SIM) candidates.push(path.join(process.env.MACHINE_SIM, 'src/simulation'));
  const dir = candidates.find((d) => fs.existsSync(path.join(d, 'engine.js')));
  if (!dir) {
    throw new Error(`machine_sim engine not found (looked for engine.js in: ${candidates.join(', ')}). `
      + 'Keep this file in src/headless/ of the starter repository, or set MACHINE_SIM=/path/to/machine_sim');
  }
  const [{ SimulationEngine }, { DEFAULT_CONFIG }] = await Promise.all([
    import(pathToFileURL(path.join(dir, 'engine.js'))),
    import(pathToFileURL(path.join(dir, 'config.js'))),
  ]);
  return { SimulationEngine, DEFAULT_CONFIG };
}

export async function runHeadless({
  config, seed = 0, shifts = 20, demand, outage = null, initialFinishedGoods = 0, native = false,
} = {}) {
  if (!Array.isArray(demand) || demand.length < shifts) throw new Error('demand must have at least `shifts` entries');
  const { SimulationEngine, DEFAULT_CONFIG } = await loadEngine();
  const cfg = JSON.parse(JSON.stringify(config ?? DEFAULT_CONFIG));
  cfg.source.materialStock = -1;                              // always infinite: use the outage for supply problems
  cfg.seed = seed;
  if (native) return runNative({ cfg, SimulationEngine, shifts, demand, outage, initialFinishedGoods });
  const engine = new SimulationEngine(cfg);
  const sourceInterval = cfg.source.interval;

  const perShift = [];
  let stock = initialFinishedGoods, backlog = 0, ordered = 0, onTime = 0, lastGood = 0, lastScrap = 0;
  const events = [];
  // outage window: the helper's own option, or the engine setting cfg.source.outage = { startTick, endTick } that you implement in the engine
  const marker = outage ?? cfg.source.outage;
  if (marker) events.push({ tick: marker.startTick, type: 'outage_start' }, { tick: marker.endTick, type: 'outage_end' });

  for (let s = 0; s < shifts; s++) {
    let wip = 0;
    for (let t = 0; t < TICKS_PER_SHIFT; t++) {
      const tick = s * TICKS_PER_SHIFT + t;
      // The outage is a halt of the source: during the window the source is skipped, its counter does not advance and
      // no part is released. Window = ticks t with startTick <= t < endTick, counting from 0; in the engine's own
      // numbering (engine.tick after it is incremented, first tick = 1) these are the ticks startTick < n <= endTick.
      // A natural engine implementation is an early `return` at the top of _tickSource() inside that window.
      const down = outage && tick >= outage.startTick && tick < outage.endTick;
      if (outage) engine.source.interval = down ? NEVER : sourceInterval;
      const counter = engine.source.ticksSinceLast;
      engine._tick();                                          // the engine's wall-clock scheduling is not used
      if (down) engine.source.ticksSinceLast = counter;        // frozen counter, as with an early return
      wip += engine.buffers.reduce((a, b) => a + b.parts.length, 0) + engine.machines.filter((m) => m.currentPart).length;
    }
    const made = engine.sink.partsReceived - lastGood, scrap = engine.scrapSink.partsReceived - lastScrap;
    lastGood = engine.sink.partsReceived; lastScrap = engine.scrapSink.partsReceived;
    stock += made;
    const orders = demand[s];
    ordered += orders;
    const need = orders + backlog, ship = Math.min(stock, need);
    stock -= ship;
    const shippedOnTime = Math.max(0, Math.min(orders, ship - backlog));   // oldest first: backlog is served before new orders
    onTime += shippedOnTime;
    backlog = need - ship;
    perShift.push({ shift: s + 1, produced: made, scrap, orders, shipped: ship, shippedOnTime, backlog, stock, wip: +(wip / TICKS_PER_SHIFT).toFixed(2) });
    if (shippedOnTime < orders) events.push({ tick: (s + 1) * TICKS_PER_SHIFT, shift: s + 1, type: 'shortfall', ordered: orders, shippedOnTime, short: orders - shippedOnTime });
  }

  events.push(...machineEpisodes(engine));
  events.sort((a, b) => a.tick - b.tick);

  const machines = machineKpis(engine, shifts * TICKS_PER_SHIFT);
  const kpis = {
    shifts,
    goodParts: engine.sink.partsReceived,
    lineYield: +(engine.sink.partsReceived / Math.max(1, engine.source.totalGenerated)).toFixed(3),
    goodPerShift: +(engine.sink.partsReceived / shifts).toFixed(2),
    scrap: engine.scrapSink.partsReceived,
    released: engine.source.totalGenerated,
    ordered,
    serviceLevel: +(onTime / ordered).toFixed(3),
    backlogEnd: backlog,
    avgWip: +(perShift.reduce((a, r) => a + r.wip, 0) / shifts).toFixed(2),
    finishedGoodsEnd: stock,
    machines,
  };
  for (const e of engine.events) events.push({ tick: e.start, shift: Math.floor((e.start - 1) / TICKS_PER_SHIFT) + 1, type: 'breakdown', machine: e.machine, mode: e.mode, ticks: e.repair });
  events.sort((a, b) => a.tick - b.tick);
  return { perShift, kpis, events, supply: engine.supply?.snapshot() ?? null };
}

// Native path: the engine applies the outage (cfg.source.outage) and the order rules (its OrderBook) itself.
function runNative({ cfg, SimulationEngine, shifts, demand, outage, initialFinishedGoods }) {
  cfg.demand = demand.slice(0, shifts);
  cfg.initialFinishedGoods = initialFinishedGoods;
  if (outage) cfg.source.outage = { startTick: outage.startTick, endTick: outage.endTick };
  const engine = new SimulationEngine(cfg);
  // Run until every shift is closed. Without overtime this is exactly shifts x 480 ticks;
  // overtime adds engine ticks at shift ends without moving the plant clock.
  const limit = shifts * TICKS_PER_SHIFT * 2;
  while (engine.orders.rows.length < shifts && engine.tick < limit) engine._tick();

  const perShift = shiftRowsFromEngine(engine);
  const events = [];
  const marker = cfg.source.outage;
  if (marker) events.push({ tick: marker.startTick, type: 'outage_start' }, { tick: marker.endTick, type: 'outage_end' });
  for (const r of perShift) {
    if (r.shippedOnTime < r.orders) events.push({ tick: r.shift * TICKS_PER_SHIFT, shift: r.shift, type: 'shortfall', ordered: r.orders, shippedOnTime: r.shippedOnTime, short: r.orders - r.shippedOnTime });
  }
  events.push(...machineEpisodes(engine));
  for (const e of engine.events) events.push({ tick: e.start, shift: Math.floor(((e.plantStart ?? e.start) - 1) / TICKS_PER_SHIFT) + 1, type: 'breakdown', machine: e.machine, mode: e.mode, ticks: e.repair });
  for (const r of perShift) if (r.overtimeMin > 0) events.push({ tick: r.shift * TICKS_PER_SHIFT, shift: r.shift, type: 'overtime', minutes: r.overtimeMin });
  events.sort((a, b) => a.tick - b.tick);
  return { perShift, kpis: kpisFromEngine(engine, shifts), events, supply: engine.supply?.snapshot() ?? null, engine };
}

export function readDemand(csvPath) {
  return fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1).map((l) => Number(l.split(',')[3]));
}

// Long STARVED / BLOCKED episodes per machine, from the per-tick history.
function machineEpisodes(engine) {
  const events = [];
  const hist = engine.getHistory();
  const plantAt = new Map(hist.map(r => [r.tick, r.plantTick ?? r.tick]));   // shift attribution on the plant clock
  for (const m of engine.machines) {
    let cur = null, start = 0;
    const flush = (end) => {
      if (cur && end - start >= MIN_EPISODE) events.push({ tick: start, shift: Math.floor((plantAt.get(start) ?? start) / TICKS_PER_SHIFT) + 1, type: `machine_${cur.toLowerCase()}`, machine: m.id, ticks: end - start });
    };
    for (const row of hist) {
      const st = row[`${m.id}_state`], keep = st === 'STARVED' || st === 'BLOCKED' ? st : null;
      if (keep !== cur) { flush(row.tick); cur = keep; start = row.tick; }
    }
    flush(hist.length ? hist[hist.length - 1].tick + 1 : 0);
  }
  return events;
}
