import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, getPreset } from '../src/simulation/presets.js';

// Every machine's buffer references must resolve to a defined buffer (or null = sink).
function assertValidConfig(cfg, label) {
  assert.ok(cfg.source && typeof cfg.source.interval === 'number', `${label}: source.interval`);
  assert.ok(typeof cfg.source.materialStock === 'number', `${label}: source.materialStock`);
  assert.ok(typeof cfg.ticksPerSecond === 'number', `${label}: ticksPerSecond`);
  assert.ok(Array.isArray(cfg.machines) && cfg.machines.length > 0, `${label}: machines`);
  assert.ok(Array.isArray(cfg.buffers) && cfg.buffers.length > 0, `${label}: buffers`);
  const bufferIds = new Set(cfg.buffers.map(b => b.id));
  for (const b of cfg.buffers) {
    assert.ok(b.capacity > 0, `${label}: buffer ${b.id} capacity > 0`);
  }
  for (const m of cfg.machines) {
    assert.ok(bufferIds.has(m.inputBufferId), `${label}: machine ${m.id} inputBuffer exists`);
    assert.ok(m.outputBufferId === null || bufferIds.has(m.outputBufferId),
      `${label}: machine ${m.id} outputBuffer exists or null`);
    assert.ok(m.cycleTime > 0, `${label}: machine ${m.id} cycleTime > 0`);
  }
}

test('every preset has required metadata and a valid config', () => {
  assert.ok(PRESETS.length >= 3, 'at least three presets');
  for (const p of PRESETS) {
    assert.ok(typeof p.id === 'string' && p.id.length, `preset id: ${JSON.stringify(p)}`);
    assert.ok(typeof p.label === 'string' && p.label.length, `preset label: ${p.id}`);
    assert.ok(typeof p.description === 'string' && p.description.length, `preset description: ${p.id}`);
    assertValidConfig(p.config, p.id);
  }
});

test('preset ids are unique', () => {
  const ids = PRESETS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('getPreset returns a deep clone, not the registry object', () => {
  const cfg = getPreset('bottleneck');
  assert.ok(cfg, 'bottleneck preset exists');
  cfg.machines[0].cycleTime = 9999;
  const fresh = getPreset('bottleneck');
  assert.notEqual(fresh.machines[0].cycleTime, 9999, 'mutation leaked into registry');
});

test('getPreset returns undefined for an unknown id', () => {
  assert.equal(getPreset('does-not-exist'), undefined);
});
