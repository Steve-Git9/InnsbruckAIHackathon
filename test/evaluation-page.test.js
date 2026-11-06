// The evaluation page's data: read from the saved result files, compact, and safe when files are missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEvaluation, TARGETS } from '../src/evaluation/summary.js';

const cmResult = (id, verdict) => ({
  disruption: { id: 'demand-swing', label: 'Demand swing' }, countermeasure: { id, label: id, category: 'operational' },
  runs: 30, shifts: 20, without: { serviceLevel: 0.57 }, with: { serviceLevel: 0.99 },
  change: { serviceLevel: { mean: 0.42, lo: 0.4, hi: 0.44 }, profitConservative: { mean: 21012, lo: 20000, hi: 22000 } },
  verdict: { code: verdict, text: verdict },
});

test('loadEvaluation: compact benchmark and countermeasure tables from the result files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'));
  fs.writeFileSync(path.join(dir, 'advisor_benchmark.json'), JSON.stringify({
    meta: { scenarios: ['demand-swing'], profiles: ['best'], repeats: 1, shifts: 20 },
    score: { cases: 1, acceptable: 1 }, groups: [],
    cases: [{ scenario: 'demand-swing', profile: 'best', repeat: 1, pick: 'finished-stock', expected: 'finished-stock', agree: true, acceptable: true, reason: 'x', prompt: 'not sent' }],
  }));
  fs.writeFileSync(path.join(dir, 'demand-swing_countermeasures.json'), JSON.stringify([cmResult('finished-stock', 'effective')]));
  const e = loadEvaluation(dir);
  assert.equal(e.benchmark.cases.length, 1);
  assert.equal(e.benchmark.cases[0].prompt, undefined);       // only the fields the page needs
  assert.ok(e.benchmark.savedAt);
  assert.equal(e.countermeasures.length, 1);
  const c = e.countermeasures[0];
  assert.equal(c.target, TARGETS['demand-swing']);
  assert.equal(c.items[0].points.toFixed(1), '42.0');
  assert.equal(c.items[0].verdict.code, 'effective');
});

test('loadEvaluation: missing or broken files give an empty page, not an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'));
  fs.writeFileSync(path.join(dir, 'advisor_benchmark.json'), '{ broken');
  assert.deepEqual(loadEvaluation(dir).benchmark, null);
  assert.deepEqual(loadEvaluation(dir).countermeasures, []);
});

test('the saved results of this repository load (if present) and match the data package', () => {
  const e = loadEvaluation();
  for (const c of e.countermeasures) {
    if (c.target != null) assert.ok(Math.abs(c.onTimeWithout - c.target) <= 0.03, `${c.scenario}: ${c.onTimeWithout} vs ${c.target}`);
  }
});
