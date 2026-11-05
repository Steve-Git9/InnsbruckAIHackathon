// Cost of the improvement: every line traced to the rate card; the lines add up to the profit change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSelection } from '../src/countermeasures/evaluate.js';
import { costBreakdown } from '../src/economics/breakdown.js';
import { range } from '../src/scenarios/scenarios.js';
import { loadRateCard } from '../src/data/loaders.js';
import { buildEngines } from '../src/ui/compare-runner.js';
import { engineRecord } from '../src/ui/run-summary.js';

const D = 'demand-swing';
const rate = loadRateCard();
const seeds = range(1, 3);
const SELECTIONS = {
  overtime: [{ id: 'overtime', params: {} }],
  'faster-m3': [{ id: 'faster-m3', params: { minutesSaved: 2 } }],
  'second-m3': [{ id: 'second-m3', params: {} }],
  'faster+second': [{ id: 'faster-m3', params: { minutesSaved: 2 } }, { id: 'second-m3', params: {} }],
};
const results = {};
for (const [k, sel] of Object.entries(SELECTIONS)) results[k] = await evaluateSelection(D, sel, { seeds, shifts: 20 });

const sum = (a) => a.reduce((x, y) => x + y.amount, 0);

test('identity: sum(get) - sum(pay) = official profit change, and the conservative figure matches the evaluator', () => {
  for (const [k, r] of Object.entries(results)) {
    const c = r.costs;
    assert.ok(Math.abs(sum(c.get) - sum(c.pay) - r.change.profitOfficial.mean) < 0.01, `${k}: official`);
    assert.ok(Math.abs(c.totals.profitChangeOfficial - r.change.profitOfficial.mean) < 0.01, `${k}: totals`);
    assert.ok(Math.abs(c.totals.profitChangeConservative - r.change.profitConservative.mean) < 0.01, `${k}: conservative`);
    assert.equal(c.basis.runs, 3);
    assert.equal(c.basis.shifts, 20);
  }
});

test('investment cash from the rate card', () => {
  assert.equal(results.overtime.costs.investment.cash, 0);
  assert.equal(results['faster-m3'].costs.investment.cash, 60000);
  assert.equal(results['second-m3'].costs.investment.cash, 95000);
  assert.equal(results['faster+second'].costs.investment.cash, 2 * 2 * 30000 + 95000);
  const items = results['faster+second'].costs.investment.items;
  assert.match(items.find(i => i.key === 'cycleTime').formula, /2 min × €30,000 × 2 machines/);
  assert.match(items.find(i => i.key === 'extraMachines').formula, /€95,000 per extra machine/);
  assert.ok(items.find(i => i.key === 'cycleTime').assumption);
  // charged this period = cash / 1,920 shifts x 20 shifts
  assert.ok(Math.abs(results['second-m3'].costs.investment.chargedThisPeriod - 95000 / 1920 * 20) < 0.01);
});

test('the overtime line is hours x the overtime rate (405 on the default line) and carries an assumption note', () => {
  const l = results.overtime.costs.pay.find(x => x.key === 'overtime');
  assert.ok(l.assumption);
  assert.match(l.formula, /€405\/h/);
  const hours = results.overtime.with.overtimeHours;
  assert.ok(Math.abs(l.amount - hours * 405) < 0.01);
  assert.equal(results['second-m3'].costs.pay.find(x => x.key === 'overtime'), undefined, 'hidden when exactly 0');
});

test('second M3: machine hours line = 90 x 8 x shifts', () => {
  const l = results['second-m3'].costs.pay.find(x => x.key === 'machineHours');
  assert.ok(Math.abs(l.amount - 90 * 8 * 20) < 0.01);
  assert.match(l.formula, /M3b: €90\/h × 8 h × 20 shifts/);
});

test('rescued orders = mean change in shippedOnTime; cost per rescued order = cost / rescued', () => {
  for (const r of Object.values(results)) {
    const c = r.costs;
    assert.ok(c.rescuedOrders > 0);
    assert.ok(Math.abs(c.costPerRescuedOrder - c.totals.costOfImprovement / c.rescuedOrders) < 1e-9);
    assert.equal(c.penaltyPerLateOrder, 90);
  }
});

