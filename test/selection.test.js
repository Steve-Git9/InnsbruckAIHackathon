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

test('a one-item selection gives exactly the override of resolveCountermeasure', () => {
  for (const id of ['overtime', 'faster-m3', 'second-m3']) {
    const one = resolveCountermeasure(id, {}, D).override;
    const r = resolveSelection(sel(id), D);
    assert.deepEqual(r.override, one, id);
    assert.equal(r.items.length, 1);
  }
  const p = { minutesSaved: 1 };
  assert.deepEqual(resolveSelection([{ id: 'faster-m3', params: p }], D).override, resolveCountermeasure('faster-m3', p, D).override);
});

test('faster M3 + second M3: M3 and M3b both faster, release interval is the minimum', () => {
  const r = resolveSelection([{ id: 'faster-m3', params: { minutesSaved: 2 } }, { id: 'second-m3', params: { releaseInterval: 8 } }], D);
  const m = Object.fromEntries(r.override.config.machines.map(x => [x.id, x.cycleTime]));
  assert.equal(m.M3, 11);
  assert.equal(m.M3b, 11);
  assert.equal(r.override.config.source.interval, 8);       // min(9, 8)
  assert.equal(r.override.config.source.materialStock, -1);
  assert.equal(r.label, 'Faster M3 (assembly) + Second M3 (parallel assembly machine)');
  // the order of the selection does not matter
  const rev = resolveSelection([{ id: 'second-m3', params: { releaseInterval: 8 } }, { id: 'faster-m3', params: { minutesSaved: 2 } }], D);
  assert.deepEqual(rev.override, r.override);
  // interval is the smaller of the two, also the other way round
  const slow = resolveSelection([{ id: 'faster-m3', params: { minutesSaved: 1 } }, { id: 'second-m3', params: { releaseInterval: 11 } }], D);
  assert.equal(slow.override.config.source.interval, 10);
});

test('overtime + faster M3 has both', () => {
  const r = resolveSelection([{ id: 'overtime', params: { maxMinutesPerShift: 60 } }, { id: 'faster-m3', params: {} }], D);
  assert.deepEqual(r.override.config.overtime, { enabled: true, maxMinutesPerShift: 60 });
  assert.equal(r.override.config.machines.find(x => x.id === 'M3').cycleTime, 11);
  assert.equal(r.override.config.machines.length, 4);
});

test('all three together', () => {
  const r = resolveSelection(sel('overtime', 'faster-m3', 'second-m3'), D);
  assert.ok(r.override.config.overtime.enabled);
  assert.equal(r.override.config.machines.length, 5);
  assert.equal(r.items.length, 3);
});

test('bad selections are rejected', () => {
  assert.throws(() => resolveSelection('overtime', D), /list/);
  assert.throws(() => resolveSelection([], D), /at least one/);
  assert.throws(() => resolveSelection(sel('overtime', 'overtime'), D), /twice/);
  assert.throws(() => resolveSelection([...sel('overtime', 'faster-m3', 'second-m3'), { id: 'overtime' }], D), /at most 3/);
  assert.throws(() => resolveSelection(sel('magic'), D), /unknown countermeasure/);
  assert.throws(() => resolveSelection([{ id: 'overtime', params: { maxMinutesPerShift: 7 } }], D), /outside/);
  assert.throws(() => resolveSelection([{ id: 'overtime', params: { maxMinutesPerShift: 100 } }], D), /steps/);
  assert.throws(() => resolveSelection([{ id: 'overtime', params: { colour: 1 } }], D), /no parameter/);
  assert.throws(() => resolveSelection(sel('overtime'), 'standard'), /not offered/);
});

test('investment: faster M3 (2) + second M3 = 2 x 2 x 30,000 + 95,000; a plain second M3 stays 95,000', () => {
  const total = (selection) => {
    const cfg = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), ...resolveSelection(selection, D).override.config };
    return Object.values(oneTimeCosts(cfg, DEFAULT_CONFIG, rate).items).reduce((a, v) => a + v, 0);
  };
  assert.equal(total([{ id: 'faster-m3', params: { minutesSaved: 2 } }, { id: 'second-m3', params: {} }]), 2 * 2 * 30000 + 95000);
  assert.equal(total(sel('second-m3')), 95000);
  assert.equal(total([{ id: 'faster-m3', params: { minutesSaved: 2 } }]), 2 * 30000);
  assert.equal(total(sel('overtime')), 0);
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
  const { a } = buildEngines({ scenarioId: 'standard', selection: sel('overtime'), shifts: 5 });
  assert.equal(a.getConfig().runShifts, 5);
  while (a.orders.rows.length < 5) a._tick();
  assert.equal(a.orders.rows.length, 5);
  assert.equal(a.plantTick, 2400);
});
