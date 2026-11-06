// Advisor benchmark: the scoring rules and the runner, with a fake LLM and fake cards (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedPick, allowedNumbers, groundingOf, classNamed, runBenchmark, formatReport, PROFILES,
} from '../src/evaluation/advisor-benchmark.js';
import { catalogueFor } from '../src/countermeasures/catalog.js';

const IDS = catalogueFor().map(c => c.id);
const CAT = Object.fromEntries(catalogueFor().map(c => [c.id, c]));

// card(id, onTimeWith, profit, verdict)
function card(id, onTimeWith, profit, verdict = 'effective') {
  return {
    id, category: CAT[id].category,
    defaults: Object.fromEntries(Object.entries(CAT[id].params).map(([k, p]) => [k, p.default])),
    onTime: { without: 0.57, with: onTimeWith, points: (onTimeWith - 0.57) * 100 },
    profit: { conservative: profit, official: profit },
    investment: { cash: 0, runningPerShift: 0 },
    costPerGoodSet: { without: 102.8, with: 103 },
    verdict: { code: verdict, text: verdict },
  };
}

const SWING = [
  card('improve-machine', 0.82, 3209),
  card('new-line', 0.968, -18878, 'costly'),
  card('extra-supplier', 0.568, -21, 'no-effect'),
  card('outsourcing', 0.869, 5578),
  card('raw-stock', 0.568, -8943, 'no-effect'),
  card('finished-stock', 0.991, 21012),
];

test('expected pick: each goal follows its rule', () => {
  assert.equal(expectedPick(SWING, IDS, { goal: 'profit' }).best, 'finished-stock');
  assert.equal(expectedPick(SWING, IDS, { goal: 'balance' }).best, 'finished-stock');
  assert.equal(expectedPick(SWING, IDS, { goal: 'delivery' }).best, 'finished-stock');
  assert.equal(expectedPick(SWING, IDS, null).best, 'finished-stock');
  // without finished stock: delivery = highest on time that does not lose money (new line loses money)
  const noFg = IDS.filter(id => id !== 'finished-stock');
  assert.equal(expectedPick(SWING, noFg, { goal: 'delivery' }).best, 'outsourcing');
  assert.equal(expectedPick(SWING, noFg, { goal: 'profit' }).best, 'outsourcing');
  // balance: nobody reaches 95% except the new line -> it wins the tier despite the loss
  assert.equal(expectedPick(SWING, noFg, { goal: 'balance' }).best, 'new-line');
});

test('expected pick: "none" when nothing helps, and the all-lose fallbacks', () => {
  const flat = IDS.map(id => card(id, 1, -100, 'no-effect'));
  assert.deepEqual(expectedPick(flat, IDS, null), { best: 'none', acceptable: ['none'], rule: 'nothing helps: none' });
  const losing = [card('outsourcing', 0.99, -500, 'delivery-only'), card('finished-stock', 1, -3000, 'costly')];
  assert.equal(expectedPick(losing, IDS, { goal: 'delivery' }).best, 'finished-stock');
  assert.equal(expectedPick(losing, IDS, null).best, 'outsourcing');
});

test('acceptable: near ties count as correct', () => {
  const tie = [card('extra-supplier', 1, 11012), card('finished-stock', 1, 10992), card('outsourcing', 0.944, 7280)];
  const r = expectedPick(tie, IDS, { goal: 'profit' });
  assert.equal(r.best, 'extra-supplier');
  assert.deepEqual(r.acceptable.sort(), ['extra-supplier', 'finished-stock']);
});

test('grounding: rounded and percent forms are found; a calculated number is not', () => {
  const allowed = allowedNumbers('{"onTimeWith":0.991,"profitChange":21012,"cost":"EUR 30,000"}');
  const g = groundingOf('It lifts on-time delivery to 99.1% (about 99%) and adds EUR 21,012; the machine costs EUR 30,000. Gap: 42.3 points.', allowed);
  assert.deepEqual(g.ungrounded, [42.3]);
  assert.equal(g.numbers, 5);
  assert.equal(groundingOf('M3 runs 2 shifts', allowed).numbers, 0);   // small integers are ignored
});

test('class named', () => {
  assert.ok(classNamed('This is an operational, short-term fix.', 'operational'));
  assert.ok(!classNamed('A quick fix.', 'strategic'));
});

test('runner: scores a fake AI, counts the retry and consistency', async () => {
  let n = 0;
  // first answer of the first case is invalid (retry), then always finished-stock
  const chat = async () => (++n === 1 ? 'not json'
    : '{"countermeasureId":"finished-stock","reason":"An operational fix: 99.1% on time and EUR 21,012 more profit."}');
  const summaryOf = (id) => ({ scenario: { id, disruptionId: id, label: id }, summary: { perShift: [], orders: { serviceLevel: 0.57 } } });
  const profiles = PROFILES.filter(p => ['profit', 'no-investment'].includes(p.id));
  const r = await runBenchmark({ scenarios: ['demand-swing'], profiles, repeats: 2, chat, getCards: async () => SWING, summaryOf });

  assert.equal(r.score.cases, 4);
  assert.equal(r.score.valid, 4);
  assert.equal(r.score.validFirstTry, 3);
  assert.equal(r.score.withinLimits, 4);
  assert.equal(r.score.acceptable, 4);
  assert.equal(r.score.consistent, 2);
  assert.equal(r.score.classNamed, 4);
  assert.equal(r.score.groundedNumbers, r.score.numbers);
  assert.match(formatReport(r), /Picks the expected option \| \*\*4 \/ 4\*\*/);
});

test('runner: a pick outside the budget is an error, and "none" is scored', async () => {
  const chat = async () => '{"countermeasureId":"new-line","reason":"A strategic investment."}';
  const summaryOf = (id) => ({ scenario: { id, disruptionId: id, label: id }, summary: { perShift: [] } });
  const profiles = PROFILES.filter(p => p.id === 'no-investment');
  const r = await runBenchmark({ scenarios: ['demand-swing'], profiles, repeats: 1, chat, getCards: async () => SWING, summaryOf });
  assert.equal(r.cases[0].status, 'error');
  assert.equal(r.score.valid, 0);

  const flat = IDS.map(id => card(id, 1, -100, 'no-effect'));
  const none = async () => '{"countermeasureId":"none","reason":"Nothing pays off."}';
  const r2 = await runBenchmark({ scenarios: ['standard'], profiles: [PROFILES[0]], repeats: 1, chat: none, getCards: async () => flat, summaryOf });
  assert.equal(r2.score.noneCases, 1);
  assert.equal(r2.score.noneCorrect, 1);
});
