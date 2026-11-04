import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../src/simulation/engine.js';
import { MachineState } from '../src/simulation/entities.js';
import { calculateMetrics } from '../src/metrics/collector.js';

// A deterministic 2-station line with no rejects: Source→BUF0→S1→BUF1→S2→Sink.
function twoStationConfig(s1Cycle = 2, s2Cycle = 6) {
  return {
    ticksPerSecond: 10,
    source: { interval: 1, materialStock: -1 },
    machines: [
      { id: 'A', stationId: 'S1', name: 'A', cycleTime: s1Cycle, inputBufferId: 'BUF0', outputBufferId: 'BUF1' },
      { id: 'B', stationId: 'S2', name: 'B', cycleTime: s2Cycle, inputBufferId: 'BUF1', outputBufferId: null },
    ],
    buffers: [ { id: 'BUF0', capacity: 4 }, { id: 'BUF1', capacity: 4 } ],
  };
}

function runTicks(engine, n) { for (let i = 0; i < n; i++) engine._tick(); }

test('regression: default line still produces parts at the Sink', () => {
  const engine = new SimulationEngine();   // DEFAULT_CONFIG
  runTicks(engine, 400);
  assert.ok(engine.sink.partsReceived > 0, 'default line completed no parts');
});

test('domino prevention: a part traverses two stations over multiple ticks (no single-tick cascade)', () => {
  const engine = new SimulationEngine(twoStationConfig(1, 1));
  // The first part cannot cascade through both machines in one tick.
  engine._tick();
  assert.equal(engine.sink.partsReceived, 0, 'reached sink too early after 1 tick');
  engine._tick();
  assert.equal(engine.sink.partsReceived, 0, 'reached sink too early after 2 ticks');
  // By tick 3 the first part has cleared both stations and reached the Sink.
  engine._tick();
  assert.ok(engine.sink.partsReceived >= 1, 'first part should reach the Sink by tick 3');
});

test('getState machines expose stationId + buffer wiring', () => {
  const engine = new SimulationEngine(twoStationConfig());
  const a = engine.getState().machines.find(m => m.id === 'A');
  assert.equal(a.stationId, 'S1');
  assert.equal(a.inputBufferId, 'BUF0');
  assert.equal(a.outputBufferId, 'BUF1');
});

test('spawnMachine adds a parallel machine sharing the station wiring', () => {
  const engine = new SimulationEngine(twoStationConfig());
  const res = engine.spawnMachine({ stationId: 'S2' });
  assert.equal(res.ok, true);
  const station = engine.machines.filter(m => m.stationId === 'S2');
  assert.equal(station.length, 2);
  const spawned = station.find(m => m.id !== 'B');
  assert.equal(spawned.id, 'Bb');
  assert.equal(spawned.inputBufferId, 'BUF1');
  assert.equal(spawned.outputBufferId, null);
  assert.equal(spawned.cycleTime, station[0].cycleTime);
});

test('spawnMachine respects the 4-machine-per-station cap', () => {
  const engine = new SimulationEngine(twoStationConfig());
  assert.equal(engine.spawnMachine({ stationId: 'S2' }).ok, true); // Bb
  assert.equal(engine.spawnMachine({ stationId: 'S2' }).ok, true); // Bc
  assert.equal(engine.spawnMachine({ stationId: 'S2' }).ok, true); // Bd
  const capped = engine.spawnMachine({ stationId: 'S2' });          // 5th
  assert.equal(capped.ok, false);
  assert.equal(engine.machines.filter(m => m.stationId === 'S2').length, 4);
});

test('spawnMachine persists across reset() but not resetToDefaults()', () => {
  const engine = new SimulationEngine();   // DEFAULT_CONFIG, station S3 = M3
  engine.spawnMachine({ stationId: 'S3' });
  engine.reset();
  assert.equal(engine.machines.filter(m => m.stationId === 'S3').length, 2);
  engine.resetToDefaults();
  assert.equal(engine.machines.filter(m => m.stationId === 'S3').length, 1);
});

test('a second machine increases a bottleneck station throughput', () => {
  const base = new SimulationEngine(twoStationConfig(1, 8)); // S2 is the slow station
  runTicks(base, 600);
  const single = base.sink.partsReceived;

  const dbl = new SimulationEngine(twoStationConfig(1, 8));
  dbl.spawnMachine({ stationId: 'S2' });
  runTicks(dbl, 600);
  assert.ok(dbl.sink.partsReceived > single,
    `expected parallel station to finish more parts (${dbl.sink.partsReceived} vs ${single})`);
});

