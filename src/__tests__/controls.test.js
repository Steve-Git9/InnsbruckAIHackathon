import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../simulation/engine.js';
import { DEFAULT_CONFIG } from '../simulation/config.js';
import { play, pause, reset, setSpeed } from '../controls.js';

test('controls.play starts the engine', () => {
  const e = new SimulationEngine(DEFAULT_CONFIG);
  play(e);
  assert.equal(e.getState().running, true);
  pause(e); // cleanup so the test process exits
});

test('controls.pause stops the engine', () => {
  const e = new SimulationEngine(DEFAULT_CONFIG);
  play(e);
  pause(e);
  assert.equal(e.getState().running, false);
});

test('controls.reset zeroes the tick and pauses', () => {
  const e = new SimulationEngine(DEFAULT_CONFIG);
  play(e);
  pause(e);
  reset(e);
  assert.equal(e.getState().tick, 0);
  assert.equal(e.getState().running, false);
});

test('controls.setSpeed rejects non-positive multipliers', () => {
  const e = new SimulationEngine(DEFAULT_CONFIG);
  assert.throws(() => setSpeed(e, 0), /positive/);
  assert.throws(() => setSpeed(e, -1), /positive/);
});

test('controls.setSpeed accepts positive multipliers', () => {
  const e = new SimulationEngine(DEFAULT_CONFIG);
  setSpeed(e, 2);
  assert.equal(e.getState().speed, 2);
});
