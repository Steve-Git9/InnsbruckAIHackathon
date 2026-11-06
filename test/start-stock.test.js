// ERP starting stock: raw-material safety stock at the source and finished sets at the start, used only
// when the CEO switches it on. Empty stock (the default) must leave every reference result unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { normaliseStart, baseVariant, variantWith, startKey, NO_START } from '../src/countermeasures/start-stock.js';
import { buildUiScenario } from '../src/ui/scenarios.js';
import { buildEngines } from '../src/ui/compare-runner.js';
import { SimulationEngine } from '../src/simulation/engine.js';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';
import { evaluateCountermeasure } from '../src/countermeasures/evaluate.js';

function run(id, start, shifts = 20) {
  const sc = buildUiScenario(id, shifts, 1, start);
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.source.materialStock = -1;
  const e = new SimulationEngine(cfg);
  e.configureScenario(sc.configureOptions);
  while (e.orders.rows.length < shifts) e._tick();
  const r = e.orders.rows;
  return { e, sl: r.reduce((a, x) => a + x.shippedOnTime, 0) / r.reduce((a, x) => a + x.orders, 0), rows: r.map(x => [x.produced, x.shippedOnTime]) };
}

test('normaliseStart: default empty, whole numbers in range, anything else is an error', () => {
  assert.deepEqual(normaliseStart(undefined), NO_START);
  assert.deepEqual(normaliseStart({ finished: '24', raw: 160 }), { finished: 24, raw: 160 });
  assert.deepEqual(normaliseStart({ finished: '', raw: undefined }), NO_START);
  for (const bad of [{ finished: -1 }, { raw: 1.5 }, { raw: 2001 }, { finished: 'x' }, [1, 2], 'abc']) {
    assert.throws(() => normaliseStart(bad), /start/);
  }
  assert.equal(startKey({ finished: 24, raw: 160 }), '24/160');
});

test('empty start leaves the reference run unchanged', () => {
  for (const id of ['standard', 'supplier-outage']) {
    assert.deepEqual(run(id, undefined).rows, run(id, { finished: 0, raw: 0 }).rows, id);
  }
  assert.equal(buildUiScenario('standard').configureOptions.rawSafetyStock, 0);
});

test('raw safety stock keeps the source running in the outage, then refills; unused without an outage', () => {
  const empty = run('supplier-outage', undefined);
  const withRaw = run('supplier-outage', { finished: 0, raw: 160 });
  assert.ok(withRaw.sl > empty.sl + 0.2, `${withRaw.sl} vs ${empty.sl}`);
  assert.ok(withRaw.e.rawFromStock > 0 && withRaw.e.rawFromStock <= 160);
  assert.equal(withRaw.e.rawOnHand, 160);                       // the supplier delivers again after the outage
  const st = withRaw.e.getState().source;
  assert.equal(st.rawSafetyLevel, 160);

  const small = run('supplier-outage', { finished: 0, raw: 10 });
  assert.equal(small.e.rawFromStock, 10);                       // used up, then the source stops as before
  assert.ok(small.sl > empty.sl && small.sl < withRaw.sl);

  const standard = run('standard', { finished: 0, raw: 160 });
  assert.equal(standard.e.rawFromStock, 0);
  assert.deepEqual(standard.rows, run('standard', undefined).rows);
});

test('finished sets at the start serve the first orders', () => {
  const r = run('demand-swing', { finished: 24, raw: 0 });
  assert.ok(r.sl > run('demand-swing', undefined).sl);
  assert.equal(r.e.getConfig().initialFinishedGoods, 24);
});

