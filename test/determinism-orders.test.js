import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHeadless, readDemand } from '../src/headless/run.js';
import { SimulationEngine } from '../src/simulation/engine.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { OrderBook } from '../src/simulation/orders.js';
import { makeStream } from '../src/simulation/rng.js';

const demand = readDemand('demand_profile.csv');
const OUTAGE = { startTick: 4800, endTick: 5760 };
const KEYS = ['shift', 'produced', 'scrap', 'orders', 'shipped', 'shippedOnTime', 'backlog', 'stock', 'wip'];
const pick = (rows) => rows.map(r => Object.fromEntries(KEYS.map(k => [k, r[k]])));

function runTicks(cfg, ticks) {
  const e = new SimulationEngine({ ...DEFAULT_CONFIG, ...cfg, source: { ...DEFAULT_CONFIG.source, materialStock: -1, ...(cfg.source ?? {}) } });
  for (let i = 0; i < ticks; i++) e._tick();
  return e;
}

test('rng: named streams are reproducible and independent of each other', () => {
  const a = makeStream(1, 'reject:M2'), b = makeStream(1, 'reject:M2'), c = makeStream(1, 'fail:M3:PWF');
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  assert.deepEqual(xs, ys);
  assert.notEqual(xs[0], c());
  assert.notEqual(xs[0], makeStream(2, 'reject:M2')());
});

test('same seed gives an identical history; different seeds differ; seed 0 is valid', () => {
  const h1 = runTicks({ seed: 1 }, 2000).getHistory();
  const h2 = runTicks({ seed: 1 }, 2000).getHistory();
  assert.deepEqual(h1, h2);
  const h3 = runTicks({ seed: 2 }, 2000).getHistory();
  assert.notDeepEqual(h1[h1.length - 1], h3[h3.length - 1]);
  const z1 = runTicks({ seed: 0 }, 2000).getHistory();
  const z2 = runTicks({ seed: 0 }, 2000).getHistory();
  assert.deepEqual(z1, z2);
  assert.notDeepEqual(z1[z1.length - 1], h1[h1.length - 1], 'seed 0 is not swallowed by a falsy check');
});

test('engine outage: source is frozen exactly for startTick < tick <= endTick', () => {
  const e = runTicks({ source: { interval: 11, outage: OUTAGE }, seed: 1 }, 6000);
  const h = e.getHistory();
  assert.equal(h[OUTAGE.startTick - 1].sourceTotalGenerated, h[OUTAGE.endTick - 1].sourceTotalGenerated);
  assert.ok(h[OUTAGE.endTick + 20].sourceTotalGenerated > h[OUTAGE.endTick - 1].sourceTotalGenerated);
});

for (const seed of [1, 2]) {
  test(`helper outage == engine outage, per-shift rows (seed ${seed})`, async () => {
    const ref = await runHeadless({ seed, shifts: 20, demand, outage: OUTAGE });
    const nat = await runHeadless({ seed, shifts: 20, demand, outage: OUTAGE, native: true });
    assert.deepEqual(pick(nat.perShift), pick(ref.perShift));
    assert.equal(nat.kpis.serviceLevel, ref.kpis.serviceLevel);
    assert.equal(nat.kpis.goodParts, ref.kpis.goodParts);
  });

  test(`helper order rows == engine OrderBook rows, no outage (seed ${seed})`, async () => {
    const ref = await runHeadless({ seed, shifts: 20, demand, initialFinishedGoods: 25 });
    const nat = await runHeadless({ seed, shifts: 20, demand, initialFinishedGoods: 25, native: true });
    assert.deepEqual(pick(nat.perShift), pick(ref.perShift));
    assert.equal(nat.kpis.backlogEnd, ref.kpis.backlogEnd);
  });
}

test('native outage via cfg.source.outage equals the outage option', async () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.source.outage = OUTAGE;
  const a = await runHeadless({ config: cfg, seed: 3, shifts: 20, demand, native: true });
  const b = await runHeadless({ seed: 3, shifts: 20, demand, outage: OUTAGE, native: true });
  assert.deepEqual(pick(a.perShift), pick(b.perShift));
});

test('OrderBook: FIFO, backlog served first, lost sales counted once', () => {
  const ob = new OrderBook({ demand: [10, 10, 10], ticksPerShift: 4 });
  ob.receive(6);                       // 6 in stock
  assert.equal(ob.closeTick(3), null);
  let r = ob.closeTick(4);             // shift 1: 10 ordered, 6 shipped
  assert.deepEqual([r.shipped, r.shippedOnTime, r.backlog, r.lostSales], [6, 6, 4, 4]);
  ob.receive(12);
  r = ob.closeTick(8);                 // shift 2: backlog 4 first (late), then 8 of the new 10
  assert.deepEqual([r.shipped, r.shippedOnTime, r.backlog, r.stock], [12, 8, 2, 0]);
  const s = ob.summary();
  assert.equal(s.ordered, 20);
  assert.equal(s.shippedOnTime, 14);
  assert.equal(s.lostSales, 6);
});
