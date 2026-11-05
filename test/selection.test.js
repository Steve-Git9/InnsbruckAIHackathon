// Manual selection: one or several countermeasures at once, and their investment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCountermeasure, resolveSelection } from '../src/countermeasures/catalog.js';
import { oneTimeCosts, computeEconomics } from '../src/economics/costs.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { loadRateCard } from '../src/data/loaders.js';
import { buildUiScenario, normaliseShifts } from '../src/ui/scenarios.js';
import { reconfiguresEngine } from '../src/ui/session-rules.js';
import { buildEngines } from '../src/ui/compare-runner.js';

const D = 'demand-swing';
const rate = loadRateCard();
const sel = (...ids) => ids.map(id => ({ id, params: {} }));

const IDS = ['improve-machine', 'new-line', 'extra-supplier', 'outsourcing', 'raw-stock', 'finished-stock'];

test('a one-item selection gives exactly the override of resolveCountermeasure', () => {
  for (const id of IDS) {
    const one = resolveCountermeasure(id, {}, D).override;
    const r = resolveSelection(sel(id), D);
    assert.deepEqual(r.override, one, id);
    assert.equal(r.items.length, 1);
  }
  const p = { minutesSaved: 1 };
  assert.deepEqual(resolveSelection([{ id: 'improve-machine', params: p }], D).override, resolveCountermeasure('improve-machine', p, D).override);
});

test('improve a machine + new line: M3 and M3b both faster, release interval is the minimum', () => {
  const r = resolveSelection([{ id: 'improve-machine', params: { minutesSaved: 2 } }, { id: 'new-line', params: { releaseInterval: 8 } }], D);
  const m = Object.fromEntries(r.override.config.machines.map(x => [x.id, x.cycleTime]));
  assert.equal(m.M3, 11);
  assert.equal(m.M3b, 11);
  assert.equal(r.override.config.source.interval, 8);       // min(9, 8)
  assert.equal(r.override.config.source.materialStock, -1);
  assert.equal(r.label, 'Improve a machine (faster M3) + New assembly line (second M3)');
  // the order of the selection does not matter
  const rev = resolveSelection([{ id: 'new-line', params: { releaseInterval: 8 } }, { id: 'improve-machine', params: { minutesSaved: 2 } }], D);
  assert.deepEqual(rev.override, r.override);
  // interval is the smaller of the two, also the other way round
  const slow = resolveSelection([{ id: 'improve-machine', params: { minutesSaved: 1 } }, { id: 'new-line', params: { releaseInterval: 11 } }], D);
  assert.equal(slow.override.config.source.interval, 10);
});

test('the old ids faster-m3 / second-m3 resolve to improve-machine / new-line', () => {
  const old = resolveSelection([{ id: 'faster-m3', params: { minutesSaved: 2 } }, { id: 'second-m3', params: {} }], D);
  const now = resolveSelection([{ id: 'improve-machine', params: { minutesSaved: 2 } }, { id: 'new-line', params: {} }], D);
  assert.deepEqual(old.override, now.override);
  assert.deepEqual(old.items.map(i => i.cm.id), ['improve-machine', 'new-line']);
  assert.throws(() => resolveSelection(sel('faster-m3', 'improve-machine'), D), /twice/);
});

test('raw stock + additional supplier: inventory mode with the second supplier enabled, no jit backup rule', () => {
  const r = resolveSelection([{ id: 'raw-stock', params: { stockLevel: 300 } }, { id: 'extra-supplier', params: {} }], D);
  assert.equal(r.override.config.supply.mode, 'inventory');
  assert.equal(r.override.config.supply.secondSupplier.enabled, true);
  assert.equal(r.override.config.supply.initialStock, 300);
  assert.equal(r.override.config.supply.reorderPoint, 200);
  assert.equal(r.override.config.source?.backupSupplier, undefined);
  // alone: the jit backup rule with the numbers of the second supplier
  const alone = resolveSelection(sel('extra-supplier'), D).override.config;
  assert.deepEqual(alone.source.backupSupplier, { enabled: true, leadTime: 240, premium: 0.08, qualification: 2000 });
  assert.equal(alone.supply, undefined);
  // raw stock alone: the default 250 is the SAFETY_STOCK of the scenario sweep
  assert.deepEqual(resolveSelection(sel('raw-stock'), D).override.config.supply, { mode: 'inventory', reorderPoint: 150, orderQty: 150, initialStock: 250 });
});

test('outsourcing and finished stock are independent and merge as they are', () => {
  const r = resolveSelection([{ id: 'outsourcing', params: { maxSetsPerShift: 20 } }, { id: 'finished-stock', params: { sets: 30 } }, { id: 'extra-supplier', params: {} }], D);
  assert.deepEqual(r.override.config.outsourcing, { enabled: true, maxSetsPerShift: 20, pricePerSet: 150, leadShifts: 1 });
  assert.equal(r.override.initialFinishedGoods, 30);
  assert.equal(r.override.config.source.backupSupplier.enabled, true);
  assert.equal(r.items.length, 3);
});

