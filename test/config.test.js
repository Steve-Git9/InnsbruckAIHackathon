import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/simulation/config.js';

test('every default machine declares station + buffer wiring', () => {
  for (const m of DEFAULT_CONFIG.machines) {
    assert.ok(m.stationId, `${m.id} missing stationId`);
    assert.ok(m.inputBufferId, `${m.id} missing inputBufferId`);
    assert.ok('outputBufferId' in m, `${m.id} missing outputBufferId`);
  }
  const last = DEFAULT_CONFIG.machines.at(-1);
  assert.equal(last.outputBufferId, null, 'last machine outputs to Sink (null)');
});
