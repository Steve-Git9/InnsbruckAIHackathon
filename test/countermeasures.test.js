// Pool of 6 countermeasures: catalogue and guardrails, evaluator; plus the overtime engine feature (no longer in the pool).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHeadless } from '../src/headless/run.js';
import { SimulationEngine } from '../src/simulation/engine.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { loadDemand, loadRateCard } from '../src/data/loaders.js';
import { computeEconomics, overtimeRatePerHour } from '../src/economics/costs.js';
import { resolveCountermeasure, catalogueFor, COUNTERMEASURES, DISRUPTIONS } from '../src/countermeasures/catalog.js';
import { evaluateCountermeasure } from '../src/countermeasures/evaluate.js';

const demand = loadDemand();
const rate = loadRateCard();
const cfgWith = (extra = {}) => ({ ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), ...extra });
const run = (cfg, seed = 1) => runHeadless({ config: cfg, seed, shifts: 20, demand, native: true });

test('overtime off (or absent) leaves the run identical', async () => {
  const a = await run(cfgWith());
  const b = await run(cfgWith({ overtime: { enabled: false, maxMinutesPerShift: 120 } }));
  assert.deepEqual(a.perShift, b.perShift);
  assert.ok(a.perShift.every(r => r.overtimeMin === 0));
});

test('overtime is worked only when orders exceed stock, never above the maximum', async () => {
  const r = await run(cfgWith({ overtime: { enabled: true, maxMinutesPerShift: 90 } }));
  assert.ok(r.perShift.some(x => x.overtimeMin > 0), 'demand swing needs some overtime');
  assert.ok(r.perShift.every(x => x.overtimeMin <= 90));
  // a shift whose orders were all shipped on time with nothing left over needed no overtime
  // only if it stopped early or never started; a shift with a full 90 min must still have been short
  for (const x of r.perShift) {
    if (x.overtimeMin > 0 && x.overtimeMin < 90) assert.equal(x.backlog, 0, `shift ${x.shift}: overtime stops only when orders are covered`);
  }
  // shift 6 orders 7 sets and the line has caught up by then: no overtime
  assert.equal(r.perShift[5].overtimeMin, 0);
});

test('overtime does not move the plant clock: due ticks and the outage window stay where they are', () => {
  const cfg = cfgWith({ overtime: { enabled: true, maxMinutesPerShift: 120 } });
  cfg.source.materialStock = -1;
  cfg.demand = demand.slice(0, 13);
  cfg.source.outage = { startTick: 4800, endTick: 5760 };
  cfg.seed = 1;
  const e = new SimulationEngine(cfg);
  while (e.orders.rows.length < 13) e._tick();
  assert.equal(e.plantTick, 13 * 480);
  assert.ok(e.tick > e.plantTick, 'engine ticks include overtime');
  // the source released nothing while the PLANT clock was inside the outage window
  const hist = e.getHistory();
  const inWindow = hist.filter(r => r.plantTick > 4800 && r.plantTick <= 5760);
  assert.equal(inWindow[0].sourceTotalGenerated, inWindow[inWindow.length - 1].sourceTotalGenerated);
});

test('overtime raises on-time delivery in the demand swing and is charged at the assumed rate', async () => {
  const base = await run(cfgWith());
  const cfg = cfgWith({ overtime: { enabled: true, maxMinutesPerShift: 120 } });
  const ot = await run(cfg);
  assert.ok(ot.kpis.serviceLevel > base.kpis.serviceLevel + 0.15);
  const e = computeEconomics(ot, cfg, DEFAULT_CONFIG, rate);
  assert.equal(overtimeRatePerHour(cfg, rate), (85 + 55 + 90 + 40) * 1.5);
  assert.ok(Math.abs(e.overtimeCost - e.overtimeHours * 405) < 1e-6);
  assert.equal(e.overtimeHours, ot.perShift.reduce((a, r) => a + r.overtimeMin, 0) / 60);
});

const SCENARIO_IDS = ['standard', 'demand-swing', 'supplier-outage', 'machinery-breakdown'];

