import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHeadless } from '../src/headless/run.js';
import { computeEconomics, oneTimeCosts } from '../src/economics/costs.js';
import { loadRateCard, loadDemand, loadFailureRates } from '../src/data/loaders.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { SimulationEngine } from '../src/simulation/engine.js';
import { expectedDowntimePerPart, DEFAULT_FAILURE_MODES } from '../src/simulation/failures.js';

const rate = loadRateCard();
const demand = loadDemand();
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const clone = (o) => JSON.parse(JSON.stringify(o));

test('loaders: rate card, demand and failure modes match the CSV files', () => {
  assert.equal(rate.material_cost_per_part, 38);
  assert.equal(rate.machine_hour_rate_M3, 90);
  assert.equal(demand.length, 60);
  const modes = loadFailureRates();
  assert.deepEqual(modes.map(m => [m.mode, m.probability, m.repairTicks]),
    DEFAULT_FAILURE_MODES.map(m => [m.mode, m.probability, m.repairTicks]));
});

test('calibration: default line, 20 shifts, empty stock = about EUR 102.8 per good unit', async () => {
  const costs = [];
  for (let seed = 1; seed <= 10; seed++) {
    const r = await runHeadless({ seed, shifts: 20, demand, native: true });
    costs.push(computeEconomics(r, DEFAULT_CONFIG, DEFAULT_CONFIG, rate).costPerGoodUnit);
  }
  const m = mean(costs);
  assert.ok(Math.abs(m - 102.8) <= 1, `cost per good unit ${m.toFixed(2)}`);
});

test('economics: profit identity and per-shift sums', async () => {
  const r = await runHeadless({ seed: 1, shifts: 20, demand, native: true, initialFinishedGoods: 30 });
  const e = computeEconomics(r, { ...DEFAULT_CONFIG, initialFinishedGoods: 30 }, DEFAULT_CONFIG, rate);
  assert.equal(e.machineCost, 20 * 8 * (85 + 55 + 90 + 40));
  assert.equal(e.materialCost, r.kpis.released * 38);
  assert.equal(e.startValue, 30 * 103);
  const lost = (r.kpis.ordered - r.perShift.reduce((a, s) => a + s.shippedOnTime, 0)) * 90;
  assert.equal(e.lostSales, lost);
  const profit = e.revenue - e.machineCost - e.materialCost - e.holdingWip - e.holdingFg - e.holdingRaw - e.amortised
    - e.lostSales - e.startValue + e.endValue;
  assert.ok(Math.abs(profit - e.profit) < 1e-6);
});

test('one-time costs: extra machine, buffer slots, cycle time, reject rate (amortised over 1,920 shifts)', () => {
  const cfg = clone(DEFAULT_CONFIG);
  cfg.machines.push({ ...cfg.machines[2], id: 'M3b' });
  cfg.buffers[2].capacity += 2;
  cfg.machines[0].cycleTime -= 1;
  cfg.machines[1].rejectRate = 0.08;
  const ot = oneTimeCosts(cfg, DEFAULT_CONFIG, rate);
  assert.deepEqual(ot.counts, { extraMachines: 1, bufferSlots: 2, cycleTicks: 1, rejectPoints: ot.counts.rejectPoints, secondSupplier: 0 });
  assert.ok(Math.abs(ot.counts.rejectPoints - 2) < 1e-9);
  assert.equal(ot.items.extraMachines, 95000);
  assert.equal(ot.items.bufferSlots, 300);
  assert.equal(ot.items.cycleTime, 30000);
  assert.ok(Math.abs(ot.items.rejectRate - 16000) < 1e-6);
  assert.ok(Math.abs(95000 / 1920 - 49.48) < 0.01);
});

test('extra M3 costs its station hour rate for every scheduled hour (EUR 720 per shift)', async () => {
  const cfg = clone(DEFAULT_CONFIG);
  cfg.machines.push({ ...cfg.machines[2], id: 'M3b' });
  const r = await runHeadless({ config: cfg, seed: 1, shifts: 20, demand, native: true });
  const e = computeEconomics(r, cfg, DEFAULT_CONFIG, rate);
  assert.equal(e.machineCost, 20 * 8 * (85 + 55 + 90 + 90 + 40));
  assert.ok(Math.abs(e.amortised - 95000 * 20 / 1920) < 1e-6);
});

// ── Breakdowns ────────────────────────────────────────────────────────────

const failCfg = (extra = {}) => ({ ...clone(DEFAULT_CONFIG), failures: { enabled: true, ...extra } });

