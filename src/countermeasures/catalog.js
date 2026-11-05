/**
 * catalog.js
 * The disruptions the CEO can simulate and the countermeasures the AI shift advisor
 * may propose. This is the ONLY menu the advisor can choose from: every entry has
 * bounded parameters and a price (rate card, or a stated assumption).
 *
 * A countermeasure turns its parameters into a config override:
 *   build(params) -> { config?: {...}, initialFinishedGoods?: n }
 * which src/countermeasures/evaluate.js simulates against the disruption.
 */
import { DEFAULT_CONFIG } from '../simulation/config.js';
import { SCENARIOS } from '../scenarios/scenarios.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const baseMachines = () => clone(DEFAULT_CONFIG.machines);
const sourceWith = (interval) => ({ ...clone(DEFAULT_CONFIG.source), materialStock: -1, interval });

// ── Disruptions ─────────────────────────────────────────────────────────────
export const DISRUPTIONS = {
  'demand-swing': {
    id: 'demand-swing',
    label: 'Demand swing',
    description: 'Customer orders follow the real demand profile: 0 to 75 sets per shift instead of a steady 34. '
      + 'The line makes about 37 sets per shift, enough on average, but not for the peaks.',
    spec: SCENARIOS.find(s => s.id === 'demand-swing'),
  },
};

// ── Countermeasures ─────────────────────────────────────────────────────────
export const COUNTERMEASURES = {
  overtime: {
    id: 'overtime',
    label: 'Overtime on busy shifts',
    description: 'When a shift ends with orders that the warehouse cannot cover, the line keeps working '
      + '(up to the maximum) until the orders are covered. The whole line runs, because M3 alone would run dry '
      + 'after the 6 parts in its input buffer. Nothing is invested; overtime is paid only when used.',
    appliesTo: ['demand-swing'],
    params: {
      maxMinutesPerShift: { label: 'Maximum overtime per shift (minutes)', min: 30, max: 240, step: 30, default: 120 },
    },
    cost: 'ASSUMPTION (no rate-card row): EUR 405 per overtime hour = hour rates of all four machines (270) + 50% overtime premium.',
    build: ({ maxMinutesPerShift }) => ({ config: { overtime: { enabled: true, maxMinutesPerShift } } }),
  },

  'faster-m3': {
    id: 'faster-m3',
    label: 'Faster M3 (assembly)',
    description: 'Tooling, fixtures and training take minutes off the M3 assembly cycle (13 min today). '
      + 'Material release is sped up to match, otherwise the faster M3 would wait for parts.',
    appliesTo: ['demand-swing'],
    params: {
      minutesSaved: { label: 'Minutes taken off the M3 cycle', min: 1, max: 2, step: 1, default: 2 },
    },
    cost: 'Rate card: EUR 30,000 one-time per minute removed, amortised over 1,920 shifts. Faster release costs only material and holding.',
    build: ({ minutesSaved }) => ({
      config: {
        machines: baseMachines().map(m => (m.id === 'M3' ? { ...m, cycleTime: m.cycleTime - minutesSaved } : m)),
        source: sourceWith(minutesSaved >= 2 ? 9 : 10),
      },
    }),
  },

  'second-m3': {
    id: 'second-m3',
    label: 'Second M3 (parallel assembly machine)',
    description: 'A second assembly machine works next to M3 and doubles assembly capacity. '
      + 'Material release is sped up so both machines get parts.',
    appliesTo: ['demand-swing'],
    params: {
      releaseInterval: { label: 'Release a part every … minutes', min: 7, max: 11, step: 1, default: 8 },
    },
    cost: 'Rate card: EUR 95,000 investment (EUR 49.48 per shift amortised) + EUR 90 per scheduled hour (EUR 720 per shift).',
    build: ({ releaseInterval }) => {
      const m = baseMachines();
      m.push({ ...m.find(x => x.id === 'M3'), id: 'M3b' });
      return { config: { machines: m, source: sourceWith(releaseInterval) } };
    },
  },
};

