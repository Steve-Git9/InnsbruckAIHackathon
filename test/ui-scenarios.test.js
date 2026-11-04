// CEO interface: scenario definitions and the engine's optional auto-stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUiScenario, UI_SCENARIO_IDS } from '../src/ui/scenarios.js';
import { SimulationEngine } from '../src/simulation/engine.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { loadDemand } from '../src/data/loaders.js';

test('the four ids build the expected options', () => {
  assert.deepEqual(UI_SCENARIO_IDS, ['standard', 'demand-swing', 'supplier-outage', 'machinery-breakdown']);
  const std = buildUiScenario('standard');
  assert.equal(std.configureOptions.demand.length, 20);
  assert.ok(std.configureOptions.demand.every(d => d === 34));
  assert.equal(std.configureOptions.outage, null);
  assert.equal(std.configureOptions.failures, null);
  assert.equal(std.configureOptions.seed, 1);
  assert.equal(std.disruptionId, null);

  const swing = buildUiScenario('demand-swing');
  assert.deepEqual(swing.configureOptions.demand, loadDemand().slice(0, 20));
  assert.equal(swing.disruptionId, 'demand-swing');

  const out = buildUiScenario('supplier-outage');
  assert.deepEqual(out.configureOptions.outage, { startTick: 4800, endTick: 5760 });
  assert.equal(out.configureOptions.demand.length, 20);
  assert.ok(out.configureOptions.demand.every(d => d === 34));
  assert.equal(out.configureOptions.failures, null);

  const bd = buildUiScenario('machinery-breakdown');
  assert.equal(bd.configureOptions.failures.enabled, true);
  assert.equal(bd.configureOptions.outage, null);
  assert.ok(bd.configureOptions.demand.every(d => d === 34));
});

test('an unknown id throws', () => {
  assert.throws(() => buildUiScenario('nope'), /unknown scenario/);
  assert.throws(() => buildUiScenario('toString'), /unknown scenario/);
});

function engineFor(runShifts) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.source.materialStock = -1;
  const e = new SimulationEngine(cfg);
  e.configureScenario({ ...buildUiScenario('standard').configureOptions, runShifts });
  return e;
}

test('runShifts pauses the engine after N closed shifts and emits run-complete', () => {
  const e = engineFor(2);
  let completed = 0;
  e.on('run-complete', () => completed++);
  e._running = true;                       // pause() must be what stops it
  for (let i = 0; i < 480 * 2; i++) e._tick();
  assert.equal(e.orders.rows.length, 2);
  assert.equal(e._running, false);
  assert.equal(completed, 1);
});

test('without runShifts nothing pauses', () => {
  const e = engineFor(undefined);
  let completed = 0;
  e.on('run-complete', () => completed++);
  e._running = true;
  for (let i = 0; i < 480 * 3; i++) e._tick();
  assert.equal(e.orders.rows.length, 3);
  assert.equal(e._running, true);
  assert.equal(completed, 0);
});