// Hand-made records for the edge cases
const rec = (o = {}) => ({
  econ: { revenue: 1000, machineCost: 500, overtimeHours: 0, overtimeCost: 0, materialCost: 300, holdingWip: 10, holdingFg: 10, holdingRaw: 0,
    lostSales: 900, amortised: 0, oneTime: { counts: {}, items: {} }, startValue: 0, endValue: 0, profit: -720, ...(o.econ ?? {}) },
  shipped: 20, shippedOnTime: 10, ordered: 20, released: 30, goodParts: 20, fgStart: 0, fgEnd: 0,
  machines: ['M1', 'M2', 'M3', 'M4'], overtimeRate: 405, reductions: { cycle: [], rejectPoints: 0 },
  ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'econ')),
});

test('cost per rescued order is null and the headline says so when nothing is rescued', () => {
  const c = costBreakdown({ without: [rec()], with: [rec({ econ: { materialCost: 400 } })], rate, shifts: 20 });
  assert.equal(c.rescuedOrders, 0);
  assert.equal(c.costPerRescuedOrder, null);
  assert.equal(c.headline, 'This does not deliver more orders on time.');
});

test('payback: null without an investment, never when the gain is not positive, else ceil(cash / gain)', () => {
  const none = costBreakdown({ without: [rec()], with: [rec({ shippedOnTime: 15, econ: { lostSales: 450, profit: -270 } })], rate, shifts: 20 });
  assert.equal(none.payback, null);

  const invest = { counts: { extraMachines: 1 }, items: { extraMachines: 95000 } };
  const base = { amortised: 95000 / 1920 * 20, oneTime: invest };
  // gain 450 EUR over 20 shifts before the investment share -> 22.5 per shift
  const good = costBreakdown({ without: [rec()], with: [rec({ shippedOnTime: 15, econ: { ...base, lostSales: 450, profit: -270 - base.amortised } })], rate, shifts: 20 });
  assert.equal(good.investment.cash, 95000);
  assert.equal(good.payback.shifts, Math.ceil(95000 / 22.5));
  assert.equal(good.payback.years, good.payback.shifts / 240);
  assert.equal(good.payback.withinLife, good.payback.shifts <= 1920);
  assert.match(good.headline, /€95,000 upfront/);

  const bad = costBreakdown({ without: [rec()], with: [rec({ shippedOnTime: 12, econ: { ...base, lostSales: 900 - 180 + 5000, profit: -9999 } })], rate, shifts: 20 });
  assert.deepEqual(bad.payback, { shifts: null, years: null, withinLife: false });
});

test('headline: mentions the rescued sets and the cost, and the investment exactly when cash > 0', () => {
  for (const [k, r] of Object.entries(results)) {
    const h = r.costs.headline;
    assert.ok(h.includes(`**${Math.round(r.costs.rescuedOrders * 10) / 10 % 1 === 0 ? Math.round(r.costs.rescuedOrders) : (Math.round(r.costs.rescuedOrders * 10) / 10).toFixed(1)}**`), `${k}: rescued`);
    assert.match(h, /you pay \*\*€[\d,]+\*\*/);
    if (r.costs.investment.cash > 0) assert.match(h, /upfront/, k);
    else assert.match(h, /No upfront investment/, k);
  }
  assert.match(results.overtime.costs.headline, /sets nobody ordered/);
});

test('a single-run breakdown (side-by-side view) works and satisfies the identity', () => {
  const { a, b } = buildEngines({ scenarioId: D, selection: [{ id: 'overtime', params: { maxMinutesPerShift: 120 } }], shifts: 6, label: 'x' });
  while (a.orders.rows.length < 6) a._tick();
  while (b.orders.rows.length < 6) b._tick();
  const ra = engineRecord(a, rate), rb = engineRecord(b, rate);
  const c = costBreakdown({ without: [ra], with: [rb], rate, shifts: 6, label: 'x' });
  assert.equal(c.basis.runs, 1);
  assert.ok(Math.abs(sum(c.get) - sum(c.pay) - (rb.econ.profit - ra.econ.profit)) < 0.01);
});

test('costBreakdown needs paired runs', () => {
  assert.throws(() => costBreakdown({ without: [rec()], with: [], rate, shifts: 20 }), /paired/);
});
