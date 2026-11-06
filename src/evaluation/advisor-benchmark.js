/**
 * advisor-benchmark.js
 * How good are the Intelligent Shift Advisor's picks? Runs the REAL advisor (the LLM through the
 * hackathon proxy) on every scenario x CEO profile, several times, and scores each answer against a
 * rule written down in code (the "expected pick"), using the same simulated card values the AI reads.
 *
 *   npm run eval:advisor [-- --repeats 3 --shifts 20 --scenarios standard,demand-swing --profiles best,profit]
 *   -> results/advisor_benchmark.md (readable scorecard) and results/advisor_benchmark.json (every case)
 *
 * What is measured per answer:
 *   valid first try   the AI's first answer was valid JSON with a pool id / "none" and allowed parameters
 *   valid             valid after the one retry the advisor allows (otherwise: error)
 *   within limits     the pick is inside the catalogue narrowed by the CEO's budget (re-checked here)
 *   expected pick     equals the rule's best option for the CEO's goal (rules: expectedPick below)
 *   acceptable pick   within a small tolerance of the best (near ties count as correct)
 *   class named       the reason says "operational" / "strategic" matching the pick
 *   grounded numbers  every number in the reason appears in what the AI was given (prompt), allowing rounding
 * and per scenario x profile: consistent = the same pick in every repeat.
 *
 * The check simulation after the pick is NOT re-run here: the pick is scored on the card values the AI
 * saw (default parameters, 10 runs). That keeps the benchmark at about the cost of the LLM calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAdvisor, NONE_ID } from '../advisor/advisor.js';
import { chat as defaultChat } from '../advisor/llm.js';
import { applyConstraints, checkProposal, validateAnswers } from '../advisor/constraints.js';
import { IGNORE_BELOW, allowedNumbers, groundingOf } from '../advisor/grounding.js';
import { catalogueFor } from '../countermeasures/catalog.js';
import { createCardStore } from '../countermeasures/cards.js';
import { buildUiScenario, UI_SCENARIO_IDS } from '../ui/scenarios.js';
import { buildRunSummary } from '../ui/run-summary.js';
import { SimulationEngine } from '../simulation/engine.js';
import { DEFAULT_CONFIG } from '../simulation/config.js';
import { loadRateCard } from '../data/loaders.js';

// ── CEO profiles (the questionnaire answers the benchmark sends) ─────────────
export const PROFILES = [
  { id: 'best',          label: 'Give me the best (no answers)',          answers: null },
  { id: 'delivery',      label: 'Goal: on-time delivery',                 answers: { goal: 'delivery' } },
  { id: 'profit',        label: 'Goal: profit',                           answers: { goal: 'profit' } },
  { id: 'balance',       label: 'Goal: a balance of both',                answers: { goal: 'balance' } },
  { id: 'budget-60k',    label: 'Balance, investment up to EUR 60,000',   answers: { goal: 'balance', budget: '60k' } },
  { id: 'no-investment', label: 'Delivery, no investment allowed',        answers: { goal: 'delivery', budget: 'none' } },
];

// Verdicts the advisor is not allowed to pick (same set as advisor.js)
const USELESS = new Set(['no-effect', 'harmful']);

// Tolerances for "acceptable": near ties are not counted as mistakes
export const TOLERANCE = { onTimePoints: 1.0, profitAbs: 500, profitRel: 0.05 };
const profitTol = (best) => Math.max(TOLERANCE.profitAbs, TOLERANCE.profitRel * Math.abs(best));

/**
 * expectedPick(cards, allowedIds, answers) -> { best, acceptable: [ids], rule }
 * The rule for each CEO goal (only options the CEO's budget allows and the advisor may pick):
 *   delivery, or no answers   highest on-time delivery among options that do not lose money
 *                             (no answers: the prompt says "improve on-time delivery the most without losing money");
 *                             if every option loses money: delivery -> highest on-time, no answers -> smallest loss
 *   profit                    highest conservative profit change
 *   balance                   the Phase 2 rule: options reaching >= 95% on time first, then highest profit change;
 *                             if none reaches 95%: highest profit change
 *   nothing helps             "none" (every allowed option is "No effect" or "Harmful")
 */
