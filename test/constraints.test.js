// CEO questionnaire: answers become hard limits in code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnswers, applyConstraints, checkProposal, describeAnswers, DEFAULT_ANSWERS } from '../src/advisor/constraints.js';
import { catalogueFor } from '../src/countermeasures/catalog.js';
import { loadRateCard } from '../src/data/loaders.js';

const rate = loadRateCard();
const full = catalogueFor('demand-swing');
const ids = (c) => c.catalogue.map(x => x.id);
const ans = (o) => validateAnswers(o);

test('no answers (Give me the best) leaves the catalogue untouched', () => {
  const r = applyConstraints(full, null, rate);
  assert.deepEqual(r.catalogue, full);
  assert.deepEqual(r.applied, []);
});

test('defaults change nothing (No limit, 2 h overtime)', () => {
  const r = applyConstraints(full, ans({}), rate);
  assert.deepEqual(ids(r), ['overtime', 'faster-m3', 'second-m3']);
  assert.equal(r.catalogue[0].params.maxMinutesPerShift.max, 120);
  assert.equal(r.catalogue[0].params.maxMinutesPerShift.default, 120);
});

test('budget: none removes both investments, keeps overtime', () => {
  const r = applyConstraints(full, ans({ budget: 'none', overtime: '4h' }), rate);
  assert.deepEqual(ids(r), ['overtime']);
  assert.equal(r.applied.length, 2);
});

test('budget: 60k removes the second M3 and keeps faster M3 at up to 2 minutes (EUR 60,000)', () => {
  const r = applyConstraints(full, ans({ budget: '60k', overtime: '4h' }), rate);
  assert.deepEqual(ids(r), ['overtime', 'faster-m3']);
  assert.equal(r.catalogue[1].params.minutesSaved.max, 2);
  assert.match(r.applied.join('|'), /€60,000.*Second M3/);
});

test('budget: 100k and unlimited keep everything', () => {
  for (const budget of ['100k', 'unlimited']) {
    assert.deepEqual(ids(applyConstraints(full, ans({ budget, overtime: '4h' }), rate)), ['overtime', 'faster-m3', 'second-m3']);
  }
});

test('overtime: no removes overtime', () => {
  assert.deepEqual(ids(applyConstraints(full, ans({ overtime: 'no' }), rate)), ['faster-m3', 'second-m3']);
});

test('overtime limits set max 60 / 120 / 240 and clamp the default', () => {
  const max = (o) => applyConstraints(full, ans({ overtime: o }), rate).catalogue[0].params.maxMinutesPerShift;
  assert.deepEqual([max('1h').max, max('1h').default], [60, 60]);
  assert.deepEqual([max('2h').max, max('2h').default], [120, 120]);
  assert.deepEqual([max('4h').max, max('4h').default], [240, 120]);
});

test('nothing + no overtime gives an empty catalogue with the reasons', () => {
  const r = applyConstraints(full, ans({ budget: 'none', overtime: 'no' }), rate);
  assert.equal(r.catalogue.length, 0);
  assert.equal(r.applied.length, 3);
});

test('the original catalogue is not mutated', () => {
  const before = JSON.stringify(full);
  applyConstraints(full, ans({ overtime: '1h', budget: 'none' }), rate);
  assert.equal(JSON.stringify(full), before);
});

test('checkProposal rejects overtime 120 when the limit is 1 h, and removed options', () => {
  const narrow = applyConstraints(full, ans({ overtime: '1h', budget: '60k' }), rate).catalogue;
  assert.throws(() => checkProposal({ id: 'overtime', params: { maxMinutesPerShift: 120 } }, narrow), /outside the allowed/);
  assert.throws(() => checkProposal({ id: 'second-m3', params: {} }, narrow), /not allowed/);
  assert.deepEqual(checkProposal({ id: 'overtime', params: { maxMinutesPerShift: 60 } }, narrow), { maxMinutesPerShift: 60 });
  // an omitted value takes the narrowed default, not the original 120
  assert.deepEqual(checkProposal({ id: 'overtime', params: {} }, narrow), { maxMinutesPerShift: 60 });
});

test('validateAnswers: null passes, defaults fill in, junk is rejected', () => {
  assert.equal(validateAnswers(null), null);
  assert.deepEqual(validateAnswers({}), DEFAULT_ANSWERS);
  assert.throws(() => validateAnswers({ colour: 'red' }), /unknown answer/);
  assert.throws(() => validateAnswers({ budget: '1m' }), /invalid value/);
  assert.throws(() => validateAnswers({ goal: 'toString' }), /invalid value/);
  assert.throws(() => validateAnswers({ notes: 'x'.repeat(501) }), /500/);
  assert.equal(validateAnswers({ notes: 'x'.repeat(500) }).notes.length, 500);
  assert.throws(() => validateAnswers([]), /object/);
});

test('describeAnswers gives readable lines, or the no-preference line', () => {
  assert.match(describeAnswers(null), /^No preferences given/);
  assert.match(describeAnswers(ans({ budget: '60k' })), /Investment: Up to €60,000/);
});
