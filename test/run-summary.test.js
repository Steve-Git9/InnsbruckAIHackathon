// CEO interface: the run summary built from an engine after 20 shifts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUiScenario } from '../src/ui/scenarios.js';
import { buildRunSummary } from '../src/ui/run-summary.js';
import { SimulationEngine } from '../src/simulation/engine.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { loadRateCard } from '../src/data/loaders.js';

const rate = loadRateCard();

function runScenario(id) {
  const sc = buildUiScenario(id);
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.source.materialStock = -1;
  const e = new SimulationEngine(cfg);
  e.configureScenario(sc.configureOptions);
  while (e.orders.rows.length < 20) e._tick();
  return { e, sc, s: buildRunSummary(e, sc, rate) };
}

test('demand swing summary', () => {
  const { e, s } = runScenario('demand-swing');
  assert.deepEqual(s.scenario, { id: 'demand-swing', label: 'Demand swing' });
  assert.equal(s.shifts, 20);
  assert.equal(s.perShift.length, 20);
  for (const k of ['ordered', 'shippedOnTime', 'serviceLevel', 'late', 'backlogEnd']) assert.ok(k in s.orders, k);
  for (const k of ['goodParts', 'goodPerShift', 'scrap', 'released', 'lineYield']) assert.ok(k in s.production, k);
  for (const k of ['profit', 'costPerGoodUnit', 'revenue', 'lostSalesPenalty']) assert.ok(Number.isFinite(s.money[k]), k);
  assert.equal(s.orders.late, s.orders.ordered - s.orders.shippedOnTime);
  const book = e.orders.summary();
  assert.equal(s.orders.serviceLevel, book.shippedOnTime / book.ordered);
  assert.equal(s.orders.backlogEnd, book.backlog);

  // worst shift = largest shortfall
  const shortfalls = s.perShift.map(r => r.orders - r.shippedOnTime);
  const max = Math.max(...shortfalls);
  assert.ok(max > 0, 'demand swing misses orders');
  assert.equal(s.worstShift.short, max);
  assert.equal(s.perShift[s.worstShift.shift - 1].orders - s.perShift[s.worstShift.shift - 1].shippedOnTime, max);

  assert.equal(s.bottleneck.machine, 'M3');
  assert.ok(s.bottleneck.utilisation > 0.5 && s.bottleneck.utilisation <= 1);
  assert.equal(typeof s.bottleneck.mainCause, 'string');
  assert.equal(s.disruption.peakOrders, Math.max(...s.perShift.map(r => r.orders)));
  assert.equal(s.disruption.minOrders, Math.min(...s.perShift.map(r => r.orders)));
});

test('supplier outage summary has the outage window', () => {
  const { s } = runScenario('supplier-outage');
  assert.equal(s.disruption.window, 'shifts 11–12');
  assert.equal(s.disruption.sourceHaltedMinutes, 960);
  assert.ok(s.disruption.bottleneckStarvedByOutageMinutes > 0);
  assert.ok(s.orders.serviceLevel < 1);
  assert.equal(s.bottleneck.mainCause, 'the supplier outage');
});

test('standard has no disruption and almost no missed orders', () => {
  const { s } = runScenario('standard');
  assert.equal(s.disruption, null);
  assert.ok(s.orders.serviceLevel >= 0.95);
  assert.ok(!s.worstShift || s.worstShift.shift === 1, 'only the start-up shift can miss');
});

test('machinery breakdown summary counts the breakdowns', () => {
  const { e, s } = runScenario('machinery-breakdown');
  assert.equal(s.disruption.count, e.events.filter(x => x.type === 'breakdown').length);
  assert.ok(s.disruption.count > 0);
  assert.ok('M3' in s.disruption.availabilityByMachine);
});