export function expectedPick(cards, allowedIds, answers) {
  const goal = answers ? (answers.goal ?? 'balance') : 'best';
  const opts = cards.filter(c => c && allowedIds.includes(c.id) && !USELESS.has(c.verdict.code));
  if (opts.length === 0) return { best: NONE_ID, acceptable: [NONE_ID], rule: 'nothing helps: none' };

  const onTime = (c) => c.onTime.with * 100;
  const profit = (c) => c.profit.conservative;
  const argmax = (list, f, tie) => list.reduce((a, c) => (f(c) > f(a) || (f(c) === f(a) && tie(c) > tie(a)) ? c : a));
  const nearOnTime = (list, b) => list.filter(c => onTime(b) - onTime(c) <= TOLERANCE.onTimePoints).map(c => c.id);
  const nearProfit = (list, b) => list.filter(c => profit(b) - profit(c) <= profitTol(profit(b))).map(c => c.id);

  if (goal === 'profit') {
    const b = argmax(opts, profit, onTime);
    return { best: b.id, acceptable: nearProfit(opts, b), rule: 'highest profit change' };
  }
  if (goal === 'balance') {
    const tier = opts.filter(c => c.onTime.with >= 0.95);
    const list = tier.length ? tier : opts;
    const b = argmax(list, profit, onTime);
    return { best: b.id, acceptable: nearProfit(list, b), rule: tier.length ? '>= 95% on time, then highest profit' : 'none reaches 95%: highest profit' };
  }
  // delivery / best
  const paying = opts.filter(c => profit(c) >= 0);
  if (paying.length) {
    const b = argmax(paying, onTime, profit);
    return { best: b.id, acceptable: nearOnTime(paying, b), rule: 'highest on-time without losing money' };
  }
  if (goal === 'delivery') {
    const b = argmax(opts, onTime, profit);
    return { best: b.id, acceptable: nearOnTime(opts, b), rule: 'all lose money: highest on-time' };
  }
  const b = argmax(opts, profit, onTime);
  return { best: b.id, acceptable: nearProfit(opts, b), rule: 'all lose money: smallest loss' };
}

// ── Grounding: are the numbers in the AI's reason in what it was given? (src/advisor/grounding.js) ──
export { IGNORE_BELOW, allowedNumbers, groundingOf };

export function classNamed(reason, category) {
  return new RegExp(category, 'i').test(String(reason));
}

// ── Running ──────────────────────────────────────────────────────────────────
// The run summary the CEO would have after pressing Simulate (seed 1)
export function summaryFor(scenarioId, shifts, rate = loadRateCard()) {
  const sc = buildUiScenario(scenarioId, shifts);
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.source.materialStock = -1;
  const e = new SimulationEngine(cfg);
  e.configureScenario(sc.configureOptions);
  while (e.orders.rows.length < sc.shifts) e._tick();
  return { scenario: sc, summary: buildRunSummary(e, sc, rate) };
}

/**
 * runBenchmark(opts) -> { meta, cases, groups, score }
 * Everything is injectable for tests: chat (the LLM), getCards, summaryFor.
 */
