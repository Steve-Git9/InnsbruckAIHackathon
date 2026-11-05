/**
 * catalog.js
 * The four scenarios the CEO can simulate and the ONE pool of 6 countermeasures that is offered
 * in every scenario. This is the ONLY menu the advisor can choose from: every entry has bounded
 * parameters, a class (strategic = investment for the long term, operational = quick fix) and a
 * price (rate card, or a stated ASSUMPTION).
 *
 * A countermeasure turns its parameters into a config override:
 *   build(params) -> { config?: {...}, initialFinishedGoods?: n }
 * which src/countermeasures/evaluate.js simulates against the scenario.
 *
 * Overtime (config.overtime) is still an engine feature, but it is no longer part of the pool.
 */
import { DEFAULT_CONFIG } from '../simulation/config.js';
import { SCENARIOS, SAFETY_STOCK } from '../scenarios/scenarios.js';
import { backupSupplierDefaults } from '../simulation/supply.js';
import { OUTSOURCING_DEFAULTS } from '../simulation/outsourcing.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const baseMachines = () => clone(DEFAULT_CONFIG.machines);
const sourceWith = (interval) => ({ ...clone(DEFAULT_CONFIG.source), materialStock: -1, interval });
const spec = (id) => SCENARIOS.find(s => s.id === id);

// ── Scenarios (the ids of the CEO interface, mapped to the specs of src/scenarios) ──────────
export const DISRUPTIONS = {
  standard: {
    id: 'standard',
    label: 'Standard',
    description: 'The normal week: a steady 34 orders per shift, the line makes about 37 good sets per shift, no disruption.',
    spec: spec('baseline'),
  },
  'demand-swing': {
    id: 'demand-swing',
    label: 'Demand swing',
    description: 'Customer orders follow the real demand profile: 0 to 75 sets per shift instead of a steady 34. '
      + 'The line makes about 37 sets per shift, enough on average, but not for the peaks.',
    spec: spec('demand-swing'),
  },
  'supplier-outage': {
    id: 'supplier-outage',
    label: 'Supplier outage',
    description: 'The supplier delivers nothing for 2 shifts (shifts 11 and 12), so the line has no parts for 960 minutes. '
      + 'Orders stay at a steady 34 per shift.',
    spec: spec('supplier-outage'),
  },
  'machinery-breakdown': {
    id: 'machinery-breakdown',
    label: 'Machinery breakdown',
    description: 'Machines break down at random and are repaired (short stops and a few long ones). '
      + 'Orders stay at a steady 34 per shift.',
    spec: spec('breakdowns'),
  },
};

