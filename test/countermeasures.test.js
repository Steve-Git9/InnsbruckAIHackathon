// Demand-swing countermeasures: overtime engine feature, catalogue guardrails, evaluator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHeadless } from '../src/headless/run.js';
import { SimulationEngine } from '../src/simulation/engine.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { loadDemand, loadRateCard } from '../src/data/loaders.js';
import { computeEconomics, overtimeRatePerHour } from '../src/economics/costs.js';
import { resolveCountermeasure, catalogueFor } from '../src/countermeasures/catalog.js';
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

test('catalogue guardrails: unknown ids, foreign disruptions, out-of-range and off-step values are rejected', () => {
  assert.throws(() => resolveCountermeasure('buy-a-robot', {}, 'demand-swing'), /unknown countermeasure/);
  assert.throws(() => resolveCountermeasure('overtime', { maxMinutesPerShift: 600 }, 'demand-swing'), /outside/);
  assert.throws(() => resolveCountermeasure('overtime', { maxMinutesPerShift: 45 }, 'demand-swing'), /steps/);
  assert.throws(() => resolveCountermeasure('faster-m3', { minutesSaved: 5 }), /outside/);
  assert.throws(() => resolveCountermeasure('second-m3', { colour: 'red' }), /no parameter/);
  assert.throws(() => resolveCountermeasure('overtime', {}, 'alien-invasion'), /not offered/);
  const ok = resolveCountermeasure('faster-m3', {}, 'demand-swing');
  assert.equal(ok.params.minutesSaved, 2);
  assert.equal(ok.override.config.machines.find(m => m.id === 'M3').cycleTime, 11);
  assert.deepEqual(catalogueFor('demand-swing').map(c => c.id), ['overtime', 'faster-m3', 'second-m3']);
});

test('evaluator: verdicts follow the simulation (2 seeds, quick)', async () => {
  const seeds = [1, 2];
  const ot = await evaluateCountermeasure('demand-swing', 'overtime', {}, { seeds });
  assert.equal(ot.verdict.code, 'effective');
  const m3b = await evaluateCountermeasure('demand-swing', 'second-m3', {}, { seeds });
  assert.ok(m3b.change.serviceLevel.mean > 0.3, 'second M3 raises delivery');
  assert.equal(m3b.verdict.code, 'costly', 'but loses money once unsold stock is not counted as profit');
});
