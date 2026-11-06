// The explanation chat runs on Claude Opus 4.8 (the countermeasure pick stays on gpt-4o), and the money
// tiles of the Results add up: revenue - total cost + value of the finished sets left = profit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdvisor } from '../src/advisor/advisor.js';
import { EXPLAIN_MODEL, DEFAULT_MODEL, recordUsage, readUsage } from '../src/advisor/llm.js';
import { buildUiScenario } from '../src/ui/scenarios.js';
import { summaryFor } from '../src/evaluation/advisor-benchmark.js';

const summary = { scenario: { id: 'standard', label: 'Standard' }, shifts: 20, orders: { late: 0 }, perShift: [] };

test('explain and follow-ups ask the proxy for claude-opus-4-8; the pick keeps gpt-4o', async () => {
  assert.equal(EXPLAIN_MODEL, 'claude-opus-4-8');
  assert.equal(DEFAULT_MODEL, 'gpt-4o');
  const seen = [];
  const chat = async (messages, opts = {}) => { seen.push(opts.model); return messages.length > 2 ? 'Follow-up.' : '{"countermeasureId":"none","reason":"Nothing pays off."}'; };
  const advisor = createAdvisor({ chat, getCards: async () => [] });
  const r = await advisor.explain(summary);
  assert.deepEqual(r.model, { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' });
  await advisor.ask(summary, { explanation: 'x', turns: [] }, 'Why?');
  await advisor.improve(summary, buildUiScenario('standard'));
  assert.deepEqual(seen.slice(0, 2), ['claude-opus-4-8', 'claude-opus-4-8']);
  assert.ok(seen.slice(2).every(m => m === undefined), 'improve uses the default model (gpt-4o)');
});

test('the token tally counts per model', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), 'u.json');
  recordUsage({ totalTokens: 100 }, file, new Date(), 'claude-opus-4-8');
  recordUsage({ totalTokens: 50 }, file, new Date(), 'gpt-4o');
  recordUsage({ totalTokens: 10 }, file, new Date(), 'gpt-4o');
  assert.deepEqual(readUsage(file).byModel, { 'claude-opus-4-8': { calls: 1, totalTokens: 100 }, 'gpt-4o': { calls: 2, totalTokens: 60 } });
});

test('money tiles: revenue - total cost + stock left = profit, in every scenario', () => {
  for (const id of ['standard', 'demand-swing', 'supplier-outage', 'machinery-breakdown']) {
    const { summary: s } = summaryFor(id, 20);
    const m = s.money, st = s.stockEnd;
    assert.ok(Math.abs(m.revenue - m.totalCost + st.finishedValue - m.profit) < 0.01, id);
    assert.equal(m.revenue, m.soldSets * m.pricePerSet, id);
    assert.equal(st.finishedValue, st.finishedSets * st.valuePerSet, id);
    const parts = Object.values(m.costs).reduce((a, v) => a + v, 0);
    assert.ok(Math.abs(parts - m.totalCost) < 0.01, `${id}: the cost lines add up to the total`);
    assert.ok(st.inLineParts >= 0 && st.storageCostFinished >= 0);
  }
});
