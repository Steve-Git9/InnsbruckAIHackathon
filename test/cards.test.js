// Countermeasure cards: computed on the spot for a scenario and a run length, kept in memory only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCardStore, cardOf } from '../src/countermeasures/cards.js';
import { COUNTERMEASURES } from '../src/countermeasures/catalog.js';

const IDS = Object.keys(COUNTERMEASURES);
const SEEDS = [1, 2, 3];

test('6 cards with the 4 values, class and verdict, computed for the given number of shifts', async () => {
  const store = createCardStore({ seeds: SEEDS });
  const cards = await store.whenReady('demand-swing', 5);
  assert.deepEqual(cards.map(c => c.id), IDS);
  for (const c of cards) {
    assert.ok(['strategic', 'operational'].includes(c.category), c.id);
    assert.ok(c.onTime.without >= 0 && c.onTime.without <= 1 && c.onTime.with >= 0 && c.onTime.with <= 1, c.id);
    assert.ok(Number.isFinite(c.onTime.points), c.id);
    assert.ok(Number.isFinite(c.profit.conservative), c.id);
    assert.ok(Number.isFinite(c.investment.cash) && Number.isFinite(c.investment.runningPerShift), c.id);
    assert.ok(c.costPerGoodSet.without > 0 && c.costPerGoodSet.with > 0, c.id);
    assert.ok(c.verdict.code && c.verdict.text, c.id);
    assert.deepEqual(Object.keys(c.defaults), Object.keys(c.params), c.id);
  }
  const by = Object.fromEntries(cards.map(c => [c.id, c]));
  assert.equal(by['improve-machine'].investment.cash, 60000);
  assert.equal(by['new-line'].investment.cash, 95000);
  assert.equal(by['extra-supplier'].investment.cash, 2000);
  for (const id of ['outsourcing', 'raw-stock', 'finished-stock']) assert.equal(by[id].investment.cash, 0, id);
  // the new line costs 90 EUR x 8 h per shift on top (EUR 720)
  assert.ok(by['new-line'].investment.runningPerShift > 700, `${by['new-line'].investment.runningPerShift}`);
  assert.equal(by['extra-supplier'].investment.runningPerShift, 0);
  // all four values come from the same 10-run style comparison: the card of the evaluator
  assert.equal(by['finished-stock'].onTime.points > 0, true);
});

test('another number of shifts gives other values; the same pair is computed once (cache)', async () => {
  const calls = [];
  const real = createCardStore({ seeds: SEEDS });
  const fake = createCardStore({
    seeds: SEEDS,
    evaluate: async (scenario, id, params, opts) => {
      calls.push(`${scenario}|${id}|${opts.shifts}`);
      return { shifts: opts.shifts, costs: { pay: [], investment: { cash: 0 } }, without: { serviceLevel: 0.5, costPerGoodUnit: 100 },
        with: { serviceLevel: 0.6, costPerGoodUnit: 99 }, change: { serviceLevel: { mean: 0.1 }, profitConservative: { mean: opts.shifts }, profitOfficial: { mean: 1 } },
        verdict: { code: 'effective', text: 'ok' } };
    },
  });
  const a = await real.whenReady('demand-swing', 4);
  const b = await real.whenReady('demand-swing', 6);
  assert.notDeepEqual(a.map(c => c.profit.conservative), b.map(c => c.profit.conservative), 'a different run length changes the numbers');

  await fake.whenReady('standard', 5);
  assert.equal(calls.length, 6);
  const again = fake.snapshot('standard', 5);                       // hits the cache: nothing is computed again
  assert.equal(calls.length, 6);
  assert.deepEqual(again.pending, []);
  assert.equal(again.ready.length, 6);
  assert.equal(again.runs, 3);
  await fake.whenReady('standard', 7);
  assert.equal(calls.length, 12);
  await fake.whenReady('standard', 5);                              // back to a pair computed before: instant
  assert.equal(calls.length, 12);
  assert.equal(fake.size(), 2);
});

test('a new scenario deprioritises the old one: only one computation at a time, on the newest request', async () => {
  const order = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const store = createCardStore({
    seeds: SEEDS,
    evaluate: async (scenario, id, params, opts) => {
      order.push(`${scenario}:${id}`);
      if (order.length === 1) await gate;                           // the first evaluation is slow
      return { shifts: opts.shifts, costs: { pay: [], investment: { cash: 0 } }, without: { serviceLevel: 0.5, costPerGoodUnit: 1 },
        with: { serviceLevel: 0.5, costPerGoodUnit: 1 }, change: { serviceLevel: { mean: 0 }, profitConservative: { mean: 0 }, profitOfficial: { mean: 0 } },
        verdict: { code: 'no-effect', text: 'x' } };
    },
  });
  const old = store.request('standard', 5);
  assert.deepEqual(old.pending.length, 6);
  const fresh = store.request('supplier-outage', 5);                // the CEO picked another scenario
  release();
  await fresh.done;
  assert.deepEqual(order.slice(1).map(x => x.split(':')[0]), Array(6).fill('supplier-outage'), 'the new scenario goes first');
  assert.equal(order.filter(x => x.startsWith('standard')).length, 1, 'the old one is not continued');
  assert.equal(old.pending.length, 5);
  assert.equal(store.snapshot('supplier-outage', 5).pending.length, 0);
  assert.throws(() => store.request('alien-invasion', 5), /unknown scenario/);
});

