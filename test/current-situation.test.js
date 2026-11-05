// Current Situation bar: demo data loader (visual only, not used by the simulation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCurrentSituation } from '../src/data/loaders.js';

test('the demo file loads with stock values and four maintenance entries', () => {
  const d = loadCurrentSituation();
  assert.equal(d.source, 'demo');
  assert.deepEqual(d.finishedGoods, { value: 24, unit: 'sets' });
  assert.deepEqual(d.rawMaterial, { value: 160, unit: 'units' });
  assert.deepEqual(d.maintenance.map(m => m.machine), ['M1', 'M2', 'M3', 'M4']);
});

test('a missing file gives { source: "unavailable" }', () => {
  assert.deepEqual(loadCurrentSituation(path.join(os.tmpdir(), 'no-such-current-situation.json')), { source: 'unavailable' });
});

test('broken JSON or a wrong shape gives { source: "unavailable" }', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  assert.deepEqual(loadCurrentSituation(write('a.json', '{ not json')), { source: 'unavailable' });
  assert.deepEqual(loadCurrentSituation(write('b.json', '{"asOf":"x","source":"demo"}')), { source: 'unavailable' });
  const good = JSON.parse(fs.readFileSync(new URL('../src/data/current_situation.json', import.meta.url), 'utf8'));
  good.maintenance[0].lastCompleted = 'yesterday';
  assert.deepEqual(loadCurrentSituation(write('c.json', JSON.stringify(good))), { source: 'unavailable' });
});
