import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHeadless } from '../src/headless/run.js';
import { summariseEvents, bottleneckLoss } from '../src/analysis/analysis.js';
import { calculateMetrics } from '../src/metrics/collector.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { loadDemand } from '../src/data/loaders.js';

const demand = loadDemand();
const OUT = { startTick: 4800, endTick: 5760 };
const clone = (o) => JSON.parse(JSON.stringify(o));

test('summariseEvents condenses the noisy log per machine and shift', async () => {
  const cfg = { ...clone(DEFAULT_CONFIG), failures: { enabled: true } };
  const r = await runHeadless({ config: cfg, seed: 1, shifts: 20, demand, outage: OUT, native: true });
  const s = summariseEvents(r.events);
  assert.ok(s.perMachineShift.length > 0 && s.perMachineShift.length < r.events.length);
  assert.deepEqual(s.outage, OUT);
  assert.equal(s.shortfalls.length, r.events.filter(e => e.type === 'shortfall').length);
  const breakdowns = r.events.filter(e => e.type === 'breakdown');
  assert.equal(Object.values(s.perMachine).reduce((a, m) => a + m.breakdowns, 0), breakdowns.length);
  assert.ok(s.perMachine.M3.downTicks > 0);
});

test('bottleneckLoss: M3 minutes add up and the outage shows up as starvation from the outage', async () => {
  const r = await runHeadless({ seed: 1, shifts: 20, demand, outage: OUT, native: true });
  const hist = r.engine.getHistory();
  const loss = bottleneckLoss(hist, { outage: OUT, config: DEFAULT_CONFIG });
  assert.deepEqual(loss.machines, ['M3']);
  assert.equal(loss.scheduled, 20 * 480);
  assert.equal(Object.values(loss.total).reduce((a, v) => a + v, 0), 20 * 480);
  assert.equal(loss.total.processing, r.engine.machines.find(m => m.id === 'M3').ticksProcessing);
  assert.ok(loss.total.starvedOutage > 100, `outage starvation ${loss.total.starvedOutage}`);
  assert.equal(loss.total.down, 0);
  assert.equal(loss.perShift.length, 20);
  assert.ok(loss.perShift[10].starvedOutage > 0 && loss.perShift[2].starvedOutage === 0);
});

test('bottleneckLoss: breakdowns are attributed to down time', async () => {
  const cfg = { ...clone(DEFAULT_CONFIG), failures: { enabled: true } };
  const r = await runHeadless({ config: cfg, seed: 1, shifts: 20, demand, native: true });
  const loss = bottleneckLoss(r.engine.getHistory(), { config: cfg });
  assert.equal(loss.total.down, r.engine.machines.find(m => m.id === 'M3').ticksDown);
  assert.ok(loss.lossShare.down > 0.3, 'most M3 minutes lost are breakdowns');
});

test('collector: a DOWN bottleneck is still the constraint, not a victim', async () => {
  const cfg = { ...clone(DEFAULT_CONFIG), failures: { enabled: true } };
  const r = await runHeadless({ config: cfg, seed: 1, shifts: 3, demand, native: true });
  const state = r.engine.getState();
  const m3 = state.machines.find(m => m.id === 'M3');
  const bumped = { ...state, machines: state.machines.map(m => m.id === 'M3'
    ? { ...m, winProcessing: 100, winDown: 200, winBlocked: 0, winStarved: 0, winIdle: 0, state: 'DOWN' } : m) };
  const metrics = calculateMetrics(bumped);
  const mm = metrics.machines.find(m => m.id === 'M3');
  assert.ok(m3);
  assert.equal(mm.bottleneck, true);
  assert.ok(Math.abs(mm.downRatio - 2 / 3) < 1e-9);
});
