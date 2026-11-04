// Acceptance test for runHeadless. Run from the repository root: node src/headless/run.check.mjs [path/to/demand_profile.csv] (default: demand_profile.csv in the repository root)
// The simulation is random (see Track B README), so every number is an average over RUNS runs and checked against a range.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runHeadless, readDemand, TICKS_PER_SHIFT } from './run.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const csvPath = process.argv[2] ?? path.join(here, '..', '..', 'demand_profile.csv');
if (!fs.existsSync(csvPath)) throw new Error(`demand profile not found: ${csvPath} (pass its path as the first argument)`);
const demand = readDemand(csvPath);
const RUNS = 20, SHIFTS = 20, OUTAGE = { startTick: 4800, endTick: 5760 };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const many = async (opts) => {
  opts = { demand, ...opts };
  const rs = [];
  for (let i = 0; i < RUNS; i++) rs.push(await runHeadless({ shifts: SHIFTS, seed: i + 1, ...opts }));
  return rs;
};
const inRange = (name, v, lo, hi) => {
  assert.ok(v >= lo && v <= hi, `${name}: ${v.toFixed(3)} not in [${lo}, ${hi}]`);
  console.log(`ok  ${name} = ${v.toFixed(3)} (expected ${lo} to ${hi})`);
};

// 1. scenario 'demand swing': default line, demand profile, empty stock, no outage. README says about 57% service level
//    and 36.8 good parts per shift
const swing = await many({});
inRange('demand swing service level', mean(swing.map((r) => r.kpis.serviceLevel)), 0.53, 0.61);
inRange('demand swing good parts per shift', mean(swing.map((r) => r.kpis.goodPerShift)), 36.3, 37.3);

// 2. scenario 'both': demand profile plus the reference outage (source halted for 960 ticks from tick 4800): about 48%
const out = await many({ outage: OUTAGE });
inRange('both (demand swing + outage) service level', mean(out.map((r) => r.kpis.serviceLevel)), 0.45, 0.53);

// 2b. flat demand of 34 per shift (scenario 'baseline'): about 100%, and about 76% with the reference outage
//     (scenario 'supplier outage')
const flat = Array(60).fill(34);
const flatBase = await many({ demand: flat });
const flatOut = await many({ demand: flat, outage: OUTAGE });
inRange('flat baseline service level', mean(flatBase.map((r) => r.kpis.serviceLevel)), 0.97, 1.0);
inRange('flat outage service level', mean(flatOut.map((r) => r.kpis.serviceLevel)), 0.70, 0.84);

// 3. finished-goods stock helps
const stocked = await many({ initialFinishedGoods: 60 });
assert.ok(mean(stocked.map((r) => r.kpis.serviceLevel)) > mean(swing.map((r) => r.kpis.serviceLevel)) + 0.05, 'stock of 60 should raise the service level');
console.log('ok  initial finished goods raise the service level');

// 4. structure of the result and consistency of the books
const r = swing[0];
assert.equal(r.perShift.length, SHIFTS);
assert.equal(r.kpis.ordered, demand.slice(0, SHIFTS).reduce((a, b) => a + b, 0));
assert.equal(r.perShift.reduce((a, s) => a + s.produced, 0), r.kpis.goodParts);
for (const s of r.perShift) assert.ok(s.shippedOnTime <= s.orders && s.backlog >= 0 && s.stock >= 0);
assert.ok(r.kpis.machines.M3.utilisation > 0.95, 'M3 is the bottleneck');
assert.ok(['availability', 'performance', 'quality', 'value'].every((k) => k in r.kpis.machines.M3.oee));
assert.ok(r.kpis.lineYield > 0.8 && r.kpis.lineYield <= 1, 'line yield');
console.log('ok  result structure and books consistent');

// 4b. a config passed by the caller does not stop the run (material is always infinite) and the engine outage setting
//     cfg.source.outage is reported in the event log
const simDir = [path.resolve(here, '../simulation'), process.env.MACHINE_SIM && path.join(process.env.MACHINE_SIM, 'src/simulation')]
  .find((d) => d && fs.existsSync(path.join(d, 'config.js')));
const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(simDir, 'config.js')));
const cfgIn = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
cfgIn.source.outage = { startTick: 4800, endTick: 5760 };            // ignored by the engine until the outage is implemented in the engine (B2)
const viaCfg = await runHeadless({ config: cfgIn, shifts: SHIFTS, demand });
assert.ok(viaCfg.kpis.goodParts > 600, 'material must not run out when a config is passed');
assert.ok(viaCfg.events.some((e) => e.type === 'outage_start' && e.tick === 4800), 'outage events come from config.source.outage');
console.log('ok  config without materialStock -1 still runs 20 shifts; outage events from config.source.outage');

// 5. event log: outage markers, shortfalls, starved/blocked episodes with machine ids
const ev = out[0].events;
assert.ok(ev.some((e) => e.type === 'outage_start' && e.tick === OUTAGE.startTick));
assert.ok(ev.some((e) => e.type === 'outage_end' && e.tick === OUTAGE.endTick));
assert.ok(ev.some((e) => e.type === 'shortfall'));
assert.ok(ev.some((e) => e.type === 'machine_starved' && e.machine && e.ticks >= 10), 'outage must starve the line');
assert.ok(ev.every((e, i) => i === 0 || ev[i - 1].tick <= e.tick), 'events are sorted by tick');
console.log('ok  event log', Object.entries(ev.reduce((a, e) => ((a[e.type] = (a[e.type] ?? 0) + 1), a), {})).map(([k, v]) => `${k}:${v}`).join(' '));

// 6. the outage runs for exactly 2 shifts of lost input: produced parts in shifts 11-12 drop
const drop = mean(out.map((x) => x.perShift.slice(11, 13).reduce((a, s) => a + s.produced, 0)));
assert.ok(drop < mean(swing.map((x) => x.perShift.slice(11, 13).reduce((a, s) => a + s.produced, 0))) - 20);
assert.equal(TICKS_PER_SHIFT, 480);
console.log('ok  outage reduces output in the outage shifts');
console.log('ALL PASSED');