export async function runBenchmark({
  scenarios = UI_SCENARIO_IDS, profiles = PROFILES, repeats = 3, shifts = 20,
  chat = defaultChat, getCards = null, summaryOf = summaryFor, log = () => {},
} = {}) {
  const store = getCards ? null : createCardStore();
  const cardsOf = getCards ?? ((id, n) => store.whenReady(id, n));
  const cases = [];

  for (const scenarioId of scenarios) {
    log(`${scenarioId}: simulating the 6 cards ...`);
    const cards = await cardsOf(scenarioId, shifts);
    const byId = new Map(cards.map(c => [c.id, c]));
    const { scenario, summary } = summaryOf(scenarioId, shifts);

    for (const profile of profiles) {
      const answers = validateAnswers(profile.answers);
      const { catalogue } = applyConstraints(catalogueFor(scenario.disruptionId), answers);
      const allowedIds = catalogue.map(c => c.id);
      const expected = expectedPick(cards, allowedIds, answers);

      for (let rep = 1; rep <= repeats; rep++) {
        let calls = 0, prompt = '';
        const counting = async (messages, o) => {
          calls++;
          if (calls === 1) prompt = messages.map(m => m.content).join('\n');
          return chat(messages, o);
        };
        // the pick is scored on the card values; no extra 10-run check
        const evaluate = async (_s, id, params) => ({ countermeasure: { id, params }, costs: null, runs: 0, without: null, with: null, change: null, verdict: byId.get(id)?.verdict ?? null });
        const advisor = createAdvisor({ chat: counting, evaluate, getCards: async () => cards });

        const t0 = Date.now();
        const c = { scenario: scenarioId, profile: profile.id, repeat: rep, expected: expected.best, acceptableSet: expected.acceptable, rule: expected.rule };
        try {
          const r = await advisor.improve(summary, scenario, answers, { shifts });
          c.status = r.status;
          c.pick = r.status === 'proposed' ? r.countermeasure.id : NONE_ID;   // 'none' or 'no-options' (nothing allowed)
          c.params = r.status === 'proposed' ? r.countermeasure.params : null;
          c.reason = r.reason ?? r.text ?? '';
        } catch (err) {
          c.status = 'error';
          c.pick = null;
          c.error = err.cause?.message ?? err.message;
          c.reason = '';
        }
        c.seconds = (Date.now() - t0) / 1000;
        c.calls = calls;
        c.validFirstTry = c.status !== 'error' && calls === 1;
        c.valid = c.status !== 'error';
        c.withinLimits = c.pick === NONE_ID ? true
          : c.pick ? (() => { try { checkProposal({ id: c.pick, params: c.params }, catalogue); return true; } catch { return false; } })()
          : false;
        c.agree = c.pick === expected.best;
        c.acceptable = c.pick != null && expected.acceptable.includes(c.pick);
        const card = byId.get(c.pick);
        c.classNamed = card ? classNamed(c.reason, card.category) : null;
        const g = groundingOf(c.reason, allowedNumbers(prompt));
        c.numbers = g.numbers;
        c.ungrounded = g.ungrounded;
        cases.push(c);
        log(`  ${profile.id} #${rep}: ${c.pick ?? c.status} (expected ${expected.best}) ${c.acceptable ? 'OK' : 'MISS'}`);
      }
    }
  }

  // consistency per scenario x profile
  const groups = [];
  for (const s of scenarios) for (const p of profiles) {
    const g = cases.filter(c => c.scenario === s && c.profile === p.id);
    const picks = g.map(c => c.pick ?? c.status);
    groups.push({ scenario: s, profile: p.id, picks, consistent: new Set(picks).size === 1, expected: g[0]?.expected });
  }

  const n = cases.length;
  const count = (f) => cases.filter(f).length;
  const proposed = cases.filter(c => c.status === 'proposed');
  const numbers = cases.reduce((a, c) => a + c.numbers, 0);
  const ungrounded = cases.reduce((a, c) => a + c.ungrounded.length, 0);
  const score = {
    cases: n,
    validFirstTry: count(c => c.validFirstTry),
    valid: count(c => c.valid),
    withinLimits: count(c => c.withinLimits),
    expected: count(c => c.agree),
    acceptable: count(c => c.acceptable),
    consistent: groups.filter(g => g.consistent).length, groups: groups.length,
    classNamed: proposed.filter(c => c.classNamed).length, proposed: proposed.length,
    numbers, groundedNumbers: numbers - ungrounded,
    fullyGroundedCases: count(c => c.ungrounded.length === 0),
    noneCases: count(c => c.expected === NONE_ID), noneCorrect: count(c => c.expected === NONE_ID && c.pick === NONE_ID),
    avgSeconds: n ? cases.reduce((a, c) => a + c.seconds, 0) / n : 0,
  };
  return { meta: { date: new Date().toISOString().slice(0, 10), shifts, repeats, scenarios, profiles: profiles.map(p => p.id), tolerance: TOLERANCE }, cases, groups, score };
}

