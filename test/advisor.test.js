// AI shift advisor with a mocked LLM and a mocked evaluator: no network, fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdvisor, parseProposal, compactFacts } from '../src/advisor/advisor.js';
import { parseEnv, foldSystem } from '../src/advisor/llm.js';
import { buildUiScenario } from '../src/ui/scenarios.js';

const summary = {
  scenario: { id: 'demand-swing', label: 'Demand swing' }, shifts: 20,
  orders: { ordered: 600, shippedOnTime: 340, serviceLevel: 0.57, late: 260, backlogEnd: 5 },
  perShift: [{ shift: 1, orders: 61, shippedOnTime: 30, backlog: 31, produced: 30, stock: 0 }],
};
const fakeCheck = {
  countermeasure: { id: 'overtime', label: 'Overtime on busy shifts', params: { maxMinutesPerShift: 120 }, cost: 'x' },
  runs: 10, without: { serviceLevel: 0.57 }, with: { serviceLevel: 0.8 },
  change: { serviceLevel: { mean: 0.2 }, profitConservative: { mean: 1000 }, profitOfficial: { mean: 900 } },
  verdict: { code: 'effective', text: 'ok' },
};
const mockChat = (answers) => {
  const calls = [];
  const fn = async (messages) => { calls.push(JSON.parse(JSON.stringify(messages))); return answers[Math.min(calls.length - 1, answers.length - 1)]; };
  fn.calls = calls;
  return fn;
};
const good = '```json\n{"countermeasureId":"overtime","params":{"maxMinutesPerShift":120},"reason":"Because 260 sets were late."}\n```';

test('explain sends the FACTS and returns the text', async () => {
  const chat = mockChat(['It went badly.']);
  const r = await createAdvisor({ chat }).explain(summary);
  assert.deepEqual(r, { text: 'It went badly.' });
  const user = chat.calls[0].find(m => m.role === 'user').content;
  assert.ok(user.startsWith('FACTS:\n'));
  assert.equal(JSON.parse(user.slice(7)).orders.late, 260);
});

test('improve without a catalogue does not call the LLM', async () => {
  const chat = mockChat(['x']);
  const advisor = createAdvisor({ chat });
  const out = await advisor.improve(summary, buildUiScenario('supplier-outage'));
  assert.equal(out.status, 'no-options');
  assert.match(out.text, /No countermeasures are available yet for Supplier outage/);
  const std = await advisor.improve(summary, buildUiScenario('standard'));
  assert.match(std.text, /nothing to fix/);
  assert.equal(chat.calls.length, 0);
});

test('an invalid id is retried once with the error, then succeeds and is checked', async () => {
  const chat = mockChat(['{"countermeasureId":"magic","params":{}}', good]);
  const evalCalls = [];
  const evaluate = async (...a) => { evalCalls.push(a); return fakeCheck; };
  const r = await createAdvisor({ chat, evaluate }).improve(summary, buildUiScenario('demand-swing'));
  assert.equal(chat.calls.length, 2);
  assert.match(chat.calls[1].at(-1).content, /unknown countermeasure "magic"/);
  assert.equal(r.status, 'proposed');
  assert.equal(r.reason, 'Because 260 sets were late.');
  assert.equal(r.check.verdict.code, 'effective');
  assert.equal(evalCalls.length, 1);
  assert.deepEqual(evalCalls[0].slice(0, 3), ['demand-swing', 'overtime', { maxMinutesPerShift: 120 }]);
  assert.equal(evalCalls[0][3].seeds.length, 10);
});

test('two invalid answers give an error and never evaluate', async () => {
  const chat = mockChat(['nonsense', '{"countermeasureId":"overtime","params":{"maxMinutesPerShift":7}}']);
  let evaluated = 0;
  const evaluate = async () => { evaluated++; return fakeCheck; };
  await assert.rejects(createAdvisor({ chat, evaluate }).improve(summary, buildUiScenario('demand-swing')), /invalid proposal/);
  assert.equal(chat.calls.length, 2);
  assert.equal(evaluated, 0);
});

test('parseProposal strips fences and surrounding text', () => {
  const p = parseProposal('Sure!\n```json\n{"countermeasureId":"faster-m3","params":{"minutesSaved":1},"reason":"r"}\n```');
  assert.deepEqual(p, { id: 'faster-m3', params: { minutesSaved: 1 }, reason: 'r' });
  assert.throws(() => parseProposal('no json'));
});

test('compactFacts keeps only the needed per-shift fields', () => {
  assert.deepEqual(Object.keys(compactFacts(summary).perShift[0]), ['shift', 'orders', 'shippedOnTime', 'backlog', 'produced']);
});

test('parseEnv reads KEY=VALUE, skips comments, strips quotes', () => {
  assert.deepEqual(parseEnv('# c\n\nA=1\nB="two"\nC = \'three\'\n'), { A: '1', B: 'two', C: 'three' });
});

test('foldSystem puts the system text into the first user message (the proxy has no system role)', () => {
  const out = foldSystem([{ role: 'system', content: 'RULES' }, { role: 'user', content: 'Q' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'Q2' }]);
  assert.deepEqual(out, [{ role: 'user', content: 'RULES\n\nQ' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'Q2' }]);
});