test('catalogue: 6 entries with a class (2 strategic, 4 operational), no overtime, the same 6 in all 4 scenarios', () => {
  assert.deepEqual(Object.keys(COUNTERMEASURES), ['improve-machine', 'new-line', 'extra-supplier', 'outsourcing', 'raw-stock', 'finished-stock']);
  assert.ok(!('overtime' in COUNTERMEASURES));
  for (const c of Object.values(COUNTERMEASURES)) {
    assert.ok(['strategic', 'operational'].includes(c.category), c.id);
    assert.equal('appliesTo' in c, false, c.id);
  }
  assert.deepEqual(Object.values(COUNTERMEASURES).filter(c => c.category === 'strategic').map(c => c.id), ['improve-machine', 'new-line']);
  assert.equal(Object.values(COUNTERMEASURES).filter(c => c.category === 'operational').length, 4);
  assert.deepEqual(Object.keys(DISRUPTIONS), SCENARIO_IDS);
  for (const sc of SCENARIO_IDS) {
    const c = catalogueFor(sc);
    assert.deepEqual(c.map(x => x.id), Object.keys(COUNTERMEASURES), sc);
    assert.ok(c.every(x => x.category), sc);
  }
  assert.throws(() => catalogueFor('alien-invasion'), /unknown scenario/);
});

test('catalogue parameters: min..max, step, default as in the spec', () => {
  const p = (id, name) => COUNTERMEASURES[id].params[name];
  const shape = (d) => [d.min, d.max, d.step, d.default];
  assert.deepEqual(shape(p('improve-machine', 'minutesSaved')), [1, 2, 1, 2]);
  assert.deepEqual(shape(p('new-line', 'releaseInterval')), [7, 11, 1, 8]);
  assert.deepEqual(shape(p('outsourcing', 'maxSetsPerShift')), [5, 30, 5, 15]);
  assert.deepEqual(shape(p('raw-stock', 'stockLevel')), [100, 400, 50, 250]);
  assert.deepEqual(shape(p('finished-stock', 'sets')), [10, 100, 10, 50]);
  assert.deepEqual(COUNTERMEASURES['extra-supplier'].params, {});
});

test('catalogue guardrails: overtime and unknown ids, unknown scenarios, out-of-range and off-step values are rejected; old ids resolve', () => {
  assert.throws(() => resolveCountermeasure('buy-a-robot', {}, 'demand-swing'), /unknown countermeasure/);
  assert.throws(() => resolveCountermeasure('overtime', {}, 'demand-swing'), /unknown countermeasure "overtime"/);
  assert.throws(() => resolveCountermeasure('overtime', { maxMinutesPerShift: 120 }), /unknown countermeasure/);
  assert.throws(() => resolveCountermeasure('improve-machine', { minutesSaved: 5 }), /outside/);
  assert.throws(() => resolveCountermeasure('raw-stock', { stockLevel: 275 }), /steps/);
  assert.throws(() => resolveCountermeasure('finished-stock', { sets: 5 }), /outside/);
  assert.throws(() => resolveCountermeasure('new-line', { colour: 'red' }), /no parameter/);
  assert.throws(() => resolveCountermeasure('extra-supplier', { x: 1 }), /no parameter/);
  assert.throws(() => resolveCountermeasure('outsourcing', {}, 'alien-invasion'), /unknown scenario/);
  const ok = resolveCountermeasure('improve-machine', {}, 'demand-swing');
  assert.equal(ok.params.minutesSaved, 2);
  assert.equal(ok.override.config.machines.find(m => m.id === 'M3').cycleTime, 11);
  // aliases
  assert.equal(resolveCountermeasure('faster-m3', {}).cm.id, 'improve-machine');
  assert.equal(resolveCountermeasure('second-m3', {}).cm.id, 'new-line');
  assert.equal(resolveCountermeasure('second-m3', {}).override.config.machines.length, 5);
  assert.throws(() => resolveCountermeasure('faster-m3', { minutesSaved: 5 }), /outside/);
});

test('every countermeasure builds the override described in the spec', () => {
  const o = (id, params = {}) => resolveCountermeasure(id, params).override;
  assert.equal(o('outsourcing').config.outsourcing.pricePerSet, 150);
  assert.equal(o('outsourcing', { maxSetsPerShift: 25 }).config.outsourcing.maxSetsPerShift, 25);
  assert.deepEqual(o('raw-stock', { stockLevel: 400 }).config.supply, { mode: 'inventory', reorderPoint: 300, orderQty: 150, initialStock: 400 });
  assert.equal(o('finished-stock', { sets: 70 }).initialFinishedGoods, 70);
  assert.equal(o('new-line', { releaseInterval: 9 }).config.source.interval, 9);
});

// ── backup supplier (jit mode) ────────────────────────────────────────────
const flat = Array(20).fill(34);
const OUTAGE = { startTick: 4800, endTick: 5760 };
const runWith = (id, extra = {}) => {
  const cfg = { ...cfgWith(), ...resolveCountermeasure(id, {}).override.config };
  return runHeadless({ config: cfg, seed: 1, shifts: 20, demand: flat, native: true, ...extra });
};
const firstPartAfter = (e, tick) => {
  const h = e.getHistory();
  const before = h[tick - 1].sourceTotalGenerated;
  return h.find(r => r.tick > tick && r.sourceTotalGenerated > before)?.tick;
};

