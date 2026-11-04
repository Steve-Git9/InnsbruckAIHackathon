// Phase 2: the rule that picks a countermeasure from the sweep must be the one we state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRecommendation, candidates } from '../src/scenarios/sweep.js';

const c = (id, sl, consMean, consLo) => ({
  id, serviceLevel: { mean: sl }, dProfitCons: { mean: consMean, lo: consLo, hi: consMean + 1 },
});

test('only significant conservative gains can be recommended', () => {
  assert.equal(pickRecommendation([c('a', 1, 5000, -10), c('b', 0.6, 100, -1)]), null);
});

test('prefers service level >= 95% over a larger gain below it', () => {
  const r = pickRecommendation([c('big-but-late', 0.80, 9000, 8000), c('on-time', 0.97, 6000, 5000)]);
  assert.equal(r.id, 'on-time');
});

test('among on-time candidates the largest conservative gain wins', () => {
  const r = pickRecommendation([c('x', 0.99, 3000, 2000), c('y', 0.96, 7000, 6000)]);
  assert.equal(r.id, 'y');
});

test('falls back to the largest significant gain when nothing reaches 95%', () => {
  const r = pickRecommendation([c('x', 0.70, 3000, 2000), c('y', 0.80, 1000, 500)]);
  assert.equal(r.id, 'x');
});

test('supply levers are offered only in outage scenarios', () => {
  const kinds = (spec) => new Set(candidates(spec).map(x => x.kind));
  assert.ok(kinds({ outage: true }).has('supply'));
  assert.ok(!kinds({ outage: false }).has('supply'));
});
