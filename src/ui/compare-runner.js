/**
 * compare-runner.js
 * Two engines side by side for the CEO comparison: A = the scenario as it is, B = the same
 * scenario with the chosen countermeasure (same seed, so the countermeasure is the only
 * difference). One driver loop advances both by the PLANT clock: while one line works
 * overtime, the other waits with its shift closed, so both end at the same plant tick.
 */
import { SimulationEngine } from '../simulation/engine.js';
import { DEFAULT_CONFIG } from '../simulation/config.js';
import { resolveSelection } from '../countermeasures/catalog.js';
import { buildUiScenario, RUN_SHIFTS } from './scenarios.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const STEP_MS = 20;            // timer granularity; several ticks are run per callback when needed

function baseConfig() {
  const cfg = clone(DEFAULT_CONFIG);
  cfg.source.materialStock = -1;
  return cfg;
}

// advice = { scenarioId, selection: [{ id, params }], label, shifts, configOverride? }
// Engine A: as is. Engine B: the countermeasures' config override merged over the defaults.
// configOverride (optional) replaces the selection with a raw engine config, for engine features that are
// not in the pool of countermeasures any more (e.g. overtime); the CEO interface never sets it.
export function buildEngines(advice) {
  const shifts = advice.shifts ?? RUN_SHIFTS;
  const sc = buildUiScenario(advice.scenarioId, shifts);
  const override = advice.configOverride ? { config: advice.configOverride } : resolveSelection(advice.selection, sc.disruptionId).override;

  const a = new SimulationEngine(baseConfig());
  a.configureScenario({ ...sc.configureOptions, runShifts: shifts });

  const cfgB = { ...baseConfig(), ...clone(override.config ?? {}) };
  const b = new SimulationEngine(cfgB);
  b.configureScenario({
    ...sc.configureOptions, runShifts: shifts,
    ...(override.initialFinishedGoods != null ? { initialFinishedGoods: override.initialFinishedGoods } : {}),
  });
  return { a, b, scenario: { id: sc.id, label: sc.label }, shifts };
}

export class CompareRunner {
  constructor(advice) {
    this.advice = advice;
    this.shifts = advice.shifts ?? RUN_SHIFTS;
    this.countermeasure = { label: advice.label, selection: advice.selection, source: advice.source };
    this.speed = 1;
    this.timer = null;
    this.restart();
  }

  restart() {
    this.stop();
    const { a, b, scenario } = buildEngines(this.advice);
    this.a = a; this.b = b; this.scenario = scenario;
    this.waitingA = false;                  // A is idle while B works overtime
  }

  doneA() { return this.a.orders.rows.length >= this.shifts; }
  doneB() { return this.b.orders.rows.length >= this.shifts; }
  get done() { return this.doneA() && this.doneB(); }
  get running() { return this.timer != null; }

  // One lockstep step by the plant clock
  step() {
    const { a, b } = this;
    const doneA = this.doneA(), doneB = this.doneB();
    if (b._otActive && !a._otActive && !doneB) { this.waitingA = !doneA; b._tick(); }
    else if (a._otActive && !b._otActive && !doneA) { this.waitingA = false; a._tick(); }
    else {
      this.waitingA = false;
      if (!doneA) a._tick();
      if (!doneB) b._tick();
    }
  }

  runToEnd() {
    while (!this.done) this.step();
  }

  // speed: 1 | 2 | 10 (multiples of the engine's ticks per second); instant: run to the end now
  start({ speed = 1, instant = false } = {}) {
    this.restart();
    this.speed = speed;
    if (instant) { this.runToEnd(); return; }
    const rate = this.a.getConfig().ticksPerSecond;          // ticks per second at x1
    let last = Date.now(), carry = 0;
    const loop = () => {
      const now = Date.now();
      carry += ((now - last) / 1000) * rate * this.speed;
      last = now;
      let n = Math.floor(carry);
      carry -= n;
      while (n-- > 0 && !this.done) this.step();
      if (this.done) { this.timer = null; return; }
      this.timer = setTimeout(loop, STEP_MS);
    };
    this.timer = setTimeout(loop, STEP_MS);
  }

  setSpeed(speed) { this.speed = speed; }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