test('improve a machine + additional supplier keeps the faster release interval', () => {
  const r = resolveSelection([{ id: 'improve-machine', params: { minutesSaved: 2 } }, { id: 'extra-supplier', params: {} }], D);
  assert.equal(r.override.config.source.interval, 9);
  assert.equal(r.override.config.source.backupSupplier.enabled, true);
});

test('bad selections are rejected', () => {
  assert.throws(() => resolveSelection('outsourcing', D), /list/);
  assert.throws(() => resolveSelection([], D), /at least one/);
  assert.throws(() => resolveSelection(sel('outsourcing', 'outsourcing'), D), /twice/);
  assert.throws(() => resolveSelection([...sel('outsourcing', 'raw-stock', 'finished-stock'), { id: 'new-line' }], D), /at most 3/);
  assert.throws(() => resolveSelection(sel('magic'), D), /unknown countermeasure/);
  assert.throws(() => resolveSelection(sel('overtime'), D), /unknown countermeasure "overtime"/);
  assert.throws(() => resolveSelection([{ id: 'outsourcing', params: { maxSetsPerShift: 7 } }], D), /outside|steps/);
  assert.throws(() => resolveSelection([{ id: 'outsourcing', params: { maxSetsPerShift: 12 } }], D), /steps/);
  assert.throws(() => resolveSelection([{ id: 'outsourcing', params: { colour: 1 } }], D), /no parameter/);
  assert.throws(() => resolveSelection(sel('outsourcing'), 'alien-invasion'), /unknown scenario/);
});

test('investment: improve a machine (2) + new line = 2 x 2 x 30,000 + 95,000; the other measures cost what the rate card says', () => {
  const total = (selection) => {
    const cfg = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), ...resolveSelection(selection, D).override.config };
    return Object.values(oneTimeCosts(cfg, DEFAULT_CONFIG, rate).items).reduce((a, v) => a + v, 0);
  };
  assert.equal(total([{ id: 'improve-machine', params: { minutesSaved: 2 } }, { id: 'new-line', params: {} }]), 2 * 2 * 30000 + 95000);
  assert.equal(total(sel('new-line')), 95000);
  assert.equal(total([{ id: 'improve-machine', params: { minutesSaved: 2 } }]), 2 * 30000);
  assert.equal(total(sel('extra-supplier')), 2000);
  assert.equal(total([{ id: 'raw-stock', params: {} }, { id: 'extra-supplier', params: {} }]), 2000);
  for (const id of ['outsourcing', 'raw-stock', 'finished-stock']) assert.equal(total(sel(id)), 0, id);
});

test('buildUiScenario(id, n): demand has n rows for all four ids; bad n throws, missing n = 20', () => {
  for (const id of ['standard', 'demand-swing', 'supplier-outage', 'machinery-breakdown']) {
    for (const n of [1, 5, 20, 60]) assert.equal(buildUiScenario(id, n).configureOptions.demand.length, n, `${id} ${n}`);
    assert.equal(buildUiScenario(id).configureOptions.demand.length, 20);
  }
  for (const bad of [0, 61, 2.5, -3, NaN, '7']) assert.throws(() => buildUiScenario('standard', bad), /whole number/, String(bad));
  assert.equal(normaliseShifts(undefined), 20);
  assert.equal(normaliseShifts(null), 20);
});

test('advanced controls that reconfigure the engine invalidate the CEO run; play, pause and speed do not', () => {
  for (const a of ['reset', 'resetToDefaults', 'loadPreset', 'loadPlantDefault', 'configureScenario', 'spawnMachine', 'removeMachine']) {
    assert.equal(reconfiguresEngine(a, {}), true, a);
  }
  for (const k of ['cycleTime', 'bufferCapacity', 'sourceInterval', 'materialStock', 'rejectRate', 'seed', 'outage', 'failures', 'supply', 'demand', 'initialFinishedGoods']) {
    assert.equal(reconfiguresEngine(undefined, { [k]: 1 }), true, k);
  }
  assert.equal(reconfiguresEngine('play', {}), false);
  assert.equal(reconfiguresEngine('pause', {}), false);
  assert.equal(reconfiguresEngine(undefined, { speed: 5 }), false);
  assert.equal(reconfiguresEngine('runScenario', { scenario: 'standard', speed: 10, shifts: 5 }), false);
});

test('a 5-shift run finishes with 5 rows', () => {
  const { a } = buildEngines({ scenarioId: 'standard', selection: sel('outsourcing'), shifts: 5 });
  assert.equal(a.getConfig().runShifts, 5);
  while (a.orders.rows.length < 5) a._tick();
  assert.equal(a.orders.rows.length, 5);
  assert.equal(a.plantTick, 2400);
});