test('breakdowns off (or absent) leaves the history identical', () => {
  const run = (cfg) => {
    const e = new SimulationEngine({ ...cfg, seed: 4, source: { ...cfg.source, materialStock: -1 } });
    for (let i = 0; i < 3000; i++) e._tick();
    return e.getHistory();
  };
  const none = run(clone(DEFAULT_CONFIG));
  const off = run({ ...clone(DEFAULT_CONFIG), failures: { enabled: false } });
  assert.deepEqual(off, none);
});

test('breakdowns do not shift the reject draws (common random numbers)', () => {
  // M2 rejects are drawn from their own stream: the n-th M2 decision is the same with and without breakdowns
  const decisions = (cfg) => {
    const e = new SimulationEngine({ ...cfg, seed: 7, source: { ...cfg.source, materialStock: -1 } });
    const orig = e.streams.get.bind(e.streams);
    const draws = [];
    e.streams.get = (name) => { const f = orig(name); return name === 'reject:M2' ? () => { const v = f(); draws.push(v); return v; } : f; };
    for (let i = 0; i < 4000; i++) e._tick();
    return draws;
  };
  const a = decisions(clone(DEFAULT_CONFIG)), b = decisions(failCfg());
  const n = Math.min(a.length, b.length);
  assert.ok(n > 50);
  assert.deepEqual(a.slice(0, n), b.slice(0, n));
});

test('DOWN state: the machine holds its part for exactly the repair time', () => {
  const cfg = failCfg({ modes: [{ mode: 'X', stations: ['M3'], probability: 0.2, repairTicks: 25 }] });
  const e = new SimulationEngine({ ...cfg, seed: 3, source: { ...cfg.source, materialStock: -1 } });
  for (let i = 0; i < 3000; i++) e._tick();
  assert.ok(e.events.length > 0);
  const h = e.getHistory();
  for (const ev of e.events.slice(0, 5)) {
    const run = h.filter(r => r.tick >= ev.start && r.tick < ev.start + ev.repair);
    assert.ok(run.every(r => r.M3_state === 'DOWN'), 'down for the whole repair');
    assert.notEqual(h[ev.start + ev.repair - 1]?.M3_state, 'DOWN', 'back after repair');
  }
  assert.equal(e.machines.find(m => m.id === 'M3').ticksDown, h[h.length - 1].M3_ticksDown);
});

test('breakdowns: M3 availability and output match the analytical value', async () => {
  const d = expectedDowntimePerPart(failCfg().failures, 'M3');
  assert.ok(Math.abs(d - 0.9015) < 1e-9);
  const expectedDownShare = d / (13 + d);
  const avail = [], good = [];
  for (let seed = 1; seed <= 40; seed++) {
    const r = await runHeadless({ config: failCfg(), seed, shifts: 20, demand, native: true });
    avail.push(1 - r.kpis.machines.M3.oee.availability);
    good.push(r.kpis.goodPerShift);
  }
  assert.ok(Math.abs(mean(avail) - expectedDownShare) < 0.01, `down share ${mean(avail).toFixed(4)} vs ${expectedDownShare.toFixed(4)}`);
  const g = mean(good);
  assert.ok(g > 33.6 && g < 35.4, `good parts per shift ${g.toFixed(2)} (expected about 34.5)`);
});

test('OEE availability falls below 1 with breakdowns and quality uses the machine\'s own scrap', async () => {
  const r = await runHeadless({ config: failCfg(), seed: 2, shifts: 20, demand, native: true });
  assert.ok(r.kpis.machines.M3.oee.availability < 1);
  assert.ok(r.events.some(e => e.type === 'breakdown' && e.machine));
  const q = r.kpis.machines.M2.oee.quality;
  assert.ok(q < 1 && q > 0.8, `M2 quality ${q}`);
  // each machine has its own scrap counter (no hardcoded M2)
  const cfg = clone(DEFAULT_CONFIG);
  cfg.machines.push({ ...cfg.machines[1], id: 'M2b' });
  const e = new SimulationEngine({ ...cfg, seed: 2, source: { ...cfg.source, materialStock: -1 } });
  for (let i = 0; i < 9600; i++) e._tick();
  assert.equal(e.machines.reduce((a, m) => a + m.scrapped, 0), e.scrapSink.partsReceived);
  assert.equal(r.kpis.machines.M1.oee.quality, 1);
});

test('parallel machines inherit their station\'s failure modes', () => {
  const cfg = failCfg();
  cfg.machines.push({ ...cfg.machines[2], id: 'M3b' });
  const e = new SimulationEngine({ ...cfg, seed: 5, source: { ...cfg.source, materialStock: -1 } });
  for (let i = 0; i < 20000; i++) e._tick();
  assert.ok(e.events.some(ev => ev.machine === 'M3b'));
  assert.ok(!e.events.some(ev => ev.machine === 'M2' && ev.mode !== 'RNF'), 'M2 has only the random failure mode, not PWF/OSF');
});
