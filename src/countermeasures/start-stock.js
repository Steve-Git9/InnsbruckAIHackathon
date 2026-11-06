/**
 * start-stock.js
 * The stock the plant starts the run with: the ERP numbers of the Current Situation bar, used only when
 * the CEO switches "Start from the ERP stock" on. Off (the default) = empty stock, as the data package's
 * reference scenarios require.
 *
 *   start = { finished, raw }
 *     finished  finished sets in the warehouse at tick 0: they serve the first orders (initialFinishedGoods)
 *     raw       raw-material safety stock at the source (config.rawSafetyStock): normal deliveries keep it at
 *               its level; while the supplier is out the source releases from it until it is empty
 *
 * The same start applies to the "without" and the "with" side of every comparison, so a countermeasure is
 * still the only difference. A countermeasure that adds stock adds it ON TOP of the ERP stock:
 *   finished-stock: initialFinishedGoods = start.finished + sets
 *   raw-stock (inventory supply model): initial raw stock = its stock level + start.raw
 */
export const NO_START = Object.freeze({ finished: 0, raw: 0 });
export const MAX_START = { finished: 500, raw: 2000 };

// undefined/null -> empty stock; otherwise both values must be whole numbers in range, else it throws
export function normaliseStart(start) {
  if (start === undefined || start === null) return { ...NO_START };
  if (typeof start !== 'object' || Array.isArray(start)) throw new Error('start must be { finished, raw }');
  const out = {};
  for (const k of ['finished', 'raw']) {
    const v = start[k] === undefined || start[k] === '' ? 0 : Number(start[k]);
    if (!Number.isInteger(v) || v < 0 || v > MAX_START[k]) throw new Error(`start.${k} must be a whole number from 0 to ${MAX_START[k]}`);
    out[k] = v;
  }
  return out;
}

export const isEmptyStart = (s) => !s || (s.finished === 0 && s.raw === 0);
export const startKey = (s) => `${s?.finished ?? 0}/${s?.raw ?? 0}`;

// The "without" side: the scenario's own config plus the starting stock
export function baseVariant(scenarioConfig = {}, start = NO_START) {
  return {
    config: { ...scenarioConfig, ...(start.raw > 0 ? { rawSafetyStock: start.raw } : {}) },
    initialFinishedGoods: start.finished,
  };
}

// The "with" side: the countermeasures' override, with their extra stock added on top of the starting stock
export function variantWith(scenarioConfig = {}, override = {}, start = NO_START) {
  const config = { ...scenarioConfig, ...(override.config ?? {}) };
  if (start.raw > 0) {
    if (config.supply?.mode === 'inventory') {
      config.supply = { ...config.supply, initialStock: (config.supply.initialStock ?? 0) + start.raw };
    } else {
      config.rawSafetyStock = start.raw;
    }
  }
  return { config, initialFinishedGoods: start.finished + (override.initialFinishedGoods ?? 0) };
}
