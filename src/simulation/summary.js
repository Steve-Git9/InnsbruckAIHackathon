/**
 * summary.js
 * Pure helpers that turn an engine (after or during a run) into the KPI shapes
 * used by runHeadless, the economics module and the server.
 */

// Utilisation and OEE per machine, from the engine's state counters over all
// `totalTicks` scheduled ticks.
//   OEE = availability x performance x quality
//   availability = 1 - down / scheduled
//   performance  = processing / (processing + blocked + starved)
//   quality      = good / processed, from the machine's OWN reject counter
export function machineKpis(engine, totalTicks) {
  const total = Math.max(1, totalTicks);
  const out = {};
  for (const m of engine.machines) {
    const busy = m.ticksProcessing, flowLoss = m.ticksBlocked + m.ticksStarved;
    const quality = m.partsProcessed ? 1 - m.scrapped / m.partsProcessed : 1;
    const availability = 1 - m.ticksDown / total;
    const performance = busy / (busy + flowLoss || 1);
    out[m.id] = {
      utilisation: +(busy / total).toFixed(3),
      blocked: +(m.ticksBlocked / total).toFixed(3),
      starved: +(m.ticksStarved / total).toFixed(3),
      down: +(m.ticksDown / total).toFixed(3),
      oee: {
        availability: +availability.toFixed(3),
        performance: +performance.toFixed(3),
        quality: +quality.toFixed(3),
        value: +(availability * performance * quality).toFixed(3),
      },
    };
  }
  return out;
}

// Per-shift rows of the native path, in the helper's row shape (+ released, lostSales).
export function shiftRowsFromEngine(engine) {
  return (engine.orders?.rows ?? []).map(r => ({
    shift: r.shift,
    produced: r.produced,
    scrap: r.scrap ?? 0,
    orders: r.orders,
    shipped: r.shipped,
    shippedOnTime: r.shippedOnTime,
    backlog: r.backlog,
    stock: r.stock,
    wip: r.wip ?? 0,
    released: r.released ?? 0,
    lostSales: r.lostSales,
    overtimeMin: r.overtimeMin ?? 0,
  }));
}

// KPIs of the engine's own order book (native path).
export function kpisFromEngine(engine, shifts) {
  const o = engine.orders.summary();
  const perShift = shiftRowsFromEngine(engine);
  const n = Math.max(1, shifts);
  return {
    shifts,
    goodParts: engine.sink.partsReceived,
    lineYield: +(engine.sink.partsReceived / Math.max(1, engine.source.totalGenerated)).toFixed(3),
    goodPerShift: +(engine.sink.partsReceived / n).toFixed(2),
    scrap: engine.scrapSink.partsReceived,
    released: engine.source.totalGenerated,
    ordered: o.ordered,
    serviceLevel: o.ordered > 0 ? +(o.shippedOnTime / o.ordered).toFixed(3) : 1,
    lostSales: o.lostSales,
    backlogEnd: o.backlog,
    avgWip: +(perShift.reduce((a, r) => a + r.wip, 0) / n).toFixed(2),
    finishedGoodsEnd: o.stock,
    overtimeMin: perShift.reduce((a, r) => a + r.overtimeMin, 0),
    // scheduled ticks include overtime, so utilisation stays <= 1
    machines: machineKpis(engine, Math.max(shifts * engine.orders.ticksPerShift, engine.tick)),
  };
}

// Result of a run in progress, in the runHeadless result shape, for the CLOSED shifts
// only (orders are booked at the end of a shift). Null when no demand is configured
// or no shift has closed yet. Used by GET /api/kpis.
export function liveResult(engine) {
  if (!engine.orders || engine.orders.rows.length === 0) return null;
  const perShift = shiftRowsFromEngine(engine);
  const sum = (k) => perShift.reduce((a, r) => a + r[k], 0);
  const o = engine.orders.summary();
  const shifts = perShift.length;
  return {
    perShift,
    supply: engine.supply ? engine.supply.snapshot() : null,
    kpis: {
      shifts,
      goodParts: sum('produced'),
      released: sum('released'),
      scrap: sum('scrap'),
      ordered: o.ordered,
      serviceLevel: o.ordered > 0 ? o.shippedOnTime / o.ordered : 1,
      finishedGoodsEnd: o.stock,
      backlogEnd: o.backlog,
    },
  };
}
