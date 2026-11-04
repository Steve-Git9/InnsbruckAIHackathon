import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSimulationFinished,
  shouldFreezeParticles,
  shouldShowStartBanner,
} from '../src/public/sim-status.js';

// Build a state snapshot. Defaults describe a *finished* run (so each test only
// overrides the one field it cares about). Mirrors engine.js getState() shape.
function makeState(overrides = {}) {
  return {
    tick: 100,
    running: false,
    source:   { materialStock: 0 },
    buffers:  [{ id: 'BUF0', load: 0 }, { id: 'BUF1', load: 0 }],
    machines: [{ id: 'M1', currentPartId: null }],
    ...overrides,
  };
}

// ── isSimulationFinished ──────────────────────────────────────────────────────

test('not finished while the sim is still running', () => {
  assert.equal(isSimulationFinished(makeState({ running: true })), false);
});

test('finished when paused, stock depleted, pipeline empty', () => {
  assert.equal(isSimulationFinished(makeState()), true);
});

test('not finished while material stock remains', () => {
  assert.equal(isSimulationFinished(makeState({ source: { materialStock: 5 } })), false);
});

test('not finished with infinite stock (materialStock === -1)', () => {
  assert.equal(isSimulationFinished(makeState({ source: { materialStock: -1 } })), false);
});

test('not finished while a buffer still holds parts', () => {
  assert.equal(
    isSimulationFinished(makeState({ buffers: [{ id: 'BUF0', load: 2 }] })),
    false,
  );
});

test('not finished while a machine still holds a part', () => {
  assert.equal(
    isSimulationFinished(makeState({ machines: [{ id: 'M1', currentPartId: 42 }] })),
    false,
  );
});

// ── shouldFreezeParticles ─────────────────────────────────────────────────────

test('running: particles must not freeze', () => {
  assert.equal(shouldFreezeParticles(makeState({ running: true })), false);
});

test('manual pause mid-run: particles freeze for inspection', () => {
  // Paused with parts still in the pipeline — a real manual pause, not a finish.
  const paused = makeState({ source: { materialStock: 5 }, buffers: [{ id: 'BUF0', load: 3 }] });
  assert.equal(shouldFreezeParticles(paused), true);
});

test('finish: particles must NOT freeze, so they glide out and clear', () => {
  assert.equal(shouldFreezeParticles(makeState()), false);
});

// ── shouldShowStartBanner ─────────────────────────────────────────────────────

test('start banner shows before the sim has started (paused at tick 0)', () => {
  assert.equal(shouldShowStartBanner(makeState({ running: false, tick: 0 })), true);
});

test('start banner hidden while running', () => {
  assert.equal(shouldShowStartBanner(makeState({ running: true, tick: 0 })), false);
});

test('start banner hidden after the run has begun, even when later paused', () => {
  assert.equal(shouldShowStartBanner(makeState({ running: false, tick: 50 })), false);
});