test('a countermeasure adds its stock on top of the starting stock; both sides get the start', () => {
  const start = { finished: 24, raw: 160 };
  assert.deepEqual(baseVariant({}, start), { config: { rawSafetyStock: 160 }, initialFinishedGoods: 24 });
  assert.deepEqual(variantWith({}, { initialFinishedGoods: 50 }, start), { config: { rawSafetyStock: 160 }, initialFinishedGoods: 74 });
  const inv = variantWith({}, { config: { supply: { mode: 'inventory', initialStock: 200, reorderPoint: 100 } } }, start);
  assert.equal(inv.config.supply.initialStock, 360);
  assert.equal(inv.config.rawSafetyStock, undefined);           // the inventory model replaces the safety stock
  assert.deepEqual(variantWith({}, { initialFinishedGoods: 50 }, NO_START), { config: {}, initialFinishedGoods: 50 });

  const { a, b } = buildEngines({ scenarioId: 'supplier-outage', selection: [{ id: 'finished-stock', params: { sets: 30 } }], shifts: 2, seed: 1, start });
  assert.equal(a.rawSafetyLevel, 160);
  assert.equal(b.rawSafetyLevel, 160);
  assert.equal(a.getConfig().initialFinishedGoods, 24);
  assert.equal(b.getConfig().initialFinishedGoods, 54);
});

test('evaluator: the starting stock changes the "without" side and is cached separately', async () => {
  const opts = { seeds: [1, 2], shifts: 20 };
  const empty = await evaluateCountermeasure('supplier-outage', 'outsourcing', {}, opts);
  const erp = await evaluateCountermeasure('supplier-outage', 'outsourcing', {}, { ...opts, start: { finished: 24, raw: 160 } });
  assert.ok(erp.without.serviceLevel > empty.without.serviceLevel + 0.2);
  assert.deepEqual(erp.start, { finished: 24, raw: 160 });
  const again = await evaluateCountermeasure('supplier-outage', 'outsourcing', {}, opts);
  assert.equal(again.without.serviceLevel, empty.without.serviceLevel);
});

// ── endpoints ─────────────────────────────────────────────────────────────────
const PORT = 4200 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
after(() => server.kill());
await Promise.race([
  new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('running at')) resolve(); });
    server.on('exit', c => reject(new Error(`server exited early (${c})`)));
  }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('server did not start')), 15000)),
]);
const base = `http://127.0.0.1:${PORT}`;
async function api(p, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + p, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, json: await res.json(), cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
}

test('endpoint: Simulate with the ERP stock; the results report it; a bad value is a 400', async () => {
  const start = { finished: 24, raw: 160 };
  const run1 = await api('/api/control', { method: 'POST', body: { action: 'runScenario', params: { scenario: 'supplier-outage', shifts: 20, instant: true, start } } });
  assert.equal(run1.json.ok, true);
  const r = await api('/api/results', { cookie: run1.cookie });
  assert.deepEqual(r.json.start, start);
  assert.equal(r.json.summary.startStock.finishedSets, 24);
  assert.equal(r.json.summary.startStock.rawUnits, 160);
  assert.ok(r.json.summary.startStock.rawUsedDuringOutage > 0);

  const plain = await api('/api/control', { method: 'POST', body: { action: 'runScenario', params: { scenario: 'supplier-outage', shifts: 20, instant: true } }, cookie: run1.cookie });
  assert.equal(plain.json.ok, true);
  const r2 = await api('/api/results', { cookie: run1.cookie });
  assert.deepEqual(r2.json.start, { finished: 0, raw: 0 });
  assert.equal(r2.json.summary.startStock, undefined);
  assert.ok(r.json.summary.orders.serviceLevel > r2.json.summary.orders.serviceLevel);

  const bad = await api('/api/control', { method: 'POST', body: { action: 'runScenario', params: { scenario: 'standard', start: { raw: -5 } } } });
  assert.equal(bad.res.status, 400);
  const badCards = await api('/api/countermeasures/cards?scenario=standard&shifts=2&finished=-1&raw=0');
  assert.equal(badCards.res.status, 400);
  const cards = await api('/api/countermeasures/cards?scenario=standard&shifts=2&finished=10&raw=20');
  assert.deepEqual(cards.json.start, { finished: 10, raw: 20 });
});