// ── Report ───────────────────────────────────────────────────────────────────
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export function formatReport({ meta, cases, groups, score }) {
  const s = score;
  const L = [];
  L.push('# Intelligent Shift Advisor: benchmark');
  L.push('');
  L.push(`${meta.date} · ${meta.scenarios.length} scenarios × ${meta.profiles.length} CEO profiles × ${meta.repeats} repeats = **${s.cases} answers** from the real AI · ${meta.shifts} shifts · card values from 10 simulated runs`);
  L.push('');
  L.push('## Scorecard');
  L.push('');
  L.push('| Check | Result | |');
  L.push('|---|---|---|');
  const row = (name, a, b, note = '') => L.push(`| ${name} | **${a} / ${b}** (${pct(a, b)}) | ${note} |`);
  row('Valid answer at the first try', s.validFirstTry, s.cases, 'JSON with a pool id and allowed parameters');
  row('Valid answer (after at most one retry)', s.valid, s.cases, 'otherwise the CEO sees an error');
  row('Within the CEO\'s limits (budget)', s.withinLimits, s.cases, 'enforced in code, re-checked here');
  row('Picks the expected option', s.expected, s.cases, 'the rule for the CEO\'s goal, below');
  row('Picks an acceptable option', s.acceptable, s.cases, `near ties count: ±${TOLERANCE.onTimePoints} pt on time, ±max(EUR ${TOLERANCE.profitAbs}, ${TOLERANCE.profitRel * 100}%) profit`);
  row('Says "none" when nothing pays off', s.noneCorrect, s.noneCases, 'Standard scenario');
  row('Same answer in every repeat', s.consistent, s.groups, 'per scenario and profile');
  row('Names the class of its pick', s.classNamed, s.proposed, '"operational" / "strategic"');
  row('Numbers in the explanation found in its input', s.groundedNumbers, s.numbers, `allowing rounding and %; integers below ${IGNORE_BELOW} ignored`);
  row('Explanations with every number found', s.fullyGroundedCases, s.cases, '');
  L.push('');
  L.push(`Average time per answer: ${s.avgSeconds.toFixed(1)} s.`);
  L.push('');
  L.push('## The expected option (rule per CEO goal)');
  L.push('');
  L.push('Only options the CEO\'s budget allows and the advisor may pick (not "No effect" / "Harmful") are considered. Values are the simulated card values the AI also reads.');
  L.push('');
  L.push('| CEO goal | Expected option |');
  L.push('|---|---|');
  L.push('| No answers ("Give me the best") | Highest on-time delivery among options that do not lose money (if all lose money: the smallest loss) |');
  L.push('| On-time delivery | Highest on-time delivery among options that do not lose money (if all lose money: highest on-time) |');
  L.push('| Profit | Highest profit change (unsold extra stock valued at EUR 0) |');
  L.push('| A balance of both | Options reaching ≥ 95% on time first, then highest profit change |');
  L.push('| Nothing helps | "none" |');
  L.push('');
  L.push('## Results per scenario and profile');
  L.push('');
  L.push('| Scenario | Profile | Expected | Acceptable | AI picks (each repeat) | Consistent |');
  L.push('|---|---|---|---|---|---|');
  for (const g of groups) {
    const acc = cases.find(c => c.scenario === g.scenario && c.profile === g.profile)?.acceptableSet ?? [];
    const marks = cases.filter(c => c.scenario === g.scenario && c.profile === g.profile).map(c => `${c.pick ?? c.status}${c.acceptable ? ' ✅' : ' ❌'}`).join(', ');
    L.push(`| ${g.scenario} | ${g.profile} | ${g.expected} | ${acc.join(', ')} | ${marks} | ${g.consistent ? 'yes' : 'no'} |`);
  }
  const misses = cases.filter(c => !c.acceptable);
  L.push('');
  L.push(`## Answers that differ from the rule (${misses.length})`);
  L.push('');
  if (!misses.length) L.push('None.');
  for (const c of misses) {
    L.push(`- **${c.scenario} / ${c.profile} #${c.repeat}**: picked \`${c.pick ?? c.status}\`, expected \`${c.expected}\` (${c.rule}).`
      + (c.error ? ` Error: ${c.error}` : ` Reason given: "${c.reason.replace(/\s+/g, ' ').slice(0, 400)}"`));
  }
  const ung = cases.filter(c => c.ungrounded.length);
  L.push('');
  L.push(`## Numbers not found in the AI's input (${ung.length} answers)`);
  L.push('');
  L.push('Usually a number the AI calculated itself (a difference or a sum). Not necessarily wrong, but not checked by the simulation.');
  L.push('');
  if (!ung.length) L.push('None.');
  for (const c of ung) L.push(`- ${c.scenario} / ${c.profile} #${c.repeat}: ${c.ungrounded.join(', ')}`);
  return L.join('\n') + '\n';
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const list = (v, all) => (v ? v.split(',').map(x => x.trim()).filter(Boolean) : all);
  const scenarios = list(arg('scenarios'), UI_SCENARIO_IDS);
  const profileIds = list(arg('profiles'), PROFILES.map(p => p.id));
  const profiles = PROFILES.filter(p => profileIds.includes(p.id));
  const repeats = Number(arg('repeats') ?? 3), shifts = Number(arg('shifts') ?? 20);
  console.error(`Advisor benchmark: ${scenarios.length} scenarios × ${profiles.length} profiles × ${repeats} repeats = ${scenarios.length * profiles.length * repeats} AI answers`);
  const result = await runBenchmark({ scenarios, profiles, repeats, shifts, log: (m) => console.error(m) });
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../results');
  fs.mkdirSync(dir, { recursive: true });
  const md = formatReport(result);
  fs.writeFileSync(path.join(dir, 'advisor_benchmark.md'), md);
  fs.writeFileSync(path.join(dir, 'advisor_benchmark.json'), JSON.stringify(result, null, 2));
  console.log(md);
  console.log('Saved: results/advisor_benchmark.md and .json');
}
