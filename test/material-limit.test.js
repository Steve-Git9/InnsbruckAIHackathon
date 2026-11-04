// Regression tests for the "run stops before the outage" bug: the starter's 200-part
// material limit must not cut realism scenarios short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../src/simulation/engine.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { calculateMetrics } from '../src/metrics/collector.js';

const OUT = { startTick: 4800, endTick: 5760 };
const run = (e, ticks) => { for (let i = 0; i < ticks; i++) e._tick(); };

test('outage-only scenario on the default config runs past the outage (material set to unlimited)', () => {
  const e = new SimulationEngine(DEFAULT_CONFIG);
  e.configureScenario({ seed: 1, outage: OUT });
  assert.equal(e.getState().source.materialStock, -1);
  run(e, 6200);
  assert.ok(e.source.totalGenerated > 200, `released ${e.source.totalGenerated}`);
  // the source is halted inside the window and releases again after it
  const hist = e.getHistory();
  const at = (t) => hist.find(r => r.tick === t).sourceTotalGenerated;
  assert.equal(at(OUT.endTick), at(OUT.startTick + 1));
  assert.ok(at(6200) > at(OUT.endTick));
});

test('breakdowns-only scenario also gets unlimited material', () => {
  const e = new SimulationEngine(DEFAULT_CONFIG);
  e.configureScenario({ failures: { enabled: true } });
  assert.equal(e.getState().source.materialStock, -1);
});

test('no realism option keeps the starter material limit (teaching behaviour unchanged)', () => {
  const e = new SimulationEngine(DEFAULT_CONFIG);
  e.configureScenario({ seed: 2 });
  assert.equal(e.getState().source.materialStock, 200);
});

test('inventory supply replaces the material limit: not capped at 200 releases', () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));   // materialStock 200 on purpose
  cfg.supply = { mode: 'inventory' };
  cfg.seed = 1;
  const e = new SimulationEngine(cfg);
  run(e, 4000);
  assert.ok(e.source.totalGenerated > 250, `released ${e.source.totalGenerated}`);
});

test('banner: depleted material and active outage get their own notes, not "increase the feed"', () => {
  const depleted = new SimulationEngine(DEFAULT_CONFIG);     // 200 parts, no realism
  run(depleted, 2600);
  const m1 = calculateMetrics(depleted.getState());
  assert.equal(m1.suggestions[0]?.type, 'material-depleted');

  const e = new SimulationEngine(DEFAULT_CONFIG);
  e.configureScenario({ seed: 1, outage: OUT });
  run(e, 5300);
  const m2 = calculateMetrics(e.getState());
  assert.equal(m2.suggestions.length, 1);
  assert.equal(m2.suggestions[0].type, 'supplier-outage');
});
