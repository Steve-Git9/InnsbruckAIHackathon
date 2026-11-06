// The seed of the Simulate bar: validation, same seed = same run, another seed = another week,
// and the side-by-side comparison replays the seed of the CEO's run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUiScenario, normaliseUiSeed, DEFAULT_SEED } from '../src/ui/scenarios.js';
import { buildEngines } from '../src/ui/compare-runner.js';
import { SimulationEngine } from '../src/simulation/engine.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';

function runOf(id, shifts, seed) {
  const sc = buildUiScenario(id, shifts, seed);
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.source.materialStock = -1;
  const e = new SimulationEngine(cfg);
  e.configureScenario(sc.configureOptions);
  while (e.orders.rows.length < shifts) e._tick();
  return e.orders.rows.map(r => [r.produced, r.shippedOnTime, r.backlog]);
}

test('seed: default 1, whole numbers 0..99999, anything else is an error', () => {
  assert.equal(normaliseUiSeed(undefined), DEFAULT_SEED);
  assert.equal(normaliseUiSeed(null), 1);
  assert.equal(normaliseUiSeed(0), 0);
  assert.equal(normaliseUiSeed(99999), 99999);
  for (const bad of [-1, 1.5, 100000, NaN]) assert.throws(() => normaliseUiSeed(bad), /seed/);
  assert.equal(buildUiScenario('standard', 5, 42).configureOptions.seed, 42);
  assert.equal(buildUiScenario('standard', 5).seed, 1);
});

test('same seed gives the same run; another seed another week', () => {
  assert.deepEqual(runOf('machinery-breakdown', 4, 7), runOf('machinery-breakdown', 4, 7));
  assert.notDeepEqual(runOf('machinery-breakdown', 4, 1), runOf('machinery-breakdown', 4, 7));
});

test('the comparison uses the seed of the run', () => {
  const { a, b } = buildEngines({ scenarioId: 'standard', selection: [{ id: 'finished-stock', params: {} }], shifts: 2, seed: 7 });
  assert.equal(a.streams.seed, 7);
  assert.equal(b.streams.seed, 7);
  assert.equal(buildEngines({ scenarioId: 'standard', selection: [{ id: 'finished-stock', params: {} }], shifts: 2 }).a.streams.seed, 1);
});