test('removeMachine deletes a spawned machine', () => {
  const engine = new SimulationEngine(twoStationConfig());
  engine.spawnMachine({ stationId: 'S2' });   // Bb
  const res = engine.removeMachine({ machineId: 'Bb' });
  assert.equal(res.ok, true);
  assert.equal(engine.machines.filter(m => m.stationId === 'S2').length, 1);
  assert.ok(!engine._config.machines.some(m => m.id === 'Bb'));
});

test('removeMachine refuses to remove the original station machine', () => {
  const engine = new SimulationEngine(twoStationConfig());
  engine.spawnMachine({ stationId: 'S2' });   // Bb exists, B is original
  const res = engine.removeMachine({ machineId: 'B' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'original-machine');
});

test('removeMachine returns a held part to its input buffer', () => {
  const engine = new SimulationEngine(twoStationConfig());
  engine.spawnMachine({ stationId: 'S2' });   // Bb
  const bb = engine.machines.find(m => m.id === 'Bb');
  const buf1 = engine._bufferById.get('BUF1');
  // Give Bb a part to hold and empty the buffer.
  bb.currentPart = { id: 999, _bufferEnterTick: 0 };
  bb.state = MachineState.PROCESSING;
  buf1.parts = [];
  engine.removeMachine({ machineId: 'Bb' });
  assert.equal(buf1.parts.length, 1);
  assert.equal(buf1.parts[0].id, 999);
});

test('regression: a resolved constraint clears from the bottleneck verdict within the utilization window', () => {
  // A=S1 (cycle 4) feeds B=S2 (cycle 8); B is the slow station → the constraint.
  const engine = new SimulationEngine(twoStationConfig(4, 8));
  runTicks(engine, 2000);
  let metrics = calculateMetrics(engine.getState());
  assert.equal(metrics.machines.find(m => m.id === 'B').bottleneck, true,
    'B should start out flagged as the constraint');

  // Speed B up so it is no longer busy (now much faster than upstream A).
  engine.updateConfig({ machineId: 'B', cycleTime: 1 });
  // Run well past the utilization window so the verdict reflects only the
  // post-change behaviour, not the long stretch when B *was* the constraint.
  runTicks(engine, 600);

  metrics = calculateMetrics(engine.getState());
  assert.equal(metrics.machines.find(m => m.id === 'B').bottleneck, false,
    'B should clear once its recent utilization drops below the threshold');
});

test('regression: resolving a constraint clears it within a few ticks, not a full window', () => {
  // B (cycle 8) is the constraint after a long saturated run.
  const engine = new SimulationEngine(twoStationConfig(4, 8));
  runTicks(engine, 2000);
  assert.equal(calculateMetrics(engine.getState()).machines.find(m => m.id === 'B').bottleneck,
    true, 'B should start out flagged as the constraint');

  // Speed B up, then run only a fraction of UTIL_WINDOW_TICKS. Because the window
  // never reaches back past a flow-affecting change, the verdict should already
  // reflect the post-change behaviour and clear B — the banner disappears fast.
  engine.updateConfig({ machineId: 'B', cycleTime: 1 });
  runTicks(engine, 50);

  assert.equal(calculateMetrics(engine.getState()).machines.find(m => m.id === 'B').bottleneck,
    false, 'B should clear within a few ticks of the change, not wait out the full window');
});

test('loadConfig applies a new config, resets to tick 0, and stays paused', () => {
  const engine = new SimulationEngine();   // DEFAULT_CONFIG
  runTicks(engine, 50);
  assert.ok(engine.tick > 0, 'precondition: ticks advanced');

  engine.loadConfig(twoStationConfig(2, 6));

  const state = engine.getState();
  assert.equal(state.tick, 0, 'tick reset to 0');
  assert.equal(state.running, false, 'engine paused after loadConfig');
  assert.deepEqual(state.machines.map(m => m.id), ['A', 'B'], 'new machine set applied');
  assert.equal(state.machines.find(m => m.id === 'B').cycleTime, 6, 'new cycle time applied');
});

test('loadConfig deep-clones so later mutation of the source object does not leak', () => {
  const engine = new SimulationEngine();
  const cfg = twoStationConfig(2, 6);
  engine.loadConfig(cfg);
  cfg.machines[0].cycleTime = 9999;
  assert.notEqual(engine.getState().machines.find(m => m.id === 'A').cycleTime, 9999);
});

test('getState exposes ticksPerSecond from the active config', () => {
  const engine = new SimulationEngine();   // DEFAULT_CONFIG has ticksPerSecond 10
  assert.equal(engine.getState().ticksPerSecond, 10);
});
