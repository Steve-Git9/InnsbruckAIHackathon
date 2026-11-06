/**
 * summary.js
 * The data of the evaluation page (/evaluation), read from the saved result files in results/:
 *   advisor_benchmark.json            <- npm run eval:advisor   (the AI advisor's picks, 72 answers)
 *   <scenario>_countermeasures.json   <- npm run countermeasures (6 countermeasures x 4 scenarios, 30 runs)
 * Nothing is simulated or sent to the AI here: the page shows what the last runs saved.
 *
 *   loadEvaluation(dir) -> { benchmark | null, countermeasures: [...], targets }
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RESULTS_DIR = path.join(ROOT, 'results');
export const SCENARIOS = ['standard', 'demand-swing', 'supplier-outage', 'machinery-breakdown'];

// Reference service levels of the data package (DATA_README.md, empty stock, 30 runs); breakdowns have none
export const TARGETS = { standard: 1.0, 'demand-swing': 0.57, 'supplier-outage': 0.76, 'machinery-breakdown': null };

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const fileDate = (file) => { try { return fs.statSync(file).mtime.toISOString(); } catch { return null; } };

function compactBenchmark(b) {
  if (!b?.score || !Array.isArray(b.cases)) return null;
  return {
    meta: b.meta, score: b.score, groups: b.groups ?? [],
    cases: b.cases.map(c => ({
      scenario: c.scenario, profile: c.profile, repeat: c.repeat, expected: c.expected, acceptableSet: c.acceptableSet,
      rule: c.rule, status: c.status, pick: c.pick, reason: c.reason, agree: c.agree, acceptable: c.acceptable,
      withinLimits: c.withinLimits, validFirstTry: c.validFirstTry, numbers: c.numbers, ungrounded: c.ungrounded, seconds: c.seconds,
    })),
  };
}

function compactCountermeasures(id, list) {
  if (!Array.isArray(list) || !list.length) return null;
  const first = list[0];
  return {
    scenario: id, label: first.disruption?.label ?? id, runs: first.runs, shifts: first.shifts,
    onTimeWithout: first.without.serviceLevel, target: TARGETS[id] ?? null,
    items: list.map(r => ({
      id: r.countermeasure.id, label: r.countermeasure.label, category: r.countermeasure.category,
      onTimeWith: r.with.serviceLevel,
      points: r.change.serviceLevel.mean * 100, pointsLo: r.change.serviceLevel.lo * 100, pointsHi: r.change.serviceLevel.hi * 100,
      profit: r.change.profitConservative.mean, profitLo: r.change.profitConservative.lo, profitHi: r.change.profitConservative.hi,
      verdict: r.verdict,
    })),
  };
}

export function loadEvaluation(dir = RESULTS_DIR) {
  const bFile = path.join(dir, 'advisor_benchmark.json');
  const benchmark = compactBenchmark(readJson(bFile));
  if (benchmark) benchmark.savedAt = fileDate(bFile);
  const countermeasures = SCENARIOS.map(id => {
    const file = path.join(dir, `${id}_countermeasures.json`);
    const c = compactCountermeasures(id, readJson(file));
    if (c) c.savedAt = fileDate(file);
    return c;
  }).filter(Boolean);
  return { benchmark, countermeasures, targets: TARGETS };
}
