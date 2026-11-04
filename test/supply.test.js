import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHeadless } from '../src/headless/run.js';
import { SimulationEngine } from '../src/simulation/engine.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { Supply } from '../src/simulation/supply.js';
import { computeEconomics } from '../src/economics/costs.js';
import { loadRateCard } from '../src/data/loaders.js';

const rate = loadRateCard();
const flat = Array(60).fill(34);
const OUT = { startTick: 4800, endTick: 5760 };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const withSupply = (supply) => ({ ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), supply });

function engineFor(supply, ticks, outage = OUT) {
  const cfg = withSupply(supply);
  cfg.source.materialStock = -1;
  if (outage) cfg.source.outage = outage;
  cfg.seed = 1;
  const e = new SimulationEngine(cfg);
  for (let i = 0; i < ticks; i++) e._tick();
  return e;
}

test("mode 'jit' equals the reference (explicit jit config, same history as none)", () => {
  const a = engineFor(undefined, 7000), b = engineFor({ mode: 'jit' }, 7000);
  assert.deepEqual(b.getHistory(), a.getHistory());
  assert.equal(b.supply, null);
});

test('invariant: delivered = released + change in raw stock (initial stock counted as delivered)', () => {
  for (const supply of [
    { mode: 'inventory' },
    { mode: 'inventory', secondSupplier: { enabled: true } },
    { mode: 'inventory', expediting: { enabled: true }, initialStock: 20 },
  ]) {
    const e = engineFor(supply, 9600);
    const s = e.supply;
    assert.equal(s.delivered, s.released + s.stock, JSON.stringify(supply));
    assert.equal(s.released, e.source.totalGenerated);
    assert.equal(s.stock >= 0, true);
  }
});

test('outage hits the supplier in inventory mode: no primary delivery inside the window, late ones arrive after it', () => {
  const e = engineFor({ mode: 'inventory' }, 9600);
  for (const o of e.supply.orders.filter(o => o.kind === 'primary')) {
    assert.ok(!(o.arrive > OUT.startTick && o.arrive <= OUT.endTick), `order at ${o.tick} arrives ${o.arrive} inside the outage`);
  }
  const late = e.supply.orders.find(o => o.tick < OUT.startTick && o.tick + 480 > OUT.startTick);
  assert.equal(late?.arrive, OUT.endTick + 1);
});

test('a large safety stock covers the outage and the service level recovers', async () => {
  const sl = async (supply) => mean(await Promise.all([1, 2, 3, 4, 5].map(async seed => {
    const r = await runHeadless({ config: withSupply(supply), seed, shifts: 20, demand: flat, outage: OUT, native: true });
    return r.kpis.serviceLevel;
  })));
  const jit = await sl(undefined);
  const covered = await sl({ mode: 'inventory', reorderPoint: 150, orderQty: 150, initialStock: 250 });
  assert.ok(jit < 0.84, `jit with outage ${jit}`);
  assert.ok(covered > 0.98, `safety stock ${covered}`);
});

test('second supplier and expediting avoid stock-outs, at a price premium', () => {
  const base = engineFor({ mode: 'inventory' }, 9600).supply;
  const second = engineFor({ mode: 'inventory', secondSupplier: { enabled: true } }, 9600).supply;
  const exped = engineFor({ mode: 'inventory', expediting: { enabled: true } }, 9600).supply;
  assert.ok(base.stockoutTicks > 0);
  assert.ok(second.stockoutTicks < base.stockoutTicks);
  assert.ok(exped.stockoutTicks < base.stockoutTicks);
  assert.ok(second.orders.some(o => o.kind === 'second' && Math.abs(o.mult - 1.08) < 1e-9));
  assert.ok(exped.orders.some(o => o.kind === 'expedite' && Math.abs(o.mult - 1.4) < 1e-9));
});

test('economics: lots carry their price; second supplier adds qualification cost and premium', async () => {
  const cfg = withSupply({ mode: 'inventory', secondSupplier: { enabled: true } });
  const r = await runHeadless({ config: cfg, seed: 1, shifts: 20, demand: flat, outage: OUT, native: true });
  const e = computeEconomics(r, cfg, DEFAULT_CONFIG, rate);
  assert.ok(e.materialCost > r.kpis.released * 38, 'premium lots are priced above 38');
  assert.ok(e.materialCost <= r.kpis.released * 38 * 1.08 + 1e-6);
  assert.ok(Math.abs(e.amortised - 2000 * 20 / 1920) < 1e-6);
  assert.ok(e.holdingRaw > 0);
});

test('Supply unit: (s,Q) reorder, FIFO lots, stock-out returns null', () => {
  const s = new Supply({ mode: 'inventory', initialStock: 2, reorderPoint: 1, orderQty: 5, leadTime: 3 });
  s.step(1);
  assert.equal(s.consume(), 1);
  s.step(2);                                      // stock 1 <= s: orders 5, arrives at 5
  assert.equal(s.orders.length, 1);
  assert.equal(s.consume(), 1);
  s.step(3);
  assert.equal(s.consume(), null);
  assert.equal(s.stockoutTicks, 1);
  s.step(5);
  assert.equal(s.stock, 5);
});