// ── Countermeasures ─────────────────────────────────────────────────────────
export const COUNTERMEASURES = {
  'improve-machine': {
    id: 'improve-machine',
    label: 'Improve a machine (faster M3)',
    category: 'strategic',
    description: 'Tooling, fixtures and training take minutes off the M3 assembly cycle (13 min today). '
      + 'Material release is sped up to match, otherwise the faster M3 would wait for parts.',
    params: {
      minutesSaved: { label: 'Minutes taken off the M3 cycle', min: 1, max: 2, step: 1, default: 2 },
    },
    cost: 'Rate card: EUR 30,000 one-time per minute removed, amortised over 1,920 shifts. Faster release costs only material and holding.',
  },

  'new-line': {
    id: 'new-line',
    label: 'New assembly line (second M3)',
    category: 'strategic',
    description: 'A second assembly machine works next to M3 and doubles assembly capacity. '
      + 'Material release is sped up so both machines get parts.',
    params: {
      releaseInterval: { label: 'Release a part every … minutes', min: 7, max: 11, step: 1, default: 8 },
    },
    cost: 'Rate card: EUR 95,000 investment (EUR 49.48 per shift amortised) + EUR 90 per scheduled hour (EUR 720 per shift).',
  },

  'extra-supplier': {
    id: 'extra-supplier',
    label: 'Additional supplier',
    category: 'operational',
    description: 'A second, qualified supplier steps in when the main supplier is out. It needs 240 minutes to deliver '
      + '(ASSUMPTION), so the line still waits at the start of an outage. Outside an outage it changes nothing.',
    params: {},
    cost: 'Rate card: +8% material price on the parts it supplies; EUR 2,000 one-time qualification (amortised over 1,920 shifts). '
      + 'The 240-minute lead time is an ASSUMPTION.',
  },

  outsourcing: {
    id: 'outsourcing',
    label: 'Production outsourcing',
    category: 'operational',
    description: 'An external partner fills the backlog: at the end of a shift with open orders it delivers finished sets '
      + 'in the next shift. Late sets are shipped from the partner, so the line serves the new orders.',
    params: {
      maxSetsPerShift: { label: 'Maximum sets per shift from the partner', min: 5, max: 30, step: 5, default: OUTSOURCING_DEFAULTS.maxSetsPerShift },
    },
    cost: 'ASSUMPTION (no rate-card row): EUR 150 per outsourced set, at most 15 sets per shift by default, delivered in the next shift.',
  },

  'raw-stock': {
    id: 'raw-stock',
    label: 'Increase stock of raw material',
    category: 'operational',
    description: 'A stock of raw material in front of the line, re-ordered when it falls 100 units below the starting level. '
      + 'It keeps the line running when a delivery is missing.',
    params: {
      stockLevel: { label: 'Raw material stock (units)', min: 100, max: 400, step: 50, default: SAFETY_STOCK.initialStock },
    },
    cost: 'Rate card: material at EUR 38 per part, raw-material holding EUR 0.3 per unit per hour (ASSUMPTION: same rate as work in progress).',
  },

  'finished-stock': {
    id: 'finished-stock',
    label: 'Increase stock of finished goods',
    category: 'operational',
    description: 'The plant starts with finished sets in the warehouse, so orders can be served from stock when the line falls short.',
    params: {
      sets: { label: 'Finished sets in stock at the start', min: 10, max: 100, step: 10, default: 50 },
    },
    cost: 'Rate card: stock valued at EUR 103 per set (charged at the start, credited for what is left at the end) + finished-goods holding EUR 0.5 per unit per hour.',
  },
};

// Old ids keep working for one release (saved sessions, old results). New code uses the new ids.
export const ALIASES = { 'faster-m3': 'improve-machine', 'second-m3': 'new-line' };
const canonical = (id) => (Object.hasOwn(ALIASES, id) ? ALIASES[id] : id);

/**
 * Turns the chosen countermeasures (id -> resolved params) into one override { config, initialFinishedGoods? }.
 *
 * Merge rules (see resolveSelection):
 *  - improve-machine, then new-line: the machines are built in that order, so M3b is a copy of the already
 *    faster M3; the source interval is the smallest of the selected items.
 *  - extra-supplier with raw-stock: the inventory mode with the second supplier enabled (no jit backup rule);
 *    extra-supplier alone: the jit backup rule config.source.backupSupplier.
 *  - outsourcing, finished-stock: independent, merged as they are.
 */
function compose(by) {
  const config = {};
  let source = null;

  if (by['improve-machine'] || by['new-line']) {
    const machines = baseMachines();
    const intervals = [];
    if (by['improve-machine']) {
      const m3 = machines.find(m => m.id === 'M3');
      m3.cycleTime -= by['improve-machine'].minutesSaved;
      intervals.push(by['improve-machine'].minutesSaved >= 2 ? 9 : 10);
    }
    if (by['new-line']) {
      machines.push({ ...machines.find(m => m.id === 'M3'), id: 'M3b' });
      intervals.push(by['new-line'].releaseInterval);
    }
    config.machines = machines;
    source = sourceWith(Math.min(...intervals));
  }

  if (by['raw-stock']) {
    const level = by['raw-stock'].stockLevel;
    config.supply = { ...SAFETY_STOCK, mode: 'inventory', reorderPoint: level - 100, initialStock: level };
    if (by['extra-supplier']) config.supply.secondSupplier = { enabled: true };
  } else if (by['extra-supplier']) {
    source = { ...(source ?? sourceWith(DEFAULT_CONFIG.source.interval)), backupSupplier: backupSupplierDefaults() };
  }
  if (source) config.source = source;

  if (by.outsourcing) config.outsourcing = { ...OUTSOURCING_DEFAULTS, enabled: true, maxSetsPerShift: by.outsourcing.maxSetsPerShift };

  const override = { config };
  if (by['finished-stock']) override.initialFinishedGoods = by['finished-stock'].sets;
  return override;
}

