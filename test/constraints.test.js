// CEO questionnaire: the budget is a hard limit in code; the other answers go to the prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnswers, applyConstraints, checkProposal, describeAnswers, investmentOf, DEFAULT_ANSWERS } from '../src/advisor/constraints.js';
import { catalogueFor } from '../src/countermeasures/catalog.js';
import { loadRateCard } from '../src/data/loaders.js';

const rate = loadRateCard();
const full = catalogueFor('demand-swing');
const ids = (c) => c.catalogue.map(x => x.id);
const ans = (o) => validateAnswers(o);
const ALL = ['improve-machine', 'new-line', 'extra-supplier', 'outsourcing', 'raw-stock', 'finished-stock'];
const OPERATIONAL = ['extra-supplier', 'outsourcing', 'raw-stock', 'finished-stock'];

test('no answers (Give me the best) leaves the catalogue untouched', () => {
  const r = applyConstraints(full, null, rate);
  assert.deepEqual(r.catalogue, full);
  assert.deepEqual(r.applied, []);
});

test('defaults change nothing (No limit)', () => {
  const r = applyConstraints(full, ans({}), rate);
  assert.deepEqual(ids(r), ALL);
  assert.deepEqual(r.applied, []);
});

test('budget: none removes the 3 measures with an upfront cost and keeps the 3 without', () => {
  const r = applyConstraints(full, ans({ budget: 'none' }), rate);
  assert.deepEqual(ids(r), ['outsourcing', 'raw-stock', 'finished-stock']);
  assert.equal(r.applied.length, 3);
  assert.match(r.applied.join('|'), /No investment allowed/);
});

test('budget: 60k removes the new line (EUR 95,000), keeps improve a machine (2 min = EUR 60,000) and all operational ones', () => {
  const r = applyConstraints(full, ans({ budget: '60k' }), rate);
  assert.deepEqual(ids(r), ['improve-machine', ...OPERATIONAL]);
  assert.equal(r.catalogue[0].params.minutesSaved.max, 2);
  assert.match(r.applied.join('|'), /€60,000.*New assembly line/);
  assert.equal(r.applied.length, 1);
});

test('budget: 100k and unlimited keep everything', () => {
  for (const budget of ['100k', 'unlimited']) assert.deepEqual(ids(applyConstraints(full, ans({ budget }), rate)), ALL);
});

test('investmentOf: the rate card prices, 0 upfront for outsourcing, raw stock and finished goods; old ids still priced', () => {
  assert.equal(investmentOf('improve-machine', { minutesSaved: 2 }, rate), 60000);
  assert.equal(investmentOf('improve-machine', { minutesSaved: 1 }, rate), 30000);
  assert.equal(investmentOf('new-line', {}, rate), 95000);
  assert.equal(investmentOf('extra-supplier', {}, rate), 2000);
  for (const id of ['outsourcing', 'raw-stock', 'finished-stock']) assert.equal(investmentOf(id, {}, rate), 0, id);
  assert.equal(investmentOf('faster-m3', { minutesSaved: 2 }, rate), 60000);
  assert.equal(investmentOf('second-m3', {}, rate), 95000);
});

test('the original catalogue is not mutated', () => {
  const before = JSON.stringify(full);
  applyConstraints(full, ans({ budget: 'none' }), rate);
  assert.equal(JSON.stringify(full), before);
});

test('checkProposal rejects removed options and out-of-range values; omitted values take the default', () => {
  const narrow = applyConstraints(full, ans({ budget: '60k' }), rate).catalogue;
  assert.throws(() => checkProposal({ id: 'new-line', params: {} }, narrow), /not allowed/);
  assert.throws(() => checkProposal({ id: 'outsourcing', params: { maxSetsPerShift: 60 } }, narrow), /outside the allowed/);
  assert.deepEqual(checkProposal({ id: 'outsourcing', params: { maxSetsPerShift: 10 } }, narrow), { maxSetsPerShift: 10 });
  assert.deepEqual(checkProposal({ id: 'outsourcing', params: {} }, narrow), { maxSetsPerShift: 15 });
  assert.deepEqual(checkProposal({ id: 'extra-supplier', params: {} }, narrow), {});
});

test('an old payload with overtime and fixType flexible is accepted and mapped', () => {
  const a = validateAnswers({ goal: 'profit', budget: '60k', overtime: '4h', fixType: 'flexible', notes: ' hi ' });
  assert.deepEqual(a, { goal: 'profit', budget: '60k', fixType: 'operational', notes: 'hi' });
  assert.equal('overtime' in a, false);
  assert.equal(validateAnswers({ fixType: 'permanent' }).fixType, 'strategic');
  assert.equal(validateAnswers({ fixType: 'strategic' }).fixType, 'strategic');
  assert.throws(() => validateAnswers({ fixType: 'whatever' }), /invalid value/);
});

test('validateAnswers: null passes, defaults fill in, junk is rejected', () => {
  assert.equal(validateAnswers(null), null);
  assert.deepEqual(validateAnswers({}), DEFAULT_ANSWERS);
  assert.equal('overtime' in DEFAULT_ANSWERS, false);
  assert.throws(() => validateAnswers({ colour: 'red' }), /unknown answer/);
  assert.throws(() => validateAnswers({ budget: '1m' }), /invalid value/);
  assert.throws(() => validateAnswers({ goal: 'toString' }), /invalid value/);
  assert.throws(() => validateAnswers({ notes: 'x'.repeat(501) }), /500/);
  assert.equal(validateAnswers({ notes: 'x'.repeat(500) }).notes.length, 500);
  assert.throws(() => validateAnswers([]), /object/);
});

test('describeAnswers gives readable lines without overtime, or the no-preference line', () => {
  assert.match(describeAnswers(null), /^No preferences given/);
  assert.match(describeAnswers(ans({ budget: '60k' })), /Investment: Up to €60,000/);
  const text = describeAnswers(ans({ fixType: 'strategic' }));
  assert.match(text, /Preferred kind of fix: Strategic — invest for the long term/);
  assert.ok(!/overtime/i.test(text));
});
