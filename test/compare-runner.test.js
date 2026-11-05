// Side-by-side comparison runner: lockstep by the plant clock, no timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompareRunner, buildEngines } from '../src/ui/compare-runner.js';
import { buildUiScenario } from '../src/ui/scenarios.js';
import { runHeadless } from '../src/headless/run.js';
import { resolveCountermeasure } from '../src/countermeasures/catalog.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { SimulationEngine } from '../src/simulation/engine.js';

const advice = (id, params = {}, shifts = 20) => ({
  scenarioId: 'demand-swing', selection: [{ id, params: resolveCountermeasure(id, params, 'demand-swing').params }], label: id, source: 'manual', shifts,
});
// overtime is an engine feature, not a countermeasure of the pool: it is given as a raw config override
const overtimeAdvice = (shifts = 20, maxMinutesPerShift = 120) => ({
  scenarioId: 'demand-swing', selection: [], configOverride: { overtime: { enabled: true, maxMinutesPerShift } }, label: 'overtime', source: 'manual', shifts,
});
const rows = (e) => e.orders.rows.map(r => ({ ...r }));

test('both engines reach 20 shifts and end at plant tick 9600', () => {
  for (const [id, adv] of [['overtime', overtimeAdvice()], ['improve-machine', advice('improve-machine')], ['new-line', advice('new-line')],
    ['outsourcing', advice('outsourcing')], ['extra-supplier', advice('extra-supplier')]]) {
    const c = new CompareRunner(adv);
    c.runToEnd();
    assert.equal(c.a.orders.rows.length, 20, id);
    assert.equal(c.b.orders.rows.length, 20, id);
    assert.equal(c.a.plantTick, 9600, id);
    assert.equal(c.b.plantTick, 9600, id);
  }
});

test('engine A equals a solo run of the same UI scenario', () => {
  const c = new CompareRunner(advice('outsourcing'));
  c.runToEnd();
  const sc = buildUiScenario('demand-swing');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); cfg.source.materialStock = -1;
  const solo = new SimulationEngine(cfg);
  solo.configureScenario({ ...sc.configureOptions, runShifts: 20 });
  while (solo.orders.rows.length < 20) solo._tick();
  assert.deepEqual(rows(c.a), rows(solo));
});

test('engine B equals runHeadless with the countermeasure config (same seed)', async () => {
  for (const id of ['improve-machine', 'outsourcing', 'raw-stock']) {
    const adv = advice(id);
    const c = new CompareRunner(adv);
    c.runToEnd();
    const sc = buildUiScenario('demand-swing');
    const cfg = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), ...resolveCountermeasure(id, adv.selection[0].params, 'demand-swing').override.config };
    cfg.source = { ...cfg.source, materialStock: -1 };
    const r = await runHeadless({ config: cfg, seed: 1, shifts: 20, demand: sc.configureOptions.demand, native: true });
    assert.deepEqual(rows(c.b).map(x => x.shippedOnTime), r.perShift.map(x => x.shippedOnTime), id);
    assert.deepEqual(rows(c.b).map(x => x.produced), r.perShift.map(x => x.produced), id);
  }
});

test('with overtime (engine feature), A waits while B works overtime: A has fewer engine ticks', () => {
  const c = new CompareRunner(overtimeAdvice());
  let waited = 0;
  while (!c.done) {
    c.step();
    if (c.waitingA) waited++;
  }
  assert.ok(waited > 0, 'A waited at least once');
  assert.ok(c.a.tick <= c.b.tick);
  assert.equal(c.b.tick - c.a.tick, waited);
  assert.ok(c.b.orders.rows.some(r => r.overtimeMin > 0));
  assert.ok(c.a.orders.rows.every(r => !r.overtimeMin));
});

test('without overtime the two engines tick together', () => {
  const c = new CompareRunner(advice('new-line'));
  c.runToEnd();
  assert.equal(c.a.tick, c.b.tick);
});

test('start({ instant }) finishes at once and can be restarted from tick 0', () => {
  const c = new CompareRunner(advice('outsourcing'));
  c.start({ instant: true });
  assert.ok(c.done);
  assert.equal(c.running, false);
  const first = rows(c.b);
  c.start({ instant: true });
  assert.deepEqual(rows(c.b), first);
});

test('buildEngines gives the second line the countermeasure', () => {
  const { a, b } = buildEngines(advice('new-line'));
  assert.equal(b.machines.length, a.machines.length + 1);
});

test('a shorter run: advice.shifts = 5 stops both engines at plant tick 2400, and A equals a solo 5-shift run', () => {
  const c = new CompareRunner(advice('outsourcing', {}, 5));
  c.runToEnd();
  assert.equal(c.a.orders.rows.length, 5);
  assert.equal(c.b.orders.rows.length, 5);
  assert.equal(c.a.plantTick, 2400);
  assert.equal(c.b.plantTick, 2400);
  const sc = buildUiScenario('demand-swing', 5);
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); cfg.source.materialStock = -1;
  const solo = new SimulationEngine(cfg);
  solo.configureScenario({ ...sc.configureOptions, runShifts: 5 });
  while (solo.orders.rows.length < 5) solo._tick();
  assert.deepEqual(rows(c.a), rows(solo));
});

test('a combined selection builds B with both countermeasures', () => {
  const adv = { scenarioId: 'demand-swing', shifts: 3, label: 'x', source: 'manual',
    selection: [{ id: 'outsourcing', params: { maxSetsPerShift: 10 } }, { id: 'improve-machine', params: { minutesSaved: 2 } }] };
  const { b } = buildEngines(adv);
  assert.equal(b.getConfig().outsourcing.maxSetsPerShift, 10);
  assert.equal(b.machines.find(m => m.id === 'M3').cycleTime, 11);
});

test('the old ids still work for one release', () => {
  const { b } = buildEngines({ scenarioId: 'demand-swing', shifts: 3, label: 'x', selection: [{ id: 'faster-m3', params: { minutesSaved: 2 } }] });
  assert.equal(b.machines.find(m => m.id === 'M3').cycleTime, 11);
});

test('outsourcing and the backup supplier reach engine B, and the shift rows carry the outsourced sets', () => {
  const c = new CompareRunner({ scenarioId: 'supplier-outage', shifts: 20, label: 'x', selection: [{ id: 'extra-supplier', params: {} }] });
  c.runToEnd();
  assert.ok(c.b.backupParts > 0);
  assert.equal(c.a.backupParts, 0);
  const o = new CompareRunner(advice('outsourcing'));
  o.runToEnd();
  assert.ok(o.b.orders.rows.some(r => r.outsourced > 0));
  assert.ok(o.a.orders.rows.every(r => !r.outsourced));
});