test('backup supplier: during an outage the source restarts leadTime ticks into the window; parts released inside it are backup parts', async () => {
  const base = await runHeadless({ config: cfgWith(), seed: 1, shifts: 20, demand: flat, native: true, outage: OUTAGE });
  const bk = await runWith('extra-supplier', { outage: OUTAGE });
  assert.equal(base.kpis.backupParts, 0);
  assert.ok(bk.kpis.backupParts > 0);
  // the source stands still for 240 ticks (the first part needs a few more ticks for its counter), then releases again
  const restart = firstPartAfter(bk.engine, OUTAGE.startTick);
  assert.ok(restart > OUTAGE.startTick + 240, `restart at ${restart}`);
  assert.ok(restart <= OUTAGE.startTick + 240 + 11, `restart at ${restart}`);
  // without the backup supplier the source stays stopped for the whole window
  assert.ok(firstPartAfter(base.engine, OUTAGE.startTick) > OUTAGE.endTick);
  // one part every 11 ticks for the rest of the window: (960 - 240) / 11 = 65
  assert.ok(Math.abs(bk.kpis.backupParts - 720 / 11) <= 1, `backup parts ${bk.kpis.backupParts}`);
  assert.ok(bk.kpis.serviceLevel > base.kpis.serviceLevel);
});

test('backup supplier: without an outage the run is identical to the baseline (same seed), only the qualification is charged', async () => {
  const base = await runHeadless({ config: cfgWith(), seed: 1, shifts: 20, demand: flat, native: true });
  const bk = await runWith('extra-supplier');
  assert.deepEqual(bk.perShift, base.perShift);
  assert.equal(bk.kpis.backupParts, 0);
  const eBase = computeEconomics(base, cfgWith(), DEFAULT_CONFIG, rate);
  const cfg = { ...cfgWith(), ...resolveCountermeasure('extra-supplier', {}).override.config };
  const eBk = computeEconomics(bk, cfg, DEFAULT_CONFIG, rate);
  assert.equal(eBk.backupPremium, 0);
  assert.ok(Math.abs((eBase.profit - eBk.profit) - 2000 / 1920 * 20) < 1e-6, 'only the amortised EUR 2,000');
});

test('backup supplier: backup parts cost +8% of the part price, and the qualification is a one-time cost', async () => {
  const bk = await runWith('extra-supplier', { outage: OUTAGE });
  const cfg = { ...cfgWith(), ...resolveCountermeasure('extra-supplier', {}).override.config };
  cfg.source.outage = OUTAGE;
  const e = computeEconomics(bk, cfg, DEFAULT_CONFIG, rate);
  assert.ok(Math.abs(e.backupPremium - bk.kpis.backupParts * 38 * 0.08) < 1e-9);
  assert.equal(e.oneTime.items.secondSupplier, 2000);
  // the qualification is amortised like an investment
  assert.ok(Math.abs(e.amortised - 2000 / 1920 * 20) < 1e-9);
  // the base material cost is not touched
  assert.ok(Math.abs(e.materialCost - bk.kpis.released * 38) < 1e-9);
});

// ── outsourcing ───────────────────────────────────────────────────────────
const swingRun = (maxSetsPerShift, seed = 1) => {
  const cfg = { ...cfgWith(), outsourcing: { enabled: true, maxSetsPerShift, pricePerSet: 150, leadShifts: 1 } };
  return runHeadless({ config: cfg, seed, shifts: 20, demand, native: true });
};

test('outsourcing: never orders without a backlog, never more than the maximum per shift, sets arrive the next shift', async () => {
  const r = await swingRun(15);
  let ordered = 0, received = 0;
  r.perShift.forEach((row, i) => {
    if (row.backlog === 0) assert.equal(row.outsourcedOrdered, 0, `shift ${row.shift}: no backlog, no order`);
    assert.ok(row.outsourcedOrdered <= 15, `shift ${row.shift}`);
    assert.ok(row.outsourcedOrdered <= row.backlog, `shift ${row.shift}: not more than the backlog`);
    // what is ordered at the close of shift s arrives in shift s + 1 (and not before)
    assert.equal(row.outsourced, i === 0 ? 0 : r.perShift[i - 1].outsourcedOrdered, `shift ${row.shift}`);
    ordered += row.outsourcedOrdered; received += row.outsourced;
  });
  assert.ok(ordered > 0, 'the demand swing leaves a backlog');
  assert.equal(r.kpis.outsourcedOrdered, ordered);
  assert.equal(r.kpis.outsourcedReceived, received);
  assert.ok(received <= ordered, 'the last order has not arrived when the run ends');
  // a lower maximum is respected
  const small = await swingRun(5);
  assert.ok(small.perShift.every(row => row.outsourcedOrdered <= 5));
});

