/**
 * loaders.js
 * Readers for the data-package CSV files (rate_card.csv, failure_rates.csv,
 * demand_profile.csv). No dependencies; the files have no embedded newlines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const dataPath = (name) => path.join(ROOT, name);

// Minimal CSV line parser with "quoted, fields" support.
function parseLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() !== '');
  const head = parseLine(lines[0]);
  return lines.slice(1).map(l => {
    const cells = parseLine(l);
    return Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  });
}

// rate_card.csv -> { item: number }  (value only; units are in the file)
export function loadRateCard(file = dataPath('rate_card.csv')) {
  const card = {};
  for (const r of readCsv(file)) card[r.item] = Number(r.value);
  return card;
}

// failure_rates.csv -> failure-mode list in the shape of config.failures.modes
export function loadFailureRates(file = dataPath('failure_rates.csv')) {
  return readCsv(file).map(r => ({
    mode: r.mode,
    description: r.description,
    stations: r.suggested_station === 'any' ? 'any' : [r.suggested_station],
    probability: Number(r.probability_per_part),
    repairTicks: Number(r.assumed_repair_time_ticks),
  }));
}

// demand_profile.csv -> orders per shift (the `orders` column)
export function loadDemand(file = dataPath('demand_profile.csv')) {
  return readCsv(file).map(r => Number(r.orders));
}