test('cardOf: running cost per shift leaves out the share of the investment and the starting stock', () => {
  const r = {
    shifts: 10, without: { serviceLevel: 0.5, costPerGoodUnit: 100 }, with: { serviceLevel: 0.9, costPerGoodUnit: 105 },
    change: { serviceLevel: { mean: 0.4 }, profitConservative: { mean: 500 }, profitOfficial: { mean: 600 } },
    costs: { investment: { cash: 95000 }, pay: [{ key: 'investmentShare', amount: 47 }, { key: 'machineHours', amount: 7200 }, { key: 'startStock', amount: 5150 }, { key: 'material', amount: 100 }] },
    verdict: { code: 'costly', text: 'x' },
  };
  const c = cardOf('new-line', r);
  assert.equal(c.investment.runningPerShift, 730);
  assert.equal(c.onTime.points, 40);
  assert.equal(c.category, 'strategic');
});

// ── endpoint: GET /api/countermeasures/cards ──────────────────────────────────
const PORT = 3900 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
after(() => server.kill());
let ready;
const started = new Promise((resolve, reject) => {
  ready = resolve;
  server.stdout.on('data', d => { if (String(d).includes('running at')) resolve(); });
  server.on('exit', c => reject(new Error(`server exited early (${c})`)));
});
await Promise.race([started, new Promise((_, rej) => setTimeout(() => rej(new Error('server did not start')), 15000))]);

const base = `http://127.0.0.1:${PORT}`;
async function api(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + path, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, json: await res.json(), cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
}
async function untilReady(path, cookie) {
  for (let i = 0; i < 200; i++) {
    const { json } = await api(path, { cookie });
    if (json.pending.length === 0) return json;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('cards did not finish');
}

test('endpoint: polls from "pending" to 6 ready cards for the shifts of the top bar', async () => {
  const first = await api('/api/countermeasures/cards?scenario=standard&shifts=5');
  assert.equal(first.res.status, 200);
  assert.equal(first.json.shifts, 5);
  assert.equal(first.json.scenario, 'standard');
  assert.equal(first.json.runs, 10);
  assert.equal(first.json.ready.length + first.json.pending.length, 6);
  const done = await untilReady('/api/countermeasures/cards?scenario=standard&shifts=5');
  assert.equal(done.ready.length, 6);
  assert.deepEqual(done.ready.map(c => c.id), IDS);
  for (const c of done.ready) assert.ok(c.category && c.verdict && c.onTime && c.profit && c.investment && c.costPerGoodSet, c.id);

  // the same pair again: answered from memory, nothing pending
  const again = await api('/api/countermeasures/cards?scenario=standard&shifts=5');
  assert.deepEqual(again.json.pending, []);
  assert.equal(again.json.ready.length, 6);

  // another shift limit: new values, the header can state the length
  const other = await untilReady('/api/countermeasures/cards?scenario=standard&shifts=8');
  assert.equal(other.shifts, 8);
  assert.notDeepEqual(other.ready.map(c => c.profit.conservative), done.ready.map(c => c.profit.conservative));
});

test('endpoint: without a query it uses the scenario and the shift limit of the session (session.runShifts)', async () => {
  const run = await api('/api/control', { method: 'POST', body: { action: 'runScenario', params: { scenario: 'demand-swing', shifts: 4, instant: true } } });
  assert.equal(run.json.ok, true);
  const done = await untilReady('/api/countermeasures/cards', run.cookie);
  assert.equal(done.shifts, 4);
  assert.equal(done.scenario, 'demand-swing');
  assert.equal(done.ready.length, 6);
  const list = await api('/api/countermeasures', { cookie: run.cookie });
  assert.deepEqual(list.json.map(c => c.id), IDS);
  assert.ok(list.json.every(c => c.category));
});

test('endpoint: bad input is a 400', async () => {
  const bad = await api('/api/countermeasures/cards?scenario=nope&shifts=5');
  assert.equal(bad.res.status, 400);
  const badShifts = await api('/api/countermeasures/cards?scenario=standard&shifts=99');
  assert.equal(badShifts.res.status, 400);
});