test('outsourcing: nothing ordered in a scenario without any backlog', async () => {
  const cfg = { ...cfgWith(), outsourcing: { enabled: true, maxSetsPerShift: 30 } };
  const r = await runHeadless({ config: cfg, seed: 1, shifts: 20, demand: Array(20).fill(5), native: true });
  assert.equal(r.kpis.outsourcedOrdered, 0);
  assert.ok(r.perShift.every(row => row.outsourced === 0 && row.outsourcedOrdered === 0));
});

test('outsourcing: goodParts, yield and OEE stay line-only; the cost is received x EUR 150; cost per good set counts them', async () => {
  const base = await run(cfgWith());
  const r = await swingRun(15);
  assert.equal(r.kpis.goodParts, base.kpis.goodParts, 'the line is not changed');
  assert.deepEqual(r.kpis.machines, base.kpis.machines);
  assert.equal(r.kpis.lineYield, base.kpis.lineYield);
  const cfg = { ...cfgWith(), outsourcing: { enabled: true, maxSetsPerShift: 15 } };
  const e = computeEconomics(r, cfg, DEFAULT_CONFIG, rate);
  assert.equal(e.outsourcedReceived, r.kpis.outsourcedReceived);
  assert.equal(e.outsourcingCost, r.kpis.outsourcedReceived * 150);
  const eb = computeEconomics(base, cfgWith(), DEFAULT_CONFIG, rate);
  const parts = e.machineCost + e.overtimeCost + e.materialCost + e.holdingWip + e.outsourcingCost;
  assert.ok(Math.abs(e.costPerGoodUnit - parts / (r.kpis.goodParts + r.kpis.outsourcedReceived)) < 1e-9);
  assert.equal(eb.outsourcingCost, 0);
  // it helps: more orders on time
  assert.ok(r.kpis.serviceLevel > base.kpis.serviceLevel + 0.1);
});

test('outsourced sets are shipped through the order book (FIFO) and never counted twice', async () => {
  const r = await swingRun(15);
  const shipped = r.perShift.reduce((a, x) => a + x.shipped, 0);
  const made = r.kpis.goodParts + r.kpis.outsourcedReceived;
  assert.ok(shipped <= made, 'cannot ship more sets than the line made plus what the partner delivered');
  // stock identity: shipped + stock at the end = start stock + line + partner
  assert.equal(shipped + r.kpis.finishedGoodsEnd, made);
});

test('outsourcing is off by default and changes nothing then (the calibration case of the data package)', async () => {
  const r = await run(cfgWith());
  assert.equal(r.kpis.outsourcedOrdered, 0);
  assert.equal(r.kpis.backupParts, 0);
  const e = computeEconomics(r, cfgWith(), DEFAULT_CONFIG, rate);
  assert.equal(e.outsourcingCost, 0);
  assert.equal(e.backupPremium, 0);
  assert.ok(r.perShift.every(x => x.outsourced === 0));
});

// ── evaluator ─────────────────────────────────────────────────────────────
test('evaluator: verdicts follow the simulation (2 seeds, quick)', async () => {
  const seeds = [1, 2];
  const fs = await evaluateCountermeasure('demand-swing', 'finished-stock', {}, { seeds });
  assert.equal(fs.verdict.code, 'effective');
  assert.equal(fs.countermeasure.category, 'operational');
  const m3b = await evaluateCountermeasure('demand-swing', 'new-line', {}, { seeds });
  assert.ok(m3b.change.serviceLevel.mean > 0.3, 'a new line raises delivery');
  assert.equal(m3b.verdict.code, 'costly', 'but loses money once unsold stock is not counted as profit');
  assert.equal(m3b.countermeasure.category, 'strategic');
});

test('evaluator works in every scenario for every countermeasure (2 seeds, 3 shifts)', async () => {
  for (const sc of SCENARIO_IDS) {
    for (const id of Object.keys(COUNTERMEASURES)) {
      const r = await evaluateCountermeasure(sc, id, {}, { seeds: [1, 2], shifts: 3 });
      assert.equal(r.disruption.id, sc);
      assert.equal(r.countermeasure.id, id);
      assert.ok(Number.isFinite(r.with.costPerGoodUnit) && Number.isFinite(r.without.costPerGoodUnit), `${sc} ${id}`);
    }
  }
});