for (const cm of Object.values(COUNTERMEASURES)) cm.build = (params) => compose({ [cm.id]: params });

// Fill defaults and reject anything outside the catalogue. This is the guardrail
// for proposals coming from the LLM: an unknown id or an out-of-range value is an error.
// The old ids faster-m3 / second-m3 resolve to improve-machine / new-line.
// (Every countermeasure applies to every scenario, so disruptionId is only checked for being known.)
export function resolveCountermeasure(id, params = {}, disruptionId = null) {
  const cm = COUNTERMEASURES[canonical(id)];
  if (!cm) throw new Error(`unknown countermeasure "${id}" (allowed: ${Object.keys(COUNTERMEASURES).join(', ')})`);
  if (disruptionId && !DISRUPTIONS[disruptionId]) {
    throw new Error(`unknown scenario "${disruptionId}" (allowed: ${Object.keys(DISRUPTIONS).join(', ')})`);
  }
  const resolved = {};
  for (const [name, def] of Object.entries(cm.params)) {
    const v = params[name] ?? def.default;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${cm.id}.${name} must be a number`);
    if (v < def.min || v > def.max) throw new Error(`${cm.id}.${name}=${v} is outside ${def.min}..${def.max}`);
    if (def.step && Math.abs((v - def.min) / def.step - Math.round((v - def.min) / def.step)) > 1e-9) {
      throw new Error(`${cm.id}.${name}=${v} must be in steps of ${def.step}`);
    }
    resolved[name] = v;
  }
  for (const k of Object.keys(params)) if (!(k in cm.params)) throw new Error(`${cm.id} has no parameter "${k}"`);
  return { cm, params: resolved, override: cm.build(resolved) };
}

// Plain description of the catalogue, e.g. for the LLM prompt or the UI. The same 6 for every scenario.
export function catalogueFor(disruptionId) {
  if (disruptionId && !DISRUPTIONS[disruptionId]) {
    throw new Error(`unknown scenario "${disruptionId}" (allowed: ${Object.keys(DISRUPTIONS).join(', ')})`);
  }
  return Object.values(COUNTERMEASURES)
    .map(({ id, label, category, description, params, cost }) => ({ id, label, category, description, params, cost }));
}

/**
 * resolveSelection(selection, disruptionId): one or several countermeasures at once.
 * selection = [{ id, params }], 1..3 entries, unique ids (an old id and its new name count as the same).
 * -> { items: [{ cm, params }], label, override: { config, initialFinishedGoods? } }
 *
 * Merge rules (compose above):
 *  - improve-machine -> new-line: machines are built in this order (M3b copies the already faster M3);
 *    the source interval is the smallest of the selected items.
 *  - raw-stock + extra-supplier: inventory mode with secondSupplier.enabled = true (no jit backup rule).
 *    extra-supplier alone: the jit backup rule (source.backupSupplier).
 *  - outsourcing, finished-stock: independent, merged as they are.
 */
export function resolveSelection(selection, disruptionId = null) {
  if (!Array.isArray(selection)) throw new Error('selection must be a list');
  if (selection.length === 0) throw new Error('select at least one countermeasure');
  if (selection.length > 3) throw new Error('select at most 3 countermeasures');
  const seen = new Set();
  const resolved = [];
  for (const s of selection) {
    if (!s || typeof s !== 'object') throw new Error('each selection entry needs an id');
    const r = resolveCountermeasure(s.id, s.params ?? {}, disruptionId);
    if (seen.has(r.cm.id)) throw new Error(`countermeasure "${s.id}" is selected twice`);
    seen.add(r.cm.id);
    resolved.push(r);
  }
  const order = Object.keys(COUNTERMEASURES);
  resolved.sort((a, b) => order.indexOf(a.cm.id) - order.indexOf(b.cm.id));
  const override = compose(Object.fromEntries(resolved.map(r => [r.cm.id, r.params])));

  return {
    items: resolved.map(r => ({ cm: r.cm, params: r.params })),
    label: resolved.map(r => r.cm.label).join(' + '),
    override,
  };
}