// Fill defaults and reject anything outside the catalogue. This is the guardrail
// for proposals coming from the LLM: an unknown id or an out-of-range value is an error.
export function resolveCountermeasure(id, params = {}, disruptionId = null) {
  const cm = COUNTERMEASURES[id];
  if (!cm) throw new Error(`unknown countermeasure "${id}" (allowed: ${Object.keys(COUNTERMEASURES).join(', ')})`);
  if (disruptionId && !cm.appliesTo.includes(disruptionId)) {
    throw new Error(`countermeasure "${id}" is not offered for disruption "${disruptionId}"`);
  }
  const resolved = {};
  for (const [name, def] of Object.entries(cm.params)) {
    const v = params[name] ?? def.default;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${id}.${name} must be a number`);
    if (v < def.min || v > def.max) throw new Error(`${id}.${name}=${v} is outside ${def.min}..${def.max}`);
    if (def.step && Math.abs((v - def.min) / def.step - Math.round((v - def.min) / def.step)) > 1e-9) {
      throw new Error(`${id}.${name}=${v} must be in steps of ${def.step}`);
    }
    resolved[name] = v;
  }
  for (const k of Object.keys(params)) if (!(k in cm.params)) throw new Error(`${id} has no parameter "${k}"`);
  return { cm, params: resolved, override: cm.build(resolved) };
}

// Plain description of the catalogue, e.g. for the LLM prompt or the UI.
export function catalogueFor(disruptionId) {
  return Object.values(COUNTERMEASURES)
    .filter(c => c.appliesTo.includes(disruptionId))
    .map(({ id, label, description, params, cost }) => ({ id, label, description, params, cost }));
}

/**
 * resolveSelection(selection, disruptionId): one or several countermeasures at once.
 * selection = [{ id, params }], 1..3 entries, unique ids, all offered for the disruption.
 * -> { items: [{ cm, params }], label, override: { config, initialFinishedGoods? } }
 *
 * Merge rules: machines are built in the order faster-m3 -> second-m3 (so M3b is a copy of the
 * already faster M3); the source interval is the smallest of the selected items; overtime as is.
 */
export function resolveSelection(selection, disruptionId = null) {
  if (!Array.isArray(selection)) throw new Error('selection must be a list');
  if (selection.length === 0) throw new Error('select at least one countermeasure');
  if (selection.length > 3) throw new Error('select at most 3 countermeasures');
  const seen = new Set();
  const resolved = [];
  for (const s of selection) {
    if (!s || typeof s !== 'object') throw new Error('each selection entry needs an id');
    if (seen.has(s.id)) throw new Error(`countermeasure "${s.id}" is selected twice`);
    seen.add(s.id);
    const r = resolveCountermeasure(s.id, s.params ?? {}, disruptionId);
    resolved.push(r);
  }
  const order = Object.keys(COUNTERMEASURES);
  resolved.sort((a, b) => order.indexOf(a.cm.id) - order.indexOf(b.cm.id));
  const by = Object.fromEntries(resolved.map(r => [r.cm.id, r]));

  const config = {};
  if (by['faster-m3'] || by['second-m3']) {
    const machines = baseMachines();
    if (by['faster-m3']) {
      const m3 = machines.find(m => m.id === 'M3');
      m3.cycleTime -= by['faster-m3'].params.minutesSaved;
    }
    if (by['second-m3']) machines.push({ ...machines.find(m => m.id === 'M3'), id: 'M3b' });
    config.machines = machines;
    const intervals = resolved.map(r => r.override.config?.source?.interval).filter(v => v != null);
    config.source = sourceWith(Math.min(...intervals));
  }
  if (by.overtime) config.overtime = by.overtime.override.config.overtime;
  const override = { config };
  const fg = resolved.map(r => r.override.initialFinishedGoods).find(v => v != null);
  if (fg != null) override.initialFinishedGoods = fg;

  return {
    items: resolved.map(r => ({ cm: r.cm, params: r.params })),
    label: resolved.map(r => r.cm.label).join(' + '),
    override,
  };
}
